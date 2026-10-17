"""Traces and steps as Kalibra receives them."""

from __future__ import annotations

import asyncio
import threading
import time

from _fake import KEY, SdkTestCase

import kalibra
from kalibra import _core, _transport


class TracingTest(SdkTestCase):
    def test_nested_trace_and_steps_have_the_documented_shape(self) -> None:
        self.start(environment="dev", release="1.4.2")

        @kalibra.trace("answer_question")
        def answer(question):
            kalibra.current_trace().metadata["user"] = "u1"
            kalibra.current_trace().tags.append("smoke")
            with kalibra.step("retrieve", kind="retrieval") as s:
                s.output = [{"id": "kb-17", "text": "Block the card in the app"}]
                s.set(top_k=3)
            return llm(question)

        @kalibra.step(kind="llm")
        def llm(prompt):
            return f"Answer to {prompt}"

        self.assertEqual(answer("How do I block my card?"), "Answer to How do I block my card?")
        [t] = self.sent()
        self.assertEqual(t["name"], "answer_question")
        self.assertEqual(t["status"], "ok")
        self.assertEqual(t["input"], "How do I block my card?")
        self.assertEqual(t["output"], "Answer to How do I block my card?")
        self.assertEqual(t["metadata"], {"user": "u1", "environment": "dev", "release": "1.4.2"})
        self.assertEqual(t["tags"], ["smoke"])
        self.assertRegex(t["id"], r"^[0-9a-f]{32}$")
        self.assertRegex(t["startedAt"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")
        self.assertGreaterEqual(t["durationMs"], 0)
        retrieve, call = t["spans"]
        self.assertEqual((retrieve["name"], retrieve["kind"]), ("retrieve", "retrieval"))
        self.assertEqual(retrieve["output"], [{"id": "kb-17", "text": "Block the card in the app"}])
        self.assertEqual(retrieve["attributes"], {"top_k": 3})
        self.assertNotIn("parentId", retrieve)
        self.assertEqual((call["name"], call["kind"], call["input"]), ("TracingTest.test_nested_trace_and_steps_have_the_documented_shape.<locals>.llm", "llm", "How do I block my card?"))
        self.assertRegex(call["id"], r"^[0-9a-f]{16}$")

    def test_a_trace_inside_a_trace_becomes_a_child_step(self) -> None:
        self.start()

        @kalibra.trace("inner")
        def inner(x):
            with kalibra.step("deep", kind="tool"):
                return x

        with kalibra.trace("outer") as t:
            t.input = {"q": 1}
            inner(5)
            t.output = "done"
        [tr] = self.sent()
        self.assertEqual(tr["name"], "outer")
        spans = {s["name"]: s for s in tr["spans"]}
        self.assertEqual(spans["inner"]["kind"], "step")
        self.assertEqual(spans["deep"]["parentId"], spans["inner"]["id"])
        self.assertEqual(spans["inner"]["output"], 5)

    def test_errors_are_recorded_and_raised_unchanged(self) -> None:
        self.start()

        class Boom(Exception):
            pass

        @kalibra.trace("fails")
        def fails():
            with kalibra.step("llm", kind="llm"):
                raise Boom("rate limited")

        with self.assertRaises(Boom):
            fails()
        [t] = self.sent()
        self.assertEqual(t["status"], "error")
        self.assertEqual(t["error"], "Boom: rate limited")
        self.assertEqual(t["spans"][0]["error"], "Boom: rate limited")

    def test_async_functions_and_concurrent_tasks_keep_their_own_traces(self) -> None:
        self.start()

        @kalibra.step(kind="llm")
        async def call_model(q):
            await asyncio.sleep(0.01)
            return q.upper()

        @kalibra.trace("answer")
        async def answer(q):
            return await call_model(q)

        async def main():
            return await asyncio.gather(*(answer(q) for q in ("a", "b", "c")))

        self.assertEqual(asyncio.run(main()), ["A", "B", "C"])
        traces = self.sent()
        self.assertEqual(sorted(t["input"] for t in traces), ["a", "b", "c"])
        for t in traces:
            self.assertEqual(len(t["spans"]), 1)
            self.assertEqual(t["spans"][0]["output"], t["input"].upper())

    def test_generators_record_the_streamed_text_without_leaking_context(self) -> None:
        self.start()

        @kalibra.trace("stream")
        def stream(prompt):
            for word in ("Hello", " ", "world"):
                yield word

        chunks = []
        for chunk in stream("hi"):
            chunks.append(chunk)
            # Between chunks the caller is not inside the generator's trace.
            self.assertIsNone(kalibra.current_trace().id)
        self.assertEqual("".join(chunks), "Hello world")

        @kalibra.trace("numbers")
        def numbers():
            yield from range(10)

        self.assertEqual(sum(numbers()), 45)

        @kalibra.trace("early_stop")
        def endless():
            i = 0
            while True:
                yield i
                i += 1

        g = endless()
        next(g), next(g)
        g.close()

        traces = {t["name"]: t for t in self.sent()}
        self.assertEqual(traces["stream"]["output"], "Hello world")
        self.assertEqual(traces["numbers"]["output"], {"items": 10, "first": [0, 1, 2, 3, 4]})
        self.assertEqual(traces["early_stop"]["status"], "ok")  # stopping early is not an error

    def test_async_generators(self) -> None:
        self.start()

        @kalibra.trace("astream")
        async def astream():
            for t in ("a", "b"):
                await asyncio.sleep(0)
                yield t

        async def main():
            return [x async for x in astream()]

        self.assertEqual(asyncio.run(main()), ["a", "b"])
        [t] = self.sent()
        self.assertEqual(t["output"], "ab")

    def test_steps_outside_a_trace_record_nothing(self) -> None:
        self.start()
        with kalibra.step("orphan", kind="llm") as s:
            s.output = "x"
        self.assertEqual(self.sent(), [])

    def test_sampling_is_decided_once_per_trace(self) -> None:
        self.start(sample_rate=0)

        seen = []

        @kalibra.trace("sampled_out")
        def f():
            with kalibra.step("inner"):
                seen.append(kalibra.current_trace().id)
            return 1

        for _ in range(20):
            f()
        self.assertEqual(seen, [None] * 20)  # nested steps of a skipped trace are skipped too
        self.assertEqual(self.sent(), [])
        # Rows of a Kalibra eval run are always kept.
        with kalibra.from_headers({"x-kalibra-result": "res_1"}):
            f()
        [t] = self.sent()
        self.assertEqual(t["resultId"], "res_1")

    def test_large_values_are_truncated_and_copied(self) -> None:
        self.start()
        # The 32 KB budget is spent in order: later keys are cut once it runs out.
        data = {"raw": b"\x00" * 10, "blob": "x" * 100_000, "items": list(range(50_000))}
        cyc: dict = {"name": "loop"}
        cyc["self"] = cyc

        with kalibra.trace("big") as t:
            t.input = data
            t.output = cyc
            for i in range(300):
                with kalibra.step(f"s{i}"):
                    pass
        data["blob"] = "changed after the trace ended"
        [tr] = self.sent()
        self.assertIn("…[truncated", tr["input"]["blob"])
        self.assertEqual(tr["input"]["…"], "[1 more keys]")
        self.assertLess(len(str(tr["input"])), 40_000)
        self.assertEqual(tr["input"]["raw"], "<10 bytes>")
        self.assertEqual(tr["output"]["self"], "[circular]")
        self.assertEqual(len(tr["spans"]), 256)
        self.assertEqual(tr["metadata"]["kalibra.dropped_spans"], 44)

    def test_redaction_on_the_way_out(self) -> None:
        self.start()
        secret = "Call +1 415 555 0100, mail jo@example.com, card 4111 1111 1111 1111, key sk-abcdefghijklmnopqrstuvwxyz"
        with kalibra.trace("pii") as t:
            t.input = {"text": secret, "count": 1234567}
        [tr] = self.sent()
        text = tr["input"]["text"]
        for leaked in ("415 555", "jo@example.com", "4111", "sk-abc"):
            self.assertNotIn(leaked, text)
        self.assertEqual(text.count("[redacted]"), 4)
        self.assertEqual(tr["input"]["count"], 1234567)

    def test_custom_and_disabled_redaction(self) -> None:
        self.start(redact=lambda s: s.replace("secret", "***"))
        with kalibra.trace("custom") as t:
            t.output = "my secret, jo@example.com"
        self.assertEqual(self.sent()[0]["output"], "my ***, jo@example.com")
        self.fake.reset()
        self.start(redact=False)
        with kalibra.trace("raw") as t:
            t.output = "jo@example.com"
        self.assertEqual(self.sent()[0]["output"], "jo@example.com")

    def test_batches_and_early_flush(self) -> None:
        self.start(flush_interval=30)  # only the span count can trigger a send
        for i in range(250):
            with kalibra.trace(f"t{i}"):
                pass
        deadline = time.time() + 3
        while not self.fake.traces() and time.time() < deadline:
            time.sleep(0.02)
        self.assertGreaterEqual(len(self.fake.traces()), _transport.FLUSH_AT_SPANS // 2)
        self.assertEqual(len(self.sent()), 250)
        self.assertLess(len(self.fake.trace_posts), 10)

    def test_retries_then_succeeds(self) -> None:
        self.start()
        self.fake.fail_next = 2
        with kalibra.trace("retry"):
            pass
        self.assertEqual([t["name"] for t in self.sent()], ["retry"])

    def test_gives_up_quietly_when_kalibra_is_unreachable(self) -> None:
        kalibra.init(url="http://127.0.0.1:9", key=KEY, flush_interval=0.01, timeout=0.2)
        old = _transport.RETRY_DELAYS
        _transport.RETRY_DELAYS = (0.01, 0.01)
        try:
            with self.assertLogs("kalibra", level="WARNING") as logs:
                with kalibra.trace("lost"):
                    pass
                kalibra.flush(timeout=5)
            self.assertIn("could not reach Kalibra", "\n".join(logs.output))
            self.assertEqual(_core._state.transport.dropped, 1)
        finally:
            _transport.RETRY_DELAYS = old

    def test_refused_keys_are_not_retried(self) -> None:
        self.start()
        self.fake.reject_status = 401
        with self.assertLogs("kalibra", level="WARNING") as logs:
            with kalibra.trace("refused"):
                pass
            kalibra.flush()
        self.assertIn("Check KALIBRA_KEY", "\n".join(logs.output))
        self.assertEqual(len(self.fake.headers), 1)

    def test_the_queue_is_bounded(self) -> None:
        self.start(flush_interval=60)
        t = _core._state.transport
        t.max_queued_spans = 50
        with mock_post_blocked(t):
            for i in range(200):
                with kalibra.trace(f"t{i}"):
                    pass
            self.assertLessEqual(t._queued_spans, 50)
            self.assertGreater(t.dropped, 100)

    def test_steps_in_other_threads_need_the_context(self) -> None:
        self.start()
        import contextvars

        with kalibra.trace("threads"):
            ctx = contextvars.copy_context()

            def work():
                with kalibra.step("in_thread"):
                    pass

            th = threading.Thread(target=ctx.run, args=(work,))
            th.start()
            th.join()
            bare = threading.Thread(target=work)
            bare.start()
            bare.join()
        [t] = self.sent()
        self.assertEqual([s["name"] for s in t["spans"]], ["in_thread"])

    def test_init_again_replaces_the_sender(self) -> None:
        self.start()
        with kalibra.trace("first"):
            pass
        self.start(project="Other")
        with kalibra.trace("second"):
            pass
        self.sent()
        self.assertIn("/api/projects/Support%20bot/ingest/traces", self.fake.paths)
        self.assertIn("/api/projects/Other/ingest/traces", self.fake.paths)


class mock_post_blocked:
    """Holds the sender thread (without sending) so the queue fills up."""

    def __init__(self, transport) -> None:
        self.t = transport

    def __enter__(self):
        self.t._cond.acquire()
        return self

    def __exit__(self, *exc):
        self.t._cond.release()
        return False
