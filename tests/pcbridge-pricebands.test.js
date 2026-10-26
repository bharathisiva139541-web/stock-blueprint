'use strict';
// PC bridge (pcbridge/ScreenerBridge/screener_bridge.py): NSE price band download,
// day selection, catch-up, address fallback and sheet replies - offline, see
// tests/fixtures/pcbridge_pricebands_check.py. Skipped when python3 is not installed.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const py = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);

test('PC bridge price bands (python, offline)', { skip: !py && 'python3 not installed' }, () => {
  const r = spawnSync(py, [path.join(__dirname, 'fixtures', 'pcbridge_pricebands_check.py')], { encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(r.status, 0, (r.stdout || '').slice(-1500) + (r.stderr || '').slice(-1500));
  assert.ok(/\nOK\s*$/.test(r.stdout), r.stdout.slice(-500));
});
