'use strict';
// Quarters matched by name (owner, 02-Nov-2026: the 20:56 Results Update email showed ESDS with YoY revenue +10% / profit
// +19%; screener.in's consolidated table has no Dec 2025 column, so "4 columns back" was Jun 2025 (138/125, 31/26)
// instead of Sep 2025 (138/94 = +47%, 31/22 = +41%), and TTM EPS added Sep 2025 in place of the missing Dec 2025).
const test = require('node:test');
const assert = require('node:assert');
const mock = require('./fixtures/apps-script-mock.js');

const TOKEN = 'bridge-token-0123456789';
const NOW = Date.UTC(2026, 10, 2, 15, 30);              // Mon 02-Nov-2026 21:00 IST
const RD = new Date(Date.UTC(2026, 10, 2, 6, 30));      // result date 02-Nov-2026
const HEAD = ['Checkbox', 'StockName', 'SYMBOL', 'Result Date', '% Change', 'QoQ Revenue Growth %', 'QoQ NP Growth %',
  'YoY Revenue Growth %', 'YoY NP Growth %', 'TTM EPS', 'Last FY EPS', 'Promotor Holding', 'FII Activity', 'OPM YoY%', 'OPM QoQ%',
  'Price Fall Alert Price', 'Breakout Alert Price', 'Triggered Y/N'];
const C = {};
HEAD.forEach((h, i) => { C[h] = i; });
const OLD = [5, 6, 7, 8, 40, 30, 'Stable', 'Increasing', 'Increasing', 'Decreasing'];   // last season's figures and tags

// ESDS consolidated, from the owner's screenshot of screener.in (02-Nov-2026 21:18) - no Dec 2025 column
const ESDS_Q = ['Jun 2025', 'Sep 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026'];
const ESDS = { Sales: [125, 94, 168, 134, 138], 'OPM %': ['42%', '52%', '61%', '42%', '42%'], 'Net Profit': [26, 22, 68, 29, 31],
  'EPS in Rs': [2.56, 2.17, 6.71, 2.92, 2.65] };

function page(quarters, rows) {
  const tr = (label, a) => '<tr><td class="text">' + label + '<button>+</button></td>' + a.map((v) => '<td>' + v + '</td>').join('') + '</tr>';
  const head = (qs) => '<thead><tr><th></th>' + qs.map((q) => '<th>' + q + '</th>').join('') + '</tr></thead>';
  return '<section id="quarters"><p>Consolidated Figures in Rs. Crores</p><table class="data-table">' + head(quarters) +
    '<tbody>' + Object.keys(rows).map((k) => tr(k, rows[k])).join('') + '</tbody></table></section>' +
    '<section id="profit-loss"><table>' + head(['Mar 2025', 'Mar 2026', 'TTM']) + '<tbody>' + tr('OPM %', ['40%', '52%', '50%']) +
    '</tbody></table></section>' +
    '<section id="shareholding"><div id="quarterly-shareholding"><table>' + head(['Dec 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026']) + '<tbody>' +
    tr('Promoters', ['70%', '70%', '70%', '70%']) + tr('FIIs', ['5%', '5%', '5%', '5%']) + '</tbody></table></div><div id="yearly-shareholding"></div></section>';
}
function env(syms) {
  return mock.loadCodeGs({ sheets: [
    { name: 'Main', rows: [['Main watchlist'], HEAD].concat((syms || ['ESDS']).map((s) => [false, s + ' Ltd', s, RD, -2.59].concat(OLD))) },
    { name: 'AutoFetch Log', rows: [['ts']] }
  ] }, { props: { AB_BRIDGE_TOKEN: TOKEN, AB_RS_SEASON: 'Sep 2026' }, now: NOW });
}
const J = (x) => JSON.parse(JSON.stringify(x));
const row = (e, sym) => e.sheet('Main').rows.find((x) => x[C.SYMBOL] === sym);
const figures = (e, sym) => row(e, sym).slice(C['QoQ Revenue Growth %'], C['Last FY EPS'] + 1);
function tracker(e) {
  const rows = e.sheet('Results Tracker').rows;
  const out = {};
  rows.slice(1).forEach((r) => { const o = {}; rows[0].forEach((k, i) => { o[k] = r[i]; }); out[r[0]] = o; });
  return out;
}
const parsed = (quarters, rows) => ({ ok: true, basis: 'Consolidated', quarters: quarters, revenue: rows.Sales, netProfit: rows['Net Profit'],
  eps: rows['EPS in Rs'] || [], error: '' });

