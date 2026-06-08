'use strict';

(function () {

// Prevent double-injection on dynamic page loads
if (window.__motkraLoaded) return;
window.__motkraLoaded = true;

// ── Storage ───────────────────────────────────────────────────────────────

let daemonPort = 7432;
chrome.storage.local.get('motkra_daemon_port', r => {
  daemonPort = r.motkra_daemon_port ?? 7432;
});

// ── Shadow DOM host ───────────────────────────────────────────────────────
// A zero-size fixed element so the shadow root can position children
// relative to the viewport without being clipped by any parent overflow.

const host = document.createElement('div');
host.id    = 'motkra-root';
host.style.cssText =
  'all:initial!important;position:fixed!important;top:0!important;' +
  'left:0!important;width:0!important;height:0!important;' +
  'overflow:visible!important;z-index:2147483647!important;pointer-events:none!important';
document.documentElement.appendChild(host);

const shadow = host.attachShadow({ mode: 'open' });

// ── Styles ────────────────────────────────────────────────────────────────

const styleEl = document.createElement('style');
styleEl.textContent = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  /* ── Floating trigger button ── */
  #btn {
    position: fixed;
    bottom: 28px;
    right: 28px;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: linear-gradient(135deg, #00bc88 0%, #007acc 100%);
    border: 2px solid rgba(255,255,255,.15);
    cursor: pointer;
    box-shadow: 0 4px 14px rgba(0,188,136,.45);
    font-size: 20px;
    z-index: 2147483646;
    transition: transform .18s ease, box-shadow .18s ease, opacity .18s;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: all;
    line-height: 1;
  }
  #btn:hover  { transform: scale(1.12); box-shadow: 0 6px 20px rgba(0,188,136,.55); }
  #btn.hidden { opacity: 0; pointer-events: none; }
  #btn.active { background: linear-gradient(135deg, #005fa3 0%, #003d6b 100%); }

  /* ── Side drawer ── */
  #drawer {
    position: fixed;
    top: 0;
    right: 0;
    width: 380px;
    height: 100vh;
    background: #1e1e1e;
    border-left: 1px solid #333;
    box-shadow: -6px 0 28px rgba(0,0,0,.55);
    display: flex;
    flex-direction: column;
    transform: translateX(100%);
    transition: transform .25s cubic-bezier(.4,0,.2,1);
    pointer-events: all;
    z-index: 2147483647;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 13px;
    color: #ccc;
  }
  #drawer.open { transform: translateX(0); }

  /* Header */
  #hdr {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 9px 12px;
    background: #252526;
    border-bottom: 1px solid #333;
    flex-shrink: 0;
  }
  #hdr-name { font-size: 11px; font-weight: 700; color: #00bc88; letter-spacing: .07em; text-transform: uppercase; }
  #hdr-url  { flex: 1; font-size: 10px; color: #666; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #close-btn { background: none; border: none; color: #888; cursor: pointer; font-size: 16px; padding: 2px 6px; border-radius: 3px; flex-shrink: 0; }
  #close-btn:hover { color: #ccc; background: #3c3c3c; }

  /* Context chip */
  #ctx-bar {
    padding: 5px 12px;
    border-bottom: 1px solid #1a4a2a;
    font-size: 10px;
    color: #6a9a6a;
    background: #161f16;
    display: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 0;
  }
  #ctx-bar.visible { display: block; }

  /* Messages */
  #msgs {
    flex: 1;
    overflow-y: auto;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  #msgs::-webkit-scrollbar { width: 4px; }
  #msgs::-webkit-scrollbar-thumb { background: #444; border-radius: 2px; }

  #empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    gap: 8px;
    opacity: .38;
    text-align: center;
    font-size: 12px;
    padding: 20px;
  }
  #empty .ico { font-size: 28px; }

  .msg { display: flex; flex-direction: column; gap: 3px; }
  .lbl { font-size: 10px; opacity: .45; text-transform: uppercase; letter-spacing: .05em; }
  .bubble {
    background: #2d2d2d;
    border: 1px solid #3c3c3c;
    border-radius: 6px;
    padding: 8px 10px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 12px;
  }
  .user      .bubble { background: #0d3a58; border-color: #1a6fa0; }
  .assistant .bubble { background: #1a2e1a; border-color: #2a5a2a; }
  .error     .bubble { border-color: #f48771; color: #f48771; }
  .bubble pre  { background: #141414; border-radius: 4px; padding: 8px; overflow-x: auto; margin: 4px 0; font-family: monospace; font-size: 11px; white-space: pre; }
  .bubble code { font-family: monospace; font-size: 11px; }
  .bubble strong { color: #fff; }
  .cursor { display: inline-block; width: 2px; height: 1em; background: currentColor; animation: blink .7s step-end infinite; vertical-align: text-bottom; }
  @keyframes blink { 50% { opacity: 0; } }

  /* Daemon warning */
  #warn {
    display: none;
    padding: 6px 12px;
    background: #3a2500;
    color: #ffd580;
    font-size: 11px;
    text-align: center;
    border-top: 1px solid #5a3a00;
    flex-shrink: 0;
  }
  #warn.visible { display: block; }

  /* Input area */
  #inp-area {
    border-top: 1px solid #333;
    padding: 8px 10px;
    display: flex;
    gap: 6px;
    align-items: flex-end;
    background: #252526;
    flex-shrink: 0;
  }
  #inp {
    flex: 1;
    min-height: 36px;
    max-height: 100px;
    resize: none;
    background: #3c3c3c;
    color: #ccc;
    border: 1px solid #555;
    border-radius: 4px;
    padding: 7px 9px;
    font-family: inherit;
    font-size: 13px;
    outline: none;
    line-height: 1.4;
  }
  #inp:focus { border-color: #007acc; }
  #inp:disabled { opacity: .45; }
  #send { background: #007acc; color: #fff; border: none; border-radius: 4px; padding: 0 12px; height: 36px; cursor: pointer; font-size: 12px; font-weight: 600; flex-shrink: 0; }
  #send:hover    { background: #1177bb; }
  #send:disabled { opacity: .4; cursor: default; }
`;
shadow.appendChild(styleEl);

// ── HTML ──────────────────────────────────────────────────────────────────

const ui = document.createElement('div');
ui.innerHTML = `
  <button id="btn" title="Ask Motkra (AI assistant)">🤖</button>
  <div id="drawer">
    <div id="hdr">
      <span id="hdr-name">Motkra</span>
      <span id="hdr-url"></span>
      <button id="close-btn" title="Close">✕</button>
    </div>
    <div id="ctx-bar"></div>
    <div id="msgs">
      <div id="empty">
        <div class="ico">🤖</div>
        <div>Ask Motkra about this page</div>
        <div style="opacity:.6;font-size:11px">Select text first for focused context</div>
      </div>
    </div>
    <div id="warn">⚠ Motkra Daemon not running — <code>cd motkra-daemon &amp;&amp; npm start</code></div>
    <div id="inp-area">
      <textarea id="inp" placeholder="Ask about this page…" rows="1"></textarea>
      <button id="send">Send</button>
    </div>
  </div>`;
shadow.appendChild(ui);

// ── Element refs ──────────────────────────────────────────────────────────

const btn      = shadow.getElementById('btn');
const drawer   = shadow.getElementById('drawer');
const closeBtn = shadow.getElementById('close-btn');
const msgs     = shadow.getElementById('msgs');
const empty    = shadow.getElementById('empty');
const inp      = shadow.getElementById('inp');
const sendBtn  = shadow.getElementById('send');
const ctxBar   = shadow.getElementById('ctx-bar');
const hdrUrl   = shadow.getElementById('hdr-url');
const warn     = shadow.getElementById('warn');

let history    = [];
let busy       = false;
let activePort = null;

// ── Drawer toggle ─────────────────────────────────────────────────────────

function open() {
  if (drawer.classList.contains('open')) return;
  hdrUrl.textContent = location.hostname + location.pathname.slice(0, 28);
  refreshCtxBar();
  drawer.classList.add('open');
  btn.classList.add('active');
  checkDaemon();
  inp.focus();
}

function close() {
  drawer.classList.remove('open');
  btn.classList.remove('active');
}

btn.addEventListener('click', () => drawer.classList.contains('open') ? close() : open());
closeBtn.addEventListener('click', close);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && drawer.classList.contains('open')) close();
});

// ── Page context extraction ───────────────────────────────────────────────

function extractContext() {
  const selected = window.getSelection()?.toString()?.trim() ?? '';
  if (location.hostname === 'github.com') return extractGitHub(selected);
  return extractGeneric(selected);
}

function extractGeneric(selected) {
  const selectors = ['main', 'article', '[role="main"]', '#content', '.content', '.post'];
  let el = null;
  for (const s of selectors) { el = document.querySelector(s); if (el) break; }
  const text = (el || document.body).innerText
    .replace(/[ \t]{3,}/g, '  ')
    .replace(/\n{4,}/g, '\n\n')
    .trim()
    .slice(0, 4000);
  return { title: document.title, url: location.href, selected, text, type: 'page' };
}

function extractGitHub(selected) {
  const isPR      = location.pathname.includes('/pull/');
  const isIssue   = location.pathname.includes('/issues/');
  const titleEl   = document.querySelector('.js-issue-title');
  const bodyEl    = document.querySelector('.comment-body, .js-comment-body');

  // First 5 comment bodies
  const commentEls = [...document.querySelectorAll(
    '.timeline-comment .comment-body, .js-comment-body'
  )].slice(0, 5);
  const comments = commentEls.map(e => e.innerText.trim().slice(0, 400)).join('\n---\n');

  // Diff summary for PRs
  let diffSummary = '';
  if (isPR) {
    const files = [...document.querySelectorAll('.file-info .link-gray')].slice(0, 8);
    if (files.length) diffSummary = `\nFiles changed: ${files.map(f => f.textContent.trim()).join(', ')}`;
  }

  const type = isPR ? 'github-pr' : isIssue ? 'github-issue' : 'github';
  const text = [
    isPR ? '## Pull Request' : isIssue ? '## Issue' : '## GitHub',
    titleEl?.innerText?.trim() ?? document.title,
    bodyEl?.innerText?.trim()  ?? '',
    comments ? `\n## Comments\n${comments}` : '',
    diffSummary,
  ].filter(Boolean).join('\n\n').slice(0, 4000);

  return { title: document.title, url: location.href, selected, text, type };
}

