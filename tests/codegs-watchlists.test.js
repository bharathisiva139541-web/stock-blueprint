'use strict';
// The website's My Watchlists kept in the sheet (Code2.gs ab_wlFromSite_, doPost action 'watchlists'):
// the owner's PIN (menu "My Watchlists sync: set / change PIN", stored salted + hashed), the lock
// after wrong PINs, compare-and-swap saves (base revision -> 'conflict'), the hidden tab's
// layout (parts of 45,000 characters), and the same cleaning rules as web/lib/watchlists.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const mock = require('./fixtures/apps-script-mock');
const M = require('../web/lib/watchlists.js');

const T0 = Date.UTC(2026, 9, 29, 10, 0);   // 29-Oct-2026 15:30 IST
const FEED = 'feed-token-123';
const PIN = 'Blue2026';
const plain = (v) => JSON.parse(JSON.stringify(v));

function load(extra) {
  return mock.loadCodeGs({ sheets: [{ name: 'Main', rows: [[], ['SYMBOL']] }] },
    Object.assign({ now: T0, props: { AB_FEED_TOKEN: FEED, AB_BRIDGE_TOKEN: 'bridge-token' } }, extra || {}));
}
function withPin(extra) {
  const env = load(Object.assign({ prompts: [PIN, PIN] }, extra || {}));
  env.call('runWatchlistPinSetup');
  return env;
}
const wl = (env, body) => env.post(Object.assign({ token: FEED, action: 'watchlists', pin: PIN }, body));
const LISTS = [
  { id: 'wa1', name: 'Swing trades', syms: ['TCS', 'INFY'], created: '2026-10-27T10:00:00.000Z', updated: '2026-10-28T10:00:00.000Z' },
  { id: 'wb2', name: 'Long term', syms: ['HDFCBANK'], created: '2026-10-27T11:00:00.000Z', updated: '2026-10-27T11:00:00.000Z' }
];

test('menu: the PIN is typed twice, kept only as a salted hash; bad / different PINs change nothing', () => {
  const env = withPin();
  const stored = env.props.getProperty('AB_WL_PIN');
  assert.match(stored, /^[0-9a-f]{32}:[0-9a-f]{64}$/);
  assert.ok(stored.indexOf(PIN) < 0, 'never the PIN itself');
  assert.match(env.alerts.at(-1).join('\n'), /PIN saved[\s\S]*My Watchlists > type this PIN > Connect/);
  assert.match(env.prompts[0].join('\n'), /No lists kept yet[\s\S]*6 to 20 letters or digits/);

  const e2 = load({ prompts: ['12 34', 'x'] });
  e2.call('runWatchlistPinSetup');
  assert.equal(e2.props.getProperty('AB_WL_PIN'), null);
  assert.match(e2.alerts.at(-1).join('\n'), /must be 6 to 20 letters or digits/);
  const e3 = load({ prompts: ['abc123456', 'abc12345'] });
  e3.call('runWatchlistPinSetup');
  assert.equal(e3.props.getProperty('AB_WL_PIN'), null);
  assert.match(e3.alerts.at(-1).join('\n'), /two PINs were different/);
  const e4 = load({ prompts: [null] });
  e4.call('runWatchlistPinSetup');
  assert.equal(e4.props.getProperty('AB_WL_PIN'), null);
  assert.equal(e4.alerts.length, 0, 'Cancel: nothing');
});

test('only the website feed token + the PIN open the lists', () => {
  const env = load();
  assert.equal(wl(env, { op: 'get' }).error, 'no PIN set yet - sheet menu 3 > My Watchlists sync: set / change PIN');
  const e = withPin();
  assert.equal(wl(e, { op: 'get', token: 'bridge-token' }).error, 'bad token');
  assert.equal(wl(e, { op: 'get', token: '' }).error, 'bad token');
  assert.equal(wl(e, { op: 'nope' }).error, 'unknown op');
  assert.equal(wl(e, { op: 'get', pin: 'blue2026' }).error, 'wrong PIN', 'capital and small letters differ');
  assert.equal(wl(e, { op: 'get', pin: undefined }).error, 'wrong PIN');
  assert.deepEqual(plain(wl(e, { op: 'get' })), { ok: true, result: 'ok', rev: 0, savedAt: '', state: { v: 1, lists: [] } });
  assert.equal(e.sheet('Site_Watchlists'), null, 'a read makes no tab');
  assert.equal(load({ lockBusy: true, prompts: [PIN, PIN] }).post({ token: FEED, action: 'watchlists', op: 'get', pin: PIN }).error,
    'sheet busy - try again');
});

