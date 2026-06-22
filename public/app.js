// ===== STATE =====
const state = {
  files: [],
  filtered: [],
  selected: null,
  view: 'grid',
  sort: 'mtime-desc',
  search: '',
  activeFolder: null,
  activeTag: null,
  activeNav: 'all',
  activeCollection: null,
  collections: [],
  thumbSize: 200,
  inspectorMeta: { tags: [], note: '', color: null, rating: 0, url: '' },
  ctxMenu: null,
  thumbPollTimer: null,
  selectedIds: new Set(),
  lastClickedId: null,
  libraries: [],
  activeLibraryId: null,
};

const COLOR_MAP = {
  red: '#ff5f57', orange: '#ff9500', yellow: '#febc2e',
  green: '#28c840', cyan: '#00c7be', blue: '#4a8fff',
  purple: '#bf5af2', pink: '#ff375f', gray: '#8e8e93',
};

// ===== UTILS =====
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
function formatDate(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

// ===== API =====
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch('/api' + path, opts);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

// ===== LOAD FILES =====
async function loadFiles() {
  document.getElementById('loading-state').classList.remove('hidden');
  document.getElementById('gallery').innerHTML = '';
  stopThumbPoll();
  try {
    state.files = await api('GET', '/files');
    document.getElementById('file-count').textContent = state.files.length;
  } catch (e) {
    console.error(e);
  }
  document.getElementById('loading-state').classList.add('hidden');
  await loadFolders();
  await loadTags();
  try { await loadCollections(); } catch(e) { console.warn('loadCollections error:', e); }
  applyFilters();
  startThumbPoll();
}

// ===== THUMBNAIL POLLING =====
function startThumbPoll() {
  stopThumbPoll();
  state.thumbPollTimer = setInterval(async () => {
    const pending = document.querySelectorAll('.card[data-thumb-pending="1"]');
    if (pending.length === 0) { stopThumbPoll(); return; }
    for (const card of pending) {
      const id = card.dataset.id;
      const file = state.files.find(f => f.id === id);
      if (!file || file.type !== 'video') continue;
      try {
        const r = await fetch('/api/thumb/' + id, { method: 'HEAD' });
        if (r.ok) {
          const el = card.querySelector('.card-video-thumb');
          if (el && el.tagName === 'VIDEO') {
            const newImg = document.createElement('img');
            newImg.className = 'card-video-thumb';
            newImg.src = '/api/thumb/' + id + '?t=' + Date.now();
            newImg.loading = 'lazy';
            newImg.alt = file.name;
            el.replaceWith(newImg);
            card.dataset.thumbPending = '0';
            attachHoverVideo(card, file);
          }
          file.hasThumbnail = true;
        }
      } catch (e) {}
    }
  }, 1500);
}

function stopThumbPoll() {
  if (state.thumbPollTimer) { clearInterval(state.thumbPollTimer); state.thumbPollTimer = null; }
}

// ===== LOAD FOLDERS / TAGS =====
async function loadFolders() {
  const tree = await api('GET', '/folders');
  renderFolderTree(tree, document.getElementById('folder-tree'), 0);
}

async function loadTags() {
  const tags = await api('GET', '/tags');
  const el = document.getElementById('tag-list');
  el.innerHTML = '';
  tags.forEach(tag => {
    const item = document.createElement('div');
    item.className = 'tag-pill-nav';
    item.innerHTML = '<span class="tag-dot"></span>' + tag;
    item.addEventListener('click', () => {
      state.activeTag = state.activeTag === tag ? null : tag;
      state.activeNav = state.activeTag ? 'tag' : 'all';
      document.querySelectorAll('.tag-pill-nav').forEach(t => t.classList.remove('active'));
      if (state.activeTag) item.classList.add('active');
      applyFilters();
    });
    el.appendChild(item);
  });
}

function renderFolderTree(node, container, depth) {
  if (depth > 0) {
    const item = document.createElement('div');
    item.className = 'folder-item';
    item.style.paddingLeft = (16 + depth * 10) + 'px';
    item.dataset.folder = node.rel;
    item.innerHTML = '<span class="folder-icon">\uD83D\uDCC1</span><span class="folder-name">' + node.name + '</span>';
    item.addEventListener('click', () => {
      state.activeFolder = state.activeFolder === node.rel ? null : node.rel;
      state.activeNav = 'folder';
      document.querySelectorAll('.folder-item').forEach(f => f.classList.remove('active'));
      item.classList.add('active');
      document.getElementById('breadcrumb').textContent = node.name;
      applyFilters();
    });
    container.appendChild(item);
  }
  if (node.children && node.children.length) {
    const children = document.createElement('div');
    node.children.forEach(c => renderFolderTree(c, children, depth + 1));
    container.appendChild(children);
  }
}

// スマートフォルダの条件判定（v1はAND固定）
function matchesSmartFolder(file, rules) {
  if (rules.tags && rules.tags.length > 0) {
    if (!file.tags || !rules.tags.every(t => file.tags.includes(t))) return false;
  }
  if (rules.ratingMin && (file.rating || 0) < rules.ratingMin) return false;
  if (rules.color && file.color !== rules.color) return false;
  if (rules.exts && rules.exts.length > 0) {
    if (!rules.exts.includes((file.ext || '').toLowerCase())) return false;
  }
  if (rules.nameContains) {
    if (!file.name.toLowerCase().includes(rules.nameContains.toLowerCase())) return false;
  }
  if (rules.urlContains) {
    if (!file.url || !file.url.toLowerCase().includes(rules.urlContains.toLowerCase())) return false;
  }
  if (rules.dateFrom && file.mtime < rules.dateFrom) return false;
  if (rules.dateTo && file.mtime > rules.dateTo) return false;
  return true;
}

// ===== FILTERS =====
function applyFilters() {
  let files = [...state.files];

  if (state.activeNav === 'collection' && state.activeCollection) {
    const col = state.collections.find(c => c.id === state.activeCollection);
    if (col && col.type === 'smart') {
      files = files.filter(f => matchesSmartFolder(f, col.rules || {}));
    } else {
      const ids = col ? col.items : [];
      // コレクションの並び順を保持
      const idOrder = {};
      ids.forEach((id, i) => { idOrder[id] = i; });
      files = files.filter(f => idOrder[f.id] !== undefined);
      files.sort((a, b) => idOrder[a.id] - idOrder[b.id]);
    }
  } else if (state.activeNav === 'folder' && state.activeFolder) {
    files = files.filter(f => f.folder === state.activeFolder || f.folder.startsWith(state.activeFolder + '/'));
  } else if (state.activeNav === 'tag' && state.activeTag) {
    files = files.filter(f => f.tags && f.tags.includes(state.activeTag));
  } else if (state.activeNav === 'untagged') {
    files = files.filter(f => !f.tags || f.tags.length === 0);
  } else if (state.activeNav === 'recent') {
    const recent = Date.now() - 7 * 24 * 60 * 60 * 1000;
    files = files.filter(f => f.mtime > recent);
  }

  if (state.search) {
    const q = state.search.toLowerCase();
    files = files.filter(f =>
      f.name.toLowerCase().includes(q) ||
      (f.tags && f.tags.some(t => t.toLowerCase().includes(q))) ||
      (f.note && f.note.toLowerCase().includes(q))
    );
  }

  const parts = state.sort.split('-');
  const sortKey = parts[0];
  const sortDir = parts[1];
  files.sort((a, b) => {
    let va = sortKey === 'mtime' ? a.mtime : sortKey === 'size' ? a.size : a.name.toLowerCase();
    let vb = sortKey === 'mtime' ? b.mtime : sortKey === 'size' ? b.size : b.name.toLowerCase();
    if (va < vb) return sortDir === 'asc' ? -1 : 1;
    if (va > vb) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  state.filtered = files;
  renderGallery();
  updateStatus();
}

// ===== RENDER GALLERY =====
function renderGallery() {
  const gallery = document.getElementById('gallery');
  const empty = document.getElementById('empty-state');
  gallery.innerHTML = '';

  if (state.filtered.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  gallery.style.setProperty('--thumb-size', state.thumbSize + 'px');

  const frag = document.createDocumentFragment();
  state.filtered.forEach(file => {
    const el = state.view === 'grid' ? createCard(file) : createListRow(file);
    if (state.selected && state.selected.id === file.id) el.classList.add('selected');
    if (state.selectedIds.has(file.id)) el.classList.add('multi-selected');
    el.addEventListener('click', function(e) {
      if (e.ctrlKey || e.metaKey) {
        // Ctrl/Cmd+Click: toggle in multi-selection
        if (state.selectedIds.has(file.id)) {
          state.selectedIds.delete(file.id);
          el.classList.remove('multi-selected');
        } else {
          state.selectedIds.add(file.id);
          el.classList.add('multi-selected');
        }
        state.lastClickedId = file.id;
        updateStatus();
      } else if (e.shiftKey && state.lastClickedId) {
        // Shift+Click: select range from lastClickedId to this item
        const ids = state.filtered.map(function(f) { return f.id; });
        const fromIdx = ids.indexOf(state.lastClickedId);
        const toIdx = ids.indexOf(file.id);
        if (fromIdx !== -1 && toIdx !== -1) {
          const start = Math.min(fromIdx, toIdx);
          const end = Math.max(fromIdx, toIdx);
          for (let i = start; i <= end; i++) {
            state.selectedIds.add(ids[i]);
            const cardEl = document.querySelector('[data-id="' + ids[i] + '"]');
            if (cardEl) cardEl.classList.add('multi-selected');
          }
        }
        state.lastClickedId = file.id;
        updateStatus();
      } else {
        // Plain click: clear multi-selection and select single file
        state.selectedIds.clear();
        document.querySelectorAll('.card.multi-selected, .list-row.multi-selected').forEach(function(c) {
          c.classList.remove('multi-selected');
        });
        selectFile(file, el);
      }
    });
    el.addEventListener('dblclick', function() { openVideoModal(file); });
    el.addEventListener('contextmenu', function(e) {
      e.preventDefault();
      showContextMenu(e, file);
    });
    frag.appendChild(el);
  });
  gallery.appendChild(frag);
}

// ===== CARD =====
function createCard(file) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = file.id;

  let thumbEl;
  if (file.type === 'video') {
    if (file.hasThumbnail) {
      thumbEl = document.createElement('img');
      thumbEl.className = 'card-video-thumb';
      thumbEl.src = '/api/thumb/' + file.id;
      thumbEl.loading = 'lazy';
      thumbEl.alt = file.name;
      card.dataset.thumbPending = '0';
    } else {
      thumbEl = document.createElement('video');
      thumbEl.className = 'card-video-thumb';
      thumbEl.src = '/api/video/' + file.id + '#t=3';
      thumbEl.preload = 'metadata';
      thumbEl.muted = true;
      thumbEl.playsInline = true;
      card.dataset.thumbPending = '1';
    }
  } else if (file.type === 'image') {
    thumbEl = document.createElement('img');
    thumbEl.className = 'card-thumb';
    thumbEl.src = '/api/file/' + file.id;
    thumbEl.loading = 'lazy';
    thumbEl.alt = file.name;
  } else {
    thumbEl = document.createElement('div');
    thumbEl.className = 'card-thumb';
    thumbEl.style.cssText = 'display:flex;align-items:center;justify-content:center;font-size:32px;color:var(--text-3)';
    thumbEl.textContent = '\uD83C\uDFB5';
  }
  card.appendChild(thumbEl);

  const ext = document.createElement('div');
  ext.className = 'card-ext';
  ext.textContent = file.ext;
  card.appendChild(ext);

  if (file.color) {
    const dot = document.createElement('div');
    dot.className = 'card-color-dot';
    dot.style.background = COLOR_MAP[file.color] || file.color;
    card.appendChild(dot);
  }

  const playBtn = document.createElement('div');
  playBtn.className = 'card-play-btn';
  playBtn.innerHTML = '<svg viewBox="0 0 16 16"><path d="M4 3l10 5-10 5V3z"/></svg>';
  card.appendChild(playBtn);

  const overlay = document.createElement('div');
  overlay.className = 'card-overlay';
  let tagsHtml = '';
  if (file.tags && file.tags.length) {
    tagsHtml = '<div style="display:flex;gap:3px;flex-wrap:wrap;margin-top:4px">';
    file.tags.forEach(function(t) {
      tagsHtml += '<span style="background:rgba(74,143,255,0.2);color:var(--accent);font-size:9px;padding:1px 5px;border-radius:8px">' + t + '</span>';
    });
    tagsHtml += '</div>';
  }
  overlay.innerHTML = '<div class="card-name">' + file.name + '</div>' + tagsHtml;
  card.appendChild(overlay);

  // Source URL バッジ
  if (file.url) {
    const urlBadge = document.createElement('div');
    urlBadge.className = 'card-url-badge';
    // ドメイン名だけ表示
    let domain = file.url;
    try { domain = new URL(file.url).hostname.replace('www.', ''); } catch(e) {}
    urlBadge.textContent = domain;
    urlBadge.title = file.url;
    urlBadge.addEventListener('click', function(e) {
      e.stopPropagation();
      window.open(file.url, '_blank');
    });
    card.appendChild(urlBadge);
  }

  if (file.type === 'video' && file.hasThumbnail) {
    attachHoverVideo(card, file);
  } else if (file.type === 'video' && !file.hasThumbnail) {
    attachHoverVideoEl(card, thumbEl);
  }

  return card;
}

function attachHoverVideo(card, file) {
  let hoverVid = null;
  let hoverTimer;
  card.addEventListener('mouseenter', function() {
    hoverTimer = setTimeout(function() {
      const img = card.querySelector('img.card-video-thumb');
      if (!img) return;
      hoverVid = document.createElement('video');
      hoverVid.className = 'card-video-thumb';
      hoverVid.src = '/api/video/' + file.id;
      hoverVid.muted = true;
      hoverVid.playsInline = true;
      hoverVid.loop = true;
      hoverVid.style.position = 'absolute';
      hoverVid.style.inset = '0';
      hoverVid.style.width = '100%';
      hoverVid.style.height = '100%';
      hoverVid.style.objectFit = 'cover';
      card.appendChild(hoverVid);
      hoverVid.play().catch(function() {});
    }, 400);
  });
  card.addEventListener('mouseleave', function() {
    clearTimeout(hoverTimer);
    if (hoverVid) { hoverVid.pause(); hoverVid.remove(); hoverVid = null; }
  });
}

function attachHoverVideoEl(card, vid) {
  let hoverTimer;
  card.addEventListener('mouseenter', function() {
    hoverTimer = setTimeout(function() { vid.play().catch(function() {}); }, 400);
  });
  card.addEventListener('mouseleave', function() {
    clearTimeout(hoverTimer);
    vid.pause();
    vid.currentTime = 3;
  });
}

function createListRow(file) {
  const row = document.createElement('div');
  row.className = 'list-row';
  row.dataset.id = file.id;
  const thumbSrc = (file.type === 'video' && file.hasThumbnail)
    ? '<img class="list-thumb" src="/api/thumb/' + file.id + '" loading="lazy" alt="">'
    : '<video class="list-thumb" src="/api/video/' + file.id + '#t=3" preload="metadata" muted playsinline></video>';
  let tagsHtml = '';
  if (file.tags && file.tags.length) {
    file.tags.forEach(function(t) {
      tagsHtml += '<span class="tag-chip" style="font-size:10px;padding:1px 6px">' + t + '</span>';
    });
  }
  row.innerHTML = thumbSrc
    + '<div class="list-name">' + file.name + '</div>'
    + '<div class="list-ext">' + file.ext + '</div>'
    + '<div class="list-tags">' + tagsHtml + '</div>'
    + '<div class="list-size">' + formatSize(file.size) + '</div>'
    + '<div class="list-date">' + formatDate(file.mtime) + '</div>';
  return row;
}

function updateStatus() {
  document.getElementById('status-count').textContent =
    state.filtered.length + ' items' + (state.filtered.length !== state.files.length ? ' / ' + state.files.length + ' total' : '');
  const selEl = document.getElementById('status-selected');
  if (selEl) {
    selEl.textContent = state.selectedIds.size > 0 ? state.selectedIds.size + ' 件選択中' : '';
  }
}

// ===== SELECT & INSPECTOR =====
function selectFile(file, el) {
  document.querySelectorAll('.card.selected, .list-row.selected').forEach(function(c) { c.classList.remove('selected'); });
  if (state.selected && state.selected.id === file.id) {
    state.selected = null;
    state.lastClickedId = null;
    closeInspector();
    return;
  }
  el.classList.add('selected');
  state.selected = file;
  state.lastClickedId = file.id;
  openInspector(file);
}

function openInspector(file) {
  document.getElementById('inspector-empty').classList.add('hidden');
  document.getElementById('inspector-content').classList.remove('hidden');
  document.getElementById('ins-name').textContent = file.name;
  document.getElementById('ins-meta').innerHTML =
    '<div>Size: ' + formatSize(file.size) + '</div>' +
    '<div>Type: ' + file.ext.toUpperCase() + '</div>' +
    '<div>Modified: ' + formatDate(file.mtime) + '</div>' +
    '<div>Path: ' + file.relPath + '</div>';
  const vid = document.getElementById('inspector-video');
  vid.src = '/api/video/' + file.id;
  vid.load();
  state.inspectorMeta = {
    tags: (file.tags || []).slice(),
    note: file.note || '',
    color: file.color || null,
    rating: file.rating || 0,
    url: file.url || '',
  };
  renderInspectorTags();
  renderInspectorRating();
  renderInspectorColors();
  renderPalette(file);
  document.getElementById('ins-note').value = state.inspectorMeta.note;
  document.getElementById('ins-url').value = state.inspectorMeta.url;
}

function closeInspector() {
  document.getElementById('inspector-content').classList.add('hidden');
  document.getElementById('inspector-empty').classList.remove('hidden');
  const vid = document.getElementById('inspector-video');
  vid.pause();
  vid.src = '';
}

function renderInspectorTags() {
  const area = document.getElementById('ins-tags');
  area.innerHTML = '';
  state.inspectorMeta.tags.forEach(function(tag) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.innerHTML = tag + '<span class="tag-remove" data-tag="' + tag + '">\u2715</span>';
    chip.querySelector('.tag-remove').addEventListener('click', function() {
      state.inspectorMeta.tags = state.inspectorMeta.tags.filter(function(t) { return t !== tag; });
      renderInspectorTags();
      autoSave();
    });
    area.appendChild(chip);
  });
}

function renderInspectorRating() {
  const el = document.getElementById('ins-rating');
  el.innerHTML = '';
  for (let i = 1; i <= 5; i++) {
    const star = document.createElement('span');
    star.className = 'star' + (i <= state.inspectorMeta.rating ? ' active' : '');
    star.textContent = '\u2605';
    (function(idx) {
      star.addEventListener('click', function() {
        state.inspectorMeta.rating = state.inspectorMeta.rating === idx ? 0 : idx;
        renderInspectorRating();
        autoSave();
      });
    })(i);
    el.appendChild(star);
  }
}

function renderInspectorColors() {
  const el = document.getElementById('ins-colors');
  el.innerHTML = '';
  Object.keys(COLOR_MAP).forEach(function(name) {
    const hex = COLOR_MAP[name];
    const dot = document.createElement('div');
    dot.className = 'color-dot' + (state.inspectorMeta.color === name ? ' active' : '');
    dot.style.background = hex;
    dot.title = name;
    dot.addEventListener('click', function() {
      state.inspectorMeta.color = state.inspectorMeta.color === name ? null : name;
      renderInspectorColors();
      autoSave();
    });
    el.appendChild(dot);
  });
}

var _saveTimer = null;
var _prevTags = [];

async function saveMeta(showIndicator) {
  if (!state.selected) return;
  const prevTags = JSON.stringify(state.inspectorMeta.tags);
  state.inspectorMeta.note = document.getElementById('ins-note').value;
  state.inspectorMeta.url  = document.getElementById('ins-url').value.trim();
  await api('PUT', '/files/' + state.selected.id + '/meta', state.inspectorMeta);

  // state.files 内のオブジェクトを直接更新（再レンダリングなし）
  const file = state.files.find(function(f) { return f.id === state.selected.id; });
  if (file) Object.assign(file, state.inspectorMeta);

  // カードのURLバッジをリアルタイム更新
  const card = document.querySelector('[data-id="' + state.selected.id + '"]');
  if (card) {
    const existing = card.querySelector('.card-url-badge');
    if (existing) existing.remove();
    if (state.inspectorMeta.url) {
      const urlBadge = document.createElement('div');
      urlBadge.className = 'card-url-badge';
      let domain = state.inspectorMeta.url;
      try { domain = new URL(state.inspectorMeta.url).hostname.replace('www.', ''); } catch(e) {}
      urlBadge.textContent = domain;
      urlBadge.title = state.inspectorMeta.url;
      urlBadge.addEventListener('click', function(e) {
        e.stopPropagation();
        window.open(state.inspectorMeta.url, '_blank');
      });
      card.appendChild(urlBadge);
    }
  }

  // タグが変わったときだけサイドバーのタグリストを更新
  if (JSON.stringify(state.inspectorMeta.tags) !== prevTags) {
    loadTags();
    applyFilters();
  }

  // 保存インジケーター
  if (showIndicator !== false) {
    var ind = document.getElementById('ins-autosave-indicator');
    if (ind) { ind.textContent = '✓ Saved'; setTimeout(function(){ ind.textContent=''; }, 1500); }
  }
}

function autoSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveMeta, 400);
}

