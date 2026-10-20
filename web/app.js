/* Stock Blueprint dashboard - bootstrap, data context, router, search, drawer.
   Pages live in web/pages/*.js and register themselves with SB.page(id, {...}).
   Data: window.SB_DATA (data/dashboard.js, made by tools/export_xlsx.py) plus,
   when the Vercel api/ is deployed and a provider is configured, live quotes. */
(function () {
  'use strict';
  var SB = window.SB = window.SB || {};
  var ui = SB.ui;
  var $ = ui.$, esc = ui.esc, F = ui.F, isNum = ui.isNum;

  var PAGES = SB.pages;            // filled by web/pages/*.js via SB.page()

  var NAV = [
    ['overview', 'Overview'], ['watchlist', 'Watchlist'], ['suggestions', 'Daily Suggestions'],
    ['industries', 'Industries & Sectors'], ['strategy', 'Strategy Settings'], ['signals', 'Patterns & FVG'],
    ['excel', 'Excel Analysis'], ['results', 'Results & Events'], ['alerts', 'Alerts & Trades'],
    ['backtest', 'Backtesting'], ['markets', 'IPOs & Markets']
  ];

  // ---------- data context ----------
  var ctx = SB.ctx = {
    D: null, stocks: [], bySym: {}, refDate: new Date(),
    market: { state: 'CACHED', source: 'Sheet snapshot', asOf: null, provider: null, message: '' },
    history: null
  };

  function prepare(data) {
    ctx.D = data;
    var C = SB.classify;
    ctx.stocks = ui.objRows(data.main).map(function (s) {
      var c = C.classify({ sector: s.sector, industry: s.industry, ind: s.ind });
      s.id = 'NSE:' + s.sym;
      s.exchange = 'NSE';
      s.sector = c.sector;              // one spelling per sector
      s.ind = c.basicIndustry;
      s.cat = c.category;
      s.catName = c.categoryName;
      s.classIssues = c.issues;
      s.priceState = 'CACHED';
      s.priceAsOf = data.asOf || data.generated;
      return s;
    });
    ctx.bySym = {};
    ctx.stocks.forEach(function (s) { ctx.bySym[s.sym] = s; });
    ctx.refDate = ui.parseDate(data.asOf) || ui.parseDate(data.generated) || new Date();
    ctx.market.asOf = data.asOf || data.generated;
  }

  // History candles (data/history.js -> window.SB_HISTORY) are loaded on demand.
  SB.loadHistory = function () {
    if (ctx.history) return Promise.resolve(ctx.history);
    if (window.SB_HISTORY) { ctx.history = window.SB_HISTORY; return Promise.resolve(ctx.history); }   // inlined (preview file)
    return ui.loadScript('data/history.js').then(function () {
      ctx.history = window.SB_HISTORY || null;
      return ctx.history;
    });
  };

  // ---------- market data provider (optional, Vercel api/) ----------
  function apiGet(path, ms) {
    var ctl = window.AbortController ? new AbortController() : null;
    var to = setTimeout(function () { if (ctl) ctl.abort(); }, ms || 12000);
    return fetch(path, { signal: ctl ? ctl.signal : undefined, cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (r) {
        clearTimeout(to);
        var ct = r.headers.get('content-type') || '';
        if (ct.indexOf('json') < 0) throw new Error('no market-data API on this host');
        return r.json().then(function (j) { if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status)); return j; });
      }, function (e) { clearTimeout(to); throw e; });
  }
  SB.api = apiGet;

  function refreshQuotes() {
    var syms = ctx.stocks.map(function (s) { return s.sym; });
    var batches = [];
    for (var i = 0; i < syms.length; i += 500) batches.push(syms.slice(i, i + 500));
    var got = 0, state = null, asOf = null, source = null;
    return batches.reduce(function (p, b) {
      return p.then(function () {
        return apiGet('api/quotes?symbols=' + encodeURIComponent(b.join(','))).then(function (q) {
          if (!q || !q.items) return;
          state = q.state; asOf = q.asOf; source = q.source;
          q.items.forEach(function (it) {
            var s = ctx.bySym[it.symbol];
            if (!s || !isNum(it.ltp) || it.state === 'UNAVAILABLE') return;
            s.price = it.ltp;
            if (isNum(it.changePct)) s.chg = it.changePct;
            s.priceState = it.state || q.state;
            s.priceAsOf = it.lastTradeTime || q.asOf;
            s.liveVol = it.volume;
            got++;
          });
        });
      });
    }, Promise.resolve()).then(function () {
      if (got) {
        ctx.market.state = state || 'DELAYED';
        ctx.market.asOf = asOf;
        ctx.market.source = source || ctx.market.provider;
        ctx.market.message = got + ' of ' + syms.length + ' prices updated from ' + (source || 'provider');
      }
      return got;
    });
  }

  // The api/ functions exist only on the Vercel deployment. Skip the probe on
  // hosts that are static by design (localhost python server, Firebase, file://)
  // unless the viewer forces it (localStorage sb:api = true, e.g. for vercel dev).
  function apiPossible() {
    if (ui.store.get('api', null) === true) return true;
    var h = location.hostname;
    if (location.protocol === 'file:' || !h) return false;
    return !/^(localhost|127\.0\.0\.1|\[::1\])$|\.web\.app$|\.firebaseapp\.com$/.test(h);
  }

  function initMarket() {
    if (!apiPossible()) {
      ctx.market.message = 'This host serves the static site only (no market-data API) - showing the sheet snapshot.';
      setStatus();
      return;
    }
    apiGet('api/market-status', 8000).then(function (st) {
      ctx.market.provider = st.provider && st.provider.name;
      ctx.market.session = st.session;
      ctx.market.providerInfo = st.provider;
      if (!st.provider || !st.provider.configured || st.provider.name === 'none') {
        ctx.market.message = 'No market-data provider configured on the server - showing the sheet snapshot.';
        setStatus();
        return;
      }
      return refreshQuotes().then(function (n) {
        setStatus();
        if (n) route();
        if (ctx.market.state === 'LIVE') setTimeout(function loop() {
          refreshQuotes().then(function () { setStatus(); }).catch(function () {}).then(function () {
            if (ctx.market.state === 'LIVE') setTimeout(loop, 60000);
          });
        }, 60000);
      });
    }).catch(function (e) {
      ctx.market.message = 'Market-data API not available on this host (' + e.message + '). Showing the sheet snapshot.';
      setStatus();
    });
  }

  function setStatus() {
    var m = ctx.market, el = $('#status');
    el.className = 'status-pill st-' + m.state;
    el.innerHTML = esc(m.state) + (m.asOf ? '<span class="st-date"> · ' + esc(F.dateTime(m.asOf).replace(/ \d{4}( |$)/, '$1')) + '</span>' : '');
    el.title = (m.source ? 'Source: ' + m.source + '. ' : '') + (m.message || '');
  }
  SB.setStatus = setStatus;

  // ---------- router ----------
  function parseHash() {
    var h = (location.hash || '#overview').slice(1);
    var parts = h.split('/').map(function (p) { try { return decodeURIComponent(p); } catch (e) { return p; } });
    return { id: parts[0] || 'overview', params: parts.slice(1) };
  }
  function route() {
    if (!ctx.D) return;                         // still loading: boot routes later
    var r = parseHash();
    if (!PAGES[r.id]) r = { id: 'overview', params: [] };
    document.querySelectorAll('.tabs a').forEach(function (a) {
      if (a.getAttribute('data-tab') === r.id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    var app = $('#app');
    var host = document.createElement('div');   // fresh element per visit: no listener build-up
    host.className = 'page';
    app.replaceChildren(host);
    try {
      PAGES[r.id].render(host, r.params, ctx);
    } catch (err) {
      host.innerHTML = '<div class="note bad">This section could not be shown: ' + esc(err.message) + '</div>';
      if (window.console) console.error(err);
    }
    var cur = document.querySelector('.tabs a[aria-current]');
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    document.title = (r.id === 'overview' ? '' : (cur ? cur.textContent + ' · ' : '')) + 'Stock Blueprint';
  }
  SB.route = route;

  // ---------- global search ----------
  function initSearch() {
    var inp = $('#gsearch'), box = $('#gsearch-results'), active = -1, items = [];
    function close() { box.hidden = true; active = -1; }
    function render(q) {
      q = q.trim().toLowerCase();
      if (!q) { close(); return; }
      items = ctx.stocks.filter(function (s) {
        return ui.textMatch(q, [s.sym, s.name, s.ind, s.sector, s.catName, s.exchange]);
      }).sort(function (a, b) {
        var ax = a.sym.toLowerCase().indexOf(q) === 0 ? 0 : 1, bx = b.sym.toLowerCase().indexOf(q) === 0 ? 0 : 1;
        return ax - bx || a.sym.localeCompare(b.sym);
      }).slice(0, 12);
      if (!items.length) { box.innerHTML = '<p class="empty">No match</p>'; box.hidden = false; return; }
      box.innerHTML = items.map(function (s, i) {
        return '<button type="button" role="option" data-i="' + i + '"' + (i === active ? ' class="active"' : '') + '>' + ui.logoHtml(s.sym) +
          '<span><b>' + esc(s.sym) + '</b> <span class="co">' + esc(s.name || '') + '</span></span><span class="sub">' +
          esc(s.exchange + ' · ' + (s.ind || s.catName)) + '</span></button>';
      }).join('');
      box.hidden = false;
    }
    inp.addEventListener('input', function () { active = -1; render(inp.value); });
    inp.addEventListener('keydown', function (e) {
      if (box.hidden) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); render(inp.value); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); render(inp.value); }
      else if (e.key === 'Enter' && items[active < 0 ? 0 : active]) { e.preventDefault(); openStock(items[active < 0 ? 0 : active].sym, inp); close(); }
      else if (e.key === 'Escape') close();
    });
    box.addEventListener('click', function (e) {
      var b = e.target.closest('[data-i]');
      if (b) { openStock(items[+b.getAttribute('data-i')].sym, inp); close(); }
    });
    document.addEventListener('click', function (e) { if (!e.target.closest('.global-search')) close(); });
  }

  // ---------- stock drawer ----------
  function openStock(sym, opener) {
    var s = ctx.bySym[sym];
    var body = $('#drawer-body');
    var h;
    if (!s) {
      h = '<h2 id="drawer-title">' + esc(sym) + '</h2><p class="sub">Not in the Main watchlist.</p>';
    } else {
      var tags = [s.sig, s.pat, s.fvg, s.e10, s.e21, s.zone].filter(Boolean);
      h = '<div class="stock" style="padding-right:44px">' + ui.logoHtml(s.sym, 'lg') + '<div><h2 id="drawer-title">' + esc(s.sym) + '</h2>' +
        '<p class="sub">' + esc(s.name || '') + ' · ' + esc(s.exchange) + '</p></div></div>' +
        '<div style="display:flex;align-items:baseline;gap:12px;margin-top:12px;flex-wrap:wrap"><span style="font-size:28px;font-weight:600">' + F.price(s.price) +
        '</span>' + ui.deltaHtml(s.chg, 2) + ui.stateBadge(s.priceState, s.priceAsOf) + '</div>' +
        (tags.length ? '<div class="tags" style="margin-top:10px">' + tags.map(function (t, i) { return ui.badge(t, i === 0 && s.sig ? undefined : ''); }).join('') + '</div>' : '') +
        '<div id="drawer-strategy"></div>';
      var kv = [
        ['Category', esc(s.catName)], ['Sector', esc(s.sector || '–')], ['Basic industry', esc(s.ind || '–')], ['Index', esc(s.idx || '–')],
        ['Market cap', F.cr(s.mcap)], ['10-day', ui.deltaHtml(s.d10)], ['30-day', ui.deltaHtml(s.d30)], ['52W high', F.price(s.hi52)],
        ['From 52W high', ui.deltaHtml(s.down52)], ['PE', F.num(s.pe)], ['Industry PE', F.num(s.ipe)], ['PE / Industry PE', F.num(s.pevs)],
        ['TTM PEG', F.num(s.peg)], ['TTM EPS growth', F.num(s.epsg)], ['Target price', F.price(s.tgt)], ['Upside', ui.deltaHtml(s.up, 0)],
        ['Result date', F.date(s.rdate) + (s.done ? ' ✓' : '')], ['Revenue QoQ', ui.deltaHtml(s.qrev, 0)], ['Profit QoQ', ui.deltaHtml(s.qnp, 0)],
        ['Revenue YoY', ui.deltaHtml(s.yrev, 0)], ['Profit YoY', ui.deltaHtml(s.ynp, 0)], ['Promoter holding', esc(s.promo || '–')],
        ['FII activity', esc(s.fii || '–')], ['OPM YoY', esc(s.opmy || '–')], ['OPM QoQ', esc(s.opmq || '–')], ['Volume change', ui.deltaHtml(s.volchg, 0)]
      ];
      h += '<dl class="kv">' + kv.map(function (p) { return '<div><dt>' + p[0] + '</dt><dd>' + p[1] + '</dd></div>'; }).join('') + '</dl>' +
        '<div id="drawer-chart" style="margin-top:14px"></div>';
    }
    h += '<div class="links"><a class="btn" target="_blank" rel="noopener" href="https://www.screener.in/company/' + encodeURIComponent(sym) + '/">Screener.in ↗</a>' +
      '<a class="btn" target="_blank" rel="noopener" href="https://www.tradingview.com/chart/?symbol=' + encodeURIComponent('NSE:' + sym) + '">Chart ↗</a></div>';
    body.innerHTML = h;
    var dr = $('#drawer');
    dr.hidden = false;
    dr._opener = opener || document.activeElement;
    document.body.style.overflow = 'hidden';
    $('.drawer-x', dr).focus();
    if (s && SB.onStockDrawer) SB.onStockDrawer(s, body);
  }
  SB.openStock = openStock;
  function closeDrawer() {
    var dr = $('#drawer');
    if (dr.hidden) return;
    dr.hidden = true;
    document.body.style.overflow = '';
    if (dr._opener && dr._opener.focus) dr._opener.focus();
  }

  // ---------- tooltip ----------
  function initTip() {
    var tip = $('#tip');
    function show(el, x, y) {
      tip.textContent = el.getAttribute('data-tip');
      tip.hidden = false;
      var r = tip.getBoundingClientRect();
      tip.style.left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x + 12)) + 'px';
      var top = y - r.height - 12;
      tip.style.top = (top < 8 ? y + 16 : top) + 'px';
    }
    document.addEventListener('pointermove', function (e) {
      if (e.target.closest && e.target.closest('.chart')) return;   // charts manage the tip themselves
      var el = e.target.closest && e.target.closest('[data-tip]');
      if (el) show(el, e.clientX, e.clientY); else tip.hidden = true;
    });
    document.addEventListener('focusin', function (e) {
      var el = e.target.closest && e.target.closest('[data-tip]');
      if (el) { var r = el.getBoundingClientRect(); show(el, r.left + r.width / 2, r.top); } else tip.hidden = true;
    });
    document.addEventListener('scroll', function () { tip.hidden = true; }, true);
  }

  // ---------- boot ----------
  function buildNav() {
    $('.tabs').innerHTML = NAV.map(function (n) { return '<a href="#' + n[0] + '" data-tab="' + n[0] + '">' + esc(n[1]) + '</a>'; }).join('');
  }

  document.addEventListener('click', function (e) {
    var s = e.target.closest('[data-sym]');
    if (s && !e.target.closest('.search-results')) { e.preventDefault(); openStock(s.getAttribute('data-sym'), s); return; }
    if (e.target.closest('[data-close]')) closeDrawer();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeDrawer();
    if (e.key === 'Tab' && !$('#drawer').hidden) {           // keep focus inside the open drawer
      var f = $('#drawer .drawer-panel').querySelectorAll('button, a[href], input, select');
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  window.addEventListener('hashchange', function () { closeDrawer(); route(); $('#app').focus({ preventScroll: true }); window.scrollTo(0, 0); });
  $('#status').addEventListener('click', function () { location.hash = '#overview/data'; });

  function initTheme() {
    var root = document.documentElement, btn = $('#theme');
    function apply(t) {
      if (t === 'dark') root.setAttribute('data-theme', 'dark'); else root.removeAttribute('data-theme');
      btn.setAttribute('aria-pressed', String(t === 'dark'));
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', t === 'dark' ? '#0f1115' : '#ffffff');
    }
    apply(ui.store.get('theme', 'light'));
    btn.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      ui.store.set('theme', next);
      apply(next);
    });
  }

  buildNav();
  initTheme();
  initTip();
  if (window.SB_DATA) {
    prepare(window.SB_DATA);
    initSearch();
    setStatus();
    route();
    initMarket();
  } else {
    $('#app').innerHTML = '<div class="note bad">No data file found (data/dashboard.js). Run tools/export_xlsx.py first.</div>';
  }
})();
