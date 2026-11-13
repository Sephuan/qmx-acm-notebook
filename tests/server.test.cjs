const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const { createServer } = require('../server.js');

async function preview(t, options = {}) {
  const server = createServer({ host: '127.0.0.1', ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const request = (target, { method = 'GET', headers = {}, omitHost = false } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: target, method, headers,
      ...(omitHost ? { setHost: false } : {}) }, res => {
      const chunks = [];
      res.on('data', data => chunks.push(data));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
  return { request, origin, port };
}

function publicRepositoryFetch() {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    const pathname = new URL(url).pathname;
    let data;
    if (/\/repos\/[^/]+\/[^/]+$/.test(pathname)) data = { default_branch: 'main' };
    else if (pathname.endsWith('/git/trees/main')) data = { tree: [] };
    else if (pathname.endsWith('/issues')) data = [];
    else throw new Error(`Unexpected upstream request: ${url}`);
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, fetcher };
}

const syncPath = serverUrl => `/api/sync?repo=team%2Fpublic${serverUrl === undefined ? '' : `&serverUrl=${encodeURIComponent(serverUrl)}`}`;

test('importing the preview server starts no listener', () => {
  const result = spawnSync(process.execPath, ['-e', "require('./server.js'); console.log('imported')"], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'imported');
});

test('command-line preview binds loopback by default and honors explicit HOST', async () => {
  for (const host of [undefined, '0.0.0.0']) {
    const env = { ...process.env, PORT: '0' };
    if (host === undefined) delete env.HOST;
    else env.HOST = host;
    const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const output = await new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        const timeout = setTimeout(() => reject(new Error(`Preview startup timed out: ${stderr}`)), 5000);
        child.stdout.on('data', data => {
          stdout += data;
          if (stdout.includes('Web Server running at')) { clearTimeout(timeout); resolve(stdout); }
        });
        child.stderr.on('data', data => { stderr += data; });
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Preview exited ${code}: ${stderr}`)); });
      });
      assert.match(output, host === undefined ? /http:\/\/127\.0\.0\.1:\d+\// : /http:\/\/0\.0\.0\.0:\d+\//);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
    }
  }
});

test('preview serves UI and production browser dependencies without CORS exposure', async t => {
  const { request } = await preview(t);
  const root = await request('/');
  assert.equal(root.status, 302);
  assert.equal(root.headers.location, '/ui/');
  for (const target of ['/ui', '/ui/', '/ui/app.js',
    '/node_modules/marked/lib/marked.umd.js', '/node_modules/dompurify/dist/purify.min.js',
    '/node_modules/katex/dist/katex.min.css', '/node_modules/katex/dist/katex.min.js',
    '/node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2',
    ...['core', 'clike', 'c', 'cpp', 'python', 'java', 'go', 'rust'].map(name => `/node_modules/prismjs/components/prism-${name}.js`),
    '/node_modules/prismjs/plugins/line-numbers/prism-line-numbers.js']) {
    const response = await request(target);
    assert.equal(response.status, 200, target);
    assert.ok(response.body.length > 0, target);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  }
});

test('repository files and unrelated dependencies are unavailable', async t => {
  const { request } = await preview(t);
  for (const target of ['/.git/config', '/.git/HEAD', '/package.json', '/server.js', '/electron/main.cjs',
    '/tests/server.test.cjs', '/node_modules/yaml/package.json', '/node_modules/marked/package.json',
    '/node_modules/dompurify/dist/purify.cjs.js', '/node_modules/katex/dist/contrib/auto-render.min.js',
    '/node_modules/prismjs/components/prism-bash.js', '/ui/.secret', '/ui/missing.js']) {
    assert.ok([403, 404].includes((await request(target)).status), target);
  }
});

test('malformed encodings, traversal, Windows separators and alternate streams fail safely', async t => {
  const { request } = await preview(t);
  for (const target of ['/ui/%', '/ui/%ZZ', '/ui/%E0%A4%A']) assert.equal((await request(target)).status, 400, target);
  for (const target of ['/ui/../server.js', '/ui/%2e%2e/server.js', '/ui/%2E%2E%2fserver.js',
    '/ui/..%5cserver.js', '/ui/..\\server.js', '/ui/%252e%252e/server.js',
    '/ui/%2f..%2fserver.js', '/ui/app.js::$DATA', '/ui/app.js.', '/ui/app.js%00', '/ui/./index.html']) {
    assert.equal((await request(target)).status, 403, target);
  }
  assert.equal((await request('/ui/')).status, 200, 'server stays alive after malformed requests');
});

test('Host and Origin checks block DNS rebinding and cross-site requests', async t => {
  const fake = publicRepositoryFetch();
  const { request, origin, port } = await preview(t, { fetcher: fake.fetcher });
  for (const headers of [
    { Host: `attacker.example:${port}` }, { Host: '127.0.0.1:1' },
    { Host: `localhost.attacker.example:${port}` }, { Host: `user@127.0.0.1:${port}` },
    { Host: `127.0.0.1:${port},attacker.example` },
    { Origin: 'https://attacker.example' }, { Origin: 'null' },
    { Origin: `http://localhost:${port}` }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' },
  ]) {
    const response = await request(syncPath(), { headers });
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  // Node may reject HTTP/1.1 requests without Host before the handler runs.
  assert.ok([400, 403].includes((await request('/ui/', { omitHost: true })).status));
  assert.equal(fake.calls.length, 0);
  assert.equal((await request('/ui/', { headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  assert.equal((await request('/ui/', { headers: { Host: `localhost:${port}` } })).status, 200);
});

test('explicit wildcard LAN binding accepts IP hosts but still rejects unconfigured DNS names', async t => {
  const { request, port } = await preview(t, { host: '0.0.0.0' });
  assert.equal((await request('/ui/', { headers: { Host: `192.168.1.2:${port}` } })).status, 200);
  assert.equal((await request('/ui/', { headers: { Host: `evil.example:${port}` } })).status, 403);
});

test('only GET is accepted for both assets and sync', async t => {
  const fake = publicRepositoryFetch();
  const { request } = await preview(t, { fetcher: fake.fetcher });
  for (const target of ['/ui/', '/api/sync']) {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
      const response = await request(target, { method });
      assert.equal(response.status, 405, `${method} ${target}`);
      assert.equal(response.headers.allow, 'GET');
    }
  }
  assert.equal(fake.calls.length, 0);
});

test('default campus and GitHub sync remain anonymous and never follow redirects', async t => {
  const fake = publicRepositoryFetch();
  const { request, origin } = await preview(t, { fetcher: fake.fetcher });
  for (const serverUrl of [undefined, '', 'https://github.com', 'https://api.github.com']) {
    const start = fake.calls.length;
    const response = await request(syncPath(serverUrl), { headers: { Origin: origin, Cookie: 'session=private' } });
    assert.equal(response.status, 200, response.body);
    assert.deepEqual(JSON.parse(response.body).records, []);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    const calls = fake.calls.slice(start);
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(new URL(call.url).origin, serverUrl === undefined ? 'http://172.25.5.128:3000' : 'https://api.github.com');
      assert.equal(call.options.method, 'GET');
      assert.equal(call.options.redirect, 'error');
      assert.equal(call.options.credentials, 'omit');
      assert.equal(call.options.headers.has('authorization'), false);
      assert.equal(call.options.headers.has('cookie'), false);
    }
  }
});

test('sync rejects arbitrary servers, credential URLs, invalid repositories and authentication', async t => {
  const fake = publicRepositoryFetch();
  const { request } = await preview(t, { fetcher: fake.fetcher });
  for (const serverUrl of ['http://127.0.0.1:8080', 'http://169.254.169.254', 'http://172.25.5.128:3001',
    'https://github.com.attacker.example', 'http://api.github.com']) {
    assert.equal((await request(syncPath(serverUrl))).status, 403, serverUrl);
  }
  for (const serverUrl of ['file:///etc/passwd', 'http://user:pass@172.25.5.128:3000',
    'http://172.25.5.128:3000/api/v1', 'http://172.25.5.128:3000/?token=secret', 'https://github.com/#secret', 'garbage']) {
    assert.equal((await request(syncPath(serverUrl))).status, 400, serverUrl);
  }
  for (const repo of ['../repo', 'owner/..', 'owner/repo/extra', 'owner/repo?token=secret']) {
    assert.equal((await request(`/api/sync?repo=${encodeURIComponent(repo)}`)).status, 400, repo);
  }
  for (const target of [`${syncPath()}&token=secret`, `${syncPath()}&access_token=secret`]) {
    assert.equal((await request(target)).status, 400);
  }
  assert.equal((await request(syncPath(), { headers: { Authorization: 'Bearer secret' } })).status, 400);
  assert.equal(fake.calls.length, 0);
});

test('configured origins replace defaults and authorize only the exact HTTP(S) origin', async t => {
  const fake = publicRepositoryFetch();
  const { request } = await preview(t, { allowedOrigins: ' https://gitea.example:8443 , ', fetcher: fake.fetcher });
  assert.equal((await request(syncPath())).status, 403);
  assert.equal((await request(syncPath('https://gitea.example:8443'))).status, 200);
  for (const url of ['http://gitea.example:8443', 'https://gitea.example', 'https://gitea.example.attacker:8443']) {
    assert.equal((await request(syncPath(url))).status, 403);
  }
  assert.equal(fake.calls.length, 3);
  for (const value of ['*', 'https://user:pass@gitea.example', 'https://gitea.example/api/v1']) {
    assert.throws(() => createServer({ allowedOrigins: value }));
  }
});

test('upstream redirects and network failures return JSON errors without escaping the allowed origin', async t => {
  for (const redirect of [true, false]) {
    const calls = [];
    const { request } = await preview(t, { fetcher: async (url, options) => {
      calls.push({ url, options });
      if (!redirect) throw new Error('offline');
      return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } });
    } });
    const response = await request(syncPath());
    assert.equal(response.status, 502);
    assert.deepEqual(JSON.parse(response.body).records, []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.redirect, 'error');
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.equal((await request('/ui/')).status, 200);
  }
});

test('filesystem failures stay within HTTP responses and symlinks cannot expose files outside UI', async t => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qmx-preview-'));
  t.after(() => fs.rm(baseDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(baseDir, 'ui'));
  await fs.writeFile(path.join(baseDir, 'ui', 'index.html'), '<!doctype html><title>preview</title>');
  await fs.writeFile(path.join(baseDir, 'private.txt'), 'private');
  // A junction works without Windows symlink privileges and exercises realpath confinement.
  await fs.mkdir(path.join(baseDir, 'private'));
  await fs.writeFile(path.join(baseDir, 'private', 'secret.txt'), 'secret');
  await fs.symlink(path.join(baseDir, 'private'), path.join(baseDir, 'ui', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const { request } = await preview(t, { baseDir });
  assert.equal((await request('/ui/linked/secret.txt')).status, 403);
  assert.equal((await request('/ui/missing.js')).status, 404);
  assert.equal((await request('/node_modules/marked/lib/marked.umd.js')).status, 404);
  assert.equal((await request('/ui/')).status, 200);
  await fs.unlink(path.join(baseDir, 'ui', 'index.html'));
  assert.equal((await request('/ui/')).status, 404);
});
