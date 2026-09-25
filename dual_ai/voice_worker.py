"""
Voice worker for the Electron app: continuous local speech-to-text (faster-whisper) and
text-to-speech (Piper, or the built-in Windows voice).

motkra-daemon spawns `python voice_worker.py` once and keeps it running, so Whisper stays
loaded between turns. Nothing leaves the machine. It talks JSON lines:

    stdin   {"cmd": "listen"}            start the microphone; utterances become transcripts
            {"cmd": "stop"}              stop the microphone (what was being said is still transcribed)
            {"cmd": "speak", "text": s}  speak a reply sentence by sentence (replaces what is playing)
            {"cmd": "hush"}              stop speaking
            {"cmd": "quit"}
    stdout  {"event": "ready", "stt": model, "language": code}   Whisper is loaded
            {"event": "transcript", "text": s}
            {"event": "listening", "on": bool}
            {"event": "speaking", "on": bool}
            {"event": "error", "message": s}

While Motkra speaks the microphone is ignored, so it does not transcribe its own voice.
"""

import json
import logging
import os
import queue
import sys
import threading
import time
from typing import Callable

from config import VOICE_LANGUAGE, VOICE_STT_MODEL
from voice import SAMPLE_RATE, SentenceBuffer, Speaker, Transcriber

log = logging.getLogger("motkra")

BLOCK = SAMPLE_RATE * 30 // 1000   # 30 ms microphone blocks
ECHO_GUARD = 0.4                   # seconds of microphone ignored after speech stops

# Phrases Whisper invents on silence or noise (subtitle credits from its training data)
_HALLUCINATIONS = ("amara.org", "subtítulos realizados por", "subtitles by")


class Segmenter:
    """Cuts a continuous microphone stream into utterances with a simple energy gate.

    The gate only has to decide where speech starts and ends; Whisper's own VAD filter
    removes whatever noise still gets through.
    """

    def __init__(self, rate: int = SAMPLE_RATE, silence_ms: int = 700, min_speech_ms: int = 250,
                 max_seconds: float = 15, pre_roll_ms: int = 300, floor: float = 0.01) -> None:
        self.silence = rate * silence_ms // 1000
        self.min_speech = rate * min_speech_ms // 1000
        self.max_len = int(rate * max_seconds)
        self.pre_roll = rate * pre_roll_ms // 1000
        self.floor = floor
        self.noise = 0.0  # running estimate of the background level
        self.reset()

    def reset(self) -> None:
        """Drop any partial utterance (the noise estimate is kept)."""
        self._pre: list = []
        self._chunks: list = []
        self._len = self._voiced = self._quiet = 0
        self._speech = False

    def feed(self, block) -> list:
        """Add one block of float32 samples; returns the utterances it completed."""
        import numpy as np

        rms = float(np.sqrt(np.mean(np.square(block)))) if len(block) else 0.0
        loud = rms > max(self.floor, self.noise * 3)
        # the background estimate falls fast and rises slowly: pauses between words pull it
        # back down, while a steady fan or hum lifts it within ~10 s
        self.noise += (rms - self.noise) * (0.1 if rms < self.noise else 0.001)
        if not self._speech:
            if not loud:
                self._pre.append(block)
                while sum(len(b) for b in self._pre) > self.pre_roll:
                    self._pre.pop(0)
                return []
            self._speech = True
            self._chunks, self._pre = self._pre + [block], []  # keep the soft start of the word
            self._len = sum(len(b) for b in self._chunks)
            self._voiced, self._quiet = len(block), 0
            return []
        self._chunks.append(block)
        self._len += len(block)
        if loud:
            self._voiced += len(block)
            self._quiet = 0
        else:
            self._quiet += len(block)
        if self._quiet >= self.silence or self._len >= self.max_len:
            return self.flush()
        return []

    def flush(self) -> list:
        """End the current utterance now (e.g. the user turned the microphone off)."""
        import numpy as np

        done = [np.concatenate(self._chunks)] if self._speech and self._voiced >= self.min_speech else []
        self.reset()
        return done


def is_hallucination(text: str) -> bool:
    low = text.lower()
    return any(h in low for h in _HALLUCINATIONS)


