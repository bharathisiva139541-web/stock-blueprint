'use strict';
// The bullish pattern engine, M1 (owner, 13-Nov-2026; docs/PATTERN_ENGINE_PLAN.md): the Python checks
// (tests/fixtures/pcbridge_patterns_check.py - indicators, the 194-entry registry, the detectors' units / boundaries /
// causality / reproducibility, the Backtest Lab's Pattern library group), K08 Bullish Engulfing = the sheet's own column W
// "Bullish Engulfing" (web/lib/patterns.js) on random candles, and the generated copies of the registry up to date.
// Skipped without python3.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('../web/lib/patterns.js');
const BP = require('../tools/build_patterns.js');

const py = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);
const FIX = path.join(__dirname, 'fixtures', 'pcbridge_patterns_check.py');

test('pattern engine M1 + phases 2 / 3 / 4 (python, offline): indicators, registry, detectors, made charts, causality, Lab group', { skip: !py && 'python3 not installed' }, () => {
  const r = spawnSync(py, [FIX], { encoding: 'utf8', timeout: 600000 });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /OK\s*$/);
});

test('K08 / K09 / K10 / K12 / K17 = the sheet\'s column W rules (web/lib/patterns.js)', { skip: !py && 'python3 not installed' }, () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const r2 = (x) => Math.round(x * 100) / 100;
  const charts = [];
  for (let k = 0; k < 40; k++) {
    const cs = [];
    let px = 50 + rnd() * 500;
    for (let i = 0; i < 300; i++) {
      const o = px * (1 + (rnd() - 0.5) * 0.04);
      const c = o * (1 + (rnd() - 0.5) * 0.06);
      cs.push({ o: r2(o), h: r2(Math.max(o, c) * (1 + rnd() * 0.02)), l: r2(Math.min(o, c) * (1 - rnd() * 0.02)), c: r2(c) });
      px = c;
    }
    charts.push(cs);
  }
  // boundaries: equal bodies, the open exactly at the red close, the close exactly at the red open, a doji before
  charts.push([{ o: 10, h: 10.5, l: 8.9, c: 9 }, { o: 9, h: 10.6, l: 8.8, c: 10 }, { o: 10, h: 10.5, l: 8.9, c: 9 },
    { o: 9, h: 10.6, l: 8.8, c: 10.01 }, { o: 10, h: 10.5, l: 8.9, c: 10 }, { o: 9, h: 10.6, l: 8.8, c: 10.2 },
    { o: 10, h: 10.5, l: 8.9, c: 9 }, { o: 8.99, h: 10.6, l: 8.8, c: 10 }]);
  const SHEET = { K08: 'Bullish Engulfing', K09: 'Piercing', K10: 'Bullish Harami', K12: 'Tweezer Bottoms', K17: 'Morningstar' };
  Object.keys(SHEET).forEach((pid) => {
    const js = charts.map((cs) => cs.map((_, i) => i).filter((i) => i >= 1 && P.patternsAt(cs, i).indexOf(SHEET[pid]) >= 0));
    const r = spawnSync(py, [FIX, '--pat', pid], { input: JSON.stringify(charts), encoding: 'utf8', timeout: 60000, maxBuffer: 1 << 24 });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(JSON.parse(r.stdout), js, pid + ' = the sheet\'s ' + SHEET[pid]);
    assert.ok(js.reduce((n, x) => n + x.length, 0) > 20, pid + ': enough of them on the random charts');
    if (pid === 'K08') assert.deepStrictEqual(js[js.length - 1], [3, 7], 'equal bodies and a doji before are not engulfing; just bigger is');
  });
});

test('web/data/pattern-registry.js + docs/PATTERN_SPECS.md = pattern_registry.py (run `npm run patterns` after changing it)', { skip: !py && 'python3 not installed' }, () => {
  const reg = BP.load();
  assert.strictEqual(fs.readFileSync(BP.OUT_JS, 'utf8'), BP.renderJs(reg));
  assert.strictEqual(fs.readFileSync(BP.OUT_MD, 'utf8'), BP.renderMd(reg));
  assert.strictEqual(reg.patterns.filter((p) => p.category !== 'X').length, 194);
  const impl = reg.patterns.filter((p) => p.status === 'implemented');
  assert.ok(impl.length >= 192 && impl.every((p) => p.rules && p.rules.length && p.words && p.params && p.version), 'rules + words of every implemented one');
  assert.ok(reg.common.length >= 15, 'the shared definitions (phase 3: swings, zones, indicators ...; phase 4: chart patterns)');
  // the Lab page's defaults for every implemented pattern's parameters = the registry's
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'pages', 'lab.js'), 'utf8');
  impl.forEach((p) => Object.keys(p.params).forEach((k) => {
    const m = new RegExp('\\b' + k + ': ([\\d.]+)').exec(src);
    assert.ok(m && Number(m[1]) === p.params[k], p.id + ' ' + k + ' default on the page');
  }));
});
