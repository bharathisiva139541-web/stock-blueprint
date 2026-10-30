'use strict';
// Owner's request, 30-Oct-2026 (MARSONS chart): "Twin Star Bottom" (a red candle, then two small
// candles holding the same low), "Twin Star Bottom + FVG" (those stars inside an FVG that still
// holds) and the RED inverted hammer added to "Bullish Harami + Inverted Hammer". Checks the
// rules (web/lib/patterns.js, web/lib/fvg.js) on the owner's own chart, and parity with
// Code.gs (updateAllCandlestickPatterns, ab_longFvgDetail_) run in the Apps Script mock.
const test = require('node:test');
const assert = require('node:assert');
const P = require('../web/lib/patterns.js');
const FVG = require('../web/lib/fvg.js');
const mock = require('./fixtures/apps-script-mock');

const c = (o, h, l, cl) => ({ o: o, h: h, l: l, c: cl, v: 1e6 });
const sheetC = (x) => ({ Opn: x.o, High: x.h, Low: x.l, Cls: x.c });
const TSB = 'Twin Star Bottom';
const HIH = 'Bullish Harami + Inverted Hammer';

// MARSONS daily candles (o, h, l, c) from 14-Jul to 30-Oct-2026, read off the owner's
// TradingView chart (to about Rs 0.1; the last candle matched O 125.99). Candles above the
// chart's top edge are cut at 134.44 - far from the patterns checked here.
const MARSONS = [
  [110.42, 113.46, 109.37, 111.12], [110.42, 110.97, 107.5, 108.14], [108.93, 113.46, 107.26, 107.89],
  [108.14, 110.12, 106.92, 107.8], [107.75, 108.63, 101.16, 103.95], [103.62, 109.77, 102.6, 103.44],
  [103.86, 105.43, 101.49, 102.18], [102.88, 104.76, 100.3, 103.16], [103.86, 105.81, 101.76, 102.55],
  [102.27, 109.87, 101.76, 104.47], [104.76, 106.77, 103.58, 104.76], [104.85, 105.62, 102.04, 102.27],
  [102.74, 111.58, 102.32, 108.33], [109.27, 113.36, 107.55, 112.13], [112.44, 120.3, 111.63, 119.54],
  [119.97, 124.97, 119.54, 120.96], [120.68, 124.97, 120.03, 123.34], [123.56, 124.86, 121.4, 123.95],
  [123.62, 127.89, 122.39, 125.48], [126.34, 131.18, 125.31, 131.18], [132.86, 134.44, 129.29, 130.24],
  [130.35, 131.13, 122.06, 123.95], [123.79, 125.94, 120.57, 122.78], [123.23, 127.49, 120.24, 125.48],
  [125.88, 134.44, 125.31, 134.44], [134.44, 134.44, 127.95, 128.77], [128.94, 133.83, 128.53, 131.01],
  [130.95, 134.44, 129.29, 134.44], [134.44, 134.44, 125.03, 125.37], [125.37, 128.36, 122.5, 127.2],
  [127.95, 128.94, 121.01, 121.29], [121.51, 124.74, 119.76, 121.95], [121.62, 127.89, 121.01, 121.73],
  [122.39, 132.56, 121.78, 128.59], [128.94, 133.95, 125.94, 127.32], [127.84, 132.32, 126.34, 127.95],
  [128.01, 132.08, 127.14, 128.65], [127.32, 129.94, 124.01, 124.35], [124.69, 126.28, 122.45, 122.84],
  [122.67, 123.67, 119.16, 120.08], [120.08, 121.89, 117.5, 117.92], [117.82, 119.21, 114.13, 115.44],
  [114.76, 116.96, 113.67, 114.24], [114.29, 117.76, 113.41, 114.76], [114.6, 122.67, 114.34, 119.21],
  [122.95, 134.44, 122.39, 132.38], [133.53, 133.53, 124.35, 126.74], [127.49, 134.44, 127.49, 131.07],
  [132.92, 134.44, 130.06, 130.83], [131.54, 134.44, 128.01, 130.12], [131.36, 133.95, 126.45, 129.06],
  [129.88, 132.98, 127.03, 128.59], [129.94, 130.41, 122, 122.67], [122.78, 126.22, 121.73, 123.79],
  [124.24, 124.74, 119.05, 120.52], [120.96, 124.8, 118.46, 123.95], [124.24, 124.69, 116.22, 118.4],
  [118.94, 124.97, 116.75, 117.39], [117.98, 128.53, 117.98, 124.69], [124.8, 126.34, 121.78, 122.84],
  [122.95, 125.6, 122, 124.01], [125.94, 134.44, 125.94, 134.44]
].map((x) => c(x[0], x[1], x[2], x[3]));
const find = (o, cl) => MARSONS.findIndex((x) => x.o === o && x.c === cl);
const OCT5 = find(114.29, 114.76), OCT26 = find(118.94, 117.39);

