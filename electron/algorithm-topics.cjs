'use strict';

const { randomUUID } = require('node:crypto');
const BUILTINS = require('../ui/algorithm-tree.js');
const { hydrate } = require('../ui/algorithm-directory.js');
const TOPICS_PATH = 'algorithms/directory-additions.json';
const COLORS = new Set(['basic', 'beginner', 'intermediate', 'advanced', 'expert']);
const CUSTOM_ID = /^custom-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TOPICS = 5000;

function cleanText(value, name, max, optional = false) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${name}必须是有效文本，不能包含控制字符`);
  const result = value.trim().replace(/\s+/g, ' ');
  if ((!optional && !result) || result.length > max) throw new Error(`${name}长度须为${optional ? '0' : '1'}-${max}个字符`);
  return result;
}
function normalizeInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('算法目录输入格式错误');
  const parentId = cleanText(value.parentId, '父分类标识', 200);
  const label = cleanText(value.label, '简短标题', 80);
  const fullLabel = cleanText(value.fullLabel, '完整标题', 200);
  const scope = cleanText(value.scope, '学习范围', 2000, true);
  const kind = value.kind === undefined ? 'algorithm' : value.kind;
  if (!['directory', 'algorithm'].includes(kind)) throw new Error('节点类型必须是目录或算法');
  if (kind === 'algorithm' && !COLORS.has(value.color)) throw new Error('算法难度必须是D1-D5对应的有效等级');
  if (kind === 'directory' && value.color !== undefined && value.color !== 'parent') throw new Error('目录不设置算法难度');
  const requestId = value.requestId === undefined ? undefined : cleanText(value.requestId, '请求标识', 100);
  if (requestId !== undefined && !/^[A-Za-z0-9._:-]+$/.test(requestId)) throw new Error('请求标识格式错误');
  return { parentId, label, fullLabel, kind, color: kind === 'directory' ? 'parent' : value.color, scope, ...(requestId ? { requestId } : {}) };
}
function builtinIndex(tree = BUILTINS, topics = []) {
  const index = new Map();
  function visit(node, depth, parentId = null) {
    const entry = { id: node.id, label: node.label, kind: node.kind, parentId, depth, children: node.children || [] };
    index.set(node.id, entry);
    for (const alias of node.legacyIds || []) index.set(alias, entry);
    for (const child of node.children || []) visit(child, depth + 1, node.id);
  }
  visit(hydrate(tree, topics), 0);
  return index;
}
function validateTopics(value, tree = BUILTINS) {
  if (!Array.isArray(value) || value.length > MAX_TOPICS) throw new Error('共享算法目录格式错误或条目过多');
  const builtins = builtinIndex(tree), custom = new Map();
  const topics = value.map(raw => {
    if (!raw || !CUSTOM_ID.test(raw.id) || builtins.has(raw.id) || custom.has(raw.id)) throw new Error('共享算法目录包含无效或重复节点标识');
    const normalized = normalizeInput(raw);
    if (!Number.isSafeInteger(raw.createdBy?.id) || raw.createdBy.id < 1 || typeof raw.createdBy.login !== 'string' || !raw.createdBy.login.trim()) throw new Error('共享算法目录缺少创建者记录');
    if (typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt))) throw new Error('共享算法目录缺少创建时间');
    const topic = { id: raw.id, ...normalized, createdAt: raw.createdAt, createdBy: { id: raw.createdBy.id, login: raw.createdBy.login } };
    custom.set(topic.id, topic); return topic;
  });
  for (const topic of topics) topic.parentId = builtins.get(topic.parentId)?.id || topic.parentId;
  // Synthetic content nodes depend on the algorithm they were split from. Follow
  // that ownership as well as ordinary parents before hydrating any stored graph.
  const syntheticPrefix = 'algorithm-content-';
  for (const topic of topics) {
    const seen = new Set([topic.id]); let cursor = topic.parentId, depth = 0;
    while (!builtins.has(cursor)) {
      if (seen.has(cursor)) throw new Error('共享算法目录存在循环父子关系');
      seen.add(cursor);
      if (custom.has(cursor)) cursor = custom.get(cursor).parentId;
      else if (cursor.startsWith(syntheticPrefix)) cursor = cursor.slice(syntheticPrefix.length);
      else throw new Error('共享算法目录包含不存在的父分类');
      if (++depth > 64) throw new Error('共享算法目录层级过深');
    }
  }
  const effective = builtinIndex(tree, topics), requests = new Set();
  for (const topic of topics) {
    const parent = effective.get(topic.parentId), node = effective.get(topic.id);
    if (!parent || !node || node.parentId !== parent.id) throw new Error('共享算法目录包含不存在的父分类或无法解析的合成节点');
    if (node.depth > 64) throw new Error('共享算法目录层级过深');
    if (parent.children.some(child => child.id !== topic.id && child.label.toLocaleLowerCase() === topic.label.toLocaleLowerCase())) throw new Error('同一父分类下已存在该算法标题');
    if (topic.requestId) {
      const requestKey = `${topic.createdBy.id}:${topic.requestId}`;
      if (requests.has(requestKey)) throw new Error('共享算法目录包含重复请求标识');
      requests.add(requestKey);
    }
  }
  return topics;
}
function parseTopics(text, tree = BUILTINS) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 5000000) throw new Error('共享算法目录文件过大');
  let value; try { value = JSON.parse(text); } catch { throw new Error('共享算法目录JSON无法解析'); }
  if (!value || value.schema !== 1) throw new Error('共享算法目录版本或格式不受支持');
  return validateTopics(value.topics, tree);
}
class AlgorithmTopics {
  constructor(github, { tree = BUILTINS, uuid = randomUUID, now = () => new Date().toISOString() } = {}) { this.gh = github; this.tree = tree; this.uuid = uuid; this.now = now; }
  async current(branch) {
    const current = await this.gh.currentDocument(TOPICS_PATH, branch);
    return { topics: current ? parseTopics(current.text, this.tree) : [], sha: current?.sha || null };
  }
  async save(input) {
    const clean = normalizeInput(input);
    if (!this.gh.token) throw new Error('请先登录 GitHub');
    // Never trust renderer or cached permission bits for shared directory modifications.
    const { data: user } = await this.gh.request('/user');
    if (!Number.isSafeInteger(user.id) || user.id < 1 || typeof user.login !== 'string' || !user.login) throw new Error('无法确认GitHub登录用户身份');
    const { data: info } = await this.gh.request(`/repos/${this.gh.repo}`);
    if (info.permissions?.admin !== true) throw new Error('只有仓库管理员（admin）可以新增算法目录');
    if (!info.default_branch) throw new Error('仓库尚无默认分支，请先初始化仓库');
    const branch = info.default_branch, current = await this.current(branch);
    const index = builtinIndex(this.tree, current.topics);
    clean.parentId = index.get(clean.parentId)?.id || clean.parentId;
    const previous = clean.requestId && current.topics.find(topic => topic.createdBy.id === user.id && topic.requestId === clean.requestId);
    if (previous) {
      if (['parentId', 'label', 'fullLabel', 'kind', 'color', 'scope'].some(key => previous[key] !== clean[key])) throw new Error('同一请求标识已用于不同算法内容，请先同步确认');
      return { topic: { ...previous, repo: this.gh.repo }, topics: current.topics.map(topic => ({ ...topic, repo: this.gh.repo })) };
    }
    const topic = { id: `custom-${this.uuid()}`, ...clean, createdAt: this.now(), createdBy: { id: user.id, login: user.login } };
    const topics = validateTopics([...current.topics, topic], this.tree);
    const text = JSON.stringify({ schema: 1, topics }, null, 2) + '\n';
    if (Buffer.byteLength(text, 'utf8') > 5000000) throw new Error('共享算法目录文件过大，请拆分整理后再新增');
    let response;
    try {
      response = await this.gh.request(this.gh.contentEndpoint(TOPICS_PATH), { method: 'PUT', body: JSON.stringify({ message: `新增算法目录：${topic.label}`, content: Buffer.from(text).toString('base64'), branch, ...(current.sha ? { sha: current.sha } : {}) }) });
    } catch (error) {
      if ([409, 422].includes(error.status)) { const conflict = new Error('算法目录SHA冲突，请先同步后重试；远端内容未被覆盖', { cause: error }); conflict.status = error.status; throw conflict; }
      throw error;
    }
    if (!response.data.content?.sha) throw new Error('算法目录写入结果未知，请先同步核实；重试时保留同一请求标识');
    return { topic: { ...topic, repo: this.gh.repo }, topics: topics.map(item => ({ ...item, repo: this.gh.repo })) };
  }
}
module.exports = { AlgorithmTopics, TOPICS_PATH, normalizeInput, builtinIndex, validateTopics, parseTopics };
