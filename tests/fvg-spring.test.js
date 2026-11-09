'use strict';
// FVG+Spring (owner, 08-Nov-2026, checked on a picture): a Spring candle pair whose 2nd candle's low is anywhere on a
// 3-candle FVG or Gap-up zone or under its bottom line, closing above the bottom, the zone still holding and no earlier
// close under the Spring low; a later close under it takes the tag off. Checks the rule (web/lib/fvg.js) and parity with
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

const springEv = (s, cfg) => FVG.longFvgDetail(s, cfg).events.filter((e) => e.type === 'fvg-spring')
  .map((e) => ({ i: e.i, zone: e.zone, where: e.where, touch: e.touch, bottom: e.bottom, top: e.top }));

// Owner's rule (08-Nov-2026, checked on a picture): the Spring candle's low anywhere in the zone (bottom 101 .. top 104,
// middle 102.5) or under the bottom (any depth), its close above the bottom, any touch, and NO candle from the zone's
// formation to the red candle closed below the Spring low. A later close below the Spring low takes the tag off.
test('top: the Spring candle dips into the upper half (1st touch)', () => {
  const s = base().concat([c(108, 108.5, 104.2, 104.5), c(104.4, 105, 103.0, 104.3)]);
  assert.deepStrictEqual(spring(FVG.longFvgDetail(s).tags), ['FVG+Spring (Today)']);
  assert.deepStrictEqual(springEv(s), [{ i: 20, zone: 'FVG', where: 'top', touch: 1, bottom: 101, top: 104 }]);
  const older = FVG.longFvgDetail(s.concat([c(104.3, 105, 104.1, 104.8)])).tags;
  assert.deepStrictEqual(spring(older), ['FVG+Spring (1d ago)']);
});

test('any touch counts: the 3rd touch too, while no earlier close went below the Spring low', () => {
  const touch = c(108.5, 108.8, 103.5, 106);      // low 103.5 under the top 104: a touch, closes above 103
  const away = c(106, 107.5, 105.5, 107);
  const pair = [c(108, 108.5, 104.2, 104.5), c(104.4, 105, 103.0, 104.3)];
  const s3 = base(); s3[18] = touch;
  const third = s3.concat([away, c(107, 107.2, 103.8, 105.5), c(105.5, 108, 105.2, 107.8)]).concat(pair);
  assert.deepStrictEqual(springEv(third).map((e) => e.where + ' ' + e.touch), ['top 3']);
});

test('middle: the lower half of the zone counts too (like PARAGMILK), the close may stay inside the zone', () => {
  const s = base().concat([c(106, 106.5, 102.4, 102.6), c(102.5, 103, 101.8, 102.55)]);
  assert.deepStrictEqual(springEv(s), [{ i: 20, zone: 'FVG', where: 'middle', touch: 1, bottom: 101, top: 104 }]);
});

test('an earlier candle that closed below the Spring low makes it not valid (the red candle is excepted)', () => {
  const s = base();
  s[18] = c(108.5, 108.8, 101.5, 101.7);          // closed at 101.7: inside the zone, above the bottom (the zone holds)
  const pair = [c(104, 104.5, 102.4, 102.6), c(102.5, 103, 101.8, 102.55)];   // Spring low 101.8 > that close
  assert.deepStrictEqual(springEv(s.concat([c(101.7, 104.5, 101.6, 104.2)]).concat(pair)), []);
  // the same Spring with that earlier close at 101.9 (above the Spring low): valid
  const t = base();
  t[18] = c(108.5, 108.8, 101.5, 101.9);
  assert.deepStrictEqual(springEv(t.concat([c(101.9, 104.5, 101.6, 104.2)]).concat(pair)).map((e) => e.where), ['middle']);
});

