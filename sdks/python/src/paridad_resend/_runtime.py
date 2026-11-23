# Runtime of paridad_resend (vault/CONTRACT.md §5): configuration, authentication,
# typed errors, the retry and idempotency policy of §5.3, per-attempt timeouts,
# cursor pagination and debug output, with the standard library only. Static
# template copied by the generator; the policy constants come from the IR
# (_policy.py) and the resources and methods are generated from its operations
# (resources.py).
from __future__ import annotations

import http.client
import json
import math
import os
import random
import re
import sys
import time
import uuid
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Literal, TypedDict
from urllib.parse import quote, quote_plus, urlsplit

from ._policy import POLICY, VERSION

USER_AGENT = f"paridad-python/{VERSION}"
_DEFAULT_BASE_URL = "https://api.resend.com"
_DEFAULT_TIMEOUT_MS = 30000
_CHUNK = 65536


class _ResponseRuleRequired(TypedDict):
    status: int


class ResponseRule(_ResponseRuleRequired, total=False):
    # Without `name` the rule matches any name; `name: None` matches a body without `name`.
    name: str | None


class RetryRules(TypedDict):
    responses: list[ResponseRule]
    transport: list[str]


class Backoff(TypedDict):
    retry_after_jitter_ms: int
    retry_after_max_seconds: int
    base_ms: int
    cap_ms: int


class IdempotencyKeyRules(TypedDict):
    header: str
    min_length: int
    max_length: int
    error_code: str
    error_message: str


class Policy(TypedDict):
    """`policy` of the IR (ir/overlay.yaml)."""

    max_attempts: int
    safe_methods: list[str]
    safe_with_idempotency_key: bool
    retry_always: RetryRules
    retry_if_safe: RetryRules
    backoff: Backoff
    idempotency_key: IdempotencyKeyRules


