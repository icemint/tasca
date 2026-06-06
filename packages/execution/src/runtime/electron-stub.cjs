'use strict';
/**
 * Headless Electron stub (bootstrap seam).
 *
 * The vendored execution core's compiled main-process modules do
 * `require('electron')` eagerly at import time (errorTracking.js, telemetry.js,
 * settings.js, db/path.js, ...). Under system Node with no Electron binary, the
 * real `electron` package throws at import ("Electron failed to install
 * correctly"). This stub is injected via Module._resolveFilename so those
 * `require('electron')` calls resolve to a minimal, Electron-free object that
 * satisfies the *non-UI* surface the headless execution core actually touches:
 *
 *   app.getPath('userData' | 'home' | 'temp' | 'exe' | ...)  -> filesystem dirs
 *   app.getAppPath()    -> repo root (for drizzle migration discovery)
 *   app.getName/getVersion/isPackaged/setName/on  -> inert/no-op
 *
 * Everything UI/IPC (BrowserWindow, ipcMain, dialog, Menu, shell.openExternal,
 * safeStorage, webContents, Notification, net) is NOT on the headless code path;
 * it is stubbed as throwing/inert so any accidental use is loud, not silent.
 *
 * This keeps the vendored source 100% unmodified — the entire de-Electron cut
 * for the import graph is this one runtime shim. Narrowest possible diff against
 * upstream => cheapest rebase.
 *
 * Env contract: EMDASH_USER_DATA_DIR, EMDASH_APP_PATH.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const USER_DATA =
  process.env.EMDASH_USER_DATA_DIR ||
  path.join(os.tmpdir(), 'emdash-headless-userdata');
fs.mkdirSync(USER_DATA, { recursive: true });

const APP_PATH = process.env.EMDASH_APP_PATH || process.cwd();

function getPath(name) {
  switch (name) {
    case 'userData':
    case 'sessionData':
      return USER_DATA;
    case 'home':
      return os.homedir();
    case 'appData':
      return path.join(os.homedir(), '.config');
    case 'temp':
      return os.tmpdir();
    case 'exe':
      return process.execPath;
    case 'logs':
      return path.join(USER_DATA, 'logs');
    case 'cache':
      return path.join(USER_DATA, 'cache');
    default:
      return path.join(USER_DATA, name);
  }
}

const app = {
  getPath,
  getAppPath: () => APP_PATH,
  getName: () => 'emdash',
  getVersion: () => process.env.EMDASH_VERSION || '0.4.48-headless',
  setName: () => {},
  isPackaged: false,
  whenReady: () => Promise.resolve(),
  on: () => app,
  once: () => app,
  quit: () => {},
  exit: () => {},
  getLocale: () => 'en-US',
};

function notImplemented(surface) {
  return new Proxy(
    {},
    {
      get() {
        throw new Error(
          `[electron-stub] ${surface} is not available on the headless path`
        );
      },
    }
  );
}

module.exports = {
  app,
  // Loud stubs for UI/IPC surfaces that must never run headless:
  BrowserWindow: notImplemented('BrowserWindow'),
  ipcMain: { handle() {}, on() {}, removeHandler() {} },
  ipcRenderer: notImplemented('ipcRenderer'),
  dialog: notImplemented('dialog'),
  Menu: { setApplicationMenu() {}, buildFromTemplate: () => ({}) },
  Tray: notImplemented('Tray'),
  shell: { openExternal: async () => {}, openPath: async () => '' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString() {
      throw new Error('[electron-stub] safeStorage unavailable (by design)');
    },
    decryptString() {
      throw new Error('[electron-stub] safeStorage unavailable (by design)');
    },
  },
  Notification: function () {
    return { show() {}, on() {} };
  },
  net: notImplemented('net'),
  powerMonitor: { on() {} },
  clipboard: { writeText() {}, readText: () => '' },
  contextBridge: { exposeInMainWorld() {} },
  webContents: notImplemented('webContents'),
  WebContentsView: notImplemented('WebContentsView'),
};
