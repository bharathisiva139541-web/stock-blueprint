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
