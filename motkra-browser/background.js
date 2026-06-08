'use strict';

// ── Port-based streaming ──────────────────────────────────────────────────
// Using chrome.runtime.connect() keeps the MV3 service worker alive
// for the duration of the streaming fetch.

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'motkra-query') return;

  port.onMessage.addListener(async msg => {
    if (msg.type !== 'query') return;

    const { text, context, history } = msg;
    const { motkra_daemon_port: daemonPort = 7432 } =
      await chrome.storage.local.get('motkra_daemon_port');

    // Build the user message: query + extracted page context
    const fullText = context
      ? `${text}\n\n---\nPage context:\n${context}`
      : text;

    try {
      const res = await fetch(`http://127.0.0.1:${daemonPort}/query`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          text:    fullText,
          history: history ?? [],
          stream:  true,
        }),
      });

      if (!res.ok) throw new Error(`Daemon returned HTTP ${res.status}`);

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buf     = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop(); // keep any incomplete trailing line

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') { port.postMessage({ type: 'done' }); return; }
          try {
            const { token } = JSON.parse(data);
            if (token) port.postMessage({ type: 'token', text: token });
          } catch { /* malformed SSE line — skip */ }
        }
      }

      port.postMessage({ type: 'done' });
    } catch (err) {
      port.postMessage({ type: 'error', text: err.message });
    }
  });
});

// ── One-shot messages (daemon health check from content / popup) ──────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'check-daemon') {
    const port = msg.port ?? 7432;
    fetch(`http://127.0.0.1:${port}/status`)
      .then(r => r.json())
      .then(d => sendResponse({ ok: d.status === 'ok', version: d.version }))
      .catch(() => sendResponse({ ok: false }));
    return true; // keep message channel open for async response
  }
});
