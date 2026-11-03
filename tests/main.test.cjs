'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

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

function harness({ files = {}, account = { id: 42, login: 'alice' }, backend = {}, updaterBackend = {}, upgradeBackend = {}, isPackaged = true } = {}) {
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
  const handlers = new Map(), calls = [], windows = [], updaterCalls = [], spawnCalls = [], timers = new Map(), appEvents = new EventEmitter();
  let ready, updaterOptions, quitCalls = 0, now = 0, timerId = 0;
  let updateState = { phase: 'idle', currentVersion: '0.3.0', available: false };
  const installerPath = path.join(root, 'updates', 'private-cache', 'app.asar');
  const manifest = { schema: 1, version: '0.4.0', runtimeVersion: '40.0.0', files: [{ path: 'resources/app.asar' }], signature: 'mock-signed-manifest' };
  const readyUpdate = { version: '0.4.0', path: installerPath, manifest };
  const execPath = path.resolve('mock-install', 'QMX-Notebook.exe');
  const installDir = path.dirname(execPath);
  const helperPath = path.join(root, 'updates', 'transaction-mock', 'update-helper.cjs');
  const jobPath = path.join(root, 'updates', 'transaction-mock', 'job.json');
  const installerArgs = [helperPath, jobPath];
  const recoveryCalls = [];
  const helperEnv = { ELECTRON_RUN_AS_NODE: '1' };
  const backupDir = path.join(root, 'upgrade-backups', 'mock-backup');
  const upgradeCalls = [], installSteps = [];
  const prepareUpgrade = options => {
    installSteps.push('prepareUpgrade');
    upgradeCalls.push(clone(options));
    const prepared = upgradeBackend.prepareUpgrade ? upgradeBackend.prepareUpgrade(options) : { args: [...installerArgs], backupDir };
    return { ...prepared, env: { ...helperEnv, ...prepared.env } };
  };
  const setUpdateState = patch => { updateState = { ...updateState, ...patch }; updaterOptions.onProgress(clone(updateState)); return clone(updateState); };
  const updater = {};
  for (const method of ['check', 'download', 'verifyReady', 'getState']) updater[method] = (...args) => {
    updaterCalls.push({ method, args: clone(args) });
    if (method === 'verifyReady') installSteps.push('verifyReady');
    if (updaterBackend[method]) return updaterBackend[method](...args, { setState: setUpdateState, installerPath });
    if (method === 'getState') return clone(updateState);
    if (method === 'check') return Promise.resolve(setUpdateState({ phase: 'available', available: true, version: '0.4.0' }));
    setUpdateState({ phase: 'ready', available: true, version: '0.4.0' });
    return Promise.resolve(clone(readyUpdate));
  };
  class BrowserWindow extends EventEmitter {
    constructor(options) { super(); this.options = options; this.destroyed = false; this.sent = []; this.webContents = { setWindowOpenHandler(fn) { this.windowOpen = fn; }, on() {}, send: (...args) => this.sent.push(clone(args)) }; windows.push(this); }
    isDestroyed() { return this.destroyed; }
    loadFile() {}
  }
  const electron = {
    app: { isPackaged, disableHardwareAcceleration() {}, whenReady: () => ({ then(callback) { ready = callback; } }), getPath: () => root, on: (...args) => appEvents.on(...args), quit() { quitCalls++; } },
    BrowserWindow,
    ipcMain: { handle(name, callback) { assert.ok(!handlers.has(name)); handlers.set(name, callback); } },
    shell: { async openExternal() {} },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: encrypted, decryptString: value => { const text = value.toString(); assert.ok(text.startsWith('fake-encrypted:')); return text.slice('fake-encrypted:'.length); } },
  };
  class FakeGitHub {
    constructor(options) { this.options = options; }
  }
  for (const method of ['saveDocument', 'deleteDocument', 'deleteIssue', 'sync', 'profile', 'comment', 'comments']) {
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
  const context = vm.createContext({ Buffer, URL, AbortSignal, console,
    process: { execPath, versions: { electron: '40.0.0' }, argv: [], env: { ELECTRON_RUN_AS_NODE: '1', QMX_TEST_ENV: 'preserved' } },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async () => { throw new Error('NETWORK FORBIDDEN IN MAIN TESTS'); },
    require(name) {
      if (name === 'electron') return electron;
      if (name === 'node:fs') return fakeFs;
      if (name === 'node:path') return path;
      if (name === 'node:crypto') return { randomUUID: () => '00000000-0000-4000-8000-000000000001' };
      if (name === '../package.json') return { version: '0.3.0' };
      if (name === './updater.cjs') return { createUpdater(options) { updaterOptions = options; return updater; } };
      if (name === './file-upgrade.cjs') return {
        prepareFileUpgrade: prepareUpgrade,
        recoverFileUpgrade(...args) {
          recoveryCalls.push(clone(args));
          assert.equal(windows.length, 0, 'recover before opening a window or exposing IPC');
          assert.equal(handlers.size, 0, 'recover before any renderer operations');
          if (upgradeBackend.recoverFileUpgrade) return upgradeBackend.recoverFileUpgrade(...args);
          return { phase: 'none' };
        },
      };
      if (name === 'node:child_process') return { spawn(file, args, options) {
        installSteps.push('spawn');
        const child = new EventEmitter();
        child.unrefCalls = 0;
        child.unref = () => { child.unrefCalls++; };
        spawnCalls.push({ file, args: clone(args), options: clone(options), child });
        return child;
      } };
      if (name === './github.cjs') return { GitHub: FakeGitHub, repoParts(repo) { if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error('Invalid repo'); return repo.split('/'); } };
      throw new Error(`Unexpected dependency ${name}`);
    }, __dirname: path.dirname(MAIN),
  });
  vm.runInContext(SOURCE, context, { filename: MAIN });
  assert.equal(handlers.size, 0, 'main must wait for app readiness');
  assert.equal(typeof ready, 'function');
  ready();
  const invoke = async (name, ...args) => clone(await handlers.get(name)({ sender: windows[0].webContents }, ...clone(args)) ?? null);
  const advanceTimers = milliseconds => {
    const end = now + milliseconds;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].callback();
    }
    now = end;
  };
  return { invoke, calls, writes, handlers, windows, updaterCalls, upgradeCalls, recoveryCalls, installSteps, spawnCalls, installerPath, readyUpdate, helperPath, jobPath, execPath, installDir, installerArgs, backupDir, advanceTimers,
    get updaterOptions() { return updaterOptions; }, get quitCalls() { return quitCalls; },
    stored: name => JSON.parse(disk.get(path.join(root, name)) || 'null') };
}

