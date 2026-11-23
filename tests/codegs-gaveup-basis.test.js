'use strict';
// Owner, 23-Nov-2026: "Gaveup has 27 stocks, but its results were updated but no tick mark" and "Waiting on Screener.in
// has 13 stocks ... 3MINDIA (Screener still shows Jun 2024 (NSE XBRL: NSE XBRL has no consolidated figures (screener.in's
// are Consolidated)) - will retry" + MTARTECH (Sep 2026 filed standalone only - its subsidiaries merged into it). A
// consolidated page that is behind makes the PC read the standalone page too; the page that goes further is used (the
// other one's quarters kept beside, for an XBRL filing of only that basis); a Gave-up row of the season is still checked
// once a day and ticked when its figures come.
const test = require('node:test');
const assert = require('node:assert');
const mock = require('./fixtures/apps-script-mock.js');

const TOKEN = 'bridge-token-0123456789';
const NOW = Date.UTC(2026, 9, 30, 13, 30);             // Fri 30-Oct-2026 19:00 IST
const RD = new Date(Date.UTC(2026, 9, 29, 6, 30));      // result date Thu 29-Oct-2026
const HEAD = ['Checkbox', 'StockName', 'SYMBOL', 'Result Date', '% Change', 'QoQ Revenue Growth %', 'QoQ NP Growth %',
  'YoY Revenue Growth %', 'YoY NP Growth %', 'TTM EPS', 'Last FY EPS', 'Promotor Holding', 'FII Activity', 'OPM YoY%', 'OPM QoQ%',
  'Price Fall Alert Price', 'Breakout Alert Price', 'Triggered Y/N'];
const C = {};
HEAD.forEach((h, i) => { C[h] = i; });
const OLD = [5, 6, 7, 8, 40, 30, 'Stable', 'Increasing', 'Increasing', 'Decreasing'];
const SYMS = ['MMIND', 'MTAR', 'LATE', 'NOFILE'];
function env(o) {
  o = o || {};
  const filed = o.filed || ['MMIND', 'MTAR', 'LATE'];
  return mock.loadCodeGs({ sheets: [
    { name: 'Main', rows: [['Main watchlist'], HEAD].concat(SYMS.map((s) => [false, s + ' Ltd', s, RD, 1.2].concat(OLD))) },
    { name: 'AutoFetch Log', rows: [['ts']] },
    { name: 'Results_Announcements', rows: [['Symbol', 'Filed (IST)', 'Session', 'Subject', 'Received']]
      .concat(filed.map((s) => [s, '2026-10-29 16:10:00', 'After market', 'Financial Results', ''])) }
  ] }, { props: { AB_BRIDGE_TOKEN: TOKEN, AB_RS_SEASON: 'Sep 2026' }, now: o.now || NOW });
}

function page(quarters, rows, basis) {
  const tr = (label, a) => '<tr><td class="text">' + label + '<button>+</button></td>' + a.map((v) => '<td>' + v + '</td>').join('') + '</tr>';
  const head = (qs) => '<thead><tr><th></th>' + qs.map((q) => '<th>' + q + '</th>').join('') + '</tr></thead>';
  return '<section id="quarters"><p>' + (basis || 'Consolidated') + ' Figures in Rs. Crores</p><table class="data-table">' + head(quarters) +
    '<tbody>' + Object.keys(rows).map((k) => tr(k, rows[k])).join('') + '</tbody></table></section>' +
    '<section id="profit-loss"><table>' + head(['Mar 2025', 'Mar 2026', 'TTM']) + '<tbody>' + tr('OPM %', ['20%', '24%', '25%']) +
    '</tbody></table></section>' +
    '<section id="shareholding"><div id="quarterly-shareholding"><table>' + head(['Dec 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026']) + '<tbody>' +
    tr('Promoters', ['60%', '60%', '60%', '60%']) + tr('FIIs', ['5%', '5%', '5%', '5%']) + '</tbody></table></div><div id="yearly-shareholding"></div></section>';
}
const qs = (endIdx, n) => { const out = []; for (let i = n - 1; i >= 0; i--) { const k = endIdx - 3 * i; const y = Math.floor((k - 1) / 12); out.push(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][k - 1 - y * 12] + ' ' + y); } return out; };
const ROWS = (base) => ({ Sales: [90, 95, 110, 100, 106, 118, 140, 128].map((v) => v + base), 'OPM %': ['22%', '21%', '25%', '20%', '24%', '23%', '27%', '24%'],
  'Net Profit': [10, 11, 12, 11, 20, 18, 30, 21], 'EPS in Rs': [1.1, 1.2, 1.5, 1.3, 2.4, 2.26, 4.27, 2.63] });