test('bottom: the low under the bottom line by any amount, the close back above it', () => {
  const s = base().concat([c(106, 106.5, 101.6, 101.8), c(101.7, 102.4, 100.5, 101.75)]);
  assert.deepStrictEqual(springEv(s), [{ i: 20, zone: 'FVG', where: 'bottom', touch: 1, bottom: 101, top: 104 }]);
  const deep = base().concat([c(106, 106.5, 99.0, 99.3), c(99.4, 101.6, 97.0, 101.3)]);     // 4 % under the bottom
  assert.deepStrictEqual(springEv(deep).map((e) => e.where), ['bottom']);
  // the close must be above the bottom line
  const below = base().concat([c(106, 106.5, 100.3, 100.5), c(100.6, 101.0, 99.95, 100.8)]);
  assert.deepStrictEqual(springEv(below), []);
  const reclaim = base().concat([c(106, 106.5, 100.3, 100.5), c(100.6, 101.4, 100.0, 101.2)]);   // the red candle closed under it
  assert.deepStrictEqual(springEv(reclaim).map((e) => e.where), ['bottom']);
});

test('a close below the zone bottom before the pair cancels the zone', () => {
  const s = base();
  s[18] = c(108.5, 108.8, 100, 100.5);          // closed below the bottom (101): zone broken
  const tags = FVG.longFvgDetail(s.concat([c(100.5, 108.6, 100.4, 108), c(106, 106.5, 101.6, 101.8), c(101.7, 102.4, 99.5, 101.75)])).tags;
  assert.deepStrictEqual(spring(tags), [], tags.join(', '));
});

test('a later close below the Spring low takes the tag off (the event keeps it with `broken`)', () => {
  const s = base().concat([c(108, 108.5, 104.2, 104.5), c(104.4, 105, 103.0, 104.3)]);
  const held = s.concat([c(104.3, 104.6, 103.1, 103.2)]);          // closes 103.2, above the Spring low 103.0
  assert.deepStrictEqual(spring(FVG.longFvgDetail(held).tags), ['FVG+Spring (1d ago)']);
  const broke = s.concat([c(104.3, 104.6, 102.5, 102.9)]);         // closes 102.9 < 103.0
  assert.deepStrictEqual(spring(FVG.longFvgDetail(broke).tags), []);
  const ev = FVG.longFvgDetail(broke).events.filter((e) => e.type === 'fvg-spring');
  assert.deepStrictEqual(ev.map((e) => [e.i, e.broken]), [[20, 21]]);
  assert.strictEqual(FVG.longFvgDetail(held).events.filter((e) => e.type === 'fvg-spring')[0].broken, -1);
});

const gapEv = (s, cfg) => FVG.longFvgDetail(s, cfg).events.filter((e) => e.type === 'gap-spring')
  .map((e) => ({ i: e.i, zone: e.zone, where: e.where, touch: e.touch, bottom: e.bottom, top: e.top, inside: e.inside }));

test('a Gap-up zone: Gap-up FVG + Spring (owner, 08-Nov-2026: split from FVG+Spring)', () => {
  // wide candles (range 8), then a 4% gap-up: candle 18 low 108.2 > candle 17 high 104 - too small for a 3-candle FVG
  const g = [];
  for (let i = 0; i < 18; i++) g.push(c(100, 104, 96, 100));
  g.push(c(109, 114, 108.2, 113));               // 18: gap-up 104 -> 108.2 (4.04 %)
  g.push(c(113, 115, 111, 114));                 // 19 (also a 3-candle FVG 104 - 111, formed later)
  const pair = [c(114, 114.5, 107.5, 107.8), c(108.0, 108.8, 106.5, 108.4)];   // low 106.5 in the upper half (>= 106.1)
  assert.deepStrictEqual(gapEv(g.concat(pair)), [{ i: 21, zone: 'Gap-up', where: 'top', touch: 1, bottom: 104, top: 108.2, inside: false }],
    'candle 17 is no big green candle: a plain Gap-up, not inside FVG');
  // ... and the same Spring sits in the lower half of that FVG: FVG+Spring too (a Spring on both kinds gets both tags)
  assert.deepStrictEqual(springEv(g.concat(pair)).map((e) => e.zone + ' ' + e.where), ['FVG middle']);
  assert.deepStrictEqual(FVG.longFvgDetail(g.concat(pair)).tags.filter((t) => /Spring/.test(t)), ['FVG+Spring (Today)', 'Gap-up FVG + Spring (Today)']);
  // with AB_GAPUP_MAX_PCT 3 the gap is no zone: only FVG+Spring
  assert.deepStrictEqual(gapEv(g.concat(pair), { AB_GAPUP_MAX_PCT: 3 }), []);
});

