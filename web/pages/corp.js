/* Corporate Intelligence (#corp, #corp/<SYMBOL>) - owner, 28-Nov-2026: a "Today's Corporate Intelligence" page - NSE's
   corporate announcements of his stocks in 6 categories (A Business Growth & Opportunities, B Financial & Capital,
   C Management & Governance, D Operational, E Risk & Negative, F Investor Communication & Market), a priority, the numbers
   of each filing (order value, execution period, rating, dividend, pledge, deal value, fundraising amount, monthly sales ...),
   the order / revenue ratio and three scores (Business Impact, Governance / Risk, Information Surprise); tiles, the filters
   All / High-impact / Order wins / Management changes / Fundraising / Financial results / Investor calls / Risk alerts /
   Corporate actions and a company search; "start from Past 1week announcement". Sorted and scored by fixed rules on the
   laptop ("No AI involvment here" - pcbridge/ScreenerBridge/corp_ann.py), the sheet keeps 30 days ("30 days sheet
   vachurukalam"); older days and a company's every filing come from the laptop's archive while it is on ("laptop on la
   iruntha all announment um website kaatanum") - api/corp?older=..., asked again every few seconds until it answers.
   Website only - no emails / pop-ups (his choice). */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, esc = ui.esc, F = ui.F, $ = ui.$, C = SB.corp;
  var OPT_KEY = 'sb:corp:opts';
  var RANGES = [['today', 'Today'], ['3', 'Last 3 days'], ['7', 'Last 7 days'], ['30', 'Last 30 days']];
  var ASK_EVERY_MS = 4000, ASK_TRIES = 25;
  var ST = { opt: load(), cat: '', q: '', one: '', older: null, asking: null };
  var MEM = null;            // {days, byDay {day: rows}, laptop, fetchedAt, today}

  function load() {
    var o = null;
    try { o = JSON.parse(localStorage.getItem(OPT_KEY) || 'null'); } catch (e) { o = null; }
    o = o && typeof o === 'object' ? o : {};
    var okR = RANGES.some(function (r) { return r[0] === o.range; }) || /^\d{4}-\d{2}-\d{2}$/.test(String(o.range || ''));
    return { range: okR ? o.range : 'today', filter: C.FILTERS.some(function (f) { return f[0] === o.filter; }) ? o.filter : 'all' };
  }
  function save() { try { localStorage.setItem(OPT_KEY, JSON.stringify(ST.opt)); } catch (e) { /* private window */ } }
  function tile(label, value, note, tone, tip, key) {
    return '<button type="button" class="tile ci-tile"' + (key ? ' data-cif="' + key + '"' : '') + (tip ? ' data-tip="' + esc(tip) + '"' : '') +
      '><div class="label">' + esc(label) + '</div><div class="value' + (tone ? ' ' + tone : '') + '">' + value + '</div>' +
      (note ? '<div class="note2">' + note + '</div>' : '') + '</button>';
  }
  function ago(sec) {
    if (sec == null || sec < 0) return null;
    return sec < 90 ? 'a minute ago' : sec < 5400 ? Math.round(sec / 60) + ' minutes ago' : sec < 172800 ? Math.round(sec / 3600) + ' hours ago'
      : Math.round(sec / 86400) + ' days ago';
  }
  function laptopWords(sec) {
    if (sec == null || sec < 0) return 'your laptop has not asked for the website\'s questions yet (its program gets this with the next update)';
    return sec <= 600 ? 'your laptop is on (it looked ' + ago(sec) + ')' : 'your laptop looks off - it last looked ' + ago(sec);
  }
  function catBadge(r) { return '<span class="badge ci-cat ' + (C.CAT_TONE[r.cat] || '') + '" data-tip="' + esc(C.CAT[r.cat] || '') + '">' + esc(r.cat) + '</span>'; }
  function priBadge(r) { var p = C.PRI[r.pr] || ['', '']; return ui.badge(p[0], p[1]); }
  function evName(e) { return (C.EVENTS[e] || [e])[0]; }
  function meter(label, v, kind) {
    return '<span class="ci-sc ci-sc-' + kind + '" data-tip="' + esc(label + ' ' + v + ' of 100') + '"><i style="width:' + Math.max(2, Math.min(100, v)) +
      '%"></i><b>' + esc(label) + '</b> ' + v + '</span>';
  }
  function pdfLink(r) {
    if (!r.pdf) return '<span class="sub">–</span>';
    var tip = r.pg === 'r' ? 'Your laptop read this PDF - its lines and numbers are shown and scored' : r.pg === 'x'
      ? 'A scanned PDF (a picture of the pages) - no text to read' : 'Not read by your laptop yet - it reads every filing\'s PDF, a few a minute';
    return '<a href="' + esc(r.pdf) + '" target="_blank" rel="noopener" data-tip="' + esc(tip) + '">PDF ↗</a>' +
      (r.pg === 'r' ? ' <span class="badge s-good ci-pg">read</span>' : r.pg === 'x' ? ' <span class="badge ci-pg">scanned</span>'
        : ' <span class="badge s-info ci-pg">not yet</span>');
  }
  /** the PDF's own lines the laptop picked (its subject, the sentences with an amount / a % / the event's words) */
  function psHtml(r, n) {
    if (!r.ps.length) return '';
    var shown = r.ps.slice(0, n || 5);
    return '<ul class="ci-ps">' + shown.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
      (r.ps.length > shown.length ? '<span class="sub">+ ' + (r.ps.length - shown.length) + ' more line' + (r.ps.length - shown.length === 1 ? '' : 's') + '</span>' : '');
  }
  function pdfNote(rows) {
    var c = C.counts(rows);
    if (!c.pdfs) return rows.length ? '<p class="sub ci-pdfnote">NSE gave no PDF with these filings.</p>' : '';
    var left = c.pdfs - c.read - c.scanned;
    return '<p class="sub ci-pdfnote" id="ci-pdfnote"><b>PDFs read by your laptop: ' + F.int(c.read) + ' of ' + F.int(c.pdfs) + '</b>' +
      (c.scanned ? ' · ' + F.int(c.scanned) + ' scanned (no text)' : '') + (left > 0 ? ' · ' + F.int(left) + ' still to read - your laptop reads about 10 a minute ' +
      'while it is on; their lines and numbers appear here then' : '') + '.</p>';
  }
  function dayWords(d) { return F.date ? F.date(d) : d; }

  // ---------- data ----------
  function api(path) {
    return SB.api(path, 40000).then(function (r) {
      if (!r || !r.ok) throw new Error((r && r.message) || 'the sheet did not answer');
      return r;
    });
  }
  function take(r) {
    var rows = C.objects(r);
    MEM.days = r.days || MEM.days;
    MEM.laptop = r.laptop;
    MEM.fetchedAt = r.fetchedAt || MEM.fetchedAt;
    (r.shown || []).forEach(function (d) { MEM.byDay[d] = []; });
    rows.forEach(function (x) { (MEM.byDay[x.day] = MEM.byDay[x.day] || []).push(x); });
  }
  /** the newest 7 kept days (one read a visit; a failed read -> the copy this device kept) */
  function first(ctx) {
    if (MEM) return Promise.resolve(MEM);
    if (ctx.site.apiBase == null) return Promise.reject(new Error('local'));
    MEM = { days: [], byDay: {}, laptop: -1, fetchedAt: '', today: '' };
    return api('api/corp?days=7').then(function (r) {
      take(r);
      MEM.today = String(r.fetchedAt || '').slice(0, 10) || (MEM.days[0] && MEM.days[0].day) || '';
      if (SB.keep && r.rows && r.rows.length) SB.keep.put('corp', { ok: true, readAt: r.fetchedAt || '', data: r });
      return MEM;
    }).catch(function (e) {
      return (SB.keep ? SB.keep.get('corp') : Promise.resolve(null)).then(function (k) {
        if (!k) { MEM = null; throw e; }
        take(k.data);
        MEM.today = String(k.data.fetchedAt || '').slice(0, 10);
        MEM.kept = k.readAt || true;
        return MEM;
      });
    });
  }
  /** the kept days of the range not read yet (10 days a read) */
  function fill(days) {
    var want = days.filter(function (d) { return !MEM.byDay[d] && MEM.days.some(function (x) { return x.day === d; }); }).sort();
    if (!want.length) return Promise.resolve();
    var jobs = [];
    for (var i = 0; i < want.length; i += 10) jobs.push(want.slice(i, i + 10));
    return jobs.reduce(function (p, w) {
      return p.then(function () { return api('api/corp?from=' + w[0] + '&to=' + w[w.length - 1]).then(take); });
    }, Promise.resolve());
  }
  function rangeDays() {
    var r = ST.opt.range, today = MEM.today || (MEM.days[0] && MEM.days[0].day);
    if (/^\d{4}-\d{2}-\d{2}$/.test(r)) return [r];
    return C.rangeDays(today, r === 'today' ? 1 : Number(r));
  }
  function keptDay(d) { return MEM.days.some(function (x) { return x.day === d; }); }
  function oldestKept() { return MEM.days.length ? MEM.days[MEM.days.length - 1].day : ''; }

  /** asks the laptop (through the sheet) and asks again every few seconds until the answer is there */
  function askLaptop(key, body, done) {
    var n = 0, me = {};
    ST.asking = me;
    function say(t) { var b = $('#ci-older', body); if (b) b.innerHTML = t; }
    function go() {
      if (ST.asking !== me || !body.isConnected) return;
      n++;
      api('api/corp?older=' + encodeURIComponent(key)).then(function (r) {
        if (ST.asking !== me) return;
        if (r.pending) {
          if (n >= ASK_TRIES) {
            ST.asking = null;
            say('<p class="note warn">Your laptop did not answer (' + esc(laptopWords(r.laptop)) + '). The sheet keeps only the last 30 days - turn the laptop on ' +
              'and try again in a minute.</p>');
            return;
          }
          say('<p class="note" aria-busy="true">Asking your laptop for ' + esc(keyWords(key)) + '… (' + esc(laptopWords(r.laptop)) + ')</p>');
          setTimeout(go, ASK_EVERY_MS);
          return;
        }
        ST.asking = null;
        done({ key: key, rows: C.objects(r), from: r.older && r.older.from, at: r.older && r.older.at });
      }).catch(function (e) {
        if (ST.asking !== me) return;
        ST.asking = null;
        say('<p class="note warn">Could not ask your laptop: ' + esc(e && e.message || 'failed') + '.</p>');
      });
    }
    go();
  }
  function keyWords(key) {
    var m = /^(day|sym):(.+)$/.exec(key);
    return m ? (m[1] === 'day' ? 'the announcements of ' + dayWords(m[2]) : 'every announcement of ' + m[2]) : key;
  }

  // ---------- the page ----------
  function headHtml() {
    var made = MEM.days.length ? MEM.days[0].made : '';
    return (MEM.kept ? '<div class="note">Showing the copy this device kept' + (MEM.kept !== true ? ' (' + esc(F.dateTime(MEM.kept)) + ')' : '') +
      ' - the live copy could not be read just now.</div>' : '') +
      '<p class="sub ci-status">' + (made ? 'Sent by your laptop at ' + esc(made) + ' · ' : '') + 'the sheet keeps the last 30 days' +
      (MEM.days.length ? ' (' + esc(dayWords(oldestKept())) + ' to ' + esc(dayWords(MEM.days[0].day)) + ')' : '') + ' · ' + esc(laptopWords(MEM.laptop)) +
      ' - older days and a company\'s whole history come from it while it is on.</p>';
  }
  function rangeHtml() {
    var r = ST.opt.range, picked = /^\d{4}-\d{2}-\d{2}$/.test(r) ? r : '';
    return '<div class="controls ci-range"><nav class="chips" aria-label="Days">' + RANGES.map(function (x) {
      return '<button type="button" class="chip" data-cir="' + x[0] + '" aria-pressed="' + (r === x[0] && !ST.older) + '">' + esc(x[1]) + '</button>';
    }).join('') + '</nav><label class="sub" for="ci-day">One day</label><input class="sel" type="date" id="ci-day" value="' + esc(picked) + '" max="' +
      esc(MEM.today || '') + '" aria-label="One day (older than 30 days: from your laptop)"></div>';
  }
  function tilesHtml(rows) {
    var c = C.counts(rows);
    var when = ST.older ? 'from your laptop' : ST.opt.range === 'today' ? 'today' : /^\d/.test(ST.opt.range) && ST.opt.range.length > 3 ? dayWords(ST.opt.range)
      : 'in ' + (RANGES.filter(function (x) { return x[0] === ST.opt.range; })[0] || ['', 'these days'])[1].toLowerCase();
    return '<div class="tiles ci-tiles">' +
      tile('Filings ' + when, F.int(c.filters.all), F.int(c.stocks) + ' of your stocks', '', 'Every NSE announcement of your Main stocks', 'all') +
      tile('High-impact events', F.int(c.filters.high), 'business impact or risk 60+', 'up', 'Priority High: a Business Impact or Governance / Risk score of 60 or more', 'high') +
      tile('Risk alerts', F.int(c.filters.risk), 'category E or risk 50+', c.filters.risk ? 'down' : '', 'Risk & Negative filings, or a Governance / Risk score of 50 or more', 'risk') +
      tile('Order wins', F.int(c.filters.orders), '', '', 'Orders, contracts, letters of award, L1 bids', 'orders') +
      tile('Fundraising', F.int(c.filters.fund), '', '', 'QIP, preferential issue, rights issue, NCDs, warrants ...', 'fund') + '</div>';
  }
  function filtersHtml(rows) {
    var c = C.counts(rows);
    return '<nav class="chips ci-filters" aria-label="Filter">' + C.FILTERS.map(function (f) {
      return '<button type="button" class="chip" data-cif="' + f[0] + '" aria-pressed="' + (ST.opt.filter === f[0]) + '">' + esc(f[1]) + ' <b>' +
        F.int(c.filters[f[0]] || 0) + '</b></button>';
    }).join('') + '</nav><nav class="chips ci-cats" aria-label="Category"><button type="button" class="chip" data-cic="" aria-pressed="' + (!ST.cat) +
      '">Every category</button>' + C.CATS.map(function (k) {
      return '<button type="button" class="chip" data-cic="' + k[0] + '" aria-pressed="' + (ST.cat === k[0]) + '"><b>' + k[0] + '</b> ' + esc(k[1]) + ' <b>' +
        F.int(c.cats[k[0]] || 0) + '</b></button>';
    }).join('') + '</nav>';
  }
  function cardHtml(r) {
    var nums = C.numWords(r);
    return '<article class="ci-card ci-c-' + esc(r.cat) + '"><div class="ci-card-h">' + ui.stockCell(r.sym, r.name || r.co) + '<span class="sub">' +
      esc(dayWords(r.day)) + ' ' + esc(r.time) + '</span></div><div class="ci-card-b">' + catBadge(r) + ' <b>' + esc(evName(r.ev)) + '</b> ' + priBadge(r) +
      (r.ex.length ? ' <span class="sub">+ ' + esc(r.ex.map(evName).join(', ')) + '</span>' : '') + '</div><div class="ci-meters">' +
      meter('Impact', r.bi, 'bi') + meter('Risk', r.gr, 'gr') + meter('Surprise', r.su, 'su') + '</div>' +
      (nums.length ? '<div class="ci-nums">' + nums.map(function (w) { return '<span>' + esc(w) + '</span>'; }).join('') + '</div>' : '') +
      '<p class="ci-sub"><b>' + esc(r.sub) + '</b>' + (r.tx && r.tx !== r.sub ? ' - ' + esc(r.tx.length > 220 ? r.tx.slice(0, 220) + '…' : r.tx) : '') + '</p>' +
      (r.ps.length ? '<div class="ci-pdf"><span class="ci-pdf-h">From the PDF</span>' + psHtml(r, 4) + '</div>' : '') +
      '<div class="ci-links">' + pdfLink(r) + '</div></article>';
  }
  function topHtml(rows) {
    var t = C.top(rows, 6);
    return '<section class="card" id="ci-top"><div class="card-head"><div><h2>The strongest events</h2><p>High and medium priority, the biggest business ' +
      'impact or risk first.</p></div></div>' + (t.length ? '<div class="ci-cards">' + t.map(cardHtml).join('') + '</div>'
      : '<p class="empty">No high or medium priority filing here.</p>') + '</section>';
  }
  function allHtml() {
    return '<section class="card" id="ci-all"><div class="card-head"><div><h2>Every announcement</h2><p>Newest first. Tap a stock for its window, <b>PDF</b> ' +
      'for the filing on NSE.</p></div><div class="actions"><button class="btn" type="button" id="ci-csv">Export CSV</button></div></div>' +
      '<div class="controls"><input class="search" id="ci-q" type="search" placeholder="Search a company (e.g. RELIANCE)" aria-label="Search a company" value="' +
      esc(ST.q) + '"><span class="count" id="ci-count"></span><button type="button" class="btn sm" id="ci-arch" hidden></button></div>' +
      '<div id="ci-older"></div><div id="ci-all-t"></div></section>';
  }
  function howHtml() {
    return '<details class="card" id="ci-how"><summary><b>How the categories and scores are worked out</b> <span class="sub">- fixed rules, no AI</span></summary>' +
      '<ul class="edge-says"><li><b>The event</b>: NSE\'s own subject of the filing first ("Bagging/Receiving of orders", "Credit Rating" ...), else the words ' +
      'in NSE\'s text and in the PDF ("letter of award", "QIP", "resignation of the CFO" ...). A filing can have other events too (a board outcome with results ' +
      'and a dividend).</li><li><b>Business Impact</b> (0-100): the event\'s base score, raised by its size - an order or deal worth 5 / 10 / 25 / 50 % of the company\'s ' +
      'revenue of the last 4 quarters, a fundraising of 5 / 10 / 20 % of its market cap, a rating upgrade, sales growth; lowered when it is under 1 %.</li>' +
      '<li><b>Governance / Risk</b> (0-100): a CEO / MD / CFO or an auditor leaving, an independent director resigning, a pledge (invoked = 80), a rating downgrade ' +
      '(below BB+ more), a default / fraud / insolvency (85-90), a tax or regulatory demand by its share of revenue.</li>' +
      '<li><b>Information Surprise</b> (0-100): how unexpected it is - routine filings (trading window, newspaper notices, compliance certificates) near 0, ' +
      'an unscheduled order / deal / fundraising high, bigger for bigger sizes.</li><li><b>Priority</b>: High = impact or risk 60+, Medium 35+, Low 15+, else Routine. ' +
      '<b>Risk alert</b> = category E or risk 50+.</li><li>Every filing\'s PDF (all but trading-window / newspaper / meeting-schedule notices) is read by your laptop with pypdf (the first 8 pages). ' +
      '<b>From the PDF</b> = its own subject line and the sentences with an amount, a % or the event\'s words - not the letter\'s greetings, addresses ' +
      'or legal lines. The numbers come from NSE\'s text and the PDF. ' +
      'Amounts in another currency are turned into rupees roughly (USD 88, EUR 95, GBP 112) - only for the size.</li></ul></details>';
  }

  function current() {
    if (ST.older) return ST.older.rows;
    var out = [];
    rangeDays().forEach(function (d) { Array.prototype.push.apply(out, MEM.byDay[d] || []); });
    return out;
  }
  function withNames(rows, ctx) {
    rows.forEach(function (r) { var s = ctx.bySym[r.sym]; r.name = s ? s.name : r.co; });
    return rows;
  }

  function draw(body, ctx) {
    var all = withNames(C.sort(current()), ctx);
    var picked = /^\d{4}-\d{2}-\d{2}$/.test(ST.opt.range) ? ST.opt.range : '';
    var olderNote = ST.older ? '<div class="note">' + esc(keyWords(ST.older.key)) + ' - from your laptop\'s archive' +
      (ST.older.from ? ' (it keeps every NSE announcement since ' + esc(dayWords(ST.older.from)) + ')' : '') +
      '. <button type="button" class="linklike" id="ci-back">Back to the last 30 days</button></div>' : '';
    var none = !all.length ? '<section class="card"><p class="empty">' + (ST.opt.range === 'today' && !ST.older
      ? 'No announcement of your stocks yet today' + (MEM.days.length ? ' - the newest are of ' + esc(dayWords(MEM.days[0].day)) + ' (Last 3 days).' : '.')
      : picked && !keptDay(picked) && !ST.older ? 'Not in the sheet\'s 30 days - asking your laptop…' : 'No announcement here.') + '</p></section>' : '';
    body.innerHTML = headHtml() + rangeHtml() + olderNote + tilesHtml(all) + pdfNote(all) + filtersHtml(all) + none + (all.length ? topHtml(rowsOf(all)) : '') + allHtml() + howHtml();
    bind(body, ctx, all);
  }
  function rowsOf(all) {
    return all.filter(function (r) { return C.inFilter(r, ST.opt.filter) && (!ST.cat || r.cat === ST.cat); });
  }

  function bind(body, ctx, all) {
    var t = new ui.Table({ rows: [], pageSize: 50, id: 'corp-all', empty: 'No announcement here', columns: [
      { key: 'at', label: 'When', get: function (r) { return r.at; }, html: function (r) { return esc(dayWords(r.day)) + ' <span class="sub">' + esc(r.time) + '</span>'; } },
      { key: 'sym', label: 'Stock', type: 'sym', name: 'name', html: function (r) { return ui.stockCell(r.sym, r.name || r.co); } },
      { key: 'cat', label: 'Category', get: function (r) { return r.cat + ' ' + (C.CAT[r.cat] || ''); }, html: catBadge },
      { key: 'ev', label: 'Event', get: function (r) { return evName(r.ev); },
        html: function (r) { return esc(evName(r.ev)) + (r.ex.length ? ' <span class="sub">+ ' + esc(r.ex.map(evName).join(', ')) + '</span>' : ''); } },
      { key: 'pr', label: 'Priority', get: function (r) { return (C.PRI[r.pr] || [''])[0]; }, html: priBadge },
      { key: 'bi', label: 'Impact', type: 'num', digits: 0, title: 'Business Impact (0-100)' },
      { key: 'gr', label: 'Risk', type: 'num', digits: 0, title: 'Governance / Risk (0-100)' },
      { key: 'su', label: 'Surprise', type: 'num', digits: 0, title: 'Information Surprise (0-100)' },
      { key: 'nums', label: 'Key numbers', get: function (r) { return C.numWords(r).join(' · '); } },
      { key: 'sub', label: 'What the filing says', get: function (r) { return r.sub + (r.tx && r.tx !== r.sub ? ' - ' + r.tx : ''); },
        html: function (r) { return '<b>' + esc(r.sub) + '</b>' + (r.tx && r.tx !== r.sub ? ' <span class="sub">' + esc(r.tx.length > 160 ? r.tx.slice(0, 160) + '…' : r.tx) + '</span>' : ''); } },
      { key: 'ps', label: 'From the PDF', title: 'The PDF\'s own lines your laptop picked: its subject, the sentences with an amount, a % or the event\'s words',
        get: function (r) { return r.ps.join(' · '); },
        html: function (r) { return r.ps.length ? '<div class="ci-ps-cell" data-tip="' + esc(r.ps.join(' · ')) + '">' + psHtml(r, 2) + '</div>' : '<span class="sub">–</span>'; } },
      { key: 'pdf', label: 'PDF', get: function (r) { return r.pdf; }, html: pdfLink },
      { key: 'why', label: 'Sorted by', title: 'The rule that decided the event' }
    ], hide: ['why'] }).mount($('#ci-all-t', body));
    function apply() {
      var list = rowsOf(all).filter(function (r) { return C.matches(r, ST.q); });
      $('#ci-count', body).textContent = F.int(list.length) + ' of ' + F.int(all.length);
      t.setRows(list);
      var syms = Object.keys(list.reduce(function (o, r) { o[r.sym] = 1; return o; }, {}));
      var w = ST.q.trim().toUpperCase(), arch = $('#ci-arch', body);
      var sym = syms.length === 1 ? syms[0] : /^[A-Z0-9&_.-]{2,30}$/.test(w) && ctx.bySym[w] ? w : '';
      arch.hidden = !sym || (ST.older && ST.older.key === 'sym:' + sym);
      arch.textContent = sym ? 'Every filing of ' + sym + ' (from my laptop)' : '';
      arch.setAttribute('data-sym-arch', sym);
    }
    var timer;
    $('#ci-q', body).addEventListener('input', function (e) { clearTimeout(timer); timer = setTimeout(function () { ST.q = e.target.value; apply(); }, 150); });
    $('#ci-arch', body).addEventListener('click', function (e) {
      var sym = e.currentTarget.getAttribute('data-sym-arch');
      if (!sym) return;
      askLaptop('sym:' + sym, body, function (got) { ST.older = got; ST.q = ''; draw(body, ctx); });
    });
    body.querySelectorAll('[data-cif]').forEach(function (b) {
      b.addEventListener('click', function () { ST.opt.filter = b.getAttribute('data-cif'); save(); draw(body, ctx); });
    });
    body.querySelectorAll('[data-cic]').forEach(function (b) {
      b.addEventListener('click', function () { ST.cat = b.getAttribute('data-cic'); draw(body, ctx); });
    });
    body.querySelectorAll('[data-cir]').forEach(function (b) {
      b.addEventListener('click', function () { ST.opt.range = b.getAttribute('data-cir'); ST.older = null; ST.asking = null; save(); show(body, ctx); });
    });
    $('#ci-day', body).addEventListener('change', function (e) {
      var d = e.target.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
      ST.opt.range = d;
      ST.older = null;
      save();
      show(body, ctx);
    });
    var back = $('#ci-back', body);
    if (back) back.addEventListener('click', function () { ST.older = null; ST.asking = null; if (/^\d{4}-/.test(ST.opt.range) && !keptDay(ST.opt.range)) ST.opt.range = 'today'; save(); show(body, ctx); });
    $('#ci-csv', body).addEventListener('click', function () { ui.download('corporate-intelligence.csv', ui.toCsv(t.toCsvRows())); });
    apply();
  }

  /** the range's days read (when kept), then drawn; a day older than the sheet's 30 -> asked of the laptop */
  function show(body, ctx) {
    var days = rangeDays();
    var picked = /^\d{4}-\d{2}-\d{2}$/.test(ST.opt.range) ? ST.opt.range : '';
    if (picked && !keptDay(picked)) {
      draw(body, ctx);
      askLaptop('day:' + picked, body, function (got) { ST.older = got; draw(body, ctx); });
      return;
    }
    if (days.every(function (d) { return MEM.byDay[d] || !keptDay(d); })) { draw(body, ctx); return; }
    body.innerHTML = '<section class="card" aria-busy="true"><h2>Loading the announcements…</h2>' + ui.skeleton(3) + '</section>';
    fill(days).then(function () { if (body.isConnected) draw(body, ctx); }, function (e) {
      if (body.isConnected) body.innerHTML = '<section class="card"><p class="empty">Could not load these days: ' + esc(e && e.message || 'failed') + '.</p></section>';
    });
  }

  SB.page('corp', {
    render: function (el, params, ctx) {
      if (params && params[0] && /^[A-Za-z0-9&_.-]{1,30}$/.test(params[0])) ST.q = params[0].toUpperCase();
      el.innerHTML = '<div class="page-head"><div><h1>Corporate Intelligence</h1><p>Every NSE announcement of your stocks, sorted into 6 categories and scored ' +
        'by fixed rules on your laptop (no AI): <b>Business Impact</b>, <b>Governance / Risk</b> and <b>Information Surprise</b>, with the numbers of each filing - ' +
        'order value and its share of revenue, execution period, rating, dividend, pledge, deal value, fundraising amount, monthly sales.</p></div></div>' +
        '<div id="ci-body"><section class="card" aria-busy="true"><h2>Loading the announcements…</h2>' + ui.skeleton(3) + '</section></div>';
      var body = $('#ci-body', el);
      first(ctx).then(function () {
        if (!el.isConnected) return;
        if (!MEM.days.length) {
          body.innerHTML = '<section class="card"><p class="empty">Nothing here yet - your laptop sends the announcements with its next results check ' +
            '(every 30 minutes), or run <b>CorpNow.bat</b> in the ScreenerBridge folder: it reads the past week at once.</p></section>';
          return;
        }
        show(body, ctx);
      }, function (e) {
        if (!el.isConnected) return;
        body.innerHTML = '<section class="card"><p class="empty">' + (e && e.message === 'local'
          ? 'The announcements come from your laptop through the live website - open the live site to see them.'
          : 'Could not load the announcements: ' + esc(e && e.message || 'failed') + '.') + '</p></section>';
      });
    }
  });
})();
