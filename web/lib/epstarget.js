/* EPS Growth Target Lab - the figures of the page #epst (owner, 23-Nov-2026: LAURUSLABS reached its TTM EPS x growth %
   target after the Q1 results - "how many stocks like this reached atmost its target price after Q1 result update").
   The laptop works out each stock's target, entry and the prices after it (pcbridge/ScreenerBridge/eps_target.py); this
   only counts: a window of N sessions after the entry, the status of every result in it, hit rates with their likely
   range, groups. Node-testable (no DOM). */
(function (root) {
  'use strict';
  var WINDOWS = [30, 60, 90, 120, 180];
  // reached = a daily high (a target under the entry: a daily low) covered this % of the way from the entry to the target
  // (owner, 24-Nov-2026: "if a stock hit atleast 80% of the target price, consider as it is target hit" - his answer:
  // 80 % of the way, entry 100 / target 200 -> 180)
  var THRESH = [80, 90, 100];
  var COLS = ['sym', 'st', 'why', 'b', 'fl', 'eps', 'ttm', 'prev', 'g', 'tgt', 'ann', 'src', 'ed', 'ep', 'pre', 'o0', 'n', 'kp',
    'kd', 'pg', 'hh', 'dd', 'cl', 'ix', 'now', 'ph', 'pc'];
  // the list's statuses: a target under the entry price is a DOWNSIDE target, kept apart from the long ones (owner,
  // 24-Nov-2026: "we are long trader. it should not mingle with long trades")
  var STATUS = {
    hit: ['Reached', 's-good'], not: ['Not reached', 's-bad'], pending: ['Still running', 's-info'],
    down: ['Downside target', 's-warn'], none: ['No target', '']
  };
  var DSTATUS = { hit: ['Fell to it', 's-good'], not: ['Did not fall to it', 's-bad'], pending: ['Still running', 's-info'] };
  var WHY = {
    loss: 'Loss in the last 4 quarters', prevloss: 'Loss in the 4 quarters before', fell: 'EPS fell (no growth)',
    date: 'No results date found', wait: 'No session since the results', price: 'No daily candles',
    nofiling: 'NSE has no result filing of it (e.g. BSE only)'
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

  /** the api's answer -> row objects (+ dir up | down, up = the target vs the entry %, pe = PE at the entry) */
  function objects(res) {
    var cols = (res && res.cols) || COLS;
    return ((res && res.rows) || []).map(function (a) {
      var r = {};
      cols.forEach(function (k, i) { r[k] = a[i]; });
      r.eps = r.eps || [];
      ['kp', 'kd', 'pg', 'hh', 'dd', 'cl', 'ix', 'ph', 'pc'].forEach(function (k) { r[k] = Array.isArray(r[k]) ? r[k] : []; });
      var ok = r.st === 'ok' && isNum(r.tgt) && r.ep > 0;
      r.dir = ok ? (r.tgt > r.ep ? 'up' : 'down') : '';
      r.up = ok ? (r.tgt / r.ep - 1) * 100 : null;
      r.pe = ok && r.ttm > 0 ? r.ep / r.ttm : null;
      return r;
    });
  }

  function wi(W) { var k = WINDOWS.indexOf(W); return k < 0 ? WINDOWS.length - 1 : k; }
  function ti(T) { var k = THRESH.indexOf(Number(T)); return k < 0 ? 0 : k; }
  /** the session (and its day) a result first covered T % of the way to its target */
  function reachK(r, T) { var v = r.kp[ti(T)]; return isNum(v) ? v : null; }
  function reachD(r, T) { return r.kd[ti(T)] || ''; }
  /** the price T % of the way from the entry to the target */
  function level(r, T) { return isNum(r.tgt) && r.ep > 0 ? r.ep + (r.tgt - r.ep) * (THRESH[ti(T)] / 100) : null; }
  /** a result's status in a window of W sessions after the entry, in its own direction */
  function status(r, W, T) {
    if (r.st !== 'ok' || !r.dir) return 'none';
    var k = reachK(r, T);
    if (k != null && k <= W) return 'hit';
    if (isNum(r.n) && r.n >= W) return 'not';
    return 'pending';
  }
  /** the list's status: a downside target is shown apart */
  function kind(r, W, T) { return r.dir === 'down' ? 'down' : status(r, W, T); }
  /** a result is counted in a window only once the whole window is over (an early hit of a result still running would
   *  make the rate look better than it is - the slow ones have not failed yet; the same rule as Results Edge) */
  function counted(r, W, T) {
    var s = status(r, W, T);
    return (s === 'hit' || s === 'not') && isNum(r.n) && r.n >= W;
  }
  /** what you would have got on a long target: bought at the entry, sold at the T % level when it came within W sessions,
   *  else at the close of the W-th session (null while the window is not over) */
  function outcome(r, W, T) {
    if (!counted(r, W, T)) return null;
    return status(r, W, T) === 'hit' ? r.up * THRESH[ti(T)] / 100 : r.cl[wi(W)];
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

  /** the figures of the results of one direction (up = long targets, down = downside targets) in a window of W sessions */
  function stats(rows, W, T, dir) {
    dir = dir || 'up';
    var c = { hit: 0, not: 0, pending: 0, early: 0, none: 0, other: 0 };
    var days = [], ups = [], ret = [], idx = [], dd = [], hh = [], out = [], beat = 0, both = 0, k = wi(W);
    rows.forEach(function (r) {
      if (r.st !== 'ok' || !r.dir) { c.none++; return; }
      if (r.dir !== dir) { c.other++; return; }
      var s = status(r, W, T);
      if (s === 'hit' && !counted(r, W, T)) { c.pending++; c.early++; return; }
      c[s]++;
      if (s === 'pending') return;
      if (s === 'hit') days.push(reachK(r, T));
      ups.push(r.up);
      out.push(outcome(r, W, T));
      dd.push(r.dd[k]);
      hh.push(r.hh[k]);
      if (isNum(r.cl[k])) {
        ret.push(r.cl[k]);
        if (isNum(r.ix[k])) { idx.push(r.ix[k]); both++; if (r.cl[k] > r.ix[k]) beat++; }
      }
    });
    var done = c.hit + c.not, ci = wilson(c.hit, done);
    return { W: W, T: THRESH[ti(T)], dir: dir, n: done + c.pending, done: done, hit: c.hit, not: c.not, pending: c.pending, early: c.early,
      none: c.none, other: c.other, rate: done ? c.hit / done : null, lo: ci[0], hi: ci[1], medDays: median(days), medUp: median(ups),
      avgOut: mean(out), medOut: median(out), avgRet: mean(ret), avgIx: mean(idx), beat: both ? beat / both : null, avgDd: mean(dd), avgHh: mean(hh) };
  }
  function byWindow(rows, T, dir) { return WINDOWS.map(function (W) { return stats(rows, W, T, dir); }); }
  function bandLabel(b, unit) {
    unit = unit || '%';
    return b[1] === Infinity ? 'Over ' + b[0] + unit : b[0] + '–' + b[1] + unit;
  }
  /** groups of the long targets by a figure: bands [[from, to), ...] -> [{label, ...stats}] */
  function bucket(rows, W, T, get, bands, unit) {
    return bands.map(function (b) {
      var in_ = rows.filter(function (r) { var v = get(r); return r.dir === 'up' && isNum(v) && v >= b[0] && v < b[1]; });
      var s = stats(in_, W, T);
      s.label = bandLabel(b, unit);
      return s;
    });
  }
  /** groups of the long targets by a word (sector ...) -> the ones with at least `min` results finished, best hit rate first */
  function groupBy(rows, W, T, get, min) {
    var m = {};
    rows.forEach(function (r) {
      if (r.dir !== 'up') return;
      var k = get(r) || 'Unknown';
      (m[k] = m[k] || []).push(r);
    });
    return Object.keys(m).map(function (k) { var s = stats(m[k], W, T); s.label = k; return s; })
      .filter(function (s) { return s.done >= (min || 1); })
      .sort(function (a, b) { return (b.rate - a.rate) || (b.done - a.done); });
  }
  /** a quarter's figures from the laptop's summary (the quarters list, without its rows); null for an older summary */
  function sumRate(sum, W, T, dir) {
    var w = sum && (dir === 'down' ? sum.dwin : sum.win) && (dir === 'down' ? sum.dwin : sum.win)[String(W)];
    if (!w || w.length < 6) return null;
    var k = ti(T);
    return { done: w[0], hit: w[1 + k], pending: w[4], early: k === 0 ? w[5] : null, rate: w[0] ? w[1 + k] / w[0] : null };
  }
  /** every stock across the quarters (byQ {quarter: rows}, qs oldest first): did its long target come each time? A target
   *  reached counts even while its window still runs (it came); a quarter still running without it is left out until its
   *  window is over. marks: hit / early (reached, window still running) / not / pending / down / none / '' (no 8 quarters). */
  function thesis(byQ, qs, W, T) {
    var m = {};
    qs.forEach(function (q, qi) {
      (byQ[q] || []).forEach(function (r) {
        var e = m[r.sym] || (m[r.sym] = { sym: r.sym, marks: qs.map(function () { return ''; }), done: 0, hit: 0, pending: 0, down: 0, none: 0,
          days: [], ups: [], last: null });
        var mark;
        if (r.st !== 'ok' || !r.dir) { mark = 'none'; e.none++; } else if (r.dir === 'down') { mark = 'down'; e.down++; } else {
          var s = status(r, W, T);
          mark = s === 'hit' && !counted(r, W, T) ? 'early' : s;
          if (mark === 'pending') e.pending++;
          else {
            e.done++;
            e.ups.push(r.up);
            if (mark !== 'not') { e.hit++; e.days.push(reachK(r, T)); }
          }
        }
        e.marks[qi] = mark;
        e.last = { q: q, r: r, mark: mark };
      });
    });
    return Object.keys(m).map(function (k) {
      var e = m[k];
      e.rate = e.done ? e.hit / e.done : null;
      e.medDays = median(e.days);
      e.medUp = median(e.ups);
      e.every = e.done >= 2 && e.hit === e.done;
      e.most = e.done >= 2 && e.hit * 2 > e.done;
      return e;
    });
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

  var api = { WINDOWS: WINDOWS, THRESH: THRESH, COLS: COLS, STATUS: STATUS, DSTATUS: DSTATUS, WHY: WHY, GROWTH: GROWTH, UPSIDE: UPSIDE, PE: PE,
    FLAG: FLAG, mi: mi, label: label, fy: fy, quarters: quarters, objects: objects, status: status, kind: kind, counted: counted,
    outcome: outcome, reachK: reachK, reachD: reachD, level: level, wilson: wilson, median: median, stats: stats, byWindow: byWindow,
    bucket: bucket, groupBy: groupBy, bandLabel: bandLabel, sumRate: sumRate, thesis: thesis, formula: formula };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) { root.SB = root.SB || {}; root.SB.epst = api; }
})(typeof window !== 'undefined' ? window : null);
