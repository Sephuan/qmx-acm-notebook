'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { prepareUpgrade: nativePrepareUpgrade } = require('../electron/upgrade.cjs');
// Existing cases exercise the Windows installer contract on every test host.
const prepareUpgrade = (options, dependencies) => nativePrepareUpgrade(options, { platform: 'win32', ...dependencies });

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qmx-upgrade-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installDir = path.join(root, 'QMX Notebook, 中文');
  const userDataDir = path.join(root, 'user data');
  fs.mkdirSync(installDir);
  fs.mkdirSync(userDataDir);
  fs.writeFileSync(path.join(installDir, 'QMX-Notebook.exe'), 'fake app, never executed');
  fs.writeFileSync(path.join(installDir, 'Uninstall QMX-Notebook.exe'), 'fake uninstaller, never executed');
  return { root, installDir, userDataDir, version: '0.3.1', targetVersion: '0.4.0' };
}
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('backs up only known existing files, preserves originals, records hashes without contents, and returns native NSIS args', t => {
  const options = fixture(t);
  const files = {
    'local.json': Buffer.from('{"notes":"中文"}'),
    'settings.json': Buffer.from('{"theme":"dark"}'),
    'auth.json': Buffer.from('{"token":"secret-token-never-in-receipt"}'),
    'cache.json': Buffer.from([0, 255, 1, 2])
  };
  const before = {};
  for (const [name, bytes] of Object.entries(files)) {
    fs.writeFileSync(path.join(options.userDataDir, name), bytes);
    before[name] = fs.statSync(path.join(options.userDataDir, name)).mtimeMs;
  }
  fs.writeFileSync(path.join(options.userDataDir, 'unknown-private-file'), 'do not read');
  const reads = [];
  const result = prepareUpgrade(options, { fs: { ...fs, readFileSync(file, ...args) { reads.push(file); return fs.readFileSync(file, ...args); } } });
  assert.deepEqual(result.args, ['/S', '--updated', '--force-run', '--keep-shortcuts', '/currentuser', `/D=${fs.realpathSync(options.installDir)}`]);
  assert.equal(path.dirname(result.backupDir), path.join(fs.realpathSync(options.userDataDir), 'backups'));
  assert.match(path.basename(result.backupDir), /^pre-update-\d{8}T\d{9}Z-[0-9a-f]{16}$/);
  assert.equal(reads.some(file => path.basename(file) === 'unknown-private-file'), false);
  assert.deepEqual(fs.readdirSync(result.backupDir).sort(), [...Object.keys(files), 'receipt.json'].sort());
  const receiptText = fs.readFileSync(path.join(result.backupDir, 'receipt.json'), 'utf8');
  const receipt = JSON.parse(receiptText);
  assert.deepEqual(Object.keys(receipt).sort(), ['hashes', 'sourceVersion', 'targetVersion', 'timestamp']);
  assert.equal(receipt.sourceVersion, '0.3.1');
  assert.equal(receipt.targetVersion, '0.4.0');
  assert.equal(new Date(receipt.timestamp).toISOString(), receipt.timestamp);
  assert.equal(receiptText.includes('secret-token'), false);
  for (const [name, bytes] of Object.entries(files)) {
    assert.deepEqual(fs.readFileSync(path.join(result.backupDir, name)), bytes);
    assert.deepEqual(fs.readFileSync(path.join(options.userDataDir, name)), bytes);
    assert.equal(fs.statSync(path.join(options.userDataDir, name)).mtimeMs, before[name]);
    assert.equal(receipt.hashes[name], hash(bytes));
  }
  const next = prepareUpgrade(options);
  assert.notEqual(next.backupDir, result.backupDir);
  assert.equal(fs.existsSync(result.backupDir), true);
});

test('missing user files are skipped without creating or changing originals', t => {
  const options = fixture(t);
  const result = prepareUpgrade(options);
  assert.deepEqual(fs.readdirSync(result.backupDir), ['receipt.json']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.backupDir, 'receipt.json'))).hashes, {});
  assert.deepEqual(fs.readdirSync(options.userDataDir), ['backups']);
});

test('portable app refusal leaves data untouched and instructs one manual install', t => {
  for (const filename of ['QMX-Notebook.exe', 'Uninstall QMX-Notebook.exe']) {
    const options = fixture(t);
    fs.writeFileSync(path.join(options.userDataDir, 'auth.json'), 'private token');
    fs.unlinkSync(path.join(options.installDir, filename));
    assert.throws(() => prepareUpgrade(options), /Portable.*one manual installation.*shortcuts/i);
    assert.deepEqual(fs.readdirSync(options.userDataDir), ['auth.json']);
    assert.equal(fs.readFileSync(path.join(options.userDataDir, 'auth.json'), 'utf8'), 'private token');
  }
});

