// Feedster front end: sidebar of folders/feeds, article list, reader pane.

const $ = (sel, el = document) => el.querySelector(sel);
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`feedster:${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`feedster:${key}`, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

const S = {
  folders: [],
  feeds: [],
  totals: { unread: 0, starred: 0 },
  scope: store.get('scope', { type: 'all' }),
  view: store.get('view', 'unread'),
  layout: store.get('layout', 'list'),
  theme: store.get('theme', 'auto'),
  oldestFirst: store.get('oldestFirst', false),
  markOnScroll: store.get('markOnScroll', false),
  collapsed: new Set(store.get('collapsed', [])),
  q: '',
  items: [],
  cursor: null,
  loading: false,
  selected: -1,
  open: -1, // classic layout: the article expanded under its headline
  listToken: 0,
};

// ---------------------------------------------------------------- api

/** Links from feeds, if they are web addresses. Older articles may hold anything, such as javascript: links. */
const webUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');

// Tells the browser extension, if installed, that unread counts may have changed.
const announceChange = () => window.dispatchEvent(new Event('feedster:changed'));

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'X-Feedster': '1', ...(opts.body && typeof opts.body === 'string' && !opts.raw && { 'Content-Type': 'application/json' }) },
  });
  if (res.status === 401) { location.reload(); throw new Error('Signed out'); }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  if (opts.method && opts.method !== 'GET') announceChange();
  return data;
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });
const patch = (path, body) => api(path, { method: 'PATCH', body: JSON.stringify(body) });
const del = (path) => api(path, { method: 'DELETE' });

// ---------------------------------------------------------------- helpers

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const feedById = (id) => S.feeds.find((f) => f.id === id);
const folderById = (id) => S.folders.find((f) => f.id === id);

function timeUntil(ts) {
  const m = Math.max(1, Math.round((ts - Date.now()) / 60_000));
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}

function timeAgo(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }) });
}

const feedLetter = (feed) => (feed.title || '?').trim()[0]?.toUpperCase() || '?';

// The server keeps each feed's icon (its own image, else the site's favicon); `icon` is
// its version, or null when there is none and a letter is shown instead.
function favicon(feed) {
  if (!feed.icon) return `<span class="favicon letter">${esc(feedLetter(feed))}</span>`;
  return `<img class="favicon" src="/api/feeds/${feed.id}/icon?v=${feed.icon}" alt="" loading="lazy" data-letter="${esc(feedLetter(feed))}">`;
}

// Replace icons that fail to load with the letter.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName === 'IMG' && img.classList.contains('favicon')) {
    const span = document.createElement('span');
    span.className = 'favicon letter';
    span.textContent = img.dataset.letter;
    img.replaceWith(span);
  } else if (img.tagName === 'IMG' && img.classList.contains('thumb')) {
    img.remove();
  }
}, true);

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

function scopeLabel() {
  const { type, id } = S.scope;
  if (type === 'starred') return 'Starred';
  if (type === 'folder') return folderById(id)?.name || 'Folder';
  if (type === 'feed') return feedById(id)?.title || 'Feed';
  return 'All articles';
}

function scopeParams() {
  const p = new URLSearchParams();
  const { type, id } = S.scope;
  if (type === 'feed') p.set('feed', id);
  if (type === 'folder') p.set('folder', id);
  p.set('view', type === 'starred' ? 'starred' : S.view);
  if (S.q) p.set('q', S.q);
  if (S.oldestFirst) p.set('order', 'oldest');
  if (S.layout === 'cards') p.set('full', '1');
  return p;
}

function scopeUnread() {
  const { type, id } = S.scope;
  if (type === 'feed') return feedById(id)?.unread || 0;
  if (type === 'folder') return S.feeds.filter((f) => f.folder_id === id).reduce((n, f) => n + f.unread, 0);
  if (type === 'starred') return S.totals.starred;
  return S.totals.unread;
}

// ---------------------------------------------------------------- state & sidebar

async function loadState() {
  const s = await api('/api/state');
  // New articles from a refresh also change the count.
  if (S.totals.unread !== s.totals.unread) announceChange();
  Object.assign(S, { folders: s.folders, feeds: s.feeds, totals: s.totals });
  // Drop a remembered scope whose feed/folder no longer exists.
  if ((S.scope.type === 'feed' && !feedById(S.scope.id)) || (S.scope.type === 'folder' && !folderById(S.scope.id))) {
    S.scope = { type: 'all' };
  }
  renderNav();
  renderHeader();
  showVersion(s);
  setRefreshing(s.refreshing);
  return s;
}

// Shows the running version, and a banner when a newer release exists (until dismissed for that version)
function showVersion(s) {
  const release = webUrl(s.update?.url) ? `<a href="${esc(s.update.url)}" target="_blank" rel="noopener noreferrer">` : '';
  $('#version').innerHTML = `Feedster ${esc(s.version === 'dev' ? '(development build)' : `v${s.version}`)}`
    + (s.update ? ` · ${release || '<span>'}<span class="new">v${esc(s.update.version)} available</span>${release ? '</a>' : '</span>'}` : '');
  const banner = $('#update');
  banner.hidden = !s.update || store.get('update-dismissed', null) === s.update.version;
  if (banner.hidden) return;
  banner.innerHTML = `<span><b>Version ${esc(s.update.version)} is available</b> (you have ${esc(s.version)}).
    ${release ? `${release}What's new</a> · ` : ''}update with <code>docker compose pull &amp;&amp; docker compose up -d</code></span>
    <button type="button">Dismiss</button>`;
  banner.querySelector('button').onclick = () => {
    store.set('update-dismissed', s.update.version);
    banner.hidden = true;
  };
}

function navItem({ cls = '', icon, label, count, scope, menu = '', attrs = '' }) {
  const active = S.scope.type === scope.type && S.scope.id === scope.id;
  return `<button class="nav-item ${cls} ${active ? 'active' : ''} ${count ? 'has-unread' : ''}"
      data-scope='${JSON.stringify(scope)}' ${attrs}>
    ${icon}<span class="label">${esc(label)}</span>
    ${count ? `<span class="count">${count > 999 ? '999+' : count}</span>` : ''}
    ${menu ? `<span class="more" role="button" data-menu='${menu}' title="Options">⋯</span>` : ''}
  </button>`;
}

function renderNav() {
  const feedRow = (f) => navItem({
    cls: f.last_error ? 'error' : '',
    icon: favicon(f),
    label: f.title,
    count: f.unread,
    scope: { type: 'feed', id: f.id },
    menu: JSON.stringify({ type: 'feed', id: f.id }),
    attrs: `draggable="true" data-feed="${f.id}" title="${esc(f.last_error ? `Error: ${f.last_error}` : f.title)}"`,
  });

  let html = navItem({ icon: '<span class="glyph">☰</span>', label: 'All articles', count: S.totals.unread, scope: { type: 'all' } });
  html += navItem({ icon: '<span class="glyph">★</span>', label: 'Starred', count: S.totals.starred, scope: { type: 'starred' } });
  html += `<div class="nav-section" data-drop-folder="">Subscriptions</div>`;

  for (const folder of S.folders) {
    const feeds = S.feeds.filter((f) => f.folder_id === folder.id);
    const collapsed = S.collapsed.has(folder.id);
    html += navItem({
      icon: `<span class="twisty" data-toggle="${folder.id}">${collapsed ? '▶' : '▼'}</span>`,
      label: folder.name,
      count: feeds.reduce((n, f) => n + f.unread, 0),
      scope: { type: 'folder', id: folder.id },
      menu: JSON.stringify({ type: 'folder', id: folder.id }),
      attrs: `data-drop-folder="${folder.id}"`,
    });
    html += `<div class="folder-children ${collapsed ? 'collapsed' : ''}">${feeds.map(feedRow).join('')}</div>`;
  }
  html += S.feeds.filter((f) => !f.folder_id).map(feedRow).join('');
  if (!S.feeds.length) html += `<p class="muted" style="padding:4px 8px">No subscriptions yet.</p>`;

  $('#nav').innerHTML = html;
  document.title = S.totals.unread ? `(${S.totals.unread}) Feedster` : 'Feedster';
}

function renderHeader() {
  $('#scopeTitle').textContent = scopeLabel();
  const n = scopeUnread();
  $('#scopeCount').textContent = S.scope.type === 'starred' ? `${n} starred` : `${n} unread`;
  for (const b of $('#viewSeg').children) b.classList.toggle('on', b.dataset.view === S.view);
  $('#viewSeg').hidden = S.scope.type === 'starred';
  for (const b of $('#layoutSeg').children) b.classList.toggle('on', b.dataset.layout === S.layout);
  $('#app').classList.toggle('layout-cards', S.layout === 'cards');
  $('#app').classList.toggle('layout-classic', S.layout === 'classic');
}

function setScope(scope) {
  S.scope = scope;
  store.set('scope', scope);
  $('#app').classList.remove('nav-open');
  renderNav();
  renderHeader();
  loadArticles();
}

$('#nav').addEventListener('click', (e) => {
  const toggle = e.target.closest('[data-toggle]');
  if (toggle) {
    const id = Number(toggle.dataset.toggle);
    S.collapsed.has(id) ? S.collapsed.delete(id) : S.collapsed.add(id);
    store.set('collapsed', [...S.collapsed]);
    renderNav();
    return;
  }
  const more = e.target.closest('[data-menu]');
  if (more) {
    e.stopPropagation();
    openEntityMenu(JSON.parse(more.dataset.menu), more.getBoundingClientRect());
    return;
  }
  const item = e.target.closest('.nav-item');
  if (item) setScope(JSON.parse(item.dataset.scope));
});

$('#nav').addEventListener('contextmenu', (e) => {
  const item = e.target.closest('.nav-item [data-menu]')?.closest('.nav-item') || e.target.closest('.nav-item');
  const menuEl = item?.querySelector('[data-menu]');
  if (!menuEl) return;
  e.preventDefault();
  openEntityMenu(JSON.parse(menuEl.dataset.menu), { left: e.clientX, bottom: e.clientY, right: e.clientX });
});

// Drag feeds onto folders (or the "Subscriptions" heading) to move them.
$('#nav').addEventListener('dragstart', (e) => {
  const feed = e.target.closest('[data-feed]');
  if (feed) e.dataTransfer.setData('text/feed', feed.dataset.feed);
});
$('#nav').addEventListener('dragover', (e) => {
  const target = e.target.closest('[data-drop-folder]');
  if (!target || !e.dataTransfer.types.includes('text/feed')) return;
  e.preventDefault();
  document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
  target.classList.add('drop-target');
});
$('#nav').addEventListener('dragleave', (e) => e.target.closest?.('[data-drop-folder]')?.classList.remove('drop-target'));
$('#nav').addEventListener('drop', async (e) => {
  const target = e.target.closest('[data-drop-folder]');
  const feedId = Number(e.dataTransfer.getData('text/feed'));
  if (!target || !feedId) return;
  e.preventDefault();
  await patch(`/api/feeds/${feedId}`, { folderId: Number(target.dataset.dropFolder) || null });
  await loadState();
});

// ---------------------------------------------------------------- menus

function openMenu(items, rect) {
  const menu = $('#menu');
  menu.innerHTML = items.map((it, i) => {
    if (it === '-') return '<hr>';
    if (it.label && !it.run) return `<div class="menu-label">${esc(it.label)}</div>`;
    return `<button data-i="${i}" class="${it.danger ? 'danger' : ''}">${esc(it.text)}</button>`;
  }).join('');
  menu.hidden = false;
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - w - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, innerHeight - h - 8))}px`;
  menu.onclick = (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    closeMenu();
    Promise.resolve(items[Number(b.dataset.i)].run()).catch((err) => toast(err.message));
  };
}
function closeMenu() { $('#menu').hidden = true; }
document.addEventListener('click', (e) => { if (!e.target.closest('#menu')) closeMenu(); });

