'use strict';
// Run with: node tests/algorithm-notes-ui-smoke.cjs (Playwright + Microsoft Edge).
const assert = require('node:assert/strict');
const directory = require('../data/algorithm-directory.json');
const legacy = require('../docs/algorithm-research/legacy-node-map.json');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const tree = require('../ui/algorithm-tree.js');

const nodes = []; (function walk(node) { nodes.push(node); (node.children || []).forEach(walk); })(tree);
const byId = new Map(nodes.flatMap(node => [node.id, ...(node.legacyIds || [])].map(id => [id, node])));
const canonical = id => {
  const node = byId.get(id);
  assert.ok(node, `legacy node ${id} resolves to a current directory`);
  return node.id;
};
const OLD_DP = 'xcpc-动态规划-1';
const DP = canonical(OLD_DP);
const PACK = canonical('xcpc-01背包-1');
const FUNCTION = canonical('xcpc-函数-1');
const hasAttribute = (node, attribute) => (node.attributes || []).includes(attribute);
const nodeForNote = note => byId.get(note.nodeId);
const MALICIOUS_TITLE = '<img src=x onerror="window.__algorithmXss=1">恶意标题';
const MALICIOUS_TAG = '<svg onload="window.__algorithmXss=2">标签';
const MALICIOUS_AUTHOR = '<img src=x onerror="window.__algorithmXss=3">';
const NOTES = [
  { id: 'n1', noteScope: 'public', nodeId: DP, title: '背包状态设计', author: 'admin', authorId: 1, tags: ['动态规划', '背包'], featured: true, updatedAt: '2026-11-08', body: '# 状态转移\n\n复杂度为 $O(nW)$。\n\n```cpp\nint answer = 42;\n```\n\n<img src="missing" onerror="window.__algorithmXss=4"><script>window.__algorithmXss=5</script>\n\n[危险链接](javascript:window.__algorithmXss=6)\n\n<iframe src="https://example.invalid"></iframe><style>body{display:none}</style>' },
  { id: 'n2', noteScope: 'public', nodeId: OLD_DP, title: '线性 DP 入门', author: 'alice', authorId: 2, tags: ['动态规划'], updatedAt: '2026-11-07', body: '线性状态。' },
  { id: 'n3', noteScope: 'personal', nodeId: DP, title: '我的状态机笔记', author: 'alice', authorId: 2, tags: ['状态机', 'private-only-token'], updatedAt: '2026-11-06', body: '个人内容。' },
  { id: 'n4', noteScope: 'public', nodeId: FUNCTION, title: '青档函数笔记', author: 'bob', authorId: 3, tags: ['语法', 'tag-only-token'], updatedAt: '2026-11-05', body: '入门内容。' },
  { id: 'n5', noteScope: 'public', nodeId: PACK, title: '01背包子节点笔记', author: 'carol', authorId: 4, tags: ['背包'], updatedAt: '2026-11-04', body: '子节点内容。' },
  { id: 'other-private', noteScope: 'personal', nodeId: DP, title: '他人的私密状态机', author: 'bob', authorId: 3, tags: ['状态机'], updatedAt: '2026-11-09', body: '绝不能泄露。' },
  { id: 'unsafe', noteScope: 'public', nodeId: DP, title: MALICIOUS_TITLE, author: MALICIOUS_AUTHOR, authorId: 99, tags: [MALICIOUS_TAG], updatedAt: '2026-11-03', body: '安全显示字符串。' },
  ...['basic', 'beginner', 'intermediate', 'advanced', 'expert', 'board', 'useful', 'useless'].map((color, index) => {
    const nodes = []; (function walk(node) { nodes.push(node); (node.children || []).forEach(walk); })(tree);
    return { id: `category-${color}`, noteScope: 'public', nodeId: nodes.find(node => node.color === color || hasAttribute(node, color)).id, title: `分类样本 ${color}`, author: `level-author-${index}`, authorId: 10 + index, tags: [`level-${color}`], updatedAt: '2026-11-01', body: `${color} 样本内容。` };
  }),
].map(note => ({ kind: 'algorithm-note', featured: false, ...note }));

