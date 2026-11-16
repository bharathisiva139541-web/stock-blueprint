'use strict';
// Result dates from the result FILINGS (owner, 16-Nov-2026: "out of all the stocks, only these stocks result dates are not updated
// in our sheet. i checked ECOSMOBILITY date in NSE, 13 nov 2026 ... these stocks have submitted their results. but our sheets have
// blank in result date. results updates are to be done" - 118 stocks, RELIANCE / MCX / MUTHOOTFIN among them): the Results tab
// (Main's Result Date formula reads it) gets a row for every Main company with an NSE result filing of this season and no row of it;
// Results Day then fetches and writes its figures even when the result date is older than the 21-day window (counted from the day
// the date was added); Main's formula also reads a Results tab date that is a real date.
const test = require('node:test');
const assert = require('node:assert');
const mock = require('./fixtures/apps-script-mock.js');

const TOKEN = 'bridge-token-0123456789';
const NOW = Date.UTC(2026, 10, 16, 12, 30);              // Mon 16-Nov-2026 18:00 IST
const ist = (iso) => new Date(Date.parse(iso + 'T12:00:00+05:30'));
const HEAD = ['Checkbox', 'StockName', 'SYMBOL', 'Result Date', '% Change', 'QoQ Revenue Growth %', 'QoQ NP Growth %',
  'YoY Revenue Growth %', 'YoY NP Growth %', 'TTM EPS', 'Last FY EPS', 'Promotor Holding', 'FII Activity', 'OPM YoY%', 'OPM QoQ%',
  'Price Fall Alert Price', 'Breakout Alert Price', 'Triggered Y/N'];
const OLD = [5, 6, 7, 8, 40, 30, 'Stable', 'Increasing', 'Increasing', 'Decreasing'];
const RES_HEAD = [['Result Calender', '', '', ''], ['SYMBOL', 'COMPANY', 'PURPOSE', 'DATE']];

function page(quarters, rows) {
  const tr = (label, a) => '<tr><td class="text">' + label + '<button>+</button></td>' + a.map((v) => '<td>' + v + '</td>').join('') + '</tr>';
  const head = (qs) => '<thead><tr><th></th>' + qs.map((q) => '<th>' + q + '</th>').join('') + '</tr></thead>';
  return '<section id="quarters"><p>Consolidated Figures in Rs. Crores</p><table class="data-table">' + head(quarters) +
    '<tbody>' + Object.keys(rows).map((k) => tr(k, rows[k])).join('') + '</tbody></table></section>' +
    '<section id="profit-loss"><table>' + head(['Mar 2025', 'Mar 2026', 'TTM']) + '<tbody>' + tr('OPM %', ['20%', '24%', '25%']) +
    '</tbody></table></section>';
}
const Q8 = ['Dec 2024', 'Mar 2025', 'Jun 2025', 'Sep 2025', 'Dec 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026'];
const ROWS = { Sales: [95, 110, 100, 106, 118, 140, 128, 151], 'OPM %': ['21%', '25%', '20%', '24%', '23%', '27%', '24%', '29%'],
  'Net Profit': [11, 12, 11, 20, 18, 30, 21, 31], 'EPS in Rs': [1.2, 1.5, 1.3, 2.4, 2.26, 4.27, 2.63, 3.8] };

/** stocks: [[symbol, result date yyyy-mm-dd | '']]; results: the Results tab rows */
function env(stocks, results, props) {
  return mock.loadCodeGs({ sheets: [
    { name: 'Main', rows: [['Main watchlist'], HEAD].concat(stocks.map(([s, rd]) => [false, s + ' Ltd', s, rd ? ist(rd) : '', 1.2].concat(OLD))) },
    { name: 'PatternData', rows: [['Date', 'x', 'y', 'Symbol']].concat(stocks.map(([s]) => ['', '', '', s])) },
    { name: 'AutoFetch Log', rows: [['ts']] },
    { name: 'Results', rows: RES_HEAD.concat(results || []) }
  ] }, { props: Object.assign({ AB_BRIDGE_TOKEN: TOKEN, AB_RS_SEASON: 'Sep 2026' }, props || {}), now: NOW });
}
const FILED = [['ECOSMOBLTY', '2026-11-13 17:30:00', 'Outcome of Board Meeting'], ['RELIANCE', '2026-10-17 15:45:10', 'Financial Results'],
  ['RELIANCE', '2026-08-01 16:00:00', 'Financial Results'], ['ABC', '2026-11-14 00:30:00', 'Financial Result Updates'],
  ['OLDQ', '2026-11-05 10:00:00', 'Outcome of Board Meeting'], ['NOTMAIN', '2026-11-10 12:00:00', 'Financial Results']];

