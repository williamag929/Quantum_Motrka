'use strict';

const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const http   = require('http');
const { execSync } = require('child_process');

require('dotenv').config({
  path: path.join(__dirname, '..', 'dual_ai', '.env')
});

const { route }             = require('./router');
const { runAgent }          = require('./agent');
const { askGemma }          = require('./clients/gemma');
const { loadAgents }        = require('./agents');
const { scan: scanPrivacy } = require('./core/privacy-scanner');
const memory                = require('./core/memory');
const ambientWatcher        = require('./ambient/watcher');
const voice                 = require('./core/voice');
const indexer               = require('./core/indexer');
const orchestrator          = require('./core/orchestrator');

const DEFAULT_SYSTEM_PROMPT =
  'You are a coding agent inside VS Code. ' +
  'You have tools to read, write, and edit files in the workspace, ' +
  'and a run_command tool to execute shell commands. ' +
  'When asked to modify code, use the tools to make changes directly — ' +
  'do not just show a diff. Be concise.';

// Claude Opus 4.7 pricing — used only to compute local savings estimates
const CLOUD_INPUT_PRICE  = 5  / 1_000_000;
const CLOUD_OUTPUT_PRICE = 25 / 1_000_000;

// ── Inline completion provider (Phase 5) ────────────────────────────────────

class MoktaInlineProvider {
  async provideInlineCompletionItems(document, position, _ctx, token) {
    const cfg = vscode.workspace.getConfiguration('motkra');
    if (!cfg.get('inlineCompletions', false)) return { items: [] };

    const offset = document.offsetAt(position);
    const text   = document.getText();
    const prefix = text.slice(Math.max(0, offset - 300), offset);
    if (!prefix.trim()) return { items: [] };

    const suffix = text.slice(offset, Math.min(text.length, offset + 80));
    const lang   = document.languageId;

    let completion = '';
    try {
      await askGemma(
        [
          {
            role: 'system',
            content: `You are a ${lang} code completion engine. Output ONLY the exact text to insert after <CURSOR>. No explanation, no markdown fences.`
          },
          { role: 'user', content: `${prefix}<CURSOR>${suffix}` }
        ],
        tok => { completion += tok; },
        {
          host:  cfg.get('ollamaHost') ?? 'localhost',
          port:  cfg.get('ollamaPort') ?? 11434,
          model: cfg.get('defaultLocalModel') ?? 'gemma4:e2b',
        }
      );
    } catch { return { items: [] }; }

    if (token.isCancellationRequested || !completion.trim()) return { items: [] };

    return { items: [{ insertText: completion.trimEnd(), range: new vscode.Range(position, position) }] };
  }
}

// ── Webview provider ────────────────────────────────────────────────────────

class MoktaProvider {
  constructor(context) {
    this._ctx              = context;
    this._view             = null;
    this._sessions         = new Map();
    this._activeSessId     = null;
    this._sessCounter      = 0;
    this._agents           = [{ id: 'default', name: 'Default', description: 'Built-in coding agent', systemPrompt: null }];
    this._activeAgent      = 'default';
    this._pendingDiffs      = new Map();
    this._currentLocalModel = null;
    this._sttDispose        = null;  // active STT session dispose fn
    this._ttsMuted          = false;
    this._channel           = null;
    // Phase 10 — orchestration state
    this._planCancelled     = false;
    this._pausedTasks       = new Set();
    this._resumeResolvers   = new Map();
  }

  // ── Computed properties ──────────────────────────────────────────────

  get _workspace() {
    return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath ?? 'default';
  }

  get _systemPrompt() {
    const agent  = this._agents.find(a => a.id === this._activeAgent);
    const base   = agent?.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    const memCtx = memory.buildMemoryContext(this._workspace);
    return memCtx ? `${base}\n\n---\n${memCtx}` : base;
  }

  get _activeHistory() {
    return this._sessions.get(this._activeSessId)?.history ?? [];
  }

  // ── Session helpers ──────────────────────────────────────────────────

