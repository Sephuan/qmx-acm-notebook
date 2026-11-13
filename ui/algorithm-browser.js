/* Algorithm directory and note reader. No source tree or note is modified. */
(function (global) {
  'use strict';

  const LEVELS = [
    { id: 'basic', label: '入门', tone: 'cyan', number: '01' },
    { id: 'beginner', label: '初级', tone: 'green', number: '02' },
    { id: 'intermediate', label: '中级', tone: 'blue', number: '03' },
    { id: 'advanced', label: '高级', tone: 'orange', number: '04' },
    { id: 'expert', label: '挑战', tone: 'red', number: '05' }
  ];
  const ATTRIBUTES = { board: '模板', useful: '常用', useless: '低频' };
  const state = {
    search: '', level: '', attribute: '', draftSearch: '', draftLevel: '', draftAttribute: '', selectedNode: null,
    expanded: new Set(), scope: 'public', initialized: false,
    reading: null, listScroll: 0, paneScroll: 0, treeScroll: 0
  };
  let active = null;
  let instanceId = 0;

  function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = String(text);
    return el;
  }
  function button(text, className, action) {
    const el = element('button', className, text);
    el.type = 'button';
    el.addEventListener('click', action);
    return el;
  }
  function isDirectory(node) { return node.kind === 'directory' || node.kind === 'category' || node.color === 'parent'; }
  function levelOf(node) { return isDirectory(node) ? undefined : LEVELS.find(level => level.id === node.color); }
  function attributesOf(node) {
    return [...new Set([...(Array.isArray(node.attributes) ? node.attributes : []), ...(ATTRIBUTES[node.color] ? [node.color] : [])])].filter(key => ATTRIBUTES[key]);
  }
  function tagsOf(note) { return Array.isArray(note.tags) ? note.tags.map(String) : []; }
  function noteKey(note) { return String(note.path || note.id || note.clientId || `${note.nodeId}:${note.title}:${note.authorId}`); }
  function excerpt(body) {
    return String(body || '').replace(/```[\s\S]*?```/g, ' [代码] ').replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/<[^>]*>/g, '').replace(/[#*_`>~|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 150);
  }
  function snapshot() {
    return { search: state.search, level: state.level, attribute: state.attribute, draftSearch: state.draftSearch, draftLevel: state.draftLevel, selectedNode: state.selectedNode,
      expanded: Array.from(state.expanded), scope: state.scope };
  }

  function render(options) {
    if (!options || !options.host || !options.tree) throw new TypeError('NotebookAlgorithms.render requires host and tree.');
    if (active) active.destroy();
    const opts = options;
    const host = opts.host;
    const root = opts.tree;
    const byId = new Map();
    const all = [];
    function index(node, parent, depth, path) {
      const entry = { node, parent, depth, path: path.concat(String(node.label || '未命名节点')), descendants: 0 };
      byId.set(node.id, entry);
      (node.legacyIds || []).forEach(id => { if (!byId.has(id)) byId.set(id, entry); });
      all.push(entry);
      (node.children || []).forEach(child => { index(child, node.id, depth + 1, entry.path); entry.descendants += 1 + byId.get(child.id).descendants; });
    }
    index(root, null, 0, []);
    if (!state.initialized) { state.expanded.add(root.id); state.initialized = true; }
    state.selectedNode = byId.get(state.selectedNode)?.node.id || root.id;
    const nextScope = opts.scope === 'personal' ? 'personal' : opts.scope === 'public' ? 'public' : state.scope;
    if (nextScope !== state.scope) { state.reading = null; state.paneScroll = 0; }
    state.scope = nextScope;
    const accountId = opts.account && opts.account.id;
    const notes = (Array.isArray(opts.notes) ? opts.notes : []).filter(note => state.scope === 'personal'
      ? note.noteScope === 'personal' && accountId != null && String(note.authorId) === String(accountId)
      : note.noteScope === 'public').map(note => {
        const canonicalId = byId.get(note.nodeId)?.node.id;
        return canonicalId && canonicalId !== note.nodeId ? { ...note, nodeId: canonicalId } : note;
      });
    const nameOf = author => {
      try { return String(opts.authorName ? opts.authorName(author) : (author && (author.name || author.login)) || author || '匿名作者'); }
      catch (_) { return '未知作者'; }
    };
    const dateOf = value => {
      try { return opts.formatDate ? opts.formatDate(value) : (value ? new Date(value).toLocaleDateString('zh-CN') : ''); }
      catch (_) { return ''; }
    };
    const sortedNotes = notes.slice().sort((a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)) || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
    const counts = new Map(all.map(entry => [entry.node.id, 0]));
    notes.forEach(note => {
      let entry = byId.get(note.nodeId);
      while (entry) { counts.set(entry.node.id, counts.get(entry.node.id) + 1); entry = byId.get(entry.parent); }
    });
    function expandAncestors(id) {
      let entry = byId.get(id);
      while (entry && entry.parent != null) { state.expanded.add(entry.parent); entry = byId.get(entry.parent); }
    }
    expandAncestors(state.selectedNode);
    if (state.reading && !notes.some(note => noteKey(note) === state.reading)) state.reading = null;

    const shell = element('section', 'alg-browser');
    shell.setAttribute('aria-label', '算法知识与笔记浏览器');
    const uid = `alg-browser-${++instanceId}`;
    const top = element('header', 'alg-toolbar');
    const brand = element('div', 'alg-brand');
    brand.append(element('span', 'alg-eyebrow', 'KNOWLEDGE EXPLORER'), element('h2', 'alg-title', '算法知识库'));
    const scopeSwitch = element('div', 'alg-scope');
    scopeSwitch.setAttribute('role', 'group'); scopeSwitch.setAttribute('aria-label', '笔记范围');
    ['public', 'personal'].forEach(scope => {
      const control = button(scope === 'public' ? '公开笔记' : '我的笔记', 'alg-scope-button', () => {
        if (scope === state.scope) return;
        if (typeof opts.onScopeChange === 'function') opts.onScopeChange(scope);
        else if (scope !== 'personal' || opts.account) { state.scope = scope; state.reading = null; render({ ...opts, scope }); }
      });
      control.setAttribute('aria-pressed', String(scope === state.scope)); scopeSwitch.append(control);
    });
    const uploadWrap = element('div', 'alg-upload-wrap');
    const upload = button('＋ 上传笔记', 'alg-button alg-button-primary', () => {
      if (!opts.canUpload || !opts.account || typeof opts.onUpload !== 'function') return;
      if (typeof opts.onSelect === 'function') opts.onSelect(state.selectedNode);
      opts.onUpload(state.selectedNode);
    });
    upload.disabled = !opts.canUpload || !opts.account || typeof opts.onUpload !== 'function';
    upload.id = 'algorithm-upload-button';
    uploadWrap.append(upload);
    if (upload.disabled) {
      const explanation = element('span', 'alg-upload-hint', opts.account ? '需要仓库写入权限才能上传' : '登录具有写入权限的账户后可上传');
      explanation.id = `${uid}-upload-hint`; upload.setAttribute('aria-describedby', explanation.id); uploadWrap.append(explanation);
    }
    top.append(brand, scopeSwitch, uploadWrap);

    const filters = element('section', 'alg-filters'); filters.setAttribute('aria-label', '检索与筛选');
    const searchRow = element('div', 'alg-search-row');
    const searchWrap = element('label', 'alg-search-wrap');
    const searchIcon = element('span', 'alg-search-icon', '⌕'); searchIcon.setAttribute('aria-hidden', 'true');
    const search = element('input', 'alg-search'); search.type = 'search'; search.value = state.draftSearch;
    search.placeholder = '搜索算法、路径、笔记标题、标签或作者'; search.setAttribute('aria-label', '搜索算法、路径、笔记标题、标签或作者');
    searchWrap.append(searchIcon, search);
    const attributeLabel = element('label', 'alg-attribute-label', '属性');
    const attribute = element('select', 'alg-attribute'); attribute.setAttribute('aria-label', '按类型或使用频率筛选');
    [['', '全部属性'], ...Object.entries(ATTRIBUTES)].forEach(([value, label]) => {
      const option = element('option', '', label); option.value = value; attribute.append(option);
    });
    attribute.value = state.draftAttribute; attributeLabel.append(attribute);
    const submitSearch = button('搜索', 'alg-button alg-button-primary alg-search-submit', applySearch);
    const clear = button('清除筛选', 'alg-text-button alg-clear', () => {
      state.search = ''; state.level = ''; state.attribute = ''; state.draftSearch = ''; state.draftLevel = ''; state.draftAttribute = ''; state.reading = null;
      search.value = ''; attribute.value = ''; refresh(); search.focus();
    });
    searchRow.append(searchWrap, submitSearch, attributeLabel, clear);
    const legend = element('div', 'alg-legend'); legend.setAttribute('role', 'group'); legend.setAttribute('aria-label', '学习参考难度筛选');
    const legendButtons = [];
    const levelCounts = new Map([...LEVELS.map(level => [level.id, 0]), ['unrated', 0]]);
    all.forEach(entry => { if (isDirectory(entry.node)) return; const level = levelOf(entry.node); const key = level ? level.id : 'unrated'; levelCounts.set(key, levelCounts.get(key) + 1); });
    const allLevel = button(`全部 ${all.length}`, 'alg-legend-button alg-tone-neutral', () => { state.draftLevel = ''; updateDraftControls(); });
    allLevel.dataset.level = ''; legendButtons.push(allLevel); legend.append(allLevel);
    [...LEVELS, ...(levelCounts.get('unrated') ? [{ id: 'unrated', label: '未分级', tone: 'neutral', number: '—' }] : [])].forEach(level => {
      const control = button('', `alg-legend-button alg-tone-${level.tone}`, () => { state.draftLevel = state.draftLevel === level.id ? '' : level.id; updateDraftControls(); });
      control.dataset.level = level.id;
      control.append(element('span', 'alg-legend-dot'), element('span', '', `${level.number} ${level.label}`), element('span', 'alg-legend-count', levelCounts.get(level.id)));
      control.title = `${level.label}：${levelCounts.get(level.id)} 个节点；点击筛选，再次点击取消`;
      legendButtons.push(control); legend.append(control);
    });
    const searchHint = element('p', 'alg-tier-hint alg-search-hint');
    searchHint.append(element('strong', '', '点击搜索按钮才会进行跳转哦，也可以按回车确认。'));
    searchHint.id = `${uid}-search-hint`; search.setAttribute('aria-describedby', searchHint.id);
    filters.append(searchRow, searchHint, legend, element('p', 'alg-tier-hint', '目录用于组织知识和保存说明，不设难度。难度筛选只匹配具体算法与知识点，并保留其上级目录。模板、常用、低频是独立属性。'));

    const workspace = element('div', 'alg-workspace');
    const sidebar = element('aside', 'alg-sidebar');
    const treeHeading = element('div', 'alg-tree-heading');
    const treeStatus = element('span', 'alg-tree-status');
    treeHeading.append(element('strong', '', '知识目录'), treeStatus);
    const treeScroller = element('div', 'alg-tree-scroll');
    const tree = element('div', 'alg-tree'); tree.setAttribute('role', 'tree'); tree.setAttribute('aria-label', '算法知识目录');
    tree.setAttribute('aria-describedby', `${uid}-tree-help`);
    treeScroller.append(tree);
    const treeHelp = element('p', 'alg-tree-help', '↑ ↓ 移动 · ← → 折叠 / 展开 · Enter 查看'); treeHelp.id = `${uid}-tree-help`;
    sidebar.append(treeHeading, treeScroller, treeHelp);
    const pane = element('section', 'alg-pane'); pane.setAttribute('aria-label', '算法与笔记详情');
    pane.tabIndex = -1;
    const live = element('span', 'alg-sr-only'); live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite');
    workspace.append(sidebar, pane); shell.append(top, filters, workspace, live);
    host.replaceChildren(shell);

    let visible = [];
    let included = new Set();
    let matched = new Set();
    let matchingNotes = [];
    let focusedId = state.selectedNode;
    let disposed = false, expandedReader = null;
    function detailPath() {
      const reading = state.reading && notes.find(note => noteKey(note) === state.reading);
      const entries = []; let entry = byId.get(reading?.nodeId || state.selectedNode);
      while (entry) { entries.unshift(entry); entry = byId.get(entry.parent); }
      const result = [{ label: '知识树', onClick() { expandedReader?.close(); } }, ...entries.map(item => ({ label: item.node.label, onClick() { selectNode(item.node.id); } }))];
      if (reading) result.push({ label: reading.title || '未命名笔记' });
      return result;
    }
    function openDetail() {
      expandedReader = global.NotebookReadingDetail?.open({ content: pane, mount: host, title: state.reading ? '算法笔记详情' : '知识节点详情', path: detailPath(), onClose() { expandedReader = null; } });
    }
    let filtering = false;
    function badge(node) {
      if (isDirectory(node)) { const directory = element('span', 'alg-node-kind', '目录'); directory.title = '目录可保存说明和笔记，具体算法在子节点中分级'; return directory; }
      const level = levelOf(node);
      const el = element('span', `alg-badge alg-tone-${level ? level.tone : 'neutral'}`, level ? level.label : node.color === 'parent' ? '目录' : '未分级');
      const origin = node.difficultySource?.kind === 'user-md' ? '用户颜色文档' : node.rating?.type === 'category' ? '分类基础门槛' : node.rating?.type === 'entry' ? '入口或任务形式' : '本项目逐项定稿';
      const range = node.rating?.range;
      const coverage = range && node.children?.length ? `；覆盖 D${range.min}–D${range.max}` : '';
      el.title = level ? `学习难度：${level.label}；依据：${origin}${coverage}${node.scope ? `。学习范围：${node.scope}` : ''}${node.rationale ? `。${node.rationale}` : ''}` : node.color === 'parent' ? '目录' : '未指定难度';
      return el;
    }
    function attributeBadge(node) {
      const names = attributesOf(node).map(key => ATTRIBUTES[key]);
      return names.length ? element('span', 'alg-attribute-badge', names.join(' · ')) : null;
    }
    function pathOf(id) { return byId.get(id)?.path.join(' / ') || '未关联目录'; }
    function matchesFacets(node) {
      const level = levelOf(node);
      return (!state.level || (!isDirectory(node) && (state.level === 'unrated' ? !level : node.color === state.level))) && (!state.attribute || attributesOf(node).includes(state.attribute));
    }
    const relevance = global.NotebookAlgorithmDirectory;
    const topicScores = new Map();
    function computeResults() {
      const q = state.search.trim();
      topicScores.clear();
      filtering = Boolean(q || state.level || state.attribute);
      matchingNotes = sortedNotes.filter(note => {
        const entry = byId.get(note.nodeId);
        if ((state.level || state.attribute) && (!entry || !matchesFacets(entry.node))) return false;
        return relevance.noteScore(note, entry?.node, entry?.path || [], q, nameOf(note.author)) > 0;
      }).sort((a, b) => {
        if (!q) return 0;
        const ae = byId.get(a.nodeId), be = byId.get(b.nodeId);
        return relevance.noteScore(b, be?.node, be?.path || [], q, nameOf(b.author)) - relevance.noteScore(a, ae?.node, ae?.path || [], q, nameOf(a.author));
      });
      const noteNodes = new Set(matchingNotes.map(note => note.nodeId));
      matched = new Set(); included = new Set();
      all.forEach(entry => {
        const score = relevance.topicScore(entry.node, entry.path, q);
        topicScores.set(entry.node.id, score);
        if (!filtering || (matchesFacets(entry.node) && (score > 0 || noteNodes.has(entry.node.id)))) matched.add(entry.node.id);
      });
      matched.forEach(id => {
        let entry = byId.get(id);
        while (entry) { included.add(entry.node.id); entry = byId.get(entry.parent); }
      });
    }
    function selectNode(id, focusPane) {
      if (!byId.has(id)) return;
      expandedReader?.close();
      state.selectedNode = id; state.reading = null; state.listScroll = 0; state.paneScroll = 0;
      focusedId = id; expandAncestors(id);
      const oldScroll = treeScroller.scrollTop;
      renderTree(); treeScroller.scrollTop = oldScroll; renderPane(); pane.scrollTop = 0;
      if (typeof opts.onSelect === 'function') opts.onSelect(id);
      if (focusPane) pane.focus({ preventScroll: true });
    }
    function focusRow(id) {
      focusedId = id;
      tree.querySelectorAll('[role="treeitem"]').forEach(row => { row.tabIndex = row.dataset.nodeId === id ? 0 : -1; });
      const target = Array.from(tree.querySelectorAll('[role="treeitem"]')).find(row => row.dataset.nodeId === id);
      if (target) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
    }
    function isExpanded(id) { return filtering ? included.has(id) && !state.expanded.has(`collapsed-filter:${id}`) : state.expanded.has(id); }
    function toggle(id, expanded) {
      if (filtering) {
        const key = `collapsed-filter:${id}`;
        if (expanded) state.expanded.delete(key); else state.expanded.add(key);
      } else if (expanded) state.expanded.add(id); else state.expanded.delete(id);
      const oldScroll = treeScroller.scrollTop; renderTree(); treeScroller.scrollTop = oldScroll; focusRow(id);
    }
    function renderTree() {
      tree.replaceChildren(); visible = [];
      const hasResults = included.size > 0;
      if (!hasResults) {
        tree.append(element('p', 'alg-tree-empty', '没有匹配的目录或笔记。试试更短的关键词，或清除筛选。'));
      } else {
        function walk(entry, group, position, size) {
          if (!included.has(entry.node.id)) return;
          const kids = (entry.node.children || []).filter(child => included.has(child.id));
          const item = element('div', 'alg-tree-item'); item.setAttribute('role', 'treeitem');
          item.dataset.nodeId = entry.node.id;
          item.dataset.depth = String(entry.depth);
          item.dataset.kind = entry.node.color === 'parent' ? 'directory' : 'topic';
          item.setAttribute('aria-level', String(entry.depth + 1));
          item.setAttribute('aria-posinset', String(position)); item.setAttribute('aria-setsize', String(size));
          item.setAttribute('aria-selected', String(state.selectedNode === entry.node.id));
          item.setAttribute('aria-label', `${entry.node.label}，${levelOf(entry.node)?.label || (entry.node.color === 'parent' ? '目录' : '未分级')}${attributesOf(entry.node).length ? `，${attributesOf(entry.node).map(key => ATTRIBUTES[key]).join('、')}` : ''}，${counts.get(entry.node.id)} 篇笔记`);
          item.tabIndex = -1;
          if (kids.length) item.setAttribute('aria-expanded', String(isExpanded(entry.node.id)));
          const row = element('div', 'alg-tree-row'); row.style.setProperty('--alg-depth', String(entry.depth));
          if (kids.length) {
            const disclosure = button(isExpanded(entry.node.id) ? '▾' : '▸', 'alg-disclosure', event => { event.stopPropagation(); toggle(entry.node.id, !isExpanded(entry.node.id)); });
            disclosure.tabIndex = -1; disclosure.setAttribute('aria-label', `${isExpanded(entry.node.id) ? '折叠' : '展开'} ${entry.node.label}`); row.append(disclosure);
          } else { const spacer = element('span', 'alg-disclosure alg-leaf', '·'); spacer.setAttribute('aria-hidden', 'true'); row.append(spacer); }
          const copy = element('span', 'alg-tree-copy'); copy.append(element('span', 'alg-tree-label', entry.node.label));
          const metadata = element('span', 'alg-tree-meta'); metadata.append(badge(entry.node));
          const attr = attributeBadge(entry.node); if (attr) metadata.append(attr);
          copy.append(metadata); row.append(copy);
          const count = element('span', 'alg-node-count', counts.get(entry.node.id)); count.title = '当前范围内含子目录的笔记总数'; row.append(count);
          row.title = `${entry.path.join(' / ')}${entry.node.fullLabel && entry.node.fullLabel !== entry.node.label ? `\n${entry.node.fullLabel}` : ''}`;
           if (opts.canManage && typeof opts.onAddTopic === 'function') {
             const add = button('＋', 'alg-add-topic', event => { event.stopPropagation(); opts.onAddTopic(entry.node.id); });
             add.title = `在“${entry.node.label}”下添加算法`; add.setAttribute('aria-label', add.title); row.append(add);
           }
          row.addEventListener('click', () => { selectNode(entry.node.id); focusRow(entry.node.id); });
          item.addEventListener('focus', event => { if (event.target === item) { focusedId = entry.node.id; } });
          item.append(row); group.append(item); visible.push(entry);
          if (kids.length && isExpanded(entry.node.id)) {
            const childGroup = element('div', 'alg-tree-group'); childGroup.setAttribute('role', 'group'); item.append(childGroup);
            kids.forEach((child, i) => walk(byId.get(child.id), childGroup, i + 1, kids.length));
          }
        }
        walk(byId.get(root.id), tree, 1, 1);
      }
      if (!visible.some(entry => entry.node.id === focusedId)) focusedId = visible.some(entry => entry.node.id === state.selectedNode) ? state.selectedNode : visible[0]?.node.id;
      tree.querySelectorAll('[role="treeitem"]').forEach(row => { row.tabIndex = row.dataset.nodeId === focusedId ? 0 : -1; });
      treeStatus.textContent = filtering ? `${matched.size} 个匹配` : `${all.length} 个节点`;
    }
    tree.addEventListener('keydown', event => {
      if (event.target.closest('.alg-add-topic')) return;
      const item = event.target.closest('[role="treeitem"]'); if (!item) return;
      const id = item.dataset.nodeId; const entry = byId.get(id); const i = visible.findIndex(value => value.node.id === id);
      let next = null;
      if (event.key === 'ArrowDown') next = visible[Math.min(i + 1, visible.length - 1)]?.node.id;
      else if (event.key === 'ArrowUp') next = visible[Math.max(i - 1, 0)]?.node.id;
      else if (event.key === 'Home') next = visible[0]?.node.id;
      else if (event.key === 'End') next = visible[visible.length - 1]?.node.id;
      else if (event.key === 'ArrowRight') {
        if (item.hasAttribute('aria-expanded')) { if (!isExpanded(id)) toggle(id, true); else next = visible[i + 1]?.node.id; }
      } else if (event.key === 'ArrowLeft') {
        if (item.getAttribute('aria-expanded') === 'true') toggle(id, false); else next = entry.parent;
      } else if (event.key === 'Enter' || event.key === ' ') { selectNode(id); focusRow(id); }
      else return;
      event.preventDefault(); event.stopPropagation(); if (next != null) focusRow(next);
    });

    function breadcrumbs(id) {
      const nav = element('nav', 'alg-breadcrumbs'); nav.setAttribute('aria-label', '当前算法路径');
      const ancestors = []; let entry = byId.get(id);
      while (entry) { ancestors.unshift(entry); entry = byId.get(entry.parent); }
      ancestors.forEach((ancestor, i) => {
        if (i) { const separator = element('span', 'alg-crumb-separator', '/'); separator.setAttribute('aria-hidden', 'true'); nav.append(separator); }
        const crumb = button(ancestor.node.label, 'alg-crumb', () => selectNode(ancestor.node.id));
        if (i === ancestors.length - 1) crumb.setAttribute('aria-current', 'page'); nav.append(crumb);
      }); return nav;
    }
    function noteMetadata(note) {
      const meta = element('div', 'alg-note-meta');
      if (note.featured) meta.append(element('span', 'alg-featured', '精选'));
      meta.append(element('span', 'alg-note-author', nameOf(note.author)));
      const date = dateOf(note.updatedAt || note.createdAt); if (date) meta.append(element('span', '', date));
      return meta;
    }
    function noteTags(note) {
      const tags = element('div', 'alg-note-tags'); tagsOf(note).forEach(tag => tags.append(element('span', 'alg-tag', tag))); return tags;
    }
    function openNote(note) {
      state.listScroll = pane.scrollTop; state.reading = noteKey(note); state.paneScroll = 0;
      renderPane(); pane.scrollTop = 0;
      pane.querySelector('.alg-reading-title')?.focus({ preventScroll: true });
    }
    function noteCard(note, globalResult) {
      const card = button('', `alg-note-card${note.featured ? ' alg-note-featured' : ''}`, () => openNote(note));
      card.append(noteMetadata(note), element('h4', 'alg-note-title', note.title || '未命名笔记'));
      const preview = excerpt(note.body); if (preview) card.append(element('p', 'alg-note-excerpt', preview));
      card.append(noteTags(note));
      if (globalResult) card.append(element('span', 'alg-note-path', pathOf(note.nodeId)));
      return card;
    }
    function heading(title, count) {
      const row = element('div', 'alg-section-heading'); row.append(element('h3', '', title));
      if (count !== undefined) row.append(element('span', 'alg-section-count', count)); return row;
    }
    function topicCard(entry) {
      const card = button('', 'alg-topic-card', () => selectNode(entry.node.id));
      const name = element('div', 'alg-topic-name'); name.append(element('strong', '', entry.node.label), element('span', 'alg-card-arrow', '↗'));
      const meta = element('div', 'alg-topic-meta'); meta.append(badge(entry.node)); const attr = attributeBadge(entry.node); if (attr) meta.append(attr);
      card.append(name, meta, element('span', 'alg-topic-count', `${entry.descendants} 个子节点 · ${counts.get(entry.node.id)} 篇笔记`));
      return card;
    }
    function renderPane() {
      expandedReader?.setPath(detailPath());
      pane.replaceChildren();
      const selected = byId.get(state.selectedNode);
      const reading = state.reading && notes.find(note => noteKey(note) === state.reading);
      if (reading) {
        const back = button('← 返回目录与笔记', 'alg-text-button alg-reader-back', () => {
          state.reading = null; renderPane(); pane.scrollTop = state.listScroll;
          pane.querySelector('.alg-detail-title')?.focus({ preventScroll: true });
        });
        const actions = element('div', 'reading-detail-actions');
        actions.append(back, button('打开详情 ↗', 'alg-button reading-detail-trigger alg-open-detail', openDetail));
        pane.append(actions, breadcrumbs(reading.nodeId));
        const article = element('article', 'alg-reading');
        const title = element('h2', 'alg-reading-title', reading.title || '未命名笔记'); title.tabIndex = -1;
        article.append(title, noteMetadata(reading), noteTags(reading));
        const body = element('div', 'alg-markdown markdown-body');
        if (typeof opts.renderMarkdown === 'function') opts.renderMarkdown(body, String(reading.body || ''));
        else body.textContent = String(reading.body || '');
        article.append(body);
        if (byId.has(reading.nodeId)) article.append(button(`在目录中查看：${byId.get(reading.nodeId).node.label}`, 'alg-text-button alg-note-location', () => selectNode(reading.nodeId)));
        pane.append(article); return;
      }
      pane.append(breadcrumbs(selected.node.id));
      const detail = element('header', 'alg-detail-heading');
      const detailBar = element('div', 'alg-detail-toolbar');
      detailBar.append(element('span', 'alg-eyebrow', selected.node.id === root.id ? '知识目录' : '知识节点'), button('打开详情 ↗', 'alg-button reading-detail-trigger alg-open-detail', openDetail));
      detail.append(detailBar);
      const titleRow = element('div', 'alg-detail-title-row');
      const title = element('h2', 'alg-detail-title', selected.node.fullLabel || selected.node.label); title.tabIndex = -1;
      titleRow.append(title, badge(selected.node)); const attr = attributeBadge(selected.node); if (attr) titleRow.append(attr);
      detail.append(titleRow, element('p', 'alg-detail-stats', `${selected.descendants} 个子节点 · ${counts.get(selected.node.id)} 篇笔记（含子目录）`));
      const information = element('section', 'alg-node-information');
      if (selected.node.id === root.id) information.append(element('p', 'alg-intro', '从一条知识主线出发，逐步建立你的算法体系。展开左侧目录，或选择下方分类；每个节点都可以阅读和积累学习笔记。'));
      if (isDirectory(selected.node)) information.append(element('p', 'alg-intro', selected.node.scope || '此目录用于分类、专题说明和学习笔记，具体算法及难度请查看子节点。'));
      if (levelOf(selected.node) && selected.node.difficultySource) {
        const origin = selected.node.difficultySource.kind === 'user-md' ? '难度依据：用户颜色文档' : selected.node.rating?.type === 'category' ? '难度依据：分类基础学习门槛' : selected.node.rating?.type === 'entry' ? '难度依据：入口或任务形式的使用门槛' : '难度依据：本项目逐项定稿';
        const range = selected.node.rating?.range;
        information.append(element('p', 'alg-intro', `${origin}${range && selected.node.children?.length ? `；覆盖 D${range.min}–D${range.max}` : ''}${selected.node.rationale ? `。${selected.node.rationale}` : ''}${selected.node.scope ? ` 学习范围：${selected.node.scope}` : ''}`));
      }
      const utilities = element('footer', 'alg-detail-utilities');
      if (opts.canManage && typeof opts.onAddTopic === 'function') utilities.append(button('＋ 添加算法', 'alg-text-button alg-add-topic-detail', () => { expandedReader?.close(); opts.onAddTopic(selected.node.id); }));
      if (typeof opts.onLearningPath === 'function') utilities.append(button('在学习路径中查看 →', 'alg-text-button alg-add-topic-detail', () => { expandedReader?.close(); opts.onLearningPath(selected.node.id); }));
      function appendInformation() { if (information.childNodes.length) pane.append(information); if (utilities.childNodes.length) pane.append(utilities); }
      pane.append(detail);
      if (filtering) {
        // Keep the selected topic useful while the global query stays active.
        if (selected.node.id !== root.id) {
          const selectedChildren = (selected.node.children || []).filter(child => matched.has(child.id));
          const selectedNotes = matchingNotes.filter(note => note.nodeId === selected.node.id);
          pane.append(heading('当前节点的笔记', selectedNotes.length));
          if (selectedNotes.length) {
            const selectedList = element('div', 'alg-note-list alg-selected-note-list');
            selectedNotes.forEach(note => selectedList.append(noteCard(note, false)));
            pane.append(selectedList);
          } else pane.append(element('p', 'alg-inline-empty', '当前节点尚无笔记；下方保留所有全局匹配结果。'));
          if (selectedChildren.length) {
            pane.append(heading('当前节点 · 继续探索', selectedChildren.length));
            const childrenGrid = element('div', 'alg-topic-grid');
            selectedChildren.forEach(child => childrenGrid.append(topicCard(byId.get(child.id))));
            pane.append(childrenGrid);
          }
        }
        const resultSummary = element('div', 'alg-result-summary');
        resultSummary.append(element('strong', '', '全局筛选结果'), element('span', '', `${matched.size} 个节点 · ${matchingNotes.length} 篇笔记`));
        pane.append(resultSummary);
        const topicMatches = all.filter(entry => matched.has(entry.node.id)).sort((a, b) => (topicScores.get(b.node.id) || 0) - (topicScores.get(a.node.id) || 0));
        if (topicMatches.length) {
          pane.append(heading('匹配的知识节点', topicMatches.length));
          const resultTopics = element('div', 'alg-result-topics');
          topicMatches.forEach(entry => {
            const row = button('', 'alg-result-topic', () => selectNode(entry.node.id));
            row.append(element('span', 'alg-result-topic-name', entry.node.label), badge(entry.node), element('span', 'alg-result-topic-path', entry.path.join(' / ')));
            const attributeTag = attributeBadge(entry.node); if (attributeTag) row.append(attributeTag);
            resultTopics.append(row);
          }); pane.append(resultTopics);
        }
        pane.append(heading('匹配的笔记', matchingNotes.length));
        if (matchingNotes.length) { const list = element('div', 'alg-note-list'); matchingNotes.forEach(note => list.append(noteCard(note, true))); pane.append(list); }
        else pane.append(element('p', 'alg-inline-empty', '当前范围内没有匹配的笔记。可以尝试算法名称、笔记标题、作者或标签。'));
        if (!topicMatches.length && !matchingNotes.length) pane.append(button('清除全部筛选', 'alg-button', () => clear.click()));
        appendInformation(); return;
      }
      const children = selected.node.children || [];
      const direct = sortedNotes.filter(note => note.nodeId === selected.node.id);
      const featured = direct.filter(note => note.featured), ordinary = direct.filter(note => !note.featured);
      const notesHeading = () => heading(state.scope === 'personal' ? '我的节点笔记' : '节点笔记', ordinary.length);
      if (featured.length) {
        const section = element('section', 'alg-featured-section'); section.append(heading('精选笔记', featured.length));
        const list = element('div', 'alg-note-list'); featured.forEach(note => list.append(noteCard(note, false))); section.append(list); pane.append(section);
      }
      if (ordinary.length) {
        pane.append(notesHeading());
        const list = element('div', 'alg-note-list'); ordinary.forEach(note => list.append(noteCard(note, false))); pane.append(list);
      }
      if (children.length) {
        pane.append(heading(selected.node.id === root.id ? '选择知识主线' : '继续探索', children.length));
        const grid = element('div', 'alg-topic-grid'); children.forEach(child => grid.append(topicCard(byId.get(child.id)))); pane.append(grid);
      }
      if (!direct.length) {
        pane.append(notesHeading());
        const empty = element('div', 'alg-empty');
        empty.append(element('span', 'alg-empty-symbol', '≡'), element('strong', '', '这里的学习笔记，等待积累'),
          element('p', '', state.scope === 'personal' ? '此节点还没有你的个人笔记。选择一个主题，记录思路、模板和复盘。' : '此节点还没有公开笔记。继续浏览子目录，或为这个主题补充一篇笔记。'));
        if (upload.disabled) empty.append(element('span', 'alg-empty-hint', opts.account ? '上传笔记需要仓库写入权限。' : '登录具有写入权限的账户后，即可上传算法笔记。'));
        else empty.append(button('＋ 为此节点上传笔记', 'alg-button', () => upload.click()));
        pane.append(empty);
      }
      appendInformation();
    }
    function refresh() {
      if (disposed) return;
      const oldScroll = treeScroller.scrollTop;
      // Each new query starts with its complete matching ancestor chains expanded.
      state.expanded.forEach(key => { if (String(key).startsWith('collapsed-filter:')) state.expanded.delete(key); });
      computeResults();
      updateDraftControls();
      clear.hidden = !filtering;
      renderTree(); treeScroller.scrollTop = oldScroll; renderPane(); pane.scrollTop = 0;
      live.textContent = filtering ? `找到 ${matched.size} 个知识节点、${matchingNotes.length} 篇笔记` : `${all.length} 个知识节点、${notes.length} 篇笔记`;
    }
    function updateDraftControls() {
      legendButtons.forEach(control => control.setAttribute('aria-pressed', String(control.dataset.level === state.draftLevel)));
      const changed = state.draftSearch !== state.search || state.draftLevel !== state.level || state.draftAttribute !== state.attribute;
      submitSearch.title = changed ? '应用当前关键词、难度和属性' : '刷新搜索结果';
      submitSearch.dataset.pending = String(changed);
      clear.hidden = !(filtering || state.draftSearch || state.draftLevel || state.draftAttribute);
    }
    function applySearch() {
      state.search = state.draftSearch.trim(); state.level = state.draftLevel; state.attribute = state.draftAttribute;
      state.reading = null; state.listScroll = 0; refresh();
    }
    search.addEventListener('input', () => { state.draftSearch = search.value; updateDraftControls(); });
    search.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); applySearch(); } });
    attribute.addEventListener('change', () => { state.draftAttribute = attribute.value; updateDraftControls(); });
    treeScroller.addEventListener('scroll', () => { state.treeScroll = treeScroller.scrollTop; }, { passive: true });
    pane.addEventListener('scroll', () => { state.paneScroll = pane.scrollTop; }, { passive: true });
    refresh(); treeScroller.scrollTop = state.treeScroll; pane.scrollTop = state.paneScroll;
    const controller = {
      selectNode(id) { if (!byId.has(id)) return; state.search = ''; state.level = ''; state.attribute = ''; state.draftSearch = ''; state.draftLevel = ''; state.draftAttribute = ''; search.value = ''; attribute.value = ''; selectNode(id); refresh(); },
      getState: snapshot,
      openNote(note, { fullscreen = false } = {}) { const found = notes.find(item => noteKey(item) === noteKey(note)); if (!found) return; openNote(found); if (fullscreen) openDetail(); },
      destroy() {
        if (disposed) return;
        expandedReader?.close();
        state.treeScroll = treeScroller.scrollTop; state.paneScroll = pane.scrollTop; disposed = true;
        if (active === controller) active = null;
      }
    };
    active = controller;
    return controller;
  }
  global.NotebookAlgorithms = Object.freeze({ render });
})(window);
