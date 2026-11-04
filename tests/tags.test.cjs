'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GitHub } = require('../electron/github.cjs');
const presets = require('../ui/tag-presets.js');
const { normalizeName } = require('../electron/tags.cjs');
const category = String(presets.categories[0].id);
const marker = (name = '自定义测试标签', cat = category) => `<!-- qmx-tag-request ${JSON.stringify({ type: 'qmx-tag-request', category: cat, name })} -->`;
function fixture(options = {}) {
  const calls = [];
  let file = options.catalog ? { text: JSON.stringify(options.catalog), sha: 'initial-sha' } : null;
  let issue = { number: 7, body: marker(), state: 'open', updated_at: '2026-11-04', user: { id: 22, login: 'alice' }, html_url: 'https://github.com/a/b/issues/7', ...options.issue };
  let closeFails = Boolean(options.closeFails);
  const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data, headers: new Headers() });
  const fetcher = async (url, opts) => {
    const u = new URL(url), method = opts.method || 'GET', body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ path: u.pathname, method, body, search: u.search });
    if (u.pathname === '/user') return response({ id: 22, login: 'alice' });
    if (u.pathname === '/repos/a/b') return response({ default_branch: 'dev/next', permissions: { push: options.push ?? true, maintain: options.maintain ?? true, admin: options.admin ?? false } });
    if (u.pathname === '/repos/a/b/contents/.qmx/tags.json') {
      if (method === 'GET') {
        assert.equal(u.searchParams.get('ref'), 'dev/next');
        if (options.readStatus) return response({ message: 'failure' }, options.readStatus);
        return file ? response({ type: 'file', encoding: 'base64', content: Buffer.from(file.text).toString('base64'), sha: file.sha }) : response({}, 404);
      }
      assert.equal(body.branch, 'dev/next');
      assert.equal(body.sha, file?.sha);
      if (options.conflict) return response({ message: 'sha changed' }, 409);
      file = { text: Buffer.from(body.content, 'base64').toString('utf8'), sha: 'new-sha' };
      if (options.writeTimeout) throw new Error('lost response');
      return response({ content: { sha: file.sha } });
    }
    if (u.pathname === '/repos/a/b/issues' && method === 'GET') return response(options.issues || [issue]);
    if (u.pathname === '/repos/a/b/issues' && method === 'POST') {
      issue = { ...issue, body: body.body, title: body.title, number: 8 };
      return response(issue, 201);
    }
    if (u.pathname === '/repos/a/b/issues/7' && method === 'GET') return response(issue);
    if (u.pathname === '/repos/a/b/issues/7' && method === 'PATCH') {
      if (closeFails) return response({ message: 'cannot close' }, 403);
      issue.state = 'closed'; return response(issue);
    }
    if (u.pathname.startsWith('/repos/a/b/git/trees/')) return response({ tree: [] });
    throw new Error(`Unexpected ${method} ${url}`);
  };
  return { gh: new GitHub({ repo: 'a/b', token: options.token ?? 'token', fetcher }), calls, writes: () => calls.filter(x => x.method !== 'GET'), file: () => file && JSON.parse(file.text), issue: () => issue, closeWorks: () => { closeFails = false; } };
}
async function expected(f) { return (await f.gh.getTagReview()).requests[0].expected; }

