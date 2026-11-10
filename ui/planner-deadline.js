/* Optional local deadline editor. The original input remains the form's source of truth. */
(() => {
  'use strict';
  const enhanced = new WeakMap();
  let active = null;
  let sequence = 0;
  const pad = value => String(value).padStart(2, '0');
  const dateKey = date => `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  function localDay(year, month, day) {
    const date = new Date(0);
    date.setHours(12, 0, 0, 0);
    date.setFullYear(year, month, day);
    return date;
  }
  function parts(value) {
    return String(value).match(/^(\d{4,}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d{1,3})?)?$/);
  }
  function validLocal(value) {
    const match = value.match(/^(\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
    if (!match) return false;
    const expected = [Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] || 0), Number((match[7] || '').padEnd(3, '0'))];
    const date = new Date(value);
    const actual = [date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()];
    return !Number.isNaN(date.getTime()) && actual.every((part, index) => part === expected[index]);
  }
  function node(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  }
  function action(text, className, callback, label) {
    const result = node('button', className, text);
    result.type = 'button';
    if (label) result.setAttribute('aria-label', label);
    result.addEventListener('click', callback);
    return result;
  }
  function enhance(input) {
    if (enhanced.has(input)) return enhanced.get(input);
    if (!(input instanceof HTMLInputElement) || input.type !== 'datetime-local') throw new TypeError('NotebookDeadline.enhance requires a datetime-local input.');
    const id = `planner-deadline-${++sequence}`;
    const button = action('', 'planner-deadline-trigger', () => {
      if (input.disabled || input.matches(':disabled')) return;
      if (opened) close();
      else open();
    });
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 20 20');
    icon.setAttribute('aria-hidden', 'true');
    icon.classList.add('planner-deadline-icon');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M5.5 2.5v3m9-3v3M3 8h14M4.5 4h11A1.5 1.5 0 0 1 17 5.5v10a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 15.5v-10A1.5 1.5 0 0 1 4.5 4ZM6.5 11h2m3 0h2m-7 3h2');
    icon.append(path);
    const caption = node('span', 'planner-deadline-caption');
    button.append(icon, caption);
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', id);
    input.hidden = true;
    input.insertAdjacentElement('afterend', button);

    const popover = node('div', 'planner-deadline-popover');
    popover.id = id;
    popover.setAttribute('popover', 'auto');
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-labelledby', `${id}-title`);
    const heading = node('div', 'planner-deadline-heading');
    const title = node('h3', '', '截止时间');
    title.id = `${id}-title`;
    heading.append(title, node('span', 'planner-deadline-optional', '可选'));
    const navigation = node('div', 'planner-deadline-navigation');
    const previous = action('‹', 'planner-deadline-nav', () => changeMonth(-1), '上个月');
    const next = action('›', 'planner-deadline-nav', () => changeMonth(1), '下个月');
    const month = node('span', 'planner-deadline-month');
    month.id = `${id}-month`;
    month.setAttribute('aria-live', 'polite');
    navigation.append(previous, month, next);
    const weekdays = node('div', 'planner-deadline-weekdays');
    weekdays.setAttribute('aria-hidden', 'true');
    for (const day of ['一', '二', '三', '四', '五', '六', '日']) weekdays.append(node('span', '', day));
    const calendar = node('div', 'planner-deadline-calendar');
    calendar.setAttribute('role', 'group');
    calendar.setAttribute('aria-labelledby', month.id);
    const shortcuts = node('div', 'planner-deadline-shortcuts');
    for (const [text, offset] of [['今天', 0], ['明天', 1], ['+7天', 7]]) {
      shortcuts.append(action(text, 'planner-deadline-shortcut', () => {
        const date = new Date();
        date.setHours(12, 0, 0, 0);
        date.setDate(date.getDate() + offset);
        selectDate(date);
      }));
    }
    const timeRow = node('label', 'planner-deadline-time-row');
    const time = node('input', 'planner-deadline-time');
    time.type = 'time';
    time.step = '60';
    time.setAttribute('aria-label', '截止时刻（本机时区）');
    timeRow.append(node('span', '', '时间'), time, node('span', 'planner-deadline-zone', '本机时区'));
    const selection = node('p', 'planner-deadline-selection');
    selection.setAttribute('aria-live', 'polite');
    const error = node('p', 'planner-deadline-error');
    error.id = `${id}-error`;
    error.setAttribute('role', 'alert');
    error.hidden = true;
    time.setAttribute('aria-describedby', error.id);
    const footer = node('div', 'planner-deadline-footer');
    const clear = action('清除', 'planner-deadline-clear', () => {
      draftDate = '';
      time.value = '';
      clearError();
      renderCalendar();
    });
    const cancel = action('取消', 'planner-deadline-cancel', close);
    const confirm = action('确定', 'planner-deadline-confirm', apply);
    footer.append(clear, cancel, confirm);
    popover.append(heading, navigation, weekdays, calendar, shortcuts, timeRow, selection, error, footer);

    let opened = false;
    let original = '';
    let originalParts = null;
    let draftDate = '';
    let view = new Date();
    let frame = 0;
    function clearError() {
      error.hidden = true;
      error.textContent = '';
      time.removeAttribute('aria-invalid');
    }
    function fail(message, target) {
      error.textContent = message;
      error.hidden = false;
      if (target === time) time.setAttribute('aria-invalid', 'true');
      target.focus({ preventScroll: true });
      position();
    }
    function refresh() {
      const value = parts(input.value);
      caption.textContent = value ? `${Number(value[1].split('-')[1])}/${Number(value[1].split('-')[2])} ${value[2]}` : '截止时间';
      button.classList.toggle('has-deadline', Boolean(value));
      button.disabled = input.disabled || input.matches(':disabled');
      const label = input.getAttribute('aria-label') || '截止时间（可选，使用本机时区）';
      button.setAttribute('aria-label', value ? `${label}：${value[1]} ${value[2]}` : label);
      button.title = value ? `${value[1]} ${input.value.split('T')[1]}（本机时区）` : label;
      if (button.disabled && opened) close();
      return api;
    }
    function renderCalendar(focusDate) {
      const year = view.getFullYear();
      const monthIndex = view.getMonth();
      month.textContent = `${year} 年 ${monthIndex + 1} 月`;
      previous.disabled = year <= 1 && monthIndex === 0;
      next.disabled = year >= 9999 && monthIndex === 11;
      calendar.replaceChildren();
      const first = localDay(year, monthIndex, 1);
      const offset = (first.getDay() + 6) % 7;
      const today = dateKey(new Date());
      for (let index = 0; index < 42; index++) {
        const date = localDay(year, monthIndex, index - offset + 1);
        const key = dateKey(date);
        const day = action(String(date.getDate()), 'planner-deadline-day', () => selectDate(date, true));
        day.dataset.date = key;
        day.classList.toggle('is-adjacent', date.getMonth() !== monthIndex);
        day.classList.toggle('is-today', key === today);
        day.setAttribute('aria-pressed', String(key === draftDate));
        day.setAttribute('aria-label', `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日，星期${['日', '一', '二', '三', '四', '五', '六'][date.getDay()]}`);
        if (key === today) day.setAttribute('aria-current', 'date');
        day.disabled = date.getFullYear() < 1 || date.getFullYear() > 9999;
        day.addEventListener('keydown', event => moveDay(event, date));
        calendar.append(day);
      }
      selection.textContent = draftDate ? `已选 ${draftDate.replace(/-/g, '/')} · 确定后生效` : '未选日期 · 可留空';
      if (focusDate) calendar.querySelector(`[data-date="${focusDate}"]`)?.focus({ preventScroll: true });
      if (opened) position();
    }
    function selectDate(date, focus = false) {
      draftDate = dateKey(date);
      view = localDay(date.getFullYear(), date.getMonth(), 1);
      clearError();
      renderCalendar(focus ? draftDate : null);
    }
    function changeMonth(delta) {
      const date = localDay(view.getFullYear(), view.getMonth() + delta, 1);
      if (date.getFullYear() < 1 || date.getFullYear() > 9999) return;
      view = date;
      clearError();
      renderCalendar();
    }
    function moveDay(event, date) {
      const increments = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
      const target = localDay(date.getFullYear(), date.getMonth(), date.getDate());
      if (Object.hasOwn(increments, event.key)) target.setDate(target.getDate() + increments[event.key]);
      else if (event.key === 'Home') target.setDate(target.getDate() - (target.getDay() + 6) % 7);
      else if (event.key === 'End') target.setDate(target.getDate() + 6 - (target.getDay() + 6) % 7);
      else if (event.key === 'PageUp' || event.key === 'PageDown') {
        const day = target.getDate();
        target.setDate(1);
        target.setMonth(target.getMonth() + (event.key === 'PageUp' ? -1 : 1));
        const last = localDay(target.getFullYear(), target.getMonth() + 1, 0).getDate();
        target.setDate(Math.min(day, last));
      } else return;
      event.preventDefault();
      if (target.getFullYear() < 1 || target.getFullYear() > 9999) return;
      view = localDay(target.getFullYear(), target.getMonth(), 1);
      renderCalendar(dateKey(target));
    }
    function position() {
      if (!opened) return;
      if (!button.isConnected || button.disabled) { close(); return; }
      const viewport = window.visualViewport;
      const leftEdge = (viewport?.offsetLeft || 0) + 8;
      const topEdge = (viewport?.offsetTop || 0) + 8;
      const rightEdge = leftEdge + (viewport?.width || window.innerWidth) - 16;
      const bottomEdge = topEdge + (viewport?.height || window.innerHeight) - 16;
      popover.style.maxHeight = `${Math.max(0, bottomEdge - topEdge)}px`;
      const anchor = button.getBoundingClientRect();
      const box = popover.getBoundingClientRect();
      const below = anchor.bottom + 7;
      const above = anchor.top - box.height - 7;
      const top = below + box.height <= bottomEdge ? below : above >= topEdge ? above : Math.max(topEdge, Math.min(below, bottomEdge - box.height));
      popover.style.left = `${Math.max(leftEdge, Math.min(anchor.left, rightEdge - box.width))}px`;
      popover.style.top = `${top}px`;
    }
    function schedulePosition(event) {
      if (event?.target instanceof Node && popover.contains(event.target)) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(position);
    }
    function finishClose() {
      if (!opened) return;
      opened = false;
      if (active === api) active = null;
      button.setAttribute('aria-expanded', 'false');
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedulePosition);
      document.removeEventListener('scroll', schedulePosition, true);
      window.visualViewport?.removeEventListener('resize', schedulePosition);
      window.visualViewport?.removeEventListener('scroll', schedulePosition);
      queueMicrotask(() => {
        if (!active && button.isConnected && !button.disabled) button.focus({ preventScroll: true });
      });
    }
    function close() {
      if (popover.matches(':popover-open')) popover.hidePopover();
      finishClose();
    }
    function open() {
      refresh();
      if (opened || button.disabled || !button.isConnected) return;
      if (active && active !== api) active.close();
      original = input.value;
      originalParts = parts(original);
      draftDate = originalParts?.[1] || '';
      time.value = originalParts?.[2] || '21:00';
      const selected = draftDate ? draftDate.split('-').map(Number) : null;
      const today = new Date();
      view = selected ? localDay(selected[0], selected[1] - 1, 1) : localDay(today.getFullYear(), today.getMonth(), 1);
      clearError();
      renderCalendar();
      // Keeping the popover inside its owning dialog avoids modal inertness.
      (input.closest('dialog') || document.body).append(popover);
      popover.showPopover();
      opened = true;
      active = api;
      button.setAttribute('aria-expanded', 'true');
      position();
      const focusDate = draftDate || dateKey(today);
      (calendar.querySelector(`[data-date="${focusDate}"]`) || calendar.querySelector('button:not(:disabled)')).focus({ preventScroll: true });
      window.addEventListener('resize', schedulePosition);
      document.addEventListener('scroll', schedulePosition, true);
      window.visualViewport?.addEventListener('resize', schedulePosition);
      window.visualViewport?.addEventListener('scroll', schedulePosition);
    }
    function apply() {
      if (input.disabled || input.matches(':disabled')) { close(); return; }
      if (!draftDate && time.value) { fail('请选择日期，或清除截止时间。', calendar.querySelector('button:not(:disabled)')); return; }
      if (draftDate && !time.value) { fail('请填写时间，或清除截止时间。', time); return; }
      let value = draftDate ? `${draftDate}T${time.value}` : '';
      // A minute-only display must never truncate an untouched stored deadline.
      if (value && originalParts && draftDate === originalParts[1] && time.value === originalParts[2]) value = original;
      if (value && !validLocal(value)) { fail('该本地时间无效，请重新选择日期和时间。', time); return; }
      input.value = value;
      refresh();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      close();
    }
    popover.addEventListener('beforetoggle', event => {
      if (event.newState === 'closed') finishClose();
    });
    popover.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    });
    time.addEventListener('input', clearError);
    input.addEventListener('input', refresh);
    input.addEventListener('change', refresh);
    input.form?.addEventListener('reset', () => queueMicrotask(() => { close(); refresh(); }));
    const observer = new MutationObserver(refresh);
    observer.observe(input, { attributes: true, attributeFilter: ['disabled', 'value', 'aria-label'] });
    const api = { input, button, popover, refresh, open, close };
    enhanced.set(input, api);
    refresh();
    return api;
  }
  window.NotebookDeadline = Object.freeze({ enhance, attach: enhance });
})();
