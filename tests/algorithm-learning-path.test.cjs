'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const data=require('../data/algorithm-learning-path.json'),directory=require('../data/algorithm-directory.json'),tree=require('../ui/algorithm-tree.js'),{validate}=require('../tools/build-algorithm-learning-path.cjs');
test('orientation precedes stable chapters without altering existing gate identities',()=>{
 assert.deepEqual(data.stages.map(s=>s.index),Array.from({length:15},(_,i)=>i));
 const zero=data.stages[0];assert.equal(zero.id,'stage-00');assert.equal(zero.type,'orientation');assert.equal(zero.gates.length,1);assert.equal(zero.gates[0].title,'总览算法竞赛');assert.equal(zero.cf,undefined);assert.deepEqual(zero.gates[0].topicIds,['directory-contest-experience']);
 for(const stage of data.stages.slice(1)){assert.equal(stage.id,`stage-${String(stage.index).padStart(2,'0')}`);assert.equal(stage.gates.length,12);for(const g of stage.gates)assert.equal(g.id,`${stage.id}-gate-${String(g.index).padStart(2,'0')}`);}
 const node=tree.children.find(n=>n.id==='directory-contest-experience');assert.equal(node.label,'算法竞赛经验与游记');assert.equal(node.kind,'directory');assert.equal(node.color,'parent');assert.equal(node.rating.status,'not-applicable');
 assert.deepEqual(validate(data,tree,directory),{stages:15,gates:169,optionalGates:10,topicCount:154});
});
test('orientation exception does not permit ordinary chapters to lose challenge and algorithm requirements',()=>{
 const missing=structuredClone(data);delete missing.stages[1].cf;assert.throws(()=>validate(missing,tree,directory),/Invalid CF range/);
 const badTopic=structuredClone(data);badTopic.stages[1].gates[0].topicIds=['directory-contest-experience'];assert.throws(()=>validate(badTopic,tree,directory),/Directory linked as algorithm/);
 const changed=structuredClone(data);changed.stages[1].index=2;assert.throws(()=>validate(changed,tree,directory));
});
