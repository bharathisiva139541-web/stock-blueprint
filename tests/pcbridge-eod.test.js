'use strict';
// PC bridge (pcbridge/ScreenerBridge/screener_bridge.py): NSE end-of-day files - full bhavcopy
// (Delivery % + market counts), 52-week high report, price band list (circuits) - parsed, counted
// and sent day by day, offline: see tests/fixtures/pcbridge_eod_check.py. Skipped without python3.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const py = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);

test('PC bridge NSE end-of-day (python, offline)', { skip: !py && 'python3 not installed' }, () => {
  const r = spawnSync(py, [path.join(__dirname, 'fixtures', 'pcbridge_eod_check.py')], { encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(r.status, 0, (r.stdout || '').slice(-1500) + (r.stderr || '').slice(-1500));
  assert.ok(/(^|\n)OK\s*$/.test(r.stdout), r.stdout.slice(-500));
});
