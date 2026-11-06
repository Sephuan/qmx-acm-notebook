'use strict';
const assert=require('node:assert/strict'); const {chromium}=require('playwright'); const {pathToFileURL}=require('node:url'); const path=require('node:path');
async function navigate(page, view) {
 await page.locator('.sidebar').hover();
 await page.locator('.nav-item[data-view="home"]').click();
 await page.locator(`#home-panel .home-shortcut[data-view="${view}"]`).click();
}
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
 const page=await browser.newPage(); await page.addInitScript(()=>{
 const repo='team/test'; window.fixture={admin:false,deleted:[],fail:false};
 const payload=()=>({settings:{repo,autoSync:false},account:{id:1,login:'alice'},permissions:{repo,admin:fixture.admin,push:true},records:[],issues:[{kind:'issue',id:'issue:7',number:7,repo,title:'Delete test',body:'test discussion'}],local:{records:[],favorites:[],mastery:{},draft:{}}});
 window.notebook={bootstrap:async()=>payload(),refreshAccount:async()=>payload(),getComments:async()=>[],updateLocal:async()=>{},deleteIssue:async r=>{if(fixture.fail)throw new Error('组织未允许删除');fixture.deleted.push(r);return {deleted:true};}};
 });
 await page.goto(pathToFileURL(path.resolve(__dirname,'../ui/index.html')).href); await navigate(page, 'discussion'); assert.equal(await page.locator('#delete-issue-button').count(),0);
 await page.evaluate(()=>fixture.admin=true); await page.click('.sidebar-rail .sidebar-bottom'); await page.click('#account-refresh'); await page.click('[data-close="account-dialog"]'); await navigate(page, 'discussion');
 page.once('dialog',d=>d.dismiss()); await page.click('#delete-issue-button'); assert.equal(await page.evaluate(()=>fixture.deleted.length),0);
 await page.evaluate(()=>fixture.fail=true); page.once('dialog',d=>d.accept());await page.click('#delete-issue-button'); await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('组织未允许删除'));assert.equal(await page.locator('.record-card').count(),1);
 await page.evaluate(()=>fixture.fail=false); page.once('dialog',d=>d.accept());await page.click('#delete-issue-button');await page.waitForFunction(()=>document.querySelectorAll('.record-card').length===0);assert.deepEqual(await page.evaluate(()=>fixture.deleted),[{number:7,repo:'team/test'}]);
 console.log('ISSUE UI PASS: admin-only, cancel, remote failure retains record, confirmed delete removes discussion');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
