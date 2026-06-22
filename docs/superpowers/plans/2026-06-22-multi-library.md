# Multi-Library Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace videoref's single global library path with a list of switchable libraries, each storing its own tags/notes/ratings/trash/thumbnails/collections inside a `.videoref/` folder next to the media files (matching Eagle's self-contained library model).

**Architecture:** `server.js` keeps one mutable `LIBRARY_PATH` plus a set of path variables (`DATA_PATH`, `THUMB_DIR`, `TRASH_DIR`, `TRASH_PATH`, `COLLECTIONS_PATH`) recomputed by `computeLibraryPaths()` whenever the active library changes. The list of known libraries and which one is active lives in the existing app-wide `settings.json`. A one-time migration moves the current AppData-based metadata/trash/thumbs into the active library's new `.videoref/` folder. New `/api/libraries` REST endpoints manage the list and switching; a sidebar dropdown in the frontend drives them.

**Tech Stack:** Node.js/Express (server.js), Electron IPC (electron-main.js/preload.js), vanilla JS frontend (public/app.js), no test framework present — verification is manual (curl + running the app).

There is no automated test framework in this project. Every task below replaces the "write failing test / run it / make it pass" cycle with a manual verification step using `curl` against the running dev server and/or the Electron UI. Run `npx electron .` from the project root to start the app during verification; stop it with Ctrl+C between tasks if it's holding file locks.

---

### Task 1: Per-library path computation + one-time migration

**Files:**
- Modify: `server.js:1-46` (init block, `DATA_PATH`/`THUMB_DIR`/`TRASH_DIR`/`TRASH_PATH` constants)

- [ ] **Step 1: Replace the fixed path constants and settings bootstrap**

Replace this block (current `server.js:1-46`):

```js
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
```

with:

```js
const express = require('express');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
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
function moveIfExists(src, dest) {
  if (!fs.existsSync(src)) return;
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    if (e.code === 'EXDEV') {
      if (fs.statSync(src).isDirectory()) {
        fs.cpSync(src, dest, { recursive: true });
        fs.rmSync(src, { recursive: true, force: true });
      } else {
        fs.copyFileSync(src, dest);
        fs.unlinkSync(src);
      }
    } else {
      console.error('[migrate] failed to move', src, '->', dest, ':', e.message);
    }
  }
}
function migrateIfNeeded() {
  if (settings.libraries) return;
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
```

- [ ] **Step 2: Manual verification — fresh install path (no prior data)**

Run:
```powershell
cd "D:\自作拡張機能\videoref_dev"
$env:EAGLE_DATA = "$env:TEMP\videoref_test_fresh"
$env:EAGLE_LIBRARY = "$env:TEMP\videoref_test_fresh_lib"
New-Item -ItemType Directory -Force "$env:TEMP\videoref_test_fresh_lib" | Out-Null
node server.js
```
Expected console output includes `移行完了: ライブラリデータを ...\.videoref に移動しました` followed by `videoref server running on port 3000`. Press Ctrl+C to stop.

Then check the migration created the right structure:
```powershell
Get-ChildItem "$env:TEMP\videoref_test_fresh_lib\.videoref"
Get-Content "$env:TEMP\videoref_test_fresh\settings.json"
```
Expected: `.videoref/thumbs`, `.videoref/collections.json` exist; `settings.json` contains a `libraries` array with one entry and `activeLibraryId` set, and no `libraryPath` key.

- [ ] **Step 3: Manual verification — migration of real existing data**

This step simulates an existing user's AppData layout. Do NOT run this against your real `%APPDATA%\videoref` data — use a throwaway copy:
```powershell
$test = "$env:TEMP\videoref_test_migrate"
Remove-Item -Recurse -Force $test -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $test | Out-Null
'{"libraryPath":"D:\\claude\\eaglemodoki"}' | Set-Content -Encoding utf8 "$test\settings.json"
'{"abc123":{"tags":["test"]}}' | Set-Content -Encoding utf8 "$test\metadata.json"
$env:EAGLE_DATA = $test
$env:EAGLE_LIBRARY = "D:\claude\eaglemodoki"
node server.js
```
Expected: console shows the migration line; `D:\claude\eaglemodoki\.videoref\metadata.json` now contains `{"abc123":{"tags":["test"]}}`; `$test\metadata.json` no longer exists (it was moved, not copied).

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "Add per-library .videoref data folder with one-time migration from AppData"
```

---

### Task 2: Per-library collections storage

**Files:**
- Modify: `server.js` collections routes (current lines ~700-731)

- [ ] **Step 1: Add load/save helpers and rewire the four collection routes**

Replace this block:

```js
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
```

with:

```js
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