// ===== VIDEO MODAL =====
function openVideoModal(file) {
  document.getElementById('modal-title').textContent = file.name;
  document.getElementById('modal-video').src = '/api/video/' + file.id;
  document.getElementById('video-modal').classList.remove('hidden');
  document.getElementById('modal-video').play().catch(function() {});
}

function closeVideoModal() {
  const vid = document.getElementById('modal-video');
  vid.pause();
  vid.src = '';
  document.getElementById('video-modal').classList.add('hidden');
}

// ===== CONTEXT MENU =====
function showContextMenu(e, file) {
  removeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';

  const isMulti = state.selectedIds.size > 1;

  if (isMulti) {
    // バッチ操作メニュー
    const count = state.selectedIds.size;
    menu.innerHTML =
      '<div class="ctx-item" style="color:var(--text-3);font-size:11px;padding:5px 12px 3px;cursor:default">' + count + ' \u4EF6\u9078\u629E\u4E2D</div>' +
      '<div class="ctx-item" data-action="tag-multi">\uD83C\uDFF7 ' + count + ' \u4EF6\u306B\u30BF\u30B0\u8FFD\u52A0</div>' +
      '<div class="ctx-item" data-action="rating-multi">\u2605 ' + count + ' \u4EF6\u306E\u30EC\u30FC\u30C6\u30A3\u30F3\u30B0\u8A2D\u5B9A</div>' +
      '<div class="ctx-item danger" data-action="delete-multi">\uD83D\uDDD1 ' + count + ' \u4EF6\u3092\u524A\u9664</div>';
    menu.addEventListener('click', async function(ev) {
      const action = ev.target.dataset.action;
      if (action === 'tag-multi') {
        removeContextMenu();
        const tag = prompt('\u8FFD\u52A0\u3059\u308B\u30BF\u30B0\u3092\u5165\u529B');
        if (tag && tag.trim()) {
          await api('PUT', '/batch/meta', { ids: [...state.selectedIds], tags: [tag.trim()] });
          showToast(state.selectedIds.size + ' \u4EF6\u306B\u30BF\u30B0\u3092\u8FFD\u52A0\u3057\u307E\u3057\u305F');
          await loadFiles();
        }
        return;
      }
      if (action === 'rating-multi') {
        removeContextMenu();
        const r = prompt('\u30EC\u30FC\u30C6\u30A3\u30F3\u30B0 (0-5)');
        if (r !== null && r !== '' && !isNaN(parseInt(r))) {
          const rating = Math.min(5, Math.max(0, parseInt(r)));
          await api('PUT', '/batch/meta', { ids: [...state.selectedIds], rating });
          showToast(state.selectedIds.size + ' \u4EF6\u306E\u30EC\u30FC\u30C6\u30A3\u30F3\u30B0\u3092\u8A2D\u5B9A\u3057\u307E\u3057\u305F');
          await loadFiles();
        }
        return;
      }
      if (action === 'delete-multi') {
        if (confirm(state.selectedIds.size + ' \u4EF6\u3092\u30B4\u30DF\u7B8B\u306B\u79FB\u52D5\u3057\u307E\u3059\u304B\uFF1F')) {
          const batchCount = state.selectedIds.size;
          await api('DELETE', '/batch/files', { ids: [...state.selectedIds] });
          showToast(batchCount + ' \u4EF6\u3092\u30B4\u30DF\u7B8B\u306B\u79FB\u52D5\u3057\u307E\u3057\u305F');
          state.selectedIds.clear();
          state.lastClickedId = null;
          await loadFiles();
        }
      }
      removeContextMenu();
    });
  } else {
    // 単一ファイルメニュー
    let colMenuHtml = '';
    if (state.collections.length > 0) {
      colMenuHtml = '<div class="ctx-item ctx-col-parent" data-action="add-to-col">\uD83D\uDDC2 Add to Collection \u25B6</div>';
    }
    menu.innerHTML =
      '<div class="ctx-item" data-action="open">\u25B6 \u52D5\u753B\u3092\u518D\u751F</div>' +
      '<div class="ctx-item" data-action="inspector">\u24D8 Info \u3092\u958B\u304F</div>' +
      colMenuHtml +
      '<div class="ctx-item" data-action="rethumb">\uD83D\uDDBC \u30B5\u30E0\u30CD\u30A4\u30EB\u518D\u751F\u6210</div>' +
      '<div class="ctx-item danger" data-action="delete">\uD83D\uDDD1 \u524A\u9664</div>';
    menu.addEventListener('click', async function(ev) {
      const action = ev.target.dataset.action;
      if (action === 'open') openVideoModal(file);
      if (action === 'inspector') {
        const el = document.querySelector('[data-id="' + file.id + '"]');
        if (el) selectFile(file, el);
      }
      if (action === 'add-to-col') {
        // サブメニュー表示
        const sub = document.createElement('div');
        sub.className = 'ctx-menu';
        sub.style.left = (e.clientX + 160) + 'px';
        sub.style.top = ev.target.getBoundingClientRect().top + 'px';
        state.collections.forEach(function(col) {
          const item = document.createElement('div');
          item.className = 'ctx-item';
          item.textContent = col.name;
          item.addEventListener('click', async function() {
            if (!col.items.includes(file.id)) {
              col.items.push(file.id);
              await api('PUT', '/collections/' + col.id, { items: col.items, name: col.name });
              renderCollections();
              showToast('"' + file.name.slice(0, 20) + '..." \u3092 ' + col.name + ' \u306B\u8FFD\u52A0');
            }
            sub.remove();
            removeContextMenu();
          });
          sub.appendChild(item);
        });
        document.body.appendChild(sub);
        setTimeout(function() { document.addEventListener('click', function rm() { sub.remove(); document.removeEventListener('click', rm); }, { once: true }); }, 0);
        return;
      }
      if (action === 'rethumb') {
        const card = document.querySelector('[data-id="' + file.id + '"]');
        if (card) {
          file.hasThumbnail = false;
          card.dataset.thumbPending = '1';
          const img = card.querySelector('img.card-video-thumb');
          if (img) {
            const vid = document.createElement('video');
            vid.className = 'card-video-thumb';
            vid.src = '/api/video/' + file.id + '#t=3';
            vid.preload = 'metadata';
            vid.muted = true;
            vid.playsInline = true;
            img.replaceWith(vid);
          }
          await fetch('/api/thumb/' + file.id + '?regen=1', { method: 'HEAD' });
          startThumbPoll();
        }
      }
      if (action === 'delete') {
        if (confirm('"' + file.name + '" \u3092\u30B4\u30DF\u7B8B\u306B\u79FB\u52D5\u3057\u307E\u3059\u304B\uFF1F')) {
          await api('DELETE', '/files/' + file.id);
          showToast(file.name + ' \u3092\u30B4\u30DF\u7B8B\u306B\u79FB\u52D5\u3057\u307E\u3057\u305F');
          await loadFiles();
        }
      }
      removeContextMenu();
    });
  }

  document.body.appendChild(menu);
  state.ctxMenu = menu;
  setTimeout(function() { document.addEventListener('click', removeContextMenu, { once: true }); }, 0);
}

