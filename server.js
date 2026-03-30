const express = require('express');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const { spawn } = require('child_process');

const app = express();
const PORT = parseInt(process.env.EAGLE_PORT || '3000', 10);
const DATA_BASE = process.env.EAGLE_DATA || path.join(__dirname, '.data');
const DATA_PATH = path.join(DATA_BASE, 'metadata.json');
const THUMB_DIR = path.join(DATA_BASE, 'thumbs');
const SETTINGS_PATH = path.join(DATA_BASE, 'settings.json');
const TRASH_DIR  = path.join(DATA_BASE, 'trash');
const TRASH_PATH = path.join(DATA_BASE, 'trash.json');

// ライブラリパスは設定ファイル > 環境変数 > デフォルト の優先順
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch (e) { console.error('[loadSettings] error:', e.message); }
  return {};
}
function saveSettings(data) {
  try {
    fs.mkdirSync(DATA_BASE, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) { console.error('[saveSettings] error:', e.message); }
}
let settings = loadSettings();
let LIBRARY_PATH = settings.libraryPath || process.env.EAGLE_LIBRARY || 'D:\\claude\\eaglemodoki';

const VIDEO_EXTS = ['.mp4', '.mov', '.avi', '.webm', '.mkv', '.flv', '.wmv', '.m4v', '.ts', '.mts'];
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.tiff'];
const AUDIO_EXTS = ['.mp3', '.wav', '.aac', '.flac', '.ogg', '.m4a'];

// サムネイルキャッシュ
const thumbCache = new Set();
// 生成中IDセット
const generating = new Map(); // id -> Promise (#7 Promise共有)
// 生成キュー
const thumbQueue = [];
let activeWorkers = 0;
const MAX_WORKERS = 3;

// ===== INIT =====
fs.mkdirSync(THUMB_DIR, { recursive: true });

// 既存サムネイルをキャッシュに読み込む
try {
  for (const f of fs.readdirSync(THUMB_DIR)) {
    if (f.endsWith('.jpg')) thumbCache.add(f.replace('.jpg', ''));
  }
  console.log(`   サムネイルキャッシュ: ${thumbCache.size} 件`);
} catch (e) {}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== METADATA =====
function loadMeta() {
  try {
    if (fs.existsSync(DATA_PATH)) return JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  } catch (e) {}
  return {};
}
function saveMeta(data) {
  const tmp = DATA_PATH + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, DATA_PATH);
  } catch (e) {
    console.error('[saveMeta] error:', e.message);
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}
function loadTrash() {
  try {
    if (fs.existsSync(TRASH_PATH)) return JSON.parse(fs.readFileSync(TRASH_PATH, 'utf-8'));
  } catch (e) {}
  return [];
}
function saveTrash(data) {
  const tmp = TRASH_PATH + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, TRASH_PATH);
  } catch (e) {
    console.error('[saveTrash] error:', e.message);
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

function generateId(filePath) {
  const rel = path.relative(LIBRARY_PATH, filePath).replace(/\\/g, '/');
  return Buffer.from(rel).toString('base64url');
}
function isSafePath(filePath) {
  const normalized = path.normalize(filePath);
  const base = path.normalize(LIBRARY_PATH);
  return normalized.startsWith(base + path.sep) || normalized === base;
}
function decodeId(id) {
  try {
    const rel = Buffer.from(id, 'base64url').toString('utf-8');
    // ../ や絶対パスを含む不正IDを拒否
    if (rel.includes('..') || path.isAbsolute(rel)) return null;
    const full = path.normalize(path.join(LIBRARY_PATH, rel));
    if (!isSafePath(full)) return null;
    return full;
  } catch (e) {
    console.error('[decodeId] error:', e.message);
    return null;
  }
}

// ===== THUMBNAIL =====
function thumbPath(id) {
  return path.join(THUMB_DIR, id + '.jpg');
}

function generateThumbnail(id, filePath) {
  if (thumbCache.has(id)) return Promise.resolve(true);
  if (generating.has(id)) return generating.get(id); // 同一ID待機 (#7)
  const out = thumbPath(id);
  const promise = new Promise((resolve) => {
    const probe = spawn(FFPROBE_BIN, [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', filePath
    ]);
    let durStr = '';
    probe.stdout.on('data', d => durStr += d.toString());
    probe.on('close', () => {
      const dur = parseFloat(durStr) || 10;
      const seekSec = Math.min(Math.max(dur * 0.1, 0.5), 10).toFixed(2);
      const ff = spawn(FFMPEG_BIN, [
        '-ss', seekSec, '-i', filePath,
        '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '3', '-y', out
      ]);
      ff.on('close', (code) => {
        generating.delete(id);
        if (code === 0 && fs.existsSync(out)) { thumbCache.add(id); resolve(true); }
        else resolve(false);
      });
      ff.on('error', (err) => {
        console.error('[ffmpeg] error:', err.message);
        generating.delete(id); resolve(false);
      });
    });
    probe.on('error', () => generateFallback(id, filePath, out, resolve));
  });
  generating.set(id, promise);
  return promise;
}

function generateFallback(id, filePath, out, resolve) {
  const ff = spawn(FFMPEG_BIN, [
    '-ss', '3',
    '-i', filePath,
    '-frames:v', '1',
    '-vf', 'scale=320:-2',
    '-q:v', '3',
    '-y', out
  ]);
  ff.on('close', (code) => {
    generating.delete(id);
    if (code === 0 && fs.existsSync(out)) {
      thumbCache.add(id);
      resolve(true);
    } else {
      resolve(false);
    }
  });
  ff.on('error', () => { generating.delete(id); resolve(false); });
}

// キュー処理
function processQueue() {
  while (activeWorkers < MAX_WORKERS && thumbQueue.length > 0) {
    const { id, filePath, resolve } = thumbQueue.shift();
    activeWorkers++;
    generateThumbnail(id, filePath).then(ok => {
      activeWorkers--;
      resolve(ok);
      processQueue();
    });
  }
}

function enqueueThumb(id, filePath) {
  if (thumbCache.has(id) || generating.has(id)) return generating.get(id);
  return new Promise(resolve => {
    thumbQueue.push({ id, filePath, resolve });
    processQueue();
  });
}

// バックグラウンドでサムネイル一括生成
function startBackgroundThumbGen(files) {
  const missing = files.filter(f => f.type === 'video' && !thumbCache.has(f.id));
  if (missing.length === 0) return;
  console.log(`   サムネイル生成開始: ${missing.length} 件`);
  let done = 0;
  for (const f of missing) {
    const filePath = decodeId(f.id);
    if (!filePath) continue;
    enqueueThumb(f.id, filePath)?.then(ok => {
      done++;
      if (ok) process.stdout.write(`\r   サムネイル生成中: ${done}/${missing.length}`);
      if (done === missing.length) console.log(`\n   サムネイル生成完了`);
    });
  }
}

// ===== SCAN (非同期化 #13) =====
async function scanDir(dirPath, baseLib) {
  const results = [];
  let entries;
  try { entries = await fs.promises.readdir(dirPath); } catch (e) { return results; }

  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const fullPath = path.join(dirPath, name);
    let stat;
    try { stat = await fs.promises.stat(fullPath); } catch (e) { continue; }

    if (stat.isDirectory()) {
      const sub = await scanDir(fullPath, baseLib);
      results.push(...sub);
    } else {
      const ext = path.extname(name).toLowerCase();
      let type = 'other';
      if (VIDEO_EXTS.includes(ext)) type = 'video';
      else if (IMAGE_EXTS.includes(ext)) type = 'image';
      else if (AUDIO_EXTS.includes(ext)) type = 'audio';
      if (type === 'other') continue;
      const id = generateId(fullPath);
      results.push({
        id, name, ext: ext.slice(1), type,
        size: stat.size, mtime: stat.mtimeMs,
        relPath: path.relative(baseLib, fullPath).replace(/\\/g, '/'),
        folder: path.relative(baseLib, path.dirname(fullPath)).replace(/\\/g, '/') || '.',
      });
    }
  }
  return results;
}

