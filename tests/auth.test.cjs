'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuth, configureUserData } = require('../electron/auth.cjs');

const storage = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() };
const alice = { id: 42, login: 'alice', name: 'Alice', avatarData: 'cached' };
function fixture(initial) {
  let saved = initial;
  return { make: (overrides = {}) => createAuth({ safeStorage: storage, readAuth: () => { if (saved === undefined) throw Object.assign(new Error(), { code: 'ENOENT' }); return saved; }, saveAuth: value => { saved = value; }, ...overrides }), get saved() { return saved; } };
}
test('encrypted credentials and account survive restart without changing identity fields', () => {
  const f = fixture(); const a = f.make(); a.restore(); a.commit('secret', alice);
  assert.ok(!JSON.stringify(f.saved).includes('secret'));
  const b = f.make(); assert.equal(b.restore(), true); assert.equal(b.token, 'secret'); assert.deepEqual(b.account, alice); assert.equal(b.status.status, 'restored');
});
test('401 invalidates only current session and persists without losing account ownership', () => {
  const f = fixture(); const a = f.make(); a.commit('secret', alice); a.failure({ status: 401 }, a.capture());
  assert.equal(a.token, ''); assert.deepEqual(a.account, alice); assert.equal(a.status.status, 'expired');
  const b = f.make(); b.restore(); assert.equal(b.token, ''); assert.deepEqual(b.account, alice); assert.equal(b.status.status, 'expired');
});
test('network, 403 and 429 errors preserve encrypted credentials for restart', () => {
  for (const error of [new Error('network'), { status: 403 }, { status: 429 }]) {
    const f = fixture(); const a = f.make(); a.commit('secret', alice); const saved = JSON.stringify(f.saved);
    a.failure(error, a.capture()); assert.equal(a.token, 'secret'); assert.equal(JSON.stringify(f.saved), saved);
    const b = f.make(); b.restore(); assert.equal(b.token, 'secret'); assert.equal(b.status.status, 'restored');
  }
});
test('stale 401 and stale identity completion cannot affect a switched account', () => {
  const f = fixture(); const a = f.make(); a.commit('old', alice); const old = a.capture();
  const bob = { id: 99, login: 'bob' }; a.commit('new', bob);
  assert.equal(a.failure({ status: 401 }, old), false);
  assert.throws(() => a.commit('old', alice, old), /账号已改变/);
  assert.equal(a.token, 'new'); assert.deepEqual(a.account, bob);
  const b = f.make(); b.restore(); assert.deepEqual(b.account, bob);
});
test('decrypt and read failures retain original data and expose non-secret diagnostics', () => {
  const f = fixture({ encrypted: 'YWJj' });
  const a = f.make({ safeStorage: { ...storage, decryptString() { throw new Error('secret exception'); } } });
  a.restore(); assert.equal(a.status.code, 'credential-decrypt-failed'); assert.deepEqual(f.saved, { encrypted: 'YWJj' });
  const b = f.make({ readAuth() { throw new Error('private path'); } }); b.restore();
  assert.equal(b.status.code, 'credential-read-failed'); assert.ok(!JSON.stringify(b.status).includes('private'));
});
test('failed secure persistence does not replace an existing account or expose exception secrets', () => {
  const f = fixture(); const initial = f.make(); initial.commit('old-secret', alice);
  const a = f.make({ saveAuth() { throw new Error('secret device details'); } }); a.restore();
  assert.throws(() => a.commit('new-secret', { id: 99, login: 'bob' }), /无法安全保存/);
  assert.equal(a.token, 'old-secret'); assert.deepEqual(a.account, alice);
  assert.ok(!JSON.stringify(a.status).includes('secret'));
  assert.throws(() => a.logout()); assert.equal(a.token, 'old-secret');
});
test('encryption unavailable and malformed payload remain recoverable without overwriting saved data', () => {
  for (const saved of [{ encrypted: 'broken' }, { encrypted: Buffer.from(JSON.stringify({ token: '', account: alice })).toString('base64') }]) {
    const f = fixture(saved); const a = f.make(); a.restore();
    assert.equal(a.status.status, 'recovery-required'); assert.deepEqual(f.saved, saved);
  }
  const f = fixture(); f.make().commit('secret', alice);
  const a = f.make({ safeStorage: { ...storage, isEncryptionAvailable: () => false } }); a.restore();
  assert.equal(a.status.code, 'keychain-unavailable'); assert.ok(f.saved.encrypted);
});
test('userData stays unchanged by default and explicit isolation must be absolute', () => {
  const calls = []; const app = { setPath: (...args) => calls.push(args) };
  configureUserData(app, { env: {}, argv: [] }); assert.deepEqual(calls, []);
  const path = require('node:path'); const target = path.resolve('isolated-test-data');
  configureUserData(app, { env: { QMX_USER_DATA_DIR: target }, argv: [] }); assert.deepEqual(calls, [['userData', target]]);
  assert.throws(() => configureUserData(app, { env: { QMX_USER_DATA_DIR: 'relative' }, argv: [] }), /绝对路径/);
});