function openEntityMenu({ type, id }, rect) {
  const items = [];
  if (type === 'feed') {
    const feed = feedById(id);
    items.push(
      { text: 'Mark all as read', run: () => markAllRead({ feed: id }) },
      { text: 'Refresh feed', run: async () => { const r = await post('/api/refresh', { feed: id }); toast(`${r.added} new article${r.added === 1 ? '' : 's'}`); await reloadAll(); } },
      { text: 'Rename…', run: async () => {
        const title = prompt('Feed name', feed.title);
        if (title?.trim()) { await patch(`/api/feeds/${id}`, { title: title.trim() }); await loadState(); }
      } },
    );
    if (webUrl(feed.site_url)) items.push({ text: 'Open website', run: () => window.open(feed.site_url, '_blank', 'noopener') });
    items.push('-', { label: 'Move to' });
    items.push({ text: `${feed.folder_id ? '' : '✓ '}No folder`, run: () => moveFeed(id, null) });
    for (const f of S.folders) items.push({ text: `${feed.folder_id === f.id ? '✓ ' : ''}${f.name}`, run: () => moveFeed(id, f.id) });
    items.push({ text: 'New folder…', run: async () => { const folder = await createFolder(); if (folder) await moveFeed(id, folder.id); } });
    items.push('-', { text: 'Unsubscribe', danger: true, run: async () => {
      if (!confirm(`Unsubscribe from “${feed.title}”? Its articles (including starred ones) will be removed.`)) return;
      await del(`/api/feeds/${id}`);
      if (S.scope.type === 'feed' && S.scope.id === id) S.scope = { type: 'all' };
      await reloadAll();
    } });
  } else if (type === 'folder') {
    const folder = folderById(id);
    items.push(
      { text: 'Mark all as read', run: () => markAllRead({ folder: id }) },
      { text: 'Rename…', run: async () => {
        const name = prompt('Folder name', folder.name);
        if (name?.trim()) { await patch(`/api/folders/${id}`, { name: name.trim() }); await loadState(); }
      } },
      '-',
      { text: 'Delete folder', danger: true, run: async () => {
        if (!confirm(`Delete folder “${folder.name}”? Its feeds move to the top level.`)) return;
        await del(`/api/folders/${id}`);
        if (S.scope.type === 'folder' && S.scope.id === id) S.scope = { type: 'all' };
        await reloadAll();
      } },
    );
  }
  openMenu(items, rect);
}

