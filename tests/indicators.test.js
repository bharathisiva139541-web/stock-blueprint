'use strict';
const test = require('node:test');
const assert = require('node:assert');
const I = require('../web/lib/indicators.js');

const mk = (closes) => closes.map((c, i) => ({ t: 'd' + i, o: c, h: c + 1, l: c - 1, c: c, v: 1000 + i }));
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' got ' + a + ' want ' + b);

test('EMA is SMA-seeded like Code.gs ab_computeEMA_', () => {
  const e = I.ema(mk([1, 2, 3, 4, 5, 6]), 3);
  assert.ok(isNaN(e[0]) && isNaN(e[1]));
  near(e[2], 2, 1e-12);            // SMA(1,2,3)
  near(e[3], 4 * 0.5 + 2 * 0.5, 1e-12); // k = 2/(3+1) = 0.5
  near(e[4], 5 * 0.5 + 3 * 0.5, 1e-12);
});

// StockCharts' table rounds the averages (70.53, 66.32, ...); unrounded Wilder
// (TA-Lib) gives 70.464, 66.249, 66.480, 69.347, 66.295, 57.915.
test('RSI(14) matches the StockCharts / TA-Lib reference example (Wilder)', () => {
  const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28,
    46.00, 46.03, 46.41, 46.22, 45.64];
  const r = I.rsi(mk(closes), 14);
  near(r[14], 70.464, 0.002, 'first RSI');
  near(r[15], 66.249, 0.002);
  near(r[16], 66.480, 0.002);
  near(r[17], 69.347, 0.002);
  near(r[18], 66.295, 0.002);
  near(r[19], 57.915, 0.002);
  assert.ok(isNaN(r[13]));
});

test('SMA and relative volume use only past bars', () => {
  const c = mk([1, 2, 3, 4]);
  assert.deepStrictEqual(I.sma([1, 2, 3, 4], 2).slice(1), [1.5, 2.5, 3.5]);
  const rv = I.relVolume(c, 2);
  near(rv[2], 1002 / ((1000 + 1001) / 2), 1e-12);
  assert.ok(isNaN(rv[1]));
});

test('ATR (EMA smoothing) and true range', () => {
  const c = [{ o: 10, h: 12, l: 9, c: 11 }, { o: 11, h: 13, l: 10, c: 12 }, { o: 12, h: 12.5, l: 8, c: 9 }];
  const tr = I.trueRange(c);
  assert.deepStrictEqual(tr, [3, 3, 4.5]);
  const a = I.atrEma(c, 2);
  near(a[1], 3, 1e-12);
  near(a[2], 4.5 * (2 / 3) + 3 * (1 / 3), 1e-12);
  assert.ok(isNaN(I.atrEmaLast(c.slice(0, 2), 2)));
});

test('MACD line = EMA12 - EMA26; signal defined only after enough bars', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 5 + i * 0.2);
  const c = mk(closes);
  const m = I.macd(c);
  const e12 = I.ema(c, 12), e26 = I.ema(c, 26);
  near(m.macd[40], e12[40] - e26[40], 1e-9);
  assert.ok(isNaN(m.signal[25 + 7]));
  assert.ok(!isNaN(m.signal[25 + 8]));
});

test('swing levels never use bars after i', () => {
  const closes = [10, 12, 15, 12, 10, 9, 8, 9, 11, 14, 13];
  const c = closes.map((x, i) => ({ t: 'd' + i, o: x, h: x, l: x, c: x }));
  const s = I.swingLevels(c, 6, 2);           // pivot high at 2 (15) confirmed by bar 4
  assert.strictEqual(s.highs.length, 1);
  assert.strictEqual(s.highs[0].price, 15);
  assert.strictEqual(s.lows.length, 0);       // low at 6 is not confirmed yet at i=6
  const s2 = I.swingLevels(c, 8, 2);
  assert.strictEqual(s2.lows[0].price, 8);
});

test('EMA support tag fires only on a touch-and-hold within the last 4 bars', () => {
  // rising closes, then a dip that touches the EMA and closes above it
  const closes = Array.from({ length: 14 }, (_, i) => 100 + i);
  const c = closes.map((x, i) => ({ t: 'd' + i, o: x, h: x + 1, l: x - 0.5, c: x }));
  const e = I.ema(c, 10);
  const last = c.length;
  c.push({ t: 'd' + last, o: 113, h: 114, l: e[last - 1] * 0.999, c: 113.5 });
  assert.match(I.emaSupportTag(c, 10, 0.5), /^10 EMA Support \(Today\)$/);
  assert.strictEqual(I.emaSupportTag(c.slice(0, 11), 10, 0.5), '');
});
