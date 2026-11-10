'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildManifest, canonical } = require('../tools/update-manifest.cjs');
const { verifyFeed } = require('../tools/release-feed.cjs');
const { buildDeltaFeed, listAssets, installFeed, main } = require('../tools/delta-feed.cjs');
const { applyDelta } = require('../electron/delta-codec.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qmx-delta-feed-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const keys = crypto.generateKeyPairSync('ed25519');
  const keyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
  function feed(name, version, bytes, runtimeVersion = '40.2.1') {
    const rootDir = path.join(directory, name);
    fs.mkdirSync(path.join(rootDir, 'node_modules/electron'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({ version }));
    fs.writeFileSync(path.join(rootDir, 'node_modules/electron/package.json'), JSON.stringify({ version: runtimeVersion }));
    const archivePath = path.join(rootDir, 'input.asar');
    fs.writeFileSync(archivePath, bytes);
    buildManifest({ rootDir, archivePath, keyPem, publicKey });
    return rootDir;
  }
  const baseBytes = crypto.randomBytes(512 * 1024);
  const targetBytes = Buffer.concat([baseBytes.subarray(0, 200000), Buffer.from('inserted application change'), baseBytes.subarray(200000)]);
  const base = feed('base', '1.0.0', baseBytes);
  const target = feed('target', '1.1.0', targetBytes);
  const baseInput = root => ({ archivePath: path.join(root, 'resources/app.asar'), manifestPath: path.join(root, 'feed/manifest.json') });
  const options = { rootDir: target, keyPem, publicKey, bases: [baseInput(base)] };
  const deltaPath = path.join(target, 'feed/delta.json');
  const delta = () => JSON.parse(fs.readFileSync(deltaPath, 'utf8'));
  function changeDelta(fn, resign = false) {
    const value = delta();
    delete value.signature;
    fn(value);
    value.signature = resign ? crypto.sign(null, Buffer.from(canonical(value)), keys.privateKey).toString('base64') : 'A'.repeat(86) + '==';
    fs.writeFileSync(deltaPath, JSON.stringify(value));
  }
  return { directory, keyPem, publicKey, keys, feed, base, target, baseBytes, targetBytes, baseInput, options, deltaPath, delta, changeDelta };
}

const verify = f => verifyFeed(f.target, { publicKey: f.publicKey });

test('delta feed binds signed base and target and reconstructs insertion changes without changing legacy schema', t => {
  const f = fixture(t);
  const original = fs.readFileSync(path.join(f.target, 'feed/manifest.json'));
  const manifest = buildDeltaFeed(f.options);
  assert.equal(manifest.patches.length, 1);
  assert.equal(manifest.patches[0].fromVersion, '1.0.0');
  assert.equal(manifest.patches[0].algorithm, 'qmx-cdc-brotli-v1');
  assert.ok(manifest.patches[0].size < f.targetBytes.length * 0.9);
  const patch = fs.readFileSync(path.join(f.target, manifest.patches[0].path));
  assert.deepEqual(applyDelta(f.baseBytes, patch, f.targetBytes.length), f.targetBytes);
  assert.deepEqual(fs.readFileSync(path.join(f.target, 'feed/manifest.json')), original);
  assert.equal(verify(f).delta.patches.length, 1);
  assert.deepEqual(listAssets(f.target, { expectedVersion: '1.1.0', publicKey: f.publicKey }), [`update-delta-${manifest.patches[0].fromSha256}.qmxdelta`]);
});

test('CLI build, release verification and asset listing work in fresh processes', t => {
  const f = fixture(t);
  const preload = path.join(f.directory, 'fixture-public-key.cjs');
  const pinned = require.resolve('../electron/update-key.cjs');
  fs.writeFileSync(preload, `require.cache[${JSON.stringify(pinned)}] = { exports: ${JSON.stringify(f.publicKey)} };`);
  const root = path.resolve(__dirname, '..');
  const { spawnSync } = require('node:child_process');
  const run = (tool, args) => {
    const logPath = path.join(f.directory, 'cli.log');
    const fd = fs.openSync(logPath, 'w');
    let result;
    try {
      result = spawnSync(process.execPath, ['--require', preload, path.join(root, 'tools', tool), ...args], {
        cwd: root, env: { ...process.env, QMX_UPDATE_SIGNING_KEY_PEM: f.keyPem }, stdio: ['ignore', fd, fd]
      });
    } finally { fs.closeSync(fd); }
    const output = fs.readFileSync(logPath, 'utf8');
    assert.equal(result.status, 0, output);
    assert.doesNotMatch(output, /circular dependency|Warning:|PRIVATE KEY/);
    return output;
  };
  assert.match(run('delta-feed.cjs', ['build', '--root-dir', f.target, '--base', f.baseInput(f.base).archivePath,
    '--base-manifest', f.baseInput(f.base).manifestPath]), /Signed delta feed 1\.1\.0: 1 patches/);
  assert.match(run('release-feed.cjs', ['verify', f.target]), /Verified update feed 1\.1\.0/);
  assert.match(run('delta-feed.cjs', ['list-assets', f.target, '--version', '1.1.0']), /^update-delta-[a-f0-9]{64}\.qmxdelta\s*$/);
});

test('unsigned or mismatched bases and signing keys fail before writing delta metadata', t => {
  const f = fixture(t);
  const baseManifestPath = f.baseInput(f.base).manifestPath;
  const original = fs.readFileSync(baseManifestPath);
  const manifest = JSON.parse(original);
  manifest.version = '0.9.0';
  fs.writeFileSync(baseManifestPath, JSON.stringify(manifest));
  assert.throws(() => buildDeltaFeed(f.options), /signature/);
  fs.writeFileSync(baseManifestPath, original);
  fs.writeFileSync(f.baseInput(f.base).archivePath, 'tampered base bytes');
  assert.throws(() => buildDeltaFeed(f.options), /base hash mismatch/);
  const unrelated = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.throws(() => buildDeltaFeed({ ...f.options, keyPem: unrelated }), /does not match/);
  assert.throws(() => buildDeltaFeed({ ...f.options, keyPem: 'SECRET-SENTINEL' }), error => {
    assert.equal(error.message, 'Invalid update signing key');
    assert.ok(!error.message.includes('SECRET-SENTINEL'));
    return true;
  });
  assert.equal(fs.existsSync(f.deltaPath), false);
});

test('unhelpful patches and signed runtime changes produce valid full-download fallback metadata', t => {
  const f = fixture(t);
  const unrelated = f.feed('unrelated', '1.0.0', crypto.randomBytes(f.targetBytes.length));
  const noSavings = buildDeltaFeed({ ...f.options, bases: [f.baseInput(unrelated)] });
  assert.deepEqual(noSavings.patches, []);
  assert.deepEqual(verify(f).delta.patches, []);
  const oldRuntime = f.feed('old-runtime', '1.0.0', f.baseBytes, '39.0.0');
  const noRuntime = buildDeltaFeed({ ...f.options, bases: [f.baseInput(oldRuntime)] });
  assert.deepEqual(noRuntime.patches, []);
});

test('two explicit authenticated bases are accepted; duplicate, excessive and missing inputs are rejected', t => {
  const f = fixture(t);
  const second = f.feed('second', '1.0.1', Buffer.concat([f.baseBytes, Buffer.from('base addition')]));
  const bases = [f.baseInput(f.base), f.baseInput(second)];
  assert.equal(buildDeltaFeed({ ...f.options, bases }).patches.length, 2);
  assert.throws(() => buildDeltaFeed({ ...f.options, bases: [bases[0], bases[0]] }), /Duplicate/);
  assert.throws(() => buildDeltaFeed({ ...f.options, bases: [...bases, bases[0]] }), /At most two/);
  assert.throws(() => buildDeltaFeed({ ...f.options, bases: [{ archivePath: f.baseInput(f.base).archivePath }] }), /explicit archive and signed manifest/);
  assert.throws(() => main(['build', '--base-manifest', 'unpaired.json']), /must follow/);
});

test('optional delta verification rejects metadata, patch, target and pinned-key tampering', t => {
  const f = fixture(t);
  buildDeltaFeed(f.options);
  const original = fs.readFileSync(f.deltaPath);
  f.changeDelta(m => { m.publishedAt = '2025-01-01T00:00:00.000Z'; });
  assert.throws(() => verify(f), /signature/);
  fs.writeFileSync(f.deltaPath, original);
  const patchPath = path.join(f.target, f.delta().patches[0].path);
  const patch = fs.readFileSync(patchPath);
  const tampered = Buffer.from(patch); tampered[0] ^= 1;
  fs.writeFileSync(patchPath, tampered);
  assert.throws(() => verify(f), /patch hash mismatch/);
  fs.writeFileSync(patchPath, patch);
  f.changeDelta(m => { m.target.sha256 = 'f'.repeat(64); }, true);
  assert.throws(() => verify(f), /target differs/);
  fs.writeFileSync(f.deltaPath, original);
  const other = crypto.generateKeyPairSync('ed25519').publicKey;
  assert.throws(() => verifyFeed(f.target, { publicKey: other }), /signature/);
  fs.rmSync(f.deltaPath);
  assert.equal(verify(f).delta, null);
});

test('even signed malicious paths, unknown keys and algorithms cannot name download assets', t => {
  const f = fixture(t);
  buildDeltaFeed(f.options);
  const original = fs.readFileSync(f.deltaPath);
  for (const mutate of [
    m => { m.patches[0].path = '../outside.qmxdelta'; },
    m => { m.patches[0].path = 'resources/deltas/../../outside.qmxdelta'; },
    m => { m.patches[0].path = 'C:\\outside.qmxdelta'; },
    m => { m.publicKey = f.publicKey; },
    m => { m.patches[0].algorithm = 'shell-command'; },
    m => { m.patches[0].size = m.target.size; }
  ]) {
    fs.writeFileSync(f.deltaPath, original);
    f.changeDelta(mutate, true);
    assert.throws(() => listAssets(f.target, { expectedVersion: '1.1.0', publicKey: f.publicKey }), /Invalid delta/);
  }
});

test('install verifies all incoming bytes, prunes only old signed owned patches, and supports legacy releases', t => {
  const f = fixture(t);
  buildDeltaFeed(f.options);
  const installed = f.feed('installed', '1.0.0', f.baseBytes);
  installFeed(f.target, { rootDir: installed, expectedVersion: '1.1.0', publicKey: f.publicKey });
  assert.equal(verifyFeed(installed, { expectedVersion: '1.1.0', runtimeVersion: 'manifest', publicKey: f.publicKey }).delta.patches.length, 1);
  const oldPatch = path.join(installed, f.delta().patches[0].path);
  const unknown = path.join(installed, 'resources/deltas/unowned.qmxdelta');
  fs.writeFileSync(unknown, 'unowned file stays');
  const legacy = f.feed('legacy-next', '1.2.0', Buffer.concat([f.targetBytes, Buffer.from('next release')]));
  const damaged = path.join(legacy, 'resources/app.asar');
  const original = fs.readFileSync(damaged);
  fs.writeFileSync(damaged, 'bad incoming archive');
  assert.throws(() => installFeed(legacy, { rootDir: installed, expectedVersion: '1.2.0', publicKey: f.publicKey }), /hash mismatch/);
  assert.ok(fs.existsSync(oldPatch));
  fs.writeFileSync(damaged, original);
  installFeed(legacy, { rootDir: installed, expectedVersion: '1.2.0', publicKey: f.publicKey });
  assert.equal(fs.existsSync(oldPatch), false);
  assert.equal(fs.existsSync(path.join(installed, 'feed/delta.json')), false);
  assert.equal(fs.readFileSync(unknown, 'utf8'), 'unowned file stays');
  assert.equal(verifyFeed(installed, { expectedVersion: '1.2.0', runtimeVersion: 'manifest', publicKey: f.publicKey }).delta, null);
});

test('a patch directory junction cannot redirect generated files outside the feed', t => {
  const f = fixture(t);
  const outside = path.join(f.directory, 'junction-target');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.target, 'resources/deltas'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => buildDeltaFeed(f.options), /symlink/);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fs.existsSync(f.deltaPath), false);
});

