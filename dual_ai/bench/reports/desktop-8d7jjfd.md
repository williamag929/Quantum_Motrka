# Motkra routing benchmark

Real-world requests answered by **gemma4:e2b** (local, Ollama, thinking `auto`) and **claude-opus-5-5** (cloud), graded blind 1–10 by claude-opus-5-5. A local answer counts as *good enough* when it scores ≥ 7 and is at most 1 point behind Claude's.

**Machine:** `desktop-8d7jjfd` — Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz (6 cores), 15.8 GB RAM, GPU: Intel(R) UHD Graphics 630 (1.0 GB), Windows 11, model placement: CPU only

- **Dev set** (74 tasks): used while designing the routers and the local prompt.
- **Holdout set** (29 tasks): written before any tuning and never used to tune; the honest numbers.

## Headline (holdout set)

Compared with sending everything to Claude, the Motkra router keeps **45%** of requests on this machine, sends **0 of 5** private requests to the cloud in clear (Claude-only: 5), cuts the Claude bill by **20%**, and answers with average quality **8.03** vs 8.83 and average latency **19.7s** vs 12.3s.

## Routers — holdout set

| Router | Kept local | Avg quality | Bad local answers | Missed local wins | Secrets sent in clear (of 2) | Personal data sent to cloud (of 3) | Claude cost | Savings | Avg latency |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Always cloud (Claude only) | 0% | 8.83 | 0 | 11 | 2 | 3 | $0.769 | 0% | 12.3s |
| Always local (Gemma only) | 100% | 6.41 | 18 | 0 | 0 | 0 | $0.000 | 100% | 26.5s |
| Keyword router (v1) | 10% | 8.69 | 1 | 9 | 2 | 3 | $0.699 | 9% | 11.7s |
| Gemma triage router (v2) | 52% | 8.03 | 6 | 2 | 0 | 0 | $0.641 | 17% | 22.5s |
| **Motkra router (v3)** | 45% | 8.03 | 6 | 4 | 0 | 0 | $0.615 | 20% | 19.7s |
| Oracle (upper bound) | 48% | 8.21 | 3 | 0 | 0 | 0 | $0.621 | 19% | 18.2s |

## Routers — dev set

| Router | Kept local | Avg quality | Bad local answers | Missed local wins | Secrets sent in clear (of 4) | Personal data sent to cloud (of 6) | Claude cost | Savings | Avg latency |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Always cloud (Claude only) | 0% | 8.89 | 0 | 26 | 4 | 6 | $1.925 | 0% | 12.2s |
| Always local (Gemma only) | 100% | 6.05 | 48 | 0 | 0 | 0 | $0.000 | 100% | 30.8s |
| Keyword router (v1) | 18% | 8.57 | 7 | 20 | 4 | 4 | $1.678 | 13% | 14.7s |
| Gemma triage router (v2) | 51% | 7.99 | 18 | 6 | 0 | 0 | $1.555 | 19% | 22.8s |
| **Motkra router (v3)** | 41% | 8.18 | 14 | 10 | 0 | 0 | $1.630 | 15% | 16.8s |
| Oracle (upper bound) | 43% | 8.55 | 6 | 0 | 0 | 0 | $1.616 | 16% | 19.8s |

