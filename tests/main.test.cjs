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

function harness({ files = {}, account = { id: 42, login: 'alice' }, backend = {}, updaterBackend = {}, upgradeBackend = {}, browserBackend = {}, networkBackend, platform = 'win32', env = {}, switches = {}, isPackaged = true } = {}) {
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
    existsSync(file) { return browserBackend.existsSync?.(file) || false; },
  };
  const handlers = new Map(), calls = [], windows = [], updaterCalls = [], spawnCalls = [], timers = new Map(), appEvents = new EventEmitter();
  const commandLineSwitches = new Map(Object.entries(switches)), appendedSwitches = [], externalCalls = [], networkCalls = [];
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
  const recoveryCalls = [], cancellationCalls = [];
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
    net: { fetch: async (url, options) => { networkCalls.push({ url: String(url), options }); return networkBackend ? networkBackend(url, options) : { url, options }; } },
    app: { isPackaged, disableHardwareAcceleration() {}, commandLine: {
      appendSwitch(name, value) { appendedSwitches.push({ name, value }); commandLineSwitches.set(name, value); },
      hasSwitch: name => commandLineSwitches.has(name), getSwitchValue: name => commandLineSwitches.get(name) || ''
    }, whenReady: () => ({ then(callback) { ready = callback; } }), getPath: () => root, on: (...args) => appEvents.on(...args), quit() { quitCalls++; } },
    BrowserWindow,
    ipcMain: { handle(name, callback) { assert.ok(!handlers.has(name)); handlers.set(name, callback); } },
    shell: { async openExternal(url) { externalCalls.push(url); return browserBackend.openExternal?.(url); } },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: encrypted, decryptString: value => { const text = value.toString(); assert.ok(text.startsWith('fake-encrypted:')); return text.slice('fake-encrypted:'.length); } },
  };
  class FakeGitHub {
    constructor(options) { this.options = options; }
  }
  for (const method of ['saveDocument', 'deleteDocument', 'deleteIssue', 'sync', 'profile', 'comment', 'comments', 'getTagCatalog', 'requestTag', 'getTagReview', 'reviewTag']) {
    FakeGitHub.prototype[method] = async function (...args) {
      calls.push({ method, args: clone(args), options: clone(this.options) });
      if (backend[method]) return backend[method](...args, this.options);
      if (method === 'saveDocument') return documentRecord();
      if (method === 'deleteDocument') return { id: args[0].id || `document:${args[0].path}`, path: args[0].path, repo: REPO, deleted: true };
      if (method === 'profile') return { account: { id: 42, login: 'alice', avatarUrl: '' }, permissions: { repo: this.options.repo, push: true } };
      if (method === 'sync') return { records: [], issues: [], blobs: {}, lastSync: '2026-11-02T00:00:00Z' };
       if (method === 'getTagCatalog') return require('../ui/tag-presets.js');
       if (method === 'getTagReview') return { canReview: false, requests: [] };
      return [];
    };
  }
  const context = vm.createContext({ Buffer, URL, AbortSignal, console,
    process: { execPath, platform, versions: { electron: '40.0.0' }, argv: [], env: { ELECTRON_RUN_AS_NODE: '1', QMX_TEST_ENV: 'preserved', ...env } },
    Date: class extends Date { static now() { return now; } },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options) => { if (!networkBackend) throw new Error('NETWORK FORBIDDEN IN MAIN TESTS'); networkCalls.push({ url: String(url), options }); return networkBackend(url, options); },
    require(name) {
      if (name === 'electron') return electron;
      if (name === 'node:fs') return fakeFs;
      if (name === 'node:path') return path;
      if (name === 'node:crypto') return { randomUUID: () => '00000000-0000-4000-8000-000000000001' };
      if (name === '../package.json') return { version: '0.3.0' };
      if (name === './auth.cjs') return require('../electron/auth.cjs');
      if (name === './platform-service.cjs') return require('../electron/platform-service.cjs');
      if (name === './planner-service.cjs') return require('../electron/planner-service.cjs');
      if (name === './platform-page.cjs') return require('../electron/platform-page.cjs');
       if (name === './contests.cjs') return require('../electron/contests.cjs');
      if (name === '@astral-sh/ruff-wasm-nodejs') return require(name);
       if (name === '../ui/tag-presets.js') return require('../ui/tag-presets.js');
       if (name === './updater.cjs') return { createUpdater(options) { updaterOptions = options; return updater; } };
      if (name === './update-storage.cjs') return { cleanupUpdateStorage() { return { files: 0, bytes: 0, retained: 0 }; } };
      if (name === './file-upgrade.cjs') return {
        prepareFileUpgrade: prepareUpgrade,
        cancelPreparedFileUpgrade(...args) {
          installSteps.push('cancelPreparedUpgrade');
          cancellationCalls.push(clone(args));
          return upgradeBackend.cancelPreparedFileUpgrade?.(...args) || { phase: 'cancelled' };
        },
        getFileUpgradeCapability: () => upgradeBackend.capability || { supported: true, reason: '' },
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
        if (browserBackend.spawn) return browserBackend.spawn(file, args, options, child);
        return child;
      } };
      if (name === './github.cjs') return { GitHub: FakeGitHub, repoParts(repo) { if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error('Invalid repo'); return repo.split('/'); } };
      throw new Error(`Unexpected dependency ${name}`);
    }, __dirname: path.dirname(MAIN),
  });
  vm.runInContext(SOURCE, context, { filename: MAIN, importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
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
  return { invoke, calls, writes, handlers, windows, updaterCalls, upgradeCalls, recoveryCalls, cancellationCalls, installSteps, spawnCalls, installerPath, readyUpdate, helperPath, jobPath, execPath, installDir, installerArgs, backupDir, advanceTimers,
    appendedSwitches, commandLineSwitches, externalCalls, networkCalls, timers,
    get updaterOptions() { return updaterOptions; }, get quitCalls() { return quitCalls; },
    stored: name => JSON.parse(disk.get(path.join(root, name)) || 'null') };
}

test('planner IPC persists device data across account/repository changes and restart without network', async () => {
  const h = harness({ account: null });
  assert.deepEqual((await h.invoke('bootstrap')).planner, { problems: [], tasks: [], layout: 'compact' });
  assert.equal(h.stored('planner.json'), null);
  let planner = await h.invoke('plannerAction', 'addProblem', { url: 'http://codeforces.com/problemset/problem/1/A', title: 'Watermelon' });
  const problemId = planner.problems[0].id;
  planner = await h.invoke('plannerAction', 'addTask', { title: 'Review proof', dueAt: '2026-11-11T18:00:00+08:00' });
  const taskId = planner.tasks[0].id;
  await h.invoke('plannerAction', 'updateProblem', { id: problemId, done: true });
  await h.invoke('plannerAction', 'updateTask', { id: taskId, details: 'Check parity', done: true });
  planner = await h.invoke('plannerAction', 'setLayout', { layout: 'compact' });
  assert.deepEqual(h.stored('planner.json'), planner);
  assert.equal(h.stored('local.json'), null);
  assert.equal(h.stored('platforms.json'), null);
  const writeCount = h.writes.length;
  await assert.rejects(h.invoke('plannerAction', 'updateTask', { id: 'missing', title: 'bad' }));
  await assert.rejects(h.invoke('plannerAction', 'addProblem', { url: 'https://evil.test/' }));
  assert.equal(h.writes.length, writeCount);
  await h.invoke('logout');
  await h.invoke('saveSettings', { repo: 'other/repo' });
  assert.deepEqual((await h.invoke('bootstrap')).planner, planner);
  const restarted = harness({ account: { id: 100, login: 'bob' }, files: { 'planner.json': h.stored('planner.json') } });
  assert.deepEqual((await restarted.invoke('bootstrap')).planner, planner);
  assert.equal(h.networkCalls.length + restarted.networkCalls.length, 0);
  await restarted.invoke('plannerAction', 'deleteProblem', { id: problemId });
  assert.deepEqual((await restarted.invoke('plannerAction', 'deleteTask', { id: taskId })), { problems: [], tasks: [], layout: 'compact' });
});

test('planner IPC validates sender/update locks and opens accepted official problem URLs', async () => {
  const gate = deferred(), h = harness({ updaterBackend: { download: () => gate.promise } });
  await assert.rejects(h.handlers.get('plannerAction')({ sender: {} }, 'addTask', { title: 'bad caller' }), /非法调用/);
  const downloading = h.invoke('downloadUpdate');
  await assert.rejects(h.invoke('plannerAction', 'addTask', { title: 'during update' }), /更新/);
  assert.equal(h.stored('planner.json'), null);
  gate.resolve(); await downloading;
  for (const url of ['http://codeforces.com/problemset/problem/1/A', 'https://hydro.ac/d/luogu/p/P1001', 'http://www.acwing.com/problem/content/1/']) await h.invoke('openExternal', url);
  for (const url of ['http://codeforces.com/profile/alice', 'https://user:pass@codeforces.com/problemset/problem/1/A', 'https://codeforces.com:8443/problemset/problem/1/A']) await assert.rejects(h.invoke('openExternal', url), /仅允许/);
  assert.equal(h.externalCalls.length, 3);
});

const cfResponse = (url, rating = 1061) => ({ ok: true, json: async () => ({ status: 'OK', result: String(url).includes('user.info') ? [{ handle: 'time-lo', rating, maxRating: rating }] : [] }) });

test('platform IPC verifies public data through Electron net and persists independently of GitHub and contest settings', async () => {
  let rating = 1061, offline = false;
  const initialSettings = { repo: REPO, contestOptOuts: ['luogu:123'], theme: 'dark' };
  const h = harness({ account: null, files: { 'settings.json': initialSettings }, networkBackend: async url => {
    if (offline) throw new Error('platform offline');
    return cfResponse(url, rating);
  } });
  assert.deepEqual((await h.invoke('bootstrap')).platforms, {});
  assert.equal(h.networkCalls.length, 0, 'startup must show cached platform state without network');
  const bound = await h.invoke('bindPlatform', 'CF', 'https://codeforces.com/profile/time-lo');
  assert.equal(bound.CF.binding.username, 'time-lo');
  assert.equal(bound.CF.data.rating, 1061);
  assert.equal(bound.CF.data.solvedCount, 0);
  assert.deepEqual((await h.invoke('bootstrap')).platforms, bound);
  assert.equal(h.networkCalls.length, 3);
  assert(h.networkCalls.every(call => new URL(call.url).hostname === 'codeforces.com'));
  assert(h.networkCalls.every(call => call.options.bypassCustomProtocolHandlers && call.options.credentials === 'omit' && !call.options.headers.Authorization));
  assert.deepEqual(h.stored('settings.json'), initialSettings);
  assert.equal(h.stored('local.json'), null);
  assert.equal(h.stored('auth.json'), null);
  await assert.rejects(h.invoke('bindPlatform', 'CF', 'https://evil.test/profile/time-lo'));
  assert.deepEqual(h.stored('platforms.json'), bound, 'invalid binding must preserve the successful snapshot');
  rating = 1200;
  const refreshed = await h.invoke('refreshPlatform', 'CF');
  assert.equal(refreshed.CF.data.rating, 1200);
  offline = true;
  const failed = await h.invoke('refreshPlatform', 'CF');
  assert.deepEqual(failed.CF.data, refreshed.CF.data);
  assert.match(failed.CF.error, /platform offline/);
  assert.equal(failed.CF.updatedAt, refreshed.CF.updatedAt);
  const restarted = harness({ account: null, files: { 'platforms.json': h.stored('platforms.json') } });
  assert.deepEqual((await restarted.invoke('bootstrap')).platforms, failed);
  assert.equal(restarted.networkCalls.length, 0);
  await restarted.invoke('logout');
  await restarted.invoke('saveSettings', { repo: 'other/repo' });
  assert.deepEqual((await restarted.invoke('bootstrap')).platforms, failed, 'GitHub logout and repository switch must retain device bindings');
  assert.deepEqual(await restarted.invoke('unbindPlatform', 'CF'), {});
  assert.deepEqual(restarted.stored('platforms.json'), {});
});

test('active platform requests prevent update checks, downloads and installation and release locks on failure', async () => {
  const gate = deferred();
  const h = harness({ networkBackend: async url => { await gate.promise; return cfResponse(url); } });
  const binding = h.invoke('bindPlatform', 'CF', 'https://codeforces.com/profile/time-lo');
  for (const name of ['checkForUpdates', 'downloadUpdate', 'installUpdate']) await assert.rejects(h.invoke(name), /等待/);
  await assert.rejects(h.invoke('refreshPlatform', 'CF'), /正在查询/);
  await assert.rejects(h.invoke('unbindPlatform', 'CF'), /正在查询/);
  assert.equal(h.updaterCalls.filter(call => call.method !== 'getState').length, 0);
  assert.equal(h.spawnCalls.length, 0);
  gate.reject(new Error('platform query failed'));
  await assert.rejects(binding, /platform query failed/);
  assert.equal((await h.invoke('checkForUpdates')).phase, 'available');
  assert.deepEqual(await h.invoke('unbindPlatform', 'CF'), {});
});

test('platform IPC shares sender validation and update locks and opens only supported HTTPS profile links', async () => {
  const gate = deferred(), h = harness({ updaterBackend: { download: () => gate.promise } });
  const downloading = h.invoke('downloadUpdate');
  for (const [name, args] of [['bindPlatform', ['CF', 'https://codeforces.com/profile/time-lo']], ['refreshPlatform', ['CF']], ['unbindPlatform', ['CF']]]) {
    await assert.rejects(h.invoke(name, ...args), /更新/);
    await assert.rejects(h.handlers.get(name)({ sender: {} }, ...args), /非法调用/);
  }
  assert.equal(h.networkCalls.length, 0);
  gate.resolve(); await downloading;
  for (const url of ['https://leetcode.cn/u/time-lo/', 'https://leetcode.com/u/time-lo/', 'https://www.luogu.com/user/123']) await h.invoke('openExternal', url);
  for (const url of ['http://leetcode.cn/u/time-lo/', 'https://leetcode.cn.evil.test/u/time-lo/', 'https://evil.test/']) await assert.rejects(h.invoke('openExternal', url), /仅允许/);
  await assert.rejects(h.invoke('openAuthUrl', 'https://leetcode.cn/u/time-lo/'), /GitHub 授权/);
  assert.equal(h.externalCalls.length, 3);
});

test('preload exposes platform IPC alongside existing auth, contest, formatter and update methods', async () => {
  let bridge;
  const calls = [], listeners = new Map();
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../electron/preload.cjs'), 'utf8'), { require(name) {
    assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'notebook'); bridge = value; } }, ipcRenderer: {
      invoke(name, ...args) { calls.push({ name, args }); return Promise.resolve(name); },
      on(name, fn) { listeners.set(name, fn); }, removeListener(name, fn) { assert.equal(listeners.get(name), fn); listeners.delete(name); }
    } };
  } });
  for (const name of ['plannerAction', 'bindPlatform', 'refreshPlatform', 'unbindPlatform', 'getContests', 'login', 'formatCode', 'installUpdate']) assert.equal(typeof bridge[name], 'function');
  assert.equal(await bridge.bindPlatform('CF', 'https://codeforces.com/profile/time-lo'), 'bindPlatform');
  assert.equal(await bridge.plannerAction('setLayout', { layout: 'compact' }), 'plannerAction');
  assert.deepEqual(calls, [{ name: 'bindPlatform', args: ['CF', 'https://codeforces.com/profile/time-lo'] }, { name: 'plannerAction', args: ['setLayout', { layout: 'compact' }] }]);
  const stop = bridge.onAuthProgress(() => {}); stop();
  assert.equal(listeners.size, 0);
});

