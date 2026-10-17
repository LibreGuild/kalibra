"""A tiny stand-in for Kalibra's HTTP API (ingest + code-run ops), for the SDK tests."""

from __future__ import annotations

import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple
from unittest import mock
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import kalibra  # noqa: E402
from kalibra import _core, _transport  # noqa: E402

KEY = "kik_test_0123456789abcdef0123"


class FakeKalibra:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.trace_posts: List[Dict[str, Any]] = []  # each POST body
        self.tool_posts: List[Dict[str, Any]] = []
        self.recordings: Dict[Tuple[str, str], Dict[str, Any]] = {}
        self.tool_gets: List[Tuple[str, str]] = []
        self.ops: List[Tuple[str, Dict[str, Any]]] = []
        self.headers: List[Dict[str, str]] = []
        self.paths: List[str] = []
        self.fail_next = 0  # answer this many POSTs with 500
        self.reject_status: Optional[int] = None
        self.rows = [
            {"id": "row_1", "data": {"question": "a", "expected": "A"}},
            {"id": "row_2", "data": {"question": "b", "expected": "B"}},
            {"id": "row_3", "data": {"question": "c", "expected": "C"}},
        ]
        self.submitted: List[Dict[str, Any]] = []
        self.unlinked = 0  # submitted traceIds whose trace had not arrived yet
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a: Any) -> None:  # quiet
                pass

            def _send(self, status: int, body: Any) -> None:
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _body(self) -> Any:
                n = int(self.headers.get("content-length") or 0)
                return json.loads(self.rfile.read(n) or b"{}")

            def do_GET(self) -> None:
                u = urlparse(self.path)
                with fake.lock:
                    fake.headers.append(dict(self.headers))
                    fake.paths.append(u.path)
                if not u.path.startswith("/kalibra/api/"):  # like the server: everything lives under /kalibra
                    return self._send(404, {"error": {"code": "not_found", "message": "outside /kalibra"}})
                if u.path.endswith("/ingest/tools"):
                    q = parse_qs(u.query)
                    key = (q["tool"][0], q["argsHash"][0])
                    with fake.lock:
                        fake.tool_gets.append(key)
                        rec = fake.recordings.get(key)
                    if rec is None:
                        return self._send(200, {"found": False})
                    return self._send(200, {"found": True, "output": rec.get("output"), "error": rec.get("error")})
                self._send(404, {"error": {"code": "not_found", "message": "no route"}})

            def do_POST(self) -> None:
                u = urlparse(self.path)
                body = self._body()
                with fake.lock:
                    fake.headers.append(dict(self.headers))
                    fake.paths.append(u.path)
                    if fake.reject_status:
                        return self._send(fake.reject_status, {"error": {"code": "forbidden", "message": "nope"}})
                    if fake.fail_next > 0:
                        fake.fail_next -= 1
                        return self._send(500, {"error": {"code": "internal", "message": "boom"}})
                if not u.path.startswith("/kalibra/api/"):
                    return self._send(404, {"error": {"code": "not_found", "message": "outside /kalibra"}})
                if u.path.endswith("/ingest/traces"):
                    with fake.lock:
                        fake.trace_posts.append(body)
                    return self._send(202, {"accepted": len(body.get("traces", []))})
                if u.path.endswith("/ingest/tools"):
                    with fake.lock:
                        fake.tool_posts.append(body)
                        # Like the server: stored under its own hash of the posted args, not the claimed argsHash.
                        fake.recordings[(body["tool"], kalibra.args_hash(body.get("args")))] = body
                    return self._send(200, {"ok": True})
                if "/ops/" in u.path:
                    name = u.path.rsplit("/", 1)[1]
                    with fake.lock:
                        fake.ops.append((name, body))
                    return self._send(200, {"data": fake.op(name, body)})
                self._send(404, {"error": {"code": "not_found", "message": "no route"}})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def op(self, name: str, body: Dict[str, Any]) -> Any:
        if name == "start_code_run":
            if body.get("dataset") == "missing":
                return None
            rows = self.rows[: body["limit"]] if body.get("limit") else self.rows
            return {"runId": "run_code_1", "rows": rows}
        if name == "submit_code_results":
            # Like the server: a result links to its trace only if the trace has already arrived.
            received = {t["id"] for t in self.traces()}
            with self.lock:
                self.unlinked += len([r for r in body["results"] if r.get("traceId") and r["traceId"] not in received])
                self.submitted.extend(body["results"])
            return {"accepted": len(body["results"])}
        if name == "finish_code_run":
            expected = {r["id"]: r["data"]["expected"] for r in self.rows}
            passed = [r for r in self.submitted if not r.get("error") and r["outputs"].get("output") == expected.get(r["rowId"])]
            failed = [r for r in self.submitted if r not in passed]
            total = len(self.submitted)
            summary = {"passRate": len(passed) / total if total else None, "passed": len(passed), "failed": len(failed)}
            return {
                "run": {"id": body["runId"], "status": "completed", "summary": summary},
                "summary": summary,
                "baseline": {"runId": body.get("baselineRunId") or "run_base", "passRate": 1.0},
                "newFailures": [{"rowId": r["rowId"], "reason": r.get("error") or "wrong answer"} for r in failed],
                "fixed": [],
            }
        return None

    # helpers

    def traces(self) -> List[Dict[str, Any]]:
        with self.lock:
            return [t for post in self.trace_posts for t in post.get("traces", [])]

    def reset(self) -> None:
        with self.lock:
            self.trace_posts.clear()
            self.tool_posts.clear()
            self.recordings.clear()
            self.tool_gets.clear()
            self.ops.clear()
            self.headers.clear()
            self.paths.clear()
            self.submitted.clear()
            self.unlinked = 0
            self.fail_next = 0
            self.reject_status = None

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class SdkTestCase(unittest.TestCase):
    """Starts one fake Kalibra per test class and gives every test a clean SDK and environment."""

    fake: FakeKalibra

    @classmethod
    def setUpClass(cls) -> None:
        cls.fake = FakeKalibra()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.fake.close()

    def setUp(self) -> None:
        self.fake.reset()
        _core._reset_for_tests()
        _transport._warned.clear()
        clean = {k: v for k, v in os.environ.items() if not k.startswith("KALIBRA_")}
        self._env = mock.patch.dict(os.environ, clean, clear=True)
        self._env.start()
        self.addCleanup(self._env.stop)
        self.addCleanup(_core._reset_for_tests)

    def start(self, **kw: Any) -> bool:
        opts: Dict[str, Any] = {"url": self.fake.url, "key": KEY, "project": "Support bot", "flush_interval": 0.05}
        opts.update(kw)
        return kalibra.init(**opts)

    def sent(self) -> List[Dict[str, Any]]:
        self.assertTrue(kalibra.flush(timeout=5), "flush timed out")
        return self.fake.traces()
