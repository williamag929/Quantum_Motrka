import threading

import pytest

np = pytest.importorskip("numpy")

from voice import SAMPLE_RATE
from voice_worker import BLOCK, Segmenter, VoiceWorker, is_hallucination


def blocks(seconds: float, level: float):
    """Microphone blocks of a constant-amplitude signal (0 = silence)."""
    total = int(SAMPLE_RATE * seconds)
    signal = np.full(total, level, dtype="float32")
    return [signal[i:i + BLOCK] for i in range(0, total, BLOCK)]


def run(segmenter: Segmenter, *parts) -> list:
    out = []
    for part in parts:
        for block in part:
            out += segmenter.feed(block)
    return out


def test_speech_between_silences_is_one_utterance():
    utterances = run(Segmenter(), blocks(1, 0.001), blocks(1.5, 0.2), blocks(1, 0.001))
    assert len(utterances) == 1
    seconds = len(utterances[0]) / SAMPLE_RATE
    assert 1.5 < seconds < 2.6  # speech + a little pre-roll + the closing silence


def test_short_pause_does_not_split_a_sentence():
    utterances = run(Segmenter(), blocks(1, 0.001), blocks(1, 0.2), blocks(0.3, 0.001), blocks(1, 0.2),
                     blocks(1, 0.001))
    assert len(utterances) == 1


def test_clicks_are_ignored():
    assert run(Segmenter(), blocks(1, 0.001), blocks(0.06, 0.3), blocks(1, 0.001)) == []


def test_long_speech_is_cut_at_max_length():
    utterances = run(Segmenter(max_seconds=2), blocks(5, 0.2))
    assert len(utterances) == 2


def test_flush_returns_speech_in_progress():
    seg = Segmenter()
    assert run(seg, blocks(1, 0.2)) == []
    assert len(seg.flush()) == 1
    assert seg.flush() == []


def test_background_noise_raises_the_threshold():
    seg = Segmenter()
    run(seg, blocks(20, 0.02))  # a steady fan above the floor: the gate adapts to it
    assert run(seg, blocks(3, 0.02)) == []
    assert len(run(seg, blocks(1, 0.3), blocks(1, 0.02))) == 1


def test_whisper_hallucinations_are_filtered():
    assert is_hallucination("Subtítulos realizados por la comunidad de Amara.org")
    assert not is_hallucination("¿Qué hora es en Bogotá?")


class FakeTranscriber:
    def transcribe(self, audio) -> str:
        return "hola motkra"


class FakeSpeaker:
    def __init__(self) -> None:
        self.said: list[str] = []
        self.stopped = 0

    def say(self, text: str) -> None:
        self.said.append(text)

    def stop(self) -> None:
        self.stopped += 1


def make_worker():
    events = []
    got = threading.Event()

    def emit(event, **data):
        events.append((event, data))
        got.set()

    speaker = FakeSpeaker()
    return VoiceWorker(emit, transcriber=FakeTranscriber(), speaker=speaker), speaker, events, got


def test_speak_queues_sentences_and_skips_code():
    worker, speaker, events, _ = make_worker()
    worker.handle({"cmd": "speak", "text": "Aquí tienes el código.\n```py\nx = 1\n```\nListo, ya funciona."})
    assert speaker.said == ["Aquí tienes el código.", "Listo, ya funciona."]
    assert events == [("speaking", {"on": True})]


def test_new_reply_interrupts_the_old_one():
    worker, speaker, events, _ = make_worker()
    worker.speak("Primera respuesta larga.")
    worker.speak("Segunda respuesta larga.")
    assert speaker.stopped == 1
    assert [e for e, _ in events] == ["speaking", "speaking", "speaking"]  # on, off, on


def test_microphone_is_ignored_while_speaking():
    worker, _, _, _ = make_worker()
    worker.speak("Estoy hablando ahora mismo.")
    for block in blocks(2, 0.3) + blocks(1, 0.001):
        worker._on_audio(block[:, None], len(block), None, None)
    assert worker._utterances.empty()


def test_utterances_become_transcripts():
    worker, _, events, got = make_worker()
    for block in blocks(0.5, 0.001) + blocks(1, 0.3) + blocks(1, 0.001):
        worker._on_audio(block[:, None], len(block), None, None)
    assert got.wait(2)
    assert ("transcript", {"text": "hola motkra"}) in events


def test_unknown_and_quit_commands():
    worker, _, events, _ = make_worker()
    assert worker.handle({"cmd": "dance"}) is True
    assert events[-1][0] == "error"
    assert worker.handle({"cmd": "quit"}) is False
