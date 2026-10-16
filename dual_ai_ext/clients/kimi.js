'use strict';

const http  = require('http');
const https = require('https');
const { kimiConfig } = require('../core/provider-settings');

/**
 * Stream a response from Kimi through NVIDIA's OpenAI-compatible API.
 * @param {Array} messages Conversation history without the system message.
 * @param {Function} onToken Called with each generated text chunk.
 * @param {Array|null} [tools] OpenAI-compatible function declarations.
 * @param {Function|null} [onReasoning] Called with each reasoning chunk (hidden chain-of-thought), if the model emits any.
 * @returns {Promise<string|{text:string,toolCalls:Array}>} Full response or tool-call turn.
 */
/**
 * NVIDIA's Kimi K3 answers with garbage ("@ @ @…", empty content) whenever the request has a
 * system message. Move system text to the start of the first user message instead; it keeps the
 * model's reasoning, unlike turning thinking off.
 */
function foldSystem(messages) {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n').trim();
  const rest = messages.filter(m => m.role !== 'system');
  if (!system) return rest;
  const i = rest.findIndex(m => m.role === 'user' && typeof m.content === 'string');
  if (i === -1) return [{ role: 'user', content: `Instructions:\n${system}` }, ...rest];
  return rest.map((m, j) => (j === i ? { ...m, content: `Instructions:\n${system}\n\n---\n\n${m.content}` } : m));
}

/** Extract a reasoning chunk from a streamed delta. Providers name the field differently. */
function reasoningOf(delta = {}) {
  return delta.reasoning_content ?? delta.reasoning ?? '';
}

function streamKimi(messages, onToken, tools = null, onReasoning = null) {
  // Model, endpoint and key variable come from the Motkra app's ⚙ Settings (NVIDIA by default).
  const { model, baseUrl, apiKeyEnv, apiKey: key } = kimiConfig();
  if (!key) return Promise.reject(new Error(`${apiKeyEnv} is not set in dual_ai/.env`));
  const endpoint = new URL(`${baseUrl}/chat/completions`);

  const body = JSON.stringify({
    model,
    messages: foldSystem(messages),
    max_tokens: 16384,
    // NVIDIA's Kimi K3 produces gibberish at temperature 1.0 (empty content, random reasoning tokens).
    temperature: parseFloat(process.env.KIMI_TEMPERATURE ?? '0.6'),
    top_p: parseFloat(process.env.KIMI_TOP_P ?? '0.95'),
    stream: true,
    ...(tools ? { tools } : {}),
  });

  return new Promise((resolve, reject) => {
    const req = (endpoint.protocol === 'http:' ? http : https).request(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      if (res.statusCode !== 200) {
        let errorBody = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { errorBody += chunk; });
        res.on('end', () => reject(new Error(`${endpoint.hostname} error ${res.statusCode}: ${errorBody.slice(0, 300)}`)));
        return;
      }

      let buffer = '';
      let full = '';
      const toolCalls = new Map();
      const consumeLine = line => {
        if (!line.startsWith('data: ')) return;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') return;
        const choices = JSON.parse(data).choices ?? [];
        for (const choice of choices) {
          const delta = choice.delta ?? {};
          const piece = delta.content ?? '';
          if (piece) {
            full += piece;
            onToken(piece);
          }
          // Reasoning chain-of-thought (field name varies by provider); surface it separately.
          const reasoning = reasoningOf(delta);
          if (reasoning && onReasoning) onReasoning(reasoning);
          for (const call of delta.tool_calls ?? []) {
            const current = toolCalls.get(call.index) ?? {
              id: '',
              type: 'function',
              function: { name: '', arguments: '' },
            };
            if (call.id) current.id += call.id;
            if (call.function?.name) current.function.name += call.function.name;
            if (call.function?.arguments) current.function.arguments += call.function.arguments;
            toolCalls.set(call.index, current);
          }
        }
      };

      res.setEncoding('utf8');
      res.on('data', chunk => {
        try {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) consumeLine(line.trimEnd());
        } catch (err) {
          reject(err);
          res.destroy();
        }
      });
      res.on('end', () => {
        try {
          if (buffer) consumeLine(buffer.trimEnd());
          if (!full.trim() && !toolCalls.size) throw new Error('Kimi (NVIDIA) returned an empty answer. Try again, or check KIMI_MODEL / KIMI_TEMPERATURE.');
          resolve(tools ? { text: full, toolCalls: [...toolCalls.values()] } : full);
        } catch (err) {
          reject(err);
        }
      });
      res.on('error', reject);
    });

    req.setTimeout(300_000, () => req.destroy(new Error('NVIDIA API timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

module.exports = { streamKimi, foldSystem, reasoningOf };
