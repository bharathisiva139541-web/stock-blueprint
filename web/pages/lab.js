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
  /** The bullish pattern engine's registry (web/data/pattern-registry.js = pattern_registry.py; owner, 13-Nov-2026). */
  function patReg() { return (window.SB_PATTERNS && window.SB_PATTERNS.patterns) || []; }
  function patOf(id) { return patReg().filter(function (p) { return p.id === id; })[0] || null; }

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
    // the owner's stop / target / exit options (13-Nov-2026: "stoploss ATR based ... Multiples of ATR whichever is lower ... Our exit
    // and target system should have more options"): the ATR stop, a % target, part sold at the target, the stop to the entry at
    // xR, a time stop
    stopAtr: 0, targetPct: 20, partialPct: 0, beAt: 0, timeN: 0, timeR: 1,
    // the Pattern library (owner, 13-Nov-2026 - the bullish pattern engine, M1): the pattern + its own parameters
    // (= pcbridge/ScreenerBridge/pattern_registry.py SPECS params)
    pattern: 'K08', engBody: 0, boBuf: 0, boVol: 0, rsiN: 14, divPivot: 5, divMaxGap: 60, divRsiMax: 100,
    // phase 2 (13-Nov-2026): a reversal pattern anywhere / only after a fall (= backtest_lab patCtx)
    patCtx: 'any',
    // phase 3 (13-Nov-2026): the swing size of the structure / SMC patterns (candles each side, = backtest_lab patSwing)
    patSwing: 5,
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
    discountMax: 0, lagMin: 0, dispAtr: 0, dispVol: 0, whereIn: 'any', wkAbove: 0, atrK: 3, valFrom: '', rollYears: 3,
    // the owner's refinements after his first charts PDF (12-Nov-2026): the zone's size (STUDDS: "control in FVG % size from 2%
    // to 10%"), the stop under the CHoCH's final low, the target lock (SIGNPOST: "should be considered as Win" - "Target தொட்டதும்
    // stop = target"), the order at the Gap-up zone top inside an FVG (GABRIEL), a zone short of the discount line but under the
    // CHoCH level (SWIGGY), a Spring / Harami + Inverted Hammer at the zone's Fib line (FINOPB), dark-cloud FVGs (RTNPOWER)
    zoneMin: 0, zoneMax: 0, lockTarget: true, gapEntry: true, lineOk: false, lineTol: 0.5, fibPat: 'off', fibLevel: 0.618, fibTol: 1,
    darkCloud: 'any',
    // owner, 12-Nov-2026: "No trade only on 2nd FVG. 1st FVG can be watched but not to be traded" (on by default, like the laptop's
    // DEFAULTS) + "In the move of Choch, volumes are at least twice ... Add this option" (off)
    zonePick: 'second', moveVol: 0, moveVolN: 1,
    // owner, 13-Nov-2026 (SWIGGY): "1st one is already mitigated before Choch move, we can take in this FVG even if this FVG mitigated
    // before the Choch Move" - a zone touched before the CHoCH counts again after it (on by default, like the laptop's DEFAULTS)
    touchAgain: true,
    // BOS + FVG setups (owner, 13-Nov-2026: "Shall we track BOS setup like this. like FVG Zone at discount level in the BOS move ...
    // It can be a continuous BOS in uptrend. or BOS formed after Choch" -> "yes. implement all you recommendations"): the structure
    // rules on the BOS move (from its higher low to its high) instead of the CHoCH move (= backtest_lab setup / bosKind / upN)
    setup: 'choch', bosKind: 'both', upN: 1,
    // the lower-timeframe confirmation (owner, 13-Nov-2026: "If any Choch has happened inside the Zone in 15 min, then i decided to
    // buy"; my recommendations: 3 candles a swing, 2 lower highs / lows, wait 5 candles, buy at its close, stop under its final low)
    // - off by default (= backtest_lab ltf...)
    ltf: 'off', ltfPivot: 3, ltfDown: 2, ltfWait: 5, ltfUnder: 0.5, ltfEntry: 'close', ltfStop: 'ltf',
    // the small CHoCH above the protected high (owner, 14-Nov-2026: "also add above the protected high in lowertimeframe also")
    ltfChoch: 'last'
  };
  // ready setups for the "Start here" cards (owner, 12-Nov-2026: "make bactest lab more user-friendly not to be complex")
  var QUICK = [
    { id: 'smc', name: 'My CHoCH + FVG setup', why: 'After lower highs and lower lows a candle closes above the last lower high (CHoCH); the first time price comes back to a zone in the discount half of that move = buy at the zone top, stop under the zone.' },
    { id: 'bos', name: 'My BOS + FVG setup', why: 'In an up-trend (or right after a CHoCH) a candle closes above the last higher high (BOS); the first time price comes back to a zone in the discount half of that BOS move (from its higher low) = buy at the zone top, stop under the zone.' },
    // owner, 14-Nov-2026: "if i want to run CHoch+FVG, BOS+FVG at a same time, there is no option"
    { id: 'both', name: 'CHoCH + FVG and BOS + FVG together', why: 'Both of your setups in one run: every zone touch is checked as CHoCH + FVG first, then as BOS + FVG - one trade a candle; the result splits them ("What worked best" → Setup).' },
    { id: 'fvg', name: 'FVG + Spring', why: 'A Spring candle on a 3-candle FVG zone (anywhere on it or under its bottom); buy at the Spring candle\'s close, stop under the zone.',
      set: { group: 'fvg', structure: 'off', entry: 'close', stop: 'zone', discount: 0 } },
    { id: 'gap', name: 'Gap-up FVG + Spring', why: 'The same on a Gap-up zone (a gap between two candles); buy at the Spring candle\'s close, stop under the zone.',
      set: { group: 'gap', structure: 'off', entry: 'close', stop: 'zone', discount: 0 } }
  ];
  // the folded "More rules" sections: the keys each one holds (its header counts the ones you changed)
  var SECTIONS = [
    ['structure', 'Market structure - CHoCH / BOS setups', ['structure', 'setup', 'bosKind', 'upN', 'pivotN', 'downN', 'zoneWhen', 'chochAge', 'discount', 'discPart', 'belowChoch', 'firstPull',
      'lineOk', 'lineTol', 'zonePick', 'touchAgain', 'swingMode', 'zzAtr', 'swingAtr', 'chochMode', 'eqAtr', 'discountMax', 'lagMin', 'dispAtr', 'dispVol', 'sweep',
      'moveVol', 'moveVolN']],
    ['shape', 'Spring candle shape', null],
    ['trend', 'Trend filters - EMA, weekly trend, market', ['emaSupport', 'emaTouch', 'above10', 'above21', 'above50', 'emaStack', 'wkAbove', 'mktIndex', 'mktAbove', 'mktStack']],
    ['zone', 'Zone rules - size, Gap-up zone inside, Fib + pattern, dark cloud', ['zoneMin', 'zoneMax', 'gapEntry', 'fibPat', 'fibLevel', 'fibTol', 'darkCloud']],
    ['ltf', 'Confirmation on a lower timeframe - a small CHoCH in the zone (15m / 1H / daily)', ['ltf', 'ltfPivot', 'ltfDown', 'ltfChoch', 'ltfWait', 'ltfUnder', 'ltfEntry', 'ltfStop']],
    ['entry', 'Entry details', ['entry', 'maxRisk', 'whereIn', 'from', 'to', 'minPrice', 'minTurnover', 'maxTouch']],
    ['exit', 'Exit details - part at the target, stop to entry, time stop', ['partialPct', 'beAt', 'timeN', 'timeR', 'breakeven', 'lockTarget', 'maxDays', 'cost']],
    ['money', 'Money details', ['maxPosPct', 'maxOpen', 'compound']],
    ['check', 'Checking the result - validation part, steady over time', ['valFrom', 'rollYears']]
  ];
  // the owner's CHoCH + FVG setup in one click (his answers of 10-Nov-2026, and 11-Nov-2026: the discount half of the move
  // instead of "below the CHoCH level", the first return to that zone = the signal, a buy order at the zone top)
  var SMC = { group: 'touch', structure: 'only', pivotN: 5, downN: 3, zoneWhen: 'both', belowChoch: false, discount: 0.5, discPart: 'mid',
    firstPull: true, chochAge: 0, stop: 'zone', entry: 'zone', zonePick: 'second', touchAgain: true, setup: 'choch' };
  // the same on the BOS move (13-Nov-2026): every BOS - the first after a CHoCH and the ones of a running up-trend
  var BOSSET = Object.assign({}, SMC, { setup: 'bos', bosKind: 'both', upN: 1 });
  var BOTHSET = Object.assign({}, BOSSET, { setup: 'both' });
  function quickSet(id) { return id === 'smc' ? SMC : id === 'bos' ? BOSSET : id === 'both' ? BOTHSET : QUICK.filter(function (x) { return x.id === id; })[0].set; }
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
      ['touch', 'First touch of a zone - every FVG / Gap-up zone (your SMC entry)'], ['spring', 'Every Spring (no zone - to compare)'],
      ['pattern', 'Pattern library (new engine) - pick the pattern below']],
    pattern: patReg().filter(function (p) { return p.status === 'implemented'; }).map(function (p) { return [p.id, p.id + ' · ' + p.name]; }),
    engBody: [[0, 'Any size'], [0.5, 'At least 0.5 x ATR'], [1, 'At least 1 x ATR'], [1.5, 'At least 1.5 x ATR'], [2, 'At least 2 x ATR']],
    boBuf: [[0, 'Just above it'], [0.5, '0.5% above it'], [1, '1% above it'], [2, '2% above it'], [3, '3% above it']],
    boVol: [[0, 'Not checked'], [1.5, 'At least 1.5 x the 20-candle average'], [2, 'At least 2 x the 20-candle average'], [3, 'At least 3 x the 20-candle average']],
    divPivot: [[3, '3 candles each side'], [5, '5 candles each side'], [8, '8 candles each side'], [10, '10 candles each side']],
    divMaxGap: [[30, 'At most 30 candles apart'], [60, 'At most 60 candles apart'], [100, 'At most 100 candles apart'], [150, 'At most 150 candles apart']],
    divRsiMax: [[100, 'Any RSI'], [30, 'RSI at most 30 (oversold)'], [40, 'RSI at most 40'], [50, 'RSI at most 50']],
    patCtx: [['any', 'Anywhere'], ['down', 'Only after a fall (under a falling 20-SMA)']],
    patSwing: [[2, '2 candles each side'], [3, '3 candles each side'], [5, '5 candles each side'], [8, '8 candles each side'], [10, '10 candles each side']],
    // the Pattern library's stop (owner, 13-Nov-2026: "confusing to use stoplosses for patterns. stop loss using zone FVG Zone
    // bottom is irrelevant here") - a pattern has no zone: its own low, the signal candle's low or a % (the CHoCH's final low
    // only when the market structure is on)
    stopPat: [['zone', 'Under the pattern\'s low (the lowest point of its candles)'], ['spring', 'Under the signal candle\'s low'],
      ['pct', '% under the entry'], ['final', 'Under the CHoCH\'s final low']],
    structure: [['off', 'Off - do not look at it'], ['show', 'Show it on every trade (nothing left out) - to compare'], ['only', 'Only my setup (the rules below)']],
    setup: [['choch', 'CHoCH + FVG - the zone of the move that turned a downtrend'], ['bos', 'BOS + FVG - the zone of a BOS move (a higher high broken)'],
      ['both', 'CHoCH + FVG and BOS + FVG together']],
    bosKind: [['both', 'Every BOS - the 1st after a CHoCH and the ones of a running up-trend'], ['first', 'Only the 1st BOS after a CHoCH'],
      ['trend', 'Only BOS of a running up-trend (not the 1st after a CHoCH)']],
    upN: [[1, 'At least 1 (any BOS)'], [2, 'At least 2'], [3, 'At least 3'], [4, 'At least 4']],
    ltf: [['off', 'Off - buy as the setup says'], ['D', 'The daily chart (a weekly run)'], ['1H', 'The 1-hour chart'], ['15m', 'The 15-minute chart']],
    ltfPivot: [[2, '2 candles each side'], [3, '3 candles each side'], [4, '4 candles each side'], [5, '5 candles each side']],
    ltfDown: [[1, 'At least 1'], [2, 'At least 2'], [3, 'At least 3'], [4, 'At least 4']],
    ltfWait: [[1, 'Only in the signal candle'], [2, 'Within 2 candles'], [3, 'Within 3 candles'], [5, 'Within 5 candles'], [10, 'Within 10 candles']],
    ltfUnder: [[0, 'Inside the zone only'], [0.5, 'Up to 0.5% under its bottom'], [1, 'Up to 1% under it'], [2, 'Up to 2% under it'], [5, 'Up to 5% under it'],
      [100, 'Any depth (the chart\'s close decides)']],
    ltfEntry: [['close', 'At the small CHoCH candle\'s close'], ['fvg', 'An order at the top of the small FVG of its move (retest)'],
      ['smart', 'Smart: CHoCH in the zone → its close; above the zone → the small FVG top, else the 50% line (retest)']],
    ltfStop: [['ltf', 'Under the small final low (the stop buffer above)'], ['rule', 'The stop loss chosen above (e.g. under the zone)']],
    ltfChoch: [['last', 'Above the last small swing high (usual)'], ['protected', 'Above the protected high - the small swing high right before the lowest low']],
    pivotN: [[2, '2 candles each side'], [3, '3 candles each side'], [5, '5 candles each side'], [8, '8 candles each side'], [10, '10 candles each side']],
    downN: [[1, 'At least 1'], [2, 'At least 2'], [3, 'At least 3'], [4, 'At least 4'], [5, 'At least 5']],
    zoneWhen: [['both', 'In the CHoCH move or after it'], ['leg', 'Only in the CHoCH move'], ['after', 'Only after the CHoCH candle']],
    chochAge: [[0, 'Any time after it'], [10, 'Within 10 candles'], [20, 'Within 20 candles'], [40, 'Within 40 candles'], [60, 'Within 60 candles'], [120, 'Within 120 candles']],
    targetMode: [['R', 'R multiple (times the risk)'], ['pct', '% above the entry'], ['mh', 'The CHoCH / BOS move high (HH)'], ['swing', 'The last swing high']],
    stopAtr: [[0, 'Off - only the stop above'], [1, '1 x ATR'], [1.5, '1.5 x ATR'], [2, '2 x ATR'], [2.5, '2.5 x ATR'], [3, '3 x ATR'], [4, '4 x ATR']],
    targetPct: [[10, '10% above the entry'], [15, '15% above the entry'], [20, '20% above the entry'], [25, '25% above the entry'], [30, '30% above the entry'],
      [40, '40% above the entry'], [50, '50% above the entry'], [75, '75% above the entry'], [100, '100% above the entry']],
    partialPct: [[0, 'Off - the whole position'], [25, 'Sell 25% there'], [33, 'Sell a third (33%) there'], [50, 'Sell half (50%) there'], [75, 'Sell 75% there']],
    beAt: [[0, 'Off'], [0.5, 'When price is 0.5R up'], [1, 'When price is 1R up'], [1.5, 'When price is 1.5R up']],
    timeN: [[0, 'Off'], [3, 'After 3 candles'], [5, 'After 5 candles'], [10, 'After 10 candles'], [15, 'After 15 candles'], [20, 'After 20 candles'], [30, 'After 30 candles']],
    timeR: [[0.5, '… not 0.5R up yet'], [1, '… not 1R up yet'], [1.5, '… not 1.5R up yet'], [2, '… not 2R up yet']],
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
    zonePick: [['second', 'Trade the 2nd - the 1st only watched (your rule)'], ['every', 'Trade every zone\'s first touch']],
    moveVol: [[0, 'Not checked'], [1.5, 'A candle with 1.5 x the volume before the move'], [2, 'A candle with 2 x the volume before the move'],
      [3, 'A candle with 3 x the volume before the move'], [5, 'A candle with 5 x the volume before the move']],
    moveVolN: [[1, 'At least 1 such candle'], [2, 'At least 2 such candles'], [3, 'At least 3 such candles'], [5, 'At least 5 such candles']],
    whereIn: [['any', 'Anywhere in the zone (or under it)'], ['tm', 'Only the top or middle of the zone'], ['t', 'Only the top half of the zone']],
    wkAbove: [[0, 'Off'], [10, 'Above its 10-week EMA'], [21, 'Above its 21-week EMA'], [50, 'Above its 50-week EMA']],
    rollYears: [[0, 'Off'], [1, 'Every year'], [2, 'Every 2 years'], [3, 'Every 3 years'], [5, 'Every 5 years']],
    discPart: [['mid', 'Its middle (part of it may be above the line)'], ['top', 'All of it (its top)'], ['bottom', 'Any part of it (its bottom)']],
    entry: [['close', 'At the signal candle\'s close'], ['next_open', 'At the next candle\'s open'],
      ['zone', 'An order waiting at the zone top (first-touch signals)']],
    stop: [['zone', 'A little below the FVG / Gap-up zone bottom'], ['spring', 'A little below the Spring candle\'s low'],
      ['lower', 'A little below whichever is lower'], ['pct', 'A fixed % below the entry'], ['final', 'A little below the CHoCH\'s final low (LL) / the BOS move\'s higher low (HL)']],
    zoneMin: [[0, 'No minimum'], [1, 'At least 1%'], [1.5, 'At least 1.5%'], [2, 'At least 2%'], [3, 'At least 3%'], [4, 'At least 4%']],
    zoneMax: [[0, 'No limit'], [4, 'At most 4%'], [5, 'At most 5%'], [6, 'At most 6%'], [8, 'At most 8%'], [10, 'At most 10%'], [12, 'At most 12%'], [15, 'At most 15%']],
    fibPat: [['off', 'Off - buy at the zone top as usual'], ['big', 'In zones bigger than "at most" (the rest at the zone top)'], ['all', 'In every zone (no zone-top orders)']],
    fibLevel: [[0.5, 'The 50% line'], [0.618, 'The 61.8% line'], [0.705, 'The 70.5% line'], [0.786, 'The 78.6% line']],
    fibTol: [[0.5, 'Within 0.5%'], [1, 'Within 1%'], [1.5, 'Within 1.5%'], [2, 'Within 2%'], [3, 'Within 3%']],
    darkCloud: [['any', 'Take them like the others'], ['exclude', 'Leave them out'], ['only', 'Only these (to compare)']],
    lineTol: [[0, 'Exactly at / under the line'], [0.5, 'Up to 0.5% above it'], [1, 'Up to 1% above it'], [2, 'Up to 2% above it']],
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
  var NUMS = ['minPrice', 'minTurnover', 'maxTouch', 'stopBuf', 'stopPct', 'maxRisk', 'targetR', 'stopAtr', 'targetPct', 'partialPct', 'beAt', 'timeN', 'timeR',
    'engBody', 'boBuf', 'boVol', 'rsiN', 'divPivot', 'divMaxGap', 'divRsiMax', 'patSwing', 'trailN', 'trailPct', 'emaN', 'maxDays',
    'cost', 'capital', 'riskPct', 'maxPosPct', 'maxOpen', 'emaSupport', 'emaTouch', 'mktAbove',
    'upWickMax', 'loWickMin', 'closeMin', 'c2BodyMin', 'c2BodyMax', 'undercutMin', 'undercutMax', 'undAtr', 'closeAbove',
    'c1BodyMin', 'c1LoWickMax', 'c1Atr', 'lowestN', 'fallN', 'fallPct', 'pivotN', 'downN', 'chochAge', 'swingMinR', 'discount',
    'zzAtr', 'swingAtr', 'eqAtr', 'discountMax', 'lagMin', 'dispAtr', 'dispVol', 'wkAbove', 'atrK', 'rollYears',
    'zoneMin', 'zoneMax', 'lineTol', 'fibLevel', 'fibTol', 'moveVol', 'moveVolN', 'upN', 'ltfPivot', 'ltfDown', 'ltfWait', 'ltfUnder'];
  // the first market-structure rule a signal failed (= backtest_lab.py STRUCT_WHY) and the stages (structure.py)
  var STRUCT_WHY = { nochoch: 'no live CHoCH before it', zone: 'its zone did not form in the CHoCH move / after it',
    bos: 'a BOS came first (not the first pullback)', above: 'its zone is not below the CHoCH level',
    premium: 'its zone was not in the discount part of the move (above your Fib line)',
    deep: 'its zone was deeper in the move than your "at most" level', early: 'it came sooner after the CHoCH than your minimum days',
    disp: 'the CHoCH candle\'s body was smaller than your ATR rule', vol: 'the CHoCH candle\'s volume was under your rule',
    sweep: 'the final low did not sweep the low before it',
    zone1: 'the 1st (higher) of two discount zones of the move - only watched, the trade is on the 2nd',
    zone3: 'a 3rd (or deeper) discount zone of the move - only the 2nd is traded',
    mvol: 'no big-volume candle (your rule) in the CHoCH move',
    // the owner's rules of 13-Nov-2026 (always on with "Only my setup")
    abovechoch: 'its zone was wholly above the CHoCH level', swing: 'its zone did not form in the swing from the final low to the move high',
    premfast: 'a premium zone (above your Fib line) with the signal 4 days or less after the CHoCH',
    deepclose: 'a candle closed under the middle of its zone before the move high',
    mitig: 'more than 2 candles touched its zone before the move high',
    zone1mit: 'the 1st (watched) zone was touched before the move high' };
  var STAGE = { disc: ['Discount, 1st pullback', 's-good'], below: ['Below CHoCH, 1st pullback', 's-good'], prem: ['Premium (above the Fib line)', 's-warn'],
    above: ['At / above CHoCH level', 's-warn'], bos: ['After a BOS', 's-bad'], old: ['Zone older than the CHoCH low', 's-info'], none: ['No CHoCH', ''] };
  // a BOS + FVG run (13-Nov-2026): the same stages on the BOS move
  var STAGE_BOS = { disc: ['Discount, 1st pullback', 's-good'], below: ['Below BOS, 1st pullback', 's-good'], prem: ['Premium (above the Fib line)', 's-warn'],
    above: ['At / above BOS level', 's-warn'], bos: ['After the next BOS', 's-bad'], old: ['Zone older than the BOS higher low', 's-info'], none: ['No BOS', ''] };
  function stageOf(key, p) { return ((p && p.setup === 'bos') ? STAGE_BOS : STAGE)[key]; }
  /** A structure text of the CHoCH setup in the words of a BOS run ('CHoCH' -> 'BOS', its final low -> the higher low). */
  function evWords(txt, p) {
    if (!(p && p.setup === 'bos')) return txt;
    return String(txt).replace(/the final low to the move high/g, 'the higher low to the move high').replace(/final low/g, 'higher low')
      .replace(/a BOS came first/g, 'the next BOS came first').replace(/no BOS yet/g, 'no next BOS yet').replace(/CHoCH/g, 'BOS');
  }
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
    lock: ['Target locked (the stop at the target)', 's-good'],
    ema: ['Close under EMA', 's-good'], tstop: ['Time stop (no move)', 's-info'], time: ['Time limit', 's-info'], open: ['Still running', 's-warn'] };
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
    if (p.setup === 'both') {               // owner, 14-Nov-2026: both setups in one run
      return 'Two setups together - every zone touch is checked as CHoCH + FVG first, then as BOS + FVG (one trade a candle). CHoCH + FVG: ' +
        structWords(Object.assign({}, p, { setup: 'choch' })) + ' BOS + FVG: ' + bosWords(Object.assign({}, p, { setup: 'bos' }));
    }
    if (p.setup === 'bos') return bosWords(p);
    var head = 'Market structure (swings of ' + p.pivotN + ' candles each side): a CHoCH = a candle closing above the last swing high after at least ' +
      p.downN + ' lower highs and ' + p.downN + ' lower lows';
    if (p.structure === 'show') return head + engineWords(p) + ' - shown on every trade, nothing left out.';
    var w = ['the zone formed after the CHoCH\'s final low, ' + (p.zoneWhen === 'leg' ? 'in the move that made the CHoCH' : p.zoneWhen === 'after' ? 'after the CHoCH candle' : 'in the CHoCH move or after it')];
    if (Number(p.discount)) {
      w.push((p.discPart === 'top' ? 'all of the zone' : p.discPart === 'bottom' ? 'some of the zone' : 'the zone\'s middle') + ' (no zone: the entry) at least ' +
        pc(Number(p.discount) * 100) + '% down the move from the CHoCH\'s final low to its high before the signal - the discount' +
        (Number(p.discount) === 0.5 ? ' half' : ' part'));
    }
    if (p.lineOk && Number(p.discount)) w.push('a zone short of that line counts too when its top is at or under the CHoCH level' + (Number(p.lineTol) ? ' (up to ' + pc(p.lineTol) + '% above it)' : ''));
    if (p.belowChoch) w.push('the zone (no zone: the entry) below the CHoCH level');
    if (p.firstPull) w.push('the first pullback - no BOS (a close above the highest swing high since the CHoCH) yet');
    if (Number(p.chochAge)) w.push('at most ' + p.chochAge + ' candles after the CHoCH');
    if (Number(p.discountMax)) w.push('the zone at most ' + pc(Number(p.discountMax) * 100) + '% down the move');
    if (Number(p.lagMin)) w.push('at least ' + p.lagMin + ' days after the CHoCH candle');
    if (Number(p.dispAtr)) w.push('the CHoCH candle\'s body at least ' + pc(p.dispAtr) + ' x ATR');
    if (Number(p.dispVol)) w.push('the CHoCH candle\'s volume at least ' + pc(p.dispVol) + ' x its 20-candle average');
    if (p.sweep) w.push('the final low swept the swing low before it and closed back above it');
    if (Number(p.moveVol)) w.push('in the CHoCH move (final low to the CHoCH candle) at least ' + (Number(p.moveVolN) || 1) + ' candle' + ((Number(p.moveVolN) || 1) === 1 ? '' : 's') +
      ' with ' + pc(p.moveVol) + ' x the average volume of the 20 candles before the move');
    w.push('the CHoCH still alive (no close under its final low)');
    // the owner's rules of 13-Nov-2026 - always part of "Only my setup"
    w.push('the zone not wholly above the CHoCH level and formed in the one swing from the final low to the move high');
    w.push('before the move high at most 2 candles touched the zone and none closed under its middle');
    w.push('no premium zone (above the Fib line) when the signal comes 4 days or less after the CHoCH');
    if (p.group === 'touch') {
      w.push(p.touchAgain === false ? 'a zone price touched before the CHoCH does not count again' :
        'a zone price already touched before the CHoCH (while the rise was forming) counts again - its first touch after the CHoCH');
    }
    w.push(p.zonePick === 'every' ? 'every discount zone\'s first touch is a trade' :
      'when the move has two discount zones, the one price reaches first (the higher) is only watched and the trade is on the 2nd (a 3rd is not traded)');
    return head + engineWords(p) + '. Only signals where ' + w.join('; ') + '.';
  }

  /** The BOS + FVG setup in words (13-Nov-2026): the CHoCH rules said of the BOS move. */
  function bosWords(p) {
    var kind = p.bosKind === 'first' ? 'the 1st BOS after a CHoCH (after at least ' + p.downN + ' lower highs and lower lows)' :
      p.bosKind === 'trend' ? 'a BOS of a running up-trend (at least ' + (Number(p.upN) || 1) + ' higher high' + ((Number(p.upN) || 1) === 1 ? '' : 's') + ' and higher low' + ((Number(p.upN) || 1) === 1 ? '' : 's') + ', not the 1st after a CHoCH)' :
        'every BOS - the 1st after a CHoCH (' + p.downN + ' lower highs / lows before it) and the ones of a running up-trend' + ((Number(p.upN) || 1) > 1 ? ' (at least ' + p.upN + ' higher highs / lows)' : '');
    var head = 'BOS + FVG (swings of ' + p.pivotN + ' candles each side): a BOS = a candle closing above the last swing high when that high was a higher high ' +
      'and the pullback since it a higher low; ' + kind + '; the BOS move = from that higher low to the highest high before the signal';
    if (p.structure === 'show') return head + engineWords(p) + ' - shown on every trade, nothing left out.';
    // the CHoCH sentences say the same of the BOS move
    var chochPart = structWords(Object.assign({}, p, { setup: 'choch' }));
    var rest = chochPart.slice(chochPart.indexOf('. Only signals where ') + 2);
    return head + engineWords(p) + '. ' + evWords(rest, p);
  }

  /** The lower-timeframe confirmation in words ('' when off). */
  function ltfWords(p) {
    if (!p.ltf || p.ltf === 'off') return '';
    var tfw = choiceLabel('tf', p.tf).toLowerCase().replace(/ \(.*\)/, '');
    if (p.ltfEntry === 'smart') {
      return 'Confirmation on the ' + (LTF_NAME[p.ltf] || p.ltf) + ' chart: after the signal, wait up to ' + p.ltfWait + ' ' + tfw + ' candle' + (Number(p.ltfWait) === 1 ? '' : 's') +
        ' for a CHoCH there (swings of ' + p.ltfPivot + ' candles, at least ' + p.ltfDown + ' lower highs and lower lows' + (p.ltfChoch === 'protected' ? ', a close above the protected high' : '') +
        '; its final low anywhere). Smart buy: its level at / under the ' +
        'zone top → at its close; above the zone → an order at the top of its highest small FVG, else at the 50% line of its move. Stop: a buy above the zone → a little under ' +
        'the small final low, in the zone → as set above. The order is cancelled when a ' + tfw + ' closes under the zone, and missed when price reaches the target first.';
    }
    return 'Confirmation on the ' + (LTF_NAME[p.ltf] || p.ltf) + ' chart: after the signal, wait up to ' + p.ltfWait + ' ' + tfw + ' candle' + (Number(p.ltfWait) === 1 ? '' : 's') +
      ' for a CHoCH there (swings of ' + p.ltfPivot + ' candles, at least ' + p.ltfDown + ' lower highs and lower lows' + (p.ltfChoch === 'protected' ? ', a close above the protected high' : '') +
      ') whose final low is in the zone' +
      (Number(p.ltfUnder) >= 100 ? ' or anywhere under it' : Number(p.ltfUnder) ? ' (at most ' + pc(p.ltfUnder) + '% under its bottom)' : '') + '; buy ' +
      (p.ltfEntry === 'fvg' ? 'with an order at the top of the small FVG of that move when price comes back to it' : 'at the close of that CHoCH candle') +
      '; stop ' + (p.ltfStop === 'rule' ? 'as set above' : 'a little under that small final low') + '. No small CHoCH in time, or a ' + tfw +
      ' close under the zone first = no trade.';
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

  /** The zone rules of 12-Nov-2026 in words ('' when all are at their defaults - the Gap-up zone entry is on by default). */
  function zoneWords(p) {
    var w = [];
    if (Number(p.zoneMin) || Number(p.zoneMax)) {
      w.push('Only zones ' + (Number(p.zoneMax) ? pc(p.zoneMin || 0) + '% to ' + pc(p.zoneMax) + '%' : 'at least ' + pc(p.zoneMin) + '%') +
        ' tall (top - bottom, % of the bottom)' + (p.fibPat === 'big' ? ' - bigger ones by the pattern at their Fib line' : '') + '.');
    }
    if (p.gapEntry && (p.group === 'touch')) w.push('An FVG with a Gap-up zone inside it: the order waits at the Gap-up zone\'s top, the stop stays under the FVG\'s bottom.');
    if (!p.gapEntry && p.group === 'touch') w.push('An FVG with a Gap-up zone inside it: bought at the FVG top as usual.');
    if (p.fibPat === 'big' || p.fibPat === 'all') {
      w.push((p.fibPat === 'big' ? 'In zones bigger than your limit' : 'In every zone') + ': no order at the zone top - wait for a Spring or a Bullish Harami + ' +
        'Inverted Hammer whose low is within ' + pc(p.fibTol) + '% of the zone\'s ' + pc(Number(p.fibLevel) * 100) + '% Fib line (drawn from the zone bottom to ' +
        'its top) and that closes above it; buy at its close, the stop under the zone bottom.');
    }
    if (p.darkCloud === 'exclude') w.push('FVGs whose 3rd candle is a dark cloud (red, opening over the green FVG candle\'s close, closing under the middle of its body) are left out.');
    if (p.darkCloud === 'only') w.push('Only FVGs whose 3rd candle is a dark cloud (to compare).');
    return w.join(' ');
  }

  /** The rules in plain words (shown above the Run button and with each result). */
  function plain(p) {
    var s = [];
    s.push((p.group === 'pattern' ? 'Pattern library: ' + patWords(p) : choiceLabel('group', p.group)) + ' on the ' + choiceLabel('tf', p.tf).toLowerCase() + ' chart' +
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
    var zw = zoneWords(p);
    if (zw) s.push(zw);
    var lw = ltfWords(p);
    if (lw) s.push(lw);
    s.push(p.entry === 'zone' ? 'Buy with an order waiting at the zone top - filled when price first comes down to it (at the open when it opened under the top); ' +
      'only first-touch signals, the stop always under the zone.' : 'Buy ' + (p.entry === 'close' ? 'at the signal candle\'s close' : 'at the next candle\'s open') + '.');
    var patRun = p.group === 'pattern';
    s.push('Stop loss ' + (p.stop === 'pct' ? F.num(p.stopPct, 2) + '% below the entry' :
      F.num(p.stopBuf, 2) + '% below ' + (patRun && (p.stop === 'zone' || p.stop === 'lower') ? 'the pattern\'s low (the lowest point of its candles)' :
        patRun && p.stop === 'spring' ? 'the signal candle\'s low' :
        p.stop === 'zone' ? 'the zone bottom' : p.stop === 'spring' ? 'the Spring candle\'s low' :
        p.stop === 'final' ? (p.setup === 'bos' && p.structure !== 'off' ? 'the BOS move\'s higher low (HL - no live BOS = no trade)' : 'the CHoCH\'s final low (LL - no live CHoCH = no trade)') :
        'the zone bottom or the Spring low, whichever is lower')) +
      (Number(p.stopAtr) ? ', or ' + F.num(p.stopAtr, 1) + ' x ATR(14) under the entry - whichever is lower (the wider stop)' : '') +
      (p.maxRisk ? ' - trades risking more than ' + F.num(p.maxRisk, 1) + '% are skipped' : '') + '.');
    var tgt = p.targetMode === 'swing' ? 'the last swing high (at least ' + F.num(p.swingMinR, 2) + 'R above the entry - none = no trade)' :
      p.targetMode === 'mh' ? 'the ' + (p.setup === 'bos' && p.structure !== 'off' ? 'BOS' : 'CHoCH') + ' move high - HH (at least ' + F.num(p.swingMinR, 2) + 'R above the entry - none = no trade)' :
        p.targetMode === 'pct' ? F.num(p.targetPct, 1) + '% above the entry' : F.num(p.targetR, 2) + 'R';
    var part = Number(p.partialPct) && p.after !== 'fixed' ? Number(p.partialPct) : 0;
    if (Number(p.beAt)) s.push('Before the target: once price is ' + F.num(p.beAt, 1) + 'R up, move the stop to the entry.');
    if (Number(p.timeN)) s.push('Time stop: if price has not gone ' + F.num(p.timeR, 1) + 'R up within ' + p.timeN + ' candles, sell at that candle\'s close.');
    if (p.after === 'fixed') s.push('Sell at ' + tgt + (p.targetMode === 'R' ? ' (' + F.num(p.targetR, 2) + ' x the risk)' : '') + '.');
    else {
      s.push('At ' + tgt + ' ' + (part ? 'sell ' + part + '% and for the rest ' : '') + (p.lockTarget ? 'move the stop up to the target (a fall back to it = sold there, a win), then ' :
        p.breakeven ? 'move the stop to the entry, then ' : 'keep the stop, then ') +
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

  /** The chosen Pattern library pattern in words (its name + the parameters that are not the default). */
  function patWords(p) {
    var e = patOf(p.pattern);
    var w = (p.pattern || '') + ' ' + (e ? e.name : '');
    var x = [];
    if (p.pattern === 'K08' && Number(p.engBody)) x.push('the green body at least ' + F.num(p.engBody, 1) + ' x ATR(14)');
    if (/^B0[1-4]$/.test(p.pattern)) {
      x.push(Number(p.boBuf) ? 'a close ' + F.num(p.boBuf, 1) + '% above the level' : 'a fresh close above the level');
      if (Number(p.boVol)) x.push('volume at least ' + F.num(p.boVol, 1) + ' x the 20-candle average');
    }
    var ks = e ? Object.keys(e.params || {}) : [];
    if (p.pattern === 'I01') {
      x.push('RSI(' + p.rsiN + '), swing lows of ' + p.divPivot + ' candles each side, at most ' + p.divMaxGap + ' candles apart' +
        (Number(p.divRsiMax) < 100 ? ', RSI at the 1st low at most ' + F.num(p.divRsiMax, 0) : '') + ' - the signal comes when the 2nd low is confirmed (' + p.divPivot + ' candles after it)');
    } else if (ks.indexOf('divPivot') >= 0) {
      x.push('swing lows of ' + p.divPivot + ' candles each side, at most ' + p.divMaxGap + ' candles apart - the signal comes when the 2nd low is confirmed (' + p.divPivot + ' candles after it)');
    }
    if (ks.indexOf('patSwing') >= 0) x.push('swings of ' + p.patSwing + ' candles each side - a swing counts only once ' + p.patSwing + ' candles after it');
    if (e && /NIFTY 50/.test(e.note || '')) x.push('against NIFTY 50 (its candles on your laptop)');
    if (e && e.ctx && p.patCtx === 'down') x.push('only after a fall - the candle before it closed under its falling 20-SMA');
    return w + (x.length ? ' (' + x.join(', ') + ')' : '');
  }

  /** The Pattern library's own fields (the basics, Pattern = "Pattern library"). */
  function patHtml(f) {
    var id = f.pattern, e = patOf(id);
    var h = field('Which pattern', patSelect(f.pattern), 'wide');
    if (e && e.ctx) h += field('Before the pattern', sel('patCtx', f.patCtx), 'wide');
    if (id === 'K08') h += field('Green candle body', sel('engBody', f.engBody));
    if (/^B0[1-4]$/.test(id)) h += field('Close above the level', sel('boBuf', f.boBuf)) + field('Volume on that candle', sel('boVol', f.boVol), 'wide');
    var ks = e ? Object.keys(e.params || {}) : [];
    if (ks.indexOf('patSwing') >= 0) h += field('Swings', sel('patSwing', f.patSwing));
    if (ks.indexOf('divPivot') >= 0) h += field('Swing lows', sel('divPivot', f.divPivot)) + field('The two lows', sel('divMaxGap', f.divMaxGap));
    if (ks.indexOf('divRsiMax') >= 0) h += field('At the 1st low', sel('divRsiMax', f.divRsiMax)) + num('rsiN', f.rsiN, 'RSI length', ' min="2" step="1"');
    var common = (window.SB_PATTERNS && window.SB_PATTERNS.common) || [];
    return h + (e && e.rules ? '<details class="lab-rules field wide"><summary>The exact rules of ' + esc(id + ' ' + e.name) + ' (version ' + e.version + ')</summary>' +
      (e.words ? '<p>' + esc(e.words) + '</p>' : '') + '<ol>' + e.rules.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ol>' +
      (common.length ? '<p class="sub">Shared definitions:</p><ul>' + common.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul>' : '') +
      '</details>' : '');
  }

  /** The implemented patterns, grouped by category (a long list - 192 after phase 4). */
  function patSelect(v) {
    var ps = patReg().filter(function (p) { return p.status === 'implemented'; });
    var cats = (window.SB_PATTERNS && window.SB_PATTERNS.categories) || {};
    var known = ps.some(function (p) { return p.id === v; });
    return '<select class="sel" data-k="pattern">' + (known ? '' : '<option value="' + esc(v) + '" selected>' + esc(v) + '</option>') +
      Object.keys(cats).map(function (c) {
        var inCat = ps.filter(function (p) { return p.category === c; });
        return inCat.length ? '<optgroup label="' + esc(cats[c]) + '">' + inCat.map(function (p) {
          return '<option value="' + esc(p.id) + '"' + (p.id === v ? ' selected' : '') + '>' + esc(p.id + ' · ' + p.name) + '</option>';
        }).join('') + '</optgroup>' : '';
      }).join('') + '</select>';
  }

  function sel(k, v, own) {
    var list = own || CHOICES[k];
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
  function secTitle(id) { return SECTIONS.filter(function (x) { return x[0] === id; })[0][1]; }
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
      (on ? field('Setups - tick one or both', '<div class="lab-checks" id="lab-setups">' +
          '<label class="lab-check"><input type="checkbox" data-setup="choch"' + (f.setup !== 'bos' ? ' checked' : '') + '> CHoCH + FVG - the zone of the move that turned a downtrend</label>' +
          '<label class="lab-check"><input type="checkbox" data-setup="bos"' + (f.setup === 'bos' || f.setup === 'both' ? ' checked' : '') + '> BOS + FVG - the zone of a BOS move (a higher high broken)</label></div>', 'wide') +
        (f.setup === 'bos' || f.setup === 'both' ? field('Which BOS', sel('bosKind', f.bosKind), 'wide') +
          (f.bosKind !== 'first' ? field('Higher highs and higher lows (a running up-trend)', sel('upN', f.upN)) : '') : '') +
        field('A swing high / low', sel('pivotN', f.pivotN)) +
        (f.setup !== 'bos' || f.bosKind !== 'trend' ? field('Lower highs and lower lows before the CHoCH', sel('downN', f.downN)) : '') +
        (only ? field('The zone formed', sel('zoneWhen', f.zoneWhen)) + field('The signal came', sel('chochAge', f.chochAge)) +
          field('Two discount zones in the move', sel('zonePick', f.zonePick), 'wide') +
          (f.group === 'touch' ? '<div class="field lab-checks">' + check('touchAgain', f.touchAgain, 'A zone price touched before the CHoCH (while the rise was forming) counts again after it') + '</div>' : '') +
          field('Discount: the zone at least', sel('discount', f.discount), 'wide') +
          (Number(f.discount) ? field('… judged on', sel('discPart', f.discPart)) : '') +
          '<div class="field lab-checks">' + check('belowChoch', f.belowChoch, 'Zone top below the CHoCH level (strict)') + check('firstPull', f.firstPull, 'First pullback only (no BOS yet)') + '</div>' +
          (Number(f.discount) ? '<div class="field lab-checks">' + check('lineOk', f.lineOk, 'A zone short of the discount line counts when its top is at / under the CHoCH level') + '</div>' +
            (f.lineOk ? field('… its top at most', sel('lineTol', f.lineTol)) : '') : '') : '') : '') +
      '</div>' +
      (on ? '<div class="lab-sub">How swings and the CHoCH are found (the usual = the frozen baseline)</div><div class="form-grid">' +
        field('Swings', sel('swingMode', f.swingMode)) + (f.swingMode === 'zigzag' ? field('… a turn of', sel('zzAtr', f.zzAtr)) : field('A swing must stand out by', sel('swingAtr', f.swingAtr))) +
        field('The CHoCH closes', sel('chochMode', f.chochMode), 'wide') + field('Equal highs / lows', sel('eqAtr', f.eqAtr)) + '</div>' : '') +
      (only ? '<div class="lab-sub">More structure rules (optional)</div><div class="form-grid">' +
        field('The zone at most', sel('discountMax', f.discountMax)) + field('Days after the CHoCH', sel('lagMin', f.lagMin)) +
        field('The CHoCH candle (displacement)', sel('dispAtr', f.dispAtr)) + field('… and its volume', sel('dispVol', f.dispVol)) +
        field('Volume in the CHoCH move', sel('moveVol', f.moveVol), 'wide') + (Number(f.moveVol) ? field('… how many', sel('moveVolN', f.moveVolN)) : '') +
        '<div class="field lab-checks">' + check('sweep', f.sweep, 'The final low swept the low before it (wick under, closed back above)') + '</div></div>' : '') +
      '<p class="sub">A swing high = a candle whose high is above the candles on both sides (known only after those candles closed - the backtest never looks ahead). ' +
      'CHoCH = the first candle that CLOSES above the last swing high after the lower highs and lower lows; BOS = after it, the first close above the highest swing high since. ' +
      'The move = from the CHoCH\'s final low to the highest high before the signal candle (what you draw the Fibonacci on at that moment): 50% down = its middle. ' +
      '"Show it on every trade" keeps every signal and adds a table "By market structure" to the result. ' +
      'ZigZag / "stand out by" / protected high / equal highs are other ways to find the swings and the CHoCH - try one at a time against the usual. ' +
      'BOS + FVG: the same rules on a BOS move - from the higher low before the break to the highest high since; the setup is over at a close under that higher low ' +
      'or at the next BOS. "The CHoCH" in the boxes above means the BOS then. Both ticked: every zone touch is checked as CHoCH + FVG first, then as BOS + FVG ' +
      '(one trade a candle) - the result splits them ("What worked best" → Setup). ' +
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

  var LTF_NAME = { D: 'daily', '1H': '1-hour', '15m': '15-minute' };
  var LTF_RANK = { '15m': 1, '1H': 2, '4H': 3, D: 4, W: 5 };
  /** The confirmation timeframes smaller than the run's chart. */
  function ltfChoices(f) { return CHOICES.ltf.filter(function (o) { return o[0] === 'off' || LTF_RANK[o[0]] < LTF_RANK[f.tf]; }); }

  /** Confirmation on a lower timeframe (owner, 13-Nov-2026). */
  function ltfHtml(f) {
    if (f.ltf !== 'off' && !(LTF_RANK[f.ltf] < LTF_RANK[f.tf])) f.ltf = 'off';     // a timeframe not smaller than the chart's
    var on = f.ltf !== 'off';
    var noZone = f.group === 'spring' || f.group === 'pattern';
    return '<div class="form-grid">' + field('After the signal, look at', sel('ltf', f.ltf, ltfChoices(f)), 'wide') +
      (on ? field('A swing on it', sel('ltfPivot', f.ltfPivot)) + field('Lower highs and lower lows before its CHoCH', sel('ltfDown', f.ltfDown)) +
        field('The small CHoCH closes', sel('ltfChoch', f.ltfChoch), 'wide') +
        field('Wait at most', sel('ltfWait', f.ltfWait)) + (f.ltfEntry === 'smart' ? '' : field('Its final low', sel('ltfUnder', f.ltfUnder), 'wide')) +
        field('Buy', sel('ltfEntry', f.ltfEntry), 'wide') + (f.ltfEntry === 'smart' ? '' : field('Stop loss', sel('ltfStop', f.ltfStop), 'wide')) : '') + '</div>' +
      (on && f.ltfEntry === 'smart' ? '<p class="note" id="lab-smart-note"><b>Smart buy:</b> the small CHoCH\'s level (the small high it broke) at / under the zone top → buy at its close. ' +
        'Above the zone → no chasing: an order at the top of the highest small FVG of its move, or - no small FVG - at the 50% line of that move (its final low to its high, ' +
        'fixed at the CHoCH). Its final low may be anywhere. The order waits to the end of "Wait at most"; a candle of your chart closing under the zone cancels it; ' +
        'the target reached first = missed. Stop: a buy above the zone → under the small final low; a buy in the zone → your stop (under the zone). ' +
        'Target: your R on that stop.</p>' : '') +
      (on && noZone ? '<p class="note warn">The confirmation needs a zone (FVG / Gap-up): pick a zone pattern above - "' + esc(choiceLabel('group', f.group)) + '" has none.</p>' : '') +
      '<p class="sub">Instead of buying when price touches the zone, the backtest waits for a <b>small CHoCH</b> on the smaller chart: price falls into the zone in lower ' +
      'highs and lower lows, makes its final low in the zone, then closes above its last swing high - the buy comes then. No CHoCH in time, or a candle of your ' +
      'chart closing under the zone first = no trade. Every signal is also traded without it, and the result compares both. The laptop keeps 1-hour candles ' +
      'and 15-minute candles as far back as Kite gives, up to 20 years (<b>KiteHistoryNow.bat</b> reads them once; <b>KiteDepthCheck.bat</b> shows how far).</p>';
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
    return '<div class="form-grid">' +
      (f.after === 'trail' ? field('At the target, sell part of it (the rest follows "At the target")', sel('partialPct', f.partialPct), 'wide') : '') +
      field('Before the target: stop to the entry', sel('beAt', f.beAt)) +
      field('Time stop', sel('timeN', f.timeN)) + (Number(f.timeN) ? field('… if price is', sel('timeR', f.timeR)) : '') +
      num('maxDays', f.maxDays, 'Sell after at most (days)', ' min="1" step="1"') +
      num('cost', f.cost, 'Costs per trade, buy + sell (%)', ' min="0" step="0.05"') +
      (f.after === 'trail' ? '<div class="field lab-checks">' + check('lockTarget', f.lockTarget, 'At the target, move the stop up to the target (a fall back to it = a win)') +
        check('breakeven', f.breakeven, 'At the target, move the stop to the entry') + '</div>' : '') + '</div>' +
      '<p class="sub">Part at the target: e.g. half is sold at the target, the other half stays with your trail - the result counts both. ' +
      'Stop to the entry: once price is that many R up (before the target), a fall back to the entry closes the trade at about 0R. ' +
      'Time stop: a trade that has not moved that many R up within those candles is sold at that candle\'s close.</p>';
  }

  /** The zone rules (owner, 12-Nov-2026, after his first charts PDF). */
  function zoneHtml(f) {
    var touch = f.group === 'touch';
    return '<div class="form-grid">' + field('Zone size - at least', sel('zoneMin', f.zoneMin)) + field('… at most', sel('zoneMax', f.zoneMax)) +
      (touch ? '<div class="field lab-checks">' + check('gapEntry', f.gapEntry, 'An FVG with a Gap-up zone inside it: the order at the Gap-up zone top (stop under the FVG)') + '</div>' +
        field('Fib + pattern: a Spring / Harami + Inverted Hammer at the zone\'s Fib line', sel('fibPat', f.fibPat), 'wide') +
        (f.fibPat !== 'off' ? field('… the line', sel('fibLevel', f.fibLevel)) + field('… its low', sel('fibTol', f.fibTol)) : '') : '') +
      field('Dark-cloud FVGs (a red 3rd candle closing under the middle of the green one)', sel('darkCloud', f.darkCloud), 'wide') + '</div>' +
      '<p class="sub">Zone size = (top - bottom) ÷ bottom. The Fib line of a zone is drawn from its bottom to its top, like TradingView: the 61.8% line of ' +
      '219.70 - 247.77 = 230.42. "Fib + pattern" buys at the pattern candle\'s close with the stop under the zone bottom. ' +
      (touch ? '' : 'The Gap-up zone and Fib + pattern rules work with the Pattern "First touch of a zone". ') + 'The daily scan takes the same rules from <b>ChochRules.bat</b>.</p>';
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
      var set = quickSet(q.id);
      return Object.keys(set).every(function (k) { return String(f[k]) === String(set[k]); });
    };
    return '<div class="lab-recs lab-quick">' + QUICK.map(function (q) {
      var on = isOn(q);
      return '<div class="lab-rec' + (on ? ' on' : '') + '"><b>' + esc(q.name) + '</b><span>' + esc(q.why) + '</span>' +
        '<button class="btn sm" type="button" data-quick="' + q.id + '"' + (q.id === 'smc' ? ' id="lab-smc"' : q.id === 'bos' ? ' id="lab-bos"' : '') + '>' + (on ? 'In use' : 'Use this') + '</button></div>';
    }).join('') + '</div>';
  }

  /** The stop choices of a Pattern library run (no zone - the 'lower of the two' is the pattern's low; the CHoCH's final low only
   *  with the market structure on). */
  function patStops(f) {
    return CHOICES.stopPat.filter(function (o) { return o[0] !== 'final' || f.structure !== 'off'; });
  }

  function formHtml(f) {
    // a pattern run with a zone-only stop kept from another setup -> the pattern's low
    if (f.group === 'pattern' && (f.stop === 'lower' || (f.stop === 'final' && f.structure === 'off'))) f.stop = 'zone';
    var trailOn = f.after === 'trail';
    var changed = SECTIONS.reduce(function (n, x) { return n + sectionOn(f, x[0]); }, 0);
    return '<section class="card lab-form" id="lab-form"><div class="card-head"><div><h2>Your rules</h2><p>1 · pick a ready setup, 2 · check the basics, ' +
      '3 · press ▶ Run. Everything else is optional under <b>More rules</b>. Kept on this device; your laptop runs it on its Kite candles ' +
      '(daily ~20 years, 4 hour as far back as Kite gives - up to 20 years).</p></div><div class="actions"><a class="btn sm" href="docs/Backtest-Lab-Guide.pdf" target="_blank" rel="noopener">📘 Guide (PDF)</a></div></div>' +
      '<h3 class="lab-h">1 · Start from a ready setup</h3>' + quickHtml(f) +
      '<h3 class="lab-h">2 · The basics</h3><div class="form-grid">' +
      field('Timeframe', sel('tf', f.tf)) + field('Pattern', sel('group', f.group), 'wide') +
      (f.group === 'pattern' ? patHtml(f) : '') +
      field('Stop loss', sel('stop', f.stop, f.group === 'pattern' ? patStops(f) : null), 'wide') +
      (f.stop === 'pct' ? num('stopPct', f.stopPct, 'Stop % below the entry', ' min="0.1" step="0.5"') :
        num('stopBuf', f.stopBuf, 'How far below it (%)', ' min="0" step="0.1"')) +
      field('… or x ATR under the entry, whichever is lower', sel('stopAtr', f.stopAtr)) +
      field('Target', sel('targetMode', f.targetMode)) +
      (f.targetMode === 'R' ? num('targetR', f.targetR, 'Target (R = times the risk)', ' min="0.25" step="0.25"') :
        f.targetMode === 'pct' ? field('Target %', sel('targetPct', f.targetPct)) :
          num('swingMinR', f.swingMinR, 'At least this many R above the entry', ' min="0" step="0.25"')) +
      field('At the target', sel('after', f.after), 'wide') +
      (trailOn ? field('Then', sel('trail', f.trail), 'wide') : '') +
      (trailOn && f.trail === 'lows' ? num('trailN', f.trailN, 'N candles', ' min="1" step="1"') : '') +
      (trailOn && f.trail === 'pct' ? num('trailPct', f.trailPct, 'X %', ' min="0.5" step="0.5"') : '') +
      (trailOn && f.trail === 'ema' ? num('emaN', f.emaN, 'EMA length', ' min="2" step="1"') : '') +
      (trailOn && f.trail === 'atr' ? num('atrK', f.atrK, 'x ATR', ' min="0.5" step="0.5"') : '') +
      num('capital', f.capital, 'Account ₹', ' min="1000" step="10000"') + num('riskPct', f.riskPct, 'Risk per trade (% of the account)', ' min="0.05" step="0.25"') +
      field('Test period from (optional)', '<input class="inp" type="date" data-k="testFrom" id="lab-testfrom" value="' + esc(f.testFrom) + '" ' +
        'title="Trades before this date = the development part (where you look for rules); from it = the test part (kept to check them)">') + '</div>' +
      (f.group === 'pattern' && f.entry === 'zone' ? '<p class="note warn">A Pattern library signal has no zone: an "order at the zone top" never fills - ' +
        'set Entry details → Buy to the signal candle\'s close or the next open.</p>' : '') +
      '<p class="sub">Test period: trades before that date = the <b>development</b> part (choose your rules there), from it = the <b>test</b> part (kept aside to check them). ' +
      'Rules that work only in the development part fit the past by luck. E.g. 2020-01-01.</p>' +
      '<h3 class="lab-h">3 · More rules (optional)' + (changed ? ' - ' + changed + ' changed' : '') + '</h3><div class="lab-secs">' +
      sec('structure', secTitle('structure'), structHtml(f), f) + sec('zone', secTitle('zone'), zoneHtml(f), f) + sec('shape', secTitle('shape'), shapeHtml(f), f) +
      sec('trend', secTitle('trend'), trendHtml(f), f) + sec('ltf', secTitle('ltf'), ltfHtml(f), f) + sec('entry', secTitle('entry'), entryHtml(f), f) + sec('exit', secTitle('exit'), exitHtml(f), f) +
      sec('money', secTitle('money'), moneyHtml(f), f) + sec('check', secTitle('check'), checkHtml(f), f) +
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
    // the setup tick boxes (14-Nov-2026): both = CHoCH + FVG and BOS + FVG in one run; none ticked = CHoCH + FVG
    var sb = el.querySelectorAll('#lab-form [data-setup]');
    if (sb.length) {
      var on = {};
      sb.forEach(function (x) { on[x.getAttribute('data-setup')] = x.checked; });
      f.setup = on.choch && on.bos ? 'both' : on.bos ? 'bos' : 'choch';
    }
    ['trailN', 'emaN', 'maxDays', 'maxOpen', 'maxTouch', 'timeN', 'rsiN', 'divPivot', 'divMaxGap', 'patSwing'].forEach(function (k) { f[k] = Math.max(0, Math.round(f[k])); });
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
    // pdf.path = the folder's full path (14-Nov-2026: the data may sit on the D: drive - MoveDataToD.bat)
    var where = pdf.path ? String(pdf.path) : 'ScreenerBridge\\' + (pdf.folder || 'lab_charts');
    return '<p class="note lab-pdf">📄 <b>Charts PDF on your laptop</b> - two pages for every trade (the chart with HH / HL / LH / LL, CHoCH, BOS, zone, BUY; then why it was taken and how it ended) - the losing ones first: <code>' +
      esc(where) + '\\' + esc(pdf.file) + '</code> - ' + F.int(pdf.pages) + ' pages' +
      (pdf.shown < pdf.trades ? ' (the first ' + F.int(pdf.shown) + ' of ' + F.int(pdf.trades) + ' trades)' : '') +
      '. On the laptop: File Explorer → <b>' + esc(where) + '</b> (the newest 20 PDFs are kept).</p>';
  }

  /** With market structure 'only': how many signals each structure rule left out (the first one they failed). */
  function structNote(res) {
    var why = res.structWhy || {}, keys = Object.keys(why).filter(function (k) { return why[k]; });
    if (!keys.length) return '';
    return '<p class="note">Market structure: left out - ' + keys.sort(function (a, b) { return why[b] - why[a]; })
      .map(function (k) { return F.int(why[k]) + ' ' + evWords(STRUCT_WHY[k] || k, res.params); }).join('; ') + '.</p>';
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
  var RSEC_OPEN = ['ltf', 'split', 'bd', 'trades'];
  var LTF_WHY = { ltfnone: 'no small CHoCH in the zone in time', ltfbroke: 'a candle of the chart closed under the zone first',
    ltfnofvg: 'no small FVG in the move (FVG entry)', ltfnofill: 'the order was not reached in time (no retest)',
    ltfmissed: 'missed - the target came before the retest', other: 'another rule' };
  var LTF_HOW = { close: 'In the zone - its close', fvg: 'Above - small FVG top', half: 'Above - 50% line' };
  var SETUP_NAME = { choch: 'CHoCH + FVG', bos: 'BOS + FVG' };
  /** With vs without the lower-timeframe confirmation on the same signals (owner, 13-Nov-2026). */
  function ltfHtml2(res) {
    var x = res.ltf;
    if (!x) return '';
    var row = function (name, s, sub) {
      if (!s || !s.trades) return '<tr><th>' + name + '<div class="sub">' + sub + '</div></th><td colspan="7" class="sub">no finished trade</td></tr>';
      var e = EDGE[s.edge] || ['', ''];
      return '<tr><th>' + name + '<div class="sub">' + sub + '</div></th><td>' + F.int(s.trades) + '</td><td>' + F.num(s.winPct, 1) + '%</td>' +
        '<td class="' + tone(s.avgR) + '">' + r2(s.avgR) + '</td><td>' + rng(s.avgRLo, s.avgRHi) + '</td><td>' + F.num(s.totalR, 1) + 'R</td>' +
        '<td>' + (isNum(s.pf) ? F.num(s.pf, 2) : '–') + '</td><td>' + ui.badge(e[0], e[1]) + '</td></tr>';
    };
    var w = x['with'] || {}, wo = x.without || {}, wc = x.withoutConfirmed || {};
    var why = Object.keys(x.why || {}).filter(function (k) { return x.why[k]; }).map(function (k) { return F.int(x.why[k]) + ' ' + (LTF_WHY[k] || k); });
    var say = '';
    if (w.trades && wo.trades) {
      var d = w.avgR - wo.avgR;
      say = '<p class="note' + (d > 0 ? '' : ' warn') + '">' + (d > 0 ? 'The ' + esc(x.name) + ' confirmation helped: <b>' + r2(w.avgR) + '</b> a trade against ' + r2(wo.avgR) +
        ' without it (+' + F.num(d, 2) + 'R a trade), on ' + F.int(w.trades) + ' of the ' + F.int(wo.trades) + ' signals.' :
        'The ' + esc(x.name) + ' confirmation did NOT help here: ' + r2(w.avgR) + ' a trade against ' + r2(wo.avgR) + ' without it.') +
        (w.trades < 30 ? ' Few trades - read it as a hint, not a result.' : '') + '</p>';
    }
    return '<div class="tbl-wrap"><table class="tbl" id="lab-ltf"><thead><tr><th>Entry</th><th>Trades</th><th>Win %</th><th>Avg R</th><th>Likely range</th>' +
      '<th>Total R</th><th>Profit factor</th><th>Real or chance?</th></tr></thead><tbody>' +
      row('With the confirmation', w, 'buy after the small ' + esc(x.tf) + ' CHoCH') +
      row('Without it - every signal', wo, 'buy as the setup says (the same signals)') +
      row('Without it - only the confirmed ones', wc, 'shows what the later, smaller-risk entry did') + '</tbody></table></div>' + say +
      '<p class="sub">' + F.int(x.signals) + ' signals with ' + esc(x.name) + ' candles' + (x.from ? ' (from ' + F.date(x.from) + ')' : '') + ': ' + F.int(x.confirmed) +
      ' confirmed' + (why.length ? ', not confirmed: ' + why.join(', ') : '') + '.' +
      (x.nodata ? ' ' + F.int(x.nodata) + ' older signals left out - no ' + esc(x.name) + ' candles that old on the laptop (KiteHistoryNow.bat reads them).' : '') +
      (x.notyet ? ' ' + F.int(x.notyet) + ' still waiting (the time is not over yet).' : '') + '</p>' + smartHtml(x, row);
  }
  /** The Smart entry (owner, 14-Nov-2026): its three ways side by side + the orders price ran away from. */
  function smartHtml(x, row) {
    if (!x.byHow) return '';
    var b = x.byHow;
    return '<h3 class="lab-h">Smart entry - which way it bought</h3><div class="tbl-wrap"><table class="tbl" id="lab-smart"><thead><tr><th>Way</th><th>Trades</th><th>Win %</th>' +
      '<th>Avg R</th><th>Likely range</th><th>Total R</th><th>Profit factor</th><th>Real or chance?</th></tr></thead><tbody>' +
      row('Small CHoCH in the zone', b.close, 'bought at its close') +
      row('Above the zone - small FVG', b.fvg, 'an order at its top, filled on the retest') +
      row('Above the zone - 50% line', b.half, 'no small FVG: an order at the middle of the small move') +
      row('Missed orders, if bought at the CHoCH close', x.missedAtClose, F.int(x.missed || 0) + ' orders: the target came before the retest') +
      '</tbody></table></div>' +
      '<p class="sub">A buy above the zone has its stop under the small final low; a buy in the zone keeps your stop (under the zone). ' +
      'The last row shows what the orders price ran away from would have made at the small CHoCH\'s close - so you see what waiting for the retest cost.</p>';
  }
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

  /** A Pattern library run made by an older laptop program (owner, 13-Nov-2026: "entha pattern select paninalum, our backtest run
   *  only on Bullishengulfing" - a program that did not know the chosen pattern used its default K08 without a word): the pattern
   *  asked (this run's job) vs the one it ran, and the program's pattern engine (results from 13-Nov-2026 on carry it). */
  function engineNote(it, res) {
    var p = res.params || {};
    if (p.group !== 'pattern') return '';
    var sj = ST.status && ST.status.job;
    var job = sj && sj.id === it.id ? sj.params || {} : {};
    var fix = ' Your laptop\'s program is older than this website: extract the newest ScreenerBridge.zip into the ScreenerBridge folder, ' +
      'then sign out of Windows and sign in again (or restart the laptop), and run it again.';
    if (job.pattern && job.pattern !== p.pattern) {
      return '<p class="note bad lab-warn" id="lab-engine">You chose ' + esc(job.pattern + ' ' + ((patOf(job.pattern) || {}).name || '')) +
        ' but your laptop ran ' + esc(p.pattern + ' ' + ((patOf(p.pattern) || {}).name || '')) + ' - these figures and the charts PDF are for that pattern.' + esc(fix) + '</p>';
    }
    if (!res.engine) {
      return '<p class="note warn lab-warn" id="lab-engine">Made by an older laptop program - it knew fewer patterns, and a pattern it did not know ran as ' +
        'K08 Bullish Engulfing. Check the pattern in the title above.' + esc(fix) + '</p>';
    }
    return '<p class="sub" id="lab-engine">Laptop program: pattern engine v' + esc(String(res.engine.version)) + ' · ' + F.int(res.engine.patterns) + ' patterns</p>';
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
      engineNote(it, res) + '<p class="note lab-plain"><b>The rules:</b> ' + esc(plain(Object.assign({}, DEF, p))) + '</p>' + pdfNote(res.pdf) +
      '<div id="lab-res-pine-box" class="lab-pine"></div>';
    if (!s.trades) {
      box.innerHTML = h + '<p class="empty">No trade matched these rules' + (res.open ? ' (' + res.open + ' still running)' : '') + '.</p>' +
        (res.ltf ? rsec('ltf', 'With vs without the ' + (LTF_NAME[res.ltf.tf] || res.ltf.tf) + ' confirmation', ltfHtml2(res)) : '') + '</section>';
      bindResult(el, it);
      return;
    }
    var sk = res.skipped || {};
    var full = '<div class="tiles">' +
      ui.tile('Trades', F.int(s.trades), (res.open ? F.int(res.open) + ' still running (not counted)' : 'all finished') +
        (sk.risk ? ' · ' + F.int(sk.risk) + ' skipped (risk too big)' : '') +
        (sk.struct ? ' · ' + F.int(sk.struct) + ' left out by your market-structure rules' : '') +
        (sk.noswing ? ' · ' + F.int(sk.noswing) + ' without a swing high above (target)' : '') +
        (sk.nomh ? ' · ' + F.int(sk.nomh) + ' without a CHoCH move high far enough above (target)' : '') +
        (sk.zoneentry ? ' · ' + F.int(sk.zoneentry) + ' not first touches (the zone-top order fills on those only)' : '') +
        (sk.shape ? ' · ' + F.int(sk.shape) + ' Springs left out by your shape rules' : '') +
        (sk.ema ? ' · ' + F.int(sk.ema) + ' left out by your EMA rules' : '') +
        (sk.mkt ? ' · ' + F.int(sk.mkt) + ' left out by your market rule' : '') +
        (sk.wk ? ' · ' + F.int(sk.wk) + ' left out by the weekly trend rule' : '') +
        (sk.where ? ' · ' + F.int(sk.where) + ' went too deep into the zone' : '') +
        (sk.zsize ? ' · ' + F.int(sk.zsize) + ' zones outside your size range' : '') +
        (sk.gapin ? ' · ' + F.int(sk.gapin) + ' FVG touches skipped - the order waited at the Gap-up zone inside' : '') +
        (sk.dcloud ? ' · ' + F.int(sk.dcloud) + ' left out by the dark-cloud rule' : '') +
        (sk.fiblevel ? ' · ' + F.int(sk.fiblevel) + ' patterns not at the zone\'s Fib line' : '') +
        (sk.nofinal ? ' · ' + F.int(sk.nofinal) + ' without a live CHoCH (final-low stop)' : '') +
        (sk.ltfnone ? ' · ' + F.int(sk.ltfnone) + ' no small CHoCH in the zone in time' : '') +
        (sk.ltfbroke ? ' · ' + F.int(sk.ltfbroke) + ' zone closed under before the small CHoCH' : '') +
        (sk.ltfnofill || sk.ltfnofvg ? ' · ' + F.int((sk.ltfnofill || 0) + (sk.ltfnofvg || 0)) + ' small FVG not there / not retested' : '') +
        (sk.ltfdata ? ' · ' + F.int(sk.ltfdata) + ' without small candles that old' : '')) +
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
    h += '<div class="lab-verdict" id="lab-verdict">' + (res.warnings || []).map(function (w) { return '<p class="note warn lab-warn">' + esc(w) + '</p>'; }).join('') +
      edgeNote(s) + verdictTest(res) +
      '<div class="tiles">' + ui.tile('Trades', F.int(s.trades), res.open ? F.int(res.open) + ' still running' : 'all finished') +
      ui.tile('Win rate', F.num(s.winPct, 1) + '%', 'sold above the entry') +
      ui.tile('Average per trade', '<span class="' + tone(s.avgR) + '">' + r2(s.avgR) + '</span>', isNum(s.avgRLo) ? 'likely ' + rng(s.avgRLo, s.avgRHi) : 'median ' + r2(s.medR)) +
      ui.tile('Total', '<span class="' + tone(s.totalR) + '">' + F.num(s.totalR, 1) + 'R</span>', 'all trades together') +
      ui.tile('Account', '<span class="' + tone(a.returnPct) + '">' + F.pct(a.returnPct) + '</span>', 'max fall ' + F.num(a.maxDD, 1) + '%') + '</div></div>';
    if (res.ltf) h += rsec('ltf', 'With vs without the ' + (LTF_NAME[res.ltf.tf] || res.ltf.tf) + ' confirmation', ltfHtml2(res));
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
          { key: 'stage', label: 'Where the signal sat', html: function (r) { var x = stageOf(r.stage, r.setup ? { setup: r.setup } : res.params) || [r.name, '']; return ui.badge(x[0], x[1]) + ' <span class="sub">' + esc(r.name) + '</span>'; } },
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
        { key: 'stage', label: 'Structure', get: function (r) { return r.stage ? (stageOf(r.stage, r.setup ? { setup: r.setup } : res.params) || [r.stage])[0] : ''; },
          html: function (r) {
            if (!r.stage) return '';
            var x = stageOf(r.stage, r.setup ? { setup: r.setup } : res.params) || [r.stage, ''];
            return r.struct ? '<span class="lab-acct" tabindex="0" data-tip="' + esc(r.struct) + '">' + ui.badge(x[0], x[1]) + '</span>' : ui.badge(x[0], x[1]);
          }, title: 'Market structure at the signal (hover / tap for the CHoCH level, its date, the final low, the move high, the zone\'s place in the move and the BOS)' },
        { key: 'setup', label: 'Setup', get: function (r) { return SETUP_NAME[r.setup] || ''; }, title: 'CHoCH + FVG or BOS + FVG (a run of both together)' },
        { key: 'entry', label: 'Entry', type: 'num', digits: 2 }, { key: 'stop', label: 'Stop', type: 'num', digits: 2 },
        { key: 'target', label: 'Target', type: 'num', digits: 2, title: 'The target price (R multiple, % above the entry, the CHoCH move high or the last swing high)' },
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
        { key: 'zpct', label: 'Zone %', type: 'num', digits: 1, title: 'The zone\'s size: top - bottom, % of the bottom (a Gap-up zone inside an FVG: that FVG)' },
        { key: 'pat', label: 'Pattern', get: function (r) { return r.pat || ''; }, title: 'The pattern at the zone\'s Fib line (Fib + pattern entry)' },
        { key: 'zn', label: 'Zone no.', type: 'num', digits: 0, title: 'Which discount zone of the CHoCH move: 1 = the only (or the higher) one, 2 = the 2nd (under a 1st that was only watched)' },
        { key: 'mit', label: 'Touches before move high', type: 'num', digits: 0, title: 'Candles that touched the zone (a wick in it counts) between its forming and the move high - at most 2 allowed' },
        { key: 'mv', label: 'Move volume x', type: 'num', digits: 1, title: 'The biggest volume in the CHoCH move (final low to the CHoCH candle), x the average of the 20 candles before the move' },
        { key: 'ltf', label: 'Confirmation', get: function (r) { return r.ltf ? String(r.ltf).split(' (')[0] : ''; },
          html: function (r) { return r.ltf ? '<span class="lab-acct" tabindex="0" data-tip="' + esc(r.ltf) + '">' + esc(String(r.ltf).split(' (')[0]) + '</span>' : ''; },
          title: 'The small CHoCH that confirmed the signal (hover / tap for its final low and how the trade was bought)' },
        { key: 'ltfHow', label: 'Smart entry', get: function (r) { return LTF_HOW[r.ltfHow] || ''; },
          title: 'The Smart entry\'s way: the small CHoCH in the zone (its close) / above the zone (the small FVG top or the 50% line on the retest)' },
        { key: 'ltfWait', label: 'Candles to confirm', type: 'num', digits: 0, title: 'Candles of your chart from the signal to the small CHoCH (0 = in the signal candle)' },
        { key: 'baseR', label: 'R without it', type: 'num', digits: 2, title: 'What the same signal made when bought as the setup says (no confirmation)' },
        { key: 'stopBy', label: 'Stop from', get: function (r) { return r.stopBy === 'atr' ? 'ATR' : r.stopBy === 'rule' ? 'Your rule' : ''; },
          title: 'Which stop was lower (and used): your stop rule or the ATR stop' },
        { key: 'part', label: 'Sold at the target', get: function (r) { return r.part ? String(r.part).replace(/\bat /, 'at ₹') : ''; },
          title: 'The part sold at the target (the Exit column is the average of both parts)' },
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
        if (c.key === 'depth' || c.key === 'lhll' || c.key === 'lag' || c.key === 'zpct' || c.key === 'zn' || c.key === 'mv' || c.key === 'mit') return rows.some(function (r) { return isNum(r[c.key]); });   // with market structure / a zone (12-Nov-2026)
        if (c.key === 'pat') return rows.some(function (r) { return r.pat; });
        if (c.key === 'stopBy' || c.key === 'part') return rows.some(function (r) { return r[c.key]; });   // with the ATR stop / a part sold (13-Nov-2026)
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

  // ---------- the Pattern library list (owner, 13-Nov-2026 - the bullish pattern engine: all 194 patterns of his master prompt +
  // his own, each with its real state; "Use" puts an implemented one in the form)
  var NEEDS = { o: 'OHLC', v: 'volume', b: 'index', i: 'intraday' };
  var STATUS_TONE = { implemented: 's-good', lab: 's-info', partial: 's-warn', sheet: 's-warn', planned: '', data: 's-bad' };
  // short chip names (a long chip would push a phone screen sideways)
  var CAT_SHORT = { C: 'Classical', K: 'Candles', P: 'Price action', S: 'SMC / ICT', V: 'Volume', B: 'Breakouts', M: 'Moving averages',
    I: 'Momentum', Q: 'Quant', X: 'Yours' };
  function libHtml() {
    var ps = patReg();
    if (!ps.length) return '';
    var n = ps.filter(function (p) { return p.category !== 'X'; }).length;
    var done = ps.filter(function (p) { return p.status === 'implemented'; }).length;
    var cats = window.SB_PATTERNS.categories || {};
    return '<section class="card" id="lab-lib"><details class="lab-sec" data-sec="library"' + (ST.libOpen ? ' open' : '') + '><summary><span>Pattern library - ' + n +
      ' patterns + your own (' + done + ' built in the new engine so far)</span><span class="sub">open</span></summary><div class="lab-sec-body">' +
      '<p class="sub">Every pattern with its real state. <b>Implemented</b> = written rules + tests (nothing from later candles is used) - pick it with ' +
      'Pattern → "Pattern library". <b>In the Lab</b> = your existing setups. <b>Partial</b> = a filter or only in the sheet. <b>Planned</b> = not built yet. ' +
      '<b>Data limited</b> = no 5-minute candles. The rules: docs/PATTERN_SPECS.md.</p>' +
      '<div class="controls">' + ui.chips('labcat', [['all', 'All']].concat(Object.keys(cats).map(function (k) { return [k, CAT_SHORT[k] || cats[k]]; })), ST.libCat || 'all') +
      '<input class="inp" type="search" id="lab-lib-q" placeholder="Search a pattern or ID" value="' + esc(ST.libQ || '') + '"></div>' +
      '<div id="lab-lib-table"></div></div></details></section>';
  }
  function drawLib(el) {
    var host = $('#lab-lib-table', el);
    if (!host) return;
    var cat = ST.libCat || 'all', q = String(ST.libQ || '').toLowerCase().trim();
    var rows = patReg().filter(function (p) {
      return (cat === 'all' || p.category === cat) && (!q || (p.id + ' ' + p.name + ' ' + p.family + ' ' + p.note).toLowerCase().indexOf(q) >= 0);
    });
    host.innerHTML = '';
    new ui.Table({
      rows: rows, pageSize: 25, id: 'lab-pattern-library',
      columns: [
        { key: 'id', label: 'ID' }, { key: 'name', label: 'Pattern' }, { key: 'categoryName', label: 'Category' },
        { key: 'statusName', label: 'Status', html: function (r) { return ui.badge(r.statusName, STATUS_TONE[r.status] || ''); } },
        { key: 'tf', label: 'Timeframes', get: function (r) { return (r.timeframes || []).join(' / '); } },
        { key: 'needs', label: 'Data', get: function (r) { return String(r.needs || '').split('').map(function (c) { return NEEDS[c] || c; }).join(' + '); } },
        { key: 'note', label: 'Note', get: function (r) { return r.note || ''; } },
        { key: 'use', label: '', get: function () { return null; },
          html: function (r) { return r.status === 'implemented' ? '<button class="btn sm" type="button" data-usepat="' + esc(r.id) + '">Use</button>' : ''; } }
      ]
    }).mount(host);
  }
  function bindLib(el) {
    var box = $('#lab-lib', el);
    if (!box) return;
    var d = $('details', box);
    d.addEventListener('toggle', function () { ST.libOpen = d.open; if (d.open && !$('#lab-lib-table table', el)) drawLib(el); });
    if (d.open) drawLib(el);
    ui.bindChips(box, 'labcat', function (v) { ST.libCat = v; drawLib(el); });
    $('#lab-lib-q', box).addEventListener('input', function (e) { ST.libQ = e.target.value; drawLib(el); });
    box.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-usepat]');
      if (!b) return;
      var f = readForm(el);
      f.group = 'pattern';
      f.pattern = b.getAttribute('data-usepat');
      if (f.entry === 'zone') f.entry = 'close';
      if (f.structure === 'only') f.structure = 'off';
      saveForm(f);
      SB.route(true);
      setTimeout(function () { var x = $('#lab-form', document); if (x && x.scrollIntoView) x.scrollIntoView({ block: 'start' }); }, 0);
    });
  }

  function bindForm(el) {
    var host = $('#lab-form', el);
    host.addEventListener('change', function (e) {
      var k = e.target.getAttribute && (e.target.getAttribute('data-k') || (e.target.getAttribute('data-setup') ? 'setup' : null));
      if (!k) return;
      var f = readForm(el);
      saveForm(f);
      var inSec = SECTIONS.some(function (x) { return (x[2] || SHAPE_KEYS).indexOf(k) >= 0; });
      if (['tf', 'stop', 'after', 'trail', 'emaSupport', 'mktIndex', 'fallN', 'structure', 'targetMode', 'group', 'swingMode', 'entry', 'timeN', 'pattern', 'patCtx'].indexOf(k) >= 0 || inSec ||
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
        saveForm(Object.assign(readForm(el), quickSet(qq.id)));
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
      el.innerHTML = head + '<div id="lab-status" class="lab-status"></div>' + formHtml(f) + libHtml() +
        '<section class="card"><div class="card-head"><div><h2>Your runs</h2><p>The newest 8 are kept in your sheet (tab Backtest_Lab). Open one to see it.</p></div></div>' +
        '<div id="lab-runs"><p class="empty">Loading…</p></div></section><div id="lab-result"></div>';
      bindForm(el);
      bindLib(el);
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
