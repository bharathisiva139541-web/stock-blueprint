/* Overview: benchmarks, breadth, sector performance, strategy setups,
   watchlist highlights, upcoming results, alerts/risk and data status. */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, esc = ui.esc, F = ui.F, isNum = ui.isNum, $ = ui.$;

  function avg(a) { var s = a.filter(isNum); return s.length ? s.reduce(function (x, y) { return x + y; }, 0) / s.length : null; }

  function dataStatus(ctx) {
    var D = ctx.D, H = ctx.history, m = ctx.market, pi = m.providerInfo;
    var rows = [
      ['Prices (Main tab)', ui.leastFresh(ctx.stocks.map(function (s) { return s.priceState; })), m.asOf,
        (m.source || 'Sheet snapshot (GOOGLEFINANCE, ~20 min delayed when exported)') + (m.partial ? ' - partial: some prices are still the sheet snapshot' : '')],
      ['Daily candles (History30)', H ? SB.candleState(H) : 'CACHED', H ? H.dates[H.dates.length - 1] : null, H ? H.source : 'not loaded yet (loads with the strategy)'],
      ['Pattern Dashboard tab', 'CACHED', D.patterns && D.patterns.asOf, 'Sheet tab, refreshed by Code.gs'],
      ['Results Performance', 'CACHED', D.asOf, 'Sheet tab, refreshed by Results Day runs']
    ];
    return '<section class="card" id="ov-data"><div class="card-head"><div><h2>Data &amp; provider status</h2><p>Where every number on this site comes from, and how fresh it is. Nothing is shown as LIVE unless a provider returned it as real-time.</p></div></div>' +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Dataset</th><th>State</th><th>As of</th><th>Source</th></tr></thead><tbody>' +
      rows.map(function (r) { return '<tr><td>' + esc(r[0]) + '</td><td>' + ui.badge(r[1]) + '</td><td>' + F.dateTime(r[2]) + '</td><td class="wrap">' + esc(r[3]) + '</td></tr>'; }).join('') +
      '</tbody></table></div><div class="note" style="margin-top:10px">' +
      (pi ? '<b>Market-data provider:</b> ' + esc(pi.name) + (pi.configured ? ' (configured)' : ' - not configured: set ' + esc((pi.requires || []).join(', ')) + ' in the server settings') +
        (pi.licensing ? '<br><span class="sub">' + esc(pi.licensing) + '</span>' : '') + (m.session ? '<br><b>NSE session:</b> ' + esc(m.session.state) + (m.session.lastCompletedSession ? ' · last completed session ' + esc(m.session.lastCompletedSession) : '') : '')
        : '<b>Market-data provider:</b> none on this host. ' + esc(m.message || '') + ' Live/delayed quotes need the Vercel deployment with a provider (see docs/MARKET_DATA.md).') +
      '</div></section>';
  }

  SB.page('overview', {
    render: function (el, params, ctx) {
      var stocks = ctx.stocks, D = ctx.D;
      var priced = stocks.filter(function (s) { return isNum(s.chg); });
      var adv = priced.filter(function (s) { return s.chg > 0; }).length, dec = priced.filter(function (s) { return s.chg < 0; }).length;
      var flat = priced.length - adv - dec;
      var season = (D.resultsPerf && D.resultsPerf.seasons || [])[0];
      var tracker = ui.objRows(D.resultsTracker).filter(function (r) { return !season || r['Quarter Expected'] === season.season; });
      var pend = tracker.filter(function (r) { return r.Status === 'Pending'; }).length;
      var alerts = ui.objRows(D.alerts), openA = alerts.filter(function (a) { return a.Outcome === 'Open'; }).length;
      var myRules = (ui.store.get('alerts:rules', []) || []).filter(function (r) { return r && r.enabled !== false; }).length;
      var idx = ui.objRows(D.indices);
      var n50 = idx.filter(function (r) { return r['NSE Symbol'] === 'NIFTY_50'; })[0];

      var h = '<div class="page-head"><div><h1>Market overview</h1><p>Your ' + F.int(stocks.length) + '-stock NSE watchlist: benchmarks, breadth, sectors, strategy setups, results and alerts. ' +
        ui.stateBadge(ctx.market.state, ctx.market.asOf, ctx.market.source) + '</p></div></div>';
      h += '<div class="tiles">' +
        ui.tile('NIFTY 50', n50 ? F.price(n50['Current Price']) : '–', n50 ? ui.deltaHtml(n50['Day change'], 2) + ' today · ' + F.pct(n50['Drop from all time high']) + ' from ATH · ' + ui.stateBadge('CACHED', D.asOf || D.generated, 'Indextracker tab of your sheet') : 'not in Indextracker', 'hero') +
        ui.tile('Breadth', adv + ' / ' + dec, 'advancing / declining · ' + flat + ' unchanged') +
        ui.tile('Strategy setups', '<span id="ov-q">…</span>', '<span id="ov-qn">active strategy</span>') +
        ui.tile('Results season' + (season ? ' · ' + season.season : ''), F.int(season ? season.tracked : 0), F.int(pend) + ' still waiting on screener.in') +
        ui.tile('Open alerts', F.int(openA), 'sheet watch alerts · ' + myRules + ' of your own rules') +
        ui.tile('Portfolio heat', '<span id="ov-heat">–</span>', '<span id="ov-heatn">from your trade journal</span>') +
        '</div>';

      // sector performance by dashboard category
      var cats = {};
      priced.forEach(function (s) { var k = s.cat || ''; (cats[k] = cats[k] || []).push(s); });
      var catItems = SB.classify.CATEGORIES.filter(function (c) { return cats[c.id] && cats[c.id].length >= 3; }).map(function (c) {
        var a = avg(cats[c.id].map(function (s) { return s.chg; })), up = cats[c.id].filter(function (s) { return s.chg > 0; }).length;
        return { label: c.name, value: a, href: '#industries/' + c.id, tip: c.name + ': avg ' + F.pct(a, 2) + ' · ' + up + ' of ' + cats[c.id].length + ' up' };
      }).sort(function (a, b) { return b.value - a.value; });

      h += '<div class="grid g2">' +
        ui.card('Benchmarks', 'NSE indices from your Indextracker tab ' + ui.stateBadge('CACHED', D.asOf || D.generated, 'Indextracker tab of your sheet'), '<div id="ov-idx"></div>') +
        ui.card('Industry performance today', 'Average % change per category - click a bar for the industry page', ui.bars(catItems, { diverging: true, fmt: function (v) { return F.pct(v, 2); } }) +
          '<div class="legend"><span><i style="background:var(--bar)"></i>Average up</span><span><i style="background:var(--bar-neg)"></i>Average down</span></div>') + '</div>';
      h += '<section class="card"><div class="card-head"><div><h2>Top strategy setups</h2><p id="ov-strat-sub">Running the active strategy…</p></div><a class="btn" href="#suggestions">All suggestions</a></div><div id="ov-strat">' + ui.skeleton(4) + '</div></section>';

      var g = priced.slice().sort(function (a, b) { return b.chg - a.chg; }).slice(0, 6);
      var l = priced.slice().sort(function (a, b) { return a.chg - b.chg; }).slice(0, 6);
      function mover(arr) {
        return '<ul class="list">' + arr.map(function (s) {
          return '<li><div class="grow">' + ui.stockCell(s.sym, s.name) + '</div><span class="num">' + F.price(s.price) + '</span><span class="num" style="min-width:64px">' + ui.deltaHtml(s.chg, 2) + '</span></li>';
        }).join('') + '</ul>';
      }
      var soon = stocks.filter(function (s) { var d = ui.parseDate(s.rdate); if (!d) return false; var dd = ui.dayDiff(d, ctx.refDate); return dd >= 0 && dd <= 7; });
      h += '<div class="grid g3">' + ui.card('Watchlist gainers', '% change today', mover(g)) + ui.card('Watchlist losers', '% change today', mover(l)) +
        ui.card('Results in the next 7 days', soon.length + ' stocks · <a href="#results">all results &amp; events</a>', '<div id="ov-soon"></div>') + '</div>';
      h += dataStatus(ctx);
      el.innerHTML = h;

      new ui.Table({
        rows: idx, pageSize: 8, sort: { key: 'Day change', dir: -1 },
        columns: [
          { key: 'NSE Symbol', label: 'Index', get: function (r) { return String(r['NSE Symbol'] || '').replace(/_/g, ' '); } },
          { key: 'Current Price', label: 'Level', type: 'price' },
          { key: 'Day change', label: 'Today', type: 'pct', digits: 2 },
          { key: 'Drop from all time high', label: 'From ATH', type: 'pct' },
          { key: '1 year returns', label: '1Y', type: 'pct' }
        ]
      }).mount($('#ov-idx', el));
      new ui.Table({
        rows: soon, pageSize: 8, sort: { key: 'rdate', dir: 1 }, empty: 'No result dates in the next 7 days',
        columns: [{ key: 'rdate', label: 'Date', type: 'date' }, { key: 'sym', label: 'Stock', type: 'sym', name: 'name' }, { key: 'chg', label: 'Today', type: 'pct', digits: 2 }]
      }).mount($('#ov-soon', el));

      // portfolio heat from the viewer's own journal + risk settings (this browser only)
      try {
        var open = SB.journal ? SB.journal.open() : [];
        if (open.length) {
          var pr = SB.journal.portfolio(ctx);
          $('#ov-heat', el).innerHTML = F.num(pr.heatPct, 1) + '%';
          $('#ov-heatn', el).textContent = open.length + ' open journal positions · limit ' + pr.heatLimitPct + '%';
        } else $('#ov-heatn', el).textContent = 'no open journal positions';
      } catch (e) { /* journal unreadable: keep the dash */ }

      SB.strategies.runActive().then(function (run) {
        var cfg = run.config, q = run.lists.qualified;
        var ds = $('#ov-data', el);
        if (ds) ds.outerHTML = dataStatus(ctx);           // the candle file is loaded now: show its state
        $('#ov-q', el).textContent = F.int(q.length);
        var dsc = SB.strategies.describe(cfg);
        $('#ov-qn', el).textContent = (cfg.mode === 'screen' ? 'match ' : 'qualified · ') + cfg.name.replace(/ \(.*\)$/, '') + (cfg.source === 'demo' ? ' (DEMO)' : SB.strategies.isConfirmed(cfg.id) ? '' : ' (unconfirmed)');
        $('#ov-strat-sub', el).innerHTML = esc(cfg.name) + ' v' + cfg.version + ' · candles to ' + F.date(run.dataAsOf) + ' · ' +
          (cfg.source === 'demo' ? '<b>DEMO - not recommendations</b>' : esc(dsc.tag));
        var top = q.slice(0, 8).map(function (r) { var s = ctx.bySym[r.sym]; return { sym: r.sym, name: s.name, catName: s.catName, price: s.price, chg: s.chg, score: r.score, conf: r.confluence, rr: r.rr, why: (r.triggersPassed || []).join(' + ') }; });
        if (!top.length) { $('#ov-strat', el).innerHTML = '<p class="empty">No qualifying setup currently.</p>'; return; }
        new ui.Table({
          rows: top, pageSize: 8,
          columns: [{ key: 'sym', label: 'Stock', type: 'sym', name: 'name' }, { key: 'catName', label: 'Category', wrap: true }, { key: 'price', label: 'Price', type: 'price' },
            { key: 'chg', label: 'Today', type: 'pct', digits: 2 }, { key: 'score', label: 'Match %', type: 'num' }, { key: 'conf', label: 'Confluence', type: 'num' },
            { key: 'rr', label: 'R:R', type: 'num', digits: 2 }, { key: 'why', label: 'Signals', wrap: true }]
        }).mount($('#ov-strat', el));
      }).catch(function (e) { $('#ov-strat', el).innerHTML = '<div class="note bad">Strategy could not run: ' + esc(e.message) + '</div>'; $('#ov-q', el).textContent = '–'; });

      if (params[0] === 'data') setTimeout(function () { var d = $('#ov-data', el); if (d) d.scrollIntoView({ block: 'start' }); }, 0);
    }
  });
})();
