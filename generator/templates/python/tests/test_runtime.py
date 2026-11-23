# Runtime of paridad_resend against an http.server in a thread: authentication,
# User-Agent, error mapping, the retry table of vault/CONTRACT.md §5.3, idempotency,
# pagination and the absence of the API key in errors and debug output.
from __future__ import annotations

import json
import re
import socket
import threading
import time
import traceback
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

from paridad_resend import VERSION, ParidadError, Resend
from paridad_resend._runtime import USER_AGENT

KEY = "re_paridad_test_9f8e7d6c5b4a39281706"
SEND: Any = {"from": "Acme <onboarding@resend.dev>", "to": ["delivered@resend.dev"], "subject": "Hello World", "html": "<p>It works!</p>"}
MESSAGE = "Idempotency key must be between 1 and 256 characters."


@dataclass(frozen=True)
class Received:
    method: str
    url: str
    headers: dict[str, str]
    body: bytes


# Answers request n with handlers[n], or the last handler once they run out.
Handler = Callable[[BaseHTTPRequestHandler, Received], None]


class Server:
    def __init__(self, handlers: tuple[Handler, ...]) -> None:
        self.received: list[Received] = []
        outer = self

        class RequestHandler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def handle_any(self) -> None:
                body = self.rfile.read(int(self.headers.get("content-length") or 0))
                headers = {name.lower(): value for name, value in self.headers.items()}
                request = Received(self.command, self.path, headers, body)
                handler = handlers[min(len(outer.received), len(handlers) - 1)]
                outer.received.append(request)
                handler(self, request)

            do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = handle_any

            def log_message(self, format: str, *args: Any) -> None:
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), RequestHandler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


servers: list[Server] = []
# Set while a test tears down, so pending hang handlers return at once.
stopping = threading.Event()


@pytest.fixture(autouse=True)
def close_servers() -> Iterator[None]:
    stopping.clear()
    yield
    stopping.set()
    while servers:
        servers.pop().close()


def serve(*handlers: Handler) -> Server:
    server = Server(handlers)
    servers.append(server)
    return server


def json_response(status: int, body: object, headers: dict[str, str] | None = None) -> Handler:
    def handler(res: BaseHTTPRequestHandler, req: Received) -> None:
        data = json.dumps(body).encode()
        res.send_response(status)
        res.send_header("content-type", "application/json")
        res.send_header("content-length", str(len(data)))
        for name, value in (headers or {}).items():
            res.send_header(name, value)
        res.end_headers()
        res.wfile.write(data)

    return handler


ok = json_response(200, {"id": "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794"})
empty_list = json_response(200, {"object": "list", "has_more": False, "data": []})


def api_error(status: int, name: str, message: str, headers: dict[str, str] | None = None) -> Handler:
    return json_response(status, {"statusCode": status, "name": name, "message": message}, headers)


def hang(res: BaseHTTPRequestHandler, req: Received) -> None:
    """Never answers within the client timeout used below."""
    if not stopping.wait(2):
        try:
            ok(res, req)
        except OSError:
            pass


def cut(res: BaseHTTPRequestHandler, req: Received) -> None:
    """Sends the headers and part of the body, then closes the connection."""
    res.send_response(200)
    res.send_header("content-type", "application/json")
    res.send_header("content-length", "200")
    res.end_headers()
    res.wfile.write(b'{"object":"li')
    res.wfile.flush()
    res.close_connection = True
    res.connection.shutdown(socket.SHUT_RDWR)


def client(server: Server, timeout_ms: int = 300) -> Resend:
    return Resend(KEY, base_url=server.url, timeout_ms=timeout_ms)


def assert_same_key_and_body(received: list[Received], key: str) -> None:
    for request in received:
        assert request.headers["idempotency-key"] == key
        assert request.body == received[0].body


def debug_lines(output: str, operation: str) -> list[str]:
    return [line for line in output.split("\n") if f"operation={operation}" in line]


