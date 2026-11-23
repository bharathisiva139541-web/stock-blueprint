'use strict';
// PC bridge (pcbridge/ScreenerBridge/eps_target.py): the EPS Growth Target Lab - the sheet's target (TTM EPS x EPS growth
// %) of every stock and quarter, the results dates from NSE, the entry and what the Kite candles did after it (owner,
// 23-Nov-2026), offline: see tests/fixtures/pcbridge_epstarget_check.py. Skipped without python3.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const py = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);

test('PC bridge EPS Growth Target Lab (python, offline)', { skip: !py && 'python3 not installed' }, () => {
  const r = spawnSync(py, [path.join(__dirname, 'fixtures', 'pcbridge_epstarget_check.py')], { encoding: 'utf8', timeout: 240000 });
  assert.strictEqual(r.status, 0, (r.stdout || '').slice(-1500) + (r.stderr || '').slice(-1500));
  assert.ok(/(^|\n)OK\s*$/.test(r.stdout), r.stdout.slice(-500));
});