test('contest IPC reads cache without network at bootstrap and fetches only fixed official sources anonymously', async () => {
  const h = harness({ account: null, networkBackend: async url => {
    const host = new URL(url).hostname;
    const bodies = {
      'codeforces.com': JSON.stringify({status:'OK',result:[]}),
      'atcoder.jp': '<div id="contest-table-upcoming"><table><tbody></tbody></table></div>',
      'www.luogu.com.cn': '<script type="application/json" id="lentille-context">{"data":{"contests":{"result":[]}}}</script>',
      'ac.nowcoder.com': '<div class="platform-mod js-current"></div>'
    };
    return new Response(bodies[host]);
  } });
  const initial = await h.invoke('bootstrap');
  assert.equal(initial.contests.platforms.length, 4);
  assert.equal(h.networkCalls.length, 0, 'startup must render cached schedule without waiting for websites');
  await assert.rejects(h.invoke('getContests', {url:'https://evil.test'}), /参数/);
  const result = await h.invoke('getContests', false);
  assert(result.platforms.every(p => p.updatedAt && !p.error));
  assert.equal(h.networkCalls.length, 4);
  assert.deepEqual(h.networkCalls.map(c => new URL(c.url).hostname).sort(), ['ac.nowcoder.com','atcoder.jp','codeforces.com','www.luogu.com.cn']);
  assert(h.networkCalls.every(c => !c.options.headers.Authorization && c.options.credentials === 'omit'));
  assert.equal(h.stored('contests.json').schema, 1);
  assert.equal(h.stored('local.json'), null, 'schedule refresh must not change personal records');
});

