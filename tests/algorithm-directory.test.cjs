'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const data=require('../data/algorithm-directory.json');
const outline=require('../docs/algorithm-research/feishu-outline.json');
const evidence=require('../docs/algorithm-research/difficulty-evidence.json');
const sources=require('../docs/algorithm-research/sources.json');
const {build}=require('../tools/build-algorithm-directory.cjs');
const {buildDirectoryDocument,renderDirectoryDocument,renderDifficultyAppendix,renderCategoryNames}=require('../tools/render-algorithm-directory.cjs');
const nodes=[],parents=new Map();(function walk(n,parent){nodes.push(n);if(parent)parents.set(n.id,parent);n.children.forEach(c=>walk(c,n));})(data.tree);
const byId=new Map(nodes.flatMap(n=>[n.id,...(n.legacyIds||[])].map(id=>[id,n])));
const isDirectory=n=>n.kind==='directory'||n.kind==='category';
const graded=nodes.filter(n=>!isDirectory(n));
const named=name=>[...graded,...nodes.filter(isDirectory)].find(n=>[n.label,...(n.aliases||[])].some(label=>label.toLowerCase()===name.toLowerCase()));
const originalParent=n=>parents.get(n.contentOf||n.id);

test('all original source headings remain traceable independently of current topic hierarchy',()=>{
 assert.equal(outline.headings.length,126);
 assert.deepEqual(nodes.filter(n=>n.sourceHeading).map(n=>n.sourceHeading).sort(),outline.headings.map(n=>n.sourceHeading).sort());
 assert.equal(data.sourceIndex.length,126);
 for(const entry of data.sourceIndex){
  const node=byId.get(entry.nodeId);assert.ok(node);
  assert.equal(node.sourceHeading,entry.sourceHeading);assert.equal(node.part,entry.part);
  const path=[];let current=node;while(current&&current!==data.tree){path.unshift(current.label);current=parents.get(current.id);}
  assert.equal(entry.currentPath,path.join(' / '));
 }
 assert.deepEqual(data.tree.children.map(n=>n.part),['0','1','2','3','4','5','6','7','8','9','10']);
});

test('all historic notebook node identifiers resolve without collisions',()=>{
 assert.equal(Object.keys(data.legacyNodeMap).length,367);
 assert.equal(new Set(nodes.map(n=>n.id)).size,nodes.length);
 for(const[oldId,target]of Object.entries(data.legacyNodeMap))assert.equal(byId.get(oldId)?.id,target,oldId);
 assert.equal(byId.get('xcpc-动态规划-1').part,'3');
 assert.equal(byId.get('xcpc-dancing-links-1').part,'2.8');
 assert.equal(byId.get('xcpc-dsu-on-tree-1').id,byId.get('xcpc-树的启发式合并-1').id);
});

test('explicit color-document grades take precedence over previous transcription',()=>{
 const expected={
  '函数':'basic','模拟':'basic','贪心':'beginner','二分':'beginner','高精度':'beginner',
  '单调栈':'beginner','单调队列':'beginner','点积':'beginner','叉积':'beginner','极角序':'beginner',
  '01背包':'beginner','完全背包':'beginner','Manacher':'intermediate','后缀数组':'intermediate',
  '后缀自动机':'expert','回文自动机':'expert','prufer序列':'expert','Burnside引理':'expert','Polya定理':'expert',
  '快速沃尔什变换（FWT）':'expert','Lyndon 分解':'expert','支配树':'expert','点分治':'advanced','边分治':'advanced',
  'Picks定理':'intermediate','带修莫队':'intermediate','树形 DP（换根）':'intermediate',
  'FFT/NTT':'advanced','Pollard Rho':'advanced','最小圆覆盖':'advanced','Voronoi图':'advanced'
 };
 for(const[name,level]of Object.entries(expected)){const n=named(name);assert.ok(n,name);assert.equal(n.color,level,name);assert.equal(n.difficultySource.kind,'user-md',name);}
});

