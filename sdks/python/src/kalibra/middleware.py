"""Middlewares that link each request to the Kalibra eval row that sent it.

They only read four headers (``traceparent``, ``x-kalibra-run``, ``x-kalibra-result``,
``x-kalibra-tools``) and set a context variable for the duration of the request; traces recorded
inside are then tied to that row, and tools follow the run's record/replay mode. When the SDK is
off they call the app directly.

* ASGI (FastAPI, Starlette, Litestar, Quart): ``app.add_middleware(KalibraASGIMiddleware)`` or
  ``app = KalibraASGIMiddleware(app)``
* WSGI (Flask, Bottle, Falcon): ``app.wsgi_app = KalibraWSGIMiddleware(app.wsgi_app)``
* Django: add ``"kalibra.middleware.KalibraDjangoMiddleware"`` to ``MIDDLEWARE``
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable, Dict, Iterable

from . import _core

_HEADERS = ("traceparent", "x-kalibra-run", "x-kalibra-result", "x-kalibra-tools")
_ENVIRON = {"HTTP_" + h.upper().replace("-", "_"): h for h in _HEADERS}


def _active() -> bool:
    if not _core._state.active:
        _core._auto_init()
    return _core._state.active


class KalibraASGIMiddleware:
    def __init__(self, app: Callable[..., Awaitable[Any]]) -> None:
        self.app = app

    async def __call__(self, scope: Dict[str, Any], receive: Any, send: Any) -> Any:
        if scope.get("type") not in ("http", "websocket") or not _active():
            return await self.app(scope, receive, send)
        headers: Dict[str, str] = {}
        for k, v in scope.get("headers") or ():
            name = k.decode("latin-1").lower() if isinstance(k, bytes) else str(k).lower()
            if name in _HEADERS:
                headers[name] = v.decode("latin-1") if isinstance(v, bytes) else str(v)
        if not headers:
            return await self.app(scope, receive, send)
        with _core.from_headers(headers):
            return await self.app(scope, receive, send)


class KalibraWSGIMiddleware:
    def __init__(self, app: Callable[..., Iterable[bytes]]) -> None:
        self.app = app

    def __call__(self, environ: Dict[str, Any], start_response: Callable[..., Any]) -> Iterable[bytes]:
        if not _active():
            return self.app(environ, start_response)
        headers = {h: environ[k] for k, h in _ENVIRON.items() if k in environ}
        if not headers:
            return self.app(environ, start_response)
        with _core.from_headers(headers):
            # Most frameworks build the whole response here; streaming bodies keep the link
            # only for work done before the first chunk.
            return self.app(environ, start_response)


class KalibraDjangoMiddleware:
    """``MIDDLEWARE = ["kalibra.middleware.KalibraDjangoMiddleware", ...]``. Supports sync and async views."""

    async_capable = True
    sync_capable = True

    def __init__(self, get_response: Callable[[Any], Any]) -> None:
        self.get_response = get_response
        import asyncio

        self._async = asyncio.iscoroutinefunction(get_response)
        if self._async:
            try:  # Django ≥ 4.1 marks async middlewares this way
                from asgiref.sync import markcoroutinefunction  # type: ignore

                markcoroutinefunction(self)
            except Exception:
                pass

    def __call__(self, request: Any) -> Any:
        if self._async:
            return self._acall(request)
        if not _active():
            return self.get_response(request)
        with _core.from_headers(getattr(request, "headers", {})):
            return self.get_response(request)

    async def _acall(self, request: Any) -> Any:
        if not _active():
            return await self.get_response(request)
        with _core.from_headers(getattr(request, "headers", {})):
            return await self.get_response(request)
