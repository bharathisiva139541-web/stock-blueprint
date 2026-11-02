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
     reclaim(row, history)          -> the "fell after results, then reclaimed" read of one Results Performance row
                                       from the daily closes (see RECLAIM below), or null without candles
     reclaimRows(perfRows, history) -> the rows with .reclaim set (those with candles)
     RECLAIM                        -> the thresholds
     flagList(text)                 -> the Results Tracker 'Flags' text as [{ id, label, tone, text }] (the email's pills:
                                       REV ↑ PROFIT ↓ / PROFIT > REVENUE / EXCEPTIONAL GAIN / OTHER INCOME HIGH)
     flagIndex(trackerRows)         -> { 'SYM|Sep 2026': text, SYM: { text, quarter } of the newest result with flags }
   }
   pick / counts take the reclaim rows as a 3rd argument for the kinds reclaimed / reclaimslow / nearreclaim. */
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
    { id: 'reclaimed', label: 'Fell after results, back above now', src: 'reclaim', sort: { key: 'reclaimDay', dir: -1 } },
    { id: 'reclaimslow', label: 'Back above after 2+ weeks', src: 'reclaim', sort: { key: 'reclaimDay', dir: -1 } },
    { id: 'nearreclaim', label: 'Still below, close to the pre-result price', src: 'reclaim', sort: { key: 'nowPct', dir: -1 } },
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

  function pick(kind, perf, tracker, rc) {
    var rec = function (r) { return r.reclaim || {}; };
    switch (kind) {
      case 'reclaimed': return (rc || []).filter(function (r) { return rec(r).status === 'reclaimed'; });
      case 'reclaimslow': return (rc || []).filter(function (r) { return rec(r).status === 'reclaimed' && rec(r).reclaimDay >= RECLAIM.slowDays; });
      case 'nearreclaim': return (rc || []).filter(function (r) { return rec(r).status === 'near'; });
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
  function counts(perf, tracker, rc) {
    var o = {};
    KINDS.forEach(function (k) { o[k.id] = pick(k.id, perf, tracker, rc).length; });
    return o;
  }

  // ---- "fell after results, then reclaimed" (owner's friend, 03-Nov-2026: some stocks fall below the pre-results
  // price after the results, and 15-20 days later climb back above it and keep going up). From the daily CLOSES after
  // the results (the session that could first react on; an after-market filing reacts the next session - the sheet's
  // 'Reaction From'), against the sheet's Pre-Result Close:
  //   fell     = a close at least 3% below the pre-result close (a small dip is not the pattern);
  //   reclaimed = after the lowest close, a close back above it, and the latest close still above (reclaimDay = the
  //               session number after the results; 'slow' = 10+ sessions, about two weeks);
  //   near     = still below, within 3% of the pre-result close and at least 2% up from the lowest close;
  //   trend    = rising (the latest close within 2% of the highest close since it climbed back) / holding (above the
  //               pre-result close but pulled back from that high)
  var RECLAIM = { minDipPct: 3, slowDays: 10, nearPct: 3, bouncePct: 2, risingPct: 2 };
  function dayOf(v) { var m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v || '')); return m ? m[1] : ''; }
  function reclaim(r, H) {
    var base = r && r['Pre-Result Close'];
    var bars = H && H.bars && r && H.bars[r.Symbol];
    if (!isNum(base) || base <= 0 || !bars || !bars.length || !H.dates) return null;
    var rf = /^(after|from)\s+(\d{4}-\d{2}-\d{2})/.exec(String(r['Reaction From'] || ''));
    var from = rf ? rf[2] : dayOf(r['Result Date']), strict = !!(rf && rf[1] === 'after');
    if (!from) return null;
    var cl = [];
    bars.forEach(function (b) {
      var d = H.dates[b[0]];
      if (d && (strict ? d > from : d >= from) && isNum(b[4])) cl.push({ d: d, c: b[4] });
    });
    cl.sort(function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : 0; });
    if (!cl.length) return null;
    var lo = 0;
    cl.forEach(function (x, i) { if (x.c < cl[lo].c) lo = i; });
    var last = cl[cl.length - 1], pc = function (v) { return (v / base - 1) * 100; };
    var out = { sessions: cl.length, low: cl[lo].c, lowPct: pc(cl[lo].c), lowDay: lo + 1, lowDate: cl[lo].d,
                now: last.c, nowPct: pc(last.c), nowDate: last.d, reclaimDay: null, reclaimDate: null, trend: '', status: 'held' };
    if (out.lowPct > -RECLAIM.minDipPct) return out;        // never closed 3% below the pre-result price
    for (var i = lo + 1; i < cl.length; i++) {
      if (cl[i].c > base) { out.reclaimDay = i + 1; out.reclaimDate = cl[i].d; out.reclaimClose = cl[i].c; break; }
    }
    if (last.c > base && out.reclaimDay) {
      out.status = 'reclaimed';
      var top = 0;
      for (var j = out.reclaimDay - 1; j < cl.length; j++) top = Math.max(top, cl[j].c);
      out.high = top;
      out.trend = last.c >= top * (1 - RECLAIM.risingPct / 100) ? 'Rising' : 'Holding';
    } else if (last.c <= base && last.c >= base * (1 - RECLAIM.nearPct / 100) && last.c >= cl[lo].c * (1 + RECLAIM.bouncePct / 100)) {
      out.status = 'near';
    } else {
      out.status = 'below';
    }
    return out;
  }
  function reclaimRows(perf, H) {
    var out = [];
    (perf || []).forEach(function (r) {
      var x = reclaim(r, H);
      if (!x) return;
      var o = {};
      Object.keys(r).forEach(function (k) { o[k] = r[k]; });
      o.reclaim = x;
      ['lowPct', 'lowDay', 'lowDate', 'reclaimDay', 'reclaimDate', 'nowPct', 'trend', 'sessions'].forEach(function (k) { o[k] = x[k]; });
      out.push(o);
    });
    return out;
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

  // ---- result flags (Code2.gs ab_rsFlags_ writes the tracker's 'Flags' text, '; ' between; ab_rsFlagPills_ = the email's pills)
  var FLAGS = [
    { id: 'revdown', re: /^Revenue up, profit down/, label: 'REV \u2191 PROFIT \u2193', tone: 'bad' },
    { id: 'profitfaster', re: /^Profit growing faster than revenue/, label: 'PROFIT > REVENUE', tone: 'good' },
    { id: 'exceptional', re: /^Exceptional gain/, label: 'EXCEPTIONAL GAIN', tone: 'warn' },
    { id: 'otherincome', re: /^Other income high/, label: 'OTHER INCOME HIGH', tone: 'warn' }
  ];
  function flagList(text) {
    return String(text || '').split(/;\s*/).map(function (t) { return t.trim(); }).filter(Boolean).map(function (t) {
      var f = FLAGS.filter(function (x) { return x.re.test(t); })[0];
      return f ? { id: f.id, label: f.label, tone: f.tone, text: t } : { id: 'other', label: 'FLAG', tone: 'info', text: t };
    });
  }
  function flagIndex(tracker) {
    var o = {};
    (tracker || []).forEach(function (r) {
      var t = String(r.Flags || '').trim();
      if (!r.Symbol || !t) return;
      o[r.Symbol + '|' + r['Quarter Expected']] = t;
      var cur = o[r.Symbol];
      var d = String(r['Result Date'] || '');
      if (!cur || d > cur.date) o[r.Symbol] = { text: t, quarter: String(r['Quarter Expected'] || ''), date: d };
    });
    return o;
  }

  return { KINDS: KINDS, seasonOf: seasonOf, perfRows: perfRows, trackerRows: trackerRows, session: session,
           pick: pick, counts: counts, bySession: bySession, movers: movers, reclaim: reclaim, reclaimRows: reclaimRows, RECLAIM: RECLAIM,
           flagList: flagList, flagIndex: flagIndex };
});
