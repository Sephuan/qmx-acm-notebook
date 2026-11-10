'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const url = pathToFileURL(path.resolve(__dirname, '../ui/index.html')).href;
const instant = Date.parse('2030-01-02T00:00:00Z');
const iso = offset => new Date(instant + offset).toISOString();
const hostile = '<img src=x onerror="window.contestInjection=true"> & fixture with a deliberately long contest title to verify single-line truncation in the compact desktop row';
const fixture = { fetchedAt: iso(0), platforms: [
  { id: 'luogu', name: '洛谷', url: 'https://www.luogu.com.cn/contest/list', updatedAt: iso(-60000), stale: false, error: null, contests: [
    { id: 'far', title: 'Fourth upcoming fixture', url: 'https://www.luogu.com.cn/contest/4', startTime: iso(90000), endTime: iso(150000) },
    { id: 'transition', title: hostile, url: 'https://www.luogu.com.cn/contest/2', startTime: iso(3000), endTime: iso(6000) },
    { id: 'expired', title: 'Expired fixture', url: 'https://www.luogu.com.cn/contest/0', startTime: iso(-60000), endTime: iso(-1) },
    { id: 'later', title: 'Later fixture', url: 'https://www.luogu.com.cn/contest/3', startTime: iso(60000), endTime: iso(120000) },
    { id: 'active', title: 'Active fixture', url: 'https://www.luogu.com.cn/contest/1', startTime: iso(-60000), endTime: iso(4000) }
  ] },
  { id: 'codeforces', name: 'Codeforces', url: 'https://codeforces.com/contests', updatedAt: iso(-3600000), stale: true, error: null, contests: [
    { id: 'cf-far', title: 'Fourth Codeforces fixture', url: 'https://codeforces.com/contest/126', startTime: iso(7200000), endTime: iso(10800000) },
    { id: 'stale', title: 'Cached Codeforces fixture', url: 'https://codeforces.com/contest/123', startTime: iso(3600000), endTime: iso(10800000) },
    { id: 'cf-upcoming', title: 'Earlier Codeforces fixture', url: 'https://codeforces.com/contest/125', startTime: iso(30000), endTime: iso(10800000) },
    { id: 'cf-active', title: 'Earlier active Codeforces fixture', url: 'https://codeforces.com/contest/124', startTime: iso(-120000), endTime: iso(10800000) }
  ] },
  { id: 'atcoder', name: 'AtCoder', url: 'https://atcoder.jp/contests/', updatedAt: null, stale: true, error: 'HTTP 503 fetch failed raw_stack_secret', contests: [] },
  { id: 'nowcoder', name: '牛客', url: 'https://ac.nowcoder.com/acm/contest/vip-index', updatedAt: iso(-60000), stale: false, error: null, contests: [] }
] };

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: 'America/Los_Angeles' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.clock.install({ time: instant });
    await page.clock.pauseAt(instant);
    await page.addInitScript(({ fixture }) => {
      window.contestCalls = []; window.externalCalls = [];
      const payload = () => ({ settings: { autoSync: false }, local: { records: [] } });
      window.notebook = {
        bootstrap: async () => ({ ...payload(), contests: fixture }),
        sync: async () => payload(), // A later unrelated payload must not erase contests.
        getContests: force => { contestCalls.push(force); return new Promise((resolve, reject) => { window.finishContests = resolve; window.failContests = () => reject(Error('raw_stack_secret fetch TypeError')); }); },
        openExternal: async link => { externalCalls.push(link); },
        saveSettings: async () => ({}), onAuthProgress() {}, onUpdateProgress() {}
      };
    }, { fixture });
    await page.goto(url);
    await page.waitForFunction(() => window.contestCalls.length === 1);
    assert.deepEqual(await page.evaluate(() => contestCalls), [false]);
    assert.equal(await page.locator('#contests-title').innerText(), '比赛提醒');
    assert(await page.locator('#home-panel').evaluate(panel => panel.firstElementChild?.matches('.home-contests') && panel.querySelector('.home-contests').nextElementSibling?.matches('.home-welcome')), 'contest reminders are the first home section, before the hero');
    assert.equal(await page.locator('#contest-platforms > .contest-sources').count(), 1);
    assert.equal(await page.locator('.contest-platform').count(), 0, 'sources do not create separate platform panels');
    assert.equal(await page.locator('.contest-sources .contest-source[data-platform]').count(), 4, 'all sources render from bootstrap while request is pending');
    assert.equal(await page.locator('.contest-sources .contest-source .contest-official-link').count(), 4, 'each compact source has an official schedule link');
    assert.deepEqual(await page.locator('.contest-sources .contest-source').evaluateAll(nodes => nodes.map(node => node.dataset.platform)), ['luogu', 'codeforces', 'atcoder', 'nowcoder']);
    assert.equal(await page.locator('.contest-sources .contest-source > span.contest-source-status').count(), 4);
    assert.equal(await page.locator('.contest-list').count(), 1, 'all platforms share one contest list');
    assert.equal(await page.locator('#contest-platforms > .contest-list').count(), 1);
    assert.equal(await page.locator('#contests-refresh').isDisabled(), true);
    assert.match(await page.locator('#contests-status').innerText(), /已保存/);
    assert.deepEqual(await page.locator('.contest-card[data-platform="luogu"]').evaluateAll(nodes => nodes.map(node => node.dataset.contestId)), ['active', 'transition', 'later'], 'nearest three per source, expired excluded');
    assert.deepEqual(await page.locator('.contest-card[data-platform="codeforces"]').evaluateAll(nodes => nodes.map(node => node.dataset.contestId)), ['cf-active', 'cf-upcoming', 'stale'], 'each source contributes at most three contests');
    assert.deepEqual(await page.locator('.contest-list > .contest-card').evaluateAll(nodes => nodes.map(node => node.dataset.contestId)), ['cf-active', 'active', 'transition', 'cf-upcoming', 'later', 'stale'], 'one global order: ongoing first, then upcoming, each by start timestamp');
    assert.deepEqual(await page.locator('.contest-card .contest-platform-label').allTextContents(), ['Codeforces', '洛谷', '洛谷', 'Codeforces', '洛谷', 'Codeforces']);
    assert(await page.locator('.contest-card').evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().height <= 70)), 'desktop contest rows are at most 70px tall');
    assert(await page.locator('.contest-card .contest-title').evaluateAll(nodes => nodes.every(node => { const style = getComputedStyle(node); return style.whiteSpace === 'nowrap' && style.textOverflow === 'ellipsis' && style.overflowX === 'hidden' && node.getBoundingClientRect().height <= parseFloat(style.lineHeight) + 1; })), 'desktop titles use one line with ellipsis');
    assert(await page.locator('[data-contest-id="transition"] .contest-title').evaluate(node => node.scrollWidth > node.clientWidth), 'long escaped fixture actually exercises title truncation');
    assert.equal(await page.locator('.contest-card .contest-duration').count(), await page.locator('.contest-card').count(), 'each compact row shows its contest duration');
    assert(await page.locator('.contest-card .contest-duration').evaluateAll(nodes => nodes.every(node => /^赛时 .+(天|小时|分|秒)/.test(node.textContent))), 'durations include the 赛时 label and a human-readable unit');
    assert.equal(await page.locator('.contest-card .contest-decline').count(), await page.locator('.contest-card').count(), 'each compact row has a decline action');
    assert(await page.locator('.contest-card').evaluateAll(nodes => nodes.every(node => { const title = node.querySelector('.contest-title')?.textContent || ''; const decline = node.querySelector('.contest-decline'); return decline?.textContent === '不参加' && decline?.getAttribute('aria-label') === `不参加：${title}`; })), 'decline actions have the contest-specific accessible label');
    assert(await page.locator('.contest-card').evaluateAll(nodes => nodes.every(node => node.querySelectorAll('.contest-schedule time, time.contest-schedule').length === 1 && !node.querySelector('.contest-schedule').textContent.includes('结束'))), 'each schedule displays only the full start date');
    assert.equal(await page.locator('[data-contest-id="active"]').getAttribute('class'), 'contest-card is-active');
    assert.match(await page.locator('[data-contest-id="active"] .contest-countdown').innerText(), /距结束 4秒/);
    assert.equal(await page.locator('[data-contest-id="active"] .contest-phase').textContent(), '正在进行');
    assert.equal(await page.locator('[data-contest-id="transition"] .contest-phase').textContent(), '即将开始');
    assert.equal(await page.locator('[data-contest-id="transition"] .contest-title').innerText(), hostile);
    assert.equal(await page.locator('.home-contests img').count(), 0);
    assert.equal(await page.evaluate(() => window.contestInjection), undefined);
    assert.equal(await page.locator('.contest-timezone').innerText(), '所有时间均为北京时间（UTC+8）');
    assert.doesNotMatch(await page.locator('.home-contests').innerText(), /Asia\/Shanghai/);
    assert.equal(await page.locator('[data-contest-id="transition"] .contest-schedule').innerText(), '2030/01/02 08:00');
    assert.equal(await page.locator('[data-contest-id="transition"] .contest-schedule time, [data-contest-id="transition"] time.contest-schedule').getAttribute('datetime'), iso(3000));
    assert.equal(await page.locator('.contest-source[data-platform="luogu"] .contest-source-status').innerText(), '已更新');
    assert.equal(await page.locator('.contest-source[data-platform="codeforces"] .contest-source-status').innerText(), '缓存待更新');
    assert.equal(await page.locator('.contest-source[data-platform="atcoder"] .contest-source-status').innerText(), '获取失败');
    assert.equal(await page.locator('.contest-source[data-platform="nowcoder"] .contest-source-status').innerText(), '暂无赛程');
    assert.match(await page.locator('.contest-source[data-platform="codeforces"]').getAttribute('title'), /更新于.*2030\/01\/02 07:00.*北京时间/);
    assert.match(await page.locator('.contest-source[data-platform="atcoder"]').getAttribute('title'), /尚无成功更新时间/);
    assert.doesNotMatch(await page.locator('.home-contests').innerText(), /raw_stack_secret|HTTP|TypeError/);
    // Ordinary ticks preserve all surrounding home controls and card DOM.
    await page.evaluate(() => { window.heroNode = document.querySelector('.home-welcome'); window.cardNode = document.querySelector('[data-contest-id="transition"]'); });
    await page.locator('[data-contest-id="transition"] .contest-title').focus();
    await page.clock.runFor(1000);
    assert.match(await page.locator('[data-contest-id="transition"] .contest-countdown').innerText(), /距开始 2秒/);
    assert(await page.evaluate(() => heroNode === document.querySelector('.home-welcome') && cardNode === document.querySelector('[data-contest-id="transition"]')));
    assert(await page.locator('[data-contest-id="transition"] .contest-title').evaluate(node => node === document.activeElement));
    await page.clock.runFor(2000);
    assert.match(await page.locator('[data-contest-id="transition"] .contest-phase').textContent(), /正在进行/);
    assert.match(await page.locator('[data-contest-id="transition"] .contest-countdown').innerText(), /距结束 3秒/);
    assert(await page.locator('[data-contest-id="transition"] .contest-title').evaluate(node => node === document.activeElement), 'boundary preserves focused surviving link');
    await page.clock.runFor(3000);
    assert.equal(await page.locator('[data-contest-id="active"]').count(), 0);
    assert.equal(await page.locator('[data-contest-id="transition"]').count(), 0);
    assert(await page.locator('.contest-source[data-platform="luogu"] .contest-official-link').evaluate(node => node === document.activeElement), 'expired focused row falls back to its source link across the shared wrapper');
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => externalCalls), ['https://www.luogu.com.cn/contest/list'], 'fallback official link works from the keyboard');
    await page.evaluate(() => { externalCalls.length = 0; });
    assert.deepEqual(await page.locator('.contest-card[data-platform="luogu"]').evaluateAll(nodes => nodes.map(node => node.dataset.contestId)), ['later', 'far']);
    assert.deepEqual(await page.locator('.contest-list > .contest-card').evaluateAll(nodes => nodes.map(node => node.dataset.contestId)), ['cf-active', 'cf-upcoming', 'later', 'far', 'stale'], 'boundary rebuild preserves global ordering and fills the per-source limit');
    assert(await page.evaluate(() => heroNode === document.querySelector('.home-welcome')), 'boundaries do not rebuild home');
    await page.evaluate(fixture => finishContests(fixture), fixture);
    await page.waitForFunction(() => !document.querySelector('#contests-refresh').disabled);
    await page.locator('#contests-refresh').click();
    assert.deepEqual(await page.evaluate(() => contestCalls), [false, true]);
    assert.equal(await page.locator('#contests-refresh').isDisabled(), true);
    await page.evaluate(() => failContests());
    await page.waitForFunction(() => document.querySelector('#contests-status').textContent.includes('刷新失败'));
    assert.equal(await page.locator('[data-contest-id="stale"]').count(), 1, 'rejected refresh retains schedule');
    assert.equal(await page.locator('#contests-refresh').isDisabled(), false);
    assert.doesNotMatch(await page.locator('.home-contests').innerText(), /raw_stack_secret|TypeError/);
    await page.locator('[data-contest-id="stale"] .contest-title').click();
    await page.locator('.contest-source[data-platform="atcoder"] .contest-official-link').click();
    assert.deepEqual(await page.evaluate(() => externalCalls), ['https://codeforces.com/contest/123', 'https://atcoder.jp/contests/']);
    // A partial source failure must also preserve the successful previous list.
    await page.locator('#contests-refresh').click();
    await page.evaluate(fixture => {
      const next = structuredClone(fixture);
      next.platforms[1] = { ...next.platforms[1], contests: [], error: 'raw_stack_secret', stale: true, updatedAt: null };
      finishContests(next);
    }, fixture);
    await page.waitForFunction(() => !document.querySelector('#contests-refresh').disabled);
    assert.equal(await page.locator('[data-contest-id="stale"]').count(), 1);
    assert.equal(await page.locator('.contest-source[data-platform="codeforces"] .contest-source-status').innerText(), '更新失败 · 保留赛程');
    assert.match(await page.locator('.contest-source[data-platform="codeforces"]').getAttribute('title'), /更新于.*2030\/01\/02 07:00.*北京时间/, 'failed source retains its last successful update in the tooltip');
    await page.locator('#sync-button').click();
    await page.waitForFunction(() => !document.querySelector('#sync-button').disabled);
    assert.equal(await page.locator('[data-contest-id="stale"]').count(), 1, 'applyPayload without contests keeps cache');
    // Returning from navigation derives countdown from the current clock, including a large time jump.
    await page.locator('.rail-nav-item[data-view="public"]').click();
    assert.equal(await page.locator('body').getAttribute('data-view'), 'public');
    await page.clock.setSystemTime(instant + 7200000);
    await page.locator('.rail-nav-item[data-view="home"]').click();
    assert.match(await page.locator('[data-contest-id="stale"] .contest-countdown').innerText(), /距结束 1小时/);
    assert.equal(await page.locator('[data-contest-id="stale"]').getAttribute('class'), 'contest-card is-active');
    assert.deepEqual(await page.evaluate(() => contestCalls), [false, true, true, false], 'returning Home after TTL starts a background refresh');
    await page.evaluate(fixture => finishContests(fixture), fixture);
    await page.waitForFunction(() => !document.querySelector('#contests-refresh').disabled);
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focus')); });
    assert.equal(await page.evaluate(() => contestCalls.length), 4, 'focus does not refresh within TTL');
    await page.locator('#contests-refresh').focus();
    await page.clock.runFor(600000);
    assert.deepEqual(await page.evaluate(() => contestCalls), [false, true, true, false, false], 'visible Home refreshes after ten minutes');
    await page.evaluate(fixture => finishContests(fixture), fixture);
    await page.waitForFunction(() => !document.querySelector('#contests-refresh').disabled);
    await page.clock.setSystemTime(instant + 9000000);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    assert.deepEqual(await page.evaluate(() => contestCalls), [false, true, true, false, false, false], 'focus refreshes after TTL without waiting for the timer');
    await page.evaluate(fixture => finishContests(fixture), fixture);
    await page.waitForFunction(() => !document.querySelector('#contests-refresh').disabled);
    for (const theme of ['dark', 'cards', 'light']) {
      await page.locator('#theme-select').selectOption(theme);
      await page.setViewportSize({ width: 390, height: 844 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme} narrow viewport has no horizontal overflow`);
      assert(await page.locator('.contest-source, .contest-card').evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().right <= innerWidth && node.getBoundingClientRect().left >= 0)), `${theme} compact sources and shared rows fit the narrow viewport`);
    }
    for (const width of [800, 700, 650, 390]) {
      await page.setViewportSize({ width, height: 844 });
      assert(await page.locator('.contest-card').evaluateAll(nodes => nodes.length > 0 && nodes.every(node => {
        const start = node.querySelector('.contest-schedule').getBoundingClientRect();
        const duration = node.querySelector('.contest-duration').getBoundingClientRect();
        return start.width > 0 && duration.width > 0 && (start.bottom <= duration.top || duration.bottom <= start.top || start.right <= duration.left || duration.right <= start.left);
      })), `start time and duration remain readable without overlap at ${width}px`);
    }
    await page.locator('#home-panel [data-view="favorites"]').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('body').getAttribute('data-view'), 'favorites');
    const callsBeforeLeaving = await page.evaluate(() => contestCalls.length);
    await page.clock.runFor(600000);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    assert.equal(await page.evaluate(() => contestCalls.length), callsBeforeLeaving, 'automatic refresh stays idle outside Home');
    assert.deepEqual(errors, []);
    await page.close();
    for (const mode of ['preview', 'missing-method', 'initial-failure']) {
      const fallback = await browser.newPage({ viewport: { width: 390, height: 844 } });
      if (mode !== 'preview') await fallback.addInitScript(mode => {
        window.notebook = { bootstrap: async () => ({ settings: { autoSync: false } }) };
        if (mode === 'initial-failure') notebook.getContests = async () => { throw Error('raw_stack_secret'); };
      }, mode);
      await fallback.goto(url);
      await fallback.waitForSelector('#contests-status');
      assert.match(await fallback.locator('#contests-status').innerText(), /暂无可用日程/);
      assert.equal(await fallback.locator('.contest-card').count(), 0);
      assert.equal(await fallback.locator('.contest-sources .contest-source .contest-official-link').count(), 4);
      assert.equal(await fallback.locator('.contest-list').count(), 1);
      assert.equal(await fallback.locator('.contest-source').count(), 4);
      await fallback.locator('.contest-source[data-platform="atcoder"] .contest-official-link').focus();
      assert(await fallback.locator('.contest-source[data-platform="atcoder"] .contest-official-link').evaluate(node => node === document.activeElement), `${mode} official schedules remain keyboard focusable`);
      assert.equal(await fallback.locator('#contests-refresh').isDisabled(), mode !== 'initial-failure');
      assert.doesNotMatch(await fallback.locator('.home-contests').innerText(), /raw_stack_secret/);
      assert(await fallback.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await fallback.close();
    }
    // Dedicated opt-out page preserves existing timing smoke isolation.
    const optOutPage = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: 'America/Los_Angeles' });
    const optOutFixture = structuredClone(fixture);
    optOutFixture.platforms[1].contests = optOutFixture.platforms[1].contests.map(contest => contest.id === 'cf-active' ? { ...contest, id: 'active', title: 'Codeforces active with shared id' } : contest);
    await optOutPage.clock.install({ time: instant });
    await optOutPage.addInitScript(({ fixture }) => {
      const readSettings = () => JSON.parse(localStorage.getItem('contest-settings') || JSON.stringify({ autoSync: false, contestOptOuts: [] }));
      window.preferenceSaves = [];
      window.notebook = {
        bootstrap: async () => ({ settings: readSettings(), local: { records: [] }, contests: fixture }),
        sync: async () => ({ settings: readSettings(), local: { records: [] } }),
        getContests: async () => fixture,
        saveSettings: async settings => {
          window.preferenceSaves.push(structuredClone(settings));
          if (window.rejectNextSave) { window.rejectNextSave = false; throw Error('mock preference save failed'); }
          if (window.holdNextSave) { window.holdNextSave = false; return new Promise((resolve, reject) => { window.resolvePreferenceSave = () => { localStorage.setItem('contest-settings', JSON.stringify(settings)); resolve({}); }; window.rejectPreferenceSave = () => reject(Error('mock preference save failed')); }); }
          localStorage.setItem('contest-settings', JSON.stringify(settings)); return {};
        },
        openExternal: async () => {}, onAuthProgress() {}, onUpdateProgress() {}
      };
    }, { fixture: optOutFixture });
    await optOutPage.goto(url);
    await optOutPage.waitForFunction(() => document.querySelectorAll('.contest-card').length > 0);
    assert.equal(await optOutPage.locator('.contest-card .contest-duration').count(), await optOutPage.locator('.contest-card').count());
    assert.equal(await optOutPage.locator('.contest-card .contest-decline').count(), await optOutPage.locator('.contest-card').count());
    assert.equal(await optOutPage.locator('#contests-restore').isHidden(), true);
    await optOutPage.evaluate(() => { window.holdNextSave = true; });
    await optOutPage.locator('[data-platform="luogu"][data-contest-id="active"] .contest-decline').click();
    assert.equal(await optOutPage.locator('[data-platform="luogu"][data-contest-id="active"]').count(), 0, 'decline hides immediately while save pending');
    assert.equal(await optOutPage.locator('[data-platform="luogu"][data-contest-id="far"]').count(), 1, 'exclusion precedes max-three slicing');
    assert.equal(await optOutPage.locator('#contests-restore').innerText(), '已隐藏 1 场 · 恢复');
    assert(await optOutPage.locator('.contest-decline').evaluateAll(nodes => nodes.every(node => node.disabled)));
    assert.equal(await optOutPage.locator('#contests-restore').isDisabled(), true);
    await optOutPage.evaluate(() => window.resolvePreferenceSave());
    await optOutPage.waitForFunction(() => !document.querySelector('.contest-decline')?.disabled);
    assert.deepEqual(await optOutPage.evaluate(() => window.preferenceSaves.at(-1).contestOptOuts), ['luogu:active']);
    await optOutPage.locator('#contests-refresh').click();
    await optOutPage.waitForFunction(() => !document.querySelector('#contests-refresh').disabled);
    assert.equal(await optOutPage.locator('[data-platform="luogu"][data-contest-id="active"]').count(), 0, 'refresh retains exclusion');
    await optOutPage.reload();
    await optOutPage.waitForFunction(() => document.querySelectorAll('.contest-card').length > 0);
    assert.equal(await optOutPage.locator('[data-platform="luogu"][data-contest-id="active"]').count(), 0, 'reload bootstraps persisted exclusion');
    assert.equal(await optOutPage.locator('[data-platform="codeforces"][data-contest-id="active"]').count(), 1, 'same id on another platform remains independent');
    await optOutPage.evaluate(() => { window.holdNextSave = true; });
    await optOutPage.locator('[data-platform="codeforces"][data-contest-id="active"] .contest-decline').click();
    assert.equal(await optOutPage.locator('[data-platform="codeforces"][data-contest-id="active"]').count(), 0, 'rejected save begins optimistically');
    await optOutPage.evaluate(() => window.rejectPreferenceSave());
    await optOutPage.waitForFunction(() => document.querySelector('[data-platform="codeforces"][data-contest-id="active"]'));
    assert.match(await optOutPage.locator('#toast').innerText(), /比赛偏好未保存.*mock preference save failed/);
    assert.deepEqual(await optOutPage.evaluate(() => JSON.parse(localStorage.getItem('contest-settings')).contestOptOuts), ['luogu:active']);
    await optOutPage.locator('[data-platform="codeforces"][data-contest-id="active"] .contest-decline').click();
    await optOutPage.waitForFunction(() => !document.querySelector('[data-platform="codeforces"][data-contest-id="active"]'));
    assert.equal(await optOutPage.locator('#contests-restore').innerText(), '已隐藏 2 场 · 恢复');
    await optOutPage.evaluate(() => {
      const settings = JSON.parse(localStorage.getItem('contest-settings'));
      settings.contestOptOuts.push('luogu:transition', 'unknown:missing');
      localStorage.setItem('contest-settings', JSON.stringify(settings));
    });
    await optOutPage.reload();
    await optOutPage.waitForFunction(() => document.querySelector('#contests-restore')?.textContent.includes('4'));
    const originalOptOuts = ['luogu:active', 'codeforces:active', 'luogu:transition', 'unknown:missing'];
    const storedOptOuts = () => optOutPage.evaluate(() => JSON.parse(localStorage.getItem('contest-settings')).contestOptOuts);
    const inputs = optOutPage.locator('#contest-restore-options label.contest-restore-option > input[type="checkbox"]');
    const option = key => optOutPage.locator('#contest-restore-options label.contest-restore-option').filter({ has: optOutPage.locator(`input[value="${key}"]`) });
    const checkbox = key => optOutPage.locator(`#contest-restore-options input[type="checkbox"][value="${key}"]`);
    const openRestore = () => optOutPage.locator('#contests-restore').click();
    const savesBeforeOpen = await optOutPage.evaluate(() => window.preferenceSaves.length);
    await openRestore();
    assert.deepEqual(await storedOptOuts(), originalOptOuts, 'opening the dialog leaves settings unchanged');
    assert.equal(await optOutPage.locator('#contest-restore-dialog').evaluate(node => node.open), true);
    assert.deepEqual((await inputs.evaluateAll(nodes => nodes.map(node => [node.value, node.checked]))).sort(), originalOptOuts.map(key => [key, true]).sort());
    assert.equal(await optOutPage.locator('#contest-restore-count').innerText(), '已选择 4 场');
    assert.match(await option('unknown:missing').innerText(), /unknown · 比赛 missing[\s\S]*暂无赛程详情/);
    assert.equal(await optOutPage.locator('#contest-restore-options img').count(), 0, 'hostile titles remain text');
    assert.equal(await option('luogu:transition').locator('strong').innerText(), `洛谷 · ${hostile}`);
    const modalBounds = await optOutPage.locator('#contest-restore-dialog').boundingBox();
    assert(modalBounds && modalBounds.x >= 0 && modalBounds.y >= 0 && modalBounds.x + modalBounds.width <= 1440 && modalBounds.y + modalBounds.height <= 1000);
    await optOutPage.setViewportSize({ width: 390, height: 844 });
    const narrowBounds = await optOutPage.locator('#contest-restore-dialog').boundingBox();
    assert(narrowBounds && narrowBounds.x >= 0 && narrowBounds.y >= 0 && narrowBounds.x + narrowBounds.width <= 390 && narrowBounds.y + narrowBounds.height <= 844, 'modal fits narrow viewport');
    assert(await optOutPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'modal does not cause horizontal page overflow');
    assert.match(await option('luogu:active').innerText(), /洛谷.*Active fixture[\s\S]*2030\/01\/02.*赛时/);
    await optOutPage.setViewportSize({ width: 1440, height: 1000 });
    await optOutPage.locator('#contest-restore-cancel').click();
    assert.deepEqual(await storedOptOuts(), originalOptOuts, 'cancel closes without saving');
    await openRestore();
    await optOutPage.keyboard.press('Escape');
    assert.equal(await optOutPage.locator('#contest-restore-dialog').evaluate(node => node.open), false, 'Escape closes without saving');
    assert.deepEqual(await storedOptOuts(), originalOptOuts);
    await openRestore();
    await optOutPage.locator('#contest-restore-close').click();
    assert.equal(await optOutPage.locator('#contest-restore-dialog').evaluate(node => node.open), false, 'close button dismisses the dialog');
    assert.deepEqual(await storedOptOuts(), originalOptOuts);
    assert.equal(await optOutPage.evaluate(() => window.preferenceSaves.length), savesBeforeOpen, 'opening and dismissing never save settings');
    await openRestore();
    await optOutPage.locator('#contest-restore-none').click();
    assert.equal(await optOutPage.locator('#contest-restore-count').innerText(), '已选择 0 场');
    assert(await optOutPage.locator('#contest-restore-confirm').isDisabled());
    await checkbox('luogu:active').check();
    assert.equal(await optOutPage.locator('#contest-restore-count').innerText(), '已选择 1 场');
    await optOutPage.evaluate(() => { window.holdNextSave = true; });
    await optOutPage.locator('#contest-restore-confirm').click();
    await optOutPage.waitForFunction(() => window.preferenceSaves.at(-1)?.contestOptOuts?.length === 3);
    assert.equal(await optOutPage.locator('[data-platform="luogu"][data-contest-id="active"]').count(), 1, 'only selected platform/key is restored');
    assert.equal(await optOutPage.locator('#contest-restore-dialog').evaluate(node => node.open), true, 'dialog remains open while save is pending');
    assert(await optOutPage.locator('#contest-restore-confirm').isDisabled());
    assert(await optOutPage.locator('#contest-restore-all, #contest-restore-none, #contest-restore-cancel, #contest-restore-close, #contest-restore-options input').evaluateAll(nodes => nodes.every(node => node.disabled)), 'all modal controls lock while save is pending');
    await optOutPage.keyboard.press('Escape');
    assert.equal(await optOutPage.locator('#contest-restore-dialog').evaluate(node => node.open), true, 'Escape cannot close a pending save');
    await optOutPage.evaluate(() => window.resolvePreferenceSave());
    await optOutPage.waitForFunction(() => !document.querySelector('#contest-restore-dialog').open);
    assert.deepEqual(await storedOptOuts(), ['codeforces:active', 'luogu:transition', 'unknown:missing']);
    await optOutPage.reload();
    await optOutPage.waitForFunction(() => document.querySelectorAll('.contest-card').length > 0);
    assert.equal(await optOutPage.locator('[data-platform="luogu"][data-contest-id="active"]').count(), 1, 'partial restore persists through reload');

    await openRestore();
    assert.deepEqual((await inputs.evaluateAll(nodes => nodes.map(node => [node.value, node.checked]))).sort(), [['codeforces:active', true], ['luogu:transition', true], ['unknown:missing', true]].sort(), 'reopen lists only remaining exclusions, selected by default');
    await optOutPage.locator('#contest-restore-none').click();
    await checkbox('codeforces:active').check();
    await optOutPage.evaluate(() => { window.holdNextSave = true; });
    await optOutPage.locator('#contest-restore-confirm').click();
    await optOutPage.waitForFunction(() => window.preferenceSaves.at(-1)?.contestOptOuts?.length === 2);
    await optOutPage.evaluate(() => window.rejectPreferenceSave());
    await optOutPage.waitForFunction(() => !document.querySelector('#contest-restore-confirm').disabled);
    assert.equal(await optOutPage.locator('#contest-restore-dialog').evaluate(node => node.open), true, 'failed restore keeps the dialog open');
    assert.equal(await optOutPage.locator('#contest-restore-error').isVisible(), true);
    assert.match(await optOutPage.locator('#contest-restore-error').innerText(), /比赛偏好未保存.*mock preference save failed/);
    assert.equal(await checkbox('codeforces:active').isChecked(), true, 'failed save preserves the user selection');
    assert.deepEqual(await storedOptOuts(), ['codeforces:active', 'luogu:transition', 'unknown:missing'], 'failed save rolls back persisted opt-outs');
    assert.equal(await optOutPage.locator('[data-platform="codeforces"][data-contest-id="active"]').count(), 0, 'failed restore rolls back the visible contest');
    await optOutPage.locator('#contest-restore-all').click();
    await optOutPage.locator('#contest-restore-confirm').click();
    await optOutPage.waitForFunction(() => !document.querySelector('#contest-restore-dialog').open);
    assert.deepEqual(await storedOptOuts(), []);
    await optOutPage.reload();
    await optOutPage.waitForFunction(() => document.querySelectorAll('.contest-card').length > 0);
    assert.equal(await optOutPage.locator('.contest-card[data-contest-id="active"]').count(), 2, 'all remaining contests restore and persist');
    // Enough hidden entries to fill the list; the modal footer must remain reachable
    // by ordinary scrolling before and after a rejected save in short windows.
    await optOutPage.evaluate(() => {
      const settings = JSON.parse(localStorage.getItem('contest-settings'));
      settings.contestOptOuts = Array.from({ length: 20 }, (_, i) => `atcoder:abc${400 + i}`);
      localStorage.setItem('contest-settings', JSON.stringify(settings));
    });
    await optOutPage.reload();
    await optOutPage.waitForFunction(() => document.querySelector('#contests-restore')?.textContent.includes('20'));
    const scrollToRestoreFooter = async label => {
      const dialog = optOutPage.locator('#contest-restore-dialog');
      await dialog.evaluate(node => { node.scrollTop = 0; });
      const bounds = await dialog.boundingBox();
      await optOutPage.mouse.move(bounds.x + 8, bounds.y + bounds.height - 8);
      await optOutPage.mouse.wheel(0, 1000);
      await optOutPage.waitForFunction(() => {
        const dialog = document.querySelector('#contest-restore-dialog'), bounds = dialog.getBoundingClientRect();
        return ['contest-restore-confirm', 'contest-restore-cancel'].every(id => {
          const button = document.getElementById(id), rect = button.getBoundingClientRect();
          return rect.top >= bounds.top && rect.bottom <= bounds.bottom && rect.bottom <= innerHeight && document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === button;
        });
      }, null, { timeout: 3000 }).catch(error => { throw new Error(`${label}: restore actions are clipped or not pointer accessible`, { cause: error }); });
    };
    for (const viewport of [{ width: 1050, height: 700 }, { width: 800, height: 390 }]) {
      await optOutPage.setViewportSize(viewport);
      await openRestore();
      assert.equal(await inputs.count(), 20);
      await scrollToRestoreFooter(`${viewport.width}x${viewport.height} before save`);
      await optOutPage.evaluate(() => { window.rejectNextSave = true; });
      await optOutPage.locator('#contest-restore-confirm').click();
      await optOutPage.waitForSelector('#contest-restore-error:not([hidden])');
      await scrollToRestoreFooter(`${viewport.width}x${viewport.height} after save error`);
      await optOutPage.locator('#contest-restore-cancel').click();
      assert.equal(await optOutPage.locator('#contest-restore-dialog').evaluate(node => node.open), false);
    }
    await optOutPage.close();
    const typesPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await typesPage.clock.install({ time: instant });
    await typesPage.addInitScript(({ instant }) => {
      const iso = offset => new Date(instant + offset).toISOString();
      const contests = [
        ['abc483', 'Sponsor fixture', 'ABC'], ['arc234', 'AtCoder Regular Contest++ 234', 'ARC'],
        ['agc079', 'AtCoder Grand Contest 079', 'AGC'], ['sponsor2027', 'HACK TO THE FUTURE (AtCoder Heuristic Contest 074)', 'AHC'],
        ['other', 'Other programming event', ''], ['abcpractice', 'ABC practice session', '']
      ].map(([id, title, expected], i) => ({ id, title, expected, url: `https://atcoder.jp/contests/${id}`, startTime: iso(3600000 + i * 60000), endTime: iso(10800000 + i * 60000) }));
      window.typeFixtures = contests;
      const settings = { autoSync: false, contestOptOuts: [] };
      const payload = { settings, local: { records: [] }, contests: { platforms: [
        { id: 'atcoder', contests, stale: false, error: null, updatedAt: iso(0) },
        { id: 'luogu', contests: [{ ...contests[0], url: 'https://www.luogu.com.cn/contest/1' }], stale: false, error: null }
      ] } };
      window.notebook = { bootstrap: async () => payload, getContests: async () => payload.contests, saveSettings: async next => Object.assign(settings, next), openExternal: async () => {}, onAuthProgress() {}, onUpdateProgress() {} };
    }, { instant });
    await typesPage.goto(url);
    await typesPage.waitForSelector('.contest-type-badge');
    assert.deepEqual(await typesPage.locator('.contest-card[data-platform="atcoder"] .contest-type-badge').allTextContents(), ['ABC', 'ARC', 'AGC']);
    assert.equal(await typesPage.locator('.contest-card[data-platform="luogu"] .contest-type-badge').count(), 0, 'type badges are exclusive to AtCoder');
    for (const [id, expected] of [['abc483', 'ABC'], ['arc234', 'ARC'], ['agc079', 'AGC'], ['sponsor2027', 'AHC'], ['other', ''], ['abcpractice', '']]) {
      const row = typesPage.locator(`.contest-card[data-platform="atcoder"][data-contest-id="${id}"]`);
      assert.deepEqual(await row.locator('.contest-type-badge').allTextContents(), expected ? [expected] : []);
      await row.locator('.contest-decline').click();
      await typesPage.waitForFunction(() => !document.querySelector('#contests-restore').disabled);
    }
    await typesPage.locator('#contests-restore').click();
    assert.deepEqual(await typesPage.locator('#contest-restore-options .contest-type-badge').allTextContents(), ['ABC', 'ARC', 'AGC', 'AHC']);
    await typesPage.locator('#contest-restore-confirm').click();
    await typesPage.waitForFunction(() => !document.querySelector('#contest-restore-dialog').open);
    for (const width of [1440, 1024, 390]) {
      await typesPage.setViewportSize({ width, height: 1000 });
      assert(await typesPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `AtCoder badge layout fits ${width}px`);
      assert(await typesPage.locator('.contest-card .contest-type-badge').evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().right <= innerWidth)));
    }
    await typesPage.close();
    console.log('ATCODER TYPES PASS: ABC/ARC/AGC by ID, sponsored AHC by official title, unknown/practice unlabelled, non-AtCoder excluded, restore badges and responsive layout');
    console.log('CONTESTS UI PASS: reminders before hero, four compact source links, one globally sorted list with three contests per source, <=70px desktop rows and ellipsized titles, source status/tooltips, background/forced/TTL refresh and focus throttling, ticking and start/end boundaries, keyboard focus fallback, rejection retention, Beijing timezone, escaped title, external links, navigation, three themes and narrow layout, durations and decline controls, selective restore modal and rollback, honest preview');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
