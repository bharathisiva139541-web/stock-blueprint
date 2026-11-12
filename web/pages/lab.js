/* Backtest Lab (#lab, #lab/<run id>) - owner, 09-Nov-2026: "we have data to backtest. Now I need a platform to backtest
   with my customized idea. You have backtested with stop loss placed below the low. Actually I place stoploss slightly
   below the FVG area ... if I take a trade I have minimum 2R. If stoploss hit means the trade is loss. If the trade hits
   2R, I don't close the trade, I try to catch the maximum move within weeks. So days, stoploss, risk, returns all should
   be customizable ... make a separate page for backtest"; choices: this page (website / app), the owner's laptop
   computes (the 20 years of Kite candles stay there); default after 2R: the stop to the entry, then a trail under the
   lowest low of the last 2 candles.
   Owner only: the My Watchlists PIN (SB.wlSync.owner -> api/watchlists op 'lab' -> Code2.gs ab_labFromSite_ -> the
   laptop's backtest_lab.py). The rules are kept on this device (localStorage sb:lab:form, presets sb:lab:presets). */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, esc = ui.esc, F = ui.F, $ = ui.$, isNum = ui.isNum;

  var DEF = {
    name: 'My FVG+Spring idea', tf: 'D', group: 'fvg', from: '', to: '', minPrice: 0, minTurnover: 0, maxTouch: 0,
    entry: 'close', stop: 'zone', stopBuf: 0.5, stopPct: 5, maxRisk: 15,
    targetR: 2, after: 'trail', breakeven: true, trail: 'lows', trailN: 2, trailPct: 8, emaN: 20, maxDays: 60, cost: 0.2,
    capital: 1000000, riskPct: 1, maxPosPct: 25, maxOpen: 10, compound: false,
    // EMA confluence (owner, 09-Nov-2026: "I don't enter the trade blindly ... if price is taking support at 10 EMA, I believe
    // the stock will go upward") - all off by default
    emaSupport: 0, emaTouch: 1, above10: false, above21: false, above50: false, emaStack: false,
    // market condition (owner, 09-Nov-2026: "yes ... why only Nifty50, you can add other indices also") - off by default
    mktIndex: '', mktAbove: 0, mktStack: false,
    // hard Spring rules (owner, 10-Nov-2026: "in our spring, sometimes c2 looks like a doji ... make hard rules for spring ...
    // upperwick of c2 should be very negligible or no upperwick ... give more options to define spring") - the pattern's own
    // values = no extra rule; these only make the Spring stricter (c1 = the red candle, c2 = the Spring candle)
    upWickMax: 100, loWickMin: 0, closeMin: 0, c2BodyMin: 0, c2Color: 'any', c2BodyMax: 30,
    undercutMin: 0.1, undercutMax: 0, undAtr: 0, closeAbove: 0, recover: false,
    c1BodyMin: 0.5, c1LoWickMax: 100, c1Atr: 0, lowestN: 0, fallN: 0, fallPct: 10,
    // market structure (owner, 10-Nov-2026: CHoCH after a downtrend, the FVG of that move, the first pullback into it;
    // answers: 5 candles a swing, 3 lower highs / lows, the CHoCH candle closes above, zone in the move or after it, below
    // the CHoCH level + first pullback, target R multiple or the last swing high) - off by default
    structure: 'off', pivotN: 5, downN: 3, zoneWhen: 'both', belowChoch: true, firstPull: true, chochAge: 0,
    targetMode: 'R', swingMinR: 1,
    // the discount zone (owner, 11-Nov-2026, SUPREMEIND: "we always try to enter with low risk, i.e. the zone in discount
    // area. it is ok even the zone have some area slightly above the Choch"): the zone's middle under the Fib line of the
    // move (final low -> its high) - off by default
    discount: 0, discPart: 'mid',
    // development / test split (owner, 12-Nov-2026, after a ChatGPT review of his run: "yes do it") - off by default
    testFrom: '',
    // the rest of the review's experiments (owner, 12-Nov-2026: "Finish all the remaining updates") - all off by default (= the
    // frozen baseline): the structure engine (E2 / E3 / E5), more filters (E6-E11), the ATR / swing-low trails (E15 / E16),
    // a validation part + the "steady over time?" blocks
    swingMode: 'fractal', zzAtr: 2, swingAtr: 0, chochMode: 'last', eqAtr: 0, sweep: false,
    discountMax: 0, lagMin: 0, dispAtr: 0, dispVol: 0, whereIn: 'any', wkAbove: 0, atrK: 3, valFrom: '', rollYears: 3
  };
  // ready setups for the "Start here" cards (owner, 12-Nov-2026: "make bactest lab more user-friendly not to be complex")
  var QUICK = [
    { id: 'smc', name: 'My CHoCH + FVG setup', why: 'After lower highs and lower lows a candle closes above the last lower high (CHoCH); the first time price comes back to a zone in the discount half of that move = buy at the zone top, stop under the zone.' },
    { id: 'fvg', name: 'FVG + Spring', why: 'A Spring candle on a 3-candle FVG zone (anywhere on it or under its bottom); buy at the Spring candle\'s close, stop under the zone.',
      set: { group: 'fvg', structure: 'off', entry: 'close', stop: 'zone', discount: 0 } },
    { id: 'gap', name: 'Gap-up FVG + Spring', why: 'The same on a Gap-up zone (a gap between two candles); buy at the Spring candle\'s close, stop under the zone.',
      set: { group: 'gap', structure: 'off', entry: 'close', stop: 'zone', discount: 0 } }
  ];
  // the folded "More rules" sections: the keys each one holds (its header counts the ones you changed)
  var SECTIONS = [
    ['structure', 'Market structure - CHoCH / BOS', ['structure', 'pivotN', 'downN', 'zoneWhen', 'chochAge', 'discount', 'discPart', 'belowChoch', 'firstPull',
      'swingMode', 'zzAtr', 'swingAtr', 'chochMode', 'eqAtr', 'discountMax', 'lagMin', 'dispAtr', 'dispVol', 'sweep']],
    ['shape', 'Spring candle shape', null],
    ['trend', 'Trend filters - EMA, weekly trend, market', ['emaSupport', 'emaTouch', 'above10', 'above21', 'above50', 'emaStack', 'wkAbove', 'mktIndex', 'mktAbove', 'mktStack']],
    ['entry', 'Entry details', ['entry', 'maxRisk', 'whereIn', 'from', 'to', 'minPrice', 'minTurnover', 'maxTouch']],
    ['exit', 'Exit details', ['targetMode', 'swingMinR', 'breakeven', 'maxDays', 'cost']],
    ['money', 'Money details', ['maxPosPct', 'maxOpen', 'compound']],
    ['check', 'Checking the result - validation part, steady over time', ['valFrom', 'rollYears']]
  ];
  // the owner's CHoCH + FVG setup in one click (his answers of 10-Nov-2026, and 11-Nov-2026: the discount half of the move
  // instead of "below the CHoCH level", the first return to that zone = the signal, a buy order at the zone top)
  var SMC = { group: 'touch', structure: 'only', pivotN: 5, downN: 3, zoneWhen: 'both', belowChoch: false, discount: 0.5, discPart: 'mid',
    firstPull: true, chochAge: 0, stop: 'zone', entry: 'zone' };
  var SHAPE_KEYS = ['upWickMax', 'loWickMin', 'closeMin', 'c2BodyMin', 'c2Color', 'c2BodyMax', 'undercutMin', 'undercutMax', 'undAtr',
    'closeAbove', 'recover', 'c1BodyMin', 'c1LoWickMax', 'c1Atr', 'lowestN', 'fallN', 'fallPct'];
  // My recommendations (10-Nov-2026): starting points to TEST - each one is a reasoned idea, not a proven edge
  var RECS = [
    { id: 'hammer', name: 'Clean hammer', set: { upWickMax: 5, loWickMin: 60 },
      why: 'Spring candle with a long lower wick (60%+) and almost no upper wick: sellers pushed it down, buyers took it all the way back to the high. Leaves out the doji-like ones.' },
    { id: 'hunt', name: 'Real stop-hunt', set: { undAtr: 0.25, closeAbove: 0.3, recover: true, upWickMax: 15 },
      why: 'The dip must be a real one (a quarter of the stock\'s usual daily range, not 1-2 ticks), the close clearly back above the red candle\'s low and above its close.' },
    { id: 'swing', name: 'Swing-low Spring', set: { lowestN: 20, upWickMax: 10, loWickMin: 50 },
      why: 'The Spring candle\'s low takes out the lowest low of the last 20 candles - the stops of a whole base, not just yesterday\'s low - and it is a hammer.' },
    { id: 'fall', name: 'Washout after a fall', set: { fallN: 10, fallPct: 8, c1BodyMin: 1.5, lowestN: 10, upWickMax: 10 },
      why: 'Price had fallen 8%+ over 10 candles, a big red candle (1.5%+), then the Spring candle takes out the 10-candle low and rejects it with a small upper wick.' },
    { id: 'strict', name: 'All of them (very strict)', set: { upWickMax: 5, loWickMin: 60, undAtr: 0.25, closeAbove: 0.3, recover: true, lowestN: 20, c2Color: 'green' },
      why: 'Hammer + real stop-hunt + swing low + green close. Very few trades - check the count (300+ before you trust the average).' }
  ];
  // the indices the laptop keeps (= kite_intraday.py LAB_INDICES; a finished run's indexNames replaces this list)
  var DEFAULT_INDICES = ['NIFTY_50', 'NIFTY_NEXT_50', 'NIFTY_100', 'NIFTY_200', 'NIFTY_500', 'NIFTY_BANK', 'NIFTY_MIDCAP_100',
    'NIFTY_MIDCAP_150', 'NIFTY_SMLCAP_100', 'NIFTY_SMLCAP_250', 'NIFTY_MIDSML_400', 'NIFTY_MICROCAP250'];
  var CHOICES = {
    tf: [['D', 'Daily'], ['W', 'Weekly'], ['4H', '4 hour (13:15 candle)']],
    group: [['fvg', 'FVG+Spring'], ['fvg_top', 'FVG+Spring - Spring at the zone top'], ['fvg_middle', 'FVG+Spring - in the middle'],
      ['fvg_bottom', 'FVG+Spring - at / under the bottom'], ['gap', 'Gap-up FVG + Spring'], ['gapin', 'Gap-up FVG + Spring - inside FVG only'],
      ['zone', 'FVG+Spring or Gap-up FVG + Spring'], ['ft', 'FVG First Touch'], ['conf', 'FVG First Touch Confirmed'],
      ['entry', 'Spring on an FVG / Gap-up zone, or FVG First Touch / Confirmed'],
      ['touch', 'First touch of a zone - every FVG / Gap-up zone (your SMC entry)'], ['spring', 'Every Spring (no zone - to compare)']],
    structure: [['off', 'Off - do not look at it'], ['show', 'Show it on every trade (nothing left out) - to compare'], ['only', 'Only my setup (the rules below)']],
    pivotN: [[2, '2 candles each side'], [3, '3 candles each side'], [5, '5 candles each side'], [8, '8 candles each side'], [10, '10 candles each side']],
    downN: [[1, 'At least 1'], [2, 'At least 2'], [3, 'At least 3'], [4, 'At least 4'], [5, 'At least 5']],
    zoneWhen: [['both', 'In the CHoCH move or after it'], ['leg', 'Only in the CHoCH move'], ['after', 'Only after the CHoCH candle']],
    chochAge: [[0, 'Any time after it'], [10, 'Within 10 candles'], [20, 'Within 20 candles'], [40, 'Within 40 candles'], [60, 'Within 60 candles'], [120, 'Within 120 candles']],
    targetMode: [['R', 'R multiple (times the risk)'], ['swing', 'The last swing high']],
    discount: [[0, 'Off - not checked'], [0.382, '38.2% down the move'], [0.5, 'Half way down - the 50% line (discount)'], [0.618, '61.8% down the move'],
      [0.65, '65% down the move'], [0.7, '70% down the move'], [0.705, '70.5% down the move'], [0.75, '75% down the move'], [0.786, '78.6% down the move']],
    discountMax: [[0, 'No limit'], [0.786, '78.6% down'], [0.9, '90% down'], [1, '100% - down to the final low']],
    swingMode: [['fractal', 'Candles on each side (the usual)'], ['zigzag', 'ZigZag - price turned by x ATR']],
    zzAtr: [[1, '1 x ATR'], [1.5, '1.5 x ATR'], [2, '2 x ATR'], [3, '3 x ATR'], [4, '4 x ATR']],
    swingAtr: [[0, 'Not checked'], [0.5, 'At least 0.5 x ATR'], [1, 'At least 1 x ATR'], [1.5, 'At least 1.5 x ATR'], [2, 'At least 2 x ATR'], [3, 'At least 3 x ATR']],
    chochMode: [['last', 'Above the last swing high (the usual)'], ['protected', 'Above the protected high (the one before the lowest low)']],
    eqAtr: [[0, 'Exact (the usual)'], [0.1, 'Within 0.1 x ATR = equal'], [0.25, 'Within 0.25 x ATR = equal'], [0.5, 'Within 0.5 x ATR = equal']],
    lagMin: [[0, 'Any time'], [5, 'At least 5 days after it'], [10, 'At least 10 days after it'], [20, 'At least 20 days after it'], [40, 'At least 40 days after it']],
    dispAtr: [[0, 'Not checked'], [0.5, 'Body at least 0.5 x ATR'], [1, 'Body at least 1 x ATR'], [1.5, 'Body at least 1.5 x ATR'], [2, 'Body at least 2 x ATR']],
    dispVol: [[0, 'Not checked'], [1.5, 'Volume at least 1.5 x average'], [2, 'Volume at least 2 x average'], [3, 'Volume at least 3 x average']],
    whereIn: [['any', 'Anywhere in the zone (or under it)'], ['tm', 'Only the top or middle of the zone'], ['t', 'Only the top half of the zone']],
    wkAbove: [[0, 'Off'], [10, 'Above its 10-week EMA'], [21, 'Above its 21-week EMA'], [50, 'Above its 50-week EMA']],
    rollYears: [[0, 'Off'], [1, 'Every year'], [2, 'Every 2 years'], [3, 'Every 3 years'], [5, 'Every 5 years']],
    discPart: [['mid', 'Its middle (part of it may be above the line)'], ['top', 'All of it (its top)'], ['bottom', 'Any part of it (its bottom)']],
    entry: [['close', 'At the signal candle\'s close'], ['next_open', 'At the next candle\'s open'],
      ['zone', 'An order waiting at the zone top (first-touch signals)']],
    stop: [['zone', 'A little below the FVG / Gap-up zone bottom'], ['spring', 'A little below the Spring candle\'s low'],
      ['lower', 'A little below whichever is lower'], ['pct', 'A fixed % below the entry']],
    after: [['trail', 'Keep the trade and trail the stop'], ['fixed', 'Sell at the target']],
    trail: [['lows', 'Under the lowest low of the last N candles'], ['pct', 'X % under the highest price since entry'],
      ['ema', 'Sell when a candle closes under the N EMA'], ['atr', 'x ATR under the highest price since entry'],
      ['swing', 'Under the newest swing low since the entry'], ['none', 'No trail (the stop stays)']],
    emaSupport: [[0, 'Off - do not look at it'], [10, 'the 10 EMA'], [21, 'the 21 EMA'], [50, 'the 50 EMA'], [1, 'any of the 10 / 21 / 50 EMA']],
    mktAbove: [[0, 'Off'], [10, 'its 10 EMA'], [21, 'its 21 EMA'], [50, 'its 50 EMA'], [100, 'its 100 EMA'], [200, 'its 200 EMA']],
    // hard Spring rules - the first option of each is "not checked" / the pattern's own value
    upWickMax: [[100, 'Any - not checked'], [0, 'None at all (0%)'], [2, 'Negligible - at most 2%'], [5, 'Very small - at most 5%'],
      [10, 'Small - at most 10%'], [20, 'At most 20%'], [33, 'At most a third']],
    loWickMin: [[0, 'Any - not checked'], [40, 'At least 40%'], [50, 'At least half (50%)'], [60, 'At least 60%'], [70, 'At least 70%'], [80, 'At least 80%']],
    closeMin: [[0, 'Any - not checked'], [50, 'Upper half of its range'], [67, 'Top third'], [80, 'Top 20%'], [90, 'Top 10%'], [100, 'Exactly at its high']],
    c2BodyMin: [[0, 'Any - a doji is fine'], [5, 'At least 5%'], [10, 'At least 10% (not a doji)'], [20, 'At least 20%'], [33, 'At least a third']],
    c2Color: [['any', 'Any colour'], ['green', 'Green (closed above its open)'], ['red', 'Red (closed below its open)']],
    c2BodyMax: [[30, 'Up to 30% - the pattern\'s own limit'], [20, 'At most 20%'], [15, 'At most 15%'], [10, 'At most 10%'], [5, 'At most 5%']],
    undercutMin: [[0.1, 'At least 0.1% - the pattern\'s own'], [0.25, 'At least 0.25%'], [0.5, 'At least 0.5%'], [1, 'At least 1%'], [2, 'At least 2%'], [3, 'At least 3%']],
    undercutMax: [[0, 'No limit'], [2, 'At most 2%'], [3, 'At most 3%'], [5, 'At most 5%'], [8, 'At most 8%'], [12, 'At most 12%']],
    undAtr: [[0, 'Not checked'], [0.1, 'At least 0.1 x ATR'], [0.25, 'At least 0.25 x ATR'], [0.5, 'At least 0.5 x ATR'], [1, 'At least 1 x ATR']],
    closeAbove: [[0, 'Any - just above is enough'], [0.25, 'At least 0.25% above'], [0.5, 'At least 0.5% above'], [1, 'At least 1% above'], [2, 'At least 2% above']],
    c1BodyMin: [[0.5, 'At least 0.5% - the pattern\'s own'], [1, 'At least 1%'], [1.5, 'At least 1.5%'], [2, 'At least 2%'], [3, 'At least 3%'], [5, 'At least 5%']],
    c1LoWickMax: [[100, 'Any - not checked'], [50, 'At most half'], [25, 'At most 25%'], [15, 'At most 15%'], [5, 'At most 5%']],
    c1Atr: [[0, 'Not checked'], [0.5, 'At least 0.5 x ATR'], [1, 'At least 1 x ATR'], [1.5, 'At least 1.5 x ATR'], [2, 'At least 2 x ATR']],
    lowestN: [[0, 'Not checked'], [5, 'Last 5 candles'], [10, 'Last 10 candles'], [20, 'Last 20 candles'], [50, 'Last 50 candles'], [100, 'Last 100 candles']],
    fallN: [[0, 'Not checked'], [5, 'Within the last 5 candles'], [10, 'Within the last 10 candles'], [20, 'Within the last 20 candles'], [50, 'Within the last 50 candles']],
    fallPct: [[3, 'at least 3%'], [5, 'at least 5%'], [8, 'at least 8%'], [10, 'at least 10%'], [15, 'at least 15%'], [20, 'at least 20%'], [30, 'at least 30%']]
  };
  var NUMS = ['minPrice', 'minTurnover', 'maxTouch', 'stopBuf', 'stopPct', 'maxRisk', 'targetR', 'trailN', 'trailPct', 'emaN', 'maxDays',
    'cost', 'capital', 'riskPct', 'maxPosPct', 'maxOpen', 'emaSupport', 'emaTouch', 'mktAbove',
    'upWickMax', 'loWickMin', 'closeMin', 'c2BodyMin', 'c2BodyMax', 'undercutMin', 'undercutMax', 'undAtr', 'closeAbove',
    'c1BodyMin', 'c1LoWickMax', 'c1Atr', 'lowestN', 'fallN', 'fallPct', 'pivotN', 'downN', 'chochAge', 'swingMinR', 'discount',
    'zzAtr', 'swingAtr', 'eqAtr', 'discountMax', 'lagMin', 'dispAtr', 'dispVol', 'wkAbove', 'atrK', 'rollYears'];
  // the first market-structure rule a signal failed (= backtest_lab.py STRUCT_WHY) and the stages (structure.py)
  var STRUCT_WHY = { nochoch: 'no live CHoCH before it', zone: 'its zone did not form in the CHoCH move / after it',
    bos: 'a BOS came first (not the first pullback)', above: 'its zone is not below the CHoCH level',
    premium: 'its zone was not in the discount part of the move (above your Fib line)',
    deep: 'its zone was deeper in the move than your "at most" level', early: 'it came sooner after the CHoCH than your minimum days',
    disp: 'the CHoCH candle\'s body was smaller than your ATR rule', vol: 'the CHoCH candle\'s volume was under your rule',
    sweep: 'the final low did not sweep the low before it' };
  var STAGE = { disc: ['Discount, 1st pullback', 's-good'], below: ['Below CHoCH, 1st pullback', 's-good'], prem: ['Premium (above the Fib line)', 's-warn'],
    above: ['At / above CHoCH level', 's-warn'], bos: ['After a BOS', 's-bad'], old: ['Zone older than the CHoCH low', 's-info'], none: ['No CHoCH', ''] };
  var ITD_TV = { D: 'D', W: 'W', '4H': '240' };
  function tvUrl(sym, tf) { return 'https://www.tradingview.com/chart/?symbol=' + encodeURIComponent('NSE:' + sym) + '&interval=' + (ITD_TV[tf] || 'D'); }
  // the first failed rule -> words (= backtest_lab.py SHAPE_WHY)
  var SHAPE_WHY = {
    data: 'no candle before it', history: 'too few candles before it for an ATR / swing-low / fall rule',
    c1body: 'the red candle was too small', c1wick: 'the red candle had a long lower wick', c1atr: 'the red candle was small for that stock (ATR)',
    dipmin: 'the dip under the red candle\'s low was too shallow', dipmax: 'the dip was too deep', dipatr: 'the dip was small for that stock (ATR)',
    closeabove: 'it closed too close to the red candle\'s low', recover: 'it did not close above the red candle\'s close',
    upwick: 'the upper wick was too long', lowick: 'the lower wick was too short', close: 'it did not close high enough in its range',
    doji: 'it was a doji (body too small)', color: 'wrong colour', c2body: 'its body was too big for the red candle',
    lowest: 'its low did not take out the lowest low of the last candles', fall: 'no fall before the red candle'
  };
  var REASON = { stop: ['Stop loss', 's-bad'], target: ['Target', 's-good'], be: ['Breakeven (stop at entry)', ''], trail: ['Trailing stop', 's-good'],
    ema: ['Close under EMA', 's-good'], time: ['Time limit', 's-info'], open: ['Still running', 's-warn'] };
  var POLL_MS = 4000;
  var ST = { status: null, item: null, itemId: null, timer: 0, busy: false, err: '', host: null, gen: 0, bd: '' };

  function form() {
    var f = ui.store.get('lab:form', null);
    var out = {};
    Object.keys(DEF).forEach(function (k) { out[k] = f && f[k] !== undefined && typeof f[k] === typeof DEF[k] ? f[k] : DEF[k]; });
    return out;
  }
  function saveForm(f) { ui.store.set('lab:form', f); }
  function presets() { var p = ui.store.get('lab:presets', []); return Array.isArray(p) ? p : []; }
  function choiceLabel(k, v) { var c = (CHOICES[k] || []).filter(function (x) { return String(x[0]) === String(v); })[0]; return c ? c[1] : v; }

  /** The EMA confluence rules in words ('' when none is on). */
  function emaWords(p) {
    var w = [];
    if (Number(p.emaSupport)) {
      w.push('the Spring candle took support at ' + (Number(p.emaSupport) === 1 ? 'the 10, 21 or 50 EMA' : 'the ' + p.emaSupport + ' EMA') +
        ' (its low came down to it - or within ' + F.num(p.emaTouch, 2) + '% above it - and it closed at or above it)');
    }
    var above = [10, 21, 50].filter(function (n) { return p['above' + n]; });
    if (above.length) w.push('it closed above the ' + above.join(', ') + ' EMA');
    if (p.emaStack) w.push('the EMAs were in order 10 > 21 > 50 (an uptrend)');
    return w.length ? 'Only when ' + w.join('; ') + '.' : '';
  }

  function pc(v) { return F.num(v, Number(v) % 1 ? 2 : 0).replace(/(\.\d)0$/, '$1'); }
  /** The hard Spring rules in words ('' when none is set). */
  function shapeWords(p) {
    var w = [], c1 = [], dip = [], close = [], c2 = [];
    if (Number(p.c1BodyMin) > 0.5) c1.push('a body of at least ' + pc(p.c1BodyMin) + '% of its open');
    if (Number(p.c1Atr)) c1.push('a body of at least ' + pc(p.c1Atr) + ' x the stock\'s usual candle (ATR)');
    if (Number(p.c1LoWickMax) < 100) c1.push('a lower wick of at most ' + pc(p.c1LoWickMax) + '% of its range');
    if (c1.length) w.push('the red candle has ' + c1.join(' and '));
    if (Number(p.undercutMin) > 0.1) dip.push('at least ' + pc(p.undercutMin) + '%');
    if (Number(p.undAtr)) dip.push('at least ' + pc(p.undAtr) + ' x ATR');
    if (Number(p.undercutMax)) dip.push('at most ' + pc(p.undercutMax) + '%');
    if (dip.length) w.push('the Spring candle\'s low went under the red candle\'s low by ' + dip.join(' and '));
    if (Number(p.closeAbove)) close.push('at least ' + pc(p.closeAbove) + '% above the red candle\'s low');
    if (p.recover) close.push('above the red candle\'s close');
    if (close.length) w.push('it closed ' + close.join(' and '));
    if (Number(p.upWickMax) < 100) c2.push(Number(p.upWickMax) === 0 ? 'no upper wick at all' : 'an upper wick of at most ' + pc(p.upWickMax) + '% of its range');
    if (Number(p.loWickMin)) c2.push('a lower wick of at least ' + pc(p.loWickMin) + '% of its range');
    if (Number(p.closeMin)) c2.push(Number(p.closeMin) >= 100 ? 'a close exactly at its high' : 'a close in the top ' + pc(100 - Number(p.closeMin)) + '% of its range');
    if (Number(p.c2BodyMin)) c2.push('a body of at least ' + pc(p.c2BodyMin) + '% of its range (not a doji)');
    if (Number(p.c2BodyMax) < 30) c2.push('a body of at most ' + pc(p.c2BodyMax) + '% of the red candle\'s body');
    if (p.c2Color && p.c2Color !== 'any') c2.push('a ' + p.c2Color + ' close');
    if (c2.length) w.push('the Spring candle has ' + c2.join(', '));
    if (Number(p.lowestN)) w.push('its low is lower than the lowest low of the last ' + p.lowestN + ' candles');
    if (Number(p.fallN)) w.push('price had fallen at least ' + pc(p.fallPct) + '% from the highest high of the last ' + p.fallN + ' candles to the red candle\'s close');
    return w.length ? 'Only Springs where ' + w.join('; ') + '.' : '';
  }
  function shapeOn(p) { return SHAPE_KEYS.some(function (k) { return k !== 'fallPct' && p[k] !== DEF[k]; }); }

  /** The structure engine away from the usual (structure.py options; '' = the frozen baseline). */
  function engineWords(p) {
    var w = [];
    if (p.swingMode === 'zigzag') w.push('swings by ZigZag (price turned by ' + pc(p.zzAtr) + ' x ATR)');
    else if (Number(p.swingAtr)) w.push('a swing must stand out by ' + pc(p.swingAtr) + ' x ATR');
    if (p.chochMode === 'protected') w.push('the CHoCH = a close above the protected high (the swing high before the lowest low)');
    if (Number(p.eqAtr)) w.push('highs / lows within ' + pc(p.eqAtr) + ' x ATR count as equal');
    return w.length ? ' (' + w.join('; ') + ')' : '';
  }

  /** The market-structure rules in words ('' when off). */
  function structWords(p) {
    if (p.structure === 'off' || !p.structure) return '';
    var head = 'Market structure (swings of ' + p.pivotN + ' candles each side): a CHoCH = a candle closing above the last swing high after at least ' +
      p.downN + ' lower highs and ' + p.downN + ' lower lows';
    if (p.structure === 'show') return head + engineWords(p) + ' - shown on every trade, nothing left out.';
    var w = ['the zone formed after the CHoCH\'s final low, ' + (p.zoneWhen === 'leg' ? 'in the move that made the CHoCH' : p.zoneWhen === 'after' ? 'after the CHoCH candle' : 'in the CHoCH move or after it')];
    if (Number(p.discount)) {
      w.push((p.discPart === 'top' ? 'all of the zone' : p.discPart === 'bottom' ? 'some of the zone' : 'the zone\'s middle') + ' (no zone: the entry) at least ' +
        pc(Number(p.discount) * 100) + '% down the move from the CHoCH\'s final low to its high before the signal - the discount' +
        (Number(p.discount) === 0.5 ? ' half' : ' part'));
    }
    if (p.belowChoch) w.push('the zone (no zone: the entry) below the CHoCH level');
    if (p.firstPull) w.push('the first pullback - no BOS (a close above the highest swing high since the CHoCH) yet');
    if (Number(p.chochAge)) w.push('at most ' + p.chochAge + ' candles after the CHoCH');
    if (Number(p.discountMax)) w.push('the zone at most ' + pc(Number(p.discountMax) * 100) + '% down the move');
    if (Number(p.lagMin)) w.push('at least ' + p.lagMin + ' days after the CHoCH candle');
    if (Number(p.dispAtr)) w.push('the CHoCH candle\'s body at least ' + pc(p.dispAtr) + ' x ATR');
    if (Number(p.dispVol)) w.push('the CHoCH candle\'s volume at least ' + pc(p.dispVol) + ' x its 20-candle average');
    if (p.sweep) w.push('the final low swept the swing low before it and closed back above it');
    w.push('the CHoCH still alive (no close under its final low)');
    return head + engineWords(p) + '. Only signals where ' + w.join('; ') + '.';
  }

  function idxName(n) { return String(n || '').replace(/_/g, ' '); }
  function indexList(cur) {
    var l = ui.store.get('lab:indices', null);
    l = Array.isArray(l) && l.length ? l.slice() : DEFAULT_INDICES.slice();
    if (cur && l.indexOf(cur) < 0) l.unshift(cur);
    return l;
  }
  /** The market rule in words ('' when off). */
  function mktWords(p) {
    if (!p.mktIndex || !(Number(p.mktAbove) || p.mktStack)) return '';
    var w = [];
    if (Number(p.mktAbove)) w.push('closed above its ' + p.mktAbove + ' EMA');
    if (p.mktStack) w.push('had its EMAs in order 10 > 21 > 50');
    return 'Only on days when ' + idxName(p.mktIndex) + ' ' + w.join(' and ') + '.';
  }

  /** The rules in plain words (shown above the Run button and with each result). */
  function plain(p) {
    var s = [];
    s.push(choiceLabel('group', p.group) + ' on the ' + choiceLabel('tf', p.tf).toLowerCase() + ' chart' +
      (p.from || p.to ? ' (' + (p.from ? 'from ' + F.date(p.from) : '') + (p.from && p.to ? ' ' : '') + (p.to ? 'to ' + F.date(p.to) : '') + ')' : '') + '.');
    if (p.testFrom) {
      s.push(p.valFrom && p.valFrom < p.testFrom ? 'Development part: the signals before ' + F.date(p.valFrom) + '; validation part: ' + F.date(p.valFrom) +
        ' to ' + F.date(p.testFrom) + '; test part: from ' + F.date(p.testFrom) + ' on.' :
        'Development part: the signals before ' + F.date(p.testFrom) + '; test part: from ' + F.date(p.testFrom) + ' on.');
    }
    var struct = structWords(p);
    if (struct) s.push(struct);
    var shape = shapeWords(p);
    if (shape) s.push(shape);
    var ema = emaWords(p);
    if (ema) s.push(ema);
    var mkt = mktWords(p);
    if (mkt) s.push(mkt);
    if (Number(p.wkAbove) && p.tf !== 'W') s.push('Only when the stock\'s last finished weekly candle closed above its ' + p.wkAbove + '-week EMA.');
    if (p.whereIn && p.whereIn !== 'any' && p.entry !== 'zone') s.push('Only when the signal candle stayed in the ' + (p.whereIn === 't' ? 'top half' : 'top or middle') + ' of its zone.');
    s.push(p.entry === 'zone' ? 'Buy with an order waiting at the zone top - filled when price first comes down to it (at the open when it opened under the top); ' +
      'only first-touch signals, the stop always under the zone.' : 'Buy ' + (p.entry === 'close' ? 'at the signal candle\'s close' : 'at the next candle\'s open') + '.');
    s.push('Stop loss ' + (p.stop === 'pct' ? F.num(p.stopPct, 2) + '% below the entry' :
      F.num(p.stopBuf, 2) + '% below ' + (p.stop === 'zone' ? 'the zone bottom' : p.stop === 'spring' ? 'the Spring candle\'s low' : 'the zone bottom or the Spring low, whichever is lower')) +
      (p.maxRisk ? ' - trades risking more than ' + F.num(p.maxRisk, 1) + '% are skipped' : '') + '.');
    var tgt = p.targetMode === 'swing' ? 'the last swing high (at least ' + F.num(p.swingMinR, 2) + 'R above the entry - none = no trade)' : F.num(p.targetR, 2) + 'R';
    if (p.after === 'fixed') s.push('Sell at ' + tgt + (p.targetMode === 'swing' ? '' : ' (' + F.num(p.targetR, 2) + ' x the risk)') + '.');
    else {
      s.push('At ' + tgt + ' ' + (p.breakeven ? 'move the stop to the entry, then ' : 'keep the stop, then ') +
        (p.trail === 'lows' ? 'trail it under the lowest low of the last ' + p.trailN + ' candle' + (p.trailN === 1 ? '' : 's') :
          p.trail === 'pct' ? 'trail it ' + F.num(p.trailPct, 1) + '% under the highest price' :
            p.trail === 'ema' ? 'sell when a candle closes under the ' + p.emaN + ' EMA' :
              p.trail === 'atr' ? 'trail it ' + F.num(p.atrK, 1) + ' x ATR under the highest price' :
                p.trail === 'swing' ? 'trail it under the newest swing low since the entry' : 'let it run with that stop') + '.');
    }
    s.push('Sold after ' + p.maxDays + ' days at the latest (that day\'s close). Costs ' + F.num(p.cost, 2) + '% a trade.');
    s.push('Account ' + F.inr(p.capital) + ', risk ' + F.num(p.riskPct, 2) + '% a trade, a position at most ' + F.num(p.maxPosPct, 0) +
      '% of it, at most ' + p.maxOpen + ' trades at once' + (p.compound ? ', profits re-invested' : '') + '.');
    return s.join(' ');
  }

  function sel(k, v) {
    var list = CHOICES[k];
    // a value from a saved run / preset that is not in the list (e.g. 7) is shown as its own option, never silently swapped
    if (!list.some(function (o) { return String(o[0]) === String(v); })) list = list.concat([[v, String(v)]]);
    return '<select class="sel" data-k="' + k + '">' + list.map(function (o) {
      return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(v) ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
    }).join('') + '</select>';
  }
  function num(k, v, label, attrs) {
    return '<label class="field"><span>' + label + '</span><input class="inp" type="number" inputmode="decimal" data-k="' + k + '" value="' +
      esc(String(v)) + '"' + (attrs || '') + '></label>';
  }
  function field(label, html, cls) { return '<label class="field' + (cls ? ' ' + cls : '') + '"><span>' + label + '</span>' + html + '</label>'; }
  function check(k, v, label) {
    return '<label class="lab-check"><input type="checkbox" data-k="' + k + '"' + (v ? ' checked' : '') + '> ' + label + '</label>';
  }

  /** A folded "More rules" section: its header says how many of its rules are away from the default (owner, 12-Nov-2026:
   *  "make bactest lab more user-friendly not to be complex" - the basics stay open, everything else is one click away). */
  function sectionOn(f, id) {
    var sec = SECTIONS.filter(function (x) { return x[0] === id; })[0];
    var keys = sec && sec[2] || SHAPE_KEYS;
    return keys.filter(function (k) { return k !== 'fallPct' && String(f[k]) !== String(DEF[k]); }).length;
  }
  function openSet() { var o = ui.store.get('lab:open', []); return Array.isArray(o) ? o : []; }
  function sec(id, title, body, f) {
    var n = sectionOn(f, id);
    return '<details class="lab-sec" data-sec="' + id + '"' + (openSet().indexOf(id) >= 0 ? ' open' : '') + '><summary><span>' + esc(title) + '</span>' +
      (n ? '<span class="badge s-info">' + n + ' changed</span>' : '<span class="sub">default</span>') + '</summary><div class="lab-sec-body">' + body + '</div></details>';
  }

  /** Market structure - CHoCH / BOS (owner, 10-Nov-2026) + the structure engine and its filters (12-Nov-2026). */
  function structHtml(f) {
    var on = f.structure !== 'off', only = f.structure === 'only';
    return '<div class="form-grid">' + field('Market structure', sel('structure', f.structure), 'wide') +
      (on ? field('A swing high / low', sel('pivotN', f.pivotN)) + field('Lower highs and lower lows before the CHoCH', sel('downN', f.downN)) +
        (only ? field('The zone formed', sel('zoneWhen', f.zoneWhen)) + field('The signal came', sel('chochAge', f.chochAge)) +
          field('Discount: the zone at least', sel('discount', f.discount), 'wide') +
          (Number(f.discount) ? field('… judged on', sel('discPart', f.discPart)) : '') +
          '<div class="field lab-checks">' + check('belowChoch', f.belowChoch, 'Zone top below the CHoCH level (strict)') + check('firstPull', f.firstPull, 'First pullback only (no BOS yet)') + '</div>' : '') : '') +
      '</div>' +
      (on ? '<div class="lab-sub">How swings and the CHoCH are found (the usual = the frozen baseline)</div><div class="form-grid">' +
        field('Swings', sel('swingMode', f.swingMode)) + (f.swingMode === 'zigzag' ? field('… a turn of', sel('zzAtr', f.zzAtr)) : field('A swing must stand out by', sel('swingAtr', f.swingAtr))) +
        field('The CHoCH closes', sel('chochMode', f.chochMode), 'wide') + field('Equal highs / lows', sel('eqAtr', f.eqAtr)) + '</div>' : '') +
      (only ? '<div class="lab-sub">More structure rules (optional)</div><div class="form-grid">' +
        field('The zone at most', sel('discountMax', f.discountMax)) + field('Days after the CHoCH', sel('lagMin', f.lagMin)) +
        field('The CHoCH candle (displacement)', sel('dispAtr', f.dispAtr)) + field('… and its volume', sel('dispVol', f.dispVol)) +
        '<div class="field lab-checks">' + check('sweep', f.sweep, 'The final low swept the low before it (wick under, closed back above)') + '</div></div>' : '') +
      '<p class="sub">A swing high = a candle whose high is above the candles on both sides (known only after those candles closed - the backtest never looks ahead). ' +
      'CHoCH = the first candle that CLOSES above the last swing high after the lower highs and lower lows; BOS = after it, the first close above the highest swing high since. ' +
      'The move = from the CHoCH\'s final low to the highest high before the signal candle (what you draw the Fibonacci on at that moment): 50% down = its middle. ' +
      '"Show it on every trade" keeps every signal and adds a table "By market structure" to the result. ' +
      'ZigZag / "stand out by" / protected high / equal highs are other ways to find the swings and the CHoCH - try one at a time against the usual. ' +
      'The daily scan\'s lists use the values set on your laptop with <b>ChochRules.bat</b>.</p>';
  }

  /** The hard Spring rules + my recommendations (owner, 10-Nov-2026). */
  function shapeHtml(f) {
    var sameSet = function (r) {
      return SHAPE_KEYS.every(function (k) { return String(r.set[k] !== undefined ? r.set[k] : DEF[k]) === String(f[k]); });
    };
    return '<p class="sub">Only for Spring patterns (FVG + Spring, Gap-up FVG + Spring, Every Spring). <b>c1</b> = the red candle, <b>c2</b> = the Spring candle that ' +
      'dips under its low. Leave a box at its first choice to not use it.</p>' +
      '<div class="lab-recs" id="lab-recs">' + RECS.map(function (r) {
        return '<div class="lab-rec' + (sameSet(r) ? ' on' : '') + '"><b>' + esc(r.name) + '</b><span>' + esc(r.why) + '</span>' +
          '<button class="btn sm" type="button" data-rec="' + r.id + '">' + (sameSet(r) ? 'In use' : 'Use this') + '</button></div>';
      }).join('') + '</div>' +
      '<p class="sub">These are <b>my starting ideas to test</b>, not proven edges. ' +
        (shapeOn(f) ? '<button class="btn sm" type="button" id="lab-shape-off">Clear all Spring rules</button>' : '') + '</p>' +
      '<div class="lab-sub">The Spring candle (c2) - its shape</div><div class="form-grid">' +
      field('Upper wick - at most', sel('upWickMax', f.upWickMax)) + field('Lower wick - at least', sel('loWickMin', f.loWickMin)) +
      field('Closed in the …', sel('closeMin', f.closeMin)) + field('Body - at least (not a doji)', sel('c2BodyMin', f.c2BodyMin)) +
      field('Colour', sel('c2Color', f.c2Color)) + field('Body - at most (of the red candle\'s body)', sel('c2BodyMax', f.c2BodyMax)) + '</div>' +
      '<div class="lab-sub">The dip and the recovery</div><div class="form-grid">' +
      field('Its low went under the red candle\'s low by', sel('undercutMin', f.undercutMin)) + field('… but not more than', sel('undercutMax', f.undercutMax)) +
      field('… or by (a stock\'s usual candle, ATR 14)', sel('undAtr', f.undAtr)) + field('It closed above the red candle\'s low by', sel('closeAbove', f.closeAbove)) +
      '<div class="field lab-checks">' + check('recover', f.recover, 'It also closed above the red candle\'s close') + '</div></div>' +
      '<div class="lab-sub">The red candle (c1)</div><div class="form-grid">' +
      field('Body - at least (of its open)', sel('c1BodyMin', f.c1BodyMin)) + field('Body - at least (stock\'s usual candle, ATR 14)', sel('c1Atr', f.c1Atr)) +
      field('Its lower wick - at most', sel('c1LoWickMax', f.c1LoWickMax)) + '</div>' +
      '<div class="lab-sub">Where it happens</div><div class="form-grid">' +
      field('c2\'s low is under the lowest low of the', sel('lowestN', f.lowestN)) +
      field('Price fell before the red candle', sel('fallN', f.fallN)) +
      (Number(f.fallN) ? field('… by', sel('fallPct', f.fallPct)) : '') + '</div>' +
      '<p class="sub">ATR 14 = the stock\'s average candle range over the 14 candles before - "0.25 x ATR" means the same on a ₹50 stock and a ₹5,000 stock.</p>';
  }

  function trendHtml(f) {
    return '<div class="lab-sub">EMA on the signal candle (its own timeframe)</div><div class="form-grid">' +
      field('The signal candle took support at', sel('emaSupport', f.emaSupport), 'wide') +
      (Number(f.emaSupport) ? num('emaTouch', f.emaTouch, 'Its low within % above the EMA', ' min="0" step="0.25"') : '') +
      '<div class="field lab-checks lab-checks-row"><span>It closed above</span>' + check('above10', f.above10, '10 EMA') +
      check('above21', f.above21, '21 EMA') + check('above50', f.above50, '50 EMA') + '</div>' +
      '<div class="field lab-checks">' + check('emaStack', f.emaStack, 'EMAs in order: 10 > 21 > 50 (uptrend)') + '</div></div>' +
      '<div class="lab-sub">The stock\'s weekly trend (daily / 4 hour runs)</div><div class="form-grid">' +
      field('Its last finished weekly close', sel('wkAbove', f.wkAbove), 'wide') + '</div>' +
      '<div class="lab-sub">The market (an index on the signal\'s day)</div><div class="form-grid">' +
      field('Index', '<select class="sel" data-k="mktIndex" id="lab-mkt-index"><option value="">Off - no market rule</option>' +
        indexList(f.mktIndex).map(function (n) {
          return '<option value="' + esc(n) + '"' + (n === f.mktIndex ? ' selected' : '') + '>' + esc(idxName(n)) + '</option>';
        }).join('') + '</select>', 'wide') +
      (f.mktIndex ? field('The index closed above', sel('mktAbove', f.mktAbove)) +
        '<div class="field lab-checks">' + check('mktStack', f.mktStack, 'Its EMAs in order: 10 > 21 > 50') + '</div>' : '') + '</div>';
  }

  function entryHtml(f) {
    return '<div class="form-grid">' + field('Buy', sel('entry', f.entry), 'wide') +
      num('maxRisk', f.maxRisk, 'Skip if the risk is more than % (0 = never)', ' min="0" step="1"') +
      (f.entry === 'zone' ? '' : field('How deep the signal candle went into the zone', sel('whereIn', f.whereIn), 'wide')) +
      field('Signals from (optional)', '<input class="inp" type="date" data-k="from" value="' + esc(f.from) + '">') +
      field('… to (optional)', '<input class="inp" type="date" data-k="to" value="' + esc(f.to) + '">') +
      num('minPrice', f.minPrice, 'Price at least ₹', ' min="0" step="1"') +
      num('minTurnover', f.minTurnover, 'Daily turnover at least ₹ lakh (20-day avg)', ' min="0" step="10"') +
      num('maxTouch', f.maxTouch, 'Zone touched at most (0 = any)', ' min="0" step="1"') + '</div>' +
      (f.entry === 'zone' ? '<p class="sub">The order at the zone top fills on a first-touch signal (Pattern "First touch of a zone" or "FVG First Touch"); ' +
        'a Spring / Confirmed candle comes after the touch, so it is skipped. The stop goes under the zone; that candle can stop the trade out at once.</p>' : '');
  }

  function exitHtml(f) {
    return '<div class="form-grid">' + field('Target', sel('targetMode', f.targetMode)) +
      (f.targetMode === 'swing' ? num('swingMinR', f.swingMinR, 'At least this many R above the entry', ' min="0" step="0.25"') : '') +
      num('maxDays', f.maxDays, 'Sell after at most (days)', ' min="1" step="1"') +
      num('cost', f.cost, 'Costs per trade, buy + sell (%)', ' min="0" step="0.05"') +
      (f.after === 'trail' ? '<div class="field lab-checks">' + check('breakeven', f.breakeven, 'At the target, move the stop to the entry') + '</div>' : '') + '</div>';
  }

  function moneyHtml(f) {
    return '<div class="form-grid">' + num('maxPosPct', f.maxPosPct, 'One position at most (% of the account)', ' min="1" step="5"') +
      num('maxOpen', f.maxOpen, 'Trades open at once, at most', ' min="1" step="1"') +
      '<div class="field lab-checks">' + check('compound', f.compound, 'Re-invest the profits (risk % of the account as it grows)') + '</div></div>';
  }

  function checkHtml(f) {
    return '<div class="form-grid">' +
      field('Validation part from (optional)', '<input class="inp" type="date" data-k="valFrom" value="' + esc(f.valFrom) + '">') +
      field('Steady over time? - figures', sel('rollYears', f.rollYears)) + '</div>' +
      '<p class="sub">With a test period (the basics) and a validation date before it, the result is split in three: <b>development</b> (choose your rules there), ' +
      '<b>validation</b> (check the rules you chose), <b>test</b> (look only at the very end). E.g. development to 2017, validation 2018 - 2021, test from 2022.</p>';
  }

  function quickHtml(f) {
    var isOn = function (q) {
      var set = q.id === 'smc' ? SMC : q.set;
      return Object.keys(set).every(function (k) { return String(f[k]) === String(set[k]); });
    };
    return '<div class="lab-recs lab-quick">' + QUICK.map(function (q) {
      var on = isOn(q);
      return '<div class="lab-rec' + (on ? ' on' : '') + '"><b>' + esc(q.name) + '</b><span>' + esc(q.why) + '</span>' +
        '<button class="btn sm" type="button" data-quick="' + q.id + '"' + (q.id === 'smc' ? ' id="lab-smc"' : '') + '>' + (on ? 'In use' : 'Use this') + '</button></div>';
    }).join('') + '</div>';
  }

  function formHtml(f) {
    var trailOn = f.after === 'trail';
    var changed = SECTIONS.reduce(function (n, x) { return n + sectionOn(f, x[0]); }, 0);
    return '<section class="card lab-form" id="lab-form"><div class="card-head"><div><h2>Your rules</h2><p>1 · pick a ready setup, 2 · check the basics, ' +
      '3 · press ▶ Run. Everything else is optional under <b>More rules</b>. Kept on this device; your laptop runs it on its Kite candles ' +
      '(daily ~20 years, 4 hour ~5 years).</p></div><div class="actions"><a class="btn sm" href="docs/Backtest-Lab-Guide.pdf" target="_blank" rel="noopener">📘 Guide (PDF)</a></div></div>' +
      '<h3 class="lab-h">1 · Start from a ready setup</h3>' + quickHtml(f) +
      '<h3 class="lab-h">2 · The basics</h3><div class="form-grid">' +
      field('Timeframe', sel('tf', f.tf)) + field('Pattern', sel('group', f.group), 'wide') +
      field('Stop loss', sel('stop', f.stop), 'wide') +
      (f.stop === 'pct' ? num('stopPct', f.stopPct, 'Stop % below the entry', ' min="0.1" step="0.5"') :
        num('stopBuf', f.stopBuf, 'How far below it (%)', ' min="0" step="0.1"')) +
      (f.targetMode === 'swing' ? '' : num('targetR', f.targetR, 'Target (R = times the risk)', ' min="0.25" step="0.25"')) +
      field('At the target', sel('after', f.after), 'wide') +
      (trailOn ? field('Then', sel('trail', f.trail), 'wide') : '') +
      (trailOn && f.trail === 'lows' ? num('trailN', f.trailN, 'N candles', ' min="1" step="1"') : '') +
      (trailOn && f.trail === 'pct' ? num('trailPct', f.trailPct, 'X %', ' min="0.5" step="0.5"') : '') +
      (trailOn && f.trail === 'ema' ? num('emaN', f.emaN, 'EMA length', ' min="2" step="1"') : '') +
      (trailOn && f.trail === 'atr' ? num('atrK', f.atrK, 'x ATR', ' min="0.5" step="0.5"') : '') +
      num('capital', f.capital, 'Account ₹', ' min="1000" step="10000"') + num('riskPct', f.riskPct, 'Risk per trade (% of the account)', ' min="0.05" step="0.25"') +
      field('Test period from (optional)', '<input class="inp" type="date" data-k="testFrom" id="lab-testfrom" value="' + esc(f.testFrom) + '" ' +
        'title="Trades before this date = the development part (where you look for rules); from it = the test part (kept to check them)">') + '</div>' +
      '<p class="sub">Test period: trades before that date = the <b>development</b> part (choose your rules there), from it = the <b>test</b> part (kept aside to check them). ' +
      'Rules that work only in the development part fit the past by luck. E.g. 2020-01-01.</p>' +
      '<h3 class="lab-h">3 · More rules (optional)' + (changed ? ' - ' + changed + ' changed' : '') + '</h3><div class="lab-secs">' +
      sec('structure', SECTIONS[0][1], structHtml(f), f) + sec('shape', SECTIONS[1][1], shapeHtml(f), f) + sec('trend', SECTIONS[2][1], trendHtml(f), f) +
      sec('entry', SECTIONS[3][1], entryHtml(f), f) + sec('exit', SECTIONS[4][1], exitHtml(f), f) + sec('money', SECTIONS[5][1], moneyHtml(f), f) +
      sec('check', SECTIONS[6][1], checkHtml(f), f) +
      (changed ? '<button class="btn sm" type="button" id="lab-more-off">Clear all the "More rules"</button>' : '') + '</div>' +
      '<p class="note lab-plain" id="lab-plain"><b>In plain words:</b> ' + esc(plain(f)) + '</p>' +
      '<div class="lab-actions"><label class="field lab-name"><span>Name of this idea</span><input class="inp" type="text" maxlength="60" data-k="name" value="' + esc(f.name) + '"></label>' +
      '<button class="btn primary" type="button" id="lab-run">▶ Run on my laptop</button>' +
      '<button class="btn" type="button" id="lab-pine" title="The TradingView indicator with these rules filled in - paste it in TradingView\'s Pine Editor">📋 Copy TradingView script</button>' +
      '<button class="btn" type="button" id="lab-save">Save as a preset</button>' +
      (presets().length ? '<select class="sel" id="lab-preset" aria-label="Load a preset"><option value="">Load a preset…</option>' +
        presets().map(function (p, i) { return '<option value="' + i + '">' + esc(p.name || 'Preset ' + (i + 1)) + '</option>'; }).join('') + '</select>' +
        '<button class="btn sm danger" type="button" id="lab-preset-del" title="Delete the chosen preset">Delete preset</button>' : '') +
      '<button class="btn sm" type="button" id="lab-reset">Back to the default</button></div><div id="lab-pine-box" class="lab-pine"></div></section>';
  }

  function readForm(el) {
    var f = form();
    el.querySelectorAll('#lab-form [data-k]').forEach(function (inp) {
      var k = inp.getAttribute('data-k');
      if (inp.type === 'checkbox') f[k] = inp.checked;
      else if (NUMS.indexOf(k) >= 0) { var v = Number(inp.value); if (isFinite(v) && inp.value !== '') f[k] = v; }
      else f[k] = String(inp.value || '');
    });
    ['trailN', 'emaN', 'maxDays', 'maxOpen', 'maxTouch'].forEach(function (k) { f[k] = Math.max(0, Math.round(f[k])); });
    f.trailN = Math.max(1, f.trailN); f.maxDays = Math.max(1, f.maxDays); f.maxOpen = Math.max(1, f.maxOpen);
    return f;
  }

  // ---------- talking to the sheet (the laptop answers through it)
  function ask(body) {
    return SB.wlSync.owner(Object.assign({ op: 'lab' }, body), function (j) { return j.result === 'lab'; });
  }
  function stopPoll() { clearTimeout(ST.timer); ST.timer = 0; }
  function poll(el, gen) {
    stopPoll();
    if (gen !== ST.gen || !document.body.contains(el)) return;
    ask({ lab: { do: 'status' } }).then(function (j) {
      if (gen !== ST.gen) return;
      var was = ST.status && ST.status.job, now = j.job;
      ST.status = j;
      ST.err = '';
      paintStatus(el);
      paintRuns(el);
      if (now && (now.status === 'waiting' || now.status === 'running')) ST.timer = setTimeout(function () { poll(el, gen); }, POLL_MS);
      else if (now && now.status === 'done' && was && was.id === now.id && was.status !== 'done') openRun(el, now.id);
    }, function (e) {
      if (gen !== ST.gen) return;
      ST.err = e && e.message || 'the sheet could not be reached';
      paintStatus(el);
      if (!(e && /^(pin|nopin|locked|off)$/.test(e.code))) ST.timer = setTimeout(function () { poll(el, gen); }, POLL_MS * 4);
    });
  }

  function paintStatus(el) {
    var box = $('#lab-status', el);
    if (!box) return;
    var s = ST.status, j = s && s.job, h = '';
    var seen = s && isNum(s.pcSeenSec) ? s.pcSeenSec : null;
    var pc = seen === null ? '<span class="badge s-warn">laptop: not seen yet</span>' :
      seen <= 180 ? '<span class="badge s-good">laptop: online (asked ' + (seen < 60 ? seen + ' s' : Math.round(seen / 60) + ' min') + ' ago)</span>' :
        '<span class="badge s-warn">laptop: last asked ' + (seen < 3600 ? Math.round(seen / 60) + ' min' : Math.round(seen / 3600) + ' h') + ' ago - is it on?</span>';
    // the laptop busy without a run - e.g. preparing the candles after an update (owner, 11-Nov-2026: "loading only")
    if (s && s.pcNote) pc += ' <span class="badge s-info" id="lab-pcnote">' + esc(s.pcNote) + '</span>';
    if (ST.err) h += '<p class="note bad">' + esc(ST.err) + '</p>';
    if (j && (j.status === 'waiting' || j.status === 'running')) {
      var pct = j.status === 'running' ? Math.max(3, j.pct || 0) : 0;
      h += '<div class="lab-run-state"><div><b>' + esc(j.name || 'Your run') + '</b> - ' + (j.status === 'waiting' ? 'waiting for your laptop' +
        (s.pcNote ? ' - it is ' + esc(s.pcNote) + '; your run comes right after' :
          seen !== null && seen > 180 ? ' (it has not asked for a while - switch it on, it will pick this up)' : ' (it asks every 10 seconds while this page is open)') :
        'running on your laptop' + (j.note ? ': ' + esc(j.note) : '')) + '</div>' +
        '<div class="lab-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><i style="width:' + pct + '%"></i></div>' +
        '<button class="btn sm" type="button" id="lab-cancel" title="' + (j.status === 'running' ? 'Stop waiting for this run - the laptop finishes its current step, then takes your next run' : 'Cancel this run') +
        '">Cancel</button></div>';
    } else if (j && j.status === 'failed') {
      h += '<p class="note bad"><b>' + esc(j.name || 'The last run') + '</b> did not finish: ' + esc(j.error || 'failed') + '</p>';
    }
    box.innerHTML = '<div class="lab-pc">' + pc + '</div>' + h;
    var c = $('#lab-cancel', box);
    if (c) c.addEventListener('click', function () { ask({ lab: { do: 'cancel' } }).then(function () { poll(el, ST.gen); }, function () {}); });
  }

  /** Your runs as one comparison table (owner, 12-Nov-2026: test one change at a time and compare) - a click opens a run. */
  function paintRuns(el) {
    var box = $('#lab-runs', el);
    if (!box) return;
    var list = (ST.status && ST.status.list) || [];
    if (!list.length) { box.innerHTML = '<p class="empty">No run yet - pick a setup and press ▶ Run on my laptop.</p>'; return; }
    box.innerHTML = '<div class="tbl-wrap"><table class="tbl lab-runs-t"><thead><tr><th>Run</th><th>Trades</th><th>Win %</th><th>Avg R a trade</th>' +
      '<th>Likely range</th><th>Real or chance?</th><th>Test part avg R</th><th>Account</th></tr></thead><tbody>' + list.map(function (r) {
        var h = r.head || {}, e = EDGE[h.edge] || null;
        return '<tr class="lab-run' + (r.id === ST.itemId ? ' on' : '') + '"><th><a href="#lab/' + esc(r.id) + '"><b>' + esc(r.name || h.group || 'Run') + '</b></a>' +
          '<div class="sub">' + esc(r.saved) + ' · ' + esc(h.tf || '') + ' · ' + esc(h.group || '') + '</div></th>' +
          '<td>' + F.int(h.trades) + '</td><td>' + (isNum(h.winPct) ? F.num(h.winPct, 1) + '%' : '–') + '</td>' +
          '<td class="' + tone(h.avgR) + '">' + r2(h.avgR) + '</td><td>' + rng(h.lo, h.hi) + '</td><td>' + (e ? ui.badge(e[0], e[1]) : '<span class="sub">–</span>') + '</td>' +
          '<td class="' + tone(h.testAvgR) + '">' + (isNum(h.testAvgR) ? r2(h.testAvgR) + ' <span class="sub">(' + F.int(h.testTrades) + ')</span>' : '<span class="sub">–</span>') + '</td>' +
          '<td class="' + tone(h.returnPct) + '">' + (isNum(h.returnPct) ? F.pct(h.returnPct) : '–') + '</td></tr>';
      }).join('') + '</tbody></table></div><p class="sub">Change one thing at a time and compare the rows. Trust a row more when the range is clear of 0 and the test part agrees.</p>';
    box.querySelectorAll('tr.lab-run').forEach(function (tr) {
      tr.addEventListener('click', function (ev) { if (!ev.target.closest('a')) { var a = tr.querySelector('a'); if (a) location.hash = a.getAttribute('href'); } });
    });
  }

  function openRun(el, id) {
    if (!id) return;
    ST.itemId = id;
    var box = $('#lab-result', el);
    if (box) box.innerHTML = ui.skeleton ? ui.skeleton(4) : '<p class="empty">Loading…</p>';
    paintRuns(el);
    ask({ lab: { do: 'result', id: id } }).then(function (j) {
      ST.item = j.item;
      rememberIndices(el, j.item && j.item.result && j.item.result.indexNames);
      paintResult(el);
    }, function (e) {
      if (box) box.innerHTML = '<p class="note bad">' + esc(e && e.message || 'could not load that run') + '</p>';
    });
  }

  function r2(v) { return isNum(v) ? F.num(v, 2) + 'R' : '–'; }

  /** The indices the laptop really has (from a run) - kept on this device for the Index list. */
  function rememberIndices(el, names) {
    if (!Array.isArray(names) || !names.length) return;
    var clean = names.filter(function (n) { return /^[A-Z0-9_&.-]{2,40}$/.test(n); });
    if (!clean.length) return;
    ui.store.set('lab:indices', clean);
    var s = $('#lab-mkt-index', el);
    if (!s) return;
    var cur = s.value;
    s.innerHTML = '<option value="">Off - no market rule</option>' + indexList(cur).map(function (n) {
      return '<option value="' + esc(n) + '"' + (n === cur ? ' selected' : '') + '>' + esc(idxName(n)) + '</option>';
    }).join('');
  }

  /** "N skipped: ..." - why the account did not take some signals (each trade's reason: hover / tap "skipped"). */
  function skipWords(a) {
    var w = a.skipReasons || {};
    var parts = [[w.full, 'too many open at once'], [w.cap, 'one share cost more than your position limit'],
      [w.risk, 'one share risked more than your risk per trade'], [w.blown, 'the account had run out']]
      .filter(function (x) { return x[0]; }).map(function (x) { return F.int(x[0]) + ' ' + x[1]; });
    if (!a.skipped) return 'none skipped';
    return F.int(a.skipped) + ' skipped' + (parts.length ? ': ' + parts.join(', ') : '') + ' - hover / tap "skipped" in the list for each one';
  }
  /** A plain hint when a money rule left out many signals. */
  function skipHint(a, p) {
    var w = a.skipReasons || {}, h = '';
    var total = (a.taken || 0) + (a.skipped || 0);
    if (!total) return '';
    if (w.cap && w.cap >= total * 0.1) {
      h += '<p class="note warn">' + F.int(w.cap) + ' signals were not taken because one share cost more than your position limit (' + F.num(p.maxPosPct, 0) +
        '% of the account). To take them: raise <b>One position at most</b> in 8 · Money.</p>';
    }
    if (w.full && w.full >= total * 0.1) {
      h += '<p class="note warn">' + F.int(w.full) + ' signals came while ' + F.int(p.maxOpen) + ' trades were already open. To take them: raise <b>Trades open at once, at most</b> in 8 · Money.</p>';
    }
    if (a.capped && a.capped >= (a.taken || 1) * 0.3) {
      h += '<p class="note">' + F.int(a.capped) + ' of the trades taken were made smaller by your position limit (' + F.num(p.maxPosPct, 0) + '%), so they risked less than ' +
        F.num(p.riskPct, 2) + '% of the account.</p>';
    }
    return h;
  }
  function tone(v) { return isNum(v) ? (v > 0 ? ' up' : v < 0 ? ' down' : '') : ''; }

  /** The run's charts PDF on the laptop (owner, 12-Nov-2026: "a PDF should come with it - a chart for every trade ... the
   *  swings, CHoCH, FVG area, target and stop loss"; choices: the laptop folder only, every trade, the losing ones first). */
  function pdfNote(pdf) {
    if (!pdf) return '';
    if (pdf.error) return '<p class="note warn">The charts PDF could not be made on your laptop: ' + esc(pdf.error) + '</p>';
    if (!pdf.file) return '';
    return '<p class="note lab-pdf">📄 <b>Charts PDF on your laptop</b> - two pages for every trade (the chart with HH / HL / LH / LL, CHoCH, BOS, zone, BUY; then why it was taken and how it ended) - the losing ones first: <code>ScreenerBridge\\' +
      esc(pdf.folder || 'lab_charts') + '\\' + esc(pdf.file) + '</code> - ' + F.int(pdf.pages) + ' pages' +
      (pdf.shown < pdf.trades ? ' (the first ' + F.int(pdf.shown) + ' of ' + F.int(pdf.trades) + ' trades)' : '') +
      '. On the laptop: File Explorer → the ScreenerBridge folder → <b>lab_charts</b> (the newest 20 PDFs are kept).</p>';
  }

  /** With market structure 'only': how many signals each structure rule left out (the first one they failed). */
  function structNote(res) {
    var why = res.structWhy || {}, keys = Object.keys(why).filter(function (k) { return why[k]; });
    if (!keys.length) return '';
    return '<p class="note">Market structure: left out - ' + keys.sort(function (a, b) { return why[b] - why[a]; })
      .map(function (k) { return F.int(why[k]) + ' ' + (STRUCT_WHY[k] || k); }).join('; ') + '.</p>';
  }

  /** With hard Spring rules on: how many Springs each rule left out (the first rule a Spring failed), and a plain
   *  warning when few trades remain - an average over a handful of trades is mostly luck. */
  function shapeNote(res, s) {
    var why = res.shapeWhy || {}, keys = Object.keys(why).filter(function (k) { return why[k]; });
    if (!keys.length) return '';
    var kept = s.trades || 0, left = (res.skipped && res.skipped.shape) || 0;
    var h = '<p class="note">Spring shape rules: <b>' + F.int(kept + (res.open || 0)) + '</b> of ' + F.int(kept + (res.open || 0) + left) + ' Springs passed. Left out - ' +
      keys.sort(function (a, b) { return why[b] - why[a]; }).map(function (k) { return F.int(why[k]) + ' ' + (SHAPE_WHY[k] || k); }).join('; ') + '.</p>';
    if (kept < 300) {
      h += '<p class="note warn">Only ' + F.int(kept) + ' trades are left. An average of ' + r2(s.avgR) + ' over so few trades can easily be luck - ' +
        'try the same idea with fewer rules, a bigger group (e.g. Every Spring) or the weekly chart before you trust it.</p>';
    }
    return h;
  }

  // "real or chance?", the breakdowns and the development / test split (owner, 12-Nov-2026, after a ChatGPT review of his
  // 405-trade run: zone depth 60-70 % weak / 70-90 % strong, 4 lower highs / lows better than 3, the CHoCH-to-signal lag;
  // "yes do it") - worked out on the laptop (backtest_lab.py breakdowns / _split)
  var EDGE = { real: ['An edge', 's-good', 'the whole range is above 0 - not luck (in this period)'],
    chance: ['Could be chance', 's-warn', 'the range spans 0 - the average could be luck'],
    losing: ['Losing', 's-bad', 'the whole range is under 0'], few: ['Too few trades', 's-warn', 'under 30 trades - too few to say'] };
  // short chip names (the full name heads the table) - a long chip would push a phone screen sideways
  var BD_SHORT = { depth: 'Zone depth', lhll: 'Lower highs / lows', lag: 'Days from CHoCH', where: 'Into the zone', zone: 'Zone kind', touch: 'Touch',
    risk: 'Risk %', turn: 'Turnover' };
  var VERDICT = { better: ['Better', 's-good'], worse: ['Worse', 's-bad'], chance: ['Could be chance', ''], few: ['Too few', 's-warn'] };
  function rng(lo, hi) { return isNum(lo) && isNum(hi) ? r2(lo) + ' to ' + r2(hi) : '–'; }
  function edgeNote(s) {
    if (!s || !s.edge || !EDGE[s.edge]) return '';
    var e = EDGE[s.edge];
    return '<p class="note' + (s.edge === 'real' ? '' : s.edge === 'losing' ? ' bad' : ' warn') + '" id="lab-edge">Real or chance? ' + ui.badge(e[0], e[1]) +
      ' the average per trade is likely between <b>' + rng(s.avgRLo, s.avgRHi) + '</b> (90% range from the spread of the trades) - ' + esc(e[2]) + '.</p>';
  }
  /** A folded section of the result: Development vs test, What worked best and the trades open at first; the rest closed
   *  (this device remembers what you opened). */
  var RSEC_OPEN = ['split', 'bd', 'trades'];
  function rsec(id, title, body) {
    var mem = ui.store.get('lab:ropen', {}) || {};
    var open = mem[id] !== undefined ? !!mem[id] : RSEC_OPEN.indexOf(id) >= 0;
    return '<details class="lab-sec lab-rsec" data-rsec="' + id + '"' + (open ? ' open' : '') + '><summary><span>' + esc(title) + '</span></summary>' +
      '<div class="lab-sec-body">' + body + '</div></details>';
  }
  /** The verdict's second line: does the test part agree with the development part? */
  function verdictTest(res) {
    var sp = res.split, d = sp && sp.dev, t = sp && sp.test;
    if (!sp) return '<p class="sub">Tip: set a <b>Test period from</b> date (step 2) to check the rules on years you did not look at.</p>';
    if (!(d && d.trades && t && t.trades)) return '';
    var ok = d.avgR > 0 && t.avgR > 0;
    return '<p class="note' + (ok ? '' : ' warn') + '">Test part (from ' + F.date(sp.at) + '): <b>' + r2(t.avgR) + '</b> a trade over ' + F.int(t.trades) +
      ' trades - ' + (ok ? 'it agrees with the development part (' + r2(d.avgR) + ').' : d.avgR > 0 ? 'it does NOT agree with the development part (' + r2(d.avgR) +
        ') - the rules may fit the past only.' : 'the development part itself (' + r2(d.avgR) + ') did not make money.') + '</p>';
  }
  /** "Steady over time?": the figures of every N-year block (the laptop's rolling blocks). */
  function rollingHtml(res) {
    var r = res.rolling;
    if (!r || !r.length) return '';
    return '<h3 class="lab-h">Steady over time? (every ' + (r[0].to - r[0].from + 1) + ' year' + (r[0].to === r[0].from ? '' : 's') + ')</h3>' +
      '<div class="tbl-wrap"><table class="tbl" id="lab-rolling"><thead><tr><th>Years</th><th>Trades</th><th>Win %</th><th>Avg R</th><th>Likely range</th><th>Real or chance?</th></tr></thead><tbody>' +
      r.map(function (x) {
        var e = EDGE[x.edge] || ['', ''];
        return '<tr><th>' + x.from + (x.to !== x.from ? ' - ' + x.to : '') + '</th><td>' + F.int(x.trades) + '</td><td>' + F.num(x.winPct, 1) + '%</td>' +
          '<td class="' + tone(x.avgR) + '">' + r2(x.avgR) + '</td><td>' + rng(x.lo, x.hi) + '</td><td>' + ui.badge(e[0], e[1]) + '</td></tr>';
      }).join('') + '</tbody></table></div><p class="sub">An edge that is real shows up in most blocks, not in one lucky stretch.</p>';
  }
  function splitHtml(res) {
    var sp = res.split;
    if (!sp) return '';
    var row = function (name, x) {
      if (!x || !x.trades) return '<tr><th>' + name + '</th><td colspan="7" class="sub">no finished trade</td></tr>';
      var e = EDGE[x.edge] || ['', ''];
      return '<tr><th>' + name + '<div class="sub">' + F.date(x.from) + ' – ' + F.date(x.to) + '</div></th><td>' + F.int(x.trades) + '</td><td>' + F.num(x.winPct, 1) + '%</td>' +
        '<td class="' + tone(x.avgR) + '">' + r2(x.avgR) + '</td><td>' + rng(x.avgRLo, x.avgRHi) + '</td><td>' + F.num(x.totalR, 1) + 'R</td>' +
        '<td>' + (isNum(x.pf) ? F.num(x.pf, 2) : '–') + '</td><td>' + ui.badge(e[0], e[1]) + '</td></tr>';
    };
    var d = sp.dev || {}, t = sp.test || {}, say = '';
    if (d.trades && t.trades) {
      say = d.avgR > 0 && t.avgR > 0 ? '<p class="note">The test part agrees: both parts made money per trade.' + (t.edge === 'real' ? '' : ' (The test part alone is not yet clear of chance.)') + '</p>'
        : d.avgR > 0 && !(t.avgR > 0) ? '<p class="note bad">The test part does NOT agree: the rules made money before ' + F.date(sp.at) + ' but not after - they may fit the past only.</p>'
          : '<p class="note warn">The development part itself did not make money per trade - change the rules there first (and do not look at the test part while choosing).</p>';
    }
    return '<div class="tbl-wrap"><table class="tbl" id="lab-split"><thead><tr><th>Part</th><th>Trades</th>' +
      '<th>Win %</th><th>Avg R</th><th>Likely range</th><th>Total R</th><th>Profit factor</th><th>Real or chance?</th></tr></thead><tbody>' +
      row('Development (before)', d) + (sp.val ? row('Validation (from ' + F.date(sp.val) + ')', sp.valid) : '') + row('Test (from)', t) + '</tbody></table></div>' + say;
  }
  function bdHtml(res) {
    var b = res.breakdowns || [];
    var noStruct = !res.params || res.params.structure === 'off';
    if (!b.length) return '';
    if (!ST.bd || !b.some(function (x) { return x.key === ST.bd; })) ST.bd = b[0].key;
    return '<div class="controls">' + ui.chips('labbd', b.map(function (x) { return [x.key, BD_SHORT[x.key] || x.name]; }), ST.bd) + '</div><div id="lab-bd"></div>' +
      '<p class="sub">Each row = the finished trades with that feature. <b>Better / Worse</b> = their average R vs the rest of this run\'s trades, clear at 90%; ' +
      '<b>Could be chance</b> = the difference is within luck; under 30 trades = too few to say. ' +
      (res.split ? '<b>Held in test</b> = it beat (or trailed) the rest in the development part AND in the test part - trust those rows most. ' : 'Set a test period (step 1) to check a row on later years. ') +
      (noStruct ? 'Turn on market structure (step 2, "Show it on every trade") to also see the zone depth, the lower highs / lows and the days from the CHoCH.' : '') + '</p>';
  }
  function drawBd(box, res) {
    var host = $('#lab-bd', box);
    if (!host) return;
    var b = (res.breakdowns || []).filter(function (x) { return x.key === ST.bd; })[0];
    if (!b) { host.innerHTML = ''; return; }
    var split = !!res.split;
    var part = function (x) { return x && x.trades ? r2(x.avgR) + ' <span class="sub">(' + F.int(x.trades) + ')</span>' : '<span class="sub">–</span>'; };
    host.innerHTML = '';
    new ui.Table({
      rows: b.rows, pageSize: 20, id: 'lab-bd-' + b.key, tools: false,
      columns: [
        { key: 'label', label: b.name, get: function (r) { return r.label; } },
        { key: 'trades', label: 'Trades', type: 'num', digits: 0 }, { key: 'winPct', label: 'Win %', type: 'num', digits: 1 },
        { key: 'avgR', label: 'Avg R', type: 'num', digits: 2, html: function (r) { return '<span class="' + tone(r.avgR) + '">' + r2(r.avgR) + '</span>'; } },
        { key: 'lo', label: 'Likely range', get: function (r) { return r.lo; }, html: function (r) { return rng(r.lo, r.hi); }, title: 'The likely range (90%) of this group\'s average R' },
        { key: 'totalR', label: 'Total R', type: 'num', digits: 1 }, { key: 'hitPct', label: 'Reached target %', type: 'num', digits: 1 },
        { key: 'verdict', label: 'vs the rest', get: function (r) { return (VERDICT[r.verdict] || [r.verdict])[0]; },
          html: function (r) { var v = VERDICT[r.verdict] || [r.verdict, '']; return ui.badge(v[0], v[1]); } },
        { key: 'dev', label: 'Development: avg R (trades)', get: function (r) { return r.dev ? r.dev.avgR : null; }, html: function (r) { return part(r.dev); } },
        { key: 'val', label: 'Validation: avg R (trades)', get: function (r) { return r.val ? r.val.avgR : null; }, html: function (r) { return part(r.val); } },
        { key: 'test', label: 'Test: avg R (trades)', get: function (r) { return r.test ? r.test.avgR : null; }, html: function (r) { return part(r.test); } },
        { key: 'held', label: 'Held in test', get: function (r) { return r.held || ''; },
          html: function (r) { return r.held === 'yes' ? ui.badge('Yes', 's-good') : r.held === 'no' ? ui.badge('No', 's-bad') : '<span class="sub">too few</span>'; } }
      ].filter(function (c) { return c.key === 'val' ? !!(res.split && res.split.val) : split || ['dev', 'test', 'held'].indexOf(c.key) < 0; })
    }).mount(host);
  }

  function paintResult(el) {
    var box = $('#lab-result', el);
    var it = ST.item;
    if (!box || !it || !it.result) return;
    var res = it.result, s = res.stats || {}, a = res.account || {}, p = res.params || {};
    var h = '<section class="card"><div class="card-head"><div><h2>' + esc(it.name || res.groupName || 'Result') + '</h2>' +
      '<p>' + esc(it.saved) + ' · candles up to ' + F.date(res.cacheUpto) + ' · signals ' + F.date(res.from) + ' – ' + F.date(res.to) +
      ' · worked out in ' + F.num(res.secs, 1) + ' s on your laptop</p></div>' +
      '<div class="actions"><button class="btn sm" type="button" id="lab-use">Use these rules</button>' +
      '<button class="btn sm" type="button" id="lab-res-pine" title="The TradingView indicator with this run\'s rules - to check its trades on the chart">📋 TradingView script</button>' +
      '<button class="btn sm danger" type="button" id="lab-del">Delete this run</button></div></div>' +
      '<p class="note lab-plain"><b>The rules:</b> ' + esc(plain(Object.assign({}, DEF, p))) + '</p>' + pdfNote(res.pdf) + '<div id="lab-res-pine-box" class="lab-pine"></div>';
    if (!s.trades) {
      box.innerHTML = h + '<p class="empty">No trade matched these rules' + (res.open ? ' (' + res.open + ' still running)' : '') + '.</p></section>';
      bindResult(el, it);
      return;
    }
    var sk = res.skipped || {};
    var full = '<div class="tiles">' +
      ui.tile('Trades', F.int(s.trades), (res.open ? F.int(res.open) + ' still running (not counted)' : 'all finished') +
        (sk.risk ? ' · ' + F.int(sk.risk) + ' skipped (risk too big)' : '') +
        (sk.struct ? ' · ' + F.int(sk.struct) + ' left out by your market-structure rules' : '') +
        (sk.noswing ? ' · ' + F.int(sk.noswing) + ' without a swing high above (target)' : '') +
        (sk.zoneentry ? ' · ' + F.int(sk.zoneentry) + ' not first touches (the zone-top order fills on those only)' : '') +
        (sk.shape ? ' · ' + F.int(sk.shape) + ' Springs left out by your shape rules' : '') +
        (sk.ema ? ' · ' + F.int(sk.ema) + ' left out by your EMA rules' : '') +
        (sk.mkt ? ' · ' + F.int(sk.mkt) + ' left out by your market rule' : '') +
        (sk.wk ? ' · ' + F.int(sk.wk) + ' left out by the weekly trend rule' : '') +
        (sk.where ? ' · ' + F.int(sk.where) + ' went too deep into the zone' : '')) +
      ui.tile('Win rate', F.num(s.winPct, 1) + '%', 'sold above the entry (after costs)') +
      ui.tile('Average per trade', '<span class="' + tone(s.avgR) + '">' + r2(s.avgR) + '</span>', 'median ' + r2(s.medR) + ' · this is your edge' +
        (isNum(s.avgRLo) ? ' · likely ' + rng(s.avgRLo, s.avgRHi) : '')) +
      ui.tile('Total', '<span class="' + tone(s.totalR) + '">' + F.num(s.totalR, 1) + 'R</span>', 'profit factor ' + (isNum(s.pf) ? F.num(s.pf, 2) : '–')) +
      ui.tile('Reached ' + F.num(p.targetR, 2) + 'R', F.num(s.hitPct, 1) + '%', 'before the stop loss') +
      ui.tile('Average win / loss', r2(s.avgWinR) + ' / ' + r2(s.avgLossR), 'best ' + r2(s.bestR) + ' · worst ' + r2(s.worstR)) +
      ui.tile('Held', F.num(s.avgDays, 1) + ' days', 'on average · ' + F.int(s.maxLosingStreak) + ' losses in a row at worst') +
      ui.tile('Return per trade', F.pct(s.avgRet, 2), 'median ' + F.pct(s.medRet, 2) + ' · best move before the exit ' + r2(s.avgMaxR) + ' avg') + '</div>' +
      structNote(res) + shapeNote(res, s);
    // the answer first (owner, 12-Nov-2026: "make bactest lab more user-friendly not to be complex"): is there an edge, does the test
    // part agree, what the account did - then the rest folded
    h += '<div class="lab-verdict" id="lab-verdict">' + edgeNote(s) + verdictTest(res) +
      '<div class="tiles">' + ui.tile('Trades', F.int(s.trades), res.open ? F.int(res.open) + ' still running' : 'all finished') +
      ui.tile('Win rate', F.num(s.winPct, 1) + '%', 'sold above the entry') +
      ui.tile('Average per trade', '<span class="' + tone(s.avgR) + '">' + r2(s.avgR) + '</span>', isNum(s.avgRLo) ? 'likely ' + rng(s.avgRLo, s.avgRHi) : 'median ' + r2(s.medR)) +
      ui.tile('Total', '<span class="' + tone(s.totalR) + '">' + F.num(s.totalR, 1) + 'R</span>', 'all trades together') +
      ui.tile('Account', '<span class="' + tone(a.returnPct) + '">' + F.pct(a.returnPct) + '</span>', 'max fall ' + F.num(a.maxDD, 1) + '%') + '</div></div>';
    h += rsec('all', 'Every signal - all the figures', '<p class="sub">Each trade on its own, in R (R = the risk: entry - stop).</p>' + full);
    if (res.split) h += rsec('split', 'Development vs test (split on ' + F.date(res.split.at) + ')', splitHtml(res));
    h += rsec('bd', 'What worked best - one thing at a time', bdHtml(res));
    if (res.stages && res.stages.length) {
      h += rsec('stages', 'By market structure - where each signal sat', '<div id="lab-stages"></div>' +
        '<p class="sub">Your setup = in the discount part of the move (with a Fib line set) or below the CHoCH level, on the first pullback. ' +
        '"Premium" = the zone sat above your Fib line. "After a BOS" = price had already made a new high after the CHoCH. ' +
        'Compare the average R of the rows - with fewer than ~300 trades in a row, a difference can still be luck.</p>');
    }
    h += rsec('account', 'Your account (' + F.inr(a.capital) + ', ' + F.num(p.riskPct, 2) + '% risk a trade, at most ' + F.int(p.maxOpen) + ' at once)', '<div class="tiles">' +
      ui.tile('Account now', F.inr(a.final), '<span class="' + tone(a.pnl) + '">' + (a.pnl >= 0 ? '+' : '−') + F.inr(Math.abs(a.pnl)) + '</span>') +
      ui.tile('Return', '<span class="' + tone(a.returnPct) + '">' + F.pct(a.returnPct) + '</span>', isNum(a.cagr) ? F.pct(a.cagr) + ' a year over ' + F.num(a.years, 1) + ' years' : 'over ' + F.num(a.years, 1) + ' years') +
      ui.tile('Max drawdown', F.num(a.maxDD, 1) + '%', 'the deepest fall from a peak') +
      ui.tile('Trades taken', F.int(a.taken), skipWords(a) + (a.openNow ? ' · ' + F.int(a.openNow) + ' still open' : '')) + '</div>' +
      skipHint(a, p) +
      (a.blown ? '<p class="note bad">The account ran out on ' + F.date(a.blown) + ' - no trades after that.</p>' : '') +
      '<div id="lab-curve" class="lab-chart"></div>');
    h += rsec('exits', 'How the trades ended', '<div class="lab-two"><div><h3 class="lab-h">Exit reasons</h3><div id="lab-reasons"></div></div>' +
      '<div><h3 class="lab-h">Result of each trade (R)</h3><div id="lab-hist"></div></div></div>');
    h += rsec('time', 'Year by year' + (res.rolling ? ' - steady over time?' : ''), rollingHtml(res) + '<div id="lab-years"></div>');
    h += rsec('trades', 'The trades' + (res.tradesTotal > (res.trades || []).length ? ' (the newest ' + F.int(res.trades.length) + ' of ' + F.int(res.tradesTotal) + ')' : ''),
      '<div id="lab-trades"></div>' +
      '<p class="sub">R = profit or loss in units of the risk (entry - stop): -1R = the full stop loss, 2R = twice the risk. Prices are Kite\'s. ' +
      'A candle reaching both the stop and the target counts as the stop; a gap through the stop sells at the open.</p>');
    h += '</section>';
    box.innerHTML = h;
    var curve = (a.curve || []).map(function (c) { return { x: c[0], y: c[1] }; });
    var drawCurve = function () {
      if (curve.length > 1) ui.lineChart($('#lab-curve', box), [{ name: 'Account', points: curve, color: 'var(--accent)' }], { height: 240, label: 'Account value', fmt: function (v) { return F.inr(v); } });
      else $('#lab-curve', box).innerHTML = '';
    };
    var accSec = box.querySelector('[data-rsec="account"]');
    if (accSec && accSec.open) drawCurve();
    // a chart is drawn when its section first opens (a closed section has no width); the open ones are remembered
    $('section.card', box).addEventListener('toggle', function (e) {
      var d = e.target, id = d && d.getAttribute && d.getAttribute('data-rsec');
      if (!id) return;
      var mem = ui.store.get('lab:ropen', {}) || {};
      mem[id] = d.open;
      ui.store.set('lab:ropen', mem);
      if (id === 'account' && d.open && !$('#lab-curve svg', box)) drawCurve();
    }, true);
    var rs = res.reasons || {};
    $('#lab-reasons', box).innerHTML = ui.bars(Object.keys(REASON).filter(function (k) { return rs[k]; }).map(function (k) {
      return { label: REASON[k][0], value: rs[k] };
    }), { fmt: function (v) { return F.int(v); } });
    $('#lab-hist', box).innerHTML = ui.bars((res.hist || []).map(function (b) { return { label: b.label, value: b.n }; }), { fmt: function (v) { return F.int(v); } });
    new ui.Table({
      rows: res.years || [], pageSize: 40, id: 'lab-years', tools: false,
      columns: [
        { key: 'year', label: 'Year' }, { key: 'trades', label: 'Trades', type: 'num', digits: 0 },
        { key: 'winPct', label: 'Win %', type: 'num', digits: 1 }, { key: 'avgR', label: 'Avg R', type: 'num', digits: 2 },
        { key: 'totalR', label: 'Total R', type: 'num', digits: 1 }, { key: 'taken', label: 'Taken', type: 'num', digits: 0 },
        { key: 'pnl', label: 'Account P/L ₹', type: 'num', digits: 0 }
      ]
    }).mount($('#lab-years', box));
    if (res.stages && res.stages.length) {
      new ui.Table({
        rows: res.stages, pageSize: 10, id: 'lab-stages', tools: false,
        columns: [
          { key: 'stage', label: 'Where the signal sat', html: function (r) { var x = STAGE[r.stage] || [r.name, '']; return ui.badge(x[0], x[1]) + ' <span class="sub">' + esc(r.name) + '</span>'; } },
          { key: 'trades', label: 'Trades', type: 'num', digits: 0 }, { key: 'winPct', label: 'Win %', type: 'num', digits: 1 },
          { key: 'avgR', label: 'Avg R', type: 'num', digits: 2, html: function (r) { return '<span class="' + tone(r.avgR) + '">' + r2(r.avgR) + '</span>'; } },
          { key: 'medR', label: 'Median R', type: 'num', digits: 2 }, { key: 'totalR', label: 'Total R', type: 'num', digits: 1 },
          { key: 'hitPct', label: 'Reached target %', type: 'num', digits: 1 }, { key: 'avgMaxR', label: 'Avg best R', type: 'num', digits: 2 },
          { key: 'open', label: 'Still running', type: 'num', digits: 0 }
        ]
      }).mount($('#lab-stages', box));
    }
    drawBd(box, res);
    // on the result's own card (re-made with each paint), so listeners never pile up
    ui.bindChips($('section.card', box), 'labbd', function (v) { ST.bd = v; drawBd(box, res); });
    var cols = res.tradeCols || [];
    var rows = (res.trades || []).map(function (r) { var o = {}; cols.forEach(function (c, i) { o[c] = r[i]; }); return o; });
    new ui.Table({
      rows: rows, pageSize: 50, id: 'lab-trades', empty: 'No trade',
      columns: [
        { key: 'sym', label: 'Stock', type: 'sym' },
        { key: 'signal', label: 'Signal candle' },
        { key: 'zone', label: 'Zone', get: function (r) { return r.zone + (r.where ? ' · ' + r.where : ''); } },
        { key: 'stage', label: 'Structure', get: function (r) { return r.stage ? (STAGE[r.stage] || [r.stage])[0] : ''; },
          html: function (r) {
            if (!r.stage) return '';
            var x = STAGE[r.stage] || [r.stage, ''];
            return r.struct ? '<span class="lab-acct" tabindex="0" data-tip="' + esc(r.struct) + '">' + ui.badge(x[0], x[1]) + '</span>' : ui.badge(x[0], x[1]);
          }, title: 'Market structure at the signal (hover / tap for the CHoCH level, its date, the final low, the move high, the zone\'s place in the move and the BOS)' },
        { key: 'entry', label: 'Entry', type: 'num', digits: 2 }, { key: 'stop', label: 'Stop', type: 'num', digits: 2 },
        { key: 'target', label: 'Target', type: 'num', digits: 2, title: 'The target price (R multiple or the last swing high)' },
        { key: 'riskPct', label: 'Risk %', type: 'num', digits: 2 },
        { key: 'exit', label: 'Exit', type: 'num', digits: 2 }, { key: 'exitOn', label: 'Sold on' },
        { key: 'reason', label: 'Why', html: function (r) { var x = REASON[r.reason] || [r.reason, '']; return ui.badge(x[0], x[1]); } },
        { key: 'R', label: 'R', type: 'num', digits: 2, html: function (r) { return '<span class="' + tone(r.R) + '">' + r2(r.R) + '</span>'; } },
        { key: 'ret', label: 'Return %', type: 'num', digits: 2 }, { key: 'days', label: 'Days', type: 'num', digits: 0 },
        { key: 'maxR', label: 'Best (R)', type: 'num', digits: 2, title: 'The highest price before the exit, in R' },
        { key: 'pnl', label: 'P/L ₹', type: 'num', digits: 0, get: function (r) { return r.taken ? r.pnl : null; } },
        { key: 'upW', label: 'Upper wick %', type: 'num', digits: 1, title: 'The Spring candle\'s upper wick, % of its high-low range (sort / filter to see which shapes worked)' },
        { key: 'loW', label: 'Lower wick %', type: 'num', digits: 1, title: 'The Spring candle\'s lower wick, % of its high-low range' },
        { key: 'dip', label: 'Dip %', type: 'num', digits: 2, title: 'How far the Spring candle\'s low went under the red candle\'s low, % of that low' },
        { key: 'ema', label: 'EMA', get: function (r) { return r.ema || ''; }, title: 'What the EMAs showed on the Spring candle (with EMA rules on)' },
        { key: 'depth', label: 'Depth %', type: 'num', digits: 0, title: 'How far down the move the zone sat (0% = the move high, 100% = the final low)' },
        { key: 'lhll', label: 'LH / LL', type: 'num', digits: 0, title: 'Lower highs / lows before the CHoCH' },
        { key: 'lag', label: 'Days from CHoCH', type: 'num', digits: 0, title: 'Calendar days from the CHoCH candle to the signal' },
        { key: 'taken', label: 'In the account', get: function (r) { return r.taken ? 'yes' : 'skipped'; },
          // owner, 09-Nov-2026: "show the reason if I place the cursor on the word skipped" (a tap on a phone)
          html: function (r) {
            var t = r.taken ? 'yes' : 'skipped';
            return r.acct ? '<span class="lab-acct' + (r.taken ? '' : ' skip') + '" tabindex="0" data-tip="' + esc(String(r.acct).replace(/\bRs /g, '₹')) + '">' + t + ' <i aria-hidden="true">ⓘ</i></span>' : t;
          } },
        // owner, 11-Nov-2026: "i open trading view chart and i go to that trade date" - the chart at the run's timeframe
        // (then Alt+G = go to the date; the Stock Blueprint indicator draws the CHoCH, the zones and the entries)
        { key: 'chart', label: 'Chart', get: function () { return null; },
          html: function (r) { return '<a class="btn sm" href="' + esc(tvUrl(r.sym, p.tf)) + '" target="_blank" rel="noopener" title="Open ' + esc(r.sym) + ' on TradingView - then Alt+G and type ' + esc(String(r.signal).slice(0, 10)) + '">TradingView ↗</a>'; } }
      ].filter(function (c) {
        if (c.key === 'ema') return rows.some(function (r) { return r.ema; });
        if (c.key === 'stage') return rows.some(function (r) { return r.stage; });
        if (c.key === 'target') return rows.some(function (r) { return isNum(r.target); });
        if (c.key === 'upW' || c.key === 'loW' || c.key === 'dip') return rows.some(function (r) { return isNum(r[c.key]); });   // runs before 10-Nov-2026 have none
        if (c.key === 'depth' || c.key === 'lhll' || c.key === 'lag') return rows.some(function (r) { return isNum(r[c.key]); });   // with market structure (12-Nov-2026)
        return true;
      })
    }).mount($('#lab-trades', box));
    bindResult(el, it);
  }

  function bindResult(el, it) {
    var use = $('#lab-use', el), del = $('#lab-del', el), rp = $('#lab-res-pine', el);
    if (rp) rp.addEventListener('click', function () {
      copyPine(Object.assign({}, DEF, it.result.params || {}, { name: it.name || DEF.name }), $('#lab-res-pine-box', el));
    });
    if (use) use.addEventListener('click', function () {
      var f = Object.assign({}, form(), it.result.params || {});
      f.name = it.name || f.name;
      saveForm(f);
      SB.route(true);
      window.scrollTo(0, 0);
    });
    if (del) del.addEventListener('click', function () {
      if (!window.confirm('Delete this run?')) return;
      ask({ lab: { do: 'delete', id: it.id } }).then(function (j) {
        ST.status = j; ST.item = null; ST.itemId = null;
        location.hash = '#lab';
      }, function (e) { window.alert(e && e.message || 'could not delete'); });
    });
  }

  /** "Copy TradingView script" (owner, 11-Nov-2026: "give option to copy the pinescript in this page that works with respect
   *  to the current setup before running the setup. i will copy the pinescript and will paste it in the trading view
   *  pinescript"): the indicator (tradingview/StockBlueprint_CHoCH_FVG.pine) with the form's rules as its settings. */
  function copyPine(f, box) {
    if (!box) return;
    var code;
    try {
      code = SB.pine.build(f, { name: f.name, plain: plain(f), when: F.date(new Date().toISOString().slice(0, 10)) });
    } catch (e) {
      box.innerHTML = '<p class="note bad">The TradingView script could not be made: ' + esc(e && e.message || 'unknown') + '</p>';
      return;
    }
    var file = 'StockBlueprint_' + (String(f.name || 'rules').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'rules') + '.pine';
    var url = '';
    try { url = URL.createObjectURL(new Blob([code], { type: 'text/plain' })); } catch (e) { url = ''; }
    var show = function (copied) {
      box.innerHTML = (copied ? '<p class="note good"><b>Copied</b> - the TradingView script with these rules (' + F.int(code.split('\n').length) + ' lines).</p>' :
        '<p class="note warn">This browser did not let the page copy it - select the script below (Ctrl+A in the box) and copy it (Ctrl+C).</p>') +
        '<ol class="lab-pine-steps"><li>TradingView: open the stock\'s chart on the <b>' + esc(f.tf === 'W' ? 'weekly' : f.tf === '4H' ? '4 hour' : 'daily') + '</b> timeframe.</li>' +
        '<li>At the bottom of the chart: <b>Pine Editor</b> → select everything there (Ctrl+A) → paste (Ctrl+V) → <b>Save</b> → <b>Add to chart</b>.</li>' +
        '<li>Already on the chart from before? Remove it and add it again (an indicator on a chart keeps its old settings), or change them in its ⚙ Settings.</li>' +
        '<li>Go to a trade\'s date: <b>Alt+G</b>. Hover a BUY label for the entry / stop / target and the CHoCH it came from; "skip" = the Lab would skip that touch (hover for why).</li></ol>' +
        '<ul class="lab-pine-notes">' + SB.pine.notes(f).map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' +
        '<details' + (copied ? '' : ' open') + '><summary>Show the script</summary><textarea class="inp lab-pine-code" id="lab-pine-text" readonly spellcheck="false">' + esc(code) + '</textarea></details>' +
        (url ? '<p class="sub"><a href="' + url + '" download="' + esc(file) + '">Download it as ' + esc(file) + '</a></p>' : '');
      var ta = $('#lab-pine-text', box);
      if (!copied && ta) { ta.focus(); ta.select(); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(function () { show(true); }, function () { show(false); });
    else show(false);
  }

  function bindForm(el) {
    var host = $('#lab-form', el);
    host.addEventListener('change', function (e) {
      var k = e.target.getAttribute && e.target.getAttribute('data-k');
      if (!k) return;
      var f = readForm(el);
      saveForm(f);
      var inSec = SECTIONS.some(function (x) { return (x[2] || SHAPE_KEYS).indexOf(k) >= 0; });
      if (['stop', 'after', 'trail', 'emaSupport', 'mktIndex', 'fallN', 'structure', 'targetMode', 'group', 'swingMode', 'entry'].indexOf(k) >= 0 || inSec ||
          Object.keys(SMC).indexOf(k) >= 0) { SB.route(true); return; }   // other fields appear / the cards and "changed" counts follow
      var pl = $('#lab-plain', el);
      if (pl) pl.innerHTML = '<b>In plain words:</b> ' + esc(plain(f));
    });
    host.addEventListener('input', function () { saveForm(readForm(el)); var pl = $('#lab-plain', el); if (pl) pl.innerHTML = '<b>In plain words:</b> ' + esc(plain(readForm(el))); });
    // the folded sections remember whether they are open (this device)
    host.addEventListener('toggle', function (e) {
      var d = e.target, id = d && d.getAttribute && d.getAttribute('data-sec');
      if (!id) return;
      var o = openSet().filter(function (x) { return x !== id; });
      if (d.open) o.push(id);
      ui.store.set('lab:open', o);
    }, true);
    // my recommendations: fill the Spring boxes (every other rule of the form stays as it is)
    host.addEventListener('click', function (e) {
      var q = e.target.closest && e.target.closest('[data-quick]');
      if (q) {
        var qq = QUICK.filter(function (x) { return x.id === q.getAttribute('data-quick'); })[0];
        saveForm(Object.assign(readForm(el), qq.id === 'smc' ? SMC : qq.set));
        SB.route(true);
        return;
      }
      if (e.target.closest && e.target.closest('#lab-more-off')) {
        var g = readForm(el);
        SECTIONS.forEach(function (x) { (x[2] || SHAPE_KEYS).forEach(function (k) { g[k] = DEF[k]; }); });
        saveForm(g);
        SB.route(true);
        return;
      }
      var b = e.target.closest && e.target.closest('[data-rec],#lab-shape-off');
      if (!b) return;
      var f = readForm(el);
      SHAPE_KEYS.forEach(function (k) { f[k] = DEF[k]; });
      if (b.id !== 'lab-shape-off') {
        var r = RECS.filter(function (x) { return x.id === b.getAttribute('data-rec'); })[0];
        if (r) Object.keys(r.set).forEach(function (k) { f[k] = r.set[k]; });
      }
      saveForm(f);
      SB.route(true);
    });
    $('#lab-run', el).addEventListener('click', function () {
      var f = readForm(el);
      saveForm(f);
      var params = {};
      Object.keys(DEF).forEach(function (k) { if (k !== 'name') params[k] = f[k]; });
      if (!params.from) delete params.from;
      if (!params.to) delete params.to;
      if (!params.testFrom) delete params.testFrom;
      if (!params.valFrom) delete params.valFrom;
      var b = this;
      b.disabled = true;
      ask({ lab: { do: 'run', name: f.name, params: params } }).then(function (j) {
        b.disabled = false;
        ST.status = j; ST.err = '';
        paintStatus(el);
        poll(el, ST.gen);
      }, function (e) {
        b.disabled = false;
        ST.err = e && e.message || 'could not start the run';
        paintStatus(el);
      });
    });
    $('#lab-pine', el).addEventListener('click', function () { var f = readForm(el); saveForm(f); copyPine(f, $('#lab-pine-box', el)); });
    $('#lab-save', el).addEventListener('click', function () {
      var f = readForm(el);
      var name = window.prompt('Name of this preset', f.name || 'My idea');
      if (!name) return;
      f.name = name.slice(0, 60);
      var list = presets().filter(function (p) { return p.name !== f.name; }).concat([f]).slice(-30);
      ui.store.set('lab:presets', list);
      saveForm(f);
      SB.route(true);
    });
    var ps = $('#lab-preset', el);
    if (ps) ps.addEventListener('change', function () {
      var p = presets()[Number(ps.value)];
      if (p) { saveForm(Object.assign({}, DEF, p)); SB.route(true); }
    });
    var pd = $('#lab-preset-del', el);
    if (pd) pd.addEventListener('click', function () {
      var i = ps ? Number(ps.value) : NaN;
      if (!ps || ps.value === '' || !presets()[i]) { window.alert('Choose a preset in the list first.'); return; }
      if (!window.confirm('Delete the preset "' + presets()[i].name + '"?')) return;
      ui.store.set('lab:presets', presets().filter(function (_, k) { return k !== i; }));
      SB.route(true);
    });
    $('#lab-reset', el).addEventListener('click', function () {
      if (!window.confirm('Put every rule back to the default (stop below the zone, 2R, then trail under the last 2 lows)?')) return;
      saveForm(Object.assign({}, DEF));
      SB.route(true);
    });
  }

  SB.page('lab', {
    noPriceRedraw: true,                       // new prices do not change this page (app.js rerender skips it)
    render: function (el, params) {
      ST.gen++;
      stopPoll();
      var head = '<div class="page-head"><div><h1>Backtest Lab</h1><p>Test <b>your own</b> trade rules on every FVG+Spring / Gap-up FVG + Spring ' +
        'signal of the last ~20 years: where the stop goes, the target, how the stop trails after it, how many days you hold, your risk and ' +
        'your account. Your laptop does the work on its Kite candles; the result comes back here in a minute.</p></div></div>';
      var sync = SB.wlSync;
      if (!sync || (SB.apiBase && SB.apiBase() == null)) {
        el.innerHTML = head + '<section class="card"><p class="empty">The Backtest Lab needs the live website (it talks to your sheet and your laptop).</p></section>';
        return;
      }
      if (!sync.hasPin() || !sync.status().linked) {
        el.innerHTML = head + '<section class="card"><p class="note">For you only: type your <b>My Watchlists PIN</b> once on this device ' +
          '(<a href="#lists">My Watchlists → Sync with my sheet</a>) - then this page opens. The Kite candles and the trade list stay private.</p></section>';
        return;
      }
      var f = form();
      el.innerHTML = head + '<div id="lab-status" class="lab-status"></div>' + formHtml(f) +
        '<section class="card"><div class="card-head"><div><h2>Your runs</h2><p>The newest 8 are kept in your sheet (tab Backtest_Lab). Open one to see it.</p></div></div>' +
        '<div id="lab-runs"><p class="empty">Loading…</p></div></section><div id="lab-result"></div>';
      bindForm(el);
      paintStatus(el);
      var gen = ST.gen;
      var want = params && params[0];
      ask({ lab: { do: 'status' } }).then(function (j) {
        if (gen !== ST.gen) return;
        ST.status = j;
        paintStatus(el);
        paintRuns(el);
        var id = want || (j.list && j.list[0] && j.list[0].id);
        if (id && ST.item && ST.item.id === id) { ST.itemId = id; paintRuns(el); paintResult(el); } else if (id) openRun(el, id);
        if (j.job && (j.job.status === 'waiting' || j.job.status === 'running')) poll(el, gen);
      }, function (e) {
        if (gen !== ST.gen) return;
        ST.err = e && e.message || 'the sheet could not be reached';
        paintStatus(el);
        paintRuns(el);
      });
    }
  });

  SB.lab = { plain: plain, DEF: DEF };
})();
