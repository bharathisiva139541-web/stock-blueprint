'use strict';
// EPS Growth Target Lab (owner, 23-Nov-2026, LAURUSLABS: TTM EPS x EPS growth % = his target, reached after the Q1
// results): the laptop (pcbridge/ScreenerBridge/eps_target.py) posts one quarter at a time -> Code2.gs ab_epstFromBridge_
// (tab EPS_Target) -> doPost action 'site' part 'epst' -> api/epstarget (unpacks + checks) -> web/lib/epstarget.js.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const mock = require('./fixtures/apps-script-mock.js');
const T = require('../web/lib/epstarget.js');
const api = require('../api/epstarget');

const TOKEN = 'bridge-token-0123456789';
const FEED = 'feed-token-abcdef';
const NOW = Date.UTC(2026, 10, 23, 9, 0);
const HEAD = ['Checkbox', 'StockName', 'SYMBOL', 'MKT Price', 'Price Fall Alert Price', 'Breakout Alert Price', 'Triggered Y/N'];
const py = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);

function env() {
  return mock.loadCodeGs({ sheets: [
    { name: 'Main', rows: [['Main'], HEAD, [false, 'Laurus', 'LAURUSLABS', 2370]] },
    { name: 'PatternData', rows: [['Date', 'x', 'y', 'Symbol'], ['', '', '', 'LAURUSLABS']] },
    { name: 'AutoFetch Log', rows: [['ts']] }
  ] }, { props: { AB_BRIDGE_TOKEN: TOKEN, AB_FEED_TOKEN: FEED }, now: NOW });
}
// a row as eps_target.py packs it (COLS order)
function row(sym, o) {
  const r = Object.assign({ sym: sym, st: 'ok', why: '', b: 'C', fl: '--------', eps: [0.37, 1.71, 4.34, 3.02, 3.61, 4.67, 5.17, 6.81], ttm: 20.26,
    prev: 9.44, g: 114.62, tgt: 2322.17, ann: '2026-07-24 16:05', src: 'nse', ed: '2026-07-27', ep: 1624.1, pre: 1600, o0: 1610, n: 85,
    kp: [38, 45, 53, 60, 68, 75], kd: ['2026-09-17', '2026-09-28', '2026-10-08', '2026-10-21', '2026-10-31', '2026-11-11'], pg: [40, 80, 120, 120, 120],
    hh: [17, 34, 50, 50, 50], dd: [-3, -3, -3, -3, -3], cl: [10, 20, null, null, null], ix: [1, 2, null, null, null], nq: 70, nqa: 0, nx: '2026-10-29 16:30',
    wq: [95, 45, -3, 25, 2], now: 46, ph: [1, 2, 3], pc: [1, 2, 3] }, o || {});
  return T.COLS.map((k) => r[k]);
}
function pack(rows) {
  return zlib.gzipSync(Buffer.from(JSON.stringify({ cols: T.COLS, rows: rows }))).toString('base64');
}
const W14 = (a) => a.concat(Array(14 - a.length).fill(0));
const SUM = { stocks: 3, ok: 2, target: 2, down: 1, why: { fell: 1, nofiling: 2, bogus: 4 },
  win: { 30: W14([2, 0]), 60: W14([2, 0, 1, 1, 1, 1]), 90: W14([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]), next: W14([1, 1, 1]), x: [1] }, dwin: { 30: W14([1, 0, 1, 1, 1, 1]) },
  medG: 114.62, medUp: 43.0, medN: 85, ready: true, ann: { nse: 2, evil: 1 } };