test('contest preferences validate, deduplicate and persist independent platform:id keys through bootstrap and restart', async () => {
  const h = harness({ account: null });
  const boundary = `${'p'.repeat(40)}:${'x'.repeat(120)}`;
  const keys = ['luogu:123', 'codeforces:123', 'AtCoder:abc-001_A', 'new-platform:赛程/round?1', boundary];
  const saved = await h.invoke('saveSettings', { contestOptOuts: [...keys, 'luogu:123', boundary] });
  assert.deepEqual(saved.settings.contestOptOuts, keys, 'deduplication preserves order and does not collide across platforms');
  assert.deepEqual(h.stored('settings.json').contestOptOuts, keys);
  assert.deepEqual((await h.invoke('bootstrap')).settings.contestOptOuts, keys);
  const restarted = harness({ account: null, files: { 'settings.json': h.stored('settings.json') } });
  assert.deepEqual((await restarted.invoke('bootstrap')).settings.contestOptOuts, keys, 'saved exclusions survive a fresh main process');
  await restarted.invoke('saveSettings', { theme: 'dark' });
  assert.deepEqual((await restarted.invoke('bootstrap')).settings.contestOptOuts, keys, 'unrelated settings saves retain exclusions');
  const maximum = Array.from({ length: 500 }, (_, index) => `luogu:${index}`);
  assert.deepEqual((await h.invoke('saveSettings', { contestOptOuts: maximum })).settings.contestOptOuts, maximum, '500 entries is inclusive');
  await h.invoke('saveSettings', { contestOptOuts: [] });
  assert.deepEqual(h.stored('settings.json').contestOptOuts, [], 'restoring all is persisted, not just hidden in renderer state');
  assert.deepEqual((await h.invoke('bootstrap')).settings.contestOptOuts, []);
});

