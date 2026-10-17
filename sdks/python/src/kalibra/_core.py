"""Traces and steps: the part of the SDK that runs inside the app's own calls.

Kept deliberately cheap:

* disabled → ``trace``/``step`` decorators return the original function and the context managers
  are shared no-op objects (no allocation, no threads, no network);
* sampling is decided once, when a trace starts;
* a finished trace is normalized (bounded, 32 KB per field) and handed to the background
  transport; redaction, serialization and sending happen on that thread.

Nesting uses ``contextvars``, so it follows threads started with ``contextvars.copy_context`` and
asyncio tasks. A ``trace`` inside another trace becomes a child span.
"""

from __future__ import annotations

import contextvars
import datetime as _dt
import functools
import inspect
import os
import random
import threading
import time
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Tuple, TypeVar, Union

from . import _serialize
from ._transport import Transport, warn_once

F = TypeVar("F", bound=Callable[..., Any])

__version__ = "0.1.1b1"

SPAN_KINDS = ("llm", "tool", "retrieval", "agent", "step")
MAX_SPANS = 256
DEFAULT_URL = "http://127.0.0.1:4317"
_OFF = ("false", "0", "no", "off")
_ON = ("true", "1", "yes", "on")


# ── Configuration ────────────────────────────────────────────────────────────


