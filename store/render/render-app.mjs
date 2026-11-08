// Renders the README's screenshot of the app (docs/screenshot.webp): a real SpoolRSS with a
// throwaway database, subscribed to made-up feeds served from this script, shown in headless
// Chrome in the classic layout with one article open.
//   node store/render/render-app.mjs
// Needs Chrome or Edge installed (set CHROME=/path/to/chrome to choose one).

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const OUT = path.join(root, 'docs', 'screenshot.webp');
// 2000 x 1344 pixels
const VIEW = { width: 1280, height: 860, scale: 1.5625 };

// ---- made-up feeds

const COLORS = ['#1f6feb', '#d1242f', '#1a7f37', '#8250df', '#bf8700', '#0a7ea4', '#cf4a9a', '#e16f24', '#57606a', '#2da44e'];
const FEEDS = [
  { slug: 'riverside', title: 'Riverside Local', folder: 'News', posts: [
    'City council approves new bike lanes along the waterfront', 'Farmers market moves to Saturdays for the summer',
    'Library extends weekend hours after record visits', 'New ferry schedule adds late-night crossings'] },
  { slug: 'cityhall', title: 'City Hall Minutes', folder: 'News', hidden: true, posts: [
    'Agenda: parks committee, Tuesday 6pm', 'Agenda: transport committee, Wednesday 5pm', 'Minutes: budget hearing, part 3',
    'Minutes: budget hearing, part 2', 'Notice: road closure on Elm Street'] },
  { slug: 'brief', title: 'The Morning Brief', folder: 'News', posts: [
    'Five things to know before you start your day', 'Rail strike talks resume as both sides signal progress',
    'Heat wave expected to ease by the weekend'] },
  { slug: 'techweekly', title: 'Tech Weekly', folder: 'Tech', posts: [
    'Ten small changes that make home Wi-Fi noticeably faster', 'Hands-on with the new e-ink tablets',
    'Why your next laptop might charge in 20 minutes', 'The quiet return of physical buttons'] },
  { slug: 'opensource', title: 'Open Source Digest', folder: 'Tech', posts: [
    'A self-hosting starter kit for your first home server', 'Release roundup: databases, editors and a new shell',
    'How a two-person project reached a million installs'] },
  { slug: 'pixel', title: 'Pixel & Code', folder: 'Tech', posts: [
    'Building a tiny weather station with a $5 board', 'CSS tricks for layouts that survive any screen'] },
  { slug: 'kitchen', title: 'Weeknight Kitchen', folder: 'Food & Home', posts: [
    'One-pan lemon garlic chicken for busy weeknights', 'The five-ingredient pasta we keep coming back to',
    'How to keep herbs fresh for two weeks'] },
  { slug: 'garden', title: 'Garden Notes', folder: 'Food & Home', posts: [
    'What to plant now for a fall harvest', 'Tomatoes splitting? Here is what to do'] },
  { slug: 'ballpark', title: 'Ballpark Daily', posts: [
    'Rookie pitcher throws first career shutout in 3-0 win', 'Trade deadline: three moves that could still happen',
    'Ranking every ballpark hot dog we tried this season'] },
  { slug: 'space', title: 'Space Notes', posts: [
    'Tonight: the best meteor shower of the year, and where to look', 'A new telescope image shows a galaxy merger in detail'] },
];

const OPEN_TITLE = 'City council approves new bike lanes along the waterfront';
const OPEN_BODY = `
  <p>The city council voted 7–2 on Tuesday to build protected bike lanes along the full length of the waterfront, linking the ferry terminal with the new riverside park by next summer.</p>
  <p>The plan replaces one lane of parking on Harbor Road with a two-way cycle track separated from traffic by planters. Crossings at the four busiest junctions get raised tables and their own signals.</p>
  <p>“People already ride here. This makes it safe for the ones who don't yet,” said council member Ana Ruiz, who proposed the plan. Local businesses asked for loading zones on the side streets, which the final version includes.</p>
  <p>Work starts in March and is expected to take five months. Harbor Road stays open to traffic throughout.</p>`;

