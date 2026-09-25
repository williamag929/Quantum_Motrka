import pytest

from router import intent_route, looks_personal, quick_answer, smart_route


@pytest.mark.parametrize("text", [
    "My doctor said my HbA1c is 6.9%",
    "Mi psiquiatra me subió la sertralina a 100 mg",
    "I owe $38,000 in student loans",
    "estoy en proceso de divorcio",
    "Help me write a message to HR about my manager",
])
def test_personal_topics_are_detected(text):
    assert looks_personal(text)


@pytest.mark.parametrize("text", [
    "Our technical debt is growing",
    "How do I diagnose a slow React form?",
    "Explain diagnostics in Kubernetes",
])
def test_technical_text_is_not_personal(text):
    assert not looks_personal(text)


@pytest.mark.parametrize("text, target", [
    ("What port does PostgreSQL use by default?", "local"),
    ("Clasifica este correo: urgente o spam. Solo la etiqueta.", "local"),
    ("Traduce al inglés: la actualización se aplicará esta noche.", "local"),
    ("Write a Python function that checks for palindromes", "cloud"),
    ("Explica el event loop de JavaScript", "cloud"),
    ("How many workers do we need for 1200 requests per second?", "cloud"),
])
def test_intent_route(text, target):
    assert intent_route(text) == target


def test_quick_answer():
    assert quick_answer("What is the time complexity of binary search?")
    assert quick_answer("Subject: hi\nBody...\nLabel only.")
    assert not quick_answer("Summarize this:\n\nA long paragraph about a quarterly review and its results.")


def test_smart_route_redacts_secrets_and_keeps_personal_local():
    mapping: dict[str, str] = {}
    d = smart_route("Explain why this fails: postgres://admin:Sup3rSecretPw@db/app", mapping)
    assert d.target == "cloud" and d.redacted
    assert "Sup3rSecretPw" in mapping.values()

    d = smart_route("Mi médico dijo que mi HbA1c es 6.9%, ¿es grave?")
    assert d.target == "local" and d.private


@pytest.mark.parametrize("text, target", [
    ("¿Qué significa el código HTTP 404?", "local"),
    ("What does status code 429 mean?", "local"),
    ("Arregla este código, no compila", "cloud"),
    ("Refactor this code", "cloud"),
])
def test_status_codes_are_not_programming(text, target):
    assert intent_route(text) == target
