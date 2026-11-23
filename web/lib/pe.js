/* Historical PE (owner, 17-Nov-2026: "intha PE Ratio va nan first athoda Historical PE Ratio, then industry median PE kooda
   compare panrathuku useful") - browser + Node, no DOM. Main's Median PE 1Y / 3Y / 5Y + Peak PE 5Y come from the owner's
   laptop (pcbridge/ScreenerBridge/pe_history.py: each day's Kite close / the TTM EPS known that day); the comparison follows
   the PE shown (live with the price), the same rule as the sheet's PE vs Own Median / PE Check formulas
   (Code2.gs ab_hpeFormulasR1C1_).

   SB.pe = {
     ownMedian(s) -> { value, years: 5 | 3 | 1 } | null   the 5-year median, else 3-year, else 1-year
     own(s)       -> PE / that median (2 decimals) | null  below 1 = cheaper than the stock's own usual PE
     check(own, vs) -> the sheet's PE Check words ('' when there is no PE): own median first, then the industry
     apply(s)     -> sets s.peOwn, s.peOwnYears, s.peCheck (app.js: at load and at every new price)
     WORDS        -> every word check() gives
     picture(s)   -> null | { now, meds [{k '1Y', v}], peak, ind, lo, hi, verdict {k below|within|above|none|loss, words},
                     vsInd {k below|above, pct} | null, pctPeak }   (owner, 23-Nov-2026: "one simple indicator ... Current
                     PE, Median PE for 1 yr, 3 yr, 5 yr, and Peak PE ... by seeing this i can understand the current state
                     of PE" -> options C + D of the mock-up, "and ... Current Industry PE")
     gaugeSvg(p)  -> the speedometer: 0 .. the 5-year peak, green / amber / red parts from the medians, the needle = PE now,
                     dots for the medians, a diamond for the industry PE
     barsSvg(p)   -> PE now against each median, the 5-year peak and the industry PE: green = cheaper, red = costlier
     html(p)      -> the stock window's block (verdict chips + both pictures)
   } */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.SB = root.SB || /** @type {any} */ ({})).pe = factory();
})(/** @type {any} */ (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  var WORDS = ['Below own + industry median', 'Below own median', 'Below industry median', 'Above both', 'Above own median',
    'No own history - below industry', 'No own history - above industry'];

  function ownMedian(s) {
    if (!s) return null;
    if (isNum(s.pem5) && s.pem5 > 0) return { value: s.pem5, years: 5 };
    if (isNum(s.pem3) && s.pem3 > 0) return { value: s.pem3, years: 3 };
    if (isNum(s.pem1) && s.pem1 > 0) return { value: s.pem1, years: 1 };
    return null;
  }
  function own(s) {
    var m = ownMedian(s);
    if (!m || !isNum(s.pe) || !(s.pe > 0)) return null;
    return Math.round(s.pe / m.value * 100) / 100;
  }
  /** own = PE / own median, vs = PE / Industry PE - the sheet's PE Check formula (PE > 0 only) */
  function check(o, vs) {
    var hasO = isNum(o) && o > 0, hasV = isNum(vs) && vs > 0;
    if (!hasO) return hasV ? (vs < 1 ? WORDS[5] : WORDS[6]) : '';
    if (!hasV) return o < 1 ? WORDS[1] : WORDS[4];
    if (o < 1 && vs < 1) return WORDS[0];
    if (o < 1) return WORDS[1];
    if (vs < 1) return WORDS[2];
    return WORDS[3];
  }
  function apply(s) {
    var m = ownMedian(s);
    s.peOwn = own(s);
    s.peOwnYears = m ? m.years : null;
    s.peCheck = isNum(s.pe) && s.pe > 0 ? check(s.peOwn, s.pevs) || null : null;
    return s;
  }

  // ---------- the PE picture (stock window) ----------
  var VERDICT = { below: 'Cheaper than its usual PE', within: 'In its usual PE range', above: 'Costlier than its usual PE',
    none: 'No own PE history yet', loss: 'No PE now (a loss, or no TTM EPS)' };
  var TONE = { below: 'good', within: 'warn', above: 'bad', none: 'none', loss: 'none' };
  function picture(s) {
    if (!s) return null;
    var now = isNum(s.pe) && s.pe > 0 ? s.pe : null;
    var meds = [['1Y', s.pem1], ['3Y', s.pem3], ['5Y', s.pem5]].filter(function (m) { return isNum(m[1]) && m[1] > 0; })
      .map(function (m) { return { k: m[0], v: m[1] }; });
    var peak = isNum(s.pepk) && s.pepk > 0 ? s.pepk : null;
    var ind = isNum(s.ipe) && s.ipe > 0 ? s.ipe : null;
    if (!meds.length && !peak && !ind) return null;
    var vals = meds.map(function (m) { return m.v; });
    var lo = vals.length ? Math.min.apply(null, vals) : null, hi = vals.length ? Math.max.apply(null, vals) : null;
    var k = now === null ? 'loss' : !vals.length ? 'none' : now < lo ? 'below' : now > hi ? 'above' : 'within';
    return {
      now: now, meds: meds, peak: peak, ind: ind, lo: lo, hi: hi, verdict: { k: k, words: VERDICT[k] },
      vsInd: now !== null && ind ? { k: now < ind ? 'below' : 'above', pct: Math.round((now - ind) / ind * 100) } : null,
      pctPeak: now !== null && peak ? Math.round(now / peak * 100) : null
    };
  }
  function f1(v) { return (Math.round(v * 10) / 10).toFixed(1); }
  function top(p) {
    var mx = Math.max.apply(null, p.meds.map(function (m) { return m.v; }).concat([p.now || 0, p.peak || 0, p.ind || 0]));
    return p.peak && p.peak >= mx ? p.peak : mx * 1.1;
  }
  function gaugeSvg(p) {
    var cx = 240, cy = 185, r = 130, mx = top(p), out = [];
    var P = function (v, rr) { var a = Math.PI - Math.PI * Math.min(Math.max(v, 0), mx) / mx; return [cx + rr * Math.cos(a), cy - rr * Math.sin(a)]; };
    var n2 = function (x) { return Math.round(x * 10) / 10; };
    var arc = function (a, b, cls) {
      if (!(b > a)) return;
      var s = P(a, r), e = P(b, r);
      out.push('<path class="' + cls + '" d="M' + n2(s[0]) + ' ' + n2(s[1]) + ' A' + r + ' ' + r + ' 0 0 1 ' + n2(e[0]) + ' ' + n2(e[1]) + '"/>');
    };
    arc(0, mx, 'pz pz-track');
    if (p.lo !== null) { arc(0, p.lo, 'pz pz-good'); arc(p.lo, p.hi, 'pz pz-warn'); arc(p.hi, mx, 'pz pz-bad'); }
    var marks = p.meds.map(function (m) { return { v: m.v, t: m.k + ' ' + f1(m.v), c: 'pm' }; });
    if (p.ind) marks.push({ v: p.ind, t: 'Industry ' + f1(p.ind), c: 'pi' });
    marks.sort(function (a, b) { return a.v - b.v; });
    marks.forEach(function (m, i) {
      var d = P(m.v, r), q = P(m.v, r + 20 + (i % 2) * 20);
      var side = q[0] < cx - 20 ? 'end' : q[0] > cx + 20 ? 'start' : 'middle';
      out.push(m.c === 'pi'
        ? '<path class="pi" d="M' + n2(d[0]) + ' ' + n2(d[1] - 7) + ' l6 7 l-6 7 l-6 -7 z"/>'
        : '<circle class="pm" cx="' + n2(d[0]) + '" cy="' + n2(d[1]) + '" r="4.5"/>');
      out.push('<text class="pl' + (m.c === 'pi' ? ' pl-i' : '') + '" x="' + n2(q[0]) + '" y="' + n2(q[1]) + '" text-anchor="' + side + '">' + m.t + '</text>');
    });
    var pk = P(mx, r + 24);
    out.push('<text class="pl" x="' + n2(pk[0] - 6) + '" y="' + n2(pk[1] + 14) + '" text-anchor="end">' +
      (p.peak ? 'Peak ' + f1(p.peak) : 'no 5-year peak yet') + '</text>');
    out.push('<text class="pl" x="' + (cx - r) + '" y="' + (cy + 18) + '" text-anchor="middle">0</text>');
    var t = TONE[p.verdict.k];
    if (p.now !== null) {
      var e = P(p.now, r - 26);
      out.push('<line class="pn pn-' + t + '" x1="' + cx + '" y1="' + cy + '" x2="' + n2(e[0]) + '" y2="' + n2(e[1]) + '"/>');
      out.push('<circle class="ph ph-' + t + '" cx="' + cx + '" cy="' + cy + '" r="9"/>');
      out.push('<text class="pv pv-' + t + '" x="' + cx + '" y="' + (cy + 36) + '" text-anchor="middle">PE now ' + f1(p.now) + '</text>');
    }
    return '<svg class="pe-gauge" viewBox="0 0 480 232" role="img" aria-label="PE now against its medians, its 5-year peak and the industry PE">' +
      out.join('') + '</svg>';
  }
  function barsSvg(p) {
    if (p.now === null) return '';
    var rows = p.meds.map(function (m) { return ['vs ' + m.k + ' median', m.v]; });
    if (p.peak) rows.push(['vs 5-year peak', p.peak]);
    var own = rows.length;
    if (p.ind) rows.push(['vs industry PE', p.ind]);
    if (!rows.length) return '';
    var mid = 290, half = 140, h = 28 + rows.length * 34 + (p.ind && own ? 8 : 0), out = [];
    out.push('<text class="pl" x="' + (mid - 8) + '" y="12" text-anchor="end">◀ cheaper</text><text class="pl" x="' + (mid + 8) + '" y="12">costlier ▶</text>');
    out.push('<line class="pax" x1="' + mid + '" x2="' + mid + '" y1="18" y2="' + (h - 4) + '"/>');
    rows.forEach(function (row, i) {
      var y = 24 + i * 34 + (p.ind && own && i >= own ? 8 : 0);
      if (p.ind && own && i === own) out.push('<line class="pdiv" x1="0" x2="480" y1="' + (y - 5) + '" y2="' + (y - 5) + '"/>');
      var pct = (p.now - row[1]) / row[1] * 100, w = Math.min(Math.abs(pct), 100) / 100 * half, t = pct < 0 ? 'good' : 'bad';
      out.push('<text class="pl pl-row" x="0" y="' + (y + 15) + '">' + row[0] + '</text>');
      out.push('<rect class="pbt" x="' + (mid - half) + '" y="' + (y + 2) + '" width="' + (half * 2) + '" height="18" rx="4"/>');
      out.push('<rect class="pb pb-' + t + '" x="' + Math.round(pct < 0 ? mid - w : mid) + '" y="' + (y + 2) + '" width="' + Math.max(2, Math.round(w)) + '" height="18" rx="4"/>');
      out.push('<text class="pv pv-' + t + '" x="' + Math.round(pct < 0 ? mid - w - 6 : mid + w + 6) + '" y="' + (y + 15) + '" text-anchor="' +
        (pct < 0 ? 'end' : 'start') + '">' + (pct < 0 ? '' : '+') + Math.round(pct) + '%</text>');
    });
    return '<svg class="pe-bars" viewBox="0 0 480 ' + h + '" role="img" aria-label="PE now against each median, the 5-year peak and the industry PE">' +
      out.join('') + '</svg>';
  }
  function html(p) {
    if (!p) return '';
    var chip = function (k, words) { return '<span class="badge ' + ({ good: 's-good', warn: 's-warn', bad: 's-bad' }[k] || '') + '">' + words + '</span>'; };
    var sub = [];
    if (p.now !== null) sub.push('PE now ' + f1(p.now));
    if (p.pctPeak !== null) sub.push(p.pctPeak + '% of its 5-year peak');
    if (p.ind) sub.push('industry PE ' + f1(p.ind));
    var bars = barsSvg(p);
    return '<div class="pe-pic"><div class="pe-pic-head">' + chip(TONE[p.verdict.k], p.verdict.words) +
      (p.vsInd ? chip(p.vsInd.k === 'below' ? 'good' : 'bad', Math.abs(p.vsInd.pct) + '% ' + (p.vsInd.k === 'below' ? 'below' : 'above') + ' industry PE') : '') +
      (sub.length ? '<span class="sub">' + sub.join(' · ') + '</span>' : '') + '</div>' +
      '<div class="pe-pic-row"><div class="pe-pic-g">' + gaugeSvg(p) + '</div>' + (bars ? '<div class="pe-pic-b">' + bars + '</div>' : '') + '</div></div>';
  }

  return { ownMedian: ownMedian, own: own, check: check, apply: apply, WORDS: WORDS, picture: picture, gaugeSvg: gaugeSvg,
    barsSvg: barsSvg, html: html, VERDICT: VERDICT };
});
