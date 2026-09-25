"""Motkra routing benchmark.

Answers every task with the local model and with Claude (optionally Kimi),
has Claude grade both answers blind, then scores each router on how many
requests it keeps local, what quality that costs, and what it saves.

    python bench/run.py                     # dev + holdout: answer, triage, judge, report
    python bench/run.py --set dev           # only the development tasks
    python bench/run.py --local-prompt original   # measure the local model with the shared prompt
    python bench/run.py --kimi              # also collect Kimi answers
    python bench/run.py --only cs01 qf02
    python bench/run.py --report-only

Every model call is cached in bench/results/*.jsonl, so re-running only pays
for tasks, prompts or models that have not been measured yet.
"""

import argparse
import hashlib
import json
import random
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent))

import anthropic  # noqa: E402

import claude_client  # noqa: E402
import gemma_client  # noqa: E402
import kimi_client  # noqa: E402
import router  # noqa: E402
from bench.tasks import HOLDOUT, TASKS  # noqa: E402
from config import (  # noqa: E402
    CLAUDE_MODEL, GEMMA_MODEL, KIMI_MODEL, LOCAL_SYSTEM_PROMPT, LOCAL_THINK, PERSONAL_SYSTEM_PROMPT, SYSTEM_PROMPT,
)
from bench.machine import machine_id, profile  # noqa: E402
from privacy import REDACTION_NOTE, REDACTION_VERSION, redact, restore  # noqa: E402

# Cloud answers don't depend on the hardware and are shared by every machine.
# Local answers, triage timings and judgments of local answers are per machine.
RESULTS = ROOT / "results"
CLOUD_ANSWERS = RESULTS / "cloud_answers.jsonl"
MACHINE_DIR = RESULTS / machine_id()
LOCAL_ANSWERS = MACHINE_DIR / "local_answers.jsonl"
JUDGMENTS = MACHINE_DIR / "judgments.jsonl"
TRIAGES = MACHINE_DIR / "triage.jsonl"
PROFILE = MACHINE_DIR / "profile.json"

TASK_SETS = {"dev": TASKS, "holdout": HOLDOUT, "all": TASKS + HOLDOUT}
LOCAL_PROMPTS = {"local": LOCAL_SYSTEM_PROMPT, "original": SYSTEM_PROMPT}
CLOUD = CLAUDE_MODEL
CLOUD_REDACTED = f"{CLAUDE_MODEL}+redacted-" + hashlib.sha256(f"{REDACTION_VERSION}{REDACTION_NOTE}".encode()).hexdigest()[:6]

_lock = threading.Lock()
sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:6]


def local_label(system: str, think: bool = True) -> str:
    """Cache key for local model + system prompt + thinking. The first run (shared prompt, thinking) is unlabeled."""
    label = GEMMA_MODEL if system == SYSTEM_PROMPT else f"{GEMMA_MODEL}+{_hash(system)}"
    return label if think else f"{label}-nothink"


def task_think(task: dict, mode: str) -> bool:
    """Reasoning on/off for one task under a LOCAL_THINK mode ('auto', 'on', 'off')."""
    return gemma_client.should_think([{"role": "user", "content": task["prompt"]}], mode)


def task_system(task: dict, system: str) -> str:
    """The router sends personal requests to the local model with the personal-help prompt."""
    if system == LOCAL_SYSTEM_PROMPT and router.looks_personal(redact(task["prompt"])[0]):
        return PERSONAL_SYSTEM_PROMPT
    return system


def task_label(task: dict, system: str, mode: str) -> str:
    return local_label(task_system(task, system), task_think(task, mode))


# ── Cache ────────────────────────────────────────────────────────────────────

def load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def append_jsonl(path: Path, row: dict) -> None:
    with _lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def answer_index() -> dict[tuple[str, str], dict]:
    """Latest successful answer per (task_id, model label)."""
    rows = load_jsonl(CLOUD_ANSWERS) + load_jsonl(LOCAL_ANSWERS)
    return {(r["task_id"], r["model"]): r for r in rows if not r.get("error")}


def judgment_index() -> dict[tuple[str, str, str], dict]:
    return {(r["task_id"], r["local_model"], r["cloud_model"]): r for r in load_jsonl(JUDGMENTS)}


# ── Answering ────────────────────────────────────────────────────────────────

