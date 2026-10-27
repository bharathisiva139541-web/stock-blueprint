'use strict';
// tools/export_xlsx.py ipo_tracker() matches Code.gs ab_site_ipoTracker_ (the saved copy and the
// live feed carry the same IPO Tracker JSON) - see tests/fixtures/export_ipo_tracker_check.py.
// Skipped when python3 or openpyxl is not installed.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const py = ['python3', 'python'].find((p) => spawnSync(p, ['-c', 'import openpyxl']).status === 0);

test('export_xlsx.py ipo_tracker (python)', { skip: !py && 'python3 with openpyxl not installed' }, () => {
  const r = spawnSync(py, [path.join(__dirname, 'fixtures', 'export_ipo_tracker_check.py')], { encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(r.status, 0, (r.stdout || '').slice(-1500) + (r.stderr || '').slice(-1500));
  assert.ok(/(^|\n)OK\s*$/.test(r.stdout), r.stdout.slice(-500));
});
