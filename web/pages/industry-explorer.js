/* Industry Explorer - the official NSE four-level industry classification
   (Macro-Economic Sector > Sector > Industry > Basic Industry) connected to the
   Main tab's stocks, their prices / daily candles and the active strategy.
   Routes (dispatched by web/pages/industries.js):
     #industries                                 landing: counts, search, tree, performance, watchlist
     #industries/companies                       every stock with combined filters
     #industries/macro|sector|industry/<slug>    one node of the hierarchy
     #industries/basic/<slug>                    one basic industry (research note, metrics, stocks,
                                                 comparison, strategy, performance)
   Data: web/data/industries.js (loaded on demand), web/data/industry-profiles.js
   (loaded only on a basic-industry page) and SB.industry (web/lib/industry.js) for the
   mapping, search, filters and aggregation. Strategy results are only read
   (SB.strategies.runActive); no rule is changed or recomputed here. */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, esc = ui.esc, F = ui.F, isNum = ui.isNum, $ = ui.$;
  var IND = SB.industry, MET = SB.industryMetrics;

  // view state kept while the site is open (not personal data)
  var DASH = { period: '1D', level: 'basic', unranked: false };
  var NODE = { period: '1D', view: 'all' };
  var BAS = { period: '1D', view: 'all', strat: 'all', shown: 10 };
  var CO = { macroId: '', sectorId: '', industryId: '', basicId: '', exchange: '', status: '', cap: '', q: '' };
  var TREE = { q: '' };

  var PERIODS = ['1D', '1W', '1M', '3M', '6M', '1Y'];
  var STATUS = {
    verified: ['Verified', 's-good', 'The sheet\'s Sector / Industry / Basic Industry match the official table.'],
    conflicting: ['Conflicting', 's-warn', 'The basic industry is official but the sheet\'s sector / industry above it differ; the official parents are used.'],
    pending: ['Pending verification', 's-info', 'The sheet\'s basic industry is not an official name - check it in the sheet.'],
    unclassified: ['Unclassified', '', 'No classification in the sheet.']
  };
  var STRAT_CLS = { qualified: 's-good', watch: 's-info', avoid: 's-bad', insufficient: 's-warn', none: '' };
  var STRAT_LIST = [['qualified', 'Qualified'], ['watch', 'Watch'], ['avoid', 'Avoid'], ['none', 'No signal'], ['insufficient', 'Insufficient data']];
  var VIEWS = [['all', 'All'], ['large', 'Large'], ['mid', 'Mid'], ['small', 'Small'], ['other', 'Other'], ['notverified', 'Not verified']];
  var LEVEL_NAME = IND.LEVEL_NAMES;
  var CHILD_NAME = { macro: 'sectors', sector: 'industries', industry: 'basic industries' };
  var RESEARCH = 'Research note - general analysis written for Stock Blueprint, not NSE text and not verified facts.';
  var NO_DEF = 'Official NSE definition: <b>Data unavailable</b> (NSE\'s definitions document was not accessible when this was built).';

  // ---------- data ----------
  function loadData() {
    if (window.SB_INDUSTRIES) return Promise.resolve(window.SB_INDUSTRIES);
    return ui.loadScript('data/industries.js').then(function () {
      if (!window.SB_INDUSTRIES) throw new Error('data/industries.js has no classification');
      return window.SB_INDUSTRIES;
    });
  }
  function loadProfiles() {
    if (window.SB_INDUSTRY_PROFILES) return Promise.resolve(window.SB_INDUSTRY_PROFILES);
    return ui.loadScript('data/industry-profiles.js').then(function () { return window.SB_INDUSTRY_PROFILES || null; });
  }

  // index, mapping and table rows: built once per classification file + stock list
  var MEMO = null;
  function model(ctx) {
    var D = window.SB_INDUSTRIES;
    if (MEMO && MEMO.D === D && MEMO.stocks === ctx.stocks) return MEMO;
    var I = IND.createIndex(D);
    var map = IND.mapStocks(I, ctx.stocks);
    var row = {};
    var rows = ctx.stocks.map(function (s) {
      var c = map.bySym[s.sym], cap = IND.capBucket(s);
      var r = { sym: s.sym, name: s.name, s: s, c: c, status: c.status, basicId: c.basicId || '', industryId: c.industryId || '',
        sectorId: c.sectorId || '', macroId: c.macroId || '', cap: cap.key, capLabel: cap.label, exchange: s.exchange || 'NSE' };
      row[s.sym] = r;
      return r;
    });
    MEMO = { D: D, stocks: ctx.stocks, I: I, map: map, rows: rows, row: row, S: null, ret: {}, cs: null };
    return MEMO;
  }
  function searchIdx(M) { return M.S || (M.S = IND.searchIndex(M.I, M.stocks, M.map)); }
  /** Stocks shown under a node: mapped members plus Pending stocks placed under its official industry. */
  function shownRows(M, id) {
    var n = M.I.node(id);
    var out = M.map.byNode(id).map(function (s) { return M.row[s]; });
    if (n && n.level !== 'basic') {
      var k = n.level + 'Id';
      M.rows.forEach(function (r) { if (r.status === 'pending' && r[k] === id) out.push(r); });
    }
    return out;
  }

  // ---------- candles, returns ----------
  function histLen(ctx) { var H = ctx.history; return H && H.dates ? H.dates.length : null; }
  function lastCandle(ctx) { var H = ctx.history; return H && H.dates && H.dates.length ? H.dates[H.dates.length - 1] : null; }
  function periodOk(ctx, p) {
    if (p === '1D') return true;
    var n = histLen(ctx);
    return n == null || n > IND.PERIOD_BARS[p];          // unknown until the candles load
  }
  function periodWhy(ctx, p) {
    return p + ' needs more than ' + IND.PERIOD_BARS[p] + ' daily candles; the candle history has ' + F.int(histLen(ctx)) +
      ' sessions (History30 keeps about 30; History60 adds older days once your PC sends them).';
  }
  function candles(ctx) { return ctx.history && SB.strategies ? SB.strategies.candles() : null; }
  /** { sym: return % | null } for a period, or null while the candles are not loaded. */
  function returnsFor(M, ctx, p) {
    var out = {};
    if (p === '1D') { M.stocks.forEach(function (s) { out[s.sym] = isNum(s.chg) ? s.chg : null; }); return out; }
    var C = candles(ctx);
    if (!C) return null;
    var k = p + '|' + histLen(ctx) + '|' + lastCandle(ctx);
    if (M.ret[p] && M.ret[p].k === k) return M.ret[p].v;
    M.stocks.forEach(function (s) { var r = IND.periodReturn(s, C[s.sym], p); out[s.sym] = r ? r.value : null; });
    M.ret[p] = { k: k, v: out };
    return out;
  }
  /** Per stock: volume trend % and average daily turnover (Rs crore) over the candle window. */
  function candleStats(M, ctx) {
    var C = candles(ctx);
    if (!C) return null;
    var k = histLen(ctx) + '|' + lastCandle(ctx);
    if (M.cs && M.cs.k === k) return M.cs;
    var vol = {}, turn = {};
    M.stocks.forEach(function (s) {
      var c = C[s.sym] || [];
      vol[s.sym] = IND.volumeTrend(c);
      var t = c.map(function (b) { return isNum(b.c) && isNum(b.v) ? b.c * b.v : null; }).filter(isNum);
      turn[s.sym] = t.length ? t.reduce(function (a, b) { return a + b; }, 0) / t.length / 1e7 : null;
    });
    M.cs = { k: k, vol: vol, turn: turn };
    return M.cs;
  }
  /** Equal-weighted node summary for a period (members = verified + conflicting stocks). */
  function nodeStats(M, id, vals, cs) {
    var syms = M.map.byNode(id);
    var a = IND.aggregate(syms.map(function (s) { return { sym: s, value: vals ? vals[s] : null }; }));
    a.id = id;
    a.volTrend = null;
    if (cs) { var v = syms.map(function (s) { return cs.vol[s]; }).filter(isNum); a.volTrend = IND.median(v); }
    return a;
  }
  function nifty(ctx) {
    var r = ctx.D && ctx.D.indices ? ui.objRows(ctx.D.indices).filter(function (x) { return x['NSE Symbol'] === 'NIFTY_50'; })[0] : null;
    return r && isNum(r['Day change']) ? r['Day change'] : null;
  }
  /** Load the daily candles once; done(err) runs only while the page is still shown. */
  function ensureHistory(el, done) {
    if (SB.ctx.history) return;
    SB.loadHistory().then(function () { if (el.isConnected) done(null); }, function (e) { if (el.isConnected) done(e || new Error('unknown error')); });
  }

  // ---------- small renderers ----------
  function versionLabel(v) {
    var m = /^(\d{4})-(\d{2})$/.exec(String(v || ''));
    return m ? ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][+m[2] - 1] + ' ' + m[1] : String(v || '–');
  }
  function sourceLine(D) {
    var v = D.meta.verification || {};
    return 'Official ' + esc(D.meta.title) + ' (' + esc(versionLabel(D.meta.version)) + ') - transcribed in your Code.gs; checked ' + F.date(v.checkedAgainstCodeGs) +
      '; online re-verification ' + (v.lastVerifiedOnline ? F.date(v.lastVerifiedOnline) : 'pending') +
      ' <span class="badge s-info" tabindex="0" data-tip="' + esc(v.note || '') + '">about the source</span>';
  }
  function statusBadge(c) {
    var s = STATUS[c.status] || STATUS.unclassified;
    return '<span class="badge ' + s[1] + '" tabindex="0" data-tip="' + esc(c.note || s[2]) + '">' + esc(s[0]) + '</span>';
  }
  function levelChip(level) { return '<span class="badge s-info">' + esc(LEVEL_NAME[level]) + '</span>'; }
  function crumbsHtml(I, id) {
    return '<nav class="ix-crumbs" aria-label="Classification path"><a href="#industries">Industries</a>' + I.path(id).map(function (n) {
      return ' <span aria-hidden="true">›</span> <a href="' + I.route(n.id) + '" data-lv="' + n.level + '"' + (n.id === id ? ' aria-current="page"' : '') + '>' + esc(n.name) + '</a>';
    }).join('') + '</nav>';
  }
  function crumbText(I, id) { return I.crumbs(id).join(' › '); }
  function watched() {
    var w = ui.store.get('industry:watch', []);
    return Array.isArray(w) ? w.filter(function (x) { return typeof x === 'string'; }) : [];
  }
  function setWatched(id, on) {
    var w = watched().filter(function (x) { return x !== id; });
    if (on) w.push(id);
    ui.store.set('industry:watch', w);
  }
  function starHtml(n) {
    var on = watched().indexOf(n.id) >= 0;
    return '<button type="button" class="ix-star" data-watch="' + esc(n.id) + '" aria-pressed="' + on + '" aria-label="Watch ' + esc(n.name) +
      '" title="' + (on ? 'In' : 'Add to') + ' your industry watchlist (saved in this browser)">' + (on ? '★' : '☆') + '</button>';
  }
  function bindStars(el, after) {
    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-watch]');
      if (!b) return;
      var id = b.getAttribute('data-watch'), on = b.getAttribute('aria-pressed') !== 'true';
      setWatched(id, on);
      el.querySelectorAll('[data-watch="' + id + '"]').forEach(function (x) {
        x.setAttribute('aria-pressed', String(on));
        x.textContent = on ? '★' : '☆';
        x.title = (on ? 'In' : 'Add to') + ' your industry watchlist (saved in this browser)';
      });
      if (after) after();
    });
  }
  function periodChips(name, cur, ctx) {
    var off = PERIODS.filter(function (p) { return !periodOk(ctx, p); });
    return '<div class="chips" role="group" aria-label="Period">' + PERIODS.map(function (p) {
      var ok = periodOk(ctx, p);
      return '<button type="button" class="chip" data-chip="' + name + '" data-v="' + p + '" aria-pressed="' + (p === cur) + '"' +
        (ok ? '' : ' disabled title="' + esc(periodWhy(ctx, p)) + '"') + '>' + p + '</button>';
    }).join('') + '</div>' +
      (off.length ? '<p class="sub ix-why">' + esc(off.join(' / ')) + ' unavailable: they need more than ' + IND.PERIOD_BARS[off[0]] +
        ' daily candles and the candle history has ' + F.int(histLen(ctx)) + ' sessions (History30 keeps about 30; History60 adds older days once your PC sends them).</p>' : '');
  }
  function freshHtml(ctx, p) {
    if (p === '1D') return 'Prices: ' + ui.stateBadge(ctx.market.state, ctx.market.asOf, ctx.market.source);
    var last = lastCandle(ctx);
    return last ? 'Daily closes to ' + ui.stateBadge(SB.candleState(ctx.history), last, ctx.history.source || 'History30 tab') : 'Daily candles: loading…';
  }
  function methodHtml() {
    return '<details class="ix-method"><summary>How this is calculated</summary><ul class="ix-ul">' +
      '<li>Members of an industry are the stocks mapped to it through their official basic industry (Verified + Conflicting). Pending verification and Unclassified stocks are left out.</li>' +
      '<li>Every figure is <b>equal-weighted</b>: the headline is the median of the members\' returns; the mean is shown as well.</li>' +
      '<li>1D is the price change shown on this site (DELAYED / EOD / CACHED - see the badge). 1W and 1M compare the last daily close with the close 5 / 21 sessions earlier. ' +
      '3M, 6M and 1Y need longer candle history than the sheet keeps.</li>' +
      '<li>Breadth = advancers / (advancers + decliners). Volume trend = median of the members\' 5-day vs prior 20-day average volume.</li>' +
      '<li>Only industries with at least ' + IND.MIN_MEMBERS + ' stocks with data are ranked strong / weak, so one big mover cannot rank an industry.</li>' +
      '<li>Benchmark: NIFTY 50 day change from the sheet\'s Indextracker tab (1D only, a cached snapshot).</li>' +
      '<li>Research only, not advice. Industry strength is separate from a stock\'s fundamentals, technicals and the strategy: a stock is never recommended because its industry is strong.</li>' +
      '</ul></details>';
  }
  function symPct(x) { return x ? '<button type="button" class="linkish" data-sym="' + esc(x.sym) + '">' + esc(x.sym) + '</button> ' + ui.deltaHtml(x.value, 1) : '<span class="sub">–</span>'; }
  function vsHtml(v) {
    if (!isNum(v)) return '<span class="sub">–</span>';
    return '<span class="' + (v > 0 ? 'up' : v < 0 ? 'down' : '') + '">' + F.pct(v, 2).replace('%', ' pp') + '</span>';
  }
  function capFmt(v) { return !isNum(v) || v <= 0 ? '–' : v >= 1e5 ? F.num(v / 1e5, 2) + ' lakh Cr' : F.cr(v); }
  function loadingNote(text) { return '<div class="ix-loading">' + ui.skeleton(3) + '<p class="sub">' + esc(text) + '</p></div>'; }
  function errNote(text, e, attr) {
    return '<div class="note bad">' + esc(text) + ' (' + esc((e && e.message) || String(e)) + '). <button type="button" class="btn" ' + attr + '>Retry</button></div>';
  }
  function listHtml(items) { return items && items.length ? '<ul class="ix-ul">' + items.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '<p class="sub">Data unavailable</p>'; }
  function scrollToEl(x) {
    if (!x) return;
    var top = x.getBoundingClientRect().top + window.scrollY - 150;
    window.scrollTo(0, Math.max(0, top));
  }

  // ---------- strategy (read only) ----------
  function stratInfo() {
    var S = SB.strategies;
    if (!S) return null;
    var cfg = S.get(S.activeId());
    return cfg ? { cfg: cfg, d: S.describe(cfg) } : null;
  }
  function runStrategy() {
    if (!SB.strategies) return Promise.reject(new Error('the strategy module did not load'));
    try { return SB.strategies.runActive(); } catch (e) { return Promise.reject(e); }
  }
  function checksHtml(r) {
    return '<ul class="checks">' + (r.checks || []).map(function (k) {
      var p = k.res.pass, mark = p === true ? '<span class="ok" aria-label="passed">✓</span>' : p === false ? '<span class="no" aria-label="failed">✗</span>' : '<span class="na" aria-label="not applicable">–</span>';
      var tag = k.group === 'filter' ? 'Filter' : k.group === 'trigger' ? (k.watchOnly ? 'Watch' : 'Signal') : 'Requirement';
      return '<li>' + mark + '<span><b>' + esc(tag) + ':</b> ' + esc(k.label) + (k.res.detail ? ' <span class="sub">(' + esc(k.res.detail) + ')</span>' : '') + '</span></li>';
    }).join('') + '</ul>';
  }
  function stratBadge(r) { return r ? ui.badge(r.statusLabel, STRAT_CLS[r.status] != null ? STRAT_CLS[r.status] : '') : '<span class="sub">–</span>'; }

  // =====================================================================
  // #industries - landing
  // =====================================================================
  function renderLanding(el, ctx, M) {
    var D = M.D, I = M.I, cnt = M.map.counts, total = M.rows.length;
    var verifiedBasics = Object.keys(M.map.byBasic).filter(function (b) {
      return M.map.byBasic[b].some(function (s) { return M.map.bySym[s].status === 'verified'; });
    }).length;
    var prof = D.meta.profiles || { written: 0 };
    var wide = window.innerWidth >= 760;

    var h = '<div class="page-head"><div><h1>Industries &amp; sectors</h1><p>' + sourceLine(D) + '</p>' +
      '<p>Companies: the stocks in your Main tab, matched by their own Sector / Industry / Basic Industry columns. ' +
      ui.stateBadge(ctx.market.state, ctx.market.asOf, ctx.market.source) + '</p></div></div>';
    h += '<div class="tiles ix-tiles" id="ix-tiles">' +
      ui.tile('Macro-economic sectors', '<span data-count="macro">' + F.int(I.counts.macro) + '</span>') +
      ui.tile('Sectors', '<span data-count="sector">' + F.int(I.counts.sector) + '</span>') +
      ui.tile('Industries', '<span data-count="industry">' + F.int(I.counts.industry) + '</span>') +
      ui.tile('Basic industries', '<span data-count="basic">' + F.int(I.counts.basic) + '</span>') +
      ui.tile('Classified companies', F.int(cnt.verified + cnt.conflicting),
        'of ' + F.int(total) + ' · ' + F.int(cnt.verified) + ' verified · ' + F.int(cnt.conflicting) + ' conflicting · <a href="#industries/companies">' +
        F.int(cnt.pending) + ' pending · ' + F.int(cnt.unclassified) + ' unclassified</a>') +
      ui.tile('Basic industries with verified companies', F.int(verifiedBasics), 'of ' + F.int(I.counts.basic)) +
      ui.tile('Research notes', F.int(prof.written), 'of ' + F.int(I.counts.basic) + ' basic industries · general analysis, not NSE text') +
      ui.tile('Classification version', esc(versionLabel(D.meta.version)), 'checked against Code.gs ' + F.date((D.meta.verification || {}).checkedAgainstCodeGs)) +
      '</div>';
    h += '<section class="card"><div class="card-head"><div><h2>Find an industry or company</h2>' +
      '<p>Searches all four levels, company names and NSE symbols. Partial words and small typos work.</p></div></div>' +
      '<div class="ix-combo"><label class="sr-only" for="ix-q">Search industries and companies</label>' +
      '<input id="ix-q" class="search" type="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="ix-q-list" autocomplete="off" ' +
      'placeholder="e.g. cement, private bank, SBIN, pharmaceuticals">' +
      '<div id="ix-q-list" class="ix-list" role="listbox" aria-label="Search results" hidden></div></div>' +
      '<div class="links"><a class="btn" href="#industries/companies">All companies &amp; filters</a><a class="btn" href="#industries/groups">Dashboard groups (24 categories)</a>' +
      '<a class="btn" href="#industries/review">Classification review</a></div></section>';
    h += '<div class="ix-layout"><div class="ix-side"><details class="card ix-tree-card" id="ix-tree-box"' + (wide ? ' open' : '') + '>' +
      '<summary><h2>Classification hierarchy</h2><span class="sub">Macro sector › Sector › Industry › Basic industry · stocks · 1D median</span></summary>' +
      '<div class="controls" style="margin-top:10px"><label class="sr-only" for="ix-tf">Filter the hierarchy</label>' +
      '<input id="ix-tf" class="search" type="search" autocomplete="off" placeholder="Filter the tree" value="' + esc(TREE.q) + '">' +
      '<button type="button" class="btn" id="ix-exp">Expand all</button><button type="button" class="btn" id="ix-col">Collapse all</button></div>' +
      '<div class="ix-tree" id="ix-tree"></div></details></div>' +
      '<div class="ix-main">' +
      '<section class="card" id="ix-watch"><div class="card-head"><div><h2>Your industry watchlist</h2><p>Saved in this browser only.</p></div></div><div id="ix-watch-body"></div></section>' +
      '<section class="card" id="ix-dash"><div class="card-head"><div><h2>Industry performance</h2><p id="ix-dash-fresh"></p></div></div>' +
      '<div class="controls"><div id="ix-pchips"></div><label class="sr-only" for="ix-level">Level</label><select class="sel" id="ix-level">' +
      [['basic', 'Basic industries'], ['industry', 'Industries'], ['sector', 'Sectors'], ['macro', 'Macro-economic sectors']].map(function (o) {
        return '<option value="' + o[0] + '"' + (DASH.level === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
      }).join('') + '</select></div><div id="ix-dash-body"></div>' + methodHtml() + '</section>' +
      '</div></div>';
    el.innerHTML = h;

    // ----- search combobox -----
    bindCombo(el, M, ctx);

    // ----- tree -----
    var open = {};
    (ui.store.get('industry:tree', []) || []).forEach(function (id) { if (I.node(id)) open[id] = true; });
    function saveOpen() { ui.store.set('industry:tree', Object.keys(open).filter(function (k) { return open[k]; })); }
    var vals1D = returnsFor(M, ctx, '1D');
    function treeVisible() {
      var q = IND.key(TREE.q);
      if (!q) return null;
      var vis = {}, exp = {};
      Object.keys(I.byId).forEach(function (id) {
        var n = I.byId[id], aliases = (n.raw && n.raw.aliases) || [];
        var hit = IND.key(n.name).indexOf(q) >= 0 || aliases.some(function (a) { return IND.key(a).indexOf(q) >= 0; });
        if (!hit) return;
        I.path(id).forEach(function (p) { vis[p.id] = true; if (p.id !== id) exp[p.id] = true; });
        (function down(x) { x.children.forEach(function (c) { vis[c] = true; down(I.byId[c]); }); })(n);
      });
      return { vis: vis, exp: exp };
    }
    function drawTree(focusId) {
      var f = treeVisible();
      var isOpen = function (id) { return f ? !!(f.exp[id] || open[id]) : !!open[id]; };
      function node(id) {
        var n = I.byId[id];
        if (f && !f.vis[id]) return '';
        var syms = M.map.byNode(id), kids = n.children.length && n.level !== 'basic', o = kids && isOpen(id);
        var a = IND.aggregate(syms.map(function (s) { return { sym: s, value: vals1D[s] }; }));
        return '<li class="lv-' + n.level + '"><div class="ix-row">' +
          (kids ? '<button type="button" class="ix-tog" data-tog="' + id + '" aria-expanded="' + o + '" aria-label="' + (o ? 'Hide' : 'Show') + ' the ' + CHILD_NAME[n.level] + ' of ' + esc(n.name) + '">' + (o ? '▾' : '▸') + '</button>' : '<span class="ix-tog-sp"></span>') +
          '<a class="ix-name" href="' + I.route(id) + '" title="' + esc(n.name) + '">' + esc(n.name) + '</a>' +
          '<span class="ix-n" title="Mapped stocks">' + F.int(syms.length) + '</span>' +
          '<span class="ix-chg" data-tip="' + esc('1D median of ' + a.withData + ' stock' + (a.withData === 1 ? '' : 's') + ' with a price change') + '">' + (a.withData ? ui.deltaHtml(a.median, 1) : '<span class="sub">–</span>') + '</span>' +
          (n.level === 'basic' || n.level === 'industry' ? starHtml(n) : '<span class="ix-star-sp"></span>') + '</div>' +
          (o ? '<ul>' + n.children.map(node).join('') + '</ul>' : '') + '</li>';
      }
      var out = I.macros.map(function (m) { return node(m.id); }).join('');
      $('#ix-tree', el).innerHTML = out ? '<ul class="ix-root">' + out + '</ul>' : '<p class="empty">Nothing in the hierarchy matches “' + esc(TREE.q) + '”.</p>';
      if (focusId) { var b = el.querySelector('[data-tog="' + focusId + '"]'); if (b) b.focus(); }
    }
    el.addEventListener('click', function (e) {
      var t = e.target.closest('[data-tog]');
      if (t) {
        var id = t.getAttribute('data-tog');
        open[id] = t.getAttribute('aria-expanded') !== 'true';
        saveOpen();
        drawTree(id);
      }
    });
    var tt;
    $('#ix-tf', el).addEventListener('input', function (e) { clearTimeout(tt); tt = setTimeout(function () { TREE.q = e.target.value.trim(); drawTree(); }, 150); });
    $('#ix-exp', el).addEventListener('click', function () {
      I.macros.concat(I.sectors, I.industries).forEach(function (n) { open[n.id] = true; });
      saveOpen(); drawTree();
    });
    $('#ix-col', el).addEventListener('click', function () { open = {}; saveOpen(); drawTree(); });
    drawTree();

    // ----- performance dashboard -----
    var run = null;
    function drawChips() { $('#ix-pchips', el).innerHTML = periodChips('ixp', DASH.period, ctx); }
    function drawDash() {
      var body = $('#ix-dash-body', el), p = DASH.period;
      $('#ix-dash-fresh', el).innerHTML = freshHtml(ctx, p) + (p === '1D' ? ' · Benchmark NIFTY 50: ' + ui.deltaHtml(nifty(ctx), 2) + ' ' + ui.stateBadge('CACHED', ctx.D.asOf || ctx.D.generated, 'Indextracker tab') : '');
      if (!periodOk(ctx, p)) { body.innerHTML = '<div class="note warn">' + esc(periodWhy(ctx, p)) + '</div>'; return; }
      var vals = returnsFor(M, ctx, p);
      if (!vals) { body.innerHTML = loadingNote('Loading daily candles for ' + p + ' returns…'); return; }
      var cs = candleStats(M, ctx), nb = p === '1D' ? nifty(ctx) : null;
      var list = (DASH.level === 'macro' ? I.macros : DASH.level === 'sector' ? I.sectors : DASH.level === 'industry' ? I.industries : I.basics);
      var aggs = list.map(function (n) { var a = nodeStats(M, n.id, vals, cs); a.name = n.name; a.vs = isNum(nb) && isNum(a.median) ? a.median - nb : null; return a; });
      var ranked = aggs.filter(function (a) { return a.ranked; }).sort(function (a, b) { return b.median - a.median || a.name.localeCompare(b.name); });
      var k = Math.min(10, Math.floor(ranked.length / 2));
      var left = aggs.filter(function (a) { return !a.ranked; }).length;
      var all = IND.aggregate(M.rows.filter(function (r) { return r.basicId; }).map(function (r) { return { sym: r.sym, value: vals[r.sym] }; }));
      function barsOf(xs) {
        return xs.length ? ui.bars(xs.map(function (a) {
          return { label: a.name, value: a.median, href: I.route(a.id), tip: a.name + ': median ' + F.pct(a.median, 2) + ' · ' + a.adv + ' up, ' + a.dec + ' down · ' + a.withData + ' stocks with data' };
        }), { diverging: true, fmt: function (v) { return F.pct(v, 2); } }) : '<p class="empty">Not enough ranked ' + esc(LEVEL_NAME[DASH.level].toLowerCase()) + ' groups</p>';
      }
      var lvl = DASH.level === 'basic' ? 'basic industries' : DASH.level === 'industry' ? 'industries' : DASH.level === 'sector' ? 'sectors' : 'macro-economic sectors';
      body.innerHTML = '<p class="sub">Market breadth ' + esc(p) + ' (all mapped stocks): <span class="up">▲ ' + F.int(all.adv) + '</span> · <span class="down">▼ ' + F.int(all.dec) + '</span>' +
        (all.flat ? ' · ' + F.int(all.flat) + ' unchanged' : '') + ' · ' + (isNum(all.breadthPct) ? F.num(all.breadthPct, 0) + '% advancing' : '–') + ' · median ' + ui.deltaHtml(all.median, 2) + '</p>' +
        '<div class="grid g2" style="margin-top:10px"><div><h3 class="ix-h3">Strongest ' + k + ' ' + esc(lvl) + '</h3>' + barsOf(ranked.slice(0, k)) + '</div>' +
        '<div><h3 class="ix-h3">Weakest ' + k + ' ' + esc(lvl) + '</h3>' + barsOf(ranked.slice(ranked.length - k).reverse()) + '</div></div>' +
        (left ? '<p class="sub" style="margin-top:8px">' + F.int(left) + ' ' + esc(lvl) + ' have fewer than ' + IND.MIN_MEMBERS + ' stocks with data for ' + esc(p) + ' and are not ranked.</p>' : '') +
        '<div class="controls" style="margin:12px 0 0"><label class="sub"><input type="checkbox" id="ix-unr"' + (DASH.unranked ? ' checked' : '') + '> Show the ' + F.int(left) +
        ' unranked ones in the table too</label><span class="count">' + F.int(DASH.unranked ? aggs.length : ranked.length) + ' ' + esc(lvl) + '</span></div>' +
        '<div id="ix-dash-tbl" style="margin-top:8px"></div>';
      new ui.Table({
        rows: DASH.unranked ? aggs : ranked, pageSize: 15, sort: { key: 'median', dir: -1 }, empty: 'No ranked groups at this level for ' + p,
        columns: [
          { key: 'name', label: LEVEL_NAME[DASH.level], wrap: true, html: function (a) {
            var n = I.node(a.id), par = n.parentId ? I.node(n.parentId) : null;
            return '<a href="' + I.route(a.id) + '">' + esc(a.name) + '</a>' + (par ? '<span class="co">' + esc(par.name) + '</span>' : '');
          } },
          { key: 'n', label: 'Stocks', type: 'num', digits: 0 },
          { key: 'withData', label: 'With data', type: 'num', digits: 0 },
          { key: 'median', label: 'Median', type: 'pct', digits: 2, title: 'Equal-weighted median return of the members' },
          { key: 'mean', label: 'Mean', type: 'pct', digits: 2 },
          { key: 'breadthPct', label: 'Breadth', type: 'num', digits: 0, title: '% advancing of advancers + decliners',
            html: function (a) { return isNum(a.breadthPct) ? F.num(a.breadthPct, 0) + '%' : '<span class="sub">–</span>'; } },
          { key: 'ad', label: 'Adv / dec', get: function (a) { return a.adv - a.dec; }, html: function (a) { return '<span class="up">' + a.adv + '</span> / <span class="down">' + a.dec + '</span>'; } },
          { key: 'lead', label: 'Leader', get: function (a) { return a.leaders[0] ? a.leaders[0].value : null; }, html: function (a) { return a.withData ? symPct(a.leaders[0]) : '<span class="sub">–</span>'; }, csv: function (a) { return a.leaders[0] ? a.leaders[0].sym : ''; } },
          { key: 'lag', label: 'Laggard', get: function (a) { return a.laggards[0] ? a.laggards[0].value : null; }, html: function (a) { return a.withData ? symPct(a.laggards[0]) : '<span class="sub">–</span>'; }, csv: function (a) { return a.laggards[0] ? a.laggards[0].sym : ''; } },
          { key: 'volTrend', label: 'Volume trend', type: 'pct', digits: 0, title: 'Median of members\' 5-day vs prior 20-day average volume (daily candles)' },
          { key: 'vs', label: 'vs NIFTY 50', title: '1D only: median minus the NIFTY 50 day change (percentage points)', type: 'num', html: function (a) { return vsHtml(a.vs); } },
          { key: 'ranked', label: 'Ranked', title: 'At least ' + IND.MIN_MEMBERS + ' stocks with data', get: function (a) { return a.ranked ? 'yes' : 'no'; },
            html: function (a) { return a.ranked ? '<span class="sub">yes</span>' : '<span class="sub" title="fewer than ' + IND.MIN_MEMBERS + ' stocks with data">no</span>'; } }
        ]
      }).mount($('#ix-dash-tbl', el));
    }
    ui.bindChips(el, 'ixp', function (v) {
      DASH.period = v;
      drawDash();
      if (v !== '1D' && !ctx.history) ensureHistory(el, onHistory);
    });
    $('#ix-level', el).addEventListener('change', function (e) { DASH.level = e.target.value; drawDash(); });
    el.addEventListener('change', function (e) { if (e.target.id === 'ix-unr') { DASH.unranked = e.target.checked; drawDash(); } });
    function onHistory(err) {
      drawChips();
      if (err && DASH.period !== '1D') { $('#ix-dash-body', el).innerHTML = errNote('Daily candles could not be loaded', err, 'data-retry-h'); return; }
      drawDash();
      drawWatch();
    }
    el.addEventListener('click', function (e) { if (e.target.closest('[data-retry-h]')) { $('#ix-dash-body', el).innerHTML = loadingNote('Loading daily candles…'); ensureHistory(el, onHistory); } });
    drawChips();
    drawDash();

    // ----- watchlist -----
    function drawWatch() {
      var ids = watched().filter(function (id) { return I.node(id); });
      var host = $('#ix-watch-body', el);
      if (!ids.length) {
        host.innerHTML = '<p class="empty">No industries watched yet. Press the ☆ next to an industry or basic industry in the hierarchy, or on its page, to follow it here.</p>';
        return;
      }
      var lr = run || (SB.strategies && SB.strategies.lastRun());
      host.innerHTML = '<ul class="list">' + ids.map(function (id) {
        var n = I.node(id), syms = M.map.byNode(id);
        var a = IND.aggregate(syms.map(function (s) { return { sym: s, value: vals1D[s] }; }));
        var q = lr ? syms.filter(function (s) { var r = lr.bySym[s]; return r && r.status === 'qualified'; }).length : null;
        return '<li><div class="grow"><a href="' + I.route(id) + '">' + esc(n.name) + '</a><span class="co">' + esc(LEVEL_NAME[n.level]) + ' · ' + esc(crumbText(I, id)) + '</span></div>' +
          '<span class="sub" style="white-space:nowrap">' + F.int(syms.length) + ' stocks</span>' +
          '<span class="num" data-tip="1D median of the members">' + (a.withData ? ui.deltaHtml(a.median, 2) : '<span class="sub">–</span>') + '</span>' +
          '<span class="sub" style="white-space:nowrap" title="Qualified under the active strategy">' + (q == null ? '' : F.int(q) + ' qualified') + '</span>' + starHtml(n) + '</li>';
      }).join('') + '</ul>' + (lr ? '<p class="sub" style="margin-top:8px">Qualified = active strategy “' + esc(lr.config.name) + '” (' + esc(SB.strategies.describe(lr.config).tag) + '), candles to ' + esc(lr.dataAsOf || '–') + '.</p>' : '');
    }
    bindStars(el, function () { drawWatch(); });
    drawWatch();

    // candles (1W / 1M, volume trend) and, with a watchlist, strategy counts - after the first paint
    setTimeout(function () {
      if (!el.isConnected) return;
      if (!ctx.history) ensureHistory(el, onHistory);
      if (watched().length) runStrategy().then(function (r) { run = r; if (el.isConnected) drawWatch(); }, function () { /* counts stay hidden */ });
    }, 50);
  }

  // ---------- search combobox (landing) ----------
  function bindCombo(el, M, ctx) {
    var inp = $('#ix-q', el), box = $('#ix-q-list', el), items = [], active = -1, timer;
    var TYPE = { macro: 'Macro sector', sector: 'Sector', industry: 'Industry', basic: 'Basic industry', company: 'Company' };
    function close() { box.hidden = true; inp.setAttribute('aria-expanded', 'false'); inp.removeAttribute('aria-activedescendant'); active = -1; }
    function paint() {
      box.innerHTML = items.length ? items.map(function (r, i) {
        var crumbs = r.type === 'company' ? (r.crumbs.length ? r.crumbs.join(' › ') : 'not mapped to the official hierarchy') : r.crumbs.slice(0, -1).join(' › ');
        return '<div class="ix-opt" role="option" id="ix-opt-' + i + '" data-i="' + i + '" aria-selected="' + (i === active) + '">' +
          '<span class="badge ' + (r.type === 'company' ? '' : 's-info') + '">' + esc(TYPE[r.type]) + '</span><span class="ix-opt-txt">' +
          (r.type === 'company' ? '<b>' + esc(r.sym) + '</b> ' + esc(r.label) : '<b>' + esc(r.label) + '</b>') +
          '<span class="ix-crumb">' + esc(crumbs || 'top level') + (r.type === 'company' ? ' · ' + esc((STATUS[r.status] || STATUS.unclassified)[0]) : '') + '</span></span></div>';
      }).join('') : '<div class="ix-opt-empty">No industry or company matches. Try a shorter word, a symbol or a basic industry name.</div>';
      box.hidden = false;
      inp.setAttribute('aria-expanded', 'true');
      if (active >= 0) inp.setAttribute('aria-activedescendant', 'ix-opt-' + active); else inp.removeAttribute('aria-activedescendant');
    }
    function run() {
      var q = inp.value.trim();
      if (!q) { items = []; close(); return; }
      items = IND.search(searchIdx(M), q, { limit: 12 });
      active = items.length ? 0 : -1;
      paint();
    }
    function choose(r) {
      close();
      if (!r) return;
      if (r.type !== 'company') { location.hash = r.route; return; }
      var target = r.route || '#industries/companies';
      if (!r.route) CO.q = r.sym;
      if (location.hash === target) { SB.openStock(r.sym); return; }
      window.addEventListener('hashchange', function once() {
        window.removeEventListener('hashchange', once);
        setTimeout(function () { SB.openStock(r.sym); }, 0);
      });
      location.hash = target;
    }
    inp.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(run, 120); });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (box.hidden) { run(); return; }
        if (!items.length) return;
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        paint();
        var o = $('#ix-opt-' + active, el); if (o && o.scrollIntoView) o.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        if (!box.hidden && items.length) { e.preventDefault(); clearTimeout(timer); choose(items[active < 0 ? 0 : active]); }
        else { clearTimeout(timer); run(); }
      } else if (e.key === 'Escape') { if (!box.hidden) { e.preventDefault(); close(); } }
    });
    box.addEventListener('mousedown', function (e) { e.preventDefault(); });   // keep focus in the input
    box.addEventListener('click', function (e) { var o = e.target.closest('[data-i]'); if (o) choose(items[+o.getAttribute('data-i')]); });
    inp.addEventListener('blur', function () { setTimeout(close, 150); });
  }

  // ---------- performance block (node + basic pages) ----------
  function perfBlock(el, ctx, M, id, state, hostSel, chipName) {
    function draw() {
      var host = $(hostSel, el), p = state.period;
      if (!host) return;
      var head = '<div class="controls">' + periodChips(chipName, p, ctx) + '</div><p class="sub">' + freshHtml(ctx, p) + '</p>';
      if (!periodOk(ctx, p)) { host.innerHTML = head + '<div class="note warn">' + esc(periodWhy(ctx, p)) + '</div>' + methodHtml(); return; }
      var vals = returnsFor(M, ctx, p);
      if (!vals) { host.innerHTML = head + loadingNote('Loading daily candles for ' + p + ' returns…') + methodHtml(); return; }
      var a = nodeStats(M, id, vals, candleStats(M, ctx)), nb = p === '1D' ? nifty(ctx) : null;
      var lst = function (xs) {
        return xs.length ? '<ul class="list">' + xs.map(function (x) {
          return '<li><div class="grow">' + ui.stockCell(x.sym, ctx.bySym[x.sym] && ctx.bySym[x.sym].name, { noLogo: true }) + '</div><span class="num">' + ui.deltaHtml(x.value, 2) + '</span></li>';
        }).join('') + '</ul>' : '<p class="empty">No stocks with data</p>';
      };
      host.innerHTML = head +
        (a.ranked ? '' : '<div class="note warn">Fewer than ' + IND.MIN_MEMBERS + ' stocks with data for ' + esc(p) + ' (' + a.withData + ' of ' + a.n + ') - shown for reference but not ranked strong / weak.</div>') +
        '<div class="tiles" style="margin-top:10px">' +
        ui.tile('Median ' + p, ui.deltaHtml(a.median, 2), 'equal-weighted · ' + F.int(a.withData) + ' of ' + F.int(a.n) + ' stocks with data') +
        ui.tile('Mean ' + p, ui.deltaHtml(a.mean, 2)) +
        ui.tile('Breadth', isNum(a.breadthPct) ? F.num(a.breadthPct, 0) + '%' : '–', '<span class="up">▲ ' + a.adv + '</span> · <span class="down">▼ ' + a.dec + '</span>' + (a.flat ? ' · ' + a.flat + ' unch.' : '')) +
        ui.tile('Volume trend', ui.deltaHtml(a.volTrend, 0), 'median 5-day vs prior 20-day volume') +
        ui.tile('vs NIFTY 50', p === '1D' ? vsHtml(isNum(nb) && isNum(a.median) ? a.median - nb : null) : '<span class="sub">1D only</span>', p === '1D' ? 'NIFTY 50 ' + F.pct(nb, 2) + ' (Indextracker, cached)' : '') +
        '</div><div class="grid g2" style="margin-top:12px"><div><h3 class="ix-h3">Leaders</h3>' + lst(a.leaders) + '</div><div><h3 class="ix-h3">Laggards</h3>' + lst(a.laggards) + '</div></div>' +
        methodHtml();
    }
    ui.bindChips(el, chipName, function (v) {
      state.period = v;
      draw();
      if (v !== '1D' && !ctx.history) ensureHistory(el, draw);
    });
    return draw;
  }

  // ---------- stock table (node + basic pages) ----------
  function viewFilter(v) {
    return function (r) {
      if (v === 'all') return true;
      if (v === 'notverified') return r.status === 'conflicting' || r.status === 'pending';
      if (v === 'other') return r.cap === 'micro' || r.cap === 'sme' || r.cap === 'other';
      return r.cap === v;
    };
  }
  function viewChips(name, list, cur) {
    return ui.chips(name, VIEWS.map(function (v) { return [v[0], v[1] + ' (' + F.int(list.filter(viewFilter(v[0])).length) + ')']; }), cur);
  }

  // =====================================================================
  // #industries/macro|sector|industry/<slug>
  // =====================================================================
  function renderNode(el, ctx, M, id) {
    var I = M.I, n = I.node(id), raw = n.raw || {};
    var list = shownRows(M, id), members = M.map.byNode(id);
    var st = { verified: 0, conflicting: 0, pending: 0 };
    list.forEach(function (r) { st[r.status] = (st[r.status] || 0) + 1; });
    var vals1D = returnsFor(M, ctx, '1D'), a1 = nodeStats(M, id, vals1D, null);

    var research = '';
    if (n.level === 'industry') {
      research = (raw.description ? '<p>' + esc(raw.description) + '</p>' : '') + (raw.businessOverview ? '<h3 class="ix-h3">Business overview</h3><p>' + esc(raw.businessOverview) + '</p>' : '') +
        '<div class="grid g2" style="margin-top:8px"><div><h3 class="ix-h3">Key demand drivers</h3>' + listHtml(raw.keyDemandDrivers) + '</div>' +
        '<div><h3 class="ix-h3">Key risks</h3>' + listHtml(raw.keyRisks) + '</div></div>';
    } else if (raw.description) research = '<p>' + esc(raw.description) + '</p>';

    var h = '<div class="page-head"><div>' + crumbsHtml(I, id) + '<h1>' + esc(n.name) + ' ' + starHtml(n) + '</h1>' +
      '<p>' + levelChip(n.level) + (raw.code ? ' <span class="badge">' + esc(raw.code) + '</span>' : '') + ' ' + F.int(n.children.length) + ' ' + esc(CHILD_NAME[n.level]) + ' · ' +
      F.int(I.basicsUnder(id).length) + ' basic industr' + (I.basicsUnder(id).length === 1 ? 'y' : 'ies') + ' · official ' + esc(versionLabel(M.D.meta.version)) + ' classification</p></div></div>';
    h += '<div class="tiles">' +
      ui.tile('Mapped stocks', F.int(members.length), F.int(st.verified) + ' verified · ' + F.int(st.conflicting) + ' conflicting' + (st.pending ? ' · ' + F.int(st.pending) + ' pending (listed, not counted)' : '')) +
      ui.tile('1D median', ui.deltaHtml(a1.median, 2), F.int(a1.withData) + ' with a price change' + (a1.ranked ? '' : ' · not ranked')) +
      ui.tile('Breadth today', isNum(a1.breadthPct) ? F.num(a1.breadthPct, 0) + '%' : '–', '<span class="up">▲ ' + a1.adv + '</span> · <span class="down">▼ ' + a1.dec + '</span>') +
      ui.tile(n.level === 'industry' ? 'Basic industries' : n.level === 'sector' ? 'Industries' : 'Sectors', F.int(n.children.length)) +
      '</div>';
    h += ui.card('About', esc(RESEARCH), '<div class="ix-prose">' + (research || '<p class="sub">Research note not written yet.</p>') + '</div>');
    h += '<section class="card"><div class="card-head"><div><h2>' + esc(CHILD_NAME[n.level].replace(/^./, function (c) { return c.toUpperCase(); })) + '</h2><p>Median and breadth for the period below.</p></div></div><div id="ix-kids"></div></section>';
    h += '<section class="card"><div class="card-head"><div><h2>Performance</h2></div></div><div id="ix-perf"></div></section>';
    h += '<section class="card"><div class="card-head"><div><h2>Stocks</h2><p>Click a symbol for details. Cap category by Nifty index membership (Main INDICES column), not the AMFI list.</p></div></div>' +
      '<div class="controls" id="ix-views">' + viewChips('ixv', list, NODE.view) + '</div><div class="controls"><span class="count" id="ix-cnt"></span><button type="button" class="btn" id="ix-csv">Export CSV</button></div><div id="ix-stocks"></div></section>';
    el.innerHTML = h;
    bindStars(el);

    var kidsTable = null;
    function drawKids() {
      var p = NODE.period, vals = periodOk(ctx, p) ? returnsFor(M, ctx, p) : null;
      var rows = n.children.map(function (c) { var a = nodeStats(M, c, vals, null); a.name = I.node(c).name; return a; });
      if (!kidsTable) {
        kidsTable = new ui.Table({
          rows: rows, pageSize: 30, sort: { key: 'name', dir: 1 },
          columns: [
            { key: 'name', label: 'Name', wrap: true, html: function (a) { return '<a href="' + I.route(a.id) + '">' + esc(a.name) + '</a>'; } },
            { key: 'n', label: 'Stocks', type: 'num', digits: 0 },
            { key: 'median', label: 'Median', type: 'pct', digits: 2, title: 'Equal-weighted median for the chosen period' },
            { key: 'breadthPct', label: 'Breadth', type: 'num', html: function (a) { return isNum(a.breadthPct) ? F.num(a.breadthPct, 0) + '%' : '<span class="sub">–</span>'; } },
            { key: 'lead', label: 'Leader', get: function (a) { return a.leaders[0] ? a.leaders[0].value : null; }, html: function (a) { return symPct(a.leaders[0]); } },
            { key: 'ranked', label: 'Ranked', get: function (a) { return a.ranked ? 'yes' : 'no'; } }
          ]
        }).mount($('#ix-kids', el));
      } else kidsTable.setRows(rows);
    }
    var perf = perfBlock(el, ctx, M, id, NODE, '#ix-perf', 'ixnp');
    function both() { perf(); drawKids(); }
    ui.bindChips(el, 'ixnp', function () { drawKids(); });
    var t = new ui.Table({
      rows: [], pageSize: 25, sort: { key: 'mcap', dir: -1 }, empty: 'No stocks in this view',
      columns: stockColumns(M, ctx, I, true)
    }).mount($('#ix-stocks', el));
    function apply() {
      var rows = list.filter(viewFilter(NODE.view));
      $('#ix-cnt', el).textContent = F.int(rows.length) + ' of ' + F.int(list.length) + ' stocks';
      t.setRows(rows);
    }
    ui.bindChips(el, 'ixv', function (v) { NODE.view = v; apply(); });
    $('#ix-csv', el).addEventListener('click', function () { ui.download('industry-' + IND.slugOf(id) + '.csv', ui.toCsv(t.toCsvRows())); });
    apply();
    both();
    if (!ctx.history) setTimeout(function () { if (el.isConnected) ensureHistory(el, function () { both(); }); }, 50);
  }

  /** Stock columns shared by node and companies tables. */
  function stockColumns(M, ctx, I, withBasic) {
    var cols = [
      { key: 'sym', label: 'Stock', type: 'sym', name: 'name', csv: function (r) { return r.sym; } },
      { key: 'name', label: 'Company', csvOnly: true }
    ];
    if (withBasic) {
      cols.push({ key: 'basic', label: 'Basic industry', wrap: true, get: function (r) { return r.basicId ? I.node(r.basicId).name : r.c.sheet.basic || ''; },
        html: function (r) {
          if (r.basicId) return '<a href="' + I.route(r.basicId) + '" title="' + esc(crumbText(I, r.basicId)) + '">' + esc(I.node(r.basicId).name) + '</a>';
          if (r.industryId) return '<a href="' + I.route(r.industryId) + '" title="' + esc(crumbText(I, r.industryId)) + '">' + esc(I.node(r.industryId).name) + '</a><span class="co">sheet: ' + esc(r.c.sheet.basic || '–') + '</span>';
          return '<span class="sub">' + esc(r.c.sheet.basic || '–') + '</span>';
        } });
      cols.push({ key: 'path', label: 'Official path', csvOnly: true, get: function (r) { var x = r.basicId || r.industryId; return x ? crumbText(I, x) : ''; } });
    }
    cols.push(
      { key: 'status', label: 'Classification', get: function (r) { return STATUS[r.status][0]; }, html: function (r) { return statusBadge(r.c); } },
      { key: 'cap', label: 'Cap category', get: function (r) { return r.capLabel; }, title: 'By Nifty index membership in the Main INDICES column (not AMFI)' },
      { key: 'exchange', label: 'Exchange', get: function (r) { return r.exchange; } },
      { key: 'bse', label: 'BSE code', csvOnly: true, get: function () { return 'Data unavailable'; } },
      { key: 'price', label: 'Price', type: 'price', get: function (r) { return r.s.price; } },
      { key: 'chg', label: '1D', type: 'pct', digits: 2, get: function (r) { return r.s.chg; } },
      { key: 'mcap', label: 'Market cap', type: 'num', digits: 0, get: function (r) { return r.s.mcap; }, html: function (r) { return capFmt(r.s.mcap); }, title: 'Rs crore (Main MCAP(CR))' },
      { key: 'priceState', label: 'Price state', csvOnly: true, get: function (r) { return r.s.priceState + ' ' + (r.s.priceAsOf || ''); } }
    );
    return cols;
  }

  // =====================================================================
  // #industries/companies
  // =====================================================================
  function renderCompanies(el, ctx, M) {
    var I = M.I, cnt = M.map.counts;
    var h = '<div class="page-head"><div><a href="#industries" class="sub">← Industry explorer</a><h1>Companies by industry</h1>' +
      '<p>Every stock in the Main tab with its official classification. Filters combine (all must match). ' + ui.stateBadge(ctx.market.state, ctx.market.asOf, ctx.market.source) + '</p></div>' +
      '<div class="actions"><button class="btn" type="button" id="co-csv">Export CSV</button></div></div>';
    h += '<div class="tiles">' + ui.tile('Verified', F.int(cnt.verified), STATUS.verified[2]) + ui.tile('Conflicting', F.int(cnt.conflicting), STATUS.conflicting[2]) +
      ui.tile('Pending verification', F.int(cnt.pending), STATUS.pending[2]) + ui.tile('Unclassified', F.int(cnt.unclassified), STATUS.unclassified[2]) + '</div>';
    h += '<section class="card"><div class="controls ix-filters">' +
      '<label class="sr-only" for="co-q">Search companies</label><input id="co-q" class="search" type="search" placeholder="Search symbol or company" value="' + esc(CO.q) + '">' +
      '<label class="sr-only" for="co-macroId">Macro-economic sector</label><select class="sel" id="co-macroId"></select>' +
      '<label class="sr-only" for="co-sectorId">Sector</label><select class="sel" id="co-sectorId"></select>' +
      '<label class="sr-only" for="co-industryId">Industry</label><select class="sel" id="co-industryId"></select>' +
      '<label class="sr-only" for="co-basicId">Basic industry</label><select class="sel" id="co-basicId"></select>' +
      '<label class="sr-only" for="co-exchange">Exchange</label><select class="sel" id="co-exchange"><option value="">All exchanges</option><option value="NSE">NSE</option></select>' +
      '<label class="sr-only" for="co-status">Classification status</label><select class="sel" id="co-status"><option value="">All statuses</option>' +
      Object.keys(STATUS).map(function (k) { return '<option value="' + k + '">' + esc(STATUS[k][0]) + '</option>'; }).join('') + '</select>' +
      '<label class="sr-only" for="co-cap">Cap category</label><select class="sel" id="co-cap"><option value="">All cap categories</option>' +
      Object.keys(IND.CAP_LABEL).map(function (k) { return '<option value="' + k + '">' + esc(IND.CAP_LABEL[k]) + '</option>'; }).join('') + '</select>' +
      '<button type="button" class="btn" id="co-clear">Clear all filters</button></div>' +
      '<p class="sub">Exchange: the data holds NSE symbols only - BSE codes and ISIN are not in Stock Blueprint data (Data unavailable). Cap category is by Nifty index membership (Main INDICES), not the AMFI list.</p>' +
      '<div class="controls"><span class="count" id="co-count"></span></div><div id="co-table"></div></section>';
    el.innerHTML = h;

    function under(n, f) {
      if (n.level === 'sector') return !f.macroId || n.parentId === f.macroId;
      if (n.level === 'industry') return (!f.sectorId || n.parentId === f.sectorId) && (!f.macroId || I.ancestor(n.id, 'macro').id === f.macroId);
      if (n.level === 'basic') return (!f.industryId || n.parentId === f.industryId) && (!f.sectorId || I.ancestor(n.id, 'sector').id === f.sectorId) && (!f.macroId || I.ancestor(n.id, 'macro').id === f.macroId);
      return true;
    }
    function opts(level, all, label) {
      var cur = CO[level + 'Id'];
      var f = { macroId: level === 'macro' ? '' : CO.macroId, sectorId: level === 'sector' || level === 'macro' ? '' : CO.sectorId, industryId: level === 'basic' ? CO.industryId : '' };
      var list = all.filter(function (n) { return under(n, f); });
      return '<option value="">' + esc(label) + '</option>' + list.map(function (n) {
        return '<option value="' + n.id + '"' + (n.id === cur ? ' selected' : '') + '>' + esc(n.name) + ' (' + F.int(shownRows(M, n.id).length) + ')</option>';
      }).join('');
    }
    function fillSelects() {
      $('#co-macroId', el).innerHTML = opts('macro', I.macros, 'All macro-economic sectors');
      $('#co-sectorId', el).innerHTML = opts('sector', I.sectors, 'All sectors');
      $('#co-industryId', el).innerHTML = opts('industry', I.industries, 'All industries');
      $('#co-basicId', el).innerHTML = opts('basic', I.basics, 'All basic industries');
      ['exchange', 'status', 'cap'].forEach(function (k) { $('#co-' + k, el).value = CO[k]; });
    }
    var t = new ui.Table({ rows: [], pageSize: 50, sort: { key: 'mcap', dir: -1 }, empty: 'No company matches these filters', columns: stockColumns(M, ctx, I, true) }).mount($('#co-table', el));
    function apply() {
      var rows = IND.filterRows(M.rows, CO).filter(function (r) { return ui.textMatch(CO.q, [r.sym, r.name]); });
      $('#co-count', el).textContent = F.int(rows.length) + ' of ' + F.int(M.rows.length) + ' companies';
      t.setRows(rows);
    }
    // a parent change keeps only children that still sit under it
    function fix() {
      if (CO.sectorId && CO.macroId && I.node(CO.sectorId).parentId !== CO.macroId) CO.sectorId = '';
      if (CO.industryId && ((CO.sectorId && I.node(CO.industryId).parentId !== CO.sectorId) || (CO.macroId && I.ancestor(CO.industryId, 'macro').id !== CO.macroId))) CO.industryId = '';
      if (CO.basicId && ((CO.industryId && I.node(CO.basicId).parentId !== CO.industryId) || (CO.sectorId && I.ancestor(CO.basicId, 'sector').id !== CO.sectorId) ||
        (CO.macroId && I.ancestor(CO.basicId, 'macro').id !== CO.macroId))) CO.basicId = '';
    }
    ['macroId', 'sectorId', 'industryId', 'basicId', 'exchange', 'status', 'cap'].forEach(function (k) {
      $('#co-' + k, el).addEventListener('change', function (e) { CO[k] = e.target.value; fix(); fillSelects(); apply(); });
    });
    var timer;
    $('#co-q', el).addEventListener('input', function (e) { clearTimeout(timer); timer = setTimeout(function () { CO.q = e.target.value.trim(); apply(); }, 120); });
    $('#co-clear', el).addEventListener('click', function () {
      Object.keys(CO).forEach(function (k) { CO[k] = ''; });
      $('#co-q', el).value = '';
      fillSelects(); apply();
      $('#co-q', el).focus();
    });
    $('#co-csv', el).addEventListener('click', function () { ui.download('companies-by-industry.csv', ui.toCsv(t.toCsvRows())); });
    fillSelects();
    apply();
  }

  // =====================================================================
  // #industries/basic/<slug>
  // =====================================================================
  function renderBasic(el, ctx, M, id) {
    var I = M.I, n = I.node(id), raw = n.raw || {}, path = I.path(id);
    var set = MET.setOf(raw.metricSet) || MET.SETS['manufacturing-generic'];
    var setId = MET.setOf(raw.metricSet) ? raw.metricSet : 'manufacturing-generic';
    var list = shownRows(M, id);
    var info = stratInfo();
    var run = null, runErr = null;
    var SECTIONS = [['ov', 'Overview'], ['fu', 'Fundamentals'], ['dr', 'Drivers & risks'], ['me', 'Metrics'], ['st', 'Stocks'], ['cm', 'Compare'], ['sg', 'Strategy'], ['pf', 'Performance']];

    var chips = [raw.cyclicality ? '<span class="badge s-info" data-tip="Research note: how earnings move with the economic cycle" tabindex="0">' + esc(raw.cyclicality) + '</span>' : '',
      '<span class="badge" id="ix-capex"></span>', '<span class="badge" data-tip="Business-model metric set used for KPIs and comparisons" tabindex="0">Metrics: ' + esc(set.name) + '</span>']
      .concat((raw.themes || []).map(function (t) { return '<span class="badge s-warn" data-tip="Themes - not part of the NSE classification" tabindex="0">Theme: ' + esc(t) + '</span>'; }));
    var h = '<div class="page-head"><div>' + crumbsHtml(I, id) + '<h1>' + esc(n.name) + ' ' + starHtml(n) + '</h1>' +
      '<div class="tags" style="margin-top:6px">' + levelChip('basic') + chips.join('') + '</div></div></div>';
    h += '<nav class="ix-jump" aria-label="Sections of this page"><div class="chips">' + SECTIONS.map(function (s) {
      return '<button type="button" class="chip" data-jump="' + s[0] + '">' + esc(s[1]) + '</button>';
    }).join('') + '</div></nav>';
    // Overview
    h += '<section class="card" id="ix-s-ov"><div class="card-head"><div><h2>Overview</h2></div></div>' +
      '<dl class="ix-dl"><dt>Official name</dt><dd>' + esc(n.name) + '</dd>' +
      '<dt>Industry</dt><dd><a href="' + I.route(path[2].id) + '">' + esc(path[2].name) + '</a></dd>' +
      '<dt>Sector</dt><dd><a href="' + I.route(path[1].id) + '">' + esc(path[1].name) + '</a></dd>' +
      '<dt>Macro-economic sector</dt><dd><a href="' + I.route(path[0].id) + '">' + esc(path[0].name) + '</a>' + (path[0].raw && path[0].raw.code ? ' <span class="sub">' + esc(path[0].raw.code) + '</span>' : '') + '</dd>' +
      '<dt>Source</dt><dd>' + esc(M.D.meta.title) + ', ' + esc(versionLabel(M.D.meta.version)) + ' <span class="sub">(verified fact: the official hierarchy, transcribed in Code.gs)</span></dd></dl>' +
      '<p class="sub" style="margin-top:8px">' + NO_DEF + '</p><div id="ix-ov-note">' + loadingNote('Loading the research note…') + '</div></section>';
    h += '<section class="card" id="ix-s-fu"><div class="card-head"><div><h2>Fundamentals</h2><p>' + esc(RESEARCH) + '</p></div></div><div id="ix-fu">' + ui.skeleton(4) + '</div></section>';
    h += '<section class="card" id="ix-s-dr"><div class="card-head"><div><h2>Drivers &amp; risks</h2><p>' + esc(RESEARCH) + '</p></div></div><div id="ix-dr">' + ui.skeleton(4) + '</div></section>';
    // Metrics
    h += '<section class="card" id="ix-s-me"><div class="card-head"><div><h2>Industry metrics</h2><p>' + esc(set.name) + (set.context ? ' - ' + esc(set.context) : '') + '</p></div></div>' +
      '<div class="ix-kpis">' + set.kpis.map(function (k) {
        var d = MET.KPIS[k];
        return '<div class="ix-kpi"><div class="ix-kpi-h"><b>' + esc(d.name) + '</b>' + (d.unit ? ' <span class="sub">' + esc(d.unit) + '</span>' : '') + '</div>' +
          '<p class="sub">' + esc(d.definition) + '</p>' + ui.badge('Not in Stock Blueprint data yet', 's-warn') + '</div>';
      }).join('') + '</div>' +
      '<h3 class="ix-h3" style="margin-top:12px">Available in Stock Blueprint</h3><ul class="ix-ul">' + MET.compareColumns(setId).map(function (c) {
        return '<li><b>' + esc(c.name) + '</b> <span class="sub">- ' + esc(c.source) + (c.note ? '. ' + esc(c.note) : '') + '</span></li>';
      }).join('') + '<li><b>1W / 1M return, volume trend, liquidity</b> <span class="sub">- daily candles (History30 tab)</span></li></ul>' +
      (Object.keys(set.notApplicable).length ? '<h3 class="ix-h3" style="margin-top:12px">Not used for this business model</h3><ul class="ix-ul">' + Object.keys(set.notApplicable).map(function (k) {
        return '<li><b>' + esc(MET.FIELDS[k] ? MET.FIELDS[k].name : k) + '</b> <span class="sub">- ' + esc(set.notApplicable[k]) + '</span></li>';
      }).join('') + '</ul>' : '') +
      '<p class="sub" style="margin-top:8px">ROE, ROCE and debt-to-equity are not in Stock Blueprint data.</p></section>';
    // Stocks
    h += '<section class="card" id="ix-s-st"><div class="card-head"><div><h2>Listed stocks</h2><p>Stocks in your Main tab whose basic industry is ' + esc(n.name) + '. ' +
      ui.stateBadge(ctx.market.state, ctx.market.asOf, ctx.market.source) + ' BSE codes / ISIN: Data unavailable. Cap category by Nifty index membership.</p></div></div>' +
      '<div class="controls">' + viewChips('ixbv', list, BAS.view) + '</div><div class="controls"><span class="count" id="ix-bcnt"></span><button type="button" class="btn" id="ix-bcsv">Export CSV</button></div><div id="ix-bstocks"></div></section>';
    h += '<section class="card" id="ix-s-cm"><div class="card-head"><div><h2>Compare stocks</h2><p>' + esc(set.name) + ' comparison. Current values: Main tab snapshot / live sheet feed; returns as of the last daily candle. ' +
      '“–” = data unavailable. ROE, ROCE and debt-to-equity are not in Stock Blueprint data.</p></div></div>' +
      (Object.keys(set.notApplicable).length ? '<p class="sub">Left out: ' + Object.keys(set.notApplicable).map(function (k) { return esc((MET.FIELDS[k] || {}).name || k) + ' (' + esc(set.notApplicable[k]) + ')'; }).join('; ') + '</p>' : '') +
      '<div id="ix-cmp"></div></section>';
    h += '<section class="card" id="ix-s-sg"><div class="card-head"><div><h2>Strategy</h2><p id="ix-sg-head"></p></div></div><div id="ix-sg">' + loadingNote('Running the active strategy…') + '</div></section>';
    h += '<section class="card" id="ix-s-pf"><div class="card-head"><div><h2>Performance</h2></div></div><div id="ix-bperf"></div></section>';
    h += '<section class="card" id="ix-rel"><div class="card-head"><div><h2>Related basic industries</h2></div></div><div id="ix-rel-body">' + ui.skeleton(2) + '</div></section>';
    el.innerHTML = h;
    bindStars(el);
    el.addEventListener('click', function (e) {
      var j = e.target.closest('[data-jump]');
      if (j) scrollToEl($('#ix-s-' + j.getAttribute('data-jump'), el));
    });

    // research note
    function fillProfile(P, err) {
      var p = P && P.profiles ? P.profiles[id] : null;
      var none = '<p class="sub">' + (err ? 'The research notes could not be loaded (' + esc(err.message || String(err)) + ').' : 'Research note not written yet for this basic industry.') + '</p>';
      if (!p) {
        $('#ix-ov-note', el).innerHTML = none; $('#ix-fu', el).innerHTML = none; $('#ix-dr', el).innerHTML = none;
        $('#ix-rel-body', el).innerHTML = '<p class="sub">Data unavailable</p>';
        $('#ix-capex', el).remove();
        return;
      }
      $('#ix-capex', el).textContent = 'Capex: ' + (p.capexIntensity || '–');
      $('#ix-ov-note', el).innerHTML = '<div class="note warn" style="margin-top:10px">' + esc(RESEARCH) + '</div><div class="ix-prose" style="margin-top:8px"><p>' + esc(p.simplifiedExplanation || '') + '</p>' +
        '<h3 class="ix-h3">Products &amp; services</h3>' + listHtml(p.productsAndServices) +
        '<h3 class="ix-h3">Value-chain position</h3><p>' + esc(p.valueChainPosition || 'Data unavailable') + '</p></div>';
      function dd(label, v) { return '<dt>' + esc(label) + '</dt><dd>' + (Array.isArray(v) ? listHtml(v) : esc(v || 'Data unavailable')) + '</dd>'; }
      $('#ix-fu', el).innerHTML = '<dl class="ix-dl ix-dl-wide">' + dd('How they make money', p.howTheyMakeMoney) + dd('Revenue sources', p.revenueSources) + dd('Operating costs', p.operatingCosts) +
        dd('Customers & end markets', p.customersAndEndMarkets) + dd('Demand / supply drivers', p.demandSupplyDrivers) + dd('Domestic / international exposure', p.domesticInternationalExposure) +
        dd('Capex intensity', (p.capexIntensity || '–') + (p.capexNote ? ' - ' + p.capexNote : '')) + dd('Working capital', p.workingCapital) + dd('Regulation', p.regulation) +
        dd('Competitive advantages', p.competitiveAdvantages) + dd('Cyclicality', (p.cyclicality || '–') + (p.cyclicalityNote ? ' - ' + p.cyclicalityNote : '')) + '</dl>';
      $('#ix-dr', el).innerHTML = '<div class="grid g2"><div><h3 class="ix-h3">What drives it</h3><ul class="ix-ul">' + (p.drivers || []).map(function (d) {
        return '<li><b>' + esc(d.factor) + '</b> - ' + esc(d.impact) + '</li>';
      }).join('') + '</ul></div><div><h3 class="ix-h3">Key risks</h3><ul class="ix-ul">' + (p.risks || []).map(function (r) {
        return '<li><b>' + esc(r.risk) + '</b> - ' + esc(r.detail) + '</li>';
      }).join('') + '</ul></div></div>';
      var rel = (p.relatedBasicIndustries || []).filter(function (x) { return I.node(x); });
      $('#ix-rel-body', el).innerHTML = rel.length ? '<div class="links" style="margin-top:0">' + rel.map(function (x) {
        return '<a class="btn" href="' + I.route(x) + '" title="' + esc(crumbText(I, x)) + '">' + esc(I.node(x).name) + '</a>';
      }).join('') + '</div>' : '<p class="sub">None listed.</p>';
    }
    loadProfiles().then(function (P) { if (el.isConnected) fillProfile(P, null); }, function (e) { if (el.isConnected) fillProfile(null, e); });

    // stocks table
    var bt = new ui.Table({
      rows: [], pageSize: 25, sort: { key: 'mcap', dir: -1 }, empty: 'No stocks in this view',
      columns: [
        { key: 'sym', label: 'Stock', type: 'sym', name: 'name', csv: function (r) { return r.sym; } },
        { key: 'name', label: 'Company', csvOnly: true },
        { key: 'bse', label: 'BSE code', csvOnly: true, get: function () { return 'Data unavailable'; } },
        { key: 'price', label: 'Price', type: 'price', get: function (r) { return r.s.price; } },
        { key: 'chg', label: '1D', type: 'pct', digits: 2, get: function (r) { return r.s.chg; } },
        { key: 'mcap', label: 'Market cap', type: 'num', get: function (r) { return r.s.mcap; }, html: function (r) { return capFmt(r.s.mcap); } },
        { key: 'cap', label: 'Cap category', get: function (r) { return r.capLabel; } },
        { key: 'status', label: 'Classification', get: function (r) { return STATUS[r.status][0]; }, html: function (r) { return statusBadge(r.c); } },
        { key: 'liq', label: 'Avg turnover', type: 'num', title: 'Average daily turnover over the candle window (close × volume, Rs crore)',
          get: function (r) { var cs = candleStats(M, ctx); return cs ? cs.turn[r.sym] : null; },
          html: function (r) { var cs = candleStats(M, ctx), v = cs ? cs.turn[r.sym] : null; return isNum(v) ? F.num(v, v < 10 ? 2 : 0) + ' Cr' : '<span class="sub">–</span>'; } },
        { key: 'tech', label: 'Technical tags', wrap: true, get: function (r) { return [r.s.pat, r.s.fvg, r.s.e10, r.s.e21].filter(Boolean).join(' | '); },
          html: function (r) { var t = [r.s.pat, r.s.fvg, r.s.e10, r.s.e21].filter(Boolean); return t.length ? '<span class="ix-tech" title="' + esc(t.join(' | ')) + '">' + esc(t.join(' · ')) + '</span>' : '<span class="sub">–</span>'; } },
        { key: 'strat', label: 'Strategy', get: function (r) { var x = run && run.bySym[r.sym]; return x ? x.statusLabel : null; },
          html: function (r) { if (!run) return '<span class="sub">' + (runErr ? '–' : '…') + '</span>'; return stratBadge(run.bySym[r.sym]); } }
      ]
    }).mount($('#ix-bstocks', el));
    function applyStocks() {
      var rows = list.filter(viewFilter(BAS.view));
      $('#ix-bcnt', el).textContent = F.int(rows.length) + ' of ' + F.int(list.length) + ' stocks';
      bt.setRows(rows);
    }
    ui.bindChips(el, 'ixbv', function (v) { BAS.view = v; applyStocks(); });
    $('#ix-bcsv', el).addEventListener('click', function () { ui.download('basic-industry-' + IND.slugOf(id) + '.csv', ui.toCsv(bt.toCsvRows())); });
    applyStocks();

    // comparison
    var cmpCols = MET.compareColumns(setId);
    function retCol(p) {
      return { key: 'r' + p, label: p, type: 'pct', digits: 1, title: p === '1D' ? 'Price change shown' : 'Last daily close vs ' + IND.PERIOD_BARS[p] + ' sessions earlier',
        get: function (r) { if (!periodOk(ctx, p)) return null; var v = returnsFor(M, ctx, p); return v ? v[r.sym] : null; } };
    }
    var cols = [{ key: 'sym', label: 'Stock', type: 'sym', name: 'name', csv: function (r) { return r.sym; } },
      { key: 'price', label: 'Price', type: 'price', get: function (r) { return r.s.price; } }];
    cmpCols.forEach(function (c) {
      if (c.key === 'chg') { cols.push(retCol('1D'), retCol('1W'), retCol('1M')); return; }
      var col = { key: c.key, label: c.name.replace(/ %$/, ''), title: c.source + (c.note ? '. ' + c.note : ''), get: function (r) { return r.s[c.key]; } };
      if (c.kind === 'pct') { col.type = 'pct'; col.digits = 1; }
      else if (c.kind === 'num') { col.type = 'num'; col.digits = 2; }
      else if (c.kind === 'price') col.type = 'price';
      else if (c.kind === 'cr') { col.type = 'num'; col.html = function (r) { return capFmt(r.s[c.key]); }; }
      else col.type = 'badge';
      cols.push(col);
    });
    cols.push({ key: 'score', label: 'Strategy score', type: 'num', digits: 0, title: 'Share of the active strategy\'s requirements met (rule satisfaction, not a probability)',
      get: function (r) { var x = run && run.bySym[r.sym]; return x && x.status !== 'insufficient' ? x.score : null; } });
    cols.push({ key: 'sstat', label: 'Strategy status', get: function (r) { var x = run && run.bySym[r.sym]; return x ? x.statusLabel : null; },
      html: function (r) { if (!run) return '<span class="sub">' + (runErr ? '–' : '…') + '</span>'; return stratBadge(run.bySym[r.sym]); } });
    var ct = new ui.Table({ rows: list, pageSize: 25, sort: { key: 'mcap', dir: -1 }, empty: 'No stocks mapped to this basic industry', columns: cols }).mount($('#ix-cmp', el));

    // performance
    var perf = perfBlock(el, ctx, M, id, BAS, '#ix-bperf', 'ixbp');
    perf();

    // strategy
    function drawStrategy() {
      var head = $('#ix-sg-head', el), host = $('#ix-sg', el);
      if (!info) { head.textContent = ''; host.innerHTML = '<div class="note bad">The strategy module did not load, so strategy results are unavailable.</div>'; return; }
      var d = info.d;
      head.innerHTML = 'Active strategy: <b>' + esc(info.cfg.name) + '</b> · v' + esc(info.cfg.version) + ' <span class="badge ' + d.cls + '" tabindex="0" data-tip="' + esc(d.long) + '">' + esc(d.tag) + '</span>' +
        ' · results read from the strategy engine (the same as <a href="#suggestions">Daily suggestions</a>); nothing is changed here.';
      if (runErr) { host.innerHTML = errNote('The strategy could not run', runErr, 'data-retry-s'); return; }
      if (!run) { host.innerHTML = loadingNote('Running the active strategy…'); return; }
      var ev = list.filter(function (r) { return run.bySym[r.sym]; });
      var counts = {};
      ev.forEach(function (r) { var s = run.bySym[r.sym].status; counts[s] = (counts[s] || 0) + 1; });
      var opts = [['all', 'All (' + F.int(ev.length) + ')']].concat(STRAT_LIST.map(function (s) { return [s[0], s[1] + ' (' + F.int(counts[s[0]] || 0) + ')']; }));
      var shown = ev.filter(function (r) { return BAS.strat === 'all' || run.bySym[r.sym].status === BAS.strat; })
        .sort(function (a, b) { return (run.bySym[b.sym].score || 0) - (run.bySym[a.sym].score || 0) || a.sym.localeCompare(b.sym); });
      var screen = run.config.mode === 'screen';
      var h2 = '<div class="note' + (d.cls === 's-good' ? '' : ' warn') + '">' + esc(d.long) + ' Candles to ' + esc(run.dataAsOf || '–') +
        '. Industry strength is a separate dimension - a stock is not recommended because its industry performs well. “Qualified” only means the rules matched on the latest daily candle.</div>' +
        '<div class="controls" style="margin-top:10px">' + ui.chips('ixsg', opts, BAS.strat) + '</div>' +
        (ev.length < list.length ? '<p class="sub">' + F.int(list.length - ev.length) + ' stock' + (list.length - ev.length === 1 ? ' is' : 's are') + ' outside the strategy\'s universe.</p>' : '');
      if (!shown.length) h2 += '<p class="empty">No stocks with this status.</p>';
      h2 += shown.slice(0, BAS.shown).map(function (r) {
        var x = run.bySym[r.sym], s = r.s;
        return '<article class="sugg-item ix-sg-item"><div>' + ui.stockCell(s.sym, s.name) +
          '<div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-top:6px"><b>' + F.price(s.price) + '</b>' + ui.deltaHtml(s.chg, 2) + '</div>' +
          '<div class="tags" style="margin-top:6px">' + stratBadge(x) + '</div>' +
          '<div class="sub" style="margin-top:6px">Score ' + (x.status === 'insufficient' ? '–' : F.int(x.score) + '%') + ' - rule satisfaction, not a probability</div>' +
          (!screen && x.entry > 0 ? '<dl class="kv2" style="margin-top:8px"><dt>Entry ref.</dt><dd>' + F.price(x.entry) + '</dd><dt>Stop-loss</dt><dd>' + (x.stop > 0 ? F.price(x.stop) + ' <span class="sub">' + esc(x.stopNote || '') + '</span>' : '–') + '</dd>' +
            '<dt>Target</dt><dd>' + (x.target > 0 ? F.price(x.target) + ' <span class="sub">' + esc(x.targetNote || '') + '</span>' : '–') + '</dd><dt>Reward : risk</dt><dd>' + (isNum(x.rr) ? '1 : ' + F.num(x.rr, 2) : '–') + '</dd></dl>' : '') +
          '</div><div><div class="sub">Checks</div>' + checksHtml(x) +
          (x.failed && x.failed.length && x.status !== 'qualified' ? '<div class="sub" style="margin-top:6px"><b>Not qualified because:</b> ' + x.failed.map(esc).join('; ') + '</div>' : '') +
          '<div class="links" style="margin-top:6px"><button type="button" class="btn" data-sym="' + esc(s.sym) + '">Stock details</button><a class="btn" href="#suggestions">Daily suggestions</a></div></div></article>';
      }).join('');
      if (shown.length > BAS.shown) h2 += '<div class="links"><button type="button" class="btn" id="ix-sg-more">Show more (' + F.int(shown.length - BAS.shown) + ' left)</button></div>';
      host.innerHTML = h2;
    }
    ui.bindChips(el, 'ixsg', function (v) { BAS.strat = v; BAS.shown = 10; drawStrategy(); });
    el.addEventListener('click', function (e) {
      if (e.target.closest('#ix-sg-more')) { BAS.shown += 10; drawStrategy(); }
      if (e.target.closest('[data-retry-s]')) { runErr = null; drawStrategy(); start(); }
    });
    function start() {
      runStrategy().then(function (r) {
        run = r;
        if (!el.isConnected) return;
        drawStrategy(); bt.draw(); ct.draw(); perf();
      }, function (e) {
        runErr = e || new Error('unknown error');
        if (!el.isConnected) return;
        drawStrategy(); bt.draw(); ct.draw(); perf();
      });
    }
    drawStrategy();
    start();
  }

  // =====================================================================
  function notFound(el, level, slug) {
    el.innerHTML = '<div class="page-head"><div><a href="#industries" class="sub">← Industry explorer</a><h1>Not found</h1>' +
      '<p>There is no ' + esc((LEVEL_NAME[level] || 'industry').toLowerCase()) + ' called “' + esc(slug || '') + '” in the official classification. ' +
      'It may have been renamed - search for it on the <a href="#industries">Industry explorer</a>.</p></div></div>';
  }
  function render(el, params, ctx) {
    var p = params || [];
    el.innerHTML = '<div class="page-head"><div><h1>Industries &amp; sectors</h1><p>Loading the NSE industry classification…</p></div></div>' + ui.skeleton(6);
    loadData().then(function () {
      if (!el.isConnected) return;
      var M = model(ctx);
      if (!p[0]) renderLanding(el, ctx, M);
      else if (p[0] === 'companies') renderCompanies(el, ctx, M);
      else {
        var id = M.I.resolve(p[0], p[1]);
        if (!id) notFound(el, p[0], p[1]);
        else if (p[0] === 'basic') renderBasic(el, ctx, M, id);
        else renderNode(el, ctx, M, id);
      }
    }).catch(function (e) {
      if (!el.isConnected) return;
      if (window.console) console.warn(e);
      el.innerHTML = '<div class="page-head"><div><h1>Industries &amp; sectors</h1></div></div>' +
        '<div class="note bad">The industry classification could not be loaded (' + esc(e && e.message || String(e)) + '). <button type="button" class="btn" id="ix-retry">Retry</button> ' +
        'The <a href="#industries/groups">dashboard groups</a> still work.</div>';
      $('#ix-retry', el).addEventListener('click', function () { render(el, params, ctx); });
    });
  }

  SB.industryExplorer = { render: render, ROUTES: { macro: 1, sector: 1, industry: 1, basic: 1, companies: 1 } };
})();
