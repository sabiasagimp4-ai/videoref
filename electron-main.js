const { app, BrowserWindow, shell, Menu, dialog, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { fork } = require('child_process');
const net = require('net');
const http = require('http');

let mainWindow = null;
let serverProcess = null;

// ===== AUTO UPDATER =====
function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    if (mainWindow) {
      mainWindow.webContents.send('update-status', {
        type: 'available',
        version: info.version
      });
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow) {
      mainWindow.webContents.send('update-status', {
        type: 'progress',
        percent: Math.round(progress.percent)
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    if (mainWindow) {
      mainWindow.webContents.send('update-status', {
        type: 'downloaded',
        version: info.version
      });
    }
  });

  autoUpdater.on('error', (err) => {
    console.error('Update error:', err.message);
  });

  // 起動3秒後にチェック
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(e => console.error('Update check failed:', e.message));
  }, 3000);
}

ipcMain.on('install-update', () => {
  autoUpdater.quitAndInstall();
});

// ===== PORT =====
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function waitForServer(port, maxRetries = 40) {
  return new Promise((resolve, reject) => {
    let retries = 0;
    const check = () => {
      const req = http.get('http://127.0.0.1:' + port + '/api/ping', (res) => {
        resolve(port);
      });
      req.on('error', () => {
        retries++;
        if (retries >= maxRetries) reject(new Error('Server did not start'));
        else setTimeout(check, 300);
      });
      req.setTimeout(500, () => {
        req.destroy();
        retries++;
        if (retries >= maxRetries) reject(new Error('Server timeout'));
        else setTimeout(check, 300);
      });
    };
    setTimeout(check, 500);
  });
}

// ===== SERVER =====
function startServer(port, dataDir) {
  const serverPath = path.join(app.getAppPath(), 'server.js');
  // デフォルトライブラリパスはドキュメント/EagleModoki
  const defaultLibrary = path.join(app.getPath('documents'), 'EagleModoki');
  serverProcess = fork(serverPath, [], {
    env: {
      ...process.env,
      EAGLE_PORT: String(port),
      EAGLE_LIBRARY: defaultLibrary,
      EAGLE_DATA: dataDir,
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  serverProcess.on('error', (err) => console.error('Server fork error:', err));
}

// ===== LOADING HTML =====
const LOADING_HTML = `data:text/html,<!DOCTYPE html><html><head><meta charset="UTF-8"><style>*{margin:0;padding:0;box-sizing:border-box}body{background:%23161618;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:-apple-system,"Segoe UI",sans-serif;color:%23aaaaaf}.logo{font-size:48px;margin-bottom:20px}.title{font-size:18px;font-weight:600;color:%23e8e8ea;margin-bottom:8px}.sub{font-size:13px;margin-bottom:32px}.spinner{width:28px;height:28px;border:2px solid %232e2e32;border-top-color:%234a8fff;border-radius:50%;animation:spin .7s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body><div class="logo">&#x1F985;</div><div class="title">Eagle Modoki</div><div class="sub">Loading...</div><div class="spinner"></div></body></html>`;

// ===== WINDOW =====
function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    title: 'Eagle Modoki', backgroundColor: '#161618',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(app.getAppPath(), 'preload.js')
    },
    show: true,
  });
  Menu.setApplicationMenu(null);
  mainWindow.loadURL(LOADING_HTML);
  waitForServer(port)
    .then(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL('http://127.0.0.1:' + port); })
    .catch(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL('http://127.0.0.1:' + port); });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ===== APP READY =====
app.whenReady().then(async () => {
  try {
    const port = await getFreePort();
    // データはAppData/Roaming/Eagle Modoki配下に保存
    const dataDir = path.join(app.getPath('userData'), 'data');
    startServer(port, dataDir);
    createWindow(port);
    setupAutoUpdater();
  } catch (e) {
    console.error('Startup error:', e);
    app.quit();
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) app.quit(); });
});

// ===== CLEANUP =====
function cleanup() {
  if (serverProcess) { serverProcess.kill('SIGTERM'); serverProcess = null; }
}
app.on('window-all-closed', () => { cleanup(); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', cleanup);
process.on('exit', cleanup);
