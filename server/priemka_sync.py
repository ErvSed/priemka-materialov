#!/usr/bin/env python3
"""ПРИЁМКА — central sync API.

A small, dependency-free HTTP service backed by SQLite. It stores one shared
registry, merges records by permanent id, and never deletes records.

Environment:
  PRIEMKA_DB               path to SQLite file (default /opt/priemka/data/priemka.db)
  PRIEMKA_TOKEN_SHA256     SHA-256 hex digest of the bearer token (production)
  PRIEMKA_TOKEN            plain bearer token (development/testing only)
  PRIEMKA_HOST             bind address (default 127.0.0.1)
  PRIEMKA_PORT             port (default 8012)
  PRIEMKA_ALLOWED_ORIGINS  comma-separated browser origins
  PRIEMKA_MAX_BODY         request body limit in bytes (default 5 MiB)
"""

from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import json
import os
import re
import sqlite3
import sys
import threading
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

MAX_RECORDS = 5_000
HISTORY_LIMIT = 40
DEFAULT_MAX_BODY = 5 * 1024 * 1024
ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,100}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ALLOWED_ACTIONS = {"create", "edit", "archive", "restore", "undo"}


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass(frozen=True)
class Config:
    db_path: str
    token_sha256: str
    token_plain: str
    host: str
    port: int
    allowed_origins: frozenset[str]
    max_body: int


def load_config() -> Config:
    db_path = os.environ.get("PRIEMKA_DB", "/opt/priemka/data/priemka.db")
    token_sha256 = os.environ.get("PRIEMKA_TOKEN_SHA256", "").strip().lower()
    token_plain = os.environ.get("PRIEMKA_TOKEN", "").strip()
    if not token_sha256 and not token_plain:
        raise SystemExit("PRIEMKA_TOKEN_SHA256 or PRIEMKA_TOKEN is required")
    if token_sha256 and not re.fullmatch(r"[0-9a-f]{64}", token_sha256):
        raise SystemExit("PRIEMKA_TOKEN_SHA256 must be a hex SHA-256 digest")
    origins = frozenset(
        origin.strip().rstrip("/")
        for origin in os.environ.get("PRIEMKA_ALLOWED_ORIGINS", "").split(",")
        if origin.strip()
    )
    return Config(
        db_path=db_path,
        token_sha256=token_sha256,
        token_plain=token_plain,
        host=os.environ.get("PRIEMKA_HOST", "127.0.0.1"),
        port=int(os.environ.get("PRIEMKA_PORT", "8012")),
        allowed_origins=origins,
        max_body=int(os.environ.get("PRIEMKA_MAX_BODY", str(DEFAULT_MAX_BODY))),
    )


