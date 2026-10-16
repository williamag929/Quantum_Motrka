'use strict';

/**
 * Subscribe to terminal output without breaking activation.
 *
 * `onDidWriteTerminalData` is a *proposed* API: VS Code throws on access when the extension is
 * installed (not in development mode), and that exception used to stop the whole extension from
 * activating. The stable route (VS Code 1.93+, shell integration) is preferred; the proposed API
 * is a best-effort fallback; with neither, the terminal monitor is simply off.
 *
 * @param {object} win  `vscode.window` (injected so this can be tested)
 * @param {(text: string) => void} onText  called with each chunk of output
 * @returns {{dispose(): void} | null}  null when no terminal API is available
 */
function subscribeTerminalOutput(win, onText) {
  if (typeof win.onDidStartTerminalShellExecution === 'function') {
    return win.onDidStartTerminalShellExecution(event => {
      (async () => {
        for await (const chunk of event.execution.read()) onText(chunk);
      })().catch(() => { /* the terminal closed mid-command: nothing to report */ });
    });
  }
  try {
    if (typeof win.onDidWriteTerminalData === 'function') {
      return win.onDidWriteTerminalData(e => onText(e.data));
    }
  } catch { /* proposed API not enabled for this extension */ }
  return null;
}

module.exports = { subscribeTerminalOutput };
