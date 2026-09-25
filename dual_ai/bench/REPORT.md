# Motkra routing benchmark

**74 real-world tasks**, answered by **gemma4:e2b** (local, Ollama) and **claude-opus-5-5** (cloud), graded blind 1–10 by claude-opus-5-5. A local answer counts as *good enough* when it scores ≥ 7 and is at most 1 point behind Claude's. 10 tasks contain private data (secrets, health, finances) that should never leave the machine.

## Routers

| Router | Kept local | Avg quality | Bad local answers | Missed local wins | Private data sent to cloud | Claude cost | Savings | Avg latency |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Always cloud (Claude only) | 0% | 9.03 | 0 | 21 | 10/10 | $1.925 | 0% | 12.2s |
| Always local (Gemma only) | 100% | 6.01 | 52 | 0 | 0/10 | $0.000 | 100% | 64.7s |
| Keyword router (current) | 18% | 8.64 | 6 | 15 | 8/10 | $1.678 | 13% | 19.4s |
| Keyword + privacy scan | 23% | 8.36 | 10 | 15 | 4/10 | $1.605 | 17% | 22.2s |
| **Motkra smart router** | 74% | 7.24 | 34 | 1 | 2/10 | $1.273 | 34% | 47.4s |
| Oracle (upper bound) | 42% | 8.36 | 9 | 0 | 0/10 | $1.591 | 17% | 26.5s |

- **Bad local answers**: kept local, but the local answer was not good enough (quality lost).
- **Missed local wins**: sent to Claude although the local answer was good enough (money and privacy lost).
- **Oracle** is a perfect router that knows the grades in advance: the ceiling for any router with this local model.

## Where the local model is good enough

| Category | Tasks | Local good enough | Avg local score | Avg Claude score | Avg local latency | Avg Claude latency |
|---|---:|---:|---:|---:|---:|---:|
| email | 10 | 70% | 8.4 | 9.2 | 20.2s | 2.9s |
| quick_fact | 10 | 50% | 6.8 | 8.9 | 37.9s | 4.2s |
| reasoning | 8 | 50% | 6.5 | 9.4 | 64.1s | 7.3s |
| rewrite_summarize | 8 | 38% | 6.9 | 8.6 | 33.4s | 4.0s |
| code_small | 10 | 20% | 5.5 | 9.1 | 60.9s | 7.0s |
| private | 10 | 10% | 4.5 | 8.6 | 62.8s | 11.9s |
| code_complex | 10 | 0% | 3.9 | 9.2 | 142.2s | 40.3s |
| explain | 8 | 0% | 5.9 | 9.2 | 95.9s | 18.4s |

## Largest local misses

- **cs10** (code_small) local 2 vs Claude 10: The key point is how `x % 2` behaves as a condition: it is truthy when x is odd, so the filter keeps odd multiples of 3.  Answer A gets this backwards. It reads `x % 2` as selecting even numbers, which leads it to the wrong result, [0, 6, 12, 18]. The correct result is [3, 9, 15]. Because it gives t
- **cc01** (code_complex) local 2 vs Claude 9: Answer A has a fatal eviction bug. It sets `lru_node = self.head.next.prev`, which is always the dummy head itself, not the least-recently-used node. `_remove_node(head)` then dereferences `head.prev`, which is None, raising an AttributeError. Its own test crashes at `put(3, 30)`. Because the core f
- **cc06** (code_complex) local 3 vs Claude 10: Answer A changes the input contract without justification. It switches from a dict keyed by name to a list of dicts and invents a 'k' field inside each item. Its note says the original implied this, which is a misreading. It also changes semantics: int(float(v)) accepts strings like "2.5" that the o
- **cc10** (code_complex) local 2 vs Claude 9: Answer A has a critical bug. In the tokenizer, the `char in '+-*/()'` branch catches '-' before the unary-minus branch, so that branch is dead code. Even if the special 'U-' token were emitted, it is not in `self.precedence`, so it would be ignored. As a result, expressions like "-5 + 10" fail: they
- **re06** (reasoning) local 2 vs Claude 9: Answer A recommends (user_id, fecha), which is correct: equality first, then the range column, which also matches the ORDER BY. The explanation is clear and accurate, and it adds useful extras: covering index, DESC ordering, keyset pagination, edge cases, EXPLAIN checks, and CONCURRENTLY. One small 
- **pv02** (private) local 3 vs Claude 10: The bug in the user's code is the keyword argument: it is written as `header=` when requests expects `headers=`.  Answer A wrongly claims the code is syntactically correct and never points out the actual bug. Its corrected code does use `headers=`, but it doesn't explain the change. It also blames t
- **pv03** (private) local 2 vs Claude 9: Answer A contains clear factual errors. It calls an HbA1c of 6.9% 'normal', when that value is in the diabetes range; it is only near the treatment target. It also places a fasting glucose of 131 mg/dL in the prediabetes range, even though its own table lists 126 or higher as diabetes. These mistake
- **cc02** (code_complex) local 3 vs Claude 9: Answer A explains the race correctly with a clear interleaving. Its fix, a single UPDATE whose subquery uses FOR UPDATE SKIP LOCKED with RETURNING, is the standard correct Postgres job-queue pattern. It also offers a correct conditional-UPDATE alternative, a partial index, and sound notes on crashed

## Method and caveats

- Tasks live in `bench/tasks.py`; all personal data in them is fake.
- Claude grades its own answers, which may favour Claude; the local numbers are therefore conservative.
- Latency is wall-clock on this machine for the local model and over the network for Claude; the local model is warmed up first.
- Cost uses $4.0/M input and $20.0/M output tokens (thinking tokens included). Grading cost $1.29, not included above.
- Reproduce: `python bench/run.py` (cached; only new tasks or models are paid for).
