const { packager } = require('@electron/packager');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const root = path.resolve(__dirname, '..');
async function main() {
  // A fresh temporary directory prevents old source or private data entering releases.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'qmx-notebook-build-'));
  const pkg = require('../package.json');
  for (const name of ['electron', 'ui']) {
    fs.cpSync(path.join(root, name), path.join(stage, name), { recursive: true });
  }
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
    name: pkg.name, version: pkg.version, main: pkg.main, dependencies: pkg.dependencies
  }, null, 2));
  for (const name of Object.keys(pkg.dependencies)) {
    fs.cpSync(fs.realpathSync(path.join(root, 'node_modules', name)),
      path.join(stage, 'node_modules', name), { recursive: true, dereference: true });
  }
  const version = require('electron/package.json').version;
  const archiveDir = path.join(root, '.electron-zip');
  const archive = path.join(archiveDir, `electron-v${version}-win32-x64.zip`);
  const options = {
    dir: stage, name: 'QMX-Notebook', platform: 'win32', arch: 'x64',
    out: path.join(root, 'release'), overwrite: true, electronVersion: version,
    asar: true, prune: false,
    download: { checksums: require('electron/checksums.json') }
  };
  // Optional local runtime archive; clean GitHub runners download automatically.
  if (fs.existsSync(archive)) options.electronZipDir = archiveDir;
  const outputs = await packager(options);
  for (const output of outputs) {
    for (const [name, flags] of [['启动.cmd', '--disable-gpu'], ['兼容启动.cmd', '--disable-gpu --no-sandbox']]) {
      fs.writeFileSync(path.join(output, name), `@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=\r\ncd /d "%~dp0"\r\nstart "" "QMX-Notebook.exe" ${flags}\r\n`);
    }
    fs.copyFileSync(path.join(root, 'docs', 'USAGE.md'), path.join(output, '使用说明.md'));
  }
  console.log('Build output:', outputs.join('\n'));
  console.log('Temporary build directory:', stage);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
