'use strict';
// Run twice with a fresh QMX_AUTH_PROBE_DIR and mode save/restore; never uses real credentials.
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createAuth } = require('../electron/auth.cjs');
const root = process.env.QMX_AUTH_PROBE_DIR;
if (!root || !path.isAbsolute(root)) throw new Error('Explicit isolated probe directory required');
app.setPath('userData', root);
app.whenReady().then(() => {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'auth.json');
  const auth = createAuth({ safeStorage, readAuth: () => JSON.parse(fs.readFileSync(file, 'utf8')), saveAuth: data => fs.writeFileSync(file, JSON.stringify(data)) });
  if (process.env.QMX_AUTH_PROBE_MODE === 'save') {
    auth.commit('FAKE_PROBE_TOKEN_NOT_REAL', { id: 999999, login: 'local-probe' });
    if (fs.readFileSync(file, 'utf8').includes('FAKE_PROBE_TOKEN_NOT_REAL')) throw new Error('Plaintext persisted');
    console.log('PROBE saved encrypted');
  } else {
    auth.restore();
    if (auth.token !== 'FAKE_PROBE_TOKEN_NOT_REAL' || auth.account?.id !== 999999) throw new Error('Restore failed');
    console.log('PROBE restored ' + auth.status.status);
  }
  app.quit();
}).catch(error => { console.error(error.message); app.exit(1); });