function removeContextMenu() {
  if (state.ctxMenu) { state.ctxMenu.remove(); state.ctxMenu = null; }
}

// ===== TRASH VIEW =====
async function loadTrashView() {
  const gallery = document.getElementById('gallery');
  const empty = document.getElementById('empty-state');
  const loading = document.getElementById('loading-state');
  gallery.innerHTML = '';
  empty.classList.add('hidden');
  loading.classList.remove('hidden');

  let items;
  try {
    items = await api('GET', '/trash');
  } catch (e) {
    loading.classList.add('hidden');
    showToast('ゴミ箱の読み込みに失敗しました');
    return;
  }
  loading.classList.add('hidden');

  if (items.length === 0) {
    empty.classList.remove('hidden');
    const emptyTitle = document.querySelector('#empty-state .empty-title');
    const emptySub = document.querySelector('#empty-state .empty-sub');
    if (emptyTitle) emptyTitle.textContent = 'ゴミ箱は空です';
    if (emptySub) emptySub.textContent = '削除したファイルはここに表示されます';
    document.getElementById('status-count').textContent = '0 items';
    return;
  }

  document.getElementById('status-count').textContent = items.length + ' items';

  // "ゴミ箱を空にする" button row
  const actionRow = document.createElement('div');
  actionRow.style.cssText = 'padding:10px 16px;display:flex;align-items:center;gap:10px;';
  const emptyAllBtn = document.createElement('button');
  emptyAllBtn.className = 'secondary-btn';
  emptyAllBtn.style.cssText = 'color:var(--red);border-color:var(--red);';
  emptyAllBtn.textContent = 'ゴミ箱を空にする';
  emptyAllBtn.addEventListener('click', async function() {
    if (!confirm('ゴミ箱のファイルをすべて完全削除しますか？この操作は元に戻せません。')) return;
    try {
      await api('DELETE', '/trash');
      showToast('ゴミ箱を空にしました');
      loadTrashView();
    } catch (e) {
      showToast('エラーが発生しました: ' + e.message);
    }
  });
  actionRow.appendChild(emptyAllBtn);
  gallery.appendChild(actionRow);

  // Trash item cards
  const frag = document.createDocumentFragment();
  items.forEach(function(item) {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.position = 'relative';

    // Thumb placeholder
    const thumb = document.createElement('div');
    thumb.className = 'card-thumb';
    thumb.style.cssText = 'display:flex;align-items:center;justify-content:center;font-size:32px;color:var(--text-3);opacity:0.5';
    thumb.textContent = '\uD83D\uDDD1';
    card.appendChild(thumb);

    // Ext badge
    const extMatch = item.name.match(/\.([^.]+)$/);
    if (extMatch) {
      const extEl = document.createElement('div');
      extEl.className = 'card-ext';
      extEl.textContent = extMatch[1].toLowerCase();
      card.appendChild(extEl);
    }

    // Overlay with name and deleted date
    const overlay = document.createElement('div');
    overlay.className = 'card-overlay';
    const deletedDate = item.deletedAt ? new Date(item.deletedAt).toLocaleDateString('ja-JP') : '';
    overlay.innerHTML = '<div class="card-name">' + item.name + '</div>' +
      (deletedDate ? '<div style="font-size:10px;color:var(--text-3);margin-top:2px">' + deletedDate + ' 削除</div>' : '');
    card.appendChild(overlay);

    // Action buttons shown on hover
    const btnWrap = document.createElement('div');
    btnWrap.style.cssText = 'position:absolute;bottom:36px;left:0;right:0;display:flex;gap:4px;justify-content:center;padding:4px 6px;opacity:0;transition:opacity 0.15s;';
    card.addEventListener('mouseenter', function() { btnWrap.style.opacity = '1'; });
    card.addEventListener('mouseleave', function() { btnWrap.style.opacity = '0'; });

    const restoreBtn = document.createElement('button');
    restoreBtn.textContent = '復元';
    restoreBtn.style.cssText = 'flex:1;font-size:11px;padding:4px 6px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer;';
    restoreBtn.addEventListener('click', async function(e) {
      e.stopPropagation();
      try {
        await api('POST', '/trash/' + item.id + '/restore');
        showToast(item.name + ' を復元しました');
        // Reload the library in the background, then refresh the trash view
        loadFiles().then(function() {
          state.activeNav = 'trash';
          document.getElementById('breadcrumb').textContent = 'ゴミ箱';
          loadTrashView();
        });
      } catch (err) {
        showToast('復元に失敗しました: ' + err.message);
      }
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '完全削除';
    deleteBtn.style.cssText = 'flex:1;font-size:11px;padding:4px 6px;background:var(--red);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer;';
    deleteBtn.addEventListener('click', async function(e) {
      e.stopPropagation();
      if (!confirm('"' + item.name + '" を完全削除しますか？この操作は元に戻せません。')) return;
      try {
        await api('DELETE', '/trash/' + item.id);
        showToast(item.name + ' を完全削除しました');
        loadTrashView();
      } catch (err) {
        showToast('削除に失敗しました: ' + err.message);
      }
    });

    btnWrap.appendChild(restoreBtn);
    btnWrap.appendChild(deleteBtn);
    card.appendChild(btnWrap);

    frag.appendChild(card);
  });
  gallery.appendChild(frag);
}

// ===== DUPLICATE DETECTION（完全一致のみ） =====
async function loadDuplicatesView() {
  const gallery = document.getElementById('gallery');
  const empty = document.getElementById('empty-state');
  const loading = document.getElementById('loading-state');
  gallery.innerHTML = '';
  empty.classList.add('hidden');
  loading.classList.add('hidden');

  const actionRow = document.createElement('div');
  actionRow.style.cssText = 'padding:10px 16px;display:flex;align-items:center;gap:10px;';
  const scanBtn = document.createElement('button');
  scanBtn.className = 'secondary-btn';
  scanBtn.style.width = 'auto';
  scanBtn.textContent = '重複をスキャン';
  const statusText = document.createElement('span');
  statusText.style.cssText = 'font-size:12px;color:var(--text-3);';
  actionRow.appendChild(scanBtn);
  actionRow.appendChild(statusText);
  gallery.appendChild(actionRow);

  const resultsWrap = document.createElement('div');
  resultsWrap.id = 'duplicates-results';
  resultsWrap.style.cssText = 'padding:0 16px 16px;';
  gallery.appendChild(resultsWrap);

  async function pollScan() {
    const job = await api('GET', '/duplicates/scan');
    if (job.status === 'running') {
      statusText.textContent = 'スキャン中... ' + job.done + '/' + job.total;
      setTimeout(pollScan, 600);
    } else if (job.status === 'error') {
      statusText.textContent = 'スキャンに失敗しました';
    } else {
      statusText.textContent = '';
      await renderDuplicateGroups();
    }
  }

  scanBtn.addEventListener('click', async function() {
    statusText.textContent = 'スキャン中...';
    resultsWrap.innerHTML = '';
    try {
      await api('POST', '/duplicates/scan');
      pollScan();
    } catch (e) { statusText.textContent = 'エラー: ' + e.message; }
  });

  async function renderDuplicateGroups() {
    let groups;
    try {
      groups = await api('GET', '/duplicates');
    } catch (e) {
      resultsWrap.textContent = '結果の取得に失敗しました';
      return;
    }
    resultsWrap.innerHTML = '';
    if (groups.length === 0) {
      resultsWrap.innerHTML = '<div style="color:var(--text-3);font-size:13px;padding:20px 0;">重複ファイルは見つかりませんでした（「重複をスキャン」を押してください）</div>';
      document.getElementById('status-count').textContent = '0 groups';
      return;
    }
    document.getElementById('status-count').textContent = groups.length + ' groups';
    groups.forEach(function(group, gi) {
      const groupEl = document.createElement('div');
      groupEl.style.cssText = 'border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 12px;margin-bottom:10px;';
      const header = document.createElement('div');
      header.style.cssText = 'font-size:12px;color:var(--text-3);margin-bottom:8px;';
      header.textContent = formatSize(group.size) + ' × ' + group.files.length + ' 件（完全一致）';
      groupEl.appendChild(header);

      group.files.forEach(function(f, fi) {
        const row = document.createElement('label');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px;cursor:pointer;';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'dup-keep-' + gi;
        radio.value = f.id;
        radio.checked = fi === 0;
        row.appendChild(radio);
        const label = document.createElement('span');
        label.textContent = f.name + (f.tags.length ? '  [' + f.tags.join(', ') + ']' : '') + (f.rating ? '  ★' + f.rating : '');
        row.appendChild(label);
        groupEl.appendChild(row);
      });

      const mergeBtn = document.createElement('button');
      mergeBtn.className = 'secondary-btn';
      mergeBtn.style.cssText = 'width:auto;margin-top:6px;color:var(--red);border-color:var(--red);';
      mergeBtn.textContent = '残す1件以外をゴミ箱へ移動してマージ';
      mergeBtn.addEventListener('click', async function() {
        const checked = groupEl.querySelector('input[name="dup-keep-' + gi + '"]:checked');
        if (!checked) return;
        const keepId = checked.value;
        const removeIds = group.files.map(function(f) { return f.id; }).filter(function(id) { return id !== keepId; });
        if (!confirm(removeIds.length + ' 件をゴミ箱へ移動します。タグ・評価は残すファイルに統合されます。よろしいですか？')) return;
        try {
          await api('POST', '/duplicates/merge', { keepId, removeIds });
          showToast('マージしました');
          await loadFiles();
          state.activeNav = 'duplicates';
          document.getElementById('breadcrumb').textContent = '重複ファイル';
          await renderDuplicateGroups();
        } catch (e) { showToast('エラー: ' + e.message); }
      });
      groupEl.appendChild(mergeBtn);
      resultsWrap.appendChild(groupEl);
    });
  }

  // 既存のスキャン結果があれば即表示。実行中なら進行状況をポーリング
  try {
    const job = await api('GET', '/duplicates/scan');
    if (job.status === 'running') {
      statusText.textContent = 'スキャン中... ' + job.done + '/' + job.total;
      pollScan();
    } else {
      await renderDuplicateGroups();
    }
  } catch (e) { await renderDuplicateGroups(); }
}

// ===== LIBRARY SWITCHER =====
// ライブラリ切替・追加・削除の直後に呼ぶ。旧ライブラリの選択状態やフィルタが
// 残ると、新ライブラリに存在しないファイル/フォルダ/タグを参照してギャラリーが
// 空に見えたり、ゴミ箱表示のまま画面が同期しなくなる
function resetLibrarySwitchState() {
  state.selected = null;
  state.selectedIds.clear();
  state.activeFolder = null;
  state.activeTag = null;
  state.activeCollection = null;
  state.activeNav = 'all';
  closeInspector();
  document.querySelectorAll('.nav-item').forEach(function(i) { i.classList.remove('active'); });
  const allNav = document.querySelector('.nav-item[data-view="all"]');
  if (allNav) allNav.classList.add('active');
  document.querySelectorAll('.folder-item').forEach(function(f) { f.classList.remove('active'); });
  document.querySelectorAll('.tag-pill-nav').forEach(function(t) { t.classList.remove('active'); });
  document.getElementById('breadcrumb').textContent = 'Library';
}

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
          const wasActive = lib.id === state.activeLibraryId;
          await api('DELETE', '/libraries/' + lib.id);
          await loadLibraries();
          renderLibSwitcherDropdown();
          if (wasActive) resetLibrarySwitchState();
          await loadFiles();
          showToast(lib.name + ' を一覧から削除しました');
        } catch (err) { showToast('エラー: ' + err.message); }
        return;
      }
      if (lib.id !== state.activeLibraryId) {
        await api('POST', '/libraries/' + lib.id + '/activate');
        await loadLibraries();
        hideLibSwitcherDropdown();
        resetLibrarySwitchState();
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
      resetLibrarySwitchState();
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

// ===== DRAG & DROP IMPORT =====
let dragCounter = 0;
let pendingImportPaths = null;

document.addEventListener('dragenter', function(e) {
  e.preventDefault();
  dragCounter++;
  document.getElementById('drop-overlay').classList.remove('hidden');
});
document.addEventListener('dragover', function(e) { e.preventDefault(); });
document.addEventListener('dragleave', function(e) {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    document.getElementById('drop-overlay').classList.add('hidden');
  }
});
document.addEventListener('drop', function(e) {
  e.preventDefault();
  dragCounter = 0;
  document.getElementById('drop-overlay').classList.add('hidden');
  const files = Array.from(e.dataTransfer.files || []);
  if (files.length === 0) return;
  if (!window.electronAPI || !window.electronAPI.getPathForFile) {
    showToast('ドラッグ&ドロップ取り込みはElectron環境でのみ使用できます');
    return;
  }
  const paths = files.map(function(f) { return window.electronAPI.getPathForFile(f); }).filter(Boolean);
  if (paths.length === 0) return;
  openImportModeModal(paths);
});

