/* Backtesting - replays a saved strategy (the SAME versioned rules as the live
   screen, from SB.strategies) bar by bar over the daily candle snapshot with
   SB.backtest.run (web/lib/backtest.js): signal at a close using bars 0..i
   only, entry at the next open, exits by the sheet's close rule or intrabar,
   fundamentals skipped, equal-weight buy & hold benchmark.
   Results are kept in this tab's memory only: nothing is written into the
   strategy state (live signals), nothing is stored or sent anywhere. */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, esc = ui.esc, F = ui.F, isNum = ui.isNum, $ = ui.$;

  var EXIT_MODELS = [
    ['close', 'Daily close (sheet rule)', 'Loss when a daily close is at or below the stop, win when a close is at or above the target; exit at that close (the sheet\'s end-of-day trade rule).'],
    ['intrabar', 'Intraday high / low', 'Stop when the day\'s low touches it (at the open if the stock opened below it), target when the high reaches it; if both happen on one bar the stop is assumed first.']
  ];
  var ST = null;          // form state for this tab (never stored)
  var LAST = null;        // last run (this tab only)
  var busy = false;
  var curEl = null;       // the page element currently on screen
  var covCache = null;    // { H, counts[] } stocks with a candle on each date

  // ---------- small helpers ----------
  function round2(v) { return isNum(v) ? Math.round(v * 100) / 100 : v; }
  function signed(v, d, suffix) {
    if (!isNum(v)) return '<span class="sub">–</span>';
    var s = Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
    var z = Number(s.replace(/,/g, '')) === 0;
    return '<span class="' + (z ? '' : v > 0 ? 'up' : 'down') + '">' + (z ? '' : v > 0 ? '+' : '−') + s + (suffix || '') + '</span>';
  }
  function inrSigned(v) {
    if (!isNum(v)) return '<span class="sub">–</span>';
    var r = Math.round(v);
    return '<span class="' + (r > 0 ? 'up' : r < 0 ? 'down' : '') + '">' + (r > 0 ? '+' : r < 0 ? '−' : '') + '₹' + Math.abs(r).toLocaleString('en-IN') + '</span>';
  }
  function pctPlain(v, d) { return isNum(v) ? F.num(v, d == null ? 1 : d) + '%' : '–'; }
  function secs(ms) { return ms < 100 ? 'under 0.1 s' : F.num(ms / 1000, 1) + ' s'; }
  function plural(n, one, many) { return F.int(n) + ' ' + (n === 1 ? one : (many || one + 's')); }
  function exitModel(id) { return EXIT_MODELS.filter(function (m) { return m[0] === id; })[0] || EXIT_MODELS[0]; }

  function coverage(H) {
    if (covCache && covCache.H === H) return covCache.counts;
    var c = H.dates.map(function () { return 0; });
    Object.keys(H.bars || {}).forEach(function (s) { (H.bars[s] || []).forEach(function (b) { if (b && c[b[0]] != null) c[b[0]]++; }); });
    covCache = { H: H, counts: c };
    return c;
  }
  function maxBars(H) {
    var m = 0;
    Object.keys(H.bars || {}).forEach(function (s) { if (H.bars[s].length > m) m = H.bars[s].length; });
    return m;
  }

  // ---------- strategy info ----------
  function info(cfg) {
    var S = SB.strategies;
    return {
      demo: cfg.source === 'demo', confirmed: S.isConfirmed(cfg.id), discovered: /^discovered/.test(cfg.source || ''),
      edited: cfg.source === 'discovered-edited', active: S.activeId() === cfg.id, screen: cfg.mode === 'screen'
    };
  }
  function statusBadges(cfg) {
    var i = info(cfg), b = [];
    if (i.demo) { b.push(ui.badge('DEMO', 's-warn')); b.push(ui.badge('for testing only', '')); }
    else if (i.confirmed) b.push(ui.badge('Confirmed by you (v' + cfg.version + ')', 's-good'));
    else if (i.discovered) b.push(ui.badge('Discovered, unconfirmed', 's-warn'));
    else b.push(ui.badge('Custom, unconfirmed', 's-warn'));
    if (i.edited) b.push(ui.badge('edited in this browser', 's-info'));
    return b.join('');
  }
  function statusNote(cfg) {
    var i = info(cfg);
    if (i.demo) return '<div class="note bad"><strong>DEMO strategy.</strong> A generic example for testing the engine - not your rules. Its backtest results are not recommendations.</div>';
    if (i.confirmed) return '';
    if (i.discovered) return '<div class="note warn"><strong>Discovered, unconfirmed.</strong> These rules were found in your sheet, but how they combine into an entry and the stop / target method are assumptions until you confirm them in <a href="#strategy">Strategy settings</a>.</div>';
    return '<div class="note warn"><strong>Custom rules, not confirmed.</strong> Review them in <a href="#strategy">Strategy settings</a>.</div>';
  }
  function optionLabel(cfg) {
    var i = info(cfg);
    return cfg.name + ' · v' + cfg.version + ' · ' + (i.demo ? 'DEMO' : i.confirmed ? 'confirmed' : 'unconfirmed') + (i.active ? ' · active' : '');
  }
  function exitSummary(cfg) {
    var st = (cfg.exits && cfg.exits.stop) || {}, tg = (cfg.exits && cfg.exits.target) || {};
    var s = st.method === 'atr' ? 'entry − ' + st.mult + ' × ATR14' : st.method === 'pct' ? st.pct + '% below entry' :
      st.method === 'swing' ? 'below the ' + (st.bars || 10) + '-bar low' : st.method === 'zone' ? 'below the FVG zone (else 2 × ATR14)' : '–';
    var t = tg.method === 'pct' ? '+' + tg.pct + '% from entry' : tg.method === 'rr' ? tg.rr + ' × the risk (' + tg.rr + 'R)' : '–';
    return 'Stop: ' + s + ' · Target: ' + t;
  }
  function needBars(cfg) {
    var v = SB.strategy.validate(cfg).config;
    return v.mode === 'screen' ? 0 : v.universe.minBars || 0;
  }
  function rulesHtml(cfg) {
    var C = SB.strategy.CONDITIONS, v = SB.strategy.validate(cfg).config, rows = [];
    ['filters', 'triggers', 'confirms'].forEach(function (g) {
      (v[g] || []).forEach(function (r) {
        if (!r || !C[r.id] || r.enabled === false) return;
        var lb = SB.strategy.label(r), kind = g === 'filters' ? 'Filter' : g === 'triggers' ? 'Signal' : 'Requirement';
        if (C[r.id].pit === false) rows.push('<li><span class="na" aria-label="skipped">–</span><span><b>' + kind + ':</b> ' + esc(lb) + ' <span class="sub">(skipped - uses today\'s fundamentals, no history)</span></span></li>');
        else if (r.watchOnly) rows.push('<li><span class="na" aria-label="watch only">–</span><span><b>Watch:</b> ' + esc(lb) + ' <span class="sub">(watch only - never an entry)</span></span></li>');
        else rows.push('<li><span class="ok" aria-label="used">✓</span><span><b>' + kind + ':</b> ' + esc(lb) + '</span></li>');
      });
    });
    return rows.length ? '<ul class="checks">' + rows.join('') + '</ul>' : '<p class="sub">No enabled rules.</p>';
  }
  /** Date on which most stocks reach the strategy's minimum bar count, and the sessions left after it. */
  function warmup(cfg, ctx, H, cand) {
    var need = needBars(cfg);
    if (!need) return null;
    var tally = {}, best = null;
    ctx.stocks.forEach(function (s) {
      var c = cand[s.sym];
      if (c && c.length >= need) { var t = c[need - 1].t; tally[t] = (tally[t] || 0) + 1; }
    });
    Object.keys(tally).forEach(function (t) { if (!best || tally[t] > tally[best]) best = t; });
    return { need: need, date: best, sessions: best ? H.dates.filter(function (d) { return d >= best; }).length : 0 };
  }

  // ---------- defaults / state ----------
  function moneyDefaults() {
    var D = SB.backtest.DEFAULTS, rs = ui.store.get('risk:settings', null), src = {};
    var o = { capital: D.capital, riskPct: D.riskPct, maxPositions: D.maxPositions, cost: D.costPctPerSide, slip: D.slippagePct };
    function take(from, to, ok) {
      if (!rs || typeof rs !== 'object' || rs[from] == null || rs[from] === '') return;
      var v = Number(rs[from]);
      if (isNum(v) && ok(v)) { o[to] = v; src[to] = true; }
    }
    take('capital', 'capital', function (v) { return v >= 1000; });
    take('riskPct', 'riskPct', function (v) { return v > 0 && v <= 10; });
    take('maxPositions', 'maxPositions', function (v) { return v >= 1 && v <= 100 && Math.floor(v) === v; });
    take('costPctPerSide', 'cost', function (v) { return v > 0 && v <= 5; });     // 0 in risk settings = "not modelled" -> keep the backtest default
    o.src = src;
    return o;
  }
  function defaultFrom(H) {
    var c = coverage(H), mx = Math.max.apply(null, c.concat([0]));
    for (var i = 0; i < H.dates.length - 1; i++) if (c[i] >= mx * 0.5) return H.dates[i];
    return H.dates[0];
  }
  function stratCats(cfg) { return cfg && cfg.universe && Array.isArray(cfg.universe.categories) ? cfg.universe.categories.slice() : []; }
  function initState(H) {
    var m = moneyDefaults(), id = SB.strategies.activeId();
    return {
      strat: id, cats: stratCats(SB.strategies.get(id)), syms: '',
      from: defaultFrom(H), to: H.dates[H.dates.length - 1], exitModel: SB.backtest.DEFAULTS.exitModel || 'close', maxHold: String(SB.backtest.DEFAULTS.maxHoldBars || 0),
      capital: String(m.capital), riskPct: String(m.riskPct), maxPositions: String(m.maxPositions), cost: String(m.cost), slip: String(m.slip), src: m.src
    };
  }
  function repairState(H) {
    if (!SB.strategies.get(ST.strat)) { ST.strat = SB.strategies.activeId(); ST.cats = stratCats(SB.strategies.get(ST.strat)); }
    if (H.dates.indexOf(ST.from) < 0) ST.from = defaultFrom(H);
    if (H.dates.indexOf(ST.to) < 0) ST.to = H.dates[H.dates.length - 1];
  }

  // ---------- universe ----------
  function parseSyms(text) {
    var seen = {}, out = [];
    String(text || '').toUpperCase().split(/[\s,;]+/).forEach(function (t) {
      t = t.replace(/^NSE:/, '').replace(/[^A-Z0-9&_.-]/g, '');
      if (t && !seen[t]) { seen[t] = 1; out.push(t); }
    });
    return out;
  }
  function universe(ctx, cand) {
    var syms = parseSyms(ST.syms), want = null, unknown = [];
    if (syms.length) {
      want = {};
      syms.forEach(function (s) { if (ctx.bySym[s]) want[s] = 1; else unknown.push(s); });
    }
    var cats = ST.cats, list = ctx.stocks.filter(function (s) {
      if (cats.length && cats.indexOf(s.cat || 'none') < 0) return false;
      return !want || !!want[s.sym];
    });
    var inList = {};
    list.forEach(function (s) { inList[s.sym] = 1; });
    var outCat = want ? syms.filter(function (s) { return want[s] && !inList[s]; }) : [];
    var noCandles = [], stocks = list.filter(function (s) {
      var c = cand[s.sym];
      if (c && c.length) return true;
      noCandles.push(s.sym);
      return false;
    });
    return { stocks: stocks, total: list.length, symbols: syms.length, unknown: unknown, outCat: outCat, noCandles: noCandles };
  }
  function catCounts(ctx) {
    var m = {};
    ctx.stocks.forEach(function (s) { var k = s.cat || 'none'; m[k] = (m[k] || 0) + 1; });
    return m;
  }
  function catName(id) {
    if (id === 'none') return 'Unclassified';
    var c = SB.classify.categoryById(id);
    return c ? c.name : id;
  }

  // ---------- benchmark path (same stocks and formula as the engine's benchmark) ----------
  function benchSeries(res, stocks, cand) {
    var dates = res.equity.map(function (p) { return p.x; });
    if (!dates.length) return null;
    var first = dates[0], last = dates[dates.length - 1], mem = [];
    stocks.forEach(function (s) {
      var c = cand[s.sym], a = -1, b = -1;
      if (!c) return;
      for (var i = 0; i < c.length; i++) { if (c[i].t === first) a = i; if (c[i].t === last) b = i; }
      if (a >= 0 && b >= 0 && c[a].o > 0) mem.push({ c: c, a: a, p: a });
    });
    if (!mem.length) return null;
    var pts = dates.map(function (d) {
      var sum = 0;
      mem.forEach(function (m) {
        while (m.p + 1 < m.c.length && m.c[m.p + 1].t <= d) m.p++;
        sum += m.c[m.p].c / m.c[m.a].o - 1;
      });
      return { x: d, y: sum / mem.length * 100 };
    });
    return { points: pts, n: mem.length };
  }

  // =====================================================================
  SB.page('backtest', {
    render: function (el, params, ctx) {
      curEl = el;
      el.innerHTML = '<div class="page-head"><div><h1>Backtesting</h1><p>Replays a saved strategy bar by bar over the daily candles from your sheet - the same versioned rules as Daily Suggestions, with no look-ahead: ' +
        'signals at a close, entries at the next session\'s open. It runs in this browser; nothing is saved or sent.</p><div class="tags" id="bt-state" style="margin-top:8px"></div></div></div>' +
        '<div id="bt-limits"></div><section class="card" id="bt-form" aria-label="Backtest settings">' + ui.skeleton(5) + '</section><div id="bt-res"></div>';
      if (!SB.backtest || !SB.strategies || !SB.strategy) {
        $('#bt-form', el).innerHTML = '<div class="note bad">The backtest engine did not load (lib/backtest.js / ui/strategy-state.js), so backtests cannot run here.</div>';
        return;
      }
      SB.loadHistory().then(function (H) {
        if (!el.isConnected) return;
        if (!H || !H.dates || !H.dates.length || !H.bars) throw new Error('the candle file has no daily bars');
        setup({ el: el, ctx: ctx, H: H, cand: SB.strategies.candles() || {} });
      }).catch(function (e) {
        if (!el.isConnected) return;
        $('#bt-state', el).innerHTML = ui.stateBadge('UNAVAILABLE');
        $('#bt-form', el).innerHTML = '<div class="note bad">Daily candles could not be loaded (' + esc(e.message || String(e)) + '). The backtest needs data/history.js - run tools/export_xlsx.py on a sheet export.</div>';
      });
    }
  });

  function setup(P) {
    var el = P.el, H = P.H;
    if (!ST) ST = initState(H); else repairState(H);
    $('#bt-state', el).innerHTML = ui.stateBadge('CACHED', H.asOf, H.source) + '<span class="sub">daily candles ' + F.date(H.dates[0]) + ' – ' + F.date(H.dates[H.dates.length - 1]) + '</span>';
    paintLimits(P);
    paintForm(P);
    bindForm(P);
    paintResults(P);
  }

  // ---------- data limitations (always shown) ----------
  function paintLimits(P) {
    var H = P.H, cfg = SB.strategies.get(ST.strat), w = cfg ? warmup(cfg, P.ctx, H, P.cand) : null;
    var pi = P.ctx.market.providerInfo, hist = !!(pi && pi.configured && pi.name && pi.name !== 'none' && pi.name !== 'sheet');
    var items = [
      'Only about ' + maxBars(H) + ' daily bars per stock are in the snapshot - ' + esc(H.source || 'History30 tab') + ', ' + F.date(H.dates[0]) + ' – ' + F.date(H.dates[H.dates.length - 1]) +
        ' - so every sample is tiny.' + (w && w.date ? ' The selected strategy needs ' + w.need + ' bars before its first signal, so signals can only start around ' + F.date(w.date) +
        ' - about ' + plural(w.sessions, 'session') + ' before the data ends. Bars before your From date are used only to warm up indicators.' :
        w ? ' The selected strategy needs ' + w.need + ' bars before its first signal - more than the snapshot holds, so it cannot signal at all.' : ''),
      'The universe is today\'s watchlist: stocks that were delisted, merged or removed are missing, which flatters results (survivorship bias).',
      'Prices are GOOGLEFINANCE daily candles with no corporate-action adjustment beyond what GOOGLEFINANCE provides - a split, bonus or dividend inside the period can look like a price move.',
      'Fundamental conditions (TTM Signal, PE, OPM, upside, result dates) only exist as today\'s values, so they are excluded from the backtest to avoid look-ahead.',
      'Fills are simulated at the next open with the costs and slippage you set. Results are hypothetical and not indicative of future returns.',
      hist ? 'A market-data provider (' + esc(pi.name) + ') is configured on this server; its daily history could be used for longer backtests in future. This page does not fetch it yet.' :
        'No market-data provider with daily history is configured on this site, so only the snapshot can be used.'
    ];
    $('#bt-limits', P.el).innerHTML = '<div class="note" role="note"><strong>Data limitations</strong><ul style="margin:6px 0 0 18px;padding:0">' +
      items.map(function (t) { return '<li>' + t + '</li>'; }).join('') + '</ul></div>';
  }

  // ---------- settings form ----------
  function field(label, inner, hint, span) {
    return '<label class="field" style="align-content:start' + (span ? ';grid-column:1/-1' : '') + '"><span>' + label + '</span>' + inner + (hint ? '<span class="sub">' + hint + '</span>' : '') + '</label>';
  }
  function numInput(k, step, min, max) {
    return '<input class="inp" type="number" inputmode="decimal" data-k="' + k + '" value="' + esc(ST[k]) + '" step="' + step + '" min="' + min + '"' + (max != null ? ' max="' + max + '"' : '') + ' style="width:100%">';
  }
  function dateOptions(H, cur, skipLast) {
    var c = coverage(H), mx = Math.max.apply(null, c.concat([0]));
    return H.dates.map(function (d, i) {
      if (skipLast === 'first' && i === 0) return '';
      if (skipLast === 'last' && i === H.dates.length - 1) return '';
      return '<option value="' + esc(d) + '"' + (d === cur ? ' selected' : '') + '>' + F.date(d) + (c[i] < mx * 0.5 ? ' (only ' + F.int(c[i]) + ' stocks)' : '') + '</option>';
    }).join('');
  }
  function paintForm(P) {
    var H = P.H, list = SB.strategies.list(), m = moneyDefaults();
    var h = '<div class="card-head"><div><h2>Backtest settings</h2><p>Settings stay in this tab only. Capital, risk and positions start from ' +
      (Object.keys(m.src).length ? 'your risk settings (Alerts &amp; Trades page, saved in this browser)' : 'the backtest defaults (no risk settings saved in this browser)') + '.</p></div></div>';
    h += '<div class="form-grid">' + field('Strategy', '<select class="sel" data-k="strat" style="width:100%">' + list.map(function (c) {
      return '<option value="' + esc(c.id) + '"' + (c.id === ST.strat ? ' selected' : '') + '>' + esc(optionLabel(c)) + '</option>';
    }).join('') + '</select>', '', true) + '</div><div id="bt-sinfo" style="margin-top:10px"></div>';

    h += '<h3 style="margin:18px 0 8px">Universe</h3><div id="bt-cats"></div>' +
      '<div class="form-grid" style="margin-top:10px">' + field('Symbols (optional)', '<input class="inp" type="text" data-k="syms" value="' + esc(ST.syms) +
        '" placeholder="e.g. TCS, INFY, HDFCBANK" autocomplete="off" spellcheck="false" style="width:100%">', 'Comma or space separated. Only these symbols are tested, within the selected categories.', true) + '</div>' +
      '<p class="sub" id="bt-uni" role="status" style="margin-top:6px"></p>';

    h += '<h3 style="margin:18px 0 8px">Period &amp; exits</h3><div class="form-grid">' +
      field('From', '<select class="sel" data-k="from" style="width:100%">' + dateOptions(H, ST.from, 'last') + '</select>') +
      field('To', '<select class="sel" data-k="to" style="width:100%">' + dateOptions(H, ST.to, 'first') + '</select>') +
      field('Exit model', '<select class="sel" data-k="exitModel" style="width:100%">' + EXIT_MODELS.map(function (x) {
        return '<option value="' + x[0] + '"' + (x[0] === ST.exitModel ? ' selected' : '') + '>' + esc(x[1]) + '</option>';
      }).join('') + '</select>') +
      field('Max hold (bars)', numInput('maxHold', 1, 0, 60), '0 = hold until stop, target or the end of data') + '</div>' +
      '<p class="sub" id="bt-exitd" style="margin-top:6px"></p>';

    h += '<h3 style="margin:18px 0 8px">Money &amp; costs</h3><div class="form-grid">' +
      field('Capital (₹)', numInput('capital', 1000, 1000), m.src.capital ? 'from your risk settings' : 'default') +
      field('Risk per trade (%)', numInput('riskPct', 0.1, 0, 10), m.src.riskPct ? 'from your risk settings' : 'default') +
      field('Max positions', numInput('maxPositions', 1, 1, 100), m.src.maxPositions ? 'from your risk settings' : 'default') +
      field('Costs per side (%)', numInput('cost', 0.01, 0, 5), m.src.cost ? 'from your risk settings' : 'brokerage + taxes, each buy and sell') +
      field('Slippage (%)', numInput('slip', 0.01, 0, 5), 'worse fill on entry and exit') + '</div>';

    h += '<div id="bt-msg" style="margin-top:12px"></div><div class="controls" style="margin:14px 0 0">' +
      '<button class="btn primary" type="button" id="bt-run">Run backtest</button>' +
      '<button class="btn" type="button" id="bt-reset">Reset to defaults</button>' +
      '<span class="sub" id="bt-status" role="status" aria-live="polite"></span></div>';
    $('#bt-form', P.el).innerHTML = h;
    paintStrategyInfo(P);
    paintCats(P);
    paintUniverse(P);
    paintExitDesc(P);
    if (busy) setBusy(P, true);
    else if (LAST) $('#bt-status', P.el).textContent = 'Last run took ' + secs(LAST.ms) + '.';
  }
  function paintStrategyInfo(P) {
    var cfg = SB.strategies.get(ST.strat), host = $('#bt-sinfo', P.el);
    if (!cfg) { host.innerHTML = '<div class="note bad">This strategy no longer exists in this browser.</div>'; return; }
    var i = info(cfg), v = SB.strategy.validate(cfg), cats = stratCats(cfg), need = needBars(cfg);
    var h = '<div class="tags">' + statusBadges(cfg) + ui.badge(i.screen ? 'Fundamental screen' : 'Entry setups', 's-info') +
      (i.active ? ui.badge('active in Daily Suggestions', '') : '') + '</div>';
    if (cfg.description) h += '<p class="sub" style="margin-top:6px">' + esc(cfg.description) + '</p>';
    if (!i.screen) h += '<p class="sub" style="margin-top:4px">' + esc(exitSummary(cfg)) + (need ? ' · needs ' + need + ' daily bars before a signal' : '') + '</p>';
    h += '<details style="margin-top:8px"><summary class="sub" style="cursor:pointer">Rules used in the backtest</summary>' + rulesHtml(cfg) + '</details>';
    if (cats.length) h += '<p class="sub" style="margin-top:6px">This strategy\'s own universe: ' + esc(cats.map(catName).join(', ')) + '. The category filter starts from it.</p>';
    var notes = statusNote(cfg);
    if (i.screen) notes += '<div class="note warn"><strong>This is a fundamental screen.</strong> It has no entry timing, and its conditions use today\'s fundamentals, which have no history. A backtest of it produces no trades - choose an entry-setup strategy (for example the Pattern Dashboard confluence).</div>';
    if (!v.ok) notes += '<div class="note bad">This strategy has rule problems, so it cannot run: ' + v.errors.map(esc).join('; ') + '. Fix them in <a href="#strategy">Strategy settings</a>.</div>';
    if (notes) h += '<div style="display:grid;gap:8px;margin-top:10px">' + notes + '</div>';
    host.innerHTML = h;
  }
  function paintCats(P) {
    var counts = catCounts(P.ctx), host = $('#bt-cats', P.el), wasOpen = host.querySelector('details') && host.querySelector('details').open;
    var opts = SB.classify.CATEGORIES.filter(function (c) { return counts[c.id]; }).map(function (c) { return [c.id, c.name]; });
    if (counts.none) opts.push(['none', 'Unclassified']);
    var sel = ST.cats.filter(function (c) { return counts[c]; });
    var n = sel.length ? sel.reduce(function (a, c) { return a + counts[c]; }, 0) : P.ctx.stocks.length;
    var h = '<details' + (wasOpen ? ' open' : '') + '><summary style="cursor:pointer"><b>Categories:</b> ' + (sel.length ? plural(sel.length, 'category', 'categories') + ' selected' : 'All') +
      ' <span class="sub">(' + plural(n, 'stock') + ')</span></summary><div class="chips" role="group" aria-label="Categories" style="margin-top:10px">' +
      '<button type="button" class="chip" data-cat="" aria-pressed="' + !sel.length + '">All (' + F.int(P.ctx.stocks.length) + ')</button>' +
      opts.map(function (o) {
        return '<button type="button" class="chip" data-cat="' + esc(o[0]) + '" aria-pressed="' + (sel.indexOf(o[0]) >= 0) + '">' + esc(o[1]) + ' (' + F.int(counts[o[0]]) + ')</button>';
      }).join('') + '</div><p class="sub" style="margin-top:6px">Tap categories to add or remove them; “All” clears the selection.</p></details>';
    host.innerHTML = h;
  }
  function paintUniverse(P) {
    var u = universe(P.ctx, P.cand), bits = [];
    var sessions = P.H.dates.filter(function (d) { return d >= ST.from && d <= ST.to; }).length;
    bits.push('<b>Universe:</b> ' + plural(u.total, 'stock') + (u.noCandles.length && !u.symbols ? ' · ' + F.int(u.stocks.length) + ' with daily candles' : '') + ' · ' + plural(sessions, 'session') + ' in range');
    if (u.unknown.length) bits.push('not in the watchlist: ' + esc(u.unknown.slice(0, 12).join(', ')) + (u.unknown.length > 12 ? '…' : ''));
    if (u.outCat.length) bits.push('outside the selected categories: ' + esc(u.outCat.slice(0, 12).join(', ')) + (u.outCat.length > 12 ? '…' : ''));
    if (u.symbols && u.noCandles.length) bits.push('no daily candles: ' + esc(u.noCandles.slice(0, 12).join(', ')) + (u.noCandles.length > 12 ? '…' : ''));
    $('#bt-uni', P.el).innerHTML = bits.join(' · ');
  }
  function paintExitDesc(P) { $('#bt-exitd', P.el).textContent = exitModel(ST.exitModel)[2]; }

  function bindForm(P) {
    var form = $('#bt-form', P.el), timer = null;
    form.addEventListener('input', function (e) {
      var k = e.target.getAttribute && e.target.getAttribute('data-k');
      if (!k || k === 'strat' || k === 'from' || k === 'to' || k === 'exitModel') return;
      ST[k] = e.target.value;
      if (k === 'syms') { clearTimeout(timer); timer = setTimeout(function () { paintUniverse(P); }, 150); }
    });
    form.addEventListener('change', function (e) {
      var k = e.target.getAttribute && e.target.getAttribute('data-k');
      if (!k) return;
      ST[k] = e.target.value;
      if (k === 'strat') {
        ST.cats = stratCats(SB.strategies.get(ST.strat));
        paintStrategyInfo(P); paintCats(P); paintUniverse(P); paintLimits(P);
      } else if (k === 'from' || k === 'to') paintUniverse(P);
      else if (k === 'exitModel') paintExitDesc(P);
    });
    form.addEventListener('click', function (e) {
      var chip = e.target.closest('[data-cat]');
      if (chip) {
        var id = chip.getAttribute('data-cat');
        if (!id) ST.cats = [];
        else if (ST.cats.indexOf(id) >= 0) ST.cats = ST.cats.filter(function (c) { return c !== id; });
        else ST.cats = ST.cats.concat([id]);
        paintCats(P);
        paintUniverse(P);
        var again = $('[data-cat="' + id + '"]', $('#bt-cats', P.el));
        if (again) again.focus();
        return;
      }
      if (e.target.closest('#bt-run')) { run(P); return; }
      if (e.target.closest('#bt-reset')) {
        ST = initState(P.H);
        paintForm(P);
        paintLimits(P);
        $('#bt-status', P.el).textContent = 'Settings reset.';
      }
    });
  }

  function checkForm(P) {
    var e = [], n = {};
    function num(k, label, lo, hi, whole) {
      var raw = String(ST[k] == null ? '' : ST[k]).trim(), v = Number(raw);
      if (raw === '' || !isNum(v)) { e.push(label + ' must be a number'); return; }
      if (whole && Math.floor(v) !== v) { e.push(label + ' must be a whole number'); return; }
      if (v < lo || v > hi) { e.push(label + ' must be between ' + F.num(lo) + ' and ' + F.num(hi)); return; }
      n[k] = v;
    }
    num('capital', 'Capital', 1000, 1e10);
    num('riskPct', 'Risk per trade', 0.01, 10);
    num('maxPositions', 'Max positions', 1, 100, true);
    num('cost', 'Costs per side', 0, 5);
    num('slip', 'Slippage', 0, 5);
    num('maxHold', 'Max hold', 0, 60, true);
    if (!(ST.from < ST.to)) e.push('From must be before To');
    else if (P.H.dates.filter(function (d) { return d >= ST.from && d <= ST.to; }).length < 3) e.push('pick a range of at least 3 sessions');
    var cfg = SB.strategies.get(ST.strat);
    if (!cfg) e.push('choose a strategy');
    else { var v = SB.strategy.validate(cfg); if (!v.ok) e.push('the strategy has rule problems: ' + v.errors.join('; ')); }
    var u = universe(P.ctx, P.cand);
    if (!u.stocks.length) e.push(u.symbols ? 'none of the symbols you entered has daily candles in the selected categories' : 'the selected categories have no stocks with daily candles');
    return { errors: e, n: n, cfg: cfg, u: u };
  }

  function setBusy(P, on) {
    var b = $('#bt-run', P.el);
    if (b) { b.disabled = on; b.textContent = on ? 'Running…' : 'Run backtest'; }
  }

  function run(P) {
    if (busy) return;
    var chk = checkForm(P), msg = $('#bt-msg', P.el);
    if (chk.errors.length) {
      $('#bt-status', P.el).textContent = '';
      msg.innerHTML = '<div class="note bad"><strong>Cannot run yet:</strong><ul style="margin:4px 0 0 18px;padding:0">' + chk.errors.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>';
      return;
    }
    msg.innerHTML = '';
    var cfg = chk.cfg, n = chk.n, uni = chk.u.stocks;
    var sessions = P.H.dates.filter(function (d) { return d >= ST.from && d <= ST.to; }).length;
    var opts = { capital: n.capital, riskPct: n.riskPct, maxPositions: n.maxPositions, exitModel: ST.exitModel, maxHoldBars: n.maxHold,
      costPctPerSide: n.cost, slippagePct: n.slip, from: ST.from, to: ST.to };
    busy = true;
    setBusy(P, true);
    $('#bt-status', P.el).textContent = 'Running ' + cfg.name + ' on ' + plural(uni.length, 'stock') + ' × ' + plural(sessions, 'session') + ' - this takes a few seconds…';
    $('#bt-res', P.el).innerHTML = '<section class="card"><p class="sub" style="margin-bottom:10px">Running the backtest in this browser…</p>' + ui.skeleton(6) + '</section>';
    setTimeout(function () {
      var t0 = Date.now(), res = null, err = null;
      try { res = SB.backtest.run(cfg, uni, P.cand, opts); } catch (e2) { err = e2; }
      var ms = Date.now() - t0;
      busy = false;
      LAST = { res: res, err: err, ms: ms, ranAt: new Date(), cfg: SB.strategy.clone(cfg), badges: statusBadges(cfg), note: statusNote(cfg), screen: cfg.mode === 'screen',
        uni: uni, uniTotal: chk.u.total, cats: ST.cats.slice(), syms: chk.u.symbols, opts: opts, asOf: P.H.asOf, source: P.H.source };
      if (res && res.ok) LAST.bench = benchSeries(res, uni, P.cand);
      var el = curEl && curEl.isConnected ? curEl : null;
      if (!el) return;                                   // left the page: the result is shown on the next visit
      if (el !== P.el) { SB.route(); return; }           // page was re-rendered meanwhile
      setBusy(P, false);
      $('#bt-status', P.el).textContent = (res && res.ok ? 'Finished' : 'Stopped') + ' in ' + secs(ms) + '.';
      paintResults(P);
      var head = $('#bt-res h2', P.el) || $('#bt-res .note', P.el);
      if (head && head.scrollIntoView && window.innerWidth < 900) head.scrollIntoView({ block: 'start', behavior: 'smooth' });
      if (head) { head.setAttribute('tabindex', '-1'); head.focus({ preventScroll: true }); }   // the Run button was disabled: keep focus on the result
    }, 60);
  }

  // ---------- results ----------
  function paintResults(P) {
    var host = $('#bt-res', P.el);
    if (busy) { host.innerHTML = '<section class="card"><p class="sub" style="margin-bottom:10px">Running the backtest in this browser…</p>' + ui.skeleton(6) + '</section>'; return; }
    if (!LAST) {
      host.innerHTML = '<section class="card"><p class="empty">No backtest run yet. Pick a strategy and settings above, then press <b>Run backtest</b>. A run over the whole watchlist takes a few seconds.</p></section>';
      return;
    }
    var L = LAST, r = L.res;
    if (L.err || !r || !r.ok) {
      host.innerHTML = '<div class="note bad"><strong>The backtest could not run:</strong> ' +
        esc(L.err ? L.err.message || String(L.err) : r && r.errors ? r.errors.join('; ') : 'unknown error') + '</div>';
      return;
    }
    var s = r.stats, o = r.options, filled = s.trades + r.open.length, other = Math.max(0, r.signals - r.skippedFull - filled);
    var bench = r.benchmark, uniN = L.uni.length;
    var h = '<div style="display:grid;gap:16px">';

    h += '<section class="card"><div class="card-head"><div><h2>Results · ' + esc(r.strategy.name) + ' · v' + esc(r.strategy.version) + '</h2><p>' +
      F.date(r.range.from) + ' – ' + F.date(r.range.to) + ' · ' + plural(r.range.sessions, 'session') + ' · ' + plural(uniN, 'stock') + ' · ' + esc(exitModel(o.exitModel)[1]) +
      ' · ran in ' + secs(L.ms) + '</p></div><div class="tags">' + L.badges + ui.badge('Hypothetical', '') + ui.stateBadge('CACHED', L.asOf, L.source) + '</div></div>';
    var notes = L.note;
    if (!s.trades) notes += '<div class="note warn"><strong>No closed trades.</strong> There is nothing to judge this strategy on in this period.</div>';
    else if (s.sampleWarning) notes += '<div class="note warn"><strong>Small sample.</strong> ' + esc(s.sampleWarning) + '</div>';
    (r.notes || []).forEach(function (t) { notes += '<div class="note">' + esc(t) + '</div>'; });
    if (isNum(bench.returnPct) && bench.n < uniN * 0.5) notes += '<div class="note warn">The benchmark covers only ' + plural(bench.n, 'stock') + ' of ' + F.int(uniN) +
      ' - the others have no candle on ' + F.date(r.range.from) + ' or ' + F.date(r.range.to) + '. A later From date gives a fairer benchmark.</div>';
    var budget = o.capital * o.riskPct / 100, cut = r.trades.concat(r.open).filter(function (t) { return t.qty * (t.risk || t.entry - t.stop) < budget * 0.5; });
    if (cut.length) notes += '<div class="note">' + plural(cut.length, 'position was', 'positions were') + ' sized well below the ' + F.num(o.riskPct, 2) + '% risk budget because cash was tied up in other open positions (for example ' +
      esc(cut[0].sym) + ': ' + plural(cut[0].qty, 'share') + '). Profit factor and P&amp;L ₹ weight trades by size; % return and R do not.</div>';
    if (!isNum(bench.returnPct)) notes += '<div class="note">No benchmark: no stock in the universe has candles on both the first and the last session of the range.</div>';
    h += '<div style="display:grid;gap:8px">' + notes + '<div class="note">Backtest results are kept on this page only; they never change your live signals or the strategy itself. Nothing here is a recommendation or a promise of profit.</div></div></section>';

    var pf = s.profitFactor;
    h += '<div class="tiles" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">' +
      ui.tile('Closed trades', F.int(s.trades), plural(s.wins, 'win') + ' · ' + plural(s.losses, 'loss', 'losses')) +
      ui.tile('Win rate', pctPlain(s.winRate, 1), 'share of closed trades with P&amp;L above 0') +
      ui.tile('Net return', signed(s.netReturnPct, 2, '%'), inrSigned(s.netPnl) + ' incl. open positions') +
      ui.tile('Benchmark return', signed(bench.returnPct, 2, '%'), 'equal-weight buy &amp; hold, ' + plural(bench.n || 0, 'stock')) +
      ui.tile('Profit factor', pf === Infinity ? '∞' : isNum(pf) ? F.num(pf, 2) : '–', pf === Infinity ? 'no losing trades' : 'gross ₹ wins ÷ gross ₹ losses (size-weighted)') +
      ui.tile('Max drawdown', isNum(s.maxDrawdownPct) && s.maxDrawdownPct > 0 ? '<span class="down">−' + F.num(s.maxDrawdownPct, 2) + '%</span>' : pctPlain(s.maxDrawdownPct, 2), 'peak to trough of daily equity') +
      ui.tile('Average win', signed(s.avgWinPct, 2, '%'), 'per winning trade, after costs') +
      ui.tile('Average loss', signed(s.avgLossPct, 2, '%'), 'per losing trade, after costs') +
      ui.tile('Average R', signed(s.avgR, 2, 'R'), 'P&amp;L ÷ planned risk') +
      ui.tile('Expectancy', signed(s.expectancyPct, 2, '%'), 'average return per closed trade') +
      ui.tile('Average hold', isNum(s.avgBars) ? F.num(s.avgBars, 1) + ' bars' : '–', 'daily bars, entry bar included') +
      '</div>';

    h += '<section class="card"><div class="card-head"><div><h2>Equity curve</h2><p>% change from the starting capital (' + F.inr(o.capital) + '), marked to market at each close' +
      (L.bench ? ', against an equal-weight buy &amp; hold of the same ' + plural(L.bench.n, 'stock') + ' (bought at the first open)' : '') + '. The 0% line is the starting capital.</p></div></div><div id="bt-chart"></div></section>';

    h += '<div class="grid g2"><section class="card"><div class="card-head"><div><h2>Signal flow</h2><p>Signals are found at a close and filled at the next session\'s open</p></div></div>' +
      '<dl class="kv2"><dt>Signals generated</dt><dd>' + F.int(r.signals) + '</dd><dt>Filled (became positions)</dt><dd>' + F.int(filled) + '</dd>' +
      '<dt>Skipped - max positions (' + F.int(o.maxPositions) + ') were full</dt><dd>' + F.int(r.skippedFull) + '</dd><dt>Not filled - other reasons</dt><dd>' + F.int(other) + '</dd>' +
      '<dt>Closed trades</dt><dd>' + F.int(s.trades) + '</dd><dt>Still open at the end</dt><dd>' + F.int(r.open.length) + '</dd></dl>' +
      '<p class="sub" style="margin-top:8px">Other reasons: the stock was already held, it opened below the stop, it had no candle the next session, or the size rounded to 0 shares / not enough cash. ' +
      'When more signals fire than free slots, they are taken in watchlist (Main tab) order - not ranked.</p></section>';
    h += '<section class="card"><div class="card-head"><div><h2>This run</h2><p>Exactly what was simulated</p></div></div><dl class="kv2">' +
      '<dt>Strategy</dt><dd>' + esc(r.strategy.name) + ' · v' + esc(r.strategy.version) + '</dd>' +
      '<dt>Universe</dt><dd>' + (L.cats.length ? esc(L.cats.map(catName).join(', ')) : 'All categories') + (L.syms ? ' · ' + plural(L.syms, 'symbol') + ' entered' : '') + ' · ' + plural(uniN, 'stock') + ' with candles</dd>' +
      '<dt>Period</dt><dd>' + F.date(r.range.from) + ' – ' + F.date(r.range.to) + '</dd>' +
      '<dt>Exit model</dt><dd>' + esc(exitModel(o.exitModel)[1]) + '</dd>' +
      '<dt>Max hold</dt><dd>' + (o.maxHoldBars > 0 ? plural(o.maxHoldBars, 'bar') : 'no limit') + '</dd>' +
      '<dt>Capital</dt><dd>' + F.inr(o.capital) + '</dd><dt>Risk per trade</dt><dd>' + F.num(o.riskPct, 2) + '%</dd><dt>Max positions</dt><dd>' + F.int(o.maxPositions) + '</dd>' +
      '<dt>Costs per side</dt><dd>' + F.num(o.costPctPerSide, 2) + '%</dd><dt>Slippage</dt><dd>' + F.num(o.slippagePct, 2) + '%</dd>' +
      '<dt>Ran at</dt><dd>' + esc(String(L.ranAt.getHours()).padStart(2, '0') + ':' + String(L.ranAt.getMinutes()).padStart(2, '0')) + ' · ' + secs(L.ms) + '</dd></dl></section></div>';

    h += '<section class="card"><div class="card-head"><div><h2>Trades</h2><p>' + plural(s.trades, 'closed trade') + ' · prices include slippage, % return and P&amp;L include costs</p></div>' +
      '<button class="btn" type="button" id="bt-csv"' + (s.trades ? '' : ' disabled') + '>Export CSV</button></div><div id="bt-trades"></div></section>';
    h += '<section class="card"><div class="card-head"><div><h2>Open at the end</h2><p>' + plural(r.open.length, 'position') + ' still open on ' + F.date(r.range.to) +
      ' - marked at the last close, not counted as wins or losses</p></div></div><div id="bt-open"></div></section>';
    h += '</div>';
    host.innerHTML = h;

    var series = [{ name: 'Strategy', color: 'var(--bar)', points: r.equity.map(function (p) { return { x: p.x, y: (p.y / o.capital - 1) * 100 }; }) }];
    if (L.bench) series.push({ name: 'Benchmark (buy & hold)', color: 'var(--muted)', points: L.bench.points });
    ui.lineChart($('#bt-chart', host), series, { height: 240, zeroLine: true, fmt: function (v) { return F.pct(v, 1); }, label: 'Equity curve: strategy vs benchmark, % change from starting capital' });

    var P2 = P.ctx.bySym;
    var tradeRows = r.trades.map(function (t) {
      return { sym: t.sym, name: P2[t.sym] ? P2[t.sym].name : '', setup: t.setup, signalDate: t.signalDate, entryDate: t.entryDate, entry: t.entry, stop: t.stop, target: t.target, qty: t.qty,
        exitDate: t.exitDate, exit: t.exit, reason: t.reason, bars: t.bars, retPct: t.retPct, r: t.r, pnl: t.pnl, costs: t.costs };
    });
    var tt = new ui.Table({
      rows: tradeRows, pageSize: 25, sort: { key: 'exitDate', dir: -1 }, empty: noTradesText(L),
      columns: [
        { key: 'sym', label: 'Stock', type: 'sym', name: 'name', csv: function (x) { return x.sym; } },
        { key: 'name', label: 'Company', csvOnly: true },
        { key: 'setup', label: 'Setup', wrap: true, html: setupHtml },
        { key: 'signalDate', label: 'Signal date', type: 'date' },
        { key: 'entryDate', label: 'Entry date', type: 'date' },
        { key: 'entry', label: 'Entry', type: 'price', csv: function (x) { return round2(x.entry); } },
        { key: 'stop', label: 'Stop', type: 'price', csv: function (x) { return round2(x.stop); } },
        { key: 'target', label: 'Target', type: 'price', csv: function (x) { return round2(x.target); } },
        { key: 'qty', label: 'Qty', type: 'num', digits: 0 },
        { key: 'exitDate', label: 'Exit date', type: 'date' },
        { key: 'exit', label: 'Exit', type: 'price', csv: function (x) { return round2(x.exit); } },
        { key: 'reason', label: 'Reason', html: function (x) { return ui.badge(x.reason, /^stop/.test(x.reason) ? 's-bad' : /^target/.test(x.reason) ? 's-good' : 's-info'); } },
        { key: 'bars', label: 'Bars', type: 'num', digits: 0 },
        { key: 'retPct', label: '% return', type: 'pct', digits: 2, csv: function (x) { return round2(x.retPct); } },
        { key: 'r', label: 'R', type: 'num', html: function (x) { return signed(x.r, 2, 'R'); }, csv: function (x) { return round2(x.r); } },
        { key: 'pnl', label: 'P&L ₹', type: 'num', html: function (x) { return inrSigned(x.pnl); }, csv: function (x) { return round2(x.pnl); } },
        { key: 'costs', label: 'Costs ₹', csvOnly: true, csv: function (x) { return round2(x.costs); } }
      ]
    }).mount($('#bt-trades', host));
    $('#bt-csv', host).addEventListener('click', function () {
      var name = 'backtest-' + String(r.strategy.id || 'strategy').replace(/[^a-zA-Z0-9_-]/g, '') + '-v' + r.strategy.version + '-' + r.range.from + '-to-' + r.range.to + '.csv';
      ui.download(name, ui.toCsv(tt.toCsvRows()));
    });

    var openRows = r.open.map(function (t) {
      return { sym: t.sym, name: P2[t.sym] ? P2[t.sym].name : '', setup: t.setup, entryDate: t.entryDate, entry: t.entry, stop: t.stop, target: t.target, qty: t.qty,
        lastPx: t.lastPx, unrealPct: t.unrealPct, unreal: isNum(t.lastPx) ? (t.lastPx - t.entry) * t.qty : NaN };
    });
    new ui.Table({
      rows: openRows, pageSize: 25, sort: { key: 'entryDate', dir: -1 }, empty: 'No positions were open at the end of the period.',
      columns: [
        { key: 'sym', label: 'Stock', type: 'sym', name: 'name' },
        { key: 'setup', label: 'Setup', wrap: true, html: setupHtml },
        { key: 'entryDate', label: 'Entry date', type: 'date' },
        { key: 'entry', label: 'Entry', type: 'price' },
        { key: 'stop', label: 'Stop', type: 'price' },
        { key: 'target', label: 'Target', type: 'price' },
        { key: 'qty', label: 'Qty', type: 'num', digits: 0 },
        { key: 'lastPx', label: 'Last close', type: 'price' },
        { key: 'unrealPct', label: 'Unrealised %', type: 'pct', digits: 2, title: 'Before exit costs' },
        { key: 'unreal', label: 'Unrealised ₹', type: 'num', html: function (x) { return inrSigned(x.unreal); }, title: 'Before exit costs' }
      ]
    }).mount($('#bt-open', host));
  }

  /** Short setup text in the table (full rule text in the tooltip and the CSV). */
  function setupHtml(x) {
    var full = String(x.setup || ''), short = full.replace(/\s*\([^)]*\)/g, '').trim();
    if (!full) return '<span class="sub">–</span>';
    return short === full ? esc(full) : '<span title="' + esc(full) + '">' + esc(short) + '</span>';
  }
  function noTradesText(L) {
    var r = L.res;
    if (L.screen) return 'No trades: a fundamental screen has no entry timing and its conditions have no history, so it cannot be backtested.';
    if (!r.signals) return 'No closed trades: the strategy produced no signals in this period. With ~30 daily bars only the last sessions can signal - try the full date range or more categories.';
    if (r.open.length) return 'No closed trades yet: every filled position was still open at the end (see below).';
    return 'No closed trades: signals fired but none could be filled (see Signal flow).';
  }
})();
