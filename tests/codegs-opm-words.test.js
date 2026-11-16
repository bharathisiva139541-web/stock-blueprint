'use strict';
// OPM words of the new quarter (owner, 16-Nov-2026, MARSONS: "Data related to OPM is inconsistent with each one" - the
// Results Performance row showed moneycontrol's Profit QoQ +160% with last quarter's OPM QoQ "Aggressive Decrease",
// Main "Increasing"; Main's OPM Qtr YoY "Slightly Decreasing" (last quarter's word) while screener.in shows 14% -> 19%).
// moneycontrol has no OPM, an NSE XBRL filing may lack the year-ago quarter: such a word is blanked when the figures are
// written, screener.in fills it later, every Results Day run repairs rows written before, the blank-cell fill from stored
// screener.in pages leaves those rows alone, and the Results Performance row follows Main while Main holds that quarter.
const test = require('node:test');
const assert = require('node:assert');
const mock = require('./fixtures/apps-script-mock.js');

const TOKEN = 'bridge-token-0123456789';
const NOW = Date.UTC(2026, 10, 16, 13, 30);             // Mon 16-Nov-2026 19:00 IST
const RD = new Date(Date.UTC(2026, 10, 13, 6, 30));      // results Fri 13-Nov-2026
const HEAD = ['Checkbox', 'StockName', 'SYMBOL', 'Result Date', '% Change', 'QoQ Revenue Growth %', 'QoQ NP Growth %',
  'YoY Revenue Growth %', 'YoY NP Growth %', 'TTM EPS', 'Last FY EPS', 'Promotor Holding', 'FII Activity', 'OPM YoY%', 'OPM QoQ%',
  'Price Fall Alert Price', 'Breakout Alert Price', 'Triggered Y/N'];
const C = {};
HEAD.forEach((h, i) => { C[h] = i; });
// last quarter's figures and words (OPM QoQ% of Jun 2026 = Aggressive Decrease)
const OLD = [-12, -30, 5, 2, 40, 30, 'Stable', 'Increasing', 'Increasing', 'Aggressive Decrease'];
const STALE_QY = 'Slightly Decreasing';                   // Jun 2026 15% vs Jun 2025 16%

function page(quarters, opm, sales, np) {
  const tr = (label, a) => '<tr><td class="text">' + label + '<button>+</button></td>' + a.map((v) => '<td>' + v + '</td>').join('') + '</tr>';
  const head = (qs) => '<thead><tr><th></th>' + qs.map((q) => '<th>' + q + '</th>').join('') + '</tr></thead>';
  return '<section id="quarters"><p>Consolidated Figures in Rs. Crores</p><table class="data-table">' + head(quarters) + '<tbody>' +
    tr('Sales', sales) + tr('OPM %', opm.map((v) => v + '%')) + tr('Net Profit', np) + tr('EPS in Rs', quarters.map(() => 1)) +
    '</tbody></table></section>' +
    '<section id="profit-loss"><table>' + head(['Mar 2025', 'Mar 2026', 'TTM']) + '<tbody>' + tr('OPM %', ['12%', '14%', '16%']) + '</tbody></table></section>' +
    '<section id="shareholding"><div id="quarterly-shareholding"><table>' + head(['Dec 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026']) + '<tbody>' +
    tr('Promoters', ['60%', '60%', '60%', '60%']) + tr('FIIs', ['1%', '1%', '2%', '3%']) + '</tbody></table></div><div id="yearly-shareholding"></div></section>';
}
// screener.in before the results: Sep 2025's OPM not readable (so neither XBRL nor the page can tell OPM Qtr YoY)
const BEFORE = page(['Jun 2025', 'Sep 2025', 'Dec 2025', 'Mar 2026', 'Jun 2026'], [16, '', 17, 18, 15], [55, 60, 58, 70, 49], [7, 9, 8, 10, 6]);
// screener.in with the new quarter: Sep 2025 14% -> Sep 2026 19%, Jun 2026 15%
const AFTER = page(['Jun 2025', 'Sep 2025', 'Dec 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026'], [16, 14, 17, 18, 15, 19],
  [55, 60, 58, 70, 49, 97], [7, 9, 8, 10, 6, 13.4]);
