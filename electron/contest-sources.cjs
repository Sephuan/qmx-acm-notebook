'use strict';

// These parsers consume data only. They never execute scripts from a listing page.
const FORMAT_ERROR = 'CONTEST_SOURCE_FORMAT';

function invalid(message) {
  const error = new Error(message);
  error.code = FORMAT_ERROR;
  throw error;
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`Invalid ${label}`);
  return value;
}

function json(text) {
  try { return JSON.parse(text); } catch { invalid('Malformed JSON'); }
}

function title(value) {
  if (typeof value !== 'string' || !value.trim()) invalid('Missing contest title');
  return value.replace(/\s+/g, ' ').trim();
}

function numericId(value) {
  if (typeof value !== 'number' && typeof value !== 'string') invalid('Invalid contest id');
  const id = String(value);
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) invalid('Invalid contest id');
  return id;
}

function epoch(value, multiplier) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid('Invalid contest timestamp');
  const milliseconds = value * multiplier;
  if (!Number.isSafeInteger(milliseconds) || !Number.isFinite(new Date(milliseconds).getTime())) invalid('Invalid contest timestamp');
  return milliseconds;
}

function contest(id, name, url, start, end) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start ||
      !Number.isFinite(new Date(start).getTime()) || !Number.isFinite(new Date(end).getTime())) {
    invalid('Invalid contest time range');
  }
  return { id, title: title(name), url, startTime: new Date(start).toISOString(), endTime: new Date(end).toISOString() };
}

const ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
function decodeEntities(text, passes = 1) {
  for (let pass = 0; pass < passes; pass++) {
    text = text.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (match, entity) => {
      if (entity[0] !== '#') return ENTITIES[entity.toLowerCase()];
      const hex = entity[1].toLowerCase() === 'x';
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) invalid('Invalid HTML character entity');
      return String.fromCodePoint(code);
    });
  }
  return text;
}

function plainText(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

// Attribute values remain encoded until the consumer chooses the correct decoding depth.
function attributes(text) {
  const result = Object.create(null);
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of text.matchAll(pattern)) {
    const key = match[1].toLowerCase();
    if (Object.hasOwn(result, key)) invalid('Duplicate HTML attribute');
    result[key] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return result;
}

function tags(html, name) {
  const pattern = new RegExp(`<${name}\\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>`, 'gi');
  return [...html.matchAll(pattern)].map(match => ({ index: match.index, length: match[0].length, attrs: attributes(match[1]) }));
}

function hasClasses(attrs, ...classes) {
  const present = (attrs.class || '').split(/\s+/);
  return classes.every(name => present.includes(name));
}

function parseCodeforces(text) {
  const body = object(json(text), 'Codeforces response');
  if (body.status !== 'OK' || !Array.isArray(body.result)) invalid('Missing successful Codeforces result');
  return body.result.flatMap(value => {
    const row = object(value, 'Codeforces contest');
    if (!['BEFORE', 'CODING', 'PENDING_SYSTEM_TEST', 'SYSTEM_TEST', 'FINISHED'].includes(row.phase)) invalid('Invalid Codeforces phase');
    if (row.phase === 'FINISHED') return [];
    const id = numericId(row.id);
    const start = epoch(row.startTimeSeconds, 1000);
    const duration = epoch(row.durationSeconds, 1000);
    return [contest(id, row.name, `https://codeforces.com/contest/${id}`, start, start + duration)];
  });
}

function atcoderTime(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})([+-])(\d{2}):?(\d{2})$/.exec(text);
  if (!match) invalid('Missing explicit AtCoder time zone');
  const [, year, month, day, hour, minute, second, sign, zoneHour, zoneMinute] = match;
  const local = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second);
  const expected = `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
  if (!Number.isFinite(local) || new Date(local).toISOString() !== expected || +zoneHour > 23 || +zoneMinute > 59) {
    invalid('Invalid AtCoder timestamp');
  }
  return local - (sign === '+' ? 1 : -1) * (+zoneHour * 60 + +zoneMinute) * 60000;
}

function parseAtcoder(text) {
  const sections = tags(text, 'div').filter(tag => /^contest-table-/.test(tag.attrs.id || ''));
  if (!sections.some(tag => ['contest-table-action', 'contest-table-upcoming', 'contest-table-archive'].includes(tag.attrs.id))) {
    invalid('Missing AtCoder contest tables');
  }
  const result = [];
  sections.forEach((section, index) => {
    if (!['contest-table-action', 'contest-table-upcoming'].includes(section.attrs.id)) return;
    const html = text.slice(section.index + section.length, sections[index + 1]?.index ?? text.length);
    const table = /<table\b[^>]*>([\s\S]*?)<\/table\s*>/i.exec(html);
    const body = table && /<tbody\b[^>]*>([\s\S]*?)<\/tbody\s*>/i.exec(table[1]);
    if (!body) invalid('Malformed AtCoder contest table');
    const rows = [...body[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)];
    if (rows.length !== tags(body[1], 'tr').length) invalid('Malformed AtCoder contest rows');
    for (const row of rows) {
      const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td\s*>/gi)].map(match => match[1]);
      if (cells.length < 3) invalid('Missing AtCoder contest cells');
      const time = /<time\b[^>]*>([\s\S]*?)<\/time\s*>/i.exec(cells[0]);
      const links = [...cells[1].matchAll(/<a\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a\s*>/gi)];
      if (!time || links.length !== 1) invalid('Missing AtCoder contest time or link');
      const href = decodeEntities(attributes(links[0][1]).href || '');
      const id = /^\/contests\/([a-zA-Z0-9][a-zA-Z0-9_-]*)$/.exec(href)?.[1];
      if (!id) invalid('Invalid AtCoder contest link');
      const duration = /^(\d+):([0-5]\d)$/.exec(plainText(cells[2]));
      if (!duration) invalid('Invalid AtCoder contest duration');
      const start = atcoderTime(plainText(time[1]));
      const end = start + (Number(duration[1]) * 60 + Number(duration[2])) * 60000;
      result.push(contest(id, plainText(links[0][2]), `https://atcoder.jp/contests/${id}`, start, end));
    }
  });
  return result;
}