def test_every_request_carries_authorization_and_user_agent_content_type_only_with_a_body() -> None:
    server = serve(empty_list, ok)
    resend = client(server)
    resend.domains.list()
    resend.emails.send(SEND)
    get, post = server.received
    assert USER_AGENT == f"paridad-python/{VERSION}"
    for request in (get, post):
        assert request.headers["authorization"] == f"Bearer {KEY}"
        assert request.headers["user-agent"] == USER_AGENT
    assert get.method == "GET"
    assert get.url == "/domains"
    assert "content-type" not in get.headers
    assert post.method == "POST"
    assert post.url == "/emails"
    assert post.headers["content-type"] == "application/json"
    assert json.loads(post.body) == SEND


def test_key_base_url_and_timeout_come_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    server = serve(hang, empty_list)
    monkeypatch.setenv("RESEND_API_KEY", KEY)
    monkeypatch.setenv("RESEND_BASE_URL", f"{server.url}/")
    monkeypatch.setenv("RESEND_TIMEOUT_MS", "200")
    started = time.monotonic()
    Resend().domains.list()
    # The first attempt timed out after 200 ms instead of the 30000 ms default.
    assert time.monotonic() - started < 1.9
    assert len(server.received) == 2
    assert server.received[0].url == "/domains"
    assert server.received[0].headers["authorization"] == f"Bearer {KEY}"


