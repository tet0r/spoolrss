import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

// SpoolRSS was called Feedster. An install set up under that name, with FEEDSTER_* settings and a
// feedster.db, keeps its data and settings after updating.

test('takes over feedster.db and the FEEDSTER_* settings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spoolrss-rename-'));
  const old = new DatabaseSync(path.join(dir, 'feedster.db'));
  old.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); INSERT INTO settings VALUES ('marker', 'kept');");
  old.close();

  const port = 19900 + Math.floor(Math.random() * 90);
  const env = { ...process.env, PORT: String(port), FEEDSTER_DATA: dir, FEEDSTER_PASSWORD: 'old-name-password', FEEDSTER_REFRESH_MINUTES: '0', UPDATE_CHECK: 'false' };
  for (const key of Object.keys(env)) if (key.startsWith('SPOOLRSS_')) delete env[key];
  const app = spawn(process.execPath, ['src/server.js'], { env, stdio: 'ignore' });
  try {
    let res;
    for (let i = 0; i < 200 && !res; i++) {
      try { res = await fetch(`http://127.0.0.1:${port}/api/state`); } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    assert.ok(res, 'SpoolRSS started');
    assert.equal(res.status, 401, 'FEEDSTER_PASSWORD still requires signing in');
  } finally {
    if (app.exitCode === null) await new Promise((r) => { app.once('exit', r); app.kill(); });
  }
  assert.ok(fs.existsSync(path.join(dir, 'spoolrss.db')), 'stored under the new name, in FEEDSTER_DATA');
  assert.ok(!fs.existsSync(path.join(dir, 'feedster.db')));
  const db = new DatabaseSync(path.join(dir, 'spoolrss.db'));
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'marker'").get().value, 'kept');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
