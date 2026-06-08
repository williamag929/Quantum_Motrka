'use strict';

const {
  app, BrowserWindow, globalShortcut, ipcMain, shell
} = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

// ── Load API key from first found .env ────────────────────────────────────

const ENV_CANDIDATES = [
  path.join(os.homedir(), '.motkra', '.env'),                       // per-user
  path.join(__dirname, '..', 'dual_ai', '.env'),                    // monorepo dev
  path.join(process.env.APPDATA ?? os.homedir(), 'Motkra', '.env') // Windows AppData
];
for (const loc of ENV_CANDIDATES) {
  if (fs.existsSync(loc)) { require('dotenv').config({ path: loc }); break; }
}

const tray  = require('./tray');
const ipc   = require('./ipc');

// ── Single instance lock ──────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.setName('Motkra');

// ── Floating chat window ──────────────────────────────────────────────────

let chatWin = null;

function createChatWindow() {
  if (chatWin && !chatWin.isDestroyed()) {
    if (!chatWin.isVisible()) chatWin.show();
    chatWin.focus();
    return;
  }

  chatWin = new BrowserWindow({
    width:           460,
    height:          520,
    frame:           false,
    alwaysOnTop:     true,
    skipTaskbar:     true,
    resizable:       true,
    movable:         true,
    show:            false,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    }
  });

  chatWin.loadFile(path.join(__dirname, 'chat.html'));

  // Auto-hide on blur (user clicks away)
  chatWin.on('blur', () => {
    if (chatWin && !chatWin.isDestroyed() && chatWin.isVisible()) {
      chatWin.hide();
    }
  });

  chatWin.once('ready-to-show', () => {
    positionNearCursor();
    chatWin.show();
    chatWin.focus();
  });
}

function positionNearCursor() {
  if (!chatWin || chatWin.isDestroyed()) return;
  const { screen } = require('electron');
  const { x, y }   = screen.getCursorScreenPoint();
  const display     = screen.getDisplayNearestPoint({ x, y });
  const { width: sw, height: sh } = display.workArea;
  const [ww, wh]    = chatWin.getSize();
  // Position above and to the left of cursor, clamped to screen
  const wx = Math.min(Math.max(x - ww / 2, display.workArea.x), display.workArea.x + sw - ww);
  const wy = Math.min(Math.max(y - wh - 10, display.workArea.y), display.workArea.y + sh - wh);
  chatWin.setPosition(Math.round(wx), Math.round(wy));
}

function toggleChatWindow() {
  if (chatWin && !chatWin.isDestroyed() && chatWin.isVisible()) {
    chatWin.hide();
  } else {
    createChatWindow();
  }
}

// ── IPC from renderer ─────────────────────────────────────────────────────

ipcMain.handle('query-stream', async (event, { text, history }) => {
  return ipc.handleQueryStream(text, history, token => {
    if (!event.sender.isDestroyed()) event.sender.send('token', token);
  });
});

ipcMain.on('hide-window', () => {
  if (chatWin && !chatWin.isDestroyed()) chatWin.hide();
});

ipcMain.on('open-vscode', () => {
  shell.openExternal('vscode://');
});

ipcMain.handle('get-config', () => ({
  hasApiKey: !!process.env.ANTHROPIC_API_KEY,
}));

// ── App lifecycle ─────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Tray-only app: hide dock on macOS
  if (process.platform === 'darwin') app.dock?.hide();

  // HTTP server for browser extension + VS Code extension IPC
  const port = parseInt(process.env.MOTKRA_DAEMON_PORT ?? '7432', 10);
  ipc.startServer(port);

  // System tray icon and context menu
  tray.createTray({
    onOpenChat:   createChatWindow,
    onOpenVSCode: () => shell.openExternal('vscode://'),
    onQuit:       () => app.quit(),
  });

  // Global hotkey — Ctrl+Shift+Space (configurable via env var)
  const hotkey = process.env.MOTKRA_HOTKEY ?? 'CommandOrControl+Shift+Space';
  const registered = globalShortcut.register(hotkey, toggleChatWindow);
  if (!registered) {
    console.warn(`[Motkra] Could not register hotkey: ${hotkey}`);
  } else {
    console.log(`[Motkra] Hotkey registered: ${hotkey}`);
  }
});

app.on('second-instance', () => {
  // A second launch attempt — just show the chat window
  createChatWindow();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  ipc.stopServer();
});

// Keep running even if all windows are closed (tray app behaviour)
app.on('window-all-closed', e => e.preventDefault());