class _State:
    """Module-wide SDK state. ``active`` is the one flag the hot path reads."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.initialized = False
        self.active = False
        self.url = DEFAULT_URL
        self.key: Optional[str] = None
        self.project = "default"
        self.sample_rate = 1.0
        self.environment: Optional[str] = None
        self.release: Optional[str] = None
        self.redact: Optional[Callable[[str], Any]] = _serialize.redact_text
        self.transport: Optional[Transport] = None
        self.flush_interval = 1.0
        self.timeout = 5.0


_state = _State()


def killed() -> bool:
    """``KALIBRA_ENABLED=false`` (or 0/no/off) switches the SDK off, whatever the code says."""
    return os.environ.get("KALIBRA_ENABLED", "").strip().lower() in _OFF


def init(
    enabled: Optional[bool] = None,
    url: Optional[str] = None,
    key: Optional[str] = None,
    project: Optional[str] = None,
    sample_rate: Optional[float] = None,
    redact: Union[bool, Callable[[str], Any]] = True,
    environment: Optional[str] = None,
    release: Optional[str] = None,
    flush_interval: float = 1.0,
    timeout: float = 5.0,
) -> bool:
    """Configures the SDK. Returns whether it is now sending.

    Everything falls back to the environment: ``KALIBRA_URL``, ``KALIBRA_KEY`` (an ingest key,
    ``kik_…``), ``KALIBRA_PROJECT``, ``KALIBRA_SAMPLE_RATE``. The SDK stays off when ``enabled`` is
    False, when ``KALIBRA_ENABLED=false`` (a kill switch that always wins), or without a key.

    Typical dev-only setup::

        kalibra.init(enabled=os.getenv("ENV") != "production")
    """
    with _state.lock:
        old = _state.transport
        _state.initialized = True
        _state.url = (url or os.environ.get("KALIBRA_URL") or DEFAULT_URL).rstrip("/")
        _state.key = key or os.environ.get("KALIBRA_KEY") or None
        _state.project = project or os.environ.get("KALIBRA_PROJECT") or "default"
        rate = sample_rate if sample_rate is not None else _float(os.environ.get("KALIBRA_SAMPLE_RATE"), 1.0)
        _state.sample_rate = min(max(rate, 0.0), 1.0)
        _state.environment = environment or os.environ.get("KALIBRA_ENVIRONMENT") or None
        _state.release = release or os.environ.get("KALIBRA_RELEASE") or None
        _state.redact = (_serialize.redact_text if redact is True else redact) if redact else None
        _state.flush_interval = flush_interval
        _state.timeout = timeout
        # Like the JS SDK: without enabled=..., KALIBRA_ENABLED decides, and an unknown value means off.
        flag = os.environ.get("KALIBRA_ENABLED", "").strip().lower()
        wanted = enabled if enabled is not None else (flag in _ON if flag else True)
        on = wanted and not killed() and bool(_state.key)
        if enabled is True and not _state.key and not killed():
            warn_once("nokey", "init(enabled=True) but no key: set KALIBRA_KEY to an ingest key (kik_…) from Kalibra → Connect your app")
        _state.transport = (
            Transport(_state.url, _state.project, _state.key or "", _state.redact, flush_interval=flush_interval, timeout=timeout) if on else None
        )
        _state.active = on
    if old is not None:
        old.shutdown(timeout=2.0)
    return on


def _float(v: Optional[str], default: float) -> float:
    try:
        return float(v) if v else default
    except ValueError:
        return default


def _auto_init() -> None:
    """First use without ``init()``: configure from the environment alone."""
    if not _state.initialized:
        init()


def is_enabled() -> bool:
    _auto_init()
    return _state.active


def flush(timeout: float = 5.0) -> bool:
    """Sends what is queued (e.g. before a serverless function returns). Never raises."""
    t = _state.transport
    if t is None:
        return True
    try:
        return t.flush(timeout)
    except Exception as e:  # pragma: no cover
        warn_once("flush", f"flush failed ({e})")
        return False


def shutdown(timeout: float = 5.0) -> None:
    """Flushes and stops the background thread. Called automatically at exit."""
    with _state.lock:
        t = _state.transport
        _state.transport = None
        _state.active = False
    if t is not None:
        try:
            t.shutdown(timeout)
        except Exception:  # pragma: no cover
            pass


# ── Ids and time ─────────────────────────────────────────────────────────────


def _trace_id() -> str:
    return os.urandom(16).hex()


def _span_id() -> str:
    return os.urandom(8).hex()


def _now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# ── Context: incoming request headers and the current trace ──────────────────


class Incoming:
    """What a request from a Kalibra eval run carries (see ``from_headers``)."""

    __slots__ = ("trace_id", "parent_id", "run_id", "result_id", "tools", "used")

    def __init__(self, trace_id: Optional[str] = None, parent_id: Optional[str] = None, run_id: Optional[str] = None, result_id: Optional[str] = None, tools: Optional[str] = None) -> None:
        self.trace_id = trace_id
        self.parent_id = parent_id
        self.run_id = run_id
        self.result_id = result_id
        self.tools = tools
        self.used = False  # set once a trace was recorded under this context


_incoming: contextvars.ContextVar[Optional[Incoming]] = contextvars.ContextVar("kalibra_incoming", default=None)
# (trace, parent span id) of the innermost open trace/step; _UNSAMPLED for traces skipped by sampling.
_current: contextvars.ContextVar[Optional[Tuple[Any, Optional[str]]]] = contextvars.ContextVar("kalibra_current", default=None)
_UNSAMPLED: Tuple[Any, Optional[str]] = (None, None)


def _header(headers: Any, name: str) -> Optional[str]:
    if headers is None:
        return None
    try:
        v = headers.get(name)
        if v is None:
            v = headers.get(name.title())
        if v is None and isinstance(headers, Mapping):
            low = name.lower()
            for k, x in headers.items():
                if isinstance(k, str) and k.lower() == low:
                    v = x
                    break
    except Exception:
        try:
            v = next((x for k, x in headers if str(k).lower() == name.lower()), None)
        except Exception:
            return None
    if isinstance(v, bytes):
        v = v.decode("latin-1")
    if isinstance(v, (list, tuple)):
        v = v[0] if v else None
    return v.strip() if isinstance(v, str) and v.strip() else None


def parse_traceparent(value: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
    """W3C ``traceparent`` → (trace id, parent span id), or (None, None) when malformed."""
    if not value:
        return None, None
    parts = value.strip().split("-")
    if len(parts) < 4 or len(parts[1]) != 32 or len(parts[2]) != 16:
        return None, None
    tid, pid = parts[1].lower(), parts[2].lower()
    try:
        int(tid, 16), int(pid, 16)
    except ValueError:
        return None, None
    if tid == "0" * 32 or pid == "0" * 16:
        return None, None
    return tid, pid


def incoming_from_headers(headers: Any) -> Incoming:
    run_id, result_id, tools = _header(headers, "x-kalibra-run"), _header(headers, "x-kalibra-result"), _header(headers, "x-kalibra-tools")
    # A traceparent alone is ordinary distributed tracing, not a Kalibra run: keep our own ids then
    # (another service's trace id would make two services' traces overwrite each other).
    tid, pid = parse_traceparent(_header(headers, "traceparent")) if run_id or result_id or tools else (None, None)
    return Incoming(trace_id=tid, parent_id=pid, run_id=run_id, result_id=result_id, tools=tools)


class _IncomingScope:
    __slots__ = ("incoming", "_token")

    def __init__(self, incoming: Incoming) -> None:
        self.incoming = incoming
        self._token: Optional[contextvars.Token] = None

    def __enter__(self) -> Incoming:
        self._token = _incoming.set(self.incoming)
        return self.incoming

    def __exit__(self, *exc: Any) -> None:
        if self._token is not None:
            _incoming.reset(self._token)
            self._token = None

    async def __aenter__(self) -> Incoming:
        return self.__enter__()

    async def __aexit__(self, *exc: Any) -> None:
        self.__exit__(*exc)


def from_headers(headers: Any) -> _IncomingScope:
    """Links what happens inside this ``with`` block to the Kalibra eval row that sent the request.

    Reads ``traceparent``, ``x-kalibra-run``, ``x-kalibra-result`` and ``x-kalibra-tools`` from any
    header mapping (Flask, Django, FastAPI/Starlette, plain dicts, lists of pairs)::

        with kalibra.from_headers(request.headers):
            return answer(question)

    Traces linked to an eval row are always kept, whatever the sample rate.
    """
    return _IncomingScope(incoming_from_headers(headers))


def incoming() -> Optional[Incoming]:
    return _incoming.get()


# ── Trace and span objects ───────────────────────────────────────────────────


class Span:
    """One step inside a trace. Set ``input``, ``output``, ``error`` or ``attributes`` on it."""

    __slots__ = ("id", "parent_id", "name", "kind", "started_at", "_t0", "duration_ms", "input", "output", "error", "attributes")

    def __init__(self, name: str, kind: str, parent_id: Optional[str]) -> None:
        self.id = _span_id()
        self.parent_id = parent_id
        self.name = name
        self.kind = kind if kind in SPAN_KINDS else "step"
        self.started_at = _now_iso()
        self._t0 = time.perf_counter()
        self.duration_ms: Optional[float] = None
        self.input: Any = None
        self.output: Any = None
        self.error: Optional[str] = None
        self.attributes: Dict[str, Any] = {}

    def set(self, **attributes: Any) -> "Span":
        """Adds attributes, e.g. ``span.set(model="gpt-4o", tokens_in=120)``."""
        self.attributes.update(attributes)
        return self

    def _end(self) -> None:
        if self.duration_ms is None:
            self.duration_ms = round((time.perf_counter() - self._t0) * 1000, 3)

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {"id": self.id, "name": self.name, "kind": self.kind, "startedAt": self.started_at}
        if self.parent_id:
            d["parentId"] = self.parent_id
        if self.duration_ms is not None:
            d["durationMs"] = self.duration_ms
        if self.input is not None:
            d["input"] = _serialize.normalize(self.input)
        if self.output is not None:
            d["output"] = _serialize.normalize(self.output)
        if self.error is not None:
            d["error"] = _serialize.normalize(self.error)
        if self.attributes:
            d["attributes"] = _serialize.normalize(self.attributes)
        return d


class Trace:
    """One interaction with your app (a request, a job, a chat turn) and its steps."""

    def __init__(self, name: str, inc: Optional[Incoming]) -> None:
        # Only the first trace of a request takes Kalibra's trace id; later ones need their own, or
        # Kalibra would store them over the first.
        self.id = inc.trace_id if inc is not None and inc.trace_id and not inc.used else _trace_id()
        self.name = name
        self.started_at = _now_iso()
        self._t0 = time.perf_counter()
        self.duration_ms: Optional[float] = None
        self.input: Any = None
        self.output: Any = None
        self.error: Optional[str] = None
        self.metadata: Dict[str, Any] = {}
        self.tags: List[str] = []
        self.run_id = inc.run_id if inc is not None else None
        self.result_id = inc.result_id if inc is not None else None
        self.spans: List[Span] = []
        self.dropped_spans = 0

    def _add(self, span: Span) -> bool:
        if len(self.spans) >= MAX_SPANS:
            self.dropped_spans += 1
            return False
        self.spans.append(span)
        return True

    def to_dict(self) -> Dict[str, Any]:
        meta = dict(self.metadata)
        if _state.environment and "environment" not in meta:
            meta["environment"] = _state.environment
        if _state.release and "release" not in meta:
            meta["release"] = _state.release
        if self.dropped_spans:
            meta["kalibra.dropped_spans"] = self.dropped_spans
        d: Dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "startedAt": self.started_at,
            "status": "error" if self.error is not None else "ok",
        }
        if self.duration_ms is not None:
            d["durationMs"] = self.duration_ms
        if self.input is not None:
            d["input"] = _serialize.normalize(self.input)
        if self.output is not None:
            d["output"] = _serialize.normalize(self.output)
        if self.error is not None:
            d["error"] = _serialize.normalize(self.error)
        if meta:
            d["metadata"] = _serialize.normalize(meta)
        if self.tags:
            d["tags"] = [str(t) for t in self.tags][:100]
        if self.run_id:
            d["runId"] = self.run_id
        if self.result_id:
            d["resultId"] = self.result_id
        if self.spans:
            d["spans"] = [s.to_dict() for s in self.spans]
        return d


class _NoopTrace:
    """What ``current_trace()`` returns when nothing is being recorded: writes go nowhere."""

    __slots__ = ()
    id = None
    name = None
    run_id = None
    result_id = None
    input = None
    output = None
    error = None

    @property
    def metadata(self) -> Dict[str, Any]:
        return {}

    @property
    def tags(self) -> List[str]:
        return []

    def __setattr__(self, name: str, value: Any) -> None:
        pass


class _NoopSpan(_NoopTrace):
    __slots__ = ()
    kind = None

    @property
    def attributes(self) -> Dict[str, Any]:
        return {}

    def set(self, **attributes: Any) -> "_NoopSpan":
        return self


NOOP_TRACE = _NoopTrace()
NOOP_SPAN = _NoopSpan()


def current_trace() -> Union[Trace, _NoopTrace]:
    """The trace being recorded right now, to add ``metadata`` or ``tags``; a no-op stand-in otherwise."""
    cur = _current.get()
    return cur[0] if cur is not None and cur[0] is not None else NOOP_TRACE


def _finish_trace(trace: Trace) -> None:
    trace.duration_ms = round((time.perf_counter() - trace._t0) * 1000, 3)
    t = _state.transport
    if t is None:
        return
    try:
        t.enqueue(trace.to_dict(), len(trace.spans))
    except Exception as e:  # pragma: no cover - the app must never see SDK errors
        warn_once("enqueue", f"could not queue a trace ({e})")


def _error_text(e: BaseException) -> str:
    msg = str(e)
    return f"{type(e).__name__}: {msg}" if msg else type(e).__name__


# ── trace() and step(): decorators and context managers ──────────────────────


def _describe_args(sig: Optional[inspect.Signature], args: tuple, kwargs: dict) -> Any:
    """What a decorated function was called with: the value itself for one argument, else a dict."""
    if sig is not None:
        try:
            bound = sig.bind_partial(*args, **kwargs)
            items = {k: v for k, v in bound.arguments.items() if k not in ("self", "cls")}
            if len(items) == 1:
                return next(iter(items.values()))
            return items or None
        except Exception:
            pass
    if not kwargs and len(args) == 1:
        return args[0]
    return {"args": list(args), "kwargs": kwargs} if args or kwargs else None


def _signature(fn: Callable[..., Any]) -> Optional[inspect.Signature]:
    try:
        return inspect.signature(fn)
    except (TypeError, ValueError):
        return None


class _Recorder:
    """Shared start/stop logic of a trace or step (whichever is right in the current context)."""

    __slots__ = ("name", "kind", "_trace", "_span", "_token", "_value", "_owner")

    def __init__(self, name: str, kind: Optional[str]) -> None:
        self.name = name
        self.kind = kind
        self._trace: Optional[Trace] = None
        self._span: Optional[Span] = None
        self._token: Optional[contextvars.Token] = None
        self._value: Optional[Tuple[Any, Optional[str]]] = None  # what this recorder puts in _current
        self._owner = False  # True when this recorder started the trace (not a nested span)

    def _enter(self, value: Tuple[Any, Optional[str]]) -> None:
        self._value = value
        self._token = _current.set(value)

    def suspend(self) -> None:
        """Generators: take the trace out of the caller's context between yields."""
        if self._token is not None:
            try:
                _current.reset(self._token)
            except ValueError:
                pass
            self._token = None

    def resume(self) -> None:
        if self._value is not None and self._token is None:
            self._token = _current.set(self._value)

    def start(self, root_allowed: bool) -> Union[Trace, Span, _NoopTrace]:
        cur = _current.get()
        if cur is _UNSAMPLED:
            return NOOP_SPAN if self.kind else NOOP_TRACE
        if cur is not None:
            trace, parent = cur
            span = Span(self.name, self.kind or "step", parent)
            if not trace._add(span):
                return NOOP_SPAN
            self._trace, self._span = trace, span
            self._enter((trace, span.id))
            return span
        if not root_allowed:
            return NOOP_SPAN  # a step outside any trace records nothing
        inc = _incoming.get()
        linked = inc is not None and (inc.result_id or inc.run_id)
        if not linked and _state.sample_rate < 1.0 and random.random() >= _state.sample_rate:
            self._enter(_UNSAMPLED)
            return NOOP_TRACE
        trace = Trace(self.name, inc)
        if inc is not None:
            inc.used = True
            if inc.trace_id is None:
                inc.trace_id = trace.id
        self._trace, self._owner = trace, True
        self._enter((trace, None))
        return trace

    def stop(self, error: Optional[BaseException] = None) -> None:
        self.suspend()
        self._value = None
        target: Any = self._span if self._span is not None else (self._trace if self._owner else None)
        if target is not None and error is not None and target.error is None:
            target.error = _error_text(error)
        if self._span is not None:
            self._span._end()
        elif self._owner and self._trace is not None:
            _finish_trace(self._trace)

    @property
    def target(self) -> Any:
        return self._span if self._span is not None else self._trace