test('the owner\'s chart: Twin Star Bottom (+ FVG) on 5-Oct, the red Harami + Inverted Hammer on 26-Oct - nowhere else', () => {
  assert.ok(OCT5 > 30 && OCT26 > OCT5);
  const found = [];
  MARSONS.forEach((x, i) => {
    const t = P.patternsAt(MARSONS, i).filter((s) => s === TSB || s.indexOf(HIH) === 0);
    const f = FVG.longFvgDetail(MARSONS.slice(0, i + 1)).tags.filter((s) => /^Twin Star Bottom \+ FVG \(Today\)/.test(s));
    if (t.length || f.length) found.push(i + ': ' + t.concat(f).join(' | '));
  });
  assert.deepStrictEqual(found, [OCT5 + ': ' + TSB + ' | Twin Star Bottom + FVG (Today)', OCT26 + ': ' + HIH]);
  // 6-Oct closed 119.21, above the red candle's open (117.82): confirmed - the only one on the chart
  const conf = MARSONS.map((x, i) => (P.patternsAt(MARSONS, i).indexOf(TSB + ' (confirmed)') >= 0 ? i : -1)).filter((i) => i >= 0);
  assert.deepStrictEqual(conf, [OCT5 + 1]);
  // the FVG it sits in: 21/24-Aug's gap, 113.36 - 119.54 (formed ~30 bars before, untouched until 30-Sep)
  const next = FVG.longFvgDetail(MARSONS.slice(0, OCT5 + 2)).tags;
  assert.ok(next.indexOf('Twin Star Bottom + FVG (1d ago)') >= 0, next.join(', '));
  // 27-Oct closed 124.69, just under the inverted hammer's high 124.97: not "(confirmed)"
  assert.ok(P.patternsAt(MARSONS, OCT26 + 1).indexOf(HIH + ' (confirmed)') < 0);
});

const RED1 = c(100, 100.5, 96.5, 97);           // red, body 3%
test('Twin Star Bottom: each rule', () => {
  const S1 = c(97.1, 98, 95.8, 96.6), S2 = c(96.5, 97.4, 95.9, 97);
  assert.ok(P.isTwinStarBottom(sheetC(RED1), sheetC(S1), sheetC(S2)));
  const bad = {
    'candle 1 green': [c(97, 100.5, 96.5, 100), S1, S2],
    'candle 1 body under 1%': [c(100, 100.5, 99, 99.2), c(99.2, 99.5, 98.9, 99.1), c(99.1, 99.4, 98.95, 99.2)],
    'star 1 body over 35% of candle 1': [RED1, c(97.2, 98, 95.8, 96.0), S2],
    'star 2 body over 35% of candle 1': [RED1, S1, c(96, 97.5, 95.9, 97.1)],
    'a star back up inside candle 1': [RED1, c(97.8, 98.6, 96.0, 98.0), S2],
    'lows more than 1% apart': [RED1, S1, c(96.0, 96.6, 94.7, 95.9)],
    'candle 3 closes below star 1\'s low': [RED1, c(97.1, 98, 96.2, 96.6), c(96.5, 96.8, 95.5, 96.1)]
  };
  Object.keys(bad).forEach((why) => {
    const s = bad[why];
    assert.strictEqual(P.isTwinStarBottom(sheetC(s[0]), sheetC(s[1]), sheetC(s[2])), false, why);
  });
  // confirmed: the next close above candle 1's open (100) - equal is not enough
  assert.ok(P.patternsAt([RED1, S1, S2, c(97.2, 101, 97, 100.4)], 3).indexOf(TSB + ' (confirmed)') >= 0);
  assert.ok(P.patternsAt([RED1, S1, S2, c(97.2, 101, 97, 100)], 3).indexOf(TSB + ' (confirmed)') < 0);
  assert.ok(P.patternsAt([RED1, S1, S2, c(97.2, 99.5, 97, 99.4)], 3).indexOf(TSB + ' (confirmed)') < 0);
  // either colour of star, a doji too
  assert.ok(P.isTwinStarBottom(sheetC(RED1), sheetC(c(96.6, 97.5, 95.8, 96.6)), sheetC(c(96.9, 97.2, 95.9, 96.3))));
});