test('invalid contest preferences reject atomically without altering saved settings', async () => {
  const h = harness({ files: { 'settings.json': { repo: REPO, theme: 'light', contestOptOuts: ['luogu:keep'] } } });
  const invalid = [
    null, 'luogu:123', {}, 1, [null], [123], [{}],
    [''], [':123'], ['luogu:'], ['luogu:has space'], ['luogu:tab\tid'], ['luogu:line\nid'], ['luogu:extra:colon'],
    [' luogu:123'], ['luogu:123 '], ['bad_platform:123'], ['bad.platform:123'],
    [`${'p'.repeat(41)}:123`], [`luogu:${'x'.repeat(121)}`],
    Array.from({ length: 501 }, (_, index) => `luogu:${index}`),
    Array(501).fill('luogu:duplicate'),
    ['luogu:valid', 'luogu:bad:id']
  ];
  const before = h.stored('settings.json');
  const writesBefore = h.writes.length;
  for (const contestOptOuts of invalid) {
    await assert.rejects(h.invoke('saveSettings', { theme: 'dark', contestOptOuts }), /比赛|偏好|格式/, `must reject ${JSON.stringify(contestOptOuts).slice(0, 160)}`);
    assert.deepEqual(h.stored('settings.json'), before, 'invalid preferences must not partially save unrelated settings');
    assert.deepEqual((await h.invoke('bootstrap')).settings.contestOptOuts, ['luogu:keep']);
  }
  assert.equal(h.writes.length, writesBefore, 'validation happens before any disk write');
});

