'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const MEMORY_DIR  = path.join(os.homedir(), '.motkra');
const MEMORY_FILE = path.join(MEMORY_DIR, 'memory.json');
const MAX_FACTS   = 200; // per workspace

// ── Storage ───────────────────────────────────────────────────────────────────

function _load() {
  try {
    if (!fs.existsSync(MEMORY_FILE)) return _empty();
    return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
  } catch { return _empty(); }
}

function _empty() {
  return { facts: [], projectContexts: {} };
}

function _save(data) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Store a fact for a workspace.
 * @returns {{ id, workspace, content, createdAt }}
 */
function remember(workspace, content) {
  const data = _load();
  const fact = {
    id:        `f${Date.now()}${Math.random().toString(36).slice(2, 5)}`,
    workspace,
    content:   content.trim().slice(0, 500),
    createdAt: new Date().toISOString(),
  };
  data.facts.push(fact);

  // Trim to max per workspace (remove oldest)
  const ws = data.facts.filter(f => f.workspace === workspace);
  if (ws.length > MAX_FACTS) {
    const keep = new Set(ws.slice(-MAX_FACTS).map(f => f.id));
    data.facts = data.facts.filter(f => f.workspace !== workspace || keep.has(f.id));
  }

  _save(data);
  return fact;
}

/**
 * Retrieve the most recent facts for a workspace, optionally filtered by query.
 * @returns {Array}
 */
function recall(workspace, query = '') {
  const facts = _load().facts.filter(f => f.workspace === workspace);
  if (!query) return facts.slice(-10);
  const lower = query.toLowerCase();
  return facts
    .filter(f => f.content.toLowerCase().includes(lower))
    .slice(-10);
}

/** Delete a fact by ID. */
function forget(id) {
  const data = _load();
  data.facts = data.facts.filter(f => f.id !== id);
  _save(data);
}

/** Delete ALL facts for a workspace. */
function forgetAll(workspace) {
  const data = _load();
  data.facts = data.facts.filter(f => f.workspace !== workspace);
  _save(data);
}

/** Total stored facts for a workspace. */
function countFacts(workspace) {
  return _load().facts.filter(f => f.workspace === workspace).length;
}

/** Get project-level summary string. */
function getProjectContext(workspace) {
  return _load().projectContexts[workspace] ?? '';
}

/** Set project-level summary string (from session summarisation). */
function setProjectContext(workspace, summary) {
  const data = _load();
  data.projectContexts[workspace] = summary.slice(0, 1000);
  _save(data);
}

/**
 * Build a memory string to inject into the system prompt (≤2000 chars).
 */
function buildMemoryContext(workspace) {
  const facts   = recall(workspace);
  const context = getProjectContext(workspace);
  if (!facts.length && !context) return '';

  const lines = [];
  if (context) lines.push(`Project context: ${context}`);
  if (facts.length) {
    lines.push('What I remember about this workspace:');
    facts.forEach(f => lines.push(`• ${f.content}`));
  }

  return lines.join('\n').slice(0, 2000);
}

module.exports = {
  remember,
  recall,
  forget,
  forgetAll,
  countFacts,
  getProjectContext,
  setProjectContext,
  buildMemoryContext,
};
