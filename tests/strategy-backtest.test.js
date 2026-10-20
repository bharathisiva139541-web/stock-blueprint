'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../web/lib/strategy.js');
const B = require('../web/lib/backtest.js');

function series(n, f) { return Array.from({ length: n }, (_, i) => f(i)).map((c, i) => Object.assign({ t: '2026-01-' + String(i + 1).padStart(2, '0'), v: 1e6 }, c)); }

test('TTM Signal follows the fixed sheet formula', () => {
  assert.strictEqual(S.ttmSignal({ tgt: 120, epsg: 10, ttmEps: 5 }, 100), 'Buy');
  assert.strictEqual(S.ttmSignal({ tgt: 80, epsg: 10, ttmEps: 5 }, 100), 'Avoid');
  assert.strictEqual(S.ttmSignal({ tgt: 120, epsg: -1, ttmEps: 5 }, 100), 'Avoid', 'negative growth forces Avoid');
  assert.strictEqual(S.ttmSignal({ tgt: 120, epsg: 10, ttmEps: 0 }, 100), 'Avoid', 'EPS <= 0 forces Avoid');
  assert.strictEqual(S.ttmSignal({ tgt: 100, epsg: 10, ttmEps: 5 }, 100), '', 'equal -> blank');
  assert.strictEqual(S.ttmSignal({ tgt: null }, 100), '');
});

test('validate rejects bad configs and normalises params', () => {
  const bad = S.validate({ name: 'x', triggers: [], exits: { stop: { method: 'nope' }, target: { method: 'pct', pct: 10 } } });
  assert.strictEqual(bad.ok, false);
  const ok = S.validate(S.PRESETS.sheet);
  assert.strictEqual(ok.ok, true, ok.errors.join(';'));
  assert.strictEqual(ok.config.filters[0].params.minTurnover, 5000000);
});

test('insufficient data and stale series are never signalled', () => {
  const st = [{ sym: 'A' }, { sym: 'B' }];
  const h = { A: series(5, (i) => ({ o: 10, h: 11, l: 9, c: 10 })), B: series(30, (i) => ({ o: 10, h: 11, l: 9, c: 10 })) };
  const out = S.run(S.PRESETS.sheet, st, h, { latestDate: '2026-01-31' });
  assert.strictEqual(out.bySym.A.status, 'insufficient');
  assert.strictEqual(out.bySym.B.status, 'insufficient', 'B ends 2026-01-30 < latest 2026-01-31 -> stale');
});

test('evaluate never reads bars after i (changing the future does not change the signal)', () => {
  const base = series(40, (i) => ({ o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i }));
  const fut = base.map((c, i) => (i > 30 ? Object.assign({}, c, { o: 1, h: 2, l: 0.5, c: 1 }) : c));
  const cfg = S.PRESETS.demo;
  for (const i of [25, 28, 30]) {
    const a = S.evaluate(S.validate(cfg).config, S.buildContext({ sym: 'X' }, base, i, { pointInTime: true }));
    const b = S.evaluate(S.validate(cfg).config, S.buildContext({ sym: 'X' }, fut, i, { pointInTime: true }));
    assert.deepStrictEqual(JSON.stringify(a), JSON.stringify(b), 'bar ' + i);
  }
});

test('every check explains itself and the score is rule satisfaction', () => {
  const c = series(30, (i) => ({ o: 100, h: 101, l: 99, c: 100 }));
  const r = S.evaluate(S.validate(S.PRESETS.sheet).config, S.buildContext({ sym: 'X', tgt: 150, epsg: 20, ttmEps: 5 }, c, 29));
  assert.ok(r.checks.length >= 3);
  r.checks.forEach((k) => assert.ok(typeof k.label === 'string' && k.res && 'pass' in k.res));
  assert.ok(r.score >= 0 && r.score <= 100);
  assert.strictEqual(r.status, 'none');       // flat prices: no trigger fires
});