test('ungraded templates and low-frequency topics receive separate reviewed difficulty',()=>{
 for(const[name,level]of Object.entries({'快读快写':'basic','Miller Rabin':'advanced','虚树':'advanced','DLX':'advanced','后缀平衡树':'advanced','最小表示法':'intermediate','树上莫队':'advanced','回滚莫队':'advanced','拟阵':'expert','AVL':'advanced','红黑树':'advanced','可撤销并查集':'intermediate'})){
  const n=named(name);assert.equal(n.color,level,name);assert.equal(n.difficultySource.kind,'research',name);
 }
 for(const n of nodes){
  assert.ok(['parent','basic','beginner','intermediate','advanced','expert'].includes(n.color),n.label);
  if(!n.children.length&&!['directory','reference'].includes(n.kind))assert.notEqual(n.color,'parent',n.label);
 }
 assert.ok(named('Miller Rabin').attributes.includes('board'));
 assert.ok(named('最小表示法').attributes.includes('useless'));
 assert.ok(named('dijkstra').attributes.includes('board')&&named('dijkstra').attributes.includes('useful'));
});

test('every inferred rating has multiple traceable references and honest confidence',()=>{
 const catalog=new Set(sources.sources.map(s=>s.url));
 const evaluated=nodes.filter(n=>n.difficultySource?.kind==='research');
 assert.equal(evidence.entries.length,nodes.length);
 for(const n of evaluated){
  const e=evidence.entries.find(e=>e.nodeId===n.id);assert.ok(e,n.label);assert.equal(e.level,n.color);
  assert.ok(e.sourceUrls.length>=2,n.label);assert.ok(e.sourceUrls.every(u=>catalog.has(u)),n.label);
  assert.ok(['medium','low'].includes(e.confidence),n.label);assert.ok(n.rationale.length>15,n.label);
 }
});

test('every original color-document algorithm row has a current topic mapping',()=>{
 const coverage=require('../docs/algorithm-research/color-md-coverage.json');
 assert.equal(coverage.rows.length,99);
 for(const row of coverage.rows)for(const topic of row.nodes){assert.equal(byId.get(topic.id)?.label,topic.label,row.sourceText);assert.equal(byId.get(topic.id)?.color,topic.difficulty,row.sourceText);}
 assert.equal(named('迭代基础').color,'basic');assert.equal(named('期望 DP').color,'intermediate');
});

test('reviewed hierarchy and provenance fixes remain correct',()=>{
 assert.equal(originalParent(named('Kosaraju 算法')).label,'强连通分量');
 assert.equal(named('Kosaraju 算法').color,'intermediate');
 assert.equal(originalParent(named('斐波那契堆')).part,'6.11');
 assert.equal(originalParent(named('floyd')).part,'7.2');
 assert.equal(originalParent(named('类欧几里得')).part,'5.2');
 assert.equal(originalParent(named('单调栈优化')).part,'3.7');
 assert.equal(originalParent(named('边分治')).label,'树上分治');
 assert.equal(named('条件概率').color,'beginner');
 assert.equal(named('最短路径树').color,'intermediate');
 assert.equal(named('最小公倍数（LCM）').difficultySource.kind,'user-md');
 const lazy=named('区间修改 / 区间查询（懒标记）');
 assert.equal(lazy.color,'intermediate');assert.equal(lazy.difficultySource.kind,'research');
 assert.equal(named('子集变换（FMT / SOS DP）').color,'intermediate');
 assert.equal(named('快速沃尔什变换（FWT）').color,'expert');
 assert.equal(byId.get('xcpc-基础-6').id,byId.get('xcpc-基础-7').id);
 assert.equal(byId.get('algorithm-欧拉函数').part,'5.2.3');
 assert.equal(nodes.filter(n=>n.kind==='reference').length,0);
 assert.equal(byId.get('xcpc-o-n-3-1').color,'intermediate');
 assert.equal(byId.get('xcpc-o-n-2-1').color,'advanced');
 for(const n of nodes){const labels=n.children.map(c=>c.label);assert.equal(new Set(labels).size,labels.length,`duplicate child under ${n.label}`);}
});