function openImportModeModal(paths) {
  pendingImportPaths = paths;
  document.getElementById('import-mode-summary').textContent = paths.length + ' 件のファイルを追加します';
  document.getElementById('import-progress').classList.add('hidden');
  document.getElementById('import-mode-copy').disabled = false;
  document.getElementById('import-mode-move').disabled = false;
  document.getElementById('import-mode-modal').classList.remove('hidden');
}
function closeImportModeModal() {
  document.getElementById('import-mode-modal').classList.add('hidden');
  pendingImportPaths = null;
}
document.getElementById('import-mode-cancel').addEventListener('click', closeImportModeModal);
document.getElementById('import-mode-modal').addEventListener('click', function(e) {
  if (e.target === e.currentTarget || e.target.classList.contains('modal-backdrop')) closeImportModeModal();
});
document.getElementById('import-mode-copy').addEventListener('click', function() { startImport('copy'); });
document.getElementById('import-mode-move').addEventListener('click', function() { startImport('move'); });

async function startImport(mode) {
  if (!pendingImportPaths) return;
  const paths = pendingImportPaths;
  document.getElementById('import-mode-copy').disabled = true;
  document.getElementById('import-mode-move').disabled = true;
  document.getElementById('import-progress').classList.remove('hidden');
  document.getElementById('import-progress-text').textContent = '取り込み中... 0/' + paths.length;
  try {
    const { jobId } = await api('POST', '/import', { paths, mode });
    await pollImportJob(jobId, paths.length);
  } catch (err) {
    showToast('エラー: ' + err.message);
  }
  closeImportModeModal();
}

