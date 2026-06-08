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

const tray    = require('./tray');
const ipc     = require('./ipc');
const monitor = require('./email/monitor');

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

// ── Email notification window IPC (Phase 17) ──────────────────────────────────

let notifyWin = null;

function createNotifyWindow(email, result) {
  if (notifyWin && !notifyWin.isDestroyed()) {
    notifyWin.webContents.send('email-notify', { email, result });
    if (!notifyWin.isVisible()) notifyWin.show();
    notifyWin.focus();
    return;
  }

  notifyWin = new BrowserWindow({
    width:          420,
    height:         420,
    frame:          false,
    alwaysOnTop:    true,
    skipTaskbar:    true,
    resizable:      false,
    show:           false,
    webPreferences: {
      nodeIntegration:  true,
      contextIsolation: false,
    },
  });

  notifyWin.loadFile(path.join(__dirname, 'email', 'notify-window.html'));

  notifyWin.once('ready-to-show', () => {
    // Position bottom-right corner
    const { screen } = require('electron');
    const { width: sw, height: sh } = screen.getPrimaryDisplay().workArea;
    const [ww, wh] = notifyWin.getSize();
    notifyWin.setPosition(sw - ww - 16, sh - wh - 16);
    notifyWin.show();
    notifyWin.focus();
    notifyWin.webContents.send('email-notify', { email, result });
  });

  notifyWin.on('closed', () => { notifyWin = null; });
}

ipcMain.on('email-action', async (_ev, { type, email, draft }) => {
  if (type === 'send' && email && draft) {
    try {
      const { send } = require('./email/gmail');
      await send(email.from, `Re: ${email.subject}`, draft, email.threadId);
      console.log('[email] sent from notification window to', email.from);
    } catch (e) {
      console.error('[email] send error:', e.message);
    }
  }
  // ignore / flag — no further action needed from this side
});

// ── App lifecycle ─────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Tray-only app: hide dock on macOS
  if (process.platform === 'darwin') app.dock?.hide();

  // HTTP server for browser extension + VS Code extension IPC
  const port = parseInt(process.env.MOTKRA_DAEMON_PORT ?? '7432', 10);
  ipc.startServer(port);

  // System tray icon and context menu
  tray.createTray({
    onOpenChat:    createChatWindow,
    onOpenVSCode:  () => shell.openExternal('vscode://'),
    onQuit:        () => app.quit(),
    onEmailToggle: toggleEmailMonitor,
  });

  // ── Email monitor (Phase 17) — start if enabled ──────────────────────
  if (process.env.MOTKRA_EMAIL_ENABLED === '1') {
    startEmailMonitor();
  }

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

// ── Email monitor helpers ─────────────────────────────────────────────────────

let _emailRunning = false;

function startEmailMonitor() {
  if (_emailRunning) return;
  _emailRunning = true;
  const intervalSec = parseInt(process.env.MOTKRA_EMAIL_INTERVAL ?? '120', 10);
  monitor.start({
    intervalSec,
    notifyFn: ({ type, email, result }) => {
      // trust level lookup for the notification window
      const { getTrust } = require('./email/contacts');
      const trust = getTrust(email.from);
      createNotifyWindow(email, { ...result, trust });
    },
  }).catch(e => {
    console.error('[email] monitor start error:', e.message);
    _emailRunning = false;
  });
}

function stopEmailMonitor() {
  monitor.stop();
  _emailRunning = false;
}

function toggleEmailMonitor() {
  if (_emailRunning) { stopEmailMonitor(); } else { startEmailMonitor(); }
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  ipc.stopServer();
  if (_emailRunning) monitor.stop();
});

// Keep running even if all windows are closed (tray app behaviour)
app.on('window-all-closed', e => e.preventDefault());
