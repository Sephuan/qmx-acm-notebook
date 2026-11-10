'use strict';

// Electron patches fs to interpret app.asar as a virtual directory. The standalone
// updater must always operate on the archive bytes, including lstat/copy/rename.
if (require.main === module && process.versions.electron) process.noAsar = true;

// This file is copied outside app.asar before restart. Keep it builtins-only.
const fs = process.versions.electron ? require('original-fs') : require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TERMINAL = new Set(['completed', 'rolled-back', 'cancelled', 'failed']);
const EXECUTABLES = Object.freeze({ win32: 'QMX-Notebook.exe', linux: 'QMX-Notebook', darwin: 'QMX-Notebook' });

function installationPaths(installDir, platform = process.platform) {
  absolute(installDir);
  if (!Object.hasOwn(EXECUTABLES, platform)) throw new Error('Unsupported update platform');
  if (platform === 'darwin' && (path.basename(installDir) !== 'MacOS' || path.basename(path.dirname(installDir)) !== 'Contents' || !path.basename(path.dirname(path.dirname(installDir))).endsWith('.app'))) throw new Error('Invalid macOS application bundle path');
  return {
    executablePath: path.join(installDir, EXECUTABLES[platform]),
    resourcesDir: platform === 'darwin' ? path.join(path.dirname(installDir), 'Resources') : path.join(installDir, 'resources')
  };
}
function getFileUpgradeCapability(platform = process.platform) {
  if (platform === 'darwin') return { supported: false, reason: 'macOS 暂不支持自动应用更新：替换 app.asar 会破坏应用签名。请下载最新版本的 macOS 安装包并手动安装，保留现有用户数据。' };
  if (platform === 'win32' || platform === 'linux') return { supported: true, reason: '' };
  return { supported: false, reason: '当前系统不支持自动应用更新，请下载适用于当前系统的安装包并手动安装。' };
}
function assertFileUpgradeSupported(platform = process.platform) {
  const capability = getFileUpgradeCapability(platform);
  if (!capability.supported) throw new Error(capability.reason);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
}
function validateManifest(manifest, pem, runtimeVersion) {
  if (!exactKeys(manifest, ['schema', 'version', 'runtimeVersion', 'base', 'notes', 'publishedAt', 'files', 'signature']) || manifest.schema !== 1 || !VERSION.test(manifest.version) || !VERSION.test(manifest.runtimeVersion) || manifest.base !== '../' || typeof manifest.notes !== 'string' || typeof manifest.publishedAt !== 'string' || !Number.isFinite(Date.parse(manifest.publishedAt))) throw new Error('Invalid signed update manifest');
  if (!Array.isArray(manifest.files) || manifest.files.length !== 1) throw new Error('Manifest must contain exactly resources/app.asar');
  const file = manifest.files[0];
  if (!exactKeys(file, ['path', 'size', 'sha256']) || file.path !== 'resources/app.asar' || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 256 * 1024 * 1024 || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(file.sha256)) throw new Error('Invalid manifest file');
  if (typeof manifest.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(manifest.signature)) throw new Error('Invalid manifest signature');
  const key = crypto.createPublicKey(pem);
  const signature = Buffer.from(manifest.signature, 'base64');
  const unsigned = Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'signature'));
  if (key.asymmetricKeyType !== 'ed25519' || signature.toString('base64') !== manifest.signature || !crypto.verify(null, Buffer.from(canonical(unsigned)), key, signature)) throw new Error('Manifest signature verification failed');
  if (manifest.runtimeVersion !== runtimeVersion) throw new Error('Electron runtime mismatch; manual installation required');
  return file;
}
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value) || /^[\\/]{2}/.test(value)) throw new Error('Unsafe absolute update path');
  if (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(value) || value.slice(3).split(/[\\/]/).some(p => /[<>:"|?*]/.test(p) || /[. ]$/.test(p)))) throw new Error('Unsafe Windows update path');
  if (path.resolve(value) !== value) throw new Error('Update paths must be normalized');
  return value;
}
function directory(value) {
  absolute(value);
  for (let cursor = value; ; cursor = path.dirname(cursor)) {
    const info = fs.lstatSync(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Update directories must not contain links or junctions');
    if (path.dirname(cursor) === cursor) break;
  }
  return value;
}
function overlaps(a, b) {
  const within = (parent, child) => { const rel = path.relative(parent, child); return !rel || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
  return within(a, b) || within(b, a);
}
function regular(file) {
  absolute(file);
  directory(path.dirname(file));
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Update file must be regular and without links');
  return info;
}
function metadata(file) {
  const info = regular(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== info.ino || opened.dev !== info.dev) throw new Error('Update file changed');
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    for (;;) { const n = fs.readSync(fd, buffer, 0, buffer.length, null); if (!n) break; size += n; hash.update(buffer.subarray(0, n)); }
    const after = regular(file);
    if (after.ino !== opened.ino || after.dev !== opened.dev || after.size !== size || fs.fstatSync(fd).size !== size) throw new Error('Update file changed');
    return { size, sha256: hash.digest('hex') };
  } finally { fs.closeSync(fd); }
}
function verifyFile(file, expected) {
  const actual = metadata(file);
  if (actual.size !== expected.size || actual.sha256 !== expected.sha256.toLowerCase()) throw new Error('Update SHA-256 or size verification failed');
  return actual;
}
function syncFile(file) { const fd = fs.openSync(file, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function syncDirectory(dir) {
  // Windows does not support opening directories with ordinary Node fs.open.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeJson(file, value, exclusive = false) {
  directory(path.dirname(file));
  const text = JSON.stringify(value, null, 2) + '\n';
  if (exclusive) { fs.writeFileSync(file, text, { flag: 'wx', mode: 0o600 }); syncFile(file); }
  else {
    if (fs.existsSync(file)) regular(file);
    const temp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    fs.writeFileSync(temp, text, { flag: 'wx', mode: 0o600 }); syncFile(temp);
    fs.renameSync(temp, file);
  }
  syncDirectory(path.dirname(file));
}
function readJson(file) { if (regular(file).size > 512 * 1024) throw new Error('Update JSON too large'); return JSON.parse(fs.readFileSync(file, 'utf8')); }
function existingRegular(file) { try { regular(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function newer(a, b) { const aa = a.split('.').map(BigInt), bb = b.split('.').map(BigInt); for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i]; return false; }
function validateJob(jobPath, publicKey, { allowCurrentParent = false } = {}) {
  regular(jobPath);
  const job = readJson(jobPath);
  const transactionDir = directory(path.dirname(jobPath));
  const updatesDir = directory(path.dirname(transactionDir));
  if (path.basename(jobPath) !== 'job.json' || !/^transaction-[a-f0-9]{32}$/.test(path.basename(transactionDir)) || path.basename(updatesDir) !== 'updates') throw new Error('Invalid update transaction path');
  if (job.schema !== 1 || job.transactionDir !== transactionDir || job.userDataDir !== path.dirname(updatesDir)) throw new Error('Invalid update job location');
  directory(job.userDataDir); directory(job.installDir);
  if (overlaps(job.userDataDir, job.installDir) || overlaps(fs.realpathSync(job.userDataDir), fs.realpathSync(job.installDir))) throw new Error('Update directories overlap');
  const installation = installationPaths(job.installDir);
  const resources = directory(installation.resourcesDir);
  const id = path.basename(transactionDir).slice('transaction-'.length);
  const derived = { stagePath: path.join(transactionDir, 'app.asar'), backupPath: path.join(transactionDir, 'original.asar'), statePath: path.join(transactionDir, 'state.json'), keyPath: path.join(transactionDir, 'public-key.pem'), targetPath: path.join(resources, 'app.asar'), newPath: path.join(resources, `app.asar.${id}.new`), oldPath: path.join(resources, `app.asar.${id}.old`), executablePath: installation.executablePath };
  for (const [key, value] of Object.entries(derived)) if (job[key] !== value) throw new Error(`Unsafe update ${key}`);
  regular(job.executablePath);
  if (!VERSION.test(job.fromVersion) || !VERSION.test(job.toVersion) || !newer(job.toVersion, job.fromVersion) || job.manifest?.version !== job.toVersion || !Number.isSafeInteger(job.parentPid) || job.parentPid <= 0 || (job.parentPid === process.pid && allowCurrentParent !== true) || !Array.isArray(job.launchArgs) || job.launchArgs.some(a => typeof a !== 'string' || /[\x00\r\n]/.test(a))) throw new Error('Invalid update job');
  regular(job.keyPath);
  job.file = validateManifest(job.manifest, publicKey || fs.readFileSync(job.keyPath, 'utf8'), job.runtimeVersion);
  for (const file of [job.stagePath, job.backupPath, job.targetPath, job.newPath, job.oldPath, job.statePath]) existingRegular(file);
  return job;
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; } }
async function waitForParent(pid, timeoutMs = 120000) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 120000) throw new Error('Invalid parent wait timeout');
  const end = Date.now() + timeoutMs;
  while (alive(pid)) { if (Date.now() >= end) throw new Error('Parent process exit timed out'); await new Promise(resolve => setTimeout(resolve, Math.min(100, end - Date.now()))); }
}
function stateFor(job) {
  const state = readJson(job.statePath);
  if (state.schema !== 1 || typeof state.phase !== 'string' || typeof state.mutationStarted !== 'boolean') throw new Error('Invalid transaction state; manual recovery required');
  return state;
}
function receipt(job, state, phase, extra = {}) {
  Object.assign(state, extra, { phase, updatedAt: new Date().toISOString() });
  writeJson(job.statePath, state);
}
function rollback(job, state, io = fs) {
  if (!state.original || !Number.isSafeInteger(state.original.size) || !/^[a-f0-9]{64}$/.test(state.original.sha256)) throw new Error('Missing original archive receipt; manual recovery required');
  verifyFile(job.backupPath, state.original);
  receipt(job, state, 'rolling-back');
  // The durable transaction backup remains untouched even if recovery itself crashes.
  if (existingRegular(job.newPath)) io.unlinkSync(job.newPath);
  io.copyFileSync(job.backupPath, job.newPath, fs.constants.COPYFILE_EXCL);
  syncFile(job.newPath); verifyFile(job.newPath, state.original);
  // rename replaces the existing destination atomically on Windows and POSIX;
  // do not first remove it, since Electron needs app.asar to boot recovery code.
  io.renameSync(job.newPath, job.targetPath);
  syncDirectory(path.dirname(job.targetPath)); verifyFile(job.targetPath, state.original);
  receipt(job, state, 'rolled-back', { mutationStarted: false, helperPid: null });
}
function launch(job, spawn = childProcess.spawn) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key];
    let child;
    try { child = spawn(job.executablePath, job.launchArgs, { detached: true, shell: false, stdio: 'ignore', env, cwd: job.installDir }); }
    catch (error) { reject(error); return; }
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
async function applyJob(jobPath, { spawn = childProcess.spawn, io = fs, timeoutMs = 120000, publicKey } = {}) {
  assertFileUpgradeSupported();
  const job = validateJob(jobPath, publicKey);
  const state = stateFor(job);
  if (state.phase !== 'prepared' || state.mutationStarted) throw new Error('Transaction already started; recovery required');
  receipt(job, state, 'waiting', { helperPid: process.pid });
  try {
    await waitForParent(job.parentPid, timeoutMs);
    validateJob(jobPath, publicKey);
    verifyFile(job.stagePath, job.file);
    const original = metadata(job.targetPath);
    receipt(job, state, 'backing-up', { original });
    io.copyFileSync(job.targetPath, job.backupPath, fs.constants.COPYFILE_EXCL);
    syncFile(job.backupPath); verifyFile(job.backupPath, original); verifyFile(job.targetPath, original);
    io.copyFileSync(job.stagePath, job.newPath, fs.constants.COPYFILE_EXCL);
    syncFile(job.newPath); verifyFile(job.newPath, job.file);
    if (existingRegular(job.oldPath)) throw new Error('Unexpected swap backup exists');
    // Write intent durably before the first destructive rename.
    receipt(job, state, 'swapping', { mutationStarted: true });
    io.copyFileSync(job.targetPath, job.oldPath, fs.constants.COPYFILE_EXCL);
    syncFile(job.oldPath); verifyFile(job.oldPath, original);
    io.renameSync(job.newPath, job.targetPath);
    syncDirectory(path.dirname(job.targetPath)); verifyFile(job.targetPath, job.file);
    // Publish verified completion before relaunch so the next Electron boot can
    // recover synchronously without racing this helper's spawn notification.
    // A spawn error still enters rollback because mutationStarted remains true.
    receipt(job, state, 'completed', { helperPid: process.pid });
    await launch(job, spawn);
    receipt(job, state, 'completed', { helperPid: null });
    return { phase: state.phase, backupDir: job.backupDir };
  } catch (error) {
    if (state.mutationStarted) {
      try { rollback(job, state, io); }
      catch (rollbackError) { try { receipt(job, state, 'recovery-required', { helperPid: null, error: 'Rollback failed; manual recovery required' }); } catch {} throw new Error('Update failed and rollback requires recovery', { cause: rollbackError }); }
    } else receipt(job, state, 'failed', { helperPid: null, error: 'Update failed before application replacement' });
    throw error;
  }
}
function recoverTransaction(jobPath, publicKey) {
  assertFileUpgradeSupported();
  const job = validateJob(jobPath, publicKey);
  const state = stateFor(job);
  if (state.phase === 'completed') {
    try { verifyFile(job.targetPath, job.file); return { phase: 'completed' }; }
    catch { return { phase: 'completed-stale' }; }
  }
  if (state.phase === 'rolled-back') { verifyFile(job.targetPath, state.original); return { phase: 'rolled-back' }; }
  if (TERMINAL.has(state.phase) && !state.mutationStarted) return { phase: state.phase };
  if (Number.isSafeInteger(state.helperPid) && alive(state.helperPid)) throw new Error('Update helper is still active; recovery refused');
  if (alive(job.parentPid)) throw new Error('Update parent is still active; recovery refused');
  if (!state.mutationStarted) { receipt(job, state, 'cancelled', { helperPid: null }); return { phase: 'cancelled' }; }
  rollback(job, state);
  return { phase: 'rolled-back' };
}
module.exports = { installationPaths, getFileUpgradeCapability, assertFileUpgradeSupported, canonical, validateManifest, absolute, directory, overlaps, regular, metadata, verifyFile, syncFile, writeJson, readJson, newer, validateJob, applyJob, recoverTransaction, waitForParent };
if (require.main === module) {
  if (process.argv.length !== 3) { process.stderr.write('Expected update job path\n'); process.exitCode = 1; }
  else applyJob(process.argv[2]).catch(() => { process.stderr.write('Application update failed; inspect transaction receipt\n'); process.exitCode = 1; });
}
