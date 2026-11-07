'use strict';
// FVG+Spring (owner, 08-Nov-2026): a Spring candle pair whose 2nd candle sits on the TOP of a 3-candle FVG or Gap-up
// zone (low in its upper half, close above the top, the zone's 1st or 2nd touch) or on its BOTTOM line (low at most 1%
// under it, close above it), the zone still holding. Checks the rule (web/lib/fvg.js) and parity with Code.gs
// ab_longFvgDetail_ run in the Apps Script mock.
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

const springEv = (s, cfg) => FVG.longFvgDetail(s, cfg).events.filter((e) => e.type === 'fvg-spring')
  .map((e) => ({ i: e.i, zone: e.zone, where: e.where, touch: e.touch, bottom: e.bottom, top: e.top }));

// Owner's rule (08-Nov-2026): TOP = low into the zone's upper half (middle 102.5 .. top 104), close above the top, on
// the zone's 1st or 2nd touch; BOTTOM = low at the bottom line (101), at most 1% under it, close above the bottom.
test('top: the Spring candle dips into the upper half and closes above the top (1st touch)', () => {
  const s = base().concat([c(108, 108.5, 104.2, 104.5), c(104.4, 105, 103.0, 104.3)]);
  assert.deepStrictEqual(spring(FVG.longFvgDetail(s).tags), ['FVG+Spring (Today)']);
  assert.deepStrictEqual(springEv(s), [{ i: 20, zone: 'FVG', where: 'top', touch: 1, bottom: 101, top: 104 }]);
  const older = FVG.longFvgDetail(s.concat([c(104.3, 105, 104.1, 104.8)])).tags;
  assert.deepStrictEqual(spring(older), ['FVG+Spring (1d ago)']);
});

test('top: the 2nd touch counts, the 3rd does not', () => {
  const touch = c(108.5, 108.8, 103.5, 106);      // low 103.5 under the top 104, closes inside / above: a touch
  const away = c(106, 107.5, 105.5, 107);          // back above the zone
  const pair = [c(108, 108.5, 104.2, 104.5), c(104.4, 105, 103.0, 104.3)];
  const s2 = base(); s2[18] = touch;
  assert.deepStrictEqual(springEv(s2.concat([away]).concat(pair)).map((e) => e.touch), [2]);
  const s3 = base(); s3[18] = touch;
  const third = s3.concat([away, c(107, 107.2, 103.8, 105.5), c(105.5, 108, 105.2, 107.8)]).concat(pair);
  assert.deepStrictEqual(springEv(third), [], 'the 3rd touch at the top is not FVG+Spring');
});

test('the lower half of the zone is neither top nor bottom', () => {
  const s = base().concat([c(106, 106.5, 102.4, 102.6), c(102.5, 103, 101.8, 102.55)]);
  assert.deepStrictEqual(springEv(s), []);
});

test('top: the close must be above the zone top', () => {
  const s = base().concat([c(108, 108.5, 104.2, 104.5), c(104.4, 104.6, 103.0, 103.9)]);
  assert.deepStrictEqual(springEv(s), []);
});

test('bottom: the low reaches the bottom line (up to 1% under it), close above it - any touch', () => {
  const s = base().concat([c(106, 106.5, 101.6, 101.8), c(101.7, 102.4, 100.5, 101.75)]);
  assert.deepStrictEqual(springEv(s), [{ i: 20, zone: 'FVG', where: 'bottom', touch: 1, bottom: 101, top: 104 }]);
  // after 3 earlier touches the bottom still counts
  const t = base(); t[18] = c(108.5, 108.8, 103.5, 106);
  const many = t.concat([c(106, 107.5, 105.5, 107), c(107, 107.2, 103.8, 105.5), c(105.5, 108, 105.2, 107.8),
    c(106, 106.5, 101.6, 101.8), c(101.7, 102.4, 100.5, 101.75)]);
  assert.deepStrictEqual(springEv(many).map((e) => e.where + ' ' + e.touch), ['bottom 3']);
  // more than 1% under the bottom (101 x 0.99 = 99.99): no
  const deep = base().concat([c(106, 106.5, 101.6, 101.8), c(101.7, 102.4, 99.9, 101.75)]);
  assert.deepStrictEqual(springEv(deep), []);
});

