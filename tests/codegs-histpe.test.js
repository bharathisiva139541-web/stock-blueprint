'use strict';
// Historical PE (owner, 17-Nov-2026: "Oru stock oda Peak PE ratio, 5 year median, 3 year median, 1 year median" ... "intha PE
// Ratio va nan first athoda Historical PE Ratio, then industry median PE kooda compare panrathuku useful"): the laptop works the
// figures out (pcbridge/ScreenerBridge/pe_history.py) and posts doPost action 'histpe' -> Code2.gs ab_histPeFromBridge_:
// op 'seed' = the stored screener.in quarterly figures, op 'put' = tab PE_History + Main's columns Median PE 1Y / 3Y / 5Y,
// Peak PE 5Y (values) + PE vs Own Median / PE Check (formulas, same words as web/lib/pe.js).
const test = require('node:test');
const assert = require('node:assert');
const mock = require('./fixtures/apps-script-mock.js');
const PE = require('../web/lib/pe.js');

const TOKEN = 'bridge-token-0123456789';
const NOW = Date.UTC(2026, 10, 17, 13, 0);
const HEAD = ['Checkbox', 'StockName', 'SYMBOL', 'Basic Industry', 'MKT Price', 'PE Ratio', 'Industry PE', 'PE vs Industry PE', 'TTM EPS',
  'Price Fall Alert Price', 'Breakout Alert Price', 'Triggered Y/N'];
const STOCKS = [['AAA', 100, 20, 5], ['BBB', 300, 30, 10], ['CCC', 400, 40, 10], ['DDD', 50, '', -2]];
const SERIES = (q) => ({ quarterOk: true, series: { basis: 'Consolidated', quarters: q, revenue: q.map(() => 10), netProfit: q.map(() => 5),
  eps: q.map((_, i) => 1 + i / 10), opm: [] } });

function env() {
  return mock.loadCodeGs({ sheets: [
    { name: 'Main', rows: [['Main watchlist'], HEAD].concat(STOCKS.map(([s, p, pe, eps]) => [false, s + ' Ltd', s, 'Pharma', p, pe, 25, pe ? pe / 25 : '', eps]))
      .concat([[false, '', '', '', '', '', '', '', '']]) },
    { name: 'PatternData', rows: [['Date', 'x', 'y', 'Symbol']].concat(STOCKS.map(([s]) => ['', '', '', s])) },
    { name: 'AutoFetch Log', rows: [['ts']] },
    { name: 'Screener_Bridge', rows: [['Symbol', 'Fetched (ms)', 'Fetched at (IST)', 'Data (JSON)'],
      ['AAA', NOW - 86400000, 'x', JSON.stringify(SERIES(['Dec 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026']))],
      ['BBB', NOW, 'x', JSON.stringify({ quarterOk: false })],
      ['CCC', NOW, 'x', JSON.stringify(Object.assign(SERIES(['Sep 2026']), { series: Object.assign(SERIES(['Sep 2026']).series, { basis: 'Standalone' }) }))]] }
  ] }, { props: { AB_BRIDGE_TOKEN: TOKEN }, now: NOW });
}

test('op seed: the stored screener.in quarterly figures of the stocks the laptop asks for', () => {
  const e = env();
  const r = e.post({ token: TOKEN, action: 'histpe', op: 'seed', want: ['AAA', 'bbb', 'CCC', 'ZZZ'] });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(Object.keys(r.series).sort(), ['AAA', 'CCC'], 'no series / not stored: left out');
  assert.deepStrictEqual(r.series.AAA, ['C', ['Dec 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026'], [1, 1.1, 1.2, 1.3], [5, 5, 5, 5], Math.round((NOW - 86400000) / 1000)]);
  assert.strictEqual(r.series.CCC[0], 'S');
  assert.strictEqual(e.post({ token: 'wrong', action: 'histpe', op: 'seed', want: ['AAA'] }).ok, false, 'the bridge token');
  assert.strictEqual(e.post({ token: TOKEN, action: 'histpe', op: 'nope' }).error, 'unknown op');
});

