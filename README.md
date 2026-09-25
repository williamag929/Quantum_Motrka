# Motkra — Dual-AI Assistant Ecosystem

> **Run Claude and a local Gemma 4 model side-by-side — Motkra picks the right one automatically, across CLI, VS Code, Chrome, and your system tray.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Python](https://img.shields.io/badge/Python-3.10%2B-blue)
![Node](https://img.shields.io/badge/Node-18%2B-green)

---

## Why Motkra?

Most developers pick one AI assistant and live with its trade-offs: cloud models are powerful but slow and expensive for short queries; local models are fast and private but struggle with complex tasks. **Motkra eliminates that choice.**

It scores every prompt in real-time and routes it automatically:

- Short or simple → **Gemma 4 (local, instant, free, private)**
- Complex, creative, or multi-step → **Claude (cloud, powerful)**
- You can override at any time with `/local`, `/cloud`, or `--local` / `--cloud` flags

All five entry points — Python CLI, VS Code extension, Chrome overlay, Electron system-tray daemon, and Claude Desktop MCP server — share the same routing logic and a single API key.

---

## Demo

<!-- Replace the line below with a real GIF/screenshot once you have one -->
<!-- ![Motkra demo](docs/demo.gif) -->

> 📸 _Screenshot / GIF coming soon. To contribute one: record a short terminal or UI session and open a PR adding it to `docs/`._

---

## Quick Start

**Prerequisites:** Python 3.10+, Node 18+, [Ollama](https://ollama.com) running locally with `gemma4:e2b` pulled, an [Anthropic API key](https://console.anthropic.com/).

```bash
# 1. Clone
git clone https://github.com/williamag929/Quantum_Motrka.git
cd Quantum_Motrka

# 2. Set your API key
cp dual_ai/.env.example dual_ai/.env
# Edit dual_ai/.env and add:  ANTHROPIC_API_KEY=sk-ant-...

# 3. Start the Python CLI (simplest entry point)
cd dual_ai
pip install -r requirements.txt
python main.py
```

**Example session:**

```
You: what is 2+2       →  Gemma 4 (local) answers instantly
You: write a haiku about recursion  →  Claude answers
You: /local            →  force all queries to Gemma 4
You: /auto             →  back to smart routing
```

For the VS Code extension, Chrome extension, system-tray daemon, or MCP server, see the component sections below.

---

## Repository Layout

```
Quantum/
├── dual_ai/          Python CLI — interactive dual-model REPL
├── dual_ai_ext/      VS Code extension — sidebar agent panel
├── motkra-browser/   Chrome extension — AI overlay on any webpage
├── motkra-daemon/    Electron daemon — system tray + email agent + HTTP API
├── motkra-mcp/       MCP server — expose Ollama to Claude Desktop
└── bell_state/       Qiskit bell-state experiments (standalone)
```

---

## Architecture

```
motkra-browser  ──┐                            ┌──► Anthropic API    (Claude)
                  │  HTTP :7432                │
dual_ai_ext    ──►  motkra-daemon ────────────┤
                  │                            └──► Ollama :11434    (Gemma 4)
                  │  stdio / TCP :3333
motkra-mcp     ◄──┘  ◄── Claude Desktop / any MCP client

dual_ai (CLI)  ─────────────────────────────► Anthropic API / Ollama / NVIDIA API (direct)

motkra-daemon  ──► Gmail API (OAuth2)   Email agent: read → triage → reply
```

All components share API keys stored in `dual_ai/.env`. The daemon exposes a local HTTP API so the browser and VS Code extensions never need the keys directly.

**Routing.** The CLI uses the privacy-aware router v3 described below. The other components still use the original keyword scoring (complex prompts → Claude, short ones → Gemma 4; tie-break ≤ 8 words → local). Kimi is available only in the CLI, selected with `/kimi` or `--kimi`.

---

## Components

### `dual_ai/` — Python CLI

Interactive REPL with streaming responses, privacy-aware routing and usage stats.

```powershell
cd dual_ai
pip install -r requirements.txt
copy .env.example .env        # add ANTHROPIC_API_KEY and NVIDIA_API_KEY; DEFAULT_MODE picks the default
python main.py                # DEFAULT_MODE from .env (auto unless changed)
python main.py --local        # force Gemma 4
python main.py --cloud        # force Claude
python main.py --kimi         # force Kimi (NVIDIA)
python -m pytest              # unit tests
python bench/run.py           # routing benchmark
```

In-session commands: `/auto` `/local` `/cloud` `/kimi` `/stats` `/clear` `/history` `/quit`

How auto mode decides (no model call, no added latency):

1. **Secrets are redacted.** Passwords, API keys, tokens, connection-string passwords and card numbers become placeholders such as `[PASSWORD_1]` or `[CARD_1 ending 1111]` before anything leaves the machine, in every mode including `/cloud`. Answers are restored locally, even while streaming.
2. **Personal topics stay local.** Health, money, HR, legal and family requests (English and Spanish) are answered by the local model with a prompt tuned for them. Once a conversation has a private turn it stays local; `/cloud` is one command away if you prefer Claude's answer.
3. **Intent decides the rest.** Classifying, translating, summarizing, short replies and quick facts run locally; writing or explaining code, calculations and design go to Claude.
4. **The local model skips its hidden reasoning** on one-line questions and label-only requests (same quality, ~5× faster on CPU).

`/stats` shows the local share, private requests kept local, redactions, Claude spend and estimated savings (persisted in `~/.motkra/cli_stats.json`).

Requires:
- **Ollama** running locally (`ollama serve`) with the model in `GEMMA_MODEL` pulled (default `gemma4:e2b`)
- **ANTHROPIC_API_KEY** in `.env` for Claude
- **NVIDIA_API_KEY** in `.env` for Kimi (optional; the free tier is slow)

#### Benchmark results (CPU-only desktop, holdout set)

| | Claude only | Motkra router |
|---|---:|---:|
| Requests kept on the machine | 0% | 45% |
| Private requests sent to the cloud in clear | 5 of 5 | 0 of 5 |
| Average quality (1–10, blind) | 8.83 | 8.03 |
| Average quality on non-private requests | 8.83 | 8.38 |
| Claude bill | 100% | 80% |
| Average latency | 12.3 s | 19.7 s |

The router sits close to the oracle ceiling (8.21 quality at 48% local), so on this hardware the local model, not the routing, is the limit. The local requests are the short ones, which is why 45% of requests save only 20% of the bill. One rule was fixed after the holdout was scored ("código de estado HTTP" no longer counts as a coding request); before that fix the holdout read 41% local, 8.10 quality, 18% savings. Full report, including a failed experiment (a local-model triage router: slower and no better than the rules), in [`dual_ai/bench/reports/`](dual_ai/bench/reports/).

---

### `dual_ai_ext/` — VS Code Extension

Sidebar chat panel with an agentic loop that can read, write, and patch workspace files.

```powershell
cd dual_ai_ext
npm install
# Open dual_ai_ext/ in VS Code → F5 → Extension Development Host
# Toggle panel: Ctrl+Shift+J
```

Build a `.vsix` for permanent install:

```powershell
npm install -g @vscode/vsce
vsce package --no-dependencies
```

Agent tools available to Claude: `read_file`, `write_file`, `str_replace`, `list_files`.
Reads the API key from `../dual_ai/.env`.

---

### `motkra-browser/` — Chrome Extension

Injects a floating chat button into every page. Streams responses from the daemon. Includes GitHub-aware context extraction (PR titles, diffs, issue bodies).

```
chrome://extensions → Enable Developer mode → Load unpacked → select motkra-browser/
```

Requires the daemon running on port 7432 (configurable via extension popup).

---

### `motkra-daemon/` — Electron Daemon

Runs in the system tray. Exposes an HTTP API for the browser and VS Code extensions, provides a global hotkey (`Ctrl+Shift+Space`) floating chat window, and runs an AI email agent that monitors your Gmail inbox.

```powershell
cd motkra-daemon
npm install
npm start                     # dev mode

npm run build:win             # Windows installer
npm run build:mac             # macOS DMG
npm run build:all             # all platforms
```

**API endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/status` | Health check |
| POST | `/query` | Chat (streaming SSE or one-shot JSON) |

Reads `ANTHROPIC_API_KEY` from (in order): `~/.motkra/.env`, `../dual_ai/.env`, `%APPDATA%/Motkra/.env`.

#### Email Agent

The daemon can monitor your Gmail inbox, triage every message with Claude, and reply autonomously — with the right level of autonomy per person based on a configurable trust level.

**Setup:**

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials → Create OAuth 2.0 Client ID (Desktop app type). Download the JSON and save it to:
   ```
   ~/.motkra/gmail-credentials.json
   ```

2. Add these to `~/.motkra/.env` to activate:
   ```env
   MOTKRA_EMAIL_ENABLED=1
   MOTKRA_EMAIL_INTERVAL=120        # poll every 120 seconds
   MOTKRA_EMAIL_THRESHOLD=6         # min confidence for auto-send at trust level 5
   ```

3. On first start the daemon opens your browser for Gmail OAuth consent. Tokens are saved to `~/.motkra/gmail-tokens.json` and refreshed automatically.

4. Define your trusted contacts at `~/.motkra/email-contacts.json`:
   ```json
   [
     { "email": "mom@gmail.com",     "name": "Mom",   "trust": 5 },
     { "email": "partner@gmail.com", "name": "Laura", "trust": 5 },
     { "email": "brother@gmail.com", "name": "Carlos","trust": 4 },
     { "email": "boss@work.com",     "name": "Jorge", "trust": 3 }
   ]
   ```

**Trust × Confidence decision matrix:**

| Trust | Meaning | Action |
|-------|---------|--------|
| **5** — Closest (spouse, parent) | Auto-send if Claude confidence ≥ 6 | Send immediately, notify you after |
| **4** — Close family / best friends | Auto-send if confidence ≥ 8 | Send immediately, notify you after |
| **3** — Extended family / colleagues | Any confidence | Send you an approval email first |
| **2** — Acquaintances / work | Any confidence | Desktop notification window only |
| **1–0** — Unknown | Any confidence | Silent queue (seen in briefing) |

**Approval-by-email loop:** For trust-3 senders, Motkra emails *you* at your own address with the draft and a `Reply YES / NO / <your own text>` instruction. You approve from your phone, in Gmail, anywhere — no need to be at your desk.

**Notification window:** For trust-2 senders, a frameless Electron window appears in the bottom-right corner showing the sender, subject, Claude's draft, and a confidence bar. Hit **Send** (optionally editing the draft first), **Ignore**, or **Flag ⚑** for manual follow-up. Auto-dismisses after 60 seconds.

**Triage logic:** Claude classifies each email as `spam` (auto-archive), `ignore`, `reply` (draft generated), or `flag` (urgent escalation). Spam is archived silently. Flagged emails trigger an immediate notification regardless of trust level.

You can also toggle the email agent from the system tray → **Email Agent** submenu without restarting the daemon.

---

### `motkra-mcp/` — MCP Server

A zero-dependency Node.js process that speaks the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP 2024-11-05) over stdio. It exposes your local Ollama models as tools that Claude Desktop (and any other MCP client) can call — keeping your inference on-device while using Claude for reasoning.

```powershell
cd motkra-mcp
node index.js                # run directly (stdio MCP)
```

**Tools exposed:**

| Tool | Description |
|------|-------------|
| `ollama_chat` | Send a message to any local Ollama model and get a response |
| `ollama_list_models` | List all models currently available on this machine |

**Connect Claude Desktop:**

Add to `~/.claude/claude_desktop_config.json` (create if it doesn't exist):

```json
{
  "mcpServers": {
    "motkra": {
      "command": "node",
      "args": ["C:/Projects/Python/Quantum/motkra-mcp/index.js"]
    }
  }
}
```

Restart Claude Desktop. You can now ask Claude to "use the `ollama_chat` tool with model `gemma4:e2b`" to run local inference from within Claude Desktop conversations.

**Auto-start from VS Code extension:**

Set `motkra.mcpServer: true` in VS Code settings. The extension spawns the MCP server on activation and also opens a TCP port (default `3333`, configurable via `motkra.mcpPort`) for non-stdio clients.

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `MOTKRA_MCP_PORT` | _(none)_ | If set, also listen on this TCP port |
| `OLLAMA_HOST` | `localhost` | Ollama hostname |
| `OLLAMA_PORT` | `11434` | Ollama port |

---

### `bell_state/` — Qiskit Experiments

Standalone quantum computing demo — Bell state circuit, statevector simulation, shot-based sampling.

```powershell
cd bell_state
pip install -r requirements.txt
python bell.py
pytest -q
```

---

## Shared `.env`

The single source of truth for secrets lives at `dual_ai/.env` (also loaded by the daemon from `~/.motkra/.env`):

```env
# Required
ANTHROPIC_API_KEY=sk-ant-...

# Daemon (optional)
MOTKRA_DAEMON_PORT=7432
MOTKRA_HOTKEY=CommandOrControl+Shift+Space

# Email agent (optional — requires gmail-credentials.json)
MOTKRA_EMAIL_ENABLED=1           # set to 1 to activate
MOTKRA_EMAIL_INTERVAL=120        # poll interval in seconds
MOTKRA_EMAIL_THRESHOLD=6         # min confidence for auto-send at trust 5
```

---

## Claude SDK conventions

All JS/Python components use the same settings:

| Setting | Value |
|---------|-------|
| Model | `claude-opus-4-7` |
| Thinking | `{type: "adaptive"}` |
| Effort | `xhigh` (JS) / `high` (Python) |
| Cache | `cache_control: {type: "ephemeral"}` on system prompt |
| Streaming | `client.messages.stream()` |
