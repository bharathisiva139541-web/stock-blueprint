/* Results & corporate events: results season tracker + performance + upcoming results.
   Every tile and bar opens the list of stocks behind it (#results/<kind>, web/lib/results.js). */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, esc = ui.esc, F = ui.F, $ = ui.$, R = SB.results;
  var RS = { status: 'all' }, RL = { q: '' };

  function linkTile(kind, label, value, note) {
    return '<a class="tile tile-link" href="#results/' + kind + '"><div class="label">' + esc(label) + '</div><div class="value">' + value + '</div>' +
      (note ? '<div class="note2">' + note + '</div>' : '') + '<span class="tile-go" aria-hidden="true">→</span></a>';
  }

  /** #results/<kind>: the stocks behind one tile / bar. */
  function renderList(el, ctx, kind, perf, pRows, tRows, seasonName) {
    var K = R.KINDS.filter(function (k) { return k.id === kind; })[0];
    var n = R.counts(pRows, tRows);
    var src = K.src === 'perf' ? 'Results Performance' : 'Results Tracker';
    el.innerHTML = '<div class="page-head"><div><p class="sub"><a href="#results">← Results &amp; corporate events</a></p><h1>' + esc(K.label) + '</h1><p>' +
      (seasonName ? esc(seasonName) + ' season · ' : '') + 'from your sheet\'s ' + src + ' tab ' + ui.stateBadge('CACHED', perf.asOf || ctx.D.asOf, src + ' tab') + '</p></div>' +
      '<div class="actions"><button class="btn" type="button" id="rl-csv">Export CSV</button></div></div>' +
      '<section class="card"><nav class="chips rl-kinds" aria-label="Results lists">' + R.KINDS.filter(function (k) { return n[k.id] || k.id === kind; }).map(function (k) {
        return '<a class="chip" href="#results/' + k.id + '" aria-pressed="' + (k.id === kind) + '"' + (k.id === kind ? ' aria-current="page"' : '') + '>' +
          esc(k.label) + ' <b>' + F.int(n[k.id]) + '</b></a>';
      }).join('') + '</nav>' +
      '<div class="controls"><input class="search" id="rl-q" type="search" placeholder="Search symbol, company or industry" aria-label="Search this list" value="' + esc(RL.q) + '">' +
      '<span class="count" id="rl-count"></span></div><div id="rl-t"></div></section>';
    var cols = K.src === 'perf' ? [
      { key: 'Symbol', label: 'Stock', type: 'sym', name: 'Company' },
      { key: 'Basic Industry', label: 'Industry', wrap: true },
      { key: 'Result Date', label: 'Result date', type: 'date' },
      { key: 'Announced', label: 'Announced', title: 'When NSE got the results (IST) and the market session' },
      { key: 'Result Day %', label: 'Result day', type: 'pct', title: 'The first session that could react vs the close before it' },
      { key: '% Since Results', label: 'Since results', type: 'pct' },
      { key: 'Max Gain %', label: 'Max gain', type: 'pct' },
      { key: 'Max Drawdown %', label: 'Max drawdown', type: 'pct' },
      { key: 'Results Verdict', label: 'Verdict', type: 'badge' },
      { key: 'Market Reaction', label: 'Reaction', type: 'badge' },
      { key: 'Signal', label: 'Signal', wrap: true },
      { key: 'Rev YoY %', label: 'Rev YoY', type: 'pct', digits: 0 },
      { key: 'NP YoY %', label: 'Profit YoY', type: 'pct', digits: 0 }
    ] : [
      { key: 'Symbol', label: 'Stock', type: 'sym', name: 'Company' },
      { key: 'Result Date', label: 'Result date', type: 'date' },
      { key: 'Announced', label: 'Announced' },
      { key: 'Quarter Expected', label: 'Expected' },
      { key: 'Screener Latest Quarter', label: 'Screener shows' },
      { key: 'Status', label: 'Status', type: 'badge' },
      { key: 'Checks', label: 'Checks', type: 'num', get: function (r) { return r.Checks == null ? null : +r.Checks; } },
      { key: 'Last Checked', label: 'Last checked', type: 'datetime' },
      { key: 'Note', label: 'Note', wrap: true }
    ];
    var t = new ui.Table({ id: 'results-list-' + K.src, rows: [], pageSize: 50, sort: K.sort, empty: 'No stocks in this list', columns: cols }).mount($('#rl-t', el));
    var list = R.pick(kind, pRows, tRows);
    function apply() {
      var rows = list.filter(function (r) { return ui.textMatch(RL.q, [r.Symbol, r.Company, r['Basic Industry']]); });
      $('#rl-count', el).textContent = F.int(rows.length) + ' of ' + F.int(list.length) + ' stock' + (list.length === 1 ? '' : 's');
      t.setRows(rows);
    }
    var timer;
    $('#rl-q', el).addEventListener('input', function (e) { clearTimeout(timer); timer = setTimeout(function () { RL.q = e.target.value.trim(); apply(); }, 120); });
    $('#rl-csv', el).addEventListener('click', function () { ui.download('results-' + kind + '.csv', ui.toCsv(t.toCsvRows())); });
    apply();
  }

  SB.page('results', {
    render: function (el, params, ctx) {
      var D = ctx.D, perf = D.resultsPerf || {};
      var season = (perf.seasons || [])[0];
      var seasonName = R.seasonOf(perf);
      var pRows = R.perfRows(perf, seasonName), tRows = R.trackerRows(D.resultsTracker, seasonName);
      if (params && params[0] && R.KINDS.some(function (k) { return k.id === params[0]; })) {
        renderList(el, ctx, params[0], perf, pRows, tRows, seasonName);
        return;
      }
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
          linkTile('tracked', 'Stocks tracked', F.int(season.tracked), 'results updated this season') +
          linkTile('tracked', 'Average since results', ui.deltaHtml(season.avg, 2), 'vs close before the result') +
          linkTile('tracked', 'Median since results', ui.deltaHtml(season.median, 2)) +
          linkTile('above', 'Above pre-result price', esc(season.above || '–')) +
          linkTile('soldoff', 'Strong results, sold off', F.int(season.soldOff), 'good numbers, price fell') +
          linkTile('waiting', 'Waiting on screener.in', F.int(tc.Pending), tc['Gave up'] + ' gave up') +
          '</div>';
      }
      var verdicts = (perf.verdicts || []).filter(function (v) { return v.verdict; });
      var vHref = function (v) { return /^(Strong|Mixed|Weak)$/.test(v.verdict) ? '#results/' + v.verdict.toLowerCase() : null; };
      h += '<div class="grid g2">' +
        ui.card('Stocks by results verdict', 'Count of stocks; click a bar for the list',
          ui.bars(verdicts.map(function (v) {
            return { label: v.verdict, value: v.stocks, href: vHref(v), tip: v.verdict + ': ' + F.int(v.stocks) + ' stocks · avg ' + F.pct(v.avg, 2) + ' since results · ' + F.num(v.positive, 0) + '% positive' };
          }))) +
        ui.card('Average move since results, by verdict', 'Strong / Mixed / Weak results; click a bar for the list',
          ui.bars(verdicts.map(function (v) { return { label: v.verdict, value: v.avg, href: vHref(v) }; }), { diverging: true, fmt: function (v) { return F.pct(v, 2); } }) +
          '<div class="legend"><span><i style="background:var(--bar)"></i>Up since results</span><span><i style="background:var(--bar-neg)"></i>Down since results</span></div>') +
        '</div>';
      // when NSE got the results (the PC's NSE announcements): after-market results react the next session
      var ses = R.bySession(pRows), known = ses.some(function (x) { return x.id !== 'unknown' && x.count; });
      var sHref = function (x) { return x.id === 'unknown' ? null : '#results/' + x.id; };
      h += '<div class="grid g2">' +
        ui.card('When the results came out', 'NSE filing time: before 9:15, in market hours, after 3:30 PM (after market: the next session reacts); click a bar for the list',
          known ? ui.bars(ses.filter(function (x) { return x.count; }).map(function (x) {
            return { label: x.label, value: x.count, href: sHref(x),
                     tip: x.label + ': ' + F.int(x.count) + ' stocks · first session ' + (x.avgDay == null ? '–' : F.pct(x.avgDay, 2)) + ' · since results ' + (x.avgSince == null ? '–' : F.pct(x.avgSince, 2)) };
          })) : '<p class="empty">Filing times show here after your PC program sends NSE\'s announcements and the sheet refreshes Results Performance.</p>') +
        ui.card('First-session move, by announcement time', 'Average "Result day %": the first session that could react vs the close before it',
          known ? ui.bars(ses.filter(function (x) { return x.count && x.avgDay != null; }).map(function (x) {
            return { label: x.label, value: x.avgDay, href: sHref(x), tip: x.label + ': avg ' + F.pct(x.avgDay, 2) + ' on the first session (' + F.int(x.count) + ' stocks)' };
          }), { diverging: true, fmt: function (v) { return F.pct(v, 2); } }) : '<p class="empty">Shows once the filing times are known.</p>') +
        '</div>';
      var mv = R.movers(pRows, 5);
      h += '<div class="grid g2">' +
        ui.card('Best since results', 'Top 5 this season · <a href="#results/above">all above the pre-result price →</a>', '<div id="mv-best"></div>') +
        ui.card('Worst since results', 'Bottom 5 this season · <a href="#results/below">all at or below it →</a>', '<div id="mv-worst"></div>') +
        '</div>';
      h += ui.card('Upcoming results (next 30 days)', upcoming.length + ' stocks · from the Main tab Result Date (NSE results calendar in the Results tab, kept up to date by your PC program)', '<div id="up-t"></div>');
      h += ui.card('Results performance', esc(perf.note || '') + ' · FII trend and TTM EPS growth: Main tab', '<div class="controls"><input class="search" id="rp-q" type="search" placeholder="Search symbol or industry" aria-label="Search results performance"><button class="btn" type="button" id="rp-csv">Export CSV</button></div><div id="rp-table"></div>');
      h += '<section class="card"><div class="card-head"><div><h2>Results tracker</h2><p>Every stock whose result date has arrived. Pending = screener.in does not show the new quarter yet (retried every run).</p></div></div>' +
        '<div class="controls">' + ui.chips('rs', [['all', 'All (' + tracker.length + ')'], ['Updated', 'Updated (' + tracker.filter(function (r) { return r.Status === 'Updated'; }).length + ')'],
          ['Pending', 'Pending (' + tracker.filter(function (r) { return r.Status === 'Pending'; }).length + ')'],
          ['Gave up', 'Gave up (' + tracker.filter(function (r) { return r.Status === 'Gave up'; }).length + ')']], RS.status) + '</div>' +
        '<div id="rs-table"></div></section>';
      el.innerHTML = h;

      [['#mv-best', mv.best], ['#mv-worst', mv.worst]].forEach(function (m) {
        new ui.Table({
          rows: m[1], pageSize: 5, tools: false, sort: { key: '% Since Results', dir: m[0] === '#mv-best' ? -1 : 1 }, empty: 'None yet',
          columns: [
            { key: 'Symbol', label: 'Stock', type: 'sym', name: 'Company' },
            { key: 'Result Date', label: 'Result date', type: 'date' },
            { key: 'Results Verdict', label: 'Verdict', type: 'badge' },
            { key: '% Since Results', label: 'Since results', type: 'pct' }
          ]
        }).mount($(m[0], el));
      });

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
          { key: 'Announced', label: 'Announced', title: 'When NSE got the results (IST) and the market session - read by your PC program. Filed after 15:30: the reaction day is the next session.' },
          { key: 'Result Day %', label: 'Result day', type: 'pct', title: 'The first session that could react vs the close before it' },
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
          { key: 'Announced', label: 'Announced', title: 'When NSE got the results (IST) and the market session - read by your PC program' },
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
