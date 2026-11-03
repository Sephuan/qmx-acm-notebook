'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const createUpdater = require('../electron/updater.cjs');

const bytes = Buffer.from('verified ASAR application bytes');
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const commit = 'a'.repeat(40);
const api = 'https://api.github.com/repos/qmx-acm-data/qmx-acm-notebook/commits/main';
const root = `https://raw.githubusercontent.com/qmx-acm-data/qmx-acm-notebook/${commit}/`;
const sources = file => [
  `https://api.github.com/repos/qmx-acm-data/qmx-acm-notebook/contents/${file}?ref=${commit}`,
  root + file,
  `https://cdn.jsdelivr.net/gh/qmx-acm-data/qmx-acm-notebook@${commit}/${file}`,
  `https://gcore.jsdelivr.net/gh/qmx-acm-data/qmx-acm-notebook@${commit}/${file}`,
  `https://gh-proxy.com/${root}${file}`
];
// Independent canonical serializer: tests do not sign using implementation exports.
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function sign(patch = {}) {
  const manifest = { schema: 1, version: '1.10.0', runtimeVersion: '42.0.0', base: '../', notes: 'Signed notes', publishedAt: '2026-01-01T00:00:00Z', files: [{ path: 'resources/app.asar', size: bytes.length, sha256: sha256(bytes) }], ...patch };
  delete manifest.signature;
  manifest.signature = crypto.sign(null, Buffer.from(canonical(manifest)), privateKey).toString('base64');
  return manifest;
}
function response(data, extra = {}) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
  return { ok: true, status: 200, body: Readable.from([body.subarray(0, 3), body.subarray(3)]), headers: new Headers(), ...extra };
}
async function setup(t, { manifest = sign(), commitResponse, manifestResponse, fileResponse, timeoutMs, attemptMs, onProgress, key = publicKey, runtimeVersion = '42.0.0' } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qmx-updater-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const calls = [];
  const events = [];
  const updater = createUpdater({ currentVersion: '1.9.0', runtimeVersion, publicKey: key, downloadDir: dir, timeoutMs, attemptMs,
    onProgress: event => { events.push(event); onProgress?.(event); },
    fetcher: async (url, opts) => {
      calls.push({ url, opts });
      if (url === api) return commitResponse ? commitResponse(url, opts) : response({ sha: commit });
      if (sources('feed/manifest.json').includes(url)) return manifestResponse ? manifestResponse(url, opts) : response(manifest);
      assert.ok(sources('resources/app.asar').includes(url));
      return fileResponse ? fileResponse(url, opts) : response(bytes);
    } });
  return { updater, calls, events, dir };
}
async function allFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? allFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
  return nested.flat();
}

test('signed manifest uses fixed production sources, resolves once, and pins every content request', async t => {
  const { updater, calls, events } = await setup(t);
  assert.equal((await updater.check()).phase, 'available');
  const ready = await updater.download();
  assert.equal(ready.version, '1.10.0');
  assert.equal(path.basename(ready.path), 'app.asar');
  assert.deepEqual(ready.manifest, sign());
  assert.deepEqual(await fs.readFile(ready.path), bytes);
  assert.deepEqual(await updater.verifyReady(), ready);
  assert.deepEqual(calls.map(call => call.url), [api, sources('feed/manifest.json')[0], sources('resources/app.asar')[0]]);
  for (const { opts } of calls) {
    assert.equal(opts.redirect, 'error');
    assert.equal(opts.credentials, 'omit');
    assert.equal(opts.headers.Authorization, undefined);
  }
  assert.ok(events.some(event => event.phase === 'downloading' && event.downloaded > 0));
  assert.ok(events.some(event => event.phase === 'ready' && event.percent === 100));
  assert.ok(events.every(event => !('path' in event)));
});

test('exports canonical and manifest validation for the signing and apply tools', () => {
  const manifest = sign();
  assert.equal(createUpdater.stableStringify({ z: 1, a: [{ c: 2, b: 3 }] }), '{"a":[{"b":3,"c":2}],"z":1}');
  assert.deepEqual(createUpdater.verifyManifest(manifest, { publicKey, runtimeVersion: '42.0.0', currentVersion: '1.9.0' }), manifest.files[0]);
  assert.throws(() => createUpdater.verifyManifest(manifest, { publicKey, runtimeVersion: '42.0.0', currentVersion: '1.10.0' }), /version/);
});

