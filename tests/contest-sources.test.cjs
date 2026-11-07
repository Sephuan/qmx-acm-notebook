'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SOURCES } = require('../electron/contest-sources.cjs');

const sources = Object.fromEntries(SOURCES.map(source => [source.id, source]));
const cf = row => JSON.stringify({ status: 'OK', result: row === undefined ? [] : [row] });
const cfRow = { id: 2288, name: 'Codeforces Round (Div. 2)', phase: 'BEFORE', startTimeSeconds: 1794043200, durationSeconds: 7200 };
const luogu = rows => `<script id='lentille-context' type='application/json'>${JSON.stringify({ status: 200, data: { contests: { result: rows } } })}</script>`;
const lgRow = { id: 329950, name: '【LGR-313-Div.2】洛谷月赛 & Round 6', startTime: 1794031200, endTime: 1794045600 };
const ncRow = { contestId: 143199, contestName: '牛客周赛 Round 169', contestStartTime: 1794135600000, contestEndTime: 1794142800000 };
function escapeAttribute(text) {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function nowcoder(rows, passes = 2) {
  return `<div class="platform-mod js-current"><h2>等你来战</h2>${rows.map(row => {
    let encoded = JSON.stringify(row);
    for (let i = 0; i < passes; i++) encoded = escapeAttribute(encoded);
    // data-id is deliberately different: contestId is the canonical source id.
    return `<div data-id="999999" class="platform-item js-item " data-json="${encoded}"></div>`;
  }).join('')}</div>`;
}
function atcoderRow({ id = 'abc483', name = 'AtCoder Beginner Contest 483', time = '2026-11-07 21:00:00+0900', duration = '01:40', href = `/contests/${id}` } = {}) {
  return `<tr>
    <td class="text-center"><a href='http://www.timeanddate.com/worldclock/fixedtime.html?iso=20261107T2100'><time class='fixtime fixtime-full'>${time}</time></a></td>
    <td><span title="Algorithm">Ⓐ</span> <span>◉</span> <a href="${href}">${name}</a></td>
    <td class="text-center">${duration}</td><td> - 1999</td>
  </tr>`;
}
const atcoder = (upcoming = '', ongoing = '') => `<div id="contest-table-action"><table><thead><tr><th>Start Time</th></tr></thead><tbody>${ongoing}</tbody></table></div>
  <div id="contest-table-upcoming"><table><tbody>${upcoming}</tbody></table></div>
  <div id="contest-table-archive"><table><tbody>${atcoderRow({ id: 'abc001', time: '2013-10-12 21:00:00+0900' })}</tbody></table></div>`;

function rejectsFormat(source, text) {
  assert.throws(() => source.parse(text), error => error instanceof Error && error.code === 'CONTEST_SOURCE_FORMAT' && error.message.startsWith(`Invalid ${source.name} contest source:`));
}

test('exports four immutable official source definitions with synchronous parsers', () => {
  assert.deepEqual(SOURCES.map(source => source.id), ['codeforces', 'atcoder', 'luogu', 'nowcoder']);
  assert.ok(Object.isFrozen(SOURCES));
  const hosts = ['codeforces.com', 'atcoder.jp', 'www.luogu.com.cn', 'ac.nowcoder.com'];
  SOURCES.forEach((source, index) => {
    assert.deepEqual(Object.keys(source).sort(), ['endpoint', 'id', 'name', 'parse', 'url']);
    assert.ok(Object.isFrozen(source));
    assert.equal(typeof source.parse, 'function');
    for (const address of [source.url, source.endpoint]) {
      assert.equal(new URL(address).protocol, 'https:');
      assert.equal(new URL(address).hostname, hosts[index]);
    }
  });
});

test('Codeforces parses upcoming and active phases, dropping FINISHED only', () => {
  const result = sources.codeforces.parse(cf(cfRow));
  assert.deepEqual(result, [{ id: '2288', title: 'Codeforces Round (Div. 2)', url: 'https://codeforces.com/contest/2288', startTime: '2026-11-07T09:20:00.000Z', endTime: '2026-11-07T11:20:00.000Z' }]);
  for (const phase of ['CODING', 'PENDING_SYSTEM_TEST', 'SYSTEM_TEST']) {
    assert.equal(sources.codeforces.parse(cf({ ...cfRow, phase })).length, 1);
  }
  assert.deepEqual(sources.codeforces.parse(cf({ ...cfRow, phase: 'FINISHED' })), []);
});

test('AtCoder reads ongoing and upcoming rows, explicit JST, entities and durations above 24 hours', () => {
  const result = sources.atcoder.parse(atcoder(atcoderRow({ name: 'ABC &amp; Friends &#x2160;' }), atcoderRow({ id: 'ahc074', name: 'HACK TO THE FUTURE 2027', time: '2026-10-30 19:00:00+0900', duration: '240:00' })));
  assert.deepEqual(result, [
    { id: 'ahc074', title: 'HACK TO THE FUTURE 2027', url: 'https://atcoder.jp/contests/ahc074', startTime: '2026-10-30T10:00:00.000Z', endTime: '2026-11-09T10:00:00.000Z' },
    { id: 'abc483', title: 'ABC & Friends Ⅰ', url: 'https://atcoder.jp/contests/abc483', startTime: '2026-11-07T12:00:00.000Z', endTime: '2026-11-07T13:40:00.000Z' },
  ]);
  const offset = sources.atcoder.parse(atcoder(atcoderRow({ time: '2026-11-07 21:00:00-0530' })))[0];
  assert.equal(offset.startTime, '2026-11-08T02:30:00.000Z');
});

test('Luogu reads only inert application/json context and interprets epoch seconds', () => {
  const result = sources.luogu.parse(`<script>throw new Error('must never execute');</script>${luogu([lgRow])}`);
  assert.deepEqual(result, [{ id: '329950', title: '【LGR-313-Div.2】洛谷月赛 & Round 6', url: 'https://www.luogu.com.cn/contest/329950', startTime: '2026-11-07T06:00:00.000Z', endTime: '2026-11-07T10:00:00.000Z' }]);
});

test('Nowcoder decodes double escaped JSON, uses contestId, and interprets milliseconds', () => {
  const row = { ...ncRow, contestName: '牛客 "Round" <169> & Friends', link: 'javascript:alert(1)' };
  const result = sources.nowcoder.parse(nowcoder([row]));
  assert.deepEqual(result, [{ id: '143199', title: '牛客 "Round" <169> & Friends', url: 'https://ac.nowcoder.com/acm/contest/143199', startTime: '2026-11-08T11:00:00.000Z', endTime: '2026-11-08T13:00:00.000Z' }]);
  assert.deepEqual(sources.nowcoder.parse(nowcoder([row], 1)), result);
  const numeric = nowcoder([ncRow]).replaceAll('&amp;quot;', '&#38;#34;');
  assert.deepEqual(sources.nowcoder.parse(numeric), sources.nowcoder.parse(nowcoder([ncRow])));
});

test('all parsers distinguish valid empty listings from missing schemas and failure markup', () => {
  const empty = { codeforces: cf(), atcoder: atcoder(), luogu: luogu([]), nowcoder: nowcoder([]) };
  for (const source of SOURCES) {
    assert.deepEqual(source.parse(empty[source.id]), []);
    for (const bad of ['', null, undefined, '<html><title>403 Forbidden</title><p>Verify you are human</p></html>', '{"status":"FAILED"}']) rejectsFormat(source, bad);
  }
  assert.deepEqual(sources.atcoder.parse('<div id="contest-table-archive"><table><tbody></tbody></table></div>'), []);
});

test('malformed envelopes and item schemas throw controlled format errors', () => {
  const malformed = {
    codeforces: ['{', JSON.stringify({ status: 'FAILED', result: [] }), JSON.stringify({ status: 'OK', result: {} }), cf(null), cf({ ...cfRow, phase: 'UNKNOWN' }), cf({ ...cfRow, name: '' }), cf({ ...cfRow, startTimeSeconds: '1794043200' })],
    atcoder: ['<div id="contest-table-upcoming"></div>', atcoder('<tr><td>broken</td></tr>'), atcoder('<tr><td>unclosed'), atcoder(atcoderRow({ duration: '01:99' })), atcoder(atcoderRow({ time: '2026-11-07 21:00:00' })), atcoder(atcoderRow({ time: '2026-02-30 21:00:00+0900' }))],
    luogu: ["<script id='lentille-context' type='application/json'>{</script>", luogu([null]), luogu([{ ...lgRow, endTime: null }]), '<script id="lentille-context" type="text/javascript">{"data":{"contests":{"result":[]}}}</script>'],
    nowcoder: ['<div class="platform-mod js-current"><div class="platform-item js-item"></div></div>', nowcoder([null]), nowcoder([{ ...ncRow, contestStartTime: undefined }]), nowcoder([{ ...ncRow, contestName: ' ' }])],
  };
  for (const [id, values] of Object.entries(malformed)) for (const value of values) rejectsFormat(sources[id], value);
});

test('untrusted ids and contest links cannot become external or executable URLs', () => {
  for (const id of ['../123', '1?redirect=https://evil.example', 'javascript:alert(1)', 'https://evil.example/123', -1, 0, 1.5, {}, Number.MAX_SAFE_INTEGER + 1]) {
    rejectsFormat(sources.codeforces, cf({ ...cfRow, id }));
    rejectsFormat(sources.luogu, luogu([{ ...lgRow, id }]));
    rejectsFormat(sources.nowcoder, nowcoder([{ ...ncRow, contestId: id }]));
  }
  for (const href of ['https://evil.example/contests/abc483', '//evil.example/contests/abc483', 'javascript:alert(1)', '/contests/../evil', '/contests/abc483?redirect=evil', '/contests/abc483%2f..']) {
    rejectsFormat(sources.atcoder, atcoder(atcoderRow({ href })));
  }
});

test('non-finite, unsafe and reversed time ranges are rejected without Date exceptions', () => {
  for (const value of [-1, 1.5, 9007199254740991, null, '1794031200']) {
    rejectsFormat(sources.codeforces, cf({ ...cfRow, startTimeSeconds: value }));
    rejectsFormat(sources.luogu, luogu([{ ...lgRow, startTime: value }]));
    rejectsFormat(sources.nowcoder, nowcoder([{ ...ncRow, contestStartTime: value }]));
  }
  rejectsFormat(sources.codeforces, cf({ ...cfRow, durationSeconds: 0 }));
  rejectsFormat(sources.luogu, luogu([{ ...lgRow, endTime: lgRow.startTime - 1 }]));
  rejectsFormat(sources.nowcoder, nowcoder([{ ...ncRow, contestEndTime: ncRow.contestStartTime }]));
  rejectsFormat(sources.atcoder, atcoder(atcoderRow({ duration: '999999999999999999999:00' })));
});
