'use strict';

const nativeTest = require('node:test');
const test = Object.assign((name, fn) => nativeTest(name, { skip: process.platform === 'darwin' ? 'macOS signed bundle application is disabled; covered in update-helper tests' : false }, fn), { after: nativeTest.after });
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const helper = require('../electron/update-helper.cjs');
const { prepareFileUpgrade, recoverFileUpgrade } = require('../electron/file-upgrade.cjs');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pem = publicKey.export({ type: 'spki', format: 'pem' });
const keyModule = require.resolve('../electron/update-key.cjs');
require(keyModule);
const productionKey = require.cache[keyModule].exports;
test.after(() => { require.cache[keyModule].exports = productionKey; });
require.cache[keyModule].exports = pem;
const DEAD_PID = 2147483647;

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qmx-file-upgrade-')));
  // root is generated directly by mkdtemp, so removal is restricted to this fixture.
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, 'user');
  const installDir = path.join(root, 'installed');
  const downloadDir = path.join(root, 'download');
  for (const directory of [userDataDir, installDir, downloadDir, path.join(installDir, 'resources')]) fs.mkdirSync(directory);
  const executablePath = helper.installationPaths(installDir).executablePath;
  fs.writeFileSync(executablePath, 'fixture executable', { mode: 0o751 });
  if (process.platform === 'win32') fs.writeFileSync(path.join(installDir, 'Uninstall QMX-Notebook.exe'), 'fixture uninstaller');
  for (const name of ['local.json', 'settings.json', 'auth.json', 'cache.json']) fs.writeFileSync(path.join(userDataDir, name), `private user data ${name}`);
  fs.writeFileSync(path.join(userDataDir, 'extra.db'), 'untouched database');
  const old = Buffer.from('original installed archive');
  const next = Buffer.from('new signed archive');
  const target = path.join(installDir, 'resources', 'app.asar');
  fs.writeFileSync(target, old);
  const stage = path.join(downloadDir, 'app.asar');
  fs.writeFileSync(stage, next);
  const manifest = { schema: 1, version: '2.0.0', runtimeVersion: '40.0.0', base: '../', notes: 'signed release', publishedAt: '2026-01-01T00:00:00Z', files: [{ path: 'resources/app.asar', size: next.length, sha256: crypto.createHash('sha256').update(next).digest('hex') }] };
  manifest.signature = crypto.sign(null, Buffer.from(helper.canonical(manifest)), privateKey).toString('base64');
  const options = { userDataDir, installDir, version: '1.0.0', targetVersion: '2.0.0', runtimeVersion: '40.0.0', executablePath, parentPid: DEAD_PID, ready: { path: stage, version: '2.0.0', manifest } };
  const snapshot = Object.fromEntries(fs.readdirSync(userDataDir).map(name => [name, fs.readFileSync(path.join(userDataDir, name))]));
  return { options, old, next, target, stage, snapshot, userDataDir, installDir };
}
function assertUserData(fixture) {
  for (const [name, bytes] of Object.entries(fixture.snapshot)) assert.deepEqual(fs.readFileSync(path.join(fixture.userDataDir, name)), bytes);
}
function successfulSpawn(calls = []) {
  return (exe, args, options) => {
    calls.push({ exe, args, options });
    const child = new EventEmitter(); child.unref = () => {};
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
}

test('successful signed archive upgrade backs up user data and relaunches without Node mode', async t => {
  const f = fixture(t);
  const executableBefore = { bytes: fs.readFileSync(f.options.executablePath), mode: fs.statSync(f.options.executablePath).mode };
  const prepared = prepareFileUpgrade(f.options);
  assert.deepEqual(prepared.env, { ELECTRON_RUN_AS_NODE: '1' });
  assert.equal(fs.readFileSync(prepared.args[0], 'utf8').includes("require('./"), false);
  assert.deepEqual(fs.readFileSync(path.join(prepared.backupDir, 'local.json')), f.snapshot['local.json']);
  const calls = [];
  const prior = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = '1';
  try { await helper.applyJob(prepared.args[1], { spawn: successfulSpawn(calls) }); }
  finally { if (prior === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = prior; }
  assert.deepEqual(fs.readFileSync(f.target), f.next);
  const job = helper.readJson(prepared.args[1]);
  assert.deepEqual(fs.readFileSync(job.backupPath), f.old);
  assert.deepEqual(fs.readFileSync(job.oldPath), f.old);
  assert.equal(helper.readJson(job.statePath).phase, 'completed');
  assert.deepEqual(fs.readFileSync(f.options.executablePath), executableBefore.bytes);
  assert.equal(fs.statSync(f.options.executablePath).mode, executableBefore.mode);
  if (process.platform === 'linux') {
    assert.equal(executableBefore.mode & 0o777, 0o751);
    assert.equal(fs.existsSync(path.join(f.installDir, 'Uninstall QMX-Notebook.exe')), false);
  }
  assert.equal(calls[0].exe, f.options.executablePath);
  assert.deepEqual(calls[0].args, ['--disable-gpu']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.deepEqual(recoverFileUpgrade(f.userDataDir, f.installDir), { phase: 'completed' });
  assertUserData(f);
});

test('stage tamper before preparation or after preparation never replaces current archive', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.stage, Buffer.alloc(f.next.length));
  assert.throws(() => prepareFileUpgrade(f.options), /SHA-256/);
  fs.writeFileSync(f.stage, f.next);
  const prepared = prepareFileUpgrade(f.options);
  const job = helper.readJson(prepared.args[1]);
  fs.writeFileSync(job.stagePath, Buffer.alloc(f.next.length));
  await assert.rejects(helper.applyJob(prepared.args[1], { spawn: successfulSpawn() }), /SHA-256/);
  assert.deepEqual(fs.readFileSync(f.target), f.old);
  assert.equal(helper.readJson(job.statePath).phase, 'failed');
  assertUserData(f);
});

test('signature, runtime, symlink and overlapping paths are refused', t => {
  const f = fixture(t);
  assert.throws(() => prepareFileUpgrade({ ...f.options, runtimeVersion: '41.0.0' }), /runtime/);
  f.options.ready.manifest.notes = 'tampered';
  assert.throws(() => prepareFileUpgrade(f.options), /signature/);
  assert.throws(() => prepareFileUpgrade({ ...f.options, userDataDir: f.installDir }), /overlap/);
  const junction = path.join(f.userDataDir, 'junction');
  fs.symlinkSync(path.dirname(f.stage), junction, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => helper.regular(path.join(junction, 'app.asar')), /links|junctions/);
  assertUserData(f);
});

test('failed atomic replacement rolls back from verified original backup', async t => {
  const f = fixture(t);
  const prepared = prepareFileUpgrade(f.options);
  const job = helper.readJson(prepared.args[1]);
  let failed = false;
  const io = Object.create(fs);
  io.renameSync = (from, to) => {
    if (!failed && from === job.newPath && to === job.targetPath) { failed = true; throw new Error('injected failed swap'); }
    return fs.renameSync(from, to);
  };
  await assert.rejects(helper.applyJob(prepared.args[1], { io, spawn: successfulSpawn() }), /failed swap/);
  assert.equal(failed, true);
  assert.deepEqual(fs.readFileSync(f.target), f.old);
  assert.equal(helper.readJson(job.statePath).phase, 'rolled-back');
  assertUserData(f);
});

test('asynchronous relaunch error restores original archive', async t => {
  const f = fixture(t);
  const prepared = prepareFileUpgrade(f.options);
  await assert.rejects(helper.applyJob(prepared.args[1], { spawn: () => {
    const child = new EventEmitter(); child.unref = () => {};
    queueMicrotask(() => child.emit('error', new Error('injected launch failure')));
    return child;
  } }), /launch failure/);
  assert.deepEqual(fs.readFileSync(f.target), f.old);
  assert.equal(helper.readJson(helper.readJson(prepared.args[1]).statePath).phase, 'rolled-back');
  assertUserData(f);
});

test('interrupted swap is restored on next boot using durable backup', t => {
  const f = fixture(t);
  const prepared = prepareFileUpgrade(f.options);
  const job = helper.readJson(prepared.args[1]);
  const original = helper.metadata(f.target);
  fs.copyFileSync(f.target, job.backupPath);
  helper.writeJson(job.statePath, { schema: 1, phase: 'swapping', mutationStarted: true, helperPid: DEAD_PID, original });
  fs.copyFileSync(f.target, job.oldPath);
  fs.copyFileSync(job.stagePath, f.target);
  assert.deepEqual(fs.readFileSync(f.target), f.next);
  assert.deepEqual(recoverFileUpgrade(f.userDataDir, f.installDir), { phase: 'rolled-back' });
  assert.deepEqual(fs.readFileSync(f.target), f.old);
  assert.deepEqual(recoverFileUpgrade(f.userDataDir, f.installDir), { phase: 'rolled-back' });
  assertUserData(f);
});

test('recovery refuses active helper, tampered original backup, and pointer traversal', t => {
  const f = fixture(t);
  const prepared = prepareFileUpgrade(f.options);
  const job = helper.readJson(prepared.args[1]);
  const original = helper.metadata(f.target);
  fs.copyFileSync(f.target, job.backupPath);
  helper.writeJson(job.statePath, { schema: 1, phase: 'swapping', mutationStarted: true, helperPid: process.pid, original });
  assert.throws(() => recoverFileUpgrade(f.userDataDir, f.installDir), /still active/);
  helper.writeJson(job.statePath, { schema: 1, phase: 'swapping', mutationStarted: true, helperPid: DEAD_PID, original });
  fs.writeFileSync(job.backupPath, 'tampered original');
  assert.throws(() => recoverFileUpgrade(f.userDataDir, f.installDir), /SHA-256/);
  assert.deepEqual(fs.readFileSync(f.target), f.old);
  helper.writeJson(path.join(f.userDataDir, 'updates', 'active.json'), { schema: 1, transaction: '../escape' });
  assert.throws(() => recoverFileUpgrade(f.userDataDir, f.installDir), /pointer/);
  assertUserData(f);
});

test('copied helper runs standalone and rejects tampered stage in a separate Node process', async t => {
  const f = fixture(t);
  const prepared = prepareFileUpgrade(f.options);
  const job = helper.readJson(prepared.args[1]);
  fs.writeFileSync(job.stagePath, Buffer.alloc(f.next.length));
  const child = require('node:child_process').spawn(process.execPath, prepared.args, { shell: false, stdio: 'ignore' });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 1);
  assert.equal(helper.readJson(job.statePath).phase, 'failed');
  assert.deepEqual(fs.readFileSync(f.target), f.old);
  assertUserData(f);
});

