import { db } from './db.js';
import { isPrivateHost, readHead, isBlocked, fetchChecked } from './net.js';

// Feed icons, looked up on the server and kept in the database:
// the feed's own image first, then the website's favicon. With neither, the UI shows a letter.

const USER_AGENT = 'SpoolRSS/1.0 (+self-hosted feed reader)';
const MAX_BYTES = 512 * 1024;
const FOUND_TTL_MS = 30 * 86_400_000;
const MISSING_TTL_MS = 3 * 86_400_000;
// The site didn't answer (timeout, outage): that says nothing about its icon, so try again soon.
const UNREACHABLE_TTL_MS = 3_600_000;
const UNREACHABLE = 'unreachable';
// The site answered with a bot check or rate limit: asking again soon would only make it worse.
const BLOCKED_TTL_MS = 86_400_000;
const BLOCKED = 'blocked';

export function getIcon(feedId) {
  return db.prepare('SELECT data, type, checked_at FROM icons WHERE feed_id = ? AND data IS NOT NULL').get(feedId) || null;
}

/** Whether this feed's icon has never been looked up, or is old enough to look up again. */
export function iconDue(feedId) {
  const row = db.prepare('SELECT data IS NOT NULL AS found, source, checked_at FROM icons WHERE feed_id = ?').get(feedId);
  if (!row) return true;
  const ttl = row.found ? FOUND_TTL_MS
    : row.source === UNREACHABLE ? UNREACHABLE_TTL_MS
      : row.source === BLOCKED ? BLOCKED_TTL_MS : MISSING_TTL_MS;
  return Date.now() - row.checked_at > ttl;
}

function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length && buf[i] === 0xff) {
    const marker = buf[i + 1];
    // Start-of-frame markers carry the dimensions (C4, C8 and CC are other segments).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return [null, null];
}

function webpSize(buf) {
  const chunk = buf.subarray(12, 16).toString('latin1');
  if (chunk === 'VP8X' && buf.length >= 30) return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)];
  if (chunk === 'VP8 ' && buf.length >= 30) return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
  if (chunk === 'VP8L' && buf.length >= 25) {
    const bits = buf.readUInt32LE(21);
    return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
  }
  return [null, null];
}

/**
 * Identify an image from its first bytes (servers often send the wrong Content-Type).
 * Returns [type, width, height], with null sizes where the format doesn't say, or null if it isn't an image.
 */
export function sniffImage(buf) {
  const ascii = (start, end) => buf.subarray(start, end).toString('latin1');
  if (buf.length >= 24 && buf[0] === 0x89 && ascii(1, 4) === 'PNG') return ['image/png', buf.readUInt32BE(16), buf.readUInt32BE(20)];
  if (buf.length >= 10 && ascii(0, 4) === 'GIF8') return ['image/gif', buf.readUInt16LE(6), buf.readUInt16LE(8)];
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ['image/jpeg', ...jpegSize(buf)];
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x00000100) return ['image/x-icon', buf[6] || 256, buf[7] || 256];
  if (buf.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return ['image/webp', ...webpSize(buf)];
  if (buf.length >= 12 && ascii(4, 12) === 'ftypavif') return ['image/avif', null, null];
  const head = buf.subarray(0, 1024).toString('utf8').trimStart().toLowerCase();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg[\s>]/.test(head)) return ['image/svg+xml', null, null];
  return null;
}

function get(url, accept, allowPrivate, timeoutMs = 10_000) {
  return fetchChecked(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: accept },
    signal: AbortSignal.timeout(timeoutMs),
  }, allowPrivate);
}

async function readLimited(res) {
  const declared = Number(res.headers.get('content-length'));
  if (declared > MAX_BYTES) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length > MAX_BYTES ? null : buf;
}

/**
 * Download a candidate and keep it only if it really is an image of a usable size.
 * With squareOnly, wide banners are refused too (feed images are often logos like 250x40).
 */
