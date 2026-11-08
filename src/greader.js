import { db, tx } from './db.js';
import { send, formParams, tooManyFailures, recordFailure, clearFailures } from './http.js';
import { login, checkToken, syncStatus } from './sync.js';
import { subscribe } from './feeds.js';

// Google Reader API, the dialect FreshRSS and Miniflux serve, at /api/greader.php.
// Streams: feed/<id>, user/-/label/<folder>, user/-/state/com.google/{reading-list,starred,read}.

const STATE = 'user/-/state/com.google/';
const READING_LIST = `${STATE}reading-list`;
const READ = `${STATE}read`;
const STARRED = `${STATE}starred`;
const KEPT_UNREAD = `${STATE}kept-unread`;
const LABEL = 'user/-/label/';
const ITEM_PREFIX = 'tag:google.com,2005:reader/item/';

const labelId = (name) => `${LABEL}${name}`;
const longId = (id) => `${ITEM_PREFIX}${id.toString(16).padStart(16, '0')}`;

/** Item ids arrive long-form (hex) or short-form (decimal). */
function parseItemId(raw) {
  const s = String(raw);
  if (s.startsWith(ITEM_PREFIX)) return parseInt(s.slice(ITEM_PREFIX.length), 16);
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Normalize the various ways clients spell stream ids ("user/1234/..." means the same as "user/-/..."). */
function normStream(s) {
  return String(s || '').replace(/^user\/[^/]+\//, 'user/-/');
}

function folderByName(name, create = false) {
  if (create) db.prepare('INSERT OR IGNORE INTO folders (name, position) VALUES (?, (SELECT COALESCE(MAX(position), 0) + 1 FROM folders))').run(name);
  return db.prepare('SELECT * FROM folders WHERE name = ?').get(name);
}

/** WHERE clause for a stream plus include/exclude targets and time bounds. */
function streamFilter(p, stream) {
  const where = [];
  const args = [];
  const add = (target, negate) => {
    const t = normStream(target);
    if (t === READ) where.push(`a.read = ${negate ? 0 : 1}`);
    else if (t === STARRED) where.push(`a.starred = ${negate ? 0 : 1}`);
    else if (t === KEPT_UNREAD) where.push(`a.read = ${negate ? 1 : 0}`);
    else if (t === READING_LIST || !t) { /* everything */ }
    else if (t.startsWith(LABEL)) {
      const folder = folderByName(t.slice(LABEL.length));
      where.push(`${negate ? 'NOT ' : ''}(f.folder_id IS ? )`);
      args.push(folder ? folder.id : -1);
    } else if (t.startsWith('feed/')) {
      where.push(`a.feed_id ${negate ? '!=' : '='} ?`);
      args.push(feedIdFromStream(t) ?? -1);
    } else {
      where.push('0');
    }
  };
  add(stream, false);
  for (const t of p.getAll('it')) add(t, false);
  for (const t of p.getAll('xt')) add(t, true);
  // ot/nt are in seconds and refer to when articles arrived, so a sync never misses late items.
  if (p.get('ot')) { where.push('a.fetched_at >= ?'); args.push(Number(p.get('ot')) * 1000); }
  if (p.get('nt')) { where.push('a.fetched_at <= ?'); args.push(Number(p.get('nt')) * 1000); }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

function feedIdFromStream(stream) {
  const rest = String(stream).slice('feed/'.length);
  if (/^\d+$/.test(rest)) return Number(rest);
  return db.prepare('SELECT id FROM feeds WHERE url = ?').get(rest)?.id ?? null;
}

function queryItems(p, stream, columns) {
  const { sql, args } = streamFilter(p, stream);
  const n = Math.min(Math.max(Number(p.get('n')) || 20, 1), 10000);
  const offset = Math.max(Number(p.get('c')) || 0, 0);
  const order = p.get('r') === 'o' ? 'ASC' : 'DESC';
  const rows = db.prepare(`
    SELECT ${columns} FROM articles a JOIN feeds f ON f.id = a.feed_id
    ${sql} ORDER BY a.published ${order}, a.id ${order} LIMIT ? OFFSET ?`).all(...args, n + 1, offset);
  const more = rows.length > n;
  return { rows: rows.slice(0, n), continuation: more ? String(offset + n) : undefined };
}

const ITEM_COLUMNS = `a.id, a.feed_id, a.url, a.title, a.author, a.content, a.published, a.fetched_at,
  a.read, a.starred, f.title AS feed_title, f.site_url, fo.name AS folder`;

function itemJson(a) {
  const categories = [READING_LIST];
  if (a.read) categories.push(READ);
  if (a.starred) categories.push(STARRED);
  if (a.folder) categories.push(labelId(a.folder));
  return {
    id: longId(a.id),
    crawlTimeMsec: String(a.fetched_at),
    timestampUsec: String(a.published * 1000),
    published: Math.floor(a.published / 1000),
    updated: Math.floor(a.published / 1000),
    title: a.title || '',
    author: a.author || '',
    canonical: a.url ? [{ href: a.url }] : [],
    alternate: a.url ? [{ href: a.url, type: 'text/html' }] : [],
    summary: { direction: 'ltr', content: a.content || '' },
    categories,
    origin: { streamId: `feed/${a.feed_id}`, title: a.feed_title, htmlUrl: a.site_url || '' },
  };
}

function itemsByIds(idList) {
  const list = idList.map(parseItemId).filter(Boolean);
  if (!list.length) return [];
  const rows = [];
  // SQLite caps bound parameters, so look ids up in chunks.
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    rows.push(...db.prepare(`
      SELECT ${ITEM_COLUMNS} FROM articles a JOIN feeds f ON f.id = a.feed_id LEFT JOIN folders fo ON fo.id = f.folder_id
      WHERE a.id IN (${chunk.map(() => '?').join(',')})`).all(...chunk));
  }
  const order = new Map(list.map((id, i) => [id, i]));
  return rows.sort((x, y) => order.get(x.id) - order.get(y.id));
}

function setFlag(itemIds, column, value) {
  const list = itemIds.map(parseItemId).filter(Boolean);
  const stmt = db.prepare(`UPDATE articles SET ${column} = ? WHERE id = ?`);
  tx(() => { for (const id of list) stmt.run(value, id); });
}

// ---- endpoints ----

const routes = {
  'GET /reader/api/0/token': () => 'spoolrss-token',
  'POST /reader/api/0/token': () => 'spoolrss-token',

  'GET /reader/api/0/user-info': () => {
    const { username } = syncStatus();
    return { userId: '1', userName: username, userProfileId: '1', userEmail: '', isBloggerUser: false, signupTimeSec: 0, isMultiLoginEnabled: false };
  },

  'GET /reader/api/0/subscription/list': () => ({
    subscriptions: db.prepare('SELECT f.*, fo.name AS folder FROM feeds f LEFT JOIN folders fo ON fo.id = f.folder_id ORDER BY f.title COLLATE NOCASE').all()
      .map((f) => ({
        id: `feed/${f.id}`,
        title: f.title,
        categories: f.folder ? [{ id: labelId(f.folder), label: f.folder }] : [],
        url: f.url,
        htmlUrl: f.site_url || '',
        iconUrl: '',
        firstitemmsec: String(f.created_at),
      })),
  }),

  'GET /reader/api/0/tag/list': () => ({
    tags: [
      { id: STARRED },
      ...db.prepare('SELECT name FROM folders ORDER BY position, name COLLATE NOCASE').all().map((f) => ({ id: labelId(f.name), type: 'folder' })),
    ],
  }),

  'GET /reader/api/0/unread-count': () => {
    const feeds = db.prepare(`
      SELECT f.id, fo.name AS folder, COUNT(a.id) AS n, MAX(a.published) AS newest
      FROM feeds f LEFT JOIN folders fo ON fo.id = f.folder_id
      LEFT JOIN articles a ON a.feed_id = f.id AND a.read = 0
      GROUP BY f.id`).all();
    const counts = [];
    const folders = new Map();
    let total = 0;
    let newestAll = 0;
    for (const f of feeds) {
      counts.push({ id: `feed/${f.id}`, count: f.n, newestItemTimestampUsec: String((f.newest || 0) * 1000) });
      total += f.n;
      newestAll = Math.max(newestAll, f.newest || 0);
      if (f.folder) {
        const agg = folders.get(f.folder) || { n: 0, newest: 0 };
        folders.set(f.folder, { n: agg.n + f.n, newest: Math.max(agg.newest, f.newest || 0) });
      }
    }
    for (const [name, agg] of folders) counts.push({ id: labelId(name), count: agg.n, newestItemTimestampUsec: String(agg.newest * 1000) });
    counts.push({ id: READING_LIST, count: total, newestItemTimestampUsec: String(newestAll * 1000) });
    return { max: total, unreadcounts: counts };
  },

  'GET /reader/api/0/stream/items/ids': (p) => {
    const { rows, continuation } = queryItems(p, p.get('s'), 'a.id, a.published, a.feed_id');
    return {
      itemRefs: rows.map((r) => ({ id: String(r.id), directStreamIds: [`feed/${r.feed_id}`], timestampUsec: String(r.published * 1000) })),
      ...(continuation && { continuation }),
    };
  },

  'POST /reader/api/0/stream/items/contents': (p) => ({
    id: READING_LIST,
    updated: Math.floor(Date.now() / 1000),
    items: itemsByIds(p.getAll('i')).map(itemJson),
  }),

  'POST /reader/api/0/edit-tag': (p) => {
    const items = p.getAll('i');
    for (const tag of p.getAll('a').map(normStream)) {
      if (tag === READ) setFlag(items, 'read', 1);
      if (tag === KEPT_UNREAD) setFlag(items, 'read', 0);
      if (tag === STARRED) setFlag(items, 'starred', 1);
    }
    for (const tag of p.getAll('r').map(normStream)) {
      if (tag === READ) setFlag(items, 'read', 0);
      if (tag === STARRED) setFlag(items, 'starred', 0);
    }
    return 'OK';
  },

  'POST /reader/api/0/mark-all-as-read': (p) => {
    const stream = p.get('s') || READING_LIST;
    const { sql, args } = streamFilter(new URLSearchParams(), stream);
    // ts (microseconds) is when the client last synced; newer articles stay unread.
    const ts = p.get('ts') ? Math.floor(Number(p.get('ts')) / 1000) : Date.now();
    db.prepare(`UPDATE articles SET read = 1 WHERE read = 0 AND id IN (
      SELECT a.id FROM articles a JOIN feeds f ON f.id = a.feed_id ${sql} ${sql ? 'AND' : 'WHERE'} a.fetched_at <= ?)`).run(...args, ts);
    return 'OK';
  },

  'POST /reader/api/0/subscription/quickadd': async (p) => {
    const query = String(p.get('quickadd') || '').replace(/^feed\//, '');
    try {
      const { id } = await subscribe(query);
      const feed = db.prepare('SELECT title FROM feeds WHERE id = ?').get(id);
      return { numResults: 1, query, streamId: `feed/${id}`, streamName: feed.title };
    } catch (err) {
      return { numResults: 0, query, error: err.message };
    }
  },

  'POST /reader/api/0/subscription/edit': async (p) => {
    const action = p.get('ac') || 'edit';
    const addLabel = p.get('a') && normStream(p.get('a')).startsWith(LABEL) ? normStream(p.get('a')).slice(LABEL.length) : null;
    const removeLabel = p.get('r') && normStream(p.get('r')).startsWith(LABEL) ? normStream(p.get('r')).slice(LABEL.length) : null;
    for (const s of p.getAll('s')) {
      if (action === 'subscribe') {
        const folder = addLabel ? folderByName(addLabel, true) : null;
        const { id } = await subscribe(s.replace(/^feed\//, ''), folder?.id ?? null);
        if (p.get('t')) db.prepare('UPDATE feeds SET title = ? WHERE id = ?').run(p.get('t'), id);
        continue;
      }
      const id = feedIdFromStream(s);
      if (!id) continue;
      if (action === 'unsubscribe') {
        db.prepare('DELETE FROM feeds WHERE id = ?').run(id);
        continue;
      }
      if (p.get('t')) db.prepare('UPDATE feeds SET title = ? WHERE id = ?').run(p.get('t'), id);
      if (addLabel) db.prepare('UPDATE feeds SET folder_id = ? WHERE id = ?').run(folderByName(addLabel, true).id, id);
      else if (removeLabel) {
        const folder = folderByName(removeLabel);
        if (folder) db.prepare('UPDATE feeds SET folder_id = NULL WHERE id = ? AND folder_id = ?').run(id, folder.id);
      }
    }
    return 'OK';
  },

  'POST /reader/api/0/rename-tag': (p) => {
    const from = normStream(p.get('s'));
    const to = normStream(p.get('dest'));
    if (from.startsWith(LABEL) && to.startsWith(LABEL)) {
      db.prepare('UPDATE folders SET name = ? WHERE name = ?').run(to.slice(LABEL.length), from.slice(LABEL.length));
    }
    return 'OK';
  },

  'POST /reader/api/0/disable-tag': (p) => {
    const tag = normStream(p.get('s') || (p.get('t') ? labelId(p.get('t')) : ''));
    if (tag.startsWith(LABEL)) db.prepare('DELETE FROM folders WHERE name = ?').run(tag.slice(LABEL.length));
    return 'OK';
  },
};

function streamContents(p, stream) {
  const { rows, continuation } = queryItems(p, stream, ITEM_COLUMNS.replace('fo.name AS folder', '(SELECT name FROM folders WHERE id = f.folder_id) AS folder'));
  return {
    id: stream,
    updated: Math.floor(Date.now() / 1000),
    items: rows.map(itemJson),
    ...(continuation && { continuation }),
  };
}

export async function handleGReader(req, res, url, base) {
  const path = url.pathname.slice(base.length) || '/';
  const p = await formParams(req, url);

  if (path === '/accounts/ClientLogin') {
    if (tooManyFailures(req)) return send(res, 429, 'Error=TooManyAttempts\n');
    const token = login(p.get('Email'), p.get('Passwd'));
    if (!token) {
      recordFailure(req);
      return send(res, 401, 'Error=BadAuthentication\n');
    }
    clearFailures(req);
    if (p.get('output') === 'json') return send(res, 200, { SID: token, LSID: null, Auth: token });
    return send(res, 200, `SID=${token}\nLSID=null\nAuth=${token}\n`);
  }

  const auth = (req.headers.authorization || '').match(/GoogleLogin\s+auth=(\S+)/i)?.[1];
  if (!checkToken(auth)) return send(res, 401, 'Unauthorized');

  // Some clients send GETs as POSTs and vice versa; allow either for reads.
  const handler = routes[`${req.method} ${path}`] || (req.method === 'POST' && routes[`GET ${path}`]) || (req.method === 'GET' && routes[`POST ${path}`]);
  if (handler) {
    const result = await handler(p);
    return send(res, 200, result);
  }
  const streamPrefix = '/reader/api/0/stream/contents';
  if (path === streamPrefix || path.startsWith(`${streamPrefix}/`)) {
    const stream = decodeURIComponent(path.slice(streamPrefix.length + 1)) || p.get('s') || READING_LIST;
    return send(res, 200, streamContents(p, stream));
  }
  send(res, 404, 'Not found');
}