test('growth by quarter name: ESDS (no Dec 2025 column) - YoY against Sep 2025, TTM EPS unknown', () => {
  const e = env();
  const g = J(e.call('ab_computeQuarterGrowth_', parsed(ESDS_Q, ESDS)));
  assert.deepStrictEqual([g.latestQuarter, g.qoqRev, g.qoqNp, g.yoyRev, g.yoyNp, g.ttmEps, g.lastFyEps, g.shortHistory],
    ['Sep 2026', 3, 7, 47, 41, '', '', false]);
  assert.deepStrictEqual(g.clear, ['ttmEps'], 'Dec 2025 missing while older quarters are there: blank the cell');
  // the old column-counting rule gave the email's numbers
  const old = J(e.call('ab_computeQuarterGrowth_', parsed(ESDS_Q, ESDS), true));
  assert.deepStrictEqual([old.yoyRev, old.yoyNp, old.ttmEps, old.clear], [10, 19, 14.45, []]);
});

test('growth by quarter name: a full table is unchanged; the quarter before missing; short history; odd labels', () => {
  const e = env();
  const Q8 = ['Sep 2024', 'Dec 2024', 'Mar 2025', 'Jun 2025', 'Sep 2025', 'Dec 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026'];
  const full = { Sales: [90, 95, 110, 100, 106, 118, 140, 128, 151], 'Net Profit': [10, 11, 12, 11, 20, 18, 30, 21, 31],
    'EPS in Rs': [1.1, 1.2, 1.5, 1.3, 2.4, 2.26, 4.27, 2.63, 3.76] };
  const a = J(e.call('ab_computeQuarterGrowth_', parsed(Q8, full))), b = J(e.call('ab_computeQuarterGrowth_', parsed(Q8, full), true));
  delete a.clear; delete b.clear;
  assert.deepStrictEqual(a, b, 'consecutive quarters: same as before');
  assert.deepStrictEqual([a.yoyRev, a.ttmEps, a.lastFyEps], [42, 12.92, 6.4]);
  // a not-yet-reported placeholder column on the right is still skipped
  const ph = J(e.call('ab_computeQuarterGrowth_', parsed(Q8.concat(['Dec 2026']), { Sales: full.Sales.concat([NaN]), 'Net Profit': full['Net Profit'].concat([NaN]),
    'EPS in Rs': full['EPS in Rs'].concat([NaN]) })));
  assert.deepStrictEqual([ph.latestQuarter, ph.yoyRev], ['Sep 2026', 42]);
  // Jun 2026 missing: no QoQ (blanked), YoY still right
  const noJun = J(e.call('ab_computeQuarterGrowth_', parsed(['Sep 2025', 'Dec 2025', 'Mar 2026', 'Sep 2026'],
    { Sales: [100, 110, 120, 150], 'Net Profit': [10, 11, 12, 15], 'EPS in Rs': [1, 1, 1, 1] })));
  assert.deepStrictEqual([noJun.qoqRev, noJun.qoqNp, noJun.yoyRev, noJun.yoyNp, noJun.ttmEps], ['', '', 50, 50, '']);
  assert.deepStrictEqual(noJun.clear, ['qoqRev', 'qoqNp', 'ttmEps']);
  // a new company with three quarters: no YoY, nothing to blank
  const young = J(e.call('ab_computeQuarterGrowth_', parsed(['Mar 2026', 'Jun 2026', 'Sep 2026'], { Sales: [10, 11, 12], 'Net Profit': [1, 1, 2] })));
  assert.deepStrictEqual([young.qoqRev, young.yoyRev, young.shortHistory, young.clear], [9, '', true, []]);
  // labels that cannot be read: columns counted as before
  const odd = J(e.call('ab_computeQuarterGrowth_', parsed(['Q1', 'Q2', 'Q3', 'Q4', 'Q5'], { Sales: [100, 1, 1, 1, 150], 'Net Profit': [10, 1, 1, 1, 15] })));
  assert.deepStrictEqual([odd.yoyRev, odd.clear], [50, []]);
});

test('Results Day: ESDS written by quarter name - YoY +47% / +41%, last season\'s TTM EPS blanked, OPM QoQ against Jun 2026', () => {
  const e = env();
  e.post({ token: TOKEN, action: 'put', items: [{ sym: 'ESDS', html: page(ESDS_Q, ESDS) }] });
  e.post({ token: TOKEN, action: 'process' });
  assert.deepStrictEqual(figures(e, 'ESDS'), [3, 7, 47, 41, '', 30], 'TTM EPS blank (Dec 2025 unknown); Last FY EPS not worked out - left');
  assert.strictEqual(row(e, 'ESDS')[C['OPM QoQ%']], 'Stagnant', '42% (Jun 2026) -> 42%');
  assert.deepStrictEqual([tracker(e).ESDS.Status, tracker(e).ESDS.Source], ['Updated', 'screener.in']);
  // the page's own stored growth is by name too
  const b = e.sheet('Screener_Bridge').rows.find((r) => r[0] === 'ESDS');
  assert.strictEqual(JSON.parse(b[3]).growth.yoyRev, 47);
});

