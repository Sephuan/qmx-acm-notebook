const test = require('node:test');
const assert = require('node:assert/strict');
const { PLATFORMS, parseProfileLink, fetchPlatform: fetchPublicPlatform } = require('../electron/platform-data.cjs');
const fetchPlatform = (binding, options = {}) => fetchPublicPlatform(binding, { cfRequestInterval: 0, ...options });

const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const binding = (platform, url) => ({ platform, url, username: 'untrusted saved name', id: 'untrusted saved id' });
const cfBinding = binding('CF', 'https://codeforces.com/profile/Alice');
const atBinding = binding('AT', 'https://atcoder.jp/users/alice');
const lgBinding = binding('LG', 'https://www.luogu.com.cn/user/123');
const ncBinding = binding('NC', 'https://www.nowcoder.com/users/123');
const cnBinding = binding('LC', 'https://leetcode.cn/u/alice/');

function cfFetch({ info = { handle: 'Alice', rating: 0, maxRating: 100 }, history = [], status = [] } = {}) {
  return async url => {
    const u = new URL(url);
    if (u.pathname === '/api/user.info') return response({ status: 'OK', result: [info] });
    if (u.pathname === '/api/user.rating') return response({ status: 'OK', result: history });
    if (u.pathname === '/api/user.status') return response({ status: 'OK', result: typeof status === 'function' ? status(u) : status });
    throw new Error(`Unexpected URL ${url}`);
  };
}
const atHtml = (extra = '') => `<html><title>alice - AtCoder</title><h3><a href="/users/alice" class="username"><span class="user-gray">alice</span></a></h3><table><tr><th>Rating</th><td>0</td></tr><tr><th>Highest Rating</th><td>100</td></tr><tr><th>Rated Matches</th><td>0</td></tr></table>${extra}</html>`;
const lgPage = {
  title: 'time_lo - 个人主页 - 洛谷',
  text: 'time_lo - 个人中心/主页\n登录\n注册\ntime_lo\n提交\n434\n通过\n418\n排名\n9.50k\n等级分\n1133\n比赛等级分\n等级分\n1133\n评定比赛\n【LGR-243】洛谷入门赛\n达成时间\n2026-10-24\n历史最高\n1153',
  links: [{ text: '【LGR-243】洛谷入门赛', url: 'https://www.luogu.com.cn/contest/234567' }],
};
const ncPage = {
  title: '时洛time的个人主页_牛客网',
  text: '时洛time 关注 私信\n三峡大学 ACM\n999\nRating\n2\n次Rating赛\n3\n次比赛\n牛客练习赛158\n2026-10-16 19:00 至 21:30（时长： 2小时30分钟）\n999 (+194)\nRating\n123 / 362\n正式榜\n3 / 6\nAC数量\n牛客周赛100\n2026-10-01 19:00 至 21:00\n805 (-10)\nRating\n200 / 500\n正式榜',
  links: [{ text: '牛客练习赛158', url: 'https://ac.nowcoder.com/acm/contest/118658' }, { text: '牛客周赛100', url: '/acm/contest/100' }],
};
const progress = { userProfileUserQuestionProgress: { numAcceptedQuestions: [{ difficulty: 'EASY', count: 0 }, { difficulty: 'MEDIUM', count: 20 }, { difficulty: 'HARD', count: 2 }] } };
function lcFetch({ identity = { userSlug: 'alice', realName: 'Alice CN' }, questionProgress = progress, ranking = null, history = null, contestError = false, submissionStats = null, recentAC = [] } = {}) {
  return async (url, options) => {
    const { query, variables } = JSON.parse(options.body);
    assert.equal(variables.userSlug, 'alice');
    if (query.includes('userProfilePublicProfile')) return response({ data: { userProfilePublicProfile: { profile: identity } } });
    if (query.includes('userProfileUserQuestionProgress')) return response({ data: questionProgress });
    if (query.includes('userProfileUserQuestionSubmitStats')) { assert.equal(url, 'https://leetcode.cn/graphql/'); return response({ data: { userProfileUserQuestionSubmitStats: submissionStats } }); }
    if (query.includes('recentACSubmissions')) { assert.equal(url, 'https://leetcode.cn/graphql/noj-go/'); return response({ data: { recentACSubmissions: recentAC } }); }
    assert.equal(url, 'https://leetcode.cn/graphql/noj-go/');
    assert.ok(query.includes('userContestRankingHistory(userSlug: $userSlug)'));
    if (contestError) return response({ errors: [{ message: 'unavailable' }] });
    return response({ data: { userContestRanking: ranking, userContestRankingHistory: history } });
  };
}

test('canonical platform codes and profile URLs preserve LeetCode region', () => {
  assert.deepEqual(PLATFORMS, ['CF', 'AT', 'LG', 'NC', 'LC']);
  const cases = [
    ['CF', 'https://www.codeforces.com/profile/Alice?locale=en#info', 'https://codeforces.com/profile/Alice', 'Alice'],
    ['AT', 'https://atcoder.jp/users/alice/', 'https://atcoder.jp/users/alice', 'alice'],
    ['LG', 'https://www.luogu.com/user/123', 'https://www.luogu.com.cn/user/123', '123'],
    ['LG', 'https://luogu.com.cn/user/123/', 'https://www.luogu.com.cn/user/123', '123'],
    ['NC', 'https://www.nowcoder.com/profile/123', 'https://ac.nowcoder.com/acm/contest/profile/123', '123'],
    ['NC', 'https://ac.nowcoder.com/acm/contest/profile/123/', 'https://ac.nowcoder.com/acm/contest/profile/123', '123'],
    ['LC', 'https://leetcode.com/u/alice', 'https://leetcode.com/u/alice/', 'alice'],
    ['LC', 'https://leetcode.cn/u/alice/', 'https://leetcode.cn/u/alice/', 'alice'],
  ];
  for (const [platform, input, url, id] of cases) assert.deepEqual(parseProfileLink(platform, input), { platform, username: id, id, url });
});

