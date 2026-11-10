'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPlannerService } = require('../electron/planner-service.cjs');
const { prepareUpgrade } = require('../electron/upgrade.cjs');

const FIRST = '2026-11-10T04:00:00.000Z';
const LATER = '2026-11-10T05:00:00.000Z';
const URL = 'https://codeforces.com/problemset/problem/1/A';
const empty = () => ({ problems: [], tasks: [], layout: 'compact' });
function harness(initial) {
  let stored = initial, clock = FIRST, sequence = 0, fail = false;
  const writes = [];
  const read = (name, fallback) => { assert.equal(name, 'planner.json'); return stored === undefined ? fallback : stored; };
  const save = (name, value) => {
    assert.equal(name, 'planner.json');
    if (fail) throw new Error('disk full');
    stored = structuredClone(value); writes.push(structuredClone(value));
  };
  const options = { read, save, now: () => clock, id: () => `id-${++sequence}` };
  return { service: createPlannerService(options), writes, restart: () => createPlannerService(options), stored: () => stored,
    clock(value) { clock = value; }, fail(value) { fail = value; } };
}

test('pending problem duplicate rejects without a write while completed problems can be scheduled again', () => {
  const h = harness(); const first = h.service.action('addProblem', { url: URL }).problems[0];
  assert.throws(() => h.service.action('addProblem', { url: URL }), /已在待做/); assert.equal(h.writes.length, 1);
  h.service.action('updateProblem', { id: first.id, done: true });
  assert.equal(h.service.action('addProblem', { url: URL }).problems.length, 2);
});

test('local planner lifecycle survives restart, preserves timestamps, and returns detached snapshots', () => {
  const h = harness();
  assert.deepEqual(h.service.state(), empty());
  assert.equal(h.writes.length, 0, 'reading defaults must not create a file');
  let result = h.service.action('addProblem', { title: '  Watermelon  ', url: URL });
  const problem = result.problems[0];
  assert.deepEqual(problem, { id: 'id-1', title: 'Watermelon', url: URL, done: false, createdAt: FIRST, updatedAt: FIRST });
  result.problems[0].title = 'tampered';
  assert.equal(h.service.state().problems[0].title, 'Watermelon');
  h.service.action('addTask', { title: 'Read editorial', details: 'Explain the invariant', dueAt: '2026-11-11T19:30:00+08:00' });
  h.clock(LATER);
  h.service.action('updateProblem', { id: problem.id, done: true, url: 'http://atcoder.jp/contests/abc001/tasks/abc001_1' });
  h.service.action('updateTask', { id: 'id-2', title: 'Write proof', details: '', dueAt: '', done: true });
  h.service.action('setLayout', { layout: 'focus' });
  const persisted = h.restart().state();
  assert.equal(persisted.layout, 'focus');
  assert.equal(persisted.problems[0].createdAt, FIRST);
  assert.equal(persisted.problems[0].updatedAt, LATER);
  assert.equal(persisted.problems[0].done, true);
  assert.deepEqual(persisted.tasks[0], { id: 'id-2', title: 'Write proof', details: '', dueAt: '', done: true, createdAt: FIRST, updatedAt: LATER });
  persisted.tasks.length = 0;
  assert.equal(h.service.state().tasks.length, 1);
  h.service.action('updateProblem', { id: problem.id, done: false });
  assert.equal(h.service.state().problems[0].done, false);
  h.service.action('deleteProblem', { id: problem.id });
  h.service.action('deleteTask', { id: 'id-2' });
  assert.deepEqual(h.restart().state(), { ...empty(), layout: 'focus' });
});

test('easy add accepts official HTTP/HTTPS problem routes for all supported platforms', () => {
  const urls = [URL, 'http://contest.codeforces.com/contest/123/problem/A', 'https://codeforces.com/gym/123/problem/A1',
    'https://atcoder.jp/contests/abc001/tasks/abc001_1', 'http://www.luogu.com.cn/problem/P1001', 'https://www.luogu.com/problem/CF1A',
    'https://ac.nowcoder.com/acm/problem/123', 'https://ac.nowcoder.com/acm/contest/123/A',
    'https://www.nowcoder.com/acm/contest/123/B', 'https://leetcode.cn/problems/two-sum/description/?envType=daily-question',
    'https://leetcode.com/problems/two-sum/', 'https://leetcode.com/contest/weekly-contest-1/problems/two-sum/',
    'https://hydro.ac/p/P1000', 'https://hydro.ac/d/luogu/p/P1001', 'https://www.acwing.com/problem/content/description/1/'];
  const h = harness();
  for (const url of urls) {
    const state = h.service.action('addProblem', { url });
    assert(state.problems.at(-1).title.length > 0);
    assert.equal(state.problems.at(-1).url, new globalThis.URL(url).href);
  }
  assert.equal(h.restart().state().problems.length, urls.length);
});