test('Linux keyring default respects explicit password stores and native desktop detection', () => {
  for (const desktop of ['niri', 'sway', '']) {
    const h = harness({ platform: 'linux', env: { XDG_CURRENT_DESKTOP: desktop } });
    assert.deepEqual(h.appendedSwitches, [{ name: 'password-store', value: 'gnome-libsecret' }]);
  }
  for (const value of ['basic', 'kwallet6', 'gnome-libsecret', '']) {
    const h = harness({ platform: 'linux', env: { XDG_CURRENT_DESKTOP: 'niri' }, switches: { 'password-store': value } });
    assert.deepEqual(h.appendedSwitches, []);
    assert.equal(h.commandLineSwitches.get('password-store'), value);
  }
  for (const [platform, desktop] of [['linux', 'GNOME'], ['linux', 'ubuntu:GNOME'], ['linux', 'KDE'], ['win32', 'niri'], ['darwin', '']]) {
    assert.deepEqual(harness({ platform, env: { XDG_CURRENT_DESKTOP: desktop } }).appendedSwitches, []);
  }
});

const AUTH_URL = 'https://github.com/login/device';
const chromeBrowser = extra => ({ existsSync: file => file === '/usr/bin/google-chrome', ...extra });

test('auth browser waits through a bounded grace period and detaches a running Chrome', async () => {
  const h = harness({ platform: 'linux', browserBackend: chromeBrowser() });
  let settled = false;
  const opened = h.invoke('openAuthUrl', AUTH_URL).then(value => { settled = true; return value; });
  const launch = h.spawnCalls[0];
  assert.equal(launch.file, '/usr/bin/google-chrome');
  assert.deepEqual(launch.args, [AUTH_URL]);
  assert.deepEqual(launch.options, { detached: true, stdio: 'ignore' });
  launch.child.emit('spawn');
  await new Promise(setImmediate);
  assert.equal(settled, false, 'spawn alone does not establish a successful browser launch');
  h.advanceTimers(999);
  await new Promise(setImmediate);
  assert.equal(settled, false);
  h.advanceTimers(1);
  assert.equal(await opened, true);
  assert.equal(launch.child.unrefCalls, 1);
  assert.deepEqual(h.externalCalls, []);
  assert.equal(h.timers.size, 0);
  launch.child.emit('exit', 1, null);
  launch.child.emit('error', new Error('late process error'));
  assert.deepEqual(h.externalCalls, [], 'events after the bounded startup window do not reopen the page');
});

test('early nonzero or signaled Chrome exits use the default browser exactly once', async () => {
  for (const [code, signal] of [[1, null], [127, null], [null, 'SIGTERM']]) {
    const h = harness({ platform: 'linux', browserBackend: chromeBrowser() });
    const opened = h.invoke('openAuthUrl', AUTH_URL);
    h.spawnCalls[0].child.emit('spawn');
    h.advanceTimers(100);
    h.spawnCalls[0].child.emit('exit', code, signal);
    assert.equal(await opened, false);
    assert.deepEqual(h.externalCalls, [AUTH_URL]);
    h.advanceTimers(5000);
    assert.deepEqual(h.externalCalls, [AUTH_URL]);
    assert.equal(h.timers.size, 0);
  }
});

test('Chrome URL handoff with a zero exit is successful without default fallback', async () => {
  const h = harness({ platform: 'linux', browserBackend: chromeBrowser() });
  const opened = h.invoke('openAuthUrl', AUTH_URL);
  h.spawnCalls[0].child.emit('spawn');
  h.spawnCalls[0].child.emit('exit', 0, null);
  assert.equal(await opened, true);
  assert.deepEqual(h.externalCalls, []);
  assert.equal(h.timers.size, 0);
});

test('missing Chrome, synchronous launch failure, spawn error and missing spawn confirmation fall back', async () => {
  for (const failure of ['missing', 'throw', 'error', 'timeout']) {
    const browserBackend = failure === 'missing' ? {} : chromeBrowser(failure === 'throw' ? { spawn() { throw new Error('launch denied'); } } : {});
    const h = harness({ platform: 'linux', browserBackend });
    const opened = h.invoke('openAuthUrl', AUTH_URL);
    if (failure === 'error') h.spawnCalls[0].child.emit('error', new Error('ENOENT'));
    if (failure === 'timeout') h.advanceTimers(1000);
    assert.equal(await opened, false);
    assert.deepEqual(h.externalCalls, [AUTH_URL]);
    assert.equal(h.timers.size, 0);
  }
});

