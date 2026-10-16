import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).with_name(".env"))

CLAUDE_MODEL = os.getenv("CLAUDE_MODEL", "claude-opus-5-5")
GEMMA_MODEL = os.getenv("GEMMA_MODEL", "gemma4:e2b")
KIMI_MODEL = os.getenv("KIMI_MODEL", "moonshotai/kimi-k3")
# NVIDIA's Kimi K3 returns gibberish at temperature 1.0; 0.6 / 0.95 gives normal answers.
KIMI_TEMPERATURE = float(os.getenv("KIMI_TEMPERATURE", "0.6"))
KIMI_TOP_P = float(os.getenv("KIMI_TOP_P", "0.95"))

# Only Claude is billed per token here; used for savings estimates. USD per 1M tokens.
CLAUDE_PRICE_IN = float(os.getenv("CLAUDE_PRICE_IN", "4.0"))
CLAUDE_PRICE_OUT = float(os.getenv("CLAUDE_PRICE_OUT", "20.0"))

# Who Motkra is. Injected into every lane's system prompt so the assistant recognizes itself
# and can answer "who are you / what can you do" truthfully. Keep it stable; Phase 24 turns
# the capability list into a live registry read from the running system.
MOTKRA_IDENTITY = (
    "You are Motkra, the user's own AI assistant living on their computer — a dual-AI system "
    "that routes each request itself: simple or private requests are answered locally on the "
    "user's machine, complex ones go to a cloud model with secrets redacted first. Depending on "
    "what the user has enabled, you can chat and answer questions, write and fix code, read and "
    "edit files in approved folders, run approved terminal commands, browse in your own sandboxed "
    "browser, triage and draft email (always with approval), work with GitHub, remember past "
    "conversations, and run multi-step agent tasks. When asked who you are or what you can do, "
    "answer as Motkra and describe these capabilities honestly, including what is not enabled yet."
)

SYSTEM_PROMPT = (
    MOTKRA_IDENTITY +
    " You have expertise in software engineering, science, and problem-solving. "
    "Be concise but thorough."
)

# The local model is small and runs on CPU: every extra token costs latency,
# and long answers are where it makes mistakes. Identity stays, but compact.
LOCAL_SYSTEM_PROMPT = (
    "You are Motkra, the user's own assistant running privately on their computer; you also have "
    "a stronger cloud side for complex tasks, and tools for files, terminal, browser and email "
    "when the user enables them. Answer directly and correctly. "
    "Match the length to the request: a sentence or two for simple questions, just the code "
    "(plus one line of explanation) for small code tasks, only the label when asked to classify. "
    "No preamble, no restating the question, no unrequested extras. If you are not sure about a "
    "fact or calculation, say so instead of guessing. Reply in the user's language."
)

# Personal requests are kept local by design, so the local model must actually help with them.
PERSONAL_SYSTEM_PROMPT = LOCAL_SYSTEM_PROMPT + (
    " This request is about the user's own health, money, work, family or legal situation, and it never "
    "leaves this computer. Help with it: explain what their facts and numbers mean using accurate, "
    "well-established reference values, and give concrete practical steps. Mention when a professional "
    "should confirm or decide, but do not refuse and do not answer only with 'see a professional'."
)

# Gemma 4 reasons silently before answering unless told not to; on CPU that is most of its latency.
# auto: off for one-line questions and label-only requests (same quality, ~5x faster), on otherwise.
_think = os.getenv("LOCAL_THINK", "auto").lower()
_think = {"true": "on", "1": "on", "false": "off", "0": "off"}.get(_think, _think)
LOCAL_THINK = _think if _think in ("auto", "on", "off") else "auto"

# Words in user messages that suggest routing to local Gemma (fast / private)
LOCAL_HINTS = {
    "quick", "briefly", "brief", "short", "fast", "simple",
    "local", "private", "offline", "one line", "tldr",
}

# Words that suggest routing to Claude (complex / cloud)
CLOUD_HINTS = {
    "explain", "analyze", "analyse", "generate", "implement",
    "design", "debug", "comprehensive", "detailed", "step by step",
    "how does", "why does", "write code", "create", "refactor",
}

# Desktop daemon (daemon.py): localhost API port (the Electron motkra-daemon owns 7432 and
# calls this one), and the global push-to-talk hotkey (press to start talking, press again to send).
DAEMON_PORT = int(os.getenv("DAEMON_PORT", "7433"))
DAEMON_HOTKEY = os.getenv("DAEMON_HOTKEY", "ctrl+shift+space")

# Local voice. STT model: tiny | base | small | medium (bigger = more accurate, slower on CPU).
# VOICE_LANGUAGE: ISO code such as "es" or "en"; empty means auto-detect.
# PIPER_VOICE: path to a Piper .onnx voice; empty falls back to the built-in Windows voice.
VOICE_STT_MODEL = os.getenv("VOICE_STT_MODEL", "small")
VOICE_LANGUAGE = os.getenv("VOICE_LANGUAGE", "").strip().lower()
PIPER_VOICE = os.getenv("PIPER_VOICE", "").strip()
VOICE_REPLY = os.getenv("VOICE_REPLY", "on").lower() not in ("off", "0", "false")
