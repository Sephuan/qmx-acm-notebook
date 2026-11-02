'use strict';
(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const bridge = window.notebook;
  const demo = !bridge;
  const STORAGE = 'acm-notebook.demo.v1';
  const THEME_STORAGE = 'acm-notebook.theme';
  const stateLabels = { unreviewed: '待复习', reviewing: '复习中', mastered: '已掌握' };
  const views = {
    public: ['公共题库', '在他人的思路里，找到自己的突破口。', 'A LITTLE BETTER, EVERY DAY'],
    mine: ['我的错题', '每个没有想通的瞬间，都有重新理解的机会。', 'TURN MISTAKES INTO INSIGHT'],
    favorites: ['收藏复习', '再想一遍，让解题思路真正成为自己的。', 'REVISIT. UNDERSTAND. REMEMBER.'],
    stats: ['学习统计', '看见积累，也看见下一步的方向。', 'SMALL STEPS, REAL PROGRESS']
  };
  const examples = [
    { id: 'demo-issue-1', number: 101, kind: 'issue', title: 'D. 数对计数：从枚举到贡献法', pid: 'CF1900D', platform: 'Codeforces', rating: 1900, tags: ['数论', '贡献法', '枚举优化'], author: '林间的二分树', body: '## 错因分析\n直接枚举三个位置会退化到 O(n³)。我一直试图优化判断过程，却没有先调整统计的顺序。\n\n## 关键观察\n排序后，固定中间位置，把左侧数字按因子归类。统计一个数对的贡献，比逐个寻找合法三元组更容易。\n\n> 先问「谁在产生贡献」，再问「如何更快地枚举」。\n\n## 复盘笔记\n1. 先用小数据写暴力，确认统计对象。\n2. 把 gcd 条件拆解为因子计数。\n3. 注意重复元素与 64 位整数溢出。\n\n```cpp\nlong long answer = 0;\n// 先计算贡献，再更新计数，避免重复统计。\n```\n\n*此内容为界面演示示例，并非该题的正式题解。*', url: 'https://codeforces.com/problemset/problem/1900/D', updatedAt: '2026-10-29T10:20:00Z', comments: 0, state: 'open' },
    { id: 'demo-document-2', number: 102, kind: 'document', title: '二分答案里的「最后一个正确」', pid: 'P1873', platform: '洛谷', difficulty: '普及−', tags: ['二分', '边界处理'], author: '不再 RE', body: '## 错因分析\n循环可以结束，不代表返回的位置正确。左闭右闭和左闭右开混用，让答案偏移了一个位置。\n\n## 解题 Trick\n先画出可行性序列：真、真、真、假、假。题目要找的是最后一个真。\n\n每次更新前，确认不变量仍然成立；最后用只有一个元素、全部可行和全部不可行三个边界检查。\n\n*此内容为演示正式题解样式，非真实题解。*', url: 'https://www.luogu.com.cn/problem/P1873', updatedAt: '2026-10-27T08:00:00Z', comments: 0, state: 'open' },
    { id: 'demo-local-3', kind: 'local', title: 'B. 边界条件：贪心之前先看约束', pid: 'CF1791B', platform: 'Codeforces', rating: 800, tags: ['贪心', '边界处理'], author: '我', body: '## 错因分析\n忽略了起点和终点之间的边界条件，在动手写贪心前没有先用最小规模数据模拟。\n\n## 下一次要记住\n先确认约束，再检查每一步是否保持可行。空路径、单步路径和提前到达终点都值得单独测试。\n\n这是只存在当前设备的演示错题。Rating 仅为展示数据，并非平台核验结果。收藏和复习状态都可以试着调整。', url: 'https://codeforces.com/problemset/problem/1791/B', updatedAt: '2026-10-25T09:00:00Z', comments: 0, state: 'open' }
  ];
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(STORAGE) || 'null'); } catch (_) { /* Storage may be disabled. */ }
  const s = { view: 'public', records: [], local: { records: [], favorites: [], mastery: {}, draft: {} }, settings: {}, account: null, lastSync: null, error: '', selected: null, comments: new Map(), loading: true, busy: false };
  let toastTimer;
  let draftTimer;
  let commentRequest = 0;
  function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = String(text); return node; }
  function append(parent, ...children) { children.filter(Boolean).forEach(child => parent.append(child)); return parent; }
  function button(label, className, action) { const node = element('button', className, label); node.type = 'button'; node.addEventListener('click', action); return node; }
  function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3400); }
  function errorMessage(error) { return typeof error === 'string' ? error : error?.message || '操作未完成，请稍后重试'; }
  function key(record) { return String(record.id ?? record.number ?? `${record.platform}:${record.pid}:${record.url}`); }
  function normalizeLocal(local) { return { records: Array.isArray(local?.records) ? local.records : [], favorites: Array.isArray(local?.favorites) ? local.favorites : [], mastery: local?.mastery && typeof local.mastery === 'object' ? local.mastery : {}, draft: local?.draft && typeof local.draft === 'object' ? local.draft : {} }; }
  function records() { const map = new Map(); [...s.records, ...s.local.records].forEach(record => { if (record && typeof record === 'object') { const id = key(record); map.set(id, { ...map.get(id), ...record }); } }); return [...map.values()]; }
  function isLocal(record) { return record.kind === 'local'; }
  function isMine(record) { return isLocal(record) || s.local.records.some(item => key(item) === key(record)) || (s.account && [s.account.login, s.account.name, s.account.username].filter(Boolean).includes(typeof record.author === 'string' ? record.author : record.author?.login)); }
  function favorite(record) { return s.local.favorites.some(value => String(value) === key(record)); }
  function mastery(record) { return stateLabels[s.local.mastery[key(record)]] ? s.local.mastery[key(record)] : 'unreviewed'; }
  function authorName(author) { return typeof author === 'string' ? author : author?.name || author?.login || '匿名学习者'; }
  function date(value) { const time = new Date(value); return Number.isNaN(time.getTime()) ? '尚未同步' : time.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }); }
  function writeDemo() { if (!demo) return; try { localStorage.setItem(STORAGE, JSON.stringify({ local: s.local, settings: s.settings })); } catch (_) { toast('浏览器存储不可用，本次修改仅在当前页面保留'); } }
  async function call(name, ...args) { if (typeof bridge?.[name] !== 'function') throw new Error(`客户端尚未提供 ${name} 接口`); const response = await bridge[name](...args); if (response?.error && !['bootstrap', 'sync'].includes(name)) throw new Error(errorMessage(response.error)); return response; }
  async function persistLocal() { if (demo) { writeDemo(); return; } await call('updateLocal', structuredClone(s.local)); }
  function applyPayload(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('客户端未返回有效数据');
    s.records = Array.isArray(payload.records) ? payload.records : [];
    s.settings = payload.settings && typeof payload.settings === 'object' ? payload.settings : {};
    s.local = normalizeLocal(payload.local);
    s.account = payload.account || null; s.lastSync = payload.lastSync || null; s.error = payload.error ? errorMessage(payload.error) : '';
    applyTheme(s.settings.theme || readTheme());
  }
  function readTheme() { try { return localStorage.getItem(THEME_STORAGE) || 'light'; } catch (_) { return 'light'; } }
  function applyTheme(theme) { theme = ['light', 'dark', 'cards'].includes(theme) ? theme : 'light'; document.body.dataset.theme = theme; $('#theme-select').value = theme; try { localStorage.setItem(THEME_STORAGE, theme); } catch (_) {} }
  function updateStatus() {
    $('#demo-label').hidden = !demo;
    $('#sync-status').textContent = s.loading ? '正在载入…' : demo ? '浏览器预览 · 本地保存' : s.lastSync ? `最近同步 ${date(s.lastSync)}` : '尚未同步';
    const offline = !navigator.onLine;
    $('#status-banner').hidden = !(offline || s.error);
    $('#status-banner').textContent = offline ? '当前处于离线状态。你仍可浏览已载入的题目、整理收藏和保存本地草稿，联网后可再次同步。' : s.error ? `连接提示：${s.error}。可稍后点击「同步」重试。` : '';
    const account = s.account;
    $('#account-name').textContent = account?.name || account?.login || account?.username || s.settings.displayName || '本地学习者';
    $('#account-caption').textContent = account ? '账户已连接' : demo ? '演示模式 · 数据仅在本机' : '未登录 · 可使用本地错题';
    $('.account-avatar').textContent = String($('#account-name').textContent).slice(0, 1);
    $('#account-button').title = account ? '退出登录' : '登录账户'; $('#account-button').setAttribute('aria-label', $('#account-button').title);
  }
  function refreshFilters() {
    const all = records();
    for (const [selector, values, title] of [['#platform-filter', all.map(record => record.platform).filter(Boolean), '全部平台'], ['#tag-filter', all.flatMap(record => Array.isArray(record.tags) ? record.tags : []), '全部标签']]) {
      const select = $(selector); const old = select.value; select.replaceChildren(element('option', '', title)); select.firstChild.value = '';
      [...new Set(values.map(String))].sort().forEach(value => { const option = element('option', '', value); option.value = value; select.append(option); });
      if ([...select.options].some(option => option.value === old)) select.value = old;
    }
  }
  function filteredRecords() {
    const search = $('#search-input').value.trim().toLowerCase(); const platform = $('#platform-filter').value; const tag = $('#tag-filter').value; const status = $('#state-filter').value;
    return records().filter(record => {
      if (s.view === 'public' && isLocal(record)) return false;
      if (s.view === 'mine' && !isMine(record)) return false;
      if (s.view === 'favorites' && !favorite(record)) return false;
      if (platform && record.platform !== platform) return false;
      if (tag && !record.tags?.includes(tag)) return false;
      if (status === 'local' && !isLocal(record) || status === 'shared' && isLocal(record)) return false;
      if (stateLabels[status] && mastery(record) !== status) return false;
      return !search || [record.title, record.pid, record.platform, record.rating, record.difficulty, record.body, ...(Array.isArray(record.tags) ? record.tags : [])].join(' ').toLowerCase().includes(search);
    }).sort((a, b) => (new Date(b.updatedAt).getTime() || 0) - (new Date(a.updatedAt).getTime() || 0));
  }
  function badge(record) { return element('span', `badge ${isLocal(record) ? 'local' : 'shared'}`, isLocal(record) ? '仅本地 · 未上传' : '已共享'); }
  function platformCode(value) { return ({ Codeforces: 'CF', AtCoder: 'AT', '洛谷': 'LG', '牛客': 'NC', LeetCode: 'LC' })[value] || value || 'Oth'; }
  function platformLabel(record) { const code = platformCode(record.platform); const label = element('span', 'platform-label', ({ CF: 'Codeforces', AT: 'AtCoder', LG: '洛谷', NC: '牛客', LC: 'LeetCode' })[code] || record.platform || '其他平台'); label.dataset.platform = ['CF', 'AT', 'LG', 'NC', 'LC'].includes(code) ? code : 'Oth'; return label; }
  function difficultyBadge(record) {
    const hasRating = record.rating !== undefined && record.rating !== null && record.rating !== '' && Number.isFinite(Number(record.rating));
    const native = String(record.difficulty || '').trim();
    if (!hasRating && !native) return null;
    const code = platformCode(record.platform); let tone = 'neutral'; let rank = '';
    if (code === 'CF' && hasRating) {
      const rating = Number(record.rating);
      const tiers = [[1200, 'gray'], [1400, 'green'], [1600, 'cyan'], [1900, 'blue'], [2100, 'purple'], [2300, 'orange'], [2400, 'orange'], [2600, 'red'], [3000, 'red']];
      const index = tiers.findIndex(([limit]) => rating < limit); tone = index < 0 ? 'red' : tiers[index][1]; rank = index < 0 ? 'legendary' : index === 8 ? 'grandmaster' : '';
    } else if (code === 'LG' && native) {
      const normalized = native.replace(/[−–—]/g, '-').replace(/\s/g, '');
      const colors = { '入门': 'red', '普及-': 'orange', '普及/提高-': 'yellow', '普及+/提高': 'green', '提高+/省选-': 'blue', '省选/NOI-': 'purple', 'NOI/NOI+/CTSC': 'black', 'NOI+': 'black' };
      tone = colors[normalized] || 'neutral';
    }
    const label = element('span', `difficulty-badge tone-${tone}${rank ? ` rank-${rank}` : ''}`, [hasRating ? `${code === 'CF' ? 'CF ' : 'Rating '}${record.rating}` : '', native].filter(Boolean).join(' · '));
    label.title = `${demo ? '演示值 · ' : ''}${code === 'CF' ? 'Codeforces 原生 Rating 色阶' : code === 'LG' ? '洛谷原生难度名称 · 颜色仅用于界面展示' : '平台原始数值 / 难度'}，不跨平台换算`;
    return label;
  }
  function tags(record) { const row = element('div', 'tag-row'); (Array.isArray(record.tags) ? record.tags : []).forEach(tag => { let hash = 0; for (const char of String(tag)) hash = (hash + char.codePointAt(0)) % 5; row.append(element('span', `tag tag-color-${hash}`, tag)); }); return row; }
  function empty(title, description, action) { const box = element('div', 'empty-state'); append(box, element('div', 'empty-icon', '⌑'), element('h3', '', title), element('p', '', description)); if (action) box.append(button(action.label, 'button secondary', action.fn)); return box; }
  function render() {
    const [title, description, eyebrow] = views[s.view]; $('#page-title').replaceChildren(document.createTextNode(title), element('span', 'heading-dot', '.')); $('#breadcrumb-view').textContent = title; $('#page-description').textContent = description; $('#page-eyebrow').textContent = eyebrow;
    $$('.nav-item').forEach(node => { node.classList.toggle('active', node.dataset.view === s.view); if (node.dataset.view === s.view) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); });
    const all = records(); $('#count-public').textContent = all.filter(record => !isLocal(record)).length; $('#count-mine').textContent = all.filter(isMine).length; $('#count-favorites').textContent = all.filter(favorite).length;
    $('#stats-panel').hidden = s.view !== 'stats'; $('#library-panel').hidden = s.view === 'stats'; updateStatus();
    if (s.view === 'stats') { renderStats(); return; }
    const items = filteredRecords(); $('#result-count').textContent = items.length;
    if (!items.some(record => key(record) === s.selected)) s.selected = items[0] ? key(items[0]) : null;
    const list = $('#record-list'); list.replaceChildren();
    items.forEach(record => {
      const card = button('', `record-card${key(record) === s.selected ? ' selected' : ''}`, () => { s.selected = key(record); render(); }); card.setAttribute('aria-pressed', key(record) === s.selected ? 'true' : 'false');
      append(card, append(element('div', 'card-meta'), platformLabel(record), element('span', '', record.pid || `#${record.number || '本地'}`), difficultyBadge(record), badge(record)), element('h2', 'card-title', record.title || '未命名错题'), element('p', 'card-excerpt', String(record.body || '尚未补充思考过程').replace(/[#>*`]/g, '').trim()), tags(record), append(element('div', 'card-footer'), element('span', `card-state ${mastery(record)}`, stateLabels[mastery(record)]), element('span', '', `${favorite(record) ? '★ · ' : ''}${date(record.updatedAt)}`)));
      list.append(card);
    });
    if (!items.length) list.append(empty(s.loading ? '正在载入题库' : '这里还没有题目', s.loading ? '等待客户端返回你的学习数据。' : '试试调整筛选，或记下第一道值得回顾的错题。', { label: '清空筛选', fn: clearFilters }));
    const record = items.find(item => key(item) === s.selected);
    if (record) renderDetail(record); else $('#detail-panel').replaceChildren(empty('给思考留一个位置', s.error ? '客户端连接暂不可用。你可以重试同步，或先保存一道本地错题。' : s.view === 'favorites' ? '点击题目详情中的收藏，把想反复理解的思路留在这里。' : '从左侧选择题目，阅读分析、记录理解，再迈进一步。', { label: '＋ 记一道错题', fn: openSubmit }));
  }
  function renderMarkdown(container, body) {
    const source = String(body || '还没有题解内容。可以从记录错因开始。');
    if (window.marked && window.DOMPurify) {
      try { const parse = typeof window.marked.parse === 'function' ? window.marked.parse.bind(window.marked) : window.marked; const safe = window.DOMPurify.sanitize(parse(source), { FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button'], FORBID_ATTR: ['style'] }); container.innerHTML = safe; if (window.renderMathInElement) window.renderMathInElement(container, {delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}],throwOnError:false,trust:false}); container.classList.add('rendered'); $$('a', container).forEach(link => link.addEventListener('click', event => { event.preventDefault(); openExternal(link.getAttribute('href')); })); return; } catch (_) { /* Plain text is the secure fallback. */ }
    }
    container.textContent = source;
  }
  async function changeLocal(change) { const before = structuredClone(s.local); change(); render(); try { await persistLocal(); } catch (error) { s.local = before; render(); toast(`未能保存：${errorMessage(error)}`); } }
  function renderDetail(record) {
    const panel = $('#detail-panel'); panel.replaceChildren();
    const actions = append(element('div', 'detail-actions'), button(favorite(record) ? '★ 已收藏' : '☆ 收藏', 'button secondary', () => changeLocal(() => { s.local.favorites = favorite(record) ? s.local.favorites.filter(value => String(value) !== key(record)) : [...s.local.favorites, key(record)]; })), button('原题 ↗', 'button subtle', () => openExternal(record.problemUrl || record.url)));
    append(panel, append(element('div', 'detail-top'), append(element('div', 'detail-meta'), platformLabel(record), element('span', '', record.pid || `#${record.number || '本地'}`), difficultyBadge(record), badge(record)), actions), element('h2', 'detail-title', record.title || '未命名错题'));
    const author = authorName(record.author); append(panel, append(element('div', 'author-row'), element('span', 'mini-avatar', author.slice(0, 1)), element('span', '', author), element('span', 'separator', '·'), element('span', '', `更新于 ${date(record.updatedAt)}`), record.kind === 'document' ? element('span', 'badge document', '正式题解') : null));
    const tagrow = tags(record); tagrow.classList.add('detail-tags'); append(panel, tagrow, element('hr', 'detail-divider'), element('div', 'body-label', '思路与复盘'));
    const body = element('div', 'markdown-body'); renderMarkdown(body, record.body); panel.append(body);
    const masteryButtons = element('div', 'mastery-buttons'); Object.entries(stateLabels).forEach(([value, label]) => { const control = button(label, mastery(record) === value ? 'active' : '', () => changeLocal(() => { s.local.mastery[key(record)] = value; })); control.setAttribute('aria-pressed', mastery(record) === value ? 'true' : 'false'); masteryButtons.append(control); });
    append(panel, append(element('div', 'mastery-box'), append(element('div'), element('strong', '', '这个思路，掌握了吗？'), element('small', '', '复习进度仅记录在你的学习空间')), masteryButtons));
    if (record.proposalUrl) panel.append(button('查看正式题解提议 · 待审核 ↗', 'button secondary', () => openExternal(record.proposalUrl)));
    if (isLocal(record)) panel.append(button('编辑本地记录', 'button secondary', () => openSubmit(record)));
    if (isLocal(record)) panel.append(button('将这道错题提交到公共题库 ↗', 'button secondary', () => openSubmit(record)));
    else if (record.kind !== 'document') panel.append(button('提议补充正式题解 ↗', 'button subtle', () => openSubmit(record, true)));
    const comments = element('section', 'comments-section'); const count = typeof record.comments === 'number' ? record.comments : Array.isArray(record.comments) ? record.comments.length : 0; append(comments, append(element('div', 'section-heading'), element('h3', '', '一起讨论'), element('span', '', isLocal(record) ? '仅本地错题' : `${count} 条讨论`)));
    const commentList = element('div'); comments.append(commentList); panel.append(comments);
    if (isLocal(record)) { commentList.append(element('div', 'comment-empty', '本地错题暂不开放公共评论。共享后可以与其他学习者讨论。')); return; }
    if (record.kind === 'document' || !record.number) { commentList.append(element('div', 'comment-empty', '正式资料的交流与修订请通过题解提议参与。')); commentList.append(button('提议改进这份正式资料 ↗', 'button secondary', () => openSubmit(record, true))); return; }
    const form = element('form', 'comment-form'); const input = element('textarea'); input.rows = 2; input.placeholder = '分享你的观察，或提出一个问题…'; input.setAttribute('aria-label', '评论内容'); input.required = true; input.maxLength = 10000;
    const submit = element('button', 'button secondary', demo ? '演示评论' : '发表讨论'); submit.type = 'submit'; append(form, input, submit); comments.append(form);
    form.addEventListener('submit', async event => { event.preventDefault(); const body = input.value.trim(); if (!body) return; if (!navigator.onLine && !demo) { toast('当前离线，请联网后发表评论'); return; } submit.disabled = true; try { if (demo) { const items = s.comments.get(key(record)) || []; s.comments.set(key(record), [...items, { author: '我 · 演示', body }]); } else { await call('comment', { number: record.number, body }); s.comments.delete(key(record)); } input.value = ''; await loadComments(record, commentList); toast(demo ? '演示评论已添加，未向外部发送' : '评论已发表'); } catch (error) { toast(errorMessage(error)); } finally { submit.disabled = false; } });
    loadComments(record, commentList);
  }
  async function loadComments(record, container) {
    const request = ++commentRequest;
    container.replaceChildren(element('div', 'comment-empty', '正在加载讨论…'));
    try {
      let comments = s.comments.get(key(record));
      if (!comments) { if (Array.isArray(record.comments)) comments = record.comments; else if (demo) comments = []; else { const response = await call('getComments', record.number); comments = Array.isArray(response) ? response : response?.comments || []; } s.comments.set(key(record), comments); }
      if (request !== commentRequest || !container.isConnected) return;
      container.replaceChildren();
      if (!comments.length) container.append(element('div', 'comment-empty', demo ? '演示讨论区 · 留下第一条思考，不会发送到外部。' : '还没有讨论，你的观察也许就是别人的突破口。'));
      comments.forEach(comment => { container.append(append(element('article', 'comment-item'), element('strong', '', authorName(comment.author || comment.user)), element('p', '', comment.body || ''))); });
    } catch (error) { if (container.isConnected) container.replaceChildren(element('div', 'comment-empty', `讨论暂不可用：${errorMessage(error)}`)); }
  }
  function renderStats() {
    const all = records(), mine = all.filter(isMine), favorites = all.filter(favorite); const tracked = all.filter(record => s.local.mastery[key(record)]); const mastered = tracked.filter(record => mastery(record) === 'mastered').length;
    const panel = $('#stats-panel'); panel.replaceChildren();
    for (const [label, value, caption] of [['我的错题', mine.length, `${mine.filter(isLocal).length} 道仅本地 · ${mine.filter(record => !isLocal(record)).length} 道已共享`], ['收藏题目', favorites.length, '值得再次思考的题目'], ['已掌握', mastered, '来自你手动记录的复习进度'], ['待复习', favorites.filter(record => mastery(record) !== 'mastered').length, '收藏中尚未掌握的题目']]) panel.append(append(element('article', 'stat-card'), element('div', 'stat-label', label), element('div', 'stat-number', value), element('div', 'stat-caption', caption)));
    const progress = append(element('article', 'stat-card stat-wide'), element('div', 'stat-label', '复习进度'));
    Object.entries(stateLabels).forEach(([value, label]) => { const count = favorites.filter(record => mastery(record) === value).length; const fill = element('div', 'progress-fill'); fill.style.width = `${favorites.length ? count / favorites.length * 100 : 0}%`; progress.append(append(element('div', 'progress-row'), element('span', '', label), append(element('div', 'progress-track'), fill), element('span', '', count))); }); panel.append(progress);
    const topics = append(element('article', 'stat-card stat-wide'), element('div', 'stat-label', '我的算法足迹')); const counts = new Map(); mine.forEach(record => (Array.isArray(record.tags) ? record.tags : []).forEach(tag => counts.set(tag, (counts.get(tag) || 0) + 1))); [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).forEach(([tag, count]) => topics.append(append(element('div', 'progress-row'), element('span', '', tag), element('span', 'tag', `${count} 道`)))); if (!counts.size) topics.append(element('p', 'settings-note', '记下第一道错题，开始积累你的算法地图。')); panel.append(topics, element('div', 'stats-note', demo ? '演示统计 · 基于 3 条明确标记的示例及你在浏览器中的本地操作，不代表真实学习记录。' : '统计来自当前已载入的题目与本地复习记录。'));
  }
  function clearFilters() { $('#search-input').value = ''; ['#platform-filter', '#tag-filter', '#state-filter'].forEach(selector => { $(selector).value = ''; }); render(); }
  async function openExternal(url) { try { const parsed = new URL(String(url)); if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('仅支持 http 或 https 题目链接'); if (demo) window.open(parsed.href, '_blank', 'noopener,noreferrer'); else await call('openExternal', parsed.href); } catch (error) { toast(errorMessage(error)); } }
  function formDraft() { const data = new FormData($('#submit-form')); return Object.fromEntries(['url', 'title', 'pid', 'platform', 'tags', 'reason', 'solution', 'trick', 'rating', 'difficulty'].map(name => [name, String(data.get(name) || '')]).concat([['official', data.has('official')]])); }
  function fillForm(draft) { const form = $('#submit-form'); form.reset(); Object.entries(draft || {}).forEach(([name, value]) => { const input = form.elements.namedItem(name); if (!input) return; if (input.type === 'checkbox') input.checked = !!value; else input.value = String(value ?? ''); }); }
  function openSubmit(record, propose = false) {
    const form = $('#submit-form'); form.dataset.source = record ? key(record) : ''; form.dataset.number = record?.number ?? ''; form.dataset.propose = propose ? 'true' : 'false';
    fillForm(record ? { url: record.problemUrl || record.url, title: record.title, pid: record.pid, platform: ({ Codeforces: 'CF', AtCoder: 'AT', '洛谷': 'LG', '牛客': 'NC' })[record.platform] || record.platform, tags: (record.tags || []).join(', '), reason: propose ? '' : record.reason || record.body, solution: record.solution || '', trick: record.trick || '', rating: record.rating ?? '', difficulty: record.difficulty || '', official: propose } : s.local.draft);
    $('#submit-error').hidden = true; $('#draft-hint').textContent = propose ? '补充正式题解：提交后由公共题库审核流程处理' : Object.keys(s.local.draft).length && !record ? '已恢复当前设备上的草稿 · 修改自动保存' : '草稿自动保存在当前设备'; $('#publish-button').textContent = propose ? '提交正式题解提议 ↗' : '提交到公共题库 ↗'; $('#submit-dialog').showModal();
  }
  async function saveDraft() { s.local.draft = formDraft(); try { await persistLocal(); $('#draft-hint').textContent = '草稿已保存到当前设备'; } catch (error) { $('#draft-hint').textContent = `草稿尚未保存：${errorMessage(error)}`; } }
  async function saveRecord(shared) {
    const form = $('#submit-form'); if (!form.reportValidity() || s.busy) return;
    clearTimeout(draftTimer); const data = formDraft(); const source = form.dataset.source;
    let parsed; try { parsed = new URL(data.url); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(); } catch (_) { $('#submit-error').textContent = '请输入有效的 http 或 https 题目链接。'; $('#submit-error').hidden = false; return; }
    const existing = records().find(record => key(record) === source);
    const record = { ...(existing || {}), id: existing && (shared || isLocal(existing)) ? existing.id : `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, title: data.title.trim() || data.pid.trim() || '未命名错题', pid: data.platform === 'CF' && data.pid.trim() ? `CF${data.pid.trim().replace(/^CF/i, '')}` : data.pid.trim(), platform: data.platform, rating: data.rating.trim() ? Number(data.rating) : null, difficulty: data.difficulty.trim(), tags: data.tags.split(/[,，、]/).map(tag => tag.trim()).filter(Boolean), url: parsed.href, problemUrl: parsed.href, body: `## 错因分析\n${data.reason.trim()}${data.solution.trim() ? `\n\n## 题解\n${data.solution.trim()}` : ''}${data.trick.trim() ? `\n\n## Trick\n${data.trick.trim()}` : ''}`, reason: data.reason.trim(), solution: data.solution.trim(), trick: data.trick.trim(), official: data.official, kind: shared ? data.official ? 'document' : 'issue' : 'local', author: s.account?.login || s.settings.displayName || '我', updatedAt: new Date().toISOString(), comments: existing?.comments || 0, state: 'open' };
    s.busy = true; $('#save-local-button').disabled = true; $('#publish-button').disabled = true; $('#submit-error').hidden = true;
    try {
      if (shared && demo) { toast('演示模式不会提交到公共题库，请选择「仅本机」保存'); return; }
      if (shared && !navigator.onLine) throw new Error('当前离线，可以先保存到我的错题（仅本机）');
      const previous = structuredClone(s.local);
      if (shared) {
        const response = await call(data.official || form.dataset.propose === 'true' ? 'propose' : 'submit', { ...record, ...(form.dataset.number ? { number: Number(form.dataset.number) } : {}) });
        if (data.official || form.dataset.propose === 'true') {
          if (response?.url) toast('正式题解提议已创建，可在公共仓库审核');
          s.local.records = s.local.records.filter(item => key(item) !== source);
          s.local.records.push({ ...record, id: `local-proposal-${Date.now()}`, number: undefined, kind: 'local', proposalUrl: response?.url });
        }
        else if (response?.records) applyPayload(response);
        else {
          const submitted = response?.record || (response?.id && response?.kind ? response : null);
          if (submitted) { s.records = [...s.records.filter(item => key(item) !== key(submitted)), submitted]; s.local.records = s.local.records.filter(item => key(item) !== source); s.local.records.push(submitted); }
          else { const fresh = await call('sync'); applyPayload(fresh); }
        }
      } else {
        s.local.records = s.local.records.filter(item => key(item) !== source && key(item) !== key(record)); s.local.records.push(record);
      }
      s.local.draft = {};
      try { await persistLocal(); } catch (error) { if (!shared) s.local = previous; else toast('公共提交已完成，本地状态保存失败，请同步刷新'); throw error; }
      form.reset(); $('#submit-dialog').close(); s.view = shared ? 'mine' : 'mine'; s.selected = key(record); refreshFilters(); render(); toast(shared ? data.official || form.dataset.propose === 'true' ? '正式题解提议已提交 · 本地保留副本，待公共仓库审核' : '已提交到公共题库' : '已保存到我的错题 · 仅本机');
    } catch (error) { $('#submit-error').textContent = errorMessage(error); $('#submit-error').hidden = false; }
    finally { s.busy = false; $('#save-local-button').disabled = false; $('#publish-button').disabled = false; }
  }
  async function sync() {
    const control = $('#sync-button'); control.disabled = true;
    try { if (demo) { toast('演示模式：本地记录已保留，未连接公共题库'); return; } if (!navigator.onLine) throw new Error('当前离线，请连接网络后重试'); applyPayload(await call('sync')); s.comments.clear(); refreshFilters(); render(); toast('学习空间已同步'); }
    catch (error) { s.error = errorMessage(error); updateStatus(); toast(s.error); } finally { control.disabled = false; }
  }
  $$('.nav-item').forEach(node => node.addEventListener('click', () => { s.view = node.dataset.view; clearFilters(); }));
  $('.brand').addEventListener('click', event => { event.preventDefault(); s.view = 'public'; clearFilters(); });
  $('#search-input').addEventListener('input', render); ['#platform-filter', '#tag-filter', '#state-filter'].forEach(selector => $(selector).addEventListener('change', render)); $('#clear-filters').addEventListener('click', clearFilters);
  $('#submit-button').addEventListener('click', () => openSubmit()); $('#sync-button').addEventListener('click', sync);
  $$('[data-close]').forEach(node => node.addEventListener('click', () => { if (node.dataset.close === 'submit-dialog' && !s.busy) { clearTimeout(draftTimer); saveDraft(); } if (!s.busy) document.getElementById(node.dataset.close).close(); }));
  $('#submit-dialog').addEventListener('cancel', event => { if (s.busy) event.preventDefault(); else { clearTimeout(draftTimer); saveDraft(); } });
  $('#submit-form').addEventListener('input', () => { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 650); });
  $('#save-local-button').addEventListener('click', () => saveRecord(false)); $('#submit-form').addEventListener('submit', event => { event.preventDefault(); saveRecord(true); });
  $('#theme-select').addEventListener('change', async event => { const previous = { ...s.settings }; s.settings.theme = event.target.value; applyTheme(s.settings.theme); try { if (demo) writeDemo(); else await call('saveSettings', { ...s.settings }); } catch (error) { s.settings = previous; toast(`当前风格已预览，设置未保存：${errorMessage(error)}`); } });
  $('#settings-button').addEventListener('click', () => { const form = $('#settings-form'); form.elements.theme.value = document.body.dataset.theme; form.elements.repo.value = s.settings.repo || 'qmx-acm-data/2026'; form.elements.clientId.value = s.settings.clientId || ''; form.elements.displayName.value = s.settings.displayName || ''; form.elements.autoSync.checked = s.settings.autoSync !== false; $('#settings-dialog').showModal(); });
  $('#settings-form').addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; const settings = { ...s.settings, theme: form.elements.theme.value, repo: form.elements.repo.value.trim() || 'qmx-acm-data/2026', clientId: form.elements.clientId.value.trim(), displayName: form.elements.displayName.value.trim(), autoSync: form.elements.autoSync.checked }; const control = $('button[type="submit"]', form); control.disabled = true; try { if (!demo) await call('saveSettings', settings); s.settings = settings; applyTheme(settings.theme); writeDemo(); $('#settings-dialog').close(); updateStatus(); toast('设置已保存'); } catch (error) { toast(errorMessage(error)); } finally { control.disabled = false; } });
  $('#account-button').addEventListener('click', async () => { if (demo) { toast('当前为浏览器演示，账户登录将在桌面客户端中提供'); return; } const control = $('#account-button'); control.disabled = true; try { const method = s.account ? 'logout' : 'login'; if (method === 'login') { $('#auth-message').textContent = '正在请求设备授权…'; $('#auth-code').textContent = ''; $('#auth-open-button').hidden = true; $('#auth-dialog').showModal(); } await call(method); $('#auth-dialog').close(); applyPayload(await call('bootstrap')); refreshFilters(); render(); toast(method === 'login' ? '账户状态已更新' : '已退出登录'); } catch (error) { $('#auth-dialog').close(); toast(errorMessage(error)); } finally { control.disabled = false; } });
  let authUrl = '';
  if (typeof bridge?.onAuthProgress === 'function') bridge.onAuthProgress(progress => {
    $('#auth-message').textContent = progress?.message || '请在 GitHub 页面完成授权，当前窗口会自动更新。';
    $('#auth-code').textContent = progress?.userCode || progress?.user_code || '';
    authUrl = progress?.verificationUri || progress?.verification_uri || progress?.verificationUrl || progress?.url || '';
    $('#auth-open-button').hidden = !authUrl;
    if (!$('#auth-dialog').open) $('#auth-dialog').showModal();
  });
  $('#auth-open-button').addEventListener('click', () => openExternal(authUrl));
  async function cancelLogin() { try { if (!demo) await call('cancelLogin'); } catch (error) { toast(errorMessage(error)); } $('#auth-dialog').close(); }
  $('#cancel-login-button').addEventListener('click', cancelLogin);
  $('#auth-dialog').addEventListener('cancel', event => { event.preventDefault(); cancelLogin(); });
  $('#export-local-button').addEventListener('click', async () => { try { if (demo) { const blob = new Blob([JSON.stringify(s.local, null, 2)], { type: 'application/json' }); const href = URL.createObjectURL(blob); const link = element('a'); link.href = href; link.download = 'acm-notebook-demo-local.json'; link.click(); setTimeout(() => URL.revokeObjectURL(href), 1000); toast('演示本地数据已导出'); } else { const result = await call('exportLocal'); if (result !== false && !result?.canceled) toast('本地数据已导出'); } } catch (error) { toast(errorMessage(error)); } });
  $('#submit-form').elements.url.addEventListener('blur', event => {
    try { const url = new URL(event.target.value); const form = $('#submit-form'); let match;
      if (url.hostname.endsWith('codeforces.com') && (match = url.pathname.match(/(?:problemset\/problem\/(\d+)\/([A-Za-z0-9]+)|contest\/(\d+)\/problem\/([A-Za-z0-9]+))/))) { form.elements.platform.value = 'CF'; form.elements.pid.value = `CF${match[1] || match[3]}${(match[2] || match[4]).toUpperCase()}`; }
      else if (url.hostname.endsWith('atcoder.jp') && (match = url.pathname.match(/\/tasks\/([^/]+)/))) { form.elements.platform.value = 'AT'; form.elements.pid.value = match[1]; }
      else if (url.hostname.endsWith('luogu.com.cn') && (match = url.pathname.match(/\/problem\/([^/]+)/))) { form.elements.platform.value = 'LG'; form.elements.pid.value = match[1]; }
      else if (url.hostname.endsWith('nowcoder.com')) { form.elements.platform.value = 'NC'; if ((match = url.pathname.match(/\/acm\/problem\/(\d+)/))) form.elements.pid.value = match[1]; }
    } catch (_) { /* Validation is shown when saving. */ }
  });
  window.addEventListener('online', updateStatus); window.addEventListener('offline', updateStatus);
  document.addEventListener('keydown', event => { if (event.key === '/' && !event.ctrlKey && !event.metaKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) && !document.querySelector('dialog[open]')) { event.preventDefault(); if (s.view === 'stats') { s.view = 'public'; render(); } $('#search-input').focus(); } });
  async function bootstrap() {
    applyTheme(readTheme()); render();
    if (demo) { s.records = examples.filter(record => !isLocal(record)); s.local = normalizeLocal(cached?.local || { records: [examples[2]], favorites: [key(examples[1])], mastery: { [key(examples[1])]: 'reviewing' }, draft: {} }); s.local.records = s.local.records.map(record => record.id === 'demo-local-3' && record.pid === 'dp_f' && record.rating == null ? { ...examples[2] } : record); s.settings = cached?.settings || {}; applyTheme(s.settings.theme || readTheme()); }
    else { try { applyPayload(await call('bootstrap')); } catch (error) { s.error = errorMessage(error); } }
    s.loading = false; refreshFilters(); render();
    if (!demo && !s.error && s.settings.autoSync !== false && navigator.onLine) await sync();
  }
  bootstrap();
})();
