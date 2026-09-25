"""Score routing strategies against cached answers and judgments; write bench/reports/<machine>.md."""

import json
import re
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from statistics import mean
from typing import Callable

import router
from bench.machine import describe, machine_id
from bench.run import (
    CLOUD, CLOUD_REDACTED, PROFILE, ROOT, answer_index, judgment_index, local_is_a, local_label, task_label,
    triage_index, triage_version,
)
from bench.tasks import HOLDOUT, TASKS
from config import CLAUDE_MODEL, CLAUDE_PRICE_IN, CLAUDE_PRICE_OUT, GEMMA_MODEL, LOCAL_SYSTEM_PROMPT, SYSTEM_PROMPT
from privacy import redact, scan

REPORT = ROOT / "reports" / f"{machine_id()}.md"

# A local answer is "good enough" when an expert would ship it and it is at
# most one point behind Claude's answer to the same request.
MIN_LOCAL_SCORE = 7
MAX_GAP = 1

MOTKRA = "**Motkra router (v3)**"


@dataclass
class Row:
    task: dict
    local_model: str
    local: dict
    cloud: dict
    local_score: int
    cloud_score: int
    redacted: dict | None = None      # Claude's answer to the redacted request, restored locally
    redacted_score: int | None = None
    triage: dict | None = None

    @property
    def local_ok(self) -> bool:
        return self.local_score >= MIN_LOCAL_SCORE and self.local_score >= self.cloud_score - MAX_GAP

    @property
    def private(self) -> bool:
        return bool(self.task.get("private"))

    @property
    def has_secret(self) -> bool:
        return scan(self.task["prompt"]) is not None

    @property
    def cloud_target(self) -> str:
        """How a privacy-aware router reaches Claude: redacted whenever the request holds secrets."""
        return "cloud_redacted" if self.redacted else "cloud"


def _cost(answer: dict) -> float:
    return (answer["input_tokens"] * CLAUDE_PRICE_IN + answer["output_tokens"] * CLAUDE_PRICE_OUT) / 1e6


@dataclass
class Decision:
    target: str                 # "local", "cloud" or "cloud_redacted"
    extra_latency_s: float = 0.0


Router = Callable[[Row], Decision]


def _replay_gemma_triage(r: Row) -> Decision:
    """Redaction + personal lexicon, then a local Gemma call decides (cached triage results)."""
    text, _ = redact(r.task["prompt"])
    if router.looks_personal(text):
        return Decision("local")
    if r.triage is None:
        return Decision("local" if router.route(text) == "local" else r.cloud_target)
    t = r.triage
    target = "local" if t["private"] or t["route"] == "local" else r.cloud_target
    return Decision(target, extra_latency_s=t["latency_s"])


def _replay_motkra(r: Row) -> Decision:
    """router.smart_route: redaction + personal lexicon + intent rules, no model call."""
    text, _ = redact(r.task["prompt"])
    if router.looks_personal(text) or router.intent_route(text) == "local":
        return Decision("local")
    return Decision(r.cloud_target)


ROUTERS: dict[str, Router] = {
    "Always cloud (Claude only)": lambda r: Decision("cloud"),
    "Always local (Gemma only)": lambda r: Decision("local"),
    "Keyword router (v1)": lambda r: Decision(router.route(r.task["prompt"])),
    "Gemma triage router (v2)": _replay_gemma_triage,
    MOTKRA: _replay_motkra,
    "Oracle (upper bound)": lambda r: Decision(
        "local" if r.local_ok or (r.private and not r.has_secret) else r.cloud_target),
}


def load_rows(tasks: list[dict], label_for: Callable[[dict], str]) -> list[Row]:
    answers, judged, triages = answer_index(), judgment_index(), triage_index()
    version = triage_version()
    rows = []
    for t in tasks:
        local_model = label_for(t)
        local, cloud = answers.get((t["id"], local_model)), answers.get((t["id"], CLOUD))
        j = judged.get((t["id"], local_model, CLOUD))
        if not (local and cloud and j):
            continue
        row = Row(t, local_model, local, cloud, j["local_score"], j["cloud_score"],
                  triage=triages.get((t["id"], GEMMA_MODEL, version)))
        red = answers.get((t["id"], CLOUD_REDACTED))
        jr = judged.get((t["id"], local_model, CLOUD_REDACTED))
        if red and jr:
            row.redacted, row.redacted_score = red, jr["cloud_score"]
        rows.append(row)
    return rows


