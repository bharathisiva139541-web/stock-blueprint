'use strict';
// Custom watchlists - data rules (web/lib/watchlists.js): create / rename / delete,
// no duplicate names or stocks, several symbols at once, search, sort, and loading
// whatever was stored (bad data is cleaned, never trusted).
const test = require('node:test');
const assert = require('node:assert');
const M = require('../web/lib/watchlists.js');

const T0 = Date.UTC(2026, 9, 27, 10, 0);

test('create, rename and delete watchlists; names are unique (case and spaces ignored)', () => {
  let s = M.empty();
  const a = M.create(s, '  Swing   trades ', T0);
  assert.ok(!a.error);
  s = a.state;
  assert.strictEqual(a.list.name, 'Swing trades');
  assert.strictEqual(s.last, a.list.id, 'the new list is selected');
  assert.match(M.create(s, 'swing TRADES').error, /already exists/);
  assert.match(M.create(s, '   ').error, /name/);
  assert.match(M.create(s, 'x'.repeat(61)).error, /60 characters/);
  const b = M.create(s, 'Long term', T0 + 1);
  s = b.state;
  assert.notStrictEqual(a.list.id, b.list.id, 'ids are unique');
  assert.match(M.rename(s, b.list.id, 'swing trades').error, /already exists/);
  assert.ok(!M.rename(s, a.list.id, 'SWING TRADES').error, 'a list may change the case of its own name');
  s = M.rename(s, b.list.id, 'Long-term holds', T0 + 2).state;
  assert.strictEqual(M.get(s, b.list.id).name, 'Long-term holds');
  const before = s;
  s = M.remove(s, b.list.id);
  assert.strictEqual(s.lists.length, 1);
  assert.strictEqual(before.lists.length, 2, 'the old state is not changed');
  assert.strictEqual(M.remove(M.create(M.empty(), 'One').state, M.create(M.empty(), 'One').state.lists[0].id).last, null);
});

test('stocks: no duplicates in a list, the same stock in many lists, several symbols at once', () => {
  let s = M.create(M.empty(), 'A', T0).state;
  const a = s.lists[0].id;
  s = M.create(s, 'B', T0 + 1).state;
  const b = s.lists[1].id;
  let r = M.add(s, a, ' tcs ');
  assert.strictEqual(r.added, true);
  s = r.state;
  r = M.add(s, a, 'TCS');
  assert.strictEqual(r.added, false, 'already there');
  assert.strictEqual(r.state, s, 'nothing changed');
  s = M.add(s, b, 'NSE:TCS').state;
  assert.deepStrictEqual(M.listsWith(s, 'tcs').map((l) => l.name), ['A', 'B']);
  assert.ok(M.has(s, 'TCS') && !M.has(s, 'INFY'));
  assert.match(M.add(s, a, 'not a symbol!').error, /not a stock symbol/);
  const m = M.addMany(s, a, 'infy, TCS sbin;; bajaj-auto M&M ??? infy 500325');
  assert.deepStrictEqual(m.added, ['INFY', 'SBIN', 'BAJAJ-AUTO', 'M&M']);
  assert.deepStrictEqual(m.dup, ['TCS', 'INFY']);
  assert.deepStrictEqual(m.bad, ['???', '500325'], 'a BSE code is not an NSE symbol');
  assert.ok(M.validSym('3MINDIA') && M.validSym('360ONE') && M.validSym('m&m'));
  s = m.state;
  assert.deepStrictEqual(M.get(s, a).syms, ['TCS', 'INFY', 'SBIN', 'BAJAJ-AUTO', 'M&M']);
  s = M.removeSym(s, a, 'sbin');
  assert.deepStrictEqual(M.get(s, a).syms, ['TCS', 'INFY', 'BAJAJ-AUTO', 'M&M']);
  const t1 = M.toggle(s, b, 'TCS');
  assert.strictEqual(t1.added, false);
  assert.deepStrictEqual(M.get(t1.state, b).syms, []);
  const t2 = M.toggle(t1.state, b, 'TCS');
  assert.strictEqual(t2.added, true);
  // thousands of stocks in one list (every Main stock fits: at most 2,000 - the sheet keeps no more)
  let big = M.create(M.empty(), 'Big').state;
  const id = big.lists[0].id;
  const many = M.addMany(big, id, Array.from({ length: 2003 }, (_, i) => 'S' + i).join(' '));
  big = many.state;
  assert.strictEqual(M.get(big, id).syms.length, 2000);
  assert.deepStrictEqual(many.full, ['S2000', 'S2001', 'S2002']);
  assert.deepStrictEqual(many.bad, []);
});

