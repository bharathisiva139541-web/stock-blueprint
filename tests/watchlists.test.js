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
  // unlimited: thousands of stocks in one list
  let big = M.create(M.empty(), 'Big').state;
  const id = big.lists[0].id;
  big = M.addMany(big, id, Array.from({ length: 3000 }, (_, i) => 'S' + i).join(' ')).state;
  assert.strictEqual(M.get(big, id).syms.length, 3000);
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
