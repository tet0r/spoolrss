import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

// SpoolRSS as the Windows app runs it (windows/SpoolRSS.cs): listening on 127.0.0.1 only, and
// installing updates through the tray program, which watches files in the data folder.

const PORT = 19080 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let app;
let dataDir;

const post = (p) => fetch(BASE + p, { method: 'POST', headers: { 'X-SpoolRSS': '1' } });

/** A request with a Host header of our choosing (fetch doesn't allow setting it). */
function withHost(host) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/api/state', headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spoolrss-test-'));
  app = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SPOOLRSS_INSTALL: 'windows', SPOOLRSS_DATA: dataDir,
      SPOOLRSS_REFRESH_MINUTES: '0', UPDATE_CHECK: 'true', SPOOLRSS_PASSWORD: '',
    },
    stdio: 'ignore',
  });
  let up = false;
  for (let i = 0; i < 200 && !up; i++) {
    try { up = (await fetch(`${BASE}/api/state`)).ok; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  if (!up) throw new Error(`SpoolRSS did not start on port ${PORT}`);
});

after(async () => {
  if (app && app.exitCode === null) await new Promise((r) => { app.once('exit', r); app.kill(); });
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('listening on this computer only, it answers only to its own names (no DNS rebinding)', async () => {
  assert.equal(await withHost(`127.0.0.1:${PORT}`), 200);
  assert.equal(await withHost(`localhost:${PORT}`), 200);
  assert.equal(await withHost(`[::1]:${PORT}`), 200);
  assert.equal(await withHost(`attacker.example:${PORT}`), 421);
  assert.equal(await withHost(`localhost.attacker.example:${PORT}`), 421);
});

test('the Windows app offers an update only once its download is attached, and installs it on request', async () => {
  const db = new DatabaseSync(path.join(dataDir, 'spoolrss.db'));
  const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
  set.run('latest_version', '99.0.0');
  set.run('latest_url', 'https://github.com/tet0r/spoolrss/releases/tag/v99.0.0');
  set.run('latest_windows', '0');

  let state = await (await fetch(`${BASE}/api/state`)).json();
  assert.equal(state.install, 'windows');
  assert.equal(state.update, null, 'not before the Windows download is there');
  assert.equal((await post('/api/update')).status, 409);

  set.run('latest_windows', '1');
  db.close();
  state = await (await fetch(`${BASE}/api/state`)).json();
  assert.deepEqual(state.update, { version: '99.0.0', url: 'https://github.com/tet0r/spoolrss/releases/tag/v99.0.0', updating: false });

  // The page's own header is required, as for every change.
  assert.equal((await fetch(`${BASE}/api/update`, { method: 'POST' })).status, 403);
  assert.equal((await post('/api/update')).status, 200);
  assert.equal(fs.readFileSync(path.join(dataDir, 'update-request.txt'), 'utf8'), '99.0.0');
  state = await (await fetch(`${BASE}/api/state`)).json();
  assert.equal(state.update.updating, true);
});
