"""Turning arbitrary Python values into small, JSON-safe data, and redacting it.

Two separate steps, so the expensive one stays off the request path:

* ``normalize`` runs when a trace or step ends (in the caller's thread). It walks the value with a
  character budget (32 KB per field), so its cost is bounded no matter how big the value is, and it
  copies the data, so later changes to the caller's objects don't leak into what is sent.
* ``redact`` runs on the background flush thread, over already-normalized data.

``canonical_json`` is the stable form used to hash tool arguments; it must match the JS SDK
(see README: "Tool arguments hash").
"""

from __future__ import annotations

import dataclasses
import datetime as _dt
import enum
import json
import math
import re
from collections import deque
from collections.abc import Mapping
from decimal import Decimal
from pathlib import PurePath
from typing import Any, Callable, Optional
from uuid import UUID

FIELD_BUDGET = 32 * 1024
MAX_DEPTH = 20
_TRUNC = "…"


class _Budget:
    __slots__ = ("left",)

    def __init__(self, left: Optional[int]) -> None:
        self.left = left  # None = unlimited (used for hashing)

    def take(self, n: int) -> None:
        if self.left is not None:
            self.left -= n

    @property
    def out(self) -> bool:
        return self.left is not None and self.left <= 0


def normalize(value: Any, budget: Optional[int] = FIELD_BUDGET) -> Any:
    """A JSON-safe copy of ``value`` that serializes to roughly ``budget`` characters at most.

    Strings past the budget are cut with a "…[truncated N chars]" note, containers stop with a
    "…" marker, cycles become "[circular]", and unknown objects fall back to their repr.
    Never raises.
    """
    try:
        return _norm(value, 0, set(), _Budget(budget), budget is None)
    except Exception as e:  # pragma: no cover - last resort, normalize must never break the app
        return f"[unserializable: {type(e).__name__}]"


def _norm(v: Any, depth: int, seen: set, b: _Budget, exact: bool) -> Any:
    if b.out:
        return _TRUNC
    if v is None or isinstance(v, bool):
        b.take(5)
        return v
    if isinstance(v, int):
        b.take(12)
        if abs(v) <= 2**53:
            return v
        if exact:  # hashing: the double JavaScript would hold, so hashes match across SDKs
            try:
                return float(v)
            except OverflowError:
                return str(v)
        return str(v)  # JSON readers lose precision past 2**53; keep the digits as text
    if isinstance(v, float):
        b.take(12)
        if not math.isfinite(v):
            return None if exact else str(v)
        return v
    if isinstance(v, str):
        return _str(v, b)
    if isinstance(v, (bytes, bytearray, memoryview)):
        s = f"<{len(v)} bytes>"
        b.take(len(s))
        return s
    if isinstance(v, enum.Enum):
        return _norm(v.value, depth, seen, b, exact)
    if isinstance(v, (_dt.datetime, _dt.date, _dt.time)):
        s = v.isoformat()
        b.take(len(s) + 2)
        return s
    if isinstance(v, (Decimal, UUID, PurePath)):
        return _str(str(v), b)
    if isinstance(v, BaseException):
        return _str(f"{type(v).__name__}: {v}", b)
    if depth >= MAX_DEPTH:
        return "[max depth]"

    # Containers: cycle detection on the current path only.
    oid = id(v)
    if oid in seen:
        return "[circular]"

    if isinstance(v, Mapping):
        seen.add(oid)
        try:
            out: dict = {}
            items = list(v.items())
            for i, (k, x) in enumerate(items):
                if b.out:
                    out[_TRUNC] = f"[{len(items) - i} more keys]"
                    break
                key = k if isinstance(k, str) else str(k)
                b.take(len(key) + 4)
                out[key] = _norm(x, depth + 1, seen, b, exact)
            return out
        finally:
            seen.discard(oid)

    if isinstance(v, (list, tuple, set, frozenset, deque)):
        if hasattr(v, "_asdict"):  # namedtuple
            return _norm(v._asdict(), depth, seen, b, exact)
        seen.add(oid)
        try:
            seq = sorted(v, key=repr) if isinstance(v, (set, frozenset)) else v
            arr: list = []
            n = len(v)
            for i, x in enumerate(seq):
                if b.out:
                    arr.append(f"{_TRUNC}[{n - i} more items]")
                    break
                b.take(2)
                arr.append(_norm(x, depth + 1, seen, b, exact))
            return arr
        finally:
            seen.discard(oid)

    if dataclasses.is_dataclass(v) and not isinstance(v, type):
        try:
            fields = {f.name: getattr(v, f.name) for f in dataclasses.fields(v)}
        except Exception:
            fields = None
        if fields is not None:
            seen.add(oid)
            try:
                return _norm(fields, depth, seen, b, exact)
            finally:
                seen.discard(oid)

    # Common libraries without importing them: pydantic v2 / v1, numpy, pandas-like.
    for attr in ("model_dump", "dict", "to_dict", "tolist", "item"):
        fn = getattr(v, attr, None)
        if callable(fn) and not isinstance(v, type):
            try:
                converted = fn()
            except Exception:
                continue
            if converted is not v:
                seen.add(oid)
                try:
                    return _norm(converted, depth, seen, b, exact)
                finally:
                    seen.discard(oid)

    try:
        r = repr(v)
    except Exception:
        r = f"<{type(v).__name__}>"
    return _str(r[:1000], b)


