const { app, BrowserWindow, shell, Menu, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { fork, execSync } = require('child_process');
const net = require('net');
const http = require('http');
const fs = require('fs');
const https = require('https');
const AdmZip = require('adm-zip');

let mainWindow = null;
let serverProcess = null;

// ===== TOOL PATHS =====
const exeExt = process.platform === 'win32' ? '.exe' : ''; // #9
const BIN_DIR = path.join(app.getPath('userData'), 'bin');
const FFMPEG_PATH  = path.join(BIN_DIR, 'ffmpeg' + exeExt);
const FFPROBE_PATH = path.join(BIN_DIR, 'ffprobe' + exeExt);
const YTDLP_PATH   = path.join(BIN_DIR, 'yt-dlp' + exeExt);

// ===== CHECK SYSTEM TOOL ===== (#8 クロスプラットフォーム対応)
function checkSystemTool(cmd) {
  const which = process.platform === 'win32' ? 'where' : 'which';
  try {
    execSync(which + ' ' + cmd, { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

// ===== DOWNLOAD FILE =====
function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest + '.tmp');
    const request = (urlStr) => {
      https.get(urlStr, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          file.destroy();
          request(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let downloaded = 0;
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (total > 0 && onProgress) onProgress(Math.round(downloaded / total * 100));
        });
        res.pipe(file);
        res.on('end', () => {
          file.close(() => {
            fs.renameSync(dest + '.tmp', dest);
            resolve();
          });
        });
      }).on('error', reject);
    };
    request(url);
    file.on('error', reject);
  });
}

// ===== SETUP TOOLS =====
async function setupTools(win) {
  const send = (msg, pct) => {
    if (win && !win.isDestroyed()) win.webContents.send('tool-setup', { msg, pct });
  };

  // ffmpeg
  let ffmpegOk = false;
  if (fs.existsSync(FFMPEG_PATH)) {
    send('ffmpeg: ローカルキャッシュを使用', 10);
    ffmpegOk = true;
  } else if (checkSystemTool('ffmpeg')) {
    send('ffmpeg: システムインストール済み', 10);
    ffmpegOk = true;
  } else {
    send('ffmpeg をダウンロード中...', 5);
    try {
      // ffmpeg Windows build (gyan.dev essentials)
      const ffmpegUrl = 'https://github.com/BtbN/ffmpeg-builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';
      const zipPath = path.join(BIN_DIR, 'ffmpeg.zip');
      fs.mkdirSync(BIN_DIR, { recursive: true });
      await downloadFile(ffmpegUrl, zipPath, (p) => send('ffmpeg をダウンロード中... ' + p + '%', Math.round(p * 0.3)));
      // adm-zip で展開 (#14 クロスプラットフォーム対応)
      send('ffmpeg を展開中...', 35);
      const zip = new AdmZip(zipPath);
      const tmpDir = path.join(BIN_DIR, 'ffmpeg_tmp');
      zip.extractAllTo(tmpDir, true);
      // ffmpeg.exe / ffmpeg (OS問わず) を探してコピー
      const findBin = (dir, name) => {
        for (const entry of fs.readdirSync(dir)) {
          const full = path.join(dir, entry);
          if (fs.statSync(full).isDirectory()) { const r = findBin(full, name); if (r) return r; }
          else if (entry === name) return full;
        }
        return null;
      };
      const ffmpegName = 'ffmpeg' + exeExt;
      const ffprobeName = 'ffprobe' + exeExt;
      const foundFfmpeg = findBin(tmpDir, ffmpegName);
      const foundFfprobe = findBin(tmpDir, ffprobeName);
      if (foundFfmpeg) fs.copyFileSync(foundFfmpeg, FFMPEG_PATH);
      if (foundFfprobe) fs.copyFileSync(foundFfprobe, FFPROBE_PATH);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(zipPath, { force: true });
      ffmpegOk = fs.existsSync(FFMPEG_PATH);
    } catch (e) {
      console.error('ffmpeg download failed:', e.message);
    }
  }

  // yt-dlp
  let ytdlpOk = false;
  if (fs.existsSync(YTDLP_PATH)) {
    send('yt-dlp: ローカルキャッシュを使用', 50);
    ytdlpOk = true;
  } else if (checkSystemTool('yt-dlp')) {
    send('yt-dlp: システムインストール済み', 50);
    ytdlpOk = true;
  } else {
    send('yt-dlp をダウンロード中...', 45);
    try {
      fs.mkdirSync(BIN_DIR, { recursive: true });
      await downloadFile(
        'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
        YTDLP_PATH,
        (p) => send('yt-dlp をダウンロード中... ' + p + '%', 45 + Math.round(p * 0.4))
      );
      ytdlpOk = fs.existsSync(YTDLP_PATH);
    } catch (e) {
      console.error('yt-dlp download failed:', e.message);
    }
  }

  send('準備完了', 100);
  return { ffmpegOk, ytdlpOk };
}

