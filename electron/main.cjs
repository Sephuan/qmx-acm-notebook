'use strict';
const { app, BrowserWindow, ipcMain, shell, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { GitHub, repoParts } = require('./github.cjs');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createUpdater } = require('./updater.cjs');
const { prepareUpgrade } = require('./upgrade.cjs');
const APP_VERSION = require('../package.json').version;
app.disableHardwareAcceleration();
let win, dir, token = '', account = null, permissions = null;
let loginGeneration = 0, writeBusy = false, syncBusy = false, updateBusy = false, installing = false, updater;
function processEnvForInstaller() {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}
function ensureIdle() {
  if (updateBusy || installing) throw new Error('客户端正在更新，请等待更新完成');
}
const defaults = { repo: 'qmx-acm-data/2026', clientId: '', theme: 'light' };
function read(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { return fallback; }
}
function save(name, data) {
  const file = path.join(dir, name);
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2));
  fs.renameSync(file + '.tmp', file);
}
function settings() { return { ...defaults, ...read('settings.json', {}) }; }
function local() { return { records: [], favorites: [], mastery: {}, draft: {}, ...read('local.json', {}) }; }
function client() { return new GitHub({ repo: settings().repo, token }); }
function state(error) {
  const s = settings(), cache = read('cache.json', {});
  // Old caches mixed Issues into records. Keep the two sources separate even before first sync.
  const matching = cache.repo === s.repo;
  return {
    records: matching ? (cache.records || []).filter(r => r.kind === 'document').map(r => ({ ...r, repo: s.repo })) : [],
    issues: matching ? (cache.issues || (cache.records || []).filter(r => r.kind === 'issue')).map(r => ({ ...r, repo: s.repo })) : [],
    lastSync: matching ? cache.lastSync : null,
    settings: s, account, appVersion: APP_VERSION, update: updater?.getState(), permissions: permissions?.repo === s.repo ? permissions : null,
    local: local(), error: error || null
  };
}
async function external(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !['github.com', 'codeforces.com', 'atcoder.jp', 'www.luogu.com.cn', 'luogu.com.cn', 'ac.nowcoder.com', 'www.nowcoder.com', 'contest.codeforces.com'].includes(u.hostname)) throw new Error('仅允许打开 GitHub 和受支持题目平台的 HTTPS 链接');
  await shell.openExternal(u.href);
}
function persistAuth(data) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，无法安全保存登录');
  save('auth.json', { encrypted: safeStorage.encryptString(JSON.stringify(data)).toString('base64') });
}
async function avatarData(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname !== 'avatars.githubusercontent.com') return null;
    u.searchParams.set('s', '80');
    const response = await fetch(u, { signal: AbortSignal.timeout(7000), redirect: 'error' });
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
  const gen = loginGeneration, repo = settings().repo;
  const result = await gh.profile();
  const picture = await avatarData(result.account.avatarUrl);
  if (gen !== loginGeneration || repo !== settings().repo) throw new Error('账号或仓库已改变，请重试');
  const next = { ...result.account, avatarData: picture };
  persistAuth({ token, account: next }); account = next; permissions = result.permissions;
  return state();
}
async function oauth(endpoint, data) {
  const response = await fetch(`https://github.com/login/${endpoint}`, {
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
  const gen = ++loginGeneration;
  const code = await oauth('device/code', { client_id: id, scope: 'public_repo' });
  if (gen !== loginGeneration) throw new Error('已取消登录');
  if (code.error) throw new Error(code.error_description || code.error);
  win.webContents.send('auth-progress', { userCode: code.user_code, url: code.verification_uri, expiresIn: code.expires_in });
  await external(code.verification_uri);
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
    const gh = new GitHub({ token: result.access_token, repo });
    const profile = await gh.profile();
    const picture = await avatarData(profile.account.avatarUrl);
    if (gen !== loginGeneration || repo !== settings().repo) throw new Error('登录已取消或仓库已改变');
    const next = { ...profile.account, avatarData: picture };
    persistAuth({ token: result.access_token, account: next });
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
    if (!['bootstrap', 'checkForUpdates', 'downloadUpdate', 'installUpdate', 'updateLocal', 'exportLocal'].includes(name)) ensureIdle();
    return fn(...args);
  });
}
function checkRecordRepo(record) {
  if (record.repo && record.repo !== settings().repo) throw new Error('该题解属于其他仓库，请切换到原仓库后操作');
  if (record.path && !record.repo) throw new Error('旧记录缺少仓库信息，请同步后重试');
}
function rememberDocument(result, removed = false) {
  const repo = settings().repo, old = read('cache.json', {});
  const cache = old.repo === repo ? old : { repo, records: [], issues: [], blobs: {} };
  if (!cache.issues) cache.issues = (cache.records || []).filter(r => r.kind === 'issue').map(r => ({ ...r, repo }));
  cache.records = (cache.records || []).filter(r => r.kind === 'document' && r.id !== result.id);
  if (!removed) cache.records.unshift(result);
  save('cache.json', cache);
  // Legacy releases kept online documents in local.records, which could resurrect remote deletions.
  const personal = local();
  personal.published = { ...(personal.published || {}) };
  if (result.clientId && result.authorId) personal.published[`${repo}:${result.authorId}:${result.clientId}`] = result.path;
  personal.records = personal.records.filter(r => r.kind === 'local' && !(result.clientId && r.clientId === result.clientId && !r.proposalUrl && (r.ownerId == null || String(r.ownerId) === String(account?.id))));
  save('local.json', personal);
}
function setup() {
  handle('bootstrap', () => state());
  handle('checkForUpdates', async () => {
    if (writeBusy || syncBusy || updateBusy || installing) throw new Error('请等待当前操作完成后检查更新');
    updateBusy = true;
    try { return await updater.check(); } finally { updateBusy = false; }
  });
  handle('downloadUpdate', async () => {
    if (writeBusy || syncBusy || updateBusy || installing) throw new Error('请等待当前操作完成后下载更新');
    updateBusy = true;
    try { await updater.download(); return updater.getState(); } finally { updateBusy = false; }
  });
  handle('installUpdate', async () => {
    if (writeBusy || syncBusy || updateBusy || installing) throw new Error('请等待当前操作完成后安装更新');
    if (!app.isPackaged) throw new Error('源码运行模式不能覆盖升级，请使用安装版客户端');
    updateBusy = true;
    try {
      const ready = await updater.verifyReady();
      const upgrade = prepareUpgrade({ userDataDir: dir, installDir: path.dirname(process.execPath), version: APP_VERSION, targetVersion: ready.version });
      // Installer upgrades the exact existing installation; userData is separately backed up.
      await new Promise((resolve, reject) => {
        const process = spawn(ready.path, upgrade.args, { detached: true, stdio: 'ignore', windowsHide: true, shell: false, env: { ...processEnvForInstaller() } });
        process.once('error', reject);
        process.once('spawn', () => { process.unref(); resolve(); });
      });
      installing = true;
      setTimeout(() => app.quit(), 400);
      return { installing: true };
    } catch (error) { throw new Error(`启动升级失败：${error.message}。可重新尝试安装。`); }
    finally { updateBusy = false; }
  });
  handle('refreshAccount', async () => {
    if (!token) throw new Error('请先登录 GitHub');
    return writeOperation(() => refreshIdentity());
  });
  handle('sync', async () => {
    if (writeBusy || syncBusy) throw new Error('请等待当前操作完成');
    syncBusy = true;
    try {
      const repo = settings().repo, old = read('cache.json', {});
      const result = await client().sync(old.repo === repo ? old : {});
      if (repo !== settings().repo) throw new Error('仓库配置已改变，请重新同步');
      save('cache.json', { ...result, repo });
      if (token) { try { await refreshIdentity(); } catch (error) { permissions = null; return state(`资料已同步，账号权限刷新失败：${error.message}`); } }
      return state();
    } finally { syncBusy = false; }
  });
  handle('saveSettings', data => {
    if (writeBusy || syncBusy) throw new Error('请等待当前操作完成后再修改设置');
    const old = settings(), next = { ...old };
    if (data.repo !== undefined) { repoParts(data.repo); next.repo = data.repo; }
    if (data.clientId !== undefined) {
      if (!/^[A-Za-z0-9_.-]{0,100}$/.test(data.clientId)) throw new Error('Client ID 格式不正确');
      next.clientId = data.clientId;
    }
    if (data.theme !== undefined) next.theme = String(data.theme);
    if (data.displayName !== undefined) next.displayName = String(data.displayName).slice(0, 40);
    if (data.autoSync !== undefined) next.autoSync = !!data.autoSync;
    if (next.repo !== old.repo) permissions = null;
    if (next.clientId !== old.clientId || next.repo !== old.repo) loginGeneration++;
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
    loginGeneration++; token = ''; account = null; permissions = null; save('auth.json', {}); return state();
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
  handle('exportLocal', async () => {
    const { dialog } = require('electron');
    const result = await dialog.showSaveDialog(win, { defaultPath: '我的题解备份.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (!result.canceled) { fs.writeFileSync(result.filePath, JSON.stringify(local(), null, 2)); return true; }
    return false;
  });
}
app.whenReady().then(() => {
  dir = app.getPath('userData'); fs.mkdirSync(dir, { recursive: true });
  const personal = local(); let migrated = false;
  personal.records = personal.records.map(record => {
    if (record.kind !== 'local') return record;
    const ownerId = record.ownerId == null ? null : String(record.ownerId);
    if (record.clientId && record.ownerId === ownerId) return record;
    migrated = true; return { ...record, clientId: record.clientId || randomUUID(), ownerId };
  });
  if (migrated) save('local.json', personal);
  try {
    const saved = read('auth.json', {});
    if (saved.encrypted) {
      const data = JSON.parse(safeStorage.decryptString(Buffer.from(saved.encrypted, 'base64')));
      token = data.token; account = data.account;
    }
  } catch { /* Local records stay available if credentials cannot be decrypted. */ }
  win = new BrowserWindow({ width: 1440, height: 940, minWidth: 1050, minHeight: 700, title: '拾题 · QMX Notebook', backgroundColor: '#f6f7fb', autoHideMenuBar: true,
    webPreferences: { preload: process.argv.includes('--preview') ? undefined : path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  updater = createUpdater({
    currentVersion: APP_VERSION, downloadDir: path.join(dir, 'updates'),
    onProgress: progress => { if (!win.isDestroyed()) win.webContents.send('update-progress', progress); }
  });
  win.on('close', event => {
    if (updateBusy && !installing) event.preventDefault();
  });
  setup(); win.loadFile(path.join(__dirname, '../ui/index.html'));
});
app.on('window-all-closed', () => { loginGeneration++; app.quit(); });
