# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Layout

This workspace contains two independent sub-projects plus a legacy quantum-computing experiment:

```
Quantum/
├── dual_ai/          Python CLI + privacy brain / desktop daemon (Claude + Gemma 4 + Kimi)
├── dual_ai_ext/      VS Code extension — sidebar agent panel backed by dual_ai
├── motkra-daemon/    Electron tray app — global-hotkey chat window, Gmail agent; routes through the dual_ai brain
├── motkra-browser/   Browser extension — talks to motkra-daemon on 127.0.0.1:7432
├── motkra-mcp/       MCP server: local Ollama models + motkra_digest for Claude Code (.mcp.json)
└── bell_state/       Qiskit bell-state experiments (separate, unrelated to dual_ai)
```

`MOTKRA_PLAN.md` is the phased roadmap.

### motkra-daemon (Electron)

`npm start` / `npm test` (node:test). Owns port 7432 (VS Code + browser extensions). On startup `brain.js` spawns `python ../dual_ai/daemon.py --headless` on 7433 (`MOTKRA_PYTHON`, `MOTKRA_BRAIN_PORT` override) and every query goes through `/route`: the brain picks local vs cloud, redacts secrets and drops private turns; Electron streams the reply, restores placeholders, restores them in tool inputs and redacts tool output through `/redact` (fails closed). If the brain is unreachable it falls back to the keyword router, and never sends a conversation already marked private to the cloud. Both Python processes use `../.venv/Scripts/python.exe` when it exists. Voice (`voice.js`) spawns `dual_ai/voice_worker.py` once (Whisper STT, Piper TTS, JSON lines on stdin/stdout); if it is unavailable, dictation falls back to `voice/stt-win.ps1` and replies to the browser `speechSynthesis`. The HTTP server accepts only requests without Origin or from browser extensions.

Model providers (⚙ in the chat, `/settings`; `settings.js`, saved in `~/.motkra/settings.json`): Ollama, Claude and NVIDIA (Kimi, `kimi.js`) can each be turned on or off, plus a preferred cloud. A provider without its API key is unavailable. `settings.pickProvider()` applies the choice after the brain routes: Ollama paused → non-private requests go to the preferred cloud; a private conversation is blocked with a message, never sent to the cloud; tool requests prefer Claude; forced modes (`/local`, `/cloud`, `/kimi`) are refused, not swapped, when off. When the engine's destination differs from the plan's, `ipc.js` asks the brain for a new plan for that destination (fails closed), so cloud payloads are always redacted. Pausing Ollama unloads the model (`keep_alive: 0`) and the brain skips its warm-up (`MOTKRA_SKIP_LOCAL_WARMUP`).

Agent tools (chat window, Claude only; `ipc.js` `runAgentTool`), all behind one consent modal (`/permissions`, `/forget`):
- `fs-tools.js` — folders: list/read/write, per-folder grants; `.env`, keys and `~/.ssh`-style dirs are never shared.
- `console-tools.js` — `run_command`: no shell (refuses `& | ; < >`), `.cmd` programs via a quoted `cmd /c` that refuses `"%^&|<>!`. Tiers: read (status/version, auto inside a read-granted folder) → run (approval, rememberable per exact command + folder) → destructive (deletes, pushes, system tools, PowerShell: approval every time). Child env drops `*KEY*/*TOKEN*/*SECRET*` vars.
- `browser.js` — Motkra Browser: Chromium window, `persist:motkra-browser` partition, sandboxed, no preload, permissions and downloads refused. `browse`/`act` grants per origin. Page text is wrapped in `<untrusted_web_content>` (closing tag defanged). Never types into password or payment fields, and placeholders are never restored in browser inputs.
- `grant-store.js` — shared once/session/always grant + audit store (`~/.motkra/*-permissions.json`, `*-audit.jsonl`).
- Requests that ask to act (`needsTools`) go to Claude even if the router picked local, unless the conversation is private.
- `npm run test:browser` drives the real browser against a local page (`scripts/browser-smoke.js`). `scripts/electron.js` launches Electron without `node_modules/.bin` and clears `ELECTRON_RUN_AS_NODE` (set in VS Code terminals).

### motkra-mcp (delegating work from Claude Code)

`npm test` (node:test). Registered in `.mcp.json`, so Claude Code sessions here get `motkra_digest` / `motkra_result`: the local model (`MOTKRA_MCP_MODEL`, default `gemma4:e2b`) reads workspace files itself (line-numbered, map-reduce over ~24k-char chunks) and returns a short answer citing `path:line`, redacted by `dual_ai/privacy.py` (fails closed). Past `wait_seconds` (max 50 s, since some clients drop tool calls at 60 s) the digest becomes a background job. Jobs live on disk (`~/.motkra/mcp-jobs/<id>.json`, `disk-jobs.js`) and each runs in a detached `worker.js`, so any server instance can collect any job even after the one that started it was restarted (Claude Desktop runs several instances); a `.lock` file keeps jobs one at a time across instances, and a dead worker marks its job failed. Tests use the in-memory `jobs.js` queue.