// Opening lines for the articles that aren't opened, shown after each headline in the list.
const LEADS = [
  'We tried it for a month so you don’t have to.', 'The short version: it’s better than it sounds.',
  'A quick guide, with the parts that surprised us most.', 'Plans change, but here’s where things stand this week.',
  'It started as a side project and got out of hand, in a good way.', 'Three experts walked us through the details.',
  'You probably have everything you need already.', 'Here are the numbers, and what they mean for you.',
];
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const icon = (letter, color) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${color}"/><text x="16" y="22" font-family="Segoe UI, Arial, sans-serif" font-size="17" font-weight="700" fill="#fff" text-anchor="middle">${letter}</text></svg>`;
const HERO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 120 1200 440">
  <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9cc9f5"/><stop offset="1" stop-color="#e4f1fc"/></linearGradient>
  <linearGradient id="water" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4f8fc9"/><stop offset="1" stop-color="#2b5f93"/></linearGradient></defs>
  <rect width="1200" height="560" fill="url(#sky)"/>
  <circle cx="960" cy="120" r="56" fill="#fff6d5"/>
  <path d="M0 300 L120 240 L220 280 L340 210 L460 270 L560 230 L700 290 L820 240 L980 280 L1100 230 L1200 270 L1200 330 L0 330Z" fill="#7aa3c9" opacity=".6"/>
  <rect y="320" width="1200" height="120" fill="url(#water)"/>
  <rect y="440" width="1200" height="120" fill="#5b6470"/>
  <rect y="455" width="1200" height="44" fill="#2f8f5b"/>
  <g stroke="#fff" stroke-width="4" stroke-dasharray="30 24"><line x1="0" y1="477" x2="1200" y2="477"/></g>
  <g fill="#e8eef4" stroke="#fff" stroke-width="3"><circle cx="420" cy="476" r="14" fill="none"/><circle cx="470" cy="476" r="14" fill="none"/><path d="M420 476 L440 452 L462 452 L470 476 M440 452 L448 476" fill="none"/></g>
  <g fill="#3d8b37"><rect x="80" y="430" width="70" height="26" rx="6"/><rect x="620" y="430" width="70" height="26" rx="6"/><rect x="1020" y="430" width="70" height="26" rx="6"/></g>
</svg>`;

// Articles from every feed, newest first across feeds so the list mixes sources.
let minutesAgo = 9;
const articles = [];
FEEDS.forEach((feed, f) => {
  feed.color = COLORS[f % COLORS.length];
  feed.posts.forEach((title, p) => articles.push({ feed, title, slot: p * FEEDS.length + f }));
});
articles.sort((a, b) => a.slot - b.slot);
for (const a of articles) {
  a.published = Date.now() - minutesAgo * 60_000;
  minutesAgo += a.title === OPEN_TITLE ? 1 : 23 + (a.slot % 5) * 9;
}
// The open article is fifth in All articles, so headlines show above it.
const opened = articles.find((a) => a.title === OPEN_TITLE);
const before = articles.filter((a) => a !== opened && !a.feed.hidden).sort((x, y) => y.published - x.published);
opened.published = before[3].published - 7 * 60_000;

function feedXml(feed, base) {
  const items = articles.filter((a) => a.feed === feed).map((a, i) => {
    const body = a === opened
      ? `<p><img src="${base}/hero.svg" alt="A bike lane along the waterfront"></p>${OPEN_BODY}`
      : `<p>${LEADS[(a.slot + i) % LEADS.length]} ${'Here is what we know so far, and what to watch for next. '.repeat(3)}</p>`;
    return `<item><guid>${feed.slug}-${i}</guid><title>${esc(a.title)}</title><link>${base}/${feed.slug}/${i}</link>
      <author>${feed === FEEDS[0] ? 'Sam Okafor' : 'Staff'}</author>
      <description>${esc(body)}</description><pubDate>${new Date(a.published).toUTCString()}</pubDate></item>`;
  }).join('');
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>${esc(feed.title)}</title><link>${base}/${feed.slug}/</link>
    <image><url>${base}/icons/${feed.slug}.svg</url></image>${items}</channel></rss>`;
}

// ---- servers

const feedServer = http.createServer((req, res) => {
  const base = `http://127.0.0.1:${feedServer.address().port}`;
  const { pathname } = new URL(req.url, base);
  const feed = FEEDS.find((f) => pathname === `/${f.slug}.xml`);
  if (feed) { res.writeHead(200, { 'Content-Type': 'application/rss+xml' }); return res.end(feedXml(feed, base)); }
  const iconFeed = FEEDS.find((f) => pathname === `/icons/${f.slug}.svg`);
  if (iconFeed) { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); return res.end(icon(iconFeed.title[0], iconFeed.color)); }
  if (pathname === '/hero.svg') { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); return res.end(HERO); }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => feedServer.listen(0, '127.0.0.1', r));
