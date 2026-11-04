const YAML = require('yaml');
const { Tags } = require('./tags.cjs');

const API = 'https://api.github.com';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function repoParts(repo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error('仓库格式应为 owner/repo');
  return repo.split('/');
}

function identify(url) {
  try {
    const u = new URL(url);
    let m;
    if (/(^|\.)codeforces\.com$/.test(u.hostname)) {
      m = u.pathname.match(/\/(?:problemset\/problem|contest|gym)\/(\d+)\/(?:problem\/)?([A-Za-z]\d*)/);
      if (m) return { pid: `CF${m[1]}${m[2].toUpperCase()}`, platform: 'CF' };
    }
    if (u.hostname === 'atcoder.jp' && (m = u.pathname.match(/\/tasks\/([\w-]+)/))) return { pid: m[1], platform: 'AT' };
    if (/(^|\.)luogu\.com\.cn$/.test(u.hostname) && (m = u.pathname.match(/\/problem\/([\w-]+)/))) return { pid: m[1], platform: 'LG' };
    if (/(^|\.)nowcoder\.com$/.test(u.hostname)) return { pid: u.pathname.split('/').filter(Boolean).slice(-2).join('-'), platform: 'NC' };
    return { pid: '', platform: 'Oth' };
  } catch {
    return { pid: '', platform: 'Oth' };
  }
}

function frontmatter(text, strict = false) {
  const source = String(text).replace(/^\uFEFF/, '');
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { meta: {}, body: source };
  try {
    const meta = YAML.parse(match[1]) || {};
    if (typeof meta !== 'object' || Array.isArray(meta)) throw new Error('元数据必须是对象');
    return { meta, body: source.slice(match[0].length) };
  } catch (error) {
    if (strict) throw new Error(`Markdown 元数据无法解析：${error.message}`);
    return { meta: {}, body: source.slice(match[0].length) };
  }
}

