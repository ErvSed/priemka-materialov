from __future__ import annotations

import json
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from contextlib import closing
from pathlib import Path

TOKEN = "test-server-token-8b5f77d1c3a84b1d9f2e"
ORIGIN = "http://127.0.0.1:8765"
BASE_RECORD = {
    "id": "aaaaaaaa-1111-4111-8111-111111111111",
    "date": "2026-11-01",
    "name": "Кирпич керамический",
    "unit": "шт",
    "qty": 120,
    "note": "Первый двор",
    "createdAt": "2026-11-01T08:00:00.000Z",
    "updatedAt": "2026-11-01T08:00:00.000Z",
    "archivedAt": None,
    "history": [
        {
            "action": "create",
            "at": "2026-11-01T08:00:00.000Z",
            "by": "admin",
            "snapshot": {
                "date": "2026-11-01",
                "name": "Кирпич керамический",
                "unit": "шт",
                "qty": 120,
                "note": "Первый двор",
            },
        }
    ],
}
SECOND_RECORD = {
    **BASE_RECORD,
    "id": "bbbbbbbb-2222-4222-8222-222222222222",
    "name": "Песок строительный",
    "unit": "т",
    "qty": 7.5,
    "createdAt": "2026-11-02T09:00:00.000Z",
    "updatedAt": "2026-11-02T09:00:00.000Z",
    "history": [
        {
            "action": "create",
            "at": "2026-11-02T09:00:00.000Z",
            "by": "admin",
            "snapshot": {
                "date": "2026-11-01",
                "name": "Песок строительный",
                "unit": "т",
                "qty": 7.5,
                "note": "Первый двор",
            },
        }
    ],
}


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def request(url: str, method: str = "GET", payload=None, headers=None):
    data = None
    request_headers = dict(headers or {})
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request_headers.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, method=method, headers=request_headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            body = response.read()
            return response.status, dict(response.headers), json.loads(body) if body else None
    except urllib.error.HTTPError as error:
        body = error.read()
        return error.code, dict(error.headers), json.loads(body) if body else None


class SyncServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(
            prefix="priemka-sync-test-", ignore_cleanup_errors=True
        )
        cls.db_path = str(Path(cls.temp.name) / "sync.db")
        cls.port = free_port()
        env = os.environ.copy()
        env.update(
            {
                "PRIEMKA_DB": cls.db_path,
                "PRIEMKA_TOKEN": TOKEN,
                "PRIEMKA_HOST": "127.0.0.1",
                "PRIEMKA_PORT": str(cls.port),
                "PRIEMKA_ALLOWED_ORIGINS": ORIGIN,
                "PYTHONUNBUFFERED": "1",
            }
        )
        cls.process = subprocess.Popen(
            [sys.executable, str(Path(__file__).with_name("priemka_sync.py"))],
            cwd=Path(__file__).parent,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        cls.base = f"http://127.0.0.1:{cls.port}"
        deadline = time.time() + 10
        while time.time() < deadline:
            try:
                status, _, body = request(f"{cls.base}/health")
                if status == 200 and body and body.get("ok"):
                    break
            except OSError:
                time.sleep(0.1)
        else:
            cls.process.terminate()
            raise RuntimeError("sync server did not start")

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        try:
            cls.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cls.process.kill()
            cls.process.wait(timeout=5)
        time.sleep(0.25)
        cls.temp.cleanup()

    def setUp(self):
        with closing(sqlite3.connect(self.db_path)) as connection:
            connection.execute("DELETE FROM records")
            connection.commit()

    def sync(self, records, token=TOKEN, origin=ORIGIN):
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        if origin:
            headers["Origin"] = origin
        return request(f"{self.base}/sync", "POST", {"records": records}, headers)

    def test_health_and_cors(self):
        status, headers, body = request(f"{self.base}/health", headers={"Origin": ORIGIN})
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), ORIGIN)

        status, headers, _ = request(
            f"{self.base}/sync",
            "OPTIONS",
            headers={
                "Origin": ORIGIN,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization,content-type",
            },
        )
        self.assertEqual(status, 204)
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), ORIGIN)
        self.assertIn("Authorization", headers.get("Access-Control-Allow-Headers", ""))

        status, _, _ = request(
            f"{self.base}/sync",
            "OPTIONS",
            headers={
                "Origin": "https://evil.example",
                "Access-Control-Request-Method": "POST",
            },
        )
        self.assertEqual(status, 403)

    def test_auth_is_required(self):
        status, headers, _ = self.sync([], token="wrong-token")
        self.assertEqual(status, 401)
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), ORIGIN)

        status, _, body = request(f"{self.base}/sync", "POST", {"records": []}, headers={})
        self.assertEqual(status, 401)
        self.assertEqual(body["error"], "Invalid access code")

    def test_union_merge_and_no_deletions(self):
        status, _, body = self.sync([BASE_RECORD])
        self.assertEqual(status, 200)
        self.assertEqual(body["count"], 1)
        self.assertEqual(body["records"][0]["id"], BASE_RECORD["id"])

        status, _, body = self.sync([BASE_RECORD, SECOND_RECORD])
        self.assertEqual(status, 200)
        self.assertEqual(body["count"], 2)
        self.assertEqual(
            {record["id"] for record in body["records"]},
            {BASE_RECORD["id"], SECOND_RECORD["id"]},
        )

        # Omitting a record must not delete it from the central database.
        status, _, body = self.sync([BASE_RECORD])
        self.assertEqual(status, 200)
        self.assertEqual(body["count"], 2)

    def test_latest_edit_wins_and_history_is_merged(self):
        edited = {
            **BASE_RECORD,
            "name": "Кирпич керамический, полнотелый",
            "qty": 118.5,
            "updatedAt": "2026-11-03T10:00:00.000Z",
            "history": [
                *BASE_RECORD["history"],
                {
                    "action": "edit",
                    "at": "2026-11-03T10:00:00.000Z",
                    "by": "admin",
                    "snapshot": {
                        "date": "2026-11-01",
                        "name": "Кирпич керамический",
                        "unit": "шт",
                        "qty": 120,
                        "note": "Первый двор",
                    },
                },
            ],
        }
        status, _, body = self.sync([edited])
        self.assertEqual(status, 200)
        record = next(r for r in body["records"] if r["id"] == BASE_RECORD["id"])
        self.assertEqual(record["name"], "Кирпич керамический, полнотелый")
        self.assertEqual(record["qty"], 118.5)
        self.assertEqual(len(record["history"]), 2)

        # An older copy must not overwrite the newer server record.
        status, _, body = self.sync([BASE_RECORD])
        self.assertEqual(status, 200)
        record = next(r for r in body["records"] if r["id"] == BASE_RECORD["id"])
        self.assertEqual(record["name"], "Кирпич керамический, полнотелый")
        self.assertEqual(len(record["history"]), 2)

    def test_equal_timestamp_conflict_is_deterministic(self):
        first = {**BASE_RECORD, "name": "Яблоко позднее по канону"}
        second = {**BASE_RECORD, "name": "Арбуз раньше по канону"}
        status, _, body = self.sync([first])
        self.assertEqual(status, 200)
        chosen = next(r for r in body["records"] if r["id"] == BASE_RECORD["id"])
        self.assertEqual(chosen["name"], first["name"])

        # Sending the other equal-timestamp version back must not flap.
        status, _, body = self.sync([second])
        self.assertEqual(status, 200)
        chosen_again = next(r for r in body["records"] if r["id"] == BASE_RECORD["id"])
        self.assertEqual(chosen_again["name"], first["name"])
        self.assertEqual(chosen_again["updatedAt"], BASE_RECORD["updatedAt"])

    def test_invalid_records_are_rejected_without_writes(self):
        bad = {**BASE_RECORD, "id": "bad", "name": "Некорректный id"}
        status, _, body = self.sync([bad])
        self.assertEqual(status, 400)
        self.assertIn("id", body["error"])

        with closing(sqlite3.connect(self.db_path)) as connection:
            count = connection.execute("SELECT COUNT(*) FROM records").fetchone()[0]
        self.assertEqual(count, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
