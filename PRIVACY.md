# Privacy policy

_Last updated: 8 November 2026_

This policy covers the **SpoolRSS browser extension** (for Chrome, Edge and Firefox) and the **SpoolRSS** self-hosted feed reader. SpoolRSS was previously called Feedster.

## The short version

The extension talks only to the feed reader whose address you enter: your own SpoolRSS, or another reader such as FreshRSS, Miniflux, Tiny Tiny RSS or Nextcloud News. It does not send anything to the developer or to anyone else, has no analytics or tracking, and shows no ads.

## What the extension stores

On your own device, in the browser's extension storage:

- which feed reader you use and its address,
- your username on it (not used for Miniflux),
- what it needs to stay signed in:
  - for SpoolRSS, FreshRSS and other Google Reader–compatible readers: the sign-in token the reader returns (your password is used once to sign in and is **not** stored),
  - for Tiny Tiny RSS: the session ID it returns (your password is not stored),
  - for Miniflux: the API key you enter,
  - for Nextcloud News: your username and app password, encoded as that API requires,
  - for Fever-compatible readers: the API key, an MD5 hash of your username and password, as the Fever API requires,
- how often to check for new articles,
- the latest unread count and the titles, feed names, links and times of your newest unread articles, so the toolbar popup can show them instantly.

Disconnecting in the extension's settings deletes the sign-in details and the saved articles. Removing the extension deletes all of it.

## What the extension sends, and where

Every few minutes (you choose how often), the extension asks your feed reader for your unread count and newest unread articles. When you connect, it sends your username and password (or API key) to that reader to sign in. When you click **Subscribe** in the popup, it sends that feed's address to your reader. Nothing is sent anywhere else.

## What the extension reads

- **The page you're viewing, when you click the toolbar button.** The extension looks in that page for links to its feeds (the `<link rel="alternate">` tags that sites publish for feed readers) and shows them in the popup. It reads nothing else from the page, keeps nothing from it, and sends nothing from it anywhere unless you click **Subscribe**. This uses the browser's `activeTab` permission: it applies only to the tab you clicked the button in, only at that moment.
- **Your SpoolRSS's own pages**, when you use SpoolRSS. The extension adds a small script there that listens for SpoolRSS's signal that something changed (for example, articles marked as read) and then asks the extension to check the count again. The script reads nothing from the page and sends nothing anywhere.

The browser asks for your permission to access your feed reader's address when you connect. Apart from that address and the tab you click the button in, the extension can't read or change any website.

## SpoolRSS itself

SpoolRSS is software you run on your own server. Your subscriptions, articles, read and starred state, and passwords stay on that server, under your control. To do its job it downloads the feeds you subscribe to, their icons, and (when you open an article from a summary-only feed) the article's web page, from the sites that publish them. It checks GitHub every few minutes for a newer SpoolRSS release unless you turn that off with `UPDATE_CHECK=false`. The developer receives no data from your SpoolRSS.

## Contact

Questions about this policy: open an issue at <https://github.com/tet0r/spoolrss/issues>.
