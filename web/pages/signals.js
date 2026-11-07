/* Patterns & FVG.
   1. Live recompute from the daily candles (web/lib patterns / fvg / indicators):
      PatternData columns W (pattern), X (FVG), Y / AA (10 / 21 EMA support)
      and the Pattern Dashboard confluence, for every stock.
   2. FVG watch zones with the sheet's rules (liquidity filter, gap-ups first),
      fill state and the approach state vs the latest price.
   3. Bearish FVG (mirror rule) - information only, not part of the strategy.
   4. Snapshot tables exported from the sheet (Pattern Dashboard, FVG watch
      tabs, FVG Backtest, Mitigated FVG Log, Signal watchlist log), each
      labelled CACHED with its own time. */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, esc = ui.esc, F = ui.F, isNum = ui.isNum, $ = ui.$;

  // filter state survives re-renders within this browser session
  var ST = {
    q: '', pat: '', fvg: 'all', ema: '', conf: '1', cat: '',
    zq: '', zkind: 'all', zstate: 'all',
    bq: '',
    pdQ: '', pdF: 'all',
    btMin: 4, btType: 'all', btCat: '', btQ: '',
    mlQ: '', mlType: 'all',
    wlQ: '', wlSrc: 'all',
    itdQ: '', itdTf: 'all', itdPat: 'all',
    z4Q: '', z4Kind: 'all', btTf: 'all', btRes: 'all', btQ2: ''
  };
  // Zerodha Kite patterns (owner, 07-Nov-2026: the 4H Spring in FVG of PARAGMILK missed for lack of intraday candles):
  // the sheet's "Intraday Patterns" tab, filled by the PC program once a trading day after the close (feed part 'intraday')
  var ITD_TFS = ['15m', '30m', '1H', '2H', '4H', 'D', 'W', 'M'];
  var ITD_TV = { '15m': '15', '30m': '30', '1H': '60', '2H': '120', '4H': '240', D: 'D', W: 'W', M: 'M' };
  var ITD_SPRINGS = ['Spring in FVG', 'Spring'];
  var ITD_PATTERNS = ['Spring in FVG', 'Spring', 'FVG First Touch', 'FVG First Touch Confirmed', 'Twin Star Bottom + FVG'];
  function tvUrl(sym, tf) { return 'https://www.tradingview.com/chart/?symbol=' + encodeURIComponent('NSE:' + sym) + '&interval=' + (ITD_TV[tf] || 'D'); }
  var CACHE = null;               // candle-derived results, computed once per history file

  var FVG_KINDS = [['all', 'Any FVG state'], ['ft', 'First Touch'], ['conf', 'Confirmed'], ['unmit', 'Unmitigated'], ['gap', 'Gap-up'], ['spring', 'FVG+Spring'], ['twin', 'Twin Star + FVG']];
  var FVG_RX = { ft: /^FVG First Touch \(/, conf: /^FVG First Touch Confirmed/, unmit: /^FVG Unmitigated/, gap: /^Gap-up FVG/, spring: /^FVG\+Spring/, twin: /^Twin Star Bottom \+ FVG/ };

  // FVG Backtest categories in the sheet's display order (Code.gs AB_MIT_CATS_ + Spring)
  var BT_CATS = [
    ['Opened inside the zone & closed green', 'The day\'s open was already inside the zone and the candle finished green (close above open).'],
    ['Held - tested the zone, closed above it', 'The low dipped into the zone and the close finished back above the zone top.'],
    ['Swept through & reclaimed', 'The low pierced through the zone bottom, but the close recovered back above it (a liquidity sweep).'],
    ['Closed inside the zone', 'Still inside the zone at the close - not decided yet.'],
    ['Broke below - closed under the zone', 'Closed below the zone bottom - the zone failed as support.'],
    ['No end-of-day candle', 'The day\'s candle was not available, so it could not be judged.'],
    ['Spring Pattern', 'Flagged by the Spring candlestick pattern (not an FVG).']
  ];
  var BT_MIN_OPTIONS = [2, 3, 4, 5, 6, 8, 10];
  var AB_MISSED_PCT_DEFAULT = 4;  // Code.gs ab_setting_('AB_MISSED_PCT', 4)

  // ---------- small helpers ----------
  function pctPlain(v, d) { return isNum(v) ? F.num(v, d == null ? 2 : d) + '%' : '–'; }
  function tagsHtml(list, cls) {
    if (!list || !list.length) return '<span class="sub">–</span>';
    return '<div class="tags">' + list.map(function (t) { return ui.badge(t, cls || ''); }).join('') + '</div>';
  }
  // stat tiles that fit two per row on a phone (layout only)
  var TILES = '<div class="tiles" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">';
  function textCell(v) { return v ? esc(v) : '<span class="sub">–</span>'; }
  function symList(s) {
    var syms = String(s || '').split(/\s*,\s*/).filter(Boolean);
    if (!syms.length) return '<span class="sub">–</span>';
    return syms.map(function (x, i) {
      return '<span style="white-space:nowrap"><button type="button" class="linkish" data-sym="' + esc(x) + '">' + esc(x) + '</button>' + (i < syms.length - 1 ? ',' : '') + '</span>';
    }).join(' ');
  }
  function sectionHtml(id, title, sub, body, actions) {
    return '<section class="card" id="' + id + '"><div class="card-head"><div><h2>' + esc(title) + '</h2>' + (sub ? '<p>' + sub + '</p>' : '') + '</div>' +
      (actions ? '<div class="tags">' + actions + '</div>' : '') + '</div>' + body + '</section>';
  }
  function selectHtml(id, label, options, current) {
    return '<select class="sel" id="' + id + '" aria-label="' + esc(label) + '">' + options.map(function (o) {
      return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(current) ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
    }).join('') + '</select>';
  }
  function afterPaint(fn) {
    setTimeout(function () {
      if (window.requestAnimationFrame && !document.hidden) requestAnimationFrame(function () { setTimeout(fn, 0); });
      else fn();
    }, 0);
  }
  // Snapshot KPI labels say "today" - that was the day of the last patterns run, not today.
  function pdLabel(s) { return String(s).replace(/\s*\btoday\b/i, ' (last run)'); }

  /** Latest completed NSE session: from the market-data API when deployed, else a weekday-only estimate (IST). */
  function latestSession(ctx) {
    var s = ctx.market && ctx.market.session;
    if (s && s.lastCompletedSession) return { date: s.lastCompletedSession, exact: true };
    var now = new Date(), ist = new Date(now.getTime() + (now.getTimezoneOffset() + 330) * 60000);
    var d = new Date(ist.getFullYear(), ist.getMonth(), ist.getDate());
    var wd = d.getDay(), mins = ist.getHours() * 60 + ist.getMinutes();
    if (!(wd >= 1 && wd <= 5 && mins > 15 * 60 + 30)) {
      do { d.setDate(d.getDate() - 1); } while (d.getDay() === 0 || d.getDay() === 6);
    }
    return { date: ui.iso(d), exact: false };
  }

  // ---------- engine pass over every stock (about 0.3-0.6 s) ----------
  function compute(ctx, H) {
    var P = SB.patterns, FV = SB.fvg, I = SB.indicators, map = SB.strategies.candles() || {};
    var out = { rows: [], zones: [], bear: [], noCandles: 0, illiquid: 0, older: 0, parity: { n: 0, same: 0, diff: [] }, ms: 0 };
    var lastDate = H.dates[H.dates.length - 1];
    var t0 = Date.now();
    ctx.stocks.forEach(function (s) {
      var c = map[s.sym];
      if (!c || !c.length) { out.noCandles++; return; }
      var last = c[c.length - 1], prev = c[c.length - 2];
      var r = {
        sym: s.sym, name: s.name, cat: s.cat, catName: s.catName, ind: s.ind,
        pat: P.latestTags(c), fvg: FV.columnTags(c), e10: I.emaSupportTag(I.sheetBars(c), 10, 0.5), e21: I.emaSupportTag(I.sheetBars(c), 21, 0.5),
        t: last.t, close: last.c, chg: prev && prev.c > 0 ? (last.c / prev.c - 1) * 100 : null, bars: c.length
      };
      r.patList = P.splitTags(r.pat);
      r.fvgList = P.splitTags(r.fvg);
      r.conf = (r.pat ? 1 : 0) + (r.fvg ? 1 : 0) + (r.e10 ? 1 : 0) + (r.e21 ? 1 : 0);
      if (last.t < lastDate) out.older++;
      out.rows.push(r);

      var sh = H.sheetTags && H.sheetTags[s.sym];
      if (sh) {
        out.parity.n++;
        if (String(sh[0] || '') === r.pat && String(sh[1] || '') === r.fvg && String(sh[2] || '') === r.e10 && String(sh[4] || '') === r.e21) out.parity.same++;
        else out.parity.diff.push(s.sym);
      }

      var w = FV.watchZones(c);
      if (w.illiquid) out.illiquid++;
      w.zones.forEach(function (z) {
        out.zones.push({ sym: s.sym, name: s.name, cat: s.cat, catName: s.catName, kind: z.kind, bottom: z.bottom, top: z.top, pct: z.pct,
          formed: z.formed, daysAgo: z.daysAgo, fill: FV.fillState(z, c), zone: z, lastT: last.t });
      });

      var b = FV.bearishGaps(c, 30);
      if (b.length) {
        out.bear.push({ sym: s.sym, name: s.name, catName: s.catName, count: b.length, formed: b[0].formed, bottom: b[0].bottom, top: b[0].top, pct: b[0].pct, close: last.c, t: last.t });
      }
    });
    out.ms = Date.now() - t0;
    return out;
  }

  function approach(z, s) {
    if (!s || !isNum(s.price)) return null;
    var st = SB.fvg.approachState(s.price, z.zone);
    if (!st) return null;
    var label, cls;
    if (st.inZone) { label = 'Inside zone'; cls = 's-warn'; }
    else if (st.approaching) { label = 'Approaching (≤0.5%)'; cls = 's-info'; }
    else if (s.price <= z.bottom) { label = 'Below zone ' + F.pct((s.price - z.bottom) / z.bottom * 100, 1); cls = 's-bad'; }
    else { label = F.pct(st.distancePct, 1) + ' above top'; cls = ''; }
    return { st: st, label: label, cls: cls, key: st.inZone ? 'inside' : st.approaching ? 'near' : s.price <= z.bottom ? 'below' : 'above' };
  }

  // ---------- page ----------
  SB.page('signals', {
    render: function (el, params, ctx) {
      var D = ctx.D, pd = D.patterns || {}, snapAsOf = D.asOf || D.generated;
      var pdBadge = ui.stateBadge('CACHED', pd.asOf, 'Pattern Dashboard tab');

      var h = '<div class="page-head"><div><h1>Patterns &amp; FVG</h1><p>Bullish candlestick patterns, fair value gaps (FVG) and 10 / 21 EMA support. ' +
        'The top sections are recomputed in your browser from the daily candles with the same rules as your sheet; the lower sections are snapshots of the sheet\'s own tabs. ' +
        'These are chart conditions to research, not buy recommendations.</p></div></div>';
      h += '<nav class="chips" aria-label="On this page">' + [
        ['sg-itd', 'Intraday & weekly (Zerodha)'], ['sg-z4', '4H FVG zones'], ['sg-sbt', 'FVG+Spring win rate'], ['sg-live', 'Live recompute'], ['sg-zones', 'FVG zones'], ['sg-bear', 'Bearish FVG'], ['sg-pd', 'Pattern Dashboard snapshot'],
        ['sg-tabs', 'Sheet FVG tabs'], ['sg-bt', 'FVG backtest'], ['sg-ml', 'Mitigated log'], ['sg-wl', 'Signal log']
      ].map(function (j) { return '<button type="button" class="chip" data-jump="' + j[0] + '">' + esc(j[1]) + '</button>'; }).join('') + '</nav>';

      // 0. Zerodha Kite: intraday / weekly / monthly patterns found by the PC program, its 4H FVG zones and the backtest
      h += itdSectionHtml(ctx);
      h += z4SectionHtml(ctx);
      h += sbtSectionHtml(ctx);

      // 1. live recompute
      h += sectionHtml('sg-live', 'Live recompute from candles',
        'Pattern (PatternData col W), FVG (col X), 10 / 21 EMA support (cols Y / AA) and confluence, recomputed for every stock from the daily candles. ' +
        'These ports reproduce your sheet\'s PatternData columns exactly (checked for every stock in tests/sheet-parity.test.js).',
        '<div id="sg-live-body">' + ui.skeleton(6) + '</div>', '<span id="sg-live-state"></span>');

      // 2. zones
      h += sectionHtml('sg-zones', 'FVG zones (rules from your sheet)',
        'Open bullish zones per stock as your GapUpFVG / UnmitigatedFVG tabs build them: liquidity filter first, gap-up zones first, the 3-candle zone only when no gap-up zone is open. ' +
        'Price vs zone uses the latest price ' + ui.stateBadge(ctx.market.state, ctx.market.asOf, ctx.market.source) + '.',
        '<div id="sg-zones-body">' + ui.skeleton(5) + '</div>' + defsHtml());

      // 3. bearish (collapsed)
      h += '<details class="card" id="sg-bear"><summary style="cursor:pointer"><b>Bearish FVG (mirror rule, information only)</b> ' +
        ui.badge('Not part of your strategy', 's-warn') + '</summary><div id="sg-bear-body" style="margin-top:12px">' + ui.skeleton(3) + '</div></details>';

      // 4. Pattern Dashboard snapshot
      h += '<section class="card" id="sg-pd"><div class="card-head"><div><h2>Pattern Dashboard snapshot</h2><p>The sheet\'s Pattern Dashboard tab from its last patterns run ' + pdBadge +
        '. "Day %" columns are the move on that run\'s day, not today.</p></div></div>' + kpiHtml(pd.kpis) + '</section>';
      h += ui.card('Signals summary', 'One row per signal type. Averages are the moves of the stocks carrying it at the last patterns run. ' + pdBadge, '<div id="sg-sum"></div>');
      h += '<section class="card"><div class="card-head"><div><h2>Stocks with signals</h2><p>Confluence = number of filled cells among Pattern, FVG, 10 EMA and 21 EMA (0-4). ' + pdBadge + '</p></div></div>' +
        '<div class="controls"><input class="search" id="sg-pd-q" type="search" placeholder="Search symbol, industry or pattern" aria-label="Search Pattern Dashboard stocks" value="' + esc(ST.pdQ) + '">' +
        ui.chips('sgpd', [['all', 'All'], ['buy', 'TTM Signal = Buy (sheet)'], ['c3', 'Confluence 3+']], ST.pdF) + '<span class="count" id="sg-pd-count"></span></div>' +
        '<div id="sg-pd-stocks"></div></section>';
      h += ui.card('Where signals cluster', 'Basic industries with the most signalled stocks at the last patterns run. ' + pdBadge, '<div id="sg-cl"></div>');

      // 5. sheet FVG watch tabs
      h += '<div class="grid g2" id="sg-tabs">' +
        ui.card('Unmitigated FVG tab', 'Zones your sheet was watching (3-candle FVG). ' + ui.stateBadge('CACHED', snapAsOf, 'UnmitigatedFVG tab'), '<div id="sg-fvg"></div>') +
        ui.card('Gap-up FVG tab', 'Gap-up zones your sheet was watching. ' + ui.stateBadge('CACHED', snapAsOf, 'GapUpFVG tab'), '<div id="sg-gap"></div>') + '</div>';

      // 6. backtest + mitigated log
      h += sectionHtml('sg-bt', 'FVG backtest (from your sheet)',
        'Every flagged zone / Spring is checked on the next trading day: did it move open-to-high by the threshold, and did it close green? Past behaviour of this small sample, not a forecast. ' +
        ui.stateBadge('CACHED', snapAsOf, 'FVG Backtest tab'),
        '<div class="controls"><label style="display:flex;flex-wrap:wrap;align-items:center;gap:8px"><span class="sub">Worked = next-day open-to-high ≥</span>' +
        selectHtml('sg-bt-min', 'Open-to-high threshold', BT_MIN_OPTIONS.map(function (v) { return [v, v + '%' + (v === AB_MISSED_PCT_DEFAULT ? ' (sheet default)' : '')]; }), ST.btMin) + '</label>' +
        '<span class="sub">AB_MISSED_PCT - the sheet\'s coded default is 4%; your Control Panel value is not published.</span></div>' +
        '<div id="sg-bt-sum"></div>' +
        '<h3 style="margin:18px 0 8px">Flags</h3>' +
        '<div class="controls"><input class="search" id="sg-bt-q" type="search" placeholder="Search symbol" aria-label="Search backtest flags" value="' + esc(ST.btQ) + '">' +
        selectHtml('sg-bt-cat', 'Category', [['', 'All categories']].concat(BT_CATS.map(function (c) { return [c[0], c[0]]; })), ST.btCat) +
        ui.chips('sgbt', [['all', 'All types'], ['FVG', 'FVG'], ['Gap-up FVG', 'Gap-up FVG'], ['Spring', 'Spring']], ST.btType) +
        '<span class="count" id="sg-bt-count"></span></div><div id="sg-bt-t"></div>',
        '<button class="btn" type="button" id="sg-bt-csv">Export CSV</button>');
      h += sectionHtml('sg-ml', 'Mitigated FVG log', 'When the price reached a watched zone (the sheet\'s Mitigated FVG Log). ' + ui.stateBadge('CACHED', snapAsOf, 'Mitigated FVG Log tab'),
        '<div class="controls"><input class="search" id="sg-ml-q" type="search" placeholder="Search symbol" aria-label="Search mitigated log" value="' + esc(ST.mlQ) + '">' +
        ui.chips('sgml', [['all', 'All'], ['Unmitigated FVG', 'Unmitigated FVG'], ['Gap-up FVG', 'Gap-up FVG']], ST.mlType) + '<span class="count" id="sg-ml-count"></span></div><div id="sg-ml-t"></div>');

      // 7. watch log
      h += sectionHtml('sg-wl', 'Signal watchlist log', 'Stocks flagged by the sheet engine, newest first. "Since flag" compares with the latest price shown ' +
        ui.stateBadge(ctx.market.state, ctx.market.asOf, ctx.market.source) + '. Log: ' + ui.stateBadge('CACHED', snapAsOf, 'Signal watchlist log tab'),
        '<div class="controls"><input class="search" id="sg-wl-q" type="search" placeholder="Search symbol, company or source" aria-label="Search signal log" value="' + esc(ST.wlQ) + '">' +
        ui.chips('sgwl', [['all', 'All'], ['Mitigated FVG', 'Mitigated FVG'], ['Spring Pattern', 'Spring Pattern']], ST.wlSrc) + '<span class="count" id="sg-wl-count"></span></div><div id="sg-wl-t"></div>');

      el.innerHTML = h;

      el.addEventListener('click', function (e) {
        var j = e.target.closest('[data-jump]');
        if (!j) return;
        var t = document.getElementById(j.getAttribute('data-jump'));
        if (!t) return;
        if (t.tagName === 'DETAILS') t.open = true;
        var top = document.querySelector('.top');
        var y = t.getBoundingClientRect().top + window.pageYOffset - (top ? top.offsetHeight : 0) - 10;
        window.scrollTo(0, Math.max(0, y));
      });

      drawItd(el, ctx);
      drawZ4(el, ctx);
      drawSbt(el, ctx);
      drawSnapshot(el, ctx);
      drawBacktest(el, ctx);
      drawLogs(el, ctx);

      // engine sections: show the skeleton first, then compute once
      afterPaint(function () {
        SB.loadHistory().then(function (H) {
          if (!el.isConnected) return;
          if (!H || !H.bars || !H.dates || !H.dates.length) throw new Error('the candle history file (data/history.js) is empty');
          if (!CACHE || CACHE.H !== H) CACHE = { H: H, data: compute(ctx, H) };
          drawLive(el, ctx, H, CACHE.data);
          drawZones(el, ctx, CACHE.data);
          drawBear(el, CACHE.data);
        }).catch(function (err) {
          if (!el.isConnected) return;
          var msg = '<div class="note bad">Could not compute from the candles: ' + esc(err && err.message || err) +
            '. The daily candle file (data/history.js) may be missing - run tools/export_xlsx.py. The sheet snapshots below are unaffected.</div>';
          ['#sg-live-body', '#sg-zones-body', '#sg-bear-body'].forEach(function (s) { var x = $(s, el); if (x) x.innerHTML = msg; });
        });
      });
    }
  });

  function itdRows(ctx) { return ui.objRows(ctx.D.intraday); }
  function itdSectionHtml(ctx) {
    var it = ctx.D.intraday, rows = itdRows(ctx);
    // the timeframes in the data (owner, 08-Nov-2026: the PC reports only 4H, D, W, M)
    var present = ITD_TFS.filter(function (t) { return rows.some(function (r) { return r.Timeframe === t; }); });
    var tfText = (present.length ? present : ['4H', 'D', 'W', 'M']).join(', ');
    var sub = 'Spring and <b>Spring in FVG</b> found by your PC program on Zerodha Kite candles - ' + esc(tfText) +
      (tfText.indexOf('4H') !== -1 ? (rows.every(function (r) { return r.Timeframe !== '4H' || ITD_SPRINGS.indexOf(r.Pattern) === -1 || /13:15$/.test(String(r.Candle || '')); })
        ? ' (4H Spring: only the day\'s 2nd candle, 13:15-15:30)' : ' (4H = 09:15-13:15 / 13:15-15:30)') : '') +
      ' - with the same rules as your sheet, once a trading day after the close. <b>Spring in FVG</b> = the Spring candle on the <b>top</b> of an FVG or ' +
      'Gap-up zone (its low in the zone\'s upper half, close above the top, the zone\'s 1st or 2nd touch) or on its <b>bottom line</b> (low at most 1% under it, ' +
      'close above it) - not on the monthly chart. On 4H also FVG First Touch / Confirmed / Twin Star Bottom + FVG (every 4H candle). ' +
      'The button opens TradingView\'s own chart at that timeframe. ' + (it && it.note ? '<span class="sub">' + esc(String(it.note).replace(/^.*?(Last scan:[^.]*\.?).*$/, '$1')) + '</span>' : '');
    var body;
    if (!rows.length) {
      body = '<p class="empty">Nothing yet. These come from your PC program\'s daily Zerodha Kite scan: double-click <b>KiteSetup.bat</b> in the ScreenerBridge folder once, ' +
        'then log in to Kite when the program opens the login page after the close.</p>';
    } else {
      var tfN = {}, patN = {};
      rows.forEach(function (r) { tfN[r.Timeframe] = (tfN[r.Timeframe] || 0) + 1; patN[r.Pattern] = (patN[r.Pattern] || 0) + 1; });
      body = '<div class="controls"><input class="search" id="sg-itd-q" type="search" placeholder="Search symbol or company" aria-label="Search intraday patterns" value="' + esc(ST.itdQ) + '">' +
        '<span class="count" id="sg-itd-count"></span></div>' +
        '<div class="controls">' + ui.chips('sgitdtf', [['all', 'All timeframes (' + F.int(rows.length) + ')']].concat(ITD_TFS.filter(function (t) { return tfN[t]; })
          .map(function (t) { return [t, t + ' (' + F.int(tfN[t]) + ')']; })), ST.itdTf) + '</div>' +
        '<div class="controls">' + ui.chips('sgitdp', [['all', 'All patterns']].concat(ITD_PATTERNS.filter(function (p) { return patN[p] || ITD_SPRINGS.indexOf(p) !== -1; })
          .map(function (p) { return [p, p + ' (' + F.int(patN[p] || 0) + ')']; })), ST.itdPat) + '</div><div id="sg-itd-t"></div>';
    }
    return sectionHtml('sg-itd', 'Intraday, weekly & monthly patterns (Zerodha)', sub, body);
  }
  function drawItd(el, ctx) {
    var box = $('#sg-itd-t', el);
    if (!box) return;
    var all = itdRows(ctx);
    var t = new ui.Table({
      rows: [], pageSize: 25, id: 'signals-intraday', empty: 'No pattern with these filters',
      columns: [
        { key: 'Session', label: 'Session', type: 'date' },
        { key: 'Symbol', label: 'Stock', type: 'sym', name: 'Company' },
        { key: 'Timeframe', label: 'Timeframe', html: function (r) { return ui.badge(r.Timeframe || '–', 's-info'); } },
        { key: 'Pattern', label: 'Pattern', html: function (r) { return ui.badge(r.Pattern || '–', r.Pattern === 'Spring in FVG' ? 's-good' : r.Pattern === 'Spring' ? '' : 's-info'); } },
        { key: 'Candle', label: 'Candle', title: 'The candle of the pattern (start time, IST; W = the week starting that Monday, M = that month)' },
        { key: 'FVG Detail', label: 'Where', title: 'Spring in FVG: on the top (with the touch number) or the bottom line of an FVG / Gap-up zone; the other FVG patterns: the zone kind' },
        { key: 'FVG Formed', label: 'Zone formed', title: 'When the zone formed (same timeframe)' },
        { key: 'chart', label: 'Chart', get: function () { return null; },
          html: function (r) { return '<a class="btn sm" href="' + esc(tvUrl(r.Symbol, r.Timeframe)) + '" target="_blank" rel="noopener">TradingView ' + esc(r.Timeframe) + ' ↗</a>'; } }
      ]
    }).mount(box);
    function apply() {
      var rows = all.filter(function (r) {
        return (ST.itdTf === 'all' || r.Timeframe === ST.itdTf) && (ST.itdPat === 'all' || r.Pattern === ST.itdPat) && ui.textMatch(ST.itdQ, [r.Symbol, r.Company]);
      });
      var c = $('#sg-itd-count', el);
      if (c) c.textContent = F.int(rows.length) + ' of ' + F.int(all.length);
      t.setRows(rows);
    }
    ui.bindChips(el, 'sgitdtf', function (v) { ST.itdTf = v; apply(); });
    ui.bindChips(el, 'sgitdp', function (v) { ST.itdPat = v; apply(); });
    var q = $('#sg-itd-q', el), timer;
    if (q) q.addEventListener('input', function (e) { clearTimeout(timer); timer = setTimeout(function () { ST.itdQ = e.target.value.trim(); apply(); }, 120); });
    apply();
  }

  // 4H FVG zones from the PC (owner, 08-Nov-2026: "I want FVG to be tracked in 4hr timeframe also"): the sheet's
  // "4H FVG Zones" tab (feed part zones4h) - no Kite prices, the zone size and the distance from the sheet's price only
  function z4SectionHtml(ctx) {
    var z = ctx.D.zones4h, rows = ui.objRows(z);
    var sub = 'Untouched 4H fair value gaps from Zerodha Kite candles (your PC program, after each day\'s close): the latest 3-candle FVG of each stock when never touched, ' +
      'and every untouched Gap-up of 3-5%. During market hours your sheet watches them: price at or under a zone top = mitigated, in the hourly <b>Mitigated FVG</b> email. ' +
      'Distance = the sheet\'s delayed price vs the zone top.';
    var body;
    if (!rows.length) {
      body = '<p class="empty">Nothing yet - the PC program sends the 4H zones after its next Zerodha scan (it needs the new ScreenerBridge files and the sheet\'s new version).</p>';
    } else {
      var n = { FVG: 0, 'Gap-up': 0 };
      rows.forEach(function (r) { n[r.Kind] = (n[r.Kind] || 0) + 1; });
      body = '<div class="controls"><input class="search" id="sg-z4-q" type="search" placeholder="Search symbol or company" aria-label="Search 4H FVG zones" value="' + esc(ST.z4Q) + '">' +
        ui.chips('sgz4', [['all', 'All (' + F.int(rows.length) + ')'], ['FVG', '3-candle FVG (' + F.int(n.FVG) + ')'], ['Gap-up', 'Gap-up (' + F.int(n['Gap-up']) + ')'],
          ['near', 'Within 2%']], ST.z4Kind) + '<span class="count" id="sg-z4-count"></span></div><div id="sg-z4-t"></div>';
    }
    return sectionHtml('sg-z4', '4H FVG zones (Zerodha)', sub, body);
  }
  function drawZ4(el, ctx) {
    var box = $('#sg-z4-t', el);
    if (!box) return;
    var all = ui.objRows(ctx.D.zones4h);
    var t = new ui.Table({
      rows: [], pageSize: 25, id: 'signals-zones4h', empty: 'No zone with these filters',
      columns: [
        { key: 'Symbol', label: 'Stock', type: 'sym', name: 'Company' },
        { key: 'Kind', label: 'Zone', html: function (r) { return ui.badge(r.Kind === 'Gap-up' ? 'Gap-up' : '3-candle FVG', 's-info'); } },
        { key: 'Formed', label: 'Formed (4H candle)' },
        { key: 'Zone %', label: 'Zone size', type: 'num', digits: 2, title: 'Zone height as % of its bottom' },
        { key: 'Distance %', label: 'Distance', type: 'pct', digits: 2, title: 'The sheet\'s price vs the zone top (negative = at / inside the zone)' },
        { key: 'Mitigated Alerted', label: 'Status', get: function (r) { return r['Mitigated Alerted'] === 'Y' ? 'Mitigated' : 'Watching'; },
          html: function (r) { return r['Mitigated Alerted'] === 'Y' ? ui.badge('Mitigated today', 's-bad') : ui.badge('Watching', 's-good'); } },
        { key: 'chart', label: 'Chart', get: function () { return null; },
          html: function (r) { return '<a class="btn sm" href="' + esc(tvUrl(r.Symbol, '4H')) + '" target="_blank" rel="noopener">TradingView 4H ↗</a>'; } }
      ]
    }).mount(box);
    function apply() {
      var rows = all.filter(function (r) {
        var k = ST.z4Kind === 'all' || r.Kind === ST.z4Kind || (ST.z4Kind === 'near' && isNum(r['Distance %']) && r['Distance %'] <= 2);
        return k && ui.textMatch(ST.z4Q, [r.Symbol, r.Company]);
      });
      var c = $('#sg-z4-count', el);
      if (c) c.textContent = F.int(rows.length) + ' of ' + F.int(all.length);
      t.setRows(rows);
    }
    ui.bindChips(el, 'sgz4', function (v) { ST.z4Kind = v; apply(); });
    var q = $('#sg-z4-q', el), timer;
    if (q) q.addEventListener('input', function (e) { clearTimeout(timer); timer = setTimeout(function () { ST.z4Q = e.target.value.trim(); apply(); }, 120); });
    apply();
  }

  // FVG+Spring backtest (owner, 08-Nov-2026: "backtest it and show the winrate"; choice: 2R target) - the sheet's "Spring
  // Backtest" tabs (feed part springBacktest), made by the PC program on all its Zerodha candles: no prices, R only
  var SBT_TFS = [['4H', '4 hour (13:15 candle)'], ['D', 'Daily'], ['W', 'Weekly']];
  function sbtSectionHtml(ctx) {
    var b = ctx.D.springBacktest || {}, sum = ui.objRows(b.summary), trades = ui.objRows(b.trades);
    var sub = 'Every <b>FVG+Spring</b> (the Spring candle on the top of an FVG / Gap-up zone on its 1st or 2nd touch, or on its bottom line) tested on your PC\'s ' +
      'Zerodha candles: <b>buy at the Spring candle\'s close, stop just under its low; a win = the target (2 × the risk) reached before the stop, within 20 candles</b>. ' +
      'A candle that touches both counts as a loss. Win rate = wins ÷ (wins + losses); with a 2R target, about 33% is break-even (before costs). ' +
      'Past results are research, not a promise.';
    var body;
    if (!sum.length) {
      body = '<p class="empty">Nothing yet - after the next Zerodha scan (or double-click <b>BacktestNow.bat</b> in the ScreenerBridge folder) the win rates show here.</p>';
    } else {
      var by = {};
      sum.forEach(function (r) { (by[r.Timeframe] = by[r.Timeframe] || {})[r.Group] = r; });
      var tiles = SBT_TFS.map(function (tf) {
        var g = by[tf[0]] || {}, f = g['FVG+Spring'] || {}, sp = g['Spring (every one, for comparison)'] || {};
        var top = g['FVG+Spring - zone top'] || {}, bot = g['FVG+Spring - zone bottom'] || {};
        var rate = function (r) { return isNum(r['Win Rate %']) ? F.num(r['Win Rate %'], 1) + '%' : '–'; };
        return '<div class="tile" data-sbt="' + esc(tf[0]) + '"><div class="label">' + esc(tf[1]) + ' - FVG+Spring</div><div class="value">' + rate(f) + '</div>' +
          '<div class="note2">' + F.int(f.Signals) + ' signals · ' + F.int(f.Wins) + ' won · ' + F.int(f.Losses) + ' lost · avg ' + (isNum(f['Avg R']) ? F.num(f['Avg R'], 2) + 'R' : '–') +
          '<br>top ' + rate(top) + ' · bottom ' + rate(bot) + ' · every Spring ' + rate(sp) + '</div></div>';
      }).join('');
      body = '<div class="tiles">' + tiles + '</div><div id="sg-sbt-sum" style="margin-top:14px"></div>' +
        '<h3 style="margin:18px 0 8px">Newest FVG+Spring trades</h3>' +
        (trades.length ? '<div class="controls"><input class="search" id="sg-sbt-q" type="search" placeholder="Search symbol or company" aria-label="Search backtest trades" value="' + esc(ST.btQ2) + '">' +
          ui.chips('sgsbtf', [['all', 'All timeframes']].concat(SBT_TFS.map(function (t) { return [t[0], t[0]]; })), ST.btTf) +
          ui.chips('sgsbtr', [['all', 'Any result'], ['Win', 'Wins'], ['Loss', 'Losses'], ['No result', 'No result'], ['Open', 'Still open']], ST.btRes) +
          '<span class="count" id="sg-sbt-count"></span></div><div id="sg-sbt-t"></div>' : '<p class="empty">No trade listed.</p>') +
        (b.summary && b.summary.note ? '<p class="sub">' + esc(b.summary.note) + '</p>' : '');
    }
    return sectionHtml('sg-sbt', 'FVG+Spring win rate (backtest on Zerodha candles)', sub, body);
  }
  function drawSbt(el, ctx) {
    var b = ctx.D.springBacktest || {};
    var sbox = $('#sg-sbt-sum', el);
    if (sbox) {
      new ui.Table({
        rows: ui.objRows(b.summary), pageSize: 20, id: 'signals-spring-backtest', tools: false,
        columns: [
          { key: 'Timeframe', label: 'Timeframe' }, { key: 'Group', label: 'Group' },
          { key: 'Signals', label: 'Signals', type: 'num', digits: 0 }, { key: 'Wins', label: 'Wins', type: 'num', digits: 0 },
          { key: 'Losses', label: 'Losses', type: 'num', digits: 0 },
          { key: 'No result (20 candles)', label: 'No result', type: 'num', digits: 0, title: 'Neither the target nor the stop within 20 candles' },
          { key: 'Still open', label: 'Open', type: 'num', digits: 0, title: 'Fewer than 20 candles since the signal' },
          { key: 'Win Rate %', label: 'Win rate', html: function (r) { return isNum(r['Win Rate %']) ? '<b>' + F.num(r['Win Rate %'], 1) + '%</b>' : '–'; } },
          { key: 'Avg R', label: 'Avg R', type: 'num', digits: 2, title: 'Average result in risk units (win +2, loss −1, no result = where it closed)' },
          { key: 'From', label: 'From' }, { key: 'To', label: 'To' }
        ]
      }).mount(sbox);
    }
    var box = $('#sg-sbt-t', el);
    if (!box) return;
    var all = ui.objRows(b.trades);
    var t = new ui.Table({
      rows: [], pageSize: 25, id: 'signals-spring-trades', empty: 'No trade with these filters',
      columns: [
        { key: 'Candle', label: 'Spring candle' },
        { key: 'Symbol', label: 'Stock', type: 'sym', name: 'Company' },
        { key: 'Timeframe', label: 'TF', html: function (r) { return ui.badge(r.Timeframe || '–', 's-info'); } },
        { key: 'Where', label: 'Where', get: function (r) { return (r.Zone || '') + ' ' + String(r.Where || '').toLowerCase(); } },
        { key: 'Touch', label: 'Touch', type: 'num', digits: 0 },
        { key: 'Result', label: 'Result', html: function (r) {
          return ui.badge(r.Result || '–', r.Result === 'Win' ? 's-good' : r.Result === 'Loss' ? 's-bad' : ''); } },
        { key: 'R', label: 'R', type: 'num', digits: 2 },
        { key: 'Candles', label: 'Candles', type: 'num', digits: 0, title: 'Candles until the target / stop (20 = no result)' },
        { key: 'chart', label: 'Chart', get: function () { return null; },
          html: function (r) { return '<a class="btn sm" href="' + esc(tvUrl(r.Symbol, r.Timeframe)) + '" target="_blank" rel="noopener">TradingView ' + esc(r.Timeframe) + ' ↗</a>'; } }
      ]
    }).mount(box);
    function apply() {
      var rows = all.filter(function (r) {
        return (ST.btTf === 'all' || r.Timeframe === ST.btTf) && (ST.btRes === 'all' || r.Result === ST.btRes) && ui.textMatch(ST.btQ2, [r.Symbol, r.Company]);
      });
      var c = $('#sg-sbt-count', el);
      if (c) c.textContent = F.int(rows.length) + ' of ' + F.int(all.length);
      t.setRows(rows);
    }
    ui.bindChips(el, 'sgsbtf', function (v) { ST.btTf = v; apply(); });
    ui.bindChips(el, 'sgsbtr', function (v) { ST.btRes = v; apply(); });
    var q = $('#sg-sbt-q', el), timer;
    if (q) q.addEventListener('input', function (e) { clearTimeout(timer); timer = setTimeout(function () { ST.btQ2 = e.target.value.trim(); apply(); }, 120); });
    apply();
  }

  function defsHtml() {
    return '<details style="margin-top:14px"><summary style="cursor:pointer"><b>How these FVG rules work</b> <span class="sub">(definitions from your sheet\'s Code.gs)</span></summary>' +
      '<ul class="sub" style="margin:8px 0 0 18px;padding:0;display:grid;gap:4px">' +
      '<li><b>Timeframe:</b> daily candles only - the FVG rules look up to 60 sessions back (History30 tab + History60\'s older days from NSE via your PC); the 10 / 21 EMA support tags use the last 30 (History30), like the sheet.</li>' +
      '<li><b>Bullish 3-candle FVG</b> on day i: Low[i] &gt; High[i−2], and the gap (Low[i] − High[i−2]) is at least 0.7 × the average High−Low range of the 14 days ending on day i. Zone = High[i−2] (bottom) to Low[i] (top). Needs 17+ candles.</li>' +
      '<li><b>Gap-up FVG:</b> Low[i] &gt; High[i−1] by 3% to 10% (AB_GAPUP_MIN_PCT / AB_GAPUP_MAX_PCT, Control Panel). Zone = High[i−1] to Low[i]. It is dropped once a later candle trades down to the zone top (Low ≤ top).</li>' +
      '<li><b>First touch:</b> a candle\'s low crosses below the zone top after the previous low was at or above it. <b>Confirmed:</b> after a touch, a close crosses back above the high of the touch candle. <b>FVG+Spring</b> (your rule of 08-Nov-2026): a Spring candle pair (big red candle, then a small candle that dips below its low and closes back above it) whose 2nd candle sits on a 3-candle FVG or a Gap-up zone formed before the pair that still holds (no close below its bottom before the pair) - either on the <b>top</b> (its low comes into the zone\'s upper half and it closes above the zone top, on the zone\'s 1st or 2nd touch) or on the <b>bottom line</b> (its low reaches the bottom, at most 1% under it, and it closes above it - any touch). <b>Twin Star Bottom + FVG:</b> a red candle, then two small candles whose lows are within 1% of each other (the Twin Star Bottom pattern), with the stars reaching into an FVG formed before the red candle that still holds (both stars close at or above its bottom). These tags are reported for the last 4 candles.</li>' +
      '<li><b>Unmitigated:</b> the latest 3-candle FVG has not been touched since it formed. <b>Mitigated:</b> the price reached the zone - the sheet logs it (Mitigated FVG Log) and judges the next candle (held / swept / closed inside / broke below…).</li>' +
      '<li><b>Circuit-lock filter:</b> a candle whose High−Low range is ≤ 0.05% of its low is treated as locked at a price band; such candles cannot form a gap-up FVG and do not count as touches.</li>' +
      '<li><b>Turnover filter:</b> stocks whose average daily turnover ((High+Low)/2 × volume, locked candles excluded) is below ₹50 lakh (AB_FVG_MIN_AVG_TURNOVER) are not watched.</li>' +
      '<li><b>Approaching:</b> price within 0.5% above the zone top and still above the bottom (AB_GAPUP_NEAR_PCT / AB_UNMIT_NEAR_PCT). <b>Inside zone:</b> price between bottom and top.</li>' +
      '<li><b>Fill state</b> (descriptive, not a sheet rule): open = no later low reached the top; partially filled = a later low went below the top but stayed above the bottom; fully filled = a later low reached the bottom.</li>' +
      '<li><b>Bearish FVGs</b> are not part of your sheet strategy (it is long-only); they are shown separately below for information only.</li>' +
      '<li>Thresholds are the sheet\'s coded defaults (AB_GAPUP_MAX_PCT = 5 as in the workbook); your Control Panel itself is not published.</li></ul></details>';
  }

  function kpiHtml(k) {
    k = k || {};
    var keys = Object.keys(k);
    if (!keys.length) return '<p class="empty">The Pattern Dashboard KPIs were not in the sheet export.</p>';
    function val(v) { return /^\d+$/.test(v) ? F.int(+v) : esc(v); }      // "1800" -> "1,800"
    return TILES + keys.map(function (key) {
      var raw = String(k[key] == null ? '' : k[key]).trim();
      var m = /^(.+?)\s*\((.+)\)$/.exec(raw);
      return m ? ui.tile(pdLabel(key), val(m[1]), esc(m[2])) : ui.tile(pdLabel(key), raw ? val(raw) : '–');
    }).join('') + '</div>';
  }

  // ---------- 1. live recompute ----------
  function drawLive(el, ctx, H, data) {
    var lastDate = H.dates[H.dates.length - 1];
    var sess = latestSession(ctx);
    var state = lastDate === sess.date ? 'EOD' : 'CACHED';
    $('#sg-live-state', el).innerHTML = ui.stateBadge(state, lastDate, H.source || 'History30 tab');
    var rows = data.rows;
    var counts = { pat: 0, patNoQ: 0, fvg: 0, ema: 0, c3: 0 }, patCount = {}, fvgCount = { ft: 0, conf: 0, spring: 0, twin: 0, unmit: 0, gap: 0 }, e10 = 0, e21 = 0;
    var catCount = {};
    rows.forEach(function (r) {
      if (r.pat) counts.pat++;
      if (r.patList.some(function (t) { return t !== 'Spring?'; })) counts.patNoQ++;
      if (r.fvg) counts.fvg++;
      if (r.e10 || r.e21) counts.ema++;
      if (r.conf >= 3) counts.c3++;
      if (r.e10) e10++;
      if (r.e21) e21++;
      r.patList.forEach(function (t) { patCount[t] = (patCount[t] || 0) + 1; });
      Object.keys(fvgCount).forEach(function (k) { if (r.fvgList.some(function (t) { return FVG_RX[k].test(t); })) fvgCount[k]++; });
      catCount[r.cat || ''] = (catCount[r.cat || ''] || 0) + 1;
    });

    var stale = state !== 'EOD';
    var h = '<div class="tags" style="margin-bottom:10px"><span class="sub">Computed on the candle of ' + F.date(lastDate) + ' · ' + F.int(rows.length) + ' stocks · ' + F.int(data.ms) + ' ms in your browser</span></div>';
    if (stale) {
      h += '<div class="note warn" style="margin-bottom:12px">The newest candle is ' + F.date(lastDate) + '. ' +
        (sess.exact ? 'The latest completed NSE session is ' + F.date(sess.date) + ', so these tags are as of an older close.' :
          'Weekdays have passed since then, so newer sessions may exist (NSE holidays are only known here when the market-data API is deployed). Treat these tags as of the ' + F.date(lastDate) + ' close.') +
        ' Update the sheet export for newer candles.</div>';
    }
    var par = data.parity;
    h += TILES +
      ui.tile('Stocks evaluated', F.int(rows.length), (data.noCandles ? F.int(data.noCandles) + ' Main stocks have no candles' : 'all Main stocks have candles') +
        (data.older ? ' · ' + F.int(data.older) + ' with an older last candle' : '')) +
      ui.tile('With a pattern', F.int(counts.pat), F.int(counts.patNoQ) + ' excl. Spring?') +
      ui.tile('With an FVG tag', F.int(counts.fvg), F.int(fvgCount.ft) + ' first touch · ' + F.int(fvgCount.conf) + ' confirmed') +
      ui.tile('EMA support', F.int(counts.ema), F.int(e10) + ' on 10 EMA · ' + F.int(e21) + ' on 21 EMA') +
      ui.tile('Confluence 3+', F.int(counts.c3), 'of 4 cells filled') +
      ui.tile('Same as your sheet', par.n ? F.int(par.same) + ' / ' + F.int(par.n) : '–',
        par.n ? (par.diff.length ? 'differs: ' + esc(par.diff.slice(0, 5).join(', ')) + (par.diff.length > 5 ? '…' : '') : 'identical to the exported PatternData cells') : 'no PatternData cells in the export') +
      '</div>';

    h += '<div class="grid g2" style="margin-top:14px"><div><h3 style="margin-bottom:8px">Patterns on the latest candle</h3>' +
      ui.bars(SB.patterns.ORDER.map(function (p) { return { label: p, value: patCount[p] || 0, tip: p + ': ' + F.int(patCount[p] || 0) + ' stocks' }; }).filter(function (b) { return b.value; })
        .concat(SB.patterns.ORDER.some(function (p) { return patCount[p]; }) ? [] : [{ label: 'No pattern on any stock', value: 0 }])) +
      '</div><div><h3 style="margin-bottom:8px">FVG &amp; EMA tags</h3>' +
      ui.bars([['ft', 'FVG First Touch'], ['conf', 'FVG First Touch Confirmed'], ['spring', 'FVG+Spring'], ['twin', 'Twin Star Bottom + FVG'], ['unmit', 'FVG Unmitigated'], ['gap', 'Gap-up FVG']].map(function (k) {
        return { label: k[1], value: fvgCount[k[0]], tip: k[1] + ': ' + F.int(fvgCount[k[0]]) + ' stocks' };
      }).concat([{ label: '10 EMA Support', value: e10 }, { label: '21 EMA Support', value: e21 }])) + '</div></div>';

    var catOpts = [['', 'All categories']].concat(SB.classify.CATEGORIES.filter(function (c) { return catCount[c.id]; }).map(function (c) {
      return [c.id, c.name + ' (' + catCount[c.id] + ')'];
    }));
    if (catCount['']) catOpts.push(['none', 'Unclassified (' + catCount[''] + ')']);
    h += '<h3 style="margin:18px 0 8px">Every stock</h3>' +
      '<div class="controls"><input class="search" id="sg-q" type="search" placeholder="Search symbol, company or industry" aria-label="Search recomputed stocks" value="' + esc(ST.q) + '">' +
      selectHtml('sg-pat', 'Pattern', [['', 'Any or no pattern'], ['*', 'Has a pattern']].concat(SB.patterns.ORDER.map(function (p) { return [p, p + ' (' + (patCount[p] || 0) + ')']; })), ST.pat) +
      selectHtml('sg-ema', 'EMA support', [['', 'Any EMA state'], ['either', '10 or 21 EMA support'], ['10', '10 EMA support'], ['21', '21 EMA support'], ['both', 'Both 10 and 21 EMA']], ST.ema) +
      selectHtml('sg-conf', 'Minimum confluence', [['0', 'Confluence: any (incl. 0)'], ['1', 'Confluence ≥ 1'], ['2', 'Confluence ≥ 2'], ['3', 'Confluence ≥ 3'], ['4', 'Confluence = 4']], ST.conf) +
      selectHtml('sg-cat', 'Category', catOpts, ST.cat) + '</div>' +
      '<div class="controls">' + ui.chips('sgfvg', FVG_KINDS, ST.fvg) + '<span class="count" id="sg-count"></span>' +
      '<button class="btn" type="button" id="sg-reset">Clear filters</button><button class="btn" type="button" id="sg-csv">Export CSV</button></div>' +
      '<div id="sg-t"></div>';
    var body = $('#sg-live-body', el);
    body.innerHTML = h;

    var t = new ui.Table({
      rows: [], pageSize: 50, sort: { key: 'conf', dir: -1 }, empty: 'No stock matches these filters - try a lower confluence or "Any FVG state".',
      columns: [
        { key: 'sym', label: 'Stock', type: 'sym', name: 'name', csv: function (r) { return r.sym; } },
        { key: 'name', label: 'Company', csvOnly: true },
        { key: 'conf', label: 'Confluence', type: 'num', title: 'Filled cells among Pattern, FVG, 10 EMA, 21 EMA (0-4), as on your Pattern Dashboard' },
        { key: 'pat', label: 'Pattern', wrap: true, html: function (r) { return tagsHtml(r.patList); } },
        { key: 'fvg', label: 'FVG', wrap: true, html: function (r) { return tagsHtml(r.fvgList, 's-info'); } },
        { key: 'e10', label: '10 EMA', html: function (r) { return textCell(r.e10); } },
        { key: 'e21', label: '21 EMA', html: function (r) { return textCell(r.e21); } },
        { key: 'close', label: 'Close', type: 'price', title: 'Close of the last candle' },
        { key: 'chg', label: 'Day % (last candle)', type: 'pct', digits: 2 },
        { key: 't', label: 'Candle date', type: 'date' },
        { key: 'catName', label: 'Category', wrap: true }
      ]
    }).mount($('#sg-t', body));

    function match(r) {
      if (ST.cat === 'none' ? r.cat : ST.cat && r.cat !== ST.cat) return false;
      if (r.conf < +ST.conf) return false;
      if (ST.pat === '*' ? !r.pat : ST.pat && r.patList.indexOf(ST.pat) < 0) return false;
      if (ST.fvg !== 'all' && !r.fvgList.some(function (x) { return FVG_RX[ST.fvg].test(x); })) return false;
      if (ST.ema === 'either' && !(r.e10 || r.e21)) return false;
      if (ST.ema === '10' && !r.e10) return false;
      if (ST.ema === '21' && !r.e21) return false;
      if (ST.ema === 'both' && !(r.e10 && r.e21)) return false;
      return ui.textMatch(ST.q, [r.sym, r.name, r.ind, r.catName]);
    }
    function apply() {
      var list = rows.filter(match);
      $('#sg-count', body).textContent = F.int(list.length) + ' of ' + F.int(rows.length) + ' stocks';
      t.setRows(list);
    }
    var timer;
    $('#sg-q', body).addEventListener('input', function (e) {
      clearTimeout(timer);
      timer = setTimeout(function () { ST.q = e.target.value.trim(); apply(); }, 120);
    });
    $('#sg-pat', body).addEventListener('change', function (e) { ST.pat = e.target.value; apply(); });
    $('#sg-ema', body).addEventListener('change', function (e) { ST.ema = e.target.value; apply(); });
    $('#sg-conf', body).addEventListener('change', function (e) { ST.conf = e.target.value; apply(); });
    $('#sg-cat', body).addEventListener('change', function (e) { ST.cat = e.target.value; apply(); });
    ui.bindChips(body, 'sgfvg', function (v) { ST.fvg = v; apply(); });
    $('#sg-reset', body).addEventListener('click', function () {
      ST.q = ''; ST.pat = ''; ST.ema = ''; ST.conf = '1'; ST.cat = ''; ST.fvg = 'all';
      $('#sg-q', body).value = ''; $('#sg-pat', body).value = ''; $('#sg-ema', body).value = ''; $('#sg-conf', body).value = '1'; $('#sg-cat', body).value = '';
      body.querySelectorAll('[data-chip="sgfvg"]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-v') === 'all')); });
      apply();
    });
    $('#sg-csv', body).addEventListener('click', function () {
      ui.download('patterns-fvg-recomputed-' + lastDate + '.csv', ui.toCsv(t.toCsvRows()));
    });
    apply();
  }

  // ---------- 2. FVG zones ----------
  function drawZones(el, ctx, data) {
    var body = $('#sg-zones-body', el);
    var zones = data.zones.map(function (z) {
      var s = ctx.bySym[z.sym], a = approach(z, s);
      z.price = s ? s.price : null;
      z.ap = a;
      z.dist = a ? a.st.distancePct : null;
      return z;
    });
    var nGap = zones.filter(function (z) { return z.kind === 'Gap-up'; }).length;
    var nState = { inside: 0, near: 0, above: 0, below: 0 };
    zones.forEach(function (z) { if (z.ap) nState[z.ap.key]++; });
    var sheetN = ui.objRows(ctx.D.fvg).length, sheetG = ui.objRows(ctx.D.gapup).length;
    var h = TILES +
      ui.tile('Open zones watched', F.int(zones.length), F.int(nGap) + ' gap-up · ' + F.int(zones.length - nGap) + ' 3-candle') +
      ui.tile('Inside a zone now', F.int(nState.inside), F.int(nState.near) + ' approaching (≤0.5%)') +
      ui.tile('Skipped: low turnover', F.int(data.illiquid), 'avg turnover below ₹50 lakh') +
      ui.tile('Your sheet\'s tabs', F.int(sheetN + sheetG), F.int(sheetN) + ' unmitigated · ' + F.int(sheetG) + ' gap-up (snapshot below)') +
      '</div>';
    h += '<div class="controls" style="margin-top:14px"><input class="search" id="sg-zq" type="search" placeholder="Search symbol or category" aria-label="Search FVG zones" value="' + esc(ST.zq) + '">' +
      ui.chips('sgzk', [['all', 'All zones'], ['Gap-up', 'Gap-up FVG'], ['FVG', '3-candle FVG']], ST.zkind) + '</div>' +
      '<div class="controls">' + ui.chips('sgzs', [['all', 'Any price position'], ['inside', 'Inside zone (' + nState.inside + ')'], ['near', 'Approaching (' + nState.near + ')'],
        ['above', 'Above (' + nState.above + ')'], ['below', 'Below zone (' + nState.below + ')']], ST.zstate) +
      '<span class="count" id="sg-zcount"></span><button class="btn" type="button" id="sg-zcsv">Export CSV</button></div><div id="sg-zt"></div>';
    body.innerHTML = h;

    var t = new ui.Table({
      rows: [], pageSize: 25, sort: { key: 'dist', dir: 1 }, empty: 'No open zone matches these filters.',
      columns: [
        { key: 'sym', label: 'Stock', type: 'sym', name: 'name', csv: function (r) { return r.sym; } },
        { key: 'dist', label: 'Price vs zone', type: 'num', title: 'Distance of the price from the zone top', csv: function (r) { return r.ap ? r.ap.label : ''; },
          html: function (r) { return r.ap ? ui.badge(r.ap.label, r.ap.cls) : '<span class="sub">no price</span>'; } },
        { key: 'kind', label: 'Zone', get: function (r) { return r.kind === 'Gap-up' ? 'Gap-up FVG' : '3-candle FVG'; } },
        { key: 'bottom', label: 'Bottom', type: 'price' },
        { key: 'top', label: 'Top', type: 'price' },
        { key: 'pct', label: 'Size', type: 'num', html: function (r) { return pctPlain(r.pct); } },
        { key: 'formed', label: 'Formed', type: 'date' },
        { key: 'daysAgo', label: 'Sessions ago', type: 'num', digits: 0 },
        { key: 'fill', label: 'Fill state', type: 'badge', title: 'Descriptive: did any later candle trade into the zone?' },
        { key: 'price', label: 'Price', type: 'price' },
        { key: 'name', label: 'Company', csvOnly: true },
        { key: 'catName', label: 'Category', csvOnly: true }
      ]
    }).mount($('#sg-zt', body));
    function apply() {
      var list = zones.filter(function (z) {
        if (ST.zkind !== 'all' && z.kind !== ST.zkind) return false;
        if (ST.zstate !== 'all' && !(z.ap && z.ap.key === ST.zstate)) return false;
        return ui.textMatch(ST.zq, [z.sym, z.name, z.catName]);
      });
      $('#sg-zcount', body).textContent = F.int(list.length) + ' zones';
      t.setRows(list);
    }
    $('#sg-zq', body).addEventListener('input', function (e) { ST.zq = e.target.value.trim(); apply(); });
    ui.bindChips(body, 'sgzk', function (v) { ST.zkind = v; apply(); });
    ui.bindChips(body, 'sgzs', function (v) { ST.zstate = v; apply(); });
    $('#sg-zcsv', body).addEventListener('click', function () { ui.download('fvg-zones.csv', ui.toCsv(t.toCsvRows())); });
    apply();
  }

  // ---------- 3. bearish (information only) ----------
  function drawBear(el, data) {
    var body = $('#sg-bear-body', el);
    var total = data.bear.reduce(function (a, b) { return a + b.count; }, 0);
    body.innerHTML = '<div class="note warn">Mirror of the bullish rule: High[i] &lt; Low[i−2] (no size filter), counted over the last 30 candles and only while no later candle traded back up into the gap. ' +
      '<strong>Your sheet strategy is long-only and does not use bearish gaps</strong> - this list is for information, not a sell or short signal.</div>' +
      '<div class="controls" style="margin-top:12px"><input class="search" id="sg-bq" type="search" placeholder="Search symbol or category" aria-label="Search bearish gaps" value="' + esc(ST.bq) + '">' +
      '<span class="count" id="sg-bcount"></span></div><div id="sg-bt2"></div>';
    var t = new ui.Table({
      rows: [], pageSize: 25, sort: { key: 'count', dir: -1 }, empty: 'No stock has an unfilled bearish gap in the last 30 candles.',
      columns: [
        { key: 'sym', label: 'Stock', type: 'sym', name: 'name' },
        { key: 'count', label: 'Open bearish gaps', type: 'num', digits: 0 },
        { key: 'formed', label: 'Newest formed', type: 'date' },
        { key: 'bottom', label: 'Newest bottom', type: 'price' },
        { key: 'top', label: 'Newest top', type: 'price' },
        { key: 'pct', label: 'Size', type: 'num', html: function (r) { return pctPlain(r.pct); } },
        { key: 'close', label: 'Last close', type: 'price' },
        { key: 'catName', label: 'Category', wrap: true }
      ]
    }).mount($('#sg-bt2', body));
    function apply() {
      var list = data.bear.filter(function (r) { return ui.textMatch(ST.bq, [r.sym, r.name, r.catName]); });
      $('#sg-bcount', body).textContent = F.int(list.length) + ' stocks · ' + F.int(total) + ' gaps in all';
      t.setRows(list);
    }
    $('#sg-bq', body).addEventListener('input', function (e) { ST.bq = e.target.value.trim(); apply(); });
    apply();
  }

  // ---------- 4./5. sheet snapshots ----------
  function drawSnapshot(el, ctx) {
    var D = ctx.D, pd = D.patterns || {};
    new ui.Table({
      rows: ui.objRows(pd.signals), pageSize: 30, empty: 'The signals summary was not in the sheet export.',
      columns: [
        { key: 'Type', label: 'Type' },
        { key: 'Signal', label: 'Signal' },
        { key: 'Stocks', label: 'Stocks', type: 'num' },
        { key: 'Fresh today', label: 'Fresh at last run', type: 'num', title: 'Signals that were new on the day of the last patterns run' },
        { key: 'Avg % Change', label: 'Avg day % at last patterns run', type: 'pct', digits: 2 },
        { key: '% Advancing', label: '% up at last run', type: 'num', digits: 0, html: function (r) { return pctPlain(r['% Advancing'], 0); } },
        { key: 'Avg 10-day %', label: 'Avg 10D', type: 'pct' },
        { key: 'Avg 30-day %', label: 'Avg 30D', type: 'pct' },
        { key: 'Most common Basic Industry', label: 'Most common industry', wrap: true }
      ]
    }).mount($('#sg-sum', el));

    var st = ui.objRows(pd.stocks);
    var stT = new ui.Table({
      rows: [], pageSize: 25, sort: { key: 'Confluence', dir: -1 }, empty: 'No Pattern Dashboard stock matches these filters.',
      columns: [
        { key: 'Symbol', label: 'Stock', type: 'sym', name: 'Company' },
        { key: 'Basic Industry', label: 'Industry', wrap: true },
        { key: 'Pattern', label: 'Pattern', wrap: true },
        { key: 'FVG', label: 'FVG', wrap: true },
        { key: '10 EMA', label: '10 EMA' },
        { key: '21 EMA', label: '21 EMA' },
        { key: 'Confluence', label: 'Confluence', type: 'num' },
        { key: '% Change', label: 'Day % at last patterns run', type: 'pct', digits: 2 },
        { key: '10-day %', label: '10D', type: 'pct' },
        { key: '30-day %', label: '30D', type: 'pct' },
        { key: 'MKT Price', label: 'Price at last run', type: 'price' },
        { key: 'TTM Signal', label: 'TTM Signal (sheet)', type: 'badge', title: 'The sheet\'s valuation signal (TTM target vs price, EPS growth) - not a chart signal' }
      ]
    }).mount($('#sg-pd-stocks', el));
    function applyPd() {
      var rows = st.filter(function (r) {
        if (ST.pdF === 'buy' && r['TTM Signal'] !== 'Buy') return false;
        if (ST.pdF === 'c3' && !(r.Confluence >= 3)) return false;
        return ui.textMatch(ST.pdQ, [r.Symbol, r.Company, r['Basic Industry'], r.Pattern, r.FVG]);
      });
      $('#sg-pd-count', el).textContent = F.int(rows.length) + ' stocks';
      stT.setRows(rows);
    }
    $('#sg-pd-q', el).addEventListener('input', function (e) { ST.pdQ = e.target.value.trim(); applyPd(); });
    ui.bindChips(el, 'sgpd', function (v) { ST.pdF = v; applyPd(); });
    applyPd();

    new ui.Table({
      rows: ui.objRows(pd.clusters), pageSize: 20, empty: 'No industry clusters in the sheet export.',
      columns: [
        { key: 'Basic Industry', label: 'Industry', wrap: true },
        { key: 'Signalled stocks', label: 'Signalled', type: 'num' },
        { key: 'With 2+ signal types', label: '2+ types', type: 'num' },
        { key: 'Avg % Change', label: 'Avg day % at last patterns run', type: 'pct', digits: 2 },
        { key: 'Signal mix (fresh)', label: 'Signal mix (fresh at last run)', wrap: true },
        { key: 'Strongest names', label: 'Strongest names', wrap: true, html: function (r) { return symList(r['Strongest names']); } }
      ]
    }).mount($('#sg-cl', el));

    function zoneCols(pre) {
      return [
        { key: 'Symbol', label: 'Stock', type: 'sym' },
        { key: pre + ' Bottom', label: 'Bottom', type: 'price' },
        { key: pre + ' Top', label: 'Top', type: 'price' },
        { key: pre + ' %', label: 'Size', type: 'num', html: function (r) { return pctPlain(r[pre + ' %']); } },
        { key: 'Formed', label: 'Formed', type: 'date' },
        { key: 'Status', label: 'Status', type: 'badge' }
      ];
    }
    new ui.Table({ rows: ui.objRows(D.fvg), pageSize: 15, sort: { key: 'Formed', dir: -1 }, empty: 'The UnmitigatedFVG tab was empty.', columns: zoneCols('Zone') }).mount($('#sg-fvg', el));
    new ui.Table({ rows: ui.objRows(D.gapup), pageSize: 15, sort: { key: 'Formed', dir: -1 }, empty: 'The GapUpFVG tab was empty.', columns: zoneCols('Gap') }).mount($('#sg-gap', el));
  }

  // ---------- 6. FVG backtest ----------
  function catOf(label) {
    for (var i = 0; i < BT_CATS.length; i++) if (BT_CATS[i][0] === label) return BT_CATS[i][0];
    return 'No end-of-day candle';               // as the sheet (unknown label -> nodata)
  }
  function btStats(rows, min) {
    var byCat = {}, byType = {}, total = 0, since = '', until = '';
    function bump(m, k, oh, cl) {
      var s = m[k] || (m[k] = { n: 0, hit: 0, green: 0, nCl: 0, sumOh: 0 });
      s.n++; s.sumOh += oh;
      if (oh >= min) s.hit++;
      if (isNum(cl)) { s.nCl++; if (cl > 0) s.green++; }
    }
    rows.forEach(function (r) {
      var oh = r['Open to High %'];
      if (!isNum(oh)) return;
      var cl = r['Close vs Open %'];
      total++;
      if (r['Flagged On'] && (!since || r['Flagged On'] < since)) since = r['Flagged On'];
      if (r['Next Trading Day'] && r['Next Trading Day'] > until) until = r['Next Trading Day'];
      bump(byCat, catOf(String(r.Category || '').trim()), oh, cl);
      bump(byType, String(r['Zone Type'] || '') || 'FVG', oh, cl);
    });
    return { byCat: byCat, byType: byType, total: total, since: since, until: until };
  }
  function rateHtml(k, n) {
    if (!n) return '<span class="sub">–</span>';
    return '<b>' + Math.round(k / n * 100) + '%</b> <span class="sub">(' + F.int(k) + ' of ' + F.int(n) + ')</span>';
  }
  function drawBacktest(el, ctx) {
    var rows = ui.objRows(ctx.D.fvgBacktest);
    var sumHost = $('#sg-bt-sum', el);
    function drawSummary() {
      var S = btStats(rows, ST.btMin);
      if (!S.total) { sumHost.innerHTML = '<p class="empty">The FVG Backtest tab has no scored flags in the export yet.</p>'; return; }
      function row(label, s, note, strong) {
        return '<tr><td class="wrap"' + (note ? ' data-tip="' + esc(note) + '"' : '') + '>' + (strong ? '<b>' + esc(label) + '</b>' : esc(label)) + '</td><td class="num">' + F.int(s.n) + '</td><td class="num">' +
          rateHtml(s.hit, s.n) + '</td><td class="num">' + rateHtml(s.green, s.nCl) + '</td><td class="num">' + ui.deltaHtml(s.n ? s.sumOh / s.n : null, 2) + '</td></tr>';
      }
      var all = { n: 0, hit: 0, green: 0, nCl: 0, sumOh: 0 }, body = '';
      BT_CATS.forEach(function (c) {
        var s = S.byCat[c[0]];
        if (!s) return;
        body += row(c[0], s, c[1]);
        if (c[0] !== 'Spring Pattern') { all.n += s.n; all.hit += s.hit; all.green += s.green; all.nCl += s.nCl; all.sumOh += s.sumOh; }
      });
      if (all.n) body += row('All mitigated FVG (excl. Spring)', all, 'Every FVG / gap-up category above, Spring excluded', true);
      var types = Object.keys(S.byType).filter(function (k) { return k !== 'Spring'; }).sort();
      if (types.length) {
        body += '<tr><th scope="rowgroup" colspan="5" style="cursor:default">By zone type</th></tr>';
        types.forEach(function (k) { body += row(k, S.byType[k], null); });
      }
      sumHost.innerHTML = '<p class="sub" style="margin-bottom:8px">' + F.int(S.total) + ' scored flags, flagged ' + F.date(S.since) + ' to next trading day ' + F.date(S.until) +
        '. Hover a category for its meaning.</p><div class="tbl-wrap"><table class="tbl"><thead><tr>' +
        ['Flagged as', 'Flags', 'Next day open-to-high ≥ ' + ST.btMin + '%', 'Next day closed green', 'Avg open-to-high'].map(function (x, i) {
          return '<th scope="col" style="cursor:default"' + (i ? ' class="num"' : '') + '>' + esc(x) + '</th>';
        }).join('') + '</tr></thead><tbody>' + body + '</tbody></table></div>';
    }
    var t = new ui.Table({
      rows: [], pageSize: 20, sort: { key: 'Flagged On', dir: -1 }, empty: 'No backtest flag matches these filters.',
      columns: [
        { key: 'Flagged On', label: 'Flagged on', type: 'date' },
        { key: 'Next Trading Day', label: 'Next trading day', type: 'date' },
        { key: 'Symbol', label: 'Stock', type: 'sym' },
        { key: 'Source', label: 'Source' },
        { key: 'Zone Type', label: 'Zone type' },
        { key: 'Category', label: 'Category', wrap: true },
        { key: 'Zone %', label: 'Zone %', type: 'num', html: function (r) { return pctPlain(r['Zone %']); } },
        { key: 'Open', label: 'Open', type: 'price' },
        { key: 'High', label: 'High', type: 'price' },
        { key: 'Close', label: 'Close', type: 'price' },
        { key: 'Open to High %', label: 'Open to high', type: 'pct', digits: 2 },
        { key: 'Close vs Open %', label: 'Close vs open', type: 'pct', digits: 2 }
      ]
    }).mount($('#sg-bt-t', el));
    function apply() {
      var list = rows.filter(function (r) {
        if (ST.btType !== 'all' && r['Zone Type'] !== ST.btType) return false;
        if (ST.btCat && catOf(String(r.Category || '').trim()) !== ST.btCat) return false;
        return ui.textMatch(ST.btQ, [r.Symbol, r.Source]);
      });
      $('#sg-bt-count', el).textContent = F.int(list.length) + ' flags';
      t.setRows(list);
    }
    $('#sg-bt-min', el).addEventListener('change', function (e) { ST.btMin = +e.target.value; drawSummary(); });
    $('#sg-bt-q', el).addEventListener('input', function (e) { ST.btQ = e.target.value.trim(); apply(); });
    $('#sg-bt-cat', el).addEventListener('change', function (e) { ST.btCat = e.target.value; apply(); });
    ui.bindChips(el, 'sgbt', function (v) { ST.btType = v; apply(); });
    $('#sg-bt-csv', el).addEventListener('click', function () { ui.download('fvg-backtest.csv', ui.toCsv(t.toCsvRows())); });
    drawSummary();
    apply();
  }

  // ---------- 6b./7. logs ----------
  function drawLogs(el, ctx) {
    var D = ctx.D;
    var ml = ui.objRows(D.mitigatedLog);
    var mt = new ui.Table({
      rows: [], pageSize: 20, sort: { key: 'Date', dir: -1 }, empty: 'No mitigated zone matches these filters.',
      columns: [
        { key: 'Date', label: 'Date', type: 'date', get: function (r) { return r.Date ? r.Date + (r.Time ? ' ' + String(r.Time).slice(0, 5) : '') : null; },
          html: function (r) { return F.date(r.Date) + (r.Time ? ' <span class="sub">' + esc(String(r.Time).slice(0, 5)) + '</span>' : ''); } },
        { key: 'Type', label: 'Type' },
        { key: 'Symbol', label: 'Stock', type: 'sym' },
        { key: 'Zone Bottom', label: 'Bottom', type: 'price' },
        { key: 'Zone Top', label: 'Top', type: 'price' },
        { key: 'Zone %', label: 'Size', type: 'num', html: function (r) { return pctPlain(r['Zone %']); } },
        { key: 'Price / Source', label: 'Price / source' }
      ]
    }).mount($('#sg-ml-t', el));
    function applyMl() {
      var list = ml.filter(function (r) {
        if (ST.mlType !== 'all' && r.Type !== ST.mlType) return false;
        return ui.textMatch(ST.mlQ, [r.Symbol]);
      });
      $('#sg-ml-count', el).textContent = F.int(list.length) + ' entries';
      mt.setRows(list);
    }
    $('#sg-ml-q', el).addEventListener('input', function (e) { ST.mlQ = e.target.value.trim(); applyMl(); });
    ui.bindChips(el, 'sgml', function (v) { ST.mlType = v; applyMl(); });
    applyMl();

    var logRows = ui.objRows(D.watchLog);
    var lt = new ui.Table({
      rows: [], pageSize: 20, sort: { key: 'Date Flagged', dir: -1 }, empty: 'No flagged stock matches these filters.',
      columns: [
        { key: 'Date Flagged', label: 'Flagged', type: 'date' },
        { key: 'Symbol', label: 'Stock', type: 'sym', name: 'Name' },
        { key: 'Source', label: 'Source' },
        { key: 'Price At Flag', label: 'Price at flag', type: 'price' },
        { key: 'now', label: 'Price now', type: 'price', get: function (r) { var s = ctx.bySym[r.Symbol]; return s ? s.price : null; } },
        { key: 'since', label: 'Since flag', type: 'pct', get: function (r) {
          var s = ctx.bySym[r.Symbol], p0 = r['Price At Flag'];
          return s && isNum(s.price) && isNum(p0) && p0 > 0 ? (s.price / p0 - 1) * 100 : null;
        } }
      ]
    }).mount($('#sg-wl-t', el));
    function applyWl() {
      var list = logRows.filter(function (r) {
        if (ST.wlSrc !== 'all' && r.Source !== ST.wlSrc) return false;
        return ui.textMatch(ST.wlQ, [r.Symbol, r.Name, r.Source]);
      });
      $('#sg-wl-count', el).textContent = F.int(list.length) + ' flags';
      lt.setRows(list);
    }
    $('#sg-wl-q', el).addEventListener('input', function (e) { ST.wlQ = e.target.value.trim(); applyWl(); });
    ui.bindChips(el, 'sgwl', function (v) { ST.wlSrc = v; applyWl(); });
    applyWl();
  }
})();