function pollImportJob(jobId, total) {
  return new Promise(function(resolve) {
    const timer = setInterval(async function() {
      try {
        const job = await api('GET', '/import/' + jobId);
        document.getElementById('import-progress-text').textContent = '取り込み中... ' + job.done + '/' + total;
        if (job.status === 'done') {
          clearInterval(timer);
          if (job.errors && job.errors.length > 0) {
            showToast(job.errors.length + ' 件のエラー: ' + job.errors[0]);
          }
          showToast((job.importedIds || []).length + ' 件のファイルを追加しました');
          await loadFiles();
          resolve();
        }
      } catch (e) {
        clearInterval(timer);
        resolve();
      }
    }, 500);
  });
}

// ===== CONTROLS & INIT (DOM ready) =====
// ===== PERSISTENT UI STATE =====
function saveUIState() {
  try {
    localStorage.setItem('videoref-ui', JSON.stringify({
      sort: state.sort,
      view: state.view,
      thumbSize: state.thumbSize,
    }));
  } catch (e) {}
}

function loadUIState() {
  try {
    var saved = JSON.parse(localStorage.getItem('videoref-ui'));
    if (!saved) return;
    if (saved.sort) state.sort = saved.sort;
    if (saved.view) state.view = saved.view;
    if (saved.thumbSize) state.thumbSize = saved.thumbSize;
  } catch (e) {}
}

function initUI() {
  loadUIState();

  // Apply restored state to DOM
  document.getElementById('sort-select').value = state.sort;
  if (state.view === 'list') {
    document.getElementById('view-list').classList.add('active');
    document.getElementById('view-grid').classList.remove('active');
  } else {
    document.getElementById('view-grid').classList.add('active');
    document.getElementById('view-list').classList.remove('active');
  }
  var zoomSlider = document.getElementById('zoom-slider');
  zoomSlider.value = state.thumbSize;
  document.getElementById('gallery').style.setProperty('--thumb-size', state.thumbSize + 'px');

  document.getElementById('zoom-slider').addEventListener('input', function(e) {
    state.thumbSize = parseInt(e.target.value);
    document.getElementById('gallery').style.setProperty('--thumb-size', state.thumbSize + 'px');
    saveUIState();
  });

  var searchTimer;
  document.getElementById('search-input').addEventListener('input', function(e) {
    clearTimeout(searchTimer);
    state.search = e.target.value;
    document.getElementById('search-clear').classList.toggle('hidden', !state.search);
    searchTimer = setTimeout(applyFilters, 200);
  });
document.getElementById('search-clear').addEventListener('click', function() {
  state.search = '';
  document.getElementById('search-input').value = '';
  document.getElementById('search-clear').classList.add('hidden');
  applyFilters();
});

document.getElementById('sort-select').addEventListener('change', function(e) {
  state.sort = e.target.value;
  saveUIState();
  applyFilters();
});

document.getElementById('view-grid').addEventListener('click', function() {
  state.view = 'grid';
  document.getElementById('gallery').className = 'grid-view';
  document.getElementById('view-grid').classList.add('active');
  document.getElementById('view-list').classList.remove('active');
  saveUIState();
  renderGallery();
});
document.getElementById('view-list').addEventListener('click', function() {
  state.view = 'list';
  document.getElementById('gallery').className = 'list-view';
  document.getElementById('view-list').classList.add('active');
  document.getElementById('view-grid').classList.remove('active');
  saveUIState();
  renderGallery();
});

document.querySelectorAll('.nav-item').forEach(function(item) {
  item.addEventListener('click', function() {
    document.querySelectorAll('.nav-item').forEach(function(i) { i.classList.remove('active'); });
    item.classList.add('active');
    // Support both data-view (div) and data-nav (button) attributes
    const navKey = item.dataset.nav || item.dataset.view;
    state.activeNav = navKey;
    state.activeFolder = null;
    state.activeTag = null;
    document.querySelectorAll('.folder-item').forEach(function(f) { f.classList.remove('active'); });
    document.querySelectorAll('.tag-pill-nav').forEach(function(t) { t.classList.remove('active'); });
    if (navKey === 'trash') {
      document.getElementById('breadcrumb').textContent = 'ゴミ箱';
      loadTrashView();
    } else if (navKey === 'duplicates') {
      document.getElementById('breadcrumb').textContent = '重複ファイル';
      loadDuplicatesView();
    } else {
      const labels = { all: 'Library', untagged: 'Untagged', recent: 'Recently Added' };
      document.getElementById('breadcrumb').textContent = labels[navKey] || 'Library';
      applyFilters();
    }
  });
});

document.getElementById('ins-url-open').addEventListener('click', function() {
  const url = document.getElementById('ins-url').value.trim();
  if (!url) return; // #15 空URL防止
  window.open(url, '_blank');
});

// ===== VIDEO MODAL FRAME MENU =====
const videoCtxMenu = document.getElementById('video-ctx-menu');
const modalVideo = document.getElementById('modal-video');

// モーダルが閉じているときは右クリックメニューを出さない
modalVideo.addEventListener('contextmenu', function(e) {
  // モーダル自体が非表示なら何もしない
  if (document.getElementById('video-modal').classList.contains('hidden')) return;
  e.preventDefault();
  e.stopPropagation();
  // モーダル内の相対座標で配置
  const modal = document.querySelector('.modal-content');
  const rect = modal.getBoundingClientRect();
  let menuX = e.clientX - rect.left;
  let menuY = e.clientY - rect.top;
  // 画面端にはみ出さないよう調整
  const mw = 210, mh = 110;
  if (menuX + mw > rect.width) menuX = rect.width - mw - 8;
  if (menuY + mh > rect.height) menuY = rect.height - mh - 8;
  videoCtxMenu.style.left = menuX + 'px';
  videoCtxMenu.style.top = menuY + 'px';
  videoCtxMenu.classList.remove('hidden');
  setTimeout(function() {
    document.addEventListener('click', hideVideoCtxMenu, { once: true });
  }, 0);
});

function hideVideoCtxMenu() {
  videoCtxMenu.classList.add('hidden');
}

videoCtxMenu.addEventListener('click', async function(e) {
  const action = e.target.dataset.action;
  if (!action || !state.selected) return;
  hideVideoCtxMenu();

  const currentTime = modalVideo.currentTime;
  const id = state.selected.id;

  if (action === 'copy-frame') {
    // canvas に描画してクリップボードへ
    const canvas = document.createElement('canvas');
    canvas.width = modalVideo.videoWidth;
    canvas.height = modalVideo.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(modalVideo, 0, 0);
    canvas.toBlob(async function(blob) {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': blob })
        ]);
        showToast('フレームをコピーしました');
      } catch (err) {
        // Electron環境ではClipboard APIが制限される場合
        // fallback: 新しいタブで画像を開く
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        showToast('フレームを新しいタブで開きました');
      }
    }, 'image/png');
  }

  if (action === 'save-frame') {
    // サーバー経由でFFmpegフレームを取得して保存
    const url = '/api/frame/' + id + '?t=' + currentTime.toFixed(3);
    const a = document.createElement('a');
    a.href = url;
    a.download = (state.selected.name.replace(/\.[^.]+$/, '')) + '_' + currentTime.toFixed(2) + 's.jpg';
    a.click();
    showToast('フレームを保存しました');
  }

  if (action === 'set-thumb') {
    // 現在フレームをサムネイルに設定
    const r = await fetch('/api/set-thumb/' + id + '?t=' + currentTime.toFixed(3), { method: 'POST' });
    if (r.ok) {
      // ギャラリーカードのサムネイルを更新
      const card = document.querySelector('[data-id="' + id + '"]');
      if (card) {
        const img = card.querySelector('img.card-video-thumb');
        if (img) img.src = '/api/thumb/' + id + '?t=' + Date.now();
      }
      const file = state.files.find(function(f) { return f.id === id; });
      if (file) file.hasThumbnail = true;
      showToast('サムネイルを更新しました');
    }
  }
});

