import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isPrivateAddress, isPrivateHost, fetchChecked } from '../src/net.js';
import { parseFeed } from '../src/feeds.js';

test('recognises local-network addresses in every spelling', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '::ffff:808:808']) assert.equal(isPrivateAddress(ip), false, ip);
  // URLs write IPv4-mapped addresses in hex
  assert.equal(await isPrivateHost(new URL('http://[::ffff:127.0.0.1]/').hostname), true);
  assert.equal(await isPrivateHost('localhost'), true);
});

test('fetches from feeds follow redirects hop by hop, web addresses only', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); return res.end(); }
    if (req.url === '/to-js') { res.writeHead(302, { Location: 'javascript:alert(1)' }); return res.end(); }
    if (req.url === '/start') { res.writeHead(301, { Location: '/end' }); return res.end(); }
    res.end('done');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(fetchChecked(`${base}/start`, {}, false), /private network/);
    await assert.rejects(fetchChecked(`http://[::ffff:7f00:1]:${server.address().port}/`, {}, false), /private network/);
    await assert.rejects(fetchChecked('file:///etc/passwd', {}, true), /not a web address/);
    // A local feed may use local pages, and the final address is reported as with redirect: 'follow'.
    const res = await fetchChecked(`${base}/start`, {}, true);
    assert.equal(await res.text(), 'done');
    assert.equal(res.url, `${base}/end`);
    await assert.rejects(fetchChecked(`${base}/loop`, {}, true), /too many redirects/);
    await assert.rejects(fetchChecked(`${base}/to-js`, {}, true), /not a web address/);
  } finally {
    server.close();
  }
});

test('drops article and site links that are not web addresses', () => {
  const feed = parseFeed(`<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><link>javascript:alert(1)</link>
    <item><guid>1</guid><title>Bad</title><link>javascript:fetch('/api/feeds/1',{method:'DELETE'})</link></item>
    <item><guid>2</guid><title>Good</title><link>/post</link></item></channel></rss>`, 'https://example.com/feed');
  assert.equal(feed.siteUrl, null);
  assert.equal(feed.items.find((i) => i.title === 'Bad').url, null);
  assert.equal(feed.items.find((i) => i.title === 'Good').url, 'https://example.com/post');
});

// ---- a password-protected SpoolRSS

const PORT = 19900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'web password';
let app;
let dataDir;

const signIn = (password, headers = {}) => fetch(`${BASE}/login`, {
  method: 'POST',
  redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams({ password, next: '/' }).toString(),
});

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spoolrss-sec-'));
  app = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(PORT), SPOOLRSS_DATA: dataDir, SPOOLRSS_REFRESH_MINUTES: '0', UPDATE_CHECK: 'false', SPOOLRSS_PASSWORD: PASSWORD },
    stdio: 'ignore',
  });
  let up = false;
  for (let i = 0; i < 200 && !up; i++) {
    try { up = (await fetch(`${BASE}/style.css`)).ok; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  if (!up) throw new Error('SpoolRSS did not start');
});

after(async () => {
  if (app && app.exitCode === null) await new Promise((r) => { app.once('exit', r); app.kill(); });
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('pages carry headers that stop framing and outside scripts', async () => {
  const res = await fetch(`${BASE}/`);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(`${BASE}/app.js`)).headers.get('x-content-type-options'), 'nosniff');
});

test('signs in with a cookie that is Secure behind an HTTPS proxy, and changes need the page header', async () => {
  const plain = await signIn(PASSWORD);
  assert.equal(plain.status, 303);
  const cookie = plain.headers.get('set-cookie');
  assert.doesNotMatch(cookie, /Secure/);
  assert.match((await signIn(PASSWORD, { 'X-Forwarded-Proto': 'https' })).headers.get('set-cookie'), /; Secure/);

  const session = cookie.split(';')[0];
  const make = (headers) => fetch(`${BASE}/api/folders`, { method: 'POST', headers: { Cookie: session, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ name: 'News' }) });
  assert.equal((await make({})).status, 403, 'a cross-site form could send this');
  assert.equal((await make({ 'X-SpoolRSS': '1' })).status, 200);
  assert.equal((await fetch(`${BASE}/api/state`, { headers: { Cookie: session } })).status, 200);
});

test('stops password guessing after 10 wrong tries', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await signIn(`guess ${i}`)).status, 401);
  assert.equal((await signIn('guess 11')).status, 429);
  assert.equal((await signIn(PASSWORD)).status, 429, 'even the right password waits');
});
