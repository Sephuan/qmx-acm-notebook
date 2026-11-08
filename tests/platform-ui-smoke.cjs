'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, hasTouch: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const storageKey = 'platform-ui-smoke-platforms';
      const read = () => JSON.parse(localStorage.getItem(storageKey) || '{}');
      const clone = value => JSON.parse(JSON.stringify(value));
      const persist = value => localStorage.setItem(storageKey, JSON.stringify(value));
      const fixture = window.platformFixture = {
        state: read(), calls: [], links: [], failBind: false, failRefresh: false,
        holdBind: false, holdRefresh: false, releases: {},
        today: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
        release(code) { this.releases[code]?.(); delete this.releases[code]; },
        persist() { persist(this.state); }
      };
      const payload = () => ({ settings: { repo: 'team/test', autoSync: false }, account: null, records: [], issues: [], local: { records: [], favorites: [], mastery: {}, draft: {} }, platforms: clone(fixture.state) });
      const entry = (code, url) => {
        const name = code === 'CF' ? 'zero-user' : code === 'AT' ? 'at-user' : 'general-user';
        return {
          binding: { platform: code, id: name, username: name, url },
          data: {
            username: name, profileUrl: url, solvedCount: code === 'CF' ? 0 : null,
            submissionCount: code === 'CF' ? 0 : null,
            rating: code === 'CF' ? null : 0, maxRating: 0, ratedContests: 0,
            contests: code === 'CF' ? [
              { name: 'Round <img src=x onerror=alert(1)>', url: 'https://codeforces.com/contest/1', date: '2026-11-01', rank: 0, rating: 0, delta: 0, solvedCount: 0, problemCount: 7 },
              { name: 'Bad external URL', url: 'https://codeforces.com.attacker.test/contest/2', date: '2026-10-31', solvedCount: 8, problemCount: 7 },
              { name: 'Third contest', url: 'javascript:alert(1)', date: '2026-10-30' },
              { name: 'Fourth visible when expanded', url: 'https://codeforces.com/contest/4', date: '2026-10-29' }
            ] : [],
            ratingHistory: code === 'CF' ? [
              { date: '2026-10-01', rating: 0, name: 'Zero rating', rank: 0, delta: 0 },
              { date: '2026-11-01', rating: 1061, name: 'History <img src=x onerror=alert(1)>', rank: 12, delta: 3, solvedCount: 3, problemCount: 7 }
            ] : [{ date: '2026-11-01', rating: 2400, name: 'AT contest', rank: 1, delta: 0 }],
            ...(code === 'CF' ? { activity: { days: { [fixture.today]: 2 }, complete: true, note: '完整首次 AC 历史' } } : {}),
            sourceNote: '公开来源；部分数据不可获取'
          },
          updatedAt: '2026-11-01T12:00:00Z', attemptedAt: '2026-11-01T12:00:00Z', error: null
        };
      };
      window.notebook = {
        bootstrap: async () => payload(), updateLocal: async () => payload(), saveSettings: async () => ({}),
        openExternal: async url => { fixture.links.push(url); },
        bindPlatform: async (code, url) => {
          fixture.calls.push(['bind', code, url]);
          if (fixture.holdBind) await new Promise(resolve => { fixture.releases[code] = resolve; });
          if (fixture.failBind) throw new Error('该用户不存在，保留原账号');
          fixture.state[code] = entry(code, url); persist(fixture.state); return clone(fixture.state);
        },
        refreshPlatform: async code => {
          fixture.calls.push(['refresh', code]);
          const response = clone(fixture.state);
          if (fixture.holdRefresh) await new Promise(resolve => { fixture.releases[code] = resolve; });
          if (fixture.failRefresh) {
            response[code].error = '网络暂时不可用'; response[code].attemptedAt = '2026-11-02T12:00:00Z';
          } else {
            response[code].data.solvedCount = code === 'CF' ? 11 : 22;
            response[code].error = null; response[code].updatedAt = '2026-11-03T12:00:00Z';
          }
          fixture.state[code] = response[code]; persist(fixture.state); return response;
        },
        unbindPlatform: async code => {
          fixture.calls.push(['unbind', code]); delete fixture.state[code]; persist(fixture.state); return clone(fixture.state);
        }
      };
    });
    const open = () => page.goto(pathToFileURL(path.resolve(__dirname, '../ui/index.html')).href);
    const panel = page.locator('.platform-dashboard');
    const row = code => page.locator(`.platform-binding-row[data-platform="${code}"]`);
    const dialog = page.locator('#platform-bind-dialog');
    const input = page.locator('#platform-bind-url');
    const submit = page.locator('#platform-bind-submit');
    const choose = code => page.selectOption('#platform-select', code);
    const metric = key => panel.locator(`[data-metric="${key}"]`);
    const tip = page.locator('#platform-floating-tooltip');
    const tipLines = () => tip.locator('.platform-tooltip-line').allTextContents();
    const assertTipBounds = async () => {
      const rect = await tip.boundingBox();
      const viewport = page.viewportSize();
      assert.ok(rect && rect.x >= 7 && rect.y >= 7 && rect.x + rect.width <= viewport.width - 7 && rect.y + rect.height <= viewport.height - 7, JSON.stringify({ rect, viewport }));
      assert.equal(await tip.getAttribute('role'), 'tooltip');
      assert.equal(await tip.evaluate(node => getComputedStyle(node).position), 'fixed');
    };
    await open();
    await page.waitForFunction(() => window.NotebookPlatforms && document.querySelector('.platform-dashboard'));
    assert.equal(await panel.count(), 1);
    assert.equal(await page.locator('.platform-card').count(), 0);
    assert.equal(await page.locator('#platform-select').inputValue(), 'ALL');
    assert.match(await panel.innerText(), /做题与比赛总览/);
    assert.equal(await panel.locator('svg,.platform-heatmap-day').count(), 0);
    assert.equal(await page.locator('#platform-refresh-all').isDisabled(), true);
    await panel.getByRole('button', { name: '去设置绑定' }).click();
    assert.equal(await page.locator('#settings-dialog').evaluate(node => node.open), true);
    assert.equal(await page.locator('.platform-binding-row').count(), 5);
    await row('CF').getByRole('button').click();
    assert.match(await page.locator('#platform-bind-example').innerText(), /https:\/\/codeforces.com\/profile\/tourist/);
    await submit.click();
    assert.match(await page.locator('#platform-bind-error').innerText(), /请粘贴/);
    for (const url of ['http://codeforces.com/profile/tourist', 'https://codeforces.com.attacker.test/profile/tourist', 'https://x@codeforces.com/profile/tourist', 'https://codeforces.com:444/profile/tourist', 'https://codeforces.com/contest/1']) {
      await input.fill(url); await submit.click();
      assert.match(await page.locator('#platform-bind-error').innerText(), /官方个人主页/);
    }
    assert.equal(await page.evaluate(() => platformFixture.calls.length), 0);
    await page.evaluate(() => { platformFixture.holdBind = true; });
    await input.fill('https://codeforces.com/profile/zero-user'); await submit.click();
    await page.waitForFunction(() => Boolean(platformFixture.releases.CF));
    assert.equal(await submit.isDisabled(), true);
    assert.equal(await input.isDisabled(), true);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.evaluate(node => node.open), true);
    await page.evaluate(() => { platformFixture.release('CF'); platformFixture.holdBind = false; });
    await page.waitForFunction(() => !document.querySelector('#platform-bind-dialog').open);
    assert.equal(await row('CF').getByRole('button').innerText(), 'zero-user');
    await row('CF').getByRole('button').click();
    await page.evaluate(() => { platformFixture.failBind = true; });
    await input.fill('https://codeforces.com/profile/not-a-user'); await submit.click();
    await page.waitForFunction(() => document.querySelector('#platform-bind-error').textContent.includes('该用户不存在'));
    assert.equal(await dialog.evaluate(node => node.open), true);
    assert.equal(await row('CF').getByRole('button').innerText(), 'zero-user');
    await page.evaluate(() => { platformFixture.failBind = false; });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await row('AT').getByRole('button').click();
    await input.fill('https://atcoder.jp/users/at-user'); await submit.click();
    await page.waitForFunction(() => !document.querySelector('#platform-bind-dialog').open);
    await page.click('[data-close="settings-dialog"]');
    assert.equal(await metric('solved').innerText(), '0');
    assert.equal(await metric('submissions').innerText(), '0');
    assert.match(await panel.locator('.platform-metric').first().innerText(), /已知合计[\s\S]*1\/5/);
    assert.match(await panel.innerText(), /同一道题跨平台不去重/);
    assert.equal(await panel.locator('.platform-rating-chart').count(), 2);
    assert.match(await panel.locator('.platform-rating-chart[data-platform="CF"] svg').getAttribute('aria-label'), /独立刻度 0 至 1189/);
    assert.match(await panel.locator('.platform-rating-chart[data-platform="AT"] svg').getAttribute('aria-label'), /2350 至 2450/);
    const dot = panel.locator('.platform-rating-chart[data-platform="CF"] circle').last();
    await dot.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await dot.hover();
    assert.deepEqual(await tipLines(), ['History <img src=x onerror=alert(1)>', 'Rating 1058 → 1061（+3）', '3/7']);
    assert.equal(await tip.locator('strong').count(), 1);
    assert.equal(await dot.getAttribute('aria-describedby'), 'platform-floating-tooltip');
    await assertTipBounds();
    await page.keyboard.press('Escape');
    assert.equal(await tip.isVisible(), false);
    await panel.locator('.platform-rating-chart[data-platform="CF"] circle').first().focus();
    assert.deepEqual(await tipLines(), ['Zero rating', 'Rating 0 → 0（0）']);
    assert.equal(await panel.locator('circle title,.platform-chart-point[title],.platform-heatmap-day[title],.platform-chart-tooltip,.platform-heatmap-tooltip').count(), 0);
    assert.equal(await panel.locator('img').count(), 0);
    assert.equal(await panel.locator('[onclick],[onmouseover],[onfocus]').count(), 0);
    const today = await page.evaluate(() => platformFixture.today);
    const cells = panel.locator('.platform-heatmap-day');
    assert.ok([365, 366].includes(await cells.count()));
    const todayCell = () => panel.locator(`.platform-heatmap-day[data-date="${today}"]`);
    await todayCell().hover();
    assert.deepEqual(await tipLines(), [today, '总通过：2道（已知）']);
    assert.equal(await tip.locator('strong').count(), 0);
    await assertTipBounds();
    await page.mouse.move(0, 0);
    assert.equal(await tip.isVisible(), false);
    assert.equal(await cells.first().getAttribute('data-level'), 'unknown');
    assert.match(await panel.locator('.platform-activity').innerText(), /完整历史 1\/5/);
    await page.evaluate(() => {
      window.stablePlatformNodes = ['.platform-rating-charts', '.platform-recent', '.platform-account-strip', '.platform-source-details'].map(selector => document.querySelector(selector));
      window.stablePlatformCharts = [...document.querySelectorAll('.platform-rating-chart')];
      window.globalContestText = document.querySelector('.platform-recent').textContent;
    });
    const assertGlobalStable = async () => {
      assert.equal(await page.evaluate(() => stablePlatformNodes.every(node => node.isConnected) && stablePlatformCharts.every(node => node.isConnected) && globalContestText === document.querySelector('.platform-recent').textContent), true);
      assert.equal(await panel.locator('.platform-rating-chart').count(), 2);
      assert.equal(await panel.locator('.platform-username').count(), 2);
    };
    await choose('AT');
    await assertGlobalStable();
    assert.equal(await metric('solved').innerText(), '暂无数据');
    assert.equal(await metric('submissions').innerText(), '暂无数据');
    assert.equal(await panel.locator('.platform-rating-summary').count(), 0);
    assert.equal(await panel.locator('.platform-latest-name').count(), 0);
    assert.equal(await panel.locator('.platform-contest').count(), 3);
    assert.equal(await panel.locator('.platform-heatmap-day').count(), 0);
    assert.match(await panel.locator('.platform-activity').innerText(), /旧缓存/);
    await page.evaluate(() => {
      platformFixture.state.AT.data.activity = { days: { [platformFixture.today]: 3 }, complete: false, note: '部分历史' };
      NotebookPlatforms.render(platformFixture.state);
    });
    assert.equal(await todayCell().getAttribute('data-count'), '3');
    assert.equal(await cells.first().getAttribute('data-level'), 'unknown');
    await page.evaluate(() => {
      window.stablePlatformNodes = ['.platform-rating-charts', '.platform-recent', '.platform-account-strip', '.platform-source-details'].map(selector => document.querySelector(selector));
      window.stablePlatformCharts = [...document.querySelectorAll('.platform-rating-chart')];
    });
    await choose('CF');
    await assertGlobalStable();
    assert.equal(await cells.first().getAttribute('data-level'), '0');
    await todayCell().focus();
    await page.keyboard.press('ArrowLeft');
    assert.equal((await tipLines())[1], '总通过：0道');
    assert.equal(await panel.locator('.platform-contest').count(), 3);
    assert.equal(await panel.locator('.platform-contest a').count(), 1);
    assert.match(await panel.locator('.platform-contest-details').first().innerText(), /排名 0 · Rating 0 → 0（0） · 0\/7/);
    await panel.locator('.platform-contest').first().hover();
    assert.deepEqual(await tipLines(), ['Round <img src=x onerror=alert(1)>', 'Rating 0 → 0（0）', '0/7']);
    assert.equal(await tip.locator('strong').count(), 1);
    await panel.locator('.platform-contest').nth(1).focus();
    assert.deepEqual(await tipLines(), ['Bad external URL']);
    await panel.locator('.platform-latest').hover();
    assert.deepEqual(await tipLines(), ['Round <img src=x onerror=alert(1)>', 'Rating 0 → 0（0）', '0/7']);
    assert.equal(await panel.locator('.platform-latest-result').innerText(), 'Rating 0 → 0（0） · 0/7');
    await panel.locator('.platform-contest a').click();
    assert.deepEqual(await page.evaluate(() => platformFixture.links), ['https://codeforces.com/contest/1']);
    await page.click('#platform-expand');
    assert.equal(await page.locator('#platform-expand').getAttribute('aria-expanded'), 'true');
    assert.equal(await panel.locator('.platform-contest').count(), 4);
    assert.equal(await panel.locator('.platform-latest-name').innerText(), 'Round <img src=x onerror=alert(1)>');
    await page.click('#platform-expand');
    await page.selectOption('#platform-activity-period', String(Number(today.slice(0, 4)) - 1));
    const previousYear = Number(today.slice(0, 4)) - 1;
    const leap = previousYear % 4 === 0 && (previousYear % 100 !== 0 || previousYear % 400 === 0);
    assert.equal(await cells.count(), leap ? 366 : 365);
    await page.selectOption('#platform-activity-period', 'recent');
    await page.evaluate(() => { platformFixture.failRefresh = true; });
    await page.click('#platform-refresh-all');
    await page.waitForFunction(() => document.querySelector('.platform-error[data-platform="CF"]')?.textContent.includes('网络暂时不可用'));
    assert.equal(await metric('solved').innerText(), '0');
    assert.match(await panel.locator('.platform-error').innerText(), /保留上次数据/);
    assert.deepEqual(await page.evaluate(() => platformFixture.calls.filter(call => call[0] === 'refresh').map(call => call[1])), ['CF']);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.platform-error[data-platform="CF"]'));
    assert.equal(await page.locator('#platform-select').inputValue(), 'ALL');
    // Concurrent responses carry stale copies of the other platform. Only merge the requested code.
    await page.evaluate(() => { platformFixture.holdRefresh = true; platformFixture.failRefresh = false; });
    await page.click('#platform-refresh-all');
    await page.waitForFunction(() => platformFixture.releases.CF && platformFixture.releases.AT);
    await page.evaluate(() => NotebookPlatforms.refreshPlatform('CF'));
    assert.equal(await page.evaluate(() => platformFixture.calls.filter(call => call[0] === 'refresh' && call[1] === 'CF').length), 1);
    assert.equal(await page.locator('#platform-refresh-all').isDisabled(), true);
    await page.evaluate(() => {
      NotebookPlatforms.render({});
      platformFixture.release('CF');
    });
    await page.waitForFunction(() => document.querySelector('[data-metric="solved"]').textContent === '11');
    await page.evaluate(() => platformFixture.release('AT'));
    await page.waitForFunction(() => document.querySelector('[data-metric="solved"]').textContent === '33');
    assert.equal(await panel.locator('.platform-error').count(), 0);
    await todayCell().hover();
    assert.deepEqual(await tipLines(), [today, '总通过：5道（已知）']);
    await choose('LG');
    assert.equal(await metric('solved').innerText(), '暂无数据');
    assert.equal(await metric('submissions').innerText(), '暂无数据');
    assert.equal(await panel.locator('.platform-latest-name').count(), 0);
    assert.equal(await panel.locator('svg').count(), 2);
    assert.equal(await panel.locator('.platform-contest').count(), 3);
    assert.equal(await panel.locator('.platform-heatmap-day').count(), 0);
    assert.equal(await page.locator('#platform-refresh-all').isDisabled(), true);
    await page.evaluate(() => {
      const today = platformFixture.today;
      const previous = new Date(`${today}T00:00:00Z`); previous.setUTCDate(previous.getUTCDate() - 1);
      platformFixture.state.LG = {
        binding: { platform: 'LG', id: '1', username: 'general-user', url: 'https://www.luogu.com.cn/user/1' },
        data: { solvedCount: null, submissionCount: null, activity: { days: {}, complete: false, rangeComplete: true, startDate: previous.toISOString().slice(0, 10), endDate: previous.toISOString().slice(0, 10), note: '官方每日通过题数，数据延迟一天' } }
      };
      NotebookPlatforms.render(platformFixture.state);
    });
    assert.equal(await panel.locator('svg').count(), 2);
    assert.equal(await todayCell().getAttribute('data-level'), 'unknown');
    await todayCell().hover();
    assert.deepEqual(await tipLines(), [today, '暂无数据']);
    assert.equal(await cells.nth((await cells.count()) - 2).getAttribute('data-level'), '0');
    await cells.nth((await cells.count()) - 2).focus();
    assert.equal((await tipLines())[1], '总通过：0道');
    assert.match(await panel.locator('.platform-activity').innerText(), /洛谷采用官方每日通过题数/);
    await page.evaluate(() => { delete platformFixture.state.LG; NotebookPlatforms.render(platformFixture.state); });
    await choose('ALL');
    for (const theme of ['light', 'dark', 'cards']) {
      await page.selectOption('#theme-select', theme);
      assert.equal(await panel.isVisible(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.click('#platform-expand');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await panel.locator('.platform-heatmap-scroll').evaluate(node => node.scrollWidth > node.clientWidth), true);
    await todayCell().scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await todayCell().tap();
    assert.deepEqual(await tipLines(), [today, '总通过：5道（已知）']);
    await assertTipBounds();
    await page.evaluate(() => document.querySelector('.platform-heatmap-scroll').dispatchEvent(new Event('scroll')));
    assert.equal(await tip.isVisible(), false);
    await todayCell().click();
    assert.equal(await tip.isVisible(), true);
    await page.setViewportSize({ width: 390, height: 800 });
    await tip.waitFor({ state: 'hidden' });
    await panel.locator('.platform-contest').first().scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await panel.locator('.platform-contest').first().hover();
    await assertTipBounds();
    assert.equal(await tip.locator('strong').count(), 1);
    await panel.locator('.platform-contest').first().focus();
    await page.locator('#platform-select').focus();
    assert.equal(await tip.isVisible(), false);
    await page.click('#platform-settings');
    assert.equal(await row('CF').getByRole('button').innerText(), 'zero-user');
    await row('CF').getByRole('button').click();
    await page.click('#platform-unbind');
    await page.waitForFunction(() => !document.querySelector('#platform-bind-dialog').open);
    assert.equal(await row('CF').getByRole('button').innerText(), '绑定账号');
    await page.click('[data-close="settings-dialog"]');
    await choose('CF');
    assert.equal(await panel.locator('.platform-username').count(), 1);
    assert.equal(await panel.locator('.platform-rating-chart').count(), 2);
    assert.equal(await panel.locator('svg').count(), 1);
    assert.equal(await panel.locator('.platform-heatmap-day').count(), 0);
    assert.equal(await metric('solved').innerText(), '暂无数据');
    assert.equal(await panel.locator('.platform-latest-name').count(), 0);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.platform-dashboard'));
    assert.equal(await panel.locator('.platform-username').innerText(), 'AT · at-user');
    assert.deepEqual(errors, []);
    console.log('PLATFORM UI PASS: scoped totals/activity/latest with stable global charts/history/accounts/sources; minimalist floating daily/contest tooltips, exact lines and bold names, rating transitions and valid solved/total, hover/focus/click/touch, dismissal and 390px clamping; zero vs unknown, independent SVG scales, heatmap coverage/keyboard/year controls, safe text/links, username settings, URL validation, pending/concurrent lifecycle, refresh/error/reload/unbind, three themes and expandable panel');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
