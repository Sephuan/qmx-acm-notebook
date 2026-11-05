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
    await page.goto(pathToFileURL(path.resolve(__dirname, '../ui/index.html')).href);
    await page.waitForSelector('.record-card');

    // Settings exposes the code font size slider and the line-number toggle.
    await page.click('#settings-button');
    await page.waitForSelector('#settings-dialog[open]');
    const range = page.locator('#settings-form [name="codeFontSize"]');
    assert.equal(await range.count(), 1, 'code font size slider');
    assert.equal(await range.getAttribute('min'), '10');
    assert.equal(await range.getAttribute('max'), '18');
    assert.equal(await page.locator('#settings-form [name="codeLineNumbers"]').count(), 1, 'line number toggle');

    // The slider applies the code font size live.
    await range.fill('16');
    assert.equal(await page.evaluate(() => document.body.style.getPropertyValue('--code-font-size')), '16px');
    assert.equal(await page.locator('#code-font-size-value').innerText(), '16px');

    // Line numbers appear after saving.
    await page.check('#settings-form [name="codeLineNumbers"]');
    await page.click('#settings-form button[type="submit"]');
    await page.waitForTimeout(400);
    await page.click('[data-view="discussion"]');
    await page.click('.record-card');
    await page.waitForSelector('.markdown-body pre.line-numbers .line-numbers-rows');
    const rows = await page.evaluate(() => document.querySelector('.markdown-body pre .line-numbers-rows').children.length);
    assert.ok(rows >= 1, 'line numbers rendered');
    const fontSize = await page.evaluate(() => getComputedStyle(document.querySelector('.markdown-body pre code')).fontSize);
    assert.equal(fontSize, '16px');

    // Sidebar collapses and expands.
    await page.click('#sidebar-toggle');
    assert.equal(await page.evaluate(() => document.body.classList.contains('sidebar-collapsed')), true);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.sidebar')).visibility), 'hidden');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.app-shell')).gridTemplateColumns), '0px 1440px');
    await page.click('#sidebar-toggle');
    assert.equal(await page.evaluate(() => document.body.classList.contains('sidebar-collapsed')), false);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.sidebar')).visibility), 'visible');

    assert.deepEqual(errors, []);
    console.log('READING PREFS PASS: code font size, line numbers and collapsible sidebar');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
