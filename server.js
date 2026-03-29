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

// ライブラリパスは設定ファイル > 環境変数 > デフォルト の優先順
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch (e) {}
  return {};
}
function saveSettings(data) {
  fs.mkdirSync(DATA_BASE, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2));
}
let settings = loadSettings();
let LIBRARY_PATH = settings.libraryPath || process.env.EAGLE_LIBRARY || 'D:\\claude\\eaglemodoki';

const VIDEO_EXTS = ['.mp4', '.mov', '.avi', '.webm', '.mkv', '.flv', '.wmv', '.m4v', '.ts', '.mts'];
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.tiff'];
const AUDIO_EXTS = ['.mp3', '.wav', '.aac', '.flac', '.ogg', '.m4a'];

// サムネイルキャッシュ
const thumbCache = new Set();
// 生成中IDセット
const generating = new Set();
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
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf-8');
}
function generateId(filePath) {
  const rel = path.relative(LIBRARY_PATH, filePath).replace(/\\/g, '/');
  return Buffer.from(rel).toString('base64url');
}
function decodeId(id) {
  try {
    const rel = Buffer.from(id, 'base64url').toString('utf-8');
    return path.join(LIBRARY_PATH, rel);
  } catch (e) { return null; }
}

// ===== THUMBNAIL =====
function thumbPath(id) {
  return path.join(THUMB_DIR, id + '.jpg');
}

function generateThumbnail(id, filePath) {
  return new Promise((resolve) => {
    if (thumbCache.has(id)) { resolve(true); return; }
    if (generating.has(id)) { resolve(false); return; }

    generating.add(id);
    const out = thumbPath(id);

    // ffprobe で動画長さを取得し、10%地点をシーク（短い動画は3秒固定）
    const probe = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ]);
    let durStr = '';
    probe.stdout.on('data', d => durStr += d.toString());
    probe.on('close', () => {
      const dur = parseFloat(durStr) || 10;
      const seekSec = Math.min(Math.max(dur * 0.1, 0.5), 10).toFixed(2);

      const ff = spawn('ffmpeg', [
        '-ss', seekSec,
        '-i', filePath,
        '-frames:v', '1',
        '-vf', 'scale=320:-2',
        '-q:v', '3',
        '-y',
        out
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
    });
    probe.on('error', () => {
      // ffprobeなしでも3秒でフォールバック
      generating.delete(id);
      generateFallback(id, filePath, out, resolve);
    });
  });
}