test('profile URL parser rejects deceptive authority, paths, schemes and bare handles', () => {
  for (const input of ['Alice', 'http://codeforces.com/profile/Alice', 'https://codeforces.com.evil.test/profile/Alice', 'https://evil.test/codeforces.com/profile/Alice', 'https://alice@codeforces.com/profile/Alice', 'https://codeforces.com:8443/profile/Alice', 'https://codeforces.com./profile/Alice', 'https://codeforces.com/profile/Alice/status', 'https://codeforces.com/a/../profile/Alice', 'https://codeforces.com/profile/%41lice', 'https://codeforces.com\\@evil.test/profile/Alice']) assert.throws(() => parseProfileLink('CF', input), undefined, input);
  assert.equal(parseProfileLink('CF', ' https://codeforces.com/profile/Alice\n').id, 'Alice');
  assert.throws(() => parseProfileLink('LG', 'https://www.luogu.com.cn/user/alice'));
  assert.throws(() => parseProfileLink('LC', 'https://leetcode.com/alice/'));
  assert.throws(() => parseProfileLink('CF', 'https://atcoder.jp/users/alice'));
});

test('CF distinguishes zero from missing and counts unique accepted problems', async () => {
  const out = await fetchPlatform(cfBinding, { fetcher: cfFetch({ status: [{ verdict: 'OK', problem: { contestId: 1, index: 'A' } }, { verdict: 'OK', problem: { contestId: 1, index: 'A' } }, { verdict: 'WRONG_ANSWER', problem: { contestId: 2, index: 'A' } }] }) });
  assert.equal(out.username, 'Alice'); assert.equal(out.solvedCount, 1); assert.equal(out.rating, 0); assert.equal(out.ratedContests, 0);
  assert.equal(out.profileUrl, cfBinding.url);
  const missing = await fetchPlatform(cfBinding, { fetcher: cfFetch({ info: { handle: 'Alice' } }) });
  assert.equal(missing.rating, null); assert.equal(missing.maxRating, null); assert.equal(missing.solvedCount, 0);
});

test('CF paginates 1000 submissions and only exposes five latest rated contests', async () => {
  const calls = [];
  const out = await fetchPlatform(cfBinding, { fetcher: cfFetch({ history: Array.from({ length: 7 }, (_, i) => ({ contestId: i, contestName: `Round ${i}`, ratingUpdateTimeSeconds: 1700000000 + i, rank: i + 1, oldRating: i, newRating: i + 10 })), status: u => {
    calls.push([u.searchParams.get('from'), u.searchParams.get('count')]);
    return calls.length === 1 ? Array.from({ length: 1000 }, (_, i) => ({ verdict: 'OK', problem: { contestId: i, index: 'A' } })) : [{ verdict: 'OK', problem: { contestId: 1001, index: 'B' } }];
  } }) });
  assert.deepEqual(calls, [['1', '1000'], ['1001', '1000']]); assert.equal(out.solvedCount, 1001);
  assert.equal(out.ratedContests, 7); assert.equal(out.contests.length, 5); assert.equal(out.contests[0].name, 'Round 6'); assert.equal(out.contests[0].delta, 10);
  assert.equal(out.submissionCount, 1001); assert.equal(out.ratingHistory.length, 7); assert.equal(out.ratingHistory[0].name, 'Round 0'); assert.equal(out.ratingHistory.at(-1).name, 'Round 6');
});

test('CF safety cap refuses incomplete totals while retaining account rating', async () => {
  let calls = 0;
  const out = await fetchPlatform(cfBinding, { fetcher: cfFetch({ status: () => { calls++; return Array(1000).fill({ verdict: 'OK', problem: { contestId: 1, index: 'A' } }); } }) });
  assert.equal(calls, 20); assert.equal(out.solvedCount, null); assert.equal(out.rating, 0); assert.match(out.sourceNote, /不完整/);
  assert.equal(out.submissionCount, null); assert.equal(out.activity.complete, false); assert.deepEqual(out.activity.days, {});
});

test('CF rejects nonexistent and mismatched accounts instead of reflected placeholders', async () => {
  await assert.rejects(fetchPlatform(cfBinding, { fetcher: cfFetch({ info: { handle: 'Bob' } }) }), /真实账号/);
  await assert.rejects(fetchPlatform(cfBinding, { fetcher: async () => response({ status: 'FAILED', comment: 'not found' }) }), /not found/);
});

test('AT official profile/history and third-party count preserve zero and actual contest host suffix', async () => {
  const out = await fetchPlatform(atBinding, { fetcher: async url => {
    if (url.endsWith('?lang=en')) return { ok: true, text: async () => atHtml() };
    if (url.endsWith('/history/json')) return response([{ IsRated: true, ContestName: 'ABC 400', ContestScreenName: 'abc400.contest.atcoder.jp', EndTime: '2026-01-01T00:00:00+09:00', NewRating: 0, OldRating: 0, Place: 4 }]);
    assert.equal(url, 'https://kenkoooo.com/atcoder/atcoder-api/v3/user_info?user=alice');
    return response({ user_id: 'alice', accepted_count: 22 });
  } });
  assert.equal(out.username, 'alice'); assert.equal(out.solvedCount, 22); assert.equal(out.rating, 0); assert.equal(out.ratedContests, 1); assert.equal(out.contests[0].url, 'https://atcoder.jp/contests/abc400');
});

