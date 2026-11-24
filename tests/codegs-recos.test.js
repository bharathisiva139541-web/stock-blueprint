'use strict';
// Analyst Targets (owner, 24-Nov-2026, JLHL: Prabhudas Lilladher's Buy with a target of Rs 330, reached on 24-Nov): the laptop
// (pcbridge/ScreenerBridge/analyst_recos.py) asks Main's names and posts every broker call since 1-Oct-2026 -> Code2.gs
// ab_recosFromBridge_ (tab Analyst_Recos) -> doPost action 'site' part 'recos' -> api/recos (unpacks + checks) -> web/lib/recos.js.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const mock = require('./fixtures/apps-script-mock.js');
const R = require('../web/lib/recos.js');
const E = require('../web/lib/epstarget.js');
const api = require('../api/recos');

const TOKEN = 'bridge-token-0123456789';
const FEED = 'feed-token-abcdef';
const NOW = Date.UTC(2026, 10, 24, 9, 0);
const HEAD = ['Checkbox', 'StockName', 'SYMBOL', 'MKT Price', 'Price Fall Alert Price', 'Breakout Alert Price', 'Triggered Y/N'];
const py = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);

function env() {
  return mock.loadCodeGs({ sheets: [
    { name: 'Main', rows: [['Main'], HEAD, [false, 'Jupiter Life Line Hospitals Ltd', 'JLHL', 297.45], [false, 'Bharat Electronics Ltd', 'BEL', 410]] },
    { name: 'PatternData', rows: [['Date', 'x', 'y', 'Symbol'], ['', '', '', 'JLHL']] },
    { name: 'AutoFetch Log', rows: [['ts']] }
  ] }, { props: { AB_BRIDGE_TOKEN: TOKEN, AB_FEED_TOKEN: FEED }, now: NOW });
}
function row(sym, o) {
  const r = Object.assign({ sym, co: 'Jupiter Life Line Hospitals', br: 'Prabhudas Lilladher', call: 'BUY', tgt: 330, rp: null, at: '2026-10-27 09:15', src: 'mc',
    url: 'https://www.moneycontrol.com/news/business/stocks/buy-jupiter-life-line-hospitals-target-of-rs-330-prabhudas-lilladher-13654321.html',
    seen: '2026-10-27', st: 'ok', why: '', ed: '2026-10-27', ep: 300, pre: 296, o0: 298, n: 95, kp: [10, 15, 20, 25, 30, 40],
    kd: ['2026-11-10', '2026-11-17', '2026-11-24', '2026-12-01', '2026-12-08', '2026-12-22'], pg: [60, 110, 120, 120, 120], hh: [12, 15, 20, 25, 25],
    dd: [-3, -4, -5, -5, -5], cl: [5, 8, 12, null, null], ix: [1, 2, 3, null, null], now: 11, ph: [1, 2], pc: [1, 2] }, o || {});
  return R.COLS.map((k) => r[k]);
}
const pack = (rows) => zlib.gzipSync(Buffer.from(JSON.stringify({ cols: R.COLS, rows }))).toString('base64');
const SUM = { recos: 3, ok: 2, brokers: 2, stocks: 1, buy: 3, why: { nosym: 1, bogus: 3 }, src: { mc: 3, evil: 1 }, from: '2026-10-01', to: '2026-11-21' };

