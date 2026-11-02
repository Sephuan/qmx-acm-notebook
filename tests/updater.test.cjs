'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const createUpdater = require('../electron/updater.cjs');

const bytes = Buffer.from('MZ verified fake installer, never executed');
const digest = data => `sha256:${crypto.createHash('sha256').update(data).digest('hex')}`;
function release(version = '1.10.0', extra = {}) {
  return { tag_name: `v${version}`, name: `Release ${version}`, published_at: '2026-01-01T00:00:00Z', draft: false, prerelease: false, assets: [{ name: `QMX-Notebook-Setup-${version}.exe`, state: 'uploaded', size: bytes.length, digest: digest(bytes), browser_download_url: `https://github.com/qmx-acm-data/qmx-acm-notebook/releases/download/v${version}/QMX-Notebook-Setup-${version}.exe` }], ...extra };
}
async function setup(t, { releases = [release()], response, downloadResponse, timeoutMs } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qmx-updater-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const calls = [];
  const events = [];
  const updater = createUpdater({ currentVersion: '1.9.0', downloadDir: dir, timeoutMs,
    onProgress: event => events.push(event),
    fetcher: async (url, opts) => {
      calls.push({ url, opts });
      if (url.includes('api.github.com')) return response ? response(url, opts) : { ok: true, status: 200, json: async () => releases };
      return downloadResponse ? downloadResponse(url, opts) : { ok: true, status: 200, body: Readable.from([bytes.subarray(0, 1), bytes.subarray(1)]), headers: new Headers({ 'content-length': String(bytes.length) }), url: 'https://release-assets.githubusercontent.com/a/installer.exe?signature=test' };
    } });
  return { updater, calls, events, dir };
}
async function allFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? allFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
  return nested.flat();
}

test('select highest published strict stable semver, avoiding drafts/prereleases and lexical ordering', async t => {
  const { updater, calls } = await setup(t, { releases: [release('1.9.9'), release('1.10.0'), release('9.0.0', { draft: true }), release('8.0.0', { prerelease: true }), release('7.0.0', { published_at: null }), release('6.0.0', { tag_name: 'v6.0.0-beta.1' }), release('5.0.0', { tag_name: 'v05.0.0' })] });
  const state = await updater.check();
  assert.equal(state.latestVersion, '1.10.0');
  assert.equal(state.available, true);
  assert.equal(state.phase, 'available');
  assert.equal(calls[0].url, 'https://api.github.com/repos/qmx-acm-data/qmx-acm-notebook/releases?per_page=100');
  assert.equal(calls[0].opts.headers.Authorization, undefined);
  assert.equal(calls[0].opts.credentials, 'omit');
  assert.equal('path' in state, false);
});

test('404, no stable releases, and older releases never advertise a downgrade', async t => {
  for (const options of [{ response: async () => ({ status: 404 }) }, { releases: [] }, { releases: [release('1.8.0')] }]) {
    const { updater } = await setup(t, options);
    assert.equal((await updater.check()).available, false);
    await assert.rejects(updater.download(), /No newer installer/);
  }
});

test('newest release without installer fails clearly instead of falling back', async t => {
  const { updater } = await setup(t, { releases: [release('1.10.0'), release('1.11.0', { assets: [] })] });
  await assert.rejects(updater.check(), /1\.11\.0.*installer/);
  assert.equal(updater.getState().phase, 'error');
  assert.equal(updater.getState().available, true);
  assert.equal(updater.getState().latestVersion, '1.11.0');
});

test('reject malformed asset URL, digest, size, upload state, and mismatched filename', async t => {
  for (const patch of [
    { browser_download_url: 'http://github.com/qmx-acm-data/qmx-acm-notebook/releases/download/v1.10.0/QMX-Notebook-Setup-1.10.0.exe' },
    { browser_download_url: 'https://github.com.evil.test/file.exe' },
    { browser_download_url: release().assets[0].browser_download_url + '?token=bad' },
    { digest: null }, { digest: 'sha256:bad' }, { size: 0 }, { size: -1 }, { size: 512 * 1024 * 1024 + 1 }, { size: 1.5 }, { size: Number.MAX_SAFE_INTEGER + 1 },
    { state: 'new' }, { name: '../QMX-Notebook-Setup-1.10.0.exe' }
  ]) {
    const item = release(); item.assets[0] = { ...item.assets[0], ...patch };
    const { updater } = await setup(t, { releases: [item] });
    await assert.rejects(updater.check());
    assert.equal(updater.getState().phase, 'error');
  }
});

