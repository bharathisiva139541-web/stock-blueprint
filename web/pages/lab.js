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
    c1BodyMin: 0.5, c1LoWickMax: 100, c1Atr: 0, lowestN: 0, fallN: 0, fallPct: 10
  };
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
      ['zone', 'FVG+Spring or Gap-up FVG + Spring'], ['spring', 'Every Spring (no zone - to compare)']],
    entry: [['close', 'At the Spring candle\'s close'], ['next_open', 'At the next candle\'s open']],
    stop: [['zone', 'A little below the FVG / Gap-up zone bottom'], ['spring', 'A little below the Spring candle\'s low'],
      ['lower', 'A little below whichever is lower'], ['pct', 'A fixed % below the entry']],
    after: [['trail', 'Keep the trade and trail the stop'], ['fixed', 'Sell at the target']],
    trail: [['lows', 'Under the lowest low of the last N candles'], ['pct', 'X % under the highest price since entry'],
      ['ema', 'Sell when a candle closes under the N EMA'], ['none', 'No trail (the stop stays)']],
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
    'c1BodyMin', 'c1LoWickMax', 'c1Atr', 'lowestN', 'fallN', 'fallPct'];
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
  var ST = { status: null, item: null, itemId: null, timer: 0, busy: false, err: '', host: null, gen: 0 };

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
    var shape = shapeWords(p);
    if (shape) s.push(shape);
    var ema = emaWords(p);
    if (ema) s.push(ema);
    var mkt = mktWords(p);
    if (mkt) s.push(mkt);
    s.push('Buy ' + (p.entry === 'close' ? 'at the Spring candle\'s close' : 'at the next candle\'s open') + '.');
    s.push('Stop loss ' + (p.stop === 'pct' ? F.num(p.stopPct, 2) + '% below the entry' :
      F.num(p.stopBuf, 2) + '% below ' + (p.stop === 'zone' ? 'the zone bottom' : p.stop === 'spring' ? 'the Spring candle\'s low' : 'the zone bottom or the Spring low, whichever is lower')) +
      (p.maxRisk ? ' - trades risking more than ' + F.num(p.maxRisk, 1) + '% are skipped' : '') + '.');
    if (p.after === 'fixed') s.push('Sell at ' + F.num(p.targetR, 2) + 'R (' + F.num(p.targetR, 2) + ' x the risk).');
    else {
      s.push('At ' + F.num(p.targetR, 2) + 'R ' + (p.breakeven ? 'move the stop to the entry, then ' : 'keep the stop, then ') +
        (p.trail === 'lows' ? 'trail it under the lowest low of the last ' + p.trailN + ' candle' + (p.trailN === 1 ? '' : 's') :
          p.trail === 'pct' ? 'trail it ' + F.num(p.trailPct, 1) + '% under the highest price' :
            p.trail === 'ema' ? 'sell when a candle closes under the ' + p.emaN + ' EMA' : 'let it run with that stop') + '.');
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

  /** Step 2: the hard Spring rules + my recommendations (owner, 10-Nov-2026). */
  function shapeHtml(f) {
    var sameSet = function (r) {
      return SHAPE_KEYS.every(function (k) { return String(r.set[k] !== undefined ? r.set[k] : DEF[k]) === String(f[k]); });
    };
    return '<h3 class="lab-h">2 · Spring candle shape (optional) - make the pattern stricter</h3>' +
      '<p class="sub">The pattern\'s own rule is loose (a doji, a 2-tick dip or a weak close can all be a "Spring"). Here you add hard rules. ' +
      '<b>c1</b> = the red candle, <b>c2</b> = the Spring candle that dips under its low. Wicks, body and close are % of c2\'s own high-low range. ' +
      'Leave a box at its first choice to not use it.</p>' +
      '<div class="lab-recs" id="lab-recs">' + RECS.map(function (r) {
        return '<div class="lab-rec' + (sameSet(r) ? ' on' : '') + '"><b>' + esc(r.name) + '</b><span>' + esc(r.why) + '</span>' +
          '<button class="btn sm" type="button" data-rec="' + r.id + '">' + (sameSet(r) ? 'In use' : 'Use this') + '</button></div>';
      }).join('') + '</div>' +
      '<p class="sub">These are <b>my starting ideas to test</b>, not proven edges. Run one, look at the number of trades and the average R, then change one box at a time. ' +
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
      '<p class="sub">ATR 14 = the stock\'s average candle range over the 14 candles before - so "0.25 x ATR" means the same on a ₹50 stock, a ₹5,000 stock, daily or weekly. ' +
      'A Spring with too few candles before it for an ATR / low / fall rule is left out.</p>';
  }

  function formHtml(f) {
    var trailOn = f.after === 'trail';
    return '<section class="card lab-form" id="lab-form"><div class="card-head"><div><h2>Your rules</h2><p>Change anything - it is kept on this device. ' +
      'Your laptop runs it on the Kite candles kept there (daily ~20 years, 4 hour ~5 years, weekly from the daily).</p></div></div>' +
      '<h3 class="lab-h">1 · Which signals</h3><div class="form-grid">' +
      field('Timeframe', sel('tf', f.tf)) + field('Pattern', sel('group', f.group), 'wide') +
      field('From (optional)', '<input class="inp" type="date" data-k="from" value="' + esc(f.from) + '">') +
      field('To (optional)', '<input class="inp" type="date" data-k="to" value="' + esc(f.to) + '">') +
      num('minPrice', f.minPrice, 'Price at least ₹', ' min="0" step="1"') +
      num('minTurnover', f.minTurnover, 'Daily turnover at least ₹ lakh (20-day avg)', ' min="0" step="10"') +
      num('maxTouch', f.maxTouch, 'Zone touched at most (0 = any)', ' min="0" step="1"') + '</div>' +
      shapeHtml(f) +
      '<h3 class="lab-h">3 · EMA confluence (optional) - take the signal only when the EMAs agree</h3><div class="form-grid">' +
      field('The Spring candle took support at', sel('emaSupport', f.emaSupport), 'wide') +
      (Number(f.emaSupport) ? num('emaTouch', f.emaTouch, 'Its low within % above the EMA', ' min="0" step="0.25"') : '') +
      '<div class="field lab-checks lab-checks-row"><span>It closed above</span>' + check('above10', f.above10, '10 EMA') +
      check('above21', f.above21, '21 EMA') + check('above50', f.above50, '50 EMA') + '</div>' +
      '<div class="field lab-checks">' + check('emaStack', f.emaStack, 'EMAs in order: 10 > 21 > 50 (uptrend)') + '</div></div>' +
      '<p class="sub">EMAs of the same timeframe (daily / weekly / 4 hour), on the Spring candle. Leave everything off to test the pattern alone.</p>' +
      '<h3 class="lab-h">4 · Market condition (optional) - trade only when the market agrees</h3><div class="form-grid">' +
      field('Index', '<select class="sel" data-k="mktIndex" id="lab-mkt-index"><option value="">Off - no market rule</option>' +
        indexList(f.mktIndex).map(function (n) {
          return '<option value="' + esc(n) + '"' + (n === f.mktIndex ? ' selected' : '') + '>' + esc(idxName(n)) + '</option>';
        }).join('') + '</select>', 'wide') +
      (f.mktIndex ? field('The index closed above', sel('mktAbove', f.mktAbove)) +
        '<div class="field lab-checks">' + check('mktStack', f.mktStack, 'Its EMAs in order: 10 > 21 > 50') + '</div>' : '') + '</div>' +
      '<p class="sub">The index\'s daily candles on the Spring candle\'s day (your laptop reads them from Kite: your Indextracker indices + NIFTY 50 / 100 / 200 / 500, ' +
      'Bank, Midcap, Smallcap ...).</p>' +
      '<h3 class="lab-h">5 · Entry and stop loss</h3><div class="form-grid">' +
      field('Buy', sel('entry', f.entry)) + field('Stop loss', sel('stop', f.stop), 'wide') +
      (f.stop === 'pct' ? num('stopPct', f.stopPct, 'Stop % below the entry', ' min="0.1" step="0.5"') :
        num('stopBuf', f.stopBuf, 'How far below it (%)', ' min="0" step="0.1"')) +
      num('maxRisk', f.maxRisk, 'Skip if the risk is more than % (0 = never)', ' min="0" step="1"') + '</div>' +
      '<h3 class="lab-h">6 · Target and exit</h3><div class="form-grid">' +
      num('targetR', f.targetR, 'Target (R = times the risk)', ' min="0.25" step="0.25"') + field('At the target', sel('after', f.after), 'wide') +
      (trailOn ? field('Then', sel('trail', f.trail), 'wide') : '') +
      (trailOn && f.trail === 'lows' ? num('trailN', f.trailN, 'N candles', ' min="1" step="1"') : '') +
      (trailOn && f.trail === 'pct' ? num('trailPct', f.trailPct, 'X %', ' min="0.5" step="0.5"') : '') +
      (trailOn && f.trail === 'ema' ? num('emaN', f.emaN, 'EMA length', ' min="2" step="1"') : '') +
      num('maxDays', f.maxDays, 'Sell after at most (days)', ' min="1" step="1"') +
      num('cost', f.cost, 'Costs per trade (%)', ' min="0" step="0.05"') +
      (trailOn ? '<div class="field lab-checks">' + check('breakeven', f.breakeven, 'At the target, move the stop to the entry') + '</div>' : '') + '</div>' +
      '<h3 class="lab-h">7 · Money</h3><div class="form-grid">' +
      num('capital', f.capital, 'Account ₹', ' min="1000" step="10000"') + num('riskPct', f.riskPct, 'Risk per trade (% of the account)', ' min="0.05" step="0.25"') +
      num('maxPosPct', f.maxPosPct, 'One position at most (% of the account)', ' min="1" step="5"') +
      num('maxOpen', f.maxOpen, 'Trades open at once, at most', ' min="1" step="1"') +
      '<div class="field lab-checks">' + check('compound', f.compound, 'Re-invest the profits (risk % of the account as it grows)') + '</div></div>' +
      '<p class="note lab-plain" id="lab-plain"><b>In plain words:</b> ' + esc(plain(f)) + '</p>' +
      '<div class="lab-actions"><label class="field lab-name"><span>Name of this idea</span><input class="inp" type="text" maxlength="60" data-k="name" value="' + esc(f.name) + '"></label>' +
      '<button class="btn primary" type="button" id="lab-run">▶ Run on my laptop</button>' +
      '<button class="btn" type="button" id="lab-save">Save as a preset</button>' +
      (presets().length ? '<select class="sel" id="lab-preset" aria-label="Load a preset"><option value="">Load a preset…</option>' +
        presets().map(function (p, i) { return '<option value="' + i + '">' + esc(p.name || 'Preset ' + (i + 1)) + '</option>'; }).join('') + '</select>' +
        '<button class="btn sm danger" type="button" id="lab-preset-del" title="Delete the chosen preset">Delete preset</button>' : '') +
      '<button class="btn sm" type="button" id="lab-reset">Back to the default</button></div></section>';
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
    if (ST.err) h += '<p class="note bad">' + esc(ST.err) + '</p>';
    if (j && (j.status === 'waiting' || j.status === 'running')) {
      var pct = j.status === 'running' ? Math.max(3, j.pct || 0) : 0;
      h += '<div class="lab-run-state"><div><b>' + esc(j.name || 'Your run') + '</b> - ' + (j.status === 'waiting' ? 'waiting for your laptop' +
        (seen !== null && seen > 180 ? ' (it has not asked for a while - switch it on, it will pick this up)' : ' (it asks every 10 seconds while this page is open)') :
        'running on your laptop' + (j.note ? ': ' + esc(j.note) : '')) + '</div>' +
        '<div class="lab-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><i style="width:' + pct + '%"></i></div>' +
        (j.status === 'waiting' ? '<button class="btn sm" type="button" id="lab-cancel">Cancel</button>' : '') + '</div>';
    } else if (j && j.status === 'failed') {
      h += '<p class="note bad"><b>' + esc(j.name || 'The last run') + '</b> did not finish: ' + esc(j.error || 'failed') + '</p>';
    }
    box.innerHTML = '<div class="lab-pc">' + pc + '</div>' + h;
    var c = $('#lab-cancel', box);
    if (c) c.addEventListener('click', function () { ask({ lab: { do: 'cancel' } }).then(function () { poll(el, ST.gen); }, function () {}); });
  }

  function paintRuns(el) {
    var box = $('#lab-runs', el);
    if (!box) return;
    var list = (ST.status && ST.status.list) || [];
    if (!list.length) { box.innerHTML = '<p class="empty">No run yet - set your rules and press ▶ Run on my laptop.</p>'; return; }
    box.innerHTML = '<div class="lab-runs">' + list.map(function (r) {
      var h = r.head || {};
      return '<a class="lab-run' + (r.id === ST.itemId ? ' on' : '') + '" href="#lab/' + esc(r.id) + '"><b>' + esc(r.name || h.group || 'Run') + '</b>' +
        '<span class="sub">' + esc(r.saved) + ' · ' + esc(h.tf || '') + ' · ' + esc(h.group || '') + '</span>' +
        '<span>' + F.int(h.trades) + ' trades · win ' + (isNum(h.winPct) ? F.num(h.winPct, 1) + '%' : '–') + ' · avg ' +
        (isNum(h.avgR) ? F.num(h.avgR, 2) + 'R' : '–') + ' · account ' + (isNum(h.returnPct) ? F.pct(h.returnPct) : '–') + '</span></a>';
    }).join('') + '</div>';
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
        '% of the account). To take them: raise <b>One position at most</b> in 7 · Money.</p>';
    }
    if (w.full && w.full >= total * 0.1) {
      h += '<p class="note warn">' + F.int(w.full) + ' signals came while ' + F.int(p.maxOpen) + ' trades were already open. To take them: raise <b>Trades open at once, at most</b> in 7 · Money.</p>';
    }
    if (a.capped && a.capped >= (a.taken || 1) * 0.3) {
      h += '<p class="note">' + F.int(a.capped) + ' of the trades taken were made smaller by your position limit (' + F.num(p.maxPosPct, 0) + '%), so they risked less than ' +
        F.num(p.riskPct, 2) + '% of the account.</p>';
    }
    return h;
  }
  function tone(v) { return isNum(v) ? (v > 0 ? ' up' : v < 0 ? ' down' : '') : ''; }

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

  function paintResult(el) {
    var box = $('#lab-result', el);
    var it = ST.item;
    if (!box || !it || !it.result) return;
    var res = it.result, s = res.stats || {}, a = res.account || {}, p = res.params || {};
    var h = '<section class="card"><div class="card-head"><div><h2>' + esc(it.name || res.groupName || 'Result') + '</h2>' +
      '<p>' + esc(it.saved) + ' · candles up to ' + F.date(res.cacheUpto) + ' · signals ' + F.date(res.from) + ' – ' + F.date(res.to) +
      ' · worked out in ' + F.num(res.secs, 1) + ' s on your laptop</p></div>' +
      '<div class="actions"><button class="btn sm" type="button" id="lab-use">Use these rules</button>' +
      '<button class="btn sm danger" type="button" id="lab-del">Delete this run</button></div></div>' +
      '<p class="note lab-plain"><b>The rules:</b> ' + esc(plain(Object.assign({}, DEF, p))) + '</p>';
    if (!s.trades) {
      box.innerHTML = h + '<p class="empty">No trade matched these rules' + (res.open ? ' (' + res.open + ' still running)' : '') + '.</p></section>';
      bindResult(el, it);
      return;
    }
    h += '<h3 class="lab-h">Every signal (each trade on its own, in R)</h3><div class="tiles">' +
      ui.tile('Trades', F.int(s.trades), (res.open ? F.int(res.open) + ' still running (not counted)' : 'all finished') +
        (res.skipped && res.skipped.risk ? ' · ' + F.int(res.skipped.risk) + ' skipped (risk too big)' : '') +
        (res.skipped && res.skipped.shape ? ' · ' + F.int(res.skipped.shape) + ' Springs left out by your shape rules' : '') +
        (res.skipped && res.skipped.ema ? ' · ' + F.int(res.skipped.ema) + ' left out by your EMA rules' : '') +
        (res.skipped && res.skipped.mkt ? ' · ' + F.int(res.skipped.mkt) + ' left out by your market rule' : '')) +
      ui.tile('Win rate', F.num(s.winPct, 1) + '%', 'sold above the entry (after costs)') +
      ui.tile('Average per trade', '<span class="' + tone(s.avgR) + '">' + r2(s.avgR) + '</span>', 'median ' + r2(s.medR) + ' · this is your edge') +
      ui.tile('Total', '<span class="' + tone(s.totalR) + '">' + F.num(s.totalR, 1) + 'R</span>', 'profit factor ' + (isNum(s.pf) ? F.num(s.pf, 2) : '–')) +
      ui.tile('Reached ' + F.num(p.targetR, 2) + 'R', F.num(s.hitPct, 1) + '%', 'before the stop loss') +
      ui.tile('Average win / loss', r2(s.avgWinR) + ' / ' + r2(s.avgLossR), 'best ' + r2(s.bestR) + ' · worst ' + r2(s.worstR)) +
      ui.tile('Held', F.num(s.avgDays, 1) + ' days', 'on average · ' + F.int(s.maxLosingStreak) + ' losses in a row at worst') +
      ui.tile('Return per trade', F.pct(s.avgRet, 2), 'median ' + F.pct(s.medRet, 2) + ' · best move before the exit ' + r2(s.avgMaxR) + ' avg') + '</div>';
    h += shapeNote(res, s);
    h += '<h3 class="lab-h">Your account (' + F.inr(a.capital) + ', ' + F.num(p.riskPct, 2) + '% risk a trade, at most ' + F.int(p.maxOpen) + ' at once)</h3><div class="tiles">' +
      ui.tile('Account now', F.inr(a.final), '<span class="' + tone(a.pnl) + '">' + (a.pnl >= 0 ? '+' : '−') + F.inr(Math.abs(a.pnl)) + '</span>') +
      ui.tile('Return', '<span class="' + tone(a.returnPct) + '">' + F.pct(a.returnPct) + '</span>', isNum(a.cagr) ? F.pct(a.cagr) + ' a year over ' + F.num(a.years, 1) + ' years' : 'over ' + F.num(a.years, 1) + ' years') +
      ui.tile('Max drawdown', F.num(a.maxDD, 1) + '%', 'the deepest fall from a peak') +
      ui.tile('Trades taken', F.int(a.taken), skipWords(a) + (a.openNow ? ' · ' + F.int(a.openNow) + ' still open' : '')) + '</div>' +
      skipHint(a, p) +
      (a.blown ? '<p class="note bad">The account ran out on ' + F.date(a.blown) + ' - no trades after that.</p>' : '') +
      '<div id="lab-curve" class="lab-chart"></div>';
    h += '<div class="lab-two"><div><h3 class="lab-h">How the trades ended</h3><div id="lab-reasons"></div></div>' +
      '<div><h3 class="lab-h">Result of each trade (R)</h3><div id="lab-hist"></div></div></div>';
    h += '<h3 class="lab-h">Year by year</h3><div id="lab-years"></div>';
    h += '<h3 class="lab-h">The trades' + (res.tradesTotal > (res.trades || []).length ? ' (the newest ' + F.int(res.trades.length) + ' of ' + F.int(res.tradesTotal) + ')' : '') + '</h3><div id="lab-trades"></div>' +
      '<p class="sub">R = profit or loss in units of the risk (entry - stop): -1R = the full stop loss, 2R = twice the risk. Prices are Kite\'s - for you only. ' +
      'A candle reaching both the stop and the target counts as the stop; a gap through the stop sells at the open.</p></section>';
    box.innerHTML = h;
    var curve = (a.curve || []).map(function (c) { return { x: c[0], y: c[1] }; });
    if (curve.length > 1) ui.lineChart($('#lab-curve', box), [{ name: 'Account', points: curve, color: 'var(--accent)' }], { height: 240, label: 'Account value', fmt: function (v) { return F.inr(v); } });
    else $('#lab-curve', box).innerHTML = '';
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
    var cols = res.tradeCols || [];
    var rows = (res.trades || []).map(function (r) { var o = {}; cols.forEach(function (c, i) { o[c] = r[i]; }); return o; });
    new ui.Table({
      rows: rows, pageSize: 50, id: 'lab-trades', empty: 'No trade',
      columns: [
        { key: 'sym', label: 'Stock', type: 'sym' },
        { key: 'signal', label: 'Spring candle' },
        { key: 'zone', label: 'Zone', get: function (r) { return r.zone + (r.where ? ' · ' + r.where : ''); } },
        { key: 'entry', label: 'Entry', type: 'num', digits: 2 }, { key: 'stop', label: 'Stop', type: 'num', digits: 2 },
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
        { key: 'taken', label: 'In the account', get: function (r) { return r.taken ? 'yes' : 'skipped'; },
          // owner, 09-Nov-2026: "show the reason if I place the cursor on the word skipped" (a tap on a phone)
          html: function (r) {
            var t = r.taken ? 'yes' : 'skipped';
            return r.acct ? '<span class="lab-acct' + (r.taken ? '' : ' skip') + '" tabindex="0" data-tip="' + esc(String(r.acct).replace(/\bRs /g, '₹')) + '">' + t + ' <i aria-hidden="true">ⓘ</i></span>' : t;
          } }
      ].filter(function (c) {
        if (c.key === 'ema') return rows.some(function (r) { return r.ema; });
        if (c.key === 'upW' || c.key === 'loW' || c.key === 'dip') return rows.some(function (r) { return isNum(r[c.key]); });   // runs before 10-Nov-2026 have none
        return true;
      })
    }).mount($('#lab-trades', box));
    bindResult(el, it);
  }

  function bindResult(el, it) {
    var use = $('#lab-use', el), del = $('#lab-del', el);
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

  function bindForm(el) {
    var host = $('#lab-form', el);
    host.addEventListener('change', function (e) {
      var k = e.target.getAttribute && e.target.getAttribute('data-k');
      if (!k) return;
      var f = readForm(el);
      saveForm(f);
      if (['stop', 'after', 'trail', 'emaSupport', 'mktIndex', 'fallN'].indexOf(k) >= 0 || SHAPE_KEYS.indexOf(k) >= 0) { SB.route(true); return; }   // other fields appear / the recommendation cards follow
      var pl = $('#lab-plain', el);
      if (pl) pl.innerHTML = '<b>In plain words:</b> ' + esc(plain(f));
    });
    host.addEventListener('input', function () { saveForm(readForm(el)); var pl = $('#lab-plain', el); if (pl) pl.innerHTML = '<b>In plain words:</b> ' + esc(plain(readForm(el))); });
    // my recommendations: fill the Spring boxes (every other rule of the form stays as it is)
    host.addEventListener('click', function (e) {
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
