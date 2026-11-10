'use strict';
// Remove only updater-owned artifacts after recovery. Never traverse an unknown tree.
const fs = process.versions.electron ? require('original-fs') : require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const helper = require('./update-helper.cjs');
const USER_FILES = ['local.json', 'settings.json', 'auth.json', 'cache.json', 'platforms.json', 'planner.json'];
const TRANSACTION = /^transaction-[a-f0-9]{32}$/;
function exists(file) { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
function inactive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
}
function removableDirectory(directory, allowed) {
  helper.directory(directory);
  const files = fs.readdirSync(directory);
  for (const name of files) {
    if (!allowed(name)) throw new Error('Unknown update artifact; retained');
    helper.regular(path.join(directory, name));
  }
  return files.map(name => path.join(directory, name));
}
function removeFiles(files, report) {
  for (const file of files) {
    // Check the exact resolved file immediately before removal; no recursive deletion.
    const info = helper.regular(file);
    fs.unlinkSync(file); report.bytes += info.size; report.files++;
  }
}
function cleanTransactions(userDataDir, installDir, publicKey, report, downloads) {
  const updates = path.join(userDataDir, 'updates');
  if (!exists(updates)) return;
  helper.directory(updates);
  const activePath = path.join(updates, 'active.json');
  const active = exists(activePath) ? helper.readJson(activePath) : null;
  // An active pointer is owned by synchronous recovery, never by garbage collection.
  for (const name of fs.readdirSync(updates)) {
    if (!TRANSACTION.test(name) || active?.transaction === name) continue;
    const transaction = path.join(updates, name);
    try {
      const names = new Set(['job.json', 'state.json', 'update-helper.cjs', 'public-key.pem', 'app.asar', 'original.asar']);
      const files = removableDirectory(transaction, name => names.has(name));
      const jobPath = path.join(transaction, 'job.json');
      const job = helper.validateJob(jobPath, publicKey);
      if (job.installDir !== installDir || job.userDataDir !== userDataDir) continue;
      const state = helper.readJson(job.statePath);
      if (!inactive(state.helperPid) || !['completed', 'rolled-back', 'failed', 'cancelled'].includes(state.phase)) continue;
      const result = helper.recoverTransaction(jobPath, publicKey);
      if (!['completed', 'completed-stale', 'rolled-back', 'failed', 'cancelled'].includes(result.phase)) continue;
      const artifacts = [job.newPath, job.oldPath].filter(exists);
      artifacts.forEach(helper.regular);
      removeFiles(artifacts, report);
      // Keep one small receipt until payload removal completes, so interrupted cleanup can retry.
      const receipt = path.join(updates, `${name}-resolved.json`);
      helper.writeJson(receipt, { schema: 1, transaction: name, phase: result.phase, fromVersion: job.fromVersion, toVersion: job.toVersion, cleanedAt: new Date().toISOString() });
      removeFiles(files.filter(file => !['job.json', 'state.json', 'public-key.pem'].includes(path.basename(file))), report);
      removeFiles(files.filter(file => ['job.json', 'state.json', 'public-key.pem'].includes(path.basename(file))), report);
      helper.directory(transaction); fs.rmdirSync(transaction);
    } catch { report.retained++; }
  }
  // Old download directories contain only a payload or partial payload; unrelated files stay.
  // Do not collect downloads while another transaction may still need them.
  if (downloads && !active) for (const name of fs.readdirSync(updates)) {
    if (!/^qmx-update-[A-Za-z0-9]{6}$/.test(name)) continue;
    const directory = path.join(updates, name);
    try {
      const files = removableDirectory(directory, name => ['app.asar', 'app.asar.part', 'patch.qmxdelta', 'patch.qmxdelta.part', '.owner.json'].includes(name));
      const ownerPath = path.join(directory, '.owner.json');
      if (exists(ownerPath)) {
        const owner = helper.readJson(ownerPath);
        if (owner.schema !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !inactive(owner.pid)) continue;
      } else if (Date.now() - fs.lstatSync(directory).mtimeMs < 24 * 60 * 60 * 1000) continue;
      removeFiles(files, report); helper.directory(directory); fs.rmdirSync(directory);
    } catch { report.retained++; }
  }
  const receipts = fs.readdirSync(updates).filter(name => /^transaction-[a-f0-9]{32}-resolved\.json$/.test(name));
  receipts.sort((a, b) => fs.lstatSync(path.join(updates, b)).mtimeMs - fs.lstatSync(path.join(updates, a)).mtimeMs);
  for (const name of receipts.slice(3)) {
    try { removeFiles([path.join(updates, name)], report); } catch { report.retained++; }
  }
}
function cleanBackups(userDataDir, report) {
  const backups = path.join(userDataDir, 'backups');
  if (!exists(backups)) return;
  helper.directory(backups);
  const valid = [];
  for (const name of fs.readdirSync(backups)) {
    if (!/^pre-update-\d{8}T\d{9}Z-[a-f0-9]{16}$/.test(name)) continue;
    const directory = path.join(backups, name);
    try {
      const files = removableDirectory(directory, name => name === 'receipt.json' || USER_FILES.includes(name));
      const receipt = helper.readJson(path.join(directory, 'receipt.json'));
      if (!/^\d+\.\d+\.\d+$/.test(receipt.sourceVersion) || !/^\d+\.\d+\.\d+$/.test(receipt.targetVersion) || !Number.isFinite(Date.parse(receipt.timestamp)) || !receipt.hashes || typeof receipt.hashes !== 'object' || Array.isArray(receipt.hashes)) continue;
      const expected = Object.keys(receipt.hashes);
      if (expected.some(name => !USER_FILES.includes(name)) || files.length !== expected.length + 1) continue;
      for (const filename of expected) {
        const file = path.join(directory, filename);
        if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== receipt.hashes[filename]) throw new Error('Unverified backup retained');
      }
      valid.push({ directory, files, timestamp: Date.parse(receipt.timestamp), name });
    } catch { report.retained++; }
  }
  valid.sort((a, b) => b.timestamp - a.timestamp || b.name.localeCompare(a.name));
  for (const backup of valid.slice(2)) {
    removeFiles(backup.files, report); helper.directory(backup.directory); fs.rmdirSync(backup.directory);
  }
}
function cleanupUpdateStorage(userDataDir, installDir, publicKey, { downloads = true } = {}) {
  const report = { files: 0, bytes: 0, retained: 0 };
  try {
    userDataDir = helper.absolute(userDataDir); installDir = helper.absolute(installDir);
    helper.directory(userDataDir); helper.directory(installDir);
    if (helper.overlaps(userDataDir, installDir)) return report;
    cleanTransactions(userDataDir, installDir, publicKey || require('./update-key.cjs'), report, downloads);
    // Any unresolved pointer protects all user backups until recovery finishes.
    if (!exists(path.join(userDataDir, 'updates', 'active.json'))) cleanBackups(userDataDir, report);
  } catch { report.retained++; }
  return report;
}
module.exports = { cleanupUpdateStorage };
