'use strict';
// 5 years of quarterly + yearly results from NSE's XBRL filings (owner, 18-Nov-2026: "a table like Screener.in in our
// website"): the laptop (pcbridge/ScreenerBridge/xbrl_history.py) posts each stock's table -> Code2.gs ab_xhFromBridge_
// (tab Financials) -> doPost action 'site' part 'fin' -> api/financials -> web/lib/fin.js in the stock window.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const mock = require('./fixtures/apps-script-mock.js');
const FIN = require('../web/lib/fin.js');
const api = require('../api/financials');

const TOKEN = 'bridge-token-0123456789';
const FEED = 'feed-token-abcdef';
const NOW = Date.UTC(2026, 10, 18, 9, 0);
const HEAD = ['Checkbox', 'StockName', 'SYMBOL', 'MKT Price', 'Price Fall Alert Price', 'Breakout Alert Price', 'Triggered Y/N'];

function env() {
  return mock.loadCodeGs({ sheets: [
    { name: 'Main', rows: [['Main'], HEAD, [false, 'Tata', 'TCS', 3000], [false, 'Bse', 'bse', 2500], [false, '', '', ''], [false, 'Tata', 'TCS', 3000]] },
    { name: 'PatternData', rows: [['Date', 'x', 'y', 'Symbol'], ['', '', '', 'TCS']] },
    { name: 'AutoFetch Log', rows: [['ts']] }
  ] }, { props: { AB_BRIDGE_TOKEN: TOKEN, AB_FEED_TOKEN: FEED }, now: NOW });
}
const Q = (l, rev, flag) => [l, rev, rev * 0.8, rev * 0.2, 20, 5, null, 2, 3, rev * 0.2 + 0, 25, rev * 0.15, rev / 100, flag || ''];
const TABLE = { b: 'C', q: [Q('Jun 2026', 100, 'c'), Q('Sep 2026', 110)], y: [Q('Mar 2026', 400)], files: 5, at: '2026-11-18' };

test('op syms = Main\'s symbols (each once, upper case)', () => {
  const e = env();
  const r = e.post({ token: TOKEN, action: 'xbrlhist', op: 'syms' });
  assert.deepStrictEqual(r, { ok: true, syms: ['TCS', 'BSE'] });
  assert.strictEqual(e.post({ token: 'wrong', action: 'xbrlhist', op: 'syms' }).ok, false, 'the bridge token');
  assert.strictEqual(e.post({ token: TOKEN, action: 'xbrlhist', op: 'x' }).error, 'unknown op');
});

test('op put: one row a stock (replaced, new ones added), the table checked; the website reads one stock', () => {
  const e = env();
  const bad = { b: 'X', q: [['Sep 2026', '=HYPERLINK("x")', 'abc', true, null, 1e400], ['bogus', 1], 'row'], y: 'no', files: -3, at: 'today' };
  const r = e.post({ token: TOKEN, action: 'xbrlhist', op: 'put', items: [{ sym: 'tcs', fin: TABLE }, { sym: 'BSE', fin: bad }, { sym: 'B D', fin: TABLE },
    { sym: 'NONE', fin: { q: [], y: [] } }] });
  assert.deepStrictEqual([r.ok, r.stored, r.bad, r.total], [true, 2, 2, 2]);
  const sh = e.sheet('Financials');
  assert.strictEqual(sh.hidden, true);
  assert.deepStrictEqual(sh.rows[0], ['Symbol', 'Basis', 'Quarters', 'Years', 'Newest Quarter', 'Table Made', 'Received', 'Data (JSON)']);
  assert.deepStrictEqual(sh.rows[1].slice(0, 6), ['TCS', 'C', 2, 1, 'Sep 2026', '2026-11-18']);
  const cleaned = JSON.parse(sh.rows[2][7]);
  assert.deepStrictEqual(cleaned, { b: 'C', q: [['Sep 2026', null, null, null, null, null, null, null, null, null, null, null, null, '']], y: [], files: 0, at: '' },
    'numbers or nothing; a strange basis -> C; unknown labels dropped');
  // the same stock again: its row replaced, not a second one
  const r2 = e.post({ token: TOKEN, action: 'xbrlhist', op: 'put', items: [{ sym: 'TCS', fin: Object.assign({}, TABLE, { b: 'S' }) }] });
  assert.deepStrictEqual([r2.stored, r2.total], [1, 2]);
  assert.strictEqual(sh.rows.filter((x) => x[0] === 'TCS').length, 1);
  assert.strictEqual(sh.rows[1][1], 'S');
  assert.match(e.post({ token: TOKEN, action: 'xbrlhist', op: 'put', items: new Array(201).fill({ sym: 'A', fin: TABLE }) }).error, /too many/);
  // the website: action 'site' part 'fin' with the feed token
  const s = e.post({ token: FEED, action: 'site', part: 'fin', sym: 'tcs' });
  assert.strictEqual(s.ok, true);
  assert.deepStrictEqual(s.fin.q[1].slice(0, 2), ['Sep 2026', 110]);
  assert.strictEqual(s.fin.q[0][13], 'c');
  assert.deepStrictEqual(s.cols, ['rev', 'exp', 'op', 'opm', 'oi', 'exc', 'int', 'dep', 'pbt', 'taxp', 'np', 'eps']);
  assert.deepStrictEqual(e.post({ token: FEED, action: 'site', part: 'fin', sym: 'INFY' }), { ok: true, sym: 'INFY', fin: null });
  assert.strictEqual(e.post({ token: FEED, action: 'site', part: 'fin', sym: '<x>' }).ok, false);
  assert.strictEqual(e.post({ token: TOKEN, action: 'site', part: 'fin', sym: 'TCS' }).ok, false, 'the bridge token is not the feed token');
  assert.strictEqual(env().post({ token: FEED, action: 'site', part: 'fin', sym: 'TCS' }).fin, null, 'no tab yet');
});