test('search by watchlist name or by a symbol inside; sort', () => {
  let s = M.empty();
  ['Swing trades', 'Long term', 'Banks'].forEach((n, i) => { s = M.create(s, n, T0 + i * 1000).state; });
  const [sw, lt, bk] = s.lists.map((l) => l.id);
  s = M.addMany(s, sw, 'TCS INFY', T0 + 5000).state;
  s = M.addMany(s, bk, 'SBIN HDFCBANK ICICIBANK', T0 + 4000).state;
  s = M.add(s, lt, 'TCS', T0 + 3000).state;
  assert.deepStrictEqual(M.search(s, 'term').map((x) => [x.list.name, x.by]), [['Long term', 'name']]);
  assert.deepStrictEqual(M.search(s, 'tcs').map((x) => [x.list.name, x.by, x.syms]), [['Swing trades', 'symbol', ['TCS']], ['Long term', 'symbol', ['TCS']]]);
  assert.deepStrictEqual(M.search(s, 'hdfc').map((x) => x.list.name), ['Banks']);
  assert.strictEqual(M.search(s, '').length, 3);
  assert.deepStrictEqual(M.search(s, 'zzz'), []);
  assert.deepStrictEqual(M.sort(s.lists, 'name').map((l) => l.name), ['Banks', 'Long term', 'Swing trades']);
  assert.deepStrictEqual(M.sort(s.lists, 'count').map((l) => l.name), ['Banks', 'Swing trades', 'Long term']);
  assert.deepStrictEqual(M.sort(s.lists, 'recent').map((l) => l.name), ['Swing trades', 'Banks', 'Long term']);
});

test('load: stored data is cleaned (bad lists, duplicate names / ids / stocks, unknown selection)', () => {
  assert.deepStrictEqual(M.load(null), M.empty());
  assert.deepStrictEqual(M.load('garbage'), M.empty());
  assert.deepStrictEqual(M.load({ lists: 'x' }), M.empty());
  const s = M.load({ v: 1, last: 'nope', lists: [
    { id: 'a', name: ' Swing ', syms: ['tcs', 'TCS', 'bad sym', 7, null, 'INFY'] },
    { id: 'a', name: 'Same id' },
    { id: 'b', name: 'swing' },
    { id: 'c', name: '' },
    null,
    { id: 'd', name: 'Banks', syms: 'SBIN' }
  ] });
  assert.deepStrictEqual(s.lists.map((l) => [l.id, l.name, l.syms]), [['a', 'Swing', ['TCS', 'INFY']], ['d', 'Banks', []]]);
  assert.strictEqual(s.last, 'a', 'an unknown selection falls back to the first list');
  // a saved state survives JSON (what localStorage keeps) unchanged
  const again = M.load(JSON.parse(JSON.stringify(s)));
  assert.deepStrictEqual(again, s);
});

// ---------- sync (web/ui/watchlist-sync.js): this browser's lists + the sheet's ----------
const L = (id, name, syms, updated) => ({ id: id, name: name, syms: syms, created: '2026-10-27T10:00:00.000Z', updated: updated || '2026-10-27T10:00:00.000Z' });
const S = (lists, last) => M.load({ v: 1, lists: lists, last: last });
const view = (s) => s.lists.map((l) => l.name + ': ' + l.syms.join(' '));

test('merge, first time on a device (no base): both sides put together; the same name -> one list', () => {
  const here = S([L('w1', 'Swing', ['TCS', 'INFY']), L('w2', 'Mine only', ['SBIN'])], 'w2');
  const sheet = S([L('x1', 'swing', ['INFY', 'HDFCBANK']), L('x2', 'Banks', ['ICICIBANK'])]);
  const m = M.merge(null, here, sheet);
  assert.deepStrictEqual(view(m), ['swing: INFY HDFCBANK TCS', 'Banks: ICICIBANK', 'Mine only: SBIN']);
  assert.strictEqual(m.last, 'w2', 'the open list stays this browser\'s');
  assert.ok(!M.same(m, sheet));
  assert.deepStrictEqual(view(M.merge(null, M.empty(), sheet)), view(sheet), 'a new device takes the sheet\'s lists');
  assert.ok(M.same(M.merge(null, M.empty(), sheet), sheet));
  assert.deepStrictEqual(view(M.merge(null, here, M.empty())), view(here), 'an empty sheet takes this browser\'s lists');
});

