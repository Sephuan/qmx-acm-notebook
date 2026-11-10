'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const updater = require('../electron/updater.cjs');
const { canonical } = require('./update-manifest.cjs');
// release-feed also calls our optional verifier; load its API only on demand.
const verifyFeed = (...args) => require('./release-feed.cjs').verifyFeed(...args);
const MAX_FILE = 256 * 1024 * 1024;
const repositoryRoot = path.resolve(__dirname, '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function readJson(file) {
  const bytes = readFile(file, 256 * 1024);
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('Invalid release metadata JSON'); }
}

function readFile(file, max = MAX_FILE) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { throw new Error('Unable to read release artifact'); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > max) throw new Error('Invalid release artifact size or file type');
  return fs.readFileSync(file);
}

// Reject symlink parents as well as final symlinks before reading/writing owned paths.
function ownedPath(root, relative) {
  root = path.resolve(root);
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(root + path.sep)) throw new Error('Unsafe release artifact path');
  let current = root;
  for (const part of [null, ...path.relative(root, resolved).split(path.sep)]) {
    if (part !== null) current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Unsafe release artifact symlink');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return resolved;
}

function publicKeyFor(options) {
  const configured = options.publicKey === undefined ? require('../electron/update-key.cjs') : options.publicKey;
  try {
    const key = configured?.type === 'public' ? configured : crypto.createPublicKey(configured);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error();
    return key;
  } catch { throw new Error('Invalid pinned update public key'); }
}

function signingKey(options) {
  require('./release-feed.cjs').verifySigning(options);
  try {
    const pem = options.keyPem ?? options.privateKeyPem ?? options.signingKeyPem ?? process.env.QMX_UPDATE_SIGNING_KEY_PEM;
    return pem !== undefined && pem !== '' ? crypto.createPrivateKey(pem)
      : crypto.createPrivateKey(fs.readFileSync(options.keyPath ?? process.env.QMX_UPDATE_SIGNING_KEY));
  } catch { throw new Error('Invalid update signing key'); }
}

function verifyDeltaFeed(root, { publicKey, manifest, file } = {}) {
  const deltaPath = ownedPath(root, 'feed/delta.json');
  if (!fs.existsSync(deltaPath)) return null;
  const delta = readJson(deltaPath);
  const patches = require('../electron/delta-manifest.cjs').verifyDeltaManifest(delta, {
    publicKey, runtimeVersion: manifest.runtimeVersion, targetVersion: manifest.version, targetFile: file
  });
  for (const patch of patches) {
    const bytes = readFile(ownedPath(root, patch.path));
    if (bytes.length !== patch.size || hash(bytes) !== patch.sha256.toLowerCase()) throw new Error('Signed delta patch hash mismatch');
  }
  return { manifest: delta, patches };
}

function buildDeltaFeed(options = {}) {
  const root = path.resolve(options.rootDir || repositoryRoot);
  const bases = options.bases || [];
  if (!Array.isArray(bases) || bases.length > 2) throw new Error('At most two explicit delta bases are allowed');
  const key = signingKey(options);
  const publicKey = publicKeyFor(options);
  const target = verifyFeed(root, { ...options, verifyDelta: false });
  const targetBytes = readFile(ownedPath(root, 'resources/app.asar'));
  const { createDelta, applyDelta } = require('../electron/delta-codec.cjs');
  const patches = [], outputs = [], seen = new Set();
  for (const base of bases) {
    if (!base || typeof base.archivePath !== 'string' || typeof base.manifestPath !== 'string') throw new Error('Each delta base requires explicit archive and signed manifest paths');
    const manifest = readJson(path.resolve(base.manifestPath));
    const file = updater.verifyManifest(manifest, { publicKey, runtimeVersion: manifest.runtimeVersion });
    updater.verifyManifest(target.manifest, { publicKey, runtimeVersion: target.manifest.runtimeVersion, currentVersion: manifest.version });
    const bytes = readFile(path.resolve(base.archivePath));
    if (bytes.length !== file.size || hash(bytes) !== file.sha256.toLowerCase()) throw new Error('Signed delta base hash mismatch');
    if (manifest.runtimeVersion !== target.manifest.runtimeVersion) continue;
    if (seen.has(file.sha256.toLowerCase())) throw new Error('Duplicate delta base');
    seen.add(file.sha256.toLowerCase());
    const patch = createDelta(bytes, targetBytes);
    if (!Buffer.isBuffer(patch) || patch.length <= 0 || patch.length > MAX_FILE) throw new Error('Invalid generated delta patch');
    if (patch.length >= targetBytes.length * 0.9) continue;
    if (!applyDelta(bytes, patch, targetBytes.length).equals(targetBytes)) throw new Error('Generated delta does not reconstruct target');
    const relative = `resources/deltas/${file.sha256.toLowerCase()}.qmxdelta`;
    patches.push({ fromVersion: manifest.version, fromSize: bytes.length, fromSha256: file.sha256.toLowerCase(), path: relative,
      size: patch.length, sha256: hash(patch), algorithm: 'qmx-cdc-brotli-v1' });
    outputs.push({ relative, bytes: patch });
  }
  const delta = { schema: 1, version: target.manifest.version, runtimeVersion: target.manifest.runtimeVersion,
    target: { size: targetBytes.length, sha256: hash(targetBytes) }, patches, publishedAt: new Date().toISOString() };
  delta.signature = crypto.sign(null, Buffer.from(canonical(delta)), key).toString('base64');
  require('../electron/delta-manifest.cjs').verifyDeltaManifest(delta, {
    publicKey, runtimeVersion: target.manifest.runtimeVersion, targetVersion: target.manifest.version, targetFile: target.file
  });
  // Validate every input and output before replacing any existing metadata.
  const deltaPath = ownedPath(root, 'feed/delta.json');
  for (const output of outputs) ownedPath(root, output.relative);
  for (const output of outputs) {
    const destination = ownedPath(root, output.relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, output.bytes);
  }
  fs.mkdirSync(path.dirname(deltaPath), { recursive: true });
  fs.writeFileSync(deltaPath, JSON.stringify(delta, null, 2) + '\n');
  return delta;
}

