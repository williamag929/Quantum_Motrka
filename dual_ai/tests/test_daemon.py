import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

import session as session_mod
from daemon import Daemon, allowed_request, make_handler
from reply import Reply
from session import Session


@pytest.mark.parametrize("method, host, origin, ctype, ok", [
    ("GET", "127.0.0.1:7432", None, None, True),
    ("GET", "localhost:7432", None, None, True),
    ("POST", "127.0.0.1:7432", None, "application/json; charset=utf-8", True),
    ("POST", "127.0.0.1:7432", None, "text/plain", False),           # cross-site "simple" request
    ("POST", "127.0.0.1:7432", "https://evil.example", "application/json", False),
    ("GET", "evil.example:7432", None, None, False),                  # DNS rebinding
    ("GET", "127.0.0.1:9999", None, None, False),
    ("GET", None, None, None, False),
])
def test_allowed_request(method, host, origin, ctype, ok):
    assert allowed_request(method, host, origin, ctype, 7432) is ok


class EchoClient:
    def generate(self, messages, system, on_text):
        text = "echo: " + messages[-1]["content"]
        on_text(text)
        return Reply(text, 1, 1)


class NoStats:
    def record(self, *args) -> None:
        pass


@pytest.fixture
def api(monkeypatch):
    monkeypatch.setattr(session_mod, "CLIENTS", {"local": EchoClient(), "cloud": EchoClient(), "kimi": EchoClient()})
    daemon = Daemon(voice=False, session=Session("local", stats=NoStats()))
    server = ThreadingHTTPServer(("127.0.0.1", 0), None)
    port = server.server_address[1]
    server.RequestHandlerClass = make_handler(daemon, port)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    def call(path, data=None, headers=None):
        req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method="POST" if data is not None else "GET",
                                     data=json.dumps(data).encode() if data is not None else None,
                                     headers={"Content-Type": "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read())

    yield call, daemon
    server.shutdown()
    server.server_close()


def test_status_matches_what_the_extension_expects(api):
    call, _ = api
    code, body = call("/status")
    assert code == 200 and body["status"] == "ok" and body["mode"] == "local"


def test_ask_returns_reply_and_route(api):
    call, daemon = api
    code, body = call("/ask", {"text": "hola"})
    assert code == 200 and body["text"] == "echo: hola" and body["target"] == "local"
    assert daemon.state == "idle"


def test_mode_and_clear(api):
    call, daemon = api
    assert call("/mode", {"mode": "claude"}) == (200, {"mode": "cloud"})
    assert call("/mode", {"mode": "gpt"})[0] == 400
    call("/ask", {"text": "hola"})
    assert call("/clear", {}) == (200, {"cleared": True}) and daemon.session.history == []


def test_browser_origin_is_refused(api):
    call, _ = api
    assert call("/ask", {"text": "hola"}, headers={"Origin": "https://evil.example"})[0] == 403


def test_bad_bodies(api):
    call, _ = api
    assert call("/ask", {"text": "  "})[0] == 400
    assert call("/ask", ["not", "an", "object"])[0] == 400


def test_route_endpoint(api):
    call, _ = api
    code, body = call("/route", {"mode": "cloud", "messages": [{"role": "user", "content": "password=otherSecret99"}]})
    assert code == 200 and body["target"] == "cloud" and body["redacted"]
    assert "otherSecret99" not in json.dumps(body["messages"])
    assert call("/route", {"messages": [{"role": "assistant", "content": "hi"}]})[0] == 400
    assert call("/route", {"messages": "hola"})[0] == 400


def test_redact_endpoint_reuses_the_mapping(api):
    call, _ = api
    first = call("/route", {"mode": "cloud", "messages": [{"role": "user", "content": "password=otherSecret99"}]})[1]
    code, body = call("/redact", {"text": "config: password=otherSecret99 token=sk-proj-FAKE1234567890abcdefghij",
                                  "secrets": first["secrets"]})
    assert code == 200 and "otherSecret99" not in body["text"] and "FAKE1234567890" not in body["text"]
    assert "[SECRET_1]" in body["text"] and len(body["secrets"]) == 2
