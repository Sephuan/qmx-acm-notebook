'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GitHub } = require('../electron/github.cjs');
const { AlgorithmTopics, TOPICS_PATH, validateTopics, parseTopics } = require('../electron/algorithm-topics.cjs');
const tree = require('../ui/algorithm-tree.js');
const UUID = '3d12970c-1ea6-4da8-809c-a8f85b2db247';
const UUID2 = 'cc720a4b-31e5-4a89-a438-ea74ab9886c4';
const id = `custom-${UUID}`, id2 = `custom-${UUID2}`;
const input = (extra = {}) => ({ parentId: 'xcpc-动态规划-1', label: '测试算法', fullLabel: '测试算法完整名称', color: 'intermediate', scope: '状态设计及基本转移', requestId: 'request-1', ...extra });
const topic = (extra = {}) => ({ id, ...input({ parentId: 'feishu-part-3' }), createdAt: '2026-11-11T06:00:00.000Z', createdBy: { id: 42, login: 'alice' }, ...extra });
function fixture({ admin = true, push = true, file = null, sha = 'old-sha', failPut = null, noSha = false, token = 'FAKE_TOKEN', permissionsAgain } = {}) {
  let saved = file, currentSha = sha; const calls = [], writes = [];
  const fetcher = async (url, opts = {}) => {
    const pathname = new URL(url).pathname;
    calls.push({ pathname, opts });
    const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => data });
    if (pathname === '/user') return response({ id: 42, login: 'alice' });
    if (pathname === '/repos/team/notebook') return response({ default_branch: 'main', permissions: { admin: permissionsAgain ? permissionsAgain() : admin, push } });
    if (pathname === `/repos/team/notebook/contents/${TOPICS_PATH}`) {
      if (opts.method === 'PUT') {
        const body = JSON.parse(opts.body); writes.push(body);
        if (failPut) return response({ message: 'changed' }, failPut);
        assert.equal(body.branch, 'main');
        if (saved) assert.equal(body.sha, currentSha); else assert.equal(body.sha, undefined);
        saved = Buffer.from(body.content, 'base64').toString('utf8'); currentSha = 'new-sha';
        return response(noSha ? {} : { content: { sha: currentSha } });
      }
      return saved === null ? response({ message: 'Not Found' }, 404) : response({ type: 'file', encoding: 'base64', sha: currentSha, content: Buffer.from(saved).toString('base64') });
    }
    if (pathname === '/repos/team/notebook/git/trees/main') return response({ tree: saved ? [{ type: 'blob', path: TOPICS_PATH, sha: currentSha }] : [] });
    if (pathname === '/repos/team/notebook/issues') return response([]);
    throw new Error('Unexpected request ' + pathname);
  };
  const gh = new GitHub({ repo: 'team/notebook', token, fetcher });
  return { gh, calls, writes, service: new AlgorithmTopics(gh, { uuid: () => UUID, now: () => '2026-11-11T06:00:00.000Z' }), get saved() { return saved; } };
}

test('administrator creates stable shared topic with canonical legacy parent and Contents API SHA', async () => {
  const h = fixture(); const result = await h.service.save(input());
  assert.equal(result.topic.id, id); assert.equal(result.topic.parentId, 'feishu-part-3');
  assert.equal(result.topic.repo, 'team/notebook'); assert.equal(result.topic.fullLabel, '测试算法完整名称');
  assert.equal(result.topic.kind, 'algorithm', 'legacy inputs default to rated algorithms');
  assert.deepEqual(result.topic.createdBy, { id: 42, login: 'alice' });
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].sha, undefined);
  assert.equal(JSON.parse(h.saved).schema, 1); assert.equal(JSON.parse(h.saved).topics.length, 1);
  assert.ok(!h.calls.some(call => /algorithm-tree/.test(call.pathname)), 'never writes generated builtin tree');
  const parent = topic();
  const existing = fixture({ file: JSON.stringify({ schema: 1, topics: [parent] }) });
  const next = await new AlgorithmTopics(existing.gh, { uuid: () => UUID2 }).save(input({ parentId: id, label: '子算法', requestId: 'request-2' }));
  assert.equal(next.topic.parentId, id); assert.equal(existing.writes[0].sha, 'old-sha');
  assert.equal(next.topics.length, 2);
});

test('only fresh strict admin permission authorizes creation, not push or renderer fields', async () => {
  for (const options of [{ admin: false, push: true }, { admin: false, push: false }, { admin: 'true', push: true }, { token: '' }]) {
    const h = fixture(options);
    await assert.rejects(h.service.save(input({ admin: true, permissions: { admin: true } })), /管理员|登录/);
    assert.equal(h.writes.length, 0);
  }
  let allowed = true; const h = fixture({ permissionsAgain: () => allowed });
  await h.service.save(input()); allowed = false;
  await assert.rejects(h.service.save(input()), /管理员/);
  assert.equal(h.writes.length, 1, 'even idempotent retry rechecks fresh admin permission');
});

