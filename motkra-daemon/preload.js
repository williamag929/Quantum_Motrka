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
  queryStream: (text, history, model = 'auto') =>
    ipcRenderer.invoke('query-stream', { text, history, model }),

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

  /**
   * Fires once per query with the model name chosen by the router.
   * @param {(model:'claude'|'gemma') => void} cb
   */
  onModelSelected: cb => ipcRenderer.on('model-selected', (_ev, model) => cb(model)),

  /** Start local Windows STT (spawns stt-win.ps1). */
  sttStart: () => ipcRenderer.invoke('stt-start'),

  /** Stop local Windows STT (kills the PS process). */
  sttStop: () => ipcRenderer.invoke('stt-stop'),

  /**
   * Register a callback that fires for each recognized transcript line.
   * Call once at startup.
   * @param {(text:string) => void} cb
   */
  onTranscript: cb => ipcRenderer.on('stt-transcript', (_ev, text) => cb(text)),
});