test('bottom: the Spring candle must close above the bottom line', () => {
  const s = base().concat([c(106, 106.5, 100.3, 100.5), c(100.6, 101.0, 99.95, 100.8)]);
  assert.deepStrictEqual(springEv(s), []);
  // the red candle may close under the bottom (a fake breakdown) when the Spring closes back above it
  const reclaim = base().concat([c(106, 106.5, 100.3, 100.5), c(100.6, 101.4, 100.0, 101.2)]);
  assert.deepStrictEqual(springEv(reclaim).map((e) => e.where), ['bottom']);
});

test('a close below the zone bottom before the pair cancels the zone', () => {
  const s = base();
  s[18] = c(108.5, 108.8, 100, 100.5);          // closed below the bottom (101): zone broken
  const tags = FVG.longFvgDetail(s.concat([c(100.5, 108.6, 100.4, 108), c(106, 106.5, 101.6, 101.8), c(101.7, 102.4, 100.5, 101.75)])).tags;
  assert.deepStrictEqual(spring(tags), [], tags.join(', '));
});

test('a Gap-up zone counts too', () => {
  // wide candles (range 8), then a 4% gap-up: candle 18 low 108.2 > candle 17 high 104 - too small for a 3-candle FVG
  const g = [];
  for (let i = 0; i < 18; i++) g.push(c(100, 104, 96, 100));
  g.push(c(109, 114, 108.2, 113));               // 18: gap-up 104 -> 108.2 (4.04 %)
  g.push(c(113, 115, 111, 114));                 // 19 (also a 3-candle FVG 104 - 111, formed later)
  const pair = [c(114, 114.5, 107.5, 107.8), c(108.0, 108.8, 106.5, 108.4)];   // low 106.5 in the upper half (>= 106.1)
  assert.deepStrictEqual(springEv(g.concat(pair)), [{ i: 21, zone: 'Gap-up', where: 'top', touch: 1, bottom: 104, top: 108.2 }]);
  // with AB_GAPUP_MAX_PCT 3 the gap is too big to be a zone; the later FVG (104 - 111, middle 107.5) does not take it
  assert.deepStrictEqual(springEv(g.concat(pair), { AB_GAPUP_MAX_PCT: 3 }), []);
});

test('an older gap still counts after a newer one formed', () => {
  const s = base();
  // a second, higher gap: candle 21's low (112) > candle 19's high (109.4)
  s.push(c(108, 109.4, 107.6, 109));             // 19
  s.push(c(109, 113, 108.8, 112.8));             // 20
  s.push(c(113, 115, 112, 114.5));               // 21: newer gap 109.4 - 112
  s.push(c(114.5, 114.8, 109.6, 110));           // 22 (closes above 109.4: newer zone not broken)
  const ev = springEv(s.concat([c(110, 110.2, 104.4, 104.6), c(104.5, 105.2, 103.2, 104.5)]));
  assert.deepStrictEqual(ev.map((e) => e.bottom + '-' + e.top + ' ' + e.where), ['101-104 top']);
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
  const sets = [base().concat([c(108, 108.5, 104.2, 104.5), c(104.4, 105, 103.0, 104.3)]), base().concat([c(106, 106.5, 100.3, 100.5), c(100.6, 101.4, 100.0, 101.2)])];
  for (let k = 0; k < 4000; k++) sets.push(series(r));
  let hits = 0;
  const bad = [];
  sets.forEach((s, i) => {
    const sheetCandles = s.map((x) => ({ Opn: x.o, High: x.h, Low: x.l, Cls: x.c }));
    const gs = env.call('ab_longFvgDetail_', sheetCandles).tags.join(', ');
    const js = FVG.longFvgDetail(s, { AB_GAPUP_MAX_PCT: 10 }).tags.join(', ');   // the mock's Control Panel = code defaults
    if (/FVG\+Spring/.test(gs)) hits++;
    if (gs !== js) bad.push(i + ': sheet="' + gs + '" js="' + js + '"');
  });
  assert.deepStrictEqual(bad.slice(0, 10), [], bad.length + ' mismatches');
  assert.ok(hits >= 5, 'the fuzz must exercise FVG+Spring: ' + hits + ' hits');
});
