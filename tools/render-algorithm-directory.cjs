'use strict';

// Editable directory data drives both the application-facing guide and the audit appendix.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const mainRelativePath = 'docs/XCPC算法目录_飞书结构与难度整合.md';
const appendixRelativePath = 'docs/algorithm-research/difficulty-assessment.md';
const categoryNamesRelativePath = 'docs/XCPC算法目录_分类标题优化对照.md';
const structureReportRelativePath = 'docs/XCPC算法目录_结构优化说明.md';
const difficulties = {
  basic: 'D1 · 入门',
  beginner: 'D2 · 初级',
  intermediate: 'D3 · 中级',
  advanced: 'D4 · 高级',
  expert: 'D5 · 挑战'
};

function indexDirectory(data) {
  const entries = [];
  const byId = new Map();
  function visit(node, ancestors = [], part = null) {
    // The current tree owns classification; historical source numbers do not determine ancestry.
    const topPart = ancestors.length === 1 ? node : part;
    const entry = { node, ancestors, topPart };
    entries.push(entry);
    byId.set(node.id, entry);
    for (const oldId of node.legacyIds || []) byId.set(oldId, entry);
    for (const child of node.children || []) visit(child, [...ancestors, node], topPart);
  }
  visit(data.tree);
  return { entries, byId };
}