test('idempotent request replay returns committed identifier and rejects changed payload', async () => {
  const h = fixture(); const first = await h.service.save(input());
  const second = await new AlgorithmTopics(h.gh, { uuid: () => UUID2 }).save(input());
  assert.equal(second.topic.id, first.topic.id); assert.equal(h.writes.length, 1);
  await assert.rejects(h.service.save(input({ color: 'expert' })), /请求标识/);
  assert.equal(h.writes.length, 1);
});

test('input, duplicate labels, nonexistent parents and cyclic stored records fail closed', async () => {
  for (const bad of [null, [], input({ parentId: 'unknown' }), input({ label: '' }), input({ label: 'x'.repeat(81) }), input({ fullLabel: '' }), input({ fullLabel: 'x'.repeat(201) }), input({ color: 'parent' }), input({ scope: 'x'.repeat(2001) }), input({ label: 'bad\nlabel' }), input({ requestId: '../bad' })]) {
    const h = fixture(); await assert.rejects(h.service.save(bad)); assert.equal(h.writes.length, 0);
  }
  const dup = fixture({ file: JSON.stringify({ schema: 1, topics: [topic()] }) });
  await assert.rejects(new AlgorithmTopics(dup.gh, { uuid: () => UUID2 }).save(input({ requestId: 'other' })), /已存在/);
  const a = topic({ parentId: id2 }), b = topic({ id: id2, parentId: id, label: 'other', requestId: 'r2' });
  assert.throws(() => validateTopics([a, b]), /循环/);
  assert.throws(() => validateTopics([topic({ parentId: id })]), /循环/);
  assert.throws(() => parseTopics('{bad'), /JSON/);
  assert.throws(() => parseTopics(JSON.stringify({ schema: 999, topics: [] })), /格式/);
  assert.equal(dup.writes.length, 0);
});

test('every canonical builtin and legacy alias is a valid parent', async () => {
  const builtins = []; (function walk(n) { builtins.push(n); n.children.forEach(walk); })(tree);
  assert.ok(builtins.length >= 473, 'all historic nodes plus explicitly split concrete algorithms remain valid');
  for (const node of builtins) for (const parentId of [node.id, ...(node.legacyIds || [])]) {
    const result = validateTopics([topic({ parentId })]); assert.equal(result[0].parentId, node.id);
  }
});

test('directories have no difficulty and preserve optional scope and complete names', async () => {
  const h = fixture();
  const result = await h.service.save(input({ kind: 'directory', color: 'parent', label: '新目录' }));
  assert.equal(result.topic.kind, 'directory'); assert.equal(result.topic.color, 'parent');
  assert.equal(result.topic.scope, '状态设计及基本转移');
  const parsed = parseTopics(h.saved); assert.equal(parsed[0].kind, 'directory');
  assert.equal(validateTopics([topic({ kind: 'directory', color: undefined })])[0].color, 'parent');
  await assert.rejects(fixture().service.save(input({ kind: 'directory', color: 'expert' })), /目录/);
  await assert.rejects(fixture().service.save(input({ kind: 'algorithm', color: 'parent' })), /难度/);
  await assert.rejects(fixture().service.save(input({ kind: 'unknown' })), /类型/);
  await assert.rejects(h.service.save(input({ kind: 'algorithm' })), /请求标识/);
});

test('split concrete algorithm IDs can receive persisted children across subsequent saves', async () => {
  const h = fixture(); const first = await h.service.save(input());
  const second = await new AlgorithmTopics(h.gh, { uuid: () => UUID2 }).save(input({ parentId: first.topic.id, label: '变体', requestId: 'child-1' }));
  const synthetic = `algorithm-content-${first.topic.id}`;
  const effective = require('../electron/algorithm-topics.cjs').builtinIndex(tree, second.topics);
  assert.equal(effective.get(first.topic.id).kind, 'directory');
  assert.equal(effective.get(synthetic).kind, 'algorithm');
  const UUID3 = 'a1d16a2e-502f-4a76-9f60-c5a6dca6b210';
  const third = await new AlgorithmTopics(h.gh, { uuid: () => UUID3 }).save(input({ parentId: synthetic, label: '具体算法下的目录', kind: 'directory', color: 'parent', requestId: 'child-2' }));
  assert.equal(third.topic.parentId, synthetic);
  assert.equal(h.writes.length, 3);
  assert.equal(parseTopics(h.saved).length, 3);
  const reversed = validateTopics([...third.topics].reverse());
  assert.equal(reversed.find(t => t.id === third.topic.id).parentId, synthetic, 'stored order does not determine parent validity');
});