def connect_db(path: str) -> sqlite3.Connection:
    connection = sqlite3.connect(path, timeout=20)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout = 10000")
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def init_db(path: str) -> None:
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, mode=0o700, exist_ok=True)
    with connect_db(path) as connection:
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS records (
                id TEXT PRIMARY KEY,
                updated_at TEXT NOT NULL,
                data TEXT NOT NULL,
                server_updated_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
            """
        )
        connection.execute(
            "INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1')"
        )
        connection.commit()


def parse_timestamp(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return value


def iso_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_date(value: object) -> str | None:
    if not isinstance(value, str) or not DATE_RE.fullmatch(value):
        return None
    try:
        dt.date.fromisoformat(value)
    except ValueError:
        return None
    return value


def normalize_snapshot(value: object) -> dict | None:
    if not isinstance(value, dict):
        return None
    date = parse_date(value.get("date"))
    name = value.get("name")
    unit = value.get("unit")
    try:
        qty = float(value.get("qty"))
    except (TypeError, ValueError):
        return None
    if not date or not isinstance(name, str) or not name or not isinstance(unit, str) or not unit:
        return None
    if qty <= 0:
        return None
    note = value.get("note")
    return {
        "date": date,
        "name": name,
        "unit": unit,
        "qty": round(qty, 3),
        "note": note if isinstance(note, str) else "",
    }


def normalize_history(value: object) -> list[dict]:
    if not isinstance(value, list):
        return []
    entries = []
    for raw in value:
        if not isinstance(raw, dict):
            continue
        action = raw.get("action")
        at = parse_timestamp(raw.get("at"))
        if action not in ALLOWED_ACTIONS or not at:
            continue
        by = raw.get("by")
        entries.append(
            {
                "action": action,
                "at": at,
                "by": by[:64] if isinstance(by, str) else "",
                "snapshot": normalize_snapshot(raw.get("snapshot")),
            }
        )
    entries.sort(key=lambda entry: entry["at"])
    return entries[-HISTORY_LIMIT:]


def validate_record(raw: object) -> dict:
    if not isinstance(raw, dict):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Некорректная запись")

    record_id = raw.get("id")
    if not isinstance(record_id, str) or not ID_RE.fullmatch(record_id):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Некорректный id записи")

    date = parse_date(raw.get("date"))
    name = raw.get("name")
    unit = raw.get("unit")
    note = raw.get("note")
    try:
        qty = float(raw.get("qty"))
    except (TypeError, ValueError):
        qty = 0
    if not date:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Некорректная дата записи")
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 200:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Некорректное наименование")
    if not isinstance(unit, str) or not unit.strip() or len(unit.strip()) > 20:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Некорректная единица измерения")
    note = raw.get("note")
    if note is None:
        note = ""
    if not isinstance(note, str) or len(note) > 500:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Слишком длинное примечание")
    if not 0 < qty <= 999_999_999.999:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Некорректное количество")

    archived_at = raw.get("archivedAt")
    if archived_at is not None and not parse_timestamp(archived_at):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Некорректная отметка архива")

    created_at = parse_timestamp(raw.get("createdAt")) or iso_now()
    updated_at = parse_timestamp(raw.get("updatedAt")) or created_at
    return {
        "id": record_id,
        "date": date,
        "name": name.strip(),
        "unit": unit.strip(),
        "qty": round(qty, 3),
        "note": note,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "archivedAt": archived_at,
        "history": normalize_history(raw.get("history")),
    }


def history_key(entry: dict) -> str:
    return json.dumps(entry, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def canonical_record_base(record: dict) -> str:
    qty = record.get("qty")
    if isinstance(qty, float) and qty.is_integer():
        qty = int(qty)
    payload = {
        "id": record.get("id"),
        "date": record.get("date"),
        "name": record.get("name"),
        "unit": record.get("unit"),
        "qty": qty,
        "note": record.get("note") or "",
        "createdAt": record.get("createdAt"),
        "updatedAt": record.get("updatedAt"),
        "archivedAt": record.get("archivedAt") or None,
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def merge_history(existing: list, incoming: list) -> list:
    merged: dict[str, dict] = {}
    for entry in [*(existing or []), *(incoming or [])]:
        if isinstance(entry, dict):
            merged[history_key(entry)] = entry
    ordered = sorted(merged.values(), key=lambda entry: str(entry.get("at", "")))
    return ordered[-HISTORY_LIMIT:]


def merge_record(existing: dict, incoming: dict) -> dict:
    existing_updated = existing.get("updatedAt", "")
    incoming_updated = incoming.get("updatedAt", "")
    if incoming_updated > existing_updated:
        base = incoming
    elif incoming_updated < existing_updated:
        base = existing
    else:
        base = (
            incoming
            if canonical_record_base(incoming) >= canonical_record_base(existing)
            else existing
        )
    merged = dict(base)
    merged["history"] = merge_history(existing.get("history", []), incoming.get("history", []))
    return merged


def decode_record(row: sqlite3.Row) -> dict:
    try:
        value = json.loads(row["data"])
    except (TypeError, ValueError) as exc:
        raise RuntimeError("Damaged record in database") from exc
    if not isinstance(value, dict):
        raise RuntimeError("Damaged record in database")
    return value


def sync_records(config: Config, incoming_raw: object) -> list[dict]:
    if not isinstance(incoming_raw, list):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Ожидается список записей")
    if len(incoming_raw) > MAX_RECORDS:
        raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Слишком много записей")

    incoming = [validate_record(raw) for raw in incoming_raw]
    now = iso_now()

    with connect_db(config.db_path) as connection:
        connection.execute("BEGIN IMMEDIATE")
        try:
            rows = connection.execute("SELECT id, data FROM records").fetchall()
            existing = {row["id"]: decode_record(row) for row in rows}
            if len(existing) + len(incoming) > MAX_RECORDS:
                raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Слишком много записей")

            for record in incoming:
                current = existing.get(record["id"])
                merged = merge_record(current, record) if current else record
                existing[record["id"]] = merged
                connection.execute(
                    """
                    INSERT INTO records(id, updated_at, data, server_updated_at)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        updated_at = excluded.updated_at,
                        data = excluded.data,
                        server_updated_at = excluded.server_updated_at
                    """,
                    (
                        merged["id"],
                        merged["updatedAt"],
                        json.dumps(merged, ensure_ascii=False, separators=(",", ":")),
                        now,
                    ),
                )

            connection.commit()
            all_records = [
                decode_record(row)
                for row in connection.execute("SELECT id, data FROM records ORDER BY id").fetchall()
            ]
            return all_records
        except Exception:
            connection.rollback()
            raise


def token_matches(config: Config, supplied: str) -> bool:
    if config.token_sha256:
        digest = hashlib.sha256(supplied.encode("utf-8")).hexdigest()
        return hmac.compare_digest(digest, config.token_sha256)
    return hmac.compare_digest(supplied, config.token_plain)


def bearer_token(header: str | None) -> str:
    if not header:
        return ""
    scheme, _, value = header.partition(" ")
    if scheme.lower() != "bearer" or not value.strip():
        return ""
    return value.strip()


class SyncServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, server_address, handler_class, config: Config):
        self.config = config
        super().__init__(server_address, handler_class)


class Handler(BaseHTTPRequestHandler):
    server: SyncServer
    server_version = "PriemkaSync/1.0"
    sys_version = ""

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write(
            "%s - - [%s] %s\n"
            % (self.address_string(), self.log_date_time_string(), fmt % args)
        )

    def _origin(self) -> str | None:
        return self.headers.get("Origin")

    def _cors_headers(self) -> dict[str, str]:
        origin = self._origin()
        if origin and origin in self.server.config.allowed_origins:
            return {
                "Access-Control-Allow-Origin": origin,
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": "Authorization, Content-Type",
                "Access-Control-Max-Age": "600",
                "Vary": "Origin",
            }
        return {"Vary": "Origin"}

    def _send_json(
        self,
        status: int,
        payload: dict,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for name, value in self._cors_headers().items():
            self.send_header(name, value)
        if extra_headers:
            for name, value in extra_headers.items():
                self.send_header(name, value)
        self.end_headers()
        self.wfile.write(raw)

    def _guard_origin(self) -> None:
        origin = self._origin()
        if origin and origin not in self.server.config.allowed_origins:
            raise ApiError(HTTPStatus.FORBIDDEN, "Origin not allowed")

    def _read_json(self) -> dict:
        content_type = (self.headers.get("Content-Type") or "").lower()
        if "application/json" not in content_type:
            raise ApiError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "Content-Type must be application/json")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Invalid Content-Length")
        if length <= 0:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Empty request")
        if length > self.server.config.max_body:
            raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Request body is too large")
        raw = self.rfile.read(length)
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Invalid JSON")
        if not isinstance(value, dict):
            raise ApiError(HTTPStatus.BAD_REQUEST, "JSON object expected")
        return value

    def do_OPTIONS(self) -> None:
        origin = self._origin()
        if origin and origin not in self.server.config.allowed_origins:
            self._send_json(HTTPStatus.FORBIDDEN, {"error": "Origin not allowed"})
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        for name, value in self._cors_headers().items():
            self.send_header(name, value)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        path = urlsplit(self.path).path.rstrip("/") or "/"
        if path == "/health":
            self._send_json(
                HTTPStatus.OK,
                {"ok": True, "service": "priemka-sync"},
            )
            return
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})

    def do_POST(self) -> None:
        try:
            self._guard_origin()
            path = urlsplit(self.path).path.rstrip("/") or "/"
            if path != "/sync":
                raise ApiError(HTTPStatus.NOT_FOUND, "Not found")

            supplied = bearer_token(self.headers.get("Authorization"))
            if not supplied or not token_matches(self.server.config, supplied):
                raise ApiError(HTTPStatus.UNAUTHORIZED, "Invalid access code")

            payload = self._read_json()
            records = sync_records(self.server.config, payload.get("records"))
            self._send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "records": records,
                    "count": len(records),
                    "serverTime": iso_now(),
                },
            )
        except ApiError as exc:
            self._send_json(exc.status, {"error": exc.message})
        except Exception as exc:
            self.log_message("internal error: %s", type(exc).__name__)
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Internal server error"})

    def _record_count(self) -> int:
        try:
            with connect_db(self.server.config.db_path) as connection:
                row = connection.execute("SELECT COUNT(*) AS n FROM records").fetchone()
            return int(row["n"])
        except sqlite3.Error:
            return 0


def main() -> None:
    os.umask(0o077)
    config = load_config()
    init_db(config.db_path)
    server = SyncServer((config.host, config.port), Handler, config)
    sys.stderr.write(f"priemka-sync listening on {config.host}:{config.port}\n")
    sys.stderr.flush()
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