class _Instrument:
    """Returned by ``trace(...)`` and ``step(...)``: works as a decorator and as a (async) context manager."""

    __slots__ = ("name", "kind", "root", "capture", "_stack")

    def __init__(self, name: Optional[str], kind: Optional[str], root: bool, capture: bool) -> None:
        self.name = name
        self.kind = kind
        self.root = root
        self.capture = capture
        self._stack: List[_Recorder] = []

    # context manager

    def __enter__(self) -> Any:
        if not _state.active:
            _auto_init()
            if not _state.active:
                self._stack.append(None)  # type: ignore[arg-type]
                return NOOP_SPAN if not self.root else NOOP_TRACE
        rec = _Recorder(self.name or "trace", self.kind)
        self._stack.append(rec)
        return rec.start(self.root)

    def __exit__(self, exc_type: Any, exc: Optional[BaseException], tb: Any) -> None:
        rec = self._stack.pop() if self._stack else None
        if rec is not None:
            rec.stop(exc)

    async def __aenter__(self) -> Any:
        return self.__enter__()

    async def __aexit__(self, exc_type: Any, exc: Optional[BaseException], tb: Any) -> None:
        self.__exit__(exc_type, exc, tb)

    # decorator

    def __call__(self, fn: F) -> F:
        if _disabled():
            return fn  # disabled: the function itself, zero overhead
        name = self.name or getattr(fn, "__qualname__", None) or getattr(fn, "__name__", "trace")
        kind, root, capture = self.kind, self.root, self.capture
        sig = _signature(fn) if capture else None

        if inspect.isasyncgenfunction(fn):

            @functools.wraps(fn)
            async def agen_wrapper(*args: Any, **kwargs: Any) -> Any:
                if not _state.active:
                    _auto_init()
                    if not _state.active:
                        async for item in fn(*args, **kwargs):
                            yield item
                        return
                rec = _Recorder(name, kind)
                target = rec.start(root)
                if capture:
                    target.input = _describe_args(sig, args, kwargs)
                rec.suspend()
                collected = _Collected()
                agen = fn(*args, **kwargs)
                try:
                    while True:
                        rec.resume()
                        try:
                            item = await agen.__anext__()
                        except StopAsyncIteration:
                            break
                        finally:
                            rec.suspend()
                        collected.add(item)
                        yield item
                except GeneratorExit:  # the consumer stopped early: not an error
                    target.output = collected.summary()
                    rec.stop()
                    await agen.aclose()
                    raise
                except BaseException as e:
                    target.output = collected.summary()
                    rec.stop(e)
                    raise
                target.output = collected.summary()
                rec.stop()

            return agen_wrapper  # type: ignore[return-value]

        if inspect.isgeneratorfunction(fn):

            @functools.wraps(fn)
            def gen_wrapper(*args: Any, **kwargs: Any) -> Any:
                if not _state.active:
                    _auto_init()
                    if not _state.active:
                        return (yield from fn(*args, **kwargs))
                rec = _Recorder(name, kind)
                target = rec.start(root)
                if capture:
                    target.input = _describe_args(sig, args, kwargs)
                rec.suspend()
                collected = _Collected()
                gen = fn(*args, **kwargs)
                try:
                    while True:
                        rec.resume()
                        try:
                            item = next(gen)
                        except StopIteration as done:
                            result = done.value
                            break
                        finally:
                            rec.suspend()
                        collected.add(item)
                        yield item
                except GeneratorExit:  # the consumer stopped early: not an error
                    target.output = collected.summary()
                    rec.stop()
                    gen.close()
                    raise
                except BaseException as e:
                    target.output = collected.summary()
                    rec.stop(e)
                    raise
                target.output = collected.summary()
                rec.stop()
                return result

            return gen_wrapper  # type: ignore[return-value]

        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                if not _state.active:
                    _auto_init()
                    if not _state.active:
                        return await fn(*args, **kwargs)
                rec = _Recorder(name, kind)
                target = rec.start(root)
                if capture:
                    target.input = _describe_args(sig, args, kwargs)
                try:
                    result = await fn(*args, **kwargs)
                except BaseException as e:
                    rec.stop(e)
                    raise
                if capture:
                    target.output = result
                rec.stop()
                return result

            return async_wrapper  # type: ignore[return-value]

        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            if not _state.active:
                _auto_init()
                if not _state.active:
                    return fn(*args, **kwargs)
            rec = _Recorder(name, kind)
            target = rec.start(root)
            if capture:
                target.input = _describe_args(sig, args, kwargs)
            try:
                result = fn(*args, **kwargs)
            except BaseException as e:
                rec.stop(e)
                raise
            if capture:
                target.output = result
            rec.stop()
            return result

        return wrapper  # type: ignore[return-value]


