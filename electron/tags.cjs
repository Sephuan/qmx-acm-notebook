'use strict';

const PRESETS = require('../ui/tag-presets.js');
const { createHash } = require('node:crypto');
const MARKER = /<!--\s*qmx-tag-request\s+([\s\S]*?)\s*-->/;
const TAGS_PATH = '.qmx/tags.json';
const MAX_NAME = 80;

function normalizeName(value) {
  if (typeof value !== 'string') throw new Error('标签名称必须是文本');
  if (/[\r\n\u0000-\u001f\u007f]/.test(value)) throw new Error('标签名称不能包含控制字符');
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name || name.length > MAX_NAME || /[\r\n\u0000-\u001f\u007f]/.test(name)) throw new Error(`标签名称须为 1-${MAX_NAME} 个字符`);
  return name;
}
function parseRequest(issue) {
  const body = String(issue?.body || '');
  const match = body.match(MARKER);
  if (!match || (body.match(/<!--\s*qmx-tag-request\b/g) || []).length !== 1) return null;
  try {
    const value = JSON.parse(match[1]);
    if (value?.type !== 'qmx-tag-request' || typeof value.category !== 'string' || typeof value.name !== 'string') return null;
    return { category: value.category, name: value.name };
  } catch { return null; }
}
function issueRequest(issue, repo) {
  const value = parseRequest(issue);
  if (!value) return null;
  return { number: issue.number, category: value.category, name: value.name, author: issue.user?.login || '', url: issue.html_url || `https://github.com/${repo}/issues/${issue.number}`, state: issue.state, expected: { category: value.category, name: value.name, updatedAt: issue.updated_at || '' } };
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function mergeCatalog(presets, saved) {
  if (!saved || typeof saved !== 'object' || !Array.isArray(saved.categories)) throw new Error('标签目录格式错误：categories 必须是数组');
  const catalog = clone(presets);
  if (saved?.approvals && typeof saved.approvals === 'object' && !Array.isArray(saved.approvals)) catalog.approvals = clone(saved.approvals);
  const categories = new Map(catalog.categories.map(category => [String(category.id), category]));
  for (const item of (saved?.categories || [])) {
    const id = String(item?.id ?? '');
    let category = categories.get(id);
    if (!category && item?.name) category = catalog.categories.find(x => x.name === item.name);
    if (!category) throw new Error(`标签目录包含未知分类：${id || item?.name || '空分类'}`);
    if (!Array.isArray(item.tags)) throw new Error('标签目录格式错误：分类 tags 必须是数组');
    for (const rawTag of item.tags) {
      const tagName = typeof rawTag === 'string' ? normalizeName(rawTag) : normalizeName(rawTag?.name);
      const tagId = typeof rawTag === 'string' ? '' : String(rawTag?.id ?? '');
      if (!category.tags.some(tag => tag.name.toLocaleLowerCase() === tagName.toLocaleLowerCase())) category.tags.push({ id: tagId, name: tagName });
    }
  }
  return catalog;
}

class Tags {
  constructor(github, presets = PRESETS) { this.gh = github; this.presets = presets; }
  async catalogData() {
    const { data: repoInfo } = await this.gh.request(`/repos/${this.gh.repo}`);
    if (!repoInfo.default_branch) throw new Error('仓库尚无默认分支');
    try {
      const { data } = await this.gh.request(`${this.gh.contentEndpoint(TAGS_PATH)}?ref=${encodeURIComponent(repoInfo.default_branch)}`);
      if (data.type !== 'file' || data.encoding !== 'base64' || !data.content || !data.sha) throw new Error('GitHub 未返回完整标签目录及 SHA');
      let saved;
      try { saved = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8')); } catch (error) { throw new Error(`标签目录 JSON 无法解析：${error.message}`); }
      return { catalog: mergeCatalog(this.presets, saved), branch: repoInfo.default_branch, sha: data.sha };
    } catch (error) {
      if (error.status !== 404) throw error;
      return { catalog: clone(this.presets), branch: repoInfo.default_branch, sha: null };
    }
  }
  async getTagCatalog() { return (await this.catalogData()).catalog; }
  async currentUser() {
    if (!this.gh.token) throw new Error('请先登录 GitHub');
    const { data: user } = await this.gh.request('/user');
    if (!Number.isSafeInteger(user.id) || user.id < 1 || !user.login) throw new Error('无法确认 GitHub 登录用户身份');
    return user;
  }
  async reviewPermission() {
    await this.currentUser();
    const { data } = await this.gh.request(`/repos/${this.gh.repo}`);
    const permissions = data.permissions || {};
    return permissions.admin === true || permissions.maintain === true || data.role_name === 'maintain' || data.role_name === 'admin';
  }
  async getTagReview() {
    const canReview = this.gh.token ? await this.reviewPermission() : false;
    const issues = await this.gh.pages(`/repos/${this.gh.repo}/issues?state=all&sort=updated&direction=desc`);
    const requests = issues.filter(issue => !issue.pull_request).map(issue => issueRequest(issue, this.gh.repo)).filter(Boolean);
    return { canReview, requests };
  }
  async requestTag({ category, name } = {}) {
    const user = await this.currentUser();
    const cleanName = normalizeName(name);
    const catalog = await this.getTagCatalog();
    const target = catalog.categories.find(item => String(item.id) === String(category) || item.name === category);
    if (!target) throw new Error('标签分类不存在');
    if (target.tags.some(tag => tag.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase())) throw new Error('该分类已存在此标签，无需重复申请');
    const issues = await this.gh.pages(`/repos/${this.gh.repo}/issues?state=all&sort=updated&direction=desc`);
    const duplicate = issues.find(issue => !issue.pull_request && issue.state === 'open'
      && parseRequest(issue)?.category === String(target.id) && parseRequest(issue)?.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase());
    if (duplicate) return issueRequest(duplicate, this.gh.repo);
    const payload = { type: 'qmx-tag-request', category: String(target.id), categoryName: target.name, name: cleanName };
    const body = `<!-- qmx-tag-request ${JSON.stringify(payload).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')} -->\n\n申请将标签「${cleanName}」加入分类「${target.name}」。`;
    const { data: issue } = await this.gh.request(`/repos/${this.gh.repo}/issues`, { method: 'POST', body: JSON.stringify({ title: `[标签申请] ${cleanName}`, body }) });
    return issueRequest(issue, this.gh.repo) || { number: issue.number, category: String(target.id), name: cleanName, author: user.login, url: issue.html_url, state: issue.state };
  }
  async saveCatalog(name, categoryId, number, state) {
    const { catalog: merged, branch, sha } = state;
    const approval = merged.approvals?.[number];
    if (approval) {
      if (approval.category !== categoryId || approval.name !== name) throw new Error('该申请已批准，但申请内容后来发生变化；请人工核对已批准目录并关闭 Issue');
      return merged;
    }
    const category = merged.categories.find(item => String(item.id) === categoryId);
    if (!category) throw new Error('标签分类不存在，拒绝写入');
    if (!category.tags.some(tag => tag.name.toLocaleLowerCase() === name.toLocaleLowerCase())) category.tags.push({ id: `custom-${createHash('sha256').update(categoryId + ':' + name).digest('hex').slice(0, 16)}`, name });
    merged.approvals = { ...merged.approvals, [number]: { category: categoryId, name } };
    const text = JSON.stringify(merged, null, 2) + '\n';
    const { data: result } = await this.gh.request(this.gh.contentEndpoint(TAGS_PATH), { method: 'PUT', body: JSON.stringify({ message: `批准标签申请 #${number}：${name}`, content: Buffer.from(text).toString('base64'), branch, ...(sha ? { sha } : {}) }) });
    if (!result.content?.sha) throw new Error('标签目录写入结果未知，请刷新后重试');
    return merged;
  }
  async reviewTag({ number, decision, expected } = {}) {
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('无效 Issue 编号，必须为正整数');
    if (!['approve', 'reject'].includes(decision)) throw new Error('审核决定必须是 approve 或 reject');
    if (!(await this.reviewPermission())) throw new Error('只有仓库维护者（maintain）或管理员（admin）可以审核标签申请');
    const { data: issue } = await this.gh.request(`/repos/${this.gh.repo}/issues/${number}`);
    if (issue?.number !== number) throw new Error('GitHub 未返回匹配的标签申请 Issue 编号');
    if (issue?.pull_request) throw new Error('不能审核 Pull Request');
    const request = issueRequest(issue, this.gh.repo);
    if (!request) throw new Error('Issue 不是有效的标签申请');
    if (issue.state === 'closed') throw new Error('标签申请已关闭，不能重复处理');
    if (!expected || typeof expected !== 'object') throw new Error('审核需要最新申请内容快照 expected，请刷新审核列表');
    if (String(expected.category) !== request.category || expected.name !== request.name || (expected.updatedAt && expected.updatedAt !== issue.updated_at)) {
      throw new Error('标签申请内容已变化，请刷新审核列表后重试');
    }
    if (decision === 'approve') {
      const catalogState = await this.catalogData();
      const category = catalogState.catalog.categories.find(item => String(item.id) === request.category);
      if (!category) throw new Error('申请分类不在当前分类目录中，拒绝批准');
      const name = normalizeName(request.name);
      try {
        await this.saveCatalog(name, request.category, number, catalogState);
      } catch (error) {
        if (error.status === 409 || error.status === 422) throw new Error(`标签目录并发冲突，请刷新后重试：${error.message}`, { cause: error });
        throw error;
      }
    }
    try {
      await this.gh.request(`/repos/${this.gh.repo}/issues/${number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
    } catch (error) {
      if (decision === 'approve') throw new Error(`标签已批准并写入目录，但关闭申请 Issue 失败（待关闭，可重试）：${error.message}`, { cause: error });
      throw error;
    }
    return { number, decision, approved: decision === 'approve', closed: true };
  }
}

module.exports = { Tags, MARKER, parseRequest, mergeCatalog, normalizeName };
