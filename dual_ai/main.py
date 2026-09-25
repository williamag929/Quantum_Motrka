"""
Motkra CLI: local-first assistant. Gemma 4 (local, Ollama) handles what it can;
Claude (cloud) or Kimi (NVIDIA) handle the rest. Secrets are redacted before any
cloud call and personal data stays on this machine.

Usage:
    python main.py              # mode from DEFAULT_MODE in .env (default: auto)
    python main.py --local      # force Gemma 4
    python main.py --cloud      # force Claude
    python main.py --kimi       # force Kimi

In-session commands:
    /auto     smart routing (secrets redacted, personal data local, local triage)
    /local    switch to Gemma 4
    /cloud    switch to Claude
    /kimi     switch to Kimi (NVIDIA)
    /stats    local share, privacy and savings
    /clear    wipe conversation history
    /history  show conversation history
    /quit     exit
"""

import sys

from config import CLAUDE_MODEL, GEMMA_MODEL, KIMI_MODEL
from session import MODEL_LABEL, MODES, Session, Turn, default_mode, normalize_mode

BANNER = f"""
  Motkra — local-first AI assistant
  • local  {GEMMA_MODEL}
  • cloud  {CLAUDE_MODEL}
  • kimi   {KIMI_MODEL}
  Commands: /auto /local /cloud /kimi /stats /clear /history /quit
"""


def initial_mode() -> str:
    for mode, flags in (("local", ("--local", "--ollama")), ("cloud", ("--cloud", "--claude")), ("kimi", ("--kimi",))):
        if any(f in sys.argv for f in flags):
            return mode
    return default_mode()


def show_route(turn: Turn) -> None:
    label = MODEL_LABEL[turn.decision.target]
    print(f"\n[{label}{' · ' + turn.reason if turn.reason else ''}] ", end="", flush=True)


def main() -> None:
    print(BANNER)
    session = Session(initial_mode())
    print(f"  Mode: {session.mode}\n")

    while True:
        try:
            user_input = input("You: ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nGoodbye!")
            break
        if not user_input:
            continue

        if user_input.startswith("/"):
            cmd = user_input[1:].lower().strip()
            cmd = normalize_mode(cmd) or cmd
            if cmd in ("quit", "exit", "q"):
                print("Goodbye!")
                break
            elif cmd in MODES:
                session.mode = cmd
                print(f"  → Mode: {session.mode}\n")
            elif cmd == "stats":
                print(session.stats.summary() + "\n")
            elif cmd == "clear":
                session.clear()
                print("  → Conversation history cleared.\n")
            elif cmd == "history":
                for msg in session.history or [{"role": "-", "content": "(empty)"}]:
                    print(f"  [{msg['role']}] {msg['content'][:80]}")
                print()
            else:
                print(f"  Unknown command: /{cmd}\n")
            continue

        try:
            turn = session.ask(user_input, on_start=show_route, on_text=lambda t: print(t, end="", flush=True))
        except Exception as exc:
            print(f"\n  Error: {exc}\n")
            continue

        print("\n")
        if turn.decision.private and turn.decision.target == "local" and session.mode == "auto":
            print("  (Kept on this machine because it looks personal. To ask Claude instead: /cloud, then ask again.)\n")


if __name__ == "__main__":
    main()
