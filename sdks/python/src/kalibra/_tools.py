"""Tools your agent calls, recorded once and replayed in evals (docs/design/sdk-and-traces.md §6).

The mode comes from, in order: the ``x-kalibra-tools`` header of the request being handled (see
``from_headers`` / the middlewares), ``KALIBRA_TOOLS``, else ``live``.

* ``live``             call the real function
* ``record``           call it, and send the arguments and result to Kalibra (in the background)
* ``replay``           answer with the recording for the same arguments; call for real when missing
* ``replay-strict``    answer with the recording; raise ``ReplayMissing`` when there is none
* ``fault:timeout``    raise ``TimeoutError`` without calling (also ``fault:error``, ``fault:empty``)

Recordings are keyed by the tool name and a hash of the arguments: SHA-256 of their canonical JSON
(see ``tool_args`` and ``_serialize.canonical_json``), byte-for-byte the JS SDK's form, so a
recording made from a Node service replays in a Python one and back.
"""

from __future__ import annotations

import asyncio
import functools
import hashlib
import inspect
import os
import threading
from typing import Any, Callable, Dict, Optional, Tuple, TypeVar
from urllib.parse import quote

from . import _core, _serialize
from ._transport import api_url, request_json, warn_once

F = TypeVar("F", bound=Callable[..., Any])

MODES = ("live", "record", "replay", "replay-strict", "fault:timeout", "fault:error", "fault:empty")


class ReplayMissing(LookupError):
    """``replay-strict`` and no recording exists for these arguments."""


_cache: Dict[Tuple[str, str], Tuple[bool, Any, Optional[str]]] = {}
_cache_lock = threading.Lock()


def tool_args(args: tuple, kwargs: dict) -> Any:
    """The arguments as one JSON value, shaped like the JS SDK's: a single argument is the value
    itself, keyword arguments alone are one object, anything else is a list (positional arguments,
    then keyword arguments as a trailing object). So ``search({"q": "x"})``, ``search(q="x")`` and
    JS ``search({ q: "x" })`` all record ``{"q":"x"}``."""
    if not kwargs:
        return args[0] if len(args) == 1 else list(args)
    if not args:
        return dict(kwargs)
    return [*args, dict(kwargs)]


def args_hash(args: Any) -> str:
    return hashlib.sha256(_serialize.canonical_json(args).encode("utf-8")).hexdigest()


def current_mode() -> str:
    inc = _core.incoming()
    mode = (inc.tools if inc is not None and inc.tools else None) or os.environ.get("KALIBRA_TOOLS") or "live"
    mode = mode.strip().lower()
    if mode not in MODES:
        warn_once(f"mode:{mode}", f"unknown tool mode {mode!r}; using live")
        return "live"
    return mode


def _lookup(name: str, digest: str) -> Tuple[bool, Any, Optional[str]]:
    key = (name, digest)
    with _cache_lock:
        if key in _cache:
            return _cache[key]
    st = _core._state
    url = api_url(st.url, f"/projects/{quote(st.project, safe='')}/ingest/tools?tool={quote(name, safe='')}&argsHash={digest}")
    try:
        data = request_json("GET", url, st.key, timeout=st.timeout) or {}
    except Exception as e:
        warn_once("replay", f"could not read tool recordings ({e}); calling tools for real")
        return False, None, None
    body = data.get("data", data) if isinstance(data, dict) else {}
    found = (bool(body.get("found")), body.get("output"), body.get("error"))
    if found[0]:
        with _cache_lock:
            _cache[key] = found
    return found


def _record(name: str, args: Any, digest: str, output: Any, error: Optional[str]) -> None:
    t = _core._state.transport
    if t is None:
        return
    # Exact values, never the shortened copies traces keep: Kalibra stores the recording under its
    # own hash of ``args``, and replay must return the real result.
    rec: Dict[str, Any] = {"tool": name, "args": _serialize.normalize(args, None), "argsHash": digest}
    if error is not None:
        rec["error"] = error
    else:
        rec["output"] = _serialize.normalize(output, None)
    t.enqueue_tool(rec)


