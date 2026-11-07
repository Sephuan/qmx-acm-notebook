'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createContestService, normalizeContests, CACHE_TTL, RETRY_DELAY } = require('../electron/contests.cjs');
const TIME = Date.parse('2026-11-07T04:00:00Z');
const item = (patch = {}) => ({ id: '1', title: 'Round 1', url: 'https://codeforces.com/contest/1', startTime: '2026-11-07T06:00:00Z', endTime: '2026-11-07T08:00:00Z', ...patch });
const source = (id = 'codeforces') => ({ id, name: id, url: id === 'codeforces' ? 'https://codeforces.com/contests' : 'https://atcoder.jp/contests/', endpoint: 'https://example.test/' + id, parse: text => JSON.parse(text) });
const response = data => new Response(JSON.stringify(data));

test('contest cache prevents redundant fetches, coalesces concurrent refresh and drops expired records', async () => {
  let now = TIME, count = 0, saved;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const service = createContestService({ now: () => now, sources: [source()], fetcher: async () => { count++; await gate; return response([item()]); }, writeCache: data => { saved = data; } });
  assert.equal(service.snapshot().platforms[0].updatedAt, null);
  const first = service.get(); const concurrent = service.get(true);
  assert.equal(first, concurrent); assert.equal(count, 1);
  release(); const result = await first;
  assert.equal(result.platforms[0].contests.length, 1); assert.equal(result.platforms[0].stale, false);
  assert.equal(saved.schema, 1);
  await service.get(); await service.get(true); assert.equal(count, 1, 'manual refresh is rate limited');
  now += RETRY_DELAY + 1; await service.get(true); assert.equal(count, 2);
  now = Date.parse('2026-11-07T09:00:00Z');
  assert.equal(service.snapshot().platforms[0].contests.length, 0);
});

test('one failed platform retains its last good cache independently and retry recovers', async () => {
  let now = TIME, failed = true; const calls = [];
  const service = createContestService({ now: () => now, sources: [source(), source('atcoder')], readCache: () => ({ schema: 1, platforms: [{ id: 'codeforces', updatedAt: new Date(TIME - CACHE_TTL).toISOString(), contests: [item()] }] }),
    fetcher: async (url, options) => { calls.push({url,options}); if (url.endsWith('codeforces') && failed) throw Error('secret-private-network-error'); return response([]); } });
  const result = await service.get();
  assert.equal(result.platforms[0].contests.length, 1); assert.equal(result.platforms[0].stale, true);
  assert(!result.platforms[0].error.includes('secret')); assert.equal(result.platforms[1].stale, false); assert.equal(result.platforms[1].error, null);
  assert.equal(calls[0].options.credentials, 'omit'); assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[0].options.headers.Authorization, undefined);
  await service.get(true); assert.equal(calls.length, 2, 'failure does not permit request storms');
  failed = false; now += RETRY_DELAY + 1; const recovered = await service.get(true);
  assert.equal(recovered.platforms[0].error, null); assert.equal(recovered.platforms[0].contests.length, 0, 'successful empty result clears old schedule');
});

test('platform Retry-After delays forced retries beyond the ordinary throttle', async () => {
  let now=TIME, count=0;
  const service=createContestService({now:()=>now,sources:[source()],fetcher:async()=>{count++;return new Response('limited',{status:429,headers:{'Retry-After':'600'}});}});
  await service.get(); now+=RETRY_DELAY+1; await service.get(true); assert.equal(count,1);
  now=TIME+600001; await service.get(true); assert.equal(count,2);
});

test('untrusted cache and parser output reject nonplatform links and invalid or duplicated times', () => {
  const values = [item(), item(), item({url:'https://codeforces.com.evil.test/contest/1'}), item({url:'https://alice:pass@codeforces.com/contest/2'}), item({url:'http://codeforces.com/contest/2'}), item({url:'https://codeforces.com/api/1'}), item({endTime:'bad'}), item({endTime:'2026-11-07T05:00:00Z'}), item({startTime:'2026-11-07T03:00:00Z', endTime:'2026-11-07T03:59:00Z'})];
  assert.deepEqual(normalizeContests(values,'codeforces',TIME), [{...item(), startTime:'2026-11-07T06:00:00.000Z',endTime:'2026-11-07T08:00:00.000Z'}]);
  const service = createContestService({fetcher:async()=>response([]),sources:[source()],now:()=>TIME,readCache:()=>({schema:1,platforms:[{id:'codeforces',updatedAt:'2099-01-01T00:00:00Z',contests:[item()]}]})});
  assert.equal(service.snapshot().platforms[0].updatedAt,null);
});

test('oversized/challenge responses retain cache, disk errors do not break refreshed in-memory data', async () => {
  const cache = {schema:1,platforms:[{id:'codeforces',updatedAt:new Date(TIME-CACHE_TTL).toISOString(),contests:[item()]}]};
  for (const bad of [new Response('blocked',{status:429}), new Response('x'.repeat(4*1024*1024+1)), new Response('<html>Challenge</html>')]) {
    const s=createContestService({now:()=>TIME,sources:[source()],readCache:()=>cache,fetcher:async()=>bad});
    const r=await s.get(); assert(r.platforms[0].error); assert.equal(r.platforms[0].contests.length,1);
  }
  const service=createContestService({now:()=>TIME,sources:[source()],fetcher:async()=>response([item()]),writeCache:()=>{throw Error('disk full');}});
  assert.equal((await service.get()).platforms[0].contests.length,1);
  await assert.rejects(service.get({url:'https://evil.test'}),/参数/);
});
