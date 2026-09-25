"""
Motkra desktop daemon: an always-on, local-first assistant in the system tray.

- Global hotkey (DAEMON_HOTKEY, default Ctrl+Shift+Space): press to start talking,
  press again to send. Pressing it while Motkra speaks interrupts the reply.
- Speech is transcribed on this machine (faster-whisper) and replies are spoken
  sentence by sentence (Piper, or the built-in Windows voice).
- Requests go through the same Session as the CLI: secrets are redacted before any
  cloud call and personal requests stay local.
- A localhost JSON API on DAEMON_PORT (default 7433; the Electron app owns 7432):
    GET  /status                      → {"status": "ok", "mode", "state", "voice_reply"}
    POST /ask    {"text", "speak"?}   → {"text", "target", "reason", "private", "redacted"}
    POST /route  {"messages", "mode"?} → routing only, for callers that keep their own history
                                         (the Electron app): {"target", "reason", "private",
                                         "redacted", "messages", "system", "secrets", ...}
    POST /redact {"text", "secrets"?} → {"text", "secrets"}: redact more text (e.g. tool output)
                                         with the same placeholder mapping
    POST /mode   {"mode"}             → {"mode"}
    POST /clear                       → {"cleared": true}

Usage:
    python daemon.py                     # tray + hotkey + voice + API
    python daemon.py --no-voice          # tray + API only
    python daemon.py --headless          # API only, no tray (servers, debugging)
    python daemon.py --install-startup   # start with Windows (no console window)
    python daemon.py --uninstall-startup
"""

import json
import logging
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional

from config import DAEMON_HOTKEY, DAEMON_PORT, GEMMA_MODEL, VOICE_REPLY
from privacy import redact
from session import MODEL_LABEL, MODES, Session, normalize_mode, plan

LOG_FILE = Path.home() / ".motkra" / "daemon.log"
STARTUP_LINK = Path(os.getenv("APPDATA", "")) / "Microsoft/Windows/Start Menu/Programs/Startup/Motkra.lnk"
MAX_BODY = 64 * 1024

log = logging.getLogger("motkra")

STATE_COLORS = {"idle": "#5b6b8c", "listening": "#d64545", "thinking": "#d9a21b", "speaking": "#3a9d5d"}
STATE_LABELS = {"idle": "Listo", "listening": "Escuchando…", "thinking": "Pensando…", "speaking": "Hablando…"}


def allowed_request(method: str, host: Optional[str], origin: Optional[str], content_type: Optional[str],
                    port: int) -> bool:
    """Only local, non-browser callers may use the API.

    A web page can send requests to 127.0.0.1, so: the Host must be localhost (blocks DNS
    rebinding), any Origin header is refused (browsers always send one on cross-site POSTs),
    and POST bodies must be JSON (a cross-site JSON POST needs a CORS preflight we never answer).
    """
    if host not in (f"127.0.0.1:{port}", f"localhost:{port}"):
        return False
    if origin:
        return False
    if method == "POST" and (content_type or "").split(";")[0].strip().lower() != "application/json":
        return False
    return True