test('tag presets have 22 categories, 262 tags; 404 falls back without mutating presets', async () => {
  assert.equal(presets.categories.length, 22);
  assert.equal(presets.categories.reduce((n, c) => n + c.tags.length, 0), 262);
  const f = fixture(); const catalog = await f.gh.getTagCatalog();
  assert.deepEqual(catalog, presets); catalog.categories[0].tags.push({ name: 'local' });
  assert.notDeepEqual(catalog, presets); assert.equal(f.writes().length, 0);
});
test('catalog keeps all presets and merges approved tags', async () => {
  const f = fixture({ catalog: { categories: [{ id: category, name: '旧名称', tags: [{ id: 'custom-x', name: '已批准' }, presets.categories[0].tags[0]] }] } });
  const result = await f.gh.getTagCatalog();
  assert.equal(result.categories.length, 22);
  assert.ok(result.categories[0].tags.some(x => x.name === '已批准'));
  assert.equal(result.categories[0].tags.length, presets.categories[0].tags.length + 1);
});
test('catalog rejects malformed structures rather than silently replacing them', async () => {
  for (const catalog of [{}, { categories: null }, { categories: [{ id: 'unknown', name: 'unknown', tags: [] }] }, { categories: [{ id: category, name: 'known', tags: 'wrong' }] }]) {
    await assert.rejects(fixture({ catalog }).gh.getTagCatalog(), /格式错误|未知分类/);
  }
});
test('non-404 catalog failures are not replaced with presets', async () => {
  for (const readStatus of [401, 403, 429, 500]) {
    const f = fixture({ readStatus }); await assert.rejects(f.gh.getTagCatalog()); assert.equal(f.writes().length, 0);
  }
});
test('requests accept existing category id/name, normalize names and deduplicate own pending requests', async () => {
  const f = fixture(); const result = await f.gh.requestTag({ category, name: ' 自定义测试标签 ' });
  assert.equal(result.number, 7); assert.equal(f.writes().length, 0);
  const fresh = fixture({ issues: [] });
  const request = await fresh.gh.requestTag({ category: presets.categories[0].name, name: '  新  标签  ' });
  assert.equal(request.category, category); assert.equal(request.name, '新 标签');
  assert.equal(fresh.writes().length, 1); assert.match(fresh.writes()[0].body.body, /qmx-tag-request/);
  assert.ok(!fresh.writes()[0].body.body.includes('qmx-record'));
});
test('requests reject unknown categories, excessive names, unauthenticated callers and malformed names', async () => {
  const f = fixture(); await assert.rejects(f.gh.requestTag({ category: 'unknown', name: 'tag' }), /分类不存在/);
  for (const name of ['', 'x'.repeat(81), 'bad\nname', null]) assert.throws(() => normalizeName(name));
  const anonymous = fixture({ token: '' }); await assert.rejects(anonymous.gh.requestTag({ category, name: 'tag' }), /登录/);
  assert.equal(f.writes().length, 0); assert.equal(anonymous.calls.length, 0);
});
test('review display and mutation both recheck actual maintain/admin; push alone cannot review', async () => {
  const f = fixture({ maintain: false }); assert.equal((await f.gh.getTagReview()).canReview, false);
  await assert.rejects(f.gh.reviewTag({ number: 7, decision: 'approve', admin: true, expected: { category, name: '自定义测试标签' } }), /maintain/);
  assert.equal(f.writes().length, 0);
  for (const permissions of [{ maintain: true, push: false }, { maintain: false, admin: true }]) {
    const allowed = fixture(permissions); assert.equal((await allowed.gh.getTagReview()).canReview, true);
  }
});
test('approval requires reviewed snapshot and rejects edited marker, unknown category, PR and closed issue', async () => {
  const f = fixture(); const snapshot = await expected(f);
  await assert.rejects(f.gh.reviewTag({ number: 7, decision: 'approve' }), /expected/);
  f.issue().body = marker('edited');
  await assert.rejects(f.gh.reviewTag({ number: 7, decision: 'approve', expected: snapshot }), /内容已变化/);
  for (const issue of [{ body: marker('tag', 'unknown') }, { pull_request: {} }, { state: 'closed' }, { body: '<!-- qmx-record {} -->' }]) {
    const invalid = fixture({ issue });
    await assert.rejects(invalid.gh.reviewTag({ number: 7, decision: 'approve', expected: { category: issue.body?.includes('unknown') ? 'unknown' : category, name: 'tag' } }));
    assert.equal(invalid.writes().length, 0);
  }
  assert.equal(f.writes().length, 0);
});
test('approval writes default branch with SHA before closing and preserves custom/preset tags', async () => {
  const f = fixture({ catalog: { categories: [{ id: category, name: 'old', tags: [{ id: 'custom-old', name: '已有标签' }] }] } });
  const result = await f.gh.reviewTag({ number: 7, decision: 'approve', expected: await expected(f) });
  assert.equal(result.approved, true); assert.deepEqual(f.writes().map(x => x.method), ['PUT', 'PATCH']);
  assert.equal(f.writes()[0].body.sha, 'initial-sha');
  const catalog = f.file(); assert.equal(catalog.categories.length, 22);
  assert.ok(catalog.categories[0].tags.some(x => x.name === '已有标签'));
  assert.ok(catalog.categories[0].tags.some(x => x.name === '自定义测试标签' && x.id.startsWith('custom-')));
  assert.deepEqual(catalog.approvals[7], { category, name: '自定义测试标签' });
});
test('approval close failure reports durable approval and retries idempotently without another PUT', async () => {
  const f = fixture({ closeFails: true }); const snapshot = await expected(f);
  await assert.rejects(f.gh.reviewTag({ number: 7, decision: 'approve', expected: snapshot }), /已批准.*待关闭/);
  f.closeWorks(); await f.gh.reviewTag({ number: 7, decision: 'approve', expected: snapshot });
  assert.deepEqual(f.writes().map(x => x.method), ['PUT', 'PATCH', 'PATCH']);
  await assert.rejects(f.gh.reviewTag({ number: 7, decision: 'approve', expected: snapshot }), /已关闭/);
});
test('approval timeout after commit can be safely retried; changed marker cannot add a second tag', async () => {
  const f = fixture({ writeTimeout: true }); const snapshot = await expected(f);
  await assert.rejects(f.gh.reviewTag({ number: 7, decision: 'approve', expected: snapshot }), /结果未知/);
  f.issue().body = marker('changed-after-approval');
  await assert.rejects(f.gh.reviewTag({ number: 7, decision: 'approve', expected: await expected(f) }), /该申请已批准/);
  assert.equal(f.writes().filter(x => x.method === 'PUT').length, 1);
});
test('SHA conflict does not close and reject only closes without catalog write', async () => {
  const conflict = fixture({ conflict: true });
  await assert.rejects(conflict.gh.reviewTag({ number: 7, decision: 'approve', expected: await expected(conflict) }), /并发冲突/);
  assert.deepEqual(conflict.writes().map(x => x.method), ['PUT']);
  const rejected = fixture(); await rejected.gh.reviewTag({ number: 7, decision: 'reject', expected: await expected(rejected) });
  assert.deepEqual(rejected.writes().map(x => x.method), ['PATCH']);
});
test('sync only filters tag request Issues, including malformed marker, and never requests catalog', async () => {
  const f = fixture({ issues: [{ number: 7, body: marker() }, { number: 8, body: '<!-- qmx-tag-request broken -->' }, { number: 9, title: 'ordinary', user: {} }, { number: 10, pull_request: {} }] });
  const result = await f.gh.sync();
  assert.deepEqual(result.issues.map(x => x.number), [9]);
  assert.ok(!f.calls.some(x => x.path.includes('/contents/')));
});