test('AT recent history includes unrated competitions without claiming rating or delta', async () => {
  const out = await fetchPlatform(atBinding, { fetcher: async url => {
    if (url.endsWith('?lang=en')) return { ok: true, text: async () => atHtml() };
    if (url.endsWith('/history/json')) return response([{ IsRated: false, ContestName: 'ABC 479', ContestScreenName: 'abc479.contest.atcoder.jp', EndTime: '2026-11-01T00:00:00+09:00', NewRating: 0, OldRating: 0, Place: 100 }]);
    return response({ user_id: 'alice', accepted_count: 0 });
  } });
  assert.equal(out.ratedContests, 0); assert.equal(out.contests[0].url, 'https://atcoder.jp/contests/abc479'); assert.equal(out.contests[0].rating, null); assert.equal(out.contests[0].delta, null); assert.equal(out.contests[0].rank, 100);
});

test('AT optional failures keep official metrics and unrecognized HTML fails', async () => {
  const out = await fetchPlatform(atBinding, { fetcher: async url => url.endsWith('?lang=en') ? { ok: true, text: async () => atHtml() } : response({}, 503) });
  assert.equal(out.rating, 0); assert.equal(out.solvedCount, null); assert.equal(out.ratedContests, 0); assert.match(out.sourceNote, /HTTP 503/);
  await assert.rejects(fetchPlatform(atBinding, { fetcher: async () => ({ ok: true, text: async () => '<title>alice - AtCoder</title><p>alice</p>' }) }), /有效个人主页/);
});

test('LG observed homepage extracts 418 passed, ratings and last evaluated contest', async () => {
  const calls = [];
  const out = await fetchPlatform(lgBinding, { readPage: async url => { calls.push(url); return lgPage; } });
  assert.deepEqual(calls, ['https://www.luogu.com.cn/user/123']); assert.equal(out.username, 'time_lo'); assert.equal(out.solvedCount, 418); assert.equal(out.rating, 1133); assert.equal(out.maxRating, 1153); assert.equal(out.ratedContests, null);
  assert.deepEqual(out.contests[0], { name: '【LGR-243】洛谷入门赛', url: 'https://www.luogu.com.cn/contest/234567', date: '2026-10-24', rank: null, rating: 1133, delta: null, solvedCount: null, problemCount: null });
});

test('rendered collectors reject challenge pages and reflected names without profile structure', async () => {
  await assert.rejects(fetchPlatform(lgBinding, { readPage: async () => ({ text: 'Just a moment... Checking your browser', links: [] }) }), /验证/);
  await assert.rejects(fetchPlatform(lgBinding, { readPage: async () => ({ title: 'time_lo - 个人中心', text: '登录\n注册\n输入用户 time_lo', links: [] }) }), /真实用户/);
  await assert.rejects(fetchPlatform(ncBinding, { readPage: async () => ({ title: '用户不存在', text: '时洛time', links: [] }) }), /不存在/);
  await assert.rejects(fetchPlatform(lgBinding), /桌面浏览器/);
});

test('NC rendered profile and practice parse current metrics and ordered contest segments', async () => {
  const calls = [];
  const out = await fetchPlatform(ncBinding, { readPage: async url => { calls.push(url); return url.endsWith('/practice-coding') ? { text: '9\n题已挑战\n8\n题已通过\n16\n次提交', links: [] } : ncPage; } });
  assert.deepEqual(calls, ['https://ac.nowcoder.com/acm/contest/profile/123', 'https://ac.nowcoder.com/acm/contest/profile/123/practice-coding']);
  assert.equal(out.username, '时洛time'); assert.equal(out.rating, 999); assert.equal(out.ratedContests, 2); assert.equal(out.solvedCount, 8); assert.equal(out.maxRating, null);
  assert.deepEqual(out.contests[0], { name: '牛客练习赛158', url: 'https://ac.nowcoder.com/acm/contest/118658', date: '2026-10-16T19:00:00+08:00', rank: 123, rating: 999, delta: 194, rated: true, solvedCount: 3, problemCount: 6 });
  assert.equal(out.contests[1].delta, -10); assert.equal(out.contests[1].rank, 200);
});

test('NC includes unrated competition and alternative rank label from actual contest cards', async () => {
  const text = ncPage.text + '\n2026ctgu_acm_秋测\n2026-09-27 18:00 至 21:00（时长： 3小时）\n不计\nRating\n8 / 16\n排名\n3 / 6\nAC数量';
  const out = await fetchPlatform(ncBinding, { readPage: async url => url.endsWith('/practice-coding') ? { text: '0\n题已挑战\n0\n题已通过\n0\n次提交', links: [] } : { ...ncPage, text, links: [...ncPage.links, { text: '2026ctgu_acm_秋测', url: '/acm/contest/111111' }] } });
  assert.equal(out.solvedCount, 0); assert.equal(out.contests.length, 3); assert.equal(out.contests[2].rank, 8); assert.equal(out.contests[2].rating, null); assert.equal(out.contests[2].delta, null); assert.equal(out.contests[2].rated, false);
});

test('NC optional practice failure keeps rating and rejects untrusted contest links', async () => {
  const out = await fetchPlatform(ncBinding, { readPage: async url => {
    if (url.endsWith('/practice-coding')) throw new Error('offline');
    return { ...ncPage, links: [{ text: '牛客练习赛158', url: 'https://evil.test/acm/contest/118658' }] };
  } });
  assert.equal(out.rating, 999); assert.equal(out.solvedCount, null); assert.deepEqual(out.contests, []); assert.match(out.sourceNote, /offline/);
});