const SEP26 = 2026 * 12 + 9, JUN26 = 2026 * 12 + 6, JUN24 = 2024 * 12 + 6;
const STAND_X = { revenue: 151.12, other_income: 2.22, expenses: 112.52, finance_costs: 0.86, depreciation: 5.06, exceptional: null,
  pbeit: 40.82, pbt: 40.82, tax: 10.26, pat: 30.56, eps: 3.76 };

function tracker(e) {
  const rows = e.sheet('Results Tracker').rows;
  const out = {};
  rows.slice(1).forEach((r) => { const o = {}; rows[0].forEach((k, i) => { o[k] = r[i]; }); out[r[0]] = o; });
  return out;
}
const row = (e, sym) => e.sheet('Main').rows.find((x) => x[C.SYMBOL] === sym);

test('a consolidated page that stopped (3MINDIA) or is behind a filed result (MTARTECH): the PC reads the standalone page too', () => {
  const e = env();
  e.post({ token: TOKEN, action: 'process' });                            // the tracker rows (Pending, Sep 2026)
  const r = e.post({ token: TOKEN, action: 'put', items: [
    { sym: 'MMIND', html: page(qs(JUN24, 8), ROWS(0)) },                   // consolidated figures end Jun 2024
    { sym: 'MTAR', html: page(qs(JUN26, 8), ROWS(0)) },                    // filed 29-Oct, the page still Jun 2026
    { sym: 'NOFILE', html: page(qs(JUN26, 8), ROWS(0)) },                  // nothing filed yet: normal
    { sym: 'LATE', html: page(qs(JUN26, 8), ROWS(0), 'Standalone') }] });  // already the standalone page
  const thin = {};
  r.details.forEach((d) => { thin[d.sym] = d.thin; });
  assert.deepStrictEqual(thin, { MMIND: true, MTAR: true, NOFILE: false, LATE: false });
  assert.strictEqual(e.call('ab_rsDueQuarterIdx_', '2026-10-30'), JUN26, 'Jun 2026 + 60 days has passed, Sep 2026 + 60 not');
  assert.strictEqual(e.call('ab_rsDueQuarterIdx_', '2026-11-30'), SEP26);
  // the filing is from today: not yet (screener.in normally shows it within a day)
  const e2 = env({ now: Date.UTC(2026, 9, 29, 14, 0) });
  e2.post({ token: TOKEN, action: 'process' });
  const r2 = e2.post({ token: TOKEN, action: 'put', items: [{ sym: 'MTAR', html: page(qs(JUN26, 8), ROWS(0)) }] });
  assert.strictEqual(r2.details[0].thin, false);
});

test('the standalone page that goes further is used: written, ticked, Updated (3MINDIA)', () => {
  const e = env();
  e.post({ token: TOKEN, action: 'process' });
  e.post({ token: TOKEN, action: 'put', items: [{ sym: 'MMIND', html: page(qs(JUN24, 8), ROWS(0)) }] });
  const r = e.post({ token: TOKEN, action: 'put', items: [{ sym: 'MMIND', html2: page(qs(SEP26, 8), ROWS(5), 'Standalone') }] });
  assert.strictEqual(r.details[0].latest, 'Sep 2026');
  e.post({ token: TOKEN, action: 'process' });
  const t = tracker(e).MMIND;
  assert.deepStrictEqual([t.Status, t.Source], ['Updated', 'screener.in']);
  assert.match(t.Note, /^Standalone figures/);
  assert.strictEqual(row(e, 'MMIND')[C.Checkbox], true);
  // a standalone page that is no further than the consolidated one does not replace it
  const p = e.call('ab_bridgePick_', e.call('ab_qt_parseBoth_', page(qs(JUN26, 8), ROWS(0))), e.call('ab_qt_parseBoth_', page(qs(JUN26, 8), ROWS(9), 'Standalone')));
  assert.strictEqual(p.growth.basis, 'Consolidated');
  assert.strictEqual(p.altSeries.basis, 'Standalone', 'its quarters kept beside');
});