class Daemon:
    def __init__(self, voice: bool = True, session: Optional[Session] = None) -> None:
        self.session = session or Session()
        self.voice = voice
        self.voice_reply = VOICE_REPLY and voice
        self.state = "idle"
        self.icon = None
        self._busy = threading.Lock()  # one voice turn at a time
        self.recorder = self.transcriber = self.speaker = None
        if voice:
            from voice import Recorder, Speaker, Transcriber

            self.recorder, self.transcriber = Recorder(), Transcriber()
            self.speaker = Speaker(on_idle=self._speech_done)

    # ── State and tray ────────────────────────────────────────────────────

    def set_state(self, state: str) -> None:
        self.state = state
        if self.icon:
            self.icon.icon = make_icon(STATE_COLORS[state])
            self.icon.title = f"Motkra · {STATE_LABELS[state]} · {self.session.mode}"
            self.icon.update_menu()

    def notify(self, message: str, title: str = "Motkra") -> None:
        log.info("%s: %s", title, message)
        if self.icon:
            try:
                self.icon.notify(message[:250], title)
            except Exception:
                pass

    # ── Asking ────────────────────────────────────────────────────────────

    def ask(self, text: str, speak: bool = False) -> dict:
        from voice import SentenceBuffer

        sentences = SentenceBuffer() if speak and self.speaker else None

        def say(parts: list[str]) -> None:
            for s in parts:
                if self.state != "speaking":
                    self.set_state("speaking")
                self.speaker.say(s)

        def on_text(piece: str) -> None:
            if sentences:
                say(sentences.feed(piece))

        self.set_state("thinking")
        try:
            turn = self.session.ask(text, on_text=on_text)
        finally:
            if sentences:
                say(sentences.flush())
            if self.state == "thinking":
                self.set_state("idle")
        log.info("[%s · %s] %s", turn.decision.target, turn.reason or "forced", turn.text[:200])
        return {
            "text": turn.text,
            "target": turn.decision.target,
            "model": MODEL_LABEL[turn.decision.target].strip(),
            "reason": turn.reason,
            "private": turn.decision.private,
            "redacted": turn.redacted,
        }

    # ── Push-to-talk ──────────────────────────────────────────────────────

    def on_hotkey(self) -> None:
        if not self.voice:
            return
        if self.state == "speaking":
            self.speaker.stop()  # barge-in: cut the reply and listen
            self.set_state("idle")
        if self.recorder.recording:
            threading.Thread(target=self._finish_listening, daemon=True).start()
        elif self._busy.acquire(blocking=False):
            try:
                self.recorder.start()
                self.set_state("listening")
            except Exception as exc:
                self._busy.release()
                self.set_state("idle")
                self.notify(f"No pude abrir el micrófono: {exc}")

    def _finish_listening(self) -> None:
        try:
            audio = self.recorder.stop()
            self.set_state("thinking")
            text = self.transcriber.transcribe(audio)
            if not text:
                self.set_state("idle")
                self.notify(f"No te escuché. Pulsa {DAEMON_HOTKEY}, habla y púlsalo otra vez.")
                return
            self.notify(text, "Tú")
            reply = self.ask(text, speak=self.voice_reply)
            self.notify(reply["text"], f"Motkra · {reply['model']}")
        except Exception as exc:
            log.exception("voice turn failed")
            self.set_state("idle")
            self.notify(f"Error: {exc}")
        finally:
            self._busy.release()

    def _speech_done(self) -> None:
        if self.state == "speaking":
            self.set_state("idle")

    # ── Warm-up ───────────────────────────────────────────────────────────

    def warm_up(self) -> None:
        """Load the local model and Whisper in the background so the first question is fast."""
        try:
            import ollama

            ollama.generate(model=GEMMA_MODEL, prompt="")  # empty prompt = load only
        except Exception as exc:
            log.warning("could not preload %s: %s", GEMMA_MODEL, exc)
        if self.transcriber:
            try:
                self.transcriber.load()
            except Exception as exc:
                log.warning("could not load Whisper: %s", exc)
        log.info("warm-up done")


# ── HTTP API ──────────────────────────────────────────────────────────────────

def make_handler(daemon: Daemon, port: int):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args) -> None:
            log.debug("http %s", fmt % args)

        def _send(self, code: int, data: dict) -> None:
            body = json.dumps(data, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _guard(self) -> bool:
            ok = allowed_request(self.command, self.headers.get("Host"), self.headers.get("Origin"),
                                 self.headers.get("Content-Type"), port)
            if not ok:
                self._send(403, {"error": "forbidden"})
            return ok

        def _json(self) -> Optional[dict]:
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                self._send(413, {"error": "body too large"})
                return None
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                data = None
            if not isinstance(data, dict):
                self._send(400, {"error": "expected a JSON object"})
                return None
            return data

        def do_GET(self) -> None:
            if not self._guard():
                return
            if self.path == "/status":
                self._send(200, {"status": "ok", "mode": daemon.session.mode, "state": daemon.state,
                                 "voice_reply": daemon.voice_reply})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self) -> None:
            if not self._guard():
                return
            data = self._json()
            if data is None:
                return
            if self.path == "/ask":
                text = str(data.get("text", "")).strip()
                if not text:
                    self._send(400, {"error": "text is required"})
                    return
                try:
                    self._send(200, daemon.ask(text, speak=bool(data.get("speak")) and daemon.voice))
                except Exception as exc:
                    log.exception("ask failed")
                    self._send(502, {"error": str(exc)})
            elif self.path == "/route":
                messages = data.get("messages")
                valid = isinstance(messages, list) and messages and all(
                    isinstance(m, dict) and m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str)
                    for m in messages) and messages[-1]["role"] == "user"
                if not valid:
                    self._send(400, {"error": "messages must be a list of {role, content} ending with a user turn"})
                    return
                mode = normalize_mode(str(data.get("mode") or daemon.session.mode)) or "auto"
                self._send(200, plan(mode, messages))
            elif self.path == "/redact":
                secrets = data.get("secrets") or {}
                if not isinstance(data.get("text"), str) or not isinstance(secrets, dict):
                    self._send(400, {"error": "expected {text, secrets?}"})
                    return
                text, secrets = redact(data["text"], {str(k): str(v) for k, v in secrets.items()})
                self._send(200, {"text": text, "secrets": secrets})
            elif self.path == "/mode":
                mode = normalize_mode(str(data.get("mode", "")))
                if not mode:
                    self._send(400, {"error": f"mode must be one of {', '.join(MODES)}"})
                    return
                daemon.session.mode = mode
                daemon.set_state(daemon.state)
                self._send(200, {"mode": mode})
            elif self.path == "/clear":
                daemon.session.clear()
                self._send(200, {"cleared": True})
            else:
                self._send(404, {"error": "not found"})

    return Handler