def _fault(name: str, mode: str) -> Tuple[bool, Any]:
    if mode == "fault:timeout":
        raise TimeoutError(f"[kalibra fault] {name} timed out")
    if mode == "fault:error":
        raise RuntimeError(f"[kalibra fault] {name} failed")
    return True, None  # fault:empty


def tool(name: Optional[str] = None) -> Callable[[F], F]:
    """Wraps a function your agent calls as a tool::

        search_orders = kalibra.tool("search_orders")(real_search_orders)

        @kalibra.tool("refund_order")
        def refund_order(order_id: str): ...

    Inside a trace each call is recorded as a ``tool`` step. When the SDK is off, the function is
    returned unchanged.
    """

    def decorate(fn: F) -> F:
        if _core._disabled():
            return fn
        tool_name = name or getattr(fn, "__name__", "tool")

        def plan(args: tuple, kwargs: dict) -> Tuple[str, Any, str]:
            mode = current_mode()
            values = tool_args(args, kwargs)
            digest = args_hash(values) if mode != "live" else ""
            return mode, values, digest

        def begin(values: Any) -> Tuple[Any, Any]:
            inst = _core._Recorder(tool_name, "tool")
            span = inst.start(False)
            span.input = values
            return inst, span

        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                if not _core._state.active:
                    _core._auto_init()
                    if not _core._state.active:
                        return await fn(*args, **kwargs)
                mode, values, digest = plan(args, kwargs)
                rec, span = begin(values)
                try:
                    if mode.startswith("fault:"):
                        span.set(**{"kalibra.tools": mode})
                        _, out = _fault(tool_name, mode)
                    elif mode.startswith("replay"):
                        found, out, err = await asyncio.get_running_loop().run_in_executor(None, _lookup, tool_name, digest)
                        if found:
                            span.set(**{"kalibra.tools": "replayed"})
                            if err:
                                raise RuntimeError(err)
                        elif mode == "replay-strict":
                            raise ReplayMissing(f"no recording of {tool_name} for these arguments")
                        else:
                            out = await fn(*args, **kwargs)
                    else:
                        try:
                            out = await fn(*args, **kwargs)
                        except BaseException as e:
                            if mode == "record":
                                _record(tool_name, values, digest, None, _core._error_text(e))
                            raise
                        if mode == "record":
                            _record(tool_name, values, digest, out, None)
                except BaseException as e:
                    rec.stop(e)
                    raise
                span.output = out
                rec.stop()
                return out

            return async_wrapper  # type: ignore[return-value]

        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            if not _core._state.active:
                _core._auto_init()
                if not _core._state.active:
                    return fn(*args, **kwargs)
            mode, values, digest = plan(args, kwargs)
            rec, span = begin(values)
            try:
                if mode.startswith("fault:"):
                    span.set(**{"kalibra.tools": mode})
                    _, out = _fault(tool_name, mode)
                elif mode.startswith("replay"):
                    found, out, err = _lookup(tool_name, digest)
                    if found:
                        span.set(**{"kalibra.tools": "replayed"})
                        if err:
                            raise RuntimeError(err)
                    elif mode == "replay-strict":
                        raise ReplayMissing(f"no recording of {tool_name} for these arguments")
                    else:
                        out = fn(*args, **kwargs)
                else:
                    try:
                        out = fn(*args, **kwargs)
                    except BaseException as e:
                        if mode == "record":
                            _record(tool_name, values, digest, None, _core._error_text(e))
                        raise
                    if mode == "record":
                        _record(tool_name, values, digest, out, None)
            except BaseException as e:
                rec.stop(e)
                raise
            span.output = out
            rec.stop()
            return out

        return wrapper  # type: ignore[return-value]

    if callable(name):  # bare @kalibra.tool
        fn, name = name, None
        return decorate(fn)  # type: ignore[return-value]
    return decorate
