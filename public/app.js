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

// ===== FILTERS =====
function applyFilters() {
  let files = [...state.files];

  if (state.activeNav === 'collection' && state.activeCollection) {
    const col = state.collections.find(c => c.id === state.activeCollection);
    const ids = col ? col.items : [];
    // 繧ｳ繝ｬ繧ｯ繧ｷ繝ｧ繝ｳ縺ｮ荳ｦ縺ｳ鬆・ｒ菫晄戟
    const idOrder = {};
    ids.forEach((id, i) => { idOrder[id] = i; });
    files = files.filter(f => idOrder[f.id] !== undefined);
    files.sort((a, b) => idOrder[a.id] - idOrder[b.id]);
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
    el.addEventListener('click', function(e) {
      if (e.ctrlKey || e.metaKey) return;
      selectFile(file, el);
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
}

// ===== SELECT & INSPECTOR =====
function selectFile(file, el) {
  document.querySelectorAll('.card.selected, .list-row.selected').forEach(function(c) { c.classList.remove('selected'); });
  if (state.selected && state.selected.id === file.id) {
    state.selected = null;
    closeInspector();
    return;
  }
  el.classList.add('selected');
  state.selected = file;
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
      // 繧ｵ繝悶Γ繝九Η繝ｼ陦ｨ遉ｺ
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
      if (confirm('"' + file.name + '" をゴミ箱に移動しますか？')) {
        await api('DELETE', '/files/' + file.id);
        showToast(file.name + ' をゴミ箱に移動しました');
        await loadFiles();
      }
    }
    removeContextMenu();
  });
  document.body.appendChild(menu);
  state.ctxMenu = menu;
  setTimeout(function() { document.addEventListener('click', removeContextMenu, { once: true }); }, 0);
}

function removeContextMenu() {
  if (state.ctxMenu) { state.ctxMenu.remove(); state.ctxMenu = null; }
}

