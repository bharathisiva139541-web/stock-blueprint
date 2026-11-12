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

// owner, 12-Nov-2026 (IREDA: "when i set strategy setting.. IREDA stock is not qualified. i don't know why"): the CHoCH had
// formed and the discount zone was below, price had not come back yet - the rule still fails, its detail says so
test('waiting for the pullback: chochWaitIndex (feed part chochWait) -> the rule\'s detail explains why it is not qualified yet', () => {
  const W = { cols: ['Symbol', 'Company', 'Timeframe', 'CHoCH Candle', 'CHoCH Level', 'Lower Highs / Lows', 'Final Low', 'Final Low On', 'Move High', '50% Line',
    'Zone Kind', 'Zone Bottom', 'Zone Top', 'Zone Formed', 'Zone Depth %', 'Last Close', 'Last Candle', 'Distance %', 'More Zones Below'],
  rows: [['IREDA', 'IREDA Ltd', 'D', '2026-11-09', 117.39, 4, 98.78, '2026-10-26', 123.99, 111.39, 'FVG', 104.1, 108.24, '2026-10-29', 83, 119.25, '2026-11-11', 9.23, 0],
    ['IREDA', 'IREDA Ltd', 'W', '2026-11-09', 117.39, 3, 98.78, '2026-10-26', 123.99, 111.39, 'Gap-up', 100.5, 102, '2026-10-26', 95, 119.25, '2026-11-09', 14.47, 0]] };
  const wi = S.chochWaitIndex(W);
  assert.deepStrictEqual(wi.IREDA[0], { tf: 'D', choch: '2026-11-09', level: 117.39, bottom: 104.1, top: 108.24, dist: 9.23, depth: 83, kind: 'FVG',
    pct: null, buy: null, stopAt: null, how: '' }, 'an older sheet: no size / buy-at columns');
  assert.deepStrictEqual(S.chochWaitIndex(null), {});
  const stocks = [{ sym: 'IREDA', price: 119.25, choch: null, chochWait: wi.IREDA }];
  const r = S.run(S.PRESETS.chochFvg, stocks, { IREDA: candles(40) }, { refDate: '2026-11-12' });
  const chk = r.bySym.IREDA.checks.find((c) => c.id === 'chochFvg');
  assert.strictEqual(chk.res.pass, false);
  assert.strictEqual(chk.res.detail, 'no CHoCH + FVG setup in the last 30 days of your PC\'s scans; waiting for the pullback: D CHoCH 2026-11-09, discount zone 104.1 - 108.24 ' +
    '- 9.2% below the last close; W CHoCH 2026-11-09, discount zone 100.5 - 102 - 14.5% below the last close - it qualifies on the day price touches it');
  // 12-Nov-2026: the zone size, where the order waits (the Gap-up zone top inside the FVG / the zone's Fib line) and the size limits
  const W2 = { cols: W.cols.slice(0, 15).concat(['Zone %', 'Buy At', 'Stop Under', 'Entry'], W.cols.slice(15)),
    rows: [W.rows[0].slice(0, 15).concat([3.98, 107.4, 104.1, 'buy order at the Gap-up zone top (inside the FVG)'], W.rows[0].slice(15)),
      W.rows[1].slice(0, 15).concat([12.4, 101.1, 100.5, 'Spring / Harami + Inverted Hammer at the zone\'s 61.8% line'], W.rows[1].slice(15))] };
  const wi2 = S.chochWaitIndex(W2);
  assert.deepStrictEqual([wi2.IREDA[0].pct, wi2.IREDA[0].buy, wi2.IREDA[0].stopAt], [3.98, 107.4, 104.1]);
  const d2 = S.run(S.PRESETS.chochFvg, [{ sym: 'IREDA', price: 119.25, choch: null, chochWait: wi2.IREDA }], { IREDA: candles(40) }, { refDate: '2026-11-12' })
    .bySym.IREDA.checks.find((c) => c.id === 'chochFvg').res.detail;
  assert.match(d2, /D CHoCH 2026-11-09, discount zone 104\.1 - 108\.24 \(4% tall\), buy order at the Gap-up zone top \(inside the FVG\) 107\.4 - 9\.2% below the last close/);
  assert.match(d2, /W CHoCH 2026-11-09, discount zone 100\.5 - 102 \(12\.4% tall\), Spring \/ Harami \+ Inverted Hammer at the zone's 61\.8% line 101\.1/);
  const sized = JSON.parse(JSON.stringify(S.PRESETS.chochFvg));
  sized.triggers[0].params.zoneMin = 2; sized.triggers[0].params.zoneMax = 10;
  const d3 = S.run(sized, [{ sym: 'IREDA', price: 119.25, choch: null, chochWait: wi2.IREDA }], { IREDA: candles(40) }, { refDate: '2026-11-12' })
    .bySym.IREDA.checks.find((c) => c.id === 'chochFvg').res.detail;
  assert.match(d3, /^no CHoCH \+ FVG setup \(zone size 2 - 10%\) in the last 30 days.*D CHoCH/);
  assert.doesNotMatch(d3, /W CHoCH/, 'the 12.4% zone is outside 2 - 10%');
  // an older setup on the same stock: the detail says both
  const ix = S.chochIndex(TABLE);
  const r2 = S.run(S.PRESETS.chochFvg, [{ sym: 'ABC', price: 130, choch: ix.ABC, chochWait: wi.IREDA.slice(0, 1) }], { ABC: candles(40) }, { refDate: '2026-11-20' });
  assert.match(r2.bySym.ABC.checks.find((c) => c.id === 'chochFvg').res.detail, /^D candle 2026-11-09 \(9 trading days ago\) - .*; waiting for the pullback: D CHoCH 2026-11-09/);
  // a setup row's zone size from its note (12-Nov-2026 scans: '· zone 4.3% tall'); outside the limits = left out
  const T2 = { cols: TABLE.cols, rows: TABLE.rows.map((r) => r.slice()) };
  const di = T2.cols.indexOf('FVG Detail');
  T2.rows.forEach((r) => { r[di] = String(r[di] || '') + ' · zone 12.5% tall'; });
  const ix2 = S.chochIndex(T2);
  assert.strictEqual(ix2.ABC[0].zpct, 12.5);
  const sized2 = JSON.parse(JSON.stringify(S.PRESETS.chochFvg));
  sized2.triggers[0].params.zoneMax = 10; sized2.triggers[0].params.days = 30;
  const r3 = S.run(sized2, [{ sym: 'ABC', price: 130, choch: ix2.ABC }], { ABC: candles(40) }, { refDate: '2026-11-12' });
  assert.strictEqual(r3.bySym.ABC.checks.find((c) => c.id === 'chochFvg').res.pass, false);
});