test('tampered signature, notes, file hash, version, and wrong key are rejected', async t => {
  for (const mutate of [m => { m.notes += ' altered'; }, m => { m.files[0].sha256 = '0'.repeat(64); }, m => { m.version = '9.0.0'; }, m => { m.signature = Buffer.alloc(64).toString('base64'); }, m => { m.signature = 'bad'; }]) {
    const manifest = sign(); mutate(manifest);
    const { updater, calls } = await setup(t, { manifest });
    await assert.rejects(updater.check(), /signature/);
    assert.equal(updater.getState().phase, 'error');
    assert.equal(calls.length, 2);
  }
  const { updater } = await setup(t, { key: crypto.generateKeyPairSync('ed25519').publicKey });
  await assert.rejects(updater.check(), /signature/);
});

test('strict manifest schema excludes traversal, multiple files, oversized entries, invalid versions and alternate bases', async t => {
  for (const patch of [
    { schema: 2 }, { version: 'v1.10.0' }, { version: '01.10.0' }, { version: '1.10.0-beta' },
    { runtimeVersion: '42.0' }, { base: 'https://evil.test/' }, { base: '../../' }, { notes: null }, { publishedAt: 'bad' }, { extra: true },
    { files: [] }, { files: [sign().files[0], sign().files[0]] },
    ...['../resources/app.asar', 'resources\\app.asar', '/resources/app.asar', 'resources/app.asar?foo', 'https://evil.test/app.asar'].map(p => ({ files: [{ ...sign().files[0], path: p }] })),
    ...[0, -1, 0.5, 256 * 1024 * 1024 + 1].map(size => ({ files: [{ ...sign().files[0], size }] })),
    { files: [{ ...sign().files[0], sha256: 'sha256:' + sha256(bytes) }] }
  ]) {
    const { updater } = await setup(t, { manifest: sign(patch) });
    await assert.rejects(updater.check(), /manifest|Manifest/);
  }
});

test('equal and older versions never stage a downgrade; semver comparison is numeric', async t => {
  for (const version of ['1.9.0', '1.8.9']) {
    const { updater, calls } = await setup(t, { manifest: sign({ version }) });
    assert.equal((await updater.check()).available, false);
    await assert.rejects(updater.download(), /No newer update/);
    assert.ok(calls.every(call => !sources('resources/app.asar').includes(call.url)));
  }
  const { updater } = await setup(t);
  assert.equal((await updater.check()).version, '1.10.0');
});

test('exact Electron runtime mismatch requires a manual installer before downloading', async t => {
  const { updater, calls } = await setup(t, { manifest: sign({ runtimeVersion: '42.0.1' }) });
  await assert.rejects(updater.download(), /runtime.*manual installer required/);
  assert.equal(calls.length, 2);
  assert.equal(updater.getState().available, false);
});

test('stream verification rejects hash, short, oversized, disconnected and mismatched length responses', async t => {
  for (const mode of ['hash', 'short', 'oversize', 'dropout', 'length']) {
    const { updater, dir } = await setup(t, { fileResponse: async () => response(mode === 'short' ? bytes.subarray(0, 4) : mode === 'oversize' ? Buffer.concat([bytes, bytes]) : mode === 'hash' ? Buffer.alloc(bytes.length) : bytes, {
      ...(mode === 'length' ? { headers: new Headers({ 'content-length': '900' }) } : {}),
      ...(mode === 'dropout' ? { body: Readable.from((async function* () { yield bytes.subarray(0, 3); throw new Error('disconnected'); })()) } : {})
    }) });
    const unrelated = path.join(dir, 'unrelated.part');
    await fs.writeFile(unrelated, 'keep');
    await assert.rejects(updater.download(), /verification|size|NETWORK_ERROR|Content-Length/);
    assert.deepEqual(await allFiles(dir), [unrelated]);
    assert.equal(await fs.readFile(unrelated, 'utf8'), 'keep');
  }
});

test('manifest and commit JSON limits are enforced on both headers and streamed bytes', async t => {
  for (const option of ['manifestResponse', 'commitResponse']) {
    for (const oversized of [response(Buffer.alloc(256 * 1024 + 1, 32)), response(Buffer.from('{}'), { headers: new Headers({ 'content-length': String(256 * 1024 + 1) }) })]) {
      const { updater } = await setup(t, { [option]: async () => oversized });
      await assert.rejects(updater.check(), /limit/);
    }
  }
});

