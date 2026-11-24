/* Analyst Targets (#recos, #recos/<SYMBOL>) - owner, 24-Nov-2026, JLHL on TradingView: "Buy Jupiter Life Line Hospitals;
   target of Rs 330: Prabhudas Lilladher" (27-Oct), the high touched 330.50 on 24-Nov - "If i know for which stocks which
   analyst give recommendations to buy with target price from october 2026, it will be helpful to strengthen for our
   analysis ... it can be our daily check ... cover maximum Analysts recommendations"; then: collect them from Moneycontrol,
   Business Standard and DSIJ, keep the history, "30-day, 60-day and 90-day returns, maximum favourable excursion and maximum
   adverse excursion ... which brokerage has historically been better at identifying stocks before a major price move".
   Collected and worked out by the laptop (analyst_recos.py, the Kite daily candles); counted by web/lib/recos.js (=
   SB.epst's rules: reached = a daily high covering T % of the way within the window; a call counts once its window is over). */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, esc = ui.esc, F = ui.F, $ = ui.$, R = SB.recos, E = SB.epst;
  var OPT_KEY = 'sb:recos:opts';
  var ST = { opt: load(), list: 'all', broker: '', one: '', apply: null };
  var MEMO = null;
  var MONTHS = { 30: '1.5 months', 60: '3 months', 90: '4.5 months', 120: '6 months', 180: '9 months' };

  function load() {
    var o = null;
    try { o = JSON.parse(localStorage.getItem(OPT_KEY) || 'null'); } catch (e) { o = null; }
    o = o && typeof o === 'object' ? o : {};
    // the owner's rule is 'within 2 % of the target' (24-Nov-2026) - a choice saved before it came (no v 2) starts on it once
    var T = o.v === 2 ? E.rule(o.T) : null;
    return { v: 2, W: E.WINDOWS.indexOf(Number(o.W)) >= 0 ? Number(o.W) : 60, T: T == null ? E.NEAR : T, calls: o.calls === 'all' ? 'all' : 'buy' };
  }
  function save() { try { localStorage.setItem(OPT_KEY, JSON.stringify(ST.opt)); } catch (e) { /* private window */ } }
  function pc(v, d) { return v == null || !isFinite(v) ? '–' : (v * 100).toFixed(d == null ? 0 : d) + '%'; }
  function sgn(v, d) { return v == null || !isFinite(v) ? '–' : (v > 0 ? '+' : '') + v.toFixed(d == null ? 1 : d) + '%'; }
  function tile(label, value, note, tone, tip) {
    return '<div class="tile"' + (tip ? ' data-tip="' + esc(tip) + '"' : '') + '><div class="label">' + esc(label) + '</div><div class="value' +
      (tone ? ' ' + tone : '') + '">' + value + '</div>' + (note ? '<div class="note2">' + note + '</div>' : '') + '</div>';
  }
  function ruleWords(T) {
    return T === E.NEAR ? 'within ' + E.NEAR_PCT + '% of the target (a Rs 330 target: Rs ' + (330 * (1 - E.NEAR_PCT / 100)).toFixed(2) + ' or more)'
      : T === 100 ? 'the target itself' : T + '% of the way from the price at the call to the target';
  }
  function ruleShort(T) { return T === E.NEAR ? 'within ' + E.NEAR_PCT + '% of the target (your rule)' : T === 100 ? 'the target itself' : T + '% of the way'; }
  function callBadge(r) { var c = R.CALL[r.call] || [r.call, '']; return ui.badge(c[0], c[1]); }
  function statusBadge(r) {
    var k = R.kind(r, ST.opt.W, ST.opt.T);
    if (k === 'down' && !r.buy) { var d = R.DSTATUS[E.status(r, ST.opt.W, ST.opt.T)]; return ui.badge('↓ ' + d[0], d[1]); }
    var s = R.STATUS[k] || ['', ''];
    return ui.badge(s[0], s[1]);
  }
  function statusText(r) {
    var k = R.kind(r, ST.opt.W, ST.opt.T);
    return k === 'down' && !r.buy ? 'Downside: ' + R.DSTATUS[E.status(r, ST.opt.W, ST.opt.T)][0] : (R.STATUS[k] || [''])[0];
  }
  function srcLink(r) {
    var name = r.srcs.map(function (s) { return R.SRC[s] || s; }).join(' · ');
    return r.url ? '<a href="' + esc(r.url) + '" target="_blank" rel="noopener">' + esc(name) + ' ↗</a>' : esc(name);
  }

  // ---------- data ----------
  function fetchAll(ctx) {
    if (MEMO) return MEMO;
    var p = (ctx.site.apiBase == null ? Promise.reject(new Error('local')) : SB.api('api/recos', 35000))
      .then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.message) || 'the sheet did not answer');
        if (SB.keep && r.rows && r.rows.length) SB.keep.put('recos', { ok: true, readAt: r.fetchedAt || '', data: r });
        return { res: r };
      })
      .catch(function (e) {
        MEMO = null;
        return (SB.keep ? SB.keep.get('recos') : Promise.resolve(null)).then(function (k) {
          return k ? { res: k.data, kept: k.readAt || true } : { error: e && e.message === 'local' ? 'local' : (e && e.message) || 'failed' };
        });
      });
    MEMO = p;
    return p;
  }
  function prepare(res, ctx) {
    return R.objects(res).map(function (r) {
      var s = r.sym ? ctx.bySym[r.sym] : null;
      r.name = s ? s.name : r.co;
      r.price = s && s.price > 0 ? s.price : null;
      r.toTgt = r.price && r.tgt > 0 ? (r.tgt / r.price - 1) * 100 : null;
      r.mfe = null; r.mae = null;
      return r;
    });
  }

  // ---------- pieces ----------
  function pickHtml(res) {
    var opt = function (v, on, words) { return '<option value="' + v + '"' + (on ? ' selected' : '') + '>' + esc(words) + '</option>'; };
    return '<section class="card" id="rc-pick"><div class="card-head"><div><h2>Window and your rule</h2>' +
      '<p>A Buy call counts as <b>reached</b> when a daily <b>high</b> covered <b>' + esc(ruleWords(ST.opt.T)) + '</b> within the window. ' +
      'The price at the call = the close of the day it was published (published after 15:30: the next session). A call whose window is not over yet is ' +
      '<b>still running</b> - never a miss. Best move / worst dip = the highest high / lowest low within the window vs the price at the call.</p></div></div>' +
      '<div class="controls edge-opts"><label class="edge-opt">Within <select id="rc-w">' + E.WINDOWS.map(function (W) {
        return opt(W, W === ST.opt.W, W + ' sessions (about ' + MONTHS[W] + ')');
      }).join('') + '</select></label><label class="edge-opt">Counts as reached at <select id="rc-t">' + [E.NEAR].concat(E.THRESH.slice().reverse()).map(function (T) {
        return opt(T, T === ST.opt.T, ruleShort(T));
      }).join('') + '</select></label><label class="edge-opt">Calls <select id="rc-c">' + opt('buy', ST.opt.calls === 'buy', 'Buy calls (Buy / Accumulate / Add / Outperform)') +
      opt('all', ST.opt.calls === 'all', 'Every call (Hold / Neutral / Sell too)') + '</select></label></div>' +
      '<p class="sub">From ' + esc(res.sum && res.sum.from ? F.date(res.sum.from) : '1 Oct 2026') + ' · prices up to ' + (res.upto ? esc(F.date(res.upto)) : '–') +
      (res.made ? ' · collected by your laptop ' + esc(F.dateTime(String(res.made).replace('T', ' '))) : '') + '.</p></section>';
  }

  function summaryHtml(res, rows) {
    var W = ST.opt.W, T = ST.opt.T, S = E.stats(rows, W, T), all = R.pick(rows, ST.opt.calls);
    var brokers = Object.keys(all.reduce(function (o, r) { o[r.br] = 1; return o; }, {})).length;
    var stocks = Object.keys(all.reduce(function (o, r) { if (r.sym) o[r.sym] = 1; return o; }, {})).length;
    var rr = R.rets(rows);
    var h = '<section class="card" id="rc-sum"><div class="card-head"><div><h2>What the brokers\' calls did</h2><p>' +
      F.int(all.length) + ' ' + (ST.opt.calls === 'buy' ? 'Buy calls' : 'calls') + ' from ' + F.int(brokers) + ' broker' + (brokers === 1 ? '' : 's') + ' on ' +
      F.int(stocks) + ' of your stocks.</p></div></div><div class="tiles">' +
      tile('Calls with a target above the price', F.int(S.n), F.int(S.other) + ' with the target under the price at the call · ' + F.int(S.none) + ' not checked') +
      tile('Reached within ' + W + ' sessions', S.rate == null ? '–' : pc(S.rate), S.done ? F.int(S.hit) + ' of ' + F.int(S.done) + ' finished · likely ' +
        pc(S.lo) + '–' + pc(S.hi) : 'none finished yet', S.rate != null ? 'up' : '',
        'Reached = ' + ruleWords(T) + '. Only calls whose ' + W + ' sessions are over count. Likely range = where the rate would fall 9 times out of 10') +
      tile('Still running', F.int(S.pending), S.early ? F.int(S.early) + ' reached it already' : 'fewer than ' + W + ' sessions since the call', '',
        'They count once their ' + W + ' sessions are over') +
      tile('Typical time to reach', S.medDays == null ? '–' : F.int(S.medDays) + ' sessions', S.medDays == null ? '' : 'median of the ones that reached it') +
      tile('Best move within ' + W + ' (MFE)', S.avgHh == null ? '–' : sgn(S.avgHh), 'average highest high vs the price at the call', S.avgHh > 0 ? 'up' : '',
        'Maximum favourable excursion: how far the price went up at its best within the window') +
      tile('Worst dip within ' + W + ' (MAE)', S.avgDd == null ? '–' : sgn(S.avgDd), 'average lowest low vs the price at the call', S.avgDd < 0 ? 'down' : '',
        'Maximum adverse excursion: how far the price fell at its worst within the window') +
      tile('After 30 / 60 / 90 sessions', [rr[0], rr[1], rr[2]].map(function (v) { return sgn(v); }).join(' / '), 'average close vs the price at the call (finished calls)',
        'rc-small') +
      '</div>';
    var li = [];
    if (S.done) {
      li.push('Of the <b>' + F.int(S.done) + '</b> calls whose ' + W + ' sessions are over, <b>' + F.int(S.hit) + ' (' + pc(S.rate) + ')</b> reached ' +
        esc(ruleWords(T)) + ' - likely between ' + pc(S.lo) + ' and ' + pc(S.hi) + ' for calls like these.' +
        (S.early ? ' ' + F.int(S.early) + ' of the calls still running reached it already (they count once their window is over).' : ''));
    } else {
      li.push('No call has had ' + W + ' sessions yet - pick a shorter window above, or come back as the calls get older.');
    }
    if (S.medUp != null) li.push('The median target was <b>' + sgn(S.medUp, 0) + '</b> above the price at the call.');
    var why = res.sum && res.sum.why ? res.sum.why : {};
    if (why.nosym) li.push('<span class="sub">' + F.int(why.nosym) + ' call(s) were for companies that are not in your Main tab (or whose name did not match) - listed at the bottom.</span>');
    var src = res.sum && res.sum.src ? res.sum.src : {};
    li.push('<span class="sub">Where they came from: ' + Object.keys(R.SRC).map(function (k) { return R.SRC[k] + ' ' + F.int(src[k] || 0); }).join(' · ') +
      ' (a call found on two websites counts once). Prices: the Kite daily candles on your laptop, adjusted for splits / bonuses.</span>');
    return h + '<ul class="edge-says">' + li.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul></section>';
  }

  function freshHtml() {
    return '<section class="card" id="rc-new"><div class="card-head"><div><h2>New calls (the newest 3 days)</h2><p>The daily check: what the brokers said lately ' +
      'and how far the price is from their target now.</p></div></div><div id="rc-new-t"></div></section>';
  }
  function drawFresh(el, rows) {
    var host = $('#rc-new-t', el);
    if (!host) return;
    new ui.Table({ rows: R.fresh(rows, 3), pageSize: 15, id: 'recos-new', empty: 'No call in the newest 3 days.', columns: [
      { key: 'sym', label: 'Stock', type: 'sym', name: 'name', get: function (r) { return r.sym || r.co; },
        html: function (r) { return r.sym ? ui.stockCell(r.sym, r.name) : esc(r.co) + ' <span class="sub">not in Main</span>'; } },
      { key: 'at', label: 'Published', html: function (r) { return esc(F.date(r.day)) + (r.at.length > 10 ? ' <span class="sub">' + esc(r.at.slice(11)) + '</span>' : ''); } },
      { key: 'br', label: 'Broker' },
      { key: 'call', label: 'Call', html: callBadge },
      { key: 'tgt', label: 'Target', type: 'price' },
      { key: 'ep', label: 'Price at the call', type: 'price' },
      { key: 'up', label: 'Target vs call price', type: 'pct', digits: 1 },
      { key: 'price', label: 'Price now', type: 'price' },
      { key: 'toTgt', label: 'Now → target', type: 'pct', digits: 1 },
      { key: 'src', label: 'Source', get: function (r) { return r.srcs.join(','); }, html: srcLink }
    ] }).mount(host);
  }

  function brokersHtml() {
    return '<section class="card" id="rc-brokers"><div class="card-head"><div><h2>Broker scorecard</h2><p>Which research house\'s targets came true most often ' +
      '(the window and rule chosen above). A broker is ranked once 3 of its calls are finished - the likely range shows how sure the rate is. Tap a broker to see its calls.</p></div>' +
      '</div><div id="rc-brokers-b"></div><div id="rc-brokers-t"></div></section>';
  }
  function drawBrokers(el, rows) {
    var host = $('#rc-brokers-t', el);
    if (!host) return;
    var W = ST.opt.W, T = ST.opt.T, sc = R.scorecard(rows, W, T, 3);
    var shown = sc.filter(function (s) { return s.ranked; }).slice(0, 15);
    $('#rc-brokers-b', el).innerHTML = shown.length ? ui.bars(shown.map(function (s) { return { label: s.label + ' (' + F.int(s.done) + ')', value: (s.rate || 0) * 100 }; }),
      { fmt: function (v) { return v.toFixed(0) + '%'; } }) : '<p class="empty">No broker has 3 finished calls in this window yet - pick a shorter window.</p>';
    new ui.Table({ rows: sc, pageSize: 25, id: 'recos-brokers', columns: [
      { key: 'label', label: 'Broker', html: function (s) { return '<button type="button" class="linkish" data-rcbr="' + esc(s.label) + '">' + esc(s.label) + '</button>'; } },
      { key: 'calls', label: 'Calls', type: 'num', digits: 0 },
      { key: 'stocks', label: 'Stocks', type: 'num', digits: 0 },
      { key: 'done', label: 'Finished (' + W + ')', type: 'num', digits: 0 },
      { key: 'rate', label: 'Reached', type: 'num', get: function (s) { return s.rate == null ? null : s.rate * 100; },
        html: function (s) { return s.rate == null ? '–' : '<b>' + pc(s.rate) + '</b> <span class="sub">' + F.int(s.hit) + ' of ' + F.int(s.done) + ' · ' + pc(s.lo) + '–' + pc(s.hi) + '</span>'; } },
      { key: 'pending', label: 'Still running', type: 'num', digits: 0 },
      { key: 'medDays', label: 'Median sessions', type: 'num', digits: 0 },
      { key: 'medUp', label: 'Median target vs price', type: 'pct', digits: 0 },
      { key: 'avgHh', label: 'Best move (MFE)', type: 'pct', digits: 1, title: 'Average highest high within the window vs the price at the call' },
      { key: 'avgDd', label: 'Worst dip (MAE)', type: 'pct', digits: 1, title: 'Average lowest low within the window vs the price at the call' },
      { key: 'r30', label: 'After 30', type: 'pct', digits: 1, title: 'Average close 30 sessions after the call' },
      { key: 'r60', label: 'After 60', type: 'pct', digits: 1 },
      { key: 'r90', label: 'After 90', type: 'pct', digits: 1 },
      { key: 'avgIx', label: 'NIFTY 50', type: 'pct', digits: 1, title: 'NIFTY 50 over the same sessions (the window)' }
    ] }).mount(host);
  }

  function allHtml(rows) {
    var n = { all: rows.length };
    Object.keys(R.STATUS).forEach(function (k) { n[k] = 0; });
    rows.forEach(function (r) { n[R.kind(r, ST.opt.W, ST.opt.T)]++; });
    var brokers = Object.keys(rows.reduce(function (o, r) { o[r.br] = 1; return o; }, {})).sort();
    return '<section class="card" id="rc-all"><div class="card-head"><div><h2>Every call</h2><p>Search a stock to see every broker\'s call on it. ' +
      'Tap <b>Source</b> to read the broker\'s note.</p></div><div class="actions"><button class="btn" type="button" id="rc-csv">Export CSV</button></div></div>' +
      '<nav class="chips" aria-label="Status">' + [['all', 'All']].concat(Object.keys(R.STATUS).map(function (k) { return [k, R.STATUS[k][0]]; })).map(function (k) {
        return '<button type="button" class="chip" data-rcs="' + k[0] + '" aria-pressed="' + (ST.list === k[0]) + '">' + esc(k[1]) + ' <b>' + F.int(n[k[0]]) + '</b></button>';
      }).join('') + '</nav><div class="controls"><input class="search" id="rc-q" type="search" placeholder="Search a stock (e.g. JLHL)" aria-label="Search a stock" value="' +
      esc(ST.one) + '"><select class="sel" id="rc-b" aria-label="Broker"><option value="">Every broker</option>' + brokers.map(function (b) {
        return '<option value="' + esc(b) + '"' + (b === ST.broker ? ' selected' : '') + '>' + esc(b) + '</option>';
      }).join('') + '</select><span class="count" id="rc-count"></span></div><div id="rc-one"></div><div id="rc-all-t"></div></section>';
  }
  function drawAll(el, rows) {
    var host = $('#rc-all-t', el);
    if (!host) return;
    var W = ST.opt.W, T = ST.opt.T, k = E.WINDOWS.indexOf(W);
    var t = new ui.Table({ rows: [], pageSize: 50, id: 'recos-all', empty: 'No call here', columns: [
      { key: 'at', label: 'Published', get: function (r) { return r.at; }, html: function (r) { return esc(F.date(r.day)) + (r.at.length > 10 ? ' <span class="sub">' + esc(r.at.slice(11)) + '</span>' : ''); } },
      { key: 'sym', label: 'Stock', type: 'sym', name: 'name', get: function (r) { return r.sym || r.co; },
        html: function (r) { return r.sym ? ui.stockCell(r.sym, r.name) : esc(r.co) + ' <span class="sub">not in Main</span>'; } },
      { key: 'br', label: 'Broker' },
      { key: 'call', label: 'Call', html: callBadge },
      { key: 'tgt', label: 'Target', type: 'price' },
      { key: 'ep', label: 'Price at the call', type: 'price', title: 'The close of the day it was published (after 15:30: the next session)' },
      { key: 'up', label: 'Target vs call price', type: 'pct', digits: 1 },
      { key: 'status', label: 'In ' + W + ' sessions', get: statusText, html: statusBadge },
      { key: 'reach', label: 'Reached in', title: 'Sessions after the call until the price covered ' + ruleWords(T),
        get: function (r) { return E.reachK(r, T); }, html: function (r) { var x = E.reachK(r, T); return x != null ? F.int(x) + ' <span class="sub">' + esc(F.date(E.reachD(r, T))) + '</span>' : '<span class="sub">–</span>'; } },
      { key: 'pg', label: 'Best progress', type: 'num', title: 'How much of the way to the target the price covered within the window',
        get: function (r) { return r.pg[k]; }, html: function (r) { return r.pg[k] == null ? '–' : Math.round(r.pg[k]) + '% of the way'; } },
      { key: 'hh', label: 'Best move (MFE)', type: 'pct', digits: 1, title: 'The highest high within the window vs the price at the call', get: function (r) { return r.hh[k]; } },
      { key: 'dd', label: 'Worst dip (MAE)', type: 'pct', digits: 1, title: 'The lowest low within the window vs the price at the call', get: function (r) { return r.dd[k]; } },
      { key: 'c30', label: 'After 30', type: 'pct', digits: 1, get: function (r) { return r.cl[0]; } },
      { key: 'c60', label: 'After 60', type: 'pct', digits: 1, get: function (r) { return r.cl[1]; } },
      { key: 'c90', label: 'After 90', type: 'pct', digits: 1, get: function (r) { return r.cl[2]; } },
      { key: 'now', label: 'Now vs call price', type: 'pct', digits: 1, title: 'The last daily close the laptop had vs the price at the call' },
      { key: 'toTgt', label: 'Price → target', type: 'pct', digits: 1, title: 'How far the price shown on this site is from the target' },
      { key: 'n', label: 'Sessions so far', type: 'num', digits: 0 },
      { key: 'why', label: 'Not checked because', get: function (r) { return r.st === 'ok' ? '' : R.WHY[r.why] || ''; } },
      { key: 'src', label: 'Source', get: function (r) { return r.srcs.join(','); }, html: srcLink }
    ], hide: ['pg', 'now', 'n', 'why'] }).mount(host);
    function apply() {
      var w = ST.one.trim();
      var list = rows.filter(function (r) {
        return (ST.list === 'all' || R.kind(r, W, T) === ST.list) && (!ST.broker || r.br === ST.broker) && (!w || ui.textMatch(w, [r.sym, r.name, r.co]));
      });
      $('#rc-count', el).textContent = F.int(list.length) + ' of ' + F.int(rows.length);
      t.setRows(list);
      oneCard(el, rows);
    }
    var timer;
    $('#rc-q', el).addEventListener('input', function (e) { clearTimeout(timer); timer = setTimeout(function () { ST.one = e.target.value; apply(); }, 150); });
    $('#rc-b', el).addEventListener('change', function (e) { ST.broker = e.target.value; apply(); });
    el.querySelectorAll('[data-rcs]').forEach(function (b) {
      b.addEventListener('click', function () {
        ST.list = b.getAttribute('data-rcs');
        el.querySelectorAll('[data-rcs]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        apply();
      });
    });
    $('#rc-csv', el).addEventListener('click', function () { ui.download('analyst-targets-' + W + '-' + T + '.csv', ui.toCsv(t.toCsvRows())); });
    ST.apply = apply;
    apply();
  }

  /** one stock: every broker's call on it, the consensus, and how far the price is from each target */
  function oneCard(el, rows) {
    var box = $('#rc-one', el), w = ST.one.trim().toUpperCase();
    if (!box) return;
    if (!w) { box.innerHTML = ''; return; }
    var mine = rows.filter(function (r) { return r.sym === w; });
    if (!mine.length) {
      var some = rows.filter(function (r) { return ui.textMatch(ST.one, [r.sym, r.name, r.co]); });
      var syms = Object.keys(some.reduce(function (o, r) { if (r.sym) o[r.sym] = 1; return o; }, {}));
      if (syms.length !== 1) { box.innerHTML = some.length ? '' : '<p class="empty">No broker call for "' + esc(ST.one) + '" since 1 Oct 2026.</p>'; return; }
      mine = rows.filter(function (r) { return r.sym === syms[0]; });
    }
    var c = R.consensus(mine), r0 = mine[0], price = r0.price;
    var h = '<div class="et-one"><h3>' + esc(r0.sym) + ' <span class="sub">' + esc(r0.name || '') + '</span></h3><p>' + F.int(c.calls) + ' call' + (c.calls === 1 ? '' : 's') +
      ' from ' + F.int(c.brokers) + ' broker' + (c.brokers === 1 ? '' : 's') + ' · average target ' + F.price(c.avg) +
      (c.hi !== c.lo ? ' (from ' + F.price(c.lo) + ' to ' + F.price(c.hi) + ')' : '') +
      (price ? ' · the price now ' + F.price(price) + ' (' + sgn((c.avg / price - 1) * 100) + ' to the average target)' : '') + '.</p><ul class="edge-says">' +
      mine.slice().sort(function (a, b) { return a.at < b.at ? 1 : -1; }).map(function (r) {
        var k = E.reachK(r, 100), kn = E.reachK(r, E.NEAR), k80 = E.reachK(r, 80);
        return '<li><b>' + esc(F.date(r.day)) + '</b> · ' + esc(r.br) + ' ' + callBadge(r) + ' target <b>' + F.price(r.tgt) + '</b>' +
          (r.ep ? ' when the price was ' + F.price(r.ep) + ' (' + sgn(r.up) + ')' : '') + ' - ' +
          (r.st !== 'ok' ? esc(R.WHY[r.why] || 'not checked') : k != null ? '<b>reached</b> after ' + F.int(k) + ' sessions (' + esc(F.date(E.reachD(r, 100))) + ')'
            : kn != null ? '<b>within ' + E.NEAR_PCT + '% of the target</b> (' + F.price(E.level(r, E.NEAR)) + ') after ' + F.int(kn) + ' sessions (' +
              esc(F.date(E.reachD(r, E.NEAR))) + ')' + (r.nearGuess ? ' <span class="sub">(about - the exact day comes with your laptop\'s next list)</span>' : '')
            : 'not reached yet in ' + F.int(r.n) + ' sessions' + (k80 != null ? ' (80% of the way after ' + F.int(k80) + ')' : '')) +
          ' · ' + srcLink(r) + '</li>';
      }).join('') + '</ul><div class="actions"><a class="btn sm" target="_blank" rel="noopener" href="https://www.tradingview.com/chart/?symbol=' +
      encodeURIComponent('NSE:' + r0.sym) + '">Open on TradingView</a><button type="button" class="btn sm" data-sym="' + esc(r0.sym) + '">Stock window</button></div></div>';
    box.innerHTML = h;
  }

  function unmatchedHtml(rows) {
    var u = rows.filter(function (r) { return r.why === 'nosym'; });
    if (!u.length) return '';
    var m = {};
    u.forEach(function (r) { (m[r.co] = m[r.co] || []).push(r); });
    var nco = Object.keys(m).length;
    return '<details class="card" id="rc-nosym"><summary><b>Not matched to your stocks (' + F.int(nco) + (nco === 1 ? ' company' : ' companies') + ')</b> <span class="sub">- not in your Main tab, ' +
      'or the name the broker used did not match it</span></summary><ul class="edge-says">' + Object.keys(m).sort().map(function (co) {
        return '<li>' + esc(co) + ' <span class="sub">' + m[co].map(function (r) { return esc(r.br) + ' ' + esc(F.date(r.day)); }).join(' · ') + '</span></li>';
      }).join('') + '</ul></details>';
  }

  // ---------- the page ----------
  SB.page('recos', {
    render: function (el, params, ctx) {
      if (params && params[0] && /^[A-Za-z0-9&_.-]{1,30}$/.test(params[0])) ST.one = params[0].toUpperCase();
      el.innerHTML = '<div class="page-head"><div><h1>Analyst Targets</h1><p>The research houses\' Buy calls with a target price (Prabhudas Lilladher, Motilal Oswal, ' +
        'ICICI Securities, HDFC Securities, Emkay, JM Financial, Nuvama, Sharekhan ...) since 1 Oct 2026, collected every round by your laptop from Moneycontrol, ' +
        'Business Standard and DSIJ - and what the price did after each: did it reach the target, how fast, the best move and the worst dip, and which broker was right most often.</p></div></div>' +
        '<div id="rc-body"><section class="card" aria-busy="true"><h2>Loading the calls…</h2>' + ui.skeleton(3) + '</section></div>';
      fetchAll(ctx).then(function (got) {
        var body = $('#rc-body', el);
        if (!body || !el.isConnected) return;
        if (got.error) {
          body.innerHTML = '<section class="card"><p class="empty">' + (got.error === 'local'
            ? 'The Analyst Targets come from your laptop through the live website - open the live site to see them.'
            : 'Could not load the Analyst Targets: ' + esc(got.error) + '.') + '</p></section>';
          return;
        }
        var res = got.res;
        if (!res.rows || !res.rows.length) {
          body.innerHTML = '<section class="card"><p class="empty">Nothing here yet - your laptop collects the brokers\' calls after its next round (or run ' +
            '<b>AnalystNow.bat</b> in the ScreenerBridge folder: it reads back to 1 Oct 2026). If it finds none, run <b>AnalystCheck.bat</b> and send what it prints.</p></section>';
          return;
        }
        var everything = prepare(res, ctx);
        var rows = R.pick(everything, ST.opt.calls);
        body.innerHTML = (got.kept ? '<div class="note">Showing the copy this device kept' + (got.kept !== true ? ' (' + esc(F.dateTime(got.kept)) + ')' : '') +
          ' - the live copy could not be read just now.</div>' : '') + pickHtml(res) + summaryHtml(res, rows) + freshHtml() + brokersHtml() + allHtml(rows) +
          unmatchedHtml(everything);
        drawFresh(body, rows);
        drawBrokers(body, rows);
        drawAll(body, rows);
        body.addEventListener('click', function (e) {
          var b = e.target.closest && e.target.closest('[data-rcbr]');
          if (!b) return;
          ST.broker = b.getAttribute('data-rcbr');
          var sel = $('#rc-b', body);
          if (sel) sel.value = ST.broker;
          if (ST.apply) ST.apply();
          var all = $('#rc-all', body);
          if (all && all.scrollIntoView) all.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        [['#rc-w', 'W', Number], ['#rc-t', 'T', E.rule], ['#rc-c', 'calls', String]].forEach(function (x) {
          $(x[0], body).addEventListener('change', function (e) { ST.opt[x[1]] = x[2](e.target.value); save(); SB.route(true); });
        });
      });
    }
  });
})();
