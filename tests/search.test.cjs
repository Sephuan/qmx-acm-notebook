'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const search = require('../ui/search.js');
const { normalizePlatform, difficulty, match } = search;

test('same API loads in CommonJS and as a browser global without a DOM', () => {
  const context = vm.createContext({ URL });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../ui/search.js'), 'utf8'), context);
  assert.deepEqual(Object.keys(context.NotebookSearch).sort(), Object.keys(search).sort());
  assert.equal(context.NotebookSearch.match({ pid: 'CF1900D' }, 'CF 1900 D'), match({ pid: 'CF1900D' }, 'CF 1900 D'));
});

test('platform aliases normalize to stable platform codes', () => {
  for (const [code, aliases] of [['CF', ['CF', 'Codeforces', 'codeforces', 'ＣＦ']], ['LG', ['LG', '洛谷', 'Luogu']], ['AT', ['AT', 'AtCoder', 'atcoder']], ['NC', ['NC', 'NowCoder', '牛客']], ['LC', ['LC', 'LeetCode', '力扣']]]) {
    for (const alias of aliases) assert.equal(normalizePlatform(alias), code, alias);
  }
  assert.equal(normalizePlatform(' custom '), 'custom');
  assert.equal(normalizePlatform(null), 'Oth');
});

test('CF native rating boundaries preserve all current colors and ranks', () => {
  for (const [rating, tone, rank] of [[800, 'gray', ''], [1199, 'gray', ''], [1200, 'green', ''], [1400, 'cyan', ''], [1600, 'blue', ''], [1900, 'purple', ''], [2100, 'orange', ''], [2300, 'orange', ''], [2400, 'red', ''], [2600, 'red', 'grandmaster'], [2999, 'red', 'grandmaster'], [3000, 'red', 'legendary']]) {
    const result = difficulty({ platform: 'codeforces', rating });
    assert.equal(result.tone, tone, String(rating));
    assert.equal(result.rank, rank, String(rating));
    assert.equal(result.level, rating);
    assert.equal(result.label, `CF ${rating}`);
  }
  assert.equal(difficulty({ platform: 'CF', rating: '1900' }).level, 1900);
});

test('Luogu levels use native colors, including minus and full-width aliases', () => {
  const names = ['入门', '普及-', '普及', '普及+/提高-', '提高', '提高+/省选-', '省选/NOI-', 'NOI/NOI+/CTS'];
  const colors = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'black'];
  names.forEach((name, index) => {
    assert.deepEqual(difficulty({ platform: 'Luogu', difficulty: name }), { tone: colors[index], rank: '', label: name, native: name, level: index + 1 });
  });
  for (const alias of ['普及−', '普及–', ' 普及 — ', '普及－']) assert.equal(difficulty({ platform: 'LG', difficulty: alias }).level, 2);
  assert.equal(difficulty({ platform: '洛谷', difficulty: '提高＋／省选−' }).level, 6);
  assert.equal(difficulty({ platform: 'LG', difficulty: 'NOI+' }).level, 8);
  assert.equal(difficulty({ platform:'LG', difficulty:'普及/提高-' }).level,3);
  assert.equal(difficulty({ platform:'LG', difficulty:'普及+/提高' }).level,4);
  assert.equal(difficulty({ platform:'LG', difficulty:'NOI/NOI+/CTSC' }).level,8);
});

test('LeetCode uses native English and Chinese levels without cross-platform conversion', () => {
  for (const [names, tone, level] of [[['Easy', '简单', 'Easy 简单'], 'green', 1], [['Medium', '中等', 'Medium（中等）'], 'yellow', 2], [['Hard', '困难'], 'red', 3]]) {
    for (const name of names) assert.equal(difficulty({ platform: 'LC', difficulty: name }).tone, tone);
    assert.equal(difficulty({ platform: 'LeetCode', difficulty: names[0] }).level, level);
  }
  assert.deepEqual(difficulty({ platform: 'AT', rating: 1900, difficulty: 'ABC D' }), { tone: 'neutral', rank: '', label: 'Rating 1900 · ABC D', native: 'ABC D', level: null });
  for (const rating of ['', ' ', null, undefined, 'unknown', Infinity]) {
    assert.deepEqual(difficulty({ platform: 'CF', rating }), { tone: 'neutral', rank: '', label: '', native: '', level: null });
  }
});

