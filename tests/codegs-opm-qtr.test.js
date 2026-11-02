'use strict';
// OPM, 03-Nov-2026 (owner): OPM QoQ% of an NSE XBRL quarter from the SAME file's quarter before; a new Main column
// 'OPM Qtr YoY' = this quarter's OPM vs the same quarter a year ago (the OPM QoQ% words), added by the code at the end of
// Main; OPM YoY% stays the yearly FY vs FY one.
const test = require('node:test');
const assert = require('node:assert');
const mock = require('./fixtures/apps-script-mock.js');

const TOKEN = 'bridge-token-0123456789';
const NOW = Date.UTC(2026, 10, 3, 13, 30);              // Tue 03-Nov-2026 19:00 IST
const RD = new Date(Date.UTC(2026, 10, 2, 6, 30));
const HEAD = ['Checkbox', 'StockName', 'SYMBOL', 'Result Date', '% Change', 'QoQ Revenue Growth %', 'QoQ NP Growth %',
  'YoY Revenue Growth %', 'YoY NP Growth %', 'TTM EPS', 'Last FY EPS', 'Promotor Holding', 'FII Activity', 'OPM YoY%', 'OPM QoQ%',
  'Price Fall Alert Price', 'Breakout Alert Price', 'Triggered Y/N'];
const C = {};
HEAD.forEach((h, i) => { C[h] = i; });
const OLD = [5, 6, 7, 8, 40, 30, 'Stable', 'Increasing', 'Increasing', 'Decreasing'];
const Q9 = ['Sep 2024', 'Dec 2024', 'Mar 2025', 'Jun 2025', 'Sep 2025', 'Dec 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026'];

function page(quarters, opm, extra) {
  const tr = (label, a) => '<tr><td class="text">' + label + '<button>+</button></td>' + a.map((v) => '<td>' + v + '</td>').join('') + '</tr>';
  const head = (qs) => '<thead><tr><th></th>' + qs.map((q) => '<th>' + q + '</th>').join('') + '</tr></thead>';
  const n = quarters.length;
  return '<section id="quarters"><p>Consolidated Figures in Rs. Crores</p><table class="data-table">' + head(quarters) + '<tbody>' +
    tr('Sales', (extra && extra.sales) || quarters.map((q, i) => 100 + i * 5)) + tr('OPM %', opm.map((v) => v + '%')) +
    tr('Net Profit', quarters.map((q, i) => 10 + i)) + tr('EPS in Rs', quarters.map(() => 1)) + '</tbody></table></section>' +
    '<section id="profit-loss"><table>' + head(['Mar 2025', 'Mar 2026', 'TTM']) + '<tbody>' + tr('OPM %', ['20%', '22%', '23%']) + '</tbody></table></section>' +
    '<section id="shareholding"><div id="quarterly-shareholding"><table>' + head(['Dec 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026']) + '<tbody>' +
    tr('Promoters', ['60%', '60%', '60%', '60%']) + tr('FIIs', ['5%', '5%', '5%', '5%']) + '</tbody></table></div><div id="yearly-shareholding"></div></section>' +
    (n ? '' : '');
}
function env(syms, head) {
  const h = head || HEAD;
  return mock.loadCodeGs({ sheets: [
    { name: 'Main', rows: [['Main watchlist'], h].concat(syms.map((s) => [false, s + ' Ltd', s, RD, 1.2].concat(OLD).slice(0, h.length))) },
    { name: 'AutoFetch Log', rows: [['ts']] },
    { name: 'Results_Announcements', rows: [['Symbol', 'Filed (IST)', 'Session', 'Subject', 'Received']].concat(syms.map((s) => [s, '2026-11-02 16:00:00', 'After market', 'Financial Results', ''])) }
  ] }, { props: { AB_BRIDGE_TOKEN: TOKEN, AB_RS_SEASON: 'Sep 2026' }, now: NOW });
}
const main = (e) => e.sheet('Main').rows;
const qyCol = (e) => main(e)[1].indexOf('OPM Qtr YoY');
const row = (e, sym) => main(e).find((x) => x[C.SYMBOL] === sym);

test('OPM Qtr YoY by quarter name: the same quarter a year before, the OPM QoQ% words', () => {
  const e = env(['A']);
  const q = (quarters, opm) => e.call('ab_qtOpmQtrYoy_', quarters, opm);
  assert.strictEqual(q(['Sep 2025', 'Dec 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026'], [20, 21, 22, 23, 26]), 'Aggressive Increase', '26 vs 20');
  assert.strictEqual(q(['Sep 2025', 'Jun 2026', 'Sep 2026'], [30, 25, 29.7]), 'Stagnant', 'a gap in the table does not matter: matched by name');
  assert.strictEqual(q(['Sep 2025', 'Sep 2026'], [30, 28.5]), 'Slightly Decreasing');
  assert.strictEqual(q(['Dec 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026'], [20, 21, 22, 23]), '', 'no Sep 2025 column');
  assert.strictEqual(q(['Sep 2025', 'Dec 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026', 'Dec 2026'], [20, 21, 22, 23, 26, NaN]), 'Aggressive Increase', 'an empty newest column is skipped');
  assert.strictEqual(q(['Sep 2025', 'Sep 2026'], [30]), '', 'columns not lined up: nothing');
});

