const {app,BrowserWindow,ipcMain,shell,safeStorage}=require('electron');
const fs=require('node:fs');const path=require('node:path');const {GitHub,repoParts}=require('./github.cjs');
app.disableHardwareAcceleration();
let win,dir,token='',account=null,loginGeneration=0,writeBusy=false;
const defaults={repo:'qmx-acm-data/2026',clientId:'',theme:'light'};
function read(name,fallback){try{return JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));}catch{return fallback;}}
function save(name,data){const p=path.join(dir,name);fs.writeFileSync(p+'.tmp',JSON.stringify(data,null,2));fs.renameSync(p+'.tmp',p);}
function settings(){return {...defaults,...read('settings.json',{})};}
function local(){return {records:[],favorites:[],mastery:{},draft:{},...read('local.json',{})};}
function client(){return new GitHub({repo:settings().repo,token});}
function state(error){const s=settings(),c=read('cache.json',{});return {records:c.repo===s.repo?c.records||[]:[],lastSync:c.repo===s.repo?c.lastSync:null,settings:s,account,local:local(),error:error||null};}
async function external(url){const u=new URL(url);if(u.protocol!=='https:' || !['github.com','codeforces.com','atcoder.jp','www.luogu.com.cn','luogu.com.cn','ac.nowcoder.com','www.nowcoder.com','contest.codeforces.com'].includes(u.hostname))throw new Error('仅允许打开 GitHub 和受支持题目平台的 HTTPS 链接');await shell.openExternal(u.href);}
function persistAuth(data){if(!safeStorage.isEncryptionAvailable())throw new Error('系统凭据加密不可用，无法安全保存登录');save('auth.json',{encrypted:safeStorage.encryptString(JSON.stringify(data)).toString('base64')});}
async function oauth(endpoint,data){const r=await fetch(`https://github.com/login/${endpoint}`,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error(`GitHub 授权服务错误 ${r.status}`);return r.json();}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function login(){const id=settings().clientId.trim();if(!id)throw new Error('请先在设置中填写队伍 GitHub OAuth 应用的 Client ID，并启用 Device Flow。未配置时仍可离线记录和浏览公开库。');const gen=++loginGeneration;const code=await oauth('device/code',{client_id:id,scope:'public_repo'});if(code.error)throw new Error(code.error_description||code.error);win.webContents.send('auth-progress',{userCode:code.user_code,url:code.verification_uri,expiresIn:code.expires_in});await external(code.verification_uri);let interval=Math.max(5,code.interval||5)*1000;const deadline=Date.now()+code.expires_in*1000;
while(Date.now()<deadline){await pause(interval);if(gen!==loginGeneration)throw new Error('已取消登录');const result=await oauth('oauth/access_token',{client_id:id,device_code:code.device_code,grant_type:'urn:ietf:params:oauth:grant-type:device_code'});if(result.error==='authorization_pending')continue;if(result.error==='slow_down'){interval+=5000;continue;}if(result.error)throw new Error(result.error_description||result.error);if(gen!==loginGeneration)throw new Error('已取消登录');if(!result.access_token)throw new Error('GitHub 未返回凭据');const gh=new GitHub({token:result.access_token,repo:settings().repo});const {data:user}=await gh.request('/user');const a={login:user.login,id:user.id,avatarUrl:user.avatar_url};persistAuth({token:result.access_token,account:a});token=result.access_token;account=a;return a;}throw new Error('授权码已过期，请重新登录');}
async function writeOperation(fn){if(writeBusy)throw new Error('上一项提交正在进行，请勿重复操作');writeBusy=true;try{return await fn();}finally{writeBusy=false;}}
function handle(name,fn){ipcMain.handle(name,async(event,...args)=>{if(event.sender!==win.webContents)throw new Error('非法调用');return fn(...args);});}
function setup(){
handle('bootstrap',()=>state());
handle('sync',async()=>{const repo=settings().repo;const old=read('cache.json',{});const result=await client().sync(old.repo===repo?old:{});if(settings().repo!==repo)throw new Error('仓库配置已改变，请重新同步');save('cache.json',{...result,repo});return state();});
handle('saveSettings',async data=>{const old=settings();const next={...old};if(data.repo!==undefined){repoParts(data.repo);next.repo=data.repo;}if(data.clientId!==undefined){if(!/^[A-Za-z0-9_.-]{0,100}$/.test(data.clientId))throw new Error('Client ID 格式不正确');next.clientId=data.clientId;}if(data.theme!==undefined)next.theme=String(data.theme);if(data.displayName!==undefined)next.displayName=String(data.displayName).slice(0,40);if(data.autoSync!==undefined)next.autoSync=!!data.autoSync;save('settings.json',next);return state();});
handle('updateLocal',data=>{if(!data||typeof data!=='object')throw new Error('本地数据格式错误');if(JSON.stringify(data).length>20000000)throw new Error('本地内容过大');save('local.json',{...local(),...data});return local();});
handle('login',login);
handle('logout',()=>{loginGeneration++;token='';account=null;save('auth.json',{});return state();});
handle('cancelLogin',()=>{loginGeneration++;});
handle('submit',r=>writeOperation(async()=>{const result=await client().submit(r);const s=settings(),cache=read('cache.json',{});if(cache.repo===s.repo){cache.records=[result,...(cache.records||[]).filter(x=>x.id!==result.id)];save('cache.json',cache);}return result;}));
handle('comment',data=>writeOperation(()=>client().comment(data)));
handle('getComments',async number=>(await client().comments(number)).map(x=>({id:x.id,body:x.body,author:x.user?.login||'',user:x.user,createdAt:x.created_at,created_at:x.created_at,url:x.html_url})));
handle('propose',r=>writeOperation(()=>client().propose(r)));
handle('openExternal',external);
handle('exportLocal',async()=>{const {dialog}=require('electron');const result=await dialog.showSaveDialog(win,{defaultPath:'我的错题备份.json',filters:[{name:'JSON',extensions:['json']}]});if(!result.canceled){fs.writeFileSync(result.filePath,JSON.stringify(local(),null,2));return true;}return false;});
}
app.whenReady().then(()=>{dir=app.getPath('userData');fs.mkdirSync(dir,{recursive:true});try{const saved=read('auth.json',{});if(saved.encrypted){const a=JSON.parse(safeStorage.decryptString(Buffer.from(saved.encrypted,'base64')));token=a.token;account=a.account;}}catch{}
win=new BrowserWindow({width:1440,height:940,minWidth:1050,minHeight:700,title:'QMX Notebook · 集训队知识库',backgroundColor:'#f6f7fb',autoHideMenuBar:true,webPreferences:{preload:process.argv.includes('--preview')?undefined:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());setup();win.loadFile(path.join(__dirname,'../ui/index.html'));if(process.argv.includes('--smoke')){win.webContents.on('did-finish-load',()=>{console.log('SMOKE: desktop renderer loaded');});} });
app.on('window-all-closed',()=>{loginGeneration++;app.quit();});
