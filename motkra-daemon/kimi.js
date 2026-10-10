'use strict';

// Kimi through NVIDIA's OpenAI-compatible endpoint (same as dual_ai/kimi_client.py).
// Streams Server-Sent Events; no tools.

const https = require('https');

const URL_ = new URL('https://integrate.api.nvidia.com/v1/chat/completions');

/**
 * @param {Array}    messages  prepared payload (redacted by the brain)
 * @param {string}   system
 * @param {Function} onToken
 * @returns {Promise<string>} full reply text (as received; placeholders still in it)
 */
function streamKimi(messages, system, onToken) {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) return Promise.reject(new Error('NVIDIA_API_KEY is not set in dual_ai/.env'));
  const body = JSON.stringify({
    model: process.env.KIMI_MODEL || 'moonshotai/kimi-k3',
    messages: [{ role: 'system', content: system }, ...messages],
    max_tokens: 16384,
    temperature: 1.0,
    stream: true,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(URL_, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      if (res.statusCode !== 200) {
        let err = '';
        res.on('data', c => { err += c; });
        res.on('end', () => reject(new Error(`NVIDIA API error ${res.statusCode}: ${err.slice(0, 300)}`)));
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
              if (piece) { full += piece; onToken(piece); }
            }
          } catch { /* partial or non-JSON line */ }
        }
      });
      res.on('end', () => resolve(full));
      res.on('error', reject);
    });
    req.setTimeout(300_000, () => req.destroy(new Error('NVIDIA API timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

module.exports = { streamKimi };
