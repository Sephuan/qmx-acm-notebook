const YAML = require('yaml');
const API = 'https://api.github.com';
function repoParts(repo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error('仓库格式应为 owner/repo');
  return repo.split('/');
}
function identify(url) {
  try {
    const u = new URL(url); let m;
    if (/(^|\.)codeforces\.com$/.test(u.hostname)) {
      m = u.pathname.match(/\/(?:problemset\/problem|contest|gym)\/(\d+)\/(?:problem\/)?([A-Za-z]\d*)/);
      if (m) return { pid: `CF${m[1]}${m[2].toUpperCase()}`, platform: 'CF' };
    }
    if (u.hostname === 'atcoder.jp' && (m=u.pathname.match(/\/tasks\/([\w-]+)/))) return {pid:m[1],platform:'AT'};
    if (/(^|\.)luogu\.com\.cn$/.test(u.hostname) && (m=u.pathname.match(/\/problem\/([\w-]+)/))) return {pid:m[1],platform:'LG'};
    if (/(^|\.)nowcoder\.com$/.test(u.hostname)) return {pid: u.pathname.split('/').filter(Boolean).slice(-2).join('-'),platform:'NC'};
    return {pid:'',platform:'Oth'};
  } catch {return {pid:'',platform:'Oth'};}
}
function parseDocument(path, text, extra={}) {
  let meta={}, body=text;
  const match=text.replace(/^\uFEFF/,'').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (match) { try {meta=YAML.parse(match[1]) || {};} catch {} body=text.replace(/^\uFEFF/,'').slice(match[0].length); }
  return {id:`document:${path}`,kind:'document',path,title:String(meta.title || path.split('/').pop().replace(/\.md$/,'')),pid:String(meta.pid || ''),platform:String(meta.platform || (path.startsWith('algorithms/')?'算法':'Oth')),rating:Number.isFinite(Number(meta.rating)) && Number(meta.rating)>0?Number(meta.rating):null,difficulty:String(meta.difficulty || ''),tags:Array.isArray(meta.tags)?meta.tags.map(String):[],author:String(meta.author || '未知'),body,updatedAt:String(meta.date || ''),...extra};
}
function issueRecord(x) {
  const text=x.body || ''; const metaMatch=text.match(/<!-- qmx-record\s*([\s\S]*?)\s*-->/); let meta={};
  if (metaMatch) {try {meta=JSON.parse(metaMatch[1]);}catch {}}
  return {id:`issue:${x.number}`,kind:'issue',number:x.number,title:x.title,pid:String(meta.pid || ''),platform:String(meta.platform || 'Oth'),rating:Number.isFinite(Number(meta.rating)) && Number(meta.rating)>0?Number(meta.rating):null,difficulty:String(meta.difficulty || ''),tags:[...new Set([...(Array.isArray(meta.tags)?meta.tags.map(String):[]),...(x.labels||[]).map(l=>typeof l==='string'?l:l.name)])],author:x.user?.login || '',body:text.replace(/<!-- qmx-record[\s\S]*?-->/g,''),url:x.html_url,updatedAt:x.updated_at,comments:x.comments,state:x.state,problemUrl:meta.problemUrl || ''};
}
function issueBody(record) {
  const found=identify(record.problemUrl || record.url || '');
  const meta={schema:1,pid:record.pid || found.pid,platform:record.platform || found.platform,tags:record.tags || [],problemUrl:record.problemUrl || '',cohort:record.cohort || '',rating:Number(record.rating)>0?Number(record.rating):null,difficulty:record.difficulty || ''};
  const text=`<!-- qmx-record ${JSON.stringify(meta).replace(/-->/g,'')} -->\n\n${record.problemUrl ? `题目链接：${record.problemUrl}\n\n`:''}## 错因\n\n${record.reason || ''}\n\n## 题解与代码\n\n${record.solution || ''}\n\n## 个人 trick\n\n${record.trick || ''}`;
  if (text.length>60000) throw new Error('内容过长，请控制在 60000 字符以内');
  return text;
}
function documentContent(r,author) {
  const found=identify(r.problemUrl || ''); const pid=r.pid || found.pid;
  if (!pid) throw new Error('正式题解需要题号，请补充题号');
  const platform=r.platform || found.platform;
  return {platform,pid,text:`---\n${YAML.stringify({pid,title:r.title || pid,platform,rating:Number(r.rating)>0?Number(r.rating):null,difficulty:r.difficulty || '',tags:r.tags || [],author,date:new Date().toISOString().slice(0,10)})}---\n\n# 题意\n\n${r.problemUrl || ''}\n\n## 思路\n\n${r.solution || ''}\n\n## 正确性\n\n${r.proof || '待补充'}\n\n## 复杂度\n\n${r.complexity || '待补充'}\n\n## 易错点\n\n${r.reason || ''}\n\n## 个人 trick\n\n${r.trick || ''}\n`};
}
class GitHub {
  constructor({token='',repo='qmx-acm-data/2026',fetcher=fetch}={}) {repoParts(repo);this.repo=repo;this.token=token;this.fetcher=fetcher;}
  async request(path,opts={}) {
    const r=await this.fetcher(API+path,{...opts,headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'QMX-Notebook',...(this.token?{Authorization:`Bearer ${this.token}`} : {}),...(opts.body?{'Content-Type':'application/json'}:{}),...opts.headers},signal:AbortSignal.timeout(25000)});
    const data=await r.json().catch(()=>({}));
    if (!r.ok) {
      if(r.status===401) throw new Error('GitHub 登录已失效，请重新授权');
      if(r.status===403 || r.status===429) {const reset=r.headers.get('x-ratelimit-reset');throw new Error(data.message?.includes('rate limit')?`GitHub 请求额度已用完${reset?'，预计 '+new Date(Number(reset)*1000).toLocaleTimeString()+' 恢复':''}，缓存仍可使用`:'GitHub 拒绝操作，请检查授权范围、仓库权限或组织 OAuth 策略');}
      if(r.status===404) throw new Error('找不到仓库或内容，也可能没有访问权限');
      throw new Error(`GitHub ${r.status}：${data.message || '请求失败'}`);
    }
    return {data,link:r.headers.get('link') || ''};
  }
  async pages(path,max=100) {
    let all=[];
    for(let page=1;page<=max;page++) {const {data,link}=await this.request(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${page}`);if(!Array.isArray(data)) throw new Error('GitHub 返回了意外的数据格式');all.push(...data);if(!link.includes('rel="next"'))return all;}
    throw new Error('数据量超过单次同步上限，请缩小仓库范围');
  }
  async sync(previous={}) {
    const {data:info}=await this.request(`/repos/${this.repo}`); const branch=info.default_branch;
    const [{data:tree},issues]=await Promise.all([this.request(`/repos/${this.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`),this.pages(`/repos/${this.repo}/issues?state=all&sort=updated&direction=desc`)]);
    if(tree.truncated) throw new Error('仓库目录过大，GitHub 未返回完整文件树');
    const docs=tree.tree.filter(x=>x.type==='blob' && /^(problems|algorithms)\/.+\.md$/i.test(x.path));
    let blobs={...previous.blobs},records=[];
    for(let start=0;start<docs.length;start+=4) {
      const rows=await Promise.all(docs.slice(start,start+4).map(async d=> {let text=blobs[d.sha];if(text===undefined){const {data}=await this.request(`/repos/${this.repo}/git/blobs/${d.sha}`);text=Buffer.from(data.content,'base64').toString('utf8');blobs[d.sha]=text;}return parseDocument(d.path,text,{sha:d.sha,url:`https://github.com/${this.repo}/blob/${encodeURIComponent(branch)}/${d.path.split('/').map(encodeURIComponent).join('/')}`});}));records.push(...rows);
    }
    return {records:[...records,...issues.filter(x=>!x.pull_request).map(issueRecord)],blobs:Object.fromEntries(docs.map(d=>[d.sha,blobs[d.sha]])),branch,lastSync:new Date().toISOString()};
  }
  async submit(r) { if(!this.token)throw new Error('请先登录 GitHub');if(!r.reason?.trim())throw new Error('请填写错因');const body=issueBody(r);const found=identify(r.problemUrl || '');const {data}=await this.request(`/repos/${this.repo}/issues`,{method:'POST',body:JSON.stringify({title:r.title || `${r.pid || found.pid || '错题'} · ${r.reason.slice(0,50)}`,body})});return issueRecord(data); }
  async comments(number) {if(!Number.isInteger(Number(number))||Number(number)<1)throw new Error('无效题目编号');return this.pages(`/repos/${this.repo}/issues/${number}/comments`);}
  async comment({number,body}) {if(!this.token)throw new Error('请先登录 GitHub');if(!body?.trim())throw new Error('请填写评论');if(!Number.isInteger(Number(number))||Number(number)<1)throw new Error('无效题目编号');return (await this.request(`/repos/${this.repo}/issues/${number}/comments`,{method:'POST',body:JSON.stringify({body})})).data;}
  async propose(r) {
    if(!this.token)throw new Error('请先登录 GitHub');const {data:user}=await this.request('/user');const doc=documentContent(r,user.login);const {data:source}=await this.request(`/repos/${this.repo}`);const base=source.default_branch;
    const {data:fork}=await this.request(`/repos/${this.repo}/forks`,{method:'POST',body:JSON.stringify({default_branch_only:true})});
    if(fork.full_name===this.repo)throw new Error('目标仓库不能作为自己的 Fork');
    if(fork.parent?.full_name && fork.parent.full_name.toLowerCase()!==this.repo.toLowerCase())throw new Error('Fork 来源不匹配，请检查 GitHub 中的同名仓库');
    const {data:ref}=await this.request(`/repos/${this.repo}/git/ref/heads/${encodeURIComponent(base)}`);const name=`notebook/${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    try {await this.request(`/repos/${fork.full_name}/git/refs`,{method:'POST',body:JSON.stringify({ref:`refs/heads/${name}`,sha:ref.object.sha})});}catch(e){throw new Error(`未能创建提案分支，Fork 可能仍在准备中。请稍后重试。${e.message}`);}
    const safe=s=>s.replace(/[<>:"/\\|?*\u0000-\u001f]/g,'-').slice(0,100);const path=`problems/${['CF','AT','LG','NC','Oth'].includes(doc.platform)?doc.platform:'Oth'}/[题解]${safe(doc.pid)} ${safe(r.title || doc.pid)}-${safe(user.login)}-${Date.now()}.md`;
    await this.request(`/repos/${fork.full_name}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,{method:'PUT',body:JSON.stringify({message:`新增题解：${r.title || doc.pid}`,content:Buffer.from(doc.text).toString('base64'),branch:name})});
    const {data:pr}=await this.request(`/repos/${this.repo}/pulls`,{method:'POST',body:JSON.stringify({title:`[题解] ${r.title || doc.pid}`,head:`${user.login}:${name}`,base,body:'由 QMX Notebook 客户端提交。请维护者审核题解内容和标签。'})});return {url:pr.html_url,number:pr.number};
  }
}
module.exports={GitHub,repoParts,identify,parseDocument,issueRecord,issueBody,documentContent};
