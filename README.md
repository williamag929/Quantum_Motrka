# Motkra — Multi-platform AI Assistant

A monorepo containing a dual-model AI assistant ecosystem that intelligently routes tasks between a local model (Gemma 4 via Ollama) and Claude (Anthropic API). Entry points span a CLI, VS Code extension, browser extension, and a system tray daemon.

---

## Repository Layout

```
Quantum/
├── dual_ai/          Python CLI — interactive dual-model REPL
├── dual_ai_ext/      VS Code extension — sidebar agent panel
├── motkra-browser/   Chrome extension — AI overlay on any webpage
├── motkra-daemon/    Electron daemon — system tray + HTTP API
└── bell_state/       Qiskit bell-state experiments (standalone)
```

---

## Architecture

```
motkra-browser  ──┐
                  │  HTTP :7432
dual_ai_ext    ──►  motkra-daemon ──► Anthropic API (Claude)
                                 └──► Ollama :11434   (Gemma 4)

dual_ai (CLI)  ──────────────────────► Anthropic API / Ollama (direct)
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

Runs in the system tray. Exposes an HTTP API for the browser and VS Code extensions, and provides a global hotkey (`Ctrl+Shift+Space`) floating chat window.

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

The single source of truth for secrets lives at `dual_ai/.env`:

```env
ANTHROPIC_API_KEY=sk-ant-...
MOTKRA_DAEMON_PORT=7432          # optional, default 7432
MOTKRA_HOTKEY=CommandOrControl+Shift+Space  # optional
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
