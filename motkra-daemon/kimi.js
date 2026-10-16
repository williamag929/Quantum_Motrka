'use strict';

// The OpenAI-compatible lane (engine "kimi"): NVIDIA by default, any other endpoint through
// ⚙ Settings (settings.endpointFor / settings.modelFor). Same wire format as dual_ai/kimi_client.py.
// Streams Server-Sent Events; no tools.

const http  = require('http');
const https = require('https');
const settings = require('./settings');

/**
 * NVIDIA's Kimi K3 answers with garbage ("@ @ @…", empty content) whenever the request has a
 * system message. Put the instructions at the start of the first user message instead; it keeps
 * the model's reasoning, unlike turning thinking off.
 */
function foldSystem(system, messages) {
  const text = String(system ?? '').trim();
  if (!text) return messages;
  const i = messages.findIndex(m => m.role === 'user' && typeof m.content === 'string');
  if (i === -1) return [{ role: 'user', content: `Instructions:\n${text}` }, ...messages];
  return messages.map((m, j) => (j === i ? { ...m, content: `Instructions:\n${text}\n\n---\n\n${m.content}` } : m));
}

/**
 * Send one chat request and feed the streamed text to onToken.
 * Rejects with Error(message) carrying `.status` when the endpoint answers with an error.
 */
function request({ messages, system, onToken, maxTokens = 16384, allowEmpty = false }) {
  const { baseUrl, apiKey, apiKeyEnv } = settings.endpointFor();
  if (!apiKey) return Promise.reject(new Error(`${apiKeyEnv} is not set in dual_ai/.env`));
  const url = new URL(`${baseUrl}/chat/completions`);
  const body = JSON.stringify({
    model: settings.modelFor('nvidia'),
    messages: foldSystem(system, messages),
    max_tokens: maxTokens,
    // NVIDIA's Kimi K3 produces gibberish at temperature 1.0 (empty content, random reasoning tokens).
    temperature: parseFloat(process.env.KIMI_TEMPERATURE ?? '0.6'),
    top_p: parseFloat(process.env.KIMI_TOP_P ?? '0.95'),
    stream: true,
  });

  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'http:' ? http : https).request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      if (res.statusCode !== 200) {
        let err = '';
        res.on('data', c => { err += c; });
        res.on('end', () => {
          let detail = err.slice(0, 300);
          try { const j = JSON.parse(err); detail = j.detail ?? j.error?.message ?? j.message ?? detail; } catch {}
          reject(Object.assign(new Error(`${url.hostname} error ${res.statusCode}: ${detail}`), { status: res.statusCode, detail }));
        });
        return;
      }
      let buf = '', full = '';
      res.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try {
            for (const choice of JSON.parse(data).choices ?? []) {
              const piece = choice.delta?.content ?? '';
              if (piece) { full += piece; onToken?.(piece); }
            }
          } catch { /* partial or non-JSON line */ }
        }
      });
      res.on('end', () => {
        if (!full.trim() && !allowEmpty) reject(new Error('The model returned an empty answer. Try again, or check the model and KIMI_TEMPERATURE in ⚙ Settings.'));
        else resolve(full);
      });
      res.on('error', reject);
    });
    req.setTimeout(300_000, () => req.destroy(new Error('Model API timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * @param {Array}    messages  prepared payload (redacted by the brain)
 * @param {string}   system
 * @param {Function} onToken
 * @returns {Promise<string>} full reply text (as received; placeholders still in it)
 */
function streamKimi(messages, system, onToken) {
  return request({ messages, system, onToken });
}

/**
 * Check that a provider's chosen model answers, with one token. Used by ⚙ Settings → Test.
 * @returns {Promise<{ok:boolean, status?:number, message:string}>}
 */
async function testModel(provider) {
  if (provider !== 'nvidia') return { ok: false, message: 'Test not available yet for this provider.' };
  try {
    await request({ messages: [{ role: 'user', content: 'Reply with: ok' }], system: '', maxTokens: 1, allowEmpty: true });
    return { ok: true, message: `${settings.modelFor('nvidia')} answered.` };
  } catch (err) {
    return { ok: false, status: err.status, message: err.detail ?? err.message };
  }
}

module.exports = { streamKimi, testModel, foldSystem };
