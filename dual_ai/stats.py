import json
from pathlib import Path

from config import CLAUDE_PRICE_IN, CLAUDE_PRICE_OUT

STATS_FILE = Path.home() / ".motkra" / "cli_stats.json"

_EMPTY = {"local": 0, "cloud": 0, "kimi": 0, "private_kept_local": 0, "redacted_cloud": 0,
          "saved_usd": 0.0, "spent_usd": 0.0}


def claude_cost(input_tokens: int, output_tokens: int) -> float:
    return (input_tokens * CLAUDE_PRICE_IN + output_tokens * CLAUDE_PRICE_OUT) / 1e6


class Stats:
    def __init__(self) -> None:
        self.session = dict(_EMPTY)
        try:
            self.total = {**_EMPTY, **json.loads(STATS_FILE.read_text(encoding="utf-8"))}
        except (OSError, ValueError):
            self.total = dict(_EMPTY)

    def record(self, target: str, input_tokens: int, output_tokens: int, private: bool, redacted: bool = False) -> None:
        cost = claude_cost(input_tokens, output_tokens)
        for bucket in (self.session, self.total):
            bucket[target] += 1
            bucket["private_kept_local"] += private and target == "local"
            bucket["redacted_cloud"] += redacted
            if target == "local":
                bucket["saved_usd"] += cost  # what Claude would have charged for the same tokens
            elif target == "cloud":
                bucket["spent_usd"] += cost
        try:
            STATS_FILE.parent.mkdir(parents=True, exist_ok=True)
            STATS_FILE.write_text(json.dumps(self.total, indent=2), encoding="utf-8")
        except OSError:
            pass

    @staticmethod
    def _format(label: str, s: dict) -> str:
        n = s["local"] + s["cloud"] + s["kimi"]
        pct = 100 * s["local"] / n if n else 0
        return (
            f"  {label}: {n} requests, {s['local']} local ({pct:.0f}%), {s['cloud']} Claude, {s['kimi']} Kimi\n"
            f"    private requests kept on this machine: {s['private_kept_local']}, "
            f"cloud requests with secrets redacted: {s['redacted_cloud']}\n"
            f"    Claude spend: ${s['spent_usd']:.4f}   estimated saved by running locally: ${s['saved_usd']:.4f}"
        )

    def summary(self) -> str:
        return self._format("This session", self.session) + "\n" + self._format("All time", self.total)
