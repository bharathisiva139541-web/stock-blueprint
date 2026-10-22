'use strict';
// FVG+Spring (owner's rule, Oct 2026): a Spring candle pair whose 2nd candle dips
// into ANY bullish FVG formed earlier in the window - touched before or not -
// while the zone still holds. Checks the rule (web/lib/fvg.js) and parity with
// Code.gs ab_longFvgDetail_ run in the Apps Script mock.
const test = require('node:test');
const assert = require('node:assert');
const FVG = require('../web/lib/fvg.js');
const mock = require('./fixtures/apps-script-mock');

const c = (o, h, l, cl) => ({ o: o, h: h, l: l, c: cl, v: 1e6 });
const spring = (tags) => tags.filter((t) => /^FVG\+Spring/.test(t));

// 15 flat candles, then a gap: candle 16's low (104) is above candle 14's high (101)
// -> zone bottom 101, top 104; then a gentle drift above the zone.
function base() {
  const out = [];
  for (let i = 0; i < 15; i++) out.push(c(100, 101, 99, 100.2));
  out.push(c(101, 106, 100.5, 105.5));          // 15
  out.push(c(106, 108, 104, 107.5));            // 16: gap formed
  out.push(c(107.5, 109, 106.5, 108.5));        // 17
  out.push(c(108.5, 109.5, 107.5, 108));        // 18
  return out;
}
const RED = c(108, 108.5, 102.8, 103);          // big red candle down into the zone
const SPRING = c(103, 103.6, 102.2, 103.3);     // dips below its low, closes back above it

test('a Spring pair inside a 30-day FVG is tagged', () => {
  const tags = FVG.longFvgDetail(base().concat([RED, SPRING])).tags;
  assert.deepStrictEqual(spring(tags), ['FVG+Spring (Today)'], tags.join(', '));
  const older = FVG.longFvgDetail(base().concat([RED, SPRING, c(103.3, 104.5, 103, 104.2)])).tags;
  assert.deepStrictEqual(spring(older), ['FVG+Spring (1d ago)']);
});

test('the zone may have been touched before (mitigated)', () => {
  const s = base();
  s[18] = c(108.5, 108.8, 103.5, 106);          // touched the zone (low 103.5 < top 104), closed above the bottom
  const tags = FVG.longFvgDetail(s.concat([c(106, 107, 105.5, 106.5), RED, SPRING])).tags;
  assert.deepStrictEqual(spring(tags), ['FVG+Spring (Today)'], tags.join(', '));
});

test('a close below the zone bottom before the pair cancels the zone', () => {
  const s = base();
  s[18] = c(108.5, 108.8, 100, 100.5);          // closed below the bottom (101): zone broken
  const tags = FVG.longFvgDetail(s.concat([c(100.5, 108.6, 100.4, 108), RED, SPRING])).tags;
  assert.deepStrictEqual(spring(tags), [], tags.join(', '));
});

test('the Spring candle must reach the zone and close back at or above its bottom', () => {
  // low above the zone top (104): no tag
  const high = FVG.longFvgDetail(base().concat([c(110, 110.5, 105.2, 105.5), c(105.5, 106, 104.9, 105.7)])).tags;
  assert.deepStrictEqual(spring(high), []);
  // red candle closes below the bottom (fake breakdown), Spring closes back above it: tag
  const reclaim = FVG.longFvgDetail(base().concat([c(106, 106.5, 100.3, 100.5), c(100.6, 101.4, 99.9, 101.2)])).tags;
  assert.deepStrictEqual(spring(reclaim), ['FVG+Spring (Today)'], reclaim.join(', '));
  // same, but the Spring candle closes below the bottom: no tag
  const below = FVG.longFvgDetail(base().concat([c(106, 106.5, 100.3, 100.5), c(100.6, 101.0, 99.9, 100.8)])).tags;
  assert.deepStrictEqual(spring(below), []);
});

test('an older gap still counts after a newer one formed', () => {
  const s = base();
  // a second, higher gap: candle 21's low (112) > candle 19's high (109.4)
  s.push(c(108, 109.4, 107.6, 109));             // 19
  s.push(c(109, 113, 108.8, 112.8));             // 20
  s.push(c(113, 115, 112, 114.5));               // 21: newer gap 109.4 - 112
  // then a drop through the newer zone into the older one (bottom 101 / top 104)
  s.push(c(114.5, 114.8, 109.6, 110));           // 22 (closes above 109.4: newer zone not broken)
  const tags = FVG.longFvgDetail(s.concat([c(110, 110.2, 102.9, 103.2), c(103.1, 103.8, 102.4, 103.4)])).tags;
  assert.deepStrictEqual(spring(tags), ['FVG+Spring (Today)'], tags.join(', '));
});

// ---- parity with Code.gs (same candles through both engines) ----
function rnd(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function series(r) {
  const out = [];
  let p = 50 + r() * 500;
  for (let i = 0; i < 30; i++) {
    const jump = r() < 0.12 ? (r() - 0.3) * 0.12 : 0;     // occasional big move -> gaps
    const o = p * (1 + (r() - 0.5) * 0.01 + jump);
    const cl = o * (1 + (r() - 0.5) * 0.05);
    const h = Math.max(o, cl) * (1 + r() * 0.015), l = Math.min(o, cl) * (1 - r() * 0.015);
    out.push(c(+o.toFixed(2), +h.toFixed(2), +l.toFixed(2), +cl.toFixed(2)));
    p = cl;
  }
  if (r() < 0.6) {                                          // end with a Spring pair (sometimes inside a zone)
    const prev = out[out.length - 3].c, o1 = prev, cl1 = +(o1 * (1 - 0.01 - r() * 0.05)).toFixed(2);
    const l1 = +(cl1 * (1 - r() * 0.005)).toFixed(2);
    const l2 = +(l1 * (1 - 0.0015 - r() * 0.02)).toFixed(2), o2 = +(cl1 * (1 + (r() - 0.5) * 0.004)).toFixed(2);
    const cl2 = +(Math.max(l1 * 1.001, o2 + (r() - 0.5) * (o1 - cl1) * 0.4)).toFixed(2);
    out[out.length - 2] = c(o1, +(o1 * (1 + r() * 0.004)).toFixed(2), l1, cl1);
    out[out.length - 1] = c(o2, +(Math.max(o2, cl2) * (1 + r() * 0.01)).toFixed(2), l2, cl2);
  }
  return out;
}

test('Code.gs and the JS port give identical FVG tags (fuzz + crafted cases)', () => {
  const env = mock.loadCodeGs({ sheets: [] });
  const r = rnd(7);
  const sets = [base().concat([RED, SPRING]), base().concat([c(106, 106.5, 100.3, 100.5), c(100.6, 101.4, 99.9, 101.2)])];
  for (let k = 0; k < 4000; k++) sets.push(series(r));
  let hits = 0;
  const bad = [];
  sets.forEach((s, i) => {
    const sheetCandles = s.map((x) => ({ Opn: x.o, High: x.h, Low: x.l, Cls: x.c }));
    const gs = env.call('ab_longFvgDetail_', sheetCandles).tags.join(', ');
    const js = FVG.longFvgDetail(s).tags.join(', ');
    if (/FVG\+Spring/.test(gs)) hits++;
    if (gs !== js) bad.push(i + ': sheet="' + gs + '" js="' + js + '"');
  });
  assert.deepStrictEqual(bad.slice(0, 10), [], bad.length + ' mismatches');
  assert.ok(hits >= 5, 'the fuzz must exercise FVG+Spring: ' + hits + ' hits');
});