def _str(s: str, b: _Budget) -> str:
    if b.left is not None and len(s) > b.left:
        keep = max(b.left, 0)
        cut = len(s) - keep
        s = f"{s[:keep]}…[truncated {cut} chars]"
    b.take(len(s) + 2)
    return s


def canonical_json(value: Any) -> str:
    """Stable JSON for hashing tool arguments, byte-for-byte what the JS SDK's ``canonicalJson``
    writes for the same data: no spaces, object keys sorted by UTF-16 code units, non-ASCII kept as
    is, numbers in JavaScript's shortest form (``1.0`` → ``1``, ``1e-7`` → ``1e-7``), non-finite
    numbers as ``null``. Values are normalized first, without truncation."""
    return _canon(normalize(value, None))


def _utf16(key: str) -> bytes:
    return key.encode("utf-16-be", "surrogatepass")


_LONE_SURROGATE = re.compile("[\ud800-\udfff]")


def _canon(v: Any) -> str:
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        return js_number(v)
    if isinstance(v, str):
        # JSON.stringify escapes lone surrogates as \udxxx; everything else matches json.dumps.
        return _LONE_SURROGATE.sub(lambda m: "\\u%04x" % ord(m.group(0)), json.dumps(v, ensure_ascii=False))
    if isinstance(v, list):
        return "[" + ",".join(_canon(x) for x in v) + "]"
    if isinstance(v, dict):
        keys = sorted(v, key=_utf16)
        return "{" + ",".join(_canon(k) + ":" + _canon(v[k]) for k in keys) + "}"
    return json.dumps(str(v), ensure_ascii=False)


def js_number(x: float) -> str:
    """A float written the way JavaScript's ``String(number)`` / ``JSON.stringify`` writes it
    (ECMA-262 Number::toString); both languages pick the same shortest digits, only the layout
    differs. Non-finite numbers become ``null``, as in JSON.stringify."""
    if not math.isfinite(x):
        return "null"
    if x == 0:
        return "0"
    r = repr(abs(x))
    mant, _, exp_s = r.lower().partition("e")
    ip, _, fp = mant.partition(".")
    raw = ip + fp
    lead = len(raw) - len(raw.lstrip("0"))
    digits = raw.lstrip("0").rstrip("0") or "0"
    n = len(ip) + (int(exp_s) if exp_s else 0) - lead  # value = 0.digits × 10^n
    k = len(digits)
    if k <= n <= 21:
        out = digits + "0" * (n - k)
    elif 0 < n <= 21:
        out = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        out = digits[0] + ("." + digits[1:] if k > 1 else "") + "e" + ("+" if e >= 0 else "-") + str(abs(e))
    return ("-" if x < 0 else "") + out


# ── Redaction ────────────────────────────────────────────────────────────────

REDACTED = "[redacted]"

_SECRETS = re.compile(
    r"\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}"  # OpenAI / Stripe-style keys
    r"|\b(?:kal|kik)_[A-Za-z0-9_-]{16,}"  # Kalibra tokens and ingest keys
    r"|\bAKIA[0-9A-Z]{16}\b"  # AWS access key ids
    r"|\bgh[pousr]_[A-Za-z0-9]{30,}\b"  # GitHub tokens
    r"|\bxox[abpr]-[A-Za-z0-9-]{10,}"  # Slack tokens
    r"|\bAIza[0-9A-Za-z_-]{35}\b"  # Google API keys
    r"|(?i:bearer)\s+[A-Za-z0-9._~+/-]{16,}=*"  # bearer tokens in text
)
_EMAIL = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
_CARD = re.compile(r"\b(?:\d[ -]?){12,18}\d\b")
_PHONE = re.compile(r"(?<![\w+])\+?\d[\d ().-]{7,}\d(?!\w)")


def _luhn(digits: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = ord(ch) - 48
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def _card(m: "re.Match[str]") -> str:
    digits = re.sub(r"\D", "", m.group(0))
    return REDACTED if 13 <= len(digits) <= 19 and _luhn(digits) else m.group(0)


def _phone(m: "re.Match[str]") -> str:
    digits = re.sub(r"\D", "", m.group(0))
    return REDACTED if 10 <= len(digits) <= 15 else m.group(0)


def redact_text(s: str) -> str:
    """Removes secrets, card numbers, phone numbers and email addresses from text."""
    if len(s) < 6:
        return s
    s = _SECRETS.sub(REDACTED, s)
    s = _CARD.sub(_card, s)
    s = _PHONE.sub(_phone, s)
    return _EMAIL.sub(REDACTED, s)


def redact(value: Any, fn: Callable[[str], Any]) -> Any:
    """Applies ``fn`` to every string inside already-normalized data (keys are left alone)."""
    if isinstance(value, str):
        try:
            out = fn(value)
        except Exception:
            return "[redaction failed]"
        return out if isinstance(out, str) else normalize(out)
    if isinstance(value, dict):
        return {k: redact(x, fn) for k, x in value.items()}
    if isinstance(value, list):
        return [redact(x, fn) for x in value]
    return value
