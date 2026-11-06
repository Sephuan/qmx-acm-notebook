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
    const cases = [
      ['c++', 'cpp', 'int main(){return 0;}'],
      ['py', 'python', 'print( 1 )'],
      ['JS', 'javascript', 'const answer=1;'],
      ['ts', 'typescript', 'const answer:number=1;'],
      ['cs', 'csharp', 'class Answer{}'],
      ['objc', 'objectivec', 'int answer=1;'],
      ['go', null, 'package main'],
      ['rust', null, 'fn main() {}'],
      ['unknown', null, 'leave this alone'],
      ['', null, 'unlabelled source'],
    ];
    await page.addInitScript(cases => {
      localStorage.setItem('acm-notebook.demo.v1', JSON.stringify({
        settings: { codeLineNumbers: true },
        local: { records: [{ id: 'code-actions-fixture', kind: 'local', title: 'Code action fixture', body: cases.map(([alias, , source]) => '```' + alias + '\n' + source + '\n```').join('\n\n') }], favorites: [], mastery: {}, draft: {} },
      }));
    }, cases);
    await page.goto(pathToFileURL(path.resolve(__dirname, '../ui/index.html')).href);
    await page.waitForSelector('.record-card');
    await page.click('[data-view="mine"]');
    await page.waitForSelector('.code-block .code-action-button');
    const blocks = page.locator('.markdown-body .code-block');
    assert.equal(await blocks.count(), cases.length);
    assert.deepEqual(await blocks.first().locator('.code-action-button').allTextContents(), ['复制', '格式化']);

    // Copy includes the exact source, without Prism's line-number helpers.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await blocks.first().locator('[data-action="copy"]').click({ force: true });
    await page.waitForFunction(() => document.querySelector('[data-action="copy"]').textContent === '已复制');
    assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'), cases[0][2] + '\n');

    // Structured formatter failures must win over code, including unchanged source.
    const firstCode = blocks.first().locator('pre code');
    const firstFormat = blocks.first().locator('[data-action="format"]');
    const original = await firstCode.textContent();
    for (const returnSource of [true, false]) {
      await page.evaluate(returnSource => { window.notebook = { formatCode: async source => ({ code: returnSource ? source : 'SHOULD NOT REPLACE SOURCE', error: { message: 'invalid syntax' } }) }; }, returnSource);
      await firstFormat.click({ force: true });
      await page.waitForFunction(() => document.querySelector('#toast').textContent === '格式化失败：invalid syntax');
      assert.equal(await firstCode.textContent(), original, 'failed formatting preserves the code');
      assert.equal(await firstFormat.isEnabled(), true, 'failure restores the action');
      assert.equal(await firstFormat.getAttribute('aria-busy'), null);
      assert.match(await blocks.first().locator('.code-status').textContent(), /invalid syntax/);
    }
    await page.evaluate(() => { window.notebook = { formatCode: async () => { throw new Error('formatter unavailable'); } }; });
    await firstFormat.click({ force: true });
    await page.waitForFunction(() => document.querySelector('#toast').textContent === '格式化失败：formatter unavailable');
    assert.equal(await firstCode.textContent(), original);
    assert.equal(await firstFormat.isEnabled(), true);

    // Common aliases reach the formatter as canonical names; unsupported languages stay disabled.
    await page.evaluate(() => {
      window.formatCalls = [];
      window.notebook = { formatCode: async (source, language) => { window.formatCalls.push({ source, language }); return { code: source.trimEnd() + '\n// formatted\n' }; } };
    });
    for (let index = 0; index < cases.length; index++) {
      const [alias, canonical, source] = cases[index];
      const format = blocks.nth(index).locator('[data-action="format"]');
      assert.equal(await format.isEnabled(), Boolean(canonical), `${alias || 'unlabelled'} format availability`);
      if (!canonical) { assert.match(await format.getAttribute('title'), /暂不支持|未能识别/); continue; }
      await format.click({ force: true });
      await page.waitForFunction(count => window.formatCalls.length === count, index + 1);
      const calls = await page.evaluate(() => window.formatCalls);
      assert.deepEqual(calls[index], { source: source + '\n', language: canonical });
      assert.equal(await blocks.nth(index).locator('pre code').textContent(), source + '\n// formatted\n');
    }
    assert.ok(await firstCode.locator('.token').count() > 0, 'C++ is re-highlighted after formatting');
    await page.evaluate(() => { window.notebook = { formatCode: async source => source }; });
    await firstFormat.click({ force: true });
    await page.waitForFunction(() => document.querySelector('#toast').textContent === '代码格式已是最新');
    assert.equal(await firstFormat.isEnabled(), true);

    assert.deepEqual(errors, []);
    console.log('CODE ACTIONS PASS: exact copy, formatter errors/recovery, canonical aliases and unsupported languages');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