test('a Main company that filed its results this season and has no row of it on the Results tab gets one (text date like the tab), once', () => {
  const e = env([['ECOSMOBLTY', ''], ['RELIANCE', ''], ['ABC', '2026-11-13'], ['OLDQ', '2026-08-10']],
    [['ABC', 'Abc Ltd', 'Financial Results', '13-Nov-26'], ['OLDQ', 'Old Q Ltd', 'Financial Results', '10-Aug-26']]);
  const r = e.post({ token: TOKEN, action: 'results_ann', ann: FILED });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual([Array.from(r.results.added), Array.from(r.results.replaced)], [['RELIANCE', 'ECOSMOBLTY'], ['OLDQ']]);
  assert.strictEqual(r.resultsError, '');
  const rows = e.sheet('Results').rows.slice(2).filter((x) => x[0]).map((x) => x.slice(0, 4));
  assert.deepStrictEqual(rows, [
    ['ABC', 'Abc Ltd', 'Financial Results', '13-Nov-26'],                                        // its calendar date of this quarter stays
    ['OLDQ', 'Old Q Ltd', 'Financial Results (filed 05/11 10:00 Market hours - from the NSE filing)', '05-Nov-26'],   // last quarter's row
    ['RELIANCE', 'RELIANCE Ltd', 'Financial Results (filed 17/10 15:45 Market closed - from the NSE filing)', '17-Oct-26'],
    ['ECOSMOBLTY', 'ECOSMOBLTY Ltd', 'Financial Results (filed 13/11 17:30 After market - from the NSE filing)', '13-Nov-26']]);
  // what Main's Result Date formula and Results Day read
  const cal = e.call('ab_rsReadCalendar_').map((c) => c.symbol + ' ' + c.dayKey);
  assert.deepStrictEqual(Array.from(cal), ['ABC 2026-11-13', 'OLDQ 2026-11-05', 'RELIANCE 2026-10-17', 'ECOSMOBLTY 2026-11-13']);
  // the days Results Day counts from: the day they were added
  const late = JSON.parse(e.props.getProperty('AB_RS_LATE'));
  assert.deepStrictEqual(late, { RELIANCE: '2026-10-17>2026-11-16', ECOSMOBLTY: '2026-11-13>2026-11-16', OLDQ: '2026-11-05>2026-11-16' });
  const age = (s, rd, today) => e.call('ab_rsAge_', s, rd, today);
  assert.deepStrictEqual([age('RELIANCE', '2026-10-17', '2026-11-16'), age('RELIANCE', '2026-10-17', '2026-12-07'), age('RELIANCE', '2026-10-17', '2026-12-08'),
    age('ECOSMOBLTY', '2026-11-13', '2026-11-20'), age('ABC', '2026-11-13', '2026-11-16'), age('RELIANCE', '2026-08-01', '2026-11-16')], [0, 21, 22, 4, 3, 107]);
  // the next post: nothing to add
  const r2 = e.post({ token: TOKEN, action: 'results_ann', ann: FILED });
  assert.deepStrictEqual([Array.from(r2.results.added), Array.from(r2.results.replaced)], [[], []]);
  assert.strictEqual(e.sheet('Results').rows.filter((x) => x[0]).length, 6);
  assert.deepStrictEqual(JSON.parse(e.props.getProperty('AB_RS_LATE')), late);
  // a catch-up post (the PC's season backfill) never sends the morning email
  assert.strictEqual(e.post({ token: TOKEN, action: 'results_ann', ann: FILED, backfill: true }).emailed, false);
});

