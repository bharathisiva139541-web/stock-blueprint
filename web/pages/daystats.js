/* Market statistics lists (#daystats/<kind>): the Main stocks behind each tile of the Overview's
   "Market statistics" card - stocks traded, advances, declines, unchanged, at a 52-week high,
   upper / lower circuit - from the sheet's Market Day tab (NSE end-of-day files via the PC bridge).
   Not a tab of its own: reached from the Overview tiles. */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, esc = ui.esc, F = ui.F, isNum = ui.isNum, $ = ui.$;
  var ST = { q: '' };
  var SORT = { declines: { key: 'chg', dir: 1 }, lower: { key: 'chg', dir: 1 }, unchanged: { key: 'sym', dir: 1 } };

  SB.page('daystats', {
    render: function (el, params, ctx) {
      var day = SB.eod.day(ctx.D.marketDay);
      var kinds = SB.eod.KINDS;
      var kind = kinds.some(function (k) { return k[0] === params[0]; }) ? params[0] : 'traded';
      var label = kinds.filter(function (k) { return k[0] === kind; })[0][1];
      var h = '<div class="page-head"><div><p class="sub"><a href="#overview">← Market overview</a></p><h1>Market statistics: ' + esc(label) + '</h1><p>' +
        (day ? 'Your Main stocks on <b>' + F.date(day.date) + '</b> ' + ui.stateBadge('EOD', day.date, 'Market Day tab of your sheet (NSE end-of-day files via your PC bridge)')
          : 'Your Main stocks') + '</p></div>' +
        (day ? '<div class="actions"><button class="btn" type="button" id="ds-csv">Export CSV</button></div>' : '') + '</div>';
      if (!day) {
        el.innerHTML = h + '<section class="card"><p class="empty">Not in this copy of the data yet. Your PC bridge reads NSE\'s end-of-day files each evening ' +
          'and fills the sheet\'s <b>Market Day</b> tab; the lists show here after that.</p></section>';
        return;
      }
      h += '<section class="card"><nav class="chips ds-kinds" aria-label="Market statistics lists">' + kinds.map(function (k) {
        var n = day.counts[k[0]];
        return '<a class="chip" href="#daystats/' + k[0] + '" aria-pressed="' + (k[0] === kind) + '"' + (k[0] === kind ? ' aria-current="page"' : '') + '>' +
          esc(k[1]) + ' <b>' + (isNum(n) ? F.int(n) : '–') + '</b></a>';
      }).join('') + '</nav>' +
        '<div class="controls"><input class="search" id="ds-q" type="search" placeholder="Search symbol or company" aria-label="Search this list" value="' + esc(ST.q) + '">' +
        '<span class="count" id="ds-count"></span></div><div id="ds-t"></div>' +
        (kind === 'high52' ? '<p class="sub" style="margin-top:8px"><a href="#markets/high52">All NSE stocks at a 52-week high →</a></p>' : '') +
        (day.counts[kind] === null ? '<p class="note warn">NSE\'s file for this list was not downloaded that day, so it is not counted.</p>' : '') + '</section>';
      el.innerHTML = h;

      var t = new ui.Table({
        id: 'daystats', rows: [], pageSize: 50, sort: SORT[kind] || { key: 'chg', dir: -1 }, empty: 'No stocks in this list',
        columns: [
          { key: 'sym', label: 'Stock', type: 'sym', name: 'name', csv: function (r) { return r.sym; } },
          { key: 'name', label: 'Company', csvOnly: true },
          { key: 'cat', label: 'Category', wrap: true, get: function (r) { var s = ctx.bySym[r.sym]; return s ? s.catName || null : null; } },
          { key: 'close', label: 'Close', type: 'price' },
          { key: 'chg', label: 'Change', type: 'pct', digits: 2 },
          { key: 'deliv', label: 'Deliv %', type: 'num', digits: 1, title: 'Delivery %: delivered quantity / traded quantity (NSE bhavcopy, EQ series)' },
          { key: 'circuit', label: 'Circuit', get: function (r) { return r.circuit || null; },
            html: function (r) { return r.circuit ? ui.badge(r.circuit + ' circuit', r.circuit === 'Upper' ? 's-good' : 's-bad') : '<span class="sub">–</span>'; } },
          { key: 'new52', label: '52W high', get: function (r) { return r.new52 ? 'New high' : null; },
            html: function (r) { return r.new52 ? ui.badge('New 52W high', 'new52') : '<span class="sub">–</span>'; } }
        ]
      }).mount($('#ds-t', el));
      var list = SB.eod.pick(day.rows, kind);
      function apply() {
        var rows = list.filter(function (r) { return ui.textMatch(ST.q, [r.sym, r.name]); });
        $('#ds-count', el).textContent = F.int(rows.length) + ' of ' + F.int(list.length) + ' stock' + (list.length === 1 ? '' : 's');
        t.setRows(rows);
      }
      var timer;
      $('#ds-q', el).addEventListener('input', function (e) { clearTimeout(timer); timer = setTimeout(function () { ST.q = e.target.value.trim(); apply(); }, 120); });
      $('#ds-csv', el).addEventListener('click', function () { ui.download('market-' + kind + '-' + day.date + '.csv', ui.toCsv(t.toCsvRows())); });
      apply();
    }
  });
})();