function releaseOptions(options) {
  if (!options.expectedVersion) throw new Error('Explicit release version required');
  return { ...options, runtimeVersion: options.runtimeVersion || 'manifest' };
}

function listAssets(root, options = {}) {
  const verified = verifyFeed(root, { ...releaseOptions(options), verifyDelta: false });
  const delta = verifyDeltaFeedMetadata(root, verified, options);
  return delta ? delta.patches.map(patch => `update-delta-${patch.fromSha256}.qmxdelta`) : [];
}

// Used before downloading patches: metadata is authenticated before it can name assets.
function verifyDeltaFeedMetadata(root, verified, options) {
  const file = ownedPath(root, 'feed/delta.json');
  if (!fs.existsSync(file)) return null;
  const manifest = readJson(file);
  const patches = require('../electron/delta-manifest.cjs').verifyDeltaManifest(manifest, {
    publicKey: publicKeyFor(options), runtimeVersion: verified.manifest.runtimeVersion,
    targetVersion: verified.manifest.version, targetFile: verified.file
  });
  return { manifest, patches };
}

function installFeed(incoming, options = {}) {
  const root = path.resolve(options.rootDir || repositoryRoot);
  incoming = path.resolve(incoming);
  if (root === incoming) throw new Error('Incoming and installed feed directories must differ');
  const verified = verifyFeed(incoming, releaseOptions(options));
  const next = verifyDeltaFeedMetadata(incoming, verified, options);
  let old = null;
  if (fs.existsSync(ownedPath(root, 'feed/delta.json'))) {
    const oldManifest = readJson(ownedPath(root, 'feed/manifest.json'));
    const oldFile = updater.verifyManifest(oldManifest, { publicKey: publicKeyFor(options), runtimeVersion: oldManifest.runtimeVersion });
    old = verifyDeltaFeedMetadata(root, { manifest: oldManifest, file: oldFile }, options);
  }
  const copies = ['resources/app.asar', ...(next ? next.patches.map(patch => patch.path) : []), 'feed/manifest.json', ...(next ? ['feed/delta.json'] : [])];
  const keep = new Set(next ? next.patches.map(patch => patch.path) : []);
  const removals = old ? old.patches.map(patch => patch.path).filter(file => !keep.has(file)) : [];
  if (!next && old) removals.push('feed/delta.json');
  // Only paths authenticated by the old manifest may be pruned. Unknown files stay.
  for (const relative of [...copies, ...removals]) ownedPath(root, relative);
  for (const relative of copies) {
    const destination = ownedPath(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(ownedPath(incoming, relative), destination);
  }
  for (const relative of removals) fs.rmSync(ownedPath(root, relative), { force: true });
  return { manifest: verified.manifest, patches: next?.patches || [], removed: removals };
}

function main(argv = process.argv.slice(2)) {
  const command = argv.shift(), options = {}, bases = [];
  let directory;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index], value = argv[index + 1];
    if (['--root-dir', '--version', '--base', '--base-manifest'].includes(flag) && value && !value.startsWith('--')) {
      index++;
      if (flag === '--root-dir') options.rootDir = value;
      else if (flag === '--version') options.expectedVersion = value;
      else if (flag === '--base') bases.push({ archivePath: value });
      else {
        if (!bases.length || bases.at(-1).manifestPath) throw new Error('--base-manifest must follow its --base');
        bases.at(-1).manifestPath = value;
      }
    } else if (!flag.startsWith('--') && directory === undefined) directory = flag;
    else throw new Error('Invalid delta-feed arguments');
  }
  if (command === 'build' && directory === undefined) {
    const result = buildDeltaFeed({ ...options, bases });
    console.log(`Signed delta feed ${result.version}: ${result.patches.length} patches`);
  } else if (command === 'list-assets' && directory && !bases.length) {
    for (const asset of listAssets(directory, options)) console.log(asset);
  } else if (command === 'install' && directory && !bases.length) {
    const result = installFeed(directory, options);
    console.log(`Installed verified update feed ${result.manifest.version}: ${result.patches.length} patches; removed ${result.removed.length} superseded files`);
  } else throw new Error('Usage: node tools/delta-feed.cjs build [--root-dir directory] [--base archive --base-manifest manifest] (max 2) | list-assets directory --version x.y.z | install directory --root-dir destination --version x.y.z');
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(error.message || 'Delta release operation failed'); process.exitCode = 1; }
}
module.exports = { buildDeltaFeed, verifyDeltaFeed, listAssets, installFeed, main };
