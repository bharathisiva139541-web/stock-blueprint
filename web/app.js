/* Stock Blueprint dashboard - bootstrap, data context, router, search, drawer.
   Pages live in web/pages/*.js and register themselves with SB.page(id, {...}).
   Data: read from the Google Sheet through the Vercel api/site (Code.gs doPost
   action 'site', read-only) whenever an API is reachable (SB.apiBase); if that
   fails, or on static-only hosts, the saved copy window.SB_DATA (data/dashboard.js,
   made by tools/export_xlsx.py), clearly labelled. When a provider is configured,
   api/quotes adds live or delayed prices on top. */
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

  // api/site waits up to 25 s for the sheet and Vercel stops it at 30 s (maxDuration): wait
  // longer than both, so its answer (the last good copy, or a clear reason) always arrives
  var SITE_TIMEOUT_MS = 32000;
  var LIVE_SOURCE = 'Google Sheet live feed (GOOGLEFINANCE, ~20 min delayed in market hours)';

  // ---------- data context ----------
  var ctx = SB.ctx = {
    D: null, stocks: [], bySym: {}, refDate: new Date(),
    market: { state: 'CACHED', source: 'Sheet snapshot', asOf: null, provider: null, message: '' },
    // where ctx.D came from: { live, apiBase, readAt, fetchedAt, stale, staleReason, generated, asOf, reason, historyReason }
    site: { live: false, apiBase: null },
    history: null
  };

  // Sheet prices come from GOOGLEFINANCE: never LIVE, whatever a server says.
  function sheetState(st) {
    if (st === 'LIVE') return 'DELAYED';
    return st === 'DELAYED' || st === 'EOD' || st === 'CACHED' ? st : 'CACHED';
  }

  /** IST 'YYYY-MM-DD HH:MM' -> epoch ms (IST is UTC+05:30 all year), or null. */
  function istMs(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(String(s || ''));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - 330 * 60000 : null;
  }

  /** meta: { live:true, resp } (api/site reply) or { live:false, reason } (saved copy). */
  function prepare(data, meta) {
    var live = !!(meta && meta.live), r = live ? meta.resp : {};
    var C = SB.classify;
    var state = live ? sheetState(r.priceState) : 'CACHED';
    // The CDN may hand out an older reply while it refreshes (stale-while-revalidate), so
    // DELAYED ages from the sheet read itself (readAt), like a quote, not from page load.
    var readMs = live ? istMs(r.readAt) : null;
    var aged = state === 'DELAYED' && readMs !== null && Date.now() - readMs > QUOTE_TTL.DELAYED;
    if (aged) state = 'CACHED';
    var asOf = live ? r.readAt || data.generated : data.asOf || data.generated;
    var stocks = ui.objRows(data.main).map(function (s) {
      var c = C.classify({ sector: s.sector, industry: s.industry, ind: s.ind });
      s.id = 'NSE:' + s.sym;
      s.exchange = 'NSE';
      s.sector = c.sector;              // one spelling per sector
      s.ind = c.basicIndustry;
      s.cat = c.category;
      s.catName = c.categoryName;
      s.classIssues = c.issues;
      s.priceState = state;
      s.priceAsOf = asOf;
      s.sigSheet = s.sig;               // the cell as exported; s.sig follows the price shown
      applySignal(s);
      return s;
    });
    ctx.D = data;
    ctx.stocks = stocks;
    ctx.bySym = {};
    ctx.stocks.forEach(function (s) { ctx.bySym[s.sym] = s; });
    var m = ctx.market;
    m.state = state;
    m.asOf = asOf;
    m.live = live;
    if (live) {
      ctx.refDate = ui.parseDate(r.readAt) || ui.parseDate(data.generated) || new Date();
      m.source = LIVE_SOURCE;
      m.stale = !!r.stale;
      m.session = r.session || null;
      m.fetchedAt = readMs !== null ? readMs : Date.now();   // DELAYED expires like a quote (checkExpiry) unless refreshed
      m.message = 'Read from your Google Sheet at ' + F.dateTime(r.readAt) + ' IST' +
        (aged ? ' - over ' + Math.round(QUOTE_TTL.DELAYED / 60000) + ' minutes ago, so shown as CACHED; reload the page for newer data' : '') +
        (r.stale ? ' - the last good copy: the newest read failed (' + (r.staleReason || 'unknown reason') + ')' : '') + '.';
    } else {
      ctx.refDate = ui.parseDate(data.asOf) || ui.parseDate(data.generated) || new Date();
      m.source = 'Sheet snapshot (saved copy)';
      m.fallbackReason = (meta && meta.reason) || null;
      m.message = 'Saved copy of the sheet' + (m.fallbackReason ? ' - live data could not be loaded: ' + m.fallbackReason : '') + '.';
    }
    ctx.site = {
      live: live, apiBase: ctx.site.apiBase, generated: data.generated || null, asOf: data.asOf || null,
      readAt: live ? r.readAt || null : null, fetchedAt: live ? r.fetchedAt || null : null,
      stale: live && !!r.stale, staleReason: live ? r.staleReason || null : null,
      reason: live ? null : (meta && meta.reason) || null, historyReason: null
    };
  }

  // TTM Signal by the sheet's fixed rule (ab_fixSignalFormulas_) at the price shown,
  // so every page agrees with the strategy engine. No TTM target -> keep the sheet cell.
  function applySignal(s) {
    s.sig = isNum(s.tgt) && isNum(s.price) ? SB.strategy.ttmSignal(s, s.price) || null : s.sigSheet || null;
  }

  function validMain(d) {
    return !!(d && d.main && Array.isArray(d.main.cols) && Array.isArray(d.main.rows) && d.main.rows.length && d.main.cols.indexOf('sym') >= 0);
  }
  function validHistory(d) {
    return !!(d && Array.isArray(d.dates) && d.dates.length && d.bars && typeof d.bars === 'object');
  }

  // History candles are loaded on demand: from api/site?part=history when the
  // boot used the live feed, else (or when that fails) data/history.js.
  var historyLoad = null;
  function staticHistory() {
    return ui.loadScript('data/history.js').then(function () {
      ctx.history = window.SB_HISTORY || null;
      return ctx.history;
    });
  }
  SB.loadHistory = function () {
    if (ctx.history) return Promise.resolve(ctx.history);
    if (window.SB_HISTORY) { ctx.history = window.SB_HISTORY; return Promise.resolve(ctx.history); }   // inlined (preview file) or loaded
    if (historyLoad) return historyLoad;                                // one request for every page asking at once
    var p = !ctx.site.live ? staticHistory() : apiGet('api/site?part=history', SITE_TIMEOUT_MS).then(function (r) {
      if (!r || r.ok !== true || !validHistory(r.data)) throw new Error((r && r.message) || 'the live feed returned no candle data');
      var H = r.data;
      H.live = true;
      H.readAt = r.readAt || null;
      H.stale = !!r.stale;
      ctx.history = H;
      return H;
    }).catch(function (e) {
      ctx.site.historyReason = e.message || String(e);
      return staticHistory();
    });
    historyLoad = p.then(function (H) { historyLoad = null; return H; }, function (e) { historyLoad = null; throw e; });
    return historyLoad;
  };

  // ---------- API base (Vercel api/: live sheet feed + market data) ----------
  // ''   same-origin api/ (the Vercel deployment, or localhost with sb:api = true, e.g. vercel dev)
  // URL  the Vercel API used by the static Firebase copy (web/config.js remoteApi; it sends CORS *)
  // null no API: localhost python server, file://, Firebase without remoteApi -> saved copy only
  function apiBaseFor(hostname, protocol, forced, remote) {
    var h = String(hostname || '');
    if (/\.web\.app$|\.firebaseapp\.com$/.test(h)) {
      return typeof remote === 'string' && /^https:\/\/[^/\s]+/.test(remote) ? remote.replace(/\/*$/, '/') : null;
    }
    if (forced === true) return '';
    if (protocol === 'file:' || !h) return null;
    return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(h) ? null : '';
  }
  function apiBase() {
    return apiBaseFor(location.hostname, location.protocol, ui.store.get('api', null), window.SB_CONFIG && window.SB_CONFIG.remoteApi);
  }
  SB.apiBase = apiBase;
  SB.apiBaseFor = apiBaseFor;

  function apiGet(path, ms) {
    var base = ctx.site.apiBase;
    if (base == null) return Promise.reject(new Error('no API on this host'));
    var ctl = window.AbortController ? new AbortController() : null, timedOut = false;
    var to = setTimeout(function () { timedOut = true; if (ctl) ctl.abort(); }, ms || 12000);
    return fetch(base + path, { signal: ctl ? ctl.signal : undefined, cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (r) {
        var ct = r.headers.get('content-type') || '';
        if (ct.indexOf('json') < 0) throw new Error(r.ok ? 'no API on this host' : 'HTTP ' + r.status + ' from the API');
        return r.json().then(function (j) { if (!r.ok) throw new Error((j && (j.error || j.message)) || ('HTTP ' + r.status)); return j; });
      })
      .then(function (j) { clearTimeout(to); return j; }, function (e) {
        clearTimeout(to);
        if (timedOut) throw new Error('no answer within ' + Math.round((ms || 12000) / 1000) + ' s');
        if (e && e.name === 'TypeError') throw new Error('the API could not be reached (network error)');   // fetch() failed
        if (e && e.name === 'SyntaxError') throw new Error('the API sent a malformed answer');
        throw e;
      });
  }
  SB.api = apiGet;

  // ---------- market data provider (optional, Vercel api/) ----------
  function sheetWord() { return ctx.site.live ? 'the prices read from your Google Sheet' : 'the saved sheet snapshot'; }

  var QUOTE_TTL = { LIVE: 5 * 60000, DELAYED: 30 * 60000 };   // older than this -> shown as CACHED
  var POLL_MS = { LIVE: 60000, DELAYED: 5 * 60000 };
  function refreshQuotes() {
    var syms = ctx.stocks.map(function (s) { return s.sym; });
    var batches = [];
    for (var i = 0; i < syms.length; i += 500) batches.push(syms.slice(i, i + 500));
    var got = 0, states = [], asOf = null, source = null, failMsg = null;
    return batches.reduce(function (p, b) {
      return p.then(function () {
        return apiGet('api/quotes?symbols=' + encodeURIComponent(b.join(','))).then(function (q) {
          if (!q || !q.items) return;
          if (q.state === 'UNAVAILABLE' && q.message) failMsg = q.message;
          if (!asOf || (q.asOf && q.asOf < asOf)) asOf = q.asOf;      // oldest batch time
          source = q.source;
          q.items.forEach(function (it) {
            var s = ctx.bySym[it.symbol];
            if (!s || !isNum(it.ltp) || it.state === 'UNAVAILABLE') return;
            s.price = it.ltp;
            if (isNum(it.changePct)) s.chg = it.changePct;
            s.priceState = it.state || q.state;
            s.priceAsOf = it.lastTradeTime || q.asOf;
            s.liveVol = it.volume;
            applySignal(s);
            states.push(s.priceState);
            got++;
          });
        });
      });
    }, Promise.resolve()).then(function () {
      var m = ctx.market;
      if (got) {
        m.state = ui.leastFresh(states);                 // never better than the stalest price returned
        m.asOf = asOf;
        m.fetchedAt = Date.now();
        m.source = source || m.provider;
        m.partial = got < syms.length;
        m.message = got + ' of ' + syms.length + ' prices updated from ' + (source || 'provider') +
          (m.partial ? '; the rest are ' + (ctx.site.live ? 'from the sheet live feed' : 'the sheet snapshot (CACHED)') : '');
      } else if (failMsg) {
        // the provider answered but had nothing: say why, keep the state of the prices shown
        m.message = 'Quotes unavailable: ' + failMsg + ' - showing ' + sheetWord() + '.';
      }
      return got;
    });
  }
  // a failed refresh or an expired quote must not keep a LIVE / DELAYED label
  function downgrade(reason) {
    var m = ctx.market;
    if (m.state !== 'LIVE' && m.state !== 'DELAYED') return false;
    m.state = 'CACHED';
    m.message = reason + ' - prices shown are the last ones received (' + F.dateTime(m.asOf) + '). Reload the page for newer data.';
    ctx.stocks.forEach(function (s) { if (s.priceState === 'LIVE' || s.priceState === 'DELAYED') s.priceState = 'CACHED'; });
    return true;
  }
  function checkExpiry() {
    var m = ctx.market, ttl = QUOTE_TTL[m.state];
    if (ttl && m.fetchedAt && Date.now() - m.fetchedAt > ttl && downgrade('Prices not refreshed for over ' + Math.round(ttl / 60000) + ' minutes')) { setStatus(); rerender(); }
  }
  // re-draw the current page with the new prices, unless the viewer is typing in it
  function rerender() {
    var a = document.activeElement;
    if (a && a.closest && a.closest('#app') && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return;
    if (!$('#drawer').hidden) return;
    var y = window.scrollY;
    route();
    window.scrollTo(0, y);
  }

  function loadStatus() {
    // longer than the server's own wait for the provider (the 'sheet' snapshot: up to 10 s)
    return apiGet('api/market-status', 12000).then(function (st) {
      var m = ctx.market;
      m.provider = st.provider && st.provider.name;
      if (st.session) m.session = st.session;
      m.providerInfo = st.provider;
      if (st.provider && st.provider.configured && st.status && st.status.ok === false) {
        m.message = 'Market-data provider problem: ' + (st.status.message || 'no reason given') + ' - showing ' + sheetWord() + '.';
      }
      return st;
    });
  }

  // Poll LIVE quotes every minute and DELAYED ones every 5 minutes while the NSE
  // session is open; stop otherwise. After a failure retry a few times so a short outage recovers.
  function pollDelay(fails) {
    var m = ctx.market;
    if (m.state === 'LIVE') return POLL_MS.LIVE;
    if (m.state === 'DELAYED' && m.session && m.session.state === 'open') return POLL_MS.DELAYED;
    return fails > 0 && fails < 5 ? POLL_MS.LIVE : 0;
  }
  function schedulePoll(fails) {
    var ms = pollDelay(fails);
    if (!ms) return;
    setTimeout(function () {
      // DELAYED polls re-read the session first, so polling stops at the close
      var pre = ctx.market.state === 'DELAYED' ? loadStatus().catch(function () { return null; }) : Promise.resolve();
      pre.then(refreshQuotes).then(function (k) { setStatus(); if (k) rerender(); schedulePoll(0); }, function (e) {
        if (downgrade('Quote refresh failed (' + e.message + ')')) { setStatus(); rerender(); }
        schedulePoll(fails + 1);
      });
    }, ms);
  }

  function initMarket() {
    var m = ctx.market;
    if (ctx.site.apiBase == null) {
      m.message = 'This host serves the static site only (no market-data API) - showing ' + sheetWord() + '.';
      setStatus();
      return;
    }
    loadStatus().then(function (st) {
      if (!st.provider || !st.provider.configured || st.provider.name === 'none') {
        m.message = 'No market-data provider configured on the server - showing ' + sheetWord() + '.';
        setStatus();
        return;
      }
      return refreshQuotes().then(function (n) {
        setStatus();
        if (n) rerender();
        schedulePoll(0);
      });
    }).catch(function (e) {
      m.message = 'Market-data API not available (' + e.message + ') - showing ' + sheetWord() + '.';
      setStatus();
    });
  }

  function setStatus() {
    var m = ctx.market, el = $('#status');
    el.className = 'status-pill st-' + m.state;
    el.innerHTML = esc(m.state) + (m.asOf ? '<span class="st-date"> · ' + esc(F.dateTime(m.asOf).replace(/ \d{4}( |$)/, '$1')) + (m.partial ? ' · partial' : '') + '</span>' : '');
    el.title = (m.source ? 'Source: ' + m.source + '. ' : '') + (m.message || '');
    if (SB.refreshDataStatus) SB.refreshDataStatus();     // Overview "Data & provider status", when shown
  }
  SB.setStatus = setStatus;

  // Banner under the header whenever the page does not show a fresh live read.
  function setBanner() {
    var el = $('#site-banner'), S = ctx.site, h = '';
    if (!el) return;
    if (S.live) {
      if (S.stale) {
        h = '<div class="note">Live feed: showing the last good copy read from your Google Sheet at ' + F.dateTime(S.readAt) +
          '. The newest read failed: ' + esc(S.staleReason || 'unknown reason') + '.</div>';
      }
    } else if (ctx.D) {
      var t = S.asOf || S.generated, d = ui.parseDate(t), n = d ? ui.dayDiff(new Date(), d) : null;
      var age = n == null ? '' : n <= 0 ? ' (today)' : ' (' + n + (n === 1 ? ' day' : ' days') + ' old)';
      h = '<div class="note warn"><b>Showing a saved copy</b> from ' + F.dateTime(t) + age + '. ' +
        (S.reason ? 'Live data could not be loaded: ' + esc(S.reason) + '.' : 'This copy is not updated automatically.') + '</div>';
    }
    el.innerHTML = h;
    el.hidden = !h;
  }

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
      var tags = [s.sig ? 'TTM Signal: ' + s.sig : '', s.pat, s.fvg, s.e10, s.e21, s.zone].filter(Boolean);
      h = '<div class="stock" style="padding-right:44px">' + ui.logoHtml(s.sym, 'lg') + '<div><h2 id="drawer-title">' + esc(s.sym) + '</h2>' +
        '<p class="sub">' + esc(s.name || '') + ' · ' + esc(s.exchange) + '</p></div></div>' +
        '<div style="display:flex;align-items:baseline;gap:12px;margin-top:12px;flex-wrap:wrap"><span style="font-size:28px;font-weight:600">' + F.price(s.price) +
        '</span>' + ui.deltaHtml(s.chg, 2) + ui.stateBadge(s.priceState, s.priceAsOf) + '</div>' +
        (tags.length ? '<div class="tags" style="margin-top:10px">' + tags.map(function (t, i) { return ui.badge(t, i === 0 && s.sig ? (s.sig === 'Buy' ? 's-good' : s.sig === 'Avoid' ? 's-bad' : '') : ''); }).join('') + '</div>' : '') +
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
    // touch screens have no hover: a tap on a tip-bearing element shows its tip
    document.addEventListener('click', function (e) {
      var el = e.target.closest && e.target.closest('[data-tip]');
      if (!el) { tip.hidden = true; return; }
      if (el.closest('.chart') || el.closest('button, a[href]')) return;
      var r = el.getBoundingClientRect();
      show(el, r.left + r.width / 2, r.top);
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
  $('#status').addEventListener('click', function () {
    if (location.hash === '#overview/data') { var d = $('#ov-data'); if (d) d.scrollIntoView({ block: 'start' }); }   // no hashchange: scroll again
    else location.hash = '#overview/data';
  });

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

  // Data: live feed first (api/site?part=main) when this host has an API, else / on
  // any failure the saved copy - inlined (single-file preview) or data/dashboard.js.
  function loadStatic() {
    if (window.SB_DATA) return Promise.resolve(window.SB_DATA);
    return ui.loadScript('data/dashboard.js').then(function () { return window.SB_DATA || null; }, function () { return null; });
  }
  function loadLive() {
    return apiGet('api/site?part=main', SITE_TIMEOUT_MS).then(function (r) {
      if (r && r.ok === true && validMain(r.data)) return { resp: r };
      return { reason: (r && r.message) || 'the live feed returned no data' };
    }, function (e) { return { reason: e.message || String(e) }; });
  }
  function start() {
    initSearch();
    setStatus();
    setBanner();
    route();
    window.setInterval(checkExpiry, 30000);
    initMarket();
  }
  function boot() {
    var base = ctx.site.apiBase = apiBase();
    $('#app').innerHTML = '<section class="card" aria-busy="true"><h2>Loading…</h2><p class="sub" style="margin-top:4px">' +
      (base == null ? 'Loading the saved copy of your Google Sheet data…' : 'Loading the latest data from your Google Sheet…') + '</p>' + ui.skeleton(3) + '</section>';
    (base == null ? Promise.resolve({ reason: null }) : loadLive()).then(function (o) {
      if (o.resp) {
        try { prepare(o.resp.data, { live: true, resp: o.resp }); } catch (e) {
          o = { reason: 'the live data could not be read (' + e.message + ')' };   // malformed feed: use the saved copy
        }
        if (o.resp) { start(); return; }
      }
      return loadStatic().then(function (D) {
        if (D) { prepare(D, { live: false, reason: o.reason }); start(); return; }
        ctx.market.state = 'UNAVAILABLE';
        ctx.market.message = 'No data could be loaded.';
        setStatus();
        $('#app').innerHTML = '<div class="note bad">No data file found (data/dashboard.js). Run tools/export_xlsx.py first.' +
          (o.reason ? ' Live data could not be loaded either: ' + esc(o.reason) + '.' : '') + '</div>';
      });
    }).catch(function (e) {
      if (window.console) console.error(e);
      $('#app').innerHTML = '<div class="note bad">The site could not start: ' + esc(e.message) + '</div>';
    });
  }

  buildNav();
  initTheme();
  initTip();
  boot();
})();
