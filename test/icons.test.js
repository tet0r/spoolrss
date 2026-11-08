import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { db } from '../src/db.js';
import { sniffImage, pageIcons, updateIcon, getIcon, iconDue } from '../src/icons.js';

const png = (width, height = width) => {
  const buf = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(40)]);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
};
// JPEG: SOI, an APP0 segment to skip, then a start-of-frame with height 20 and width 30
const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffc0001108001400 1e03012200021101031101'.replace(/ /g, ''), 'hex');
// WebP (lossless VP8L) 24x12
const webp = (() => {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0); b.write('WEBP', 8); b.write('VP8L', 12);
  b[20] = 0x2f;
  b.writeUInt32LE((24 - 1) | ((12 - 1) << 14), 21);
  return b;
})();
const ico = Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0, 32, 32]), Buffer.alloc(40)]);
const pixel = Buffer.from('47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b', 'hex');
const svg = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>');

test('recognizes images by their bytes, not their Content-Type', () => {
  assert.deepEqual(sniffImage(png(32, 16)), ['image/png', 32, 16]);
  assert.deepEqual(sniffImage(ico), ['image/x-icon', 32, 32]);
  assert.deepEqual(sniffImage(pixel), ['image/gif', 1, 1]);
  assert.deepEqual(sniffImage(jpeg), ['image/jpeg', 30, 20]);
  assert.deepEqual(sniffImage(webp), ['image/webp', 24, 12]);
  assert.deepEqual(sniffImage(svg), ['image/svg+xml', null, null]);
  assert.equal(sniffImage(Buffer.from('<!doctype html><html><body>Not found</body></html>')), null);
});

test('ranks declared icons: rel=icon near 32-96px first, apple-touch-icon last', () => {
  const html = `<head>
    <link rel="apple-touch-icon" href="/touch.png">
    <link rel="icon" sizes="192x192" href="/big.png">
    <link rel="shortcut icon" href="/plain.ico">
    <link rel="icon" sizes="48x48" href="/just-right.png">
    <link rel="stylesheet" href="/style.css">
  </head>`;
  assert.deepEqual(pageIcons(html, 'https://site.test/blog/'), [
    'https://site.test/just-right.png', 'https://site.test/plain.ico', 'https://site.test/big.png', 'https://site.test/touch.png',
  ]);
});

// A local site whose routes cover each lookup step.
let server;
let base;
const hits = [];
const ROUTES = {
  '/feed-image.png': ['image/png', png(64)],
  '/banner.png': ['image/png', png(250, 40)],
  '/with-icons/': ['text/html', '<html><head><link rel="icon" href="/declared.png"></head></html>'],
  '/declared.png': ['image/png', png(32)],
  '/plain/': ['text/html', '<html><head></head></html>'],
  '/favicon.ico': ['image/x-icon', ico],
  '/broken/': ['text/html', '<html><head><link rel="icon" href="/missing.png"><link rel="icon" href="/pixel.gif"></head></html>'],
  '/pixel.gif': ['image/gif', pixel],
};

before(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url.startsWith('/challenged/')) {
      res.writeHead(403, { 'cf-mitigated': 'challenge', server: 'cloudflare', 'Content-Type': 'text/html' });
      return res.end('Just a moment...');
    }
    const route = ROUTES[req.url];
    // Like many sites, answer missing files with an HTML page rather than an image.
    if (!route) { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<html>Not found</html>'); }
    res.writeHead(200, { 'Content-Type': route[0] });
    res.end(route[1]);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

let nextId = 9000;
function feed(sitePath, url = `${base}/feed.xml`) {
  const id = nextId++;
  db.prepare('INSERT INTO feeds (id, url, title, site_url, created_at) VALUES (?, ?, ?, ?, ?)').run(id, `${url}#${id}`, 'T', `${base}${sitePath}`, Date.now());
  return { id, url, site_url: `${base}${sitePath}` };
}

test("uses the feed's own image first", async () => {
  const f = feed('/with-icons/');
  assert.equal(await updateIcon(f, `${base}/feed-image.png`), true);
  assert.deepEqual(Buffer.from(getIcon(f.id).data), png(64));
  assert.equal(iconDue(f.id), false);
});

test('skips a feed image that is a wide banner rather than an icon', async () => {
  const f = feed('/with-icons/');
  assert.equal(await updateIcon(f, `${base}/banner.png`), true);
  assert.deepEqual(Buffer.from(getIcon(f.id).data), png(32), 'used the declared site icon instead');
});

test("falls back to the icon the website declares", async () => {
  const f = feed('/with-icons/');
  assert.equal(await updateIcon(f, `${base}/does-not-exist.png`), true);
  assert.deepEqual(Buffer.from(getIcon(f.id).data), png(32));
});

test('then to /favicon.ico', async () => {
  const f = feed('/plain/');
  assert.equal(await updateIcon(f, null), true);
  assert.equal(getIcon(f.id).type, 'image/x-icon');
});

test('ignores HTML error pages and tracking pixels, leaving the letter', async () => {
  delete ROUTES['/favicon.ico'];
  const f = feed('/broken/');
  assert.equal(await updateIcon(f, null), false);
  assert.equal(getIcon(f.id), null);
  assert.equal(iconDue(f.id), false, 'a real miss waits days before trying again');
});

test('retries soon when the site could not be reached', async () => {
  const f = feed('/plain/');
  f.site_url = 'http://127.0.0.1:1/'; // nothing listens on port 1
  assert.equal(await updateIcon(f, null), false);
  db.prepare('UPDATE icons SET checked_at = checked_at - 3700000 WHERE feed_id = ?').run(f.id);
  assert.equal(iconDue(f.id), true, 'an unreachable site is retried within the hour');
});

test('a public feed cannot point SpoolRSS at addresses on the local network', async () => {
  hits.length = 0;
  // An IP literal on the public internet, so no DNS is involved; nothing is fetched from it either.
  const f = feed('/with-icons/', 'https://93.184.215.14/feed.xml');
  assert.equal(await updateIcon(f, `${base}/feed-image.png`), false);
  assert.deepEqual(hits, [], 'no request reached the local server');
});

test('a site behind a bot check is asked once, then left alone for a day', async () => {
  hits.length = 0;
  const f = feed('/challenged/');
  assert.equal(await updateIcon(f, null), false);
  assert.deepEqual(hits, ['/challenged/'], 'no favicon requests after the page was refused');
  assert.equal(iconDue(f.id), false);
  db.prepare('UPDATE icons SET checked_at = checked_at - 2 * 3600000 WHERE feed_id = ?').run(f.id);
  assert.equal(iconDue(f.id), false, 'still waiting after two hours');
  db.prepare('UPDATE icons SET checked_at = checked_at - 23 * 3600000 WHERE feed_id = ?').run(f.id);
  assert.equal(iconDue(f.id), true, 'tried again after a day');
});