test('auth browser validates URLs before launching and reports explicit default-browser failures', async () => {
  const h = harness({ browserBackend: { openExternal() { throw new Error('no browser available'); } } });
  for (const url of ['http://github.com/login/device', 'https://example.com/', 'https://codeforces.com/']) {
    await assert.rejects(h.invoke('openAuthUrl', url), /仅允许/);
  }
  assert.deepEqual(h.externalCalls, []);
  assert.equal(h.spawnCalls.length, 0);
  await assert.rejects(h.invoke('openAuthUrl', AUTH_URL), /no browser available/);
});

test('automatic browser failures preserve the device code and keep polling through authorization success', async () => {
  let polls = 0;
  const h = harness({ account: null, platform: 'linux',
    browserBackend: chromeBrowser({ openExternal() { throw new Error('no default browser'); } }),
    networkBackend: async url => ({ ok: true, json: async () => String(url).endsWith('/device/code')
      ? { user_code: 'ABCD-1234', verification_uri: AUTH_URL, device_code: 'device-code', expires_in: 60, interval: 5 }
      : ++polls === 1 ? { error: 'authorization_pending' } : { access_token: 'NEW_TEST_TOKEN' } })
  });
  const login = h.invoke('login');
  await new Promise(setImmediate);
  assert.deepEqual(h.windows[0].sent, [['auth-progress', { userCode: 'ABCD-1234', url: AUTH_URL, expiresIn: 60 }]]);
  h.spawnCalls[0].child.emit('spawn');
  h.spawnCalls[0].child.emit('exit', 1, null);
  await new Promise(setImmediate);
  assert.deepEqual(h.externalCalls, [AUTH_URL]);
  assert.equal(polls, 0);
  h.advanceTimers(5000);
  await new Promise(setImmediate);
  assert.equal(polls, 1, 'browser failure must not abort polling');
  h.advanceTimers(5000);
  const account = await login;
  assert.equal(polls, 2);
  assert.equal(account.login, 'alice');
  assert.equal((await h.invoke('bootstrap')).account.login, 'alice');
  assert.ok(h.stored('auth.json').encrypted, 'successful device authorization is persisted');
  const request = h.networkCalls.find(call => call.url.endsWith('/oauth/access_token'));
  assert.equal(JSON.parse(request.options.body).device_code, 'device-code');
});

test('formatter uses each supported language and aliases, including TypeScript, with real offline engines', async () => {
  const h = harness();
  const cases = [
    { aliases: ['cpp', 'c++'], source: 'int main(){return 0;}', expected: 'int main() {\n    return 0;\n}' },
    { aliases: ['c'], source: 'int main(){return 0;}' },
    { aliases: ['java'], source: 'class Main{public static void main(String[] args){int x=1;}}' },
    { aliases: ['javascript', 'js'], source: 'const x={a:1,b:2};' },
    { aliases: ['typescript', 'ts', ' TS '], source: 'const value:{count:number}={count:1};', expected: 'const value: {count: number} = {\n    count: 1\n};' },
    { aliases: ['csharp', 'cs', 'c#'], source: 'class Main{static void Main(){int x=1;}}' },
    { aliases: ['objectivec', 'objc', 'objective-c'], source: '@interface Foo:NSObject\n-(void)bar;\n@end' },
    { aliases: ['python', 'py'], source: 'def f(x):\n return [x,1,2]', expected: 'def f(x):\n    return [x, 1, 2]\n' },
    { aliases: ['rust', 'rs', ' Rust '], source: 'fn main() { println!("hello"); }', expected: 'fn main() {\n    println!("hello");\n}\n' }
  ];
  for (const { aliases, source, expected } of cases) {
    let canonical;
    for (const alias of aliases) {
      const result = await h.invoke('formatCode', source, alias);
      assert.equal(result.error, undefined, `${alias}: ${result.error}`);
      assert.equal(typeof result.code, 'string');
      assert.notEqual(result.code, source, `${alias} must actually format the fixture`);
      if (canonical === undefined) canonical = result.code;
      assert.equal(result.code, canonical, `${alias} must use the same language as its canonical name`);
      if (expected) assert.equal(result.code, expected);
      assert.deepEqual(await h.invoke('formatCode', result.code, alias), result, `${alias} formatting is stable`);
    }
  }
});

test('formatter refuses oversized code before running either WASM engine and preserves the source', async () => {
  const h = harness(), source = 'x'.repeat(200001);
  for (const language of ['cpp', 'python', 'typescript', 'rust']) {
    const result = await h.invoke('formatCode', source, language);
    assert.equal(result.code, source);
    assert.match(result.error, /代码过长.*200000/);
  }
  const boundary = await h.invoke('formatCode', ' '.repeat(200000), 'cpp');
  assert.equal(boundary.error, undefined, 'the documented maximum is inclusive');
});

test('unsupported and missing formatter languages return errors while preserving the original source', async () => {
  const h = harness(), source = 'int main(){return 0;}';
  for (const language of ['', null, undefined, 'text', 'go', 'shell', 'toString', '__proto__']) {
    const result = await h.invoke('formatCode', source, language);
    assert.equal(result.code, source);
    assert.match(result.error, /不支持|未能识别/, `expected language error for ${language}`);
  }
});

