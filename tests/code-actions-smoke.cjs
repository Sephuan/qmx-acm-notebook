'use strict';
// Run with: node tests/code-actions-smoke.cjs (requires Playwright and Microsoft Edge).
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
    await page.click('[data-view="discussion"]');
    await page.click('.record-card');
    await page.waitForSelector('.code-block .code-action-button');

    const labels = await page.$$eval('.code-block .code-action-button', nodes => nodes.map(node => node.textContent.trim()));
    assert.deepEqual(labels, ['复制', '格式化'], 'copy and format buttons');

    // Copy writes the exact source text to the clipboard.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.hover('.code-block');
    await page.click('.code-action-button[data-action="copy"]', { force: true });
    await page.waitForTimeout(250);
    assert.equal(await page.locator('.code-action-button[data-action="copy"]').innerText(), '已复制');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(copied, /long long answer = 0/);

    // Format rewrites the code in place and re-runs Prism.
    await page.evaluate(() => {
      window.notebook = { formatCode: async () => 'int main() {\n    return 0;\n}' };
    });
    await page.hover('.code-block');
    await page.click('.code-action-button[data-action="format"]', { force: true });
    await page.waitForTimeout(600);
    const formatted = await page.evaluate(() => ({
      text: document.querySelector('.markdown-body pre code').textContent,
      tokens: document.querySelectorAll('.markdown-body pre code .token').length,
    }));
    assert.equal(formatted.text, 'int main() {\n    return 0;\n}');
    assert.ok(formatted.tokens > 0, 're-highlighted after formatting');

    assert.deepEqual(errors, []);
    console.log('CODE ACTIONS PASS: copy and format buttons');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
