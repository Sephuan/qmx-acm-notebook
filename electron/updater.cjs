'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const RELEASES_URL = 'https://api.github.com/repos/qmx-acm-data/qmx-acm-notebook/releases?per_page=100';
const DOWNLOAD_PREFIX = 'https://github.com/qmx-acm-data/qmx-acm-notebook/releases/download/';
const MAX_SIZE = 512 * 1024 * 1024;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function versionParts(value, tag = false) {
  if (typeof value !== 'string') return null;
  const version = tag && value.startsWith('v') ? value.slice(1) : value;
  const match = SEMVER.exec(version);
  return match ? { version, parts: match.slice(1).map(BigInt) } : null;
}
function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a.parts[i] !== b.parts[i]) return a.parts[i] > b.parts[i] ? 1 : -1;
  }
  return 0;
}
function validateResponseUrl(response, api = false) {
  // Injected test responses may omit URL; native fetch always supplies the final URL.
  if (response.url === undefined || response.url === '') return;
  const url = new URL(response.url);
  const allowed = api ? ['api.github.com'] : ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'];
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowed.includes(url.hostname)) {
    throw new Error('Unsafe update response URL');
  }
}

function createUpdater({ currentVersion, downloadDir, fetcher = globalThis.fetch, onProgress = () => {}, timeoutMs = 120000 } = {}) {
  const current = versionParts(currentVersion);
  if (!current) throw new Error('currentVersion must be a stable semantic version');
  if (typeof downloadDir !== 'string' || !path.isAbsolute(downloadDir)) throw new Error('downloadDir must be an absolute directory');
  if (typeof fetcher !== 'function') throw new Error('fetcher must be a function');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive');
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
    emit({ phase: 'error', message: error.message || String(error) });
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
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'QMX-Notebook-Updater' };

  function check() {
    if (checkPromise) return checkPromise;
    if (downloadPromise || verifyPromise) return Promise.reject(new Error('Updater is busy'));
    checkPromise = (async () => {
      emit({ phase: 'checking', available: false, latestVersion: null, version: null, releaseUrl: null, message: 'Checking for updates', downloaded: 0, total: 0, percent: 0 });
      selected = null;
      ready = null;
      try {
        const releases = await timed(async signal => {
          const response = await fetcher(RELEASES_URL, { headers: { ...headers }, signal, redirect: 'follow', credentials: 'omit' });
          validateResponseUrl(response, true);
          if (response.status === 404) return [];
          if (!response.ok) throw new Error(`Update check failed (HTTP ${response.status})`);
          const data = await response.json();
          if (!Array.isArray(data)) throw new Error('Invalid GitHub releases response');
          return data;
        });
        const stable = releases.flatMap(release => {
          if (!release || release.draft !== false || release.prerelease !== false || !release.published_at || !Number.isFinite(Date.parse(release.published_at))) return [];
          const parsed = versionParts(release.tag_name, true);
          return parsed ? [{ release, parsed }] : [];
        }).sort((a, b) => compare(b.parsed, a.parsed));
        const latest = stable[0];
        if (!latest || compare(latest.parsed, current) <= 0) {
          return emit({ phase: 'idle', available: false, latestVersion: latest?.parsed.version || null, version: latest?.parsed.version || null, releaseUrl: latest ? `https://github.com/qmx-acm-data/qmx-acm-notebook/releases/tag/${encodeURIComponent(latest.release.tag_name)}` : null, message: 'Already up to date' });
        }
        const { release, parsed } = latest;
        const version = parsed.version;
        emit({ available: true, latestVersion: version, version, releaseUrl: `https://github.com/qmx-acm-data/qmx-acm-notebook/releases/tag/${encodeURIComponent(release.tag_name)}` });
        const filename = `QMX-Notebook-Setup-${version}.exe`;
        const assets = Array.isArray(release.assets) ? release.assets.filter(asset => asset?.name === filename && asset.state === 'uploaded') : [];
        if (assets.length !== 1) throw new Error(`Release ${version} has no unique uploaded Windows installer (${filename})`);
        const asset = assets[0];
        const expectedUrl = `${DOWNLOAD_PREFIX}${encodeURIComponent(release.tag_name)}/${filename}`;
        if (asset.browser_download_url !== expectedUrl) throw new Error(`Release ${version} has an unsafe installer URL`);
        if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_SIZE) throw new Error(`Release ${version} has an invalid installer size`);
        if (typeof asset.digest !== 'string' || !/^sha256:[a-fA-F0-9]{64}$/.test(asset.digest)) throw new Error(`Release ${version} is missing a valid SHA-256 digest`);
        selected = Object.freeze({ version, filename, url: expectedUrl, size: asset.size, digest: asset.digest.slice(7).toLowerCase() });
        return emit({ phase: 'available', total: asset.size, message: `Version ${version} is available` });
      } catch (error) { return failure(error); }
    })().finally(() => { checkPromise = null; });
    return checkPromise;
  }

  async function verifyFile(file, metadata) {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== metadata.size) throw new Error('Installer size or file type verification failed');
    const handle = await fs.open(file, 'r');
    try {
      const hash = crypto.createHash('sha256');
      let size = 0;
      let magic = Buffer.alloc(0);
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        size += chunk.length;
        if (size > metadata.size) throw new Error('Installer size verification failed');
        if (magic.length < 2) magic = Buffer.concat([magic, chunk]).subarray(0, 2);
        hash.update(chunk);
      }
      if (size !== metadata.size || hash.digest('hex') !== metadata.digest || magic.toString('ascii') !== 'MZ') throw new Error('Installer SHA-256, size, or MZ header verification failed');
    } finally { await handle.close(); }
  }

  function verifyReady() {
    if (verifyPromise) return verifyPromise;
    if (downloadPromise || checkPromise) return Promise.reject(new Error('Updater is busy'));
    verifyPromise = (async () => {
      try {
        if (!ready || !selected) throw new Error('No verified installer is ready');
        await verifyFile(ready.path, selected);
        emit({ phase: 'ready', message: 'Installer verified and ready' });
        return { ...ready };
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
        else if (!selected) {
          // download owns the busy flag, so invoke check before it is visible.
          await check();
        }
        if (!selected) throw new Error('No newer installer is available');
        const metadata = selected;
        await fs.mkdir(downloadDir, { recursive: true });
        const ownDir = await fs.mkdtemp(path.join(downloadDir, 'qmx-update-'));
        temporary = path.join(ownDir, `${metadata.filename}.part`);
        handle = await fs.open(temporary, 'wx', 0o600);
        emit({ phase: 'downloading', version: metadata.version, downloaded: 0, total: metadata.size, percent: 0, message: 'Downloading installer' });
        await timed(async signal => {
          const response = await fetcher(metadata.url, { headers: { 'User-Agent': headers['User-Agent'] }, signal, redirect: 'follow', credentials: 'omit' });
          validateResponseUrl(response);
          if (!response.ok) throw new Error(`Installer download failed (HTTP ${response.status})`);
          if (!response.body || !response.body[Symbol.asyncIterator]) throw new Error('Installer response has no readable stream');
          const length = response.headers?.get?.('content-length');
          if (length !== null && length !== undefined && (!/^\d+$/.test(length) || Number(length) !== metadata.size)) throw new Error('Installer Content-Length does not match release size');
          const hash = crypto.createHash('sha256');
          let downloaded = 0;
          let magic = Buffer.alloc(0);
          for await (const value of response.body) {
            if (signal.aborted) throw new Error('Update request timed out');
            const chunk = Buffer.from(value);
            downloaded += chunk.length;
            if (downloaded > metadata.size || downloaded > MAX_SIZE) throw new Error('Installer exceeds expected size');
            if (magic.length < 2) magic = Buffer.concat([magic, chunk]).subarray(0, 2);
            hash.update(chunk);
            await handle.writeFile(chunk);
            emit({ downloaded, percent: Math.floor(downloaded / metadata.size * 100) });
          }
          if (signal.aborted) throw new Error('Update request timed out');
          if (downloaded !== metadata.size) throw new Error('Installer size verification failed');
          if (hash.digest('hex') !== metadata.digest) throw new Error('Installer SHA-256 verification failed');
          if (magic.toString('ascii') !== 'MZ') throw new Error('Installer MZ header verification failed');
        });
        await handle.close();
        handle = null;
        const finalPath = path.join(path.dirname(temporary), metadata.filename);
        await fs.rename(temporary, finalPath);
        temporary = null;
        ready = { version: metadata.version, path: finalPath };
        emit({ phase: 'ready', downloaded: metadata.size, total: metadata.size, percent: 100, message: 'Installer verified and ready' });
        return { ...ready };
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
