// Builds the browser extension packages in dist/:
//   spoolrss-chrome.zip      for the Chrome Web Store (also Edge Add-ons and other Chromium browsers)
//   spoolrss-firefox.zip     for Firefox Add-ons; dist/firefox/ is the same files, for web-ext
//   spoolrss-extension.zip   one package that loads in both browsers, for developer-mode installs
// The version comes from the VERSION file.
//   node scripts/package-extension.mjs

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every file under a folder, as [relative path with forward slashes, contents]. */
function readTree(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? readTree(full, rel) : [[rel, fs.readFileSync(full)]];
    });
}

/**
 * Each browser gets only its own background entry: Chrome warns about "scripts" and Firefox
 * ignores "service_worker", and the stores' reviewers see those warnings too.
 */
export function manifestFor(target, manifest, version) {
  const m = structuredClone(manifest);
  m.version = version;
  if (target === 'chrome') {
    delete m.background.scripts;
    delete m.browser_specific_settings;
  } else if (target === 'firefox') {
    delete m.background.service_worker;
  }
  return m;
}

// A fixed timestamp, so the same source always makes the same zip.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

/** A standard zip archive (deflate) from [name, Buffer] entries. */
export function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);           // version needed
    header.writeUInt16LE(0x0800, 6);       // UTF-8 names
    header.writeUInt16LE(8, 8);            // deflate
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(deflated.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    parts.push(header, nameBuf, deflated);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);            // made by
    entry.writeUInt16LE(20, 6);            // version needed
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(deflated.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += header.length + nameBuf.length + deflated.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, end]);
}

export function buildPackages({ outDir = path.join(root, 'dist') } = {}) {
  const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
  const files = readTree(path.join(root, 'extension'));
  const manifest = JSON.parse(files.find(([name]) => name === 'manifest.json')[1].toString());
  const withManifest = (target) => files.map(([name, data]) => (name === 'manifest.json'
    ? [name, Buffer.from(`${JSON.stringify(manifestFor(target, manifest, version), null, 2)}\n`)]
    : [name, data]));

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const written = {};
  for (const [target, file] of [['chrome', 'spoolrss-chrome.zip'], ['firefox', 'spoolrss-firefox.zip'], ['both', 'spoolrss-extension.zip']]) {
    const entries = withManifest(target);
    fs.writeFileSync(path.join(outDir, file), zip(entries));
    written[target] = path.join(outDir, file);
    if (target === 'firefox') {
      // web-ext signs from a folder.
      for (const [name, data] of entries) {
        const dest = path.join(outDir, 'firefox', name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, data);
      }
    }
  }
  return { version, written };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { version, written } = buildPackages();
  for (const file of Object.values(written)) {
    console.log(`${path.relative(root, file).replace(/\\/g, '/')}  (${fs.statSync(file).size} bytes, version ${version})`);
  }
}