// POST /api/collections — 新規作成
app.post('/api/collections', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const col = { id: Date.now().toString(36), name, items: [] };
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
```

- [ ] **Step 2: Manual verification**

Start the app (`npx electron .`), open it, click "+" under COLLECTIONS in the sidebar, create one named `test-col`. Then check the file directly:
```powershell
Get-Content "<your library path>\.videoref\collections.json"
```
Expected: JSON array containing `{"id":"...","name":"test-col","items":[]}`. Delete the collection in the UI and re-check the file — the entry should be gone.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "Move collections storage from global settings.json to per-library collections.json"
```

---

### Task 3: `/api/libraries` endpoints + `switchLibrary`

**Files:**
- Modify: `server.js` — add new routes near the existing `/api/settings` routes (current lines ~735-755), and remove the old `PUT /api/settings` handler

- [ ] **Step 1: Add `switchLibrary` and the five `/api/libraries` routes, remove old `PUT /api/settings`**

Replace this block (current `server.js:735-755`):

```js
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
```

with:

```js
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
  thumbQueue.length = 0;
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
```

- [ ] **Step 2: Manual verification with curl**

Start the server (`node server.js` with default env, or `npx electron .`), then in another terminal:
```bash
curl http://127.0.0.1:3000/api/libraries
```
Expected: `{"libraries":[{"id":"lib_...","name":"Library","path":"..."}],"activeLibraryId":"lib_..."}`

```bash
curl -X POST http://127.0.0.1:3000/api/libraries -H "Content-Type: application/json" -d "{\"name\":\"Test Lib\",\"path\":\"C:\\\\Windows\\\\Temp\"}"
```
Expected: `200` with the new library object, and `GET /api/libraries` now shows 2 entries with `activeLibraryId` pointing at the new one.

```bash
curl -X DELETE http://127.0.0.1:3000/api/libraries/<the-only-remaining-id>
```
Expected when only 1 library remains: `400 {"error":"Cannot delete the last library"}`.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "Add /api/libraries CRUD + activate endpoints, remove old PUT /api/settings"
```

---

### Task 4: Native folder picker IPC

**Files:**
- Modify: `electron-main.js:1-10` (imports), add IPC handler near `ipcMain.on('install-update', ...)`
- Modify: `preload.js`

- [ ] **Step 1: Add `dialog` import and IPC handler in electron-main.js**

Change line 1 from:
```js
const { app, BrowserWindow, shell, Menu, ipcMain } = require('electron');
```
to:
```js
const { app, BrowserWindow, shell, Menu, ipcMain, dialog } = require('electron');
```

Then add, right after `ipcMain.on('install-update', () => autoUpdater.quitAndInstall());`:
```js
ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});
```

- [ ] **Step 2: Expose it via preload.js**

Replace `preload.js` entirely:
```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onUpdateStatus: (callback) => ipcRenderer.on('update-status', (_, data) => callback(data)),
  onUpdateError: (callback) => ipcRenderer.on('update-error', (_, data) => callback(data)),
  installUpdate: () => ipcRenderer.send('install-update'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
});
```

- [ ] **Step 3: Manual verification**

Start with `npx electron .`. Open DevTools (the app has no menu, so temporarily add `mainWindow.webContents.openDevTools()` after `createWindow`/inline window creation in `electron-main.js`, or call from the Run skill). In the console run:
```js
await window.electronAPI.pickFolder()
```
Expected: a native Windows folder picker opens; selecting a folder returns its path as a string; clicking Cancel returns `null`. Remove the temporary `openDevTools()` call afterward if you added one.

- [ ] **Step 4: Commit**

```bash
git add electron-main.js preload.js
git commit -m "Add native folder picker IPC for the library switcher UI"
```

---

### Task 5: Sidebar library switcher UI

**Files:**
- Modify: `public/index.html:14-19` (sidebar header)
- Modify: `public/style.css` (append new rules)
- Modify: `public/app.js` (add library state + rendering, remove old settings library-path UI wiring)

- [ ] **Step 1: Replace the static sidebar logo with a switcher button + dropdown**

Replace `public/index.html:14-19`:
```html
      <div id="sidebar-header">
        <div id="app-logo">
          <span class="logo-icon">🦅</span>
          <span class="logo-text">videoref</span>
        </div>
      </div>
