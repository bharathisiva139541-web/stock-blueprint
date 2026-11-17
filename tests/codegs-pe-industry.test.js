'use strict';
// PE Ratio + Industry PE without the owner's hand work (owner, 17-Nov-2026: "PE ratio cell of any stock in our sheet is using
// Google finance formula to fetch ... NSE daily update PE ratio file in their reports page" + "Industry PE fulla enoda manual work
// than ... These all should happen without my intervention"; choices: PE = "Both" (MKT Price / TTM EPS, NSE's PE where there is no
// TTM EPS), Industry PE = the median of the Main stocks of the same Basic Industry): Code2.gs ab_nsePeFromBridge_ /
// ab_ensurePeFormula_ / ab_industryPeAuto_.
const test = require('node:test');
const assert = require('node:assert');
const mock = require('./fixtures/apps-script-mock.js');

const TOKEN = 'bridge-token-0123456789';
const NOW = Date.UTC(2026, 10, 17, 13, 0);
const HEAD = ['Checkbox', 'StockName', 'SYMBOL', 'Basic Industry', 'MKT Price', 'PE Ratio', 'Industry PE', 'PE vs Industry PE', 'TTM EPS',
  'Price Fall Alert Price', 'Breakout Alert Price', 'Triggered Y/N'];
// [symbol, basic industry, price, PE (what the formula would show), TTM EPS]
const STOCKS = [['AAA', 'Pharmaceuticals', 100, 20, 5], ['BBB', 'Pharmaceuticals', 300, 30, 10], ['CCC', 'Pharmaceuticals', 400, 40, 10],
  ['DDD', 'Pharmaceuticals', 50, '', -2], ['EEE', 'Cement', 90, 18, 5], ['FFF', 'Cement', 100, 25, 4],
  ['GGG', 'Drones', 500, 100, 5], ['HHH', 'Drones', 300, 60, 5], ['III', 'Drones', 120, 80, 1.5], ['JJJ', 'Drones', 100, 70, ''],
  ['KKK', 'Specialty Chemicals', 100, 40, 2.5], ['LLL', 'Specialty Chemicals', 100, 50, 2], ['MMM', 'Specialty Chemicals', 100, 30, 3.33]];
const IP_ROWS = [['Basic Industry PE'], ['Basic Industry Type', 'Industry PE', 'Stock', 'Updated PE'],
  ['Pharmaceuticals', 34, 'SUNPHARMA', ''], ['Cement', 29.3, 'ULTRACEMCO', ''], ['Drones', 55, 'IDEAFORGE', ''], ['Shipping', 12, 'SCI', '']];

function env(extra) {
  return mock.loadCodeGs({ sheets: [
    { name: 'Main', rows: [['Main watchlist'], HEAD].concat(STOCKS.map(([s, b, p, pe, eps]) => [false, s + ' Ltd', s, b, p, pe, '', '', eps])) },
    { name: 'PatternData', rows: [['Date', 'x', 'y', 'Symbol']].concat(STOCKS.map(([s]) => ['', '', '', s])) },
    { name: 'AutoFetch Log', rows: [['ts']] },
    { name: 'BasicIndustry PE', rows: IP_ROWS.map((r) => r.slice()) }
  ].concat(extra || []) }, { props: { AB_BRIDGE_TOKEN: TOKEN }, now: NOW });
}

test('Main\'s PE Ratio: one formula per stock row - MKT Price / TTM EPS, blank for a loss, NSE\'s PE without a TTM EPS; put back when changed', () => {
  const e = env();
  const r = e.call('ab_ensurePeFormula_');
  assert.deepStrictEqual([r.rows, r.checked], [13, 13]);
  const f = e.sheet('Main').formulas;
  // columns (1-based): SYMBOL 3, MKT Price 5, PE Ratio 6, TTM EPS 9
  const want = '=IFERROR(IF(N(RC9)>0,ROUND(RC5/RC9,2),IF(LEN(RC9),"",IFERROR(VLOOKUP(RC3,\'NSE_PE\'!C1:C2,2,FALSE),""))),' +
    'IFERROR(VLOOKUP(RC3,\'NSE_PE\'!C1:C2,2,FALSE),""))';
  for (let r = 2; r < 15; r++) assert.strictEqual(f[r + ',5'], want, 'row ' + r);
  assert.strictEqual(f['15,5'], undefined, 'nothing under the last stock');
  assert.ok(e.sheet('NSE_PE'), 'the tab the formula reads exists');
  assert.strictEqual(e.sheet('NSE_PE').hidden, true);
  // nothing to do the next time; a row whose formula differs (a GOOGLEFINANCE one) is put back
  assert.strictEqual(e.call('ab_ensurePeFormula_').rows, 0);
  f['7,5'] = '=IFERROR(GOOGLEFINANCE(H9,"pe"),"")';
  assert.strictEqual(e.call('ab_ensurePeFormula_').rows, 1);
  assert.strictEqual(f['7,5'], want);
});

