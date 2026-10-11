import json
import os
from typing import Callable, Optional

import requests

from config import KIMI_MODEL, KIMI_TEMPERATURE, KIMI_TOP_P, SYSTEM_PROMPT
from reply import Reply

KIMI_INVOKE_URL = "https://integrate.api.nvidia.com/v1/chat/completions"


def fold_system(system: str, messages: list[dict]) -> list[dict]:
    """NVIDIA's Kimi K3 answers with garbage ("@ @ @...", empty content) whenever the request has a
    system message. Put the instructions at the start of the first user message instead; it keeps
    the model's reasoning, unlike turning thinking off."""
    text = (system or "").strip()
    if not text:
        return messages
    for i, m in enumerate(messages):
        if m["role"] == "user" and isinstance(m["content"], str):
            return messages[:i] + [{**m, "content": f"Instructions:\n{text}\n\n---\n\n{m['content']}"}] + messages[i + 1:]
    return [{"role": "user", "content": f"Instructions:\n{text}"}] + messages


def generate(
    messages: list[dict],
    system: str = SYSTEM_PROMPT,
    on_text: Optional[Callable[[str], None]] = None,
    max_tokens: int = 16384,
) -> Reply:
    api_key = os.getenv("NVIDIA_API_KEY")
    if not api_key:
        raise RuntimeError("NVIDIA_API_KEY is not set in dual_ai/.env (get one at https://build.nvidia.com/).")

    payload = {
        "model": KIMI_MODEL,
        "messages": fold_system(system, messages),
        "max_tokens": max_tokens,
        # NVIDIA's Kimi K3 produces gibberish at temperature 1.0 (empty content, random reasoning tokens).
        "temperature": KIMI_TEMPERATURE,
        "top_p": KIMI_TOP_P,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    headers = {"Authorization": f"Bearer {api_key}", "Accept": "text/event-stream"}

    text, in_tok, out_tok = "", 0, 0
    with requests.post(KIMI_INVOKE_URL, headers=headers, json=payload, stream=True, timeout=(10, 300)) as resp:
        if resp.status_code != 200:
            raise RuntimeError(f"NVIDIA API error {resp.status_code}: {resp.text[:300]}")
        for raw in resp.iter_lines(decode_unicode=True):
            if not raw or not raw.startswith("data: "):
                continue
            data = raw[6:]
            if data == "[DONE]":
                break
            event = json.loads(data)
            if event.get("usage"):
                in_tok = event["usage"].get("prompt_tokens", 0)
                out_tok = event["usage"].get("completion_tokens", 0)
            for choice in event.get("choices", []):
                piece = (choice.get("delta") or {}).get("content") or ""
                if piece:
                    if on_text:
                        on_text(piece)
                    text += piece
    if not text.strip():
        raise RuntimeError("Kimi (NVIDIA) returned an empty answer. Try again, or check KIMI_MODEL / KIMI_TEMPERATURE.")
    return Reply(text, in_tok, out_tok)


def ask(messages: list[dict], system: str = SYSTEM_PROMPT) -> str:
    """Stream a response from Kimi (NVIDIA) to stdout and return the full text."""
    reply = generate(messages, system, on_text=lambda t: print(t, end="", flush=True))
    print()
    return reply.text
