# Publishing the browser extension

The release workflow publishes every new version of the extension to **Firefox Add-ons (AMO)** and the **Chrome Web Store** by itself. Each store needs two things from you, once:

1. **The first version, submitted by hand.** Neither store's API can create a new listing, and this is where the listing text, images and privacy answers go in. Everything to paste is below.
2. **API keys, saved as GitHub secrets**, so later releases can publish. Until they exist, the workflow skips publishing with a notice, and nothing fails.

For the first submission, use **`spoolrss-firefox.zip`** for Firefox and **`spoolrss-chrome.zip`** for Chrome. Releases from v1.4.1 attach both; `node scripts/package-extension.mjs` builds them into `dist/` from any checkout. (`spoolrss-extension.zip` loads in both browsers for developer-mode installs; give each store its own zip instead.) The images are in [`store/images`](images); `node store/render/render.mjs` regenerates them (and the extension image in the README), and `node store/render/render-app.mjs` the app screenshot in the README.

---

## Firefox Add-ons

### First submission

1. Go to <https://addons.mozilla.org/developers/addon/submit/distribution>, choose **On this site**, and continue.
2. Upload `spoolrss-firefox.zip`. Under compatibility, keep **Firefox** and untick **Firefox for Android** (toolbar extensions are a desktop feature).
3. **Source code:** answer **No**. The extension isn't minified or bundled, so the uploaded files are the source.
4. Fill in the listing:

