'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { buildManifest } = require('../tools/update-manifest.cjs');
const { verifyFeed } = require('../tools/release-feed.cjs');

for (const scenario of ['signed', 'tampered-input', 'tampered-output']) {
  test(`packager uses verified prebuiltAsar before integrity calculation: ${scenario}`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qmx-package-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const dir of ['electron', 'ui', 'docs', 'tools', 'node_modules/electron', 'release/QMX-Notebook-win32-x64/resources']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    const pkg = { name: 'fixture', version: '8.7.6', main: 'electron/main.cjs', dependencies: {} };
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
    fs.writeFileSync(path.join(root, 'node_modules/electron/package.json'), JSON.stringify({ version: '40.2.1' }));
    fs.writeFileSync(path.join(root, 'docs/USAGE.md'), 'fixture');
    fs.writeFileSync(path.join(root, 'release/QMX-Notebook-win32-x64/resources/app.asar'), 'fixture-archive');
    const keys = crypto.generateKeyPairSync('ed25519');
    buildManifest({ rootDir: root, keyPem: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }), publicKey: keys.publicKey });
    if (scenario === 'tampered-input') fs.appendFileSync(path.join(root, 'resources/app.asar'), 'tamper');
    let calls = 0;
    const module = { exports: {} };
    const source = fs.readFileSync(path.join(__dirname, '../tools/package.cjs'), 'utf8');
    const sandbox = {
      __dirname: path.join(root, 'tools'), module, console: { log() {} },
      process: { platform: 'win32', arch: 'x64', env: {} },
      require(name) {
        if (name === '@electron/packager') return { packager: async options => {
          calls++;
          assert.equal(options.prebuiltAsar, path.join(root, 'resources/app.asar'));
          assert.equal(options.asar, undefined);
          const output = path.join(root, 'release/QMX-Notebook-win32-x64');
          fs.copyFileSync(options.prebuiltAsar, path.join(output, 'resources/app.asar'));
          if (scenario === 'tampered-output') fs.appendFileSync(path.join(output, 'resources/app.asar'), 'tamper');
          return [output];
        } };
        if (name === '../package.json') return pkg;
        if (name === 'electron/package.json') return { version: '40.2.1' };
        if (name === 'electron/checksums.json') return {};
        if (name === './release-feed.cjs') return { verifyFeed: dir => verifyFeed(dir, { publicKey: keys.publicKey }) };
        if (name === 'node:fs') return { ...fs, mkdtempSync: () => fs.mkdtempSync(path.join(root, 'stage-')) };
        return require(name);
      }
    };
    vm.runInNewContext(source, sandbox, { filename: 'package.cjs' });
    if (scenario === 'signed') { await module.exports.main(); assert.equal(calls, 1); }
    else { await assert.rejects(module.exports.main(), /hash mismatch|differs from the signed feed/); assert.equal(calls, scenario === 'tampered-input' ? 0 : 1); }
  });
}
