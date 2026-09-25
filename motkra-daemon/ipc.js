'use strict';

const http = require('http');
const fsTools = require('./fs-tools');

let _server = null;

// ── System prompt ─────────────────────────────────────────────────────────

const SYSTEM =
  'You are Motkra, a privacy-first AI coding assistant running as a system tray daemon. ' +
  'Answer concisely. Use markdown only when it genuinely helps readability. ' +
  'If asked to write code, produce complete, runnable code.';

// ── Router — same keyword-scoring logic as dual_ai_ext/router.js ─────────

const LOCAL_HINTS = ['quick','brief','short','fast','simple','summarize','tldr','private','offline','local'];
const CLOUD_HINTS = ['explain','analyze','generate','implement','fix','edit','refactor','design','debug','create','write','build','how do','how does'];

// Absolute Windows or Unix-style paths: the local model has no file tools, so these go to Claude.
const PATH_RE = /(?:^|[\s"'`(])(?:[a-zA-Z]:[\\/]|~[\\/]|\/(?:home|users|mnt|opt|srv|var|etc)\/)/i;

function route(text) {
  if (PATH_RE.test(text)) return 'claude';
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);
  const localScore = LOCAL_HINTS.filter(h => lower.includes(h)).length;
  const cloudScore = CLOUD_HINTS.filter(h => lower.includes(h)).length;
  if (localScore > cloudScore) return 'gemma';
  if (cloudScore > localScore) return 'claude';
  return words.length <= 8 ? 'gemma' : 'claude'; // tie-break: short → local
}

// ── Gemma streaming (Ollama) ──────────────────────────────────────────────

async function handleGemmaStream(text, history, onToken) {
  const messages = [
    { role: 'system', content: SYSTEM },
    ...(Array.isArray(history) ? history : []),
    { role: 'user', content: text },
  ];

  const body = JSON.stringify({
    model:    process.env.GEMMA_MODEL ?? 'gemma4:e2b',
    messages,
    stream:   true,
  });

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: process.env.OLLAMA_HOST ?? 'localhost',
      port:     parseInt(process.env.OLLAMA_PORT ?? '11434', 10),
      path:     '/api/chat',
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let fullText = '';
      let buf = '';
      res.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop(); // hold incomplete line
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj   = JSON.parse(line);
            const token = obj.message?.content ?? '';
            if (token) { onToken(token); fullText += token; }
          } catch { /* malformed line — skip */ }
        }
      });
      res.on('end',   () => resolve(fullText));
      res.on('error', reject);
    });
    req.on('error', err => reject(new Error(`Ollama unreachable: ${err.message}. Is 'ollama serve' running?`)));
    req.write(body);
    req.end();
  });
}

// ── Claude streaming ──────────────────────────────────────────────────────

const AGENT_NOTE =
  '\n\nYou can work with files on the user\'s computer through the list_directory, read_file and write_file tools. ' +
  'When the user mentions a folder or file, use the tools instead of asking them to paste content: ' +
  'start with list_directory, then read the files that matter. The user is asked to approve each new folder; ' +
  'if access is denied, say so and continue with what you have. Only write files when the user asked for changes.';

const MAX_TOOL_TURNS = 15;

/**
 * @param {object|null} agent  { ask, onActivity } enables the filesystem tools (chat window only)
 */
async function handleClaudeStream(text, history, onToken, agent = null) {
  const { default: Anthropic } = require('@anthropic-ai/sdk');
  const client = new Anthropic();

  const messages = [
    ...(Array.isArray(history) ? history : []).filter(
      m => m.role === 'user' || m.role === 'assistant'
    ),
    { role: 'user', content: text },
  ];

  const params = {
    model:         'claude-opus-4-7',
    max_tokens:    16000,
    thinking:      { type: 'adaptive' },
    output_config: { effort: 'high' },
    system:        [{ type: 'text', text: SYSTEM + (agent ? AGENT_NOTE : ''), cache_control: { type: 'ephemeral' } }],
    messages,
    ...(agent ? { tools: fsTools.TOOLS } : {}),
  };

  let fullText = '';
  const emit = t => { onToken(t); fullText += t; };

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const stream = client.messages.stream(params);
    stream.on('text', emit);
    const msg = await stream.finalMessage();
    if (!agent || msg.stop_reason !== 'tool_use') return fullText;

    messages.push({ role: 'assistant', content: msg.content });
    const results = [];
    for (const block of msg.content) {
      if (block.type !== 'tool_use') continue;
      try {
        const out = await fsTools.runTool(block.name, block.input, agent);
        results.push({ type: 'tool_result', tool_use_id: block.id, content: out });
      } catch (err) {
        agent.onActivity?.(`⚠ ${err.message}`);
        results.push({ type: 'tool_result', tool_use_id: block.id, content: err.message, is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
    if (fullText && !fullText.endsWith('\n')) emit('\n\n');
  }

  emit('\n\n(Stopped after too many file operations. Ask me to continue if needed.)');
  return fullText;
}

// ── Public entry point ────────────────────────────────────────────────────

/**
 * Route and stream a response.
 *
 * @param {string}   text     User message
 * @param {Array}    history  [{role, content}]
 * @param {Function} onToken  Called for each streamed text chunk
 * @param {string}   model    'auto' | 'claude' | 'gemma'
 * @param {Function} onModel  Called once with the chosen model name before first token
 * @param {object}   agent    { ask, onActivity } to enable filesystem tools (chat window only)
 */
async function handleQueryStream(text, history, onToken, model = 'auto', onModel = null, agent = null) {
  const chosen = model === 'auto' ? route(text) : model;
  onModel?.(chosen);
  if (chosen === 'gemma') {
    return await handleGemmaStream(text, history, onToken);
  }
  return await handleClaudeStream(text, history, onToken, agent);
}

// ── HTTP server (browser extension + VS Code extension) ───────────────────

function startServer(port) {
  _server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', name: 'motkra-daemon', version: '0.1.0', hasKey: !!process.env.ANTHROPIC_API_KEY }));
      return;
    }

    if (req.method === 'POST' && req.url === '/query') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', async () => {
        try {
          const { text, history, stream: wantStream, model = 'auto' } = JSON.parse(body);
          if (wantStream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
            await handleQueryStream(text, history ?? [], token => {
              if (!res.writableEnded) res.write(`data: ${JSON.stringify({ token })}\n\n`);
            }, model);
            if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
          } else {
            const result = await handleQueryStream(text, history ?? [], () => {}, model);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ result }));
          }
        } catch (err) {
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
          if (!res.writableEnded) res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404); res.end('Not found');
  });

  _server.on('error', err => {
    if (err.code === 'EADDRINUSE') console.warn(`[Motkra] Port ${port} in use — HTTP server not started.`);
    else console.error('[Motkra] Server error:', err);
  });

  _server.listen(port, '127.0.0.1', () =>
    console.log(`[Motkra] HTTP server listening on http://127.0.0.1:${port}`)
  );
}

function stopServer() {
  _server?.close();
  _server = null;
}

module.exports = { handleQueryStream, startServer, stopServer };
