/* Results & corporate events: results season tracker + performance + upcoming results. */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, esc = ui.esc, F = ui.F, $ = ui.$;
  var RS = { status: 'all' };

  SB.page('results', {
    render: function (el, params, ctx) {
      var D = ctx.D, perf = D.resultsPerf || {};
      var season = (perf.seasons || [])[0];
      var tracker = ui.objRows(D.resultsTracker);
      var seasonRows = season ? tracker.filter(function (r) { return r['Quarter Expected'] === season.season; }) : tracker;
      var tc = { Updated: 0, Pending: 0, 'Gave up': 0 };
      seasonRows.forEach(function (r) { if (r.Status in tc) tc[r.Status]++; });
      var upcoming = ctx.stocks.filter(function (s) {
        var d = ui.parseDate(s.rdate);
        if (!d) return false;
        var dd = ui.dayDiff(d, ctx.refDate);
        return dd >= 0 && dd <= 30;
      });

      var h = '<div class="page-head"><div><h1>Results &amp; corporate events' + (season ? ' · ' + esc(season.season) + ' season' : '') + '</h1>' +
        '<p>Upcoming result dates, how stocks moved after their quarterly results, and which results screener.in has not shown yet. ' +
        ui.stateBadge('CACHED', perf.asOf || D.asOf, 'Results Performance tab') + '</p></div></div>';
      if (season) {
        h += '<div class="tiles">' +
          ui.tile('Stocks tracked', F.int(season.tracked), 'results updated this season') +
          ui.tile('Average since results', ui.deltaHtml(season.avg, 2), 'vs close before the result') +
          ui.tile('Median since results', ui.deltaHtml(season.median, 2)) +
          ui.tile('Above pre-result price', esc(season.above || '–')) +
          ui.tile('Strong results, sold off', F.int(season.soldOff), 'good numbers, price fell') +
          ui.tile('Waiting on screener.in', F.int(tc.Pending), tc['Gave up'] + ' gave up') +
          '</div>';
      }
      var verdicts = (perf.verdicts || []).filter(function (v) { return v.verdict; });
      h += '<div class="grid g2">' +
        ui.card('Stocks by results verdict', 'Count of stocks; hover for the average move since results',
          ui.bars(verdicts.map(function (v) {
            return { label: v.verdict, value: v.stocks, tip: v.verdict + ': ' + F.int(v.stocks) + ' stocks · avg ' + F.pct(v.avg, 2) + ' since results · ' + F.num(v.positive, 0) + '% positive' };
          }))) +
        ui.card('Average move since results, by verdict', 'Strong / Mixed / Weak results',
          ui.bars(verdicts.map(function (v) { return { label: v.verdict, value: v.avg }; }), { diverging: true, fmt: function (v) { return F.pct(v, 2); } }) +
          '<div class="legend"><span><i style="background:var(--bar)"></i>Up since results</span><span><i style="background:var(--bar-neg)"></i>Down since results</span></div>') +
        '</div>';
      h += ui.card('Upcoming results (next 30 days)', upcoming.length + ' stocks · from the Main tab Result Date (NSE results calendar pasted in the Results tab)', '<div id="up-t"></div>');
      h += ui.card('Results performance', esc(perf.note || '') + ' · FII trend and TTM EPS growth: Main tab', '<div class="controls"><input class="search" id="rp-q" type="search" placeholder="Search symbol or industry" aria-label="Search results performance"><button class="btn" type="button" id="rp-csv">Export CSV</button></div><div id="rp-table"></div>');
      h += '<section class="card"><div class="card-head"><div><h2>Results tracker</h2><p>Every stock whose result date has arrived. Pending = screener.in does not show the new quarter yet (retried every run).</p></div></div>' +
        '<div class="controls">' + ui.chips('rs', [['all', 'All (' + tracker.length + ')'], ['Updated', 'Updated (' + tracker.filter(function (r) { return r.Status === 'Updated'; }).length + ')'],
          ['Pending', 'Pending (' + tracker.filter(function (r) { return r.Status === 'Pending'; }).length + ')'],
          ['Gave up', 'Gave up (' + tracker.filter(function (r) { return r.Status === 'Gave up'; }).length + ')']], RS.status) + '</div>' +
        '<div id="rs-table"></div></section>';
      el.innerHTML = h;

      new ui.Table({
        rows: upcoming, pageSize: 20, sort: { key: 'rdate', dir: 1 }, empty: 'No result dates in the next 30 days',
        columns: [
          { key: 'rdate', label: 'Result date', type: 'date' },
          { key: 'sym', label: 'Stock', type: 'sym', name: 'name' },
          { key: 'catName', label: 'Category', wrap: true },
          { key: 'price', label: 'Price', type: 'price' },
          { key: 'chg', label: 'Today', type: 'pct', digits: 2 },
          { key: 'sig', label: 'TTM Signal', type: 'badge' },
          { key: 'qrev', label: 'Last Rev QoQ', type: 'pct', digits: 0 },
          { key: 'qnp', label: 'Last Profit QoQ', type: 'pct', digits: 0 }
        ]
      }).mount($('#up-t', el));

      // FII trend and TTM EPS growth are not in the Results Performance tab: take them from Main
      var perfRows = ui.objRows(perf.table).map(function (r) {
        var s = ctx.bySym[r.Symbol];
        r.fiiTrend = s ? s.fii : null;
        r.epsGrowth = s ? s.epsg : null;
        return r;
      });
      var pt = new ui.Table({
        rows: perfRows, pageSize: 25, sort: { key: '% Since Results', dir: -1 },
        columns: [
          { key: 'Symbol', label: 'Stock', type: 'sym', name: 'Company' },
          { key: 'Basic Industry', label: 'Industry', wrap: true },
          { key: 'Quarter', label: 'Quarter' },
          { key: 'Result Date', label: 'Result date', type: 'date' },
          { key: 'Result Day %', label: 'Result day', type: 'pct' },
          { key: '% Since Results', label: 'Since results', type: 'pct' },
          { key: 'Max Gain %', label: 'Max gain', type: 'pct' },
          { key: 'Max Drawdown %', label: 'Max drawdown', type: 'pct' },
          { key: 'Rev YoY %', label: 'Rev YoY', type: 'pct', digits: 0 },
          { key: 'NP YoY %', label: 'Profit YoY', type: 'pct', digits: 0 },
          { key: 'Rev QoQ %', label: 'Rev QoQ', type: 'pct', digits: 0 },
          { key: 'NP QoQ %', label: 'Profit QoQ', type: 'pct', digits: 0 },
          { key: 'OPM QoQ', label: 'OPM QoQ', type: 'badge', title: 'Operating profit margin trend vs the previous quarter' },
          { key: 'OPM YoY', label: 'OPM YoY', type: 'badge', title: 'Operating profit margin trend vs the same quarter last year' },
          { key: 'fiiTrend', label: 'FII', type: 'badge', title: 'FII holding trend (Main tab "FII Activity")' },
          { key: 'epsGrowth', label: 'EPS growth', type: 'pct', digits: 0, title: 'TTM EPS growth % (Main tab)' },
          { key: 'Results Verdict', label: 'Verdict', type: 'badge' },
          { key: 'Market Reaction', label: 'Reaction', type: 'badge' }
        ]
      }).mount($('#rp-table', el));
      $('#rp-q', el).addEventListener('input', function (e) {
        var q = e.target.value.trim();
        pt.setRows(perfRows.filter(function (r) { return ui.textMatch(q, [r.Symbol, r.Company, r['Basic Industry']]); }));
      });
      $('#rp-csv', el).addEventListener('click', function () { ui.download('results-performance.csv', ui.toCsv(pt.toCsvRows())); });

      var rt = new ui.Table({
        rows: [], pageSize: 25, sort: { key: 'Result Date', dir: -1 },
        columns: [
          { key: 'Symbol', label: 'Stock', type: 'sym', name: 'Company' },
          { key: 'Result Date', label: 'Result date', type: 'date' },
          { key: 'Quarter Expected', label: 'Expected' },
          { key: 'Screener Latest Quarter', label: 'Screener shows' },
          { key: 'Status', label: 'Status', type: 'badge' },
          { key: 'Checks', label: 'Checks', type: 'num', get: function (r) { return r.Checks == null ? null : +r.Checks; } },
          { key: 'Last Checked', label: 'Last checked', type: 'datetime' },
          { key: 'Note', label: 'Note', wrap: true }
        ]
      }).mount($('#rs-table', el));
      function applyRs() { rt.setRows(tracker.filter(function (r) { return RS.status === 'all' || r.Status === RS.status; })); }
      ui.bindChips(el, 'rs', function (v) { RS.status = v; applyRs(); });
      applyRs();
    }
  });
})();