test('op names = Main\'s symbols and names; op put keeps one row; site part recos; refusals', () => {
  const e = env();
  assert.deepStrictEqual(e.post({ token: TOKEN, action: 'recos', op: 'names' }), { ok: true, names: { JLHL: 'Jupiter Life Line Hospitals Ltd', BEL: 'Bharat Electronics Ltd' } });
  assert.strictEqual(e.post({ token: 'wrong', action: 'recos', op: 'names' }).ok, false, 'the bridge token');
  assert.deepStrictEqual(e.post({ token: FEED, action: 'site', part: 'recos' }).blob, '', 'nothing yet');
  const big = 'A'.repeat(100000);
  assert.deepStrictEqual(e.post({ token: TOKEN, action: 'recos', op: 'put', made: '2026-11-24T10:00:00', upto: '2026-11-21', sum: SUM, blob: big, engine: 1 }),
    { ok: true, parts: 3 });
  const b = pack([row('JLHL')]);
  assert.deepStrictEqual(e.post({ token: TOKEN, action: 'recos', op: 'put', made: '2026-11-24T11:00:00', upto: '2026-11-21', sum: SUM, blob: b, engine: 1 }),
    { ok: true, parts: 1 });
  const s = e.post({ token: FEED, action: 'site', part: 'recos' });
  assert.strictEqual(s.blob, b, 'only the new part - no old part left behind');
  assert.strictEqual(s.made, '2026-11-24T11:00:00');
  assert.deepStrictEqual(s.sum, { recos: 3, ok: 2, brokers: 2, stocks: 1, buy: 3, why: { nosym: 1 }, src: { mc: 3 }, from: '2026-10-01', to: '2026-11-21' });
  for (const bad of [{ engine: 0 }, { blob: 'not base64!' }, { blob: '' }]) {
    assert.strictEqual(e.post(Object.assign({ token: TOKEN, action: 'recos', op: 'put', blob: b, engine: 1 }, bad)).ok, false, JSON.stringify(bad));
  }
  assert.strictEqual(e.post({ token: TOKEN, action: 'recos', op: 'x' }).ok, false);
  assert.strictEqual(e.post({ token: TOKEN, action: 'site', part: 'recos' }).ok, false, 'the bridge token is not the feed token');
});

