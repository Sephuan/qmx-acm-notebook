'use strict';
const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const mode of ['available', 'latest', 'offline', 'deferred', 'update']) {
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.addInitScript(mode => {
        const calls = window.calls = [];
        window.notebook = {
          bootstrap: async () => ({ appVersion: '0.3.5', settings: { autoSync: false }, local: { records: [] } }),
          checkStartupUpdates: async () => { calls.push('startup'); if (mode === 'deferred') await new Promise(resolve => { window.finishStartup = resolve; }); if (mode === 'offline') throw Error('offline'); return { phase: mode === 'latest' ? 'idle' : 'available', available: mode !== 'latest', latestVersion: '0.3.6' }; },
          checkForUpdates: async () => { calls.push('manual'); return { phase: 'available', available: true, latestVersion: '0.3.6' }; },
          updateLocal: async () => { calls.push('persist'); },
          downloadUpdate: async () => { calls.push('download'); return { phase: 'ready' }; },
          installUpdate: async () => { calls.push('install'); return { installing: true }; },
          onUpdateProgress() {}, onAuthProgress() {}
        };
      }, mode);
      await page.goto(pathToFileURL(path.resolve('ui/index.html')).href);
      await page.waitForFunction(() => calls.includes('startup'));
      if (mode === 'latest' || mode === 'offline') {
        await page.waitForTimeout(100); assert.equal(await page.locator('#startup-update-dialog').evaluate(n => n.open), false);
      } else {
        if (mode === 'deferred') { await page.click('#settings-button'); await page.evaluate(() => finishStartup()); await page.waitForTimeout(100); assert.equal(await page.locator('#startup-update-dialog').evaluate(n => n.open), false); await page.click('[data-close="settings-dialog"]'); }
        await page.waitForSelector('#startup-update-dialog[open]');
        assert.equal(await page.locator('#startup-update-version').innerText(), '0.3.6');
        if (mode === 'available') { require('node:fs').mkdirSync('screenshots', { recursive: true }); await page.screenshot({ path: 'screenshots/startup-update-prompt.png' }); await page.keyboard.press('Escape'); assert.equal(await page.locator('#startup-update-dialog').evaluate(n => n.open), false); await page.evaluate(() => document.querySelector('#startup-update-dialog').showModal()); }
        const bounds = await page.locator('#startup-update-dialog').boundingBox(); assert(bounds.width <= 440 && bounds.height < 330);
        assert.deepEqual(await page.evaluate(() => calls), ['startup']);
        if (mode === 'update') { await page.click('#startup-update-now'); await page.waitForFunction(() => calls.includes('install')); assert.deepEqual(await page.evaluate(() => calls), ['startup', 'manual', 'persist', 'download', 'persist', 'install']); }
        else { await page.click(mode === 'deferred' ? '#startup-update-close' : '#startup-update-later'); assert.equal(await page.locator('#startup-update-dialog').evaluate(n => n.open), false); assert.deepEqual(await page.evaluate(() => calls), ['startup']); }
      }
      assert.deepEqual(errors, []); await page.close();
    }
    console.log('STARTUP UPDATE PASS: one background check, quiet latest/offline, compact dismissible dialog, deferred until editor closes, explicit update only');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