test('op put: a quarter a row (replaced, newest 40 by quarter end), checked; op list; refusals', () => {
  const e = env();
  const blob = pack([row('LAURUSLABS'), row('FLAT', { st: 'x', why: 'fell', tgt: null, g: -5 })]);
  const r = e.post({ token: TOKEN, action: 'epst', op: 'put', q: 'Jun 2026', end: '2026-06-30', fy: 'Q1 FY27', made: '2026-11-23T10:00:00',
    upto: '2026-11-20', sum: SUM, blob: blob, engine: 3 });
  assert.deepStrictEqual(r, { ok: true, stored: 'Jun 2026', parts: 1 });
  assert.strictEqual(e.post({ token: 'wrong', action: 'epst', op: 'list' }).ok, false, 'the bridge token');
  assert.deepStrictEqual(e.post({ token: TOKEN, action: 'epst', op: 'list' }).quarters, [{ q: 'Jun 2026', made: '2026-11-23T10:00:00', upto: '2026-11-20' }]);
  for (const bad of [{ q: 'Jul 2026' }, { engine: 2 }, { blob: 'not base64!' }, { blob: '' }]) {      // engine 2 = the laptop program before 50 / 60 / 70 % + next
    const x = e.post(Object.assign({ token: TOKEN, action: 'epst', op: 'put', q: 'Jun 2026', blob: blob, engine: 3 }, bad));
    assert.strictEqual(x.ok, false, JSON.stringify(bad));
  }
  // a big quarter in parts, then a smaller one in the same row: no old part left behind
  const big = 'A'.repeat(100000);
  assert.strictEqual(e.post({ token: TOKEN, action: 'epst', op: 'put', q: 'Sep 2026', end: '2026-09-30', blob: big, engine: 3 }).parts, 3);
  assert.strictEqual(e.post({ token: TOKEN, action: 'epst', op: 'put', q: 'Sep 2026', end: '2026-09-30', blob: 'QUJD', engine: 3 }).parts, 1);
  const s = e.post({ token: FEED, action: 'site', part: 'epst', q: 'Sep 2026' });
  assert.strictEqual(s.blob, 'QUJD', 'only the new part');
  // 50 quarters -> the newest 40 by quarter end
  for (let y = 2014; y <= 2025; y++) {
    for (const m of ['Mar', 'Jun', 'Sep', 'Dec']) {
      const end = { Mar: '03-31', Jun: '06-30', Sep: '09-30', Dec: '12-31' }[m];
      e.post({ token: TOKEN, action: 'epst', op: 'put', q: m + ' ' + y, end: y + '-' + end, blob: 'QUJD', engine: 3 });
    }
  }
  const qs = e.post({ token: TOKEN, action: 'epst', op: 'list' }).quarters.map((x) => x.q);
  assert.strictEqual(qs.length, 40);
  assert.deepStrictEqual(qs.slice(0, 3), ['Sep 2026', 'Jun 2026', 'Dec 2025']);
  assert.ok(qs.indexOf('Jun 2016') < 0 && qs.indexOf('Sep 2016') >= 0, qs.join(','));
});

test('site part epst: the quarters + one quarter\'s blob (asked, else the newest ready one); the feed token only', () => {
  const e = env();
  assert.deepStrictEqual(e.post({ token: FEED, action: 'site', part: 'epst' }), { ok: true, quarters: [], q: '', blob: '' }, 'nothing yet');
  const b1 = pack([row('LAURUSLABS')]);
  e.post({ token: TOKEN, action: 'epst', op: 'put', q: 'Jun 2026', end: '2026-06-30', fy: 'Q1 FY27', upto: '2026-11-20', sum: SUM, blob: b1, engine: 3 });
  e.post({ token: TOKEN, action: 'epst', op: 'put', q: 'Sep 2026', end: '2026-09-30', fy: 'Q2 FY27', sum: Object.assign({}, SUM, { ready: false }), blob: 'QUJD', engine: 3 });
  const s = e.post({ token: FEED, action: 'site', part: 'epst' });
  assert.strictEqual(s.q, 'Jun 2026', 'the newest quarter whose results mostly had 30 sessions (the owner\'s Q1), not the running one');
  assert.strictEqual(s.blob, b1);
  assert.deepStrictEqual(s.quarters.map((x) => [x.q, x.fy, x.sum.ready]), [['Sep 2026', 'Q2 FY27', false], ['Jun 2026', 'Q1 FY27', true]]);
  const sum = s.quarters[1].sum;
  assert.deepStrictEqual(sum.why, { fell: 1, nofiling: 2 }, 'unknown reasons dropped');
  assert.deepStrictEqual(sum.ann, { nse: 2 });
  assert.deepStrictEqual(Object.keys(sum.win), ['30', '60', '90', 'next'], 'the windows + until the next results');
  assert.deepStrictEqual(sum.win.next, W14([1, 1, 1]));
  assert.deepStrictEqual(sum.dwin, { 30: W14([1, 0, 1, 1, 1, 1]) });
  assert.strictEqual(sum.down, 1);
  assert.strictEqual(e.post({ token: FEED, action: 'site', part: 'epst', q: 'Sep 2026' }).blob, 'QUJD');
  const miss = e.post({ token: FEED, action: 'site', part: 'epst', q: 'Mar 2020' });
  assert.ok(miss.ok && miss.q === 'Mar 2020' && miss.blob === '' && miss.quarters.length === 2, 'a quarter not kept: no rows');
  assert.strictEqual(e.post({ token: FEED, action: 'site', part: 'epst', q: '<x>' }).ok, false);
  assert.strictEqual(e.post({ token: TOKEN, action: 'site', part: 'epst' }).ok, false, 'the bridge token is not the feed token');
});