# ── Tray ──────────────────────────────────────────────────────────────────────

def make_icon(color: str):
    from PIL import Image, ImageDraw

    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.ellipse((2, 2, 62, 62), fill=color)
    draw.line([(18, 46), (18, 18), (32, 34), (46, 18), (46, 46)], fill="white", width=6, joint="curve")
    return img


def run_tray(daemon: Daemon, server: ThreadingHTTPServer) -> None:
    import pystray
    from pystray import Menu, MenuItem as Item

    def set_mode(mode: str):
        def action(icon, item) -> None:
            daemon.session.mode = mode
            daemon.set_state(daemon.state)
        return action

    def toggle_voice_reply(icon, item) -> None:
        daemon.voice_reply = not daemon.voice_reply
        if not daemon.voice_reply and daemon.state == "speaking":
            daemon.speaker.stop()
            daemon.set_state("idle")

    def clear(icon, item) -> None:
        daemon.session.clear()
        daemon.notify("Conversación borrada.")

    def show_stats(icon, item) -> None:
        daemon.notify(daemon.session.stats.summary().replace("  ", " "), "Motkra · estadísticas")

    def quit_(icon, item) -> None:
        server.shutdown()
        icon.stop()

    hotkey_label = DAEMON_HOTKEY.replace("+", " + ").title()
    menu = Menu(
        Item(lambda item: f"Motkra · {STATE_LABELS[daemon.state]}", None, enabled=False),
        Item(f"Hablar ({hotkey_label})", lambda icon, item: daemon.on_hotkey(), default=True,
             visible=daemon.voice),
        Menu.SEPARATOR,
        Item("Modo", Menu(*[
            Item(m, set_mode(m), checked=lambda item, m=m: daemon.session.mode == m, radio=True) for m in MODES
        ])),
        Item("Responder en voz alta", toggle_voice_reply, checked=lambda item: daemon.voice_reply,
             visible=daemon.voice),
        Item("Borrar conversación", clear),
        Item("Estadísticas", show_stats),
        Menu.SEPARATOR,
        Item("Salir", quit_),
    )
    daemon.icon = pystray.Icon("motkra", make_icon(STATE_COLORS["idle"]), "Motkra", menu)
    daemon.set_state("idle")
    daemon.icon.run()


# ── Startup with Windows ──────────────────────────────────────────────────────

def install_startup() -> None:
    import win32com.client

    pythonw = Path(sys.executable).with_name("pythonw.exe")
    link = win32com.client.Dispatch("WScript.Shell").CreateShortcut(str(STARTUP_LINK))
    link.TargetPath = str(pythonw if pythonw.exists() else sys.executable)
    link.Arguments = f'"{Path(__file__).resolve()}"'
    link.WorkingDirectory = str(Path(__file__).resolve().parent)
    link.Description = "Motkra desktop assistant"
    link.save()
    print(f"Motkra will start with Windows: {STARTUP_LINK}")


def uninstall_startup() -> None:
    STARTUP_LINK.unlink(missing_ok=True)
    print("Motkra will no longer start with Windows.")


# ── Main ──────────────────────────────────────────────────────────────────────

def setup_logging() -> None:
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    handlers: list[logging.Handler] = [logging.FileHandler(LOG_FILE, encoding="utf-8")]
    if sys.stdout is not None:  # pythonw has no console
        handlers.append(logging.StreamHandler(sys.stdout))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", handlers=handlers)


def main() -> None:
    if "--install-startup" in sys.argv:
        return install_startup()
    if "--uninstall-startup" in sys.argv:
        return uninstall_startup()

    setup_logging()
    headless = "--headless" in sys.argv
    voice = not headless and "--no-voice" not in sys.argv

    daemon = Daemon(voice=voice)
    try:
        server = ThreadingHTTPServer(("127.0.0.1", DAEMON_PORT), make_handler(daemon, DAEMON_PORT))
    except OSError:
        log.error("Port %d is in use: Motkra is probably already running.", DAEMON_PORT)
        sys.exit(1)
    log.info("Motkra daemon on http://127.0.0.1:%d (mode %s, voice %s)", DAEMON_PORT, daemon.session.mode,
             "on" if voice else "off")
    threading.Thread(target=daemon.warm_up, daemon=True).start()

    if voice:
        import keyboard

        keyboard.add_hotkey(DAEMON_HOTKEY, daemon.on_hotkey)
        log.info("Push-to-talk: %s", DAEMON_HOTKEY)

    if headless:
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        return

    threading.Thread(target=server.serve_forever, daemon=True).start()
    run_tray(daemon, server)


if __name__ == "__main__":
    main()