test('Issue deletion rejects foreign repositories and cleans only selected discussion cache after confirmed remote success', async () => {
  const h = harness({ files: { 'cache.json': { repo: REPO, records: [documentRecord(), issueRecord()], issues: [issueRecord(), issueRecord({number:8,id:'issue:8'})] }, 'local.json': personal([localRecord()]) }, backend: { deleteIssue: async r => ({id:`issue:${r.number}`,number:r.number,repo:REPO,deleted:true}) } });
  await assert.rejects(h.invoke('deleteIssue',{repo:'other/repo',number:7}), /仓库/);
  assert.equal(h.calls.length,0);
  await h.invoke('deleteIssue',{repo:REPO,number:7});
  const state=await h.invoke('bootstrap');
  assert.equal(state.records.length,1); assert.deepEqual(state.issues.map(r=>r.number),[8]);
  assert.deepEqual(state.local.favorites,[]); assert.equal(state.local.records.length,1);
  assert.equal(h.calls.filter(c=>c.method==='deleteIssue').length,1);
});

test('team OAuth app is available for new installs and legacy empty settings', async () => {
  for (const clientId of [undefined, '', '   ', null, 123]) {
    const h = harness({ account: null, files: { 'settings.json': { repo: REPO, ...(clientId === undefined ? {} : { clientId }) } } });
    assert.equal((await h.invoke('bootstrap')).settings.clientId, 'Ov23likjqSdpkS6MYGzJ');
  }
});

