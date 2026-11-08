import { unreadSummary, badgeText, AuthError, originPattern, platform } from './api.js';

// Checks the connected reader on a timer, keeps the toolbar badge current, and saves the latest
// result so the popup can show it instantly.

const BLUE = '#1f6feb';
const GREY = '#868d96';

async function settings() {
  // Versions before other platforms were supported only connected to SpoolRSS (then Feedster).
  const { platform: id = 'spoolrss', server, username, token, interval = 5 } = await chrome.storage.local.get(['platform', 'server', 'username', 'token', 'interval']);
  return { platform: id, server, username, token, interval };
}

async function show(state, name) {
  await chrome.storage.local.set({ state });
  if (state.error) {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: GREY });
    await chrome.action.setTitle({ title: `SpoolRSS: ${state.error}` });
    return;
  }
  await chrome.action.setBadgeText({ text: badgeText(state.count) });
  await chrome.action.setBadgeBackgroundColor({ color: BLUE });
  const where = name === 'SpoolRSS' ? '' : ` in ${name}`;
  await chrome.action.setTitle({ title: state.count ? `SpoolRSS: ${state.count} unread${where}` : `SpoolRSS: all caught up${where}` });
}

let running = null;

/** Fetch the unread count now. Overlapping calls share one request. */
async function refresh() {
  if (running) return running;
  running = (async () => {
    const account = await settings();
    if (!account.server || !account.token) {
      await chrome.storage.local.set({ state: { notConnected: true } });
      await chrome.action.setBadgeText({ text: '' });
      await chrome.action.setTitle({ title: 'SpoolRSS: click to connect' });
      return;
    }
    const { name } = platform(account.platform);
    try {
      const { count, items } = await unreadSummary(account);
      await show({ count, items, checkedAt: Date.now() }, name);
    } catch (err) {
      await show({ error: err.message, authFailed: err instanceof AuthError, checkedAt: Date.now() }, name);
    }
  })().finally(() => { running = null; });
  return running;
}

async function schedule() {
  const { interval } = await settings();
  await chrome.alarms.clear('refresh');
  await chrome.alarms.create('refresh', { periodInMinutes: Math.max(1, Number(interval) || 5) });
}

const PAGE_SCRIPT = 'spoolrss-page';
// Registered scripts outlive updates; this one is from before the rename.
const OLD_PAGE_SCRIPTS = ['feedster-page'];

/**
 * Put spoolrss-page.js on the connected SpoolRSS's pages, so changes made there update the badge
 * at once. It uses the same address pattern the person allowed when connecting. Other platforms
 * don't announce changes, so they get no script.
 */
async function watchPages() {
  const { platform: id, server, token } = await settings();
  for (const old of [PAGE_SCRIPT, ...OLD_PAGE_SCRIPTS]) {
    await chrome.scripting.unregisterContentScripts({ ids: [old] }).catch(() => {});
  }
  if (id !== 'spoolrss' || !server || !token) return;
  const origins = [originPattern(server)];
  if (!await chrome.permissions.contains({ origins })) return;
  await chrome.scripting.registerContentScripts([{ id: PAGE_SCRIPT, matches: origins, js: ['spoolrss-page.js'], runAt: 'document_idle' }]);
}

// Connecting, switching servers or platforms, or disconnecting.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.server || changes.token || changes.platform)) watchPages().catch(console.error);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'refresh') refresh();
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await schedule();
  await watchPages().catch(console.error);
  await refresh();
  // First install: go straight to the setup page.
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(async () => {
  await schedule();
  await watchPages().catch(console.error);
  await refresh();
});

// The popup asks for a fresh count when opened or after subscribing, the options page after
// connecting, and SpoolRSS's own page (through spoolrss-page.js) after a change.
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type === 'refresh') {
    refresh().then(() => reply({ ok: true }));
    return true; // reply asynchronously
  }
  if (message?.type === 'reschedule') {
    schedule().then(refresh).then(() => reply({ ok: true }));
    return true;
  }
  return false;
});
