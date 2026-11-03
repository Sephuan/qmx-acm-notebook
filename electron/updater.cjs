'use strict';

// Electron's patched fs treats .asar files as virtual directories; updates need raw bytes.
const fs = process.versions.electron ? require('original-fs').promises : require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const COMMIT_URL = 'https://api.github.com/repos/qmx-acm-data/qmx-acm-notebook/commits/main';
const RAW_ROOT = 'https://raw.githubusercontent.com/qmx-acm-data/qmx-acm-notebook/';
function sourceUrls(sha, file) {
  const raw = `${RAW_ROOT}${sha}/${file}`;
  return [`https://api.github.com/repos/qmx-acm-data/qmx-acm-notebook/contents/${file}?ref=${sha}`, raw,
    `https://cdn.jsdelivr.net/gh/qmx-acm-data/qmx-acm-notebook@${sha}/${file}`,
    `https://gcore.jsdelivr.net/gh/qmx-acm-data/qmx-acm-notebook@${sha}/${file}`,
    `https://gh-proxy.com/${raw}`];
}
function networkError(url, cause, code) {
  const candidate = code || cause?.cause?.code || cause?.code;
  const safeCode = typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(candidate) ? candidate : 'NETWORK_ERROR';
  const error = new Error(`网络无法连接更新服务（${new URL(url).hostname}，${safeCode}）。请稍后重试，或下载完整安装包手动安装。`);
  error.transient = true;
  error.code = safeCode;
  return error;
}
function aborted(signal) {
  if (signal.aborted) throw signal.reason;
}
// Race only transport waits: a stalled injected fetch/iterator cannot continue writing
// into a staging file after its source has been abandoned.
async function transportWait(promise, signal) {
  aborted(signal);
  let listener;
  const expiry = new Promise((_, reject) => {
    listener = () => reject(signal.reason);
    signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([promise, expiry]); }
  finally { signal.removeEventListener('abort', listener); }
}
const MAX_MANIFEST = 256 * 1024;
const MAX_FILE = 256 * 1024 * 1024;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const clone = value => JSON.parse(JSON.stringify(value));

function versionParts(value) {
  const match = typeof value === 'string' && SEMVER.exec(value);
  return match ? match.slice(1).map(BigInt) : null;
}
function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
// The signing format is recursive, lexicographically sorted JSON, without whitespace.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function exactKeys(object, keys) {
  return object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).sort().join(',') === keys.slice().sort().join(',');
}
function validateResponse(response, expectedUrl) {
  // Native fetch reports the final URL. Minimal injected fetch responses may omit it.
  if (response.url && response.url !== expectedUrl) throw new Error('Unsafe update response URL');
  if (response.redirected) throw new Error('Update request failed: redirects are forbidden');
  if (!response.ok) {
    const error = networkError(expectedUrl, null, `HTTP_${response.status}`);
    error.transient = response.status === 408 || response.status === 429 || response.status >= 500 && response.status <= 599;
    throw error;
  }
}
async function streamResponse(response, limit, signal, consume, expectedSize) {
  if (!response.body?.[Symbol.asyncIterator]) throw new Error('Update response has no readable stream');
  const length = response.headers?.get?.('content-length');
  if (length != null && (!/^\d+$/.test(length) || Number(length) > limit || (expectedSize !== undefined && Number(length) !== expectedSize))) {
    throw new Error('Update Content-Length exceeds limit or does not match expected size');
  }
  let size = 0;
  const iterator = response.body[Symbol.asyncIterator]();
  try {
    while (true) {
      let part;
      try { part = await transportWait(iterator.next(), signal); }
      catch (error) { error.transportFailure = true; throw error; }
      aborted(signal);
      if (part.done) break;
      const chunk = Buffer.from(part.value);
      size += chunk.length;
      if (size > limit) throw new Error('Update response exceeds expected size limit');
      await consume(chunk, size);
    }
  } finally {
    // Do not await return(): a broken/stalled iterator may never settle.
    Promise.resolve(iterator.return?.()).catch(() => {});
  }
  aborted(signal);
  if (expectedSize !== undefined && size !== expectedSize) throw new Error('Update size verification failed');
}

