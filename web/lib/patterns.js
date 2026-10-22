/* Candlestick patterns - a faithful port of Code.gs updateAllCandlestickPatterns,
   ab_isSpringPair_ and ab_isHaramiInvHammerPair_. Same tags, same order,
   same thresholds, same strict/inclusive comparisons. Only bullish patterns
   exist in the sheet engine.
   Candles: [{t,o,h,l,c,v}] oldest first. patternsAt(candles, i) evaluates bar i
   as "Today" (i-1 = Yesterday, i-2 = ThirdDay, i-3 = Day4) and never reads i+1. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.SB = root.SB || /** @type {any} */ ({})).patterns = factory();
})(/** @type {any} */ (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  // Control Panel keys and their coded defaults (Code.gs ab_springCfg_ / ab_setting_)
  var DEFAULTS = {
    AB_SPRING_BODY_MIN_PCT: 0.5,
    AB_SPRING_DAY2_BODY_MAX_PCT: 30,
    AB_SPRING_UNDERCUT_PCT: 0.10,
    AB_SPRING_RECLAIM_MAX_PCT: 50,
    AB_SPRINGQ_BODY_MIN_PCT: 1.5,
    AB_SPRINGQ_WICK_MAX_PCT: 25,
    AB_HARAMI_REQUIRE_SMALLER: true,
    AB_ENGULFING_REQUIRE_BIGGER: true
  };
  var ORDER = ['Spring', 'Piercing', 'Bullish Engulfing', 'Bullish Harami', 'Tweezer Bottoms', 'Spring?',
    'Three Day Low Rejection', 'Morningstar', 'Trio', 'FVG 1234', 'FVG 123', 'FVG 123 Type 2', 'FVGTouch',
    'Bullish Harami + Inverted Hammer', 'Bullish Harami + Inverted Hammer (confirmed)'];
  // Code.gs AB_HIH_* (Bullish Harami + Inverted Hammer)
  var HIH = { c1BodyMin: 0.65, bodyMin: 0.25, bodyMax: 0.50, openTol: 0.005, upperWickMin: 1.5, lowerWickMax: 0.10, highOverMax: 0.15 };

  function cfgOf(cfg) {
    var o = {};
    Object.keys(DEFAULTS).forEach(function (k) { o[k] = cfg && cfg[k] != null ? cfg[k] : DEFAULTS[k]; });
    return o;
  }
  // Code.gs toNum(): val ? Number(val) : NaN  (0, '', null -> NaN)
  function toNum(v) { return v ? Number(v) : NaN; }
  function sheetCandle(c) {
    return c ? { Opn: toNum(c.o), High: toNum(c.h), Low: toNum(c.l), Cls: toNum(c.c) } : null;
  }

  /** ab_isSpringPair_: c1 (big red) -> c2. Candles {Opn,High,Low,Cls}. */
  function isSpringPair(c1, c2, cfg) {
    var v = [c1.Opn, c1.High, c1.Low, c1.Cls, c2.Opn, c2.High, c2.Low, c2.Cls];
    if (v.some(function (x) { return typeof x !== 'number' || isNaN(x); })) return false;
    var c1Body = Math.abs(c1.Cls - c1.Opn);
    var c1Range = c1.High - c1.Low;
    return (c1.Cls < c1.Opn) &&
      (c1Body / c1.Opn >= cfg.bodyMin / 100) &&
      (c2.Low < c1.Low) &&
      (c2.Cls > c1.Low) &&
      (Math.abs(c2.Cls - c2.Opn) < (cfg.day2BodyMax / 100) * c1Body) &&
      (c2.Low <= c1.Low * (1 - cfg.undercut / 100)) &&
      (c2.High <= c1.Low + (cfg.reclaimMax / 100) * c1Range);
  }

  /** ab_isHaramiInvHammerPair_: c1 big red, c2 small green inside c1's lower body half
   *  with a long upper wick reaching at least c1's open (at most 15% of c1's body above c1's high), almost no lower wick and
   *  its low never below c1's low. Candles {Opn,High,Low,Cls}. */
  function isHaramiInvHammerPair(c1, c2) {
    var v = [c1.Opn, c1.High, c1.Low, c1.Cls, c2.Opn, c2.High, c2.Low, c2.Cls];
    if (v.some(function (x) { return typeof x !== 'number' || isNaN(x); })) return false;
    var c1Body = c1.Opn - c1.Cls, c1Range = c1.High - c1.Low;
    var c2Body = c2.Cls - c2.Opn, c2Range = c2.High - c2.Low;
    if (!(c1Body > 0 && c1Range > 0 && c2Body > 0 && c2Range > 0)) return false;
    return (c1Body / c1Range >= HIH.c1BodyMin) &&
      (c2Body >= HIH.bodyMin * c1Body) && (c2Body <= HIH.bodyMax * c1Body) &&
      (Math.abs(c2.Opn - c1.Cls) <= HIH.openTol * c1.Cls) &&
      (c2.Cls <= (c1.Opn + c1.Cls) / 2) &&
      (c2.High - c2.Cls >= HIH.upperWickMin * c2Body) &&
      (c2.High >= c1.Opn) && (c2.High <= c1.High + HIH.highOverMax * c1Body) &&
      (c2.Opn - c2.Low <= HIH.lowerWickMax * c2Range) &&
      (c2.Low >= c1.Low);
  }

  /** Tags for bar i, in the sheet's fixed order. Returns [] when bar i is missing. */
  function patternsAt(candles, i, cfgIn) {
    var cfg = cfgOf(cfgIn);
    var springCfg = { bodyMin: cfg.AB_SPRING_BODY_MIN_PCT, day2BodyMax: cfg.AB_SPRING_DAY2_BODY_MAX_PCT, undercut: cfg.AB_SPRING_UNDERCUT_PCT, reclaimMax: cfg.AB_SPRING_RECLAIM_MAX_PCT };
    var LOW_EQUAL_TOL = 0.0125, BODY_SIM_TOL = 0.25, WICK_SIM_TOL = 0.30, BODY_SIZE_THRESHOLD = 0.01;
    var tRow = i >= 0 ? sheetCandle(candles[i]) : null;
    var yRow = i >= 1 ? sheetCandle(candles[i - 1]) : null;
    var thRow = i >= 2 ? sheetCandle(candles[i - 2]) : null;
    var d4Row = i >= 3 ? sheetCandle(candles[i - 3]) : null;
    var all = [];
    var c1Body, c2Body, c3Body, c1, c2, c3, c4;

    if (yRow && tRow) {
      var c1Open = yRow.Opn, c1High = yRow.High, c1Low = yRow.Low, c1Close = yRow.Cls;
      var c2Open = tRow.Opn, c2High = tRow.High, c2Low = tRow.Low, c2Close = tRow.Cls;
      if (![c1Open, c1High, c1Low, c1Close, c2Open, c2High, c2Low, c2Close].some(isNaN)) {
        c1Body = Math.abs(c1Close - c1Open);
        if (isSpringPair(yRow, tRow, springCfg)) all.push('Spring');
        if ((c1Close < c1Open) && (c2Open < c1Low) && (c2Close > (c1Open + c1Close) / 2) && (c2Close < c1Open)) all.push('Piercing');
        c2Body = Math.abs(c2Close - c2Open);
        var c1LowerWick = Math.min(c1Open, c1Close) - c1Low;
        var c2LowerWick = Math.min(c2Open, c2Close) - c2Low;
        var engulfing = false;
        if (c1Close < c1Open && c2Close > c2Open) {
          var e1 = (c2Open <= c1Close && c2Close >= c1Open);
          var e2 = cfg.AB_ENGULFING_REQUIRE_BIGGER ? (c2Body > c1Body) : true;
          if (e1 && e2) { all.push('Bullish Engulfing'); engulfing = true; }
        }
        if (!engulfing && c1Close < c1Open && c2Close > c2Open) {
          var h1 = (c2Open >= c1Close && c2Close <= c1Open);
          var h2 = (c2Low > c1Low);
          var h3 = cfg.AB_HARAMI_REQUIRE_SMALLER ? (c2Body < c1Body) : true;
          if (h1 && h2 && h3) all.push('Bullish Harami');
        }
        if (c1Close < c1Open && c2Close > c2Open) {
          var avgLow = (c1Low + c2Low) / 2 || 1;
          var lowsEqual = Math.abs(c1Low - c2Low) <= avgLow * LOW_EQUAL_TOL;
          var bodiesSimilar = (Math.abs(c1Body - c2Body) <= Math.max(c1Body, c2Body) * BODY_SIM_TOL);
          var wicksSimilar = (Math.abs(c1LowerWick - c2LowerWick) <= Math.max(c1LowerWick, c2LowerWick) * WICK_SIM_TOL);
          var wickPresent = (c1LowerWick > 0 && c2LowerWick > 0);
          if (lowsEqual && bodiesSimilar && wicksSimilar && wickPresent) all.push('Tweezer Bottoms');
        }
      }
    }

    if (tRow) {
      var open = tRow.Opn, high = tRow.High, low = tRow.Low, close = tRow.Cls;
      if (![open, high, low, close].some(isNaN)) {
        var body = Math.abs(close - open);
        var candleSize = high - low;
        var lowerWick = Math.min(open, close) - low;
        var bigBearQ = close < open && (body / open >= cfg.AB_SPRINGQ_BODY_MIN_PCT / 100);
        var wickSmallQ = (lowerWick / candleSize) <= cfg.AB_SPRINGQ_WICK_MAX_PCT / 100;
        if (bigBearQ && wickSmallQ) all.push('Spring?');
      }
    }

    if (thRow && yRow && tRow) {
      // Three Day Low Rejection (High not used)
      var a1o = thRow.Opn, a1l = thRow.Low, a1c = thRow.Cls, a2o = yRow.Opn, yLow = yRow.Low, a2c = yRow.Cls, a3o = tRow.Opn, tLow = tRow.Low, a3c = tRow.Cls;
      if (![a1o, a1l, a1c, a2o, yLow, a2c, a3o, tLow, a3c].some(isNaN)) {
        var b1 = Math.abs(a1c - a1o), b2 = Math.abs(a2c - a2o), b3 = Math.abs(a3c - a3o);
        if (a1c < a1o && a2c < a2o && a3c < a3o && b1 / a1o >= BODY_SIZE_THRESHOLD && b2 / a2o >= BODY_SIZE_THRESHOLD && b3 / a3o >= BODY_SIZE_THRESHOLD) {
          if ((yLow < a1l) && (a2c > a1l) && (tLow < yLow) && (a3c > yLow)) all.push('Three Day Low Rejection');
        }
      }
      var m = [thRow.Opn, thRow.High, thRow.Low, thRow.Cls, yRow.Opn, yRow.High, yRow.Low, yRow.Cls, tRow.Opn, tRow.High, tRow.Low, tRow.Cls];
      if (!m.some(isNaN)) {
        // Morningstar
        c1 = thRow; c2 = yRow; c3 = tRow;
        c1Body = Math.abs(c1.Cls - c1.Opn); c2Body = Math.abs(c2.Cls - c2.Opn); c3Body = Math.abs(c3.Cls - c3.Opn);
        var bigBear = (c1.Cls < c1.Opn) && (c1Body / c1.Opn >= 0.02);
        var wickSmall = ((Math.min(c1.Opn, c1.Cls) - c1.Low) / (c1.High - c1.Low)) <= 0.3;
        var smallBodyDay2 = (c2Body / c1Body) <= 0.3;
        var bullishDay3 = (c3.Cls > c3.Opn) && (c3Body / c3.Opn >= 0.02);
        var c3CloseIntoC1Body = c3.Cls >= (c1.Opn + c1.Cls) / 2;
        if (bigBear && wickSmall && smallBodyDay2 && bullishDay3 && c3CloseIntoC1Body) all.push('Morningstar');
        // Trio
        var c1Large = c1Body / c1.Opn >= 0.03;
        var t1 = (c1.Cls < c1.Opn), t3 = (c2.Low < c1.Low), t4 = (c2.Cls > c1.Low);
        var t5 = (Math.abs(c2.Cls - c2.Opn) < 0.3 * c1Body), t6 = (c2.Low <= c1.Low * (1 - 0.0025));
        var t7 = (c2.High <= c1.High + (0.4 * c1Body));
        var breaks = (c3.Low < c2.Low) && (c3.Low < c1.Low), closesAbove = (c3.Cls > c2.Low) && (c3.Cls > c1.Low);
        if (t1 && c1Large && t3 && t4 && t5 && t6 && t7 && breaks && closesAbove) all.push('Trio');
      }
    }

    if (d4Row && thRow && yRow && tRow) {
      c1 = d4Row; c2 = thRow; c3 = yRow; c4 = tRow;
      c1Body = Math.abs(c1.Cls - c1.Opn); c2Body = Math.abs(c2.Cls - c2.Opn); c3Body = Math.abs(c3.Cls - c3.Opn);
      var c4Body = Math.abs(c4.Cls - c4.Opn);
      if (![c1.Opn, c1.Cls, c2.Opn, c2.Low, c2.Cls, c3.High, c3.Low, c3.Opn, c3.Cls, c4.High, c4.Low, c4.Opn, c4.Cls].some(isNaN)) {
        var lw = Math.min(c2.Opn, c2.Cls) - c2.Low, uw = c2.High - Math.max(c2.Opn, c2.Cls);
        if (c1.Cls > c1.Opn && c1Body / c1.Opn >= 0.02 &&
            c2.Cls > c2.Opn && c2Body / c2.Opn >= 0.01 &&
            lw <= 0.01 * c2.Opn && uw <= 0.003 * c2.Cls &&
            c2.Low > c1.Opn &&
            c3.Cls < c3.Opn && Math.abs(c3Body - c2Body) <= Math.max(c2Body, c3Body) * 0.15 && c3.High <= c2.High && c3.Low >= c2.Low &&
            c4.Cls > c4.Opn && c4Body > c3Body && c4.High <= c2.High && (c4.Low >= c1.Opn) && (c4.Low <= c2.Low)) {
          all.push('FVG 1234');
        }
      }
    }

    if (thRow && yRow && tRow) {
      c1 = thRow; c2 = yRow; c3 = tRow;
      c1Body = Math.abs(c1.Cls - c1.Opn); c2Body = Math.abs(c2.Cls - c2.Opn); c3Body = Math.abs(c3.Cls - c3.Opn);
      var g = [c1.Opn, c1.Cls, c2.Opn, c2.Cls, c2.Low, c2.High, c3.Opn, c3.Cls, c3.High, c3.Low];
      if (!g.some(isNaN)) {
        var lw2 = Math.min(c2.Opn, c2.Cls) - c2.Low, uw2 = c2.High - Math.max(c2.Opn, c2.Cls);
        var base = c1.Cls > c1.Opn && c1Body / c1.Opn >= 0.02 && c2.Low > c1.Opn;
        // FVG 123
        if (base && c2.Cls > c2.Opn && c2Body / c2.Opn >= 0.005 && lw2 <= 0.015 * c2.Opn && uw2 <= 0.03 * c2.Cls &&
            c3.Cls < c3.Opn && Math.abs(c3Body - c2Body) <= Math.max(c2Body, c3Body) * 0.50 && c3.High <= c2.High &&
            (c3.Low >= c1.Opn) && (c3.Low <= c2.Low) && c3.Cls >= c2.Low) {
          all.push('FVG 123');
        }
        // FVG 123 Type 2 - as coded: the variable named "c3Bearish" tests c3.Cls > c2.Low
        if (base && c2.Cls > c2.Opn && c2Body / c2.Opn >= 0.005 && lw2 <= 0.015 * c2.Opn && uw2 <= 0.03 * c2.Cls &&
            c3.Cls > c2.Low && Math.abs(c3Body - c2Body) <= Math.max(c2Body, c3Body) * 0.50 &&
            (c3.Low >= c1.Opn) && (c3.Low <= c2.Low) && c3.Cls >= c2.Low) {
          all.push('FVG 123 Type 2');
        }
        // FVGTouch
        if (base && c2Body / c2.Opn <= 0.01 && lw2 <= 0.02 * c2.Opn && uw2 <= 0.02 * c2.Cls &&
            c3.Cls < c3.Opn && c3.Opn < c2.High && (c3.Low >= c1.Opn) && (c3.Low <= c2.Low) && c3.Cls >= c2.Low) {
          all.push('FVGTouch');
        }
      }
    }

    // Bullish Harami + Inverted Hammer: today's pair, and yesterday's pair confirmed by today's close
    if (yRow && tRow && isHaramiInvHammerPair(yRow, tRow)) all.push('Bullish Harami + Inverted Hammer');
    if (thRow && yRow && tRow && isHaramiInvHammerPair(thRow, yRow) && tRow.Cls > yRow.High) {
      all.push('Bullish Harami + Inverted Hammer (confirmed)');
    }
    return all;
  }

  /** Tags for the latest bar, joined like PatternData col W. */
  function latestTags(candles, cfg) {
    if (!candles || !candles.length) return '';
    return patternsAt(candles, candles.length - 1, cfg).join(', ');
  }

  // A tag list "A, B (x, y), C" -> ['A','B (x, y)','C'] (Code.gs ab_pdSplit_)
  function splitTags(s) {
    return String(s || '').split(/,(?![^()]*\))/).map(function (x) { return x.trim(); }).filter(Boolean);
  }

  return { DEFAULTS: DEFAULTS, ORDER: ORDER, HIH: HIH, isSpringPair: isSpringPair, isHaramiInvHammerPair: isHaramiInvHammerPair,
    patternsAt: patternsAt, latestTags: latestTags, splitTags: splitTags };
});