test('NSE\'s PE file from the PC: Main\'s stocks kept in NSE_PE, an older day ignored, the Industry PE worked out at once', () => {
  const e = env();
  const rows = { AAA: [21.5, 20.9], JJJ: [65.25, null], ZZZ: [10, 10], DDD: [null, null] };
  const r = e.post({ token: TOKEN, action: 'nsepe', day: '2026-11-17', rows });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual([r.matched, r.sent], [3, 4]);
  const t = e.sheet('NSE_PE').rows.slice(2).filter((x) => x[0]).map((x) => x.slice(0, 4));
  assert.deepStrictEqual(t, [['AAA', 21.5, 20.9, '2026-11-17'], ['DDD', '', '', '2026-11-17'], ['JJJ', 65.25, '', '2026-11-17']]);
  assert.strictEqual(r.formula.rows, 13);
  assert.ok(r.industryPe && r.industryPe.industries >= 3, JSON.stringify(r.industryPe));
  // an older file never replaces a newer one
  const old = e.post({ token: TOKEN, action: 'nsepe', day: '2026-11-14', rows: { AAA: [1, 1] } });
  assert.strictEqual(old.older, true);
  assert.strictEqual(e.sheet('NSE_PE').rows[2][1], 21.5);
  assert.strictEqual(e.post({ token: TOKEN, action: 'nsepe', day: 'x', rows }).ok, false);
});

test('Industry PE = the median PE of Main\'s stocks per Basic Industry; fewer than 3 stocks keep the typed value; new industries added', () => {
  const e = env();
  const r = e.call('ab_industryPeAuto_');
  assert.deepStrictEqual([r.updated, r.added, r.kept], [2, 1, 1], JSON.stringify(r));
  const ip = e.sheet('BasicIndustry PE').rows;
  assert.deepStrictEqual(ip[1].slice(0, 6), ['Basic Industry Type', 'Industry PE', 'Stock', 'Updated PE', 'Stocks in median', 'Median worked out']);
  const by = Object.fromEntries(ip.slice(2).filter((x) => x[0]).map((x) => [x[0], x]));
  assert.strictEqual(by.Pharmaceuticals[1], 30, 'median of 20 / 30 / 40 (the loss-maker left out)');
  assert.strictEqual(by.Pharmaceuticals[4], 3);
  assert.strictEqual(by.Drones[1], 75, 'median of 100 / 60 / 80 / 70');
  assert.strictEqual(by.Cement[1], 29.3, 'only 2 stocks: the typed value stays');
  assert.match(String(by.Cement[4]), /fewer than 3 \(2\) - your value kept/);
  assert.strictEqual(by.Shipping[1], 12, 'not in Main: untouched');
  assert.strictEqual(by.Shipping[4], '');
  assert.strictEqual(by['Specialty Chemicals'][1], 40, 'Main has it, the tab did not: added');
  assert.strictEqual(by['Specialty Chemicals'][4], 3);
  assert.match(String(by.Pharmaceuticals[5]), /^\d{2}-[A-Z][a-z]{2}-2026 \d{2}:\d{2}$/);
  // the typed "Updated PE" column and the stock column are left as they were
  assert.deepStrictEqual([by.Drones[2], by.Drones[3]], ['IDEAFORGE', '']);
  // a second run: same numbers, no row added twice
  e.call('ab_industryPeAuto_');
  assert.strictEqual(e.sheet('BasicIndustry PE').rows.filter((x) => x[0] === 'Specialty Chemicals').length, 1);
  assert.ok(JSON.parse(e.props.getProperty('AB_IPE_AUTO')).industries === 3);
});

test('the evening run (Phase 4) and the menu item do both; the web app knows action nsepe', () => {
  const e = env();
  const note = e.call('ab_peEveningRefresh_');
  assert.match(note, /PE Ratio formula: 13 row\(s\) set\. Industry PE: 3 industries \(median of Main's stocks\)\./);
  assert.match(e.call('ab_peEveningRefresh_'), /PE Ratio formula: in place\./);
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'Code.gs'), 'utf8');
  assert.match(src, /ab_peEveningRefresh_\(\)/, 'Phase 4 calls it');
  assert.match(src, /'runIndustryPeAutoNow'/, 'menu item');
});
