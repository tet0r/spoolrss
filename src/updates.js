import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir, getSetting, setSetting } from './db.js';

// The release this build is, from the VERSION file at the repo root. Bumping
// that file on main publishes a new release.
const versionFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'VERSION');
export const VERSION = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : 'dev';

const UPDATE_CHECK = ['1', 'true', 'yes'].includes((process.env.UPDATE_CHECK ?? 'true').toLowerCase());
const UPDATE_REPO = process.env.UPDATE_REPO || 'tet0r/spoolrss';
// The portable Windows app updates itself: its tray program (windows/SpoolRSS.cs) watches these
// files in the data folder, shows the first and acts on the second.
export const WINDOWS = process.env.SPOOLRSS_INSTALL === 'windows';
export const WINDOWS_ASSET = 'SpoolRSS-windows.zip';
const availableFile = path.join(dataDir, 'update-available.txt');
const requestFile = path.join(dataDir, 'update-request.txt');
// 12 requests an hour, well inside GitHub's limit of 60 for anonymous callers
const UPDATE_INTERVAL_MS = 5 * 60_000;

export function versionTuple(version) {
  return (String(version).match(/\d+/g) || []).slice(0, 3).map(Number);
}

function isNewer(a, b) {
  const x = versionTuple(a);
  const y = versionTuple(b);
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/** The newer release found by the last check, if there is one. */
export function availableUpdate() {
  const latest = getSetting('latest_version');
  if (!UPDATE_CHECK || VERSION === 'dev' || !latest || !isNewer(latest, VERSION)) return null;
  // The Windows app's download is attached a few minutes after the release itself is created.
  if (WINDOWS && getSetting('latest_windows') !== '1') return null;
  return { version: latest, url: getSetting('latest_url'), ...(WINDOWS && { updating: requestedUpdate() === latest }) };
}

/** Ask GitHub for the latest release and log once per new version. */
export async function checkForUpdate() {
  const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `SpoolRSS/${VERSION}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status !== 200) return;
  const release = await res.json();
  const latest = String(release.tag_name ?? '').replace(/^v/, '');
  const url = String(release.html_url ?? '');
  if (!versionTuple(latest).length) return;
  setSetting('latest_version', latest);
  setSetting('latest_url', url.startsWith('https://github.com/') ? url : '');
  setSetting('latest_windows', (release.assets || []).some((a) => a.name === WINDOWS_ASSET) ? '1' : '0');
  const update = availableUpdate();
  if (WINDOWS) {
    try {
      if (update) fs.writeFileSync(availableFile, update.version);
      else fs.rmSync(availableFile, { force: true });
    } catch (err) { console.error('could not note the update for the tray icon:', err.message); }
  }
  if (update && getSetting('update_notified') !== latest) {
    setSetting('update_notified', latest);
    console.log(`SpoolRSS ${latest} is available (running ${VERSION}). ${WINDOWS
      ? 'Click Update now in SpoolRSS to install it.'
      : 'Update with: docker compose pull && docker compose up -d'}`);
  }
}

/** Asks the Windows tray program to install the available update (it stops and restarts SpoolRSS). */
export function requestUpdate() {
  const update = WINDOWS ? availableUpdate() : null;
  if (!update) return false;
  fs.writeFileSync(requestFile, update.version);
  return true;
}

function requestedUpdate() {
  try { return fs.readFileSync(requestFile, 'utf8').trim(); } catch { return null; }
}

export function startUpdateChecker() {
  if (!UPDATE_CHECK || VERSION === 'dev') return;
  const run = () => checkForUpdate().catch((err) => console.error('update check failed:', err.message));
  setTimeout(() => {
    run();
    setInterval(run, UPDATE_INTERVAL_MS);
  }, 30_000);
}
