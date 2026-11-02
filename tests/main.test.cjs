'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run the real entry point without loading Electron, touching userData, or using a network.
// Only app readiness is manually advanced; all behavior goes through registered IPC handlers.
const MAIN = path.resolve(__dirname, '../electron/main.cjs');
const SOURCE = fs.readFileSync(MAIN, 'utf8');
const REPO = 'team/notebook';
const UUID = '55c710aa-e083-4b14-94fe-a3a825d17f70';
const localRecord = (extra = {}) => ({ id: 'local:one', kind: 'local', clientId: UUID, ownerId: '42', title: 'Original local', body: 'local body', ...extra });
const documentRecord = (extra = {}) => ({ id: `document:problems/qmx/42/${UUID}.md`, kind: 'document', path: `problems/qmx/42/${UUID}.md`, repo: REPO, sha: 'new-sha', clientId: UUID, authorId: 42, title: 'Remote document', body: 'remote body', ...extra });
const issueRecord = (extra = {}) => ({ id: 'issue:7', kind: 'issue', number: 7, title: 'Discussion', ...extra });
const personal = (records = []) => ({ records, favorites: ['issue:7'], mastery: { 'issue:7': 'reviewing' }, draft: { editor: { body: 'unsent work' } } });
const clone = value => JSON.parse(JSON.stringify(value));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

function harness({ files = {}, account = { id: 42, login: 'alice' }, backend = {} } = {}) {
  const root = path.resolve('mock-user-data');
  const disk = new Map();
  const writes = [];
  for (const [name, value] of Object.entries({ 'settings.json': { repo: REPO }, ...files })) disk.set(path.join(root, name), JSON.stringify(value));
  const encrypted = value => Buffer.from(`fake-encrypted:${value}`);
  if (account) disk.set(path.join(root, 'auth.json'), JSON.stringify({ encrypted: encrypted(JSON.stringify({ token: 'FAKE_TEST_TOKEN', account })).toString('base64') }));
  const fakeFs = {
    readFileSync(file) { if (!disk.has(file)) throw new Error('ENOENT'); return disk.get(file); },
    writeFileSync(file, text) { disk.set(file, String(text)); writes.push(file); },
    renameSync(from, to) { if (!disk.has(from)) throw new Error('ENOENT'); disk.set(to, disk.get(from)); disk.delete(from); },
    mkdirSync() {},
  };
  const handlers = new Map(), calls = [], windows = [];
  let ready;
  class BrowserWindow {
    constructor(options) { this.options = options; this.webContents = { setWindowOpenHandler(fn) { this.windowOpen = fn; }, on() {}, send() {} }; windows.push(this); }
    loadFile() {}
  }
  const electron = {
    app: { disableHardwareAcceleration() {}, whenReady: () => ({ then(callback) { ready = callback; } }), getPath: () => root, on() {}, quit() {} },
    BrowserWindow,
    ipcMain: { handle(name, callback) { assert.ok(!handlers.has(name)); handlers.set(name, callback); } },
    shell: { async openExternal() {} },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: encrypted, decryptString: value => { const text = value.toString(); assert.ok(text.startsWith('fake-encrypted:')); return text.slice('fake-encrypted:'.length); } },
  };
  class FakeGitHub {
    constructor(options) { this.options = options; }
  }
  for (const method of ['saveDocument', 'deleteDocument', 'sync', 'profile', 'comment', 'comments']) {
    FakeGitHub.prototype[method] = async function (...args) {
      calls.push({ method, args: clone(args), options: clone(this.options) });
      if (backend[method]) return backend[method](...args, this.options);
      if (method === 'saveDocument') return documentRecord();
      if (method === 'deleteDocument') return { id: args[0].id || `document:${args[0].path}`, path: args[0].path, repo: REPO, deleted: true };
      if (method === 'profile') return { account: { id: 42, login: 'alice', avatarUrl: '' }, permissions: { repo: this.options.repo, push: true } };
      if (method === 'sync') return { records: [], issues: [], blobs: {}, lastSync: '2026-11-02T00:00:00Z' };
      return [];
    };
  }
  const context = vm.createContext({ Buffer, URL, AbortSignal, console, process: { argv: [] }, setTimeout, clearTimeout,
    fetch: async () => { throw new Error('NETWORK FORBIDDEN IN MAIN TESTS'); },
    require(name) {
      if (name === 'electron') return electron;
      if (name === 'node:fs') return fakeFs;
      if (name === 'node:path') return path;
      if (name === 'node:crypto') return { randomUUID: () => '00000000-0000-4000-8000-000000000001' };
      if (name === './github.cjs') return { GitHub: FakeGitHub, repoParts(repo) { if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error('Invalid repo'); return repo.split('/'); } };
      throw new Error(`Unexpected dependency ${name}`);
    }, __dirname: path.dirname(MAIN),
  });
  vm.runInContext(SOURCE, context, { filename: MAIN });
  assert.equal(handlers.size, 0, 'main must wait for app readiness');
  assert.equal(typeof ready, 'function');
  ready();
  const invoke = async (name, ...args) => clone(await handlers.get(name)({ sender: windows[0].webContents }, ...clone(args)) ?? null);
  return { invoke, calls, writes, handlers, windows, stored: name => JSON.parse(disk.get(path.join(root, name)) || 'null') };
}