test('op put: PE_History rebuilt, Main gets the four values + the two formulas after its last column, by symbol', () => {
  const e = env();
  const rows = {
    AAA: [18.5, 22.25, 24.004, 61.3, '2024-03-07', 20, 5, 35, 'screener.in page 15-11-2026', 'EPS up to Mar 2024 divided by 2 (split / bonus)'],
    CCC: [41, null, null, null, '', 40, 10, null, 'the sheet (quarterly figures only)', '=HYPERLINK("x") 3Y: EPS history shorter than 3Y'],
    'BAD SYM': [1, 2, 3, 4], ZZZ: [9, 9, 9, 9, '', 9, 1, 100, '', '']
  };
  const r = e.post({ token: TOKEN, action: 'histpe', op: 'put', upto: '2026-11-14', rows });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.stocks, 3, 'the bad symbol left out');
  assert.strictEqual(r.main, 2, 'AAA + CCC are Main stocks');
  assert.deepStrictEqual(r.added, ['Median PE 1Y', 'Median PE 3Y', 'Median PE 5Y', 'Peak PE 5Y', 'PE vs Own Median', 'PE Check']);
  const t = e.sheet('PE_History');
  assert.strictEqual(t.hidden, true);
  assert.match(String(t.rows[0][0]), /^Historical PE from your laptop .* Prices up to 2026-11-14/);
  assert.deepStrictEqual(t.rows[1], ['Symbol', 'Median PE 1Y', 'Median PE 3Y', 'Median PE 5Y', 'Peak PE 5Y', 'Peak On', 'PE Now (Kite close)',
    'TTM EPS (laptop)', 'Quarterly EPS share 5Y %', 'EPS From', 'Note', 'Prices Up To']);
  assert.deepStrictEqual(t.rows[2], ['AAA', 18.5, 22.25, 24, 61.3, '2024-03-07', 20, 5, 35, 'screener.in page 15-11-2026',
    'EPS up to Mar 2024 divided by 2 (split / bonus)', '2026-11-14']);
  assert.deepStrictEqual(t.rows[3].slice(0, 5), ['CCC', 41, '', '', '']);
  assert.ok(!/^[=+\-@]/.test(t.rows[3][10]), 'a note never becomes a formula: ' + t.rows[3][10]);
  const m = e.sheet('Main').rows;
  assert.deepStrictEqual(m[1].slice(12), ['Median PE 1Y', 'Median PE 3Y', 'Median PE 5Y', 'Peak PE 5Y', 'PE vs Own Median', 'PE Check']);
  assert.deepStrictEqual(m[2].slice(12, 16), [18.5, 22.25, 24, 61.3], 'AAA');
  assert.deepStrictEqual(m[3].slice(12, 16), ['', '', '', ''], 'BBB: not sent -> blank');
  assert.deepStrictEqual(m[4].slice(12, 16), [41, '', '', ''], 'CCC');
  // the two formulas on every stock row (1-based columns: PE 6, Industry PE 7, PE vs Industry PE 8, the new ones 13-18)
  const f = e.sheet('Main').formulas;
  const want = e.call('ab_hpeFormulasR1C1_', 6, 13, 14, 15, 17, 8, 7);
  assert.strictEqual(want.own, '=IFERROR(IF(N(RC6)>0,ROUND(RC6/IF(N(RC15)>0,RC15,IF(N(RC14)>0,RC14,RC13)),2),""),"")');
  for (let r0 = 2; r0 < 6; r0++) {
    assert.strictEqual(f[r0 + ',16'], want.own, 'row ' + r0);
    assert.strictEqual(f[r0 + ',17'], want.check, 'row ' + r0);
  }
  assert.strictEqual(f['6,16'], undefined, 'not under the last stock');
  // every word of the website's PE check (web/lib/pe.js) is the sheet's too
  PE.WORDS.forEach((w) => assert.ok(want.check.indexOf('"' + w + '"') !== -1, w));
  assert.ok(want.check.indexOf('IF(AND(RC17<1,IFERROR(N(RC8),0)<1),"Below own + industry median"') !== -1, want.check);
  // a second post with fewer stocks clears the others; nothing to change in the formulas
  const r2 = e.post({ token: TOKEN, action: 'histpe', op: 'put', upto: '2026-11-17', rows: { CCC: [42, 43, 44, 50, '', 40, 10, 60, '', ''] } });
  assert.deepStrictEqual([r2.main, r2.added, r2.formulas.rows], [1, [], 0]);
  assert.deepStrictEqual(e.sheet('Main').rows[2].slice(12, 16), ['', '', '', '']);
  assert.deepStrictEqual(e.sheet('Main').rows[4].slice(12, 16), [42, 43, 44, 50]);
  assert.strictEqual(e.sheet('PE_History').rows.filter((x) => x[0] === 'AAA').length, 0, 'rebuilt');
  assert.strictEqual(JSON.parse(e.props.getProperty('AB_HPE_AT')).upto, '2026-11-17');
  assert.strictEqual(e.post({ token: TOKEN, action: 'histpe', op: 'put' }).ok, false, 'no rows');
});

