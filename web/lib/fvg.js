/* Fair Value Gaps - a faithful port of Code.gs ab_longFvgDetail_ (~5092),
   ab_gapUpFvgs_ (~5471), ab_gapUpTags_, ab_isCircuitLocked_ (~5373),
   ab_avgTurnover_ (~5427) and ab_classifyMitigation_ (~14951).
   Bullish (long-only) like the sheet engine. Daily candles, oldest first:
   [{t,o,h,l,c,v}]. All functions only read bars up to the last one given -
   to evaluate "as of bar i" pass candles.slice(0, i + 1).

   Definitions (from the sheet):
   - 3-candle FVG on bar i: Low[i] > High[i-2] and the gap >= 0.70 x the
     14-bar average (High-Low) range ending at bar i. Zone = [High[i-2], Low[i]].
   - Touch: Low crosses under the active gap top (Low[i-1] >= top && Low[i] < top).
   - Confirm: Close crosses back above the High of the latest touch candle.
   - FVG+Spring: a Spring pair (patterns.js isSpringPair, the Spring pattern's
     thresholds) whose 2nd candle dips into ANY gap formed before the pair
     (touched or not) that still holds: no close below its bottom in between,
     Low <= top and Close >= bottom.
   - Twin Star Bottom + FVG: patterns.js isTwinStarBottom (red c1, two small
     candles holding the same low) whose stars reach into any gap formed before
     c1 that still holds (lowest star low <= top, both star closes >= bottom).
   - Gap-up FVG: Low[i] > High[i-1] by AB_GAPUP_MIN_PCT..AB_GAPUP_MAX_PCT %,
     neither candle circuit-locked; dropped once any later (non-locked)
     candle has Low <= top.
   Extra descriptive helpers (not in the sheet, clearly separate):
   fillState() says open / partially filled / fully filled, and
   bearishGaps() is the mirror rule, shown for information only. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./patterns.js'));
  else { var SB = root.SB = root.SB || /** @type {any} */ ({}); SB.fvg = factory(SB.patterns); }
})(/** @type {any} */ (typeof self !== 'undefined' ? self : this), function (P) {
  'use strict';

  var DEFAULTS = {
    AB_GAPUP_MIN_PCT: 3,
    AB_GAPUP_MAX_PCT: 5,            // workbook Control Panel value (code default is 10)
    AB_CIRCUIT_LOCK_RANGE_PCT: 0.05,
    AB_FVG_MIN_AVG_TURNOVER: 5000000,
    AB_GAPUP_NEAR_PCT: 0.5,
    AB_UNMIT_NEAR_PCT: 0.5,
    AB_GAPUP_MIN_AGE_DAYS: 1,
    AB_UNMIT_MIN_AGE_DAYS: 1
  };
  function cfgOf(cfg) {
    var o = {};
    Object.keys(DEFAULTS).forEach(function (k) { o[k] = cfg && cfg[k] != null ? cfg[k] : DEFAULTS[k]; });
    return o;
  }
  function S(c) { return { Opn: c.o, High: c.h, Low: c.l, Cls: c.c, Volume: c.v, t: c.t }; }

  function isCircuitLocked(c, cfg) {
    if (!c) return false;
    var hi = c.h, lo = c.l;
    if (isNaN(hi) || isNaN(lo) || lo <= 0) return false;
    return (hi - lo) / lo * 100 <= cfgOf(cfg).AB_CIRCUIT_LOCK_RANGE_PCT;
  }

  function avgTurnover(candles, cfg) {
    if (!candles || !candles.length) return NaN;
    var sum = 0, n = 0;
    candles.forEach(function (c) {
      if (isCircuitLocked(c, cfg)) return;
      var mid = (c.h + c.l) / 2;
      if (isNaN(mid) || mid <= 0 || isNaN(c.v) || c.v == null || c.v <= 0) return;
      sum += mid * c.v;
      n++;
    });
    return n ? sum / n : NaN;
  }

  /** ab_longFvgDetail_ -> { tags, unmitigated, events }. cfg: Spring keys of patterns.js DEFAULTS. */
  function longFvgDetail(candlesIn, cfgIn) {
    var candles = (candlesIn || []).map(S);
    var n = candles.length;
    if (n < 17) return { tags: [], unmitigated: null, events: [] };
    var minDeviation = new Array(n).fill(NaN);
    var i, k;
    for (i = 13; i < n; i++) {
      var sum = 0;
      for (k = i - 13; k <= i; k++) sum += (candles[k].High - candles[k].Low);
      minDeviation[i] = 0.70 * (sum / 14);
    }
    var isFVGUp = new Array(n).fill(false), fvgTop = new Array(n).fill(NaN), curTop = NaN;
    for (i = 0; i < n; i++) {
      var up = false;
      if (i >= 2 && !isNaN(minDeviation[i])) {
        var low = candles[i].Low, highTwoBack = candles[i - 2].High;
        if (low > highTwoBack && (low - highTwoBack) >= minDeviation[i]) up = true;
      }
      isFVGUp[i] = up;
      if (up) curTop = candles[i].Low;
      fvgTop[i] = curTop;
    }
    var longCont2 = new Array(n).fill(false), cont2High = new Array(n).fill(NaN), curCont2High = NaN;
    for (i = 1; i < n; i++) {
      if (!isNaN(fvgTop[i - 1]) && !isNaN(fvgTop[i]) && candles[i - 1].Low >= fvgTop[i - 1] && candles[i].Low < fvgTop[i]) longCont2[i] = true;
      if (longCont2[i]) curCont2High = candles[i].High;
      cont2High[i] = curCont2High;
    }
    var longCont2Conf = new Array(n).fill(false);
    for (i = 1; i < n; i++) {
      if (!isNaN(cont2High[i - 1]) && !isNaN(cont2High[i]) && candles[i - 1].Cls <= cont2High[i - 1] && candles[i].Cls > cont2High[i]) longCont2Conf[i] = true;
    }
    // FVG+Spring (ab_longFvgDetail_): Spring pair i-1 -> i dipping into a gap formed before it that still holds
    var sc = cfgIn || {}, D = P.DEFAULTS;
    var springCfg = {
      bodyMin: sc.AB_SPRING_BODY_MIN_PCT != null ? sc.AB_SPRING_BODY_MIN_PCT : D.AB_SPRING_BODY_MIN_PCT,
      day2BodyMax: sc.AB_SPRING_DAY2_BODY_MAX_PCT != null ? sc.AB_SPRING_DAY2_BODY_MAX_PCT : D.AB_SPRING_DAY2_BODY_MAX_PCT,
      undercut: sc.AB_SPRING_UNDERCUT_PCT != null ? sc.AB_SPRING_UNDERCUT_PCT : D.AB_SPRING_UNDERCUT_PCT,
      reclaimMax: sc.AB_SPRING_RECLAIM_MAX_PCT != null ? sc.AB_SPRING_RECLAIM_MAX_PCT : D.AB_SPRING_RECLAIM_MAX_PCT
    };
    var springSignal = new Array(n).fill(false);
    for (i = 3; i < n; i++) {
      if (!P.isSpringPair(candles[i - 1], candles[i], springCfg)) continue;
      var c2 = candles[i];
      for (var g = 2; g <= i - 2 && !springSignal[i]; g++) {
        if (!isFVGUp[g]) continue;
        var gTop = candles[g].Low, gBottom = candles[g - 2].High;
        if (!(c2.Low <= gTop && c2.Cls >= gBottom)) continue;
        var holds = true;
        for (k = g + 1; k <= i - 2; k++) if (candles[k].Cls < gBottom) { holds = false; break; }
        if (holds) springSignal[i] = true;
      }
    }
    // Twin Star Bottom + FVG (ab_longFvgDetail_): c1 = i-2, stars i-1 and i, into a gap formed before c1 that still holds
    var twinSignal = new Array(n).fill(false);
    for (i = 4; i < n; i++) {
      var s1 = candles[i - 1], s2 = candles[i];
      if (!P.isTwinStarBottom(candles[i - 2], s1, s2)) continue;
      var starLow = Math.min(s1.Low, s2.Low);
      for (var g2 = 2; g2 <= i - 3 && !twinSignal[i]; g2++) {
        if (!isFVGUp[g2]) continue;
        var tTop = candles[g2].Low, tBottom = candles[g2 - 2].High;
        if (!(starLow <= tTop && s1.Cls >= tBottom && s2.Cls >= tBottom)) continue;
        var tHolds = true;
        for (k = g2 + 1; k <= i - 3; k++) if (candles[k].Cls < tBottom) { tHolds = false; break; }
        if (tHolds) twinSignal[i] = true;
      }
    }
    var ftSignal = new Array(n).fill(false), ftState = 0, cur;
    for (i = 0; i < n; i++) {
      cur = (ftState === 2) ? 0 : ftState;
      if (isFVGUp[i] && cur === 0) cur = 1;
      if (longCont2[i] && cur === 1) cur = 2;
      ftSignal[i] = (cur === 2);
      ftState = cur;
    }
    var ftcSignal = new Array(n).fill(false), ftcState = 0;
    for (i = 0; i < n; i++) {
      cur = (ftcState === 3) ? 0 : ftcState;
      if (isFVGUp[i] && cur === 0) cur = 1;
      if (longCont2[i] && cur === 1) cur = 2;
      if (longCont2Conf[i] && cur === 2) cur = 3;
      ftcSignal[i] = (cur === 3);
      ftcState = cur;
    }
    var lastN = Math.min(4, n), touchIdx = -1, confIdx = -1, springIdx = -1, twinIdx = -1;
    for (i = n - lastN; i < n; i++) {
      if (ftSignal[i]) touchIdx = i;
      if (ftcSignal[i]) confIdx = i;
      if (springSignal[i]) springIdx = i;
      if (twinSignal[i]) twinIdx = i;
    }
    var lastGapIdx = -1;
    for (i = 0; i < n; i++) if (isFVGUp[i]) lastGapIdx = i;
    var unmitigated = false;
    if (lastGapIdx !== -1) {
      unmitigated = true;
      for (i = lastGapIdx + 1; i < n; i++) if (longCont2[i]) { unmitigated = false; break; }
    }
    function rec(idx) { var d = (n - 1) - idx; return d === 0 ? '(Today)' : '(' + d + 'd ago)'; }
    var tags = [];
    if (touchIdx !== -1) tags.push('FVG First Touch ' + rec(touchIdx));
    if (confIdx !== -1) tags.push('FVG First Touch Confirmed ' + rec(confIdx));
    if (springIdx !== -1) tags.push('FVG+Spring ' + rec(springIdx));
    if (twinIdx !== -1) tags.push('Twin Star Bottom + FVG ' + rec(twinIdx));
    var zone = null;
    if (unmitigated) {
      var daysAgo = (n - 1) - lastGapIdx;
      tags.push('FVG Unmitigated ' + (daysAgo === 0 ? '(formed today)' : '(formed ' + daysAgo + 'd ago)'));
      var bottom = lastGapIdx >= 2 ? candles[lastGapIdx - 2].High : NaN, top = candles[lastGapIdx].Low;
      if (!isNaN(bottom) && !isNaN(top) && bottom > 0 && top > bottom) {
        zone = { kind: 'FVG', bottom: bottom, top: top, pct: Math.round((top - bottom) / bottom * 10000) / 100, formedIdx: lastGapIdx, formed: candles[lastGapIdx].t, daysAgo: daysAgo };
      }
    }
    var events = [];
    for (i = 0; i < n; i++) {
      if (isFVGUp[i]) events.push({ i: i, t: candles[i].t, type: 'gap', top: candles[i].Low, bottom: candles[i - 2].High });
      if (ftSignal[i]) events.push({ i: i, t: candles[i].t, type: 'first-touch', top: fvgTop[i] });
      if (ftcSignal[i]) events.push({ i: i, t: candles[i].t, type: 'confirmed' });
      if (springSignal[i]) events.push({ i: i, t: candles[i].t, type: 'fvg-spring' });
      if (twinSignal[i]) events.push({ i: i, t: candles[i].t, type: 'fvg-twinstar' });
    }
    return { tags: tags, unmitigated: zone, events: events };
  }

  /** ab_gapUpFvgs_ -> untouched gap-up zones, newest first */
  function gapUpFvgs(candles, cfgIn) {
    var cfg = cfgOf(cfgIn), out = [], n = (candles || []).length;
    if (n < 2) return out;
    for (var i = 1; i < n; i++) {
      if (isCircuitLocked(candles[i - 1], cfg) || isCircuitLocked(candles[i], cfg)) continue;
      var prevHigh = candles[i - 1].h, low = candles[i].l;
      if (isNaN(prevHigh) || isNaN(low) || prevHigh <= 0) continue;
      if (low <= prevHigh) continue;
      var pct = (low - prevHigh) / prevHigh * 100;
      if (pct < cfg.AB_GAPUP_MIN_PCT || pct > cfg.AB_GAPUP_MAX_PCT) continue;
      var touched = false;
      for (var j = i + 1; j < n; j++) {
        if (isCircuitLocked(candles[j], cfg)) continue;
        if (!isNaN(candles[j].l) && candles[j].l <= low) { touched = true; break; }
      }
      if (touched) continue;
      out.push({ kind: 'Gap-up', bottom: prevHigh, top: low, pct: Math.round(pct * 100) / 100, formedIdx: i, formed: candles[i].t, daysAgo: (n - 1) - i });
    }
    out.reverse();
    return out;
  }
  function gapUpTags(candles, cfg) {
    return gapUpFvgs(candles, cfg).map(function (g) {
      return 'Gap-up FVG ' + g.pct + '% ' + (g.daysAgo === 0 ? '(today)' : '(' + g.daysAgo + 'd ago)');
    });
  }

  /** Main/PatternData 'FVG' column text for the latest bar (col X). */
  function columnTags(candles, cfg) {
    return longFvgDetail(candles).tags.concat(gapUpTags(candles, cfg)).join(', ');
  }

  /** Watch zones as the GapUpFVG / UnmitigatedFVG tabs build them: liquidity
   *  filter, gap-ups first, the 3-candle zone only when no gap-up is watched. */
  function watchZones(candles, cfgIn) {
    var cfg = cfgOf(cfgIn);
    var t = avgTurnover(candles, cfg);
    var illiquid = !isNaN(t) && t < cfg.AB_FVG_MIN_AVG_TURNOVER;
    if (illiquid) return { zones: [], illiquid: true, turnover: t };
    var gaps = gapUpFvgs(candles, cfg);
    var zones = gaps.slice();
    if (!gaps.length) {
      var z = longFvgDetail(candles).unmitigated;
      if (z) zones.push(z);
    }
    return { zones: zones, illiquid: false, turnover: t };
  }

  /** Approach rule of ab_checkZoneAlerts_: price within near% above the top and above the bottom. */
  function approachState(price, zone, cfgIn) {
    var cfg = cfgOf(cfgIn);
    if (!(price > 0) || !zone) return null;
    var near = zone.kind === 'Gap-up' ? cfg.AB_GAPUP_NEAR_PCT : cfg.AB_UNMIT_NEAR_PCT;
    var nearLine = zone.top * (1 + near / 100);
    return {
      approaching: price <= nearLine && price > zone.bottom,
      inZone: price <= zone.top && price > zone.bottom,
      mitigated: price <= zone.top,
      distancePct: (price - zone.top) / zone.top * 100
    };
  }

  /** ab_classifyMitigation_ - how the candle behaved against the zone. */
  function classifyMitigation(zone, c) {
    if (!c || isNaN(c.l) || isNaN(c.c) || !zone || isNaN(zone.top) || isNaN(zone.bottom) || zone.top <= zone.bottom) return 'nodata';
    var closeKind = c.c > zone.top ? 'above' : c.c >= zone.bottom ? 'inside' : 'below';
    var openedInside = c.o != null && !isNaN(c.o) && c.o <= zone.top && c.o >= zone.bottom;
    if (openedInside && c.c > c.o) return 'openin';
    if (closeKind === 'below') return 'broken';
    if (c.l < zone.bottom) return 'swept';
    if (c.c > zone.top) return 'held';
    return 'inside';
  }
  var MIT_LABELS = {
    openin: 'Opened inside the zone & closed green', held: 'Held - tested the zone, closed above it',
    swept: 'Swept through & reclaimed', inside: 'Closed inside the zone', broken: 'Broke below - closed under the zone',
    nodata: 'No end-of-day candle', spring: 'Spring Pattern'
  };

  /** Descriptive fill state of a bullish zone over the candles after it formed. */
  function fillState(zone, candles) {
    if (!zone) return null;
    var minLow = Infinity;
    for (var i = zone.formedIdx + 1; i < candles.length; i++) if (candles[i].l < minLow) minLow = candles[i].l;
    if (minLow === Infinity || minLow > zone.top) return 'open';
    if (minLow > zone.bottom) return 'partially filled';
    return 'fully filled';
  }

  /** Mirror rule (bearish 3-candle gap: High[i] < Low[i-2]) - informational only,
   *  NOT part of the sheet strategy. Returns gaps not yet traded back into. */
  function bearishGaps(candles, lookback) {
    var out = [], n = (candles || []).length, from = Math.max(2, n - (lookback || 30));
    for (var i = from; i < n; i++) {
      var top = candles[i - 2].l, bottom = candles[i].h;
      if (!(bottom < top)) continue;
      var filled = false;
      for (var j = i + 1; j < n; j++) if (candles[j].h >= bottom) { filled = true; break; }
      if (!filled) out.push({ kind: 'Bearish FVG', bottom: bottom, top: top, pct: Math.round((top - bottom) / bottom * 10000) / 100, formedIdx: i, formed: candles[i].t, daysAgo: n - 1 - i });
    }
    return out.reverse();
  }

  return {
    DEFAULTS: DEFAULTS, isCircuitLocked: isCircuitLocked, avgTurnover: avgTurnover, longFvgDetail: longFvgDetail,
    gapUpFvgs: gapUpFvgs, gapUpTags: gapUpTags, columnTags: columnTags, watchZones: watchZones,
    approachState: approachState, classifyMitigation: classifyMitigation, MIT_LABELS: MIT_LABELS,
    fillState: fillState, bearishGaps: bearishGaps
  };
});