async function moveFeed(id, folderId) {
  await patch(`/api/feeds/${id}`, { folderId });
  await loadState();
}

async function createFolder() {
  const name = prompt('Folder name');
  if (!name?.trim()) return null;
  const folder = await post('/api/folders', { name: name.trim() });
  await loadState();
  return folder;
}

$('#scopeMenuBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const scope = scopeFilter();
  const day = 86_400_000;
  const items = [
    { text: 'Mark older than 1 day as read', run: () => markAllRead({ ...scope, olderThan: Date.now() - day }) },
    { text: 'Mark older than 1 week as read', run: () => markAllRead({ ...scope, olderThan: Date.now() - 7 * day }) },
    { text: `${S.oldestFirst ? '✓ ' : ''}Oldest first`, run: () => setOldestFirst(!S.oldestFirst) },
  ];
  if (S.scope.type === 'feed' || S.scope.type === 'folder') {
    items.push('-', { text: `${S.scope.type === 'feed' ? 'Feed' : 'Folder'} options…`, run: () => openEntityMenu(S.scope, e.target.getBoundingClientRect()) });
  }
  openMenu(items, e.target.getBoundingClientRect());
});

// ---------------------------------------------------------------- article list

function scopeFilter() {
  const { type, id } = S.scope;
  return { ...(type === 'feed' && { feed: id }), ...(type === 'folder' && { folder: id }), ...(type === 'starred' && { view: 'starred' }), ...(S.q && { q: S.q }) };
}

async function loadArticles({ keepSelection = false } = {}) {
  const token = ++S.listToken;
  const prevId = keepSelection ? S.items[S.selected]?.id : null;
  S.loading = true;
  const data = await api(`/api/articles?${scopeParams()}`);
  if (token !== S.listToken) return; // a newer load superseded this one
  S.items = data.items;
  S.cursor = data.cursor;
  S.loading = false;
  S.selected = prevId ? S.items.findIndex((a) => a.id === prevId) : -1;
  S.open = -1;
  $('#articles').scrollTop = 0;
  renderList();
  if (S.selected < 0) showEmptyReader();
}

async function loadMore() {
  if (S.loading || !S.cursor) return;
  const token = S.listToken;
  S.loading = true;
  const p = scopeParams();
  p.set('cursor', S.cursor);
  const data = await api(`/api/articles?${p}`);
  S.loading = false;
  if (token !== S.listToken) return;
  const start = S.items.length;
  S.items.push(...data.items);
  S.cursor = data.cursor;
  appendItems(start);
}