function checkTreeContract() {
  assert.equal(nodes.length, directory.summary.nodes);
  assert.equal(new Set(nodes.map(node => node.id)).size, nodes.length);
  assert.equal(nodes.filter(node => node.sourceHeading).length, 126);
  for (const [oldId, targetId] of Object.entries(legacy.map)) assert.equal(canonical(oldId), targetId);
  assert.equal(Object.keys(legacy.map).length, 367);
}

async function openAlgorithms(browser, errors, { signedIn = true, push = true, admin = false, width = 1440 } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 940 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ notes, signedIn, push, admin }) => {
    window.__algorithmXss = 0;
    window.__algorithmSaved = [];
    const payload = { records: [], issues: [], algorithmNotes: notes, algorithmTopics: JSON.parse(sessionStorage.getItem('algorithm-topics-fixture') || '[]'),
      account: signedIn ? { id: 2, login: 'alice', name: 'Alice' } : null,
      permissions: { repo: 'team/notebook', push, admin },
      settings: { repo: 'team/notebook', autoSync: false },
      local: { records: [], favorites: [], mastery: {}, draft: {} } };
    window.notebook = {
      bootstrap: async () => payload, sync: async () => payload,
      saveAlgorithmNote: async record => { window.__algorithmSaved.push(record); return { ...record, id: 'new-note', path: 'personal/new-note.md', kind: 'algorithm-note', author: 'alice', authorId: 2, updatedAt: '2026-11-10' }; },
      saveAlgorithmTopic: async record => { if (!admin) throw new Error('管理员权限'); const topic = { ...record, id: `custom-${crypto.randomUUID()}`, repo: 'team/notebook' }; payload.algorithmTopics.push(topic); sessionStorage.setItem('algorithm-topics-fixture', JSON.stringify(payload.algorithmTopics)); return topic; },
      updateLocal: async () => {}, saveSettings: async settings => settings, openExternal: async () => {},
    };
  }, { notes: NOTES, signedIn, push, admin });
  await page.goto(pathToFileURL(path.resolve(__dirname, '../ui/index.html')).href);
  await page.locator('.rail-nav-item[data-view="algorithms"]').click();
  await page.waitForSelector('#algorithm-panel .alg-browser');
  await page.mouse.move(Math.max(300, width - 80), 800);
  // Wait for the actual sidebar geometry, not a fixed animation delay.
  await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().width <= 73);
  return page;
}

