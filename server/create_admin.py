#!/usr/bin/env python3
"""Create the first administrator account for the central portal."""

from __future__ import annotations

import json
import os
import sqlite3
import sys
from types import SimpleNamespace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from priemka_sync import connect_db, create_account, init_db  # noqa: E402


def main() -> None:
    db_path = os.environ.get("PRIEMKA_DB", "/opt/priemka/data/priemka.db")
    init_db(db_path)
    with connect_db(db_path) as connection:
        existing = connection.execute(
            "SELECT id, name FROM accounts WHERE role = 'admin' AND active = 1 LIMIT 1"
        ).fetchone()
    if existing:
        print("ACTIVE_ADMIN_EXISTS", file=sys.stderr)
        raise SystemExit(2)

    account = create_account(SimpleNamespace(db_path=db_path), "Администратор", "admin")
    print(json.dumps(account, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