class _NoopInstrument:
    """What ``trace()``/``step()`` return once the SDK is known to be off: one shared object that
    hands back the decorated function unchanged and does nothing as a context manager."""

    __slots__ = ()

    def __call__(self, fn: F) -> F:
        return fn

    def __enter__(self) -> Any:
        return NOOP_SPAN

    def __exit__(self, *exc: Any) -> None:
        return None

    async def __aenter__(self) -> Any:
        return NOOP_SPAN

    async def __aexit__(self, *exc: Any) -> None:
        return None


NOOP_INSTRUMENT = _NoopInstrument()


def _disabled() -> bool:
    """Known to be off: after init() decided so, or by the kill switch. Before init() the answer is
    "not yet known", so decorators applied at import time still follow a later init()."""
    return (_state.initialized and not _state.active) or killed()


class _Collected:
    """Summary of what a generator yielded: the joined text for text chunks (LLM streams), else a count and a preview."""

    __slots__ = ("count", "text", "preview")

    def __init__(self) -> None:
        self.count = 0
        self.text: Optional[List[str]] = []
        self.preview: List[Any] = []

    def add(self, item: Any) -> None:
        self.count += 1
        if self.text is not None:
            if isinstance(item, str):
                if sum(map(len, self.text)) < _serialize.FIELD_BUDGET:
                    self.text.append(item)
                return
            self.text = None
        if len(self.preview) < 5:
            self.preview.append(item)

    def summary(self) -> Any:
        if self.count == 0:
            return {"items": 0}
        if self.text is not None:
            return "".join(self.text)
        return {"items": self.count, "first": self.preview}


