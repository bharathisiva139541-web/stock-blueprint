/* Results & corporate events - the stock lists behind the Results page's tiles and bars
   (#results/<kind>), from the sheet's Results Performance and Results Tracker tabs.
   Pure functions, browser + Node (tests/results-lists.test.js).

   SB.results = {
     KINDS: [{ id, label, src: 'perf' | 'tracker', sort: { key, dir } }],
     seasonOf(perf)                 -> 'Sep 2026' | null (the newest season the sheet summarises)
     perfRows(perf, season)         -> Results Performance rows (objects) of that season
     trackerRows(tracker, season)   -> Results Tracker rows (objects) of that season
     session(row)                   -> 'after' | 'market' | 'before' | '' from the 'Announced' text
                                       ('29/10 17:05 After market'; a closed-day filing counts as after market)
     pick(kind, perfRows, trackerRows) -> the rows of one list
     counts(perfRows, trackerRows)  -> { kind: n }
     bySession(perfRows)            -> [{ id, label, count, avgDay, avgSince }] (after, market, before, unknown)
     movers(perfRows, n)            -> { best: [rows], worst: [rows] } by % Since Results
   } */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.SB = root.SB || /** @type {any} */ ({})).results = factory();
})(/** @type {any} */ (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  var SINCE = '% Since Results', DAY = 'Result Day %';
  var KINDS = [
    { id: 'tracked', label: 'All results this season', src: 'perf', sort: { key: SINCE, dir: -1 } },
    { id: 'above', label: 'Above pre-result price', src: 'perf', sort: { key: SINCE, dir: -1 } },
    { id: 'below', label: 'At or below pre-result price', src: 'perf', sort: { key: SINCE, dir: 1 } },
    { id: 'soldoff', label: 'Strong results, sold off', src: 'perf', sort: { key: SINCE, dir: 1 } },
    { id: 'rallied', label: 'Weak results, rallied', src: 'perf', sort: { key: SINCE, dir: -1 } },
    { id: 'strong', label: 'Strong results', src: 'perf', sort: { key: SINCE, dir: -1 } },
    { id: 'mixed', label: 'Mixed results', src: 'perf', sort: { key: SINCE, dir: -1 } },
    { id: 'weak', label: 'Weak results', src: 'perf', sort: { key: SINCE, dir: -1 } },
    { id: 'after', label: 'Announced after market', src: 'perf', sort: { key: DAY, dir: -1 } },
    { id: 'market', label: 'Announced in market hours', src: 'perf', sort: { key: DAY, dir: -1 } },
    { id: 'before', label: 'Announced before market', src: 'perf', sort: { key: DAY, dir: -1 } },
    { id: 'waiting', label: 'Waiting on screener.in', src: 'tracker', sort: { key: 'Result Date', dir: 1 } },
    { id: 'gaveup', label: 'Gave up', src: 'tracker', sort: { key: 'Result Date', dir: -1 } }
  ];
  var SESSIONS = [['after', 'After market'], ['market', 'Market hours'], ['before', 'Before market'], ['unknown', 'Time not known']];

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function objRows(t) {
    if (!t || !Array.isArray(t.cols) || !Array.isArray(t.rows)) return [];
    return t.rows.map(function (r) { var o = {}; t.cols.forEach(function (c, i) { o[c] = r[i]; }); return o; });
  }
  function seasonOf(perf) { var s = perf && perf.seasons && perf.seasons[0]; return s && s.season ? String(s.season) : null; }
  function perfRows(perf, season) {
    return objRows(perf && perf.table).filter(function (r) { return r.Symbol && (!season || String(r.Quarter) === season); });
  }
  function trackerRows(tracker, season) {
    return objRows(tracker).filter(function (r) { return r.Symbol && (!season || String(r['Quarter Expected']) === season); });
  }
  function session(r) {
    var t = String((r && r.Announced) || '').toLowerCase();
    if (/after market|market closed/.test(t)) return 'after';
    if (/market hours/.test(t)) return 'market';
    if (/before market/.test(t)) return 'before';
    return '';
  }
  function verdict(r) { return String(r['Results Verdict'] || ''); }
  function since(r) { return r[SINCE]; }

  function pick(kind, perf, tracker) {
    switch (kind) {
      case 'tracked': return perf.slice();
      case 'above': return perf.filter(function (r) { return isNum(since(r)) && since(r) > 0; });
      case 'below': return perf.filter(function (r) { return isNum(since(r)) && since(r) <= 0; });
      case 'soldoff': return perf.filter(function (r) { return /watch/i.test(String(r.Signal || '')); });
      case 'rallied': return perf.filter(function (r) { return /caution/i.test(String(r.Signal || '')); });
      case 'strong': return perf.filter(function (r) { return verdict(r) === 'Strong'; });
      case 'mixed': return perf.filter(function (r) { return verdict(r) === 'Mixed'; });
      case 'weak': return perf.filter(function (r) { return verdict(r) === 'Weak'; });
      case 'after': case 'market': case 'before': return perf.filter(function (r) { return session(r) === kind; });
      case 'waiting': return tracker.filter(function (r) { return r.Status === 'Pending'; });
      case 'gaveup': return tracker.filter(function (r) { return r.Status === 'Gave up'; });
      default: return [];
    }
  }
  function counts(perf, tracker) {
    var o = {};
    KINDS.forEach(function (k) { o[k.id] = pick(k.id, perf, tracker).length; });
    return o;
  }
  function avg(rows, key) {
    var v = rows.map(function (r) { return r[key]; }).filter(isNum);
    return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : null;
  }
  function bySession(perf) {
    return SESSIONS.map(function (s) {
      var rows = perf.filter(function (r) { return (session(r) || 'unknown') === s[0]; });
      return { id: s[0], label: s[1], count: rows.length, avgDay: avg(rows, DAY), avgSince: avg(rows, SINCE) };
    });
  }
  function movers(perf, n) {
    var withMove = perf.filter(function (r) { return isNum(since(r)); });
    var up = withMove.slice().sort(function (a, b) { return since(b) - since(a); });
    return { best: up.slice(0, n).filter(function (r) { return since(r) > 0; }),
             worst: up.slice().reverse().slice(0, n).filter(function (r) { return since(r) < 0; }) };
  }

  return { KINDS: KINDS, seasonOf: seasonOf, perfRows: perfRows, trackerRows: trackerRows, session: session,
           pick: pick, counts: counts, bySession: bySession, movers: movers };
});
