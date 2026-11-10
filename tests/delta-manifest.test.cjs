'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyDeltaManifest } = require('../electron/delta-manifest.cjs');

const trusted = crypto.generateKeyPairSync('ed25519');
const untrusted = crypto.generateKeyPairSync('ed25519');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const targetFile = { path: 'resources/app.asar', size: 10000, sha256: hash('target') };
const options = { publicKey: trusted.publicKey, runtimeVersion: '42.0.0', targetVersion: '2.0.0', targetFile };

// Deliberately independent of the production canonical serializer and signer.
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function sign(manifest, privateKey = trusted.privateKey) {
  const unsigned = structuredClone(manifest);
  delete unsigned.signature;
  return { ...unsigned, signature: crypto.sign(null, Buffer.from(canonical(unsigned)), privateKey).toString('base64') };
}
function patch(fromVersion = '1.0.0', fromSha256 = hash('base')) {
  return { fromVersion, fromSize: 9000, fromSha256, path: `resources/deltas/${fromSha256}.qmxdelta`, size: 1000, sha256: hash('patch'), algorithm: 'qmx-cdc-brotli-v1' };
}
function fixture() {
  return sign({ schema: 1, version: '2.0.0', runtimeVersion: '42.0.0', target: { size: targetFile.size, sha256: targetFile.sha256 }, patches: [patch()], publishedAt: '2026-01-01T00:00:00Z' });
}

test('delta manifest accepts independently signed Ed25519 metadata and returns its authenticated patch list', () => {
  const manifest = fixture();
  const before = structuredClone(manifest);
  assert.deepEqual(verifyDeltaManifest(manifest, options), manifest.patches);
  assert.deepEqual(manifest, before);
  const pem = trusted.publicKey.export({ type: 'spki', format: 'pem' });
  assert.deepEqual(verifyDeltaManifest(manifest, { ...options, publicKey: pem }), manifest.patches);
});

test('delta manifest permits zero, one, or two unique older bases and compares versions numerically', () => {
  for (const patches of [[], [patch('1.10.0')], [patch('1.9.0'), patch('1.10.0', hash('other base'))]]) {
    assert.deepEqual(verifyDeltaManifest(sign({ ...fixture(), patches }), options), patches);
  }
  const huge = '999999999999999999999999999999.0.0';
  const manifest = sign({ ...fixture(), version: huge, patches: [patch('999999999999999999999999999998.999.999')] });
  assert.equal(verifyDeltaManifest(manifest, { ...options, targetVersion: huge }).length, 1);
});

test('delta manifest rejects unauthenticated changes, untrusted keys, and noncanonical signatures', () => {
  const changed = fixture();
  changed.patches[0].size++;
  assert.throws(() => verifyDeltaManifest(changed, options));
  assert.throws(() => verifyDeltaManifest(sign(fixture(), untrusted.privateKey), options));
  assert.throws(() => verifyDeltaManifest(fixture(), { ...options, publicKey: untrusted.publicKey }));
  for (const signature of ['', 'A'.repeat(86) + '==', fixture().signature.replace(/==$/, ''), ' ' + fixture().signature]) {
    assert.throws(() => verifyDeltaManifest({ ...fixture(), signature }, options));
  }
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => verifyDeltaManifest(fixture(), { ...options, publicKey: rsa.publicKey }));
});

test('delta metadata must agree with the separately signed legacy target and installed runtime', () => {
  for (const overrides of [
    { runtimeVersion: '41.0.0' }, { targetVersion: '2.0.1' },
    { targetFile: { ...targetFile, size: targetFile.size + 1 } },
    { targetFile: { ...targetFile, sha256: hash('other target') } },
    { targetFile: undefined },
  ]) assert.throws(() => verifyDeltaManifest(fixture(), { ...options, ...overrides }));
});

const invalidCases = [
  ['unknown top-level field', m => { m.url = 'https://attacker.invalid/'; }],
  ['missing top-level field', m => { delete m.publishedAt; }],
  ['unsupported schema', m => { m.schema = 2; }],
  ['invalid publication date', m => { m.publishedAt = 'not-a-date'; }],
  ['unknown target field', m => { m.target.path = 'resources/app.asar'; }],
  ['unknown patch field', m => { m.patches[0].url = 'https://attacker.invalid/patch'; }],
  ['missing patch field', m => { delete m.patches[0].algorithm; }],
  ['unsupported algorithm', m => { m.patches[0].algorithm = 'bsdiff'; }],
  ['three patches', m => { m.patches = [patch(), patch('1.1.0', hash('b')), patch('1.2.0', hash('c'))]; }],
  ['duplicate base digest', m => { m.patches.push(patch('1.1.0')); }],
  ['patch list is not an array', m => { m.patches = {}; }],
  ['same version base', m => { m.patches[0].fromVersion = '2.0.0'; }],
  ['newer version base', m => { m.patches[0].fromVersion = '2.0.1'; }],
  ['prerelease base', m => { m.patches[0].fromVersion = '1.0.0-beta'; }],
  ['leading-zero base version', m => { m.patches[0].fromVersion = '01.0.0'; }],
  ['uppercase base hash', m => { m.patches[0].fromSha256 = m.patches[0].fromSha256.toUpperCase(); }],
  ['invalid patch hash', m => { m.patches[0].sha256 = '0'.repeat(63); }],
  ['absolute patch URL', m => { m.patches[0].path = 'https://attacker.invalid/patch'; }],
  ['path traversal', m => { m.patches[0].path = 'resources/deltas/../../app.asar'; }],
  ['backslash path', m => { m.patches[0].path = m.patches[0].path.replaceAll('/', '\\'); }],
  ['mismatched path digest', m => { m.patches[0].path = `resources/deltas/${hash('other')}.qmxdelta`; }],
  ['query in patch path', m => { m.patches[0].path += '?raw=1'; }],
  ['patch at exactly ninety percent', m => { m.patches[0].size = 9000; }],
  ['patch larger than ninety percent', m => { m.patches[0].size = 9001; }],
];
for (const field of ['size', 'fromSize']) {
  for (const value of [0, -1, 1.5, '100', Number.MAX_SAFE_INTEGER, 256 * 1024 * 1024 + 1]) {
    invalidCases.push([`invalid patch ${field}: ${value}`, m => { m.patches[0][field] = value; }]);
  }
}
for (const [name, mutate] of invalidCases) {
  test(`delta manifest rejects correctly signed but invalid metadata: ${name}`, () => {
    const manifest = fixture();
    mutate(manifest);
    assert.throws(() => verifyDeltaManifest(sign(manifest), options));
  });
}

test('delta patch size must be strictly below ninety percent of the full target', () => {
  const manifest = fixture();
  manifest.patches[0].size = 8999;
  assert.equal(verifyDeltaManifest(sign(manifest), options)[0].size, 8999);
});