function parseLuogu(text) {
  const scripts = tags(text, 'script').filter(tag => tag.attrs.id === 'lentille-context');
  if (scripts.length !== 1 || scripts[0].attrs.type !== 'application/json') invalid('Missing Luogu contest context');
  const script = scripts[0];
  const tail = text.slice(script.index + script.length);
  const end = /<\/script\s*>/i.exec(tail);
  if (!end) invalid('Unclosed Luogu contest context');
  const body = object(json(tail.slice(0, end.index)), 'Luogu context');
  const data = object(body.data, 'Luogu data');
  const contests = object(data.contests, 'Luogu contests');
  if ((body.status !== undefined && body.status !== 200) || !Array.isArray(contests.result)) invalid('Missing Luogu contest result');
  return contests.result.map(value => {
    const row = object(value, 'Luogu contest');
    const id = numericId(row.id);
    return contest(id, row.name, `https://www.luogu.com.cn/contest/${id}`, epoch(row.startTime, 1000), epoch(row.endTime, 1000));
  });
}

function parseNowcoder(text) {
  const divs = tags(text, 'div');
  if (!divs.some(tag => hasClasses(tag.attrs, 'platform-mod', 'js-current'))) invalid('Missing Nowcoder contest listing');
  const items = divs.filter(tag => hasClasses(tag.attrs, 'platform-item', 'js-item'));
  return items.map(item => {
    if (!item.attrs['data-json']) invalid('Missing Nowcoder contest data');
    const row = object(json(decodeEntities(item.attrs['data-json'], 2)), 'Nowcoder contest');
    const id = numericId(row.contestId);
    return contest(id, row.contestName, `https://ac.nowcoder.com/acm/contest/${id}`,
      epoch(row.contestStartTime, 1), epoch(row.contestEndTime, 1));
  });
}

function source(id, name, url, endpoint, parse) {
  return Object.freeze({ id, name, url, endpoint, parse(text) {
    try {
      if (typeof text !== 'string' || !text.trim()) invalid('Empty response');
      return parse(text);
    } catch (cause) {
      const error = new Error(`Invalid ${name} contest source: ${cause.code === FORMAT_ERROR ? cause.message : 'Malformed listing'}`);
      error.code = FORMAT_ERROR;
      throw error;
    }
  } });
}

const SOURCES = Object.freeze([
  source('codeforces', 'Codeforces', 'https://codeforces.com/contests', 'https://codeforces.com/api/contest.list?gym=false', parseCodeforces),
  source('atcoder', 'AtCoder', 'https://atcoder.jp/contests/?lang=en', 'https://atcoder.jp/contests/?lang=en', parseAtcoder),
  source('luogu', '洛谷', 'https://www.luogu.com.cn/contest/list', 'https://www.luogu.com.cn/contest/list', parseLuogu),
  source('nowcoder', '牛客', 'https://ac.nowcoder.com/acm/contest/vip-index', 'https://ac.nowcoder.com/acm/contest/vip-index', parseNowcoder),
]);

module.exports = { SOURCES };
