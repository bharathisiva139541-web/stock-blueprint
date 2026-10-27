'use strict';
// web/lib/eod.js: the NSE end-of-day tabs as the site shows them - latest market statistics
// (with the day before), the 52-week high report and each stock's Delivery % (latest, 5-day avg).
const test = require('node:test');
const assert = require('node:assert');
const E = require('../web/lib/eod.js');

const STATS = { note: 'NSE market statistics ...', cols: ['Date', 'Stocks Traded', 'Advances', 'Declines', 'Unchanged', 'At 52W High', 'Upper Circuit', 'Lower Circuit'],
  rows: [['2026-10-26', 2300, 1300, 900, 100, 20, 30, 10], ['2026-10-27', 2310, 1520, 700, 90, 28, null, null], ['bad', 1, 1, 1, 1, 1, 1, 1]] };

test('stats: the newest day, the day before, advance / decline ratio; missing figures stay missing', () => {
  const s = E.stats(STATS);
  assert.deepStrictEqual([s.date, s.traded, s.advances, s.declines, s.unchanged, s.high52, s.upper, s.lower, s.adRatio],
    ['2026-10-27', 2310, 1520, 700, 90, 28, null, null, 2.17]);
  assert.deepStrictEqual([s.prev.date, s.prev.adRatio], ['2026-10-26', 1.44]);
  assert.strictEqual(s.note, 'NSE market statistics ...');
  assert.strictEqual(E.stats(null), null);
  assert.strictEqual(E.stats({ cols: STATS.cols, rows: [] }), null);
});

test('highs: rows, new highs today, by symbol, as-on date from the note', () => {
  const h = E.highs({ note: '52-week highs from NSE (adjusted for corporate actions) - as on 2026-10-27: 2 mainboard stocks ...',
    cols: ['Symbol', 'Company', '52W High', '52W High Date', 'Close', '% Below 52W High', 'New High Today', 'In Watchlist'],
    rows: [['NEWCO', null, 50, '2026-10-27', 50, 0, 'Yes', null], ['tcs', 'Tata Consultancy', 4500, '2026-01-10 00:00:00', 3900, 13.3, null, 'Yes'],
      ['NOHIGH', null, null, null, null, null, null, null]] });
  assert.strictEqual(h.asOf, '2026-10-27');
  assert.deepStrictEqual(h.rows.map((r) => r.sym), ['NEWCO', 'TCS']);
  assert.deepStrictEqual(h.newToday.map((r) => r.sym), ['NEWCO']);
  assert.deepStrictEqual(h.bySym.TCS, { sym: 'TCS', name: 'Tata Consultancy', high: 4500, date: '2026-01-10', close: 3900, below: 13.3, isNew: false, inMain: true });
  assert.deepStrictEqual(E.highs(undefined).rows, []);
});

test('delivery: newest day first whatever the column order, 5-day average of the days that have a value', () => {
  const d = E.delivery({ cols: ['Symbol', 'Company', '2026-10-21', '2026-10-27', '2026-10-26', '2026-10-23', '2026-10-22', '2026-10-20'],
    rows: [['TCS', 'Tata', 40, 61.23, 50, null, 45, 10], ['NEW', 'New Co', null, 30, null, null, null, null]] });
  assert.strictEqual(d.date, '2026-10-27');
  assert.deepStrictEqual(d.dates, ['2026-10-27', '2026-10-26', '2026-10-23', '2026-10-22', '2026-10-21', '2026-10-20']);
  assert.deepStrictEqual(d.bySym.TCS, { latest: 61.23, avg5: 49.06, hist: [61.23, 50, null, 45, 40, 10] });
  assert.deepStrictEqual(d.bySym.NEW, { latest: 30, avg5: 30, hist: [30, null, null, null, null, null] });
  assert.deepStrictEqual(E.delivery(null), { date: null, dates: [], bySym: {} });
});
