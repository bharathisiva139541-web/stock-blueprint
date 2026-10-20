/* Position sizing and portfolio risk checks.
   Defaults mirror the sheet's Control Panel (AB_RISK_CAPITAL 100000,
   AB_RISK_PCT_PER_TRADE 1, AB_RISK_MAX_HEAT_PCT 6, AB_RISK_DAILY_LOSS_PCT 3).
   The viewer's own values live only in their browser.

   Core formula:
     risk budget       = equity x risk% / 100
     risk per unit     = |entry - stop|
     quantity          = floor(risk budget / risk per unit)
   then capped by available capital, max exposure, per-industry exposure and
   lot size. Costs are only included when the viewer configures them. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.SB = root.SB || /** @type {any} */ ({})).risk = factory();
})(/** @type {any} */ (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  var DEFAULTS = {
    capital: 100000,          // account equity (Rs)
    riskPct: 1,               // % of equity risked per trade
    maxPositions: 10,
    maxHeatPct: 6,            // total open risk as % of equity
    dailyLossPct: 3,
    maxExposurePct: 100,      // total position value as % of equity
    maxIndustryPct: 0,        // 0 = no per-industry limit
    minRR: 2,                 // minimum reward : risk
    lotSize: 1,
    costPctPerSide: 0,        // brokerage + taxes + slippage, % of value per side (0 = not modelled)
    allowShort: false
  };

  function num(v) { return typeof v === 'number' && isFinite(v) ? v : NaN; }

  function validateSettings(s) {
    var o = {}, errors = [];
    Object.keys(DEFAULTS).forEach(function (k) {
      var v = s && s[k] != null && s[k] !== '' ? s[k] : DEFAULTS[k];
      if (typeof DEFAULTS[k] === 'number') {
        v = Number(v);
        if (!isFinite(v) || v < 0) { errors.push(k + ' must be a number >= 0'); v = DEFAULTS[k]; }
      } else v = !!v;
      o[k] = v;
    });
    if (o.riskPct > 10) errors.push('risk per trade above 10% is not accepted');
    if (o.capital <= 0) errors.push('capital must be above 0');
    if (o.lotSize < 1) o.lotSize = 1;
    return { settings: o, errors: errors };
  }

  /** Size one trade.
   *  input: { entry, stop, target, side:'long'|'short', industry }
   *  ctx:   { openPositions:[{value, risk, industry}], realizedTodayLoss }
   *  -> { ok, qty, value, riskAmount, riskPerUnit, rr, reward, costs, warnings[], errors[], steps[] } */
  function sizePosition(input, settingsIn, ctx) {
    var v = validateSettings(settingsIn), s = v.settings;
    var out = { ok: false, qty: 0, value: 0, riskAmount: 0, riskPerUnit: NaN, rr: NaN, reward: NaN, costs: 0, warnings: [], errors: v.errors.slice(), steps: [] };
    var entry = num(input && input.entry), stop = num(input && input.stop), target = num(input && input.target);
    var side = input && input.side === 'short' ? 'short' : 'long';
    if (!(entry > 0)) { out.errors.push('entry price is missing or not above 0'); return out; }
    if (!(stop > 0)) { out.errors.push('stop-loss is missing or not above 0'); return out; }
    if (side === 'short' && !s.allowShort) { out.errors.push('short trades are disabled in the risk settings'); return out; }
    if (side === 'long' && stop >= entry) { out.errors.push('stop-loss must be below the entry for a long trade'); return out; }
    if (side === 'short' && stop <= entry) { out.errors.push('stop-loss must be above the entry for a short trade'); return out; }
    var rpu = Math.abs(entry - stop);
    if (!(rpu > 0)) { out.errors.push('entry and stop-loss are equal'); return out; }
    out.riskPerUnit = rpu;

    if (target > 0) {
      if ((side === 'long' && target <= entry) || (side === 'short' && target >= entry)) out.warnings.push('target is on the wrong side of the entry');
      else { out.reward = Math.abs(target - entry); out.rr = out.reward / rpu; }
    }
    if (isFinite(out.rr) && out.rr < s.minRR) out.warnings.push('reward:risk 1:' + out.rr.toFixed(2) + ' is below your minimum 1:' + s.minRR);
    if (!isFinite(out.rr)) out.warnings.push('no valid target - reward:risk cannot be checked');

    var open = (ctx && ctx.openPositions) || [];
    var openRisk = open.reduce(function (a, p) { return a + (num(p.risk) || 0); }, 0);
    var openValue = open.reduce(function (a, p) { return a + (num(p.value) || 0); }, 0);
    var budget = s.capital * s.riskPct / 100;
    out.steps.push('Risk budget = ₹' + Math.round(s.capital) + ' × ' + s.riskPct + '% = ₹' + budget.toFixed(0));
    out.steps.push('Risk per share = |' + entry + ' − ' + stop + '| = ₹' + rpu.toFixed(2));
    var qty = Math.floor(budget / rpu);
    out.steps.push('Quantity by risk = floor(' + budget.toFixed(0) + ' / ' + rpu.toFixed(2) + ') = ' + qty);

    // portfolio heat
    var heatLeft = s.capital * s.maxHeatPct / 100 - openRisk;
    if (heatLeft <= 0) { out.errors.push('portfolio heat limit (' + s.maxHeatPct + '%) already used by open positions'); qty = 0; }
    else if (qty * rpu > heatLeft) { qty = Math.floor(heatLeft / rpu); out.warnings.push('reduced to fit the ' + s.maxHeatPct + '% portfolio heat limit'); }
    // capital / exposure
    var exposureLeft = Math.min(s.capital - openValue, s.capital * s.maxExposurePct / 100 - openValue);
    var feeFactor = 1 + s.costPctPerSide / 100;
    if (qty * entry * feeFactor > exposureLeft) {
      var q2 = Math.max(0, Math.floor(exposureLeft / (entry * feeFactor)));
      if (q2 < qty) { qty = q2; out.warnings.push('reduced to fit available capital / maximum exposure'); }
    }
    // per-industry exposure
    if (s.maxIndustryPct > 0 && input.industry) {
      var indValue = open.filter(function (p) { return p.industry === input.industry; }).reduce(function (a, p) { return a + (num(p.value) || 0); }, 0);
      var indLeft = s.capital * s.maxIndustryPct / 100 - indValue;
      if (qty * entry > indLeft) { qty = Math.max(0, Math.floor(indLeft / entry)); out.warnings.push('reduced to fit the ' + s.maxIndustryPct + '% limit for ' + input.industry); }
    }
    if (open.length >= s.maxPositions) { out.errors.push('maximum concurrent positions (' + s.maxPositions + ') reached'); qty = 0; }
    if (ctx && num(ctx.realizedTodayLoss) >= s.capital * s.dailyLossPct / 100) { out.errors.push('daily loss limit (' + s.dailyLossPct + '%) reached - no new trades today'); qty = 0; }
    // lot size
    if (s.lotSize > 1) qty = Math.floor(qty / s.lotSize) * s.lotSize;

    out.qty = Math.max(0, qty);
    out.value = out.qty * entry;
    out.riskAmount = out.qty * rpu;
    out.costs = s.costPctPerSide > 0 ? out.value * s.costPctPerSide / 100 * 2 : 0;
    if (out.qty === 0 && !out.errors.length) out.errors.push('quantity rounds down to 0 at this risk per share');
    if (rpu / entry > 0.15) out.warnings.push('stop-loss is ' + (rpu / entry * 100).toFixed(1) + '% away - very wide');
    out.ok = out.qty > 0 && !out.errors.length;
    return out;
  }

  /** Portfolio summary for a list of open positions [{entry, stop, qty, industry}]. */
  function portfolioRisk(positions, settingsIn) {
    var s = validateSettings(settingsIn).settings;
    var risk = 0, value = 0, byInd = {};
    (positions || []).forEach(function (p) {
      var e = num(p.entry), st = num(p.stop), q = num(p.qty);
      if (!(e > 0) || !(q > 0)) return;
      var r = st > 0 ? Math.max(0, (e - st) * q) : e * q;    // no stop -> the whole position is at risk
      risk += r; value += e * q;
      byInd[p.industry || 'Unclassified'] = (byInd[p.industry || 'Unclassified'] || 0) + e * q;
    });
    return {
      openRisk: risk, heatPct: risk / s.capital * 100, exposure: value, exposurePct: value / s.capital * 100,
      heatLimitPct: s.maxHeatPct, byIndustry: byInd, overHeat: risk / s.capital * 100 > s.maxHeatPct
    };
  }

  return { DEFAULTS: DEFAULTS, validateSettings: validateSettings, sizePosition: sizePosition, portfolioRisk: portfolioRisk };
});
