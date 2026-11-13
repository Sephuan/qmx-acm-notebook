/* Stage-based learning route. Only explicit progress actions cross the persistence callback. */
(function (global) {
  'use strict';
  const views = new Map();
  let serial = 0;
  const kinds = { learning: '学习关', mixed: '综合练习', challenge: '阶段挑战' };
  const grades = { basic: ['D1 · 入门', 'basic'], beginner: ['D2 · 初级', 'beginner'], intermediate: ['D3 · 中级', 'intermediate'], advanced: ['D4 · 高级', 'advanced'], expert: ['D5 · 挑战', 'expert'] };
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function add(parent, ...children) { children.filter(Boolean).forEach(child => parent.append(child)); return parent; }
  function control(text, className, action) {
    const node = el('button', className, text); node.type = 'button';
    node.addEventListener('click', action); return node;
  }
  function list(value) { return Array.isArray(value) ? value : []; }
  function text(value) { return typeof value === 'string' ? value : ''; }
  function cfLabel(value) {
    if (!value || !Number.isFinite(value.min)) return '按关卡目标选题';
    return `CF ${value.min}${Number.isFinite(value.max) ? (value.max === value.min ? '' : `–${value.max}`) : '+'}`;
  }
  function authorName(author) {
    if (typeof author === 'string') return author;
    return text(author?.name) || text(author?.login) || '未署名';
  }
  function render(options) {
    if (!options?.host) throw new TypeError('NotebookLearningPath.render requires a host.');
    const opts = options, host = opts.host, uid = `alp-${++serial}`;
    const stages = list(opts.curriculum?.stages).filter(stage => stage && typeof stage.id === 'string');
    const stageById = new Map(), gateById = new Map(), topics = new Map();
    stages.forEach((stage, stageIndex) => {
      stageById.set(stage.id, { stage, index: stageIndex });
      list(stage.gates).forEach((gate, gateIndex) => { if (gate && typeof gate.id === 'string') gateById.set(gate.id, { gate, stage, stageIndex, index: gateIndex }); });
    });
    function walk(node, path) {
      if (!node || typeof node.id !== 'string') return;
      const entry = { node, path: [...path, text(node.label) || '未命名知识点'] };
      topics.set(node.id, entry); list(node.legacyIds).forEach(id => topics.set(id, entry));
      list(node.children).forEach(child => walk(child, entry.path));
    }
    walk(opts.tree, []);
    // Admin additions can turn a linked algorithm into a directory; follow its concrete child.
    for (const [id, entry] of topics) {
      if (entry.node.kind !== 'directory') continue;
      const concrete = list(entry.node.children).find(child => child.contentOf === entry.node.id && child.kind === 'algorithm');
      if (concrete && topics.has(concrete.id)) topics.set(id, topics.get(concrete.id));
    }
    const sharedNotes = list(opts.notes).filter(note => note?.noteScope === 'public' && topics.has(note.nodeId));
    const viewKey = text(opts.progressKey) || `${opts.account?.id ?? 'local'}:${text(opts.curriculum?.id) || 'main'}`;
    const remembered = views.get(viewKey);
    let progress = { ...(opts.progress || {}), gates: { ...(opts.progress?.gates || {}) } };
    let stageId = stageById.has(remembered?.stageId) ? remembered.stageId : stageById.has(progress.stageId) ? progress.stageId : stages[0]?.id;
    let gateId = gateById.has(remembered?.gateId) && gateById.get(remembered.gateId).stage.id === stageId ? remembered.gateId
      : gateById.has(progress.gateId) && gateById.get(progress.gateId).stage.id === stageId ? progress.gateId : null;
    let destroyed = false, busy = false, celebrationTimer, saveError = '', root, routeScroll, detail, summary, stageButton, stageDialog, evidenceDialog, shareDialog;
    let evidenceForm, evidenceError, evidenceGateId = null, previousFocus, lastCelebrated = null, detailController = null;
    const canSave = typeof opts.onProgress === 'function';
    const records = () => [...gateById.values()];
    const gateProgress = id => progress.gates[id] && ['learning', 'completed'].includes(progress.gates[id].status) ? progress.gates[id] : null;
    const isCompleted = id => gateProgress(id)?.status === 'completed';
    const completedCount = gates => list(gates).filter(gate => isCompleted(gate.id)).length;
    const validGates = stage => list(stage.gates).filter(gate => gateById.has(gate.id));
    function stageCurrent(stage) {
      const gates = validGates(stage);
      return gates.find(gate => gateProgress(gate.id)?.status === 'learning') || gates.find(gate => !isCompleted(gate.id)) || gates[0];
    }
    function currentEntry() { return gateById.get(gateId); }
    function remember() { views.set(viewKey, { stageId, gateId }); }
    if (!gateId) gateId = stages.length ? stageCurrent(stageById.get(stageId).stage)?.id : null;
    function notify(message) { if (typeof opts.toast === 'function') opts.toast(message); }
    function nodeButton(entry, label, className = 'alp-topic-link') {
      const button = control(label || entry.node.label, className, () => opts.onTopic?.(entry.node.id));
      button.title = `${entry.path.join(' / ')}${entry.node.fullLabel && entry.node.fullLabel !== entry.node.label ? ` · ${entry.node.fullLabel}` : ''}`; button.disabled = typeof opts.onTopic !== 'function'; return button;
    }
    function isOrientation(stage) { return stage.type === 'orientation'; }
    function learningPosition(stage, cf = stage.cf) { return isOrientation(stage) ? '入门导览' : cfLabel(cf); }
    function rangeTags(parent, cf, luogu, orientation = false) {
      if (orientation) { parent.append(el('span', 'alp-range', '入门导览')); return; }
      add(parent, el('span', 'alp-range alp-range-cf', cfLabel(cf)));
      if (list(luogu).length) parent.append(el('span', 'alp-range', `洛谷参考：${luogu.join(' / ')}`));
    }
    function statusOf(gate, stage) {
      if (isCompleted(gate.id)) return 'completed';
      return gateProgress(gate.id)?.status === 'learning' || stageCurrent(stage)?.id === gate.id ? 'learning' : 'todo';
    }
    function stageNumber(stage) { return Number.isInteger(stage.index) ? stage.index : stageById.get(stage.id).index + 1; }
    function gateNumber(gate) { return gateById.get(gate.id).index + 1; }
    function selectGate(id, { focus = false, center = true } = {}) {
      const entry = gateById.get(id); if (!entry || destroyed || busy) return false;
      stageId = entry.stage.id; gateId = entry.gate.id; saveError = ''; remember();
      renderMain({ center });
      if (focus) (detailController ? detail.querySelector('.alp-gate-title') : root.querySelector('.alp-checkpoint[aria-pressed="true"]'))?.focus({ preventScroll: true });
      return true;
    }
    function renderSummary() {
      summary.replaceChildren();
      const done = records().filter(({ gate }) => isCompleted(gate.id)).length;
      for (const [value, label] of [[`${stages.length} 阶段`, '以综合做题能力为目标'], [`${gateById.size} 关`, '先广后深 · 学习与混练'], [`${done} / ${gateById.size}`, '已记录完成的关卡']]) {
        const stat = el('div', 'alp-stat'); add(stat, el('strong', '', value), el('span', '', label)); summary.append(stat);
      }
      const resumed = records().find(({ gate }) => gateProgress(gate.id)?.status === 'learning') || records().find(({ gate }) => !isCompleted(gate.id));
      if (resumed) summary.append(control(`继续 第${stageNumber(resumed.stage)}章 · 第${gateNumber(resumed.gate)}关 →`, 'alp-button alp-button-primary alp-resume', () => selectGate(resumed.gate.id, { focus: true })));
      else summary.append(el('span', 'alp-all-complete', '✓ 已完成全部关卡记录，可随时回顾'));
    }
    function renderAchievements() {
      const container = root.querySelector('.alp-achievements'); container.replaceChildren();
      const completed = records().filter(({ gate }) => isCompleted(gate.id));
      const finishedStage = stages.some(stage => validGates(stage).length && completedCount(validGates(stage)) === validGates(stage).length);
      const reflectionCount = records().filter(({ gate }) => text(gateProgress(gate.id)?.reflection).trim()).length;
      const items = [
        ['迈出第一步', completed.length > 0, '完成第一关的学习记录'],
        ['综合初试', completed.some(({ gate }) => ['mixed', 'challenge'].includes(gate.kind)), '完成一次综合练习或阶段挑战'],
        ['章节里程碑', finishedStage, '完成一章的全部关卡记录'],
        ['复盘积累', reflectionCount >= 3, `为至少 3 关留下复盘，当前 ${reflectionCount} 关`]
      ];
      container.append(el('span', 'alp-achievement-heading', '我的学习足迹'));
      items.forEach(([label, earned, description]) => {
        const badge = el('span', 'alp-achievement', `${earned ? '✓' : '○'} ${label}`);
        badge.dataset.earned = String(earned); badge.title = description; container.append(badge);
      });
    }
    function renderStagePicker() {
      const grid = stageDialog.querySelector('.alp-stage-grid'); grid.replaceChildren();
      stages.forEach(stage => {
        const gates = validGates(stage), done = completedCount(gates), complete = gates.length > 0 && done === gates.length;
        const card = control('', 'alp-stage-card', () => { if (busy) return; stageDialog.close(); selectGate(stageCurrent(stage)?.id); stageButton.focus({ preventScroll: true }); });
        card.dataset.stageId = stage.id; card.dataset.completed = String(complete); card.setAttribute('aria-current', String(stageId === stage.id));
        add(card, el('span', 'alp-stage-index', `${complete ? '✓ 已完成 · ' : ''}第${stageNumber(stage)}章`), el('strong', 'alp-stage-name', stage.title), el('span', 'alp-stage-description', stage.description || stage.goal));
        const ranges = el('div', 'alp-ranges'); rangeTags(ranges, stage.cf, stage.luoguDifficulty, isOrientation(stage)); card.append(ranges);
        const bar = el('progress', 'alp-stage-progress'); bar.max = gates.length || 1; bar.value = done; bar.setAttribute('aria-label', `第${stageNumber(stage)}章完成 ${done} / ${gates.length} 关`);
        add(card, el('span', 'alp-stage-count', `${done} / ${gates.length} 关已完成`), bar); grid.append(card);
      });
    }
    function openStagePicker() {
      if (busy) return; renderStagePicker(); previousFocus = stageButton; stageDialog.showModal();
      stageDialog.querySelector('[aria-current="true"]')?.focus();
    }
    function renderRoute(stage) {
      const route = el('div', 'alp-route');
      validGates(stage).forEach(gate => {
        const status = statusOf(gate, stage), selected = gateId === gate.id;
        const row = control('', 'alp-checkpoint', () => selectGate(gate.id, { focus: true, center: false }));
        row.dataset.gateId = gate.id; row.dataset.status = status; row.dataset.kind = gate.kind || 'learning'; row.setAttribute('aria-pressed', String(selected));
        const statusText = status === 'completed' ? '已完成' : gateProgress(gate.id)?.status === 'learning' ? '学习中' : status === 'learning' ? '下一关' : '未完成';
        row.setAttribute('aria-label', `第${stageNumber(stage)}章 第${gateNumber(gate)}关 ${gate.title}，${statusText}${selected ? '，已选择' : ''}`);
        const symbol = status === 'completed' ? '✓' : status === 'learning' ? '▶' : String(gateNumber(gate));
        const copy = el('span', 'alp-checkpoint-copy');
        add(copy, el('strong', '', `第${gateNumber(gate)}关 ${gate.title}`));
        if (gate.learningTitle) copy.append(el('span', 'alp-checkpoint-story', gate.learningTitle));
        copy.append(el('span', 'alp-checkpoint-subtitle', `${kinds[gate.kind] || '学习关'}${gate.optional ? ' · 选修' : ''} · ${learningPosition(stage, gate.cf || stage.cf)}`));
        add(row, el('span', 'alp-checkpoint-number', symbol), copy, el('span', 'alp-checkpoint-status', `${status === 'completed' ? '✓ ' : status === 'learning' ? '▶ ' : '○ '}${statusText}`));
        route.append(row);
        if (gate.kind === 'mixed' || gate.kind === 'challenge') {
          const checkpoint = el('div', 'alp-route-milestone'); checkpoint.append(el('span', '', gate.kind === 'challenge' ? '阶段终点 · 完成独立解题与复盘' : '混合检验 · 回收前序知识')); route.append(checkpoint);
        }
      });
      routeScroll.replaceChildren(route);
    }
    function sectionHeading(title) { return el('h4', 'alp-section-title', title); }
    function renderDetail() {
      const entry = currentEntry(); detail.replaceChildren(); if (!entry) return;
      const { gate, stage } = entry, record = gateProgress(gate.id);
      const readingPath = [
        { label: '闯关学习', onClick() { detailController?.close(); } },
        { label: `第${stageNumber(stage)}章 ${stage.title}`, onClick() { detailController?.close(); openStagePicker(); } },
        { label: `第${gateNumber(gate)}关 ${gate.title}` }
      ];
      detailController?.setPath(readingPath);
      const heading = el('h3', 'alp-gate-title', gate.title); heading.tabIndex = -1;
      const label = el('div', 'alp-detail-eyebrow', `第${stageNumber(stage)}章 · 第${gateNumber(gate)}关`);
      const header = el('div', 'alp-detail-header'), title = el('div', 'alp-detail-title');
      add(title, label, heading, el('span', 'alp-kind', `${kinds[gate.kind] || '学习关'}${gate.optional ? ' · 选修' : ''}`));
      const open = control('打开详情', 'alp-button alp-button-secondary alp-detail-open-button reading-detail-trigger', () => {
        if (detailController || typeof global.NotebookReadingDetail?.open !== 'function') return;
        detailController = global.NotebookReadingDetail.open({ content: detail, mount: host, title: '关卡详情', path: readingPath, onClose() { detailController = null; } });
      });
      add(header, title, open); detail.append(header);
      const related = list(gate.topicIds).map(id => topics.get(id)).filter(Boolean);
      const notes = renderNotes(gate, related);
      const ranges = el('div', 'alp-ranges'); rangeTags(ranges, gate.cf || stage.cf, gate.luoguDifficulty || stage.luoguDifficulty, isOrientation(stage));
      if (gate.learningTitle || gate.learningDescription) {
        const story = el('div', 'alp-learning-story');
        if (gate.learningTitle) story.append(el('strong', '', gate.learningTitle));
        if (gate.learningDescription) story.append(el('p', '', gate.learningDescription));
        detail.append(story);
      }
      add(detail, el('p', 'alp-description', gate.description || stage.description), ranges, !isOrientation(stage) && el('p', 'alp-fine-print', '题目难度用于选题；知识点等级单独显示，两者不作换算。'));
      const goals = list(gate.goals);
      if (goals.length) { detail.append(sectionHeading('本关目标')); const ul = el('ul', 'alp-goals'); goals.forEach(goal => ul.append(el('li', '', goal))); detail.append(ul); }
      const actions = el('div', 'alp-actions');
      const complete = control(record?.status === 'completed' ? '编辑完成记录' : '✓ 记录本关完成', 'alp-button alp-button-primary alp-complete-button', () => openEvidence(gate.id));
      complete.disabled = busy || !canSave; actions.append(complete);
      const learning = control(record?.status === 'completed' ? '撤销完成，设为学习中' : record?.status === 'learning' ? '编辑学习记录' : '▶ 开始学习', 'alp-button alp-button-secondary alp-learning-button', () => {
        if (record?.status === 'learning') openEvidence(gate.id, 'learning');
        else saveStatus(gate.id, 'learning');
      }); learning.disabled = busy || !canSave; actions.append(learning);
      add(detail, actions, el('p', 'alp-fine-print', '完成状态由自己记录，用于学习追踪；不代表系统判题通过。'));
      if (!canSave) detail.append(el('p', 'alp-inline-error', '当前无法保存学习进度，请稍后重试。'));
      if (saveError) { const error = el('p', 'alp-inline-error', saveError); error.setAttribute('role', 'alert'); detail.append(error); }
      detail.append(sectionHeading('关联知识点'));
      if (related.length) {
        const group = el('div', 'alp-topics');
        related.forEach(topic => {
          const card = el('div', 'alp-topic'); card.append(nodeButton(topic));
          const grade = grades[topic.node.color]; if (grade && topic.node.kind !== 'directory') { const tag = el('span', 'alp-grade', grade[0]); tag.dataset.level = grade[1]; card.append(tag); }
          group.append(card);
        }); detail.append(group);
      } else detail.append(el('p', 'alp-fine-print', '此关的知识点正在整理，可先按学习目标练习。'));
      const thread = list(gate.threadGateIds).map(id => gateById.get(id)).filter(Boolean);
      if (thread.length) {
        detail.append(sectionHeading('把知识连成线'));
        const links = el('div', 'alp-thread');
        thread.forEach(item => {
          const before = item.stageIndex < entry.stageIndex || item.stageIndex === entry.stageIndex && item.index < entry.index;
          links.append(control(`${before ? '↩ 回顾' : '↗ 延伸'} · 第${stageNumber(item.stage)}章第${gateNumber(item.gate)}关 ${item.gate.title}`, 'alp-prerequisite alp-thread-link', () => selectGate(item.gate.id, { focus: true })));
        });
        detail.append(links);
      }
      const requiredGates = list(gate.prerequisites?.gateIds).map(id => gateById.get(id)).filter(Boolean);
      const requiredTopics = list(gate.prerequisites?.topicIds).map(id => topics.get(id)).filter(Boolean);
      if (requiredGates.length || requiredTopics.length) {
        detail.append(sectionHeading('先修与回补')); const group = el('div', 'alp-prerequisites');
        requiredGates.forEach(required => group.append(control(`${isCompleted(required.gate.id) ? '✓' : '↩'} 第${stageNumber(required.stage)}章·第${gateNumber(required.gate)}关 ${required.gate.title}`, 'alp-prerequisite', () => selectGate(required.gate.id, { focus: true }))));
        requiredTopics.forEach(topic => group.append(nodeButton(topic, `↩ ${topic.node.label}`, 'alp-prerequisite')));
        add(detail, group, el('p', 'alp-fine-print', '先修是学习建议，可按实际掌握情况回补或跳学。'));
      }
      if (stage.goal) add(detail, sectionHeading(isOrientation(stage) ? '导览目标' : '阶段综合目标'), el('p', 'alp-stage-goal', stage.goal));
      if (list(stage.completionCriteria).length) {
        detail.append(sectionHeading(isOrientation(stage) ? '导览完成检验' : '阶段通关检验'));
        const criteria = el('ul', 'alp-goals alp-stage-criteria');
        stage.completionCriteria.forEach(criterion => criteria.append(el('li', '', criterion)));
        detail.append(criteria);
      }
      if (record) {
        detail.append(sectionHeading('我的本关记录'));
        const saved = el('div', 'alp-saved-record'); saved.append(el('strong', '', record.status === 'completed' ? '✓ 已记录完成' : '▶ 学习中'));
        if (record.problemUrl) saved.append(el('p', 'alp-saved-url', record.problemUrl));
        if (record.reflection) saved.append(el('p', 'alp-saved-reflection', record.reflection));
        if (record.updatedAt && Number.isFinite(Date.parse(record.updatedAt))) saved.append(el('span', 'alp-saved-date', new Date(record.updatedAt).toLocaleString('zh-CN')));
        detail.append(saved);
      }
      const utilities = el('footer', 'alp-detail-utilities'), utilityActions = el('div', 'alp-utility-actions');
      const share = control('复制互助卡', 'alp-button alp-button-secondary alp-share-button', () => openShare(gate.id)); share.disabled = busy; utilityActions.append(share);
      if (related[0] && typeof opts.onUpload === 'function') {
        const upload = control('＋ 为本关知识点补充笔记', 'alp-text-button alp-upload-button', () => { if (opts.canUpload !== false) opts.onUpload(related[0].node.id); });
        upload.disabled = opts.canUpload === false; if (upload.disabled) upload.title = '登录并获得仓库写入权限后可补充共享笔记'; utilityActions.append(upload);
      }
      utilities.append(utilityActions);
      if (notes.length) { const authors = [...new Set(notes.map(note => authorName(note.author)))]; add(utilities, sectionHeading('相关笔记贡献者'), el('p', 'alp-contributors', authors.join(' · '))); }
      detail.append(utilities);
    }
    function renderNotes(gate, related) {
      const ids = new Set(related.map(topic => topic.node.id));
      related.forEach(topic => { if (topic.node.contentOf) ids.add(topics.get(topic.node.contentOf)?.node.id || topic.node.contentOf); });
      const notes = sharedNotes.filter(note => ids.has(topics.get(note.nodeId)?.node.id)).slice().sort((a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)) || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
      detail.append(sectionHeading('相关公开笔记'));
      if (notes.length) {
        const noteList = el('div', 'alp-notes');
        notes.slice(0, 5).forEach(note => {
          const topic = topics.get(note.nodeId); const noteButton = control('', `alp-note${note.featured ? ' alp-note-featured' : ''}`, () => { if (typeof opts.onNote === 'function') opts.onNote(note, { gateId: gate.id }); else opts.onTopic?.(topic.node.id); });
          if (note.featured) noteButton.append(el('span', 'alp-note-featured-label', '精选'));
          add(noteButton, el('strong', '', note.title || '未命名笔记'), el('span', '', `${authorName(note.author)} · ${topic.node.label}`)); noteButton.title = '打开笔记详情'; noteList.append(noteButton);
        }); detail.append(noteList);
      } else detail.append(el('p', 'alp-fine-print', '此关尚无相关公开笔记，可以分享自己的理解与复盘。'));
      return notes;
    }
    function renderMain({ center = false } = {}) {
      if (destroyed || !stages.length) return;
      const stage = stageById.get(stageId).stage, oldScroll = routeScroll.scrollTop;
      renderSummary(); renderAchievements();
      stageButton.replaceChildren();
      add(stageButton, el('span', 'alp-selected-stage-number', String(stageNumber(stage)).padStart(2, '0')));
      const name = el('span', 'alp-selected-stage-copy'); add(name, el('strong', '', `第${stageNumber(stage)}章 ${stage.title}`), el('span', '', `${learningPosition(stage)} · ${completedCount(validGates(stage))} / ${validGates(stage).length} 关完成`));
      add(stageButton, name, el('span', 'alp-switch-label', '切换阶段 ⌄'));
      const stageIntro = root.querySelector('.alp-stage-intro'); stageIntro.replaceChildren();
      add(stageIntro, el('span', 'alp-eyebrow', `阶段 ${stageNumber(stage)} · ${isOrientation(stage) ? '入门导览' : '先广后深，独立完成综合题'}`), el('h2', 'alp-stage-title', `第${stageNumber(stage)}章 ${stage.title}`));
      const ranges = el('div', 'alp-ranges'); rangeTags(ranges, stage.cf, stage.luoguDifficulty, isOrientation(stage));
      add(stageIntro, ranges, el('p', 'alp-description', stage.description || stage.goal));
      const orientation = isOrientation(stage);
      root.querySelector('.alp-footer').hidden = orientation;
      renderRoute(stage); renderDetail();
      routeScroll.scrollTop = oldScroll;
      if (center) centerSelected();
      if (lastCelebrated) showCelebration(lastCelebrated);
    }
    function centerSelected() {
      const selected = root.querySelector('.alp-checkpoint[aria-pressed="true"]'); if (!selected) return;
      const delta = selected.getBoundingClientRect().top - routeScroll.getBoundingClientRect().top;
      routeScroll.scrollTop += delta - routeScroll.clientHeight * .38;
    }
    function showCelebration(message) {
      const band = root.querySelector('.alp-success'); band.textContent = message; band.hidden = false;
      clearTimeout(celebrationTimer); celebrationTimer = setTimeout(() => { if (!destroyed) { band.hidden = true; lastCelebrated = null; } }, 2200);
    }
    function buildDialog(title, className) {
      const dialog = el('dialog', `alp-dialog ${className}`), headingId = `${uid}-${className}-heading`;
      dialog.setAttribute('aria-labelledby', headingId);
      const header = el('div', 'alp-dialog-heading'), heading = el('h2', '', title); heading.id = headingId;
      const close = control('×', 'alp-dialog-close', () => { if (!busy) dialog.close(); }); close.setAttribute('aria-label', '关闭');
      add(header, heading, close); dialog.append(header);
      dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
      dialog.addEventListener('click', event => { if (event.target === dialog && !busy) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } });
      dialog.addEventListener('close', () => { if (!destroyed && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }); });
      return dialog;
    }
    function field(labelText, input) { const label = el('label', 'alp-field'); add(label, el('span', '', labelText), input); return label; }
    function buildEvidenceDialog() {
      const dialog = buildDialog('记录本关学习', 'alp-evidence-dialog');
      const form = el('form', 'alp-evidence-form');
      const gateTitle = el('p', 'alp-evidence-title');
      const status = el('select'); status.name = 'status';
      for (const [value, label] of [['learning', '学习中'], ['completed', '已完成（自己记录）']]) { const option = el('option', '', label); option.value = value; status.append(option); }
      const url = el('input'); url.name = 'problemUrl'; url.type = 'url'; url.maxLength = 2000; url.placeholder = 'https://…'; url.autocomplete = 'off';
      const reflection = el('textarea'); reflection.name = 'reflection'; reflection.rows = 5; reflection.maxLength = 4000; reflection.placeholder = '写下独立解题过程、关键观察，或还没有弄清楚的地方。';
      evidenceError = el('p', 'alp-inline-error'); evidenceError.setAttribute('role', 'alert'); evidenceError.hidden = true;
      const actions = el('div', 'alp-dialog-actions'), cancel = control('取消', 'alp-button alp-button-secondary', () => { if (!busy) dialog.close(); });
      const save = el('button', 'alp-button alp-button-primary', '保存记录'); save.type = 'submit';
      add(actions, cancel, save);
      add(form, gateTitle, el('p', 'alp-fine-print', '如实记录学习情况；题目链接和复盘可选。这里不会自动判断提交结果，也不会向队友或外部平台发送内容。'), field('学习状态', status), field('练习题目链接（可选）', url), field('我的复盘（可选）', reflection), evidenceError, actions);
      form.addEventListener('submit', async event => {
        event.preventDefault(); if (busy || !evidenceGateId || !canSave) return;
        const problemUrl = url.value.trim();
        if (problemUrl) { try { const parsed = new URL(problemUrl); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(); } catch (_) { evidenceError.textContent = '请填写有效的 HTTP 或 HTTPS 题目链接。'; evidenceError.hidden = false; url.focus(); return; } }
        evidenceError.hidden = true;
        const nextRecord = { status: status.value, problemUrl, reflection: reflection.value.trim(), updatedAt: new Date().toISOString() };
        try {
          await persist(evidenceGateId, nextRecord);
          if (destroyed) return;
          dialog.close(); renderMain();
          if (nextRecord.status === 'completed') { lastCelebrated = isOrientation(gateById.get(evidenceGateId).stage) ? '✓ 导览完成记录已保存。' : '✓ 本关完成记录已保存，继续积累自己的解题方法。'; showCelebration(lastCelebrated); }
          detail.querySelector('.alp-complete-button')?.focus({ preventScroll: true });
        } catch (error) { if (!destroyed) { evidenceError.textContent = error?.message || '未能保存，请保留记录后重试。'; evidenceError.hidden = false; } }
      });
      evidenceForm = form; dialog.append(form); return dialog;
    }
    function openEvidence(id, preferredStatus) {
      if (busy || !gateById.has(id)) return;
      evidenceGateId = id; const entry = gateById.get(id), record = gateProgress(id);
      evidenceForm.querySelector('.alp-evidence-title').textContent = `第${stageNumber(entry.stage)}章 · 第${gateNumber(entry.gate)}关 ${entry.gate.title}`;
      evidenceForm.elements.status.value = preferredStatus || 'completed';
      evidenceForm.elements.problemUrl.value = record?.problemUrl || '';
      evidenceForm.elements.reflection.value = record?.reflection || '';
      evidenceForm.elements.reflection.placeholder = isOrientation(entry.stage) ? '写下导览中的理解，或还没有弄清楚的地方。' : '写下独立解题过程、关键观察，或还没有弄清楚的地方。';
      evidenceError.hidden = true; previousFocus = document.activeElement;
      evidenceDialog.showModal(); evidenceForm.elements.reflection.focus();
    }
    function setBusy(value) {
      busy = value; root.dataset.saving = String(value); root.setAttribute('aria-busy', String(value));
      evidenceForm?.querySelectorAll('button,input,textarea,select').forEach(input => { input.disabled = value; });
      evidenceDialog?.querySelector('.alp-dialog-close')?.toggleAttribute('disabled', value);
      detail.querySelectorAll('.alp-complete-button,.alp-learning-button').forEach(button => { button.disabled = value || !canSave; });
    }
    async function persist(id, record) {
      if (!canSave) throw new Error('当前无法保存学习进度，请稍后重试。');
      const entry = gateById.get(id); if (!entry) throw new Error('未找到此关卡，请重新打开学习路径。');
      const next = { ...progress, gates: { ...progress.gates, [id]: record }, stageId: entry.stage.id, gateId: id };
      setBusy(true);
      try { await opts.onProgress(next); progress = next; saveError = ''; }
      finally { if (!destroyed) setBusy(false); }
    }
    async function saveStatus(id, status) {
      if (busy || !canSave) return;
      const previous = gateProgress(id);
      try {
        await persist(id, { status, problemUrl: text(previous?.problemUrl), reflection: text(previous?.reflection), updatedAt: new Date().toISOString() });
        if (!destroyed) { renderMain(); notify(status === 'learning' ? '已保存为学习中' : '本关完成记录已保存'); }
      } catch (error) { if (!destroyed) { saveError = error?.message || '进度未能保存，请重试。'; renderDetail(); } }
    }
    function shareText(id) {
      const entry = gateById.get(id), record = gateProgress(id); if (!entry) return '';
      const names = list(entry.gate.topicIds).map(id => topics.get(id)).filter(Boolean).map(topic => topic.path.join(' / '));
      return ['【拾题 · 学习互助卡】', `第${stageNumber(entry.stage)}章 · 第${gateNumber(entry.gate)}关 ${entry.gate.title}`,
        entry.gate.learningTitle ? `学习脉络：${entry.gate.learningTitle}` : '',
        isOrientation(entry.stage) ? '学习定位：入门导览' : `目标选题：${cfLabel(entry.gate.cf || entry.stage.cf)}；洛谷参考：${list(entry.gate.luoguDifficulty || entry.stage.luoguDifficulty).join(' / ') || '按具体题目选择'}`,
        `知识路径：${names.join('；') || '按本关学习目标'}`,
        `当前记录：${record?.status === 'completed' ? '已完成（本人记录）' : record?.status === 'learning' ? '学习中' : '尚未记录'}`,
        record?.problemUrl ? `练习题目：${record.problemUrl}` : '',
        record?.reflection ? `我的复盘 / 困惑：${record.reflection}` : '想请教的问题：请补充自己的思路、卡点与尝试。',
        !isOrientation(entry.stage) && '一起讨论：关键观察是什么？有没有反例？如何证明复杂度？'].filter(Boolean).join('\n');
    }
    function buildShareDialog() {
      const dialog = buildDialog('学习互助卡', 'alp-share-dialog');
      const textarea = el('textarea', 'alp-share-text'); textarea.readOnly = true; textarea.rows = 11; textarea.setAttribute('aria-label', '互助卡内容');
      const hint = el('p', 'alp-fine-print', '仅生成文字供你复制，自行选择是否分享给队友。复盘中的个人内容也会包含在卡片里。');
      const actions = el('div', 'alp-dialog-actions');
      const copy = control('复制文字', 'alp-button alp-button-primary', async () => {
        try { await navigator.clipboard.writeText(textarea.value); notify('互助卡已复制，可自行分享给队友'); }
        catch (_) { textarea.focus(); textarea.select(); hint.textContent = '无法自动复制，内容已选中，请按 Ctrl+C 或使用系统复制。'; }
      }); add(actions, copy); add(dialog, textarea, hint, actions); return dialog;
    }
    async function openShare(id) {
      const content = shareText(id); if (!content) return;
      try { await navigator.clipboard.writeText(content); notify('互助卡已复制，包含本关路径及你的记录，可自行分享'); }
      catch (_) { if (destroyed) return; previousFocus = document.activeElement; shareDialog.querySelector('textarea').value = content; shareDialog.showModal(); shareDialog.querySelector('textarea').focus(); shareDialog.querySelector('textarea').select(); }
    }
    root = el('section', 'alp'); root.setAttribute('aria-label', '算法竞赛闯关学习路径');
    if (!stages.length || !gateById.size) {
      add(root, el('h2', 'alp-empty-title', '学习路径正在整理'), el('p', 'alp-description', '关卡准备完成后会显示在这里，可以先从知识树查看学习笔记。')); host.replaceChildren(root);
      return { destroy() { destroyed = true; root.remove(); }, selectTopic() { return false; }, selectGate() { return false; } };
    }
    summary = el('div', 'alp-summary'); summary.setAttribute('aria-label', '学习进度概览');
    const legend = el('div', 'alp-state-legend');
    for (const [type, symbol, label] of [['completed', '✓', '已完成'], ['learning', '▶', '学习中 / 下一关'], ['todo', '○', '未完成']]) { const item = el('span', 'alp-state-item'); const mark = el('i', 'alp-state-mark', symbol); mark.dataset.status = type; add(item, mark, el('span', '', label)); legend.append(item); }
    legend.append(el('span', 'alp-record-hint', '进度由自己记录，先修满足即可跳学'));
    const achievements = el('div', 'alp-achievements'); achievements.setAttribute('aria-label', '学习足迹');
    const main = el('div', 'alp-main');
    const pickerRow = el('div', 'alp-stage-picker-row'); stageButton = control('', 'alp-stage-picker', openStagePicker); stageButton.setAttribute('aria-haspopup', 'dialog'); pickerRow.append(stageButton);
    const stageIntro = el('div', 'alp-stage-intro');
    const columns = el('div', 'alp-columns');
    routeScroll = el('div', 'alp-route-scroll'); routeScroll.setAttribute('aria-label', '本章关卡路线'); routeScroll.tabIndex = 0;
    detail = el('aside', 'alp-detail'); detail.setAttribute('aria-label', '所选关卡详情'); add(columns, routeScroll, detail);
    add(main, pickerRow, stageIntro, columns);
    const success = el('div', 'alp-success'); success.hidden = true; success.setAttribute('role', 'status'); success.setAttribute('aria-live', 'polite');
    stageDialog = buildDialog('选择学习阶段', 'alp-stage-dialog'); stageDialog.append(el('p', 'alp-picker-hint', '以综合做题能力为主线，先广后深；阶段可以自由切换，已有基础可直接跳学。'), el('div', 'alp-stage-grid'));
    evidenceDialog = buildEvidenceDialog(); shareDialog = buildShareDialog();
    const footer = el('p', 'alp-footer', 'CF 区间和洛谷等级分别用于选题参考，不作等价换算。知识点难度与题目难度独立；阅读和勾选不能代替独立做题。');
    add(root, summary, legend, achievements, success, main, footer, stageDialog, evidenceDialog, shareDialog);
    host.replaceChildren(root); remember(); renderMain({ center: true });
    const controller = {
      destroy() { if (destroyed) return; destroyed = true; detailController?.close(); detailController = null; clearTimeout(celebrationTimer); [stageDialog, evidenceDialog, shareDialog].forEach(dialog => { if (dialog.open) dialog.close(); }); root.remove(); },
      selectGate(id) { return selectGate(id, { focus: true }); },
      selectTopic(id) {
        const canonicalId = topics.get(id)?.node.id || id;
        const matches = new Set([canonicalId]);
        function include(node) { if (!node) return; matches.add(node.id); list(node.children).forEach(include); }
        include(topics.get(id)?.node);
        for (const topic of topics.values()) if (topic.node.contentOf === canonicalId) matches.add(topic.node.id);
        const entry = records().find(({ gate }) => list(gate.topicIds).some(topicId => matches.has(topics.get(topicId)?.node.id || topicId)));
        if (entry) return selectGate(entry.gate.id, { focus: true });
        notify('该专题暂未编入主线，可在知识树继续学习'); return false;
      }
    };
    return controller;
  }
  global.NotebookLearningPath = Object.freeze({ render });
})(typeof window !== 'undefined' ? window : globalThis);