When to use it: logs or outputs too long to read where you only need the conclusion — redirect command output to a file, then digest it with a `pattern` (e.g. `"error|fail|traceback"`). On this CPU-only machine a filtered digest takes about a minute and an unfiltered one 2–4 minutes per chunk, so pass `wait_seconds: 0` and keep working. Treat answers as leads and check anything you act on; don't delegate reasoning or code changes.

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
- `session.py` — one conversation: `Session.ask()` applies the privacy rules (cloud payloads are always redacted and exclude private turns; once a conversation has a private turn, auto mode keeps it local). `plan()` is the stateless version for callers that keep their own history (the Electron app)
- `main.py` — REPL on top of `Session`. Commands `/auto /local /cloud /kimi /stats /clear /history /quit`
- `daemon.py` — desktop daemon and "privacy brain". `python daemon.py` = tray + push-to-talk hotkey + local voice + localhost API; `--headless` = API only (what `motkra-daemon` spawns). API on `DAEMON_PORT` (7433): `/status`, `/ask`, `/route`, `/redact`, `/mode`, `/clear`. Refuses browser origins and non-localhost Host headers. Extras: `pip install -r requirements-daemon.txt`
- `voice.py` — faster-whisper STT, Piper TTS (first `.onnx` in `~/.motkra/voices`, else the Windows voice), `SentenceBuffer` speaks replies sentence by sentence and skips code blocks
- `voice_worker.py` — voice for the Electron app: continuous mic with an energy-gate `Segmenter` → Whisper transcripts, Piper replies, mic ignored while speaking. Polls its stdin pipe on Windows (a blocking pipe read stalls DLL loads)
- `bench/` — routing benchmark (see `bench/README.md`): `python bench/run.py`, report in `bench/reports/<machine>.md`. Results are cached per machine in `bench/results/<machine>/`; cloud answers are shared in `bench/results/cloud_answers.jsonl`
- Tests: `cd dual_ai && python -m pytest` (privacy, routing, session, voice text helpers, daemon API)

---

## dual_ai_ext — VS Code Extension

### Setup & run

```powershell
cd dual_ai_ext
npm install
# Open dual_ai_ext/ folder in VS Code, press F5 → Extension Development Host
```

To build a permanent `.vsix` (bump `"version"` in `package.json` first so VS Code treats it as an update):

```powershell
npm install -g @vscode/vsce
npm test
vsce package                                         # keep node_modules: the extension needs @anthropic-ai/sdk, dotenv…
code --install-extension motkra-<version>.vsix --force
# then Developer: Reload Window in each VS Code window
```

`.vscodeignore` keeps `.env`, `test/` and old `.vsix` files out of the package; check with `vsce ls` before installing.

### Architecture

The extension registers a single `WebviewViewProvider` (`DualAIProvider`) that owns all state:

- **`extension.js`** — `DualAIProvider` class: session management (Map of `{name, history[]}`), agent selection, editor context injection (file/selection auto-attached to each message), webview message routing. Entry point for VS Code lifecycle.
- **`agent.js`** — Claude agentic loop using `@anthropic-ai/sdk` streaming + `stream.finalMessage()`. Runs up to 10 tool-call iterations. Converts system prompt string → `[{type:'text', text, cache_control}]` array before each request.
- **`router.js`** — same keyword-scoring logic as the Python router; shared `CLOUD_HINTS` and `LOCAL_HINTS` arrays. Tie-break on word count ≤ 8.
- **`clients/gemma.js`** — raw `http.request` to Ollama NDJSON streaming on port 11434.
- **`agents.js`** — scans workspace for agent definition files (`.github/copilot-instructions.md`, `.github/agents/`, `.agents/`, `CLAUDE.md`, `architect.yml`). Parses optional YAML frontmatter (`name:`, `description:`) from `.md` files. The resulting agent list populates the extension's agent selector; each agent supplies an alternative system prompt to `agent.js`.
- **`media/panel.html`** — self-contained chat UI (vanilla JS, no bundler).

### Project rules, branch guard and providers

- **`core/project-rules.js`** — every agent's system prompt gets the workspace's `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md` plus the `.md` files they reference (one level, size-capped), the way Claude Code loads CLAUDE.md. Selecting an agent adds its prompt; it no longer replaces the project rules.
- **`core/branch-guard.js`** — before a write (`write_file`, `str_replace`) or a mutating `git` command, `_guardWrite` refuses protected branches (`motkra.protectedBranches` + the repo's default) and, with `motkra.requireWorktree` (`auto` = the rules mention worktrees), the main checkout. It offers to create Motkra's worktree under `<repo parent>/wt/` — named as the rules declare for Motkra, else after the other agents' pattern (`api-claude` → `api-motkra`), else `<repo>-motkra`; branch `motkra/<task>` from the current branch — and moves the session there (`toolOpts.root`), so the task continues in the worktree.
- **`core/provider-settings.js`** — reads the desktop app's `~/.motkra/settings.json` (Ollama / Claude / NVIDIA on-off + preferred cloud) so the panel's Auto mode respects it; a message with a detected secret only goes to the local model.

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

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.