test('rows written the old way are corrected once (stored page + Main), a full table left alone', () => {
  const e = env(['ESDS', 'FULLCO']);
  const Q8 = ['Dec 2024', 'Mar 2025', 'Jun 2025', 'Sep 2025', 'Dec 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026'];
  e.post({ token: TOKEN, action: 'put', items: [{ sym: 'ESDS', html: page(ESDS_Q, ESDS) },
    { sym: 'FULLCO', html: page(Q8, { Sales: [1, 1, 1, 100, 1, 1, 1, 120], 'OPM %': Q8.map(() => '10%'), 'Net Profit': [1, 1, 1, 10, 1, 1, 1, 12],
      'EPS in Rs': Q8.map(() => 1) }) }] });
  e.post({ token: TOKEN, action: 'process' });
  const fullBefore = figures(e, 'FULLCO');
  // what the old code had written for ESDS (the email's numbers), and a stored page whose growth was counted by columns
  const r = row(e, 'ESDS');
  [3, 7, 10, 19, 14.45].forEach((v, i) => { r[C['QoQ Revenue Growth %'] + i] = v; });
  const sh = e.sheet('Screener_Bridge');
  const br = sh.rows.find((x) => x[0] === 'ESDS');
  const c = JSON.parse(br[3]);
  c.growth.yoyRev = 10; c.growth.yoyNp = 19; c.growth.ttmEps = 14.45;
  br[3] = JSON.stringify(c);
  e.setNow(NOW + 30 * 60e3);
  const p = e.post({ token: TOKEN, action: 'process' });
  assert.match(p.result.results, /Figures corrected \(a quarter missing from screener\.in's table\): ESDS\./);
  assert.deepStrictEqual(figures(e, 'ESDS'), [3, 7, 47, 41, '', 30]);
  const t = tracker(e).ESDS;
  assert.match(t.Note, /figures corrected on 02\/11\/2026 21:30 \(screener\.in's table skips a quarter - quarters now matched by name\)$/);
  assert.deepStrictEqual(figures(e, 'FULLCO'), fullBefore, 'a full table is left alone');
  // nothing to do any more
  e.setNow(NOW + 60 * 60e3);
  const p2 = e.post({ token: TOKEN, action: 'process' });
  assert.ok(!/Figures corrected/.test(p2.result.results), p2.result.results);
  assert.strictEqual((tracker(e).ESDS.Note.match(/figures corrected/g) || []).length, 1);
});

test('NSE XBRL rows: the stored quarters with a gap are matched by name too', () => {
  const e = env();
  e.post({ token: TOKEN, action: 'put', items: [{ sym: 'ESDS', html: page(ESDS_Q.slice(0, 4), {
    Sales: ESDS.Sales.slice(0, 4), 'OPM %': ESDS['OPM %'].slice(0, 4), 'Net Profit': ESDS['Net Profit'].slice(0, 4), 'EPS in Rs': ESDS['EPS in Rs'].slice(0, 4) }) }] });
  e.post({ token: TOKEN, action: 'xbrlput', items: [{ sym: 'ESDS', quarter: 'Sep 2026', cons: { revenue: 138, other_income: 5, expenses: 81,
    finance_costs: 3, depreciation: 20, exceptional: null, pbeit: 40, pbt: 40, tax: 9, pat: 31, eps: 2.65 } }] });
  e.post({ token: TOKEN, action: 'process' });
  assert.deepStrictEqual([tracker(e).ESDS.Source].concat(figures(e, 'ESDS')), ['NSE XBRL', 3, 7, 47, 41, '', 30]);
});

test('the quarter before missing: QoQ and OPM QoQ% blanked in Main (no comparison with an older quarter)', () => {
  const e = env();
  const q = ['Sep 2025', 'Dec 2025', 'Mar 2026', 'Sep 2026'];
  e.post({ token: TOKEN, action: 'put', items: [{ sym: 'ESDS', html: page(q, { Sales: [100, 110, 120, 150], 'OPM %': ['40%', '41%', '30%', '45%'],
    'Net Profit': [10, 11, 12, 15], 'EPS in Rs': [1, 1, 1, 1] }) }] });
  e.post({ token: TOKEN, action: 'process' });
  assert.deepStrictEqual(figures(e, 'ESDS'), ['', '', 50, 50, '', 30]);
  assert.strictEqual(row(e, 'ESDS')[C['OPM QoQ%']], '', 'not 30% (Mar 2026) -> 45%');
});
