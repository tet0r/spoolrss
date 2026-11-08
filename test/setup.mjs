// Loaded before every test file (--import): tests that use the database in-process get a fresh
// one of their own, never ./data, which holds the database of a local SpoolRSS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spoolrss-test-'));
process.env.SPOOLRSS_DATA = dir;
process.on('exit', () => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* still open on Windows */ }
});
