'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Expose a minimal safe API to the renderer (chat.html)
contextBridge.exposeInMainWorld('motkra', {
  /**
   * Start a streaming Claude query.
   * Tokens arrive via the 'token' event before this resolves.
   * @param {string} text
   * @param {Array}  history  [{role, content}]
   * @returns {Promise<void>}
   */
  queryStream: (text, history) =>
    ipcRenderer.invoke('query-stream', { text, history }),

  /**
   * Register a callback that fires for each streamed token.
   * Call once at startup.
   * @param {(token:string) => void} cb
   */
  onToken: cb => ipcRenderer.on('token', (_ev, token) => cb(token)),

  /** Hide (not close) the floating window. */
  hideWindow: () => ipcRenderer.send('hide-window'),

  /** Open VS Code in the shell. */
  openVSCode: () => ipcRenderer.send('open-vscode'),

  /** Check whether an API key is configured. */
  getConfig: () => ipcRenderer.invoke('get-config'),
});