test('optimized Markdown has complete navigation and a traceable separate appendix',()=>{
 const main=renderDirectoryDocument(data),appendix=renderDifficultyAppendix(data);
 for(let i=0;i<10;i++){assert.ok(main.includes(`id="part-${i}"`));assert.ok(main.includes(`](#part-${i})`));}
 const titles=renderCategoryNames(data);
 for(const n of nodes.filter(n=>n.sourceHeading)){
  assert.ok(main.includes(n.label),n.label);
  assert.ok(titles.includes(n.sourceHeading),n.sourceHeading);
 }
 assert.ok(main.includes('〔定稿〕'));assert.ok(main.includes('〔目录〕'));assert.ok(!main.includes('〔分类门槛〕'));assert.ok(!main.includes('〔待补模型〕'));assert.ok(!main.includes('待复核'));assert.ok(main.includes('整数溢出'));assert.ok(named('__int128 与整数溢出').aliases.includes('__int128 与整数溢出'));
 assert.ok(main.includes('difficulty-assessment.md'));
 for(const n of nodes.filter(n=>n.difficultySource?.kind==='research'))assert.ok(appendix.replaceAll('`','').includes(n.label),n.label);
 const mainAnchors=[...main.matchAll(/id="([^"]+)"/g)].map(m=>m[1]);
 assert.equal(new Set(mainAnchors).size,mainAnchors.length,'unique stable topic anchors');
 for(const m of main.matchAll(/\]\(#((?:topic|part)-[^)]+)\)/g))assert.ok(mainAnchors.includes(m[1]),m[1]);
 assert.ok(!/Part \d+\.\d+/.test(main),'source numbering must not masquerade as current hierarchy');
 const anchors=new Set([...appendix.matchAll(/id="([^"]+)"/g)].map(m=>m[1]));
 for(const m of appendix.matchAll(/\]\(#(source-[^)]+)\)/g))assert.ok(anchors.has(m[1]),m[1]);
});

test('category display titles retain searchable old names and original source headings',()=>{
 const report=renderCategoryNames(data);
 for(const change of data.editorial.categoryRenames){
  const node=byId.get(change.nodeId);
  assert.ok(node.label===change.after||(node.aliases||[]).includes(change.after)||(node.aliases||[]).includes(change.nodeId)||(node.legacyIds||[]).includes(change.nodeId));
  assert.ok(node.label===change.before||(node.aliases||[]).includes(change.before)||(node.legacyIds||[]).includes(change.nodeId),change.before);
  assert.ok(report.includes(change.before));
  if(change.sourceHeading)assert.equal(node.sourceHeading,change.sourceHeading);
 }
 assert.equal(byId.get('feishu-part-0').label,'C++ 与工具');
 assert.equal(byId.get('feishu-part-9').label,'离线与杂项');
 assert.equal(byId.get('feishu-part-9-4').label,'待分类专题');
});

test('knowledge groups remove duplicated layers and keep cross-topic algorithms discoverable',()=>{
 const hasAncestor=(nodeId,ancestorId)=>{let n=byId.get(nodeId);while(n){if(n.id===ancestorId)return true;n=parents.get(n.id);}return false;};
 assert.ok(hasAncestor('feishu-part-6-1','feishu-part-0'));
 assert.ok(hasAncestor('feishu-part-6-14','feishu-part-7-3'));
 assert.ok(hasAncestor('feishu-part-6-16','feishu-part-7-3'));
 assert.ok(hasAncestor('feishu-part-7-11','xcpc-树上分治-1'));
 assert.ok(hasAncestor('feishu-part-6-12','feishu-part-6-17'));
 assert.ok(hasAncestor('algorithm-点双连通分量','xcpc-点-边-双连通分量-1'));
 assert.ok(hasAncestor('xcpc-状态-1','group-dp-principles'));
 assert.ok(hasAncestor('xcpc-概率dp-1','group-dp-count-probability'));
 assert.ok(hasAncestor('feishu-part-3-9','group-dp-optimizations'));
 assert.equal(originalParent(named('Dinic')).part,'7.9.1');
 assert.equal(originalParent(named('AVL')).part,'6.13');
 assert.equal(originalParent(named('卡特兰数')).part,'5.6.2');
 assert.equal(data.tree.children.find(n=>n.part==='8').children[0].id,'group-geometry-foundations');
 for(const node of nodes.filter(n=>n.origin==='editorial'&&isDirectory(n))){assert.equal(node.rating.type,'directory');assert.ok(node.children.length>0,node.label);}
});

test('only concrete algorithms have finalized scope-specific ratings',()=>{
 const levels=['basic','beginner','intermediate','advanced','expert'];
 assert.equal(data.summary.graded,graded.length);assert.equal(data.summary.confirmed,graded.length);
 assert.equal(nodes.length,578);assert.equal(graded.length,386);assert.equal(nodes.filter(isDirectory).length,192);
 for(const n of nodes){
  assert.ok(n.scope.length>=8,n.label);assert.ok(n.rationale.length>15,n.label);
  if(isDirectory(n)){
   assert.equal(n.color,'parent');assert.equal(n.rating.status,'not-applicable');assert.equal(n.rating.type,'directory');assert.equal(n.rating.range,undefined);
  }else{
   assert.ok(levels.includes(n.color),n.label);assert.equal(n.rating.status,'confirmed');
   const values=[];(function walk(x){if(!isDirectory(x))values.push(levels.indexOf(x.color)+1);x.children.forEach(walk)})(n);
   assert.deepEqual(n.rating.range,{min:Math.min(...values),max:Math.max(...values)},n.label);
  }
  const record=evidence.entries.find(e=>e.nodeId===n.id);assert.ok(record);assert.equal(record.level,n.color);assert.equal(record.status,n.rating.status);
 }
 assert.equal(Object.values(data.summary.difficultyHistogram).reduce((a,b)=>a+b,0),graded.length);
 assert.equal(data.summary.userGraded,181);assert.equal(data.summary.researchGraded,205);
});

test('all 473 original nodes and notes retain identity, position and original algorithm payloads',()=>{
 const {createHash}=require('node:crypto');
 const revision=data.editorial.directorySeparation;assert.equal(revision.originalNodesSnapshot.length,473);assert.equal(revision.contentMoves.length,104);
 for(const old of revision.originalNodesSnapshot){
  const n=byId.get(old.id);assert.ok(n,old.id);assert.equal(n.label,old.label);assert.equal(parents.get(n.id)?.id||null,old.parentId);
  assert.deepEqual(n.children.filter(c=>!c.contentOf && c.id!=='directory-contest-experience').map(c=>c.id),old.childIds);
  if(old.kind==='algorithm')assert.equal(createHash('sha256').update(JSON.stringify(n)).digest('hex'),old.sha256,n.label);
  else{
   assert.equal(n.kind,'directory');
   const child=n.children.find(c=>c.contentOf===n.id);
   if(['knowledge','model'].includes(old.ratingType)){
    assert.ok(child);assert.equal(child.id,'algorithm-content-'+n.id);assert.equal(child.label,n.label);assert.equal(child.color,old.color);assert.deepEqual(child.children,[]);
    for(const key of ['legacyIds','sourceHeading','part','sourceBlockId'])assert.equal(child[key],undefined);
    const change=data.editorial.titleSimplification.changes.find(c=>c.nodeId===n.id);assert.equal(child.fullLabel,change?.before||n.label);
   }else assert.equal(child,undefined,'category/entry must not invent algorithm content');
  }
 }
});

test('simplified titles retain exact old-name aliases without changing topic identity',()=>{
 const revision=data.editorial.titleSimplification;
 assert.equal(revision.reviewed,473);
 assert.equal(revision.changed,revision.changes.length);
 for(const change of revision.changes){
  const node=byId.get(change.nodeId);assert.equal(node.label,change.after);
  assert.ok(node.aliases.includes(change.before),change.before);
 }
 assert.equal(named('迭代加深启发式搜索（IDA*）').label,'IDA* 搜索');
 assert.equal(named('可持久化权值线段树（主席树）').label,'主席树');
});

test('generated runtime and readable directory match the editable source',()=>{
 assert.equal(build({check:true}).nodes,nodes.length);buildDirectoryDocument({check:true});
});