test('inside FVG (owner, 09-Nov-2026, BSE): two big green candles with a small gap between them - any size, tagged inside FVG', () => {
  // A (16) high 104 < B (17) high 104.5; B and C green, bodies >= 2 %; C's low 104.9 over B's high (0.38 %); D's low 106 over C's
  const g = [];
  for (let i = 0; i < 17; i++) g.push(c(100, 104, 96, 100));
  g.push(c(100, 104.5, 99.8, 104.3));            // 17: B
  g.push(c(105, 110, 104.9, 109.5));             // 18: C - gap-up zone 104.5 - 104.9
  g.push(c(109.5, 111, 106, 110.5));             // 19: D
  const pair = [c(110.5, 110.8, 105.4, 105.6), c(105.5, 106.0, 104.7, 105.7)];   // Spring low 104.7 in the zone's upper half
  assert.deepStrictEqual(gapEv(g.concat(pair)), [{ i: 21, zone: 'Gap-up', where: 'top', touch: 1, bottom: 104.5, top: 104.9, inside: true }]);
  assert.deepStrictEqual(FVG.longFvgDetail(g.concat(pair)).tags.filter((t) => /Spring/.test(t)), ['Gap-up FVG + Spring (Today, inside FVG)']);
  const z = FVG.gapUpFvgs(g.concat(pair));
  assert.deepStrictEqual(z.map((x) => [x.bottom, x.top, x.pct, x.insideFvg, x.touchIdx]), [[104.5, 104.9, 0.38, true, 21]]);
  // B's body under 2 %: a 0.38 % gap is no zone at all
  const small = g.slice(); small[17] = c(103, 104.5, 99.8, 104.3);
  assert.deepStrictEqual(FVG.gapUpFvgs(small.concat(pair)), []);
  assert.deepStrictEqual(gapEv(small.concat(pair)), []);
  // D's low under C's low: not inside (and not a Gap-up of 3 %)
  const lowD = g.slice(); lowD[19] = c(109.5, 111, 104.8, 110.5);
  assert.deepStrictEqual(FVG.gapUpFvgs(lowD.concat(pair)).map((x) => x.insideFvg), []);
  // before D has closed the gap is not judged inside yet
  assert.deepStrictEqual(FVG.gapUpFvgs(g.slice(0, 19)), []);
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
  let hits = 0, gapHits = 0;
  const bad = [];
  sets.forEach((s, i) => {
    const sheetCandles = s.map((x) => ({ Opn: x.o, High: x.h, Low: x.l, Cls: x.c }));
    const gs = env.call('ab_longFvgDetail_', sheetCandles).tags.join(', ');
    const js = FVG.longFvgDetail(s, { AB_GAPUP_MAX_PCT: 10 }).tags.join(', ');   // the mock's Control Panel = code defaults
    if (/FVG\+Spring/.test(gs)) hits++;
    if (/Gap-up FVG \+ Spring/.test(gs)) gapHits++;
    if (gs !== js) bad.push(i + ': sheet="' + gs + '" js="' + js + '"');
  });
  assert.deepStrictEqual(bad.slice(0, 10), [], bad.length + ' mismatches');
  assert.ok(hits >= 5, 'the fuzz must exercise FVG+Spring: ' + hits + ' hits');
  assert.ok(gapHits >= 1, 'the fuzz must exercise Gap-up FVG + Spring: ' + gapHits + ' hits');
});
