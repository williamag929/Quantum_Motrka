'use strict';

/**
 * Email monitor — polls Gmail, triages each email, and dispatches actions
 * according to the trust × confidence matrix.
 *
 * Trust × Confidence decision matrix:
 *   spam / ignore                    → archive silently
 *   flag (any trust)                 → urgent system-tray alert, open chat
 *   reply + trust 5 + confidence ≥ 6 → auto-send, notify user after
 *   reply + trust 4 + confidence ≥ 8 → auto-send, notify user after
 *   reply + trust 3 (any confidence) → send approval email to user, act on YES/NO reply
 *   reply + trust 2                  → desktop notification window only
 *   reply + trust 0–1                → silent queue (shown in morning briefing)
 */

const { listNew, send, archive, getMyEmail, pollApprovalReply } = require('./gmail');
const { getTrust }  = require('./contacts');
const { triage }    = require('./triage');

let _timer    = null;
let _notifyFn = null;   // (event) → void — injected by main.js
let _myEmail  = null;

// ── Decision engine ───────────────────────────────────────────────────────────

async function processEmail(email) {
  const trust  = getTrust(email.from);
  let   result;

  try {
    result = await triage(email);
  } catch (e) {
    console.error(`[email] triage error for ${email.id}:`, e.message);
    return;
  }

  const { action, confidence, draft } = result;

  // ── Spam / Ignore ──────────────────────────────────────────────────
  if (action === 'spam') {
    try { await archive(email.id); } catch (e) { console.error('[email] archive error:', e.message); }
    console.log(`[email] archived spam: "${email.subject}" from ${email.from}`);
    return;
  }

  if (action === 'ignore') {
    console.log(`[email] ignored: "${email.subject}" from ${email.from}`);
    return;
  }

  // ── Flag — always escalate regardless of trust ─────────────────────
  if (action === 'flag') {
    _notifyFn?.({ type: 'flag', email, result });
    return;
  }

  // ── Reply — trust × confidence matrix ─────────────────────────────
  if (action === 'reply') {

    // Trust 5: auto-send if confidence ≥ threshold (default 6)
    if (trust === 5 && confidence >= (parseInt(process.env.MOTKRA_EMAIL_THRESHOLD, 10) || 6)) {
      await safeSend(email, draft);
      _notifyFn?.({ type: 'sent', email, result });
      return;
    }

    // Trust 4: auto-send if confidence ≥ 8
    if (trust === 4 && confidence >= 8) {
      await safeSend(email, draft);
      _notifyFn?.({ type: 'sent', email, result });
      return;
    }

    // Trust 3: send approval email to user; act on reply
    if (trust === 3) {
      await sendApprovalEmail(email, draft, result);
      return;
    }

    // Trust 2: desktop notification only
    if (trust === 2) {
      _notifyFn?.({ type: 'notify', email, result });
      return;
    }

    // Trust 0–1: silent queue — just leave unread, daily briefing will surface it
    console.log(`[email] silently queued: "${email.subject}" from ${email.from} (trust ${trust})`);
  }
}

async function safeSend(email, draft) {
  try {
    await send(email.from, `Re: ${email.subject}`, draft, email.threadId);
    console.log(`[email] sent reply to ${email.from}`);
  } catch (e) {
    console.error('[email] send error:', e.message);
  }
}

async function sendApprovalEmail(email, draft, result) {
  if (!_myEmail) { console.warn('[email] myEmail not set, cannot send approval'); return; }

  const body =
    `📧 Incoming from: ${email.from}\n` +
    `Subject: ${email.subject}\n\n` +
    `Suggested reply:\n` +
    `────────────────────────────────\n` +
    `${draft}\n` +
    `────────────────────────────────\n\n` +
    `Confidence: ${result.confidence}/10 · ${result.reason}\n\n` +
    `Reply YES to send · NO to discard · or paste your own text to override`;

  let approvalMsg;
  try {
    approvalMsg = await send(
      _myEmail,
      `[Motkra] Approval needed — Re: ${email.subject}`,
      body,
      null
    );
  } catch (e) {
    console.error('[email] approval send error:', e.message);
    return;
  }

  // Poll for user's reply (5 min window)
  pollApprovalReply(approvalMsg.id, 300_000).then(async reply => {
    if (!reply) { console.log(`[email] approval timed out for: "${email.subject}"`); return; }

    const firstWord = reply.trim().toUpperCase().split(/\s+/)[0];
    if (firstWord === 'NO') {
      console.log(`[email] approval declined for: "${email.subject}"`);
      return;
    }
    const textToSend = firstWord === 'YES' ? draft : reply.trim();
    await safeSend({ ...email }, textToSend.startsWith('Re:')
      ? textToSend  // user pasted a full override — use as-is
      : textToSend
    );
  }).catch(e => console.error('[email] approval poll error:', e.message));
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function poll() {
  let emails;
  try { emails = await listNew(); }
  catch (e) { console.error('[email] listNew error:', e.message); return; }

  for (const email of emails) {
    await processEmail(email).catch(e =>
      console.error(`[email] processEmail error (${email.id}):`, e.message)
    );
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

async function start({ intervalSec = 120, notifyFn } = {}) {
  if (_timer) stop();
  _notifyFn = notifyFn ?? null;

  // Resolve our own address (needed for approval emails)
  try { _myEmail = await getMyEmail(); }
  catch (e) { console.error('[email] could not resolve my email:', e.message); }

  await poll();  // immediate first poll
  _timer = setInterval(poll, intervalSec * 1000);
  console.log(`[email] monitor started — polling every ${intervalSec}s as ${_myEmail ?? '?'}`);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _notifyFn = null;
  console.log('[email] monitor stopped');
}

module.exports = { start, stop };