test('LC CN uses verified profile/progress schema and null ranking stays unknown', async () => {
  const out = await fetchPlatform(cnBinding, { fetcher: lcFetch() });
  assert.equal(out.username, 'Alice CN'); assert.equal(out.solvedCount, 22); assert.equal(out.rating, null); assert.equal(out.maxRating, null); assert.equal(out.ratedContests, null); assert.deepEqual(out.contests, []); assert.match(out.sourceNote, /不能据此判断/);
});

test('LC CN ranking uses noj-go and only attended contests enter max/recent history', async () => {
  const history = Array.from({ length: 7 }, (_, i) => ({ attended: true, rating: 1500 + i * 10, ranking: i + 1, contest: { title: `Weekly Contest ${i}`, titleCn: `第 ${i} 场周赛`, startTime: 1700000000 + i } }));
  history.push({ attended: false, rating: 99999, contest: { startTime: 1800000000 } });
  const out = await fetchPlatform(cnBinding, { fetcher: lcFetch({ ranking: { rating: 1560, attendedContestsCount: 7 }, history }) });
  assert.equal(out.maxRating, 1560); assert.equal(out.ratedContests, 7); assert.equal(out.contests.length, 5); assert.equal(out.contests[0].url, 'https://leetcode.cn/contest/weekly-contest-6/'); assert.equal(out.contests[0].delta, 10);
  assert.equal(out.ratingHistory.length, 7); assert.equal(out.ratingHistory[0].rating, 1500); assert.equal(out.ratingHistory.at(-1).rating, 1560);
});

test('LC preserves partial data, requires recognized identity, and avoids incomplete difficulty totals', async () => {
  const out = await fetchPlatform(cnBinding, { fetcher: lcFetch({ contestError: true, questionProgress: { userProfileUserQuestionProgress: { numAcceptedQuestions: [{ difficulty: 'EASY', count: 0 }] } } }) });
  assert.equal(out.solvedCount, null); assert.equal(out.username, 'Alice CN'); assert.equal(out.rating, null);
  await assert.rejects(fetchPlatform(cnBinding, { fetcher: lcFetch({ identity: null }) }), /真实账号/);
  await assert.rejects(fetchPlatform(cnBinding, { fetcher: lcFetch({ identity: { userSlug: 'bob' } }) }), /真实账号/);
});

test('LC international uses matchedUser and its own hostname with true zero metrics', async () => {
  const out = await fetchPlatform(binding('LC', 'https://leetcode.com/u/alice/'), { fetcher: async (url, opts) => {
    assert.equal(url, 'https://leetcode.com/graphql/'); const { query, variables } = JSON.parse(opts.body); assert.equal(variables.username, 'alice');
    if (query.includes('matchedUser')) return response({ data: { matchedUser: { username: 'alice', profile: { realName: '' }, submitStatsGlobal: { acSubmissionNum: [{ difficulty: 'All', count: 0 }] } } } });
    return response({ data: { userContestRanking: { rating: 0, attendedContestsCount: 0 }, userContestRankingHistory: [] } });
  } });
  assert.equal(out.username, 'alice'); assert.equal(out.solvedCount, 0); assert.equal(out.rating, 0); assert.equal(out.ratedContests, 0); assert.equal(out.maxRating, null);
});

test('network requests have timeout signals, omit credentials and refuse redirects', async () => {
  await fetchPlatform(cfBinding, { fetcher: async (url, opts) => { assert.ok(opts.signal instanceof AbortSignal); assert.equal(opts.credentials, 'omit'); assert.equal(opts.redirect, 'error'); return cfFetch()(url); } });
  let calls = 0;
  await assert.rejects(fetchPlatform(binding('CF', 'https://evil.test/profile/alice'), { fetcher: async () => { calls++; } })); assert.equal(calls, 0);
});

test('oversized JSON stream is cancelled and malformed response never becomes an account', async () => {
  let cancelled = false;
  const huge = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); }, cancel() { cancelled = true; } });
  await assert.rejects(fetchPlatform(cfBinding, { fetcher: async () => ({ ok: true, body: huge }) }), /响应过大/); assert.equal(cancelled, true);
  await assert.rejects(fetchPlatform(cfBinding, { fetcher: async () => new Response('<html>Just a moment</html>') }), /验证/);
});

test('CF first AC uses earliest acceptance across history and Shanghai midnight, not submission volume', async () => {
  const seconds = text => Date.parse(text) / 1000;
  const row = (id, pid, time, verdict = 'OK') => ({ id, verdict, creationTimeSeconds: seconds(time), problem: { contestId: 42, index: pid } });
  const out = await fetchPlatform(cfBinding, { fetcher: cfFetch({ status: [
    row(5, 'A', '2026-01-03T00:00:00Z'), row(4, 'B', '2026-01-01T16:00:00Z'),
    row(3, 'A', '2026-01-01T15:59:59Z'), row(2, 'C', '2026-01-01T15:50:00Z', 'WRONG_ANSWER'),
    row(1, 'B', '2026-01-01T16:01:00Z'),
  ] }) });
  assert.equal(out.submissionCount, 5); assert.equal(out.solvedCount, 2); assert.equal(out.activity.complete, true);
  assert.deepEqual(out.activity.days, { '2026-01-01': 1, '2026-01-02': 1 });
  const zero = await fetchPlatform(cfBinding, { fetcher: cfFetch() });
  assert.equal(zero.submissionCount, 0); assert.deepEqual(zero.activity.days, {}); assert.equal(zero.activity.complete, true);
  const unavailable = await fetchPlatform(cfBinding, { fetcher: async url => url.includes('user.status') ? response({}, 503) : cfFetch()(url) });
  assert.equal(unavailable.submissionCount, null); assert.equal(unavailable.activity.complete, false); assert.deepEqual(unavailable.activity.days, {}); assert.equal(unavailable.rating, 0);
});

