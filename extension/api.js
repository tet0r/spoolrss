// Talks to the feed reader the extension is connected to: SpoolRSS or another self-hosted reader.
// Each platform has an adapter with the same three jobs: sign in (returning the token to keep),
// read the unread count and newest unread articles, and subscribe to a feed.

import { md5 } from './md5.js';

export class AuthError extends Error {}

/**
 * The platforms people can pick in the options page. `login` is what they enter: a username and
 * password, or an API key. `address` labels the address field, which for the two "other" choices
 * is the API's own address rather than the reader's.
 */
export const PLATFORMS = {
  spoolrss: {
    name: 'SpoolRSS', api: 'greader', login: 'password', address: 'SpoolRSS address', placeholder: 'https://feeds.example.com',
    password: 'App password', help: "In SpoolRSS, open Settings → Reading apps and choose a username and app password.",
  },
  freshrss: {
    name: 'FreshRSS', api: 'greader', login: 'password', address: 'FreshRSS address', placeholder: 'https://freshrss.example.com',
    password: 'API password', help: 'In FreshRSS, allow API access (Administration → Authentication) and set an API password (Settings → Profile).',
  },
  miniflux: {
    name: 'Miniflux', api: 'miniflux', login: 'key', address: 'Miniflux address', placeholder: 'https://miniflux.example.com',
    password: 'API key', help: 'In Miniflux, open Settings → API Keys and create a key.',
  },
  ttrss: {
    name: 'Tiny Tiny RSS', api: 'ttrss', login: 'password', address: 'Tiny Tiny RSS address', placeholder: 'https://example.com/tt-rss',
    password: 'Password', help: 'In Tiny Tiny RSS, turn on "Enable API" in Preferences, then sign in with your username and password (or an app password).',
  },
  nextcloud: {
    name: 'Nextcloud News', api: 'nextcloud', login: 'password', address: 'Nextcloud address', placeholder: 'https://cloud.example.com',
    password: 'App password', help: "Create an app password in Nextcloud's Personal settings → Security, and use it with your Nextcloud username.",
  },
  greader: {
    name: 'Other (Google Reader API)', api: 'greader', login: 'password', address: 'Google Reader API address', placeholder: 'https://example.com/api/greader.php',
    password: 'Password', help: 'For readers with a Google Reader–compatible API, such as The Old Reader, BazQux or Miniflux. Enter the API address: the part before /accounts/ClientLogin.',
  },
  fever: {
    name: 'Other (Fever API)', api: 'fever', login: 'password', address: 'Fever API address', placeholder: 'https://example.com/fever/',
    password: 'Password', help: 'For readers with a Fever-compatible API, such as yarr, CommaFeed or Tiny Tiny RSS with its Fever plugin. Fever has no way to subscribe, so feeds found on a page can be copied instead.',
  },
};

export const platform = (id) => PLATFORMS[id] || PLATFORMS.spoolrss;

/** "feeds.example.com/" -> "https://feeds.example.com"; keeps a sub-path such as /spoolrss. */
export function normalizeServer(input, id = 'spoolrss') {
  let s = String(input || '').trim();
  if (!s) throw new Error(`Enter your ${platform(id).address}`);
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** The match pattern to ask the browser for access to, e.g. "https://feeds.example.com/*". */
export function originPattern(server) {
  return `${new URL(server).origin}/*`;
}

/** The reader's own web page, for the popup's Open button. */
export function webAddress(id, server) {
  if (id === 'nextcloud') return `${server}/index.php/apps/news/`;
  if (id === 'greader' || id === 'fever') {
    // An API address: drop the API part, e.g. https://x/api/greader.php -> https://x/
    return `${server.replace(/\/(api\/(greader|fever)\.php|fever|plugins(\.local)?\/fever|plugins\/fever\/api|api)$/i, '')}/`;
  }
  return `${server}/`;
}

// ---- HTTP

async function request(name, url, { method = 'GET', headers = {}, form, json, timeoutMs = 15_000 } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...headers,
        ...(form && { 'Content-Type': 'application/x-www-form-urlencoded' }),
        ...(json && { 'Content-Type': 'application/json' }),
      },
      body: form ? new URLSearchParams(form).toString() : json ? JSON.stringify(json) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(err.name === 'TimeoutError' ? `${name} didn't respond` : `Can't reach ${name} at that address`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new AuthError(`${name} no longer accepts the saved sign-in. Sign in again in the extension options.`);
  }
  if (!res.ok) {
    const detail = await res.clone().json().then((b) => b.error_message || b.message || b.error).catch(() => '');
    throw new Error(detail ? `${name}: ${detail}` : `${name} returned HTTP ${res.status}`);
  }
  return res;
}