test('api/recos: unpacks + checks every column, no chart paths, caches; no secret leaks', async () => {
  const e = env();
  const odd = row('ODD', { co: 'Evil <script>alert(1)</script> me@x.com', br: 'B@d Broker', url: 'https://evil.example.com/x', src: 'mc,zz', at: 'soon' });
  const odd2 = row('', { co: 'Some Unknown Co', br: 'Ventura', st: 'x', why: 'nosym', url: 'javascript:alert(1)', kp: 'x' });
  const sell = row('BEL', { co: 'Bharat Electronics', br: 'Kotak Securities', call: 'SELL', tgt: 350, ep: 410, at: '2026-11-03' });
  e.post({ token: TOKEN, action: 'recos', op: 'put', made: '2026-11-24T10:00:00', upto: '2026-11-21', sum: SUM,
    blob: pack([row('JLHL'), odd, odd2, sell, row('BAD SYM'), row('X', { call: 'MAYBE' }), 'junk']), engine: 1 });
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
  assert.strictEqual(r.body.ok, true);
  assert.deepStrictEqual(r.body.cols, R.COLS);
  const ci = (k) => R.COLS.indexOf(k);
  assert.deepStrictEqual(r.body.rows.map((x) => x[ci('co')]), ['Jupiter Life Line Hospitals', 'Some Unknown Co', 'Bharat Electronics'],
    'a row without a date / a bad symbol / an unknown call / junk left out');
  const j = r.body.rows[0];
  assert.deepStrictEqual([j[ci('sym')], j[ci('br')], j[ci('call')], j[ci('tgt')], j[ci('at')], j[ci('src')]], ['JLHL', 'Prabhudas Lilladher', 'BUY', 330, '2026-10-27 09:15', 'mc']);
  assert.ok(/^https:\/\/www\.moneycontrol\.com\//.test(j[ci('url')]));
  assert.deepStrictEqual([j[ci('ph')], j[ci('pc')]], [[], []], 'no chart paths on this page');
  assert.deepStrictEqual(j[ci('kp')], [10, 15, 20, 25, 30, 40]);
  const u = r.body.rows[1];
  assert.deepStrictEqual([u[ci('url')], u[ci('kp')], u[ci('why')], u[ci('st')]], ['', [], 'nosym', 'x'], 'a strange link / bad numbers dropped');
  assert.deepStrictEqual(r.body.sum.why, { nosym: 1 });
  assert.match(r.headers['cache-control'], /s-maxage=1800/);
  assert.deepStrictEqual(calls[0], { action: 'site', part: 'recos', token: FEED });
  const text = JSON.stringify(r.body) + JSON.stringify(r.headers);
  assert.ok(text.indexOf(FEED) < 0 && text.indexOf('AKfy_SECRET') < 0 && text.indexOf('@') < 0 && text.indexOf('<script') < 0, 'no token / address / mail / markup');
  assert.ok(!require('../api/site.js').PERSONAL_MARKERS.some((re) => re.test(JSON.stringify(r.body))), 'nothing the site guard would block');
  r = res();
  await h({ method: 'GET', query: {} }, r);
  assert.strictEqual(calls.length, 1, 'a second ask within 30 minutes: from the server\'s memory');
  r = res();
  await api.createHandler({ env: {}, fetch })({ method: 'GET', query: {} }, r);
  assert.strictEqual(r.body.ok, false, 'not configured');
  assert.throws(() => api.unpack(zlib.gzipSync(Buffer.from(JSON.stringify({ cols: ['sym'], rows: [] }))).toString('base64')), /AnalystNow\.bat/);
});

test('web/lib/recos.js: SB.epst\'s counting on the brokers\' calls, the scorecard, one stock, the newest calls', () => {
  const rows = R.objects({ cols: R.COLS, rows: [
    row('JLHL'),                                                                                    // the target on 40 (95 sessions)
    row('JLHL', { br: 'Choice', tgt: 340, kp: [12, 20, 30, null, null, null], cl: [4, 6, 9, null, null] }),
    row('A', { br: 'Motilal Oswal', tgt: 600, ep: 500, kp: [2, 3, 4, 5, 6, 8], at: '2026-10-10', cl: [10, 12, 14, null, null], hh: [20, 30, 30, 30, 30] }),
    row('B', { br: 'Motilal Oswal', tgt: 900, ep: 800, kp: [null, null, null, null, null, null], at: '2026-10-12', cl: [-2, -4, -6, null, null], dd: [-8, -10, -12, -12, -12] }),
    row('C', { br: 'Motilal Oswal', tgt: 1200, ep: 1000, kp: [10, 15, 20, 30, 40, 50], at: '2026-10-14' }),
    row('D', { br: 'ICICI Securities', tgt: 300, ep: 200, n: 40, kp: [null, null, null, null, null, null], at: '2026-11-01', cl: [3, null, null, null, null] }),
    row('E', { br: 'Kotak Securities', call: 'SELL', tgt: 50, ep: 80, at: '2026-10-20' }),
    row('', { co: 'Some Unknown Co', br: 'Ventura', st: 'x', why: 'nosym', at: '2026-11-05', kp: [], pg: [] }),
    row('A', { br: 'HDFC Securities', tgt: 650, at: '2026-11-21 18:00', st: 'x', why: 'wait' })
  ] });
  assert.deepStrictEqual(rows.map((r) => [r.dir, r.buy]).slice(0, 7), [['up', true], ['up', true], ['up', true], ['up', true], ['up', true], ['up', true], ['down', false]]);
  const buys = R.pick(rows, 'buy');
  assert.strictEqual(buys.length, 8, 'the Sell call left out');
  const S = E.stats(buys, 60, 100);
  assert.deepStrictEqual([S.n, S.done, S.hit, S.pending, S.none], [6, 5, 3, 1, 2]);
  assert.ok(Math.abs(S.rate - 0.6) < 1e-9);
  assert.strictEqual(E.stats(buys, 60, 70).hit, 4, 'Choice reached 70 % of the way on 30');
  const sc = R.scorecard(buys, 60, 100, 3);
  assert.strictEqual(sc[0].label, 'Motilal Oswal');
  assert.deepStrictEqual([sc[0].calls, sc[0].done, sc[0].hit, sc[0].ranked, sc[0].stocks], [3, 3, 2, true, 3]);
  assert.ok(Math.abs(sc[0].r30 - (10 - 2 + 5) / 3) < 1e-9 && Math.abs(sc[0].avgHh - (30 + 15 + 15) / 3) < 1e-9, sc[0].r30 + ' ' + sc[0].avgHh);
  assert.ok(sc.slice(1).every((s) => !s.ranked), 'the rest have fewer than 3 finished calls');
  const c = R.consensus(buys.filter((r) => r.sym === 'JLHL'));
  assert.deepStrictEqual([c.calls, c.brokers, c.avg, c.hi, c.lo], [2, 2, 335, 340, 330]);
  assert.deepStrictEqual(R.fresh(buys, 3).map((r) => r.br), ['HDFC Securities'], 'the newest 3 days from the newest call (21-Nov)');
  assert.strictEqual(R.kind(rows[6], 60, 100), 'down');
  assert.strictEqual(E.status(rows[6], 60, 100), 'hit', 'the Sell call: fell to its target');
});

test('a list packed by the laptop\'s own code reads the same through the sheet, the api and the page', { skip: !py && 'python3 not installed' }, async () => {
  const code = 'import sys, json; sys.path.insert(0, sys.argv[1]); import analyst_recos as A\n' +
    'r = {k: None for k in A.COLS}; r.update(sym="JLHL", co="Jupiter Life Line Hospitals", br="Prabhudas Lilladher", call="BUY", tgt=330.0, at="2026-10-27 09:15",\n' +
    '  src="mc,dsij", url="https://www.moneycontrol.com/news/business/stocks/x-1.html", seen="2026-10-27", st="ok", why="", ed="2026-10-27", ep=300.0, pre=296.0, o0=298.0,\n' +
    '  n=95, kp=[10,15,20,25,30,40], kd=["2026-11-10","2026-11-17","2026-11-24","2026-12-01","2026-12-08","2026-12-22"], pg=[60.0,110.0,120.0,120.0,120.0],\n' +
    '  hh=[12.0]*5, dd=[-3.0]*5, cl=[5.0,8.0,12.0,None,None], ix=[1.0,2.0,3.0,None,None], now=11.0, ph=[1.0], pc=[1.0])\n' +
    'print(json.dumps({"blob": A.pack([r]), "sum": A.summary([r])}))\n';
  const p = spawnSync(py, ['-c', code, path.join(__dirname, '..', 'pcbridge', 'ScreenerBridge')], { encoding: 'utf8' });
  assert.strictEqual(p.status, 0, p.stderr);
  const got = JSON.parse(p.stdout);
  const e = env();
  assert.strictEqual(e.post({ token: TOKEN, action: 'recos', op: 'put', made: '2026-11-24T10:00:00', upto: '2026-11-21', sum: got.sum, blob: got.blob, engine: 1 }).ok, true);
  const fetch = async (url, init) => new Response(JSON.stringify(e.post(JSON.parse(init.body))), { status: 200, headers: { 'content-type': 'application/json' } });
  const h = api.createHandler({ env: { SHEET_FEED_URL: 'https://script.google.com/macros/s/X/exec', SHEET_FEED_TOKEN: FEED }, fetch, now: () => NOW,
    cache: require('../api/_lib/cache').createCache() });
  const r = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; }, end() {} };
  await h({ method: 'GET', query: {} }, r);
  const rows = R.objects(r.body);
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual([rows[0].sym, rows[0].srcs, rows[0].dir, E.status(rows[0], 60, 100)], ['JLHL', ['mc', 'dsij'], 'up', 'hit']);
  assert.deepStrictEqual(r.body.sum.src, { mc: 1, dsij: 1 });
  const py2 = spawnSync(py, ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); import analyst_recos as A; print(",".join(A.COLS))',
    path.join(__dirname, '..', 'pcbridge', 'ScreenerBridge')], { encoding: 'utf8' });
  assert.deepStrictEqual(py2.stdout.trim().split(','), api.COLS, 'the same columns in Python, the api and the page');
  assert.deepStrictEqual(api.COLS, R.COLS);
});