function text(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function code(value) {
  const content = String(value).replace(/`/g, '');
  return `\`${content}\``;
}

function topicName(node) {
  const label = String(node.label || '未命名节点');
  if (/^O\(.+\)$/.test(label)) return code(label);
  return text(label).replace(/\b_*[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*\b|__\w+/g, token => code(token));
}

function sourceTitle(node) {
  // Only the ten current modules display Part numbers. Nested source numbers remain provenance.
  const topLevel = typeof node.part === 'string' && !node.part.includes('.');
  return `${topLevel ? `Part ${node.part} ` : ''}${topicName(node)}`;
}

function grade(node) {
  return difficulties[node.color] || '目录';
}

function isDirectory(node) { return ['directory', 'category'].includes(node.kind); }

function isResearch(node) {
  return !isDirectory(node) && node.difficultySource?.kind === 'research';
}

function needsReview(node) {
  return node.difficultyConfidence === 'low' || node.evidenceScope === 'category-and-prerequisites';
}

function provenanceMark(node) {
  if (node.difficultySource?.kind === 'user-md') return '〔原〕';
  if (isDirectory(node)) return '〔目录〕';
  return node.rating?.status === 'confirmed' ? '〔定稿〕' : '〔评〕';
}

function rangeLabel(node) {
  const range = node.rating?.range;
  return range ? `D${range.min}–D${range.max}` : grade(node);
}

function partAnchor(part) {
  return `part-${String(part).split('.')[0]}`;
}

function partLink(node) {
  return `#${partAnchor(node.part || '0')}`;
}

function topicAnchor(node) {
  return `topic-${createHash('sha256').update(node.id, 'utf8').digest('hex').slice(0, 12)}`;
}

function nodeLink(entry) {
  return `#${entry.topPart === entry.node ? partAnchor(entry.node.part) : topicAnchor(entry.node)}`;
}

function referenceTo(id, byId) {
  const entry = byId.get(id);
  if (!entry) return code(id);
  return `[${topicName(entry.node)}](${nodeLink(entry)})`;
}

function currentPath(entry, rootNode) {
  return [...entry.ancestors, entry.node].filter(node => node !== rootNode).map(topicName).join(' → ');
}

function listOfStrings(value) {
  return (Array.isArray(value) ? value : value ? [value] : []).filter(item => typeof item === 'string' && item.trim());
}

function supplementalDetails(node, byId) {
  const details = [];
  if (node.scope) details.push(`范围：${listOfStrings(node.scope).map(text).join('；')}`);
  const prerequisites = listOfStrings(node.prerequisites);
  if (prerequisites.length) details.push(`先修：${prerequisites.map(item => byId.has(item) ? referenceTo(item, byId) : text(item)).join(' → ')}`);
  const crossRefs = listOfStrings(node.crossRefs);
  if (crossRefs.length) details.push(`参见：${crossRefs.map(id => referenceTo(id, byId)).join('、')}`);
  return details;
}

function sourceDate(data) {
  return data.sources?.research?.date || data.sources?.feishu?.snapshot || '见来源快照';
}

function renderLearningPlan(rows) {
  rows.push(
    '## 学习安排',
    '',
    '每阶段先理解原理，再独立实现，最后通过有变化的题目检验迁移能力；完成标准比固定刷题数量更有用。',
    '',
    '| 阶段 | 学习范围 | 完成标准 |',
    '| --- | --- | --- |',
    '| ① 建立基础 | C++ 与工具；基础算法；DFS、BFS、回溯与剪枝 | 能把思路写成程序、估算时空复杂度，独立实现二分、前缀和、DFS/BFS，并用边界样例或对拍定位错误。 |',
    '| ② 连起常用工具 | 线性、背包和区间 DP；基础数论与组合计数；基础数据结构；图遍历、最短路和生成树 | 能解释 DP 状态与转移；按约束选择数据结构和图算法；模板题通过后，能解决改变条件的基础应用。 |',
    '| ③ 补齐进阶专题 | D3 条目；树形/状压 DP、字符串、LCA、连通性、基础网络流与几何 | 能说明先修关系、正确性和复杂度，独立完成至少一类组合应用，并复盘错误条件与实现细节。 |',
    '| ④ 按比赛缺口深挖 | D4–D5 条目；复杂变体、离线方法、动态结构、多项式等 | 能比较备选方案与适用边界，验证模板并完成对应专题综合题；低置信度评级用实际训练结果校准。 |',
    '',
    '学习顺序参考原资料的起步建议，并按当前知识分类表述。原飞书的多级编号仅用于来源对照，不再表示当前目录路径。D4–D5 不要求一次学完，按比赛和补题暴露的缺口选择。',
    '',
    '### 六条学习依赖参考',
    '',
    '箭头表示建议的串联学习顺序；同一层列出的算法可按需并行学习，并非彼此都是严格先修。',
    '',
    '- 递归与复杂度 → DFS/BFS → 剪枝、记忆化 → 双向搜索、A* / IDA*。',
    '- 线性 DP → 背包、区间 DP → 树形 / 状压 DP → 数据结构与决策优化 → 轮廓线 / 插头 DP。',
    '- 前缀和、离散化 → 树状数组 / 线段树 → 分块与莫队 → 持久化、树套树和动态结构。',
    '- 图的遍历 → 最短路、生成树 → LCA、连通性分解 → 树链剖分、虚树和树分治。',
    '- 字符串基础 → 哈希、KMP / Z 函数、Trie → AC 自动机、SA、Manacher → SAM / PAM 与复杂后缀结构。',
    '- GCD、快速幂、逆元与组合计数 → CRT、线性代数 → FFT / NTT → 形式幂级数、反演与生成函数。',
    ''
  );
}

function renderScopeNotes(rows, byId) {
  const target = (id, fallback) => byId.has(id) ? referenceTo(id, byId) : fallback;
  rows.push(
    '## 使用条件与易混范围',
    '',
    '| 主题 | 适用条件与检查点 |',
    '| --- | --- |',
    `| ${target('xcpc-sg函数-1', 'SG 函数')} | 经典 SG 定理适用于有限、无偏、双方可选行动相同、正常规则的组合博弈；和局、环或反常规则需另行分析。 |`,
    `| ${target('xcpc-prim-1', 'Prim')} / ${target('xcpc-kruskal-1', 'Kruskal')} | 解决无向带权图的最小生成树；不连通时得到最小生成森林，有向最小树形图另列。 |`,
    `| ${target('xcpc-dijkstra-1', 'Dijkstra')} | 要求边权非负；使用负边权前应更换算法或证明经过合法重标权。 |`,
    `| ${target('algorithm-spfa', 'SPFA')} | 是队列优化的松弛算法，最坏复杂度仍为 ${code('O(VE)')}；负环判断与不可达点必须单独处理。 |`,
    `| ${target('xcpc-逆元-1', '模逆元')} | 模 ${code('m')} 的逆元存在当且仅当 ${code('gcd(a, m) = 1')}；费马小定理求逆还要求模数为素数且 ${code('a ≠ 0 (mod m)')}。 |`,
    `| ${target('algorithm-多项式求逆', '多项式求逆')} | 形式幂级数的常数项必须可逆；在域上即常数项非零，在一般模环中仍需检查互素条件。 |`,
    `| ${target('xcpc-fft-ntt-1', 'FFT / NTT')} | 区分浮点误差与模变换；NTT 的模数、原根和变换长度必须相容，不能任取模数直接套用。 |`,
    `| ${target('feishu-part-6-19', '珂朵莉树 / ODT')} | 普通实现依赖区间数量控制及数据分布假设；对抗数据可使区间大量分裂，不具有通用稳定的对数复杂度保证。 |`,
    `| ${target('algorithm-可撤销并查集', '可撤销并查集')} | 通常用按大小/秩合并及修改栈；普通路径压缩不能直接沿用，否则撤销记录和复杂度分析都需重做。 |`,
    `| ${target('feishu-part-5-12-1', '三分法')} / ${target('feishu-part-5-12-2', '自适应辛普森法')} | 三分需单峰/单谷条件；数值积分需误差和终止控制。整数离散最优点、浮点精度与不光滑函数分别处理。 |`,
    ''
  );
}

function renderDirectoryDocument(data) {
  const { entries, byId } = indexDirectory(data);
  const summary = data.summary || {};
  const rows = [
    '# XCPC 算法目录：知识结构与学习难度整合版',
    '',
    `整理日期：${sourceDate(data)}。保留飞书 ${summary.sourceHeadings ?? entries.filter(entry => entry.node.sourceHeading).length} 个原始章节的来源记录，按当前知识关系重新分组，整合为 ${summary.nodes ?? entries.length} 个目录与知识节点；${summary.userGraded ?? entries.filter(entry => entry.node.difficultySource?.kind === 'user-md').length} 项沿用明确分档，${summary.researchGraded ?? entries.filter(entry => isResearch(entry.node)).length} 项完成知识补评，${summary.graded} 个具体算法与模型均已定稿；${summary.directories} 个目录与入口不评级，原有 ${summary.originalNodesPreserved} 个节点全部保留，另加 ${summary.addedAlgorithmContent} 个算法内容子节点，兼容 ${summary.oldNodesMapped ?? Object.keys(data.legacyNodeMap || {}).length} 个历史节点标识。`,
    '',
    '## 阅读导航',
    '',
    '- [标号与阅读规则](#reading-rules) · [学习安排](#学习安排) · [使用条件与易混范围](#使用条件与易混范围)',
    '- [逐项难度评估附录](<algorithm-research/difficulty-assessment.md>) · [来源与维护](#来源与维护)',
    ''
  ];
  for (const part of data.tree.children) rows.push(`- [${sourceTitle(part)}](${partLink(part)})`);
  rows.push(
    '',
    '<a id="reading-rules"></a>',
    '',
    '## 标号与阅读规则',
    '',
    `以[《${text(data.sources?.feishu?.title || '算法板子与要点')}》](${data.sources.feishu.url})为初始框架，保留原十个一级模块，并补充“算法竞赛经验与游记”模块；模块内部按知识依赖、问题模型和应用关系重新组织。原飞书编号只用于追溯，完整对应见[原标题与当前路径对照](<XCPC算法目录_分类标题优化对照.md>)，移动和归并理由见[结构优化说明](<XCPC算法目录_结构优化说明.md>)。难度优先采用[用户颜色文档](<${data.sources.userMd.path}>)的明确分档。`,
    '',
    '| 标号 | 学习定位 | 原颜色 |',
    '| --- | --- | --- |',
    '| D1 | 入门 | 青 |',
    '| D2 | 初级 | 绿 |',
    '| D3 | 中级 | 蓝 |',
    '| D4 | 高级 | 橙 |',
    '| D5 | 挑战 | 红 |',
    '',
    '- 仅具体算法与明确模型参与难度定稿。**〔原〕**沿用用户明确等级，**〔定稿〕**为逐项审定；**〔目录〕**只负责导航和笔记关联，不评级。',
    '- **模板、常用、低频是独立属性，不代表难度。**低频知识可以很简单，常用算法也有复杂变体；五档同样不等于一道题的难度或获得某种奖牌的保证。',
    '- 原有目录的标识、名称、顺序、父级和笔记关联均保留。原目录包含具体算法内容时，另开一个同名算法子节点承接原等级、学习范围和证据；目录自身不显示难度或跨度。',
    '- 保留原文明确分档，例如 SAM、PAM、FWT、Prüfer、Burnside/Pólya、Lyndon/Duval 为 D5。这是来源取舍，不宣称各资料都采用相同等级。',
    '- “定稿”表示本项目对所述范围作出明确等级选择，不表示难度客观唯一。参考资料的证据范围和置信度仍保留，外部资料没有共同授予本目录五档；USACO 分区不直接映射为 XCPC 奖牌。',
    ''
  );
  renderLearningPlan(rows);
  rows.push('## 模块与专题概览', '', '目录仅组织知识，不标难度；具体算法与模型在所属分支中单独列出等级。', '', '| 模块 | 主要专题 |', '| --- | --- |');
  for (const part of data.tree.children) {
    const groups = part.children.map(node => `${referenceTo(node.id, byId)}${isDirectory(node) ? '' : `（${grade(node)}）`}`).join('、');
    rows.push(`| [${sourceTitle(part)}](${partLink(part)}) | ${groups} |`);
  }
  rows.push('', '## 完整目录', '');

  function renderNode(node, depth) {
    const attributes = (node.attributes || []).map(attribute => data.legend[attribute] || attribute).join('、');
    const difficulty = isDirectory(node) ? ' · 〔目录〕' : ` · **${grade(node)}**${provenanceMark(node)}`;
    rows.push(`${'  '.repeat(depth)}- <a id="${topicAnchor(node)}"></a>${sourceTitle(node)}${difficulty}${attributes ? ` · ${attributes}` : ''}`);
    for (const detail of supplementalDetails(node, byId).filter(detail => !detail.startsWith('范围：') || !node.children.length)) rows.push(`${'  '.repeat(depth + 1)}- ${detail}`);
    for (const child of node.children || []) renderNode(child, depth + 1);
  }
  for (const part of data.tree.children) {
    rows.push(`<a id="${partAnchor(part.part)}"></a>`, '', `### ${sourceTitle(part)} · 〔目录〕`, '');
    for (const child of part.children || []) renderNode(child, 0);
    rows.push('');
  }
  renderScopeNotes(rows, byId);
  rows.push(
    '## 来源与维护',
    '',
    '- [逐项难度评估附录](<algorithm-research/difficulty-assessment.md>)：按 Part 分组，完整列出算法的定稿等级、范围、依据和编号参考来源；目录明确记为不适用。',
    '- [完整难度依据 JSON](<algorithm-research/difficulty-evidence.json>) · [来源短摘录](<algorithm-research/sources.json>) · [飞书原始目录快照](<algorithm-research/feishu-outline.json>)。',
    '- [颜色文档覆盖表](<algorithm-research/color-md-coverage.json>)记录原清单与新节点的对应；[旧节点映射](<algorithm-research/legacy-node-map.json>)保留已有笔记关联。',
    '- [可编辑目录数据](<../data/algorithm-directory.json>)同时生成项目目录、本文与评估附录；维护命令及文件关系见[维护说明](<algorithm-research/README.md>)。',
    '- 这里只提取飞书公开目录与必要学习顺序，不复制大段讲解、代码；用户原 Markdown 保持原样。旧目录中的泛称、复杂度变体和类别节点也不计作全新的独立算法。',
    ''
  );
  return rows.join('\n');
}

function researchUrls(node) {
  return [...new Set((node.sourceRefs || []).filter(value => typeof value === 'string' && /^https?:\/\//.test(value) && !value.includes('feishu.cn')))];
}

function sourceLabel(url) {
  const parsed = new URL(url);
  const site = ({ 'oi-wiki.org': 'OI Wiki', 'cp-algorithms.com': 'CP-Algorithms', 'usaco.guide': 'USACO Guide', 'arxiv.org': 'arXiv' })[parsed.hostname] || parsed.hostname;
  const location = decodeURIComponent(parsed.pathname).replace(/^\//, '').replace(/\/$/, '') || '首页 / 导航';
  return `${site} · ${location}`;
}

function renderDifficultyAppendix(data) {
  const { entries, byId } = indexDirectory(data);
  const urls = [...new Set(entries.flatMap(entry => researchUrls(entry.node)))].sort();
  const sourceIds = new Map(urls.map((url, index) => [url, 'S' + String(index + 1).padStart(3, '0')]));
  const rows = ['# XCPC 算法目录：算法难度与目录不适用对照表', '',
    '[返回主目录](<../XCPC算法目录_飞书结构与难度整合.md>)。本表完整覆盖 ' + entries.length + ' 个节点，其中 ' + data.summary.graded + ' 个具体算法与模型评级，' + data.summary.directories + ' 个目录、根入口与来源占位不评级。', '',
    '## 评级口径', '',
    '- 评级对象是理解原理并独立实现本行所述范围的学习负担，不是某道题的题目分数。',
    '- D1：基础语法与直接操作；D2：常用基础算法与标准模型；D3：非平凡状态维护、组合先修和完整证明；D4：高级优化或复杂结构组合；D5：高度抽象结构与较重的综合证明。',
    '- 定稿状态与证据强度分开：所有等级均已由本项目确定；来源的直接程度仍如实记录，不宣称客观唯一或来源统一授予。',
    '- 目录、分类、根入口和来源占位均不评级；目录包含具体算法内容时，新增算法子节点承接原等级与证据。原目录的名称、位置及已有笔记关联不变。',
    '- 原文明确档保留，包括个别与常见教材路线不同的等级；本项目沿用用户标尺。',
    '- 两条原来只有复杂度的树形背包记录已明确采用教学模型，模型与复杂度条件见逐项范围；这不表示恢复了原作者未提供的状态定义。', '',
    '## 数量分布', '', '| 等级 | 节点数 |', '| --- | --- |'];
  for (const [color, label] of Object.entries(difficulties)) rows.push('| ' + label + ' | ' + entries.filter(entry => entry.node.color === color).length + ' |');
  rows.push('| 目录（不评级） | ' + data.summary.directories + ' |');
  rows.push('', '## 分组导航', '', '- [总入口](#assessment-root)');
  for (const part of data.tree.children) rows.push('- [' + sourceTitle(part) + '](#assessment-part-' + part.part + ')');
  rows.push('- [编号参考来源](#source-catalog)', '');
  function table(group) {
    rows.push('| 节点与当前路径 | 定稿等级 / 类型 | 学习范围与评级理由 | 出处 / 内容参考 |', '| --- | --- | --- | --- |');
    for (const entry of group) {
      const node = entry.node;
      const type = ({ directory: '目录（不评级）', knowledge: '知识点', model: '明确教学模型' })[node.rating?.type] || '知识点';
      const origin = isDirectory(node) ? '目录不适用' : node.difficultySource?.kind === 'user-md' ? '用户明确档' : '本项目逐项审定';
      const confidence = node.difficultyConfidence === 'low' ? '宽泛或先修参考' : node.difficultyConfidence === 'medium' ? '专题与先修参考' : '';
      const refs = researchUrls(node).map(url => '[' + sourceIds.get(url) + '](#source-' + sourceIds.get(url).toLowerCase() + ')').join('、');
      rows.push('| ' + text(currentPath(entry, data.tree) || data.tree.label) + ' | **' + (isDirectory(node) ? '不适用' : grade(node)) + '**<br>' + type + ' | ' + text(node.rating?.scope || node.scope) + '<br>理由：' + text(node.rationale) + ' | ' + origin + (confidence ? '<br>' + confidence : '') + (refs ? '<br>' + refs : '') + ' |');
    }
    rows.push('');
  }
  rows.push('<a id="assessment-root"></a>', '', '## 总入口', '');
  table(entries.filter(entry => entry.node === data.tree));
  for (const part of data.tree.children) {
    rows.push('<a id="assessment-part-' + part.part + '"></a>', '', '## ' + sourceTitle(part), '');
    table(entries.filter(entry => entry.topPart === part));
  }
  rows.push('<a id="source-catalog"></a>', '', '## 编号参考来源', '', '参考支撑知识内容与先修，等级由本项目审定；资料的原文没有共同采用本目录五档。', '');
  for (const url of urls) {
    const sourceId = sourceIds.get(url);
    rows.push('<a id="source-' + sourceId.toLowerCase() + '"></a>', '', '- **' + sourceId + '** [' + text(sourceLabel(url)) + '](' + url + ')');
  }
  rows.push('', '## 维护数据', '', '- [完整评级数据](<difficulty-evidence.json>) · [来源记录](<sources.json>) · [原文清单覆盖](<color-md-coverage.json>)。', '');
  return rows.join('\n');
}

function renderCategoryNames(data) {
  const { entries } = indexDirectory(data);
  const changes = data.editorial?.categoryRenames || [];
  const rows = [
    '# XCPC 算法目录：分类标题优化对照', '',
    `此前完成 ${changes.length} 项分类或专题标题规范化；本表同时追踪后续结构调整后的当前位置。原飞书编号与标题属于来源记录，当前路径按实际知识分类展示。`, '',
    '## 一级分类', '',
    '| Part | 原标题 | 当前标题 |', '| --- | --- | --- |'
  ];
  for (const part of data.tree.children) {
    rows.push(`| ${part.part} | ${text(part.sourceHeading?.replace(/^Part\s+\S+\s+/, '') || part.label)} | ${topicName(part)} |`);
  }
  const shortened = data.editorial?.titleSimplification;
  if (shortened) {
    rows.push('', '## 全目录标题简化', '', `已检查 ${shortened.reviewed} 个标题，简化 ${shortened.changed} 个，其余保留。难度、层级及节点标识不变，原名保留为搜索别名。`, '', '| 简化前 | 当前标题 |', '| --- | --- |');
    for (const change of shortened.changes) rows.push(`| ${text(change.before)} | ${text(change.after)} |`);
  }
  rows.push('', '## 历次标题规范化记录', '', '下表的“优化后”记录改名当时的名称；完整的当前名称与位置见后面的来源对照。', '', '| 位置 | 优化前 | 优化后 | 原因 |', '| --- | --- | --- | --- |');
  for (const change of changes) {
    rows.push(`| ${text(change.part ? `Part ${change.part}` : change.nodeId)} | ${text(change.before)} | ${text(change.after)} | ${text(change.reason)} |`);
  }
  rows.push('', '## 全部飞书章节对照', '', '按原始编号排列；编号只表示来源位置，当前学习路径见最右列。', '', '| 原编号 | 飞书原始标题 | 当前标题 | 当前路径 |', '| --- | --- | --- | --- |');
  const sourceEntries = entries.filter(entry => entry.node.sourceHeading).sort((left, right) => left.node.part.localeCompare(right.node.part, 'en', { numeric: true }));
  for (const entry of sourceEntries) {
    const { node } = entry;
    const link = `[${topicName(node)}](XCPC算法目录_飞书结构与难度整合.md${nodeLink(entry)})`;
    rows.push(`| ${node.part} | ${text(node.sourceHeading)} | ${link} | ${currentPath(entry, data.tree)} |`);
  }
  rows.push('', '## 使用说明', '',
    '- 原标题继续作为检索别名，旧名称仍可搜索。',
    '- “待分类专题”保留原来源的空章节；缺少具体内容时不凭空指定为某类题型。',
    '- 标题规范化与结构调整分别留有记录；旧节点标识继续映射到当前知识点，已有笔记关联由同一份目录数据维持。',
    '- [返回算法主目录](<XCPC算法目录_飞书结构与难度整合.md>) · [来源目录快照](<algorithm-research/feishu-outline.json>)', '');
  return rows.join('\n');
}

function renderStructureReport(data) {
  const changes = data.editorial?.structureChanges || [];
  const { entries, byId } = indexDirectory(data);
  const counts = new Map();
  for (const change of changes) counts.set(change.type, (counts.get(change.type) || 0) + 1);
  const rows = [
    '# XCPC 算法目录：结构优化说明', '',
    '本轮在规范标题的基础上调整知识层级：保留十个一级模块，按问题模型、结构类型与学习依赖组织模块内部专题；原飞书章节的编号和标题继续作为来源记录。', '',
    '## 优化结果', '',
    `- 当前共 ${entries.length} 个目录与知识节点；新增的专题分组不表示新增独立算法。`,
    `- 完整保留 ${entries.filter(entry => entry.node.sourceHeading).length} 条飞书章节来源，并记录当前路径。`,
    `- 保留 ${Object.keys(data.legacyNodeMap || {}).length} 个历史节点标识的映射，兼容已有笔记。`,
    '- 全部原目录保持名称、位置与笔记关联，不评级；104 个原目录中的具体算法内容另开子节点承接原等级与证据。模板与使用频率仍作为独立属性。',
    '- 交叉引用链接直接指向具体节点，移动到其他模块后仍能准确定位。', '',
    '## 当前专题布局', '', '| 模块 | 直接专题 |', '| --- | --- |'
  ];
  for (const part of data.tree.children) {
    const topics = part.children.map(node => `[${topicName(node)}](XCPC算法目录_飞书结构与难度整合.md${nodeLink(byId.get(node.id))})`).join('、');
    rows.push(`| ${sourceTitle(part)} | ${topics} |`);
  }
  rows.push('', '## 改动类型', '', '| 类型 | 记录数 |', '| --- | --- |');
  for (const [type, count] of counts) rows.push(`| ${text(type)} | ${count} |`);
  rows.push('', '## 归类与层级改动', '', '先列新增分组、归属调整和合并等内容；各节点内部的排序记录单列在后。', '', '| 类型 | 条目 | 调整前 | 调整后 | 原因 |', '| --- | --- | --- | --- | --- |');
  const valueText = value => Array.isArray(value) ? value.map(text).join('、') : text(value || '—');
  for (const change of changes.filter(item => !/order|sort/i.test(item.type))) {
    const entry = byId.get(change.nodeId);
    const label = change.label || entry?.node.label || change.nodeId || '专题分组';
    const link = entry ? `[${text(label)}](XCPC算法目录_飞书结构与难度整合.md${nodeLink(entry)})` : text(label);
    rows.push(`| ${text(change.type)} | ${link} | ${valueText(change.from)} | ${valueText(change.to)} | ${text(change.reason || '')} |`);
  }
  const ordered = changes.filter(item => /order|sort/i.test(item.type));
  if (ordered.length) {
    rows.push('', '## 专题内部排序', '', '| 条目 | 当前顺序 | 原因 |', '| --- | --- | --- |');
    for (const change of ordered) {
      const entry = byId.get(change.nodeId);
      rows.push(`| ${text(change.label || entry?.node.label || change.nodeId || '专题')} | ${valueText(change.to)} | ${text(change.reason || '')} |`);
    }
  }
  rows.push('', '## 目录与算法内容分离', '', `保留原有 ${data.editorial.directorySeparation.originalNodes} 个节点，${data.summary.directories} 个目录均不评级；新增 ${data.summary.addedAlgorithmContent} 个算法内容子节点。原有算法叶子节点保持原样，历史标识仍指向原目录，笔记不搬移。`, '', '| 原目录 | 新算法子节点 |', '| --- | --- |');
  for (const move of data.editorial.directorySeparation.contentMoves) rows.push(`| ${referenceTo(move.directoryId, byId)}（${code(move.directoryId)}） | ${referenceTo(move.algorithmId, byId)}（${code(move.algorithmId)}） |`);
  rows.push('', '## 来源与复核', '',
    '- [查看完整目录](<XCPC算法目录_飞书结构与难度整合.md>)',
    '- [原标题、原编号与当前路径对照](<XCPC算法目录_分类标题优化对照.md>)',
    '- [可编辑数据与结构改动记录](<../data/algorithm-directory.json>)',
    '- 节点数量包含模块、专题分组、知识点、模型与入口记录；不应将节点总数直接当作独立算法数量。', '');
  return rows.join('\n');
}

function buildDirectoryDocument({ check = false } = {}) {
  const data = JSON.parse(fs.readFileSync(path.join(root, 'data/algorithm-directory.json'), 'utf8'));
  const outputs = [
    { relativePath: mainRelativePath, content: renderDirectoryDocument(data) },
    { relativePath: appendixRelativePath, content: renderDifficultyAppendix(data) },
    { relativePath: categoryNamesRelativePath, content: renderCategoryNames(data) },
    { relativePath: structureReportRelativePath, content: renderStructureReport(data) }
  ];
  for (const output of outputs) {
    const target = path.join(root, output.relativePath);
    if (check) {
      assert.equal(fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n'), output.content, `Generated document differs: ${output.relativePath}`);
    } else {
      fs.writeFileSync(target, output.content);
    }
  }
  // Preserve the existing public API's return value for scripts and callers.
  return path.join(root, mainRelativePath);
}

if (require.main === module) console.log(buildDirectoryDocument({ check: process.argv.includes('--check') }));
module.exports = { renderDirectoryDocument, renderDifficultyAppendix, renderCategoryNames, renderStructureReport, buildDirectoryDocument };