test('Results Day fetches and writes a result date added late - older than the 21-day window - and gives up 21 days after it was added', () => {
  const e = env([['RELIANCE', '2026-10-17'], ['OLDIE', '2026-10-17']], []);
  // OLDIE: a result date 30 days old that was on the tab all along (its window is over); RELIANCE: added today from its filing
  e.post({ token: TOKEN, action: 'results_ann', ann: [['RELIANCE', '2026-10-17 15:45:10', 'Financial Results']] });
  const l = e.post({ token: TOKEN, action: 'list' });
  assert.deepStrictEqual(l.priority, ['RELIANCE'], 'screener.in asked for RELIANCE only');
  e.post({ token: TOKEN, action: 'process' });
  let t = e.sheet('Results Tracker').rows;
  assert.deepStrictEqual(t.slice(1).map((x) => [x[0], x[2], x[3], x[4]]), [['RELIANCE', '17/10/2026', 'Sep 2026', 'Pending']]);
  // the PC brings screener.in's page with the September quarter: written and ticked
  e.post({ token: TOKEN, action: 'put', items: [{ sym: 'RELIANCE', html: page(Q8, ROWS) }] });
  e.post({ token: TOKEN, action: 'process' });
  t = e.sheet('Results Tracker').rows;
  assert.deepStrictEqual([t[1][0], t[1][4], t[1][5]], ['RELIANCE', 'Updated', 'Sep 2026']);
  const main = e.sheet('Main').rows[2];
  assert.strictEqual(main[0], true, 'ticked');
  assert.strictEqual(main[5], 18, 'QoQ revenue: 151 vs 128');
});

test('a late date that never shows up on screener.in: given up 21 days after it was added (not at once)', () => {
  const e = env([['LATE', '2026-10-10']], []);
  e.post({ token: TOKEN, action: 'results_ann', ann: [['LATE', '2026-10-10 18:00:00', 'Financial Results']] });
  e.post({ token: TOKEN, action: 'process' });
  assert.strictEqual(e.sheet('Results Tracker').rows[1][4], 'Pending');
  e.setNow(NOW + 21 * 864e5);
  e.post({ token: TOKEN, action: 'process' });
  assert.strictEqual(e.sheet('Results Tracker').rows[1][4], 'Pending', 'day 21: still checked');
  e.setNow(NOW + 22 * 864e5);
  e.post({ token: TOKEN, action: 'process' });
  assert.strictEqual(e.sheet('Results Tracker').rows[1][4], 'Gave up');
});

test('Main\'s Result Date formula reads a real-date cell of the Results tab too; an older formula is replaced by itself', () => {
  const e = env([['ABC', ''], ['DEF', '']], [['ABC', 'Abc', 'Financial Results', '13-Nov-26']]);
  e.call('ab_installResultDateFormula_');
  const one = e.sheet('Main').formulas['2,3'];
  assert.ok(one, JSON.stringify(Object.keys(e.sheet('Main').formulas).slice(0, 5)));
  assert.match(one, /^=IFERROR\(IF\(ISNUMBER\(VLOOKUP\(\$C3,'Results'!\$A:\$D,4,0\)\),INT\(VLOOKUP\(\$C3,'Results'!\$A:\$D,4,0\)\),DATE\(2000\+VALUE\(RIGHT\(/);
  // a v4 formula (text dates only) left in Main: put back at the next 12-hourly check
  const e2 = env([['ABC', '']], []);
  e2.sheet('Main').formulas['2,3'] = '=IFERROR(DATE(2000+VALUE(RIGHT(VLOOKUP($C3,\'Results\'!$A:$D,4,0),2)),1,1),"")';
  assert.strictEqual(e2.call('ab_ensureResultDateReal_'), true);
  assert.match(e2.sheet('Main').formulas['2,3'], /ISNUMBER\(/);
  e2.props.setProperty('AB_RD_FORMULA_CHECKED', '0');
  assert.strictEqual(e2.call('ab_ensureResultDateReal_'), false, 'already the new one: nothing to do');
  assert.strictEqual(e2.call('ab_ensureResultDateReal_'), false, 'checked again only after 12 hours');
});
