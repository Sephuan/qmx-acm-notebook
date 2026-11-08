'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      const notes = [
        { id: 'n1', kind: 'algorithm-note', noteScope: 'public', nodeId: 'xcpc-动态规划-1', title: '背包状态设计', author: 'admin', authorId: 1, tags: ['动态规划', '背包'], featured: true, updatedAt: '2026-11-08', body: '复杂度为 $O(nW)$，转移为 $dp[w]=\\max(dp[w],dp[w-w_i]+v_i)$。' },
        { id: 'n2', kind: 'algorithm-note', noteScope: 'public', nodeId: 'xcpc-动态规划-1', title: '线性 DP 入门', author: 'alice', authorId: 2, tags: ['动态规划'], featured: false, updatedAt: '2026-11-07', body: '线性状态。' },
        { id: 'n3', kind: 'algorithm-note', noteScope: 'personal', nodeId: 'xcpc-动态规划-1', title: '我的状态机笔记', author: 'alice', authorId: 2, tags: ['状态机'], featured: false, updatedAt: '2026-11-06', body: '个人内容。' },
        { id: 'n4', kind: 'algorithm-note', noteScope: 'public', nodeId: 'xcpc-函数-1', title: '青档函数笔记', author: 'bob', authorId: 3, tags: ['语法'], featured: false, updatedAt: '2026-11-05', body: '入门内容。' },
        { id: 'n5', kind: 'algorithm-note', noteScope: 'public', nodeId: 'xcpc-01背包-1', title: '01背包子节点笔记', author: 'carol', authorId: 4, tags: ['背包'], featured: false, updatedAt: '2026-11-04', body: '子节点内容。' }
      ];
      window.notebook = {
        bootstrap: async () => ({ records: [], issues: [], algorithmNotes: notes, account: { id: 2, login: 'alice', name: 'Alice' }, permissions: { repo: 'team/notebook', push: true, admin: false }, settings: { repo: 'team/notebook', autoSync: false }, local: { records: [], favorites: [], mastery: {}, draft: {} } }),
        sync: async () => ({ records: [], issues: [], algorithmNotes: notes, account: { id: 2, login: 'alice' }, permissions: { repo: 'team/notebook', push: true, admin: false }, settings: { repo: 'team/notebook', autoSync: false }, local: { records: [], favorites: [], mastery: {}, draft: {} } }),
        saveAlgorithmNote: async record => ({ ...record, id: 'new-note', kind: 'algorithm-note', author: 'alice', authorId: 2, updatedAt: '2026-11-08' }),
        updateLocal: async () => {}, openExternal: async () => {}
      };
    });
    await page.goto(pathToFileURL(path.resolve(__dirname, '../ui/index.html')).href);
    await page.click('[data-view="algorithms"]');
    await page.waitForSelector('#algorithm-panel');
    assert.equal(await page.locator('#algorithm-panel').isVisible(), true);
    assert.equal(await page.locator('.algorithm-tree-node').count() > 1, true);
    // 悬停展开的侧栏在收起动画期间会覆盖内容，先移开鼠标再点击节点。
    await page.mouse.move(1100, 780);
    await page.waitForTimeout(350);
    await page.locator('[data-node="xcpc-动态规划-1"]').click();
    assert.match(await page.locator('.algorithm-note-drawer').innerText(), /背包状态设计/);
    assert.match(await page.locator('.featured-badge').innerText(), /精选/);

    // 按难度搜索：下拉选择「基础（入门）」时跨节点列出该颜色下的笔记。
    await page.selectOption('.algorithm-level-filter', 'basic');
    assert.match(await page.locator('.algorithm-note-drawer').innerText(), /青档函数笔记/);
    assert.doesNotMatch(await page.locator('.algorithm-note-drawer').innerText(), /背包状态设计/);
    assert.equal(await page.locator('.algorithm-tree-node.dimmed').count() > 0, true);
    // 文本搜索“入门”也按难度别名命中同一档位。
    await page.selectOption('.algorithm-level-filter', '');
    await page.fill('.algorithm-search', '入门');
    assert.match(await page.locator('.algorithm-note-drawer').innerText(), /青档函数笔记/);
    await page.fill('.algorithm-search', '');

    // 点击子节点也应显示对应笔记（不仅是根节点）。
    await page.locator('[data-node="xcpc-01背包-1"]').click();
    await page.waitForTimeout(300);
    assert.match(await page.locator('.algorithm-note-drawer').innerText(), /01背包子节点笔记/);

    await page.fill('.algorithm-search', '状态机');
    assert.match(await page.locator('.algorithm-note-drawer').innerText(), /没有算法笔记/);
    // 个人笔记挂在「动态规划」节点上，切回该节点再查看「我的笔记」。
    await page.locator('[data-node="xcpc-动态规划-1"]').click();
    await page.waitForTimeout(250);
    await page.click('.algorithm-toolbar button:has-text("我的笔记")');
    assert.match(await page.locator('.algorithm-note-drawer').innerText(), /我的状态机笔记/);
    await page.click('.algorithm-note-card');
    assert.match(await page.locator('.algorithm-reading').innerText(), /我的状态机笔记/);
    assert.deepEqual(errors, []);
    console.log('ALGORITHM NOTES UI PASS');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
