"""The background sender: a bounded queue and one daemon thread that posts batches to Kalibra.

Nothing in the caller's path touches the network. Finished traces are put on the queue (a few
dict appends under a lock); the thread wakes every ``flush_interval`` seconds, or as soon as 200
spans are waiting, redacts and serializes them, and POSTs them in batches. A failed batch is
retried twice with backoff, then dropped: an SDK must never grow without bound or slow the app
because Kalibra is down.

The thread starts on the first trace, so a disabled SDK never starts one, and restarts itself in a
forked child (gunicorn, multiprocessing) because threads don't survive ``fork``.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from typing import Any, Callable, Deque, Dict, List, Optional, Tuple

from . import _serialize

log = logging.getLogger("kalibra")

MAX_QUEUED_SPANS = 10_000
FLUSH_AT_SPANS = 200
MAX_BATCH_TRACES = 1000
MAX_BATCH_SPANS = 5000
MAX_BATCH_BYTES = 1_800_000  # the server accepts up to 2 MB per request
RETRY_DELAYS = (0.5, 1.0)

# Kalibra serves everything under this path (same as BASE_PATH in the server), so a load balancer can
# route on it. The configured URL is the server's origin; one that already ends in /kalibra works too.
BASE_PATH = "/kalibra"


def origin_of(url: str) -> str:
    """``http://host:4317/kalibra/`` → ``http://host:4317``."""
    trimmed = url.strip().rstrip("/")
    return trimmed[: -len(BASE_PATH)] if trimmed.endswith(BASE_PATH) else trimmed


def api_url(origin: str, path: str) -> str:
    """A Kalibra API address: ``api_url(origin, "/projects/p/ingest/traces")``."""
    return f"{origin}{BASE_PATH}/api{path}"

_warned: set = set()


def warn_once(key: str, message: str) -> None:
    """The SDK's only way to complain: one warning per kind of problem, then silence."""
    if key in _warned:
        log.debug(message)
        return
    _warned.add(key)
    log.warning("kalibra: %s", message)


class HttpError(Exception):
    def __init__(self, status: int, body: str) -> None:
        super().__init__(f"HTTP {status}: {body[:200]}")
        self.status = status
        self.body = body


def request_json(method: str, url: str, key: Optional[str], body: Any = None, timeout: float = 5.0, extra_headers: Optional[Dict[str, str]] = None) -> Any:
    """One HTTP request with a JSON body and answer. Raises on network errors and non-2xx."""
    data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode("utf-8"))
    headers = {"accept": "application/json", "user-agent": "kalibra-sdk-python", **(extra_headers or {})}
    if data is not None:
        headers["content-type"] = "application/json"
    if key:
        headers["authorization"] = f"Bearer {key}"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:  # noqa: S310 - the URL is configured by the app
            raw = res.read()
    except urllib.error.HTTPError as e:
        try:
            text = e.read().decode("utf-8", "replace")
        except Exception:
            text = ""
        raise HttpError(e.code, text) from None
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None