test('api/epstarget: unpacks + checks the rows, caches on the CDN; bad quarter 400; no secret leaks', async () => {
  const e = env();
  const evil = row('EVIL', { sym: 'a b <script>', ann: 'x@y.com' });
  const odd = row('ODD', { why: 'nonsense', fl: 'XYZ', src: 'moneycontrol', eps: ['=1', 2], ann: 'mail me@x.com', kd: ['soon', 'x@y.com'], pg: 'x' });
  const odd2 = row('ODD2', { nq: -4, nqa: 'yes', nx: 'x@y.com', wq: ['a', 1] });
  e.post({ token: TOKEN, action: 'epst', op: 'put', q: 'Jun 2026', end: '2026-06-30', fy: 'Q1 FY27', made: '2026-11-23T10:00:00', upto: '2026-11-20',
    sum: SUM, blob: pack([row('LAURUSLABS'), evil, odd, odd2, 'junk']), engine: 3 });
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify(e.post(JSON.parse(init.body))), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const ENV = { SHEET_FEED_URL: 'https://script.google.com/macros/s/AKfy_SECRET_X/exec', SHEET_FEED_TOKEN: FEED, SITE_ACCESS: 'open' };
  const h = api.createHandler({ env: ENV, fetch, now: () => NOW, cache: require('../api/_lib/cache').createCache() });
  const res = () => {
    const r = { headers: {}, statusCode: 200 };
    r.setHeader = (k, v) => { r.headers[String(k).toLowerCase()] = v; };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (o) => { r.body = JSON.parse(JSON.stringify(o)); };
    r.end = () => {};
    return r;
  };
  let r = res();
  await h({ method: 'GET', query: {} }, r);
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.q, 'Jun 2026');
  assert.deepStrictEqual(r.body.cols, T.COLS);
  assert.deepStrictEqual(r.body.rows.map((x) => x[0]), ['LAURUSLABS', 'ODD', 'ODD2'], 'a bad symbol / a broken row left out');
  const o2 = r.body.rows[2];
  const o = r.body.rows[1];
  const ci = (k) => T.COLS.indexOf(k);
  assert.deepStrictEqual([o[ci('why')], o[ci('fl')], o[ci('src')], o[ci('ann')]], ['', '', '', ''], 'unknown codes and texts blanked');
  assert.deepStrictEqual(o[ci('kd')], ['', ''], 'dates only');
  assert.deepStrictEqual(o[ci('eps')], [null, 2], 'numbers only');
  assert.deepStrictEqual(o[ci('pg')], []);
  assert.deepStrictEqual([o2[ci('nq')], o2[ci('nqa')], o2[ci('nx')], o2[ci('wq')]], [null, 0, '', [null, 1]], 'next-results fields checked');
  assert.deepStrictEqual(r.body.rows[0][ci('kp')], [38, 45, 53, 60, 68, 75]);
  assert.deepStrictEqual([r.body.rows[0][ci('nq')], r.body.rows[0][ci('nqa')], r.body.rows[0][ci('nx')], r.body.rows[0][ci('wq')]],
    [70, 0, '2026-10-29 16:30', [95, 45, -3, 25, 2]], 'the window up to the next results');
  assert.deepStrictEqual([o[ci('nq')], o[ci('nx')]], [70, '2026-10-29 16:30']);
  assert.match(r.headers['cache-control'], /s-maxage=1800/);
  assert.deepStrictEqual(calls[0], { action: 'site', part: 'epst', token: FEED });
  const text = JSON.stringify(r.body) + JSON.stringify(r.headers);
  assert.ok(text.indexOf(FEED) < 0 && text.indexOf('AKfy_SECRET') < 0, 'no token / web-app address');
  assert.ok(!require('../api/site.js').PERSONAL_MARKERS.some((re) => re.test(JSON.stringify(r.body))), 'nothing the site guard would block');
  r = res();
  await h({ method: 'GET', query: {} }, r);
  assert.strictEqual(calls.length, 1, 'a second ask within 30 minutes: from the server\'s memory');
  r = res();
  await h({ method: 'GET', query: { q: 'Jun 2026' } }, r);
  assert.deepStrictEqual(calls[1], { action: 'site', part: 'epst', q: 'Jun 2026', token: FEED });
  assert.ok(r.body.rows[0][ci('pc')].length === 3);
  r = res();
  await h({ method: 'GET', query: { q: 'Jun 2026', lite: '1' } }, r);
  assert.deepStrictEqual([r.body.rows[0][ci('ph')], r.body.rows[0][ci('pc')]], [[], []], 'lite: without the chart\'s path');
  assert.deepStrictEqual(r.body.rows[0][ci('kp')], [38, 45, 53, 60, 68, 75]);
  r = res();
  await h({ method: 'GET', query: { q: 'June' } }, r);
  assert.strictEqual(r.statusCode, 400);
  r = res();
  await api.createHandler({ env: {}, fetch })({ method: 'GET', query: {} }, r);
  assert.strictEqual(r.body.ok, false, 'not configured');
  assert.throws(() => api.unpack('$$$'), /not readable/);
  assert.throws(() => api.unpack(zlib.gzipSync(Buffer.from(JSON.stringify({ cols: ['sym'], rows: [] }))).toString('base64')), /UpdateNow\.bat/,
    'the first version\'s columns: the laptop must send the new ones');
});

