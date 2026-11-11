'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const api=require('../ui/algorithm-directory.js'),base=require('../ui/algorithm-tree.js');
test('algorithm query normalization preserves symbols and ranks exact aliases over paths',()=>{
 const node={label:'后缀自动机',fullLabel:'后缀自动机（SAM）',aliases:['SAM']};
 assert.ok(api.topicScore(node,['字符串','后缀结构'],'ＳＡＭ'));
 assert.ok(api.topicScore(node,[],'sam')>api.topicScore({label:'其他'},['SAM','其他'],'sam'));
 assert.ok(api.topicScore({label:'Miller–Rabin'},[],'miller rabin'));
 assert.equal(api.topicScore({label:'A* 搜索'},[],'IDA*'),0);
 assert.ok(api.topicScore({label:'IDA* 搜索'},[],'ida*'));
 assert.equal(api.topicScore(node,[],'SAM 最短路'),0);
 assert.ok(api.noteScore({title:'后缀自动机学习',body:'状态的 endpos 集合',tags:['字符串']},node,[],'SAM endpos','alice'));
});
test('empty directories have no difficulty and synthetic children accept nested records in any order',()=>{
 const base={id:'root',label:'目录',kind:'directory',color:'parent',children:[]};
 const tree=api.hydrate(base,[{id:'deep',parentId:'algorithm-content-added',label:'变体',color:'expert'},
 {id:'branch',parentId:'added',label:'扩展',kind:'directory',color:'parent'},
 {id:'added',parentId:'root',label:'算法',color:'beginner'},
 {id:'empty',parentId:'root',label:'空目录',kind:'directory',color:'parent'}]);
 const nodes=[];(function w(n){nodes.push(n);n.children.forEach(w)})(tree);
 const byId=new Map(nodes.map(n=>[n.id,n]));
 assert.equal(byId.get('empty').color,'parent');assert.equal(byId.get('empty').rating.range,undefined);
 assert.equal(byId.get('added').kind,'directory');assert.equal(byId.get('algorithm-content-added').kind,'directory');
 assert.equal(byId.get('algorithm-content-algorithm-content-added').color,'beginner');
 assert.equal(byId.get('algorithm-content-added').children[1].id,'deep');
 assert.equal(base.children.length,0);
});
test('custom topics merge into builtin or custom branches without mutating source',()=>{
 const topics=[{id:'child',parentId:'added',label:'子算法',fullLabel:'子算法完整名称',color:'expert'},
 {id:'added',parentId:'xcpc-动态规划-1',label:'新算法',fullLabel:'新算法完整名称',color:'advanced'}];
 const tree=api.hydrate(base,topics),nodes=[];(function w(n){nodes.push(n);n.children.forEach(w)})(tree);
 const added=nodes.find(n=>n.id==='added');assert.equal(added.children[0].id,'algorithm-content-added');
 assert.equal(added.children[1].id,'child');assert.equal(added.kind,'directory');assert.equal(added.color,'parent');
 assert.equal(added.rating.status,'not-applicable');assert.equal(added.rating.range,undefined);
 assert.ok(added.aliases.includes('新算法完整名称'));assert.equal(nodes.length,base.metadata.summary.nodes+3);
 assert.equal(added.children[0].color,'advanced');assert.equal(added.children[1].color,'expert');assert.equal(base.children.flatMap(n=>n.children).some(n=>n.id==='added'),false);
});
