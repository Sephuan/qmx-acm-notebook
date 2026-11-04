'use strict';

// Dependency injection keeps tests away from Electron's real keychain and userData.
function createAuth({ safeStorage, readAuth, saveAuth, now = () => new Date().toISOString() }) {
  let token = '', account = null, revision = 0;
  let status = { status: 'anonymous', code: null, transport: 'electron-net' };
  const report = (value, code = null) => { status = { status: value, code, transport: 'electron-net', checkedAt: now() }; };
  const validAccount = value => value && Number.isSafeInteger(value.id) && value.id > 0 && typeof value.login === 'string' && Boolean(value.login.trim());
  const validToken = value => typeof value === 'string' && Boolean(value.trim()) && !/[\r\n]/.test(value);
  function encode(data) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，无法安全保存登录');
    return { encrypted: safeStorage.encryptString(JSON.stringify(data)).toString('base64') };
  }
  function restore() {
    let saved;
    try { saved = readAuth(); }
    catch (error) {
      if (error.code === 'ENOENT') { report('anonymous'); return false; }
      report('recovery-required', 'credential-read-failed'); return false;
    }
    if (saved && typeof saved === 'object' && !Array.isArray(saved) && Object.keys(saved).length === 0) { report('anonymous'); return false; }
    if (!saved || typeof saved.encrypted !== 'string' || !saved.encrypted || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(saved.encrypted)) {
      report('recovery-required', 'credential-format-invalid'); return false;
    }
    try {
      if (!safeStorage.isEncryptionAvailable()) { report('recovery-required', 'keychain-unavailable'); return false; }
      const data = JSON.parse(safeStorage.decryptString(Buffer.from(saved.encrypted, 'base64')));
      if (!validAccount(data.account) || (data.invalidated !== true && !validToken(data.token))) {
        report('recovery-required', 'credential-format-invalid'); return false;
      }
      token = data.invalidated === true ? '' : data.token; account = data.account; revision++;
      report(data.invalidated === true ? 'expired' : 'restored', data.invalidated === true ? 'http-401' : null);
      return Boolean(token);
    } catch { report('recovery-required', 'credential-decrypt-failed'); return false; }
  }
  function capture() { return { revision, token }; }
  function current(ticket) { return ticket.revision === revision && ticket.token === token; }
  function commit(nextToken, nextAccount, ticket = capture()) {
    if (!current(ticket)) throw new Error('账号已改变，请重试');
    if (!validToken(nextToken) || !validAccount(nextAccount)) throw new Error('登录资料格式不正确');
    try { saveAuth(encode({ token: nextToken, account: nextAccount })); }
    catch { report('recovery-required', 'credential-save-failed'); throw new Error('无法安全保存 GitHub 登录，原凭据未主动清除；请检查系统加密和数据目录权限后重试'); }
    token = nextToken; account = nextAccount; revision++; report('verified');
  }
  function failure(error, ticket) {
    if (!current(ticket) || !ticket.token) return false;
    if (error.status === 401) {
      // Preserve identity/ownership locally, but never send a confirmed expired token again.
      token = ''; revision++; report('expired', 'http-401');
      try { saveAuth(encode({ token: '', account, invalidated: true })); }
      catch { report('expired', 'credential-invalidation-save-failed'); }
    } else if (error.status === 403 || error.status === 429) report('unverified', `http-${error.status}`);
    else report('unverified', error.status ? 'http-other' : 'network-unavailable');
    return true;
  }
  function logout() {
    // Persist first: failure must not claim credentials were durably removed.
    saveAuth({}); token = ''; account = null; revision++; report('anonymous');
  }
  return { restore, capture, current, commit, failure, logout,
    get token() { return token; }, get account() { return account; }, get status() { return { ...status }; } };
}

function configureUserData(app, { env = process.env, argv = process.argv, path = require('node:path') } = {}) {
  const argument = argv.find(value => value.startsWith('--qmx-user-data-dir='));
  const explicit = argument ? argument.slice('--qmx-user-data-dir='.length) : env.QMX_USER_DATA_DIR;
  const chromium = app.commandLine?.getSwitchValue('user-data-dir');
  const directory = explicit !== undefined ? explicit : (chromium || undefined);
  if (directory !== undefined) {
    if (!directory || !path.isAbsolute(directory)) throw new Error('隔离数据目录必须是明确的绝对路径');
    app.setPath('userData', path.resolve(directory));
  }
  // Do not rename the application or move the established installed profile.
}
module.exports = { createAuth, configureUserData };
