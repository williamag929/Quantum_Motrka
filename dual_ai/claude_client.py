from typing import Callable, Optional

import anthropic

from config import CLAUDE_MODEL, SYSTEM_PROMPT
from reply import Reply

_client = anthropic.Anthropic()


def generate(
    messages: list[dict],
    system: str = SYSTEM_PROMPT,
    on_text: Optional[Callable[[str], None]] = None,
    effort: str = "high",
    max_tokens: int = 16000,
) -> Reply:
    with _client.messages.stream(
        model=CLAUDE_MODEL,
        max_tokens=max_tokens,
        thinking={"type": "adaptive"},
        output_config={"effort": effort},
        system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
        messages=messages,
    ) as stream:
        for text in stream.text_stream:
            if on_text:
                on_text(text)
        final = stream.get_final_message()

    if final.stop_reason == "refusal":
        raise RuntimeError("Claude declined this request (stop_reason=refusal).")

    text = "".join(b.text for b in final.content if b.type == "text")
    u = final.usage
    input_tokens = u.input_tokens + (u.cache_read_input_tokens or 0) + (u.cache_creation_input_tokens or 0)
    return Reply(text, input_tokens, u.output_tokens)


def ask(messages: list[dict], system: str = SYSTEM_PROMPT) -> str:
    """Stream a response from Claude to stdout and return the full text."""
    reply = generate(messages, system, on_text=lambda t: print(t, end="", flush=True))
    print()
    return reply.text
