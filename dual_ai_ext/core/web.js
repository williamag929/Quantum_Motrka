'use strict';

const https = require('https');
const http  = require('http');

// ── In-memory URL cache (1-hour TTL) ─────────────────────────────────────────
const _cache  = new Map(); // url → { content, ts }
const TTL     = 60 * 60 * 1000;

// ── HTTP helper ───────────────────────────────────────────────────────────────

function _get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
  });
}

/** Crude but dependency-free HTML → plain-text stripper. */
function _stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g,  '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Search the web.
 * Uses Brave Search API when a key is provided; falls back to DuckDuckGo
 * instant-answer API (no key required, limited results).
 *
 * @param {string} query
 * @param {string} [braveKey]
 * @returns {Promise<string>} plain-text result summary
 */
async function searchWeb(query, braveKey = '') {
  const q = encodeURIComponent(query);

  if (braveKey) {
    const { status, body } = await _get(
      `https://api.search.brave.com/res/v1/web/search?q=${q}&count=5`,
      { Accept: 'application/json', 'X-Subscription-Token': braveKey }
    );
    if (status >= 400) throw new Error(`Brave Search HTTP ${status}`);
    const data    = JSON.parse(body);
    const results = (data.web?.results ?? []).slice(0, 5);
    if (!results.length) return 'No results found.';
    return results.map((r, i) =>
      `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description ?? ''}`
    ).join('\n\n');
  }

  // DuckDuckGo fallback (instant answers only — no key needed)
  const { body } = await _get(
    `https://api.duckduckgo.com/?q=${q}&format=json&no_html=1&skip_disambig=1`
  );
  const data  = JSON.parse(body);
  const lines = [];
  if (data.AbstractText) lines.push(data.AbstractText);
  for (const t of (data.RelatedTopics ?? []).slice(0, 5)) {
    if (t.Text && t.FirstURL) lines.push(`- ${t.Text}\n  ${t.FirstURL}`);
  }
  if (!lines.length) return 'No instant-answer found. Set motkra.braveSearchKey for full web search.';
  return lines.join('\n\n');
}

/**
 * Fetch a URL and return its text content (HTML stripped, ≤ 10,000 chars).
 * Results are cached for 1 hour per URL.
 *
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchUrl(url) {
  const cached = _cache.get(url);
  if (cached && Date.now() - cached.ts < TTL) return cached.content;

  const { status, body } = await _get(url);
  if (status >= 400) throw new Error(`HTTP ${status} fetching ${url}`);

  const text    = _stripHtml(body);
  const content = text.length > 10_000
    ? text.slice(0, 10_000) + `\n\n[… ${(text.length - 10_000).toLocaleString()} more characters truncated]`
    : text;

  _cache.set(url, { content, ts: Date.now() });
  return content;
}

module.exports = { searchWeb, fetchUrl };
