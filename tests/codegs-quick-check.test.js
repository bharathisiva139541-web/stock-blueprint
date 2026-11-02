'use strict';
// The PC's 30-minute results check + fewer screener.in pages (owner, 02-Nov-2026, after a 42-minute round of 139 screener.in
// pages: "constantly check the results due today from NSE XBRL every 30 minutes ... after we get the results from NSE XBRL,
// then go for screener.in for the particular companies"; an email whenever new results come - only the new rows;
// moneycontrol kept for the hours between the results PDF and the XBRL filing).
const test = require('node:test');
const assert = require('node:assert');
const mock = require('./fixtures/apps-script-mock.js');

const TOKEN = 'bridge-token-0123456789';
const NOW = Date.UTC(2026, 9, 30, 13, 30);              // Fri 30-Oct-2026 19:00 IST
const ist = (iso) => new Date(Date.parse(iso + 'T12:00:00+05:30'));
const HEAD = ['Checkbox', 'StockName', 'SYMBOL', 'Result Date', '% Change', 'QoQ Revenue Growth %', 'QoQ NP Growth %',
  'YoY Revenue Growth %', 'YoY NP Growth %', 'TTM EPS', 'Last FY EPS', 'Promotor Holding', 'FII Activity', 'OPM YoY%', 'OPM QoQ%',
  'Price Fall Alert Price', 'Breakout Alert Price', 'Triggered Y/N'];
const OLD = [5, 6, 7, 8, 40, 30, 'Stable', 'Increasing', 'Increasing', 'Decreasing'];
const FILED_HEAD = ['Symbol', 'Filed (IST)', 'Session', 'Subject', 'Received'];

function page(quarters, rows) {
  const tr = (label, a) => '<tr><td class="text">' + label + '<button>+</button></td>' + a.map((v) => '<td>' + v + '</td>').join('') + '</tr>';
  const head = (qs) => '<thead><tr><th></th>' + qs.map((q) => '<th>' + q + '</th>').join('') + '</tr></thead>';
  return '<section id="quarters"><p>Consolidated Figures in Rs. Crores</p><table class="data-table">' + head(quarters) +
    '<tbody>' + Object.keys(rows).map((k) => tr(k, rows[k])).join('') + '</tbody></table></section>' +
    '<section id="profit-loss"><table>' + head(['Mar 2025', 'Mar 2026', 'TTM']) + '<tbody>' + tr('OPM %', ['20%', '24%', '25%']) +
    '</tbody></table></section>';
}
const Q8 = ['Sep 2024', 'Dec 2024', 'Mar 2025', 'Jun 2025', 'Sep 2025', 'Dec 2025', 'Mar 2026', 'Jun 2026'];
const ROWS = { Sales: [90, 95, 110, 100, 106, 118, 140, 128], 'OPM %': ['22%', '21%', '25%', '20%', '24%', '23%', '27%', '24%'],
  'Net Profit': [10, 11, 12, 11, 20, 18, 30, 21], 'EPS in Rs': [1.1, 1.2, 1.5, 1.3, 2.4, 2.26, 4.27, 2.63] };
const X = { revenue: 151.12, other_income: 2.22, expenses: 112.52, finance_costs: 0.86, depreciation: 5.06, exceptional: null,
  pbeit: 40.82, pbt: 40.82, tax: 10.26, pat: 30.56, eps: 3.76 };

/** stocks: [[symbol, result date yyyy-mm-dd]]; filed: [[symbol, 'yyyy-mm-dd HH:mm:ss']] */
function env(stocks, filed) {
  return mock.loadCodeGs({ sheets: [
    { name: 'Main', rows: [['Main watchlist'], HEAD].concat(stocks.map(([s, rd]) => [false, s + ' Ltd', s, ist(rd), 1.2].concat(OLD))) },
    { name: 'AutoFetch Log', rows: [['ts']] },
    { name: 'Results_Announcements', rows: [FILED_HEAD].concat((filed || []).map(([s, at]) => [s, at, 'After market', 'Financial Results', ''])) }
  ] }, { props: { AB_BRIDGE_TOKEN: TOKEN, AB_RS_SEASON: 'Sep 2026' }, now: NOW });
}
function tracker(e) {
  const rows = e.sheet('Results Tracker').rows;
  const out = {};
  rows.slice(1).forEach((r) => { const o = {}; rows[0].forEach((k, i) => { o[k] = r[i]; }); out[r[0]] = o; });
  return out;
}