async function hasVideoFiles(dirPath) {
  let entries;
  try { entries = await fs.promises.readdir(dirPath); } catch (e) { return false; }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const full = path.join(dirPath, entry);
    try {
      const stat = await fs.promises.stat(full);
      if (stat.isDirectory()) {
        if (await hasVideoFiles(full)) return true;
      } else {
        if (VIDEO_EXTS.includes(path.extname(entry).toLowerCase())) return true;
      }
    } catch (e) {}
  }
  return false;
}

async function getFolderTree(dirPath, baseLib) {
  const name = dirPath === baseLib ? 'Library' : path.basename(dirPath);
  const rel = path.relative(baseLib, dirPath).replace(/\\/g, '/') || '.';
  const node = { name, rel, children: [] };
  let entries;
  try { entries = await fs.promises.readdir(dirPath); } catch (e) { return node; }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const full = path.join(dirPath, entry);
    try {
      const stat = await fs.promises.stat(full);
      if (stat.isDirectory() && await hasVideoFiles(full)) {
        node.children.push(await getFolderTree(full, baseLib));
      }
    } catch (e) {}
  }
  return node;
}

// ===== API =====

// GET /api/files
app.get('/api/files', async (req, res) => {
  if (!fs.existsSync(LIBRARY_PATH)) return res.json([]);
  const files = await scanDir(LIBRARY_PATH, LIBRARY_PATH);
  const meta = loadMeta();
  const result = files.map(f => ({
    ...f,
    tags: meta[f.id]?.tags || [],
    note: meta[f.id]?.note || '',
    color: meta[f.id]?.color || null,
    rating: meta[f.id]?.rating || 0,
    url: meta[f.id]?.url || '',
    hasThumbnail: thumbCache.has(f.id),
  }));

  // バックグラウンドでサムネイル生成
  startBackgroundThumbGen(result);

  res.json(result);
});

