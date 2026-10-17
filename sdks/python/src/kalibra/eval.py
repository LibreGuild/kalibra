"""Evals from your own tests: run a Kalibra dataset through a Python function and score it there.

::

    from kalibra.eval import evaluate

    def test_support_bot():
        result = evaluate(dataset="Support questions", suite="Chat checks", task=lambda row: answer(row["question"]))
        result.expect(min_pass_rate=0.9)

No API or server of yours needs to run: Kalibra hands out the rows (``start_code_run``), your
``task`` runs here for each row (timed, errors caught), the outputs go back in batches
(``submit_code_results``), and Kalibra scores them with the suite and compares with the baseline
(``finish_code_run``). The run then shows up in Kalibra like any other.

Connection, in order: the ``url`` / ``token`` arguments, ``KALIBRA_URL`` / ``KALIBRA_TOKEN`` (a
personal access token, ``kal_…``, from Kalibra → Account), else the Kalibra app running on this
computer (found through ``<data folder>/.engine.json``).
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Mapping, Optional, Union
from urllib.parse import quote

from . import _core, _serialize
from ._transport import HttpError, request_json

OUTPUT_BUDGET = 1_000_000


class KalibraError(RuntimeError):
    """Kalibra answered with an error (``code`` is e.g. ``not_found``, ``invalid``, ``forbidden``)."""

    def __init__(self, message: str, code: str = "internal") -> None:
        super().__init__(message)
        self.code = code


@dataclass
class EvalResult:
    run_id: str
    pass_rate: Optional[float]
    passed: int
    failed: int
    errors: int
    new_failures: List[Dict[str, Any]]
    fixed: List[str]
    baseline: Optional[Dict[str, Any]]
    url: str
    summary: Dict[str, Any] = field(default_factory=dict)
    run: Dict[str, Any] = field(default_factory=dict)

    def expect(self, min_pass_rate: Optional[float] = None, no_new_failures: bool = False) -> "EvalResult":
        """Fails the test (``AssertionError``) below ``min_pass_rate`` or with new failures."""
        problems = []
        if min_pass_rate is not None and (self.pass_rate is None or self.pass_rate < min_pass_rate):
            rate = "no score" if self.pass_rate is None else f"{self.pass_rate:.1%}"
            problems.append(f"pass rate {rate} is below {min_pass_rate:.0%}")
        if no_new_failures and self.new_failures:
            problems.append(f"{len(self.new_failures)} rows fail that passed in the baseline")
        if problems:
            lines = [f"Kalibra eval {self.run_id}: " + "; ".join(problems), f"  {self.url}"]
            lines += [f"  - {f.get('rowId')}: {f.get('reason', '')}" for f in self.new_failures[:10]]
            raise AssertionError("\n".join(lines))
        return self


# ── Connection ───────────────────────────────────────────────────────────────


def _engine_info() -> Optional[Dict[str, Any]]:
    """The Kalibra app running on this computer, if any."""
    dirs = [os.environ.get("KALIBRA_DIR"), str(Path.home() / "Kalibra" / "default"), ".kalibra-dev"]
    for d in dirs:
        if not d:
            continue
        p = Path(d) / ".engine.json"
        try:
            info = json.loads(p.read_text("utf-8"))
            os.kill(int(info["pid"]), 0)  # still running?
            return info
        except Exception:
            continue
    return None


class _Client:
    def __init__(self, url: Optional[str], token: Optional[str], project: Optional[str], timeout: float) -> None:
        info = None
        if not (url or os.environ.get("KALIBRA_URL")) or not (token or os.environ.get("KALIBRA_TOKEN")):
            info = _engine_info()
        self.url = (url or os.environ.get("KALIBRA_URL") or (info or {}).get("url") or _core.DEFAULT_URL).rstrip("/")
        self.token = token or os.environ.get("KALIBRA_TOKEN") or (info or {}).get("token")
        self.project = project or os.environ.get("KALIBRA_PROJECT") or "default"
        self.timeout = timeout

    def op(self, name: str, body: Dict[str, Any]) -> Any:
        url = f"{self.url}/api/projects/{quote(self.project, safe='')}/ops/{name}"
        actor = {"kind": "cli", "client": "kalibra-sdk-python"}
        try:
            res = request_json("POST", url, self.token, body, timeout=self.timeout, extra_headers={"x-kalibra-actor": json.dumps(actor)})
        except HttpError as e:
            try:
                err = json.loads(e.body).get("error") or {}
            except Exception:
                err = {}
            raise KalibraError(f"{name}: {err.get('message') or e}", err.get("code") or f"http_{e.status}") from None
        except OSError as e:
            raise KalibraError(f"Could not reach Kalibra at {self.url} ({e}). Start the app, or set KALIBRA_URL and KALIBRA_TOKEN.", "unavailable") from None
        return res.get("data") if isinstance(res, dict) else res


def _git() -> Dict[str, Any]:
    """Branch, commit and PR from CI variables (GitHub Actions), else from git itself."""
    env = os.environ
    out: Dict[str, Any] = {}
    branch = env.get("GITHUB_HEAD_REF") or env.get("GITHUB_REF_NAME") or env.get("CI_COMMIT_REF_NAME")
    commit = env.get("GITHUB_SHA") or env.get("CI_COMMIT_SHA")
    ref = env.get("GITHUB_REF", "")
    if ref.startswith("refs/pull/"):
        out["pr"] = ref.split("/")[2]
    if env.get("GITHUB_BASE_REF"):
        out["baseBranch"] = env["GITHUB_BASE_REF"]
    if not branch or not commit:
        for key, cmd in (("branch", ["git", "rev-parse", "--abbrev-ref", "HEAD"]), ("commit", ["git", "rev-parse", "HEAD"])):
            if (key == "branch" and branch) or (key == "commit" and commit):
                continue
            try:
                value = subprocess.run(cmd, capture_output=True, text=True, timeout=2).stdout.strip()
            except Exception:
                value = ""
            if key == "branch":
                branch = value or None
            else:
                commit = value or None
    if branch and branch != "HEAD":
        out["branch"] = branch
    if commit:
        out["commit"] = commit
    return out


# ── Running ──────────────────────────────────────────────────────────────────


def _outputs(value: Any) -> Dict[str, Any]:
    """``task`` may return the output itself or ``{"output": …, other fields…, "metrics": {…}}``."""
    if isinstance(value, Mapping) and "output" in value:
        out = dict(value)
        out.pop("metrics", None)
        return _serialize.normalize(out, OUTPUT_BUDGET)
    return {"output": _serialize.normalize(value, OUTPUT_BUDGET)}


def _metrics(value: Any, latency_ms: float) -> Dict[str, float]:
    m: Dict[str, float] = {"latency_ms": round(latency_ms, 3)}
    extra = value.get("metrics") if isinstance(value, Mapping) else None
    if isinstance(extra, Mapping):
        for k, v in extra.items():
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                m[str(k)] = float(v)
    return m


def _result(row_id: str, inc: _core.Incoming, value: Any, error: Optional[BaseException], latency_ms: float) -> Dict[str, Any]:
    r: Dict[str, Any] = {"rowId": row_id, "metrics": _metrics(value, latency_ms)}
    if error is not None:
        r["outputs"] = {}
        r["error"] = _core._error_text(error)
    else:
        r["outputs"] = _outputs(value)
    if inc.used and inc.trace_id:
        r["traceId"] = inc.trace_id
    return r


def _start(client: _Client, dataset: str, suite: str, name: Optional[str], limit: Optional[int], tags: Optional[List[str]], git: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    body: Dict[str, Any] = {"dataset": dataset, "suite": suite, "git": git if git is not None else _git()}
    if name:
        body["name"] = name
    if limit:
        body["limit"] = limit
    if tags:
        body["tags"] = tags
    started = client.op("start_code_run", body)
    if not isinstance(started, dict) or "runId" not in started:
        raise KalibraError("start_code_run returned no run id")
    return started


def _submit(client: _Client, run_id: str, results: List[Dict[str, Any]]) -> None:
    # Kalibra links a row to its trace when the results arrive, so the traces go first.
    _core.flush(timeout=5.0)
    client.op("submit_code_results", {"runId": run_id, "results": results})


def _finish(client: _Client, run_id: str, baseline: Optional[str]) -> EvalResult:
    _core.flush(timeout=5.0)  # traces of the rows should arrive before scoring
    body: Dict[str, Any] = {"runId": run_id}
    if baseline:
        body["baselineRunId"] = baseline
    done = client.op("finish_code_run", body) or {}
    summary = done.get("summary") or (done.get("run") or {}).get("summary") or {}
    return EvalResult(
        run_id=run_id,
        pass_rate=summary.get("passRate"),
        passed=int(summary.get("passed") or 0),
        failed=int(summary.get("failed") or 0),
        errors=int(summary.get("targetErrors") or summary.get("errors") or 0),
        new_failures=list(done.get("newFailures") or []),
        fixed=list(done.get("fixed") or []),
        # The server names the baseline run "id"; expose it as "runId" too, like the JS SDK.
        baseline=({**done["baseline"], "runId": done["baseline"].get("id")} if done.get("baseline") else None),
        url=f"{client.url}/p/{quote(client.project, safe='')}/runs/{run_id}",
        summary=summary,
        run=done.get("run") or {},
    )


def evaluate(
    dataset: str,
    suite: str,
    task: Callable[[Dict[str, Any]], Any],
    *,
    name: Optional[str] = None,
    project: Optional[str] = None,
    concurrency: int = 4,
    limit: Optional[int] = None,
    tags: Optional[List[str]] = None,
    baseline: Optional[str] = None,
    url: Optional[str] = None,
    token: Optional[str] = None,
    git: Optional[Dict[str, Any]] = None,
    batch_size: int = 50,
    timeout: float = 60.0,
) -> EvalResult:
    """Runs ``task(row)`` for every row of ``dataset`` and scores the outputs with ``suite``.

    ``task`` gets the row's values (a dict) and returns the output, or a dict with ``output``,
    other fields the checks read, and optional numeric ``metrics``. An exception is recorded as
    that row's error. Async tasks are supported (or use ``await evaluate_async(...)`` inside a
    running event loop).
    """
    if asyncio.iscoroutinefunction(task):
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(
                evaluate_async(dataset, suite, task, name=name, project=project, concurrency=concurrency, limit=limit, tags=tags, baseline=baseline, url=url, token=token, git=git, batch_size=batch_size, timeout=timeout)
            )
        raise RuntimeError("evaluate() was called inside a running event loop with an async task: use `await evaluate_async(...)`")

    client = _Client(url, token, project, timeout)
    started = _start(client, dataset, suite, name, limit, tags, git)
    run_id: str = started["runId"]
    rows: List[Dict[str, Any]] = started.get("rows") or []

    def one(row: Dict[str, Any]) -> Dict[str, Any]:
        inc = _core.Incoming(run_id=run_id)
        with _core._IncomingScope(inc):
            t0 = time.perf_counter()
            try:
                value, error = task(row.get("data") or {}), None
            except Exception as e:
                value, error = None, e
            return _result(row["id"], inc, value, error, (time.perf_counter() - t0) * 1000)

    pending: List[Dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max(1, concurrency), thread_name_prefix="kalibra-eval") as pool:
        for fut in as_completed([pool.submit(one, r) for r in rows]):
            pending.append(fut.result())
            if len(pending) >= batch_size:
                _submit(client, run_id, pending)
                pending = []
    if pending:
        _submit(client, run_id, pending)
    return _finish(client, run_id, baseline)


async def evaluate_async(
    dataset: str,
    suite: str,
    task: Callable[[Dict[str, Any]], Union[Any, Awaitable[Any]]],
    *,
    name: Optional[str] = None,
    project: Optional[str] = None,
    concurrency: int = 4,
    limit: Optional[int] = None,
    tags: Optional[List[str]] = None,
    baseline: Optional[str] = None,
    url: Optional[str] = None,
    token: Optional[str] = None,
    git: Optional[Dict[str, Any]] = None,
    batch_size: int = 50,
    timeout: float = 60.0,
) -> EvalResult:
    """``evaluate`` for async code (pytest-asyncio, notebooks). Requests to Kalibra run in a thread."""
    client = _Client(url, token, project, timeout)
    started = await asyncio.to_thread(_start, client, dataset, suite, name, limit, tags, git)
    run_id: str = started["runId"]
    rows: List[Dict[str, Any]] = started.get("rows") or []
    gate = asyncio.Semaphore(max(1, concurrency))

    async def one(row: Dict[str, Any]) -> Dict[str, Any]:
        async with gate:
            inc = _core.Incoming(run_id=run_id)
            with _core._IncomingScope(inc):
                t0 = time.perf_counter()
                try:
                    value = task(row.get("data") or {})
                    if asyncio.iscoroutine(value) or isinstance(value, asyncio.Future):
                        value = await value
                    error = None
                except Exception as e:
                    value, error = None, e
                return _result(row["id"], inc, value, error, (time.perf_counter() - t0) * 1000)

    pending: List[Dict[str, Any]] = []
    for coro in asyncio.as_completed([one(r) for r in rows]):
        pending.append(await coro)
        if len(pending) >= batch_size:
            batch, pending = pending, []
            await asyncio.to_thread(_submit, client, run_id, batch)
    if pending:
        await asyncio.to_thread(_submit, client, run_id, pending)
    return await asyncio.to_thread(_finish, client, run_id, baseline)
