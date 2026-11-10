'use strict';
// The pattern guide (tools/pattern-guide/examples.js -> PDF / PowerPoint): every example chart is checked against the
// REAL rules - web/lib/patterns.js (Code.gs col W), web/lib/fvg.js (Code.gs col X) and Code.gs ab_ipoBaseSequence_ -
// so a picture marked VALID is found by the code and one marked NOT VALID is not. And every pattern the code can
// tag has a page: a new pattern without one fails here (owner, 08-Nov-2026: "if we add new pattern to our script,
// later we add ... chart with rules to this PPT or PDF").
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const P = require('../web/lib/patterns.js');
const F = require('../web/lib/fvg.js');
const mock = require('./fixtures/apps-script-mock.js');
const { spawnSync } = require('child_process');
const G = require('../tools/pattern-guide/examples.js');

const day0 = Date.UTC(2026, 0, 5);
function bars(rows) {
  return rows.map((r, i) => ({ t: new Date(day0 + i * 86400000).toISOString().slice(0, 10), o: r[0], h: r[1], l: r[2], c: r[3], v: 1e6 }));
}
const examples = [];
G.PAGES.forEach((p) => p.examples.forEach((ex, k) => examples.push({ page: p, ex, name: p.id + ' #' + (k + 1) + ' (' + ex.label + ')' })));

test('every example candle is a real candle (high >= open / close >= low)', () => {
  examples.forEach(({ ex, name }) => ex.candles.forEach((c, i) => {
    assert.ok(c.length === 4 && c.every(Number.isFinite), name + ' candle ' + i);
    assert.ok(c[1] >= Math.max(c[0], c[3]) && c[2] <= Math.min(c[0], c[3]), name + ' candle ' + i + ': ' + JSON.stringify(c));
  }));
});

test('candlestick pages: the code finds the pattern on every VALID chart and not on a NOT VALID one', () => {
  examples.filter((e) => e.ex.check.type === 'w').forEach(({ ex, name }) => {
    const b = bars(ex.candles);
    const tags = P.patternsAt(b, b.length - 1);
    assert.strictEqual(tags.indexOf(ex.check.tag) >= 0, ex.ok, name + ': ' + JSON.stringify(tags));
  });
});

test('FVG pages: col X tags (and where the Spring sat) as the charts say', () => {
  examples.filter((e) => e.ex.check.type === 'x').forEach(({ ex, name }) => {
    const b = bars(ex.candles);
    const d = F.longFvgDetail(b);
    const re = new RegExp('^' + ex.check.tag.replace(/[+()]/g, '\\$&') + ' \\(');
    assert.strictEqual(d.tags.some((t) => re.test(t)), ex.ok, name + ': ' + JSON.stringify(d.tags));
    const gapSpring = ex.check.tag === 'Gap-up FVG + Spring';     // owner, 08-Nov-2026: split from FVG+Spring
    if (ex.check.where) {
      const ev = d.events.filter((e) => e.type === (gapSpring ? 'gap-spring' : 'fvg-spring') && e.i === b.length - 1)[0];
      assert.ok(ev && ev.where === ex.check.where, name + ': ' + JSON.stringify(ev));
      if ('inside' in ex.check) assert.strictEqual(ev.inside, ex.check.inside, name + ': inside FVG');
    }
    if ('inside' in ex.check) assert.strictEqual(d.tags.some((t) => / inside FVG\)$/.test(t) && re.test(t)), ex.check.inside, name + ': ' + JSON.stringify(d.tags));
    if (ex.marks && ex.marks.zone && gapSpring) {
      // the drawn zone = a Gap-up zone of the code's rule (3-5 %, formed on that candle)
      // (3-5 %, or any size up to 5 % between the two big green candles of an inside FVG - owner, 09-Nov-2026)
      const z = ex.marks.zone, a = b[z.from - 1], g = b[z.from];
      const pct = (g.l - a.h) / a.h * 100;
      const sc = b.map((x) => ({ Opn: x.o, High: x.h, Low: x.l, Cls: x.c }));
      assert.ok(a.h === z.bottom && g.l === z.top && pct > 0 && pct <= 5 && (pct >= 3 || F.gapInsideAt(sc, z.from)),
        name + ': drawn zone = a Gap-up ' + JSON.stringify([a.h, g.l, pct]));
    } else if (ex.marks && ex.marks.zone && ex.check.tag !== 'Gap-up FVG') {
      const gap = d.events.filter((e) => e.type === 'gap' && e.i === ex.marks.zone.from)[0];
      assert.ok(gap && gap.bottom === ex.marks.zone.bottom && gap.top === ex.marks.zone.top, name + ': drawn zone = the code\'s gap ' + JSON.stringify(gap));
    }
  });
  examples.filter((e) => e.ex.check.type === 'gap').forEach(({ ex, name }) => {
    // owner, 08-Nov-2026: a touched zone stays (mitigated) until a close under its bottom
    const g = F.gapUpFvgs(bars(ex.candles), { AB_GAPUP_MIN_PCT: 3, AB_GAPUP_MAX_PCT: 5 });
    assert.strictEqual(g.length > 0, ex.ok, name + ': ' + JSON.stringify(g));
    if (ex.ok) assert.deepStrictEqual([g[0].bottom, g[0].top], [ex.marks.zone.bottom, ex.marks.zone.top], name + ': drawn zone');
    if ('touched' in ex.check) assert.strictEqual(g[0].touched, ex.check.touched, name + ': mitigated');
    if ('inside' in ex.check) assert.strictEqual(g[0].insideFvg, ex.check.inside, name + ': inside FVG');
  });
});

