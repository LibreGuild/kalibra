"""Kalibra SDK for Python: send what happens inside your AI app to Kalibra.

::

    import kalibra

    kalibra.init(enabled=os.getenv("ENV") != "production")   # off in production

    @kalibra.trace("answer_question")
    def answer(question):
        with kalibra.step("retrieve", kind="retrieval") as s:
            docs = search(question)
            s.output = docs
        return llm(question, docs)

Everything is optional and never in the way: when the SDK is off, decorators return your function
unchanged; when it is on, nothing in your call path waits on the network.

Modules:
    _core        traces, steps, context, init/flush/shutdown
    _tools       tool record / replay / fault injection
    _transport   the background queue and sender
    _serialize   JSON-safe copies with size limits, redaction, canonical JSON
    middleware   ASGI / WSGI / Django middlewares (link requests to Kalibra eval rows)
    eval         ``evaluate()``: run a Kalibra dataset through a function from your tests
"""

from __future__ import annotations

import atexit

from ._core import (
    Incoming,
    Span,
    Trace,
    __version__,
    current_trace,
    flush,
    from_headers,
    init,
    is_enabled,
    parse_traceparent,
    shutdown,
    step,
    trace,
)
from ._serialize import canonical_json, redact_text
from ._tools import ReplayMissing, args_hash, current_mode as tool_mode, tool
from .middleware import KalibraASGIMiddleware, KalibraDjangoMiddleware, KalibraWSGIMiddleware

__all__ = [
    "__version__",
    "init",
    "is_enabled",
    "trace",
    "step",
    "tool",
    "current_trace",
    "from_headers",
    "flush",
    "shutdown",
    "Trace",
    "Span",
    "Incoming",
    "ReplayMissing",
    "KalibraASGIMiddleware",
    "KalibraWSGIMiddleware",
    "KalibraDjangoMiddleware",
    "args_hash",
    "canonical_json",
    "redact_text",
    "parse_traceparent",
    "tool_mode",
]


@atexit.register
def _flush_at_exit() -> None:
    # Short: an app that is exiting should not hang on an unreachable Kalibra.
    flush(timeout=2.0)