function generateFallback(id, filePath, out, resolve) {
  generating.add(id);
  const ff = spawn('ffmpeg', [
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
  if (thumbCache.has(id) || generating.has(id)) return;
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

// ===== SCAN =====
function scanDir(dirPath, baseLib) {
  const results = [];
  let entries;
  try { entries = fs.readdirSync(dirPath); } catch (e) { return results; }

  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const fullPath = path.join(dirPath, name);
    let stat;
    try { stat = fs.statSync(fullPath); } catch (e) { continue; }

    if (stat.isDirectory()) {
      results.push(...scanDir(fullPath, baseLib));
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

// フォルダ以下に動画ファイルが1件でも存在するか再帰チェック
function hasVideoFiles(dirPath) {
  let entries;
  try { entries = fs.readdirSync(dirPath); } catch (e) { return false; }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const full = path.join(dirPath, entry);
    try {
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        if (hasVideoFiles(full)) return true;
      } else {
        if (VIDEO_EXTS.includes(path.extname(entry).toLowerCase())) return true;
      }
    } catch (e) {}
  }
  return false;
}

function getFolderTree(dirPath, baseLib) {
  const name = dirPath === baseLib ? 'Library' : path.basename(dirPath);
  const rel = path.relative(baseLib, dirPath).replace(/\\/g, '/') || '.';
  const node = { name, rel, children: [] };
  let entries;
  try { entries = fs.readdirSync(dirPath); } catch (e) { return node; }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const full = path.join(dirPath, entry);
    try {
      if (fs.statSync(full).isDirectory()) {
        // 動画ファイルを持つフォルダだけ追加
        if (hasVideoFiles(full)) {
          node.children.push(getFolderTree(full, baseLib));
        }
      }
    } catch (e) {}
  }
  return node;
}

// ===== API =====

// GET /api/files
app.get('/api/files', (req, res) => {
  if (!fs.existsSync(LIBRARY_PATH)) return res.json([]);
  const files = scanDir(LIBRARY_PATH, LIBRARY_PATH);
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
app.get('/api/folders', (req, res) => {
  if (!fs.existsSync(LIBRARY_PATH)) return res.json({ name: 'Library', rel: '.', children: [] });
  res.json(getFolderTree(LIBRARY_PATH, LIBRARY_PATH));
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

// DELETE /api/files/:id
app.delete('/api/files/:id', (req, res) => {
  const filePath = decodeId(req.params.id);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Not found');
  fs.unlinkSync(filePath);
  // サムネイルも削除
  const tp = thumbPath(req.params.id);
  if (fs.existsSync(tp)) fs.unlinkSync(tp);
  thumbCache.delete(req.params.id);
  const meta = loadMeta();
  delete meta[req.params.id];
  saveMeta(meta);
  res.json({ ok: true });
});

// PUT /api/files/:id/meta — url フィールドも含めて保存
// (既存のmeta PUTルートで url も受け取れるよう拡張済み — bodyに含まれれば保存される)

// GET /api/frame/:id?t=秒 — 指定時刻のフレームをJPEGで返す
app.get('/api/frame/:id', (req, res) => {
  const filePath = decodeId(req.params.id);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Not found');
  const t = parseFloat(req.query.t) || 0;
  const ff = spawn('ffmpeg', [
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
  const ff = spawn('ffmpeg', [
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

// yt-dlpのパスを解決
const YT_DLP_PATHS = [
  'yt-dlp',
  'C:\\Users\\tomoj\\AppData\\Local\\Microsoft\\WinGet\\Packages\\yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe\\yt-dlp.exe',
];
function getYtDlpPath() {
  for (const p of YT_DLP_PATHS) {
    try {
      const absPath = p.includes('\\') ? p : require('child_process').execSync('where yt-dlp 2>nul', { encoding: 'utf-8' }).trim().split('\n')[0];
      if (fs.existsSync(absPath || p)) return absPath || p;
    } catch (e) {}
  }
  return 'yt-dlp';
}

// ダウンロード中のジョブ管理
const downloadJobs = new Map(); // id -> { process, url, status, log }

// POST /api/download — ダウンロード開始
app.post('/api/download', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const ytdlp = getYtDlpPath();
  const args = [
    url,
    '--output', path.join(LIBRARY_PATH, '%(title)s.%(ext)s'),
    '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--progress',
    '--newline',
    '--no-warnings',
  ];

  const proc = spawn(ytdlp, args, {
    env: { ...process.env, PATH: process.env.PATH },
  });

  const job = { process: proc, url, status: 'downloading', log: [], progress: 0, filename: '' };
  downloadJobs.set(jobId, job);

  // ダウンロード開始前のファイル一覧を記録
  const filesBefore = new Set(
    scanDir(LIBRARY_PATH, LIBRARY_PATH).map(f => f.relPath)
  );

  proc.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').filter(Boolean);
    lines.forEach(line => {
      job.log.push(line);
      // 進捗パース: [download]  45.2% of ...
      const m = line.match(/\[download\]\s+([\d.]+)%/);
      if (m) job.progress = parseFloat(m[1]);
      // ファイル名パース
      const fm = line.match(/\[download\] Destination: (.+)/);
      if (fm) job.filename = path.basename(fm[1]);
      const mm = line.match(/\[Merger\] Merging formats into "(.+)"/);
      if (mm) job.filename = path.basename(mm[1]);
    });
  });
  proc.stderr.on('data', (data) => {
    job.log.push('[err] ' + data.toString());
  });
  proc.on('close', (code) => {
    job.status = code === 0 ? 'done' : 'error';
    job.progress = code === 0 ? 100 : job.progress;
    if (code === 0) {
      const filesAfter = scanDir(LIBRARY_PATH, LIBRARY_PATH).filter(f => f.type === 'video');
      startBackgroundThumbGen(filesAfter);

      // ダウンロード前に存在しなかった新しいファイルを特定
      const newFiles = filesAfter.filter(f => !filesBefore.has(f.relPath));
      if (newFiles.length > 0) {
        const meta = loadMeta();
        newFiles.forEach(f => {
          meta[f.id] = { ...(meta[f.id] || {}), url: job.url };
          console.log(`  URL saved: ${f.name} → ${job.url}`);
        });
        saveMeta(meta);
        job.savedIds = newFiles.map(f => f.id);
      }
    }
  });
  proc.on('error', (err) => {
    job.status = 'error';
    job.log.push('spawn error: ' + err.message);
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

app.listen(PORT, () => {
  console.log(`\nEagle Modoki server running on port ${PORT}`);
  console.log(`   Library : ${LIBRARY_PATH}`);
  console.log(`   Thumbs  : ${THUMB_DIR}`);
  // Electronメインプロセスへポートを通知
  if (process.send) process.send({ type: 'ready', port: PORT });
});