class ParidadError(Exception):
    """A failed operation: `code`, `message` and `status_code` (None without a response)."""

    code: str
    message: str
    status_code: int | None

    def __init__(self, code: str, message: str, status_code: int | None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code

    def __repr__(self) -> str:
        return f"ParidadError(code={self.code!r}, message={self.message!r}, status_code={self.status_code!r})"


@dataclass(frozen=True)
class QueryParameter:
    name: str
    explode: bool


@dataclass(frozen=True)
class Operation:
    """What a generated method knows about its operation."""

    id: str
    method: str
    path: str
    query: tuple[QueryParameter, ...]
    body: Literal["json", "multipart"] | None


_Transport = Literal["timeout", "connection_error_before_send", "connection_error_after_send"]


@dataclass(frozen=True)
class _Attempt:
    data: object
    error: ParidadError | None
    status: int | None
    name: str | None
    transport: _Transport | None
    retry_after: str | None


class _BeforeSend(Exception):
    """The connection failed before the request left the client."""


class Core:
    def __init__(self, api_key: str | None, base_url: str | None, timeout_ms: int | None) -> None:
        env = os.environ
        key = api_key or env.get("RESEND_API_KEY") or None
        if key is None:
            raise ValueError("Missing API key. Pass it to the constructor or set RESEND_API_KEY.")
        self._api_key = key
        self._base_url = (base_url or env.get("RESEND_BASE_URL") or _DEFAULT_BASE_URL).rstrip("/")
        base = urlsplit(self._base_url)
        if base.scheme not in ("http", "https") or base.hostname is None:
            raise ValueError(f"The base URL {self._base_url} is not an http or https URL.")
        self._scheme = base.scheme
        self._host = base.hostname
        self._port = base.port
        self._prefix = base.path
        timeout: object = timeout_ms if timeout_ms is not None else (env.get("RESEND_TIMEOUT_MS") or _DEFAULT_TIMEOUT_MS)
        if isinstance(timeout, str) and re.fullmatch(r"[0-9]+", timeout.strip()):
            timeout = int(timeout)
        if isinstance(timeout, bool) or not isinstance(timeout, int) or timeout <= 0:
            raise ValueError("The timeout must be a positive integer of milliseconds.")
        self._timeout_ms = timeout
        self._debug = env.get("PARIDAD_DEBUG") == "1"
        if self._debug:
            _debug(
                f"config base_url={self._base_url} timeout_ms={self._timeout_ms} "
                f"api_key={mask_key(key)} user_agent={USER_AGENT}"
            )

    def request(
        self,
        op: Operation,
        path: Sequence[object],
        query: Mapping[str, object] | None,
        body: object,
        idempotency_key: str | None = None,
    ) -> object:
        rules = POLICY["idempotency_key"]
        if idempotency_key is not None and not rules["min_length"] <= len(idempotency_key) <= rules["max_length"]:
            raise ParidadError(rules["error_code"], rules["error_message"], None)
        target = self._target(op, path, query)
        headers = {"Authorization": f"Bearer {self._api_key}", "User-Agent": USER_AGENT}
        if idempotency_key is not None:
            headers[rules["header"]] = idempotency_key
        # The body is serialized once, so every attempt sends the same bytes.
        payload: bytes | None = None
        if op.body == "json":
            payload = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
            headers["Content-Type"] = "application/json"
        elif op.body == "multipart":
            payload, headers["Content-Type"] = _multipart(body)
        safe = op.method in POLICY["safe_methods"] or (POLICY["safe_with_idempotency_key"] and idempotency_key is not None)
        pathname = target.split("?", 1)[0]

        attempt = 1
        while True:
            outcome = self._attempt(op.method, target, headers, payload)
            wait = _retry_delay(outcome, safe, attempt) if attempt < POLICY["max_attempts"] else None
            if self._debug:
                result = outcome.status if outcome.status is not None else (outcome.error.code if outcome.error else "")
                next_wait = "none" if wait is None else str(math.floor(wait + 0.5))
                _debug(
                    f"operation={op.id} method={op.method} path={pathname} attempt={attempt} "
                    f"result={result} wait_ms={next_wait}"
                )
            if wait is None:
                if outcome.error is not None:
                    raise outcome.error
                return outcome.data
            time.sleep(wait / 1000)
            attempt += 1

    def paginate(self, op: Operation, path: Sequence[object], query: Mapping[str, object] | None) -> Iterator[object]:
        """Every item of every page, asking for the next page with after = id of the
        last item while has_more is true. Each page follows the retry policy; an
        error that remains is raised as ParidadError."""
        after: str | None = None
        while True:
            page = self.request(op, path, {**(query or {}), "after": after}, None)
            fields = page if isinstance(page, dict) else {}
            items = fields.get("data")
            items = items if isinstance(items, list) else []
            yield from items
            last = items[-1] if items else None
            if fields.get("has_more") is not True or not isinstance(last, dict) or not isinstance(last.get("id"), str):
                return
            after = last["id"]

    def _target(self, op: Operation, path: Sequence[object], query: Mapping[str, object] | None) -> str:
        values = iter(path)
        # Same escaping as encodeURIComponent.
        pathname = re.sub(r"\{[^}]+\}", lambda _: quote(_text(next(values, "")), safe="!~*'()"), op.path)
        pairs: list[str] = []
        given = query or {}
        for parameter in op.query:
            value = given.get(parameter.name)
            if value is None:
                continue
            items = [value] if not isinstance(value, (list, tuple)) else list(value)
            texts = [_text(item) for item in items]
            joined = texts if parameter.explode or not isinstance(value, (list, tuple)) else [",".join(texts)]
            pairs.extend(f"{quote_plus(parameter.name, safe='*')}={quote_plus(text, safe='*')}" for text in joined)
        return f"{self._prefix}{pathname}{'?' + '&'.join(pairs) if pairs else ''}"

    def _attempt(self, method: str, target: str, headers: dict[str, str], payload: bytes | None) -> _Attempt:
        deadline = time.monotonic() + self._timeout_ms / 1000

        def remaining() -> float:
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError
            return left

        connection: http.client.HTTPConnection
        if self._scheme == "https":
            connection = http.client.HTTPSConnection(self._host, self._port, timeout=remaining())
        else:
            connection = http.client.HTTPConnection(self._host, self._port, timeout=remaining())
        try:
            try:
                connection.connect()
            except TimeoutError:
                raise
            except OSError as error:
                raise _BeforeSend from error
            connection.request(method, target, body=payload, headers=headers)
            # getresponse() may hand the socket over to the response and drop it from
            # the connection, so the deadline is applied through this reference.
            sock = connection.sock
            sock.settimeout(remaining())
            response = connection.getresponse()
            chunks: list[bytes] = []
            while True:
                sock.settimeout(remaining())
                chunk = response.read(_CHUNK)
                if not chunk:
                    break
                chunks.append(chunk)
            if response.length:
                # The connection closed before Content-Length bytes arrived.
                raise http.client.IncompleteRead(b"".join(chunks), response.length)
            return _from_response(response.status, response.getheader("retry-after"), b"".join(chunks))
        except TimeoutError:
            return self._transport("timeout")
        except _BeforeSend:
            return self._transport("connection_error_before_send")
        except (OSError, http.client.HTTPException):
            return self._transport("connection_error_after_send")
        finally:
            connection.close()

    def _transport(self, transport: _Transport) -> _Attempt:
        if transport == "timeout":
            error = ParidadError("timeout", f"The request timed out after {self._timeout_ms} ms.", None)
        elif transport == "connection_error_before_send":
            error = ParidadError("connection_error", "Could not connect to the API.", None)
        else:
            error = ParidadError("connection_error", "The connection closed before the response was complete.", None)
        return _Attempt(None, error, None, None, transport, None)


def _from_response(status: int, retry_after: str | None, raw: bytes) -> _Attempt:
    parsed: object = None
    valid = True
    if raw:
        try:
            parsed = json.loads(raw)
        except ValueError:
            valid = False
    if 200 <= status < 300:
        if valid:
            return _Attempt(parsed, None, status, None, None, retry_after)
        error = ParidadError("invalid_response", "The response body is not valid JSON.", status)
        return _Attempt(None, error, status, None, None, retry_after)
    fields = parsed if isinstance(parsed, dict) else {}
    name = fields.get("name") if isinstance(fields.get("name"), str) else None
    message = fields.get("message") if isinstance(fields.get("message"), str) else f"Request failed with status {status}."
    error = ParidadError(name if name is not None else f"http_{status}", str(message), status)
    return _Attempt(None, error, status, name, None, retry_after)


def _retry_delay(outcome: _Attempt, safe: bool, attempt: int) -> float | None:
    """Milliseconds to wait before the next attempt, or None when the outcome is final (§5.3)."""
    if outcome.error is None:
        return None

    def matches(rules: RetryRules) -> bool:
        if outcome.transport is not None:
            return outcome.transport in rules["transport"]
        return any(
            rule["status"] == outcome.status and ("name" not in rule or rule.get("name") == outcome.name)
            for rule in rules["responses"]
        )

    if not matches(POLICY["retry_always"]) and not (safe and matches(POLICY["retry_if_safe"])):
        return None
    backoff = POLICY["backoff"]
    retry_after = (outcome.retry_after or "").strip()
    if re.fullmatch(r"[0-9]+", retry_after):
        seconds = int(retry_after)
        if seconds > backoff["retry_after_max_seconds"]:
            return None
        return seconds * 1000 + random.random() * backoff["retry_after_jitter_ms"]
    return float(min(backoff["cap_ms"], backoff["base_ms"] * 2 ** (attempt - 1))) * (0.5 + 0.5 * random.random())


def _multipart(body: object) -> tuple[bytes, str]:
    boundary = f"paridad-{uuid.uuid4().hex}"
    parts: list[bytes] = []
    fields: dict[object, object] = body if isinstance(body, dict) else {}
    for name, value in fields.items():
        if value is None:
            continue
        field = str(name).replace('"', "%22")
        if isinstance(value, (bytes, bytearray)):
            head = f'Content-Disposition: form-data; name="{field}"; filename="{field}"\r\nContent-Type: application/octet-stream'
            data = bytes(value)
        else:
            head = f'Content-Disposition: form-data; name="{field}"'
            data = (value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, separators=(",", ":"))).encode()
        parts.append(f"--{boundary}\r\n{head}\r\n\r\n".encode() + data + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def _text(value: object) -> str:
    """A value as JavaScript's String() writes it, so query and path match the TS SDK."""
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def mask_key(key: str) -> str:
    """The key is never shown: re_... and its last 4 characters."""
    return f"re_...{key[-4:] if len(key) > 4 else ''}"


def _debug(line: str) -> None:
    sys.stderr.write(f"[paridad] {line}\n")
    sys.stderr.flush()
