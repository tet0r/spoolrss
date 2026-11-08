import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { db } from '../src/db.js';
import { refreshFeed, refreshAll, pruneOld } from '../src/feeds.js';

// A local site whose feed can be switched between working, broken and behind a bot check.
const FEED = '<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><link>/</link><item><guid>1</guid><title>One</title></item></channel></rss>';
let mode = 'ok';
let hits = 0;
let server;
let feedUrl;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url !== '/feed.xml') { res.writeHead(404); return res.end(); }
    hits++;
    if (mode === 'challenge') { res.writeHead(403, { 'cf-mitigated': 'challenge', server: 'cloudflare', 'Content-Type': 'text/html' }); return res.end('Just a moment...'); }
    if (mode === 'limited') { res.writeHead(429, { 'Retry-After': '7200' }); return res.end(); }
    if (mode === 'broken') { res.writeHead(500); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
    res.end(FEED);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  feedUrl = `http://127.0.0.1:${server.address().port}/feed.xml`;
  db.prepare("INSERT INTO feeds (id, url, title, created_at) VALUES (7001, ?, 'T', ?)").run(feedUrl, Date.now());
  // An icon on record, so these refreshes don't also look one up.
  db.prepare("INSERT INTO icons (feed_id, data, type, checked_at) VALUES (7001, x'00', 'image/png', ?)").run(Date.now());
});
after(() => server.close());

const feed = () => db.prepare('SELECT * FROM feeds WHERE id = 7001').get();
const minutesUntilRetry = () => Math.round((feed().next_fetch_at - Date.now()) / 60_000);

test('a bot check is reported plainly and backs off from an hour, doubling', async () => {
  mode = 'challenge';
  await refreshFeed(feed());
  assert.match(feed().last_error, /asked for a browser check/);
  assert.equal(feed().fail_count, 1);
  assert.equal(minutesUntilRetry(), 60);
  await refreshFeed(feed());
  assert.equal(minutesUntilRetry(), 120);
});

test('scheduled refreshes leave a backing-off feed alone', async () => {
  hits = 0;
  await refreshAll();
  assert.equal(hits, 0);
});

test("a site's Retry-After is honored", async () => {
  mode = 'limited';
  db.prepare('UPDATE feeds SET fail_count = 0 WHERE id = 7001').run();
  await refreshFeed(feed());
  assert.equal(minutesUntilRetry(), 120);
});

test('an ordinary failure retries on the normal schedule first', async () => {
  mode = 'broken';
  db.prepare('UPDATE feeds SET fail_count = 0 WHERE id = 7001').run();
  await refreshFeed(feed());
  assert.equal(feed().last_error, 'HTTP 500');
  assert.equal(minutesUntilRetry(), 15);
});

test('a successful refresh clears the error and the backoff', async () => {
  mode = 'ok';
  await refreshFeed(feed());
  assert.equal(feed().last_error, null);
  assert.equal(feed().fail_count, 0);
  assert.equal(feed().next_fetch_at, null);
});

test('old read articles are kept while their feed still lists them', async () => {
  const old = Date.now() - 400 * 86_400_000;
  db.prepare("INSERT INTO articles (feed_id, guid, title, published, fetched_at, read) VALUES (7001, 'gone', 'Gone', ?, ?, 1)").run(old, old);
  db.prepare("UPDATE articles SET read = 1, published = ? WHERE feed_id = 7001").run(old);
  mode = 'ok';
  await refreshFeed({ ...feed(), etag: null, last_modified: null });
  pruneOld();
  const guids = db.prepare('SELECT guid FROM articles WHERE feed_id = 7001').all().map((a) => a.guid);
  assert.deepEqual(guids, ['1']); // still in the feed: kept; dropped from it: pruned
  await refreshFeed({ ...feed(), etag: null, last_modified: null });
  assert.equal(db.prepare("SELECT read FROM articles WHERE feed_id = 7001 AND guid = '1'").get().read, 1);
});