// ===== TOAST =====
function showToast(msg) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(function() { toast.classList.remove('show'); }, 2000);
}

document.getElementById('ins-open-btn').addEventListener('click', function() {
  if (state.selected) alert('Path: ' + state.selected.relPath);
});
document.getElementById('ins-tag-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') addTag();
});
document.getElementById('ins-tag-add').addEventListener('click', addTag);

// note: 入力のたびに自動保存（debounce済み）
document.getElementById('ins-note').addEventListener('input', autoSave);

// URL: フォーカスが外れたら保存
document.getElementById('ins-url').addEventListener('blur', function() {
  if (state.selected) autoSave();
});

function addTag() {
  const input = document.getElementById('ins-tag-input');
  const val = input.value.trim();
  if (val && !state.inspectorMeta.tags.includes(val)) {
    state.inspectorMeta.tags.push(val);
    renderInspectorTags();
    autoSave();
  }
  input.value = '';
  input.focus();
}

document.getElementById('video-modal').addEventListener('click', function(e) {
  if (e.target === e.currentTarget || e.target.classList.contains('modal-backdrop')) closeVideoModal();
});
var _vmClose = document.querySelector('#video-modal .modal-close');
if (_vmClose) _vmClose.addEventListener('click', closeVideoModal);
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeVideoModal(); });

document.getElementById('reload-btn').addEventListener('click', loadFiles);

// ===== DOWNLOAD MODAL =====
const dlJobs = {}; // jobId -> pollTimer

function openDownload() {
  document.getElementById('dl-modal').classList.remove('hidden');
  document.getElementById('dl-url-input').focus();
}
function closeDownload() {
  document.getElementById('dl-modal').classList.add('hidden');
}

document.getElementById('dl-open-btn').addEventListener('click', openDownload);
document.getElementById('dl-close').addEventListener('click', closeDownload);
document.getElementById('dl-modal').addEventListener('click', function(e) {
  if (e.target === e.currentTarget || e.target.classList.contains('modal-backdrop')) closeDownload();
});

// URLペーストで即スタート
document.getElementById('dl-url-input').addEventListener('paste', function() {
  setTimeout(function() {
    const val = document.getElementById('dl-url-input').value.trim();
    if (val.startsWith('http')) startDownload(val);
  }, 50);
});

document.getElementById('dl-start-btn').addEventListener('click', function() {
  const val = document.getElementById('dl-url-input').value.trim();
  if (val) startDownload(val);
});
document.getElementById('dl-url-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') {
    const val = this.value.trim();
    if (val) startDownload(val);
  }
});

async function startDownload(url) {
  document.getElementById('dl-url-input').value = '';
  let data;
  try {
    data = await api('POST', '/download', { url });
  } catch (e) {
    showToast('Error: ' + e.message);
    return;
  }
  const jobId = data.jobId;
  addJobCard(jobId, url);
  pollJob(jobId);
}

function addJobCard(jobId, url) {
  const container = document.getElementById('dl-jobs');
  const card = document.createElement('div');
  card.className = 'dl-job';
  card.id = 'dl-job-' + jobId;
  card.innerHTML =
    '<div class="dl-job-header">' +
      '<div class="dl-job-url">' + url + '</div>' +
      '<div class="dl-job-status downloading" id="dl-status-' + jobId + '">Downloading</div>' +
    '</div>' +
    '<div class="dl-job-filename" id="dl-filename-' + jobId + '">準備中...</div>' +
    '<div class="dl-progress-bar"><div class="dl-progress-fill" id="dl-prog-' + jobId + '" style="width:0%"></div></div>' +
    '<div class="dl-job-actions">' +
      '<button class="dl-cancel-btn" id="dl-cancel-' + jobId + '">Cancel</button>' +
    '</div>';
  container.insertBefore(card, container.firstChild);
  document.getElementById('dl-cancel-' + jobId).addEventListener('click', function() {
    cancelJob(jobId);
  });
}

async function pollJob(jobId) {
  const timer = setInterval(async function() {
    let data;
    try { data = await api('GET', '/download/' + jobId); } catch (e) { return; }

    const progEl = document.getElementById('dl-prog-' + jobId);
    const statusEl = document.getElementById('dl-status-' + jobId);
    const filenameEl = document.getElementById('dl-filename-' + jobId);

    if (!progEl) { clearInterval(timer); return; }

    if (progEl) progEl.style.width = data.progress + '%';
    if (filenameEl && data.filename) filenameEl.textContent = data.filename;

    if (data.status === 'done') {
      clearInterval(timer);
      if (statusEl) { statusEl.textContent = '✓ Done'; statusEl.className = 'dl-job-status done'; }
      if (progEl) progEl.style.width = '100%';
      showToast('\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9\u5B8C\u4E86: ' + (data.filename || ''));
      setTimeout(function() { loadFiles(); }, 1000);
      const cancelBtn = document.getElementById('dl-cancel-' + jobId);
      if (cancelBtn) cancelBtn.style.display = 'none';
    } else if (data.status === 'error') {
      clearInterval(timer);
      if (statusEl) { statusEl.textContent = '\u2715 Error'; statusEl.className = 'dl-job-status error'; }
      if (filenameEl) filenameEl.textContent = data.log.join(' ') || 'Download failed';
    } else if (data.status === 'cancelled') {
      clearInterval(timer);
      if (statusEl) { statusEl.textContent = 'Cancelled'; statusEl.className = 'dl-job-status cancelled'; }
    }
  }, 800);
  dlJobs[jobId] = timer;
}

async function cancelJob(jobId) {
  clearInterval(dlJobs[jobId]);
  try { await api('DELETE', '/download/' + jobId); } catch (e) {}
  const statusEl = document.getElementById('dl-status-' + jobId);
  if (statusEl) { statusEl.textContent = 'Cancelled'; statusEl.className = 'dl-job-status cancelled'; }
  const cancelBtn = document.getElementById('dl-cancel-' + jobId);
  if (cancelBtn) cancelBtn.style.display = 'none';
}

// ===== SETTINGS MODAL =====
async function openSettings() {
  const modal = document.getElementById('settings-modal');
  modal.classList.remove('hidden');
  try {
    const s = await api('GET', '/settings');
    document.getElementById('settings-current-path').textContent = s.libraryPath || '?';
    document.getElementById('settings-thumb-dir').textContent = s.thumbDir || '?';
  } catch (e) {}
}

function closeSettings() {
  document.getElementById('settings-modal').classList.add('hidden');
}

document.getElementById('settings-btn').addEventListener('click', openSettings);
document.getElementById('settings-close').addEventListener('click', closeSettings);
document.getElementById('settings-modal').addEventListener('click', function(e) {
  if (e.target === e.currentTarget || e.target.classList.contains('modal-backdrop')) closeSettings();
});

// ===== COLLECTIONS =====
async function loadCollections() {
  state.collections = await api('GET', '/collections');
  renderCollections();
}

function renderCollections() {
  const list = document.getElementById('collection-list');
  list.innerHTML = '';
  state.collections.forEach(function(col) {
    const isSmart = col.type === 'smart';
    const count = isSmart
      ? state.files.filter(function(f) { return matchesSmartFolder(f, col.rules || {}); }).length
      : (col.items || []).length;
    const item = document.createElement('div');
    item.className = 'collection-item' + (state.activeCollection === col.id ? ' active' : '');
    item.innerHTML =
      '<span class="col-icon">' + (isSmart ? '\uD83D\uDD0D' : '\uD83D\uDDC2') + '</span>' +
      '<span class="col-name">' + col.name + '</span>' +
      '<span class="col-count">' + count + '</span>' +
      (isSmart ? '<button class="col-edit" data-id="' + col.id + '">\u270E</button>' : '') +
      '<button class="col-delete" data-id="' + col.id + '">\u2715</button>';
    item.addEventListener('click', function(e) {
      if (e.target.classList.contains('col-delete') || e.target.classList.contains('col-edit')) return;
      state.activeCollection = state.activeCollection === col.id ? null : col.id;
      state.activeNav = state.activeCollection ? 'collection' : 'all';
      document.querySelectorAll('.nav-item,.folder-item,.tag-pill-nav,.collection-item').forEach(function(el) { el.classList.remove('active'); });
      if (state.activeCollection) item.classList.add('active');
      document.getElementById('breadcrumb').textContent = col.name;
      applyFilters();
    });
    if (isSmart) {
      item.querySelector('.col-edit').addEventListener('click', function(e) {
        e.stopPropagation();
        openSmartFolderModal(col);
      });
    }
    item.querySelector('.col-delete').addEventListener('click', async function(e) {
      e.stopPropagation();
      if (!confirm('"' + col.name + '" \u3092\u524A\u9664\u3057\u307E\u3059\u304B\uFF1F')) return;
      await api('DELETE', '/collections/' + col.id);
      if (state.activeCollection === col.id) { state.activeCollection = null; state.activeNav = 'all'; }
      await loadCollections();
      applyFilters();
    });
    list.appendChild(item);
  });
}

// ===== SMART FOLDER MODAL =====
let smartFolderEditingId = null;

