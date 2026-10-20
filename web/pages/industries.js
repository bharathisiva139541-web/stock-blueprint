/* Industries & Sectors.
   Routes: #industries            overview of all dashboard categories
           #industries/<id>       one category's own page
           #industries/review     classification review
   Classification comes only from the NSE Sector / Basic Industry stored in
   the sheet's Main tab (SB.classify, applied in app.js prepare()); nothing is
   ever classified from a company name. Each stock is in exactly one
   category, so totals never double-count. */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, esc = ui.esc, F = ui.F, isNum = ui.isNum, $ = ui.$;

  // control state, kept while the site is open (not personal data)
  var OV = { q: '', sort: 'name', sector: '' };
  var CAT = { id: null, f: 'all', q: '', bi: '' };
  var RV = { f: 'all', q: '' };
  var NONE = '__none__';                       // "no basic industry" option value

  var STATUS_CLS = { qualified: 's-good', watch: 's-info', avoid: 's-bad', insufficient: 's-warn', none: '' };

  // ---------- helpers ----------
  function stats(list) {
    var o = { n: list.length, adv: 0, dec: 0, flat: 0, chgN: 0, mcap: 0, mcapN: 0, d10N: 0, d30N: 0 };
    var cs = 0, s10 = 0, s30 = 0;
    list.forEach(function (s) {
      if (isNum(s.chg)) {
        o.chgN++; cs += s.chg;
        if (s.chg > 0) o.adv++; else if (s.chg < 0) o.dec++; else o.flat++;
      }
      if (isNum(s.mcap) && s.mcap > 0) { o.mcapN++; o.mcap += s.mcap; }
      if (isNum(s.d10)) { o.d10N++; s10 += s.d10; }
      if (isNum(s.d30)) { o.d30N++; s30 += s.d30; }
    });
    o.avg = o.chgN ? cs / o.chgN : null;
    o.d10 = o.d10N ? s10 / o.d10N : null;
    o.d30 = o.d30N ? s30 / o.d30N : null;
    o.breadth = o.chgN ? o.adv / o.chgN * 100 : null;
    o.nodata = o.n - o.chgN;
    return o;
  }
  // percentage points (difference of two percentages)
  function ppHtml(v) {
    if (!isNum(v)) return '<span class="sub">–</span>';
    return '<span class="' + (v > 0 ? 'up' : v < 0 ? 'down' : '') + '">' + F.pct(v, 2).replace('%', ' pp') + '</span>';
  }
  function capFmt(v) {
    if (!isNum(v) || v <= 0) return '–';
    return v >= 1e5 ? F.num(v / 1e5, 2) + ' lakh Cr' : F.cr(v);
  }
  function breadthBar(st) {
    var parts = [['b-up', st.adv, 'advancing'], ['b-flat', st.flat, 'unchanged'], ['b-down', st.dec, 'declining']].filter(function (p) { return p[1] > 0; });
    var label = st.adv + ' advancing, ' + st.flat + ' unchanged, ' + st.dec + ' declining' + (st.nodata ? ', ' + st.nodata + ' without a price change' : '');
    return '<div class="breadth" role="img" aria-label="' + esc(label) + '" data-tip="' + esc(label) + '">' + parts.map(function (p) {
      return '<span class="' + p[0] + '" style="flex:' + p[1] + ' 1 0"></span>';
    }).join('') + '</div>';
  }
  function advDecHtml(st) {
    return '<span class="up">▲ ' + F.int(st.adv) + '</span> · <span class="down">▼ ' + F.int(st.dec) + '</span>' +
      (st.flat ? ' · ' + F.int(st.flat) + ' unch.' : '');
  }
  function daysTo(rdate, ref) {
    var d = ui.parseDate(rdate);
    return d ? ui.dayDiff(d, ref) : null;
  }
  function backLink() { return '<a href="#industries" class="sub">← All industries &amp; sectors</a>'; }
  function countBy(list, fn) {
    var m = {};
    list.forEach(function (s) { var k = fn(s); m[k] = (m[k] || 0) + 1; });
    return m;
  }

  // ---------- active strategy ----------
  function strategyInfo() {
    var S = SB.strategies;
    if (!S) return null;
    var id = S.activeId(), cfg = S.get(id);       // store reads never throw (ui.store catches)
    if (!cfg) return null;
    return { id: id, cfg: cfg, confirmed: S.isConfirmed(id), demo: cfg.source === 'demo', discovered: /^discovered/.test(cfg.source || '') };
  }
  function runStrategy() {
    if (!SB.strategies) return Promise.reject(new Error('the strategy module did not load'));
    try { return SB.strategies.runActive(); } catch (e) { return Promise.reject(e); }
  }
  function strategyBadges(info) {
    var c = info.cfg, b = [];
    if (info.demo) { b.push(ui.badge('DEMO', 's-warn')); b.push(ui.badge('for testing only', '')); }
    else if (info.confirmed) b.push(ui.badge('Confirmed by you', 's-good'));
    else if (info.discovered) b.push(ui.badge('Discovered, unconfirmed', 's-warn'));
    else b.push(ui.badge('Custom, unconfirmed', 's-warn'));
    if (c.source === 'discovered-edited') b.push(ui.badge('edited in this browser', 's-info'));
    return b.join(' ');
  }
  function strategyNote(info) {
    if (!info) return '<div class="note bad">The strategy module did not load, so strategy counts and statuses are unavailable.</div>';
    var c = info.cfg;
    var h = '<div class="note' + (info.demo || !info.confirmed ? ' warn' : '') + '"><strong>Active strategy:</strong> ' + esc(c.name) +
      ' · v' + esc(c.version) + ' ' + strategyBadges(info) + ' ';
    if (info.demo) h += 'DEMO strategies are generic examples for testing the engine; their signals are not recommendations. ';
    else if (!info.confirmed && info.discovered) h += 'Assembled from rules found in your sheet. How they combine into an entry candidate is not written there, so treat results as unconfirmed until you confirm them in <a href="#strategy">Strategy Settings</a>. ';
    else if (!info.confirmed) h += 'Your own rules, not yet confirmed - review them in <a href="#strategy">Strategy Settings</a>. ';
    else h += 'You confirmed this version in <a href="#strategy">Strategy Settings</a>. ';
    h += 'Daily candles: <span data-candles>loading…</span> “Qualified” only means the rules matched on the latest daily candle - it is not a prediction or a promise of profit.</div>';
    return h;
  }
  function fillCandles(el, run, err) {
    var x = el.querySelector('[data-candles]');
    if (!x) return;
    if (err) { x.innerHTML = ui.stateBadge('UNAVAILABLE') + ' the strategy could not run (' + esc(err.message || String(err)) + ').'; return; }
    x.innerHTML = ui.stateBadge('CACHED', run.dataAsOf, run.dataSource) + (run.errors && run.errors.length ? ' Rule problems: ' + esc(run.errors.join('; ')) + '.' : '');
  }
  function clip(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s;
  }
  function firstReason(r) {
    if (!r) return null;
    if (r.status === 'qualified') {
      var t = (r.checks || []).filter(function (k) { return k.group === 'trigger' && k.res && k.res.pass === true && !k.watchOnly; })[0];
      if (t) return t.res.detail ? t.label.replace(/\s*\(.*\)$/, '') + ' - ' + t.res.detail : t.label;
      return (r.triggersPassed && r.triggersPassed[0]) || 'all screen conditions met';
    }
    return (r.failed && r.failed[0]) || null;
  }

  // =====================================================================
  // #industries - overview
  // =====================================================================
  function renderOverview(el, ctx) {
    var C = SB.classify, stocks = ctx.stocks;
    var byCat = {};
    stocks.forEach(function (s) { if (s.cat) (byCat[s.cat] = byCat[s.cat] || []).push(s); });
    var groups = C.CATEGORIES.filter(function (c) { return byCat[c.id]; }).map(function (c) { return { cat: c, all: byCat[c.id] }; });
    var classified = stocks.filter(function (s) { return !!s.cat; }).length;
    var unclassified = stocks.length - classified;
    var review = C.reviewList(stocks);
    var market = stats(stocks);
    var sectorCounts = countBy(stocks.filter(function (s) { return s.sector; }), function (s) { return s.sector; });
    var sectors = Object.keys(sectorCounts).sort();
    if (OV.sector && !sectorCounts[OV.sector]) OV.sector = '';
    var info = strategyInfo();
    var run = null, runErr = null;

    var h = '<div class="page-head"><div><h1>Industries &amp; sectors</h1>' +
      '<p>Every stock carries the NSE industry classification stored in the sheet\'s Main tab - one <b>Sector</b> and one <b>Basic Industry</b> ' +
      '(NSE Sector → Industry → Basic Industry). The dashboard groups these NSE values into ' + F.int(groups.length) +
      ' categories: banks, insurance, logistics, agri-inputs and packaging are picked out by basic industry, everything else follows the NSE sector. ' +
      'Each stock sits in exactly one category, so totals never double-count. Nothing is classified from a company name.</p>' +
      '<p>Prices: ' + ui.stateBadge(ctx.market.state, ctx.market.asOf, ctx.market.source) + ' · Classification: ' +
      ui.stateBadge('CACHED', ctx.D.asOf || ctx.D.generated, 'Main tab Sector / Basic Industry') + '</p></div></div>';
    h += '<div class="tiles">' +
      ui.tile('Categories', F.int(groups.length), 'with at least one watchlist stock') +
      ui.tile('Stocks classified', F.int(classified), 'of ' + F.int(stocks.length) + ' in the Main tab') +
      ui.tile('Unclassified', '<a href="#industries/review">' + F.int(unclassified) + '</a>',
        '<a href="#industries/review">' + F.int(review.length) + ' row' + (review.length === 1 ? '' : 's') + ' to review →</a>') +
      ui.tile('Market average today', ui.deltaHtml(market.avg, 2), advDecHtml(market) + ' · ' + F.int(market.chgN) + ' stocks') +
      ui.tile('Strategy qualified', '<span id="ov-qual">…</span>', 'all categories, active strategy') +
      '</div>';
    h += strategyNote(info);
    h += '<section aria-label="Categories"><div class="controls">' +
      '<input class="search" id="ov-q" type="search" placeholder="Search category, sector, basic industry or symbol" aria-label="Search categories" value="' + esc(OV.q) + '">' +
      '<select class="sel" id="ov-sort" aria-label="Sort categories">' + [
        ['name', 'Sort: name (A–Z)'], ['count', 'Sort: stock count'], ['avg', 'Sort: avg % change (highest)'],
        ['avgAsc', 'Sort: avg % change (lowest)'], ['breadth', 'Sort: breadth (% advancing)'], ['mom', 'Sort: 10D momentum'],
        ['qual', 'Sort: strategy qualified']
      ].map(function (o) { return '<option value="' + o[0] + '"' + (OV.sort === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>' +
      '<select class="sel" id="ov-sector" aria-label="NSE sector"><option value="">All NSE sectors</option>' +
      sectors.map(function (s) { return '<option value="' + esc(s) + '"' + (OV.sector === s ? ' selected' : '') + '>' + esc(s) + ' (' + sectorCounts[s] + ')</option>'; }).join('') +
      '</select><span class="count" id="ov-count"></span></div>' +
      '<div id="ov-cards" style="display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(250px,1fr))"></div></section>';
    h += ui.card('Average % change today, by category', 'Follows the search and sector filter above · market average ' + F.pct(market.avg, 2) + ' · select a bar to open the category',
      '<div id="ov-chart"></div><div class="legend"><span><i style="background:var(--bar)"></i>Average up today</span><span><i style="background:var(--bar-neg)"></i>Average down today</span></div>');
    el.innerHTML = h;

    function visible() {
      var q = OV.q.toLowerCase(), qs = OV.q.toUpperCase();
      var out = [];
      groups.forEach(function (g) {
        var list = OV.sector ? g.all.filter(function (s) { return s.sector === OV.sector; }) : g.all;
        if (!list.length) return;
        var hint = null;
        if (q && !ui.textMatch(q, [g.cat.name, g.cat.id])) {
          var hits = {};
          list.forEach(function (s) {
            if (s.sym === qs) hits[s.sym + ' is here'] = 1;
            if (s.ind && ui.textMatch(q, [s.ind])) hits[s.ind] = 1;
            if (s.sector && ui.textMatch(q, [s.sector])) hits[s.sector] = 1;
          });
          var k = Object.keys(hits);
          if (!k.length) return;
          hint = k;
        }
        var st = stats(list);
        out.push({ cat: g.cat, all: g.all, list: list, st: st, hint: hint, nInd: Object.keys(countBy(list, function (s) { return s.ind || ''; })).length });
      });
      return out;
    }
    function qualOf(g) {
      if (!run) return null;
      var ev = 0, q = 0;
      g.list.forEach(function (s) { var r = run.bySym[s.sym]; if (r) { ev++; if (r.status === 'qualified') q++; } });
      return ev ? q : NaN;                       // NaN: none of these stocks is in the strategy's universe
    }
    function qualHtml(g) {
      if (runErr) return '<span class="sub" data-tip="' + esc('Strategy could not run: ' + (runErr.message || runErr)) + '">–</span>';
      var q = qualOf(g);
      if (q === null) return '<span class="sub">…</span>';
      if (isNaN(q)) return '<span class="sub" data-tip="Outside the active strategy\'s universe">n/a</span>';
      return '<b>' + F.int(q) + '</b>';
    }
    function sorter(a, b) {
      function nd(x, y) {                        // numbers descending, blanks last
        var xa = isNum(x), ya = isNum(y);
        if (!xa && !ya) return 0;
        if (!xa) return 1;
        if (!ya) return -1;
        return y - x;
      }
      var r = 0;
      switch (OV.sort) {
        case 'count': r = b.st.n - a.st.n; break;
        case 'avg': r = nd(a.st.avg, b.st.avg); break;
        case 'avgAsc': r = nd(isNum(a.st.avg) ? -a.st.avg : null, isNum(b.st.avg) ? -b.st.avg : null); break;
        case 'breadth': r = nd(a.st.breadth, b.st.breadth); break;
        case 'mom': r = nd(a.st.d10, b.st.d10); break;
        case 'qual': r = nd(qualOf(a), qualOf(b)); break;
      }
      return r || a.cat.name.localeCompare(b.cat.name);
    }
    function cardHtml(g) {
      var st = g.st, rs = isNum(st.avg) && isNum(market.avg) ? st.avg - market.avg : null;
      var h2 = '<a class="card ind-card" href="#industries/' + encodeURIComponent(g.cat.id) + '">' +
        '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px"><h3>' + esc(g.cat.name) + '</h3>' +
        '<span class="sub" style="white-space:nowrap">' + F.int(st.n) + ' stock' + (st.n === 1 ? '' : 's') + '</span></div>' +
        '<p class="sub">' + F.int(g.nInd) + ' basic industr' + (g.nInd === 1 ? 'y' : 'ies') +
        (OV.sector ? ' · ' + F.int(st.n) + ' of ' + F.int(g.all.length) + ' stocks are in ' + esc(OV.sector) : '') + '</p>' +
        (g.hint ? '<p class="sub">Matches: ' + esc(g.hint.slice(0, 3).join(', ') + (g.hint.length > 3 ? ' +' + (g.hint.length - 3) + ' more' : '')) + '</p>' : '') +
        '<div class="row"><span>Avg change today</span><span class="num" data-tip="' + esc('Average of ' + st.chgN + ' of ' + st.n + ' stocks with a price change') + '">' + ui.deltaHtml(st.avg, 2) + '</span></div>' +
        breadthBar(st) +
        '<div class="row"><span>' + advDecHtml(st) + '</span><span>' + (isNum(st.breadth) ? F.num(st.breadth, 0) + '% up' : '–') + '</span></div>' +
        '<div class="row"><span>Relative strength</span><span class="num" data-tip="' + esc('Category average minus the market-wide average (' + F.pct(market.avg, 2) + ')') + '">' + ppHtml(rs) + '</span></div>' +
        '<div class="row"><span>10D momentum</span><span class="num" data-tip="' + esc('Average 10-day % change of ' + st.d10N + ' stocks') + '">' + ui.deltaHtml(st.d10, 2) + '</span></div>' +
        '<div class="row"><span>Market cap</span><span class="num">' + capFmt(st.mcap) + '</span></div>' +
        '<div class="row" style="margin-top:2px"><span></span><span class="sub">' + F.int(st.mcapN) + ' of ' + F.int(st.n) + ' with market cap</span></div>' +
        '<div class="row"><span>Strategy qualified</span><span class="num" data-q="' + esc(g.cat.id) + '">' + qualHtml(g) + '</span></div>' +
        '</a>';
      return h2;
    }
    var shown = [];
    function draw() {
      shown = visible().sort(sorter);
      var nStocks = shown.reduce(function (a, g) { return a + g.st.n; }, 0);
      $('#ov-count', el).textContent = F.int(shown.length) + ' of ' + F.int(groups.length) + ' categories · ' + F.int(nStocks) + ' stocks';
      var host = $('#ov-cards', el);
      if (!shown.length) {
        host.innerHTML = '<div class="note" style="grid-column:1/-1">No category matches ' + (OV.q ? '“' + esc(OV.q) + '”' : 'these filters') +
          (OV.sector ? ' in the ' + esc(OV.sector) + ' sector' : '') + '. Try a basic industry (e.g. “cement”, “bank”) or a symbol. ' +
          '<button type="button" class="btn" id="ov-clear" style="margin-left:6px">Clear filters</button></div>';
      } else host.innerHTML = shown.map(cardHtml).join('');
      var items = shown.slice().sort(function (a, b) {
        var x = isNum(a.st.avg) ? a.st.avg : -Infinity, y = isNum(b.st.avg) ? b.st.avg : -Infinity;
        return (y - x) || a.cat.name.localeCompare(b.cat.name);
      }).map(function (g) {
        return { label: g.cat.name, value: g.st.avg, href: '#industries/' + encodeURIComponent(g.cat.id),
          tip: g.cat.name + ': ' + F.pct(g.st.avg, 2) + ' average today · ' + g.st.adv + ' up, ' + g.st.dec + ' down · ' + g.st.n + ' stocks' };
      });
      $('#ov-chart', el).innerHTML = items.length ? ui.bars(items, { diverging: true, fmt: function (v) { return F.pct(v, 2); } }) :
        '<p class="empty">No categories to chart for these filters</p>';
    }
    function fillQual() {
      el.querySelectorAll('[data-q]').forEach(function (x) {
        var g = shown.filter(function (k) { return k.cat.id === x.getAttribute('data-q'); })[0];
        if (g) x.innerHTML = qualHtml(g);
      });
      var t = $('#ov-qual', el);
      if (t) t.innerHTML = runErr ? '<span class="sub" data-tip="' + esc(runErr.message || String(runErr)) + '">–</span>' : run ? F.int(run.counts.qualified) : '…';
    }

    var timer;
    $('#ov-q', el).addEventListener('input', function (e) {
      clearTimeout(timer);
      timer = setTimeout(function () { OV.q = e.target.value.trim(); draw(); }, 120);
    });
    $('#ov-sort', el).addEventListener('change', function (e) { OV.sort = e.target.value; draw(); });
    $('#ov-sector', el).addEventListener('change', function (e) { OV.sector = e.target.value; draw(); });
    el.addEventListener('click', function (e) {
      if (!e.target.closest('#ov-clear')) return;
      OV.q = ''; OV.sector = '';
      $('#ov-q', el).value = ''; $('#ov-sector', el).value = '';
      draw();
      $('#ov-q', el).focus();
    });
    draw();

    runStrategy().then(function (r) {
      run = r;
      if (!el.isConnected) return;
      fillCandles(el, r, null);
      if (OV.sort === 'qual') draw();          // order depends on the counts
      fillQual();
    }, function (e) {
      runErr = e || new Error('unknown error');
      if (!el.isConnected) return;
      fillCandles(el, null, runErr);
      fillQual();
    });
  }

  // =====================================================================
  // #industries/<id> - one category
  // =====================================================================
  function renderCategory(el, ctx, id) {
    var C = SB.classify, cat = C.categoryById(id);
    if (!cat) {
      el.innerHTML = '<div class="page-head"><div>' + backLink() + '<h1>Category not found</h1>' +
        '<p>There is no dashboard category called “' + esc(id) + '”. Categories come from the NSE Sector / Basic Industry in the sheet\'s Main tab.</p></div></div>' +
        '<section class="card"><div class="card-head"><div><h2>Open a category</h2></div></div><div class="links">' +
        C.CATEGORIES.map(function (c) { return '<a class="btn" href="#industries/' + encodeURIComponent(c.id) + '">' + esc(c.name) + '</a>'; }).join('') +
        '</div></section>';
      return;
    }
    var list = ctx.stocks.filter(function (s) { return s.cat === id; });
    if (!list.length) {
      el.innerHTML = '<div class="page-head"><div>' + backLink() + '<h1>' + esc(cat.name) + '</h1></div></div>' +
        '<div class="note">None of the ' + F.int(ctx.stocks.length) + ' watchlist stocks is in this category right now. ' +
        'A stock lands here when its NSE Sector / Basic Industry in the Main tab maps to “' + esc(cat.name) + '”. <a href="#industries">Back to all categories</a>.</div>';
      return;
    }
    if (CAT.id !== id) { CAT.id = id; CAT.f = 'all'; CAT.q = ''; CAT.bi = ''; }
    var st = stats(list), market = stats(ctx.stocks);
    var rs = isNum(st.avg) && isNum(market.avg) ? st.avg - market.avg : null;
    var info = strategyInfo();
    var run = null, runErr = null;
    var sectorCounts = countBy(list, function (s) { return s.sector || '(no sector)'; });
    var biMap = {};
    list.forEach(function (s) {
      var k = s.ind || NONE;
      (biMap[k] = biMap[k] || []).push(s);
    });
    var biRows = Object.keys(biMap).map(function (k) {
      var l = biMap[k], x = stats(l), sc = countBy(l, function (s) { return s.sector || '–'; });
      return { key: k, bi: k === NONE ? null : k, sector: Object.keys(sc).sort(function (a, b) { return sc[b] - sc[a]; }).join(', '),
        n: x.n, avg: x.avg, d10: x.d10, adv: x.adv, dec: x.dec, list: l };
    });
    if (CAT.bi && !biMap[CAT.bi]) CAT.bi = '';
    var upcoming = list.map(function (s) { return { s: s, dd: daysTo(s.rdate, ctx.refDate) }; })
      .filter(function (x) { return x.dd != null && x.dd >= 0; })
      .sort(function (a, b) { return a.dd - b.dd || a.s.sym.localeCompare(b.s.sym); });

    var h = '<div class="page-head"><div>' + backLink() + '<h1>' + esc(cat.name) + '</h1>' +
      '<p>' + F.int(st.n) + ' stocks · ' + F.int(biRows.length) + ' NSE basic industr' + (biRows.length === 1 ? 'y' : 'ies') + ' · NSE sector' +
      (Object.keys(sectorCounts).length === 1 ? '' : 's') + ': ' +
      esc(Object.keys(sectorCounts).sort(function (a, b) { return sectorCounts[b] - sectorCounts[a]; }).map(function (k) { return k + ' (' + sectorCounts[k] + ')'; }).join(', ')) + '</p>' +
      '<p>Prices: ' + ui.stateBadge(ctx.market.state, ctx.market.asOf, ctx.market.source) + ' · Classification: ' +
      ui.stateBadge('CACHED', ctx.D.asOf || ctx.D.generated, 'Main tab Sector / Basic Industry') + '</p></div></div>';
    h += '<div class="tiles">' +
      ui.tile('Stocks', F.int(st.n), F.int(biRows.length) + ' basic industr' + (biRows.length === 1 ? 'y' : 'ies')) +
      ui.tile('Average change today', ui.deltaHtml(st.avg, 2), ppHtml(rs) + ' vs market (' + F.pct(market.avg, 2) + ')') +
      ui.tile('Advancers / decliners', '<span class="up">▲ ' + F.int(st.adv) + '</span> · <span class="down">▼ ' + F.int(st.dec) + '</span>',
        breadthBar(st) + '<div style="margin-top:4px">' + F.int(st.flat) + ' unchanged' + (st.nodata ? ' · ' + F.int(st.nodata) + ' without a price change' : '') + '</div>') +
      ui.tile('Market cap', capFmt(st.mcap), F.int(st.mcapN) + ' of ' + F.int(st.n) + ' with market cap') +
      ui.tile('Avg 10D / 30D', ui.deltaHtml(st.d10, 2) + ' / ' + ui.deltaHtml(st.d30, 2), F.int(st.d10N) + ' / ' + F.int(st.d30N) + ' stocks with data') +
      ui.tile('Strategy qualified', '<span id="ic-qual">…</span>', '<span id="ic-qual-note">running the active strategy…</span>') +
      '</div>';
    h += strategyNote(info);
    h += '<div class="grid g2" style="align-items:start">' +
      ui.card('By NSE basic industry', 'Stock count and averages · select a basic industry to filter the table below', '<div id="ic-bi"></div>') +
      ui.card('Upcoming results', upcoming.length ? F.int(upcoming.length) + ' stock' + (upcoming.length === 1 ? '' : 's') + ' with a result date from ' + F.date(ui.iso(ctx.refDate)) + ' · Main tab Result Date' : 'Main tab Result Date', '<div id="ic-up"></div>') +
      '</div>';
    h += '<section class="card" id="ic-stocks"><div class="card-head"><div><h2>Stocks</h2><p>Click a symbol for details, a column to sort. TTM Signal is the sheet\'s own target-price signal, not advice.</p></div></div>' +
      '<div class="controls">' +
      '<input class="search" id="ic-q" type="search" placeholder="Search symbol, company or basic industry" aria-label="Search stocks in this category" value="' + esc(CAT.q) + '">' +
      '<select class="sel" id="ic-bi-sel" aria-label="Basic industry"><option value="">All basic industries</option>' +
      biRows.slice().sort(function (a, b) { return String(a.bi || '~').localeCompare(String(b.bi || '~')); }).map(function (r) {
        return '<option value="' + esc(r.key) + '"' + (CAT.bi === r.key ? ' selected' : '') + '>' + esc(r.bi || '(no basic industry)') + ' (' + r.n + ')</option>';
      }).join('') + '</select>' +
      '<button class="btn" type="button" id="ic-csv">Export CSV</button></div>' +
      '<div class="controls">' + ui.chips('ic', chipOptions(), CAT.f) + '<span class="count" id="ic-count"></span></div>' +
      '<div id="ic-table"></div></section>';
    el.innerHTML = h;

    function resOf(s) { return run ? run.bySym[s.sym] || null : null; }
    function chipOptions() {
      var due = list.filter(function (s) { var d = daysTo(s.rdate, ctx.refDate); return d != null && d >= 0 && d <= 14; }).length;
      function n(k) {
        if (runErr) return '–';
        if (!run) return '…';
        return F.int(list.filter(function (s) { var r = resOf(s); return r && r.status === k; }).length);
      }
      return [['all', 'All (' + F.int(list.length) + ')'], ['qualified', 'Qualified (' + n('qualified') + ')'], ['watch', 'Watch (' + n('watch') + ')'],
        ['avoid', 'Avoid (' + n('avoid') + ')'], ['none', 'No signal (' + n('none') + ')'], ['insufficient', 'Insufficient data (' + n('insufficient') + ')'],
        ['results', 'Result due ≤14 days (' + F.int(due) + ')']];
    }

    // --- basic industry breakdown
    var bt = new ui.Table({
      rows: biRows, pageSize: 12, sort: { key: 'n', dir: -1 }, empty: 'No basic industries',
      columns: [
        { key: 'bi', label: 'Basic industry', wrap: true, get: function (r) { return r.bi || '(no basic industry)'; },
          html: function (r) {
            return '<button type="button" class="linkish" data-bi="' + esc(r.key) + '" title="Show these stocks in the table below">' + esc(r.bi || '(no basic industry)') + '</button>' +
              (r.sector ? '<span class="co">' + esc(r.sector) + '</span>' : '');
          } },
        { key: 'n', label: 'Stocks', type: 'num', digits: 0 },
        { key: 'avg', label: 'Avg today', type: 'pct', digits: 2 },
        { key: 'd10', label: 'Avg 10D', type: 'pct', digits: 2 },
        { key: 'ad', label: 'Up / down', get: function (r) { return r.adv - r.dec; },
          html: function (r) { return '<span class="up">' + r.adv + '</span> / <span class="down">' + r.dec + '</span>'; } },
        { key: 'q', label: 'Qualified', type: 'num', digits: 0,
          get: function (r) { return run ? r.list.filter(function (s) { var x = resOf(s); return x && x.status === 'qualified'; }).length : null; },
          html: function (r) {
            if (runErr) return '<span class="sub">–</span>';
            if (!run) return '<span class="sub">…</span>';
            return F.int(r.list.filter(function (s) { var x = resOf(s); return x && x.status === 'qualified'; }).length);
          } }
      ]
    }).mount($('#ic-bi', el));

    // --- upcoming results
    var MAXUP = 8;
    $('#ic-up', el).innerHTML = upcoming.length ? '<ul class="list">' + upcoming.slice(0, MAXUP).map(function (x) {
      var s = x.s;
      return '<li><span class="num" style="min-width:92px;text-align:left">' + F.date(s.rdate) + '</span><div class="grow">' + ui.stockCell(s.sym, s.name) + '</div>' +
        ui.badge(x.dd === 0 ? 'today' : 'in ' + x.dd + ' day' + (x.dd === 1 ? '' : 's'), x.dd <= 3 ? 's-warn' : 's-info') + '</li>';
    }).join('') + '</ul>' + (upcoming.length > MAXUP ? '<p class="sub" style="margin-top:8px">+' + F.int(upcoming.length - MAXUP) +
      ' more - sort the table below by Result date, or use the “Result due ≤14 days” filter.</p>' : '') :
      '<p class="empty">No upcoming result dates for these stocks in the Main tab\'s Result Date column (the NSE results calendar pasted in the Results tab).</p>';

    // --- stock table
    var t = new ui.Table({
      rows: [], pageSize: 50, sort: { key: 'chg', dir: -1 }, empty: 'No stocks match these filters',
      columns: [
        { key: 'sym', label: 'Stock', type: 'sym', name: 'name', csv: function (r) { return r.sym; } },
        { key: 'name', label: 'Company', csvOnly: true },
        { key: 'ind', label: 'Basic industry', wrap: true },
        { key: 'price', label: 'Price', type: 'price' },
        { key: 'chg', label: 'Today', type: 'pct', digits: 2 },
        { key: 'd10', label: '10D', type: 'pct' },
        { key: 'd30', label: '30D', type: 'pct' },
        { key: 'down52', label: 'vs 52W high', type: 'pct', title: '% below the 52-week high' },
        { key: 'sig', label: 'TTM Signal', type: 'badge', title: 'The sheet\'s TTM Signal rule at the price shown: Buy when the TTM target is above the price with EPS growth ≥ 0 and EPS > 0, otherwise Avoid. Not a recommendation.' },
        // status badge with the first reason under it; the reason is also its own CSV column.
        // (The engine's "results due" warnings are measured from the last candle date, which can be
        // older than the data date, so they are not shown - the Result date column has the timing.)
        { key: 'strat', label: 'Strategy', wrap: true, title: 'Status under the active strategy, with the first reason',
          get: function (r) { var x = resOf(r); return x ? x.statusLabel : null; },
          html: function (r) {
            var x = resOf(r);
            if (!x) return '<span class="sub">' + (runErr ? '–' : run ? 'not evaluated' : '…') + '</span>';
            var s = firstReason(x);
            return ui.badge(x.statusLabel, STATUS_CLS[x.status] != null ? STATUS_CLS[x.status] : '') +
              (s ? '<span class="co" style="white-space:normal;max-width:none;margin-top:2px" title="' + esc(s) + '">' + esc(clip(s.replace(/\s*\([^()]*\)(?= - )/, ''), 80)) + '</span>' : '');
          } },
        { key: 'score', label: 'Score', type: 'num', digits: 0, title: 'Share of the active strategy\'s requirements met (0-100)',
          get: function (r) { var x = resOf(r); return x && x.status !== 'insufficient' ? x.score : null; } },
        { key: 'reason', label: 'Strategy reason', csvOnly: true, get: function (r) { return firstReason(resOf(r)); } },
        { key: 'rdate', label: 'Result date', type: 'date',
          html: function (r) {
            if (!r.rdate) return '<span class="sub">–</span>';
            var d = daysTo(r.rdate, ctx.refDate);
            return F.date(r.rdate) + (r.done ? ' <span title="Results ticked in the Main tab">✓</span>' : '') +
              (d != null && d >= 0 && d <= 14 ? ' <span class="sub">(' + (d === 0 ? 'today' : 'in ' + d + 'd') + ')</span>' : '');
          } }
      ]
    }).mount($('#ic-table', el));

    function apply() {
      var rows = list.filter(function (s) {
        if (CAT.bi && (s.ind || NONE) !== CAT.bi) return false;
        if (!ui.textMatch(CAT.q, [s.sym, s.name, s.ind])) return false;
        if (CAT.f === 'all') return true;
        if (CAT.f === 'results') { var d = daysTo(s.rdate, ctx.refDate); return d != null && d >= 0 && d <= 14; }
        var x = resOf(s);
        return !!x && x.status === CAT.f;
      });
      var strategyChip = CAT.f !== 'all' && CAT.f !== 'results';
      t.o.empty = strategyChip && runErr ? 'The strategy could not run, so strategy filters are unavailable (' + (runErr.message || runErr) + ')' :
        strategyChip && !run ? 'Running the active strategy… the list fills in when it is done' : 'No stocks match these filters';
      $('#ic-count', el).textContent = F.int(rows.length) + ' of ' + F.int(list.length) + ' stocks';
      t.setRows(rows);
    }
    function refreshChips() {
      var opts = chipOptions();
      el.querySelectorAll('[data-chip="ic"]').forEach(function (b) {
        var o = opts.filter(function (x) { return x[0] === b.getAttribute('data-v'); })[0];
        if (o) b.textContent = o[1];
      });
    }
    var timer;
    $('#ic-q', el).addEventListener('input', function (e) {
      clearTimeout(timer);
      timer = setTimeout(function () { CAT.q = e.target.value.trim(); apply(); }, 120);
    });
    $('#ic-bi-sel', el).addEventListener('change', function (e) { CAT.bi = e.target.value; apply(); });
    $('#ic-csv', el).addEventListener('click', function () { ui.download('industry-' + id + '.csv', ui.toCsv(t.toCsvRows())); });
    ui.bindChips(el, 'ic', function (v) { CAT.f = v; apply(); });
    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-bi]');
      if (!b) return;
      CAT.bi = b.getAttribute('data-bi');
      $('#ic-bi-sel', el).value = CAT.bi;
      apply();
      var card = $('#ic-stocks', el);
      var top = card.getBoundingClientRect().top + window.scrollY - 110;
      window.scrollTo(0, Math.max(0, top));
      $('#ic-bi-sel', el).focus({ preventScroll: true });
    });
    apply();

    runStrategy().then(function (r) {
      run = r;
      if (!el.isConnected) return;
      fillCandles(el, r, null);
      var ev = list.filter(function (s) { return !!r.bySym[s.sym]; });
      var cnt = countBy(ev.map(resOf), function (x) { return x.status; });
      $('#ic-qual', el).innerHTML = ev.length ? F.int(cnt.qualified || 0) : '<span class="sub">n/a</span>';
      $('#ic-qual-note', el).textContent = ev.length ?
        F.int(cnt.watch || 0) + ' watch · ' + F.int(cnt.avoid || 0) + ' avoid · ' + F.int(cnt.insufficient || 0) + ' insufficient data' +
        (ev.length < list.length ? ' · ' + F.int(list.length - ev.length) + ' outside the strategy universe' : '') :
        'this category is outside the active strategy\'s universe';
      refreshChips();
      bt.draw();
      apply();
    }, function (e) {
      runErr = e || new Error('unknown error');
      if (!el.isConnected) return;
      fillCandles(el, null, runErr);
      $('#ic-qual', el).innerHTML = '<span class="sub">–</span>';
      $('#ic-qual-note', el).textContent = 'strategy could not run';
      refreshChips();
      bt.draw();
      apply();
    });
  }

  // =====================================================================
  // #industries/review - classification review
  // =====================================================================
  function renderReview(el, ctx) {
    var rows = SB.classify.reviewList(ctx.stocks);
    function kind(i) {
      if (i === 'missing sector') return 'sector';
      if (i === 'missing basic industry') return 'basic';
      if (/^basic industry usually under/.test(i)) return 'unusual';
      if (/^unknown sector/.test(i)) return 'unknown';
      return 'other';
    }
    function has(r, k) { return r.issues.some(function (i) { return kind(i) === k; }); }
    var cnt = { sector: 0, basic: 0, unusual: 0, unknown: 0 };
    rows.forEach(function (r) { Object.keys(cnt).forEach(function (k) { if (has(r, k)) cnt[k]++; }); });
    var unclassified = ctx.stocks.filter(function (s) { return !s.cat; }).length;
    var menu = '<b>Auto Bhavcopy › 8. Symbols, Indices &amp; Main Upkeep</b>';

    var h = '<div class="page-head"><div>' + backLink() + '<h1>Classification review</h1>' +
      '<p>Stocks whose NSE classification is missing or unusual. These values come from the sheet\'s Main tab columns <b>Sector</b> and <b>Basic Industry</b> ' +
      '(the website never guesses them from a company name). Fix them in the sheet, then refresh the website data. ' +
      ui.stateBadge('CACHED', ctx.D.asOf || ctx.D.generated, 'Main tab Sector / Basic Industry') + '</p></div>' +
      '<div class="actions"><button class="btn" type="button" id="rv-csv"' + (rows.length ? '' : ' disabled') + '>Export CSV</button></div></div>';
    h += '<div class="tiles">' +
      ui.tile('Rows to review', F.int(rows.length), 'of ' + F.int(ctx.stocks.length) + ' stocks') +
      ui.tile('Unclassified', F.int(unclassified), 'in no dashboard category') +
      ui.tile('Missing sector', F.int(cnt.sector)) +
      ui.tile('Missing basic industry', F.int(cnt.basic)) +
      ui.tile('Unusual sector', F.int(cnt.unusual), 'sector differs from other stocks of the same basic industry') +
      '</div>';
    h += '<div class="note"><strong>How to fix in the sheet:</strong> type the stock\'s NSE Basic Industry in Main, then run ' + menu +
      ' › <b>Fill Sector/Industry from Basic Industry</b> (fills Sector and Industry from the NSE list). To check every row against the NSE list, run ' + menu +
      ' › <b>Audit Industry Classification vs NSE list</b> (writes the “Classification Audit” tab) and then <b>Fix Classification from Audit</b>. ' +
      'Afterwards download the workbook and drop it on <b>UpdateWebsiteData.bat</b> to refresh this site.</div>';
    if (!rows.length) {
      h += '<div class="note good">Every stock has an NSE sector and basic industry, and no basic industry sits under an unusual sector. Nothing to review.</div>';
      el.innerHTML = h;
      return;
    }
    h += '<section class="card"><div class="card-head"><div><h2>Stocks to review</h2><p>Unusual sector = most stocks of that basic industry are under another NSE sector.</p></div></div>' +
      '<div class="controls"><input class="search" id="rv-q" type="search" placeholder="Search symbol, company, sector or basic industry" aria-label="Search review list" value="' + esc(RV.q) + '"></div>' +
      '<div class="controls">' + ui.chips('rv', [['all', 'All (' + rows.length + ')'], ['sector', 'Missing sector (' + cnt.sector + ')'],
        ['basic', 'Missing basic industry (' + cnt.basic + ')'], ['unusual', 'Unusual sector (' + cnt.unusual + ')'], ['unknown', 'Unknown sector (' + cnt.unknown + ')']], RV.f) +
      '<span class="count" id="rv-count"></span></div><div id="rv-table"></div></section>';
    el.innerHTML = h;

    var t = new ui.Table({
      rows: [], pageSize: 50, sort: { key: 'symbol', dir: 1 }, empty: 'No stocks with this issue',
      columns: [
        { key: 'symbol', label: 'Stock', type: 'sym', name: 'name', csv: function (r) { return r.symbol; } },
        { key: 'name', label: 'Company', csvOnly: true },
        { key: 'sector', label: 'Sector (Main)', wrap: true },
        { key: 'basicIndustry', label: 'Basic Industry (Main)', wrap: true },
        { key: 'category', label: 'Dashboard category', wrap: true },
        { key: 'issues', label: 'Issues', wrap: true, get: function (r) { return r.issues.join('; '); },
          html: function (r) {
            return '<div class="tags">' + r.issues.map(function (i) {
              return ui.badge(i, kind(i) === 'other' ? '' : kind(i) === 'unusual' ? 's-info' : 's-warn');
            }).join('') + '</div>';
          } }
      ]
    }).mount($('#rv-table', el));
    function apply() {
      var out = rows.filter(function (r) {
        if (RV.f !== 'all' && !has(r, RV.f)) return false;
        return ui.textMatch(RV.q, [r.symbol, r.name, r.sector, r.basicIndustry, r.category]);
      });
      $('#rv-count', el).textContent = F.int(out.length) + ' of ' + F.int(rows.length);
      t.setRows(out);
    }
    var timer;
    $('#rv-q', el).addEventListener('input', function (e) {
      clearTimeout(timer);
      timer = setTimeout(function () { RV.q = e.target.value.trim(); apply(); }, 120);
    });
    ui.bindChips(el, 'rv', function (v) { RV.f = v; apply(); });
    $('#rv-csv', el).addEventListener('click', function () { ui.download('classification-review.csv', ui.toCsv(t.toCsvRows())); });
    apply();
  }

  SB.page('industries', {
    render: function (el, params, ctx) {
      var p = params && params[0];
      if (!p) renderOverview(el, ctx);
      else if (p === 'review') renderReview(el, ctx);
      else renderCategory(el, ctx, p);
    }
  });
})();
