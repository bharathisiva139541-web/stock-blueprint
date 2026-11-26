/* Analyst Targets - the figures of the page #recos (owner, 24-Nov-2026, JLHL: Prabhudas Lilladher's Buy with a target of
   Rs 330 (27-Oct), reached on 24-Nov - "If i know for which stocks which analyst give recommendations to buy with target price
   from october 2026, it will be helpful ... which brokerage has historically been better at identifying stocks before a major
   price move"). The laptop finds the recommendations (pcbridge/ScreenerBridge/analyst_recos.py) and works out what the
   price did after each exactly like the EPS Target Lab (eps_target.after), so the counting here is SB.epst's own: a window of
   30 .. 180 sessions after the entry, reached = 50 .. 100 % of the way to the target, a result counted only once its whole
   window is over. Node-testable (no DOM). */
(function (root) {
  'use strict';
  var E = typeof module !== 'undefined' && module.exports ? require('./epstarget.js') : root.SB.epst;
  var COLS = ['sym', 'co', 'br', 'call', 'tgt', 'rp', 'at', 'src', 'url', 'seen', 'st', 'why', 'ed', 'ep', 'pre', 'o0', 'n', 'kp', 'kd',
    'pg', 'hh', 'dd', 'cl', 'ix', 'now', 'ph', 'pc'];
  var BUYS = ['BUY', 'ACCUMULATE', 'ADD', 'OUTPERFORM'];
  var CALL = { BUY: ['Buy', 's-good'], ACCUMULATE: ['Accumulate', 's-good'], ADD: ['Add', 's-good'], OUTPERFORM: ['Outperform', 's-good'],
    HOLD: ['Hold', 's-info'], NEUTRAL: ['Neutral', 's-info'], REDUCE: ['Reduce', 's-bad'], SELL: ['Sell', 's-bad'] };
  var SRC = { mc: 'Moneycontrol', bs: 'Business Standard', dsij: 'DSIJ' };
  var WHY = { nosym: 'Not one of your Main stocks (or its name did not match)', price: 'No daily candles for it', wait: 'No session since the recommendation yet',
    old: 'Before 1-Oct-2026' };
  // the list's statuses (SB.epst's, in the words of a broker's call)
  var STATUS = { hit: ['Reached', 's-good'], not: ['Not reached', 's-bad'], pending: ['Still running', 's-info'],
    down: ['Target under the price at the call', 's-warn'], none: ['Not checked', ''] };
  var DSTATUS = { hit: ['Fell to it', 's-good'], not: ['Did not fall to it', 's-bad'], pending: ['Still running', 's-info'] };

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /** the api's answer -> row objects: dir up (the target above the entry) | down, up = target vs entry %, buy = a Buy-type call */
  function objects(res) {
    var cols = (res && res.cols) || COLS;
    return ((res && res.rows) || []).map(function (a) {
      var r = {};
      cols.forEach(function (k, i) { r[k] = a[i]; });
      ['kp', 'kd', 'pg', 'hh', 'dd', 'cl', 'ix', 'ph', 'pc'].forEach(function (k) { r[k] = Array.isArray(r[k]) ? r[k] : []; });
      r.wq = [];
      r.nq = null;
      var ok = r.st === 'ok' && isNum(r.tgt) && r.ep > 0;
      r.dir = ok ? (r.tgt > r.ep ? 'up' : 'down') : '';
      r.up = ok ? (r.tgt / r.ep - 1) * 100 : null;
      r.buy = BUYS.indexOf(r.call) >= 0;
      r.day = String(r.at || '').slice(0, 10);
      r.srcs = String(r.src || '').split(',').filter(Boolean);
      return r;
    });
  }
  /** the calls the page counts: Buy-type ('buy', default) or every call ('all') */
  function pick(rows, calls) { return calls === 'all' ? rows : rows.filter(function (r) { return r.buy; }); }
  function kind(r, W, T) { return E.kind(r, W, T); }
  function mean(a) { var v = a.filter(isNum); return v.length ? v.reduce(function (s, x) { return s + x; }, 0) / v.length : null; }
  /** the average close after 30 / 60 / 90 sessions of the results whose that many sessions are over */
  function rets(rows) {
    return [0, 1, 2].map(function (k) {
      return mean(rows.filter(function (r) { return r.dir === 'up' && !r.out && isNum(r.cl[k]); }).map(function (r) { return r.cl[k]; }));
    });
  }
  /** owner, 25-Nov-2026: "if it hit target withing 10 days . it is acceptable right" - a call whose high reached the target
   *  counts as reached at once (a reached target never goes away); only a MISS waits for its whole window. SB.epst.stats +
   *  reached (finished + early) / running (not reached, window open) / missed (window over) / soFar = reached of every call
   *  with a target above the price (it can only go up while calls run) / medAll = median sessions of every reached call /
   *  hhNow, ddNow = the average best move / worst dip so far (a running window up to today). */
  function stats(rows, W, T) {
    var s = E.stats(rows, W, T), days = [], hh = [], dd = [], ups = [];
    rows.forEach(function (r) {
      if (r.st !== 'ok' || r.dir !== 'up' || r.out) return;
      if (E.status(r, W, T) === 'hit') days.push(E.reachK(r, T));
      ups.push(r.up);
      hh.push(E.wv(r, 'hh', W));
      dd.push(E.wv(r, 'dd', W));
    });
    s.reached = s.hit + s.early;
    s.running = s.pending - s.early;
    s.missed = s.not;
    s.soFar = s.n ? s.reached / s.n : null;
    var ci = s.n && !s.running ? E.wilson(s.reached, s.n) : [null, null];
    s.soLo = ci[0]; s.soHi = ci[1];
    s.medAll = E.median(days);
    s.medUp = E.median(ups);
    s.hhNow = mean(hh);
    s.ddNow = mean(dd);
    return s;
  }
  /** every broker: stats() of its long calls + the average close after 30 / 60 / 90 sessions + its calls in all; ranked
   *  once `min` (3) of its calls are checked (reached so far, owner 25-Nov-2026: "Broker scorecard is empty" - ranking only
   *  finished windows left every broker out for the first weeks) */
  function scorecard(rows, W, T, min) {
    var m = {};
    rows.forEach(function (r) { (m[r.br] = m[r.br] || []).push(r); });
    return Object.keys(m).map(function (b) {
      var s = stats(m[b], W, T);
      s.label = b;
      s.calls = m[b].length;
      s.checked = m[b].filter(function (r) { return r.st === 'ok'; }).length;
      s.stocks = Object.keys(m[b].reduce(function (o, r) { if (r.sym) o[r.sym] = 1; return o; }, {})).length;
      var rr = rets(m[b]);
      s.r30 = rr[0]; s.r60 = rr[1]; s.r90 = rr[2];
      s.ranked = s.n >= (min || 3);
      return s;
    }).sort(function (a, b) {
      return (b.ranked - a.ranked) || ((b.soFar == null ? -1 : b.soFar) - (a.soFar == null ? -1 : a.soFar)) || (b.reached - a.reached) ||
        (b.n - a.n) || (b.calls - a.calls);
    });
  }
  /** owner, 25-Nov-2026: "if price at call is not available. use the opening price of the stock on the published date" ->
   *  {v, how: close (the laptop's entry close) | open (the open of the published day - published at / after 15:30: the next
   *  session - from the site's daily candles H) | broker (the price the broker's page quoted), d} or null */
  function callPrice(r, H) {
    if (r.ep > 0) return { v: r.ep, how: 'close', d: r.ed || r.day };
    var bars = H && H.bars && H.dates && r.sym ? H.bars[r.sym] : null, day = r.day;
    if (bars && day) {
      var late = String(r.at || '').slice(11, 16) >= '15:30';
      for (var i = 0; i < bars.length; i++) {
        var d = H.dates[bars[i][0]];
        if (d && (late ? d > day : d >= day) && bars[i][1] > 0) return { v: bars[i][1], how: 'open', d: d };
      }
    }
    if (r.rp > 0) return { v: r.rp, how: 'broker', d: day };
    return null;
  }
  /** fill r.px / r.pxHow / r.pxDay (+ r.up from it when the laptop gave none) */
  function fillPrice(rows, H) {
    rows.forEach(function (r) {
      var p = callPrice(r, H);
      r.px = p ? p.v : null;
      r.pxHow = p ? p.how : '';
      r.pxDay = p ? p.d : '';
      if (r.up == null && p && isNum(r.tgt)) r.up = (r.tgt / p.v - 1) * 100;
    });
    return rows;
  }
  /** a price the laptop has not checked yet that the site can fill from its candles */
  function needsCandles(rows) { return rows.some(function (r) { return !(r.ep > 0) && r.sym; }); }
  /** one stock's calls: how many brokers, the average / highest / lowest target, the newest call */
  function consensus(rows) {
    var t = rows.map(function (r) { return r.tgt; }).filter(isNum);
    var newest = rows.slice().sort(function (a, b) { return a.at < b.at ? 1 : -1; })[0] || null;
    return { calls: rows.length, brokers: Object.keys(rows.reduce(function (o, r) { o[r.br] = 1; return o; }, {})).length,
      avg: mean(t), hi: t.length ? Math.max.apply(null, t) : null, lo: t.length ? Math.min.apply(null, t) : null, newest: newest };
  }
  /** the calls of the newest `days` calendar days (counted back from the newest call) */
  function fresh(rows, days) {
    var newest = rows.reduce(function (m, r) { return r.day > m ? r.day : m; }, '');
    if (!newest) return [];
    var d = new Date(newest + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - (days || 3));
    var from = d.toISOString().slice(0, 10);
    return rows.filter(function (r) { return r.day > from; }).sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; });
  }

  /** owner, 26-Nov-2026 ("Show small Icon for Analytics signal near the Stock Name ... on every stock window, add this signal with
   *  upside target"): every stock's calls -> {SYM: {calls, brokers, buys, holds, sells, latest (each broker's newest call, newest
   *  first), newest, avg / hi / lo (targets of the brokers' newest Buy-type calls), reached (of those, already at their target),
   *  tone buy | hold | sell}} - a broker's older call on the stock is replaced by its newer one. */
  function index(rows) {
    var by = {}, out = {};
    rows.forEach(function (r) { if (r.sym) (by[r.sym] = by[r.sym] || []).push(r); });
    Object.keys(by).forEach(function (sym) {
      var list = by[sym].slice().sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; });
      var seen = {}, latest = [];
      list.forEach(function (r) { if (!seen[r.br]) { seen[r.br] = 1; latest.push(r); } });
      var buys = latest.filter(function (r) { return r.buy; });
      var sells = latest.filter(function (r) { return r.call === 'SELL' || r.call === 'REDUCE'; });
      var t = buys.map(function (r) { return r.tgt; }).filter(isNum);
      out[sym] = { calls: list.length, brokers: latest.length, buys: buys.length, sells: sells.length, holds: latest.length - buys.length - sells.length,
        latest: latest, newest: list[0], avg: mean(t), hi: t.length ? Math.max.apply(null, t) : null, lo: t.length ? Math.min.apply(null, t) : null,
        reached: buys.filter(function (r) { return E.reachK(r, 100) != null; }).length,
        tone: buys.length && buys.length >= sells.length ? 'buy' : sells.length ? 'sell' : 'hold' };
    });
    return out;
  }
  /** % from the price to the average Buy target (null without either) */
  function upside(info, price) { return info && isNum(info.avg) && price > 0 ? (info.avg / price - 1) * 100 : null; }

  var api = { COLS: COLS, BUYS: BUYS, CALL: CALL, SRC: SRC, WHY: WHY, STATUS: STATUS, DSTATUS: DSTATUS, objects: objects, pick: pick,
    kind: kind, rets: rets, stats: stats, scorecard: scorecard, callPrice: callPrice, fillPrice: fillPrice, needsCandles: needsCandles,
    consensus: consensus, fresh: fresh, mean: mean, index: index, upside: upside };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) { root.SB = root.SB || {}; root.SB.recos = api; }
})(typeof window !== 'undefined' ? window : null);
