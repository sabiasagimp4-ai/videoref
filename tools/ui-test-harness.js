// ============================================================================
// videoref UI テストハーネス（実ブラウザ＝Electron/Chromium でのバグ検出）
// ----------------------------------------------------------------------------
// 隔離環境（OS の temp に使い捨てライブラリ）で server.js を起動し、本番と同じ
// Electron + Chromium で public/ の SPA を読み込み、コンソール/未捕捉例外を収集
// しつつ動画モーダル・Eagle 準拠ショートカット・インスペクタを自動操作する。
// 実データ・実 AppData には一切触れない。
//
// 使い方:
//   set VIDEOREF_FFMPEG=...\ffmpeg.exe   (PATH に ffmpeg があれば不要)
//   npx electron tools/ui-test-harness.js            # スモーク＋コンソール検査
//   npx electron tools/ui-test-harness.js --shots    # 画面キャプチャも保存
//
// 出力: 末尾に RESULT {json}。issues[] が空ならコンソールエラー無し。
//   --shots 指定時は OS temp の作業ディレクトリに 0X-*.png を保存しパスを表示。
// 注意: 残る CSP 警告は Electron 開発時のみのもの（パッケージ後は出ない）。
// 関連: .claude/rules/testing.md
// ============================================================================
const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');

const REPO = path.resolve(__dirname, '..');
const FFMPEG = process.env.VIDEOREF_FFMPEG || 'ffmpeg';
const PORT = parseInt(process.env.HARNESS_PORT || '3939', 10);
const WANT_SHOTS = process.argv.includes('--shots');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'videoref-harness-'));
const LIB = path.join(WORK, 'lib');
const DATA = path.join(WORK, 'data');
fs.mkdirSync(LIB, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });

// --- テスト用メディア生成（ffmpeg があれば） ---
function genMedia() {
  try {
    spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30', '-t', '3', '-pix_fmt', 'yuv420p', path.join(LIB, 'sample.mp4')], { stdio: 'ignore' });
    spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=400x300', '-frames:v', '1', path.join(LIB, 'sample.png')], { stdio: 'ignore' });
  } catch (e) { /* ffmpeg 無し: メディア無しでも UI 読み込み自体は検査可能 */ }
}

const env = Object.assign({}, process.env, {
  EAGLE_PORT: String(PORT), EAGLE_LIBRARY: LIB, EAGLE_DATA: DATA,
  VIDEOREF_FFMPEG: FFMPEG, ELECTRON_RUN_AS_NODE: '1',
});

const issues = [];
let server, win;
ipcMain.handle('pick-folder', () => null);
const wait = ms => new Promise(r => setTimeout(r, ms));
const shot = name => WANT_SHOTS ? win.webContents.capturePage().then(img => fs.writeFileSync(path.join(WORK, name + '.png'), img.toPNG())) : Promise.resolve();

function waitServer(cb, t) {
  t = t || 0;
  http.get({ host: '127.0.0.1', port: PORT, path: '/' }, r => { r.resume(); cb(); })
    .on('error', () => { if (t > 60) { finish('server never came up'); } else setTimeout(() => waitServer(cb, t + 1), 200); });
}

function finish(fatal) {
  if (WANT_SHOTS) console.log('SHOTS_DIR ' + WORK);
  console.log('RESULT ' + JSON.stringify({ fatal: fatal || null, issues }, null, 2));
  try { server && server.kill(); } catch (e) {}
  try { if (!WANT_SHOTS) fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {}
  app.exit(fatal ? 1 : 0);
}

// 動画モーダル＋Eagle準拠ショートカット＋インスペクタを自動操作（main world で評価）
const INTERACT = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const out = [];
  const key = (code, opts) => document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ code, key: code, bubbles: true }, opts || {})));
  try {
    await sleep(700);
    const vid = state.files.find(f => /\\.mp4$/i.test(f.name));
    const img = state.files.find(f => /\\.png$/i.test(f.name));
    const mv = document.getElementById('modal-video');
    if (vid) {
      openVideoModal(vid); await sleep(900);
      out.push('playBtn=' + !!document.getElementById('pc-play') + ' nativeControls=' + mv.hasAttribute('controls'));
      const t0 = mv.currentTime; key('BracketRight'); key('BracketRight', { shiftKey: true }); await sleep(120);
      out.push('frameStepDelta=' + (mv.currentTime - t0).toFixed(4));
      key('Period', { shiftKey: true }); await sleep(60); out.push('rate=' + mv.playbackRate);
      key('KeyR', { shiftKey: true }); await sleep(60); out.push('rotation=' + state.player.rotation);
      const seek = document.getElementById('pc-seek');
      if (seek) { const r = seek.getBoundingClientRect(); seek.dispatchEvent(new MouseEvent('mousedown', { clientX: r.left + r.width * 0.5, clientY: r.top + 3, bubbles: true })); document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); await sleep(120); out.push('seek t=' + mv.currentTime.toFixed(2)); }
      key('Escape'); await sleep(150); out.push('closed=' + document.getElementById('video-modal').classList.contains('hidden'));
    } else { out.push('NO_VIDEO_FILE'); }
    if (img && typeof openInspector === 'function') { openInspector(img); await sleep(300); out.push('imgPreviewShown=' + !document.getElementById('inspector-img').classList.contains('hidden')); if (typeof closeInspector === 'function') closeInspector(); }
    out.push('DONE');
  } catch (e) { out.push('INTERACT_THREW: ' + e.message); }
  return out;
})()`;

app.disableHardwareAcceleration();
app.whenReady().then(() => {
  genMedia();
  server = spawn(process.execPath, [path.join(REPO, 'server.js')], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  server.stderr.on('data', d => issues.push('SERVER_STDERR: ' + ('' + d).trim()));
  waitServer(async () => {
    win = new BrowserWindow({ show: false, width: 1320, height: 880, webPreferences: { preload: path.join(REPO, 'preload.js') } });
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      if (/insecure content-security-policy/i.test(message)) return; // Electron 開発時のみの警告
      if (level >= 2 || /error|uncaught|cannot read|is not a function|is not defined/i.test(message)) {
        issues.push('CONSOLE[' + level + ']: ' + message + '  @' + (sourceId || '').split('/').pop() + ':' + line);
      }
    });
    win.webContents.on('render-process-gone', (_e, d) => issues.push('RENDER_GONE: ' + JSON.stringify(d)));
    win.webContents.on('did-fail-load', (_e, c, desc) => issues.push('DID_FAIL_LOAD: ' + c + ' ' + desc));
    try {
      await win.loadURL('http://127.0.0.1:' + PORT + '/');
      await win.webContents.executeJavaScript("window.addEventListener('error',e=>console.error('PAGEERR '+(e.error&&e.error.stack||e.message)));window.addEventListener('unhandledrejection',e=>console.error('REJECT '+(e.reason&&e.reason.stack||e.reason)));true");
      await wait(1000); await shot('01-gallery');
      const result = await win.webContents.executeJavaScript(INTERACT);
      if (WANT_SHOTS) {
        await win.webContents.executeJavaScript("(function(){var i=state.files.find(f=>/\\.png$/i.test(f.name))||state.files[0];if(i){var el=document.querySelector('[data-id=\"'+i.id+'\"]');if(el)el.click();openInspector(i);}return true;})()");
        await wait(500); await shot('02-inspector');
      }
      console.log('INTERACTIONS ' + JSON.stringify(result));
      finish(null);
    } catch (err) { finish(err.message); }
  });
});
