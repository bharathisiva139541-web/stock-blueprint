/* A stock's 5-year results table (owner, 18-Nov-2026: "if we download all XBRL file from NSE for upto 5 years, can we able
   to build a table like Screener.in in our website?" -> quarterly + yearly P&L) - browser + Node, no DOM. The laptop reads
   NSE's XBRL result filings (pcbridge/ScreenerBridge/xbrl_history.py), the sheet keeps one table a stock (tab Financials)
   and api/financials?sym= hands it to the stock window.

   fin = { b: 'C' | 'S', q: [[label, rev, exp, op, opm, oi, exc, int, dep, pbt, taxp, np, eps, flag], ...] oldest first,
           y: [...same, years], files, at, note?, k?, bw?, o? }   flag '' = the filing's own period, 'c' = a later
                                                filing's comparison column, 'd' = worked out from the year-to-date figures
                                                of the other filings (no filing of its own), 's' = standalone figures
                                                before the company's first consolidated period, 'q' = a year with no
                                                yearly figures read = the sum of its 4 quarters, 'r' = screener.in's
                                                figures (no NSE filing: before the listing / a gap); note = EPS adjusted for
                                                a bonus / split; k 'bank' = screener.in's bank rows (Revenue, Financing
                                                Profit, Financing Margin %); bw = words about the basis (owner, 23-Nov-2026:
                                                MTARTECH - consolidated results ended, its subsidiaries merged into it);
                                                o = the other basis's table { b, q, y, note?, k? } (never mixed in)

   SB.fin = {
     ROWS                  -> [{k, label, kind 'cr' | 'pct' | 'eps'}] in screener.in's order
     bases(fin)            -> ['C'] / ['S'] / ['S', 'C'] ... the tables it has, the one shown first first
     pick(fin, basis)      -> the table of that basis (fin itself, or fin.o with the shared files / at / bw)
     view(fin, kind)       -> null | { kind, basis, bank, note, labels, flags, rows: [{k, label, kind, vals}] } (rows with
                              no figure left out; kind 'q' quarters / 'y' years); the years end with a 'TTM' column
                              (flag 't', ttmFrom 'Dec 2025 - Sep 2026', ttmPrev = the 4 quarters before) = the sum of the
                              newest 4 quarters when they follow each other (owner, 23-Nov-2026: "include TTM to PL to all
                              stocks" - screener.in's own way)
     ttm(fin)              -> null | { vals: [12 figures], from, to, prev: [12 figures] | null }
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
  var BANK = { rev: 'Revenue', op: 'Financing Profit', opm: 'Financing Margin %' };
  var LABEL_RE = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}$/;

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  var FLAGS = { c: 1, d: 1, s: 1, q: 1, r: 1 };
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function monthOf(label) {
    var m = /^([A-Za-z]{3}) (\d{4})$/.exec(String(label));
    return m && MON.indexOf(m[1]) >= 0 ? +m[2] * 12 + MON.indexOf(m[1]) : null;
  }
  var SUMS = { rev: 1, exp: 1, op: 1, oi: 1, int: 1, dep: 1, pbt: 1, np: 1, eps: 1 };

  /** Four quarters (rows, oldest first) -> the 12 figures of their sum, screener.in's way: amounts and EPS added
      (all 4 needed), exceptional items added where filed, OPM % from the sums, Tax % = the 4 quarters' tax / their PBT. */
  function sum4(rows) {
    var col = function (k) { var i = ROWS.map(function (r) { return r.k; }).indexOf(k) + 1; return rows.map(function (r) { return r[i]; }); };
    var all = function (xs) { return xs.every(isNum); };
    var add = function (xs) { return Math.round(xs.reduce(function (a, b) { return a + b; }, 0) * 100) / 100; };
    var out = {};
    Object.keys(SUMS).forEach(function (k) { var xs = col(k); out[k] = all(xs) ? add(xs) : null; });
    var exc = col('exc');
    out.exc = exc.some(isNum) ? add(exc.map(function (x) { return isNum(x) ? x : 0; })) : null;
    out.opm = isNum(out.op) && isNum(out.rev) && out.rev !== 0 ? Math.round(out.op / out.rev * 100) : null;
    var pbt = col('pbt'), tx = col('taxp');
    out.taxp = all(pbt) && all(tx) && out.pbt ? Math.round(pbt.reduce(function (a, b, i) { return a + b * tx[i] / 100; }, 0) / out.pbt * 100) : null;
    return ROWS.map(function (r) { return out[r.k]; });
  }

  function ttm(fin) {
    if (!fin || typeof fin !== 'object') return null;
    var q = (Array.isArray(fin.q) ? fin.q : []).filter(function (r) { return Array.isArray(r) && LABEL_RE.test(String(r[0])); });
    var run = function (end) {               // 4 quarters ending at q[end], each 3 months after the one before
      if (end < 3) return null;
      var part = q.slice(end - 3, end + 1);
      for (var i = 1; i < 4; i++) if (monthOf(part[i][0]) - monthOf(part[i - 1][0]) !== 3) return null;
      return part;
    };
    var cur = run(q.length - 1);
    if (!cur) return null;
    var ys = (Array.isArray(fin.y) ? fin.y : []).map(function (r) { return Array.isArray(r) ? monthOf(r[0]) : null; }).filter(isNum);
    if (ys.length && Math.max.apply(null, ys) > monthOf(cur[3][0])) return null;   // years newer than the quarters: none
    var prev = q.length >= 8 && monthOf(q[q.length - 4][0]) - monthOf(q[q.length - 5][0]) === 3 ? run(q.length - 5) : null;
    return { vals: sum4(cur), from: String(cur[0][0]), to: String(cur[3][0]), prev: prev ? sum4(prev) : null };
  }

  function other(fin) { return fin && fin.o && typeof fin.o === 'object' && (fin.o.b === 'C' || fin.o.b === 'S') && fin.o.b !== fin.b ? fin.o : null; }
  function bases(fin) {
    if (!fin || typeof fin !== 'object') return [];
    var o = other(fin);
    return [fin.b === 'S' ? 'S' : 'C'].concat(o ? [o.b] : []);
  }
  function pick(fin, basis) {
    var o = other(fin);
    if (!o || !basis || basis === fin.b || basis !== o.b) return fin;
    return { b: o.b, q: o.q, y: o.y, note: o.note, k: o.k, files: fin.files, at: fin.at, bw: fin.bw };
  }

  function view(fin, kind) {
    if (!fin || typeof fin !== 'object') return null;
    var k = kind === 'y' ? 'y' : 'q';
    var src = (Array.isArray(fin[k]) ? fin[k] : []).filter(function (r) { return Array.isArray(r) && LABEL_RE.test(String(r[0])); });
    var t = k === 'y' ? ttm(fin) : null;
    if (!src.length && !t) return null;
    var rows = [], bank = fin.k === 'bank', prev = {};
    ROWS.forEach(function (row, i) {
      var vals = src.map(function (r) { return isNum(r[i + 1]) ? r[i + 1] : null; });
      if (t) vals.push(isNum(t.vals[i]) ? t.vals[i] : null);
      if (t && t.prev) prev[row.k] = t.prev[i];
      if (vals.some(isNum)) rows.push({ k: row.k, label: (bank && BANK[row.k]) || row.label, kind: row.kind, vals: vals });
    });
    var labels = src.map(function (r) { return String(r[0]); }), flags = src.map(function (r) { var f = r[ROWS.length + 1]; return FLAGS[f] ? f : ''; });
    if (t) { labels.push('TTM'); flags.push('t'); }
    return {
      kind: k, basis: fin.b === 'S' ? 'S' : 'C', at: fin.at || '', files: fin.files || 0, bank: bank,
      note: typeof fin.note === 'string' ? fin.note : '',
      labels: labels,
      bw: typeof fin.bw === 'string' ? fin.bw : '',
      flags: flags,
      ttmFrom: t ? t.from + ' - ' + t.to : '',
      ttmPrev: t && t.prev ? prev : null,
      rows: rows
    };
  }

  /** % change of one row vs `lag` periods before (null when either side is missing or the base is 0). */
  function growth(v, key, lag) {
    var row = v && v.rows.filter(function (r) { return r.k === key; })[0];
    if (!row) return [];
    return row.vals.map(function (x, i) {
      var b = v.flags[i] === 't' ? (v.ttmPrev ? v.ttmPrev[key] : null) : i >= lag ? row.vals[i - lag] : null;
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
      return f === 'c' ? 'a later filing (comparison column)' : f === 's' ? 'standalone filing (before the first consolidated one)'
        : f === 'd' ? 'worked out from the year-to-date figures of other filings'
        : f === 'q' ? 'the sum of its 4 quarters' : f === 'r' ? 'screener.in (no NSE filing figures)'
        : f === 't' ? 'the sum of the last 4 quarters (' + v.ttmFrom + ')' : 'its own filing';
    })));
    if (v.bw) out.push([v.bw]);
    if (v.note) out.push([v.note]);
    return out;
  }

  return { ROWS: ROWS, bases: bases, pick: pick, view: view, ttm: ttm, growth: growth, cell: cell, csv: csv };
});
