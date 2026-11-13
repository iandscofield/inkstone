// Electron shell for Inkstone: serves the built web app over a private app:// scheme
// and gives it native open/save dialogs and "Open with" (.pdf file association) support.
import { app, BrowserWindow, protocol, net, ipcMain, dialog, shell, Menu } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, cpSync } from 'node:fs';
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as signing from './signing.mjs';
import { createRequire } from 'node:module';

const { autoUpdater } = createRequire(import.meta.url)('electron-updater');

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, '..', 'dist');
const devUrl = process.env.INKSTONE_DEV_URL; // e.g. http://localhost:5173 for live reload
const OPENABLE = new Set(['.pdf', '.png', '.jpg', '.jpeg']);

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// Carry over settings and saved signatures from builds released as "PDF Pro".
try {
  const fresh = app.getPath('userData');
  const old = join(dirname(fresh), 'PDF Pro');
  if (!existsSync(fresh) && existsSync(old)) cpSync(old, fresh, { recursive: true });
} catch (e) {
  console.warn('Settings migration skipped', e);
}

let win = null;
let rendererReady = false;
const pendingPaths = [];
// The renderer may only write to files the user opened or picked in a save dialog.
const writablePaths = new Set();

function filesFromArgv(argv) {
  return argv.slice(app.isPackaged ? 1 : 2)
    .filter((a) => !a.startsWith('-') && OPENABLE.has(extname(a).toLowerCase()) && existsSync(a))
    .map((a) => resolve(a));
}

async function loadFiles(paths) {
  const out = [];
  for (const p of paths) {
    try {
      out.push({ path: p, name: basename(p), bytes: await readFile(p) });
      writablePaths.add(p);
    } catch (e) {
      console.error('Cannot read', p, e);
    }
  }
  return out;
}

async function openPaths(paths) {
  if (!paths.length) return;
  if (!win || !rendererReady) { pendingPaths.push(...paths); return; }
  win.webContents.send('open-files', await loadFiles(paths));
  if (win.isMinimized()) win.restore();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    title: 'Inkstone',
    icon: join(here, '..', 'build', 'icon.png'),
    backgroundColor: '#ffffff',
    show: false,
    // No OS title bar: the app's own header is the drag region, with the native
    // window buttons drawn on top of it (colors are synced from the page's theme).
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? true : { color: '#ffffff', symbolColor: '#18181b', height: 40 },
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadURL(devUrl || 'app://inkstone/index.html');

  // Links in documents open in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://') && !(devUrl && url.startsWith(devUrl))) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
  // The page blocks unload when there are unsaved changes; ask the user instead of silently refusing to close.
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Discard changes', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Unsaved changes',
      message: 'You have unsaved changes.',
      detail: 'Close Inkstone and discard them?',
    });
    if (choice === 0) e.preventDefault();
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
  win.on('closed', () => { win = null; rendererReady = false; });
}

// ---------- IPC ----------

ipcMain.handle('renderer-ready', async () => {
  rendererReady = true;
  const paths = pendingPaths.splice(0);
  return loadFiles(paths);
});

// ---------- recent files ----------
// Only files the user opened or saved (writablePaths) can be added, and only listed
// entries can be reopened, so the page can't use this to read arbitrary files.

const recentFile = () => join(app.getPath('userData'), 'recent.json');
const RECENT_MAX = 30;

async function readRecent() {
  try { return JSON.parse(await readFile(recentFile(), 'utf8')); } catch { return []; }
}
async function writeRecent(list) {
  const pinned = list.filter((r) => r.pinned);
  const rest = list.filter((r) => !r.pinned).slice(0, Math.max(0, RECENT_MAX - pinned.length));
  await writeFile(recentFile(), JSON.stringify([...pinned, ...rest]));
}

ipcMain.handle('recent-list', async () => (await readRecent()).map((r) => ({ ...r, missing: !existsSync(r.path), folder: dirname(r.path) })));
ipcMain.handle('recent-add', async (_e, { path, pages, thumb }) => {
  const p = resolve(String(path));
  if (!writablePaths.has(p)) return false;
  const list = await readRecent();
  const prev = list.find((r) => r.path === p);
  const entry = { path: p, name: basename(p), pages: pages || prev?.pages || 0, thumb: thumb || prev?.thumb || null, opened: Date.now(), pinned: !!prev?.pinned };
  await writeRecent([entry, ...list.filter((r) => r.path !== p)]);
  return true;
});
ipcMain.handle('recent-remove', async (_e, path) => { await writeRecent((await readRecent()).filter((r) => r.path !== path)); });
ipcMain.handle('recent-pin', async (_e, path, pinned) => {
  await writeRecent((await readRecent()).map((r) => (r.path === path ? { ...r, pinned: !!pinned } : r)));
});
ipcMain.handle('recent-clear', async () => { await writeRecent((await readRecent()).filter((r) => r.pinned)); });
ipcMain.handle('recent-open', async (_e, path) => {
  const entry = (await readRecent()).find((r) => r.path === path);
  if (!entry || !existsSync(entry.path)) return [];
  return loadFiles([entry.path]);
});

