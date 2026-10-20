/* Technical indicators. Candles [{t,o,h,l,c,v}] oldest first; every series
   function returns an array aligned to the candles with NaN where the value
   is not yet defined, and value[i] only uses bars 0..i (no look-ahead).

   Sheet-exact ports (Code.gs):
   - ema(): ab_computeEMA_ (SMA seed of the first `length` closes, k = 2/(n+1))
   - emaSupportTag(): ab_computeEmaSupportTag_ (10 / 21 EMA support, last 4 bars)
   - atrEma(): ab_computeATR14EMA_ (TR, SMA seed, EMA smoothing - not Wilder)
   Standard formulas (not used by the sheet, offered for strategy rules):
   sma, rsi (Wilder), macd (12/26/9), relVolume, breakout, pullback, swing levels. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.SB = root.SB || /** @type {any} */ ({})).indicators = factory();
})(/** @type {any} */ (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  function closes(c) { return c.map(function (x) { return x.c; }); }

  function sma(values, length) {
    var n = values.length, out = new Array(n).fill(NaN), sum = 0;
    for (var i = 0; i < n; i++) {
      sum += values[i];
      if (i >= length) sum -= values[i - length];
      if (i >= length - 1) out[i] = sum / length;
    }
    return out;
  }

  /** ab_computeEMA_ on closes (or any value array). */
  function emaValues(values, length) {
    var n = values.length, out = new Array(n).fill(NaN);
    if (n < length || length < 1) return out;
    var sum = 0;
    for (var i = 0; i < length; i++) sum += values[i];
    out[length - 1] = sum / length;
    var k = 2 / (length + 1);
    for (var j = length; j < n; j++) out[j] = values[j] * k + out[j - 1] * (1 - k);
    return out;
  }
  function ema(candles, length) { return emaValues(closes(candles), length); }

  /** ab_computeEmaSupportTag_ -> '' | '10 EMA Support (Today)' | '21 EMA Support (2d ago)' */
  function emaSupportTag(candles, length, touchPct) {
    var tp = touchPct == null ? 0.5 : touchPct;              // AB_EMA_SUPPORT_TOUCH_PCT
    var n = candles.length;
    if (n < length + 2) return '';
    var e = ema(candles, length);
    var lastN = Math.min(4, n - length), hitIdx = -1;
    for (var i = Math.max(length, n - lastN); i < n; i++) {
      if (isNaN(e[i]) || isNaN(e[i - 1])) continue;
      var wasAbove = candles[i - 1].c > e[i - 1];
      var touched = candles[i].l <= e[i] * (1 + tp / 100);
      var closedAbove = candles[i].c > e[i];
      if (wasAbove && touched && closedAbove) hitIdx = i;
    }
    if (hitIdx === -1) return '';
    var d = (n - 1) - hitIdx;
    return length + ' EMA Support ' + (d === 0 ? '(Today)' : '(' + d + 'd ago)');
  }

  function trueRange(candles) {
    var n = candles.length, tr = new Array(n).fill(NaN);
    if (!n) return tr;
    tr[0] = candles[0].h - candles[0].l;
    for (var i = 1; i < n; i++) {
      var pc = candles[i - 1].c;
      tr[i] = Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - pc), Math.abs(candles[i].l - pc));
    }
    return tr;
  }
  /** ab_computeATR14EMA_ as a series (the sheet stores only the last value). */
  function atrEma(candles, length) {
    length = length || 14;
    var n = candles.length, out = new Array(n).fill(NaN);
    if (n < length + 1) return out;
    var tr = trueRange(candles), sum = 0;
    for (var i = 0; i < length; i++) sum += tr[i];
    var atr = sum / length;
    out[length - 1] = atr;
    var k = 2 / (length + 1);
    for (var j = length; j < n; j++) { atr = tr[j] * k + atr * (1 - k); out[j] = atr; }
    return out;
  }
  function atrEmaLast(candles, length) {
    var s = atrEma(candles, length);
    return candles.length < (length || 14) + 1 ? NaN : s[s.length - 1];
  }

  /** Wilder RSI. */
  function rsi(candles, length) {
    length = length || 14;
    var c = closes(candles), n = c.length, out = new Array(n).fill(NaN);
    if (n <= length) return out;
    var g = 0, l = 0;
    for (var i = 1; i <= length; i++) { var d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
    var ag = g / length, al = l / length;
    out[length] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    for (var j = length + 1; j < n; j++) {
      var dd = c[j] - c[j - 1];
      ag = (ag * (length - 1) + (dd > 0 ? dd : 0)) / length;
      al = (al * (length - 1) + (dd < 0 ? -dd : 0)) / length;
      out[j] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
    return out;
  }

  /** MACD (fast EMA - slow EMA), signal EMA of MACD, histogram. */
  function macd(candles, fast, slow, signal) {
    fast = fast || 12; slow = slow || 26; signal = signal || 9;
    var c = closes(candles), f = emaValues(c, fast), s = emaValues(c, slow);
    var line = c.map(function (_, i) { return f[i] - s[i]; });
    var first = line.findIndex(function (v) { return !isNaN(v); });
    var sig = new Array(c.length).fill(NaN);
    if (first >= 0) {
      var sub = emaValues(line.slice(first), signal);
      for (var i = 0; i < sub.length; i++) sig[first + i] = sub[i];
    }
    return { macd: line, signal: sig, hist: line.map(function (v, i) { return v - sig[i]; }) };
  }

  /** Volume on bar i divided by the average of the previous `length` bars. */
  function relVolume(candles, length) {
    length = length || 20;
    var n = candles.length, out = new Array(n).fill(NaN);
    for (var i = length; i < n; i++) {
      var sum = 0, k = 0;
      for (var j = i - length; j < i; j++) if (candles[j].v > 0) { sum += candles[j].v; k++; }
      if (k && candles[i].v != null) out[i] = candles[i].v / (sum / k);
    }
    return out;
  }

  /** Highest high / lowest low of the `length` bars BEFORE bar i. */
  function priorHigh(candles, i, length) {
    var m = -Infinity;
    for (var j = Math.max(0, i - length); j < i; j++) m = Math.max(m, candles[j].h);
    return m === -Infinity ? NaN : m;
  }
  function priorLow(candles, i, length) {
    var m = Infinity;
    for (var j = Math.max(0, i - length); j < i; j++) m = Math.min(m, candles[j].l);
    return m === Infinity ? NaN : m;
  }

  /** Confirmed swing points up to bar i: a pivot at p needs `w` bars on each
   *  side, so only pivots with p + w <= i are visible at bar i. */
  function swingLevels(candles, i, w) {
    w = w || 3;
    var highs = [], lows = [];
    for (var p = w; p + w <= i; p++) {
      var isH = true, isL = true;
      for (var k = p - w; k <= p + w; k++) {
        if (k === p) continue;
        if (candles[k].h >= candles[p].h) isH = false;
        if (candles[k].l <= candles[p].l) isL = false;
      }
      if (isH) highs.push({ i: p, t: candles[p].t, price: candles[p].h });
      if (isL) lows.push({ i: p, t: candles[p].t, price: candles[p].l });
    }
    var px = candles[i].c;
    var res = highs.filter(function (h) { return h.price > px; }).sort(function (a, b) { return a.price - b.price; })[0] || null;
    var sup = lows.filter(function (l) { return l.price < px; }).sort(function (a, b) { return b.price - a.price; })[0] || null;
    return { support: sup, resistance: res, highs: highs, lows: lows };
  }

  return {
    sma: sma, emaValues: emaValues, ema: ema, emaSupportTag: emaSupportTag, trueRange: trueRange,
    atrEma: atrEma, atrEmaLast: atrEmaLast, rsi: rsi, macd: macd, relVolume: relVolume,
    priorHigh: priorHigh, priorLow: priorLow, swingLevels: swingLevels
  };
});
