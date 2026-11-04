'use strict';
// Local build only: preserve the installed, matching Electron runtime; never reuse a stale signed feed.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'release', 'QMX-Notebook-win32-x64');
async function main() {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'qmx-local-stage-'));
  const pkg = require('../package.json');
  for (const name of ['electron', 'ui']) fs.cpSync(path.join(root, name), path.join(stage, name), { recursive: true });
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, main: pkg.main, dependencies: pkg.dependencies }, null, 2));
  for (const name of Object.keys(pkg.dependencies)) fs.cpSync(fs.realpathSync(path.join(root, 'node_modules', name)), path.join(stage, 'node_modules', name), { recursive: true, dereference: true });
  fs.mkdirSync(path.join(output, 'resources'), { recursive: true });
  // The user's installed app has the same runtime, 40.10.6. Copy runtime files only, not its application archive.
  const runtime = 'D:\\拾题\\QMX-Notebook';
  for (const entry of fs.readdirSync(runtime, { withFileTypes: true })) {
    if (entry.name === 'resources' || /uninstall/i.test(entry.name)) continue;
    fs.cpSync(path.join(runtime, entry.name), path.join(output, entry.name), { recursive: true });
  }
  await asar.createPackage(stage, path.join(output, 'resources', 'app.asar'));
  const built = JSON.parse(asar.extractFile(path.join(output, 'resources', 'app.asar'), 'package.json'));
  if (built.version !== pkg.version) throw new Error('Build version mismatch');
  console.log('Built local version', built.version, output);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
