const { _electron: electron } = require('playwright');
const path=require('node:path');const fs=require('node:fs');
(async()=>{
  const preview=process.argv.includes('--preview');
  delete process.env.ELECTRON_RUN_AS_NODE;
  const app=await electron.launch({executablePath:process.argv.includes('--packaged')?path.resolve(__dirname,'../release/QMX-Notebook-win32-x64/QMX-Notebook.exe'):require('electron'),args:['--disable-gpu','--no-sandbox',...(process.argv.includes('--packaged')?[]:[path.resolve(__dirname,'..')]),...(preview?['--preview']:[]),'--user-data-dir='+path.resolve(__dirname,'../.test-profile')],env:{...process.env},timeout:30000});
  try {
    const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.waitForSelector('#record-list');await page.waitForTimeout(600);
    fs.mkdirSync(path.resolve(__dirname,'../screenshots'),{recursive:true});
    for(const theme of ['light','dark','cards']){await page.selectOption('#theme-select',theme);await page.screenshot({path:path.resolve(__dirname,`../screenshots/${preview?'preview':'desktop'}-${theme}.png`)});}
    if(!preview){await page.click('[data-view="mine"]');await page.click('#submit-button');await page.fill('[name="url"]','https://codeforces.com/problemset/problem/1/A');await page.fill('[name="title"]','本地验证：整数溢出');await page.fill('[name="reason"]','面积相乘可能超出 int，应使用 long long。');await page.click('#save-local-button');await page.waitForTimeout(500);if(!(await page.locator('#record-list').innerText()).includes('本地验证'))throw new Error('本地保存后列表未出现记录');await page.click('#settings-button');if(!await page.locator('[name="clientId"]').count())throw new Error('缺少授权配置');await page.click('[data-close="settings-dialog"]');await page.click('#sync-button');await page.waitForTimeout(3500);}
    if(errors.length)throw new Error(errors.join('\n'));console.log('DESKTOP PASS '+(preview?'style previews':'local save, settings, sync')+'; screenshot saved');
  }finally{await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