test('api/financials: one stock from the sheet, checked again, cached on the CDN; a bad symbol 400; no secret leaks', async () => {
  const e = env();
  e.post({ token: TOKEN, action: 'xbrlhist', op: 'put', items: [{ sym: 'TCS', fin: TABLE }] });
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify(e.post(JSON.parse(init.body))), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const ENV = { SHEET_FEED_URL: 'https://script.google.com/macros/s/AKfy_SECRET_X/exec', SHEET_FEED_TOKEN: FEED };
  const h = api.createHandler({ env: ENV, fetch, now: () => NOW });
  const res = () => {
    const r = { headers: {}, statusCode: 200 };
    r.setHeader = (k, v) => { r.headers[String(k).toLowerCase()] = v; };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (o) => { r.body = JSON.parse(JSON.stringify(o)); };
    r.end = () => {};
    return r;
  };
  let r = res();
  await h({ method: 'GET', query: { sym: 'tcs' } }, r);
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.body.ok, true);
  assert.deepStrictEqual(r.body.fin.q[1].slice(0, 3), ['Sep 2026', 110, 88]);
  assert.match(r.headers['cache-control'], /s-maxage=1800/);
  assert.deepStrictEqual(calls[0], { action: 'site', part: 'fin', sym: 'TCS', token: FEED });
  const text = JSON.stringify(r.body) + JSON.stringify(r.headers);
  assert.ok(text.indexOf(FEED) < 0 && text.indexOf('AKfy_SECRET') < 0, 'no token / web-app address');
  assert.ok(!require('../api/site.js').PERSONAL_MARKERS.some((re) => re.test(JSON.stringify(r.body))), 'nothing the site guard would block');
  r = res();
  await h({ method: 'GET', query: { sym: 'TCS' } }, r);
  assert.strictEqual(calls.length, 1, 'a second ask within 30 minutes: from the server\'s memory');
  r = res();
  await h({ method: 'GET', query: { sym: 'IN FY' } }, r);
  assert.strictEqual(r.statusCode, 400);
  r = res();
  await api.createHandler({ env: {}, fetch })({ method: 'GET', query: { sym: 'TCS' } }, r);
  assert.strictEqual(r.body.ok, false, 'not configured');
  assert.deepStrictEqual(api.cleanFin({ b: 'C', q: [['Sep 2026', 'x', 2, null, 4, 5, 6, 7, 8, 9, 10, 11, 12, 'z']] }).q[0],
    ['Sep 2026', null, 2, null, 4, 5, 6, 7, 8, 9, 10, 11, 12, '']);
});

test('web/lib/fin.js: rows like screener.in (empty rows left out), flags, growth, figures, CSV', () => {
  const v = FIN.view(TABLE, 'q');
  assert.deepStrictEqual(v.labels, ['Jun 2026', 'Sep 2026']);
  assert.deepStrictEqual(v.flags, ['c', '']);
  assert.deepStrictEqual(v.rows.map((r) => r.k), ['rev', 'exp', 'op', 'opm', 'oi', 'int', 'dep', 'pbt', 'taxp', 'np', 'eps'], 'no exceptional figure: no row');
  assert.strictEqual(FIN.view(TABLE, 'y').labels[0], 'Mar 2026');
  assert.strictEqual(FIN.view({ q: [] }, 'q'), null);
  assert.deepStrictEqual(FIN.growth(v, 'rev', 1), [null, 10]);
  assert.strictEqual(FIN.cell(12345.6, 'cr'), '12,346');
  assert.strictEqual(FIN.cell(-3.456, 'cr'), '-3.46');
  assert.strictEqual(FIN.cell(20.4, 'pct'), '20%');
  assert.strictEqual(FIN.cell(1.1, 'eps'), '1.10');
  assert.strictEqual(FIN.cell(null, 'cr'), '');
  const csv = FIN.csv(v, 'TCS');
  assert.deepStrictEqual(csv[0], ['TCS - quarterly (Rs crore)', 'Jun 2026', 'Sep 2026']);
  assert.deepStrictEqual(csv[1], ['Sales', 100, 110]);
  assert.deepStrictEqual(csv[csv.length - 1], ['From', 'a later filing (comparison column)', 'its own filing']);
});

