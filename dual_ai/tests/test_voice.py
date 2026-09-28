from voice import SentenceBuffer, speakable


def stream(text: str, size: int = 3) -> list[str]:
    buf = SentenceBuffer()
    out = []
    for i in range(0, len(text), size):
        out += buf.feed(text[i:i + size])
    return out + buf.flush()


def test_sentences_come_out_as_they_complete():
    buf = SentenceBuffer()
    assert buf.feed("La capital de Francia es París. Tiene") == ["La capital de Francia es París."]
    assert buf.flush() == ["Tiene"]


def test_short_fragments_are_joined():
    assert stream("Sí. Claro que puedo ayudarte con eso.") == ["Sí. Claro que puedo ayudarte con eso."]


def test_code_blocks_are_not_read_aloud():
    text = "Usa esta función:\n```python\ndef f():\n    return 1\n```\nY listo, eso es todo."
    spoken = " ".join(stream(text))
    assert "def" not in spoken and "return" not in spoken
    assert "Usa esta función" in spoken and "listo" in spoken


def test_decimals_and_times_do_not_split():
    assert stream("Son las 10:30 y cuesta 4.50 euros hoy.") == ["Son las 10:30 y cuesta 4.50 euros hoy."]


def test_speakable_strips_markdown_and_links():
    assert speakable("## Pasos\n- Abre **config** con `nano` en [la guía](https://x.io)") == \
        "Pasos Abre config con nano en la guía"


def test_symbol_only_output_is_dropped():
    assert stream("---\n***\n") == []
