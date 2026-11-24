/* EPS Target Lab (#epst, #epst/<SYMBOL>) - owner, 23-Nov-2026: LAURUSLABS - "Q1(June 2026) result came in July 24 2026 ...
   at July 27th stock price was 1624. but now the stock price is 2370 and nearly touched its target price on 11 November
   2026 at 2488 ... It is impressive to see our method is actually working. but i don't know how many stocks like this
   reached atmost its target price after Q1 result update ... I want to analyse with Q1 results first."
   The sheet's own target (TTM EPS x EPS growth %), every stock and quarter: when the results came out (NSE's result filing,
   else the XBRL file's time), the entry (the close of the first session that could react), and whether the price covered
   80 % of the way to the target within 30 / 60 / 90 / 120 / 180 sessions. Owner, 24-Nov-2026: "if a stock hit atleast 80%
   of the target price, consider as it is target hit" (80 % of the way - his answer), a target under the entry price is a
   DOWNSIDE target kept apart ("we are long trader. it should not mingle with long trades"), and "list those stocks which
   hit target at every/maximum quarter as per our thesis". Then (24-Nov-2026): "add another session, as reached within next
   quarterly result date" (the window 'next'), 50 / 60 / 70 % of the way too, and "Atleast target vs Entry % as atleast 10% and
   above, 20% and above, between ... These unimaginable targets reduce our winrate" (the target filter: long targets outside it
   are left out of every figure). Worked out by the laptop (eps_target.py); counted by web/lib/epstarget.js. */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, esc = ui.esc, F = ui.F, $ = ui.$, T = SB.epst;
  var OPT_KEY = 'sb:epst:opts';
  var ST = { opt: load(), q: '', list: 'all', group: 'growth', one: '', th: 'every' };
  var MEMO = {};
  var MONTHS = { 30: '1.5 months', 60: '3 months', 90: '4.5 months', 120: '6 months', 180: '9 months', next: 'about 3 months' };
  var GROUPS = [['growth', 'EPS growth'], ['upside', 'Upside at entry'], ['pe', 'PE at entry'], ['session', 'When the results came'], ['sector', 'Sector']];
  var MARK = { hit: ['✓', 'reached'], early: ['✓', 'reached (its window still running)'], not: ['✗', 'not reached'], pending: ['…', 'still running'],
    down: ['↓', 'a downside target (below the entry) - not counted'], none: ['–', 'no target (EPS fell / a loss / no results date)'],
    out: ['○', 'left out by your target filter'], '': ['·', 'not 8 quarters of EPS yet'] };

  function load() {
    var o = null;
    try { o = JSON.parse(localStorage.getItem(OPT_KEY) || 'null'); } catch (e) { o = null; }
    o = o && typeof o === 'object' ? o : {};
    var lim = function (v, list) { return v != null && list.indexOf(Number(v)) > 0 ? Number(v) : null; };
    return { q: typeof o.q === 'string' ? o.q : '', W: T.win(o.W) || 60, T: T.THRESH.indexOf(Number(o.T)) >= 0 ? Number(o.T) : T.MAIN_T,
      lo: lim(o.lo, T.UP_MIN), hi: lim(o.hi, T.UP_MAX) };
  }
  function save() { try { localStorage.setItem(OPT_KEY, JSON.stringify(ST.opt)); } catch (e) { /* private window */ } }
  function pc(v, d) { return v == null || !isFinite(v) ? '–' : (v * 100).toFixed(d == null ? 0 : d) + '%'; }
  function sgn(v, d) { return v == null || !isFinite(v) ? '–' : (v > 0 ? '+' : '') + v.toFixed(d == null ? 1 : d) + '%'; }
  function tile(label, value, note, tone, tip) {
    return '<div class="tile"' + (tip ? ' data-tip="' + esc(tip) + '"' : '') + '><div class="label">' + esc(label) + '</div><div class="value' +
      (tone ? ' ' + tone : '') + '">' + value + '</div>' + (note ? '<div class="note2">' + note + '</div>' : '') + '</div>';
  }
  function statusBadge(r, W, Tt) {
    var k = T.kind(r, W, Tt);
    if (k !== 'down') return ui.badge(T.STATUS[k][0], T.STATUS[k][1]);
    var d = T.DSTATUS[T.status(r, W, Tt)];
    return ui.badge('↓ ' + d[0], d[1]);
  }
  function statusText(r, W, Tt) {
    var k = T.kind(r, W, Tt);
    return k === 'down' ? 'Downside: ' + T.DSTATUS[T.status(r, W, Tt)][0] : T.STATUS[k][0];
  }
  function qWords(q) { var f = T.fy(q); return esc(q) + (f ? ' · ' + f : ''); }
  function ruleWords(Tt) {
    return Tt === 100 ? 'the target itself' : Tt + '% of the way from the entry to the target';
  }
  var NX = T.NEXT;
  /** the window in words: 'within 60 sessions' / 'before the next results' */
  function winName(W) { return W === NX ? 'before the next results' : 'within ' + W + ' sessions'; }
  function winShort(W) { return W === NX ? 'Until next results' : W + ' sessions'; }
  function overWords(W) { return W === NX ? 'whose next results are out' : 'whose ' + W + ' sessions are over'; }
  function runWords(W) { return W === NX ? 'the next quarter\'s results not out yet' : 'fewer than ' + W + ' sessions since the entry'; }
  function endWords(W) { return W === NX ? 'at the next results' : 'after ' + W + ' sessions'; }
  function filterOn() { return ST.opt.lo != null || ST.opt.hi != null; }
  function filterWords() {
    var lo = ST.opt.lo, hi = ST.opt.hi;
    return lo != null && hi != null ? lo + '% to ' + hi + '% above the entry' : lo != null ? 'at least ' + lo + '% above the entry' : 'at most ' + hi + '% above the entry';
  }

  // ---------- data ----------
  function fetchQ(ctx, q, lite) {
    var key = (q || '*') + (lite ? ':lite' : '');
    if (MEMO[key]) return MEMO[key];
    var keepKey = 'epst:' + key;
    var path = 'api/epstarget' + (q ? '?q=' + encodeURIComponent(q) + (lite ? '&lite=1' : '') : '');
    var p = (ctx.site.apiBase == null ? Promise.reject(new Error('local')) : SB.api(path, 35000))
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
    T.markOut(rows, ST.opt.lo, ST.opt.hi);
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
    var opt = function (v, on, words) { return '<option value="' + v + '"' + (on ? ' selected' : '') + '>' + esc(words) + '</option>'; };
    var lo = ST.opt.lo, hi = ST.opt.hi;
    return '<section class="card" id="et-pick"><div class="card-head"><div><h2>Quarter, window and your rule</h2>' +
      '<p>A long target counts as <b>reached</b> when a daily <b>high</b> covered at least <b>' + esc(ruleWords(ST.opt.T)) + '</b> within the window ' +
      'after the entry (entry ₹100, target ₹200: ₹' + (100 + ST.opt.T) + '). <b>Until the next results</b> = the sessions after the entry before the first one that could ' +
      'react to the next quarter\'s results. Results whose window is not over yet are shown as <b>still running</b> - never as misses. ' +
      'A target <b>under</b> the entry price is a <b>downside target</b>, counted apart below.</p></div></div>' +
      '<nav class="chips" aria-label="Quarter">' + (chips || '<span class="sub">No quarter yet</span>') + '</nav>' +
      '<div class="controls edge-opts"><label class="edge-opt">Reached within <select id="et-w">' + T.WINS.map(function (W) {
        return opt(W, W === ST.opt.W, W === NX ? 'Until the next results (' + MONTHS[W] + ')' : W + ' sessions (about ' + MONTHS[W] + ')');
      }).join('') + '</select></label><label class="edge-opt">Counts as reached at <select id="et-t">' + T.THRESH.map(function (Tt) {
        return opt(Tt, Tt === ST.opt.T, Tt === 100 ? 'the target itself' : Tt + '% of the way' + (Tt === T.MAIN_T ? ' (your rule)' : ''));
      }).join('') + '</select></label>' +
      '<label class="edge-opt">Target vs entry: at least <select id="et-lo">' + T.UP_MIN.map(function (v) {
        return opt(v == null ? '' : v, v === lo, v == null ? 'any' : v + '%');
      }).join('') + '</select></label><label class="edge-opt">at most <select id="et-hi">' + T.UP_MAX.map(function (v) {
        return opt(v == null ? '' : v, v === hi, v == null ? 'no limit' : v + '%');
      }).join('') + '</select></label></div>' +
      '<p class="sub" id="et-filter-note">' + (filterOn()
        ? 'Only long targets <b>' + esc(filterWords()) + '</b> are counted on this page; the others are left out of every figure (the chip <b>Left out by your target filter</b> below lists them).' +
          (lo != null && hi != null && lo >= hi ? ' <b>At least is not below at most - nothing is left.</b>' : '')
        : 'Target vs entry: every long target counts. A huge target (1,000%+) comes from EPS growing from almost nothing - use <b>at most</b> to leave those out.') + '</p></section>';
  }

  function summaryHtml(res, rows) {
    var W = ST.opt.W, Tt = ST.opt.T, S = T.stats(rows, W, Tt), D = T.stats(rows, W, Tt, 'down'), q = res.q;
    var sum = (res.quarters || []).filter(function (x) { return x.q === q; })[0] || {};
    var ups = rows.filter(function (r) { return r.dir === 'up'; });
    var eds = ups.map(function (r) { return r.ed; }).filter(Boolean).sort();
    var ns = ups.map(function (r) { return r.n; }).filter(function (n) { return n != null; });
    var maxN = ns.length ? Math.max.apply(null, ns) : 0, medN = T.median(ns);
    var why = {};
    rows.forEach(function (r) { if (r.st !== 'ok' && r.why) why[r.why] = (why[r.why] || 0) + 1; });
    var h = '<section class="card" id="et-sum"><div class="card-head"><div><h2>What ' + qWords(q) + ' says</h2><p>' +
      F.int(rows.length) + ' stocks with 8 quarters of EPS · prices up to ' + (sum.upto ? esc(F.date(sum.upto)) : '–') +
      (sum.made ? ' · worked out by your laptop ' + esc(F.dateTime(sum.made.replace('T', ' '))) : '') + '.</p></div></div>';
    h += '<div class="tiles">' +
      tile('Long targets (above the entry)', F.int(S.n), F.int(S.other) + ' downside targets apart · ' + F.int(S.none) + ' without a target' +
        (S.out ? ' · ' + F.int(S.out) + ' left out by your target filter' : ''), '',
        'A target under the entry price is a downside target - counted apart, never mixed with the long ones') +
      tile('Reached ' + winName(W), S.rate == null ? '–' : pc(S.rate), S.done ? F.int(S.hit) + ' of ' + F.int(S.done) + ' finished · likely ' +
        pc(S.lo) + '–' + pc(S.hi) : 'none finished yet', S.rate != null ? 'up' : '',
        'Reached = ' + ruleWords(Tt) + '. Only results ' + overWords(W) + ' count. Likely range = where the rate of results like these would fall 9 times out of 10') +
      tile('Still running', F.int(S.pending), runWords(W) + (S.early ? ' · ' + F.int(S.early) + ' reached it already' : ''), '',
        'They count once their window is over - an early hit alone would make the rate look better than it is') +
      tile('Typical time to reach', S.medDays == null ? '–' : F.int(S.medDays) + ' sessions', S.medDays == null ? '' : 'about ' + monthsOf(S.medDays) + ' (median)') +
      tile('Buy at entry, sell at ' + (Tt === 100 ? 'the target' : 'the ' + Tt + '% level') + ' or ' + (W === NX ? 'at the next results' : 'after ' + W),
        S.avgOut == null ? '–' : sgn(S.avgOut), S.avgIx == null ? 'average per result' : 'average per result · NIFTY 50 over the same sessions ' + sgn(S.avgIx),
        S.avgOut > 0 ? 'up' : S.avgOut < 0 ? 'down' : '',
        'Sold the day the price reached ' + ruleWords(Tt) + ', else at the close of the last session of the window') +
      tile('Downside targets', F.int(D.n), D.done ? 'fell ' + (Tt === 100 ? 'to the target' : Tt + '% of the way down') + ': ' + F.int(D.hit) + ' of ' + F.int(D.done) +
        ' finished (' + pc(D.rate) + ') - see below' : 'see below', '', 'The formula\'s price was under the price at the entry') +
      '</div>';
    var li = [];
    if (S.done) {
      li.push('Of the <b>' + F.int(S.done) + '</b> long targets ' + overWords(W) + ', <b>' + F.int(S.hit) + ' (' + pc(S.rate) +
        ')</b> reached ' + esc(ruleWords(Tt)) + (W === NX ? ' before the next results' : '') + '. For results like these the rate is likely between ' + pc(S.lo) +
        ' and ' + pc(S.hi) + '.' + (S.early ? ' ' + F.int(S.early) + ' of the results still running reached it already - they count once their window is over ' +
          '(counting only the early hits would make the rate look better than it is).' : ''));
      if (W === NX) {
        li.push('The next results came <b>' + F.int(S.medLen) + ' sessions</b> after the entry for the median result' + (S.approx ? ' (for ' + F.int(S.approx) +
          ' of them no date was found - the window ends on the last day SEBI allows for those results: 45 days after the quarter, 60 for March)' : '') + '.');
      }
    } else {
      li.push(W === NX ? 'The next results of ' + esc(q) + '\'s long targets are not out yet - pick a window in sessions above, or come back after the next results season.'
        : 'No long target of ' + esc(q) + ' has had ' + W + ' sessions yet' + (maxN ? ' (the longest so far: ' + F.int(maxN) + ')' : '') + ' - pick a shorter window above.');
    }
    if (S.out) li.push(F.int(S.out) + ' long target' + (S.out === 1 ? '' : 's') + ' left out: not ' + esc(filterWords()) + ' (your target filter above).');
    if (S.medUp != null) li.push('The median target was <b>' + sgn(S.medUp, 0) + '</b> above the entry price - see <b>Upside at entry</b> below: the bigger the upside, the rarer the hit.');
    if (S.avgRet != null) {
      li.push((W === NX ? 'At the next results' : 'After ' + W + ' sessions') + ' the average long target\'s stock had moved <b>' + sgn(S.avgRet) + '</b>' + (S.avgIx != null ? ', NIFTY 50 ' + sgn(S.avgIx) + ' over the same sessions' +
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

  // ---------- stocks that respect the thesis (every quarter the laptop worked out) ----------
  function thesisHtml() {
    return '<section class="card" id="et-thesis"><div class="card-head"><div><h2>Stocks that respect the thesis</h2>' +
      '<p>Every quarter your laptop worked out, stock by stock: did the price reach its long target (' + esc(ruleWords(ST.opt.T)) + ', ' + winName(ST.opt.W) +
      ') after the results, quarter after quarter? ✓ reached · ✗ not reached · … still running · ↓ a downside target (not counted) · – no target' +
      (filterOn() ? ' · ○ left out by your target filter' : '') + '. ' +
      'A target reached counts even while its window still runs; a quarter still running without it waits until its window is over.</p></div>' +
      '<div class="actions"><button class="btn" type="button" id="et-th-csv" hidden>Export CSV</button></div></div>' +
      '<nav class="chips" aria-label="Which stocks">' + [['every', 'Reached every finished quarter'], ['most', 'Reached most quarters'], ['all', 'Every stock']].map(function (k) {
        return '<button type="button" class="chip" data-epth="' + k[0] + '" aria-pressed="' + (ST.th === k[0]) + '">' + esc(k[1]) + ' <b data-epthn="' + k[0] + '"></b></button>';
      }).join('') + '</nav><div id="et-th-body"><p class="sub" id="et-th-load">Reading the other quarters…</p></div></section>';
  }
  function drawThesis(el, ctx, res, rows) {
    var host = $('#et-th-body', el);
    if (!host) return;
    var qs = (res.quarters || []).map(function (x) { return x.q; }).slice().reverse();     // oldest first
    var others = qs.filter(function (q) { return q !== res.q; });
    var byQ = {};
    byQ[res.q] = rows;
    var done = 0;
    var say = function () { var p = $('#et-th-load', el); if (p) p.textContent = 'Reading the other quarters… ' + done + ' of ' + others.length; };
    say();
    // one quarter at a time (lite = without the charts' paths) - kept on the device like the rest
    var chain = Promise.resolve();
    others.forEach(function (q) {
      chain = chain.then(function () {
        return fetchQ(ctx, q, true).then(function (got) {
          done++;
          if (got.res) byQ[q] = prepare(got.res, ctx);
          say();
        });
      });
    });
    chain.then(function () {
      if (!el.isConnected) return;
      var W = ST.opt.W, Tt = ST.opt.T;
      drawQuarters(el, res, byQ);
      var list = T.thesis(byQ, qs, W, Tt);
      var nameOf = function (sym) { var s = ctx.bySym[sym]; return s ? s.name : ''; };
      list.forEach(function (e) { e.name = nameOf(e.sym); });
      var pick = function (k) {
        return list.filter(function (e) { return k === 'every' ? e.every : k === 'most' ? e.most : e.done + e.pending > 0; })
          .sort(function (a, b) { return (b.hit - a.hit) || ((b.rate || 0) - (a.rate || 0)) || (b.done - a.done) || (a.sym < b.sym ? -1 : 1); });
      };
      ['every', 'most', 'all'].forEach(function (k) { var b = el.querySelector('[data-epthn="' + k + '"]'); if (b) b.textContent = F.int(pick(k).length); });
      host.innerHTML = '<div id="et-th-t"></div>';
      var t = new ui.Table({ rows: [], pageSize: 25, id: 'epst-thesis', empty: 'No stock here yet - with more finished quarters this list fills.', columns: [
        { key: 'sym', label: 'Stock', type: 'sym', name: 'name' },
        { key: 'hit', label: 'Reached', type: 'num', get: function (e) { return e.hit; },
          html: function (e) { return '<b>' + F.int(e.hit) + ' of ' + F.int(e.done) + '</b>' + (e.pending ? ' <span class="sub">+' + e.pending + ' running</span>' : ''); } },
        { key: 'rate', label: 'Hit rate', type: 'num', get: function (e) { return e.rate == null ? null : e.rate * 100; }, html: function (e) { return pc(e.rate); } },
        { key: 'marks', label: 'Quarters (oldest → newest)', get: function (e) { return e.marks.map(function (m) { return MARK[m][0]; }).join(' '); },
          html: function (e) {
            return '<span class="et-marks">' + e.marks.map(function (m, i) {
              return '<span class="et-mk et-mk-' + (m || 'na') + '" data-tip="' + esc(qs[i] + ': ' + MARK[m][1]) + '">' + MARK[m][0] + '</span>';
            }).join('') + '</span>';
          } },
        { key: 'medDays', label: 'Median sessions to reach', type: 'num', digits: 0 },
        { key: 'medUp', label: 'Median upside at entry', type: 'pct', digits: 0 },
        { key: 'down', label: 'Downside quarters', type: 'num', digits: 0 },
        { key: 'last', label: 'Newest quarter', get: function (e) { return e.last ? e.last.q + ' ' + MARK[e.last.mark][1] : ''; },
          html: function (e) { return e.last ? esc(e.last.q) + ' <span class="sub">' + esc(MARK[e.last.mark][1]) + (e.last.r.up != null ? ' · target ' + sgn(e.last.r.up, 0) : '') + '</span>' : '–'; } }
      ] }).mount($('#et-th-t', el));
      t.setRows(pick(ST.th));
      el.querySelectorAll('[data-epth]').forEach(function (b) {
        b.addEventListener('click', function () {
          ST.th = b.getAttribute('data-epth');
          el.querySelectorAll('[data-epth]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
          t.setRows(pick(ST.th));
        });
      });
      var csv = $('#et-th-csv', el);
      if (csv) {
        csv.hidden = false;
        csv.addEventListener('click', function () { ui.download('eps-target-thesis-' + W + '-' + Tt + '.csv', ui.toCsv(t.toCsvRows())); });
      }
    });
  }

  function windowCols(dir) {
    var word = dir === 'down' ? 'Fell to it' : 'Reached';
    return [
      { key: 'W', label: 'Window', get: function (s) { return s.W === NX ? 999 : s.W; }, html: function (s) {
        return s.W === NX ? '<b>Until the next results</b> <span class="sub">' + (s.medLen != null ? 'median ' + F.int(s.medLen) + ' sessions' : '≈ ' + MONTHS[s.W]) + '</span>'
          : '<b>' + s.W + ' sessions</b> <span class="sub">≈ ' + MONTHS[s.W] + '</span>';
      } },
      { key: 'done', label: 'Finished', type: 'num', digits: 0 },
      { key: 'hit', label: word, type: 'num', digits: 0 },
      { key: 'rate', label: 'Hit rate', type: 'num', get: function (s) { return s.rate == null ? null : s.rate * 100; },
        html: function (s) { return s.rate == null ? '–' : '<b>' + pc(s.rate) + '</b> <span class="sub">' + pc(s.lo) + '–' + pc(s.hi) + '</span>'; } },
      { key: 'pending', label: 'Still running', type: 'num', digits: 0, title: 'Fewer sessions than the window since the entry (counted once it is over)' },
      { key: 'early', label: word + ', still running', type: 'num', digits: 0, title: 'Still running, the level already reached' },
      { key: 'medDays', label: 'Median sessions', type: 'num', digits: 0 },
      dir === 'down' ? { key: 'avgHh', label: 'Avg highest high', type: 'pct', digits: 1, title: 'The highest high within the window vs the entry' }
        : { key: 'avgOut', label: 'Avg result', type: 'pct', digits: 1, title: 'Sold at the level the day it was reached, else at the close of the last session of the window' },
      { key: 'avgRet', label: 'Avg move', type: 'pct', digits: 1, title: 'Close of the last session of the window vs the entry (finished results)' },
      { key: 'avgIx', label: 'NIFTY 50', type: 'pct', digits: 1, title: 'NIFTY 50 over the same sessions' }
    ];
  }
  function windowsHtml() {
    return '<section class="card" id="et-win"><div class="card-head"><div><h2>Every window</h2>' +
      '<p>The long targets of this quarter, 30 to 180 sessions after the entry and until the next quarter\'s results. Each window counts only the results whose window is over - so a longer window has fewer of them until time passes.</p></div></div>' +
      '<div id="et-win-t"></div></section>';
  }
  function drawWindows(el, rows) {
    var host = $('#et-win-t', el);
    if (!host) return;
    new ui.Table({ rows: T.byWindow(rows, ST.opt.T), pageSize: 10, id: 'epst-windows', tools: false, columns: windowCols('up') }).mount(host);
  }

  function groupsHtml() {
    return '<section class="card" id="et-groups"><div class="card-head"><div><h2>Which long targets were reached</h2>' +
      '<p>The hit rate of each group (in the window chosen above) - a group needs a few finished results before it means much.</p></div></div>' +
      '<nav class="chips" aria-label="Group by">' + GROUPS.map(function (g) {
        return '<button type="button" class="chip" data-epg="' + g[0] + '" aria-pressed="' + (ST.group === g[0]) + '">' + esc(g[1]) + '</button>';
      }).join('') + '</nav><div id="et-groups-b"></div><div id="et-groups-t"></div></section>';
  }
  function groupRows(rows) {
    var W = ST.opt.W, Tt = ST.opt.T;
    if (ST.group === 'growth') return T.bucket(rows, W, Tt, function (r) { return r.g; }, T.GROWTH);
    if (ST.group === 'upside') return T.bucket(rows, W, Tt, function (r) { return r.up; }, T.UPSIDE);
    if (ST.group === 'pe') return T.bucket(rows, W, Tt, function (r) { return r.pe; }, T.PE, '');
    if (ST.group === 'session') return T.groupBy(rows, W, Tt, function (r) { return r.session; }, 1);
    return T.groupBy(rows, W, Tt, function (r) { return r.sector; }, 5);
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
      { key: 'pending', label: 'Still running', type: 'num', digits: 0 },
      { key: 'medUp', label: 'Median upside', type: 'pct', digits: 0 },
      { key: 'medDays', label: 'Median sessions', type: 'num', digits: 0 },
      { key: 'avgOut', label: 'Avg result', type: 'pct', digits: 1 }
    ] }).mount(host);
  }

  function downHtml(rows) {
    var W = ST.opt.W, Tt = ST.opt.T, D = T.stats(rows, W, Tt, 'down');
    return '<section class="card" id="et-down"><div class="card-head"><div><h2>Downside targets (target below the entry price)</h2>' +
      '<p>The formula\'s price was <b>under</b> the price you could buy at - the stock already traded above its EPS-growth value. Kept apart from the long targets. ' +
      'Did the price <b>fall</b> to it (a daily <b>low</b> covering ' + esc(ruleWords(Tt)) + ' down) within the window?</p></div></div>' +
      '<div class="tiles">' +
      tile('Downside targets', F.int(D.n), D.n ? 'median target ' + sgn(D.medUp, 0) + ' from the entry' : '') +
      tile('Fell to it ' + winName(W), D.rate == null ? '–' : pc(D.rate), D.done ? F.int(D.hit) + ' of ' + F.int(D.done) + ' finished · likely ' + pc(D.lo) + '–' + pc(D.hi)
        : 'none finished yet') +
      tile('Still running', F.int(D.pending), D.early ? F.int(D.early) + ' fell to it already' : '') +
      tile('Their move ' + endWords(W), D.avgRet == null ? '–' : sgn(D.avgRet), D.avgIx == null ? '' : 'NIFTY 50 ' + sgn(D.avgIx), D.avgRet > 0 ? 'up' : D.avgRet < 0 ? 'down' : '') +
      '</div><div id="et-down-t"></div><p class="sub">They are in <b>Every result</b> below under the chip <b>Downside target</b>.</p></section>';
  }
  function drawDown(el, rows) {
    var host = $('#et-down-t', el);
    if (!host) return;
    new ui.Table({ rows: T.byWindow(rows, ST.opt.T, 'down'), pageSize: 10, id: 'epst-down-windows', tools: false, columns: windowCols('down') }).mount(host);
  }

  function quartersHtml() {
    return '<section class="card" id="et-qs"><div class="card-head"><div><h2>Every quarter</h2><p>The same window and rule for each quarter your laptop worked out ' +
      '(long targets). Tap a quarter to open it.</p></div></div><p class="sub" id="et-qs-note"></p><div id="et-qs-t"></div></section>';
  }
  /** byQ = every quarter's rows once the thesis list has read them (then the target filter applies here too); before that the
   *  laptop's own summary of each quarter */
  function drawQuarters(el, res, byQ) {
    var host = $('#et-qs-t', el);
    if (!host) return;
    var W = ST.opt.W, Tt = ST.opt.T;
    var rows = (res.quarters || []).map(function (x) {
      var got = byQ && byQ[x.q];
      if (got) {
        var S = T.stats(got, W, Tt), D = T.stats(got, W, Tt, 'down');
        return { q: x.q, target: S.n, down: D.n, done: S.done, hit: S.hit, pending: S.pending, rate: S.rate, drate: D.rate, ddone: D.done, medUp: S.medUp,
          medG: T.median(got.filter(function (r) { return r.dir === 'up' && !r.out; }).map(function (r) { return r.g; })) };
      }
      var s = T.sumRate(x.sum, W, Tt) || {}, d = T.sumRate(x.sum, W, Tt, 'down') || {};
      return { q: x.q, target: x.sum.target, down: x.sum.down, done: s.done, hit: s.hit, pending: s.pending, rate: s.rate, drate: d.rate, ddone: d.done,
        medUp: x.sum.medUp, medG: x.sum.medG };
    });
    var note = $('#et-qs-note', el);
    if (note) note.textContent = byQ ? '' : filterOn() ? 'Reading every quarter - your target filter applies here once they are read.' : '';
    host.innerHTML = '';
    new ui.Table({ rows: rows, pageSize: 20, id: 'epst-quarters', tools: false, columns: [
      { key: 'q', label: 'Quarter', html: function (r) { return '<button type="button" class="linkish" data-epq="' + esc(r.q) + '">' + qWords(r.q) + '</button>'; } },
      { key: 'target', label: 'Long targets', type: 'num', digits: 0 },
      { key: 'done', label: 'Finished (' + winShort(W).toLowerCase() + ')', type: 'num', digits: 0 },
      { key: 'rate', label: 'Hit rate', type: 'num', get: function (r) { return r.rate == null ? null : r.rate * 100; },
        html: function (r) { return r.done ? '<b>' + pc(r.rate) + '</b> <span class="sub">' + F.int(r.hit) + ' of ' + F.int(r.done) + '</span>' : '–'; } },
      { key: 'pending', label: 'Still running', type: 'num', digits: 0 },
      { key: 'down', label: 'Downside targets', type: 'num', digits: 0 },
      { key: 'drate', label: 'Fell to it', type: 'num', get: function (r) { return r.drate == null ? null : r.drate * 100; },
        html: function (r) { return r.ddone ? pc(r.drate) + ' <span class="sub">of ' + F.int(r.ddone) + '</span>' : '–'; } },
      { key: 'medG', label: 'Median growth', type: 'pct', digits: 0 },
      { key: 'medUp', label: 'Median upside', type: 'pct', digits: 0 }
    ] }).mount(host);
  }

  function allHtml(rows) {
    var W = ST.opt.W, Tt = ST.opt.T, n = { all: rows.length };
    Object.keys(T.STATUS).forEach(function (k) { n[k] = 0; });
    rows.forEach(function (r) { n[T.kind(r, W, Tt)]++; });
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
    var W = ST.opt.W, Tt = ST.opt.T;
    var t = new ui.Table({ rows: [], pageSize: 50, id: 'epst-all-v2', empty: 'No result with this status', columns: [
      { key: 'sym', label: 'Stock', type: 'sym', name: 'name' },
      { key: 'status', label: W === NX ? 'Before the next results' : 'In ' + W + ' sessions', get: function (r) { return statusText(r, W, Tt); },
        html: function (r) { return statusBadge(r, W, Tt); } },
      { key: 'ann', label: 'Results out', title: 'When NSE got the results (IST): its result filing, else the time in the XBRL file\'s name',
        html: function (r) { return r.ann ? esc(F.date(r.ann.slice(0, 10))) + ' <span class="sub">' + esc(r.ann.slice(11)) + (r.src === 'xbrl' ? ' (XBRL)' : '') + '</span>' : '<span class="sub">–</span>'; } },
      { key: 'ed', label: 'Entry', type: 'date', title: 'The first session that could react: the results day itself before 15:30, else the next session' },
      { key: 'ep', label: 'Entry price', type: 'price', title: 'That session\'s close' },
      { key: 'ttm', label: 'TTM EPS', type: 'num', digits: 2 },
      { key: 'prev', label: 'EPS 4Q before', type: 'num', digits: 2 },
      { key: 'g', label: 'EPS growth', type: 'pct', digits: 1 },
      { key: 'tgt', label: 'Target', type: 'price' },
      { key: 'up', label: 'Target vs entry', type: 'pct', digits: 0, title: 'Above the entry = a long target; under it = a downside target' },
      { key: 'lvl', label: Tt === 100 ? 'Target level' : Tt + '% level', type: 'price', get: function (r) { return T.level(r, Tt); },
        title: 'The price ' + ruleWords(Tt) + ' - reaching it counts' },
      { key: 'pe', label: 'PE at entry', type: 'num', digits: 1 },
      { key: 'reach', label: 'Reached in', title: 'Sessions after the entry until the price covered ' + ruleWords(Tt),
        get: function (r) { return T.reachK(r, Tt); }, html: function (r) { var x = T.reachK(r, Tt); return x != null ? F.int(x) + ' <span class="sub">' + esc(F.date(T.reachD(r, Tt))) + '</span>' : '<span class="sub">–</span>'; } },
      { key: 'pg', label: 'Best progress', type: 'num', title: 'How much of the way to the target the price covered within the window (so far, while it runs)',
        get: function (r) { return T.wv(r, 'pg', W); }, html: function (r) { var v = T.wv(r, 'pg', W); return v == null ? '–' : Math.round(v) + '% of the way'; } },
      { key: 'hh', label: 'Highest', type: 'pct', digits: 1, title: 'The highest high within the window vs the entry', get: function (r) { return T.wv(r, 'hh', W); } },
      { key: 'dd', label: 'Lowest', type: 'pct', digits: 1, title: 'The lowest low within the window vs the entry', get: function (r) { return T.wv(r, 'dd', W); } },
      { key: 'cl', label: W === NX ? 'At the next results' : 'After ' + W, type: 'pct', digits: 1,
        title: W === NX ? 'The close of the last session before the next results vs the entry' : 'The close of the ' + W + 'th session vs the entry',
        get: function (r) { return T.wv(r, 'cl', W); } },
      { key: 'ix', label: 'NIFTY 50', type: 'pct', digits: 1, title: 'NIFTY 50 over the same sessions', get: function (r) { return T.wv(r, 'ix', W); } },
      { key: 'nx', label: 'Next results', title: 'When the next quarter\'s results came out and how many sessions after the entry were before them (≈ = no date found: SEBI\'s last day)',
        get: function (r) { return r.nq; }, html: function (r) {
          if (r.st !== 'ok') return '<span class="sub">–</span>';
          if (r.nq == null) return '<span class="sub">not out yet</span>';
          return (r.nx ? esc(F.date(r.nx.slice(0, 10))) : '≈ SEBI\'s last day') + ' <span class="sub">' + F.int(r.nq) + ' sessions</span>';
        } },
      { key: 'now', label: 'Now vs entry', type: 'pct', digits: 1, title: 'The last daily close the laptop had vs the entry' },
      { key: 'toTgt', label: 'Price → target', type: 'pct', digits: 1, title: 'How far the price shown on this site is from the target' },
      { key: 'n', label: 'Sessions so far', type: 'num', digits: 0 },
      { key: 'why', label: 'No target because', get: function (r) { return r.st === 'ok' ? '' : T.WHY[r.why] || ''; } },
      { key: 'b', label: 'Basis', title: 'C = consolidated, S = standalone EPS' },
      { key: 'go', label: 'Details', get: function () { return ''; }, html: function (r) { return '<button type="button" class="btn sm" data-epone="' + esc(r.sym) + '">Details</button>'; } }
    ], hide: ['pe', 'lvl', 'hh', 'ix', 'b', 'why', 'nx'] }).mount(host);
    function apply() {
      var w = ST.one.trim();
      var list = rows.filter(function (r) { return (ST.list === 'all' || T.kind(r, W, Tt) === ST.list) && (!w || ui.textMatch(w, [r.sym, r.name])); });
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
    $('#et-csv', el).addEventListener('click', function () { ui.download('eps-target-' + String(res.q).replace(' ', '-') + '-' + W + '-' + Tt + '.csv', ui.toCsv(t.toCsvRows())); });
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
      box.innerHTML = some.length ? '' : '<p class="empty">No ' + esc(res.q) + ' result for "' + esc(ST.one) + '" - it needs 8 quarters of EPS.</p>';
      if (some.length !== 1) return;
      r = some[0];
    }
    var W = ST.opt.W, Tt = ST.opt.T, f = T.formula(r), labs = T.quarters(res.q);
    var marks = String(r.fl || '');
    var epsT = '<table class="et-eps"><thead><tr>' + labs.map(function (l, i) { return '<th' + (i >= 4 ? ' class="ttm"' : '') + '>' + esc(l) + '</th>'; }).join('') +
      '</tr></thead><tbody><tr>' + r.eps.map(function (v, i) {
        var m = marks.charAt(i), tip = T.FLAG[m] || '';
        return '<td' + (i >= 4 ? ' class="ttm"' : '') + (tip ? ' data-tip="' + esc('EPS from ' + tip) + '"' : '') + '>' + (v == null ? '–' : v.toFixed(2)) +
          (tip && m !== 'p' ? '<sup>' + esc(m) + '</sup>' : '') + '</td>';
      }).join('') + '</tr></tbody></table>';
    var timeTxt = r.ann ? esc(F.date(r.ann.slice(0, 10))) + ' ' + esc(r.ann.slice(11)) + ' <span class="sub">(' + (r.src === 'xbrl' ? 'the time in NSE\'s XBRL file' : 'NSE\'s result filing') + ' · ' + esc(r.session) + ')</span>' : '–';
    var h = '<div class="et-one"><h3>' + esc(r.sym) + ' <span class="sub">' + esc(r.name || '') + '</span> ' + statusBadge(r, W, Tt) + '</h3>' +
      '<div class="et-formula">' + epsT +
      '<p><b>TTM EPS</b> (' + esc(labs[4]) + ' – ' + esc(labs[7]) + ') = ' + esc(f.ttm) + '<br><b>The 4 quarters before</b> = ' + esc(f.prev) +
      '<br><b>EPS growth</b> = ' + esc(f.growth) + '<br><b>Target</b> = ' + esc(f.target) + (r.why && r.st !== 'ok' ? ' <span class="sub">- ' + esc(T.WHY[r.why] || '') + '</span>' : '') + '</p></div>' +
      '<p>Results out: ' + timeTxt + (r.ed ? ' → entry <b>' + esc(F.date(r.ed)) + '</b> at <b>' + F.price(r.ep) + '</b> <span class="sub">(the close; that day opened ' + F.price(r.o0) +
        ', the close before ' + F.price(r.pre) + ')</span>' : '') +
      (r.up != null ? ' → target ' + F.price(r.tgt) + ' = <b>' + sgn(r.up, 0) + '</b> from the entry' + (r.dir === 'down' ? ' - a <b>downside</b> target' : '') : '') + '.</p>';
    if (r.st === 'ok') {
      var lvl = T.level(r, Tt), kk = T.reachK(r, Tt), way = r.dir === 'down' ? 'down' : 'up', pgW = T.wv(r, 'pg', W);
      var len = W === NX ? (r.nq != null ? r.nq : r.n) : Math.min(W, r.n);
      var all = T.THRESH.map(function (x) {
        var kx = T.reachK(r, x);
        return kx == null ? null : (x === 100 ? 'the target itself' : x + '%') + ' after ' + F.int(kx) + ' sessions (' + esc(F.date(T.reachD(r, x))) + ')';
      }).filter(Boolean);
      var moved = Tt === 100 ? 'The price reached the target' : 'The price ' + (way === 'down' ? 'fell' : 'rose') + ' ' + Tt + '% of the way to the target (' + F.price(lvl) + ')';
      h += '<p>' + (kk != null
        ? moved + ' after <b>' + F.int(kk) + ' sessions</b>, on ' + esc(F.date(T.reachD(r, Tt))) +
          (W === NX ? (r.nq != null && kk > r.nq ? ' (after the next results)' : '') : kk > W ? ' (after your ' + W + '-session window)' : '') + '.' +
          (all.length > 1 ? ' <span class="sub">Reached ' + all.join(' · ') + '.</span>' : '')
        : 'Not reached yet (' + esc(ruleWords(Tt)) + ') in ' + F.int(r.n) + ' session' + (r.n === 1 ? '' : 's') +
          (pgW != null ? ' - within ' + F.int(len) + ' sessions' + (W === NX ? (r.nq != null ? ' (until the next results)' : ' (the next results not out yet)') : '') +
            ' the price covered ' + Math.round(pgW) + '% of the way' : '') + '.') +
        (r.now != null ? ' The last close the laptop had: ' + sgn(r.now) + ' from the entry' + (r.price ? ', the price on this site ' + F.price(r.price) + ' (' + sgn(r.toTgt) + ' to the target)' : '') + '.' : '') + '</p>' +
        '<p>' + nextLine(r, Tt) + '</p>' +
        '<div class="et-chart">' + chartSvg(r, W, Tt) + '</div>';
    }
    h += '<div class="actions"><a class="btn sm" target="_blank" rel="noopener" href="https://www.tradingview.com/chart/?symbol=' + encodeURIComponent('NSE:' + r.sym) + '">Open on TradingView</a>' +
      '<button type="button" class="btn sm" data-sym="' + esc(r.sym) + '">Stock window</button></div></div>';
    box.innerHTML = h;
  }

  /** the next quarter's results of one result, in words */
  function nextLine(r, Tt) {
    var kk = T.reachK(r, Tt);
    if (r.nq == null) return 'The next quarter\'s results are not out yet' + (kk != null ? ' - the level was reached already' : '') + '.';
    var when = r.nx ? 'The next quarter\'s results came out on <b>' + esc(F.date(r.nx.slice(0, 10))) + '</b> ' + esc(r.nx.slice(11)) :
      'No date was found for the next quarter\'s results - the window ends on the last day SEBI allows for them';
    return when + ': <b>' + F.int(r.nq) + ' sessions</b> after the entry were before them - ' + esc(ruleWords(Tt)) + ' ' +
      (kk != null && kk <= r.nq ? '<b>reached before them</b>' : '<b>not reached before them</b>') + '.';
  }

  /** the price after the entry: closes (line) and highs (faint) every 5 sessions as % from the entry; the target, the rule's
   *  level, the entry, the window and the day the level was reached */
  function chartSvg(r, W, Tt) {
    var pcs = r.pc || [], phs = r.ph || [];
    if (!pcs.length) return '<p class="sub">No session after the entry yet.</p>';
    var Wd = 640, Hd = 220, P = { l: 46, r: 92, t: 12, b: 26 };
    var xs = [0].concat(pcs.map(function (_, j) { return Math.min((j + 1) * 5, r.n); }));
    var wl = W === NX ? r.nq : W;
    var xmax = Math.max(xs[xs.length - 1], wl == null ? 0 : Math.min(wl, 200));
    var lv = r.up == null ? null : r.up * Tt / 100;
    var ys = [0, r.up || 0].concat(pcs, phs, [r.dd[T.WINDOWS.length - 1] || 0]).filter(function (v) { return v != null && isFinite(v); });
    var lo = Math.min.apply(null, ys), hi = Math.max.apply(null, ys);
    var pad = (hi - lo || 10) * 0.08;
    lo -= pad; hi += pad;
    var X = function (s) { return P.l + (Wd - P.l - P.r) * s / xmax; };
    var Y = function (v) { return P.t + (Hd - P.t - P.b) * (hi - v) / (hi - lo); };
    var line = function (vals) { return [[0, 0]].concat(vals.map(function (v, j) { return [xs[j + 1], v]; })).filter(function (p) { return p[1] != null; })
      .map(function (p) { return X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1); }).join(' '); };
    var h = '<svg viewBox="0 0 ' + Wd + ' ' + Hd + '" role="img" aria-label="' + esc(r.sym + ': the price after the entry vs the target') + '">';
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
      if (Tt < 100) {
        h += '<line class="et-lvl" x1="' + P.l + '" x2="' + (Wd - P.r) + '" y1="' + Y(lv).toFixed(1) + '" y2="' + Y(lv).toFixed(1) + '"/>' +
          '<text class="et-lab" x="' + (Wd - P.r + 4) + '" y="' + (Y(lv) + (r.up > 0 ? 13 : -5)).toFixed(1) + '">' + Tt + '% ' + esc(F.price(T.level(r, Tt))) + '</text>';
      }
    }
    if (wl != null && wl > 0 && wl <= xmax) {
      h += '<line class="et-win" x1="' + X(wl).toFixed(1) + '" x2="' + X(wl).toFixed(1) + '" y1="' + P.t + '" y2="' + (Hd - P.b) + '"/>' +
        '<text class="et-ax" x="' + (X(wl) - 4).toFixed(1) + '" y="' + (Hd - P.b - 5) + '" text-anchor="end">' + (W === NX ? 'next results' : W + '-session window') + '</text>';
    }
    h += '<polyline class="et-hi" points="' + line(r.dir === 'down' ? pcs : phs) + '"/><polyline class="et-cl" points="' + line(pcs) + '"/>';
    var kk = T.reachK(r, Tt);
    if (kk != null && kk <= xmax && lv != null) {
      h += '<circle class="et-hit" cx="' + X(kk).toFixed(1) + '" cy="' + Y(lv).toFixed(1) + '" r="5"/><text class="et-lab et-tl" x="' + X(kk).toFixed(1) + '" y="' +
        (Y(lv) + (r.dir === 'down' ? 16 : -9)).toFixed(1) + '" text-anchor="middle">reached · day ' + kk + '</text>';
    }
    h += '<text class="et-ax" x="' + P.l + '" y="' + (Hd - 6) + '">entry ' + esc(F.date(r.ed)) + '</text><text class="et-ax" x="' + (Wd - P.r) + '" y="' + (Hd - 6) +
      '" text-anchor="end">' + xmax + ' sessions</text></svg>';
    return h + '<p class="sub">Line = the close' + (r.dir === 'down' ? '' : ', faint line = the highest high of each 5 sessions') + ', both from the entry price; dashed = the target' +
      (Tt < 100 ? ' and your ' + Tt + '% level' : '') + '.</p>';
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
          ' - the live copy could not be read just now.</div>' : '') + pickHtml(res) + summaryHtml(res, rows) + thesisHtml() + windowsHtml() + groupsHtml() +
          downHtml(rows) + quartersHtml() + allHtml(rows);
        drawWindows(body, rows);
        drawGroups(body, rows);
        drawDown(body, rows);
        drawQuarters(body, res);
        drawAll(body, rows, res);
        drawThesis(body, ctx, res, rows);
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
          ST.opt.W = T.win(e.target.value) || 60;
          save();
          SB.route(true);
        });
        ['lo', 'hi'].forEach(function (k) {
          $('#et-' + k, body).addEventListener('change', function (e) {
            ST.opt[k] = e.target.value === '' ? null : Number(e.target.value);
            save();
            SB.route(true);
          });
        });
        $('#et-t', body).addEventListener('change', function (e) {
          ST.opt.T = Number(e.target.value);
          save();
          SB.route(true);
        });
      });
    }
  });
})();