def test_without_a_key_the_client_does_not_start(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    with pytest.raises(ValueError, match="Missing API key"):
        Resend()


def test_a_non_2xx_response_raises_paridad_error_with_code_message_and_status_code() -> None:
    server = serve(api_error(404, "not_found", "Domain not found"), json_response(418, {"message": "No name"}), json_response(400, "plain"))
    resend = client(server)
    with pytest.raises(ParidadError) as found:
        resend.domains.get("49a3999c-0ce1-4ea6-ab68-afcd6dc2e794")
    assert (found.value.code, found.value.message, found.value.status_code) == ("not_found", "Domain not found", 404)
    assert str(found.value) == "Domain not found"
    with pytest.raises(ParidadError) as no_name:
        resend.domains.list()
    assert (no_name.value.code, no_name.value.message, no_name.value.status_code) == ("http_418", "No name", 418)
    with pytest.raises(ParidadError) as plain:
        resend.domains.list()
    assert plain.value.code == "http_400"
    assert len(server.received) == 3


def test_429_rate_limit_exceeded_with_retry_after_waits_and_retries() -> None:
    server = serve(api_error(429, "rate_limit_exceeded", "Too many requests", {"retry-after": "1"}), empty_list)
    started = time.monotonic()
    client(server).domains.list()
    elapsed = time.monotonic() - started
    assert len(server.received) == 2
    assert 0.975 <= elapsed < 2, f"waited {elapsed} s"


def test_429_rate_limit_exceeded_is_retried_on_post_without_key_and_stops_after_3_attempts() -> None:
    limited = api_error(429, "rate_limit_exceeded", "Too many requests", {"retry-after": "0"})
    once = serve(limited, ok)
    client(once).emails.send(SEND)
    assert len(once.received) == 2
    always = serve(limited)
    with pytest.raises(ParidadError) as found:
        client(always).domains.list()
    assert found.value.code == "rate_limit_exceeded"
    assert len(always.received) == 3


def test_429_with_retry_after_above_60_seconds_is_not_retried() -> None:
    server = serve(api_error(429, "rate_limit_exceeded", "Too many requests", {"retry-after": "61"}), empty_list)
    with pytest.raises(ParidadError) as found:
        client(server).domains.list()
    assert found.value.code == "rate_limit_exceeded"
    assert len(server.received) == 1


@pytest.mark.parametrize("name", ["daily_quota_exceeded", "monthly_quota_exceeded"])
def test_429_quota_errors_are_never_retried(name: str) -> None:
    server = serve(api_error(429, name, "Quota exceeded", {"retry-after": "1"}), empty_list)
    with pytest.raises(ParidadError) as found:
        client(server).domains.list()
    assert (found.value.code, found.value.status_code) == (name, 429)
    assert len(server.received) == 1


def test_503_is_retried_on_get_and_on_post_with_key_not_on_post_without_key() -> None:
    unavailable = api_error(503, "service_unavailable", "Service unavailable")
    get = serve(unavailable, empty_list)
    client(get).domains.list()
    assert len(get.received) == 2

    with_key = serve(unavailable, ok)
    client(with_key).emails.send(SEND, idempotency_key="welcome-user-123")
    assert len(with_key.received) == 2
    assert_same_key_and_body(with_key.received, "welcome-user-123")

    without_key = serve(unavailable, ok)
    with pytest.raises(ParidadError) as found:
        client(without_key).emails.send(SEND)
    assert (found.value.code, found.value.status_code) == ("service_unavailable", 503)
    assert len(without_key.received) == 1


def test_500_on_every_attempt_of_a_get_gives_application_error_after_3_attempts() -> None:
    server = serve(api_error(500, "application_error", "Internal server error"))
    with pytest.raises(ParidadError) as found:
        client(server).domains.list()
    assert found.value.code == "application_error"
    assert len(server.received) == 3


def test_409_concurrent_idempotent_requests_is_retried_with_key() -> None:
    server = serve(api_error(409, "concurrent_idempotent_requests", "Concurrent request"), ok)
    client(server).emails.send(SEND, idempotency_key="k-409")
    assert len(server.received) == 2


@pytest.mark.parametrize(
    ("status", "name"),
    [(400, "validation_error"), (401, "missing_api_key"), (403, "restricted_api_key"), (404, "not_found"), (405, "method_not_allowed"), (409, "invalid_idempotent_request"), (422, "missing_required_field")],
)
def test_other_4xx_are_not_retried(status: int, name: str) -> None:
    server = serve(api_error(status, name, "No"), ok)
    with pytest.raises(ParidadError) as found:
        client(server).emails.send(SEND, idempotency_key="k")
    assert found.value.code == name
    assert len(server.received) == 1


def test_a_timeout_is_retried_on_get_and_on_post_with_key_and_raised_on_post_without_key() -> None:
    get = serve(hang, empty_list)
    client(get).domains.list()
    assert len(get.received) == 2

    with_key = serve(hang, ok)
    client(with_key).emails.send(SEND, idempotency_key="timeout-key")
    assert len(with_key.received) == 2
    assert_same_key_and_body(with_key.received, "timeout-key")

    without_key = serve(hang, ok)
    with pytest.raises(ParidadError) as found:
        client(without_key).emails.send(SEND)
    assert (found.value.code, found.value.status_code) == ("timeout", None)
    assert len(without_key.received) == 1


def test_a_response_cut_in_the_middle_is_retried_on_get_and_on_post_with_key_not_on_post_without_key() -> None:
    get = serve(cut, empty_list)
    client(get).domains.list()
    assert len(get.received) == 2

    with_key = serve(cut, ok)
    client(with_key).emails.send(SEND, idempotency_key="cut-key")
    assert len(with_key.received) == 2
    assert_same_key_and_body(with_key.received, "cut-key")

    without_key = serve(cut, ok)
    with pytest.raises(ParidadError) as found:
        client(without_key).emails.send(SEND)
    assert (found.value.code, found.value.status_code) == ("connection_error", None)
    assert len(without_key.received) == 1


def test_a_refused_connection_is_retried_even_on_post_without_key_up_to_3_attempts(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    monkeypatch.setenv("PARIDAD_DEBUG", "1")
    with pytest.raises(ParidadError) as found:
        Resend(KEY, base_url=f"http://127.0.0.1:{port}", timeout_ms=300).emails.send(SEND)
    assert (found.value.code, found.value.status_code) == ("connection_error", None)
    assert len(debug_lines(capsys.readouterr().err, "emails/send")) == 3


def test_an_invalid_idempotency_key_fails_without_sending_any_request() -> None:
    server = serve(ok)
    resend = client(server)
    for key in ["", "k" * 257]:
        with pytest.raises(ParidadError) as found:
            resend.emails.send(SEND, idempotency_key=key)
        assert (found.value.code, found.value.message, found.value.status_code) == ("invalid_idempotency_key", MESSAGE, None)
    assert len(server.received) == 0
    resend.emails.send(SEND, idempotency_key="k" * 256)
    assert server.received[0].headers["idempotency-key"] == "k" * 256


ITEMS = [{"id": f"c{n}", "email": f"c{n}@example.com"} for n in range(1, 6)]


def pages(res: BaseHTTPRequestHandler, req: Received) -> None:
    query = parse_qs(urlsplit(req.url).query)
    after = query.get("after", [None])[0]
    start = next(index for index, item in enumerate(ITEMS) if item["id"] == after) + 1 if after is not None else 0
    limit = int(query["limit"][0])
    json_response(200, {"object": "list", "has_more": start + limit < len(ITEMS), "data": ITEMS[start : start + limit]})(res, req)


def test_list_all_follows_after_while_has_more_is_true() -> None:
    server = serve(pages)
    seen = [str(contact["id"]) for contact in client(server).contacts.list_all({"limit": 2})]
    assert seen == ["c1", "c2", "c3", "c4", "c5"]
    assert [request.url for request in server.received] == ["/contacts?limit=2", "/contacts?limit=2&after=c2", "/contacts?limit=2&after=c4"]

    # The first request of page 2 is cut: that page is retried (GET), no item repeats.
    flaky = serve(pages, cut, pages)
    again = [str(contact["id"]) for contact in client(flaky).contacts.list_all({"limit": 2})]
    assert again == ["c1", "c2", "c3", "c4", "c5"]
    assert len(flaky.received) == 4


def test_list_all_raises_the_paridad_error_of_a_page_that_keeps_failing() -> None:
    server = serve(api_error(404, "not_found", "Gone"))
    with pytest.raises(ParidadError) as found:
        for item in client(server).contacts.list_all():
            pytest.fail(f"unexpected item {item!r}")
    assert found.value.code == "not_found"


def test_the_api_key_never_appears_in_errors_or_debug_output_debug_shows_it_masked(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    server = serve(api_error(401, "missing_api_key", "Missing API key"), hang, cut, api_error(503, "service_unavailable", "Down"))
    monkeypatch.setenv("PARIDAD_DEBUG", "1")
    resend = client(server)
    messages: list[str] = []
    for key in [None, None, None, None, ""]:
        with pytest.raises(ParidadError) as found:
            resend.emails.send(SEND, idempotency_key=key)
        error = found.value
        messages.append(f"{error.code} {error.message} {error!r} {''.join(traceback.format_exception(error))}")
    output = capsys.readouterr().err
    assert len(messages) == 5
    for message in messages:
        assert KEY not in message
    assert KEY not in output
    assert KEY[3:-4] not in output
    assert re.search(r"config .*api_key=re_\.\.\.1706", output)
    assert re.search(r"operation=emails/send method=POST path=/emails attempt=1 result=401 wait_ms=none", output)
    assert re.search(r"attempt=1 result=timeout wait_ms=none", output)
    assert re.search(r"attempt=1 result=connection_error wait_ms=none", output)


def test_debug_output_lists_every_attempt_with_the_wait_before_the_next_one(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    server = serve(api_error(503, "service_unavailable", "Down"), empty_list)
    monkeypatch.setenv("PARIDAD_DEBUG", "1")
    client(server).domains.list()
    lines = debug_lines(capsys.readouterr().err, "domains/list")
    assert len(lines) == 2
    assert re.search(r"attempt=1 result=503 wait_ms=\d+$", lines[0])
    assert re.search(r"attempt=2 result=200 wait_ms=none$", lines[1])
