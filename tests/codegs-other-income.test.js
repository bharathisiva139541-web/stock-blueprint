'use strict';
// "Other income high" flag (owner, 03-Nov-2026, after GANESHCP: revenue -5% YoY, profit +71% - one-off income often sits in
// Other Income, not in the exceptional items): this quarter's other income >= 25% of the profit before tax, or more than
// double the same quarter a year ago while it is at least 10% of PBT. This quarter from the NSE XBRL filing, else from
// screener.in's stored page; the year-ago quarter from screener.in's page (Other Income / Profit before tax rows).
const test = require('node:test');
const assert = require('node:assert');
const mock = require('./fixtures/apps-script-mock.js');

const TOKEN = 'bridge-token-0123456789';
const NOW = Date.UTC(2026, 10, 3, 13, 30);              // Tue 03-Nov-2026 19:00 IST
const RD = new Date(Date.UTC(2026, 10, 2, 6, 30));      // result date 02-Nov-2026
const HEAD = ['Checkbox', 'StockName', 'SYMBOL', 'Result Date', '% Change', 'QoQ Revenue Growth %', 'QoQ NP Growth %',
  'YoY Revenue Growth %', 'YoY NP Growth %', 'TTM EPS', 'Last FY EPS', 'Promotor Holding', 'FII Activity', 'OPM YoY%', 'OPM QoQ%',
  'Price Fall Alert Price', 'Breakout Alert Price', 'Triggered Y/N'];
const OLD = [5, 6, 7, 8, 40, 30, 'Stable', 'Increasing', 'Increasing', 'Decreasing'];
const Q = ['Sep 2025', 'Dec 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026'];

function page(quarters, rows) {
  const tr = (label, a) => '<tr><td class="text">' + label + '<button>+</button></td>' + a.map((v) => '<td>' + v + '</td>').join('') + '</tr>';
  const head = (qs) => '<thead><tr><th></th>' + qs.map((q) => '<th>' + q + '</th>').join('') + '</tr></thead>';
  return '<section id="quarters"><p>Consolidated Figures in Rs. Crores</p><table class="data-table">' + head(quarters) +
    '<tbody>' + Object.keys(rows).map((k) => tr(k, rows[k])).join('') + '</tbody></table></section>' +
    '<section id="profit-loss"><table>' + head(['Mar 2025', 'Mar 2026', 'TTM']) + '<tbody>' + tr('OPM %', ['20%', '22%', '22%']) + '</tbody></table></section>' +
    '<section id="shareholding"><div id="quarterly-shareholding"><table>' + head(['Dec 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026']) + '<tbody>' +
    tr('Promoters', ['60%', '60%', '60%', '60%']) + tr('FIIs', ['5%', '5%', '5%', '5%']) + '</tbody></table></div><div id="yearly-shareholding"></div></section>';
}
const rows = (oi, pbt) => ({ Sales: [100, 100, 100, 100, 110], 'OPM %': ['20%', '20%', '20%', '20%', '20%'], 'Other Income +': oi,
  'Profit before tax': pbt, 'Net Profit': [10, 10, 10, 10, 11], 'EPS in Rs': [1, 1, 1, 1, 1.1] });
function env(syms) {
  return mock.loadCodeGs({ sheets: [
    { name: 'Main', rows: [['Main watchlist'], HEAD].concat(syms.map((s) => [false, s + ' Ltd', s, RD, 1.2].concat(OLD))) },
    { name: 'AutoFetch Log', rows: [['ts']] }
  ] }, { props: { AB_BRIDGE_TOKEN: TOKEN, AB_RS_SEASON: 'Sep 2026' }, now: NOW });
}
function tracker(e) {
  const r = e.sheet('Results Tracker').rows;
  const out = {};
  r.slice(1).forEach((x) => { const o = {}; r[0].forEach((k, i) => { o[k] = x[i]; }); out[x[0]] = o; });
  return out;
}

