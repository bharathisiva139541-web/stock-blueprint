/* EPS Growth Target Lab - the figures of the page #epst (owner, 23-Nov-2026: LAURUSLABS reached its TTM EPS x growth %
   target after the Q1 results - "how many stocks like this reached atmost its target price after Q1 result update").
   The laptop works out each stock's target, entry and the prices after it (pcbridge/ScreenerBridge/eps_target.py); this
   only counts: a window of N sessions after the entry, the status of every result in it, hit rates with their likely
   range, groups. Node-testable (no DOM). */
(function (root) {
  'use strict';
  var WINDOWS = [30, 60, 90, 120, 180];
  var NEAR = 2;                         // a best high within 2 % under the target = a near miss
  var COLS = ['sym', 'st', 'why', 'b', 'fl', 'eps', 'ttm', 'prev', 'g', 'tgt', 'ann', 'src', 'ed', 'ep', 'pre', 'o0', 'n', 'hit',
    'hitd', 'mx', 'dd', 'cl', 'ix', 'now', 'ph', 'pc'];
  var STATUS = {
    hit: ['Target reached', 's-good'], near: ['Near miss', 's-warn'], not: ['Not reached', 's-bad'], pending: ['Still running', 's-info'],
    above: ['Above target at entry', ''], none: ['No target', '']
  };
  var WHY = {
    loss: 'Loss in the last 4 quarters', prevloss: 'Loss in the 4 quarters before', fell: 'EPS fell (no growth)',
    date: 'No results date found', wait: 'No session since the results', price: 'No daily candles'
  };
  var GROWTH = [[0, 20], [20, 40], [40, 60], [60, 100], [100, 150], [150, Infinity]];
  var UPSIDE = [[0, 25], [25, 50], [50, 100], [100, 200], [200, Infinity]];
  var PE = [[0, 15], [15, 25], [25, 40], [40, 60], [60, Infinity]];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function mi(label) {
    var m = /^([A-Z][a-z]{2}) (\d{4})$/.exec(String(label || ''));
    var k = m ? MON.indexOf(m[1]) : -1;
    return k < 0 ? null : Number(m[2]) * 12 + k + 1;
  }
  function label(x) { var y = Math.floor((x - 1) / 12); return MON[(x - 1) - y * 12] + ' ' + y; }
  /** 'Jun 2026' -> 'Q1 FY27' (India's financial year starts in April) */
  function fy(q) {
    var x = mi(q);
    if (x == null) return '';
    var y = Math.floor((x - 1) / 12), m = x - y * 12;
    var n = { 6: 1, 9: 2, 12: 3, 3: 4 }[m];
    return n ? 'Q' + n + ' FY' + String((m >= 4 ? y + 1 : y) % 100).padStart(2, '0') : '';
  }
  /** the 8 quarters of a quarter's formula, oldest first */
  function quarters(q) {
    var x = mi(q), out = [];
    if (x == null) return out;
    for (var k = 7; k >= 0; k--) out.push(label(x - 3 * k));
    return out;
  }

  /** the api's answer -> row objects (+ up = upside at the entry %, pe = PE at the entry) */
  function objects(res) {
    var cols = (res && res.cols) || COLS;
    return ((res && res.rows) || []).map(function (a) {
      var r = {};
      cols.forEach(function (k, i) { r[k] = a[i]; });
      r.eps = r.eps || [];
      ['mx', 'dd', 'cl', 'ix', 'ph', 'pc'].forEach(function (k) { r[k] = Array.isArray(r[k]) ? r[k] : []; });
      r.up = r.st === 'ok' && isNum(r.tgt) && r.ep > 0 ? (r.tgt / r.ep - 1) * 100 : null;
      r.pe = r.st === 'ok' && r.ttm > 0 && r.ep > 0 ? r.ep / r.ttm : null;
      return r;
    });
  }

  function wi(W) { var k = WINDOWS.indexOf(W); return k < 0 ? WINDOWS.length - 1 : k; }
  /** a result's status in a window of W sessions after the entry */
  function status(r, W) {
    if (r.st !== 'ok' || !isNum(r.tgt)) return 'none';
    if (r.tgt <= r.ep) return 'above';
    if (isNum(r.hit) && r.hit <= W) return 'hit';
    if (isNum(r.n) && r.n >= W) return (r.mx[wi(W)] || 0) >= 100 - NEAR ? 'near' : 'not';
    return 'pending';
  }
  /** a result is counted in a window only once the whole window is over (an early hit of a result still running would
   *  make the rate look better than it is - the slow ones have not failed yet; the same rule as Results Edge) */
  function counted(r, W) {
    var s = status(r, W);
    return (s === 'hit' || s === 'near' || s === 'not') && isNum(r.n) && r.n >= W;
  }
  /** what you would have got: bought at the entry, sold at the target when it came within W sessions, else at the close of
   *  the W-th session (null while the window is not over) */
  function outcome(r, W) {
    if (!counted(r, W)) return null;
    return status(r, W) === 'hit' ? r.up : r.cl[wi(W)];
  }

  function wilson(k, n, z) {
    if (!n) return [null, null];
    z = z || 1.645;
    var p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
    return [Math.max(0, c - h), Math.min(1, c + h)];
  }
  function median(a) {
    var v = a.filter(isNum).sort(function (x, y) { return x - y; });
    if (!v.length) return null;
    var m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }
  function mean(a) {
    var v = a.filter(isNum);
    return v.length ? v.reduce(function (s, x) { return s + x; }, 0) / v.length : null;
  }

  /** the figures of a list of results in a window of W sessions */
  function stats(rows, W) {
    var c = { hit: 0, near: 0, not: 0, pending: 0, above: 0, none: 0, early: 0 };
    var days = [], ups = [], ret = [], idx = [], dd = [], out = [], beat = 0, both = 0, k = wi(W);
    rows.forEach(function (r) {
      var s = status(r, W);
      if (s === 'hit' && !counted(r, W)) { c.pending++; c.early++; return; }
      c[s]++;
      if (s === 'hit') days.push(r.hit);
      if (s === 'hit' || s === 'near' || s === 'not') {
        ups.push(r.up);
        out.push(outcome(r, W));
        dd.push(r.dd[k]);
      }
      if (s !== 'none' && s !== 'above' && isNum(r.n) && r.n >= W && isNum(r.cl[k])) {
        ret.push(r.cl[k]);
        if (isNum(r.ix[k])) { idx.push(r.ix[k]); both++; if (r.cl[k] > r.ix[k]) beat++; }
      }
    });
    var done = c.hit + c.near + c.not, ci = wilson(c.hit, done);
    return { W: W, n: done + c.pending, done: done, hit: c.hit, near: c.near, not: c.not, pending: c.pending, early: c.early, above: c.above, none: c.none,
      rate: done ? c.hit / done : null, lo: ci[0], hi: ci[1], nearRate: done ? (c.hit + c.near) / done : null,
      medDays: median(days), medUp: median(ups), avgOut: mean(out), medOut: median(out), avgRet: mean(ret), avgIx: mean(idx),
      beat: both ? beat / both : null, avgDd: mean(dd) };
  }
  function byWindow(rows) { return WINDOWS.map(function (W) { return stats(rows, W); }); }
  function bandLabel(b, unit) {
    unit = unit || '%';
    return b[1] === Infinity ? 'Over ' + b[0] + unit : b[0] + '–' + b[1] + unit;
  }
  /** groups by a figure: bands [[from, to), ...] -> [{label, ...stats}] (results with a target only) */
  function bucket(rows, W, get, bands, unit) {
    return bands.map(function (b) {
      var in_ = rows.filter(function (r) { var v = get(r); return status(r, W) !== 'none' && status(r, W) !== 'above' && isNum(v) && v >= b[0] && v < b[1]; });
      var s = stats(in_, W);
      s.label = bandLabel(b, unit);
      return s;
    });
  }
  /** groups by a word (sector ...) -> the ones with at least `min` results finished, best hit rate first */
  function groupBy(rows, W, get, min) {
    var m = {};
    rows.forEach(function (r) {
      var s = status(r, W);
      if (s === 'none' || s === 'above') return;
      var k = get(r) || 'Unknown';
      (m[k] = m[k] || []).push(r);
    });
    return Object.keys(m).map(function (k) { var s = stats(m[k], W); s.label = k; return s; })
      .filter(function (s) { return s.done >= (min || 1); })
      .sort(function (a, b) { return (b.rate - a.rate) || (b.done - a.done); });
  }
  /** a quarter's figures from the laptop's summary (the quarters list, without its rows) */
  function sumRate(sum, W) {
    var w = sum && sum.win && sum.win[String(W)];
    if (!w) return null;
    return { done: w[0], hit: w[1], near: w[2], pending: w[3], early: w[4] || 0, rate: w[0] ? w[1] / w[0] : null };
  }
  /** the formula in words with the stock's own numbers */
  function formula(r) {
    var f = function (v) { return isNum(v) ? v.toFixed(2) : '–'; };
    return {
      ttm: r.eps.slice(4).map(f).join(' + ') + ' = ' + f(r.ttm),
      prev: r.eps.slice(0, 4).map(f).join(' + ') + ' = ' + f(r.prev),
      growth: isNum(r.g) ? '(' + f(r.ttm) + ' − ' + f(r.prev) + ') ÷ ' + f(r.prev) + ' × 100 = ' + r.g.toFixed(1) + '%' : '–',
      target: isNum(r.tgt) ? f(r.ttm) + ' × ' + r.g.toFixed(1) + ' = ' + f(r.tgt) : '–'
    };
  }
  /** a flag of one of the 8 quarters: '' NSE's own filing, else where the EPS came from */
  var FLAG = { '-': '', c: 'a later filing\'s comparison column', d: 'worked out from year-to-date figures', s: 'the other basis (before consolidated results began)',
    r: 'screener.in (no NSE filing figure)', p: 'screener.in' };

  var api = { WINDOWS: WINDOWS, NEAR: NEAR, COLS: COLS, STATUS: STATUS, WHY: WHY, GROWTH: GROWTH, UPSIDE: UPSIDE, PE: PE, FLAG: FLAG,
    mi: mi, label: label, fy: fy, quarters: quarters, objects: objects, status: status, counted: counted, outcome: outcome, wilson: wilson, median: median,
    stats: stats, byWindow: byWindow, bucket: bucket, groupBy: groupBy, bandLabel: bandLabel, sumRate: sumRate, formula: formula };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) { root.SB = root.SB || {}; root.SB.epst = api; }
})(typeof window !== 'undefined' ? window : null);
