import anthropic
from config import CLAUDE_MODEL, SYSTEM_PROMPT

_client = anthropic.Anthropic()


def ask(messages: list[dict], system: str = SYSTEM_PROMPT) -> str:
    """Stream a response from Claude with adaptive thinking and prompt caching."""
    full_text = ""

    with _client.messages.stream(
        model=CLAUDE_MODEL,
        max_tokens=16000,
        thinking={"type": "adaptive"},
        output_config={"effort": "high"},
        system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
        messages=messages,
    ) as stream:
        for text in stream.text_stream:
            print(text, end="", flush=True)
            full_text += text

    print()  # newline after streaming ends
    return full_text