```
with:
```html
      <div id="sidebar-header">
        <button id="lib-switcher-btn">
          <span class="logo-icon">🦅</span>
          <span class="logo-text" id="lib-switcher-name">videoref</span>
          <svg class="lib-switcher-caret" viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div id="lib-switcher-dropdown" class="hidden"></div>
      </div>
```

- [ ] **Step 2: Add CSS for the switcher**

Append to `public/style.css`:
```css
#sidebar-header { position: relative; }
#lib-switcher-btn {
  display: flex; align-items: center; gap: 8px; width: 100%;
  background: none; border: none; color: var(--text-1);
  font-size: 14px; font-weight: 600; cursor: pointer; padding: 4px;
  border-radius: var(--radius-sm); text-align: left;
}
#lib-switcher-btn:hover { background: var(--bg-3); }
#lib-switcher-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lib-switcher-caret { width: 12px; height: 12px; color: var(--text-3); flex-shrink: 0; }
#lib-switcher-dropdown {
  position: absolute; left: 12px; right: 12px; top: 100%; margin-top: 4px;
  background: var(--bg-2); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 4px; z-index: 50; max-height: 300px; overflow-y: auto;
}
.lib-switcher-item {
  display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: var(--radius-sm);
  cursor: pointer; font-size: 13px; color: var(--text-2);
}
.lib-switcher-item:hover { background: var(--bg-3); color: var(--text-1); }
.lib-switcher-item.active { color: var(--accent); }
.lib-switcher-item .lib-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lib-switcher-item .lib-remove { color: var(--text-3); padding: 0 4px; }
.lib-switcher-item .lib-remove:hover { color: var(--red); }
#lib-switcher-add {
  margin-top: 4px; padding: 7px 8px; border-top: 1px solid var(--border);
  font-size: 13px; color: var(--accent); cursor: pointer; border-radius: var(--radius-sm);
}
#lib-switcher-add:hover { background: var(--bg-3); }
```

- [ ] **Step 3: Add library state + rendering to app.js**

Add to the `state` object in `public/app.js` (after `lastClickedId: null,`):
```js
  libraries: [],
  activeLibraryId: null,
```

Add these new functions right before the `// ===== CONTROLS & INIT (DOM ready) =====` marker:
```js
// ===== LIBRARY SWITCHER =====
async function loadLibraries() {
  const data = await api('GET', '/libraries');
  state.libraries = data.libraries;
  state.activeLibraryId = data.activeLibraryId;
  const active = state.libraries.find(function(l) { return l.id === state.activeLibraryId; });
  document.getElementById('lib-switcher-name').textContent = active ? active.name : 'videoref';
}

function renderLibSwitcherDropdown() {
  const dd = document.getElementById('lib-switcher-dropdown');
  dd.innerHTML = '';
  state.libraries.forEach(function(lib) {
    const item = document.createElement('div');
    item.className = 'lib-switcher-item' + (lib.id === state.activeLibraryId ? ' active' : '');
    item.innerHTML = '<span class="lib-name">' + lib.name + '</span>' +
      (state.libraries.length > 1 ? '<span class="lib-remove" data-id="' + lib.id + '">✕</span>' : '');
    item.addEventListener('click', async function(e) {
      if (e.target.classList.contains('lib-remove')) {
        e.stopPropagation();
        if (!confirm('"' + lib.name + '" をライブラリ一覧から削除しますか？(ファイルは削除されません)')) return;
        try {
          await api('DELETE', '/libraries/' + lib.id);
          await loadLibraries();
          renderLibSwitcherDropdown();
          await loadFiles();
          showToast(lib.name + ' を一覧から削除しました');
        } catch (err) { showToast('エラー: ' + err.message); }
        return;
      }
      if (lib.id !== state.activeLibraryId) {
        await api('POST', '/libraries/' + lib.id + '/activate');
        await loadLibraries();
        hideLibSwitcherDropdown();
        await loadFiles();
        showToast(lib.name + ' に切り替えました');
      } else {
        hideLibSwitcherDropdown();
      }
    });
    dd.appendChild(item);
  });
  const addRow = document.createElement('div');
  addRow.id = 'lib-switcher-add';
  addRow.textContent = '+ ライブラリを追加';
  addRow.addEventListener('click', async function(e) {
    e.stopPropagation();
    if (!window.electronAPI || !window.electronAPI.pickFolder) { showToast('フォルダ選択はElectron環境でのみ使用できます'); return; }
    const folder = await window.electronAPI.pickFolder();
    if (!folder) return;
    const defaultName = folder.split(/[\\/]/).pop() || 'Library';
    const name = prompt('ライブラリ名', defaultName);
    if (!name) return;
    try {
      await api('POST', '/libraries', { name, path: folder });
      await loadLibraries();
      hideLibSwitcherDropdown();
      await loadFiles();
      showToast(name + ' を追加しました');
    } catch (err) { showToast('エラー: ' + err.message); }
  });
  dd.appendChild(addRow);
}

function hideLibSwitcherDropdown() {
  document.getElementById('lib-switcher-dropdown').classList.add('hidden');
  document.removeEventListener('click', hideLibSwitcherDropdownOnOutsideClick);
}
function hideLibSwitcherDropdownOnOutsideClick(e) {
  const dd = document.getElementById('lib-switcher-dropdown');
  const btn = document.getElementById('lib-switcher-btn');
  if (!dd.contains(e.target) && !btn.contains(e.target)) hideLibSwitcherDropdown();
}

document.getElementById('lib-switcher-btn').addEventListener('click', function(e) {
  e.stopPropagation();
  const dd = document.getElementById('lib-switcher-dropdown');
  if (dd.classList.contains('hidden')) {
    renderLibSwitcherDropdown();
    dd.classList.remove('hidden');
    setTimeout(function() { document.addEventListener('click', hideLibSwitcherDropdownOnOutsideClick); }, 0);
  } else {
    hideLibSwitcherDropdown();
  }
});
```

