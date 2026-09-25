# Motkra routing benchmark

Measures how much of a developer's day-to-day AI traffic a **local model** can handle, what that costs in quality and latency, and whether private data leaks to the cloud. Every router in `router.py` is scored against the same tasks.

## Run it

```powershell
cd dual_ai
python bench/run.py                 # dev + holdout: answer, triage, judge, write the report
python bench/run.py --think off     # measure the local model with its hidden reasoning disabled
python bench/run.py --set holdout   # only the held-out tasks
python bench/run.py --report-only   # rebuild the report from cached results
```

The report lands in `bench/reports/<machine>.md`.

Every model call is cached, so re-running only pays for what has not been measured yet. Claude's own answers (~$2.70 for all tasks) are shared by every machine; grading each new local model or variant costs about **$1.50**.

## How it works

1. **Answer.** Every task in `bench/tasks.py` is answered by the local model (Ollama) and by Claude. Tasks containing secrets are also answered by Claude on the *redacted* request, the way the v2 router would send it.
2. **Triage.** The local router decides, for each task, whether it would stay local.
3. **Judge.** Claude grades the local and the cloud answer blind (random A/B order), 1–10. A local answer is *good enough* when it scores ≥ 7 and is within 1 point of Claude's.
4. **Report.** Each router is replayed over the cached results: share kept local, average quality, bad local answers, missed local wins, secrets and personal data sent to the cloud, Claude cost, and latency. The **oracle** row is the ceiling for any router with that local model.

Tasks are split into a **dev** set (used to design the router) and a **holdout** set (never used for tuning). Trust the holdout numbers.

## Running on another machine

Local results depend on the hardware, so they are stored per machine:

```
bench/results/cloud_answers.jsonl         shared: Claude and Kimi answers
bench/results/<machine>/local_answers.jsonl
bench/results/<machine>/triage.jsonl
bench/results/<machine>/judgments.jsonl
bench/results/<machine>/profile.json       CPU, RAM, GPU/VRAM, where Ollama placed the model
bench/reports/<machine>.md
```

On the new machine:

1. Copy the repo **including `bench/results/cloud_answers.jsonl`** so Claude's answers are not paid for twice, and create `dual_ai/.env` with the API keys.
2. Pull the local model you want to test and point `GEMMA_MODEL` at it in `.env`. With a 12 GB GPU, models whose Ollama download is under ~10 GB run fully on the GPU; bigger ones split between GPU and RAM and slow down. Check `ollama ps` after the first answer: the `PROCESSOR` column should read `100% GPU`.
3. `python bench/run.py` (and `--think off` for the second variant).
4. Compare `bench/reports/<this-machine>.md` with the other machines' reports.

The machine folder name comes from the hostname; set `BENCH_MACHINE=name` to override it.

## Caveats

- Claude grades its own answers, which may favour Claude; local numbers are conservative.
- ~100 tasks: differences of a few tasks are noise.
- All personal data and credentials in `tasks.py` are fake.
