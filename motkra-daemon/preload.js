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

  /**
   * Fires once per query with the privacy brain's decision.
   * @param {(info:{target:string, reason:string, private:boolean, redacted:boolean}) => void} cb
   */
  onRouteInfo: cb => ipcRenderer.on('route-info', (_ev, info) => cb(info)),

  /** Start local speech-to-text (Whisper; Windows speech recognition as fallback). */
  sttStart: () => ipcRenderer.invoke('stt-start'),

  /** Stop local speech-to-text. */
  sttStop: () => ipcRenderer.invoke('stt-stop'),

  /**
   * Speak text with the local Piper voice.
   * @returns {Promise<boolean>} false when Piper is not available (use speechSynthesis)
   */
  ttsSpeak: text => ipcRenderer.invoke('tts-speak', text),

  /** Stop the local voice. */
  ttsStop: () => ipcRenderer.invoke('tts-stop'),

  /**
   * Register a callback that fires for each recognized transcript line.
   * Call once at startup.
   * @param {(text:string) => void} cb
   */
  onTranscript: cb => ipcRenderer.on('stt-transcript', (_ev, text) => cb(text)),

  /** Agent file-tool progress lines ("📂 Listing D:\\..."). */
  onToolActivity: cb => ipcRenderer.on('tool-activity', (_ev, line) => cb(line)),

  /** The agent wants to use a folder: cb({id, op, folder, target}); answer with respondPermission. */
  onPermissionRequest: cb => ipcRenderer.on('fs-permission-request', (_ev, req) => cb(req)),

  /** @param {'once'|'session'|'always'|'deny'} scope */
  respondPermission: (id, scope) => ipcRenderer.send('fs-permission-response', { id, scope }),

  /** Folders the agent may use: [{op, folder, scope, granted_at}] */
  listGrants: () => ipcRenderer.invoke('fs-grants'),

  /** Forget every folder permission (session and always). */
  revokeAllGrants: () => ipcRenderer.invoke('fs-revoke-all'),

  copyText: text => ipcRenderer.invoke('copy-text', text),

  /** Record 👍/👎 for an answer locally in ~/.motkra/feedback.jsonl. rating: 'up' | 'down' | null */
  sendFeedback: entry => ipcRenderer.invoke('feedback', entry),
});