// Measure actual composited backgrounds, including translucent ancestors. WCAG
// small-text threshold applies to all node labels and category badges.
async function assertTextContrast(page, selector, theme) {
  const results = await page.locator(selector).evaluateAll(elements => {
    const rgba = value => {
      const match = value.match(/[\d.]+/g);
      if (!match) throw new Error(`Cannot parse computed color: ${value}`);
      const scale = value.startsWith('color(srgb ') ? 255 : 1;
      if (!value.startsWith('rgb') && scale !== 255) throw new Error(`Unsupported computed color space: ${value}`);
      return [Number(match[0]) * scale, Number(match[1]) * scale, Number(match[2]) * scale, match[3] === undefined ? 1 : Number(match[3])];
    };
    const over = (fg, bg) => {
      const alpha = fg[3] + bg[3] * (1 - fg[3]);
      return [0, 1, 2].map(i => (fg[i] * fg[3] + bg[i] * bg[3] * (1 - fg[3])) / alpha).concat(alpha);
    };
    const luminance = color => color.slice(0, 3).map(c => c / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4).reduce((v, c, i) => v + c * [0.2126, 0.7152, 0.0722][i], 0);
    return elements.filter(el => el.getClientRects().length && el.textContent.trim()).map(el => {
      const lineage = []; for (let node = el; node; node = node.parentElement) lineage.unshift(node);
      let background = [255, 255, 255, 1];
      for (const node of lineage) {
        const style = getComputedStyle(node);
        const layer = rgba(style.backgroundColor);
        // An opaque descendant fully masks any ancestor gradient.
        if (layer[3] === 1) background = layer;
        else background = over(layer, background);
        if (style.backgroundImage !== 'none') throw new Error(`Contrast target has a background image: ${node.className}`);
        if (Number(style.opacity) !== 1) throw new Error(`Contrast target has group opacity: ${node.className}`);
      }
      const foreground = over(rgba(getComputedStyle(el).color), background);
      const a = luminance(foreground), b = luminance(background);
      return { text: el.textContent.trim().slice(0, 65), className: el.className, foreground, background, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
    });
  });
  assert.ok(results.length > 0, `${theme}: contrast selectors must find visible text`);
  for (const result of results) assert.ok(result.ratio >= 4.5, `${theme}: ${result.className} ${JSON.stringify(result.text)} contrast ${result.ratio.toFixed(2)} < 4.5; foreground=${result.foreground} background=${result.background}`);
  return results.length;
}

const item = (page, id) => page.locator(`.alg-tree-item[data-node-id="${id}"]`);
const row = (page, id) => page.locator(`.alg-tree-item[data-node-id="${id}"] > .alg-tree-row`);
const resultCards = page => page.locator('.alg-pane .alg-note-list:not(.alg-selected-note-list) .alg-note-card');
const noteTitles = page => resultCards(page).locator('.alg-note-title').allTextContents();
const scopeButton = (page, scope) => page.locator('.alg-scope-button').filter({ hasText: scope === 'personal' ? '我的笔记' : '公开笔记' });
async function clearFilters(page) {
  await page.locator('.alg-search').fill('');
  await page.locator('.alg-attribute').selectOption('');
  await page.locator('.alg-legend-button[data-level=""]').click();
  await page.locator('.alg-search-submit').click();
}
async function assertNoOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({
    viewport: innerWidth, document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    panel: document.querySelector('#algorithm-panel').getBoundingClientRect().toJSON(),
    tree: document.querySelector('.alg-tree-scroll').getBoundingClientRect().toJSON(),
    pane: document.querySelector('.alg-pane').getBoundingClientRect().toJSON(),
    treeScroll: document.querySelector('.alg-tree-scroll').scrollWidth,
    treeClient: document.querySelector('.alg-tree-scroll').clientWidth,
    paneScroll: document.querySelector('.alg-pane').scrollWidth,
    paneClient: document.querySelector('.alg-pane').clientWidth,
  }));
  assert.ok(dimensions.document <= dimensions.viewport + 1, `${label}: document overflows: ${JSON.stringify(dimensions)}`);
  assert.ok(dimensions.body <= dimensions.viewport + 1, `${label}: body overflows`);
  for (const name of ['panel', 'tree', 'pane']) {
    assert.ok(dimensions[name].left >= -1 && dimensions[name].right <= dimensions.viewport + 1, `${label}: ${name} escapes the viewport`);
  }
  assert.ok(dimensions.treeScroll <= dimensions.treeClient + 1, `${label}: directory has horizontal overflow`);
  assert.ok(dimensions.paneScroll <= dimensions.paneClient + 1, `${label}: note pane has horizontal overflow`);
}

