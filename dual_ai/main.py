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

import os
import sys

import claude_client
import gemma_client
import kimi_client
from config import CLAUDE_MODEL, GEMMA_MODEL, KIMI_MODEL, LOCAL_SYSTEM_PROMPT, PERSONAL_SYSTEM_PROMPT, SYSTEM_PROMPT
from privacy import REDACTION_NOTE, StreamRestorer, redact, restore
from router import Decision, smart_route
from stats import Stats

MODES = ("auto", "local", "cloud", "kimi")
CLIENTS = {"local": gemma_client, "cloud": claude_client, "kimi": kimi_client}
MODEL_LABEL = {
    "local": f"Gemma  {GEMMA_MODEL} (local)",
    "cloud": f"Claude {CLAUDE_MODEL}",
    "kimi": f"Kimi   {KIMI_MODEL}",
}

BANNER = f"""
  Motkra — local-first AI assistant
  • local  {GEMMA_MODEL}
  • cloud  {CLAUDE_MODEL}
  • kimi   {KIMI_MODEL}
  Commands: /auto /local /cloud /kimi /stats /clear /history /quit
"""

ALIASES = {"ollama": "local", "claude": "cloud"}


def initial_mode() -> str:
    for mode, flags in (("local", ("--local", "--ollama")), ("cloud", ("--cloud", "--claude")), ("kimi", ("--kimi",))):
        if any(f in sys.argv for f in flags):
            return mode
    mode = os.getenv("DEFAULT_MODE", "auto").lower()
    mode = ALIASES.get(mode, mode)
    return mode if mode in MODES else "auto"


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


def main() -> None:
    print(BANNER)
    mode = initial_mode()
    print(f"  Mode: {mode}\n")
    history: list[dict] = []
    secrets: dict[str, str] = {}  # placeholder → secret, kept for the whole session
    stats = Stats()

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
            cmd = ALIASES.get(cmd, cmd)
            if cmd in ("quit", "exit", "q"):
                print("Goodbye!")
                break
            elif cmd in MODES:
                mode = cmd
                print(f"  → Mode: {mode}\n")
            elif cmd == "stats":
                print(stats.summary() + "\n")
            elif cmd == "clear":
                history.clear()
                secrets.clear()
                print("  → Conversation history cleared.\n")
            elif cmd == "history":
                for msg in history or [{"role": "-", "content": "(empty)"}]:
                    print(f"  [{msg['role']}] {msg['content'][:80]}")
                print()
            else:
                print(f"  Unknown command: /{cmd}\n")
            continue

        decision = decide(mode, user_input, history, secrets)
        history.append({"role": "user", "content": user_input, "private": decision.private})
        messages = payload(history, decision.target, secrets)
        redacted = decision.target != "local" and messages[-1]["content"] != user_input
        reason = "" if decision.reason == "forced" else decision.reason
        if redacted and "redacted" not in reason:
            reason = f"{reason}, secrets redacted" if reason else "secrets redacted"
        print(f"\n[{MODEL_LABEL[decision.target]}{' · ' + reason if reason else ''}] ", end="", flush=True)

        if decision.target == "local":
            system = PERSONAL_SYSTEM_PROMPT if decision.private else LOCAL_SYSTEM_PROMPT
        else:
            has_placeholders = any(p in m["content"] for m in messages for p in secrets)
            system = SYSTEM_PROMPT + (REDACTION_NOTE if has_placeholders else "")

        restorer = StreamRestorer(secrets)
        try:
            reply = CLIENTS[decision.target].generate(
                messages, system=system, on_text=lambda t: print(restorer.feed(t), end="", flush=True)
            )
        except Exception as exc:
            print(f"\n  Error: {exc}\n")
            history.pop()
            continue

        print(restorer.flush() + "\n")
        if decision.private and decision.target == "local" and mode == "auto":
            print("  (Kept on this machine because it looks personal. To ask Claude instead: /cloud, then ask again.)\n")
        history.append({"role": "assistant", "content": restore(reply.text, secrets), "private": decision.private})
        stats.record(decision.target, reply.input_tokens, reply.output_tokens, decision.private, redacted)


if __name__ == "__main__":
    main()