  _newSession() {
    // Summarise previous session into memory before switching
    if (this._activeSessId) this._summariseSession(this._activeSessId);

    const id   = `s${Date.now()}_${++this._sessCounter}`;
    const name = `Session ${this._sessCounter}`;
    this._sessions.set(id, { name, history: [] });
    this._activeSessId = id;
    this._post({ type: 'session-created', id, name });
    this._pushMemoryCount();
    return id;
  }

  /** Extract and store key facts from a closing session using Gemma. */
  async _summariseSession(sessId) {
    const sess = this._sessions.get(sessId);
    if (!sess || sess.history.length < 4) return;

    const cfg     = vscode.workspace.getConfiguration('motkra');
    const ollaOpts = {
      host:  cfg.get('ollamaHost')  ?? 'localhost',
      port:  cfg.get('ollamaPort')  ?? 11434,
      model: this._currentLocalModel ?? cfg.get('defaultLocalModel') ?? 'gemma4:e2b',
    };

    const recent = sess.history.slice(-10)
      .map(m => `${m.role}: ${String(m.content).slice(0, 200)}`)
      .join('\n');

    let summary = '';
    try {
      await askGemma(
        [
          { role: 'system', content: 'Extract 1-3 short facts worth remembering from this conversation. Output one fact per line, starting with "•". If nothing worth remembering, output nothing.' },
          { role: 'user',   content: recent }
        ],
        tok => { summary += tok; },
        ollaOpts
      );
    } catch { return; }

    summary.split('\n')
      .filter(l => l.trim().startsWith('•'))
      .map(l => l.replace(/^•\s*/, '').trim())
      .filter(Boolean)
      .forEach(fact => memory.remember(this._workspace, fact));
  }

  // ── VS Code lifecycle ────────────────────────────────────────────────

