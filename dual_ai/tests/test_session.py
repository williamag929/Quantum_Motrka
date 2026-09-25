import pytest

import session as session_mod
from reply import Reply
from session import Session


class FakeStats:
    def __init__(self) -> None:
        self.records = []

    def record(self, *args) -> None:
        self.records.append(args)


class FakeClient:
    def __init__(self, answer: str = "ok", fail: bool = False) -> None:
        self.answer, self.fail, self.calls = answer, fail, []

    def generate(self, messages, system, on_text):
        self.calls.append(messages)
        if self.fail:
            raise RuntimeError("model down")
        for word in self.answer.split(" "):
            on_text(word + " ")
        return Reply(self.answer, 10, 5)


@pytest.fixture
def clients(monkeypatch):
    fakes = {"local": FakeClient("local answer"), "cloud": FakeClient("cloud answer"), "kimi": FakeClient()}
    monkeypatch.setattr(session_mod, "CLIENTS", fakes)
    return fakes


def test_cloud_never_sees_raw_secret_and_reply_is_restored(clients):
    clients["cloud"].answer = "Rotate [PASSWORD_1] now"
    s = Session("cloud", stats=FakeStats())
    turn = s.ask("my db is postgres://admin:hunter2secret@db/app, is it safe?")
    sent = clients["cloud"].calls[0][-1]["content"]
    assert "hunter2secret" not in sent and "[PASSWORD_1]" in sent
    assert turn.redacted
    assert turn.text == "Rotate hunter2secret now"


def test_streamed_text_is_restored(clients):
    clients["cloud"].answer = "Rotate [PASSWORD_1] now"
    s = Session("cloud", stats=FakeStats())
    pieces = []
    s.ask("postgres://admin:hunter2secret@db/app", on_text=pieces.append)
    assert "hunter2secret" in "".join(pieces) and "[PASSWORD_1]" not in "".join(pieces)


def test_private_turn_keeps_conversation_local_and_out_of_cloud_payloads(clients):
    s = Session("auto", stats=FakeStats())
    first = s.ask("Mi psiquiatra me subió la sertralina a 100 mg")
    assert first.decision.target == "local" and first.decision.private
    second = s.ask("Write a Python function that checks for palindromes")
    assert second.decision.target == "local"
    s.mode = "cloud"
    s.ask("Write a Python function that checks for palindromes")
    assert all("sertralina" not in m["content"] for m in clients["cloud"].calls[0])


def test_failed_request_is_dropped_from_history(clients):
    clients["local"].fail = True
    s = Session("local", stats=FakeStats())
    with pytest.raises(RuntimeError):
        s.ask("hola")
    assert s.history == []


def test_on_start_reports_route_before_streaming(clients):
    s = Session("local", stats=FakeStats())
    seen = []
    s.ask("hola", on_start=lambda t: seen.append(("start", t.decision.target)), on_text=lambda p: seen.append("text"))
    assert seen[0] == ("start", "local") and "text" in seen


@pytest.mark.parametrize("raw, mode", [("Claude", "cloud"), ("ollama", "local"), (" kimi ", "kimi"), ("gpt", None)])
def test_normalize_mode(raw, mode):
    assert session_mod.normalize_mode(raw) == mode


def test_plan_matches_a_live_session_turn_by_turn(clients):
    """The Electron app routes statelessly; it must reach the same decisions as a Session."""
    conversation = [
        "What port does PostgreSQL use by default?",
        "my db is postgres://admin:hunter2secret@db/app, write a Python function to connect to it",
        "Mi psiquiatra me subió la sertralina a 100 mg",
        "Write a Python function that checks for palindromes",
    ]
    live = Session("auto", stats=FakeStats())
    history: list[dict] = []
    for text in conversation:
        planned = session_mod.plan("auto", history + [{"role": "user", "content": text}])
        turn = live.ask(text)
        assert (planned["target"], planned["private"], planned["redacted"]) == \
            (turn.decision.target, turn.decision.private, turn.redacted), text
        history += [{"role": "user", "content": text, "private": planned["private"]},
                    {"role": "assistant", "content": turn.text, "private": planned["private"]}]


def test_plan_cloud_payload_is_redacted_and_restorable():
    out = session_mod.plan("cloud", [{"role": "user", "content": "postgres://admin:hunter2secret@db/app"}])
    assert "hunter2secret" not in out["messages"][-1]["content"]
    assert out["secrets"] == {"[PASSWORD_1]": "hunter2secret"} and out["redaction_note"]


def test_plan_without_flags_treats_personal_turns_as_private():
    history = [{"role": "user", "content": "estoy en proceso de divorcio"}, {"role": "assistant", "content": "Lo siento."}]
    auto = session_mod.plan("auto", history + [{"role": "user", "content": "Write a Python function that checks for palindromes"}])
    assert auto["target"] == "local" and auto["private"]
    cloud = session_mod.plan("cloud", history + [{"role": "user", "content": "hola"}])
    assert [m["content"] for m in cloud["messages"]] == ["hola"]
