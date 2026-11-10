'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const helper = require('../electron/update-helper.cjs');
const { prepareFileUpgrade, recoverFileUpgrade } = require('../electron/file-upgrade.cjs');
const { cleanupUpdateStorage } = require('../electron/update-storage.cjs');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pem = publicKey.export({ type: 'spki', format: 'pem' });
const keyModule = require.resolve('../electron/update-key.cjs');
require(keyModule);
const productionKey = require.cache[keyModule].exports;
test.after(() => { require.cache[keyModule].exports = productionKey; });
const supported = process.platform !== 'darwin';
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qmx-storage-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const user = path.join(root, 'user'), install = path.join(root, 'install');
  fs.mkdirSync(user); fs.mkdirSync(install); fs.mkdirSync(path.join(install, 'resources'));
  fs.writeFileSync(helper.installationPaths(install).executablePath, 'portable executable');
  fs.writeFileSync(path.join(install, 'resources', 'app.asar'), Buffer.alloc(8192, 1));
  for (const name of ['local.json', 'auth.json', 'planner.json']) fs.writeFileSync(path.join(user, name), `keep ${name}`);
  require.cache[keyModule].exports = pem;
  return { root, user, install };
}
function prepare(f, index) {
  const updates = path.join(f.user, 'updates'); fs.mkdirSync(updates, { recursive: true });
  const download = fs.mkdtempSync(path.join(updates, 'qmx-update-'));
  fs.writeFileSync(path.join(download, '.owner.json'), JSON.stringify({ schema: 1, pid: 2147483647 }));
  const next = Buffer.alloc(8192, index + 1);
  const archive = path.join(download, 'app.asar'); fs.writeFileSync(archive, next);
  const version = `1.0.${index}`, targetVersion = `1.0.${index + 1}`;
  const manifest = { schema: 1, version: targetVersion, runtimeVersion: '40.0.0', base: '../', notes: '', publishedAt: new Date().toISOString(), files: [{ path: 'resources/app.asar', size: next.length, sha256: crypto.createHash('sha256').update(next).digest('hex') }] };
  manifest.signature = crypto.sign(null, Buffer.from(helper.canonical(manifest)), privateKey).toString('base64');
  const prepared = prepareFileUpgrade({ userDataDir: f.user, installDir: f.install, version, targetVersion, runtimeVersion: '40.0.0', executablePath: helper.installationPaths(f.install).executablePath, parentPid: 2147483647, ready: { path: archive, version: targetVersion, manifest } });
  return { prepared, next, job: helper.readJson(prepared.args[1]) };
}
function spawn() { const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child; }
function bytes(dir) { return fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, e) => sum + (e.isDirectory() ? bytes(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0); }

test('six portable upgrades keep one installed archive, no payload copies, two backups and at most three receipts', { skip: !supported }, async t => {
  const f = fixture(t), sizes = [];
  for (let index = 0; index < 6; index++) {
    const { prepared, next, job } = prepare(f, index);
    await helper.applyJob(prepared.args[1], { spawn });
    assert.deepEqual(fs.readFileSync(job.targetPath), next);
    assert.equal(recoverFileUpgrade(f.user, f.install).phase, 'completed');
    const report = cleanupUpdateStorage(f.user, f.install, pem);
    assert.equal(report.retained, 0);
    assert.ok(report.bytes >= 3 * 8192);
    assert.deepEqual(fs.readdirSync(path.dirname(job.targetPath)), ['app.asar']);
    const entries = fs.readdirSync(path.join(f.user, 'updates'));
    assert.ok(entries.length <= 3);
    assert.ok(entries.every(name => name.endsWith('-resolved.json')));
    assert.ok(fs.readdirSync(path.join(f.user, 'backups')).length <= 2);
    for (const name of ['local.json', 'auth.json', 'planner.json']) assert.equal(fs.readFileSync(path.join(f.user, name), 'utf8'), `keep ${name}`);
    sizes.push(bytes(f.user));
  }
  assert.equal(sizes[5], sizes[2], 'disk use must stabilize after retention limits are reached');
  console.log('Six equal-sized upgrades user-data bytes:', sizes.join(', '));
});