test('bootstrap separates a pre-sync mixed legacy cache and scopes it to its repository', async () => {
  const doc = documentRecord({ repo: undefined }), issue = issueRecord();
  const h = harness({ files: { 'cache.json': { repo: REPO, records: [doc, issue], lastSync: 'cached-time' } } });
  const state = await h.invoke('bootstrap');
  assert.deepEqual(state.records, [{ ...doc, repo: REPO }]);
  assert.deepEqual(state.issues, [{ ...issue, repo: REPO }]);
  assert.equal(state.lastSync, 'cached-time');
  await h.invoke('saveSettings', { repo: 'different/repository' });
  const changed = await h.invoke('bootstrap');
  assert.deepEqual(changed.records, []); assert.deepEqual(changed.issues, []); assert.equal(changed.lastSync, null); assert.equal(changed.permissions, null);
  assert.equal(h.calls.length, 0);
});

test('bootstrap migration supplies stable client IDs and string owner IDs without losing local metadata', async () => {
  const data = personal([{ id: 'legacy', kind: 'local', ownerId: 42 }, { id: 'unbound', kind: 'local' }]);
  const h = harness({ files: { 'local.json': data } });
  const first = (await h.invoke('bootstrap')).local;
  assert.equal(first.records[0].ownerId, '42'); assert.equal(first.records[1].ownerId, null);
  assert.match(first.records[0].clientId, /^[0-9a-f-]{36}$/);
  assert.deepEqual((await h.invoke('bootstrap')).local, first);
  assert.deepEqual(first.favorites, data.favorites); assert.deepEqual(first.mastery, data.mastery); assert.deepEqual(first.draft, data.draft);
});

test('foreign local records survive normal personal updates and cannot be edited, deleted or reassigned', async () => {
  const foreign = localRecord({ id: 'foreign', ownerId: '99' });
  const own = localRecord(); const data = personal([foreign, own]);
  const h = harness({ files: { 'local.json': data } });
  for (const records of [[own], [{ ...foreign, body: 'tampered' }, own], [{ ...foreign, ownerId: '42' }, own]]) {
    await assert.rejects(h.invoke('updateLocal', { ...data, records }), /其他账号|归属/);
    assert.deepEqual(h.stored('local.json'), data);
  }
  const changed = await h.invoke('updateLocal', { ...data, records: [foreign, { ...own, body: 'my edit' }], favorites: [] });
  assert.equal(changed.records[1].body, 'my edit'); assert.deepEqual(changed.records[0], foreign); assert.deepEqual(changed.favorites, []);
});

test('duplicate incoming IDs cannot smuggle a modified foreign local record past the guard', async () => {
  const foreign = localRecord({ id: 'foreign', ownerId: '99' }), data = personal([foreign]);
  const h = harness({ files: { 'local.json': data } });
  await assert.rejects(h.invoke('updateLocal', { ...data, records: [{ ...foreign, body: 'tampered duplicate' }, foreign] }));
  assert.deepEqual(h.stored('local.json'), data);
});

test('owner binding allows only the active account and cannot be bypassed by changing record kind', async () => {
  const unbound = localRecord({ ownerId: null }), data = personal([unbound]);
  const h = harness({ files: { 'local.json': data } });
  await assert.rejects(h.invoke('updateLocal', { ...data, records: [{ ...unbound, ownerId: '99' }] }), /其他账号/);
  await h.invoke('updateLocal', { ...data, records: [{ ...unbound, ownerId: '42' }] });
  await assert.rejects(h.invoke('updateLocal', { ...data, records: [{ ...unbound, ownerId: null }] }), /归属/);
  assert.equal(h.stored('local.json').records[0].ownerId, '42');
  // Legacy online mirrors may be ignored instead of rejected, but must never persist a forged owner.
  try { await h.invoke('updateLocal', { ...data, records: [{ ...unbound, kind: 'document', ownerId: '99' }] }); }
  catch (error) { assert.match(error.message, /归属|格式|类型/); }
  assert.ok(h.stored('local.json').records.every(record => record.ownerId !== '99'));
});

