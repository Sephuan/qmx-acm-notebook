'use strict';

const nativeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { installationPaths } = require('./update-helper.cjs');

const USER_FILES = ['local.json', 'settings.json', 'auth.json', 'cache.json', 'platforms.json', 'planner.json'];
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function absoluteDirectory(value, name) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f]/.test(value) || !path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute directory path`);
  }
  // Device/extended namespaces and UNC shares are not supported installer targets.
  if (/^[\\/]{2}/.test(value) || (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(value))) {
    throw new Error(`${name} must use a normal local absolute path, not a namespace or network path`);
  }
  if (process.platform === 'win32') {
    const components = value.slice(3).split(/[\\/]/).filter(Boolean);
    if (components.some(part => /[<>:"|?*]/.test(part) || (part !== '.' && part !== '..' && /[. ]$/.test(part)))) {
      throw new Error(`${name} contains an invalid Windows path component`);
    }
  }
  return path.resolve(value);
}

function assertPlainDirectory(fs, directory, label) {
  // Checking every ancestor prevents a junction above the leaf from hiding overlap.
  for (let current = directory; ; current = path.dirname(current)) {
    const info = fs.lstatSync(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a directory without symlinks or junctions`);
    if (path.dirname(current) === current) break;
  }
}

function overlaps(a, b) {
  const within = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  return within(a, b) || within(b, a);
}

/**
 * Back up immediately before launching an already verified installer.
 * The caller must spawn that executable directly with shell:false and these native
 * args unchanged. NSIS requires /D= to remain last; never wrap this in cmd.exe.
 * Completed and partial backup directories are intentionally retained.
 */
function prepareUpgrade({ userDataDir, installDir, version, targetVersion } = {}, { fs = nativeFs, platform = process.platform, installer = true } = {}) {
  if (!VERSION.test(version) || !VERSION.test(targetVersion)) throw new Error('Upgrade versions must be stable semantic versions');
  const userPath = absoluteDirectory(userDataDir, 'userDataDir');
  const installPath = absoluteDirectory(installDir, 'installDir');
  if (overlaps(userPath, installPath)) throw new Error('installDir and userDataDir must not overlap');
  assertPlainDirectory(fs, userPath, 'userDataDir');
  assertPlainDirectory(fs, installPath, 'installDir');
  const realUserData = fs.realpathSync(userPath);
  const realInstallDir = fs.realpathSync(installPath);
  if (overlaps(realUserData, realInstallDir)) throw new Error('installDir and userDataDir must not overlap');

  const { executablePath } = installationPaths(realInstallDir, platform);
  const requiredFiles = [executablePath];
  if (platform === 'win32' && installer) requiredFiles.push(path.join(realInstallDir, 'Uninstall QMX-Notebook.exe'));
  for (const filename of requiredFiles) {
    let info;
    try { info = fs.lstatSync(filename); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!info || !info.isFile() || info.isSymbolicLink()) {
      throw new Error(platform === 'win32' && installer
        ? 'Portable upgrades are unsupported. Perform one manual installation of QMX Notebook, then retry; shortcuts are not migrated automatically.'
        : 'Installed QMX-Notebook executable is missing or unsafe; manual installation required.');
    }
  }

  const timestamp = new Date().toISOString();
  const backups = path.join(realUserData, 'backups');
  const backupDir = path.join(backups, `pre-update-${timestamp.replace(/[-:.]/g, '')}-${crypto.randomBytes(8).toString('hex')}`);
  try {
    try { fs.mkdirSync(backups, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    assertPlainDirectory(fs, backups, 'Backup directory');
    fs.mkdirSync(backupDir, { mode: 0o700 });
    const hashes = {};
    const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    for (const filename of USER_FILES) {
      const source = path.join(realUserData, filename);
      let info;
      try { info = fs.lstatSync(source); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('User data must be regular files');
      const expected = digest(source);
      const destination = path.join(backupDir, filename);
      fs.copyFileSync(source, destination, nativeFs.constants.COPYFILE_EXCL);
      if (digest(destination) !== expected || digest(source) !== expected) throw new Error('Backup SHA-256 verification failed');
      hashes[filename] = expected;
    }
    fs.writeFileSync(path.join(backupDir, 'receipt.json'), JSON.stringify({ sourceVersion: version, targetVersion, timestamp, hashes }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch {
    // Never include raw filesystem errors or file contents in UI/log messages.
    throw new Error('Upgrade backup failed; installer must not be launched. Existing data and any backup directory have been retained.');
  }
  return {
    args: platform === 'win32' ? ['/S', '--updated', '--force-run', '--keep-shortcuts', '/currentuser', `/D=${realInstallDir}`] : [],
    backupDir
  };
}

module.exports = { prepareUpgrade };
