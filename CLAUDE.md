# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Layout

This workspace contains two independent sub-projects plus a legacy quantum-computing experiment:

```
Quantum/
├── dual_ai/          Python CLI — interactive dual-model chat (Claude + Gemma 4)
├── dual_ai_ext/      VS Code extension — sidebar agent panel backed by dual_ai
└── bell_state/       Qiskit bell-state experiments (separate, unrelated to dual_ai)
```

The extension (`dual_ai_ext`) and CLI (`dual_ai`) share one `.env` file located at `dual_ai/.env`. The extension loads it via `dotenv` from a relative path (`../dual_ai/.env`).

---

## dual_ai — Python CLI

### Setup & run

```powershell
cd dual_ai
pip install -r requirements.txt       # anthropic, ollama, python-dotenv, requests
copy .env.example .env                # then edit .env with your key
python main.py                        # auto-routing mode
python main.py --local                # force Gemma 4
python main.py --cloud                # force Claude
python main.py --kimi                 # force Kimi (NVIDIA)
python -m pytest                      # unit tests
python bench/run.py                   # routing benchmark
```

Requires Ollama running locally (`ollama serve`) with `gemma4:e2b` pulled.

### Architecture

Local-first: the local model answers what it can; Claude (or Kimi) gets the rest. Secrets never leave in clear and personal requests stay local.

- `config.py` — loads `dual_ai/.env` itself; model IDs (`CLAUDE_MODEL`, `GEMMA_MODEL`, `KIMI_MODEL`), `DEFAULT_MODE`, `LOCAL_THINK` (`auto`/`on`/`off`), Claude prices, and the system prompts (`SYSTEM_PROMPT` for cloud, `LOCAL_SYSTEM_PROMPT` concise for the local model, `PERSONAL_SYSTEM_PROMPT` for personal requests kept local)
- `privacy.py` — `scan()` detects secrets; `redact()`/`restore()` swap them for placeholders like `[PASSWORD_1]` with one session-wide mapping; `StreamRestorer` restores placeholders in streamed output; `REDACTION_NOTE` tells cloud models what placeholders mean
- `router.py` — `smart_route()` (v3): redact → `looks_personal()` bilingual lexicon keeps personal topics local → `intent_route()` bilingual intent rules. No model call. `quick_answer()` decides when the local model can skip its hidden reasoning. `route()` (keyword v1) and `triage()` (Gemma triage v2) remain for benchmark comparison
- `claude_client.py` / `gemma_client.py` / `kimi_client.py` — each exposes `generate(messages, system, on_text) -> Reply(text, input_tokens, output_tokens)` and `ask()` for streaming to stdout. Gemma resolves `think` per message via `should_think()`; Kimi is raw `requests` SSE against NVIDIA's OpenAI-compatible endpoint
- `stats.py` — per-session and all-time counters in `~/.motkra/cli_stats.json` (local share, private kept local, redactions, Claude spend, estimated savings)
- `main.py` — REPL. Cloud payloads are always redacted and exclude private turns; once a conversation has a private turn, auto mode keeps it local. Commands `/auto /local /cloud /kimi /stats /clear /history /quit`
- `bench/` — routing benchmark (see `bench/README.md`): `python bench/run.py`, report in `bench/reports/<machine>.md`. Results are cached per machine in `bench/results/<machine>/`; cloud answers are shared in `bench/results/cloud_answers.jsonl`
- Tests: `cd dual_ai && python -m pytest` (pure-function tests for privacy and routing)

---

## dual_ai_ext — VS Code Extension

### Setup & run

```powershell
cd dual_ai_ext
npm install
# Open dual_ai_ext/ folder in VS Code, press F5 → Extension Development Host
```

To build a permanent `.vsix`:

```powershell
npm install -g @vscode/vsce
vsce package --no-dependencies
# Install from VSIX via the Extensions panel
```

### Architecture

The extension registers a single `WebviewViewProvider` (`DualAIProvider`) that owns all state:

- **`extension.js`** — `DualAIProvider` class: session management (Map of `{name, history[]}`), agent selection, editor context injection (file/selection auto-attached to each message), webview message routing. Entry point for VS Code lifecycle.
- **`agent.js`** — Claude agentic loop using `@anthropic-ai/sdk` streaming + `stream.finalMessage()`. Runs up to 10 tool-call iterations. Converts system prompt string → `[{type:'text', text, cache_control}]` array before each request.
- **`router.js`** — same keyword-scoring logic as the Python router; shared `CLOUD_HINTS` and `LOCAL_HINTS` arrays. Tie-break on word count ≤ 8.
- **`clients/gemma.js`** — raw `http.request` to Ollama NDJSON streaming on port 11434.
- **`agents.js`** — scans workspace for agent definition files (`.github/copilot-instructions.md`, `.github/agents/`, `.agents/`, `CLAUDE.md`, `architect.yml`). Parses optional YAML frontmatter (`name:`, `description:`) from `.md` files. The resulting agent list populates the extension's agent selector; each agent supplies an alternative system prompt to `agent.js`.
- **`media/panel.html`** — self-contained chat UI (vanilla JS, no bundler).

### Claude tools available to the agent

`read_file`, `write_file`, `str_replace`, `list_files` — all resolved relative to the workspace root of the Extension Development Host window.

### Agent file format

Custom agents can be defined in `CLAUDE.md` (this file), `.github/agents/*.md`, or `architect.yml`. Markdown files support optional frontmatter:

```markdown
---
name: My Agent
description: What it does
---
System prompt text here.
```

---

## Claude SDK conventions (both sub-projects)

- Model: `claude-opus-4-7` (JS extension) / `CLAUDE_MODEL` from `.env`, default `claude-opus-5-5` (Python CLI)
- Thinking: `{type: "adaptive"}` — no `budget_tokens`
- Effort: `output_config: {effort: "xhigh"}` (JS agent) / `{"effort": "high"}` (Python CLI)
- Cache: `cache_control: {type: "ephemeral"}` placed on the system prompt content block, not at top level
- Streaming: `client.messages.stream()` + `stream.finalMessage()` (JS); `_client.messages.stream()` as context manager (Python)

---

## bell_state — Qiskit experiments

```powershell
cd bell_state
pytest                # run all tests
```

Tests live in `bell_state/` following `test_*.py`. Uses `bell_lib.py` (library) + `bell.py` (script). Follow PEP 8, use type hints and docstrings.
