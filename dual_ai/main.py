"""
Dual-model AI assistant: Claude (cloud) + Gemma 4 (local via Ollama).

Usage:
    python main.py              # interactive chat, auto-routing
    python main.py --local      # force Gemma 4 for all messages
    python main.py --cloud      # force Claude for all messages

In-session commands:
    /local    switch to Gemma 4
    /cloud    switch to Claude
    /auto     restore auto-routing
    /clear    wipe conversation history
    /quit     exit
"""

import sys
from dotenv import load_dotenv

load_dotenv()  # loads .env from the current directory (or any parent)

import claude_client
import gemma_client
from router import route

BANNER = """
╔══════════════════════════════════════════════╗
║      Dual-Model AI Assistant                 ║
║  • Claude claude-opus-4-6  (cloud / complex) ║
║  • Gemma 4 gemma4:e2b      (local / fast)    ║
╠══════════════════════════════════════════════╣
║  Commands: /local  /cloud  /auto  /clear     ║
║            /quit                             ║
╚══════════════════════════════════════════════╝
"""

MODEL_LABEL = {
    "local": "Gemma 4  (local) ",
    "cloud": "Claude   (cloud) ",
}


def parse_args() -> str:
    """Return the initial mode from CLI flags: 'auto', 'local', or 'cloud'."""
    if "--local" in sys.argv:
        return "local"
    if "--cloud" in sys.argv:
        return "cloud"
    return "auto"


def main() -> None:
    print(BANNER)
    mode = parse_args()
    if mode != "auto":
        print(f"  Mode forced to: {mode}\n")

    history: list[dict] = []

    while True:
        try:
            user_input = input("You: ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nGoodbye!")
            break

        if not user_input:
            continue

        # ── Commands ────────────────────────────────────────────────────────
        if user_input.startswith("/"):
            cmd = user_input[1:].lower().strip()
            if cmd in ("quit", "exit", "q"):
                print("Goodbye!")
                break
            elif cmd == "local":
                mode = "local"
                print("  → Gemma 4 (local) selected for all messages.\n")
            elif cmd == "cloud":
                mode = "cloud"
                print("  → Claude (cloud) selected for all messages.\n")
            elif cmd == "auto":
                mode = "auto"
                print("  → Auto-routing restored.\n")
            elif cmd == "clear":
                history.clear()
                print("  → Conversation history cleared.\n")
            elif cmd == "history":
                if not history:
                    print("  (empty)\n")
                else:
                    for msg in history:
                        print(f"  [{msg['role']}] {msg['content'][:80]}")
                    print()
            else:
                print(f"  Unknown command: /{cmd}\n")
            continue

        # ── Route ────────────────────────────────────────────────────────────
        model = route(user_input) if mode == "auto" else mode

        # ── Build & send ─────────────────────────────────────────────────────
        history.append({"role": "user", "content": user_input})
        print(f"\n[{MODEL_LABEL[model]}] ", end="", flush=True)

        try:
            if model == "local":
                response = gemma_client.ask(history)
            else:
                response = claude_client.ask(history)
        except Exception as exc:
            print(f"\n  Error: {exc}\n")
            history.pop()  # remove the failed user turn
            continue

        history.append({"role": "assistant", "content": response})
        print()  # blank line between turns


if __name__ == "__main__":
    main()