class Transport:
    def __init__(
        self,
        base_url: str,
        project: str,
        key: str,
        redact: Optional[Callable[[str], Any]],
        flush_interval: float = 1.0,
        timeout: float = 5.0,
        max_queued_spans: int = MAX_QUEUED_SPANS,
    ) -> None:
        self.base_url = origin_of(base_url)
        self.project = project
        self.key = key
        self.redact = redact
        self.flush_interval = flush_interval
        self.timeout = timeout
        self.max_queued_spans = max_queued_spans
        self._cond = threading.Condition()
        self._queue: Deque[Tuple[Dict[str, Any], int]] = deque()  # (trace dict, span count)
        self._queued_spans = 0
        self._tools: Deque[Dict[str, Any]] = deque(maxlen=1000)  # recordings to POST
        self._sending = 0
        self._stop = False
        self._wake = False
        self._thread: Optional[threading.Thread] = None
        self._pid = os.getpid()
        self.dropped = 0
        self.sent = 0

    # ── called from the app ──────────────────────────────────────────────

    @property
    def traces_url(self) -> str:
        return api_url(self.base_url, f"/projects/{_quote(self.project)}/ingest/traces")

    @property
    def tools_url(self) -> str:
        return api_url(self.base_url, f"/projects/{_quote(self.project)}/ingest/tools")

    def enqueue(self, trace: Dict[str, Any], spans: int) -> None:
        cost = spans + 1
        with self._cond:
            self._ensure_thread()
            self._queue.append((trace, cost))
            self._queued_spans += cost
            # Full: drop the oldest, never block the app.
            while self._queued_spans > self.max_queued_spans and len(self._queue) > 1:
                _, c = self._queue.popleft()
                self._queued_spans -= c
                self.dropped += 1
            # A trace from a Kalibra eval row is sent at once: the run waits only briefly for it.
            if self._queued_spans >= FLUSH_AT_SPANS or trace.get("resultId"):
                self._wake = True
                self._cond.notify_all()

    def enqueue_tool(self, recording: Dict[str, Any]) -> None:
        with self._cond:
            self._ensure_thread()
            self._tools.append(recording)
            self._wake = True
            self._cond.notify_all()

    def flush(self, timeout: float = 5.0) -> bool:
        """Sends everything queued so far. True when the queue emptied within ``timeout``."""
        deadline = time.monotonic() + timeout
        with self._cond:
            if not self._queue and not self._tools and not self._sending:
                return True
            self._ensure_thread()
            self._wake = True
            self._cond.notify_all()
            while self._queue or self._tools or self._sending:
                left = deadline - time.monotonic()
                if left <= 0:
                    return False
                self._cond.wait(left)
            return True

    def shutdown(self, timeout: float = 5.0) -> None:
        self.flush(timeout)
        with self._cond:
            self._stop = True
            self._cond.notify_all()
        t = self._thread
        if t is not None and t is not threading.current_thread():
            t.join(timeout=1.0)

    @property
    def started(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    # ── the background thread ────────────────────────────────────────────

    def _ensure_thread(self) -> None:
        # Called with the lock held.
        if self._pid != os.getpid():  # forked child: the parent's thread did not come along
            self._pid = os.getpid()
            self._thread = None
            self._sending = 0
        if self._thread is None or not self._thread.is_alive():
            if self._stop:
                return
            self._thread = threading.Thread(target=self._run, name="kalibra-flush", daemon=True)
            self._thread.start()

    def _run(self) -> None:
        while True:
            with self._cond:
                if not self._wake and not self._stop:
                    self._cond.wait(self.flush_interval)
                self._wake = False
                stop = self._stop
                traces = self._take_batch()
                tools = list(self._tools)
                self._tools.clear()
                self._sending += 1
            try:
                if tools:
                    self._send_tools(tools)
                while traces:
                    self._send_traces(traces)
                    with self._cond:
                        traces = self._take_batch()
            except Exception as e:  # never let the thread die
                warn_once("thread", f"could not send traces ({e})")
            finally:
                with self._cond:
                    self._sending -= 1
                    self._cond.notify_all()
            if stop:
                return

    def _take_batch(self) -> List[Dict[str, Any]]:
        # Called with the lock held. Batches stay under the server's limits.
        batch: List[Dict[str, Any]] = []
        spans = 0
        while self._queue and len(batch) < MAX_BATCH_TRACES:
            trace, cost = self._queue[0]
            if batch and spans + cost > MAX_BATCH_SPANS:
                break
            self._queue.popleft()
            self._queued_spans -= cost
            batch.append(trace)
            spans += cost
        return batch

    def _prepare(self, trace: Dict[str, Any]) -> str:
        if self.redact is not None:
            trace = _serialize.redact(trace, self.redact)
        text = json.dumps(trace, ensure_ascii=False, separators=(",", ":"))
        if len(text.encode("utf-8")) <= MAX_BATCH_BYTES:
            return text
        # One huge trace: keep its shape, shrink the payloads until it fits.
        for budget in (4096, 512):
            small = dict(trace)
            for k in ("input", "output", "metadata"):
                if k in small:
                    small[k] = _serialize.normalize(small[k], budget)
            small["spans"] = [
                {**s, **{k: _serialize.normalize(s[k], budget) for k in ("input", "output", "attributes") if k in s}} for s in trace.get("spans", [])
            ]
            text = json.dumps(small, ensure_ascii=False, separators=(",", ":"))
            if len(text.encode("utf-8")) <= MAX_BATCH_BYTES:
                return text
        return json.dumps({**{k: trace[k] for k in ("id", "name", "startedAt") if k in trace}, "error": "trace too large to send", "status": trace.get("status", "ok")})

    def _send_traces(self, traces: List[Dict[str, Any]]) -> None:
        chunks: List[str] = []
        size = 0
        for t in traces:
            text = self._prepare(t)
            n = len(text.encode("utf-8")) + 1
            if chunks and size + n > MAX_BATCH_BYTES:
                self._post_chunks(chunks, len(chunks))
                chunks, size = [], 0
            chunks.append(text)
            size += n
        if chunks:
            self._post_chunks(chunks, len(chunks))

    def _post_chunks(self, chunks: List[str], count: int) -> None:
        body = ('{"traces":[' + ",".join(chunks) + "]}").encode("utf-8")
        if self._post(self.traces_url, body):
            self.sent += count
        else:
            self.dropped += count

    def _send_tools(self, tools: List[Dict[str, Any]]) -> None:
        # Not redacted: a recording is found by a hash of its exact arguments, and replay returns
        # its exact result. Redaction is for traces.
        for rec in tools:
            self._post(self.tools_url, json.dumps(rec, ensure_ascii=False).encode("utf-8"))

    def _post(self, url: str, body: bytes) -> bool:
        for attempt in range(len(RETRY_DELAYS) + 1):
            try:
                request_json("POST", url, self.key, body, timeout=self.timeout)
                return True
            except HttpError as e:
                if 400 <= e.status < 500 and e.status not in (408, 429):
                    hint = " Check KALIBRA_KEY and KALIBRA_PROJECT." if e.status in (401, 403, 404) else ""
                    warn_once(f"http{e.status}", f"Kalibra refused the traces ({e}).{hint}")
                    return False
                err: Exception = e
            except Exception as e:  # network errors, timeouts
                err = e
            if attempt < len(RETRY_DELAYS):
                time.sleep(RETRY_DELAYS[attempt])
        warn_once("send", f"could not reach Kalibra at {self.base_url} ({err}); traces were dropped")
        return False


def _quote(segment: str) -> str:
    from urllib.parse import quote

    return quote(segment, safe="")