def _call(path: Path, label: str, generate, task: dict, prompt: str | None = None, mapping: dict | None = None) -> None:
    t0 = time.perf_counter()
    try:
        reply = generate([{"role": "user", "content": prompt or task["prompt"]}])
        text = restore(reply.text, mapping) if mapping else reply.text
        row = {
            "task_id": task["id"], "model": label, "text": text,
            "input_tokens": reply.input_tokens, "output_tokens": reply.output_tokens,
            "latency_s": round(time.perf_counter() - t0, 2),
        }
        print(f"  ✓ {label:<30} {task['id']:<6} {row['latency_s']:>6.1f}s  {reply.output_tokens} tok")
    except Exception as exc:  # recorded and retried on the next run
        row = {"task_id": task["id"], "model": label, "error": f"{type(exc).__name__}: {exc}"[:500]}
        print(f"  ✗ {label:<30} {task['id']:<6} {row['error'][:120]}")
    append_jsonl(path, row)


def collect_answers(tasks: list[dict], local_system: str, mode: str, with_kimi: bool) -> None:
    have = answer_index()
    todo_local = [t for t in tasks if (t["id"], task_label(t, local_system, mode)) not in have]
    todo_cloud = [t for t in tasks if (t["id"], CLOUD) not in have]
    todo_redacted = []
    for t in tasks:
        text, mapping = redact(t["prompt"])
        if mapping and (t["id"], CLOUD_REDACTED) not in have:
            todo_redacted.append((t, text, mapping))
    todo_kimi = [t for t in tasks if with_kimi and (t["id"], KIMI_MODEL) not in have]
    print(f"Answers to collect: {len(todo_local)} local ({GEMMA_MODEL}, thinking {mode}), {len(todo_cloud)} {CLOUD}, "
          f"{len(todo_redacted)} {CLOUD_REDACTED}, {len(todo_kimi)} {KIMI_MODEL}")

    # Load the model first so the first task's latency isn't the cold start,
    # then record the hardware and where Ollama placed the model.
    gemma_client.generate([{"role": "user", "content": "hi"}])
    MACHINE_DIR.mkdir(parents=True, exist_ok=True)
    PROFILE.write_text(json.dumps(profile(GEMMA_MODEL), indent=2), encoding="utf-8")

    def run_local():
        for t in todo_local:  # CPU-bound: keep local calls sequential
            think, system = task_think(t, mode), task_system(t, local_system)
            _call(LOCAL_ANSWERS, local_label(system, think),
                  lambda msgs, think=think, system=system: gemma_client.generate(msgs, system=system, think=think), t)

    with ThreadPoolExecutor(max_workers=8) as pool:
        local_future = pool.submit(run_local)
        futures = [pool.submit(_call, CLOUD_ANSWERS, CLOUD, claude_client.generate, t) for t in todo_cloud]
        redacted_generate = lambda msgs: claude_client.generate(msgs, system=SYSTEM_PROMPT + REDACTION_NOTE)  # noqa: E731
        futures += [pool.submit(_call, CLOUD_ANSWERS, CLOUD_REDACTED, redacted_generate, t, p, m)
                    for t, p, m in todo_redacted]
        futures += [pool.submit(_call, CLOUD_ANSWERS, KIMI_MODEL, kimi_client.generate, t) for t in todo_kimi]
        for f in futures + [local_future]:
            f.result()


# ── Triage (local routing decision) ───────────────────────────────────────────

def triage_version() -> str:
    return _hash(router.TRIAGE_PROMPT + json.dumps(router.TRIAGE_OPTIONS, sort_keys=True))


def triage_index() -> dict[tuple[str, str, str], dict]:
    return {(r["task_id"], r["model"], r["version"]): r for r in load_jsonl(TRIAGES)}


def collect_triage(tasks: list[dict]) -> None:
    version, have = triage_version(), triage_index()
    todo = [t for t in tasks if (t["id"], GEMMA_MODEL, version) not in have]
    print(f"Triage decisions to collect: {len(todo)} (prompt {version})")
    for t in todo:
        text, _ = redact(t["prompt"])  # the router triages the already-redacted request
        try:
            tr = router.triage(text)
        except Exception as exc:
            print(f"  ✗ triage {t['id']}: {type(exc).__name__}: {str(exc)[:200]}")
            continue
        append_jsonl(TRIAGES, {
            "task_id": t["id"], "model": GEMMA_MODEL, "version": version,
            "private": tr.private, "route": tr.route, "latency_s": round(tr.latency_s, 2),
        })
        print(f"  ⇄ {t['id']:<6} {tr.route:<5}  private={tr.private!s:<5}  {tr.latency_s:.1f}s")


# ── Judging ──────────────────────────────────────────────────────────────────

