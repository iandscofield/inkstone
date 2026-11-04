// Narrow, explicit bridge between the sandboxed page and the Electron main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pdfProDesktop', {
  platform: process.platform,
  ready: () => ipcRenderer.invoke('renderer-ready'),
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  saveDialog: (suggestedName) => ipcRenderer.invoke('save-dialog', suggestedName),
  writeFile: (path, bytes) => ipcRenderer.invoke('write-file', path, bytes),
  showInFolder: (path) => ipcRenderer.invoke('show-in-folder', path),
  onOpenFiles: (cb) => ipcRenderer.on('open-files', (_e, files) => cb(files)),
});
