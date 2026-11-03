const test = require('node:test');
const assert = require('node:assert/strict');
const YAML = require('yaml');
const { GitHub, identify, parseDocument, issueRecord, issueBody, documentContent, repoParts } = require('../electron/github.cjs');

const CLIENT_ID = '55c710aa-e083-4b14-94fe-a3a825d17f70';
const PATH = `problems/qmx/42/${CLIENT_ID}.md`;
const record = (extra = {}) => ({ clientId: CLIENT_ID, title: '测试', pid: 'CF1A', platform: 'CF', body: '# 思路\n\n```cpp\nint main(){}\n```', tags: ['数学'], ...extra });
const markdown = (meta = {}, body = '正文') => `---\n${YAML.stringify({ schema: 2, author_id: 42, author: 'alice', title: '测试', pid: 'CF1A', platform: 'CF', tags: ['数学'], client_id: CLIENT_ID, ...meta })}---\n${body}`;

function fakeGitHub({ files = {}, user = { id: 42, login: 'alice', name: 'Alice', avatar_url: 'https://example.com/avatar' }, push = true, admin = false, writeStatus, writeError, timeoutAfterCommit = false } = {}) {
  const calls = [];
  const store = new Map(Object.entries(files).map(([path, text]) => [path, { text, sha: 'old-sha' }]));
  let counter = 0;
  const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data, headers: new Headers() });
  const fetcher = async (url, opts) => {
    const method = opts.method || 'GET';
    const payload = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ url, method, payload });
    const u = new URL(url);
    if (u.pathname === '/user') return response(user);
    if (u.pathname === '/repos/a/b') return response({ default_branch: 'main', permissions: { push, admin } });
    const prefix = '/repos/a/b/contents/';
    assert.ok(u.pathname.startsWith(prefix), `Unexpected request: ${method} ${url}`);
    const path = decodeURIComponent(u.pathname.slice(prefix.length));
    if (method === 'GET') {
      assert.equal(u.searchParams.get('ref'), 'main');
      const file = store.get(path);
      return file ? response({ type: 'file', encoding: 'base64', content: Buffer.from(file.text).toString('base64'), sha: file.sha }) : response({}, 404);
    }
    assert.equal(payload.branch, 'main');
    if (writeError) throw writeError;
    if (writeStatus) return response({ message: 'Protected branch' }, writeStatus);
    if (method === 'PUT') {
      const previous = store.get(path);
      assert.equal(payload.sha, previous?.sha);
      const file = { text: Buffer.from(payload.content, 'base64').toString('utf8'), sha: `sha-${++counter}` };
      store.set(path, file);
      if (timeoutAfterCommit) throw new DOMException('Response lost after commit', 'TimeoutError');
      return response({ content: { sha: file.sha } }, 201);
    }
    if (method === 'DELETE') {
      assert.equal(payload.sha, store.get(path)?.sha);
      store.delete(path);
      return response({ commit: { sha: 'deleted' } });
    }
    throw new Error(`Unexpected method ${method}`);
  };
  return { gh: new GitHub({ repo: 'a/b', token: 'secret', fetcher }), calls, store, writes: () => calls.filter(x => x.method !== 'GET') };
}

function fakeIssueDeletion({ token = 'secret', user = { id: 42, login: 'alice' }, admin = true,
  issue = { number: 12, node_id: 'I_fresh_issue', user: { id: 999, login: 'bob' } }, issueStatus = 200,
  graphql = { data: { deleteIssue: { clientMutationId: null } } }, graphqlStatus = 200, graphqlError } = {}) {
  const calls = [];
  const fetcher = async (url, opts) => {
    const method = opts.method || 'GET';
    const payload = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ url, method, payload });
    assert.equal(opts.headers.Authorization, `Bearer ${token}`);
    const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data, headers: new Headers() });
    if (url === 'https://api.github.com/user') {
      assert.equal(method, 'GET');
      return response(user);
    }
    if (url === 'https://api.github.com/repos/a/b') {
      assert.equal(method, 'GET');
      return response({ permissions: { push: true, admin } });
    }
    if (url === 'https://api.github.com/repos/a/b/issues/12') {
      assert.equal(method, 'GET');
      return response(issue, issueStatus);
    }
    assert.equal(url, 'https://api.github.com/graphql');
    assert.equal(method, 'POST');
    if (graphqlError) throw graphqlError;
    return response(graphql, graphqlStatus);
  };
  return { gh: new GitHub({ repo: 'a/b', token, fetcher }), calls, writes: () => calls.filter(call => call.method !== 'GET') };
}

