'use strict';

const statusDot    = document.getElementById('status-dot');
const statusText   = document.getElementById('status-text');
const checkBtn     = document.getElementById('check-btn');
const portInp      = document.getElementById('port-inp');
const saveBtn      = document.getElementById('save-btn');
const quickInp     = document.getElementById('quick-inp');
const quickSend    = document.getElementById('quick-send');
const quickOut     = document.getElementById('quick-out');
const daemonPortEl = document.getElementById('daemon-port-show');

let daemonPort = 7432;

// ── Load saved port ───────────────────────────────────────────────────────

chrome.storage.local.get('motkra_daemon_port', r => {
  daemonPort = r.motkra_daemon_port ?? 7432;
  portInp.value        = daemonPort;
  daemonPortEl.textContent = daemonPort;
  checkDaemon();
});

// ── Daemon status check ───────────────────────────────────────────────────

function checkDaemon() {
  statusDot.className  = '';
  statusText.className = '';
  statusText.textContent = 'Checking…';

  chrome.runtime.sendMessage({ type: 'check-daemon', port: daemonPort }, res => {
    if (res?.ok) {
      statusDot.className  = 'ok';
      statusText.className = 'ok';
      statusText.textContent = `Connected — Motkra Daemon v${res.version ?? '?'} on port ${daemonPort}`;
    } else {
      statusDot.className  = 'err';
      statusText.className = 'err';
      statusText.textContent = `Not running — start with: cd motkra-daemon && npm start`;
    }
  });
}

checkBtn.addEventListener('click', checkDaemon);

// ── Save port setting ─────────────────────────────────────────────────────

saveBtn.addEventListener('click', () => {
  const p = parseInt(portInp.value, 10);
  if (!p || p < 1024 || p > 65535) return;
  daemonPort = p;
  daemonPortEl.textContent = p;
  chrome.storage.local.set({ motkra_daemon_port: p }, checkDaemon);
  saveBtn.textContent = '✓';
  setTimeout(() => { saveBtn.textContent = 'Save'; }, 1500);
});

portInp.addEventListener('keydown', e => {
  if (e.key === 'Enter') saveBtn.click();
});

// ── Quick ask (non-streaming for simplicity in popup) ────────────────────

async function quickAsk() {
  const text = quickInp.value.trim();
  if (!text) return;

  quickSend.disabled = true;
  quickOut.textContent = '';
  quickOut.classList.add('visible');
  quickOut.textContent = '…';

  try {
    const res = await fetch(`http://127.0.0.1:${daemonPort}/query`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text, history: [], stream: false }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { result } = await res.json();
    quickOut.textContent = result;
  } catch (err) {
    quickOut.textContent = `Error: ${err.message}`;
  }

  quickSend.disabled = false;
}

quickSend.addEventListener('click', quickAsk);
quickInp.addEventListener('keydown', e => {
  if (e.key === 'Enter') quickAsk();
});
