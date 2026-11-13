const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_SYNC_ORIGINS = ['http://172.25.5.128:3000', 'https://github.com', 'https://api.github.com'];
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
};
const BROWSER_ASSETS = new Set([
  '/node_modules/marked/lib/marked.umd.js',
  '/node_modules/dompurify/dist/purify.min.js',
  '/node_modules/katex/dist/katex.min.css',
  '/node_modules/katex/dist/katex.min.js',
  ...['core', 'clike', 'c', 'cpp', 'python', 'java', 'go', 'rust']
    .map(name => `/node_modules/prismjs/components/prism-${name}.js`),
  '/node_modules/prismjs/plugins/line-numbers/prism-line-numbers.js',
]);

function originUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Sync servers must be HTTP(S) origins without credentials, paths, queries or fragments');
  }
  return url;
}

function configuredOrigins(value) {
  const values = value === undefined ? DEFAULT_SYNC_ORIGINS
    : Array.isArray(value) ? value : String(value).split(',').map(item => item.trim()).filter(Boolean);
  return new Set(values.map(value => originUrl(value).origin));
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function isAllowedPath(requestPath) {
  return requestPath.startsWith('/ui/') || BROWSER_ASSETS.has(requestPath)
    || /^\/node_modules\/katex\/dist\/fonts\/[A-Za-z0-9_-]+\.(woff2?|ttf)$/.test(requestPath);
}

// Wildcard bindings accept literal IP hosts for LAN previews, never arbitrary DNS names.
function allowedHostname(hostname, host) {
  const name = hostname.toLowerCase();
  const address = name.replace(/^\[|\]$/g, '');
  if (name === 'localhost' || address === '127.0.0.1' || address === '::1') return true;
  if (host === '0.0.0.0' || host === '::') return net.isIP(address) !== 0;
  return name === host.toLowerCase() || address === host.toLowerCase();
}

function requestOrigin(req, server, host) {
  const authority = req.headers.host;
  if (typeof authority !== 'string' || !authority || /[\s,/@\\?#]/.test(authority)) return null;
  let url;
  try { url = new URL(`http://${authority}`); } catch { return null; }
  if (!allowedHostname(url.hostname, host) || Number(url.port || 80) !== server.address()?.port) return null;
  return url.origin;
}

function createServer({ host = process.env.HOST || DEFAULT_HOST,
  baseDir = __dirname, allowedOrigins = process.env.SYNC_ALLOWED_ORIGINS,
  fetcher = globalThis.fetch } = {}) {
  const syncOrigins = configuredOrigins(allowedOrigins);
  const base = path.resolve(baseDir);
  const roots = new Map();
  const realRoot = async directory => {
    if (!roots.has(directory)) roots.set(directory, fs.promises.realpath(path.join(base, directory)));
    return roots.get(directory);
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const reply = (status, message, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
      res.end(message);
    };
    try {
      const localOrigin = requestOrigin(req, server, host);
      if (!localOrigin) return reply(403, 'Forbidden Host');
      if (req.headers.origin !== undefined && req.headers.origin !== localOrigin) return reply(403, 'Forbidden Origin');
      if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) {
        return reply(403, 'Forbidden cross-site request');
      }
      if (req.method !== 'GET') return reply(405, 'Method Not Allowed', { Allow: 'GET' });
      if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//')) return reply(400, 'Invalid request target');
      const rawPath = req.url.split('?')[0];
      let requestPath;
      try { requestPath = decodeURIComponent(rawPath); } catch { return reply(400, 'Malformed URL encoding'); }
      // Reject separators and double encoding before URL parsing can normalize dot segments.
      if (/%(?:2f|5c)/i.test(rawPath) || /[\\%:\u0000-\u001f\u007f]/.test(requestPath)
          || requestPath.split('/').some(part => part === '.' || part === '..' || /[.: ]$/.test(part))) {
        return reply(403, 'Forbidden path');
      }
      if (requestPath === '/api/sync') {
        const params = new URL(req.url, localOrigin).searchParams;
        if (req.headers.authorization || params.has('token') || params.has('access_token')) {
          return reply(400, 'Web sync supports anonymous public access only');
        }
        const repo = params.get('repo') || 'ctguacm/2026';
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.split('/').some(part => part === '.' || part === '..')) {
          return reply(400, 'Invalid repository; expected owner/repo');
        }
        let upstream;
        try { upstream = originUrl(params.has('serverUrl') ? params.get('serverUrl') || 'https://api.github.com' : DEFAULT_SYNC_ORIGINS[0]); }
        catch { return reply(400, 'Invalid sync server origin'); }
        if (!syncOrigins.has(upstream.origin)) return reply(403, 'Sync server origin is not allowed; configure SYNC_ALLOWED_ORIGINS');
        // github.com is a user-facing alias whose requests are sent to api.github.com.
        const upstreamOrigin = upstream.origin === 'https://github.com' ? 'https://api.github.com' : upstream.origin;
        const anonymousFetch = async (url, options = {}) => {
          const target = new URL(url);
          if (target.origin !== upstreamOrigin || target.username || target.password
              || (options.method && options.method !== 'GET') || options.body !== undefined) {
            throw new Error('Sync request must be an anonymous GET to the selected server');
          }
          const headers = new Headers(options.headers);
          headers.delete('authorization');
          headers.delete('cookie');
          const response = await fetcher(target.href, { ...options, method: 'GET', headers, redirect: 'error', credentials: 'omit' });
          if (response.status >= 300 && response.status < 400) throw new Error('Sync redirects are disabled');
          return response;
        };
        try {
          const { GitHub } = require('./electron/github.cjs');
          const result = await new GitHub({ repo, serverUrl: upstream.origin, token: '', fetcher: anonymousFetch }).sync();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: error.message, records: [], issues: [] }));
        }
        return;
      }
      if (requestPath === '/') return reply(302, '', { Location: '/ui/' });
      if (requestPath === '/ui' || requestPath === '/ui/') requestPath = '/ui/index.html';
      if (!isAllowedPath(requestPath)) return reply(404, '404 Not Found');
      if (requestPath.split('/').some(part => part.startsWith('.'))) return reply(403, 'Forbidden path');
      const directory = requestPath.startsWith('/ui/') ? 'ui' : `node_modules/${requestPath.split('/')[2]}`;
      const filePath = path.resolve(base, `.${requestPath}`);
      if (!isWithin(path.join(base, directory), filePath)) return reply(403, 'Forbidden path');
      let file;
      try {
        const [root, realFile] = await Promise.all([realRoot(directory), fs.promises.realpath(filePath)]);
        if (!isWithin(root, realFile)) return reply(403, 'Forbidden path');
        file = await fs.promises.open(realFile, 'r');
        const stats = await file.stat();
        if (!stats.isFile()) { await file.close(); return reply(404, '404 Not Found'); }
      } catch (error) {
        if (file) await file.close().catch(() => {});
        return reply(['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 500, 'Unable to read preview asset');
      }
      res.setHeader('Content-Type', MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
      const stream = file.createReadStream();
      stream.on('error', () => {
        if (!res.headersSent) reply(500, 'Unable to read preview asset');
        else res.destroy();
      });
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch {
      if (!res.headersSent) reply(500, 'Preview server error');
      else res.destroy();
    }
  });
  return server;
}

if (require.main === module) {
  const host = process.env.HOST || DEFAULT_HOST;
  const server = createServer({ host });
  server.listen(process.env.PORT || 3001, host, () => {
    const address = server.address();
    const displayHost = host.includes(':') ? `[${host}]` : host;
    console.log(`QMX ACM Notebook Web Server running at http://${displayHost}:${address.port}/`);
  });
}

module.exports = { createServer };
