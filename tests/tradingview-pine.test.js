'use strict';
// The TradingView indicator (tradingview/StockBlueprint_CHoCH_FVG.pine; owner, 11-Nov-2026: "i open trading view chart and
// i go to that trade date. i check how our backtest enter the trade, how our backtest where it is marked Choch, FVG ... it
// would be helpful if i got pinescript indicator"): its bar-by-bar logic (tradingview/pine_model.py) finds exactly what
// the laptop's backtest finds (structure.py CHoCH events, kite_intraday zones + first touches, the Lab's discount rule) on
// random and made charts; the .pine's defaults = the Lab's; Pine v5 layout checks. Offline: tests/fixtures/tradingview_pine_check.py.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const py = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);

test('TradingView indicator = the laptop backtest (python, offline)', { skip: !py && 'python3 not installed' }, () => {
  const r = spawnSync(py, [path.join(__dirname, 'fixtures', 'tradingview_pine_check.py')], { encoding: 'utf8', timeout: 240000 });
  assert.strictEqual(r.status, 0, (r.stdout || '').slice(-1500) + (r.stderr || '').slice(-1500));
  assert.ok(/(^|\n)OK\s*$/.test(r.stdout), r.stdout.slice(-500));
});