// ===== CONTROLS & INIT (DOM ready) =====
function initUI() {
  document.getElementById('zoom-slider').addEventListener('input', function(e) {
    state.thumbSize = parseInt(e.target.value);
    document.getElementById('gallery').style.setProperty('--thumb-size', state.thumbSize + 'px');
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
  applyFilters();
});

document.getElementById('view-grid').addEventListener('click', function() {
  state.view = 'grid';
  document.getElementById('gallery').className = 'grid-view';
  document.getElementById('view-grid').classList.add('active');
  document.getElementById('view-list').classList.remove('active');
  renderGallery();
});
document.getElementById('view-list').addEventListener('click', function() {
  state.view = 'list';
  document.getElementById('gallery').className = 'list-view';
  document.getElementById('view-list').classList.add('active');
  document.getElementById('view-grid').classList.remove('active');
  renderGallery();
});

document.querySelectorAll('.nav-item').forEach(function(item) {
  item.addEventListener('click', function() {
    document.querySelectorAll('.nav-item').forEach(function(i) { i.classList.remove('active'); });
    item.classList.add('active');
    state.activeNav = item.dataset.view;
    state.activeFolder = null;
    state.activeTag = null;
    document.querySelectorAll('.folder-item').forEach(function(f) { f.classList.remove('active'); });
    document.querySelectorAll('.tag-pill-nav').forEach(function(t) { t.classList.remove('active'); });
    const labels = { all: 'Library', untagged: 'Untagged', recent: 'Recently Added' };
    document.getElementById('breadcrumb').textContent = labels[state.activeNav] || 'Library';
    applyFilters();
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

// 繝｢繝ｼ繝繝ｫ縺碁哩縺倥※縺・ｋ縺ｨ縺阪・蜿ｳ繧ｯ繝ｪ繝・け繝｡繝九Η繝ｼ繧貞・縺輔↑縺・
modalVideo.addEventListener('contextmenu', function(e) {
  // 繝｢繝ｼ繝繝ｫ閾ｪ菴薙′髱櫁｡ｨ遉ｺ縺ｪ繧我ｽ輔ｂ縺励↑縺・
  if (document.getElementById('video-modal').classList.contains('hidden')) return;
  e.preventDefault();
  e.stopPropagation();
  // 繝｢繝ｼ繝繝ｫ蜀・・逶ｸ蟇ｾ蠎ｧ讓吶〒驟咲ｽｮ
  const modal = document.querySelector('.modal-content');
  const rect = modal.getBoundingClientRect();
  let menuX = e.clientX - rect.left;
  let menuY = e.clientY - rect.top;
  // 逕ｻ髱｢遶ｯ縺ｫ縺ｯ縺ｿ蜃ｺ縺輔↑縺・ｈ縺・ｪｿ謨ｴ
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
    // canvas 縺ｫ謠冗判縺励※繧ｯ繝ｪ繝・・繝懊・繝峨∈
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
        showToast('繝輔Ξ繝ｼ繝繧偵さ繝斐・縺励∪縺励◆');
      } catch (err) {
        // Electron迺ｰ蠅・〒縺ｯClipboard API縺悟宛髯舌＆繧後ｋ蝣ｴ蜷・
        // fallback: 譁ｰ縺励＞繧ｿ繝悶〒逕ｻ蜒上ｒ髢九￥
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        showToast('繝輔Ξ繝ｼ繝繧呈眠縺励＞繧ｿ繝悶〒髢九″縺ｾ縺励◆');
      }
    }, 'image/png');
  }

  if (action === 'save-frame') {
    // 繧ｵ繝ｼ繝舌・邨檎罰縺ｧFFmpeg繝輔Ξ繝ｼ繝繧貞叙蠕励＠縺ｦ菫晏ｭ・
    const url = '/api/frame/' + id + '?t=' + currentTime.toFixed(3);
    const a = document.createElement('a');
    a.href = url;
    a.download = (state.selected.name.replace(/\.[^.]+$/, '')) + '_' + currentTime.toFixed(2) + 's.jpg';
    a.click();
    showToast('繝輔Ξ繝ｼ繝繧剃ｿ晏ｭ倥＠縺ｾ縺励◆');
  }

  if (action === 'set-thumb') {
    // 迴ｾ蝨ｨ繝輔Ξ繝ｼ繝繧偵し繝繝阪う繝ｫ縺ｫ險ｭ螳・
    const r = await fetch('/api/set-thumb/' + id + '?t=' + currentTime.toFixed(3), { method: 'POST' });
    if (r.ok) {
      // 繧ｮ繝｣繝ｩ繝ｪ繝ｼ繧ｫ繝ｼ繝峨・繧ｵ繝繝阪う繝ｫ繧呈峩譁ｰ
      const card = document.querySelector('[data-id="' + id + '"]');
      if (card) {
        const img = card.querySelector('img.card-video-thumb');
        if (img) img.src = '/api/thumb/' + id + '?t=' + Date.now();
      }
      const file = state.files.find(function(f) { return f.id === id; });
      if (file) file.hasThumbnail = true;
      showToast('繧ｵ繝繝阪う繝ｫ繧呈峩譁ｰ縺励∪縺励◆');
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

// URL繝壹・繧ｹ繝医〒蜊ｳ繧ｹ繧ｿ繝ｼ繝・
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
    '<div class="dl-job-filename" id="dl-filename-' + jobId + '">貅門ｙ荳ｭ...</div>' +
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
      if (statusEl) { statusEl.textContent = '笨・Done'; statusEl.className = 'dl-job-status done'; }
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
  // 迴ｾ蝨ｨ縺ｮ險ｭ螳壹ｒ蜿門ｾ・
  try {
    const s = await api('GET', '/settings');
    document.getElementById('settings-library-path').value = s.libraryPath || '';
    document.getElementById('settings-current-path').textContent = s.libraryPath || '?';
    document.getElementById('settings-thumb-dir').textContent = s.thumbDir || '?';
    document.getElementById('settings-path-status').textContent = '';
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

document.getElementById('settings-path-apply').addEventListener('click', async function() {
  const newPath = document.getElementById('settings-library-path').value.trim();
  const status = document.getElementById('settings-path-status');
  if (!newPath) { status.textContent = '繝代せ繧貞・蜉帙＠縺ｦ縺上□縺輔＞'; status.className = 'err'; return; }
  status.textContent = '遒ｺ隱堺ｸｭ...'; status.className = '';
  try {
    const r = await api('PUT', '/settings', { libraryPath: newPath });
    document.getElementById('settings-current-path').textContent = r.libraryPath;
    status.textContent = '笨・驕ｩ逕ｨ縺励∪縺励◆縲ゅΛ繧､繝悶Λ繝ｪ繧偵Μ繝ｭ繝ｼ繝峨＠縺ｾ縺・..';
    status.className = 'ok';
    setTimeout(async () => {
      closeSettings();
      await loadFiles();
    }, 800);
  } catch (e) {
    const msg = e.message || '繧ｨ繝ｩ繝ｼ縺檎匱逕溘＠縺ｾ縺励◆';
    status.textContent = '笨・' + msg;
    status.className = 'err';
  }
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
    const item = document.createElement('div');
    item.className = 'collection-item' + (state.activeCollection === col.id ? ' active' : '');
    item.innerHTML =
      '<span class="col-icon">\uD83D\uDDC2</span>' +
      '<span class="col-name">' + col.name + '</span>' +
      '<span class="col-count">' + (col.items || []).length + '</span>' +
      '<button class="col-delete" data-id="' + col.id + '">\u2715</button>';
    item.addEventListener('click', function(e) {
      if (e.target.classList.contains('col-delete')) return;
      state.activeCollection = state.activeCollection === col.id ? null : col.id;
      state.activeNav = state.activeCollection ? 'collection' : 'all';
      document.querySelectorAll('.nav-item,.folder-item,.tag-pill-nav,.collection-item').forEach(function(el) { el.classList.remove('active'); });
      if (state.activeCollection) item.classList.add('active');
      document.getElementById('breadcrumb').textContent = col.name;
      applyFilters();
    });
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

// 繧ｳ繝ｬ繧ｯ繧ｷ繝ｧ繝ｳ縺九ｉ蜑企勁・・nspector 縺ｮ Remove 繝懊ち繝ｳ逕ｨ・・
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
  // input/textarea 縺ｫ繝輔か繝ｼ繧ｫ繧ｹ荳ｭ縺ｯ辟｡隕・
  const tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  // 繝｢繝ｼ繝繝ｫ縺碁幕縺・※縺・ｋ縺ｨ縺阪・遏｢蜊ｰ邉ｻ縺縺第椛蛻ｶ
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
  loadFiles();
} // end initUI

document.addEventListener('DOMContentLoaded', initUI);

