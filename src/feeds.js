import { XMLParser } from 'fast-xml-parser';
import { db, tx, getSetting, setSetting } from './db.js';
import { updateIcon, iconDue } from './icons.js';
import { isBlocked, retryAfterMs } from './net.js';

const USER_AGENT = 'SpoolRSS/1.0 (+self-hosted feed reader)';
const FETCH_TIMEOUT_MS = 20_000;

// fast-xml-parser counts every entity (even &lt; and &amp;) toward a 1,000-per-document
// limit by default, which ordinary feeds with escaped HTML easily exceed. Lift that count;
// DOCTYPE-defined entities stay capped in size, number and total expanded length.
const entityLimits = {
  enabled: true,
  maxTotalExpansions: 10_000_000,
  maxExpansionDepth: 10,
  maxEntitySize: 10_000,
  maxEntityCount: 100,
  maxExpandedLength: 100_000,
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  processEntities: entityLimits,
  htmlEntities: true,
  trimValues: true,
  // Keep these as arrays even when a feed has a single entry.
  isArray: (name) => ['item', 'entry', 'link', 'category', 'media:content', 'enclosure'].includes(name),
});

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

function text(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === 'object') return text(v['#text'] ?? '');
  return String(v).trim();
}

function toTime(v) {
  const t = Date.parse(text(v));
  return Number.isFinite(t) ? t : null;
}

