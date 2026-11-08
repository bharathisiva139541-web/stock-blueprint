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
   - FVG+Spring (owner, 08-Nov-2026, checked with him on a picture): a Spring
     pair (patterns.js isSpringPair, the Spring pattern's thresholds) whose
     2nd candle sits on a 3-candle FVG or a Gap-up zone formed before the pair
     that still holds (no close below its bottom before the pair): its low
     anywhere in the zone or below the bottom line (any depth), its close
     above the bottom line, and NO candle from the zone's formation to the
     red candle closed below the Spring candle's low (the red candle itself
     is excepted). Any touch. `where` = top (low in the upper half) / middle /
     bottom (low at or under the bottom line). The oldest such zone is taken
     (an FVG before a Gap-up formed on the same candle). A Spring is dropped
     from the tags once a later candle closes below its low (events keep it,
     with `broken` = that candle's index).
   - Twin Star Bottom + FVG: patterns.js isTwinStarBottom (red c1, two small
     candles holding the same low) whose stars reach into any gap formed before
     c1 that still holds (lowest star low <= top, both star closes >= bottom).
   - Gap-up FVG + Spring (owner, 08-Nov-2026, split from FVG+Spring): the
     same Spring rule on a Gap-up zone (FVG+Spring = 3-candle FVGs only);
     "inside FVG" when the gap-up zone lies in a 3-candle FVG (gapInsideFvg).
   - Gap-up FVG: Low[i] > High[i-1] by AB_GAPUP_MIN_PCT..AB_GAPUP_MAX_PCT %,
     neither candle circuit-locked. Owner, 08-Nov-2026: the first later
     (non-locked) candle with Low <= top MITIGATES it (touchIdx, one email);
     it stays valid until a later candle CLOSES below the bottom.
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

  /** The zones a Spring can sit on: 3-candle FVGs (isFVGUp[g]: [High[g-2], Low[g]]) and Gap-ups (Low[j] > High[j-1]
   *  by AB_GAPUP_MIN_PCT..AB_GAPUP_MAX_PCT %, neither candle circuit-locked: [High[j-1], Low[j]]), oldest first, an FVG
   *  before a Gap-up of the same candle. Sheet candles {Opn, High, Low, Cls}. */
  function springZones(candles, isFVGUp, cfg) {
    var out = [], n = candles.length;
    for (var f = 1; f < n; f++) {
      if (f >= 2 && isFVGUp[f]) out.push({ kind: 'FVG', f: f, bottom: candles[f - 2].High, top: candles[f].Low });
      var a = candles[f - 1], b = candles[f];
      var lockA = !isNaN(a.High) && !isNaN(a.Low) && a.Low > 0 && (a.High - a.Low) / a.Low * 100 <= cfg.AB_CIRCUIT_LOCK_RANGE_PCT;
      var lockB = !isNaN(b.High) && !isNaN(b.Low) && b.Low > 0 && (b.High - b.Low) / b.Low * 100 <= cfg.AB_CIRCUIT_LOCK_RANGE_PCT;
      if (lockA || lockB || isNaN(a.High) || isNaN(b.Low) || !(a.High > 0) || !(b.Low > a.High)) continue;
      var pct = (b.Low - a.High) / a.High * 100;
      if (pct >= cfg.AB_GAPUP_MIN_PCT && pct <= cfg.AB_GAPUP_MAX_PCT) out.push({ kind: 'Gap-up', f: f, bottom: a.High, top: b.Low });
    }
    return out;
  }

  /** FVG+Spring for the Spring pair (i-1, i): the oldest zone formed before the pair (f <= i-2) where candle i's low is
   *  at or under the zone top (inside it, or under the bottom - any depth) and its close above the bottom, while every
   *  close from f+1 to i-2 stays at or above both the zone bottom (the zone holds) and candle i's low (no earlier close
   *  under the Spring low). -> {kind, f, bottom, top, where: 'top'|'middle'|'bottom', touch} or null. */
  function springZone(candles, i, zones) {
    var c2 = candles[i];
    for (var z = 0; z < zones.length; z++) {
      var Z = zones[z];
      if (Z.f > i - 2) break;
      var top = Z.top, bottom = Z.bottom;
      if (!(c2.Low <= top && c2.Cls > bottom)) continue;
      var ok = true, k;
      for (k = Z.f + 1; k <= i - 2; k++) if (candles[k].Cls < bottom || candles[k].Cls < c2.Low) { ok = false; break; }
      if (!ok) continue;
      var touch = 0;
      for (k = Z.f + 1; k <= i; k++) if (candles[k].Low <= top && (k === Z.f + 1 || candles[k - 1].Low > top)) touch++;
      var where = c2.Low <= bottom ? 'bottom' : c2.Low >= (bottom + top) / 2 ? 'top' : 'middle';
      return { kind: Z.kind, f: Z.f, bottom: bottom, top: top, where: where, touch: touch };
    }
    return null;
  }

  /** Code.gs ab_fvgUpFlags_: Low[i] > High[i-2] by >= 70 % of the 14-bar average range (the col X 3-candle FVG). */
  function fvgUpFlags(candles) {
    var n = candles.length, out = new Array(n).fill(false);
    for (var i = 13; i < n; i++) {
      var sum = 0;
      for (var k = i - 13; k <= i; k++) sum += (candles[k].High - candles[k].Low);
      var low = candles[i].Low, h2 = candles[i - 2].High;
      if (low > h2 && (low - h2) >= 0.70 * (sum / 14)) out[i] = true;
    }
    return out;
  }

  /** Code.gs ab_gapInsideFvg_: the gap-up zone of candle j inside a 3-candle FVG formed at most one candle after it,
   *  no close from g+1 to `upto` under that FVG's bottom. Sheet candles. */
  function gapInsideFvg(candles, isFVGUp, j, bottom, top, upto) {
    for (var g = 2; g <= Math.min(j + 1, upto); g++) {
      if (!isFVGUp[g]) continue;
      var fb = candles[g - 2].High, ft = candles[g].Low;
      if (!(fb <= bottom && ft >= top)) continue;
      var holds = true;
      for (var k = g + 1; k <= upto; k++) if (candles[k].Cls < fb) { holds = false; break; }
      if (holds) return true;
    }
    return false;
  }

  /** The first candle after i that closed below candle i's low (the Spring is no longer valid), or -1. */
  function springBroken(candles, i) {
    for (var k = i + 1; k < candles.length; k++) if (candles[k].Cls < candles[i].Low) return k;
    return -1;
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
    // FVG+Spring (ab_longFvgDetail_): Spring pair i-1 -> i on the top / bottom of an FVG or Gap-up zone formed before it
    var sc = cfgIn || {}, D = P.DEFAULTS;
    var springCfg = {
      bodyMin: sc.AB_SPRING_BODY_MIN_PCT != null ? sc.AB_SPRING_BODY_MIN_PCT : D.AB_SPRING_BODY_MIN_PCT,
      day2BodyMax: sc.AB_SPRING_DAY2_BODY_MAX_PCT != null ? sc.AB_SPRING_DAY2_BODY_MAX_PCT : D.AB_SPRING_DAY2_BODY_MAX_PCT,
      undercut: sc.AB_SPRING_UNDERCUT_PCT != null ? sc.AB_SPRING_UNDERCUT_PCT : D.AB_SPRING_UNDERCUT_PCT,
      reclaimMax: sc.AB_SPRING_RECLAIM_MAX_PCT != null ? sc.AB_SPRING_RECLAIM_MAX_PCT : D.AB_SPRING_RECLAIM_MAX_PCT
    };
    var zones = springZones(candles, isFVGUp, cfgOf(cfgIn));
    var fvgZones = zones.filter(function (z) { return z.kind === 'FVG'; });
    var gapZones = zones.filter(function (z) { return z.kind === 'Gap-up'; });
    var springSignal = new Array(n).fill(false), springAt = {}, gapAt = {};
    for (i = 3; i < n; i++) {
      if (!P.isSpringPair(candles[i - 1], candles[i], springCfg)) continue;
      var hit = springZone(candles, i, fvgZones);
      if (hit) { springSignal[i] = true; springAt[i] = hit; }
      var gh = springZone(candles, i, gapZones);
      if (gh) { gh.inside = gapInsideFvg(candles, isFVGUp, gh.f, gh.bottom, gh.top, i); gapAt[i] = gh; }
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
    var lastN = Math.min(4, n), touchIdx = -1, confIdx = -1, springIdx = -1, twinIdx = -1, gapSpringIdx = -1;
    for (i = n - lastN; i < n; i++) {
      if (ftSignal[i]) touchIdx = i;
      if (ftcSignal[i]) confIdx = i;
      if (springSignal[i] && springBroken(candles, i) === -1) springIdx = i;   // a later close under its low: no longer valid
      if (gapAt[i] && springBroken(candles, i) === -1) gapSpringIdx = i;
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
    if (gapSpringIdx !== -1) tags.push('Gap-up FVG + Spring ' + (gapAt[gapSpringIdx].inside ? rec(gapSpringIdx).replace(')', ', inside FVG)') : rec(gapSpringIdx)));
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
      if (springSignal[i]) {
        var sz = springAt[i];
        events.push({ i: i, t: candles[i].t, type: 'fvg-spring', zone: sz.kind, where: sz.where, touch: sz.touch,
          bottom: sz.bottom, top: sz.top, formedIdx: sz.f, formed: candles[sz.f].t, broken: springBroken(candles, i) });
      }
      if (gapAt[i]) {
        var gz = gapAt[i];
        events.push({ i: i, t: candles[i].t, type: 'gap-spring', zone: gz.kind, where: gz.where, touch: gz.touch, inside: gz.inside,
          bottom: gz.bottom, top: gz.top, formedIdx: gz.f, formed: candles[gz.f].t, broken: springBroken(candles, i) });
      }
      if (twinSignal[i]) events.push({ i: i, t: candles[i].t, type: 'fvg-twinstar' });
    }
    return { tags: tags, unmitigated: zone, events: events };
  }

  /** ab_gapUpFvgs_ -> the gap-up zones still valid (no later close under the bottom), newest first; touchIdx = the first
   *  later non-locked candle with low <= top (mitigated; -1 = untouched), touched, insideFvg. */
  function gapUpFvgs(candles, cfgIn) {
    var cfg = cfgOf(cfgIn), out = [], n = (candles || []).length, flags = null;
    if (n < 2) return out;
    for (var i = 1; i < n; i++) {
      if (isCircuitLocked(candles[i - 1], cfg) || isCircuitLocked(candles[i], cfg)) continue;
      var prevHigh = candles[i - 1].h, low = candles[i].l;
      if (isNaN(prevHigh) || isNaN(low) || prevHigh <= 0) continue;
      if (low <= prevHigh) continue;
      var pct = (low - prevHigh) / prevHigh * 100;
      if (pct < cfg.AB_GAPUP_MIN_PCT || pct > cfg.AB_GAPUP_MAX_PCT) continue;
      var touchIdx = -1, broken = false;
      for (var j = i + 1; j < n; j++) {
        if (touchIdx === -1 && !isCircuitLocked(candles[j], cfg) && !isNaN(candles[j].l) && candles[j].l <= low) touchIdx = j;
        if (!isNaN(candles[j].c) && candles[j].c < prevHigh) { broken = true; break; }
      }
      if (broken) continue;
      if (!flags) flags = fvgUpFlags(candles.map(S));
      out.push({ kind: 'Gap-up', bottom: prevHigh, top: low, pct: Math.round(pct * 100) / 100, formedIdx: i, formed: candles[i].t, daysAgo: (n - 1) - i,
        touchIdx: touchIdx, touched: touchIdx !== -1, touchedOn: touchIdx !== -1 ? candles[touchIdx].t : null,
        insideFvg: gapInsideFvg(candles.map(S), flags, i, prevHigh, low, n - 1) });
    }
    out.reverse();
    return out;
  }
  function gapUpTags(candles, cfg) {
    return gapUpFvgs(candles, cfg).map(function (g) {
      return 'Gap-up FVG ' + g.pct + '% (' + (g.daysAgo === 0 ? 'today' : g.daysAgo + 'd ago') +
        (g.touched ? ', mitigated' : '') + (g.insideFvg ? ', inside FVG' : '') + ')';
    });
  }

  /** Main/PatternData 'FVG' column text for the latest bar (col X). */
  function columnTags(candles, cfg) {
    return longFvgDetail(candles, cfg).tags.concat(gapUpTags(candles, cfg)).join(', ');
  }

  /** Watch zones as the GapUpFVG / UnmitigatedFVG tabs build them: liquidity
   *  filter, gap-ups first (mitigated ones too - `touched`, kept until a close
   *  below), the 3-candle zone only when no untouched gap-up is watched. */
  function watchZones(candles, cfgIn) {
    var cfg = cfgOf(cfgIn);
    var t = avgTurnover(candles, cfg);
    var illiquid = !isNaN(t) && t < cfg.AB_FVG_MIN_AVG_TURNOVER;
    if (illiquid) return { zones: [], illiquid: true, turnover: t };
    var gaps = gapUpFvgs(candles, cfg);
    var zones = gaps.slice();
    if (!gaps.some(function (g) { return !g.touched; })) {
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
    springZones: springZones, springZone: springZone, springBroken: springBroken, fvgUpFlags: fvgUpFlags, gapInsideFvg: gapInsideFvg,
    gapUpFvgs: gapUpFvgs, gapUpTags: gapUpTags, columnTags: columnTags, watchZones: watchZones,
    approachState: approachState, classifyMitigation: classifyMitigation, MIT_LABELS: MIT_LABELS,
    fillState: fillState, bearishGaps: bearishGaps
  };
});
