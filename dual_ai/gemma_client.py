from typing import Callable, Optional

import ollama

from config import GEMMA_MODEL, LOCAL_SYSTEM_PROMPT, LOCAL_THINK
from reply import Reply
from router import quick_answer


def should_think(messages: list[dict], mode: str = LOCAL_THINK) -> bool:
    """Resolve the local reasoning mode ('auto', 'on', 'off') for the latest user message."""
    if mode != "auto":
        return mode == "on"
    last = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
    return not quick_answer(last)


def generate(
    messages: list[dict],
    system: str = LOCAL_SYSTEM_PROMPT,
    on_text: Optional[Callable[[str], None]] = None,
    model: str = GEMMA_MODEL,
    think: Optional[bool] = None,
) -> Reply:
    stream = ollama.chat(
        model=model,
        messages=[{"role": "system", "content": system}] + messages,
        stream=True,
        think=should_think(messages) if think is None else think,
    )
    text, in_tok, out_tok = "", 0, 0
    for chunk in stream:
        piece = chunk.message.content or ""
        if piece and on_text:
            on_text(piece)
        text += piece
        if chunk.done:
            in_tok = chunk.prompt_eval_count or 0
            out_tok = chunk.eval_count or 0
    return Reply(text, in_tok, out_tok)


def ask(messages: list[dict], system: str = LOCAL_SYSTEM_PROMPT) -> str:
    """Stream a response from Gemma via Ollama to stdout and return the full text."""
    reply = generate(messages, system, on_text=lambda t: print(t, end="", flush=True))
    print()
    return reply.text
