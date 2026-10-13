'use strict';

// Daily morning briefing (Phase 13B, essential scope).
//
// Once a day, after 8am, on the first window open, Motkra gathers a little context
// (yesterday's commits + open GitHub issues if a token is set), asks Claude to turn
// it into ≤5 bullets, and posts it to the panel as a system message. Best-effort:
// every source is optional and a failure never blocks activation.

const { execSync } = require('child_process');
const { default: Anthropic } = require('@anthropic-ai/sdk');

let vscode;
try { vscode = require('vscode'); } catch { vscode = null; }

const MODEL_DEFAULT = 'claude-opus-4-7';

/** Yesterday's commits, one line each. Empty string if not a repo or none. */
function collectCommits(root) {
  try {
    const out = execSync('git log --since=yesterday --pretty=format:%s', { cwd: root, timeout: 5000 })
      .toString().trim();
    return out;
  } catch {
    return '';
  }
}

/** Open issues assigned to nobody-specific: just the repo's recent open issues. Optional. */
async function collectIssues(token) {
  if (!token) return '';
  try {
    const github = require('./github');
    return await github.listIssues(detectRepo(), { state: 'open', per_page: 10 }, token);
  } catch {
    return '';
  }
}

/** owner/repo from the git remote, so the user doesn't configure it. */
function detectRepo(root = process.cwd()) {
  try {
    const url = execSync('git remote get-url origin', { cwd: root, timeout: 3000 }).toString().trim();
    const m = url.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i);
    if (m) return `${m[1]}/${m[2]}`;
  } catch { /* no remote */ }
  return '';
}

/** Ask Claude to compress the raw context into ≤5 plain bullets. */
async function synthesize(model, commits, issues) {
  const parts = [];
  if (commits) parts.push(`Commits since yesterday:\n${commits}`);
  if (issues) parts.push(`Open GitHub issues:\n${issues}`);
  if (!parts.length) return null;   // nothing to say — don't even build a client

  const client = new Anthropic();
  const resp = await client.messages.create({
    model,
    max_tokens: 500,
    system: 'You write a concise morning developer briefing. From the context given, output at most 5 short bullets (markdown "- ..."), no greeting, no preamble. If there is nothing meaningful, reply with exactly: NO_BRIEFING.',
    messages: [{ role: 'user', content: parts.join('\n\n') }],
  });
  const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  return (!text || text === 'NO_BRIEFING') ? null : text;
}

/**
 * Run the briefing if it's due: setting on, after 8am, and not already shown today.
 * Best-effort — never throws into activation. Returns the text shown, or null.
 *
 * @param {Object} provider  the MoktaProvider (uses _postSystemMsg)
 * @param {Object} context   VS Code extension context (globalState)
 * @param {Object} [deps]     test seams: { now, root, cfg }
 */
async function maybeRunBriefing(provider, context, deps = {}) {
  const cfg = (deps.cfg ?? (vscode ? vscode.workspace.getConfiguration('motkra') : null));
  if (!cfg?.get('dailyBriefing', false)) return null;

  const now = deps.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const last = context?.globalState?.get('motkra.lastBriefing');
  if (last === today) return null;               // already shown today
  if (now.getHours() < 8) return null;           // morning only

  const root = deps.root ?? vscode?.workspace?.workspaceFolders?.[0]?.uri?.fsPath;
  if (!root) return null;

  const model = cfg.get('claudeModel') ?? MODEL_DEFAULT;
  const token = cfg.get('githubToken') ?? '';
  let text = null;
  try {
    const [commits, issues] = await Promise.all([collectCommits(root), collectIssues(token)]);
    text = await synthesize(model, commits, issues);
  } catch (err) {
    provider?._out?.()?.appendLine?.(`[Briefing] skipped: ${err.message}`);
    return null;
  }

  context?.globalState?.update?.('motkra.lastBriefing', today);
  if (text && provider) provider._postSystemMsg(`📋 **Morning Briefing**\n${text}`);
  return text;
}

module.exports = {
  collectCommits, collectIssues, detectRepo, synthesize, maybeRunBriefing,
};
