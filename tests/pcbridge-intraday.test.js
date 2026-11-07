'use strict';
// PC bridge, Zerodha Kite (pcbridge/ScreenerBridge/kite_intraday.py): owner, 07-Nov-2026 - "PARAGMILK, in the 4 hour
// timeframe a Spring candlestick pattern formed in an FVG; due to lack of intraday data I missed this opportunity".
// 1. the offline checks (candles of every timeframe, sessions, login, download, a whole scan): tests/fixtures/pcbridge_intraday_check.py
// 2. the Python copy of the rules = the website's (= Code.gs): Spring (web/lib/patterns.js isSpringPair / patternsAt),
//    Spring in FVG (owner's 08-Nov-2026 rule: web/lib/fvg.js longFvgDetail 'fvg-spring' events with zone / where / touch /
//    broken),
//    FVG First Touch / Confirmed / Twin Star + FVG, the unmitigated FVG and the Gap-up zones, on random candles.
//    Skipped without python3.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('../web/lib/patterns.js');
const FVG = require('../web/lib/fvg.js');

const py = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);

test('PC bridge Kite intraday (python, offline)', { skip: !py && 'python3 not installed' }, () => {
  const r = spawnSync(py, [path.join(__dirname, 'fixtures', 'pcbridge_intraday_check.py')], { encoding: 'utf8', timeout: 120000 });
  assert.strictEqual(r.status, 0, (r.stdout || '').slice(-1500) + (r.stderr || '').slice(-1500));
  assert.ok(/(^|\n)OK\s*$/.test(r.stdout), r.stdout.slice(-500));
});

/** Random candles with many gaps and Spring-like pairs (seeded). */
function series(seed, n) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const out = [];
  let px = 100 + rnd() * 400;
  for (let i = 0; i < n; i++) {
    const r = rnd();
    let o, c, h, l;
    if (r < 0.035 && out.length) {                    // a gap-up of 3 - 5.5 % (Gap-up zones)
      const prevHigh = out[out.length - 1].h;
      l = prevHigh * (1.03 + rnd() * 0.025); o = l * (1 + rnd() * 0.004); c = o * (1 + (rnd() - 0.3) * 0.02);
      h = Math.max(o, c) * (1 + rnd() * 0.004);
    } else if (r < 0.07) {                            // a jump: leaves a 3-candle gap now and then
      o = px * (1 + rnd() * 0.01); c = o * (1.04 + rnd() * 0.08);
      h = c * (1 + rnd() * 0.004); l = o * (1 - rnd() * 0.004);
    } else if (r < 0.2 && out.length) {               // a red candle then a Spring-like candle
      o = px; c = o * (1 - 0.004 - rnd() * 0.03); h = o * (1 + rnd() * 0.004); l = c * (1 - rnd() * 0.004);
      out.push({ t: 'x' + out.length, o: o, h: h, l: l, c: c, v: 1000 });
      const under = l * (1 - (rnd() < 0.85 ? 0.0012 + rnd() * 0.02 : rnd() * 0.001));
      const close = l + (o - l) * (rnd() * 0.4) * (rnd() < 0.9 ? 1 : -1);
      const open2 = close + (o - c) * (rnd() * 0.4 - 0.2);
      o = open2; c = close; l = Math.min(under, o, c); h = Math.max(o, c) + (rnd() < 0.8 ? 0 : (h - l) * rnd());
      i++;
    } else {
      o = px; c = px * (1 + (rnd() - 0.5) * 0.03);
      h = Math.max(o, c) * (1 + rnd() * 0.01); l = Math.min(o, c) * (1 - rnd() * 0.01);
    }
    const r2 = (x) => Math.round(x * 100) / 100;
    out.push({ t: 'x' + out.length, o: r2(o), h: r2(Math.max(h, o, c)), l: r2(Math.min(l, o, c)), c: r2(c), v: 1000 });
    px = c;
  }
  return out;
}

