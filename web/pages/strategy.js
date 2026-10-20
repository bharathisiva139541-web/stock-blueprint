/* Strategy settings: view, configure, version and confirm the strategy that
   drives Daily Suggestions.
   - Strategies come from SB.strategies (ui/strategy-state.js): the presets read
     from the sheet, the DEMO preset and the viewer's own copies.
   - Edits stay in an in-memory draft (this tab only) until saved. A save
     validates, bumps the version, records the changes and clears the
     confirmation, so every version is confirmed on its own.
   - Everything the viewer changes is stored only in this browser
     (localStorage through SB.strategies); export / import as JSON files.
     Nothing is sent anywhere. */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, esc = ui.esc, F = ui.F, isNum = ui.isNum, $ = ui.$;

  var GROUPS = [
    { key: 'filters', set: 'filter', title: 'Filters', one: 'filter',
      help: 'Must all pass. A stock that fails any filter is marked Avoid.' },
    { key: 'triggers', set: 'trigger', title: 'Triggers', one: 'trigger',
      help: 'Signal types checked on the latest daily candle. A stock needs the minimum number of firing triggers (set below) to qualify. Watch-only triggers can only produce Watch.' },
    { key: 'confirms', set: 'confirm', title: 'Requirements', one: 'requirement',
      help: 'Must all pass. In setup mode a stock whose trigger fired but a requirement failed is shown as Watch; in screen mode every requirement must pass for a match.' }
  ];
  var MODES = { setup: 'Setup - entry timing with stop-loss and target', screen: 'Screen - fundamental screen, no entry timing' };
  var STYLES = [
    ['swing', 'Swing', 'days to a few weeks'],
    ['positional', 'Positional', 'weeks to months'],
    ['long-term', 'Long-term', 'months to years'],
    ['intraday', 'Intraday', 'not supported - the data is daily end-of-day']
  ];
  var STOPS = [['atr', 'ATR multiple below entry'], ['pct', 'Percent below entry'], ['swing', 'Below the recent swing low'], ['zone', 'Below the FVG zone (from a zone trigger)']];
  var TARGETS = [['pct', 'Percent above entry'], ['rr', 'Multiple of the risk (R)']];
  var STOP_KEY = { atr: 'mult', pct: 'pct', swing: 'bars', zone: null };
  var STOP_DEF = { atr: { mult: 2 }, pct: { pct: 5 }, swing: { bars: 10 }, zone: {} };
  var STOP_LABEL = { atr: 'ATR multiple (stop = entry − N × ATR14)', pct: 'Stop % below entry (above 0, below 50)', swing: 'Swing-low lookback (bars)' };
  var TARGET_KEY = { pct: 'pct', rr: 'rr' };
  var TARGET_DEF = { pct: { pct: 10 }, rr: { rr: 2 } };
  var TARGET_LABEL = { pct: 'Target % above entry', rr: 'Target in R (multiples of the risk)' };
  // readable names of the Main columns used by fieldIn / fieldRange (strategy.js keeps its own copy private)
  var FIELD_NAMES = {
    opmq: 'OPM QoQ%', opmy: 'OPM YoY%', promo: 'Promoter holding', fii: 'FII activity', sig: 'TTM Signal (recomputed with the current price)',
    up: 'Upside %', pevs: 'PE vs Industry PE', down52: '% from 52W high', epsg: 'TTM EPS growth %', qrev: 'QoQ revenue growth %',
    volchg: 'Volume change %', chg: 'Day %', d10: '10-day %', d30: '30-day %'
  };
  var VALUE_ORDER = ['aggressive increase', 'increasing', 'slightly increasing', 'stagnant', 'slightly decreasing', 'decreasing',
    'aggressive decrease', 'volatile', 'buy', 'avoid'];
  // allowed parameter ranges: [min, max, wholeNumber, minExclusive]
  var RANGE = {
    'liquidity.minTurnover': [0, 1e11],
    'minPrice.min': [0, 1e6],
    'resultsNotWithin.days': [0, 365, true],
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
  var AGE_HINT = 'The sheet only tags the last 4 candles, so 0-3.';

  // ---------- page state (this tab only - nothing here is persisted) ----------
  var ST = { sel: null, resetAsk: false, catsOpen: false, pendOpen: false };
  var DRAFTS = {};     // id -> working copy with unsaved edits
  var NOTES = {};      // id -> change note being typed
  var TESTS = {};      // id -> { version, result } | { version, error }
  var TESTING = {};    // id -> true while a test runs
  var FLASH = null;    // one-off message: { where: 'top'|'top-detail'|'confirm'|'save'|'test', cls, html }
  // plain-language change lists per saved version, for the history table (this browser only)
  var CH_KEY = 'strategy-page:changes';

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
  function styleText(s) {
    for (var i = 0; i < STYLES.length; i++) if (STYLES[i][0] === s) return STYLES[i][1] + ' (' + STYLES[i][2] + ')';
    return s || '–';
  }
  function stopText(s) {
    s = s || {};
    if (s.method === 'atr') return s.mult + ' × ATR14 below entry';
    if (s.method === 'pct') return s.pct + '% below entry';
    if (s.method === 'swing') return 'below the ' + (s.bars || 10) + '-bar low';
    if (s.method === 'zone') return 'below the FVG zone';
    return String(s.method || '–');
  }
  function targetText(t) {
    t = t || {};
    if (t.method === 'pct') return '+' + t.pct + '% from entry';
    if (t.method === 'rr') return t.rr + ' R';
    return String(t.method || '–');
  }
  function fmtVal(v) {
    if (v === '' || v == null) return 'blank';
    if (Array.isArray(v)) return v.length ? v.join(', ') : 'none';
    if (typeof v === 'number') return F.num(v, 4);
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }
  function errP(id) { return '<p class="sub down ferr" id="' + id + '-err" data-for="' + id + '" hidden></p>'; }
  function parseInput(t) {
    if (t.validity && t.validity.badInput) return 'invalid';
    var s = String(t.value).trim();
    if (s === '') return '';
    var n = Number(s);
    return isFinite(n) ? n : s;
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
    cmp(a.mode, b.mode, function (x, y) { return 'Mode: ' + x + ' → ' + y; });
    cmp(a.style, b.style, function (x, y) { return 'Style: ' + x + ' → ' + y; });
    cmp(a.description, b.description, function () { return 'Description edited'; });
    cmp(a.assumptions, b.assumptions, function (x, y) { return 'Assumptions edited (' + x.length + ' → ' + y.length + ' lines)'; });
    cmp(a.universe.categories, b.universe.categories, function (x, y) { return 'Categories: ' + catText(x) + ' → ' + catText(y); });
    cmp(a.universe.minBars, b.universe.minBars, function (x, y) { return 'Minimum daily bars: ' + fmtVal(x) + ' → ' + fmtVal(y); });
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
        if (!!ra.watchOnly !== !!rb.watchOnly) out.push(cap(g.one) + ' "' + safeLabel(rb) + '": watch only ' + (rb.watchOnly ? 'on' : 'off'));
        Object.keys(Object.assign({}, ra.params, rb.params)).forEach(function (pk) {
          if (!same(ra.params[pk], rb.params[pk])) {
            out.push(cap(g.one) + ' "' + safeLabel(ra) + '": ' + paramLabel(rb.id, pk) + ' ' + fmtVal(ra.params[pk]) + ' → ' + fmtVal(rb.params[pk]));
          }
        });
      });
    });
    if (a.mode === 'setup' && b.mode === 'setup') {
      cmp(a.qualify.minTriggers, b.qualify.minTriggers, function (x, y) { return 'Minimum firing triggers: ' + fmtVal(x) + ' → ' + fmtVal(y); });
    }
    cmp(a.exits.stop, b.exits.stop, function (x, y) { return 'Stop-loss: ' + stopText(x) + ' → ' + stopText(y); });
    cmp(a.exits.target, b.exits.target, function (x, y) { return 'Target: ' + targetText(x) + ' → ' + targetText(y); });
    cmp(a.exits.minRR, b.exits.minRR, function (x, y) { return 'Minimum reward:risk: ' + fmtVal(x) + ' → ' + fmtVal(y); });
    cmp(a.events.warnDays, b.events.warnDays, function (x, y) { return 'Results warning days: ' + fmtVal(x) + ' → ' + fmtVal(y); });
    var handled = /^(name|mode|style|description|assumptions|universe|filters|triggers|confirms|qualify|exits|events)(\.|:)/;
    SB.strategy.diff(a, b).forEach(function (s) { if (!handled.test(s)) out.push(s); });
    return out;
  }

  // ---------- validation (before save, shown inline) ----------
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
    if (d.style === 'intraday') err('st-style', 'Intraday is not supported - the data is daily end-of-day. Choose swing, positional or long-term.', 'Style');
    m = checkNum(d.universe.minBars, [2, 250, true]);
    if (m) err('st-minbars', m, 'Minimum daily bars');
    else if (bars && d.universe.minBars > bars) warn('st-minbars', 'the history file has only ' + bars + ' daily candles, so every stock would be "Insufficient data".');
    d.universe.categories.forEach(function (c) {
      if (!SB.classify.categoryById(c)) err('st-cats', 'Unknown category "' + c + '" - untick it', 'Universe');
    });
    GROUPS.forEach(function (g) {
      d[g.key].forEach(function (r, i) {
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
      if (!trig) err('sec-triggers', 'Setup mode needs at least one trigger that is on and not watch-only.', 'Triggers');
      m = checkNum(d.qualify.minTriggers, [1, 20, true]);
      if (m) err('st-mintrig', m, 'Minimum firing triggers');
      else if (trig && d.qualify.minTriggers > trig) err('st-mintrig', 'only ' + plural(trig, 'trigger is', 'triggers are') + ' on, so nothing could ever qualify - use ' + trig + ' or fewer', 'Minimum firing triggers');
    } else if (!d.confirms.filter(function (r) { return r.enabled !== false; }).length && !d.filters.length) {
      err('sec-confirms', 'A screen needs at least one requirement that is on (or a filter).', 'Requirements');
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
    if (c.source === 'demo') return ui.badge('DEMO', 's-warn');
    if (c.source === 'discovered') h = conf ? ui.badge('From your sheet', 's-info') : ui.badge('From your sheet (unconfirmed)', 's-warn');
    else if (c.source === 'discovered-edited') h = ui.badge('Edited from your sheet', 's-info');
    else h = ui.badge('Custom', '');
    if (conf) h += ui.badge('Confirmed v' + c.version, 's-good');
    else if (c.source !== 'discovered') h += ui.badge('Not confirmed', 's-warn');
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
  function selectField(id, label, f, opts, cur, hint) {
    var known = opts.some(function (o) { return o[0] === cur; });
    var h = '<select class="sel" id="' + id + '" data-f="' + f + '" style="width:100%" aria-describedby="' + id + '-err">' +
      (known ? '' : '<option value="" selected>Choose…</option>') +
      opts.map(function (o) {
        return '<option value="' + esc(o[0]) + '"' + (o[0] === cur ? ' selected' : '') + (o[2] && o[0] !== cur ? ' disabled' : '') + '>' + esc(o[1]) + '</option>';
      }).join('') + '</select>';
    return fieldWrap(id, label, h, hint ? '<p class="sub">' + hint + '</p>' : '');
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
      var n = memo.counts[k] || 0;
      return { value: spellAll[k], label: spellAll[k] + ' · ' + plural(n, 'stock') };
    });
  }
  function rangeHint(P, field) {
    var key = 'range:' + field;
    if (!(key in P.memo)) {
      var v = P.ctx.stocks.map(function (s) { return s[field]; }).filter(isNum).sort(function (a, b) { return a - b; });
      P.memo[key] = v.length ? 'In your sheet: ' + F.num(v[0], 1) + ' to ' + F.num(v[v.length - 1], 1) + ', median ' + F.num(v[Math.floor(v.length / 2)], 1) + ' (' + plural(v.length, 'stock') + ' with a value).' : 'No values in your sheet for this column.';
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
          (r.id === 'fieldIn' ? ' (counts = stocks in your sheet now)' : '') + '</span><div style="display:flex;flex-wrap:wrap;gap:4px 16px">' +
          opts.map(function (o) {
            return '<label style="display:inline-flex;gap:6px;align-items:center"><input type="checkbox" ' + data + ' data-pt="opt" value="' + esc(o.value) + '"' +
              (cur.indexOf(String(o.value).toLowerCase()) >= 0 ? ' checked' : '') + '> ' + esc(o.label) + '</label>';
          }).join('') + '</div>' + errP(id) + '</div>';
      }
      return fieldWrap(id, pp.label + ' (comma separated)', '<input class="inp" type="text" id="' + id + '" ' + data + ' data-pt="list" style="width:100%" value="' +
        esc((v || []).join(', ')) + '" aria-describedby="' + id + '-err">', '', true);
    }
    if (typeof pp.def === 'number') {
      var hint = '';
      if (pp.key === 'maxAge') hint = AGE_HINT;
      else if (range) hint = 'Allowed: ' + (range[3] ? 'above ' : '') + F.num(range[0]) + ' to ' + F.num(range[1]) + (range[2] ? ', whole numbers' : '');
      if (pp.key === 'minTurnover') hint = '₹50,00,000 = ₹50 lakh. The sheet uses ₹50 lakh.';
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

  function ruleHtml(P, g, r, i) {
    var def = SB.strategy.CONDITIONS[r.id], on = r.enabled !== false, lbl = safeLabel(r);
    var data = 'data-g="' + g.key + '" data-i="' + i + '"';
    var params = paramDefs(r.id);
    return '<li style="padding:12px 0"><div class="grow">' +
      '<div style="display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;justify-content:space-between">' +
      '<b id="lbl-' + g.key + '-' + i + '" style="min-width:0;overflow-wrap:anywhere">' + esc(lbl) + '</b>' +
      '<span class="tags">' + (def.kind === 'sheet' ? ui.badge('From your sheet', 's-info') : ui.badge('Standard rule', '')) +
      (r.watchOnly ? ui.badge('Watch only', 's-info') : '') + (on ? '' : ui.badge('Off - not checked', '')) + '</span></div>' +
      (def.kind === 'sheet' && def.ref ? '<p class="sub" style="overflow-wrap:anywhere">Source: ' + esc(def.ref) + '</p>' : '') +
      (def.pit === false ? '<p class="sub">Uses today\'s fundamentals from the sheet (left out of backtests).</p>' : '') +
      (params.length ? '<div class="form-grid" style="margin-top:8px">' + params.map(function (pp) { return paramHtml(P, g, i, r, pp); }).join('') + '</div>' : '') +
      '<div style="display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center;margin-top:8px">' +
      '<label style="display:inline-flex;gap:6px;align-items:center"><input type="checkbox" id="on-' + g.key + '-' + i + '" ' + data + ' data-r="enabled"' + (on ? ' checked' : '') + '> Rule on</label>' +
      (g.key === 'triggers' ? '<label style="display:inline-flex;gap:6px;align-items:center"><input type="checkbox" id="wo-' + g.key + '-' + i + '" ' + data + ' data-r="watchOnly"' + (r.watchOnly ? ' checked' : '') + '> Watch only</label>' : '') +
      '<button type="button" class="btn danger" id="rm-' + g.key + '-' + i + '" ' + data + ' data-act="remove" style="margin-left:auto" aria-label="Remove ' + esc(g.one) + ': ' + esc(lbl) + '">Remove</button>' +
      '</div></div></li>';
  }

  function addHtml(g, d) {
    var C = SB.strategy.CONDITIONS, used = {};
    d[g.key].forEach(function (r) { used[r.id] = true; });
    var ids = Object.keys(C).filter(function (k) { return C[k].setGroup === g.set; });
    function opt(k) {
      return '<option value="' + esc(k) + '">' + esc(safeLabel({ id: k, params: defaults(k) })) + (used[k] ? ' (already added)' : '') + '</option>';
    }
    var sheet = ids.filter(function (k) { return C[k].kind === 'sheet'; }), std = ids.filter(function (k) { return C[k].kind !== 'sheet'; });
    return '<div class="controls" style="margin:12px 0 0">' +
      '<label class="sr-only" for="add-' + g.key + '">Add a ' + g.one + ' from the catalogue</label>' +
      '<select class="sel" id="add-' + g.key + '" style="flex:1 1 240px;min-width:0"><option value="">Add a ' + g.one + ' from the catalogue…</option>' +
      (sheet.length ? '<optgroup label="From your sheet">' + sheet.map(opt).join('') + '</optgroup>' : '') +
      (std.length ? '<optgroup label="Standard rules">' + std.map(opt).join('') + '</optgroup>' : '') + '</select>' +
      '<button type="button" class="btn" id="add-btn-' + g.key + '" data-act="add" data-g="' + g.key + '">Add ' + g.one + '</button></div>' +
      '<p class="sub down" id="add-' + g.key + '-msg" role="alert" hidden></p>';
  }

  function groupCard(P, g, d) {
    var rules = d[g.key], on = rules.filter(function (r) { return r.enabled !== false; }).length, screen = d.mode === 'screen';
    var empty = {
      filters: 'No filters - every stock in the universe is checked.',
      triggers: screen ? 'No triggers (not used in screen mode).' : 'No triggers yet. Setup mode needs at least one - add one below.',
      confirms: screen ? 'No requirements yet - a screen needs at least one.' : 'No requirements - after the filters, a firing trigger is enough to qualify.'
    }[g.key];
    var h = '<section class="card" id="sec-' + g.key + '"><div class="card-head"><div><h2>' + esc(g.title) + ' <span class="sub">· ' + on + ' of ' + rules.length + ' on</span></h2>' +
      '<p>' + esc(g.help) + '</p></div></div>';
    if (g.key === 'triggers' && screen) h += '<div class="note">Screen mode: triggers are not used - a stock matches when every filter and requirement passes. Switch the mode to Setup to use them.</div>';
    h += errP('sec-' + g.key);
    h += rules.length ? '<ul class="list">' + rules.map(function (r, i) { return ruleHtml(P, g, r, i); }).join('') + '</ul>' : '<p class="empty">' + esc(empty) + '</p>';
    h += addHtml(g, d);
    if (g.key === 'triggers' && !screen) {
      h += '<div class="form-grid" style="margin-top:14px">' +
        fieldWrap('st-mintrig', 'Minimum firing triggers to qualify', numInput('st-mintrig', 'data-f="minTriggers"', d.qualify.minTriggers), '<p class="sub" id="st-trig-count"></p>') + '</div>';
    }
    return h + '</section>';
  }

  function detailsCard(d) {
    var styles = STYLES.map(function (s) { return [s[0], s[1] + ' - ' + s[2], s[0] === 'intraday']; });
    return '<section class="card"><div class="card-head"><div><h2>Name, mode &amp; style</h2><p>The data is daily end-of-day (one candle per session), so every rule is checked on the latest daily candle.</p></div></div>' +
      '<div class="form-grid">' +
      fieldWrap('st-name', 'Name', '<input class="inp" type="text" id="st-name" data-f="name" maxlength="120" style="width:100%" value="' + esc(d.name) + '" aria-describedby="st-name-err">') +
      selectField('st-mode', 'Mode', 'mode', [['setup', 'Setup (entry timing, stop & target)'], ['screen', 'Screen (fundamentals, no timing)']], d.mode) +
      selectField('st-style', 'Style', 'style', styles, d.style, 'Intraday is not available: there are no intraday candles.') +
      fieldWrap('st-desc', 'Description', '<textarea class="inp" id="st-desc" data-f="description" rows="3" aria-describedby="st-desc-err">' + esc(d.description) + '</textarea>', '', true) +
      fieldWrap('st-assump', 'Assumptions (one per line - shown in the confirmation box)', '<textarea class="inp" id="st-assump" data-f="assumptions" rows="4" aria-describedby="st-assump-err">' +
        esc(d.assumptions.join('\n')) + '</textarea>', '', true) +
      '</div></section>';
  }

  function universeCard(P, d) {
    var counts = {}, unc = 0, sel = d.universe.categories;
    P.ctx.stocks.forEach(function (s) { if (s.cat) counts[s.cat] = (counts[s.cat] || 0) + 1; else unc++; });
    var cats = SB.classify.CATEGORIES.slice();
    sel.forEach(function (id) { if (!SB.classify.categoryById(id)) cats.push({ id: id, name: id + ' (unknown category)' }); });
    var boxes = cats.map(function (c) {
      return '<label style="display:flex;gap:6px;align-items:center;min-width:0"><input type="checkbox" data-f="cat" value="' + esc(c.id) + '"' +
        (sel.indexOf(c.id) >= 0 ? ' checked' : '') + '> <span style="min-width:0;overflow-wrap:anywhere">' + esc(c.name) + ' <span class="sub">' + F.int(counts[c.id] || 0) + '</span></span></label>';
    }).join('');
    return '<section class="card"><div class="card-head"><div><h2>Universe</h2><p>Which stocks of your watchlist the strategy looks at.</p></div></div>' +
      '<details id="st-cats-d"' + (ST.catsOpen ? ' open' : '') + '><summary style="cursor:pointer">Categories: <b id="st-cats-sum"></b></summary>' +
      '<p class="sub" style="margin:8px 0">Tick none to use all categories. Unclassified stocks (' + F.int(unc) + ') are only included when none is ticked.</p>' +
      '<div class="form-grid" role="group" aria-label="Categories" id="st-cats">' + boxes + '</div>' +
      '<div style="margin-top:10px"><button type="button" class="btn" id="st-cats-clear" data-act="cats-clear">Untick all (use all categories)</button></div></details>' + errP('st-cats') +
      '<div class="form-grid" style="margin-top:12px">' +
      numField('st-minbars', 'Minimum daily candles per stock', 'minBars', d.universe.minBars, 'Stocks with fewer candles are shown as Insufficient data. <span id="st-bars-hint"></span>') +
      '</div></section>';
  }

  function exitsCard(d) {
    var st = d.exits.stop, tg = d.exits.target, sk = STOP_KEY[st.method], tk = TARGET_KEY[tg.method];
    var h = '<section class="card"><div class="card-head"><div><h2>Exits &amp; events</h2><p>Stop-loss and target are measured from the entry reference = the latest daily close. ' +
      (d.mode === 'screen' ? 'In screen mode they are shown for reference only and do not change whether a stock matches.' : 'A setup without a valid stop below the entry, or with reward:risk below the minimum, is shown as Watch.') +
      '</p></div></div><div class="form-grid">';
    h += selectField('st-stopm', 'Stop-loss method', 'stopMethod', STOPS, st.method);
    h += sk ? numField('st-stopv', STOP_LABEL[st.method], 'stopVal', st[sk]) :
      (st.method === 'zone' ? '<div class="field"><span>Stop level</span><p class="sub">Just below the bottom of the FVG zone found by a zone trigger; 2 × ATR14 when no zone is found.</p></div>' : '');
    h += selectField('st-tgtm', 'Target method', 'targetMethod', TARGETS, tg.method);
    if (tk) h += numField('st-tgtv', TARGET_LABEL[tg.method], 'targetVal', tg[tk]);
    h += numField('st-minrr', 'Minimum reward:risk (0 = no minimum)', 'minRR', d.exits.minRR, '2 means the target must be at least 2 × the risk.');
    h += numField('st-warn', 'Warn when results are due within (days, 0 = off)', 'warnDays', d.events.warnDays, 'Adds a warning to the suggestion; it does not block it.');
    return h + '</div></section>';
  }

  function saveBar(P, saved) {
    var id = saved.id;
    return '<section class="card" id="st-savebar">' +
      '<div class="controls" style="margin-bottom:6px">' +
      '<label class="sr-only" for="st-note">Change note</label>' +
      '<input class="inp" type="text" id="st-note" maxlength="200" style="flex:1 1 240px;min-width:0" placeholder="Change note (optional), e.g. raised the turnover filter" value="' + esc(NOTES[id] || '') + '">' +
      '<button type="button" class="btn primary" id="st-save" data-act="save">Save</button>' +
      '<button type="button" class="btn" id="st-discard" data-act="discard">Discard edits</button></div>' +
      '<p class="sub" id="st-dirty" aria-live="polite"></p>' +
      '<details id="st-pend-d"' + (ST.pendOpen ? ' open' : '') + ' hidden><summary class="sub" style="cursor:pointer">Show the changes</summary><ul class="checks" id="st-pending"></ul></details>' +
      flashHtml('save') + '</section>';
  }

  function flashHtml(where) {
    if (!FLASH || FLASH.where !== where) return '';
    return '<div class="note' + (FLASH.cls ? ' ' + FLASH.cls : '') + '" id="st-flash-' + where + '" tabindex="-1" role="status" style="margin-top:10px' +
      (where === 'save' && FLASH.cls === 'bad' ? ';max-height:40vh;overflow:auto' : '') + '">' + FLASH.html + '</div>';
  }
  function chKey(id, version, at) { return id + '|' + version + '|' + at; }
  function noteChanges(id, version, at, lines) {
    if (!lines || !lines.length) return;
    var all = ui.store.get(CH_KEY, {}) || {};
    all[chKey(id, version, at)] = lines.slice(0, 40);
    var keys = Object.keys(all);
    if (keys.length > 300) keys.slice(0, keys.length - 300).forEach(function (k) { delete all[k]; });
    ui.store.set(CH_KEY, all);
  }
  function listHtml(items) {
    return '<ul style="margin:6px 0 0;padding-left:18px">' + items.map(function (s) { return '<li style="overflow-wrap:anywhere">' + esc(s) + '</li>'; }).join('') + '</ul>';
  }

  // ---------- page sections ----------
  function listCard(P, list, active) {
    var h = '<section class="card"><div class="card-head"><div><h2>Strategies</h2><p>Pick one to view, test or edit. The active one drives Daily Suggestions.</p></div></div><ul class="list" aria-label="Strategies">';
    list.forEach(function (c, k) {
      h += '<li><input type="radio" name="st-pick" id="pick-' + k + '" value="' + esc(c.id) + '"' + (c.id === ST.sel ? ' checked' : '') + '>' +
        '<label for="pick-' + k + '" class="grow" style="cursor:pointer"><b style="display:block;overflow-wrap:anywhere">' + esc(c.name || c.id) + '</b>' +
        '<span class="tags" style="margin-top:4px">' + sourceBadges(P.STR, c) + ui.badge('v' + c.version, '') + ui.badge(c.mode === 'screen' ? 'Screen' : 'Setup', '') +
        (c.id === active ? ui.badge('Active · drives Daily Suggestions', 's-info') : '') +
        '<span data-unsaved="' + esc(c.id) + '">' + (isDirty(P.STR, c.id) ? ui.badge('Unsaved edits', 's-warn') : '') + '</span></span></label></li>';
    });
    return h + '</ul></section>';
  }

  function detailCard(P, saved, dirty) {
    var STR = P.STR, id = saved.id, active = STR.activeId() === id, preset = !!SB.strategy.PRESETS[id];
    var edited = preset && !same(saved, SB.strategy.PRESETS[id]);
    var c = ensureShape(saved);
    var onCount = function (g) { return c[g].filter(function (r) { return r.enabled; }).length; };
    var h = '<section class="card" id="st-detail"><div class="card-head"><div><h2 style="overflow-wrap:anywhere">' + esc(saved.name || id) + '</h2>' +
      '<p>Version ' + saved.version + ' · ' + (saved.updatedAt ? 'saved ' + F.dateTime(saved.updatedAt) + ' IST in this browser' : preset ? 'original preset' : 'saved in this browser') + ' · id ' + esc(id) + '</p></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      (active ? '<button type="button" class="btn" disabled>✓ In use for Daily Suggestions</button>' : '<button type="button" class="btn primary" id="st-use" data-act="use">Use this strategy</button>') +
      '<button type="button" class="btn" id="st-dup" data-act="dup">Duplicate as custom</button>' +
      (preset ? '<button type="button" class="btn" id="st-reset" data-act="reset"' + (edited ? '' : ' disabled title="Already the original preset"') + '>Reset to original</button>' : '') +
      '<button type="button" class="btn" id="st-export" data-act="export">Export JSON</button></div></div>';
    h += '<div class="tags">' + sourceBadges(STR, saved) + (active ? ui.badge('Active · drives Daily Suggestions', 's-info') : '') +
      '<span data-unsaved="' + esc(id) + '">' + (dirty ? ui.badge('Unsaved edits', 's-warn') : '') + '</span></div>';
    if (ST.resetAsk && preset) {
      h += '<div class="note warn" style="margin-top:12px"><strong>Reset “' + esc(saved.name) + '” to the original preset?</strong> Your saved versions of it (now version ' + saved.version +
        '), any unsaved edits and its confirmation are removed from this browser. The change history keeps a “reset” entry.' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><button type="button" class="btn danger" id="st-reset-yes" data-act="reset-yes">Yes, reset</button>' +
        '<button type="button" class="btn" id="st-reset-no" data-act="reset-no">Cancel</button></div></div>';
    }
    h += '<dl class="kv">' +
      '<div><dt>Mode</dt><dd>' + esc(MODES[c.mode]) + '</dd></div>' +
      '<div><dt>Style</dt><dd>' + esc(styleText(c.style)) + '</dd></div>' +
      '<div><dt>Timeframe</dt><dd>' + (c.timeframe === '1d' ? 'Daily candles (end-of-day)' : esc(c.timeframe)) + '</dd></div>' +
      '<div><dt>Universe</dt><dd>' + esc(cap(catText(c.universe.categories))) + ' · ' + plural(universeCount(P.ctx, c.universe.categories), 'stock') + ' · ≥ ' + c.universe.minBars + ' candles</dd></div>' +
      '<div><dt>Rules on</dt><dd>' + plural(onCount('filters'), 'filter') + ' · ' + plural(onCount('triggers'), 'trigger') + ' · ' + plural(onCount('confirms'), 'requirement') + '</dd></div>' +
      '<div><dt>Exits</dt><dd>Stop ' + esc(stopText(c.exits.stop)) + ' · target ' + esc(targetText(c.exits.target)) + (c.exits.minRR > 0 ? ' · min reward:risk ' + F.num(c.exits.minRR) : '') + '</dd></div>' +
      '</dl>';
    if (saved.description) h += '<p style="margin-top:12px;overflow-wrap:anywhere">' + esc(saved.description) + '</p>';
    if (c.style === 'intraday') h += '<div class="note warn" style="margin-top:12px">This strategy is marked intraday, but the dashboard only has daily end-of-day candles - intraday timing is not supported. Its rules are checked on the daily candle. Change the style in the editor.</div>';
    else h += '<p class="sub" style="margin-top:8px">The data is daily end-of-day, so intraday strategies are not supported.</p>';
    h += confirmBox(P, saved, dirty);
    h += flashHtml('top-detail');
    return h + '</section>';
  }

  function confirmBox(P, saved, dirty) {
    var STR = P.STR, conf = STR.isConfirmed(saved.id), demo = saved.source === 'demo', items = Array.isArray(saved.assumptions) ? saved.assumptions : [];
    var h = '<div class="note ' + (conf ? 'good' : 'warn') + '" id="st-assume" style="margin-top:12px">';
    h += '<strong>' + (demo ? 'DEMO strategy - assumptions' : conf ? 'Assumptions you confirmed (version ' + saved.version + ')' : 'Assumptions - please check before confirming') + '</strong>';
    h += items.length ? listHtml(items) : '<p style="margin-top:4px">No extra assumptions are listed for this strategy - check every rule in the editor below before confirming.</p>';
    if (saved.source === 'discovered' || saved.source === 'discovered-edited') {
      h += '<p style="margin-top:8px">These rules were found in your sheet (Code.gs and your dashboards), but how they combine into a suggestion is not written there. ' +
        'Until you confirm, Daily Suggestions marks this strategy “unconfirmed”.</p>';
    }
    if (demo) {
      h += '<p style="margin-top:8px"><strong>DEMO strategies can never be confirmed.</strong> They are generic examples for testing the engine, not your rules, and their signals are not recommendations. ' +
        'Use “Duplicate as custom” to make your own editable copy.</p>';
    } else {
      h += '<label style="display:flex;gap:8px;align-items:flex-start;margin-top:10px"><input type="checkbox" id="st-confirm" style="margin-top:3px"' + (conf ? ' checked' : '') + (dirty ? ' disabled' : '') + '>' +
        '<span><strong>I confirm these rules are mine (version ' + saved.version + ')</strong></span></label>' +
        '<p id="st-confirm-hint" style="margin-top:4px"' + (dirty ? '' : ' hidden') + '>You have unsaved edits - save or discard them first. Only a saved version can be confirmed.</p>' +
        '<p style="margin-top:4px">Saving a new version clears the confirmation, so each version is confirmed on its own.</p>';
    }
    return h + flashHtml('confirm') + '</div>';
  }

  function testCard(P, saved) {
    return '<section class="card" id="st-test"><div class="card-head"><div><h2>Test on today\'s data</h2><p id="st-test-intro"></p></div>' +
      '<button type="button" class="btn" id="st-test-btn" data-act="test">Test on today\'s data</button></div>' +
      '<div id="st-test-out"></div>' + flashHtml('test') + '</section>';
  }

  function historyCard() {
    return '<section class="card"><div class="card-head"><div><h2>Change history</h2><p>Saved versions of this strategy in this browser, newest first (the last 50 are kept). Times are IST.</p></div></div><div id="st-hist"></div></section>';
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

  // ---------- test results ----------
  function drawTest(P) {
    var el = P.el, out = $('#st-test-out', el), btn = $('#st-test-btn', el);
    if (!out) return;
    var id = ST.sel, saved = P.STR.get(id), t = TESTS[id], ctx = P.ctx;
    if (btn) { btn.disabled = !!TESTING[id]; btn.textContent = TESTING[id] ? 'Testing…' : t && !t.error && t.key === testKey(saved) ? 'Test again' : 'Test on today\'s data'; }
    if (TESTING[id]) { out.innerHTML = ui.skeleton(4) + '<p class="sub" style="margin-top:8px">Checking version ' + saved.version + ' against every stock…</p>'; return; }
    if (!t) { out.innerHTML = '<p class="empty">Not tested yet. The test shows how many stocks match the saved rules on the latest daily candle.</p>'; return; }
    if (t.key !== testKey(saved)) { out.innerHTML = '<div class="note">The last test was for version ' + t.version + '. Press “Test on today\'s data” to test version ' + saved.version + '.</div>'; return; }
    if (t.error) { out.innerHTML = '<div class="note bad">The test could not run: ' + esc(t.error) + '</div>'; return; }
    var r = t.result, mode = r.config && r.config.mode === 'screen' ? 'screen' : 'setup', n = r.results.length, H = ctx.history || {};
    var conf = P.STR.isConfirmed(id), demo = saved.source === 'demo', active = P.STR.activeId() === id;
    var labels = mode === 'screen' ?
      [['qualified', 'Matches screen'], ['avoid', 'Avoid'], ['none', 'Does not match'], ['insufficient', 'Insufficient data']] :
      [['qualified', 'Qualified'], ['watch', 'Watch'], ['avoid', 'Avoid'], ['none', 'No signal'], ['insufficient', 'Insufficient data']];
    var why = { avoid: ' - a filter failed', insufficient: ' - too few or stale candles', none: mode === 'screen' ? ' - a requirement failed' : ' - no trigger fired', watch: ' - partly matched' };
    if (mode === 'screen' && r.counts.watch) labels.splice(1, 0, ['watch', 'Watch']);
    var h = '<div class="tags">' + (demo ? ui.badge('DEMO results - not your strategy', 's-warn') : conf ? ui.badge('Confirmed version ' + saved.version, 's-good') : ui.badge('Unconfirmed rules', 's-warn')) +
      ui.badge('Version ' + saved.version, '') + '</div>';
    h += '<p class="sub" style="margin-top:8px">Daily candles ' + ui.stateBadge(SB.candleState(H), r.dataAsOf, r.dataSource || H.source) + ' newest candle ' + F.date(r.dataAsOf) +
      ' · Prices ' + ui.stateBadge(ctx.market.state, ctx.market.asOf, ctx.market.source) + ' · tested ' + esc(F.dateTime(r.ranAt)) + ' IST</p>';
    if (r.errors && r.errors.length) h += '<div class="note bad" style="margin-top:8px"><strong>The engine reported problems with this version:</strong>' + listHtml(r.errors) + '</div>';
    var q = r.counts.qualified || 0;
    h += '<p style="margin-top:10px"><strong>' + F.int(q) + '</strong> of ' + plural(n, 'stock') + ' ' + (mode === 'screen' ? 'match the screen' : 'qualified') +
      (mode === 'setup' ? ', ' + F.int(r.counts.watch || 0) + ' on Watch' : '') + '.</p>';
    h += '<p class="sub" style="margin-top:4px">' + (mode === 'screen' ? 'Avoid = a filter failed · Does not match = a requirement failed' :
      'Avoid = a filter failed · Watch = partly matched (watch-only trigger, partial confluence or a failed requirement) · No signal = no trigger fired') +
      ' · Insufficient data = too few or stale daily candles.</p>';
    h += '<div style="margin-top:8px">' + ui.bars(labels.map(function (l) {
      var v = r.counts[l[0]] || 0;
      return { label: l[1], value: v, tip: l[1] + (why[l[0]] || '') + ': ' + plural(v, 'stock') + ' (' + F.num(n ? v / n * 100 : 0, 1) + '% of ' + F.int(n) + ')' };
    }), { fmt: function (v) { return F.int(v); } }) + '</div>';
    h += '<h3 style="margin-top:14px">Top 5 ' + (mode === 'screen' ? 'matches' : 'qualified') + ' by score</h3>';
    if (q) h += '<div id="st-test-top" style="margin-top:8px"></div>';
    else {
      h += '<p class="empty">No stock ' + (mode === 'screen' ? 'matches the screen' : 'qualified') + ' on ' + F.date(r.dataAsOf) + '.' +
        (r.counts.watch ? ' ' + plural(r.counts.watch, 'stock is', 'stocks are') + ' on Watch.' : '') +
        ' Loosen a rule, or check the Insufficient data count.</p>';
    }
    h += '<p class="sub" style="margin-top:8px">Score = share of the requirements met. ' + (mode === 'screen' ? 'Matches screen' : 'Qualified') +
      ' means every rule passed on the latest daily candle - it is a research shortlist, not a buy recommendation, and says nothing about future returns.</p>';
    h += '<p style="margin-top:8px">' + (active ? '<a href="#suggestions">Open Daily Suggestions for the full list →</a>' :
      '<span class="sub">This strategy is not the active one. Press “Use this strategy” to see its full list in Daily Suggestions.</span>') + '</p>';
    out.innerHTML = h;
    if (!q) return;
    var cols = [
      { key: 'sym', label: 'Stock', type: 'sym', get: function (x) { return x.sym; }, html: function (x) { var s = ctx.bySym[x.sym]; return ui.stockCell(x.sym, s && s.name); } },
      { key: 'score', label: 'Score', type: 'num', get: function (x) { return x.score; },
        html: function (x) { return '<b>' + F.int(x.score) + '</b> <span class="sub">' + esc(x.scoreNote || '') + '</span>'; } }
    ];
    if (mode === 'setup') {
      cols.push(
        { key: 'setup', label: 'Signal type', get: function (x) { return (x.setupTypes || []).join(', '); },
          html: function (x) { return (x.setupTypes || []).length ? x.setupTypes.map(function (s) { return ui.badge(s, ''); }).join(' ') : '<span class="sub">–</span>'; } },
        { key: 'entry', label: 'Entry ref.', type: 'price' },
        { key: 'stop', label: 'Stop', type: 'price' },
        { key: 'target', label: 'Target', type: 'price' },
        { key: 'rr', label: 'Reward:risk', type: 'num', html: function (x) { return isNum(x.rr) ? '1:' + F.num(x.rr, 2) : '–'; } }
      );
    } else {
      cols.push({ key: 'cat', label: 'Category', wrap: true, get: function (x) { var s = ctx.bySym[x.sym]; return s ? s.catName : null; } });
    }
    cols.push({ key: 'warnings', label: 'Notes', wrap: true, get: function (x) { return (x.warnings || []).join('; ') || null; } });
    new ui.Table({ rows: r.lists.qualified.slice(0, 5), pageSize: 5, columns: cols, empty: 'Nothing qualified' }).mount($('#st-test-top', el));
  }

  function runTest(P) {
    var STR = P.STR, id = ST.sel, saved = STR.get(id);
    if (!saved || TESTING[id]) return;
    TESTING[id] = true;
    drawTest(P);
    setTimeout(function () {                      // let the "Testing…" state paint before the run blocks
      var p;
      try { p = STR.runActive(id); } catch (e) { p = Promise.reject(e); }
      p.then(function (r) {
        TESTS[id] = { version: saved.version, key: testKey(saved), result: r };
      }, function (e) {
        TESTS[id] = { version: saved.version, key: testKey(saved), error: (e && e.message) || String(e) };
      }).then(function () {
        TESTING[id] = false;
        if (P.el.isConnected && ST.sel === id) {
          drawTest(P);
          var out = $('#st-test-out', P.el);
          if (out) { out.setAttribute('tabindex', '-1'); out.focus({ preventScroll: true }); }
        }
      });
    }, 30);
  }

  // ---------- drawing ----------
  function draw(P, focusId) {
    var el = P.el, STR = P.STR;
    var prev = document.activeElement && el.contains(document.activeElement) ? document.activeElement.id : null;
    P.memo = P.memo || {};
    var list = STR.list(), active = STR.activeId();
    if (!STR.get(ST.sel)) ST.sel = active;
    var id = ST.sel, saved = STR.get(id), d = draftOf(STR, id), dirty = isDirty(STR, id);

    var h = '<div class="page-head"><div><h1>Strategy settings</h1>' +
      '<p>Choose, edit, version and confirm the rules behind Daily Suggestions. Your edits, versions and confirmations are saved <strong>only in this browser</strong> ' +
      '(localStorage) - nothing is uploaded or shared. Use Export JSON to back them up or move them to another device.</p></div>' +
      '<div class="actions"><button type="button" class="btn" id="st-import" data-act="import">Import JSON</button>' +
      '<input type="file" id="st-file" accept=".json,application/json" hidden>' +
      '<a class="btn" href="#suggestions">Daily Suggestions</a></div></div>';
    h += flashHtml('top');
    h += listCard(P, list, active);
    h += detailCard(P, saved, dirty);
    h += testCard(P, saved);
    h += '<div class="grid" id="st-editor"><div><h2 style="font-size:18px">Edit “' + esc(saved.name || id) + '”</h2>' +
      '<p class="sub" style="margin-top:2px">Changes stay a draft in this tab until you press Save.' + (saved.source === 'demo' ? ' Edits to the DEMO strategy stay labelled DEMO - duplicate it as custom to make it yours.' : '') + '</p></div>' +
      '<div class="grid g2">' + detailsCard(d) + universeCard(P, d) + '</div>' +
      GROUPS.map(function (g) { return groupCard(P, g, d); }).join('') +
      exitsCard(d) + saveBar(P, saved) + '</div>';
    h += historyCard();
    el.innerHTML = h;

    var humanStore = ui.store.get(CH_KEY, {}) || {}, hist = STR.history(id);
    if (!hist.length) {
      $('#st-hist', el).innerHTML = '<p class="empty">' + (SB.strategy.PRESETS[id] ? 'No saved versions yet - this is the original preset. Saving an edit creates version ' + (saved.version + 1) + '.' : 'No history recorded.') + '</p>';
    } else new ui.Table({
      rows: hist, pageSize: 10,
      columns: [
        { key: 'version', label: 'Version', type: 'num', digits: 0 },
        { key: 'at', label: 'Saved (IST)', type: 'datetime' },
        { key: 'note', label: 'Note', wrap: true },
        { key: 'changes', label: 'Changes', wrap: true, get: function (r) { return (r.changes || []).join('; '); },
          html: function (r) {
            var human = humanStore[chKey(id, r.version, r.at)];
            if (!human) return changesHtml(r.changes);
            return changesHtml(human) + ((r.changes || []).length ? '<details style="margin-top:4px"><summary class="sub" style="cursor:pointer">Technical log</summary>' + changesHtml(r.changes) + '</details>' : '');
          } }
      ]
    }).mount($('#st-hist', el));
    drawTest(P);
    refresh(P);

    var flashEl = FLASH ? $('#st-flash-' + FLASH.where, el) : null;
    FLASH = null;
    var target = focusId === 'flash' ? flashEl : (focusId || prev) ? document.getElementById(focusId || prev) : null;
    if (target && el.contains(target)) target.focus({ preventScroll: focusId !== 'flash' });
  }

  /** In-place update after a value edit (no re-render, so typing keeps focus). */
  function refresh(P) {
    var el = P.el, STR = P.STR, ctx = P.ctx, id = ST.sel, saved = STR.get(id), d = draftOf(STR, id);
    var bars = barsCount(ctx), v = validateDraft(d, bars);
    el.querySelectorAll('.ferr').forEach(function (p) {
      var f = p.getAttribute('data-for'), msg = v.E[f] || '', w = !msg && v.W[f] ? v.W[f] : '';
      p.textContent = msg || (w ? 'Note: ' + w : '');
      p.className = 'sub ferr' + (msg ? ' down' : '');
      p.hidden = !(msg || w);
      var inp = document.getElementById(f);
      if (inp) { if (msg) inp.setAttribute('aria-invalid', 'true'); else inp.removeAttribute('aria-invalid'); }
    });
    var dirty = isDirty(STR, id), ch = dirty ? humanChanges(saved, d) : [];
    var dt = $('#st-dirty', el);
    if (dt) {
      dt.textContent = dirty ? (ch.length ? plural(ch.length, 'unsaved change') : 'Unsaved edits - some values are not valid yet') +
        (v.list.length ? ' · ' + plural(v.list.length, 'problem') + ' to fix before saving' : '') +
        (STR.isConfirmed(id) ? ' · saving clears your confirmation of version ' + saved.version : '') :
        'No unsaved edits - this is saved version ' + saved.version + '. Saving stores a new version in this browser only and clears the confirmation; you then confirm the new version in the box above.';
    }
    var pend = $('#st-pending', el), pd = $('#st-pend-d', el);
    if (pd) pd.hidden = !ch.length;
    if (pend) {
      pend.innerHTML = ch.map(function (s) { return '<li style="overflow-wrap:anywhere">• ' + esc(s) + '</li>'; }).join('');
    }
    var sv = $('#st-save', el), ds = $('#st-discard', el), bar = $('#st-savebar', el);
    if (sv) { sv.disabled = !dirty; sv.textContent = 'Save as version ' + (saved.version + 1); }
    if (ds) ds.disabled = !dirty;
    if (bar) { bar.style.position = dirty ? 'sticky' : ''; bar.style.bottom = dirty ? '0' : ''; bar.style.zIndex = dirty ? '5' : ''; }
    var cb = $('#st-confirm', el), hint = $('#st-confirm-hint', el);
    if (cb) cb.disabled = dirty;
    if (hint) hint.hidden = !dirty;
    el.querySelectorAll('[data-unsaved]').forEach(function (s) {
      var sid = s.getAttribute('data-unsaved');
      s.innerHTML = isDirty(STR, sid) ? ui.badge('Unsaved edits', 's-warn') : '';
    });
    var cs = $('#st-cats-sum', el);
    if (cs) cs.textContent = cap(catText(d.universe.categories)) + ' · ' + plural(universeCount(ctx, d.universe.categories), 'stock');
    var tc = $('#st-trig-count', el);
    if (tc) {
      var on = d.triggers.filter(function (r) { return r.enabled !== false && !r.watchOnly; }).length;
      tc.textContent = plural(on, 'trigger') + ' on and not watch-only. With 1, any one firing trigger is enough.';
    }
    var bh = $('#st-bars-hint', el);
    if (bh) bh.textContent = bars ? 'The history file has up to ' + bars + ' daily candles per stock.' : '';
    var ti = $('#st-test-intro', el);
    if (ti) {
      var H = ctx.history;
      var sc = ensureShape(saved).universe.categories;
      ti.textContent = 'Runs the saved version ' + saved.version + ' over ' + plural(universeCount(ctx, sc), 'stock') + ' (' + catText(sc) + ') with the daily candles in the history file' +
        (H && H.dates && H.dates.length ? ' (latest session ' + F.date(H.dates[H.dates.length - 1]) + ')' : '') + '. Nothing is saved or sent anywhere.' +
        (dirty ? ' Your unsaved edits are not included - save them first to test them.' : '');
    }
  }

  // ---------- actions ----------
  function setFlash(where, cls, html) { FLASH = { where: where, cls: cls, html: html }; }
  var STORAGE_MSG = 'This browser did not keep it - local storage is blocked or full (for example in a private window), so the change is lost when you leave the page.';
  function persisted(STR, id, version) { var g = STR.get(id); return !!(g && g.version === version); }
  function testKey(cfg) { return cfg.version + '|' + (cfg.updatedAt || ''); }

  function doUse(P) {
    var STR = P.STR, id = ST.sel, saved = STR.get(id), dirty = isDirty(STR, id);
    STR.setActive(id);
    var notes = [];
    if (saved.source === 'demo') notes.push('It is a DEMO strategy: its suggestions are labelled DEMO and are not your rules.');
    else if (!STR.isConfirmed(id)) notes.push('It is not confirmed yet, so its suggestions are marked unconfirmed until you confirm it below.');
    if (dirty) notes.push('Your unsaved edits are not used until you save them.');
    setFlash('top-detail', saved.source === 'demo' ? 'warn' : 'good', '<strong>' + esc(saved.name) + ' (version ' + saved.version + ') now drives Daily Suggestions.</strong>' +
      (notes.length ? ' ' + esc(notes.join(' ')) : '') + ' <a href="#suggestions">Open Daily Suggestions →</a>');
    draw(P, 'flash');
  }

  function doConfirm(P, yes) {
    var STR = P.STR, id = ST.sel, saved = STR.get(id);
    if (saved.source === 'demo' || isDirty(STR, id)) { draw(P); return; }
    STR.confirm(id, yes);
    setFlash('confirm', '', yes ? 'Confirmed version ' + saved.version + ' as your rules. Saving a new version will ask you to confirm again.' :
      'Confirmation removed - this strategy is marked unconfirmed again.');
    draw(P, 'st-confirm');
  }

  function doReset(P) {
    var STR = P.STR, id = ST.sel, name = STR.get(id).name;
    STR.resetToPreset(id);
    delete DRAFTS[id]; delete NOTES[id]; delete TESTS[id];
    ST.resetAsk = false;
    var p = STR.get(id);
    setFlash('top-detail', 'good', '<strong>' + esc(name) + '</strong> was reset to the original preset (version ' + p.version + '). Its confirmation was cleared; the change history keeps a “reset” entry.');
    draw(P, 'flash');
  }

  function doDuplicate(P) {
    var STR = P.STR, id = ST.sel, saved = STR.get(id), dirty = isDirty(STR, id);
    var src = dirty ? DRAFTS[id] : ensureShape(saved);
    if (dirty) {
      var v = validateDraft(src, barsCount(P.ctx));
      if (v.list.length) {
        setFlash('top-detail', 'bad', '<strong>Not duplicated.</strong> Your unsaved edits have ' + plural(v.list.length, 'problem') + ' - fix them in the editor or discard them first.' + listHtml(v.list.map(function (x) { return x.msg; })));
        draw(P, 'flash');
        return;
      }
    }
    var c = clone(src), nid = 'custom-' + Date.now();
    c.id = nid;
    c.source = 'custom';
    c.name = String(saved.name || 'Strategy').slice(0, 72) + ' (copy)';
    if (dirty && src.name && src.name !== saved.name) c.name = String(src.name).slice(0, 72) + ' (copy)';
    delete c.version; delete c.updatedAt;
    var res = STR.save(c, 'duplicated from ' + saved.name + ' v' + saved.version + (dirty ? ' (with unsaved edits)' : ''));
    if (!res.ok) {
      setFlash('top-detail', 'bad', '<strong>Not duplicated:</strong>' + listHtml(res.errors || ['unknown error']));
      draw(P, 'flash');
      return;
    }
    if (!STR.get(nid)) {
      setFlash('top-detail', 'bad', '<strong>Not duplicated.</strong> ' + esc(STORAGE_MSG));
      draw(P, 'flash');
      return;
    }
    if (dirty) { delete DRAFTS[id]; delete NOTES[id]; }
    ST.sel = nid; ST.resetAsk = false;
    setFlash('top', 'good', '<strong>Created “' + esc(res.config.name) + '”</strong> - your own custom strategy, version 1, not confirmed yet.' +
      (dirty ? ' Your unsaved edits were moved into the copy; “' + esc(saved.name) + '” keeps its saved version ' + saved.version + '.' : '') +
      (saved.source === 'demo' ? ' It started from the DEMO strategy: rename it and check every rule before you confirm it as yours.' : ''));
    draw(P, 'flash');
  }

  function doExport(P) {
    var STR = P.STR, id = ST.sel, saved = STR.get(id), name = id + '-v' + saved.version + '.json';
    ui.download(name, STR.exportJson(id), 'application/json;charset=utf-8');
    setFlash('top-detail', '', 'Downloaded <strong>' + esc(name) + '</strong> - saved version ' + saved.version + ' only' + (isDirty(STR, id) ? ' (your unsaved edits are not in the file)' : '') +
      '. Import it on another device with “Import JSON”.');
    draw(P, 'flash');
  }

  /** Imported files may claim any source: only real preset ids keep a sheet / DEMO source. */
  function prepImport(text, STR) {
    var cfg;
    try { cfg = JSON.parse(text); } catch (e) { return { text: text }; }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { text: text };
    var sid = String(cfg.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
    var preset = sid && SB.strategy.PRESETS[sid], cur = sid ? STR.get(sid) : null;
    if (preset) cfg.source = preset.source === 'demo' ? 'demo' : cur && cur.source === 'discovered-edited' ? 'discovered-edited' : 'discovered';
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
        delete DRAFTS[c.id]; delete NOTES[c.id]; delete TESTS[c.id];
        ST.sel = c.id; ST.resetAsk = false;
        if (!res.unchanged && !persisted(STR, c.id, c.version)) setFlash('top', 'bad', '<strong>Not imported.</strong> ' + esc(STORAGE_MSG));
        else if (res.unchanged) setFlash('top', '', '“' + esc(c.name) + '” in ' + esc(file.name) + ' is identical to the saved version ' + c.version + ' - nothing changed.');
        else {
          setFlash('top', 'good', '<strong>Imported “' + esc(c.name) + '” as version ' + c.version + '</strong>' +
            (prep.existed ? ' - it updated the strategy with the same id; older versions stay in its change history.' : ' - a new strategy.') +
            ' Imported rules are not confirmed: check them and confirm below.' + (c.source === 'demo' ? ' It is the DEMO strategy and stays labelled DEMO.' : ''));
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

  function doSave(P) {
    var STR = P.STR, id = ST.sel, saved = STR.get(id), d = draftOf(STR, id);
    var v = validateDraft(d, barsCount(P.ctx));
    if (v.list.length) {
      setFlash('save', 'bad', '<strong>Not saved - fix ' + plural(v.list.length, 'problem') + ' first:</strong>' + listHtml(v.list.map(function (x) { return x.msg; })));
      var firstId = v.list[0].id;
      draw(P, 'flash');
      var f = document.getElementById(firstId);
      if (f && f.scrollIntoView) f.scrollIntoView({ block: 'center' });
      return;
    }
    if (!isDirty(STR, id)) { setFlash('save', '', 'Nothing changed - no new version saved.'); draw(P, 'flash'); return; }
    var wasConfirmed = STR.isConfirmed(id), wasActive = STR.activeId() === id, human = humanChanges(saved, d);
    var res = STR.save(clone(d), String(NOTES[id] || '').trim());
    if (!res.ok) {
      setFlash('save', 'bad', '<strong>Not saved - the engine rejected it:</strong>' + listHtml(res.errors || ['unknown error']));
      draw(P, 'flash');
      return;
    }
    if (res.unchanged) { delete DRAFTS[id]; setFlash('save', '', 'Nothing changed - no new version saved.'); draw(P, 'flash'); return; }
    var c = res.config;
    if (!persisted(STR, id, c.version)) {
      setFlash('save', 'bad', '<strong>Version ' + c.version + ' could not be saved.</strong> ' + esc(STORAGE_MSG) + ' Your edits are still in the editor.');
      draw(P, 'flash');
      return;
    }
    delete DRAFTS[id]; delete NOTES[id]; delete TESTS[id];
    noteChanges(id, c.version, c.updatedAt, human);
    setFlash('save', 'good', '<strong>Saved version ' + c.version + ' of “' + esc(c.name) + '” in this browser.</strong> What changed:' + listHtml(human.length ? human : res.changes || []) +
      ((res.changes || []).length ? '<details style="margin-top:6px"><summary style="cursor:pointer">Technical change log (as recorded in the history)</summary>' + listHtml(res.changes) + '</details>' : '') +
      '<p style="margin-top:6px">' + (c.source === 'demo' ? 'DEMO strategies are never confirmed.' : wasConfirmed ?
        'Your confirmation was for version ' + saved.version + ', so it was cleared - confirm version ' + c.version + ' in the box above when the rules are right.' :
        'Version ' + c.version + ' is not confirmed yet - confirm it in the box above when the rules are right.') +
      (wasActive ? ' Daily Suggestions uses version ' + c.version + ' from now on.' : '') + '</p>' +
      '<div style="margin-top:8px"><button type="button" class="btn" id="st-test-new" data-act="test-new">Test version ' + c.version + ' on today\'s data</button></div>');
    draw(P, 'flash');
  }

  function onEdit(P, t, type) {
    var STR = P.STR, id = ST.sel, d = draftOf(STR, id), el = P.el;
    var isText = t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && /^(text|number|search)$/.test(t.type));
    if (isText ? type !== 'input' : type !== 'change') return;
    if (t.id === 'st-note') { NOTES[id] = t.value; return; }
    var f = t.getAttribute('data-f'), g = t.getAttribute('data-g'), structural = false, saved = STR.get(id);
    if (f) {
      switch (f) {
        case 'name': d.name = t.value; break;
        case 'description': d.description = t.value; break;
        case 'assumptions': d.assumptions = t.value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean); break;
        case 'mode':
          d.mode = t.value === 'screen' ? 'screen' : 'setup';
          if (d.mode === 'setup' && !(d.qualify.minTriggers >= 1)) d.qualify.minTriggers = 1;
          structural = true; break;
        case 'style': d.style = t.value; structural = true; break;
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
    } else if (g && d[g]) {
      var i = +t.getAttribute('data-i'), r = d[g][i];
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
    } else return;
    if (structural) draw(P); else refresh(P);
  }

  function bind(P) {
    var el = P.el;
    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b || !el.contains(b) || b.disabled) return;
      var act = b.getAttribute('data-act'), STR = P.STR, id = ST.sel;
      if (act === 'use') doUse(P);
      else if (act === 'dup') doDuplicate(P);
      else if (act === 'reset') { ST.resetAsk = true; draw(P, 'st-reset-yes'); }
      else if (act === 'reset-no') { ST.resetAsk = false; draw(P, 'st-reset'); }
      else if (act === 'reset-yes') doReset(P);
      else if (act === 'export') doExport(P);
      else if (act === 'import') { var fi = $('#st-file', el); if (fi) fi.click(); }
      else if (act === 'save') doSave(P);
      else if (act === 'discard') {
        delete DRAFTS[id];
        setFlash('save', '', 'Edits discarded - back to saved version ' + STR.get(id).version + '.');
        draw(P, 'flash');
      } else if (act === 'test') runTest(P);
      else if (act === 'test-new') {
        var card = $('#st-test', el);
        if (card && card.scrollIntoView) card.scrollIntoView({ block: 'start' });
        runTest(P);
      } else if (act === 'cats-clear') {
        draftOf(STR, id).universe.categories = [];
        el.querySelectorAll('input[data-f="cat"]').forEach(function (x) { x.checked = false; });
        refresh(P);
      } else if (act === 'add') {
        var g = b.getAttribute('data-g'), sel = $('#add-' + g, el), msg = $('#add-' + g + '-msg', el), cid = sel ? sel.value : '';
        if (!cid || !SB.strategy.CONDITIONS[cid]) {
          if (msg) { msg.textContent = 'Pick a rule from the list first.'; msg.hidden = false; }
          if (sel) sel.focus();
          return;
        }
        var d = draftOf(STR, id);
        d[g].push({ id: cid, params: defaults(cid), enabled: true });
        var ni = d[g].length - 1;
        draw(P, 'on-' + g + '-' + ni);
        var li = $('#on-' + g + '-' + ni, el);
        if (li && li.scrollIntoView) li.scrollIntoView({ block: 'center' });
      } else if (act === 'remove') {
        var rg = b.getAttribute('data-g'), ri = +b.getAttribute('data-i'), dd = draftOf(STR, id);
        if (dd[rg] && dd[rg][ri]) dd[rg].splice(ri, 1);
        draw(P, 'add-' + rg);
      }
    });
    el.addEventListener('change', function (e) {
      var t = e.target;
      if (t.name === 'st-pick') { ST.sel = t.value; ST.resetAsk = false; FLASH = null; selectHash(t.value); draw(P); return; }
      if (t.id === 'st-file') { var file = t.files && t.files[0]; t.value = ''; doImport(P, file); return; }
      if (t.id === 'st-confirm') { doConfirm(P, t.checked); return; }
      if (t.id && /^add-/.test(t.id)) { var m = $('#' + t.id + '-msg', el); if (m) m.hidden = true; return; }
      onEdit(P, t, 'change');
    });
    el.addEventListener('input', function (e) { onEdit(P, e.target, 'input'); });
    el.addEventListener('toggle', function (e) {
      if (e.target && e.target.id === 'st-cats-d') ST.catsOpen = e.target.open;
      if (e.target && e.target.id === 'st-pend-d') ST.pendOpen = e.target.open;
    }, true);
  }

  function selectHash(id) {
    try { if (window.history && window.history.replaceState) window.history.replaceState(null, '', '#strategy/' + encodeURIComponent(id)); } catch (e) { /* ignore */ }
  }

  SB.page('strategy', {
    render: function (el, params, ctx) {
      var STR = SB.strategies;
      if (!STR || !SB.strategy) { el.innerHTML = '<div class="note bad">The strategy engine did not load, so strategies cannot be shown.</div>'; return; }
      if (params && params[0] && STR.get(params[0])) ST.sel = params[0];
      if (!ST.sel || !STR.get(ST.sel)) ST.sel = STR.activeId();
      ST.resetAsk = false;
      var P = { el: el, ctx: ctx, STR: STR, memo: {} };
      bind(P);
      draw(P);
      // candle history (for bar-count hints and the test) - loaded in the background
      if (!ctx.history && SB.loadHistory) {
        SB.loadHistory().then(function () { if (el.isConnected) refresh(P); }, function () { /* the test reports it */ });
      }
    }
  });
})();
