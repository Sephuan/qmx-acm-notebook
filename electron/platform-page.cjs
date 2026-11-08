'use strict';
// Public pages run in an isolated, non-persistent session with no preload or Node access.
function createPublicPageReader({ BrowserWindow }) {
  let sequence = 0;
  return async function readPage(url) {
    const target = new URL(url);
    if(target.protocol !== 'https:' || !['www.luogu.com.cn','ac.nowcoder.com'].includes(target.hostname)) throw new Error('不支持的公开资料地址');
    const window = new BrowserWindow({ show:false, webPreferences:{partition:`public-platform-${process.pid}-${++sequence}`,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true} });
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    const restrict = (event, next) => { try { const u=new URL(next); if(u.protocol!=='https:' || u.hostname!==target.hostname) event.preventDefault(); }catch{event.preventDefault();} };
    window.webContents.on('will-navigate',restrict); window.webContents.on('will-redirect',restrict);
    window.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    let timer;
    const work = async()=>{
      await window.loadURL(target.href);
      let previous='', stable=0;
      for(let i=0;i<35;i++) {
        const snapshot=await window.webContents.executeJavaScript(`(()=>{let publicData;try{const raw=document.getElementById('lentille-context')?.textContent;if(raw&&raw.length<4000000){const c=JSON.parse(raw);if(c.template==='user.show'&&c.status===200){const d=c.data;publicData={dailyCounts:d?.dailyCounts,uid:d?.user?.uid};}}}catch{}return {title:document.title,text:document.body?.innerText||'',links:Array.from(document.querySelectorAll('a[href]')).map(a=>({text:a.innerText,url:a.href})).slice(0,2000),publicData};})()`);
        const ready=target.hostname==='www.luogu.com.cn' ? /通过\s*\n\s*\d/.test(snapshot.text) : /题已通过|次Rating赛/.test(snapshot.text);
        if(ready && snapshot.text===previous && !/加载中/.test(snapshot.text)) stable++; else stable=0;
        if(stable>=2) return snapshot;
        previous=snapshot.text;
        await new Promise(resolve=>setTimeout(resolve,400));
      }
      throw new Error('公开页面未加载完整，可能遇到访问验证或网络限制，请稍后重试');
    };
    try { return await Promise.race([work(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('平台公开页面查询超时，请稍后重试')),25000);})]); }
    finally { clearTimeout(timer); if(!window.isDestroyed()) window.destroy(); }
  };
}
module.exports={createPublicPageReader};
