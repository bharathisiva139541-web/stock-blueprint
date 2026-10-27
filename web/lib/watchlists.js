/* Custom watchlists - data model (browser + Node, no DOM, no storage).
   The page code (web/ui/watchlists.js) keeps the state in this browser's
   localStorage; every function here takes a state and returns a NEW state,
   so a failed save never leaves a half-changed list behind.

   state = { v: 1, lists: [{ id, name, syms: ['TCS', ...], created, updated }], last: id | null }

   SB.wlModel = {
     empty(), load(raw)                      -> a clean state (bad / unknown input is dropped)
     normSym(s), validSym(s)                  -> 'TCS' / true
     nameError(state, name, exceptId)         -> null or the reason the name cannot be used
     create(state, name, now)                 -> { state, list } | { error }
     rename(state, id, name, now)             -> { state } | { error }
     remove(state, id)                        -> state
     add(state, id, sym, now)                 -> { state, added } | { error }   (no duplicates in a list)
     addMany(state, id, text, now)            -> { state, added: [], dup: [], bad: [] }
     removeSym(state, id, sym, now)           -> state
     toggle(state, id, sym, now)              -> { state, added } | { error }
     listsWith(state, sym), has(state, sym), get(state, id)
     search(state, query)                     -> [{ list, by: 'name' | 'symbol', syms }]
     sort(lists, how)                         -> 'name' | 'count' | 'recent'
   } */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.SB = root.SB || /** @type {any} */ ({})).wlModel = factory();
})(/** @type {any} */ (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  var NAME_MAX = 60;
  var SYM_RE = /^[A-Z0-9][A-Z0-9&_.-]{0,29}$/;
  /** NSE symbols: letters, digits and & _ . - and at least one letter (3MINDIA, M&M, BAJAJ-AUTO). */
  function isSym(x) { return SYM_RE.test(x) && /[A-Z]/.test(x); }

  function empty() { return { v: 1, lists: [], last: null }; }
  function clone(s) { return JSON.parse(JSON.stringify(s)); }
  function nowIso(now) { return (now ? new Date(now) : new Date()).toISOString(); }
  function normSym(s) { return String(s == null ? '' : s).trim().toUpperCase().replace(/^NSE:/, ''); }
  function validSym(s) { return isSym(normSym(s)); }
  function cleanName(n) { return String(n == null ? '' : n).replace(/\s+/g, ' ').trim(); }
  function key(n) { return cleanName(n).toLowerCase(); }

  /** Whatever was stored -> a clean state: valid ids / names / symbols only, no duplicates. */
  function load(raw) {
    var out = empty();
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.lists)) return out;
    var ids = {}, names = {};
    raw.lists.forEach(function (l) {
      if (!l || typeof l !== 'object') return;
      var id = String(l.id || '');
      var name = cleanName(l.name).slice(0, NAME_MAX);
      if (!id || ids[id] || !name || names[key(name)]) return;
      var seen = {}, syms = [];
      (Array.isArray(l.syms) ? l.syms : []).forEach(function (s) {
        var x = normSym(s);
        if (isSym(x) && !seen[x]) { seen[x] = 1; syms.push(x); }
      });
      ids[id] = 1; names[key(name)] = 1;
      out.lists.push({ id: id, name: name, syms: syms, created: String(l.created || ''), updated: String(l.updated || '') });
    });
    out.last = ids[raw.last] ? String(raw.last) : (out.lists[0] ? out.lists[0].id : null);
    return out;
  }

  function get(state, id) {
    for (var i = 0; i < state.lists.length; i++) if (state.lists[i].id === id) return state.lists[i];
    return null;
  }
  function nameError(state, name, exceptId) {
    var n = cleanName(name);
    if (!n) return 'Give the watchlist a name.';
    if (n.length > NAME_MAX) return 'Use at most ' + NAME_MAX + ' characters.';
    var k = key(n);
    for (var i = 0; i < state.lists.length; i++) {
      if (state.lists[i].id !== exceptId && key(state.lists[i].name) === k) return 'A watchlist called "' + state.lists[i].name + '" already exists.';
    }
    return null;
  }
  function newId(state, now) {
    var base = 'w' + (now || Date.now()).toString(36), id = base, n = 1;
    while (get(state, id)) id = base + '-' + (n++);
    return id;
  }

  function create(state, name, now) {
    var err = nameError(state, name);
    if (err) return { error: err };
    var s = clone(state), t = nowIso(now);
    var list = { id: newId(state, now), name: cleanName(name), syms: [], created: t, updated: t };
    s.lists.push(list);
    s.last = list.id;
    return { state: s, list: list };
  }
  function rename(state, id, name, now) {
    if (!get(state, id)) return { error: 'That watchlist no longer exists.' };
    var err = nameError(state, name, id);
    if (err) return { error: err };
    var s = clone(state), l = get(s, id);
    l.name = cleanName(name);
    l.updated = nowIso(now);
    return { state: s };
  }
  function remove(state, id) {
    var s = clone(state);
    s.lists = s.lists.filter(function (l) { return l.id !== id; });
    if (s.last === id) s.last = s.lists[0] ? s.lists[0].id : null;
    return s;
  }
  function add(state, id, sym, now) {
    var x = normSym(sym);
    if (!isSym(x)) return { error: '"' + String(sym).trim() + '" is not a stock symbol.' };
    if (!get(state, id)) return { error: 'That watchlist no longer exists.' };
    if (get(state, id).syms.indexOf(x) >= 0) return { state: state, added: false };
    var s = clone(state), l = get(s, id);
    l.syms.push(x);
    l.updated = nowIso(now);
    s.last = id;
    return { state: s, added: true };
  }
  /** Several symbols at once ("TCS, INFY sbin") - each counted as added / already there / not a symbol. */
  function addMany(state, id, text, now) {
    var out = { state: state, added: [], dup: [], bad: [] };
    String(text || '').split(/[\s,;]+/).filter(Boolean).forEach(function (t) {
      var r = add(out.state, id, t, now);
      if (r.error) out.bad.push(String(t));
      else if (r.added) { out.state = r.state; out.added.push(normSym(t)); }
      else if (out.dup.indexOf(normSym(t)) < 0) out.dup.push(normSym(t));
    });
    return out;
  }
  function removeSym(state, id, sym, now) {
    var x = normSym(sym), l0 = get(state, id);
    if (!l0 || l0.syms.indexOf(x) < 0) return state;
    var s = clone(state), l = get(s, id);
    l.syms = l.syms.filter(function (y) { return y !== x; });
    l.updated = nowIso(now);
    return s;
  }
  function toggle(state, id, sym, now) {
    var l = get(state, id);
    if (l && l.syms.indexOf(normSym(sym)) >= 0) return { state: removeSym(state, id, sym, now), added: false };
    return add(state, id, sym, now);
  }
  function listsWith(state, sym) {
    var x = normSym(sym);
    return state.lists.filter(function (l) { return l.syms.indexOf(x) >= 0; });
  }
  function has(state, sym) { return listsWith(state, sym).length > 0; }

  /** Watchlists whose name contains the query, or that hold a symbol starting with it. */
  function search(state, query) {
    var q = cleanName(query).toLowerCase(), qs = normSym(query);
    if (!q) return state.lists.map(function (l) { return { list: l, by: 'all', syms: [] }; });
    var out = [];
    state.lists.forEach(function (l) {
      if (l.name.toLowerCase().indexOf(q) >= 0) { out.push({ list: l, by: 'name', syms: [] }); return; }
      var syms = l.syms.filter(function (x) { return x.indexOf(qs) === 0; });
      if (syms.length) out.push({ list: l, by: 'symbol', syms: syms });
    });
    return out;
  }
  function sort(lists, how) {
    var a = lists.slice();
    var name = function (x, y) { return x.name.localeCompare(y.name, 'en', { sensitivity: 'base', numeric: true }); };
    if (how === 'count') a.sort(function (x, y) { return y.syms.length - x.syms.length || name(x, y); });
    else if (how === 'recent') a.sort(function (x, y) { return (y.updated || '').localeCompare(x.updated || '') || name(x, y); });
    else a.sort(name);
    return a;
  }

  return {
    NAME_MAX: NAME_MAX, empty: empty, load: load, normSym: normSym, validSym: validSym, nameError: nameError, get: get,
    create: create, rename: rename, remove: remove, add: add, addMany: addMany, removeSym: removeSym, toggle: toggle,
    listsWith: listsWith, has: has, search: search, sort: sort
  };
});
