"""Live checks against NVIDIA's OpenAI-compatible API (network, uses your NVIDIA_API_KEY).

Skipped unless MOTKRA_LIVE=1, so the normal `pytest` stays offline:

    set MOTKRA_LIVE=1 && python -m pytest tests/test_nvidia_live.py -v -s

NVIDIA retires and gates models per account (kimi-k3 → 410, kimi-k2.6 → 404 here), so these
tests say which models your key can actually call. Override the model with NVIDIA_TEST_MODEL.
"""
import os

import pytest
import requests

import config  # noqa: F401  (loads dual_ai/.env)
import kimi_client

BASE_URL = "https://integrate.api.nvidia.com/v1"
# NVIDIA_OPENAPI_KEY wins when set (the key that works for this account); else the usual one.
API_KEY = os.getenv("NVIDIA_OPENAPI_KEY") or os.getenv("NVIDIA_API_KEY") or ""
MODEL = os.getenv("NVIDIA_TEST_MODEL", "deepseek-ai/deepseek-v4.1-flash")
PROMPT = "Describe the path in this image and the landscape around it in two sentences."

pytestmark = pytest.mark.skipif(
    os.getenv("MOTKRA_LIVE") != "1" or not API_KEY,
    reason="live test: set MOTKRA_LIVE=1 and NVIDIA_OPENAPI_KEY (or NVIDIA_API_KEY)",
)


def _chat(model: str, content, max_tokens: int = 256) -> requests.Response:
    return requests.post(
        f"{BASE_URL}/chat/completions",
        headers={"Authorization": f"Bearer {API_KEY}"},
        json={"model": model, "messages": [{"role": "user", "content": content}], "max_tokens": max_tokens},
        timeout=120,
    )


def test_model_is_listed_for_this_key():
    r = requests.get(f"{BASE_URL}/models", headers={"Authorization": f"Bearer {API_KEY}"}, timeout=30)
    assert r.status_code == 200, r.text[:300]
    ids = {m["id"] for m in r.json()["data"]}
    assert MODEL in ids, f"{MODEL} is not in the catalog ({len(ids)} models)"


def test_plain_text_chat_with_the_model():
    r = _chat(MODEL, "Reply with one short sentence in Spanish.")
    assert r.status_code == 200, f"{r.status_code}: {r.text[:300]}"
    message = r.json()["choices"][0]["message"]
    assert (message.get("content") or message.get("reasoning_content") or "").strip(), "empty answer"


def test_chat_with_text_parts_as_in_the_original_snippet():
    # Same message shape as the snippet (a list of typed parts). The image part was cut off
    # when the snippet was shared, so this sends the text part only.
    r = _chat(MODEL, [{"type": "text", "text": PROMPT}])
    assert r.status_code == 200, f"{r.status_code}: {r.text[:300]}"


def test_motkra_client_streams_from_the_same_model(monkeypatch):
    # The path Motkra itself uses (dual_ai/kimi_client.py), pointed at this model.
    monkeypatch.setattr(kimi_client, "KIMI_MODEL", MODEL)
    monkeypatch.setenv("NVIDIA_API_KEY", API_KEY)
    pieces: list[str] = []
    reply = kimi_client.generate(
        [{"role": "user", "content": "Say hello in one short sentence."}],
        system="Answer briefly.",
        on_text=pieces.append,
        max_tokens=256,
    )
    assert reply.text.strip()
    assert "".join(pieces) == reply.text
