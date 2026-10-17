"""Overhead budgets. Generous enough for slow CI machines; the printed numbers are the real figures."""

from __future__ import annotations

import sys
import time

from _fake import SdkTestCase

import kalibra

N_DISABLED = 100_000
N_TRACES = 5_000


def work(x):
    return x + 1


class OverheadTest(SdkTestCase):
    def test_disabled_costs_nothing(self) -> None:
        kalibra.init(enabled=False)
        traced = kalibra.trace("work")(work)
        self.assertIs(traced, work)

        t0 = time.perf_counter()
        for i in range(N_DISABLED):
            work(i)
        raw = time.perf_counter() - t0

        t0 = time.perf_counter()
        for i in range(N_DISABLED):
            with kalibra.step("s"):
                work(i)
        with_cm = time.perf_counter() - t0

        per_cm_us = (with_cm - raw) / N_DISABLED * 1e6
        print(f"\n  disabled: {N_DISABLED} decorated calls = plain function ({raw * 1000:.1f} ms); `with kalibra.step()` adds {per_cm_us:.2f} µs per block", file=sys.stderr)
        self.assertLess(per_cm_us, 5)

    def test_enabled_stays_cheap_in_the_call_path(self) -> None:
        self.start(flush_interval=0.2)

        @kalibra.trace("answer")
        def answer(q):
            with kalibra.step("retrieve", kind="retrieval") as s:
                s.output = [{"id": "kb-1", "text": "short"}]
            with kalibra.step("llm", kind="llm") as s:
                s.set(model="m", tokens_in=10)
                return q

        t0 = time.perf_counter()
        for i in range(N_TRACES):
            answer(f"question {i}")
        call_path = time.perf_counter() - t0
        per_trace_us = call_path / N_TRACES * 1e6

        t0 = time.perf_counter()
        self.assertTrue(kalibra.flush(timeout=30))
        drain = time.perf_counter() - t0
        sent = len(self.fake.traces())
        print(f"  enabled: {N_TRACES} traces (2 steps each) cost {per_trace_us:.0f} µs each in the call path; background send drained in {drain * 1000:.0f} ms ({sent} sent in {len(self.fake.trace_posts)} requests)", file=sys.stderr)
        self.assertEqual(sent, N_TRACES)
        self.assertLess(per_trace_us, 400)

    def test_sampled_out_traces_are_nearly_free(self) -> None:
        self.start(sample_rate=0)
        traced = kalibra.trace("answer")(work)
        t0 = time.perf_counter()
        for i in range(N_DISABLED):
            traced(i)
        per_call_us = (time.perf_counter() - t0) / N_DISABLED * 1e6
        print(f"  sampled out: {per_call_us:.2f} µs per call", file=sys.stderr)
        self.assertLess(per_call_us, 15)
        self.assertEqual(self.sent(), [])
