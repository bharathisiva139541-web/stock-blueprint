'use strict';
// The stock window's PE picture (owner, 23-Nov-2026: "one simple indicator ... Current PE, Median PE for 1 yr, 3 yr, 5 yr,
// and Peak PE ... by seeing this i can understand the current state of PE" -> "I like option C and D. i want Both ... include
// Current Industry PE"): web/lib/pe.js picture / gaugeSvg / barsSvg / html.
const test = require('node:test');
const assert = require('node:assert');
const PE = require('../web/lib/pe.js');

const RVNL = { pe: 42.12, pem1: 53.87, pem3: 56.56, pem5: 42.75, pepk: 87.14, ipe: 16.45 };

test('picture: the verdict against its own medians, the industry and the 5-year peak', () => {
  const p = PE.picture(RVNL);
  assert.deepStrictEqual([p.lo, p.hi, p.verdict.k, p.verdict.words], [42.75, 56.56, 'below', 'Cheaper than its usual PE']);
  assert.deepStrictEqual(p.vsInd, { k: 'above', pct: 156 });
  assert.strictEqual(p.pctPeak, 48);
  assert.deepStrictEqual(p.meds.map((m) => m.k), ['1Y', '3Y', '5Y']);
  assert.strictEqual(PE.picture(Object.assign({}, RVNL, { pe: 50 })).verdict.k, 'within');
  assert.strictEqual(PE.picture(Object.assign({}, RVNL, { pe: 70 })).verdict.k, 'above');
  assert.strictEqual(PE.picture(Object.assign({}, RVNL, { pe: 10 })).vsInd.k, 'below');
  const young = PE.picture({ pe: 24.6, pem1: 31.5, ipe: 20 });
  assert.deepStrictEqual([young.verdict.k, young.peak, young.pctPeak, young.meds.length], ['below', null, null, 1]);
  assert.strictEqual(PE.picture({ pe: 30, ipe: 20 }).verdict.k, 'none', 'no own history: only the industry');
  assert.strictEqual(PE.picture({ pe: null, pem1: 20, ipe: 15 }).verdict.k, 'loss');
  assert.strictEqual(PE.picture({ pe: -5, pem1: 20 }).vsInd, null);
  assert.strictEqual(PE.picture({ pe: 20 }), null, 'nothing to compare with: no picture');
  assert.strictEqual(PE.picture(null), null);
});

test('the speedometer: needle on PE now, the arc ends at the 5-year peak, a mark for every median + the industry', () => {
  const p = PE.picture(RVNL);
  const svg = PE.gaugeSvg(p);
  const m = /<line class="pn pn-good" x1="240" y1="185" x2="([\d.]+)" y2="([\d.]+)"/.exec(svg);
  assert.ok(m, svg);
  const ang = Math.atan2(185 - +m[2], +m[1] - 240), want = Math.PI - Math.PI * 42.12 / 87.14;
  assert.ok(Math.abs(ang - want) < 0.01, 'the needle points at 42.1 of 87.1');
  assert.strictEqual((svg.match(/<circle class="pm"/g) || []).length, 3, 'three medians');
  assert.match(svg, /class="pi" d="M/);
  ['1Y 53.9', '3Y 56.6', '5Y 42.8', 'Industry 16.5', 'Peak 87.1', 'PE now 42.1'].forEach((t) => assert.ok(svg.indexOf('>' + t + '<') > 0, t));
  ['pz-good', 'pz-warn', 'pz-bad'].forEach((c) => assert.ok(svg.indexOf(c) > 0, c));
  const y = PE.gaugeSvg(PE.picture({ pe: 24.6, pem1: 31.5 }));
  assert.ok(y.indexOf('no 5-year peak yet') > 0 && y.indexOf('pz-warn') < 0, 'one median: no amber part (no range)');
  assert.ok(PE.gaugeSvg(PE.picture({ pe: null, pem1: 20 })).indexOf('class="pn') < 0, 'no PE: no needle');
});

test('the bars: PE now against each median, the peak and the industry - cheaper green, costlier red', () => {
  const svg = PE.barsSvg(PE.picture(RVNL));
  const rows = [...svg.matchAll(/class="pl pl-row"[^>]*>([^<]+)</g)].map((x) => x[1]);
  assert.deepStrictEqual(rows, ['vs 1Y median', 'vs 3Y median', 'vs 5Y median', 'vs 5-year peak', 'vs industry PE']);
  const pcts = [...svg.matchAll(/class="pv pv-(good|bad)"[^>]*>([^<]+)</g)].map((x) => x[1] + ' ' + x[2]);
  assert.deepStrictEqual(pcts, ['good -22%', 'good -26%', 'good -1%', 'good -52%', 'bad +156%']);
  assert.ok(/<line class="pdiv"/.test(svg), 'the industry row set apart');
  const wide = [...svg.matchAll(/class="pb pb-bad" x="(\d+)"[^>]*width="(\d+)"/g)][0];
  assert.deepStrictEqual([+wide[1], +wide[2]], [290, 140], '+156% is drawn at most the full half');
  assert.strictEqual(PE.barsSvg(PE.picture({ pe: null, pem1: 20 })), '');
});

test('the block: chips + both pictures, nothing without figures', () => {
  const h = PE.html(PE.picture(RVNL));
  assert.match(h, /<span class="badge s-good">Cheaper than its usual PE<\/span><span class="badge s-bad">156% above industry PE<\/span>/);
  assert.match(h, /PE now 42\.1 · 48% of its 5-year peak · industry PE 16\.5/);
  assert.ok(h.indexOf('pe-gauge') > 0 && h.indexOf('pe-bars') > 0);
  assert.strictEqual(PE.html(null), '');
  assert.match(PE.html(PE.picture({ pe: null, pem1: 20, ipe: 15 })), /<span class="badge ">No PE now \(a loss, or no TTM EPS\)<\/span>/);
});
