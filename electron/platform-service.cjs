'use strict';
const { parseProfileLink, fetchPlatform } = require('./platform-data.cjs');
// Bindings and public snapshots belong to this device, independently of GitHub login.
function createPlatformService({ read, save, fetcher, readPage, now = () => new Date().toISOString() }) {
  const running = new Set();
  function state() { const value = read('platforms.json', {}); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  function code(value) { if (!['CF','AT','LG','NC','LC'].includes(value)) throw new Error('不支持的平台'); return value; }
  function lock(platform) { code(platform); if (running.has(platform)) throw new Error('该平台正在查询，请稍候'); running.add(platform); }
  async function bind(platform, url) {
    lock(platform);
    try {
      const binding = parseProfileLink(platform, url);
      const data = await fetchPlatform(binding, { fetcher, readPage });
      const next = state(); next[platform] = { binding: { ...binding, username: data.username }, data, updatedAt: now(), attemptedAt: now(), error: '' };
      save('platforms.json', next); return state();
    } finally { running.delete(platform); }
  }
  async function refresh(platform) {
    lock(platform);
    try {
      const entry = state()[platform]; if (!entry?.binding) throw new Error('请先绑定账号');
      try {
        const data = await fetchPlatform(entry.binding, { fetcher, readPage });
        const next = state(); next[platform] = { ...entry, binding:{ ...entry.binding, username:data.username }, data, updatedAt:now(), attemptedAt:now(), error:'' }; save('platforms.json', next);
      } catch(error) {
        const next = state(); next[platform] = { ...entry, attemptedAt:now(), error:String(error.message || '查询失败').slice(0,500) }; save('platforms.json',next);
      }
      return state();
    } finally { running.delete(platform); }
  }
  function unbind(platform) { code(platform); if(running.has(platform)) throw new Error('该平台正在查询，请稍候'); const next=state();delete next[platform];save('platforms.json',next);return state(); }
  return { state, bind, refresh, unbind, isBusy:()=>running.size>0 };
}
module.exports = { createPlatformService };
