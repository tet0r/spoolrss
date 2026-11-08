import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import { db } from './db.js';
import { isPrivateHost, readHead, isBlocked, fetchChecked } from './net.js';

// Many feeds carry only a summary. This fetches the article's page and pulls out the main
// text with Readability (the engine behind Firefox's Reader View), once per article.

const USER_AGENT = 'SpoolRSS/1.0 (+self-hosted feed reader)';
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MIN_TEXT_CHARS = 250;
// A failure is often temporary (timeout, outage), so try again after a while.
const ERROR_RETRY_MS = 3_600_000;

/** Decode with the page's own charset: fetch's .text() assumes UTF-8, which garbles older sites. */
function decode(buf, contentType) {
  const declared = /charset=["']?([\w-]+)/i.exec(contentType || '')?.[1]
    || /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 4096).toString('latin1'))?.[1];
  try {
    return new TextDecoder(declared || 'utf-8').decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

/** Extract the readable article from a page's HTML. Returns { content, title, byline } or null. */
export function extract(html, pageUrl) {
  const { document } = parseHTML(html);
  const article = new Readability(document, { charThreshold: MIN_TEXT_CHARS }).parse();
  if (!article?.content || (article.textContent || '').trim().length < MIN_TEXT_CHARS) return null;

  // Make links and images absolute, and promote lazy-loaded images, so they work outside the site.
  const { document: out } = parseHTML(`<!doctype html><html><body>${article.content}</body></html>`);
  const absolute = (v) => { try { return new URL(v, pageUrl).href; } catch { return v; } };
  for (const img of out.querySelectorAll('img')) {
    const lazy = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original');
    const src = img.getAttribute('src');
    if (lazy && (!src || src.startsWith('data:'))) img.setAttribute('src', lazy);
    if (img.getAttribute('src')) img.setAttribute('src', absolute(img.getAttribute('src')));
  }
  for (const a of out.querySelectorAll('a[href]')) a.setAttribute('href', absolute(a.getAttribute('href')));
  return { content: out.body.innerHTML, title: article.title || '', byline: article.byline || '' };
}

async function fetchPage(url, allowPrivate) {
  const res = await fetchChecked(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
    signal: AbortSignal.timeout(20_000),
  }, allowPrivate);
  if (isBlocked(res)) throw new Error("the site asked for a browser check, which SpoolRSS can't complete");
  if (res.status === 401 || res.status === 403 || res.status === 429) throw new Error(`the site refused the request (HTTP ${res.status})`);
  if (!res.ok) throw new Error(`the site returned HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (type && !/html|xml/i.test(type)) throw new Error('the link is not a web page');
  const html = decode(await readHead(res, MAX_PAGE_BYTES), type);
  return { html, finalUrl: res.url || url };
}

/**
 * The full article for an article id: from the cache, or fetched now.
 * Returns { content } or { error } (a reason to show the reader).
 */
export async function fullArticle(articleId) {
  const article = db.prepare('SELECT a.id, a.url, f.url AS feed_url FROM articles a JOIN feeds f ON f.id = a.feed_id WHERE a.id = ?').get(articleId);
  if (!article) return null;
  const cached = db.prepare('SELECT content, error, fetched_at FROM fulltext WHERE article_id = ?').get(articleId);
  if (cached?.content) return { content: cached.content };
  if (cached?.error && Date.now() - cached.fetched_at < ERROR_RETRY_MS) return { error: cached.error };
  if (!article.url) return { error: 'this article has no link to fetch' };

  let result;
  try {
    // Only a feed that is itself on the local network may link to local pages.
    const allowPrivate = await isPrivateHost(new URL(article.feed_url).hostname);
    const { html, finalUrl } = await fetchPage(article.url, allowPrivate);
    const extracted = extract(html, finalUrl);
    result = extracted ? { content: extracted.content } : { error: "couldn't find the article text on the page" };
  } catch (err) {
    result = { error: err.name === 'TimeoutError' ? 'the site took too long to respond' : err.message };
  }
  db.prepare(`INSERT INTO fulltext (article_id, content, error, fetched_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (article_id) DO UPDATE SET content = excluded.content, error = excluded.error, fetched_at = excluded.fetched_at`)
    .run(articleId, result.content ?? null, result.error ?? null, Date.now());
  return result;
}