async function fetchIcon(url, allowPrivate, { squareOnly = false } = {}) {
  try {
    const res = await get(url, 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5', allowPrivate);
    if (isBlocked(res)) return { blocked: true };
    if (!res.ok) return null;
    const buf = await readLimited(res);
    const sniffed = buf && sniffImage(buf);
    if (!sniffed) return null;
    const [type, width, height] = sniffed;
    // Skip tracking pixels and spacers.
    if ((width !== null && width < 8) || (height !== null && height < 8)) return null;
    if (squareOnly && width && height && Math.max(width, height) / Math.min(width, height) > 1.5) return null;
    return { data: buf, type, source: res.url || url };
  } catch {
    return null;
  }
}

const SIZE_PREFERENCE = (sizes) => {
  if (!sizes) return 1;
  if (/any/i.test(sizes)) return 0;
  const px = Math.max(...sizes.split(/\s+/).map((s) => Number(s.split(/x/i)[0]) || 0));
  return px >= 32 && px <= 96 ? 0 : px > 96 ? 2 : 3;
};

/** Icons a web page declares, best first: rel="icon" (sizes near 32-96px), then apple-touch-icon. */
export function pageIcons(html, baseUrl) {
  const found = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const attr = (name) => tag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1];
    const rel = (attr('rel') || '').toLowerCase().split(/\s+/);
    const href = attr('href');
    if (!href || (!rel.includes('icon') && !rel.includes('apple-touch-icon') && !rel.includes('apple-touch-icon-precomposed'))) continue;
    let url;
    try { url = new URL(href, baseUrl).href; } catch { continue; }
    const touch = !rel.includes('icon');
    found.push({ url, rank: (touch ? 10 : 0) + SIZE_PREFERENCE(attr('sizes')) });
  }
  return found.sort((a, b) => a.rank - b.rank).map((f) => f.url);
}

/** Icons the site's page declares, then /favicon.ico. `reached` is false if the page didn't load at all. */
async function siteCandidates(siteUrl, allowPrivate) {
  const candidates = [];
  let reached = false;
  try {
    // The site address comes from the feed, so it gets the same local-network check as icons.
    if (!allowPrivate && await isPrivateHost(new URL(siteUrl).hostname)) return { candidates, reached: true };
    // Home pages can be large and slow; give them longer than an icon gets.
    const res = await get(siteUrl, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', allowPrivate, 20_000);
    reached = true;
    if (isBlocked(res)) return { candidates, reached, blocked: true };
    if (res.ok && (res.headers.get('content-type') || '').includes('html')) {
      // Icon tags sit in <head>; no need to download all of a multi-megabyte home page.
      const html = (await readHead(res, 300_000)).toString('utf8');
      candidates.push(...pageIcons(html, res.url || siteUrl));
    }
  } catch { /* fall through to /favicon.ico */ }
  candidates.push(new URL('/favicon.ico', siteUrl).href);
  return { candidates, reached };
}

/**
 * Look up and store the icon for a feed. feedImage is the image URL the feed itself declares.
 * Returns true when an icon was found.
 */
export async function updateIcon(feed, feedImage) {
  const siteUrl = feed.site_url || new URL(feed.url).origin;
  const allowPrivate = await isPrivateHost(new URL(feed.url).hostname);
  let result = feedImage ? await fetchIcon(feedImage, allowPrivate, { squareOnly: true }) : null;
  let reached = true;
  let blocked = Boolean(result?.blocked);
  if (!result?.data && !blocked) {
    const site = await siteCandidates(siteUrl, allowPrivate);
    reached = site.reached;
    blocked = Boolean(site.blocked);
    // Stop at the first refusal: more requests to a site that is challenging us keep us flagged.
    for (const candidate of blocked ? [] : [...new Set(site.candidates)]) {
      result = await fetchIcon(candidate, allowPrivate);
      if (result?.data || result?.blocked) break;
    }
    blocked ||= Boolean(result?.blocked);
  }
  const icon = result?.data ? result : null;
  // Keep an icon found earlier if this lookup only failed because the site was down or refusing.
  if (!icon && (!reached || blocked) && getIcon(feed.id)) {
    const ttl = blocked ? BLOCKED_TTL_MS : UNREACHABLE_TTL_MS;
    db.prepare('UPDATE icons SET checked_at = ? WHERE feed_id = ?').run(Date.now() - FOUND_TTL_MS + ttl, feed.id);
    return true;
  }
  db.prepare(`INSERT INTO icons (feed_id, data, type, source, checked_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (feed_id) DO UPDATE SET data = excluded.data, type = excluded.type, source = excluded.source, checked_at = excluded.checked_at`)
    .run(feed.id, icon?.data ?? null, icon?.type ?? null, icon?.source ?? (blocked ? BLOCKED : reached ? null : UNREACHABLE), Date.now());
  return Boolean(icon);
}
