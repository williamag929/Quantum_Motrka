#!/usr/bin/env node
'use strict';

/**
 * Motkra MCP Server — exposes local Ollama models to Claude Desktop and any
 * MCP-compatible client.
 *
 * Transport:
 *   stdio   — always active; connect from Claude Desktop via mcpServers config
 *   TCP     — active when MOTKRA_MCP_PORT env var is set (same JSON-RPC protocol)
 *
 * Claude Desktop config example (~/.claude/claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "motkra": {
 *         "command": "node",
 *         "args": ["/path/to/motkra-mcp/index.js"]
 *       }
 *     }
 *   }
 *
 * Tools exposed:
 *   ollama_chat         — send messages to any local Ollama model
 *   ollama_list_models  — list all models available on this machine
 */

const readline = require('readline');
const http     = require('http');
const net      = require('net');

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'localhost';
const OLLAMA_PORT = parseInt(process.env.OLLAMA_PORT ?? '11434', 10);

// ── Ollama helpers ────────────────────────────────────────────────────────────

function ollamaRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req  = http.request(
      {
        hostname: OLLAMA_HOST,
        port:     OLLAMA_PORT,
        path:     urlPath,
        method,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
          : {},
      },
      res => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); } catch { resolve({ _raw: raw }); }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function ollamaChat(model, messages, systemPrompt) {
  const msgs = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages;
  const resp = await ollamaRequest('POST', '/api/chat', { model, messages: msgs, stream: false });
  return resp.message?.content ?? resp.error ?? `Unexpected response: ${JSON.stringify(resp)}`;
}

async function ollamaListModels() {
  const resp = await ollamaRequest('GET', '/api/tags', null);
  return (resp.models ?? []).map(m => m.name);
}

// ── MCP tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name:        'ollama_chat',
    description: 'Send a chat message to a local Ollama model. Use this to run inference on a locally hosted LLM without sending data to the cloud.',
    inputSchema: {
      type: 'object',
      properties: {
        model:  { type: 'string', description: 'Ollama model name, e.g. gemma4:e2b or llama3.2' },
        prompt: { type: 'string', description: 'User message to send' },
        system: { type: 'string', description: 'Optional system prompt' },
      },
      required: ['model', 'prompt'],
    },
  },
  {
    name:        'ollama_list_models',
    description: 'List all Ollama models currently available on this machine.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ── MCP request handler ───────────────────────────────────────────────────────

async function handleRequest(req) {
  const { id, method, params } = req;

  // Notifications have no id — no response expected
  if (id === undefined || id === null) return null;

  const ok  = result  => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {

    case 'initialize':
      return ok({
        protocolVersion: '2024-11-05',
        capabilities:    { tools: {} },
        serverInfo:      { name: 'motkra-mcp', version: '0.1.0' },
      });

    case 'ping':
      return ok({});

    case 'tools/list':
      return ok({ tools: TOOLS });

    case 'tools/call': {
      const { name, arguments: args = {} } = params ?? {};

      if (name === 'ollama_chat') {
        const { model, prompt, system } = args;
        if (!model || !prompt) return err(-32602, '"model" and "prompt" are required');
        try {
          const text = await ollamaChat(model, [{ role: 'user', content: prompt }], system);
          return ok({ content: [{ type: 'text', text }] });
        } catch (e) {
          return ok({ content: [{ type: 'text', text: `Ollama error: ${e.message}` }], isError: true });
        }
      }

      if (name === 'ollama_list_models') {
        try {
          const models = await ollamaListModels();
          const text = models.length
            ? `Available Ollama models:\n${models.map(m => `• ${m}`).join('\n')}`
            : 'No models found. Is Ollama running? Try: ollama serve';
          return ok({ content: [{ type: 'text', text }] });
        } catch (e) {
          return ok({ content: [{ type: 'text', text: `Ollama error: ${e.message}` }], isError: true });
        }
      }

      return err(-32601, `Unknown tool: ${name}`);
    }

    default:
      return err(-32601, `Method not found: ${method}`);
  }
}

// ── Connection handler (shared by stdio and TCP) ──────────────────────────────

function handleConnection(input, writeFn) {
  const rl = readline.createInterface({ input, terminal: false });
  rl.on('line', async line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req;
    try { req = JSON.parse(trimmed); } catch { return; }
    const resp = await handleRequest(req);
    if (resp) writeFn(JSON.stringify(resp) + '\n');
  });
  return rl;
}

// ── Stdio transport ───────────────────────────────────────────────────────────

const stdioRl = handleConnection(process.stdin, s => process.stdout.write(s));
stdioRl.on('close', () => process.exit(0));

// ── TCP transport (optional) ──────────────────────────────────────────────────

const tcpPort = process.env.MOTKRA_MCP_PORT ? parseInt(process.env.MOTKRA_MCP_PORT, 10) : null;

if (tcpPort) {
  const server = net.createServer(socket => {
    const rl = handleConnection(socket, s => { if (!socket.destroyed) socket.write(s); });
    socket.on('error', () => rl.close());
    socket.on('close', () => rl.close());
  });
  server.listen(tcpPort, '127.0.0.1', () => {
    process.stderr.write(`[motkra-mcp] TCP server on 127.0.0.1:${tcpPort}\n`);
  });
  server.on('error', e => process.stderr.write(`[motkra-mcp] TCP error: ${e.message}\n`));
}

process.stderr.write('[motkra-mcp] MCP server ready (stdio)\n');
