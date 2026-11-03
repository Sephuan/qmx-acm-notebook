'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function buildManifest({ keyPath = process.env.QMX_UPDATE_SIGNING_KEY, notes = process.env.QMX_UPDATE_NOTES || '' } = {}) {
  if (!keyPath) throw new Error('Set QMX_UPDATE_SIGNING_KEY to a private Ed25519 PEM outside the repository');
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
  const publicKey = require('../electron/update-key.cjs');
  if (crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) !== publicKey) throw new Error('Signing key does not match pinned application key');
  const bytes = fs.readFileSync(path.join(root, 'release/QMX-Notebook-win32-x64/resources/app.asar'));
  const manifest = { schema: 1, version: require('../package.json').version, runtimeVersion: require('electron/package.json').version, base: '../', notes, publishedAt: new Date().toISOString(), files: [{ path: 'resources/app.asar', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }] };
  manifest.signature = crypto.sign(null, Buffer.from(canonical(manifest)), privateKey).toString('base64');
  const feed = path.join(root, 'feed');
  fs.mkdirSync(feed, { recursive: true });
  fs.mkdirSync(path.join(root, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(root, 'resources/app.asar'), bytes);
  fs.writeFileSync(path.join(feed, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Signed update feed ${manifest.version}: ${bytes.length} bytes, SHA-256 ${manifest.files[0].sha256}`);
  return manifest;
}
if (require.main === module) buildManifest();
module.exports = { buildManifest, canonical };
