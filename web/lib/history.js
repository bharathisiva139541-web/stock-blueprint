/* Daily candle history as the site gets it (browser + Node, no DOM): part 'history' (History30,
   GOOGLEFINANCE - window.SB_HISTORY / api/site?part=history) and part 'history60' (History60's
   older days, NSE bhavcopy via the owner's PC - window.SB_HISTORY60 / api/site?part=history60).

   SB.history = {
     merge(H, O)  -> H with O's candles in front: one sorted `dates` list, per stock O's bars on the
                     days H does not have + H's bars (H wins on a day both have), H.older =
                     { days, stored, source } | null. H itself is not changed. Without O's bars: H.
     usable(O)    -> true for a history60 part with candles
   } */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.SB = root.SB || /** @type {any} */ ({})).history = factory();
})(/** @type {any} */ (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  function usable(O) {
    return !!(O && Array.isArray(O.dates) && O.dates.length && O.bars && typeof O.bars === 'object' && Object.keys(O.bars).length);
  }

  function merge(H, O) {
    if (!H || !Array.isArray(H.dates) || !H.bars || !usable(O)) return H;
    var seen = {};
    H.dates.forEach(function (d) { seen[d] = true; });
    O.dates.forEach(function (d) { seen[d] = true; });
    var dates = Object.keys(seen).sort();
    var at = {};
    dates.forEach(function (d, i) { at[d] = i; });
    var bars = {};
    Object.keys(H.bars).forEach(function (sym) {
      var own = {};
      var list = (H.bars[sym] || []).map(function (b) { var d = H.dates[b[0]]; own[d] = true; return [at[d]].concat(b.slice(1)); });
      (O.bars[sym] || []).forEach(function (b) { var d = O.dates[b[0]]; if (d && !own[d]) list.push([at[d]].concat(b.slice(1))); });
      bars[sym] = list.sort(function (a, b) { return a[0] - b[0]; });
    });
    Object.keys(O.bars).forEach(function (sym) {
      if (bars[sym]) return;
      bars[sym] = O.bars[sym].filter(function (b) { return O.dates[b[0]]; })
        .map(function (b) { return [at[O.dates[b[0]]]].concat(b.slice(1)); }).sort(function (a, b) { return a[0] - b[0]; });
    });
    var out = {};
    Object.keys(H).forEach(function (k) { out[k] = H[k]; });
    out.dates = dates;
    out.bars = bars;
    out.older = { days: O.dates.length, stored: O.stored || null, source: O.source || 'History60' };
    out.source = (H.source || 'History30') + ' + ' + (O.source || 'History60') + ' (older days)';
    return out;
  }

  return { merge: merge, usable: usable };
});
