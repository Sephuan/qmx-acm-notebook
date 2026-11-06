'use strict';
// Native Linux only. Setup: install project dependencies, package for this architecture,
// and install Xvfb plus the shared libraries required by Electron on your distribution.
// Run: xvfb-run -a node tests/linux-desktop-smoke.cjs
// Root/container CI only: CI=1 QMX_SMOKE_NO_SANDBOX=1 xvfb-run -a node tests/linux-desktop-smoke.cjs
// That explicit CI opt-in disables Chromium's sandbox for this smoke process only.
// No GitHub login, publish, sync button, download, or updater install is exercised.
// Startup discovery/public reads are tolerated; page.route cannot intercept main-process
// Node fetch or Electron net.fetch. Native updater coverage lives in the updater tests.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TIMEOUT = 120000;
const LAUNCH_TIMEOUT = 30000;
const UI_TIMEOUT = 15000;
const DEFAULT_CLIENT_ID = 'Ov23likjqSdpkS6MYGzJ';
const title = 'Linux packaged smoke: 本地题解';
const body = '## Linux persistence\n\nKeep **all** Markdown and Unicode: 整数溢出。\n\n```cpp\nlong long answer = 42;\n```';

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
async function bounded(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

(async () => {
  assert.equal(process.platform, 'linux', 'Run this test on native Linux, not Windows/WSL interop Node');
  const { _electron: electron } = require('playwright');
  const executable = path.resolve(__dirname, `../release/QMX-Notebook-linux-${process.arch}/QMX-Notebook`);
  const archive = path.join(path.dirname(executable), 'resources', 'app.asar');
  assert(fs.statSync(executable).isFile(), `Missing packaged executable: ${executable}`);
  assert(fs.statSync(archive).isFile(), `Missing packaged archive: ${archive}`);
  fs.accessSync(executable, fs.constants.X_OK);
  assert(fs.statSync(executable).mode & 0o111, 'Packaged executable must retain its Linux execute bits (check packaging/chmod)');
  const original = { executable: sha256(executable), archive: sha256(archive), mode: fs.statSync(executable).mode };
  const noSandbox = process.env.QMX_SMOKE_NO_SANDBOX === '1';
  if (noSandbox) {
    assert(process.env.CI && !/^(false|0)$/i.test(process.env.CI), 'QMX_SMOKE_NO_SANDBOX is restricted to CI smoke runs');
    console.warn('CI smoke only: launching with --no-sandbox; do not use this flag for normal desktop use.');
  }
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qmx-linux-desktop-smoke-')));
  const profile = path.join(root, 'profile');
  const env = { ...process.env, HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_DATA_HOME: path.join(root, 'data') };
  delete env.ELECTRON_RUN_AS_NODE;
  // Even an Electron version that ignores --user-data-dir stays inside the fixture.
  for (const directory of [profile, env.HOME, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_DATA_HOME]) fs.mkdirSync(directory, { recursive: true });
  let app, page, userData, succeeded = false, stopped = false;
  const rendererErrors = [];
  const diagnostics = [];
  async function launch() {
    assert(!stopped, 'Smoke has already timed out or failed');
    app = await electron.launch({ executablePath: executable,
      args: ['--disable-gpu', ...(noSandbox ? ['--no-sandbox'] : []), `--user-data-dir=${profile}`],
      env, timeout: LAUNCH_TIMEOUT });
    if (stopped) { await close(); throw new Error('Launch completed after smoke timeout'); }
    const runtime = await app.evaluate(({ app }) => ({
      userData: app.getPath('userData'), packaged: app.isPackaged, platform: process.platform, executable: process.execPath
    }));
    assert.equal(runtime.platform, 'linux');
    assert.equal(runtime.packaged, true, 'Must launch the real packaged application');
    assert.equal(fs.realpathSync(runtime.executable), fs.realpathSync(executable));
    const actualUserData = fs.realpathSync(runtime.userData);
    assert(within(root, actualUserData), `Refusing fixture writes outside temporary root: ${actualUserData}`);
    if (userData) assert.equal(actualUserData, userData, 'Relaunch must reuse the same userData');
    userData = actualUserData;
    page = await app.firstWindow({ timeout: LAUNCH_TIMEOUT });
    page.setDefaultTimeout(UI_TIMEOUT);
    page.on('pageerror', error => rendererErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') diagnostics.push(message.text()); });
    await page.waitForFunction(() => typeof window.notebook?.bootstrap === 'function');
    await page.waitForSelector('#home-panel');
    return page.evaluate(() => window.notebook.bootstrap());
  }
  async function close() {
    if (!app) return;
    const closing = app;
    try { await bounded(closing.close(), 10000, 'Electron did not close within 10 seconds'); }
    catch (error) { closing.process().kill('SIGKILL'); throw error; }
    finally { app = undefined; page = undefined; }
  }
  async function scenario() {
    const clean = await launch();
    assert.equal(clean.account, null, 'Fresh profile must be logged out');
    assert.equal(clean.settings.clientId, DEFAULT_CLIENT_ID, 'Default public OAuth Client ID must be available');
    assert.deepEqual(clean.local.records, [], 'Fresh profile must have no local records');
    assert.deepEqual(clean.local.favorites, [], 'Fresh profile must have no favorites');
    assert.equal(fs.existsSync(path.join(userData, 'auth.json')), false, 'Clean launch must not create credentials');
    await close();

    // Main reads settings.json on each bootstrap. Write only after a clean shutdown;
    // this avoids racing the first-launch public sync or changing application source.
    const settingsFile = path.join(userData, 'settings.json');
    const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
    fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, autoSync: false }, null, 2));
    const ready = await launch();
    assert.equal(ready.settings.autoSync, false);
    assert.equal(ready.account, null);
    await page.locator('.sidebar').hover();
    await page.locator('.nav-item[data-view="home"]').click();
    await page.locator('#home-panel .home-shortcut[data-view="mine"]').click();
    await page.click('#submit-button');
    await page.fill('[name="url"]', 'https://codeforces.com/problemset/problem/1/A');
    await page.fill('[name="title"]', title);
    await page.fill('#record-body', body);
    await page.click('#save-local-button');
    await page.waitForSelector('#submit-dialog', { state: 'hidden' });
    await page.locator('.record-card').filter({ hasText: title }).waitFor();
    await page.getByRole('button', { name: '☆ 收藏', exact: true }).click();
    await page.getByRole('button', { name: '★ 已收藏', exact: true }).waitFor();
    // The UI renders optimistically; poll the real IPC bootstrap until disk persistence finishes.
    await page.waitForFunction(async () => {
      const state = await window.notebook.bootstrap();
      return state.local.records.length === 1 && state.local.favorites.includes(state.local.records[0].id);
    });
    const saved = await page.evaluate(() => window.notebook.bootstrap());
    assert.equal(saved.local.records.length, 1);
    const record = saved.local.records[0];
    assert.equal(record.title, title);
    assert.equal(record.body, body);
    assert.equal(record.kind, 'local');
    assert.equal(record.ownerId, null);
    assert.match(record.clientId, /^[0-9a-f-]{36}$/i);
    assert.deepEqual(saved.local.favorites, [record.id]);
    await close();

    const restored = await launch();
    assert.equal(restored.account, null);
    assert.equal(restored.settings.clientId, DEFAULT_CLIENT_ID);
    assert.equal(restored.settings.autoSync, false);
    assert.deepEqual(restored.local.records, saved.local.records, 'Full local content and identity must survive relaunch');
    assert.deepEqual(restored.local.favorites, [record.id]);
    await page.locator('.sidebar').hover();
    await page.locator('.nav-item[data-view="favorites"]').click();
    await page.locator('.record-card').filter({ hasText: title }).click();
    await page.getByRole('button', { name: '★ 已收藏', exact: true }).waitFor();
    await page.click('#edit-record-button');
    assert.equal(await page.inputValue('[name="title"]'), title);
    assert.equal(await page.inputValue('#record-body'), body, 'Editor must restore exact Markdown');
    await page.click('[data-close="submit-dialog"]');
    assert.deepEqual(rendererErrors, [], 'Renderer must not throw');
    await close();
  }
  try {
    await bounded(scenario(), TIMEOUT, `Linux desktop smoke exceeded ${TIMEOUT / 1000}s`);
    succeeded = true;
  } catch (error) {
    stopped = true;
    if (page && !page.isClosed()) {
      const screenshot = path.join(root, 'failure.png');
      try { await page.screenshot({ path: screenshot, timeout: 5000 }); console.error(`Failure screenshot: ${screenshot}`); }
      catch (captureError) { console.error(`Screenshot unavailable: ${captureError.message}`); }
    }
    if (diagnostics.length) console.error('Renderer console diagnostics:\n' + diagnostics.join('\n'));
    if (rendererErrors.length) console.error('Renderer errors:\n' + rendererErrors.join('\n'));
    console.error(`Retained isolated diagnostic profile: ${root}`);
    throw error;
  } finally {
    try { await close(); }
    finally {
      assert.equal(sha256(executable), original.executable, 'Smoke must not change the executable');
      assert.equal(sha256(archive), original.archive, 'Smoke must not change app.asar');
      assert.equal(fs.statSync(executable).mode, original.mode, 'Smoke must not change executable permissions');
      if (succeeded) {
        // root is the verified absolute directory returned by mkdtemp/realpath above.
        assert(path.isAbsolute(root) && path.basename(root).startsWith('qmx-linux-desktop-smoke-'));
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }
  console.log('LINUX DESKTOP PASS: packaged clean start, real preload/IPC bootstrap, logged-out defaults, UI local save/favorite, exact Markdown persistence after relaunch; executable and app.asar unchanged.');
})().catch(error => { console.error(error); process.exitCode = 1; });