// GET /api/thumb/:id — サムネイル取得
app.get('/api/thumb/:id', async (req, res) => {
  const { id } = req.params;
  const tp = thumbPath(id);

  if (thumbCache.has(id) && fs.existsSync(tp)) {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return fs.createReadStream(tp).pipe(res);
  }

  // まだ生成されていない場合は即時生成
  const filePath = decodeId(id);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Not found');

  const ok = await new Promise(resolve => {
    thumbQueue.unshift({ id, filePath, resolve }); // 優先度高め（先頭に積む）
    processQueue();
  });

  if (ok && fs.existsSync(tp)) {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return fs.createReadStream(tp).pipe(res);
  }
  res.status(202).send('Generating');
});

// GET /api/thumb-status — 生成状況
app.get('/api/thumb-status', (req, res) => {
  res.json({
    cached: thumbCache.size,
    generating: generating.size,
    queued: thumbQueue.length,
  });
});

// GET /api/folders
app.get('/api/folders', async (req, res) => {
  if (!fs.existsSync(LIBRARY_PATH)) return res.json({ name: 'Library', rel: '.', children: [] });
  res.json(await getFolderTree(LIBRARY_PATH, LIBRARY_PATH));
});

// GET /api/tags
app.get('/api/tags', (req, res) => {
  const meta = loadMeta();
  const tagSet = new Set();
  for (const v of Object.values(meta)) (v.tags || []).forEach(t => tagSet.add(t));
  res.json([...tagSet].sort());
});

// PUT /api/files/:id/meta
app.put('/api/files/:id/meta', (req, res) => {
  const { id } = req.params;
  const { tags, note, color, rating, url } = req.body;
  const meta = loadMeta();
  meta[id] = { ...(meta[id] || {}), tags, note, color, rating, url };
  saveMeta(meta);
  res.json({ ok: true });
});

// GET /api/video/:id — Range対応ストリーミング
app.get('/api/video/:id', (req, res) => {
  const filePath = decodeId(req.params.id);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Not found');
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;
  const mimeType = mime.lookup(filePath) || 'video/mp4';

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;
    const fileStream = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': mimeType,
    });
    fileStream.pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': mimeType });
    fs.createReadStream(filePath).pipe(res);
  }
});

// GET /api/file/:id
app.get('/api/file/:id', (req, res) => {
  const filePath = decodeId(req.params.id);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.setHeader('Content-Type', mime.lookup(filePath) || 'application/octet-stream');
  fs.createReadStream(filePath).pipe(res);
});

// DELETE /api/files/:id  (?permanent=true で完全削除、デフォルトはゴミ箱移動)
app.delete('/api/files/:id', (req, res) => {
  const id = req.params.id;
  const filePath = decodeId(id);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Not found');
  if (req.query.permanent === 'true') {
    fs.unlinkSync(filePath);
  } else {
    fs.mkdirSync(TRASH_DIR, { recursive: true });
    const destName = id + '_' + path.basename(filePath);
    fs.renameSync(filePath, path.join(TRASH_DIR, destName));
    const trash = loadTrash();
    trash.push({ id, name: path.basename(filePath), destName, deletedAt: new Date().toISOString() });
    saveTrash(trash);
  }
  // サムネイルも削除
  const tp = thumbPath(id);
  if (fs.existsSync(tp)) fs.unlinkSync(tp);
  thumbCache.delete(id);
  const meta = loadMeta();
  delete meta[id];
  saveMeta(meta);
  res.json({ ok: true });
});