test('a logged-out user cannot claim another account or change that account local records', async () => {
  const foreign = localRecord(), data = personal([foreign]);
  const h = harness({ account: null, files: { 'local.json': data } });
  await assert.rejects(h.invoke('updateLocal', { ...data, records: [] }), /其他账号/);
  await assert.rejects(h.invoke('updateLocal', { ...data, records: [foreign, localRecord({ id: 'new', ownerId: '42' })] }), /其他账号/);
  assert.deepEqual(h.stored('local.json'), data);
});

test('foreign local uploads are rejected before calling the backend through every publication alias', async () => {
  const foreign = localRecord({ ownerId: '99' }), data = personal([foreign]);
  const h = harness({ files: { 'local.json': data } });
  for (const operation of ['saveDocument', 'submit', 'propose']) await assert.rejects(h.invoke(operation, { ...foreign, repo: REPO }), /其他账号|归属|账号/);
  assert.equal(h.calls.length, 0); assert.deepEqual(h.stored('local.json'), data);
});

test('an unbound local upload is bound durably before an uncertain remote failure', async () => {
  const unbound = localRecord({ ownerId: null });
  const h = harness({ files: { 'local.json': personal([unbound]) }, backend: { saveDocument() {
    assert.equal(h.stored('local.json').records[0].ownerId, '42', 'the binding must be persisted before network work begins');
    throw new Error('remote result unknown');
  } } });
  await assert.rejects(h.invoke('saveDocument', { ...unbound, ownerId: '42', repo: REPO }), /remote result unknown/);
  assert.equal(h.stored('local.json').records[0].ownerId, '42', 'binding must survive a lost response and subsequent account switch');
  assert.equal(h.stored('local.json').records[0].clientId, UUID);
  assert.equal(h.stored('local.json').records[0].body, unbound.body);
});

test('repository mismatch and legacy unscoped remote records fail before backend calls', async () => {
  const h = harness();
  for (const operation of ['saveDocument', 'submit', 'propose', 'deleteDocument']) {
    await assert.rejects(h.invoke(operation, documentRecord({ repo: 'other/repo' })), /其他仓库/);
    await assert.rejects(h.invoke(operation, documentRecord({ repo: undefined })), /仓库信息/);
  }
  await assert.rejects(h.invoke('comment', { repo: 'other/repo', number: 7, body: 'hello' }), /仓库/);
  assert.equal(h.calls.length, 0);
});

test('write lock blocks conflicting remote, account and configuration operations and releases on failure', async () => {
  const pending = deferred();
  const h = harness({ backend: { saveDocument: () => pending.promise } });
  const write = h.invoke('saveDocument', { clientId: UUID, repo: REPO });
  for (const [name, data] of [['saveDocument', {}], ['submit', {}], ['propose', {}], ['deleteDocument', {}], ['comment', {}], ['sync'], ['refreshAccount'], ['saveSettings', { repo: 'other/repo' }], ['logout'], ['login']]) {
    await assert.rejects(h.invoke(name, data), /操作|等待/);
  }
  assert.equal(h.calls.length, 1);
  pending.reject(new Error('write failed')); await assert.rejects(write, /write failed/);
  await h.invoke('saveSettings', { theme: 'dark' }); assert.equal(h.stored('settings.json').theme, 'dark');
});

test('sync lock prevents write/account/configuration races and releases after rejection', async () => {
  const pending = deferred(); const h = harness({ backend: { sync: () => pending.promise } });
  const sync = h.invoke('sync');
  for (const [name, data] of [['sync'], ['saveDocument', {}], ['deleteDocument', {}], ['comment', {}], ['saveSettings', { repo: 'other/repo' }], ['logout'], ['login'], ['refreshAccount']]) await assert.rejects(h.invoke(name, data), /操作|等待/);
  assert.equal(h.calls.length, 1);
  pending.reject(new Error('sync failed')); await assert.rejects(sync, /sync failed/);
  assert.equal((await h.invoke('logout')).account, null);
});

test('successful online save mutates cache immediately, preserves discussions and removes only eligible local mirrors', async () => {
  const oldDoc = documentRecord({ sha: 'old-sha' }), issue = issueRecord();
  const own = localRecord(), foreign = localRecord({ id: 'foreign', ownerId: '99' });
  const proposal = localRecord({ id: 'proposal', proposalUrl: 'https://github.com/team/notebook/pull/1' });
  const unrelated = localRecord({ id: 'unrelated', clientId: '00000000-0000-4000-8000-000000000009' });
  const data = personal([own, foreign, proposal, unrelated, oldDoc]);
  const h = harness({ files: { 'cache.json': { repo: REPO, records: [oldDoc, issue], blobs: { old: 'cached blob' }, lastSync: 'before-write' }, 'local.json': data } });
  const saved = await h.invoke('saveDocument', { ...own, repo: REPO });
  const state = await h.invoke('bootstrap');
  assert.deepEqual(state.records, [saved]); assert.deepEqual(state.issues, [{ ...issue, repo: REPO }]);
  assert.equal(state.lastSync, 'before-write');
  assert.deepEqual(state.local.records, [foreign, proposal, unrelated]);
  assert.deepEqual(state.local.favorites, data.favorites); assert.deepEqual(state.local.mastery, data.mastery); assert.deepEqual(state.local.draft, data.draft);
  assert.deepEqual(h.stored('cache.json').blobs, { old: 'cached blob' });
});

