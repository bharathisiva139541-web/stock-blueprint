/* The TradingView indicator with the Backtest Lab's rules filled in (owner, 11-Nov-2026: "it would be helpful if you give
   option to copy the pinescript in this page that works with respect to the current setup before running the setup. i
   will copy the pinescript and will paste it in the trading view pinescript").
   The script itself = tradingview/StockBlueprint_CHoCH_FVG.pine (copied to web/data/pine-template.js by `npm run pine`);
   build(params) writes the form's rules into its inputs' default values (the same names as the Lab's params - see
   tradingview/pine_model.py, checked against the laptop's runs) and puts the rules in plain words at the top. Settings the
   script cannot draw are listed by notes(params) (and in the script's header). Works in the browser (SB.pine) and node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(null);
  else (root.SB = root.SB || /** @type {any} */ ({})).pine = factory(root);
})(/** @type {any} */ (typeof self !== 'undefined' ? self : this), function (root) {
  'use strict';

  var ZONE_WHEN = { both: 'In the CHoCH move or after it', leg: 'Only in the CHoCH move', after: 'Only after the CHoCH candle' };
  var PART = { mid: 'Middle', top: 'Top', bottom: 'Bottom' };
  var STOP = { zone: 'Under the zone bottom', spring: 'Under the touch candle\'s low', lower: 'Under whichever is lower', pct: '% under the entry',
    final: 'Under the CHoCH\'s final low' };
  var EMA = { 0: 'Off', 10: '10 EMA', 21: '21 EMA', 50: '50 EMA', 1: 'Any of 10 / 21 / 50' };
  var TARGET = { R: 'R multiple', swing: 'The last swing high', mh: 'The move high (HH)', pct: '% above the entry' };
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var TF = { D: 'Daily (1D)', W: 'Weekly (1W)', '4H': '4 hour (240)' };
  var SHAPE_BASE = { upWickMax: 100, loWickMin: 0, closeMin: 0, c2BodyMin: 0, c2Color: 'any', c2BodyMax: 30, undercutMin: 0.1, undercutMax: 0,
    undAtr: 0, closeAbove: 0, recover: false, c1BodyMin: 0.5, c1LoWickMax: 100, c1Atr: 0, lowestN: 0, fallN: 0 };

  function num(v, d) { var x = Number(v); return isFinite(x) ? x : d; }
  function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }
  /** A Pine float literal (always with a point: an int literal would not match a float input's options). */
  function fl(v) { var s = String(Math.round(num(v, 0) * 1e6) / 1e6); return /[.e]/.test(s) ? s : s + '.0'; }
  function str(v) { return '"' + String(v).replace(/["\\\n\r]/g, ' ') + '"'; }
  function stamp(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    return m ? 'timestamp("' + m[3] + ' ' + MON[Number(m[2]) - 1] + ' ' + m[1] + ' 00:00 +0530")' : null;
  }

  /** Sets the default value (first argument) of `name = input.xxx(...)`. */
  function setInput(src, name, lit) {
    var re = new RegExp('^(' + name + ' = input\\.\\w+\\()("[^"]*"|timestamp\\("[^"]*"\\)|[^,]+)(,)', 'm');
    if (!re.test(src)) throw new Error('the script has no input ' + name);
    return src.replace(re, function (_, a, __, c) { return a + lit + c; });
  }

  var BOS_KIND = { both: 'Every BOS', first: 'Only the 1st BOS after a CHoCH', trend: 'Only BOS of a running up-trend' };

  /** The Lab's form (or a run's params) -> the Pine inputs (name -> literal). */
  function inputs(p) {
    var disc = clamp(num(p.discount, 0), 0, 1);
    var out = {
      structOnly: String(p.structure === 'only'),
      // BOS + FVG (owner, 13-Nov-2026): the same rules on a BOS move
      setupMode: str(p.setup === 'bos' ? 'BOS + FVG' : 'CHoCH + FVG'),
      bosKind: str(BOS_KIND[p.bosKind] || BOS_KIND.both),
      upN: String(clamp(Math.round(num(p.upN, 1)), 1, 8)),
      pivN: String(clamp(Math.round(num(p.pivotN, 5)), 2, 20)),
      downN: String(clamp(Math.round(num(p.downN, 3)), 1, 8)),
      zoneWhen: str(ZONE_WHEN[p.zoneWhen] || ZONE_WHEN.both),
      chochAge: String(Math.max(0, Math.round(num(p.chochAge, 0)))),
      fibLvl: fl(disc),
      discPart: str(PART[p.discPart] || PART.mid),
      firstPull: String(p.firstPull !== false),
      belowChoch: String(!!p.belowChoch),
      entryMode: str(p.entry === 'zone' ? 'Order at the zone top' : 'Touch candle\'s close'),
      stopMode: str(STOP[p.stop] || STOP.zone),
      stopBuf: fl(Math.max(0, num(p.stopBuf, 0.5))),
      stopPct: fl(clamp(num(p.stopPct, 5), 0.1, 50)),
      // the ATR stop: whichever is lower (owner, 13-Nov-2026)
      stopAtr: fl(clamp(num(p.stopAtr, 0), 0, 10)),
      maxRisk: fl(Math.max(0, num(p.maxRisk, 15))),
      minPrice: fl(Math.max(0, num(p.minPrice, 0))),
      targetMode: str(TARGET[p.targetMode] || TARGET.R),
      targetR: fl(Math.max(0.25, num(p.targetR, 2))),
      targetPct: fl(clamp(num(p.targetPct, 20), 1, 1000)),
      swingMinR: fl(Math.max(0, num(p.swingMinR, 1))),
      useDates: String(!!(stamp(p.from) || stamp(p.to))),
      minTurn: fl(Math.max(0, num(p.minTurnover, 0))),
      emaSup: str(EMA[num(p.emaSupport, 0)] || EMA[0]),
      emaTouch: fl(Math.max(0, num(p.emaTouch, 1))),
      ab10: String(!!p.above10), ab21: String(!!p.above21), ab50: String(!!p.above50), emaStack: String(!!p.emaStack),
      gapEntry: String(p.gapEntry !== false),
      // of two discount zones in the CHoCH move: the 2nd traded, the 1st only watched (owner, 12-Nov-2026)
      zonePick: str(p.zonePick === 'every' ? 'Trade every zone' : 'Trade the 2nd (the 1st only watched)'),
      // a zone touched before the CHoCH counts again after it (owner, 13-Nov-2026)
      touchAgain: String(p.touchAgain !== false),
      // how swings and the CHoCH are found (owner, 12-Nov-2026: the structure options drawn too)
      swMode: str(p.swingMode === 'zigzag' ? 'ZigZag (ATR)' : 'Candles each side'),
      zzAtr: fl(clamp(num(p.zzAtr, 2), 0.5, 10)),
      swAtr: fl(clamp(num(p.swingAtr, 0), 0, 5)),
      chMode: str(p.chochMode === 'protected' ? 'The protected high' : 'The last swing high'),
      eqAtr: fl(clamp(num(p.eqAtr, 0), 0, 2))
    };
    if (stamp(p.from)) out.fromDate = stamp(p.from);
    if (stamp(p.to)) out.toDate = stamp(p.to);
    return out;
  }

  /** What the script cannot draw for these rules (shown on the page and put in the script's header). */
  function notes(p) {
    var n = [];
    n.push('Open the ' + (TF[p.tf] || TF.D) + ' chart on TradingView (the Lab ran on that timeframe).');
    if (p.setup === 'both') n.push('The script draws one setup at a time - CHoCH + FVG here; to see the BOS + FVG trades of this run, set Setup to "BOS + FVG" in its settings (gear icon).');
    if (p.group && p.group !== 'touch') {
      n.push('The script draws BUY on the first touch of a zone ("First touch of a zone"); your Pattern is a different one - Spring candles show as small "S" marks, FVG First Touch / Confirmed are not drawn.');
    }
    if (p.entry === 'next_open') n.push('Buy "at the next candle\'s open" is drawn at the touch candle\'s close.');
    if (p.mktIndex && (num(p.mktAbove, 0) || p.mktStack)) n.push('The market condition (' + String(p.mktIndex).replace(/_/g, ' ') + ') is not drawn - check the index chart yourself.');
    if (Object.keys(SHAPE_BASE).some(function (k) { return p[k] !== undefined && String(p[k]) !== String(SHAPE_BASE[k]); })) {
      n.push('The Spring shape rules (step 3) are not drawn - they apply to Spring signals.');
    }
    if (num(p.maxTouch, 0)) n.push('"Zone touched at most" is not needed - every BUY is a first touch.');
    // the filters of 12-Nov-2026 (the review's E6-E11; the structure options - ZigZag, stand out by x ATR, protected high,
    // equal highs / lows - are drawn: owner, 12-Nov-2026)
    var more = [];
    if (num(p.discountMax, 0)) more.push('the "zone at most" level');
    if (num(p.lagMin, 0)) more.push('the days after the CHoCH');
    if (num(p.dispAtr, 0) || num(p.dispVol, 0)) more.push('the CHoCH candle\'s body / volume');
    if (num(p.moveVol, 0)) more.push('the big-volume candles in the CHoCH move');
    if (p.sweep) more.push('the sweep of the low');
    // the owner's refinements of 12-Nov-2026 the script does not draw (the Gap-up zone entry and the final-low stop it does)
    if (num(p.zoneMin, 0) || num(p.zoneMax, 0)) more.push('the zone size range');
    if (p.lineOk) more.push('zones short of the discount line under the CHoCH level');
    if (p.fibPat === 'big' || p.fibPat === 'all') more.push('the Spring / Harami + Inverted Hammer at the zone\'s Fib line');
    if (p.darkCloud === 'exclude' || p.darkCloud === 'only') more.push('the dark-cloud FVG rule');
    if (p.whereIn && p.whereIn !== 'any') more.push('how deep the candle went into the zone');
    if (num(p.wkAbove, 0)) more.push('the weekly trend');
    if (more.length) n.push('Not drawn (check them on the chart yourself): ' + more.join(', ') + '.');
    var exits = [];
    if (num(p.partialPct, 0) && p.after !== 'fixed') exits.push('selling ' + num(p.partialPct, 0) + '% at the target');
    if (num(p.beAt, 0)) exits.push('the stop to the entry at ' + num(p.beAt, 0) + 'R');
    if (num(p.timeN, 0)) exits.push('the time stop (' + Math.round(num(p.timeN, 0)) + ' candles)');
    if (exits.length) n.push('Exits are not drawn: ' + exits.join(', ') + ' - the Lab\'s result has them.');
    // the lower-timeframe confirmation (owner, 13-Nov-2026) - one chart cannot show two timeframes' structure
    if (p.ltf && p.ltf !== 'off') {
      n.push('The confirmation on the ' + ({ D: 'daily', '1H': '1-hour', '15m': '15-minute' }[p.ltf] || p.ltf) + ' chart is not drawn: the BUY marks are the ' +
        'touches - after one, switch TradingView to the ' + p.ltf + ' chart and look for a CHoCH with its final low in the zone (the Lab\'s charts PDF has a page for each).');
    }
    n.push('Only the entry, stop and target are drawn - the trail, the target lock, the time limit, the costs and the account are not.');
    return n;
  }

  /** The script for these rules: `src` = the template (window.SB_PINE_SRC), `plain` = the rules in words, `name` = the idea. */
  function build(p, opts) {
    opts = opts || {};
    var src = opts.src || (root && root.SB_PINE_SRC);
    if (!src) throw new Error('the TradingView script is not loaded');
    var ins = inputs(p || {});
    Object.keys(ins).forEach(function (k) { src = setInput(src, k, ins[k]); });
    // a discount level that is not in the input's list is added to it (Pine refuses a default that is not an option)
    src = src.replace(/^(fibLvl = input\.float\(([^,]+), [^\n]*?options=\[)([^\]]*)(\])/m, function (all, a, def, list, b) {
      var vals = list.split(',').map(function (x) { return Number(x); });
      if (vals.indexOf(Number(def)) >= 0) return all;
      vals.push(Number(def));
      vals.sort(function (x, y) { return x - y; });
      return a + vals.map(fl).join(', ') + b;
    });
    var head = ['// ------------------------------------------------------------------ your Backtest Lab rules',
      '// ' + clean(opts.name || 'My idea') + (opts.when ? ' - copied ' + clean(opts.when) : '')];
    wrap(clean(opts.plain || ''), 110).forEach(function (l) { head.push('// ' + l); });
    notes(p || {}).forEach(function (t) { wrap(clean(t), 106).forEach(function (l, i) { head.push('// ' + (i ? '  ' : '* ') + l); }); });
    var lines = src.split('\n');
    return [lines[0]].concat(head, lines.slice(1)).join('\n');
  }
  function clean(s) { return String(s).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  function wrap(s, w) {
    if (!s) return [];
    var out = [], line = '';
    s.split(' ').forEach(function (word) {
      if (line && (line + ' ' + word).length > w) { out.push(line); line = word; } else line = line ? line + ' ' + word : word;
    });
    if (line) out.push(line);
    return out;
  }

  return { build: build, inputs: inputs, notes: notes, setInput: setInput };
});
