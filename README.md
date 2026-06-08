# Motkra — Multi-platform AI Assistant

A monorepo containing a dual-model AI assistant ecosystem that intelligently routes tasks between a local model (Gemma 4 via Ollama) and Claude (Anthropic API). Entry points span a CLI, VS Code extension, browser extension, and a system tray daemon.

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
motkra-browser  ──┐
                  │  HTTP :7432           ┌──► Anthropic API  (Claude)
dual_ai_ext    ──►  motkra-daemon ────────┤
                  │                       └──► Ollama :11434  (Gemma 4)
                  │  stdio / TCP :3333
motkra-mcp     ◄──┘  ◄── Claude Desktop / any MCP client

dual_ai (CLI)  ──────────────────────────────► Anthropic API / Ollama (direct)

motkra-daemon  ──► Gmail API (OAuth2)   Email agent: read → triage → reply
```

All components share one API key stored in `dual_ai/.env`. The daemon exposes a local HTTP API so the browser and VS Code extensions never need the key directly.

**Auto-routing logic** (shared across all components): keyword scoring sends complex/creative prompts to Claude and short/local prompts to Gemma 4. Tie-break: ≤ 8 words → local.

---

## Components

### `dual_ai/` — Python CLI

Interactive REPL with streaming responses and in-session commands.

```powershell
cd dual_ai
pip install -r requirements.txt
copy .env.example .env        # add your ANTHROPIC_API_KEY
python main.py                # auto-routing
python main.py --local        # force Gemma 4
python main.py --cloud        # force Claude
```

In-session commands: `/local` `/cloud` `/auto` `/clear` `/history` `/quit`

Requires Ollama running locally (`ollama serve`) with `gemma4:e2b` pulled.

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
