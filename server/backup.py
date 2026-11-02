#!/usr/bin/env python3
"""Create a consistent SQLite backup and prune old copies."""

from __future__ import annotations

import gzip
import os
import shutil
import sqlite3
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

DB_PATH = Path(os.environ.get("PRIEMKA_DB", "/opt/priemka/data/priemka.db"))
BACKUP_DIR = Path(os.environ.get("PRIEMKA_BACKUP_DIR", "/opt/priemka/backups"))
KEEP_DAYS = int(os.environ.get("PRIEMKA_BACKUP_KEEP_DAYS", "14"))


def main() -> None:
    if not DB_PATH.is_file():
        raise SystemExit(f"database not found: {DB_PATH}")
    BACKUP_DIR.mkdir(parents=True, mode=0o700, exist_ok=True)
    os.chmod(BACKUP_DIR, 0o700)

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    target = BACKUP_DIR / f"priemka-{stamp}.db.gz"
    with tempfile.NamedTemporaryFile(
        prefix="priemka-backup-", suffix=".db", dir=BACKUP_DIR, delete=False
    ) as temporary:
        temporary_path = Path(temporary.name)
    try:
        with sqlite3.connect(DB_PATH) as source, sqlite3.connect(temporary_path) as destination:
            source.backup(destination)
        with temporary_path.open("rb") as raw, gzip.open(target, "wb", compresslevel=9) as compressed:
            shutil.copyfileobj(raw, compressed)
        os.chmod(target, 0o600)
    finally:
        temporary_path.unlink(missing_ok=True)

    cutoff = datetime.now(timezone.utc) - timedelta(days=KEEP_DAYS)
    for old in BACKUP_DIR.glob("priemka-*.db.gz"):
        try:
            modified = datetime.fromtimestamp(old.stat().st_mtime, tz=timezone.utc)
        except OSError:
            continue
        if modified < cutoff:
            old.unlink(missing_ok=True)
    print(target)


if __name__ == "__main__":
    main()