function openSmartFolderModal(col) {
  smartFolderEditingId = col ? col.id : null;
  const rules = (col && col.rules) || {};
  document.getElementById('sf-name').value = col ? col.name : '';
  document.getElementById('sf-tags').value = (rules.tags || []).join(', ');
  document.getElementById('sf-rating-min').value = rules.ratingMin || 0;
  document.getElementById('sf-color').value = rules.color || '';
  document.getElementById('sf-exts').value = (rules.exts || []).join(', ');
  document.getElementById('sf-name-contains').value = rules.nameContains || '';
  document.getElementById('sf-url-contains').value = rules.urlContains || '';
  document.getElementById('sf-date-from').value = rules.dateFrom ? new Date(rules.dateFrom).toISOString().slice(0, 10) : '';
  document.getElementById('sf-date-to').value = rules.dateTo ? new Date(rules.dateTo).toISOString().slice(0, 10) : '';
  document.getElementById('smart-folder-modal').classList.remove('hidden');
}

function closeSmartFolderModal() {
  document.getElementById('smart-folder-modal').classList.add('hidden');
  smartFolderEditingId = null;
}

document.getElementById('new-smart-folder-btn').addEventListener('click', function() {
  openSmartFolderModal(null);
});
document.getElementById('smart-folder-close').addEventListener('click', closeSmartFolderModal);
document.getElementById('smart-folder-modal').addEventListener('click', function(e) {
  if (e.target === e.currentTarget || e.target.classList.contains('modal-backdrop')) closeSmartFolderModal();
});
document.getElementById('sf-save').addEventListener('click', async function() {
  const name = document.getElementById('sf-name').value.trim();
  if (!name) { showToast('\u540D\u524D\u3092\u5165\u529B\u3057\u3066\u304F\u3060\u3055\u3044'); return; }
  const dateFrom = document.getElementById('sf-date-from').value;
  const dateTo = document.getElementById('sf-date-to').value;
  const rules = {
    tags: document.getElementById('sf-tags').value.split(',').map(function(s) { return s.trim(); }).filter(Boolean),
    ratingMin: parseInt(document.getElementById('sf-rating-min').value, 10) || 0,
    color: document.getElementById('sf-color').value || null,
    exts: document.getElementById('sf-exts').value.split(',').map(function(s) { return s.trim().toLowerCase().replace(/^\./, ''); }).filter(Boolean),
    nameContains: document.getElementById('sf-name-contains').value.trim(),
    urlContains: document.getElementById('sf-url-contains').value.trim(),
    dateFrom: dateFrom ? new Date(dateFrom).getTime() : null,
    dateTo: dateTo ? new Date(dateTo).getTime() + 24 * 60 * 60 * 1000 - 1 : null,
  };
  try {
    if (smartFolderEditingId) {
      await api('PUT', '/collections/' + smartFolderEditingId, { name, rules });
    } else {
      await api('POST', '/collections', { name, type: 'smart', rules });
    }
    closeSmartFolderModal();
    await loadCollections();
    applyFilters();
  } catch (err) { showToast('\u30A8\u30E9\u30FC: ' + err.message); }
});

document.getElementById('new-collection-btn').addEventListener('click', function() {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'collection-name-input';
  input.placeholder = 'Collection name...';
  const list = document.getElementById('collection-list');
  list.insertBefore(input, list.firstChild);
  input.focus();
  async function confirm_create() {
    const name = input.value.trim();
    input.remove();
    if (!name) return;
    await api('POST', '/collections', { name });
    await loadCollections();
  }
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') confirm_create();
    if (e.key === 'Escape') input.remove();
  });
  input.addEventListener('blur', confirm_create);
});

// コレクションから削除（Inspector の Remove ボタン用）
async function removeFromCollection(fileId) {
  const col = state.collections.find(c => c.id === state.activeCollection);
  if (!col) return;
  col.items = col.items.filter(id => id !== fileId);
  await api('PUT', '/collections/' + col.id, { items: col.items, name: col.name });
  renderCollections();
  applyFilters();
}

// ===== COLOR PALETTE EXTRACTION =====

// RGB 竊・HEX
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(function(v) { return ('0' + v.toString(16)).slice(-2); }).join('');
}
// HEX 竊・RGB
function hexToRgb(hex) {
  var r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return [r, g, b];
}
// RGB 竊・HSL
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  var max = Math.max(r,g,b), min = Math.min(r,g,b), h, s, l = (max+min)/2;
  if (max === min) { h = s = 0; } else {
    var d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch(max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      default: h = ((r - g) / d + 4) / 6;
    }
  }
  return [Math.round(h*360), Math.round(s*100), Math.round(l*100)];
}

function formatColor(hex, fmt) {
  var rgb = hexToRgb(hex);
  if (fmt === 'hex') return hex;
  if (fmt === 'rgb') return 'rgb(' + rgb.join(', ') + ')';
  if (fmt === 'hsl') { var hsl = rgbToHsl(rgb[0],rgb[1],rgb[2]); return 'hsl(' + hsl[0] + ', ' + hsl[1] + '%, ' + hsl[2] + '%)'; }
  return hex;
}

// Median Cut algorithm for palette extraction
function extractPalette(imgSrc, count) {
  count = count || 8;
  return new Promise(function(resolve) {
    var img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = function() {
      var canvas = document.createElement('canvas');
      var size = 120; canvas.width = size; canvas.height = size;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, size, size);
      var data = ctx.getImageData(0, 0, size, size).data;
      var pixels = [];
      for (var i = 0; i < data.length; i += 4) {
        if (data[i+3] < 128) continue;
        pixels.push([data[i], data[i+1], data[i+2]]);
      }
      function mc(px, depth) {
        if (depth === 0 || px.length < 4) {
          var avg=[0,0,0]; px.forEach(function(p){avg[0]+=p[0];avg[1]+=p[1];avg[2]+=p[2];}); var n=px.length;
          return [[Math.round(avg[0]/n),Math.round(avg[1]/n),Math.round(avg[2]/n)]];
        }
        var ranges=[0,1,2].map(function(c){var v=px.map(function(p){return p[c];});return Math.max.apply(null,v)-Math.min.apply(null,v);});
        var ch=ranges.indexOf(Math.max.apply(null,ranges));
        px.sort(function(a,b){return a[ch]-b[ch];});
        var mid=Math.floor(px.length/2);
        return mc(px.slice(0,mid),depth-1).concat(mc(px.slice(mid),depth-1));
      }
      var raw=mc(pixels,Math.ceil(Math.log2(count)));
      var palette=[];
      raw.forEach(function(p){
        var close=palette.some(function(q){return Math.abs(q[0]-p[0])+Math.abs(q[1]-p[1])+Math.abs(q[2]-p[2])<40;});
        if(!close&&palette.length<count)palette.push(p);
      });
      resolve(palette.map(function(p){return rgbToHex(p[0],p[1],p[2]);}));
    };
    img.onerror = function() { resolve([]); };
    img.src = imgSrc;
  });
}

var _paletteFile = null;

async function renderPalette(file) {
  _paletteFile = file;
  var el = document.getElementById('ins-palette');
  if (!el) return;
  el.innerHTML = '<span style="color:var(--text-3);font-size:11px">Extracting...</span>';
  var src = file.hasThumbnail ? ('/api/thumb/' + file.id) : null;
  if (!src) { el.innerHTML = ''; return; }
  var colors = await extractPalette(src, 8);
  el.innerHTML = '';
  colors.forEach(function(hex) {
    var sw = document.createElement('div');
    sw.className = 'palette-swatch';
    sw.style.background = hex;
    sw.innerHTML = '<div class="palette-tooltip">' + hex + '</div>';
    sw.addEventListener('click', function() { showPickedColor(hex); });
    el.appendChild(sw);
  });
}

function showPickedColor(hex) {
  var row = document.getElementById('picked-color-row');
  var sw = document.getElementById('picked-swatch');
  var hexEl = document.getElementById('picked-hex');
  if (!row) return;
  row.classList.remove('hidden');
  row.style.display = 'flex';
  if (sw) sw.style.background = hex;
  if (hexEl) { hexEl.textContent = hex; hexEl.dataset.hex = hex; }
}

document.querySelectorAll('.palette-copy-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    var hexEl = document.getElementById('picked-hex');
    if (!hexEl || !hexEl.dataset.hex) return;
    var text = formatColor(hexEl.dataset.hex, this.dataset.fmt);
    navigator.clipboard.writeText(text).catch(function(){});
    showToast(text + ' copied');
  });
});

var _reBtn = document.getElementById('reextract-btn');
if (_reBtn) _reBtn.addEventListener('click', function() { if (_paletteFile) renderPalette(_paletteFile); });

var _edBtn = document.getElementById('eyedropper-btn');
if (_edBtn) _edBtn.addEventListener('click', async function() {
  if (!window.EyeDropper) {
    var fb = document.getElementById('frame-eyedropper-btn');
    if (fb) fb.click();
    return;
  }
  this.classList.add('active');
  try { var r = await (new EyeDropper()).open(); showPickedColor(r.sRGBHex); showToast(r.sRGBHex + ' picked'); } catch(e) {}
  this.classList.remove('active');
});

