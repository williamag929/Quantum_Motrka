import pytest

from privacy import StreamRestorer, redact, restore, scan


@pytest.mark.parametrize("text, label", [
    ("OPENAI_API_KEY=sk-proj-FAKE1234567890abcdefghij", "API key (sk-)"),
    ("postgres://admin:hunter2secret@db.internal/app", "DB connection string"),
    ("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123", "Bearer token"),
    ("card 4111 1111 1111 1111", "card number"),
    ("SSN 123-45-6789", "US SSN"),
])
def test_scan_detects_secrets(text, label):
    assert scan(text) == label


@pytest.mark.parametrize("text", ["What port does PostgreSQL use?", "order 1234567890123", "hello world"])
def test_scan_ignores_ordinary_text(text):
    assert scan(text) is None


def test_redact_hides_only_the_secret_part_and_round_trips():
    text = "DATABASE_URL=postgres://admin:Sup3rS3cret!@db.internal:5433/billing"
    redacted, mapping = redact(text)
    assert "Sup3rS3cret!" not in redacted
    assert "postgres://admin:[PASSWORD_1]@db.internal:5433/billing" in redacted
    assert restore(redacted, mapping) == text


def test_redact_does_not_re_redact_placeholders():
    redacted, mapping = redact("OPENAI_API_KEY=sk-proj-FAKE1234567890abcdefghij")
    assert redacted == "OPENAI_API_KEY=[API_KEY_1]"
    assert list(mapping) == ["[API_KEY_1]"]


def test_session_mapping_keeps_one_placeholder_per_secret():
    mapping: dict[str, str] = {}
    first, _ = redact("postgres://u:hunter2secret@h/db", mapping)
    second, _ = redact("is hunter2secret too weak? also password=otherSecret99", mapping)
    assert "[PASSWORD_1]" in first
    assert second == "is [PASSWORD_1] too weak? also password=[SECRET_2]"


def test_stream_restorer_handles_placeholders_split_across_chunks():
    restorer = StreamRestorer({"[PASSWORD_1]": "hunter2", "[SECRET_2]": "s3cr3t"})
    chunks = ["use [PASS", "WORD_1] and [SEC", "RET_2", "] then [x"]
    out = "".join(restorer.feed(c) for c in chunks) + restorer.flush()
    assert out == "use hunter2 and s3cr3t then [x"


def test_card_placeholder_keeps_last_four_digits():
    redacted, mapping = redact("My card 4111 1111 1111 1111 was charged twice")
    assert redacted == "My card [CARD_1 ending 1111] was charged twice"
    assert mapping["[CARD_1 ending 1111]"] == "4111 1111 1111 1111"