const MC = { sym: 'MARS', basis: 'Standalone', quarters: ['Jun 2025', 'Sep 2025', 'Dec 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026'],
  src: 'standalone widget', revenue: [55, 60, 58, 70, 49, 96], netProfit: [7, 9, 8, 10, 5, 13], eps: [] };
const fig = (rev, opm, pat) => ({ revenue: rev, other_income: 0.5, expenses: rev * (1 - opm / 100), finance_costs: 0, depreciation: 0,
  exceptional: null, pbeit: pat * 1.3, pbt: pat * 1.3, tax: pat * 0.3, pat: pat, eps: 1 });
// NSE XBRL: Sep 2026 19% and the quarter before (Jun 2026 15%) - no year-ago quarter in the file
const XBRL = { sym: 'MARS', quarter: 'Sep 2026', cons: Object.assign(fig(97, 19, 13.4), { prev: Object.assign(fig(49, 15, 6), { quarter: 'Jun 2026' }) }) };

function env() {
  const e = mock.loadCodeGs({ sheets: [
    { name: 'Main', rows: [['Main watchlist'], HEAD, [false, 'Marsons Ltd', 'MARS', RD, 1.2].concat(OLD)] },
    { name: 'AutoFetch Log', rows: [['ts']] },
    { name: 'Results_Announcements', rows: [['Symbol', 'Filed (IST)', 'Session', 'Subject', 'Received'],
      ['MARS', '2026-11-13 16:00:00', 'After market', 'Financial Results', '']] }
  ] }, { props: { AB_BRIDGE_TOKEN: TOKEN, AB_RS_SEASON: 'Sep 2026' }, now: NOW });
  e.call('ab_ensureOpmQtrYoyCol_');
  row(e)[qy(e)] = STALE_QY;
  return e;
}
const main = (e) => e.sheet('Main').rows;
const qy = (e) => main(e)[1].indexOf('OPM Qtr YoY');
const row = (e) => main(e).find((x) => x[C.SYMBOL] === 'MARS');
const words = (e) => [row(e)[C['OPM QoQ%']], row(e)[qy(e)]];
function rp(e) {
  const rows = e.sheet('Results Performance').rows;
  const h = rows.findIndex((r) => r[0] === 'Symbol' && r[1] === 'Company');
  const r = rows.slice(h + 1).find((x) => String(x[0]).indexOf('MARS') >= 0);
  const o = {};
  rows[h].forEach((k, i) => { o[k] = r ? r[i] : undefined; });
  return o;
}
const tracker = (e) => {
  const rows = e.sheet('Results Tracker').rows;
  const o = {};
  rows[0].forEach((k, i) => { o[k] = rows.find((r) => r[0] === 'MARS')[i]; });
  return o;
};

test('MARSONS chain: moneycontrol -> NSE XBRL -> screener.in; last quarter\'s OPM words never stay; Results Performance follows Main', () => {
  const e = env();
  e.post({ token: TOKEN, action: 'put', items: [{ sym: 'MARS', html: BEFORE }] });
  e.post({ token: TOKEN, action: 'mcput', items: [MC] });
  e.post({ token: TOKEN, action: 'process' });
  assert.strictEqual(tracker(e).Source, 'moneycontrol');
  assert.deepStrictEqual(words(e), ['', ''], 'moneycontrol has no OPM: both blank, not last quarter\'s');
  assert.strictEqual(row(e)[C['OPM YoY%']], OLD[8], 'the yearly OPM YoY% waits for screener.in as before');
  assert.strictEqual(rp(e)['OPM QoQ'], '', 'the Results Performance row: no stale word');
  const mcNp = rp(e)['NP QoQ %'];
  assert.ok(Math.abs(mcNp - 1.6) < 1e-9, 'moneycontrol\'s profit QoQ (5 -> 13) in the first copy: ' + mcNp);

  e.setNow(NOW + 3600e3);
  e.post({ token: TOKEN, action: 'xbrlput', items: [XBRL] });
  e.post({ token: TOKEN, action: 'process' });
  assert.strictEqual(tracker(e).Source, 'NSE XBRL');
  assert.deepStrictEqual(words(e), ['Increasing', ''], 'OPM QoQ% from the file (15% -> 19%); no year-ago quarter: blank');
  const r = rp(e);
  assert.strictEqual(r['OPM QoQ'], 'Increasing', 'the Results Performance row follows Main');
  assert.ok(Math.abs(r['NP QoQ %'] - row(e)[C['QoQ NP Growth %']] / 100) < 1e-9, 'Profit QoQ = Main\'s (XBRL), not moneycontrol\'s');
  assert.notStrictEqual(r['NP QoQ %'], mcNp);

  // the blank-cell fill from the stored page (still ends Jun 2026: Jun 2026 vs Jun 2025 = last quarter's word) leaves it
  e.setNow(NOW + 2 * 3600e3);
  e.call('ab_rsRun_', 'Manual run', false);
  assert.strictEqual(row(e)[qy(e)], '', 'not filled with last quarter\'s word');

  e.setNow(NOW + 3 * 3600e3);
  e.post({ token: TOKEN, action: 'put', items: [{ sym: 'MARS', html: AFTER }] });
  e.post({ token: TOKEN, action: 'process' });
  assert.strictEqual(tracker(e).Source, 'NSE XBRL + screener.in tags');
  assert.deepStrictEqual(words(e), ['Increasing', 'Aggressive Increase'], 'screener.in\'s word where XBRL could not tell (14% -> 19%)');
  assert.strictEqual(row(e)[C['OPM YoY%']], 'Increasing', 'yearly OPM YoY% from screener.in (12% -> 14%)');
  assert.strictEqual(rp(e)['OPM YoY'], 'Increasing');
});