test('web/lib/epstarget.js: 80 % of the way, downside targets apart, the full-window rule, groups, quarters, thesis, formula', () => {
  const rows = T.objects({ cols: T.COLS, rows: [
    row('HIT'),                                                                      // 80 % on 60, 90 % on 68, the target on 75 (85 sessions)
    row('EARLY', { kp: [10, 14, 17, 20, 25, 30], n: 35, pg: [101, 101, 101, 101, 101], cl: [30, null, null, null, null], nq: null, nx: '', wq: [101, 60, -2, null, null] }),
    row('MISS', { kp: [25, 40, null, null, null, null], pg: [30, 40, 45, 45, 45], cl: [-5, -10, null, null, null], dd: [-12, -20, -20, -20, -20], nq: 30, wq: [30, 5, -12, -5, 1] }),
    row('RUN', { kp: [null, null, null, null, null, null], n: 40, pg: [50, 55, 55, 55, 55], cl: [3, null, null, null, null], nq: null, wq: [55, 8, -1, null, null] }),
    row('DOWN', { tgt: 1500, kp: [5, 7, 8, 10, 12, 15], pg: [100, 100, 100, 100, 100] }),
    row('NONE', { st: 'x', why: 'fell', tgt: null, g: -3, kp: [], pg: [], nq: null, wq: [] })
  ] });
  assert.deepStrictEqual(rows.map((r) => r.dir), ['up', 'up', 'up', 'up', 'down', '']);
  const by = (W, Tt) => Object.fromEntries(rows.map((r) => [r.sym, T.kind(r, W, Tt)]));
  assert.deepStrictEqual(by(60, 80), { HIT: 'hit', EARLY: 'hit', MISS: 'not', RUN: 'pending', DOWN: 'down', NONE: 'none' });
  assert.deepStrictEqual(by(60, 100), { HIT: 'not', EARLY: 'hit', MISS: 'not', RUN: 'pending', DOWN: 'down', NONE: 'none' });
  assert.deepStrictEqual(by(60, 50), { HIT: 'hit', EARLY: 'hit', MISS: 'hit', RUN: 'pending', DOWN: 'down', NONE: 'none' }, '50 % of the way');
  assert.strictEqual(T.status(rows[2], 30, 60), 'not', 'MISS: 60 % on session 40 - after 30 sessions');
  // until the next results: HIT's came 70 sessions after the entry (80 % on 60: reached; the target on 75: not), MISS's after 30,
  // EARLY / RUN not out yet
  assert.deepStrictEqual(by('next', 80), { HIT: 'hit', EARLY: 'hit', MISS: 'not', RUN: 'pending', DOWN: 'down', NONE: 'none' });
  assert.deepStrictEqual(by('next', 100), { HIT: 'not', EARLY: 'hit', MISS: 'not', RUN: 'pending', DOWN: 'down', NONE: 'none' });
  assert.strictEqual(T.status(rows[2], 'next', 50), 'hit', 'MISS: 50 % on 25 - before its next results (30)');
  const sn = T.stats(rows, 'next', 80);
  assert.deepStrictEqual([sn.done, sn.hit, sn.not, sn.pending, sn.early, sn.medLen], [2, 1, 1, 2, 1, 50]);
  assert.strictEqual(T.outcome(rows[2], 'next', 80), -5, 'missed: the close of the last session before the next results');
  assert.strictEqual(T.outcome(rows[1], 'next', 80), null, 'EARLY: its next results not out yet');
  assert.deepStrictEqual([T.wv(rows[0], 'pg', 'next'), T.wv(rows[0], 'cl', 'next'), T.wv(rows[0], 'cl', 30), T.wv(rows[3], 'cl', 'next')], [95, 25, 10, null]);
  assert.deepStrictEqual([T.win('next'), T.win('60'), T.win(45), T.win('x')], ['next', 60, null, null]);
  assert.strictEqual(T.byWindow(rows, 80).map((x) => x.W).join(','), '30,60,90,120,180,next');
  assert.strictEqual(T.stats(rows, 'next', 80, 'down').pending, 0, 'DOWN: its next results came (70)');
  assert.strictEqual(T.status(rows[4], 30, 80), 'hit', 'the downside target fell to its 80 % level on session 10');
  // 30 sessions, 80 %: EARLY reached on 20 with 35 sessions - counted; HIT not by 30; MISS not; RUN (40 sessions) not
  const s30 = T.stats(rows, 30, 80);
  assert.deepStrictEqual([s30.done, s30.hit, s30.not, s30.pending, s30.early, s30.other, s30.none], [4, 1, 3, 0, 0, 1, 1]);
  assert.strictEqual(s30.rate, 0.25);
  assert.ok(s30.lo > 0 && s30.lo < 0.25 && s30.hi > 0.25 && s30.hi < 1, s30.lo + ' ' + s30.hi);
  // 60 sessions: HIT reached 80 % on 60 (counted, 85 sessions); EARLY reached it but has only 35 sessions - early, not counted
  const s = T.stats(rows, 60, 80);
  assert.deepStrictEqual([s.done, s.hit, s.not, s.pending, s.early], [2, 1, 1, 2, 1]);
  assert.strictEqual(T.stats(rows, 60, 100).hit, 0, 'the target itself: HIT reached it on 75');
  const up = (2322.17 / 1624.1 - 1) * 100;
  assert.ok(Math.abs(T.outcome(rows[0], 60, 80) - up * 0.8) < 1e-9, 'reached: sold at the 80 % level');
  assert.strictEqual(T.outcome(rows[1], 60, 80), null, 'reached, but its 60 sessions are not over');
  assert.strictEqual(T.outcome(rows[2], 60, 80), -10, 'missed: the close of the 60th session');
  assert.ok(Math.abs(s.avgOut - (up * 0.8 - 10) / 2) < 1e-9, s.avgOut);
  assert.ok(Math.abs(T.level(rows[0], 80) - (1624.1 + 0.8 * (2322.17 - 1624.1))) < 1e-9);
  assert.ok(Math.abs(T.level(rows[4], 80) - (1624.1 - 0.8 * 124.1)) < 1e-9, 'a downside level is under the entry');
  const d = T.stats(rows, 30, 80, 'down');
  assert.deepStrictEqual([d.n, d.done, d.hit, d.other], [1, 1, 1, 4]);
  assert.ok(Math.abs(rows[0].pe - 1624.1 / 20.26) < 1e-9 && Math.abs(rows[0].up - up) < 1e-9);
  const g = T.bucket(rows, 30, 80, (r) => r.g, T.GROWTH);
  assert.deepStrictEqual(g.map((x) => x.label), ['0–20%', '20–40%', '40–60%', '60–100%', '100–150%', 'Over 150%']);
  assert.strictEqual(g[4].done, 4, 'the long targets only (114.6 % growth)');
  assert.deepStrictEqual(T.groupBy(rows, 30, 80, (r) => r.sym === 'MISS' ? 'Banks' : 'Pharma', 1).map((x) => [x.label, x.done, x.hit]), [['Pharma', 3, 1], ['Banks', 1, 0]]);
  // [finished, still running, reached 50 .. 100 % among the finished, the same among the ones running]
  const W60 = [10, 5, 7, 6, 5, 4, 3, 2, 3, 2, 2, 1, 0, 0];
  assert.deepStrictEqual(T.sumRate({ win: { 60: W60 } }, 60, 90), { done: 10, hit: 3, pending: 5, early: 0, rate: 0.3 });
  assert.deepStrictEqual(T.sumRate({ win: { 60: W60 } }, 60, 80), { done: 10, hit: 4, pending: 5, early: 1, rate: 0.4 });
  assert.deepStrictEqual(T.sumRate({ win: { 60: W60 } }, 60, 50), { done: 10, hit: 7, pending: 5, early: 3, rate: 0.7 });
  assert.deepStrictEqual(T.sumRate({ win: { next: W60 } }, 'next', 70).hit, 5);
  assert.strictEqual(T.sumRate({ win: { 60: [10, 4, 3, 2, 5, 1] } }, 60, 80), null, 'an older summary (80 / 90 / 100 % only): no figures');
  assert.deepStrictEqual(T.sumRate({ dwin: { 60: W14([2, 0, 1, 1, 1, 1]) } }, 60, 80, 'down').rate, 0.5);
  // the target filter (owner: "Atleast target vs Entry % as atleast 10% and above, 20% and above, between"): long targets only
  const big = T.objects({ cols: T.COLS, rows: [row('HIT'), row('HUGE', { tgt: 1624.1 * 30 }), row('SMALL', { tgt: 1624.1 * 1.05 }), row('DOWN', { tgt: 1500 })] });
  assert.strictEqual(T.markOut(big, 10, 100), 2, 'HUGE (+2,900 %) and SMALL (+5 %) left out; HIT (+43 %) in; DOWN never');
  assert.deepStrictEqual(big.map((r) => T.kind(r, 60, 80)), ['hit', 'out', 'out', 'down']);
  const sb = T.stats(big, 60, 80);
  assert.deepStrictEqual([sb.n, sb.done, sb.hit, sb.out, sb.other], [1, 1, 1, 2, 1]);
  assert.deepStrictEqual(T.thesis({ 'Jun 2026': big }, ['Jun 2026'], 60, 80).map((e) => e.marks[0]), ['hit', 'out', 'out', 'down']);
  assert.strictEqual(T.markOut(big, null, null), 0, 'no limit: none left out');
  assert.strictEqual(T.markOut(big, 50, null), 2, 'at least 50 %: HIT (+43 %) and SMALL out');
  // the thesis list: every quarter of every stock
  const q2 = T.objects({ cols: T.COLS, rows: [row('HIT'), row('MISS', { kp: [null, null, null] }), row('DOWN')] });
  const th = T.thesis({ 'Jun 2026': rows, 'Mar 2026': q2 }, ['Mar 2026', 'Jun 2026'], 60, 80);
  const of = (sym) => th.filter((e) => e.sym === sym)[0];
  assert.deepStrictEqual(of('HIT').marks, ['hit', 'hit']);
  assert.ok(of('HIT').every && of('HIT').done === 2 && of('HIT').hit === 2);
  assert.deepStrictEqual(of('MISS').marks, ['not', 'not']);
  assert.ok(!of('MISS').most && of('MISS').rate === 0);
  assert.deepStrictEqual(of('EARLY').marks, ['', 'early'], 'a target reached counts while its window still runs');
  assert.ok(of('EARLY').hit === 1 && !of('EARLY').every, 'one finished quarter is not enough for "every"');
  assert.deepStrictEqual(of('DOWN').marks, ['hit', 'down'], 'Mar 2026: a long target reached; Jun 2026: a downside target, not counted');
  assert.deepStrictEqual(of('RUN').marks, ['', 'pending']);
  assert.strictEqual(T.fy('Jun 2026'), 'Q1 FY27');
  assert.strictEqual(T.fy('Mar 2026'), 'Q4 FY26');
  assert.strictEqual(T.fy('Dec 2025'), 'Q3 FY26');
  assert.deepStrictEqual(T.quarters('Jun 2026'), ['Sep 2024', 'Dec 2024', 'Mar 2025', 'Jun 2025', 'Sep 2025', 'Dec 2025', 'Mar 2026', 'Jun 2026']);
  const f = T.formula(rows[0]);
  assert.strictEqual(f.ttm, '3.61 + 4.67 + 5.17 + 6.81 = 20.26');
  assert.strictEqual(f.growth, '(20.26 − 9.44) ÷ 9.44 × 100 = 114.6%');
  assert.strictEqual(f.target, '20.26 × 114.6 = 2322.17');
});