var _frBtn = document.getElementById('frame-eyedropper-btn');
if (_frBtn) _frBtn.addEventListener('click', function() {
  var vid = document.getElementById('inspector-video');
  if (!vid || !vid.src || !_paletteFile) { showToast('Select a video first'); return; }
  var cv = document.createElement('canvas');
  cv.width = vid.videoWidth||320; cv.height = vid.videoHeight||180;
  var ctx = cv.getContext('2d'); ctx.drawImage(vid,0,0,cv.width,cv.height);
  var ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:9999;cursor:crosshair';
  var pv = document.createElement('div');
  pv.style.cssText = 'position:fixed;width:28px;height:28px;border-radius:50%;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.5);pointer-events:none;z-index:10000;transform:translate(-50%,-50%)';
  document.body.appendChild(pv); document.body.appendChild(ov);
  ov.addEventListener('mousemove', function(e) {
    pv.style.left=e.clientX+'px'; pv.style.top=e.clientY+'px';
    var vp=document.getElementById('inspector-preview'); if(!vp)return;
    var rc=vp.getBoundingClientRect();
    var px=Math.round((e.clientX-rc.left)/rc.width*cv.width);
    var py=Math.round((e.clientY-rc.top)/rc.height*cv.height);
    if(px>=0&&px<cv.width&&py>=0&&py<cv.height){var d=ctx.getImageData(px,py,1,1).data;pv.style.background=rgbToHex(d[0],d[1],d[2]);}
  });
  ov.addEventListener('click', function(e) {
    var vp=document.getElementById('inspector-preview'); if(vp){
      var rc=vp.getBoundingClientRect();
      var px=Math.round((e.clientX-rc.left)/rc.width*cv.width);
      var py=Math.round((e.clientY-rc.top)/rc.height*cv.height);
      if(px>=0&&px<cv.width&&py>=0&&py<cv.height){var d=ctx.getImageData(px,py,1,1).data;showPickedColor(rgbToHex(d[0],d[1],d[2]));}
    }
    cleanup();
  });
  function cleanup(){ov.remove();pv.remove();document.removeEventListener('keydown',esc);}
  function esc(e){if(e.key==='Escape')cleanup();}
  document.addEventListener('keydown',esc);
});

var _mEdBtn = document.getElementById('modal-eyedropper-btn');
if (_mEdBtn) _mEdBtn.addEventListener('click', function() {
  var vid = document.getElementById('modal-video');
  if (!vid || !vid.src) return;
  var cv = document.createElement('canvas');
  cv.width=vid.videoWidth||1280; cv.height=vid.videoHeight||720;
  var ctx=cv.getContext('2d'); ctx.drawImage(vid,0,0,cv.width,cv.height);
  var fcv=document.getElementById('frame-canvas');
  var hint=document.getElementById('eyedropper-hint');
  var btn=this; if(!fcv)return;
  fcv.width=cv.width; fcv.height=cv.height;
  fcv.getContext('2d').drawImage(vid,0,0,fcv.width,fcv.height);
  fcv.style.display='block'; if(hint)hint.classList.remove('hidden');
  btn.classList.add('active');
  var pv=document.createElement('div');
  pv.style.cssText='position:fixed;width:28px;height:28px;border-radius:50%;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.5);pointer-events:none;z-index:10000;transform:translate(-50%,-50%)';
  document.body.appendChild(pv);
  function onMove(e){
    pv.style.left=e.clientX+'px'; pv.style.top=e.clientY+'px';
    var rc=fcv.getBoundingClientRect();
    var px=Math.round((e.clientX-rc.left)/rc.width*cv.width);
    var py=Math.round((e.clientY-rc.top)/rc.height*cv.height);
    if(px>=0&&px<cv.width&&py>=0&&py<cv.height){var d=ctx.getImageData(px,py,1,1).data;pv.style.background=rgbToHex(d[0],d[1],d[2]);}
  }
  function onClick(e){
    var rc=fcv.getBoundingClientRect();
    var px=Math.round((e.clientX-rc.left)/rc.width*cv.width);
    var py=Math.round((e.clientY-rc.top)/rc.height*cv.height);
    if(px>=0&&px<cv.width&&py>=0&&py<cv.height){var d=ctx.getImageData(px,py,1,1).data;var hex=rgbToHex(d[0],d[1],d[2]);showPickedColor(hex);showToast(hex+' picked');}
    cleanup();
  }
  function cleanup(){fcv.style.display='none';if(hint)hint.classList.add('hidden');btn.classList.remove('active');pv.remove();fcv.removeEventListener('mousemove',onMove);fcv.removeEventListener('click',onClick);document.removeEventListener('keydown',onEsc);}
  function onEsc(e){if(e.key==='Escape')cleanup();}
  fcv.addEventListener('mousemove',onMove); fcv.addEventListener('click',onClick); document.addEventListener('keydown',onEsc);
});

// ===== KEYBOARD SHORTCUTS =====
document.addEventListener('keydown', function(e) {
  // input/textarea にフォーカス中は無視
  const tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  // モーダルが開いているときは矢印系だけ抑制
  const modalOpen = !document.getElementById('video-modal').classList.contains('hidden');

  switch (e.key) {
    case 'ArrowLeft':
    case 'ArrowRight': {
      if (modalOpen) return;
      e.preventDefault();
      const idx = state.filtered.findIndex(function(f) { return f.id === (state.selected && state.selected.id); });
      if (idx === -1) {
        if (state.filtered.length) {
          const first = state.filtered[0];
          const el = document.querySelector('[data-id="' + first.id + '"]');
          if (el) selectFile(first, el);
        }
        return;
      }
      const next = e.key === 'ArrowRight' ? Math.min(idx + 1, state.filtered.length - 1) : Math.max(idx - 1, 0);
      const file = state.filtered[next];
      const el = document.querySelector('[data-id="' + file.id + '"]');
      if (el) {
        selectFile(file, el);
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
      break;
    }
    case ' ':
      if (modalOpen) {
        e.preventDefault();
        const v = document.getElementById('modal-video');
        v.paused ? v.play() : v.pause();
      } else if (state.selected) {
        e.preventDefault();
        const iv = document.getElementById('inspector-video');
        if (iv) iv.paused ? iv.play() : iv.pause();
      }
      break;
    case 'Enter':
      if (!modalOpen && state.selected) { e.preventDefault(); openVideoModal(state.selected); }
      break;
    case 'Escape':
      if (modalOpen) { e.preventDefault(); closeVideoModal(); }
      break;
    case 'i': case 'I':
      if (!modalOpen) {
        if (state.selected) {
          const inspector = document.getElementById('inspector-content');
          if (!inspector.classList.contains('hidden')) closeInspector();
          else openInspector(state.selected);
        }
      }
      break;
    case 't': case 'T':
      if (!modalOpen) { e.preventDefault(); document.getElementById('ins-tag-input').focus(); }
      break;
    case 's': case 'S':
      if (!modalOpen && state.selected) { e.preventDefault(); saveMeta(); }
      break;
    case 'r': case 'R':
      if (!modalOpen) { e.preventDefault(); loadFiles(); }
      break;
    case 'd': case 'D':
      if (!modalOpen) { e.preventDefault(); openDownload(); }
      break;
    case 'Delete':
    case 'Backspace':
      if (!modalOpen) {
        e.preventDefault();
        if (state.selectedIds && state.selectedIds.size > 1) {
          if (confirm(state.selectedIds.size + ' 件をゴミ箱に移動しますか？')) {
            api('DELETE', '/batch/files', { ids: [...state.selectedIds] }).then(function() {
              showToast(state.selectedIds.size + ' 件をゴミ箱に移動しました');
              state.selectedIds.clear();
              loadFiles();
            });
          }
        } else if (state.selected) {
          if (confirm('"' + state.selected.name + '" をゴミ箱に移動しますか？')) {
            api('DELETE', '/files/' + state.selected.id).then(function() {
              showToast(state.selected.name + ' をゴミ箱に移動しました');
              loadFiles();
            });
          }
        }
      }
      break;
    case '0': case '1': case '2': case '3': case '4': case '5':
      if (!modalOpen && state.selected) {
        var rating = parseInt(e.key);
        state.inspectorMeta.rating = rating;
        document.querySelectorAll('.star').forEach(function(star) {
          star.classList.toggle('active', parseInt(star.dataset.value) <= rating);
        });
        autoSave();
        showToast('★ ' + rating);
      }
      break;
  }
});

// ===== SHORTCUT HELP =====
var _shBtn = document.getElementById('shortcut-help-btn');
var _shClose = document.getElementById('shortcut-close');
var _shModal = document.getElementById('shortcut-modal');
if (_shBtn) _shBtn.addEventListener('click', function() { _shModal.classList.remove('hidden'); });
if (_shClose) _shClose.addEventListener('click', function() { _shModal.classList.add('hidden'); });
if (_shModal) _shModal.addEventListener('click', function(e) {
  if (e.target === e.currentTarget || e.target.classList.contains('modal-backdrop')) {
    _shModal.classList.add('hidden');
  }
});

// ===== AUTO UPDATER UI =====
if (window.electronAPI) {
  window.electronAPI.onUpdateStatus(function(data) {
    if (data.type === 'available') {
      showUpdateBanner('🆕 v' + data.version + ' をダウンロード中...', false);
    } else if (data.type === 'progress') {
      showUpdateBanner('⬇ アップデートをダウンロード中... ' + data.percent + '%', false);
    } else if (data.type === 'downloaded') {
      showUpdateBanner('✅ v' + data.version + ' の準備完了', true);
    }
  });
  // アップデートチェック失敗通知
  window.electronAPI.onUpdateError(function(data) {
    showToast('アップデートの確認に失敗しました');
  });
}

function showUpdateBanner(msg, showInstall) {
  var existing = document.getElementById('update-banner');
  if (existing) existing.remove();
  var banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#1a2a1a;border-top:1px solid #28c840;color:#e8e8ea;font-size:13px;padding:10px 16px;display:flex;align-items:center;gap:10px;z-index:9999';
  var text = document.createElement('span');
  text.textContent = msg;
  text.style.flex = '1';
  banner.appendChild(text);
  if (showInstall) {
    var btn = document.createElement('button');
    btn.textContent = '今すぐ再起動して更新';
    btn.style.cssText = 'background:#28c840;color:#000;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600';
    btn.addEventListener('click', function() {
      if (window.electronAPI) window.electronAPI.installUpdate();
    });
    banner.appendChild(btn);
    var dismiss = document.createElement('button');
    dismiss.textContent = '後で';
    dismiss.style.cssText = 'background:none;color:var(--text-3);border:none;padding:6px 10px;cursor:pointer;font-size:12px';
    dismiss.addEventListener('click', function() { banner.remove(); });
    banner.appendChild(dismiss);
  }
  document.body.appendChild(banner);
}

// ===== INIT =====
  loadLibraries().then(loadFiles);
} // end initUI

document.addEventListener('DOMContentLoaded', initUI);

