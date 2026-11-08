'use strict';
// Results Today (owner, 03-Nov-2026: "a separate dashboard for results due today alone and their status"):
// web/lib/results.js todayRows - the Main stocks whose Result Date is the day, with their status from the Results Tracker.
const test = require('node:test');
const assert = require('node:assert');
const R = require('../web/lib/results.js');

const DAY = '2026-11-03';
const stocks = [
  { sym: 'XBRLCO', name: 'X Co', rdate: DAY, done: true, qrev: 12, yrev: 30, qnp: 20, ynp: 40, sig: 'Buy', price: 100, chg: 2 },
  { sym: 'MCCO', name: 'M Co', rdate: DAY, done: true, qrev: 5, yrev: 9, qnp: 6, ynp: 8, sig: 'Avoid', price: 50, chg: -1 },
  { sym: 'FILEDCO', name: 'F Co', rdate: DAY + ' 00:00', done: false, qrev: 99, yrev: 99, qnp: 99, ynp: 99, sig: 'Buy', price: 10, chg: 0 },
  { sym: 'WAITCO', name: 'W Co', rdate: DAY, done: false, qrev: 1, yrev: 1, qnp: 1, ynp: 1 },
  { sym: 'TICKED', name: 'T Co', rdate: DAY, done: true, qrev: 3 },
  { sym: 'NOROW', name: 'N Co', rdate: DAY, done: false },
  { sym: 'OTHERDAY', name: 'O Co', rdate: '2026-11-04' },
  { sym: 'XBRLCO', name: 'X Co (2nd row)', rdate: DAY }
];
const tracker = [
  { Symbol: 'XBRLCO', 'Result Date': DAY, Status: 'Updated', Source: 'NSE XBRL', Announced: '03/11 16:05 After market', 'Updated At': '2026-11-03 18:40',
    Flags: 'Other income high: Rs 6.00 Cr = 30% of PBT', Checks: '2', Note: 'NSE XBRL figures (consolidated, final)' },
  { Symbol: 'MCCO', 'Result Date': DAY, Status: 'Updated', Source: 'moneycontrol', Announced: '03/11 13:20 Market hours' },
  { Symbol: 'FILEDCO', 'Result Date': DAY, Status: 'Pending', Source: '', Announced: '03/11 17:45 After market', Checks: '1', Note: 'Screener still shows Jun 2026 - will retry' },
  { Symbol: 'WAITCO', 'Result Date': DAY, Status: 'Pending', Source: '', Announced: '' },
  { Symbol: 'WAITCO', 'Result Date': '2026-08-05', Status: 'Updated', Source: 'screener.in' }
];

test('statuses: final (NSE XBRL / screener.in / ticked), provisional (moneycontrol), filed, not filed', () => {
  const rows = R.todayRows(stocks, tracker, DAY);
  assert.deepStrictEqual(rows.map((r) => [r.sym, r.status]), [['XBRLCO', 'final'], ['MCCO', 'provisional'], ['FILEDCO', 'filed'],
    ['WAITCO', 'notfiled'], ['TICKED', 'final'], ['NOROW', 'notfiled']], 'one row per stock, other days left out');
  const x = rows[0];
  assert.deepStrictEqual([x.announced, x.annTime, x.session, x.source, x.updatedAt, x.checks, x.flags],
    ['03/11 16:05 After market', '16:05', 'after', 'NSE XBRL', '2026-11-03 18:40', 2, 'Other income high: Rs 6.00 Cr = 30% of PBT']);
  assert.deepStrictEqual([x.qrev, x.yrev, x.qnp, x.ynp, x.sig], [12, 30, 20, 40, 'Buy'], 'figures once in Main');
  const f = rows[2];
  assert.deepStrictEqual([f.qrev, f.ynp, f.sig, f.price, f.annTime], [null, null, null, 10, '17:45'], 'last quarter\'s figures are not shown as today\'s');
  assert.strictEqual(rows[4].source, 'screener.in', 'ticked by Results Day before the tracker row: screener.in');
  assert.deepStrictEqual(R.TODAY.map((s) => s.id), ['final', 'provisional', 'filed', 'notfiled']);
  assert.deepStrictEqual(R.todayRows(stocks, tracker, '2026-11-05'), []);
});

