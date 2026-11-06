'use strict';
// Run with: node tests/reading-prefs-smoke.cjs (requires Playwright and Microsoft Edge).
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
    const url = pathToFileURL(path.resolve(__dirname, '../ui/index.html')).href;
    await page.goto(url);
    await page.waitForSelector('.record-card');
    await page.click('[data-view="discussion"]');
    await page.waitForSelector('.markdown-body pre code');
    const range = page.locator('#settings-form [name="codeFontSize"]');
    const numbers = page.locator('#settings-form [name="codeLineNumbers"]');
    const fontSize = () => page.evaluate(() => document.body.style.getPropertyValue('--code-font-size'));
    const savedSettings = () => page.evaluate(() => JSON.parse(localStorage.getItem('acm-notebook.demo.v1'))?.settings || {});

    // Live reading previews stay outside saved settings, even during an unrelated local save.
    await page.click('#settings-button');
    assert.equal(await range.getAttribute('min'), '10');
    assert.equal(await range.getAttribute('max'), '18');
    await range.fill('16');
    assert.equal(await fontSize(), '16px');
    assert.equal(await page.locator('#code-font-size-value').innerText(), '16px');
    await numbers.check();
    await page.waitForSelector('.markdown-body pre.line-numbers .line-numbers-rows');
    await page.evaluate(() => document.querySelector('.mastery-buttons button').click());
    const previewSaved = await savedSettings();
    assert.notEqual(previewSaved.codeLineNumbers, true, 'another save must not persist the preview');
    assert.notEqual(previewSaved.codeFontSize, 16, 'preview font size stays unsaved');

    // Closing with the X rolls the rendered code and controls back to committed values.
    await page.click('[data-close="settings-dialog"]');
    await page.waitForFunction(() => document.body.style.getPropertyValue('--code-font-size') === '11px');
    assert.equal(await page.locator('.markdown-body pre.line-numbers').count(), 0);
    await page.click('#settings-button');
    assert.equal(await range.inputValue(), '11');
    assert.equal(await numbers.isChecked(), false);
    await range.fill('18');
    await numbers.check();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#settings-dialog').open && document.body.style.getPropertyValue('--code-font-size') === '11px');
    assert.equal(await page.locator('.markdown-body pre.line-numbers').count(), 0, 'Escape removes preview line numbers');

    // Saving commits both preferences, keeps them rendered, and survives reload.
    await page.click('#settings-button');
    await range.fill('16');
    await numbers.check();
    await page.click('#settings-form button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('#settings-dialog').open);
    assert.equal((await savedSettings()).codeFontSize, 16);
    assert.equal((await savedSettings()).codeLineNumbers, true);
    assert.equal(await fontSize(), '16px');
    const rows = await page.locator('.markdown-body pre .line-numbers-rows').evaluate(node => node.children.length);
    assert.ok(rows >= 1, 'line numbers rendered');
    await page.reload();
    await page.waitForSelector('.record-card');
    await page.click('[data-view="discussion"]');
    await page.waitForSelector('.markdown-body pre.line-numbers .line-numbers-rows');
    assert.equal(await page.locator('.markdown-body pre code').evaluate(node => getComputedStyle(node).fontSize), '16px');

    // Cancelling a later preview restores the saved non-default preferences too.
    await page.click('#settings-button');
    await range.fill('10');
    await numbers.uncheck();
    await page.click('[data-close="settings-dialog"]');
    await page.waitForFunction(() => document.body.style.getPropertyValue('--code-font-size') === '16px');
    await page.waitForSelector('.markdown-body pre.line-numbers .line-numbers-rows');
    await page.click('#settings-button');
    assert.equal(await range.inputValue(), '16');
    assert.equal(await numbers.isChecked(), true);
    await page.keyboard.press('Escape');

    // Sidebar collapses and expands.
    await page.click('#sidebar-toggle');
    assert.equal(await page.evaluate(() => document.body.classList.contains('sidebar-collapsed')), true);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.sidebar')).visibility), 'hidden');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.app-shell')).gridTemplateColumns), '0px 1440px');
    await page.click('#sidebar-toggle');
    assert.equal(await page.evaluate(() => document.body.classList.contains('sidebar-collapsed')), false);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.sidebar')).visibility), 'visible');

    // A rejected desktop save leaves the preview open, and closing restores committed settings.
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 940 } });
    desktop.on('pageerror', error => errors.push(error.message));
    await desktop.addInitScript(() => {
      window.settingsWrites = [];
      window.notebook = {
        bootstrap: async () => ({ settings: { autoSync: false, codeFontSize: 12, codeLineNumbers: true }, local: { records: [{ id: 'reading-fixture', kind: 'local', body: '```cpp\nint answer = 1;\n```' }], favorites: [], mastery: {}, draft: {} } }),
        saveSettings: async settings => { window.settingsWrites.push(settings); return { error: 'settings write failed' }; },
      };
    });
    await desktop.goto(url);
    await desktop.waitForSelector('.nav-item');
    await desktop.click('[data-view="mine"]');
    await desktop.waitForSelector('.markdown-body pre.line-numbers');
    await desktop.click('#settings-button');
    await desktop.locator('[name="codeFontSize"]').fill('18');
    await desktop.locator('[name="codeLineNumbers"]').uncheck();
    await desktop.click('#settings-form button[type="submit"]');
    await desktop.waitForFunction(() => document.querySelector('#toast').textContent === 'settings write failed');
    assert.equal(await desktop.locator('#settings-dialog').evaluate(node => node.open), true);
    assert.equal(await desktop.locator('#settings-form button[type="submit"]').isEnabled(), true);
    assert.equal(await desktop.evaluate(() => window.settingsWrites[0].codeFontSize), 18);
    await desktop.keyboard.press('Escape');
    await desktop.waitForFunction(() => document.body.style.getPropertyValue('--code-font-size') === '12px');
    await desktop.waitForSelector('.markdown-body pre.line-numbers .line-numbers-rows');
    await desktop.close();

    assert.deepEqual(errors, []);
    console.log('READING PREFS PASS: isolated previews, close/Escape rollback, save/reload, failed save and sidebar');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
