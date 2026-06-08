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
pip install -r requirements.txt       # anthropic, ollama, python-dotenv
copy .env.example .env                # then edit .env with your key
python main.py                        # auto-routing mode
python main.py --local                # force Gemma 4
python main.py --cloud                # force Claude
```

Requires Ollama running locally (`ollama serve`) with `gemma4:e2b` pulled.

### Architecture

- `config.py` — single source of truth for model IDs (`CLAUDE_MODEL`, `GEMMA_MODEL`) and routing keyword sets (`LOCAL_HINTS`, `CLOUD_HINTS`)
- `router.py` — scores LOCAL_HINTS vs CLOUD_HINTS in the user message; tie-break on word count ≤ 8 → local
- `claude_client.py` — Anthropic SDK streaming with adaptive thinking, `output_config.effort`, and system-prompt-level cache_control
- `gemma_client.py` — `ollama.chat()` streaming; injects system prompt as a leading system message
- `main.py` — REPL loop; in-session commands `/local`, `/cloud`, `/auto`, `/clear`, `/quit`

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

- Model: `claude-opus-4-7`
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