test('synthetic parent validation rejects missing conversions, forged IDs and ownership cycles', () => {
  const synthetic = `algorithm-content-${id}`;
  assert.throws(() => validateTopics([topic({ parentId: synthetic })]), /循环/);
  assert.throws(() => validateTopics([topic(), topic({ id: id2, parentId: synthetic, label: 'unresolvable', requestId: 'r2' })]), /不存在|无法解析/);
  assert.throws(() => validateTopics([topic({ parentId: 'algorithm-content-forged' })]), /不存在/);
  assert.throws(() => validateTopics([topic({ parentId: `algorithm-content-${id2}` }), topic({ id: id2, parentId: id, label: 'cycle', requestId: 'r2' })]), /循环/);
  const nestedId = `algorithm-content-algorithm-content-${id}`;
  assert.throws(() => validateTopics([topic({ parentId: nestedId })]), /循环/);
});

test('SHA conflicts do not overwrite or silently merge remote contents; unknown outcomes remain explicit', async () => {
  for (const status of [409, 422]) {
    const existing = JSON.stringify({ schema: 1, topics: [topic({ label: 'other', requestId: 'other' })] });
    const h = fixture({ file: existing, failPut: status });
    await assert.rejects(new AlgorithmTopics(h.gh, { uuid: () => UUID2 }).save(input()), /SHA冲突/);
    assert.equal(h.saved, existing); assert.equal(h.writes.length, 1);
  }
  const h = fixture({ noSha: true }); await assert.rejects(h.service.save(input()), /结果未知/);
});

test('sync returns shared additions and removes remotely deleted file without reusing stale topics', async () => {
  const h = fixture({ file: JSON.stringify({ schema: 1, topics: [topic()] }), token: '' });
  const result = await h.gh.sync(); assert.equal(result.algorithmTopics.length, 1);
  assert.equal(result.algorithmTopics[0].repo, 'team/notebook'); assert.equal(result.algorithmTopics[0].id, id);
  const empty = await fixture({ file: null, token: '' }).gh.sync({ algorithmTopics: [topic()] });
  assert.deepEqual(empty.algorithmTopics, []);
});

// Reuse the existing main-process VM fixture without changing or registering its tests.
function mainHarness(options) {
  const fs = require('node:fs'), path = require('node:path');
  let source = fs.readFileSync(path.join(__dirname, 'main.test.cjs'), 'utf8').split("test('planner IPC persists")[0];
  source = source.replace("['saveDocument', 'deleteDocument'", "['saveAlgorithmTopic', 'saveDocument', 'deleteDocument'");
  return new Function('require', '__dirname', 'Buffer', source + '\nreturn harness;')(require, __dirname, Buffer)(options);
}

test('main IPC caches only committed additions, exposes offline bootstrap/sync and isolates repository changes', async () => {
  const record = { ...topic(), repo: 'team/notebook' };
  let fail = false;
  const h = mainHarness({ backend: { saveAlgorithmTopic: async () => {
    if (fail) throw new Error('SHA conflict');
    return { topic: record, topics: [record] };
  }, sync: async () => ({ records: [], issues: [], algorithmTopics: [record] }) } });
  assert.deepEqual((await h.invoke('bootstrap')).algorithmTopics, []);
  assert.deepEqual(await h.invoke('saveAlgorithmTopic', input()), record);
  assert.deepEqual(h.stored('cache.json').algorithmTopics, [record]);
  const writes = h.writes.length; fail = true;
  await assert.rejects(h.invoke('saveAlgorithmTopic', input()), /SHA conflict/);
  assert.equal(h.writes.length, writes, 'failed remote commit does not write local cache');
  const scopedRecord = { ...record, serverUrl: '', sourceKey: 'https://api.github.com|team/notebook' };
  const state = await h.invoke('sync'); assert.deepEqual(state.algorithmTopics, [scopedRecord]);
  await h.invoke('saveSettings', { repo: 'other/repo' });
  assert.deepEqual((await h.invoke('bootstrap')).algorithmTopics, []);
  const offline = mainHarness({ account: null, files: { 'cache.json': h.stored('cache.json') } });
  assert.deepEqual((await offline.invoke('bootstrap')).algorithmTopics, [scopedRecord]);
  assert.equal(offline.calls.length, 0, 'offline bootstrap performs no network requests');
  await assert.rejects(h.handlers.get('saveAlgorithmTopic')({ sender: {} }, input()), /非法调用/);
});

test('preload exposes saveAlgorithmTopic through the isolated IPC bridge', () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  let bridge; const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), { require: () => ({ contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'notebook'); bridge = value; } }, ipcRenderer: { invoke(...args) { calls.push(args); return Promise.resolve('saved'); } } }) });
  assert.equal(typeof bridge.saveAlgorithmTopic, 'function');
  bridge.saveAlgorithmTopic(input()); assert.equal(calls[0][0], 'saveAlgorithmTopic');
  assert.equal(calls[0][1].label, '测试算法');
});
