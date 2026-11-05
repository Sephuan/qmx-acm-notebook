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
    discussion: ['讨论 Issues', '阅读已有讨论，与学习者交流观察。', 'DISCUSS AND LEARN'],
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
  const s = { view: 'public', records: [], local: { records: [], favorites: [], mastery: {}, draft: {} }, settings: {}, account: null, authStatus: { status: 'anonymous' }, permissions: {}, issues: [], editor: null, lastSync: null, error: '', selected: null, comments: new Map(), loading: true, busy: false, tagCatalog: window.QMX_TAG_PRESETS || { version: 'local', source: 'local', categories: [] }, tagReview: null };
  s.appVersion = ''; s.update = null;
  let updateRunning = false;
  let updateReady = false;
  let toastTimer;
  let draftTimer;
  let commentRequest = 0;
  function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = String(text); return node; }
  function append(parent, ...children) { children.filter(Boolean).forEach(child => parent.append(child)); return parent; }
  function button(label, className, action) { const node = element('button', className, label); node.type = 'button'; node.addEventListener('click', action); return node; }
  function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3400); }
  function errorMessage(error) { const message = typeof error === 'string' ? error : error?.message || '操作未完成，请稍后重试'; return message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, ''); }
  function key(record) { return String(record.id ?? record.number ?? `${record.platform}:${record.pid}:${record.url}`); }
  function uuid() { return crypto.randomUUID(); }
  function accountId() { return s.account?.id == null ? null : String(s.account.id); }
  function repo() { return s.permissions.repo || s.settings.repo || ''; }
  function sameRepo(record) { return !!record.repo && String(record.repo).toLowerCase() === String(repo()).toLowerCase(); }
  const migratedClientIds = new Map();
  function normalizeLocal(local) { return { records: (Array.isArray(local?.records) ? local.records : []).filter(record => record?.kind === 'local').map(record => { const legacyKey = record.id == null ? null : String(record.id); const clientId = record.clientId || (legacyKey && migratedClientIds.get(legacyKey)) || uuid(); if (legacyKey) migratedClientIds.set(legacyKey, clientId); return { ...record, clientId, id: record.id ?? `local:${clientId}`, ownerId: record.ownerId == null ? null : String(record.ownerId) }; }), favorites: Array.isArray(local?.favorites) ? local.favorites : [], mastery: local?.mastery && typeof local.mastery === 'object' ? local.mastery : {}, draft: local?.draft && typeof local.draft === 'object' ? local.draft : {} }; }
  function visibleLocal(record) { return record.ownerId == null || (accountId() !== null && String(record.ownerId) === accountId()); }
  function records() { return [...s.records.filter(record => record.kind === 'document' && sameRepo(record)), ...s.issues.filter(record => record.kind === 'issue' && sameRepo(record)), ...s.local.records.filter(record => record.kind === 'local' && visibleLocal(record))]; }
  function isLocal(record) { return record.kind === 'local'; }
  function isMine(record) { return isLocal(record) ? visibleLocal(record) : record.kind === 'document' && accountId() !== null && String(record.authorId) === accountId(); }
  function canEditRemote(record) { return record?.kind === 'document' && isMine(record) && sameRepo(record) && s.permissions.push === true; }
  function favorite(record) { return s.local.favorites.some(value => String(value) === key(record)); }
  function mastery(record) { return stateLabels[s.local.mastery[key(record)]] ? s.local.mastery[key(record)] : 'unreviewed'; }
  function authorName(author) { return typeof author === 'string' ? author : author?.name || author?.login || '匿名学习者'; }
  function date(value) { const time = new Date(value); return Number.isNaN(time.getTime()) ? '尚未同步' : time.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }); }
  function writeDemo() { if (!demo) return; try { localStorage.setItem(STORAGE, JSON.stringify({ local: s.local, settings: s.settings })); } catch (_) { toast('浏览器存储不可用，本次修改仅在当前页面保留'); } }
  async function call(name, ...args) { if (typeof bridge?.[name] !== 'function') throw new Error(`客户端尚未提供 ${name} 接口`); const response = await bridge[name](...args); if (response?.error && !['bootstrap', 'sync'].includes(name)) throw new Error(errorMessage(response.error)); return response; }
  let localWrite = Promise.resolve();
  async function persistLocal() { if (demo) { writeDemo(); return; } const snapshot = structuredClone(s.local); const write = localWrite.catch(() => {}).then(() => call('updateLocal', snapshot)); localWrite = write; await write; }
  function applyPayload(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('客户端未返回有效数据');
    if (payload.tagCatalog && Array.isArray(payload.tagCatalog.categories)) { s.tagCatalog = payload.tagCatalog; s.catalogFromPayload = true; }
    if (payload.authStatus) s.authStatus = payload.authStatus;
    if (typeof payload.appVersion === 'string') s.appVersion = payload.appVersion;
    if (payload.update && typeof payload.update === 'object') s.update = { ...payload.update };
    if (payload.updateCapability) s.updateCapability = payload.updateCapability;
    renderUpdate();
    s.records = (Array.isArray(payload.records) ? payload.records : []).filter(record => record.kind === 'document');
    s.issues = (Array.isArray(payload.issues) ? payload.issues : []).filter(record => record.kind === 'issue');
    s.permissions = payload.permissions || {};
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
    $('#account-caption').textContent = s.authStatus?.status === 'expired' ? '授权已过期 · 请重新登录' : s.authStatus?.status === 'recovery-required' ? '凭证恢复失败 · 请重新授权' : s.authStatus?.status === 'unverified' ? '账户尚未验证 · 请联网刷新' : account ? '账户已连接' : demo ? '演示模式 · 数据仅在本机' : '未登录 · 可使用本地错题';
    const avatar = $('.account-avatar'); avatar.replaceChildren();
    if (/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(account?.avatarData || '')) { const image = element('img'); image.src = account.avatarData; image.alt = ''; avatar.append(image); } else avatar.textContent = String($('#account-name').textContent).slice(0, 1);
    $('#account-button').title = 'GitHub 账户'; $('#account-button').setAttribute('aria-label', $('#account-button').title);
  }
  const facets = { platform: new Set(), tags: new Set(), authors: new Set(), native: new Set() };
  const facetNames = { platform: '平台', tags: '标签', authors: '作者', native: '难度' };
  const platformNames = { CF: 'Codeforces', LG: '洛谷', AT: 'AtCoder', NC: '牛客', LC: 'LeetCode', Oth: '其他平台' };
  function facetValue(record, group) { return group === 'platform' ? NotebookSearch.normalizePlatform(record.platform) : group === 'authors' ? authorName(record.author || (isLocal(record) ? s.account?.login || '我（本地）' : '')) : ''; }
  function fillFacetOptions(container, group, values, search = '') {
    container.replaceChildren();
    const counts = new Map(); values.forEach(value => counts.set(String(value), (counts.get(String(value)) || 0) + 1));
    const options = [...new Set([...counts.keys(), ...facets[group]])].sort((a,b) => a.localeCompare(b, 'zh-CN'));
    options.filter(value => (group === 'platform' ? platformNames[value] || value : value).toLowerCase().includes(search.toLowerCase())).forEach(value => {
      const label = element('label', 'facet-option'); const input = element('input'); input.type = 'checkbox'; input.value = value; input.checked = facets[group].has(value);
      input.addEventListener('change', () => { input.checked ? facets[group].add(value) : facets[group].delete(value); updateFacetCounts(); render(); });
      append(label, input, element('span', '', group === 'platform' ? platformNames[value] || value : value), element('small', '', counts.get(value) || 0)); container.append(label);
    });
    if (!container.children.length) container.append(element('p', 'facet-help', '没有匹配的选项'));
  }
  function refreshFilters() {
    const all = records();
    for (const group of ['platform', 'tags', 'authors']) {
      const host = $(group === 'tags' ? '#tag-filter' : group === 'authors' ? '#author-filter' : '#platform-filter');
      const values = group === 'tags' ? all.flatMap(r => Array.isArray(r.tags) ? r.tags : []) : all.map(r => facetValue(r, group));
      if (group === 'tags') {
        const trigger = button('', 'facet-trigger', () => openTagPicker('filter'));
        append(trigger, document.createTextNode(facetNames[group] + ' '), element('span', 'facet-chevron', '⌄'));
        trigger.id = 'tag-filter-trigger'; trigger.setAttribute('aria-haspopup', 'dialog'); host.replaceChildren(trigger);
      } else {
        const wasOpen = host.querySelector('details')?.open; const query = host.querySelector('input[type="search"]')?.value || '';
        const details = element('details'); details.open = !!wasOpen; const summary = element('summary'); append(summary, document.createTextNode(facetNames[group]+' '), element('span', 'facet-count'), element('span', 'facet-chevron', '⌄'));
        const popover = element('div', 'facet-popover'); const search = element('input', 'facet-search'); search.type = 'search'; search.placeholder = `查找${facetNames[group]}`; search.setAttribute('aria-label', `查找${facetNames[group]}`); search.value = query;
        const options = element('div', 'facet-options'); search.addEventListener('input', () => fillFacetOptions(options, group, values, search.value));
        append(popover, search, options, button('清除本组', 'facet-clear', () => { facets[group].clear(); fillFacetOptions(options, group, values, search.value); updateFacetCounts(); render(); })); append(details, summary, popover); host.replaceChildren(details); fillFacetOptions(options, group, values, query);
      }
    }
    const native = all.filter(r => !['CF','LG'].includes(NotebookSearch.normalizePlatform(r.platform))).map(r => String(r.difficulty || '').trim()).filter(Boolean);
    fillFacetOptions($('#native-difficulty-options'), 'native', native); updateFacetCounts();
  }
  function tagGroups(extra = []) {
    const groups = (s.tagCatalog?.categories || []).map(c => ({ id: String(c.id), name: String(c.name), tags: (c.tags || []).map(t => String(t.name)) }));
    const known = new Set(groups.flatMap(c => c.tags));
    const historical = [...new Set([...records().flatMap(r => Array.isArray(r.tags) ? r.tags.map(String) : []), ...extra])].filter(t => !known.has(t));
    if (historical.length) groups.push({ id: 'history', name: '历史标签', tags: historical, historical: true });
    return groups;
  }
  function fillTagOptions(container, selected, query, onChange) {
    container.replaceChildren();
    const counts = new Map(); records().forEach(r => new Set(r.tags || []).forEach(t => counts.set(t, (counts.get(t) || 0) + 1)));
    tagGroups([...selected]).forEach(group => {
      const matching = group.tags.filter(t => `${group.name} ${t}`.toLowerCase().includes(query.toLowerCase())); if (!matching.length) return;
      container.append(element('strong', 'tag-category-heading', group.name));
      matching.forEach(value => { const label = element('label', 'facet-option'); const input = element('input'); input.type = 'checkbox'; input.value = value; input.checked = selected.has(value); input.disabled = s.busy;
        input.addEventListener('change', () => { input.checked ? selected.add(value) : selected.delete(value); $$('input[type="checkbox"]', container).filter(n => n.value === value).forEach(n => n.checked = input.checked); onChange(); });
        append(label, input, element('span', '', value + (group.historical ? ' · 历史' : '')), element('small', '', counts.get(value) || 0)); container.append(label);
      });
    });
    if (!container.children.length) container.append(element('p', 'facet-help', '没有匹配的标签'));
  }
  let tagPickerContext = null;
  function openTagPicker(mode) {
    if (s.busy) return;
    const source = mode === 'filter' ? facets.tags : new Set($('#submit-form').elements.tags.value.split(/[,，、]/).map(t => t.trim()).filter(Boolean));
    tagPickerContext = { mode, original: new Set(source), selected: new Set(source) };
    $('#tag-picker-title').textContent = mode === 'filter' ? '筛选算法标签' : '选择算法标签';
    $('#tag-picker-hint').textContent = mode === 'filter' ? '命中任一已选标签的题目将显示；确定后应用筛选。' : '选择一个或多个标签，点击确定后加入错题。';
    $('#tag-picker-search').value = '';
    fillTagOptions($('#tag-picker-dialog-options'), tagPickerContext.selected, '', () => {});
    $('#tag-picker-dialog').showModal(); $('#tag-picker-search').focus();
  }
  function closeTagPicker(apply) {
    if (!tagPickerContext) return;
    const context = tagPickerContext; tagPickerContext = null; $('#tag-picker-dialog').close();
    if (!apply) return;
    if (context.mode === 'filter') {
      facets.tags.clear(); context.selected.forEach(tag => facets.tags.add(tag)); refreshFilters(); render();
    } else {
      const field = $('#submit-form').elements.tags; field.value = [...context.selected].join(', '); renderEditorTags(); field.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  function renderEditorTags() {
    const field = $('#submit-form').elements.tags;
    const selected = new Set(field.value.split(/[,，、]/).map(t => t.trim()).filter(Boolean));
    const host = $('#record-tag-selected'); host.replaceChildren();
    selected.forEach(t => host.append(button(t + ' ×', 'filter-chip', () => { if(s.busy)return; selected.delete(t); field.value = [...selected].join(', '); renderEditorTags(); field.dispatchEvent(new Event('input', { bubbles: true })); })));
    $('#record-tag-open').textContent = selected.size ? `选择标签…（已选 ${selected.size}）` : '选择标签…';
  }
  async function openTagDialog() {
    const select = $('#request-tag-category'); select.replaceChildren();
    (s.tagCatalog?.categories || []).forEach(c => { const option = element('option', '', c.name); option.value = c.id; select.append(option); });
    $('#tag-review-section').hidden = true; $('#tag-review-dialog').showModal();
    if (demo || typeof bridge?.getTagReview !== 'function') return;
    try { const result = await call('getTagReview'); s.tagReview = result; if (!result?.canReview) return; $('#tag-review-section').hidden = false; const list = $('#tag-review-list'); list.replaceChildren();
      (result.requests || []).forEach(request => { const row = element('article', 'tag-request-row'); append(row, element('strong', '', `${request.category} / ${request.name}`), element('p', 'facet-help', `#${request.number} · ${authorName(request.author)} · ${request.state || 'open'}`));
        if(request.url) row.append(button('查看申请 ↗', 'button subtle', () => openExternal(request.url)));
        ['approve','reject'].forEach(decision => row.append(button(decision === 'approve' ? '批准' : '拒绝', 'button secondary', async () => { if (s.busy || !s.tagReview?.canReview || demo) return; setBusy(true); try { await call('reviewTag', { number: request.number, decision, expected: request.expected || { category: request.category, name: request.name } }); if (typeof bridge.getTagCatalog === 'function') { const catalog = await call('getTagCatalog'); if (Array.isArray(catalog?.categories)) s.tagCatalog = catalog; } $('#tag-review-dialog').close(); refreshFilters(); if ($('#submit-dialog').open) renderEditorTags(); toast('标签申请已处理'); } catch(error) { toast(errorMessage(error)); } finally { setBusy(false); } })));
        list.append(row);
      }); if (!list.children.length) list.append(element('p', 'facet-help', '暂无待审核申请'));
    } catch(error) { toast(errorMessage(error)); }
  }
  function ranges() { return ['rating-min','rating-max','luogu-min','luogu-max'].map(id => { const v=$('#'+id).value; return v === '' ? null : Number(v); }); }
  function updateFacetCounts() {
    ['rating-min','rating-max'].forEach(id => colorRatingInput($('#'+id)));
    for (const group of ['platform','tags','authors']) { const count = facets[group].size; const node = $(`[data-facet="${group}"] .facet-count`); if(node) node.textContent = count || ''; }
    const range = ranges(); const count = range.filter(v=>v!==null).length + facets.native.size; $('#difficulty-count').textContent = count ? '已选' : '';
    const chips=$('#active-filters'); chips.replaceChildren();
    for(const group of Object.keys(facets)) for(const value of facets[group]) chips.append(button(`${facetNames[group]} · ${group === 'platform' ? platformNames[value] || value : value} ×`, 'filter-chip', () => { facets[group].delete(value); refreshFilters(); render(); }));
    if(range.some(v=>v!==null)) chips.append(button('难度区间 ×','filter-chip',()=>{clearDifficulty();render();}));
    chips.hidden=!chips.children.length;
    $('#range-error').hidden = !((range[0]!==null && range[1]!==null && range[0]>range[1]) || (range[2]!==null && range[3]!==null && range[2]>range[3]));
  }
  function clearDifficulty() { ['rating-min','rating-max','luogu-min','luogu-max'].forEach(id=>$('#'+id).value=''); facets.native.clear(); ['luogu-min','luogu-max'].forEach(id=>colorLuoguSelection($('#'+id))); refreshFilters(); }
  function filteredRecords() {
    const search = $('#search-input').value.trim(); const status = $('#state-filter').value;
    const [min,max,lgMin,lgMax] = ranges();
    const scores = new Map();
    const difficultyActive = [min,max,lgMin,lgMax].some(v=>v!==null) || facets.native.size>0;
    return records().filter(record => {
      if (s.view === 'public' && record.kind !== 'document') return false;
      if (s.view === 'discussion' && record.kind !== 'issue') return false;
      if (s.view === 'mine' && !isMine(record)) return false;
      if (s.view === 'favorites' && !favorite(record)) return false;
      if (facets.platform.size && !facets.platform.has(facetValue(record,'platform'))) return false;
      if (facets.tags.size && !(record.tags || []).some(tag=>facets.tags.has(String(tag)))) return false;
      if (facets.authors.size && !facets.authors.has(facetValue(record,'authors'))) return false;
      if (difficultyActive) {
        const code=NotebookSearch.normalizePlatform(record.platform), info=NotebookSearch.difficulty(record);
        const cf=code==='CF' && (min!==null || max!==null) && info.level!==null && (min===null || info.level>=min) && (max===null || info.level<=max);
        const lg=code==='LG' && (lgMin!==null || lgMax!==null) && info.level!==null && (lgMin===null || info.level>=lgMin) && (lgMax===null || info.level<=lgMax);
        const native=!['CF','LG'].includes(code) && facets.native.has(String(record.difficulty || '').trim());
        if(!cf && !lg && !native) return false;
      }
      if (status === 'local' && !isLocal(record) || status === 'shared' && isLocal(record)) return false;
      if (stateLabels[status] && mastery(record) !== status) return false;
      const score=NotebookSearch.match(record,search); scores.set(record,score); return score>0;
    }).sort((a, b) => NotebookSearch.tagHits(b, facets.tags) - NotebookSearch.tagHits(a, facets.tags) || (search ? scores.get(b)-scores.get(a) : 0) || (new Date(b.updatedAt).getTime() || 0) - (new Date(a.updatedAt).getTime() || 0));
  }
  function badge(record) { return element('span', `badge ${isLocal(record) ? 'local' : 'shared'}`, isLocal(record) ? record.proposalUrl ? '旧版已投稿副本' : '仅本地 · 未上传' : record.kind === 'document' ? '正式题解' : '讨论 Issue'); }
  function platformCode(value) { return NotebookSearch.normalizePlatform(value); }
  function platformLabel(record) { const code = platformCode(record.platform); const label = element('span', 'platform-label', ({ CF: 'Codeforces', AT: 'AtCoder', LG: '洛谷', NC: '牛客', LC: 'LeetCode' })[code] || record.platform || '其他平台'); label.dataset.platform = ['CF', 'AT', 'LG', 'NC', 'LC'].includes(code) ? code : 'Oth'; return label; }
  function difficultyBadge(record) {
    const {tone,rank,label:text} = NotebookSearch.difficulty(record);
    if(!text) return null;
    const code=NotebookSearch.normalizePlatform(record.platform);
    const label = element('span', `difficulty-badge tone-${tone}${rank ? ` rank-${rank}` : ''}`, text);
    label.title = `${demo ? '演示值 · ' : ''}${code === 'CF' ? 'Codeforces 原生 Rating 色阶' : code === 'LG' ? '洛谷原生难度名称 · 颜色仅用于界面展示' : '平台原始数值 / 难度'}，不跨平台换算`;
    return label;
  }
  function tags(record) { const row = element('div', 'tag-row'); (Array.isArray(record.tags) ? record.tags : []).forEach(tag => { let hash = 0; for (const char of String(tag)) hash = (hash + char.codePointAt(0)) % 5; row.append(element('span', `tag tag-color-${hash}`, tag)); }); return row; }
  function empty(title, description, action) { const box = element('div', 'empty-state'); append(box, element('div', 'empty-icon', '⌑'), element('h3', '', title), element('p', '', description)); if (action) box.append(button(action.label, 'button secondary', action.fn)); return box; }
  let focusedDetail = false;
  let readerPosition = null;
  function openDetail(record) {
    if (focusedDetail) return;
    s.selected = key(record); readerPosition = { window: window.scrollY, list: $('#record-list').scrollTop, panel: $('#detail-panel').scrollTop, focus: document.activeElement };
    focusedDetail = true; document.body.classList.add('reading-detail'); render(); $('#detail-back-button')?.focus(); window.scrollTo(0, 0);
  }
  function closeDetail() {
    focusedDetail = false; document.body.classList.remove('reading-detail'); render();
    if (readerPosition) { $('#record-list').scrollTop = readerPosition.list; $('#detail-panel').scrollTop = readerPosition.panel; window.scrollTo(0, readerPosition.window); const card = $$('.record-card').find(n => n.dataset.key === s.selected); card?.focus({ preventScroll: true }); }
  }
  function render() {
    updateStateFacet();
    document.body.dataset.view = s.view;
    const [title, description, eyebrow] = views[s.view]; $('#page-title').replaceChildren(document.createTextNode(title), element('span', 'heading-dot', '.')); $('#breadcrumb-view').textContent = title; $('#page-description').textContent = description; $('#page-eyebrow').textContent = eyebrow;
    $$('.nav-item').forEach(node => { node.classList.toggle('active', node.dataset.view === s.view); if (node.dataset.view === s.view) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); });
    const all = records(); $('#count-public').textContent = all.filter(record => record.kind === 'document').length; $('#count-discussion').textContent = all.filter(record => record.kind === 'issue').length; $('#count-mine').textContent = all.filter(isMine).length; $('#count-favorites').textContent = all.filter(favorite).length;
    $('#stats-panel').hidden = s.view !== 'stats'; $('#library-panel').hidden = s.view === 'stats'; updateStatus();
    if (s.view === 'stats') { renderStats(); return; }
    const items = filteredRecords(); $('#result-count').textContent = items.length;
    $('.list-heading > span:last-child').textContent = facets.tags.size ? '标签命中数 ↓ · 相关度 / 更新时间' : $('#search-input').value.trim() ? '匹配程度 ↓' : '最近更新 ↓';
    if (!items.some(record => key(record) === s.selected)) s.selected = items[0] ? key(items[0]) : null;
    const list = $('#record-list'); list.replaceChildren();
    items.forEach(record => {
      const card = button('', `record-card${key(record) === s.selected ? ' selected' : ''}`, () => { s.selected = key(record); $$('.record-card').forEach(n => { const active = n.dataset.key === s.selected; n.classList.toggle('selected', active); n.setAttribute('aria-pressed', String(active)); }); renderDetail(record); }); card.dataset.key = key(record); card.title = '单击预览，双击打开详情；Enter 打开详情'; card.setAttribute('aria-pressed', key(record) === s.selected ? 'true' : 'false');
      card.addEventListener('dblclick', () => openDetail(record));
      card.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); openDetail(record); } });
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
  async function changeLocal(change) { if (s.busy) return; setBusy(true); const before = structuredClone(s.local); change(); render(); try { await persistLocal(); } catch (error) { s.local = before; render(); toast(`未能保存：${errorMessage(error)}`); } finally { setBusy(false); } }
  function renderDetail(record) {
    const panel = $('#detail-panel'); const scroll = panel.scrollTop; panel.replaceChildren();
    if (focusedDetail) { const back = button('← 返回题目网格', 'button secondary detail-back', closeDetail); back.id = 'detail-back-button'; panel.append(back); } else { const open = button('打开详情 ↗', 'button primary detail-open', () => openDetail(record)); open.id = 'open-detail-button'; panel.append(open); }
    const actions = append(element('div', 'detail-actions'), button(favorite(record) ? '★ 已收藏' : '☆ 收藏', 'button secondary', () => changeLocal(() => { s.local.favorites = favorite(record) ? s.local.favorites.filter(value => String(value) !== key(record)) : [...s.local.favorites, key(record)]; })), button('原题 ↗', 'button subtle', () => openExternal(record.problemUrl || record.url)));
    append(panel, append(element('div', 'detail-top'), append(element('div', 'detail-meta'), platformLabel(record), element('span', '', record.pid || `#${record.number || '本地'}`), difficultyBadge(record), badge(record)), actions), element('h2', 'detail-title', record.title || '未命名错题'));
    const author = authorName(record.author); append(panel, append(element('div', 'author-row'), element('span', 'mini-avatar', author.slice(0, 1)), element('span', '', author), element('span', 'separator', '·'), element('span', '', `更新于 ${date(record.updatedAt)}`), record.kind === 'document' ? element('span', 'badge document', '正式题解') : null));
    const tagrow = tags(record); tagrow.classList.add('detail-tags'); append(panel, tagrow, element('hr', 'detail-divider'), element('div', 'body-label', '思路与复盘'));
    const body = element('div', 'markdown-body'); renderMarkdown(body, record.body); panel.append(body);
    const masteryButtons = element('div', 'mastery-buttons'); Object.entries(stateLabels).forEach(([value, label]) => { const control = button(label, mastery(record) === value ? 'active' : '', () => changeLocal(() => { s.local.mastery[key(record)] = value; })); control.setAttribute('aria-pressed', mastery(record) === value ? 'true' : 'false'); masteryButtons.append(control); });
    append(panel, append(element('div', 'mastery-box'), append(element('div'), element('strong', '', '这个思路，掌握了吗？'), element('small', '', '复习进度仅记录在你的学习空间')), masteryButtons));
    const edits = element('div', 'record-edit-actions');
    if (record.proposalUrl) edits.append(button('旧版已投稿副本 · 查看投稿 ↗', 'button secondary', () => openExternal(record.proposalUrl)));
    if (isLocal(record) && visibleLocal(record) || canEditRemote(record)) { const edit = button(isLocal(record) ? '编辑本地记录' : '编辑正式题解', 'button secondary', () => openSubmit(record)); edit.id = 'edit-record-button'; const remove = button(isLocal(record) ? '删除本地记录' : '删除正式题解', 'button danger', () => deleteRecord(record)); remove.id = 'delete-record-button'; append(edits, edit, remove); }
    if (record.kind === 'issue' && sameRepo(record) && s.account && s.permissions.admin === true) {
      const remove = button('永久删除讨论 Issue', 'button danger', () => deleteDiscussion(record)); remove.id = 'delete-issue-button'; edits.append(remove);
    }
    panel.append(edits); panel.scrollTop = scroll;
    if (record.kind !== 'issue' || !record.number) return;
    const comments = element('section', 'comments-section'); append(comments, append(element('div', 'section-heading'), element('h3', '', '一起讨论')));
    const commentList = element('div'); comments.append(commentList); panel.append(comments);
    const form = element('form', 'comment-form'); const input = element('textarea'); input.rows = 2; input.placeholder = '分享你的观察，或提出一个问题…'; input.setAttribute('aria-label', '评论内容'); input.required = true; input.maxLength = 10000;
    const submit = element('button', 'button secondary', demo ? '演示评论' : '发表讨论'); submit.type = 'submit'; append(form, input, submit); comments.append(form);
    form.addEventListener('submit', async event => { event.preventDefault(); const body = input.value.trim(); if (!body || s.busy) return; if (!s.account && !demo) { toast('请先登录 GitHub 账户再评论'); return; } if (!navigator.onLine && !demo) { toast('当前离线，请联网后发表评论'); return; } setBusy(true); submit.disabled = true; try { if (demo) { const items = s.comments.get(key(record)) || []; s.comments.set(key(record), [...items, { author: '我 · 演示', body }]); } else { await call('comment', { number: record.number, repo: record.repo, body }); s.comments.delete(key(record)); } input.value = ''; await loadComments(record, commentList); toast(demo ? '演示评论已添加，未向外部发送' : '评论已发表'); } catch (error) { toast(errorMessage(error)); } finally { setBusy(false); submit.disabled = false; } });
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
  function clearFilters() { $('#search-input').value = ''; $('#state-filter').value=''; Object.values(facets).forEach(set=>set.clear()); clearDifficulty(); render(); }
  async function openExternal(url) { try { const parsed = new URL(String(url)); if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('仅支持 http 或 https 题目链接'); if (demo) window.open(parsed.href, '_blank', 'noopener,noreferrer'); else await call('openExternal', parsed.href); } catch (error) { toast(errorMessage(error)); } }
  let updateLockedControls = null;
  function setBusy(value) {
    if (!value && updateLockedControls) { updateLockedControls.forEach(([node, disabled]) => { node.disabled = disabled; }); updateLockedControls = null; }
    s.busy = value;
    ['sync-button', 'account-button', 'settings-button', 'theme-select', 'submit-button', 'save-local-button', 'publish-button', 'account-login', 'account-logout', 'account-switch', 'account-refresh'].forEach(id => { const node = document.getElementById(id); if (node) node.disabled = value; });
    $$('[data-close], #settings-form input, #settings-form select, #settings-form button').forEach(node => { node.disabled = value; });
    $$('#submit-form input, #submit-form textarea').forEach(node => { node.readOnly = value; });
    $$('#submit-form select, #editor-difficulty-picker select, #editor-difficulty-picker button').forEach(node => { node.disabled = value; });
    if (!value && s.editor?.record?.kind === 'document') $('#save-local-button').disabled = true;
    if (value && updateRunning) {
      const controls = $$('button, input, select, textarea');
      if (!updateLockedControls) updateLockedControls = controls.map(node => [node, node.disabled]);
      controls.forEach(node => { node.disabled = true; });
    }
    $('#check-update-button').disabled = value;
    if (!value) queueMicrotask(showStartupUpdate);
  }
  function formDraft() { const form = $('#submit-form'); return Object.fromEntries(['url', 'title', 'pid', 'platform', 'tags', 'reason', 'body', 'trick', 'rating', 'difficulty'].map(name => [name, String(form.elements.namedItem(name)?.value || '')])); }
  function fillForm(draft) { const form = $('#submit-form'); form.reset(); Object.entries(draft || {}).forEach(([name, value]) => { const input = form.elements.namedItem(name); if (input) input.value = String(value ?? ''); }); }
  const editorLuoguLevels = ['入门','普及-','普及','普及+/提高-','提高','提高+/省选-','省选/NOI-','NOI/NOI+/CTS'];
  const editorLuoguTones = ['red','orange','yellow','green','cyan','blue','purple','black'];
  function renderEditorDifficulty() {
    const form = $('#submit-form'), host = $('#editor-difficulty-picker');
    const platform = platformCode(form.elements.platform.value);
    const rating = form.elements.rating, native = form.elements.difficulty;
    const wrapper = element('div', 'editor-difficulty-controls');
    if (platform === 'CF') {
      const ratingField = element('label', 'range-field'); ratingField.append(element('span', '', 'Codeforces Rating'));
      const input = element('input', 'rating-range'); input.type = 'number'; input.min = '0'; input.max = '10000'; input.step = '1'; input.placeholder = '未指定'; input.setAttribute('aria-label', 'Codeforces Rating'); input.value = rating.value;
      const color = () => colorRatingInput(input);
      input.addEventListener('input', () => { rating.value = input.value; color(); }); color(); ratingField.append(input);
      const presets = element('div', 'range-presets');
      [['800–1200','800'],['1300–1900','1300'],['2000+','2000']].forEach(([label,value]) => { const option = button(label, '', () => { input.value = value; rating.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }); option.title = `设置 Codeforces Rating ${value}`; presets.append(option); });
      const nativeField = element('label', 'editor-native-difficulty'); nativeField.append(element('span', '', '其他原生难度（可选）'));
      const nativeInput = element('input'); nativeInput.type = 'text'; nativeInput.maxLength = '60'; nativeInput.placeholder = '如 ABC D'; nativeInput.value = native.value; nativeInput.setAttribute('aria-label', 'Codeforces 其他原生难度'); nativeInput.addEventListener('input', () => { native.value = nativeInput.value; }); nativeField.append(nativeInput);
      wrapper.append(ratingField, presets, nativeField);
    } else if (platform === 'LG') {
      const select = element('select', 'luogu-range'); select.setAttribute('aria-label', '洛谷原生难度');
      [['','未指定'], ...editorLuoguLevels.map(name => [name,name])].forEach(([value,label], index) => { const option = element('option', index ? `tone-${editorLuoguTones[index - 1]}` : '', label); option.value = value; select.append(option); });
      const current = NotebookSearch.difficulty({ platform:'LG', difficulty:native.value });
      const known = current.level ? editorLuoguLevels[current.level - 1] : editorLuoguLevels.find(level => level === native.value);
      if (known) select.value = known; else if (native.value) { const legacy = element('option', '', native.value); legacy.value = native.value; select.append(legacy); select.value = native.value; }
      const color = () => { const level = editorLuoguLevels.indexOf(select.value); select.className = `luogu-range${level >= 0 ? ` tone-${editorLuoguTones[level]}` : ''}`; };
      select.addEventListener('change', () => { native.value = select.value; color(); }); color(); wrapper.append(select);
    } else if (platform === 'LC') {
      const select = element('select', 'luogu-range'); select.setAttribute('aria-label', 'LeetCode 原生难度');
      [['','未指定',''],['Easy','Easy / 简单','green'],['Medium','Medium / 中等','yellow'],['Hard','Hard / 困难','red']].forEach(([value,label,tone]) => { const option = element('option', tone ? `tone-${tone}` : '', label); option.value = value; select.append(option); });
      const level = NotebookSearch.difficulty({ platform:'LC', difficulty:native.value }).level;
      const known = ['Easy','Medium','Hard'][level - 1];
      if (known) select.value = known;
      else if (native.value) { const legacy = element('option', '', native.value); legacy.value = native.value; select.append(legacy); select.value = native.value; }
      const color = () => { const tone = { Easy:'green', Medium:'yellow', Hard:'red' }[select.value]; select.className = `luogu-range${tone ? ` tone-${tone}` : ''}`; };
      select.addEventListener('change', () => { native.value = select.value; color(); }); color(); wrapper.append(select);
    } else {
      const input = element('input'); input.type = 'text'; input.maxLength = 60; input.placeholder = '原生难度，如 ABC D / 3'; input.setAttribute('aria-label', '平台原生难度'); input.value = native.value;
      const datalist = element('datalist'); datalist.id = 'editor-native-difficulties';
      const values = platform === 'AT' ? ['ABC A','ABC B','ABC C','ABC D','ABC E','ABC F','ARC A','ARC B','ARC C','ARC D','ARC E','ARC F'] : platform === 'NC' ? ['简单','中等','困难'] : [];
      values.forEach(value => { const option = element('option'); option.value = value; datalist.append(option); }); input.setAttribute('list', datalist.id);
      input.addEventListener('input', () => { native.value = input.value; }); wrapper.append(input, datalist);
    }
    host.replaceChildren(wrapper);
  }
  function setEditorPlatform(value, clearDifficulty = true) {
    const form = $('#submit-form'), next = platformCode(value);
    if (form.elements.platform.value !== next) {
      form.elements.platform.value = next;
      if (clearDifficulty) { form.elements.rating.value = ''; form.elements.difficulty.value = ''; }
    }
    renderEditorDifficulty();
  }
  function draftKey(source, ownerId) { return JSON.stringify([source || 'new', ownerId]); }
  function editorError(error) { $('#submit-error').textContent = errorMessage(error); $('#submit-error').hidden = false; }
  function openSubmit(record) {
    if (s.busy) return;
    if (record && !(isLocal(record) && visibleLocal(record) || canEditRemote(record))) { toast('当前账户无权编辑这条记录'); return; }
    const source = record ? key(record) : 'new', ownerId = accountId();
    const candidate = s.local.draft[draftKey(source, ownerId)];
    const saved = candidate?.source === source && candidate.ownerId === ownerId ? candidate : null;
    const original = record ? structuredClone(record) : null;
    if (original?.kind === 'document' && saved?.base?.path === original.path && saved.base.repo === original.repo) original.sha = saved.base.sha;
    s.editor = { source, ownerId, clientId: saved?.clientId || record?.clientId || uuid(), record: original };
    const data = record ? { url: record.problemUrl || record.url, title: record.title, pid: record.pid, platform: platformCode(record.platform), tags: (record.tags || []).join(', '), body: record.body || '', rating: record.rating ?? '', difficulty: record.difficulty || '' } : {};
    fillForm(saved?.source === source && saved.ownerId === ownerId ? saved.data : data);
    renderEditorDifficulty();
    renderEditorTags();
    const editing = !!record;
    $('#creation-extras').hidden = editing;
    $('#save-local-button').disabled = record?.kind === 'document';
    $('#save-local-button').title = record?.kind === 'document' ? '在线题解修改保存在独立编辑草稿中，请直接更新原文档' : '';
    $('#submit-title').textContent = record?.kind === 'document' ? '编辑正式题解' : editing ? '编辑本地记录' : '记下一道错题';
    $('#submit-error').hidden = true;
    $('#draft-hint').textContent = saved ? '已恢复此来源与当前账户的编辑草稿' : record?.kind === 'document' ? '保留完整 Markdown 原文，失败后编辑内容仍在此处' : '草稿按来源与当前账户保存在本机';
    $('#publish-button').textContent = record?.kind === 'document' ? '更新原文档' : '上传正式题解';
    $('#submit-dialog').showModal();
  }
  async function saveDraft(required = false) {
    if (!s.editor || s.editor.ownerId !== accountId()) return;
    const { source, ownerId, clientId, record } = s.editor;
    s.local.draft[draftKey(source, ownerId)] = { source, ownerId, clientId, ...(record?.kind === 'document' ? { base: { path: record.path, repo: record.repo, sha: record.sha } } : {}), data: formDraft() };
    try { await persistLocal(); $('#draft-hint').textContent = '编辑草稿已保存到当前设备'; } catch (error) { $('#draft-hint').textContent = `编辑草稿保存失败：${errorMessage(error)}；请勿关闭窗口`; if (required) throw new Error(`无法持久化编辑标识，尚未写入 GitHub：${errorMessage(error)}`); }
  }
  async function saveRecord(remote) {
    const form = $('#submit-form'); if (s.busy || !form.reportValidity() || !s.editor) return;
    if (s.editor.ownerId !== accountId()) { editorError('账户已变更，请重新打开编辑器'); return; }
    clearTimeout(draftTimer);
    const data = formDraft(), existing = s.editor.record;
    if (!data.body.trim()) { editorError('请填写完整 Markdown 题解正文'); return; }
    let parsed; try { parsed = new URL(data.url); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(); } catch (_) { editorError('请输入有效的 http 或 https 题目链接'); return; }
    if (existing?.kind === 'document' && (!remote || !canEditRemote(existing))) { editorError('当前账户无权执行此操作；在线编辑只能更新原文档'); return; }
    if (remote) {
      if (demo) { editorError('浏览器演示不会写入 GitHub，请保存本地记录'); return; }
      if (!s.account || s.permissions.push !== true || !repo()) { editorError('请登录具有当前仓库 push 权限的 GitHub 账户并刷新账户'); return; }
      if (existing?.proposalUrl) { editorError('这是旧版已投稿副本，请先查看原投稿，不能重复上传'); return; }
      if (!navigator.onLine) { editorError('当前离线，编辑内容保留，请联网后重试或保存本地记录'); await saveDraft(); return; }
      const binding = existing?.kind === 'local' && existing.ownerId == null;
      if (!window.confirm(existing?.kind === 'document' ? `确认直接更新 ${existing.repo} 中的原文档 ${existing.path}？` : `确认上传正式题解到 ${repo()}？${binding ? ' 此未绑定本地记录将绑定当前 GitHub ID ' + accountId() + '。' : ''}`)) return;
    }
    const clientId = s.editor.clientId;
    const body = !existing ? [data.body, data.reason.trim() ? `## 错因分析\n${data.reason.trim()}` : '', data.trick.trim() ? `## Trick\n${data.trick.trim()}` : ''].filter(Boolean).join('\n\n') : data.body;
    const record = { ...(existing || {}), clientId, ownerId: existing && !remote ? existing.ownerId : existing?.ownerId ?? accountId(), title: data.title.trim() || data.pid.trim() || '未命名错题', pid: data.platform === 'CF' && data.pid.trim() ? `CF${data.pid.trim().replace(/^CF/i, '')}` : data.pid.trim(), platform: data.platform, rating: data.rating.trim() ? Number(data.rating) : null, difficulty: data.difficulty.trim(), tags: data.tags.split(/[,，、]/).map(tag => tag.trim()).filter(Boolean), problemUrl: parsed.href, url: parsed.href, body, updatedAt: new Date().toISOString() };
    setBusy(true); $('#submit-error').hidden = true;
    let wroteRemote = false; const previousLocal = structuredClone(s.local);
    try {
      if (remote && existing?.kind === 'local' && existing.ownerId == null) {
        const source = s.local.records.find(item => key(item) === s.editor.source && item.clientId === existing.clientId && item.ownerId == null);
        if (!source) throw new Error('本地来源记录已变化，请重新打开编辑器');
        source.ownerId = accountId();
        existing.ownerId = accountId();
      }
      await saveDraft(remote);
      if (remote) {
        const response = await call('saveDocument', { ...record, repo: existing?.kind === 'document' ? existing.repo : repo(), ...(existing?.kind === 'document' ? { path: existing.path, sha: existing.sha } : {}) });
        const documentRecord = response?.document || response?.record || response;
        if (documentRecord?.kind !== 'document' || !documentRecord.path || !documentRecord.sha) throw new Error('客户端返回的文档不完整，请同步核实；编辑草稿已保留');
        wroteRemote = true;
        s.records = [...s.records.filter(item => !(item.path === documentRecord.path && item.repo === documentRecord.repo)), documentRecord];
        if (existing?.kind === 'local') s.local.records = s.local.records.filter(item => !(key(item) === s.editor.source && item.clientId === existing.clientId && item.ownerId === existing.ownerId));
        s.selected = key(documentRecord);
      } else {
        const localRecord = { ...record, id: existing?.id ?? `local:${clientId}`, kind: 'local' };
        s.local.records = [...s.local.records.filter(item => !(existing?.kind === 'local' && key(item) === s.editor.source && item.clientId === existing.clientId && item.ownerId === existing.ownerId)), localRecord]; s.selected = key(localRecord);
      }
      delete s.local.draft[draftKey(s.editor.source, s.editor.ownerId)];
      try { await persistLocal(); } catch (error) { if (wroteRemote) { toast('GitHub 已更新，本地清理未保存，请同步核实'); } else throw error; }
      form.reset(); $('#submit-dialog').close(); s.editor = null; s.view = 'mine'; refreshFilters(); render(); toast(remote ? '正式题解已保存到 GitHub' : '已保存本地记录');
    } catch (error) { if (!remote) s.local = previousLocal; editorError(error); await saveDraft(); }
    finally { setBusy(false); }
  }
  async function deleteDiscussion(record) {
    if (s.busy) return;
    if (demo) { toast('浏览器演示不会删除 GitHub 讨论'); return; }
    if (!sameRepo(record) || !s.account || s.permissions.admin !== true) { toast('永久删除讨论需要当前仓库管理员权限'); return; }
    if (!window.confirm(`永久删除 GitHub 仓库 ${record.repo} 的 Issue #${record.number}「${record.title}」及其讨论？此操作不能撤销，不会删除正式题解文件。`)) return;
    setBusy(true);
    try {
      const result = await call('deleteIssue', { number: record.number, repo: record.repo });
      if (!result?.deleted) throw new Error('GitHub 未确认删除，请同步核实');
      s.issues = s.issues.filter(item => !(item.repo === record.repo && item.number === record.number));
      s.comments.delete(key(record));
      s.local.favorites = s.local.favorites.filter(id => String(id) !== key(record));
      delete s.local.mastery[key(record)];
      try { await persistLocal(); } catch (_) { toast('讨论已删除，本地复习状态清理未保存，请同步'); }
      s.selected = null; refreshFilters(); render(); toast('GitHub 讨论已永久删除');
    } catch (error) { toast(`删除讨论失败：${errorMessage(error)}`); }
    finally { setBusy(false); }
  }
  async function deleteRecord(record) {
    if (s.busy) return;
    const local = isLocal(record);
    if (!(local && visibleLocal(record) || canEditRemote(record))) { toast('当前账户没有删除权限'); return; }
    if (demo && !local) { toast('浏览器演示不会删除 GitHub 文档'); return; }
    if (!window.confirm(local ? '确认删除这条本地记录？此操作只修改本机。' : `确认从 GitHub 仓库 ${record.repo} 删除 ${record.path}？`)) return;
    setBusy(true);
    try {
      if (local) { const previous = structuredClone(s.local); s.local.records = s.local.records.filter(item => item.clientId !== record.clientId); try { await persistLocal(); } catch (error) { s.local = previous; throw error; } }
      else { await call('deleteDocument', { path: record.path, sha: record.sha, repo: record.repo }); s.records = s.records.filter(item => !(item.path === record.path && item.repo === record.repo)); }
      s.selected = null; refreshFilters(); render(); toast(local ? '本地记录已删除' : 'GitHub 文档已删除');
    } catch (error) { toast(`删除失败：${errorMessage(error)}`); } finally { setBusy(false); }
  }
  async function sync() {
    if (s.busy || $('#submit-dialog').open) { toast('请先完成或关闭当前编辑'); return; }
    setBusy(true);
    try { if (demo) { toast('演示模式：本地记录已保留，未连接公共题库'); return; } if (!navigator.onLine) throw new Error('当前离线，请连接网络后重试'); applyPayload(await call('sync')); s.comments.clear(); refreshFilters(); render(); toast('学习空间已同步'); } catch (error) { const message = errorMessage(error); try { applyPayload(await call('bootstrap')); } catch (_) {} s.error = message; refreshFilters(); render(); toast(`同步失败：${message}`); } finally { setBusy(false); }
  }
  $$('.nav-item').forEach(node => node.addEventListener('click', () => { if (focusedDetail) { focusedDetail = false; document.body.classList.remove('reading-detail'); } s.view = node.dataset.view; clearFilters(); }));
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && focusedDetail && !document.querySelector('dialog[open]')) { event.preventDefault(); closeDetail(); } });
  $('#record-tag-open').addEventListener('click', () => openTagPicker('editor'));
  $('#tag-picker-search').addEventListener('input', event => { if (tagPickerContext) fillTagOptions($('#tag-picker-dialog-options'), tagPickerContext.selected, event.target.value, () => {}); });
  $('#tag-picker-confirm').addEventListener('click', () => closeTagPicker(true));
  $('#tag-picker-cancel').addEventListener('click', () => closeTagPicker(false));
  $('#tag-picker-close').addEventListener('click', () => closeTagPicker(false));
  $('#tag-picker-dialog').addEventListener('cancel', event => { event.preventDefault(); closeTagPicker(false); });
  $('#request-tag-open').addEventListener('click', openTagDialog);
  const tagEntry = button('＋ 添加标签', 'button subtle', openTagDialog); tagEntry.id = 'tag-manager-button'; $('.topbar-actions').insertBefore(tagEntry, $('#sync-button'));
  $('#tag-request-form').addEventListener('submit', async event => { event.preventDefault(); if (s.busy) return; const category = $('#request-tag-category').value, name = $('#request-tag-dialog-name').value.trim(); if (!category || !name) return;
    if (demo) { toast('演示模式：未发送标签申请，不会写入外部'); return; }
    setBusy(true); try { await call('requestTag', { category, name }); $('#request-tag-dialog-name').value = ''; $('#tag-review-dialog').close(); toast('标签申请已提交，审核后加入公共标签'); } catch(error) { toast(errorMessage(error)); } finally { setBusy(false); }
  });
  $('.brand').addEventListener('click', event => { event.preventDefault(); if (s.busy) return; focusedDetail = false; document.body.classList.remove('reading-detail'); s.view = 'public'; clearFilters(); });
  const stateSelect = $('#state-filter');
  const stateFacet = element('details', 'facet state-facet'); stateFacet.id = 'state-facet';
  const stateSummary = element('summary'); const stateLabel = element('span');
  append(stateSummary, stateLabel, element('span', 'facet-chevron', '⌄'));
  const stateOptions = element('div', 'facet-popover'); stateOptions.setAttribute('aria-label', '状态筛选');
  [...stateSelect.options].forEach(option => { const label = element('label', 'facet-option'); const input = element('input'); input.type = 'radio'; input.name = 'state-choice'; input.value = option.value;
    input.addEventListener('change', () => { stateSelect.value = input.value; stateFacet.open = false; render(); }); append(label, input, element('span', '', option.textContent)); stateOptions.append(label); });
  append(stateFacet, stateSummary, stateOptions); stateSelect.hidden = true; stateSelect.after(stateFacet);
  function updateStateFacet() { stateLabel.textContent = stateSelect.selectedOptions[0]?.textContent || '全部状态'; $$('input', stateOptions).forEach(input => { input.checked = input.value === stateSelect.value; }); }
  $('#search-input').addEventListener('input', render); $('#state-filter').addEventListener('change', render); $('#clear-filters').addEventListener('click', clearFilters);
  const luoguLevels=['入门','普及-','普及','普及+/提高-','提高','提高+/省选-','省选/NOI-','NOI/NOI+/CTS'];
  const luoguTones=['red','orange','yellow','green','cyan','blue','purple','black'];
  function colorRatingInput(input) {
    const valid = input.value !== '' && !input.validity.badInput && Number.isInteger(input.valueAsNumber) && input.valueAsNumber >= 0 && input.valueAsNumber <= 10000;
    const info = valid ? NotebookSearch.difficulty({ platform:'CF', rating:input.valueAsNumber }) : null;
    input.className = `rating-range${info ? ` tone-${info.tone}` : ''}`;
    input.style.caretColor = info ? 'var(--difficulty-color)' : '';
  }
  function colorLuoguSelection(select) { select.className = select.value ? `luogu-range tone-${luoguTones[Number(select.value)-1]}` : 'luogu-range'; }
  for(const id of ['luogu-min','luogu-max']) { const select=$('#'+id); const option=element('option','','不限');option.value='';select.append(option);luoguLevels.forEach((name,i)=>{const o=element('option',`tone-${luoguTones[i]}`,name);o.value=String(i+1);select.append(o);}); colorLuoguSelection(select);select.addEventListener('input',()=>colorLuoguSelection(select)); }
  ['rating-min','rating-max','luogu-min','luogu-max'].forEach(id=>$('#'+id).addEventListener('input',()=>{updateFacetCounts();render();}));
  $$('[data-rating]').forEach(node=>node.addEventListener('click',()=>{const [min,max]=node.dataset.rating.split(',');$('#rating-min').value=min;$('#rating-max').value=max;updateFacetCounts();render();}));
  $('#clear-difficulty').addEventListener('click',()=>{clearDifficulty();render();});
  document.addEventListener('click',event=>{ $$('.facet details[open],details.facet[open]').forEach(node=>{if(!node.contains(event.target))node.open=false;}); });
  document.addEventListener('keydown',event=>{if(event.key==='Escape')$$('.facet details[open],details.facet[open]').forEach(node=>node.open=false);});
  $('#submit-button').addEventListener('click', () => openSubmit()); $('#sync-button').addEventListener('click', sync);
  $$('dialog').forEach(dialog => dialog.addEventListener('cancel', event => { if (s.busy) event.preventDefault(); }));
  $$('[data-close]').forEach(node => node.addEventListener('click', async () => { if (s.busy) return; if (node.dataset.close === 'submit-dialog') { clearTimeout(draftTimer); setBusy(true); await saveDraft(); setBusy(false); } document.getElementById(node.dataset.close).close(); }));
  $('#submit-dialog').addEventListener('cancel', async event => { event.preventDefault(); if (s.busy) return; clearTimeout(draftTimer); setBusy(true); await saveDraft(); setBusy(false); $('#submit-dialog').close(); });
  $('#submit-form').addEventListener('input', () => { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 650); });
  $('#submit-form').elements.platform.addEventListener('change', () => { const form = $('#submit-form'); form.elements.rating.value = ''; form.elements.difficulty.value = ''; setEditorPlatform(form.elements.platform.value, false); });
  $('#save-local-button').addEventListener('click', () => saveRecord(false)); $('#submit-form').addEventListener('submit', event => { event.preventDefault(); saveRecord(true); });
  $('#theme-select').addEventListener('change', async event => { const previous = { ...s.settings }; s.settings.theme = event.target.value; applyTheme(s.settings.theme); try { if (demo) writeDemo(); else await call('saveSettings', { ...s.settings }); } catch (error) { s.settings = previous; toast(`当前风格已预览，设置未保存：${errorMessage(error)}`); } });
  $('#settings-button').addEventListener('click', () => { if (s.busy || $('#submit-dialog').open) { toast('请先完成或关闭编辑'); return; } const form = $('#settings-form'); form.elements.theme.value = document.body.dataset.theme; form.elements.repo.value = s.settings.repo || 'qmx-acm-data/2026'; form.elements.clientId.value = s.settings.clientId || ''; form.elements.displayName.value = s.settings.displayName || ''; form.elements.autoSync.checked = s.settings.autoSync !== false; $('#settings-dialog').showModal(); });
  $('#settings-form').addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; const settings = { ...s.settings, theme: form.elements.theme.value, repo: form.elements.repo.value.trim() || 'qmx-acm-data/2026', clientId: form.elements.clientId.value.trim(), displayName: form.elements.displayName.value.trim(), autoSync: form.elements.autoSync.checked }; const control = $('button[type="submit"]', form); if (s.busy) return; setBusy(true); try { if (!demo) { await call('saveSettings', settings); applyPayload(await call('bootstrap')); } else s.settings = settings; applyTheme(settings.theme); writeDemo(); $('#settings-dialog').close(); refreshFilters(); render(); toast('设置已保存'); } catch (error) { toast(errorMessage(error)); } finally { setBusy(false); } });
  function renderUpdate() {
    $('#app-version').textContent = s.appVersion || (demo ? '浏览器预览（非桌面客户端）' : '尚未获取');
    const update = s.update || {};
    if (s.updateCapability?.supported === false) $('#update-notice').textContent = s.updateCapability.reason;
    const latest = update.latestVersion ? ` ${update.latestVersion}` : '';
    const labels = { checking: '正在检查更新…', available: `发现新版本${latest}，可点击检查更新进行升级。`, downloading: `正在下载新版本${latest}…`, ready: `新版本${latest}的签名和文件已校验，正在准备更新。`, installing: '本地记录已备份，退出后将备份并替换程序文件，完成后自动重启。', error: '更新失败，请点击检查更新重试。' };
    let text = labels[update.phase] || (update.available === false && !!update.message ? `当前已是最新版本${latest}。` : '可随时检查更新，无需登录 GitHub。');
    if (update.phase === 'checking' || update.phase === 'available' || update.phase === 'downloading' || update.phase === 'ready' || update.phase === 'installing' || update.phase === 'error' || update.available === false) {
      if (update.message) text += ` ${update.message}`;
    }
    const progress = $('#update-progress');
    progress.hidden = update.phase !== 'downloading';
    const percent = typeof update.percent === 'number' && Number.isFinite(update.percent) ? update.percent : typeof update.total === 'number' && update.total > 0 && Number.isFinite(update.downloaded) ? update.downloaded / update.total * 100 : null;
    if (percent === null) progress.removeAttribute('value'); else { progress.value = Math.min(100, Math.max(0, percent)); if (!progress.hidden) text += ` ${Math.round(progress.value)}%`; }
    if (!progress.hidden && Number.isFinite(update.downloaded) && Number.isFinite(update.total) && update.total > 0) text += `（${(update.downloaded / 1048576).toFixed(1)} / ${(update.total / 1048576).toFixed(1)} MB）`;
    $('#update-status').textContent = text;
    $('#update-status').classList.toggle('update-error', update.phase === 'error');
    $('#check-update-button').textContent = updateReady && update.phase === 'error' ? '重试安装' : '检查更新';
  }
  function receiveUpdate(update) {
    if (!update || typeof update !== 'object') return;
    // Clear stale progress and errors when a fresh check starts.
    s.update = update.phase === 'checking' ? { ...update } : { ...s.update, ...update };
    renderUpdate();
  }
  async function saveBeforeUpdate() {
    clearTimeout(draftTimer);
    try { await localWrite; } catch (error) { localWrite = Promise.resolve(); throw new Error(`本地数据尚未保存，更新已停止：${errorMessage(error)}`); }
    try { if (s.editor) await saveDraft(true); else await persistLocal(); }
    catch (error) { localWrite = Promise.resolve(); throw error; }
  }
  async function checkForUpdates() {
    if (s.busy || updateRunning) return;
    if (demo) { receiveUpdate({ phase: 'error', message: '浏览器预览不连接更新服务，请在桌面客户端检查更新。' }); return; }
    updateRunning = true; setBusy(true);
    let installing = false;
    try {
      if (!updateReady) {
        receiveUpdate({ phase: 'checking' });
        const checked = await call('checkForUpdates');
        if (!checked || checked.phase === 'error') throw new Error(checked?.message || '检查更新失败');
        receiveUpdate(checked);
        if (!checked.available) return;
        if (s.updateCapability?.supported === false) { receiveUpdate({ ...checked, message: s.updateCapability.reason }); toast(s.updateCapability.reason); return; }
        await saveBeforeUpdate();
        receiveUpdate({ phase: 'downloading', percent: 0, downloaded: 0, total: 0 });
        const downloaded = await call('downloadUpdate');
        if (downloaded?.phase !== 'ready') throw new Error(downloaded?.message || '下载未完成或安装包未通过校验');
        updateReady = true; receiveUpdate(downloaded);
      }
      await saveBeforeUpdate();
      const result = await call('installUpdate');
      if (result?.installing !== true) throw new Error(result?.message || '安装程序未能启动');
      installing = true; receiveUpdate({ phase: 'installing' });
    } catch (error) { receiveUpdate({ phase: 'error', message: errorMessage(error) }); }
    finally { if (!installing) { setBusy(false); updateRunning = false; } }
  }
  if (typeof bridge?.onUpdateProgress === 'function') bridge.onUpdateProgress(update => {
    // Backend errors may invalidate the verified package; require a fresh check/download.
    if (update?.phase === 'error') updateReady = false;
    receiveUpdate(update);
  });
  $('#check-update-button').addEventListener('click', checkForUpdates);
  let startupUpdatePending = null;
  function showStartupUpdate() {
    if (!startupUpdatePending || s.busy || updateRunning || document.querySelector('dialog[open]')) return;
    $('#startup-update-version').textContent = startupUpdatePending.latestVersion || startupUpdatePending.version;
    startupUpdatePending = null;
    $('#startup-update-dialog').showModal();
  }
  async function checkStartupUpdates() {
    if (demo || typeof bridge?.checkStartupUpdates !== 'function') return;
    try {
      const result = await call('checkStartupUpdates');
      if (!result?.available || result.phase !== 'available') return;
      startupUpdatePending = result;
      showStartupUpdate();
    } catch { /* Startup discovery stays quiet when offline. */ }
  }
  function dismissStartupUpdate() { startupUpdatePending = null; $('#startup-update-dialog').close(); }
  $('#startup-update-close').addEventListener('click', dismissStartupUpdate);
  $('#startup-update-later').addEventListener('click', dismissStartupUpdate);
  $('#startup-update-dialog').addEventListener('click', event => { if (event.target !== event.currentTarget) return; const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dismissStartupUpdate(); });
  $('#startup-update-now').addEventListener('click', () => { dismissStartupUpdate(); renderAccount(); $('#account-dialog').showModal(); void checkForUpdates(); });
  $$('dialog').forEach(dialog => dialog.addEventListener('close', showStartupUpdate));
  function renderAccount() {
    renderUpdate();
    const box = $('#account-details'); box.replaceChildren();
    for (const [label, value] of [['姓名', s.account?.name || '未设置'], ['GitHub 登录名', s.account?.login || '未登录'], ['GitHub ID', s.account?.id ?? '未登录'], ['当前仓库', repo() || '未配置'], ['权限', s.account ? s.permissions.admin ? '管理员 · 可直接维护自己的题解' : s.permissions.push ? '可推送 · 可直接维护自己的题解' : '只读 · 可使用本地记录' : '未登录 · 仅本地编辑']]) append(box, element('dt', '', label), element('dd', '', value));
    const authLabel = { anonymous: '未登录', restored: '已恢复，等待验证', verified: '已验证', expired: '授权已过期，请重新登录', unverified: '尚未验证，请联网刷新', 'recovery-required': '凭证恢复失败，请重新授权' }[s.authStatus?.status];
    if (authLabel) append(box, element('dt', '', '认证状态'), element('dd', '', authLabel));
    $('#account-login').textContent = ['expired','recovery-required'].includes(s.authStatus?.status) ? '重新授权 GitHub' : '登录 GitHub';
    $('#account-login').hidden = !!s.account && !['expired','recovery-required'].includes(s.authStatus?.status); ['account-switch', 'account-logout', 'account-refresh'].forEach(id => { document.getElementById(id).hidden = !s.account; });
  }
  $('#account-button').addEventListener('click', () => { if (s.busy) return; if ($('#submit-dialog').open) { toast('请先完成或关闭编辑，草稿不会跨账户恢复'); return; } renderAccount(); $('#account-error').hidden = true; $('#account-dialog').showModal(); });
  async function accountAction(action) {
    if (s.busy) return;
    if (demo) { $('#account-error').hidden = false; $('#account-error').textContent = '浏览器演示不连接 GitHub，账户功能请在桌面客户端使用'; return; }
    setBusy(true); $('#account-error').hidden = true;
    try {
      if (action === 'refresh') applyPayload(await call('refreshAccount'));
      else {
        if (action === 'logout' || action === 'switch') await call('logout');
        if (action === 'login' || action === 'switch') { $('#auth-message').textContent = '正在请求设备授权…'; $('#auth-code').textContent = ''; $('#auth-open-button').hidden = true; $('#auth-dialog').showModal(); await call('login'); }
        applyPayload(await call('bootstrap'));
      }
      s.comments.clear(); refreshFilters(); render(); renderAccount(); toast('账户与仓库权限已更新');
    } catch (error) { $('#account-error').hidden = false; $('#account-error').textContent = errorMessage(error); try { applyPayload(await call('bootstrap')); refreshFilters(); render(); renderAccount(); } catch (_) {} }
    finally { $('#auth-dialog').close(); setBusy(false); }
  }
  ['login', 'logout', 'switch', 'refresh'].forEach(action => { document.getElementById(`account-${action}`).addEventListener('click', () => accountAction(action)); });
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
      if (url.hostname.endsWith('codeforces.com') && (match = url.pathname.match(/(?:problemset\/problem\/(\d+)\/([A-Za-z0-9]+)|contest\/(\d+)\/problem\/([A-Za-z0-9]+))/))) { setEditorPlatform('CF'); form.elements.pid.value = `CF${match[1] || match[3]}${(match[2] || match[4]).toUpperCase()}`; }
      else if (url.hostname.endsWith('atcoder.jp') && (match = url.pathname.match(/\/tasks\/([^/]+)/))) { setEditorPlatform('AT'); form.elements.pid.value = match[1]; }
      else if (url.hostname.endsWith('luogu.com.cn') && (match = url.pathname.match(/\/problem\/([^/]+)/))) { setEditorPlatform('LG'); form.elements.pid.value = match[1]; }
      else if (url.hostname.endsWith('nowcoder.com')) { setEditorPlatform('NC'); if ((match = url.pathname.match(/\/acm\/problem\/(\d+)/))) form.elements.pid.value = match[1]; }
    } catch (_) { /* Validation is shown when saving. */ }
  });
  window.addEventListener('online', updateStatus); window.addEventListener('offline', updateStatus);
  document.addEventListener('keydown', event => { if (event.key === '/' && !event.ctrlKey && !event.metaKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) && !document.querySelector('dialog[open]')) { event.preventDefault(); if (s.view === 'stats') { s.view = 'public'; render(); } $('#search-input').focus(); } });
  async function bootstrap() {
    applyTheme(readTheme()); render();
    if (demo) { s.permissions = { repo: 'qmx-acm-data/2026', push: false, admin: false }; s.records = examples.filter(record => record.kind === 'document').map(record => ({ ...record, repo: s.permissions.repo })); s.issues = examples.filter(record => record.kind === 'issue').map(record => ({ ...record, repo: s.permissions.repo })); s.local = normalizeLocal(cached?.local || { records: [examples[2]], favorites: [key(examples[1])], mastery: { [key(examples[1])]: 'reviewing' }, draft: {} }); s.local.records = s.local.records.map(record => record.id === 'demo-local-3' && record.pid === 'dp_f' && record.rating == null ? { ...examples[2] } : record); s.settings = cached?.settings || {}; applyTheme(s.settings.theme || readTheme()); }
    else { try { applyPayload(await call('bootstrap')); } catch (error) { s.error = errorMessage(error); } }
    if (!demo && !s.catalogFromPayload && typeof bridge?.getTagCatalog === 'function') { try { const catalog = await call('getTagCatalog'); if (Array.isArray(catalog?.categories)) s.tagCatalog = catalog; } catch (_) { /* Presets remain available offline. */ } }
    s.loading = false; refreshFilters(); render();
    void checkStartupUpdates();
    if (!demo && !s.error && s.settings.autoSync !== false && navigator.onLine) await sync();
  }
  bootstrap();
})();