/** Classic layout: one line per article (star, feed, headline and the start of its text, date). */
function classicRow(a) {
  return `<div class="crow">
    <button class="cstar ${a.starred ? 'on' : ''}" data-act="star" title="Star (s)">${a.starred ? '★' : '☆'}</button>
    <span class="csrc">${esc(a.feed_title)}</span>
    <span class="ctext"><span class="ct">${esc(a.title)}</span>${a.snippet ? `<span class="cs"> – ${esc(a.snippet)}</span>` : ''}</span>
    <span class="cdate" title="${esc(new Date(a.published).toLocaleString())}">${timeAgo(a.published)}</span>
  </div>`;
}

function itemHtml(a, i) {
  if (S.layout === 'classic') {
    const open = i === S.open;
    return `<div class="entry ${a.read ? 'read' : ''} ${i === S.selected ? 'selected' : ''} ${open ? 'open' : ''}" data-i="${i}">${classicRow(a)}${open ? `<div class="entry-body">${articleHtml(a)}</div>` : ''}</div>`;
  }
  if (S.layout === 'cards') {
    return `<div class="card ${a.read ? 'read' : ''} ${i === S.selected ? 'selected' : ''}" data-i="${i}">${articleHtml(a)}</div>`;
  }
  return `<div class="item ${a.read ? 'read' : ''} ${i === S.selected ? 'selected' : ''}" data-i="${i}">
    <div class="meta"><span class="src">${esc(a.feed_title)}</span>${a.starred ? '<span class="star">★</span>' : ''}<span class="date" title="${esc(new Date(a.published).toLocaleString())}">${timeAgo(a.published)}</span></div>
    <div class="t">${esc(a.title)}</div>
    ${webUrl(a.image) ? `<img class="thumb" src="${esc(a.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
    <div class="s">${esc(a.snippet)}</div>
  </div>`;
}

function listFooter() {
  if (S.cursor) return '<div class="list-end">Loading…</div>';
  if (!S.items.length) {
    if (!S.feeds.length) return `<div class="list-empty"><strong>Welcome to Feedster</strong>Add a subscription or import an OPML file from Settings to get started.</div>`;
    if (S.q) return `<div class="list-empty"><strong>No matches</strong>Nothing matches “${esc(S.q)}”.</div>`;
    if (S.scope.type === 'starred') return `<div class="list-empty"><strong>No starred articles</strong>Press <kbd>s</kbd> on an article to star it.</div>`;
    return `<div class="list-empty"><strong>All caught up</strong>${S.view === 'unread' ? 'No unread articles here.' : 'No articles yet.'}</div>`;
  }
  return '<div class="list-end">That’s everything.</div>';
}

function renderList() {
  $('#articles').innerHTML = S.items.map(itemHtml).join('') + listFooter();
  observeScroll();
}

function appendItems(start) {
  $('#articles').querySelector('.list-end, .list-empty')?.remove();
  $('#articles').insertAdjacentHTML('beforeend', S.items.slice(start).map((a, k) => itemHtml(a, start + k)).join('') + listFooter());
  observeScroll();
}

function updateItem(i) {
  const el = $(`#articles [data-i="${i}"]`);
  if (!el) return;
  const a = S.items[i];
  if (S.layout === 'classic') {
    // Only the headline line is redrawn, so an open article keeps its place and any playing media.
    el.classList.toggle('read', Boolean(a.read));
    el.classList.toggle('selected', i === S.selected);
    el.classList.toggle('open', i === S.open);
    const tmp = document.createElement('div');
    tmp.innerHTML = classicRow(a);
    el.querySelector('.crow').replaceWith(tmp.firstElementChild);
    const body = el.querySelector('.entry-body');
    if (i === S.open && !body) el.insertAdjacentHTML('beforeend', `<div class="entry-body">${articleHtml(a)}</div>`);
    else if (i !== S.open && body) body.remove();
    else if (body) syncArticleButtons(body, a);
    return;
  }
  if (S.layout === 'cards') {
    el.classList.toggle('read', Boolean(a.read));
    el.classList.toggle('selected', i === S.selected);
    syncArticleButtons(el, a);
    return;
  }
  const tmp = document.createElement('div');
  tmp.innerHTML = itemHtml(S.items[i], i);
  el.replaceWith(tmp.firstElementChild);
}

$('#articles').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]');
  const el = e.target.closest('[data-i]');
  if (!el) return;
  const i = Number(el.dataset.i);
  if (act) {
    e.preventDefault();
    if (act.dataset.act === 'star') toggleStar(i);
    if (act.dataset.act === 'read') toggleRead(i);
    if (act.dataset.act === 'open') openOriginal(i);
    if (act.dataset.act === 'fulltext') toggleFull(i);
    return;
  }
  if (S.layout === 'classic') {
    if (e.target.closest('.crow')) toggleOpen(i);
    else if (e.target.closest('a')) setRead(i, true);
    return;
  }
  if (S.layout === 'cards') {
    if (!e.target.closest('a')) select(i, { scroll: false });
    else setRead(i, true);
    return;
  }
  select(i);
});

$('#articles').addEventListener('scroll', () => {
  const el = $('#articles');
  if (el.scrollTop + el.clientHeight > el.scrollHeight - 600) loadMore();
}, { passive: true });

// In cards view, optionally mark articles read once they scroll past the top.
let scrollObserver;
function observeScroll() {
  scrollObserver?.disconnect();
  if (S.layout !== 'cards' || !S.markOnScroll) return;
  scrollObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting && entry.boundingClientRect.bottom < entry.rootBounds.top) {
        setRead(Number(entry.target.dataset.i), true);
      }
    }
  }, { root: $('#articles') });
  document.querySelectorAll('#articles .card').forEach((c) => scrollObserver.observe(c));
}

// ---------------------------------------------------------------- reader