test('existing resolved transactions from old clients are cleaned, unknown files and junction targets are retained', { skip: !supported }, async t => {
  const f = fixture(t);
  const { prepared, job } = prepare(f, 0);
  await helper.applyJob(prepared.args[1], { spawn });
  recoverFileUpgrade(f.user, f.install);
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'app.asar'), 'do not delete');
  fs.symlinkSync(outside, path.join(f.user, 'updates', 'qmx-update-ABC123'), process.platform === 'win32' ? 'junction' : 'dir');
  const unknown = path.join(f.user, 'updates', 'qmx-update-DEF456'); fs.mkdirSync(unknown); fs.writeFileSync(path.join(unknown, 'personal.txt'), 'keep');
  cleanupUpdateStorage(f.user, f.install, pem);
  assert.equal(fs.existsSync(job.transactionDir), false);
  assert.equal(fs.existsSync(job.oldPath), false);
  assert.equal(fs.readFileSync(path.join(outside, 'app.asar'), 'utf8'), 'do not delete');
  assert.equal(fs.readFileSync(path.join(unknown, 'personal.txt'), 'utf8'), 'keep');
});

test('unfinished update and backup survive cleanup, interrupted replacement still rolls back', { skip: !supported }, t => {
  const f = fixture(t);
  const { job } = prepare(f, 0);
  const original = helper.metadata(job.targetPath), old = fs.readFileSync(job.targetPath);
  fs.copyFileSync(job.targetPath, job.backupPath); fs.copyFileSync(job.stagePath, job.targetPath);
  helper.writeJson(job.statePath, { schema: 1, phase: 'swapping', mutationStarted: true, helperPid: 2147483647, original });
  cleanupUpdateStorage(f.user, f.install, pem);
  assert.equal(fs.existsSync(job.backupPath), true);
  assert.equal(fs.existsSync(job.stagePath), true);
  assert.equal(recoverFileUpgrade(f.user, f.install).phase, 'rolled-back');
  assert.deepEqual(fs.readFileSync(job.targetPath), old);
  cleanupUpdateStorage(f.user, f.install, pem);
  assert.equal(fs.existsSync(job.transactionDir), false);
});

test('live helper protects rollback payload until relaunch completes; delayed pass never touches current download', { skip: !supported }, async t => {
  const f = fixture(t);
  const { prepared, job } = prepare(f, 0);
  await helper.applyJob(prepared.args[1], { spawn }); recoverFileUpgrade(f.user, f.install);
  const state = helper.readJson(job.statePath); helper.writeJson(job.statePath, { ...state, helperPid: process.pid });
  cleanupUpdateStorage(f.user, f.install, pem);
  assert.equal(fs.existsSync(job.backupPath), true);
  helper.writeJson(job.statePath, { ...state, helperPid: null });
  const current = fs.mkdtempSync(path.join(f.user, 'updates', 'qmx-update-')); fs.writeFileSync(path.join(current, 'app.asar'), 'current downloaded bytes');
  cleanupUpdateStorage(f.user, f.install, pem, { downloads: false });
  assert.equal(fs.existsSync(job.transactionDir), false);
  assert.equal(fs.readFileSync(path.join(current, 'app.asar'), 'utf8'), 'current downloaded bytes');
});

test('startup preserves live download owners and recent legacy directories, cleans dead owners and aged legacy files', { skip: !supported }, t => {
  const f = fixture(t), updates = path.join(f.user, 'updates'); fs.mkdirSync(updates);
  for (const [suffix, pid, aged] of [['LiveAA', process.pid, false], ['DeadAA', 2147483647, false], ['OldAAA', null, true], ['NewAAA', null, false]]) {
    const dir = path.join(updates, `qmx-update-${suffix}`); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'app.asar'), 'payload');
    if (pid) fs.writeFileSync(path.join(dir, '.owner.json'), JSON.stringify({ schema: 1, pid }));
    if (aged) fs.utimesSync(dir, new Date(0), new Date(0));
  }
  cleanupUpdateStorage(f.user, f.install, pem);
  assert.deepEqual(fs.readdirSync(updates).sort(), ['qmx-update-LiveAA', 'qmx-update-NewAAA']);
});