// ===== AUTO UPDATER =====
function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (info) => {
    if (mainWindow) mainWindow.webContents.send('update-status', { type: 'available', version: info.version });
  });
  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow) mainWindow.webContents.send('update-status', { type: 'progress', percent: Math.round(progress.percent) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    if (mainWindow) mainWindow.webContents.send('update-status', { type: 'downloaded', version: info.version });
  });
  autoUpdater.on('error', (err) => console.error('Update error:', err.message));
  // 指数バックオフリトライ: 5秒 → 30秒 → 5分 (最大3回)
  const delays = [5000, 30000, 300000];
  let attempt = 0;
  function tryCheck() {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(e => {
        console.error('Update check failed (attempt ' + (attempt + 1) + '):', e.message);
        attempt++;
        if (attempt < delays.length) {
          tryCheck();
        } else {
          console.error('Update check exhausted retries');
          if (mainWindow) mainWindow.webContents.send('update-error', { message: e.message });
        }
      });
    }, delays[attempt]);
  }
  tryCheck();
}

ipcMain.on('install-update', () => autoUpdater.quitAndInstall());

// ===== PORT =====
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const port = srv.address().port; srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

function waitForServer(port, maxRetries = 40) {
  return new Promise((resolve, reject) => {
    let retries = 0;
    const check = () => {
      const req = http.get('http://127.0.0.1:' + port + '/api/ping', () => resolve(port));
      req.on('error', () => { retries++; if (retries >= maxRetries) reject(new Error('Server did not start')); else setTimeout(check, 300); });
      req.setTimeout(500, () => { req.destroy(); retries++; if (retries >= maxRetries) reject(new Error('Server timeout')); else setTimeout(check, 300); });
    };
    setTimeout(check, 500);
  });
}

// ===== SERVER =====
function startServer(port, dataDir) {
  const serverPath = path.join(app.getAppPath(), 'server.js');
  const defaultLibrary = path.join(app.getPath('documents'), 'videoref');
  // ローカルキャッシュのbinパスを環境変数で渡す
  const ffmpegBin  = fs.existsSync(FFMPEG_PATH)  ? FFMPEG_PATH  : (checkSystemTool('ffmpeg')  ? 'ffmpeg'  : 'ffmpeg');
  const ffprobeBin = fs.existsSync(FFPROBE_PATH) ? FFPROBE_PATH : (checkSystemTool('ffprobe') ? 'ffprobe' : 'ffprobe');
  const ytdlpBin   = fs.existsSync(YTDLP_PATH)   ? YTDLP_PATH   : (checkSystemTool('yt-dlp')  ? 'yt-dlp'  : 'yt-dlp');
  serverProcess = fork(serverPath, [], {
    env: {
      ...process.env,
      EAGLE_PORT: String(port),
      EAGLE_LIBRARY: defaultLibrary,
      EAGLE_DATA: dataDir,
      VIDEOREF_FFMPEG:  ffmpegBin,
      VIDEOREF_FFPROBE: ffprobeBin,
      VIDEOREF_YTDLP:   ytdlpBin,
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  serverProcess.on('error', (err) => console.error('Server fork error:', err));
}

// ===== LOADING HTML =====
const LOADING_HTML = `data:text/html,<!DOCTYPE html><html><head><meta charset="UTF-8"><style>*{margin:0;padding:0;box-sizing:border-box}body{background:%23161618;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:-apple-system,"Segoe UI",sans-serif;color:%23aaaaaf}.logo{font-size:48px;margin-bottom:20px}.title{font-size:18px;font-weight:600;color:%23e8e8ea;margin-bottom:8px}.sub{font-size:13px;margin-bottom:32px;color:%234a8fff}.bar-wrap{width:220px;height:4px;background:%232e2e32;border-radius:2px;overflow:hidden}.bar{height:4px;background:%234a8fff;border-radius:2px;transition:width .3s;width:0%}</style></head><body><div class="logo">&#x1F3AC;</div><div class="title">videoref</div><div class="sub" id="msg">起動中...</div><div class="bar-wrap"><div class="bar" id="bar"></div></div><script>if(window.__ELECTRON__){}</script></body></html>`;

// ===== WINDOW =====
function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    title: 'videoref', backgroundColor: '#161618',
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(app.getAppPath(), 'preload.js') },
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
    const dataDir = path.join(app.getPath('userData'), 'data');

    // ツールセットアップ用の一時ウィンドウ（ローディング画面）
    mainWindow = new BrowserWindow({
      width: 1440, height: 900, minWidth: 900, minHeight: 600,
      title: 'videoref', backgroundColor: '#161618',
      webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(app.getAppPath(), 'preload.js') },
      show: true,
    });
    Menu.setApplicationMenu(null);
    mainWindow.loadURL(LOADING_HTML);
    mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
    mainWindow.on('closed', () => { mainWindow = null; });

    // ツールのセットアップ（DL or スキップ）
    await mainWindow.webContents.executeJavaScript('document.readyState').catch(() => {});
    const tools = await setupTools(mainWindow);
    console.log('Tools ready:', tools);

    startServer(port, dataDir);
    waitForServer(port)
      .then(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL('http://127.0.0.1:' + port); })
      .catch(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL('http://127.0.0.1:' + port); });

    setupAutoUpdater();
  } catch (e) {
    console.error('Startup error:', e);
    app.quit();
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) app.quit(); });
});

// ===== CLEANUP =====
function cleanup() { if (serverProcess) { serverProcess.kill('SIGTERM'); serverProcess = null; } }
app.on('window-all-closed', () => { cleanup(); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', cleanup);
process.on('exit', cleanup);