function sanitize(html, baseUrl) {
  const clean = window.DOMPurify
    ? DOMPurify.sanitize(html || '', { ADD_ATTR: ['target'], FORBID_TAGS: ['style', 'form', 'input'], FORBID_ATTR: ['style'] })
    : esc(html);
  const tpl = document.createElement('template');
  tpl.innerHTML = clean;
  const resolve = (v) => { try { return new URL(v, baseUrl).href; } catch { return v; } };
  tpl.content.querySelectorAll('a[href]').forEach((a) => {
    a.href = resolve(a.getAttribute('href'));
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });
  tpl.content.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || img.dataset.src;
    if (src) img.src = resolve(src);
    img.removeAttribute('srcset');
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.removeAttribute('width');
    img.removeAttribute('height');
  });
  tpl.content.querySelectorAll('iframe').forEach((f) => f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups'));
  return tpl.innerHTML;
}

function articleHtml(a, opts) {
  return `<div class="reader-article">${articleInner(a, opts)}</div>`;
}

// Some feeds (MLB, many news sites) carry only headlines; point to the article instead of an empty page.
function headlineOnly(a) {
  let host = '';
  try { host = new URL(a.url).hostname.replace(/^www\./, ''); } catch { /* no link */ }
  return `<p class="muted">This feed only shares headlines, not the article text.</p>
    ${host && webUrl(a.url) ? `<p><a class="btn" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">Read the full article on ${esc(host)} ↗</a></p>` : ''}`;
}

// ---- full articles: fetched from the article's page by the server (see fulltext.js)

// Feeds with less text than this are treated as summaries and open the full article.
const SUMMARY_CHARS = 1500;
const fullTextPrefs = store.get('fullText', {});
const textLength = (html) => (html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().length;

/** Whether to show the full article: the reader's choice for this feed, else only for summary feeds. */
function wantsFull(a) {
  const pref = fullTextPrefs[a.feed_id];
  if (pref) return pref === 'full' && Boolean(a.url);
  return Boolean(a.url) && textLength(a.content) < SUMMARY_CHARS;
}

async function loadFull(a) {
  if (a.fullContent || a.fullError || a.fullLoading) return;
  a.fullLoading = true;
  try {
    const r = await api(`/api/articles/${a.id}/full`);
    if (r.content) a.fullContent = r.content;
    else a.fullError = r.error || 'not available';
  } catch (err) {
    a.fullError = err.message;
  }
  a.fullLoading = false;
}

/** Re-draw one article where it is shown: the reading pane, or its card. */
function rerenderArticle(i) {
  const a = S.items[i];
  if (!a) return;
  if (S.layout === 'cards') {
    const el = $(`#articles [data-i="${i}"]`);
    if (el) el.innerHTML = articleHtml(a);
  } else if (S.layout === 'classic') {
    const body = $(`#articles [data-i="${i}"] .entry-body`);
    if (body) body.innerHTML = articleHtml(a);
  } else if (i === S.selected) {
    $('#readerArticle').innerHTML = articleInner(a, { full: true });
  }
}

async function showFullIfWanted(i) {
  const a = S.items[i];
  if (a?.view !== 'full' || a.fullContent || a.fullError) return;
  const pending = loadFull(a);
  rerenderArticle(i); // shows "Loading the full article…"
  await pending;
  if (S.items[i] === a) rerenderArticle(i);
}

function toggleFull(i) {
  const a = S.items[i];
  if (!a?.url) return;
  a.view = a.view === 'full' ? 'feed' : 'full';
  fullTextPrefs[a.feed_id] = a.view;
  store.set('fullText', fullTextPrefs);
  toast(a.view === 'full' ? `Showing full articles for ${a.feed_title}` : `Showing the feed's text for ${a.feed_title}`);
  rerenderArticle(i);
  showFullIfWanted(i);
}

function articleInner(a, { full = false } = {}) {
  const content = a.content ?? '';
  const showFull = a.view === 'full';
  let body;
  let shown = content;
  if (showFull && a.fullContent) {
    body = sanitize(a.fullContent, a.url);
    shown = a.fullContent;
  } else {
    body = content.trim() ? sanitize(content, a.url || a.site_url) : headlineOnly(a);
    if (showFull && a.fullLoading) body = `<p class="ra-status">Loading the full article…</p>${content.trim() ? body : ''}`;
    if (showFull && a.fullError) body = `<p class="ra-status">Couldn't load the full article (${esc(a.fullError)}). Showing the feed's text.</p>${body}`;
  }
  const hasImage = a.image && !shown.includes(a.image.split('?')[0].split('/').pop());
  const date = new Date(a.published);
  return `
    <div class="ra-top">
      ${full ? '<button class="icon-btn mobile-only" data-act="back" title="Back">←</button>' : ''}
      <a class="src" href="#" data-feed-link="${a.feed_id}">${esc(a.feed_title)}</a>
      ${a.url ? `<button class="text-btn ${showFull ? 'on' : ''}" data-act="fulltext" aria-pressed="${showFull}"
        title="${showFull ? "Show the feed's text" : 'Show the full article from the website'} (f)">Full article</button>` : ''}
      <button class="icon-btn ${a.starred ? 'on' : ''}" data-act="star" title="Star (s)">${a.starred ? '★' : '☆'}</button>
      <button class="icon-btn" data-act="read" title="${a.read ? 'Mark as unread' : 'Mark as read'} (m)">◐</button>
      ${a.url ? '<button class="icon-btn" data-act="open" title="Open original (v)">↗</button>' : ''}
    </div>
    <h1 class="ra-title">${webUrl(a.url) ? `<a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.title)}</a>` : esc(a.title)}</h1>
    <div class="ra-byline">${a.author ? `${esc(a.author)} · ` : ''}<time title="${esc(date.toLocaleString())}">${esc(date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}</time></div>
    ${hasImage ? `<img class="ra-hero" src="${esc(a.image)}" alt="" referrerpolicy="no-referrer">` : ''}
    <div class="ra-body">${body}</div>`;
}

function showEmptyReader() {
  $('#readerEmpty').hidden = false;
  $('#readerArticle').hidden = true;
  $('#app').classList.remove('reading');
}

/**
 * Classic layout: move to an article and, unless `open` is false, expand it under its headline
 * (closing the one that was open) and mark it read.
 */
async function selectClassic(i, { open = true, scroll = true } = {}) {
  if (i < 0 || i >= S.items.length) return;
  const a = S.items[i];
  const prev = S.selected;
  S.selected = i;
  if (prev >= 0 && prev !== i) updateItem(prev);
  updateItem(i);
  if (i > S.items.length - 6) loadMore();
  if (!open) {
    if (scroll) $(`#articles [data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (a.content == null) a.content = (await api(`/api/articles/${a.id}`)).content;
  if (S.items[S.selected] !== a) return; // moved on while loading
  a.view ??= wantsFull(a) ? 'full' : 'feed';
  const wasOpen = S.open;
  S.open = i;
  if (wasOpen >= 0 && wasOpen !== i) updateItem(wasOpen);
  setRead(i, true);
  updateItem(i);
  if (scroll) $(`#articles [data-i="${i}"]`)?.scrollIntoView({ block: 'start' });
  showFullIfWanted(i);
}

/** Classic layout: expand an article, or close it if it's the one open. */
function toggleOpen(i) {
  if (i < 0 || i >= S.items.length) return;
  if (S.open !== i) return selectClassic(i);
  S.open = -1;
  S.selected = i;
  updateItem(i);
}

async function select(i, { scroll = true, open = true } = {}) {
  if (S.layout === 'classic') return selectClassic(i, { scroll, open });
  if (i < 0 || i >= S.items.length) return;
  const prev = S.selected;
  S.selected = i;
  if (prev >= 0) updateItem(prev);
  const a = S.items[i];
  setRead(i, true);
  updateItem(i);
  const el = $(`#articles [data-i="${i}"]`);
  if (scroll && el) el.scrollIntoView({ block: S.layout === 'cards' ? 'start' : 'nearest' });
  if (i > S.items.length - 6) loadMore();
  if (S.layout === 'cards') return;

  if (a.content == null) a.content = (await api(`/api/articles/${a.id}`)).content;
  if (S.items[S.selected]?.id !== a.id) return;
  a.view ??= wantsFull(a) ? 'full' : 'feed';
  const reader = $('#readerArticle');
  reader.innerHTML = articleInner(a, { full: true });
  reader.hidden = false;
  $('#readerEmpty').hidden = true;
  $('#reader').scrollTop = 0;
  $('#app').classList.add('reading');
  showFullIfWanted(i);
}

$('#reader').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]');
  if (act) {
    e.preventDefault();
    if (act.dataset.act === 'back') return $('#app').classList.remove('reading');
    if (act.dataset.act === 'star') toggleStar(S.selected);
    if (act.dataset.act === 'read') toggleRead(S.selected);
    if (act.dataset.act === 'open') openOriginal(S.selected);
    if (act.dataset.act === 'fulltext') toggleFull(S.selected);
  }
});