JUDGE_SYSTEM = """You grade answers from AI assistants. You see a user request and two candidate answers, A and B, in random order.

Score each answer from 1 to 10 on how well it serves the user:
- Correctness comes first. Any factual error, bug, or wrong result caps the score at 5; a dangerous or badly misleading answer gets 1-3.
- Then whether it does what was asked, fully, in the requested format and length. When the user asks for a label only, one line, or a short reply, brevity is correct; do not reward extra length.
- Then clarity and usefulness. Answering in the user's language matters.
- 9-10: an expert would ship it as is. 7-8: good, minor issues. 5-6: usable with fixes. 1-4: wrong or unhelpful.

Judge each answer on its own merits; two answers can both earn a 9."""

JUDGE_SCHEMA = {
    "type": "object",
    "properties": {
        "reasoning": {"type": "string"},
        "score_a": {"type": "integer"},
        "score_b": {"type": "integer"},
    },
    "required": ["reasoning", "score_a", "score_b"],
    "additionalProperties": False,
}

_judge = anthropic.Anthropic()


def local_is_a(task_id: str, local_model: str) -> bool:
    """Deterministic blind A/B order per task and local variant."""
    seed = task_id if local_model == GEMMA_MODEL else f"{task_id}|{local_model}"
    return random.Random(seed).random() < 0.5


def _judge_one(task: dict, local: dict, cloud: dict) -> None:
    local_first = local_is_a(task["id"], local["model"])
    a, b = (local, cloud) if local_first else (cloud, local)
    user = (
        f"<request>\n{task['prompt']}\n</request>\n\n"
        f"<answer_a>\n{a['text']}\n</answer_a>\n\n"
        f"<answer_b>\n{b['text']}\n</answer_b>\n\n"
        "Briefly reason about each answer, then score both."
    )
    try:
        with _judge.messages.stream(
            model=CLAUDE_MODEL,
            max_tokens=16000,
            thinking={"type": "adaptive"},
            output_config={"effort": "medium", "format": {"type": "json_schema", "schema": JUDGE_SCHEMA}},
            system=[{"type": "text", "text": JUDGE_SYSTEM, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": user}],
        ) as stream:
            msg = stream.get_final_message()
        if msg.stop_reason == "refusal":
            raise RuntimeError("judge refused")
        verdict = json.loads(next(blk.text for blk in msg.content if blk.type == "text"))
    except Exception as exc:
        print(f"  ✗ judge {task['id']}: {type(exc).__name__}: {str(exc)[:200]}")
        return

    local_score, cloud_score = (
        (verdict["score_a"], verdict["score_b"]) if local_first else (verdict["score_b"], verdict["score_a"])
    )
    append_jsonl(JUDGMENTS, {
        "task_id": task["id"], "local_model": local["model"], "cloud_model": cloud["model"],
        "local_is_a": local_first, "local_score": local_score, "cloud_score": cloud_score,
        "reasoning": verdict["reasoning"],
        "judge_input_tokens": msg.usage.input_tokens + (msg.usage.cache_read_input_tokens or 0)
        + (msg.usage.cache_creation_input_tokens or 0),
        "judge_output_tokens": msg.usage.output_tokens,
    })
    print(f"  ⚖ {task['id']:<6} {local['model']} {local_score:>2}  vs {cloud['model']} {cloud_score:>2}")


def collect_judgments(tasks: list[dict], local_system: str, mode: str) -> None:
    answers, judged = answer_index(), judgment_index()
    todo = []
    for t in tasks:
        local_model = task_label(t, local_system, mode)
        local = answers.get((t["id"], local_model))
        for cloud_model in (CLOUD, CLOUD_REDACTED):
            cloud = answers.get((t["id"], cloud_model))
            if local and cloud and (t["id"], local_model, cloud_model) not in judged:
                todo.append((t, local, cloud))
    print(f"Judgments to collect: {len(todo)}")
    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(lambda args: _judge_one(*args), todo))


# ── Entry point ──────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--set", choices=TASK_SETS, default="all")
    ap.add_argument("--local-prompt", choices=LOCAL_PROMPTS, default="local")
    ap.add_argument("--think", choices=["auto", "on", "off"], default=LOCAL_THINK,
                    help="local model reasoning (default: LOCAL_THINK from .env, normally auto)")
    ap.add_argument("--kimi", action="store_true", help="also collect Kimi answers (slow on the free NVIDIA tier)")
    ap.add_argument("--only", nargs="*", help="task ids to run")
    ap.add_argument("--report-only", action="store_true")
    args = ap.parse_args()

    local_system = LOCAL_PROMPTS[args.local_prompt]
    tasks = [t for t in TASK_SETS[args.set] if not args.only or t["id"] in args.only]
    if not args.report_only:
        collect_answers(tasks, local_system, args.think, args.kimi)
        collect_triage(tasks)
        collect_judgments(tasks, local_system, args.think)

    from bench.report import write_report
    print(f"\nReport: {write_report(local_system, args.think)}")


if __name__ == "__main__":
    main()
