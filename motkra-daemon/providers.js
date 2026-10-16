'use strict';

// What each provider offers and whether the chosen model works, for ⚙ Settings:
//   listModels(id) → { ok, models[] | message }   fills the model suggestions
//   testModel(id)  → { ok, status?, message }     the Test button
// Keys are read from the environment and only ever go in request headers.

const http  = require('http');
const https = require('https');
const settings = require('./settings');
const kimi = require('./kimi');

const TIMEOUT_MS = 8000;

/** GET a JSON document. Resolves { status, json, text }; rejects on network errors and timeouts. */
function getJson(urlString, headers = {}) {
  const url = new URL(urlString);
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'http:' ? http : https).request(url, { method: 'GET', headers }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', c => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/** The provider's own error text, else the start of the body. */
function errorText(r) {
  return r.json?.detail ?? r.json?.error?.message ?? r.json?.message ?? r.text.slice(0, 200);
}

const ollamaUrl = () => `http://${process.env.OLLAMA_HOST ?? 'localhost'}:${parseInt(process.env.OLLAMA_PORT ?? '11434', 10)}`;
const anthropicUrl = () => (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
const anthropicHeaders = () => ({ 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' });

const unknown = id => ({ ok: false, message: `Unknown provider: ${id}` });
const missingKey = name => ({ ok: false, message: `${name} is not set in dual_ai/.env` });

async function listModels(id) {
  try {
    if (id === 'local') {
      const r = await getJson(`${ollamaUrl()}/api/tags`);
      if (r.status !== 200) return { ok: false, status: r.status, message: errorText(r) };
      return { ok: true, models: (r.json?.models ?? []).map(m => m.name) };
    }
    if (id === 'claude') {
      if (!process.env.ANTHROPIC_API_KEY) return missingKey('ANTHROPIC_API_KEY');
      const r = await getJson(`${anthropicUrl()}/v1/models?limit=100`, anthropicHeaders());
      if (r.status !== 200) return { ok: false, status: r.status, message: errorText(r) };
      return { ok: true, models: (r.json?.data ?? []).map(m => m.id) };
    }
    if (id === 'nvidia') {
      const { baseUrl, apiKey, apiKeyEnv } = settings.endpointFor();
      if (!apiKey) return missingKey(apiKeyEnv);
      const r = await getJson(`${baseUrl}/models`, { Authorization: `Bearer ${apiKey}` });
      if (r.status !== 200) return { ok: false, status: r.status, message: errorText(r) };
      return { ok: true, models: (r.json?.data ?? []).map(m => m.id) };
    }
  } catch (err) {
    return { ok: false, message: id === 'local' ? 'Ollama is not running.' : `Could not reach the provider: ${err.message}` };
  }
  return unknown(id);
}

async function testModel(id) {
  const model = id in settings.PROVIDERS ? settings.modelFor(id) : null;
  try {
    if (id === 'local') {
      const r = await listModels('local');
      if (!r.ok) return r;
      return r.models.includes(model)
        ? { ok: true, message: `${model} is installed.` }
        : { ok: false, message: `${model} is not installed. Run: ollama pull ${model}` };
    }
    if (id === 'claude') {
      if (!process.env.ANTHROPIC_API_KEY) return missingKey('ANTHROPIC_API_KEY');
      const r = await getJson(`${anthropicUrl()}/v1/models/${encodeURIComponent(model)}`, anthropicHeaders());
      return r.status === 200
        ? { ok: true, message: `${model} is available.` }
        : { ok: false, status: r.status, message: errorText(r) };
    }
    if (id === 'nvidia') return await kimi.testModel('nvidia');
  } catch (err) {
    return { ok: false, message: `Could not reach the provider: ${err.message}` };
  }
  return unknown(id);
}

module.exports = { listModels, testModel };
