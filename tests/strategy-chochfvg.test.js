'use strict';
// CHoCH + FVG (owner, 10-Nov-2026: "when market structure formed Choch in downtrend, i check is there any FVG formed in
// this move ... if the price mitigated the FVG with FVG pattern or spring candlestick pattern, i enter the trade ... add this
// strategy to Pattern & FVG page and strategy settings"): the PC program finds the setups on Zerodha Kite candles and
// sends them to the sheet's Intraday Patterns tab (pattern 'CHoCH + FVG'); the feed part intraday -> chochIndex ->
// stock.choch -> rule chochFvg / preset chochFvg.
const test = require('node:test');
const assert = require('node:assert');
const S = require('../web/lib/strategy.js');

const COLS = ['Session', 'Symbol', 'Company', 'Timeframe', 'Pattern', 'Candle', 'FVG Formed', 'FVG Detail'];
const TABLE = { cols: COLS, rows: [
  ['2026-11-09', 'ABC', 'Abc Ltd', 'D', 'CHoCH + FVG', '2026-11-09', '2026-10-28', 'FVG middle (touch 1) · Spring · CHoCH 2026-10-30 after 3 lower highs / lows · first pullback'],
  ['2026-11-06', 'ABC', 'Abc Ltd', '4H', 'CHoCH + FVG', '2026-11-06 13:15', '2026-11-03 09:15', 'FVG · FVG First Touch · CHoCH 2026-11-04 09:15 after 3 lower highs / lows · first pullback'],
  ['2026-11-09', 'ABC', 'Abc Ltd', 'D', 'Spring in FVG', '2026-11-09', '2026-10-28', 'FVG middle (touch 1)'],
  ['2026-11-02', 'xyz', 'Xyz Ltd', 'W', 'CHoCH + FVG', '2026-10-26', '2026-09-07', 'Gap-up top (touch 1) · Spring · CHoCH 2026-09-28 after 4 lower highs / lows · first pullback']
] };

function candles(n) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const t = new Date(Date.UTC(2026, 9, 1 + k)).toISOString().slice(0, 10);
    out.push({ t: t, o: 100 + k, h: 102 + k, l: 99 + k, c: 101 + k, v: 200000 });
  }
  return out;
}

test('chochIndex: the CHoCH + FVG rows of the Intraday Patterns feed part, per stock, newest first', () => {
  const ix = S.chochIndex(TABLE);
  assert.deepStrictEqual(Object.keys(ix).sort(), ['ABC', 'XYZ']);
  assert.deepStrictEqual(ix.ABC.map((r) => r.tf + ' ' + r.candle), ['D 2026-11-09', '4H 2026-11-06 13:15'], 'newest first; other patterns left out');
  assert.match(ix.ABC[0].detail, /CHoCH 2026-10-30 after 3 lower highs/);
  assert.deepStrictEqual(S.chochIndex(null), {});
  assert.deepStrictEqual(S.chochIndex({ cols: COLS }), {});
});

test('the preset: a valid setup strategy with the chochFvg trigger (not used in the website\'s own backtests)', () => {
  const P = S.PRESETS.chochFvg;
  const v = S.validate(P);
  assert.ok(v.ok, v.errors.join('; '));
  assert.deepStrictEqual([v.config.mode, v.config.style, v.config.triggers.map((r) => r.id)], ['setup', 'swing', ['chochFvg']]);
  assert.strictEqual(S.CONDITIONS.chochFvg.pit, false);
  assert.strictEqual(S.label(v.config.triggers[0]), 'CHoCH + FVG setup on 3 selected, found at most 1 trading day(s) before today');
  assert.ok(P.assumptions.length >= 3 && /Backtest Lab/.test(P.description));
});

test('the rule: a setup on a chosen timeframe found today / yesterday qualifies; older or other timeframes do not', () => {
  const ix = S.chochIndex(TABLE);
  const stocks = [{ sym: 'ABC', price: 130, choch: ix.ABC }, { sym: 'XYZ', price: 50, choch: ix.XYZ }, { sym: 'NONE', price: 10, choch: null }];
  const hist = { ABC: candles(40), XYZ: candles(40), NONE: candles(40) };
  const r = S.run(S.PRESETS.chochFvg, stocks, hist, { refDate: '2026-11-10' });
  assert.strictEqual(r.bySym.ABC.triggersPassed.length, 1, JSON.stringify(r.bySym.ABC.checks));
  const chk = r.bySym.ABC.checks.find((c) => c.id === 'chochFvg');
  assert.match(chk.res.detail, /^D candle 2026-11-09 \(1 trading day ago\) - FVG middle \(touch 1\) · Spring · CHoCH 2026-10-30/);
  assert.ok(['qualified', 'watch'].indexOf(r.bySym.ABC.status) >= 0, r.bySym.ABC.status);
  assert.strictEqual(r.bySym.XYZ.checks.find((c) => c.id === 'chochFvg').res.pass, false, 'the weekly setup is 6 trading days old');
  assert.match(r.bySym.NONE.checks.find((c) => c.id === 'chochFvg').res.detail, /no CHoCH \+ FVG setup/);
  // only the weekly chart, 10 days back: XYZ passes, ABC (D / 4H only) does not
  const cfg = S.clone(S.PRESETS.chochFvg);
  cfg.triggers[0].params = { tfs: ['W'], days: 10 };
  const r2 = S.run(cfg, stocks, hist, { refDate: '2026-11-10' });
  assert.strictEqual(r2.bySym.XYZ.checks.find((c) => c.id === 'chochFvg').res.pass, true);
  assert.match(r2.bySym.ABC.checks.find((c) => c.id === 'chochFvg').res.detail, /^a setup only on D, 4H/);
  // a backtest (point in time) does not use it
  const x = S.buildContext(stocks[0], hist.ABC, 39, { pointInTime: true });
  const e = S.evaluate(S.PRESETS.chochFvg, x);
  assert.match(e.checks.find((c) => c.id === 'chochFvg').res.detail, /not used in backtests/);
});
