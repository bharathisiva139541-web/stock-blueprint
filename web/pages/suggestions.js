/* Daily Suggestions - powered by the active strategy (web/lib/strategy.js).
   Workflow: data -> freshness check -> indicators -> rules per stock ->
   filters -> ranking (score, confluence, R:R) -> explanations + risk. */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, esc = ui.esc, F = ui.F, isNum = ui.isNum, $ = ui.$;
  var ST = { list: 'qualified', cat: '', q: '', shown: 20 };

  var LISTS = [
    ['qualified', 'Qualified'], ['breakout', 'Breakout'], ['pullback', 'Pullback'], ['watch', 'Watchlist candidates'],
    ['exits', 'Exit / risk warnings'], ['avoid', 'Avoid / no-trade'], ['insufficient', 'Insufficient data'], ['none', 'No valid signal']
  ];

  function journalOpen() {
    var j = ui.store.get('journal:v1', null);
    var arr = Array.isArray(j) ? j : j && Array.isArray(j.trades) ? j.trades : j && Array.isArray(j.entries) ? j.entries : [];
    return arr.filter(function (t) {
      var closed = t.closed || t.status === 'closed' || isNum(Number(t.exitPrice)) && Number(t.exitPrice) > 0 || isNum(Number(t.exit)) && Number(t.exit) > 0;
      return !closed;
    }).map(function (t) {
      return { sym: String(t.sym || t.symbol || '').toUpperCase(), entry: Number(t.entry || t.entryPrice), stop: Number(t.stop || t.stopLoss || t.stoploss), target: Number(t.target), qty: Number(t.qty || t.quantity) };
    }).filter(function (p) { return p.sym && p.entry > 0; });
  }

  function checksHtml(r) {
    return '<ul class="checks">' + (r.checks || []).map(function (k) {
      var p = k.res.pass, mark = p === true ? '<span class="ok" aria-label="passed">✓</span>' : p === false ? '<span class="no" aria-label="failed">✗</span>' : '<span class="na" aria-label="not applicable">–</span>';
      var tag = k.group === 'filter' ? 'Filter' : k.group === 'trigger' ? (k.watchOnly ? 'Watch' : 'Signal') : 'Requirement';
      return '<li>' + mark + '<span><b>' + esc(tag) + ':</b> ' + esc(k.label) + (k.res.detail ? ' <span class="sub">(' + esc(k.res.detail) + ')</span>' : '') + '</span></li>';
    }).join('') + '</ul>';
  }

  function itemHtml(r, s, run, risk) {
    var size = null;
    if (r.stop > 0 && r.entry > 0) size = SB.risk.sizePosition({ entry: r.entry, stop: r.stop, target: r.target, industry: s.catName }, risk);
    var setup = (r.setupTypes || []).filter(function (t) { return t !== 'screen'; }).map(function (t) { return t === 'pullback' ? 'Pullback / support' : t === 'reversal' ? 'Reversal pattern' : t === 'breakout' ? 'Breakout' : t; });
    var screen = run.config.mode === 'screen';
    var h = '<article class="sugg-item">';
    h += '<div><div class="stock">' + ui.logoHtml(s.sym, 'lg') + '<div class="txt"><button type="button" class="linkish" data-sym="' + esc(s.sym) + '">' + esc(s.sym) + '</button>' +
      '<span class="co">' + esc(s.name || '') + '</span><span class="sub">' + esc(s.exchange) + ' · ' + esc(s.catName) + (s.ind ? ' · ' + esc(s.ind) : '') + '</span></div></div>' +
      '<div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin-top:8px"><b style="font-size:17px">' + F.price(s.price) + '</b>' + ui.deltaHtml(s.chg, 2) + ui.stateBadge(s.priceState, s.priceAsOf) + '</div>' +
      (r.warnings && r.warnings.length ? '<div class="note warn" style="margin-top:8px">' + r.warnings.map(esc).join('<br>') + '</div>' : '') + '</div>';
    h += '<div><div class="sub">Strategy match</div><div class="score">' + r.score + '%</div><div class="meter" aria-hidden="true"><span style="width:' + r.score + '%"></span></div>' +
      '<div class="sub" style="margin-top:4px">' + esc(r.scoreNote || '') + ' - rule satisfaction, not a probability of profit</div>' +
      '<div class="tags" style="margin-top:8px">' + ui.badge(r.statusLabel) + setup.map(function (t) { return ui.badge(t, 's-info'); }).join('') +
      (isNum(r.confluence) ? ui.badge('Confluence ' + r.confluence + '/4', '') : '') + '</div>';
    if (!screen) {
      h += '<dl class="kv2" style="margin-top:10px"><dt>Entry ref.</dt><dd>' + F.price(r.entry) + ' <span class="sub">close ' + esc(r.asOf || '') + '</span></dd>' +
        '<dt>Stop-loss</dt><dd>' + (r.stop > 0 ? F.price(r.stop) + ' <span class="sub">' + esc(r.stopNote || '') + '</span>' : '–') + '</dd>' +
        '<dt>Target</dt><dd>' + (r.target > 0 ? F.price(r.target) + ' <span class="sub">' + esc(r.targetNote || '') + '</span>' : '–') + '</dd>' +
        '<dt>Reward : risk</dt><dd>' + (isNum(r.rr) ? '1 : ' + F.num(r.rr, 2) : '–') + '</dd>' +
        '<dt>Position size</dt><dd>' + (size && size.ok ? F.int(size.qty) + ' sh · risk ' + F.inr(size.riskAmount) : size ? '<span class="sub">' + esc(size.errors[0] || 'n/a') + '</span>' : '–') + '</dd></dl>';
    }
    h += '</div>';
    h += '<div><div class="sub">Why</div>' + checksHtml(r) +
      (r.failed && r.failed.length && r.status !== 'qualified' ? '<div class="sub" style="margin-top:6px"><b>Not qualified because:</b> ' + r.failed.map(esc).join('; ') + '</div>' : '') +
      '<div class="sub" style="margin-top:6px">TTM Signal: ' + esc(SB.strategy.ttmSignal(s, s.price) || '–') + ' · Avg turnover filter, volume & liquidity from daily candles</div></div>';
    return h + '</article>';
  }

  SB.page('suggestions', {
    render: function (el, params, ctx) {
      var cfg = SB.strategies.get(SB.strategies.activeId());
      var confirmed = SB.strategies.isConfirmed(cfg.id);
      var head = '<div class="page-head"><div><h1>Daily suggestions</h1><p>Stocks that meet the active strategy\'s rules, with the reason for every pass and fail. ' +
        'Research and decision-support only - no orders are placed.</p></div><div class="actions"><a class="btn" href="#strategy">Strategy settings</a><button class="btn" type="button" id="sg-csv">Export CSV</button></div></div>';
      var badge = cfg.source === 'demo' ? ui.badge('DEMO', 's-warn') : confirmed ? ui.badge('Confirmed by you (v' + cfg.version + ')', 's-good') : ui.badge('From your sheet - not yet confirmed', 's-warn');
      head += '<section class="card"><div class="card-head"><div><h2>' + esc(cfg.name) + ' · v' + cfg.version + '</h2><p>' + esc(cfg.description || '') + '</p></div><div class="tags">' + badge +
        ui.badge(cfg.mode === 'screen' ? 'Fundamental screen' : 'Entry setups', 's-info') + ui.badge((cfg.style || 'swing') + ' · daily candles', '') + '</div></div>' +
        (cfg.source === 'demo' ? '<div class="note bad"><strong>DEMO strategy.</strong> Its results are for testing the engine only - they are not your strategy and not recommendations.</div>' :
          !confirmed ? '<div class="note warn"><strong>Unconfirmed rules.</strong> These rules were taken from your sheet (Code.gs), but the way they are combined into a suggestion, and the stop/target method, are assumptions until you confirm them in <a href="#strategy">Strategy settings</a>. Treat this as a research shortlist.' +
            (cfg.assumptions && cfg.assumptions.length ? '<ul style="margin:6px 0 0 18px;padding:0">' + cfg.assumptions.map(function (a) { return '<li>' + esc(a) + '</li>'; }).join('') + '</ul>' : '') + '</div>' : '') +
        '<div id="sg-fresh" style="margin-top:10px"></div></section>';
      el.innerHTML = head + '<section class="card"><div id="sg-body">' + ui.skeleton(6) + '</div></section>' +
        '<details class="card"><summary><b>How these suggestions are produced</b></summary><ol style="margin:10px 0 0 18px;padding:0;color:var(--ink-2)">' +
        '<li>Load the daily candles (History30 from your sheet) and the latest prices (sheet snapshot, or a configured market-data provider).</li>' +
        '<li>Check freshness: a stock whose last candle is older than the latest session is listed under "Insufficient data", never signalled.</li>' +
        '<li>Compute the indicators the rules need (patterns, FVG, EMA support, ATR, turnover) using only past and current bars.</li>' +
        '<li>Evaluate every filter, signal and requirement of the strategy for each stock.</li>' +
        '<li>Apply the liquidity / circuit-lock / event filters - failures go to "Avoid".</li>' +
        '<li>Rank by match score (share of requirements met), then confluence, then reward:risk.</li>' +
        '<li>Compute entry reference, stop-loss, target, reward:risk and a position size from your risk settings (Alerts &amp; Trades page).</li>' +
        '<li>Show the data date, source and strategy version.</li></ol></details>';

      SB.strategies.runActive().then(function (run) {
        var H = ctx.history;
        var latest = run.dataAsOf;
        var refIso = ui.iso(ctx.refDate);
        var stale = latest && latest < refIso;
        $('#sg-fresh', el).innerHTML = '<div class="tags">' + ui.stateBadge(stale ? 'CACHED' : 'EOD', latest, H && H.source) + ui.stateBadge(ctx.market.state, ctx.market.asOf, ctx.market.source) +
          '<span class="sub">Signals use daily candles up to ' + F.date(latest) + '; price rules use the latest price shown. Strategy run ' + esc(run.ranAt) + '.</span></div>' +
          (stale ? '<div class="note warn" style="margin-top:8px">The newest candle is ' + F.date(latest) + ', older than the price snapshot (' + F.dateTime(ctx.market.asOf) + '). Signals are as of the ' + F.date(latest) + ' close - update the sheet export for newer candles.</div>' : '') +
          (run.errors.length ? '<div class="note bad" style="margin-top:8px">Strategy problems: ' + run.errors.map(esc).join('; ') + '</div>' : '');
        draw(el, ctx, run);
      }).catch(function (e) {
        $('#sg-body', el).innerHTML = '<div class="note bad">Could not run the strategy: ' + esc(e.message) + '. The daily candle file (data/history.js) may be missing - run tools/export_xlsx.py.</div>';
      });
    }
  });

  function draw(el, ctx, run) {
    var risk = ui.store.get('risk:settings', {});
    var exits = SB.strategy.positionWarnings(journalOpen(), ctx.bySym, SB.strategies.candles());
    var counts = {};
    LISTS.forEach(function (l) { counts[l[0]] = l[0] === 'exits' ? exits.filter(function (x) { return x.warnings.length; }).length : (run.lists[l[0]] || []).length; });
    var cats = {};
    ctx.stocks.forEach(function (s) { if (s.cat) cats[s.cat] = s.catName; });
    var body = $('#sg-body', el);
    body.innerHTML = '<div class="tiles" style="margin-bottom:14px">' +
      ui.tile(run.config.mode === 'screen' ? 'Match the screen' : 'Qualified', F.int(counts.qualified), 'of ' + F.int(run.results.length) + ' evaluated') +
      ui.tile('Watch', F.int(counts.watch), 'some signals, not all requirements') + ui.tile('Avoid', F.int(counts.avoid), 'failed a filter') +
      ui.tile('Insufficient data', F.int(counts.insufficient), 'missing / stale candles') + '</div>' +
      '<div class="controls">' + ui.chips('sgl', LISTS.map(function (l) { return [l[0], l[1] + ' (' + counts[l[0]] + ')']; }), ST.list) + '</div>' +
      '<div class="controls"><input class="search" id="sg-q" type="search" placeholder="Filter by symbol, company or industry" aria-label="Filter suggestions" value="' + esc(ST.q) + '">' +
      '<select class="sel" id="sg-cat" aria-label="Category"><option value="">All categories</option>' + Object.keys(cats).sort(function (a, b) { return cats[a].localeCompare(cats[b]); }).map(function (k) {
        return '<option value="' + k + '"' + (ST.cat === k ? ' selected' : '') + '>' + esc(cats[k]) + '</option>';
      }).join('') + '</select><span class="count" id="sg-count"></span></div><div id="sg-list"></div>';

    function rows() {
      if (ST.list === 'exits') return exits;
      return (run.lists[ST.list] || []).filter(function (r) {
        var s = ctx.bySym[r.sym];
        if (!s) return false;
        if (ST.cat && s.cat !== ST.cat) return false;
        return ui.textMatch(ST.q, [s.sym, s.name, s.ind, s.catName]);
      });
    }
    function paint() {
      var host = $('#sg-list', body), list = rows();
      $('#sg-count', body).textContent = F.int(list.length) + ' stocks';
      if (ST.list === 'exits') {
        if (!list.length) { host.innerHTML = '<p class="empty">No open positions in your trade journal (Alerts &amp; Trades page). Exit warnings are checked for journal positions only - never for broker accounts.</p>'; return; }
        host.innerHTML = '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Stock</th><th class="num">Entry</th><th class="num">Stop</th><th class="num">Price</th><th class="num">P&amp;L</th><th>Warnings</th></tr></thead><tbody>' +
          list.map(function (x) {
            return '<tr><td>' + ui.stockCell(x.sym, ctx.bySym[x.sym] && ctx.bySym[x.sym].name) + '</td><td class="num">' + F.price(x.position.entry) + '</td><td class="num">' + F.price(x.position.stop) +
              '</td><td class="num">' + F.price(x.price) + '</td><td class="num">' + ui.deltaHtml(x.pnlPct, 2) + '</td><td class="wrap">' + (x.warnings.length ? x.warnings.map(function (w) { return ui.badge(w, /stop|below/.test(w) ? 's-bad' : 's-warn'); }).join(' ') : '<span class="sub">no warning</span>') + '</td></tr>';
          }).join('') + '</tbody></table></div>';
        return;
      }
      if (!list.length) {
        host.innerHTML = '<p class="empty">' + (ST.list === 'qualified' ? 'No qualifying setup currently.' : 'Nothing in this list for the current filters.') + '</p>' +
          (ST.list === 'breakout' && !run.config.triggers.some(function (t) { return t.id === 'breakout' && t.enabled !== false; }) ? '<p class="sub" style="text-align:center">The active strategy has no breakout rule - your sheet does not define one. You can add the standard "Close above the prior N-bar high" rule in Strategy settings.</p>' : '');
        return;
      }
      if (ST.list === 'avoid' || ST.list === 'insufficient' || ST.list === 'none') {
        var t = new ui.Table({
          rows: list.map(function (r) { var s = ctx.bySym[r.sym]; return { sym: r.sym, name: s.name, catName: s.catName, price: s.price, chg: s.chg, reason: (r.failed || []).join('; '), score: r.score, asOf: r.asOf }; }),
          pageSize: 50, sort: { key: 'sym', dir: 1 },
          columns: [{ key: 'sym', label: 'Stock', type: 'sym', name: 'name' }, { key: 'catName', label: 'Category', wrap: true }, { key: 'price', label: 'Price', type: 'price' },
            { key: 'chg', label: 'Today', type: 'pct', digits: 2 }, { key: 'score', label: 'Score', type: 'num' }, { key: 'asOf', label: 'Last candle', type: 'date' }, { key: 'reason', label: 'Reason', wrap: true }]
        });
        t.mount(host);
        return;
      }
      var showN = Math.min(ST.shown, list.length);
      host.innerHTML = '<div class="sugg">' + list.slice(0, showN).map(function (r) { return itemHtml(r, ctx.bySym[r.sym], run, risk); }).join('') + '</div>' +
        (list.length > showN ? '<div style="text-align:center;margin-top:12px"><button class="btn" type="button" id="sg-more">Show ' + Math.min(20, list.length - showN) + ' more (' + (list.length - showN) + ' left)</button></div>' : '');
      var more = $('#sg-more', host);
      if (more) more.addEventListener('click', function () { ST.shown += 20; paint(); });
    }
    ui.bindChips(body, 'sgl', function (v) { ST.list = v; ST.shown = 20; paint(); });
    $('#sg-q', body).addEventListener('input', function (e) { ST.q = e.target.value.trim(); ST.shown = 20; paint(); });
    $('#sg-cat', body).addEventListener('change', function (e) { ST.cat = e.target.value; ST.shown = 20; paint(); });
    $('#sg-csv', el).onclick = function () {
      var list = rows();
      var out = [['List', 'Symbol', 'Company', 'Exchange', 'Category', 'Basic industry', 'Price', 'Price state', 'Price as of', 'Status', 'Score %', 'Confluence', 'Entry ref', 'Stop', 'Target', 'R:R', 'Signals', 'Not qualified because', 'Warnings', 'Strategy', 'Version', 'Candles as of']];
      list.forEach(function (r) {
        if (ST.list === 'exits') { out.push(['exits', r.sym, '', 'NSE', '', '', r.price, '', '', '', '', '', r.position.entry, r.position.stop, r.position.target, '', '', '', r.warnings.join('; '), run.config.name, run.config.version, run.dataAsOf]); return; }
        var s = ctx.bySym[r.sym];
        out.push([ST.list, r.sym, s.name, s.exchange, s.catName, s.ind, s.price, s.priceState, s.priceAsOf, r.statusLabel, r.score, r.confluence, r.entry, r.stop, r.target, isNum(r.rr) ? r.rr.toFixed(2) : '',
          (r.triggersPassed || []).join(' + '), (r.failed || []).join('; '), (r.warnings || []).join('; '), run.config.name, run.config.version, r.asOf]);
      });
      ui.download('suggestions-' + ST.list + '.csv', ui.toCsv(out));
    };
    paint();
  }
})();
