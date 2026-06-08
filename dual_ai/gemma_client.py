import ollama
from config import GEMMA_MODEL, SYSTEM_PROMPT


def ask(messages: list[dict], system: str = SYSTEM_PROMPT) -> str:
    """Stream a response from Gemma 4 via Ollama (local, no API key needed)."""
    # Ollama expects the system prompt as a leading system message
    ollama_messages = [{"role": "system", "content": system}] + messages

    full_text = ""
    stream = ollama.chat(
        model=GEMMA_MODEL,
        messages=ollama_messages,
        stream=True,
    )
    for chunk in stream:
        text = chunk.message.content
        print(text, end="", flush=True)
        full_text += text

    print()  # newline after streaming ends
    return full_text