test('the Results Performance columns (owner: "same as in the results performance table") once the result is in Main', () => {
  const st = stocks.map((s) => Object.assign({}, s, { opmq: 'Increasing', opmy: 'Stagnant', fii: 'Increasing', epsg: 37, ind: 'Cement' }));
  const perf = [
    { Symbol: 'MCCO', Quarter: 'Sep 2026', 'Result Date': DAY + ' 12:00', 'Pre-Result Close': 50, 'Result Day %': 6.4, 'Result Day Close': '',
      'Current Price': 52, '% Since Results': 4, 'Max Gain %': 6.4, 'Max Drawdown %': -1.2, 'Results Verdict': 'Strong', 'Market Reaction': 'Rallied' },
    { Symbol: 'XBRLCO', Quarter: 'Sep 2026', 'Result Date': DAY, 'Pre-Result Close': 100, 'Result Day %': 14.5, 'Result Day Close': 106,
      'Current Price': 108, '% Since Results': 8, 'Max Gain %': 14.5, 'Max Drawdown %': 0, 'Results Verdict': 'Strong', 'Market Reaction': 'Rallied' },
    { Symbol: 'XBRLCO', Quarter: 'Jun 2026', 'Result Date': '2026-08-04', 'Result Day %': -3 },
    { Symbol: 'FILEDCO', Quarter: 'Sep 2026', 'Result Date': DAY, 'Result Day %': 9 }
  ];
  const rows = R.todayRows(st, tracker, DAY, perf), by = {};
  rows.forEach((r) => { by[r.sym] = r; });
  const x = by.XBRLCO;
  assert.deepStrictEqual([x.quarter, x.rdate, x.rdayPct, x.since, x.maxGain, x.maxDd, x.verdict, x.reaction, x.ind],
    ['Sep 2026', DAY, 14.5, 8, 14.5, 0, 'Strong', 'Rallied', 'Cement'], 'the row of today, not an older quarter\'s');
  assert.ok(Math.abs(x.dailyPct - 6) < 1e-9, 'Daily % = where the result day closed');
  assert.ok(Math.abs(by.MCCO.dailyPct - 4) < 1e-9, 'the session still on: the price now');
  assert.deepStrictEqual([x.opmq, x.opmy, x.fii, x.epsg], ['Increasing', 'Stagnant', 'Increasing', 37]);
  const f = by.FILEDCO;
  assert.deepStrictEqual([f.rdayPct, f.verdict, f.opmq, f.fii, f.epsg, f.quarter], [null, null, null, null, null, ''],
    'not in Main yet: nothing from last quarter / a stray row');
  assert.strictEqual(R.todayRows(st, tracker, DAY)[0].rdayPct, null, 'without the tab: empty');
  assert.strictEqual(R.dailyPct({ 'Pre-Result Close': 0, 'Result Day Close': 5 }), null);
});

// owner, 08-Nov-2026: "do whichever we can make as live" - the Results Performance rows with the site's newer price
test('livePerf: since results / today from the price now; Result day + max gain / drawdown once the market could react', () => {
  const row = (sym, extra) => Object.assign({ Symbol: sym, Quarter: 'Sep 2026', 'Result Date': '2026-11-07', 'Pre-Result Close': 1000, 'Current Price': 1005,
    'Today %': 0.5, '% Since Results': 0.5, 'Result Day %': null, 'Result Day Close': null, 'Max Gain %': null, 'Max Drawdown %': null,
    'Reaction From': 'after 2026-11-07', Announced: '07/11 16:58 Market closed' }, extra || {});
  const rows = [
    row('KITE'),                                                                    // filed Saturday, reacting in today's session
    row('DONE', { 'Result Date': '2026-10-20', 'Reaction From': 'from 2026-10-20', 'Result Day %': 6, 'Result Day Close': 1040, 'Max Gain %': 9, 'Max Drawdown %': -2 }),
    row('EARLY', { 'Reaction From': 'after 2026-11-08' }),                          // reacts tomorrow: only the price now
    row('NOLIVE')
  ];
  const s = { KITE: { price: 1120, chg: 12, dayHigh: 1130, dayLow: 990, priceAsOf: '2026-11-08 14:56:00' },
    DONE: { price: 1100, chg: 1, dayHigh: 1110, dayLow: 1090, priceAsOf: '2026-11-08 14:56:00' },
    EARLY: { price: 980, chg: -2, priceAsOf: '2026-11-08 14:56:00' } };
  const out = R.livePerf(rows, (sym) => s[sym] || null);
  const k = out[0];
  assert.deepStrictEqual([k._live, k._reacting, k['Current Price'], k['Today %']], [true, true, 1120, 12]);
  assert.ok(Math.abs(k['% Since Results'] - 12) < 1e-9);
  assert.ok(Math.abs(k['Result Day %'] - 13) < 1e-9, 'the day high went further than the low: +13%');
  assert.ok(Math.abs(R.dailyPct(k) - 12) < 1e-9, 'Daily % = the price now while the session is on');
  assert.deepStrictEqual([Math.round(k['Max Gain %'] * 100) / 100, Math.round(k['Max Drawdown %'] * 100) / 100], [13, -1]);
  const d = out[1];
  assert.deepStrictEqual([d['Result Day %'], d._reacting, Math.round(d['Max Gain %'] * 100) / 100, d['Max Drawdown %']], [6, undefined, 11, -2], 'the result day stays; today\'s high widens the max gain');
  const e = out[2];
  assert.deepStrictEqual([e['Result Day %'], e['Max Gain %'], Math.round(e['% Since Results'] * 100) / 100], [null, null, -2]);
  assert.strictEqual(out[3], rows[3], 'no newer price: the row as the sheet built it');
  assert.strictEqual(rows[0]['% Since Results'], 0.5, 'the sheet rows are not changed');
  const sl = R.seasonLive(out);
  assert.deepStrictEqual([Math.round(sl.median * 100) / 100, sl.above], [5.25, '3 of 4 (75%)']);
});
