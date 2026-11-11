'use strict';
// Run with node tests/public-local-solution-smoke.cjs (Playwright + Microsoft Edge).
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

async function openPage(browser, signedIn = false) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
  page.setDefaultTimeout(8000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(signedIn => {
    const repo = 'test/notebook', ownerId = signedIn ? '101' : null;
    const problem = { id: 'document:docs/public.md', kind: 'document', repo, path: 'docs/public.md', sha: 'public-sha', authorId: '999', author: 'Other author', title: 'Public problem', platform: 'CF', pid: 'CF1900D', problemUrl: 'https://codeforces.com/problemset/problem/1900/D', tags: ['math'], rating: 1900, luoguDifficulty: '提高', body: 'Public solution must not become personal writing', updatedAt: '2026-11-11' };
    const local = { records: [
      { ...problem, id: 'foreign-local', clientId: 'foreign-client', kind: 'local', ownerId: '202', body: 'Foreign private solution' },
      ...(signedIn ? [
        { ...problem, id: 'unbound-local', clientId: 'unbound-client', kind: 'local', ownerId: null, body: 'Unbound solution' },
        { ...problem, id: 'owned-local', clientId: 'owned-client', kind: 'local', ownerId, body: 'Owned existing solution' }
      ] : [])
    ], favorites: [], mastery: {}, draft: { [JSON.stringify(['new', ownerId])]: { source: 'new', ownerId, clientId: 'general-draft', data: { body: 'Unrelated global draft', url: 'https://example.com/new' } } } };
    const fixture = window.fixture = { local, remoteCalls: 0 };
    const payload = () => ({ records: [problem], issues: [], account: signedIn ? { id: 101, login: 'reader' } : null, permissions: { repo, push: false, admin: false }, settings: { repo, autoSync: false }, local: fixture.local });
    window.notebook = { bootstrap: async () => structuredClone(payload()), sync: async () => structuredClone(payload()), updateLocal: async data => { fixture.local = structuredClone(data); }, saveDocument: async () => { fixture.remoteCalls++; throw new Error('Local action must not publish'); }, openExternal: async () => {} };
  }, signedIn);
  await page.goto(pathToFileURL(path.resolve(__dirname, '../ui/index.html')).href);
  try { await page.locator('.rail-nav-item[data-view="public"]').click(); } catch (error) { console.error('PAGE STARTUP ERRORS', errors); throw error; }
  await page.waitForSelector('#local-solution-button');
  return { page, errors };
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const { page, errors } = await openPage(browser);
    assert.equal(await page.locator('#edit-record-button').count(), 0, 'reader cannot edit source document');
    await page.click('#local-solution-button');
    assert.equal(await page.locator('#submit-title').innerText(), '写本地题解');
    assert.equal(await page.inputValue('#submit-form [name="url"]'), 'https://codeforces.com/problemset/problem/1900/D');
    assert.equal(await page.inputValue('#submit-form [name="title"]'), 'Public problem');
    assert.equal(await page.inputValue('#submit-form [name="pid"]'), 'CF1900D');
    assert.equal(await page.inputValue('#submit-form [name="rating"]'), '1900');
    assert.equal(await page.inputValue('#submit-form [name="luoguDifficulty"]'), '提高');
    assert.equal(await page.inputValue('#submit-form [name="tags"]'), 'math');
    assert.equal(await page.inputValue('#record-body'), '', 'source solution and foreign private record are not copied');
    assert.equal(await page.locator('#save-local-button').isEnabled(), true, 'anonymous no-push reader can save locally');
    await page.fill('#record-body', 'My draft in progress');
    await page.click('[data-close="submit-dialog"]');
    await page.waitForSelector('#submit-dialog', { state: 'hidden' });
    await page.click('#local-solution-button');
    assert.equal(await page.inputValue('#record-body'), 'My draft in progress', 'same problem resumes account-scoped draft');
    await page.fill('#record-body', 'My completed local solution');
    await page.click('#save-local-button');
    await page.waitForSelector('#submit-dialog', { state: 'hidden' });
    const created = await page.evaluate(() => fixture.local.records.find(record => record.ownerId == null));
    assert.equal(created.body, 'My completed local solution');
    assert.equal(created.sourceProblemId, 'document:docs/public.md');
    assert.equal(created.sourceProblemRepo, 'test/notebook');
    assert.equal(created.ownerId, null);
    assert.equal(await page.evaluate(() => fixture.remoteCalls), 0);
    assert.equal(await page.evaluate(() => fixture.local.draft[JSON.stringify(['new', null])].data.body), 'Unrelated global draft');
    await page.click('#detail-back-button');
    await page.locator('.record-card').click();
    await page.click('#local-solution-button');
    assert.equal(await page.inputValue('#record-body'), 'My completed local solution', 'saved same-problem local record is reused');
    assert.equal(await page.locator('#submit-title').innerText(), '编辑本地记录');
    await page.click('[data-close="submit-dialog"]');
    await page.click('#library-local-button');
    assert.equal(await page.locator('#library-local-button').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.record-card').count(), 1, 'local scope lists unbound local solutions and hides foreign-owned records');
    assert.equal(await page.locator('.record-card .card-title').innerText(), 'Public problem');
    await page.locator('.record-card').click();
    assert.equal(await page.locator('#edit-record-button').innerText(), '编辑本地记录');
    await page.click('#library-public-button');
    assert.equal(await page.locator('.record-card').count(), 1, 'public scope restores remote problems');
    assert.equal(await page.locator('#local-solution-button').count(), 1);
    assert.deepEqual(errors, []);
    await page.close();

    const owned = await openPage(browser, true);
    await owned.page.click('#local-solution-button');
    assert.equal(await owned.page.inputValue('#record-body'), 'Owned existing solution', 'account-owned record preferred over unbound and foreign matches');
    await owned.page.fill('#record-body', 'Updated owned local solution');
    await owned.page.click('#save-local-button');
    await owned.page.waitForSelector('#submit-dialog', { state: 'hidden' });
    const persisted = await owned.page.evaluate(() => fixture.local.records);
    assert.equal(persisted.length, 3, 'reusing an existing solution does not create a duplicate');
    assert.equal(persisted.find(record => record.id === 'owned-local').body, 'Updated owned local solution');
    assert.equal(persisted.find(record => record.id === 'owned-local').ownerId, '101');
    assert.equal(persisted.find(record => record.id === 'foreign-local').body, 'Foreign private solution');
    assert.equal(await owned.page.evaluate(() => fixture.remoteCalls), 0);
    assert.deepEqual(owned.errors, []);
    console.log('PUBLIC LOCAL SOLUTION PASS (anonymous/no push, metadata, private isolation, per-problem drafts, existing-record reuse, no publishing)');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
