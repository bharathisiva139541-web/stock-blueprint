/* Results Today (#today, #today/<status>) - owner, 03-Nov-2026: "a separate dashboard for results due today alone and
   their status". The Main stocks whose Result Date is today, and where each one stands, from the sheet's Results
   Tracker (kept up to date by the PC's results check every 30 minutes: NSE's filing time, NSE XBRL / screener.in /
   moneycontrol figures). Statuses: web/lib/results.js TODAY / todayRows. */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, esc = ui.esc, F = ui.F, $ = ui.$, R = SB.results;
  var ST = { q: '' };
  var ORDER = { final: 0, provisional: 1, filed: 2, notfiled: 3 };

  function statusOf(id) { return R.TODAY.filter(function (s) { return s.id === id; })[0]; }
  function statusBadge(id) {
    var s = statusOf(id);
    return s ? '<span class="badge' + (s.tone ? ' s-' + s.tone : '') + '">' + esc(s.label) + '</span>' : '–';
  }
  function tile(id, label, n, note, on) {
    return '<a class="tile tile-link" href="#today' + (id === 'all' ? '' : '/' + id) + '"' + (on ? ' aria-current="page"' : '') + '>' +
      '<div class="label">' + esc(label) + '</div><div class="value">' + F.int(n) + '</div>' + (note ? '<div class="note2">' + note + '</div>' : '') +
      '<span class="tile-go" aria-hidden="true">→</span></a>';
  }

  SB.page('today', {
    render: function (el, params, ctx) {
      var live = !!(ctx.site && ctx.site.live);
      // the live site: the real day; a saved copy: the day it was saved
      var dayDate = live ? new Date() : ctx.refDate, day = ui.iso(dayDate);
      // Results Performance rows with the site's newer price (owner, 08-Nov-2026: "do whichever we can make as live")
      var perfLive = R.livePerf(ui.objRows((ctx.D.resultsPerf || {}).table), function (sym) {
        var s = ctx.bySym[sym];
        return SB.livePrice && SB.livePrice(s) ? s : null;
      });
      var all = R.todayRows(ctx.stocks, ui.objRows(ctx.D.resultsTracker), day, perfLive).sort(function (a, b) {
        return ORDER[a.status] - ORDER[b.status] || (a.annTime < b.annTime ? -1 : a.annTime > b.annTime ? 1 : 0) || (a.sym < b.sym ? -1 : 1);
      });
      var pick = statusOf(params && params[0]) ? params[0] : 'all';
      var n = { all: all.length };
      R.TODAY.forEach(function (s) { n[s.id] = all.filter(function (r) { return r.status === s.id; }).length; });
      var asOf = live ? ctx.site.readAt || ctx.D.generated : ctx.D.asOf || ctx.D.generated;

      var h = '<div class="page-head"><div><h1>Results Today · ' + F.date(day) + '</h1>' +
        '<p>The Main stocks with their results today and where each one stands. Status from your sheet\'s Results Tracker - your PC\'s ' +
        'results check updates it every 30 minutes (NSE\'s filing time, NSE XBRL / screener.in / moneycontrol figures). Sheet as of ' +
        '<b>' + (asOf ? F.dateTime(asOf) : '–') + '</b>' + (live ? ' (the website copy refreshes every 30 minutes)' : ' - a saved copy') + '.</p></div>' +
        '<div class="actions"><button class="btn" type="button" id="td-refresh">Refresh</button>' +
        (all.length ? '<button class="btn" type="button" id="td-csv">Export CSV</button>' : '') + '</div></div>';

      if (!all.length) {
        var next = null, cnt = 0;
        ctx.stocks.forEach(function (s) {
          var d = String(s.rdate || '').slice(0, 10);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d <= day) return;
          if (!next || d < next) { next = d; cnt = 0; }
          if (d === next) cnt++;
        });
        el.innerHTML = h + '<section class="card"><p class="empty">No Main stock has its results on ' + F.date(day) + '.' +
          (next ? ' Next: <b>' + F.date(next) + '</b> - ' + F.int(cnt) + ' stock' + (cnt === 1 ? '' : 's') + ' (<a href="#results">upcoming results →</a>).' : '') + '</p></section>';
        bindRefresh(el);
        return;
      }

      var inMain = n.final + n.provisional;
      h += '<div class="tiles">' +
        tile('all', 'Due today', n.all, F.int(inMain) + ' of ' + F.int(n.all) + ' in Main', pick === 'all') +
        R.TODAY.map(function (s) {
          var note = s.id === 'final' ? 'screener.in / NSE XBRL' : s.id === 'provisional' ? 'NSE XBRL / screener.in replace them'
            : s.id === 'filed' ? 'NSE has the results' : 'no results filing on NSE yet';
          return tile(s.id, s.label, n[s.id], note, pick === s.id);
        }).join('') + '</div>';
      h += '<section class="card"><nav class="chips td-kinds" aria-label="Results today by status">' +
        [['all', 'All']].concat(R.TODAY.map(function (s) { return [s.id, s.label]; })).map(function (k) {
          return '<a class="chip" href="#today' + (k[0] === 'all' ? '' : '/' + k[0]) + '" aria-pressed="' + (k[0] === pick) + '"' +
            (k[0] === pick ? ' aria-current="page"' : '') + '>' + esc(k[1]) + ' <b>' + F.int(n[k[0]]) + '</b></a>';
        }).join('') + '</nav>' +
        '<div class="controls"><input class="search" id="td-q" type="search" placeholder="Search symbol, company or industry" aria-label="Search today\'s results" value="' + esc(ST.q) + '">' +
        '<span class="count" id="td-count"></span></div><div id="td-t"></div>' +
        '<p class="sub" style="margin-top:8px">Revenue / profit figures, OPM, FII, EPS growth, flags and TTM Signal show once the result is in Main (until then Main still holds last quarter\'s). ' +
        'Daily % / Result day / Since results / Max gain / Max drawdown / Verdict / Reaction: from the Results Performance tab, as on the Results page ' +
        '(rebuilt about every hour while the market is open). Announced = when NSE got the results (after 3:30 PM: the market reacts the next session). ' +
        'Hide the columns you do not need with ▦ Columns.</p></section>';
      el.innerHTML = h;

      var t = new ui.Table({
        id: 'results-today', rows: [], pageSize: 100, empty: 'No stocks with this status',
        columns: [
          { key: 'sym', label: 'Stock', type: 'sym', name: 'name' },
          { key: 'status', label: 'Status', get: function (r) { var s = statusOf(r.status); return s ? s.label : ''; }, html: function (r) { return statusBadge(r.status); } },
          // owner, 03-Nov-2026: "add all columns same as in the results performance table - price is not necessary"
          { key: 'ind', label: 'Industry', wrap: true },
          { key: 'quarter', label: 'Quarter' },
          { key: 'rdate', label: 'Result date', type: 'date' },
          { key: 'announced', label: 'Announced', title: 'When NSE got the results (IST) and the market session - read by your PC program. Filed after 15:30: the reaction day is the next session.' },
          { key: 'dailyPct', label: 'Daily %', type: 'pct',
            title: 'Where the result day closed vs the close before the results - that day\'s % change (during that session: the price now)' },
          { key: 'rdayPct', label: 'Result day', type: 'pct',
            title: 'The intraday move on the result day (the first session that could react): its high or its low vs the close before the results, ' +
              'whichever went further (during that session: so far). Daily % = where it closed.' },
          { key: 'since', label: 'Since results', type: 'pct' },
          { key: 'flags', label: 'Flags', title: 'Result flags (as in the Results Update email); hover or tap a pill for the figures',
            html: function (r) { return ui.flagPills(r.flags) || '<span class="sub">–</span>'; } },
          { key: 'sig', label: 'TTM Signal', type: 'badge' },
          { key: 'maxGain', label: 'Max gain', type: 'pct' },
          { key: 'maxDd', label: 'Max drawdown', type: 'pct' },
          { key: 'yrev', label: 'Rev YoY', type: 'pct', digits: 0 },
          { key: 'ynp', label: 'Profit YoY', type: 'pct', digits: 0 },
          { key: 'qrev', label: 'Rev QoQ', type: 'pct', digits: 0 },
          { key: 'qnp', label: 'Profit QoQ', type: 'pct', digits: 0 },
          { key: 'opmq', label: 'OPM QoQ', type: 'badge', title: 'Operating profit margin trend vs the previous quarter' },
          { key: 'opmy', label: 'OPM YoY', type: 'badge', title: 'Operating profit margin trend, yearly: the last financial year vs the one before (Main "OPM YoY%")' },
          { key: 'opmqy', label: 'OPM Qtr YoY', type: 'badge', title: 'This quarter\'s operating margin vs the same quarter a year ago (Main "OPM Qtr YoY")' },
          { key: 'fii', label: 'FII', type: 'badge', title: 'FII holding trend (Main tab "FII Activity")' },
          { key: 'epsg', label: 'EPS growth', type: 'pct', digits: 0, title: 'TTM EPS growth % (Main tab)' },
          { key: 'verdict', label: 'Verdict', type: 'badge' },
          { key: 'reaction', label: 'Reaction', type: 'badge' },
          // the page's own: where each result stands
          { key: 'source', label: 'Figures from' },
          { key: 'updatedAt', label: 'In Main at', type: 'datetime', title: 'When the figures were written to Main' },
          { key: 'chg', label: 'Today', type: 'pct', digits: 2, title: 'Today\'s % change (Main tab)' },
          { key: 'checks', label: 'Checks', type: 'num', title: 'How many times the results check looked at it' },
          { key: 'note', label: 'Note', wrap: true }
        ]
      }).mount($('#td-t', el));
      var list = all.filter(function (r) { return pick === 'all' || r.status === pick; });
      function apply() {
        var rows = list.filter(function (r) { return ui.textMatch(ST.q, [r.sym, r.name, r.ind]); });
        $('#td-count', el).textContent = F.int(rows.length) + ' of ' + F.int(list.length) + ' stock' + (list.length === 1 ? '' : 's');
        t.setRows(rows);
      }
      var timer;
      $('#td-q', el).addEventListener('input', function (e) { clearTimeout(timer); timer = setTimeout(function () { ST.q = e.target.value.trim(); apply(); }, 120); });
      $('#td-csv', el).addEventListener('click', function () { ui.download('results-today-' + day + '.csv', ui.toCsv(t.toCsvRows())); });
      bindRefresh(el);
      apply();
    }
  });

  // the newest copy of the sheet: the page loads again (the website asks the live feed afresh)
  function bindRefresh(el) {
    var b = $('#td-refresh', el);
    if (b) b.addEventListener('click', function () { window.location.reload(); });
  }
})();