test('Twin Star Bottom + FVG: the stars must reach a gap formed before candle 1 that still holds', () => {
  const flat = [];
  for (let i = 0; i < 15; i++) flat.push(c(100, 101, 99, 100.2));
  const gap = flat.concat([c(101, 106, 100.5, 105.5), c(106, 108, 104, 107.5), c(107.5, 109, 106.5, 108.5)]);   // zone 101 - 104
  const red = c(108.5, 108.8, 104.6, 104.8), s1 = c(104.7, 105.2, 103.2, 104.2), s2 = c(104.1, 104.8, 103.3, 104.5);
  const tw = (tags) => tags.filter((t) => /^Twin Star/.test(t));
  assert.deepStrictEqual(tw(FVG.longFvgDetail(gap.concat([red, s1, s2])).tags), ['Twin Star Bottom + FVG (Today)']);
  // stars above the zone top (104): the pattern, but no FVG tag
  const hi = [c(110, 110.3, 106.8, 107), c(107, 107.5, 105.9, 106.6), c(106.5, 107.1, 106.0, 106.9)];
  assert.ok(P.patternsAt(gap.concat(hi), 20).indexOf(TSB) >= 0);
  assert.deepStrictEqual(tw(FVG.longFvgDetail(gap.concat(hi)).tags), []);
  // a close below the zone bottom (101) before candle 1: the zone no longer holds
  const broken = gap.slice();
  broken[17] = c(107.5, 108, 100.2, 100.5);
  assert.deepStrictEqual(tw(FVG.longFvgDetail(broken.concat([c(100.5, 108.6, 100.4, 108.5), red, s1, s2])).tags), []);
});

test('Bullish Harami + Inverted Hammer: a red inverted hammer counts too (owner, 30-Oct-2026)', () => {
  const R = c(124.24, 124.69, 116.22, 118.4);          // MARSONS 23-Oct
  const INV = c(118.94, 124.97, 116.75, 117.39);       // MARSONS 26-Oct (red)
  assert.ok(P.isHaramiInvHammerPair(sheetC(R), sheetC(INV)));
  const bad = {
    'red body under 10% of candle 1': c(118.6, 124.9, 118.0, 118.2),
    'red body over 50% of candle 1': c(119.5, 124.9, 116.5, 116.5),
    'opens more than 1% from close 1': c(119.8, 124.9, 118.0, 118.9),
    'wick short of open 1': c(118.94, 124.0, 116.75, 117.39),
    'lower wick over 20% of range': c(118.94, 124.97, 116.3, 118.1),
    'low below candle 1 low': c(118.94, 124.97, 116.1, 116.4)
  };
  Object.keys(bad).forEach((why) => assert.strictEqual(P.isHaramiInvHammerPair(sheetC(R), sheetC(bad[why])), false, why));
  const tags = P.patternsAt([c(126, 127, 123.5, 124.3), R, INV], 2);
  assert.ok(tags.indexOf(HIH) >= 0, tags.join(', '));
  const conf = P.patternsAt([R, INV, c(118, 126, 117.9, 125.2)], 2);
  assert.ok(conf.indexOf(HIH + ' (confirmed)') >= 0, 'confirmed by the next close above its high (124.97)');
});