test('the Python Spring / Spring in FVG / 4H FVG patterns = the website\'s (and the sheet\'s) rules, on random candles', { skip: !py && 'python3 not installed' }, () => {
  const all = [];
  for (let k = 0; k < 60; k++) all.push(series(1000 + k * 7919, 120 + (k % 5) * 40));
  const zoneOf = (z) => z ? [z.bottom, z.top, z.formedIdx] : null;
  const js = all.map((cs) => {
    const det = FVG.longFvgDetail(cs);
    const ev = (type) => det.events.filter((e) => e.type === type).map((e) => e.i);
    return {
      springs: cs.map((_, i) => i).filter((i) => i >= 1 && P.patternsAt(cs, i).indexOf('Spring') >= 0),
      fvg: det.events.filter((e) => e.type === 'fvg-spring').map((e) => [e.i, e.zone, e.where, e.touch, e.formedIdx, e.bottom, e.top, e.broken]),
      ft: ev('first-touch'), conf: ev('confirmed'), twin: ev('fvg-twinstar'),
      unmit: zoneOf(det.unmitigated),
      gapups: FVG.gapUpFvgs(cs).map((g) => [g.bottom, g.top, g.formedIdx, g.pct])
    };
  });
  const code = [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("k", sys.argv[1])',
    'K = importlib.util.module_from_spec(spec); spec.loader.exec_module(K)',
    'out = []',
    'for cs in json.load(sys.stdin):',
    '    d = K.fvg_detail(cs)',
    '    fs = K.fvg_spring(cs)',
    '    assert sorted(fs) == sorted(d["spring"]), "fvg_spring = fvg_detail spring"',
    '    out.append({"springs": K.springs(cs),',
    '                "fvg": [[i, z["kind"], z["where"], z["touch"], z["f"], z["bottom"], z["top"], -1 if z["broken"] is None else z["broken"]]',
    '                        for i, z in sorted(fs.items())],',
    '                "ft": sorted(d["ft"]), "conf": sorted(d["conf"]), "twin": sorted(d["twin"]),',
    '                "unmit": [d["unmit"]["bottom"], d["unmit"]["top"], d["unmit"]["f"]] if d["unmit"] else None,',
    '                "gapups": [[z["bottom"], z["top"], z["f"], z["pct"]] for z in d["gapups"]]})',
    'print(json.dumps(out))'
  ].join('\n');
  const r = spawnSync(py, ['-c', code, path.join(__dirname, '..', 'pcbridge', 'ScreenerBridge', 'kite_intraday.py')],
    { input: JSON.stringify(all), encoding: 'utf8', timeout: 60000, maxBuffer: 1 << 26 });
  assert.strictEqual(r.status, 0, r.stderr);
  const pyOut = JSON.parse(r.stdout);
  let springs = 0, ft = 0, gapups = 0;
  const fvg = { top: 0, middle: 0, bottom: 0, 'Gap-up': 0, touch3: 0, broken: 0 };
  js.forEach((j, k) => {
    ['springs', 'fvg', 'ft', 'conf', 'twin', 'unmit', 'gapups'].forEach((key) => {
      assert.deepStrictEqual(pyOut[k][key], j[key], key + ', series ' + k);
    });
    springs += j.springs.length; ft += j.ft.length; gapups += j.gapups.length;
    j.fvg.forEach((e) => { fvg[e[2]]++; if (e[1] === 'Gap-up') fvg['Gap-up']++; if (e[3] >= 3) fvg.touch3++; if (e[7] >= 0) fvg.broken++; });
  });
  const twin = js.reduce((a, j) => a + j.twin.length, 0), conf = js.reduce((a, j) => a + j.conf.length, 0);
  assert.ok(springs > 150 && fvg.top > 5 && fvg.middle > 5 && fvg.bottom > 3 && fvg['Gap-up'] >= 1 && fvg.touch3 >= 1 && fvg.broken > 5 &&
    ft > 20 && gapups > 5 && twin > 5 && conf > 20,
    'the random candles exercise every rule: ' + JSON.stringify({ springs: springs, fvg: fvg, ft: ft, gapups: gapups, twin: twin, conf: conf }));
});