// GET /api/trash — ゴミ箱一覧
app.get('/api/trash', (req, res) => {
  res.json(loadTrash());
});

// DELETE /api/trash — ゴミ箱を空にする
app.delete('/api/trash', (req, res) => {
  const trash = loadTrash();
  for (const item of trash) {
    const p = path.join(TRASH_DIR, item.destName);
    if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch (e) {}
  }
  saveTrash([]);
  res.json({ ok: true });
});

// PUT /api/files/:id/meta — url フィールドも含めて保存
// (既存のmeta PUTルートで url も受け取れるよう拡張済み — bodyに含まれれば保存される)

// GET /api/frame/:id?t=秒 — 指定時刻のフレームをJPEGで返す
app.get('/api/frame/:id', (req, res) => {
  const filePath = decodeId(req.params.id);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Not found');
  const t = parseFloat(req.query.t) || 0;
  const ff = spawn(FFMPEG_BIN, [
    '-ss', String(t),
    '-i', filePath,
    '-frames:v', '1',
    '-vf', 'scale=1920:-2',
    '-q:v', '2',
    '-f', 'image2',
    '-vcodec', 'mjpeg',
    'pipe:1',
  ]);
  res.setHeader('Content-Type', 'image/jpeg');
  ff.stdout.pipe(res);
  ff.on('error', () => res.status(500).send('FFmpeg error'));
  ff.stderr.on('data', () => {});
});

// POST /api/set-thumb/:id?t=秒 — 指定フレームをサムネイルに設定
app.post('/api/set-thumb/:id', (req, res) => {
  const filePath = decodeId(req.params.id);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Not found');
  const t = parseFloat(req.query.t) || 0;
  const out = thumbPath(req.params.id);
  thumbCache.delete(req.params.id);
  const ff = spawn(FFMPEG_BIN, [
    '-ss', String(t), '-i', filePath,
    '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '3', '-y', out
  ]);
  ff.on('close', (code) => {
    if (code === 0 && fs.existsSync(out)) {
      thumbCache.add(req.params.id);
      res.json({ ok: true });
    } else {
      res.status(500).json({ ok: false });
    }
  });
  ff.on('error', () => res.status(500).json({ ok: false }));
  ff.stderr.on('data', () => {});
});

// ffmpeg/ffprobe/yt-dlp パス（環境変数 > システムPATH の優先順）
const FFMPEG_BIN  = process.env.VIDEOREF_FFMPEG  || 'ffmpeg';
const FFPROBE_BIN = process.env.VIDEOREF_FFPROBE || 'ffprobe';
const YTDLP_BIN   = process.env.VIDEOREF_YTDLP   || 'yt-dlp';
function getYtDlpPath() { return YTDLP_BIN; }

const JOB_LOG_LIMIT = 100; // ログ行数上限 (#12)

// ログ追加ヘルパー
function jobLogPush(job, line) {
  jobLogPush(job, line);
  if (job.log.length > JOB_LOG_LIMIT) job.log.shift();
}

// ダウンロード中のジョブ管理
const downloadJobs = new Map(); // id -> { process, url, status, log }

