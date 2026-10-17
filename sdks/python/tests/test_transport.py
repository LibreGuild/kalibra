"""The HTTP client never hands the key or token to another host."""

from __future__ import annotations

import http.server
import threading
import unittest

from kalibra._transport import HttpError, request_json


class _Quiet(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args) -> None:  # noqa: D401 - silence test output
        pass


class RedirectTest(unittest.TestCase):
    def test_redirects_are_errors_and_the_key_stays_home(self) -> None:
        seen = {}

        class Other(_Quiet):
            def do_GET(self) -> None:
                seen["authorization"] = self.headers.get("Authorization")
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"{}")

            do_POST = do_GET

        other = http.server.HTTPServer(("127.0.0.1", 0), Other)

        class Gateway(_Quiet):
            def do_POST(self) -> None:
                self.send_response(302)
                self.send_header("Location", f"http://localhost:{other.server_port}/login?state=x")
                self.end_headers()

            do_GET = do_POST

        gateway = http.server.HTTPServer(("127.0.0.1", 0), Gateway)
        for s in (gateway, other):
            threading.Thread(target=s.serve_forever, daemon=True).start()
        try:
            for method in ("GET", "POST"):
                with self.subTest(method=method):
                    with self.assertRaises(HttpError) as ctx:
                        request_json(method, f"http://127.0.0.1:{gateway.server_port}/kalibra/api/x", "kpat_secret", {"a": 1} if method == "POST" else None)
                    self.assertEqual(ctx.exception.status, 302)
                    self.assertIn("final address", str(ctx.exception))
            self.assertEqual(seen, {})
        finally:
            gateway.shutdown()
            other.shutdown()


if __name__ == "__main__":
    unittest.main()
