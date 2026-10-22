'use strict';
// Bullish Harami + Inverted Hammer: the rule itself (web/lib/patterns.js) and
// parity with Code.gs updateAllCandlestickPatterns (run in the Apps Script mock).
const test = require('node:test');
const assert = require('node:assert');
const P = require('../web/lib/patterns.js');
const mock = require('./fixtures/apps-script-mock');

const TAG = 'Bullish Harami + Inverted Hammer';
const CONFIRMED = TAG + ' (confirmed)';
const c = (o, h, l, cl) => ({ o: o, h: h, l: l, c: cl, v: 1e6 });
const sheetC = (x) => ({ Opn: x.o, High: x.h, Low: x.l, Cls: x.c });

// shaped like the owner's chart: red body 87% of range; green body 40% of it,
// opening at the red close, upper wick 1.65 x body up to just under the red high
const RED = c(100, 101, 89.5, 90);
const GREEN = c(90.2, 100.8, 90.0, 94.2);

test('matches the reference pair and tags it', () => {
  assert.ok(P.isHaramiInvHammerPair(sheetC(RED), sheetC(GREEN)));
  const tags = P.patternsAt([c(105, 106, 99, 100), RED, GREEN], 2);
  assert.ok(tags.indexOf(TAG) >= 0, tags.join(', '));
  assert.ok(tags.indexOf(CONFIRMED) < 0);
});

test('the wick only has to reach candle 1 open (equal is enough)', () => {
  assert.ok(P.isHaramiInvHammerPair(sheetC(RED), sheetC(c(90.2, 100, 90.0, 93.2))), 'high = open 1');
  assert.ok(!P.isHaramiInvHammerPair(sheetC(RED), sheetC(c(90.2, 99.9, 90.0, 93.2))), 'high just below open 1');
});

test('each rule is enforced', () => {
  const bad = {
    'candle 1 green': [c(90, 101, 89.5, 100), GREEN],
    'candle 1 body under 65% of its range': [c(100, 104, 86, 90), GREEN],
    'body 2 under 25% of body 1': [RED, c(90.2, 100.8, 90.0, 92.4)],
    'body 2 over 50% of body 1': [RED, c(90.2, 100.8, 90.0, 95.4)],
    'opens more than 0.5% away from close 1': [RED, c(91, 100.8, 90.9, 94.2)],
    'closes above the middle of body 1': [c(100, 101, 89.5, 90), c(90.2, 100.9, 90.0, 95.1)],
    'upper wick under 1.5 x body': [c(100, 103, 89.5, 90), c(90.2, 100.1, 90.0, 94.2)],
    'high below open 1': [RED, c(90.2, 99.9, 90.0, 93.2)],
    'high above high 1': [RED, c(90.2, 101.2, 90.0, 94.2)],
    'lower wick over 10% of range': [c(100, 101, 88, 90), c(90.2, 100.8, 88.9, 94.2)],
    'low below candle 1 low': [c(100, 101, 90, 90), c(90.2, 100.8, 89.95, 94.2)],
    'candle 2 red': [RED, c(94.2, 100.8, 90.0, 90.2)]
  };
  Object.keys(bad).forEach((why) => {
    const pair = bad[why];
    assert.strictEqual(P.isHaramiInvHammerPair(sheetC(pair[0]), sheetC(pair[1])), false, why);
  });
});

test('confirmed only when the next close is above the pattern high', () => {
  const up = P.patternsAt([RED, GREEN, c(95, 102, 94.5, 101)], 2);
  assert.ok(up.indexOf(CONFIRMED) >= 0, up.join(', '));
  assert.ok(up.indexOf(TAG) < 0, 'the new pair (GREEN, day 3) is not itself the pattern');
  const flat = P.patternsAt([RED, GREEN, c(95, 101, 94.5, 100.8)], 2);
  assert.ok(flat.indexOf(CONFIRMED) < 0, 'a close equal to the high does not confirm');
});