test('merge with a base: stocks added / removed on both sides all count; renames and deletes travel', () => {
  const base = S([L('a', 'Swing', ['TCS', 'INFY', 'SBIN']), L('b', 'Banks', ['HDFCBANK']), L('c', 'Old', ['ITC'])]);
  // here: +WIPRO -SBIN in Swing, Banks renamed, Old deleted
  const here = S([L('a', 'Swing', ['TCS', 'INFY', 'WIPRO'], '2026-10-29T10:00:00.000Z'), L('b', 'Private banks', ['HDFCBANK'])]);
  // the phone: +LT -TCS in Swing, a new list, Old untouched
  const sheet = S([L('a', 'Swing', ['INFY', 'SBIN', 'LT'], '2026-10-29T11:00:00.000Z'), L('b', 'Banks', ['HDFCBANK', 'AXISBANK']), L('c', 'Old', ['ITC']), L('d', 'Phone', ['ONGC'])]);
  const m = M.merge(base, here, sheet);
  assert.deepStrictEqual(view(m), ['Swing: INFY LT WIPRO', 'Private banks: HDFCBANK AXISBANK', 'Phone: ONGC']);
  assert.strictEqual(M.get(m, 'a').updated, '2026-10-29T11:00:00.000Z', 'the later change time');
  // deleted on the other side
  assert.deepStrictEqual(view(M.merge(base, base, S([L('a', 'Swing', ['TCS', 'INFY', 'SBIN'])]))), ['Swing: TCS INFY SBIN']);
  // ... but changed here since: kept (nothing is lost)
  const changedHere = S([L('a', 'Swing', ['TCS', 'INFY', 'SBIN']), L('b', 'Banks', ['HDFCBANK', 'KOTAKBANK']), L('c', 'Old', ['ITC'])]);
  assert.deepStrictEqual(view(M.merge(base, changedHere, S([L('a', 'Swing', ['TCS', 'INFY', 'SBIN'])]))), ['Swing: TCS INFY SBIN', 'Banks: HDFCBANK KOTAKBANK']);
  // deleted here, changed on the other side since: kept
  const sheet2 = S([L('a', 'Swing', ['TCS', 'INFY', 'SBIN']), L('b', 'Banks', ['HDFCBANK']), L('c', 'Old', ['ITC', 'VEDL'])]);
  assert.deepStrictEqual(view(M.merge(base, S([L('a', 'Swing', ['TCS', 'INFY', 'SBIN']), L('b', 'Banks', ['HDFCBANK'])]), sheet2)),
    ['Swing: TCS INFY SBIN', 'Banks: HDFCBANK', 'Old: ITC VEDL']);
  // nothing changed anywhere
  assert.ok(M.same(M.merge(base, base, base), base));
});

test('merge after the sheet answered: changes made here meanwhile are kept on top of what the sheet holds', () => {
  // the browser sent `sent`; while waiting it added NTPC to Swing; the sheet holds `sent` (+ the phone's list)
  const sent = S([L('a', 'Swing', ['TCS'])]);
  const now = S([L('a', 'Swing', ['TCS', 'NTPC'])]);
  const sheet = S([L('a', 'Swing', ['TCS']), L('p', 'Phone', ['ONGC'])]);
  const m = M.merge(sent, now, sheet);
  assert.deepStrictEqual(view(m), ['Swing: TCS NTPC', 'Phone: ONGC']);
  assert.ok(!M.same(m, sheet), 'so the next sync sends NTPC');
});

test('same() looks at ids, names and stocks only; strip() is what goes to the sheet', () => {
  const a = S([L('a', 'A', ['TCS'], '2026-10-27T10:00:00.000Z'), L('b', 'B', [])], 'b');
  const b = S([L('b', 'B', []), L('a', 'A', ['TCS'], '2026-10-29T10:00:00.000Z')], 'a');
  assert.ok(M.same(a, b));
  assert.ok(!M.same(a, S([L('a', 'A', ['TCS', 'INFY']), L('b', 'B', [])])));
  assert.ok(!M.same(a, S([L('a', 'A', ['TCS']), L('b', 'B2', [])])));
  assert.ok(M.same(null, M.empty()));
  assert.deepStrictEqual(M.strip(a), { v: 1, lists: a.lists });
  assert.ok(!('last' in M.strip(a)));
});

test('limits shared with the sheet: 200 watchlists, 2,000 stocks each', () => {
  let s = M.empty();
  for (let i = 0; i < M.MAX_LISTS; i++) s = M.create(s, 'L' + i, T0 + i).state;
  assert.match(M.create(s, 'one more').error, /200 watchlists/);
  const syms = [];
  for (let i = 0; i < M.MAX_SYMS; i++) syms.push('S' + i);
  let t = M.load({ lists: [{ id: 'w1', name: 'Big', syms: syms.concat(['EXTRA']) }] });
  assert.strictEqual(t.lists[0].syms.length, M.MAX_SYMS);
  assert.match(M.add(t, 'w1', 'TCS').error, /at most 2000 stocks/);
  t = M.load({ lists: [{ id: 'bad id', name: 'X' }, { id: 'w-1_ok', name: 'Y', created: 'yesterday', updated: '2026-10-28T10:00:00.000Z' }] });
  assert.deepStrictEqual(t.lists.map((l) => [l.id, l.created, l.updated]), [['w-1_ok', '', '2026-10-28T10:00:00.000Z']]);
});
