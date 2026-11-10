/* Local planner UI. The host owns persistence, layout controls, and the bridge. */
(() => {
  'use strict';
  let bridge;
  let onChange;
  let state = { problems: [], tasks: [], layout: 'balanced' };
  let root;
  let dialog;
  let editor;
  let busy = false;
  let mounted = false;
  const cards = {};
  const collapsed = { problems: false, tasks: false };
  const completedOpen = { problems: false, tasks: false };
  let deleteTarget = '';
  let lastFocus;

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  };
  function button(text, className, action) {
    const node = el('button', className, text);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  }
  function field(label, name, type, placeholder, maxLength) {
    const wrap = el('label', 'planner-field');
    wrap.append(el('span', 'planner-sr-only', label));
    const input = el(type === 'textarea' ? 'textarea' : 'input', 'planner-input');
    input.name = name;
    if (type !== 'textarea') input.type = type;
    if (placeholder) input.placeholder = placeholder;
    if (maxLength) input.maxLength = maxLength;
    input.setAttribute('aria-label', label);
    wrap.append(input);
    return { wrap, input };
  }
  function errorText(error) {
    return String(typeof error === 'string' ? error : error?.message || '保存失败，请重试。').replace(/^Error:\s*/, '');
  }
  function showError(target, message) {
    target.textContent = message || '';
    target.hidden = !message;
  }
  function safeURL(value) {
    const url = new URL(String(value).trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请填写 http 或 https 题目链接。');
    return url.href;
  }
  function problemTitle(url) {
    const parsed = new URL(url);
    const path = parsed.pathname;
    let match;
    if (/codeforces\.com$/i.test(parsed.hostname) && (match = path.match(/\/(?:problemset\/problem|contest|gym)\/(\d+)\/(?:problem\/)?([a-z]\d*)/i))) return `CF ${match[1]}${match[2].toUpperCase()}`;
    if (/luogu\.(?:com\.cn|com)$/i.test(parsed.hostname) && (match = path.match(/\/problem\/([^/]+)/i))) return match[1].toUpperCase();
    if (/atcoder\.jp$/i.test(parsed.hostname) && (match = path.match(/\/tasks\/([^/]+)/i))) return match[1];
    if (/nowcoder\.com$/i.test(parsed.hostname) && (match = path.match(/\/acm\/contest\/(\d+)\/([^/]+)/i))) return `牛客 ${match[1]} ${match[2]}`;
    let last = path.split('/').filter(Boolean).pop() || parsed.hostname;
    try { last = decodeURIComponent(last); } catch (_) { /* Keep malformed escapes readable. */ }
    return last.slice(0, 180);
  }
  function parseProblem(value, optionalTitle) {
    const raw = value.trim();
    const match = raw.match(/https?:\/\/\S+/i);
    if (!match) throw new Error('粘贴题目链接后再添加。');
    const url = safeURL(match[0]);
    const pastedTitle = raw.replace(match[0], '').trim().replace(/^[|·—\-\s]+|[|·—\-\s]+$/g, '');
    const title = optionalTitle.trim() || pastedTitle || problemTitle(url);
    if (title.length > 180) throw new Error('题目名称请控制在 180 字以内。');
    return { url, title };
  }
  function localDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (part, length = 2) => String(part).padStart(length, '0');
    const base = `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    return date.getSeconds() || date.getMilliseconds() ? `${base}:${pad(date.getSeconds())}${date.getMilliseconds() ? `.${pad(date.getMilliseconds(), 3)}` : ''}` : base;
  }
  function toISO(value) {
    if (!value) return '';
    const date = new Date(value);
    const parts = value.match(/^(\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
    const expected = parts && [Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]), Number(parts[4]), Number(parts[5]), Number(parts[6] || 0), Number((parts[7] || '').padEnd(3, '0'))];
    const actual = [date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()];
    if (!expected || Number.isNaN(date.getTime()) || actual.some((part, index) => part !== expected[index])) throw new Error('截止时间无效，请重新选择。');
    return date.toISOString();
  }
  function dueTime(item) {
    const time = item.dueAt ? new Date(item.dueAt).getTime() : NaN;
    return Number.isNaN(time) ? Infinity : time;
  }
  function deadline(item) {
    if (!item.dueAt || !Number.isFinite(dueTime(item))) return { text: '无截止时间', overdue: false };
    const date = new Date(item.dueAt);
    const delta = date.getTime() - Date.now();
    const minutes = Math.max(1, Math.ceil(Math.abs(delta) / 60000));
    const span = minutes < 60 ? `${minutes} 分钟` : minutes < 1440 ? `${Math.ceil(minutes / 60)} 小时` : `${Math.ceil(minutes / 1440)} 天`;
    const overdue = !item.done && delta < 0;
    const now = new Date();
    const absolute = date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const clock = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
    const calendar = sameDay ? `今天 ${clock}` : `${date.getFullYear() !== now.getFullYear() ? `${date.getFullYear()}/` : ''}${date.getMonth() + 1}/${date.getDate()} ${clock}`;
    return { text: item.done ? `截止 ${calendar}` : `${calendar} · ${overdue ? `已逾期 ${span}` : `${span}后截止`}`, title: absolute, overdue };
  }
  function updateBusy(value) {
    busy = value;
    for (const area of [root, dialog]) {
      if (!area) continue;
      area.setAttribute('aria-busy', String(value));
      area.querySelectorAll('button,input,textarea').forEach(node => { node.disabled = value; });
    }
  }
  async function mutate(action, payload, errorNode, success) {
    if (busy) return false;
    showError(errorNode, '');
    updateBusy(true);
    let next;
    try {
      if (typeof bridge?.plannerAction !== 'function') throw new Error('计划暂不可用，请稍后重试。');
      next = await bridge.plannerAction(action, payload);
      if (!next || !Array.isArray(next.problems) || !Array.isArray(next.tasks)) throw new Error('保存结果无效，请重试。');
    } catch (error) {
      showError(errorNode, errorText(error));
      updateBusy(false);
      return false;
    }
    updateBusy(false);
    if (success) success();
    deleteTarget = '';
    render(next);
    // Host callback failures must not turn a successful save into a failed form.
    try { if (typeof onChange === 'function') onChange(state); } catch (error) { console.error('Planner onChange failed', error); }
    document.dispatchEvent(new CustomEvent('planner:change', { detail: state }));
    return true;
  }
  function createCard(kind, title, caption) {
    const card = el('section', `planner-card planner-${kind}`);
    const heading = el('div', 'planner-heading');
    const titleGroup = el('div', 'planner-title-group');
    const h2 = el('h2', '', title);
    h2.id = `planner-${kind}-title`;
    card.setAttribute('aria-labelledby', h2.id);
    const count = el('span', 'planner-count');
    titleGroup.append(h2, count);
    heading.append(titleGroup, el('span', 'planner-caption', caption));
    const form = el('form', `planner-add planner-add-${kind}`);
    form.noValidate = true;
    form.setAttribute('aria-label', kind === 'problems' ? '添加待做题目' : '添加待办事项');
    const error = el('p', 'planner-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const list = el('div', 'planner-list');
    list.id = `planner-${kind}-list`;
    list.tabIndex = 0;
    list.setAttribute('role', 'region');
    list.setAttribute('aria-label', kind === 'problems' ? '待做题单，可向下滚动' : '学习任务，可向下滚动');
    const more = button('收起 ▴', 'planner-list-toggle', () => {
      collapsed[kind] = !collapsed[kind];
      drawCard(kind);
      more.focus();
    });
    more.setAttribute('aria-controls', list.id);
    heading.lastChild.remove();
    heading.append(more);
    const completed = el('details', 'planner-completed');
    const summary = el('summary');
    const doneList = el('div', 'planner-list planner-done-list');
    completed.append(summary, doneList);
    completed.addEventListener('toggle', () => { completedOpen[kind] = completed.open; });
    const hint = el('p', 'planner-scroll-hint', '向下滚动查看全部'); hint.hidden = true;
    card.append(heading, form, error, list, hint, completed);
    const refs = { card, count, form, error, list, more, hint, completed, summary, doneList };
    cards[kind] = refs;
    return refs;
  }
  function build() {
    root = el('div', 'planner-root');
    const problems = createCard('problems', '待做题目', '随手存下，稍后再做');
    const url = field('题目链接，可附题目名称', 'url', 'text', '粘贴题目链接', 2400);
    url.input.autocomplete = 'off';
    url.input.spellcheck = false;
    const title = field('题目名称（可选，留空使用题号）', 'title', 'text', '名称（可选）', 180);
    const addProblem = el('button', 'planner-add-button', '添加');
    addProblem.type = 'submit';
    problems.form.append(url.wrap, title.wrap, addProblem);
    problems.form.addEventListener('submit', async event => {
      event.preventDefault();
      if (busy) return;
      try {
        const payload = parseProblem(url.input.value, title.input.value);
        await mutate('addProblem', payload, problems.error, () => {
          url.input.value = '';
          title.input.value = '';
          url.input.focus();
        });
      } catch (error) { showError(problems.error, errorText(error)); url.input.focus(); }
    });
    const tasks = createCard('tasks', '学习任务', '把下一步写下来');
    const taskTitle = field('待办标题', 'title', 'text', '添加一项待办', 180);
    const due = field('截止时间（可选，使用本机时区）', 'dueAt', 'datetime-local', '');
    due.input.step = 'any';
    due.input.title = '截止时间（可选，使用本机时区）';
    const deadlinePicker = window.NotebookDeadline?.enhance(due.input);
    due.wrap.classList.add('planner-deadline-field');
    const addTask = el('button', 'planner-add-button', '添加');
    addTask.type = 'submit';
    tasks.form.append(taskTitle.wrap, due.wrap, addTask);
    tasks.form.addEventListener('submit', async event => {
      event.preventDefault();
      if (busy) return;
      try {
        const titleValue = taskTitle.input.value.trim();
        if (!titleValue) throw new Error('先写下要做的事。');
        if (titleValue.length > 180) throw new Error('标题请控制在 180 字以内。');
        if (due.input.validity.badInput) throw new Error('请填写完整的截止时间，或留空。');
        const dueAt = toISO(due.input.value);
        await mutate('addTask', { title: titleValue, details: '', dueAt }, tasks.error, () => {
          taskTitle.input.value = '';
          due.input.value = '';
          deadlinePicker?.refresh();
          taskTitle.input.focus();
        });
      } catch (error) { showError(tasks.error, errorText(error)); taskTitle.input.focus(); }
    });
    root.append(problems.card, tasks.card);
    buildDialog();
  }
  function captureFocus() {
    const active = document.activeElement;
    if (!active || !root.contains(active)) return null;
    return { kind: active.closest('[data-kind]')?.dataset.kind, id: active.closest('[data-id]')?.dataset.id, action: active.dataset.action };
  }
  function restoreFocus(focus) {
    if (!focus?.action) return;
    const card = cards[focus.kind];
    if (!card) return;
    const row = Array.from(card.card.querySelectorAll('[data-id]')).find(node => node.dataset.id === focus.id);
    const target = row && Array.from(row.querySelectorAll('[data-action]')).find(node => node.dataset.action === focus.action);
    if (target && !target.closest('details:not([open])')) target.focus();
    else card.form.querySelector('input').focus();
  }
  function row(kind, item) {
    const refs = cards[kind];
    const node = el('div', `planner-row${item.done ? ' is-done' : ''}`);
    node.dataset.id = String(item.id);
    node.dataset.kind = kind;
    const checkbox = el('input', 'planner-checkbox');
    checkbox.type = 'checkbox';
    checkbox.checked = Boolean(item.done);
    checkbox.dataset.action = 'done';
    checkbox.setAttribute('aria-label', `${item.done ? '标为未完成' : '标为完成'}：${item.title}`);
    checkbox.addEventListener('change', async () => {
      const done = checkbox.checked;
      checkbox.checked = Boolean(item.done);
      await mutate(kind === 'problems' ? 'updateProblem' : 'updateTask', { id: item.id, done }, refs.error);
    });
    const copy = el('div', 'planner-row-copy');
    if (kind === 'problems') {
      let url;
      try { url = safeURL(item.url); } catch (_) { /* Invalid historical URLs stay plain text. */ }
      const name = el(url ? 'a' : 'span', 'planner-row-title', item.title || (url ? problemTitle(url) : '题目'));
      if (url) {
        name.href = url;
        name.title = url;
        name.dataset.action = 'open';
        name.addEventListener('click', async event => {
          event.preventDefault();
          if (busy) return;
          try {
            if (typeof bridge?.openExternal !== 'function') throw new Error('暂时无法打开链接。');
            await bridge.openExternal(url);
          } catch (error) { showError(refs.error, errorText(error)); }
        });
      }
      copy.append(name);
      if (url) copy.append(el('span', 'planner-row-meta', new URL(url).hostname.replace(/^www\./, '')));
    } else {
      const name = button(item.title, 'planner-row-title planner-task-title', () => openTaskDetail(item));
      name.dataset.action = 'view';
      copy.append(name);
      const due = deadline(item);
      const meta = el('span', `planner-row-meta${due.overdue ? ' is-overdue' : ''}`, due.text);
      if (due.title) meta.title = due.title;
      copy.append(meta);
      if (item.details) copy.append(el('span', 'planner-row-details', item.details));
    }
    const actions = el('div', 'planner-row-actions');
    const edit = button('编辑', 'planner-row-button', () => openEditor(kind, item));
    edit.dataset.action = 'edit';
    edit.setAttribute('aria-label', `编辑：${item.title}`);
    const key = `${kind}:${item.id}`;
    const deleting = deleteTarget === key;
    const remove = button(deleting ? '确认删除' : '删除', `planner-row-button${deleting ? ' planner-danger' : ''}`, async () => {
      if (deleteTarget !== key) {
        deleteTarget = key;
        drawCard(kind);
        const replacement = Array.from(refs.card.querySelectorAll('[data-id]')).find(value => value.dataset.id === String(item.id));
        replacement?.querySelector('[data-action="delete"]')?.focus();
        return;
      }
      await mutate(kind === 'problems' ? 'deleteProblem' : 'deleteTask', { id: item.id }, refs.error);
    });
    remove.dataset.action = 'delete';
    remove.setAttribute('aria-label', `${deleting ? '确认删除' : '删除'}：${item.title}`);
    actions.append(edit, remove);
    if (deleting) {
      const cancel = button('取消', 'planner-row-button', () => { deleteTarget = ''; drawCard(kind); });
      cancel.dataset.action = 'cancel-delete';
      actions.append(cancel);
    }
    node.append(checkbox, copy, actions);
    return node;
  }
  function drawCard(kind) {
    const refs = cards[kind];
    const items = state[kind];
    const pending = items.filter(item => !item.done);
    if (kind === 'tasks') pending.sort((a, b) => {
      const left = dueTime(a), right = dueTime(b);
      return left === right ? 0 : left < right ? -1 : 1;
    });
    const done = items.filter(item => item.done);
    const overdue = kind === 'tasks' ? pending.filter(item => dueTime(item) < Date.now()).length : 0;
    refs.count.textContent = `${pending.length} 项待办${overdue ? ` · ${overdue} 项逾期` : ''}`;
    if (kind === 'problems') refs.count.textContent = `${pending.length} 题待做`;
    const scrollTop = refs.list.scrollTop;
    refs.list.replaceChildren(...pending.map(item => row(kind, item)));
    if (!pending.length) refs.list.append(el('p', 'planner-empty', kind === 'problems' ? '暂无待做题目，粘贴链接即可添加。' : '暂无待办，记下接下来要做的事。'));
    refs.list.hidden = collapsed[kind];
    refs.list.scrollTop = scrollTop;
    refs.more.textContent = collapsed[kind] ? `展开 ${pending.length} ${kind === 'problems' ? '题' : '项'} ▾` : '收起 ▴';
    refs.more.setAttribute('aria-expanded', String(!collapsed[kind]));
    refs.hint.hidden = collapsed[kind] || pending.length <= 3;
    refs.completed.hidden = !done.length;
    refs.summary.textContent = `已完成 ${done.length} ${kind === 'problems' ? '题' : '项'}`;
    refs.completed.open = completedOpen[kind];
    refs.doneList.replaceChildren(...done.map(item => row(kind, item)));
    if (busy) refs.card.querySelectorAll('button,input,textarea').forEach(node => { node.disabled = true; });
  }
  function buildDialog() {
    dialog = el('dialog', 'planner-dialog');
    dialog.setAttribute('aria-labelledby', 'planner-editor-title');
    const form = el('form', 'planner-editor');
    form.noValidate = true;
    const heading = el('div', 'planner-dialog-heading');
    const title = el('h2', '', '编辑待办');
    title.id = 'planner-editor-title';
    const close = button('×', 'planner-dialog-close', () => dialog.close());
    close.setAttribute('aria-label', '关闭编辑');
    heading.append(title, close);
    const titleField = field('标题', 'title', 'text', '', 180);
    const url = field('题目链接', 'url', 'url', 'https://…', 2400);
    const details = field('补充说明（可选，最多 2000 字）', 'details', 'textarea', '补充步骤、备忘或资料…', 2000);
    details.input.rows = 5;
    const due = field('截止时间（可选，本机时区）', 'dueAt', 'datetime-local', '');
    due.input.step = 'any';
    const deadlinePicker = window.NotebookDeadline?.enhance(due.input);
    [titleField, url, details, due].forEach(value => { value.wrap.firstChild.className = 'planner-editor-label'; });
    const error = el('p', 'planner-error');
    error.hidden = true;
    error.setAttribute('role', 'alert');
    const footer = el('div', 'planner-dialog-footer');
    const cancel = button('取消', 'planner-dialog-button', () => dialog.close());
    const save = el('button', 'planner-add-button', '保存');
    save.type = 'submit';
    footer.append(cancel, save);
    form.append(heading, titleField.wrap, url.wrap, details.wrap, due.wrap, error, footer);
    dialog.append(form);
    editor = { form, heading: title, title: titleField, url, details, due, deadlinePicker, error, item: null, kind: null, initialLocal: '' };
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('close', () => {
      if (lastFocus?.isConnected) lastFocus.focus();
      else if (editor.kind && cards[editor.kind]) cards[editor.kind].form.querySelector('input').focus();
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (busy || !editor.item) return;
      try {
        const titleValue = editor.title.input.value.trim();
        if (!titleValue) throw new Error('标题不能为空。');
        if (titleValue.length > 180) throw new Error('标题请控制在 180 字以内。');
        let payload;
        if (editor.kind === 'problems') payload = { id: editor.item.id, title: titleValue, url: safeURL(editor.url.input.value) };
        else {
          if (editor.details.input.value.length > 2000) throw new Error('补充说明请控制在 2000 字以内。');
          if (editor.due.input.validity.badInput) throw new Error('请填写完整的截止时间，或留空。');
          const dueAt = editor.due.input.value === editor.initialLocal ? editor.item.dueAt || '' : toISO(editor.due.input.value);
          payload = { id: editor.item.id, title: titleValue, details: editor.details.input.value, dueAt };
        }
        await mutate(editor.kind === 'problems' ? 'updateProblem' : 'updateTask', payload, editor.error, () => dialog.close());
      } catch (error) { showError(editor.error, errorText(error)); }
    });
  }
  function openTaskDetail(item) {
    if (busy || dialog.open) return;
    const origin = document.activeElement;
    const detail = el('dialog', 'planner-dialog planner-task-detail');
    detail.setAttribute('aria-labelledby', 'planner-task-detail-title');
    const heading = el('div', 'planner-dialog-heading');
    const title = el('h2', '', item.title || '学习任务'); title.id = 'planner-task-detail-title';
    const close = button('×', 'planner-dialog-close', () => detail.close()); close.setAttribute('aria-label', '关闭任务详情');
    heading.append(title, close);
    const due = deadline(item);
    const deadlineBlock = el('section', 'planner-detail-deadline');
    deadlineBlock.append(el('h3', '', '截止时间'), el('p', '', item.dueAt ? new Date(item.dueAt).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '未设置截止时间'));
    if (item.dueAt) deadlineBlock.append(el('span', `planner-row-meta${due.overdue ? ' is-overdue' : ''}`, due.text));
    const description = el('section', 'planner-detail-description');
    description.append(el('h3', '', '任务说明'), el('p', '', item.details || '暂无说明'));
    const footer = el('div', 'planner-dialog-footer');
    footer.append(button('关闭', 'planner-dialog-button', () => detail.close()));
    detail.append(heading, deadlineBlock, description, footer);
    detail.addEventListener('close', () => { detail.remove(); if (origin?.isConnected) origin.focus(); }, { once: true });
    document.body.append(detail); detail.showModal(); close.focus();
  }
  function openEditor(kind, item) {
    if (busy || dialog.open) return;
    lastFocus = document.activeElement;
    editor.kind = kind;
    editor.item = { ...item };
    editor.heading.textContent = kind === 'problems' ? '编辑题目' : '编辑待办';
    editor.title.input.value = item.title || '';
    editor.url.input.value = item.url || '';
    editor.details.input.value = item.details || '';
    editor.due.input.value = localDate(item.dueAt);
    editor.initialLocal = editor.due.input.value;
    editor.deadlinePicker?.refresh();
    editor.url.wrap.hidden = kind !== 'problems';
    editor.details.wrap.hidden = kind !== 'tasks';
    editor.due.wrap.hidden = kind !== 'tasks';
    showError(editor.error, '');
    dialog.showModal();
    editor.title.input.focus();
  }
  function attach() {
    const host = document.getElementById('home-planner');
    if (!host) return false;
    if (!root) build();
    // Keep these exact two card nodes (including active drafts) across parent renders.
    if (root.parentNode !== host) host.append(root);
    if (!dialog.isConnected) document.body.append(dialog);
    if (!mounted) {
      mounted = true;
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && deleteTarget && !busy) { deleteTarget = ''; render(state); }
      });
    }
    return true;
  }
  function render(next) {
    if (next && typeof next === 'object') state = { ...next, problems: Array.isArray(next.problems) ? next.problems : [], tasks: Array.isArray(next.tasks) ? next.tasks : [], layout: next.layout || 'balanced' };
    if (!attach()) return;
    const focus = captureFocus();
    drawCard('problems');
    drawCard('tasks');
    restoreFocus(focus);
  }
  window.NotebookPlanner = {
    init(options = {}) {
      bridge = options.bridge;
      onChange = options.onChange;
      attach();
      return window.NotebookPlanner;
    },
    render
  };
})();