test('rows written before the fix: every Results Day run sets this quarter\'s words (XBRL + tags, moneycontrol)', () => {
  const e = env();
  e.post({ token: TOKEN, action: 'put', items: [{ sym: 'MARS', html: BEFORE }] });
  e.post({ token: TOKEN, action: 'xbrlput', items: [XBRL] });
  e.post({ token: TOKEN, action: 'process' });
  e.setNow(NOW + 3600e3);
  e.post({ token: TOKEN, action: 'put', items: [{ sym: 'MARS', html: AFTER }] });
  e.post({ token: TOKEN, action: 'process' });
  assert.deepStrictEqual(words(e), ['Increasing', 'Aggressive Increase']);
  // what the earlier code left behind: last quarter's words
  row(e)[C['OPM QoQ%']] = OLD[9];
  row(e)[qy(e)] = STALE_QY;
  e.setNow(NOW + 2 * 3600e3);
  const r = e.call('ab_rsRun_', 'Manual run', false);
  assert.ok(r, 'ran');
  assert.deepStrictEqual(words(e), ['Increasing', 'Aggressive Increase'], 'repaired');
  assert.strictEqual(rp(e)['OPM QoQ'], 'Increasing');

  // a moneycontrol row of this season keeps no OPM word; a screener.in row is not touched
  const e2 = env();
  e2.post({ token: TOKEN, action: 'put', items: [{ sym: 'MARS', html: BEFORE }] });
  e2.post({ token: TOKEN, action: 'mcput', items: [MC] });
  e2.post({ token: TOKEN, action: 'process' });
  row(e2)[C['OPM QoQ%']] = OLD[9];
  row(e2)[qy(e2)] = STALE_QY;
  e2.setNow(NOW + 3600e3);
  e2.call('ab_rsRun_', 'Manual run', false);
  assert.deepStrictEqual(words(e2), ['', '']);
});

test('Results Performance: a row of an older quarter (Main moved on) keeps its own figures', () => {
  const e = env();
  e.post({ token: TOKEN, action: 'put', items: [{ sym: 'MARS', html: AFTER }] });
  e.post({ token: TOKEN, action: 'process' });
  assert.strictEqual(tracker(e).Source, 'screener.in');
  assert.strictEqual(rp(e)['OPM QoQ'], 'Increasing');
  // 50 days later Main's cells change (next season's work): the row stays as it was
  e.setNow(NOW + 50 * 86400e3);
  row(e)[C['OPM QoQ%']] = 'Aggressive Decrease';
  row(e)[C['QoQ NP Growth %']] = -50;
  e.call('ab_rpRefresh_', {});
  assert.strictEqual(rp(e)['OPM QoQ'], 'Increasing');
  assert.ok(rp(e)['NP QoQ %'] > 0);
});