const feedBase = `http://127.0.0.1:${feedServer.address().port}`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spoolrss-demo-'));
const appPort = 18900 + Math.floor(Math.random() * 90);
const appBase = `http://127.0.0.1:${appPort}`;
const env = { ...process.env, PORT: String(appPort), SPOOLRSS_DATA: dataDir, SPOOLRSS_REFRESH_MINUTES: '0', UPDATE_CHECK: 'false', SPOOLRSS_PASSWORD: '' };
const app = spawn(process.execPath, [path.join(root, 'src', 'server.js')], { cwd: root, env, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (p, body, method = body ? 'POST' : 'GET') => fetch(appBase + p, {
  method, headers: { 'Content-Type': 'application/json', 'X-SpoolRSS': '1' }, body: body && JSON.stringify(body),
}).then((r) => r.json());

function findChrome() {
  const candidates = [
    process.env.CHROME,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) throw new Error('Chrome or Edge not found; set CHROME to its path');
  return found;
}

/** A page in headless Chrome, driven over the DevTools protocol. */
async function openChrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'spoolrss-render-'));
  const port = 9400 + Math.floor(Math.random() * 500);
  const proc = spawn(findChrome(), ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    try { target = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())).find((t) => t.type === 'page'); } catch { await sleep(100); }
  }
  if (!target) throw new Error('Chrome did not start');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    waiting.set(n, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const close = async () => {
    ws.close();
    proc.kill();
    await sleep(500);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { send, close };
}

try {
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`${appBase}/api/state`)).ok) break; } catch { await sleep(100); }
  }
  const folders = {};
  for (const name of [...new Set(FEEDS.map((f) => f.folder).filter(Boolean))]) folders[name] = (await api('/api/folders', { name })).id;
  for (const feed of FEEDS) {
    const r = await api('/api/feeds', { url: `${feedBase}/${feed.slug}.xml`, folderId: folders[feed.folder] || null });
    feed.id = r.id;
    if (feed.hidden) await api(`/api/feeds/${feed.id}`, { hideInAll: true }, 'PATCH');
  }
  // Some articles already read, as in a reader that's in use.
  const all = (await api('/api/articles?view=all&limit=200')).items;
  for (const [i, a] of all.entries()) {
    if (i > 14 && i % 3 !== 0) await api(`/api/articles/${a.id}`, { read: true }, 'PATCH');
  }
  // Icons are fetched in the background after subscribing.
  for (let i = 0; i < 50; i++) {
    if ((await api('/api/state')).feeds.every((f) => f.icon)) break;
    await sleep(200);
  }

  const page = await openChrome();
  try {
    await page.send('Emulation.setDeviceMetricsOverride', { width: VIEW.width, height: VIEW.height, deviceScaleFactor: VIEW.scale, mobile: false });
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await page.send('Page.enable');
    await page.send('Page.navigate', { url: `${appBase}/` });
    await sleep(1500);
    // Show the feed's own text: the demo articles have no web pages to fetch full text from.
    const fullText = Object.fromEntries(FEEDS.map((f) => [f.id, 'feed']));
    await page.send('Runtime.evaluate', { expression: `localStorage.setItem('spoolrss:fullText', ${JSON.stringify(JSON.stringify(fullText))})` });
    await page.send('Page.reload');
    await sleep(2500);
    // Open the bike lanes story in place, as a click on its headline would.
    await page.send('Runtime.evaluate', {
      awaitPromise: true,
      expression: `(async () => {
        const row = [...document.querySelectorAll('#articles .entry')].find((e) => e.querySelector('.ct')?.textContent === ${JSON.stringify(OPEN_TITLE)});
        row.querySelector('.crow').click();
        await new Promise((r) => setTimeout(r, 1500));
        document.getElementById('articles').scrollTop = 0;
        await new Promise((r) => setTimeout(r, 300));
      })()`,
    });
    const shot = await page.send('Page.captureScreenshot', { format: 'webp', quality: 90 });
    fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
    console.log(`wrote ${path.relative(root, OUT)} (${Math.round(VIEW.width * VIEW.scale)}x${Math.round(VIEW.height * VIEW.scale)})`);
  } finally {
    await page.close();
  }
} finally {
  feedServer.close();
  if (app.exitCode === null) await new Promise((r) => { app.once('exit', r); app.kill(); });
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