// POST /api/download — ダウンロード開始
app.post('/api/download', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const ytdlp = getYtDlpPath();

  // 安全なテンプレ: IDベースで保存 → パストラバーサル防止 (#3)
  // --print after_move で完了後の実ファイルパスを取得 (#11)
  const args = [
    url,
    '--output', path.join(LIBRARY_PATH, '%(id)s.%(ext)s'),
    '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--progress',
    '--newline',
    '--no-warnings',
    '--print', 'after_move:filepath',
  ];

  const proc = spawn(ytdlp, args, {
    env: { ...process.env, PATH: process.env.PATH },
  });

  const job = { process: proc, url, status: 'downloading', log: [], progress: 0, filename: '' };
  downloadJobs.set(jobId, job);

  let downloadedFilePath = null;

  proc.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').filter(Boolean);
    lines.forEach(line => {
      // --print after_move の出力は絶対パス（他の出力と区別）
      if (line.startsWith(LIBRARY_PATH) && fs.existsSync(line.trim())) {
        downloadedFilePath = line.trim();
        job.filename = path.basename(downloadedFilePath);
        return;
      }
      jobLogPush(job, line);
      const m = line.match(/\[download\]\s+([\d.]+)%/);
      if (m) job.progress = parseFloat(m[1]);
      const fm = line.match(/\[download\] Destination: (.+)/);
      if (fm) job.filename = path.basename(fm[1].trim());
      const mm = line.match(/\[Merger\] Merging formats into "(.+)"/);
      if (mm) job.filename = path.basename(mm[1].trim());
    });
  });
  proc.stderr.on('data', (data) => {
    jobLogPush(job, '[err] ' + data.toString());
  });
  proc.on('close', async (code) => {
    job.status = code === 0 ? 'done' : 'error';
    job.progress = code === 0 ? 100 : job.progress;
    if (code === 0) {
      // --print after_move で特定した実ファイルパスを使用 (#11)
      const targetPath = downloadedFilePath;
      if (targetPath && isSafePath(targetPath) && fs.existsSync(targetPath)) {
        const fileId = generateId(targetPath);
        const meta = loadMeta();
        meta[fileId] = { ...(meta[fileId] || {}), url: job.url };
        saveMeta(meta);
        job.savedIds = [fileId];
        console.log(`  URL saved: ${path.basename(targetPath)} → ${job.url}`);
        // サムネイル生成
        const relPath = path.relative(LIBRARY_PATH, targetPath).replace(/\\/g, '/');
        startBackgroundThumbGen([{ id: fileId, name: path.basename(targetPath), relPath, type: 'video' }]);
      } else {
        // fallback: 差分検出
        const allFiles = await scanDir(LIBRARY_PATH, LIBRARY_PATH);
        const filesAfter = allFiles.filter(f => f.type === 'video');
        startBackgroundThumbGen(filesAfter);
      }
    }
  });
  proc.on('error', (err) => {
    job.status = 'error';
    jobLogPush(job, 'spawn error: ' + err.message);
    console.error('[download] spawn error:', err.message);
  });

  res.json({ jobId });
});

// GET /api/download/:id — ジョブ状態確認
app.get('/api/download/:id', (req, res) => {
  const job = downloadJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json({
    status: job.status,
    progress: job.progress,
    filename: job.filename,
    log: job.log.slice(-5), // 直近5行
  });
});

// DELETE /api/download/:id — キャンセル
app.delete('/api/download/:id', (req, res) => {
  const job = downloadJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  if (job.process && job.status === 'downloading') {
    job.process.kill();
    job.status = 'cancelled';
  }
  res.json({ ok: true });
});

// GET /api/collections
app.get('/api/collections', (req, res) => {
  res.json(settings.collections || []);
});

// POST /api/collections — 新規作成
app.post('/api/collections', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const col = { id: Date.now().toString(36), name, items: [] };
  settings.collections = [...(settings.collections || []), col];
  saveSettings(settings);
  res.json(col);
});

// PUT /api/collections/:id — 更新（名前変更・items並び替え）
app.put('/api/collections/:id', (req, res) => {
  const cols = settings.collections || [];
  const idx = cols.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  cols[idx] = { ...cols[idx], ...req.body, id: req.params.id };
  settings.collections = cols;
  saveSettings(settings);
  res.json(cols[idx]);
});

// DELETE /api/collections/:id — 削除
app.delete('/api/collections/:id', (req, res) => {
  settings.collections = (settings.collections || []).filter(c => c.id !== req.params.id);
  saveSettings(settings);
  res.json({ ok: true });
});

app.get('/api/ping', (_, res) => res.json({ ok: true, library: LIBRARY_PATH }));

// GET /api/settings
app.get('/api/settings', (req, res) => {
  res.json({
    libraryPath: LIBRARY_PATH,
    thumbDir: THUMB_DIR,
  });
});

// PUT /api/settings — ライブラリパス変更
app.put('/api/settings', (req, res) => {
  const { libraryPath } = req.body;
  if (!libraryPath) return res.status(400).json({ error: 'libraryPath required' });
  if (!fs.existsSync(libraryPath)) {
    return res.status(400).json({ error: 'Path does not exist: ' + libraryPath });
  }
  LIBRARY_PATH = libraryPath;
  settings.libraryPath = libraryPath;
  saveSettings(settings);
  // サムネキャッシュはそのまま（別ライブラリのIDは自然と不一致になる）
  res.json({ ok: true, libraryPath: LIBRARY_PATH });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\nvideoref server running on port ${PORT}`);
  console.log(`   Library : ${LIBRARY_PATH}`);
  console.log(`   Thumbs  : ${THUMB_DIR}`);
  // Electronメインプロセスへポートを通知
  if (process.send) process.send({ type: 'ready', port: PORT });
});
