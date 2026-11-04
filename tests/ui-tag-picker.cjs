'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const repo = 'fixture/tags';
      const docs = [{ id:'d1',title:'one',tags:['甲'],body:'# one' },{ id:'d2',title:'two',tags:['乙'],body:'# two' }].map(r => ({kind:'document',repo,path:r.id+'.md',sha:'sha',authorId:1,author:'user',problemUrl:'https://example.com',...r}));
      window.notebook = { bootstrap: async()=>({records:docs,local:{records:[],favorites:[],mastery:{},draft:{}},settings:{autoSync:false},account:{id:1,login:'user'},permissions:{repo,push:true},tagCatalog:{categories:[{id:'dp',name:'动态规划',tags:[{id:'a',name:'甲'},{id:'b',name:'乙'}]}]}}), updateLocal:async()=>{} };
    });
    await page.goto(pathToFileURL(path.resolve(__dirname,'../ui/index.html')).href);
    await page.waitForSelector('.record-card');
    assert.match((await page.locator('#tag-filter-trigger').innerText()).trim(), /^标签\s*⌄$/);
    assert.equal(await page.locator('#tag-filter-trigger').evaluate(el => {
      const tag = getComputedStyle(el), platform = getComputedStyle(document.querySelector('#platform-filter summary'));
      return ['padding', 'border-radius', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'background-color'].every(key => tag[key] === platform[key]);
    }), true, 'tag trigger matches platform control styling');
    await page.click('#tag-filter-trigger'); assert.equal(await page.locator('#tag-picker-dialog').evaluate(d=>d.open),true);
    await page.locator('#tag-picker-dialog-options input[value="甲"]').check();
    assert.equal(await page.locator('.record-card').count(),2,'selection is staged until confirm');
    await page.click('#tag-picker-cancel'); assert.equal(await page.locator('.record-card').count(),2);
    await page.click('#tag-filter-trigger'); await page.locator('#tag-picker-dialog-options input[value="乙"]').check(); await page.click('#tag-picker-confirm');
    assert.equal(await page.locator('.record-card').count(),1); assert.equal(await page.locator('.record-card').first().getAttribute('data-key'),'d2');
    await page.click('#clear-filters'); await page.click('#submit-button');
    await page.click('#record-tag-open'); await page.locator('#tag-picker-dialog-options input[value="甲"]').check(); await page.click('#tag-picker-close');
    assert.equal(await page.locator('[name="tags"]').inputValue(),'','close cancels editor selections');
    await page.click('#record-tag-open'); await page.locator('#tag-picker-search').fill('乙'); assert.equal(await page.locator('#tag-picker-dialog-options input').count(),1); await page.locator('#tag-picker-dialog-options input[value="乙"]').check(); await page.click('#tag-picker-confirm');
    assert.equal(await page.locator('[name="tags"]').inputValue(),'乙'); assert.deepEqual(errors,[]);
    console.log('TAG PICKER PASS: dialog, category search, multi-select, cancel/close rollback, confirm applies to filter/editor');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
