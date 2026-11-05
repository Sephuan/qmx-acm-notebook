'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const repositoryRoot = path.resolve(__dirname, '..');

// The updater and the release tools sign the same recursive, sorted JSON form.
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function safeKeyError(message) {
  // Do not attach OpenSSL errors: depending on the provider they can contain
  // portions of a malformed PEM (and a CI log must never contain key material).
  return new Error(message);
}

function publicKeyFor(options) {
  const configured = options.publicKey === undefined
    ? require('../electron/update-key.cjs')
    : options.publicKey;
  try {
    const key = configured?.type === 'public' ? configured : crypto.createPublicKey(configured);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('type');
    return key;
  } catch {
    throw safeKeyError('Invalid pinned update public key');
  }
}

function privateKeyFor(options) {
  // PEM is deliberately accepted as a value. It is never written to disk.
  const pem = options.keyPem ?? options.privateKeyPem ?? options.signingKeyPem ?? process.env.QMX_UPDATE_SIGNING_KEY_PEM;
  let key;
  try {
    if (pem !== undefined && pem !== '') key = crypto.createPrivateKey(pem);
    else {
      const keyPath = options.keyPath ?? process.env.QMX_UPDATE_SIGNING_KEY;
      if (!keyPath) throw new Error('missing');
      let keyBytes;
      try { keyBytes = fs.readFileSync(keyPath); } catch { throw new Error('read'); }
      key = crypto.createPrivateKey(keyBytes);
    }
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('type');
    return key;
  } catch {
    throw safeKeyError('Invalid update signing key');
  }
}

function samePublicKey(left, right) {
  try {
    return left.export({ type: 'spki', format: 'der' }).equals(right.export({ type: 'spki', format: 'der' }));
  } catch {
    return false;
  }
}

function readJson(file, message) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error(message); }
}

function packageInfo(rootDir) {
  const pkg = readJson(path.join(rootDir, 'package.json'), 'Unable to read package metadata');
  if (typeof pkg.version !== 'string' || !pkg.version) throw new Error('Package metadata has no version');
  const electronPackage = path.join(rootDir, 'node_modules', 'electron', 'package.json');
  const electron = readJson(electronPackage, 'Unable to read Electron runtime metadata');
  if (typeof electron.version !== 'string' || !electron.version) throw new Error('Electron metadata has no version');
  return { packageVersion: pkg.version, runtimeVersion: electron.version };
}

function buildManifest({
  rootDir = repositoryRoot,
  archivePath,
  keyPem,
  privateKeyPem,
  signingKeyPem,
  keyPath,
  publicKey,
  notes = process.env.QMX_UPDATE_NOTES || ''
} = {}) {
  rootDir = path.resolve(rootDir);
  const archive = path.resolve(rootDir, archivePath || path.join('release', 'QMX-Notebook-win32-x64', 'resources', 'app.asar'));
  const privateKey = privateKeyFor({ keyPem, privateKeyPem, signingKeyPem, keyPath });
  const pinned = publicKeyFor({ publicKey });
  if (!samePublicKey(crypto.createPublicKey(privateKey), pinned)) {
    throw new Error('Signing key does not match pinned application key');
  }
  const { packageVersion, runtimeVersion } = packageInfo(rootDir);
  let bytes;
  try { bytes = fs.readFileSync(archive); } catch { throw new Error('Unable to read application archive'); }
  const manifest = {
    schema: 1,
    version: packageVersion,
    runtimeVersion,
    base: '../',
    notes,
    publishedAt: new Date().toISOString(),
    files: [{
      path: 'resources/app.asar',
      size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex')
    }]
  };
  manifest.signature = crypto.sign(null, Buffer.from(canonical(manifest)), privateKey).toString('base64');
  const feed = path.join(rootDir, 'feed');
  fs.mkdirSync(feed, { recursive: true });
  fs.mkdirSync(path.join(rootDir, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'resources', 'app.asar'), bytes);
  fs.writeFileSync(path.join(feed, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Signed update feed ${manifest.version}: ${bytes.length} bytes, SHA-256 ${manifest.files[0].sha256}`);
  return manifest;
}

function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--root-dir' && argv[index + 1]) options.rootDir = argv[++index];
    else if (argv[index] === '--notes' && argv[index + 1]) options.notes = argv[++index];
    else throw new Error('Usage: node tools/update-manifest.cjs [--root-dir directory] [--notes text]');
  }
  return buildManifest(options);
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(error.message || 'Unable to build update manifest'); process.exitCode = 1; }
}

module.exports = { buildManifest, canonical };
