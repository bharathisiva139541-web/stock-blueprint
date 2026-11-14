'use strict';
// PC bridge: the big Kite / Backtest Lab data on another drive (pcbridge/ScreenerBridge/data_place.py, MoveDataToD.bat;
// owner, 14-Nov-2026: "yes i want the datas to be in D drive. apo than c drive la konjam spaces irukum"): where the data
// is / should be, the move file by file, a move cut off and finished later, a failed move put back, the drive checks,
// the datafolder command and the background program moving FIRST: tests/fixtures/pcbridge_dataplace_check.py.
// Skipped without python3.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const py = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);
const DIR = path.join(__dirname, '..', 'pcbridge', 'ScreenerBridge');

test('PC bridge data folder (python, offline)', { skip: !py && 'python3 not installed' }, () => {
  const r = spawnSync(py, [path.join(__dirname, 'fixtures', 'pcbridge_dataplace_check.py')], { encoding: 'utf8', timeout: 120000 });
  assert.strictEqual(r.status, 0, (r.stdout || '').slice(-1500) + (r.stderr || '').slice(-1500));
  assert.ok(/(^|\n)OK\s*$/.test(r.stdout), r.stdout.slice(-500));
});

test('MoveDataToD.bat: Windows line ends, runs the datafolder command', () => {
  const bat = fs.readFileSync(path.join(DIR, 'MoveDataToD.bat'), 'utf8');
  assert.ok(!/[^\r]\n/.test(bat) && bat.endsWith('\r\n'), 'CRLF line ends');
  assert.match(bat, /screener_bridge\.py datafolder %\*/);
  assert.match(bat, /D:\\StockBlueprintData/);
});

test('the per-laptop place files are never committed', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  for (const f of ['data_place.json', 'data_moving.json']) assert.ok(gi.includes('pcbridge/ScreenerBridge/' + f), f);
});
