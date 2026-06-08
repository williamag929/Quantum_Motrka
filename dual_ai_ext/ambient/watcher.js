'use strict';

const vscode = require('vscode');
const path   = require('path');

const CRASH_PATTERNS = [
  /\bError:\s/,
  /Traceback \(most recent call last\)/,
  /\sFAILED\b/,
  /\bENOENT\b/,
  /Segmentation fault/i,
  /\bnpm ERR!/,
  /\bSyntaxError:/,
  /\bTypeError:/,
  /\bReferenceError:/,
  /\bModuleNotFoundError:/,
  /\bAssertionError:/,
];

/**
 * Activate all ambient watchers (error detection, terminal monitor, stuck detection).
 * Returns an array of Disposables to push into context.subscriptions.
 *
 * @param {{ suggestProactive(msg: string, autoFill: string): void }} provider
 * @returns {vscode.Disposable[]}
 */
function activate(provider) {
  const subs = [];

  // ── 2A: Proactive error detection on save ────────────────────────────
  const cooldowns = new Map(); // filePath → last-suggested timestamp

  subs.push(vscode.workspace.onDidSaveTextDocument(doc => {
    const cfg = vscode.workspace.getConfiguration('motkra');
    if (!cfg.get('proactiveErrors', true)) return;

    const now  = Date.now();
    const last = cooldowns.get(doc.uri.fsPath) ?? 0;
    if (now - last < 60_000) return; // 60 s cooldown per file

    const errors = vscode.languages
      .getDiagnostics(doc.uri)
      .filter(d => d.severity === vscode.DiagnosticSeverity.Error);

    if (errors.length === 0) return;
    cooldowns.set(doc.uri.fsPath, now);

    const filename = path.basename(doc.uri.fsPath);
    const errList  = errors.slice(0, 3)
      .map(e => `Line ${e.range.start.line + 1}: ${e.message}`)
      .join('\n');

    provider.suggestProactive(
      `I noticed ${errors.length} error${errors.length > 1 ? 's' : ''} in \`${filename}\`:\n${errList}`,
      `Fix the error${errors.length > 1 ? 's' : ''} in ${filename} using str_replace or write_file as needed.`
    );
  }));

  // ── 2B: Terminal crash monitor ───────────────────────────────────────
  let termBuffer  = '';
  let termTimer   = null;
  let lastCrashAt = 0;

  subs.push(vscode.window.onDidWriteTerminalData(e => {
    const cfg = vscode.workspace.getConfiguration('motkra');
    if (!cfg.get('proactiveTerminal', true)) return;

    termBuffer += e.data;
    clearTimeout(termTimer);
    termTimer = setTimeout(() => {
      const snapshot = termBuffer.slice(-1200);
      termBuffer     = '';

      const now = Date.now();
      if (now - lastCrashAt < 10_000) return; // 10 s cooldown
      if (!CRASH_PATTERNS.some(p => p.test(snapshot))) return;

      lastCrashAt = now;
      const clean = snapshot.replace(/\x1b\[[0-9;]*m/g, '').trim(); // strip ANSI
      provider.suggestProactive(
        'I caught an error in your terminal.',
        `Diagnose and fix this terminal error:\n\`\`\`\n${clean}\n\`\`\``
      );
    }, 600);
  }));

  // ── 2C: Stuck detection ──────────────────────────────────────────────
  const editLog = new Map(); // "filePath:bucket" → { count, firstAt, lastLine }

  subs.push(vscode.workspace.onDidChangeTextDocument(e => {
    const cfg = vscode.workspace.getConfiguration('motkra');
    if (!cfg.get('stuckDetection', true)) return;
    if (e.contentChanges.length === 0) return;

    const fp     = e.document.uri.fsPath;
    const ln     = e.contentChanges[0].range.start.line;
    const bucket = Math.floor(ln / 15); // 15-line regions
    const key    = `${fp}:${bucket}`;
    const now    = Date.now();
    const rec    = editLog.get(key) ?? { count: 0, firstAt: now, lastLine: ln };

    // Reset if the region hasn't been touched in >20 min
    if (now - rec.firstAt > 20 * 60_000) {
      editLog.set(key, { count: 1, firstAt: now, lastLine: ln });
      return;
    }

    rec.count++;
    rec.lastLine = ln;
    editLog.set(key, rec);

    if (rec.count === 8) {
      const filename = path.basename(fp);
      provider.suggestProactive(
        `You've been editing the same section of \`${filename}\` for a while. Want a second pair of eyes?`,
        `Review the code around line ${ln + 1} in ${filename} and suggest fixes or improvements.`
      );
    }
  }));

  return subs;
}

module.exports = { activate };
