'use strict';
const { _electron: electron } = require('playwright');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qmx-packaged-smoke-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ repo: 'qmx-acm-data/2026', autoSync: false }));
  const env = { ...process.env, QMX_USER_DATA_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: process.env.QMX_SMOKE_EXE || path.resolve(__dirname, '../release/QMX-Notebook-win32-x64/QMX-Notebook.exe'), args: ['--disable-gpu', '--no-sandbox'], env, timeout: 30000 });
  try {
    assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), profile);
    const page = await app.firstWindow(); const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.waitForSelector('#record-list');
    const state = await page.evaluate(() => window.notebook.bootstrap()); assert.equal(state.appVersion, '0.6.0'); assert.equal(state.tagCatalog.categories.length, 22); assert.equal(state.account, null);
    await page.click('[data-view="mine"]'); await page.click('#submit-button');
    await page.fill('[name="title"]', '隔离桌面验证'); await page.fill('[name="url"]', 'https://www.luogu.com.cn/problem/P1001'); await page.fill('[name="body"]', '# 完整题解\n\n仅隔离数据目录'); await page.click('#save-local-button');
    await page.waitForSelector('.record-card'); await page.locator('.record-card').first().dblclick(); await page.waitForSelector('#detail-back-button'); await page.click('#detail-back-button');
    await page.locator('#state-facet summary').click(); await page.locator('#state-facet input[value="unreviewed"]').check(); assert.equal(await page.locator('.record-card').count(), 1);
    fs.mkdirSync(path.resolve(__dirname, '../screenshots'), { recursive: true });
    await page.screenshot({ path: path.resolve(__dirname, '../screenshots/desktop-0.6.0.png') });
    assert.deepEqual(errors, []); console.log('PACKAGED PASS: version, isolated userData, presets, local save, grid, reader, state facet; no account credentials used');
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