test('Phase 4 puts the two formulas back; without the columns nothing happens', () => {
  const e = env();
  assert.match(e.call('ab_hpeEnsureFormulas_').skipped, /no historical PE columns/);
  e.post({ token: TOKEN, action: 'histpe', op: 'put', upto: '2026-11-14', rows: { AAA: [1, 2, 3, 4, '', 1, 1, 1, '', ''] } });
  const f = e.sheet('Main').formulas;
  f['3,16'] = '=1';
  delete f['4,17'];
  assert.match(e.call('ab_peEveningRefresh_'), /Historical PE formulas: 2 cell\(s\) set\./);
  assert.strictEqual(e.call('ab_hpeEnsureFormulas_').rows, 0);
});

test('web/lib/pe.js: own median 5Y -> 3Y -> 1Y, PE / that median, the check words (own median first, then the industry)', () => {
  assert.deepStrictEqual(PE.ownMedian({ pem1: 10, pem3: 12, pem5: 15 }), { value: 15, years: 5 });
  assert.deepStrictEqual(PE.ownMedian({ pem1: 10, pem3: 12, pem5: null }), { value: 12, years: 3 });
  assert.deepStrictEqual(PE.ownMedian({ pem1: 10 }), { value: 10, years: 1 });
  assert.strictEqual(PE.ownMedian({}), null);
  assert.strictEqual(PE.own({ pe: 12, pem5: 15 }), 0.8);
  assert.strictEqual(PE.own({ pe: '', pem5: 15 }), null);
  assert.strictEqual(PE.check(0.8, 0.9), 'Below own + industry median');
  assert.strictEqual(PE.check(0.8, 1.2), 'Below own median');
  assert.strictEqual(PE.check(1.1, 0.9), 'Below industry median');
  assert.strictEqual(PE.check(1.1, 1.2), 'Above both');
  assert.strictEqual(PE.check(1.1, null), 'Above own median');
  assert.strictEqual(PE.check(0.7, ''), 'Below own median');
  assert.strictEqual(PE.check(null, 0.5), 'No own history - below industry');
  assert.strictEqual(PE.check(null, 1.5), 'No own history - above industry');
  assert.strictEqual(PE.check(null, null), '');
  const s = PE.apply({ pe: 30, pevs: 0.9, pem1: 40, pem3: 35, pem5: '' });
  assert.deepStrictEqual([s.peOwn, s.peOwnYears, s.peCheck], [0.86, 3, 'Below own + industry median']);
  assert.strictEqual(PE.apply({ pe: null, pevs: 0.9, pem5: 20 }).peCheck, null, 'a loss: no PE, no check');
});

test('site feed: Main\'s Median PE 1Y / 3Y / 5Y + Peak PE 5Y travel as pem1 / pem3 / pem5 / pepk (= tools/export_xlsx.py)', () => {
  const e = mock.loadCodeGs({ sheets: [] }, { props: {} });
  const cols = JSON.parse(JSON.stringify(e.run('AB_SITE_MAIN_COLS')));
  assert.deepStrictEqual(cols.slice(-4), [['pem1', 'Median PE 1Y', 'num'], ['pem3', 'Median PE 3Y', 'num'], ['pem5', 'Median PE 5Y', 'num'],
    ['pepk', 'Peak PE 5Y', 'num']]);
  const py = require('fs').readFileSync(require('path').join(__dirname, '..', 'tools', 'export_xlsx.py'), 'utf8');
  ['pem1', 'pem3', 'pem5', 'pepk'].forEach((k, i) => assert.ok(py.indexOf("('" + k + "', '" + cols[cols.length - 4 + i][1] + "', 'num')") !== -1, k));
  assert.ok(e.run('AB_SITE_FEED_FORMAT') >= 17);
});
