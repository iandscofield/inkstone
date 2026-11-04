// Electron shell for PDF Pro: serves the built web app over a private app:// scheme
// and gives it native open/save dialogs and "Open with" (.pdf file association) support.
import { app, BrowserWindow, protocol, net, ipcMain, dialog, shell, Menu } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, '..', 'dist');
const devUrl = process.env.PDFPRO_DEV_URL; // e.g. http://localhost:5173 for live reload
const OPENABLE = new Set(['.pdf', '.png', '.jpg', '.jpeg']);

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

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
    title: 'PDF Pro',
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
  win.loadURL(devUrl || 'app://pdfpro/index.html');

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
      detail: 'Close PDF Pro and discard them?',
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
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