document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-feed-link]');
  if (!link) return;
  e.preventDefault();
  setScope({ type: 'feed', id: Number(link.dataset.feedLink) });
});

/** Match an article's star and read buttons to its state. */
function syncArticleButtons(root, a) {
  const star = root.querySelector('.ra-top [data-act="star"]');
  if (star) { star.classList.toggle('on', Boolean(a.starred)); star.textContent = a.starred ? '★' : '☆'; }
  const read = root.querySelector('.ra-top [data-act="read"]');
  if (read) read.title = `${a.read ? 'Mark as unread' : 'Mark as read'} (m)`;
}

function refreshReaderButtons() {
  const a = S.items[S.selected];
  if (!a || S.layout !== 'list') return; // cards and classic redraw theirs in updateItem
  syncArticleButtons($('#readerArticle'), a);
}

// ---------------------------------------------------------------- read / star

function adjustUnread(feedId, delta) {
  const feed = feedById(feedId);
  if (feed) feed.unread = Math.max(0, feed.unread + delta);
  S.totals.unread = Math.max(0, S.totals.unread + delta);
  renderNav();
  renderHeader();
}

function setRead(i, read) {
  const a = S.items[i];
  if (!a || Boolean(a.read) === read) return;
  a.read = read ? 1 : 0;
  adjustUnread(a.feed_id, read ? -1 : 1);
  updateItem(i);
  refreshReaderButtons();
  patch(`/api/articles/${a.id}`, { read }).catch((err) => toast(err.message));
}

function toggleRead(i) {
  const a = S.items[i];
  if (a) setRead(i, !a.read);
}

function toggleStar(i) {
  const a = S.items[i];
  if (!a) return;
  a.starred = a.starred ? 0 : 1;
  S.totals.starred += a.starred ? 1 : -1;
  renderNav();
  renderHeader();
  updateItem(i);
  refreshReaderButtons();
  patch(`/api/articles/${a.id}`, { starred: Boolean(a.starred) }).catch((err) => toast(err.message));
}

function openOriginal(i) {
  const a = S.items[i];
  if (!webUrl(a?.url)) return;
  setRead(i, true);
  window.open(a.url, '_blank', 'noopener');
}

async function markAllRead(filter = scopeFilter()) {
  const r = await post('/api/mark-read', filter);
  toast(`Marked ${r.marked} article${r.marked === 1 ? '' : 's'} as read`);
  await reloadAll({ keepSelection: true });
}