test('custom OAuth app remains available and clearing restores team default without losing settings', async () => {
  const h = harness({ account: null, files: { 'settings.json': { repo: REPO, clientId: 'custom-app', theme: 'dark', displayName: 'test' } } });
  assert.equal((await h.invoke('bootstrap')).settings.clientId, 'custom-app');
  await h.invoke('saveSettings', { clientId: '' });
  const state = await h.invoke('bootstrap');
  assert.equal(state.settings.clientId, 'Ov23likjqSdpkS6MYGzJ');
  assert.equal(state.settings.theme, 'dark'); assert.equal(state.settings.displayName, 'test');
});

test('failed Issue deletion retains discussion cache', async () => {
  const h=harness({files:{'cache.json':{repo:REPO,records:[],issues:[issueRecord()]}}, backend:{deleteIssue:async()=>{throw new Error('organization denied');}}});
  await assert.rejects(h.invoke('deleteIssue',{repo:REPO,number:7}),/organization denied/);
  assert.equal((await h.invoke('bootstrap')).issues.length,1);
});

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

test('packaged startup recovery fails before opening a window or exposing IPC', () => {
  assert.throws(() => harness({ upgradeBackend: { recoverFileUpgrade() { throw new Error('unsafe transaction requires manual recovery'); } } }), /unsafe transaction requires manual recovery/);
});

test('updater initializes with the packaged version and private cache and allows signed-out checks and downloads', async () => {
  const h = harness({ account: null });
  assert.equal(h.updaterOptions.currentVersion, '0.3.0');
  assert.equal(h.updaterOptions.runtimeVersion, '40.0.0');
  assert.deepEqual(h.recoveryCalls, [[path.resolve('mock-user-data'), h.installDir]]);
  assert.equal(h.updaterOptions.downloadDir, path.resolve('mock-user-data', 'updates'));
  const initial = await h.invoke('bootstrap');
  assert.equal(initial.account, null); assert.equal(initial.appVersion, '0.3.0'); assert.equal(initial.update.phase, 'idle');
  assert.equal((await h.invoke('checkForUpdates')).phase, 'available');
  const downloaded = await h.invoke('downloadUpdate');
  assert.equal(downloaded.phase, 'ready');
  assert.equal(Object.hasOwn(downloaded, 'path'), false);
  assert.ok(!JSON.stringify(downloaded).includes(h.installerPath));
  assert.deepEqual(h.updaterCalls.filter(call => call.method !== 'getState'), [{ method: 'check', args: [] }, { method: 'download', args: [] }]);
  assert.equal(h.calls.length, 0); assert.equal(h.spawnCalls.length, 0); assert.equal(h.quitCalls, 0);
});

test('installation ignores renderer paths, reverifies its internal artifact, launches Electron helper and quits after spawn', async () => {
  const h = harness({ account: null });
  await h.invoke('downloadUpdate');
  const install = h.invoke('installUpdate', { path: 'C:\\attacker.exe', execPath: 'C:\\attacker.exe', installDir: 'C:\\attacker', userDataDir: 'C:\\attacker-data', args: ['/malicious'] });
  await new Promise(setImmediate);
  assert.equal(h.spawnCalls.length, 1);
  const launch = h.spawnCalls[0];
  assert.equal(launch.file, h.execPath, 'the installed Electron executable runs the external helper');
  assert.deepEqual(launch.args, [h.helperPath, h.jobPath]);
  assert.deepEqual(launch.options, { detached: true, stdio: 'ignore', windowsHide: true, shell: false, env: { ELECTRON_RUN_AS_NODE: '1', QMX_TEST_ENV: 'preserved' } });
  assert.deepEqual(h.upgradeCalls, [{ userDataDir: path.resolve('mock-user-data'), installDir: path.dirname(h.execPath), version: '0.3.0', targetVersion: '0.4.0', ready: h.readyUpdate, runtimeVersion: '40.0.0', executablePath: h.execPath }]);
  assert.deepEqual(h.installSteps, ['verifyReady', 'prepareUpgrade', 'spawn']);
  assert.deepEqual(h.updaterCalls.filter(call => call.method === 'verifyReady'), [{ method: 'verifyReady', args: [] }]);
  h.advanceTimers(1000); assert.equal(h.quitCalls, 0, 'must not quit before the child confirms spawn');
  launch.child.emit('spawn');
  assert.deepEqual(await install, { installing: true });
  assert.equal(launch.child.unrefCalls, 1);
  h.advanceTimers(399); assert.equal(h.quitCalls, 0);
  h.advanceTimers(1); assert.equal(h.quitCalls, 1);
});

