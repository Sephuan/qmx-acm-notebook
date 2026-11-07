'use strict';

const { SOURCES } = require('./contest-sources.cjs');
const CACHE_TTL = 10 * 60 * 1000;
const RETRY_DELAY = 60 * 1000;
const MAX_BYTES = 4 * 1024 * 1024;
const HOSTS = {
  luogu: ['www.luogu.com.cn', 'luogu.com.cn'], codeforces: ['codeforces.com'],
  atcoder: ['atcoder.jp'], nowcoder: ['ac.nowcoder.com']
};

function normalizeContests(value, platform, now) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.slice(0, 10000).flatMap(item => {
    if (!item || typeof item !== 'object' || typeof item.title !== 'string' || !item.title.trim()) return [];
    const start = Date.parse(item.startTime), end = Date.parse(item.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end <= now || start > now + 366 * 86400000 || end - start > 90 * 86400000) return [];
    let url;
    try {
      url = new URL(item.url);
      if (url.protocol !== 'https:' || !HOSTS[platform]?.includes(url.hostname) || url.username || url.password || url.port) return [];
      const pattern = platform === 'nowcoder' ? /^\/acm\/contest\/\d+\/?$/ : platform === 'atcoder' ? /^\/contests\/[a-zA-Z0-9_-]+\/?$/ : /^\/contest\/\d+\/?$/;
      if (!pattern.test(url.pathname)) return [];
      url.search = ''; url.hash = '';
    } catch { return []; }
    if (seen.has(url.href)) return [];
    seen.add(url.href);
    return [{ id: String(item.id ?? url.pathname).slice(0, 100), title: item.title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 240), url: url.href, startTime: new Date(start).toISOString(), endTime: new Date(end).toISOString() }];
  }).sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime) || a.id.localeCompare(b.id)).slice(0, 60);
}

async function readResponse(response) {
  if (!response.ok) {
    const error = new Error('Contest source unavailable');
    if ([429, 503].includes(response.status)) {
      const retry = response.headers?.get('retry-after');
      const seconds = /^\d+$/.test(retry || '') ? Number(retry) : (Date.parse(retry) - Date.now()) / 1000;
      if (Number.isFinite(seconds) && seconds > 0) error.retryAfter = Math.min(seconds * 1000, 24 * 60 * 60 * 1000);
    }
    throw error;
  }
  if (Number(response.headers?.get('content-length')) > MAX_BYTES) throw new Error('Contest response too large');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Contest response too large');
    return text;
  }
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_BYTES) throw new Error('Contest response too large');
      chunks.push(Buffer.from(part.value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  return Buffer.concat(chunks).toString('utf8');
}

function createContestService({ fetcher, readCache = () => null, writeCache = () => {}, now = Date.now, sources = SOURCES } = {}) {
  if (typeof fetcher !== 'function') throw new Error('Contest fetcher required');
  let disk;
  try { disk = readCache(); } catch { /* Corrupt/missing cache is a normal first run. */ }
  const entries = new Map(), attempted = new Map(), retryAt = new Map(); let pending;
  for (const source of sources) {
    const old = disk?.schema === 1 && Array.isArray(disk.platforms) ? disk.platforms.find(item => item?.id === source.id) : null;
    const updated = typeof old?.updatedAt === 'string' ? Date.parse(old.updatedAt) : NaN;
    const valid = Number.isFinite(updated) && updated > 0 && updated <= now();
    entries.set(source.id, { contests: valid ? normalizeContests(old.contests, source.id, now()) : [], updatedAt: valid ? new Date(updated).toISOString() : null, error: null });
  }
  function snapshot() {
    const time = now();
    return { platforms: sources.map(source => {
      const value = entries.get(source.id);
      return { id: source.id, name: source.name, url: source.url, contests: normalizeContests(value.contests, source.id, time), updatedAt: value.updatedAt, stale: !!value.error || !value.updatedAt || time - Date.parse(value.updatedAt) >= CACHE_TTL, error: value.error };
    }) };
  }
  function get(force = false) {
    if (typeof force !== 'boolean') return Promise.reject(new Error('赛程刷新参数无效'));
    if (pending) return pending;
    const time = now();
    const due = sources.filter(source => {
      const value = entries.get(source.id), last = attempted.get(source.id);
      if (time < (retryAt.get(source.id) || 0) || (last !== undefined && time - last < RETRY_DELAY)) return false;
      return force || !!value.error || !value.updatedAt || time - Date.parse(value.updatedAt) >= CACHE_TTL;
    });
    if (!due.length) return Promise.resolve(snapshot());
    pending = Promise.all(due.map(async source => {
      attempted.set(source.id, now());
      const current = entries.get(source.id);
      try {
        const response = await fetcher(source.endpoint, {
          headers: { Accept: 'application/json, text/html;q=0.9', 'Accept-Language': 'zh-CN, en;q=0.8' },
          signal: AbortSignal.timeout(12000), redirect: 'error', credentials: 'omit'
        });
        const text = await readResponse(response);
        const parsed = source.parse(text);
        if (!Array.isArray(parsed)) throw new Error('Contest source format changed');
        const contests = normalizeContests(parsed, source.id, now());
        // A non-empty response made entirely of invalid records must not erase a useful cache.
        if (parsed.length && !contests.length && parsed.some(item => !Number.isFinite(Date.parse(item?.endTime)))) throw new Error('Invalid contest times');
        retryAt.delete(source.id);
        entries.set(source.id, { contests, updatedAt: new Date(now()).toISOString(), error: null });
      } catch (error) {
        if (error.retryAfter) retryAt.set(source.id, now() + error.retryAfter);
        entries.set(source.id, { ...current, error: '暂时无法更新，请稍后重试或前往平台查看' });
      }
    })).then(() => {
      try { writeCache({ schema: 1, platforms: [...entries].map(([id, entry]) => ({ id, contests: entry.contests, updatedAt: entry.updatedAt })) }); } catch { /* In-memory schedule remains available if disk is read-only/full. */ }
      return snapshot();
    }).finally(() => { pending = null; });
    return pending;
  }
  return { snapshot, get };
}

module.exports = { createContestService, normalizeContests, CACHE_TTL, RETRY_DELAY };