Then update `initUI()` to load the library list on startup. Find this line near the end of `initUI()`:
```js
// ===== INIT =====
  loadFiles();
} // end initUI
```
and replace with:
```js
// ===== INIT =====
  loadLibraries().then(loadFiles);
} // end initUI
```

- [ ] **Step 4: Manual verification**

Start `npx electron .`. Confirm:
1. The sidebar header shows the active library's name instead of "videoref".
2. Clicking it opens a dropdown listing the library with a checkmark/highlight.
3. Clicking "+ ライブラリを追加" opens the native folder picker, then a name prompt, then switches to it and the gallery reloads with that folder's content.
4. Clicking the ✕ next to a non-active library removes it from the dropdown after confirming (and the underlying folder still exists on disk).
5. With only one library left, no ✕ is shown (since `state.libraries.length > 1` is false).

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/style.css public/app.js
git commit -m "Add sidebar library switcher with add/remove/activate"
```

---

### Task 6: Clean up the old Settings modal library path UI

**Files:**
- Modify: `public/index.html:298-316` (Settings modal Library section)
- Modify: `public/app.js` `openSettings()` and the `settings-path-apply` click handler

- [ ] **Step 1: Simplify the Settings modal markup**

Replace `public/index.html:298-316`:
```html
        <div class="settings-section">
          <div class="settings-section-title">Library</div>
          <div class="settings-row">
            <div class="settings-label">Library Path</div>
            <div class="settings-path-wrap">
              <input id="settings-library-path" type="text" placeholder="D:\path\to\library" spellcheck="false">
              <button id="settings-path-apply" class="primary-btn">Apply</button>
            </div>
            <div id="settings-path-status"></div>
          </div>
          <div class="settings-row">
            <div class="settings-label">Current Path</div>
            <div id="settings-current-path" class="settings-current-path">—</div>
          </div>
          <div class="settings-row">
            <div class="settings-label">Thumbnail Cache</div>
            <div id="settings-thumb-dir" class="settings-current-path">—</div>
          </div>
        </div>
```
with:
```html
        <div class="settings-section">
          <div class="settings-section-title">Library</div>
          <div class="settings-row">
            <div class="settings-label">Current Path</div>
            <div id="settings-current-path" class="settings-current-path">—</div>
          </div>
          <div class="settings-row">
            <div class="settings-label">Thumbnail Cache</div>
            <div id="settings-thumb-dir" class="settings-current-path">—</div>
          </div>
          <div class="settings-row">
            <div class="settings-label">ライブラリの追加・切替はサイドバー上部のライブラリ名から行えます</div>
          </div>
        </div>
