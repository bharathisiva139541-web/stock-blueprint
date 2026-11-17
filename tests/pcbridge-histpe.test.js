'use strict';
// PC bridge (pcbridge/ScreenerBridge/pe_history.py): the Historical PE - median PE 1Y / 3Y / 5Y + the 5-year peak of every
// stock from the Kite daily closes / screener.in's EPS (owner, 17-Nov-2026), offline: see
// tests/fixtures/pcbridge_histpe_check.py. Skipped without python3.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const py = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);

test('PC bridge Historical PE (python, offline)', { skip: !py && 'python3 not installed' }, () => {
  const r = spawnSync(py, [path.join(__dirname, 'fixtures', 'pcbridge_histpe_check.py')], { encoding: 'utf8', timeout: 240000 });
  assert.strictEqual(r.status, 0, (r.stdout || '').slice(-1500) + (r.stderr || '').slice(-1500));
  assert.ok(/(^|\n)OK\s*$/.test(r.stdout), r.stdout.slice(-500));
});
