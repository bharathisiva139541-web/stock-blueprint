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
    prev: 9.44, g: 114.62, tgt: 2322.17, ann: '2026-07-24 16:05', src: 'nse', ed: '2026-07-27', ep: 1624.1, pre: 1600, o0: 1610, n: 85, hit: 75,
    hitd: '2026-11-11', mx: [70, 85, 101, 101, 101], dd: [-3, -3, -3, -3, -3], cl: [10, 20, null, null, null], ix: [1, 2, null, null, null], now: 46,
    ph: [1, 2, 3], pc: [1, 2, 3] }, o || {});
  return T.COLS.map((k) => r[k]);
}
function pack(rows) {
  return zlib.gzipSync(Buffer.from(JSON.stringify({ cols: T.COLS, rows: rows }))).toString('base64');
}
const SUM = { stocks: 3, ok: 2, target: 2, above: 0, why: { fell: 1, bogus: 4 }, win: { 30: [2, 0, 0, 0, 0], 60: [2, 0, 1, 0, 0], 90: [1, 1, 0, 1, 1], x: [1] },
  medG: 114.62, medUp: 43.0, medN: 85, ready: true, ann: { nse: 2, evil: 1 } };

test('op put: a quarter a row (replaced, newest 16 by quarter end), checked; op list; refusals', () => {
  const e = env();
  const blob = pack([row('LAURUSLABS'), row('FLAT', { st: 'x', why: 'fell', tgt: null, g: -5 })]);
  const r = e.post({ token: TOKEN, action: 'epst', op: 'put', q: 'Jun 2026', end: '2026-06-30', fy: 'Q1 FY27', made: '2026-11-23T10:00:00',
    upto: '2026-11-20', sum: SUM, blob: blob, engine: 1 });
  assert.deepStrictEqual(r, { ok: true, stored: 'Jun 2026', parts: 1 });
  assert.strictEqual(e.post({ token: 'wrong', action: 'epst', op: 'list' }).ok, false, 'the bridge token');
  assert.deepStrictEqual(e.post({ token: TOKEN, action: 'epst', op: 'list' }).quarters, [{ q: 'Jun 2026', made: '2026-11-23T10:00:00', upto: '2026-11-20' }]);
  for (const bad of [{ q: 'Jul 2026' }, { engine: 0 }, { blob: 'not base64!' }, { blob: '' }]) {
    const x = e.post(Object.assign({ token: TOKEN, action: 'epst', op: 'put', q: 'Jun 2026', blob: blob, engine: 1 }, bad));
    assert.strictEqual(x.ok, false, JSON.stringify(bad));
  }
  // a big quarter in parts, then a smaller one in the same row: no old part left behind
  const big = 'A'.repeat(100000);
  assert.strictEqual(e.post({ token: TOKEN, action: 'epst', op: 'put', q: 'Sep 2026', end: '2026-09-30', blob: big, engine: 1 }).parts, 3);
  assert.strictEqual(e.post({ token: TOKEN, action: 'epst', op: 'put', q: 'Sep 2026', end: '2026-09-30', blob: 'QUJD', engine: 1 }).parts, 1);
  const s = e.post({ token: FEED, action: 'site', part: 'epst', q: 'Sep 2026' });
  assert.strictEqual(s.blob, 'QUJD', 'only the new part');
  // 18 quarters -> the newest 16 by quarter end
  for (let y = 2021; y <= 2025; y++) {
    for (const m of ['Mar', 'Jun', 'Sep', 'Dec']) {
      const end = { Mar: '03-31', Jun: '06-30', Sep: '09-30', Dec: '12-31' }[m];
      e.post({ token: TOKEN, action: 'epst', op: 'put', q: m + ' ' + y, end: y + '-' + end, blob: 'QUJD', engine: 1 });
    }
  }
  const qs = e.post({ token: TOKEN, action: 'epst', op: 'list' }).quarters.map((x) => x.q);
  assert.strictEqual(qs.length, 16);
  assert.deepStrictEqual(qs.slice(0, 3), ['Sep 2026', 'Jun 2026', 'Dec 2025']);
  assert.ok(qs.indexOf('Mar 2021') < 0 && qs.indexOf('Dec 2022') >= 0, qs.join(','));
});