test('unsafe links, wrong paths, credentials, host tricks, malformed fields, and unknown IDs never save', () => {
  const h = harness();
  h.service.action('addProblem', { title: 'Original', url: URL });
  h.service.action('addTask', { title: 'Original task' });
  const before = structuredClone(h.stored()), count = h.writes.length;
  const urls = ['javascript:alert(1)', 'file:///tmp/problem', 'https://evil.test/problem/P1001',
    'https://codeforces.com.evil.test/problemset/problem/1/A', 'https://evil.test@codeforces.com/problemset/problem/1/A',
    'https://codeforces.com:8443/problemset/problem/1/A', 'https://codeforces.com/profile/alice',
    'https://codeforces.com', 'https://hydro.ac/d/luogu', '//codeforces.com/problemset/problem/1/A',
    'https://codeforces.com\\@evil.test/problemset/problem/1/A', 'https://codeforces.com/problemset/problem/1/\nA'];
  const invalid = urls.map(url => ['updateProblem', { id: 'id-1', url }]);
  invalid.push(['addTask', { title: '' }], ['addTask', { title: 42 }], ['addProblem', { url: URL, title: null }],
    ['updateTask', { id: 'id-2', done: 1 }], ['updateProblem', { id: 'id-1', done: 'true' }],
    ['updateProblem', { id: 'id-1', createdAt: LATER }], ['updateTask', { id: 'id-2' }],
    ['updateTask', { id: 'missing', title: 'lost' }], ['deleteProblem', { id: 'missing' }], ['deleteTask', { id: 'id-1' }],
    ['setLayout', { layout: 'wide' }], ['setLayout', 'focus'], ['setLayout', { layout: 'focus', extra: 1 }],
    ['addTask', { title: 'bad\u0000title' }], ['addTask', { title: 'x', details: {} }], ['addTask', { title: 'x', done: true }],
    ['toggleTask', { id: 'id-2' }], ['__proto__', {}], ['addTask', null], ['addTask', []]);
  for (const [name, payload] of invalid) assert.throws(() => h.service.action(name, payload), `${name}: ${JSON.stringify(payload)}`);
  assert.equal(h.writes.length, count);
  assert.deepEqual(h.stored(), before);
  assert.deepEqual(h.service.state(), before);
});

test('easy-add labels and URL encoding respect persisted bounds and do not leak save references', () => {
  let stored;
  let sequence = 0;
  const service = createPlannerService({ read: (_name, fallback) => stored || fallback, save: (_name, value) => { stored = value; }, now: () => FIRST, id: () => `id-${++sequence}` });
  const result = service.action('addProblem', { url: `https://leetcode.cn/problems/${'a'.repeat(500)}/`, title: '  ' });
  assert.equal(result.problems[0].title.length, 180);
  assert.equal(service.state().problems.length, 1);
  result.problems[0].done = true;
  assert.equal(service.state().problems[0].done, false, 'action return must not mutate even a reference-retaining save implementation');
  const before = structuredClone(stored);
  assert.throws(() => service.action('addProblem', { url: URL, title: ' '.repeat(181) }));
  assert.throws(() => service.action('addProblem', { url: `${URL}?q=${'题'.repeat(500)}` }));
  assert.deepEqual(stored, before, 'URL expansion must be checked before writing an unreadable snapshot');
});

test('due dates require explicit timezone and real calendar/time values, including leap-year boundaries', () => {
  const h = harness();
  for (const dueAt of ['', '2028-02-29T23:59:59.123Z', '2026-11-10T20:30+08:00', '2026-11-10T01:00:00-05:30']) {
    const result = h.service.action('addTask', { title: 'Deadline', dueAt });
    assert.equal(result.tasks.at(-1).dueAt, dueAt);
  }
  const count = h.writes.length;
  for (const dueAt of ['2026-11-10', '2026-11-10T12:00', '2026-02-29T12:00:00Z', '2026-04-31T12:00:00Z',
    '2026-13-01T12:00:00Z', '2026-11-10T24:00:00Z', '2026-11-10T12:60:00Z', '2026-11-10T12:00:60Z',
    '2026-11-10T12:00:00+24:00', '2026-11-10T12:00:00+08:60', 'tomorrow', null, 123]) {
    assert.throws(() => h.service.action('addTask', { title: 'Deadline', dueAt }), String(dueAt));
  }
  assert.equal(h.writes.length, count);
});

