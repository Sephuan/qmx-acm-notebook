'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const source = String.raw`# Foreground colors

<span id="hex" style="color:#c7254e">hex <strong>bold</strong> <em>italic</em> <a href="https://www.bilibili.com/video/BV1xx411c7mD/">video</a></span>

<font id="legacy" color="blue" face="monospace" size="7">legacy <b>bold</b></font>

<span id="rgb" style="color:rgb(20, 120, 80)">RGB</span> <span id="hsl" style="color:hsl(210, 70%, 45%)">HSL</span> <span id="named" style="color:rebeccapurple">named</span>

<span id="mixed" style="position:fixed;inset:0;background:url(https://example.com/track);color:#09c;display:none" onclick="window.injected=true">safe color only</span>

<span id="invalid" style="color:var(--text);background:red">invalid color</span> <font id="badfont" color="not-a-color">invalid legacy</font>

<span id="injection" style="color:expression(alert(1));background-image:url(javascript:alert(1))">CSS injection</span>

<div id="layout" style="color:red;position:fixed">unsupported styled tag</div>

<script>window.injected=true</script><style>body{display:none}</style><iframe src="https://example.com"></iframe><img src="x" onerror="window.injected=true">

$\color{red}x$ $\color{#12ab34}y$ $\textcolor{#09c}{z}$ $a+{\color{blue}b}+c$

<span id="mathinherit" style="color:#c7254e">$x_i$</span>

$\href{javascript:alert(1)}{unsafe}$ $\htmlStyle{position:fixed;color:red}{unsafe}$

[short video](https://b23.tv/AbCd12)

[section](#reader-target) [encoded section](#reader%2Dtarget) [missing](#missing) [malformed](#%xx)

<h2 id="reader-target">Target section</h2>

\`<span style="color:red">literal</span>\`
`.replace(/\\`/g, '`');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(body => {
      const record = { id: 'document:colors.md', kind: 'document', repo: 'test/colors', path: 'colors.md', title: 'Color regression', body, author: 'test', authorId: '1' };
      const payload = { records: [record], issues: [], account: null, permissions: { repo: 'test/colors' }, settings: { repo: 'test/colors', autoSync: false }, local: { records: [], favorites: [], mastery: {}, draft: {} } };
      window.openedUrls = [];
      window.notebook = { bootstrap: async () => structuredClone(payload), sync: async () => structuredClone(payload), openExternal: async url => window.openedUrls.push(url) };
    }, source);
    await page.goto(pathToFileURL(path.resolve(__dirname, '../ui/index.html')).href);
    await page.locator('.rail-nav-item[data-view="public"]').click();
    const reader = page.locator('#detail-panel .markdown-body');
    await reader.locator('.katex').first().waitFor();
    assert.equal(await reader.locator('.notebook-math-error').count(), 0);
    assert.equal(await reader.locator('script,style,iframe,[onclick],[onerror],a[href^="javascript:"]').count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    const styles = await reader.evaluate(root => Array.from(root.querySelectorAll('[style]')).filter(node => !node.closest('.katex')).map(node => ({ id: node.id, properties: Array.from(node.style) })));
    assert.ok(styles.length >= 7);
    assert.ok(styles.every(node => node.properties.length === 1 && node.properties[0] === 'color'), JSON.stringify(styles));
    for (const id of ['invalid', 'badfont', 'injection', 'layout']) assert.equal(await reader.locator('#' + id).getAttribute('style'), null);
    assert.equal(await reader.locator('font[color]').count(), 0);
    assert.equal(await reader.locator('code span').count(), 0);
    assert.match(await reader.locator('code').innerText(), /<span style="color:red">literal<\/span>/);
    for (const theme of ['light', 'dark', 'cards']) {
      await page.evaluate(value => document.body.dataset.theme = value, theme);
      const actual = await reader.evaluate(root => {
        const get = selector => getComputedStyle(root.querySelector(selector)).color;
        return { hex: get('#hex'), bold: get('#hex strong'), italic: get('#hex em'), link: get('#hex a'), legacy: get('#legacy'), legacyBold: get('#legacy b'), rgb: get('#rgb'), hsl: get('#hsl'), named: get('#named'), mixed: get('#mixed'), math: get('#mathinherit .mord'), katexColors: Array.from(root.querySelectorAll('.katex-html [style]')).map(node => node.style.color).filter(Boolean) };
      });
      assert.equal(actual.hex, 'rgb(199, 37, 78)', theme);
      assert.equal(actual.bold, actual.hex, theme);
      assert.equal(actual.italic, actual.hex, theme);
      assert.equal(actual.link, actual.hex, theme);
      assert.equal(actual.legacy, 'rgb(0, 0, 255)', theme);
      assert.equal(actual.legacyBold, actual.legacy, theme);
      assert.equal(actual.rgb, 'rgb(20, 120, 80)', theme);
      assert.equal(actual.hsl, 'rgb(34, 115, 195)', theme);
      assert.equal(actual.named, 'rgb(102, 51, 153)', theme);
      assert.equal(actual.mixed, 'rgb(0, 153, 204)', theme);
      assert.equal(actual.math, actual.hex, theme);
      for (const color of ['red', 'rgb(18, 171, 52)', 'rgb(0, 153, 204)', 'blue']) assert.ok(actual.katexColors.includes(color), `${theme}: ${color}: ${JSON.stringify(actual.katexColors)}`);
    }
    await reader.locator('#hex a').click();
    await reader.getByRole('link', { name: 'short video', exact: true }).click();
    await page.evaluate(() => { window.fragmentScrolls = 0; document.querySelector('#reader-target').scrollIntoView = () => { window.fragmentScrolls++; }; });
    for (const name of ['section', 'encoded section', 'missing', 'malformed']) await reader.getByRole('link', { name, exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.openedUrls), ['https://www.bilibili.com/video/BV1xx411c7mD/', 'https://b23.tv/AbCd12']);
    assert.equal(await page.evaluate(() => window.fragmentScrolls), 2);
    assert.deepEqual(errors, []);
    console.log('PASS Markdown colors: safe span/font foregrounds, restricted CSS, literal code, KaTeX named/hex/scoped colors, 3 themes, video links and local anchors');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