test('stream verified installer, share concurrent work, hide paths in events, and rehash cached file', async t => {
  const { updater, calls, events } = await setup(t);
  const checkA = updater.check();
  assert.equal(checkA, updater.check());
  await checkA;
  const first = updater.download();
  assert.equal(first, updater.download());
  await assert.rejects(updater.check(), /busy/);
  const ready = await first;
  assert.equal(ready.version, '1.10.0');
  assert.deepEqual(await fs.readFile(ready.path), bytes);
  assert.deepEqual(await updater.verifyReady(), ready);
  assert.deepEqual(await updater.download(), ready);
  assert.equal(calls.length, 2);
  assert.ok(events.some(event => event.phase === 'downloading' && event.downloaded > 0));
  assert.ok(events.some(event => event.phase === 'ready' && event.percent === 100));
  assert.ok(events.every(event => !('path' in event)));
  const changed = Buffer.from(bytes); changed[3] ^= 1;
  await fs.writeFile(ready.path, changed);
  await assert.rejects(updater.verifyReady(), /verification/);
  assert.equal(updater.getState().phase, 'error');
});

test('download can perform its own check', async t => {
  const { updater } = await setup(t);
  assert.equal((await updater.download()).version, '1.10.0');
});

test('reject corrupt, short, oversized, non-PE, or disconnected streams and delete own part only', async t => {
  const badHeader = Buffer.from(bytes); badHeader[0] = 0;
  for (const mode of ['hash', 'short', 'oversize', 'header', 'dropout', 'length']) {
    const item = release();
    if (mode === 'header') item.assets[0].digest = digest(badHeader);
    const { updater, dir } = await setup(t, { releases: [item], downloadResponse: async () => ({ ok: true, status: 200,
      headers: new Headers(mode === 'length' ? { 'content-length': '900' } : {}),
      body: mode === 'dropout' ? Readable.from((async function* () { yield bytes.subarray(0, 3); throw new Error('disconnected'); })()) : Readable.from([mode === 'short' ? bytes.subarray(0, 5) : mode === 'oversize' ? Buffer.concat([bytes, bytes]) : mode === 'header' ? badHeader : mode === 'hash' ? Buffer.alloc(bytes.length, 'x') : bytes]) }) });
    const unrelated = path.join(dir, 'unrelated.part');
    await fs.writeFile(unrelated, 'keep');
    await assert.rejects(updater.download(), /verification|size|disconnected|Content-Length/);
    assert.deepEqual(await allFiles(dir), [unrelated]);
    assert.equal(await fs.readFile(unrelated, 'utf8'), 'keep');
  }
});

test('reject unsafe final redirect hosts but accept GitHub standard asset hosts', async t => {
  for (const url of ['http://github.com/file', 'https://evil.test/a', 'https://github.com.evil.test/a', 'https://user@github.com/a', 'https://objects.githubusercontent.com:444/a']) {
    const { updater } = await setup(t, { downloadResponse: async () => ({ ok: true, status: 200, url, body: Readable.from([bytes]) }) });
    await assert.rejects(updater.download(), /Unsafe update response URL/);
  }
  for (const url of ['https://github.com/file', 'https://objects.githubusercontent.com/file', undefined]) {
    const { updater } = await setup(t, { downloadResponse: async () => ({ ok: true, status: 200, url, body: Readable.from([bytes]) }) });
    assert.equal((await updater.download()).version, '1.10.0');
  }
});

test('timeout aborts request; a failed attempt is retryable', async t => {
  let attempt = 0;
  const { updater, dir } = await setup(t, { timeoutMs: 25, downloadResponse: async (_url, { signal }) => {
    if (++attempt === 1) return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    return { ok: true, status: 200, body: Readable.from([bytes]) };
  } });
  await assert.rejects(updater.download(), /timed out|aborted/);
  assert.deepEqual(await allFiles(dir), []);
  assert.equal((await updater.download()).version, '1.10.0');
});

test('timeout covers stalled response bodies and cleans up partial bytes', async t => {
  const { updater, dir } = await setup(t, { timeoutMs: 25, downloadResponse: async () => ({ ok: true, status: 200,
    body: { async *[Symbol.asyncIterator]() { yield bytes.subarray(0, 2); await new Promise(() => {}); } }
  }) });
  await assert.rejects(updater.download(), /timed out/);
  assert.deepEqual(await allFiles(dir), []);
});

test('verifyReady rejects a truncated cached installer', async t => {
  const { updater } = await setup(t);
  const ready = await updater.download();
  await fs.truncate(ready.path, 2);
  await assert.rejects(updater.verifyReady(), /size/);
});

test('reject malformed API, unsafe API response URL, and invalid current version', async t => {
  for (const response of [async () => ({ ok: true, json: async () => ({}) }), async () => ({ ok: false, status: 503 }), async () => ({ ok: true, url: 'https://evil.test/releases', json: async () => [] })]) {
    const { updater } = await setup(t, { response });
    await assert.rejects(updater.check());
  }
  for (const currentVersion of ['1.0', '01.0.0', '1.0.0-beta', '1.0.0+meta', '../1.0.0']) {
    assert.throws(() => createUpdater({ currentVersion, downloadDir: os.tmpdir() }), /semantic version/);
  }
});