test('Issue deletion authenticates and verifies admin and fresh server identity before one GraphQL mutation', async () => {
  const { gh, calls, writes } = fakeIssueDeletion();
  const result = await gh.deleteIssue({ number: 12, repo: 'A/B', node_id: 'I_victim', nodeId: 'I_another_victim', authorId: 42, admin: true });
  assert.deepEqual(result, { id: 'issue:12', number: 12, repo: 'a/b', deleted: true });
  assert.deepEqual(calls.map(call => [call.method, call.url]), [
    ['GET', 'https://api.github.com/user'],
    ['GET', 'https://api.github.com/repos/a/b'],
    ['GET', 'https://api.github.com/repos/a/b/issues/12'],
    ['POST', 'https://api.github.com/graphql'],
  ]);
  assert.equal(writes().length, 1);
  assert.deepEqual(writes()[0].payload.variables, { issueId: 'I_fresh_issue' });
  assert.match(writes()[0].payload.query, /mutation.*\$issueId: ID!/);
  assert.match(writes()[0].payload.query, /deleteIssue\(input: \{ issueId: \$issueId \}\)/);
  assert.ok(!JSON.stringify(writes()[0].payload).includes('victim'));
});

test('Issue deletion rejects cross-repository targets and invalid numbers before any network request', async () => {
  const { gh, calls } = fakeIssueDeletion();
  await assert.rejects(gh.deleteIssue({ number: 12, repo: 'other/repo' }), /仓库不一致/);
  for (const number of [undefined, null, 0, -1, 1.5, '12', '12/../13', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(gh.deleteIssue({ number }), /正整数/);
  }
  assert.equal(calls.length, 0);
});

test('Issue deletion requires authenticated identity and actual admin permission, ignoring renderer claims', async () => {
  const anonymous = fakeIssueDeletion({ token: '' });
  await assert.rejects(anonymous.gh.deleteIssue({ number: 12 }), /先登录/);
  assert.equal(anonymous.calls.length, 0);
  for (const user of [{ id: '42', login: 'alice' }, { id: 0, login: 'alice' }, { id: 42 }]) {
    const fake = fakeIssueDeletion({ user });
    await assert.rejects(fake.gh.deleteIssue({ number: 12 }), /无法确认.*身份/);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.writes().length, 0);
  }
  for (const admin of [false, undefined, 1, 'true']) {
    const fake = fakeIssueDeletion({ admin: admin === undefined ? null : admin });
    await assert.rejects(fake.gh.deleteIssue({ number: 12, admin: true, permissions: { admin: true } }), /管理员/);
    assert.equal(fake.calls.length, 2);
    assert.equal(fake.writes().length, 0);
  }
});

test('Issue deletion rejects fresh PRs, mismatched numbers, missing IDs and missing Issues without mutation', async () => {
  for (const [issue, message] of [
    [{ number: 12, node_id: 'PR_fresh', pull_request: {} }, /Pull Request/],
    [{ number: 13, node_id: 'I_wrong_issue' }, /编号和 node_id/],
    [{ number: 12 }, /node_id/],
    [{ number: 12, node_id: '' }, /node_id/],
    [{ number: 12, node_id: '  ' }, /node_id/],
    [{ number: 12, node_id: 123 }, /node_id/],
    [null, /编号和 node_id/],
  ]) {
    const fake = fakeIssueDeletion({ issue });
    await assert.rejects(fake.gh.deleteIssue({ number: 12, node_id: 'I_client' }), message);
    assert.equal(fake.calls.length, 3);
    assert.equal(fake.writes().length, 0);
  }
  const missing = fakeIssueDeletion({ issueStatus: 404 });
  await assert.rejects(missing.gh.deleteIssue({ number: 12 }), /找不到/);
  assert.equal(missing.writes().length, 0);
});