$('#markAllBtn').addEventListener('click', () => {
  const n = scopeUnread();
  if (S.scope.type === 'starred') return markAllRead();
  if (n > 0 && confirm(`Mark ${n} article${n === 1 ? '' : 's'} in “${scopeLabel()}” as read?`)) markAllRead();
});

// ---------------------------------------------------------------- refresh

let pollTimer;
function setRefreshing(on) {
  $('#refreshBtn').classList.toggle('spin', on);
  clearTimeout(pollTimer);
  if (on) {
    pollTimer = setTimeout(async () => {
      const s = await loadState();
      if (!s.refreshing) loadArticles({ keepSelection: true });
    }, 2000);
  }
}

async function refresh() {
  await post('/api/refresh');
  setRefreshing(true);
}

async function reloadAll(opts) {
  await loadState();
  await loadArticles(opts);
}

$('#refreshBtn').addEventListener('click', refresh);
setInterval(() => { if (!document.hidden) loadState(); }, 60_000);

// ---------------------------------------------------------------- toolbar controls

$('#viewSeg').addEventListener('click', (e) => {
  const v = e.target.dataset.view;
  if (!v || v === S.view) return;
  S.view = v;
  store.set('view', v);
  renderHeader();
  loadArticles();
});

$('#layoutSeg').addEventListener('click', (e) => {
  const l = e.target.dataset.layout;
  if (!l || l === S.layout) return;
  S.layout = l;
  store.set('layout', l);
  renderHeader();
  applyPaneWidths();
  loadArticles({ keepSelection: true });
});

let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    S.q = e.target.value.trim();
    renderHeader();
    loadArticles();
  }, 250);
});

$('#menuBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#app').classList.toggle('nav-open');
});
$('#listPane').addEventListener('click', (e) => {
  if (!e.target.closest('#menuBtn')) $('#app').classList.remove('nav-open');
});

function setOldestFirst(on) {
  S.oldestFirst = on;
  store.set('oldestFirst', on);
  $('#oldestFirst').checked = on;
  loadArticles();
}

// ---------------------------------------------------------------- dialogs

for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', (e) => {
    if (e.target === d || e.target.closest('[data-close]')) d.close();
  });
}

function openAddDialog(prefill) {
  const sel = $('#addForm select');
  sel.innerHTML = `<option value="">No folder</option>${S.folders.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join('')}<option value="new">New folder…</option>`;
  if (S.scope.type === 'folder') sel.value = S.scope.id;
  $('#addError').hidden = true;
  $('#addForm').reset();
  if (S.scope.type === 'folder') sel.value = S.scope.id;
  if (typeof prefill === 'string') $('#addForm').url.value = prefill;
  $('#addDialog').showModal();
}

$('#addBtn').addEventListener('click', () => openAddDialog());

$('#addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const btn = $('#addSubmit');
  let folderId = form.folder.value;
  if (folderId === 'new') {
    const folder = await createFolder();
    if (!folder) return;
    folderId = folder.id;
  }
  btn.disabled = true;
  btn.textContent = 'Finding feed…';
  $('#addError').hidden = true;
  try {
    const r = await post('/api/feeds', { url: form.url.value, folderId: Number(folderId) || null });
    $('#addDialog').close();
    await loadState();
    toast(r.existed ? 'Already subscribed' : `Subscribed to ${feedById(r.id)?.title}`);
    setScope({ type: 'feed', id: r.id });
  } catch (err) {
    $('#addError').textContent = err.message;
    $('#addError').hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Subscribe';
  }
});

$('#newFolderBtn').addEventListener('click', createFolder);

function applyTheme() {
  if (S.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = S.theme;
  for (const b of $('#themeSeg').children) b.classList.toggle('on', b.dataset.theme === S.theme);
}

$('#themeSeg').addEventListener('click', (e) => {
  if (!e.target.dataset.theme) return;
  S.theme = e.target.dataset.theme;
  store.set('theme', S.theme);
  applyTheme();
});

$('#settingsBtn').addEventListener('click', () => {
  $('#oldestFirst').checked = S.oldestFirst;
  $('#markOnScroll').checked = S.markOnScroll;
  const feeds = [...S.feeds].sort((a, b) => Boolean(b.last_error) - Boolean(a.last_error));
  $('#feedHealth').innerHTML = feeds.length
    ? feeds.map((f) => `<div><span title="${esc(f.url)}">${esc(f.title)}</span>${f.last_error
      ? `<span class="bad" title="${esc(f.last_error)}">${esc(f.last_error.slice(0, 40))}${f.next_fetch_at > Date.now() ? ` · retry in ${timeUntil(f.next_fetch_at)}` : ''}</span>`
      : `<span class="muted">${f.last_fetched ? `updated ${timeAgo(f.last_fetched)} ago` : 'pending'}</span>`}</div>`).join('')
    : '<p class="muted">No feeds yet.</p>';
  $('#settingsDialog').showModal();
  api('/api/sync').then(showSync).catch(() => {});
});

// Credentials reading apps use for the Google Reader and Fever APIs.
function showSync(s) {
  $('#syncState').textContent = s.enabled
    ? `On. Apps sign in as “${s.username}” with the app password. Saving a new password signs every app out.`
    : 'Off. Choose a username and app password to turn it on.';
  $('#syncUser').value = s.username;
  $('#syncPass').value = '';
  $('#syncOff').hidden = !s.enabled;
  $('#syncError').hidden = true;
  $('#greaderUrl').textContent = `${location.origin}/api/greader.php`;
  $('#feverUrl').textContent = `${location.origin}/api/fever.php`;
  $('#radarUrl').textContent = location.origin;
  $('#bookmarklet').href = `javascript:location.href='${location.origin}/?add='+encodeURIComponent(location.href)`;
}

async function saveSync(body) {
  try {
    showSync(await api('/api/sync', { method: 'PUT', body: JSON.stringify(body) }));
    toast(body.username ? 'App sync saved' : 'App sync turned off');
  } catch (err) {
    $('#syncError').textContent = err.message;
    $('#syncError').hidden = false;
  }
}

$('#syncSave').addEventListener('click', () => saveSync({ username: $('#syncUser').value, password: $('#syncPass').value }));
$('#syncOff').addEventListener('click', () => {
  if (confirm('Turn off app sync? Every app signed in to Feedster will be signed out.')) saveSync({});
});

$('#oldestFirst').addEventListener('change', (e) => setOldestFirst(e.target.checked));
$('#markOnScroll').addEventListener('change', (e) => {
  S.markOnScroll = e.target.checked;
  store.set('markOnScroll', S.markOnScroll);
  observeScroll();
});

$('#opmlFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const r = await api('/api/opml', { method: 'POST', body: await file.text(), raw: true });
    toast(`Imported ${r.imported} feed${r.imported === 1 ? '' : 's'} — fetching articles…`);
    $('#settingsDialog').close();
    await loadState();
    setRefreshing(true);
  } catch (err) {
    toast(err.message);
  }
  e.target.value = '';
});