| Field | Value |
| --- | --- |
| Name | `SpoolRSS` |
| Add-on URL | `spoolrss` (if it's taken, `spoolrss-reader`) |
| Summary | Your feed reader's unread count in the toolbar, and one-click subscribe to the feeds on any page. Works with SpoolRSS and other self-hosted readers. |
| Description | The [description](#description) below |
| Categories | **Feeds, News & Blogging** |
| Support email / website | `https://github.com/tet0r/spoolrss/issues` |
| License | **MIT License** |
| Privacy policy | Tick "This add-on has a privacy policy" and paste the contents of [`PRIVACY.md`](../PRIVACY.md) |
| Notes to reviewer | The [notes for reviewers](#notes-for-reviewers) below |

5. Optional but recommended: on the add-on's edit page, add `store/images/screenshot-popup.png` and `store/images/screenshot-setup.png` as screenshots.
6. Submit. Mozilla reviews it, usually within a day or two for a small add-on.

### API keys for automatic releases

1. Open <https://addons.mozilla.org/developers/addon/api/key/> and click **Generate new credentials**.
2. Save them as GitHub secrets (see [Adding the secrets](#adding-the-secrets)):
   - **JWT issuer** → `AMO_JWT_ISSUER`
   - **JWT secret** → `AMO_JWT_SECRET`

---

## Chrome Web Store

Publishing needs 2-Step Verification on the Google account that owns the developer account.

### First submission

1. Open the [Developer Dashboard](https://chrome.google.com/webstore/devconsole), click **New item** and upload `spoolrss-chrome.zip`.
2. **Store listing** tab:

| Field | Value |
| --- | --- |
| Description | The [description](#description) below (the short description comes from the extension itself) |
| Category | **News & Weather** (or **Productivity** if you prefer) |
| Language | English |
| Store icon | `extension/icons/icon-128.png` |
| Screenshots | `store/images/screenshot-popup.png`, `store/images/screenshot-setup.png` |
| Small promo tile | `store/images/promo-small.png` |
| Homepage URL | `https://github.com/tet0r/spoolrss` |
| Support URL | `https://github.com/tet0r/spoolrss/issues` |

3. **Privacy** tab:

| Field | Value |
| --- | --- |
| Single purpose | Connects the browser to the user's own feed reader (SpoolRSS or another self-hosted reader): shows its unread count and newest headlines on the toolbar, and subscribes it to the feeds offered by the page the user is viewing. |
| `activeTab` justification | When the user clicks the toolbar button, the extension looks in the current page for the feed links it publishes (<link rel="alternate"> tags) and lists them in the popup, so the user can subscribe in one click. It reads nothing else and runs only on that tab, at that moment. |
| `alarms` justification | Checks the user's feed reader for new unread articles on the interval they choose (every 1 to 60 minutes). |
| `storage` justification | Keeps which feed reader the user connected, its address, their username, sign-in token and check interval, and the last unread count and headlines, on their device. |
| `scripting` justification | Runs the feed finder in the current tab when the user clicks the toolbar button (with activeTab). And, for SpoolRSS users, adds a small script to the user's own SpoolRSS pages (only the address they connected, which they granted access to). It listens for SpoolRSS's "something changed" event, for example when articles are marked as read, and asks the extension to update the unread count. It reads nothing from the page. |
| Host permission justification | The user's feed reader is self-hosted, so its address is different for every user. The extension asks for access to the single address the user enters, at the moment they connect, and uses it only to read their unread count and headlines and to add feeds they choose. It never accesses any other site in the background. |
| Remote code | **No, I am not using remote code** |
| Data usage | Tick **Authentication information** (the sign-in token or API key for the user's own reader) and **Website content** (the address of a feed on the current page, sent to the user's own reader when they click Subscribe). Tick all three certifications: not sold to third parties, not used for unrelated purposes, not used for creditworthiness or lending. |
| Privacy policy URL | `https://github.com/tet0r/spoolrss/blob/main/PRIVACY.md` |

4. **Distribution** tab: **Public**, all regions, free.
5. If any form asks for test instructions or a test account, use the [notes for reviewers](#notes-for-reviewers).
6. Click **Submit for review**. Chrome reviews usually take a few days.

### Keys for automatic releases

Google's recommended way to publish from CI is a service account:

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project (for example `spoolrss-publishing`).
2. **APIs & Services → Library**: search for **Chrome Web Store API** and click **Enable**.
3. **IAM & Admin → Service accounts → Create service account**: name it `spoolrss-ci`. It needs no roles; click **Done**.
4. Open the new service account → **Keys → Add key → Create new key → JSON**. A `.json` file downloads.
5. Back in the Chrome [Developer Dashboard](https://chrome.google.com/webstore/devconsole) → **Account**: add the service account's email (it ends in `.iam.gserviceaccount.com`).
6. Save these as GitHub secrets:
   - the whole contents of the downloaded `.json` file → `CWS_SERVICE_ACCOUNT`
   - **Publisher ID** (Dashboard → Publisher → Settings) → `CWS_PUBLISHER_ID`
   - the extension's **Item ID** (shown on the item in the dashboard; 32 letters) → `CWS_EXTENSION_ID`
7. Delete the downloaded `.json` file. GitHub keeps the only copy needed, and you can make a new key at any time.

---

## Adding the secrets

In GitHub: **tet0r/spoolrss → Settings → Secrets and variables → Actions → New repository secret**, once for each:

| Secret | From |
| --- | --- |
| `AMO_JWT_ISSUER` | Firefox Add-ons API key: JWT issuer |
| `AMO_JWT_SECRET` | Firefox Add-ons API key: JWT secret |
| `CWS_SERVICE_ACCOUNT` | Google service account JSON key (whole file) |
| `CWS_PUBLISHER_ID` | Chrome Developer Dashboard → Publisher → Settings |
| `CWS_EXTENSION_ID` | Chrome Developer Dashboard → the item's ID |

From then on, each new `VERSION` on `main` submits the extension to both stores for review, if anything in `extension/` changed since the previous release. The version number is stamped from `VERSION`, so it always goes up.

The two stores are published separately, so a problem with one doesn't hold up the other, and the reason for a failure appears on the run's summary page. To send the current version to a store again, open **Actions → Docker image → Run workflow** on `main` and choose a store under **Publish the browser extension**.

Two cases need the store's dashboard instead:

- **A release adds a permission.** Chrome asks for a justification for each permission, and its Privacy tab only shows the box once a package with that permission is uploaded. Upload that version's `spoolrss-chrome.zip` under **Package**, fill in the justification, and submit.
- **Mozilla is still reviewing an earlier version.** Wait for that review, then run the workflow with **firefox**, or upload `spoolrss-firefox.zip` on the add-on's page.

---

## Text to paste

The Chrome Web Store treats a list of other products' names in the listing (description, screenshots or the extension's own description) as keyword spam and rejects it. Keep those generic, as below; naming the supported readers is fine in the notes for reviewers.

### Description

```
Connect your browser to your own feed reader: SpoolRSS or another self-hosted reader. Choose yours in the extension's settings.

• Your unread count on the toolbar icon, checked every 1 to 60 minutes
• Click the icon to see your newest unread headlines
• Feeds on this page: the popup lists the RSS, Atom and JSON feeds the site you're on offers, and subscribes your reader to one in a click
• "Open" switches to your reader's tab, or opens one
• A grey "!" tells you when your reader can't be reached or wants you to sign in again

Private by design: the extension talks only to the reader address you enter, and asks for access to that one address. It looks at the page you're on only when you click its button, and only for feed links. No analytics, no tracking, no ads.

SpoolRSS is a free, open-source feed reader you run on your own server: https://github.com/tet0r/spoolrss
```

### Notes for reviewers

```
This extension connects to SpoolRSS, a self-hosted feed reader (https://github.com/tet0r/spoolrss). To test it you need a SpoolRSS server; one runs locally with Docker:

1. docker run -p 8080:8080 ghcr.io/tet0r/spoolrss:latest
2. Open http://localhost:8080, click "+ Add subscription" and add https://xkcd.com/atom.xml
3. In SpoolRSS's Settings → Reading apps, set username "reviewer" and an app password of at least 8 characters, then Save.
4. In the extension's settings, enter http://localhost:8080, that username and password, and click Connect. Allow access when asked.

The toolbar badge then shows the unread count; the popup lists the newest unread articles and opens SpoolRSS.

To try finding feeds: open https://www.theverge.com/ (or any blog), click the extension's button, and click Subscribe next to a feed under "Feeds on this page". It appears in SpoolRSS.

The extension also connects to other self-hosted readers (FreshRSS, Miniflux, Tiny Tiny RSS, Nextcloud News, and Google Reader or Fever APIs), chosen in its settings; each works the same way.

The extension is not minified or bundled: the files in the package are the source.
```

If you run a SpoolRSS that reviewers can reach over the internet, you can instead give them its address and a reviewer app password. Change the app password after the review.
