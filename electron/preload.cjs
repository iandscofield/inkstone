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
  verifyPdf: (bytes) => ipcRenderer.invoke('verify-pdf', bytes),
  onOpenFiles: (cb) => ipcRenderer.on('open-files', (_e, files) => cb(files)),
});