test('release CI keeps signed delta generation in trusted signing job and authenticates activation assets', () => {
  const yaml = require('yaml');
  const root = path.resolve(__dirname, '..');
  const release = yaml.parse(fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8'));
  const activate = yaml.parse(fs.readFileSync(path.join(root, '.github/workflows/activate-update.yml'), 'utf8'));
  const guard = release.jobs.trust.steps.find(step => step.id === 'guard').run;
  for (const file of ['tools/update-manifest.cjs', 'tools/release-feed.cjs', 'tools/delta-feed.cjs', 'electron/delta-codec.cjs', 'electron/delta-manifest.cjs']) assert.ok(guard.includes(file));
  const signing = release.jobs['sign-feed'].steps.find(step => step.name?.startsWith('Sign using trusted'));
  assert.ok(signing.run.indexOf('tools/update-manifest.cjs') < signing.run.indexOf('tools/delta-feed.cjs build'));
  assert.match(signing.run, /--base resources\/app\.asar --base-manifest feed\/manifest\.json/);
  const upload = release.jobs['sign-feed'].steps.find(step => step.uses === 'actions/upload-artifact@v4');
  assert.match(upload.with.path, /feed\/delta\.json/);
  assert.match(upload.with.path, /resources\/deltas\/\*\*/);
  for (const [name, job] of Object.entries(release.jobs)) {
    if (!['sign-feed', 'signing-check'].includes(name)) assert.doesNotMatch(JSON.stringify(job), /secrets\.QMX_UPDATE_SIGNING_KEY_PEM/);
  }
  const steps = activate.jobs.prepare.steps;
  const download = steps.find(step => step.name?.startsWith('Download release feed')).run;
  assert.match(download, /--json assets/);
  assert.ok(download.indexOf('list-assets incoming') < download.indexOf('--pattern "$ASSET"'));
  assert.doesNotMatch(JSON.stringify(activate), /secrets\.QMX_UPDATE_SIGNING_KEY_PEM/);
  const install = steps.find(step => step.name?.startsWith('Create review branch')).run;
  assert.match(install, /delta-feed\.cjs install incoming/);
  assert.match(install, /git add -- feed\/delta\.json/);
  assert.match(install, /git add -A -- resources\/deltas/);
});

test('forged old metadata cannot authorize pruning outside the patch directory', t => {
  const f = fixture(t);
  buildDeltaFeed(f.options);
  const incoming = f.feed('incoming-next', '1.2.0', f.targetBytes);
  const outside = path.join(f.directory, 'outside.qmxdelta');
  fs.writeFileSync(outside, 'keep');
  f.changeDelta(m => { m.patches[0].path = '../outside.qmxdelta'; }, true);
  const oldLegacy = fs.readFileSync(path.join(f.target, 'feed/manifest.json'));
  assert.throws(() => installFeed(incoming, { rootDir: f.target, expectedVersion: '1.2.0', publicKey: f.publicKey }), /Invalid delta/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
  assert.deepEqual(fs.readFileSync(path.join(f.target, 'feed/manifest.json')), oldLegacy);
});
