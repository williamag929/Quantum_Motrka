'use strict';

const https = require('https');

const URL = new URL('https://integrate.api.nvidia.com/v1/chat/completions');

/**
 * Stream a response from Kimi through NVIDIA's OpenAI-compatible API.
 * @param {Array} messages Conversation history without the system message.
 * @param {Function} onToken Called with each generated text chunk.
 * @param {Array|null} [tools] OpenAI-compatible function declarations.
 * @returns {Promise<string|{text:string,toolCalls:Array}>} Full response or tool-call turn.
 */
function streamKimi(messages, onToken, tools = null) {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) return Promise.reject(new Error('NVIDIA_API_KEY is not set in dual_ai/.env'));

  const body = JSON.stringify({
    model: process.env.KIMI_MODEL || 'moonshotai/kimi-k3',
    messages,
    max_tokens: 16384,
    temperature: 1,
    stream: true,
    ...(tools ? { tools } : {}),
  });

  return new Promise((resolve, reject) => {
    const req = https.request(URL, {
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
        res.on('end', () => reject(new Error(`NVIDIA API error ${res.statusCode}: ${errorBody.slice(0, 300)}`)));
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

module.exports = { streamKimi };
