'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const helper = require('../electron/update-helper.cjs');
const { prepareUpgrade } = require('../electron/upgrade.cjs');

// Evaluate the real entry points with a platform override, without changing the
// host process, launching an application, or touching any real installation.
function loadForPlatform(filename, platform, overrides = {}) {
  const localRequire = createRequire(filename);
  const fakeProcess = Object.create(process);
  Object.defineProperty(fakeProcess, 'platform', { value: platform });
  const module = { exports: {} };
  const requireModule = id => Object.hasOwn(overrides, id) ? overrides[id] : localRequire(id);
  vm.runInNewContext('(function(require, module, exports, process, __dirname) {\n' + fs.readFileSync(filename, 'utf8') + '\n})', { Buffer, setTimeout }, { filename })(requireModule, module, module.exports, fakeProcess, path.dirname(filename));
  return module.exports;
}

function fixture(t) {
  // realpath avoids macOS /var -> /private/var, which the updater rightly rejects.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qmx-platform-update-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, 'user');
  const installDir = path.join(root, 'install');
  fs.mkdirSync(userDataDir); fs.mkdirSync(installDir);
  return { root, userDataDir, installDir, version: '1.0.0', targetVersion: '2.0.0' };
}

test('platform executable allowlist and macOS bundle Resources layout are explicit', t => {
  const f = fixture(t);
  for (const [platform, executable] of [['win32', 'QMX-Notebook.exe'], ['linux', 'QMX-Notebook']]) {
    assert.deepEqual(helper.installationPaths(f.installDir, platform), { executablePath: path.join(f.installDir, executable), resourcesDir: path.join(f.installDir, 'resources') });
  }
  const macOS = path.join(f.root, 'QMX-Notebook.app', 'Contents', 'MacOS');
  assert.deepEqual(helper.installationPaths(macOS, 'darwin'), { executablePath: path.join(macOS, 'QMX-Notebook'), resourcesDir: path.join(f.root, 'QMX-Notebook.app', 'Contents', 'Resources') });
  assert.throws(() => helper.installationPaths(f.installDir, 'darwin'), /bundle path/);
  assert.throws(() => helper.installationPaths(f.installDir, 'freebsd'), /Unsupported/);
  assert.throws(() => helper.installationPaths(f.installDir, 'toString'), /Unsupported/);
});

test('Unix backups require the allowlisted executable without a Windows uninstaller', t => {
  for (const platform of ['linux', 'darwin']) {
    const f = fixture(t);
    if (platform === 'darwin') {
      f.installDir = path.join(f.root, 'QMX-Notebook.app', 'Contents', 'MacOS');
      fs.mkdirSync(f.installDir, { recursive: true });
    }
    fs.writeFileSync(path.join(f.userDataDir, 'auth.json'), 'private fixture data');
    const executable = helper.installationPaths(f.installDir, platform).executablePath;
    fs.writeFileSync(executable, 'never executed', { mode: 0o751 });
    const result = prepareUpgrade(f, { platform });
    assert.deepEqual(result.args, []);
    assert.equal(fs.readFileSync(path.join(result.backupDir, 'auth.json'), 'utf8'), 'private fixture data');
    assert.equal(fs.existsSync(path.join(f.installDir, 'Uninstall QMX-Notebook.exe')), false);
    fs.unlinkSync(executable);
    fs.writeFileSync(path.join(f.installDir, 'QMX-Notebook.exe'), 'wrong platform executable');
    assert.throws(() => prepareUpgrade(f, { platform }), /executable.*missing or unsafe/);
  }
});

test('Linux helper validates signed jobs without an uninstaller and rejects executable or resource escapes', t => {
  const f = fixture(t);
  const linuxHelper = loadForPlatform(require.resolve('../electron/update-helper.cjs'), 'linux');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const id = 'a'.repeat(32);
  const transactionDir = path.join(f.userDataDir, 'updates', `transaction-${id}`);
  fs.mkdirSync(transactionDir, { recursive: true });
  const resources = path.join(f.installDir, 'resources');
  fs.mkdirSync(resources);
  const executablePath = path.join(f.installDir, 'QMX-Notebook');
  fs.writeFileSync(executablePath, 'fixture only');
  const manifest = { schema: 1, version: '2.0.0', runtimeVersion: '40.0.0', base: '../', notes: 'fixture', publishedAt: '2026-01-01T00:00:00Z', files: [{ path: 'resources/app.asar', size: 1, sha256: crypto.createHash('sha256').update('a').digest('hex') }] };
  manifest.signature = crypto.sign(null, Buffer.from(helper.canonical(manifest)), privateKey).toString('base64');
  const job = {
    schema: 1, transactionDir, userDataDir: f.userDataDir, installDir: f.installDir, executablePath,
    fromVersion: '1.0.0', toVersion: '2.0.0', runtimeVersion: '40.0.0', manifest,
    parentPid: 2147483647, launchArgs: ['--disable-gpu'],
    stagePath: path.join(transactionDir, 'app.asar'), backupPath: path.join(transactionDir, 'original.asar'),
    statePath: path.join(transactionDir, 'state.json'), keyPath: path.join(transactionDir, 'public-key.pem'),
    targetPath: path.join(resources, 'app.asar'), newPath: path.join(resources, `app.asar.${id}.new`), oldPath: path.join(resources, `app.asar.${id}.old`)
  };
  fs.writeFileSync(job.keyPath, pem);
  const jobPath = path.join(transactionDir, 'job.json');
  const write = change => fs.writeFileSync(jobPath, JSON.stringify({ ...job, ...change }));
  write({});
  assert.equal(linuxHelper.validateJob(jobPath, pem).executablePath, executablePath);
  for (const executablePath of [path.join(f.installDir, 'QMX-Notebook.exe'), path.join(f.root, 'QMX-Notebook'), path.join(f.installDir, 'arbitrary-command')]) {
    write({ executablePath });
    assert.throws(() => linuxHelper.validateJob(jobPath, pem), /Unsafe update executablePath/);
  }
  write({ targetPath: path.join(f.root, 'app.asar') });
  assert.throws(() => linuxHelper.validateJob(jobPath, pem), /Unsafe update targetPath/);
  write({});
  fs.writeFileSync(jobPath, JSON.stringify({ ...job, manifest: { ...manifest, notes: 'tampered' } }));
  assert.throws(() => linuxHelper.validateJob(jobPath, pem), /signature/);
});

test('macOS entry points refuse ASAR mutation with Chinese manual installation guidance before IO', async () => {
  const macHelper = loadForPlatform(require.resolve('../electron/update-helper.cjs'), 'darwin');
  const fileUpgrade = loadForPlatform(require.resolve('../electron/file-upgrade.cjs'), 'darwin', { './update-helper.cjs': macHelper });
  const capability = fileUpgrade.getFileUpgradeCapability();
  assert.equal(capability.supported, false);
  assert.match(capability.reason, /macOS.*app\.asar.*签名.*手动安装/);
  assert.throws(() => fileUpgrade.prepareFileUpgrade(), /签名.*手动安装/);
  await assert.rejects(macHelper.applyJob('deliberately invalid path'), /签名.*手动安装/);
  assert.throws(() => macHelper.recoverTransaction('deliberately invalid path'), /签名.*手动安装/);
  assert.equal(helper.getFileUpgradeCapability('linux').supported, true);
  assert.equal(helper.getFileUpgradeCapability('win32').supported, true);
  assert.equal(helper.getFileUpgradeCapability('freebsd').supported, false);
});
