# Model identifiers
CLAUDE_MODEL = "claude-opus-4-7"
GEMMA_MODEL = "gemma4:e2b"

SYSTEM_PROMPT = (
    "You are a helpful AI assistant with expertise in software engineering, "
    "science, and problem-solving. Be concise but thorough."
)

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