function resolveUrl(href, base) {
  if (!href) return null;
  try {
    const url = new URL(href, base);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch { return null; }
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™',
  deg: '°', eacute: 'é', egrave: 'è', aacute: 'á', oacute: 'ó', uacute: 'ú', iacute: 'í', ntilde: 'ñ', uuml: 'ü', ouml: 'ö', auml: 'ä',
};

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * Titles and names are plain text, but many feeds escape them twice ("Tom &amp;amp; Jerry",
 * "Women&amp;#039;s") or wrap them in tags. Strip tags first, then decode, so "&lt;div&gt;" survives.
 */
export function plainText(v) {
  const s = text(v);
  if (!/[<&]/.test(s)) return s;
  return decodeEntities(/<\/?[a-z][^>]*>/i.test(s) ? stripTags(s) : s).replace(/\s+/g, ' ').trim();
}

function firstImage(html, base) {
  const m = html && html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? resolveUrl(m[1], base) : null;
}

function atomLink(links, rel = 'alternate') {
  const list = asArray(links);
  const hit = list.find((l) => (l['@_rel'] || 'alternate') === rel && (rel !== 'alternate' || !l['@_type'] || l['@_type'].includes('html')))
    || (rel === 'alternate' ? list.find((l) => !l['@_rel']) : null);
  return hit ? hit['@_href'] : null;
}

function mediaImage(item) {
  const thumb = item['media:thumbnail'] || item['media:group']?.['media:thumbnail'];
  if (thumb) return asArray(thumb)[0]['@_url'];
  const media = asArray(item['media:content'] || item['media:group']?.['media:content'])
    .find((m) => (m['@_medium'] === 'image') || (m['@_type'] || '').startsWith('image/'));
  if (media) return media['@_url'];
  const enc = asArray(item.enclosure).find((e) => (e['@_type'] || '').startsWith('image/'));
  if (enc) return enc['@_url'];
  // Non-standard but common: <image href="…"/>, <image>url</image>, <itunes:image href="…"/>
  const img = item.image || item['itunes:image'];
  if (img) return typeof img === 'object' ? img['@_href'] || img['@_url'] || text(img.url) || text(img) || null : text(img);
  return null;
}

/** Parse RSS 2.0 / RSS 1.0 / Atom / JSON Feed into a normalized shape. */
export function parseFeed(body, feedUrl) {
  const trimmed = body.trimStart();
  if (trimmed.startsWith('{')) return parseJsonFeed(JSON.parse(trimmed), feedUrl);

  const doc = parser.parse(body);

  if (doc.feed) {
    const f = doc.feed;
    const siteUrl = resolveUrl(atomLink(f.link), feedUrl);
    return {
      title: plainText(f.title),
      siteUrl,
      icon: resolveUrl(text(f.icon) || text(f.logo), feedUrl),
      items: asArray(f.entry).map((e) => {
        const url = resolveUrl(atomLink(e.link), siteUrl || feedUrl);
        const content = text(e.content) || text(e.summary) || text(e['media:group']?.['media:description']);
        return {
          guid: text(e.id) || url || text(e.title),
          url,
          title: plainText(e.title),
          author: plainText(e.author?.name ?? e.author),
          content,
          image: mediaImage(e) || firstImage(content, url),
          published: toTime(e.published) ?? toTime(e.updated),
        };
      }),
    };
  }

  const channel = doc.rss?.channel || doc['rdf:RDF']?.channel;
  if (!channel) throw new Error('Not a recognizable RSS/Atom feed');
  const rawItems = asArray(doc.rss ? channel.item : doc['rdf:RDF'].item);
  const siteUrl = resolveUrl(text(asArray(channel.link).find((l) => typeof l !== 'object' || l['#text'])), feedUrl);

  const image = asArray(channel.image)[0] || asArray(doc['rdf:RDF']?.image)[0];
  return {
    title: plainText(channel.title),
    siteUrl,
    icon: image ? resolveUrl(text(image.url) || image['@_rdf:resource'] || image['@_rdf:about'] || '', feedUrl) : null,
    items: rawItems.map((i) => {
      const url = resolveUrl(text(i.link) || (i.guid?.['@_isPermaLink'] !== 'false' ? text(i.guid) : ''), siteUrl || feedUrl);
      const content = text(i['content:encoded']) || text(i.description);
      return {
        guid: text(i.guid) || url || text(i.title),
        url,
        title: plainText(i.title),
        author: plainText(i['dc:creator']) || plainText(i.author),
        content,
        image: mediaImage(i) || firstImage(content, url),
        published: toTime(i.pubDate) ?? toTime(i['dc:date']),
      };
    }),
  };
}

function parseJsonFeed(j, feedUrl) {
  return {
    title: plainText(j.title),
    siteUrl: resolveUrl(j.home_page_url, feedUrl),
    icon: resolveUrl(j.favicon || j.icon, feedUrl),
    items: asArray(j.items).map((i) => ({
      guid: String(i.id ?? i.url),
      url: resolveUrl(i.url, feedUrl),
      title: plainText(i.title),
      author: plainText(i.authors?.[0]?.name || i.author?.name),
      content: i.content_html || (i.content_text ? `<p>${escapeHtml(i.content_text)}</p>` : '') || i.summary || '',
      image: i.image || i.banner_image || null,
      published: toTime(i.date_published) ?? toTime(i.date_modified),
    })),
  };
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function httpGet(url, headers = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/xml, text/xml, text/html;q=0.8, */*;q=0.5', ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return res;
}

const looksLikeFeed = (body) => /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<(rss|feed|rdf:RDF)[\s>]/i.test(body) || /^\s*\{[\s\S]*"version"\s*:\s*"https:\/\/jsonfeed/.test(body);

// Big sites whose pages don't link to their feeds. Each one was checked to serve a feed to SpoolRSS.
const KNOWN_FEEDS = {
  'mlb.com': 'https://www.mlb.com/feeds/news/rss.xml',
  'espn.com': 'https://www.espn.com/espn/rss/news',
  'bbc.com': 'https://feeds.bbci.co.uk/news/rss.xml',
  'bbc.co.uk': 'https://feeds.bbci.co.uk/news/rss.xml',
  'cnn.com': 'http://rss.cnn.com/rss/cnn_topstories.rss',
  'nytimes.com': 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml',
};

function knownFeed(url) {
  const host = new URL(url).hostname.replace(/^www\./, '');
  return KNOWN_FEEDS[host] || null;
}

function feedLinks(html, baseUrl) {
  const found = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const attr = (name) => tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1];
    if (/alternate/i.test(attr('rel') || '') && /(rss|atom|feed)\+?(xml|json)/i.test(attr('type') || '')) {
      const href = resolveUrl(attr('href'), baseUrl);
      if (href) found.push(href);
    }
  }
  return found;
}

/** Common feed locations, starting with ones relative to the page (reddit /r/x/.rss, medium /feed/@user). */
function guessedFeeds(pageUrl) {
  const u = new URL(pageUrl);
  const dir = u.pathname.replace(/\/+$/, '');
  const paths = [];
  if (dir) paths.push(`${dir}/.rss`, `${dir}/feed`, `${dir}/rss`, `${dir}/feed.xml`, `${dir}/rss.xml`, `/feed${dir}`);
  paths.push('/feed', '/rss', '/rss.xml', '/atom.xml', '/feed.xml', '/index.xml', '/feed.json', '/?feed=rss2', '/feeds/posts/default');
  return paths.map((p) => new URL(p, u.origin).href);
}

// Probing many addresses at once looks like an attack to bot protection, so go a few at a time.
const PROBE_BATCH = 3;

const blockedMessage = (host) => `${host} asked for a browser check (bot protection such as Cloudflare), which feed readers can't complete. SpoolRSS will retry less often until it clears, which it usually does on its own.`;

async function fetchFeed(url) {
  try {
    const res = await httpGet(url);
    if (isBlocked(res)) {
      res.body?.cancel().catch(() => {});
      return { blocked: true };
    }
    if (!res.ok) return null;
    const body = await res.text();
    return looksLikeFeed(body) ? { url: res.url || url, body } : null;
  } catch {
    return null;
  }
}

/** The first candidate (in order) that is a feed, a few at a time; { blocked } once the site starts refusing. */
async function firstFeed(candidates) {
  const unique = [...new Set(candidates)];
  for (let i = 0; i < unique.length; i += PROBE_BATCH) {
    const results = await Promise.all(unique.slice(i, i + PROBE_BATCH).map(fetchFeed));
    const hit = results.find((r) => r?.body);
    if (hit) return hit;
    if (results.some((r) => r?.blocked)) return { blocked: true };
  }
  return null;
}

/**
 * Find a feed from whatever the user typed: a feed URL, or a page that links to one,
 * or a site whose feed sits at a common or known address.
 */
export async function discover(inputUrl) {
  let url = inputUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  let host;
  try { host = new URL(url).hostname; } catch { throw new Error("That doesn't look like a web address"); }

  let page = null;
  let status = null;
  let blocked = false;
  try {
    const res = await httpGet(url);
    status = res.status;
    blocked = isBlocked(res);
    if (res.ok) page = { url: res.url || url, body: await res.text() };
    else res.body?.cancel().catch(() => {});
  } catch (err) {
    throw new Error(`Couldn't reach ${host} (${err.cause?.code || err.message})`);
  }
  if (page && looksLikeFeed(page.body)) return page;

  // A site may refuse its homepage to feed readers but still serve its feed (Medium does), so keep
  // looking, but stop as soon as a feed address is refused too.
  const base = page?.url || url;
  for (const candidates of [page ? feedLinks(page.body, base) : [], [...(knownFeed(base) ? [knownFeed(base)] : []), ...guessedFeeds(base)]]) {
    const hit = await firstFeed(candidates);
    if (hit?.body) return hit;
    if (hit?.blocked) { blocked = true; break; }
  }

  if (blocked) throw new Error(blockedMessage(host));
  if (status === 401 || status === 403 || status === 429) {
    throw new Error(`${host} blocks feed readers (HTTP ${status}) and no feed was found. If the site has a feed, paste its address instead.`);
  }
  if (!page) throw new Error(`${host} returned HTTP ${status}`);
  throw new Error(`No feed found on ${host}. If the site has one (often linked as "RSS"), paste its address instead.`);
}

const insertArticle = db.prepare(`
  INSERT INTO articles (feed_id, guid, url, title, author, content, image, published, fetched_at, in_feed)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  ON CONFLICT (feed_id, guid) DO UPDATE SET
    title = excluded.title, content = excluded.content, url = excluded.url, image = excluded.image, in_feed = 1
`);
const leftFeed = db.prepare('UPDATE articles SET in_feed = 0 WHERE feed_id = ? AND in_feed = 1');
const articleExists = db.prepare('SELECT 1 FROM articles WHERE feed_id = ? AND guid = ?');

function storeItems(feedId, items, { markRead = false } = {}) {
  const now = Date.now();
  let added = 0;
  tx(() => {
    // Only what this fetch lists counts as still in the feed.
    leftFeed.run(feedId);
    // Items without dates keep their feed order by spacing them out by a millisecond.
    items.forEach((item, idx) => {
      if (!item.guid) return;
      const isNew = !articleExists.get(feedId, item.guid);
      insertArticle.run(feedId, item.guid, item.url, item.title || stripTags(item.content).slice(0, 120) || '(untitled)',
        item.author || null, item.content, item.image, item.published ?? now - idx, now);
      if (isNew) added++;
    });
    if (markRead) db.prepare('UPDATE articles SET read = 1 WHERE feed_id = ?').run(feedId);
  });
  return added;
}

export async function subscribe(inputUrl, folderId = null) {
  const { url, body } = await discover(inputUrl);
  const existing = db.prepare('SELECT id FROM feeds WHERE url = ?').get(url);
  if (existing) return { id: existing.id, existed: true };

  const parsed = parseFeed(body, url);
  const title = parsed.title || new URL(url).hostname;
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO feeds (url, title, site_url, folder_id, last_fetched, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(url, title, parsed.siteUrl, folderId, Date.now(), Date.now());
  const id = Number(lastInsertRowid);
  storeItems(id, parsed.items);
  // Usually quick; capped so a slow site can't hold up subscribing. A miss is retried on refresh.
  const feed = { id, url, site_url: parsed.siteUrl };
  await Promise.race([updateIcon(feed, parsed.icon).catch(() => {}), new Promise((r) => setTimeout(r, 10_000))]);
  return { id, existed: false };
}

const REFRESH_MS = (Number(process.env.SPOOLRSS_REFRESH_MINUTES) || 15) * 60_000;
const MAX_BACKOFF_MS = 24 * 3_600_000;

class FetchError extends Error {
  constructor(message, { blocked = false, retryAfter = null } = {}) {
    super(message);
    this.blocked = blocked;
    this.retryAfter = retryAfter;
  }
}

/**
 * How long to leave a failing feed alone. Retrying a site that is refusing us on schedule keeps
 * us flagged, so the wait doubles with each failure: from one refresh interval, or from an hour
 * when the site showed a bot check or rate limit, up to a day. A site's Retry-After is honored.
 */
function backoffMs(failCount, { blocked, retryAfter }) {
  const base = blocked ? Math.max(3_600_000, REFRESH_MS) : REFRESH_MS;
  const delay = Math.min(base * 2 ** (failCount - 1), MAX_BACKOFF_MS);
  return Math.min(Math.max(delay, retryAfter ?? 0), MAX_BACKOFF_MS);
}

export async function refreshFeed(feed) {
  try {
    // When the icon needs looking up, fetch the whole feed (not "304 Not Modified") to read its image.
    const needIcon = iconDue(feed.id);
    const headers = {};
    if (feed.etag && !needIcon) headers['If-None-Match'] = feed.etag;
    if (feed.last_modified && !needIcon) headers['If-Modified-Since'] = feed.last_modified;
    const res = await httpGet(feed.url, headers);
    if (isBlocked(res)) {
      res.body?.cancel().catch(() => {});
      throw new FetchError(blockedMessage(new URL(feed.url).hostname), { blocked: true, retryAfter: retryAfterMs(res) });
    }
    if (res.status === 304) {
      db.prepare('UPDATE feeds SET last_fetched = ?, last_error = NULL, fail_count = 0, next_fetch_at = NULL WHERE id = ?').run(Date.now(), feed.id);
      return 0;
    }
    if (!res.ok) throw new FetchError(`HTTP ${res.status}`, { retryAfter: retryAfterMs(res) });
    const parsed = parseFeed(await res.text(), feed.url);
    const added = storeItems(feed.id, parsed.items);
    db.prepare(`UPDATE feeds SET etag = ?, last_modified = ?, last_fetched = ?, last_error = NULL, fail_count = 0, next_fetch_at = NULL,
      site_url = COALESCE(site_url, ?) WHERE id = ?`)
      .run(res.headers.get('etag'), res.headers.get('last-modified'), Date.now(), parsed.siteUrl, feed.id);
    if (needIcon) await updateIcon({ ...feed, site_url: feed.site_url || parsed.siteUrl }, parsed.icon).catch(() => {});
    return added;
  } catch (err) {
    const fails = (feed.fail_count || 0) + 1;
    const message = err.name === 'TimeoutError' ? 'The site took too long to respond' : String(err.message || err);
    db.prepare('UPDATE feeds SET last_fetched = ?, last_error = ?, fail_count = ?, next_fetch_at = ? WHERE id = ?')
      .run(Date.now(), message, fails, Date.now() + backoffMs(fails, err), feed.id);
    return 0;
  }
}

let refreshing = null;

/** Refresh every feed (or one), a few at a time. Concurrent callers share the same run. */
export function refreshAll(feedId = null) {
  if (feedId) {
    const feed = db.prepare('SELECT * FROM feeds WHERE id = ?').get(feedId);
    return feed ? refreshFeed(feed) : Promise.resolve(0);
  }
  if (refreshing) return refreshing;
  refreshing = (async () => {
    // Feeds that are backing off after failures wait their turn (a manual refresh of one feed doesn't).
    const queue = db.prepare('SELECT * FROM feeds WHERE next_fetch_at IS NULL OR next_fetch_at <= ?').all(Date.now());
    let added = 0;
    const worker = async () => {
      while (queue.length) added += await refreshFeed(queue.shift());
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    pruneOld();
    return added;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export function isRefreshing() {
  return Boolean(refreshing);
}

/** One-time fix for titles stored before they were decoded (1.3.0). Refreshes fix the rest. */
function cleanStoredTitles() {
  if (getSetting('titles_cleaned') === '1') return;
  tx(() => {
    for (const table of ['articles', 'feeds']) {
      const fix = db.prepare(`UPDATE ${table} SET title = ? WHERE id = ?`);
      for (const row of db.prepare(`SELECT id, title FROM ${table} WHERE title LIKE '%&%;%' OR title LIKE '%<%>%'`).all()) {
        const clean = plainText(row.title);
        if (clean && clean !== row.title) fix.run(clean, row.id);
      }
    }
    setSetting('titles_cleaned', '1');
  });
}
cleanStoredTitles();

/**
 * Drop read, unstarred articles past the retention window, once their feed no longer lists them.
 * (Some feeds keep old posts for months; deleting those would make them come back unread.)
 */
export function pruneOld() {
  const days = Number(process.env.SPOOLRSS_RETENTION_DAYS || 90);
  if (!days) return;
  db.prepare('DELETE FROM articles WHERE read = 1 AND starred = 0 AND in_feed = 0 AND published < ?').run(Date.now() - days * 86_400_000);
}

// ---- OPML ----

export function exportOpml() {
  const folders = db.prepare('SELECT * FROM folders ORDER BY position, name').all();
  const feeds = db.prepare('SELECT * FROM feeds ORDER BY title COLLATE NOCASE').all();
  const outline = (f) => `<outline type="rss" text="${escapeHtml(f.title)}" title="${escapeHtml(f.title)}" xmlUrl="${escapeHtml(f.url)}"${f.site_url ? ` htmlUrl="${escapeHtml(f.site_url)}"` : ''}/>`;
  const lines = [];
  for (const folder of folders) {
    lines.push(`    <outline text="${escapeHtml(folder.name)}" title="${escapeHtml(folder.name)}">`);
    for (const f of feeds.filter((x) => x.folder_id === folder.id)) lines.push(`      ${outline(f)}`);
    lines.push('    </outline>');
  }
  for (const f of feeds.filter((x) => !x.folder_id)) lines.push(`    ${outline(f)}`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>SpoolRSS subscriptions</title><dateCreated>${new Date().toUTCString()}</dateCreated></head>
  <body>
${lines.join('\n')}
  </body>
</opml>
`;
}

/** Import an OPML file: creates folders and feeds immediately, then fetches them in the background. */
export function importOpml(xml) {
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', processEntities: entityLimits, isArray: (n) => n === 'outline' }).parse(xml);
  const root = doc.opml?.body?.outline;
  if (!root) throw new Error('Not a valid OPML file');

  const getFolder = (name) => {
    db.prepare('INSERT OR IGNORE INTO folders (name, position) VALUES (?, (SELECT COALESCE(MAX(position), 0) + 1 FROM folders))').run(name);
    return db.prepare('SELECT id FROM folders WHERE name = ?').get(name).id;
  };
  const insertFeed = db.prepare('INSERT OR IGNORE INTO feeds (url, title, site_url, folder_id, created_at) VALUES (?, ?, ?, ?, ?)');

  let imported = 0;
  const walk = (outlines, folderId) => {
    for (const o of asArray(outlines)) {
      if (o.xmlUrl) {
        imported += Number(insertFeed.run(o.xmlUrl, o.title || o.text || o.xmlUrl, o.htmlUrl || null, folderId, Date.now()).changes);
      } else if (o.outline) {
        // Nested folders are flattened into their top-level folder.
        walk(o.outline, folderId ?? getFolder(o.title || o.text || 'Imported'));
      }
    }
  };
  tx(() => walk(root, null));
  refreshAll().catch(() => {});
  return imported;
}
