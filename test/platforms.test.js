import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { parseHTML } from 'linkedom';
import { signIn, unreadSummary, subscribe, canSubscribe, AuthError } from '../extension/api.js';
import { md5 } from '../extension/md5.js';
import { findFeeds } from '../extension/find-feeds.js';

// The extension's other platforms, each against a small stand-in that answers the way the
// platform's API is documented to. (SpoolRSS itself is tested against the real server in
// extension.test.js.)

const USER = 'reader';
const PASS = 'secret pass';
const NOW = Math.floor(Date.UTC(2026, 10, 8) / 1000);
let server;
let base;
const added = [];

const json = (res, body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { let s = ''; req.on('data', (d) => { s += d; }); req.on('end', () => r(s)); });
const basic = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;

before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = await readBody(req);

    // Miniflux: X-Auth-Token
    if (url.pathname.startsWith('/miniflux/v1/')) {
      if (req.headers['x-auth-token'] !== 'mf-key') return json(res, { error_message: 'Access Unauthorized' }, 401);
      const p = url.pathname.slice('/miniflux/v1'.length);
      if (p === '/me') return json(res, { id: 1, username: USER });
      if (p === '/entries') {
        assert.equal(url.searchParams.get('status'), 'unread');
        return json(res, { total: 12, entries: [{ title: 'MF story', url: 'https://mf.example/1', published_at: '2026-11-08T10:00:00Z', feed: { title: 'MF feed' } }] });
      }
      if (p === '/categories') return json(res, [{ id: 7, title: 'All' }]);
      if (p === '/feeds' && req.method === 'POST') {
        const b = JSON.parse(body);
        if (b.feed_url.includes('bad')) return json(res, { error_message: 'This feed already exists' }, 400);
        added.push(['miniflux', b.feed_url, b.category_id]);
        return json(res, { feed_id: 3 }, 201);
      }
    }

    // Tiny Tiny RSS: JSON body with op and sid
    if (url.pathname === '/tt/api/') {
      const b = JSON.parse(body);
      const ok = (content) => json(res, { seq: 0, status: 0, content });
      const err = (error) => json(res, { seq: 0, status: 1, content: { error } });
      if (b.op === 'login') return b.user === USER && b.password === PASS ? ok({ session_id: 'tt-sid', api_level: 18 }) : err('LOGIN_ERROR');
      if (b.sid !== 'tt-sid') return err('NOT_LOGGED_IN');
      if (b.op === 'getUnread') return ok({ unread: '5' });
      if (b.op === 'getHeadlines') {
        assert.equal(b.feed_id, -4);
        return ok([{ title: 'TT story', link: 'https://tt.example/1', feed_title: 'TT feed', updated: NOW }]);
      }
      if (b.op === 'subscribeToFeed') { added.push(['ttrss', b.feed_url]); return ok({ status: { code: 1 } }); }
    }

    // Nextcloud News: HTTP Basic
    if (url.pathname.startsWith('/nc/index.php/apps/news/api/v1-3/')) {
      if (req.headers.authorization !== basic) return json(res, { message: 'Unauthorized' }, 401);
      const p = url.pathname.slice('/nc/index.php/apps/news/api/v1-3'.length);
      if (p === '/feeds' && req.method === 'GET') return json(res, { feeds: [{ id: 1, title: 'NC feed', unreadCount: 4 }, { id: 2, title: 'Other', unreadCount: 2 }], starredCount: 0 });
      if (p === '/items') {
        assert.equal(url.searchParams.get('getRead'), 'false');
        return json(res, { items: [{ title: 'NC story', url: 'https://nc.example/1', feedId: 1, pubDate: NOW }] });
      }
      if (p === '/feeds' && req.method === 'POST') {
        const b = JSON.parse(body);
        if (b.url.includes('dupe')) return json(res, { message: 'Feed exists' }, 409);
        added.push(['nextcloud', b.url]);
        return json(res, { feeds: [{ id: 3 }] });
      }
    }

    // Fever: api_key in the form body
    if (url.pathname === '/fever/' && url.searchParams.has('api')) {
      const key = new URLSearchParams(body).get('api_key');
      if (key !== crypto.createHash('md5').update(`${USER}:${PASS}`).digest('hex')) return json(res, { api_version: 3, auth: 0 });
      const out = { api_version: 3, auth: 1 };
      if (url.searchParams.has('unread_item_ids')) out.unread_item_ids = '3,10,7';
      if (url.searchParams.has('items')) {
        assert.equal(url.searchParams.get('with_ids'), '10,7,3');
        out.items = [3, 10, 7].map((id) => ({ id, feed_id: 1, title: `Fever ${id}`, url: `https://fv.example/${id}`, created_on_time: NOW - 100 + id }));
      }
      if (url.searchParams.has('feeds')) out.feeds = [{ id: 1, title: 'Fever feed' }];
      return json(res, out);
    }

    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

test('MD5 matches the standard one, for the Fever api_key', () => {
  for (const s of ['', 'abc', 'a'.repeat(64), `${USER}:${PASS}`, 'ünïcødé 🙂']) {
    assert.equal(md5(s), crypto.createHash('md5').update(s, 'utf8').digest('hex'));
  }
});

