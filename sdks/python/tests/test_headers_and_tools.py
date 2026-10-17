"""Linking requests to Kalibra eval rows, and tool record / replay / faults."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os

from _fake import SdkTestCase

import kalibra
from kalibra import _core, _tools

TP_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736"
TP_SPAN = "00f067aa0ba902b7"
HEADERS = {
    "traceparent": f"00-{TP_TRACE}-{TP_SPAN}-01",
    "x-kalibra-run": "run_42",
    "x-kalibra-result": "res_7",
    "x-kalibra-tools": "replay",
}


class HeadersTest(SdkTestCase):
    def test_traceparent_parsing(self) -> None:
        self.assertEqual(kalibra.parse_traceparent(HEADERS["traceparent"]), (TP_TRACE, TP_SPAN))
        for bad in (None, "", "00-xyz-abc-01", f"00-{'0' * 32}-{TP_SPAN}-01", f"00-{TP_TRACE}-{'0' * 16}-01", "garbage"):
            self.assertEqual(kalibra.parse_traceparent(bad), (None, None))

    def test_from_headers_accepts_any_header_shape(self) -> None:
        shapes = [
            HEADERS,
            {k.upper(): v for k, v in HEADERS.items()},  # case-insensitive
            {k.title(): v for k, v in HEADERS.items()},
            list(HEADERS.items()),  # list of pairs (ASGI-like)
        ]
        for shape in shapes:
            with self.subTest(shape=type(shape).__name__):
                with kalibra.from_headers(shape) as inc:
                    self.assertEqual((inc.trace_id, inc.run_id, inc.result_id, inc.tools), (TP_TRACE, "run_42", "res_7", "replay"))
                self.assertIsNone(_core.incoming())

    def test_traces_join_the_eval_row(self) -> None:
        self.start(sample_rate=0)  # linked traces are kept anyway

        @kalibra.trace("handle")
        def handle():
            return "ok"

        with kalibra.from_headers(HEADERS):
            handle()
        [t] = self.sent()
        self.assertEqual((t["id"], t["runId"], t["resultId"]), (TP_TRACE, "run_42", "res_7"))

    def test_each_trace_of_a_request_has_its_own_id(self) -> None:
        self.start()
        with kalibra.from_headers(HEADERS):
            with kalibra.trace("classify"):
                pass
            with kalibra.trace("answer"):
                pass
        # A traceparent without Kalibra headers is someone else's distributed trace: not reused.
        with kalibra.from_headers({"traceparent": HEADERS["traceparent"]}) as inc:
            self.assertIsNone(inc.trace_id)
            with kalibra.trace("plain"):
                pass
        first, second, plain = self.sent()
        self.assertEqual(first["id"], TP_TRACE)
        self.assertNotEqual(second["id"], TP_TRACE)
        self.assertEqual((second["runId"], second["resultId"]), ("run_42", "res_7"))
        self.assertNotEqual(plain["id"], TP_TRACE)

    def test_asgi_middleware(self) -> None:
        self.start()
        seen = {}

        @kalibra.trace("endpoint")
        async def endpoint():
            seen["tools"] = kalibra.tool_mode()
            return "ok"

        async def app(scope, receive, send):
            if scope["type"] == "http":
                await endpoint()
            else:
                seen["other"] = _core.incoming()

        mw = kalibra.KalibraASGIMiddleware(app)
        scope = {"type": "http", "headers": [(k.encode(), v.encode()) for k, v in HEADERS.items()] + [(b"content-type", b"application/json")]}
        asyncio.run(mw(scope, None, None))
        asyncio.run(mw({"type": "lifespan"}, None, None))  # other scope types pass through
        [t] = self.sent()
        self.assertEqual((t["runId"], t["resultId"]), ("run_42", "res_7"))
        self.assertEqual(seen["tools"], "replay")
        self.assertIsNone(seen["other"])

    def test_wsgi_middleware(self) -> None:
        self.start()

        @kalibra.trace("view")
        def view():
            return [b"ok"]

        def app(environ, start_response):
            return view()

        mw = kalibra.KalibraWSGIMiddleware(app)
        environ = {"HTTP_" + k.upper().replace("-", "_"): v for k, v in HEADERS.items()}
        self.assertEqual(mw(environ, lambda *a: None), [b"ok"])
        self.assertEqual(mw({}, lambda *a: None), [b"ok"])  # no Kalibra headers: a normal request
        traces = self.sent()
        self.assertEqual(sorted(str(t.get("resultId")) for t in traces), ["None", "res_7"])

    def test_django_middleware_sync_and_async(self) -> None:
        self.start()

        class Request:
            headers = HEADERS

        @kalibra.trace("django_view")
        def get_response(request):
            return "response"

        mw = kalibra.KalibraDjangoMiddleware(get_response)
        self.assertEqual(mw(Request()), "response")

        async def aget_response(request):
            return await asyncio.sleep(0, "async response")

        amw = kalibra.KalibraDjangoMiddleware(aget_response)
        self.assertEqual(asyncio.run(amw(Request())), "async response")
        [t] = self.sent()
        self.assertEqual(t["resultId"], "res_7")


class ToolsTest(SdkTestCase):
    def test_args_hash_is_sha256_of_canonical_json(self) -> None:
        args = [{"order_id": "A12", "limit": 5.0, "zeta": [1, "é"], "alpha": None}]
        canonical = '[{"alpha":null,"limit":5,"order_id":"A12","zeta":[1,"é"]}]'
        self.assertEqual(kalibra.canonical_json(args), canonical)
        self.assertEqual(kalibra.args_hash(args), hashlib.sha256(canonical.encode()).hexdigest())
        # Shaped like the JS SDK: one argument is the value itself, keyword arguments alone one object.
        self.assertEqual(_tools.tool_args(({"q": "x"},), {}), {"q": "x"})
        self.assertEqual(_tools.tool_args((), {"q": "x"}), {"q": "x"})
        self.assertEqual(_tools.tool_args(("a", 1), {}), ["a", 1])
        self.assertEqual(_tools.tool_args(("a", 1), {"k": True}), ["a", 1, {"k": True}])

    def test_hashes_match_the_js_sdk(self) -> None:
        # Computed with the JS SDK's argsHash (packages/sdk/src/tools.ts) for the same value.
        value = {"order_id": "A12", "limit": 5, "zeta": [1, "é", None, True], "Alpha": {"b": 0.1, "a": -2.5e-7}}
        self.assertEqual(kalibra.canonical_json(value), '{"Alpha":{"a":-2.5e-7,"b":0.1},"limit":5,"order_id":"A12","zeta":[1,"é",null,true]}')
        self.assertEqual(kalibra.args_hash(value), "3bc8f3ed3776ed9a2cf88d5afdacf6cc337212333a18eec67adac7046ac4c9c4")
        # JavaScript's number layout, keys in UTF-16 order, NaN as null.
        self.assertEqual(kalibra.canonical_json([1.0, 1e-7, 1e21, 2**60, float("nan")]), "[1,1e-7,1e+21,1152921504606847000,null]")
        self.assertEqual(kalibra.canonical_json({"\U0001F600": 1, "\uffff": 2}), '{"\U0001F600":1,"\uffff":2}')

    def test_live_calls_are_recorded_as_tool_steps(self) -> None:
        self.start()

        @kalibra.tool("search_orders")
        def search_orders(order_id):
            return {"id": order_id, "status": "shipped"}

        with kalibra.trace("agent"):
            self.assertEqual(search_orders(order_id="A12")["status"], "shipped")
        [t] = self.sent()
        [span] = t["spans"]
        self.assertEqual((span["name"], span["kind"]), ("search_orders", "tool"))
        self.assertEqual(span["input"], {"order_id": "A12"})
        self.assertEqual(span["output"], {"id": "A12", "status": "shipped"})
        self.assertEqual(self.fake.tool_posts, [])

    def test_record_then_replay(self) -> None:
        self.start()
        calls = []

        def real(order_id, *, verbose=False):
            calls.append(order_id)
            return {"order": order_id, "total": 12.5}

        search = kalibra.tool("search_orders")(real)
        os.environ["KALIBRA_TOOLS"] = "record"
        search("A12", verbose=True)
        kalibra.flush()
        [rec] = self.fake.tool_posts
        self.assertEqual(rec["tool"], "search_orders")
        self.assertEqual(rec["args"], ["A12", {"verbose": True}])
        self.assertEqual(rec["argsHash"], kalibra.args_hash(["A12", {"verbose": True}]))
        self.assertEqual(rec["output"], {"order": "A12", "total": 12.5})

        os.environ["KALIBRA_TOOLS"] = "replay"
        self.assertEqual(search("A12", verbose=True), {"order": "A12", "total": 12.5})
        self.assertEqual(calls, ["A12"])  # replayed: the real function did not run again
        self.assertEqual(search("B99"), {"order": "B99", "total": 12.5})  # no recording: called for real
        self.assertEqual(calls, ["A12", "B99"])
        search("A12", verbose=True)
        self.assertEqual(len([g for g in self.fake.tool_gets if g[1] == rec["argsHash"]]), 1)  # cached

    def test_replay_strict_and_recorded_errors(self) -> None:
        self.start()

        @kalibra.tool("pay")
        def pay(amount):
            raise ValueError("card declined")

        os.environ["KALIBRA_TOOLS"] = "record"
        with self.assertRaises(ValueError):
            pay(10)
        kalibra.flush()
        self.assertEqual(self.fake.tool_posts[0]["error"], "ValueError: card declined")

        os.environ["KALIBRA_TOOLS"] = "replay"
        with self.assertRaisesRegex(RuntimeError, "card declined"):
            pay(10)
        os.environ["KALIBRA_TOOLS"] = "replay-strict"
        with self.assertRaises(kalibra.ReplayMissing):
            pay(99)

    def test_faults_never_call_the_tool(self) -> None:
        self.start()
        calls = []

        @kalibra.tool("send_email")
        def send_email(to):
            calls.append(to)
            return "sent"

        with kalibra.from_headers({"x-kalibra-tools": "fault:timeout"}):
            with self.assertRaises(TimeoutError):
                send_email("a@example.com")
        with kalibra.from_headers({"x-kalibra-tools": "fault:error"}):
            with self.assertRaises(RuntimeError):
                send_email("a@example.com")
        with kalibra.from_headers({"x-kalibra-tools": "fault:empty"}):
            self.assertIsNone(send_email("a@example.com"))
        self.assertEqual(calls, [])

    def test_header_mode_wins_over_the_environment(self) -> None:
        self.start()
        os.environ["KALIBRA_TOOLS"] = "fault:error"
        with kalibra.from_headers({"x-kalibra-tools": "live"}):
            self.assertEqual(kalibra.tool_mode(), "live")
        self.assertEqual(kalibra.tool_mode(), "fault:error")
        os.environ["KALIBRA_TOOLS"] = "nonsense"
        with self.assertLogs("kalibra", level="WARNING"):
            self.assertEqual(kalibra.tool_mode(), "live")

    def test_async_tools(self) -> None:
        self.start()
        self.fake.recordings[("lookup", kalibra.args_hash("x"))] = {"output": "recorded"}

        @kalibra.tool("lookup")
        async def lookup(key):
            return "live"

        async def main():
            live = await lookup("x")
            os.environ["KALIBRA_TOOLS"] = "replay"
            return live, await lookup("x")

        self.assertEqual(asyncio.run(main()), ("live", "recorded"))

    def test_recordings_are_exact_so_replay_works(self) -> None:
        # Personal data and big values: the recording keeps them as they are (Kalibra finds it by a
        # hash of the exact arguments, and replay returns the exact result); the trace is redacted.
        self.start()
        calls = []
        docs = [{"id": f"kb-{i}", "text": "é" * 4000} for i in range(20)]

        @kalibra.tool("lookup_user")
        def lookup_user(email, note):
            calls.append(email)
            return {"email": email, "plan": "pro", "docs": docs}

        note = "refund policy " * 1000  # a 14 KB argument
        os.environ["KALIBRA_TOOLS"] = "record"
        with kalibra.trace("agent"):
            lookup_user("jo@example.com", note)
        kalibra.flush()
        [rec] = self.fake.tool_posts
        self.assertEqual(rec["args"], ["jo@example.com", note])
        self.assertEqual(json.dumps(self.sent()).count("jo@example.com"), 0)

        os.environ["KALIBRA_TOOLS"] = "replay-strict"
        self.assertEqual(lookup_user("jo@example.com", note), {"email": "jo@example.com", "plan": "pro", "docs": docs})
        self.assertEqual(calls, ["jo@example.com"])