function atFetch({ rows = [], history = [], accepted = 0 } = {}) {
  return async url => {
    if (url.endsWith('?lang=en')) return { ok: true, text: async () => atHtml() };
    if (url.endsWith('/history/json')) return response(history);
    if (url.includes('/user_info?')) return response({ user_id: 'alice', accepted_count: accepted });
    assert.ok(url.startsWith('https://kenkoooo.com/atcoder/atcoder-api/v3/user/submissions?user=alice&from_second='));
    return response(typeof rows === 'function' ? rows(new URL(url)) : rows);
  };
}
const atSubmission = (id, problem, seconds, verdict = 'AC') => ({ id, user_id: 'alice', problem_id: problem, epoch_second: seconds, result: verdict });

test('AT complete submissions count every verdict but each problem only on earliest AC, official full history excludes unrated', async () => {
  const history = Array.from({ length: 8 }, (_, i) => ({ IsRated: i !== 7, ContestName: `ABC ${i}`, ContestScreenName: `abc${i}.contest.atcoder.jp`, EndTime: `2026-01-${String(i + 1).padStart(2, '0')}T20:00:00+09:00`, NewRating: i * 10, OldRating: i * 10 - 10, Place: i + 1 })).reverse();
  const before = Date.parse('2026-01-01T15:59:59Z') / 1000;
  const out = await fetchPlatform(atBinding, { fetcher: atFetch({ history, accepted: 2, rows: [atSubmission(1, 'abc_a', before), atSubmission(2, 'abc_a', before + 1), atSubmission(3, 'abc_b', before + 1, 'WA'), atSubmission(4, 'abc_b', before + 2)] }) });
  assert.equal(out.submissionCount, 4); assert.equal(out.solvedCount, 2); assert.equal(out.activity.complete, true); assert.deepEqual(out.activity.days, { '2026-01-01': 1, '2026-01-02': 1 });
  assert.equal(out.ratingHistory.length, 7); assert.equal(out.ratingHistory[0].name, 'ABC 0'); assert.equal(out.ratingHistory.at(-1).name, 'ABC 6'); assert.equal(out.contests.length, 5); assert.equal(out.contests[0].rated, false);
});

test('AT pagination audits equal-second boundary before advancing last timestamp +1', async () => {
  const seen = []; const seconds = Date.parse('2026-01-01T16:00:00Z') / 1000;
  const out = await fetchPlatform(atBinding, { fetcher: atFetch({ accepted: 2, rows: u => {
    const from = Number(u.searchParams.get('from_second')); seen.push(from);
    if (from === 0) return Array.from({ length: 500 }, (_, i) => atSubmission(i + 1, 'abc_a', seconds - 499 + i));
    if (from === seconds) return [atSubmission(500, 'abc_a', seconds), atSubmission(501, 'abc_b', seconds), atSubmission(502, 'abc_c', seconds + 1, 'WA')];
    if (from === seconds + 1) return [atSubmission(502, 'abc_c', seconds + 1, 'WA')];
    throw new Error(`unexpected cursor ${from}`);
  } }) });
  assert.deepEqual(seen, [0, seconds, seconds + 1]); assert.equal(out.submissionCount, 502); assert.equal(out.activity.complete, true); assert.equal(out.solvedCount, 2);
  assert.deepEqual(out.activity.days, { '2026-01-01': 1, '2026-01-02': 1 });
});

test('AT same-second 500-row cap refuses false completeness and retains known solved count', async () => {
  const out = await fetchPlatform(atBinding, { fetcher: atFetch({ accepted: 50, rows: Array.from({ length: 500 }, (_, i) => atSubmission(i + 1, 'abc_a', 1700000000)) }) });
  assert.equal(out.submissionCount, null); assert.equal(out.solvedCount, 50); assert.equal(out.activity.complete, false); assert.deepEqual(out.activity.days, {}); assert.match(out.activity.note, /同一时间戳/);
});

test('AT contradictory complete history preserves separately verified solved count and unknown timeline', async () => {
  const out = await fetchPlatform(atBinding, { fetcher: atFetch({ accepted: 900, rows: [atSubmission(1, 'abc_a', 1700000000)] }) });
  assert.equal(out.solvedCount, 900); assert.equal(out.submissionCount, null); assert.equal(out.activity.complete, false);
  assert.deepEqual(out.activity.days, {}); assert.match(out.submissionCountNote, /不一致/);
});

test('LG maps homepage submitted field and submission calendars never become daily solve totals', async () => {
  const out = await fetchPlatform(lgBinding, { readPage: async () => ({ ...lgPage, activity: { metric: 'submissions', timezone: 'Asia/Shanghai', days: { '2026-01-01': 434 }, complete: true } }) });
  assert.equal(out.submissionCount, 434); assert.equal(out.submissionCountNote, '洛谷主页“提交”显示值'); assert.equal(out.activity.complete, false); assert.deepEqual(out.activity.days, {}); assert.deepEqual(out.ratingHistory, []);
  const exact = await fetchPlatform(lgBinding, { readPage: async () => ({ ...lgPage, text: lgPage.text.replace('418', '2'), firstAccepted: { complete: true, records: [{ problemId: 'P1000', timestamp: '2026-01-02T00:00:00+08:00' }, { problemId: 'P1000', timestamp: '2026-01-01T15:59:59Z' }, { problemId: 'P1001', timestamp: '2026-01-01T16:00:00Z' }] } }) });
  assert.equal(exact.activity.complete, true); assert.deepEqual(exact.activity.days, { '2026-01-01': 1, '2026-01-02': 1 });
});

