'use strict';
// The PC's auto update (owner, 16-Nov-2026: "You itself place the code to the script and copy and paste file to Screenerbridge
// folder. here after i won't do this job"): pcbridge/ScreenerBridge/self_update.py gets GitHub's newest version into the
// laptop's folder (checked, all or none, backed up) and the sheet's Code / Code2 into the Apps Script project (the web app's
// own deployment moved to a new version), after a one-time Google login; the background program restarts itself when its
// files changed - tests/fixtures/pcbridge_update_check.py (offline). Plus the sheet's side (Code.gs action 'scriptid') and
// the wiring in screener_bridge.py. The python part is skipped without python3.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const mock = require('./fixtures/apps-script-mock.js');

const py = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);
const DIR = path.join(__dirname, '..', 'pcbridge', 'ScreenerBridge');

test('PC auto update (python, offline)', { skip: !py && 'python3 not installed' }, () => {
  const r = spawnSync(py, [path.join(__dirname, 'fixtures', 'pcbridge_update_check.py')], { encoding: 'utf8', timeout: 120000 });
  assert.strictEqual(r.status, 0, (r.stdout || '').slice(-1500) + (r.stderr || '').slice(-1500));
  assert.ok(/(^|\n)OK\s*$/.test(r.stdout), r.stdout.slice(-500));
});

test('UpdateNow.bat / GoogleLogin.bat: Windows line ends, their commands', () => {
  for (const [bat, cmd] of [['UpdateNow.bat', 'update'], ['GoogleLogin.bat', 'googlelogin']]) {
    const s = fs.readFileSync(path.join(DIR, bat), 'utf8');
    assert.ok(!/[^\r]\n/.test(s) && s.endsWith('\r\n'), bat + ': CRLF line ends');
    assert.match(s, new RegExp('screener_bridge\\.py ' + cmd + '\\)'));
  }
});

test('the laptop\'s Google login key, update state and backups are never committed', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  for (const p of ['google_session.json', 'update_state.json', '_update_backup/', '_update_new/']) {
    assert.ok(gi.includes('pcbridge/ScreenerBridge/' + p), p);
  }
});

test('screener_bridge.py: the background loop checks / restarts, the update + googlelogin commands, TestConnection line 10', () => {
  const s = fs.readFileSync(path.join(DIR, 'screener_bridge.py'), 'utf8');
  assert.match(s, /import self_update as UPD/);
  assert.match(s, /updater\.restart_due\(busy\)[\s\S]{0,400}restart_self\(\)[\s\S]{0,80}updater\.maybe_check\(cfg, api, online=internet_ok\)/);
  assert.match(s, /def restart_self\(\):[\s\S]{0,400}os\.remove\(LOOP_PATH\)[\s\S]{0,400}'login'[\s\S]{0,120}os\._exit\(0\)/);
  assert.match(s, /if cmd == 'update':/);
  assert.match(s, /if cmd == 'googlelogin':/);
  assert.match(s, /print\('10\) ' \+ UPD\.status_line\(\)\)/);
});

test('Code.gs action scriptid: which Apps Script project the web app is (bridge token only)', () => {
  const e = mock.loadCodeGs({ sheets: [{ name: 'Main', rows: [['x'], ['SYMBOL']] }] }, { props: { AB_BRIDGE_TOKEN: 'bridge-token-0123456789' } });
  assert.deepStrictEqual(e.post({ token: 'bridge-token-0123456789', action: 'scriptid' }), { ok: true, scriptId: 'test-script-id-0123456789abcdef' });
  assert.deepStrictEqual(e.post({ token: 'wrong', action: 'scriptid' }), { ok: false, error: 'bad token' });
});