def evaluate(rows: list[Row], route: Router) -> dict:
    local_n = bad_local = secret_leaks = personal_leaks = missed = 0
    scores, latencies, cost = [], [], 0.0
    for r in rows:
        d = route(r)
        if d.target == "local":
            local_n += 1
            scores.append(r.local_score)
            latencies.append(r.local["latency_s"] + d.extra_latency_s)
            bad_local += not r.local_ok
            continue
        answer, score = (r.redacted, r.redacted_score) if d.target == "cloud_redacted" else (r.cloud, r.cloud_score)
        scores.append(score)
        latencies.append(answer["latency_s"] + d.extra_latency_s)
        cost += _cost(answer)
        secret_leaks += r.has_secret and d.target == "cloud"
        personal_leaks += r.private and not r.has_secret
        missed += r.local_ok and not r.private
    baseline = sum(_cost(r.cloud) for r in rows)
    return {
        "local_pct": 100 * local_n / len(rows),
        "quality": mean(scores),
        "bad_local": bad_local,
        "missed": missed,
        "secret_leaks": secret_leaks,
        "personal_leaks": personal_leaks,
        "cost": cost,
        "savings_pct": 100 * (1 - cost / baseline) if baseline else 0.0,
        "latency": mean(latencies),
    }


def _router_table(rows: list[Row], routers: dict[str, Router]) -> list[str]:
    secrets = sum(r.has_secret for r in rows)
    personal = sum(r.private and not r.has_secret for r in rows)
    out = [
        f"| Router | Kept local | Avg quality | Bad local answers | Missed local wins | Secrets sent in clear (of {secrets}) "
        f"| Personal data sent to cloud (of {personal}) | Claude cost | Savings | Avg latency |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for name, fn in routers.items():
        m = evaluate(rows, fn)
        out.append(
            f"| {name} | {m['local_pct']:.0f}% | {m['quality']:.2f} | {m['bad_local']} | {m['missed']} | "
            f"{m['secret_leaks']} | {m['personal_leaks']} | ${m['cost']:.3f} | {m['savings_pct']:.0f}% | {m['latency']:.1f}s |"
        )
    return out


def _category_table(rows: list[Row]) -> list[str]:
    out = [
        "| Category | Tasks | Local good enough | Avg local score | Avg Claude score | Avg local latency | Avg Claude latency |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    by_cat = defaultdict(list)
    for r in rows:
        by_cat[r.task["category"]].append(r)
    for cat, rs in sorted(by_cat.items(), key=lambda kv: -mean(r.local_ok for r in kv[1])):
        out.append(
            f"| {cat} | {len(rs)} | {100 * mean(r.local_ok for r in rs):.0f}% | {mean(r.local_score for r in rs):.1f} | "
            f"{mean(r.cloud_score for r in rs):.1f} | {mean(r.local['latency_s'] for r in rs):.1f}s | "
            f"{mean(r.cloud['latency_s'] for r in rs):.1f}s |"
        )
    return out


def _variant_table(tasks: list[dict], active_mode: str) -> list[str]:
    variants = [
        ("shared assistant prompt, thinking on (Gemma default)", lambda t: local_label(SYSTEM_PROMPT, True)),
        ("concise local prompt, thinking on", lambda t: local_label(LOCAL_SYSTEM_PROMPT, True)),
        ("concise local prompt, thinking off", lambda t: local_label(LOCAL_SYSTEM_PROMPT, False)),
        ("concise local prompt, thinking auto", lambda t: task_label(t, LOCAL_SYSTEM_PROMPT, "auto")),
    ]
    measured = [(name, load_rows(tasks, fn)) for name, fn in variants]
    ids = set.intersection(*({r.task["id"] for r in rows} for _, rows in measured if rows)) if any(
        rows for _, rows in measured) else set()
    out = [
        "| Local variant | Tasks | Local good enough | Avg local score | Avg output tokens | Avg local latency |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for name, rows in measured:
        rows = [r for r in rows if r.task["id"] in ids]
        if not rows:
            continue
        active = " ← active" if name.endswith(f"thinking {active_mode}") else ""
        out.append(
            f"| {name}{active} | {len(rows)} | {100 * mean(r.local_ok for r in rows):.0f}% | "
            f"{mean(r.local_score for r in rows):.2f} | {mean(r.local['output_tokens'] for r in rows):.0f} | "
            f"{mean(r.local['latency_s'] for r in rows):.1f}s |"
        )
    return out


def _named(reasoning: str, local_first: bool) -> str:
    """Replace the judge's blind labels with the real sources."""
    a, b = ("Local", "Claude") if local_first else ("Claude", "Local")
    reasoning = re.sub(r"\b(?:Answer |answer )?A\b", a, reasoning)
    reasoning = re.sub(r"\b(?:Answer |answer )?B\b", b, reasoning)
    return reasoning.replace("\n", " ")


def _headline(rows: list[Row]) -> list[str]:
    base, motkra = evaluate(rows, ROUTERS["Always cloud (Claude only)"]), evaluate(rows, _replay_motkra)
    leaks = base["secret_leaks"] + base["personal_leaks"]
    return [
        "## Headline (holdout set)",
        "",
        f"Compared with sending everything to Claude, the Motkra router keeps **{motkra['local_pct']:.0f}%** of requests "
        f"on this machine, sends **{motkra['secret_leaks'] + motkra['personal_leaks']} of {leaks}** private requests to "
        f"the cloud in clear (Claude-only: {leaks}), cuts the Claude bill by **{motkra['savings_pct']:.0f}%**, and answers "
        f"with average quality **{motkra['quality']:.2f}** vs {base['quality']:.2f} and average latency "
        f"**{motkra['latency']:.1f}s** vs {base['latency']:.1f}s.",
        "",
    ]


def write_report(local_system: str, mode: str, extra_routers: dict[str, Router] | None = None) -> Path:
    routers = {**ROUTERS, **(extra_routers or {})}
    label_for = lambda t: task_label(t, local_system, mode)  # noqa: E731
    dev, holdout = load_rows(TASKS, label_for), load_rows(HOLDOUT, label_for)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    if not dev:
        REPORT.write_text("# Motkra routing benchmark\n\nNo judged tasks yet. Run `python bench/run.py`.\n", encoding="utf-8")
        return REPORT

    lines = [
        "# Motkra routing benchmark",
        "",
        f"Real-world requests answered by **{GEMMA_MODEL}** (local, Ollama, thinking `{mode}`) and **{CLAUDE_MODEL}** "
        f"(cloud), graded blind 1–10 by {CLAUDE_MODEL}. A local answer counts as *good enough* when it scores "
        f"≥ {MIN_LOCAL_SCORE} and is at most {MAX_GAP} point behind Claude's.",
        "",
        f"**Machine:** {describe(json.loads(PROFILE.read_text(encoding='utf-8')))}" if PROFILE.exists()
        else f"**Machine:** `{machine_id()}`",
        "",
        f"- **Dev set** ({len(dev)} tasks): used while designing the routers and the local prompt.",
        f"- **Holdout set** ({len(holdout)} tasks): written before any tuning and never used to tune; the honest numbers.",
        "",
    ]
    if holdout:
        lines += _headline(holdout)
        lines += ["## Routers — holdout set", ""] + _router_table(holdout, routers) + [""]
    lines += ["## Routers — dev set", ""] + _router_table(dev, routers) + [
        "",
        "- **Bad local answers**: kept local, but the local answer was not good enough (quality lost).",
        "- **Missed local wins**: sent to Claude although the local answer was good enough (money lost).",
        "- **Secrets sent in clear**: credentials, keys or card numbers that reached the cloud unredacted. "
        "v2 and v3 replace them with placeholders (`[PASSWORD_1]`) before any cloud call and restore them locally.",
        "- **Personal data**: health, finances, HR or family details. No placeholder keeps such a request meaningful, "
        "so v2 and v3 keep it local (the CLI offers `/cloud` if the user prefers Claude's answer).",
        "- **v2** asks the local model to triage each request (one extra local call). "
        "**v3** routes by request intent with bilingual rules and costs no model call.",
        "- **Oracle** knows the grades in advance: the ceiling for any router with this local model.",
        "",
        "## Where the local model is good enough (dev + holdout)",
        "",
    ] + _category_table(dev + holdout)

    lines += ["", "## Local model variants (dev set)", ""] + _variant_table(TASKS, mode)

    judgments = judgment_index()
    worst = sorted((r for r in dev + holdout if not r.local_ok), key=lambda r: r.local_score - r.cloud_score)[:8]
    if worst:
        lines += ["", "## Largest local misses", ""]
        for r in worst:
            j = judgments[(r.task["id"], r.local_model, CLOUD)]
            why = _named(j["reasoning"], j.get("local_is_a", local_is_a(r.task["id"], r.local_model)))
            lines.append(f"- **{r.task['id']}** ({r.task['category']}) local {r.local_score} vs Claude {r.cloud_score}: {why[:320]}")

    judge_cost = sum(
        (j["judge_input_tokens"] * CLAUDE_PRICE_IN + j["judge_output_tokens"] * CLAUDE_PRICE_OUT) / 1e6
        for j in judgments.values()
    )
    lines += [
        "",
        "## Method and caveats",
        "",
        "- Tasks live in `bench/tasks.py`; all personal data and credentials in them are fake.",
        "- Claude grades its own answers, which may favour Claude; the local numbers are conservative.",
        "- Latency is wall-clock: the local model on the machine above, warmed up first; Claude over the network. "
        "v2 latency includes its local triage call. Local results only compare within one machine "
        "(`bench/results/<machine>/`).",
        f"- Cost uses ${CLAUDE_PRICE_IN}/M input and ${CLAUDE_PRICE_OUT}/M output tokens (thinking tokens included). "
        f"All grading on this machine so far cost ${judge_cost:.2f}, not included above.",
        "- Small samples: treat differences of a few tasks as noise.",
        "- Reproduce: `python bench/run.py` (cached; only new tasks, prompts or models are paid for).",
        "",
    ]
    REPORT.write_text("\n".join(lines), encoding="utf-8")
    return REPORT
