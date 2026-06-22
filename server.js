const express = require('express');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
const PORT = parseInt(process.env.EAGLE_PORT || '3000', 10);
const DATA_BASE = process.env.EAGLE_DATA || path.join(__dirname, '.data');
const SETTINGS_PATH = path.join(DATA_BASE, 'settings.json');

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

function genLibId() {
  return 'lib_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 旧形式（settings.libraryPath 単一文字列）からの1回限りの移行
// ドライブをまたぐ場合(EXDEV)は1件ずつコピーし、失敗したファイルがあっても
// 全体を止めない。1件でも失敗があれば元データは削除せず残す（安全側）。
function moveIfExists(src, dest) {
  if (!fs.existsSync(src)) return;
  try {
    fs.renameSync(src, dest);
    return;
  } catch (e) {
    if (e.code !== 'EXDEV') {
      console.error('[migrate] failed to move', src, '->', dest, ':', e.message);
      return;
    }
  }
  try {
    if (fs.statSync(src).isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      let failures = 0;
      for (const entry of fs.readdirSync(src)) {
        try {
          fs.copyFileSync(path.join(src, entry), path.join(dest, entry));
        } catch (e2) {
          failures++;
          console.error('[migrate] failed to copy', entry, ':', e2.message);
        }
      }
      if (failures === 0) {
        fs.rmSync(src, { recursive: true, force: true });
      } else {
        console.error(`[migrate] ${failures} 件のコピーに失敗したため、元データ ${src} は削除せず残します`);
      }
    } else {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    }
  } catch (e3) {
    console.error('[migrate] failed to migrate', src, '->', dest, ':', e3.message);
  }
}
function migrateIfNeeded() {
  if (settings.libraries) return;
  try {
    const oldLibraryPath = settings.libraryPath || process.env.EAGLE_LIBRARY || 'D:\\claude\\eaglemodoki';
    const newDir = path.join(oldLibraryPath, '.videoref');
    fs.mkdirSync(newDir, { recursive: true });
    moveIfExists(path.join(DATA_BASE, 'metadata.json'), path.join(newDir, 'metadata.json'));
    moveIfExists(path.join(DATA_BASE, 'trash.json'), path.join(newDir, 'trash.json'));
    moveIfExists(path.join(DATA_BASE, 'trash'), path.join(newDir, 'trash'));
    moveIfExists(path.join(DATA_BASE, 'thumbs'), path.join(newDir, 'thumbs'));
    fs.writeFileSync(path.join(newDir, 'collections.json'), JSON.stringify(settings.collections || [], null, 2), 'utf-8');

    const id = genLibId();
    settings.libraries = [{ id, name: 'Library', path: oldLibraryPath }];
    settings.activeLibraryId = id;
    delete settings.libraryPath;
    delete settings.collections;
    saveSettings(settings);
    console.log(`   移行完了: ライブラリデータを ${newDir} に移動しました`);
  } catch (e) {
    // 移行に失敗してもサーバー起動を止めない。settings.librariesが未設定のまま
    // 残るため、次回起動時にも移行が再試行される（moveIfExistsは既に移動済みの
    // ファイルがあれば existsSync チェックで素通りするため再実行は安全）。
    console.error('[migrate] migration failed, server will start without multi-library data:', e.message);
  }
}
migrateIfNeeded();

function getActiveLibrary() {
  const libs = settings.libraries || [];
  return libs.find(l => l.id === settings.activeLibraryId) || libs[0];
}
let LIBRARY_PATH = getActiveLibrary() ? getActiveLibrary().path : (process.env.EAGLE_LIBRARY || 'D:\\claude\\eaglemodoki');

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

// ===== ライブラリ依存パスの計算 =====
let DATA_PATH, THUMB_DIR, TRASH_DIR, TRASH_PATH, COLLECTIONS_PATH;
function computeLibraryPaths(libPath) {
  const dir = path.join(libPath, '.videoref');
  DATA_PATH = path.join(dir, 'metadata.json');
  THUMB_DIR = path.join(dir, 'thumbs');
  TRASH_DIR = path.join(dir, 'trash');
  TRASH_PATH = path.join(dir, 'trash.json');
  COLLECTIONS_PATH = path.join(dir, 'collections.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(THUMB_DIR, { recursive: true });
}

// ===== INIT =====
computeLibraryPaths(LIBRARY_PATH);

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

// PUT /api/batch/meta — 一括メタデータ更新
app.put('/api/batch/meta', (req, res) => {
  const { ids, tags, rating, color } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids required' });
  const meta = loadMeta();
  let updated = 0;
  for (const id of ids) {
    if (!meta[id]) meta[id] = {};
    if (Array.isArray(tags)) {
      // Merge tags (add new ones, don't remove existing)
      const existing = meta[id].tags || [];
      const merged = [...new Set([...existing, ...tags])];
      meta[id].tags = merged;
    }
    if (typeof rating === 'number') meta[id].rating = rating;
    if (color !== undefined) meta[id].color = color;
    updated++;
  }
  saveMeta(meta);
  res.json({ ok: true, updated });
});

// DELETE /api/batch/files — 一括ゴミ箱移動
app.delete('/api/batch/files', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids required' });
  fs.mkdirSync(TRASH_DIR, { recursive: true });
  const meta = loadMeta();
  const trash = loadTrash();
  let deleted = 0;
  for (const id of ids) {
    const filePath = decodeId(id);
    if (!filePath || !fs.existsSync(filePath)) continue;
    const destName = id + '_' + path.basename(filePath);
    try {
      fs.renameSync(filePath, path.join(TRASH_DIR, destName));
      trash.push({ id, name: path.basename(filePath), destName, deletedAt: new Date().toISOString() });
      const tp = thumbPath(id);
      if (fs.existsSync(tp)) fs.unlinkSync(tp);
      thumbCache.delete(id);
      delete meta[id];
      deleted++;
    } catch (e) { console.error('[batch-delete]', e.message); }
  }
  saveMeta(meta);
  saveTrash(trash);
  res.json({ ok: true, deleted });
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

// POST /api/trash/:id/restore — ゴミ箱からファイルを復元
app.post('/api/trash/:id/restore', (req, res) => {
  const id = req.params.id;
  const trash = loadTrash();
  const idx = trash.findIndex(item => item.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not in trash' });
  const item = trash[idx];
  const trashFile = path.join(TRASH_DIR, item.destName);
  if (!fs.existsSync(trashFile)) return res.status(404).json({ error: 'File not found in trash' });
  const originalPath = decodeId(id);
  if (!originalPath) return res.status(400).json({ error: 'Cannot resolve original path' });
  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(originalPath), { recursive: true });
  fs.renameSync(trashFile, originalPath);
  trash.splice(idx, 1);
  saveTrash(trash);
  res.json({ ok: true });
});

// DELETE /api/trash/:id — ゴミ箱から1件完全削除
app.delete('/api/trash/:id', (req, res) => {
  const id = req.params.id;
  const trash = loadTrash();
  const idx = trash.findIndex(item => item.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not in trash' });
  const item = trash[idx];
  const trashFile = path.join(TRASH_DIR, item.destName);
  if (fs.existsSync(trashFile)) fs.unlinkSync(trashFile);
  trash.splice(idx, 1);
  saveTrash(trash);
  res.json({ ok: true });
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
  job.log.push(line);
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

  // ダウンロード開始時点のライブラリをスナップショット（完了時にライブラリが
  // 切り替わっていても、保存先と無関係なライブラリのmetadata.jsonを汚さないため）
  const jobLibraryPath = LIBRARY_PATH;
  const jobDataPath = DATA_PATH;

  // 安全なテンプレ: IDベースで保存 → パストラバーサル防止 (#3)
  // --print after_move で完了後の実ファイルパスを取得 (#11)
  const args = [
    url,
    '--output', path.join(jobLibraryPath, '%(id)s.%(ext)s'),
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
      if (line.startsWith(jobLibraryPath) && fs.existsSync(line.trim())) {
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
      // 完了処理は常にダウンロード開始時のライブラリ(jobLibraryPath/jobDataPath)を
      // 対象にする。途中でライブラリが切り替わっていても、現在アクティブな
      // 別ライブラリのmetadata.jsonに書き込んでしまわないようにするため。
      const targetPath = downloadedFilePath;
      const normalizedTarget = targetPath && path.normalize(targetPath);
      const normalizedBase = path.normalize(jobLibraryPath);
      const isSafe = normalizedTarget && (normalizedTarget.startsWith(normalizedBase + path.sep) || normalizedTarget === normalizedBase);
      if (targetPath && isSafe && fs.existsSync(targetPath)) {
        const rel = path.relative(jobLibraryPath, targetPath).replace(/\\/g, '/');
        const fileId = Buffer.from(rel).toString('base64url');
        let meta = {};
        try {
          if (fs.existsSync(jobDataPath)) meta = JSON.parse(fs.readFileSync(jobDataPath, 'utf-8'));
        } catch (e) {}
        meta[fileId] = { ...(meta[fileId] || {}), url: job.url };
        const tmp = jobDataPath + '.tmp';
        try {
          fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf-8');
          fs.renameSync(tmp, jobDataPath);
        } catch (e) {
          console.error('[download] failed to save metadata:', e.message);
          try { fs.unlinkSync(tmp); } catch (_) {}
        }
        job.savedIds = [fileId];
        console.log(`  URL saved: ${path.basename(targetPath)} → ${job.url}`);
        // サムネイル生成（ダウンロード中にライブラリが切り替わっていた場合は
        // スキップ。そのライブラリを再度開いた際に /api/thumb で遅延生成される）
        if (jobLibraryPath === LIBRARY_PATH) {
          startBackgroundThumbGen([{ id: fileId, name: path.basename(targetPath), relPath: rel, type: 'video' }]);
        }
      } else if (jobLibraryPath === LIBRARY_PATH) {
        // fallback: 差分検出（ライブラリが切り替わっている場合は対象外なので行わない）
        const allFiles = await scanDir(jobLibraryPath, jobLibraryPath);
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

// ===== IMPORT（ドラッグ&ドロップ取り込み） =====
const importJobs = new Map(); // id -> { status, total, done, errors, importedIds }
const IMPORT_EXTS = [...VIDEO_EXTS, ...IMAGE_EXTS, ...AUDIO_EXTS];

// POST /api/import — D&Dで受け取ったローカルファイルをライブラリへコピー/移動
app.post('/api/import', (req, res) => {
  const { paths, mode } = req.body;
  if (!Array.isArray(paths) || paths.length === 0) return res.status(400).json({ error: 'paths required' });
  if (mode !== 'copy' && mode !== 'move') return res.status(400).json({ error: 'mode must be copy or move' });

  // インポート開始時点のライブラリをスナップショット（途中でライブラリが
  // 切り替わっても、現在アクティブな別ライブラリへ取り込んでしまわないため）
  const jobLibraryPath = LIBRARY_PATH;

  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const job = { status: 'running', total: paths.length, done: 0, errors: [], importedIds: [] };
  importJobs.set(jobId, job);
  res.json({ jobId });

  (async () => {
    for (const srcPath of paths) {
      try {
        const ext = path.extname(srcPath).toLowerCase();
        if (!IMPORT_EXTS.includes(ext)) {
          job.errors.push(path.basename(srcPath) + ': 対応していない形式です');
          job.done++;
          continue;
        }
        if (!fs.existsSync(srcPath)) {
          job.errors.push(path.basename(srcPath) + ': ファイルが見つかりません');
          job.done++;
          continue;
        }
        const baseName = path.basename(srcPath, ext);
        let destName = baseName + ext;
        let destPath = path.join(jobLibraryPath, destName);
        let n = 1;
        while (fs.existsSync(destPath)) {
          destName = `${baseName} (${n})${ext}`;
          destPath = path.join(jobLibraryPath, destName);
          n++;
        }
        if (mode === 'move') {
          try {
            fs.renameSync(srcPath, destPath);
          } catch (e) {
            if (e.code === 'EXDEV') {
              fs.copyFileSync(srcPath, destPath);
              fs.unlinkSync(srcPath);
            } else {
              throw e;
            }
          }
        } else {
          fs.copyFileSync(srcPath, destPath);
        }
        const rel = path.relative(jobLibraryPath, destPath).replace(/\\/g, '/');
        job.importedIds.push(Buffer.from(rel).toString('base64url'));
      } catch (e) {
        job.errors.push(path.basename(srcPath) + ': ' + e.message);
      }
      job.done++;
    }
    job.status = 'done';
    // インポート中にライブラリが切り替わっていた場合、サムネ生成は対象外
    // （そのライブラリを開いた際に /api/thumb で遅延生成される）
    if (jobLibraryPath === LIBRARY_PATH) {
      const allFiles = await scanDir(jobLibraryPath, jobLibraryPath);
      startBackgroundThumbGen(allFiles.filter(f => f.type === 'video'));
    }
  })();
});

// GET /api/import/:id — 取り込み進行状況
app.get('/api/import/:id', (req, res) => {
  const job = importJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(job);
});

// ===== 重複検出（Eagle同様: 完全一致のみ。サイズ→SHA-256で確定） =====
let duplicateScanJob = null; // { status: 'running'|'done'|'error', total, done }
let lastDuplicateGroups = []; // [{ hash, size, ids: [...] }]
let lastDuplicateLibraryPath = null; // スキャン時点のライブラリ（切替後は無効化するため）

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// POST /api/duplicates/scan — スキャン開始（既に実行中なら新規開始しない）
app.post('/api/duplicates/scan', (req, res) => {
  if (duplicateScanJob && duplicateScanJob.status === 'running') {
    return res.json({ ok: true, alreadyRunning: true });
  }
  const job = { status: 'running', total: 0, done: 0 };
  duplicateScanJob = job;
  res.json({ ok: true });

  const scanLibraryPath = LIBRARY_PATH;
  (async () => {
    try {
      const allFiles = await scanDir(scanLibraryPath, scanLibraryPath);
      const bySize = new Map();
      for (const f of allFiles) {
        if (!bySize.has(f.size)) bySize.set(f.size, []);
        bySize.get(f.size).push(f);
      }
      const candidates = [...bySize.values()].filter((g) => g.length > 1);
      job.total = candidates.reduce((sum, g) => sum + g.length, 0);

      const byHash = new Map();
      for (const group of candidates) {
        for (const f of group) {
          try {
            const fullPath = path.join(scanLibraryPath, f.relPath);
            const hash = await hashFile(fullPath);
            const key = f.size + '_' + hash;
            if (!byHash.has(key)) byHash.set(key, { hash, size: f.size, ids: [] });
            byHash.get(key).ids.push(f.id);
          } catch (e) { console.error('[duplicates] hash error:', e.message); }
          job.done++;
        }
      }
      // スキャン中にライブラリが切り替わっていたら結果を捨てる
      if (scanLibraryPath === LIBRARY_PATH) {
        lastDuplicateGroups = [...byHash.values()].filter((g) => g.ids.length > 1);
        lastDuplicateLibraryPath = scanLibraryPath;
      }
      job.status = 'done';
    } catch (e) {
      console.error('[duplicates] scan failed:', e.message);
      job.status = 'error';
    }
  })();
});

// GET /api/duplicates/scan — 進行状況
app.get('/api/duplicates/scan', (req, res) => {
  res.json(duplicateScanJob || { status: 'idle', total: 0, done: 0 });
});

// GET /api/duplicates — 直近のスキャン結果（グループ化済み）
app.get('/api/duplicates', (req, res) => {
  if (lastDuplicateLibraryPath !== LIBRARY_PATH) return res.json([]);
  const meta = loadMeta();
  const groups = lastDuplicateGroups
    .map((g) => ({
      hash: g.hash,
      size: g.size,
      files: g.ids
        .map((id) => {
          const filePath = decodeId(id);
          if (!filePath || !fs.existsSync(filePath)) return null;
          return {
            id,
            name: path.basename(filePath),
            relPath: path.relative(LIBRARY_PATH, filePath).replace(/\\/g, '/'),
            tags: meta[id]?.tags || [],
            rating: meta[id]?.rating || 0,
          };
        })
        .filter(Boolean),
    }))
    .filter((g) => g.files.length > 1);
  res.json(groups);
});

// POST /api/duplicates/merge — keepIdを残し、removeIdsをゴミ箱へ移動。メタデータはマージして保持
app.post('/api/duplicates/merge', (req, res) => {
  const { keepId, removeIds } = req.body;
  if (!keepId || !Array.isArray(removeIds) || removeIds.length === 0) {
    return res.status(400).json({ error: 'keepId and removeIds required' });
  }
  const meta = loadMeta();
  const trash = loadTrash();
  fs.mkdirSync(TRASH_DIR, { recursive: true });
  const keepMeta = meta[keepId] || {};
  const mergedTags = new Set(keepMeta.tags || []);
  let mergedRating = keepMeta.rating || 0;
  let mergedNote = keepMeta.note || '';
  let mergedColor = keepMeta.color || null;
  let mergedUrl = keepMeta.url || '';
  let removed = 0;
  for (const id of removeIds) {
    if (id === keepId) continue;
    const m = meta[id] || {};
    (m.tags || []).forEach((t) => mergedTags.add(t));
    if ((m.rating || 0) > mergedRating) mergedRating = m.rating;
    if (!mergedNote && m.note) mergedNote = m.note;
    if (!mergedColor && m.color) mergedColor = m.color;
    if (!mergedUrl && m.url) mergedUrl = m.url;

    const filePath = decodeId(id);
    if (filePath && fs.existsSync(filePath)) {
      const destName = id + '_' + path.basename(filePath);
      try {
        fs.renameSync(filePath, path.join(TRASH_DIR, destName));
        trash.push({ id, name: path.basename(filePath), destName, deletedAt: new Date().toISOString() });
        removed++;
      } catch (e) { console.error('[duplicates merge] move failed:', e.message); }
    }
    const tp = thumbPath(id);
    if (fs.existsSync(tp)) fs.unlinkSync(tp);
    thumbCache.delete(id);
    delete meta[id];
  }
  meta[keepId] = { ...keepMeta, tags: [...mergedTags], rating: mergedRating, note: mergedNote, color: mergedColor, url: mergedUrl };
  saveMeta(meta);
  saveTrash(trash);
  // マージ済みグループをキャッシュから更新
  lastDuplicateGroups = lastDuplicateGroups
    .map((g) => ({ ...g, ids: g.ids.filter((id) => !removeIds.includes(id)) }))
    .filter((g) => g.ids.length > 1);
  res.json({ ok: true, removed });
});

function loadCollections() {
  try {
    if (fs.existsSync(COLLECTIONS_PATH)) return JSON.parse(fs.readFileSync(COLLECTIONS_PATH, 'utf-8'));
  } catch (e) { console.error('[loadCollections] error:', e.message); }
  return [];
}
function saveCollections(data) {
  const tmp = COLLECTIONS_PATH + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, COLLECTIONS_PATH);
  } catch (e) {
    console.error('[saveCollections] error:', e.message);
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

// GET /api/collections
app.get('/api/collections', (req, res) => {
  res.json(loadCollections());
});

// POST /api/collections — 新規作成（通常コレクション or スマートフォルダ）
app.post('/api/collections', (req, res) => {
  const { name, type, rules } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const col = type === 'smart'
    ? { id: Date.now().toString(36), name, type: 'smart', rules: rules || {} }
    : { id: Date.now().toString(36), name, items: [] };
  const cols = [...loadCollections(), col];
  saveCollections(cols);
  res.json(col);
});

// PUT /api/collections/:id — 更新（名前変更・items並び替え）
app.put('/api/collections/:id', (req, res) => {
  const cols = loadCollections();
  const idx = cols.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  cols[idx] = { ...cols[idx], ...req.body, id: req.params.id };
  saveCollections(cols);
  res.json(cols[idx]);
});

// DELETE /api/collections/:id — 削除
app.delete('/api/collections/:id', (req, res) => {
  const cols = loadCollections().filter(c => c.id !== req.params.id);
  saveCollections(cols);
  res.json({ ok: true });
});

app.get('/api/ping', (_, res) => res.json({ ok: true, library: LIBRARY_PATH }));

// GET /api/settings — 表示用（現在のライブラリ情報）
app.get('/api/settings', (req, res) => {
  res.json({
    libraryPath: LIBRARY_PATH,
    thumbDir: THUMB_DIR,
  });
});

function switchLibrary(id) {
  const lib = (settings.libraries || []).find(l => l.id === id);
  if (!lib) return false;
  LIBRARY_PATH = lib.path;
  computeLibraryPaths(LIBRARY_PATH);
  thumbCache.clear();
  try {
    for (const f of fs.readdirSync(THUMB_DIR)) {
      if (f.endsWith('.jpg')) thumbCache.add(f.replace('.jpg', ''));
    }
  } catch (e) {}
  generating.clear();
  // キュー中の各リクエストのPromiseを解決してから空にする
  // （解決せずに空にすると、待機中の/api/thumbリクエストが永久にハングする）
  while (thumbQueue.length > 0) {
    const { resolve } = thumbQueue.shift();
    resolve(false);
  }
  // 重複検出結果は別ライブラリのIDを指してしまうため無効化する
  lastDuplicateGroups = [];
  lastDuplicateLibraryPath = null;
  settings.activeLibraryId = id;
  saveSettings(settings);
  return true;
}

// GET /api/libraries
app.get('/api/libraries', (req, res) => {
  res.json({
    libraries: (settings.libraries || []).map(l => ({ id: l.id, name: l.name, path: l.path })),
    activeLibraryId: settings.activeLibraryId,
  });
});

// POST /api/libraries — 新規ライブラリ追加（追加後そのライブラリへ自動切替）
app.post('/api/libraries', (req, res) => {
  const { name, path: libPath } = req.body;
  if (!name || !libPath) return res.status(400).json({ error: 'name and path required' });
  if (!fs.existsSync(libPath) || !fs.statSync(libPath).isDirectory()) {
    return res.status(400).json({ error: 'Path does not exist or is not a directory: ' + libPath });
  }
  const normalized = path.normalize(libPath);
  if ((settings.libraries || []).some(l => path.normalize(l.path) === normalized)) {
    return res.status(400).json({ error: 'This path is already registered as a library' });
  }
  const id = genLibId();
  const lib = { id, name, path: libPath };
  settings.libraries = [...(settings.libraries || []), lib];
  saveSettings(settings);
  switchLibrary(id);
  res.json(lib);
});

// PUT /api/libraries/:id — 名前変更のみ
app.put('/api/libraries/:id', (req, res) => {
  const { name } = req.body;
  const libs = settings.libraries || [];
  const idx = libs.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  if (name) libs[idx] = { ...libs[idx], name };
  settings.libraries = libs;
  saveSettings(settings);
  res.json(libs[idx]);
});

// DELETE /api/libraries/:id — リストから削除（ファイルは削除しない）
app.delete('/api/libraries/:id', (req, res) => {
  const libs = settings.libraries || [];
  if (libs.length <= 1) return res.status(400).json({ error: 'Cannot delete the last library' });
  const idx = libs.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const wasActive = settings.activeLibraryId === req.params.id;
  settings.libraries = libs.filter(l => l.id !== req.params.id);
  saveSettings(settings);
  if (wasActive) switchLibrary(settings.libraries[0].id);
  res.json({ ok: true });
});

// POST /api/libraries/:id/activate — ライブラリ切替
app.post('/api/libraries/:id/activate', (req, res) => {
  const ok = switchLibrary(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true, libraryPath: LIBRARY_PATH });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\nvideoref server running on port ${PORT}`);
  console.log(`   Library : ${LIBRARY_PATH}`);
  console.log(`   Thumbs  : ${THUMB_DIR}`);
  // Electronメインプロセスへポートを通知
  if (process.send) process.send({ type: 'ready', port: PORT });
});
