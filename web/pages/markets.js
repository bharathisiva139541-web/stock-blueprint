/* IPOs & markets: indices, IPO tracker, new listings, NSE price band changes. */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, isNum = ui.isNum, $ = ui.$;

  SB.page('markets', {
    render: function (el, params, ctx) {
      var D = ctx.D, ipos = ui.objRows(D.ipos);
      var h = '<div class="page-head"><div><h1>IPOs &amp; markets</h1><p>NSE indices, listed IPOs and their bases, the latest listings and NSE price band changes. ' +
        ui.stateBadge('CACHED', D.asOf, 'Sheet snapshot') + '</p></div></div>';
      h += ui.card('Indices', 'Day change and distance from all-time high (Indextracker tab)', '<div id="mk-idx"></div>');
      h += '<section class="card"><div class="card-head"><div><h2>IPO tracker</h2><p>' + ipos.length + ' IPOs · price vs listing price and IPO base</p></div></div>' +
        '<div class="controls"><input class="search" id="ipo-q" type="search" placeholder="Search IPO symbol or base status" aria-label="Search IPOs">' +
        ui.chips('ipo', [['all', 'All'], ['Above', 'Above IPO price'], ['Below', 'Below IPO price']], 'all') + '</div><div id="ipo-t"></div></section>';
      h += '<div class="grid g2">' +
        ui.card('New listings', 'Latest NSE listings', '<div id="ipo-new"></div>') +
        ui.card('Price band changes', 'NSE circuit band revisions', '<div id="pb-t"></div>') + '</div>';
      el.innerHTML = h;

      new ui.Table({
        rows: ui.objRows(D.indices), pageSize: 40, sort: { key: 'Day change', dir: -1 },
        columns: [
          { key: 'NSE Symbol', label: 'Index', get: function (r) { return String(r['NSE Symbol'] || '').replace(/_/g, ' '); } },
          { key: 'Current Price', label: 'Level', type: 'price' },
          { key: 'Day change', label: 'Today', type: 'pct', digits: 2 },
          { key: 'Drop from all time high', label: 'From ATH', type: 'pct' },
          { key: '1 year returns', label: '1Y', type: 'pct' },
          { key: '5Y returns', label: '5Y', type: 'pct', digits: 0 },
          { key: '10Y returns', label: '10Y', type: 'pct', digits: 0 }
        ]
      }).mount($('#mk-idx', el));

      var it = new ui.Table({
        rows: [], pageSize: 25, sort: { key: 'LISTING DATE', dir: -1 },
        columns: [
          { key: 'NSE SYMBOL', label: 'Stock', type: 'sym' },
          { key: 'LISTING DATE', label: 'Listed', type: 'date' },
          { key: 'LISTING PRICE', label: 'Listing price', type: 'price' },
          { key: 'MarketPrice', label: 'Price', type: 'price' },
          { key: '% change', label: 'Today', type: 'pct', digits: 2 },
          { key: '% Down/up from Listing Price', label: 'vs listing', type: 'pct' },
          { key: 'IPO Base', label: 'IPO base', type: 'price' },
          { key: '% to IPO Base', label: 'vs base', type: 'pct' },
          { key: 'Base Status', label: 'Base status', wrap: true }
        ]
      }).mount($('#ipo-t', el));
      var iq = '', iF = 'all';
      function applyIpo() {
        it.setRows(ipos.filter(function (r) {
          if (iF !== 'all' && r['Below or Above IPO price'] !== iF) return false;
          return ui.textMatch(iq, [r['NSE SYMBOL'], r['Base Status']]);
        }));
      }
      $('#ipo-q', el).addEventListener('input', function (e) { iq = e.target.value.trim(); applyIpo(); });
      ui.bindChips(el, 'ipo', function (v) { iF = v; applyIpo(); });
      applyIpo();

      new ui.Table({
        rows: ui.objRows(D.newIpos), pageSize: 15, sort: { key: 'DATE OF LISTING', dir: -1 },
        columns: [
          { key: 'Symbol', label: 'Stock', type: 'sym', name: 'COMPANY NAME' },
          { key: 'SECURITY TYPE', label: 'Series' },
          { key: 'DATE OF LISTING', label: 'Listed', type: 'date' }
        ]
      }).mount($('#ipo-new', el));
      new ui.Table({
        rows: ui.objRows(D.priceBands), pageSize: 15, sort: { key: 'Effective (next weekday)', dir: -1 },
        columns: [
          { key: 'Symbol', label: 'Stock', type: 'sym', name: 'Company' },
          { key: 'Effective (next weekday)', label: 'Effective', type: 'date' },
          { key: 'band', label: 'Band', get: function (r) { return (isNum(r['From %']) ? r['From %'] : '?') + '% → ' + (isNum(r['To %']) ? r['To %'] : '?') + '%'; } },
          { key: 'Impact', label: 'Impact', type: 'badge' }
        ]
      }).mount($('#pb-t', el));
    }
  });
})();
