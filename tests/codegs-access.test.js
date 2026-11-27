'use strict';
// Website access (owner, 28-Nov-2026: "I don't want this website public now. i want to give access to only authorized
// persons" - an access code per person, 3 devices each): Code2.gs tab 'Website Access', menu "Website access: add a
// person", doPost action 'access' ops login / renew / logout (the site feed's token), the device limit, untick Active /
// Reset Devices / a new code, the wrong-code lock.
const test = require('node:test');
const assert = require('node:assert/strict');
const mock = require('./fixtures/apps-script-mock');

const T0 = Date.UTC(2026, 10, 28, 5, 0);     // 28-Nov-2026 10:30 IST
const FEED = 'feed-token-123';
const DEV = (n) => 'dev' + String(n).padStart(2, '0') + 'abcdefghijklmnopq';

function load(extra) {
  return mock.loadCodeGs({ sheets: [{ name: 'Main', rows: [[], ['SYMBOL']] }] },
    Object.assign({ now: T0, props: { AB_FEED_TOKEN: FEED, AB_BRIDGE_TOKEN: 'bridge-token' } }, extra || {}));
}
const acc = (env, body) => env.post(Object.assign({ token: FEED, action: 'access' }, body));
function headOf(env) { return env.sheet('Website Access').rows[1].map(String); }
function cell(env, row, name) { return env.sheet('Website Access').rows[row - 1][headOf(env).indexOf(name)]; }
function setCell(env, row, name, v) { env.sheet('Website Access').rows[row - 1][headOf(env).indexOf(name)] = v; }
function withPerson(name) {
  const env = load({ prompts: [name || 'Siva'] });
  env.call('runWebsiteAccessAdd');
  const code = String(cell(env, 3, 'Access Code'));
  return { env, code };
}

test('menu: a person is added with a new 8-character code, Active, 3 devices; the alert gives the code', () => {
  const { env, code } = withPerson('Siva');
  assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  const t = env.sheet('Website Access');
  assert.match(String(t.rows[0][0]), /only the access codes here open the website/);
  assert.deepEqual(headOf(env).slice(0, 10), ['Name', 'Access Code', 'Active', 'Max Devices', 'Devices', 'Last Used',
    'Days Used', 'Added', 'Reset Devices', 'Device Data']);
  assert.equal(cell(env, 3, 'Name'), 'Siva');
  assert.equal(cell(env, 3, 'Active'), true);
  assert.equal(cell(env, 3, 'Max Devices'), 3);
  assert.equal(cell(env, 3, 'Device Data'), '[]');
  const alert = env.alerts.at(-1).join('\n');
  assert.ok(alert.indexOf(code) >= 0 && /up to 3 devices/.test(alert), alert);
  // a second person gets another code
  const e2 = load({ prompts: ['A', 'B'] });
  e2.call('runWebsiteAccessAdd');
  e2.call('runWebsiteAccessAdd');
  assert.notEqual(cell(e2, 3, 'Access Code'), cell(e2, 4, 'Access Code'));
  assert.match(e2.prompts.at(-1).join('\n'), /Persons who can open the website now: 1/);
  // Cancel / no name: nothing
  const e3 = load({ prompts: [null] });
  e3.call('runWebsiteAccessAdd');
  assert.equal(e3.sheet('Website Access').rows.length, 2);
});

test('only the feed token; login with the code (any case) registers the device; renew and logout', () => {
  const { env, code } = withPerson('Siva');
  assert.equal(acc(env, { op: 'login', code, dev: DEV(1), token: 'bridge-token' }).error, 'bad token');
  assert.equal(acc(env, { op: 'nope', dev: DEV(1) }).error, 'unknown op');
  assert.equal(acc(env, { op: 'login', code, dev: 'short' }).code, 'bad');
  const a = acc(env, { op: 'login', code: code.toLowerCase(), dev: DEV(1), label: 'Android phone <b>' });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.match(a.pid, /^[0-9a-f]{16}$/);
  assert.equal(a.name, 'Siva');
  assert.equal(a.used, 1);
  assert.match(String(cell(env, 3, 'Devices')), /^1 of 3: Android phone b \(last 28-11 10:30\)$/);
  assert.equal(cell(env, 3, 'Days Used'), 1);
  // the same device again: no second slot
  assert.equal(acc(env, { op: 'login', code, dev: DEV(1) }).used, 1);
  assert.equal(acc(env, { op: 'renew', pid: a.pid, dev: DEV(1) }).ok, true);
  assert.equal(acc(env, { op: 'renew', pid: a.pid, dev: DEV(2) }).code, 'gone', 'a device never signed in');
  assert.equal(acc(env, { op: 'renew', pid: '0123456789abcdef', dev: DEV(1) }).code, 'gone');
  // the next day: Days Used counts the day once
  env.setNow(T0 + 86400000);
  acc(env, { op: 'renew', pid: a.pid, dev: DEV(1) });
  acc(env, { op: 'renew', pid: a.pid, dev: DEV(1) });
  assert.equal(cell(env, 3, 'Days Used'), 2);
  assert.equal(acc(env, { op: 'logout', pid: a.pid, dev: DEV(1) }).ok, true);
  assert.equal(cell(env, 3, 'Device Data'), '[]');
  assert.equal(acc(env, { op: 'renew', pid: a.pid, dev: DEV(1) }).code, 'gone', 'signed out');
});

