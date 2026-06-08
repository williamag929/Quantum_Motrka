'use strict';

/**
 * Gmail OAuth2 client for the Motkra email agent.
 *
 * First-time setup:
 *   1. Create a Google Cloud project and enable the Gmail API.
 *   2. Create OAuth2 credentials (Desktop app type), download the JSON, and save
 *      it to ~/.motkra/gmail-credentials.json.
 *   3. Call ensureAuth() — a browser window opens for consent and tokens are
 *      saved to ~/.motkra/gmail-tokens.json automatically.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const http = require('http');

const MOTKRA_DIR       = path.join(os.homedir(), '.motkra');
const STATE_FILE       = path.join(MOTKRA_DIR, 'email-state.json');
const TOKENS_FILE      = path.join(MOTKRA_DIR, 'gmail-tokens.json');
const CREDENTIALS_FILE = path.join(MOTKRA_DIR, 'gmail-credentials.json');
const REDIRECT_PORT    = 3456;
const REDIRECT_URI     = `http://localhost:${REDIRECT_PORT}/oauth2callback`;
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.labels',
];

// ── State helpers ─────────────────────────────────────────────────────────────

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { seenIds: [] }; }
}

function saveState(state) {
  fs.mkdirSync(MOTKRA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── OAuth2 ────────────────────────────────────────────────────────────────────

function getOAuth2Client() {
  let google;
  try { google = require('googleapis').google; }
  catch { throw new Error('googleapis not installed. Run: cd motkra-daemon && npm install googleapis'); }

  if (!fs.existsSync(CREDENTIALS_FILE)) {
    throw new Error(
      `Gmail credentials not found at ${CREDENTIALS_FILE}.\n` +
      'Steps: Google Cloud Console → APIs & Services → Credentials →\n' +
      'Create OAuth 2.0 Client ID (Desktop) → Download JSON → save to that path.'
    );
  }

  const creds = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
  const { client_id, client_secret } = creds.installed ?? creds.web ?? creds;
  return { google, oauth2: new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI) };
}

async function ensureAuth() {
  const { google, oauth2 } = getOAuth2Client();

  if (fs.existsSync(TOKENS_FILE)) {
    const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    oauth2.setCredentials(tokens);
    // Refresh if expiring within the next minute
    if (tokens.expiry_date && tokens.expiry_date < Date.now() + 60_000) {
      const { credentials } = await oauth2.refreshAccessToken();
      fs.mkdirSync(MOTKRA_DIR, { recursive: true });
      fs.writeFileSync(TOKENS_FILE, JSON.stringify(credentials, null, 2));
      oauth2.setCredentials(credentials);
    }
    return { google, oauth2 };
  }

  // First-time: open browser for OAuth consent
  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    scope:       SCOPES,
    prompt:      'consent',
  });

  try {
    const { shell } = require('electron');
    shell.openExternal(authUrl);
  } catch {
    console.log('[email] Open this URL to authorize Gmail:\n' + authUrl);
  }

  // Capture redirect with a local HTTP server
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url  = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      const code = url.searchParams.get('code');
      res.end('<html><body style="font-family:sans-serif;padding:40px"><h2>Motkra: Gmail authorized ✓</h2><p>You can close this tab.</p></body></html>');
      server.close();
      if (code) resolve(code);
      else reject(new Error('No authorization code in OAuth redirect'));
    });
    server.listen(REDIRECT_PORT, 'localhost');
    server.on('error', reject);
    setTimeout(() => { server.close(); reject(new Error('OAuth timeout (2 min)')); }, 120_000);
  });

  const { tokens } = await oauth2.getToken(code);
  fs.mkdirSync(MOTKRA_DIR, { recursive: true });
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
  oauth2.setCredentials(tokens);
  console.log('[email] Gmail authorized and tokens saved.');
  return { google, oauth2 };
}

// ── Message helpers ───────────────────────────────────────────────────────────

function headerValue(headers, name) {
  return headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function decodeBody(payload) {
  if (!payload) return '';
  const findPart = (parts, mime) => {
    for (const p of parts ?? []) {
      if (p.mimeType === mime && p.body?.data) return p;
      const nested = findPart(p.parts, mime);
      if (nested) return nested;
    }
    return null;
  };

  const plain = findPart(payload.parts, 'text/plain');
  if (plain) return Buffer.from(plain.body.data, 'base64').toString('utf8');

  const html = findPart(payload.parts, 'text/html');
  if (html) {
    return Buffer.from(html.body.data, 'base64')
      .toString('utf8')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  if (payload.body?.data) return Buffer.from(payload.body.data, 'base64').toString('utf8');
  return '';
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns new unread INBOX messages since last poll.
 * [{id, threadId, from, subject, body, date}]
 */
