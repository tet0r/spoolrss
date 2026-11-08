import { PLATFORMS, platform, normalizeServer, originPattern, signIn } from './api.js';

const $ = (sel) => document.querySelector(sel);

function status(text, kind = '') {
  $('#status').textContent = text;
  $('#status').className = kind;
}

$('#platform').append(...Object.entries(PLATFORMS).map(([id, p]) => new Option(p.name, id)));

/** Labels and help for the chosen platform. */
function showPlatform(connected) {
  const p = platform($('#platform').value);
  $('#help').textContent = p.help;
  $('#serverLabel').textContent = p.address;
  $('#server').placeholder = p.placeholder;
  $('#usernameRow').hidden = p.login === 'key';
  $('#username').required = p.login !== 'key';
  $('#passwordLabel').textContent = p.password;
  $('#password').placeholder = connected ? 'Leave empty to keep the current sign-in' : '';
  $('#password').required = !connected;
  $('#passwordNote').textContent = p.api === 'nextcloud' || p.api === 'fever' || p.login === 'key'
    ? `Kept on this device, ${p.api === 'fever' ? 'scrambled as the Fever API requires' : p.login === 'key' ? 'as Miniflux has no sign-in token' : 'as Nextcloud has no sign-in token'}. Use one you can revoke.`
    : 'Used once to sign in and not stored. Only the sign-in token is kept.';
}

let saved = {};

async function load() {
  saved = await chrome.storage.local.get(['platform', 'server', 'username', 'token', 'interval', 'state']);
  const { platform: id = 'spoolrss', server = '', username = '', token, interval = 5, state } = saved;
  $('#platform').value = PLATFORMS[id] ? id : 'spoolrss';
  $('#server').value = server;
  $('#username').value = username;
  $('#interval').value = String(interval);
  $('#disconnect').hidden = !token;
  showPlatform(Boolean(token));
  const name = platform(id).name;
  if (token && state?.error) status(state.error, 'error');
  else if (token) status(`Connected to ${name}${username ? ` as ${username}` : ''}.${state && !state.error ? ` ${state.count ? `${state.count} unread.` : 'All caught up.'}` : ''}`, 'ok');
}

$('#platform').addEventListener('change', () => {
  // Another platform needs a new sign-in.
  showPlatform(Boolean(saved.token) && $('#platform').value === (saved.platform || 'spoolrss'));
  status('');
});

$('#form').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = $('#platform').value;
  const p = platform(id);
  let server;
  try {
    server = normalizeServer($('#server').value, id);
  } catch (err) {
    status(err.message, 'error');
    return;
  }
  const username = p.login === 'key' ? '' : $('#username').value.trim();
  const password = $('#password').value;
  const interval = Number($('#interval').value);
  // Browsers only allow asking for access straight from the click, before any other await.
  chrome.permissions.request({ origins: [originPattern(server)] }).then(async (granted) => {
    if (!granted) {
      status(`The extension needs access to your ${p.name} address to check it.`, 'error');
      return;
    }
    $('#connect').disabled = true;
    try {
      const stored = await chrome.storage.local.get(['platform', 'server', 'username', 'token']);
      let token = stored.token;
      const same = (stored.platform || 'spoolrss') === id && stored.server === server && (stored.username || '') === username;
      if (password || !token || !same) {
        if (!password) throw new Error(`Enter the ${p.password.toLowerCase()} to sign in.`);
        status('Signing in…');
        token = await signIn({ platform: id, server }, username, password);
      }
      await chrome.storage.local.set({ platform: id, server, username, token, interval, state: null });
      $('#password').value = '';
      status('Connected. Checking…', 'ok');
      await chrome.runtime.sendMessage({ type: 'reschedule' });
      await load();
    } catch (err) {
      status(err.message, 'error');
    } finally {
      $('#connect').disabled = false;
    }
  });
});

$('#disconnect').addEventListener('click', async () => {
  const { server } = await chrome.storage.local.get('server');
  await chrome.storage.local.remove(['token', 'state']);
  if (server) await chrome.permissions.remove({ origins: [originPattern(server)] }).catch(() => {});
  await chrome.runtime.sendMessage({ type: 'refresh' }).catch(() => {});
  $('#password').value = '';
  await load();
  status('Disconnected.');
});

load();