test('empty queries are neutral and missing fields are safe', () => {
  for (const query of ['', '  \n\t ', null, undefined, '　']) assert.equal(match({}, query), 1);
  assert.equal(match(null, 'missing'), 0);
  assert.equal(match({}, 'missing'), 0);
});

test('compact CF identifiers and record URLs share exact identifier relevance', () => {
  const record = { platform: 'CF', pid: 'CF1900D', title: '数对计数' };
  const exact = match(record, 'CF1900D');
  for (const query of ['CF 1900 D', 'cf-1900-d', 'CF_1900_D', '1900D', '1900 D', 'ＣＦ１９００Ｄ', 'https://codeforces.com/problemset/problem/1900/D']) assert.equal(match(record, query), exact, query);
  for (const url of ['https://codeforces.com/problemset/problem/1900/D', 'https://codeforces.com/contest/1900/problem/D']) {
    assert.equal(match({ url }, 'CF 1900 D'), exact);
  }
  assert.equal(match({ pid: '1900D', platform: 'CF' }, 'CF1900D'), exact);
  assert.equal(match(record, 'CF1900E'), 0);
});

test('Luogu identifiers come from pid or link and accept bare numbers', () => {
  for (const record of [{ pid: 'P1001' }, { link: 'https://www.luogu.com.cn/problem/P1001' }, { problemUrl: 'https://www.luogu.com.cn/problem/P1001?from=search' }]) {
    for (const query of ['P1001', 'P 1001', '1001', 'https://www.luogu.com.cn/problem/P1001']) assert.ok(match(record, query) >= 10000, query);
  }
  assert.equal(match({ url: 'https://codeforces.com.evil.example/problemset/problem/1900/D' }, 'CF1900D'), 0);
});

test('AND terms can span title, tags, author and body, including Chinese', () => {
  const record = { title: '二分答案', tags: ['边界处理'], author: '小林', body: '最后一个正确的位置' };
  assert.ok(match(record, '二分 边界 小林 正确') > 0);
  assert.equal(match(record, '二分 边界 小林 不存在'), 0);
  assert.ok(match({ author: { name: 'Alice', login: 'alice-code' } }, 'ALICE') > 0);
  assert.ok(match({ title: 'Straße ＡＢＣ', body: 'CAFÉ' }, 'STRASSE abc cafe\u0301') > 0);
});

test('relevance favors exact IDs, then prefixes, title phrases, title words and body', () => {
  const query = '1900D';
  assert.ok(match({ pid: 'CF1900D' }, query) > match({ title: query }, query));
  assert.ok(match({ pid: 'CF1900D' }, '1900') > match({ title: '1900' }, '1900'));
  assert.ok(match({ title: 'binary search guide' }, 'binary search') > match({ title: 'binary answer search guide' }, 'binary search'));
  assert.ok(match({ title: 'binary guide' }, 'binary') > match({ title: 'a binary guide' }, 'binary'));
  assert.ok(match({ title: 'a binary guide' }, 'binary') > match({ body: 'binary' }, 'binary'));
  assert.ok(match({ tags: ['binary'] }, 'binary') > match({ body: 'binary' }, 'binary'));
  assert.ok(match({ pid: 'CF1900D', tags: ['数论'] }, 'CF 1900 D 数论') > 0);
  assert.equal(match({ pid: 'CF1900D' }, 'CF1900D missing'), 0);
});

test('punctuation and regex metacharacters are literal and never executable patterns', () => {
  for (const query of ['[', '.*', '(a+)+$', '\\', '二分，边界', 'C++']) {
    assert.ok(match({ title: query }, query) > 0, query);
    assert.equal(match({ title: 'unrelated content' }, query), 0, query);
  }
});