test('site part epst: the quarters + one quarter\'s blob (asked, else the newest ready one); the feed token only', () => {
  const e = env();
  assert.deepStrictEqual(e.post({ token: FEED, action: 'site', part: 'epst' }), { ok: true, quarters: [], q: '', blob: '' }, 'nothing yet');
  const b1 = pack([row('LAURUSLABS')]);
  e.post({ token: TOKEN, action: 'epst', op: 'put', q: 'Jun 2026', end: '2026-06-30', fy: 'Q1 FY27', upto: '2026-11-20', sum: SUM, blob: b1, engine: 1 });
  e.post({ token: TOKEN, action: 'epst', op: 'put', q: 'Sep 2026', end: '2026-09-30', fy: 'Q2 FY27', sum: Object.assign({}, SUM, { ready: false }), blob: 'QUJD', engine: 1 });
  const s = e.post({ token: FEED, action: 'site', part: 'epst' });
  assert.strictEqual(s.q, 'Jun 2026', 'the newest quarter whose results mostly had 30 sessions (the owner\'s Q1), not the running one');
  assert.strictEqual(s.blob, b1);
  assert.deepStrictEqual(s.quarters.map((x) => [x.q, x.fy, x.sum.ready]), [['Sep 2026', 'Q2 FY27', false], ['Jun 2026', 'Q1 FY27', true]]);
  const sum = s.quarters[1].sum;
  assert.deepStrictEqual(sum.why, { fell: 1 }, 'unknown reasons dropped');
  assert.deepStrictEqual(sum.ann, { nse: 2 });
  assert.deepStrictEqual(Object.keys(sum.win), ['30', '60', '90']);
  assert.strictEqual(e.post({ token: FEED, action: 'site', part: 'epst', q: 'Sep 2026' }).blob, 'QUJD');
  const miss = e.post({ token: FEED, action: 'site', part: 'epst', q: 'Mar 2020' });
  assert.ok(miss.ok && miss.q === 'Mar 2020' && miss.blob === '' && miss.quarters.length === 2, 'a quarter not kept: no rows');
  assert.strictEqual(e.post({ token: FEED, action: 'site', part: 'epst', q: '<x>' }).ok, false);
  assert.strictEqual(e.post({ token: TOKEN, action: 'site', part: 'epst' }).ok, false, 'the bridge token is not the feed token');
});

test('api/epstarget: unpacks + checks the rows, caches on the CDN; bad quarter 400; no secret leaks', async () => {
  const e = env();
  const evil = row('EVIL', { sym: 'a b <script>', ann: 'x@y.com' });
  const odd = row('ODD', { why: 'nonsense', fl: 'XYZ', src: 'moneycontrol', eps: ['=1', 2], ann: 'mail me@x.com', hitd: 'soon', mx: 'x' });
  e.post({ token: TOKEN, action: 'epst', op: 'put', q: 'Jun 2026', end: '2026-06-30', fy: 'Q1 FY27', made: '2026-11-23T10:00:00', upto: '2026-11-20',
    sum: SUM, blob: pack([row('LAURUSLABS'), evil, odd, 'junk']), engine: 1 });
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify(e.post(JSON.parse(init.body))), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const ENV = { SHEET_FEED_URL: 'https://script.google.com/macros/s/AKfy_SECRET_X/exec', SHEET_FEED_TOKEN: FEED };
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
  assert.deepStrictEqual(r.body.rows.map((x) => x[0]), ['LAURUSLABS', 'ODD'], 'a bad symbol / a broken row left out');
  const o = r.body.rows[1];
  assert.deepStrictEqual([o[2], o[4], o[11], o[10], o[18]], ['', '', '', '', ''], 'unknown codes and texts blanked');
  assert.deepStrictEqual(o[5], [null, 2], 'numbers only');
  assert.deepStrictEqual(o[19], []);
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
  r = res();
  await h({ method: 'GET', query: { q: 'June' } }, r);
  assert.strictEqual(r.statusCode, 400);
  r = res();
  await api.createHandler({ env: {}, fetch })({ method: 'GET', query: {} }, r);
  assert.strictEqual(r.body.ok, false, 'not configured');
  assert.throws(() => api.unpack('$$$'), /not readable/);
  assert.throws(() => api.unpack(zlib.gzipSync(Buffer.from(JSON.stringify({ cols: ['sym'], rows: [] }))).toString('base64')), /other columns/);
});

