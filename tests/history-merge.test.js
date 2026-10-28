'use strict';
// web/lib/history.js: the site's candle history = part 'history' (History30) with part 'history60'
// (History60's older days) put in front - one date list, the newer part wins on a shared day.
const test = require('node:test');
const assert = require('node:assert');
const Hx = require('../web/lib/history.js');
const I = require('../web/lib/indicators.js');

const H = { asOf: '2026-10-28 19:30', source: 'History30 tab (GOOGLEFINANCE daily candles)', timeframe: '1d',
  dates: ['2026-10-26', '2026-10-27', '2026-10-28'], cols: ['d', 'o', 'h', 'l', 'c', 'v'],
  bars: { TCS: [[0, 10, 11, 9, 10, 100], [1, 11, 12, 10, 11, 100], [2, 12, 13, 11, 12, 100]], INFY: [[2, 5, 6, 4, 5, 50]] },
  sheetTags: { TCS: ['', '', '', 1, ''] }, live: true };
const O = { source: 'History60 tab (NSE bhavcopy via your PC)', timeframe: '1d', stored: { days: 60, first: '2026-08-01', last: '2026-10-28' },
  dates: ['2026-10-22', '2026-10-23', '2026-10-26'], cols: ['d', 'o', 'h', 'l', 'c', 'v'],
  bars: { TCS: [[0, 8, 9, 7, 8, 90], [1, 9, 10, 8, 9, 90], [2, 99, 99, 99, 99, 9]], NEWCO: [[1, 3, 3, 3, 3, 3]] } };

test('merge: older days in front, one sorted date list, History30 wins on a day both have', () => {
  const M = Hx.merge(H, O);
  assert.deepStrictEqual(M.dates, ['2026-10-22', '2026-10-23', '2026-10-26', '2026-10-27', '2026-10-28']);
  assert.deepStrictEqual(M.bars.TCS, [[0, 8, 9, 7, 8, 90], [1, 9, 10, 8, 9, 90], [2, 10, 11, 9, 10, 100], [3, 11, 12, 10, 11, 100], [4, 12, 13, 11, 12, 100]]);
  assert.deepStrictEqual(M.bars.INFY, [[4, 5, 6, 4, 5, 50]]);
  assert.deepStrictEqual(M.bars.NEWCO, [[1, 3, 3, 3, 3, 3]], 'a stock only History60 has');
  assert.deepStrictEqual(M.older, { days: 3, stored: O.stored, source: O.source });
  assert.strictEqual(M.source, 'History30 tab (GOOGLEFINANCE daily candles) + History60 tab (NSE bhavcopy via your PC) (older days)');
  assert.strictEqual(M.sheetTags, H.sheetTags);
  assert.strictEqual(M.live, true);
  assert.deepStrictEqual(H.dates, ['2026-10-26', '2026-10-27', '2026-10-28'], 'the 30-day part is not changed');
});

test('merge: no older candles = the 30-day part as it is', () => {
  for (const o of [null, undefined, { dates: [], bars: {} }, { dates: ['2026-10-01'], bars: {} }]) assert.strictEqual(Hx.merge(H, o), H);
  assert.strictEqual(Hx.usable(O), true);
});

test('sheetBars: the sheet\'s EMA / ATR window is the last 30 candles', () => {
  const c = Array.from({ length: 60 }, (_, i) => ({ t: String(i), o: i, h: i + 1, l: i - 1, c: i + 0.5, v: 1 }));
  assert.strictEqual(I.SHEET_BARS, 30);
  assert.strictEqual(I.sheetBars(c).length, 30);
  assert.strictEqual(I.sheetBars(c)[0].t, '30');
  assert.strictEqual(I.sheetBars(c.slice(0, 12)).length, 12);
  assert.strictEqual(I.emaSupportTag(I.sheetBars(c), 10, 0.5), I.emaSupportTag(c.slice(-30), 10, 0.5));
});
