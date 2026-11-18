'use strict';
// PC bridge (pcbridge/ScreenerBridge/xbrl_history.py): 5 years of quarterly + yearly results from NSE's XBRL filings, the files
// kept on the laptop, the table like screener.in's (owner, 18-Nov-2026), offline: see tests/fixtures/pcbridge_xbrlhist_check.py.
// Skipped without python3.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const py = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);

test('PC bridge NSE XBRL 5-year history (python, offline)', { skip: !py && 'python3 not installed' }, () => {
  const r = spawnSync(py, [path.join(__dirname, 'fixtures', 'pcbridge_xbrlhist_check.py')], { encoding: 'utf8', timeout: 240000 });
  assert.strictEqual(r.status, 0, (r.stdout || '').slice(-1500) + (r.stderr || '').slice(-1500));
  assert.ok(/(^|\n)OK\s*$/.test(r.stdout), r.stdout.slice(-500));
});
