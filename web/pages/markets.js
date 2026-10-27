/* IPOs & markets: IPO Tracker (mainboard IPOs open / closed - awaiting listing / upcoming,
   from NSE via the PC bridge and the sheet's IPO Tracker tab), NSE 52-week highs (52 Week High
   tab, #markets/high52), NSE price band changes, indices, listed IPOs and their bases, new listings. */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, esc = ui.esc, F = ui.F, isNum = ui.isNum, $ = ui.$;
  var PB = { view: 'latest', f: 'all', q: '' };
  var H52 = { f: 'new', q: '' };

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

  function high52Card(D) {
    if (!D.high52) {
      return '<section class="card" id="high52"><div class="card-head"><div><h2>52-week highs</h2><p>NSE 52 Week High report</p></div></div>' +
        '<p class="empty">Not in this copy of the data yet. Your PC bridge reads NSE\'s 52 Week High report each evening and fills the sheet\'s ' +
        '<b>52 Week High</b> tab; it shows here after that.</p></section>';
    }
    return '<section class="card" id="high52"><div class="card-head"><div><h2>52-week highs</h2><p id="h52-sum"></p></div></div>' +
      '<div class="controls"><input class="search" id="h52-q" type="search" placeholder="Search symbol or company" aria-label="Search 52-week highs" value="' + esc(H52.q) + '">' +
      ui.chips('h52', [['new', 'New 52-week high today'], ['near', 'Watchlist within 5% of high'], ['watch', 'All watchlist stocks']], H52.f) +
      '<span class="count" id="h52-count"></span></div><div id="h52-t"></div>' +
      '<p class="sub" style="margin-top:8px">From NSE\'s daily "52 Week High Low Report" (52-week highs adjusted for bonus, splits and rights), read by your PC each evening; ' +
      'mainboard stocks only, 52-week lows are not tracked. Close = the day\'s closing price from NSE\'s bhavcopy.</p></section>';
  }
  function mountHigh52(el, D) {
    if (!D.high52) return;
    var X = SB.eod.highs(D.high52);
    var newMain = X.newToday.filter(function (r) { return r.inMain; }).length;
    $('#h52-sum', el).innerHTML = X.asOf ? 'As on <b>' + F.date(X.asOf) + '</b>: ' + F.int(X.newToday.length) + ' mainboard stock' + (X.newToday.length === 1 ? '' : 's') +
      ' at a new 52-week high · ' + F.int(newMain) + ' in your watchlist ' + ui.stateBadge('EOD', X.asOf, '52 Week High tab (NSE via the PC bridge)') : esc(X.note);
    var t = new ui.Table({
      rows: [], pageSize: 25, sort: { key: 'below', dir: 1 }, empty: 'No stocks match',
      columns: [
        { key: 'sym', label: 'Stock', type: 'sym', name: 'name', csv: function (r) { return r.sym; } },
        { key: 'name', label: 'Company', csvOnly: true },
        { key: 'high', label: '52W high', type: 'price' },
        { key: 'date', label: 'High on', type: 'date' },
        { key: 'close', label: 'Close', type: 'price' },
        { key: 'below', label: '% below high', type: 'num', digits: 1 },
        { key: 'isNew', label: 'Today', get: function (r) { return r.isNew ? 'New high' : null; },
          html: function (r) { return r.isNew ? ui.badge('New high', 'new52') : '<span class="sub">–</span>'; } },
        { key: 'inMain', label: 'Watchlist', get: function (r) { return r.inMain ? 'Yes' : null; } }
      ]
    }).mount($('#h52-t', el));
    function apply() {
      var rows = X.rows.filter(function (r) {
        if (H52.f === 'new' && !r.isNew) return false;
        if (H52.f === 'near' && !(r.inMain && isNum(r.below) && r.below <= 5)) return false;
        if (H52.f === 'watch' && !r.inMain) return false;
        return ui.textMatch(H52.q, [r.sym, r.name]);
      });
      $('#h52-count', el).textContent = F.int(rows.length) + ' stock' + (rows.length === 1 ? '' : 's');
      t.setRows(rows);
    }
    var timer;
    $('#h52-q', el).addEventListener('input', function (e) { clearTimeout(timer); timer = setTimeout(function () { H52.q = e.target.value.trim(); apply(); }, 120); });
    ui.bindChips(el, 'h52', function (v) { H52.f = v; apply(); });
    apply();
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
      var h = '<div class="page-head"><div><h1>IPOs &amp; markets</h1><p>Mainboard IPOs (open, closed - awaiting listing, upcoming), NSE 52-week highs, NSE price band changes, indices, ' +
        'listed IPOs and their bases, and the latest listings. ' + ui.stateBadge('CACHED', D.asOf || D.generated, 'Sheet snapshot') + '</p></div></div>';
      h += ipoTrackerCard(D);
      h += high52Card(D);
      h += priceBandCard();
      h += ui.card('Indices', 'Day change and distance from all-time high (Indextracker tab)', '<div id="mk-idx"></div>');
      h += '<section class="card"><div class="card-head"><div><h2>Listed IPOs &amp; IPO bases</h2><p>' + ipos.length + ' IPOs · price vs listing price and IPO base</p></div></div>' +
        '<div class="controls"><input class="search" id="ipo-q" type="search" placeholder="Search IPO symbol or base status" aria-label="Search IPOs">' +
        ui.chips('ipo', [['all', 'All'], ['Above', 'Above IPO price'], ['Below', 'Below IPO price']], 'all') + '</div><div id="ipo-t"></div></section>';
      h += ui.card('New listings', 'Latest NSE listings', '<div id="ipo-new"></div>');
      el.innerHTML = h;

      mountIpoTracker(el, D);
      mountHigh52(el, D);
      mountPriceBands(el, D);
      if (params && params[0] === 'high52') {             // #markets/high52 (the Overview's 52-week high tile)
        var h52 = $('#high52', el);
        if (h52 && h52.scrollIntoView) h52.scrollIntoView({ block: 'start' });
      }

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