test('successful remote delete removes cached document and stale online local mirrors without removing actual locals', async () => {
  const doc = documentRecord(), other = documentRecord({ id: 'document:algorithms/other.md', path: 'algorithms/other.md' }), issue = issueRecord();
  const own = localRecord();
  const h = harness({ files: { 'cache.json': { repo: REPO, records: [doc, other], issues: [issue] }, 'local.json': personal([doc, own]) } });
  await h.invoke('deleteDocument', doc);
  const state = await h.invoke('bootstrap');
  assert.deepEqual(state.records, [other]); assert.deepEqual(state.issues, [{ ...issue, repo: REPO }]); assert.deepEqual(state.local.records, [own]);
});

test('stale UI local snapshots cannot resurrect online mirrors after remote deletion', async () => {
  const doc = documentRecord(), own = localRecord(), stale = personal([doc, own]);
  const h = harness({ files: { 'cache.json': { repo: REPO, records: [doc], issues: [] }, 'local.json': stale } });
  await h.invoke('deleteDocument', doc);
  await h.invoke('updateLocal', stale);
  assert.deepEqual((await h.invoke('bootstrap')).local.records, [own]);
});

test('stale UI snapshots cannot resurrect a local copy already published successfully', async () => {
  const own = localRecord(), unrelated = localRecord({ id: 'unrelated', clientId: '00000000-0000-4000-8000-000000000009' });
  const stale = personal([own, unrelated]); const h = harness({ files: { 'local.json': stale } });
  await h.invoke('saveDocument', { ...own, repo: REPO });
  await h.invoke('updateLocal', stale);
  const state = await h.invoke('bootstrap');
  assert.deepEqual(state.local.records, [unrelated]); assert.equal(state.records.length, 1);
});

test('published local copies stay removed after remote deletion, empty sync and application restart', async () => {
  const own = localRecord(), stale = personal([own]);
  const h = harness({ files: { 'local.json': stale } });
  const saved = await h.invoke('saveDocument', { ...own, repo: REPO });
  await h.invoke('deleteDocument', saved);
  await h.invoke('sync');
  const restarted = harness({ files: { 'local.json': h.stored('local.json'), 'cache.json': h.stored('cache.json') } });
  await restarted.invoke('updateLocal', stale);
  const state = await restarted.invoke('bootstrap');
  assert.deepEqual(state.records, []); assert.deepEqual(state.local.records, []);
  assert.deepEqual(state.local.draft, stale.draft);
});

test('local autosaves cannot race a pending online write or sync', async () => {
  for (const operation of ['saveDocument', 'sync']) {
    const pending = deferred(), data = personal([localRecord()]);
    const h = harness({ files: { 'local.json': data }, backend: { [operation]: () => pending.promise } });
    const running = h.invoke(operation, { clientId: UUID, repo: REPO });
    await assert.rejects(h.invoke('updateLocal', { ...data, favorites: [] }), /操作|等待/);
    assert.deepEqual(h.stored('local.json'), data);
    pending.reject(new Error('operation aborted')); await assert.rejects(running, /operation aborted/);
    await h.invoke('updateLocal', { ...data, favorites: [] });
    assert.deepEqual(h.stored('local.json').favorites, []);
  }
});

test('sync never supplies cached blobs from a different repository to the backend', async () => {
  const h = harness({ account: null, files: { 'cache.json': { repo: 'other/repo', records: [documentRecord()], blobs: { secret: 'foreign cache' } } } });
  await h.invoke('sync');
  assert.deepEqual(h.calls[0].args, [{}]); assert.equal(h.calls[0].options.repo, REPO);
  const state = await h.invoke('bootstrap'); assert.deepEqual(state.records, []); assert.deepEqual(state.issues, []);
  assert.equal(h.stored('cache.json').repo, REPO);
});

test('IPC handlers reject senders other than the application window', async () => {
  const h = harness();
  await assert.rejects(h.handlers.get('updateLocal')({ sender: {} }, personal()), /非法调用/);
  assert.equal(h.stored('local.json'), null); assert.equal(h.calls.length, 0);
});