test('IPO base pages: Code.gs ab_ipoBaseSequence_ finds exactly the levels drawn', () => {
  const env = mock.loadCodeGs({ sheets: [] }, {});
  examples.filter((e) => e.ex.check.type === 'ipo').forEach(({ ex, name }) => {
    const c = JSON.stringify(ex.candles.map((r) => ({ o: r[0], h: r[1], l: r[2], c: r[3] })));
    const out = JSON.parse(env.run('JSON.stringify(ab_ipoBaseSequence_(' + c + ', null))'));
    const k = ex.check;
    assert.deepStrictEqual(out.bases.map((b) => b.level), k.levels, name + ': ' + JSON.stringify(out));
    if ('dropped' in k) assert.strictEqual(out.voidBase && out.voidBase.level, k.dropped, name + ' dropped');
    if (k.broken) assert.deepStrictEqual(out.bases.map((b) => b.broken), k.broken, name + ' broken');
    if (k.types) k.types.forEach((t, i) => { if (t) assert.strictEqual(out.bases[i].type, t, name + ' type ' + i); });
    if ('sub' in k) assert.strictEqual(out.sub && out.sub.level, k.sub, name + ' 2A');
  });
});

test('market structure pages: the PC program (structure.py + kite_intraday.choch_setups) answers as the charts say', () => {
  const list = examples.filter((e) => e.ex.check.type === 'choch');
  assert.ok(list.length >= 4, 'CHoCH + FVG has its pages');
  const py = ['python3', 'python'].find((x) => spawnSync(x, ['--version']).status === 0);
  assert.ok(py, 'python is needed for these checks');
  const code = ['import importlib.util, json, os, sys',
    'd = sys.argv[1]; sys.path.insert(0, d)',
    'spec = importlib.util.spec_from_file_location("ki", os.path.join(d, "kite_intraday.py")); K = importlib.util.module_from_spec(spec); spec.loader.exec_module(K)',
    'from datetime import date, timedelta',
    'out = []',
    'for rows in json.load(sys.stdin):',
    '    cc = [{"t": (date(2026, 1, 1) + timedelta(days=k)).isoformat(), "day": (date(2026, 1, 1) + timedelta(days=k)).isoformat(), "o": r[0], "h": r[1], "l": r[2], "c": r[3], "v": 1e6} for k, r in enumerate(rows)]',
    '    d0 = K.fvg_detail(cc, None, K.WINDOW.get("D", 300)); i = len(cc) - 1',
    '    setups = K.choch_setups(cc, cc, d0, "D", None, "")',
    '    trig = K.choch_trigger(d0, i, True); stage = "notrigger"; zone = None',
    '    if trig:',
    '        st = K.backtest_lab.structure.Structure([c["h"] for c in cc], [c["l"] for c in cc], [c["c"] for c in cc], K.CHOCH_PIVOT_N)',
    '        stage = st.judge(i, trig[0]["f"], trig[0]["top"], cc[i]["c"], [c["c"] for c in cc], K.CHOCH_DOWN_N)["stage"]',
    '        zone = [round(trig[0]["bottom"], 2), round(trig[0]["top"], 2), trig[0]["f"], trig[1]]',
    '    out.append({"setup": i in setups, "stage": stage, "zone": zone, "note": setups[i][1] if i in setups else ""})',
    'print(json.dumps(out))'].join('\n');
  const r = spawnSync(py, ['-c', code, path.join(__dirname, '..', 'pcbridge', 'ScreenerBridge')],
    { input: JSON.stringify(list.map((e) => e.ex.candles)), encoding: 'utf8', timeout: 120000 });
  assert.strictEqual(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  list.forEach(({ ex, name }, k) => {
    const g = got[k];
    assert.strictEqual(g.setup, ex.ok, name + ': ' + JSON.stringify(g));
    if (ex.check.stage) assert.strictEqual(g.stage, ex.check.stage, name + ': ' + JSON.stringify(g));
    // the drawn zone = the zone the entry Spring sat on
    assert.deepStrictEqual(g.zone && [g.zone[0], g.zone[1], g.zone[2], g.zone[3]], [ex.marks.zone.bottom, ex.marks.zone.top, ex.marks.zone.from, 'Spring'], name + ': the drawn zone');
    if (ex.ok) assert.match(g.note, /^Spring · CHoCH \S+ after 3 lower highs \/ lows · first pullback$/, name);
  });
});

test('every pattern the code can tag has a page in the guide (add one with a new pattern)', () => {
  const covered = new Set();
  G.PAGES.forEach((p) => p.tags.forEach((t) => covered.add(t)));
  P.ORDER.forEach((t) => assert.ok(covered.has(t), 'no guide page for the col W pattern "' + t + '" - add it to tools/pattern-guide/examples.js'));
  // col X: every tags.push('<name> ' ...) of web/lib/fvg.js (the port of Code.gs ab_longFvgDetail_ / ab_gapUpTags_)
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'lib', 'fvg.js'), 'utf8');
  const xTags = [...src.matchAll(/(?:tags\.push\(|return )'([A-Za-z0-9+ -]+?) '/g)].map((m) => m[1].trim());
  assert.ok(xTags.length >= 6, JSON.stringify(xTags));
  xTags.forEach((t) => assert.ok(covered.has(t), 'no guide page for the col X pattern "' + t + '" - add it to tools/pattern-guide/examples.js'));
  // every pattern shows at least one VALID and one NOT VALID chart - on its page, or on the page right next to it
  // that continues it (fvgspring -> fvgspring2)
  G.PAGES.forEach((p, i) => {
    const next = G.PAGES[i + 1], prev = G.PAGES[i - 1];
    const cont = (a, b) => a && b && b.id.indexOf(a.id) === 0;
    assert.ok(p.examples.some((e) => !e.ok) || (cont(p, next) && next.examples.some((e) => !e.ok)), p.id + ': a NOT VALID example');
    assert.ok(p.examples.some((e) => e.ok) || (cont(prev, p) && prev.examples.some((e) => e.ok)), p.id + ': a VALID example');
    assert.ok(p.rules.length && p.ta && p.title, p.id + ': title, Tamil text and rules');
  });
});
