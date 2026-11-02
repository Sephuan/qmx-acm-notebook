'use strict';
// Run with: node tests/update-ui-smoke.cjs (requires Playwright and Microsoft Edge).
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const errors = [];
  async function fixturePage(options = {}) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(options => {
      let progress;
      const fixture = window.fixture = { calls: [], ...options };
      const version = { currentVersion: '1.2.3', latestVersion: options.available === false ? '1.2.3' : '1.3.0', available: options.available !== false };
      window.notebook = {
        bootstrap: async () => ({ appVersion: '1.2.3', update: { phase: 'idle', available: false, latestVersion: null, message: '' }, account: null, settings: { autoSync: false }, local: { records: [], favorites: [], mastery: {}, draft: {} } }),
        onAuthProgress: callback => { fixture.auth = callback; },
        onUpdateProgress: callback => { progress = callback; fixture.progress = callback; },
        checkForUpdates: async () => { fixture.calls.push('check'); if (fixture.failCheck) throw new Error('Check failed'); progress({ ...version, phase: 'checking' }); return { ...version, phase: version.available ? 'available' : 'idle', message: version.available ? 'New release available' : 'Already up to date' }; },
        updateLocal: async () => { fixture.calls.push('persist'); if (fixture.failPersist || (fixture.failSecondPersist && fixture.calls.filter(call => call === 'persist').length === 2)) throw new Error('Local disk failed'); },
        downloadUpdate: async () => {
          fixture.calls.push('download');
          progress({ ...version, phase: 'downloading', downloaded: 1048576, total: 2097152, percent: 50, message: 'Download in progress' });
          if (fixture.holdDownload) await new Promise(resolve => { fixture.finishDownload = resolve; });
          if (fixture.failDownload) throw new Error('Download failed');
          progress({ ...version, phase: 'ready' });
          return { ...version, phase: 'ready' };
        },
        installUpdate: async () => { fixture.calls.push('install'); if (fixture.failInstall) throw new Error('Installer failed'); return { installing: true }; }
      };
    }, options);
    await page.goto(pathToFileURL(path.resolve(__dirname, '../ui/index.html')).href);
    await page.waitForFunction(() => document.querySelector('#sync-status').textContent === '尚未同步');
    await page.click('#account-button');
    assert.equal(await page.locator('#app-version').innerText(), '1.2.3');
    assert.doesNotMatch(await page.locator('#update-status').innerText(), /最新版本/, 'initial idle state is not a completed check');
    assert(await page.locator('#account-login').isVisible());
    assert(await page.locator('#check-update-button').isEnabled(), 'signed out users may check');
    assert.match(await page.locator('#update-notice').innerText(), /自动下载并启动安装/);
    return page;
  }
  const calls = page => page.evaluate(() => fixture.calls);
  const settled = page => page.waitForFunction(() => !document.querySelector('#check-update-button').disabled);
  try {
    let page = await fixturePage({ available: false });
    await page.click('#check-update-button'); await settled(page);
    assert.match(await page.locator('#update-status').innerText(), /最新版本/);
    assert.deepEqual(await calls(page), ['check']);
    await page.close();

    page = await fixturePage({ holdDownload: true });
    await page.evaluate(() => { document.querySelector('#account-error').hidden = false; document.querySelector('#account-error').textContent = 'Existing account error'; });
    await page.click('#check-update-button');
    await page.waitForFunction(() => !!fixture.finishDownload);
    assert.match(await page.locator('#update-status').innerText(), /50%/);
    assert.equal(await page.locator('#update-progress').evaluate(node => node.value), 50);
    for (const selector of ['#account-login', '#submit-button', '#settings-button', '#theme-select', '[data-close="account-dialog"]']) assert(await page.locator(selector).isDisabled(), selector);
    await page.keyboard.press('Escape');
    assert(await page.locator('#account-dialog').isVisible(), 'busy dialog cannot close');
    assert.equal(await page.locator('#account-error').innerText(), 'Existing account error');
    await page.evaluate(() => fixture.finishDownload());
    await page.waitForFunction(() => fixture.calls.includes('install'));
    assert.deepEqual(await calls(page), ['check', 'persist', 'download', 'persist', 'install']);
    assert.match(await page.locator('#update-status').innerText(), /安装程序已启动/);
    assert(await page.locator('#check-update-button').isDisabled(), 'keep controls locked while main exits');
    await page.close();

    for (const [options, expected, message] of [
      [{ failCheck: true }, ['check'], /Check failed/],
      [{ failDownload: true }, ['check', 'persist', 'download'], /Download failed/],
      [{ failPersist: true }, ['check', 'persist'], /Local disk failed/],
      [{ failSecondPersist: true }, ['check', 'persist', 'download', 'persist'], /Local disk failed/]
    ]) {
      page = await fixturePage(options);
      await page.click('#check-update-button'); await settled(page);
      assert.deepEqual(await calls(page), expected, 'failure must abort before installation');
      assert.match(await page.locator('#update-status').innerText(), message);
      assert(await page.locator('#account-login').isEnabled());
      await page.close();
    }

    page = await fixturePage({ failInstall: true });
    await page.click('#check-update-button'); await settled(page);
    assert.equal(await page.locator('#check-update-button').innerText(), '重试安装');
    assert.match(await page.locator('#update-status').innerText(), /Installer failed/);
    await page.evaluate(() => { fixture.failInstall = false; });
    await page.click('#check-update-button');
    await page.waitForFunction(() => fixture.calls.filter(call => call === 'install').length === 2);
    assert.deepEqual(await calls(page), ['check', 'persist', 'download', 'persist', 'install', 'persist', 'install']);
    await page.close();

    // A backend verification error invalidates ready state and permits a fresh download.
    page = await fixturePage({ failInstall: true });
    await page.click('#check-update-button'); await settled(page);
    await page.evaluate(() => { fixture.failInstall = false; fixture.progress({ phase: 'error', message: 'Package verification failed' }); });
    assert.equal(await page.locator('#check-update-button').innerText(), '检查更新');
    await page.click('#check-update-button');
    await page.waitForFunction(() => fixture.calls.filter(call => call === 'install').length === 2);
    assert.equal((await calls(page)).filter(call => call === 'download').length, 2);
    await page.close();

    // A failed write aborts that attempt; a fresh explicit check retries persistence.
    page = await fixturePage({ failPersist: true });
    await page.click('#check-update-button'); await settled(page);
    await page.evaluate(() => { fixture.failPersist = false; });
    await page.click('#check-update-button');
    await page.waitForFunction(() => fixture.calls.includes('install'));
    await page.close();

    page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    let networkRequests = 0;
    page.on('request', request => { if (/^https?:/.test(request.url())) networkRequests++; });
    await page.goto(pathToFileURL(path.resolve(__dirname, '../ui/index.html')).href);
    await page.click('#account-button'); await page.click('#check-update-button');
    assert.match(await page.locator('#app-version').innerText(), /浏览器预览/);
    assert.match(await page.locator('#update-status').innerText(), /桌面客户端/);
    assert.equal(networkRequests, 0);
    await page.close();
    assert.deepEqual(errors, []);
    console.log('UPDATE UI PASS: signed out, real bootstrap version, latest, auto download/install, progress and locks, failure aborts, ready install retry, pending writes and browser preview');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