test('backtest: entries at next open, close-only exits, no trades without signals', () => {
  // a series that breaks out on bar 25 and rallies 15% afterwards
  const c = series(40, (i) => {
    const p = i < 25 ? 100 + Math.sin(i) : 100 + (i - 24) * 2;
    return { o: p - 0.5, h: p + 1, l: p - 1, c: p };
  });
  c[25].v = 5e6;
  const cfg = { name: 'test', filters: [], triggers: [{ id: 'breakout', params: { length: 20, minRelVol: 1.5 } }], confirms: [],
    qualify: { minTriggers: 1 }, universe: { minBars: 21 }, exits: { stop: { method: 'pct', pct: 5 }, target: { method: 'pct', pct: 10 } } };
  const r = B.run(cfg, [{ sym: 'X' }], { X: c }, { capital: 100000, riskPct: 1, costPctPerSide: 0, slippagePct: 0 });
  assert.strictEqual(r.ok, true, (r.errors || []).join(';'));
  assert.ok(r.signals >= 1);
  const t = r.trades[0] || r.open[0];
  assert.ok(t, 'a trade was opened');
  const sigDay = c.findIndex((x) => x.t === (r.trades[0] ? r.trades[0].signalDate : null));
  if (r.trades[0]) {
    assert.strictEqual(r.trades[0].entry, c[sigDay + 1].o, 'filled at the next bar open');
    assert.ok(r.trades[0].exit >= r.trades[0].entry * 1.1 - 1e-9, 'target by close');
  }
  const none = B.run(Object.assign({}, cfg, { triggers: [{ id: 'breakout', params: { length: 20, minRelVol: 99 } }] }), [{ sym: 'X' }], { X: c }, {});
  assert.strictEqual(none.trades.length, 0);
  assert.ok(none.stats.sampleWarning);
});

test('backtest skips fundamentals (no look-ahead) and says so', () => {
  const c = series(30, (i) => ({ o: 100, h: 101, l: 99, c: 100 }));
  const cfg = S.clone(S.PRESETS.sheet);
  cfg.confirms = [{ id: 'ttmBuy', enabled: true }];
  const r = B.run(cfg, [{ sym: 'X', tgt: 200, epsg: 50, ttmEps: 10 }], { X: c }, {});
  assert.ok(r.notes.some((n) => /TTM Signal/.test(n)));
});

test('screen presets (fundamentals only) never trade in a backtest', () => {
  const c = series(30, (i) => ({ o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i }));
  const r = B.run(S.PRESETS.deepValue, [{ sym: 'X', tgt: 500, epsg: 50, ttmEps: 10, pevs: 0.5, up: 80 }], { X: c }, {});
  assert.strictEqual(r.trades.length + r.open.length, 0);
});

test('Smart Dashboard presets match the sheet definitions', () => {
  const ev = (id, st) => S.evaluate(S.validate(S.PRESETS[id]).config, S.buildContext(st, [{ t: '2026-01-01', o: 1, h: 1, l: 1, c: 100 }], 0, { usePrice: true }));
  const base = { sym: 'X', price: 100, tgt: 150, epsg: 20, ttmEps: 5 };
  assert.strictEqual(ev('qualityGrowth', Object.assign({}, base, { opmy: 'Increasing', opmq: 'Slightly Increasing', qrev: 10 })).status, 'qualified');
  assert.strictEqual(ev('qualityGrowth', Object.assign({}, base, { opmy: 'Increasing', opmq: 'Stagnant', qrev: 10 })).status, 'none');
  assert.strictEqual(ev('smartMoney', Object.assign({}, base, { fii: 'Increasing', promo: 'Stagnant' })).status, 'qualified');
  assert.strictEqual(ev('deepValue', Object.assign({}, base, { pevs: 0.8, up: 20 })).status, 'qualified', 'bounds inclusive');
  assert.strictEqual(ev('deepValue', Object.assign({}, base, { pevs: 0.81, up: 20 })).status, 'none');
  assert.strictEqual(ev('volumeBreakout', Object.assign({}, base, { volchg: 100 })).status, 'qualified');
  assert.strictEqual(ev('beatenDown', Object.assign({}, base, { opmq: 'Aggressive Increase', down52: -30 })).status, 'qualified');
  assert.strictEqual(ev('beatenDown', Object.assign({}, base, { opmq: 'Aggressive Increase', down52: null })).status, 'none', 'missing value fails');
});