const wrongLogin = (name, label) => new AuthError(`Wrong username or ${label.toLowerCase()}. Check them in ${name}.`);

/** Item fields the popup shows. */
const item = (title, feed, url, published) => ({ title: title || '(untitled)', feed: feed || '', url: url || '', published: published || 0 });

// ---- Google Reader API: SpoolRSS, FreshRSS, The Old Reader, BazQux, Miniflux…

const READING_LIST = 'user/-/state/com.google/reading-list';
const READ = 'user/-/state/com.google/read';

const greader = {
  base(id, server) {
    return id === 'spoolrss' || id === 'freshrss' ? `${server}/api/greader.php` : server;
  },
  async signIn(name, base, username, password, label) {
    let res;
    try {
      res = await request(name, `${base}/accounts/ClientLogin`, { method: 'POST', form: { Email: username, Passwd: password } });
    } catch (err) {
      throw err instanceof AuthError ? wrongLogin(name, label) : err;
    }
    const token = (await res.text()).match(/^Auth=(.+)$/m)?.[1]?.trim();
    if (!token) throw new Error(`That address doesn't look like ${name}`);
    return token;
  },
  auth: (token) => ({ Authorization: `GoogleLogin auth=${token}` }),
  async summary(name, base, token, recent) {
    const headers = greader.auth(token);
    const [counts, stream] = await Promise.all([
      request(name, `${base}/reader/api/0/unread-count?output=json`, { headers }).then((r) => r.json()),
      request(name, `${base}/reader/api/0/stream/contents/${READING_LIST}?output=json&n=${recent}&xt=${encodeURIComponent(READ)}`, { headers }).then((r) => r.json()),
    ]);
    // The reading list's count; some servers only list feeds and folders, so add up the feeds.
    const list = counts.unreadcounts || [];
    const total = list.find((c) => /\/state\/com\.google\/reading-list$/.test(c.id));
    const count = total ? total.count : list.filter((c) => c.id.startsWith('feed/')).reduce((n, c) => n + c.count, 0);
    const items = (stream.items || []).map((i) => item(
      i.title, i.origin?.title, i.alternate?.[0]?.href || i.canonical?.[0]?.href, (i.published || 0) * 1000,
    ));
    return { count, items };
  },
  async subscribe(name, base, token, url) {
    const headers = greader.auth(token);
    // Most servers want an edit token with changes.
    const T = await request(name, `${base}/reader/api/0/token`, { headers }).then((r) => r.text()).then((t) => t.trim()).catch(() => '');
    const res = await request(name, `${base}/reader/api/0/subscription/quickadd`, { method: 'POST', headers, form: { quickadd: `feed/${url}`, ...(T && { T }) } });
    const body = await res.json().catch(() => ({}));
    if (body.numResults === 0 || body.error) throw new Error(body.error || `${name} couldn't subscribe to that feed`);
  },
};

// ---- Miniflux (its own API, with an API key)

const miniflux = {
  headers: (token) => ({ 'X-Auth-Token': token }),
  async signIn(name, server, _username, key) {
    try {
      await request(name, `${server}/v1/me`, { headers: miniflux.headers(key) });
    } catch (err) {
      throw err instanceof AuthError ? new AuthError(`${name} didn't accept that API key.`) : err;
    }
    return key;
  },
  async summary(name, server, token, recent) {
    const r = await request(name, `${server}/v1/entries?status=unread&limit=${recent}&order=published_at&direction=desc`, { headers: miniflux.headers(token) }).then((x) => x.json());
    return { count: r.total || 0, items: (r.entries || []).map((e) => item(e.title, e.feed?.title, e.url, Date.parse(e.published_at) || 0)) };
  },
  async subscribe(name, server, token, url) {
    const headers = miniflux.headers(token);
    const categories = await request(name, `${server}/v1/categories`, { headers }).then((r) => r.json());
    await request(name, `${server}/v1/feeds`, { method: 'POST', headers, json: { feed_url: url, category_id: categories[0]?.id } });
  },
};

