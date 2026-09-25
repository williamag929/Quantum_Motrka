import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).with_name(".env"))

CLAUDE_MODEL = os.getenv("CLAUDE_MODEL", "claude-opus-5-5")
GEMMA_MODEL = os.getenv("GEMMA_MODEL", "gemma4:e2b")
KIMI_MODEL = os.getenv("KIMI_MODEL", "moonshotai/kimi-k3")

# Only Claude is billed per token here; used for savings estimates. USD per 1M tokens.
CLAUDE_PRICE_IN = float(os.getenv("CLAUDE_PRICE_IN", "4.0"))
CLAUDE_PRICE_OUT = float(os.getenv("CLAUDE_PRICE_OUT", "20.0"))

SYSTEM_PROMPT = (
    "You are a helpful AI assistant with expertise in software engineering, "
    "science, and problem-solving. Be concise but thorough."
)

# The local model is small and runs on CPU: every extra token costs latency,
# and long answers are where it makes mistakes.
LOCAL_SYSTEM_PROMPT = (
    "You are a helpful assistant running on the user's computer. Answer directly and correctly. "
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
