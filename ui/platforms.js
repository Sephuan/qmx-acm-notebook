/* Public platform profiles are independent of the GitHub account and stay on this device. */
(() => {
  'use strict';
  const platforms = [
    { code: 'CF', name: 'Codeforces', example: 'https://codeforces.com/profile/tourist', hosts: ['codeforces.com', 'www.codeforces.com'], profile: /^\/profile\/[^/]+\/?$/ },
    { code: 'AT', name: 'AtCoder', example: 'https://atcoder.jp/users/tourist', hosts: ['atcoder.jp', 'www.atcoder.jp'], profile: /^\/users\/[^/]+\/?$/ },
    { code: 'LG', name: '洛谷', example: 'https://www.luogu.com.cn/user/1', hosts: ['luogu.com.cn', 'www.luogu.com.cn', 'luogu.com', 'www.luogu.com'], profile: /^\/user\/\d+\/?$/ },
    { code: 'NC', name: '牛客', example: 'https://ac.nowcoder.com/acm/contest/profile/1', hosts: ['ac.nowcoder.com', 'www.nowcoder.com', 'nowcoder.com'], profile: /^\/(?:profile|users|acm\/contest\/profile)\/\d+\/?$/ },
    { code: 'LC', name: 'LeetCode', example: 'https://leetcode.cn/u/leetcode/', hosts: ['leetcode.cn', 'www.leetcode.cn', 'leetcode.com', 'www.leetcode.com'], profile: /^\/u\/[^/]+\/?$/ }
  ];
  const pending = new Set();
  const localErrors = new Map();
  let state = {};
  let selected = 'ALL';
  let expanded = false;
  let activityPeriod = 'recent';
  let bridge;
  let onSettings;
  let modalCode = null;
  let dialog;
  let input;
  let modalError;
  let saveButton;
  let unlinkButton;
  let closeButton;
  let cancelButton;
  let floatingTip;
  let tipTarget;

  function dismissTip() {
    if (!floatingTip) return;
    floatingTip.hidden = true;
    if (tipTarget) tipTarget.removeAttribute('aria-describedby');
    tipTarget = null;
  }
  function ensureTip() {
    if (floatingTip) return;
    floatingTip = element('div', 'platform-floating-tooltip');
    floatingTip.id = 'platform-floating-tooltip';
    floatingTip.setAttribute('role', 'tooltip');
    floatingTip.hidden = true;
    document.body.append(floatingTip);
    document.addEventListener('keydown', event => { if (event.key === 'Escape') dismissTip(); });
    document.addEventListener('scroll', dismissTip, true);
    window.addEventListener('resize', dismissTip);
    window.addEventListener('blur', dismissTip);
    document.addEventListener('pointerdown', event => {
      if (tipTarget && !tipTarget.contains(event.target)) dismissTip();
    });
  }
  function showTip(target, lines) {
    ensureTip();
    dismissTip();
    tipTarget = target;
    floatingTip.replaceChildren(...lines.map((line, index) => element(line.bold ? 'strong' : 'div', `platform-tooltip-line${index === 0 ? ' platform-tooltip-first' : ''}`, line.text)));
    target.setAttribute('aria-describedby', floatingTip.id);
    floatingTip.hidden = false;
    const viewport = window.visualViewport;
    const leftEdge = viewport?.offsetLeft || 0;
    const topEdge = viewport?.offsetTop || 0;
    const width = viewport?.width || window.innerWidth;
    const height = viewport?.height || window.innerHeight;
    const margin = 8;
    floatingTip.style.maxWidth = `${Math.max(0, width - margin * 2)}px`;
    floatingTip.style.maxHeight = `${Math.max(0, height - margin * 2)}px`;
    const anchor = target.getBoundingClientRect();
    const rect = floatingTip.getBoundingClientRect();
    const left = Math.max(leftEdge + margin, Math.min(anchor.left + anchor.width / 2 - rect.width / 2, leftEdge + width - margin - rect.width));
    const below = anchor.bottom + margin;
    const top = Math.max(topEdge + margin, Math.min(below + rect.height <= topEdge + height - margin ? below : anchor.top - margin - rect.height, topEdge + height - margin - rect.height));
    floatingTip.style.left = `${left}px`;
    floatingTip.style.top = `${top}px`;
  }
  function attachTip(target, lines) {
    const reveal = () => showTip(target, lines);
    target.removeAttribute('title');
    target.setAttribute('aria-label', lines.map(line => line.text).join('，'));
    if (!target.matches('a,button,[tabindex]')) target.tabIndex = 0;
    target.addEventListener('mouseenter', reveal);
    target.addEventListener('focus', reveal);
    target.addEventListener('focusin', reveal);
    target.addEventListener('click', reveal);
    target.addEventListener('mouseleave', () => { if (tipTarget === target) dismissTip(); });
    target.addEventListener('blur', () => { if (tipTarget === target) dismissTip(); });
    target.addEventListener('focusout', event => { if (!target.contains(event.relatedTarget) && tipTarget === target) dismissTip(); });
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }
  function button(text, className, action) {
    const node = element('button', className, text);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  }
  function metadata(code) { return platforms.find(platform => platform.code === code); }
  function entry(code) { return state[code] || {}; }
  function bound(code) { return Boolean(entry(code).binding); }
  function username(code) {
    const value = entry(code);
    return String(value.binding?.username || value.data?.username || value.binding?.id || '未知用户');
  }
  function number(value) { return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '暂无数据'; }
  function time(value) {
    if (!value) return '尚未刷新';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function errorText(error) {
    const text = typeof error === 'string' ? error : error?.message;
    return String(text || '操作失败，请稍后重试。');
  }
  function safeURL(value, code, profileOnly = false) {
    try {
      const url = new URL(value);
      const platform = metadata(code);
      if (!platform || url.protocol !== 'https:' || url.username || url.password || url.port || !platform.hosts.includes(url.hostname)) return null;
      if (profileOnly && !platform.profile.test(url.pathname)) return null;
      return url.href;
    } catch { return null; }
  }
  function external(text, url, code, className) {
    const safe = safeURL(url, code);
    if (!safe || typeof bridge?.openExternal !== 'function') return element('span', className, text);
    const link = element('a', className, text);
    link.href = safe;
    link.addEventListener('click', async event => {
      event.preventDefault();
      try { await bridge.openExternal(safe); }
      catch (error) { localErrors.set(code, errorText(error)); draw(); }
    });
    return link;
  }
  function metric(label, value, key) {
    const node = element('div', 'platform-metric');
    const strong = element('strong', '', number(value));
    strong.dataset.metric = key;
    if (typeof value !== 'number' || !Number.isFinite(value)) strong.className = 'platform-unknown';
    node.append(strong, element('span', '', label));
    return node;
  }
  function known(value) { return typeof value === 'number' && Number.isFinite(value); }
  function scope() { return selected === 'ALL' ? platforms : platforms.filter(platform => platform.code === selected); }
  function coverage(count, total) { return `${count}/${total} 平台有数据`; }
  function dateLabel(value) {
    const date = new Date(value);
    return value && !Number.isNaN(date.getTime()) ? date.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '日期未知';
  }
  function ratingChange(contest) {
    const delta = known(contest.delta) ? `${contest.delta > 0 ? '+' : ''}${contest.delta}` : null;
    if (known(contest.rating) && delta !== null) return `Rating ${contest.rating - contest.delta} → ${contest.rating}（${delta}）`;
    if (known(contest.rating)) return `Rating ${contest.rating}`;
    return delta !== null ? `Rating 变化 ${delta}` : null;
  }
  function contestScore(contest) {
    const solved = contest.solvedCount;
    const total = contest.problemCount;
    return Number.isSafeInteger(solved) && Number.isSafeInteger(total) && solved >= 0 && total >= 0 && solved <= total ? `${solved}/${total}` : null;
  }
  function contestLines(contest) {
    const lines = [{ text: String(contest.name || '未命名比赛'), bold: true }];
    const change = ratingChange(contest);
    const score = contestScore(contest);
    if (change) lines.push({ text: change });
    if (score) lines.push({ text: score });
    return lines;
  }
  function contestDetails(contest) {
    const parts = [dateLabel(contest.date)];
    if (contest.rank !== null && contest.rank !== undefined && contest.rank !== '') parts.push(`排名 ${contest.rank}`);
    const change = ratingChange(contest);
    const score = contestScore(contest);
    if (change) parts.push(change);
    if (score) parts.push(score);
    return parts.join(' · ');
  }
  function recentContests(targets = platforms) {
    return targets.filter(({ code }) => bound(code)).flatMap(({ code }) => {
      const contests = entry(code).data?.contests;
      return (Array.isArray(contests) ? contests : []).map(contest => ({ ...contest, code }));
    }).sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  }
  function drawSummary(panel, contests) {
    const metrics = element('div', 'platform-metrics');
    for (const [field, label, key] of [['solvedCount', '总解题', 'solved'], ['submissionCount', '总提交', 'submissions']]) {
      const values = scope().filter(({ code }) => bound(code) && known(entry(code).data?.[field]));
      const total = values.length ? values.reduce((sum, { code }) => sum + entry(code).data[field], 0) : null;
      const node = metric(selected === 'ALL' ? `${label} · 已知合计` : label, total, key);
      node.append(element('small', 'platform-coverage', coverage(values.length, scope().length)));
      metrics.append(node);
    }
    const latest = element('div', 'platform-metric platform-latest');
    latest.append(element('span', '', '最近比赛'));
    if (contests.length) {
      const contest = contests[0];
      latest.append(external(contest.name || '未命名比赛', contest.url, contest.code, 'platform-latest-name'));
      latest.append(element('small', 'platform-coverage', `${contest.code} · ${dateLabel(contest.date)}`));
      const supplement = [ratingChange(contest), contestScore(contest)].filter(Boolean);
      if (supplement.length) latest.append(element('small', 'platform-latest-result', supplement.join(' · ')));
      attachTip(latest, contestLines(contest));
    } else latest.append(element('strong', 'platform-unknown', '暂无数据'));
    const covered = scope().filter(({ code }) => bound(code) && Array.isArray(entry(code).data?.contests)).length;
    latest.append(element('small', 'platform-coverage', coverage(covered, scope().length)));
    metrics.append(latest);
    panel.append(metrics);
    panel.append(element('p', 'platform-sum-note', '解题数为各平台已解题数相加，同一道题跨平台不去重；未知数据不计为 0。'));
  }
  function svgElement(tag, attributes = {}, text) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
    if (text !== undefined) node.textContent = String(text);
    return node;
  }
  function drawRatingChart(code) {
    const data = entry(code).data || {};
    const raw = Array.isArray(data.ratingHistory) ? data.ratingHistory : [];
    const points = raw.filter(point => known(point.rating) && Number.isFinite(Date.parse(point.date))).slice().sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    const figure = element('figure', 'platform-rating-chart');
    figure.dataset.platform = code;
    const caption = element('figcaption');
    caption.append(element('strong', '', `${metadata(code).name} Rating`), element('span', 'platform-coverage', '独立刻度'));
    figure.append(caption);
    if (!points.length) { figure.append(element('p', 'platform-chart-empty', '暂无 Rating 历史数据')); return figure; }
    const low = Math.min(...points.map(point => point.rating));
    const high = Math.max(...points.map(point => point.rating));
    const padding = Math.max(50, Math.ceil((high - low) * .12));
    const min = Math.max(0, low - padding);
    const max = Math.max(min + 100, high + padding);
    const first = Date.parse(points[0].date);
    const last = Date.parse(points[points.length - 1].date);
    const x = point => first === last ? 288 : 48 + (Date.parse(point.date) - first) / (last - first) * 480;
    const y = point => 154 - (point.rating - min) / (max - min) * 130;
    const svg = svgElement('svg', { viewBox: '0 0 560 190', role: 'group', 'aria-label': `${metadata(code).name} Rating 历史，独立刻度 ${Math.round(min)} 至 ${Math.round(max)}` });
    for (let index = 0; index < 3; index++) {
      const value = min + (max - min) * index / 2;
      const pos = 154 - index * 65;
      svg.append(svgElement('line', { x1: 48, y1: pos, x2: 528, y2: pos, class: 'platform-chart-grid' }));
      svg.append(svgElement('text', { x: 40, y: pos + 4, 'text-anchor': 'end', class: 'platform-chart-axis' }, Math.round(value)));
    }
    svg.append(svgElement('text', { x: 48, y: 178, class: 'platform-chart-axis' }, dateLabel(points[0].date)));
    svg.append(svgElement('text', { x: 528, y: 178, 'text-anchor': 'end', class: 'platform-chart-axis' }, dateLabel(points[points.length - 1].date)));
    svg.append(svgElement('polyline', { points: points.map(point => `${x(point)},${y(point)}`).join(' '), class: 'platform-chart-line', fill: 'none' }));
    points.forEach((point, index) => {
      const dot = svgElement('circle', { cx: x(point), cy: y(point), r: 4, tabindex: '0', class: 'platform-chart-point', 'data-index': index });
      attachTip(dot, contestLines(point));
      svg.append(dot);
    });
    figure.append(svg);
    return figure;
  }
  function dayKey(date) { return date.toISOString().slice(0, 10); }
  function activityRange() {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const end = new Date(`${today}T00:00:00Z`);
    const start = new Date(end);
    if (activityPeriod === 'recent') { start.setUTCFullYear(start.getUTCFullYear() - 1); start.setUTCDate(start.getUTCDate() + 1); }
    else { start.setUTCFullYear(Number(activityPeriod), 0, 1); end.setUTCFullYear(Number(activityPeriod), 11, 31); }
    return { start, end, year: Number(today.slice(0, 4)) };
  }
  function activityData(code) {
    const activity = bound(code) ? entry(code).data?.activity : null;
    return activity && activity.days && typeof activity.days === 'object' && !Array.isArray(activity.days) ? activity : null;
  }
  function activityCount(activity, key) {
    if (!activity) return null;
    if (Object.prototype.hasOwnProperty.call(activity.days, key) && known(activity.days[key]) && activity.days[key] >= 0) return activity.days[key];
    if (activity.complete === true) return 0;
    if (activity.rangeComplete === true && /^\d{4}-\d{2}-\d{2}$/.test(activity.startDate) && /^\d{4}-\d{2}-\d{2}$/.test(activity.endDate) && key >= activity.startDate && key <= activity.endDate) return 0;
    return null;
  }
  function drawActivity(panel) {
    const section = element('section', 'platform-activity');
    const heading = element('div', 'platform-subheading');
    heading.append(element('h3', '', '每日解题'));
    const range = activityRange();
    const label = element('label', 'platform-period-label', '时间范围');
    const select = element('select', 'platform-select');
    select.id = 'platform-activity-period';
    select.setAttribute('aria-label', '每日解题时间范围');
    for (const [value, title] of [['recent', '最近一年'], [String(range.year - 1), `${range.year - 1} 年`]]) {
      const option = element('option', '', title); option.value = value; select.append(option);
    }
    select.value = activityPeriod;
    select.addEventListener('change', () => { activityPeriod = select.value; updateScope(); });
    label.append(select); heading.append(label); section.append(heading);
    const available = scope().filter(({ code }) => {
      const activity = activityData(code);
      return activity && (activity.complete === true || activity.rangeComplete === true || Object.values(activity.days).some(value => known(value) && value >= 0));
    });
    const complete = available.filter(({ code }) => activityData(code).complete === true);
    const coverageText = `日历覆盖 ${available.length}/${scope().length} 平台 · 完整历史 ${complete.length}/${scope().length} 平台`;
    section.append(element('p', 'platform-activity-note', `${coverageText} · Asia/Shanghai`));
    section.append(element('p', 'platform-activity-note', 'CF / AT / 牛客按每题首次 AC 计数；洛谷采用官方每日通过题数。各平台统计口径见数据说明。'));
    const incomplete = scope().filter(({ code }) => !activityData(code) || activityData(code).complete !== true);
    if (incomplete.length) section.append(element('p', 'platform-activity-note', `覆盖不完整：${incomplete.map(({ code }) => code).join('、')}；仅汇总已提供日期与已确认完整区间，缺失数据不视为 0。`));
    for (const { code } of available) {
      const activity = activityData(code);
      if (activity.rangeComplete === true && activity.startDate && activity.endDate) section.append(element('p', 'platform-activity-note', `${code} 完整区间：${activity.startDate} 至 ${activity.endDate}`));
    }
    if (!available.length) {
      section.append(element('p', 'platform-chart-empty', '暂无每日解题数据，旧缓存或平台未提供日历。刷新后仍不可用时请查看数据说明。'));
      panel.append(section); return;
    }
    const scroll = element('div', 'platform-heatmap-scroll');
    const months = element('div', 'platform-heatmap-months');
    const grid = element('div', 'platform-heatmap-grid');
    grid.setAttribute('role', 'group'); grid.setAttribute('aria-label', '每日解题数日历，方向键移动，悬停或聚焦查看详情');
    const day = new Date(range.start);
    const offset = (day.getUTCDay() + 6) % 7;
    for (let index = 0; index < offset; index++) { const spacer = element('span', 'platform-heatmap-spacer'); spacer.setAttribute('aria-hidden', 'true'); grid.append(spacer); }
    let index = offset;
    let lastMonth = -1;
    let total = 0;
    while (day <= range.end) {
      const key = dayKey(day);
      const counts = scope().map(({ code }) => ({ code, count: activityCount(activityData(code), key) }));
      const knownCounts = counts.filter(item => item.count !== null);
      const count = knownCounts.reduce((sum, item) => sum + item.count, 0);
      total += count;
      const partial = knownCounts.length < scope().length;
      const lines = [{ text: key }, { text: knownCounts.length ? `总通过：${number(count)}道${partial ? '（已知）' : ''}` : '暂无数据' }];
      const cell = button('', 'platform-heatmap-day', () => {});
      const level = !knownCounts.length || (partial && count === 0) ? 'unknown' : String(count === 0 ? 0 : count <= 2 ? 1 : count <= 5 ? 2 : count <= 9 ? 3 : 4);
      cell.dataset.date = key; cell.dataset.level = level; cell.dataset.count = knownCounts.length ? String(count) : ''; cell.dataset.partial = String(partial);
      cell.tabIndex = key === dayKey(range.end) ? 0 : -1;
      attachTip(cell, lines);
      cell.addEventListener('keydown', event => {
        const move = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[event.key];
        const cells = [...grid.querySelectorAll('.platform-heatmap-day')];
        let target = cells.indexOf(cell) + move;
        if (event.key === 'Home') target = 0;
        else if (event.key === 'End') target = cells.length - 1;
        else if (move === undefined) return;
        event.preventDefault(); target = Math.max(0, Math.min(cells.length - 1, target));
        cells.forEach(node => { node.tabIndex = -1; }); cells[target].tabIndex = 0; cells[target].focus();
      });
      grid.append(cell);
      if (day.getUTCMonth() !== lastMonth) {
        const month = element('span', '', `${day.getUTCMonth() + 1}月`);
        month.dataset.week = String(Math.floor(index / 7));
        months.append(month); lastMonth = day.getUTCMonth();
      }
      index++; day.setUTCDate(day.getUTCDate() + 1);
    }
    const weeks = Math.ceil(index / 7);
    const monthLabels = new Map([...months.children].map(node => [Number(node.dataset.week), node.textContent]));
    months.replaceChildren(...Array.from({ length: weeks }, (_, week) => element('span', '', monthLabels.get(week) || '')));
    // Grid column counts use classes, keeping this module compatible with the page CSP.
    scroll.classList.add(`platform-heatmap-weeks-${weeks}`);
    const weekdays = element('div', 'platform-heatmap-weekdays');
    for (const text of ['一', '', '三', '', '五', '', '日']) weekdays.append(element('span', '', text));
    const calendar = element('div', 'platform-heatmap-calendar'); calendar.append(weekdays, grid);
    scroll.append(months, calendar);
    const legend = element('div', 'platform-heatmap-legend');
    legend.append(element('span', '', `本范围已知合计 ${number(total)} 题`), element('span', '', '少'));
    for (const level of ['0', '1', '2', '3', '4', 'unknown']) {
      const swatch = element('span', 'platform-heatmap-swatch'); swatch.dataset.level = level;
      swatch.title = level === 'unknown' ? '数据缺失或覆盖不完整' : `强度 ${level}`; legend.append(swatch);
    }
    legend.append(element('span', '', '多 / 未知'));
    section.append(scroll, legend); panel.append(section);
  }
  function syncRefresh() {
    const refresh = document.getElementById('platform-refresh-all');
    if (!refresh) return;
    const targets = scope().filter(({ code }) => bound(code));
    const busy = targets.some(({ code }) => pending.has(code));
    refresh.textContent = busy ? '刷新中…' : selected === 'ALL' ? '刷新全部' : '刷新平台';
    refresh.disabled = busy || !targets.length || typeof bridge?.refreshPlatform !== 'function';
  }
  function updateScope() {
    dismissTip();
    const panel = document.querySelector('#platform-overview .platform-dashboard');
    if (!panel) return;
    panel.dataset.platform = selected;
    const summary = panel.querySelector('.platform-summary');
    if (summary) { summary.replaceChildren(); drawSummary(summary, recentContests(scope())); }
    const activity = panel.querySelector('.platform-activity');
    if (activity) {
      const holder = element('div'); drawActivity(holder); activity.replaceWith(...holder.childNodes);
    }
    syncRefresh();
  }
  function drawOverview() {
    dismissTip();
    const root = document.getElementById('platform-overview');
    if (!root) return;
    const panel = element('article', `platform-dashboard${expanded ? ' is-expanded' : ''}`);
    panel.dataset.platform = selected;
    const heading = element('div', 'platform-section-heading');
    const copy = element('div');
    const title = element('h2', '', '做题与比赛总览'); title.id = 'platform-overview-title';
    copy.append(title, element('p', '', '公开主页数据 · 仅保存在本机 · 独立于 GitHub 账户'));
    const actions = element('div', 'platform-dashboard-actions');
    const select = element('select', 'platform-select'); select.id = 'platform-select'; select.setAttribute('aria-label', '选择统计平台');
    for (const platform of [{ code: 'ALL', name: '全部平台 · 汇总' }, ...platforms]) {
      const option = element('option', '', platform.code === 'ALL' ? platform.name : `${platform.code} · ${platform.name}`); option.value = platform.code; select.append(option);
    }
    select.value = selected;
    select.addEventListener('change', () => { selected = select.value; updateScope(); });
    const targets = platforms.filter(({ code }) => bound(code));
    const refreshTargets = scope().filter(({ code }) => bound(code));
    const busy = refreshTargets.some(({ code }) => pending.has(code));
    const refresh = button(busy ? '刷新中…' : selected === 'ALL' ? '刷新全部' : '刷新平台', 'platform-button', () => selected === 'ALL' ? refreshAll() : refreshPlatform(selected));
    refresh.id = 'platform-refresh-all'; refresh.disabled = busy || !refreshTargets.length || typeof bridge?.refreshPlatform !== 'function';
    const settings = button('账号设置', 'platform-button', () => { if (typeof onSettings === 'function') onSettings(); });
    settings.id = 'platform-settings'; settings.disabled = typeof onSettings !== 'function';
    const toggle = button(expanded ? '收起统计' : '展开统计', 'platform-button', () => { expanded = !expanded; drawOverview(); document.getElementById('platform-expand')?.focus(); });
    toggle.id = 'platform-expand'; toggle.setAttribute('aria-expanded', String(expanded));
    actions.append(select, refresh, settings, toggle); heading.append(copy, actions); panel.append(heading);
    if (!targets.length) {
      const empty = element('div', 'platform-dashboard-empty');
      empty.append(element('strong', '', selected === 'ALL' ? '尚未绑定平台账号' : `${metadata(selected).name} 尚未绑定账号`), element('p', '', '在账号设置中添加公开主页，查看真实的解题、比赛和每日进展。'));
      const go = button('去设置绑定', 'platform-button', () => { if (typeof onSettings === 'function') onSettings(); }); go.disabled = typeof onSettings !== 'function';
      empty.append(go); panel.append(empty);
    } else {
      const accounts = element('div', 'platform-account-strip');
      for (const { code } of targets) accounts.append(external(`${code} · ${username(code)}`, entry(code).data?.profileUrl || entry(code).binding.url, code, 'platform-username'));
      panel.append(accounts);
      const contests = recentContests();
      const summary = element('div', 'platform-summary'); drawSummary(summary, recentContests(scope())); panel.append(summary);
      const charts = element('div', 'platform-rating-charts');
      for (const code of ['CF', 'AT']) charts.append(drawRatingChart(code));
      if (charts.childElementCount) panel.append(charts);
      drawActivity(panel);
      const recent = element('section', 'platform-recent'); recent.append(element('h3', '', '最近比赛记录'));
      if (!contests.length) recent.append(element('p', 'platform-chart-empty', '暂无比赛数据'));
      for (const contest of contests.slice(0, expanded ? 8 : 3)) {
        const row = element('div', 'platform-contest');
        row.append(element('span', 'platform-contest-platform', contest.code), external(String(contest.name || '未命名比赛'), contest.url, contest.code, 'platform-contest-name'), element('span', 'platform-contest-details', contestDetails(contest)));
        attachTip(row, contestLines(contest)); recent.append(row);
      }
      panel.append(recent);
      const notes = element('details', 'platform-source-details'); notes.append(element('summary', '', '数据来源与覆盖说明'));
      for (const { code } of targets) {
        const value = entry(code); const data = value.data || {};
        notes.append(element('p', 'platform-source-note', `${metadata(code).name}：${data.sourceNote || '数据来自平台公开页面；不可获取的字段显示暂无数据。'}`));
        if (data.activity?.note) notes.append(element('p', 'platform-source-note', `${code} 每日解题：${data.activity.note}`));
        notes.append(element('p', 'platform-updated', `${code} 上次成功刷新：${time(value.updatedAt)}`));
        const error = localErrors.get(code) || value.error;
        if (error) {
          const failure = element('p', 'platform-error', `${code}：${value.data ? '保留上次数据。' : ''}${errorText(error)}`); failure.dataset.platform = code; failure.setAttribute('role', 'status'); panel.append(failure);
          if (value.attemptedAt) notes.append(element('p', 'platform-updated', `${code} 最近尝试：${time(value.attemptedAt)}`));
        }
      }
      panel.append(notes);
    }
    root.classList.add('notebook-platforms'); root.setAttribute('aria-labelledby', 'platform-overview-title'); root.replaceChildren(panel);
  }
  function drawBindings() {
    const root = document.getElementById('platform-bindings');
    if (!root) return;
    const title = element('h3', '', '竞赛平台账号');
    title.id = 'platform-bindings-title';
    const help = element('p', 'platform-settings-note', '粘贴公开个人主页即可绑定，无需密码或 Token。绑定与缓存仅保存在本机，不受 GitHub 登录、退出或切换影响。');
    const rows = element('div', 'platform-binding-rows');
    for (const platform of platforms) {
      const row = element('div', 'platform-binding-row');
      row.dataset.platform = platform.code;
      const label = element('span', 'platform-binding-name', platform.name);
      const action = button(bound(platform.code) ? username(platform.code) : '绑定账号', 'platform-button platform-bind-account', () => openDialog(platform.code));
      action.disabled = pending.has(platform.code);
      row.append(label, action);
      rows.append(row);
    }
    root.classList.add('notebook-platforms', 'platform-settings');
    root.setAttribute('aria-labelledby', 'platform-bindings-title');
    root.replaceChildren(title, help, rows);
  }
  function draw() {
    drawOverview();
    drawBindings();
    if (modalCode) syncDialog();
  }
  function showError(message) {
    modalError.textContent = message || '';
    modalError.hidden = !message;
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
  }
  function syncDialog() {
    const busy = pending.has(modalCode);
    input.disabled = busy;
    saveButton.disabled = busy || typeof bridge?.bindPlatform !== 'function';
    unlinkButton.disabled = busy || typeof bridge?.unbindPlatform !== 'function';
    unlinkButton.hidden = !bound(modalCode);
    closeButton.disabled = busy;
    cancelButton.disabled = busy;
    saveButton.textContent = busy ? '处理中…' : '绑定账号';
    dialog.setAttribute('aria-busy', String(busy));
  }
  function closeDialog() {
    if (modalCode && pending.has(modalCode)) return;
    dialog.close();
    modalCode = null;
  }
  function ensureDialog() {
    if (dialog) return;
    dialog = element('dialog', 'platform-bind-dialog');
    dialog.id = 'platform-bind-dialog';
    dialog.setAttribute('aria-labelledby', 'platform-bind-title');
    dialog.setAttribute('aria-describedby', 'platform-bind-description');
    const form = element('form');
    form.noValidate = true;
    const heading = element('div', 'platform-dialog-heading');
    const title = element('h2');
    title.id = 'platform-bind-title';
    closeButton = button('✕', 'platform-dialog-close', closeDialog);
    closeButton.setAttribute('aria-label', '关闭绑定窗口');
    heading.append(title, closeButton);
    const description = element('p', 'platform-dialog-description', '粘贴你的 HTTPS 公开个人主页链接。无需登录平台、密码或 Token。');
    description.id = 'platform-bind-description';
    const label = element('label', 'platform-url-label', '个人主页 URL');
    input = element('input');
    input.id = 'platform-bind-url';
    input.type = 'url';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.maxLength = 2048;
    input.setAttribute('aria-describedby', 'platform-bind-example platform-bind-error');
    input.addEventListener('input', () => showError(''));
    label.append(input);
    const example = element('p', 'platform-url-example');
    example.id = 'platform-bind-example';
    modalError = element('p', 'platform-error platform-modal-error');
    modalError.id = 'platform-bind-error';
    modalError.setAttribute('role', 'alert');
    modalError.hidden = true;
    const actions = element('div', 'platform-dialog-actions');
    unlinkButton = button('解除绑定', 'platform-button platform-unlink', () => mutate(modalCode, 'unbindPlatform'));
    unlinkButton.id = 'platform-unbind';
    cancelButton = button('取消', 'platform-button', closeDialog);
    saveButton = element('button', 'platform-button platform-primary', '绑定账号');
    saveButton.id = 'platform-bind-submit';
    saveButton.type = 'submit';
    actions.append(unlinkButton, cancelButton, saveButton);
    form.append(heading, description, label, example, modalError, actions);
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (pending.has(modalCode)) return;
      const url = input.value.trim();
      if (!url) { showError('请粘贴个人主页链接。'); input.focus(); return; }
      if (!safeURL(url, modalCode, true)) { showError(`请使用 ${metadata(modalCode).name} 官方个人主页的 HTTPS 链接。`); input.focus(); return; }
      mutate(modalCode, 'bindPlatform', url);
    });
    dialog.addEventListener('cancel', event => {
      if (modalCode && pending.has(modalCode)) event.preventDefault();
      else modalCode = null;
    });
    dialog.append(form);
    document.body.append(dialog);
  }
  function openDialog(code) {
    if (!metadata(code) || pending.has(code)) return;
    ensureDialog();
    modalCode = code;
    const platform = metadata(code);
    document.getElementById('platform-bind-title').textContent = `绑定 ${platform.name}`;
    document.getElementById('platform-bind-example').textContent = `例如：${platform.example}`;
    input.placeholder = platform.example;
    input.value = entry(code).binding?.url || '';
    showError('');
    syncDialog();
    if (!dialog.open) dialog.showModal();
    input.focus();
  }
  async function mutate(code, method, url) {
    if (!metadata(code) || pending.has(code) || typeof bridge?.[method] !== 'function') return;
    pending.add(code);
    localErrors.delete(code);
    if (modalCode === code) showError('');
    draw();
    let success = false;
    try {
      const result = await bridge[method](code, ...(url === undefined ? [] : [url]));
      if (!result || typeof result !== 'object') throw new Error('平台没有返回有效数据，请重试。');
      const next = result[code];
      if (method !== 'unbindPlatform' && !next) throw new Error('平台没有返回该账号的数据，请重试。');
      // Responses are full mappings. Other codes may be older than their own in-flight results.
      if (next) state = { ...state, [code]: next };
      else { state = { ...state }; delete state[code]; }
      if (next?.error && method === 'bindPlatform') {
        if (modalCode === code) showError(errorText(next.error));
      } else success = true;
    } catch (error) {
      localErrors.set(code, errorText(error));
      if (modalCode === code) showError(errorText(error));
    } finally {
      pending.delete(code);
      draw();
      if (success && modalCode === code && method !== 'refreshPlatform') closeDialog();
    }
  }
  function refreshPlatform(code) {
    if (!bound(code)) return Promise.resolve();
    return mutate(code, 'refreshPlatform');
  }
  async function refreshAll() {
    await Promise.all(platforms.filter(platform => bound(platform.code) && !pending.has(platform.code)).map(platform => refreshPlatform(platform.code)));
  }
  function init(options = {}) {
    bridge = options.bridge || window.notebook;
    onSettings = options.onSettings;
    ensureDialog();
    draw();
    return window.NotebookPlatforms;
  }
  function render(mapping = {}) {
    const next = mapping && typeof mapping === 'object' ? mapping : {};
    const merged = {};
    for (const { code } of platforms) {
      if (pending.has(code)) { if (state[code]) merged[code] = state[code]; }
      else if (next[code]) merged[code] = next[code];
    }
    state = merged;
    if (!bridge) bridge = window.notebook;
    draw();
  }
  window.NotebookPlatforms = Object.freeze({ init, render, refreshAll, refreshPlatform, openDialog });
})();