// ---- Tiny Tiny RSS (its JSON API; the token is a session id)

const ttrss = {
  async call(name, server, body) {
    const r = await request(name, `${server}/api/`, { method: 'POST', json: body }).then((x) => x.json());
    if (r.status !== 0) {
      const error = r.content?.error || 'UNKNOWN_ERROR';
      if (error === 'NOT_LOGGED_IN') throw new AuthError(`${name} no longer accepts the saved sign-in. Sign in again in the extension options.`);
      if (error === 'LOGIN_ERROR') throw new AuthError(`Wrong username or password. Check them in ${name}.`);
      if (error === 'API_DISABLED') throw new Error(`${name}'s API is turned off. Turn on "Enable API" in its Preferences.`);
      throw new Error(`${name}: ${error}`);
    }
    return r.content;
  },
  async signIn(name, server, username, password) {
    const content = await ttrss.call(name, server, { op: 'login', user: username, password });
    if (!content?.session_id) throw new Error(`That address doesn't look like ${name}`);
    return content.session_id;
  },
  async summary(name, server, sid, recent) {
    const [unread, headlines] = await Promise.all([
      ttrss.call(name, server, { op: 'getUnread', sid }),
      ttrss.call(name, server, { op: 'getHeadlines', sid, feed_id: -4, view_mode: 'unread', limit: recent, show_excerpt: false, show_content: false }),
    ]);
    return { count: Number(unread?.unread) || 0, items: (headlines || []).map((h) => item(h.title, h.feed_title, h.link, (h.updated || 0) * 1000)) };
  },
  async subscribe(name, server, sid, url) {
    const content = await ttrss.call(name, server, { op: 'subscribeToFeed', sid, feed_url: url });
    const code = content?.status?.code;
    if (code !== 0 && code !== 1) throw new Error(content?.status?.message || `${name} couldn't subscribe to that feed`);
  },
};

// ---- Nextcloud News (API v1.3; the token is the username and app password, as HTTP Basic)

const base64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

