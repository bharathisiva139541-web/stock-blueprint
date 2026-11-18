/* A stock's 5-year results table (owner, 18-Nov-2026: "if we download all XBRL file from NSE for upto 5 years, can we able
   to build a table like Screener.in in our website?" -> quarterly + yearly P&L) - browser + Node, no DOM. The laptop reads
   NSE's XBRL result filings (pcbridge/ScreenerBridge/xbrl_history.py), the sheet keeps one table a stock (tab Financials)
   and api/financials?sym= hands it to the stock window.

   fin = { b: 'C' | 'S', q: [[label, rev, exp, op, opm, oi, exc, int, dep, pbt, taxp, np, eps, flag], ...] oldest first,
           y: [...same, years], files, at }   flag '' = the filing's own period, 'c' = a later filing's comparison column,
                                                's' = the other basis's filing

   SB.fin = {
     ROWS                  -> [{k, label, kind 'cr' | 'pct' | 'eps'}] in screener.in's order
     view(fin, kind)       -> null | { kind, basis, labels, flags, rows: [{k, label, kind, vals}] } (rows with no figure left
                              out; kind 'q' quarters / 'y' years)
     growth(view, k, lag)  -> [% change vs lag periods before, ...] (lag 4 = a year for quarters, 1 for years)
     cell(v, kind)         -> the text of one figure
     csv(view, sym)        -> [[...], ...] rows for a CSV file
   } */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.SB = root.SB || /** @type {any} */ ({})).fin = factory();
})(/** @type {any} */ (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  var ROWS = [
    { k: 'rev', label: 'Sales', kind: 'cr' }, { k: 'exp', label: 'Expenses', kind: 'cr' },
    { k: 'op', label: 'Operating Profit', kind: 'cr' }, { k: 'opm', label: 'OPM %', kind: 'pct' },
    { k: 'oi', label: 'Other Income', kind: 'cr' }, { k: 'exc', label: 'Exceptional items', kind: 'cr' },
    { k: 'int', label: 'Interest', kind: 'cr' }, { k: 'dep', label: 'Depreciation', kind: 'cr' },
    { k: 'pbt', label: 'Profit before tax', kind: 'cr' }, { k: 'taxp', label: 'Tax %', kind: 'pct' },
    { k: 'np', label: 'Net Profit', kind: 'cr' }, { k: 'eps', label: 'EPS in Rs', kind: 'eps' }
  ];
  var LABEL_RE = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}$/;

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function view(fin, kind) {
    if (!fin || typeof fin !== 'object') return null;
    var k = kind === 'y' ? 'y' : 'q';
    var src = (Array.isArray(fin[k]) ? fin[k] : []).filter(function (r) { return Array.isArray(r) && LABEL_RE.test(String(r[0])); });
    if (!src.length) return null;
    var rows = [];
    ROWS.forEach(function (row, i) {
      var vals = src.map(function (r) { return isNum(r[i + 1]) ? r[i + 1] : null; });
      if (vals.some(isNum)) rows.push({ k: row.k, label: row.label, kind: row.kind, vals: vals });
    });
    return {
      kind: k, basis: fin.b === 'S' ? 'S' : 'C', at: fin.at || '', files: fin.files || 0,
      labels: src.map(function (r) { return String(r[0]); }),
      flags: src.map(function (r) { var f = r[ROWS.length + 1]; return f === 'c' || f === 's' ? f : ''; }),
      rows: rows
    };
  }

  /** % change of one row vs `lag` periods before (null when either side is missing or the base is 0). */
  function growth(v, key, lag) {
    var row = v && v.rows.filter(function (r) { return r.k === key; })[0];
    if (!row) return [];
    return row.vals.map(function (x, i) {
      var b = i >= lag ? row.vals[i - lag] : null;
      return isNum(x) && isNum(b) && b !== 0 ? (x - b) / Math.abs(b) * 100 : null;
    });
  }

  function cell(v, kind) {
    if (!isNum(v)) return '';
    if (kind === 'pct') return v.toFixed(0) + '%';
    if (kind === 'eps') return v.toFixed(2);
    var a = Math.abs(v);
    var s = a >= 100 ? Math.round(a).toLocaleString('en-IN') : a.toFixed(2);
    return (v < 0 ? '-' : '') + s;
  }

  function csv(v, sym) {
    if (!v) return [];
    var out = [[(sym || '') + (v.kind === 'y' ? ' - yearly (Rs crore)' : ' - quarterly (Rs crore)')].concat(v.labels)];
    v.rows.forEach(function (r) { out.push([r.label].concat(r.vals.map(function (x) { return isNum(x) ? x : ''; }))); });
    out.push(['From'].concat(v.flags.map(function (f) {
      return f === 'c' ? 'a later filing (comparison column)' : f === 's' ? (v.basis === 'C' ? 'standalone filing' : 'consolidated filing') : 'its own filing';
    })));
    return out;
  }

  return { ROWS: ROWS, view: view, growth: growth, cell: cell, csv: csv };
});