def trace(name: Union[str, Callable[..., Any], None] = None, *, capture: bool = True) -> Any:
    """Records one interaction with your app. Use as a decorator or a context manager::

        @kalibra.trace("answer_question")
        def answer(question): ...

        with kalibra.trace("nightly_job") as t:
            t.input = params
            ...
            t.output = summary

    Inside another trace it becomes a child step. ``capture=False`` skips recording the
    function's arguments and return value.
    """
    if callable(name):  # bare @kalibra.trace
        return _Instrument(None, None, True, capture)(name)
    if _disabled():
        return NOOP_INSTRUMENT
    return _Instrument(name, None, True, capture)


def step(name: Union[str, Callable[..., Any], None] = None, *, kind: str = "step", capture: bool = True) -> Any:
    """Records one step inside the current trace: ``kind`` is ``llm``, ``tool``, ``retrieval``,
    ``agent`` or ``step``. Outside a trace it records nothing::

        with kalibra.step("retrieve", kind="retrieval") as s:
            docs = search(question)
            s.output = docs
    """
    if callable(name):
        return _Instrument(None, kind, False, capture)(name)
    if _disabled():
        return NOOP_INSTRUMENT
    return _Instrument(name, kind, False, capture)


def _reset_for_tests() -> None:
    shutdown(timeout=1.0)
    with _state.lock:
        _state.initialized = False
        _state.active = False
        _state.key = None
        _state.transport = None
    from . import _tools

    _tools._cache.clear()