const nextcloud = {
  base: (server) => `${server}/index.php/apps/news/api/v1-3`,
  headers: (token) => ({ Authorization: `Basic ${token}`, 'OCS-APIRequest': 'true' }),
  async signIn(name, server, username, password) {
    const token = base64(`${username}:${password}`);
    try {
      await request(name, `${nextcloud.base(server)}/feeds`, { headers: nextcloud.headers(token) });
    } catch (err) {
      throw err instanceof AuthError ? new AuthError(`Wrong username or app password. Check them in ${name}.`) : err;
    }
    return token;
  },
  async summary(name, server, token, recent) {
    const headers = nextcloud.headers(token);
    const [feeds, items] = await Promise.all([
      request(name, `${nextcloud.base(server)}/feeds`, { headers }).then((r) => r.json()),
      request(name, `${nextcloud.base(server)}/items?batchSize=${recent}&offset=0&type=3&id=0&getRead=false&oldestFirst=false`, { headers }).then((r) => r.json()),
    ]);
    const titles = new Map((feeds.feeds || []).map((f) => [f.id, f.title]));
    return {
      count: (feeds.feeds || []).reduce((n, f) => n + (f.unreadCount || 0), 0),
      items: (items.items || []).map((i) => item(i.title, titles.get(i.feedId), i.url, (i.pubDate || 0) * 1000)),
    };
  },
  async subscribe(name, server, token, url) {
    let res;
    try {
      res = await fetch(`${nextcloud.base(server)}/feeds`, {
        method: 'POST',
        headers: { ...nextcloud.headers(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, folderId: null }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error(`Can't reach ${name} at that address`);
    }
    if (res.status === 409) return; // already subscribed
    if (res.status === 401 || res.status === 403) throw new AuthError(`${name} no longer accepts the saved sign-in. Sign in again in the extension options.`);
    if (!res.ok) throw new Error(await res.json().then((b) => `${name}: ${b.message}`).catch(() => `${name} couldn't subscribe to that feed`));
  },
};

// ---- Fever API (the token is the api_key, an MD5 of "username:password")

const fever = {
  async call(name, server, token, query = '') {
    const r = await request(name, `${server}${server.includes('?') ? '&' : '?'}api${query ? `&${query}` : ''}`, { method: 'POST', form: { api_key: token } })
      .then((x) => x.json())
      .catch((err) => { throw err instanceof SyntaxError ? new Error(`That address doesn't look like a Fever API`) : err; });
    if (!r.auth) throw new AuthError(`${name} no longer accepts the saved sign-in. Sign in again in the extension options.`);
    return r;
  },
  async signIn(name, server, username, password) {
    const token = md5(`${username}:${password}`);
    try {
      await fever.call(name, server, token);
    } catch (err) {
      throw err instanceof AuthError ? new AuthError(`Wrong username or password. Check them in ${name}.`) : err;
    }
    return token;
  },
  async summary(name, server, token, recent) {
    const { unread_item_ids: ids = '' } = await fever.call(name, server, token, 'unread_item_ids');
    const unread = String(ids).split(',').filter(Boolean).map(Number).sort((a, b) => b - a);
    if (!unread.length) return { count: 0, items: [] };
    const [{ items = [] }, { feeds = [] }] = await Promise.all([
      fever.call(name, server, token, `items&with_ids=${unread.slice(0, recent).join(',')}`),
      fever.call(name, server, token, 'feeds'),
    ]);
    const titles = new Map(feeds.map((f) => [f.id, f.title]));
    return {
      count: unread.length,
      items: items.sort((a, b) => b.created_on_time - a.created_on_time)
        .map((i) => item(i.title, titles.get(i.feed_id), i.url, (i.created_on_time || 0) * 1000)),
    };
  },
  subscribe: null, // Fever has no way to subscribe
};

// ---- the account the extension is connected to: { platform, server, username, token }

const RECENT = 8;

function adapter(account) {
  const id = PLATFORMS[account.platform] ? account.platform : 'spoolrss';
  const { name, api, password } = PLATFORMS[id];
  const server = account.server;
  switch (api) {
    case 'greader': {
      const base = greader.base(id, server);
      return {
        signIn: (user, pass) => greader.signIn(name, base, user, pass, password),
        summary: (token) => greader.summary(name, base, token, RECENT),
        subscribe: (token, url) => greader.subscribe(name, base, token, url),
      };
    }
    case 'miniflux': return { signIn: (u, p) => miniflux.signIn(name, server, u, p), summary: (t) => miniflux.summary(name, server, t, RECENT), subscribe: (t, url) => miniflux.subscribe(name, server, t, url) };
    case 'ttrss': return { signIn: (u, p) => ttrss.signIn(name, server, u, p), summary: (t) => ttrss.summary(name, server, t, RECENT), subscribe: (t, url) => ttrss.subscribe(name, server, t, url) };
    case 'nextcloud': return { signIn: (u, p) => nextcloud.signIn(name, server, u, p), summary: (t) => nextcloud.summary(name, server, t, RECENT), subscribe: (t, url) => nextcloud.subscribe(name, server, t, url) };
    case 'fever': return { signIn: (u, p) => fever.signIn(name, server, u, p), summary: (t) => fever.summary(name, server, t, RECENT), subscribe: null };
    default: throw new Error(`Unknown platform ${id}`);
  }
}

/** Sign in and return the token to keep. Only Nextcloud and Fever need the password itself kept (encoded or hashed). */
export const signIn = (account, username, password) => adapter(account).signIn(username, password);

/** Unread count and the newest unread articles. */
export const unreadSummary = (account) => adapter(account).summary(account.token);

/** Whether feeds found on a page can be added to this platform from the extension. */
export const canSubscribe = (account) => Boolean(adapter(account).subscribe);

/** Subscribe to a feed address. */
export async function subscribe(account, url) {
  const { subscribe: add } = adapter(account);
  if (!add) throw new Error(`${platform(account.platform).name} can't subscribe from the extension`);
  await add(account.token, url);
}

export function badgeText(count) {
  if (!count) return '';
  return count > 999 ? '999+' : String(count);
}
