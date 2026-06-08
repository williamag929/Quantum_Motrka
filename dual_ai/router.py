from config import LOCAL_HINTS, CLOUD_HINTS


def route(message: str) -> str:
    """
    Return 'local' (Gemma) or 'cloud' (Claude) based on message content.

    Scoring rules (highest wins):
      - Explicit local hints  → local
      - Explicit cloud hints  → cloud
      - Very short message    → local  (fast turnaround)
      - Default               → cloud  (more capable)
    """
    lower = message.lower()
    words = lower.split()

    local_score = sum(1 for hint in LOCAL_HINTS if hint in lower)
    cloud_score = sum(1 for hint in CLOUD_HINTS if hint in lower)

    if local_score > cloud_score:
        return "local"
    if cloud_score > local_score:
        return "cloud"

    # Tie-break: very short messages go local, longer ones go cloud
    return "local" if len(words) <= 8 else "cloud"
