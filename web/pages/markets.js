/* IPOs & markets: IPO Tracker (mainboard IPOs open / closed - awaiting listing / upcoming,
   from NSE via the PC bridge and the sheet's IPO Tracker tab), NSE price band changes,
   indices, listed IPOs and their bases, new listings. */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, esc = ui.esc, F = ui.F, isNum = ui.isNum, $ = ui.$;
  var PB = { view: 'latest', f: 'all', q: '' };

  var SECTIONS = [['open', 'Open now', 'Open for subscription today'], ['closed', 'Closed - awaiting listing', 'Subscription closed, not listed yet'],
    ['upcoming', 'Upcoming', 'Opens on a later day']];

  /** 'Updated 2026-10-27 08:28 IST ...' -> '2026-10-27 08:28' */
  function updatedAt(note) { var m = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/.exec(note || ''); return m ? m[1] : null; }
  function sharesFmt(v) { return isNum(v) ? Math.round(v).toLocaleString('en-IN') : '–'; }

  function ipoTrackerCard(D) {
    var T = D.ipoTracker;
    if (!T) {
      return ui.card('IPO tracker - mainboard IPOs', 'Open now, closed - awaiting listing, upcoming',
        '<p class="empty">Not in this copy of the data yet. The sheet\'s <b>IPO Tracker</b> tab is filled from NSE by your PC bridge; ' +
        'the website shows it once the live feed (or the next saved copy) includes that tab.</p>');
    }
    var at = updatedAt(T.note);
    var h = '<section class="card" id="ipot"><div class="card-head"><div><h2>IPO tracker - mainboard IPOs</h2><p>' +
      'Equity IPOs on NSE, SME and debt issues left out. Dates from NSE, read by your PC ' +
      ui.stateBadge('CACHED', at, 'IPO Tracker tab (NSE via the PC bridge)') + '. Unofficial summary - check the offer document before applying.</p></div></div>';
    if (T.warning) h += '<div class="note warn">' + esc(T.warning) + '</div>';
    h += '<div class="tiles">' + SECTIONS.map(function (s) {
      var n = (T[s[0]] && T[s[0]].rows || []).length;
      return ui.tile(s[1], F.int(n), esc(s[2]));
    }).join('') + '</div>';
    SECTIONS.forEach(function (s) {
      h += '<h3 class="ix-h3" style="margin-top:14px">' + esc(s[1]) + ' (' + F.int((T[s[0]] && T[s[0]].rows || []).length) + ')</h3><div id="ipot-' + s[0] + '"></div>';
    });
    return h + '</section>';
  }
  function mountIpoTracker(el, D) {
    var T = D.ipoTracker;
    if (!T) return;
    SECTIONS.forEach(function (s) {
      var rows = ui.objRows(T[s[0]] || { cols: [], rows: [] });
      var cols = [
        { key: 'Company', label: 'Company', wrap: true, html: function (r) {
          return '<b>' + esc(r.Company || r.Symbol || '–') + '</b>' + (r.Symbol ? '<span class="co">' + esc(r.Symbol) + '</span>' : '');
        } },
        { key: 'Opens', label: 'Opens', type: 'date' },
        { key: 'Closes', label: 'Closes', type: 'date' }
      ];
      if (s[0] === 'closed') cols.push({ key: 'Listing date', label: 'Listing', type: 'date' });
      cols.push(
        { key: 'Price range', label: 'Price range' },
        { key: 'Issue size (shares)', label: 'Issue size (shares)', type: 'num', html: function (r) { return sharesFmt(r['Issue size (shares)']); } },
        { key: 'Note', label: 'Note', wrap: true }
      );
      new ui.Table({
        rows: rows, pageSize: 20, sort: { key: s[0] === 'upcoming' ? 'Opens' : s[0] === 'open' ? 'Closes' : 'Listing date', dir: 1 },
        empty: 'None', columns: cols
      }).mount($('#ipot-' + s[0], el));
    });
  }

  function priceBandCard() {
    return '<section class="card" id="pb"><div class="card-head"><div><h2>NSE price band changes</h2><p id="pb-sum"></p></div></div>' +
      '<div class="controls"><input class="search" id="pb-q" type="search" placeholder="Search symbol or company" aria-label="Search price band changes" value="' + esc(PB.q) + '">' +
      ui.chips('pbv', [['latest', 'Latest day'], ['all', 'All days']], PB.view) +
      ui.chips('pbf', [['all', 'All'], ['main', 'In your watchlist'], ['up', 'Widened'], ['down', 'Tightened']], PB.f) +
      '<span class="count" id="pb-count"></span></div><div id="pb-t"></div>' +
      '<p class="sub" style="margin-top:8px">A wider band (e.g. 5% → 20%) gives the stock more room to move - usually read as positive; a tighter band (20% → 5%) usually means surveillance. ' +
      'Source: NSE\'s daily "Price Band changes from next trade date" file, filed on the sheet\'s Price Band Changes tab.</p></section>';
  }
  function mountPriceBands(el, D) {
    var all = ui.objRows(D.priceBands);
    var latest = all.reduce(function (m, r) { var d = r['Effective (next weekday)'] || ''; return d > m ? d : m; }, '');
    var day = all.filter(function (r) { return (r['Effective (next weekday)'] || '') === latest; });
    function kind(r) { return /^widened/i.test(r.Impact || '') ? 'up' : /^tightened/i.test(r.Impact || '') ? 'down' : 'chg'; }
    var inMain = day.filter(function (r) { return r['In Main'] === 'Yes'; }).length;
    $('#pb-sum', el).innerHTML = latest ? 'Bands from <b>' + F.date(latest) + '</b>: ' + F.int(day.length) + ' change' + (day.length === 1 ? '' : 's') + ' · ' +
      '<span class="up">' + F.int(day.filter(function (r) { return kind(r) === 'up'; }).length) + ' widened</span> · ' +
      '<span class="down">' + F.int(day.filter(function (r) { return kind(r) === 'down'; }).length) + ' tightened</span> · ' +
      F.int(inMain) + ' in your watchlist (Main) ' + ui.stateBadge('CACHED', D.generated || D.asOf, 'Price Band Changes tab of your sheet') : 'No price band changes in this copy of the data.';
    var t = new ui.Table({
      rows: [], pageSize: 20, sort: { key: 'Effective (next weekday)', dir: -1 }, empty: 'No price band changes match',
      columns: [
        { key: 'Symbol', label: 'Stock', type: 'sym', name: 'Company' },
        { key: 'Company', label: 'Company', csvOnly: true },
        { key: 'Effective (next weekday)', label: 'Effective', type: 'date' },
        { key: 'Report Date', label: 'Report date', type: 'date' },
        { key: 'band', label: 'Band', get: function (r) { return isNum(r['To %']) ? r['To %'] : null; },
          html: function (r) { return (isNum(r['From %']) ? r['From %'] + '%' : '?') + ' → <b>' + (isNum(r['To %']) ? r['To %'] + '%' : '?') + '</b>'; } },
        { key: 'Impact', label: 'Impact', type: 'badge' },
        { key: 'In Main', label: 'Watchlist', get: function (r) { return r['In Main'] === 'Yes' ? 'Yes' : null; } }
      ]
    }).mount($('#pb-t', el));
    function apply() {
      var rows = (PB.view === 'latest' ? day : all).filter(function (r) {
        if (PB.f === 'main' && r['In Main'] !== 'Yes') return false;
        if ((PB.f === 'up' || PB.f === 'down') && kind(r) !== PB.f) return false;
        return ui.textMatch(PB.q, [r.Symbol, r.Company]);
      });
      $('#pb-count', el).textContent = F.int(rows.length) + ' of ' + F.int(PB.view === 'latest' ? day.length : all.length);
      t.setRows(rows);
    }
    var timer;
    $('#pb-q', el).addEventListener('input', function (e) { clearTimeout(timer); timer = setTimeout(function () { PB.q = e.target.value.trim(); apply(); }, 120); });
    ui.bindChips(el, 'pbv', function (v) { PB.view = v; apply(); });
    ui.bindChips(el, 'pbf', function (v) { PB.f = v; apply(); });
    apply();
  }

  SB.page('markets', {
    render: function (el, params, ctx) {
      var D = ctx.D, ipos = ui.objRows(D.ipos);
      var h = '<div class="page-head"><div><h1>IPOs &amp; markets</h1><p>Mainboard IPOs (open, closed - awaiting listing, upcoming), NSE price band changes, indices, ' +
        'listed IPOs and their bases, and the latest listings. ' + ui.stateBadge('CACHED', D.asOf || D.generated, 'Sheet snapshot') + '</p></div></div>';
      h += ipoTrackerCard(D);
      h += priceBandCard();
      h += ui.card('Indices', 'Day change and distance from all-time high (Indextracker tab)', '<div id="mk-idx"></div>');
      h += '<section class="card"><div class="card-head"><div><h2>Listed IPOs &amp; IPO bases</h2><p>' + ipos.length + ' IPOs · price vs listing price and IPO base</p></div></div>' +
        '<div class="controls"><input class="search" id="ipo-q" type="search" placeholder="Search IPO symbol or base status" aria-label="Search IPOs">' +
        ui.chips('ipo', [['all', 'All'], ['Above', 'Above IPO price'], ['Below', 'Below IPO price']], 'all') + '</div><div id="ipo-t"></div></section>';
      h += ui.card('New listings', 'Latest NSE listings', '<div id="ipo-new"></div>');
      el.innerHTML = h;

      mountIpoTracker(el, D);
      mountPriceBands(el, D);

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
    }
  });
})();
