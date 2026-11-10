'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const createUpdater = require('../electron/updater.cjs');
const { createDelta } = require('../electron/delta-codec.cjs');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const base = crypto.randomBytes(1024 * 1024);
const target = Buffer.from(base);
target[503123] ^= 1;
const patch = createDelta(base, target);
const commit = 'b'.repeat(40);
const commitUrl = 'https://api.github.com/repos/qmx-acm-data/qmx-acm-notebook/commits/main';
const raw = `https://raw.githubusercontent.com/qmx-acm-data/qmx-acm-notebook/${commit}/`;
function sources(file) {
  return [
    `https://api.github.com/repos/qmx-acm-data/qmx-acm-notebook/contents/${file}?ref=${commit}`,
    raw + file,
    `https://cdn.jsdelivr.net/gh/qmx-acm-data/qmx-acm-notebook@${commit}/${file}`,
    `https://gcore.jsdelivr.net/gh/qmx-acm-data/qmx-acm-notebook@${commit}/${file}`,
    `https://gh-proxy.com/${raw}${file}`,
  ];
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function sign(value, key = privateKey) {
  const unsigned = structuredClone(value);
  delete unsigned.signature;
  return { ...unsigned, signature: crypto.sign(null, Buffer.from(canonical(unsigned)), key).toString('base64') };
}
function legacyManifest() {
  return sign({ schema: 1, version: '1.10.0', runtimeVersion: '42.0.0', base: '../', notes: 'Compatible signed release', publishedAt: '2026-01-01T00:00:00Z', files: [{ path: 'resources/app.asar', size: target.length, sha256: hash(target) }] });
}
function deltaManifest(patchBytes = patch) {
  const fromSha256 = hash(base);
  return sign({ schema: 1, version: '1.10.0', runtimeVersion: '42.0.0', target: { size: target.length, sha256: hash(target) }, patches: [{ fromVersion: '1.9.0', fromSize: base.length, fromSha256, path: `resources/deltas/${fromSha256}.qmxdelta`, size: patchBytes.length, sha256: hash(patchBytes), algorithm: 'qmx-cdc-brotli-v1' }], publishedAt: '2026-01-01T00:00:00Z' });
}
function response(value, extra = {}) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  return { ok: true, status: 200, headers: new Headers(), body: Readable.from([bytes.subarray(0, 29), bytes.subarray(29)]), ...extra };
}
async function filesIn(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? filesIn(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))).flat();
}
async function setup(t, options = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'qmx-delta-updater-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const installation = path.join(dir, 'installed');
  await fs.mkdir(installation);
  const installedArchive = path.join(installation, 'app.asar');
  await fs.writeFile(installedArchive, options.installedBytes ?? base);
  const downloadDir = path.join(dir, 'downloads');
  await fs.mkdir(downloadDir);
  const calls = [];
  const events = [];
  const bodyBytes = { patch: 0, full: 0 };
  const legacy = options.legacy ?? legacyManifest();
  const delta = options.delta ?? deltaManifest(options.patchBytes ?? patch);
  const patchPath = `resources/deltas/${hash(base)}.qmxdelta`;
  function counted(bytes, kind) {
    return response(bytes, { body: (async function* () {
      for (let offset = 0; offset < bytes.length; offset += 4096) {
        const chunk = bytes.subarray(offset, offset + 4096);
        bodyBytes[kind] += chunk.length;
        yield chunk;
      }
    })() });
  }
  const context = { dir, installation, installedArchive, downloadDir, calls, events, bodyBytes, legacy, delta, counted };
  const updater = createUpdater({ currentVersion: options.currentVersion ?? '1.9.0', runtimeVersion: '42.0.0', publicKey,
    downloadDir, installedArchive: options.noBase ? undefined : options.installedPath ?? installedArchive,
    timeoutMs: 5000, attemptMs: 500,
    onProgress: event => { events.push(event); options.onProgress?.(event, context); },
    fetcher: async (url, opts) => {
      calls.push({ url, opts });
      if (url === commitUrl) return response({ sha: commit });
      if (sources('feed/manifest.json').includes(url)) return options.legacyResponse ? options.legacyResponse(url, context) : response(legacy);
      if (sources('feed/delta.json').includes(url)) return options.deltaResponse ? options.deltaResponse(url, context) : response(delta);
      if (sources(patchPath).includes(url)) return options.patchResponse ? options.patchResponse(url, context) : counted(options.patchBytes ?? patch, 'patch');
      if (sources('resources/app.asar').includes(url)) return options.fullResponse ? options.fullResponse(url, context) : counted(target, 'full');
      assert.fail(`Unexpected update URL: ${url}`);
    },
  });
  return { ...context, updater, patchPath };
}
function requests(context, file) { return context.calls.filter(call => sources(file).includes(call.url)); }
async function assertReady(context, expectedKind, expectedBase = base) {
  const ready = await context.updater.download();
  assert.equal(path.basename(ready.path), 'app.asar');
  assert.equal(ready.version, '1.10.0');
  assert.deepEqual(ready.manifest, context.legacy);
  assert.deepEqual(await fs.readFile(ready.path), target);
  assert.deepEqual(await context.updater.verifyReady(), ready);
  assert.deepEqual(await fs.readFile(context.installedArchive), expectedBase);
  const state = context.updater.getState();
  const total = expectedKind === 'delta' ? context.delta.patches[0].size : target.length;
  assert.equal(state.phase, 'ready');
  assert.equal(state.downloadKind, expectedKind);
  assert.equal(state.downloaded, total);
  assert.equal(state.total, total);
  assert.equal(state.fullSize, target.length);
  assert.equal(state.percent, 100);
  assert.deepEqual((await filesIn(context.downloadDir)).map(file => path.basename(file)).sort(), ['.owner.json', 'app.asar']);
  return ready;
}