class VoiceWorker:
    def __init__(self, emit: Callable[..., None], transcriber=None, speaker=None) -> None:
        self.emit = emit
        self.transcriber = transcriber or Transcriber()
        self.speaker = speaker or Speaker(on_idle=self._spoken)
        self.segmenter = Segmenter()
        self._stream = None
        self._speaking = False
        self._mute_until = 0.0
        self._utterances: "queue.Queue" = queue.Queue()
        threading.Thread(target=self._transcribe_loop, name="motkra-stt", daemon=True).start()

    # ── Listening ─────────────────────────────────────────────────────────

    def listen(self) -> None:
        if self._stream is not None:
            return
        import sounddevice as sd

        self.segmenter.reset()
        self._stream = sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32", blocksize=BLOCK,
                                      callback=self._on_audio)
        self._stream.start()
        self.emit("listening", on=True)

    def stop_listening(self) -> None:
        if self._stream is None:
            return
        self._stream.stop()
        self._stream.close()
        self._stream = None
        for utterance in self.segmenter.flush():
            self._utterances.put(utterance)
        self.emit("listening", on=False)

    def _on_audio(self, indata, frames, time_info, status) -> None:
        if self._speaking or time.monotonic() < self._mute_until:
            self.segmenter.reset()  # that is our own voice coming back through the mic
            return
        for utterance in self.segmenter.feed(indata[:, 0].copy()):
            self._utterances.put(utterance)

    def _transcribe_loop(self) -> None:
        while True:
            audio = self._utterances.get()
            try:
                text = self.transcriber.transcribe(audio)
            except Exception as exc:
                log.exception("transcription failed")
                self.emit("error", message=f"transcription failed: {exc}")
                continue
            if text and not is_hallucination(text):
                self.emit("transcript", text=text)

    # ── Speaking ──────────────────────────────────────────────────────────

    def speak(self, text: str) -> None:
        self.hush()
        buf = SentenceBuffer()
        sentences = buf.feed(text) + buf.flush()
        if not sentences:
            return
        # queue first: an idle callback left over from the interrupted reply then sees a busy queue
        for sentence in sentences:
            self.speaker.say(sentence)
        self._speaking = True
        self.emit("speaking", on=True)

    def hush(self) -> None:
        if self._speaking:
            self.speaker.stop()
            self._spoken()

    def _spoken(self) -> None:
        if self._speaking:
            self._speaking = False
            self._mute_until = time.monotonic() + ECHO_GUARD
            self.emit("speaking", on=False)

    # ── Commands ──────────────────────────────────────────────────────────

    def handle(self, command: dict) -> bool:
        """Run one command; returns False when the worker should exit."""
        cmd = command.get("cmd")
        if cmd == "listen":
            self.listen()
        elif cmd == "stop":
            self.stop_listening()
        elif cmd == "speak":
            self.speak(str(command.get("text", "")))
        elif cmd == "hush":
            self.hush()
        elif cmd == "quit":
            return False
        else:
            self.emit("error", message=f"unknown command: {cmd!r}")
        return True


def command_lines():
    """Yields the lines Electron writes to stdin until it closes the pipe.

    On Windows a thread blocked reading a pipe stalls every DLL load in the process (each
    DLL's C runtime checks the standard handles as it starts), which froze Whisper's
    warm-up. So when stdin is a pipe, poll it and only read what is already there.
    """
    if os.name != "nt":
        yield from sys.stdin
        return
    import ctypes
    import msvcrt
    from ctypes import wintypes

    kernel32 = ctypes.windll.kernel32
    fd = sys.stdin.fileno()
    handle = msvcrt.get_osfhandle(fd)
    if kernel32.GetFileType(handle) != 3:  # FILE_TYPE_PIPE; a console is read normally
        yield from sys.stdin
        return
    available = wintypes.DWORD()
    buf = b""
    while kernel32.PeekNamedPipe(handle, None, 0, None, ctypes.byref(available), None):  # fails once closed
        if not available.value:
            time.sleep(0.05)
            continue
        chunk = os.read(fd, available.value)
        if not chunk:
            break
        *lines, buf = (buf + chunk).split(b"\n")
        for line in lines:
            yield line.decode("utf-8", "replace")


def main() -> None:
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(levelname)s %(message)s")
    out_lock = threading.Lock()

    def emit(event: str, **data) -> None:
        with out_lock:
            sys.stdout.write(json.dumps({"event": event, **data}, ensure_ascii=False) + "\n")
            sys.stdout.flush()

    worker = VoiceWorker(emit)

    def warm_up() -> None:
        try:
            worker.transcriber.load()  # downloads the model on first run
            emit("ready", stt=VOICE_STT_MODEL, language=VOICE_LANGUAGE or "auto")
        except Exception as exc:
            emit("error", message=f"could not load Whisper: {exc}")
            os._exit(1)  # the app falls back to Windows speech recognition

    threading.Thread(target=warm_up, daemon=True).start()

    for line in command_lines():  # Electron closing our stdin also ends the worker
        line = line.strip().lstrip("﻿")
        if not line:
            continue
        try:
            command = json.loads(line)
            if not isinstance(command, dict):
                raise ValueError("expected a JSON object")
            if not worker.handle(command):
                break
        except Exception as exc:
            log.exception("command failed")
            emit("error", message=str(exc))
    worker.stop_listening()
    worker.hush()


if __name__ == "__main__":
    main()