  resolveWebviewView(webviewView) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._ctx.extensionUri, 'media')]
    };
    webviewView.webview.html = this._buildHtml(webviewView.webview);

    const pushCtx = this._debounce(() => this._pushEditorContext(), 150);
    this._ctx.subscriptions.push(
      vscode.window.onDidChangeTextEditorSelection(pushCtx),
      vscode.window.onDidChangeActiveTextEditor(pushCtx)
    );

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {

        case 'ready':
          this._pushAgents();
          if (this._sessions.size === 0) this._newSession();
          this._pushEditorContext();
          this._pushSavedCost();
          this._pushMemoryCount();
          this.reloadOllamaModels();
          this._pushVoiceConfig();
          break;

        case 'chat':
          await this._onChat(msg.text, msg.mode ?? 'auto', msg.sessionId, msg.attachContext !== false);
          break;

        case 'clear': {
          const sess = this._sessions.get(this._activeSessId);
          if (sess) sess.history = [];
          break;
        }

        case 'newSession':   this._newSession(); break;
        case 'switchSession':
          if (this._sessions.has(msg.id)) this._activeSessId = msg.id;
          break;

        case 'deleteSession':
          this._sessions.delete(msg.id);
          if (this._activeSessId === msg.id)
            this._activeSessId = this._sessions.keys().next().value ?? null;
          break;

        case 'renameSession': {
          const sess = this._sessions.get(msg.id);
          if (sess) sess.name = msg.name;
          break;
        }

        case 'agent':
          this._activeAgent = msg.id;
          break;

        case 'local-model':
          this._currentLocalModel = msg.model || null;
          break;

        // ── Voice commands (Phase 4) ───────────────────────────────────
        case 'voice-start':
          if (this._sttDispose) { this._sttDispose(); this._sttDispose = null; }
          voice.startSTT(
            partial => this._post({ type: 'voice-partial', text: partial }),
            final   => {
              this._post({ type: 'voice-final', text: final });
              if (this._sttDispose) { this._sttDispose(); this._sttDispose = null; }
            }
          ).then(dispose => { this._sttDispose = dispose; });
          break;

        case 'voice-stop':
          if (this._sttDispose) { this._sttDispose(); this._sttDispose = null; }
          this._post({ type: 'voice-stopped' });
          break;

        case 'tts-mute':
          this._ttsMuted = msg.muted ?? !this._ttsMuted;
          break;

        // ── Diff approval ──────────────────────────────────────────────
        case 'diff-accept': {
          const res = this._pendingDiffs.get(msg.id);
          if (res) { res(true);  this._pendingDiffs.delete(msg.id); }
          break;
        }
        case 'diff-reject': {
          const res = this._pendingDiffs.get(msg.id);
          if (res) { res(false); this._pendingDiffs.delete(msg.id); }
          break;
        }

        // ── Memory commands ────────────────────────────────────────────
        case 'memory-remember': {
          const fact = memory.remember(this._workspace, msg.content);
          this._pushMemoryCount();
          this._postSystemMsg(`Remembered: "${fact.content}"`);
          break;
        }
        case 'memory-recall': {
          const facts = memory.recall(this._workspace, msg.query ?? '');
          const text  = facts.length
            ? facts.map(f => `• ${f.content}`).join('\n')
            : '(nothing stored yet)';
          this._postSystemMsg(`**Memory (${facts.length} fact${facts.length !== 1 ? 's' : ''}):**\n${text}`);
          break;
        }
        case 'memory-forget': {
          memory.forget(msg.id);
          this._pushMemoryCount();
          this._postSystemMsg('Fact forgotten.');
          break;
        }
        case 'memory-forget-all': {
          memory.forgetAll(this._workspace);
          this._pushMemoryCount();
          this._postSystemMsg('All memory for this workspace cleared.');
          break;
        }

        // ── Phase 10 — Multi-agent orchestration ───────────────────────
        case 'plan':
          this._onPlan(msg.goal, msg.sessionId);
          break;

        case 'plan-cancel':
          this._planCancelled = true;
          break;

        case 'plan-pause-task':
          this._pausedTasks.add(msg.taskId);
          break;

        case 'plan-resume-task': {
          this._pausedTasks.delete(msg.taskId);
          const res = this._resumeResolvers.get(msg.taskId);
          if (res) { res(); this._resumeResolvers.delete(msg.taskId); }
          break;
        }
      }
    });
  }

  inject(text) {
    this._view?.webview.postMessage({ type: 'inject', text });
  }

  /** Inject a proactive suggestion banner into the panel. */
  suggestProactive(message, autoFill) {
    this._post({ type: 'proactive', message, autoFill });
  }

  // ── Core chat handler ────────────────────────────────────────────────

  async _onChat(userText, mode = 'auto', sessionId, attachContext = true) {
    const sid  = (sessionId && this._sessions.has(sessionId)) ? sessionId : this._activeSessId;
    const sess = this._sessions.get(sid);
    if (!sess) return;

    const ctx        = attachContext ? this._getEditorContext() : '';
    const msgWithCtx = ctx ? `${userText}\n\n${ctx}` : userText;
    sess.history.push({ role: 'user', content: msgWithCtx });

    // ── Privacy scan ───────────────────────────────────────────────────
    const cfg         = vscode.workspace.getConfiguration('motkra');
    const privacyScan = cfg.get('privacyScan') ?? true;
    let   forcedLocal = false;

    if (privacyScan) {
      const hit = scanPrivacy(msgWithCtx);
      if (hit.hit) {
        forcedLocal = true;
        this._post({ type: 'privacy', label: hit.label, sessionId: sid });
        this._out().appendLine(`[Privacy] '${hit.label}' detected → forced local model`);
      }
    }

    // ── Route ──────────────────────────────────────────────────────────
    const model = forcedLocal ? 'local'
      : mode === 'cloud' ? 'cloud'
      : mode === 'local' ? 'local'
      : route(userText);

    const s          = extra => ({ sessionId: sid, ...extra });
    const ollamaOpts = {
      host:  cfg.get('ollamaHost')  ?? 'localhost',
      port:  cfg.get('ollamaPort')  ?? 11434,
      model: this._currentLocalModel ?? cfg.get('defaultLocalModel') ?? 'gemma4:e2b',
    };
    const toolOpts   = {
      allowedCommands: cfg.get('allowedCommands'),
      terminalTimeout: cfg.get('terminalTimeout'),
    };

    // ── RAG context (Phase 6) — inject relevant files for Claude ──────────
    if (model === 'cloud' && cfg.get('workspaceIndex', true) && indexer.isReady()) {
      const hits = indexer.query(userText, 3);
      if (hits.length > 0) {
        const ragBlock = 'Relevant workspace files:\n\n' + hits.map(h =>
          `### ${path.relative(this._workspace, h.filePath)}\n${h.excerpt}`
        ).join('\n\n');
        const last = sess.history[sess.history.length - 1];
        if (last?.role === 'user') last.content += `\n\n---\n\n${ragBlock}`;
        this._post({ type: 'rag-context', count: hits.length, sessionId: sid });
      }
    }

    this._post(s({ type: 'model', model }));
    this._post(s({ type: 'start' }));

    try {
      if (model === 'cloud') {
        await runAgent(
          sess.history,
          this._systemPrompt,
          token       => this._post(s({ type: 'token', text: token })),
          (name, inp) => this._post(s({ type: 'tool',  name, input: JSON.stringify(inp) })),
          full        => sess.history.push({ role: 'assistant', content: full }),
          async (id, filePath, before, after) => {
            this._post(s({ type: 'diff-request', id, path: filePath, before, after }));
            return new Promise(res => this._pendingDiffs.set(id, res));
          },
          null,   // cloud calls don't contribute to savings
          toolOpts
        );
      } else {
        let full       = '';
        const inputChars = sess.history.reduce((a, m) => a + String(m.content).length, 0);

        const outTokens = await askGemma(
          [{ role: 'system', content: this._systemPrompt }, ...sess.history],
          token => {
            this._post(s({ type: 'token', text: token }));
            full += token;
          },
          ollamaOpts
        );

        sess.history.push({ role: 'assistant', content: full });

        // ── Cost savings ───────────────────────────────────────────────
        const inTok     = Math.ceil(inputChars / 4);
        const savedNow  = inTok * CLOUD_INPUT_PRICE + outTokens * CLOUD_OUTPUT_PRICE;
        const total     = (this._ctx.globalState.get('motkra.totalSaved') ?? 0) + savedNow;
        this._ctx.globalState.update('motkra.totalSaved', total);
        this._post({ type: 'cost-update', saved: total });

        // ── TTS (Phase 4B) — read short Gemma responses aloud ─────────
        const ttsCfg = vscode.workspace.getConfiguration('motkra');
        if (ttsCfg.get('ttsEnabled', false) && !this._ttsMuted) {
          voice.speak(full);
        }
      }
    } catch (err) {
      this._post(s({ type: 'error', text: err.message }));
      sess.history.pop();
    }

    this._post(s({ type: 'done' }));

    // 10C-1 — suggest /plan for complex cloud responses
    if (model === 'cloud' && this._isMultiStep(userText)) {
      this._post({
        type:     'proactive',
        message:  'This looks like a multi-step task. Run it as an orchestrated multi-agent plan?',
        autoFill: `/plan ${userText}`,
      });
    }
  }

  // ── Multi-step detection (Phase 10C-1) ──────────────────────────────

  _isMultiStep(text) {
    if (text.length < 80) return false;
    const seqWords = /\b(then|after that|next step|finally|step\s+[0-9]+|first.{0,20}then|also\b.*and\b|additionally)\b/i;
    const hasList  = /\n\s*[-*\d]|\n\s*\d+\./;
    return seqWords.test(text) || hasList.test(text);
  }

  // ── Orchestration handler (Phase 10) ────────────────────────────────

  async _onPlan(goal, sessionId) {
    const sid  = (sessionId && this._sessions.has(sessionId)) ? sessionId : this._activeSessId;
    if (!sid) return;

    const cfg      = vscode.workspace.getConfiguration('motkra');
    const toolOpts = {
      allowedCommands: cfg.get('allowedCommands'),
      terminalTimeout: cfg.get('terminalTimeout'),
    };

    this._planCancelled   = false;
    this._pausedTasks.clear();
    this._resumeResolvers.clear();

    const s = extra => ({ sessionId: sid, ...extra });
    this._post(s({ type: 'plan-started', goal }));

    try {
      await orchestrator.runOrchestration(
        goal,
        this._systemPrompt,
        tasks  => this._post(s({ type: 'plan-tasks',       tasks: tasks.map(t => ({ id: t.id, title: t.title })) })),
        taskId => this._post(s({ type: 'plan-task-update', taskId, status: 'running' })),
        (taskId, text)   => this._post(s({ type: 'plan-token', taskId, text })),
        (taskId, n, inp) => this._post(s({ type: 'plan-tool',  taskId, name: n, input: JSON.stringify(inp) })),
        (taskId, out)    => this._post(s({ type: 'plan-task-update', taskId, status: 'done',  output: out })),
        (taskId, err)    => this._post(s({ type: 'plan-task-update', taskId, status: 'error', output: err })),
        ()     => this._post(s({ type: 'plan-complete' })),
        {
          model:           cfg.get('claudeModel')   ?? 'claude-opus-4-7',
          maxSubAgents:    cfg.get('maxSubAgents')  ?? 4,
          toolOpts,
          isCancelled:     ()       => this._planCancelled,
          isPaused:        (taskId) => this._pausedTasks.has(taskId),
          onPauseResolved: (taskId, resolve) => this._resumeResolvers.set(taskId, resolve),
        }
      );
    } catch (err) {
      this._post(s({ type: 'plan-error', text: err.message }));
    }
  }

  // ── Agents ───────────────────────────────────────────────────────────

  _pushAgents() {
    this._post({
      type:   'agents',
      agents: this._agents.map(a => ({ id: a.id, name: a.name, description: a.description })),
    });
  }

  reloadAgents() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    if (root) {
      this._agents = loadAgents(root);
      if (!this._agents.find(a => a.id === this._activeAgent)) this._activeAgent = 'default';
    }
    this._pushAgents();
  }

  // ── Ollama model list (Phase 8) ──────────────────────────────────────

  reloadOllamaModels() {
    const cfg  = vscode.workspace.getConfiguration('motkra');
    const host = cfg.get('ollamaHost') ?? 'localhost';
    const port = cfg.get('ollamaPort') ?? 11434;

    const req = http.get(`http://${host}:${port}/api/tags`, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const models = (JSON.parse(data).models ?? []).map(m => m.name);
          this._post({ type: 'ollama-models', models });
        } catch { /* Ollama not running — silent */ }
      });
    });
    req.on('error', () => { /* silent — Ollama may not be running */ });
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  _pushVoiceConfig() {
    const cfg = vscode.workspace.getConfiguration('motkra');
    this._post({
      type:       'voice-config',
      sttEnabled: cfg.get('voiceEnabled', false),
      ttsEnabled: cfg.get('ttsEnabled',   false),
    });
  }

  _pushSavedCost() {
    const total = this._ctx.globalState.get('motkra.totalSaved') ?? 0;
    if (total > 0) this._post({ type: 'cost-update', saved: total });
  }

  _pushMemoryCount() {
    const count = memory.countFacts(this._workspace);
    this._post({ type: 'memory-count', count });
  }

  _postSystemMsg(text) {
    this._post({ type: 'system-msg', text });
  }

  _out() {
    if (!this._channel) this._channel = vscode.window.createOutputChannel('Motkra');
    return this._channel;
  }

  _getEditorContext() {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return '';
    const name = path.basename(ed.document.fileName);
    const sel  = ed.document.getText(ed.selection);
    if (sel.trim()) {
      const start = ed.selection.start.line + 1;
      const end   = ed.selection.end.line + 1;
      const range = start === end ? `line ${start}` : `lines ${start}–${end}`;
      return `Selected code in \`${name}\` (${range}):\n\`\`\`\n${sel}\n\`\`\``;
    }
    return `Current file \`${name}\`:\n\`\`\`\n${ed.document.getText().slice(0, 6000)}\n\`\`\``;
  }

  _pushEditorContext() {
    const ed = vscode.window.activeTextEditor;
    if (!ed) { this._post({ type: 'context', ctx: null }); return; }
    const file         = path.basename(ed.document.fileName);
    const sel          = ed.document.getText(ed.selection);
    const hasSelection = sel.trim().length > 0;
    let lines          = null;
    if (hasSelection) {
      const start = ed.selection.start.line + 1;
      const end   = ed.selection.end.line + 1;
      lines = start === end ? `line ${start}` : `lines ${start}–${end}`;
    }
    this._post({ type: 'context', ctx: { file, lines, hasSelection } });
  }

  _debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  _post(msg) { this._view?.webview.postMessage(msg); }

  _buildHtml(webview) {
    const htmlPath = path.join(this._ctx.extensionPath, 'media', 'panel.html');
    const nonce    = [...Array(32)].map(() =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[
        Math.floor(Math.random() * 62)
      ]
    ).join('');
    return fs.readFileSync(htmlPath, 'utf8').replace(/\$\{nonce\}/g, nonce);
  }
}

