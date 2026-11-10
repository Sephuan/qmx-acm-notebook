'use strict';
const crypto = require('node:crypto');
const LIMIT = 256 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
function exact(v, keys) { return v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === keys.slice().sort().join(','); }
function size(v) { return Number.isSafeInteger(v) && v > 0 && v <= LIMIT; }
function verifyDeltaManifest(manifest, { publicKey, runtimeVersion, targetVersion, targetFile } = {}) {
  if (!exact(manifest, ['schema', 'version', 'runtimeVersion', 'target', 'patches', 'publishedAt', 'signature']) || manifest.schema !== 1 || !VERSION.test(manifest.version) || !VERSION.test(manifest.runtimeVersion) || typeof manifest.publishedAt !== 'string' || !Number.isFinite(Date.parse(manifest.publishedAt))) throw new Error('Invalid delta manifest');
  if (!exact(manifest.target, ['size', 'sha256']) || !size(manifest.target.size) || !HASH.test(manifest.target.sha256)) throw new Error('Invalid delta target');
  if (manifest.runtimeVersion !== runtimeVersion || manifest.version !== targetVersion || manifest.target.size !== targetFile?.size || manifest.target.sha256 !== targetFile?.sha256?.toLowerCase()) throw new Error('Delta target differs from signed application manifest');
  if (!Array.isArray(manifest.patches) || manifest.patches.length > 2) throw new Error('Invalid delta patch list');
  const bases = new Set();
  for (const p of manifest.patches) {
    if (!exact(p, ['fromVersion', 'fromSize', 'fromSha256', 'path', 'size', 'sha256', 'algorithm']) || typeof p.fromVersion !== 'string' || !VERSION.test(p.fromVersion) || !size(p.fromSize) || typeof p.fromSha256 !== 'string' || !HASH.test(p.fromSha256) || typeof p.sha256 !== 'string' || !HASH.test(p.sha256) || !size(p.size) || p.size >= manifest.target.size * 0.9 || p.algorithm !== 'qmx-cdc-brotli-v1' || p.path !== `resources/deltas/${p.fromSha256}.qmxdelta` || bases.has(p.fromSha256)) throw new Error('Invalid delta patch metadata');
    const a = p.fromVersion.split('.').map(BigInt), b = manifest.version.split('.').map(BigInt);
    const order = a.reduce((r, n, i) => r || (n < b[i] ? -1 : n > b[i] ? 1 : 0), 0);
    if (order >= 0) throw new Error('Delta base must precede target');
    bases.add(p.fromSha256);
  }
  if (typeof manifest.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(manifest.signature)) throw new Error('Invalid delta signature');
  const sig = Buffer.from(manifest.signature, 'base64');
  const configured = publicKey === undefined ? require('./update-key.cjs') : publicKey;
  const key = configured?.type === 'public' ? configured : crypto.createPublicKey(configured);
  const unsigned = Object.fromEntries(Object.entries(manifest).filter(([k]) => k !== 'signature'));
  if (sig.toString('base64') !== manifest.signature || key.asymmetricKeyType !== 'ed25519' || !crypto.verify(null, Buffer.from(canonical(unsigned)), key, sig)) throw new Error('Delta manifest signature verification failed');
  return manifest.patches;
}
module.exports = { verifyDeltaManifest, canonical };