test('one byte changed in a random 1 MiB archive downloads only the delta body and publishes exact verified bytes', async t => {
  assert.ok(patch.length < target.length * 0.9);
  const context = await setup(t);
  const available = await context.updater.check();
  assert.equal(available.phase, 'available');
  assert.equal(available.downloadKind, 'delta');
  assert.equal(available.total, patch.length);
  assert.equal(available.fullSize, target.length);
  assert.deepEqual(context.calls.map(call => call.url), [commitUrl, sources('feed/manifest.json')[0], sources('feed/delta.json')[0]]);
  assert.deepEqual(context.bodyBytes, { patch: 0, full: 0 });
  await assertReady(context, 'delta');
  assert.deepEqual(context.bodyBytes, { patch: patch.length, full: 0 });
  assert.equal(requests(context, 'resources/app.asar').length, 0);
  assert.equal(requests(context, context.patchPath).length, 1);
  assert.ok(context.events.some(event => event.phase === 'downloading' && event.downloadKind === 'delta' && event.downloaded > 0));
  assert.ok(context.events.every(event => !('path' in event)));
  for (const { opts } of context.calls) {
    assert.equal(opts.redirect, 'error');
    assert.equal(opts.credentials, 'omit');
    assert.equal(opts.headers.Authorization, undefined);
  }
});

test('delta and legacy metadata plus patch mirror retries stay pinned to the same resolved commit', async t => {
  const context = await setup(t, { patchResponse: async (url, fixture) => {
    if (url !== sources(fixture.delta.patches[0].path)[1]) throw Object.assign(new Error('offline'), { code: 'ECONNRESET' });
    return fixture.counted(patch, 'patch');
  } });
  await assertReady(context, 'delta');
  assert.deepEqual(requests(context, context.patchPath).map(call => call.url), sources(context.patchPath).slice(0, 2));
  assert.equal(context.calls.filter(call => call.url === commitUrl).length, 1);
  assert.equal(context.bodyBytes.full, 0);
});

test('legacy-only clients still accept the unchanged signed feed without requesting optional delta metadata', async t => {
  const context = await setup(t, { noBase: true });
  await assertReady(context, 'full');
  assert.deepEqual(context.calls.map(call => call.url), [commitUrl, sources('feed/manifest.json')[0], sources('resources/app.asar')[0]]);
});

test('a relative installed archive cannot enable delta lookup or a patch request', async t => {
  const context = await setup(t, { installedPath: 'resources/app.asar' });
  await assertReady(context, 'full');
  assert.equal(requests(context, 'feed/delta.json').length, 0);
  assert.equal(context.bodyBytes.patch, 0);
});

for (const failure of ['hash', 'size', 'version']) {
  test(`installed base ${failure} mismatch skips all patch requests and downloads the signed full archive`, async t => {
    const bytes = Buffer.from(base);
    if (failure === 'hash') bytes[100] ^= 1;
    const installedBytes = failure === 'size' ? bytes.subarray(1) : bytes;
    const context = await setup(t, { installedBytes, currentVersion: failure === 'version' ? '1.8.0' : '1.9.0' });
    assert.equal((await context.updater.check()).downloadKind, 'full');
    await assertReady(context, 'full', installedBytes);
    assert.equal(requests(context, context.patchPath).length, 0);
    assert.equal(context.bodyBytes.patch, 0);
  });
}