test('screener.in only when it can help: the rules one by one', () => {
  const e = env([['A', '2026-10-30']]);
  const day = Date.parse('2026-10-30T00:00:00+05:30');
  const due = (kind, filedAt, at, err, rdAge) => e.call('ab_rsScreenerDue_', kind, filedAt ? { at: filedAt } : null,
    at ? { at: at, combined: { quarterError: err || '' } } : null, rdAge, '2026-10-30', NOW);
  // no filing seen: not on the result day (the 30-minute check sees the filing); after that once a day
  assert.strictEqual(due('pending', null, null, '', 0), false);
  assert.strictEqual(due('pending', null, null, '', 1), true);
  assert.strictEqual(due('pending', null, day - 3600e3, '', 2), true, 'read yesterday');
  assert.strictEqual(due('pending', null, day + 3600e3, '', 2), false, 'read today already');
  // filed: every full round; a filing more than 3 days old: once a day
  assert.strictEqual(due('pending', '2026-10-30 16:00:00', day + 3600e3, '', 0), true);
  assert.strictEqual(due('pending', '2026-10-27 16:00:00', day + 3600e3, '', 3), true, '3 days: still every round');
  assert.strictEqual(due('pending', '2026-10-26 16:00:00', day + 3600e3, '', 4), false, '4 days, read today');
  assert.strictEqual(due('pending', '2026-10-26 16:00:00', day - 3600e3, '', 4), true, '4 days, read yesterday');
  // moneycontrol's figures: like a filing (from the result date when the filing was not seen)
  assert.strictEqual(due('mc', null, day + 3600e3, '', 2), true);
  assert.strictEqual(due('mc', null, day + 3600e3, '', 5), false);
  // NSE XBRL figures (final): only the trend tags wait - once a day
  assert.strictEqual(due('xbrl', '2026-10-30 16:00:00', day + 3600e3, '', 0), false);
  assert.strictEqual(due('xbrl', '2026-10-30 16:00:00', day - 3600e3, '', 0), true);
  // screener.in said 404: a week's rest
  assert.strictEqual(due('pending', '2026-10-30 16:00:00', NOW - 6 * 864e5, 'not on screener (404)', 0), false);
  assert.strictEqual(due('pending', '2026-10-30 16:00:00', NOW - 8 * 864e5, 'not on screener (404)', 0), true);
});

test('list: the full round asks screener.in by the rules; the quick check asks only NSE XBRL / moneycontrol of filed results', () => {
  const e = env([['TODAYNF', '2026-10-30'], ['TODAYF', '2026-10-30'], ['OLDNF', '2026-10-28'], ['READNF', '2026-10-28'], ['GONE', '2026-10-29']],
    [['TODAYF', '2026-10-30 16:05:00']]);
  e.post({ token: TOKEN, action: 'put', items: [{ sym: 'READNF', html: page(Q8, ROWS) }, { sym: 'GONE', status: 404 }] });
  const l = e.post({ token: TOKEN, action: 'list' });
  assert.deepStrictEqual(l.priority, ['TODAYF', 'OLDNF'], 'not filed today / read today / 404 left out');
  assert.deepStrictEqual(l.mc, { TODAYF: 'Sep 2026' });
  // no tracker rows yet (the first Results Day run makes them): XBRL waits for them
  e.post({ token: TOKEN, action: 'process' });
  const l2 = e.post({ token: TOKEN, action: 'list' });
  assert.deepStrictEqual(l2.xbrl, { TODAYF: 'Sep 2026' });
  assert.deepStrictEqual(Object.keys(l2.xbrlDaily).sort(), ['GONE', 'OLDNF', 'READNF'], 'no filing seen: once a day (not on the result day)');
  const q = e.post({ token: TOKEN, action: 'list', quick: true });
  assert.deepStrictEqual(q, { ok: true, quick: true, mc: { TODAYF: 'Sep 2026' }, xbrl: { TODAYF: 'Sep 2026' }, xbrlBasis: {} });
});