test('Miniflux: API key, unread count, newest articles and subscribing', async () => {
  const account = { platform: 'miniflux', server: `${base}/miniflux` };
  await assert.rejects(signIn(account, '', 'wrong'), (err) => err instanceof AuthError && /API key/.test(err.message));
  const token = await signIn(account, '', 'mf-key');
  const summary = await unreadSummary({ ...account, token });
  assert.equal(summary.count, 12);
  assert.deepEqual(summary.items[0], { title: 'MF story', feed: 'MF feed', url: 'https://mf.example/1', published: Date.parse('2026-11-08T10:00:00Z') });
  await subscribe({ ...account, token }, 'https://site.example/feed.xml');
  assert.deepEqual(added.at(-1), ['miniflux', 'https://site.example/feed.xml', 7]);
  await assert.rejects(subscribe({ ...account, token }, 'https://bad.example/feed'), /Miniflux: This feed already exists/);
});

test('Tiny Tiny RSS: session sign-in, unread count, headlines and subscribing', async () => {
  const account = { platform: 'ttrss', server: `${base}/tt` };
  await assert.rejects(signIn(account, USER, 'nope'), (err) => err instanceof AuthError && /Wrong username or password/.test(err.message));
  const token = await signIn(account, USER, PASS);
  assert.equal(token, 'tt-sid');
  const summary = await unreadSummary({ ...account, token });
  assert.equal(summary.count, 5);
  assert.deepEqual(summary.items[0], { title: 'TT story', feed: 'TT feed', url: 'https://tt.example/1', published: NOW * 1000 });
  await assert.rejects(unreadSummary({ ...account, token: 'expired' }), AuthError);
  await subscribe({ ...account, token }, 'https://site.example/tt.xml');
  assert.deepEqual(added.at(-1), ['ttrss', 'https://site.example/tt.xml']);
});

test('Nextcloud News: app password, unread count across feeds, items and subscribing', async () => {
  const account = { platform: 'nextcloud', server: `${base}/nc` };
  await assert.rejects(signIn(account, USER, 'nope'), AuthError);
  const token = await signIn(account, USER, PASS);
  const summary = await unreadSummary({ ...account, token });
  assert.equal(summary.count, 6);
  assert.deepEqual(summary.items[0], { title: 'NC story', feed: 'NC feed', url: 'https://nc.example/1', published: NOW * 1000 });
  await subscribe({ ...account, token }, 'https://site.example/nc.xml');
  assert.deepEqual(added.at(-1), ['nextcloud', 'https://site.example/nc.xml']);
  await subscribe({ ...account, token }, 'https://site.example/dupe.xml'); // already subscribed is fine
});

test('Fever: api_key sign-in, unread count and newest items; no subscribing', async () => {
  const account = { platform: 'fever', server: `${base}/fever/` };
  await assert.rejects(signIn(account, USER, 'nope'), (err) => err instanceof AuthError && /Wrong username or password/.test(err.message));
  const token = await signIn(account, USER, PASS);
  const summary = await unreadSummary({ ...account, token });
  assert.equal(summary.count, 3);
  assert.deepEqual(summary.items.map((i) => i.title), ['Fever 10', 'Fever 7', 'Fever 3']);
  assert.equal(summary.items[0].feed, 'Fever feed');
  assert.equal(canSubscribe({ ...account, token }), false);
  assert.equal(canSubscribe({ platform: 'miniflux', server: base }), true);
  await assert.rejects(subscribe({ ...account, token }, 'https://x.example/feed'), /can't subscribe/);
});

test("finds the feeds a page offers, and recognizes a page that's a feed", () => {
  const page = (html, href = 'https://blog.example/post/1') => {
    const { document } = parseHTML(html);
    Object.defineProperty(document, 'baseURI', { value: href });
    globalThis.document = document;
    globalThis.location = { href };
  };
  try {
    page(`<html><head><title>A blog</title>
      <link rel="alternate" type="application/rss+xml" title="Posts" href="/feed.xml">
      <link rel="alternate" type="application/atom+xml" href="https://blog.example/atom">
      <link rel="alternate" type="application/feed+json" title="JSON" href="/feed.json">
      <link rel="alternate" type="application/rss+xml" title="Posts again" href="/feed.xml">
      <link rel="alternate" type="application/json+oembed" href="/oembed?url=1">
      <link rel="alternate" hreflang="fr" href="/fr/">
      <link rel="alternate" type="text/xml" href="/sitemap.xml">
      <link rel="alternate" type="application/xml" title="RSS" href="/rss.xml">
      <link rel="alternate" type="application/rss+xml" href="javascript:alert(1)">
      </head><body></body></html>`);
    assert.deepEqual(findFeeds().map((f) => [f.url, f.title]), [
      ['https://blog.example/feed.xml', 'Posts'],
      ['https://blog.example/atom', 'A blog'],
      ['https://blog.example/feed.json', 'JSON'],
      ['https://blog.example/rss.xml', 'RSS'],
    ]);

    page('<rss version="2.0"><channel><title>Raw feed</title></channel></rss>', 'https://x.example/rss');
    assert.deepEqual(findFeeds().map((f) => [f.url, f.title]), [['https://x.example/rss', 'Raw feed']]);

    page('<html><head><title>Nothing</title></head><body></body></html>');
    assert.deepEqual(findFeeds(), []);
  } finally {
    delete globalThis.document;
    delete globalThis.location;
  }
});
