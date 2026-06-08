# Motkra Development Plan

Transforming `dual_ai` into a Motkra-grade ambient AI dev assistant.
Target: 1,000 GitHub stars. Timeline: ~8 weeks.

---

## Phase 0 — Foundation Fixes (Days 1–2)
*Must be done before any new features. These are blockers.*

- [x] **P0-1** Rename project to "Motkra" — update `package.json` `name`, `displayName`, activity bar title, README headline
- [x] **P0-2** Add `.vscodeignore` — exclude `node_modules/`, `.vscode/`, `*.vsix` from package
- [x] **P0-3** Extract Ollama host/port to VS Code settings (`motkra.ollamaHost`, `motkra.ollamaPort`) — replace hard-coded values in `clients/gemma.js`
- [ ] **P0-4** Fix README model table — still says `claude-opus-4-6`; update to `claude-opus-4-7`
- [x] **P0-5** Add keyboard shortcut `Ctrl+Shift+J` to focus the Motkra panel
- [x] **P0-6** Add VS Code setting `motkra.claudeModel` so users can override the model without editing code

---

## Phase 1 — Trust & Completeness · Tier 1 (Week 1)
*Without these, no serious developer will use an agentic tool.*

### 1A — Diff Preview Before Apply
- [x] **1A-1** Add `pendingEdits` queue to `agent.js` — when Claude calls `write_file` or `str_replace`, compute unified diff and post `{type:'diff-request', id, path, before, after}` to the webview instead of writing immediately
- [x] **1A-2** Add diff UI to `panel.html` — render unified diff with syntax highlight, Accept / Reject buttons
- [x] **1A-3** Handle `diff-accept` / `diff-reject` messages in `extension.js` — apply or discard the pending edit
- [ ] **1A-4** Add "Apply all" and "Reject all" buttons for multi-file edits

### 1B — Terminal Tool
- [x] **1B-1** Add `run_command` tool definition to `agent.js` tool registry
- [x] **1B-2** Implement `executeTool('run_command')` using `child_process.exec` with allow-list and timeout
- [x] **1B-3** Stream terminal output tokens back to panel in real time with a `⚙ terminal` prefix
- [x] **1B-4** Add timeout (30s default) and user-configurable `motkra.terminalTimeout` setting
- [x] **1B-5** Add allow-list setting `motkra.allowedCommands` (default: `['npm','npx','python','pytest','git','node']`) — block anything not on the list

### 1C — Smart Privacy Routing
- [x] **1C-1** Create `core/privacy-scanner.js` — regex patterns for API keys, Bearer tokens, PEM blocks, DB connection strings, `.env` content, common secret variable names
- [x] **1C-2** Run scanner on user message + attached code before routing — if hit, force `local` regardless of keyword score
- [x] **1C-3** Show `🔒 Private` badge in panel when privacy override is active
- [x] **1C-4** Add `motkra.privacyScan` boolean setting (default: `true`)
- [ ] **1C-5** Log privacy hits to VS Code output channel (what pattern triggered, never the content)

### 1D — Cost Savings Counter
- [x] **1D-1** Track token counts per response — Anthropic SDK returns `usage.input_tokens` + `usage.output_tokens` in `stream.finalMessage()`
- [x] **1D-2** Track Gemma token count estimates (outputChars / 4 approximation)
- [x] **1D-3** Compute "saved" cost: Gemma_tokens × Claude_price_per_token
- [x] **1D-4** Persist running total in `globalState` (survives VS Code restarts)
- [x] **1D-5** Display `💰 $X.XX saved` in panel header — update live after each Gemma response
- [ ] **1D-6** Add reset button and show breakdown in tooltip (N calls, M tokens)

---

## Phase 2 — Ambient Awareness · Layer 1 (Week 2)
*Motkra watches. You don't have to ask.*

