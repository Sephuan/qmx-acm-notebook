'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require('playwright');
const search = require('../ui/search.js');
assert.equal(search.tagHits({tags:['a','a','b']}, new Set(['a','b'])), 2);
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1500,height:1000}}); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
   const repo='test/tags'; const catalog={version:'test',source:'fixture',categories:[{id:'dp',name:'动态规划',tags:[{id:'a',name:'甲'},{id:'b',name:'乙'}]}]};
   const docs=[{id:'one',title:'关键词',tags:['甲'],updatedAt:'2026-11-04'}, {id:'two',title:'第二题',body:'关键词',tags:['甲','乙'],updatedAt:'2025-01-01'}, {id:'three',title:'历史题',tags:['旧标签'],updatedAt:'2026-01-01'}].map(r=>({kind:'document',repo,path:r.id+'.md',sha:'sha',authorId:1,author:'user',body:r.body||'# 完整题解\n\n末尾完整内容',problemUrl:'https://example.com',...r}));
   window.fixture={calls:[]}; const payload=()=>({records:docs,local:{records:[],favorites:[],mastery:{},draft:{}},settings:{autoSync:false},account:{id:1,login:'user'},permissions:{repo,push:true,admin:true},tagCatalog:catalog,authStatus:{status:'expired'}});
   window.notebook={bootstrap:async()=>payload(),updateLocal:async data=>fixture.calls.push(['local',data]),requestTag:async data=>fixture.calls.push(['request',data]),getTagCatalog:async()=>catalog,getTagReview:async()=>({canReview:true,requests:[{number:9,category:'dp',name:'丙',author:'user',state:'open',expected:{category:'dp',name:'丙',updatedAt:'stamp'}}]}),reviewTag:async data=>fixture.calls.push(['review',data])};
  });
  await page.goto(pathToFileURL(path.resolve(__dirname,'../ui/index.html')).href); await page.waitForSelector('.record-card');
  assert.match(await page.locator('#account-caption').innerText(),/过期/);
  await page.locator('#tag-filter-trigger').click(); await page.locator('#tag-picker-dialog-options input[value="甲"]').check(); await page.locator('#tag-picker-dialog-options input[value="乙"]').check(); await page.locator('#tag-picker-confirm').click();
  assert.equal(await page.locator('.record-card').first().getAttribute('data-key'),'two'); assert.match((await page.locator('#tag-filter-trigger').innerText()).trim(),/^标签\s*⌄$/);
  await page.locator('#search-input').fill('关键词'); assert.equal(await page.locator('.record-card').first().getAttribute('data-key'),'two');
  await page.locator('#tag-filter-trigger').click(); await page.locator('#tag-picker-cancel').click();
  await page.locator('.record-card').first().dblclick(); assert.equal(await page.locator('body').evaluate(e=>e.classList.contains('reading-detail')),true);
  await page.locator('.mastery-buttons button').last().click(); await page.locator('#detail-back-button').click();
  assert.equal(await page.locator('#search-input').inputValue(),'关键词'); assert.equal(await page.locator('.record-card.selected').getAttribute('data-key'),'two'); assert.match((await page.locator('#tag-filter-trigger').innerText()).trim(),/^标签\s*⌄$/);
  await page.locator('.record-card.selected').focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
  for(const theme of ['light','dark','cards']) {await page.selectOption('#theme-select',theme); assert.equal(await page.locator('#record-list').evaluate(n=>getComputedStyle(n).display),'grid');}
  await page.locator('#submit-button').click(); assert.equal(await page.locator('[name="tags"]').getAttribute('type'),'hidden'); await page.locator('#record-tag-open').click(); assert.match(await page.locator('#tag-picker-dialog-options').innerText(),/旧标签 · 历史/);
  await page.locator('#tag-picker-dialog-options input[value="甲"]').check(); await page.locator('#tag-picker-dialog-options input[value="乙"]').check(); assert.equal(await page.locator('[name="tags"]').inputValue(),''); await page.locator('#tag-picker-confirm').click(); assert.equal(await page.locator('[name="tags"]').inputValue(),'甲, 乙');
  await page.locator('#request-tag-open').click(); await page.locator('#request-tag-dialog-name').fill('新算法'); await page.locator('#tag-request-form button[type="submit"]').click();
  assert.deepEqual(await page.evaluate(()=>fixture.calls.find(c=>c[0]==='request')[1]),{category:'dp',name:'新算法'});
  await page.locator('#request-tag-open').click(); await page.getByRole('button',{name:'批准',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>fixture.calls.find(c=>c[0]==='review')[1]),{number:9,decision:'approve',expected:{category:'dp',name:'丙',updatedAt:'stamp'}});
  assert.deepEqual(errors,[]); console.log('UI GRID/TAGS PASS: OR hit ordering, relevance tie, classified/history multi-select, reader return/keyboard, auth expiry, request/review expected, themes');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