test('Issue deletion reports HTTP 200 GraphQL errors and organization deletion policy without closing or retrying', async () => {
  for (const graphql of [
    { errors: [{ type: 'FORBIDDEN', message: 'Organization does not allow members to delete issues' }] },
    { data: { deleteIssue: null }, errors: [{ message: 'Could not resolve to a node' }] },
    { data: { deleteIssue: { clientMutationId: null } }, errors: [{ message: 'Mutation failed' }] },
  ]) {
    const fake = fakeIssueDeletion({ graphql });
    await assert.rejects(fake.gh.deleteIssue({ number: 12 }), /删除 Issue 失败.*组织.*Allow members to delete issues/);
    assert.equal(fake.writes().length, 1);
    assert.equal(fake.calls.length, 4);
  }
  const forbidden = fakeIssueDeletion({ graphqlStatus: 403, graphql: { message: 'Forbidden' } });
  await assert.rejects(forbidden.gh.deleteIssue({ number: 12 }), /拒绝删除.*组织.*Allow members to delete issues/);
  assert.equal(forbidden.writes().length, 1);
});

test('Issue deletion treats timeout or incomplete mutation response as unknown and never retries automatically', async () => {
  for (const options of [
    { graphqlError: new DOMException('Response lost after commit', 'TimeoutError') },
    { graphql: {} },
    { graphql: { data: { deleteIssue: null } } },
    { graphql: null },
  ]) {
    const fake = fakeIssueDeletion(options);
    await assert.rejects(fake.gh.deleteIssue({ number: 12 }), /结果未知.*先同步.*不要自动重试/);
    assert.equal(fake.calls.length, 4);
    assert.equal(fake.writes().length, 1);
    assert.equal(fake.writes()[0].method, 'POST');
    assert.equal(fake.writes()[0].url, 'https://api.github.com/graphql');
  }
});

test('recognize contest and platform URLs', () => {
  assert.deepEqual(identify('https://codeforces.com/contest/2277/problem/C'), { pid: 'CF2277C', platform: 'CF' });
  assert.equal(identify('https://codeforces.com/problemset/problem/2277/C').pid, 'CF2277C');
  assert.equal(identify('https://atcoder.jp/contests/abc400/tasks/abc400_d').platform, 'AT');
  assert.equal(identify('https://www.luogu.com.cn/problem/P1001').pid, 'P1001');
  assert.equal(identify('https://evilcodeforces.com/contest/1/problem/A').platform, 'Oth');
});

test('Markdown parsing exposes identity, management and full body', () => {
  const r = parseDocument(PATH, markdown({ problem_url: 'https://example.com/problem', updated_at: '2026-01-01', custom: true }, '# 内容\n```cpp\nint main(){}\n```'), { repo: 'a/b' });
  assert.equal(r.authorId, 42);
  assert.equal(r.managed, true);
  assert.equal(r.schema, 2);
  assert.equal(r.clientId, CLIENT_ID);
  assert.equal(r.problemUrl, 'https://example.com/problem');
  assert.equal(r.repo, 'a/b');
  assert.match(r.body, /int main/);
  assert.deepEqual(r.tags, ['数学']);
  assert.equal(parseDocument(PATH, markdown({ author_id: '42' })).authorId, null);
});

test('legacy Issue and formal document helpers remain compatible', () => {
  const body = issueBody({ problemUrl: 'https://codeforces.com/problemset/problem/1/A', reason: '溢出', tags: ['实现'] });
  const r = issueRecord({ number: 12, title: '测试', body, labels: [], user: { id: 42, login: 'alice' } });
  assert.equal(r.pid, 'CF1A');
  assert.equal(r.authorId, 42);
  assert.deepEqual(r.tags, ['实现']);
  assert.match(r.body, /溢出/);
  assert.ok(!r.body.includes('qmx-record'));
  const d = documentContent({ pid: 'CF1A', platform: 'CF', title: 'a: b\nother: value', tags: ['数学'] }, 'alice');
  assert.equal(parseDocument(PATH, d.text).title, 'a: b\nother: value');
  assert.throws(() => repoParts('../bad/repo'));
});

test('profile returns authenticated account and repository permissions', async () => {
  const { gh, calls } = fakeGitHub({ push: false, admin: true });
  assert.deepEqual(await gh.profile(), {
    account: { id: 42, login: 'alice', name: 'Alice', avatarUrl: 'https://example.com/avatar' },
    permissions: { push: true, admin: true, repo: 'a/b' },
  });
  assert.equal(calls[0].url, 'https://api.github.com/user');
});

