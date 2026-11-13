'use strict';
const { app, BrowserWindow, ipcMain, shell, safeStorage, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { GitHub, repoParts } = require('./github.cjs');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createUpdater } = require('./updater.cjs');
const { prepareFileUpgrade, recoverFileUpgrade, cancelPreparedFileUpgrade, getFileUpgradeCapability } = require('./file-upgrade.cjs');
const { cleanupUpdateStorage } = require('./update-storage.cjs');
const { createAuth, configureUserData } = require('./auth.cjs');
const { createContestService } = require('./contests.cjs');
const { createPlatformService } = require('./platform-service.cjs');
const { createPlannerService, problemUrl } = require('./planner-service.cjs');
const { createPublicPageReader } = require('./platform-page.cjs');
const APP_VERSION = require('../package.json').version;
configureUserData(app);
const networkFetch = (url, options) => net.fetch(url, { ...options, bypassCustomProtocolHandlers: true });
let auth;
// Lazy offline code formatter (WASM in the main process; the renderer CSP blocks wasm).
// clang-format covers C-family languages, Ruff covers Python, rustfmt covers Rust.
let clangFormatterPromise, ruffWorkspacePromise, rustFormatterPromise;
async function formatCode(source, lang) {
  const text = String(source == null ? '' : source);
  if (text.length > 200000) throw new Error('代码过长，格式化仅支持不超过 200000 个字符');
  const language = String(lang || '').trim().toLowerCase();
  if (language === 'python' || language === 'py') {
    if (!ruffWorkspacePromise) ruffWorkspacePromise = Promise.resolve().then(() => {
      const { Workspace, PositionEncoding } = require('@astral-sh/ruff-wasm-nodejs');
      return new Workspace({}, PositionEncoding.UTF16);
    });
    return { code: (await ruffWorkspacePromise).format(text) };
  }
  if (language === 'rust' || language === 'rs') {
    if (!rustFormatterPromise) rustFormatterPromise = import('@scalar/rust-fmt');
    const { format } = await rustFormatterPromise;
    return { code: await format(text, { edition: '2021', maxWidth: 100 }) };
  }
  const filenames = new Map([
    ['cpp', 'main.cpp'], ['c++', 'main.cpp'], ['c', 'main.c'], ['java', 'Main.java'],
    ['javascript', 'main.js'], ['js', 'main.js'], ['typescript', 'main.ts'], ['ts', 'main.ts'],
    ['cs', 'main.cs'], ['csharp', 'main.cs'], ['c#', 'main.cs'],
    ['objc', 'main.m'], ['objectivec', 'main.m'], ['objective-c', 'main.m']
  ]);
  const filename = filenames.get(language);
  if (!filename) throw new Error(language ? `暂不支持 ${language} 代码的格式化` : '未能识别代码语言，无法格式化');
  if (!clangFormatterPromise) clangFormatterPromise = import('@wasm-fmt/clang-format');
  const { format } = await clangFormatterPromise;
  const style = JSON.stringify({ BasedOnStyle: 'Chromium', IndentWidth: 4, ColumnLimit: 100, PointerAlignment: 'Left' });
  return { code: format(text, filename, style) };
}
function authFailure(error, ticket) {
  if (auth.failure(error, ticket)) {
    token = auth.token; account = auth.account;
    if (error.status === 401) permissions = null;
  }
}
app.disableHardwareAcceleration();
// On Linux desktops without a recognized keyring (niri, sway, ...), Chromium picks the plaintext
// backend and safeStorage reports unavailable, which blocks login persistence. Prefer libsecret so a
// running secret service (gnome-keyring/KWallet) can be used; GNOME and KDE keep native detection.
if (process.platform === 'linux' && !app.commandLine.hasSwitch('password-store') && !/gnome|kde/i.test(process.env.XDG_CURRENT_DESKTOP || '')) {
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
}
let win, dir, contestService, platforms, planner, token = '', account = null, permissions = null;
let loginGeneration = 0, writeBusy = false, syncBusy = false, updateBusy = false, installing = false, updater;
function processEnvForInstaller() {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}
function ensureIdle() {
  if (updateBusy || installing) throw new Error('客户端正在更新，请等待更新完成');
}
// Public OAuth application identifier; never embed a client secret or user token.
const TEAM_CLIENT_ID = 'Ov23likjqSdpkS6MYGzJ';
const defaults = {
  serverUrl: 'http://172.25.5.128:3000',
  repo: 'ctguacm/2026',
  repositories: [
    { id: 'ctgu-2026', name: '三峡大学 2026 题解库 (校内)', serverUrl: 'http://172.25.5.128:3000', repo: 'ctguacm/2026' },
    { id: 'qmx-official', name: '官方公共题库 (GitHub)', serverUrl: '', repo: 'qmx-acm-data/2026' }
  ],
  activeRepoId: 'ctgu-2026',
  clientId: TEAM_CLIENT_ID,
  theme: 'light'
};
function read(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { return fallback; }
}
function save(name, data) {
  const file = path.join(dir, name);
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2));
  fs.renameSync(file + '.tmp', file);
}
function normalizeRepositories(data, fallbackRepo = defaults.repo, fallbackServerUrl = defaults.serverUrl) {
  let repos = Array.isArray(data?.repositories) ? [...data.repositories] : [];
  if (repos.length === 0) {
    repos = [
      { id: 'ctgu-2026', name: '三峡大学 2026 题解库 (校内)', serverUrl: 'http://172.25.5.128:3000', repo: 'ctguacm/2026' },
      { id: 'qmx-official', name: '官方公共题库 (GitHub)', serverUrl: '', repo: 'qmx-acm-data/2026' }
    ];
  }
  if (data?.repo && !repos.some(r => r && r.repo === data.repo)) {
    repos.unshift({ id: 'repo-current', name: '当前题库', serverUrl: data.serverUrl !== undefined ? data.serverUrl : fallbackServerUrl, repo: data.repo });
  }
  const validRepos = [];
  const seenIds = new Set();
  for (const item of repos) {
    if (!item || typeof item !== 'object') continue;
    let repoPath = String(item.repo || '').trim();
    try { repoParts(repoPath); } catch { continue; }
    let id = String(item.id || '').trim();
    if (!id || seenIds.has(id)) id = 'repo-' + Math.random().toString(36).slice(2, 9);
    seenIds.add(id);
    let serverUrl = String(item.serverUrl || '').trim();
    if (serverUrl && !/^https?:\/\/[^\s$.?#].[^\s]*$/i.test(serverUrl)) serverUrl = '';
    const name = String(item.name || '').trim().slice(0, 50) || repoPath;
    validRepos.push({ id, name, serverUrl, repo: repoPath });
  }
  if (validRepos.length === 0) {
    validRepos.push({ id: 'repo-current', name: '当前题库', serverUrl: fallbackServerUrl, repo: fallbackRepo });
  }
  let active = null;
  if (data?.activeRepoId) {
    active = validRepos.find(r => r.id === data.activeRepoId && (!data.repo || r.repo === data.repo));
  }
  if (!active && data?.repo) {
    active = validRepos.find(r => r.repo === data.repo);
  }
  if (!active) {
    active = validRepos.find(r => r.id === data?.activeRepoId) || validRepos[0];
  }
  return { repositories: validRepos, activeRepoId: active.id, repo: active.repo, serverUrl: active.serverUrl };
}
function settings() {
  const stored = read('settings.json', {});
  const raw = { ...defaults, ...stored };
  const requestedRepo = stored.repo !== undefined ? stored.repo : raw.repo;
  const requestedActiveId = stored.activeRepoId !== undefined ? stored.activeRepoId : (stored.repo && stored.repo !== defaults.repo ? null : raw.activeRepoId);
  const normalized = normalizeRepositories({ ...raw, repo: requestedRepo, activeRepoId: requestedActiveId }, defaults.repo, defaults.serverUrl);
  const value = {
    ...raw,
    repositories: normalized.repositories,
    activeRepoId: normalized.activeRepoId,
    repo: normalized.repo,
    serverUrl: normalized.serverUrl
  };
  value.clientId = typeof value.clientId === 'string' && value.clientId.trim() ? value.clientId.trim() : TEAM_CLIENT_ID;
  return value;
}
function local() { return { records: [], favorites: [], mastery: {}, draft: {}, ...read('local.json', {}) }; }
function githubClient(currentToken = token, repo = settings().repo, serverUrl = settings().serverUrl) {
  const ticket = auth.capture();
  const gh = new GitHub({ repo, token: currentToken, fetcher: networkFetch, serverUrl });
  // All authenticated operations, including writes, invalidate only on a structured HTTP 401.
  return new Proxy(gh, { get(target, name) {
    const value = target[name];
    if (typeof value !== 'function') return value;
    return async (...args) => {
      try { return await value.apply(target, args); }
      catch (error) { if (currentToken && currentToken === ticket.token) authFailure(error, ticket); throw error; }
    };
  } });
}
function client() { return githubClient(); }
function repoCache(cache, repo = settings().repo) {
  if (cache.repos && cache.repos[repo]) return cache.repos[repo];
  if (cache.repo === repo) return cache;
  return {};
}
function state(error) {
  const s = settings(), cache = read('cache.json', {});
  const c = repoCache(cache, s.repo);
  const matching = c.repo === s.repo;
  return {
    records: matching ? (c.records || []).filter(r => r.kind === 'document').map(r => ({ ...r, repo: s.repo })) : [],
    algorithmNotes: matching ? (c.algorithmNotes || []).map(r => ({ ...r, repo: s.repo })) : [],
    algorithmTopics: matching && Array.isArray(c.algorithmTopics) ? c.algorithmTopics.map(topic => ({ ...topic, repo: s.repo })) : [],
    issues: matching ? (c.issues || (c.records || []).filter(r => r.kind === 'issue')).map(r => ({ ...r, repo: s.repo })) : [],
    lastSync: matching ? c.lastSync : null,
    tagCatalog: matching && c.tagCatalog ? c.tagCatalog : require('../ui/tag-presets.js'),
    tagCatalogError: matching ? c.tagCatalogError || null : null,
    settings: s, account, authStatus: auth?.status, appVersion: APP_VERSION, update: updater?.getState(), updateCapability: getFileUpgradeCapability(), permissions: permissions?.repo === s.repo ? permissions : null,
    local: local(), contests: contestService?.snapshot(), platforms: platforms?.state(), planner: planner?.state(), error: error || null
  };
}
function assertExternal(url) {
  const u = new URL(url);
  const custom = settings()?.serverUrl;
  let customUrl = null;
  if (custom) {
    try { customUrl = new URL(custom); } catch (_) {}
  }
  const isSchoolServer = u.hostname === '172.25.5.128';
  const isCustom = customUrl && u.hostname === customUrl.hostname && (!u.port || u.port === customUrl.port);
  if (!u.username && !u.password && (isSchoolServer || isCustom)) return u;
  if (!u.username && !u.password && !u.port && u.protocol === 'https:' && ['github.com', 'codeforces.com', 'atcoder.jp', 'www.luogu.com.cn', 'luogu.com.cn', 'ac.nowcoder.com', 'www.nowcoder.com', 'contest.codeforces.com', 'leetcode.cn', 'leetcode.com', 'www.luogu.com'].includes(u.hostname)) return u;
  try { return new URL(problemUrl(url)); }
  catch { throw new Error('仅允许打开 GitHub、校内代码平台和受支持题目平台的链接（HTTP 仅限官方题目）'); }
}
async function external(url) {
  const u = assertExternal(url);
  await shell.openExternal(u.href);
}
// Prefer Chrome for the device-flow page; fall back to the default handler if it is missing or
// fails during startup. Existing Chrome instances may accept the URL and exit successfully.
const AUTH_BROWSER_STARTUP_GRACE_MS = 1000;
function chromePath() {
  const candidates = process.platform === 'win32'
    ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].map(base => base && path.join(base, 'Google\\Chrome\\Application\\chrome.exe'))
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find(candidate => candidate && fs.existsSync(candidate)) || null;
}
async function openAuthUrl(url) {
  const u = assertExternal(url);
  if (u.hostname !== 'github.com') throw new Error('仅允许打开 GitHub 授权链接');
  const chrome = chromePath();
  if (chrome) {
    const launched = await new Promise(resolve => {
      let child, timer, settled = false, spawned = false;
      const finish = success => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        child?.removeListener('spawn', onSpawn);
        child?.removeListener('exit', onExit);
        resolve(success);
      };
      const onSpawn = () => { spawned = true; child.unref(); };
      const onExit = (code, signal) => finish(code === 0 && !signal);
      try { child = spawn(chrome, [u.href], { detached: true, stdio: 'ignore' }); }
      catch { finish(false); return; }
      // Keep the one-shot error handler after the grace period to consume late process errors.
      child.once('error', () => finish(false));
      child.once('spawn', onSpawn);
      child.once('exit', onExit);
      timer = setTimeout(() => finish(spawned), AUTH_BROWSER_STARTUP_GRACE_MS);
    });
    if (launched) return true;
  }
  await shell.openExternal(u.href);
  return false;
}
function persistAuth(data, ticket) {
  auth.commit(data.token, data.account, ticket);
}
async function avatarData(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname !== 'avatars.githubusercontent.com') return null;
    u.searchParams.set('s', '80');
    const response = await networkFetch(u, { signal: AbortSignal.timeout(7000), redirect: 'error' });
    const type = response.headers.get('content-type')?.split(';')[0];
    if (!response.ok || !['image/png', 'image/jpeg', 'image/webp'].includes(type)) return null;
    const reader = response.body.getReader(); const chunks = []; let length = 0;
    while (true) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.length;
      if (length > 256000) { await reader.cancel(); return null; }
      chunks.push(Buffer.from(part.value));
    }
    return `data:${type};base64,${Buffer.concat(chunks).toString('base64')}`;
  } catch { return null; }
}
async function refreshIdentity(gh = client()) {
  const gen = loginGeneration, repo = settings().repo, ticket = auth.capture();
  const result = await gh.profile();
  const picture = await avatarData(result.account.avatarUrl);
  if (gen !== loginGeneration || repo !== settings().repo) throw new Error('账号或仓库已改变，请重试');
  const next = { ...result.account, avatarData: picture };
  persistAuth({ token: ticket.token, account: next }, ticket); account = next; permissions = result.permissions;
  return state();
}
async function oauth(endpoint, data) {
  const response = await networkFetch(`https://github.com/login/${endpoint}`, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(data), signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`GitHub 授权服务错误 ${response.status}`);
  return response.json();
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function login() {
  if (writeBusy || syncBusy) throw new Error('请等待当前操作完成后再登录');
  const id = settings().clientId.trim();
  if (!id) throw new Error('请先在设置中填写队伍 GitHub OAuth 应用的 Client ID，并启用 Device Flow。未配置时仍可使用本地题解和公开题库。');
  const gen = ++loginGeneration, ticket = auth.capture();
  const code = await oauth('device/code', { client_id: id, scope: 'public_repo' });
  if (gen !== loginGeneration) throw new Error('已取消登录');
  if (code.error) throw new Error(code.error_description || code.error);
  win.webContents.send('auth-progress', { userCode: code.user_code, url: code.verification_uri, expiresIn: code.expires_in });
  // The code/link are already visible, so a failed automatic browser launch must not stop polling.
  await openAuthUrl(code.verification_uri).catch(() => {});
  let interval = Math.max(5, code.interval || 5) * 1000;
  const deadline = Date.now() + code.expires_in * 1000;
  while (Date.now() < deadline) {
    await pause(interval); if (gen !== loginGeneration) throw new Error('已取消登录');
    const result = await oauth('oauth/access_token', { client_id: id, device_code: code.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
    if (gen !== loginGeneration) throw new Error('已取消登录');
    if (result.error === 'authorization_pending') continue;
    if (result.error === 'slow_down') { interval += 5000; continue; }
    if (result.error) throw new Error(result.error_description || result.error);
    if (!result.access_token) throw new Error('GitHub 未返回凭据');
    const repo = settings().repo;
    const gh = githubClient(result.access_token, repo);
    const profile = await gh.profile();
    const picture = await avatarData(profile.account.avatarUrl);
    if (gen !== loginGeneration || repo !== settings().repo) throw new Error('登录已取消或仓库已改变');
    const next = { ...profile.account, avatarData: picture };
    persistAuth({ token: result.access_token, account: next }, ticket);
    token = result.access_token; account = next; permissions = profile.permissions;
    return account;
  }
  throw new Error('授权码已过期，请重新登录');
}
async function writeOperation(fn) {
  if (writeBusy || syncBusy) throw new Error('上一项操作正在进行，请勿重复操作');
  writeBusy = true;
  try { return await fn(); } finally { writeBusy = false; }
}
function handle(name, fn) {
  ipcMain.handle(name, async (event, ...args) => {
    if (event.sender !== win.webContents) throw new Error('非法调用');
    if (!['bootstrap', 'checkStartupUpdates', 'checkForUpdates', 'downloadUpdate', 'installUpdate', 'updateLocal', 'exportLocal'].includes(name)) ensureIdle();
    return fn(...args);
  });
}
function checkRecordRepo(record) {
  if (record.repo && record.repo !== settings().repo) throw new Error('该题解属于其他仓库，请切换到原仓库后操作');
  if (record.path && !record.repo) throw new Error('旧记录缺少仓库信息，请同步后重试');
}
function rememberDocument(result, removed = false) {
  const repo = settings().repo, old = read('cache.json', {});
  const c = repoCache(old, repo);
  const cache = c.repo === repo ? { ...c } : { repo, records: [], issues: [], blobs: {} };
  if (!cache.issues) cache.issues = (cache.records || []).filter(r => r.kind === 'issue').map(r => ({ ...r, repo }));
  cache.records = (cache.records || []).filter(r => r.kind === 'document' && r.id !== result.id);
  if (!removed) cache.records.unshift(result);
  const repos = { ...(old.repos || {}) };
  repos[repo] = cache;
  save('cache.json', { ...cache, repo, repos });
  // Legacy releases kept online documents in local.records, which could resurrect remote deletions.
  const personal = local();
  personal.published = { ...(personal.published || {}) };
  if (result.clientId && result.authorId) personal.published[`${repo}:${result.authorId}:${result.clientId}`] = result.path;
  personal.records = personal.records.filter(r => r.kind === 'local' && !(result.clientId && r.clientId === result.clientId && !r.proposalUrl && (r.ownerId == null || String(r.ownerId) === String(account?.id))));
  save('local.json', personal);
}
function setup() {
  planner = createPlannerService({ read, save });
  platforms = createPlatformService({ read, save, fetcher: networkFetch, readPage: createPublicPageReader({ BrowserWindow }) });
  // Public schedules use stateless Node fetch, separate from Chromium session cookies.
  contestService = createContestService({ fetcher: (url, options) => fetch(url, options), readCache: () => read('contests.json', null), writeCache: value => save('contests.json', value) });
  handle('bootstrap', () => state());
  handle('plannerAction', (action, payload) => planner.action(action, payload));
  handle('getContests', force => contestService.get(force));
  handle('bindPlatform', (platform, url) => platforms.bind(platform, url));
  handle('refreshPlatform', platform => platforms.refresh(platform));
  handle('unbindPlatform', platform => platforms.unbind(platform));
  handle('checkStartupUpdates', async () => {
    // Discovery only: normal reading, editing and sync remain available.
    if (updateBusy || installing) return null;
    try {
      if (app.isPackaged) cleanupUpdateStorage(dir, path.dirname(process.execPath), undefined, { downloads: false });
      return await updater.check();
    } catch { return null; }
  });
  handle('checkForUpdates', async () => {
    if (writeBusy || syncBusy || updateBusy || installing || platforms.isBusy()) throw new Error('请等待当前操作完成后检查更新');
    updateBusy = true;
    try {
      if (app.isPackaged) cleanupUpdateStorage(dir, path.dirname(process.execPath), undefined, { downloads: false });
      return await updater.check();
    } finally { updateBusy = false; }
  });
  handle('downloadUpdate', async () => {
    if (writeBusy || syncBusy || updateBusy || installing || platforms.isBusy()) throw new Error('请等待当前操作完成后下载更新');
    updateBusy = true;
    try { await updater.download(); return updater.getState(); } finally { updateBusy = false; }
  });
  handle('installUpdate', async () => {
    if (writeBusy || syncBusy || updateBusy || installing || platforms.isBusy()) throw new Error('请等待当前操作完成后安装更新');
    if (!app.isPackaged) throw new Error('源码运行模式不能覆盖升级，请使用安装版客户端');
    const capability = getFileUpgradeCapability();
    if (!capability.supported) throw new Error(capability.reason);
    updateBusy = true;
    try {
      const ready = await updater.verifyReady();
      const upgrade = prepareFileUpgrade({ userDataDir: dir, installDir: path.dirname(process.execPath), version: APP_VERSION, targetVersion: ready.version,
        ready, runtimeVersion: process.versions.electron, executablePath: process.execPath });
      // The detached helper waits for exit, then verifies, backs up and swaps app.asar.
      await new Promise((resolve, reject) => {
        let child, spawned = false, failed = false;
        const spawnFailed = error => {
          if (spawned || failed) return;
          failed = true;
          try { cancelPreparedFileUpgrade(dir, path.dirname(globalThis.process.execPath)); }
          catch (cancelError) { reject(new Error(`${error.message}；取消升级准备失败：${cancelError.message}`)); return; }
          reject(error);
        };
        try { child = spawn(globalThis.process.execPath, upgrade.args, { detached: true, stdio: 'ignore', windowsHide: true, shell: false, env: { ...processEnvForInstaller(), ...upgrade.env } }); }
        catch (error) { spawnFailed(error); return; }
        child.once('error', spawnFailed);
        child.once('spawn', () => { if (failed) return; spawned = true; child.unref(); resolve(); });
      });
      installing = true;
      setTimeout(() => app.quit(), 400);
      return { installing: true };
    } catch (error) { throw new Error(`启动升级失败：${error.message}。可重新尝试安装。`); }
    finally { updateBusy = false; }
  });
  handle('getTagCatalog', () => writeOperation(async () => {
    const repo = settings().repo;
    const catalog = await client().getTagCatalog();
    if (repo !== settings().repo) throw new Error('仓库配置已改变，请重新同步');
    const old = read('cache.json', {});
    const c = repoCache(old, repo);
    const updated = { ...(c.repo === repo ? c : {}), repo, tagCatalog: catalog, tagCatalogError: null };
    const repos = { ...(old.repos || {}) };
    repos[repo] = updated;
    save('cache.json', { ...updated, repo, repos });
    return catalog;
  }));
  handle('requestTag', data => writeOperation(() => client().requestTag(data)));
  handle('getTagReview', () => client().getTagReview());
  handle('reviewTag', data => writeOperation(async () => {
    const repo = settings().repo;
    const result = await client().reviewTag(data);
    if (repo === settings().repo && data.decision === 'approve') {
      const old = read('cache.json', {});
      const c = repoCache(old, repo);
      try {
        const tagCatalog = await client().getTagCatalog();
        const updated = { ...(c.repo === repo ? c : {}), repo, tagCatalog, tagCatalogError: null };
        const repos = { ...(old.repos || {}) };
        repos[repo] = updated;
        save('cache.json', { ...updated, repo, repos });
      }
      catch { /* Approval is already committed; preserve the successful result and refresh on next sync. */ }
    }
    return result;
  }));
  handle('saveAlgorithmTopic', data => writeOperation(async () => {
    const repo = settings().repo;
    const result = await client().saveAlgorithmTopic(data);
    if (repo !== settings().repo) throw new Error('仓库配置已改变，请重新同步');
    // Persist only the complete additions list returned after the repository commit succeeded.
    const old = read('cache.json', {});
    const c = repoCache(old, repo);
    const updated = { ...(c.repo === repo ? c : {}), repo, algorithmTopics: result.topics };
    const repos = { ...(old.repos || {}) };
    repos[repo] = updated;
    save('cache.json', { ...updated, repo, repos });
    return result.topic;
  }));
  handle('refreshAccount', async () => {
    if (!token) throw new Error('请先登录 GitHub');
    return writeOperation(() => refreshIdentity());
  });
  handle('sync', async () => {
    if (writeBusy || syncBusy) throw new Error('请等待当前操作完成');
    syncBusy = true;
    try {
      const repo = settings().repo, old = read('cache.json', {});
      const c = repoCache(old, repo);
      const result = await client().sync(c.repo === repo ? c : {});
      if (repo !== settings().repo) throw new Error('仓库配置已改变，请重新同步');
      let tagCatalog = c.repo === repo ? c.tagCatalog : null, tagCatalogError = null;
      try { tagCatalog = await client().getTagCatalog(); }
      catch (error) { tagCatalogError = error.status === 401 ? '标签目录授权已失效，请重新登录' : '标签目录暂未更新，继续使用已缓存的标签'; }
      if (repo !== settings().repo) throw new Error('仓库配置已改变，请重新同步');
      const updated = { ...result, repo, tagCatalog, tagCatalogError, algorithmNotes: Array.isArray(result.algorithmNotes) ? result.algorithmNotes : [], algorithmTopics: Array.isArray(result.algorithmTopics) ? result.algorithmTopics : [] };
      const repos = { ...(old.repos || {}) };
      repos[repo] = updated;
      save('cache.json', { ...updated, repo, repos });
      if (token) { try { await refreshIdentity(); } catch (error) { permissions = null; return state(`资料已同步，账号权限刷新失败：${error.message}`); } }
      return state();
    } finally { syncBusy = false; }
  });
  handle('saveSettings', data => {
    if (writeBusy || syncBusy) throw new Error('请等待当前操作完成后再修改设置');
    const old = settings(), next = { ...old };
    if (Array.isArray(data.repositories)) {
      if (data.repositories.length === 0) throw new Error('至少需要保留一个仓库配置');
      for (const item of data.repositories) {
        if (!item || typeof item !== 'object') throw new Error('仓库配置格式不正确');
        repoParts(item.repo);
        if (item.serverUrl) {
          const u = String(item.serverUrl).trim();
          if (!/^https?:\/\/[^\s$.?#].[^\s]*$/i.test(u)) throw new Error('Git 服务地址格式不正确');
        }
      }
      next.repositories = data.repositories;
    }
    if (data.activeRepoId !== undefined) {
      next.activeRepoId = String(data.activeRepoId).trim();
    }
    if (data.repo !== undefined && !data.repositories) {
      repoParts(data.repo);
      next.repo = data.repo;
      const match = next.repositories?.find(r => r.id === next.activeRepoId);
      if (match) match.repo = data.repo;
    }
    if (data.serverUrl !== undefined && !data.repositories) {
      const url = String(data.serverUrl).trim();
      if (url && !/^https?:\/\/[^\s$.?#].[^\s]*$/i.test(url)) throw new Error('Git 服务地址格式不正确');
      next.serverUrl = url;
      const match = next.repositories?.find(r => r.id === next.activeRepoId);
      if (match) match.serverUrl = url;
    }
    const normalized = normalizeRepositories(next, old.repo, old.serverUrl);
    next.repositories = normalized.repositories;
    next.activeRepoId = normalized.activeRepoId;
    next.repo = normalized.repo;
    next.serverUrl = normalized.serverUrl;

    if (data.clientId !== undefined) {
      if (!/^[A-Za-z0-9_.-]{0,100}$/.test(data.clientId)) throw new Error('Client ID 格式不正确');
      next.clientId = data.clientId.trim() || TEAM_CLIENT_ID;
    }
    if (data.theme !== undefined) next.theme = String(data.theme);
    if (data.displayName !== undefined) next.displayName = String(data.displayName).slice(0, 40);
    if (data.autoSync !== undefined) next.autoSync = !!data.autoSync;
    if (data.codeFontSize !== undefined) {
      const size = Math.round(Number(data.codeFontSize));
      if (!Number.isFinite(size) || size < 10 || size > 18) throw new Error('代码字号需在 10 到 18 之间');
      next.codeFontSize = size;
    }
    if (data.codeLineNumbers !== undefined) next.codeLineNumbers = !!data.codeLineNumbers;
    if (data.contestOptOuts !== undefined) {
      if (!Array.isArray(data.contestOptOuts) || data.contestOptOuts.length > 500) throw new Error('比赛偏好格式不正确');
      if (data.contestOptOuts.some(item => typeof item !== 'string' || !/^[a-z0-9-]{1,40}:[^\s:]{1,120}$/i.test(item))) throw new Error('比赛偏好格式不正确');
      next.contestOptOuts = [...new Set(data.contestOptOuts.map(item => item.trim()))];
    }
    if (next.repo !== old.repo || next.serverUrl !== old.serverUrl) permissions = null;
    if (next.clientId !== old.clientId || next.repo !== old.repo || next.serverUrl !== old.serverUrl) loginGeneration++;
    save('settings.json', next); return state();
  });
  handle('updateLocal', data => {
    if (writeBusy || syncBusy) throw new Error('线上操作进行中，请稍后保存本地内容');
    if (!data || typeof data !== 'object' || !Array.isArray(data.records)) throw new Error('本地数据格式错误');
    if (JSON.stringify(data).length > 20000000) throw new Error('本地内容过大');
    const old = local();
    const foreign = r => r.kind === 'local' && r.ownerId != null && String(r.ownerId) !== String(account?.id ?? '');
    if (data.records.some(r => !r || typeof r.id !== 'string')) throw new Error('本地记录缺少有效 ID');
    const incoming = new Map(data.records.map(r => [r.id, r]));
    if (incoming.size !== data.records.length) throw new Error('本地记录 ID 重复，拒绝保存');
    for (const record of old.records.filter(foreign)) {
      if (JSON.stringify(incoming.get(record.id)) !== JSON.stringify(record)) throw new Error('不能修改或删除其他账号的本地题解，请切换账号');
    }
    for (const record of data.records) {
      const previous = old.records.find(r => r.id === record.id);
      if (previous?.kind === 'local' && record.kind !== 'local') throw new Error('不能改变本地记录类型或账号归属');
      if (record.kind !== 'local') continue;
      if (previous?.ownerId != null && String(previous.ownerId) !== String(record.ownerId)) throw new Error('不能更改本地题解的账号归属');
      if ((!previous || previous.ownerId == null) && record.ownerId != null && String(record.ownerId) !== String(account?.id ?? '')) throw new Error('不能以其他账号创建或绑定本地题解');
    }
    const cache = read('cache.json', {});
    const published = { ...(old.published || {}) };
    for (const doc of cache.records || []) {
      if (cache.repo && doc.clientId && doc.authorId) published[`${cache.repo}:${doc.authorId}:${doc.clientId}`] = doc.path;
    }
    const records = data.records.filter(r => {
      if (r.kind !== 'local') return false;
      if (r.proposalUrl) return true;
      const owner = r.ownerId ?? account?.id;
      return !published[`${settings().repo}:${owner}:${r.clientId}`];
    });
    save('local.json', { ...old, ...data, records, published }); return local();
  });
  handle('login', login);
  handle('logout', () => {
    if (writeBusy || syncBusy) throw new Error('请等待当前操作完成后再退出');
    auth.logout(); loginGeneration++; token = ''; account = null; permissions = null; return state();
  });
  handle('cancelLogin', () => { loginGeneration++; });
  const saveDocument = record => writeOperation(async () => {
    checkRecordRepo(record);
    if (!account?.id || !token) throw new Error('请先登录 GitHub');
    if (!record.path) {
      const personal = local();
      const sources = personal.records.filter(r => r.kind === 'local' && r.clientId === record.clientId && r.id === record.id);
      if (sources.some(r => r.ownerId != null && String(r.ownerId) !== String(account.id))) throw new Error('不能上传其他账号的本地题解，请切换账号');
      let bound = false;
      for (const source of sources) {
        if (source.ownerId == null) { source.ownerId = String(account.id); bound = true; }
      }
      if (bound) save('local.json', personal);
    }
    const result = await client().saveDocument(record);
    rememberDocument(result); return result;
  });
  handle('saveDocument', saveDocument);
  handle('saveAlgorithmNote', record => writeOperation(async () => {
    checkRecordRepo(record);
    if (!account?.id || !token) throw new Error('请先登录 GitHub');
    const result = await client().saveAlgorithmNote(record);
    const cache = read('cache.json', {});
    const notes = (cache.algorithmNotes || []).filter(item => item.path !== result.path);
    save('cache.json', { ...(cache.repo === settings().repo ? cache : {}), repo: settings().repo, algorithmNotes: [...notes, result] });
    return result;
  }));
  handle('submit', saveDocument);
  handle('propose', saveDocument);
  handle('deleteDocument', record => writeOperation(async () => {
    checkRecordRepo(record);
    const result = await client().deleteDocument(record);
    rememberDocument(result, true); return result;
  }));
  handle('deleteIssue', record => writeOperation(async () => {
    if (record.repo !== settings().repo) throw new Error('讨论所属仓库已改变，请同步后重试');
    const result = await client().deleteIssue(record);
    const repo = settings().repo, cache = read('cache.json', {});
    if (cache.repo === repo) {
      cache.issues = (cache.issues || (cache.records || []).filter(r => r.kind === 'issue')).filter(r => r.number !== result.number);
      cache.records = (cache.records || []).filter(r => r.kind !== 'issue' || r.number !== result.number);
      save('cache.json', cache);
    }
    const personal = local();
    personal.favorites = personal.favorites.filter(id => String(id) !== result.id);
    delete personal.mastery[result.id];
    personal.records = personal.records.filter(r => r.kind === 'local');
    save('local.json', personal);
    return result;
  }));
  handle('comment', data => writeOperation(() => {
    if (data.repo !== settings().repo) throw new Error('讨论所属仓库已改变，请同步后重试');
    return client().comment(data);
  }));
  handle('getComments', async number => (await client().comments(number)).map(x => ({ id: x.id, body: x.body, author: x.user?.login || '', createdAt: x.created_at, url: x.html_url })));
  handle('openExternal', external);
  handle('openAuthUrl', openAuthUrl);
  handle('formatCode', (source, lang) => formatCode(source, lang).catch(error => ({ code: source, error: error.message })));
  handle('exportLocal', async () => {
    const { dialog } = require('electron');
    const result = await dialog.showSaveDialog(win, { defaultPath: '我的题解备份.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (!result.canceled) { fs.writeFileSync(result.filePath, JSON.stringify(local(), null, 2)); return true; }
    return false;
  });
}
app.whenReady().then(() => {
  dir = app.getPath('userData'); fs.mkdirSync(dir, { recursive: true });
  if (app.isPackaged) {
    const installDir = path.dirname(process.execPath);
    recoverFileUpgrade(dir, installDir);
    cleanupUpdateStorage(dir, installDir);
    // A helper still observing relaunch keeps its rollback files. The next
    // update check retries cleanup after it exits, without touching new downloads.
  }
  const personal = local(); let migrated = false;
  personal.records = personal.records.map(record => {
    if (record.kind !== 'local') return record;
    const ownerId = record.ownerId == null ? null : String(record.ownerId);
    if (record.clientId && record.ownerId === ownerId) return record;
    migrated = true; return { ...record, clientId: record.clientId || randomUUID(), ownerId };
  });
  if (migrated) save('local.json', personal);
  auth = createAuth({ safeStorage,
    // Do not use read(): credential read/parse failures must not be swallowed as signed-out.
    readAuth: () => JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8')),
    saveAuth: data => save('auth.json', data)
  });
  auth.restore(); token = auth.token; account = auth.account;
  win = new BrowserWindow({ width: 1440, height: 940, minWidth: 1050, minHeight: 700, title: '拾题 · QMX Notebook', backgroundColor: '#f6f7fb', autoHideMenuBar: true,
    webPreferences: { preload: process.argv.includes('--preview') ? undefined : path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  updater = createUpdater({
    currentVersion: APP_VERSION, runtimeVersion: process.versions.electron, downloadDir: path.join(dir, 'updates'),
    fetcher: networkFetch,
    installedArchive: app.isPackaged ? path.join(path.dirname(process.execPath), 'resources', 'app.asar') : undefined,
    onProgress: progress => { if (!win.isDestroyed()) win.webContents.send('update-progress', progress); }
  });
  win.on('close', event => {
    if (updateBusy && !installing) event.preventDefault();
  });
  setup(); win.loadFile(path.join(__dirname, '../ui/index.html'));
});
app.on('window-all-closed', () => { loginGeneration++; app.quit(); });