function validateSignedManifest(manifest, publicKey, runtimeVersion) {
  if (!exactKeys(manifest, ['schema', 'version', 'runtimeVersion', 'base', 'notes', 'publishedAt', 'files', 'signature']) || manifest.schema !== 1 || !versionParts(manifest.version) || !versionParts(manifest.runtimeVersion) || manifest.base !== '../' || typeof manifest.notes !== 'string' || typeof manifest.publishedAt !== 'string' || !Number.isFinite(Date.parse(manifest.publishedAt))) throw new Error('Invalid update manifest');
  if (!Array.isArray(manifest.files) || manifest.files.length !== 1) throw new Error('Manifest must contain only resources/app.asar');
  const file = manifest.files[0];
  if (!exactKeys(file, ['path', 'size', 'sha256']) || file.path !== 'resources/app.asar' || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_FILE || typeof file.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(file.sha256)) throw new Error('Invalid manifest file path, size, or SHA-256');
  if (typeof manifest.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(manifest.signature)) throw new Error('Invalid manifest signature');
  const signature = Buffer.from(manifest.signature, 'base64');
  if (signature.toString('base64') !== manifest.signature) throw new Error('Invalid manifest signature');
  const configuredKey = publicKey === undefined ? require('./update-key.cjs') : publicKey;
  const key = configuredKey?.type === 'public' ? configuredKey : crypto.createPublicKey(configuredKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Update public key must be Ed25519');
  const unsigned = Object.fromEntries(Object.entries(manifest).filter(([name]) => name !== 'signature'));
  if (!crypto.verify(null, Buffer.from(canonical(unsigned)), key, signature)) throw new Error('Manifest signature verification failed');
  if (manifest.runtimeVersion !== runtimeVersion) throw new Error('Electron runtime version mismatch; manual installer required');
  return file;
}

function verifyManifest(manifest, { publicKey, runtimeVersion, currentVersion } = {}) {
  const file = validateSignedManifest(manifest, publicKey, runtimeVersion);
  if (currentVersion !== undefined && (!versionParts(currentVersion) || compare(versionParts(manifest.version), versionParts(currentVersion)) <= 0)) throw new Error('Update version verification failed: no newer update');
  return file;
}

function createUpdater({ currentVersion, downloadDir, fetcher = globalThis.fetch, onProgress = () => {}, timeoutMs = 120000, attemptMs = 10000, runtimeVersion = process.versions.electron, publicKey } = {}) {
  const current = versionParts(currentVersion);
  if (!current) throw new Error('currentVersion must be a stable semantic version');
  if (!versionParts(runtimeVersion)) throw new Error('runtimeVersion must be the installed Electron semantic version');
  if (typeof downloadDir !== 'string' || !path.isAbsolute(downloadDir)) throw new Error('downloadDir must be an absolute directory');
  if (typeof fetcher !== 'function') throw new Error('fetcher must be a function');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive');
  if (!Number.isSafeInteger(attemptMs) || attemptMs <= 0) throw new Error('attemptMs must be positive');
  downloadDir = path.resolve(downloadDir);
  let state = { phase: 'idle', currentVersion, latestVersion: null, version: null, available: false, downloaded: 0, total: 0, percent: 0, message: '' };
  let selected = null;
  let ready = null;
  let checkPromise = null;
  let downloadPromise = null;
  let verifyPromise = null;

  function emit(patch) {
    state = { ...state, ...patch };
    try { onProgress({ ...state }); } catch { /* UI listeners cannot interrupt verification. */ }
    return { ...state };
  }
  function failure(error) {
    emit({ phase: 'error', available: false, message: error.message || String(error) });
    throw error;
  }
  async function candidates(urls, deadline, action) {
    let last;
    for (const url of urls) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw last || networkError(url, null, 'ETIMEDOUT');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(networkError(url, null, 'ETIMEDOUT')), Math.min(10000, attemptMs, remaining));
      try {
        const result = await action(url, controller.signal);
        aborted(controller.signal);
        return result;
      } catch (error) {
        const failure = controller.signal.aborted ? controller.signal.reason : error.transportFailure ? networkError(url, error) : error;
        if (!failure.transient) throw failure;
        last = failure;
      } finally { clearTimeout(timer); controller.abort(); }
    }
    throw last;
  }
  async function request(url, signal) {
    let response;
    try {
      response = await transportWait(fetcher(url, { headers: { Accept: url.startsWith('https://api.github.com/repos/qmx-acm-data/qmx-acm-notebook/contents/') ? 'application/vnd.github.raw+json' : 'application/json', 'User-Agent': 'QMX-Notebook-Updater' }, signal, redirect: 'error', credentials: 'omit' }), signal);
    } catch (error) { throw networkError(url, error); }
    aborted(signal);
    validateResponse(response, url);
    return response;
  }
  async function json(url, signal) {
    const response = await request(url, signal);
    const chunks = [];
    await streamResponse(response, MAX_MANIFEST, signal, chunk => { chunks.push(chunk); });
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new Error('Invalid update JSON'); }
  }
  function validateManifest(manifest) { return verifyManifest(manifest, { publicKey, runtimeVersion }); }
  async function checkInternal() {
    emit({ phase: 'checking', available: false, latestVersion: null, version: null, releaseUrl: null, message: 'Checking for updates', downloaded: 0, total: 0, percent: 0 });
    selected = null;
    ready = null;
    try {
      const deadline = Date.now() + timeoutMs;
      const commit = await candidates([COMMIT_URL, COMMIT_URL, COMMIT_URL], deadline, json);
      if (!commit || typeof commit.sha !== 'string' || !/^[a-f0-9]{40}$/.test(commit.sha)) throw new Error('Invalid main commit SHA');
      const selection = await candidates(sourceUrls(commit.sha, 'feed/manifest.json'), deadline, async (url, signal) => {
        const manifest = await json(url, signal);
        const file = validateManifest(manifest);
        return { manifest, file, urls: sourceUrls(commit.sha, 'resources/app.asar') };
      });
      const { manifest, file } = selection;
      if (compare(versionParts(manifest.version), current) <= 0) return emit({ phase: 'idle', version: manifest.version, latestVersion: manifest.version, message: 'Already up to date' });
      selected = selection;
      return emit({ phase: 'available', available: true, version: manifest.version, latestVersion: manifest.version, total: file.size, message: `Version ${manifest.version} is available` });
    } catch (error) { return failure(error); }
  }
  function check() {
    if (checkPromise) return checkPromise;
    if (downloadPromise || verifyPromise) return Promise.reject(new Error('Updater is busy'));
    checkPromise = checkInternal().finally(() => { checkPromise = null; });
    return checkPromise;
  }
  // Check every directory component, including junctions, before trusting a staged file.
  async function verifyDirectories(directory) {
    let cursor = path.resolve(directory);
    while (true) {
      const info = await fs.lstat(cursor);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Update staging directory must not contain links');
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  async function verifyFile(file, metadata) {
    await verifyDirectories(path.dirname(file));
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== metadata.size) throw new Error('Update size or file type verification failed (links are forbidden)');
    const handle = await fs.open(file, 'r');
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.size !== info.size || opened.ino !== info.ino || opened.dev !== info.dev) throw new Error('Update file changed during verification');
      const hash = crypto.createHash('sha256');
      let size = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        size += chunk.length;
        if (size > metadata.size) throw new Error('Update size verification failed');
        hash.update(chunk);
      }
      const after = await fs.lstat(file);
      if (size !== metadata.size || hash.digest('hex') !== metadata.sha256.toLowerCase() || after.isSymbolicLink() || after.nlink !== 1 || after.ino !== opened.ino || after.dev !== opened.dev) throw new Error('Update SHA-256 or file type verification failed');
    } finally { await handle.close(); }
  }
  function verifyReady() {
    if (verifyPromise) return verifyPromise;
    if (downloadPromise || checkPromise) return Promise.reject(new Error('Updater is busy'));
    verifyPromise = (async () => {
      try {
        if (!ready || !selected) throw new Error('No verified update is ready');
        const metadata = validateManifest(ready.manifest);
        if (ready.version !== ready.manifest.version || compare(versionParts(ready.version), current) <= 0) throw new Error('Update version verification failed');
        await verifyFile(ready.path, metadata);
        emit({ phase: 'ready', message: 'Update verified and ready' });
        return clone(ready);
      } catch (error) { ready = null; return failure(error); }
    })().finally(() => { verifyPromise = null; });
    return verifyPromise;
  }
  function download() {
    if (downloadPromise) return downloadPromise;
    if (verifyPromise) return Promise.reject(new Error('Updater is busy'));
    if (ready) return verifyReady();
    downloadPromise = (async () => {
      let temporary;
      let handle;
      try {
        if (checkPromise) await checkPromise;
        else if (!selected) await checkInternal();
        if (!selected) throw new Error('No newer update is available');
        const selection = selected;
        const metadata = validateManifest(selection.manifest);
        await fs.mkdir(downloadDir, { recursive: true });
        await verifyDirectories(downloadDir);
        const ownDir = await fs.mkdtemp(path.join(downloadDir, 'qmx-update-'));
        await verifyDirectories(ownDir);
        temporary = path.join(ownDir, 'app.asar.part');
        handle = await fs.open(temporary, 'wx', 0o600);
        emit({ phase: 'downloading', version: selection.manifest.version, downloaded: 0, total: metadata.size, percent: 0, message: 'Downloading application update' });
        await candidates(selection.urls, Date.now() + timeoutMs, async (url, signal) => {
          await handle.truncate(0);
          emit({ downloaded: 0, percent: 0 });
          const response = await request(url, signal);
          const hash = crypto.createHash('sha256');
          await streamResponse(response, metadata.size, signal, async (chunk, downloaded) => {
            hash.update(chunk);
            let offset = 0;
            while (offset < chunk.length) {
              aborted(signal);
              const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, downloaded - chunk.length + offset);
              if (!bytesWritten) throw new Error('Update staging write failed');
              offset += bytesWritten;
            }
            aborted(signal);
            emit({ downloaded, percent: Math.floor(downloaded / metadata.size * 100) });
          }, metadata.size);
          if (hash.digest('hex') !== metadata.sha256.toLowerCase()) throw new Error('Update SHA-256 verification failed');
        });
        await handle.close();
        handle = null;
        const finalPath = path.join(path.dirname(temporary), 'app.asar');
        await fs.rename(temporary, finalPath);
        temporary = null;
        await verifyFile(finalPath, metadata);
        ready = { version: selection.manifest.version, path: finalPath, manifest: clone(selection.manifest) };
        emit({ phase: 'ready', downloaded: metadata.size, total: metadata.size, percent: 100, message: 'Update verified and ready' });
        return clone(ready);
      } catch (error) {
        if (handle) await handle.close().catch(() => {});
        if (temporary) await fs.unlink(temporary).catch(() => {});
        ready = null;
        return failure(error);
      }
    })().finally(() => { downloadPromise = null; });
    return downloadPromise;
  }
  return { check, download, verifyReady, getState: () => ({ ...state }) };
}

module.exports = createUpdater;
module.exports.createUpdater = createUpdater;
module.exports.stableStringify = canonical;
module.exports.verifyManifest = verifyManifest;