test('copied helper executes with installed Electron RunAsNode fuse', async t => {
  const electron = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  if (!fs.existsSync(electron)) { t.skip('Electron binary unavailable'); return; }
  const f = fixture(t);
  const prepared = prepareFileUpgrade(f.options);
  const job = helper.readJson(prepared.args[1]);
  // Reject before changing files, avoiding GUI launch while proving Node mode.
  fs.writeFileSync(job.stagePath, Buffer.alloc(f.next.length));
  const child = require('node:child_process').spawn(electron, prepared.args, { shell: false, stdio: 'ignore', env: { ...process.env, ...prepared.env } });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 1);
  assert.equal(helper.readJson(job.statePath).phase, 'failed');
  assert.deepEqual(fs.readFileSync(f.target), f.old);
  assertUserData(f);
});

test('helper parent timeout is bounded and does not touch installed archive', async t => {
  const f = fixture(t);
  assert.throws(() => helper.validateManifest({ ...f.options.ready.manifest, files: [] }, pem, '40.0.0'), /exactly/);
  await assert.rejects(helper.waitForParent(process.pid, 0), /timed out/);
  await assert.rejects(helper.waitForParent(DEAD_PID, 120001), /timeout/);
  assert.deepEqual(fs.readFileSync(f.target), f.old);
  assertUserData(f);
});
