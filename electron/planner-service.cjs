'use strict';
const { randomUUID } = require('node:crypto');

const LIMIT = 500;
const LAYOUTS = new Set(['balanced', 'compact', 'focus']);
const PROBLEM_PATHS = [
  [['codeforces.com', 'www.codeforces.com', 'contest.codeforces.com'], /^\/(?:problemset\/problem\/\d+\/[A-Za-z]\d*|(?:contest|gym)\/\d+\/problem\/[A-Za-z]\d*|problemsets\/acmsguru\/problem\/\d+\/\d+)\/?$/],
  [['atcoder.jp', 'www.atcoder.jp'], /^\/contests\/[\w-]+\/tasks\/[\w-]+\/?$/],
  [['luogu.com.cn', 'www.luogu.com.cn', 'luogu.com', 'www.luogu.com'], /^\/problem\/[A-Za-z0-9_-]+\/?$/],
  [['ac.nowcoder.com', 'www.nowcoder.com', 'nowcoder.com'], /^\/acm\/(?:problem\/\d+|contest\/\d+\/[A-Za-z0-9]+)\/?$/],
  [['leetcode.cn', 'leetcode.com', 'www.leetcode.cn', 'www.leetcode.com'], /^\/(?:problems\/[a-z0-9-]+(?:\/(?:description|solutions|submissions|discuss))?|contest\/[a-z0-9-]+\/problems\/[a-z0-9-]+)\/?$/],
  [['hydro.ac'], /^\/(?:d\/[\w-]+\/)?p\/[A-Za-z0-9_-]+\/?$/],
  [['acwing.com', 'www.acwing.com'], /^\/problem\/content\/(?:description\/)?\d+\/?$/]
];
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value, name, max, optional = false) {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error(`${name}格式或长度无效（最多 ${max} 个字符）`);
  const result = value.trim();
  if (!optional && !result) throw new Error(`${name}不能为空`);
  return result;
}
function identifier(value) { return text(value, 'ID', 128); }
function datetime(value, optional = false) {
  if (optional && value === '') return '';
  if (typeof value !== 'string' || value.length > 40) throw new Error('日期必须是带时区的 ISO 日期时间');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Error('日期必须是带时区的 ISO 日期时间');
  const [, year, month, day, hour, minute, second, , zone] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m < 1 || m > 12 || d < 1 || d > days[m - 1] || Number(hour) > 23 || Number(minute) > 59 || Number(second || 0) > 59 || (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) || !Number.isFinite(Date.parse(value))) throw new Error('日期时间无效');
  return value;
}
function problemUrl(value) {
  const raw = text(value, '题目链接', 2048);
  if (/[\s\\]/.test(raw) || !/^https?:\/\//i.test(raw)) throw new Error('仅支持官方题目 HTTP/HTTPS 链接');
  let url;
  try { url = new URL(raw); } catch { throw new Error('题目链接无效'); }
  if (url.href.length > 2048 || url.username || url.password || url.port || !PROBLEM_PATHS.some(([hosts, pattern]) => hosts.includes(url.hostname) && pattern.test(url.pathname))) throw new Error('仅支持官方题目链接，不能包含凭据或自定义端口');
  return url.href;
}
function fields(payload, allowed) {
  if (!object(payload) || Object.keys(payload).some(key => !allowed.includes(key))) throw new Error('计划操作参数无效');
}
function done(value) { if (typeof value !== 'boolean') throw new Error('完成状态必须为布尔值'); return value; }
function record(value, kind) {
  if (!object(value)) throw new Error('计划记录无效');
  const common = { id: identifier(value.id), title: text(value.title, '标题', 180), done: done(value.done), createdAt: datetime(value.createdAt), updatedAt: datetime(value.updatedAt) };
  return kind === 'problems' ? { ...common, url: problemUrl(value.url) } : { ...common, details: text(value.details, '任务详情', 2000, true), dueAt: datetime(value.dueAt, true) };
}

// Planner data belongs to this device, regardless of GitHub account or repository.
// Build a detached candidate, validate it, then use the existing atomic JSON save.
function createPlannerService({ read, save, now = () => new Date().toISOString(), id = randomUUID }) {
  function state() {
    const stored = read('planner.json', null);
    const result = { problems: [], tasks: [], layout: LAYOUTS.has(stored?.layout) ? stored.layout : 'compact' };
    if (!object(stored)) return result;
    for (const kind of ['problems', 'tasks']) {
      const seen = new Set();
      for (const value of (Array.isArray(stored[kind]) ? stored[kind].slice(0, LIMIT) : [])) {
        try {
          const item = record(value, kind);
          if (!seen.has(item.id)) { seen.add(item.id); result[kind].push(item); }
        } catch { /* Invalid legacy/corrupt rows must not break the home screen. */ }
      }
    }
    return result;
  }
  function action(name, payload) {
    const next = state();
    if (name === 'setLayout') {
      fields(payload, ['layout']);
      if (!LAYOUTS.has(payload.layout)) throw new Error('不支持的首页布局');
      next.layout = payload.layout;
    } else {
      const match = /^(add|update|delete)(Problem|Task)$/.exec(typeof name === 'string' ? name : '');
      if (!match) throw new Error('不支持的计划操作');
      const [, operation, type] = match, kind = type === 'Problem' ? 'problems' : 'tasks';
      const editable = kind === 'problems' ? ['title', 'url', 'done'] : ['title', 'details', 'dueAt', 'done'];
      fields(payload, operation === 'delete' ? ['id'] : operation === 'update' ? ['id', ...editable] : editable.filter(key => key !== 'done'));
      if (operation === 'add') {
        if (next[kind].length >= LIMIT) throw new Error('每类计划最多 500 项');
        const timestamp = datetime(now());
        const newId = identifier(id());
        if (next.problems.some(item => item.id === newId) || next.tasks.some(item => item.id === newId)) throw new Error('计划 ID 已存在，请重试');
        const url = kind === 'problems' ? problemUrl(payload.url) : undefined;
        if (kind === 'problems' && next.problems.some(item => !item.done && item.url === url)) throw new Error('这道题已在待做题单中');
        const suppliedTitle = has(payload, 'title') ? text(payload.title, '标题', 180, kind === 'problems') : '';
        const title = kind === 'problems' && !suppliedTitle ? `${new URL(url).hostname} · ${new URL(url).pathname.split('/').filter(Boolean).pop()}`.slice(0, 180) : suppliedTitle;
        next[kind].push(record({ id: newId, title, url, details: has(payload, 'details') ? payload.details : '', dueAt: has(payload, 'dueAt') ? payload.dueAt : '', done: false, createdAt: timestamp, updatedAt: timestamp }, kind));
      } else {
        const target = identifier(payload.id), index = next[kind].findIndex(item => item.id === target);
        if (index < 0) throw new Error('计划记录不存在');
        if (operation === 'delete') next[kind].splice(index, 1);
        else {
          if (!editable.some(key => has(payload, key))) throw new Error('请提供要更新的字段');
          next[kind][index] = record({ ...next[kind][index], ...payload, updatedAt: datetime(now()) }, kind);
        }
      }
    }
    save('planner.json', next);
    return { ...next, problems: next.problems.map(item => ({ ...item })), tasks: next.tasks.map(item => ({ ...item })) };
  }
  return { state, action };
}
module.exports = { createPlannerService, problemUrl };