// ---- parity with Code.gs (same candles through both engines) ----
function rnd(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function withStars(r, out, at) {       // turn candles at, at+1, at+2 into a (near) Twin Star Bottom
  const o1 = out[at - 1].c, cl1 = +(o1 * (1 - 0.008 - r() * 0.04)).toFixed(2), body = o1 - cl1;
  out[at] = c(o1, +(o1 * (1 + r() * 0.004)).toFixed(2), +(cl1 * (1 - r() * 0.006)).toFixed(2), cl1);
  for (let k = 1; k <= 2; k++) {
    const so = +(cl1 + (r() - 0.6) * body * 0.5).toFixed(2), sc = +(so + (r() - 0.5) * body * 0.7).toFixed(2);
    const sl = +(Math.min(so, sc) - cl1 * r() * 0.012).toFixed(2), sh = +(Math.max(so, sc) + cl1 * r() * 0.01).toFixed(2);
    out[at + k] = c(so, sh, sl, sc);
  }
}
function series(r) {
  const out = [];
  let p = 50 + r() * 500;
  for (let i = 0; i < 30; i++) {
    const jump = r() < 0.12 ? (r() - 0.3) * 0.12 : 0;
    const o = p * (1 + (r() - 0.5) * 0.01 + jump);
    const cl = o * (1 + (r() - 0.5) * 0.05);
    const h = Math.max(o, cl) * (1 + r() * 0.015), l = Math.min(o, cl) * (1 - r() * 0.015);
    out.push(c(+o.toFixed(2), +h.toFixed(2), +l.toFixed(2), +cl.toFixed(2)));
    p = cl;
  }
  if (r() < 0.7) withStars(r, out, out.length - 3 - Math.floor(r() * 2));
  if (r() < 0.25) {                     // stars at 26-28, then a strong day that may win back candle 1's open
    withStars(r, out, 26);
    const o = out[28].c, cl = +(out[26].o * (0.99 + r() * 0.03)).toFixed(2);
    out[29] = c(o, +(Math.max(o, cl) * (1 + r() * 0.01)).toFixed(2), +(Math.min(o, cl) * (1 - r() * 0.01)).toFixed(2), cl);
  }
  if (r() < 0.3) {                      // a red inverted hammer pair at the end
    const o1 = out[27].c, cl1 = +(o1 * (1 - 0.02 - r() * 0.04)).toFixed(2), b1 = o1 - cl1;
    out[28] = c(o1, +(o1 + b1 * r() * 0.2).toFixed(2), +(cl1 - b1 * r() * 0.3).toFixed(2), cl1);
    const o2 = +(cl1 * (1 + (r() - 0.5) * 0.02)).toFixed(2), c2 = +(o2 - b1 * (0.05 + r() * 0.5)).toFixed(2);
    out[29] = c(o2, +(o1 + b1 * (r() * 0.4 - 0.15)).toFixed(2), +(c2 - (o2 - c2) * r() * 0.6).toFixed(2), c2);
  }
  return out;
}

test('Code.gs and the JS port agree: patterns (col W) and FVG tags (col X), fuzz + the owner\'s chart', () => {
  const r = rnd(11);
  const sets = [MARSONS.slice(0, OCT5 + 1), MARSONS.slice(0, OCT26 + 1), MARSONS.slice(0, OCT26 + 2)];
  for (let k = 0; k < 3000; k++) sets.push(series(r));
  // FVG column: ab_longFvgDetail_
  const env = mock.loadCodeGs({ sheets: [] });
  let twinFvg = 0;
  const bad = [];
  sets.forEach((s, i) => {
    const gs = env.call('ab_longFvgDetail_', s.map(sheetC)).tags.join(', ');
    const js = FVG.longFvgDetail(s).tags.join(', ');
    if (/Twin Star Bottom \+ FVG/.test(gs)) twinFvg++;
    if (gs !== js) bad.push('fvg ' + i + ': sheet="' + gs + '" js="' + js + '"');
  });
  // pattern column: updateAllCandlestickPatterns on the last 4 candles
  const syms = sets.map((_, i) => 'S' + i);
  const tab = (name, d) => ({ name: name, rows: [['TckrSymb', 'OpnPric', 'HghPric', 'LwPric', 'ClsPric']].concat(sets.map((s, i) => {
    const x = s[s.length - 4 + d];
    return [syms[i], x.o, x.h, x.l, x.c];
  })) });
  const pd = { name: 'PatternData', rows: [['Date', 'x', 'y', 'Symbol']].concat(syms.map((s) => ['', '', '', s])) };
  const env2 = mock.loadCodeGs({ sheets: [pd, tab('Day4', 0), tab('ThirdDay', 1), tab('Yesterday', 2), tab('Today', 3)] });
  env2.call('updateAllCandlestickPatterns');
  const grid = env2.sheet('PatternData').rows;
  let twin = 0, redHih = 0, twinConf = 0;
  sets.forEach((s, i) => {
    const sheet = String((grid[i + 1] || [])[22] || '');
    const js = P.patternsAt(s, s.length - 1).join(', ');
    if (sheet.indexOf(TSB) >= 0) twin++;
    if (sheet.indexOf(TSB + ' (confirmed)') >= 0) twinConf++;
    const t = s[s.length - 1];
    if (sheet.indexOf(HIH) >= 0 && t.c < t.o) redHih++;
    if (sheet !== js) bad.push('pattern ' + syms[i] + ': sheet="' + sheet + '" js="' + js + '"');
  });
  assert.deepStrictEqual(bad.slice(0, 10), [], bad.length + ' mismatches');
  assert.ok(twin >= 20 && twinFvg >= 3 && redHih >= 3 && twinConf >= 5, 'the fuzz must exercise the rules: ' + twin + ' twin stars, ' +
    twinFvg + ' with FVG, ' + redHih + ' red hammers, ' + twinConf + ' confirmed');
});
