import { db } from './db.js';
import { send, formParams, tooManyFailures, recordFailure } from './http.js';
import { checkFeverKey } from './sync.js';

// Fever API (https://feedafever.com/api), served at /api/fever.php.
// Folders are Fever "groups"; SpoolRSS's ids are used as-is.

// 1x1 transparent GIF: Fever clients expect every feed to point at a favicon.
const BLANK_FAVICON = { id: 1, data: 'image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' };
const ITEM_LIMIT = 50;

const ids = (value) => String(value || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
const secs = (ms) => Math.floor((ms || 0) / 1000);

function feedsGroups() {
  const rows = db.prepare('SELECT folder_id, group_concat(id) AS feed_ids FROM feeds WHERE folder_id IS NOT NULL GROUP BY folder_id').all();
  return rows.map((r) => ({ group_id: r.folder_id, feed_ids: r.feed_ids }));
}

function items(p) {
  let sql = 'SELECT * FROM articles';
  let args = [];
  if (p.has('with_ids')) {
    const list = ids(p.get('with_ids')).slice(0, ITEM_LIMIT);
    if (!list.length) return [];
    sql += ` WHERE id IN (${list.map(() => '?').join(',')}) ORDER BY id`;
    args = list;
  } else if (p.has('max_id')) {
    sql += ' WHERE id < ? ORDER BY id DESC';
    args = [Number(p.get('max_id')) || 0];
  } else {
    sql += ' WHERE id > ? ORDER BY id ASC';
    args = [Number(p.get('since_id')) || 0];
  }
  return db.prepare(`${sql} LIMIT ${ITEM_LIMIT}`).all(...args).map((a) => ({
    id: a.id,
    feed_id: a.feed_id,
    title: a.title || '',
    author: a.author || '',
    html: a.content || '',
    url: a.url || '',
    is_saved: a.starred,
    is_read: a.read,
    created_on_time: secs(a.published),
  }));
}

function mark(p) {
  const as = p.get('as');
  const id = Number(p.get('id'));
  // "before" is when the client last refreshed; leave anything fetched since then alone.
  const before = p.has('before') ? Number(p.get('before')) * 1000 : Date.now();
  switch (p.get('mark')) {
    case 'item': {
      const column = as === 'saved' || as === 'unsaved' ? 'starred' : 'read';
      const value = as === 'read' || as === 'saved' ? 1 : 0;
      db.prepare(`UPDATE articles SET ${column} = ? WHERE id = ?`).run(value, id);
      break;
    }
    case 'feed':
      if (as === 'read') db.prepare('UPDATE articles SET read = 1 WHERE feed_id = ? AND fetched_at <= ?').run(id, before);
      break;
    case 'group':
      if (as !== 'read') break;
      if (id === 0) db.prepare('UPDATE articles SET read = 1 WHERE fetched_at <= ?').run(before);
      else if (id > 0) {
        db.prepare('UPDATE articles SET read = 1 WHERE fetched_at <= ? AND feed_id IN (SELECT id FROM feeds WHERE folder_id = ?)').run(before, id);
      }
      break;
  }
}

export async function handleFever(req, res, url) {
  const p = await formParams(req, url);
  const lastRefreshed = db.prepare('SELECT MAX(last_fetched) AS t FROM feeds').get().t;
  const out = { api_version: 3, auth: 0, last_refreshed_on_time: secs(lastRefreshed) };
  if (tooManyFailures(req)) return send(res, 429, out);
  if (!checkFeverKey(p.get('api_key'))) {
    if (p.has('api_key')) recordFailure(req);
    return send(res, 200, out);
  }
  out.auth = 1;

  if (p.has('mark')) {
    mark(p);
    // Clients expect the updated state back after marking.
    if (p.get('as') === 'saved' || p.get('as') === 'unsaved') p.set('saved_item_ids', '');
    else p.set('unread_item_ids', '');
  }
  if (p.has('groups')) {
    out.groups = db.prepare('SELECT id, name AS title FROM folders ORDER BY position, name COLLATE NOCASE').all();
    out.feeds_groups = feedsGroups();
  }
  if (p.has('feeds')) {
    out.feeds = db.prepare(`SELECT f.*, EXISTS (SELECT 1 FROM icons i WHERE i.feed_id = f.id AND i.data IS NOT NULL) AS has_icon
      FROM feeds f ORDER BY f.title COLLATE NOCASE`).all().map((f) => ({
      id: f.id,
      favicon_id: f.has_icon ? f.id + 1 : BLANK_FAVICON.id,
      title: f.title,
      url: f.url,
      site_url: f.site_url || '',
      is_spark: 0,
      last_updated_on_time: secs(f.last_fetched),
    }));
    out.feeds_groups = feedsGroups();
  }
  if (p.has('favicons')) {
    // Favicon ids are feed id + 1, since 1 is the blank fallback.
    out.favicons = [BLANK_FAVICON, ...db.prepare('SELECT feed_id, type, data FROM icons WHERE data IS NOT NULL').all()
      .map((i) => ({ id: i.feed_id + 1, data: `${i.type};base64,${Buffer.from(i.data).toString('base64')}` }))];
  }
  if (p.has('items')) {
    out.items = items(p);
    out.total_items = db.prepare('SELECT COUNT(*) AS n FROM articles').get().n;
  }
  if (p.has('links')) out.links = [];
  if (p.has('unread_item_ids')) {
    out.unread_item_ids = db.prepare('SELECT id FROM articles WHERE read = 0 ORDER BY id').all().map((r) => r.id).join(',');
  }
  if (p.has('saved_item_ids')) {
    out.saved_item_ids = db.prepare('SELECT id FROM articles WHERE starred = 1 ORDER BY id').all().map((r) => r.id).join(',');
  }
  send(res, 200, out);
}
