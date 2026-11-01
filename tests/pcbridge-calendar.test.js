'use strict';
// PC bridge (pcbridge/ScreenerBridge/screener_bridge.py): NSE's forthcoming "Financial Results" meetings (Equity + SME)
// sent to the sheet once a day, offline: see
// tests/fixtures/pcbridge_calendar_check.py. Skipped without python3.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const py = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);

test('PC bridge results calendar (python, offline)', { skip: !py && 'python3 not installed' }, () => {
  const r = spawnSync(py, [path.join(__dirname, 'fixtures', 'pcbridge_calendar_check.py')], { encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(r.status, 0, (r.stdout || '').slice(-1500) + (r.stderr || '').slice(-1500));
  assert.ok(/(^|\n)OK\s*$/.test(r.stdout), r.stdout.slice(-500));
});
