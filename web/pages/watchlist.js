/* Watchlist: every stock of the Main tab, with strategy status and notes. */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, esc = ui.esc, F = ui.F, isNum = ui.isNum, $ = ui.$;
  var ST = { q: '', sector: '', cat: '', f: 'all' };

  SB.page('watchlist', {
    render: function (el, params, ctx) {
      var stocks = ctx.stocks;
      var cats = {};
      stocks.forEach(function (s) { cats[s.cat || ''] = (cats[s.cat || ''] || 0) + 1; });
      var notes = ui.store.get('notes', {});
      var strat = SB.strategyResults ? SB.strategyResults(ctx) : null;

      var h = '<div class="page-head"><div><h1>Watchlist</h1><p>All ' + F.int(stocks.length) +
        ' stocks from the Main tab (NSE). Click a symbol for details; click a column to sort. Prices: ' +
        ui.stateBadge(ctx.market.state, ctx.market.asOf, ctx.market.source) + '</p></div>' +
        '<div class="actions"><button class="btn" type="button" id="wl-csv">Export CSV</button></div></div>';
      h += '<section class="card"><div class="controls">' +
        '<input class="search" id="wl-q" type="search" placeholder="Search symbol, company or industry" aria-label="Search stocks" value="' + esc(ST.q) + '">' +
        '<select class="sel" id="wl-cat" aria-label="Industry category"><option value="">All categories</option>' +
        SB.classify.CATEGORIES.filter(function (c) { return cats[c.id]; }).map(function (c) {
          return '<option value="' + c.id + '"' + (ST.cat === c.id ? ' selected' : '') + '>' + esc(c.name) + ' (' + cats[c.id] + ')</option>';
        }).join('') + (cats[''] ? '<option value="none"' + (ST.cat === 'none' ? ' selected' : '') + '>Unclassified (' + cats[''] + ')</option>' : '') +
        '</select></div>' +
        '<div class="controls">' + ui.chips('wl', [
          ['all', 'All'], ['qualified', 'Strategy: qualified'], ['buy', 'TTM Buy'], ['pattern', 'Has pattern'], ['fvg', 'Has FVG'],
          ['ema', 'EMA support'], ['results', 'Result due ≤14 days'], ['done', 'Results ticked'], ['near', 'Within 10% of 52W high'], ['notes', 'With notes']
        ], ST.f) + '<span class="count" id="wl-count"></span></div>' +
        '<div id="wl-table"></div></section>';
      el.innerHTML = h;

      var t = new ui.Table({
        rows: [], pageSize: 50, sort: { key: 'chg', dir: -1 }, empty: 'No stocks match these filters',
        columns: [
          { key: 'sym', label: 'Stock', type: 'sym', name: 'name', csv: function (r) { return r.sym; } },
          { key: 'name', label: 'Company', csvOnly: true },
          { key: 'catName', label: 'Category', wrap: true },
          { key: 'ind', label: 'Basic industry', wrap: true },
          { key: 'price', label: 'Price', type: 'price' },
          { key: 'chg', label: 'Today', type: 'pct', digits: 2 },
          { key: 'd10', label: '10D', type: 'pct' },
          { key: 'd30', label: '30D', type: 'pct' },
          { key: 'down52', label: 'From 52W high', type: 'pct' },
          { key: 'pevs', label: 'PE / Ind PE', type: 'num', title: 'PE ratio divided by industry PE' },
          { key: 'sig', label: 'TTM Signal', type: 'badge' },
          { key: 'strat', label: 'Strategy', get: function (r) { var x = strat && strat.bySym[r.sym]; return x ? x.statusLabel : null; },
            html: function (r) { var x = strat && strat.bySym[r.sym]; return x ? ui.badge(x.statusLabel) : '<span class="sub">–</span>'; } },
          { key: 'pat', label: 'Pattern', wrap: true },
          { key: 'rdate', label: 'Result date', type: 'date' },
          { key: 'note', label: 'Note', wrap: true, get: function (r) { return notes[r.sym] || null; } }
        ]
      }).mount($('#wl-table', el));

      function apply() {
        var rows = stocks.filter(function (s) {
          if (ST.cat === 'none' ? s.cat : ST.cat && s.cat !== ST.cat) return false;
          if (!ui.textMatch(ST.q, [s.sym, s.name, s.ind, s.sector, s.catName])) return false;
          switch (ST.f) {
            case 'qualified': return !!(strat && strat.bySym[s.sym] && strat.bySym[s.sym].qualified);
            case 'buy': return s.sig === 'Buy';
            case 'pattern': return !!s.pat;
            case 'fvg': return !!s.fvg;
            case 'ema': return !!(s.e10 || s.e21);
            case 'done': return s.done === true;
            case 'near': return isNum(s.down52) && s.down52 >= -10;
            case 'notes': return !!notes[s.sym];
            case 'results':
              var d = ui.parseDate(s.rdate);
              if (!d) return false;
              var dd = ui.dayDiff(d, ctx.refDate);
              return dd >= 0 && dd <= 14;
          }
          return true;
        });
        $('#wl-count', el).textContent = F.int(rows.length) + ' stocks';
        t.setRows(rows);
      }
      var timer;
      $('#wl-q', el).addEventListener('input', function (e) {
        clearTimeout(timer);
        timer = setTimeout(function () { ST.q = e.target.value.trim(); apply(); }, 120);
      });
      $('#wl-cat', el).addEventListener('change', function (e) { ST.cat = e.target.value; apply(); });
      $('#wl-csv', el).addEventListener('click', function () { ui.download('watchlist.csv', ui.toCsv(t.toCsvRows())); });
      ui.bindChips(el, 'wl', function (v) { ST.f = v; apply(); });
      apply();
    }
  });
})();
