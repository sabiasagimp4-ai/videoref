const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onUpdateStatus: (callback) => ipcRenderer.on('update-status', (_, data) => callback(data)),
  onUpdateError: (callback) => ipcRenderer.on('update-error', (_, data) => callback(data)),
  installUpdate: () => ipcRenderer.send('install-update'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  // Electron 32+ ではセキュリティ上 File.path が廃止されたため webUtils 経由で取得する
  getPathForFile: (file) => webUtils.getPathForFile(file),
});
