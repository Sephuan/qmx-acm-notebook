'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const root = path.resolve(__dirname, '..');
const readWorkflow = name => YAML.parse(fs.readFileSync(path.join(root, '.github', 'workflows', name), 'utf8'));

test('release workflow runs manually from main and isolates signing from tag source', () => {
  const workflow = readWorkflow('release.yml');
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.jobs.trust.env.GH_TOKEN, '${{ github.token }}');
  assert.match(workflow.jobs.trust.steps.find(step => step.name?.includes('validated stable tag')).run, /gh auth setup-git/);
  assert.doesNotMatch(workflow.jobs['windows-build'].steps.map(step => JSON.stringify(step)).join('\n'), /secrets\.QMX_UPDATE_SIGNING_KEY_PEM/);

  const signer = workflow.jobs['sign-feed'];
  assert.deepEqual(signer.needs, ['trust', 'windows-build']);
  assert.equal(signer.steps[0].uses, 'actions/checkout@v4');
  assert.equal(signer.steps[0].with.ref, '${{ github.sha }}');
  assert.equal(signer.steps.find(step => step.name?.startsWith('Sign using trusted')).env.QMX_UPDATE_SIGNING_KEY_PEM, '${{ secrets.QMX_UPDATE_SIGNING_KEY_PEM }}');
  const signing = signer.steps.find(step => step.name?.startsWith('Sign using trusted')).run;
  assert.match(signing, /node tools\/update-manifest\.cjs --root-dir signing-root/);
  assert.match(signing, /node tools\/delta-feed\.cjs build --root-dir signing-root --base resources\/app\.asar --base-manifest feed\/manifest\.json/);
  assert.deepEqual(signer.steps.find(step => step.uses === 'actions/upload-artifact@v4').with.path.trim().split('\n'), ['signing-root/feed/manifest.json', 'signing-root/feed/delta.json', 'signing-root/resources/app.asar', 'signing-root/resources/deltas/**']);
});

test('signed feed is injected into every installer and attached for post-release verification', () => {
  const workflow = readWorkflow('release.yml');
  const windowsPackage = workflow.jobs['windows-package'];
  assert.ok(windowsPackage.needs.includes('sign-feed'));
  assert.match(windowsPackage.steps.find(step => step.name?.includes('Verify and install')).run, /delta-feed\.cjs install incoming-signed/);
  assert.match(windowsPackage.steps.find(step => step.name?.includes('Verify and install')).run, /verify incoming-signed/);
  const unix = workflow.jobs.unix.steps.find(step => step.name?.includes('Build platform app'));
  assert.match(unix.run, /delta-feed\.cjs install incoming/);
  assert.match(unix.run, /pnpm dist/);

  const draft = workflow.jobs.draft.steps.find(step => step.name?.includes('Prepare flat release'));
  assert.match(draft.run, /signed-update-feed\/feed\/manifest\.json/);
  assert.match(draft.run, /signed-update-feed\/resources\/app\.asar/);
});

test('published update-channel activation needs GitHub token and never receives signing secret', () => {
  const workflow = readWorkflow('activate-update.yml');
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.jobs.prepare.if, "github.ref == 'refs/heads/main'");
  assert.equal(workflow.jobs.prepare.env.GH_TOKEN, '${{ github.token }}');
  assert.ok(workflow.jobs.prepare.permissions['pull-requests'] === 'write');
  const steps = workflow.jobs.prepare.steps;
  assert.match(steps.find(step => step.name?.includes('Require a published')).run, /gh auth setup-git/);
  assert.match(steps.find(step => step.name?.includes('Verify signature')).run, /--runtime-version manifest/);
  assert.doesNotMatch(JSON.stringify(workflow), /secrets\.QMX_UPDATE_SIGNING_KEY_PEM/);
  assert.equal(workflow.jobs.prepare.permissions.actions, 'write');
  assert.ok(Object.hasOwn(readWorkflow('ci.yml').on, 'workflow_dispatch'));
  const checks = steps.find(step => step.name === 'Run required source checks for the channel branch');
  assert.match(checks.run, /gh workflow run ci\.yml --ref/);
  assert.match(checks.run, /gh run watch .*--exit-status/);
});