ipcMain.handle('open-dialog', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF and images', extensions: ['pdf', 'png', 'jpg', 'jpeg'] }, { name: 'All files', extensions: ['*'] }],
  });
  return r.canceled ? [] : loadFiles(r.filePaths);
});

ipcMain.handle('save-dialog', async (_e, suggestedName) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: suggestedName || 'document.pdf',
    filters: [{ name: 'PDF document', extensions: ['pdf'] }],
  });
  if (r.canceled || !r.filePath) return null;
  const p = resolve(r.filePath);
  writablePaths.add(p);
  return p;
});

ipcMain.handle('write-file', async (_e, path, bytes) => {
  const p = resolve(String(path));
  if (!writablePaths.has(p)) throw new Error('Not allowed to write to this location');
  await writeFile(p, Buffer.from(bytes));
  return true;
});

ipcMain.handle('title-bar-theme', (_e, { color, symbolColor } = {}) => {
  const hex = /^#[0-9a-f]{3,8}$/i;
  if (!win || process.platform === 'darwin' || !hex.test(color) || !hex.test(symbolColor)) return;
  win.setTitleBarOverlay({ color, symbolColor, height: 40 });
  win.setBackgroundColor(color);
});

// ---------- digital IDs & certificate signatures ----------

ipcMain.handle('ids-list', () => signing.listIds());
ipcMain.handle('ids-create', (_e, opts) => signing.createId(opts));
ipcMain.handle('ids-import', (_e, bytes, password) => signing.importId(bytes, password));
ipcMain.handle('ids-delete', (_e, id) => signing.deleteId(id));
ipcMain.handle('ids-export', async (_e, id, name) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: `${name || 'digital-id'}.pfx`, filters: [{ name: 'Digital ID (PKCS#12)', extensions: ['pfx', 'p12'] }] });
  if (r.canceled || !r.filePath) return false;
  await writeFile(r.filePath, await signing.readIdFile(id));
  return true;
});
ipcMain.handle('ids-export-cert', async (_e, id, password, name) => {
  const pem = await signing.certificatePem(id, password);
  const r = await dialog.showSaveDialog(win, { defaultPath: `${name || 'certificate'}.cer`, filters: [{ name: 'Certificate', extensions: ['cer', 'pem'] }] });
  if (r.canceled || !r.filePath) return false;
  await writeFile(r.filePath, pem);
  return true;
});
ipcMain.handle('sign-pdf', (_e, opts) => signing.signPdf(opts));

// ---------- updates ----------
// Installed builds check GitHub Releases (configured when publishing; see README).
// Portable copies and builds without a release feed report that updates aren't available.

const isPortable = !!process.env.PORTABLE_EXECUTABLE_DIR;
const canUpdate = () => app.isPackaged && !isPortable && process.platform === 'win32';
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.logger = null;
const sendUpdate = (status) => win?.webContents.send('update-status', status);
autoUpdater.on('update-available', (info) => sendUpdate({ state: 'downloading', version: info.version }));
autoUpdater.on('download-progress', (p) => sendUpdate({ state: 'downloading', percent: Math.round(p.percent) }));
autoUpdater.on('update-downloaded', (info) => sendUpdate({ state: 'ready', version: info.version }));

async function checkForUpdates() {
  if (!canUpdate()) return { state: 'unavailable', reason: isPortable ? 'portable' : 'dev' };
  try {
    const r = await autoUpdater.checkForUpdates();
    const latest = r?.updateInfo?.version;
    return { state: r?.isUpdateAvailable ? 'downloading' : 'current', version: latest || app.getVersion() };
  } catch (e) {
    return { state: /app-update\.yml|ENOENT|No published versions/i.test(e.message) ? 'not-configured' : 'error', message: e.message };
  }
}

ipcMain.handle('app-info', () => ({ version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, canUpdate: canUpdate(), portable: isPortable }));
ipcMain.handle('check-updates', () => checkForUpdates());
ipcMain.handle('install-update', () => autoUpdater.quitAndInstall());
ipcMain.handle('verify-pdf', (_e, bytes) => signing.verifyPdf(bytes));

ipcMain.handle('show-in-folder', (_e, path) => {
  const p = resolve(String(path));
  if (writablePaths.has(p)) shell.showItemInFolder(p);
});

// ---------- lifecycle ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => openPaths(filesFromArgv(argv)));
  app.on('open-file', (e, path) => { e.preventDefault(); openPaths([path]); }); // macOS

  app.whenReady().then(() => {
    protocol.handle('app', (req) => {
      const { pathname } = new URL(req.url);
      const file = normalize(join(distDir, decodeURIComponent(pathname)));
      if (file !== distDir && !file.startsWith(distDir + sep)) return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(file).toString());
    });
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    pendingPaths.push(...filesFromArgv(process.argv));
    createWindow();
    // Quietly look for an update a little after startup.
    if (canUpdate()) setTimeout(() => checkForUpdates(), 8000);
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