### 2A — Proactive Error Detection
- [x] **2A-1** Create `ambient/watcher.js` — subscribe to `vscode.workspace.onDidSaveTextDocument`
- [x] **2A-2** On save, read VS Code diagnostics for that file — filter `severity === Error`
- [x] **2A-3** If errors found, post a soft suggestion to the panel: "I noticed N error(s) in `filename` — want me to fix them?" with Yes / Dismiss buttons
- [x] **2A-4** Add cooldown (don't re-suggest same file within 60s) and `motkra.proactiveErrors` toggle setting

### 2B — Terminal Crash Monitor
- [x] **2B-1** Subscribe to `vscode.window.onDidWriteTerminalData`
- [x] **2B-2** Match output against crash patterns: `Error:`, `Traceback`, `FAILED`, `ENOENT`, `Segmentation fault`, `npm ERR!`
- [x] **2B-3** On match, post suggestion with auto-fill option; 10s cooldown, 600ms debounce, ANSI stripping
- [x] **2B-4** Add `motkra.proactiveTerminal` toggle setting

### 2C — Stuck Detection
- [x] **2C-1** Track edit events per file region — `onDidChangeTextDocument` with 15-line buckets
- [x] **2C-2** If same 15-line region edited ≥8 times in 20 minutes, trigger suggestion
- [x] **2C-3** Suggestion: "You've been editing the same section for a while. Want a second pair of eyes?"
- [x] **2C-4** Add `motkra.stuckDetection` toggle setting

### 2D — Git Hook Integration
- [x] **2D-1** Add `motkra.commitMessage` command — run `git diff --staged`, send to Gemma, write result into SCM input box
- [x] **2D-2** Add `motkra.explainDiff` command — run `git diff HEAD`, send to panel
- [ ] **2D-3** Add post-save hook: when a file with significant changes is saved, quietly append a one-liner change summary to `.motkra/session.log`

---

## Phase 3 — Persistent Memory · Layer 2 (Weeks 2–3)
*Motkra remembers. Every session builds on the last.*

### 3A — Memory Store Setup
- [ ] **3A-1** Add `better-sqlite3` dependency to `package.json` *(skipped — using JSON file at `~/.motkra/memory.json` to avoid native binary compilation)*
- [x] **3A-2** Create `core/memory.js` — JSON-based store at `~/.motkra/memory.json` (no native deps)
- [x] **3A-3** Facts per workspace with max-200 cap, project context string, workspace isolation
- [x] **3A-4** Export `remember`, `recall`, `forget`, `forgetAll`, `getProjectContext`, `setProjectContext`, `buildMemoryContext`

### 3B — Automatic Session Memory
- [x] **3B-1** On new session, send last 10 messages to Gemma: extract 1–3 facts, store via `memory.remember()`
- [x] **3B-2** On session start, retrieve last 10 facts for the current workspace — injected into system prompt as "What I remember:"
- [x] **3B-3** Retrieve `project_context` and prepend as "Project context:"
- [x] **3B-4** Memory injection capped at 2,000 chars — oldest facts truncated first

### 3C — Memory Commands & Tool
- [x] **3C-1** Add `/remember <text>` slash command in panel — stores fact immediately, shows confirmation
- [x] **3C-2** Add `/forget <id>` and `/forget-all` commands — fact deletion with confirmation message
- [x] **3C-3** Add `/recall [query]` command — searches facts, displays results as system message
- [ ] **3C-4** Add `remember` and `recall` tools to Claude agent tool registry — Claude can store/retrieve facts autonomously
- [x] **3C-5** Add 🧠 N memory badge in panel header showing count of stored facts for current workspace

---

## Phase 4 — Voice Layer · Layer 3 (Week 3)
*Talk to it. It talks back.*

### 4A — Speech to Text
- [ ] **4A-1** Add `"ms-vscode.vscode-speech"` to `extensionDependencies` *(skipped — checked at runtime with install prompt instead, avoids forcing dependency on all users)*
- [x] **4A-2** Add microphone button to `panel.html` — toggles recording state with red blinking indicator; hidden unless `motkra.voiceEnabled` is true
- [x] **4A-3** Create `core/voice.js` — wraps VS Code Speech API `createSpeechToTextSession()`; shows install prompt if extension missing
- [x] **4A-4** Stream partial transcription as draft text in the input box (italic/dimmed) while recording
- [x] **4A-5** On `SpeechToTextStatus.Recognized`, auto-submit transcript as chat message
- [x] **4A-6** Add `motkra.voiceEnabled` setting (default: `false`, opt-in)

### 4B — Text to Speech
- [x] **4B-1** Wrap VS Code Speech API TTS in `core/voice.js` — `speak(text)` strips code blocks and skips >200 word responses
- [x] **4B-2** After each Gemma response, call `voice.speak()` if TTS enabled and not muted
- [x] **4B-3** Skip TTS for code blocks and markdown — reads prose only
- [x] **4B-4** Add 🔊 speaker button in panel toolbar — toggles per-session mute, posts `tts-mute` to extension
- [x] **4B-5** Add `motkra.ttsEnabled` setting (default: `false`)

---

## Phase 5 — Inline Completions · Tier 2 (Week 4)
*Ghost text. The feature that makes it a Copilot replacement.*

- [x] **5-1** Register `vscode.languages.registerInlineCompletionItemProvider` for all languages (`*`)
- [x] **5-2** On cursor idle (400ms debounce), extract last 300 chars before cursor + first 100 chars after
- [x] **5-3** Send to Gemma with system prompt: "Complete the code. Output only the completion, no explanation."
- [x] **5-4** Return result as `InlineCompletionItem` — appears as ghost text
- [x] **5-5** Handle cancellation token — abort Gemma request if user types before completion arrives
- [x] **5-6** Add `motkra.inlineCompletions` toggle setting (default: `false`, opt-in — it's aggressive)
- [ ] **5-7** Track accept/dismiss rate — if >80% dismissed, auto-disable and notify user

---

## Phase 6 — Workspace RAG · Tier 2 (Week 4)
*Claude sees the whole codebase, not just the open file.*

- [x] **6-1** Create `core/indexer.js` — walks workspace files (capped at 2000), skips `node_modules`, `.git`, `__pycache__`, binaries
- [x] **6-2** Build TF-IDF index in memory: tokenize each file, Map of term→TF, global DF table — no SQLite dependency
- [x] **6-3** Implement `query(text, topK=3)` — TF-IDF scoring, returns top-K file paths + best matching excerpt
- [x] **6-4** Inject retrieved context into Claude requests as "Relevant workspace files:" appended to user message
- [x] **6-5** Show `📎 N files` badge in panel header — lights up on indexing complete and on each RAG injection
- [x] **6-6** Re-index on save/create/delete via `onDidSaveTextDocument`, `onDidCreateFiles`, `onDidDeleteFiles`
- [x] **6-7** Add `motkra.workspaceIndex` toggle and `motkra.workspaceIndexMaxKB` settings

---

## Phase 7 — Git Integration · Tier 2 (Week 4)
*Motkra knows your history.*

- [ ] **7-1** Add `git` tool to agent tool registry: sub-commands `diff`, `log`, `status`, `branch`
- [x] **7-2** Implement `motkra.commitMessage` command — `git diff --staged` → Gemma → Conventional Commit → SCM input box
- [x] **7-3** Implement `motkra.explainDiff` command — `git diff HEAD`, send to panel for explanation
- [x] **7-4** Register `motkra.reviewPR` command (GitHub API integration pending Phase 13A)
- [ ] **7-5** Add keyboard shortcuts: `Ctrl+Shift+G M` (commit message), `Ctrl+Shift+G D` (explain diff)
- [ ] **7-6** Add git context to daily briefing (see Phase 12)

---

## Phase 8 — Any Ollama Model · Tier 2 (Week 4)
*Not just Gemma. Any local model.*

- [x] **8-1** On activation, fetch `GET localhost:11434/api/tags` — parse available model list
- [x] **8-2** Add local model dropdown to panel header — populated from Ollama tags, posts `local-model` on change
- [x] **8-3** Pass selected model name to `clients/gemma.js` via `_currentLocalModel` field
- [ ] **8-4** Persist selected model per workspace in `preferences` table
- [ ] **8-5** Show model size and family in dropdown tooltip
- [x] **8-6** Add `motkra.defaultLocalModel` setting

---

## Phase 9 — Enhanced Agent Tools (Week 5)
*Claude can search the web and see your screen.*

### 9A — Web Search Tool
- [x] **9A-1** Add `web_search` tool to agent registry
- [x] **9A-2** Implement in `core/web.js` using Brave Search API (`GET .../web/search?q=...&count=5`)
- [x] **9A-3** Add `motkra.braveSearchKey` setting
- [x] **9A-4** Fallback to DuckDuckGo instant-answer API when no key configured

### 9B — Web Fetch Tool
- [x] **9B-1** Add `fetch_url` tool — `core/web.js` fetches URL, strips HTML with dependency-free regex stripper
- [x] **9B-2** Limit to 10,000 chars with truncation note
- [x] **9B-3** In-memory URL cache with 1-hour TTL (no SQLite dependency)

### 9C — Screenshot Tool
- [x] **9C-1** Add `take_screenshot` tool — executes `workbench.action.screenshot`, scans OS temp dir for newest PNG within 1.5s
- [x] **9C-2** Returns image content block `[{type:'image', source:{type:'base64',...}}]`; agentic loop passes array directly to Claude Vision
- [x] **9C-3** Add `motkra.allowScreenshot` setting (default: `false`, explicit opt-in)

---

## Phase 10 — Multi-Agent Orchestration · Layer 5 (Weeks 5–6)
*Motkra spawns sub-agents and coordinates them.*

### 10A — Task Tree
- [x] **10A-1** Create `core/orchestrator.js` — data structure: `{id, goal, subtasks:[{id, agent, status, result}]}`
- [x] **10A-2** Orchestrator prompt: Claude receives user goal + tool list, responds with JSON task breakdown
- [x] **10A-3** Add task tree UI to `panel.html` — collapsible tree with status icons (⏳ pending, ▶ running, ✓ done, ✗ failed)
- [x] **10A-4** Post task tree updates to panel in real time as subtasks complete

### 10B — Sub-Agent Execution
- [x] **10B-1** Each subtask runs as an independent Claude session with isolated message history; shares base system prompt
- [x] **10B-2** Sub-agents share the same file tools but have isolated message histories
- [x] **10B-3** Subtask output is passed as context to the next subtask (chain-of-thought handoff)
- [x] **10B-4** Add Pause / Resume controls per subtask branch in panel UI *(Redirect not implemented)*
- [x] **10B-5** Add `motkra.maxSubAgents` setting (default: `4`) to cap parallel Claude sessions

### 10C — Trigger
- [x] **10C-1** Detect multi-step intent in user message (keyword: "then", "after that", "and also", "finally") — offer "Run as multi-agent task?" prompt
- [x] **10C-2** Add `/plan <goal>` slash command to explicitly invoke orchestrator mode

---

## Phase 11 — System Tray Daemon · Layer 4 (Weeks 6–7)
*Motkra lives outside VS Code.*

- [x] **11-1** Scaffold Electron app in new `motkra-daemon/` folder — `main.js`, `tray.js`, `ipc.js`
- [x] **11-2** System tray icon with context menu: Open Motkra, Quick Query, Settings, Quit
- [x] **11-3** Register global hotkey `Ctrl+Shift+Space` (configurable via `MOTKRA_HOTKEY` env var)
- [x] **11-4** Floating window: frameless, 460×520px, always-on-top, auto-hides on blur
- [x] **11-5** IPC bridge: daemon listens on `localhost:7432`, VS Code extension connects as client
- [x] **11-6** Route floating window queries through Claude streaming via `ipc.js`
- [ ] **11-7** Package as installer (NSIS for Windows, `.dmg` for Mac) via `electron-builder`

---

## Phase 12 — Browser Extension · Layer 4 (Week 7)
*Motkra reads the web for you.*

- [x] **12-1** Scaffold Chrome/Firefox extension in `motkra-browser/` — `manifest.json` (MV3), `content.js`, `popup.html`
- [x] **12-2** Inject "Ask Motkra" floating button on all pages
- [x] **12-3** On click: extract page title, URL, main content (Readability.js), selected text
- [x] **12-4** Send to Motkra daemon via `localhost:7432`
- [x] **12-5** Show response in a side drawer injected into the page (not popup, so it's readable alongside content)
- [x] **12-6** Special handling for GitHub pages: extract issue/PR description + comments, send as structured context

---

## Phase 13 — External Integrations · Layer 6 (Week 7–8)

### 13A — GitHub
- [ ] **13A-1** Add `motkra.githubToken` setting
- [ ] **13A-2** Add `github` tool to agent: `list_issues`, `get_pr`, `post_comment`, `get_review_comments`
- [ ] **13A-3** On `motkra.reviewPR`: fetch PR diff via GitHub API, send to Claude, post review as GitHub review (with approval)

### 13B — Daily Briefing
- [ ] **13B-1** Register VS Code task that runs at first window open after 8am (check `globalState.lastBriefing` date)
- [ ] **13B-2** Collect: `git log --since=yesterday`, open GitHub issues assigned to user, failing test count from last run, today's calendar events (if integration enabled)
- [ ] **13B-3** Send to Claude: "Generate a concise morning dev briefing. 5 bullets max."
- [ ] **13B-4** Display in panel with `📋 Morning Briefing` header — read aloud via TTS if voice enabled
- [ ] **13B-5** Add `motkra.dailyBriefing` toggle setting

### 13C — Push Notifications
- [ ] **13C-1** Add `motkra.ntfyTopic` setting (user creates a topic at ntfy.sh)
- [ ] **13C-2** On long Claude task completion (>30s), send `POST https://ntfy.sh/{topic}` with task summary
- [ ] **13C-3** On proactive error detection when VS Code is not focused, send notification

---

## Phase 14 — Launch · Week 8

- [ ] **14-1** Record README GIF — 15 seconds showing: select buggy code → right-click Fix → Claude edits file live
- [ ] **14-2** Record 90-second demo video for README and Product Hunt
- [ ] **14-3** Publish to VS Code Marketplace — get publisher ID, add `vsce publish` to CI
- [ ] **14-4** Set up GitHub Actions: lint + `vsce package` on PR, `vsce publish` on version tag
- [ ] **14-5** Create `community-agents/` folder — add 5 starter agents (Python expert, TypeScript expert, Security reviewer, Documentation writer, Test generator)
- [ ] **14-6** Write Product Hunt launch description
- [ ] **14-7** Post to: r/vscode, r/LocalLLaMA, Hacker News Show HN, DEV.to

---

## Phase 15 — Side-by-Side Comparison · Tier 3

- [ ] **15-1** Add "⚖ Compare" button to panel toolbar — sends current input to both Claude and Gemma simultaneously (Promise.all)
- [ ] **15-2** Render responses in two columns inside a new `compare-pane` view — left column Claude (☁), right column local (🏠)
- [ ] **15-3** Add token count and latency footer under each column for benchmarking
- [ ] **15-4** Add CSS for split-column layout within `#messages-wrap` that activates when compare mode is on
- [ ] **15-5** Add `motkra.compare` command and keyboard shortcut `Ctrl+Shift+J C`

---

## Phase 16 — MCP Server Mode · Tier 3

- [x] **16-1** Scaffold `motkra-mcp/` folder — MCP server exposing local Ollama models as MCP tools (`ollama_chat`, `ollama_list_models`)
- [x] **16-2** Implement MCP `initialize`, `tools/list`, `tools/call` handlers over stdio (JSON-RPC 2.0, newline-delimited)
- [x] **16-3** Route MCP tool calls directly to Ollama HTTP API — any model the user has installed
- [x] **16-4** Add `motkra.mcpServer` boolean setting (default: `false`) — when enabled, extension spawns the MCP server on activation
- [x] **16-5** Add `motkra.mcpPort` setting (default: `3333`) — expose MCP over TCP as well as stdio via `MOTKRA_MCP_PORT` env var
- [ ] **16-6** Document in README how to connect Claude Desktop to Motkra as an MCP server

---

## Phase 17 — Email Agent · Layer 7 (Week 9)
*Motkra reads your inbox, triages every email, and acts on your behalf — with the right level of autonomy per person.*

### 17A — Gmail OAuth2 Client
- [x] **17A-1** Create `motkra-daemon/email/gmail.js` — OAuth2 flow using `googleapis`; tokens at `~/.motkra/gmail-tokens.json`, credentials at `~/.motkra/gmail-credentials.json`
- [x] **17A-2** Implement `listNew()` — fetch unread INBOX messages since last poll, return `[{id, threadId, from, subject, body, date}]`
- [x] **17A-3** Implement `send(to, subject, body, threadId)` — send reply on the same thread, returns `{id, threadId}`
- [x] **17A-4** Implement `archive(messageId)` — remove `INBOX` label
- [x] **17A-5** Persist seen message IDs to `~/.motkra/email-state.json` (capped at 500) to prevent re-processing

### 17B — Contact Trust Store
- [x] **17B-1** Create `motkra-daemon/email/contacts.js` — reads/writes `~/.motkra/email-contacts.json`
- [x] **17B-2** Trust levels 1–5 with full semantics implemented in `monitor.js` decision matrix
- [x] **17B-3** Export `getTrust(emailAddress)` — strips `Name <addr>` format, returns 0–5
- [ ] **17B-4** Add `/email-trust add <address> <name> <level>` slash command in daemon chat window

### 17C — Claude Triage Engine
- [x] **17C-1** Create `motkra-daemon/email/triage.js` — sends email to Claude with structured prompt
- [x] **17C-2** Returns `{ action: "spam"|"ignore"|"reply"|"flag", confidence: 1–10, draft: string|null, reason: string }`
- [x] **17C-3** Claude writes complete reply draft in sender's language for `action: "reply"`
- [x] **17C-4** `action: "flag"` escalates to urgent notification regardless of trust level
- [x] **17C-5** Confidence 1–10 reflects certainty about both classification and draft quality

### 17D — Decision Engine & Approval Loop
- [x] **17D-1** Create `motkra-daemon/email/monitor.js` — polling loop via `setInterval`, interval from `MOTKRA_EMAIL_INTERVAL` env var (default 120s)
- [x] **17D-2** Full `trust × confidence` decision matrix implemented
- [x] **17D-3** Approval email sent to user's own address with YES / NO / override-text instructions
- [x] **17D-4** `pollApprovalReply()` polls reply thread every 15s for up to 5 min
- [x] **17D-5** YES → send draft; NO → discard; override text → send user's text

### 17E — Notification Windows
- [x] **17E-1** Create `motkra-daemon/email/notify-window.html` — frameless Electron window (420×420px)
- [x] **17E-2** Shows: sender + trust stars, subject, body preview, draft textarea, confidence bar, reason
- [x] **17E-3** Action buttons: **Send**, **Ignore**, **Flag ⚑** — draft is editable before send
- [x] **17E-4** Auto-dismisses after 60s; IPC sends action result back to `main.js`
- [x] **17E-5** Positioned bottom-right; reuses window if already open (new email data pushed via IPC)

### 17F — Settings & Wiring
- [x] **17F-1** Email enabled via `MOTKRA_EMAIL_ENABLED=1` env var (opt-in)
- [x] **17F-2** Poll interval via `MOTKRA_EMAIL_INTERVAL` env var (default 120s)
- [x] **17F-3** Auto-archive spam implemented in `monitor.js`
- [x] **17F-4** Auto-send confidence threshold via `MOTKRA_EMAIL_THRESHOLD` env var (default 6)
- [x] **17F-5** `monitor.start()` called in `app.whenReady()` behind `MOTKRA_EMAIL_ENABLED` flag
- [x] **17F-6** "Email Agent" submenu in system tray with Enable/Disable toggle

---

## Settings Reference (all phases combined)

```json
{
  "motkra.claudeModel":           "claude-opus-4-7",
  "motkra.defaultLocalModel":     "gemma4:e2b",
  "motkra.ollamaHost":            "localhost",
  "motkra.ollamaPort":            11434,
  "motkra.privacyScan":           true,
  "motkra.proactiveErrors":       true,
  "motkra.proactiveTerminal":     true,
  "motkra.stuckDetection":        true,
  "motkra.voiceEnabled":          false,
  "motkra.ttsEnabled":            false,
  "motkra.inlineCompletions":     false,
  "motkra.workspaceIndex":        true,
  "motkra.allowScreenshot":       false,
  "motkra.maxSubAgents":          4,
  "motkra.terminalTimeout":       30,
  "motkra.allowedCommands":       ["npm","npx","python","pytest","git","node"],
  "motkra.braveSearchKey":        "",
  "motkra.githubToken":           "",
  "motkra.ntfyTopic":             "",
  "motkra.dailyBriefing":         true,
  "motkra.emailEnabled":          false,
  "motkra.emailPollInterval":     120,
  "motkra.emailAutoArchiveSpam":  true,
  "motkra.emailAutoSendThreshold": 6,
  "motkra.mcpServer":             false,
  "motkra.mcpPort":               3333
}
```

---

## Milestone Summary

| Week | Deliverable | Star potential |
|------|-------------|----------------|
| 1 | Diff preview + terminal tool + privacy routing + cost counter | Foundation for trust |
| 2 | Proactive errors + terminal monitor + commit message | "It watches for me" |
| 3 | Memory + voice input | "It remembers me" |
| 4 | Inline completions + RAG + git integration + any Ollama model | Copilot replacement tier |
| 5 | Web search + screenshot + multi-agent task tree | Agentic tier |
| 6–7 | System tray + browser extension | Omnipresence tier |
| 7–8 | GitHub + daily briefing + notifications | Full Motkra tier |
| 8 | GIF + Marketplace + Product Hunt | 🚀 Launch |
| 9 | Email agent — triage, trust levels, approval loop | Superhuman tier |
| 9 | MCP server — expose Ollama to Claude Desktop | Ecosystem tier |