// ── Daemon connectivity (Phase 11) ─────────────────────────────────────────

/**
 * Check whether the Motkra daemon is running on the given port.
 * @param {number}   port
 * @param {Function} callback  (running: boolean) → void
 */
function checkDaemon(port, callback) {
  const req = http.get(`http://127.0.0.1:${port}/status`, res => {
    let body = '';
    res.on('data', c => { body += c; });
    res.on('end', () => {
      try {
        const data = JSON.parse(body);
        callback(data.status === 'ok');
      } catch { callback(false); }
    });
  });
  req.setTimeout(2000, () => { req.destroy(); callback(false); });
  req.on('error', () => callback(false));
}

// ── Activation ──────────────────────────────────────────────────────────────

function activate(context) {
  const provider = new MoktaProvider(context);

  // ── Webview ──────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('motkra.panel', provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  provider.reloadAgents();

  // ── Agent file watcher ───────────────────────────────────────────────
  const watcher = vscode.workspace.createFileSystemWatcher(
    '**/{.github/agents,claude.md,CLAUDE.md,architect.{yml,yaml},.agents/**}'
  );
  const reload = () => provider.reloadAgents();
  watcher.onDidCreate(reload); watcher.onDidChange(reload); watcher.onDidDelete(reload);
  context.subscriptions.push(watcher);

  // ── Workspace RAG index (Phase 6) ───────────────────────────────────
  const buildIndex = () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    const cfg  = vscode.workspace.getConfiguration('motkra');
    if (!root || !cfg.get('workspaceIndex', true)) return;
    const count = indexer.index(root);
    provider._post({ type: 'rag-indexed', count });
  };

  // Build initial index 1.5 s after activation to not block startup
  setTimeout(buildIndex, 1500);

  // Incremental updates on save / create / delete
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(doc => {
      const cfg = vscode.workspace.getConfiguration('motkra');
      if (cfg.get('workspaceIndex', true)) indexer.indexFile(doc.uri.fsPath);
    }),
    vscode.workspace.onDidCreateFiles(e => {
      const cfg = vscode.workspace.getConfiguration('motkra');
      if (cfg.get('workspaceIndex', true)) e.files.forEach(f => indexer.indexFile(f.fsPath));
    }),
    vscode.workspace.onDidDeleteFiles(e => {
      e.files.forEach(f => indexer.removeFile(f.fsPath));
    })
  );

  // ── Ambient watchers (Phase 2) ───────────────────────────────────────
  ambientWatcher.activate(provider).forEach(d => context.subscriptions.push(d));

  // ── Inline completions (Phase 5) ─────────────────────────────────────
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: '**' },
      new MoktaInlineProvider()
    )
  );

  // ── Commands ──────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('motkra.reloadAgents', () => {
      provider.reloadAgents();
      vscode.window.showInformationMessage('Motkra: agents reloaded.');
    }),

    vscode.commands.registerCommand('motkra.sendSelection', () => {
      const sel = vscode.window.activeTextEditor?.document.getText(
        vscode.window.activeTextEditor.selection
      );
      if (sel?.trim()) provider.inject(`Explain this code:\n\`\`\`\n${sel}\n\`\`\``);
    }),

    vscode.commands.registerCommand('motkra.fixSelection', () => {
      const ed  = vscode.window.activeTextEditor;
      const sel = ed?.document.getText(ed.selection);
      if (sel?.trim()) provider.inject(`Fix this code (edit the file directly):\n\`\`\`\n${sel}\n\`\`\``);
    }),

    // ── Git commands (Phase 2D / 7) ────────────────────────────────────
    vscode.commands.registerCommand('motkra.commitMessage', async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
      if (!root) return;
      try {
        const diff = execSync('git diff --staged', { cwd: root, timeout: 5000 }).toString().trim();
        if (!diff) {
          vscode.window.showWarningMessage('Motkra: No staged changes. Run "git add" first.');
          return;
        }
        vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Motkra: generating commit message…' },
          async () => {
            const cfg = vscode.workspace.getConfiguration('motkra');
            let msg   = '';
            await askGemma(
              [
                { role: 'system', content: 'Generate a Conventional Commit message for this diff. Output ONLY the commit message on one line, nothing else.' },
                { role: 'user',   content: `\`\`\`diff\n${diff.slice(0, 4000)}\n\`\`\`` }
              ],
              tok => { msg += tok; },
              {
                host:  cfg.get('ollamaHost')  ?? 'localhost',
                port:  cfg.get('ollamaPort')  ?? 11434,
                model: cfg.get('defaultLocalModel') ?? 'gemma4:e2b',
              }
            );
            const scmInputBox = vscode.scm?.inputBox;
            if (scmInputBox) scmInputBox.value = msg.trim();
            else vscode.env.clipboard.writeText(msg.trim()).then(() =>
              vscode.window.showInformationMessage('Motkra: commit message copied to clipboard.')
            );
          }
        );
      } catch (e) {
        vscode.window.showErrorMessage(`Motkra: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand('motkra.explainDiff', () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
      if (!root) return;
      try {
        const diff = execSync('git diff HEAD', { cwd: root, timeout: 5000 }).toString().trim();
        if (!diff) { vscode.window.showWarningMessage('Motkra: No uncommitted changes.'); return; }
        provider.inject(`Explain what changed in this diff:\n\`\`\`diff\n${diff.slice(0, 6000)}\n\`\`\``);
      } catch (e) {
        vscode.window.showErrorMessage(`Motkra: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand('motkra.reviewPR', () => {
      provider.inject('Review this PR diff for bugs, style issues, and improvements:\n```diff\n\n```');
    }),

    // ── Phase 11 — Daemon status command ──────────────────────────────
    vscode.commands.registerCommand('motkra.daemonStatus', () => {
      const cfg  = vscode.workspace.getConfiguration('motkra');
      const port = cfg.get('daemonPort') ?? 7432;
      checkDaemon(port, running => {
        if (running) {
          vscode.window.showInformationMessage(
            `Motkra Daemon is running on port ${port}. System-wide chat available via Ctrl+Shift+Space.`,
            'Open Chat'
          ).then(sel => {
            if (sel === 'Open Chat') vscode.env.openExternal(vscode.Uri.parse(`http://127.0.0.1:${port}/status`));
          });
        } else {
          vscode.window.showInformationMessage(
            'Motkra Daemon is not running. Start it with: cd motkra-daemon && npm start',
            'Show Instructions'
          ).then(sel => {
            if (sel === 'Show Instructions')
              vscode.window.showInformationMessage('Run: cd motkra-daemon && npm install && npm start');
          });
        }
      });
    })
  );

  // ── Phase 11 — Daemon connectivity check (silent) ──────────────────
  const cfg  = vscode.workspace.getConfiguration('motkra');
  const port = cfg.get('daemonPort') ?? 7432;
  checkDaemon(port, running => {
    if (running) {
      provider._out().appendLine('[Motkra] Daemon connected on port ' + port);
    }
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