function ncPractice(rows, { total = 16, solved = 8 } = {}) {
  const links = [];
  const text = `${solved + 1}\n题已挑战\n${solved}\n题已通过\n${total}\n次提交\n运行ID\t题目\t运行结果\t提交时间\n` + rows.map(r => {
    links.push({ text: String(r.id), url: `/acm/contest/view-submission?submissionId=${r.id}&uid=123` }, { text: `题目${r.problem}`, url: `/acm/problem/${r.problem}` });
    return `${r.id}\t题目${r.problem}\t${r.verdict || '答案正确'}\t100\t4\t200\t500\tC++\t${r.time}`;
  }).join('\n');
  return { text, links };
}

test('LG public calendar preserves official metric, limited China interval and hidden unknown state', async () => {
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const midnight = Date.parse(`${today}T00:00:00Z`);
  const yesterday = new Date(midnight - 86400000).toISOString().slice(0, 10);
  const start = new Date(midnight - 180 * 86400000).toISOString().slice(0, 10);
  const out = await fetchPlatform(lgBinding, { readPage: async () => ({ ...lgPage, publicData: { uid: 123, dailyCounts: { [yesterday]: [3, 2], [start]: [1, 1], [today]: [9, 3], '2000-01-01': [100, 9] } } }) });
  assert.equal(out.activity.complete, false); assert.equal(out.activity.rangeComplete, true); assert.equal(out.activity.metric, 'platformDailySolved'); assert.equal(out.activity.startDate, start); assert.equal(out.activity.endDate, yesterday);
  assert.deepEqual(out.activity.days, { [start]: 1, [yesterday]: 3 }); assert.match(out.activity.note, /口径不同/); assert.equal(out.submissionCount, 434);
  for (const publicData of [{ uid: 123, dailyCounts: {} }, { uid: 456, dailyCounts: { [yesterday]: [3, 2] } }, { uid: 123, dailyCounts: { [yesterday]: [-1, 2] } }]) {
    const unavailable = await fetchPlatform(lgBinding, { readPage: async () => ({ ...lgPage, publicData }) });
    assert.equal(unavailable.activity.complete, false); assert.equal(unavailable.activity.rangeComplete, undefined); assert.deepEqual(unavailable.activity.days, {}); assert.equal(unavailable.solvedCount, 418);
  }
});

test('NC reads first10 plus last6 and deduplicates earliest AC across pages', async () => {
  const rows = Array.from({ length: 16 }, (_, i) => ({ id: 100 + i, problem: i % 8 + 1, time: i < 10 ? '2026-01-02 00:00:00' : '2026-01-01 23:59:59' }));
  const calls = [];
  const out = await fetchPlatform(ncBinding, { readPage: async url => {
    calls.push(url);
    if (!url.includes('/practice-coding')) return ncPage;
    return ncPractice(url.includes('page=2') ? rows.slice(10) : rows.slice(0, 10));
  } });
  assert.equal(calls.length, 3); assert.equal(new URL(calls[2]).searchParams.get('page'), '2'); assert.equal(out.submissionCount, 16); assert.equal(out.activity.complete, true); assert.deepEqual(out.activity.days, { '2026-01-01': 6, '2026-01-02': 2 });
});

test('NC pagination errors and 20-page cap preserve total submissions while refusing incomplete activity', async () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, problem: i + 1, time: '2026-01-01 00:00:00' }));
  const failure = await fetchPlatform(ncBinding, { readPage: async url => {
    if (!url.includes('/practice-coding')) return ncPage;
    if (url.includes('page=2')) throw new Error('last page offline');
    return ncPractice(rows);
  } });
  assert.equal(failure.submissionCount, 16); assert.equal(failure.solvedCount, 8); assert.equal(failure.activity.complete, false); assert.deepEqual(failure.activity.days, {}); assert.match(failure.sourceNote, /last page offline/);
  let pages = 0;
  const capped = await fetchPlatform(ncBinding, { readPage: async url => {
    if (!url.includes('/practice-coding')) return ncPage;
    pages++; return ncPractice(rows.map(r => ({ ...r, id: r.id + pages * 10 })), { total: 201, solved: 10 });
  } });
  assert.equal(pages, 20); assert.equal(capped.submissionCount, 201); assert.equal(capped.activity.complete, false); assert.match(capped.activity.note, /20 页/);
});

test('LC CN official submission totals stay distinct from limited recent AC and submit calendar', async () => {
  const totals = counts => ({ totalSubmissionNum: ['EASY', 'MEDIUM', 'HARD'].map((difficulty, i) => ({ difficulty, count: counts[i] })) });
  const out = await fetchPlatform(cnBinding, { fetcher: lcFetch({ submissionStats: totals([10, 20, 3]), recentAC: [{ submissionId: '1', submitTime: '1700000000', question: { titleSlug: 'two-sum' } }] }) });
  assert.equal(out.submissionCount, 33); assert.equal(out.solvedCount, 22); assert.equal(out.activity.complete, false); assert.deepEqual(out.activity.days, {}); assert.match(out.activity.note, /最近 1 条/);
  const zeroProgress = { userProfileUserQuestionProgress: { numAcceptedQuestions: ['EASY', 'MEDIUM', 'HARD'].map(difficulty => ({ difficulty, count: 0 })) } };
  const zero = await fetchPlatform(cnBinding, { fetcher: lcFetch({ questionProgress: zeroProgress, submissionStats: totals([0, 0, 0]) }) });
  assert.equal(zero.submissionCount, 0); assert.equal(zero.activity.complete, true); assert.deepEqual(zero.activity.days, {});
  const unknown = await fetchPlatform(cnBinding, { fetcher: lcFetch({ submissionStats: { totalSubmissionNum: [{ difficulty: 'EASY', count: 0 }] }, recentAC: null }) });
  assert.equal(unknown.submissionCount, null); assert.equal(unknown.activity.complete, false); assert.equal(unknown.solvedCount, 22);
});

