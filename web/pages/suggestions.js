/* Daily Suggestions - powered by the active strategy (web/lib/strategy.js).
   Workflow: data -> freshness check -> indicators -> rules per stock ->
   filters -> ranking (score, confluence, R:R) -> explanations + risk.
   Layout (owner, 03-Nov-2026: "looking awkward and not engaging - present it so everyone can easily understand it"):
   the strategy (switchable here) with today's headline number, three steps "your rules -> every stock checked ->
   ranked ideas", a bar of where every stock landed (click a part = that list), a line saying what the chosen list
   means, and one card per idea: rank, match ring, a Stop - Entry - Target ladder (setups) or the key figures
   (screens), and every rule passed / failed in plain words. */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, esc = ui.esc, F = ui.F, isNum = ui.isNum, $ = ui.$;
  var ST = { list: 'qualified', cat: '', q: '', shown: 20 };

  var LISTS = [
    ['qualified', 'Qualified'], ['breakout', 'Breakout'], ['pullback', 'Pullback'], ['watch', 'Watchlist candidates'],
    ['exits', 'Exit / risk warnings'], ['avoid', 'Avoid / no-trade'], ['insufficient', 'Insufficient data'], ['none', 'No valid signal']
  ];
  // what each list means, in one plain line
  var LIST_HELP = {
    qualified: 'Every rule of the strategy is met - these are today\'s ideas, best match first.',
    breakout: 'Ideas whose signal is a breakout above a recent high.',
    pullback: 'Ideas where the price came back to a support (FVG zone or EMA) in an up-move.',
    watch: 'Some signals fired but not every requirement is met yet - worth keeping an eye on.',
    exits: 'Warnings for the open positions in your trade journal (stop-loss near, target reached ...).',
    avoid: 'Stopped by a safety filter (too little trading, circuit-locked, results too close ...).',
    insufficient: 'Not enough daily prices to judge (new listing, or the newest candle is missing).',
    none: 'Checked, but no signal of this strategy today.'
  };
  // where every stock landed - the parts of the bar, in this order
  var FUNNEL = [['qualified', 'Qualified', 's-good'], ['watch', 'Watch', 's-warn'], ['avoid', 'Avoid', 's-bad'], ['none', 'No signal', ''], ['insufficient', 'Insufficient data', 's-muted']];
  var FUNNEL_HELP = { qualified: 'every rule met', watch: 'some signals, not all requirements', avoid: 'failed a filter', none: 'no signal today', insufficient: 'missing / stale candles' };

  // open journal positions, read through the journal page's own cleaner (side included)
  function journalOpen() { return SB.journal ? SB.journal.open() : []; }

  /** Every rule, passed / failed, in plain words. */
  function checksHtml(r) {
    return '<ul class="sg-checks">' + (r.checks || []).map(function (k) {
      var p = k.res.pass, cls = p === true ? 'ok' : p === false ? 'no' : 'na';
      var mark = p === true ? '<span class="sg-ic" aria-label="passed">✓</span>' : p === false ? '<span class="sg-ic" aria-label="failed">✗</span>' : '<span class="sg-ic" aria-label="not applicable">–</span>';
      var tag = k.group === 'filter' ? 'Filter' : k.group === 'trigger' ? (k.watchOnly ? 'Watch' : 'Signal') : 'Requirement';
      return '<li class="' + cls + '">' + mark + '<div><b>' + esc(tag) + ':</b> ' + esc(k.label) + (k.res.detail ? '<span class="sub">' + esc(k.res.detail) + '</span>' : '') + '</div></li>';
    }).join('') + '</ul>';
  }

  /** The match score as a ring. */
  function ringHtml(score) {
    var v = Math.max(0, Math.min(100, Number(score) || 0));
    return '<div class="sg-ring" role="img" aria-label="Strategy match ' + v + '%"><svg viewBox="0 0 40 40" aria-hidden="true">' +
      '<circle class="sg-ring-bg" cx="20" cy="20" r="16" pathLength="100"/>' +
      '<circle class="sg-ring-fg" cx="20" cy="20" r="16" pathLength="100" stroke-dasharray="' + v + ' 100"/></svg><b>' + v + '%</b></div>';
  }

  /** Stop - Entry - Target on one line (an entry setup). */
  function ladderHtml(r) {
    if (!(r.entry > 0) || !(r.stop > 0) || !(r.target > r.entry)) return '';
    var span = r.target - r.stop, at = Math.max(4, Math.min(96, (r.entry - r.stop) / span * 100));
    var pct = function (v) { return F.pct((v / r.entry - 1) * 100, 1); };
    return '<div class="sg-ladder" role="img" aria-label="' + esc('Stop-loss ' + F.price(r.stop) + ', entry ' + F.price(r.entry) + ', target ' + F.price(r.target)) + '">' +
      '<div class="sg-bar"><i class="sg-risk" style="width:' + at.toFixed(1) + '%"></i><i class="sg-reward" style="width:' + (100 - at).toFixed(1) + '%"></i>' +
      '<span class="sg-entry" style="left:' + at.toFixed(1) + '%"></span></div>' +
      '<div class="sg-ladder-l"><span class="sg-l-stop"><small>Stop-loss</small><b>' + F.price(r.stop) + '</b><em class="down">' + pct(r.stop) + '</em></span>' +
      '<span class="sg-l-entry"><small>Entry ref.</small><b>' + F.price(r.entry) + '</b><em>close ' + esc(r.asOf || '') + '</em></span>' +
      '<span class="sg-l-target"><small>Target</small><b>' + F.price(r.target) + '</b><em class="up">' + pct(r.target) + '</em></span></div></div>';
  }

  /** The figures a screen is usually about (fundamental screens have no entry timing). */
  function snapshotHtml(s) {
    var item = function (label, html) { return '<div class="sg-kv"><span>' + esc(label) + '</span><b>' + html + '</b></div>'; };
    var h = '<div class="sg-snap">' + item('TTM Signal', ui.badge(SB.strategy.ttmSignal(s, s.price) || null)) +
      item('Upside', isNum(s.up) ? ui.deltaHtml(s.up, 0) : '–') + item('PE vs industry', isNum(s.pevs) ? F.num(s.pevs, 2) + '×' : '–') +
      item('OPM QoQ', ui.badge(s.opmq || null)) + item('OPM YoY', ui.badge(s.opmy || null)) + item('OPM Qtr YoY', ui.badge(s.opmqy || null)) +
      item('FII', ui.badge(s.fii || null)) + item('EPS growth', isNum(s.epsg) ? ui.deltaHtml(s.epsg, 0) : '–');
    if (s.rp) h += item('Result date', F.date(s.rp.resultDate)) + item('Announced', s.rp.announced ? esc(s.rp.announced) : '–');
    return h + '</div>';
  }

  function itemHtml(r, s, run, risk, rc, rank) {
    var size = null;
    // sized like the journal's calculator: your risk settings + open journal positions (heat, max positions, daily loss)
    if (r.stop > 0 && r.entry > 0) size = SB.risk.sizePosition({ entry: r.entry, stop: r.stop, target: r.target, industry: s.catName }, risk, rc);
    var setup = (r.setupTypes || []).filter(function (t) { return t !== 'screen'; }).map(function (t) { return t === 'pullback' ? 'Pullback / support' : t === 'reversal' ? 'Reversal pattern' : t === 'breakout' ? 'Breakout' : t; });
    var screen = run.config.mode === 'screen';
    var h = '<article class="sugg-item sg-card' + (rank <= 3 && r.status === 'qualified' ? ' sg-top' : '') + '">';
    // who
    h += '<header class="sg-card-h"><span class="sg-rank" title="Rank in this list">#' + rank + '</span>' +
      '<div class="stock">' + ui.logoHtml(s.sym, 'lg') + '<div class="txt"><span class="sym-line"><button type="button" class="linkish" data-sym="' + esc(s.sym) + '">' + esc(s.sym) + '</button>' + SB.wlStar(s.sym) + '</span>' +
      '<span class="co">' + esc(s.name || '') + '</span><span class="sub">' + esc(s.exchange) + ' · ' + esc(s.catName) + (s.ind ? ' · ' + esc(s.ind) : '') + '</span></div></div>' +
      '<div class="sg-px"><b>' + F.price(s.price) + '</b>' + ui.deltaHtml(s.chg, 2) + ui.stateBadge(s.priceState, s.priceAsOf) + '</div></header>';
    if (r.warnings && r.warnings.length) h += '<div class="note warn sg-warn">' + r.warnings.map(esc).join('<br>') + '</div>';
    h += '<div class="sg-card-b">';
    // how well it matches
    h += '<div class="sg-match">' + ringHtml(r.score) + '<div><div class="sg-sec-t">Strategy match</div>' +
      '<div class="sub">' + esc(r.scoreNote || '') + ' - rule satisfaction, not a probability of profit</div>' +
      '<div class="tags" style="margin-top:8px">' + ui.badge(r.statusLabel) + setup.map(function (t) { return ui.badge(t, 's-info'); }).join('') +
      (isNum(r.confluence) ? ui.badge('Confluence ' + r.confluence + '/4', '') : '') + '</div></div></div>';
    // the plan (a setup) or the key figures (a screen)
    if (!screen) {
      var lad = ladderHtml(r);
      h += '<div class="sg-plan"><div class="sg-sec-t">Trade plan</div>' + lad +
        '<dl class="kv2">' + (lad ? '<dt>Stop-loss / target</dt><dd><span class="sub">' + esc((r.stopNote || '') + (r.targetNote ? ' · target ' + r.targetNote : '')) + '</span></dd>'
          : '<dt>Entry ref.</dt><dd>' + F.price(r.entry) + ' <span class="sub">close ' + esc(r.asOf || '') + '</span></dd>' +
          '<dt>Stop-loss</dt><dd>' + (r.stop > 0 ? F.price(r.stop) + ' <span class="sub">' + esc(r.stopNote || '') + '</span>' : '–') + '</dd>' +
          '<dt>Target</dt><dd>' + (r.target > 0 ? F.price(r.target) + ' <span class="sub">' + esc(r.targetNote || '') + '</span>' : '–') + '</dd>') +
        '<dt>Reward : risk</dt><dd>' + (isNum(r.rr) ? '<span class="sg-rr' + (r.rr >= 2 ? ' good' : '') + '">1 : ' + F.num(r.rr, 2) + '</span>' : '–') + '</dd>' +
        '<dt>Position size</dt><dd>' + (size && size.ok ? F.int(size.qty) + ' sh · risk ' + F.inr(size.riskAmount) +
          (size.warnings.length ? ' <span class="sub">(' + esc(size.warnings[0]) + ')</span>' : '') : size ? '<span class="sub">' + esc(size.errors[0] || 'n/a') + '</span>' : '–') +
          '<div class="sub">your risk settings' + (rc && rc.openPositions.length ? ' + ' + rc.openPositions.length + ' open journal position' + (rc.openPositions.length === 1 ? '' : 's') : '') + '</div></dd></dl></div>';
    } else {
      h += '<div class="sg-plan"><div class="sg-sec-t">Key figures</div>' + snapshotHtml(s) + '</div>';
    }
    // why
    h += '<div class="sg-why"><div class="sg-sec-t">Why it is here</div>' + checksHtml(r) +
      (r.failed && r.failed.length && r.status !== 'qualified' ? '<div class="sub" style="margin-top:6px"><b>Not qualified because:</b> ' + r.failed.map(esc).join('; ') + '</div>' : '') +
      '<div class="sub" style="margin-top:6px">TTM Signal: ' + esc(SB.strategy.ttmSignal(s, s.price) || '–') + ' · Avg turnover filter, volume & liquidity from daily candles</div></div>';
    return h + '</div></article>';
  }

  SB.page('suggestions', {
    render: function (el, params, ctx) {
      var cfg = SB.strategies.get(SB.strategies.activeId());
      var confirmed = SB.strategies.isConfirmed(cfg.id);
      var head = '<div class="page-head"><div><h1>Daily suggestions</h1><p>Stocks that meet the active strategy\'s rules, with the reason for every pass and fail. ' +
        'Research and decision-support only - no orders are placed.</p></div><div class="actions"><a class="btn" href="#strategy">Strategy settings</a><button class="btn" type="button" id="sg-csv">Export CSV</button></div></div>';
      var dsc = SB.strategies.describe(cfg), badge = ui.badge(dsc.tag, dsc.cls);
      var strategies = SB.strategies.list();
      head += '<section class="card sg-hero"><div class="sg-hero-l"><span class="sg-eyebrow">Active strategy</span>' +
        '<label class="sr-only" for="sg-strat">Choose the strategy</label><select class="sel sg-strat" id="sg-strat">' + strategies.map(function (x) {
          return '<option value="' + esc(x.id) + '"' + (x.id === cfg.id ? ' selected' : '') + '>' + esc(x.name) + '</option>';
        }).join('') + '</select>' +
        '<h2 class="sr-only">' + esc(cfg.name) + ' · v' + cfg.version + '</h2><p class="sg-desc">' + esc(cfg.description || '') + '</p>' +
        '<div class="tags">' + badge + ui.badge(cfg.mode === 'screen' ? 'Fundamental screen' : 'Entry setups', 's-info') + ui.badge((cfg.style || 'swing') + ' · daily candles', '') + ui.badge('v' + cfg.version, '') + '</div></div>' +
        '<div class="sg-hero-r" id="sg-big" aria-live="polite"><div class="sg-big-n">…</div><div class="sub">checking every stock…</div></div>' +
        (cfg.source === 'demo' ? '<div class="note bad sg-hero-note"><strong>DEMO strategy.</strong> Its results are for testing the engine only - they are not your strategy and not recommendations.</div>' :
          !confirmed ? '<div class="note warn sg-hero-note"><strong>Unconfirmed rules.</strong> ' + esc(dsc.long) + ' Confirm them in <a href="#strategy">Strategy settings</a>; until then treat this as a research shortlist.' +
            (cfg.assumptions && cfg.assumptions.length ? '<details class="sg-assume"><summary>The assumptions (' + cfg.assumptions.length + ')</summary><ul style="margin:6px 0 0 18px;padding:0">' +
              cfg.assumptions.map(function (a) { return '<li>' + esc(a) + '</li>'; }).join('') + '</ul></details>' : '') + '</div>' : '') +
        '<div id="sg-fresh" class="sg-hero-note"></div></section>';
      el.innerHTML = head + '<div id="sg-steps"></div><section class="card"><div id="sg-body">' + ui.skeleton(6) + '</div></section>' +
        '<details class="card"><summary><b>How these suggestions are produced</b></summary><ol style="margin:10px 0 0 18px;padding:0;color:var(--ink-2)">' +
        '<li>Load the daily candles (History30 from your sheet) and the latest prices (sheet snapshot, or a configured market-data provider).</li>' +
        '<li>Check freshness: a stock whose last candle is older than the latest session is listed under "Insufficient data", never signalled.</li>' +
        '<li>Compute the indicators the rules need (patterns, FVG, EMA support, ATR, turnover) using only past and current bars.</li>' +
        '<li>Evaluate every filter, signal and requirement of the strategy for each stock.</li>' +
        '<li>Apply the liquidity / circuit-lock / event filters - failures go to "Avoid".</li>' +
        '<li>Rank by match score (share of requirements met), then confluence, then reward:risk.</li>' +
        '<li>Compute entry reference, stop-loss, target, reward:risk and a position size from your risk settings (Alerts &amp; Trades page).</li>' +
        '<li>Show the data date, source and strategy version.</li></ol></details>';
      $('#sg-strat', el).addEventListener('change', function (e) {
        SB.strategies.setActive(e.target.value);
        ST.list = 'qualified'; ST.shown = 20;
        SB.route();
      });

      SB.strategies.runActive().then(function (run) {
        var H = ctx.history;
        var latest = run.dataAsOf;
        var stale = SB.candleState(H) !== 'EOD';
        $('#sg-fresh', el).innerHTML = '<div class="tags">' + ui.stateBadge(SB.candleState(H), latest, H && H.source) + ui.stateBadge(ctx.market.state, ctx.market.asOf, ctx.market.source) +
          '<span class="sub">Signals use daily candles up to ' + F.date(latest) + '; price rules use the latest price shown. Strategy run ' + esc(run.ranAt) + '.</span></div>' +
          (stale ? '<div class="note warn" style="margin-top:8px">The newest candle is ' + F.date(latest) + ', older than the price snapshot (' + F.dateTime(ctx.market.asOf) + '). Signals are as of the ' + F.date(latest) + ' close - update the sheet export for newer candles.</div>' : '') +
          (run.errors.length ? '<div class="note bad" style="margin-top:8px">Strategy problems: ' + run.errors.map(esc).join('; ') + '</div>' : '');
        draw(el, ctx, run);
      }).catch(function (e) {
        $('#sg-big', el).innerHTML = '<div class="sg-big-n">–</div><div class="sub">the strategy could not run</div>';
        $('#sg-body', el).innerHTML = '<div class="note bad">Could not run the strategy: ' + esc(e.message) + '. The daily candle file (data/history.js) may be missing - run tools/export_xlsx.py.</div>';
      });
    }
  });

  /** Headline number + "your rules -> every stock checked -> ranked ideas". */
  function drawIntro(el, ctx, run, counts) {
    var cfg = run.config, screen = cfg.mode === 'screen', total = run.results.length;
    var on = function (g) { return (cfg[g] || []).filter(function (r) { return r.enabled !== false && !r.watchOnly; }).length; };
    $('#sg-big', el).innerHTML = '<div class="sg-big-n">' + F.int(counts.qualified) + '</div><div class="sg-big-l">' +
      (screen ? 'stocks match the screen' : 'stocks qualify') + '</div><div class="sub">of ' + F.int(total) + ' checked · ' + F.int(counts.watch) + ' to watch</div>';
    var parts = [];
    if (on('filters')) parts.push(on('filters') + ' safety filter' + (on('filters') === 1 ? '' : 's'));
    if (on('triggers')) parts.push(on('triggers') + ' signal' + (on('triggers') === 1 ? '' : 's'));
    if (on('confirms')) parts.push(on('confirms') + ' requirement' + (on('confirms') === 1 ? '' : 's'));
    var step = function (n, title, text, href) {
      return '<' + (href ? 'a href="' + href + '"' : 'div') + ' class="sg-step"><span class="sg-step-n">' + n + '</span><div><b>' + esc(title) + '</b><span>' + text + '</span></div></' + (href ? 'a' : 'div') + '>';
    };
    $('#sg-steps', el).innerHTML = '<div class="sg-steps">' +
      step(1, 'Your rules', esc(parts.join(' · ') || 'no rule switched on') + ' - edit them in Strategy settings', '#strategy') +
      step(2, 'Every stock checked', F.int(total) + ' stocks of your sheet' + (screen ? ', with their latest figures' : ', daily candles up to ' + F.date(run.dataAsOf))) +
      step(3, 'Ranked ideas', '<b class="up">' + F.int(counts.qualified) + '</b> qualify · ' + F.int(counts.watch) + ' to watch · best match first') + '</div>';
  }

  function draw(el, ctx, run) {
    var risk = ui.store.get('risk:settings', {});
    var rc = SB.journal ? SB.journal.riskContext(ctx) : null;
    var exits = SB.strategy.positionWarnings(journalOpen(), ctx.bySym, SB.strategies.candles());
    var counts = {};
    LISTS.forEach(function (l) { counts[l[0]] = l[0] === 'exits' ? exits.filter(function (x) { return x.warnings.length; }).length : (run.lists[l[0]] || []).length; });
    drawIntro(el, ctx, run, counts);
    var cats = {};
    ctx.stocks.forEach(function (s) { if (s.cat) cats[s.cat] = s.catName; });
    var total = Math.max(1, run.results.length);
    var body = $('#sg-body', el);
    body.innerHTML = '<div class="sg-sec-t">Where every stock landed <span class="sub">- click a part for its list</span></div>' +
      '<div class="sg-funnel" role="group" aria-label="Where every stock landed">' + FUNNEL.filter(function (f) { return counts[f[0]] > 0; }).map(function (f) {
        return '<button type="button" class="sg-seg ' + (f[2] || 's-none') + '" data-funnel="' + f[0] + '" style="flex-grow:' + counts[f[0]] + '" title="' + esc(f[1] + ': ' + F.int(counts[f[0]]) + ' (' + Math.round(counts[f[0]] / total * 100) + '%)') + '">' +
          '<span>' + esc(f[1]) + '</span><b>' + F.int(counts[f[0]]) + '</b></button>';
      }).join('') + '</div>' +
      '<p class="sub sg-legend">' + FUNNEL.map(function (f) { return '<b>' + esc(f[1]) + '</b> ' + FUNNEL_HELP[f[0]]; }).join(' · ') + '</p>' +
      '<div class="controls">' + ui.chips('sgl', LISTS.map(function (l) { return [l[0], l[1] + ' (' + counts[l[0]] + ')']; }), ST.list) + '</div>' +
      '<p class="sg-help" id="sg-help"></p>' +
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
      $('#sg-help', body).innerHTML = '<b>' + esc((LISTS.filter(function (l) { return l[0] === ST.list; })[0] || ['', ''])[1]) + ':</b> ' + esc(LIST_HELP[ST.list] || '');
      body.querySelectorAll('[data-funnel]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-funnel') === ST.list)); });
      if (ST.list === 'exits') {
        if (!list.length) { host.innerHTML = '<p class="empty">No open positions in your trade journal (Alerts &amp; Trades page). Exit warnings are checked for journal positions only - never for broker accounts.</p>'; return; }
        host.innerHTML = '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Stock</th><th>Side</th><th class="num">Entry</th><th class="num">Stop</th><th class="num">Price</th><th class="num">P&amp;L</th><th>Warnings</th></tr></thead><tbody>' +
          list.map(function (x) {
            return '<tr><td>' + ui.stockCell(x.sym, ctx.bySym[x.sym] && ctx.bySym[x.sym].name) + '</td><td>' + (x.position.side === 'short' ? 'Short' : 'Long') + '</td><td class="num">' + F.price(x.position.entry) + '</td><td class="num">' + F.price(x.position.stop) +
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
      host.innerHTML = '<div class="sugg">' + list.slice(0, showN).map(function (r, i) { return itemHtml(r, ctx.bySym[r.sym], run, risk, rc, i + 1); }).join('') + '</div>' +
        (list.length > showN ? '<div style="text-align:center;margin-top:12px"><button class="btn" type="button" id="sg-more">Show ' + Math.min(20, list.length - showN) + ' more (' + (list.length - showN) + ' left)</button></div>' : '');
      var more = $('#sg-more', host);
      if (more) more.addEventListener('click', function () {
        ST.shown += 20; paint();
        var first = host.querySelectorAll('.sugg-item')[showN];          // keep keyboard focus on the first new card
        var b = first && first.querySelector('button[data-sym]');
        if (b) b.focus();
      });
    }
    ui.bindChips(body, 'sgl', function (v) { ST.list = v; ST.shown = 20; paint(); });
    body.addEventListener('click', function (e) {
      var b = e.target.closest('[data-funnel]');
      if (!b) return;
      ST.list = b.getAttribute('data-funnel'); ST.shown = 20;
      body.querySelectorAll('[data-chip="sgl"]').forEach(function (x) { x.setAttribute('aria-pressed', String(x.getAttribute('data-v') === ST.list)); });
      paint();
    });
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
