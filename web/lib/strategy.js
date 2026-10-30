/* Strategy engine: configurable, versioned rule sets evaluated per stock.
   Every condition returns pass / fail / n.a. with the value it saw, so each
   signal can be explained. Technical conditions only read candles 0..i.

   Presets
   - 'sheet': "Stock Blueprint signals" - assembled ONLY from rules found in
     Code.gs (patterns col W, FVG col X, 10/21 EMA support, liquidity and
     circuit-lock filters, TTM Signal with the ab_fixSignalFormulas_ rule,
     Quality Watch, +10% win target AB_TRADE_WIN_PCT). How these are combined
     into an "entry candidate" is NOT defined in the sheet, so the preset is
     marked unconfirmed until the owner confirms it in Strategy Settings.
   - 'demo': an explicitly labelled DEMO trend-pullback strategy for testing. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./indicators.js'), require('./patterns.js'), require('./fvg.js'));
  } else {
    var SB = root.SB = root.SB || /** @type {any} */ ({});
    SB.strategy = factory(SB.indicators, SB.patterns, SB.fvg);
  }
})(/** @type {any} */ (typeof self !== 'undefined' ? self : this), function (I, P, FVG) {
  'use strict';

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function round(v, d) { var k = Math.pow(10, d || 2); return Math.round(v * k) / k; }
  function inrShort(v) { return v >= 1e7 ? '₹' + round(v / 1e7, 1) + ' Cr' : '₹' + round(v / 1e5, 1) + ' lakh'; }
  // 'Bullish Harami + Inverted Hammer' alone is a watch signal (sellers still capped the high); only its
  // confirmed form (next close above its high) counts as bullish, like 'Spring?' is offered but not default
  var BULLISH_PATTERNS = ['Spring', 'Piercing', 'Bullish Engulfing', 'Bullish Harami', 'Tweezer Bottoms',
    'Three Day Low Rejection', 'Morningstar', 'Trio', 'FVG 1234', 'FVG 123', 'FVG 123 Type 2', 'FVGTouch',
    'Bullish Harami + Inverted Hammer (confirmed)'];
  var OPM_UP = ['increasing', 'aggressive increase', 'slightly increasing'];
  var UP3 = ['Aggressive Increase', 'Increasing', 'Slightly Increasing'];
  var FIELD_LABEL = { opmq: 'OPM QoQ%', opmy: 'OPM YoY%', promo: 'Promoter holding', fii: 'FII activity', sig: 'TTM Signal',
    up: 'Upside %', pevs: 'PE vs Industry PE', down52: '% from 52W high', epsg: 'TTM EPS growth %', qrev: 'QoQ revenue growth %',
    volchg: 'Volume change %', chg: 'Day %', d10: '10-day %', d30: '30-day %' };

  // ---------- per-bar technical context (no look-ahead) ----------
  /** ctx for bar i of candles (oldest first). stock = Main row object (fundamentals). */
  function buildContext(stock, candlesAll, i, opts) {
    opts = opts || {};
    var candles = (candlesAll || []).slice(0, i + 1);
    var n = candles.length, last = candles[n - 1] || null;
    var ctx = { stock: stock || {}, candles: candles, n: n, i: i, bar: last, t: last ? last.t : null, cache: {} };
    ctx.price = opts.usePrice && stock && isNum(stock.price) ? stock.price : (last ? last.c : NaN);
    ctx.pointInTime = !!opts.pointInTime;     // true in backtests: fundamentals unavailable
    // "today" for calendar rules (results due...): the data date when screening live,
    // the candle date in backtests
    ctx.refDate = opts.refDate || (last ? String(last.t).slice(0, 10) : null);
    ctx.fvgCfg = opts.fvgCfg || null;
    ctx.patternCfg = opts.patternCfg || null;
    return ctx;
  }
  function memo(ctx, key, fn) { if (!(key in ctx.cache)) ctx.cache[key] = fn(); return ctx.cache[key]; }
  function patternsOf(ctx) { return memo(ctx, 'pat', function () { return ctx.n ? P.patternsAt(ctx.candles, ctx.n - 1, ctx.patternCfg) : []; }); }
  function fvgOf(ctx) { return memo(ctx, 'fvg', function () { return FVG.longFvgDetail(ctx.candles); }); }
  function emaOf(ctx, len) { return memo(ctx, 'ema' + len, function () { return I.ema(ctx.candles, len); }); }
  function atrOf(ctx) { return memo(ctx, 'atr', function () { return I.atrEmaLast(I.sheetBars(ctx.candles), 14); }); }   // the sheet's ATR14 (History30)
  function ageOfTag(tag) {
    var m = /\((Today|today|formed today)\)|\((?:formed )?(\d+)d ago\)/.exec(tag || '');
    if (!m) return null;
    return m[2] ? +m[2] : 0;
  }
  function ttmSignal(s, price) {
    // ab_fixSignalFormulas_ rule (the intended sheet formula), recomputed with the current price
    var tgt = s.tgt, g = s.epsg, eps = s.ttmEps;
    if (!isNum(tgt) || !isNum(price)) return '';
    if ((isNum(g) ? g : 0) < 0 || (isNum(eps) ? eps : 0) <= 0) return 'Avoid';
    if (tgt < price) return 'Avoid';
    if (tgt > price) return 'Buy';
    return '';
  }

  // ---------- condition catalogue ----------
  // group: filter (must pass) | trigger (setup signals, counted) | confirm (must pass to qualify)
  // kind: 'sheet' = rule taken from Code.gs; 'std' = standard rule offered for custom strategies
  // pit: false = uses today's fundamentals -> excluded from backtests (would be look-ahead)
  var C = {};
  function def(id, o) { o.id = id; C[id] = o; }

  def('liquidity', { label: 'Average turnover ≥ ₹{minTurnover}', kind: 'sheet', setGroup: 'filter', pit: true,
    params: [{ key: 'minTurnover', label: 'Min avg daily turnover (₹)', def: 5000000 }],
    ref: 'Code.gs ab_avgTurnover_ / AB_FVG_MIN_AVG_TURNOVER',
    eval: function (x, p) {
      var t = FVG.avgTurnover(x.candles, x.fvgCfg);
      if (isNaN(t)) return { pass: true, value: null, detail: 'no volume data (passes, as in the sheet)' };
      return { pass: t >= p.minTurnover, value: t, detail: 'avg turnover ' + inrShort(t) };
    } });
  def('notCircuitLocked', { label: 'Latest candle not circuit-locked', kind: 'sheet', setGroup: 'filter', pit: true,
    ref: 'Code.gs ab_isCircuitLocked_', params: [],
    eval: function (x) { var l = FVG.isCircuitLocked(x.bar, x.fvgCfg); return { pass: !l, detail: l ? 'high-low range ≤ 0.05% (locked at a band)' : 'traded normally' }; } });
  def('minPrice', { label: 'Price ≥ ₹{min}', kind: 'std', setGroup: 'filter', pit: true, params: [{ key: 'min', label: 'Min price', def: 20 }],
    eval: function (x, p) { return { pass: x.price >= p.min, value: x.price }; } });
  def('resultsNotWithin', { label: 'No results due within {days} days', kind: 'std', setGroup: 'filter', pit: false,
    params: [{ key: 'days', label: 'Days', def: 3 }],
    eval: function (x, p) {
      var d = x.stock.rdate ? new Date(String(x.stock.rdate).slice(0, 10) + 'T00:00:00') : null;
      var ref = x.refDate ? new Date(String(x.refDate).slice(0, 10) + 'T00:00:00') : null;
      if (!d || !ref || isNaN(d.getTime())) return { pass: true, detail: 'no result date' };
      var dd = Math.round((d.getTime() - ref.getTime()) / 864e5);
      if (dd < 0) return { pass: true, detail: 'last result ' + (-dd) + ' days ago' };
      return { pass: dd > p.days, value: dd, detail: 'result in ' + dd + ' days' };
    } });

  def('pattern', { label: 'Bullish candlestick pattern on the latest bar', kind: 'sheet', setGroup: 'trigger', type: 'reversal', pit: true,
    ref: 'Code.gs updateAllCandlestickPatterns (PatternData col W)',
    params: [{ key: 'names', label: 'Patterns', def: BULLISH_PATTERNS.slice(), options: BULLISH_PATTERNS.concat(['Spring?', 'Bullish Harami + Inverted Hammer', 'Twin Star Bottom', 'Twin Star Bottom (confirmed)']) }],
    eval: function (x, p) {
      var got = patternsOf(x), hit = got.filter(function (t) { return p.names.indexOf(t) >= 0; });
      return { pass: hit.length > 0, value: hit.join(', ') || null, detail: got.length ? got.join(', ') : 'no pattern' };
    } });
  def('fvgFirstTouch', { label: 'FVG first touch (last 4 bars)', kind: 'sheet', setGroup: 'trigger', type: 'pullback', pit: true,
    ref: 'Code.gs ab_longFvgDetail_ "FVG First Touch"', params: [{ key: 'maxAge', label: 'Max age (bars)', def: 3 }],
    eval: function (x, p) {
      var t = fvgOf(x).tags.filter(function (s) { return /^FVG First Touch \(/.test(s); })[0];
      var a = ageOfTag(t);
      return { pass: !!t && a <= p.maxAge, value: t || null, detail: t || 'no first touch' };
    } });
  def('fvgConfirmed', { label: 'FVG first touch confirmed (last 4 bars)', kind: 'sheet', setGroup: 'trigger', type: 'pullback', pit: true,
    ref: 'Code.gs ab_longFvgDetail_ "FVG First Touch Confirmed"', params: [{ key: 'maxAge', label: 'Max age (bars)', def: 3 }],
    eval: function (x, p) {
      var t = fvgOf(x).tags.filter(function (s) { return /^FVG First Touch Confirmed/.test(s); })[0];
      return { pass: !!t && ageOfTag(t) <= p.maxAge, value: t || null, detail: t || 'not confirmed' };
    } });
  def('fvgSpring', { label: 'FVG + Spring (Spring candle pair inside a 30-day FVG that still holds)', kind: 'sheet', setGroup: 'trigger', type: 'reversal', pit: true,
    ref: 'Code.gs ab_longFvgDetail_ "FVG+Spring"', params: [{ key: 'maxAge', label: 'Max age (bars)', def: 3 }],
    eval: function (x, p) {
      var t = fvgOf(x).tags.filter(function (s) { return /^FVG\+Spring/.test(s); })[0];
      return { pass: !!t && ageOfTag(t) <= p.maxAge, value: t || null, detail: t || 'none' };
    } });
  def('zoneApproach', { label: 'Price at / near an untouched FVG zone', kind: 'sheet', setGroup: 'trigger', type: 'pullback', pit: true,
    ref: 'Code.gs ab_checkZoneAlerts_ (GapUpFVG / UnmitigatedFVG approach rule)', params: [],
    eval: function (x) {
      var w = FVG.watchZones(x.candles, x.fvgCfg);
      if (w.illiquid) return { pass: false, detail: 'illiquid - zones not watched' };
      for (var k = 0; k < w.zones.length; k++) {
        var z = w.zones[k], st = FVG.approachState(x.price, z, x.fvgCfg);
        if (st && st.approaching) return { pass: true, value: z, detail: z.kind + ' ' + round(z.bottom) + '–' + round(z.top) + (st.inZone ? ' (inside)' : ' (' + round(st.distancePct) + '% above)') };
      }
      return { pass: false, detail: w.zones.length ? 'zone(s) not reached' : 'no open zone' };
    } });
  def('emaSupport', { label: '{length} EMA support (touch & hold)', kind: 'sheet', setGroup: 'trigger', type: 'pullback', pit: true,
    ref: 'Code.gs ab_computeEmaSupportTag_', params: [{ key: 'length', label: 'EMA length', def: 10 }, { key: 'maxAge', label: 'Max age (bars)', def: 1 }, { key: 'touchPct', label: 'Touch tolerance %', def: 0.5 }],
    eval: function (x, p) {
      var t = I.emaSupportTag(I.sheetBars(x.candles), p.length, p.touchPct);   // on History30's window, like the sheet
      return { pass: !!t && ageOfTag(t) <= p.maxAge, value: t || null, detail: t || 'no support touch' };
    } });
  def('ttmBuy', { label: 'TTM Signal = Buy (target above price, growth ≥ 0, EPS > 0)', kind: 'sheet', setGroup: 'confirm', pit: false,
    ref: 'Main TTM Signal (ab_fixSignalFormulas_ rule)', params: [],
    eval: function (x) {
      var s = ttmSignal(x.stock, x.price);
      var cell = x.stock.sigSheet !== undefined ? x.stock.sigSheet : x.stock.sig;   // the exported cell (sigSheet once the site recomputes sig)
      return { pass: s === 'Buy', value: s || null, detail: s ? 'TTM Signal ' + s + ' at ' + (Math.round(x.price * 100) / 100) + (cell && cell !== s ? ' (sheet cell shows ' + cell + ')' : '') : 'no TTM target' };
    } });
  def('qualityWatch', { label: 'Quality Watch (TTM Buy + EPS ≥ 0 + OPM rising QoQ & YoY)', kind: 'sheet', setGroup: 'confirm', pit: false,
    ref: 'Code.gs ab_qualityWatchSymbols_', params: [],
    eval: function (x) {
      var s = x.stock;
      var ok = ttmSignal(s, x.price) === 'Buy' && isNum(s.lfyEps) && isNum(s.ttmEps) && s.ttmEps >= 0 &&
        OPM_UP.indexOf(String(s.opmq || '').toLowerCase()) >= 0 && OPM_UP.indexOf(String(s.opmy || '').toLowerCase()) >= 0;
      return { pass: ok, detail: 'OPM QoQ ' + (s.opmq || '–') + ', YoY ' + (s.opmy || '–') };
    } });

  // Pattern Dashboard confluence (ab_buildPatternDashboard_): number of NON-EMPTY
  // cells among Pattern (col W), FVG (col X), 10 EMA and 21 EMA support - 0..4.
  def('sheetConfluence', { label: 'Pattern Dashboard confluence ≥ {min} (Pattern, FVG, 10 EMA, 21 EMA)', kind: 'sheet', setGroup: 'trigger', pit: true,
    ref: 'Code.gs ab_buildPatternDashboard_ (confluence = non-empty Pattern/FVG/10 EMA/21 EMA cells; 3+ highlighted)',
    params: [{ key: 'min', label: 'Min confluence (1-4)', def: 3 }, { key: 'touchPct', label: 'EMA touch tolerance %', def: 0.5 }],
    eval: function (x, p) {
      var cells = {
        Pattern: patternsOf(x).join(', '),
        FVG: memo(x, 'fvgcol', function () { return FVG.columnTags(x.candles, x.fvgCfg); }),
        '10 EMA': I.emaSupportTag(I.sheetBars(x.candles), 10, p.touchPct),
        '21 EMA': I.emaSupportTag(I.sheetBars(x.candles), 21, p.touchPct)
      };
      var on = Object.keys(cells).filter(function (k) { return !!cells[k]; });
      var types = [];
      if (cells.Pattern) types.push('reversal');
      if (cells.FVG || cells['10 EMA'] || cells['21 EMA']) types.push('pullback');
      return { pass: on.length >= p.min, partial: on.length > 0 && on.length < p.min, value: on.length, types: types, cells: cells,
        detail: 'confluence ' + on.length + '/4' + (on.length ? ': ' + on.map(function (k) { return k + ' = ' + cells[k]; }).join(' · ') : '') };
    } });
  def('fieldIn', { label: '{field} is one of {values}', kind: 'sheet', setGroup: 'confirm', pit: false,
    ref: 'Smart Dashboard tag filters (exact, case-insensitive; blank fails)',
    params: [{ key: 'field', label: 'Main column', def: 'opmq', options: ['opmq', 'opmy', 'promo', 'fii', 'sig'] }, { key: 'values', label: 'Allowed values', def: ['Increasing'] }],
    eval: function (x, p) {
      var raw = p.field === 'sig' ? ttmSignal(x.stock, x.price) : x.stock[p.field];
      var v = String(raw == null ? '' : raw).trim().toLowerCase();
      var ok = !!v && p.values.some(function (a) { return String(a).toLowerCase() === v; });
      return { pass: ok, value: raw || null, detail: FIELD_LABEL[p.field] + ' = ' + (raw || 'blank') };
    } });
  def('fieldRange', { label: '{field} between {min} and {max}', kind: 'sheet', setGroup: 'confirm', pit: false,
    ref: 'Smart Dashboard range filters (inclusive; blank bound = no limit; missing value fails)',
    params: [{ key: 'field', label: 'Main column', def: 'qrev', options: ['up', 'pevs', 'down52', 'epsg', 'qrev', 'volchg', 'chg', 'd10', 'd30'] }, { key: 'min', label: 'Min (blank = none)', def: '' }, { key: 'max', label: 'Max (blank = none)', def: '' }],
    eval: function (x, p) {
      var v = x.stock[p.field], lo = p.min === '' || p.min == null ? -Infinity : Number(p.min), hi = p.max === '' || p.max == null ? Infinity : Number(p.max);
      if (!isNum(v)) return { pass: false, detail: FIELD_LABEL[p.field] + ' missing' };
      return { pass: v >= lo && v <= hi, value: v, detail: FIELD_LABEL[p.field] + ' = ' + round(v, 2) };
    } });

  // ---------- post-results opportunities (your rules, from the Results Performance tab) ----------
  // stock.rp = the stock's latest Results Performance row (see rpIndex): since / maxGain / maxDD (%),
  // verdict Strong|Mixed|Weak, reaction Rallied|Flat|Sold off (the sheet's reaction is measured on
  // the CURRENT move since results, +/- 5%), and the quarter's growth figures / OPM trends.
  var RP_TYPES = { rally: 'Immediate rally', delayed: 'Delayed reaction', second: 'Second opportunity after rally', eroded: 'Rally gains eroded' };
  function upWord(v) { return /increas|improv|rising|up/i.test(String(v || '')) ? true : /decreas|declin|falling|down/i.test(String(v || '')) ? false : null; }
  /** How many of the quarter's figures support the result: [label, true | false | null (no data), text]. */
  function rpSupport(s) {
    var rp = s.rp || {};
    var num = function (label, v) { return [label, isNum(v) ? v > 0 : null, isNum(v) ? (v > 0 ? '+' : '') + Math.round(v) + '%' : 'no data']; };
    var trend = function (label, v) { return [label, upWord(v), v ? String(v) : 'no data']; };
    var items = [num('Rev YoY', rp.revYoY), num('Profit YoY', rp.npYoY), num('Rev QoQ', rp.revQoQ), num('Profit QoQ', rp.npQoQ),
      trend('OPM QoQ', rp.opmQoQ), trend('OPM YoY', rp.opmYoY), num('EPS growth', s.epsg), trend('FII', s.fii)];
    var known = items.filter(function (x) { return x[1] !== null; }), pos = known.filter(function (x) { return x[1]; }).length;
    return { items: items, n: known.length, pos: pos, pct: known.length ? pos / known.length * 100 : null };
  }
  function supportText(sp) {
    return sp.items.map(function (x) { return x[0] + ' ' + x[2] + (x[1] === true ? ' ✓' : x[1] === false ? ' ✗' : ''); }).join(' · ');
  }
  def('postResults', { label: 'Post-results opportunity (Immediate rally / Delayed reaction / Second opportunity / Rally gains eroded)', kind: 'std', setGroup: 'trigger', pit: false,
    ref: 'Your post-results rules, on the Results Performance tab (Since results, Max gain, Max drawdown, Verdict, Reaction)',
    params: [{ key: 'rallyMin', label: 'A rally = max gain since results at least (%)', def: 5 },
      { key: 'keepRally', label: 'Immediate rally: still holds at least (% of max gain)', def: 80 },
      { key: 'keepSecond', label: 'Second opportunity: still holds at least (% of max gain)', def: 60 },
      { key: 'keepErased', label: 'Gains "nearly erased" below (% of max gain)', def: 25 },
      { key: 'maxDrawdown', label: 'Delayed reaction: max drawdown no worse than (%)', def: 8 }],
    eval: function (x, p) {
      var s = x.stock || {}, rp = s.rp;
      if (!rp) return { pass: false, detail: 'no Results Performance record (no result this season yet)' };
      var S = rp.since, G = rp.maxGain, D = rp.maxDD, V = String(rp.verdict || ''), R = String(rp.reaction || '');
      if (!isNum(S) || !isNum(G)) return { pass: false, detail: 'price record since results incomplete' };
      var keep = G > 0 ? S / G * 100 : null, sp = rpSupport(s);
      var rec = 'since results ' + (S > 0 ? '+' : '') + round(S, 1) + '%, max gain +' + round(G, 1) + '%' + (keep != null && G >= p.rallyMin ? ' (still holds ' + Math.round(Math.max(keep, -999)) + '% of it)' : '') +
        ', max drawdown ' + (isNum(D) ? round(D, 1) + '%' : 'n/a') + ' · verdict ' + (V || 'n/a') + ', reaction ' + (R || 'n/a');
      var out = function (type, sub, ok, why, rank) {
        var name = RP_TYPES[type] + (sub ? ' (' + sub + ')' : '');
        return { pass: ok === true, partial: ok === 'watch', value: keep, types: [name], rank: rank, rpType: type,
          detail: name + ' - ' + rec + (why ? ' · ' + why : '') };
      };
      var strong = V === 'Strong', support = isNum(sp.pct) ? sp.pct : 0;
      var rallied = G >= p.rallyMin;
      if (rallied && R === 'Rallied' && keep >= p.keepRally) {
        return out('rally', '', strong ? true : V === 'Mixed' ? 'watch' : false, strong ? 'gains held' : 'verdict ' + (V || 'missing') + ', not Strong', support);
      }
      if (rallied && R === 'Rallied' && keep >= p.keepSecond) {
        return out('second', '', strong ? true : V === 'Mixed' ? 'watch' : false, strong ? 'pulled back ' + Math.round(100 - keep) + '% of the gain' : 'verdict ' + (V || 'missing') + ', not Strong', support);
      }
      if (rallied) {
        var erased = keep < p.keepErased;
        var gave = Math.min(100, 100 - keep);
        return out('eroded', erased ? 'nearly erased' : 'about half given back', strong ? true : V === 'Mixed' ? 'watch' : false,
          strong ? 'gave back ' + Math.round(gave) + '% of the gain' : V === 'Mixed' ? 'verdict Mixed - thesis only partly supported' : 'verdict ' + (V || 'missing') + ' - thesis not supported',
          (support + gave) / 2);
      }
      if (R === 'Flat' && strong) {
        var stable = !isNum(D) || D >= -p.maxDrawdown;
        return out('delayed', stable ? '' : 'weak price record', stable ? true : 'watch',
          stable ? 'stable so far despite strong results' : 'max drawdown ' + round(D, 1) + '% - weaker than ' + p.maxDrawdown + '%', support);
      }
      return { pass: false, detail: 'not one of the four post-results set-ups - ' + rec };
    } });
  def('resultsSupport', { label: 'Quarter\'s figures support the result: at least {min}% positive (Rev / Profit YoY & QoQ, OPM QoQ & YoY, EPS growth, FII)', kind: 'std', setGroup: 'confirm', pit: false,
    params: [{ key: 'min', label: 'Min % of available figures positive', def: 60 }],
    eval: function (x, p) {
      var sp = rpSupport(x.stock || {});
      if (!sp.n) return { pass: false, detail: 'no quarterly figures' };
      return { pass: sp.pct >= p.min, value: sp.pct, detail: sp.pos + ' of ' + sp.n + ' positive (' + Math.round(sp.pct) + '%): ' + supportText(sp) };
    } });

  // standard rules (not in the sheet)
  def('breakout', { label: 'Close above the prior {length}-bar high', kind: 'std', setGroup: 'trigger', type: 'breakout', pit: true,
    params: [{ key: 'length', label: 'Lookback bars', def: 20 }, { key: 'minRelVol', label: 'Min relative volume', def: 1.5 }],
    eval: function (x, p) {
      if (x.n < p.length + 1) return { pass: null, detail: 'needs ' + (p.length + 1) + ' bars' };
      var hi = I.priorHigh(x.candles, x.n - 1, p.length), rv = I.relVolume(x.candles, Math.min(20, x.n - 1))[x.n - 1];
      var ok = x.bar.c > hi && (!(p.minRelVol > 0) || rv >= p.minRelVol);
      return { pass: ok, value: hi, detail: 'close ' + round(x.bar.c) + ' vs prior high ' + round(hi) + (isNum(rv) ? ', rel. volume ' + round(rv, 2) + '×' : '') };
    } });
  def('closeAboveEma', { label: 'Close above {length} EMA', kind: 'std', setGroup: 'confirm', pit: true, params: [{ key: 'length', label: 'EMA length', def: 21 }],
    eval: function (x, p) { var e = emaOf(x, p.length)[x.n - 1]; if (!isNum(e)) return { pass: null, detail: 'not enough bars' }; return { pass: x.bar.c > e, value: e, detail: 'EMA' + p.length + ' ' + round(e) }; } });
  def('emaTrend', { label: '{fast} EMA above {slow} EMA', kind: 'std', setGroup: 'confirm', pit: true, params: [{ key: 'fast', label: 'Fast', def: 10 }, { key: 'slow', label: 'Slow', def: 21 }],
    eval: function (x, p) { var f = emaOf(x, p.fast)[x.n - 1], s = emaOf(x, p.slow)[x.n - 1]; if (!isNum(f) || !isNum(s)) return { pass: null, detail: 'not enough bars' }; return { pass: f > s, detail: round(f) + ' vs ' + round(s) }; } });
  def('rsiRange', { label: 'RSI(14) between {min} and {max}', kind: 'std', setGroup: 'confirm', pit: true, params: [{ key: 'min', label: 'Min', def: 40 }, { key: 'max', label: 'Max', def: 70 }],
    eval: function (x, p) { var r = I.rsi(x.candles, 14)[x.n - 1]; if (!isNum(r)) return { pass: null, detail: 'needs 15 bars' }; return { pass: r >= p.min && r <= p.max, value: r, detail: 'RSI ' + round(r, 1) }; } });
  def('macdBull', { label: 'MACD above its signal line', kind: 'std', setGroup: 'confirm', pit: true, params: [],
    eval: function (x) { var m = I.macd(x.candles); var a = m.macd[x.n - 1], b = m.signal[x.n - 1]; if (!isNum(a) || !isNum(b)) return { pass: null, detail: 'needs ~35 bars' }; return { pass: a > b, detail: round(a, 3) + ' vs ' + round(b, 3) }; } });
  def('relVolume', { label: 'Relative volume ≥ {min}×', kind: 'std', setGroup: 'confirm', pit: true, params: [{ key: 'min', label: 'Min', def: 1.2 }],
    eval: function (x, p) { var r = I.relVolume(x.candles, Math.min(20, x.n - 1))[x.n - 1]; if (!isNum(r)) return { pass: null, detail: 'no volume' }; return { pass: r >= p.min, value: r, detail: round(r, 2) + '×' }; } });
  def('pullbackToEma', { label: 'Pullback to {length} EMA (low within {pct}%) in an uptrend', kind: 'std', setGroup: 'trigger', type: 'pullback', pit: true,
    params: [{ key: 'length', label: 'EMA length', def: 10 }, { key: 'pct', label: 'Within %', def: 1 }],
    eval: function (x, p) {
      var e = emaOf(x, p.length)[x.n - 1];
      if (!isNum(e)) return { pass: null, detail: 'not enough bars' };
      var ok = x.bar.c > e && x.bar.l <= e * (1 + p.pct / 100);
      return { pass: ok, value: e, detail: 'low ' + round(x.bar.l) + ', EMA' + p.length + ' ' + round(e) };
    } });
  def('upsideMin', { label: 'TTM upside ≥ {pct}%', kind: 'std', setGroup: 'confirm', pit: false, params: [{ key: 'pct', label: 'Min upside %', def: 20 }],
    eval: function (x, p) { var t = x.stock.tgt; if (!isNum(t) || !(x.price > 0)) return { pass: null, detail: 'no TTM target' }; var u = (t / x.price - 1) * 100; return { pass: u >= p.pct, value: u, detail: round(u, 0) + '%' }; } });
  def('peVsIndustryMax', { label: 'PE ≤ {max}× industry PE', kind: 'std', setGroup: 'confirm', pit: false, params: [{ key: 'max', label: 'Max ratio', def: 1 }],
    eval: function (x, p) { var r = x.stock.pevs; if (!isNum(r)) return { pass: null, detail: 'no industry PE' }; return { pass: r <= p.max, value: r, detail: round(r, 2) + '×' }; } });

  // ---------- presets ----------
  var PRESETS = {
    sheet: {
      id: 'sheet', name: 'Pattern Dashboard confluence (from your sheet)', version: 1, source: 'discovered', mode: 'setup', style: 'swing', timeframe: '1d',
      description: 'Your Pattern Dashboard: a stock is listed when its Pattern, FVG, 10 EMA or 21 EMA support cells are filled, and confluence 3+ is highlighted. Liquidity and circuit-lock filters come from your FVG watch tabs. Turning this into an entry candidate (and the stop/target below) is not written in the sheet - please confirm.',
      universe: { categories: [], minBars: 17 },
      filters: [{ id: 'liquidity', params: { minTurnover: 5000000 } }, { id: 'notCircuitLocked' }],
      triggers: [{ id: 'sheetConfluence', params: { min: 3 } }, { id: 'zoneApproach', watchOnly: true }],
      confirms: [{ id: 'ttmBuy', enabled: false }],
      qualify: { minTriggers: 1 },
      exits: { stop: { method: 'atr', mult: 2 }, target: { method: 'pct', pct: 10 }, minRR: 0 },
      events: { warnDays: 7 },
      assumptions: [
        'Qualified = filters pass + Pattern Dashboard confluence ≥ 3 (your dashboard highlights 3+ in dark green). Confluence 1-2 is shown as Watch.',
        'An FVG zone being approached (your GapUpFVG / UnmitigatedFVG alert rule) is shown as Watch only.',
        'TTM Signal = Buy is available as an extra requirement but is OFF, because the Pattern Dashboard does not use it.',
        'Stop-loss = entry − 2 × ATR14 (Main\'s "ATR" column is 2 × ATR14); the sheet itself uses your hand-typed Stoploss.',
        'Target = entry + 10% (AB_TRADE_WIN_PCT, the sheet\'s Win rule measured from entry). Entry reference = the latest daily close (end-of-day, like Phase 2 at 18:53 IST).'
      ]
    },
    qualityGrowth: {
      id: 'qualityGrowth', name: 'Quality Growth (Smart Dashboard preset)', version: 1, source: 'discovered', mode: 'screen', style: 'positional', timeframe: '1d',
      description: 'Your Smart Dashboard preset: OPM YoY and QoQ rising, TTM Signal Buy, QoQ revenue growth ≥ 10%. A fundamental screen - no entry timing.',
      universe: { categories: [], minBars: 0 }, filters: [], triggers: [],
      confirms: [{ id: 'fieldIn', params: { field: 'opmy', values: UP3 } }, { id: 'fieldIn', params: { field: 'opmq', values: UP3 } },
        { id: 'ttmBuy' }, { id: 'fieldRange', params: { field: 'qrev', min: 10, max: '' } }],
      qualify: { minTriggers: 0 }, exits: { stop: { method: 'atr', mult: 2 }, target: { method: 'pct', pct: 10 }, minRR: 0 }, events: { warnDays: 7 }, assumptions: []
    },
    smartMoney: {
      id: 'smartMoney', name: 'Smart Money Buying (Smart Dashboard preset)', version: 1, source: 'discovered', mode: 'screen', style: 'positional', timeframe: '1d',
      description: 'Your Smart Dashboard preset: FII activity Increasing, promoter holding Increasing or Stagnant, TTM Signal Buy.',
      universe: { categories: [], minBars: 0 }, filters: [], triggers: [],
      confirms: [{ id: 'fieldIn', params: { field: 'fii', values: ['Increasing'] } }, { id: 'fieldIn', params: { field: 'promo', values: ['Increasing', 'Stagnant'] } }, { id: 'ttmBuy' }],
      qualify: { minTriggers: 0 }, exits: { stop: { method: 'atr', mult: 2 }, target: { method: 'pct', pct: 10 }, minRR: 0 }, events: { warnDays: 7 }, assumptions: []
    },
    deepValue: {
      id: 'deepValue', name: 'Deep Value (Smart Dashboard preset)', version: 1, source: 'discovered', mode: 'screen', style: 'long-term', timeframe: '1d',
      description: 'Your Smart Dashboard preset: TTM Signal Buy, PE vs industry PE 0.01-0.8, upside ≥ 20%.',
      universe: { categories: [], minBars: 0 }, filters: [], triggers: [],
      confirms: [{ id: 'ttmBuy' }, { id: 'fieldRange', params: { field: 'pevs', min: 0.01, max: 0.8 } }, { id: 'fieldRange', params: { field: 'up', min: 20, max: '' } }],
      qualify: { minTriggers: 0 }, exits: { stop: { method: 'atr', mult: 2 }, target: { method: 'pct', pct: 10 }, minRR: 0 }, events: { warnDays: 7 }, assumptions: []
    },
    volumeBreakout: {
      id: 'volumeBreakout', name: 'Volume Breakout (Smart Dashboard preset)', version: 1, source: 'discovered', mode: 'screen', style: 'swing', timeframe: '1d',
      description: 'Your Smart Dashboard preset: TTM Signal Buy and today\'s volume at least double the previous session (Vol Change ≥ 100%).',
      universe: { categories: [], minBars: 0 }, filters: [], triggers: [],
      confirms: [{ id: 'ttmBuy' }, { id: 'fieldRange', params: { field: 'volchg', min: 100, max: '' } }],
      qualify: { minTriggers: 0 }, exits: { stop: { method: 'atr', mult: 2 }, target: { method: 'pct', pct: 10 }, minRR: 0 }, events: { warnDays: 7 }, assumptions: []
    },
    beatenDown: {
      id: 'beatenDown', name: 'Beaten Down + Improving (Smart Dashboard preset)', version: 1, source: 'discovered', mode: 'screen', style: 'long-term', timeframe: '1d',
      description: 'Your Smart Dashboard preset: OPM QoQ rising and at least 30% below the 52-week high. No TTM Signal filter.',
      universe: { categories: [], minBars: 0 }, filters: [], triggers: [],
      confirms: [{ id: 'fieldIn', params: { field: 'opmq', values: UP3 } }, { id: 'fieldRange', params: { field: 'down52', min: '', max: -30 } }],
      qualify: { minTriggers: 0 }, exits: { stop: { method: 'atr', mult: 2 }, target: { method: 'pct', pct: 10 }, minRR: 0 }, events: { warnDays: 7 }, assumptions: []
    },
    postResults: {
      id: 'postResults', name: 'Post-results opportunities (your rules)', version: 1, source: 'request', mode: 'setup', style: 'swing', timeframe: '1d',
      description: 'Your rules for trading after quarterly results, on the Results Performance tab: Immediate rally, Delayed reaction, Second opportunity after a rally ' +
        'and Rally gains eroded - judged on Since results, Max gain, Max drawdown, Verdict and Reaction, with the quarter\'s Rev / Profit YoY & QoQ, OPM QoQ & YoY, ' +
        'EPS growth and FII as support. A research screen: a fall after a rally does not mean another rally will follow.',
      universe: { categories: [], minBars: 15 }, filters: [],
      triggers: [{ id: 'postResults', params: { rallyMin: 5, keepRally: 80, keepSecond: 60, keepErased: 25, maxDrawdown: 8 } }],
      confirms: [{ id: 'resultsSupport', params: { min: 60 } }],
      qualify: { minTriggers: 1 },
      exits: { stop: { method: 'atr', mult: 2 }, target: { method: 'pct', pct: 10 }, minRR: 0 },
      events: { warnDays: 7 },
      assumptions: [
        'A "rally" = Max gain since results of at least 5% (the sheet\'s Rallied / Sold off threshold, Control Panel AB_RP_MOVE_PCT). The sheet\'s Reaction is measured on the CURRENT move since results, so a stock that rallied and gave the gain back shows Flat or Sold off - type 4 therefore uses Max gain, not Reaction.',
        'Immediate rally: Reaction Rallied, Verdict Strong, still holding at least 80% of its max gain.',
        'Second opportunity after rally: Reaction Rallied, Verdict Strong, still holding 60-80% of its max gain (a pullback within the rally).',
        'Rally gains eroded: rallied (max gain ≥ 5%) but holds less than 60% of the gain; "about half given back" = 25-60% kept, "nearly erased" = under 25% kept. Verdict Strong qualifies, Mixed is Watch, Weak is left out. Ranked by how much was given back and by the quarter\'s figures.',
        'Delayed reaction: Reaction Flat, Verdict Strong, never rallied (max gain under 5%); max drawdown no worse than −8% = stable, worse = "weak price record" (Watch).',
        'Supporting figures: at least 60% of the available figures positive - Rev YoY, Profit YoY, Rev QoQ, Profit QoQ > 0, OPM QoQ and OPM YoY increasing, TTM EPS growth > 0, FII increasing (FII only where available). Below 60% = Watch.',
        'Stop / target are the same placeholders as your other presets (2 × ATR, +10%); they are not part of your rules.',
        'All percentages are editable below. Nothing here predicts a move - it sorts stocks into the four set-ups you described.'
      ]
    },
    demo: {
      id: 'demo', name: 'DEMO - EMA trend pullback (for testing only)', version: 1, source: 'demo', mode: 'setup', style: 'swing', timeframe: '1d',
      description: 'A generic example strategy to test the engine. It is NOT your strategy and its signals are not recommendations.',
      universe: { categories: [], minBars: 22 },
      filters: [{ id: 'liquidity', params: { minTurnover: 10000000 } }, { id: 'notCircuitLocked' }, { id: 'minPrice', params: { min: 50 } }, { id: 'resultsNotWithin', params: { days: 3 } }],
      triggers: [{ id: 'pullbackToEma', params: { length: 10, pct: 1 } }, { id: 'breakout', params: { length: 20, minRelVol: 1.5 } }],
      confirms: [{ id: 'emaTrend', params: { fast: 10, slow: 21 } }, { id: 'rsiRange', params: { min: 40, max: 70 } }],
      qualify: { minTriggers: 1 },
      exits: { stop: { method: 'swing', bars: 10 }, target: { method: 'rr', rr: 2 }, minRR: 1.5 },
      events: { warnDays: 7 },
      assumptions: ['DEMO only.']
    }
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /** Validate + normalise a config. -> { ok, errors, config } */
  function validate(cfgIn) {
    var errors = [], cfg = clone(cfgIn || {});
    if (!cfg.name) errors.push('name is required');
    cfg.version = Math.max(1, parseInt(cfg.version, 10) || 1);
    cfg.mode = cfg.mode === 'screen' ? 'screen' : 'setup';
    cfg.universe = cfg.universe || { categories: [], minBars: 17 };
    cfg.universe.minBars = cfg.mode === 'screen' ? 0 : Math.max(2, Number(cfg.universe.minBars) || 17);
    ['filters', 'triggers', 'confirms'].forEach(function (g) {
      cfg[g] = (cfg[g] || []).filter(function (r) {
        if (!r || !C[r.id]) { errors.push(g + ': unknown condition ' + (r && r.id)); return false; }
        var d = C[r.id];
        r.params = r.params || {};
        (d.params || []).forEach(function (pp) {
          var v = r.params[pp.key];
          if (v == null || v === '') v = clone(pp.def);
          if (typeof pp.def === 'number') { v = Number(v); if (!isFinite(v)) { errors.push(d.id + '.' + pp.key + ' must be a number'); v = pp.def; } }
          if (Array.isArray(pp.def) && !Array.isArray(v)) v = String(v).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
          r.params[pp.key] = v;
        });
        if (r.enabled === undefined) r.enabled = true;
        return true;
      });
    });
    cfg.mode = cfg.mode === 'screen' ? 'screen' : 'setup';
    cfg.qualify = cfg.qualify || {};
    cfg.qualify.minTriggers = cfg.mode === 'screen' ? 0 : Math.max(1, parseInt(cfg.qualify.minTriggers, 10) || 1);
    cfg.exits = cfg.exits || { stop: { method: 'atr', mult: 2 }, target: { method: 'pct', pct: 10 }, minRR: 0 };
    var st = cfg.exits.stop || {}, tg = cfg.exits.target || {};
    if (['atr', 'pct', 'swing', 'zone'].indexOf(st.method) < 0) errors.push('stop method must be atr, pct, swing or zone');
    if (['pct', 'rr'].indexOf(tg.method) < 0) errors.push('target method must be pct or rr');
    if (st.method === 'atr' && !(Number(st.mult) > 0)) errors.push('ATR multiple must be above 0');
    if (st.method === 'pct' && !(Number(st.pct) > 0 && Number(st.pct) < 50)) errors.push('stop % must be between 0 and 50');
    if (tg.method === 'pct' && !(Number(tg.pct) > 0)) errors.push('target % must be above 0');
    if (tg.method === 'rr' && !(Number(tg.rr) > 0)) errors.push('target R multiple must be above 0');
    cfg.exits.minRR = Number(cfg.exits.minRR) || 0;
    cfg.events = cfg.events || { warnDays: 7 };
    if (cfg.mode === 'setup' && !cfg.triggers.filter(function (r) { return r.enabled && !r.watchOnly; }).length) errors.push('enable at least one trigger');
    if (cfg.mode === 'screen' && !cfg.confirms.filter(function (r) { return r.enabled; }).length && !cfg.filters.length) errors.push('a screen needs at least one condition');
    return { ok: !errors.length, errors: errors, config: cfg };
  }

  /** Changes between two configs, for the change history. */
  function diff(a, b) {
    var out = [];
    function walk(x, y, path) {
      if (JSON.stringify(x) === JSON.stringify(y)) return;
      if (Array.isArray(x) && Array.isArray(y) && (typeof x[0] === 'object' || typeof y[0] === 'object')) {
        if (x.length !== y.length) { out.push(path + ': ' + x.length + ' → ' + y.length + ' rules'); return; }
        for (var i = 0; i < x.length; i++) walk(x[i], y[i], path + '[' + (i + 1) + ']');
        return;
      }
      if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) {
        Object.keys(Object.assign({}, x, y)).forEach(function (k) { walk(x[k], y[k], path ? path + '.' + k : k); });
      } else out.push(path + ': ' + JSON.stringify(x) + ' → ' + JSON.stringify(y));
    }
    walk(a, b, '');
    return out.filter(function (s) { return !/^version:|^history|^confirmed|^updatedAt|^__valid/.test(s); });
  }

  function label(rule) {
    var d = C[rule.id], s = d.label;
    Object.keys(rule.params || {}).forEach(function (k) {
      var v = rule.params[k];
      if (k === 'minTurnover') v = (v / 1e5) + ' lakh';
      if (k === 'field') v = FIELD_LABEL[v] || v;
      if (k === 'values' && Array.isArray(v)) v = v.join(' / ');
      if ((k === 'min' || k === 'max') && rule.id === 'fieldRange' && (v === '' || v == null)) v = k === 'min' ? '−∞' : '∞';
      s = s.replace('{' + k + '}', Array.isArray(v) ? v.length + ' selected' : v);
    });
    return s;
  }

  function stopTarget(cfg, x, triggers) {
    var entry = x.bar ? x.bar.c : NaN, st = cfg.exits.stop, tg = cfg.exits.target, stop = NaN, note = '';
    if (cfg.mode === 'screen') return { entry: x.price, stop: NaN, target: NaN, rr: NaN, stopNote: 'screen - no entry timing' };
    if (!(entry > 0)) return { entry: NaN };
    if (st.method === 'atr') { var a = atrOf(x); if (isNum(a)) { stop = entry - st.mult * a; note = st.mult + ' × ATR14 (' + round(a) + ')'; } }
    else if (st.method === 'pct') { stop = entry * (1 - st.pct / 100); note = st.pct + '% below entry'; }
    else if (st.method === 'swing') { var lo = I.priorLow(x.candles, x.n, Math.min(st.bars || 10, x.n)); stop = lo < entry ? lo * 0.999 : NaN; note = 'below the ' + (st.bars || 10) + '-bar low'; }
    else if (st.method === 'zone') {
      /** @type {any} */ var z = null;
      triggers.forEach(function (t) { if (t.res.value && t.res.value.bottom) z = t.res.value; });
      if (z) { stop = z.bottom * 0.995; note = 'below the FVG zone bottom'; }
      else { var a2 = atrOf(x); if (isNum(a2)) { stop = entry - 2 * a2; note = 'no zone - 2 × ATR14'; } }
    }
    if (!(stop > 0) || stop >= entry) return { entry: entry, stop: NaN, target: NaN, rr: NaN, stopNote: 'no valid stop below entry' };
    var target = tg.method === 'pct' ? entry * (1 + tg.pct / 100) : entry + tg.rr * (entry - stop);
    return { entry: entry, stop: stop, target: target, rr: (target - entry) / (entry - stop), stopNote: note,
      targetNote: tg.method === 'pct' ? '+' + tg.pct + '%' : tg.rr + 'R' };
  }

  /** Evaluate one stock at its context. */
  function evaluate(cfgIn, x) {
    var cfg = cfgIn.__valid ? cfgIn : validate(cfgIn).config;
    var res = { status: 'none', statusLabel: 'No signal', setupTypes: [], checks: [], triggersPassed: [], failed: [], warnings: [], score: 0 };
    var minBars = cfg.universe.minBars;
    if (cfg.mode === 'screen' && x && !(x.price > 0)) { res.status = 'insufficient'; res.statusLabel = 'Insufficient data'; res.failed.push('no price'); return res; }
    if (cfg.mode !== 'screen' && (!x || !x.bar || !(x.bar.c > 0))) { res.status = 'insufficient'; res.statusLabel = 'Insufficient data'; res.failed.push('no candle data'); return res; }
    if (x.n < minBars) { res.status = 'insufficient'; res.statusLabel = 'Insufficient data'; res.failed.push('only ' + x.n + ' daily bars (needs ' + minBars + ')'); return res; }
    function run(group, rules) {
      return rules.filter(function (r) { return r.enabled !== false; }).map(function (r) {
        var d = C[r.id];
        if (x.pointInTime && d.pit === false) return { id: r.id, group: group, label: label(r), res: { pass: null, detail: 'not used in backtests (today\'s fundamentals would leak)' }, kind: d.kind };
        var out;
        try { out = d.eval(x, r.params || {}); } catch (e) { out = { pass: null, detail: 'error: ' + e.message }; }
        return { id: r.id, group: group, label: label(r), res: out, kind: d.kind, type: d.type, watchOnly: !!r.watchOnly };
      });
    }
    var f = run('filter', cfg.filters), t = run('trigger', cfg.triggers), c = run('confirm', cfg.confirms);
    res.checks = f.concat(t, c);
    var fFail = f.filter(function (k) { return k.res.pass === false; });
    var tPass = t.filter(function (k) { return k.res.pass === true && !k.watchOnly; });
    var tWatch = t.filter(function (k) { return (k.res.pass === true && k.watchOnly) || k.res.partial; });
    var cFail = c.filter(function (k) { return k.res.pass === false; });
    var cNa = c.filter(function (k) { return k.res.pass == null; });
    res.triggersPassed = tPass.map(function (k) { return k.label; });
    res.confluence = tPass.length;
    tPass.concat(tWatch).forEach(function (k) {
      (k.res.types || (k.type ? [k.type] : [])).forEach(function (ty) { if (res.setupTypes.indexOf(ty) < 0) res.setupTypes.push(ty); });
    });
    if (tPass.length && tPass[0].res.cells) res.confluence = tPass[0].res.value;
    else if (t.length && t[0].res.cells) res.confluence = t[0].res.value;
    if (cfg.mode === 'screen') res.setupTypes = ['screen'];
    var rk = t.map(function (k) { return k.res.rank; }).filter(isNum);
    if (rk.length) res.rank = Math.max.apply(null, rk);   // a rule's own ranking (post-results), after the score
    var need = cfg.qualify.minTriggers;
    var slots = f.length + c.filter(function (k) { return k.res.pass != null; }).length + need;
    var got = f.filter(function (k) { return k.res.pass !== false; }).length + c.filter(function (k) { return k.res.pass === true; }).length + Math.min(need, tPass.length);
    res.score = slots ? Math.round(got / slots * 100) : 0;
    res.scoreNote = got + ' of ' + slots + ' requirements met';

    var lv = stopTarget(cfg, x, tPass);
    res.entry = lv.entry; res.stop = lv.stop; res.target = lv.target; res.rr = lv.rr; res.stopNote = lv.stopNote; res.targetNote = lv.targetNote;
    if (x.stock && x.stock.rdate && x.refDate && cfg.events && cfg.events.warnDays) {
      var rd = new Date(String(x.stock.rdate).slice(0, 10) + 'T00:00:00'), ref = new Date(String(x.refDate).slice(0, 10) + 'T00:00:00');
      var dd = Math.round((rd.getTime() - ref.getTime()) / 864e5);
      if (dd >= 0 && dd <= cfg.events.warnDays) res.warnings.push('Results due in ' + dd + ' day' + (dd === 1 ? '' : 's') + ' (' + String(x.stock.rdate).slice(0, 10) + ')');
    }

    if (fFail.length) {
      res.status = 'avoid'; res.statusLabel = 'Avoid';
      res.failed = fFail.map(function (k) { return k.label + ' - ' + (k.res.detail || 'failed'); });
      return res;
    }
    if (cfg.mode === 'screen') {
      var sFail = c.filter(function (k) { return k.res.pass !== true; });
      if (sFail.length) { res.status = 'none'; res.statusLabel = 'Does not match'; res.failed = sFail.map(function (k) { return k.label + ' - ' + (k.res.detail || 'failed'); }); }
      else { res.status = 'qualified'; res.statusLabel = 'Matches screen'; }
      return res;
    }
    if (!tPass.length) {
      if (tWatch.length) {
        res.status = 'watch'; res.statusLabel = 'Watch';
        res.failed = tWatch.map(function (k) { return k.label + ' - ' + (k.res.detail || ''); });
        return res;
      }
      res.status = 'none'; res.statusLabel = 'No signal'; res.failed.push('no trigger fired'); return res;
    }
    var reasons = [];
    if (tPass.length < need) reasons.push('only ' + tPass.length + ' of ' + need + ' required signal types');
    cFail.forEach(function (k) { reasons.push(k.label + ' - ' + (k.res.detail || 'failed')); });
    if (!x.pointInTime) cNa.forEach(function (k) { reasons.push(k.label + ' - ' + (k.res.detail || 'not available')); });
    if (!(res.stop > 0)) reasons.push(lv.stopNote || 'no valid stop-loss');
    else if (cfg.exits.minRR > 0 && !(res.rr >= cfg.exits.minRR)) reasons.push('reward:risk 1:' + round(res.rr, 2) + ' below 1:' + cfg.exits.minRR);
    if (reasons.length) { res.status = 'watch'; res.statusLabel = 'Watch'; res.failed = reasons; }
    else { res.status = 'qualified'; res.statusLabel = 'Qualified'; }
    return res;
  }

  /** Run a strategy over a universe.
   *  stocks: Main rows ({sym, cat, price, ...}); history: {SYM: candles}
   *  opts: { usePrice: use stock.price (live/snapshot) instead of the last close for price-based rules,
   *          latestDate: the dataset's latest session (older series are flagged stale) } */
  function run(cfgIn, stocks, history, opts) {
    opts = opts || {};
    var v = validate(cfgIn), cfg = v.config;
    cfg.__valid = true;
    var out = { config: cfg, errors: v.errors, results: [], bySym: {}, lists: {}, counts: {}, latestDate: opts.latestDate || null };
    var cats = cfg.universe.categories || [];
    stocks.forEach(function (s) {
      if (cats.length && cats.indexOf(s.cat) < 0) return;
      var candles = history[s.sym] || [];
      /** @type {any} */ var r;
      if (cfg.mode === 'screen') {
        r = evaluate(cfg, buildContext(s, candles, candles.length - 1, { usePrice: true, refDate: opts.refDate, fvgCfg: opts.fvgCfg, patternCfg: opts.patternCfg }));
      } else if (!candles.length) {
        r = { status: 'insufficient', statusLabel: 'Insufficient data', failed: ['no daily candles for this symbol'], checks: [], warnings: [], score: 0, setupTypes: [] };
      } else if (opts.latestDate && candles[candles.length - 1].t < opts.latestDate) {
        r = { status: 'insufficient', statusLabel: 'Insufficient data', failed: ['latest candle ' + candles[candles.length - 1].t + ' is older than the latest session ' + opts.latestDate], checks: [], warnings: [], score: 0, setupTypes: [] };
      } else {
        r = evaluate(cfg, buildContext(s, candles, candles.length - 1, { usePrice: opts.usePrice, refDate: opts.refDate, fvgCfg: opts.fvgCfg, patternCfg: opts.patternCfg }));
      }
      r.sym = s.sym;
      r.asOf = candles.length ? candles[candles.length - 1].t : null;
      r.qualified = r.status === 'qualified';
      out.results.push(r);
      out.bySym[s.sym] = r;
    });
    ['qualified', 'watch', 'avoid', 'insufficient', 'none'].forEach(function (k) {
      out.lists[k] = out.results.filter(function (r) { return r.status === k; });
      out.counts[k] = out.lists[k].length;
    });
    out.lists.breakout = out.results.filter(function (r) { return (r.status === 'qualified' || r.status === 'watch') && r.setupTypes.indexOf('breakout') >= 0; });
    out.lists.pullback = out.results.filter(function (r) { return (r.status === 'qualified' || r.status === 'watch') && r.setupTypes.indexOf('pullback') >= 0; });
    var rank = function (a, b) { return (b.score - a.score) || ((b.rank || 0) - (a.rank || 0)) || ((b.confluence || 0) - (a.confluence || 0)) || ((b.rr || 0) - (a.rr || 0)) || String(a.sym).localeCompare(String(b.sym)); };
    Object.keys(out.lists).forEach(function (k) { out.lists[k].sort(rank); });
    return out;
  }

  /** Results Performance table ({cols, rows}) -> { SYM: the latest row as stock.rp } (numbers in %). */
  function rpIndex(table) {
    var out = {};
    if (!table || !Array.isArray(table.cols) || !Array.isArray(table.rows)) return out;
    var ix = {};
    table.cols.forEach(function (c, i) { ix[c] = i; });
    var g = function (r, c) { return ix[c] == null ? null : r[ix[c]]; };
    var n = function (r, c) { var v = g(r, c); return isNum(v) ? v : null; };
    table.rows.forEach(function (r) {
      var sym = String(g(r, 'Symbol') || '').trim().toUpperCase();
      if (!sym) return;
      var rd = String(g(r, 'Result Date') || '');
      if (out[sym] && out[sym].resultDate >= rd) return;
      out[sym] = { quarter: g(r, 'Quarter'), resultDate: rd, resultDay: n(r, 'Result Day %'), since: n(r, '% Since Results'), maxGain: n(r, 'Max Gain %'),
        maxDD: n(r, 'Max Drawdown %'), verdict: g(r, 'Results Verdict'), reaction: g(r, 'Market Reaction'), revQoQ: n(r, 'Rev QoQ %'), revYoY: n(r, 'Rev YoY %'),
        npQoQ: n(r, 'NP QoQ %'), npYoY: n(r, 'NP YoY %'), opmQoQ: g(r, 'OPM QoQ'), opmYoY: g(r, 'OPM YoY') };
    });
    return out;
  }

  /** Exit / risk warnings for open positions [{sym, side, entry, stop, target, qty}] at the latest data.
   *  side 'short' mirrors every check (stop above, target below, close above the 21 EMA). */
  function positionWarnings(positions, stocksBySym, history) {
    return (positions || []).map(function (p) {
      var s = stocksBySym[p.sym] || {}, c = history[p.sym] || [], last = c[c.length - 1];
      var px = isNum(s.price) ? s.price : last ? last.c : NaN, w = [], short = p.side === 'short', sg = short ? -1 : 1;
      if (!isNum(px)) w.push('no current price');
      else {
        if (p.stop > 0 && sg * (px - p.stop) <= 0) w.push((short ? 'at or above' : 'at or below') + ' your stop-loss ' + p.stop);
        else if (p.stop > 0 && sg * (px - p.stop) / px * 100 <= 2) w.push('within 2% of the stop-loss');
        if (p.target > 0 && sg * (px - p.target) >= 0) w.push('target ' + p.target + ' reached');
        if (c.length >= 22) {
          var e = I.ema(c, 21)[c.length - 1];
          if (last && sg * (last.c - e) < 0) w.push(short ? 'closed above the 21 EMA' : 'closed below the 21 EMA');
        }
        // sheet rule (long only): Loss when close <= stop, Win when close >= entry x 1.10
        if (!short && p.entry > 0 && px >= p.entry * 1.10) w.push('+10% from entry (the sheet\'s Win rule)');
        if (short && p.entry > 0 && px <= p.entry * 0.90) w.push('10% in your favour from entry');
      }
      return { sym: p.sym, price: px, pnlPct: isNum(px) && p.entry > 0 ? sg * (px / p.entry - 1) * 100 : NaN, warnings: w, position: p };
    });
  }

  return {
    CONDITIONS: C, PRESETS: PRESETS, BULLISH_PATTERNS: BULLISH_PATTERNS, buildContext: buildContext, evaluate: evaluate, run: run,
    validate: validate, diff: diff, label: label, ttmSignal: ttmSignal, positionWarnings: positionWarnings, clone: clone,
    rpIndex: rpIndex, rpSupport: rpSupport, RP_TYPES: RP_TYPES
  };
});
