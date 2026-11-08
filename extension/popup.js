import { platform, webAddress, canSubscribe, subscribe } from './api.js';
import { findFeeds } from './find-feeds.js';

const $ = (sel) => document.querySelector(sel);

function timeAgo(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Build an element; props may include className, textContent and data-* keys. */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('data-')) node.setAttribute(key, value);
    else node[key] = value;
  }
  node.append(...children);
  return node;
}

/** A message with one action button, shown instead of the article list. */
function message(text, { kind = '', button, act }) {
  $('#message').replaceChildren(
    el('p', { className: kind, textContent: text }),
    el('button', { className: `btn${act === 'settings' && !kind ? ' primary' : ''}`, textContent: button, 'data-act': act }),
  );
  $('#message').hidden = false;
  $('#list').replaceChildren();
}

let account = {};

function render(state) {
  const { server, platform: id } = account;
  const name = platform(id).name;
  $('#message').hidden = true;
  $('#open').hidden = !server;
  $('#open').textContent = `Open ${name.startsWith('Other') ? 'your reader' : name}`;
  if (!server || state?.notConnected) {
    $('#count').textContent = '';
    message('Connect the extension to SpoolRSS or another feed reader to see your unread count here.', { button: 'Connect', act: 'settings' });
    return;
  }
  if (!state) {
    $('#count').textContent = 'Checking…';
    return;
  }
  if (state.error) {
    $('#count').textContent = '';
    message(state.error, state.authFailed
      ? { kind: 'error', button: 'Sign in again', act: 'settings' }
      : { kind: 'error', button: 'Try again', act: 'refresh' });
    return;
  }
  $('#count').replaceChildren(...(state.count
    ? [el('b', { textContent: state.count.toLocaleString() }), ' unread']
    : ['All caught up']));
  const list = $('#list');
  list.replaceChildren(...(state.items || []).map((item) => el('button', {
    className: 'item',
    title: item.url ? `Open “${item.title}”` : item.title,
    'data-url': item.url,
  }, [
    el('div', { className: 't', textContent: item.title }),
    el('div', { className: 'm', textContent: [item.feed, item.published ? timeAgo(item.published) : ''].filter(Boolean).join(' · ') }),
  ])));
}

async function load() {
  const stored = await chrome.storage.local.get(['platform', 'server', 'username', 'token', 'state']);
  account = { platform: stored.platform || 'spoolrss', server: stored.server, username: stored.username, token: stored.token };
  render(stored.state);
  return stored.server;
}

// ---- feeds on the current page

const shortUrl = (url) => { const u = new URL(url); return `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}`; };

async function showPageFeeds() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (!tab?.id || !/^https?:/.test(tab.url || 'https:')) return;
  let feeds = [];
  try {
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: findFeeds });
    feeds = result?.result || [];
  } catch { return; /* a page the extension may not read, such as the browser's own pages or a store */ }
  if (!feeds.length) return;
  const connected = Boolean(account.server && account.token);
  const add = connected && canSubscribe(account);
  $('#feeds').replaceChildren(...feeds.slice(0, 6).map((feed) => el('div', { className: 'feed' }, [
    el('div', { className: 'info', title: feed.url }, [
      el('div', { className: 't', textContent: feed.title || shortUrl(feed.url) }),
      el('div', { className: 'u', textContent: shortUrl(feed.url) }),
    ]),
    el('button', { className: `btn${add ? ' primary' : ''}`, textContent: add ? 'Subscribe' : 'Copy', 'data-feed': feed.url, 'data-act': add ? 'subscribe' : 'copy' }),
  ])));
  const note = $('#foundNote');
  note.hidden = add;
  note.className = 'note muted';
  note.textContent = connected
    ? `${platform(account.platform).name} can't subscribe from here. Copy the address and add it in your reader.`
    : 'Connect the extension to subscribe in one click, or copy the address.';
  $('#found').hidden = false;
}

async function subscribeTo(button) {
  button.disabled = true;
  button.textContent = 'Adding…';
  try {
    await subscribe(account, button.dataset.feed);
    button.replaceWith(el('span', { className: 'done', textContent: 'Subscribed ✓' }));
    chrome.runtime.sendMessage({ type: 'refresh' }).then(load).catch(() => {});
  } catch (err) {
    button.disabled = false;
    button.textContent = 'Subscribe';
    const note = $('#foundNote');
    note.hidden = false;
    note.className = 'note error';
    note.textContent = err.message;
  }
}

async function copy(button) {
  await navigator.clipboard.writeText(button.dataset.feed);
  button.textContent = 'Copied';
  setTimeout(() => { button.textContent = 'Copy'; }, 1500);
}

// ---- actions

/** Switch to the reader's tab if one is open, or open one. */
async function openReader() {
  if (!account.server) return;
  const home = webAddress(account.platform, account.server);
  const tabs = await chrome.tabs.query({ url: `${new URL(home).origin}/*` }).catch(() => []);
  const tab = tabs.find((t) => t.url?.startsWith(home));
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: home });
  }
  window.close();
}

async function refresh() {
  $('#refresh').disabled = true;
  await chrome.runtime.sendMessage({ type: 'refresh' }).catch(() => {});
  await load();
  $('#refresh').disabled = false;
}

document.addEventListener('click', (e) => {
  const actEl = e.target.closest('[data-act]');
  const act = actEl?.dataset.act;
  if (act === 'settings') { chrome.runtime.openOptionsPage(); window.close(); }
  if (act === 'refresh') refresh();
  if (act === 'subscribe') subscribeTo(actEl);
  if (act === 'copy') copy(actEl);
  const item = e.target.closest('.item');
  if (/^https?:\/\//i.test(item?.dataset.url || '')) { chrome.tabs.create({ url: item.dataset.url }); window.close(); }
});
$('#open').addEventListener('click', openReader);
$('#refresh').addEventListener('click', refresh);
$('#settings').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });

// Show the last known count at once, then check for a fresh one and look for feeds on the page.
load().then((server) => {
  if (server) refresh();
  showPageFeeds();
});