for (const scenario of ['missing', 'network failure', 'invalid JSON', 'tampered signature', 'untrusted signer', 'full target hash mismatch', 'full target size mismatch', 'runtime mismatch', 'version mismatch', 'unsafe patch path', 'extra field']) {
  test(`optional delta feed ${scenario} falls back to the unchanged signed full archive`, async t => {
    let delta = deltaManifest();
    const options = {};
    if (scenario === 'missing') options.deltaResponse = async () => response({}, { ok: false, status: 404 });
    if (scenario === 'network failure') options.deltaResponse = async () => { throw Object.assign(new Error('offline'), { code: 'ECONNRESET' }); };
    if (scenario === 'invalid JSON') options.deltaResponse = async () => response(Buffer.from('{broken'));
    if (scenario === 'tampered signature') delta.patches[0].size++;
    if (scenario === 'untrusted signer') delta = sign(delta, crypto.generateKeyPairSync('ed25519').privateKey);
    if (scenario === 'full target hash mismatch') delta = sign({ ...delta, target: { ...delta.target, sha256: hash('other target') } });
    if (scenario === 'full target size mismatch') delta = sign({ ...delta, target: { ...delta.target, size: target.length + 1 } });
    if (scenario === 'runtime mismatch') delta = sign({ ...delta, runtimeVersion: '41.0.0' });
    if (scenario === 'version mismatch') delta = sign({ ...delta, version: '1.11.0' });
    if (scenario === 'unsafe patch path') { delta.patches[0].path = 'https://attacker.invalid/patch'; delta = sign(delta); }
    if (scenario === 'extra field') delta = sign({ ...delta, mirror: 'https://attacker.invalid/' });
    const context = await setup(t, { ...options, delta });
    assert.equal((await context.updater.check()).downloadKind, 'full');
    await assertReady(context, 'full');
    assert.equal(requests(context, context.patchPath).length, 0);
    assert.equal(context.bodyBytes.patch, 0);
  });
}

for (const outcome of ['up to date', 'failed metadata']) {
  test(`a new check resets previous delta progress before reporting ${outcome}`, async t => {
    let replacing = false;
    const context = await setup(t, { legacyResponse: async () => {
      if (!replacing) return response(legacyManifest());
      if (outcome === 'failed metadata') return response({}, { ok: false, status: 404 });
      return response(sign({ ...legacyManifest(), version: '1.9.0' }));
    } });
    await assertReady(context, 'delta');
    const eventOffset = context.events.length;
    const deltaRequests = requests(context, 'feed/delta.json').length;
    replacing = true;
    if (outcome === 'failed metadata') await assert.rejects(context.updater.check(), /HTTP_404/);
    else assert.equal((await context.updater.check()).phase, 'idle');
    const checking = context.events.slice(eventOffset).find(event => event.phase === 'checking');
    assert.ok(checking);
    for (const state of [checking, context.updater.getState()]) {
      assert.equal(state.downloadKind, 'full');
      assert.equal(state.fullSize, 0);
      assert.equal(state.downloaded, 0);
      assert.equal(state.total, 0);
      assert.equal(state.percent, 0);
    }
    assert.equal(requests(context, 'feed/delta.json').length, deltaRequests);
    assert.deepEqual(await fs.readdir(context.downloadDir), []);
    await assert.rejects(context.updater.verifyReady(), /No verified update/i);
  });
}

test('invalid legacy signatures fail before the optional feed or either archive is requested', async t => {
  const legacy = legacyManifest();
  legacy.notes = 'Unauthenticated change';
  const context = await setup(t, { legacy });
  await assert.rejects(context.updater.check(), /signature/i);
  assert.equal(requests(context, 'feed/delta.json').length, 0);
  assert.deepEqual(context.bodyBytes, { patch: 0, full: 0 });
  assert.deepEqual(await fs.readdir(context.downloadDir), []);
});

test('modifying installed bytes after check revalidates the base and falls back before any patch body', async t => {
  const context = await setup(t);
  assert.equal((await context.updater.check()).downloadKind, 'delta');
  const changed = Buffer.from(base);
  changed[99] ^= 1;
  await fs.writeFile(context.installedArchive, changed);
  await assertReady(context, 'full', changed);
  assert.equal(requests(context, context.patchPath).length, 0);
  assert.equal(context.bodyBytes.patch, 0);
});

test('modifying installed bytes while the patch downloads forces full fallback without overwriting the installed archive', async t => {
  const changed = Buffer.from(base);
  changed[1234] ^= 1;
  const context = await setup(t, { patchResponse: async (url, fixture) => {
    await fs.writeFile(fixture.installedArchive, changed);
    return fixture.counted(patch, 'patch');
  } });
  await assertReady(context, 'full', changed);
  assert.equal(context.bodyBytes.patch, patch.length);
  assert.equal(context.bodyBytes.full, target.length);
});

