'use strict';
// Run with: node tests/code-highlight-smoke.cjs (requires Playwright and Microsoft Edge).
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
    // The demo discussion contains a fenced cpp block.
    await page.click('[data-view="discussion"]');
    await page.click('.record-card');
    await page.waitForSelector('.markdown-body pre code .token');
    const colors = {};
    for (const theme of ['light', 'dark', 'cards']) {
      await page.selectOption('#theme-select', theme);
      colors[theme] = await page.evaluate(() => {
        const code = document.querySelector('.markdown-body pre code');
        const pick = cls => {
          const node = [...code.querySelectorAll('.token')].find(token => token.classList.contains(cls));
          return node ? getComputedStyle(node).color : null;
        };
        return { keyword: pick('keyword'), number: pick('number'), comment: pick('comment') };
      });
    }
    for (const theme of ['light', 'dark', 'cards']) {
      assert.equal(typeof colors[theme].keyword, 'string', `${theme} keyword color`);
      assert.equal(typeof colors[theme].number, 'string', `${theme} number color`);
      assert.notEqual(colors[theme].keyword, colors[theme].number, `${theme} tokens must be colored differently`);
    }
    assert.notEqual(colors.dark.keyword, colors.light.keyword, 'dark theme must restyle syntax colors');
    assert.deepEqual(errors, []);
    console.log('CODE HIGHLIGHT PASS: cpp tokens colored in light, dark and cards', JSON.stringify(colors));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