test('file-upgrade preparation waits for successful artifact verification and completes before helper spawn', async () => {
  const verified = deferred();
  const h = harness({
    updaterBackend: { verifyReady: () => verified.promise },
    upgradeBackend: { prepareUpgrade(options) {
      assert.equal(h.spawnCalls.length, 0);
      assert.equal(h.quitCalls, 0);
      assert.equal(options.targetVersion, '0.4.0');
      return { args: [...h.installerArgs], backupDir: h.backupDir };
    } },
  });
  await h.invoke('downloadUpdate');
  const install = h.invoke('installUpdate');
  await new Promise(setImmediate);
  assert.deepEqual(h.installSteps, ['verifyReady']);
  assert.equal(h.upgradeCalls.length, 0); assert.equal(h.spawnCalls.length, 0);
  verified.resolve(clone(h.readyUpdate));
  await new Promise(setImmediate);
  assert.deepEqual(h.installSteps, ['verifyReady', 'prepareUpgrade', 'spawn']);
  h.spawnCalls[0].child.emit('spawn');
  assert.deepEqual(await install, { installing: true });
});

test('backup preparation failure aborts installation, releases locks and retains a ready update for retry', async () => {
  let attempts = 0;
  const h = harness({ upgradeBackend: { prepareUpgrade() {
    if (++attempts === 1) throw new Error('backup disk full');
    return { args: [...h.installerArgs], backupDir: h.backupDir };
  } } });
  await h.invoke('downloadUpdate');
  await assert.rejects(h.invoke('installUpdate'), /启动升级失败.*backup disk full.*重新尝试/);
  assert.deepEqual(h.installSteps, ['verifyReady', 'prepareUpgrade']);
  assert.equal((await h.invoke('bootstrap')).update.phase, 'ready');
  h.advanceTimers(10000); assert.equal(h.spawnCalls.length, 0); assert.equal(h.quitCalls, 0);
  await h.invoke('saveSettings', { theme: 'dark' });
  assert.equal(h.stored('settings.json').theme, 'dark');
  let prevented = 0;
  h.windows[0].emit('close', { preventDefault() { prevented++; } });
  assert.equal(prevented, 0, 'normal close resumes after backup failure');
  const retry = h.invoke('installUpdate');
  await new Promise(setImmediate);
  assert.deepEqual(h.installSteps, ['verifyReady', 'prepareUpgrade', 'verifyReady', 'prepareUpgrade', 'spawn']);
  assert.equal(h.upgradeCalls.length, 2);
  assert.equal(h.spawnCalls.length, 1);
  assert.deepEqual(h.spawnCalls[0].args, h.installerArgs);
  h.spawnCalls[0].child.emit('spawn');
  assert.deepEqual(await retry, { installing: true });
  h.advanceTimers(400); assert.equal(h.quitCalls, 1);
});

test('install reverification detects tampering without spawning or quitting and releases its lock', async () => {
  const h = harness({ updaterBackend: { verifyReady({ setState }) { setState({ phase: 'error', message: 'Installer SHA-256 verification failed' }); throw new Error('Installer SHA-256 verification failed'); } } });
  await h.invoke('downloadUpdate');
  await assert.rejects(h.invoke('installUpdate', { path: h.installerPath }), /SHA-256/);
  assert.equal((await h.invoke('bootstrap')).update.phase, 'error');
  assert.equal(h.updaterCalls.filter(call => call.method === 'verifyReady').length, 1);
  assert.equal(h.upgradeCalls.length, 0, 'tampered artifacts must not trigger backup preparation');
  h.advanceTimers(10000); assert.equal(h.spawnCalls.length, 0); assert.equal(h.quitCalls, 0);
  await h.invoke('saveSettings', { theme: 'dark' });
  assert.equal(h.stored('settings.json').theme, 'dark');
});