test('the rule: >= 25% of PBT, or > 2x a year ago while >= 10% of PBT; nothing for a loss or unknown figures', () => {
  const e = env(['A']);
  const fl = (oi) => e.call('ab_rsFlags_', {}, null, oi);
  assert.strictEqual(fl({ cur: 6, ago: 5, pbt: 20 }), 'Other income high: Rs 6.00 Cr = 30% of PBT');
  assert.strictEqual(fl({ cur: 3, ago: 1.2, pbt: 20 }), 'Other income high: Rs 3.00 Cr = 15% of PBT, 2.5x a year ago (Rs 1.20 Cr)');
  assert.strictEqual(fl({ cur: 8, ago: 2, pbt: 20 }), 'Other income high: Rs 8.00 Cr = 40% of PBT, 4.0x a year ago (Rs 2.00 Cr)');
  assert.strictEqual(fl({ cur: 1, ago: 0.2, pbt: 20 }), '', '5x but only 5% of PBT');
  assert.strictEqual(fl({ cur: 4, ago: 3, pbt: 20 }), '', '20% of PBT, not double');
  assert.strictEqual(fl({ cur: 4, ago: null, pbt: 20 }), '');
  assert.strictEqual(fl({ cur: 6, ago: 1, pbt: -5 }), '', 'a loss before tax');
  assert.strictEqual(fl({ cur: null, ago: 1, pbt: 20 }), '');
  assert.strictEqual(fl(undefined), '');
  // with the other flags, '; ' between
  assert.strictEqual(e.call('ab_rsFlags_', { yoyRev: -5, yoyNp: 71 }, null, { cur: 6, ago: 5, pbt: 20 }),
    'Profit growing faster than revenue (YoY profit +71.0% vs revenue -5.0%); Other income high: Rs 6.00 Cr = 30% of PBT');
});

test('screener.in figures: this quarter and a year ago from the page; tracker Flags + email pill', () => {
  const e = env(['HIGHOI', 'NORMAL']);
  e.post({ token: TOKEN, action: 'put', items: [
    { sym: 'HIGHOI', html: page(Q, rows([1, 1, 1, 1, 2.5], [12, 12, 12, 12, 18])) },      // 2.5 / 18 = 14%, 2.5x Sep 2025
    { sym: 'NORMAL', html: page(Q, rows([1, 1, 1, 1, 1.2], [12, 12, 12, 12, 18])) }] });
  e.post({ token: TOKEN, action: 'process' });
  const t = tracker(e);
  assert.strictEqual(t.HIGHOI.Flags, 'Other income high: Rs 2.50 Cr = 14% of PBT, 2.5x a year ago (Rs 1.00 Cr)');
  assert.strictEqual(t.NORMAL.Flags, '');
  const html = e.mails[0][0].htmlBody;
  assert.strictEqual((html.match(/OTHER INCOME HIGH/g) || []).length, 1);
  assert.match(e.mails[0][0].body, /HIGHOI .*\| Flags: Other income high: Rs 2\.50 Cr = 14% of PBT/);
});

test('NSE XBRL figures: this quarter from the filing (same basis), a year ago from screener.in; a row already Updated gets it later', () => {
  const e = env(['XCO', 'LATECO']);
  const prev = page(Q.slice(0, 4), { Sales: [100, 100, 100, 100], 'OPM %': ['20%', '20%', '20%', '20%'], 'Other Income +': [2, 1, 1, 1],
    'Profit before tax': [12, 12, 12, 12], 'Net Profit': [10, 10, 10, 10], 'EPS in Rs': [1, 1, 1, 1] });
  e.post({ token: TOKEN, action: 'put', items: [{ sym: 'XCO', html: prev },
    { sym: 'LATECO', html: page(Q, rows([2, 1, 1, 1, 3], [12, 12, 12, 12, 30])) }] });
  const X = { revenue: 110, other_income: 5.5, expenses: 90, finance_costs: 1, depreciation: 2, exceptional: null, pbeit: 20, pbt: 20, tax: 5, pat: 15, eps: 1.5 };
  e.post({ token: TOKEN, action: 'xbrlput', items: [{ sym: 'XCO', quarter: 'Sep 2026', cons: X }] });
  e.post({ token: TOKEN, action: 'process' });
  let t = tracker(e);
  assert.strictEqual(t.XCO.Source, 'NSE XBRL');
  assert.match(t.XCO.Flags, /Other income high: Rs 5\.50 Cr = 28% of PBT, 2\.8x a year ago \(Rs 2\.00 Cr\)$/);
  assert.strictEqual(t.LATECO.Flags, '', 'screener.in: 3 / 30 = 10%, 1.5x');
  // LATECO's XBRL filing comes the next hour with a bigger other income: the flags pass adds it
  e.setNow(NOW + 3600e3);
  e.post({ token: TOKEN, action: 'xbrlput', items: [{ sym: 'LATECO', quarter: 'Sep 2026', cons: Object.assign({}, X, { other_income: 9, pbt: 30, pbeit: 30 }) }] });
  e.post({ token: TOKEN, action: 'process' });
  t = tracker(e);
  assert.strictEqual(t.LATECO.Flags, 'Other income high: Rs 9.00 Cr = 30% of PBT, 4.5x a year ago (Rs 2.00 Cr)');
});
