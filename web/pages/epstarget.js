/* EPS Target Lab (#epst, #epst/<SYMBOL>) - owner, 23-Nov-2026: LAURUSLABS - "Q1(June 2026) result came in July 24 2026 ...
   at July 27th stock price was 1624. but now the stock price is 2370 and nearly touched its target price on 11 November
   2026 at 2488 ... It is impressive to see our method is actually working. but i don't know how many stocks like this
   reached atmost its target price after Q1 result update ... I want to analyse with Q1 results first."
   The sheet's own target (TTM EPS x EPS growth %), every stock and quarter: when the results came out (NSE's result filing,
   else the XBRL file's time), the entry (the close of the first session that could react), and whether a daily HIGH reached
   the target within 30 / 60 / 90 / 120 / 180 sessions. Worked out by the laptop (eps_target.py); counted by web/lib/epstarget.js. */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, esc = ui.esc, F = ui.F, $ = ui.$, T = SB.epst;
  var OPT_KEY = 'sb:epst:opts';
  var ST = { opt: load(), q: '', list: 'all', group: 'growth', one: '' };
  var MEMO = {};
  var MONTHS = { 30: '1.5 months', 60: '3 months', 90: '4.5 months', 120: '6 months', 180: '9 months' };
  var GROUPS = [['growth', 'EPS growth'], ['upside', 'Upside at entry'], ['pe', 'PE at entry'], ['session', 'When the results came'], ['sector', 'Sector']];

  function load() {
    var o = null;
    try { o = JSON.parse(localStorage.getItem(OPT_KEY) || 'null'); } catch (e) { o = null; }
    o = o && typeof o === 'object' ? o : {};
    return { q: typeof o.q === 'string' ? o.q : '', W: T.WINDOWS.indexOf(Number(o.W)) >= 0 ? Number(o.W) : 60 };
  }
  function save() { try { localStorage.setItem(OPT_KEY, JSON.stringify(ST.opt)); } catch (e) { /* private window */ } }
  function pc(v, d) { return v == null || !isFinite(v) ? '–' : (v * 100).toFixed(d == null ? 0 : d) + '%'; }
  function sgn(v, d) { return v == null || !isFinite(v) ? '–' : (v > 0 ? '+' : '') + v.toFixed(d == null ? 1 : d) + '%'; }
  function tile(label, value, note, tone, tip) {
    return '<div class="tile"' + (tip ? ' data-tip="' + esc(tip) + '"' : '') + '><div class="label">' + esc(label) + '</div><div class="value' +
      (tone ? ' ' + tone : '') + '">' + value + '</div>' + (note ? '<div class="note2">' + note + '</div>' : '') + '</div>';
  }
  function badge(s) { var b = T.STATUS[s]; return ui.badge(b[0], b[1]); }
  function qWords(q) { var f = T.fy(q); return esc(q) + (f ? ' · ' + f : ''); }

  // ---------- data ----------
  function fetchQ(ctx, q) {
    var key = q || '*';
    if (MEMO[key]) return MEMO[key];
    var keepKey = 'epst:' + key;
    var p = (ctx.site.apiBase == null ? Promise.reject(new Error('local')) : SB.api('api/epstarget' + (q ? '?q=' + encodeURIComponent(q) : ''), 35000))
      .then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.message) || 'the sheet did not answer');
        if (SB.keep && r.rows && r.rows.length) SB.keep.put(keepKey, { ok: true, readAt: r.fetchedAt || '', data: r });
        return { res: r };
      })
      .catch(function (e) {
        delete MEMO[key];
        return (SB.keep ? SB.keep.get(keepKey) : Promise.resolve(null)).then(function (k) {
          return k ? { res: k.data, kept: k.readAt || true } : { error: e && e.message === 'local' ? 'local' : (e && e.message) || 'failed' };
        });
      });
    MEMO[key] = p;
    return p;
  }

  /** the rows of the answer + the site's own stock data (name, sector, the price now) */
  function prepare(res, ctx) {
    var rows = T.objects(res);
    rows.forEach(function (r) {
      var s = ctx.bySym[r.sym];
      r.name = s ? s.name : '';
      r.sector = s ? s.sector : '';
      r.price = s && s.price > 0 ? s.price : null;
      r.toTgt = r.price && r.tgt > 0 ? (r.tgt / r.price - 1) * 100 : null;
      r.session = !r.ann ? '' : r.ann.slice(11, 16) >= '15:30' || [0, 6].indexOf(new Date(r.ann.slice(0, 10) + 'T00:00:00Z').getUTCDay()) >= 0 ? 'After the market / closed day'
        : r.ann.slice(11, 16) < '09:15' ? 'Before the market' : 'During market hours';
    });
    return rows;
  }

  // ---------- pieces ----------
  function pickHtml(res) {
    var qs = res.quarters || [];
    var chips = qs.map(function (x) {
      var on = x.q === res.q;
      return '<button type="button" class="chip" data-epq="' + esc(x.q) + '" aria-pressed="' + on + '">' + qWords(x.q) +
        (x.sum && !x.sum.ready ? ' <span class="sub">running</span>' : '') + '</button>';
    }).join('');
    return '<section class="card" id="et-pick"><div class="card-head"><div><h2>Quarter and window</h2>' +
      '<p>A result counts as <b>reached</b> when a daily <b>high</b> touched the target within the window after the entry. ' +
      'Results whose window is not over yet are shown as <b>still running</b> - never as misses.</p></div></div>' +
      '<nav class="chips" aria-label="Quarter">' + (chips || '<span class="sub">No quarter yet</span>') + '</nav>' +
      '<div class="controls"><label class="edge-opt">Reached within <select id="et-w">' + T.WINDOWS.map(function (W) {
        return '<option value="' + W + '"' + (W === ST.opt.W ? ' selected' : '') + '>' + W + ' sessions (about ' + MONTHS[W] + ')</option>';
      }).join('') + '</select></label></div></section>';
  }

  function summaryHtml(res, rows, ctx) {
    var W = ST.opt.W, S = T.stats(rows, W), q = res.q;
    var sum = (res.quarters || []).filter(function (x) { return x.q === q; })[0] || {};
    var ok = rows.filter(function (r) { return r.st === 'ok'; });
    var eds = ok.map(function (r) { return r.ed; }).filter(Boolean).sort();
    var ns = ok.map(function (r) { return r.n; }).filter(function (n) { return n != null; });
    var maxN = ns.length ? Math.max.apply(null, ns) : 0, medN = T.median(ns);
    var none = rows.filter(function (r) { return r.st !== 'ok'; });
    var why = {};
    none.forEach(function (r) { if (r.why) why[r.why] = (why[r.why] || 0) + 1; });
    var h = '<section class="card" id="et-sum"><div class="card-head"><div><h2>What ' + qWords(q) + ' says</h2><p>' +
      F.int(rows.length) + ' stocks with 8 quarters of EPS · prices up to ' + (sum.upto ? esc(F.date(sum.upto)) : '–') +
      (sum.made ? ' · worked out by your laptop ' + esc(F.dateTime(sum.made.replace('T', ' '))) : '') + '.</p></div></div>';
    h += '<div class="tiles">' +
      tile('Targets above the entry', F.int(S.n), F.int(S.above) + ' already above at the entry · ' + F.int(S.none) + ' without a target', '',
        'A target at or under the entry price was reached before you could buy - counted apart') +
      tile('Reached within ' + W + ' sessions', S.rate == null ? '–' : pc(S.rate), S.done ? F.int(S.hit) + ' of ' + F.int(S.done) + ' finished · likely ' +
        pc(S.lo) + '–' + pc(S.hi) : 'none finished yet', S.rate != null ? 'up' : '',
        'Only results whose ' + W + ' sessions are over count. Likely range = where the rate of results like these would fall 9 times out of 10') +
      tile('Near miss', F.int(S.near), 'best high within ' + T.NEAR + '% under the target') +
      tile('Still running', F.int(S.pending), 'fewer than ' + W + ' sessions since the entry' + (S.early ? ' · ' + F.int(S.early) + ' reached it already' : ''), '',
        'They count once their ' + W + ' sessions are over - an early hit alone would make the rate look better than it is') +
      tile('Typical time to reach', S.medDays == null ? '–' : F.int(S.medDays) + ' sessions', S.medDays == null ? '' : 'about ' + monthsOf(S.medDays) + ' (median)') +
      tile('Buy at entry, sell at the target or after ' + W, S.avgOut == null ? '–' : sgn(S.avgOut), S.avgIx == null ? 'average per result' :
        'average per result · NIFTY 50 over ' + W + ' sessions ' + sgn(S.avgIx), S.avgOut > 0 ? 'up' : S.avgOut < 0 ? 'down' : '',
        'Sold at the target the day it was reached, else at the close of the ' + W + 'th session') +
      '</div>';
    var li = [];
    if (S.done) {
      li.push('Of the <b>' + F.int(S.done) + '</b> results whose ' + W + ' sessions are over, <b>' + F.int(S.hit) + ' (' + pc(S.rate) +
        ')</b> reached the target' + (S.near ? ', ' + F.int(S.near) + ' more came within ' + T.NEAR + '%' : '') + '. For results like these the rate is likely between ' +
        pc(S.lo) + ' and ' + pc(S.hi) + '.' + (S.early ? ' ' + F.int(S.early) + ' of the results still running reached it already - they count once their ' + W +
        ' sessions are over (counting only the early hits would make the rate look better than it is).' : ''));
    } else {
      li.push('No result of ' + esc(q) + ' has had ' + W + ' sessions yet' + (maxN ? ' (the longest so far: ' + F.int(maxN) + ')' : '') + ' - pick a shorter window above.');
    }
    if (S.medUp != null) li.push('The median target was <b>' + sgn(S.medUp, 0) + '</b> above the entry price - see <b>Upside at entry</b> below: the bigger the upside, the rarer the hit.');
    if (S.avgRet != null) {
      li.push('After ' + W + ' sessions the average result had moved <b>' + sgn(S.avgRet) + '</b>' + (S.avgIx != null ? ', NIFTY 50 ' + sgn(S.avgIx) + ' over the same sessions' +
        (S.beat != null ? ' - ' + pc(S.beat) + ' of them did better than NIFTY 50' : '') : '') + '.');
    }
    if (eds.length) {
      li.push('Entries from ' + esc(F.date(eds[0])) + ' to ' + esc(F.date(eds[eds.length - 1])) + ': about <b>' + F.int(medN) + ' sessions</b> have passed for the median result' +
        (maxN < T.WINDOWS[T.WINDOWS.length - 1] ? ' - the longer windows are still running, so their numbers will change' : '') + '.');
    }
    var whyTxt = Object.keys(why).sort(function (a, b) { return why[b] - why[a]; }).map(function (k) { return esc(T.WHY[k] || k) + ' ' + F.int(why[k]); });
    if (whyTxt.length) li.push('<span class="sub">Without a target: ' + whyTxt.join(' · ') + '.</span>');
    var src = sum.sum && sum.sum.ann ? sum.sum.ann : {};
    li.push('<span class="sub">Results dates: NSE\'s result filing (' + F.int(src.nse || 0) + ') or, without one, the time NSE put in the XBRL file (' + F.int(src.xbrl || 0) +
      ' - it can be a few hours after the results PDF). Results before 15:30 react the same day, later ones the next session; the entry = that session\'s close. ' +
      'EPS and prices are both on today\'s share count (splits / bonuses adjusted).</span>');
    return h + '<ul class="edge-says">' + li.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul></section>';
  }
  function monthsOf(sessions) {
    var m = sessions / 21;
    return m < 1 ? Math.max(1, Math.round(sessions / 5)) + ' weeks' : (Math.round(m * 2) / 2) + ' month' + (m >= 1.25 ? 's' : '');
  }

  function windowsHtml() {
    return '<section class="card" id="et-win"><div class="card-head"><div><h2>Every window</h2>' +
      '<p>The same quarter, 30 to 180 sessions after the entry. Each window counts only the results whose sessions are all over - so a longer window has fewer of them until time passes.</p></div></div>' +
      '<div id="et-win-t"></div></section>';
  }
  function drawWindows(el, rows) {
    var host = $('#et-win-t', el);
    if (!host) return;
    new ui.Table({ rows: T.byWindow(rows), pageSize: 10, id: 'epst-windows', tools: false, columns: [
      { key: 'W', label: 'Window', html: function (s) { return '<b>' + s.W + ' sessions</b> <span class="sub">≈ ' + MONTHS[s.W] + '</span>'; } },
      { key: 'done', label: 'Finished', type: 'num', digits: 0 },
      { key: 'hit', label: 'Reached', type: 'num', digits: 0 },
      { key: 'rate', label: 'Hit rate', type: 'num', get: function (s) { return s.rate == null ? null : s.rate * 100; },
        html: function (s) { return s.rate == null ? '–' : '<b>' + pc(s.rate) + '</b> <span class="sub">' + pc(s.lo) + '–' + pc(s.hi) + '</span>'; } },
      { key: 'near', label: 'Near miss', type: 'num', digits: 0 },
      { key: 'pending', label: 'Still running', type: 'num', digits: 0, title: 'Fewer sessions than the window since the entry (counted once it is over)' },
      { key: 'early', label: 'Reached, still running', type: 'num', digits: 0, title: 'Still running, the target already reached' },
      { key: 'medDays', label: 'Median sessions to reach', type: 'num', digits: 0 },
      { key: 'avgOut', label: 'Avg result', type: 'pct', digits: 1, title: 'Sold at the target the day it was reached, else at the close of the last session of the window' },
      { key: 'avgRet', label: 'Avg move', type: 'pct', digits: 1, title: 'Close of the last session of the window vs the entry (finished results)' },
      { key: 'avgIx', label: 'NIFTY 50', type: 'pct', digits: 1, title: 'NIFTY 50 over the same sessions' },
      { key: 'beat', label: 'Beat NIFTY', type: 'num', get: function (s) { return s.beat == null ? null : s.beat * 100; }, html: function (s) { return pc(s.beat); } }
    ] }).mount(host);
  }

  function groupsHtml() {
    return '<section class="card" id="et-groups"><div class="card-head"><div><h2>Which results reached it</h2>' +
      '<p>The hit rate of each group (in the window chosen above) - a group needs a few finished results before it means much.</p></div></div>' +
      '<nav class="chips" aria-label="Group by">' + GROUPS.map(function (g) {
        return '<button type="button" class="chip" data-epg="' + g[0] + '" aria-pressed="' + (ST.group === g[0]) + '">' + esc(g[1]) + '</button>';
      }).join('') + '</nav><div id="et-groups-b"></div><div id="et-groups-t"></div></section>';
  }
  function groupRows(rows) {
    var W = ST.opt.W;
    if (ST.group === 'growth') return T.bucket(rows, W, function (r) { return r.g; }, T.GROWTH);
    if (ST.group === 'upside') return T.bucket(rows, W, function (r) { return r.up; }, T.UPSIDE);
    if (ST.group === 'pe') return T.bucket(rows, W, function (r) { return r.pe; }, T.PE, '');
    if (ST.group === 'session') return T.groupBy(rows, W, function (r) { return r.session; }, 1);
    return T.groupBy(rows, W, function (r) { return r.sector; }, 5);
  }
  function drawGroups(el, rows) {
    var b = $('#et-groups-b', el), host = $('#et-groups-t', el);
    if (!host) return;
    el.querySelectorAll('[data-epg]').forEach(function (x) { x.setAttribute('aria-pressed', String(x.getAttribute('data-epg') === ST.group)); });
    var g = groupRows(rows);
    var shown = g.filter(function (x) { return x.done; });
    b.innerHTML = shown.length ? ui.bars(shown.map(function (x) { return { label: x.label + ' (' + F.int(x.done) + ')', value: (x.rate || 0) * 100 }; }),
      { fmt: function (v) { return v.toFixed(0) + '%'; } }) : '<p class="empty">No finished results in any group yet - pick a shorter window.</p>';
    new ui.Table({ rows: g, pageSize: 30, id: 'epst-groups', tools: false, columns: [
      { key: 'label', label: ST.group === 'sector' ? 'Sector (5+ finished)' : 'Group' },
      { key: 'done', label: 'Finished', type: 'num', digits: 0 },
      { key: 'rate', label: 'Hit rate', type: 'num', get: function (s) { return s.rate == null ? null : s.rate * 100; },
        html: function (s) { return s.rate == null ? '–' : '<b>' + pc(s.rate) + '</b> <span class="sub">' + pc(s.lo) + '–' + pc(s.hi) + '</span>'; } },
      { key: 'hit', label: 'Reached', type: 'num', digits: 0 },
      { key: 'near', label: 'Near miss', type: 'num', digits: 0 },
      { key: 'pending', label: 'Still running', type: 'num', digits: 0 },
      { key: 'medUp', label: 'Median upside', type: 'pct', digits: 0 },
      { key: 'medDays', label: 'Median sessions', type: 'num', digits: 0 },
      { key: 'avgOut', label: 'Avg result', type: 'pct', digits: 1 }
    ] }).mount(host);
  }

  function quartersHtml() {
    return '<section class="card" id="et-qs"><div class="card-head"><div><h2>Every quarter</h2><p>The same window for each quarter your laptop worked out ' +
      '(targets above the entry). Tap a quarter to open it.</p></div></div><div id="et-qs-t"></div></section>';
  }
  function drawQuarters(el, res) {
    var host = $('#et-qs-t', el);
    if (!host) return;
    var W = ST.opt.W;
    var rows = (res.quarters || []).map(function (x) {
      var s = T.sumRate(x.sum, W) || {};
      return { q: x.q, fy: x.fy || T.fy(x.q), target: x.sum.target, above: x.sum.above, done: s.done, hit: s.hit, near: s.near, pending: s.pending,
        rate: s.rate, medUp: x.sum.medUp, medG: x.sum.medG, upto: x.upto };
    });
    new ui.Table({ rows: rows, pageSize: 20, id: 'epst-quarters', tools: false, columns: [
      { key: 'q', label: 'Quarter', html: function (r) { return '<button type="button" class="linkish" data-epq="' + esc(r.q) + '">' + qWords(r.q) + '</button>'; } },
      { key: 'target', label: 'Targets', type: 'num', digits: 0 },
      { key: 'done', label: 'Finished (' + W + ')', type: 'num', digits: 0 },
      { key: 'rate', label: 'Hit rate', type: 'num', get: function (r) { return r.rate == null ? null : r.rate * 100; },
        html: function (r) { return r.done ? '<b>' + pc(r.rate) + '</b> <span class="sub">' + F.int(r.hit) + ' of ' + F.int(r.done) + '</span>' : '–'; } },
      { key: 'near', label: 'Near miss', type: 'num', digits: 0 },
      { key: 'pending', label: 'Still running', type: 'num', digits: 0 },
      { key: 'above', label: 'Above at entry', type: 'num', digits: 0 },
      { key: 'medG', label: 'Median growth', type: 'pct', digits: 0 },
      { key: 'medUp', label: 'Median upside', type: 'pct', digits: 0 }
    ] }).mount(host);
  }

  function allHtml(rows) {
    var W = ST.opt.W, n = { all: rows.length };
    Object.keys(T.STATUS).forEach(function (k) { n[k] = 0; });
    rows.forEach(function (r) { n[T.status(r, W)]++; });
    return '<section class="card" id="et-all"><div class="card-head"><div><h2>Every result</h2><p>Search a stock to see its numbers, its formula and a chart of what ' +
      'the price did. Tap <b>Details</b> on a row for the same.</p></div><div class="actions"><button class="btn" type="button" id="et-csv">Export CSV</button></div></div>' +
      '<nav class="chips" aria-label="Status">' + [['all', 'All']].concat(Object.keys(T.STATUS).map(function (k) { return [k, T.STATUS[k][0]]; })).map(function (k) {
        return '<button type="button" class="chip" data-eps="' + k[0] + '" aria-pressed="' + (ST.list === k[0]) + '">' + esc(k[1]) + ' <b>' + F.int(n[k[0]]) + '</b></button>';
      }).join('') + '</nav><div class="controls"><input class="search" id="et-q" type="search" placeholder="Search a stock (e.g. LAURUSLABS)" aria-label="Search a stock" value="' +
      esc(ST.one) + '"><span class="count" id="et-count"></span></div><div id="et-one"></div><div id="et-all-t"></div></section>';
  }
  function drawAll(el, rows, res) {
    var host = $('#et-all-t', el);
    if (!host) return;
    var W = ST.opt.W, k = T.WINDOWS.indexOf(W);
    var t = new ui.Table({ rows: [], pageSize: 50, id: 'epst-all', empty: 'No result with this status', columns: [
      { key: 'sym', label: 'Stock', type: 'sym', name: 'name' },
      { key: 'status', label: 'In ' + W + ' sessions', get: function (r) { return T.STATUS[T.status(r, W)][0]; }, html: function (r) { return badge(T.status(r, W)); } },
      { key: 'ann', label: 'Results out', title: 'When NSE got the results (IST): its result filing, else the time in the XBRL file\'s name',
        html: function (r) { return r.ann ? esc(F.date(r.ann.slice(0, 10))) + ' <span class="sub">' + esc(r.ann.slice(11)) + (r.src === 'xbrl' ? ' (XBRL)' : '') + '</span>' : '<span class="sub">–</span>'; } },
      { key: 'ed', label: 'Entry', type: 'date', title: 'The first session that could react: the results day itself before 15:30, else the next session' },
      { key: 'ep', label: 'Entry price', type: 'price', title: 'That session\'s close' },
      { key: 'ttm', label: 'TTM EPS', type: 'num', digits: 2 },
      { key: 'prev', label: 'EPS 4Q before', type: 'num', digits: 2 },
      { key: 'g', label: 'EPS growth', type: 'pct', digits: 1 },
      { key: 'tgt', label: 'Target', type: 'price' },
      { key: 'up', label: 'Upside at entry', type: 'pct', digits: 0 },
      { key: 'pe', label: 'PE at entry', type: 'num', digits: 1 },
      { key: 'hit', label: 'Reached in', title: 'Sessions after the entry until a daily high touched the target',
        get: function (r) { return r.hit; }, html: function (r) { return r.hit != null ? F.int(r.hit) + ' <span class="sub">' + esc(F.date(r.hitd)) + '</span>' : '<span class="sub">–</span>'; } },
      { key: 'mx', label: 'Best high', type: 'num', title: 'The highest high within the window as % of the target (so far, while it is still running)',
        get: function (r) { return r.mx[k]; }, html: function (r) { return r.mx[k] == null ? '–' : r.mx[k].toFixed(0) + '% of target'; } },
      { key: 'dd', label: 'Lowest', type: 'pct', digits: 1, title: 'The lowest low within the window vs the entry', get: function (r) { return r.dd[k]; } },
      { key: 'cl', label: 'After ' + W, type: 'pct', digits: 1, title: 'The close of the ' + W + 'th session vs the entry', get: function (r) { return r.cl[k]; } },
      { key: 'ix', label: 'NIFTY 50', type: 'pct', digits: 1, title: 'NIFTY 50 over the same sessions', get: function (r) { return r.ix[k]; } },
      { key: 'now', label: 'Now vs entry', type: 'pct', digits: 1, title: 'The last daily close the laptop had vs the entry' },
      { key: 'toTgt', label: 'Price → target', type: 'pct', digits: 1, title: 'How far the price shown on this site is from the target' },
      { key: 'n', label: 'Sessions so far', type: 'num', digits: 0 },
      { key: 'why', label: 'No target because', get: function (r) { return r.st === 'ok' ? '' : T.WHY[r.why] || ''; } },
      { key: 'b', label: 'Basis', title: 'C = consolidated, S = standalone EPS' },
      { key: 'go', label: 'Details', get: function () { return ''; }, html: function (r) { return '<button type="button" class="btn sm" data-epone="' + esc(r.sym) + '">Details</button>'; } }
    ], hide: ['pe', 'dd', 'ix', 'b', 'why'] }).mount(host);
    function apply() {
      var w = ST.one.trim();
      var list = rows.filter(function (r) { return (ST.list === 'all' || T.status(r, W) === ST.list) && (!w || ui.textMatch(w, [r.sym, r.name])); });
      $('#et-count', el).textContent = F.int(list.length) + ' of ' + F.int(rows.length);
      t.setRows(list);
      oneCard(el, rows, res);
    }
    var timer;
    $('#et-q', el).addEventListener('input', function (e) { clearTimeout(timer); timer = setTimeout(function () { ST.one = e.target.value; apply(); }, 150); });
    el.querySelectorAll('[data-eps]').forEach(function (b) {
      b.addEventListener('click', function () {
        ST.list = b.getAttribute('data-eps');
        el.querySelectorAll('[data-eps]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        apply();
      });
    });
    host.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-epone]');
      if (!b) return;
      ST.one = b.getAttribute('data-epone');
      $('#et-q', el).value = ST.one;
      apply();
      var box = $('#et-one', el);
      if (box && box.scrollIntoView) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('#et-csv', el).addEventListener('click', function () { ui.download('eps-target-' + String(res.q).replace(' ', '-') + '-' + W + '.csv', ui.toCsv(t.toCsvRows())); });
    apply();
  }

  /** one stock's card: its 8 EPS, the formula with its numbers, the dates, a chart of the price after the entry */
  function oneCard(el, rows, res) {
    var box = $('#et-one', el), w = ST.one.trim().toUpperCase();
    if (!box) return;
    if (!w) { box.innerHTML = ''; return; }
    var r = rows.filter(function (x) { return x.sym === w; })[0];
    if (!r) {
      var some = rows.filter(function (x) { return ui.textMatch(ST.one, [x.sym, x.name]); });
      box.innerHTML = some.length === 1 ? '' : some.length ? '' : '<p class="empty">No ' + esc(res.q) + ' result for "' + esc(ST.one) + '" - it needs 8 quarters of EPS.</p>';
      if (some.length !== 1) return;
      r = some[0];
    }
    var W = ST.opt.W, st = T.status(r, W), f = T.formula(r), labs = T.quarters(res.q);
    var marks = String(r.fl || '');
    var epsT = '<table class="et-eps"><thead><tr>' + labs.map(function (l, i) { return '<th' + (i >= 4 ? ' class="ttm"' : '') + '>' + esc(l) + '</th>'; }).join('') +
      '</tr></thead><tbody><tr>' + r.eps.map(function (v, i) {
        var m = marks.charAt(i), tip = T.FLAG[m] || '';
        return '<td' + (i >= 4 ? ' class="ttm"' : '') + (tip ? ' data-tip="' + esc('EPS from ' + tip) + '"' : '') + '>' + (v == null ? '–' : v.toFixed(2)) +
          (tip && m !== 'p' ? '<sup>' + esc(m) + '</sup>' : '') + '</td>';
      }).join('') + '</tr></tbody></table>';
    var timeTxt = r.ann ? esc(F.date(r.ann.slice(0, 10))) + ' ' + esc(r.ann.slice(11)) + ' <span class="sub">(' + (r.src === 'xbrl' ? 'the time in NSE\'s XBRL file' : 'NSE\'s result filing') + ' · ' + esc(r.session) + ')</span>' : '–';
    var h = '<div class="et-one"><h3>' + esc(r.sym) + ' <span class="sub">' + esc(r.name || '') + '</span> ' + badge(st) + '</h3>' +
      '<div class="et-formula">' + epsT +
      '<p><b>TTM EPS</b> (' + esc(labs[4]) + ' – ' + esc(labs[7]) + ') = ' + esc(f.ttm) + '<br><b>The 4 quarters before</b> = ' + esc(f.prev) +
      '<br><b>EPS growth</b> = ' + esc(f.growth) + '<br><b>Target</b> = ' + esc(f.target) + (r.why && r.st !== 'ok' ? ' <span class="sub">- ' + esc(T.WHY[r.why] || '') + '</span>' : '') + '</p></div>' +
      '<p>Results out: ' + timeTxt + (r.ed ? ' → entry <b>' + esc(F.date(r.ed)) + '</b> at <b>' + F.price(r.ep) + '</b> <span class="sub">(the close; that day opened ' + F.price(r.o0) +
        ', the close before ' + F.price(r.pre) + ')</span>' : '') +
      (r.up != null ? ' → target ' + F.price(r.tgt) + ' = <b>' + sgn(r.up, 0) + '</b> from the entry' : '') + '.</p>';
    if (r.st === 'ok') {
      var k = T.WINDOWS.indexOf(W);
      h += '<p>' + (st === 'above' ? 'The price was already above the target at the entry.'
        : r.hit != null ? 'A daily high reached the target after <b>' + F.int(r.hit) + ' sessions</b>, on ' + esc(F.date(r.hitd)) + (r.hit > W ? ' (after your ' + W + '-session window)' : '') + '.'
          : 'Not reached in ' + F.int(r.n) + ' session' + (r.n === 1 ? '' : 's') + ' so far' + (r.mx[k] != null ? ' - the best high within ' + Math.min(W, r.n) + ' sessions was ' + r.mx[k].toFixed(0) + '% of the target' : '') + '.') +
        (r.now != null ? ' The last close the laptop had: ' + sgn(r.now) + ' from the entry' + (r.price ? ', the price on this site ' + F.price(r.price) + ' (' + sgn(r.toTgt) + ' to the target)' : '') + '.' : '') + '</p>' +
        '<div class="et-chart">' + chartSvg(r, W) + '</div>';
    }
    h += '<div class="actions"><a class="btn sm" target="_blank" rel="noopener" href="https://www.tradingview.com/chart/?symbol=' + encodeURIComponent('NSE:' + r.sym) + '">Open on TradingView</a>' +
      '<button type="button" class="btn sm" data-sym="' + esc(r.sym) + '">Stock window</button></div></div>';
    box.innerHTML = h;
  }

  /** the price after the entry: closes (line) and highs (faint) every 5 sessions as % from the entry; the target, the entry,
   *  the window and the day it was reached */
  function chartSvg(r, W) {
    var pcs = r.pc || [], phs = r.ph || [];
    if (!pcs.length) return '<p class="sub">No session after the entry yet.</p>';
    var Wd = 640, Hd = 220, P = { l: 46, r: 92, t: 12, b: 26 };
    var xs = [0].concat(pcs.map(function (_, j) { return Math.min((j + 1) * 5, r.n); }));
    var xmax = Math.max(xs[xs.length - 1], Math.min(W, 180));
    var ys = [0, r.up || 0].concat(pcs, phs, [r.dd[T.WINDOWS.length - 1] || 0]).filter(function (v) { return v != null && isFinite(v); });
    var lo = Math.min.apply(null, ys), hi = Math.max.apply(null, ys);
    var pad = (hi - lo || 10) * 0.08;
    lo -= pad; hi += pad;
    var X = function (s) { return P.l + (Wd - P.l - P.r) * s / xmax; };
    var Y = function (v) { return P.t + (Hd - P.t - P.b) * (hi - v) / (hi - lo); };
    var line = function (vals) { return [[0, 0]].concat(vals.map(function (v, j) { return [xs[j + 1], v]; })).filter(function (p) { return p[1] != null; })
      .map(function (p) { return X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1); }).join(' '); };
    var h = '<svg viewBox="0 0 ' + Wd + ' ' + Hd + '" role="img" aria-label="' + esc(r.sym + ': the price after the entry vs the target') + '">';
    // grid: 0 %, the target, a few steps
    var step = Math.pow(10, Math.floor(Math.log(hi - lo) / Math.LN10));
    if ((hi - lo) / step < 4) step /= 2;
    for (var g = Math.ceil(lo / step) * step; g <= hi; g += step) {
      h += '<line class="et-g" x1="' + P.l + '" x2="' + (Wd - P.r) + '" y1="' + Y(g).toFixed(1) + '" y2="' + Y(g).toFixed(1) + '"/><text class="et-ax" x="' + (P.l - 6) + '" y="' +
        (Y(g) + 4).toFixed(1) + '" text-anchor="end">' + (g > 0 ? '+' : '') + Math.round(g) + '%</text>';
    }
    h += '<line class="et-entry" x1="' + P.l + '" x2="' + (Wd - P.r) + '" y1="' + Y(0).toFixed(1) + '" y2="' + Y(0).toFixed(1) + '"/>' +
      '<text class="et-lab" x="' + (Wd - P.r + 4) + '" y="' + (Y(0) + 4).toFixed(1) + '">Entry ' + esc(F.price(r.ep)) + '</text>';
    if (r.up != null) {
      h += '<line class="et-tgt" x1="' + P.l + '" x2="' + (Wd - P.r) + '" y1="' + Y(r.up).toFixed(1) + '" y2="' + Y(r.up).toFixed(1) + '"/>' +
        '<text class="et-lab et-tl" x="' + (Wd - P.r + 4) + '" y="' + (Y(r.up) + 4).toFixed(1) + '">Target ' + esc(F.price(r.tgt)) + '</text>';
    }
    if (W <= xmax) {
      h += '<line class="et-win" x1="' + X(W).toFixed(1) + '" x2="' + X(W).toFixed(1) + '" y1="' + P.t + '" y2="' + (Hd - P.b) + '"/>' +
        '<text class="et-ax" x="' + (X(W) - 4).toFixed(1) + '" y="' + (Hd - P.b - 5) + '" text-anchor="end">' + W + '-session window</text>';
    }
    h += '<polyline class="et-hi" points="' + line(phs) + '"/><polyline class="et-cl" points="' + line(pcs) + '"/>';
    if (r.hit != null && r.hit <= xmax && r.up != null) {
      h += '<circle class="et-hit" cx="' + X(r.hit).toFixed(1) + '" cy="' + Y(r.up).toFixed(1) + '" r="5"/><text class="et-lab et-tl" x="' + X(r.hit).toFixed(1) + '" y="' +
        (Y(r.up) - 9).toFixed(1) + '" text-anchor="middle">reached · day ' + r.hit + '</text>';
    }
    h += '<text class="et-ax" x="' + P.l + '" y="' + (Hd - 6) + '">entry ' + esc(F.date(r.ed)) + '</text><text class="et-ax" x="' + (Wd - P.r) + '" y="' + (Hd - 6) +
      '" text-anchor="end">' + xmax + ' sessions</text></svg>';
    return h + '<p class="sub">Line = the close, faint line = the highest high of each 5 sessions, both from the entry price.</p>';
  }

  // ---------- the page ----------
  SB.page('epst', {
    render: function (el, params, ctx) {
      if (params && params[0] && /^[A-Za-z0-9&_.-]{1,30}$/.test(params[0])) ST.one = params[0].toUpperCase();
      var head = '<div class="page-head"><div><h1>EPS Target Lab</h1><p>Your target = <b>TTM EPS × EPS growth %</b> - the sheet\'s TargetPrice ' +
        '(TTM EPS = the newest 4 quarters\' EPS added up; growth = vs the 4 quarters before; the same as a PE equal to the growth rate). ' +
        'For every stock and quarter: when the results came out, the price you could buy at, and whether the price <b>reached the target</b> afterwards. ' +
        'Worked out by your laptop from NSE\'s result filings and the Kite daily candles.</p></div></div>';
      el.innerHTML = head + '<div id="et-body"><section class="card" aria-busy="true"><h2>Loading the quarter…</h2>' + ui.skeleton(3) + '</section></div>';
      var want = ST.q || ST.opt.q || '';
      fetchQ(ctx, want).then(function (got) {
        var body = $('#et-body', el);
        if (!body || !el.isConnected) return;
        if (got.error) {
          body.innerHTML = '<section class="card"><p class="empty">' + (got.error === 'local'
            ? 'The EPS Target Lab comes from your laptop through the live website - open the live site to see it.'
            : 'Could not load the EPS Target Lab: ' + esc(got.error) + '.') + '</p></section>';
          return;
        }
        var res = got.res;
        if (want && res.q !== want && res.quarters && res.quarters.length && !res.rows.length) {   // a quarter no longer kept: the default one
          ST.q = '';
          ST.opt.q = '';
          save();
          SB.route(true);
          return;
        }
        if (!res.quarters || !res.quarters.length) {
          body.innerHTML = '<section class="card"><p class="empty">Nothing here yet - your laptop works this out after its next round (or run ' +
            '<b>EpsTargetNow.bat</b> in the ScreenerBridge folder). It needs the Kite daily candles and the results tables / EPS history it already keeps.</p></section>';
          return;
        }
        var rows = prepare(res, ctx);
        body.innerHTML = (got.kept ? '<div class="note">Showing the copy this device kept' + (got.kept !== true ? ' (' + esc(F.dateTime(got.kept)) + ')' : '') +
          ' - the live copy could not be read just now.</div>' : '') + pickHtml(res) + summaryHtml(res, rows, ctx) + windowsHtml() + groupsHtml() + quartersHtml() + allHtml(rows);
        drawWindows(body, rows);
        drawGroups(body, rows);
        drawQuarters(body, res);
        drawAll(body, rows, res);
        body.addEventListener('click', function (e) {
          var q = e.target.closest && e.target.closest('[data-epq]');
          if (q) {
            ST.q = q.getAttribute('data-epq');
            ST.opt.q = ST.q;
            save();
            SB.route(true);
            return;
          }
          var g = e.target.closest && e.target.closest('[data-epg]');
          if (g) { ST.group = g.getAttribute('data-epg'); drawGroups(body, rows); }
        });
        $('#et-w', body).addEventListener('change', function (e) {
          ST.opt.W = Number(e.target.value);
          save();
          SB.route(true);
        });
      });
    }
  });
})();
