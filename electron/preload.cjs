// Narrow, explicit bridge between the sandboxed page and the Electron main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('inkstoneDesktop', {
  platform: process.platform,
  ready: () => ipcRenderer.invoke('renderer-ready'),
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  saveDialog: (suggestedName) => ipcRenderer.invoke('save-dialog', suggestedName),
  writeFile: (path, bytes) => ipcRenderer.invoke('write-file', path, bytes),
  showInFolder: (path) => ipcRenderer.invoke('show-in-folder', path),
  setTitleBarTheme: (theme) => ipcRenderer.invoke('title-bar-theme', theme),
  // Digital IDs and certificate signatures. Private keys never leave the main process.
  ids: {
    list: () => ipcRenderer.invoke('ids-list'),
    create: (opts) => ipcRenderer.invoke('ids-create', opts),
    import: (bytes, password) => ipcRenderer.invoke('ids-import', bytes, password),
    remove: (id) => ipcRenderer.invoke('ids-delete', id),
    exportId: (id, name) => ipcRenderer.invoke('ids-export', id, name),
    exportCert: (id, password, name) => ipcRenderer.invoke('ids-export-cert', id, password, name),
  },
  signPdf: (opts) => ipcRenderer.invoke('sign-pdf', opts),
  recent: {
    list: () => ipcRenderer.invoke('recent-list'),
    add: (entry) => ipcRenderer.invoke('recent-add', entry),
    remove: (path) => ipcRenderer.invoke('recent-remove', path),
    pin: (path, pinned) => ipcRenderer.invoke('recent-pin', path, pinned),
    clear: () => ipcRenderer.invoke('recent-clear'),
    open: (path) => ipcRenderer.invoke('recent-open', path),
  },
  appInfo: () => ipcRenderer.invoke('app-info'),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, s) => cb(s)),
  verifyPdf: (bytes) => ipcRenderer.invoke('verify-pdf', bytes),
  onOpenFiles: (cb) => ipcRenderer.on('open-files', (_e, files) => cb(files)),
});
