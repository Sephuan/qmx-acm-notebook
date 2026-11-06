'use strict';
// Explicit network smoke: run with node tests/live-update-smoke.cjs (requires Electron).
const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qmx-live-network-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: path.resolve('release/QMX-Notebook-win32-x64/QMX-Notebook.exe'), args: ['--disable-gpu', '--no-sandbox', '--user-data-dir=' + profile], env, timeout: 30000 });
  try {
    const page = await app.firstWindow(); await page.waitForSelector('#home-panel');
    // Exercise the packaged updater with the same Chromium transport used by main.
    const result = await app.evaluate(async ({ net, app }) => {
      const load = process.mainModule.require.bind(process.mainModule);
      const path = load('node:path');
      const createUpdater = load(path.join(app.getAppPath(), 'electron/updater.cjs'));
      const u = createUpdater({ currentVersion: '0.3.3', runtimeVersion: process.versions.electron, downloadDir: path.join(app.getPath('userData'), 'live-download'), fetcher: (url, options) => net.fetch(url, { ...options, bypassCustomProtocolHandlers: true }) });
      const first = await u.check(); const second = await u.check();
      const ready = await u.download(); await u.verifyReady();
      return { first: first.phase, second: second.phase, version: ready.version, bytes: ready.manifest.files[0].size };
    });
    assert.equal(result.first, 'available'); assert.equal(result.second, 'available'); assert(result.bytes > 0);
    console.log('PACKAGED LIVE CHECK TWICE + DOWNLOAD + VERIFY PASS', JSON.stringify(result));
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