test('a quarter packed by the laptop\'s own code reads the same through the sheet, the api and the page', { skip: !py && 'python3 not installed' }, async () => {
  const code = 'import sys, json; sys.path.insert(0, sys.argv[1]); import eps_target as E\n' +
    'r = {k: None for k in E.COLS}; r.update(sym="LAURUSLABS", st="ok", why="", b="C", fl="r-------", eps=[0.37,1.71,4.34,3.02,3.61,4.67,5.17,6.81])\n' +
    't = E.target_of({E.mi_label(l): v for l, v in zip(["Sep 2024","Dec 2024","Mar 2025","Jun 2025","Sep 2025","Dec 2025","Mar 2026","Jun 2026"], r["eps"])}, E.mi_label("Jun 2026"))\n' +
    'r.update(ttm=t["ttm"], prev=t["prev"], g=t["g"], tgt=t["tgt"], ann="2026-07-24 16:05", src="nse", ed="2026-07-27", ep=1624.1, pre=1600.0, o0=1610.0, n=95,\n' +
    '  kp=[38, 45, 53, 60, 68, 75], kd=["2026-09-17","2026-09-28","2026-10-08","2026-10-21","2026-10-31","2026-11-11"], pg=[40.0, 80.0, 120.0, 120.0, 120.0],\n' +
    '  hh=[17.0]*5, dd=[-3.0]*5, cl=[10.0,20.0,30.0,None,None], ix=[1.0,2.0,3.0,None,None], nq=70, nqa=0, nx="2026-10-29 16:30", wq=[95.0,45.0,-3.0,25.0,2.0],\n' +
    '  now=46.0, ph=[1.0], pc=[1.0])\n' +
    'print(json.dumps({"blob": E.pack([r]), "sum": E.summary([r])}))\n';
  const p = spawnSync(py, ['-c', code, path.join(__dirname, '..', 'pcbridge', 'ScreenerBridge')], { encoding: 'utf8' });
  assert.strictEqual(p.status, 0, p.stderr);
  const got = JSON.parse(p.stdout);
  const e = env();
  assert.strictEqual(e.post({ token: TOKEN, action: 'epst', op: 'put', q: 'Jun 2026', end: '2026-06-30', fy: 'Q1 FY27', made: '2026-11-23T10:00:00',
    upto: '2026-11-20', sum: got.sum, blob: got.blob, engine: 3 }).ok, true);
  const fetch = async (url, init) => new Response(JSON.stringify(e.post(JSON.parse(init.body))), { status: 200, headers: { 'content-type': 'application/json' } });
  const h = api.createHandler({ env: { SHEET_FEED_URL: 'https://script.google.com/macros/s/X/exec', SHEET_FEED_TOKEN: FEED, SITE_ACCESS: 'open' }, fetch, now: () => NOW,
    cache: require('../api/_lib/cache').createCache() });
  const r = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; }, end() {} };
  await h({ method: 'GET', query: {} }, r);
  const rows = T.objects(r.body);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].tgt, 2322.17);
  assert.strictEqual(rows[0].fl, 'r-------');
  assert.strictEqual(T.status(rows[0], 90, 80), 'hit');
  assert.strictEqual(T.status(rows[0], 60, 100), 'not');
  assert.deepStrictEqual(r.body.quarters[0].sum.win['60'], got.sum.win['60']);
  assert.deepStrictEqual(got.sum.win['60'], [1, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0], 'Python\'s summary = the page\'s own count');
  assert.deepStrictEqual(got.sum.win.next, [1, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], 'next results 70 sessions after the entry');
  assert.deepStrictEqual(r.body.quarters[0].sum.win.next, got.sum.win.next);
  for (const W of [30, 60, 90, 120, 180, 'next']) {
    for (const Tt of T.THRESH) {
      const S = T.stats(rows, W, Tt), x = T.sumRate(got.sum, W, Tt);
      assert.deepStrictEqual([S.done, S.hit, S.pending, S.early], [x.done, x.hit, x.pending, x.early], W + ' / ' + Tt);
    }
  }
  assert.strictEqual(T.status(rows[0], 'next', 90), 'hit');
  assert.strictEqual(T.status(rows[0], 'next', 100), 'not');
});