(async () => {
  checkTreeContract();
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const errors = [];
  try {
    const page = await openAlgorithms(browser, errors);
    const difficultyIds = ['basic', 'beginner', 'intermediate', 'advanced', 'expert'];
    assert.deepEqual(await page.locator('.alg-legend-button[data-level]').evaluateAll(nodes => nodes.map(node => node.dataset.level)), ['', ...difficultyIds]);
    assert.deepEqual(await page.locator('.alg-attribute option').evaluateAll(nodes => nodes.map(node => node.value)), ['', 'board', 'useful', 'useless']);
    assert.match(await page.locator('.alg-tier-hint:not(.alg-search-hint)').innerText(), /模板、常用、低频是独立属性/);
    assert.ok((await page.locator('.alg-tree-status').innerText()).includes(String(nodes.length)));
    assert.equal(await item(page, 'root').getAttribute('aria-selected'), 'true');
    assert.equal(await row(page, DP).locator('.alg-badge').count(), 0, 'directory has no difficulty badge');
    assert.equal(await page.locator('.alg-detail-heading .alg-badge').count(), 0, 'directory detail has no difficulty badge');
    assert.equal(await row(page, DP).locator('.alg-node-kind').textContent(), '目录');
    assert.equal(await page.locator('.alg-detail-heading').innerText().then(text => /难度依据|覆盖 D/.test(text)), false);
    assert.equal(await item(page, DP).getAttribute('aria-expanded'), 'false');

    // Expanding a directory and selecting its title are separate operations.
    await row(page, DP).locator('button.alg-disclosure').click();
    assert.equal(await item(page, DP).getAttribute('aria-expanded'), 'true');
    assert.equal(await item(page, 'root').getAttribute('aria-selected'), 'true', 'disclosure does not change selection');
    assert.equal(await page.locator('.alg-detail-title').innerText(), 'XCPC算法');
    await row(page, DP).locator('.alg-tree-label').click();
    assert.equal(await item(page, DP).getAttribute('aria-selected'), 'true');
    assert.equal(await item(page, DP).getAttribute('aria-expanded'), 'true', 'title click does not collapse the directory');
    assert.ok((await noteTitles(page)).includes('背包状态设计'));
    assert.equal(await page.locator('.alg-note-card').first().locator('.alg-note-title').innerText(), '背包状态设计', 'featured notes sort first');
    assert.equal(await page.locator('.alg-featured').first().innerText(), '精选');
    assert.ok(!(await noteTitles(page)).includes('我的状态机笔记'));
    assert.ok(!(await noteTitles(page)).includes('他人的私密状态机'));
    assert.ok((await noteTitles(page)).includes(MALICIOUS_TITLE));
    const unsafe = page.locator('.alg-note-card').filter({ has: page.locator('.alg-note-title', { hasText: MALICIOUS_TITLE }) });
    assert.equal(await unsafe.locator('.alg-note-author').innerText(), MALICIOUS_AUTHOR);
    assert.equal(await unsafe.locator('.alg-tag').innerText(), MALICIOUS_TAG);
    assert.equal(await unsafe.locator('img, svg, script').count(), 0, 'untrusted metadata renders as text');
    assert.equal(await page.evaluate(() => window.__algorithmXss), 0);

    // All nodes can be reached without losing or changing their persisted IDs.
    await page.evaluate(() => {
      for (let pass = 0; pass < 1000; pass++) {
        const collapsed = Array.from(document.querySelectorAll('.alg-tree-item[aria-expanded="false"] > .alg-tree-row > button.alg-disclosure'));
        if (!collapsed.length) return;
        collapsed[0].click();
      }
      throw new Error('Directory expansion did not converge');
    });
    const ids = await page.locator('.alg-tree-item').evaluateAll(nodes => nodes.map(node => node.dataset.nodeId).sort());
    assert.deepEqual(ids, nodes.map(node => node.id).sort());
    await row(page, PACK).locator('.alg-tree-label').click();
    assert.ok((await noteTitles(page)).includes('01背包子节点笔记'));

    // Draft changes must leave both the current tree and results unchanged until submitted.
    const beforeDraft = await page.locator('.alg-workspace').innerHTML();
    await page.locator('.alg-search').fill('不存在的算法');
    await page.locator('.alg-legend-button[data-level="expert"]').click();
    assert.equal(await page.locator('.alg-workspace').innerHTML(), beforeDraft);
    await page.locator('.alg-search-submit').click();
    assert.equal(await page.locator('.alg-result-topic').count(), 0);
    await clearFilters(page);
    await page.locator('.alg-search').fill('迭代加深启发式搜索');
    await page.locator('.alg-search').press('Enter');
    assert.equal(await page.locator('.alg-result-topic-name').first().innerText(), 'IDA* 搜索');
    await page.locator('.alg-result-topic').first().click();
    assert.equal(await page.locator('.alg-detail-title').innerText(), '迭代加深启发式搜索（IDA*）');
    await clearFilters(page);
    assert.equal(await page.locator('.alg-add-topic').count(), 0, 'non-admin has no add-topic controls');

    // Search independently covers a node label, note title, tag and author.
    const searches = [
      ['01背包', '01背包子节点笔记', PACK],
      ['背包状态设计', '背包状态设计', DP],
      ['tag-only-token', '青档函数笔记', FUNCTION],
      ['carol', '01背包子节点笔记', PACK],
    ];
    for (const [query, title, nodeId] of searches) {
      await page.locator('.alg-search').fill(query);

      await page.locator('.alg-search-submit').click();
      assert.deepEqual(await noteTitles(page), [title], `global search for ${query}`);
      assert.equal(await item(page, nodeId).count(), 1, `${query} reveals its associated directory`);
      assert.equal(await item(page, 'root').count(), 1, `${query} preserves the ancestor chain`);
    }
    await page.locator('.alg-search').fill('private-only-token');

    await page.locator('.alg-search-submit').click();
    assert.deepEqual(await noteTitles(page), [], 'public search excludes personal notes');
    await scopeButton(page, 'personal').click();
    assert.deepEqual(await noteTitles(page), ['我的状态机笔记']);
    await page.locator('.alg-search').fill('状态机');

    await page.locator('.alg-search-submit').click();
    assert.deepEqual(await noteTitles(page), ['我的状态机笔记'], 'personal scope excludes other authors');
    await page.locator('.alg-search').fill('背包状态设计');

    await page.locator('.alg-search-submit').click();
    assert.deepEqual(await noteTitles(page), [], 'personal search excludes public notes');
    await scopeButton(page, 'public').click();
    assert.deepEqual(await noteTitles(page), ['背包状态设计']);
    await clearFilters(page);

    // Every difficulty returns only notes assigned that level; retained parent
    // directories give context without receiving a child difficulty themselves.
    for (const level of difficultyIds) {
      await page.locator(`.alg-legend-button[data-level="${level}"]`).click();

      await page.locator('.alg-search-submit').click();
      const expected = NOTES.filter(note => note.noteScope === 'public').filter(note => {
        const nodes = []; (function walk(node) { nodes.push(node); (node.children || []).forEach(walk); })(tree);
        return nodeForNote(note).color === level;
      }).map(note => note.title).sort();
      assert.deepEqual((await noteTitles(page)).sort(), expected, `${level} note results`);
      assert.equal(await item(page, 'root').count(), 1);
      assert.equal(await row(page, 'root').locator('.alg-badge').count(), 0, 'retained ancestor is a directory, never rated');
      const renderedIds = await page.locator('.alg-tree-item').evaluateAll(nodes => nodes.map(node => node.dataset.nodeId));
      const expectedIds = new Set();
      (function collect(node, ancestors = []) {
        if (node.color === level) [...ancestors, node.id].forEach(id => expectedIds.add(id));
        (node.children || []).forEach(child => collect(child, [...ancestors, node.id]));
      })(tree);
      assert.deepEqual(renderedIds.sort(), [...expectedIds].sort(), `${level} shows matching nodes and their ancestors`);
    }
    await page.locator('.alg-legend-button[data-level=""]').click();
    for (const attribute of ['board', 'useful', 'useless']) {
      await page.locator('.alg-attribute').selectOption(attribute);
      await page.locator('.alg-search-submit').click();
      assert.deepEqual((await noteTitles(page)).sort(), NOTES.filter(note => note.noteScope === 'public' && hasAttribute(nodeForNote(note), attribute)).map(note => note.title).sort());
      assert.equal(await page.locator('.alg-legend-button[data-level=""]').getAttribute('aria-pressed'), 'true', 'usage attributes do not select a difficulty');
      assert.ok((await page.locator('.alg-pane .alg-attribute-badge').allTextContents()).length > 0);
      assert.ok(!(await page.locator('.alg-pane .alg-badge').allTextContents()).includes('未分级'), 'attributes retain independent algorithm difficulties');
    }
    await clearFilters(page);

    // The reader occupies only the right pane and back restores selection,
    // expanded directory, query and difficulty, including the result set.
    await row(page, PACK).locator('.alg-tree-label').click();
    await page.locator('.alg-legend-button[data-level="beginner"]').click();
    await page.locator('.alg-search').fill('背包');

    await page.locator('.alg-search-submit').click();
    const beforeReader = await page.locator('.alg-tree').evaluate(node => ({ html: node.innerHTML, scroll: node.parentElement.scrollTop }));
    const beforeTitles = await noteTitles(page);
    assert.equal(await page.locator('.alg-selected-note-list .alg-note-title').innerText(), '01背包子节点笔记', 'selected topic notes remain available alongside difficulty results');
    await resultCards(page).filter({ hasText: '01背包子节点笔记' }).click();
    assert.equal(await page.locator('.alg-reading-title').innerText(), '01背包子节点笔记');
    assert.equal(await page.locator('.alg-sidebar').isVisible(), true);
    assert.deepEqual(await page.locator('.alg-tree').evaluate(node => ({ html: node.innerHTML, scroll: node.parentElement.scrollTop })), beforeReader, 'reader preserves the exact directory and scroll');
    await page.locator('.alg-reader-back').click();
    assert.equal(await item(page, PACK).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('.alg-search').inputValue(), '背包');
    assert.equal(await page.locator('.alg-legend-button[data-level="beginner"]').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await noteTitles(page), beforeTitles);
    await clearFilters(page);
    await row(page, DP).locator('.alg-tree-label').click();
    await page.locator('.alg-note-card').filter({ hasText: '背包状态设计' }).click();
    await page.waitForSelector('.alg-markdown .katex');
    assert.equal(await page.locator('.alg-markdown h1').innerText(), '状态转移');
    assert.match(await page.locator('.alg-markdown pre code.language-cpp').innerText(), /int answer = 42;/);
    assert.ok(await page.locator('.alg-markdown pre code .token').count() > 0, 'Prism highlights sanitized code');
    assert.equal(await page.locator('.alg-markdown script, .alg-markdown iframe, .alg-markdown style, .alg-markdown [onerror], .alg-markdown [onload], .alg-markdown a[href^="javascript:"]').count(), 0, 'parent Markdown renderer sanitizes active content');
    assert.equal(await page.evaluate(() => window.__algorithmXss), 0);
    await page.locator('.alg-reader-back').click();

    // Upload targets the selected node and retains the parent form's permission
    // rules. A save crosses the real form -> mocked notebook bridge boundary.
    await row(page, PACK).locator('.alg-tree-label').click();
    await page.locator('#algorithm-upload-button').click();
    assert.equal(await page.locator('#algorithm-note-dialog').evaluate(node => node.open), true);
    assert.equal(await page.locator('#algorithm-note-node').inputValue(), PACK);
    assert.equal(await page.locator('#algorithm-note-node option').count(), nodes.length);
    assert.equal(await page.locator('#algorithm-note-form [name="noteScope"]').inputValue(), 'personal');
    assert.equal(await page.locator('#algorithm-note-form [name="noteScope"]').isDisabled(), true);
    await page.locator('#algorithm-note-form [name="noteTitle"]').fill('新上传的背包笔记');
    await page.locator('#algorithm-note-form [name="noteTags"]').fill('背包,测试');
    await page.locator('#algorithm-note-form [name="body"]').fill('保存 $O(n)$ 状态。');
    await page.locator('#algorithm-note-form button[type="submit"]').click();
    await page.waitForFunction(() => !document.querySelector('#algorithm-note-dialog').open);
    const saved = await page.evaluate(() => window.__algorithmSaved);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].nodeId, PACK);
    assert.equal(saved[0].noteScope, 'personal');
    assert.deepEqual(saved[0].tags, ['背包', '测试']);
    await scopeButton(page, 'personal').click();
    assert.ok((await noteTitles(page)).includes('新上传的背包笔记'));
    await scopeButton(page, 'public').click();

    // Arrow keys move focus through actual visible rows, expand/collapse, move
    // to a parent, and Enter selects the focused algorithm rather than a no-op.
    await row(page, 'root').locator('.alg-tree-label').click();
    await item(page, 'root').focus();
    await page.keyboard.press('ArrowLeft');
    assert.equal(await item(page, 'root').getAttribute('aria-expanded'), 'false');
    await page.keyboard.press('ArrowRight');
    assert.equal(await item(page, 'root').getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('ArrowRight');
    const firstId = tree.children[0].id;
    assert.equal(await page.evaluate(() => document.activeElement.dataset.nodeId), firstId);
    await page.keyboard.press('ArrowDown');
    assert.notEqual(await page.evaluate(() => document.activeElement.dataset.nodeId), firstId);
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.nodeId), firstId);
    await page.keyboard.press('Enter');
    assert.equal(await item(page, firstId).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('.alg-detail-title').innerText(), tree.children[0].fullLabel);
    await page.keyboard.press('ArrowLeft');
    assert.equal(await item(page, firstId).getAttribute('aria-expanded'), 'false');
    await page.keyboard.press('ArrowRight');
    assert.equal(await item(page, firstId).getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.nodeId), tree.children[0].children[0].id);
    await page.keyboard.press('ArrowLeft'); // child directory collapses first, if expanded
    if (await page.evaluate(() => document.activeElement.dataset.nodeId) !== firstId) await page.keyboard.press('ArrowLeft');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.nodeId), firstId);
    assert.equal(await page.locator('.alg-tree-item[tabindex="0"]').count(), 1, 'the tree has one keyboard tab stop');

    let measured = 0;
    for (const theme of ['light', 'dark', 'cards']) {
      await page.locator('#theme-select').selectOption(theme);
      await page.waitForFunction(theme => document.body.dataset.theme === theme, theme);
      // All categories and all badges appear in unfiltered, fully expanded tree.
      await page.evaluate(() => { for (let i = 0; i < 1000; i++) { const button = document.querySelector('.alg-tree-item[aria-expanded="false"] > .alg-tree-row > button.alg-disclosure'); if (!button) break; button.click(); } });
      measured += await assertTextContrast(page, '.alg-tree-label, .alg-badge, .alg-attribute-badge, .alg-legend-button, .alg-legend-button > span:not(.alg-legend-dot)', theme);
      await page.locator('.alg-search').fill('背包状态设计');

      await page.locator('.alg-search-submit').click();
      measured += await assertTextContrast(page, '.alg-note-title, .alg-featured, .alg-tag', theme);
      await assertNoOverflow(page, `${theme} desktop`);
      await page.setViewportSize({ width: 390, height: 844 });
      await assertNoOverflow(page, `${theme} 390px results`);
      await resultCards(page).click();
      await page.waitForSelector('.alg-markdown .katex');
      await assertNoOverflow(page, `${theme} 390px reader`);
      await page.locator('.alg-reader-back').click();
      await clearFilters(page);
      await assertNoOverflow(page, `${theme} 390px directory`);
      await page.setViewportSize({ width: 1440, height: 940 });
    }
    console.log(`Algorithm text contrast: ${measured} computed-style samples >= 4.5 across light/dark/cards`);

    for (const permission of [{ signedIn: false, push: false }, { signedIn: true, push: false }]) {
      const restricted = await openAlgorithms(browser, errors, permission);
      assert.equal(await restricted.locator('#algorithm-upload-button').isDisabled(), true);
      assert.match(await restricted.locator('.alg-upload-hint').innerText(), permission.signedIn ? /写入权限/ : /登录/);
      await restricted.locator('#algorithm-upload-button').evaluate(button => button.click());
      assert.equal(await restricted.locator('#algorithm-note-dialog').evaluate(node => node.open), false);
      if (!permission.signedIn) {
        await scopeButton(restricted, 'personal').click();
        assert.equal(await scopeButton(restricted, 'public').getAttribute('aria-pressed'), 'true');
        assert.match(await restricted.locator('#toast').innerText(), /登录/);
      }
      await restricted.close();
    }
    const adminPage = await openAlgorithms(browser, errors, { admin: true });
    await row(adminPage, DP).locator('.alg-tree-label').click();
    await adminPage.locator('#algorithm-upload-button').click();
    assert.equal(await adminPage.locator('#algorithm-note-node').inputValue(), DP);
    assert.equal(await adminPage.locator('#algorithm-note-form [name="noteScope"]').isDisabled(), false);
    assert.equal(await adminPage.locator('#algorithm-note-form [name="noteScope"]').inputValue(), 'public');
    await adminPage.locator('[data-close="algorithm-note-dialog"]').first().click();
    await row(adminPage, DP).locator('.alg-add-topic').click();
    assert.equal(await adminPage.locator('#algorithm-topic-form [name="parentId"]').inputValue(), DP);
    await adminPage.locator('#algorithm-topic-form [name="label"]').fill('测试算法');
    await adminPage.locator('#algorithm-topic-form [name="fullLabel"]').fill('测试算法完整名称');
    await adminPage.locator('#algorithm-topic-form [name="scope"]').fill('测试学习范围');
    await adminPage.locator('#algorithm-topic-form button[type="submit"]').click();
    await adminPage.waitForFunction(() => !document.querySelector('#algorithm-topic-dialog').open);
    assert.equal(await adminPage.locator('.alg-detail-title').innerText(), '测试算法完整名称');
    const added = await adminPage.locator('.alg-tree-item[aria-selected="true"]').getAttribute('data-node-id');
    await row(adminPage, added).locator('.alg-add-topic').click();
    assert.equal(await adminPage.locator('#algorithm-topic-form [name="parentId"]').inputValue(), added);
    await adminPage.locator('#algorithm-topic-form [name="kind"]').selectOption('directory');
    assert.equal(await adminPage.locator('#algorithm-topic-difficulty').isVisible(), false);
    assert.equal(await adminPage.locator('#algorithm-topic-form [name="color"]').isDisabled(), true);
    await adminPage.locator('#algorithm-topic-form [name="label"]').fill('测试子目录');
    await adminPage.locator('#algorithm-topic-form button[type="submit"]').click();
    await adminPage.waitForFunction(() => !document.querySelector('#algorithm-topic-dialog').open);
    assert.equal(await adminPage.locator('.alg-detail-title').innerText(), '测试子目录');
    assert.equal(await adminPage.locator('.alg-detail-heading .alg-badge').count(), 0);
    assert.equal(await row(adminPage, added).locator('.alg-badge').count(), 0, 'algorithm parent becomes ungraded directory');
    await row(adminPage, added).locator('.alg-tree-label').click();
    const content = `algorithm-content-${added}`;
    assert.equal(await row(adminPage, content).locator('.alg-badge').innerText(), '中级', 'original algorithm remains a rated child');
    await row(adminPage, content).locator('.alg-tree-label').click();
    assert.equal(await adminPage.locator('.alg-detail-title').innerText(), '测试算法完整名称');
    await adminPage.locator('.rail-nav-item[data-view="home"]').click();
    await adminPage.locator('.rail-nav-item[data-view="algorithms"]').click();
    assert.equal(await item(adminPage, added).count(), 1, 'new topic survives view changes');
    await adminPage.reload();
    await adminPage.locator('.rail-nav-item[data-view="algorithms"]').click();
    await adminPage.locator('.alg-search').fill('测试算法');
    await adminPage.locator('.alg-search-submit').click();
    assert.ok((await adminPage.locator('.alg-result-topic-name').allTextContents()).includes('测试算法'), 'bootstrap reload restores stored custom topic');
    await adminPage.close();

    // Node labels follow the same text-only boundary as note metadata. Mutate
    // only this page's in-memory fixture, retaining every node ID and app code.
    const hostileNode = await openAlgorithms(browser, errors);
    await hostileNode.evaluate(() => { window.QMX_ALGORITHM_TREE.children[0].label = '<img src=x onerror="window.__algorithmXss=7">目录'; });
    await hostileNode.locator('#sync-button').click();
    await hostileNode.waitForFunction(() => !document.querySelector('#sync-button').disabled);
    await hostileNode.waitForSelector('.alg-browser');
    assert.equal(await row(hostileNode, tree.children[0].id).locator('.alg-tree-label').innerText(), '<img src=x onerror="window.__algorithmXss=7">目录');
    assert.equal(await row(hostileNode, tree.children[0].id).locator('img, script').count(), 0);
    assert.equal(await hostileNode.evaluate(() => window.__algorithmXss), 0);
    await hostileNode.close();
    assert.deepEqual(errors, [], 'no renderer errors');
    console.log('ALGORITHM NOTES UI PASS (all legacy IDs mapped, directory/keyboard, search/scopes/filters, reader/sanitization, uploads, themes, 390px)');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
