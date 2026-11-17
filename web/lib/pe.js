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
  return { ownMedian: ownMedian, own: own, check: check, apply: apply, WORDS: WORDS };
});