for (const failure of ['corrupt patch hash', 'truncated patch', 'patch network failure', 'signed malformed patch', 'signed wrong reconstruction']) {
  test(`${failure} safely falls back to the signed full target`, async t => {
    const options = {};
    if (failure === 'corrupt patch hash') {
      const corrupt = Buffer.from(patch);
      corrupt[corrupt.length - 1] ^= 1;
      options.patchResponse = async (url, fixture) => fixture.counted(corrupt, 'patch');
    }
    if (failure === 'truncated patch') options.patchResponse = async (url, fixture) => fixture.counted(patch.subarray(0, patch.length - 1), 'patch');
    if (failure === 'patch network failure') options.patchResponse = async () => { throw Object.assign(new Error('offline'), { code: 'ECONNRESET' }); };
    if (failure === 'signed malformed patch') options.patchBytes = Buffer.from('authenticated bytes but not a delta');
    if (failure === 'signed wrong reconstruction') {
      const wrongTarget = Buffer.from(target);
      wrongTarget[412345] ^= 1;
      options.patchBytes = createDelta(base, wrongTarget);
    }
    const context = await setup(t, options);
    assert.equal((await context.updater.check()).downloadKind, 'delta');
    await assertReady(context, 'full');
    assert.ok(requests(context, context.patchPath).length > 0);
    assert.equal(context.bodyBytes.full, target.length);
  });
}

test('a failed reconstruction followed by a broken full download publishes no ready or partial archive', async t => {
  const wrongTarget = Buffer.from(target);
  wrongTarget[222222] ^= 1;
  const context = await setup(t, { patchBytes: createDelta(base, wrongTarget), fullResponse: async (url, fixture) => fixture.counted(Buffer.alloc(target.length), 'full') });
  await assert.rejects(context.updater.download(), /SHA-256/i);
  await assert.rejects(context.updater.verifyReady(), /No verified update/i);
  assert.equal(context.events.some(event => event.phase === 'ready'), false);
  assert.deepEqual(await fs.readdir(context.downloadDir), []);
  assert.deepEqual(await fs.readFile(context.installedArchive), base);
});

for (const unsafe of ['hard link', 'directory junction', 'file symlink']) {
  test(`an installed base reached through a ${unsafe} never enables delta downloads`, async t => {
    const context = await setup(t);
    if (unsafe === 'hard link') {
      await fs.link(context.installedArchive, path.join(context.dir, 'linked.asar'));
    } else if (unsafe === 'directory junction') {
      const relocated = path.join(context.dir, 'actual-installation');
      await fs.rename(context.installation, relocated);
      await fs.symlink(relocated, context.installation, process.platform === 'win32' ? 'junction' : 'dir');
    } else {
      const real = path.join(context.dir, 'actual.asar');
      await fs.rename(context.installedArchive, real);
      try { await fs.symlink(real, context.installedArchive, 'file'); }
      catch (error) {
        if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip('Host does not grant file symlink privileges'); return; }
        throw error;
      }
    }
    assert.equal((await context.updater.check()).downloadKind, 'full');
    await assertReady(context, 'full');
    assert.equal(requests(context, context.patchPath).length, 0);
  });
}

test('a base directory replaced by a junction after check is rejected before downloading the patch', async t => {
  const context = await setup(t);
  assert.equal((await context.updater.check()).downloadKind, 'delta');
  const relocated = path.join(context.dir, 'actual-installation');
  await fs.rename(context.installation, relocated);
  await fs.symlink(relocated, context.installation, process.platform === 'win32' ? 'junction' : 'dir');
  await assertReady(context, 'full');
  assert.equal(requests(context, context.patchPath).length, 0);
});

test('a base hard-linked during patch download forces full fallback', async t => {
  const context = await setup(t, { patchResponse: async (url, fixture) => {
    await fs.link(fixture.installedArchive, path.join(fixture.dir, 'late-linked.asar'));
    return fixture.counted(patch, 'patch');
  } });
  await assertReady(context, 'full');
  assert.equal(context.bodyBytes.patch, patch.length);
  assert.equal(context.bodyBytes.full, target.length);
});

test('a base directory replaced by a junction during patch download forces full fallback', async t => {
  const context = await setup(t, { patchResponse: async (url, fixture) => {
    const relocated = path.join(fixture.dir, 'actual-installation');
    await fs.rename(fixture.installation, relocated);
    await fs.symlink(relocated, fixture.installation, process.platform === 'win32' ? 'junction' : 'dir');
    return fixture.counted(patch, 'patch');
  } });
  await assertReady(context, 'full');
  assert.equal(context.bodyBytes.patch, patch.length);
  assert.equal(context.bodyBytes.full, target.length);
});
