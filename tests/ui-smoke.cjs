'use strict';
// Run with: node tests/ui-smoke.cjs (requires Playwright and Microsoft Edge).
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.addInitScript(() => {
      const repo = 'test/notebook';
      let account = { id: 101, login: 'same-name', name: 'Same Name' };
      const documentRecord = { id: 'document:docs/original.md', kind: 'document', path: 'docs/original.md', sha: 'original-sha', repo, authorId: 101, author: 'Same Name', title: 'Owned formal document', body: '## Full raw body\n\nOriginal **Markdown**', problemUrl: 'https://example.com/problem', updatedAt: '2026-01-01' };
      const fixture = window.fixture = {
        docs: [documentRecord], calls: [], failSave: false,
        local: { records: [
          { id: 'legacy-foreign-id', clientId: 'foreign-client', kind: 'local', ownerId: '202', title: 'Foreign private local', body: 'private', problemUrl: 'https://example.com/foreign' },
          { id: 'legacy-unbound-id', kind: 'local', ownerId: null, title: 'Unbound existing local', body: 'unbound', problemUrl: 'https://example.com/free' },
          { id: documentRecord.id, kind: 'document', ...documentRecord, title: 'STALE LOCAL COPY' }
        ], favorites: ['legacy-unbound-id'], mastery: { 'legacy-unbound-id': 'mastered' }, draft: {} }
      };
      const payload = () => structuredClone({ records: fixture.docs, issues: [{ id: 'issue:1', kind: 'issue', number: 1, repo, title: 'Existing discussion', body: 'Discussion' }], account, permissions: { repo, push: true, admin: false }, settings: { repo, autoSync: false }, local: fixture.local });
      fixture.payload = payload;
      fixture.getAccount = () => account;
      fixture.setAccount = value => { account = value; };
      window.notebook = {
        bootstrap: async () => payload(), sync: async () => payload(),
        updateLocal: async local => { fixture.calls.push({ method: 'updateLocal', local: structuredClone(local) }); fixture.local = structuredClone(local); },
        saveDocument: async record => {
          fixture.calls.push({ method: 'saveDocument', record: structuredClone(record) });
          if (fixture.failSave) throw new Error('Mock GitHub save failed');
          const saved = { ...record, id: 'document:' + (record.path || 'docs/new.md'), path: record.path || 'docs/new.md', sha: 'updated-sha', kind: 'document', authorId: account.id, author: account.login };
          fixture.docs = [...fixture.docs.filter(item => item.path !== saved.path), saved];
          return structuredClone(saved);
        },
        deleteDocument: async input => { fixture.calls.push({ method: 'deleteDocument', input }); fixture.docs = fixture.docs.filter(item => item.path !== input.path); return { deleted: true }; },
        logout: async () => { account = null; },
        login: async () => { account = { id: 202, login: 'same-name', name: 'Same Name' }; return account; },
        refreshAccount: async () => payload(), getComments: async () => [], openExternal: async () => {}
      };
    });
    await page.goto(pathToFileURL(path.resolve(__dirname, '../ui/index.html')).href);
    await page.waitForSelector('.record-card');
    assert.match(await page.locator('#record-list').innerText(), /Owned formal document/);
    assert.doesNotMatch(await page.locator('#record-list').innerText(), /STALE LOCAL COPY|Existing discussion/);
    await page.click('[data-view="discussion"]');
    assert.match(await page.locator('#record-list').innerText(), /Existing discussion/);
    assert.equal(await page.locator('#edit-record-button').count(), 0);
    await page.click('[data-view="favorites"]');
    assert.match(await page.locator('#record-list').innerText(), /Unbound existing local/);
    await page.click('[data-view="mine"]');
    assert.doesNotMatch(await page.locator('#record-list').innerText(), /Foreign private local/);
    await page.click('#submit-button');
    await page.fill('[name="url"]', 'https://example.com/local');
    await page.fill('[name="title"]', 'New local CRUD');
    const rawBody = '## Untouched raw\n\nA **complete** solution.\n\n```cpp\nint x = 1;\n```';
    await page.fill('#record-body', rawBody);
    await page.click('#save-local-button');
    await page.waitForSelector('#submit-dialog', { state: 'hidden' });
    let local = await page.evaluate(() => fixture.local);
    const created = local.records.find(record => record.title === 'New local CRUD');
    assert.equal(created.ownerId, '101');
    assert.match(created.clientId, /^[0-9a-f-]{36}$/i);
    assert(local.records.some(record => record.id === 'legacy-foreign-id'), 'foreign record must survive persistence');
    assert(local.records.some(record => record.id === 'legacy-unbound-id'), 'legacy ID must remain stable');
    assert(!local.records.some(record => record.kind !== 'local'), 'stale online copies must be filtered');
    await page.click('#edit-record-button');
    assert.equal(await page.inputValue('#record-body'), rawBody);
    await page.click('#save-local-button');
    await page.waitForSelector('#submit-dialog', { state: 'hidden' });
    assert.equal(await page.evaluate(() => fixture.local.records.find(record => record.title === 'New local CRUD').clientId), created.clientId);
    await page.click('#delete-record-button');
    await page.waitForFunction(() => !fixture.local.records.some(record => record.title === 'New local CRUD'));
    assert.equal(await page.evaluate(() => fixture.calls.filter(call => call.method === 'deleteDocument').length), 0, 'local deletion must never call GitHub');

    await page.getByRole('button', { name: /Owned formal document/ }).click();
    await page.click('#edit-record-button');
    assert(await page.locator('#save-local-button').isDisabled());
    await page.fill('#record-body', '## Edited remote\n\nFull new body');
    await page.evaluate(() => { fixture.failSave = true; });
    await page.click('#publish-button');
    await page.waitForSelector('#submit-error:not([hidden])');
    assert.match(await page.locator('#submit-error').innerText(), /Mock GitHub save failed/);
    assert.equal(await page.inputValue('#record-body'), '## Edited remote\n\nFull new body');
    assert(await page.locator('#submit-dialog').isVisible());
    await page.waitForFunction(() => Object.values(fixture.local.draft).some(draft => draft.data?.body === '## Edited remote\n\nFull new body'));
    // A reopened draft must retain its original base SHA even after sync sees a newer revision.
    await page.click('[data-close="submit-dialog"]');
    await page.evaluate(() => { fixture.docs[0].sha = 'changed-by-another-device'; });
    await page.click('#sync-button');
    await page.click('#edit-record-button');
    assert.equal(await page.inputValue('#record-body'), '## Edited remote\n\nFull new body');
    await page.evaluate(() => { fixture.failSave = false; });
    await page.click('#publish-button');
    await page.waitForSelector('#submit-dialog', { state: 'hidden' });
    const save = await page.evaluate(() => fixture.calls.filter(call => call.method === 'saveDocument').at(-1).record);
    assert.equal(save.path, 'docs/original.md'); assert.equal(save.sha, 'original-sha'); assert.equal(save.repo, 'test/notebook');
    assert.equal(save.body, '## Edited remote\n\nFull new body');
    await page.click('#delete-record-button');
    await page.waitForFunction(() => fixture.calls.some(call => call.method === 'deleteDocument'));
    const deletion = await page.evaluate(() => fixture.calls.find(call => call.method === 'deleteDocument').input);
    assert.deepEqual(deletion, { path: 'docs/original.md', sha: 'updated-sha', repo: 'test/notebook' });
    await page.click('#sync-button');
    await page.click('[data-view="public"]');
    assert.equal(await page.locator('.record-card').count(), 0, 'sync must not resurrect deleted doc from stale local data');

    // Persist the new document identity before any remote write; retry/reopen uses that identity.
    await page.click('#submit-button');
    await page.fill('[name="url"]', 'https://example.com/retry');
    await page.fill('[name="title"]', 'Retry new document');
    await page.fill('#record-body', 'New solution');
    await page.evaluate(() => { fixture.failSave = true; });
    await page.click('#publish-button');
    await page.waitForSelector('#submit-error:not([hidden])');
    const firstCreate = await page.evaluate(() => fixture.calls.filter(call => call.method === 'saveDocument').at(-1).record);
    const persistedIdentity = await page.evaluate(() => Object.values(fixture.local.draft).find(draft => draft.source === 'new').clientId);
    assert.equal(firstCreate.clientId, persistedIdentity);
    await page.click('[data-close="submit-dialog"]');
    await page.click('#submit-button');
    assert.equal(await page.inputValue('#record-body'), 'New solution');
    await page.click('#publish-button');
    await page.waitForSelector('#submit-error:not([hidden])');
    const retryCreate = await page.evaluate(() => fixture.calls.filter(call => call.method === 'saveDocument').at(-1).record);
    assert.equal(retryCreate.clientId, firstCreate.clientId, 'new document retries must reuse persisted identity');
    await page.click('[data-close="submit-dialog"]');

    await page.click('[data-view="mine"]');
    await page.getByRole('button', { name: /Unbound existing local/ }).click();
    await page.click('#edit-record-button');
    await page.click('#publish-button');
    await page.waitForSelector('#submit-error:not([hidden])');
    assert.equal(await page.evaluate(() => fixture.local.records.find(item => item.id === 'legacy-unbound-id').ownerId), '101', 'confirmed first upload must bind before failed remote request');
    await page.click('[data-close="submit-dialog"]');

    await page.click('#account-button'); await page.click('#account-switch');
    await page.waitForFunction(() => document.querySelector('#account-details').textContent.includes('202'));
    await page.click('[data-close="account-dialog"]'); await page.click('[data-view="mine"]');
    assert.match(await page.locator('#record-list').innerText(), /Foreign private local/);
    assert.doesNotMatch(await page.locator('#record-list').innerText(), /Unbound existing local/, 'failed upload must keep confirmed ownership after account switch');

    // Anonymous quota exhaustion offers the existing device-flow login and retries the pull after authorizing.
    await page.click('#account-button');
    await page.click('#account-logout');
    await page.waitForFunction(() => document.querySelector('#account-details').textContent.includes('未登录'));
    await page.click('[data-close="account-dialog"]');
    await page.evaluate(() => {
      fixture.loginCalls = 0;
      fixture.syncCalls = 0;
      window.notebook.sync = async () => { fixture.syncCalls++; throw new Error('GitHub 请求额度已用完，预计 20:16:57 恢复，缓存仍可使用'); };
    });
    await page.click('#sync-button');
    await page.waitForSelector('#banner-login-button');
    assert.match(await page.locator('#status-banner').innerText(), /登录 GitHub 后，同步额度/);
    assert.equal(await page.locator('#account-caption').innerText(), '未登录 · 点此登录提升额度');
    // The whole sidebar account row is the login target now, not just the small arrow.
    await page.click('.account-avatar');
    await page.waitForSelector('#account-dialog[open]');
    await page.click('[data-close="account-dialog"]');
    await page.evaluate(() => {
      window.notebook.login = async () => { fixture.loginCalls++; fixture.setAccount({ id: 303, login: 'rate-limited-user', name: 'Rate Limited' }); };
      window.notebook.sync = async () => {
        fixture.syncCalls++;
        if (!fixture.getAccount()) throw new Error('GitHub 请求额度已用完，预计 20:16:57 恢复，缓存仍可使用');
        return fixture.payload();
      };
    });
    await page.click('#banner-login-button');
    await page.waitForFunction(() => fixture.loginCalls === 1);
    await page.waitForFunction(() => fixture.syncCalls >= 2);
    await page.waitForFunction(() => document.querySelector('#status-banner').hidden);
    assert.match(await page.locator('#account-name').innerText(), /Rate Limited/);

    // Logging in from the account dialog retries the blocked pull too.
    await page.click('#account-button');
    await page.click('#account-logout');
    await page.waitForFunction(() => document.querySelector('#account-details').textContent.includes('未登录'));
    await page.click('[data-close="account-dialog"]');
    await page.evaluate(() => {
      fixture.loginCalls = 0;
      fixture.syncCalls = 0;
      window.notebook.sync = async () => { fixture.syncCalls++; throw new Error('GitHub 请求额度已用完，预计 20:16:57 恢复，缓存仍可使用'); };
    });
    await page.click('#sync-button');
    await page.waitForSelector('#banner-login-button');
    await page.evaluate(() => {
      window.notebook.login = async () => { fixture.loginCalls++; fixture.setAccount({ id: 404, login: 'dialog-user', name: 'Dialog User' }); };
      window.notebook.sync = async () => {
        fixture.syncCalls++;
        if (!fixture.getAccount()) throw new Error('GitHub 请求额度已用完，预计 20:16:57 恢复，缓存仍可使用');
        return fixture.payload();
      };
    });
    await page.click('#account-button');
    await page.click('#account-login');
    await page.waitForFunction(() => fixture.loginCalls === 1);
    await page.waitForFunction(() => fixture.syncCalls >= 2);
    await page.waitForFunction(() => document.querySelector('#status-banner').hidden);
    assert.match(await page.locator('#account-name').innerText(), /Dialog User/);

    assert.deepEqual(errors, []);
    console.log('UI PASS: local CRUD, legacy IDs, foreign isolation, canonical Markdown, original path/SHA update/delete, failed edit draft, sync deletion, discussion, accounts and rate-limit login retry');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
