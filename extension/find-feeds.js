// Finds the feeds a web page offers. The popup runs findFeeds in the current tab (with the
// activeTab permission, only when the person clicks the toolbar button), so it must not use
// anything from outside the function.

export function findFeeds() {
  const FEED_TYPE = /^application\/(rss|atom|rdf|feed)\+(xml|json)$/i;
  const MAYBE_FEED_TYPE = /^(application|text)\/(xml|json)$/i;
  const found = [];
  const seen = new Set();
  const add = (href, title, type) => {
    let url;
    try { url = new URL(href, document.baseURI); } catch { return; }
    if (!/^https?:$/.test(url.protocol) || seen.has(url.href)) return;
    seen.add(url.href);
    found.push({ url: url.href, title: (title || '').trim(), type: (type || '').toLowerCase() });
  };

  // The page is itself a feed (shown as XML).
  const root = document.documentElement?.nodeName.toLowerCase();
  if (root === 'rss' || root === 'feed' || root === 'rdf:rdf') {
    add(location.href, document.querySelector('channel > title, feed > title')?.textContent || document.title, 'feed');
  }

  // <link rel="alternate" type="application/rss+xml" href="…">, which browsers used to show as the feed icon.
  for (const link of document.querySelectorAll('link[rel][href]')) {
    const rel = link.getAttribute('rel').toLowerCase().split(/\s+/);
    if (!rel.includes('alternate') && !rel.includes('feed')) continue;
    const type = (link.getAttribute('type') || '').split(';')[0].trim();
    const href = link.getAttribute('href');
    if (FEED_TYPE.test(type) || (MAYBE_FEED_TYPE.test(type) && /rss|atom|feed/i.test(href)) || (rel.includes('feed') && !type)) {
      add(href, link.getAttribute('title') || document.title, type);
    }
  }
  return found;
}