test('version 2 tables: a year summed from its 4 quarters (flag q), the EPS note, a bank\'s row names - sheet, api, page', async () => {
  const NOTE = "EPS adjusted for a bonus / split (today's share count): up to Mar 2025 divided by 3";
  const T2 = Object.assign({}, TABLE, { y: [Q('Mar 2025', 380, 'q'), Q('Mar 2026', 400)], note: NOTE, k: 'bank' });
  const e = env();
  e.post({ token: TOKEN, action: 'xbrlhist', op: 'put', items: [{ sym: 'TCS', fin: T2 },
    { sym: 'BSE', fin: Object.assign({}, TABLE, { note: '=HYPERLINK("http://x")<b>', k: 'insurer' }) }] });
  const s = e.post({ token: FEED, action: 'site', part: 'fin', sym: 'TCS' }).fin;
  assert.deepStrictEqual([s.y[0][13], s.y[1][13], s.note, s.k], ['q', '', NOTE, 'bank']);
  const b = e.post({ token: FEED, action: 'site', part: 'fin', sym: 'BSE' }).fin;
  assert.strictEqual(b.note, 'HYPERLINK(http://x)b', 'no formula, no markup - plain words only');
  assert.strictEqual(b.k, undefined);
  const c = api.cleanFin(Object.assign({}, T2, { note: '<script>x</script>' }));
  assert.deepStrictEqual([c.y[0][13], c.note, c.k], ['q', 'scriptx/script', 'bank']);
  assert.strictEqual(api.cleanFin(TABLE).note, undefined);
  const v = FIN.view(T2, 'y');
  assert.deepStrictEqual([v.flags, v.note, v.bank], [['q', ''], NOTE, true]);
  assert.deepStrictEqual(v.rows.slice(0, 4).map((r) => r.label), ['Revenue', 'Expenses', 'Financing Profit', 'Financing Margin %']);
  assert.strictEqual(FIN.view(TABLE, 'q').rows[0].label, 'Sales', 'other companies keep screener.in\'s usual names');
  const csv = FIN.csv(v, 'TCS');
  assert.deepStrictEqual(csv[csv.length - 2], ['From', 'the sum of its 4 quarters', 'its own filing']);
  assert.deepStrictEqual(csv[csv.length - 1], [NOTE]);
});

test('screener.in\'s figures for the periods NSE has no filing for (flag r) pass the sheet, the api and the page', () => {
  const T3 = Object.assign({}, TABLE, { y: [Q('Mar 2020', 246, 'r'), Q('Mar 2026', 932, 'x')] });
  const e = env();
  e.post({ token: TOKEN, action: 'xbrlhist', op: 'put', items: [{ sym: 'ARSSBL', fin: T3 }] });
  const s = e.post({ token: FEED, action: 'site', part: 'fin', sym: 'ARSSBL' }).fin;
  assert.deepStrictEqual([s.y[0][13], s.y[1][13]], ['r', ''], 'r kept, an unknown flag dropped');
  assert.deepStrictEqual(api.cleanFin(s).y.map((r) => r[13]), ['r', '']);
  const v = FIN.view(s, 'y');
  assert.deepStrictEqual(v.flags, ['r', '']);
  assert.deepStrictEqual(FIN.csv(v, 'ARSSBL').filter((r) => r[0] === 'From')[0], ['From', 'screener.in (no NSE filing figures)', 'its own filing']);
});

test('the laptop, the sheet, the api and the page agree on the 12 figures in one order', () => {
  const py = fs.readFileSync(path.join(__dirname, '..', 'pcbridge', 'ScreenerBridge', 'xbrl_history.py'), 'utf8');
  const m = /^COLS = \(([^)]*)\)/m.exec(py);
  const pyCols = m[1].split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean);
  const gs = JSON.parse(JSON.stringify(env().run('AB_FIN_COLS')));
  const apiSrc = fs.readFileSync(path.join(__dirname, '..', 'api', 'financials.js'), 'utf8');
  const apiCols = JSON.parse(/const COLS = (\[[^\]]*\])/.exec(apiSrc)[1].replace(/'/g, '"'));
  assert.deepStrictEqual(pyCols, gs);
  assert.deepStrictEqual(apiCols, gs);
  assert.deepStrictEqual(FIN.ROWS.map((r) => r.k), gs);
});