test('put: saved on top of the revision read last, else a conflict with the current lists', () => {
  const env = withPin();
  const reads0 = env.reads.length;            // (loading the code reads the Control Panel)
  const r1 = wl(env, { op: 'put', base: 0, state: { v: 1, lists: LISTS } });
  assert.equal(r1.ok, true);
  assert.equal(r1.result, 'ok');
  assert.equal(r1.rev, 1);
  assert.equal(r1.savedAt, '2026-10-29 15:30:00');
  assert.deepEqual(plain(r1.state.lists), LISTS);
  const tab = env.sheet('Site_Watchlists');
  assert.ok(tab.hidden, 'a hidden tab');
  assert.match(tab.rows[0][0], /My Watchlists of the website/);
  assert.deepEqual(JSON.parse(tab.rows[1][0].slice(1)), { rev: 1, savedAt: '2026-10-29 15:30:00', parts: 1, chars: JSON.stringify({ v: 1, lists: LISTS }).length });
  assert.equal(tab.rows[2][0], 'J' + JSON.stringify({ v: 1, lists: LISTS }));
  assert.deepEqual(plain(wl(env, { op: 'get' })), plain(r1));

  // another device that read revision 0 saves: refused, gets the current lists
  const c = wl(env, { op: 'put', base: 0, state: { v: 1, lists: [] } });
  assert.equal(c.result, 'conflict');
  assert.equal(c.rev, 1);
  assert.deepEqual(plain(c.state.lists), LISTS);
  assert.equal(wl(env, { op: 'put', state: { v: 1, lists: [] } }).result, 'conflict', 'no base = conflict');
  // the same lists again: nothing written, same revision
  env.setNow(T0 + 60000);
  const same = wl(env, { op: 'put', base: 1, state: { v: 1, lists: LISTS } });
  assert.equal(same.rev, 1);
  assert.equal(same.savedAt, '2026-10-29 15:30:00');
  const r2 = wl(env, { op: 'put', base: 1, state: { v: 1, lists: [LISTS[1]] } });
  assert.equal(r2.rev, 2);
  assert.equal(r2.savedAt, '2026-10-29 15:31:00');
  assert.deepEqual(plain(wl(env, { op: 'get' }).state.lists), [LISTS[1]]);
  assert.deepEqual(env.reads.slice(reads0).filter((n) => n !== 'Site_Watchlists'), [], 'no other tab is read');
});

test('big lists go in parts of 45,000 characters; more than 400,000 characters are refused', () => {
  const env = withPin();
  const syms = [];
  for (let i = 0; i < 2000; i++) syms.push('STOCK' + i + 'X');
  const lists = [];
  for (let i = 0; i < 8; i++) lists.push({ id: 'w' + i, name: 'List ' + i, syms: syms.slice(), created: '', updated: '' });
  const r = wl(env, { op: 'put', base: 0, state: { v: 1, lists: lists } });
  assert.equal(r.rev, 1, r.error);
  const text = JSON.stringify({ v: 1, lists: lists });
  const tab = env.sheet('Site_Watchlists');
  const meta = JSON.parse(tab.rows[1][0].slice(1));
  assert.equal(meta.parts, Math.ceil(text.length / 45000));
  assert.ok(meta.parts >= 3, meta.parts);
  tab.rows.slice(2, 2 + meta.parts).forEach((row, i) => {
    assert.equal(row[0].charAt(0), 'J');
    assert.ok(row[0].length <= 45001, 'a cell holds at most 50,000 characters');
    assert.equal(row[0].slice(1), text.slice(i * 45000, (i + 1) * 45000));
  });
  assert.deepEqual(plain(wl(env, { op: 'get' }).state.lists), lists);
  // a smaller save clears the parts left over
  const r2 = wl(env, { op: 'put', base: 1, state: { v: 1, lists: [LISTS[0]] } });
  assert.equal(r2.rev, 2);
  assert.deepEqual(env.sheet('Site_Watchlists').rows.slice(3, 2 + meta.parts).map((x) => x[0]), new Array(meta.parts - 1).fill(''));
  assert.deepEqual(plain(wl(env, { op: 'get' }).state.lists), [LISTS[0]]);

  for (let i = 8; i < 30; i++) lists.push({ id: 'w' + i, name: 'List ' + i, syms: syms.slice(), created: '', updated: '' });
  assert.equal(wl(env, { op: 'put', base: 2, state: { v: 1, lists: lists } }).error, 'watchlists too big to keep');
  assert.equal(wl(env, { op: 'get' }).rev, 2, 'kept as it was');

  // a tab edited by hand is never taken for "no lists" (the browsers would then delete theirs)
  env.sheet('Site_Watchlists').rows[2][0] = 'J{"v":1,"lis';
  assert.match(wl(env, { op: 'get' }).error, /could not be read - unreadable/);
  assert.match(wl(env, { op: 'put', base: 2, state: { v: 1, lists: [] } }).error, /unreadable/);
});

