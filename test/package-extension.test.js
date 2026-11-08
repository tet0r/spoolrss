import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { buildPackages } from '../scripts/package-extension.mjs';

/** Read a zip's entries back through its central directory, checking each CRC. */
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString();
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = zlib.inflateRawSync(buf.subarray(dataStart, dataStart + size));
    assert.equal(zlib.crc32(data), buf.readUInt32LE(p + 16), `${name} CRC`);
    files[name] = data;
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return files;
}

test('builds a Chrome zip, a Firefox zip and a combined one, each with the right manifest', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spoolrss-pkg-'));
  try {
    const { version, written } = buildPackages({ outDir });
    assert.equal(version, fs.readFileSync('VERSION', 'utf8').trim());
    const source = fs.readdirSync('extension', { recursive: true })
      .filter((f) => fs.statSync(path.join('extension', f)).isFile())
      .map((f) => f.replace(/\\/g, '/')).sort();

    const chrome = unzip(fs.readFileSync(written.chrome));
    const firefox = unzip(fs.readFileSync(written.firefox));
    const both = unzip(fs.readFileSync(written.both));
    for (const files of [chrome, firefox, both]) {
      assert.deepEqual(Object.keys(files).sort(), source, 'every extension file, nothing else');
      assert.deepEqual(files['popup.js'], fs.readFileSync('extension/popup.js'));
    }

    const cm = JSON.parse(chrome['manifest.json']);
    assert.equal(cm.version, version);
    assert.deepEqual(cm.background, { service_worker: 'background.js', type: 'module' });
    assert.equal(cm.browser_specific_settings, undefined);

    const fm = JSON.parse(firefox['manifest.json']);
    assert.deepEqual(fm.background, { scripts: ['background.js'], type: 'module' });
    assert.equal(fm.browser_specific_settings.gecko.id, 'feedster-extension@tet0r.github.io');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outDir, 'firefox', 'manifest.json'))), fm, 'folder for web-ext matches the zip');

    const bm = JSON.parse(both['manifest.json']);
    assert.ok(bm.background.service_worker && bm.background.scripts, 'combined zip loads in both browsers');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