test('length and independent 500-item caps accept the boundary and reject overflow without writes', () => {
  const h = harness();
  h.service.action('addTask', { title: 't'.repeat(180), details: 'd'.repeat(2000) });
  const longUrl = `${URL}?q=${'a'.repeat(2048 - URL.length - 3)}`;
  assert.equal(longUrl.length, 2048);
  h.service.action('addProblem', { title: 'p'.repeat(180), url: longUrl });
  for (const [name, payload] of [
    ['addTask', { title: 't'.repeat(181) }], ['addTask', { title: 'x', details: 'd'.repeat(2001) }],
    ['addProblem', { url: longUrl + 'a' }], ['updateProblem', { id: 'id-2', title: 'p'.repeat(181) }]
  ]) assert.throws(() => h.service.action(name, payload));
  const item = h.service.state();
  const full = harness({ problems: Array.from({ length: 500 }, (_, i) => ({ ...item.problems[0], id: `p-${i}` })),
    tasks: Array.from({ length: 499 }, (_, i) => ({ ...item.tasks[0], id: `t-${i}` })), layout: 'compact' });
  full.service.action('addTask', { title: 'last slot' });
  assert.equal(full.service.state().tasks.length, 500);
  const count = full.writes.length;
  assert.throws(() => full.service.action('addProblem', { url: URL }), /500/);
  assert.throws(() => full.service.action('addTask', { title: 'overflow' }), /500/);
  assert.equal(full.writes.length, count);
  full.service.action('updateProblem', { id: 'p-0', done: true });
  full.service.action('deleteProblem', { id: 'p-1' });
  assert.equal(full.service.action('addProblem', { url: URL }).problems.length, 500);
});

test('failed persistence and invalid injected identifiers/clocks leave prior stored and visible state intact', () => {
  const h = harness();
  h.service.action('addTask', { title: 'Keep me' });
  const before = structuredClone(h.stored());
  h.fail(true);
  for (const [name, payload] of [['updateTask', { id: 'id-1', done: true }], ['deleteTask', { id: 'id-1' }], ['setLayout', { layout: 'focus' }], ['addProblem', { url: URL }]]) {
    assert.throws(() => h.service.action(name, payload), /disk full/);
    assert.deepEqual(h.stored(), before);
    assert.deepEqual(h.service.state(), before);
  }
  h.fail(false);
  h.clock('2026-02-30T12:00:00Z');
  assert.throws(() => h.service.action('updateTask', { id: 'id-1', done: true }));
  const duplicate = createPlannerService({ read: () => before, save: () => assert.fail('must not save'), now: () => FIRST, id: () => 'id-1' });
  assert.throws(() => duplicate.action('addTask', { title: 'Duplicate' }), /ID/);
  assert.deepEqual(before, h.stored());
});

test('malformed cached state degrades safely without modifying storage or exposing live references', () => {
  for (const value of [undefined, null, false, 'bad', [], { problems: {}, tasks: null, layout: 'bad' }]) {
    const h = harness(value);
    assert.deepEqual(h.service.state(), empty());
    assert.equal(h.writes.length, 0);
  }
  const good = harness(); good.service.action('addTask', { title: 'Valid' });
  const row = good.service.state().tasks[0];
  const stored = { tasks: [{ title: 'broken' }, row, row, { ...row, id: 'evil', done: 'yes' }], problems: [], layout: 'focus' };
  const h = harness(stored);
  const state = h.service.state();
  assert.equal(state.tasks.length, 1);
  state.tasks[0].title = 'bad';
  assert.equal(stored.tasks[1].title, 'Valid');
  assert.equal(h.writes.length, 0);
});

test('upgrade backup includes planner bytes and receipt hash without changing the original', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qmx-planner-backup-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, 'user'), installDir = path.join(root, 'app');
  fs.mkdirSync(userDataDir); fs.mkdirSync(installDir);
  fs.writeFileSync(path.join(installDir, 'QMX-Notebook.exe'), 'test executable');
  fs.writeFileSync(path.join(installDir, 'Uninstall QMX-Notebook.exe'), 'test uninstaller');
  const bytes = JSON.stringify({ ...empty(), tasks: [{ title: 'private plan' }] });
  fs.writeFileSync(path.join(userDataDir, 'planner.json'), bytes);
  const { backupDir } = prepareUpgrade({ userDataDir, installDir, version: '0.10.1', targetVersion: '0.10.2' }, { platform: 'win32' });
  assert.equal(fs.readFileSync(path.join(backupDir, 'planner.json'), 'utf8'), bytes);
  assert.equal(fs.readFileSync(path.join(userDataDir, 'planner.json'), 'utf8'), bytes);
  const receipt = JSON.parse(fs.readFileSync(path.join(backupDir, 'receipt.json'), 'utf8'));
  assert.match(receipt.hashes['planner.json'], /^[a-f0-9]{64}$/);
  assert(!JSON.stringify(receipt).includes('private plan'));
});