function authorId(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseDocument(path, text, extra = {}) {
  const { meta, body } = frontmatter(text);
  return {
    id: `document:${path}`, kind: 'document', path,
    title: String(meta.title || path.split('/').pop().replace(/\.md$/i, '')),
    pid: String(meta.pid || ''), platform: String(meta.platform || (path.startsWith('algorithms/') ? '算法' : 'Oth')),
    rating: Number(meta.rating) > 0 && Number.isFinite(Number(meta.rating)) ? Number(meta.rating) : null,
    difficulty: String(meta.difficulty || ''), tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
    author: String(meta.author || '未知'), authorId: authorId(meta.author_id),
    problemUrl: String(meta.problem_url || meta.problemUrl || ''), clientId: String(meta.client_id || ''),
    managed: meta.schema === 2 && authorId(meta.author_id) !== null,
    schema: meta.schema ?? null, body, updatedAt: String(meta.updated_at || meta.date || ''), ...extra,
  };
}

function issueRecord(x) {
  const text = x.body || '';
  const metaMatch = text.match(/<!-- qmx-record\s*([\s\S]*?)\s*-->/);
  let meta = {};
  if (metaMatch) { try { meta = JSON.parse(metaMatch[1]); } catch {} }
  return {
    id: `issue:${x.number}`, kind: 'issue', number: x.number, title: x.title,
    pid: String(meta.pid || ''), platform: String(meta.platform || 'Oth'),
    rating: Number.isFinite(Number(meta.rating)) && Number(meta.rating) > 0 ? Number(meta.rating) : null,
    difficulty: String(meta.difficulty || ''),
    tags: [...new Set([...(Array.isArray(meta.tags) ? meta.tags.map(String) : []), ...(x.labels || []).map(l => typeof l === 'string' ? l : l.name)])],
    author: x.user?.login || '', authorId: authorId(x.user?.id),
    body: text.replace(/<!-- qmx-record[\s\S]*?-->/g, ''), url: x.html_url,
    updatedAt: x.updated_at, comments: x.comments, state: x.state, problemUrl: meta.problemUrl || '',
  };
}

function issueBody(record) {
  const found = identify(record.problemUrl || record.url || '');
  const meta = { schema: 1, pid: record.pid || found.pid, platform: record.platform || found.platform, tags: record.tags || [], problemUrl: record.problemUrl || '', cohort: record.cohort || '', rating: Number(record.rating) > 0 ? Number(record.rating) : null, difficulty: record.difficulty || '' };
  const text = `<!-- qmx-record ${JSON.stringify(meta).replace(/-->/g, '')} -->\n\n${record.problemUrl ? `题目链接：${record.problemUrl}\n\n` : ''}## 错因\n\n${record.reason || ''}\n\n## 题解与代码\n\n${record.solution || ''}\n\n## 个人 trick\n\n${record.trick || ''}`;
  if (text.length > 60000) throw new Error('内容过长，请控制在 60000 字符以内');
  return text;
}

// Retained for consumers that generate the original formal-document template.
function documentContent(r, author) {
  const found = identify(r.problemUrl || '');
  const pid = r.pid || found.pid;
  if (!pid) throw new Error('正式题解需要题号，请补充题号');
  const platform = r.platform || found.platform;
  return { platform, pid, text: `---\n${YAML.stringify({ pid, title: r.title || pid, platform, rating: Number(r.rating) > 0 ? Number(r.rating) : null, difficulty: r.difficulty || '', tags: r.tags || [], author, date: new Date().toISOString().slice(0, 10) })}---\n\n# 题意\n\n${r.problemUrl || ''}\n\n## 思路\n\n${r.solution || ''}\n\n## 正确性\n\n${r.proof || '待补充'}\n\n## 复杂度\n\n${r.complexity || '待补充'}\n\n## 易错点\n\n${r.reason || ''}\n\n## 个人 trick\n\n${r.trick || ''}\n` };
}

function validatePath(path) {
  if (typeof path !== 'string' || !/^(problems|algorithms)\/.+\.md$/i.test(path)
      || /[\\%?#\u0000-\u001f\u007f]/.test(path)
      || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('文档路径必须位于 problems/ 或 algorithms/ 下，使用 .md 扩展名且不能包含路径穿越');
  }
  return path;
}

function samePayload(a, b) {
  const comparable = text => {
    const { meta, body } = frontmatter(text, true);
    delete meta.updated_at;
    const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
    return JSON.stringify({ meta: stable(meta), body });
  };
  return comparable(a) === comparable(b);
}

class GitHub {
  constructor({ token = '', repo = 'qmx-acm-data/2026', fetcher = fetch } = {}) {
    repoParts(repo);
    this.repo = repo;
    this.token = token;
    this.fetcher = fetcher;
  }

  async request(path, opts = {}) {
    let r;
    try {
      r = await this.fetcher(API + path, {
        ...opts,
        headers: {
          Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'QMX-Notebook',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...opts.headers,
        },
        signal: AbortSignal.timeout(25000),
      });
    } catch (error) {
      if (opts.method && opts.method !== 'GET') throw new Error('GitHub 写入结果未知（网络中断或超时）；请先同步确认结果，不要重复创建文档。', { cause: error });
      throw new Error('GitHub 请求超时或网络中断，请同步后重试', { cause: error });
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      let message;
      if (r.status === 401) message = 'GitHub 登录已失效，请重新授权';
      else if (r.status === 403 || r.status === 429) {
        const reset = r.headers.get('x-ratelimit-reset');
        message = data.message?.includes('rate limit')
          ? `GitHub 请求额度已用完${reset ? '，预计 ' + new Date(Number(reset) * 1000).toLocaleTimeString() + ' 恢复' : ''}，缓存仍可使用`
          : 'GitHub 拒绝操作，请检查仓库写入权限、默认分支保护规则、授权范围或组织 OAuth 策略';
      } else if (r.status === 404) message = '找不到仓库或内容，也可能没有访问权限';
      else if (r.status === 409 || r.status === 422) message = `GitHub 内容冲突，请先同步后再编辑：${data.message || '文件已变化'}`;
      else message = `GitHub ${r.status}：${data.message || '请求失败'}`;
      const error = new Error(message);
      error.status = r.status;
      throw error;
    }
    return { data, link: r.headers.get('link') || '' };
  }

  async pages(path, max = 100) {
    const all = [];
    for (let page = 1; page <= max; page++) {
      const { data, link } = await this.request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      if (!Array.isArray(data)) throw new Error('GitHub 返回了意外的数据格式');
      all.push(...data);
      if (!link.includes('rel="next"')) return all;
    }
    throw new Error('数据量超过单次同步上限，请缩小仓库范围');
  }

  async profile() {
    if (!this.token) throw new Error('请先登录 GitHub');
    const { data: user } = await this.request('/user');
    if (!authorId(user.id) || !user.login) throw new Error('无法确认 GitHub 登录用户身份，请重新登录');
    const { data: info } = await this.request(`/repos/${this.repo}`);
    return {
      account: { id: user.id, login: user.login, name: user.name || user.login, avatarUrl: user.avatar_url || '' },
      permissions: { push: Boolean(info.permissions?.push || info.permissions?.admin), admin: Boolean(info.permissions?.admin), repo: this.repo },
    };
  }

  checkScope(record) {
    if (record.repo !== undefined && (typeof record.repo !== 'string' || record.repo.toLowerCase() !== this.repo.toLowerCase())) {
      throw new Error('文档所属仓库与当前仓库不一致，请切换仓库并同步');
    }
  }

  async writeContext() {
    if (!this.token) throw new Error('请先登录 GitHub');
    const { data: user } = await this.request('/user');
    if (!authorId(user.id) || !user.login) throw new Error('无法确认 GitHub 登录用户身份，请重新登录');
    const { data: info } = await this.request(`/repos/${this.repo}`);
    if (!info.permissions?.push && !info.permissions?.admin) throw new Error('当前账号没有该仓库的写入权限（push），请联系仓库管理员授权');
    if (!info.default_branch) throw new Error('仓库尚无默认分支，请先初始化仓库');
    return { user, branch: info.default_branch };
  }

  contentEndpoint(path) {
    return `/repos/${this.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  async currentDocument(path, branch) {
    try {
      const { data } = await this.request(`${this.contentEndpoint(path)}?ref=${encodeURIComponent(branch)}`);
      if (data.type !== 'file' || data.encoding !== 'base64' || typeof data.content !== 'string' || !data.sha) throw new Error('GitHub 未返回完整 Markdown 文件，请同步后重试');
      return { sha: data.sha, text: Buffer.from(data.content, 'base64').toString('utf8') };
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  checkOwner(text, user) {
    const { meta } = frontmatter(text, true);
    if (!authorId(meta.author_id)) throw new Error('旧文档缺少可信的 author_id，无法确认所有权；请联系维护者迁移文档元数据');
    if (meta.author_id !== user.id) throw new Error('只能修改或删除自己创建的文档（author_id 与登录账号不一致）');
    return meta;
  }

  recordResult(path, text, sha, branch) {
    return parseDocument(path, text, {
      sha, repo: this.repo, branch,
      url: `https://github.com/${this.repo}/blob/${encodeURIComponent(branch)}/${path.split('/').map(encodeURIComponent).join('/')}`,
    });
  }

  async saveDocument(record) {
    this.checkScope(record);
    if (record.path !== undefined) validatePath(record.path);
    if (record.path !== undefined && (typeof record.sha !== 'string' || !record.sha.trim())) throw new Error('更新文档必须提供当前 SHA，请先同步');
    if (record.body !== undefined && typeof record.body !== 'string') throw new Error('Markdown 正文必须是字符串');
    const { user, branch } = await this.writeContext();
    const found = identify(record.problemUrl || '');
    const clientId = record.clientId;
    if (!record.path && (typeof clientId !== 'string' || !UUID.test(clientId))) throw new Error('新建文档必须提供有效的 UUID clientId，请保留同一个记录 ID 后重试');
    const path = record.path || `problems/qmx/${user.id}/${clientId.toLowerCase()}.md`;
    const current = await this.currentDocument(path, branch);
    if (record.path && !current) throw new Error('文档已被删除或移动，请先同步');
    const previous = current ? this.checkOwner(current.text, user) : {};
    if (record.path && current.sha !== record.sha) throw new Error('文档 SHA 冲突：文件已被更新，请先同步后再编辑');
    if (!record.path && current && previous.client_id !== clientId.toLowerCase()) throw new Error('目标路径已存在且 clientId 不匹配，请同步');
    const supplied = record.body === undefined ? null : frontmatter(record.body, true);
    const value = (key, fallback) => {
      const metadataKey = key === 'problemUrl' ? 'problem_url' : key;
      return record[key] !== undefined ? record[key] : supplied?.meta[metadataKey] !== undefined ? supplied.meta[metadataKey] : fallback;
    };
    const meta = {
      ...previous, ...(supplied?.meta || {}), schema: 2, author_id: user.id, author: user.login,
      title: value('title', previous.title || record.pid || found.pid || '未命名文档'),
      pid: value('pid', previous.pid || found.pid), platform: value('platform', previous.platform || found.platform),
      tags: value('tags', previous.tags || []), rating: value('rating', previous.rating ?? null),
      difficulty: value('difficulty', previous.difficulty || ''),
      problem_url: value('problemUrl', previous.problem_url || previous.problemUrl || ''),
      client_id: record.path ? (previous.client_id || '') : clientId.toLowerCase(), updated_at: new Date().toISOString(),
    };
    if (!Array.isArray(meta.tags)) throw new Error('标签必须是数组');
    meta.tags = meta.tags.map(String);
    meta.rating = Number(meta.rating) > 0 && Number.isFinite(Number(meta.rating)) ? Number(meta.rating) : null;
    const body = supplied ? supplied.body : record.path ? frontmatter(current.text, true).body
      : `## 错因\n\n${record.reason || ''}\n\n## 题解与代码\n\n${record.solution || ''}\n\n## 个人 trick\n\n${record.trick || ''}`;
    const text = `---\n${YAML.stringify(meta)}---\n${body}`;
    if (text.length > 1000000) throw new Error('文档内容过长，请控制在 1000000 字符以内');
    if (!record.path && current) {
      if (!samePayload(current.text, text)) throw new Error('同一 clientId 的文档已存在，但内容不同；请先同步，使用当前路径和 SHA 编辑');
      return this.recordResult(path, current.text, current.sha, branch);
    }
    const { data } = await this.request(this.contentEndpoint(path), {
      method: 'PUT', body: JSON.stringify({
        message: `${current ? '更新' : '新增'}文档：${meta.title}`, content: Buffer.from(text).toString('base64'), branch,
        ...(current ? { sha: current.sha } : {}),
      }),
    });
    if (!data.content?.sha) throw new Error('GitHub 写入结果未知，请先同步确认结果，不要重复创建文档');
    return this.recordResult(path, text, data.content.sha, branch);
  }

  async deleteDocument(record) {
    this.checkScope(record);
    const path = validatePath(record.path);
    if (typeof record.sha !== 'string' || !record.sha.trim()) throw new Error('删除文档必须提供当前 SHA，请先同步');
    const { user, branch } = await this.writeContext();
    const current = await this.currentDocument(path, branch);
    if (!current) throw new Error('文档已不存在，请先同步');
    this.checkOwner(current.text, user);
    if (current.sha !== record.sha) throw new Error('文档 SHA 冲突：文件已被更新，请先同步后再删除');
    await this.request(this.contentEndpoint(path), {
      method: 'DELETE', body: JSON.stringify({ message: `删除文档：${path}`, sha: current.sha, branch }),
    });
    return { id: `document:${path}`, path, repo: this.repo, deleted: true };
  }

  async deleteIssue(record) {
    this.checkScope(record);
    const { number } = record;
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('无效 Issue 编号，必须为正整数');
    if (!this.token) throw new Error('请先登录 GitHub');
    const { data: user } = await this.request('/user');
    if (!authorId(user.id) || !user.login) throw new Error('无法确认 GitHub 登录用户身份，请重新登录');
    const { data: info } = await this.request(`/repos/${this.repo}`);
    if (info.permissions?.admin !== true) throw new Error('只有仓库管理员（admin）可以永久删除 Issue');
    const { data: issue } = await this.request(`/repos/${this.repo}/issues/${number}`);
    if (issue?.pull_request) throw new Error('不能通过删除 Issue 操作删除 Pull Request');
    if (issue?.number !== number || typeof issue.node_id !== 'string' || !issue.node_id.trim()) {
      throw new Error('GitHub 未返回匹配的 Issue 编号和 node_id，请先同步后重试');
    }
    const permissionHint = '请检查令牌授权范围、组织策略及组织允许管理员删除 Issue 的设置（Allow members to delete issues）';
    let data;
    try {
      ({ data } = await this.request('/graphql', {
        method: 'POST', body: JSON.stringify({
          query: 'mutation DeleteIssue($issueId: ID!) { deleteIssue(input: { issueId: $issueId }) { clientMutationId } }',
          variables: { issueId: issue.node_id },
        }),
      }));
    } catch (error) {
      if (error.status === 403) throw new Error(`GitHub 拒绝删除 Issue；${permissionHint}`, { cause: error });
      if (error.cause) throw new Error('GitHub 删除 Issue 结果未知（网络中断或超时）；请先同步确认结果，不要自动重试删除。', { cause: error });
      throw error;
    }
    if (Array.isArray(data?.errors) && data.errors.length) {
      const details = data.errors.map(error => String(error?.message || error?.type || '未知 GraphQL 错误')).join('；');
      throw new Error(`GitHub 删除 Issue 失败：${details}；${permissionHint}`);
    }
    if (!data?.data?.deleteIssue || typeof data.data.deleteIssue !== 'object') {
      throw new Error('GitHub 删除 Issue 结果未知；请先同步确认结果，不要自动重试删除。');
    }
    return { id: `issue:${number}`, number, repo: this.repo, deleted: true };
  }

  async sync(previous = {}) {
    const { data: info } = await this.request(`/repos/${this.repo}`);
    const branch = info.default_branch;
    const [{ data: tree }, issues] = await Promise.all([
      this.request(`/repos/${this.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`),
      this.pages(`/repos/${this.repo}/issues?state=all&sort=updated&direction=desc`),
    ]);
    if (tree.truncated) throw new Error('仓库目录过大，GitHub 未返回完整文件树');
    const docs = tree.tree.filter(x => {
      if (x.type !== 'blob') return false;
      try { validatePath(x.path); return true; } catch { return false; }
    });
    const blobs = { ...previous.blobs };
    const records = [];
    for (let start = 0; start < docs.length; start += 4) {
      records.push(...await Promise.all(docs.slice(start, start + 4).map(async d => {
        let text = blobs[d.sha];
        if (text === undefined) {
          const { data } = await this.request(`/repos/${this.repo}/git/blobs/${d.sha}`);
          text = Buffer.from(data.content, 'base64').toString('utf8');
          blobs[d.sha] = text;
        }
        return this.recordResult(d.path, text, d.sha, branch);
      })));
    }
    return {
      records, issues: issues.filter(x => !x.pull_request && !/<!--\s*qmx-tag-request\s+[\s\S]*?-->/i.test(String(x.body || ''))).map(x => ({ ...issueRecord(x), repo: this.repo })),
      blobs: Object.fromEntries(docs.map(d => [d.sha, blobs[d.sha]])), branch, lastSync: new Date().toISOString(),
    };
  }

  // Legacy entry points now publish Markdown directly instead of opening Issues or PRs.
  async submit(record) { return this.saveDocument(record); }
  async propose(record) { return this.saveDocument(record); }

  async getTagCatalog() { return new Tags(this).getTagCatalog(); }
  async requestTag(data) { return new Tags(this).requestTag(data); }
  async getTagReview() { return new Tags(this).getTagReview(); }
  async reviewTag(data) { return new Tags(this).reviewTag(data); }

  async comments(number) {
    if (!Number.isInteger(Number(number)) || Number(number) < 1) throw new Error('无效题目编号');
    return this.pages(`/repos/${this.repo}/issues/${number}/comments`);
  }

  async comment({ number, body }) {
    if (!this.token) throw new Error('请先登录 GitHub');
    if (!body?.trim()) throw new Error('请填写评论');
    if (!Number.isInteger(Number(number)) || Number(number) < 1) throw new Error('无效题目编号');
    await this.request('/user');
    return (await this.request(`/repos/${this.repo}/issues/${number}/comments`, { method: 'POST', body: JSON.stringify({ body }) })).data;
  }
}

module.exports = { GitHub, repoParts, identify, parseDocument, issueRecord, issueBody, documentContent };
