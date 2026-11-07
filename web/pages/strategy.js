/* Strategy settings ("Strategy Studio") - owner, 03-Nov-2026: "strategy settings page is not user friendly - my friend
   opened this page, it would take 2 days to understand ... upgrade this page to peak level. Also once a strategy is set in
   one browser it should not be deleted when reloaded. Swing, positional, long-term."
   Three steps on one page:
     1. How do you trade?  Swing / Positional / Long-term (or all) - the strategies of that style.
     2. Pick a strategy     cards with today's count, "Use for Daily Suggestions", "+ New strategy" (a ready-made starter
                            for the style, or a copy).
     3. Fine-tune it        the rules in plain words (recipe), each rule a card with a switch + a one-line explanation,
                            an "Add a rule" picker, the exit plan with a worked example, and a LIVE PREVIEW of today's
                            matches that follows every change.
   SAVING: every change is saved automatically in this browser (SB.strategies, localStorage) - one visit of the page =
   one new version, later changes of that visit update it (save opts.amend); a change that is not valid yet is kept as a
   draft in localStorage (DRAFT_KEY) and saved once it is fixed, so a reload never loses anything. Undo steps back
   through this visit's changes. Nothing is sent anywhere; Export / Import JSON moves a strategy to another device. */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, esc = ui.esc, F = ui.F, isNum = ui.isNum, $ = ui.$;

  var GROUPS = [
    { key: 'filters', set: 'filter', title: 'Skip stocks that fail these', one: 'safety check', icon: 'shield',
      help: 'Every one must pass. A stock that fails any of them is skipped (shown as Avoid).' },
    { key: 'triggers', set: 'trigger', title: 'Buy signals - when to act', one: 'signal', icon: 'bolt',
      help: 'Checked on the latest daily candle. A stock needs at least the number of signals set below. A signal set to "only watch" puts a stock on the Watch list - never in Qualified.' },
    { key: 'confirms', set: 'confirm', title: 'Must also be true', one: 'condition', icon: 'check',
      help: 'Every one must pass. When a buy signal fired but one of these fails, the stock goes on the Watch list.',
      helpScreen: 'Every one must pass for a stock to be listed.' }
  ];
  var MODES = {
    setup: ['Find entry points', 'Waits for a buy signal on the daily chart, then gives the entry, stop-loss and target.'],
    screen: ['List matching stocks', 'Lists every stock that meets the conditions today - you time the entry yourself.']
  };
  var STYLES = [
    ['swing', 'Swing', 'days to a few weeks'],
    ['positional', 'Positional', 'weeks to months'],
    ['long-term', 'Long-term', 'months to years'],
    ['intraday', 'Intraday', 'not supported - the data is daily end-of-day']
  ];
  // step 1: the trading styles, in plain words
  var STYLE_CARDS = [
    { id: 'swing', name: 'Swing', hold: 'Hold for days to a few weeks', icon: 'swing',
      looks: 'Chart signals: candle patterns, FVG zones, EMA bounces, breakouts and the reaction to results.' },
    { id: 'positional', name: 'Positional', hold: 'Hold for weeks to months', icon: 'positional',
      looks: 'Improving businesses: rising margins, FII buying, growth with a Buy signal.' },
    { id: 'long-term', name: 'Long-term', hold: 'Hold for months to years', icon: 'longterm',
      looks: 'Value and quality: cheaper than the industry, upside to the TTM target, steady growth.' },
    { id: 'all', name: 'All styles', hold: 'Every strategy in one place', icon: 'all', looks: 'Your own, the ones from your sheet and the examples.' }
  ];
  var STOPS = [['atr', 'ATR based', 'N × the stock\'s normal daily move (ATR14) below the entry'], ['pct', 'Fixed %', 'a fixed percent below the entry'],
    ['swing', 'Recent low', 'just below the lowest low of the last N days'], ['zone', 'Below the FVG zone', 'just below the gap the signal found (needs an FVG signal)']];
  var TARGETS = [['pct', 'Fixed %', 'a fixed percent above the entry'], ['rr', 'Multiple of the risk', 'N × (entry − stop-loss) above the entry']];
  var STOP_KEY = { atr: 'mult', pct: 'pct', swing: 'bars', zone: null };
  var STOP_DEF = { atr: { mult: 2 }, pct: { pct: 5 }, swing: { bars: 10 }, zone: {} };
  var STOP_LABEL = { atr: 'How many ATRs below the entry', pct: 'Percent below the entry', swing: 'Lowest low of the last … days' };
  var TARGET_KEY = { pct: 'pct', rr: 'rr' };
  var TARGET_DEF = { pct: { pct: 10 }, rr: { rr: 2 } };
  var TARGET_LABEL = { pct: 'Percent above the entry', rr: 'Times the risk (R)' };
  // readable names of the Main columns used by fieldIn / fieldRange (strategy.js keeps its own copy private)
  var FIELD_NAMES = {
    opmq: 'OPM QoQ%', opmy: 'OPM YoY%', opmqy: 'OPM Qtr YoY', promo: 'Promoter holding', fii: 'FII activity', sig: 'TTM Signal (recomputed with the current price)',
    up: 'Upside %', pevs: 'PE vs Industry PE', down52: '% from 52W high', epsg: 'TTM EPS growth %', qrev: 'QoQ revenue growth %',
    volchg: 'Volume change %', chg: 'Day %', d10: '10-day %', d30: '30-day %'
  };
  var VALUE_ORDER = ['aggressive increase', 'increasing', 'slightly increasing', 'stagnant', 'slightly decreasing', 'decreasing',
    'aggressive decrease', 'volatile', 'buy', 'avoid'];
  // every rule in one plain sentence (the rule cards and the "Add a rule" picker)
  var EXPLAIN = {
    liquidity: 'Skips thinly traded stocks: the average daily turnover (price × volume) must be at least this much.',
    notCircuitLocked: 'Skips a stock stuck at its upper or lower price band on the latest day (no real trading).',
    minPrice: 'Skips very low-priced stocks.',
    resultsNotWithin: 'Skips a stock whose quarterly results are due within these days - results can move the price sharply.',
    pattern: 'A bullish candlestick pattern (e.g. Hammer, Bullish Engulfing) on the latest daily candle - your sheet\'s Pattern column.',
    fvgFirstTouch: 'The price came back to a fair value gap (FVG - an untouched price gap) for the first time in the last few days.',
    fvgConfirmed: 'Like FVG first touch, and the next candle closed higher - the gap held as support.',
    fvgSpring: 'A Spring (a dip below support that recovers at once) on the top of a fair value gap or gap-up zone (its 1st or 2nd touch) or on the zone\'s bottom line.',
    zoneApproach: 'The price is at or just above an untouched FVG zone - a possible support area. Usually "only watch".',
    emaSupport: 'The price dipped to this moving average (EMA) and held above it - a bounce off support.',
    ttmBuy: 'Main\'s TTM Signal is Buy: the TTM target is above today\'s price, EPS growth is not negative and EPS is positive.',
    qualityWatch: 'TTM Buy, EPS not negative, and the operating margin (OPM) rising both quarter-on-quarter and year-on-year.',
    sheetConfluence: 'How many of 4 signals your Pattern Dashboard shows today: candle pattern, FVG, 10 EMA support, 21 EMA support. More = stronger.',
    fieldIn: 'A Main column must show one of the ticked words (for example OPM QoQ = Increasing).',
    fieldRange: 'A Main column\'s number must be within the limits - leave a box empty for no limit.',
    postResults: 'Your post-results set-ups from the Results Performance tab: Immediate rally, Delayed reaction, Second opportunity, Rally gains eroded.',
    resultsSupport: 'Enough of the quarter\'s figures are positive: revenue, profit, margins, EPS growth, FII.',
    resultAnnounced: 'The results came when the market could not react yet (after 3:30 PM, or on a closed day), and recently.',
    breakout: 'Today\'s close is above the highest high of the previous days, with more volume than usual.',
    closeAboveEma: 'Today\'s close is above this moving average - the trend is up.',
    emaTrend: 'The faster moving average is above the slower one - an uptrend.',
    rsiRange: 'RSI (a 0-100 momentum gauge) is inside this range - not too weak, not overheated.',
    macdBull: 'MACD (a momentum indicator) is above its signal line - momentum turning up.',
    relVolume: 'Today\'s volume is at least this many times its 20-day average.',
    pullbackToEma: 'In an uptrend, the price dipped close to this moving average - a pullback entry.',
    upsideMin: 'The TTM target price is at least this much above today\'s price.',
    peVsIndustryMax: 'The stock\'s PE is at most this many times its industry\'s PE (1 = not more expensive than the industry).'
  };
  var TOPICS = [['safety', 'Liquidity & safety'], ['chart', 'Chart signals'], ['trend', 'Trend & momentum'], ['fund', 'Business & valuation'], ['results', 'Quarterly results']];
  var TOPIC = {
    liquidity: 'safety', notCircuitLocked: 'safety', minPrice: 'safety', resultsNotWithin: 'safety',
    pattern: 'chart', fvgFirstTouch: 'chart', fvgConfirmed: 'chart', fvgSpring: 'chart', zoneApproach: 'chart', emaSupport: 'chart',
    sheetConfluence: 'chart', breakout: 'chart', pullbackToEma: 'chart',
    closeAboveEma: 'trend', emaTrend: 'trend', rsiRange: 'trend', macdBull: 'trend', relVolume: 'trend',
    ttmBuy: 'fund', qualityWatch: 'fund', fieldIn: 'fund', fieldRange: 'fund', upsideMin: 'fund', peVsIndustryMax: 'fund',
    postResults: 'results', resultsSupport: 'results', resultAnnounced: 'results'
  };
  var UP3 = ['Aggressive Increase', 'Increasing', 'Slightly Increasing'];
  // "+ New strategy": a ready-made starting point per style. The numbers are common starting values, NOT the owner's
  // rules - each starter lists them as assumptions and every one can be changed or switched off.
  var STARTERS = {
    swing: {
      mode: 'setup', style: 'swing', universe: { categories: [], minBars: 22 },
      description: 'A swing starter: liquid stocks without results in the next 3 days, a chart signal today (candle pattern, FVG first touch, 21 EMA bounce or a breakout) in an uptrend with healthy momentum.',
      filters: [{ id: 'liquidity', params: { minTurnover: 5000000 } }, { id: 'notCircuitLocked' }, { id: 'resultsNotWithin', params: { days: 3 } }],
      triggers: [{ id: 'pattern' }, { id: 'fvgFirstTouch', params: { maxAge: 1 } }, { id: 'emaSupport', params: { length: 21, maxAge: 1, touchPct: 0.5 } },
        { id: 'breakout', params: { length: 20, minRelVol: 1.5 } }],
      confirms: [{ id: 'emaTrend', params: { fast: 10, slow: 21 } }, { id: 'rsiRange', params: { min: 40, max: 70 } }],
      qualify: { minTriggers: 1 }, exits: { stop: { method: 'atr', mult: 2 }, target: { method: 'rr', rr: 2 }, minRR: 1.5 }, events: { warnDays: 7 },
      assumptions: ['A starting point, not your rules: turnover ≥ ₹50 lakh, no results within 3 days, any one chart signal, 10 EMA above 21 EMA, RSI 40-70.',
        'Stop-loss 2 × ATR below the entry, target 2 × the risk, only when reward:risk is at least 1:1.5. Change any of it below.']
    },
    positional: {
      mode: 'screen', style: 'positional', universe: { categories: [], minBars: 0 },
      description: 'A positional starter: an improving business with a Buy signal - margins rising, FII buying or steady, EPS and revenue growing.',
      filters: [{ id: 'liquidity', params: { minTurnover: 5000000 } }], triggers: [],
      confirms: [{ id: 'ttmBuy' }, { id: 'fieldIn', params: { field: 'opmq', values: UP3 } }, { id: 'fieldIn', params: { field: 'opmy', values: UP3 } },
        { id: 'fieldIn', params: { field: 'fii', values: ['Increasing', 'Stagnant'] } }, { id: 'fieldRange', params: { field: 'epsg', min: 10, max: '' } },
        { id: 'fieldRange', params: { field: 'qrev', min: 5, max: '' } }],
      qualify: { minTriggers: 0 }, exits: { stop: { method: 'pct', pct: 8 }, target: { method: 'pct', pct: 25 }, minRR: 0 }, events: { warnDays: 7 },
      assumptions: ['A starting point, not your rules: TTM Buy, OPM QoQ and YoY rising, FII increasing or stagnant, TTM EPS growth ≥ 10%, QoQ revenue growth ≥ 5%, turnover ≥ ₹50 lakh.',
        'It lists stocks; the stop-loss (8%) and target (+25%) are shown for reference only.']
    },
    'long-term': {
      mode: 'screen', style: 'long-term', universe: { categories: [], minBars: 0 },
      description: 'A long-term starter: quality at a fair price - a Buy signal, at least 25% upside to the TTM target, not more expensive than its industry, promoters not selling, growing earnings.',
      filters: [{ id: 'liquidity', params: { minTurnover: 5000000 } }], triggers: [],
      confirms: [{ id: 'ttmBuy' }, { id: 'upsideMin', params: { pct: 25 } }, { id: 'peVsIndustryMax', params: { max: 1 } },
        { id: 'fieldIn', params: { field: 'promo', values: ['Increasing', 'Stagnant'] } }, { id: 'fieldRange', params: { field: 'epsg', min: 0, max: '' } },
        { id: 'fieldIn', params: { field: 'opmy', values: UP3.concat(['Stagnant']) } }],
      qualify: { minTriggers: 0 }, exits: { stop: { method: 'pct', pct: 15 }, target: { method: 'pct', pct: 50 }, minRR: 0 }, events: { warnDays: 7 },
      assumptions: ['A starting point, not your rules: TTM Buy, upside ≥ 25%, PE at most the industry\'s, promoter holding increasing or stagnant, TTM EPS growth ≥ 0%, yearly OPM not falling, turnover ≥ ₹50 lakh.',
        'It lists stocks; the stop-loss (15%) and target (+50%) are shown for reference only.']
    }
  };
  // allowed parameter ranges: [min, max, wholeNumber, minExclusive]
  var RANGE = {
    'liquidity.minTurnover': [0, 1e11],
    'minPrice.min': [0, 1e6],
    'resultsNotWithin.days': [0, 365, true],
    'resultAnnounced.days': [0, 30, true],
    'fvgFirstTouch.maxAge': [0, 3, true],
    'fvgConfirmed.maxAge': [0, 3, true],
    'fvgSpring.maxAge': [0, 3, true],
    'emaSupport.length': [2, 250, true],
    'emaSupport.maxAge': [0, 3, true],
    'emaSupport.touchPct': [0, 10],
    'sheetConfluence.min': [1, 4, true],
    'sheetConfluence.touchPct': [0, 10],
    'breakout.length': [2, 250, true],
    'breakout.minRelVol': [0, 20],
    'closeAboveEma.length': [2, 250, true],
    'emaTrend.fast': [2, 250, true],
    'emaTrend.slow': [2, 250, true],
    'rsiRange.min': [0, 100],
    'rsiRange.max': [0, 100],
    'relVolume.min': [0, 20],
    'pullbackToEma.length': [2, 250, true],
    'pullbackToEma.pct': [0, 20],
    'upsideMin.pct': [-100, 1000],
    'peVsIndustryMax.max': [0, 100, false, true]
  };
  var AGE_HINT = '0 = today only. The sheet tags the last 4 candles, so 0-3.';
  var ICONS = {
    swing: '<path d="M2 15c2.5 0 3-7 5.5-7S10 17 12.5 17 15 6 17.5 6 20 12 22 12"/>',
    positional: '<path d="M3 20h4v-5h4v-4h4V7h6"/><path d="M17 3h4v4"/>',
    longterm: '<path d="M2 20l7-11 4 6 3-4 6 9z"/><path d="M9 9V4l4 2-4 2"/>',
    all: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
    bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
    check: '<path d="M4 12.5l5 5L20 6.5"/>',
    exit: '<path d="M4 20V4"/><path d="M4 5h12l-2 4 2 4H4"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 010 10h-4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>'
  };
  function icon(id) { return ICONS[id] ? '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + ICONS[id] + '</svg>' : ''; }

  // ---------- page state ----------
  var ST = { sel: null, style: null, resetAsk: false, delAsk: false, newOpen: false, catsOpen: false, addOpen: null };
  var DRAFTS = {};     // id -> working copy (changes not saved yet: waiting for the autosave, or not valid yet)
  var SESSION = {};    // id -> { version, base } the version this visit created (later changes amend it) + the config before it
  var UNDO = {};       // id -> earlier drafts of this visit (Undo)
  var LAST_EDIT = {};  // id -> time of the last edit (an Undo step per pause in typing)
  var SAVE = {};       // id -> { state: 'saving' | 'saved' | 'invalid' | 'failed', list }
  var COUNTS = {};     // id -> { key, run } today's result of the saved version (strategy cards)
  var LIVE = { key: null, run: null, busy: false };
  var FLASH = null;    // one-off message: { where: 'top' | 'work', cls, html }
  var SAVE_T = null, LIVE_T = null, COUNT_RUN = false, HOOKED = false;
  var CH_KEY = 'strategy-page:changes', DRAFT_KEY = 'strategy-page:drafts', STYLE_KEY = 'strategy-page:style';

  // ---------- small helpers ----------
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function sortKeys(v) {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      var o = {};
      Object.keys(v).sort().forEach(function (k) { if (v[k] !== undefined) o[k] = sortKeys(v[k]); });
      return o;
    }
    return v;
  }
  function same(a, b) { return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b)); }
  function toNum(v) { return typeof v === 'string' && v.trim() !== '' && isFinite(Number(v)) ? Number(v) : v; }
  function plural(n, one, many) { return F.int(n) + ' ' + (n === 1 ? one : (many || one + 's')); }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function paramDefs(id) { var d = SB.strategy.CONDITIONS[id]; return (d && d.params) || []; }
  function defaults(id) { var p = {}; paramDefs(id).forEach(function (pp) { p[pp.key] = clone(pp.def); }); return p; }
  function paramLabel(id, key) { var p = paramDefs(id).filter(function (x) { return x.key === key; })[0]; return p ? p.label : key; }
  function safeLabel(r) { try { return SB.strategy.label(r); } catch (e) { return (r && r.id) || '?'; } }
  function fid(g, i, k) { return 'r-' + g + '-' + i + '-' + k; }
  function barsCount(ctx) { var H = ctx.history || window.SB_HISTORY; return H && H.dates ? H.dates.length : 0; }
  function catName(id) { var c = SB.classify.categoryById(id); return c ? c.name : id; }
  function catText(arr) {
    if (!arr || !arr.length) return 'all categories';
    return arr.length <= 3 ? arr.map(catName).join(', ') : arr.length + ' categories';
  }
  function universeCount(ctx, cats) {
    if (!cats || !cats.length) return ctx.stocks.length;
    return ctx.stocks.filter(function (s) { return cats.indexOf(s.cat) >= 0; }).length;
  }
  function styleOf(id) { return STYLES.filter(function (s) { return s[0] === id; })[0]; }
  function styleName(id) { var s = styleOf(id); return s ? s[1] : id || '–'; }
  function stopText(s) {
    s = s || {};
    if (s.method === 'atr') return s.mult + ' × ATR below the entry';
    if (s.method === 'pct') return s.pct + '% below the entry';
    if (s.method === 'swing') return 'below the lowest low of the last ' + (s.bars || 10) + ' days';
    if (s.method === 'zone') return 'just below the FVG zone';
    return String(s.method || '–');
  }
  function targetText(t) {
    t = t || {};
    if (t.method === 'pct') return '+' + t.pct + '% above the entry';
    if (t.method === 'rr') return t.rr + ' × the risk above the entry';
    return String(t.method || '–');
  }
  function fmtVal(v) {
    if (v === '' || v == null) return 'blank';
    if (Array.isArray(v)) return v.length ? v.join(', ') : 'none';
    if (typeof v === 'number') return F.num(v, 4);
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }
  function firstSentence(s) {
    s = String(s || '').trim();
    var m = /^(.{20,220}?[.!?])(\s|$)/.exec(s);
    return m ? m[1] : s.length > 220 ? s.slice(0, 217) + '…' : s;
  }
  function errP(id) { return '<p class="sub down ferr" id="' + id + '-err" data-for="' + id + '" hidden></p>'; }
  function parseInput(t) {
    if (t.validity && t.validity.badInput) return 'invalid';
    var s = String(t.value).trim();
    if (s === '') return '';
    var n = Number(s);
    return isFinite(n) ? n : s;
  }
  function runOpts(ctx) {
    var H = ctx.history;
    return { usePrice: true, latestDate: H && H.dates && H.dates.length ? H.dates[H.dates.length - 1] : null, refDate: ui.iso(ctx.refDate) };
  }

  // ---------- config shape ----------
  /** Working copy with every part present and the values the engine actually uses. */
  function ensureShape(cfg) {
    var c = clone(cfg) || {};
    var C = SB.strategy.CONDITIONS;
    c.name = c.name == null ? '' : String(c.name);
    c.description = c.description == null ? '' : String(c.description);
    c.assumptions = Array.isArray(c.assumptions) ? c.assumptions.map(String) : [];
    c.mode = c.mode === 'screen' ? 'screen' : 'setup';
    c.style = c.style || 'swing';
    c.timeframe = c.timeframe || '1d';
    c.universe = c.universe || {};
    c.universe.categories = Array.isArray(c.universe.categories) ? c.universe.categories.slice() : [];
    c.universe.minBars = Math.max(2, Number(c.universe.minBars) || 17);       // as strategy.validate() uses it
    GROUPS.forEach(function (g) {
      c[g.key] = (Array.isArray(c[g.key]) ? c[g.key] : []).filter(function (r) { return r && C[r.id]; });
      c[g.key].forEach(function (r) {
        r.params = r.params || {};
        paramDefs(r.id).forEach(function (pp) {
          var v = r.params[pp.key];
          if (v == null || v === '') v = clone(pp.def);
          if (typeof pp.def === 'number') v = toNum(v);
          else if (Array.isArray(pp.def) && !Array.isArray(v)) v = String(v).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
          else if (pp.def === '' && v !== '') v = toNum(v);
          r.params[pp.key] = v;
        });
        r.enabled = r.enabled !== false;
        if (r.watchOnly) r.watchOnly = true; else delete r.watchOnly;
      });
    });
    c.qualify = c.qualify || {};
    var mt = parseInt(c.qualify.minTriggers, 10);
    c.qualify.minTriggers = c.mode === 'screen' ? (isFinite(mt) ? mt : 0) : Math.max(1, mt || 1);
    c.exits = c.exits || {};
    c.exits.stop = c.exits.stop || { method: 'atr', mult: 2 };
    c.exits.target = c.exits.target || { method: 'pct', pct: 10 };
    ['mult', 'pct', 'bars'].forEach(function (k) { if (k in c.exits.stop) c.exits.stop[k] = toNum(c.exits.stop[k]); });
    ['pct', 'rr'].forEach(function (k) { if (k in c.exits.target) c.exits.target[k] = toNum(c.exits.target[k]); });
    c.exits.minRR = Number(c.exits.minRR) || 0;
    c.events = c.events || { warnDays: 7 };
    c.events.warnDays = c.events.warnDays == null ? 0 : toNum(c.events.warnDays);
    return c;
  }
  /** Canonical form for "is anything different?" (ignores key order, version and bookkeeping). */
  function canon(cfg) {
    var c = ensureShape(cfg);
    ['id', 'version', 'updatedAt', 'source', '__valid'].forEach(function (k) { delete c[k]; });
    if (c.mode === 'screen') c.qualify.minTriggers = 0;
    GROUPS.forEach(function (g) {
      c[g.key].forEach(function (r) {
        Object.keys(r.params).forEach(function (k) { if (Array.isArray(r.params[k])) r.params[k] = r.params[k].map(String).sort(); });
      });
    });
    c.universe.categories.sort();
    return sortKeys(c);
  }
  function draftOf(STR, id) {
    if (!DRAFTS[id]) DRAFTS[id] = ensureShape(STR.get(id));
    return DRAFTS[id];
  }
  function isDirty(STR, id) {
    var saved = STR.get(id);
    return !!(DRAFTS[id] && saved && !same(canon(DRAFTS[id]), canon(saved)));
  }

  /** Plain-language list of what differs between two configs. */
  function humanChanges(aCfg, bCfg) {
    var a = canon(aCfg), b = canon(bCfg), out = [];
    function cmp(x, y, fn) { if (!same(x, y)) out.push(fn(x, y)); }
    cmp(a.name, b.name, function (x, y) { return 'Name: "' + x + '" → "' + y + '"'; });
    cmp(a.mode, b.mode, function (x, y) { return 'How it works: ' + MODES[x][0] + ' → ' + MODES[y][0]; });
    cmp(a.style, b.style, function (x, y) { return 'Trading style: ' + styleName(x) + ' → ' + styleName(y); });
    cmp(a.description, b.description, function () { return 'Description edited'; });
    cmp(a.assumptions, b.assumptions, function (x, y) { return 'Assumptions edited (' + x.length + ' → ' + y.length + ' lines)'; });
    cmp(a.universe.categories, b.universe.categories, function (x, y) { return 'Categories: ' + catText(x) + ' → ' + catText(y); });
    cmp(a.universe.minBars, b.universe.minBars, function (x, y) { return 'Minimum daily candles: ' + fmtVal(x) + ' → ' + fmtVal(y); });
    GROUPS.forEach(function (g) {
      function keyed(list) {
        var map = {}, keys = [], seen = {};
        list.forEach(function (r) { seen[r.id] = (seen[r.id] || 0) + 1; var k = r.id + '#' + seen[r.id]; map[k] = r; keys.push(k); });
        return { map: map, keys: keys };
      }
      var A = keyed(a[g.key]), B = keyed(b[g.key]);
      var keys = A.keys.concat(B.keys.filter(function (k) { return !A.map[k]; }));
      keys.forEach(function (k) {
        var ra = A.map[k], rb = B.map[k];
        if (!ra) { out.push('Added ' + g.one + ': ' + safeLabel(rb)); return; }
        if (!rb) { out.push('Removed ' + g.one + ': ' + safeLabel(ra)); return; }
        if (ra.enabled !== rb.enabled) out.push((rb.enabled ? 'Turned on ' : 'Turned off ') + g.one + ': ' + safeLabel(rb));
        if (!!ra.watchOnly !== !!rb.watchOnly) out.push(cap(g.one) + ' "' + safeLabel(rb) + '": only watch ' + (rb.watchOnly ? 'on' : 'off'));
        Object.keys(Object.assign({}, ra.params, rb.params)).forEach(function (pk) {
          if (!same(ra.params[pk], rb.params[pk])) {
            out.push(cap(g.one) + ' "' + safeLabel(ra) + '": ' + paramLabel(rb.id, pk) + ' ' + fmtVal(ra.params[pk]) + ' → ' + fmtVal(rb.params[pk]));
          }
        });
      });
    });
    if (a.mode === 'setup' && b.mode === 'setup') {
      cmp(a.qualify.minTriggers, b.qualify.minTriggers, function (x, y) { return 'Signals needed: ' + fmtVal(x) + ' → ' + fmtVal(y); });
    }
    cmp(a.exits.stop, b.exits.stop, function (x, y) { return 'Stop-loss: ' + stopText(x) + ' → ' + stopText(y); });
    cmp(a.exits.target, b.exits.target, function (x, y) { return 'Target: ' + targetText(x) + ' → ' + targetText(y); });
    cmp(a.exits.minRR, b.exits.minRR, function (x, y) { return 'Minimum reward:risk: ' + fmtVal(x) + ' → ' + fmtVal(y); });
    cmp(a.events.warnDays, b.events.warnDays, function (x, y) { return 'Results warning days: ' + fmtVal(x) + ' → ' + fmtVal(y); });
    var handled = /^(name|mode|style|description|assumptions|universe|filters|triggers|confirms|qualify|exits|events)(\.|:)/;
    SB.strategy.diff(a, b).forEach(function (s) { if (!handled.test(s)) out.push(s); });
    return out;
  }

  // ---------- validation (shown next to each field; nothing invalid is saved) ----------
  function checkNum(v, r) {
    if (v === '' || v == null || typeof v !== 'number' || !isFinite(v)) return 'Enter a number';
    if (r) {
      if (r[2] && Math.floor(v) !== v) return 'Use a whole number';
      if (r[3] ? v <= r[0] : v < r[0]) return (r[3] ? 'Must be above ' : 'Must be at least ') + F.num(r[0]);
      if (v > r[1]) return 'Must be at most ' + F.num(r[1]);
    }
    return '';
  }
  /** -> { E: {fieldId: error}, W: {fieldId: note}, list: [{id, msg}] } */
  function validateDraft(d, bars) {
    var E = {}, W = {}, list = [];
    function err(id, msg, where) { if (!E[id]) { E[id] = msg; list.push({ id: id, msg: (where ? where + ': ' : '') + msg }); } }
    function warn(id, msg) { if (!W[id]) W[id] = msg; }
    var m;
    var name = String(d.name || '').trim();
    if (!name) err('st-name', 'Give the strategy a name', 'Name');
    else if (name.length > 80) err('st-name', 'Keep the name to 80 characters or fewer', 'Name');
    if (String(d.description || '').length > 1000) err('st-desc', 'Keep the description to 1000 characters or fewer', 'Description');
    if (d.assumptions.length > 30) err('st-assump', 'Keep it to 30 lines or fewer', 'Assumptions');
    if (d.style === 'intraday') err('st-style', 'Intraday is not supported - the data is daily end-of-day. Choose Swing, Positional or Long-term.', 'Trading style');
    m = checkNum(d.universe.minBars, [2, 250, true]);
    if (m) err('st-minbars', m, 'Minimum daily candles');
    else if (bars && d.universe.minBars > bars) warn('st-minbars', 'the history file has only ' + bars + ' daily candles, so every stock would be "Insufficient data".');
    d.universe.categories.forEach(function (c) {
      if (!SB.classify.categoryById(c)) err('st-cats', 'Unknown category "' + c + '" - untick it', 'Stocks to look at');
    });
    GROUPS.forEach(function (g) {
      d[g.key].forEach(function (r, i) {
        if (r.enabled === false) return;            // a switched-off rule hides its boxes and is not checked
        var where = cap(g.one) + ' ' + (i + 1), p = r.params || {};
        paramDefs(r.id).forEach(function (pp) {
          var id = fid(g.key, i, pp.key), v = p[pp.key], msg = '';
          if (Array.isArray(pp.def)) {
            if (!Array.isArray(v) || !v.length) msg = pp.options || r.id === 'fieldIn' ? 'Tick at least one' : 'Enter at least one value';
          } else if (typeof pp.def === 'number') {
            msg = checkNum(v, RANGE[r.id + '.' + pp.key]);
            if (!msg && bars && /^(length|fast|slow)$/.test(pp.key) && v + 1 > bars) {
              warn(id, 'needs more than ' + v + ' candles - the history file has ' + bars + ', so this rule will report "not enough bars".');
            }
          } else if (pp.options) {
            if (pp.options.indexOf(v) < 0) msg = 'Choose an option';
          } else if (v !== '' && v != null && !isNum(v)) msg = 'Enter a number or leave it blank';
          if (msg) err(id, msg, where);
        });
        if (r.id === 'emaTrend' && isNum(p.fast) && isNum(p.slow) && p.fast >= p.slow) err(fid(g.key, i, 'slow'), 'The slow EMA must be longer than the fast EMA', where);
        if ((r.id === 'rsiRange' || r.id === 'fieldRange') && isNum(p.min) && isNum(p.max) && p.min > p.max) err(fid(g.key, i, 'max'), 'Max must be at least the min', where);
        if (r.id === 'fieldRange' && p.min === '' && p.max === '') warn(fid(g.key, i, 'max'), 'no limits set - passes whenever the value exists.');
      });
    });
    var trig = d.triggers.filter(function (r) { return r.enabled !== false && !r.watchOnly; }).length;
    if (d.mode !== 'screen') {
      if (!trig) err('sec-triggers', '"Find entry points" needs at least one buy signal that is on (and not "only watch").', 'Buy signals');
      m = checkNum(d.qualify.minTriggers, [1, 20, true]);
      if (m) err('st-mintrig', m, 'Signals needed');
      else if (trig && d.qualify.minTriggers > trig) err('st-mintrig', 'only ' + plural(trig, 'signal is', 'signals are') + ' on, so nothing could ever qualify - use ' + trig + ' or fewer', 'Signals needed');
    } else if (!d.confirms.filter(function (r) { return r.enabled !== false; }).length && !d.filters.length) {
      err('sec-confirms', '"List matching stocks" needs at least one condition that is on (or a safety check).', 'Must also be true');
    }
    var st = d.exits.stop, tg = d.exits.target;
    if (st.method === 'atr') { m = checkNum(st.mult, [0, 10, false, true]); if (m) err('st-stopv', m, 'Stop-loss'); }
    else if (st.method === 'pct') {
      m = checkNum(st.pct, [0, 50, false, true]);
      if (!m && st.pct >= 50) m = 'Must be below 50';
      if (m) err('st-stopv', m, 'Stop-loss');
    } else if (st.method === 'swing') {
      m = checkNum(st.bars, [2, 60, true]);
      if (m) err('st-stopv', m, 'Stop-loss');
      else if (bars && st.bars > bars) warn('st-stopv', 'only ' + bars + ' candles of history - the lookback is capped at what each stock has.');
    } else if (st.method !== 'zone') err('st-stopm', 'Choose a stop-loss method', 'Stop-loss');
    if (tg.method === 'pct') { m = checkNum(tg.pct, [0, 500, false, true]); if (m) err('st-tgtv', m, 'Target'); }
    else if (tg.method === 'rr') { m = checkNum(tg.rr, [0, 20, false, true]); if (m) err('st-tgtv', m, 'Target'); }
    else err('st-tgtm', 'Choose a target method', 'Target');
    m = checkNum(d.exits.minRR, [0, 20]);
    if (m) err('st-minrr', m, 'Minimum reward:risk');
    m = checkNum(d.events.warnDays, [0, 60, true]);
    if (m) err('st-warn', m, 'Results warning');
    return { E: E, W: W, list: list };
  }

  // ---------- badges ----------
  function sourceBadges(STR, c) {
    var conf = STR.isConfirmed(c.id), h = '';
    if (c.source === 'demo') return ui.badge('Example only', 's-warn');
    if (c.source === 'discovered') h = ui.badge('From your sheet', 's-info');
    else if (c.source === 'discovered-edited') h = ui.badge('From your sheet, edited', 's-info');
    else if (c.source === 'request') h = ui.badge('Your rules', 's-info');
    else h = ui.badge('Made by you', 's-info');
    h += conf ? ui.badge('Confirmed ✓', 's-good') : ui.badge('Not confirmed', 's-warn');
    return h;
  }

  // ---------- form fields ----------
  function fieldWrap(id, label, input, extra, wide) {
    return '<div class="field"' + (wide ? ' style="grid-column:1/-1"' : '') + '><span><label for="' + id + '">' + esc(label) + '</label></span>' +
      input + (extra || '') + errP(id) + '</div>';
  }
  function numInput(id, attrs, value) {
    return '<input class="inp" type="number" step="any" inputmode="decimal" id="' + id + '" ' + attrs + ' value="' +
      esc(isNum(value) ? String(value) : '') + '" aria-describedby="' + id + '-err">';
  }
  function numField(id, label, f, value, hint) {
    return fieldWrap(id, label, numInput(id, 'data-f="' + f + '"', value), hint ? '<p class="sub">' + hint + '</p>' : '');
  }

  // values seen in the sheet for a fieldIn column (exact match, case-insensitive)
  function valueOptions(P, field, cur) {
    var memo = P.memo['vals:' + field];
    if (!memo) {
      var counts = {}, spell = {};
      P.ctx.stocks.forEach(function (s) {
        var raw = field === 'sig' ? SB.strategy.ttmSignal(s, s.price) : s[field];
        var v = String(raw == null ? '' : raw).trim();
        if (!v) return;
        var k = v.toLowerCase();
        counts[k] = (counts[k] || 0) + 1;
        if (!spell[k]) spell[k] = v;
      });
      memo = P.memo['vals:' + field] = { counts: counts, spell: spell };
    }
    var spellAll = Object.assign({}, memo.spell);
    (cur || []).forEach(function (v) { var k = String(v).toLowerCase(); if (!spellAll[k]) spellAll[k] = String(v); });
    function rank(k) { var i = VALUE_ORDER.indexOf(k); return i < 0 ? 100 : i; }
    return Object.keys(spellAll).sort(function (x, y) { return rank(x) - rank(y) || x.localeCompare(y); }).map(function (k) {
      return { value: spellAll[k], label: spellAll[k], n: memo.counts[k] || 0 };
    });
  }
  function rangeHint(P, field) {
    var key = 'range:' + field;
    if (!(key in P.memo)) {
      var v = P.ctx.stocks.map(function (s) { return s[field]; }).filter(isNum).sort(function (a, b) { return a - b; });
      P.memo[key] = v.length ? 'In your sheet: ' + F.num(v[0], 1) + ' to ' + F.num(v[v.length - 1], 1) + ', middle value ' + F.num(v[Math.floor(v.length / 2)], 1) + ' (' + plural(v.length, 'stock') + ' with a value).' : 'No values in your sheet for this column.';
    }
    return P.memo[key];
  }

  function paramHtml(P, g, i, r, pp) {
    var id = fid(g.key, i, pp.key), v = r.params[pp.key];
    var data = 'data-g="' + g.key + '" data-i="' + i + '" data-p="' + esc(pp.key) + '"';
    var range = RANGE[r.id + '.' + pp.key];
    if (Array.isArray(pp.def)) {
      var opts = pp.options ? pp.options.map(function (o) { return { value: o, label: o }; }) : r.id === 'fieldIn' ? valueOptions(P, r.params.field, v) : null;
      if (opts) {
        var cur = (v || []).map(function (x) { return String(x).toLowerCase(); });
        return '<div class="field" style="grid-column:1/-1" role="group" aria-labelledby="' + id + '-l" id="' + id + '"><span id="' + id + '-l">' + esc(pp.label) +
          (r.id === 'fieldIn' ? ' <span class="sub">(number = stocks in your sheet with it now)</span>' : '') + '</span><div class="ss-opts">' +
          opts.map(function (o) {
            return '<label class="ss-chk"><input type="checkbox" ' + data + ' data-pt="opt" value="' + esc(o.value) + '"' +
              (cur.indexOf(String(o.value).toLowerCase()) >= 0 ? ' checked' : '') + '><span>' + esc(o.label) + (o.n != null ? ' <i>' + F.int(o.n) + '</i>' : '') + '</span></label>';
          }).join('') + '</div>' + errP(id) + '</div>';
      }
      return fieldWrap(id, pp.label + ' (comma between)', '<input class="inp" type="text" id="' + id + '" ' + data + ' data-pt="list" style="width:100%" value="' +
        esc((v || []).join(', ')) + '" aria-describedby="' + id + '-err">', '', true);
    }
    if (typeof pp.def === 'number') {
      var hint = '';
      if (pp.key === 'maxAge') hint = AGE_HINT;
      else if (range) hint = 'Allowed: ' + (range[3] ? 'above ' : '') + F.num(range[0]) + ' to ' + F.num(range[1]) + (range[2] ? ', whole numbers' : '');
      if (pp.key === 'minTurnover') hint = '50,00,000 = ₹50 lakh (the sheet uses ₹50 lakh).';
      return fieldWrap(id, pp.label, numInput(id, data + ' data-pt="num"', v), hint ? '<p class="sub">' + esc(hint) + '</p>' : '');
    }
    if (pp.options) {
      var sel = '<select class="sel" id="' + id + '" ' + data + ' data-pt="sel" style="width:100%" aria-describedby="' + id + '-err">' + pp.options.map(function (o) {
        return '<option value="' + esc(o) + '"' + (o === v ? ' selected' : '') + '>' + esc(FIELD_NAMES[o] || o) + '</option>';
      }).join('') + '</select>';
      return fieldWrap(id, pp.label, sel, r.id === 'fieldRange' ? '<p class="sub">' + esc(rangeHint(P, v)) + '</p>' : '');
    }
    // blank-or-number (fieldRange min / max)
    return fieldWrap(id, pp.label, numInput(id, data + ' data-pt="numblank" placeholder="no limit"', v));
  }

  // ---------- step 1 + 2: style and strategy cards ----------
  function styleCards(P) {
    var all = P.STR.list();
    return '<section class="card ss-step-card"><div class="card-head"><div><h2><span class="ss-n">1</span> How do you trade?</h2>' +
      '<p>Pick your style - the strategies below follow it. The data is end-of-day (one candle a day), so intraday trading is not covered.</p></div></div>' +
      '<div class="ss-styles" role="group" aria-label="Trading style">' + STYLE_CARDS.map(function (s) {
        var n = all.filter(function (c) { return s.id === 'all' || c.style === s.id; }).length, on = ST.style === s.id;
        return '<button type="button" class="ss-style' + (on ? ' on' : '') + '" aria-pressed="' + on + '" data-act="style" data-style="' + s.id + '">' +
          '<span class="ss-style-i">' + icon(s.icon) + '</span><b>' + esc(s.name) + '</b><span class="ss-style-h">' + esc(s.hold) + '</span>' +
          '<span class="ss-style-l">' + esc(s.looks) + '</span><span class="ss-style-c">' + plural(n, 'strategy', 'strategies') + '</span></button>';
      }).join('') + '</div></section>';
  }

  function countHtml(P, c) {
    var k = COUNTS[c.id], mode = c.mode === 'screen' ? 'screen' : 'setup';
    if (!k || k.key !== countKey(c)) return '<span class="sub">' + (P.ctx.history ? 'Checking today\'s stocks…' : 'Loading the daily candles…') + '</span>';
    if (k.error) return '<span class="sub">Could not check today: ' + esc(k.error) + '</span>';
    var q = k.run.counts.qualified || 0, w = k.run.counts.watch || 0;
    return '<b>' + F.int(q) + '</b> ' + (mode === 'screen' ? (q === 1 ? 'stock matches' : 'stocks match') : 'qualified') + ' today' +
      (mode === 'setup' && w ? ' <span class="sub">· ' + F.int(w) + ' on watch</span>' : '');
  }
  // the rules themselves (an automatic save in the same minute keeps the version and the time)
  function countKey(c) { return c.id + '@' + JSON.stringify(canon(c)) + '@' + (SB.ctx.market.asOf || '') + '@' + (SB.ctx.market.state || ''); }

  function stratCards(P) {
    var STR = P.STR, active = STR.activeId();
    var list = STR.list().filter(function (c) { return ST.style === 'all' || c.style === ST.style; });
    var h = '<div class="ss-cards">';
    list.forEach(function (c) {
      var sel = c.id === ST.sel, on = c.id === active;
      h += '<article class="ss-card' + (sel ? ' sel' : '') + (on ? ' active' : '') + '"' + (sel ? ' aria-current="true"' : '') + '>' +
        '<div class="ss-card-t"><span class="ss-pill">' + icon(c.style === 'positional' ? 'positional' : c.style === 'long-term' ? 'longterm' : 'swing') + esc(styleName(c.style)) + '</span>' +
        '<span class="ss-pill">' + esc(MODES[c.mode === 'screen' ? 'screen' : 'setup'][0]) + '</span>' + (on ? '<span class="badge s-good ss-inuse">In use</span>' : '') + '</div>' +
        '<h3><button type="button" class="ss-card-name" data-act="open" data-id="' + esc(c.id) + '">' + esc(c.name || c.id) + '</button></h3>' +
        '<p class="ss-card-d">' + esc(firstSentence(c.description) || 'No description.') + '</p>' +
        '<div class="tags">' + sourceBadges(STR, c) + (isDirty(STR, c.id) ? ui.badge('Changes not saved yet', 's-warn') : '') + '</div>' +
        '<div class="ss-card-n" data-count="' + esc(c.id) + '">' + countHtml(P, c) + '</div>' +
        '<div class="ss-card-a">' + (on ? '<span class="sub">Drives Daily Suggestions</span>' :
          '<button type="button" class="btn" data-act="use" data-id="' + esc(c.id) + '">Use for Daily Suggestions</button>') +
        '<button type="button" class="btn' + (sel ? '' : ' primary') + '" data-act="open" data-id="' + esc(c.id) + '"' + (sel ? ' aria-pressed="true"' : '') + '>' +
        (sel ? 'Open below ↓' : 'Open &amp; edit') + '</button></div></article>';
    });
    if (!list.length) h += '<p class="empty">No strategy of this style yet - make one with “New strategy”.</p>';
    return h + '</div>';
  }

  function newForm(P) {
    var style = ST.style === 'all' ? 'swing' : ST.style, cur = P.STR.get(ST.sel);
    return '<div class="ss-new" id="st-new"><h3>New strategy</h3><div class="form-grid">' +
      fieldWrap('st-new-name', 'Name', '<input class="inp" type="text" id="st-new-name" maxlength="80" placeholder="e.g. My swing setup" style="width:100%">') +
      '<div class="field"><span>Trading style</span><div class="ss-segs" role="radiogroup" aria-label="Trading style of the new strategy">' +
      STYLES.slice(0, 3).map(function (s) {
        return '<label class="ss-seg"><input type="radio" name="st-new-style" value="' + s[0] + '"' + (s[0] === style ? ' checked' : '') + '><span>' + esc(s[1]) + '</span></label>';
      }).join('') + '</div></div></div>' +
      '<div class="field" style="margin-top:12px"><span>Start from</span><div class="ss-from">' +
      '<label class="ss-opt"><input type="radio" name="st-new-from" value="starter" checked><span><b>A ready-made starter</b><small id="st-new-starter">' + esc(STARTERS[style].description) + '</small></span></label>' +
      (cur ? '<label class="ss-opt"><input type="radio" name="st-new-from" value="copy"><span><b>A copy of “' + esc(cur.name) + '”</b><small>All its rules, as saved' +
        (isDirty(P.STR, cur.id) ? ' plus the changes not saved yet' : '') + '.</small></span></label>' : '') +
      '</div></div><p class="sub down" id="st-new-msg" role="alert" hidden></p>' +
      '<div class="ss-row"><button type="button" class="btn primary" data-act="create">Create</button><button type="button" class="btn" data-act="new-cancel">Cancel</button></div></div>';
  }

  function pickCard(P) {
    var sc = STYLE_CARDS.filter(function (s) { return s.id === ST.style; })[0] || STYLE_CARDS[3];
    return '<section class="card ss-step-card" id="st-pickcard"><div class="card-head"><div><h2><span class="ss-n">2</span> Pick a strategy <span class="sub">· ' + esc(sc.name) + '</span></h2>' +
      '<p>“In use” = the one Daily Suggestions follows. Open any strategy to see its rules in plain words and change them.</p></div>' +
      '<button type="button" class="btn" data-act="new" aria-expanded="' + ST.newOpen + '">' + icon('plus') + ' New strategy</button></div>' +
      (ST.newOpen ? newForm(P) : '') + '<div id="st-cards">' + stratCards(P) + '</div>' + flashHtml('top') + '</section>';
  }

  // ---------- step 3: the selected strategy ----------
  function recipeHtml(P, d) {
    var on = function (k) { return d[k].filter(function (r) { return r.enabled !== false; }); };
    var li = function (rules, extra) {
      return '<ul class="ss-rl">' + rules.map(function (r) { return '<li>' + esc(safeLabel(r)) + (extra ? extra(r) : '') + '</li>'; }).join('') + '</ul>';
    };
    var steps = [];
    steps.push(['eye', 'Looks at', esc(cap(catText(d.universe.categories))) + ' - ' + plural(universeCount(P.ctx, d.universe.categories), 'stock') + ' of your watchlist.']);
    var f = on('filters');
    steps.push(['shield', 'Skips', f.length ? 'a stock that fails any of these:' + li(f) : 'nothing - every stock is checked.']);
    if (d.mode !== 'screen') {
      var t = on('triggers'), buy = t.filter(function (r) { return !r.watchOnly; }), wo = t.filter(function (r) { return r.watchOnly; });
      var need = d.qualify.minTriggers;
      steps.push(['bolt', 'Buy signal', (buy.length ? (buy.length === 1 ? 'when this happens on the latest daily candle:' : need > 1 ? 'when at least ' + need + ' of these happen on the latest daily candle:' :
        'when any one of these happens on the latest daily candle:') + li(buy) : '<span class="down">none switched on - add one below.</span>') +
        (wo.length ? '<p class="sub">Only watch (the Watch list, never Qualified): ' + wo.map(function (r) { return esc(safeLabel(r)); }).join(' · ') + '</p>' : '')]);
    }
    var c = on('confirms');
    steps.push(['check', d.mode === 'screen' ? 'Lists a stock when' : 'Must also be true', c.length ? 'all of these are true:' + li(c) : d.mode === 'screen' ? '<span class="down">no condition switched on - add one below.</span>' : 'nothing more - a buy signal is enough.']);
    steps.push(['exit', 'Exit plan', d.mode === 'screen' ? 'none - it lists stocks and you time the entry. For reference: stop-loss ' + esc(stopText(d.exits.stop)) + ', target ' + esc(targetText(d.exits.target)) + '.' :
      'entry = the latest close; stop-loss ' + esc(stopText(d.exits.stop)) + '; target ' + esc(targetText(d.exits.target)) + (d.exits.minRR > 0 ? '; only when the reward is at least ' + F.num(d.exits.minRR) + ' × the risk' : '') + '.']);
    return '<ol class="ss-recipe">' + steps.map(function (s, i) {
      return '<li><span class="ss-rn">' + icon(s[0]) + '</span><div><b>' + (i + 1) + '. ' + esc(s[1]) + '</b><div class="ss-rt">' + s[2] + '</div></div></li>';
    }).join('') + '</ol>';
  }

  function confirmHtml(P, saved) {
    var STR = P.STR, conf = STR.isConfirmed(saved.id), demo = saved.source === 'demo', items = Array.isArray(saved.assumptions) ? saved.assumptions : [];
    var h = '<div class="ss-confirm ' + (demo ? 'warn' : conf ? 'good' : 'warn') + '">';
    if (demo) {
      h += '<p><strong>An example for testing the website - not a recommendation.</strong> Make your own from it: “⋯ More” → Duplicate, or “New strategy”.</p>';
    } else {
      h += '<label class="ss-confirm-l"><input type="checkbox" id="st-confirm"' + (conf ? ' checked' : '') + '><span><strong>' +
        (conf ? 'You confirmed these rules (version ' + saved.version + ')' : 'Are these your rules? Tick to confirm') + '</strong>' +
        '<small>' + (conf ? 'Any change asks you to confirm again.' : 'Until then Daily Suggestions marks this strategy “not confirmed”.') + '</small></span></label>';
    }
    if (items.length) {
      h += '<details class="ss-assume"><summary>What was assumed (' + items.length + ')</summary><ul>' + items.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>' +
        (saved.source === 'request' ? '<p class="sub">Written from your own description: where it said "about" or "relatively", the numbers are assumptions - change them below.</p>' : '') +
        (saved.source === 'discovered' || saved.source === 'discovered-edited' ? '<p class="sub">Found in your sheet (Code.gs and your dashboards); how the rules combine into a suggestion is not written there.</p>' : '') +
        '</details>';
    }
    return h + '</div>';
  }

  function savedHtml(P) {
    var STR = P.STR, id = ST.sel, saved = STR.get(id), s = SAVE[id] || {}, dirty = isDirty(STR, id);
    var when = saved.updatedAt ? ' · ' + esc(String(saved.updatedAt).replace(/^\d{4}-\d{2}-\d{2} /, '')) : '';
    if (dirty && s.state === 'invalid') {
      return '<span class="ss-st bad">⚠ Not saved yet - fix ' + plural(s.list.length, 'thing') + ': ' + esc(s.list[0].msg) + '</span>' +
        '<button type="button" class="btn ss-sm" data-act="show-err">Show</button><button type="button" class="btn ss-sm" data-act="discard">Go back to the saved version</button>';
    }
    if (s.state === 'failed') return '<span class="ss-st bad">⚠ This browser did not keep it - its storage is blocked or full (for example a private window). Your changes stay on this page until you leave it.</span>';
    if (dirty || s.state === 'saving') return '<span class="ss-st">Saving…</span>';
    return '<span class="ss-st good">✓ Saved in this browser · version ' + saved.version + when + '</span>';
  }

  function ruleHtml(P, g, r, i, screen) {
    var def = SB.strategy.CONDITIONS[r.id], on = r.enabled !== false, lbl = safeLabel(r);
    var data = 'data-g="' + g.key + '" data-i="' + i + '"';
    var params = paramDefs(r.id);
    return '<li class="ss-rule' + (on ? '' : ' off') + '">' +
      '<div class="ss-rule-h"><label class="ss-switch" title="' + (on ? 'On - checked' : 'Off - not checked') + '"><input type="checkbox" role="switch" id="on-' + g.key + '-' + i + '" ' + data + ' data-r="enabled"' + (on ? ' checked' : '') +
      ' aria-label="' + esc(cap(g.one)) + ' on: ' + esc(lbl) + '"><span aria-hidden="true"></span></label>' +
      '<div class="ss-rule-t"><b id="lbl-' + g.key + '-' + i + '">' + esc(lbl) + '</b>' +
      '<p>' + esc(EXPLAIN[r.id] || '') + (def.kind === 'sheet' ? ' <span class="ss-src">from your sheet</span>' : '') + (def.pit === false && !screen ? ' <span class="ss-src">uses today\'s fundamentals</span>' : '') + '</p></div>' +
      '<button type="button" class="ss-x" id="rm-' + g.key + '-' + i + '" ' + data + ' data-act="remove" aria-label="Remove ' + esc(g.one) + ': ' + esc(lbl) + '" title="Remove">' + icon('x') + '</button></div>' +
      (params.length && on ? '<div class="form-grid ss-params">' + params.map(function (pp) { return paramHtml(P, g, i, r, pp); }).join('') + '</div>' : '') +
      (g.key === 'triggers' && on ? '<label class="ss-wo"><input type="checkbox" id="wo-' + g.key + '-' + i + '" ' + data + ' data-r="watchOnly"' + (r.watchOnly ? ' checked' : '') +
        '> Only watch - puts the stock on the Watch list, never makes it qualify</label>' : '') + '</li>';
  }

  function pickerHtml(g, d) {
    var C = SB.strategy.CONDITIONS, used = {};
    d[g.key].forEach(function (r) { used[r.id] = true; });
    var ids = Object.keys(C).filter(function (k) { return C[k].setGroup === g.set; });
    var open = ST.addOpen === g.key;
    var h = '<details class="ss-add" id="add-' + g.key + '"' + (open ? ' open' : '') + '><summary class="btn">' + icon('plus') + ' Add a ' + esc(g.one) + '</summary>' +
      '<div class="ss-pick"><input class="inp" type="search" data-pick-q="' + g.key + '" placeholder="Search, e.g. EMA, volume, OPM" aria-label="Search the ' + esc(g.one) + 's">';
    TOPICS.forEach(function (tp) {
      var inTopic = ids.filter(function (k) { return (TOPIC[k] || 'fund') === tp[0]; });
      if (!inTopic.length) return;
      h += '<div class="ss-pick-g"><h4>' + esc(tp[1]) + '</h4>' + inTopic.map(function (k) {
        var lbl = safeLabel({ id: k, params: defaults(k) });
        return '<button type="button" class="ss-pick-i" data-act="add" data-g="' + g.key + '" data-c="' + esc(k) + '" data-q="' + esc((lbl + ' ' + (EXPLAIN[k] || '')).toLowerCase()) + '">' +
          '<b>' + esc(lbl) + '</b><span>' + esc(EXPLAIN[k] || '') + '</span>' + (used[k] ? '<em>already added - adds another</em>' : '') + '</button>';
      }).join('') + '</div>';
    });
    return h + '</div></details>';
  }

  function groupCard(P, g, d) {
    var rules = d[g.key], on = rules.filter(function (r) { return r.enabled !== false; }).length, screen = d.mode === 'screen';
    if (g.key === 'triggers' && screen) {
      return '<section class="card ss-group" id="sec-triggers"><div class="card-head"><div><h2>' + icon(g.icon) + ' ' + esc(g.title) + '</h2>' +
        '<p>This strategy lists stocks - it does not wait for a buy signal.' + (rules.length ? ' Its ' + plural(rules.length, 'signal') + ' are kept but not used.' : '') + '</p></div>' +
        '<button type="button" class="btn" data-act="mode-setup">Use buy signals instead</button></div>' + errP('sec-triggers') + '</section>';
    }
    var empty = {
      filters: 'No safety checks - every stock is looked at.',
      triggers: 'No buy signals yet - add one, or this strategy finds nothing.',
      confirms: screen ? 'No conditions yet - add at least one.' : 'No extra conditions - after the safety checks a buy signal is enough.'
    }[g.key];
    var h = '<section class="card ss-group" id="sec-' + g.key + '"><div class="card-head"><div><h2>' + icon(g.icon) + ' ' + esc(g.title) + ' <span class="sub">· ' + on + ' of ' + rules.length + ' on</span></h2>' +
      '<p>' + esc(screen && g.helpScreen ? g.helpScreen : g.help) + '</p></div></div>';
    h += errP('sec-' + g.key);
    h += rules.length ? '<ul class="ss-rules">' + rules.map(function (r, i) { return ruleHtml(P, g, r, i, screen); }).join('') + '</ul>' : '<p class="empty">' + esc(empty) + '</p>';
    if (g.key === 'triggers') {
      h += '<div class="ss-need">' + fieldWrap('st-mintrig', 'Signals needed at the same time', numInput('st-mintrig', 'data-f="minTriggers" min="1" max="20"', d.qualify.minTriggers),
        '<p class="sub" id="st-trig-count"></p>') + '</div>';
    }
    h += pickerHtml(g, d);
    return h + '</section>';
  }

  function exampleHtml(d) {
    var st = d.exits.stop, tg = d.exits.target, e = 100, stop = null, note = '';
    if (st.method === 'pct' && isNum(st.pct)) stop = e * (1 - st.pct / 100);
    else if (st.method === 'atr' && isNum(st.mult)) { stop = e - st.mult * 3; note = ' (if its ATR is ₹3, a stock moving about 3% a day)'; }
    else if (st.method === 'swing') note = 'the lowest low of the last ' + (st.bars || 10) + ' days';
    else if (st.method === 'zone') note = 'just below the gap the signal found';
    var tgt = null;
    if (tg.method === 'pct' && isNum(tg.pct)) tgt = e * (1 + tg.pct / 100);
    else if (tg.method === 'rr' && isNum(tg.rr) && stop != null) tgt = e + tg.rr * (e - stop);
    var rr = stop != null && tgt != null && e > stop ? (tgt - e) / (e - stop) : null;
    return '<div class="ss-example"><b>Example - a stock at ₹100:</b> stop-loss ' + (stop != null ? '<b class="down">₹' + F.num(stop, 2) + '</b>' + esc(note) : esc(note || '–')) +
      ' · target ' + (tgt != null ? '<b class="up">₹' + F.num(tgt, 2) + '</b>' : tg.method === 'rr' ? esc(tg.rr + ' × the risk') : '–') +
      (rr != null ? ' · reward:risk <b>1:' + F.num(rr, 2) + '</b>' : '') + '</div>';
  }

  function exitsCard(d) {
    var st = d.exits.stop, tg = d.exits.target, sk = STOP_KEY[st.method], tk = TARGET_KEY[tg.method], screen = d.mode === 'screen';
    function opts(name, f, list, cur) {
      return '<div class="ss-from" role="radiogroup" aria-label="' + esc(name) + '">' + list.map(function (o) {
        return '<label class="ss-opt"><input type="radio" name="' + f + '" data-f="' + f + '" value="' + o[0] + '"' + (o[0] === cur ? ' checked' : '') + '><span><b>' + esc(o[1]) + '</b><small>' + esc(o[2]) + '</small></span></label>';
      }).join('') + '</div>';
    }
    var h = '<section class="card ss-group" id="sec-exits"><div class="card-head"><div><h2>' + icon('exit') + ' Exit plan</h2><p>' +
      (screen ? 'This strategy lists stocks, so these are shown for reference only - they do not change which stocks are listed.' :
        'Measured from the entry = the latest daily close. A set-up without a valid stop-loss below the entry, or with too little reward for the risk, goes on the Watch list.') +
      '</p></div></div>';
    h += '<div class="ss-exits"><div><h3>Stop-loss</h3>' + opts('Stop-loss method', 'stopMethod', STOPS, st.method) + errP('st-stopm') +
      (sk ? '<div class="form-grid" style="margin-top:8px">' + numField('st-stopv', STOP_LABEL[st.method], 'stopVal', st[sk]) + '</div>' : '') + '</div>' +
      '<div><h3>Target</h3>' + opts('Target method', 'targetMethod', TARGETS, tg.method) + errP('st-tgtm') +
      (tk ? '<div class="form-grid" style="margin-top:8px">' + numField('st-tgtv', TARGET_LABEL[tg.method], 'targetVal', tg[tk]) + '</div>' : '') + '</div></div>';
    h += '<div id="st-example">' + exampleHtml(d) + '</div>';
    h += '<div class="form-grid" style="margin-top:12px">' +
      numField('st-minrr', 'Minimum reward:risk (0 = no minimum)', 'minRR', d.exits.minRR, '2 = the target must be at least 2 × the risk.') +
      numField('st-warn', 'Warn when results are due within (days, 0 = off)', 'warnDays', d.events.warnDays, 'Adds a warning to the suggestion; it does not remove it.') +
      '</div>';
    return h + '</section>';
  }

  function howCard(d) {
    var known = STYLES.slice(0, 3).some(function (s) { return s[0] === d.style; });
    return '<section class="card ss-group" id="sec-how"><div class="card-head"><div><h2>How it works</h2><p>Your trading style, and whether it times an entry or just lists stocks.</p></div></div>' +
      '<div class="field"><span>Trading style</span><div class="ss-segs" role="radiogroup" aria-label="Trading style" id="st-style">' +
      STYLES.slice(0, 3).map(function (s) {
        return '<label class="ss-seg"><input type="radio" name="st-style" data-f="style" value="' + s[0] + '"' + (s[0] === d.style ? ' checked' : '') + '><span>' + esc(s[1]) + ' <small>' + esc(s[2]) + '</small></span></label>';
      }).join('') + '</div>' + (known ? '' : '<p class="sub down">Saved as “' + esc(styleName(d.style)) + '” - pick one of the three.</p>') + errP('st-style') + '</div>' +
      '<div class="field" style="margin-top:12px"><span>What it does</span><div class="ss-from ss-from2" role="radiogroup" aria-label="What it does">' +
      ['setup', 'screen'].map(function (m) {
        return '<label class="ss-opt"><input type="radio" name="st-mode" data-f="mode" value="' + m + '"' + (d.mode === m ? ' checked' : '') + '><span><b>' + esc(MODES[m][0]) + '</b><small>' + esc(MODES[m][1]) + '</small></span></label>';
      }).join('') + '</div></div></section>';
  }

  function moreCard(P, d) {
    var counts = {}, unc = 0, sel = d.universe.categories;
    P.ctx.stocks.forEach(function (s) { if (s.cat) counts[s.cat] = (counts[s.cat] || 0) + 1; else unc++; });
    var cats = SB.classify.CATEGORIES.slice();
    sel.forEach(function (id) { if (!SB.classify.categoryById(id)) cats.push({ id: id, name: id + ' (unknown category)' }); });
    var boxes = cats.map(function (c) {
      return '<label class="ss-chk"><input type="checkbox" data-f="cat" value="' + esc(c.id) + '"' + (sel.indexOf(c.id) >= 0 ? ' checked' : '') + '><span>' + esc(c.name) + ' <i>' + F.int(counts[c.id] || 0) + '</i></span></label>';
    }).join('');
    return '<details class="card ss-more" id="st-more"' + (ST.moreOpen ? ' open' : '') + '><summary><h2>More settings</h2><span class="sub">Which stocks to look at, description, assumptions, minimum candles</span></summary>' +
      '<div class="ss-more-b"><div class="field"><span>Stocks to look at: <b id="st-cats-sum"></b></span>' +
      '<p class="sub">Tick none to look at every category. Stocks without a category (' + F.int(unc) + ') are only included when none is ticked.</p>' +
      '<div class="ss-opts" role="group" aria-label="Categories" id="st-cats">' + boxes + '</div>' +
      '<div style="margin-top:8px"><button type="button" class="btn ss-sm" data-act="cats-clear">Untick all (every category)</button></div>' + errP('st-cats') + '</div>' +
      '<div class="form-grid" style="margin-top:14px">' +
      fieldWrap('st-desc', 'Description', '<textarea class="inp" id="st-desc" data-f="description" rows="3" aria-describedby="st-desc-err">' + esc(d.description) + '</textarea>', '', true) +
      fieldWrap('st-assump', 'Assumptions (one per line - shown under “What was assumed”)', '<textarea class="inp" id="st-assump" data-f="assumptions" rows="4" aria-describedby="st-assump-err">' +
        esc(d.assumptions.join('\n')) + '</textarea>', '', true) +
      numField('st-minbars', 'Minimum daily candles per stock', 'minBars', d.universe.minBars, 'Fewer = shown as Insufficient data. <span id="st-bars-hint"></span>') +
      '</div></div></details>';
  }

  function historyCard() {
    return '<details class="card ss-more" id="st-histd"' + (ST.histOpen ? ' open' : '') + '><summary><h2>Change history &amp; backup</h2><span class="sub">Every version saved in this browser · export / import a file to move it to another device</span></summary>' +
      '<div class="ss-more-b"><div class="ss-row" style="margin-bottom:10px"><button type="button" class="btn" data-act="export">Export this strategy (JSON file)</button>' +
      '<button type="button" class="btn" data-act="import">Import a strategy file</button></div><div id="st-hist"></div></div></details>';
  }

  function liveCard() {
    return '<section class="card ss-live" id="st-live" aria-live="polite"><span class="sg-eyebrow">Live preview · today</span><div id="st-live-b">' + ui.skeleton(3) + '</div></section>';
  }

  function workHead(P, saved, d) {
    var STR = P.STR, id = saved.id, active = STR.activeId() === id, preset = !!SB.strategy.PRESETS[id];
    var edited = preset && !same(saved, SB.strategy.PRESETS[id]);
    var h = '<div class="ss-head"><div class="ss-head-l"><span class="ss-n">3</span><div class="ss-head-name">' +
      '<label class="sg-eyebrow" for="st-name">Fine-tune - the name</label><input class="ss-name" type="text" id="st-name" data-f="name" maxlength="120" value="' + esc(d.name) + '" aria-describedby="st-name-err">' +
      errP('st-name') + '<div class="tags" id="st-badges">' + sourceBadges(STR, saved) + '</div></div></div>' +
      '<div class="ss-head-r"><p class="ss-saved" id="st-saved" aria-live="polite">' + savedHtml(P) + '</p><div class="ss-row">' +
      '<button type="button" class="btn" id="st-undo" data-act="undo"' + ((UNDO[id] || []).length ? '' : ' disabled') + ' title="Undo the last change">' + icon('undo') + ' Undo</button>' +
      (active ? '<span class="btn ss-inuse-b" aria-disabled="true">✓ In use for Daily Suggestions</span>' : '<button type="button" class="btn primary" id="st-use" data-act="use" data-id="' + esc(id) + '">Use for Daily Suggestions</button>') +
      '<details class="ss-menu"><summary class="btn">⋯ More</summary><div class="ss-menu-b">' +
      '<button type="button" class="btn" data-act="dup">Duplicate as my own copy</button>' +
      '<button type="button" class="btn" data-act="export">Export (JSON file)</button>' +
      (preset ? '<button type="button" class="btn" data-act="reset"' + (edited ? '' : ' disabled title="Already the original"') + '>Reset to the original</button>' :
        '<button type="button" class="btn danger" data-act="delete">Delete this strategy</button>') +
      '</div></details></div></div></div>';
    if (ST.resetAsk && preset) {
      h += '<div class="note warn" style="margin-top:12px"><strong>Reset “' + esc(saved.name) + '” to the original?</strong> Your saved versions of it (now version ' + saved.version +
        '), any change not saved yet and its confirmation are removed from this browser. The history keeps a “reset” line.' +
        '<div class="ss-row" style="margin-top:8px"><button type="button" class="btn danger" id="st-reset-yes" data-act="reset-yes">Yes, reset</button>' +
        '<button type="button" class="btn" data-act="ask-no">Cancel</button></div></div>';
    }
    if (ST.delAsk && !preset) {
      h += '<div class="note bad" style="margin-top:12px"><strong>Delete “' + esc(saved.name) + '” from this browser?</strong> Its rules and history are removed' +
        (active ? ' and Daily Suggestions goes back to “' + esc((STR.get('sheet') || {}).name || 'sheet') + '”' : '') + '. Export it first if you may want it back.' +
        '<div class="ss-row" style="margin-top:8px"><button type="button" class="btn danger" id="st-del-yes" data-act="delete-yes">Yes, delete</button>' +
        '<button type="button" class="btn" data-act="ask-no">Cancel</button></div></div>';
    }
    return h;
  }

  function flashHtml(where) {
    if (!FLASH || FLASH.where !== where) return '';
    return '<div class="note' + (FLASH.cls ? ' ' + FLASH.cls : '') + '" id="st-flash-' + where + '" tabindex="-1" role="status" style="margin-top:12px">' + FLASH.html + '</div>';
  }
  function chKey(id, version, at) { return id + '|' + version + '|' + at; }
  function noteChanges(id, version, at, lines, oldAt) {
    var all = ui.store.get(CH_KEY, {}) || {};
    if (oldAt) delete all[chKey(id, version, oldAt)];
    if (lines && lines.length) all[chKey(id, version, at)] = lines.slice(0, 40);
    var keys = Object.keys(all);
    if (keys.length > 300) keys.slice(0, keys.length - 300).forEach(function (k) { delete all[k]; });
    ui.store.set(CH_KEY, all);
  }
  function listHtml(items) {
    return '<ul style="margin:6px 0 0;padding-left:18px">' + items.map(function (s) { return '<li style="overflow-wrap:anywhere">' + esc(s) + '</li>'; }).join('') + '</ul>';
  }
  function changesHtml(list) {
    if (!list || !list.length) return '<span class="sub">–</span>';
    return '<ul class="checks" style="margin:0">' + list.map(function (s) {
      s = String(s);
      if (s.length > 160) {
        return '<li style="display:block"><details><summary style="cursor:pointer;overflow-wrap:anywhere">' + esc(s.slice(0, 120)) + '…</summary><span style="overflow-wrap:anywhere">' + esc(s) + '</span></details></li>';
      }
      return '<li style="overflow-wrap:anywhere">' + esc(s) + '</li>';
    }).join('') + '</ul>';
  }

  // ---------- drawing ----------
  function draw(P, focusId) {
    var el = P.el, STR = P.STR;
    var prev = document.activeElement && el.contains(document.activeElement) ? document.activeElement.id : null;
    P.memo = P.memo || {};
    if (!STR.get(ST.sel)) ST.sel = STR.activeId();
    var id = ST.sel, saved = STR.get(id), d = draftOf(STR, id);

    var h = '<div class="page-head"><div><h1>Strategy settings</h1>' +
      '<p>Choose how you trade, pick a strategy, then fine-tune it in plain words - the preview shows today\'s matches as you change it. ' +
      '<strong>Every change is saved automatically in this browser</strong> (nothing is uploaded); a reload keeps it. To use it on another device: Export / Import.</p></div>' +
      '<div class="actions"><button type="button" class="btn" data-act="import">Import a strategy file</button>' +
      '<input type="file" id="st-file" accept=".json,application/json" hidden>' +
      '<a class="btn" href="#suggestions">Daily Suggestions →</a></div></div>';
    h += styleCards(P);
    h += pickCard(P);
    h += '<section class="ss-work" id="st-editor" aria-label="Fine-tune ' + esc(saved.name || id) + '">' + workHead(P, saved, d) + flashHtml('work') +
      '<div class="ss-cols"><div class="ss-main">' +
      '<section class="card ss-group"><div class="card-head"><div><h2>In plain words</h2><p>What “' + esc(saved.name || id) + '” does, step by step - it follows your changes.</p></div></div>' +
      '<div id="st-recipe">' + recipeHtml(P, d) + '</div><div id="st-confirmbox">' + confirmHtml(P, saved) + '</div></section>' +
      howCard(d) + GROUPS.map(function (g) { return groupCard(P, g, d); }).join('') + exitsCard(d) + moreCard(P, d) + historyCard() +
      '</div><aside class="ss-side">' + liveCard() + '</aside></div></section>';
    el.innerHTML = h;
    drawHistory(P);
    refresh(P);
    drawLive(P);
    loadCounts(P);

    var flashEl = FLASH ? $('#st-flash-' + FLASH.where, el) : null;
    FLASH = null;
    var target = focusId === 'flash' ? flashEl : (focusId || prev) ? document.getElementById(focusId || prev) : null;
    if (target && el.contains(target)) target.focus({ preventScroll: focusId !== 'flash' });
  }

  function drawHistory(P) {
    var el = P.el, STR = P.STR, id = ST.sel, saved = STR.get(id), box = $('#st-hist', el);
    if (!box) return;
    var humanStore = ui.store.get(CH_KEY, {}) || {}, hist = STR.history(id);
    if (!hist.length) {
      box.innerHTML = '<p class="empty">' + (SB.strategy.PRESETS[id] ? 'No saved versions yet - this is the original. Your first change becomes version ' + (saved.version + 1) + '.' : 'No history recorded.') + '</p>';
      return;
    }
    new ui.Table({
      rows: hist, pageSize: 10, tools: false,
      columns: [
        { key: 'version', label: 'Version', type: 'num', digits: 0 },
        { key: 'at', label: 'Saved (IST)', type: 'datetime' },
        { key: 'changes', label: 'What changed', wrap: true, get: function (r) { return (r.changes || []).join('; '); },
          html: function (r) {
            var human = humanStore[chKey(id, r.version, r.at)];
            var note = r.note ? '<p class="sub" style="margin-bottom:4px">' + esc(r.note) + '</p>' : '';
            if (!human) return note + changesHtml(r.changes);
            return note + changesHtml(human) + ((r.changes || []).length ? '<details style="margin-top:4px"><summary class="sub" style="cursor:pointer">Technical log</summary>' + changesHtml(r.changes) + '</details>' : '');
          } }
      ]
    }).mount(box);
  }

  /** The parts that follow a saved change, without touching the inputs (typing keeps its place). */
  function partial(P) {
    var el = P.el, STR = P.STR, saved = STR.get(ST.sel);
    var cards = $('#st-cards', el); if (cards) cards.innerHTML = stratCards(P);
    var cb = $('#st-confirmbox', el); if (cb) cb.innerHTML = confirmHtml(P, saved);
    var bd = $('#st-badges', el); if (bd) bd.innerHTML = sourceBadges(STR, saved);
    drawHistory(P);
    refresh(P);
    loadCounts(P);
  }

  /** In-place update after a value edit (no re-render, so typing keeps focus). */
  function refresh(P) {
    var el = P.el, STR = P.STR, ctx = P.ctx, id = ST.sel, d = draftOf(STR, id);
    var bars = barsCount(ctx), v = validateDraft(d, bars);
    el.querySelectorAll('.ferr').forEach(function (p) {
      var f = p.getAttribute('data-for'), msg = v.E[f] || '', w = !msg && v.W[f] ? v.W[f] : '';
      p.textContent = msg || (w ? 'Note: ' + w : '');
      p.className = 'sub ferr' + (msg ? ' down' : '');
      p.hidden = !(msg || w);
      var inp = document.getElementById(f);
      if (inp) { if (msg) inp.setAttribute('aria-invalid', 'true'); else inp.removeAttribute('aria-invalid'); }
    });
    if (v.list.length && isDirty(STR, id)) SAVE[id] = { state: 'invalid', list: v.list };
    else if (SAVE[id] && SAVE[id].state === 'invalid') SAVE[id] = { state: isDirty(STR, id) ? 'saving' : 'saved' };
    var sv = $('#st-saved', el); if (sv) sv.innerHTML = savedHtml(P);
    var un = $('#st-undo', el); if (un) un.disabled = !(UNDO[id] || []).length;
    var rc = $('#st-recipe', el); if (rc) rc.innerHTML = recipeHtml(P, d);
    var ex = $('#st-example', el); if (ex) ex.innerHTML = exampleHtml(d);
    var cs = $('#st-cats-sum', el);
    if (cs) cs.textContent = cap(catText(d.universe.categories)) + ' · ' + plural(universeCount(ctx, d.universe.categories), 'stock');
    var tc = $('#st-trig-count', el);
    if (tc) {
      var on = d.triggers.filter(function (r) { return r.enabled !== false && !r.watchOnly; }).length;
      tc.textContent = plural(on, 'signal') + ' on. 1 = any one of them is enough; 2 = two must happen together (stronger, fewer stocks).';
    }
    var bh = $('#st-bars-hint', el);
    if (bh) bh.textContent = bars ? 'The history file has up to ' + bars + ' daily candles per stock.' : '';
  }

  // ---------- live preview (the draft, on today's data) ----------
  function liveKey(P) { return JSON.stringify(canon(draftOf(P.STR, ST.sel))) + '@' + (SB.ctx.market.asOf || '') + '@' + barsCount(P.ctx); }
  function schedulePreview(P) {
    clearTimeout(LIVE_T);
    LIVE_T = setTimeout(function () { LIVE_T = null; if (P.el.isConnected) drawLive(P); }, 450);
  }
  function drawLive(P) {
    var el = P.el, box = $('#st-live-b', el), ctx = P.ctx, STR = P.STR;
    if (!box) return;
    if (!ctx.history) {
      box.innerHTML = ui.skeleton(3) + '<p class="sub">Loading the daily candles…</p>';
      if (SB.loadHistory) SB.loadHistory().then(function () { if (el.isConnected) drawLive(P); }, function (e) {
        if (el.isConnected) box.innerHTML = '<p class="sub down">The daily candles could not be loaded: ' + esc(e && e.message || e) + '</p>';
      });
      return;
    }
    var id = ST.sel, d = draftOf(STR, id), v = validateDraft(d, barsCount(ctx)), useSaved = !!v.list.length;
    var key = useSaved ? 'saved@' + countKey(STR.get(id)) : liveKey(P);
    if (LIVE.key !== key) {
      try {
        var cfg = useSaved ? STR.get(id) : clone(d);
        LIVE = { key: key, run: SB.strategy.run(cfg, ctx.stocks, STR.candles() || {}, runOpts(ctx)), saved: useSaved };
      } catch (e) { LIVE = { key: key, error: (e && e.message) || String(e) }; }
    }
    if (LIVE.error) { box.innerHTML = '<p class="sub down">The preview could not run: ' + esc(LIVE.error) + '</p>'; return; }
    var r = LIVE.run, screen = r.config.mode === 'screen', n = r.results.length, q = r.counts.qualified || 0, active = STR.activeId() === id;
    var parts = screen ? [['qualified', 'Match', 's-good'], ['avoid', 'Skipped by a safety check', 's-bad'], ['none', 'A condition failed', 's-none'], ['insufficient', 'Not enough data', 's-muted']]
      : [['qualified', 'Qualified', 's-good'], ['watch', 'Watch', 's-warn'], ['avoid', 'Skipped by a safety check', 's-bad'], ['none', 'No buy signal', 's-none'], ['insufficient', 'Not enough data', 's-muted']];
    if (screen && r.counts.watch) parts.splice(1, 0, ['watch', 'Watch', 's-warn']);
    var h = (LIVE.saved ? '<p class="ss-live-w">Showing the saved version - fix the marked field to see your change.</p>' : '') +
      '<div class="ss-live-n"><b class="sg-big-n" id="st-live-n">' + F.int(q) + '</b><span>' + (screen ? (q === 1 ? 'stock matches' : 'stocks match') : 'qualified') + '</span></div>' +
      '<p class="sub">of ' + plural(n, 'stock') + ' checked · newest candle ' + F.date(r.latestDate) + '</p>' +
      '<div class="ss-dist">' + parts.map(function (p) {
        var c = r.counts[p[0]] || 0;
        return '<div class="ss-dist-r"><span>' + esc(p[1]) + '</span><i class="' + p[2] + '"><em style="width:' + (n ? Math.max(c ? 2 : 0, c / n * 100) : 0).toFixed(1) + '%"></em></i><b>' + F.int(c) + '</b></div>';
      }).join('') + '</div>';
    var top = r.lists.qualified.slice(0, 5);
    h += '<h3 class="ss-live-t">' + (top.length ? 'Top ' + top.length + ' by score' : 'Nothing ' + (screen ? 'matches' : 'qualified') + ' today') + '</h3>';
    if (top.length) {
      h += '<ol class="ss-top">' + top.map(function (x) {
        var s = ctx.bySym[x.sym];
        return '<li>' + ui.stockCell(x.sym, s && s.name) + '<span class="ss-sc" title="' + esc(x.scoreNote || '') + '">' + F.int(x.score) + '</span></li>';
      }).join('') + '</ol>';
    } else {
      h += '<p class="sub">' + (r.counts.watch ? plural(r.counts.watch, 'stock is', 'stocks are') + ' on the Watch list. ' : '') + 'Switch off or loosen a rule to see more.</p>';
    }
    h += '<p class="sub" style="margin-top:10px">' + (active ? '<a href="#suggestions">See every one in Daily Suggestions →</a>' :
      'Press “Use for Daily Suggestions” to see every one there.') + '</p>' +
      '<p class="sub">A research shortlist from your rules - not a buy recommendation.</p>';
    box.innerHTML = h;
  }

  // today's count on every strategy card (the saved versions, one after another so the page stays responsive)
  function loadCounts(P) {
    if (!P.ctx.history) { if (SB.loadHistory) SB.loadHistory().then(function () { if (P.el.isConnected) loadCounts(P); }, function () { /* the cards say so */ }); return; }
    if (COUNT_RUN) return;
    var todo = P.STR.list().filter(function (c) { return (ST.style === 'all' || c.style === ST.style) && !(COUNTS[c.id] && COUNTS[c.id].key === countKey(c)); });
    if (!todo.length) return;
    COUNT_RUN = true;
    var c = todo[0];
    setTimeout(function () {
      P.STR.runActive(c.id).then(function (run) { COUNTS[c.id] = { key: countKey(c), run: run }; }, function (e) { COUNTS[c.id] = { key: countKey(c), error: (e && e.message) || String(e) }; })
        .then(function () {
          COUNT_RUN = false;
          var p2 = P.el.isConnected ? P : CUR.P;               // the page may have been drawn again meanwhile
          if (!p2 || !p2.el.isConnected) return;
          var box = p2.el.querySelector('[data-count="' + c.id + '"]');
          if (box) box.innerHTML = countHtml(p2, c);
          loadCounts(p2);
        });
    }, 20);
  }

  // ---------- saving: automatic ----------
  function persistDrafts(STR) {
    var out = {}, any = false;
    Object.keys(DRAFTS).forEach(function (id) {
      var saved = STR.get(id);
      if (saved && isDirty(STR, id)) { out[id] = { v: saved.version, at: saved.updatedAt || '', d: DRAFTS[id] }; any = true; }
    });
    if (any) ui.store.set(DRAFT_KEY, out); else ui.store.del(DRAFT_KEY);
  }
  function restoreDrafts(STR) {
    var all = ui.store.get(DRAFT_KEY, null);
    if (!all || typeof all !== 'object') return;
    Object.keys(all).forEach(function (id) {
      var x = all[id], saved = STR.get(id);
      if (!DRAFTS[id] && x && x.d && saved && saved.version === x.v && (saved.updatedAt || '') === (x.at || '')) DRAFTS[id] = ensureShape(x.d);
    });
  }
  function scheduleSave(P) {
    var id = ST.sel;
    persistDrafts(P.STR);                       // a reload from now on keeps the change, even before it is saved
    if (!SAVE[id] || SAVE[id].state !== 'invalid') SAVE[id] = { state: 'saving' };
    clearTimeout(SAVE_T);
    SAVE_T = setTimeout(function () { SAVE_T = null; autoSave(P, id); }, 700);
  }
  function flushSave(P) {
    if (!SAVE_T) return;
    clearTimeout(SAVE_T); SAVE_T = null;
    autoSave(P, ST.sel);
  }
  function persisted(STR, id, c) { var g = STR.get(id); return !!(g && g.version === c.version && same(canon(g), canon(c))); }
  function autoSave(P, id) {
    var STR = P.STR, saved = STR.get(id), d = DRAFTS[id];
    if (!saved || !d || !isDirty(STR, id)) {
      SAVE[id] = { state: 'saved' };
      persistDrafts(STR);
      if (P.el.isConnected && ST.sel === id) refresh(P);
      return;
    }
    var v = validateDraft(d, barsCount(P.ctx));
    if (v.list.length) { SAVE[id] = { state: 'invalid', list: v.list }; if (P.el.isConnected && ST.sel === id) refresh(P); return; }
    var sess = SESSION[id];
    var res = STR.save(clone(d), '', sess ? { amend: sess.version, base: sess.base } : {});
    if (!res.ok) {
      SAVE[id] = { state: 'invalid', list: (res.errors || ['not valid']).map(function (m) { return { id: '', msg: m }; }) };
      if (P.el.isConnected && ST.sel === id) refresh(P);
      return;
    }
    if (res.unchanged) { delete DRAFTS[id]; persistDrafts(STR); SAVE[id] = { state: 'saved' }; if (P.el.isConnected && ST.sel === id) refresh(P); return; }
    var c = res.config;
    if (!persisted(STR, id, c)) { SAVE[id] = { state: 'failed' }; if (P.el.isConnected && ST.sel === id) refresh(P); return; }
    if (!res.amended) SESSION[id] = { version: c.version, base: saved };
    noteChanges(id, c.version, c.updatedAt, humanChanges(SESSION[id].base, c), res.amended ? res.prevAt : null);
    // the draft stays the working copy only if it differs (it does not: it was just saved)
    delete DRAFTS[id];
    persistDrafts(STR);
    SAVE[id] = { state: 'saved' };
    if (P.el.isConnected && ST.sel === id) partial(P);
  }

  // ---------- actions ----------
  function setFlash(where, cls, html) { FLASH = { where: where, cls: cls, html: html }; }
  var STORAGE_MSG = 'This browser did not keep it - its storage is blocked or full (for example a private window).';

  function select(P, id) {
    flushSave(P);
    ST.sel = id; ST.resetAsk = false; ST.delAsk = false; FLASH = null;
    selectHash(id);
    draw(P);
    var ed = $('#st-editor', P.el);
    if (ed && ed.scrollIntoView) ed.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function doUse(P, id) {
    var STR = P.STR, c = STR.get(id);
    if (!c) return;
    flushSave(P);
    STR.setActive(id);
    var note = c.source === 'demo' ? ' It is an example only - its suggestions are labelled DEMO.' : !STR.isConfirmed(id) ? ' Tick “Are these your rules?” below when they are right.' : '';
    setFlash(ST.sel === id ? 'work' : 'top', 'good', '<strong>“' + esc(c.name) + '” now drives Daily Suggestions.</strong>' + esc(note) + ' <a href="#suggestions">Open Daily Suggestions →</a>');
    draw(P, 'flash');
  }

  function doConfirm(P, yes) {
    var STR = P.STR, id = ST.sel;
    flushSave(P);
    var saved = STR.get(id);
    if (saved.source === 'demo') { draw(P); return; }
    if (isDirty(STR, id)) {
      setFlash('work', 'warn', 'Fix the marked field first - only saved rules can be confirmed.');
      draw(P, 'flash');
      return;
    }
    STR.confirm(id, yes);
    partial(P);
    var cb = $('#st-confirm', P.el); if (cb) cb.focus();
  }

  function pushUndo(P, id, force) {
    var now = Date.now();
    if (force || now - (LAST_EDIT[id] || 0) > 1200) {
      var st = UNDO[id] = UNDO[id] || [];
      st.push(clone(draftOf(P.STR, id)));               // the draft, or the saved version right after an automatic save
      if (st.length > 40) st.shift();
    }
    LAST_EDIT[id] = force ? 0 : now;
  }
  function doUndo(P) {
    var id = ST.sel, st = UNDO[id] || [];
    if (!st.length) return;
    DRAFTS[id] = ensureShape(st.pop());
    LAST_EDIT[id] = 0;
    draw(P, 'st-undo');
    scheduleSave(P);
    schedulePreview(P);
  }

  function doReset(P) {
    var STR = P.STR, id = ST.sel, name = STR.get(id).name;
    clearTimeout(SAVE_T); SAVE_T = null;
    STR.resetToPreset(id);
    delete DRAFTS[id]; delete SESSION[id]; delete UNDO[id]; delete SAVE[id];
    persistDrafts(STR);
    ST.resetAsk = false;
    setFlash('work', 'good', '<strong>' + esc(name) + '</strong> is back to the original. Its confirmation was cleared; the history keeps a “reset” line.');
    draw(P, 'flash');
  }

  function doDelete(P) {
    var STR = P.STR, id = ST.sel, name = STR.get(id).name;
    clearTimeout(SAVE_T); SAVE_T = null;
    if (!STR.remove(id)) { setFlash('work', 'bad', 'Not deleted.'); draw(P, 'flash'); return; }
    delete DRAFTS[id]; delete SESSION[id]; delete UNDO[id]; delete SAVE[id]; delete COUNTS[id];
    persistDrafts(STR);
    ST.delAsk = false;
    ST.sel = STR.activeId();
    setFlash('top', 'good', '<strong>“' + esc(name) + '” was deleted</strong> from this browser.');
    draw(P, 'flash');
  }

  function newId() { return 'custom-' + Date.now(); }
  function createFrom(P, src, name, style, note) {
    var STR = P.STR, c = clone(src), nid = newId();
    c.id = nid; c.source = 'custom'; c.name = name; c.style = style || c.style;
    delete c.version; delete c.updatedAt;
    var res = STR.save(c, note);
    if (!res.ok) return { error: (res.errors || ['unknown error']).join('; ') };
    if (!STR.get(nid)) return { error: STORAGE_MSG };
    return { id: nid, config: res.config };
  }

  function doDuplicate(P) {
    var STR = P.STR, id = ST.sel, saved = STR.get(id), dirty = isDirty(STR, id);
    flushSave(P);
    dirty = isDirty(STR, id);
    var src = dirty ? DRAFTS[id] : ensureShape(STR.get(id));
    if (dirty) {
      var v = validateDraft(src, barsCount(P.ctx));
      if (v.list.length) {
        setFlash('work', 'bad', '<strong>Not duplicated.</strong> Fix the marked field first:' + listHtml(v.list.map(function (x) { return x.msg; })));
        draw(P, 'flash');
        return;
      }
    }
    var out = createFrom(P, src, String(saved.name || 'Strategy').slice(0, 72) + ' (my copy)', null, 'copied from ' + saved.name + ' v' + saved.version);
    if (out.error) { setFlash('work', 'bad', '<strong>Not duplicated:</strong> ' + esc(out.error)); draw(P, 'flash'); return; }
    ST.sel = out.id; ST.resetAsk = false; ST.delAsk = false;
    if (ST.style !== 'all' && out.config.style !== ST.style) ST.style = out.config.style;
    setFlash('work', 'good', '<strong>Created “' + esc(out.config.name) + '”</strong> - your own copy. Rename it above and change any rule; it saves by itself.' +
      (saved.source === 'demo' ? ' It started from the example strategy: check every rule before you confirm it as yours.' : ''));
    draw(P, 'flash');
  }

  function doCreate(P) {
    var el = P.el, STR = P.STR, nm = $('#st-new-name', el), msg = $('#st-new-msg', el);
    var name = String(nm && nm.value || '').trim();
    var style = (el.querySelector('input[name="st-new-style"]:checked') || {}).value || 'swing';
    var from = (el.querySelector('input[name="st-new-from"]:checked') || {}).value || 'starter';
    if (!name) { if (msg) { msg.textContent = 'Give the new strategy a name.'; msg.hidden = false; } if (nm) nm.focus(); return; }
    if (name.length > 80) { if (msg) { msg.textContent = 'Keep the name to 80 characters or fewer.'; msg.hidden = false; } if (nm) nm.focus(); return; }
    flushSave(P);
    var src;
    if (from === 'copy' && STR.get(ST.sel)) {
      src = isDirty(STR, ST.sel) ? DRAFTS[ST.sel] : ensureShape(STR.get(ST.sel));
      if (validateDraft(src, barsCount(P.ctx)).list.length) src = ensureShape(STR.get(ST.sel));
    } else src = Object.assign({}, clone(STARTERS[style]), { timeframe: '1d' });
    var out = createFrom(P, src, name, style, from === 'copy' ? 'copied from ' + STR.get(ST.sel).name : 'new ' + styleName(style) + ' strategy from the starter');
    if (out.error) { if (msg) { msg.textContent = 'Not created: ' + out.error; msg.hidden = false; } return; }
    ST.sel = out.id; ST.newOpen = false; ST.style = style;
    selectHash(out.id);
    setFlash('work', 'good', '<strong>Created “' + esc(name) + '”</strong> (' + esc(styleName(style)) + '). Below are its rules in plain words - switch rules on or off, change the numbers; the preview on the right follows every change and it saves by itself.');
    draw(P, 'flash');
    var ed = $('#st-editor', el);
    if (ed && ed.scrollIntoView) ed.scrollIntoView({ block: 'start' });
  }

  function doExport(P) {
    var STR = P.STR, id = ST.sel;
    flushSave(P);
    var saved = STR.get(id), name = id + '-v' + saved.version + '.json';
    ui.download(name, STR.exportJson(id), 'application/json;charset=utf-8');
    setFlash('work', '', 'Downloaded <strong>' + esc(name) + '</strong> (version ' + saved.version + '). On the other device: Strategy settings → “Import a strategy file”.');
    draw(P, 'flash');
  }

  /** Imported files may claim any source: only real preset ids keep a sheet / DEMO source. */
  function prepImport(text, STR) {
    var cfg;
    try { cfg = JSON.parse(text); } catch (e) { return { text: text }; }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { text: text };
    var sid = String(cfg.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
    var preset = sid && SB.strategy.PRESETS[sid], cur = sid ? STR.get(sid) : null;
    if (preset) cfg.source = preset.source === 'demo' ? 'demo' : preset.source === 'request' ? 'request' : cur && cur.source === 'discovered-edited' ? 'discovered-edited' : 'discovered';
    else cfg.source = 'custom';
    return { text: JSON.stringify(cfg), existed: !!cur, sid: sid };
  }

  function doImport(P, file) {
    var STR = P.STR;
    if (!file) return;
    if (file.size > 512 * 1024) {
      setFlash('top', 'bad', '<strong>Not imported:</strong> ' + esc(file.name) + ' is larger than 512 KB - a strategy file is only a few KB.');
      draw(P, 'flash');
      return;
    }
    flushSave(P);
    var fr = new FileReader();
    fr.onload = function () {
      var prep = prepImport(String(fr.result || ''), STR);
      var before = prep.sid ? STR.get(prep.sid) : null;
      var res = STR.importJson(prep.text);
      if (res && res.ok && !res.unchanged && before && res.config.id === before.id) noteChanges(before.id, res.config.version, res.config.updatedAt, humanChanges(before, res.config));
      if (!res || !res.ok) {
        setFlash('top', 'bad', '<strong>Not imported from ' + esc(file.name) + ':</strong>' + listHtml((res && res.errors) || ['unknown error']));
      } else {
        var c = res.config;
        delete DRAFTS[c.id]; delete SESSION[c.id]; delete UNDO[c.id];
        persistDrafts(STR);
        ST.sel = c.id; ST.resetAsk = false; ST.delAsk = false;
        if (ST.style !== 'all' && c.style !== ST.style) ST.style = STYLES.some(function (s) { return s[0] === c.style; }) ? c.style : 'all';
        if (!res.unchanged && !persisted(STR, c.id, c)) setFlash('top', 'bad', '<strong>Not imported.</strong> ' + esc(STORAGE_MSG));
        else if (res.unchanged) setFlash('top', '', '“' + esc(c.name) + '” in ' + esc(file.name) + ' is the same as the saved version ' + c.version + ' - nothing changed.');
        else {
          setFlash('top', 'good', '<strong>Imported “' + esc(c.name) + '” as version ' + c.version + '</strong>' +
            (prep.existed ? ' - it updated the strategy with the same id; older versions stay in its history.' : ' - a new strategy.') +
            ' Check its rules and confirm them below.' + (c.source === 'demo' ? ' It is the example strategy and stays labelled DEMO.' : ''));
        }
      }
      if (P.el.isConnected) draw(P, 'flash');
    };
    fr.onerror = function () {
      setFlash('top', 'bad', 'Could not read ' + esc(file.name) + '.');
      if (P.el.isConnected) draw(P, 'flash');
    };
    fr.readAsText(file);
  }

  function onEdit(P, t, type) {
    var STR = P.STR, id = ST.sel, el = P.el;
    var isText = t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && /^(text|number|search)$/.test(t.type));
    if (isText ? type !== 'input' : type !== 'change') return;
    if (t.hasAttribute('data-pick-q') || /^st-new-/.test(t.id || '') || /^st-new-/.test(t.name || '')) return;
    var f = t.getAttribute('data-f'), g = t.getAttribute('data-g');
    if (!f && !(g && t.getAttribute('data-i') != null)) return;
    var d = draftOf(STR, id), saved = STR.get(id), structural = false;
    pushUndo(P, id, !isText);
    if (f) {
      switch (f) {
        case 'name': d.name = t.value; break;
        case 'description': d.description = t.value; break;
        case 'assumptions': d.assumptions = t.value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean); break;
        case 'mode':
          d.mode = t.value === 'screen' ? 'screen' : 'setup';
          if (d.mode === 'setup' && !(d.qualify.minTriggers >= 1)) d.qualify.minTriggers = 1;
          structural = true; break;
        case 'style': d.style = t.value; if (ST.style !== 'all') ST.style = t.value; structural = true; break;
        case 'minBars': d.universe.minBars = parseInput(t); break;
        case 'cat':
          d.universe.categories = [].filter.call(el.querySelectorAll('input[data-f="cat"]'), function (x) { return x.checked; }).map(function (x) { return x.value; });
          break;
        case 'minTriggers': d.qualify.minTriggers = parseInput(t); break;
        case 'stopMethod': {
          var sm = t.value, ss = ensureShape(saved).exits.stop;
          d.exits.stop = ss.method === sm ? clone(ss) : Object.assign({ method: sm }, clone(STOP_DEF[sm] || {}));
          structural = true; break;
        }
        case 'stopVal': if (STOP_KEY[d.exits.stop.method]) d.exits.stop[STOP_KEY[d.exits.stop.method]] = parseInput(t); break;
        case 'targetMethod': {
          var tm = t.value, ts = ensureShape(saved).exits.target;
          d.exits.target = ts.method === tm ? clone(ts) : Object.assign({ method: tm }, clone(TARGET_DEF[tm] || {}));
          structural = true; break;
        }
        case 'targetVal': if (TARGET_KEY[d.exits.target.method]) d.exits.target[TARGET_KEY[d.exits.target.method]] = parseInput(t); break;
        case 'minRR': d.exits.minRR = parseInput(t); break;
        case 'warnDays': d.events.warnDays = parseInput(t); break;
        default: return;
      }
    } else {
      var i = +t.getAttribute('data-i'), r = d[g] && d[g][i];
      if (!r) return;
      var rk = t.getAttribute('data-r'), pk = t.getAttribute('data-p'), pt = t.getAttribute('data-pt');
      if (rk === 'enabled') { r.enabled = t.checked; structural = true; }
      else if (rk === 'watchOnly') { if (t.checked) r.watchOnly = true; else delete r.watchOnly; structural = true; }
      else if (pk) {
        if (pt === 'opt') {
          r.params[pk] = [].filter.call(el.querySelectorAll('input[data-pt="opt"][data-g="' + g + '"][data-i="' + i + '"]'), function (x) {
            return x.checked && x.getAttribute('data-p') === pk;
          }).map(function (x) { return x.value; });
        } else if (pt === 'list') r.params[pk] = t.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        else if (pt === 'num' || pt === 'numblank') r.params[pk] = parseInput(t);
        else if (pt === 'sel') {
          r.params[pk] = t.value;
          if (r.id === 'fieldIn' && pk === 'field') {           // keep only values that exist for the new column
            var allowed = valueOptions(P, t.value, []).map(function (o) { return o.value.toLowerCase(); });
            r.params.values = (r.params.values || []).filter(function (x) { return allowed.indexOf(String(x).toLowerCase()) >= 0; });
          }
          structural = true;
        } else return;
        var lb = $('#lbl-' + g + '-' + i, el);
        if (lb) lb.textContent = safeLabel(r);
      } else return;
    }
    if (structural) draw(P); else refresh(P);
    scheduleSave(P);
    schedulePreview(P);
  }

  function bind(P) {
    var el = P.el;
    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b || !el.contains(b) || b.disabled) return;
      var act = b.getAttribute('data-act'), STR = P.STR, id = ST.sel;
      var menu = b.closest('details.ss-menu');
      if (menu) menu.open = false;
      if (act === 'style') {
        ST.style = b.getAttribute('data-style'); ui.store.set(STYLE_KEY, ST.style); ST.newOpen = false;
        var list = STR.list().filter(function (c) { return ST.style === 'all' || c.style === ST.style; });
        if (list.length && !list.some(function (c) { return c.id === ST.sel; })) {
          flushSave(P);
          ST.sel = (list.filter(function (c) { return c.id === STR.activeId(); })[0] || list[0]).id;
          selectHash(ST.sel);
        }
        draw(P, b.id ? b.id : null);
        var nb = el.querySelector('[data-act="style"][data-style="' + ST.style + '"]'); if (nb) nb.focus();
      } else if (act === 'open') select(P, b.getAttribute('data-id'));
      else if (act === 'use') doUse(P, b.getAttribute('data-id') || id);
      else if (act === 'new') { ST.newOpen = !ST.newOpen; draw(P); var nn = $('#st-new-name', el); if (nn) nn.focus(); }
      else if (act === 'new-cancel') { ST.newOpen = false; draw(P); }
      else if (act === 'create') doCreate(P);
      else if (act === 'dup') doDuplicate(P);
      else if (act === 'reset') { ST.resetAsk = true; ST.delAsk = false; draw(P, 'st-reset-yes'); }
      else if (act === 'delete') { ST.delAsk = true; ST.resetAsk = false; draw(P, 'st-del-yes'); }
      else if (act === 'ask-no') { ST.resetAsk = false; ST.delAsk = false; draw(P); }
      else if (act === 'reset-yes') doReset(P);
      else if (act === 'delete-yes') doDelete(P);
      else if (act === 'export') doExport(P);
      else if (act === 'import') { var fi = $('#st-file', el); if (fi) fi.click(); }
      else if (act === 'undo') doUndo(P);
      else if (act === 'discard') {
        clearTimeout(SAVE_T); SAVE_T = null;
        delete DRAFTS[id]; delete SAVE[id]; UNDO[id] = [];
        persistDrafts(STR);
        setFlash('work', '', 'Back to the saved version ' + STR.get(id).version + '.');
        draw(P, 'flash');
      } else if (act === 'show-err') {
        var s = SAVE[id], fe = s && s.list && s.list[0] ? document.getElementById(s.list[0].id) : null;
        if (fe) { if (fe.scrollIntoView) fe.scrollIntoView({ block: 'center' }); if (fe.focus) fe.focus(); }
      } else if (act === 'mode-setup') {
        pushUndo(P, id, true);
        var dm = draftOf(STR, id);
        dm.mode = 'setup';
        if (!(dm.qualify.minTriggers >= 1)) dm.qualify.minTriggers = 1;
        draw(P, 'sec-triggers');
        scheduleSave(P); schedulePreview(P);
      } else if (act === 'cats-clear') {
        pushUndo(P, id, true);
        draftOf(STR, id).universe.categories = [];
        el.querySelectorAll('input[data-f="cat"]').forEach(function (x) { x.checked = false; });
        refresh(P); scheduleSave(P); schedulePreview(P);
      } else if (act === 'add') {
        var g = b.getAttribute('data-g'), cid = b.getAttribute('data-c');
        if (!cid || !SB.strategy.CONDITIONS[cid]) return;
        pushUndo(P, id, true);
        var d = draftOf(STR, id);
        d[g].push({ id: cid, params: defaults(cid), enabled: true });
        var ni = d[g].length - 1;
        ST.addOpen = null;
        draw(P, 'on-' + g + '-' + ni);
        var li = $('#on-' + g + '-' + ni, el);
        if (li && li.scrollIntoView) li.scrollIntoView({ block: 'center' });
        scheduleSave(P); schedulePreview(P);
      } else if (act === 'remove') {
        var rg = b.getAttribute('data-g'), ri = +b.getAttribute('data-i'), dd = draftOf(STR, id);
        pushUndo(P, id, true);
        if (dd[rg] && dd[rg][ri]) dd[rg].splice(ri, 1);
        draw(P, 'sec-' + rg);
        scheduleSave(P); schedulePreview(P);
      }
    });
    el.addEventListener('change', function (e) {
      var t = e.target;
      if (t.id === 'st-file') { var file = t.files && t.files[0]; t.value = ''; doImport(P, file); return; }
      if (t.id === 'st-confirm') { doConfirm(P, t.checked); return; }
      if (t.name === 'st-new-style') {
        var sx = $('#st-new-starter', P.el); if (sx && STARTERS[t.value]) sx.textContent = STARTERS[t.value].description;
        return;
      }
      onEdit(P, t, 'change');
    });
    el.addEventListener('input', function (e) {
      var t = e.target, q = t.getAttribute && t.getAttribute('data-pick-q');
      if (q) {
        var words = String(t.value || '').toLowerCase().split(/\s+/).filter(Boolean);
        var box = t.closest('.ss-pick');
        box.querySelectorAll('.ss-pick-i').forEach(function (it) {
          var txt = it.getAttribute('data-q') || '';
          it.hidden = !words.every(function (w) { return txt.indexOf(w) >= 0; });
        });
        box.querySelectorAll('.ss-pick-g').forEach(function (gr) { gr.hidden = !gr.querySelector('.ss-pick-i:not([hidden])'); });
        return;
      }
      onEdit(P, t, 'input');
    });
    el.addEventListener('toggle', function (e) {
      var t = e.target;
      if (!t || !t.id) return;
      if (t.id === 'st-more') ST.moreOpen = t.open;
      if (t.id === 'st-histd') ST.histOpen = t.open;
      if (/^add-/.test(t.id)) {
        ST.addOpen = t.open ? t.id.slice(4) : ST.addOpen === t.id.slice(4) ? null : ST.addOpen;
        if (t.open) { var qi = t.querySelector('[data-pick-q]'); if (qi) qi.focus({ preventScroll: true }); }
      }
    }, true);
  }

  function selectHash(id) {
    try { if (window.history && window.history.replaceState) window.history.replaceState(null, '', '#strategy/' + encodeURIComponent(id)); } catch (e) { /* ignore */ }
  }

  SB.page('strategy', {
    render: function (el, params, ctx) {
      var STR = SB.strategies;
      if (!STR || !SB.strategy) { el.innerHTML = '<div class="note bad">The strategy engine did not load, so strategies cannot be shown.</div>'; return; }
      restoreDrafts(STR);
      if (params && params[0] && STR.get(params[0])) ST.sel = params[0];
      if (!ST.sel || !STR.get(ST.sel)) ST.sel = STR.activeId();
      if (!ST.style) {         // the style picked last time, else the style of the strategy in use
        var keep = ui.store.get(STYLE_KEY, null);
        ST.style = STYLE_CARDS.some(function (s) { return s.id === keep; }) ? keep : (STR.get(STR.activeId()) || {}).style || 'all';
        if (!STYLE_CARDS.some(function (s) { return s.id === ST.style; })) ST.style = 'all';
      }
      var selStyle = (STR.get(ST.sel) || {}).style;
      if (ST.style !== 'all' && selStyle !== ST.style) ST.style = STYLES.slice(0, 3).some(function (s) { return s[0] === selStyle; }) ? selStyle : 'all';
      ST.resetAsk = false; ST.delAsk = false;
      var P = { el: el, ctx: ctx, STR: STR, memo: {} };
      bind(P);
      draw(P);
      if (!HOOKED) {        // leaving the page or the tab: a change waiting for its autosave is saved at once
        HOOKED = true;
        window.addEventListener('pagehide', function () { if (SAVE_T && CUR.P) flushSave(CUR.P); });
        document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden' && SAVE_T && CUR.P) flushSave(CUR.P); });
      }
      CUR.P = P;
      // candle history (the preview and the counts) - loaded in the background
      if (!ctx.history && SB.loadHistory) {
        SB.loadHistory().then(function () { if (el.isConnected) { refresh(P); drawLive(P); loadCounts(P); } }, function () { /* the preview says so */ });
      }
    }
  });
  var CUR = { P: null };
})();
