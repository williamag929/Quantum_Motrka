'use strict';

// Ollama HTTP helpers shared by the MCP server and the digest worker.

const http = require('http');

const OLLAMA_HOST  = process.env.OLLAMA_HOST ?? 'localhost';
const OLLAMA_PORT  = parseInt(process.env.OLLAMA_PORT ?? '11434', 10);
const DIGEST_MODEL = process.env.MOTKRA_MCP_MODEL ?? 'gemma4:e2b';
const DIGEST_CTX   = parseInt(process.env.MOTKRA_MCP_CTX ?? '16384', 10);

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

/** One non-streaming completion for digests: no hidden reasoning, bounded output. */
async function digestChat(system, prompt, maxTokens) {
  const resp = await ollamaRequest('POST', '/api/chat', {
    model: DIGEST_MODEL,
    stream: false,
    think: false,
    options: { num_ctx: DIGEST_CTX, num_predict: maxTokens, temperature: 0.2 },
    messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
  });
  if (resp.error) throw new Error(`Ollama: ${resp.error}`);
  if (typeof resp.message?.content !== 'string') throw new Error(`Unexpected Ollama response: ${JSON.stringify(resp).slice(0, 200)}`);
  return resp.message.content;
}

async function ollamaListModels() {
  const resp = await ollamaRequest('GET', '/api/tags', null);
  return (resp.models ?? []).map(m => m.name);
}

module.exports = { DIGEST_MODEL, ollamaChat, digestChat, ollamaListModels };
