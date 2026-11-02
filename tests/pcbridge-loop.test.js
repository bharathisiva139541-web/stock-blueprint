'use strict';
// PC bridge (pcbridge/ScreenerBridge/screener_bridge.py): the background program after log-in - the results check every
// 30 minutes (owner, 02-Nov-2026: NSE XBRL first, no time limit), full rounds at log-in, an hour later and every 3 hours,
// sleep / no internet handled, one program per log-in - offline, on a fake clock: tests/fixtures/pcbridge_loop_check.py.
// Skipped without python3.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const py = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);

test('PC bridge background program: 30-minute results check + full rounds (python, offline)', { skip: !py && 'python3 not installed' }, () => {
  const r = spawnSync(py, [path.join(__dirname, 'fixtures', 'pcbridge_loop_check.py')], { encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(r.status, 0, (r.stdout || '').slice(-1500) + (r.stderr || '').slice(-1500));
  assert.ok(/(^|\n)OK\s*$/.test(r.stdout), r.stdout.slice(-500));
});