test('rejects equal paths and either direction of nesting before writing backups', t => {
  const options = fixture(t);
  for (const [installDir, userDataDir] of [
    [options.userDataDir, options.userDataDir],
    [options.root, options.userDataDir],
    [options.installDir, options.root],
    [options.userDataDir + path.sep, options.userDataDir]
  ]) assert.throws(() => prepareUpgrade({ ...options, installDir, userDataDir }), /overlap/);
  assert.deepEqual(fs.readdirSync(options.userDataDir), []);
});

test('requires absolute existing directories and rejects namespace paths', t => {
  const options = fixture(t);
  const regularFile = path.join(options.root, 'not-a-directory');
  fs.writeFileSync(regularFile, 'file');
  for (const key of ['installDir', 'userDataDir']) {
    for (const value of ['', '.', 'relative', 'C:relative', '\\\\?\\C:\\QMX', '\\\\.\\C:\\QMX', '//server/share', '\\\\server\\share', options[key] + '\0']) {
      assert.throws(() => prepareUpgrade({ ...options, [key]: value }), /absolute|namespace|network/);
    }
    assert.throws(() => prepareUpgrade({ ...options, [key]: path.join(options.root, 'missing') }), /ENOENT/);
    assert.throws(() => prepareUpgrade({ ...options, [key]: regularFile }), /directory/);
  }
  if (process.platform === 'win32') {
    assert.throws(() => prepareUpgrade({ ...options, installDir: options.installDir + ':stream' }), /invalid Windows/);
  }
});

test('rejects directory junctions at installDir, userDataDir, and ancestor paths', t => {
  const options = fixture(t);
  const alias = path.join(options.root, 'alias');
  fs.symlinkSync(options.installDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepareUpgrade({ ...options, installDir: alias }), /symlinks or junctions/);
  assert.throws(() => prepareUpgrade({ ...options, userDataDir: alias }), /symlinks or junctions/);
  const child = path.join(options.installDir, 'nested');
  fs.mkdirSync(child);
  assert.throws(() => prepareUpgrade({ ...options, installDir: path.join(alias, 'nested') }), /symlinks or junctions/);
});

test('rejects symlinked backups without writing outside user data', t => {
  const options = fixture(t);
  const outside = path.join(options.root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(options.userDataDir, 'backups'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepareUpgrade(options), /backup failed/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('copy/read/receipt errors and corrupted copies abort while retaining data and partial backups', t => {
  for (const mode of ['copy', 'read', 'corrupt', 'receipt']) {
    const options = fixture(t);
    const source = path.join(options.userDataDir, 'auth.json');
    const secret = 'secret-error-must-not-leak';
    fs.writeFileSync(source, secret);
    const injected = { ...fs };
    if (mode === 'copy') injected.copyFileSync = () => { throw new Error(secret); };
    if (mode === 'read') injected.readFileSync = () => { throw new Error(secret); };
    if (mode === 'corrupt') injected.copyFileSync = (_source, destination) => fs.writeFileSync(destination, 'corruption');
    if (mode === 'receipt') injected.writeFileSync = () => { throw new Error(secret); };
    assert.throws(() => prepareUpgrade(options, { fs: injected }), error => /backup failed.*must not be launched/.test(error.message) && !error.message.includes(secret));
    assert.equal(fs.readFileSync(source, 'utf8'), secret);
    const backups = fs.readdirSync(path.join(options.userDataDir, 'backups'));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^pre-update-/);
    assert.equal(fs.existsSync(path.join(options.userDataDir, 'backups', backups[0], 'receipt.json')), false);
  }
});

test('non-regular user data files abort and invalid versions do not create backups', t => {
  const options = fixture(t);
  for (const value of [undefined, '', 'v0.4.0', '0.4.0-beta', 'x', '0.04.0']) {
    assert.throws(() => prepareUpgrade({ ...options, targetVersion: value }), /semantic versions/);
  }
  fs.mkdirSync(path.join(options.userDataDir, 'auth.json'));
  assert.throws(() => prepareUpgrade(options), /backup failed/);
  assert.equal(fs.statSync(path.join(options.userDataDir, 'auth.json')).isDirectory(), true);
});