test('CF contest ACs exclude practice, virtual, partial scores and duplicates; official problem total reaches full history', async () => {
  const history = Array.from({ length: 6 }, (_, i) => ({ contestId: 40 + i, contestName: `Round ${i}`, ratingUpdateTimeSeconds: 1700000000 + i, rank: 1, oldRating: 0, newRating: 100 }));
  const row = (id, contestId, index, participantType, verdict = 'OK') => ({ id, contestId, problem: { contestId, index }, author: { participantType }, verdict, creationTimeSeconds: 1700000000 });
  const statuses = [row(1, 45, 'A', 'CONTESTANT'), row(2, 45, 'A', 'CONTESTANT'), row(3, 45, 'B', 'PRACTICE'), row(4, 45, 'C', 'VIRTUAL'), row(5, 45, 'D', 'CONTESTANT', 'PARTIAL'), row(6, 40, 'A', 'CONTESTANT')];
  const calls = [];
  const out = await fetchPlatform(cfBinding, { fetcher: async url => {
    const u = new URL(url);
    if (u.pathname === '/api/contest.standings') {
      calls.push(u.search); assert.deepEqual([...u.searchParams.keys()], ['contestId']);
      const id = Number(u.searchParams.get('contestId'));
      return response({ status: 'OK', result: { contest: { id, type: 'IOI' }, problems: ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map(index => ({ contestId: id, index })), rows: [{ problemResults: [{ points: 20 }] }] } });
    }
    return cfFetch({ history, status: statuses })(url);
  } });
  assert.equal(calls.length, 3); assert.equal(out.contests[0].solvedCount, 1); assert.equal(out.contests[0].problemCount, 7);
  assert.equal(out.ratingHistory.at(-1).solvedCount, 1); assert.equal(out.ratingHistory.at(-1).problemCount, 7);
  assert.equal(out.ratingHistory[0].solvedCount, 1); assert.equal(out.ratingHistory[0].problemCount, null);
  assert.equal(out.ratingHistory[1].solvedCount, 0); assert.equal(out.ratingHistory[1].problemCount, null);
});

test('CF incomplete or unverifiable contest submissions stay unknown and standings failures retain metrics', async () => {
  const history = [{ contestId: 42, contestName: 'Round', ratingUpdateTimeSeconds: 1700000000, newRating: 100 }];
  const out = await fetchPlatform(cfBinding, { fetcher: cfFetch({ history, status: [{ verdict: 'OK', problem: { contestId: 42, index: 'A' } }] }) });
  assert.equal(out.contests[0].solvedCount, null); assert.equal(out.contests[0].problemCount, null); assert.equal(out.ratingHistory[0].solvedCount, null); assert.equal(out.solvedCount, 1);
  const failed = await fetchPlatform(cfBinding, { fetcher: async url => url.includes('/user.status') ? response({}, 503) : cfFetch({ history })(url) });
  assert.equal(failed.contests[0].solvedCount, null); assert.equal(failed.rating, 0);
});

test('CF reads bounded standings metadata and cancels before oversized ranking rows', async () => {
  let cancelled = false; let readRows = false;
  const history = [{ contestId: 42, contestName: 'Round', ratingUpdateTimeSeconds: 1700000000, newRating: 100 }];
  const prefix = JSON.stringify({ status: 'OK', result: { contest: { id: 42, name: 'name containing , "rows": [ is harmless' }, problems: ['A', 'B'].map(index => ({ contestId: 42, index })), rows: [] } }).replace(/\[\]\}\}$/, '[');
  const out = await fetchPlatform(cfBinding, { fetcher: async url => {
    if (!url.includes('contest.standings')) return cfFetch({ history })(url);
    let part = 0;
    return { ok: true, headers: { get: () => String(16 * 1024 * 1024) }, body: new ReadableStream({
      pull(controller) {
        if (part++ === 0) controller.enqueue(Buffer.from(prefix.slice(0, 35)));
        else if (part === 2) controller.enqueue(Buffer.from(prefix.slice(35)));
        else { readRows = true; controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); }
      }, cancel() { cancelled = true; },
    }, { highWaterMark: 0 }) };
  } });
  assert.equal(cancelled, true); assert.equal(readRows, false); assert.equal(out.contests[0].problemCount, 2); assert.equal(out.ratingHistory[0].problemCount, 2);
});

test('CF serializes API calls with the configured gap, including added standings calls', async () => {
  const times = [];
  await fetchPlatform(cfBinding, { cfRequestInterval: 20, fetcher: async url => { times.push(Date.now()); return cfFetch()(url); } });
  assert.equal(times.length, 3); assert.ok(times[1] - times[0] >= 18); assert.ok(times[2] - times[1] >= 18);
});

