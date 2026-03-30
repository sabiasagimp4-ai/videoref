const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onUpdateStatus: (callback) => ipcRenderer.on('update-status', (_, data) => callback(data)),
  onUpdateError: (callback) => ipcRenderer.on('update-error', (_, data) => callback(data)),
  installUpdate: () => ipcRenderer.send('install-update'),
});