test('invalid JSON and SHA, HTTP errors, and all redirected sources fail closed', async t => {
  for (const commitResponse of [async () => response({ sha: 'main' }), async () => response({ sha: '../' + commit }), async () => response(Buffer.from('{')), async () => response({}, { ok: false, status: 503 })]) {
    const { updater } = await setup(t, { commitResponse });
    await assert.rejects(updater.check());
  }
  for (const option of ['commitResponse', 'manifestResponse', 'fileResponse']) {
    for (const url of ['http://raw.githubusercontent.com/file', 'https://evil.test/a', `${root}wrong`, `https://raw.githubusercontent.com/qmx-acm-data/qmx-acm-notebook/main/resources/app.asar`]) {
      const { updater } = await setup(t, { [option]: async () => response(bytes, { url }) });
      await assert.rejects(updater.download(), /Unsafe update response URL/);
    }
    const { updater } = await setup(t, { [option]: async () => response(bytes, { redirected: true }) });
    await assert.rejects(updater.download(), /request failed/);
  }
});

test('concurrent check/download/verify share work and reject conflicting operations', async t => {
  const { updater, calls } = await setup(t);
  const first = updater.check();
  assert.equal(first, updater.check());
  const downloading = updater.download();
  assert.equal(downloading, updater.download());
  await first;
  await assert.rejects(updater.check(), /busy/);
  await assert.rejects(updater.verifyReady(), /busy/);
  const ready = await downloading;
  const verifying = updater.verifyReady();
  assert.equal(verifying, updater.verifyReady());
  await assert.rejects(updater.check(), /busy/);
  await assert.rejects(updater.download(), /busy/);
  assert.deepEqual(await verifying, ready);
  assert.equal(calls.length, 3);
});

test('download performs its own check and ready return values cannot mutate internal manifest', async t => {
  const { updater } = await setup(t, { onProgress: () => { throw new Error('bad UI listener'); } });
  const ready = await updater.download();
  ready.manifest.files[0].sha256 = '0'.repeat(64);
  ready.version = '9.0.0';
  const rechecked = await updater.download();
  assert.equal(rechecked.version, '1.10.0');
  assert.equal(rechecked.manifest.files[0].sha256, sha256(bytes));
});

test('verifyReady rehashes cached bytes and rejects truncation and hard links', async t => {
  for (const mode of ['hash', 'short', 'hardlink']) {
    const { updater } = await setup(t);
    const ready = await updater.download();
    if (mode === 'hash') await fs.writeFile(ready.path, Buffer.alloc(bytes.length));
    if (mode === 'short') await fs.truncate(ready.path, 2);
    if (mode === 'hardlink') await fs.link(ready.path, ready.path + '.link');
    await assert.rejects(updater.verifyReady(), /verification|links/);
    assert.equal(updater.getState().phase, 'error');
    await assert.rejects(updater.verifyReady(), /No verified update/);
  }
});