const atTasksHtml = (slug, start = '2026-11-07 21:00:00+0900', end = '2026-11-07 22:40:00+0900') => `<time class="fixtime fixtime-full">${start}</time><time class="fixtime fixtime-full">${end}</time>` + ['a', 'b', 'c', 'd', 'e', 'f', 'g'].flatMap(p => [`<a href="/contests/${slug}/tasks/${slug}_${p}">${p}</a>`, `<a href="/contests/${slug}/tasks/${slug}_${p}">task</a>`]).join('');

test('AT official task list plus complete AC history counts only unique tasks inside the actual contest', async () => {
  const history = [{ IsRated: true, ContestName: 'ABC483', ContestScreenName: 'abc483.contest.atcoder.jp', EndTime: '2026-11-07T22:40:00+09:00', NewRating: 382, OldRating: 330, Place: 5200 }];
  const start = Date.parse('2026-11-07T21:00:00+09:00') / 1000; const end = start + 6000;
  const rows = [atSubmission(1, 'abc483_a', start), atSubmission(2, 'abc483_a', start + 1), atSubmission(3, 'abc483_b', end - 1), atSubmission(4, 'abc483_c', end), atSubmission(5, 'abc483_d', start - 1), atSubmission(6, 'abc483_e', start + 100, 'WA'), atSubmission(7, 'another_a', start + 100)];
  const out = await fetchPlatform(atBinding, { fetcher: async url => url === 'https://atcoder.jp/contests/abc483/tasks?lang=en' ? { ok: true, text: async () => atTasksHtml('abc483') } : atFetch({ history, rows, accepted: 5 })(url) });
  assert.equal(out.contests[0].solvedCount, 2); assert.equal(out.contests[0].problemCount, 7); assert.equal(out.ratingHistory[0].solvedCount, 2); assert.equal(out.ratingHistory[0].problemCount, 7);
  assert.equal(out.submissionCount, 7); assert.equal(out.solvedCount, 5);
  const unavailable = await fetchPlatform(atBinding, { fetcher: async url => url.includes('/tasks?') ? { ok: true, text: async () => atTasksHtml('abc483', '2026-11-07 21:00:00+0900', '2026-11-07 23:00:00+0900') } : atFetch({ history, rows, accepted: 5 })(url) });
  assert.equal(unavailable.contests[0].solvedCount, null); assert.equal(unavailable.contests[0].problemCount, null); assert.equal(unavailable.rating, 382);
});

test('NC AC fractions cover rated and unrated cards and do not borrow another contest fraction', async () => {
  const out = await fetchPlatform(ncBinding, { readPage: async url => url.includes('/practice-coding') ? { text: '0 题已挑战 0 题已通过 0 次提交', links: [] } : ncPage });
  assert.equal(out.contests[0].solvedCount, 3); assert.equal(out.contests[0].problemCount, 6); assert.equal(out.ratingHistory.at(-1).solvedCount, 3);
  assert.equal(out.contests[1].solvedCount, null); assert.equal(out.contests[1].problemCount, null);
  const bad = await fetchPlatform(ncBinding, { readPage: async url => url.includes('/practice-coding') ? { text: '0 题已挑战 0 题已通过 0 次提交', links: [] } : { ...ncPage, text: ncPage.text.replace('3 / 6\nAC数量', '7 / 6\nAC数量') } });
  assert.equal(bad.contests[0].solvedCount, null); assert.equal(bad.contests[0].problemCount, 6);
});

test('LC CN requests its verified totalProblems schema and retains unknown AC rather than score', async () => {
  const original = lcFetch({ ranking: { rating: 1500, attendedContestsCount: 1 }, history: [{ attended: true, rating: 1500, ranking: 10, totalProblems: 4, score: 12, contest: { title: 'Weekly Contest 1', startTime: 1700000000 } }] });
  const out = await fetchPlatform(cnBinding, { fetcher: async (url, opts) => {
    const { query } = JSON.parse(opts.body); if (query.includes('userContestRankingHistory')) { assert.ok(query.includes('totalProblems')); assert.ok(!query.includes('problemsSolved')); }
    return original(url, opts);
  } });
  assert.equal(out.contests[0].solvedCount, null); assert.equal(out.contests[0].problemCount, 4); assert.equal(out.ratingHistory[0].problemCount, 4);
});

test('LC international exposes official problemsSolved and falls back if optional schema changes', async () => {
  const lc = binding('LC', 'https://leetcode.com/u/alice/'); let fallback = 0;
  const run = rejectFields => fetchPlatform(lc, { fetcher: async (url, opts) => {
    const { query } = JSON.parse(opts.body);
    if (query.includes('matchedUser')) return response({ data: { matchedUser: { username: 'alice', profile: {}, submitStatsGlobal: {} } } });
    if (rejectFields && query.includes('problemsSolved')) return response({ errors: [{ message: 'Cannot query field' }] });
    if (!query.includes('problemsSolved')) fallback++;
    return response({ data: { userContestRanking: { rating: 1500, attendedContestsCount: 1 }, userContestRankingHistory: [{ attended: true, rating: 1500, ranking: 1, ...(rejectFields ? {} : { problemsSolved: 3, totalProblems: 4 }), contest: { title: 'Weekly Contest 1', startTime: 1700000000 } }] } });
  } });
  const out = await run(false); assert.equal(out.contests[0].solvedCount, 3); assert.equal(out.contests[0].problemCount, 4); assert.equal(out.ratingHistory[0].solvedCount, 3);
  const legacy = await run(true); assert.equal(fallback, 1); assert.equal(legacy.rating, 1500); assert.equal(legacy.contests[0].solvedCount, null); assert.equal(legacy.contests[0].problemCount, null);
});