test('3 devices at most; Reset Devices frees them; untick Active and a new code close the website', () => {
  const { env, code } = withPerson('Friend');
  const pid = acc(env, { op: 'login', code, dev: DEV(1) }).pid;
  acc(env, { op: 'login', code, dev: DEV(2) });
  assert.equal(acc(env, { op: 'login', code, dev: DEV(3) }).used, 3);
  const r4 = acc(env, { op: 'login', code, dev: DEV(4) });
  assert.equal(r4.code, 'devices');
  assert.match(r4.error, /already used on 3 device/);
  // Max Devices 4 in the tab
  setCell(env, 3, 'Max Devices', 4);
  assert.equal(acc(env, { op: 'login', code, dev: DEV(4) }).used, 4);
  // Reset Devices: the next renew says so and frees every device; the box is unticked
  setCell(env, 3, 'Reset Devices', true);
  assert.equal(acc(env, { op: 'renew', pid, dev: DEV(1) }).code, 'reset');
  assert.equal(cell(env, 3, 'Reset Devices'), false);
  assert.equal(acc(env, { op: 'renew', pid, dev: DEV(2) }).code, 'gone');
  assert.equal(acc(env, { op: 'login', code, dev: DEV(5) }).used, 1);
  // untick Active
  setCell(env, 3, 'Active', false);
  assert.equal(acc(env, { op: 'renew', pid, dev: DEV(5) }).code, 'off');
  assert.equal(acc(env, { op: 'login', code, dev: DEV(5) }).code, 'off');
  setCell(env, 3, 'Active', true);
  assert.equal(acc(env, { op: 'renew', pid, dev: DEV(5) }).ok, true);
  // a new code typed by the owner: the old sessions are gone, the new code works
  setCell(env, 3, 'Access Code', 'NEWCODE77');
  assert.equal(acc(env, { op: 'renew', pid, dev: DEV(5) }).code, 'gone');
  assert.equal(acc(env, { op: 'login', code, dev: DEV(5) }).code, 'wrong');
  const n = acc(env, { op: 'login', code: 'newcode77', dev: DEV(5) });
  assert.equal(n.ok, true);
  assert.notEqual(n.pid, pid);
});

test('wrong codes: counted, 30 in an hour lock every login for 30 minutes (renewals go on)', () => {
  const { env, code } = withPerson('Siva');
  const pid = acc(env, { op: 'login', code, dev: DEV(1) }).pid;
  for (let i = 0; i < 29; i++) assert.equal(acc(env, { op: 'login', code: 'WRONG' + i + 'XX', dev: DEV(2) }).code, 'wrong');
  assert.equal(acc(env, { op: 'login', code: 'WRONGLAST', dev: DEV(2) }).code, 'wrong');
  const l = acc(env, { op: 'login', code, dev: DEV(2) });
  assert.equal(l.code, 'locked');
  assert.match(l.error, /try again in 30 min/);
  assert.equal(acc(env, { op: 'renew', pid, dev: DEV(1) }).ok, true, 'a signed-in device goes on');
  env.setNow(T0 + 31 * 60000);
  assert.equal(acc(env, { op: 'login', code, dev: DEV(2) }).ok, true);
});

test('no list yet / blank rows / a deleted column / the sheet busy', () => {
  const env = load();
  assert.equal(acc(env, { op: 'login', code: 'ABCDEFGH', dev: DEV(1) }).code, 'wrong');
  assert.equal(env.sheet('Website Access'), null, 'a login never makes the tab');
  const { env: e2, code } = withPerson('Siva');
  e2.sheet('Website Access').rows.splice(2, 0, []);           // a blank row above the person
  assert.equal(acc(e2, { op: 'login', code, dev: DEV(1) }).ok, true);
  // the owner deleted the Days Used header: it comes back at the end, the login still works
  const h = headOf(e2);
  e2.sheet('Website Access').rows[1][h.indexOf('Days Used')] = '';
  assert.equal(acc(e2, { op: 'login', code, dev: DEV(2) }).ok, true);
  assert.ok(headOf(e2).indexOf('Days Used') >= 10, headOf(e2).join('|'));
  const busy = load({ lockBusy: true, prompts: ['X'] });
  busy.call('runWebsiteAccessAdd');
  assert.equal(acc(busy, { op: 'login', code: String(cell(busy, 3, 'Access Code')), dev: DEV(1) }).code, 'busy');
});
