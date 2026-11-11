'use strict';
// Editable curriculum -> validated runtime data. Does not download or fabricate problem records.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
function validate(data, tree, directory) {
  assert.equal(data.schema, 1);
  assert.ok(data.id && data.title);
  assert.ok(Array.isArray(data.stages) && data.stages.length >= 12);
  const topics = new Map(), sourceTopics = new Map();
  function index(node, map) { assert.ok(!map.has(node.id), `Duplicate topic ${node.id}`); map.set(node.id, node); node.children.forEach(child => index(child, map)); }
  index(tree, topics); index(directory.tree, sourceTopics);
  const stages = new Map(), gates = new Map(), gateOrder = new Map();
  for (const [i, stage] of data.stages.entries()) {
    assert.equal(stage.index, i + 1); assert.ok(stage.id && !stages.has(stage.id)); stages.set(stage.id, stage);
    assert.ok(stage.title && stage.description && stage.goal && stage.rationale);
    assert.ok(stage.gates.length >= 12 && stage.gates.length <= 16);
    for (const [j, gate] of stage.gates.entries()) {
      assert.equal(gate.index, j + 1); assert.ok(gate.id && !gates.has(gate.id), `Duplicate gate ${gate.id}`);
      gates.set(gate.id, gate); gateOrder.set(gate.id, gateOrder.size);
    }
  }
  const luogu = new Set(['入门', '普及−', '普及', '普及+/提高−', '提高', '提高+/省选−', '省选/NOI−', 'NOI/NOI+/CTS']);
  const colors = new Set(['basic', 'beginner', 'intermediate', 'advanced', 'expert']);
  const referenced = new Set();
  function range(cf, name) { assert.ok(Number.isInteger(cf?.min) && cf.min >= 0, `Invalid CF range ${name}`); assert.ok(cf.max === null || Number.isInteger(cf.max) && cf.max >= cf.min, `Invalid CF ceiling ${name}`); }
  function tags(value, name) { assert.ok(Array.isArray(value) && value.length > 0 && value.every(tag => luogu.has(tag)), `Invalid Luogu tags ${name}`); }
  for (const stage of data.stages) {
    range(stage.cf, stage.id); tags(stage.luoguDifficulty, stage.id);
    for (const parent of stage.prerequisites?.stageIds || []) assert.ok(stages.has(parent) && stages.get(parent).index < stage.index, `Invalid stage prerequisite ${parent}`);
    for (const gate of stage.gates) {
      assert.ok(['learning', 'mixed', 'challenge'].includes(gate.kind));
      assert.ok(gate.title && gate.description && gate.goals?.length >= 3);
      assert.ok(typeof gate.learningTitle === 'string' && gate.learningTitle.length > 0 && gate.learningTitle.length <= 40, `Missing learning title ${gate.id}`);
      assert.ok(typeof gate.learningDescription === 'string' && gate.learningDescription.length >= 20, `Missing learning narrative ${gate.id}`);
      assert.ok(Array.isArray(gate.threadGateIds) && gate.threadGateIds.length >= 1 && gate.threadGateIds.length <= 3, `Invalid learning thread ${gate.id}`);
      assert.equal(new Set(gate.threadGateIds).size, gate.threadGateIds.length, `Repeated learning thread ${gate.id}`);
      for (const id of gate.threadGateIds) assert.ok(gates.has(id) && id !== gate.id, `Unresolved learning thread ${gate.id}: ${id}`);
      assert.ok(typeof gate.optional === 'boolean');
      assert.ok(Array.isArray(gate.topicIds) && gate.topicIds.length >= 1 && gate.topicIds.length <= 3, `Missing topic links ${gate.id}`);
      assert.equal(new Set(gate.topicIds).size, gate.topicIds.length);
      range(gate.cf, gate.id); tags(gate.luoguDifficulty, gate.id);
      assert.ok(gate.cf.min >= stage.cf.min && (stage.cf.max === null || gate.cf.max !== null && gate.cf.max <= stage.cf.max), `Gate range outside stage ${gate.id}`);
      for (const id of gate.topicIds) {
        const topic = topics.get(id), source = sourceTopics.get(id); assert.ok(topic && source, `Unresolved topic ${id}`);
        assert.equal(topic.kind, 'algorithm', `Directory linked as algorithm ${gate.id}: ${id}`);
        assert.ok(colors.has(topic.color), `Missing knowledge difficulty ${id}`); assert.equal(topic.color, source.color);
        if (topic.color === 'expert') assert.ok(gate.optional && stage.index >= 13, `Expert topic must stay in optional late branch ${gate.id}`);
        referenced.add(id);
      }
      for (const id of gate.prerequisites?.gateIds || []) {
        const before = gates.get(id); assert.ok(before && gateOrder.get(id) < gateOrder.get(gate.id), `Unresolved or cyclic gate prerequisite ${gate.id}: ${id}`);
        if (!gate.optional) assert.ok(!before.optional, `Optional topic blocks mandatory gate ${gate.id}`);
      }
      for (const id of gate.prerequisites?.topicIds || []) assert.ok(topics.get(id)?.kind === 'algorithm', `Invalid topic prerequisite ${id}`);
      assert.equal(gate.problemIds, undefined, 'Real problem bindings must be verified separately');
      assert.equal(gate.knowledgeDifficulty, undefined, 'Knowledge difficulty must come from linked tree');
    }
    assert.equal(stage.gates.at(-1).kind, 'challenge'); assert.ok(stage.gates.filter(gate => gate.kind === 'mixed').length >= 2);
  }
  const summary = { stages: data.stages.length, gates: gates.size, optionalGates: [...gates.values()].filter(gate => gate.optional).length, topicCount: referenced.size };
  assert.deepEqual(data.summary, summary);
  const early = new Set(data.stages.slice(0, 2).flatMap(stage => stage.gates.flatMap(gate => gate.topicIds)));
  for (const id of ['xcpc-vector-1', 'algorithm-string', 'xcpc-pair-1', 'algorithm-常用算法函数与迭代器', 'xcpc-set-1', 'xcpc-map-1', 'algorithm-stack-queue', 'xcpc-priority-queue-1']) assert.ok(early.has(id), `STL missing from early stages ${id}`);
  assert.ok(data.sources.every(source => /^https:\/\//.test(source.url)));
  return summary;
}
function build({ check = false } = {}) {
  const data = JSON.parse(fs.readFileSync(path.join(root, 'data/algorithm-learning-path.json'), 'utf8'));
  const tree = require('../ui/algorithm-tree.js');
  const directory = JSON.parse(fs.readFileSync(path.join(root, 'data/algorithm-directory.json'), 'utf8'));
  const summary = validate(data, tree, directory);
  const output = "'use strict';\n// Generated by tools/build-algorithm-learning-path.cjs from data/algorithm-learning-path.json.\n(function (root, factory) {\n  if (typeof module === 'object' && module.exports) module.exports = factory();\n  else root.QMX_ALGORITHM_LEARNING_PATH = factory();\n})(typeof globalThis !== 'undefined' ? globalThis : this, function () {\n  return " + JSON.stringify(data, null, 2) + ";\n});\n";
  const target = path.join(root, 'ui/algorithm-learning-path-data.js');
  if (check) assert.equal(fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n'), output, 'Runtime learning route differs; run node tools/build-algorithm-learning-path.cjs');
  else fs.writeFileSync(target, output);
  return summary;
}
if (require.main === module) { try { console.log(JSON.stringify(build({ check: process.argv.includes('--check') }))); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { build, validate };
