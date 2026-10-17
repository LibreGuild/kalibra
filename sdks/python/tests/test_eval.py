"""``evaluate()``: a Kalibra dataset through a Python function, scored by Kalibra."""

from __future__ import annotations

import asyncio
import json
import os
import tempfile

from _fake import SdkTestCase

import kalibra
from kalibra.eval import KalibraError, evaluate, evaluate_async


class EvaluateTest(SdkTestCase):
    def run_eval(self, task, **kw):
        opts = {"url": self.fake.url, "token": "kal_test_token", "project": "Support bot", "git": {"branch": "feature/x"}}
        opts.update(kw)
        return evaluate("Support questions", "Chat checks", task, **opts)

    def test_scores_every_row_and_reports_failures(self) -> None:
        answers = {"a": "A", "b": "B", "c": "wrong"}
        result = self.run_eval(lambda row: answers[row["question"]], concurrency=2)
        self.assertEqual((result.run_id, result.passed, result.failed), ("run_code_1", 2, 1))
        self.assertAlmostEqual(result.pass_rate, 2 / 3)
        self.assertEqual(result.new_failures, [{"rowId": "row_3", "reason": "wrong answer"}])
        self.assertEqual(result.url, f"{self.fake.url}/p/Support%20bot/runs/run_code_1")
        names = [name for name, _ in self.fake.ops]
        self.assertEqual(names, ["start_code_run", "submit_code_results", "finish_code_run"])
        start = self.fake.ops[0][1]
        self.assertEqual(start, {"dataset": "Support questions", "suite": "Chat checks", "git": {"branch": "feature/x"}})
        auth = [h.get("Authorization") for h in self.fake.headers]
        self.assertEqual(set(auth), {"Bearer kal_test_token"})
        self.assertEqual(json.loads(self.fake.headers[0]["X-Kalibra-Actor"])["kind"], "cli")

    def test_outputs_metrics_and_errors(self) -> None:
        def task(row):
            if row["question"] == "b":
                raise TimeoutError("model too slow")
            return {"output": row["expected"], "sources": [{"id": "kb-1"}], "metrics": {"tokens": 42, "flag": True}}

        self.run_eval(task, batch_size=1)
        by_row = {r["rowId"]: r for r in self.fake.submitted}
        self.assertEqual(by_row["row_1"]["outputs"], {"output": "A", "sources": [{"id": "kb-1"}]})
        self.assertEqual(by_row["row_1"]["metrics"]["tokens"], 42.0)
        self.assertNotIn("flag", by_row["row_1"]["metrics"])  # only numbers are metrics
        self.assertGreaterEqual(by_row["row_1"]["metrics"]["latency_ms"], 0)
        self.assertEqual(by_row["row_2"], {**by_row["row_2"], "outputs": {}, "error": "TimeoutError: model too slow"})
        self.assertEqual(len([n for n, _ in self.fake.ops if n == "submit_code_results"]), 3)

    def test_traces_made_by_the_task_are_linked_to_their_row(self) -> None:
        self.start()

        @kalibra.trace("answer")
        def answer(q):
            with kalibra.step("llm", kind="llm"):
                return q.upper()

        self.run_eval(lambda row: answer(row["question"]))
        traces = self.fake.traces()
        self.assertEqual(len(traces), 3)
        self.assertEqual({t["runId"] for t in traces}, {"run_code_1"})
        submitted = {r["traceId"] for r in self.fake.submitted}
        self.assertEqual(submitted, {t["id"] for t in traces})

    def test_async_tasks(self) -> None:
        async def task(row):
            await asyncio.sleep(0.001)
            return row["expected"]

        result = self.run_eval(task)  # runs its own event loop
        self.assertEqual(result.passed, 3)

        async def inside_a_loop():
            with self.assertRaises(RuntimeError):
                self.run_eval(task)
            return await evaluate_async("Support questions", "Chat checks", task, url=self.fake.url, token="t", project="p", git={})

        self.fake.submitted.clear()
        self.assertEqual(asyncio.run(inside_a_loop()).passed, 3)

    def test_expect_fails_the_test_with_details(self) -> None:
        result = self.run_eval(lambda row: "nope")
        with self.assertRaises(AssertionError) as ctx:
            result.expect(min_pass_rate=0.9)
        self.assertIn("pass rate 0.0% is below 90%", str(ctx.exception))
        self.assertIn("row_1", str(ctx.exception))
        self.fake.submitted.clear()
        self.run_eval(lambda row: row["expected"], baseline="run_9").expect(min_pass_rate=1, no_new_failures=True)
        self.assertEqual(self.fake.ops[-1][1], {"runId": "run_code_1", "baselineRunId": "run_9"})

    def test_errors_from_kalibra_and_from_the_network(self) -> None:
        self.fake.reject_status = 403
        with self.assertRaises(KalibraError) as ctx:
            self.run_eval(lambda row: 1)
        self.assertEqual(ctx.exception.code, "forbidden")
        self.fake.reject_status = None
        with self.assertRaises(KalibraError) as ctx:
            self.run_eval(lambda row: 1, url="http://127.0.0.1:9", timeout=1)
        self.assertEqual(ctx.exception.code, "unavailable")

    def test_finds_the_running_app(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, ".engine.json"), "w") as f:
                json.dump({"url": self.fake.url, "token": "launch_token", "pid": os.getpid()}, f)
            os.environ["KALIBRA_DIR"] = d
            evaluate("Support questions", "Chat checks", lambda row: row["expected"], project="Support bot", git={})
        self.assertEqual(self.fake.headers[0]["Authorization"], "Bearer launch_token")

    def test_git_details_from_github_actions(self) -> None:
        os.environ.update({"GITHUB_HEAD_REF": "feature/y", "GITHUB_SHA": "abc123", "GITHUB_REF": "refs/pull/17/merge", "GITHUB_BASE_REF": "main"})
        evaluate("Support questions", "Chat checks", lambda row: row["expected"], url=self.fake.url, token="t", project="p")
        self.assertEqual(self.fake.ops[0][1]["git"], {"pr": "17", "baseBranch": "main", "branch": "feature/y", "commit": "abc123"})