test('verifyReady rejects a junction in the staged path', async t => {
  const { updater, dir } = await setup(t);
  const ready = await updater.download();
  const stage = path.dirname(ready.path);
  const moved = path.join(dir, 'moved');
  await fs.rename(stage, moved);
  await fs.symlink(moved, stage, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(updater.verifyReady(), /links/);
});

test('timeout aborts download, cleans partial files, and permits retry', async t => {
  let stall = true;
  const { updater, dir } = await setup(t, { timeoutMs: 30, fileResponse: async (_url, { signal }) => {
    if (stall) return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    return response(bytes);
  } });
  await assert.rejects(updater.download(), /ETIMEDOUT/);
  assert.deepEqual(await allFiles(dir), []);
  stall = false;
  assert.equal((await updater.download()).version, '1.10.0');
});

test('timeout covers stalled manifest and file streams without advertising ready', async t => {
  for (const option of ['manifestResponse', 'fileResponse']) {
    const { updater, dir } = await setup(t, { timeoutMs: 30, [option]: async () => response(bytes, { body: { async *[Symbol.asyncIterator]() { yield bytes.subarray(0, 2); await new Promise(() => {}); } } }) });
    await assert.rejects(updater.download(), /ETIMEDOUT/);
    assert.equal(updater.getState().phase, 'error');
    assert.deepEqual(await allFiles(dir), []);
  }
});

test('network and HTTP transient failures visit every SHA-pinned source in order', async t => {
  for (const status of [408, 429, 500, 503]) {
    const { updater, calls } = await setup(t, {
      manifestResponse: async url => url === sources('feed/manifest.json').at(-1) ? response(sign()) : response({}, { ok: false, status }),
      fileResponse: async url => {
        if (url === sources('resources/app.asar').at(-1)) return response(bytes);
        throw Object.assign(new TypeError('fetch failed secret-token C:\\private'), { cause: { code: 'ECONNRESET' } });
      }
    });
    const ready = await updater.download();
    assert.deepEqual(await fs.readFile(ready.path), bytes);
    assert.deepEqual(calls.map(call => call.url), [api, ...sources('feed/manifest.json'), ...sources('resources/app.asar')]);
    for (const { url, opts } of calls.slice(1)) {
      assert.ok(url.includes(commit));
      assert.equal(opts.headers.Accept, url.startsWith('https://api.github.com/') ? 'application/vnd.github.raw+json' : 'application/json');
    }
  }
});

test('a broken stream restarts at zero and truncates bytes from previous sources', async t => {
  let attempt = 0;
  const { updater, events } = await setup(t, { fileResponse: async () => {
    if (++attempt < 3) return response(bytes, { body: Readable.from((async function* () {
      yield Buffer.alloc(attempt === 1 ? bytes.length - 1 : 2, 88);
      throw Object.assign(new Error('socket disconnected'), { code: 'ECONNRESET' });
    })()) });
    return response(bytes);
  } });
  const ready = await updater.download();
  assert.equal(attempt, 3);
  assert.deepEqual(await fs.readFile(ready.path), bytes);
  assert.ok(events.filter(event => event.phase === 'downloading' && event.downloaded === 0).length >= 3);
});

test('content trust failures and permanent HTTP status never try another source', async t => {
  for (const mode of ['signature', 'hash', 'json', '404']) {
    const manifest = sign();
    if (mode === 'signature') manifest.notes += 'tampered';
    const { updater, calls } = await setup(t, { manifest,
      ...(mode === 'json' ? { manifestResponse: async () => response(Buffer.from('{')) } : {}),
      fileResponse: async () => mode === '404' ? response({}, { ok: false, status: 404 }) : response(Buffer.alloc(bytes.length))
    });
    await assert.rejects(updater.download());
    assert.equal(calls.length, mode === 'hash' || mode === '404' ? 3 : 2);
  }
});

test('commit resolver retries twice only on transient failures and hides sensitive causes', async t => {
  let attempt = 0;
  const { updater, calls } = await setup(t, { commitResponse: async () => {
    if (++attempt < 3) throw Object.assign(new Error('fetch failed token=SECRET C:\\private'), { cause: { code: 'ECONNRESET' } });
    return response({ sha: commit });
  } });
  await updater.check();
  assert.deepEqual(calls.slice(0, 3).map(call => call.url), [api, api, api]);
  const failed = await setup(t, { commitResponse: async () => { throw Object.assign(new Error('fetch failed token=SECRET C:\\private'), { cause: { code: 'ECONNRESET' } }); } });
  await assert.rejects(failed.updater.check(), error => {
    assert.match(error.message, /网络无法连接.*api.github.com.*ECONNRESET.*重试.*手动安装/);
    assert.doesNotMatch(error.message, /fetch failed|SECRET|private/);
    return true;
  });
  assert.equal(failed.calls.length, 3);
});

test('per-attempt timeout advances to next source and total timeout bounds all attempts', async t => {
  let attempt = 0;
  const { updater, calls } = await setup(t, { timeoutMs: 300, attemptMs: 20, manifestResponse: async () => {
    if (++attempt === 1) return new Promise(() => {});
    return response(sign());
  } });
  assert.equal((await updater.check()).phase, 'available');
  assert.equal(calls.length, 3);
  const stalled = await setup(t, { timeoutMs: 65, attemptMs: 20, fileResponse: async () => response(bytes, {
    body: { async *[Symbol.asyncIterator]() { yield bytes.subarray(0, 2); await new Promise(() => {}); } }
  }) });
  await stalled.updater.check();
  const started = Date.now();
  await assert.rejects(stalled.updater.download(), /ETIMEDOUT/);
  assert.ok(Date.now() - started < 250, 'all candidates share the operation deadline');
  assert.ok(stalled.calls.length >= 4);
  assert.deepEqual(await allFiles(stalled.dir), []);
  assert.equal(stalled.updater.getState().phase, 'error');
});

test('invalid constructor options fail immediately', () => {
  const valid = { currentVersion: '1.0.0', runtimeVersion: '42.0.0', publicKey, downloadDir: os.tmpdir() };
  for (const currentVersion of ['1.0', '01.0.0', '1.0.0-beta', '../1.0.0']) assert.throws(() => createUpdater({ ...valid, currentVersion }), /semantic version/);
  for (const patch of [{ runtimeVersion: '42' }, { downloadDir: 'relative' }, { fetcher: null }, { timeoutMs: 0 }]) assert.throws(() => createUpdater({ ...valid, ...patch }));
});
