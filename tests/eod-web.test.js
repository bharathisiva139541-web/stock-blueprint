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

test('day: the Main stocks of the newest day, counts per list, missing files leave their counts empty', () => {
  const T = { note: 'Your Main stocks on 2026-10-27 (NSE end-of-day files read by your PC): 4 traded - 2 advances, 1 declines, 1 unchanged, 1 at a new 52-week high, 1 in upper circuit, 0 in lower circuit.',
    cols: ['Symbol', 'Company', 'Close', '% Change', 'Move', 'Circuit', 'New 52W High', 'Delivery %'],
    rows: [['TCS', 'Tata', 3948, 1.23, 'Advance', null, null, 61.2], ['SONA', 'Sona', 700, 3.5, 'Advance', 'Upper', 'Yes', 45.5],
      ['RALLIS', 'Rallis', 380, -2.1, 'Decline', null, null, null], ['FLAT', 'Flat', 50, 0, 'Unchanged', null, null, 50]] };
  const d = E.day(T);
  assert.strictEqual(d.date, '2026-10-27');
  assert.deepStrictEqual(d.counts, { traded: 4, advances: 2, declines: 1, unchanged: 1, high52: 1, upper: 1, lower: 0 });
  assert.deepStrictEqual(d.rows[1], { sym: 'SONA', name: 'Sona', close: 700, chg: 3.5, move: 'Advance', circuit: 'Upper', new52: true, deliv: 45.5 });
  assert.deepStrictEqual(E.pick(d.rows, 'advances').map((r) => r.sym), ['TCS', 'SONA']);
  assert.deepStrictEqual(E.pick(d.rows, 'lower'), []);
  assert.deepStrictEqual(E.pick(d.rows, 'nope'), []);
  assert.deepStrictEqual(E.KINDS.map((k) => k[0]), ['traded', 'advances', 'declines', 'unchanged', 'high52', 'upper', 'lower']);
  const noFiles = E.day(Object.assign({}, T, { note: 'Your Main stocks on 2026-10-20 (NSE end-of-day files read by your PC): 4 traded - 2 advances, 1 declines, 1 unchanged.' }));
  assert.deepStrictEqual([noFiles.counts.high52, noFiles.counts.upper, noFiles.counts.lower], [null, null, null]);
  assert.strictEqual(E.day(null), null);
});

// owner, 08-Nov-2026: "this is not live, even though we have live data" - the Market statistics from the prices on the page
test('liveDay / current: counts from the live change, 52-week high from the day high, circuits kept from NSE\'s day', () => {
  const MD = { note: 'Your Main stocks on 2026-11-06: 3 traded, in upper circuit 1, 52-week high 0', cols: ['Symbol', 'Company', 'Close', '% Change', 'Move', 'Circuit', 'New 52W High', 'Delivery %'],
    rows: [['AAA', 'A Ltd', 100, 5, 'Advance', 'Upper', 'No', 40], ['BBB', 'B Ltd', 50, -1, 'Decline', '', 'No', 20], ['CCC', 'C Ltd', 10, 0, 'Unchanged', '', 'No', 10]] };
  const st = (sym, price, chg, extra) => Object.assign({ sym, name: sym + ' Ltd', price, chg, priceState: 'LIVE', priceAsOf: '2026-11-08 14:56:00' }, extra || {});
  const stocks = [
    st('AAA', 104, 4, { dayHigh: 106, nse52: { high: 105 } }),        // day high 106 >= 105: at a 52-week high
    st('BBB', 49, -2, { base: { hi52: 60 } }),                         // no NSE report row: Main's 52W high
    st('CCC', 10, 0),
    st('DDD', 7, 1, { priceState: 'CACHED', priceAsOf: '2026-11-06 15:30' }),   // an older price is not counted
    st('EEE', 20, null)
  ];
  const market = { state: 'LIVE', asOf: '2026-11-08 14:56:00' };
  const d = E.current({ marketDay: MD }, stocks, market);
  assert.strictEqual(d.live, true);
  assert.deepStrictEqual([d.date, d.eodDate, d.state], ['2026-11-08', '2026-11-06', 'LIVE']);
  assert.deepStrictEqual(d.counts, { traded: 3, advances: 1, declines: 1, unchanged: 1, high52: 1, upper: 1, lower: 0 });
  assert.deepStrictEqual(E.pick(d.rows, 'upper').map((r) => [r.sym, r.close, r.chg]), [['AAA', 104, 4]], 'NSE\'s upper circuit list with the price now');
  assert.deepStrictEqual(E.pick(d.rows, 'high52').map((r) => r.sym), ['AAA']);
  // prices of NSE's own day or older, a weekend snapshot, a cached price: NSE's end-of-day files
  assert.strictEqual(E.current({ marketDay: MD }, stocks, { state: 'LIVE', asOf: '2026-11-06 15:30' }).live, undefined);
  assert.strictEqual(E.current({ marketDay: MD }, stocks, { state: 'EOD', session: 'weekend', asOf: '2026-11-08 10:00' }).live, undefined);
  assert.strictEqual(E.current({ marketDay: MD }, stocks, { state: 'CACHED', asOf: '2026-11-08 10:00' }).live, undefined);
  assert.strictEqual(E.current({ marketDay: MD }, stocks, { state: 'EOD', session: 'closed', asOf: '2026-11-09 16:10' }).live, true, 'after the close, before NSE\'s files');
  // no end-of-day files at all: live counts, circuits unknown
  const n = E.current({}, stocks, market);
  assert.deepStrictEqual([n.live, n.counts.traded, n.counts.upper, n.counts.lower], [true, 3, null, null]);
});
