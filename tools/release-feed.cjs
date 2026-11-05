'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const updater = require('../electron/updater.cjs');

const repositoryRoot = path.resolve(__dirname, '..');

function safeError(message) { return new Error(message); }

function readJson(file, message) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw safeError(message); }
}

function publicKeyFor(options = {}) {
  const configured = options.publicKey === undefined
    ? require('../electron/update-key.cjs')
    : options.publicKey;
  try {
    const key = configured?.type === 'public' ? configured : crypto.createPublicKey(configured);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('type');
    return key;
  } catch {
    throw safeError('Invalid pinned update public key');
  }
}

function privateKeyFor(options = {}) {
  const pem = options.keyPem ?? options.privateKeyPem ?? options.signingKeyPem ?? process.env.QMX_UPDATE_SIGNING_KEY_PEM;
  try {
    let key;
    if (pem !== undefined && pem !== '') key = crypto.createPrivateKey(pem);
    else {
      const keyPath = options.keyPath ?? process.env.QMX_UPDATE_SIGNING_KEY;
      if (!keyPath) throw new Error('missing');
      key = crypto.createPrivateKey(fs.readFileSync(keyPath));
    }
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('type');
    return key;
  } catch {
    throw safeError('Invalid update signing key');
  }
}

function packageInfo(rootDir) {
  const packageJson = readJson(path.join(rootDir, 'package.json'), 'Unable to read package metadata');
  const electronJson = readJson(path.join(rootDir, 'node_modules', 'electron', 'package.json'), 'Unable to read Electron runtime metadata');
  if (typeof packageJson.version !== 'string' || !packageJson.version) throw safeError('Package metadata has no version');
  if (typeof electronJson.version !== 'string' || !electronJson.version) throw safeError('Electron metadata has no version');
  return { version: packageJson.version, runtimeVersion: electronJson.version };
}

/** Check that a CI-provided private PEM corresponds to the pinned public key. */
function verifySigning(options = {}) {
  const privateKey = privateKeyFor(options);
  const publicKey = publicKeyFor(options);
  let derived;
  try { derived = crypto.createPublicKey(privateKey); } catch { throw safeError('Invalid update signing key'); }
  try {
    const challenge = crypto.randomBytes(32);
    const signature = crypto.sign(null, challenge, privateKey);
    if (!crypto.verify(null, challenge, publicKey, signature)) throw new Error('mismatch');
    const left = derived.export({ type: 'spki', format: 'der' });
    const right = publicKey.export({ type: 'spki', format: 'der' });
    if (!left.equals(right)) throw new Error('mismatch');
  } catch (error) {
    if (error?.message === 'mismatch') throw safeError('Signing key does not match pinned application key');
    throw safeError('Signing key verification failed');
  }
  return true;
}

function verifyFeed(root = '.', options = {}) {
  root = path.resolve(root);
  // `rootDir` lets tests and CI point metadata at a source checkout while
  // `root` remains the extracted release artifact being verified.
  const metadataRoot = path.resolve(options.rootDir || root);
  const manifest = readJson(path.join(root, 'feed', 'manifest.json'), 'Unable to read signed update manifest');
  const packageMetadata = options.expectedVersion !== undefined && options.runtimeVersion !== undefined
    ? { version: options.expectedVersion, runtimeVersion: options.runtimeVersion === 'manifest' ? manifest.runtimeVersion : options.runtimeVersion }
    : packageInfo(metadataRoot);
  const metadata = updater.verifyManifest(manifest, {
    publicKey: publicKeyFor(options),
    runtimeVersion: packageMetadata.runtimeVersion,
    ...(options.currentVersion === undefined ? {} : { currentVersion: options.currentVersion })
  });
  if (manifest.version !== packageMetadata.version) throw safeError('Update feed version differs from package version');
  const archive = path.join(root, 'resources', 'app.asar');
  let bytes;
  try { bytes = fs.readFileSync(archive); } catch { throw safeError('Unable to read application archive'); }
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== metadata.size || hash !== metadata.sha256.toLowerCase()) {
    throw safeError('Signed application feed hash mismatch');
  }
  return { manifest, file: metadata, archivePath: archive };
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (command === 'verify-signing') {
    verifySigning();
    console.log('Signing key verified');
    return;
  }
  if (command === 'verify') {
    let root = '.', rootDir, expectedVersion, runtimeVersion;
    for (let index = 1; index < argv.length; index++) {
      if (argv[index] === '--root-dir' && argv[index + 1]) rootDir = argv[++index];
      else if (argv[index] === '--version' && argv[index + 1]) expectedVersion = argv[++index];
      else if (argv[index] === '--runtime-version' && argv[index + 1]) runtimeVersion = argv[++index];
      else if (!argv[index].startsWith('--') && root === '.') root = argv[index];
      else throw safeError('Usage: node tools/release-feed.cjs verify [directory] [--root-dir metadata-directory] [--version x.y.z] [--runtime-version x.y.z|manifest]');
    }
    const result = verifyFeed(root, { rootDir, expectedVersion, runtimeVersion });
    console.log(`Verified update feed ${result.manifest.version}: ${result.file.size} bytes, SHA-256 ${result.file.sha256}`);
    return;
  }
  throw safeError('Usage: node tools/release-feed.cjs verify-signing | verify [directory] [--root-dir metadata-directory]');
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    // Deliberately print only controlled messages. Never expose PEM/OpenSSL text.
    console.error(error.message || 'Release feed verification failed');
    process.exitCode = 1;
  }
}

module.exports = { verifySigning, verifyFeed, main };
