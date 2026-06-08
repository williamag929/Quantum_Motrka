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

- [ ] **6-1** Create `core/indexer.js` — walk workspace files on activation, skip `node_modules/`, `.git/`, `*.vsix`, binary files
- [ ] **6-2** Build TF-IDF index: tokenize each file, store term frequencies in SQLite (`index` table)
- [ ] **6-3** Implement `query(userMessage, topK=3)` — score all files against query terms, return top-K file paths + relevant excerpts
- [ ] **6-4** Inject retrieved context into Claude requests: prepend as "Relevant files:" section in the first user message
- [ ] **6-5** Show `📎 N files` badge in panel header when context is attached
- [ ] **6-6** Re-index on file save (incremental — only update changed file's entries)
- [ ] **6-7** Add `motkra.workspaceIndex` toggle setting and max file size limit (default: 500KB)

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
- [ ] **9A-1** Add `web_search` tool to agent registry
- [ ] **9A-2** Implement using Brave Search API (free tier: 2,000 req/day) — `GET https://api.search.brave.com/res/v1/web/search?q=...`
- [ ] **9A-3** Add `motkra.braveSearchKey` setting
- [ ] **9A-4** Fallback to DuckDuckGo instant answer API if no key configured

### 9B — Web Fetch Tool
- [ ] **9B-1** Add `fetch_url` tool — fetches URL content, strips HTML to markdown using `node-html-markdown`
- [ ] **9B-2** Limit to 10,000 chars, truncate with a note
- [ ] **9B-3** Cache fetched URLs in SQLite for 1 hour to avoid duplicate fetches

### 9C — Screenshot Tool
- [ ] **9C-1** Add `take_screenshot` tool — calls `vscode.commands.executeCommand('workbench.action.screenshot')`
- [ ] **9C-2** Read resulting PNG, encode as base64, pass to Claude Vision as image content block
- [ ] **9C-3** Add `motkra.allowScreenshot` setting (default: `false`, explicit opt-in)

---

## Phase 10 — Multi-Agent Orchestration · Layer 5 (Weeks 5–6)
*Motkra spawns sub-agents and coordinates them.*

### 10A — Task Tree
- [ ] **10A-1** Create `core/orchestrator.js` — data structure: `{id, goal, subtasks:[{id, agent, status, result}]}`
- [ ] **10A-2** Orchestrator prompt: Claude receives user goal + tool list, responds with JSON task breakdown
- [ ] **10A-3** Add task tree UI to `panel.html` — collapsible tree with status icons (⏳ pending, ▶ running, ✓ done, ✗ failed)
- [ ] **10A-4** Post task tree updates to panel in real time as subtasks complete

### 10B — Sub-Agent Execution
- [ ] **10B-1** Each subtask runs as an independent Claude session with specialized system prompt (researcher / implementer / reviewer)
- [ ] **10B-2** Sub-agents share the same file tools but have isolated message histories
- [ ] **10B-3** Subtask output is passed as context to the next subtask (chain-of-thought handoff)
- [ ] **10B-4** Add Pause / Resume / Redirect controls per subtask branch in panel UI
- [ ] **10B-5** Add `motkra.maxSubAgents` setting (default: `4`) to cap parallel Claude sessions

### 10C — Trigger
- [ ] **10C-1** Detect multi-step intent in user message (keyword: "then", "after that", "and also", "finally") — offer "Run as multi-agent task?" prompt
- [ ] **10C-2** Add `/plan <goal>` slash command to explicitly invoke orchestrator mode

---

## Phase 11 — System Tray Daemon · Layer 4 (Weeks 6–7)
*Motkra lives outside VS Code.*

- [ ] **11-1** Scaffold Electron app in new `motkra-daemon/` folder — `main.js`, `tray.js`, `ipc.js`
- [ ] **11-2** System tray icon with context menu: Open Motkra, Quick Query, Settings, Quit
- [ ] **11-3** Register global hotkey `Ctrl+Space+Space` (configurable) — opens floating mini-chat window
- [ ] **11-4** Floating window: frameless, 400×200px, always-on-top, auto-hides on blur
- [ ] **11-5** IPC bridge: daemon listens on `localhost:7432`, VS Code extension connects as client — shared session state
- [ ] **11-6** Route floating window queries through the same Claude/Gemma stack
- [ ] **11-7** Package as installer (NSIS for Windows, `.dmg` for Mac) via `electron-builder`

---

## Phase 12 — Browser Extension · Layer 4 (Week 7)
*Motkra reads the web for you.*

- [ ] **12-1** Scaffold Chrome/Firefox extension in `motkra-browser/` — `manifest.json` (MV3), `content.js`, `popup.html`
- [ ] **12-2** Inject "Ask Motkra" floating button on all pages
- [ ] **12-3** On click: extract page title, URL, main content (Readability.js), selected text
- [ ] **12-4** Send to Motkra daemon via `localhost:7432`
- [ ] **12-5** Show response in a side drawer injected into the page (not popup, so it's readable alongside content)
- [ ] **12-6** Special handling for GitHub pages: extract issue/PR description + comments, send as structured context

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

- [ ] **16-1** Scaffold `motkra-mcp/` folder — MCP server exposing the local Ollama model as an MCP-compatible LLM endpoint
- [ ] **16-2** Implement MCP `initialize` and `sampling/createMessage` handlers over stdio
- [ ] **16-3** Route MCP requests to Ollama via `clients/gemma.js` — any model the user has installed
- [ ] **16-4** Add `motkra.mcpServer` boolean setting (default: `false`) — when enabled, extension spawns the MCP server process on activation
- [ ] **16-5** Add `motkra.mcpPort` setting (default: `3333`) — expose MCP over TCP as well as stdio
- [ ] **16-6** Document in README how to connect Claude Desktop to Motkra as an MCP server

---

## Settings Reference (all phases combined)

```json
{
  "motkra.claudeModel":        "claude-opus-4-7",
  "motkra.defaultLocalModel":  "gemma4:e2b",
  "motkra.ollamaHost":         "localhost",
  "motkra.ollamaPort":         11434,
  "motkra.privacyScan":        true,
  "motkra.proactiveErrors":    true,
  "motkra.proactiveTerminal":  true,
  "motkra.stuckDetection":     true,
  "motkra.voiceEnabled":       false,
  "motkra.ttsEnabled":         false,
  "motkra.inlineCompletions":  false,
  "motkra.workspaceIndex":     true,
  "motkra.allowScreenshot":    false,
  "motkra.maxSubAgents":       4,
  "motkra.terminalTimeout":    30,
  "motkra.allowedCommands":    ["npm","npx","python","pytest","git","node"],
  "motkra.braveSearchKey":     "",
  "motkra.githubToken":        "",
  "motkra.ntfyTopic":          "",
  "motkra.dailyBriefing":      true
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
