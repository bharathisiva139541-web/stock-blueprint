/* Results & corporate events: results season tracker + performance + upcoming results.
   Every tile and bar opens the list of stocks behind it (#results/<kind>, web/lib/results.js). */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, esc = ui.esc, F = ui.F, $ = ui.$, R = SB.results;
  var RS = { status: 'all' }, RL = { q: '' };
  // the tracker's result flags on Results Performance rows (same stock + quarter)
  // Main's 'OPM Qtr YoY' (this quarter's OPM vs the same quarter a year ago - owner, 03-Nov-2026: in every table of the
  // page) on rows of the newest season; a tracker row not Updated yet shows nothing (Main still holds last quarter's)
  var OPMQY = { key: 'opmqy', label: 'OPM Qtr YoY', type: 'badge',
    title: 'This quarter\'s operating margin vs the same quarter a year ago (Main "OPM Qtr YoY")' };
  // Main's TTM Signal of the stock (owner, 03-Nov-2026: "add TTM signal column in all tables") - the stock's current signal
  var SIG = { key: 'ttmsig', label: 'TTM Signal', type: 'badge', title: 'The stock\'s TTM Signal now (Main tab, follows the price shown)',
    get: function (r) { var s = SB.ctx.bySym[r.Symbol]; return s ? s.sig || null : null; } };
  // owner, 03-Nov-2026: "add daily % to the left of result day, and use intraday movement as result day % - VRL Logistics
  // should show 14.5% instead of 6%" (no new sheet columns): Result day = the sheet's Result Day % (the reaction session's
  // high or low vs the close before the results, whichever went further); Daily % = where that session closed = Result
  // Day Close vs Pre-Result Close (during the session, Result Day Close still empty: the price now)
  var DAILY = { key: 'dailyPct', label: 'Daily %', type: 'pct',
    title: 'Where the result day closed vs the close before the results - that day\'s % change (during that session: the price now)',
    get: function (r) { return R.dailyPct(r); } };
  var RDAY = { key: 'Result Day %', label: 'Result day', type: 'pct',
    title: 'The intraday move on the result day (the first session that could react): its high or its low vs the close before the results, ' +
      'whichever went further (during that session: so far). Daily % = where it closed.' };
  function withOpm(rows, ctx, season, qKey) {
    rows.forEach(function (r) {
      var s = ctx.bySym[r.Symbol];
      var ok = s && (!season || String(r[qKey]) === season) && (qKey !== 'Quarter Expected' || r.Status === 'Updated');
      r.opmqy = ok ? s.opmqy || null : null;
    });
    return rows;
  }
  function withFlags(rows, D) {
    var ix = R.flagIndex(ui.objRows(D.resultsTracker));
    return rows.map(function (r) { if (r.Flags === undefined) r.Flags = ix[r.Symbol + '|' + r.Quarter] || ''; return r; });
  }

  function linkTile(kind, label, value, note) {
    return '<a class="tile tile-link" href="#results/' + kind + '"><div class="label">' + esc(label) + '</div><div class="value">' + value + '</div>' +
      (note ? '<div class="note2">' + note + '</div>' : '') + '<span class="tile-go" aria-hidden="true">→</span></a>';
  }

  // "fell after results, then back above" needs the daily closes: loaded on demand, then the part is drawn again
  function withCandles(el, ctx, then) {
    if (ctx.history) return true;
    SB.loadHistory().then(function () { if (el.isConnected) then(); }, function (e) {
      if (el.isConnected) { var x = $('#rc-body', el); if (x) x.innerHTML = '<p class="empty">Daily prices could not be loaded: ' + esc(e && e.message || e) + '</p>'; }
    });
    return false;
  }
  var RC_HELP = 'Closed at least ' + R.RECLAIM.minDipPct + '% below the close before the results, then closed back above it - ' +
    'and the latest close is still above. Daily closes from the session that could first react (after-market results: the next session).';

  /** #results/<kind>: the stocks behind one tile / bar. */
  function renderList(el, ctx, kind, perf, pRows, tRows, seasonName) {
    var K = R.KINDS.filter(function (k) { return k.id === kind; })[0];
    var rc = ctx.history ? R.reclaimRows(pRows, ctx.history) : null;
    if (K.src === 'reclaim' && !rc) {
      el.innerHTML = '<p class="sub"><a href="#results">← Results &amp; corporate events</a></p><h1>' + esc(K.label) + '</h1>' + ui.skeleton(6) +
        '<div id="rc-body"></div>';
      withCandles(el, ctx, function () { renderList(el, ctx, kind, perf, pRows, tRows, seasonName); });
      return;
    }
    var n = R.counts(pRows, tRows, rc);
    var src = K.src === 'tracker' ? 'Results Tracker' : 'Results Performance';
    el.innerHTML = '<div class="page-head"><div><p class="sub"><a href="#results">← Results &amp; corporate events</a></p><h1>' + esc(K.label) + '</h1><p>' +
      (seasonName ? esc(seasonName) + ' season · ' : '') + 'from your sheet\'s ' + src + ' tab ' + ui.stateBadge('CACHED', perf.asOf || ctx.D.asOf, src + ' tab') + '</p></div>' +
      '<div class="actions"><button class="btn" type="button" id="rl-csv">Export CSV</button></div></div>' +
      '<section class="card"><nav class="chips rl-kinds" aria-label="Results lists">' + R.KINDS.filter(function (k) { return n[k.id] || k.id === kind; }).map(function (k) {
        return '<a class="chip" href="#results/' + k.id + '" aria-pressed="' + (k.id === kind) + '"' + (k.id === kind ? ' aria-current="page"' : '') + '>' +
          esc(k.label) + ' <b>' + F.int(n[k.id]) + '</b></a>';
      }).join('') + '</nav>' +
      (K.src === 'reclaim' ? '<p class="sub">' + esc(RC_HELP) + ' "Back above after 2+ weeks" = it closed back above on the ' + R.RECLAIM.slowDays +
        'th session after the results or later; "close to" = still below, within ' + R.RECLAIM.nearPct + '% of it and ' + R.RECLAIM.bouncePct +
        '% or more up from its lowest close. Closes up to ' + F.date(rc.length ? rc[0].reclaim.nowDate : null) + '.</p>' : '') +
      '<div class="controls"><input class="search" id="rl-q" type="search" placeholder="Search symbol, company or industry" aria-label="Search this list" value="' + esc(RL.q) + '">' +
      '<span class="count" id="rl-count"></span></div><div id="rl-t"></div></section>';
    var cols = K.src === 'reclaim' ? [
      { key: 'Symbol', label: 'Stock', type: 'sym', name: 'Company' },
      { key: 'Result Date', label: 'Result date', type: 'date' },
      { key: 'Pre-Result Close', label: 'Pre-result close', type: 'price' },
      { key: 'lowPct', label: 'Fell to', type: 'pct', digits: 1, title: 'The lowest close after the results vs the pre-result close' },
      { key: 'lowDay', label: 'Low on session', type: 'num', title: 'Session number after the results of the lowest close' },
      { key: 'reclaimDay', label: 'Back above on session', type: 'num', title: 'The first close back above the pre-result close after the low (session number after the results)' },
      { key: 'reclaimDate', label: 'Back above on', type: 'date' },
      { key: 'nowPct', label: 'Now vs pre-result', type: 'pct', digits: 1, title: 'Latest close vs the pre-result close' },
      { key: 'trend', label: 'Trend', type: 'badge', title: 'Rising = the latest close is within 2% of its highest close since it climbed back; Holding = still above the pre-result close but pulled back from that high' },
      { key: 'sessions', label: 'Sessions since', type: 'num' },
      { key: 'Results Verdict', label: 'Verdict', type: 'badge' },
      { key: 'Flags', label: 'Flags', title: 'Result flags (as in the Results Update email); hover or tap a pill for the figures', get: function (r) { return r.Flags || ''; }, html: function (r) { return ui.flagPills(r.Flags) || '<span class="sub">–</span>'; } },
      SIG,
      { key: 'Rev YoY %', label: 'Rev YoY', type: 'pct', digits: 0 },
      { key: 'NP YoY %', label: 'Profit YoY', type: 'pct', digits: 0 },
      OPMQY
    ] : K.src === 'perf' ? [
      { key: 'Symbol', label: 'Stock', type: 'sym', name: 'Company' },
      { key: 'Basic Industry', label: 'Industry', wrap: true },
      { key: 'Result Date', label: 'Result date', type: 'date' },
      { key: 'Announced', label: 'Announced', title: 'When NSE got the results (IST) and the market session' },
      DAILY,
      RDAY,
      { key: '% Since Results', label: 'Since results', type: 'pct' },
      { key: 'Flags', label: 'Flags', title: 'Result flags (as in the Results Update email); hover or tap a pill for the figures', get: function (r) { return r.Flags || ''; }, html: function (r) { return ui.flagPills(r.Flags) || '<span class="sub">–</span>'; } },
      SIG,
      { key: 'Max Gain %', label: 'Max gain', type: 'pct' },
      { key: 'Max Drawdown %', label: 'Max drawdown', type: 'pct' },
      { key: 'Results Verdict', label: 'Verdict', type: 'badge' },
      { key: 'Market Reaction', label: 'Reaction', type: 'badge' },
      { key: 'Signal', label: 'Signal', wrap: true },
      { key: 'Rev YoY %', label: 'Rev YoY', type: 'pct', digits: 0 },
      { key: 'NP YoY %', label: 'Profit YoY', type: 'pct', digits: 0 },
      OPMQY
    ] : [
      { key: 'Symbol', label: 'Stock', type: 'sym', name: 'Company' },
      { key: 'Result Date', label: 'Result date', type: 'date' },
      { key: 'Announced', label: 'Announced' },
      { key: 'Quarter Expected', label: 'Expected' },
      { key: 'Screener Latest Quarter', label: 'Screener shows' },
      { key: 'Status', label: 'Status', type: 'badge' },
      { key: 'Flags', label: 'Flags', title: 'Result flags (as in the Results Update email); hover or tap a pill for the figures', get: function (r) { return r.Flags || ''; }, html: function (r) { return ui.flagPills(r.Flags) || '<span class="sub">–</span>'; } },
      SIG,
      OPMQY,
      { key: 'Checks', label: 'Checks', type: 'num', get: function (r) { return r.Checks == null ? null : +r.Checks; } },
      { key: 'Last Checked', label: 'Last checked', type: 'datetime' },
      { key: 'Note', label: 'Note', wrap: true }
    ];
    var t = new ui.Table({ id: 'results-list-' + K.src, rows: [], pageSize: 50, sort: K.sort, empty: 'No stocks in this list', columns: cols }).mount($('#rl-t', el));
    var list = R.pick(kind, pRows, tRows, rc);
    if (K.src !== 'tracker') withFlags(list, ctx.D);
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
      var pRows = withOpm(R.perfRows(perf, seasonName), ctx, seasonName, 'Quarter');
      var tRows = withOpm(R.trackerRows(D.resultsTracker, seasonName), ctx, seasonName, 'Quarter Expected');
      if (params && params[0] && R.KINDS.some(function (k) { return k.id === params[0]; })) {
        renderList(el, ctx, params[0], perf, pRows, tRows, seasonName);
        return;
      }
      var tracker = withOpm(ui.objRows(D.resultsTracker), ctx, seasonName, 'Quarter Expected');
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
        ui.card('First-session move, by announcement time', 'Average "Result day": the intraday move of the first session that could react - its high or low vs the close before it, whichever went further',
          known ? ui.bars(ses.filter(function (x) { return x.count && x.avgDay != null; }).map(function (x) {
            return { label: x.label, value: x.avgDay, href: sHref(x), tip: x.label + ': avg ' + F.pct(x.avgDay, 2) + ' on the first session (' + F.int(x.count) + ' stocks)' };
          }), { diverging: true, fmt: function (v) { return F.pct(v, 2); } }) : '<p class="empty">Shows once the filing times are known.</p>') +
        '</div>';
      var mv = R.movers(pRows, 5);
      h += '<div class="grid g2">' +
        ui.card('Best since results', 'Top 5 this season · <a href="#results/above">all above the pre-result price →</a>', '<div id="mv-best"></div>') +
        ui.card('Worst since results', 'Bottom 5 this season · <a href="#results/below">all at or below it →</a>', '<div id="mv-worst"></div>') +
        '</div>';
      // the owner's friend's idea (03-Nov-2026): fell below the pre-results price, then climbed back above it
      h += ui.card('Fell after results, then back above', esc(RC_HELP) + ' Click a number for the list.', '<div id="rc-body">' + ui.skeleton(2) + '</div>');
      h += ui.card('Upcoming results (next 30 days)', upcoming.length + ' stocks · from the Main tab Result Date (NSE results calendar in the Results tab, kept up to date by your PC program)', '<div id="up-t"></div>');
      h += ui.card('Results performance', esc(perf.note || '') + ' · FII trend and TTM EPS growth: Main tab', '<div class="controls"><input class="search" id="rp-q" type="search" placeholder="Search symbol or industry" aria-label="Search results performance"><button class="btn" type="button" id="rp-csv">Export CSV</button></div><div id="rp-table"></div>');
      h += '<section class="card"><div class="card-head"><div><h2>Results tracker</h2><p>Every stock whose result date has arrived. Pending = screener.in does not show the new quarter yet (retried every run).</p></div></div>' +
        '<div class="controls">' + ui.chips('rs', [['all', 'All (' + tracker.length + ')'], ['Updated', 'Updated (' + tracker.filter(function (r) { return r.Status === 'Updated'; }).length + ')'],
          ['Pending', 'Pending (' + tracker.filter(function (r) { return r.Status === 'Pending'; }).length + ')'],
          ['Gave up', 'Gave up (' + tracker.filter(function (r) { return r.Status === 'Gave up'; }).length + ')']], RS.status) + '</div>' +
        '<div id="rs-table"></div></section>';
      el.innerHTML = h;

      var drawReclaim = function () {
        var rc = R.reclaimRows(pRows, ctx.history), n = R.counts(pRows, tRows, rc);
        var fell = rc.filter(function (r) { return r.reclaim.status !== 'held'; }).length;
        $('#rc-body', el).innerHTML = '<div class="tiles">' +
          linkTile('reclaimed', 'Back above now', F.int(n.reclaimed), F.int(fell) + ' of ' + F.int(rc.length) + ' fell ' + R.RECLAIM.minDipPct + '%+ below') +
          linkTile('reclaimslow', 'Back above after 2+ weeks', F.int(n.reclaimslow), 'climbed back on session ' + R.RECLAIM.slowDays + ' or later') +
          linkTile('nearreclaim', 'Close to it (still below)', F.int(n.nearreclaim), 'within ' + R.RECLAIM.nearPct + '%, bouncing off the low') +
          '</div>' + (rc.length < pRows.length ? '<p class="sub">' + F.int(pRows.length - rc.length) + ' stock(s) have no daily prices on the site.</p>' : '');
      };
      if (withCandles(el, ctx, drawReclaim)) drawReclaim();

      [['#mv-best', mv.best], ['#mv-worst', mv.worst]].forEach(function (m) {
        new ui.Table({
          rows: m[1], pageSize: 5, tools: false, sort: { key: '% Since Results', dir: m[0] === '#mv-best' ? -1 : 1 }, empty: 'None yet',
          columns: [
            { key: 'Symbol', label: 'Stock', type: 'sym', name: 'Company' },
            { key: 'Result Date', label: 'Result date', type: 'date' },
            { key: 'Results Verdict', label: 'Verdict', type: 'badge' },
            { key: '% Since Results', label: 'Since results', type: 'pct' },
            SIG,
            OPMQY
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
          { key: 'qnp', label: 'Last Profit QoQ', type: 'pct', digits: 0 },
          { key: 'opmqy', label: 'Last OPM Qtr YoY', type: 'badge', title: 'The last reported quarter\'s operating margin vs the same quarter a year before (Main "OPM Qtr YoY")' }
        ]
      }).mount($('#up-t', el));

      // FII trend and TTM EPS growth are not in the Results Performance tab: take them from Main
      var perfRows = withOpm(withFlags(ui.objRows(perf.table), D), ctx, seasonName, 'Quarter').map(function (r) {
        var s = ctx.bySym[r.Symbol];
        r.fiiTrend = s ? s.fii : null;
        r.epsGrowth = s ? s.epsg : null;
        return r;
      });
      // legacyKeys: the columns before 03-Nov-2026 - the viewer's saved sort & filter of this table are kept
      var pt = new ui.Table({
        rows: perfRows, pageSize: 25, sort: { key: '% Since Results', dir: -1 }, id: 'results-performance',
        legacyKeys: ['Symbol', 'Basic Industry', 'Quarter', 'Result Date', 'Announced', 'Result Day %', '% Since Results', 'Flags', 'Max Gain %',
          'Max Drawdown %', 'Rev YoY %', 'NP YoY %', 'Rev QoQ %', 'NP QoQ %', 'OPM QoQ', 'OPM YoY', 'opmqy', 'fiiTrend', 'epsGrowth', 'Results Verdict', 'Market Reaction'],
        columns: [
          { key: 'Symbol', label: 'Stock', type: 'sym', name: 'Company' },
          { key: 'Basic Industry', label: 'Industry', wrap: true },
          { key: 'Quarter', label: 'Quarter' },
          { key: 'Result Date', label: 'Result date', type: 'date' },
          { key: 'Announced', label: 'Announced', title: 'When NSE got the results (IST) and the market session - read by your PC program. Filed after 15:30: the reaction day is the next session.' },
          DAILY,
          RDAY,
          { key: '% Since Results', label: 'Since results', type: 'pct' },
          { key: 'Flags', label: 'Flags', title: 'Result flags (as in the Results Update email); hover or tap a pill for the figures', get: function (r) { return r.Flags || ''; }, html: function (r) { return ui.flagPills(r.Flags) || '<span class="sub">–</span>'; } },
          SIG,
          { key: 'Max Gain %', label: 'Max gain', type: 'pct' },
          { key: 'Max Drawdown %', label: 'Max drawdown', type: 'pct' },
          { key: 'Rev YoY %', label: 'Rev YoY', type: 'pct', digits: 0 },
          { key: 'NP YoY %', label: 'Profit YoY', type: 'pct', digits: 0 },
          { key: 'Rev QoQ %', label: 'Rev QoQ', type: 'pct', digits: 0 },
          { key: 'NP QoQ %', label: 'Profit QoQ', type: 'pct', digits: 0 },
          { key: 'OPM QoQ', label: 'OPM QoQ', type: 'badge', title: 'Operating profit margin trend vs the previous quarter' },
          { key: 'OPM YoY', label: 'OPM YoY', type: 'badge', title: 'Operating profit margin trend, yearly: the last financial year vs the one before (Main "OPM YoY%")' },
          OPMQY,
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
        rows: [], pageSize: 25, sort: { key: 'Result Date', dir: -1 }, id: 'results-tracker',
        legacyKeys: ['Symbol', 'Result Date', 'Announced', 'Quarter Expected', 'Screener Latest Quarter', 'Status', 'Flags', 'opmqy', 'Checks', 'Last Checked', 'Note'],
        columns: [
          { key: 'Symbol', label: 'Stock', type: 'sym', name: 'Company' },
          { key: 'Result Date', label: 'Result date', type: 'date' },
          { key: 'Announced', label: 'Announced', title: 'When NSE got the results (IST) and the market session - read by your PC program' },
          { key: 'Quarter Expected', label: 'Expected' },
          { key: 'Screener Latest Quarter', label: 'Screener shows' },
          { key: 'Status', label: 'Status', type: 'badge' },
          { key: 'Flags', label: 'Flags', title: 'Result flags (as in the Results Update email); hover or tap a pill for the figures', get: function (r) { return r.Flags || ''; }, html: function (r) { return ui.flagPills(r.Flags) || '<span class="sub">–</span>'; } },
          SIG,
          OPMQY,
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
