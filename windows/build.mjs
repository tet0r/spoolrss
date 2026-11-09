// Builds the portable Windows app: dist/SpoolRSS-windows.zip, holding a SpoolRSS folder with
//   SpoolRSS.exe   the tray icon (windows/SpoolRSS.cs, compiled with the C# compiler in Windows)
//   app\           node.exe (official build, checksum checked) and the SpoolRSS server
//   README.txt
// settings.txt and data\ are created on first run, so unzipping a new version over an old
// folder keeps both. Runs on Windows only: `node windows/build.mjs`.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const here = path.join(repo, 'windows');
const version = fs.readFileSync(path.join(repo, 'VERSION'), 'utf8').trim();
const nodeVersion = process.env.SPOOLRSS_NODE_VERSION || process.version; // the Node that runs the tests
const out = path.join(repo, 'dist', 'windows');
const folder = path.join(out, 'SpoolRSS');
const zip = path.join(repo, 'dist', 'SpoolRSS-windows.zip');

if (process.platform !== 'win32') throw new Error('Build the Windows app on Windows (it uses the C# compiler that comes with it).');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(folder, 'app'), { recursive: true });

// ---- node.exe, from nodejs.org, checked against its published checksum ----
const cache = path.join(repo, 'dist', 'cache');
fs.mkdirSync(cache, { recursive: true });
const nodeExe = path.join(cache, `node-${nodeVersion}-win-x64.exe`);
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sums = await (await fetch(`https://nodejs.org/dist/${nodeVersion}/SHASUMS256.txt`)).text();
const expected = sums.split('\n').find((l) => l.trim().endsWith(' win-x64/node.exe'))?.split(/\s+/)[0];
if (!expected) throw new Error(`No checksum for win-x64/node.exe in Node ${nodeVersion}`);
if (!fs.existsSync(nodeExe) || sha256(nodeExe) !== expected) {
  console.log(`Downloading node.exe ${nodeVersion}`);
  const res = await fetch(`https://nodejs.org/dist/${nodeVersion}/win-x64/node.exe`);
  if (!res.ok) throw new Error(`node.exe download failed: HTTP ${res.status}`);
  fs.writeFileSync(nodeExe, Buffer.from(await res.arrayBuffer()));
  if (sha256(nodeExe) !== expected) throw new Error('node.exe does not match its published checksum');
}
fs.copyFileSync(nodeExe, path.join(folder, 'app', 'node.exe'));

// ---- the server ----
for (const item of ['src', 'public', 'node_modules', 'VERSION', 'package.json', 'LICENSE']) {
  fs.cpSync(path.join(repo, item), path.join(folder, 'app', item), {
    recursive: true,
    filter: (src) => !src.split(path.sep).includes('.bin'),
  });
}

// ---- the icon: an .ico holding the extension's PNG icons ----
const pngs = [16, 32, 48, 128].map((size) => ({ size, data: fs.readFileSync(path.join(repo, 'extension', 'icons', `icon-${size}.png`)) }));
const header = Buffer.alloc(6 + 16 * pngs.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);
let offset = header.length;
pngs.forEach(({ size, data }, i) => {
  const at = 6 + 16 * i;
  header[at] = size >= 256 ? 0 : size;
  header[at + 1] = size >= 256 ? 0 : size;
  header.writeUInt16LE(1, at + 4);
  header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(data.length, at + 8);
  header.writeUInt32LE(offset, at + 12);
  offset += data.length;
});
const build = path.join(out, 'build');
fs.mkdirSync(build);
const ico = path.join(build, 'spoolrss.ico');
fs.writeFileSync(ico, Buffer.concat([header, ...pngs.map((p) => p.data)]));

// ---- SpoolRSS.exe ----
const numeric = (version.match(/\d+/g) || []).slice(0, 3).concat(['0', '0', '0']).slice(0, 3).join('.');
fs.writeFileSync(path.join(build, 'AssemblyInfo.cs'), `using System.Reflection;
[assembly: AssemblyTitle("SpoolRSS")]
[assembly: AssemblyProduct("SpoolRSS")]
[assembly: AssemblyDescription("SpoolRSS feed reader")]
[assembly: AssemblyCopyright("MIT License")]
[assembly: AssemblyVersion("${numeric}.0")]
[assembly: AssemblyFileVersion("${numeric}.0")]
[assembly: AssemblyInformationalVersion("${version}")]
`);
const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
execFileSync(csc, [
  '/nologo', '/target:winexe', '/optimize+', '/platform:anycpu',
  // A test build can update from a local server (see SPOOLRSS_TEST_UPDATES in SpoolRSS.cs). Never released.
  ...(process.argv.includes('--test') ? ['/define:TEST_UPDATES'] : []),
  `/out:${path.join(folder, 'SpoolRSS.exe')}`,
  `/win32icon:${ico}`, `/win32manifest:${path.join(here, 'app.manifest')}`, `/resource:${ico},spoolrss.ico`,
  '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.ServiceProcess.dll', '/r:System.IO.Compression.dll', '/r:System.IO.Compression.FileSystem.dll',
  path.join(here, 'SpoolRSS.cs'), path.join(build, 'AssemblyInfo.cs'),
], { stdio: 'inherit' });
fs.rmSync(build, { recursive: true });
// Turns on long paths (see the file); .NET reads it from next to the exe.
fs.copyFileSync(path.join(here, 'SpoolRSS.exe.config'), path.join(folder, 'SpoolRSS.exe.config'));

fs.writeFileSync(path.join(folder, 'README.txt'), fs.readFileSync(path.join(here, 'README.txt'), 'utf8')
  .replace('{version}', version).replace(/\r?\n/g, '\r\n'));

// ---- the zip (Windows' own tar writes zip files) ----
fs.rmSync(zip, { force: true });
execFileSync(path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', zip, '-C', out, 'SpoolRSS'], { stdio: 'inherit' });
// Its checksum, which the updater in SpoolRSS.exe checks the download against.
fs.writeFileSync(`${zip}.sha256`, `${sha256(zip)}  ${path.basename(zip)}
`);
console.log(`Built ${path.relative(repo, zip)} (${(fs.statSync(zip).size / 1048576).toFixed(1)} MB), SpoolRSS ${version} with Node ${nodeVersion}`);