async function listNew() {
  const { google, oauth2 } = await ensureAuth();
  const gmail  = google.gmail({ version: 'v1', auth: oauth2 });
  const state  = loadState();

  const list   = await gmail.users.messages.list({
    userId:     'me',
    q:          'is:unread in:INBOX',
    maxResults: 25,
  });

  const msgs   = (list.data.messages ?? []).filter(m => !state.seenIds.includes(m.id));
  const result = [];

  for (const { id } of msgs) {
    const msg     = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    const headers = msg.data.payload?.headers ?? [];
    result.push({
      id,
      threadId: msg.data.threadId,
      from:     headerValue(headers, 'From'),
      subject:  headerValue(headers, 'Subject'),
      date:     headerValue(headers, 'Date'),
      body:     decodeBody(msg.data.payload).slice(0, 2000),
    });
    state.seenIds.push(id);
  }

  // Cap seen list to last 500 IDs
  if (state.seenIds.length > 500) state.seenIds = state.seenIds.slice(-500);
  saveState(state);
  return result;
}

/**
 * Send a reply on the given thread (or a new email if threadId is null).
 * Returns {id} of the sent message.
 */
async function send(to, subject, body, threadId) {
  const { google, oauth2 } = await ensureAuth();
  const gmail = google.gmail({ version: 'v1', auth: oauth2 });

  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
  ).toString('base64url');

  const resp = await gmail.users.messages.send({
    userId:   'me',
    resource: { raw, ...(threadId ? { threadId } : {}) },
  });
  return { id: resp.data.id, threadId: resp.data.threadId };
}

/** Remove a message from INBOX (archive it). */
async function archive(messageId) {
  const { google, oauth2 } = await ensureAuth();
  const gmail = google.gmail({ version: 'v1', auth: oauth2 });
  await gmail.users.messages.modify({
    userId:   'me',
    id:       messageId,
    resource: { removeLabelIds: ['INBOX'] },
  });
}

/** Return the authenticated user's email address. */
async function getMyEmail() {
  const { google, oauth2 } = await ensureAuth();
  const gmail   = google.gmail({ version: 'v1', auth: oauth2 });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  return profile.data.emailAddress;
}

/**
 * Poll a thread for a reply to our approval email.
 * Resolves with the reply body text, or null on timeout.
 * @param {string} approvalMsgId  ID of the approval email we sent to ourselves
 * @param {number} timeoutMs
 */
async function pollApprovalReply(approvalMsgId, timeoutMs = 300_000) {
  const { google, oauth2 } = await ensureAuth();
  const gmail    = google.gmail({ version: 'v1', auth: oauth2 });
  const msg      = await gmail.users.messages.get({ userId: 'me', id: approvalMsgId, format: 'minimal' });
  const threadId = msg.data.threadId;
  const myEmail  = await getMyEmail();
  const deadline = Date.now() + timeoutMs;

  return new Promise(resolve => {
    const iv = setInterval(async () => {
      if (Date.now() > deadline) { clearInterval(iv); resolve(null); return; }
      try {
        const thread = await gmail.users.threads.get({ userId: 'me', id: threadId });
        for (const m of thread.data.messages ?? []) {
          if (m.id === approvalMsgId) continue;
          const headers = m.payload?.headers ?? [];
          const from    = headerValue(headers, 'From');
          if (!from.includes(myEmail)) continue;
          // Exclude the original approval email we sent
          const body = decodeBody(m.payload).trim();
          if (body) { clearInterval(iv); resolve(body); return; }
        }
      } catch { /* retry next tick */ }
    }, 15_000);
  });
}

module.exports = { listNew, send, archive, getMyEmail, pollApprovalReply, ensureAuth };