test('create writes a deterministic direct path with authenticated metadata', async () => {
  const { gh, calls, store, writes } = fakeGitHub();
  const saved = await gh.saveDocument(record({ authorId: 999, author: 'mallory', problemUrl: 'https://codeforces.com/problemset/problem/1/A' }));
  assert.equal(saved.path, PATH);
  assert.equal(saved.id, `document:${PATH}`);
  assert.equal(saved.authorId, 42);
  assert.equal(saved.author, 'alice');
  assert.equal(saved.repo, 'a/b');
  assert.equal(saved.branch, 'main');
  assert.equal(saved.sha, 'sha-1');
  assert.match(saved.url, /\/blob\/main\/problems\/qmx\/42\//);
  assert.equal(saved.body, record().body);
  assert.equal(saved.problemUrl, 'https://codeforces.com/problemset/problem/1/A');
  assert.equal(writes().length, 1);
  assert.equal(writes()[0].method, 'PUT');
  assert.ok(calls[0].url.endsWith('/user'));
  assert.ok(!calls.some(x => /\/(issues|pulls|forks|git\/refs)/.test(x.url)));
  assert.equal(YAML.parse(store.get(PATH).text.split('---\n')[1]).author_id, 42);
});

test('algorithm metadata uses the same canonical author and UUID creation path', async () => {
  const { gh } = fakeGitHub();
  const saved = await gh.saveDocument(record({ platform: '算法', pid: '' }));
  assert.equal(saved.path, PATH);
  assert.equal(saved.platform, '算法');
});

test('same create retry returns existing content without another write; different payload conflicts', async () => {
  const { gh, writes } = fakeGitHub();
  const first = await gh.saveDocument(record());
  const repeated = await gh.saveDocument(record());
  assert.equal(repeated.sha, first.sha);
  assert.equal(writes().length, 1);
  await assert.rejects(gh.saveDocument(record({ body: 'changed' })), /clientId.*内容不同/);
  assert.equal(writes().length, 1);
});

test('create committed before timeout retries the same UUID with one document and no second PUT', async () => {
  const { gh, store, writes } = fakeGitHub({ timeoutAfterCommit: true });
  await assert.rejects(gh.saveDocument(record()), /结果未知.*先同步/);
  assert.equal(store.size, 1);
  const saved = await gh.saveDocument(record());
  assert.equal(saved.path, PATH);
  assert.equal(saved.sha, 'sha-1');
  assert.equal(store.size, 1);
  assert.equal(writes().length, 1);
  for (const platform of ['AT', 'LG', '算法']) {
    await assert.rejects(gh.saveDocument(record({ platform })), /clientId.*内容不同.*同步/);
  }
  assert.equal(store.size, 1);
  assert.equal(writes().length, 1);
});

test('profile rejects missing or nonnumeric authenticated user identities', async () => {
  for (const user of [{ login: 'alice' }, { id: '42', login: 'alice' }, { id: 0, login: 'alice' }, { id: 42 }]) {
    const { gh, calls } = fakeGitHub({ user });
    await assert.rejects(gh.profile(), /无法确认.*身份/);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/user'));
  }
});

test('update preserves unknown frontmatter and uses the full Markdown editor body', async () => {
  const { gh, store, calls, writes } = fakeGitHub({ files: { [PATH]: markdown({ custom: { nested: [1, 2] }, problem_url: 'old-link' }) } });
  const saved = await gh.saveDocument({ path: PATH, sha: 'old-sha', repo: 'a/b', body: '---\nauthor_id: 999\nauthor: mallory\ncustom_editor: yes\n---\n# New\n\n```cpp\nreturn 0;\n```', title: '新标题' });
  const parsed = YAML.parse(store.get(PATH).text.split('---\n')[1]);
  assert.deepEqual(parsed.custom, { nested: [1, 2] });
  assert.equal(parsed.custom_editor, 'yes');
  assert.equal(parsed.author_id, 42);
  assert.equal(parsed.author, 'alice');
  assert.equal(saved.title, '新标题');
  assert.match(saved.body, /return 0/);
  assert.equal(saved.clientId, CLIENT_ID);
  assert.equal(saved.problemUrl, 'old-link');
  assert.equal(writes()[0].payload.sha, 'old-sha');
  assert.ok(calls[0].url.endsWith('/user'));
});

test('update without editor body retains existing Markdown', async () => {
  const { gh } = fakeGitHub({ files: { [PATH]: markdown({}, 'old body') } });
  const saved = await gh.saveDocument({ path: PATH, sha: 'old-sha', title: 'changed' });
  assert.equal(saved.body, 'old body');
});

test('delete verifies fresh SHA and numeric author, returning scoped identity', async () => {
  const { gh, calls, writes, store } = fakeGitHub({ files: { [PATH]: markdown() } });
  assert.deepEqual(await gh.deleteDocument({ path: PATH, sha: 'old-sha', repo: 'a/b' }), { id: `document:${PATH}`, path: PATH, repo: 'a/b', deleted: true });
  assert.equal(store.has(PATH), false);
  assert.equal(writes()[0].method, 'DELETE');
  assert.ok(calls[0].url.endsWith('/user'));
});

test('ownership spoof, unknown legacy identity and SHA conflicts never write', async () => {
  for (const [meta, sha, message] of [
    [{ author_id: 999, author: 'alice' }, 'old-sha', /author_id.*不一致/],
    [{ author_id: null, author: 'alice' }, 'old-sha', /旧文档.*author_id/],
    [{ author_id: '42' }, 'old-sha', /旧文档.*author_id/],
    [{}, 'stale-sha', /SHA 冲突/],
  ]) {
    const { gh, writes } = fakeGitHub({ files: { [PATH]: markdown(meta) } });
    await assert.rejects(gh.saveDocument(record({ path: PATH, sha, authorId: 42, author: 'alice' })), message);
    await assert.rejects(gh.deleteDocument({ path: PATH, sha, authorId: 42, author: 'alice' }), message);
    assert.equal(writes().length, 0);
  }
});

test('numeric owner identity permits renamed accounts and ignores renderer identity claims', async () => {
  const { gh } = fakeGitHub({ files: { [PATH]: markdown({ author: 'old-login' }) } });
  const saved = await gh.saveDocument({ path: PATH, sha: 'old-sha', authorId: 999, author: 'mallory', body: 'updated' });
  assert.equal(saved.authorId, 42);
  assert.equal(saved.author, 'alice');
});

test('create cannot overwrite deterministic path occupied by a different client ID or owner', async () => {
  for (const meta of [{ client_id: 'another-id' }, { author_id: 99 }]) {
    const { gh, writes } = fakeGitHub({ files: { [PATH]: markdown(meta) } });
    await assert.rejects(gh.saveDocument(record()), /clientId.*不匹配|author_id.*不一致/);
    assert.equal(writes().length, 0);
  }
});

test('invalid paths, missing SHA, invalid UUID and cross-repository records never write', async () => {
  const { gh, writes } = fakeGitHub();
  for (const path of ['README.md', 'problems/../secret.md', 'problems/a/../../x.md', 'problems/a\\x.md', 'problems/%2e%2e/x.md', 'problems//a.md', 'algorithms/a.txt', 'problems/a.md?ref=x']) {
    await assert.rejects(gh.saveDocument(record({ path, sha: 'old-sha' })), /路径/);
    await assert.rejects(gh.deleteDocument({ path, sha: 'old-sha' }), /路径/);
  }
  await assert.rejects(gh.saveDocument(record({ path: PATH })), /SHA/);
  await assert.rejects(gh.deleteDocument({ path: PATH }), /SHA/);
  await assert.rejects(gh.saveDocument(record({ clientId: 'bad' })), /UUID/);
  await assert.rejects(gh.saveDocument(record({ repo: 'other/repo' })), /仓库不一致/);
  await assert.rejects(gh.deleteDocument({ path: PATH, sha: 'old-sha', repo: 'other/repo' }), /仓库不一致/);
  assert.equal(writes().length, 0);
});

test('missing files and permissions fail before any write', async () => {
  const missing = fakeGitHub();
  await assert.rejects(missing.gh.saveDocument(record({ path: PATH, sha: 'old-sha' })), /删除或移动/);
  await assert.rejects(missing.gh.deleteDocument({ path: PATH, sha: 'old-sha' }), /不存在/);
  assert.equal(missing.writes().length, 0);
  const denied = fakeGitHub({ push: false });
  await assert.rejects(denied.gh.saveDocument(record()), /写入权限/);
  await assert.rejects(denied.gh.deleteDocument({ path: PATH, sha: 'old-sha' }), /写入权限/);
  assert.equal(denied.writes().length, 0);
});

test('branch protection and ambiguous network failures offer useful recovery', async () => {
  const protectedRepo = fakeGitHub({ writeStatus: 403 });
  await assert.rejects(protectedRepo.gh.saveDocument(record()), /默认分支保护/);
  const timeout = fakeGitHub({ writeError: new DOMException('timeout', 'TimeoutError') });
  await assert.rejects(timeout.gh.saveDocument(record()), /结果未知.*先同步.*不要重复创建/);
});

test('legacy submit and propose entry points publish direct Markdown only', async () => {
  const { gh, writes, calls } = fakeGitHub();
  await gh.submit(record());
  await gh.propose(record());
  assert.equal(writes().length, 1);
  assert.equal(writes()[0].method, 'PUT');
  assert.ok(!calls.some(x => /\/(issues|pulls|forks)/.test(x.url)));
});

test('sync paginates, includes closed Issues separately, scopes both record types and reuses blobs', async () => {
  const urls = [];
  const fetcher = async url => {
    urls.push(url);
    let data;
    let link = '';
    if (url.endsWith('/repos/a/b')) data = { default_branch: 'develop' };
    else if (url.includes('/git/trees/')) data = { tree: [{ type: 'blob', path: PATH, sha: '123' }, { type: 'blob', path: 'README.md', sha: 'skip' }] };
    else if (url.includes('page=2')) data = [{ number: 3, title: 'PR', pull_request: {}, user: {} }, { number: 2, title: 'closed', state: 'closed', user: { id: 43, login: 'bob' } }];
    else if (url.includes('/issues?')) {
      assert.ok(url.includes('state=all'));
      data = [{ number: 1, title: '错题', body: 'hello', state: 'open', user: { id: 42, login: 'alice' }, labels: [] }];
      link = '<https://api.github.com/next>; rel="next"';
    } else throw new Error(url);
    return { ok: true, json: async () => data, headers: new Headers({ link }) };
  };
  const result = await new GitHub({ repo: 'a/b', fetcher }).sync({ blobs: { 123: markdown() } });
  assert.equal(result.records.length, 1);
  assert.equal(result.issues.length, 2);
  assert.equal(result.issues[1].state, 'closed');
  assert.equal(result.issues[1].authorId, 43);
  for (const item of [...result.records, ...result.issues]) assert.equal(item.repo, 'a/b');
  assert.ok(urls.some(x => x.includes('page=2')));
  assert.equal(result.branch, 'develop');
  assert.ok(!urls.some(x => x.includes('/git/blobs/')));
  assert.deepEqual(Object.keys(result.blobs), ['123']);
});

test('sync removes remotely deleted documents and cached blobs without resurrecting or writing them', async () => {
  const calls = [];
  let deleted = false;
  const fetcher = async (url, opts) => {
    calls.push({ url, method: opts.method || 'GET' });
    assert.equal(opts.method || 'GET', 'GET');
    let data;
    if (url.endsWith('/repos/a/b')) data = { default_branch: 'main' };
    else if (url.includes('/git/trees/')) data = { tree: deleted ? [] : [{ type: 'blob', path: PATH, sha: 'cached-sha' }] };
    else if (url.includes('/issues?')) data = [];
    else throw new Error(`Unexpected fetch: ${url}`);
    return { ok: true, json: async () => data, headers: new Headers() };
  };
  const gh = new GitHub({ repo: 'a/b', token: 'secret', fetcher });
  const before = await gh.sync({ blobs: { 'cached-sha': markdown() } });
  assert.equal(before.records.length, 1);
  deleted = true;
  const after = await gh.sync(before);
  assert.deepEqual(after.records, []);
  assert.deepEqual(after.blobs, {});
  const repeated = await gh.sync(after);
  assert.deepEqual(repeated.records, []);
  assert.deepEqual(repeated.blobs, {});
  assert.ok(calls.every(call => call.method === 'GET'));
});

test('GitHub denied authentication returns actionable message', async () => {
  const gh = new GitHub({ fetcher: async () => ({ ok: false, status: 401, json: async () => ({}), headers: new Headers() }) });
  await assert.rejects(gh.request('/user'), /重新授权/);
});
