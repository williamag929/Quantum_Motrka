"""Local voice for the Motkra daemon: microphone capture, speech-to-text and text-to-speech.

Everything runs on this machine: faster-whisper transcribes, Piper (or the built-in
Windows voice as a fallback) speaks. Replies are spoken sentence by sentence while
they stream in, so the first words play before the model has finished.

Heavy imports (numpy, sounddevice, faster_whisper, piper) happen lazily so the pure
text helpers here can be imported and tested without the voice extras installed.
"""

import logging
import os
import queue
import re
import tempfile
import threading
import wave
from pathlib import Path
from typing import Callable, Optional

from config import PIPER_VOICE, VOICE_LANGUAGE, VOICE_STT_MODEL

log = logging.getLogger("motkra")

SAMPLE_RATE = 16_000   # what Whisper expects
MAX_RECORD_SECONDS = 30
VOICES_DIR = Path.home() / ".motkra" / "voices"

_SENTENCE_END = re.compile(r"[.!?…;:](?=\s)|\n")
_FENCE = "```"
_MIN_SENTENCE = 12     # join very short fragments ("Sí.") with the next one


def speakable(text: str) -> str:
    """Strip markdown and links so the voice reads words, not symbols."""
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"https?://\S+", "", text)
    text = re.sub(r"^\s*(#+|[-*+]|\d+\.)\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"[*_#>|~]", "", text)
    return re.sub(r"\s+", " ", text).strip()


class SentenceBuffer:
    """Turns streamed text into speakable sentences. Code blocks are skipped, not read aloud."""

    def __init__(self) -> None:
        self._buf = ""
        self._in_code = False

    def feed(self, text: str) -> list[str]:
        self._buf += text
        out: list[str] = []
        while True:
            if self._in_code:
                end = self._buf.find(_FENCE)
                if end < 0:
                    # keep a possible partial fence, drop the rest of the code
                    self._buf = self._buf[-(len(_FENCE) - 1):]
                    return out
                self._buf = self._buf[end + len(_FENCE):]
                self._in_code = False
                continue
            fence = self._buf.find(_FENCE)
            match = _SENTENCE_END.search(self._buf)
            cut = match.end() if match else -1
            while match and cut < _MIN_SENTENCE and (fence < 0 or cut < fence):
                match = _SENTENCE_END.search(self._buf, cut)
                cut = match.end() if match else -1
            if fence >= 0 and (cut < 0 or fence < cut):
                self._add(out, self._buf[:fence])
                self._buf = self._buf[fence + len(_FENCE):]
                self._in_code = True
                continue
            if cut < 0:
                return out
            self._add(out, self._buf[:cut])
            self._buf = self._buf[cut:]

    def flush(self) -> list[str]:
        out: list[str] = []
        if not self._in_code:
            self._add(out, self._buf)
        self._buf, self._in_code = "", False
        return out

    @staticmethod
    def _add(out: list[str], text: str) -> None:
        text = speakable(text)
        if any(c.isalnum() for c in text):
            out.append(text)


class Recorder:
    """Captures mono 16 kHz audio from the default microphone between start() and stop()."""

    def __init__(self) -> None:
        self._chunks: list = []
        self._stream = None

    @property
    def recording(self) -> bool:
        return self._stream is not None

    def start(self) -> None:
        import sounddevice as sd

        self._chunks = []
        limit = SAMPLE_RATE * MAX_RECORD_SECONDS

        def callback(indata, frames, time_info, status) -> None:
            if sum(len(c) for c in self._chunks) < limit:
                self._chunks.append(indata[:, 0].copy())

        self._stream = sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32", callback=callback)
        self._stream.start()

    def stop(self):
        """Stop recording and return the audio as a float32 numpy array (may be empty)."""
        import numpy as np

        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None
        return np.concatenate(self._chunks) if self._chunks else np.zeros(0, dtype="float32")


class Transcriber:
    """faster-whisper on CPU. The model downloads on first use and then stays in memory."""

    def __init__(self, model: str = VOICE_STT_MODEL, language: str = VOICE_LANGUAGE) -> None:
        self._model_name = model
        self._language = language or None  # None = auto-detect
        self._model = None
        self._lock = threading.Lock()

    def load(self) -> None:
        with self._lock:
            if self._model is None:
                from faster_whisper import WhisperModel

                self._model = WhisperModel(self._model_name, device="cpu", compute_type="int8")

    def transcribe(self, audio) -> str:
        if len(audio) < SAMPLE_RATE // 4:  # under 0.25 s: a tap, not speech
            return ""
        self.load()
        segments, _ = self._model.transcribe(audio, language=self._language, vad_filter=True, beam_size=1,
                                                initial_prompt="Motkra")  # spell the name right
        return " ".join(s.text.strip() for s in segments).strip()


class _PiperVoice:
    def __init__(self, model_path: str) -> None:
        from piper import PiperVoice

        self._voice = PiperVoice.load(model_path)

    def synth(self, text: str):
        import numpy as np

        chunks = list(self._voice.synthesize(text))
        if not chunks:
            return np.zeros(0, dtype="int16"), 22_050
        return np.concatenate([c.audio_int16_array for c in chunks]), chunks[0].sample_rate


class _WindowsVoice:
    """Built-in SAPI voice through pyttsx3, rendered to a temp file so playback can be interrupted."""

    def __init__(self) -> None:
        import pyttsx3

        self._engine = pyttsx3.init()
        if VOICE_LANGUAGE:
            for v in self._engine.getProperty("voices"):
                langs = " ".join(str(x) for x in (v.languages or [])) + " " + (v.name or "") + " " + v.id
                if VOICE_LANGUAGE.lower() in langs.lower() or _LANG_NAMES.get(VOICE_LANGUAGE, "~") in langs:
                    self._engine.setProperty("voice", v.id)
                    break

    def synth(self, text: str):
        import numpy as np

        fd, path = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        try:
            self._engine.save_to_file(text, path)
            self._engine.runAndWait()
            with wave.open(path, "rb") as w:
                rate, width, channels = w.getframerate(), w.getsampwidth(), w.getnchannels()
                data = np.frombuffer(w.readframes(w.getnframes()), dtype="int16" if width == 2 else "uint8")
            if channels > 1:
                data = data.reshape(-1, channels)[:, 0]
            return data, rate
        finally:
            Path(path).unlink(missing_ok=True)


def find_piper_voice() -> Optional[Path]:
    """PIPER_VOICE if set, else the first voice downloaded into ~/.motkra/voices."""
    if PIPER_VOICE:
        return Path(PIPER_VOICE) if Path(PIPER_VOICE).is_file() else None
    return next(iter(sorted(VOICES_DIR.glob("*.onnx"))), None)


_LANG_NAMES = {"es": "Spanish", "en": "English", "pt": "Portuguese", "fr": "French"}


class Speaker:
    """Speaks queued sentences on a worker thread. stop() interrupts and drops what is queued."""

    def __init__(self, on_idle: Optional[Callable[[], None]] = None) -> None:
        self._on_idle = on_idle  # called when the last queued sentence has finished playing
        self._queue: "queue.Queue[tuple[int, str]]" = queue.Queue()
        self._generation = 0  # bumped by stop(); stale sentences are skipped
        self._backend = None
        self.backend_name = ""
        self._thread = threading.Thread(target=self._run, name="motkra-tts", daemon=True)
        self._thread.start()

    def say(self, text: str) -> None:
        self._queue.put((self._generation, text))

    def stop(self) -> None:
        import sounddevice as sd

        self._generation += 1
        try:
            while True:
                self._queue.get_nowait()
        except queue.Empty:
            pass
        sd.stop()

    def _load(self) -> None:
        piper_voice = find_piper_voice()
        if piper_voice:
            self._backend, self.backend_name = _PiperVoice(str(piper_voice)), "piper"
        else:
            self._backend, self.backend_name = _WindowsVoice(), "windows"

    def _run(self) -> None:
        import sounddevice as sd

        self._load()  # the SAPI engine must live on the thread that uses it
        while True:
            gen, text = self._queue.get()
            if gen != self._generation:
                continue
            try:
                audio, rate = self._backend.synth(text)
                if gen == self._generation and len(audio):
                    sd.play(audio, rate)
                    sd.wait()
            except Exception as exc:  # a bad sentence must not kill the voice
                log.warning("could not speak: %s", exc)
            if self._queue.empty() and self._on_idle:
                self._on_idle()
