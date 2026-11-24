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
    'pg', 'hh', 'dd', 'cl', 'ix', 'now', 'ph', 'pc', 'kn', 'kdn'];
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
      near(r, ok);
      r.buy = BUYS.indexOf(r.call) >= 0;
      r.day = String(r.at || '').slice(0, 10);
      r.srcs = String(r.src || '').split(',').filter(Boolean);
      return r;
    });
  }
  /** the 'within 2 % of the target' rule (E.NEAR) in kp / kd after the 6 '% of the way' entries: the laptop's own kn / kdn,
   *  else (a list made before it sent them - kdn null) the first '% of the way' at or past that level - never earlier than
   *  the real day, so a call is never counted as reached too soon */
  function near(r, ok) {
    var i = E.THRESH.length;
    r.nearGuess = false;
    if (!ok) { r.kp[i] = null; r.kd[i] = ''; return; }
    if (r.kdn !== null && r.kdn !== undefined) { r.kp[i] = isNum(r.kn) ? r.kn : null; r.kd[i] = r.kn ? r.kdn || '' : ''; return; }
    var d = r.tgt - r.ep, p = d ? (E.level(r, E.NEAR) - r.ep) / d * 100 : 0, t = 0;
    while (t < i - 1 && E.THRESH[t] < p - 1e-9) t++;
    r.kp[i] = isNum(r.kp[t]) ? r.kp[t] : null;
    r.kd[i] = r.kd[t] || '';
    r.nearGuess = true;
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
  /** every broker: SB.epst.stats of its long calls + the average close after 30 / 60 / 90 sessions + its calls in all */
  function scorecard(rows, W, T, min) {
    var m = {};
    rows.forEach(function (r) { (m[r.br] = m[r.br] || []).push(r); });
    return Object.keys(m).map(function (b) {
      var s = E.stats(m[b], W, T);
      s.label = b;
      s.calls = m[b].length;
      s.checked = m[b].filter(function (r) { return r.st === 'ok'; }).length;
      s.stocks = Object.keys(m[b].reduce(function (o, r) { if (r.sym) o[r.sym] = 1; return o; }, {})).length;
      var rr = rets(m[b]);
      s.r30 = rr[0]; s.r60 = rr[1]; s.r90 = rr[2];
      s.ranked = s.done >= (min || 3);
      return s;
    }).sort(function (a, b) {
      return (b.ranked - a.ranked) || ((b.rate == null ? -1 : b.rate) - (a.rate == null ? -1 : a.rate)) || (b.done - a.done) || (b.calls - a.calls);
    });
  }
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

  var api = { COLS: COLS, BUYS: BUYS, CALL: CALL, SRC: SRC, WHY: WHY, STATUS: STATUS, DSTATUS: DSTATUS, objects: objects, pick: pick,
    kind: kind, rets: rets, scorecard: scorecard, consensus: consensus, fresh: fresh, mean: mean };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) { root.SB = root.SB || {}; root.SB.recos = api; }
})(typeof window !== 'undefined' ? window : null);
