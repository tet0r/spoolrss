// Runs on the SpoolRSS pages the extension is connected to (only when it's connected to SpoolRSS).
// SpoolRSS announces each change it makes (marking read, mark all as read, starring, new
// articles) with a "spoolrss:changed" event, and this asks the extension to check the count
// straight away instead of at the next timer. Servers from before the rename send
// "feedster:changed"; newer ones send both, which the wait below merges into one check.

const SETTLE_MS = 1000;
let timer = null;

async function changed() {
  // Only the SpoolRSS the extension is signed in to (the address may include a sub-path).
  const { server } = await chrome.storage.local.get('server');
  if (!server || !location.href.startsWith(server)) return;
  // Marking articles read while scrolling sends many changes; check once they settle.
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      chrome.runtime.sendMessage({ type: 'refresh' }).catch(() => {});
    } catch { /* the extension was updated or removed; this page has a stale copy */ }
  }, SETTLE_MS);
}

window.addEventListener('spoolrss:changed', changed);
window.addEventListener('feedster:changed', changed);
