'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildManifest } = require('../tools/update-manifest.cjs');
const { verifySigning, verifyFeed } = require('../tools/release-feed.cjs');

const archiveBytes = Buffer.from('independent temporary application archive');

function fixture(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmx-release-feed-test-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(rootDir, 'node_modules', 'electron'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({ version: '8.7.6' }));
  fs.writeFileSync(path.join(rootDir, 'node_modules', 'electron', 'package.json'), JSON.stringify({ version: '40.2.1' }));
  const keys = crypto.generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
  const keyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
  return { rootDir, publicKey, keyPem };
}

function putArchive(rootDir, relative = 'release/QMX-Notebook-win32-x64/resources/app.asar') {
  const archivePath = path.join(rootDir, relative);
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, archiveBytes);
  return archivePath;
}

test('buildManifest signs app bytes using in-memory PEM and root metadata', t => {
  const f = fixture(t);
  const archivePath = putArchive(f.rootDir);
  const manifest = buildManifest({ rootDir: f.rootDir, keyPem: f.keyPem, publicKey: f.publicKey, notes: 'CI fixture' });
  assert.equal(manifest.version, '8.7.6');
  assert.equal(manifest.runtimeVersion, '40.2.1');
  assert.equal(manifest.notes, 'CI fixture');
  assert.equal(manifest.files[0].path, 'resources/app.asar');
  assert.equal(manifest.files[0].size, archiveBytes.length);
  assert.equal(fs.readFileSync(archivePath).toString(), archiveBytes.toString());
  assert.deepEqual(fs.readFileSync(path.join(f.rootDir, 'resources', 'app.asar')), archiveBytes);
  assert.equal(verifyFeed(f.rootDir, { rootDir: f.rootDir, publicKey: f.publicKey }).manifest.signature, manifest.signature);
});

test('buildManifest accepts archivePath and the legacy keyPath without persisting PEM', t => {
  const f = fixture(t);
  const archivePath = putArchive(f.rootDir, 'artifact/custom/app.asar');
  const keyPath = path.join(f.rootDir, 'private.pem');
  fs.writeFileSync(keyPath, f.keyPem);
  const manifest = buildManifest({ rootDir: f.rootDir, archivePath, keyPath, publicKey: f.publicKey });
  assert.equal(manifest.files[0].size, archiveBytes.length);
  assert.deepEqual(fs.readFileSync(path.join(f.rootDir, 'resources', 'app.asar')), archiveBytes);
  assert.deepEqual(fs.readdirSync(f.rootDir).filter(name => name === 'signing-key.pem'), []);
});

test('buildManifest honors QMX_UPDATE_SIGNING_KEY_PEM and gives safe malformed-key errors', t => {
  const f = fixture(t);
  putArchive(f.rootDir);
  const previous = process.env.QMX_UPDATE_SIGNING_KEY_PEM;
  process.env.QMX_UPDATE_SIGNING_KEY_PEM = f.keyPem;
  try {
    assert.equal(buildManifest({ rootDir: f.rootDir, publicKey: f.publicKey }).version, '8.7.6');
    process.env.QMX_UPDATE_SIGNING_KEY_PEM = '-----BEGIN PRIVATE KEY-----SECRET-FIXTURE-CONTENT';
    assert.throws(() => buildManifest({ rootDir: f.rootDir, publicKey: f.publicKey }), error => {
      assert.equal(error.message, 'Invalid update signing key');
      assert.equal(error.message.includes('SECRET-FIXTURE-CONTENT'), false);
      return true;
    });
  } finally {
    if (previous === undefined) delete process.env.QMX_UPDATE_SIGNING_KEY_PEM;
    else process.env.QMX_UPDATE_SIGNING_KEY_PEM = previous;
  }
});

test('verifySigning challenge proves a matching key and rejects malformed or unrelated keys', t => {
  const f = fixture(t);
  assert.equal(verifySigning({ keyPem: f.keyPem, publicKey: f.publicKey }), true);
  const other = crypto.generateKeyPairSync('ed25519');
  assert.throws(() => verifySigning({ keyPem: f.keyPem, publicKey: other.publicKey.export({ type: 'spki', format: 'pem' }) }), /does not match/);
  assert.throws(() => verifySigning({ keyPem: 'private-key-secret-sentinel', publicKey: f.publicKey }), error => {
    assert.equal(error.message, 'Invalid update signing key');
    assert.equal(error.message.includes('private-key-secret-sentinel'), false);
    return true;
  });
});

test('verifyFeed verifies extracted artifacts using source metadata or signed runtime', t => {
  const f = fixture(t);
  putArchive(f.rootDir);
  buildManifest({ rootDir: f.rootDir, keyPem: f.keyPem, publicKey: f.publicKey });
  const extracted = path.join(f.rootDir, 'extracted');
  fs.mkdirSync(extracted);
  for (const name of ['feed', 'resources']) fs.cpSync(path.join(f.rootDir, name), path.join(extracted, name), { recursive: true });
  assert.equal(verifyFeed(extracted, { publicKey: f.publicKey, rootDir: f.rootDir }).manifest.version, '8.7.6');
  assert.equal(verifyFeed(extracted, { publicKey: f.publicKey, expectedVersion: '8.7.6', runtimeVersion: 'manifest' }).manifest.runtimeVersion, '40.2.1');
  assert.throws(() => verifyFeed(extracted, { publicKey: f.publicKey, expectedVersion: '8.7.7', runtimeVersion: 'manifest' }), /version differs/);
  assert.throws(() => verifyFeed(extracted, { publicKey: f.publicKey, expectedVersion: '8.7.6', runtimeVersion: '40.2.0' }), /runtime version mismatch/);
  const manifestPath = path.join(extracted, 'feed', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.runtimeVersion = '40.2.2';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => verifyFeed(extracted, { publicKey: f.publicKey, expectedVersion: '8.7.6', runtimeVersion: 'manifest' }), /signature/);
});

test('verifyFeed checks runtime, package version, signature, and archive hash', t => {
  const f = fixture(t);
  putArchive(f.rootDir);
  buildManifest({ rootDir: f.rootDir, keyPem: f.keyPem, publicKey: f.publicKey });
  assert.equal(verifyFeed(f.rootDir, { publicKey: f.publicKey }).file.size, archiveBytes.length);

  const archive = path.join(f.rootDir, 'resources', 'app.asar');
  fs.writeFileSync(archive, 'tampered bytes');
  assert.throws(() => verifyFeed(f.rootDir, { publicKey: f.publicKey }), /hash mismatch/);
  fs.writeFileSync(archive, archiveBytes);
  const manifestPath = path.join(f.rootDir, 'feed', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.version = '8.7.7';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => verifyFeed(f.rootDir, { publicKey: f.publicKey }), /signature/);

  manifest.version = '8.7.6';
  manifest.runtimeVersion = '40.2.0';
  delete manifest.signature;
  manifest.signature = crypto.sign(null, Buffer.from(require('../tools/update-manifest.cjs').canonical(manifest)), crypto.createPrivateKey(f.keyPem)).toString('base64');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => verifyFeed(f.rootDir, { publicKey: f.publicKey }), /runtime version mismatch/);
});