```

- [ ] **Step 2: Simplify `openSettings()` in app.js and remove the now-dead apply handler**

Replace this block in `public/app.js`:
```js
async function openSettings() {
  const modal = document.getElementById('settings-modal');
  modal.classList.remove('hidden');
  // 現在の設定を取得
  try {
    const s = await api('GET', '/settings');
    document.getElementById('settings-library-path').value = s.libraryPath || '';
    document.getElementById('settings-current-path').textContent = s.libraryPath || '?';
    document.getElementById('settings-thumb-dir').textContent = s.thumbDir || '?';
    document.getElementById('settings-path-status').textContent = '';
  } catch (e) {}
}
```
with:
```js
async function openSettings() {
  const modal = document.getElementById('settings-modal');
  modal.classList.remove('hidden');
  try {
    const s = await api('GET', '/settings');
    document.getElementById('settings-current-path').textContent = s.libraryPath || '?';
    document.getElementById('settings-thumb-dir').textContent = s.thumbDir || '?';
  } catch (e) {}
}
```

Remove this block entirely (the old "Apply" button handler that called the now-deleted `PUT /api/settings`):
```js
document.getElementById('settings-path-apply').addEventListener('click', async function() {
  const newPath = document.getElementById('settings-library-path').value.trim();
  const status = document.getElementById('settings-path-status');
  if (!newPath) { status.textContent = 'パスを入力してください'; status.className = 'err'; return; }
  status.textContent = '確認中...'; status.className = '';
  try {
    const r = await api('PUT', '/settings', { libraryPath: newPath });
    document.getElementById('settings-current-path').textContent = r.libraryPath;
    status.textContent = '✓ 適用しました。ライブラリをリロードします...';
    status.className = 'ok';
    setTimeout(async () => {
      closeSettings();
      await loadFiles();
    }, 800);
  } catch (e) {
    const msg = e.message || 'エラーが発生しました';
    status.textContent = '✓ ' + msg;
    status.className = 'err';
  }
});
```

- [ ] **Step 3: Manual verification**

Open Settings in the running app. Confirm it shows the current library path and thumbnail cache dir as read-only text, with no input box or Apply button, and no console errors when opening/closing it.

- [ ] **Step 4: Commit**

```bash
git add public/index.html public/app.js
git commit -m "Remove obsolete library-path input from Settings modal (superseded by sidebar switcher)"
```

---

### Task 7: Sync to `dist/win-unpacked` and full regression pass

**Files:** none (verification only)

- [ ] **Step 1: Sync changed files into the unpacked build per `.claude/rules/release.md`**

```powershell
$src = "D:\自作拡張機能\videoref_dev"
$dst = "D:\自作拡張機能\videoref_dev\dist\win-unpacked\resources\app"
if (Test-Path $dst) {
  Copy-Item "$src\server.js" "$dst\server.js" -Force
  Copy-Item "$src\electron-main.js" "$dst\electron-main.js" -Force
  Copy-Item "$src\preload.js" "$dst\preload.js" -Force
  Copy-Item "$src\public\app.js" "$dst\public\app.js" -Force
  Copy-Item "$src\public\index.html" "$dst\public\index.html" -Force
  Copy-Item "$src\public\style.css" "$dst\public\style.css" -Force
}
```
(Skip if `dist/win-unpacked` doesn't exist yet — it's only needed for testing the packaged exe.)

- [ ] **Step 2: Full manual regression pass**

Run `npx electron .` and confirm, in order:
1. App starts, library switcher shows the migrated library's name.
2. Existing tags/ratings/colors/notes on files are still present (proves migration preserved metadata).
3. Existing collections still show in the sidebar (proves collections migration worked).
4. Existing trash items still show in the trash view.
5. Add a second library pointing at a different folder with a couple of test video files; switching to it shows only that folder's files, with no tags bleeding over from the first library.
6. Tag a file in library 2, switch back to library 1 — library 1's files are unaffected.
7. Download a video via the Download modal — still works (proves `downloadJobs`/yt-dlp path unaffected).
8. Set a custom thumbnail frame on a video, reload — thumbnail persists (proves `THUMB_DIR` repointing works end to end).

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "v1.2.0: multi-library support with per-library data isolation"
```

(Bump `package.json` `version` to `1.2.0` first if this is meant to ship as a release — see `.claude/rules/release.md` for the tag+push flow. Do not push or tag without explicit confirmation.)
