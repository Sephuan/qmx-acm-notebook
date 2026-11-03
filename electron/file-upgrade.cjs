'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { prepareUpgrade } = require('./upgrade.cjs');
const helper = require('./update-helper.cjs');

function publicKeyPem() {
  const configured = require('./update-key.cjs');
  const key = configured?.type === 'public' ? configured : crypto.createPublicKey(configured);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Update public key must be Ed25519');
  return key.export({ type: 'spki', format: 'pem' });
}
function updatesDirectory(userDataDir, create = false) {
  helper.directory(userDataDir);
  const updates = path.join(userDataDir, 'updates');
  if (create) { try { fs.mkdirSync(updates, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
  return helper.directory(updates);
}
function recoverFileUpgrade(userDataDir, installDir) {
  userDataDir = helper.absolute(userDataDir);
  installDir = helper.absolute(installDir);
  helper.directory(userDataDir); helper.directory(installDir);
  if (helper.overlaps(userDataDir, installDir)) throw new Error('Install and user data directories overlap');
  let updates;
  try { updates = updatesDirectory(userDataDir); } catch (error) { if (error.code === 'ENOENT') return { phase: 'none' }; throw error; }
  const pointerPath = path.join(updates, 'active.json');
  let pointer;
  try { pointer = helper.readJson(pointerPath); } catch (error) { if (error.code === 'ENOENT') return { phase: 'none' }; throw error; }
  helper.assertFileUpgradeSupported();
  if (pointer.schema !== 1 || typeof pointer.transaction !== 'string' || !/^transaction-[a-f0-9]{32}$/.test(pointer.transaction)) throw new Error('Unsafe update recovery pointer; manual recovery required');
  const jobPath = path.join(updates, pointer.transaction, 'job.json');
  const job = helper.validateJob(jobPath, publicKeyPem());
  if (job.userDataDir !== userDataDir || job.installDir !== installDir) throw new Error('Update recovery install location mismatch');
  return helper.recoverTransaction(jobPath, publicKeyPem());
}

/** Prepare synchronously, then spawn process.execPath with returned args and merged env.
 * Electron's default RunAsNode fuse must remain enabled. Wait for the helper's
 * spawn event before quitting Electron. The external helper waits for this PID.
 */
function prepareFileUpgrade({ userDataDir, installDir, version, targetVersion, ready, runtimeVersion, executablePath, parentPid = process.pid, launchArgs = ['--disable-gpu'] } = {}) {
  helper.assertFileUpgradeSupported();
  userDataDir = helper.absolute(userDataDir);
  installDir = helper.absolute(installDir);
  helper.directory(userDataDir); helper.directory(installDir);
  if (helper.overlaps(userDataDir, installDir)) throw new Error('Install and user data directories overlap');
  const { executablePath: expectedExecutable, resourcesDir } = helper.installationPaths(installDir);
  if (executablePath !== expectedExecutable) throw new Error('File upgrades require the installed application executable');
  helper.regular(executablePath);
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0 || !Array.isArray(launchArgs) || launchArgs.some(arg => typeof arg !== 'string' || /[\x00\r\n]/.test(arg))) throw new Error('Invalid upgrade parent PID or launch arguments');
  if (!ready || ready.version !== targetVersion || ready.manifest?.version !== targetVersion || typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || !helper.newer(targetVersion, version)) throw new Error('Update version mismatch');
  const pem = publicKeyPem();
  const manifest = JSON.parse(JSON.stringify(ready.manifest));
  const file = helper.validateManifest(manifest, pem, runtimeVersion);
  helper.verifyFile(ready.path, file);
  helper.metadata(path.join(resourcesDir, 'app.asar'));
  // Never replace a pointer to an unfinished transaction.
  recoverFileUpgrade(userDataDir, installDir);
  const { backupDir } = prepareUpgrade({ userDataDir, installDir, version, targetVersion });
  const updates = updatesDirectory(userDataDir, true);
  const id = crypto.randomBytes(16).toString('hex');
  const transactionDir = path.join(updates, `transaction-${id}`);
  fs.mkdirSync(transactionDir, { mode: 0o700 });
  helper.directory(transactionDir);
  const stagePath = path.join(transactionDir, 'app.asar');
  const helperPath = path.join(transactionDir, 'update-helper.cjs');
  const keyPath = path.join(transactionDir, 'public-key.pem');
  const jobPath = path.join(transactionDir, 'job.json');
  // __dirname may be inside Electron's virtual app.asar; copyFileSync cannot
  // reliably copy virtual ASAR entries, but readFileSync transparently reads them.
  const helperSource = fs.readFileSync(path.join(__dirname, 'update-helper.cjs'));
  fs.writeFileSync(helperPath, helperSource, { flag: 'wx', mode: 0o600 });
  helper.syncFile(helperPath);
  if (!fs.readFileSync(helperPath).equals(helperSource)) throw new Error('Update helper copy verification failed');
  fs.writeFileSync(keyPath, pem, { flag: 'wx', mode: 0o600 }); helper.syncFile(keyPath);
  const archiveFs = process.versions.electron ? require('original-fs') : fs;
  archiveFs.copyFileSync(ready.path, stagePath, fs.constants.COPYFILE_EXCL); helper.syncFile(stagePath);
  helper.verifyFile(stagePath, file); helper.verifyFile(ready.path, file);
  const job = {
    schema: 1, transactionDir, userDataDir, installDir, executablePath, parentPid,
    fromVersion: version, toVersion: targetVersion, runtimeVersion, manifest,
    launchArgs: launchArgs.slice(), backupDir, stagePath, keyPath,
    backupPath: path.join(transactionDir, 'original.asar'),
    statePath: path.join(transactionDir, 'state.json'),
    targetPath: path.join(resourcesDir, 'app.asar'),
    newPath: path.join(resourcesDir, `app.asar.${id}.new`),
    oldPath: path.join(resourcesDir, `app.asar.${id}.old`)
  };
  helper.writeJson(jobPath, job, true);
  helper.writeJson(job.statePath, { schema: 1, phase: 'prepared', mutationStarted: false, helperPid: null, updatedAt: new Date().toISOString() }, true);
  // Pointer is published last, after all inputs and state have reached disk.
  helper.writeJson(path.join(updates, 'active.json'), { schema: 1, transaction: path.basename(transactionDir) });
  return { args: [helperPath, jobPath], env: { ELECTRON_RUN_AS_NODE: '1' }, backupDir };
}
module.exports = { prepareFileUpgrade, recoverFileUpgrade, getFileUpgradeCapability: helper.getFileUpgradeCapability };