- **Bad local answers**: kept local, but the local answer was not good enough (quality lost).
- **Missed local wins**: sent to Claude although the local answer was good enough (money lost).
- **Secrets sent in clear**: credentials, keys or card numbers that reached the cloud unredacted. v2 and v3 replace them with placeholders (`[PASSWORD_1]`) before any cloud call and restore them locally.
- **Personal data**: health, finances, HR or family details. No placeholder keeps such a request meaningful, so v2 and v3 keep it local (the CLI offers `/cloud` if the user prefers Claude's answer).
- **v2** asks the local model to triage each request (one extra local call). **v3** routes by request intent with bilingual rules and costs no model call.
- **Oracle** knows the grades in advance: the ceiling for any router with this local model.

## Where the local model is good enough (dev + holdout)

| Category | Tasks | Local good enough | Avg local score | Avg Claude score | Avg local latency | Avg Claude latency |
|---|---:|---:|---:|---:|---:|---:|
| quick_fact | 14 | 71% | 8.0 | 8.5 | 4.0s | 4.5s |
| email | 14 | 71% | 7.9 | 9.1 | 13.5s | 2.5s |
| rewrite_summarize | 11 | 64% | 6.7 | 8.7 | 18.6s | 3.7s |
| reasoning | 11 | 45% | 6.7 | 8.6 | 38.0s | 7.3s |
| code_small | 14 | 29% | 6.6 | 9.0 | 19.8s | 7.7s |
| explain | 11 | 9% | 5.1 | 9.3 | 12.7s | 17.6s |
| code_complex | 13 | 0% | 3.5 | 9.2 | 88.9s | 42.3s |
| private | 15 | 0% | 4.5 | 8.6 | 40.7s | 12.6s |

## Local model variants (dev set)

| Local variant | Tasks | Local good enough | Avg local score | Avg output tokens | Avg local latency |
|---|---:|---:|---:|---:|---:|
| shared assistant prompt, thinking on (Gemma default) | 74 | 30% | 6.01 | 987 | 64.7s |
| concise local prompt, thinking on | 74 | 39% | 6.08 | 511 | 34.2s |
| concise local prompt, thinking off | 74 | 27% | 5.41 | 96 | 7.4s |
| concise local prompt, thinking auto ← active | 74 | 35% | 6.05 | 457 | 30.8s |

## Largest local misses

- **cs10** (code_small) local 1 vs Claude 10: The comprehension keeps x where x % 3 == 0 and x % 2 is truthy. x % 2 is truthy only for odd numbers, so the result is odd multiples of 3: [3, 9, 15].  Claude gets this right. It explains how the truthiness of `x % 2` works and why 0 is excluded. It also offers a clearer explicit form and a correct alternative, range(3
- **cc09** (code_complex) local 2 vs Claude 10: Local's fix is broken. `this.update.bind(this)` creates a new function reference, so `removeEventListener` removes nothing. The original anonymous arrow listener is never stored either, so the leak remains. The explanation is roughly right but the code is wrong, and the example calls destroy right after creation.  Clau
- **cc10** (code_complex) local 2 vs Claude 10: Local has fatal bugs. The tokenizer checks `char in '+-*/()'` before its `elif char == '-'` unary branch, so that branch is unreachable and unary minus is never handled. For '-5+10', evaluation pops '-' with only one value on the stack, raising an IndexError. Tests 3 and 6 therefore crash. Even if the unary branch were
- **cc04** (code_complex) local 2 vs Claude 9: Claude is correct and robust. It holds the semaphore per attempt, retries up to 3 times with exponential backoff and jitter, separates retryable from permanent errors, and prints a detailed failure report. It demonstrably does what was asked, and the design notes are useful. The only minor concern is length, but it is 
- **cc08** (code_complex) local 2 vs Claude 9: Claude is a complete, idiomatic implementation. It uses lazy refill, a mutex, an injectable clock, Allow/AllowN/Wait/WaitN with context handling and reservation rollback, and thorough deterministic tests plus a benchmark. There are minor nits. The deadline check uses time.Until rather than the injected clock, and retur
- **ex04** (explain) local 2 vs Claude 9: Claude is accurate and thorough. It gives the four Bell states correctly, along with the circuit that creates them. It explains maximal entanglement in several consistent ways: the state cannot be factored, the reduced state is maximally mixed, the entropy is 1 ebit, the Schmidt coefficients are equal, and it reaches t
- **h_pv1** (private) local 2 vs Claude 9: Local is generic. It misses the actual bug: the typo `decode_response` should be `decode_responses`. It is unhelpful and misleading.  Claude finds the typo, and it is correct that kwargs pass through to the connection class and error lazily on the first command. In redis-py, from_url passes kwargs to ConnectionPool.fro
- **cc02** (code_complex) local 3 vs Claude 9: Claude explains the check-then-act race clearly with an interleaving. Its fix, UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *, is the standard, correct Postgres job-queue pattern. It adds a sensible partial index and a correct conditional-UPDATE alternative with an accurate note on re-eva

## Method and caveats

- Tasks live in `bench/tasks.py`; all personal data and credentials in them are fake.
- Claude grades its own answers, which may favour Claude; the local numbers are conservative.
- Latency is wall-clock: the local model on the machine above, warmed up first; Claude over the network. v2 latency includes its local triage call. Local results only compare within one machine (`bench/results/<machine>/`).
- Cost uses $4.0/M input and $20.0/M output tokens (thinking tokens included). All grading on this machine so far cost $4.91, not included above.
- Small samples: treat differences of a few tasks as noise.
- Reproduce: `python bench/run.py` (cached; only new tasks, prompts or models are paid for).
