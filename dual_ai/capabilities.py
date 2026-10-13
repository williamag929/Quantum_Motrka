"""Live inventory of what Motkra can do right now (Phase 24A — the brain's self-model).

Reports which lanes are usable (enabled in the daemon settings AND configured: API key
present, or Ollama reachable with models), which optional features are on, and renders a
one-line honest summary that session.py appends to the cloud system prompt — so Motkra
answers "what can you do?" from reality, not from a hard-coded paragraph.

Daemon-side tools (files, console, browser) are owned by the Electron app and merged
into the registry there (24A-3). The registry is cached for a few seconds: it is read
on every cloud turn and polling Ollama is not free.
"""

import importlib.util
import json
import os
import time
import urllib.request
from pathlib import Path
from typing import Optional

from config import CLAUDE_MODEL, GEMMA_MODEL, KIMI_MODEL, VOICE_REPLY

MOTKRA_DIR = Path(os.getenv("MOTKRA_DIR", str(Path.home() / ".motkra")))
SETTINGS = MOTKRA_DIR / "settings.json"
OLLAMA_TAGS = "http://127.0.0.1:11434/api/tags"

_TTL = 30.0  # seconds
_cache: Optional[tuple[float, dict]] = None


def _settings() -> dict:
    """Daemon settings (~/.motkra/settings.json): per-lane on/off switches."""
    try:
        return json.loads(SETTINGS.read_text("utf8"))
    except Exception:
        return {}


def _ollama_models(timeout: float = 1.0) -> Optional[list]:
    """Model tags when Ollama is reachable, None when it is not."""
    try:
        with urllib.request.urlopen(OLLAMA_TAGS, timeout=timeout) as res:
            return sorted(m.get("name", "") for m in json.load(res).get("models", []))
    except Exception:
        return None


def _model_present(models: Optional[list], wanted: str) -> bool:
    if models is None:
        return False
    base = wanted.split(":")[0]
    return any(m == wanted or m.split(":")[0] == base for m in models)


def registry(now: Optional[float] = None) -> dict:
    """The capability registry, cached for _TTL seconds (read on every cloud turn)."""
    global _cache
    now = time.monotonic() if now is None else now
    if _cache and now - _cache[0] < _TTL:
        return _cache[1]

    enabled = _settings().get("providers", {})
    models = _ollama_models()
    lanes = {
        "local": {
            "enabled": bool(enabled.get("local", True)),
            "available": models is not None,
            "model": GEMMA_MODEL,
            "model_present": _model_present(models, GEMMA_MODEL),
            "models": models or [],
            "needs": "" if models is not None else "start Ollama",
        },
        "cloud": {
            "enabled": bool(enabled.get("claude", True)),
            "available": bool(os.getenv("ANTHROPIC_API_KEY")),
            "model": CLAUDE_MODEL,
            "needs": "" if os.getenv("ANTHROPIC_API_KEY") else "add an Anthropic API key in Settings",
        },
        "kimi": {
            "enabled": bool(enabled.get("nvidia", True)),
            "available": bool(os.getenv("NVIDIA_API_KEY")),
            "model": KIMI_MODEL,
            "needs": "" if os.getenv("NVIDIA_API_KEY") else "add an NVIDIA API key in Settings",
        },
    }
    features = {
        "voice": bool(VOICE_REPLY and importlib.util.find_spec("faster_whisper") is not None),
        "email": os.getenv("MOTKRA_EMAIL_ENABLED", "").lower() in ("1", "true", "on"),
        "memory": (MOTKRA_DIR / "memory.json").exists(),
    }
    reg = {"name": "Motkra", "lanes": lanes, "features": features}
    _cache = (now, reg)
    return reg


def ready_lanes(reg: dict) -> list:
    return [k for k, v in reg["lanes"].items() if v["enabled"] and v["available"]]


def prompt_line(reg: Optional[dict] = None) -> str:
    """One honest sentence for the cloud system prompt: what works now, what needs setup."""
    reg = registry() if reg is None else reg
    parts = []
    ready = ready_lanes(reg)
    if ready:
        parts.append("lanes ready: " + ", ".join(f"{k} ({reg['lanes'][k]['model']})" for k in ready))
    on = [k for k, v in reg["features"].items() if v]
    if on:
        parts.append("features on: " + ", ".join(on))
    missing = [f"{k} ({v['needs']})" for k, v in reg["lanes"].items()
               if v["enabled"] and not v["available"] and v["needs"]]
    if missing:
        parts.append("not usable yet: " + ", ".join(missing))
    disabled = [k for k, v in reg["lanes"].items() if not v["enabled"]]
    if disabled:
        parts.append("turned off by the user: " + ", ".join(disabled))
    return ("Right now on this machine — " + "; ".join(parts) + ".") if parts else ""