// ---- parity with Code.gs (same candles through both engines) ----
function rnd(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function dayTab(name, rows) {
  return { name: name, rows: [['TckrSymb', 'OpnPric', 'HghPric', 'LwPric', 'ClsPric']].concat(rows) };
}

test('Code.gs and the JS port give identical tags (fuzz + crafted cases)', () => {
  const r = rnd(42);
  const sets = [];
  // crafted: plain pattern, confirmed pattern, and near misses
  sets.push([c(104, 105, 99, 100), c(103, 104, 99, 100), RED, GREEN]);
  sets.push([c(104, 105, 99, 100), RED, GREEN, c(95, 102, 94.5, 101)]);
  sets.push([c(104, 105, 99, 100), RED, c(90.2, 101.2, 90.0, 94.2), c(95, 102, 94.5, 101)]);
  // random 4-candle sets, biased toward red-then-small-green shapes so the rule is exercised
  for (let k = 0; k < 2500; k++) {
    const base = 50 + r() * 500;
    const set = [];
    let prev = base;
    for (let d = 0; d < 4; d++) {
      const o = prev * (1 + (r() - 0.5) * 0.04);
      const body = o * (r() * 0.06);
      const up = r() < (d === 2 ? 0.25 : 0.5);
      const cl = up ? o + body : o - body;
      const h = Math.max(o, cl) + o * r() * 0.04;
      const l = Math.min(o, cl) - o * r() * 0.02;
      set.push(c(+o.toFixed(2), +h.toFixed(2), +l.toFixed(2), +cl.toFixed(2)));
      prev = cl;
    }
    if (k % 5 === 0) {           // derive a near-pattern pair from the 3rd candle
      const o1 = set[2].o, cl1 = +(o1 * 0.9).toFixed(2), h1 = +(o1 * (1 + r() * 0.02)).toFixed(2);
      set[2] = c(o1, h1, +(cl1 * (1 - r() * 0.01)).toFixed(2), cl1);
      const body1 = o1 - cl1, o2 = +(cl1 * (1 + (r() - 0.5) * 0.012)).toFixed(2);
      const cl2 = +(o2 + body1 * (0.2 + r() * 0.35)).toFixed(2);
      set[3] = c(o2, +(o1 + (h1 - o1) * (r() * 1.4 - 0.2)).toFixed(2), +(o2 - body1 * r() * 0.08).toFixed(2), cl2);
    }
    sets.push(set);
  }
  const syms = sets.map((_, i) => 'S' + i);
  const tabs = [['Day4', 0], ['ThirdDay', 1], ['Yesterday', 2], ['Today', 3]].map(([n, d]) =>
    dayTab(n, sets.map((s, i) => [syms[i], s[d].o, s[d].h, s[d].l, s[d].c])));
  const pd = { name: 'PatternData', rows: [['Date', 'x', 'y', 'Symbol']].concat(syms.map((s) => ['', '', '', s])) };
  const env = mock.loadCodeGs({ sheets: [pd].concat(tabs) });
  env.call('updateAllCandlestickPatterns');
  const grid = env.sheet('PatternData').rows;
  let hits = 0, confirmed = 0;
  const bad = [];
  sets.forEach((s, i) => {
    const sheet = String((grid[i + 1] || [])[22] || '');
    const js = P.patternsAt(s, 3).join(', ');
    if (sheet.indexOf(TAG) >= 0) hits++;
    if (sheet.indexOf(CONFIRMED) >= 0) confirmed++;
    if (sheet !== js) bad.push(syms[i] + ': sheet="' + sheet + '" js="' + js + '"');
  });
  assert.deepStrictEqual(bad.slice(0, 10), [], bad.length + ' mismatches');
  assert.ok(hits >= 3 && confirmed >= 1, 'the fuzz must exercise the rule: ' + hits + ' tags, ' + confirmed + ' confirmed');
});