test('an XBRL filing of only the other basis is combined with that page\'s quarters (MTARTECH Sep 2026: standalone only)', () => {
  const e = env();
  e.post({ token: TOKEN, action: 'process' });
  e.post({ token: TOKEN, action: 'put', items: [{ sym: 'MTAR', html: page(qs(JUN26, 8), ROWS(0)) }] });
  e.post({ token: TOKEN, action: 'put', items: [{ sym: 'MTAR', html2: page(qs(JUN26, 8), ROWS(0), 'Standalone') }] });
  e.post({ token: TOKEN, action: 'xbrlput', items: [{ sym: 'MTAR', quarter: 'Sep 2026', cons: null, stand: STAND_X }] });
  e.post({ token: TOKEN, action: 'process' });
  const t = tracker(e).MTAR;
  assert.deepStrictEqual([t.Status, t.Source], ['Updated', 'NSE XBRL']);
  assert.match(t.Note, /^NSE XBRL figures \(standalone, final\)/);
  assert.strictEqual(row(e, 'MTAR')[C.Checkbox], true);
  // Rev QoQ 151.12 vs 128 = 18, TTM EPS 3.76 + 2.63 + 4.27 + 2.26 = 12.92
  assert.deepStrictEqual([row(e, 'MTAR')[C['QoQ Revenue Growth %']], row(e, 'MTAR')[C['TTM EPS']]], [18, 12.92]);
  // without the standalone page's quarters: still the old waiting words
  const e2 = env();
  e2.post({ token: TOKEN, action: 'process' });
  e2.post({ token: TOKEN, action: 'put', items: [{ sym: 'MTAR', html: page(qs(JUN26, 8), ROWS(0)) }] });
  e2.post({ token: TOKEN, action: 'xbrlput', items: [{ sym: 'MTAR', quarter: 'Sep 2026', cons: null, stand: STAND_X }] });
  e2.post({ token: TOKEN, action: 'process' });
  assert.match(tracker(e2).MTAR.Note, /NSE XBRL has no consolidated figures/);
});

test('a Gave-up row of the season: still in the PC\'s lists once a day, Updated + ticked when its figures come', () => {
  const e = env();
  e.post({ token: TOKEN, action: 'process' });
  e.post({ token: TOKEN, action: 'put', items: [{ sym: 'LATE', html: page(qs(JUN26, 8), ROWS(0)) }] });
  e.setNow(NOW + 23 * 864e5);                                             // 22-Nov: 24 days after the result date
  e.post({ token: TOKEN, action: 'process' });
  assert.strictEqual(tracker(e).LATE.Status, 'Gave up');
  const l = e.post({ token: TOKEN, action: 'list' });
  assert.ok(l.priority.includes('LATE'), 'its page once a day');
  assert.strictEqual(l.xbrlDaily.LATE, 'Sep 2026', 'its XBRL filing once a day');
  e.setNow(NOW + 23 * 864e5 + 600e3);                                     // its page read 10 minutes later
  e.post({ token: TOKEN, action: 'put', items: [{ sym: 'LATE', html: page(qs(JUN26, 8), ROWS(0)) }] });
  e.post({ token: TOKEN, action: 'process' });
  let t = tracker(e).LATE;
  assert.strictEqual(t.Status, 'Gave up');
  assert.match(t.Note, /^Not shown within 21 days of the result date - still checked once a day this season: Screener still shows Jun 2026/);
  assert.ok(!e.post({ token: TOKEN, action: 'list' }).priority.includes('LATE'), 'read today already');
  // the next day screener.in shows Sep 2026
  e.setNow(NOW + 24 * 864e5);
  assert.ok(e.post({ token: TOKEN, action: 'list' }).priority.includes('LATE'));
  e.post({ token: TOKEN, action: 'put', items: [{ sym: 'LATE', html: page(qs(SEP26, 8), ROWS(4)) }] });
  e.post({ token: TOKEN, action: 'process' });
  t = tracker(e).LATE;
  assert.deepStrictEqual([t.Status, t.Source], ['Updated', 'screener.in']);
  assert.strictEqual(row(e, 'LATE')[C.Checkbox], true);
  // a new season: a Gave-up row of the old one is left alone
  assert.strictEqual(e.call('ab_rsGaveUpSeason_', { status: 'Gave up', quarter: 'Sep 2026' }, '2027-01-05'), false);
  assert.strictEqual(e.call('ab_rsGaveUpSeason_', { status: 'Gave up', quarter: 'Sep 2026' }, '2026-12-30'), true);
});
