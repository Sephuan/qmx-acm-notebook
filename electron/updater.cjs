'use strict';

// Electron's patched fs treats .asar files as virtual directories; updates need raw bytes.
const fs = process.versions.electron ? require('original-fs').promises : require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const COMMIT_URL = 'https://api.github.com/repos/qmx-acm-data/qmx-acm-notebook/commits/main';
const RAW_ROOT = 'https://raw.githubusercontent.com/qmx-acm-data/qmx-acm-notebook/';
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
  if (response.redirected || !response.ok) throw new Error(`Update request failed (HTTP ${response.status})`);
}
async function streamResponse(response, limit, signal, consume, expectedSize) {
  if (!response.body?.[Symbol.asyncIterator]) throw new Error('Update response has no readable stream');
  const length = response.headers?.get?.('content-length');
  if (length != null && (!/^\d+$/.test(length) || Number(length) > limit || (expectedSize !== undefined && Number(length) !== expectedSize))) {
    throw new Error('Update Content-Length exceeds limit or does not match expected size');
  }
  let size = 0;
  for await (const value of response.body) {
    if (signal.aborted) throw new Error('Update request timed out');
    const chunk = Buffer.from(value);
    size += chunk.length;
    if (size > limit) throw new Error('Update response exceeds expected size limit');
    await consume(chunk, size);
  }
  if (signal.aborted) throw new Error('Update request timed out');
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

function createUpdater({ currentVersion, downloadDir, fetcher = globalThis.fetch, onProgress = () => {}, timeoutMs = 120000, runtimeVersion = process.versions.electron, publicKey } = {}) {
  const current = versionParts(currentVersion);
  if (!current) throw new Error('currentVersion must be a stable semantic version');
  if (!versionParts(runtimeVersion)) throw new Error('runtimeVersion must be the installed Electron semantic version');
  if (typeof downloadDir !== 'string' || !path.isAbsolute(downloadDir)) throw new Error('downloadDir must be an absolute directory');
  if (typeof fetcher !== 'function') throw new Error('fetcher must be a function');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive');
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
  async function timed(action) {
    const controller = new AbortController();
    let timer;
    const expiry = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Update request timed out'));
      }, timeoutMs);
    });
    try { return await Promise.race([action(controller.signal), expiry]); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  async function request(url, signal) {
    const response = await fetcher(url, { headers: { Accept: 'application/json', 'User-Agent': 'QMX-Notebook-Updater' }, signal, redirect: 'error', credentials: 'omit' });
    if (signal.aborted) throw new Error('Update request timed out');
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
      const selection = await timed(async signal => {
        const commit = await json(COMMIT_URL, signal);
        if (!commit || typeof commit.sha !== 'string' || !/^[a-f0-9]{40}$/.test(commit.sha)) throw new Error('Invalid main commit SHA');
        const root = `${RAW_ROOT}${commit.sha}/`;
        const manifest = await json(`${root}feed/manifest.json`, signal);
        const file = validateManifest(manifest);
        return { manifest, file, url: `${root}resources/app.asar` };
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
        await timed(async signal => {
          const response = await request(selection.url, signal);
          const hash = crypto.createHash('sha256');
          await streamResponse(response, metadata.size, signal, async (chunk, downloaded) => {
            hash.update(chunk);
            await handle.writeFile(chunk);
            if (signal.aborted) throw new Error('Update request timed out');
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
