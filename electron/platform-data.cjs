'use strict';

const PLATFORMS = Object.freeze(['CF', 'AT', 'LG', 'NC', 'LC']);
const HOSTS = {
  CF: ['codeforces.com', 'www.codeforces.com'], AT: ['atcoder.jp'],
  LG: ['www.luogu.com.cn', 'luogu.com.cn', 'www.luogu.com', 'luogu.com'],
  NC: ['ac.nowcoder.com', 'www.nowcoder.com', 'nowcoder.com'], LC: ['leetcode.cn', 'leetcode.com'],
};
const MAX_BYTES = 4 * 1024 * 1024;
const CF_PAGE_SIZE = 1000;
const CF_MAX_PAGES = 20;

function parseProfileLink(platform, input) {
  platform = String(platform || '').toUpperCase();
  if (!PLATFORMS.includes(platform)) throw new Error('不支持的平台');
  if (typeof input !== 'string' || input.length > 2048) throw new Error('请粘贴完整的 HTTPS 个人主页链接');
  const value = input.trim();
  // Reject URL normalization tricks before WHATWG URL resolves dot segments or backslashes.
  if (!/^https:\/\//i.test(value) || /[\\\s\u0000-\u001f\u007f%]/.test(value)) throw new Error('请使用有效的 HTTPS 个人主页链接');
  let u;
  try { u = new URL(value); } catch { throw new Error('个人主页链接无效'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !HOSTS[platform].includes(u.hostname) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(value.slice(value.indexOf('://') + 3))) throw new Error('个人主页链接的域名或路径不受支持');
  let match;
  if (platform === 'CF') match = u.pathname.match(/^\/profile\/([A-Za-z0-9_.-]{1,64})\/?$/);
  if (platform === 'AT') match = u.pathname.match(/^\/users\/([A-Za-z0-9_]{1,64})\/?$/);
  if (platform === 'LG') match = u.pathname.match(/^\/user\/([1-9][0-9]{0,17})\/?$/);
  if (platform === 'NC') match = u.pathname.match(/^\/(?:users|profile|acm\/contest\/profile)\/([1-9][0-9]{0,19})\/?$/);
  if (platform === 'LC') match = u.pathname.match(/^\/u\/([A-Za-z0-9_-]{1,100})\/?$/);
  if (!match) throw new Error('请提供该平台的个人主页链接');
  const id = match[1];
  const url = platform === 'CF' ? `https://codeforces.com/profile/${id}`
    : platform === 'AT' ? `https://atcoder.jp/users/${id}`
      : platform === 'LG' ? `https://www.luogu.com.cn/user/${id}`
        : platform === 'NC' ? `https://ac.nowcoder.com/acm/contest/profile/${id}`
          : `https://${u.hostname}/u/${id}/`;
  return { platform, id, username: id, url };
}

const num = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const count = value => num(value) !== null && value >= 0 && Number.isInteger(value) ? value : null;
const fromText = value => typeof value === 'string' && /^\d[\d,]*(?:\.\d+)?$/.test(value.trim()) ? num(Number(value.replaceAll(',', ''))) : null;
const clean = value => String(value || '').replace(/\r/g, '').replace(/\u00a0/g, ' ').trim();
const escapeRe = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function plain(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|#160);/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(?:39|x27);/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}
function challenge(text) {
  if (/just a moment|checking your browser|verify (?:you are|that you are) human|cf-chl-|人机验证|安全验证|访问验证|访问过于频繁|请求过于频繁|验证码|challenge-platform/i.test(text)) throw new Error('平台返回了验证或限流页面，请稍后重试');
}
function errorMessage(error) { return error?.message || '请求失败'; }
function result(binding) {
  return { username: binding.id, profileUrl: binding.url, solvedCount: null, submissionCount: null, rating: null, maxRating: null, ratedContests: null, contests: [], ratingHistory: [], activity: { days: {}, complete: false, note: '公开数据未提供完整的首次通过时间线，不能将提交次数当作每日通过题数' }, sourceNote: '' };
}
function chronological(rows) { return rows.slice().sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0)); }
function historyOf(out, rows) {
  out.ratingHistory = chronological(rows.filter(c => num(c.rating) !== null).map(({ date, rating, name, url, rank, delta, solvedCount, problemCount }) => ({ date, rating, name, url, rank, delta, solvedCount: count(solvedCount), problemCount: count(problemCount) })));
}
function contestCounts(solved, total) {
  const problemCount = count(total); const solvedCount = count(solved);
  return { solvedCount: solvedCount !== null && (problemCount === null || solvedCount <= problemCount) ? solvedCount : null, problemCount };
}
function updateContestCounts(out, url, values) {
  for (const row of [...out.contests, ...out.ratingHistory]) if (row.url === url) Object.assign(row, contestCounts(values.solvedCount, values.problemCount));
}
function atContestTasks(html, slug) {
  challenge(html);
  const ids = new Set([...html.matchAll(new RegExp(`href=["']/contests/${escapeRe(slug)}/tasks/([A-Za-z0-9_-]+)["']`, 'g'))].map(m => m[1]));
  const times = [...html.matchAll(/<time\b[^>]*class=["'][^"']*\bfixtime\b[^"']*["'][^>]*>([^<]+)<\/time>/gi)].map(m => timestamp(plain(m[1]))).filter(n => n !== null);
  if (!ids.size || times.length !== 2 || times[0] >= times[1]) throw new Error('官方题目列表或比赛时间未公开');
  return { ids, start: times[0], end: times[1] };
}
// All aggregation uses the platform problem identity, and the earliest accepted time.
// Numeric timestamps are Unix seconds; timezone-less browser dates are China local time.
function timestamp(value) {
  if (typeof value === 'number') return value >= 0 && iso(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  const local = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(text);
  const ms = Date.parse(local ? `${text.replace(' ', 'T')}${text.length === 16 ? ':00' : ''}+08:00` : text);
  return Number.isFinite(ms) && ms >= 0 ? ms / 1000 : null;
}
function firstAccepted(map, problem, time) {
  const seconds = timestamp(time);
  if (typeof problem !== 'string' || !problem || seconds === null) return false;
  if (!map.has(problem) || seconds < map.get(problem)) map.set(problem, seconds);
  return true;
}
function activityFrom(first, complete, note, allowPartial = false) {
  const days = {};
  if (complete || allowPartial) for (const seconds of first.values()) {
    const day = new Date((seconds + 8 * 3600) * 1000).toISOString().slice(0, 10);
    days[day] = (days[day] || 0) + 1;
  }
  return { days: Object.fromEntries(Object.entries(days).sort(([a], [b]) => a.localeCompare(b))), complete, note };
}
function unavailableActivity(out, note) { out.activity = { days: {}, complete: false, note }; }
function recent(contests) {
  return contests.sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 5);
}
function iso(seconds) {
  if (num(seconds) === null || !Number.isFinite(new Date(seconds * 1000).getTime())) return null;
  return new Date(seconds * 1000).toISOString();
}
async function bounded(task, ms = 12000) {
  let timer;
  try { return await Promise.race([task(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('平台请求超时')), ms); })]); }
  finally { clearTimeout(timer); }
}
function cfStandingsMetadata(body) {
  // The anonymous endpoint may send the entire standings. Parse only a valid JSON
  // prefix containing official contest/problems metadata, then cancel before rows.
  for (const match of body.matchAll(/,\s*"rows"\s*:\s*\[/g)) {
    try {
      const data = JSON.parse(`${body.slice(0, match.index)}}}`);
      if (data?.status === 'OK' && data.result?.contest && Array.isArray(data.result.problems)) return data;
    } catch {}
  }
  return null;
}
async function request(fetcher, url, type = 'json', options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    return await bounded(async () => {
      const r = await fetcher(url, { ...options, signal: controller.signal, redirect: 'error', credentials: 'omit', headers: { Accept: type === 'text' ? 'text/html' : 'application/json', ...options.headers } });
      if (!r?.ok) throw new Error(`平台请求失败（HTTP ${r?.status || '未知'}）`);
      if (type !== 'cfStandingsMetadata' && Number(r.headers?.get?.('content-length')) > MAX_BYTES) throw new Error('平台响应过大');
      if (typeof r.text === 'function' || r.body?.getReader) {
        let body;
        if (r.body?.getReader) {
          const reader = r.body.getReader(); const chunks = []; let bytes = 0;
          try {
            while (true) {
              const chunk = await reader.read(); if (chunk.done) break;
              bytes += chunk.value.byteLength;
              if (bytes > MAX_BYTES) { await reader.cancel(); throw new Error('平台响应过大'); }
              chunks.push(Buffer.from(chunk.value));
              if (type === 'cfStandingsMetadata') {
                const metadata = cfStandingsMetadata(Buffer.concat(chunks).toString('utf8'));
                if (metadata) { await reader.cancel(); return metadata; }
              }
            }
            body = Buffer.concat(chunks).toString('utf8');
          } finally { reader.releaseLock(); }
        } else body = await r.text();
        if (Buffer.byteLength(body) > MAX_BYTES) throw new Error('平台响应过大');
        if (type === 'text') return body;
        try { return JSON.parse(body); } catch { challenge(body); throw new Error('平台未返回有效数据'); }
      }
      if ((type === 'json' || type === 'cfStandingsMetadata') && typeof r.json === 'function') {
        const body = await r.json();
        if (Buffer.byteLength(JSON.stringify(body) || '') > MAX_BYTES) throw new Error('平台响应过大');
        return body;
      }
      throw new Error('平台响应无效');
    });
  } finally { clearTimeout(timer); controller.abort(); }
}
async function optional(out, label, task) {
  try { return await task(); } catch (error) { out.sourceNote += `；${label}暂不可用：${errorMessage(error)}`; return null; }
}
const cfQueues = new WeakMap();
async function cf(binding, fetcher, requestInterval = 2000) {
  const out = result(binding);
  out.sourceNote = 'Codeforces 官方 API';
  async function api(method, query) {
    const previous = cfQueues.get(fetcher) || Promise.resolve(0);
    const current = previous.catch(() => 0).then(async last => {
      const wait = requestInterval - (Date.now() - last);
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      try { return { data: await request(fetcher, `https://codeforces.com/api/${method}?${new URLSearchParams(query)}`, method === 'contest.standings' ? 'cfStandingsMetadata' : 'json'), at: Date.now() }; }
      catch (error) { error.requestFinishedAt = Date.now(); throw error; }
    });
    cfQueues.set(fetcher, current.then(r => r.at, error => error.requestFinishedAt || Date.now()));
    const { data: d } = await current;
    if (d?.status !== 'OK') throw new Error(d?.comment || 'Codeforces 账号不存在或 API 不可用');
    return d.result;
  }
  const info = await api('user.info', { handles: binding.id });
  if (!Array.isArray(info) || info.length !== 1 || typeof info[0]?.handle !== 'string' || info[0].handle.toLowerCase() !== binding.id.toLowerCase()) throw new Error('Codeforces 未返回匹配的真实账号');
  out.username = info[0].handle;
  out.rating = num(info[0].rating); out.maxRating = num(info[0].maxRating);
  await optional(out, '比赛历史', async () => {
    const history = await api('user.rating', { handle: out.username });
    if (!Array.isArray(history)) throw new Error('比赛历史格式无效');
    out.ratedContests = history.length;
    const contests = history.map(c => ({ name: String(c.contestName || ''), url: `https://codeforces.com/contest/${Number(c.contestId)}`, date: iso(c.ratingUpdateTimeSeconds), rank: num(c.rank), rating: num(c.newRating), delta: num(c.newRating) !== null && num(c.oldRating) !== null ? c.newRating - c.oldRating : null, solvedCount: null, problemCount: null }));
    out.contests = recent(contests); historyOf(out, contests);
  });
  out.submissionCountNote = '仅在完整读取官方提交历史后计算提交总数';
  await optional(out, '提交及首次通过历史', async () => {
    const solved = new Set(); const first = new Map(); const ids = new Set(); const contestSolved = new Map(); const uncertainContests = new Set(); let submissions = 0; let validDates = true;
    try {
      for (let page = 0; page < CF_MAX_PAGES; page++) {
        const rows = await api('user.status', { handle: out.username, from: String(page * CF_PAGE_SIZE + 1), count: String(CF_PAGE_SIZE) });
        if (!Array.isArray(rows)) throw new Error('提交历史格式无效');
        for (const row of rows) {
          if (row?.id != null) { const id = String(row.id); if (ids.has(id)) continue; ids.add(id); }
          submissions++;
          const cid = count(row?.contestId) ?? count(row?.problem?.contestId);
          if (cid !== null && (!['CONTESTANT', 'PRACTICE', 'VIRTUAL', 'OUT_OF_COMPETITION', 'MANAGER'].includes(row?.author?.participantType) || (row?.verdict === 'OK' && row.author.participantType === 'CONTESTANT' && (row.contestId !== row.problem?.contestId || !row.problem?.index)))) uncertainContests.add(cid);
          if (row?.verdict === 'OK') {
            const pid = row.problem?.contestId != null && row.problem?.index ? `${row.problem.contestId}:${row.problem.index}` : row.problem?.problemsetName && row.problem?.index ? `${row.problem.problemsetName}:${row.problem.index}` : null;
            if (!pid) { validDates = false; continue; }
            solved.add(pid); if (!firstAccepted(first, pid, row.creationTimeSeconds)) validDates = false;
            // Practice, virtual, unofficial and partial-score submissions are not contest ACs.
            if (row.author?.participantType === 'CONTESTANT' && row.contestId === row.problem?.contestId && count(row.contestId) !== null) {
              if (!contestSolved.has(row.contestId)) contestSolved.set(row.contestId, new Set());
              contestSolved.get(row.contestId).add(pid);
            }
          }
        }
        if (rows.length < CF_PAGE_SIZE) {
          out.solvedCount = solved.size; out.submissionCount = submissions; out.submissionCountNote = 'Codeforces 官方完整提交历史（含未通过提交）';
          for (const c of out.ratingHistory) {
            const id = Number(c.url?.match(/\/contest\/(\d+)$/)?.[1]);
            updateContestCounts(out, c.url, { solvedCount: uncertainContests.has(id) ? null : contestSolved.get(id)?.size ?? 0, problemCount: null });
          }
          out.activity = activityFrom(first, validDates, validDates ? 'Codeforces 全部提交中每题首次 AC，Asia/Shanghai' : '部分通过记录缺少题目标识或时间，无法确认完整的首次通过时间线');
          return;
        }
      }
      throw new Error(`提交历史超过 ${CF_MAX_PAGES * CF_PAGE_SIZE} 条安全上限，未将不完整数据作为总数`);
    } catch (error) { out.submissionCountNote = errorMessage(error); unavailableActivity(out, `提交历史不完整，无法确定每题首次 AC：${errorMessage(error)}`); throw error; }
  });
  // Anonymous standings only accepts contestId. Keep the extra requests bounded.
  for (const c of out.contests.slice(0, 3)) await optional(out, '比赛题目数', async () => {
    const id = c.url?.match(/\/contest\/(\d+)$/)?.[1]; if (!id) return;
    const data = await api('contest.standings', { contestId: id });
    if (data?.contest?.id !== Number(id) || !Array.isArray(data.problems) || !data.problems.length || data.problems.some(p => p.contestId !== Number(id) || typeof p.index !== 'string')) throw new Error('比赛题目列表无效');
    updateContestCounts(out, c.url, { solvedCount: c.solvedCount, problemCount: new Set(data.problems.map(p => p.index)).size });
  });
  return out;
}
function tableValue(html, label) {
  for (const row of html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || []) {
    const cells = [...row.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(m => plain(m[1]));
    if (cells.length > 1 && label.test(cells[0])) return cells[1];
  }
  return null;
}
async function at(binding, fetcher) {
  const out = result(binding); const contestTasks = new Map();
  out.sourceNote = 'AtCoder 官方主页及比赛历史；通过题数来自 AtCoder Problems（kenkoooo）';
  const html = await request(fetcher, `${binding.url}?lang=en`, 'text');
  challenge(html);
  const title = plain(html.match(/<title\b[^>]*>([^<]*)<\/title>/i)?.[1] || '');
  const accountHeader = (html.match(/<h3\b[^>]*>[\s\S]*?<\/h3>/gi) || []).some(header => new RegExp(`href=["']/users/${escapeRe(binding.id)}["']`, 'i').test(header) && new RegExp(`(?:^|\\s)${escapeRe(binding.id)}(?:\\s|$)`, 'i').test(plain(header)));
  if (!new RegExp(`^${escapeRe(binding.id)} - AtCoder$`, 'i').test(title) || !accountHeader) throw new Error('AtCoder 未返回有效个人主页');
  out.username = title.slice(0, -10);
  const metric = re => fromText(tableValue(html, re)?.match(/^[\d,]+/)?.[0]);
  out.rating = metric(/^Rating$/i); out.maxRating = metric(/^Highest Rating$/i); out.ratedContests = metric(/^Rated Matches\b/i);
  await optional(out, '比赛历史', async () => {
    const history = await request(fetcher, `${binding.url}/history/json`);
    if (!Array.isArray(history)) throw new Error('比赛历史格式无效');
    const rated = history.filter(c => c.IsRated === true);
    out.ratedContests = rated.length;
    if (rated.length) {
      const ordered = rated.slice().sort((a, b) => String(a.EndTime).localeCompare(String(b.EndTime)));
      out.rating = num(ordered.at(-1).NewRating) ?? out.rating;
      out.maxRating = Math.max(...rated.map(c => num(c.NewRating)).filter(n => n !== null), out.maxRating ?? 0);
    }
    const contests = history.map(c => {
      const slug = String(c.ContestScreenName || '').match(/^([A-Za-z0-9_-]+)(?:\.(?:contest|rated)(?:\.atcoder\.jp)?)?$/)?.[1];
      return { name: String(c.ContestName || ''), url: slug ? `https://atcoder.jp/contests/${slug}` : null, date: typeof c.EndTime === 'string' ? c.EndTime : null, rank: num(c.Place), rating: c.IsRated === true ? num(c.NewRating) : null, delta: c.IsRated === true && num(c.NewRating) !== null && num(c.OldRating) !== null ? c.NewRating - c.OldRating : null, rated: c.IsRated === true, solvedCount: null, problemCount: null };
    });
    out.contests = recent(contests); historyOf(out, contests.filter(c => c.rated));
  });
  for (const c of out.contests) await optional(out, '比赛题目及时间', async () => {
    if (!c.url) return;
    const slug = c.url.split('/').at(-1);
    const html = await request(fetcher, `${c.url}/tasks?lang=en`, 'text');
    const tasks = atContestTasks(html, slug);
    if (timestamp(c.date) !== tasks.end) throw new Error('官方比赛结束时间与历史不一致');
    contestTasks.set(c.url, tasks);
    updateContestCounts(out, c.url, { solvedCount: null, problemCount: tasks.ids.size });
  });
  let lastKenkooooRequest = 0;
  await optional(out, '通过题数', async () => {
    lastKenkooooRequest = Date.now();
    const info = await request(fetcher, `https://kenkoooo.com/atcoder/atcoder-api/v3/user_info?user=${encodeURIComponent(binding.id)}`);
    if (typeof info?.user_id !== 'string' || info.user_id.toLowerCase() !== binding.id.toLowerCase() || count(info.accepted_count) === null) throw new Error('第三方未返回匹配账号的通过题数');
    out.solvedCount = info.accepted_count;
  });
  out.submissionCountNote = 'AtCoder Problems 公开提交历史尚未完整读取';
  await optional(out, '提交及首次通过历史', async () => {
    const first = new Map(); const ids = new Set(); const solved = new Set(); const contestSolved = new Map(); let from = 0; let submissions = 0; let validDates = true;
    const load = async start => {
      // kenkoooo asks clients to leave at least one second between requests.
      const wait = 1000 - (Date.now() - lastKenkooooRequest);
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      lastKenkooooRequest = Date.now();
      const rows = await request(fetcher, `https://kenkoooo.com/atcoder/atcoder-api/v3/user/submissions?user=${encodeURIComponent(binding.id)}&from_second=${start}`);
      if (!Array.isArray(rows) || rows.length > 500 || rows.some(r => !r || timestamp(r.epoch_second) === null || r.epoch_second < start || typeof r.user_id !== 'string' || r.user_id.toLowerCase() !== binding.id.toLowerCase() || r.id == null)) throw new Error('第三方提交历史格式或账号无效');
      return rows;
    };
    const ingest = rows => {
      for (const row of rows) {
        const id = String(row.id); if (ids.has(id)) continue; ids.add(id); submissions++;
        if (submissions > 20000) throw new Error('提交历史超过 20000 条安全上限，未将不完整数据作为总数');
        if (row.result === 'AC') {
          if (typeof row.problem_id !== 'string' || !row.problem_id) { validDates = false; continue; }
          solved.add(row.problem_id); if (!firstAccepted(first, row.problem_id, row.epoch_second)) validDates = false;
          for (const [url, tasks] of contestTasks) if (tasks.ids.has(row.problem_id) && row.epoch_second >= tasks.start && row.epoch_second < tasks.end) {
            if (!contestSolved.has(url)) contestSolved.set(url, new Set());
            contestSolved.get(url).add(row.problem_id);
          }
        }
      }
    };
    try {
      for (let page = 0; page < 40; page++) {
        const rows = await load(from); ingest(rows);
        if (rows.length < 500) {
          if (out.solvedCount !== null && out.solvedCount !== solved.size) throw new Error('完整提交历史与公开通过题数不一致，保留公开通过数，稍后刷新重试');
          out.submissionCount = submissions; out.submissionCountNote = 'AtCoder Problems 完整公开提交历史（每页 500，上限 20000；分页同秒边界复核）';
          out.solvedCount = solved.size;
          for (const [url, tasks] of contestTasks) updateContestCounts(out, url, { solvedCount: contestSolved.get(url)?.size ?? 0, problemCount: tasks.ids.size });
          out.activity = activityFrom(first, validDates, validDates ? 'AtCoder Problems 全历史每题首次 AC，Asia/Shanghai；第三方数据可能延迟' : '通过记录缺少有效题目标识，首次通过时间线不完整');
          return;
        }
        const last = Math.max(...rows.map(r => r.epoch_second));
        // from_second is inclusive. Audit the boundary before advancing by one second,
        // otherwise a 500-row page can silently discard submissions in the same second.
        const boundary = await load(last); const sameSecond = boundary.filter(r => r.epoch_second === last); ingest(sameSecond);
        if (sameSecond.length === 500) throw new Error('同一时间戳达到 500 条分页上限，无法保证提交历史完整');
        from = last + 1;
      }
      throw new Error('提交历史达到 20000 条安全上限，未将不完整数据作为总数');
    } catch (error) { out.submissionCountNote = errorMessage(error); unavailableActivity(out, `第三方提交历史不完整：${errorMessage(error)}`); throw error; }
  });
  return out;
}
async function page(readPage, url) {
  if (typeof readPage !== 'function') throw new Error('该平台需要桌面浏览器采集公开主页');
  const d = await bounded(() => readPage(url), 35000);
  if (!d || typeof d.text !== 'string' || d.text.length > MAX_BYTES) throw new Error('浏览器未返回有效页面');
  challenge(`${d.title || ''}\n${d.text}`);
  if (/用户不存在|该用户不存在|账号不存在|找不到用户|404\s*(?:not found|页面)|页面不存在/i.test(`${d.title || ''}\n${d.text}`)) throw new Error('账号不存在或主页不可用');
  return { text: clean(d.text), title: clean(d.title), links: Array.isArray(d.links) ? d.links : [], firstAccepted: d.firstAccepted, activity: d.activity, practiceRows: d.practiceRows, publicData: d.publicData };
}
function safeContestLink(links, name, base, hosts, path) {
  for (const link of links) {
    if (clean(link?.text) !== name) continue;
    try { const u = new URL(link.url, base); if (u.protocol === 'https:' && !u.username && !u.password && !u.port && hosts.includes(u.hostname) && path.test(u.pathname)) return u.href; } catch {}
  }
  return null;
}
async function lg(binding, readPage) {
  const out = result(binding); out.sourceNote = '洛谷公开主页（浏览器渲染）；比赛仅展示主页公开的最近评定比赛';
  const p = await page(readPage, binding.url);
  const heading = `${p.title}\n${p.text}`.match(/(?:^|\n)([^\n]+?)\s*-\s*个人(?:中心|主页)/);
  if (!heading || !/提交\s*\n?\s*[\d,]+\s*\n?\s*通过\s*\n?\s*[\d,]+/.test(p.text)) throw new Error('洛谷未返回可识别的真实用户主页');
  out.username = heading[1].trim();
  out.solvedCount = fromText(p.text.match(/(?:^|\n)通过\s*\n\s*([\d,]+)/)?.[1]);
  out.submissionCount = fromText(p.text.match(/(?:^|\n)提交\s*\n\s*([\d,]+)/)?.[1]);
  const section = p.text.split('比赛等级分')[1] || '';
  out.rating = fromText(section.match(/等级分\s*\n\s*([\d,]+)/)?.[1] || p.text.match(/等级分\s*\n\s*([\d,]+)/)?.[1]);
  out.maxRating = fromText(section.match(/历史最高\s*\n\s*([\d,]+)/)?.[1]);
  const name = clean(section.match(/评定比赛\s*\n\s*([^\n]+)/)?.[1]);
  if (name && !/^(?:无|暂无|未参加|—|-)$/.test(name)) out.contests = [{ name, url: safeContestLink(p.links, name, binding.url, HOSTS.LG, /^\/contest\/[1-9]\d*\/?$/), date: section.match(/达成时间\s*\n\s*(\d{4}-\d{2}-\d{2})/)?.[1] || null, rank: null, rating: out.rating, delta: null, solvedCount: null, problemCount: null }];
  out.submissionCountNote = '洛谷主页“提交”显示值';
  unavailableActivity(out, '洛谷公开主页未提供可核实的全历史每题首次 AC；提交日历不能代替每日首次通过题数');
  await optional(out, '首次通过时间线', async () => {
    if (String(p.publicData?.uid) === binding.id && p.publicData.dailyCounts && typeof p.publicData.dailyCounts === 'object' && !Array.isArray(p.publicData.dailyCounts)) {
      const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
      const midnight = Date.parse(`${today}T00:00:00Z`);
      const startDate = new Date(midnight - 180 * 86400000).toISOString().slice(0, 10);
      const endDate = new Date(midnight - 86400000).toISOString().slice(0, 10);
      const days = {};
      for (const [day, value] of Object.entries(p.publicData.dailyCounts)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < startDate || day > endDate) continue;
        if (!Number.isFinite(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day || !Array.isArray(value) || count(value[0]) === null) throw new Error('洛谷官方每日通过数据格式无效');
        days[day] = value[0];
      }
      if (Object.keys(days).length) out.activity = { days: Object.fromEntries(Object.entries(days).sort(([a], [b]) => a.localeCompare(b))), complete: false, rangeComplete: true, metric: 'platformDailySolved', timezone: 'Asia/Shanghai', startDate, endDate, note: '洛谷官方每日通过题数，最近 180 天截至昨日，非实时；与 CF/AT/NC 的全历史每题首次 AC 口径不同，区间外未知' };
    }
    const data = p.firstAccepted;
    if (data && Array.isArray(data.records) && data.records.length <= 20000) {
      const first = new Map(); let valid = true;
      for (const row of data.records) if (!firstAccepted(first, row?.problemId, row?.timestamp)) valid = false;
      const complete = data.complete === true && valid && (out.solvedCount === null || first.size === out.solvedCount);
      out.activity = activityFrom(first, complete, complete ? '洛谷公开完整每题首次 AC，Asia/Shanghai' : '洛谷公开首次通过时间线不完整，未将缺失日期视为零');
    } else if (p.activity?.metric === 'platformDailySolved' && p.activity.timezone === 'Asia/Shanghai' && p.activity.days && typeof p.activity.days === 'object' && !Array.isArray(p.activity.days)) {
      const data = p.activity; const entries = Object.entries(data.days);
      const validDay = day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(`${day}T00:00:00Z`)) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
      if (!validDay(data.startDate) || !validDay(data.endDate) || data.startDate > data.endDate || entries.length > 366 || entries.some(([day, n]) => !validDay(day) || day < data.startDate || day > data.endDate || count(n) === null)) throw new Error('公开每日通过区间格式无效');
      out.activity = { days: Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))), complete: false, metric: 'platformDailySolved', timezone: 'Asia/Shanghai', startDate: data.startDate, endDate: data.endDate, note: `洛谷官方每日通过题数，仅公开区间 ${data.startDate} 至 ${data.endDate}，非实时；不保证全历史每题首次 AC，区间外日期未知` };
    } else if (p.activity?.metric === 'firstAccepted' && p.activity.timezone === 'Asia/Shanghai' && p.activity.complete === true && p.activity.days && typeof p.activity.days === 'object' && !Array.isArray(p.activity.days)) {
      const entries = Object.entries(p.activity.days);
      if (entries.some(([date, n]) => !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00+08:00`)) || count(n) === null)) throw new Error('每日首次通过数据格式无效');
      if (out.solvedCount !== null && entries.reduce((sum, [, n]) => sum + n, 0) !== out.solvedCount) throw new Error('每日首次通过数据未覆盖完整通过题数');
      out.activity = { days: Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))), complete: true, note: '洛谷公开日历明确标注首次通过题数，Asia/Shanghai' };
    }
  });
  return out;
}
function labelBefore(text, label) { return fromText(text.match(new RegExp(`(?:^|\\s)([\\d,]+)\\s*${label}(?:\\s|$)`, 'i'))?.[1]); }
function practiceRows(p, base) {
  if (Array.isArray(p.practiceRows)) return p.practiceRows.slice(0, 1000).map(r => ({ id: String(r.submissionId || ''), problem: r.problemId, time: r.time, accepted: /^(?:答案正确|AC|Accepted)$/i.test(clean(r.verdict)), valid: typeof r.verdict === 'string' && timestamp(r.time) !== null && typeof r.problemId === 'string' && Boolean(r.submissionId) }));
  const submissions = new Set(); const problems = [];
  for (const link of p.links) {
    try {
      const u = new URL(link?.url, base);
      if (u.protocol !== 'https:' || !HOSTS.NC.includes(u.hostname)) continue;
      if (u.pathname === '/acm/contest/view-submission' && /^\d+$/.test(u.searchParams.get('submissionId') || '')) submissions.add(u.searchParams.get('submissionId'));
      if (/^\/acm\/problem\/\d+\/?$/.test(u.pathname) && clean(link.text)) problems.push({ name: clean(link.text), id: u.pathname.match(/\d+/)[0] });
    } catch {}
  }
  const rows = [];
  for (const id of submissions) {
    const start = p.text.search(new RegExp(`(?:^|\\s)${escapeRe(id)}(?=\\s)`)); if (start < 0) continue;
    const tail = p.text.slice(start).trimStart(); const date = tail.match(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/); if (!date) continue;
    const body = tail.slice(id.length, date.index).trim();
    const problem = problems.filter(r => body.startsWith(r.name) && /^\s/.test(body.slice(r.name.length))).sort((a, b) => b.name.length - a.name.length)[0];
    const verdict = problem ? body.slice(problem.name.length).trim() : '';
    rows.push({ id, problem: problem?.id, time: date[0], accepted: /^(?:答案正确|Accepted\b|AC\b)/i.test(verdict), valid: Boolean(problem) && /^(?:答案正确|答案错误|编译错误|运行超时|运行错误|内存超限|输出超限|格式错误|部分正确|提交中|等待|正在|系统错误|Wrong Answer|Accepted|Time Limit|Runtime|Compilation|Memory|AC\b|WA\b|TLE\b)/i.test(verdict) });
  }
  return rows;
}
async function nc(binding, readPage) {
  const out = result(binding); out.sourceNote = '牛客公开竞赛主页及练习统计（浏览器渲染）；历史最高分未公开';
  const p = await page(readPage, binding.url);
  const head = p.text.match(/(?:^|\n)([^\n]{1,100}?)\s+关注\s+私信/);
  const titleName = p.title.match(/^(.+?)(?:的个人主页|的个人空间|的牛客个人主页)/)?.[1];
  const rating = labelBefore(p.text, 'Rating');
  const rated = labelBefore(p.text, '次\\s*Rating赛');
  if (!(head || titleName) || (rating === null && rated === null)) throw new Error('牛客未返回可识别的真实用户竞赛主页');
  out.username = clean(head?.[1] || titleName); out.rating = rating; out.ratedContests = rated;
  const candidates = [];
  for (const link of p.links) {
    const name = clean(link?.text); if (!name) continue;
    const url = safeContestLink([link], name, binding.url, HOSTS.NC, /^\/acm\/contest\/[1-9]\d*\/?$/);
    const index = p.text.indexOf(name);
    if (url && index >= 0 && !candidates.some(c => c.url === url)) candidates.push({ name, url, index });
  }
  candidates.sort((a, b) => a.index - b.index);
  const contests = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]; const segment = p.text.slice(c.index + c.name.length, candidates[i + 1]?.index ?? p.text.length);
    const date = segment.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s*至/);
    const score = segment.match(/(?:^|\s)([\d,]+)\s*\(\s*([+-]\d+)\s*\)\s*Rating\b/i);
    const rank = segment.match(/(?:^|\s)([\d,]+)\s*\/\s*[\d,]+\s*(?:正式榜|排名)/);
    const ac = segment.match(/(?:^|\s)([\d,]+)\s*\/\s*([\d,]+)\s*AC数量(?:\s|$)/i);
    if (date) contests.push({ name: c.name, url: c.url, date: `${date[1]}T${date[2]}:00+08:00`, rank: fromText(rank?.[1]), rating: fromText(score?.[1]), delta: score ? Number(score[2]) : null, rated: Boolean(score), ...contestCounts(fromText(ac?.[1]), fromText(ac?.[2])) });
  }
  out.contests = recent(contests); historyOf(out, contests.filter(c => c.rated));
  // Visible contest cards do not prove an all-time maximum.
  out.maxRating = null;
  const observedRatings = contests.map(c => c.rating).filter(n => n !== null);
  if (observedRatings.length) out.observedMaxRating = Math.max(...observedRatings);
  out.submissionCountNote = '牛客公开练习统计暂未读取';
  await optional(out, '练习统计及首次通过历史', async () => {
    const base = `${binding.url}/practice-coding`;
    const practice = await page(readPage, base);
    const solved = labelBefore(practice.text, '题已通过'); const total = labelBefore(practice.text, '次提交');
    if (solved === null || labelBefore(practice.text, '题已挑战') === null || total === null) throw new Error('练习统计暂未公开');
    out.solvedCount = solved; out.submissionCount = total; out.submissionCountNote = '牛客公开练习统计“次提交”（练习范围）';
    const first = new Map(); const ids = new Set(); let valid = true;
    const ingest = p => {
      const rows = practiceRows(p, base);
      for (const row of rows) {
        if (ids.has(row.id)) continue; ids.add(row.id);
        if (!row.valid) valid = false;
        if (row.accepted && !firstAccepted(first, row.problem, row.time)) valid = false;
      }
      return rows.length;
    };
    const firstSize = ingest(practice);
    if (total === 0) { out.activity = activityFrom(first, solved === 0, solved === 0 ? '牛客公开练习完整历史，暂无首次通过题目' : '公开练习总数与通过数不一致'); return; }
    if (firstSize === 0) { unavailableActivity(out, '牛客公开提交行未能完整读取；保留真实统计，未将缺少时间线视为零'); return; }
    try {
      const pages = Math.ceil(total / 10);
      for (let n = 2; n <= Math.min(pages, 20); n++) {
        const url = `${base}?pageSize=10&search=&statusTypeFilter=-1&languageCategoryFilter=-1&orderType=DESC&page=${n}`;
        const next = await page(readPage, url);
        if (labelBefore(next.text, '次提交') !== total) throw new Error('分页期间提交总数变化，请重试');
        if (ingest(next) === 0) throw new Error('提交分页没有可识别记录');
      }
      const complete = pages <= 20 && ids.size === total && valid && first.size === solved;
      out.activity = activityFrom(first, complete, complete ? '牛客公开练习全部提交中每题首次 AC，Asia/Shanghai' : pages > 20 ? '牛客提交历史超过 20 页采集上限，首次通过时间线不完整' : '牛客提交历史未覆盖全部统计或存在不可识别记录，首次通过时间线不完整');
    } catch (error) { unavailableActivity(out, `牛客首次通过时间线不完整：${errorMessage(error)}`); throw error; }
  });
  return out;
}
async function graphql(fetcher, url, query, variables) {
  const d = await request(fetcher, url, 'json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  if (d?.errors?.length || !d?.data) throw new Error('力扣公开接口暂不可用');
  return d.data;
}
function lcContestUrl(host, title) {
  let m = title.match(/^(?:第\s*(\d+)\s*场周赛|Weekly Contest (\d+))$/i);
  if (m) return `https://${host}/contest/weekly-contest-${m[1] || m[2]}/`;
  m = title.match(/^(?:第\s*(\d+)\s*场双周赛|Biweekly Contest (\d+))$/i);
  return m ? `https://${host}/contest/biweekly-contest-${m[1] || m[2]}/` : null;
}
async function lc(binding, fetcher) {
  const out = result(binding); const host = new URL(binding.url).hostname; const cn = host === 'leetcode.cn';
  out.sourceNote = `LeetCode ${cn ? '中国站' : '国际站'}公开 GraphQL；未公开的竞赛数据保持未知`;
  if (cn) {
    const d = await graphql(fetcher, `https://${host}/graphql/`, 'query PublicProfile($userSlug: String!) { userProfilePublicProfile(userSlug: $userSlug) { profile { userSlug realName } } }', { userSlug: binding.id });
    const profile = d.userProfilePublicProfile?.profile;
    if (typeof profile?.userSlug !== 'string' || profile.userSlug.toLowerCase() !== binding.id.toLowerCase()) throw new Error('力扣未返回匹配的真实账号');
    out.username = clean(profile.realName) || profile.userSlug;
    await optional(out, '通过题数', async () => {
      const d = await graphql(fetcher, `https://${host}/graphql/`, 'query QuestionProgress($userSlug: String!) { userProfileUserQuestionProgress(userSlug: $userSlug) { numAcceptedQuestions { difficulty count } } }', { userSlug: binding.id });
      const rows = d.userProfileUserQuestionProgress?.numAcceptedQuestions;
      if (!Array.isArray(rows)) throw new Error('通过题数未公开');
      const byDifficulty = new Map(rows.map(r => [r.difficulty, r.count]));
      if (['EASY', 'MEDIUM', 'HARD'].some(k => count(byDifficulty.get(k)) === null)) throw new Error('通过题数不完整');
      out.solvedCount = ['EASY', 'MEDIUM', 'HARD'].reduce((sum, k) => sum + byDifficulty.get(k), 0);
    });
    out.submissionCountNote = '力扣公开提交统计暂不可用；提交日历不代表每日通过题数';
    await optional(out, '提交总数', async () => {
      const d = await graphql(fetcher, `https://${host}/graphql/`, 'query SubmissionStats($userSlug: String!) { userProfileUserQuestionSubmitStats(userSlug: $userSlug) { totalSubmissionNum { difficulty count } } }', { userSlug: binding.id });
      const rows = d.userProfileUserQuestionSubmitStats?.totalSubmissionNum;
      if (!Array.isArray(rows)) throw new Error('提交总数未公开');
      const byDifficulty = new Map(rows.map(r => [r.difficulty, r.count]));
      if (['EASY', 'MEDIUM', 'HARD'].some(k => count(byDifficulty.get(k)) === null)) throw new Error('提交总数不完整');
      out.submissionCount = ['EASY', 'MEDIUM', 'HARD'].reduce((sum, k) => sum + byDifficulty.get(k), 0);
      out.submissionCountNote = '力扣公开 totalSubmissionNum，含未通过提交';
    });
    await optional(out, '最近通过记录', async () => {
      const d = await graphql(fetcher, `https://${host}/graphql/noj-go/`, 'query RecentAccepted($userSlug: String!) { recentACSubmissions(userSlug: $userSlug) { submissionId submitTime question { titleSlug } } }', { userSlug: binding.id });
      if (!Array.isArray(d.recentACSubmissions)) throw new Error('最近通过记录未公开');
      unavailableActivity(out, `力扣仅公开最近 ${d.recentACSubmissions.length} 条通过记录，无法确认全历史每题首次 AC；网站日历统计提交次数`);
    });
  } else {
    const d = await graphql(fetcher, `https://${host}/graphql/`, 'query PublicProfile($username: String!) { matchedUser(username: $username) { username profile { realName } submitStatsGlobal { acSubmissionNum { difficulty count } totalSubmissionNum { difficulty count } } } }', { username: binding.id });
    const user = d.matchedUser;
    if (typeof user?.username !== 'string' || user.username.toLowerCase() !== binding.id.toLowerCase()) throw new Error('LeetCode 未返回匹配的真实账号');
    out.username = clean(user.profile?.realName) || user.username;
    out.solvedCount = count(user.submitStatsGlobal?.acSubmissionNum?.find(r => r.difficulty === 'All')?.count);
    out.submissionCount = count(user.submitStatsGlobal?.totalSubmissionNum?.find(r => r.difficulty === 'All')?.count);
    out.submissionCountNote = out.submissionCount === null ? 'LeetCode 未公开提交总数' : 'LeetCode 公开 totalSubmissionNum，含未通过提交';
  }
  if (out.submissionCount === 0 && out.solvedCount === 0) out.activity = activityFrom(new Map(), true, '公开提交总数与通过题数均为零，暂无首次通过题目');
  await optional(out, '比赛数据', async () => {
    const arg = cn ? 'userSlug' : 'username';
    // CN moved this schema to noj-go; /graphql/ exposes a different legacy node.
    const queryFor = fields => `query ContestHistory($${arg}: String!) { userContestRanking(${arg}: $${arg}) { attendedContestsCount rating } userContestRankingHistory(${arg}: $${arg}) { attended rating ranking ${fields} contest { title ${cn ? 'titleCn' : ''} startTime } } }`;
    const endpoint = `https://${host}/graphql/${cn ? 'noj-go/' : ''}`;
    let d;
    try { d = await graphql(fetcher, endpoint, queryFor(cn ? 'totalProblems' : 'problemsSolved totalProblems'), { [arg]: binding.id }); }
    catch { d = await graphql(fetcher, endpoint, queryFor(''), { [arg]: binding.id }); }
    const ranking = d.userContestRanking;
    if (!ranking || num(ranking.rating) === null || count(ranking.attendedContestsCount) === null) throw new Error('竞赛排名未公开，不能据此判断是否参赛');
    out.rating = ranking.rating; out.ratedContests = ranking.attendedContestsCount;
    const history = d.userContestRankingHistory;
    if (!Array.isArray(history)) throw new Error('比赛历史未公开');
    const attended = history.filter(c => c.attended === true).sort((a, b) => (a.contest?.startTime || 0) - (b.contest?.startTime || 0));
    const ratings = attended.map(c => num(c.rating)).filter(n => n !== null);
    if (ratings.length) out.maxRating = Math.max(...ratings, out.rating);
    const contests = attended.map((c, i) => ({ name: String(c.contest?.titleCn || c.contest?.title || ''), url: lcContestUrl(host, String(c.contest?.titleCn || c.contest?.title || '')), date: iso(c.contest?.startTime), rank: num(c.ranking), rating: num(c.rating), delta: i > 0 && num(c.rating) !== null && num(attended[i - 1].rating) !== null ? c.rating - attended[i - 1].rating : null, ...contestCounts(c.problemsSolved, c.totalProblems) }));
    out.contests = recent(contests); historyOf(out, contests);
  });
  return out;
}

async function fetchPlatform(binding, { fetcher = globalThis.fetch, readPage, cfRequestInterval = 2000 } = {}) {
  if (!binding || typeof binding !== 'object') throw new Error('平台绑定无效');
  const parsed = parseProfileLink(binding.platform, binding.url);
  // Stored display names are never used to establish remote identity or construct requests.
  if (parsed.platform === 'CF') return cf(parsed, fetcher, Number.isFinite(cfRequestInterval) ? Math.max(0, cfRequestInterval) : 2000);
  if (parsed.platform === 'AT') return at(parsed, fetcher);
  if (parsed.platform === 'LG') return lg(parsed, readPage);
  if (parsed.platform === 'NC') return nc(parsed, readPage);
  return lc(parsed, fetcher);
}

module.exports = { PLATFORMS, parseProfileLink, fetchPlatform };
