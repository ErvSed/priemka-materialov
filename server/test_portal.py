#!/usr/bin/env python3
"""Integration test for the central portal accounts, sessions and records."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from pathlib import Path
from types import SimpleNamespace

SERVER_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SERVER_DIR))

import priemka_sync  # noqa: E402


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class PortalApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temp = tempfile.TemporaryDirectory(prefix="priemka-portal-test-")
        cls.config = SimpleNamespace(db_path=os.path.join(cls.temp.name, "portal.db"))
        priemka_sync.init_db(cls.config.db_path)
        cls.admin = priemka_sync.create_account(cls.config, "Администратор", "admin")
        cls.port = free_port()
        env = os.environ.copy()
        env.update(
            {
                "PRIEMKA_DB": cls.config.db_path,
                "PRIEMKA_TOKEN": "legacy-test-token",
                "PRIEMKA_ALLOWED_ORIGINS": "http://127.0.0.1:8766",
                "PRIEMKA_COOKIE_SECURE": "0",
                "PRIEMKA_PORT": str(cls.port),
            }
        )
        cls.process = subprocess.Popen(
            [sys.executable, str(SERVER_DIR / "priemka_sync.py")],
            env=env,
            cwd=SERVER_DIR.parent,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        cls.base = f"http://127.0.0.1:{cls.port}"
        for _ in range(80):
            try:
                with urllib.request.urlopen(cls.base + "/health", timeout=1) as response:
                    if response.status == 200:
                        return
            except Exception:
                time.sleep(0.1)
        raise RuntimeError("portal API did not start")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.process.terminate()
        try:
            cls.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cls.process.kill()
        time.sleep(0.2)
        cls.temp.cleanup()

    def setUp(self) -> None:
        self.jar = CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def request(self, path: str, method: str = "GET", payload: dict | None = None):
        data = None
        headers = {}
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False).encode()
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with self.opener.open(request, timeout=10) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read() or b"{}")

    def login_admin(self) -> None:
        status, payload = self.request("/login", "POST", {"code": self.admin["code"]})
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["account"]["role"], "admin")

    def test_session_requires_login(self) -> None:
        status, _ = self.request("/session")
        self.assertEqual(status, 401)
        status, _ = self.request("/records")
        self.assertEqual(status, 401)

    def test_admin_creates_worker_shared_record_and_revokes(self) -> None:
        self.login_admin()
        status, payload = self.request("/accounts", "POST", {"name": "Прораб Иван"})
        self.assertEqual(status, 201, payload)
        code = payload["account"]["code"]
        account_id = payload["account"]["id"]
        self.assertTrue(code.startswith("usr_"))

        status, payload = self.request("/logout", "POST", {})
        self.assertEqual(status, 200)
        status, payload = self.request("/login", "POST", {"code": code})
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["account"]["role"], "user")

        record = {
            "id": "aaaaaaaa-2222-4222-8222-222222222222",
            "date": "2026-11-06",
            "name": "Тестовый материал",
            "unit": "шт",
            "qty": 3,
            "note": "",
            "createdAt": "2026-11-06T10:00:00.000Z",
            "updatedAt": "2026-11-06T10:00:00.000Z",
            "archivedAt": None,
            "history": [],
        }
        status, payload = self.request("/records", "POST", {"records": [record]})
        self.assertEqual(status, 200, payload)
        self.assertTrue(any(item["id"] == record["id"] for item in payload["records"]))

        status, _ = self.request("/accounts")
        self.assertEqual(status, 403)
        status, _ = self.request("/accounts", "POST", {"name": "Нельзя"})
        self.assertEqual(status, 403)

        archived = dict(record)
        archived["archivedAt"] = "2026-11-06T10:05:00.000Z"
        archived["updatedAt"] = "2026-11-06T10:05:00.000Z"
        status, _ = self.request("/records", "POST", {"records": [archived]})
        self.assertEqual(status, 403)
        status, payload = self.request("/records")
        self.assertEqual(status, 200)
        own = next(item for item in payload["records"] if item["id"] == record["id"])
        self.assertIsNone(own["archivedAt"])

        self.request("/logout", "POST", {})
        status, payload = self.request("/login", "POST", {"code": self.admin["code"]})
        self.assertEqual(status, 200, payload)
        status, payload = self.request("/accounts", "POST", {"name": "Второй"})
        self.assertEqual(status, 201, payload)
        status, payload = self.request(f"/accounts/{account_id}/revoke", "POST", {})
        self.assertEqual(status, 200, payload)
        self.assertFalse(payload["account"]["active"])

    def test_admin_can_archive(self) -> None:
        self.login_admin()
        record = {
            "id": "aaaaaaaa-3333-4333-8333-333333333333",
            "date": "2026-11-07",
            "name": "Материал для архива",
            "unit": "шт",
            "qty": 1,
            "note": "",
            "createdAt": "2026-11-07T10:00:00.000Z",
            "updatedAt": "2026-11-07T10:00:00.000Z",
            "archivedAt": None,
            "history": [],
        }
        status, payload = self.request("/records", "POST", {"records": [record]})
        self.assertEqual(status, 200, payload)
        archived = dict(record)
        archived["archivedAt"] = "2026-11-07T10:10:00.000Z"
        archived["updatedAt"] = "2026-11-07T10:10:00.000Z"
        status, payload = self.request("/records", "POST", {"records": [archived]})
        self.assertEqual(status, 200, payload)
        self.assertTrue(any(item["id"] == record["id"] and item["archivedAt"] for item in payload["records"]))


if __name__ == "__main__":
    unittest.main()