test('screener.in figures: the column is added at the end of Main (once) and filled; OPM QoQ% / OPM YoY% as before', () => {
  const e = env(['SCR', 'NOOPM']);
  e.post({ token: TOKEN, action: 'put', items: [
    { sym: 'SCR', html: page(Q9, [20, 20, 21, 21, 22, 22, 23, 24, 25.5]) },               // Sep 2026 25.5 vs Sep 2025 22 -> +3.5
    { sym: 'NOOPM', html: page(Q9.slice(5), [22, 23, 24, 25]) }] });                       // no Sep 2025 in the table
  e.post({ token: TOKEN, action: 'process' });
  const c = qyCol(e);
  assert.strictEqual(c, HEAD.length, 'after the last column - nothing else moved');
  assert.deepStrictEqual(main(e)[1].slice(0, HEAD.length), HEAD);
  assert.strictEqual(row(e, 'SCR')[c], 'Increasing');
  assert.strictEqual(row(e, 'SCR')[C['OPM QoQ%']], 'Slightly Increasing', '25.5 vs 24 (Jun 2026)');
  assert.strictEqual(row(e, 'SCR')[C['OPM YoY%']], 'Increasing', 'yearly FY vs FY (Mar 2026 22% vs Mar 2025 20%, the TTM column left out) - unchanged rule');
  assert.ok(!row(e, 'NOOPM')[c], 'no same quarter a year before: blank');
  e.setNow(NOW + 3600e3);
  e.post({ token: TOKEN, action: 'process' });
  assert.strictEqual(main(e)[1].filter((h) => h === 'OPM Qtr YoY').length, 1, 'added once');
});

test('NSE XBRL: OPM QoQ% and OPM Qtr YoY from the same file\'s quarters; else from screener.in\'s stored OPM', () => {
  const e = env(['XF', 'XS']);
  const prev = page(Q9.slice(0, 8), [20, 20, 21, 21, 22, 22, 23, 24]);                    // stored page ends Jun 2026 (24%)
  e.post({ token: TOKEN, action: 'put', items: [{ sym: 'XF', html: prev }, { sym: 'XS', html: prev }] });
  const fig = (rev, exp) => ({ revenue: rev, other_income: 1, expenses: exp, finance_costs: 0, depreciation: 0, exceptional: null, pbeit: rev - exp, pbt: rev - exp, tax: 1, pat: 5, eps: 1 });
  e.post({ token: TOKEN, action: 'xbrlput', items: [
    // in the file: Sep 2026 30% / Jun 2026 29.6% / Sep 2025 25%  ->  Stagnant (the file) and Aggressive Increase
    { sym: 'XF', quarter: 'Sep 2026', cons: Object.assign(fig(200, 140), { prev: Object.assign(fig(125, 88), { quarter: 'Jun 2026' }), ago: Object.assign(fig(160, 120), { quarter: 'Sep 2025' }) }) },
    // no comparison columns: Sep 2026 30% vs screener.in's Jun 2026 24% / Sep 2025 22%
    { sym: 'XS', quarter: 'Sep 2026', cons: fig(200, 140) }] });
  e.post({ token: TOKEN, action: 'process' });
  const c = qyCol(e);
  assert.deepStrictEqual([row(e, 'XF')[C['OPM QoQ%']], row(e, 'XF')[c]], ['Stagnant', 'Aggressive Increase']);
  assert.deepStrictEqual([row(e, 'XS')[C['OPM QoQ%']], row(e, 'XS')[c]], ['Aggressive Increase', 'Aggressive Increase']);
  assert.strictEqual(row(e, 'XF')[C['OPM YoY%']], OLD[8], 'OPM YoY% untouched by XBRL (the yearly one)');
  // a comparison quarter that is not 3 / 12 months back is not kept
  const stored = JSON.parse(e.sheet('XBRL_Bridge').rows.find((r) => r[0] === 'XF')[4]);
  assert.deepStrictEqual([stored.cons.prev.quarter, stored.cons.ago.quarter], ['Jun 2026', 'Sep 2025']);
  e.post({ token: TOKEN, action: 'xbrlput', items: [{ sym: 'XF', quarter: 'Sep 2026', cons: Object.assign(fig(200, 140), { prev: Object.assign(fig(1, 1), { quarter: 'Mar 2026' }) }) }] });
  assert.strictEqual(JSON.parse(e.sheet('XBRL_Bridge').rows.find((r) => r[0] === 'XF')[4]).cons.prev, undefined);
});

test('blank cells of other Main stocks filled from their stored screener.in pages (one write of the column)', () => {
  const e = env(['OLDCO', 'KEPT']);
  // results long past (no tracker work): the stored page alone fills the new column
  e.sheet('Main').rows.forEach((r) => { if (r[C.SYMBOL] === 'OLDCO' || r[C.SYMBOL] === 'KEPT') r[C['Result Date']] = new Date(Date.UTC(2026, 7, 10, 6, 30)); });
  e.post({ token: TOKEN, action: 'put', items: [{ sym: 'OLDCO', html: page(Q9.slice(0, 8), [20, 20, 21, 21, 22, 22, 23, 21]) },
    { sym: 'KEPT', html: page(Q9.slice(0, 8), [20, 20, 21, 21, 22, 22, 23, 21]) }] });
  e.call('ab_ensureOpmQtrYoyCol_');
  const c = qyCol(e);
  row(e, 'KEPT')[c] = 'Increasing';                                            // a value already there is kept
  const r = e.call('ab_rsRun_', 'Manual run', false);
  assert.ok(r, 'ran');
  assert.strictEqual(row(e, 'OLDCO')[c], 'Stagnant', 'Jun 2026 21% vs Jun 2025 21%');
  assert.strictEqual(row(e, 'KEPT')[c], 'Increasing');
  // no OPM QoQ% column in the sheet: nothing added
  const e2 = env(['A'], HEAD.filter((h) => h !== 'OPM QoQ%'));
  assert.strictEqual(e2.call('ab_ensureOpmQtrYoyCol_'), false);
  assert.ok(e2.sheet('Main').rows[1].indexOf('OPM Qtr YoY') < 0);
});