test('Rust parse failures preserve source and do not break subsequent formatting', async () => {
  const h = harness(), source = 'fn main( { println!("hello"); }';
  const result = await h.invoke('formatCode', source, 'rust');
  assert.equal(result.code, source);
  assert.ok(result.error, 'invalid Rust must report a failure');
  const next = await h.invoke('formatCode', 'fn main(){let text = "你好"; println!("{}", text);}', 'rust');
  assert.equal(next.error, undefined);
  assert.match(next.code, /你好/);
});

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

test('tag catalog is available offline and a refresh updates cache without erasing document data', async () => {
  const catalog = { version: 'custom-test', source: 'fixture', categories: [] };
  const h = harness({ files: { 'cache.json': { repo: REPO, records: [documentRecord()], issues: [issueRecord()] } }, backend: { getTagCatalog: async () => catalog } });
  assert.equal((await h.invoke('bootstrap')).tagCatalog.categories.length, 22);
  assert.deepEqual(await h.invoke('getTagCatalog'), catalog);
  const state = await h.invoke('bootstrap');
  assert.deepEqual(state.tagCatalog, catalog); assert.equal(state.records.length, 1); assert.equal(state.issues.length, 1);
});
test('tag review and application are forwarded under the write lock and approval refreshes catalog', async () => {
  const gate = deferred(), catalog = { version: 'approved', categories: [] };
  const h = harness({ backend: { requestTag: async () => gate.promise, reviewTag: async input => ({ number: input.number, approved: true }), getTagCatalog: async () => catalog } });
  const pending = h.invoke('requestTag', { category: '3', name: '测试' });
  await assert.rejects(h.invoke('saveSettings', { repo: 'other/repo' }), /等待|操作/);
  gate.resolve({ number: 1 }); await pending;
  assert.deepEqual(await h.invoke('getTagReview'), { canReview: false, requests: [] });
  const decision = { number: 1, decision: 'approve', expected: { category: '3', name: '测试' } };
  assert.equal((await h.invoke('reviewTag', decision)).approved, true);
  assert.deepEqual((await h.invoke('bootstrap')).tagCatalog, catalog);
  assert.deepEqual(h.calls.find(x => x.method === 'reviewTag').args[0], decision);
});
test('tag catalog failures do not discard successful document sync or existing cached tags', async () => {
  const old = { version: 'cached', categories: [] };
  const h = harness({ files: { 'cache.json': { repo: REPO, tagCatalog: old } }, backend: { getTagCatalog: async () => { throw new Error('Network unavailable'); } } });
  const state = await h.invoke('sync');
  assert.deepEqual(state.tagCatalog, old); assert.match(state.tagCatalogError, /缓存/); assert.ok(state.lastSync);
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

test('startup discovery never downloads, stays nonblocking and suppresses network errors', async () => {
  const pending = deferred();
  const h = harness({ updaterBackend: { check: () => pending.promise } });
  const discovery = h.invoke('checkStartupUpdates');
  const windowClose = { prevented: false, preventDefault() { this.prevented = true; } };
  h.windows[0].emit('close', windowClose);
  assert.equal(windowClose.prevented, false);
  assert.equal((await h.invoke('bootstrap')).appVersion, '0.3.0');
  assert.deepEqual(h.updaterCalls.map(c => c.method).filter(m => m !== 'getState'), ['check']);
  pending.reject(new Error('offline'));
  assert.equal(await discovery, null);
  assert.equal(h.spawnCalls.length, 0);
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
  const network = await h.updaterOptions.fetcher('https://api.github.com/example', { redirect: 'error' });
  assert.equal(network.options.bypassCustomProtocolHandlers, true);
  assert.equal(network.options.redirect, 'error');
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

test('unsupported platform reports manual update capability and refuses helper launch', async () => {
  const reason = 'macOS 请手动安装完整应用';
  const h = harness({ upgradeBackend: { capability: { supported: false, reason } } });
  assert.equal((await h.invoke('bootstrap')).updateCapability.reason, reason);
  await assert.rejects(h.invoke('installUpdate'), /macOS 请手动安装/);
  assert.equal(h.spawnCalls.length, 0);
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
  assert.deepEqual(h.cancellationCalls, [[path.resolve('mock-user-data'), h.installDir]]);
  h.advanceTimers(10000); assert.equal(h.quitCalls, 0); assert.equal(h.spawnCalls[0].child.unrefCalls, 0);
  const retry = h.invoke('installUpdate');
  await new Promise(setImmediate);
  assert.equal(h.spawnCalls.length, 2);
  assert.equal(h.updaterCalls.filter(call => call.method === 'verifyReady').length, 2, 'each retry must reverify');
  h.spawnCalls[1].child.emit('spawn');
  assert.deepEqual(await retry, { installing: true });
  h.advanceTimers(400); assert.equal(h.quitCalls, 1);
});

test('synchronous helper spawn throws cancel preparation and release the update lock', async () => {
  const h = harness({ browserBackend: { spawn() { throw new Error('synchronous launch denied'); } } });
  await h.invoke('downloadUpdate');
  await assert.rejects(h.invoke('installUpdate'), /synchronous launch denied/);
  assert.deepEqual(h.cancellationCalls, [[path.resolve('mock-user-data'), h.installDir]]);
  assert.equal((await h.invoke('bootstrap')).update.phase, 'ready');
  await h.invoke('saveSettings', { theme: 'dark' });
  h.advanceTimers(10000);
  assert.equal(h.quitCalls, 0);
});

test('confirmed spawn success never cancels a job on late process errors', async () => {
  const h = harness();
  const install = h.invoke('installUpdate');
  await new Promise(setImmediate);
  h.spawnCalls[0].child.emit('spawn');
  h.spawnCalls[0].child.emit('error', new Error('late helper error'));
  assert.deepEqual(await install, { installing: true });
  assert.deepEqual(h.cancellationCalls, []);
  h.advanceTimers(400);
  assert.equal(h.quitCalls, 1);
});

test('unsafe preparation cancellation reports its failure and does not quit', async () => {
  const h = harness({ upgradeBackend: { cancelPreparedFileUpgrade() { throw new Error('helper already waiting'); } } });
  const install = h.invoke('installUpdate');
  await new Promise(setImmediate);
  const rejected = assert.rejects(install, /launch denied.*取消升级准备失败.*helper already waiting/);
  h.spawnCalls[0].child.emit('error', new Error('launch denied'));
  await rejected;
  h.advanceTimers(10000);
  assert.equal(h.quitCalls, 0);
  await h.invoke('saveSettings', { theme: 'dark' });
});

for (const spawnFailure of ['error', 'throw']) test(`main ${spawnFailure} spawn failure retires the real prepared transaction and retries without restarting`, async t => {
  if (process.platform === 'darwin') { t.skip('automatic file upgrades are disabled on macOS'); return; }
  const os = require('node:os');
  const crypto = require('node:crypto');
  const helper = require('../electron/update-helper.cjs');
  const upgrade = require('../electron/file-upgrade.cjs');
  const keyModule = require.resolve('../electron/update-key.cjs');
  const productionKey = require(keyModule);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  require.cache[keyModule].exports = publicKey.export({ type: 'spki', format: 'pem' });
  t.after(() => { require.cache[keyModule].exports = productionKey; });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qmx-main-retry-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, 'user');
  const installDir = path.join(root, 'installed');
  fs.mkdirSync(userDataDir); fs.mkdirSync(installDir); fs.mkdirSync(path.join(installDir, 'resources'));
  const executablePath = helper.installationPaths(installDir).executablePath;
  fs.writeFileSync(executablePath, 'fixture executable');
  const target = path.join(installDir, 'resources', 'app.asar');
  fs.writeFileSync(target, 'original archive');
  const download = path.join(root, 'download.asar');
  const bytes = Buffer.from('signed replacement archive');
  fs.writeFileSync(download, bytes);
  const manifest = { schema: 1, version: '0.4.0', runtimeVersion: '40.0.0', base: '../', notes: '', publishedAt: '2026-01-01T00:00:00Z', files: [{ path: 'resources/app.asar', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }] };
  manifest.signature = crypto.sign(null, Buffer.from(helper.canonical(manifest)), privateKey).toString('base64');
  const ready = { version: '0.4.0', path: download, manifest };
  const transactions = [];
  let spawnAttempts = 0;
  const h = harness({
    browserBackend: { spawn(file, args, options, child) {
      if (++spawnAttempts === 1 && spawnFailure === 'throw') throw new Error('launch denied');
      return child;
    } },
    updaterBackend: { verifyReady: () => ready },
    upgradeBackend: {
      prepareUpgrade(options) {
        const prepared = upgrade.prepareFileUpgrade({ ...options, userDataDir, installDir, executablePath });
        transactions.push(prepared.args[1]);
        return prepared;
      },
      cancelPreparedFileUpgrade: () => upgrade.cancelPreparedFileUpgrade(userDataDir, installDir),
    },
  });
  const failed = h.invoke('installUpdate');
  const rejected = assert.rejects(failed, /launch denied/);
  await new Promise(setImmediate);
  if (spawnFailure === 'error') h.spawnCalls[0].child.emit('error', new Error('launch denied'));
  await rejected;
  const firstJob = helper.readJson(transactions[0]);
  assert.equal(helper.readJson(firstJob.statePath).phase, 'cancelled');
  assert.equal(fs.existsSync(path.join(userDataDir, 'updates', 'active.json')), false);
  assert.deepEqual(fs.readFileSync(download), bytes);
  assert.equal(fs.readFileSync(target, 'utf8'), 'original archive');
  assert.equal(h.quitCalls, 0);
  const retry = h.invoke('installUpdate');
  await new Promise(setImmediate);
  assert.equal(transactions.length, 2);
  assert.notEqual(transactions[0], transactions[1]);
  h.spawnCalls[1].child.emit('spawn');
  assert.deepEqual(await retry, { installing: true });
  assert.equal(h.cancellationCalls.length, 1);
  assert.equal(fs.readFileSync(target, 'utf8'), 'original archive');
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
