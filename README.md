# Feedster

A self-hosted feed reader for RSS, Atom and JSON Feed. Folders, unread counts, starring, search, full articles and keyboard shortcuts, in one small app you run yourself. Your subscriptions and reading history stay on your server.

Works in any browser, syncs with popular reader apps on Android and iPhone, and has a browser extension that shows your unread count.

![Feedster with subscriptions in the sidebar, the article list in the middle and an article open on the right](docs/screenshot.webp)

## Install

With Docker:

```yaml
services:
  feedster:
    image: ghcr.io/tet0r/feedster:latest
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      FEEDSTER_PASSWORD: change-me
    volumes:
      - feedster-data:/data

volumes:
  feedster-data:
```

Save that as `docker-compose.yml` and run `docker compose up -d`, or paste it into Portainer as a stack. Then open http://localhost:8080 and add your first subscription. The fuller [docker-compose.yml](docker-compose.yml) in this repository adds a health check and more settings.

Without Docker, you need Node.js 22.13 or later:

```bash
git clone https://github.com/tet0r/feedster.git
cd feedster
npm install
npm start
```

Coming from another reader? Export your subscriptions as OPML and import the file in Feedster's **Settings**.

## Features

- Subscribe with a feed address or just a website address. Feedster finds the feed.
- Folders, drag and drop, unread and starred views, and search across every article
- Full articles for feeds that only send a summary
- List view with a reading pane, a card view, or a classic view in the style of the old Google Reader: one line per headline, and the article opens in place under it
- Feed icons, light and dark themes, and a layout that works on phones
- Resizable panes and keyboard shortcuts
- OPML import and export
- A banner when a new version of Feedster is available

## Reader apps

Feedster speaks the same sync APIs as FreshRSS, so apps that support FreshRSS work with it.

1. In Feedster, open **Settings → Reading apps** and choose a username and app password.
2. In the app, add a **FreshRSS** account with the address `https://your-server/api/greader.php`.
3. Sign in with that username and app password.

Free apps that work this way:

| Platform | App |
| --- | --- |
| Android | [Capy Reader](https://github.com/jocmp/capyreader), [Read You](https://github.com/Ashinch/ReadYou), [FeedMe](https://github.com/seazon/FeedMe) |
| iPhone, iPad and Mac | [NetNewsWire](https://netnewswire.com/), [Fiery Feeds](https://apps.apple.com/app/id1158763303) |

Apps that only offer a **Fever** account can use `https://your-server/api/fever.php` instead. Phone apps need Feedster to be reachable over HTTPS.

## Browser extension

The Feedster extension for Chrome, Edge and Firefox shows your unread count on the toolbar. Click it to see your newest headlines or open Feedster.

<img src="docs/extension-popup.png" width="348" alt="The Feedster extension's popup in Chrome: the unread count, the newest unread headlines, and an Open Feedster button">

Install it from the [Chrome Web Store](https://chromewebstore.google.com/detail/feedster/lecfbammajmdcafoodjalelofaelbaoc) (Chrome and Edge) or [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/feedster/). After installing, sign in with your reading-app username and password.

To subscribe to the site you're on, use [RSSHub Radar](https://github.com/DIYgod/RSSHub-Radar) set to FreshRSS with your Feedster address, or drag the **+ Feedster** bookmarklet from Feedster's Settings to your bookmarks bar.

## Settings

Set these as environment variables:

| Variable | Default | What it does |
| --- | --- | --- |
| `FEEDSTER_PASSWORD` | none | Requires sign-in. Set it if Feedster can be reached from the internet. |
| `FEEDSTER_REFRESH_MINUTES` | `15` | How often feeds are checked. `0` turns it off. |
| `FEEDSTER_RETENTION_DAYS` | `90` | Read articles older than this are deleted, except starred ones. `0` keeps everything. |
| `UPDATE_CHECK` | `true` | Checks GitHub for new versions. `false` turns it off. |
| `PORT` | `8080` | The port Feedster listens on |
| `FEEDSTER_DATA` | `./data` | Where the database is stored |

Feedster serves plain HTTP. For HTTPS, put it behind a reverse proxy such as Caddy, nginx or Traefik.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `j` / `k` | Next / previous article |
| `n` / `p` | In the classic view: move to the next / previous headline without opening it |
| `o` or `Enter` | In the classic view: open or close the article |
| `s` | Star |
| `m` | Mark read or unread |
| `v` | Open the original page |
| `f` | Full article |
| `r` | Refresh |
| `Shift`+`A` | Mark all as read |
| `a` | Add a subscription |
| `/` | Search |

## Updating

Pull the latest image and restart: `docker compose pull && docker compose up -d`. To stay on one version, use a tag such as `ghcr.io/tet0r/feedster:1.4` instead of `latest`. What changed in each version is in the [changelog](CHANGELOG.md).

## Development

Run the tests with `npm test`. A new number in the `VERSION` file, pushed to `main`, publishes a release. Publishing the browser extension to the stores is described in [store/SUBMITTING.md](store/SUBMITTING.md).

## License

MIT. See [LICENSE](LICENSE). Bug reports and ideas are welcome in [issues](https://github.com/tet0r/feedster/issues).