test('wrong PINs: locked after 5 in a row (the right PIN too), 15 min then twice as long; a new PIN unlocks', () => {
  const env = withPin();
  for (let i = 0; i < 4; i++) assert.equal(wl(env, { op: 'get', pin: 'guess' + i }).error, 'wrong PIN');
  assert.equal(wl(env, { op: 'get', pin: 'guess4' }).error, 'wrong PIN - PIN locked for 15 min');
  assert.equal(wl(env, { op: 'get' }).error, 'PIN locked for 15 min', 'the right PIN is refused while locked');
  env.setNow(T0 + 10 * 60000);
  assert.equal(wl(env, { op: 'get', pin: 'guess5' }).error, 'PIN locked for 5 min', 'not counted while locked');
  env.setNow(T0 + 15 * 60000 + 1);
  for (let i = 0; i < 4; i++) assert.equal(wl(env, { op: 'get', pin: 'again' + i }).error, 'wrong PIN');
  assert.equal(wl(env, { op: 'get', pin: 'again4' }).error, 'wrong PIN - PIN locked for 30 min');
  env.setNow(T0 + 46 * 60000);
  assert.equal(wl(env, { op: 'get' }).ok, true, 'the right PIN after the lock');
  assert.equal(env.props.getProperty('AB_WL_FAILS'), null, 'and the count starts again');
  for (let i = 0; i < 5; i++) wl(env, { op: 'get', pin: 'x' + i });
  assert.match(wl(env, { op: 'get' }).error, /PIN locked/);
  const e2 = withPin();
  e2.props.setProperty('AB_WL_FAILS', env.props.getProperty('AB_WL_FAILS'));
  assert.match(wl(e2, { op: 'get' }).error, /PIN locked/);
  // the owner sets the PIN again in the sheet
  const e3 = load({ prompts: ['NewPin77', 'NewPin77'] });
  e3.props.setProperty('AB_WL_FAILS', env.props.getProperty('AB_WL_FAILS'));
  e3.call('runWatchlistPinSetup');
  assert.equal(e3.props.getProperty('AB_WL_FAILS'), null);
  assert.equal(wl(e3, { op: 'get', pin: 'NewPin77' }).ok, true);
  assert.equal(wl(e3, { op: 'get' }).error, 'wrong PIN', 'the old PIN no longer works');
});

test('the sheet cleans the lists exactly like the website (web/lib/watchlists.js load)', () => {
  const env = withPin();
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const SYMS = ['TCS', 'tcs', ' infy ', 'NSE:SBIN', 'M&M', 'BAJAJ-AUTO', '3MINDIA', '500325', '???', '', null, 7, 'A'.repeat(31), 'HDFC BANK'];
  const NAMES = ['Swing', 'swing ', '  Long   term ', '', null, 'x'.repeat(70), 'Watch', 'WATCH', 42];
  const IDS = ['w1', 'w2', 'w2', 'bad id', '', null, 'w' + 'x'.repeat(45), 'w3-1', 'w_4', 5];
  const TIMES = ['2026-10-28T10:00:00.000Z', '2026-10-28T10:00:00Z', 'yesterday', '', null, '2026-10-28 10:00'];
  for (let round = 0; round < 40; round++) {
    const lists = [];
    const n = Math.floor(rnd() * 8);
    for (let i = 0; i < n; i++) {
      const syms = [];
      const k = Math.floor(rnd() * 8);
      for (let j = 0; j < k; j++) syms.push(pick(SYMS));
      lists.push(rnd() < 0.05 ? 'junk' : { id: pick(IDS), name: pick(NAMES), syms: rnd() < 0.1 ? 'TCS' : syms, created: pick(TIMES), updated: pick(TIMES) });
    }
    const raw = { v: 1, lists: lists };
    assert.deepEqual(plain(env.call('ab_wlClean_', JSON.parse(JSON.stringify(raw)))), M.load(raw).lists, JSON.stringify(raw));
  }
  // the limits: 200 lists, 2,000 stocks
  const many = [];
  for (let i = 0; i < 210; i++) many.push({ id: 'w' + i, name: 'L' + i, syms: [] });
  const syms = [];
  for (let i = 0; i < 2100; i++) syms.push('S' + i);
  many[0].syms = syms;
  const a = plain(env.call('ab_wlClean_', { lists: many }));
  assert.equal(a.length, 200);
  assert.equal(a[0].syms.length, 2000);
  assert.deepEqual(a, M.load({ lists: many }).lists);
  assert.deepEqual(plain(env.call('ab_wlClean_', null)), []);
  assert.deepEqual(plain(env.call('ab_wlClean_', { lists: 'x' })), []);
});
