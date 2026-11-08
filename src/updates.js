import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSetting, setSetting } from './db.js';

// The release this build is, from the VERSION file at the repo root. Bumping
// that file on main publishes a new release.
const versionFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'VERSION');
export const VERSION = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : 'dev';

const UPDATE_CHECK = ['1', 'true', 'yes'].includes((process.env.UPDATE_CHECK ?? 'true').toLowerCase());
const UPDATE_REPO = process.env.UPDATE_REPO || 'tet0r/spoolrss';
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
  return { version: latest, url: getSetting('latest_url') };
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
  const update = availableUpdate();
  if (update && getSetting('update_notified') !== latest) {
    setSetting('update_notified', latest);
    console.log(`SpoolRSS ${latest} is available (running ${VERSION}). Update with: docker compose pull && docker compose up -d`);
  }
}

export function startUpdateChecker() {
  if (!UPDATE_CHECK || VERSION === 'dev') return;
  const run = () => checkForUpdate().catch((err) => console.error('update check failed:', err.message));
  setTimeout(() => {
    run();
    setInterval(run, UPDATE_INTERVAL_MS);
  }, 30_000);
}