test('the quick check: Results Day on the rows with new NSE XBRL figures only; an email with just the new rows', () => {
  const e = env([['PARAS', '2026-10-29'], ['OTHER', '2026-10-29'], ['LATER', '2026-10-29']],
    [['PARAS', '2026-10-29 16:00:00'], ['OTHER', '2026-10-29 17:00:00'], ['LATER', '2026-10-29 18:00:00']]);
  e.post({ token: TOKEN, action: 'put', items: ['PARAS', 'OTHER', 'LATER'].map((s) => ({ sym: s, html: page(Q8, ROWS) })) });
  e.post({ token: TOKEN, action: 'process' });
  assert.strictEqual(e.mails.length, 0, 'nothing updated - no email');
  let t = tracker(e);
  assert.deepStrictEqual(['PARAS', 'OTHER', 'LATER'].map((s) => [t[s].Status, Number(t[s].Checks)]), [['Pending', 1], ['Pending', 1], ['Pending', 1]]);

  // 30 minutes later: PARAS' XBRL filing came
  e.setNow(NOW + 30 * 60e3);
  e.post({ token: TOKEN, action: 'xbrlput', items: [{ sym: 'PARAS', quarter: 'Sep 2026', cons: X }] });
  const p1 = e.post({ token: TOKEN, action: 'process', quick: true });
  assert.strictEqual(p1.result.missing, 'not in the quick check');
  t = tracker(e);
  assert.deepStrictEqual([t.PARAS.Status, t.PARAS.Source, Number(t.PARAS.Checks)], ['Updated', 'NSE XBRL', 2]);
  assert.deepStrictEqual([Number(t.OTHER.Checks), Number(t.LATER.Checks)], [1, 1], 'the others are not checked again');
  assert.strictEqual(e.mails.length, 1);
  let m = e.mails[0][0];
  assert.match(m.subject, /^Results Update - 1 new in Main \(1 today\), /);
  assert.match(m.htmlBody, /Quick check \(PC bridge\)/);
  assert.match(m.htmlBody, /New results in Main/);
  assert.match(m.body, /NEW RESULTS IN MAIN \(1\)\n {2}PARAS \(result /);

  // 30 minutes later: OTHER's - the email lists OTHER only; the tile counts the day
  e.setNow(NOW + 60 * 60e3);
  e.post({ token: TOKEN, action: 'xbrlput', items: [{ sym: 'OTHER', quarter: 'Sep 2026', cons: X }] });
  e.post({ token: TOKEN, action: 'process', quick: true });
  assert.strictEqual(e.mails.length, 2);
  m = e.mails[1][0];
  assert.match(m.subject, /^Results Update - 1 new in Main \(2 today\), /);
  assert.ok(/symbol=NSE:OTHER"/.test(m.htmlBody) && !/symbol=NSE:PARAS"/.test(m.htmlBody), 'only the new row');

  // nothing new: no email, nobody checked
  e.setNow(NOW + 90 * 60e3);
  const p3 = e.post({ token: TOKEN, action: 'process', quick: true });
  assert.match(p3.result.results, /\(0 checked this run/);
  assert.strictEqual(e.mails.length, 2);
  // the full round's email lists the run's new rows too (screener.in now has LATER's quarter)
  e.post({ token: TOKEN, action: 'put', items: [{ sym: 'LATER', html: page(Q8.slice(1).concat(['Sep 2026']),
    { Sales: ROWS.Sales.slice(1).concat([151]), 'OPM %': ROWS['OPM %'].slice(1).concat(['29%']), 'Net Profit': ROWS['Net Profit'].slice(1).concat([31]),
      'EPS in Rs': ROWS['EPS in Rs'].slice(1).concat([3.76]) }) }] });
  e.post({ token: TOKEN, action: 'process' });
  assert.strictEqual(e.mails.length, 3);
  m = e.mails[2][0];
  assert.match(m.subject, /^Results Update - 1 new in Main \(3 today\), /);
  assert.ok(/symbol=NSE:LATER"/.test(m.htmlBody) && !/symbol=NSE:(PARAS|OTHER)"/.test(m.htmlBody));
});

test('the menu\'s runs keep the whole day in the email', () => {
  const e = env([['PARAS', '2026-10-29']], [['PARAS', '2026-10-29 16:00:00']]);
  e.post({ token: TOKEN, action: 'put', items: [{ sym: 'PARAS', html: page(Q8, ROWS) }] });
  e.post({ token: TOKEN, action: 'xbrlput', items: [{ sym: 'PARAS', quarter: 'Sep 2026', cons: X }] });
  e.post({ token: TOKEN, action: 'process', quick: true });
  e.setNow(NOW + 30 * 60e3);
  e.call('ab_rsSendEmail_', Object.assign({}, (() => {
    const layout = e.call('ab_getMainLayout_');
    const rowsBySym = { PARAS: [2] };
    return { layout: layout, cols: {}, tracker: e.call('ab_rsReadTracker_'), rowsBySym: rowsBySym, todayKey: '2026-10-30',
      runStartFloor: NOW + 30 * 60e3, slot: 'Manual run', checked: 0, failed: 0, perf: {} };
  })()));
  const m = e.mails[e.mails.length - 1][0];
  assert.match(m.subject, /^Results Update - 1 updated in Main, /);
  assert.match(m.htmlBody, /Updated in Main today/);
});
