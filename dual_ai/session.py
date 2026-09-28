"""One Motkra conversation: routing, redaction, private turns and stats.

Shared by the CLI (main.py) and the desktop daemon (daemon.py) so both apply the
same privacy rules: cloud payloads are always redacted and never include private
turns, and once a conversation has a private turn, auto mode keeps it local.
"""

import os
import threading
from dataclasses import dataclass
from typing import Callable, Optional

import claude_client
import gemma_client
import kimi_client
from config import CLAUDE_MODEL, GEMMA_MODEL, KIMI_MODEL, LOCAL_SYSTEM_PROMPT, PERSONAL_SYSTEM_PROMPT, SYSTEM_PROMPT
from privacy import REDACTION_NOTE, StreamRestorer, redact, restore
from router import Decision, looks_personal, smart_route
from stats import Stats

MODES = ("auto", "local", "cloud", "kimi")
CLIENTS = {"local": gemma_client, "cloud": claude_client, "kimi": kimi_client}
MODEL_LABEL = {
    "local": f"Gemma  {GEMMA_MODEL} (local)",
    "cloud": f"Claude {CLAUDE_MODEL}",
    "kimi": f"Kimi   {KIMI_MODEL}",
}
ALIASES = {"ollama": "local", "claude": "cloud"}


def normalize_mode(mode: str) -> Optional[str]:
    mode = ALIASES.get(mode.lower().strip(), mode.lower().strip())
    return mode if mode in MODES else None


def default_mode() -> str:
    return normalize_mode(os.getenv("DEFAULT_MODE", "auto")) or "auto"


def decide(mode: str, message: str, history: list[dict], secrets: dict[str, str]) -> Decision:
    if mode != "auto":
        return Decision(mode, "forced")
    if any(m.get("private") for m in history):
        return Decision("local", "private conversation", private=True)
    return smart_route(message, secrets)


def payload(history: list[dict], target: str, secrets: dict[str, str]) -> list[dict]:
    """Messages for the target model. Cloud models never see private turns or raw secrets."""
    if target == "local":
        return [{"role": m["role"], "content": m["content"]} for m in history]
    return [
        {"role": m["role"], "content": redact(m["content"], secrets)[0]}
        for m in history
        if not m.get("private")
    ]


def route_reason(decision: Decision, redacted: bool) -> str:
    """Label shown next to the model name ("" when the mode was forced)."""
    reason = "" if decision.reason == "forced" else decision.reason
    if redacted and "redacted" not in reason:
        reason = f"{reason}, secrets redacted" if reason else "secrets redacted"
    return reason


def system_prompt(decision: Decision, messages: list[dict], secrets: dict[str, str]) -> str:
    if decision.target == "local":
        return PERSONAL_SYSTEM_PROMPT if decision.private else LOCAL_SYSTEM_PROMPT
    has_placeholders = any(p in m["content"] for m in messages for p in secrets)
    return SYSTEM_PROMPT + (REDACTION_NOTE if has_placeholders else "")


def plan(mode: str, messages: list[dict]) -> dict:
    """Stateless routing for callers that keep their own history (the Electron daemon).

    `messages` ends with the new user message. Earlier turns may carry "private"; when it
    is missing, a user turn counts as private if it looks personal and its reply inherits
    that. Returns the target, the payload to send (redacted, without private turns, for
    cloud targets), the system prompt and the placeholder mapping to restore the reply.
    """
    *prior, last = messages
    history, private = [], False
    for m in prior:
        if m["role"] == "user":
            private = bool(m["private"]) if "private" in m else looks_personal(m["content"])
        history.append({"role": m["role"], "content": m["content"], "private": bool(m.get("private", private))})
    secrets: dict[str, str] = {}
    for m in history:
        redact(m["content"], secrets)  # same placeholders a live Session would have assigned
    text = last["content"]
    decision = decide(mode, text, history, secrets)
    history.append({"role": "user", "content": text, "private": decision.private})
    out = payload(history, decision.target, secrets)
    redacted = decision.target != "local" and out[-1]["content"] != text
    system = system_prompt(decision, out, secrets)
    return {
        "target": decision.target,
        "reason": route_reason(decision, redacted),
        "private": decision.private,
        "redacted": redacted,
        "messages": out,
        "system": system,
        "redaction_note": REDACTION_NOTE if system.endswith(REDACTION_NOTE) else "",
        "think": gemma_client.should_think(out) if decision.target == "local" else None,
        "secrets": secrets,
    }


@dataclass
class Turn:
    decision: Decision
    reason: str      # label to show next to the model name ("" when forced)
    redacted: bool   # the cloud model received placeholders instead of secrets
    text: str        # reply with secrets restored


class Session:
    def __init__(self, mode: Optional[str] = None, stats: Optional[Stats] = None) -> None:
        self.mode = mode or default_mode()
        self.history: list[dict] = []
        self.secrets: dict[str, str] = {}  # placeholder → secret, kept for the whole session
        self.stats = stats or Stats()
        self._lock = threading.Lock()  # the daemon serves several callers

    def clear(self) -> None:
        with self._lock:
            self.history.clear()
            self.secrets.clear()

    def ask(
        self,
        text: str,
        on_start: Optional[Callable[[Turn], None]] = None,
        on_text: Optional[Callable[[str], None]] = None,
    ) -> Turn:
        """Route, send and record one user message. On error the message is dropped from history."""
        with self._lock:
            decision = decide(self.mode, text, self.history, self.secrets)
            self.history.append({"role": "user", "content": text, "private": decision.private})
            messages = payload(self.history, decision.target, self.secrets)
            redacted = decision.target != "local" and messages[-1]["content"] != text
            turn = Turn(decision, route_reason(decision, redacted), redacted, "")
            if on_start:
                on_start(turn)
            system = system_prompt(decision, messages, self.secrets)

            restorer = StreamRestorer(self.secrets)

            def emit(piece: str) -> None:
                out = restorer.feed(piece)
                if out and on_text:
                    on_text(out)

            try:
                reply = CLIENTS[decision.target].generate(messages, system=system, on_text=emit)
            except Exception:
                self.history.pop()
                raise

            tail = restorer.flush()
            if tail and on_text:
                on_text(tail)
            turn.text = restore(reply.text, self.secrets)
            self.history.append({"role": "assistant", "content": turn.text, "private": decision.private})
            self.stats.record(decision.target, reply.input_tokens, reply.output_tokens, decision.private, redacted)
            return turn
