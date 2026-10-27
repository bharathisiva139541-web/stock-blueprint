/* NSE end-of-day data from the PC bridge (browser + Node, no DOM): the sheet's
   "Market Statistics", "52 Week High" and "Delivery %" tabs as the site feed /
   saved copy carries them (data.marketStats / data.high52 = {note, cols, rows},
   data.delivery = {cols, rows}).

   SB.eod = {
     stats(marketStats)    -> null | { date, traded, advances, declines, unchanged, high52, upper, lower,
                                       adRatio, prev: {...same...} | null, note }
     highs(high52)         -> { asOf, note, rows: [{ sym, name, high, date, close, below, isNew, inMain }],
                                bySym: {SYM: row}, newToday: [rows] }
     delivery(delivery)    -> { date, dates: [...newest first], bySym: {SYM: { latest, avg5, hist: [...] }} }
     dayOf(v)              -> 'yyyy-MM-dd' from a header / cell ('2026-10-27', '2026-10-27 00:00:00', a Date)
   } */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.SB = root.SB || /** @type {any} */ ({})).eod = factory();
})(/** @type {any} */ (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v) { return isNum(v) ? v : null; }
  function dayOf(v) {
    if (v instanceof Date && !isNaN(v.getTime())) {
      return v.getFullYear() + '-' + ('0' + (v.getMonth() + 1)).slice(-2) + '-' + ('0' + v.getDate()).slice(-2);
    }
    var m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v == null ? '' : v).trim());
    return m ? m[1] : '';
  }
  /** {cols, rows} -> [{col: value}] */
  function objRows(t) {
    if (!t || !Array.isArray(t.cols) || !Array.isArray(t.rows)) return [];
    return t.rows.map(function (r) { var o = {}; t.cols.forEach(function (c, i) { o[c] = r[i]; }); return o; });
  }

  var STAT_COLS = { traded: 'Stocks Traded', advances: 'Advances', declines: 'Declines', unchanged: 'Unchanged',
    high52: 'At 52W High', upper: 'Upper Circuit', lower: 'Lower Circuit' };
  function statRow(o) {
    var s = { date: dayOf(o.Date) };
    Object.keys(STAT_COLS).forEach(function (k) { s[k] = num(o[STAT_COLS[k]]); });
    s.adRatio = isNum(s.advances) && isNum(s.declines) && s.declines > 0 ? Math.round(s.advances / s.declines * 100) / 100 : null;
    return s;
  }
  function stats(t) {
    var rows = objRows(t).map(statRow).filter(function (s) { return s.date && isNum(s.traded); })
      .sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
    if (!rows.length) return null;
    var out = rows[0];
    out.prev = rows[1] || null;
    out.note = (t && t.note) || '';
    return out;
  }

  function highs(t) {
    var asOf = (/as on (\d{4}-\d{2}-\d{2})/.exec((t && t.note) || '') || [])[1] || null;
    var rows = objRows(t).map(function (o) {
      return { sym: String(o.Symbol || '').trim().toUpperCase(), name: o.Company || '', high: num(o['52W High']),
        date: dayOf(o['52W High Date']) || null, close: num(o.Close), below: num(o['% Below 52W High']),
        isNew: o['New High Today'] === 'Yes', inMain: o['In Watchlist'] === 'Yes' };
    }).filter(function (r) { return r.sym && isNum(r.high); });
    var bySym = {};
    rows.forEach(function (r) { if (!bySym[r.sym]) bySym[r.sym] = r; });
    return { asOf: asOf, note: (t && t.note) || '', rows: rows, bySym: bySym, newToday: rows.filter(function (r) { return r.isNew; }) };
  }

  function delivery(t) {
    var cols = (t && t.cols) || [];
    var days = [];                    // [column index, day]
    cols.forEach(function (c, j) { var d = j >= 2 ? dayOf(c) : ''; if (d) days.push([j, d]); });
    days.sort(function (a, b) { return a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0; });
    var bySym = {};
    ((t && t.rows) || []).forEach(function (r) {
      var sym = String(r[0] || '').trim().toUpperCase();
      if (!sym || bySym[sym]) return;
      var hist = days.map(function (d) { return num(r[d[0]]); });
      var last5 = hist.slice(0, 5).filter(isNum);
      bySym[sym] = { latest: hist.length ? hist[0] : null,
        avg5: last5.length ? Math.round(last5.reduce(function (a, b) { return a + b; }, 0) / last5.length * 100) / 100 : null, hist: hist };
    });
    return { date: days.length ? days[0][1] : null, dates: days.map(function (d) { return d[1]; }), bySym: bySym };
  }

  return { stats: stats, highs: highs, delivery: delivery, dayOf: dayOf };
});
