'use strict';

const http = require('http');

let _server = null;

// ── System prompt shared by all daemon queries ────────────────────────────

const SYSTEM =
  'You are Motkra, a privacy-first AI coding assistant running as a system tray daemon. ' +
  'Answer concisely. Use markdown only when it genuinely helps readability. ' +
  'If asked to write code, produce complete, runnable code.';

// ── Claude streaming ──────────────────────────────────────────────────────

/**
 * Stream a Claude response, calling onToken for each text chunk.
 *
 * @param {string}   text     User message
 * @param {Array}    history  [{role:'user'|'assistant', content:string}]
 * @param {Function} onToken  (text:string) → void
 * @returns {Promise<string>} Full response text
 */
async function handleQueryStream(text, history, onToken) {
  const { default: Anthropic } = require('@anthropic-ai/sdk');
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

  const messages = [
    ...(Array.isArray(history) ? history : []).filter(
      m => m.role === 'user' || m.role === 'assistant'
    ),
    { role: 'user', content: text }
  ];

  let fullText = '';

  const stream = client.messages.stream({
    model:         'claude-opus-4-7',
    max_tokens:    4096,
    thinking:      { type: 'adaptive' },
    output_config: { effort: 'high' },
    system:        [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages,
  });

  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      onToken(event.delta.text);
      fullText += event.delta.text;
    }
  }

  return fullText;
}

// ── HTTP server ───────────────────────────────────────────────────────────
// Used by: VS Code extension (status check + future session sync)
//          Browser extension (Phase 12)
//          Any HTTP client

function startServer(port) {
  _server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ── GET /status — daemon health check ──────────────────────────────
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status:  'ok',
        name:    'motkra-daemon',
        version: '0.1.0',
        hasKey:  !!process.env.ANTHROPIC_API_KEY,
      }));
      return;
    }

    // ── POST /query — ad-hoc query (streaming or one-shot) ─────────────
    if (req.method === 'POST' && req.url === '/query') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', async () => {
        try {
          const { text, history, stream: wantStream } = JSON.parse(body);

          if (wantStream) {
            res.writeHead(200, {
              'Content-Type':  'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection':    'keep-alive',
            });
            await handleQueryStream(text, history ?? [], token => {
              if (!res.writableEnded) res.write(`data: ${JSON.stringify({ token })}\n\n`);
            });
            if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
          } else {
            const result = await handleQueryStream(text, history ?? [], () => {});
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
    if (err.code === 'EADDRINUSE') {
      console.warn(`[Motkra] Port ${port} in use — daemon HTTP server not started.`);
    } else {
      console.error('[Motkra] Server error:', err);
    }
  });

  _server.listen(port, '127.0.0.1', () => {
    console.log(`[Motkra] Daemon HTTP server listening on http://127.0.0.1:${port}`);
  });
}

function stopServer() {
  _server?.close();
  _server = null;
}

module.exports = { handleQueryStream, startServer, stopServer };
