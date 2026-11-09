'use strict';
// PC bridge Backtest Lab (pcbridge/ScreenerBridge/backtest_lab.py; owner, 09-Nov-2026: "I need a platform to backtest
// with my customized idea ... stoploss slightly below the FVG area ... minimum 2R ... catch the maximum move within weeks;
// days, stoploss, risk, returns all customizable"): the rules of one trade (stop under the zone / Spring low / lower /
// x %, the target, breakeven, trail under the last N lows / x % / EMA, the time limit, costs), the groups, the account
// (risk per trade, at most N at once), the cache made by the backtest pass (= the backtest's own signals) and the
// background worker (poll -> run -> result / fail). Offline: tests/fixtures/pcbridge_lab_check.py. Skipped without python3.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const py = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);

test('PC bridge Backtest Lab (python, offline)', { skip: !py && 'python3 not installed' }, () => {
  const r = spawnSync(py, [path.join(__dirname, 'fixtures', 'pcbridge_lab_check.py')], { encoding: 'utf8', timeout: 240000 });
  assert.strictEqual(r.status, 0, (r.stdout || '').slice(-1500) + (r.stderr || '').slice(-1500));
  assert.ok(/(^|\n)OK\s*$/.test(r.stdout), r.stdout.slice(-500));
});
