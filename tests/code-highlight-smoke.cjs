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
    const aliases = [
      ['c++', 'cpp', 'int main() { return 0; }'],
      ['CXX', 'cpp', 'int answer = 1;'],
      ['PY', 'python', 'def answer():\n    return 1'],
      ['python3', 'python', 'print(1)'],
      ['golang', 'go', 'package main\nfunc main() {}'],
      ['rs', 'rust', 'fn main() { let answer = 1; }'],
      ['unknown', 'unknown', '<unsafe markup>& plain code'],
      ['', null, 'unlabelled <code> & source'],
    ];
    await page.addInitScript(aliases => {
      localStorage.setItem('acm-notebook.demo.v1', JSON.stringify({ settings: {}, local: {
        records: [{ id: 'highlight-fixture', kind: 'local', title: 'Highlight aliases', body: aliases.map(([alias, , source]) => '```' + alias + '\n' + source + '\n```').join('\n\n') }], favorites: [], mastery: {}, draft: {},
      } }));
    }, aliases);
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

    // Aliases are normalized before Prism reads the language, preserving exact source text.
    await page.click('[data-view="mine"]');
    const code = page.locator('.markdown-body pre code');
    assert.equal(await code.count(), aliases.length);
    for (let index = 0; index < aliases.length; index++) {
      const [alias, language, source] = aliases[index];
      assert.equal(await code.nth(index).textContent(), source + '\n', `${alias || 'unlabelled'} source preserved`);
      if (language) assert.ok((await code.nth(index).getAttribute('class')).split(/\s+/).includes('language-' + language), `${alias} canonical Prism language`);
      assert.equal(await code.nth(index).locator('.token').count() > 0, index < 6, `${alias || 'unlabelled'} token availability`);
    }
    assert.equal(await page.locator('.markdown-body pre unsafe').count(), 0, 'unknown-language text remains escaped');
    assert.deepEqual(errors, []);
    console.log('CODE HIGHLIGHT PASS: themed syntax colors, C++/Python/Go/Rust aliases and plain unknown languages', JSON.stringify(colors));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