test('source-mode installation is rejected before verification or process launch', async () => {
  const h = harness({ isPackaged: false });
  assert.deepEqual(h.recoveryCalls, [], 'source mode does not recover installed application files');
  await h.invoke('downloadUpdate');
  await assert.rejects(h.invoke('installUpdate'), /源码|安装版/);
  assert.equal(h.updaterCalls.filter(call => call.method === 'verifyReady').length, 0);
  h.advanceTimers(10000); assert.equal(h.spawnCalls.length, 0); assert.equal(h.quitCalls, 0);
});

test('spawn errors are surfaced, retain a retryable verified update and allow a later successful install', async () => {
  const h = harness();
  await h.invoke('downloadUpdate');
  const failed = h.invoke('installUpdate');
  await new Promise(setImmediate);
  const rejected = assert.rejects(failed, /启动升级失败.*launch denied.*重新尝试/);
  h.spawnCalls[0].child.emit('error', new Error('launch denied'));
  await rejected;
  assert.equal((await h.invoke('bootstrap')).update.phase, 'ready', 'verified package remains available for install retry');
  h.advanceTimers(10000); assert.equal(h.quitCalls, 0); assert.equal(h.spawnCalls[0].child.unrefCalls, 0);
  const retry = h.invoke('installUpdate');
  await new Promise(setImmediate);
  assert.equal(h.spawnCalls.length, 2);
  assert.equal(h.updaterCalls.filter(call => call.method === 'verifyReady').length, 2, 'each retry must reverify');
  h.spawnCalls[1].child.emit('spawn');
  assert.deepEqual(await retry, { installing: true });
  h.advanceTimers(400); assert.equal(h.quitCalls, 1);
});

test('download blocks conflicting operations and window close while local edits persist between update stages', async () => {
  const pending = deferred(), data = personal([localRecord()]);
  const h = harness({ files: { 'local.json': data }, updaterBackend: { download: () => pending.promise } });
  await h.invoke('checkForUpdates');
  await h.invoke('updateLocal', { ...data, draft: { body: 'after check' } });
  assert.deepEqual(h.stored('local.json').draft, { body: 'after check' });
  const downloading = h.invoke('downloadUpdate');
  for (const [name, payload] of [['saveDocument', {}], ['submit', {}], ['propose', {}], ['deleteDocument', {}], ['comment', {}], ['sync'], ['refreshAccount'], ['saveSettings', { theme: 'dark' }], ['logout'], ['login'], ['checkForUpdates'], ['downloadUpdate'], ['installUpdate']]) {
    await assert.rejects(h.invoke(name, payload), /更新|等待/);
  }
  let prevented = 0;
  h.windows[0].emit('close', { preventDefault() { prevented++; } });
  assert.equal(prevented, 1); assert.equal(h.quitCalls, 0); assert.equal(h.calls.length, 0);
  pending.resolve({ path: h.installerPath, version: '0.4.0' });
  const result = await downloading;
  assert.equal(Object.hasOwn(result, 'path'), false);
  await h.invoke('updateLocal', { ...data, draft: { body: 'after download' } });
  assert.deepEqual(h.stored('local.json').draft, { body: 'after download' });
  h.windows[0].emit('close', { preventDefault() { prevented++; } });
  assert.equal(prevented, 1, 'normal close resumes once downloading settles');
});

test('updater progress is delivered only while the application window exists', () => {
  const h = harness();
  h.updaterOptions.onProgress({ phase: 'downloading', percent: 25 });
  assert.deepEqual(h.windows[0].sent, [['update-progress', { phase: 'downloading', percent: 25 }]]);
  h.windows[0].destroyed = true;
  h.updaterOptions.onProgress({ phase: 'ready', percent: 100 });
  assert.equal(h.windows[0].sent.length, 1);
});

test('IPC handlers reject senders other than the application window', async () => {
  const h = harness();
  await assert.rejects(h.handlers.get('updateLocal')({ sender: {} }, personal()), /非法调用/);
  assert.equal(h.stored('local.json'), null); assert.equal(h.calls.length, 0);
});