function refreshCtxBar() {
  const { selected, type, title } = extractContext();
  if (selected) {
    ctxBar.textContent = `✂ "${selected.slice(0, 80)}${selected.length > 80 ? '…' : ''}"`;
    ctxBar.classList.add('visible');
  } else if (type === 'github-pr') {
    ctxBar.textContent = `⎇ PR: ${title.slice(0, 55)}`;
    ctxBar.classList.add('visible');
  } else if (type === 'github-issue') {
    ctxBar.textContent = `🐛 Issue: ${title.slice(0, 55)}`;
    ctxBar.classList.add('visible');
  } else {
    ctxBar.classList.remove('visible');
  }
}

// Update context chip when selection changes
document.addEventListener('selectionchange', () => {
  if (drawer.classList.contains('open')) refreshCtxBar();
});

// ── Daemon check ──────────────────────────────────────────────────────────

function checkDaemon() {
  chrome.runtime.sendMessage({ type: 'check-daemon', port: daemonPort }, res => {
    warn.classList.toggle('visible', !(res?.ok));
  });
}

// ── Markdown / bubble helpers ─────────────────────────────────────────────

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function renderMd(text) {
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g,
    (_, __, code) => `<pre><code>${esc(code.trimEnd())}</code></pre>`);
  text = text.replace(/`([^`]+)`/g, (_, c) => `<code>${esc(c)}</code>`);
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*(.+?)\*/g,     '<em>$1</em>');
  return text;
}

function addBubble(role, label) {
  empty?.remove();
  const w = document.createElement('div'); w.className = `msg ${role}`;
  const l = document.createElement('div'); l.className = 'lbl'; l.textContent = label;
  const b = document.createElement('div'); b.className = 'bubble';
  w.appendChild(l); w.appendChild(b); msgs.appendChild(w);
  msgs.scrollTop = msgs.scrollHeight;
  return b;
}

// ── Send ──────────────────────────────────────────────────────────────────

function send() {
  const text = inp.value.trim();
  if (!text || busy) return;

  busy = true;
  sendBtn.disabled = true;

  const ctx = extractContext();
  const contextBlock = [
    ctx.selected ? `Selected text:\n"${ctx.selected}"` : null,
    ctx.text     ? `Page content:\n${ctx.text}`        : null,
  ].filter(Boolean).join('\n\n');

  const ub  = addBubble('user', 'You');
  ub.innerHTML = renderMd(text);
  inp.value    = '';
  inp.style.height = 'auto';

  history.push({ role: 'user', content: text });

  const ab  = addBubble('assistant', '☁ Claude');
  ab._raw   = '';
  ab.innerHTML = '<span class="cursor"></span>';
  msgs.scrollTop = msgs.scrollHeight;

  // Connect a persistent port to the background service worker
  activePort = chrome.runtime.connect({ name: 'motkra-query' });

  activePort.onMessage.addListener(msg => {
    if (msg.type === 'token') {
      ab._raw += msg.text;
      ab.innerHTML = renderMd(ab._raw) + '<span class="cursor"></span>';
      msgs.scrollTop = msgs.scrollHeight;

    } else if (msg.type === 'done') {
      ab.innerHTML = renderMd(ab._raw);
      history.push({ role: 'assistant', content: ab._raw });
      ab._raw = '';
      finalize();

    } else if (msg.type === 'error') {
      ab.parentNode?.remove();
      const eb = addBubble('error', 'Error');
      eb.textContent = msg.text;
      history.pop();
      finalize();
    }
  });

  activePort.onDisconnect.addListener(() => {
    if (busy) {
      ab.innerHTML = renderMd(ab._raw || '(connection lost)');
      if (ab._raw) history.push({ role: 'assistant', content: ab._raw });
      finalize();
    }
  });

  activePort.postMessage({ type: 'query', text, context: contextBlock, history: history.slice(0, -1) });
}

function finalize() {
  busy = false;
  sendBtn.disabled = false;
  activePort?.disconnect();
  activePort = null;
  inp.focus();
  msgs.scrollTop = msgs.scrollHeight;
}

inp.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
sendBtn.addEventListener('click', send);
inp.addEventListener('input', () => {
  inp.style.height = 'auto';
  inp.style.height = Math.min(inp.scrollHeight, 100) + 'px';
});

})();