test('web/lib/epstarget.js: status per window, hit rate + likely range, outcome, groups, quarters, formula', () => {
  const rows = T.objects({ cols: T.COLS, rows: [
    row('HIT'),                                                                      // reached on session 75
    row('EARLY', { hit: 20, hitd: '2026-08-25', n: 35, mx: [101, 101, 101, 101, 101], cl: [30, null, null, null, null] }),
    row('NEAR', { hit: null, hitd: '', mx: [90, 98.5, 99, 99, 99], cl: [5, 8, null, null, null] }),
    row('MISS', { hit: null, hitd: '', mx: [60, 70, 75, 75, 75], cl: [-5, -10, null, null, null], dd: [-12, -20, -20, -20, -20] }),
    row('RUN', { hit: null, hitd: '', n: 40, mx: [80, 85, 85, 85, 85], cl: [3, null, null, null, null] }),
    row('ABOVE', { tgt: 1500, hit: null }),
    row('NONE', { st: 'x', why: 'fell', tgt: null, g: -3 })
  ] });
  const by = (W) => Object.fromEntries(rows.map((r) => [r.sym, T.status(r, W)]));
  assert.deepStrictEqual(by(30), { HIT: 'not', EARLY: 'hit', NEAR: 'not', MISS: 'not', RUN: 'not', ABOVE: 'above', NONE: 'none' });
  assert.deepStrictEqual(by(60), { HIT: 'not', EARLY: 'hit', NEAR: 'near', MISS: 'not', RUN: 'pending', ABOVE: 'above', NONE: 'none' });
  assert.deepStrictEqual(by(90), { HIT: 'hit', EARLY: 'hit', NEAR: 'pending', MISS: 'pending', RUN: 'pending', ABOVE: 'above', NONE: 'none' });
  const s30 = T.stats(rows, 30);
  assert.deepStrictEqual([s30.done, s30.hit, s30.near, s30.not, s30.pending, s30.early], [5, 1, 0, 4, 0, 0]);
  assert.strictEqual(s30.rate, 0.2);
  assert.ok(s30.lo > 0 && s30.lo < 0.2 && s30.hi > 0.2 && s30.hi < 1, s30.lo + ' ' + s30.hi);
  // 60 sessions: EARLY reached it on session 20 but has only 35 sessions - counted once its 60 are over (no flattering early hits)
  const s = T.stats(rows, 60);
  assert.deepStrictEqual([s.done, s.hit, s.near, s.not, s.pending, s.early, s.above, s.none], [3, 0, 1, 2, 2, 1, 1, 1]);
  assert.strictEqual(s.rate, 0);
  const up = (2322.17 / 1624.1 - 1) * 100;
  assert.ok(Math.abs(T.outcome(rows[1], 30) - up) < 1e-9, 'reached: sold at the target');
  assert.strictEqual(T.outcome(rows[1], 60), null, 'reached, but its 60 sessions are not over');
  assert.strictEqual(T.outcome(rows[3], 60), -10, 'missed: the close of the 60th session');
  assert.strictEqual(T.outcome(rows[4], 60), null, 'still running');
  assert.ok(Math.abs(s.avgOut - (20 + 8 - 10) / 3) < 1e-9, s.avgOut);
  assert.strictEqual(s.avgRet, (20 + 8 - 10) / 3, 'the 60-session close of the ones with 60 sessions');
  assert.ok(Math.abs(rows[0].pe - 1624.1 / 20.26) < 1e-9 && Math.abs(rows[0].up - up) < 1e-9);
  const g = T.bucket(rows, 60, (r) => r.g, T.GROWTH);
  assert.deepStrictEqual(g.map((x) => x.label), ['0–20%', '20–40%', '40–60%', '60–100%', '100–150%', 'Over 150%']);
  assert.strictEqual(g[4].done, 3, 'every result here grew 114.6 % (above / no target / still running left out)');
  assert.deepStrictEqual(T.groupBy(rows, 30, (r) => r.sym === 'MISS' ? 'Banks' : 'Pharma', 1).map((x) => [x.label, x.done, x.hit]), [['Pharma', 4, 1], ['Banks', 1, 0]]);
  assert.deepStrictEqual(T.sumRate({ win: { 60: [10, 4, 1, 3, 2] } }, 60), { done: 10, hit: 4, near: 1, pending: 3, early: 2, rate: 0.4 });
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
    'r.update(ttm=t["ttm"], prev=t["prev"], g=t["g"], tgt=t["tgt"], ann="2026-07-24 16:05", src="nse", ed="2026-07-27", ep=1624.1, pre=1600.0, o0=1610.0, n=85, hit=75, hitd="2026-11-11",\n' +
    '  mx=[70.1,85.2,101.0,101.0,101.0], dd=[-3.0]*5, cl=[10.0,20.0,None,None,None], ix=[1.0,2.0,None,None,None], now=46.0, ph=[1.0], pc=[1.0])\n' +
    'print(json.dumps({"blob": E.pack([r]), "sum": E.summary([r])}))\n';
  const p = spawnSync(py, ['-c', code, path.join(__dirname, '..', 'pcbridge', 'ScreenerBridge')], { encoding: 'utf8' });
  assert.strictEqual(p.status, 0, p.stderr);
  const got = JSON.parse(p.stdout);
  const e = env();
  assert.strictEqual(e.post({ token: TOKEN, action: 'epst', op: 'put', q: 'Jun 2026', end: '2026-06-30', fy: 'Q1 FY27', made: '2026-11-23T10:00:00',
    upto: '2026-11-20', sum: got.sum, blob: got.blob, engine: 1 }).ok, true);
  const fetch = async (url, init) => new Response(JSON.stringify(e.post(JSON.parse(init.body))), { status: 200, headers: { 'content-type': 'application/json' } });
  const h = api.createHandler({ env: { SHEET_FEED_URL: 'https://script.google.com/macros/s/X/exec', SHEET_FEED_TOKEN: FEED }, fetch, now: () => NOW,
    cache: require('../api/_lib/cache').createCache() });
  const r = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; }, end() {} };
  await h({ method: 'GET', query: {} }, r);
  const rows = T.objects(r.body);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].tgt, 2322.17);
  assert.strictEqual(rows[0].fl, 'r-------');
  assert.strictEqual(T.status(rows[0], 90), 'hit');
  assert.deepStrictEqual(r.body.quarters[0].sum.win['60'], got.sum.win['60']);
});