// ---------------------------------------------------------------- keyboard

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, dialog[open]') || e.ctrlKey || e.metaKey || e.altKey) {
    if (e.key === 'Escape' && e.target.id === 'search') e.target.blur();
    return;
  }
  const i = S.selected;
  switch (e.key) {
    case 'j': case 'ArrowDown': select(Math.min(i + 1, S.items.length - 1)); break;
    case 'k': case 'ArrowUp': select(Math.max(i - 1, 0)); break;
    // n/p move without opening in the classic layout; o and Enter then open or close the article
    case 'n': select(Math.min(i + 1, S.items.length - 1), { open: false }); break;
    case 'p': select(Math.max(i - 1, 0), { open: false }); break;
    case 's': toggleStar(i); break;
    case 'm': toggleRead(i); break;
    case 'o': case 'Enter':
      if (e.key === 'Enter' && e.target.closest('button, a, [tabindex]')) return; // Enter on a focused control
      if (S.layout === 'classic') toggleOpen(i);
      else if (e.key === 'o') openOriginal(i);
      else return;
      break;
    case 'v': openOriginal(i); break;
    case 'f': toggleFull(i); break;
    case 'r': refresh(); break;
    case 'A': markAllRead(); break;
    case 'a': openAddDialog(); break;
    case '/': $('#search').focus(); break;
    case 'Escape': closeMenu(); $('#app').classList.remove('reading', 'nav-open'); break;
    default: return;
  }
  e.preventDefault();
});

// ---------------------------------------------------------------- resizable panes

const PANE_LIMITS = { sidebar: [180, 420], list: [260, 900] };
const READER_MIN = 360;
const paneWidths = store.get('paneWidths', {});
const paneEl = { sidebar: () => $('#sidebar'), list: () => $('#listPane') };
const paneVar = { sidebar: '--sidebar-w', list: '--list-w' };

/** Keep a pane within its limits and leave the reading pane (or cards) at least READER_MIN wide. */
function clampPane(key, width) {
  const [min, max] = PANE_LIMITS[key];
  const other = key === 'sidebar'
    ? (S.layout !== 'list' ? 0 : paneEl.list().getBoundingClientRect().width)
    : paneEl.sidebar().getBoundingClientRect().width;
  const room = window.innerWidth - other - READER_MIN;
  return Math.round(Math.max(min, Math.min(max, width, room)));
}

function applyPaneWidths() {
  for (const key of Object.keys(paneVar)) {
    if (paneWidths[key]) $('#app').style.setProperty(paneVar[key], `${clampPane(key, paneWidths[key])}px`);
    else $('#app').style.removeProperty(paneVar[key]);
  }
}

function setPaneWidth(key, width) {
  paneWidths[key] = clampPane(key, width);
  $('#app').style.setProperty(paneVar[key], `${paneWidths[key]}px`);
}

for (const handle of document.querySelectorAll('.splitter')) {
  const key = handle.dataset.split;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    document.body.classList.add('resizing');
    const startX = e.clientX;
    const startWidth = paneEl[key]().getBoundingClientRect().width;
    const move = (ev) => setPaneWidth(key, startWidth + ev.clientX - startX);
    const done = () => {
      handle.removeEventListener('pointermove', move);
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing');
      store.set('paneWidths', paneWidths);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', done, { once: true });
    handle.addEventListener('pointercancel', done, { once: true });
  });
  handle.addEventListener('dblclick', () => {
    delete paneWidths[key];
    store.set('paneWidths', paneWidths);
    applyPaneWidths();
  });
  handle.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    setPaneWidth(key, paneEl[key]().getBoundingClientRect().width + (e.key === 'ArrowRight' ? 24 : -24));
    store.set('paneWidths', paneWidths);
  });
}
window.addEventListener('resize', applyPaneWidths);

// ---------------------------------------------------------------- boot

applyTheme();
renderHeader();
applyPaneWidths();
// A subscribe link (from a browser extension or the bookmarklet) opens the Add dialog pre-filled.
// It never subscribes on its own, so a link elsewhere can't add feeds without you confirming.
const addParam = new URLSearchParams(location.search).get('add');
if (addParam) history.replaceState(null, '', location.pathname);
reloadAll()
  .then(() => { if (addParam) openAddDialog(addParam); })
  .catch((err) => toast(err.message));

$('#bookmarklet').addEventListener('click', (e) => {
  e.preventDefault();
  toast('Drag this button to your bookmarks bar, then click it on any website');
});
