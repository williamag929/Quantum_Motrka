'use strict';

// Consent grants for agent tools that are not folder-based (console commands, websites).
// Same scopes as the folder grants in fs-tools.js: once | session | always | deny.

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const SCOPES = ['once', 'session', 'always', 'deny'];

function motkraDir() {
  return process.env.MOTKRA_DIR ?? path.join(os.homedir(), '.motkra');
}

/**
 * @param {string} file          JSON file name inside ~/.motkra for "always" grants
 * @param {string} auditFile     JSONL audit log name inside ~/.motkra
 * @param {(grant:object, request:object) => boolean} matches  does a stored grant cover the request?
 */
function createStore(file, auditFile, matches) {
  const session = [];
  let always = null;

  const filePath  = () => path.join(motkraDir(), file);
  const auditPath = () => path.join(motkraDir(), auditFile);

  function load() {
    if (always) return always;
    try { always = JSON.parse(fs.readFileSync(filePath(), 'utf8')).filter(g => g && typeof g === 'object'); }
    catch { always = []; }
    return always;
  }

  function save() {
    fs.mkdirSync(motkraDir(), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(load(), null, 2));
  }

  return {
    isGranted(request) {
      return [...session, ...load()].some(g => matches(g, request));
    },

    add(grant, scope) {
      const entry = { ...grant, granted_at: new Date().toISOString() };
      if (scope === 'session') session.push(entry);
      if (scope === 'always') { load().push(entry); save(); }
    },

    list() {
      return [...load().map(g => ({ ...g, scope: 'always' })), ...session.map(g => ({ ...g, scope: 'session' }))];
    },

    revokeAll() {
      session.length = 0;
      always = [];
      save();
    },

    audit(entry) {
      try {
        fs.mkdirSync(motkraDir(), { recursive: true });
        fs.appendFileSync(auditPath(), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
      } catch { /* auditing must never break the agent */ }
    },
  };
}

module.exports = { SCOPES, createStore };
