/* Stock Blueprint dashboard - plain JS, no build step.
   Data: window.SB_DATA (data/dashboard.js, made by tools/export_xlsx.py)
   or, when SB_CONFIG.liveUrl is set, the same JSON shape fetched live. */
(function () {
  'use strict';

  var D = null;            // current data
  var STOCKS = [];         // Main rows as objects
  var BY_SYM = {};         // symbol -> stock
  var REF_DATE = null;     // "today" for the data (Date)
  var LIVE = false;

  // ---------- small helpers ----------
  function $(s, el) { return (el || document).querySelector(s); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function objRows(t) {
    if (!t || !t.cols) return [];
    return t.rows.map(function (r) {
      var o = {};
      t.cols.forEach(function (c, i) { o[c] = r[i]; });
      return o;
    });
  }
  function median(a) {
    var s = a.filter(isNum).slice().sort(function (x, y) { return x - y; });
    if (!s.length) return null;
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function avg(a) {
    var s = a.filter(isNum);
    return s.length ? s.reduce(function (x, y) { return x + y; }, 0) / s.length : null;
  }
  function parseDate(v) {
    if (!v) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(v));
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  }
  function dayDiff(a, b) { return Math.round((startOfDay(a) - startOfDay(b)) / 864e5); }
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var F = {
    num: function (v, d) {
      if (!isNum(v)) return '–';
      return v.toLocaleString('en-IN', { maximumFractionDigits: d == null ? 2 : d, minimumFractionDigits: 0 });
    },
    price: function (v) {
      if (!isNum(v)) return '–';
      return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    },
    int: function (v) { return isNum(v) ? Math.round(v).toLocaleString('en-IN') : '–'; },
    pct: function (v, d) {
      if (!isNum(v)) return '–';
      var s = Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: d == null ? 1 : d, maximumFractionDigits: d == null ? 1 : d });
      return (v > 0 ? '+' : v < 0 ? '−' : '') + s + '%';
    },
    cr: function (v) { return isNum(v) ? Math.round(v).toLocaleString('en-IN') + ' Cr' : '–'; },
    date: function (v) {
      var d = parseDate(v);
      if (!d) return v ? esc(v) : '–';
      return d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear();
    },
    dateTime: function (v) {
      var d = parseDate(v);
      if (!d) return v ? esc(v) : '–';
      var t = /\d{2}:\d{2}/.test(String(v)) ? ' ' + String(v).slice(11, 16) : '';
      return d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear() + t;
    }
  };
  function deltaHtml(v, d) {
    if (!isNum(v)) return '<span class="sub">–</span>';
    return '<span class="' + (v > 0 ? 'up' : v < 0 ? 'down' : '') + '">' + F.pct(v, d) + '</span>';
  }

  // status -> badge (colour is never alone: the badge always has text)
  var STATUS = {
    buy: 's-good', avoid: 's-bad', hold: 's-warn', sell: 's-bad',
    updated: 's-good', pending: 's-warn', 'gave up': 's-bad',
    win: 's-good', loss: 's-bad', open: 's-info',
    strong: 's-good', mixed: 's-warn', weak: 's-bad',
    untouched: 's-info', 'first touch': 's-warn', mitigated: 's-serious',
    rallied: 's-good', flat: 's-warn', 'sold off': 's-bad', fell: 's-bad'
  };
  function badge(v) {
    if (v == null || v === '') return '<span class="sub">–</span>';
    var k = String(v).toLowerCase();
    var cls = STATUS[k];
    if (!cls) {
      if (/^widened|increas|above/.test(k)) cls = 's-good';
      else if (/^narrowed|decreas|below|loss/.test(k)) cls = 's-bad';
      else cls = '';
    }
    return '<span class="badge ' + cls + '">' + esc(v) + '</span>';
  }
  function screenerUrl(sym) { return 'https://www.screener.in/company/' + encodeURIComponent(sym) + '/'; }
  function chartUrl(sym) { return 'https://www.tradingview.com/chart/?symbol=' + encodeURIComponent('NSE:' + sym); }
  function symCell(sym, name) {
    if (!sym) return '–';
    return '<button type="button" class="sym linkish" data-sym="' + esc(sym) + '">' + esc(sym) + '</button>' +
      (name ? '<span class="co" title="' + esc(name) + '">' + esc(name) + '</span>' : '');
  }

  // ---------- generic sortable / paged table ----------
  // columns: {key, label, type: text|num|pct|price|date|datetime|badge|sym, get(row), html(row), wrap}
  function Table(opts) {
    this.o = opts;
    this.rows = opts.rows || [];
    this.page = 0;
    this.size = opts.pageSize || 50;
    this.sort = opts.sort || null; // {key, dir: 1|-1}
    this.id = 't' + Math.random().toString(36).slice(2, 8);
  }
  Table.prototype.val = function (c, r) { return c.get ? c.get(r) : r[c.key]; };
  Table.prototype.setRows = function (rows) { this.rows = rows; this.page = 0; this.draw(); };
  Table.prototype.sorted = function () {
    var s = this.sort, self = this;
    if (!s) return this.rows;
    var c = this.o.columns.filter(function (x) { return x.key === s.key; })[0];
    if (!c) return this.rows;
    var numeric = /^(num|pct|price)$/.test(c.type);
    return this.rows.slice().sort(function (a, b) {
      var x = self.val(c, a), y = self.val(c, b);
      var xe = x == null || x === '' || (numeric && !isNum(x)), ye = y == null || y === '' || (numeric && !isNum(y));
      if (xe && ye) return 0;
      if (xe) return 1;            // blanks always last
      if (ye) return -1;
      if (numeric) return (x - y) * s.dir;
      return String(x).localeCompare(String(y), 'en', { numeric: true }) * s.dir;
    });
  };
  Table.prototype.cell = function (c, r) {
    if (c.html) return c.html(r);
    var v = this.val(c, r);
    switch (c.type) {
      case 'num': return F.num(v, c.digits);
      case 'price': return F.price(v);
      case 'pct': return deltaHtml(v, c.digits);
      case 'date': return F.date(v);
      case 'datetime': return F.dateTime(v);
      case 'badge': return badge(v);
      case 'sym': return symCell(v, c.name ? r[c.name] : null);
      default: return v == null || v === '' ? '<span class="sub">–</span>' : esc(v);
    }
  };
  Table.prototype.mount = function (host) {
    this.host = host;
    var self = this;
    host.addEventListener('click', function (e) {
      var th = e.target.closest('th[data-k]');
      if (th) { self.toggleSort(th.getAttribute('data-k')); return; }
      var pb = e.target.closest('[data-page]');
      if (pb) { self.page += +pb.getAttribute('data-page'); self.draw(); return; }
    });
    host.addEventListener('keydown', function (e) {
      var th = e.target.closest('th[data-k]');
      if (th && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); self.toggleSort(th.getAttribute('data-k')); }
    });
    this.draw();
    return this;
  };
  Table.prototype.toggleSort = function (k) {
    var c = this.o.columns.filter(function (x) { return x.key === k; })[0];
    var numeric = c && /^(num|pct|price|date|datetime)$/.test(c.type);
    if (this.sort && this.sort.key === k) this.sort.dir = -this.sort.dir;
    else this.sort = { key: k, dir: numeric ? -1 : 1 };
    this.page = 0;
    this.draw();
    var th = this.host.querySelector('th[data-k="' + k + '"]');
    if (th) th.focus();
  };
  Table.prototype.draw = function () {
    if (!this.host) return;
    var self = this, cols = this.o.columns, rows = this.sorted();
    var pages = Math.max(1, Math.ceil(rows.length / this.size));
    if (this.page >= pages) this.page = pages - 1;
    if (this.page < 0) this.page = 0;
    var slice = rows.slice(this.page * this.size, (this.page + 1) * this.size);
    var h = '<div class="tbl-wrap"><table class="tbl"><thead><tr>';
    cols.forEach(function (c) {
      var srt = self.sort && self.sort.key === c.key ? (self.sort.dir > 0 ? 'ascending' : 'descending') : 'none';
      var num = /^(num|pct|price)$/.test(c.type) ? ' class="num"' : '';
      h += '<th scope="col" tabindex="0" data-k="' + esc(c.key) + '" aria-sort="' + srt + '"' + num +
        (c.title ? ' title="' + esc(c.title) + '"' : '') + '>' + esc(c.label) + '</th>';
    });
    h += '</tr></thead><tbody>';
    if (!slice.length) {
      h += '<tr><td class="empty" colspan="' + cols.length + '">' + esc(this.o.empty || 'Nothing to show') + '</td></tr>';
    }
    slice.forEach(function (r) {
      h += '<tr>';
      cols.forEach(function (c) {
        var cls = /^(num|pct|price)$/.test(c.type) ? 'num' : c.wrap ? 'wrap' : /^(date|datetime|badge)$/.test(c.type) ? 'nowrap' : '';
        h += '<td' + (cls ? ' class="' + cls + '"' : '') + '>' + self.cell(c, r) + '</td>';
      });
      h += '</tr>';
    });
    h += '</tbody></table></div>';
    if (rows.length > this.size) {
      h += '<div class="pager"><span>' + (this.page * this.size + 1) + '–' + Math.min(rows.length, (this.page + 1) * this.size) +
        ' of ' + rows.length + '</span>' +
        '<button type="button" data-page="-1"' + (this.page === 0 ? ' disabled' : '') + '>‹ Prev</button>' +
        '<button type="button" data-page="1"' + (this.page >= pages - 1 ? ' disabled' : '') + '>Next ›</button></div>';
    }
    this.host.innerHTML = h;
  };

  // ---------- bar chart (single series, HTML) ----------
  // items: [{label, value, tip}], opts: {diverging, fmt}
  function bars(items, opts) {
    opts = opts || {};
    var fmt = opts.fmt || function (v) { return F.num(v, 0); };
    var max = Math.max.apply(null, items.map(function (i) { return Math.abs(i.value) || 0; }).concat([1e-9]));
    var h = '<div class="bars" role="list">';
    items.forEach(function (it) {
      var v = it.value || 0, w = Math.abs(v) / max;
      var bar;
      if (opts.diverging) {
        bar = '<div class="bar-track div"><div class="bar ' + (v < 0 ? 'neg' : 'pos') + '" style="' +
          (v < 0 ? 'right:50%;' : 'left:50%;') + 'width:' + (w * 50).toFixed(2) + '%"></div></div>';
      } else {
        bar = '<div class="bar-track"><div class="bar pos" style="left:0;width:' + Math.max(w * 100, v ? 1 : 0).toFixed(2) + '%"></div></div>';
      }
      h += '<div class="bar-row" role="listitem" tabindex="0" data-tip="' + esc(it.tip || (it.label + ': ' + fmt(v))) + '">' +
        '<span class="bar-label" title="' + esc(it.label) + '">' + esc(it.label) + '</span>' + bar +
        '<span class="bar-val">' + fmt(v) + '</span></div>';
    });
    return h + '</div>';
  }

  function tile(label, value, note, cls) {
    return '<div class="tile' + (cls ? ' ' + cls : '') + '"><div class="label">' + esc(label) + '</div>' +
      '<div class="value">' + value + '</div>' + (note ? '<div class="note">' + note + '</div>' : '') + '</div>';
  }
  function card(title, sub, body, id) {
    return '<section class="card"' + (id ? ' id="' + id + '"' : '') + '><div class="card-head"><div><h2>' + esc(title) + '</h2>' +
      (sub ? '<p>' + sub + '</p>' : '') + '</div></div>' + body + '</section>';
  }
  function chips(name, options, current) {
    return '<div class="chips" role="group" aria-label="' + esc(name) + '">' + options.map(function (o) {
      return '<button type="button" class="chip" data-chip="' + esc(name) + '" data-v="' + esc(o[0]) + '" aria-pressed="' +
        (o[0] === current) + '">' + esc(o[1]) + '</button>';
    }).join('') + '</div>';
  }
  function bindChips(root, name, fn) {
    root.addEventListener('click', function (e) {
      var b = e.target.closest('[data-chip="' + name + '"]');
      if (!b) return;
      root.querySelectorAll('[data-chip="' + name + '"]').forEach(function (x) { x.setAttribute('aria-pressed', x === b); });
      fn(b.getAttribute('data-v'));
    });
  }
  function textMatch(q, parts) {
    if (!q) return true;
    q = q.toLowerCase();
    for (var i = 0; i < parts.length; i++) if (parts[i] && String(parts[i]).toLowerCase().indexOf(q) >= 0) return true;
    return false;
  }

  // ---------- data prep ----------
  function prepare(data) {
    D = data;
    STOCKS = objRows(D.main);
    BY_SYM = {};
    STOCKS.forEach(function (s) { BY_SYM[s.sym] = s; });
    REF_DATE = parseDate(D.asOf) || parseDate(D.generated) || new Date();
  }

  // ---------- pages ----------
  var pages = {};

  pages.overview = function (el) {
    var priced = STOCKS.filter(function (s) { return isNum(s.chg); });
    var adv = priced.filter(function (s) { return s.chg > 0; }).length;
    var dec = priced.filter(function (s) { return s.chg < 0; }).length;
    var buys = STOCKS.filter(function (s) { return s.sig === 'Buy'; }).length;
    var withPat = STOCKS.filter(function (s) { return s.pat || s.fvg; }).length;
    var tracker = objRows(D.resultsTracker);
    var tc = { Updated: 0, Pending: 0, 'Gave up': 0 };
    tracker.forEach(function (r) { if (r.Status in tc) tc[r.Status]++; });
    var season = (D.resultsPerf && D.resultsPerf.seasons && D.resultsPerf.seasons[0]) || null;
    var alerts = objRows(D.alerts);
    var openA = alerts.filter(function (a) { return a.Outcome === 'Open'; }).length;

    var h = '<div class="page-head"><div><h1>Market overview</h1><p>Today’s picture of your ' + F.int(STOCKS.length) +
      '-stock watchlist: breadth, movers, results season and alerts.</p></div></div>';
    h += '<div class="tiles">' +
      tile('Stocks tracked', F.int(STOCKS.length), adv + ' up · ' + dec + ' down today', 'hero') +
      tile('TTM Buy signals', F.int(buys), F.num(buys / Math.max(1, STOCKS.length) * 100, 0) + '% of watchlist') +
      tile('With pattern / FVG tag', F.int(withPat), 'see Patterns & FVG') +
      tile('Results updated' + (season ? ' · ' + season.season : ''), F.int(tc.Updated), F.int(tc.Pending) + ' pending · ' + F.int(tc['Gave up']) + ' gave up') +
      tile('Open watch alerts', F.int(openA), alerts.length + ' breakout / price-fall alerts') +
      '</div>';

    // movers
    var g = priced.slice().sort(function (a, b) { return b.chg - a.chg; }).slice(0, 8);
    var l = priced.slice().sort(function (a, b) { return a.chg - b.chg; }).slice(0, 8);
    function moverList(arr) {
      return '<ul class="list">' + arr.map(function (s) {
        return '<li><div class="grow"><button type="button" class="linkish" data-sym="' + esc(s.sym) + '">' + esc(s.sym) +
          '</button><span class="co">' + esc(s.name || '') + '</span></div><span class="num">' + F.price(s.price) +
          '</span><span class="num" style="min-width:64px">' + deltaHtml(s.chg, 2) + '</span></li>';
      }).join('') + '</ul>';
    }
    h += '<div class="grid g2">' + card('Top gainers today', '% change, from the Main tab', moverList(g)) +
      card('Top losers today', '% change, from the Main tab', moverList(l)) + '</div>';

    // sector breadth
    var sec = {};
    priced.forEach(function (s) {
      var k = s.sector || 'Other';
      (sec[k] = sec[k] || []).push(s.chg);
    });
    var secItems = Object.keys(sec).filter(function (k) { return sec[k].length >= 5; }).map(function (k) {
      var a = avg(sec[k]);
      var up = sec[k].filter(function (x) { return x > 0; }).length;
      return { label: k, value: a, tip: k + ': avg ' + F.pct(a, 2) + ' · ' + up + ' of ' + sec[k].length + ' up' };
    }).sort(function (a, b) { return b.value - a.value; });

    // upcoming results
    var soon = STOCKS.filter(function (s) {
      var d = parseDate(s.rdate);
      if (!d) return false;
      var dd = dayDiff(d, REF_DATE);
      return dd >= 0 && dd <= 14;
    }).sort(function (a, b) { return String(a.rdate).localeCompare(String(b.rdate)); });

    h += '<div class="grid g2">' +
      card('Sector breadth today', 'Average % change per sector (5+ stocks). Hover a bar for details.',
        bars(secItems, { diverging: true, fmt: function (v) { return F.pct(v, 2); } }) +
        '<div class="legend"><span><i style="background:var(--series-1)"></i>Average up</span><span><i style="background:var(--neg-mark)"></i>Average down</span></div>') +
      card('Results in the next 14 days', soon.length + ' stocks with a result date from ' + F.date(fmtIso(REF_DATE)), '<div id="ov-soon"></div>') +
      '</div>';

    // indices
    h += card('Indices', 'Day change and distance from all-time high', '<div id="ov-idx"></div>');
    el.innerHTML = h;

    new Table({
      rows: soon, pageSize: 10, empty: 'No result dates in the next 14 days',
      columns: [
        { key: 'rdate', label: 'Result date', type: 'date' },
        { key: 'sym', label: 'Stock', type: 'sym', name: 'name' },
        { key: 'chg', label: 'Today', type: 'pct', digits: 2 },
        { key: 'sig', label: 'TTM Signal', type: 'badge' }
      ]
    }).mount($('#ov-soon', el));

    new Table({
      rows: objRows(D.indices), pageSize: 40, sort: { key: 'Day change', dir: -1 },
      columns: [
        { key: 'NSE Symbol', label: 'Index', get: function (r) { return String(r['NSE Symbol'] || '').replace(/_/g, ' '); } },
        { key: 'Current Price', label: 'Level', type: 'price' },
        { key: 'Day change', label: 'Today', type: 'pct', digits: 2 },
        { key: 'Drop from all time high', label: 'From ATH', type: 'pct' },
        { key: '1 year returns', label: '1Y', type: 'pct' },
        { key: '5Y returns', label: '5Y', type: 'pct', digits: 0 }
      ]
    }).mount($('#ov-idx', el));
  };

  function fmtIso(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // Watchlist
  var WL = { q: '', sector: '', f: 'all' };
  pages.watchlist = function (el) {
    var sectors = {};
    STOCKS.forEach(function (s) { if (s.sector) sectors[s.sector] = (sectors[s.sector] || 0) + 1; });
    var h = '<div class="page-head"><div><h1>Watchlist</h1><p>All ' + F.int(STOCKS.length) +
      ' stocks from the Main tab. Click a symbol for details; click a column to sort.</p></div></div>';
    h += '<section class="card"><div class="controls">' +
      '<input class="search" id="wl-q" type="search" placeholder="Search symbol, company or industry" aria-label="Search stocks" value="' + esc(WL.q) + '">' +
      '<select class="sel" id="wl-sector" aria-label="Sector"><option value="">All sectors</option>' +
      Object.keys(sectors).sort().map(function (k) {
        return '<option value="' + esc(k) + '"' + (WL.sector === k ? ' selected' : '') + '>' + esc(k) + ' (' + sectors[k] + ')</option>';
      }).join('') + '</select></div>' +
      '<div class="controls">' + chips('wl', [
        ['all', 'All'], ['buy', 'TTM Buy'], ['pattern', 'Has pattern'], ['fvg', 'Has FVG'],
        ['ema', 'EMA support'], ['results', 'Result due ≤14 days'], ['done', 'Results ticked'],
        ['near', 'Within 10% of 52W high']
      ], WL.f) + '<span class="count" id="wl-count"></span></div>' +
      '<div id="wl-table"></div></section>';
    el.innerHTML = h;

    var t = new Table({
      rows: [], pageSize: 50, sort: { key: 'chg', dir: -1 }, empty: 'No stocks match these filters',
      columns: [
        { key: 'sym', label: 'Stock', type: 'sym', name: 'name' },
        { key: 'ind', label: 'Industry', wrap: true },
        { key: 'price', label: 'Price', type: 'price' },
        { key: 'chg', label: 'Today', type: 'pct', digits: 2 },
        { key: 'd10', label: '10D', type: 'pct' },
        { key: 'd30', label: '30D', type: 'pct' },
        { key: 'down52', label: 'From 52W high', type: 'pct' },
        { key: 'pevs', label: 'PE / Ind PE', type: 'num', title: 'PE ratio divided by industry PE' },
        { key: 'up', label: 'Upside', type: 'pct', digits: 0 },
        { key: 'sig', label: 'TTM Signal', type: 'badge' },
        { key: 'pat', label: 'Pattern', wrap: true },
        { key: 'rdate', label: 'Result date', type: 'date' },
        { key: 'mcap', label: 'M-cap', type: 'num', html: function (r) { return F.cr(r.mcap); } }
      ]
    }).mount($('#wl-table', el));

    function apply() {
      var rows = STOCKS.filter(function (s) {
        if (WL.sector && s.sector !== WL.sector) return false;
        if (!textMatch(WL.q, [s.sym, s.name, s.ind, s.sector])) return false;
        switch (WL.f) {
          case 'buy': return s.sig === 'Buy';
          case 'pattern': return !!s.pat;
          case 'fvg': return !!s.fvg;
          case 'ema': return !!(s.e10 || s.e21);
          case 'done': return s.done === true;
          case 'near': return isNum(s.down52) && s.down52 >= -10;
          case 'results':
            var d = parseDate(s.rdate);
            if (!d) return false;
            var dd = dayDiff(d, REF_DATE);
            return dd >= 0 && dd <= 14;
        }
        return true;
      });
      $('#wl-count', el).textContent = F.int(rows.length) + ' stocks';
      t.setRows(rows);
    }
    var timer;
    $('#wl-q', el).addEventListener('input', function (e) {
      clearTimeout(timer);
      timer = setTimeout(function () { WL.q = e.target.value.trim(); apply(); }, 120);
    });
    $('#wl-sector', el).addEventListener('change', function (e) { WL.sector = e.target.value; apply(); });
    bindChips(el, 'wl', function (v) { WL.f = v; apply(); });
    apply();
  };

  // Results season
  var RS = { status: 'all', q: '' };
  pages.results = function (el) {
    var perf = D.resultsPerf || {};
    var season = (perf.seasons || [])[0];
    var tracker = objRows(D.resultsTracker);
    var tc = { Updated: 0, Pending: 0, 'Gave up': 0 };
    tracker.forEach(function (r) { if (r.Status in tc) tc[r.Status]++; });

    var h = '<div class="page-head"><div><h1>Results season' + (season ? ' · ' + esc(season.season) : '') + '</h1>' +
      '<p>How stocks moved after their quarterly results, and which results are still waiting on screener.in.</p></div></div>';
    if (season) {
      h += '<div class="tiles">' +
        tile('Stocks tracked', F.int(season.tracked), 'results updated this season') +
        tile('Average since results', deltaHtml(season.avg, 2), 'vs close before the result') +
        tile('Median since results', deltaHtml(season.median, 2)) +
        tile('Above pre-result price', esc(season.above || '–')) +
        tile('Strong results, sold off', F.int(season.soldOff), 'good numbers, price fell') +
        '</div>';
    }
    var verdicts = (perf.verdicts || []).filter(function (v) { return v.verdict; });
    h += '<div class="grid g2">' +
      card('Stocks by results verdict', 'Count of stocks; hover for average move since results',
        bars(verdicts.map(function (v) {
          return { label: v.verdict, value: v.stocks, tip: v.verdict + ': ' + F.int(v.stocks) + ' stocks · avg ' + F.pct(v.avg, 2) + ' since results · ' + F.num(v.positive, 0) + '% positive' };
        }))) +
      card('Average move since results, by verdict', 'Strong / Mixed / Weak results',
        bars(verdicts.map(function (v) { return { label: v.verdict, value: v.avg }; }), { diverging: true, fmt: function (v) { return F.pct(v, 2); } }) +
        '<div class="legend"><span><i style="background:var(--series-1)"></i>Up since results</span><span><i style="background:var(--neg-mark)"></i>Down since results</span></div>') +
      '</div>';

    h += card('Results performance', esc(perf.note || ''), '<div class="controls"><input class="search" id="rp-q" type="search" placeholder="Search symbol or industry" aria-label="Search results performance"></div><div id="rp-table"></div>');
    h += '<section class="card"><div class="card-head"><div><h2>Results tracker</h2><p>Every stock whose result date has arrived. Pending = screener.in does not show the new quarter yet (retried every run).</p></div></div>' +
      '<div class="controls">' + chips('rs', [['all', 'All (' + tracker.length + ')'], ['Updated', 'Updated (' + tc.Updated + ')'],
        ['Pending', 'Pending (' + tc.Pending + ')'], ['Gave up', 'Gave up (' + tc['Gave up'] + ')']], RS.status) + '</div>' +
      '<div id="rs-table"></div></section>';
    el.innerHTML = h;

    var perfRows = objRows(perf.table);
    var pt = new Table({
      rows: perfRows, pageSize: 25, sort: { key: '% Since Results', dir: -1 },
      columns: [
        { key: 'Symbol', label: 'Stock', type: 'sym', name: 'Company' },
        { key: 'Basic Industry', label: 'Industry', wrap: true },
        { key: 'Quarter', label: 'Quarter' },
        { key: 'Result Date', label: 'Result date', type: 'date' },
        { key: 'Result Day %', label: 'Result day', type: 'pct' },
        { key: '% Since Results', label: 'Since results', type: 'pct' },
        { key: 'Max Gain %', label: 'Max gain', type: 'pct' },
        { key: 'Max Drawdown %', label: 'Max drawdown', type: 'pct' },
        { key: 'Rev YoY %', label: 'Rev YoY', type: 'pct', digits: 0 },
        { key: 'NP YoY %', label: 'Profit YoY', type: 'pct', digits: 0 },
        { key: 'Results Verdict', label: 'Verdict', type: 'badge' },
        { key: 'Market Reaction', label: 'Reaction', type: 'badge' }
      ]
    }).mount($('#rp-table', el));
    $('#rp-q', el).addEventListener('input', function (e) {
      var q = e.target.value.trim();
      pt.setRows(perfRows.filter(function (r) { return textMatch(q, [r.Symbol, r.Company, r['Basic Industry']]); }));
    });

    var rt = new Table({
      rows: [], pageSize: 25, sort: { key: 'Result Date', dir: -1 },
      columns: [
        { key: 'Symbol', label: 'Stock', type: 'sym', name: 'Company' },
        { key: 'Result Date', label: 'Result date', type: 'date' },
        { key: 'Quarter Expected', label: 'Expected' },
        { key: 'Screener Latest Quarter', label: 'Screener shows' },
        { key: 'Status', label: 'Status', type: 'badge' },
        { key: 'Checks', label: 'Checks', type: 'num', get: function (r) { return r.Checks == null ? null : +r.Checks; } },
        { key: 'Last Checked', label: 'Last checked', type: 'datetime' },
        { key: 'Note', label: 'Note', wrap: true }
      ]
    }).mount($('#rs-table', el));
    function applyRs() { rt.setRows(tracker.filter(function (r) { return RS.status === 'all' || r.Status === RS.status; })); }
    bindChips(el, 'rs', function (v) { RS.status = v; applyRs(); });
    applyRs();
  };

  // Patterns & FVG
  pages.signals = function (el) {
    var p = D.patterns || {};
    var k = p.kpis || {};
    var h = '<div class="page-head"><div><h1>Patterns &amp; FVG</h1><p>Candlestick patterns, fair value gaps (FVG) and EMA support found by the daily pipeline.</p></div></div>';
    h += '<div class="tiles">' + Object.keys(k).map(function (key) {
      var m = /^(.+?)\s*\((.+)\)$/.exec(String(k[key] == null ? '' : k[key]));
      return m ? tile(key, esc(m[1]), esc(m[2])) : tile(key, esc(k[key] == null ? '–' : k[key]));
    }).join('') + '</div>';

    h += card('Signals summary', 'One row per signal type. Averages are today’s moves of the stocks carrying it.', '<div id="sg-sum"></div>');
    h += '<section class="card"><div class="card-head"><div><h2>Stocks with signals</h2><p>Confluence = number of different signal types on the stock.</p></div></div>' +
      '<div class="controls"><input class="search" id="sg-q" type="search" placeholder="Search symbol, industry or pattern" aria-label="Search signal stocks">' +
      chips('sg', [['all', 'All'], ['buy', 'TTM Buy'], ['c3', 'Confluence 3+']], 'all') + '<span class="count" id="sg-count"></span></div>' +
      '<div id="sg-stocks"></div></section>';
    h += card('Where signals cluster', 'Basic industries with the most signalled stocks', '<div id="sg-cl"></div>');
    h += '<div class="grid g2">' +
      card('Unmitigated FVG zones', 'Price gaps not yet filled', '<div id="sg-fvg"></div>') +
      card('Gap-up FVG zones', 'Gap-up days that left a fair value gap', '<div id="sg-gap"></div>') + '</div>';
    h += card('Signal watchlist log', 'Stocks flagged by the engine, newest first', '<div class="controls"><input class="search" id="wl2-q" type="search" placeholder="Search symbol or source" aria-label="Search signal log"></div><div id="sg-log"></div>');
    el.innerHTML = h;

    new Table({
      rows: objRows(p.signals), pageSize: 30,
      columns: [
        { key: 'Type', label: 'Type' },
        { key: 'Signal', label: 'Signal' },
        { key: 'Stocks', label: 'Stocks', type: 'num' },
        { key: 'Fresh today', label: 'Fresh today', type: 'num' },
        { key: 'Avg % Change', label: 'Avg today', type: 'pct', digits: 2 },
        { key: '% Advancing', label: '% advancing', type: 'num', digits: 0, html: function (r) { return isNum(r['% Advancing']) ? F.num(r['% Advancing'], 0) + '%' : '–'; } },
        { key: 'Avg 10-day %', label: 'Avg 10D', type: 'pct' },
        { key: 'Avg 30-day %', label: 'Avg 30D', type: 'pct' },
        { key: 'Most common Basic Industry', label: 'Most common industry', wrap: true }
      ]
    }).mount($('#sg-sum', el));

    var st = objRows(p.stocks), sgF = 'all', sgQ = '';
    var stT = new Table({
      rows: [], pageSize: 25, sort: { key: 'Confluence', dir: -1 },
      columns: [
        { key: 'Symbol', label: 'Stock', type: 'sym', name: 'Company' },
        { key: 'Basic Industry', label: 'Industry', wrap: true },
        { key: 'Pattern', label: 'Pattern', wrap: true },
        { key: 'FVG', label: 'FVG', wrap: true },
        { key: '10 EMA', label: '10 EMA', wrap: true },
        { key: '21 EMA', label: '21 EMA', wrap: true },
        { key: 'Confluence', label: 'Confluence', type: 'num' },
        { key: '% Change', label: 'Today', type: 'pct', digits: 2 },
        { key: '30-day %', label: '30D', type: 'pct' },
        { key: 'TTM Signal', label: 'TTM Signal', type: 'badge' }
      ]
    }).mount($('#sg-stocks', el));
    function applySg() {
      var rows = st.filter(function (r) {
        if (sgF === 'buy' && r['TTM Signal'] !== 'Buy') return false;
        if (sgF === 'c3' && !(r.Confluence >= 3)) return false;
        return textMatch(sgQ, [r.Symbol, r.Company, r['Basic Industry'], r.Pattern, r.FVG]);
      });
      $('#sg-count', el).textContent = F.int(rows.length) + ' stocks';
      stT.setRows(rows);
    }
    $('#sg-q', el).addEventListener('input', function (e) { sgQ = e.target.value.trim(); applySg(); });
    bindChips(el, 'sg', function (v) { sgF = v; applySg(); });
    applySg();

    new Table({
      rows: objRows(p.clusters), pageSize: 20,
      columns: [
        { key: 'Basic Industry', label: 'Industry' },
        { key: 'Signalled stocks', label: 'Signalled', type: 'num' },
        { key: 'With 2+ signal types', label: '2+ types', type: 'num' },
        { key: 'Avg % Change', label: 'Avg today', type: 'pct', digits: 2 },
        { key: 'Signal mix (fresh)', label: 'Signal mix', wrap: true },
        { key: 'Strongest names', label: 'Strongest names', wrap: true }
      ]
    }).mount($('#sg-cl', el));

    var zoneCols = function (pre) {
      return [
        { key: 'Symbol', label: 'Stock', type: 'sym' },
        { key: pre + ' Bottom', label: 'Bottom', type: 'price' },
        { key: pre + ' Top', label: 'Top', type: 'price' },
        { key: pre + ' %', label: 'Size', type: 'num', html: function (r) { return isNum(r[pre + ' %']) ? F.num(r[pre + ' %'], 2) + '%' : '–'; } },
        { key: 'Formed', label: 'Formed', type: 'date' },
        { key: 'Status', label: 'Status', type: 'badge' }
      ];
    };
    new Table({ rows: objRows(D.fvg), pageSize: 15, sort: { key: 'Formed', dir: -1 }, columns: zoneCols('Zone') }).mount($('#sg-fvg', el));
    new Table({ rows: objRows(D.gapup), pageSize: 15, sort: { key: 'Formed', dir: -1 }, columns: zoneCols('Gap') }).mount($('#sg-gap', el));

    var logRows = objRows(D.watchLog);
    var lt = new Table({
      rows: logRows, pageSize: 20, sort: { key: 'Date Flagged', dir: -1 },
      columns: [
        { key: 'Date Flagged', label: 'Flagged', type: 'date' },
        { key: 'Symbol', label: 'Stock', type: 'sym', name: 'Name' },
        { key: 'Source', label: 'Source' },
        { key: 'Price At Flag', label: 'Price at flag', type: 'price' },
        { key: 'now', label: 'Now', type: 'price', get: function (r) { var s = BY_SYM[r.Symbol]; return s ? s.price : null; } },
        { key: 'since', label: 'Since flag', type: 'pct', get: function (r) {
          var s = BY_SYM[r.Symbol];
          return s && isNum(s.price) && isNum(r['Price At Flag']) && r['Price At Flag'] ? (s.price / r['Price At Flag'] - 1) * 100 : null;
        } }
      ]
    }).mount($('#sg-log', el));
    $('#wl2-q', el).addEventListener('input', function (e) {
      var q = e.target.value.trim();
      lt.setRows(logRows.filter(function (r) { return textMatch(q, [r.Symbol, r.Name, r.Source]); }));
    });
  };

  // Alerts & trades
  pages.alerts = function (el) {
    var alerts = objRows(D.alerts);
    var byType = {};
    alerts.forEach(function (a) {
      var t = a['Alert Type'] || 'Other';
      var o = byType[t] = byType[t] || { total: 0, win: 0, loss: 0, open: 0, since: [] };
      o.total++;
      if (a.Outcome === 'Win') o.win++; else if (a.Outcome === 'Loss') o.loss++; else o.open++;
      o.since.push(a['% Since Alert']);
    });
    var types = Object.keys(byType).sort();

    var h = '<div class="page-head"><div><h1>Alerts</h1><p>Breakout and price-fall watch alerts from the sheet. Personal entries, positions and trade results are not published.</p></div></div>';

    h += '<div class="grid g2">' +
      card('Alerts by type', 'Hit rate = wins ÷ (wins + losses)', '<div id="al-type"></div>') +
      card('Average move since alert', 'By alert type', bars(types.map(function (t) {
        var a = avg(byType[t].since);
        return { label: t, value: a || 0, tip: t + ': avg ' + F.pct(a, 2) + ' over ' + byType[t].total + ' alerts' };
      }), { diverging: true, fmt: function (v) { return F.pct(v, 2); } }) +
      '<div class="legend"><span><i style="background:var(--series-1)"></i>Up since alert</span><span><i style="background:var(--neg-mark)"></i>Down since alert</span></div>') +
      '</div>';
    h += card('Alert log', alerts.length + ' alerts', '<div id="al-log"></div>');
    el.innerHTML = h;

    new Table({
      rows: types.map(function (t) {
        var o = byType[t];
        return { type: t, total: o.total, win: o.win, loss: o.loss, open: o.open, hit: o.win + o.loss ? o.win / (o.win + o.loss) * 100 : null };
      }),
      columns: [
        { key: 'type', label: 'Type' },
        { key: 'total', label: 'Total', type: 'num' },
        { key: 'win', label: 'Win', type: 'num' },
        { key: 'loss', label: 'Loss', type: 'num' },
        { key: 'open', label: 'Open', type: 'num' },
        { key: 'hit', label: 'Hit rate', type: 'num', html: function (r) { return isNum(r.hit) ? F.num(r.hit, 0) + '%' : '–'; } }
      ]
    }).mount($('#al-type', el));

    new Table({
      rows: alerts, pageSize: 25, sort: { key: 'Date', dir: -1 },
      columns: [
        { key: 'Date', label: 'Date', type: 'datetime' },
        { key: 'Symbol', label: 'Stock', type: 'sym', name: 'Company' },
        { key: 'Alert Type', label: 'Type' },
        { key: 'Alert Level', label: 'Level', type: 'price' },
        { key: 'Trigger Price', label: 'Triggered at', type: 'price' },
        { key: 'Current Price', label: 'Now', type: 'price' },
        { key: '% Since Alert', label: 'Since alert', type: 'pct', digits: 2 },
        { key: 'Days Since', label: 'Days', type: 'num', digits: 0 },
        { key: 'Pattern @ Alert', label: 'Pattern at alert', wrap: true },
        { key: 'Outcome', label: 'Outcome', type: 'badge' }
      ]
    }).mount($('#al-log', el));
  };

  // IPOs & markets
  pages.markets = function (el) {
    var ipos = objRows(D.ipos);
    var h = '<div class="page-head"><div><h1>IPOs &amp; markets</h1><p>Listed IPOs and their bases, the latest listings and NSE price band changes.</p></div></div>';
    h += '<section class="card"><div class="card-head"><div><h2>IPO tracker</h2><p>' + ipos.length + ' IPOs · price vs listing price and IPO base</p></div></div>' +
      '<div class="controls"><input class="search" id="ipo-q" type="search" placeholder="Search IPO symbol or base status" aria-label="Search IPOs">' +
      chips('ipo', [['all', 'All'], ['Above', 'Above IPO price'], ['Below', 'Below IPO price']], 'all') + '</div><div id="ipo-t"></div></section>';
    h += '<div class="grid g2">' +
      card('New listings', 'Latest NSE listings', '<div id="ipo-new"></div>') +
      card('Price band changes', 'NSE circuit band revisions', '<div id="pb-t"></div>') + '</div>';
    el.innerHTML = h;

    var it = new Table({
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
        return textMatch(iq, [r['NSE SYMBOL'], r['Base Status']]);
      }));
    }
    $('#ipo-q', el).addEventListener('input', function (e) { iq = e.target.value.trim(); applyIpo(); });
    bindChips(el, 'ipo', function (v) { iF = v; applyIpo(); });
    applyIpo();

    new Table({
      rows: objRows(D.newIpos), pageSize: 15, sort: { key: 'DATE OF LISTING', dir: -1 },
      columns: [
        { key: 'Symbol', label: 'Stock', type: 'sym', name: 'COMPANY NAME' },
        { key: 'SECURITY TYPE', label: 'Series' },
        { key: 'DATE OF LISTING', label: 'Listed', type: 'date' }
      ]
    }).mount($('#ipo-new', el));
    new Table({
      rows: objRows(D.priceBands), pageSize: 15, sort: { key: 'Effective (next weekday)', dir: -1 },
      columns: [
        { key: 'Symbol', label: 'Stock', type: 'sym', name: 'Company' },
        { key: 'Effective (next weekday)', label: 'Effective', type: 'date' },
        { key: 'band', label: 'Band', get: function (r) { return (isNum(r['From %']) ? r['From %'] : '?') + '% → ' + (isNum(r['To %']) ? r['To %'] : '?') + '%'; } },
        { key: 'Impact', label: 'Impact', type: 'badge' }
      ]
    }).mount($('#pb-t', el));
  };

  // ---------- stock drawer ----------
  function openStock(sym, opener) {
    var s = BY_SYM[sym];
    var body = $('#drawer-body');
    var h = '';
    if (!s) {
      h = '<h2 id="drawer-title">' + esc(sym) + '</h2><p class="sub">Not in the Main watchlist.</p>';
    } else {
      h = '<h2 id="drawer-title">' + esc(s.sym) + '</h2><p class="sub">' + esc(s.name || '') + '</p>' +
        '<div style="display:flex;align-items:baseline;gap:12px;margin-top:10px"><span style="font-size:28px;font-weight:600">' + F.price(s.price) +
        '</span>' + deltaHtml(s.chg, 2) + '</div>' +
        '<div class="tags">' + [s.sig ? badge(s.sig) : '', s.pat ? badge(s.pat) : '', s.fvg ? badge(s.fvg) : '',
          s.e10 ? badge(s.e10) : '', s.e21 ? badge(s.e21) : '', s.zone ? badge(s.zone) : ''].join('') + '</div>';
      var kv = [
        ['Sector', esc(s.sector || '–')], ['Industry', esc(s.ind || '–')], ['Index', esc(s.idx || '–')], ['Market cap', F.cr(s.mcap)],
        ['10-day', deltaHtml(s.d10)], ['30-day', deltaHtml(s.d30)], ['52W high', F.price(s.hi52)], ['From 52W high', deltaHtml(s.down52)],
        ['PE', F.num(s.pe)], ['Industry PE', F.num(s.ipe)], ['PE / Industry PE', F.num(s.pevs)], ['TTM PEG', F.num(s.peg)],
        ['TTM EPS growth', F.num(s.epsg)], ['Target price', F.price(s.tgt)], ['Upside', deltaHtml(s.up, 0)], ['Result date', F.date(s.rdate) + (s.done ? ' ✓' : '')],
        ['Revenue QoQ', deltaHtml(s.qrev, 0)], ['Profit QoQ', deltaHtml(s.qnp, 0)], ['Revenue YoY', deltaHtml(s.yrev, 0)], ['Profit YoY', deltaHtml(s.ynp, 0)],
        ['Promoter holding', esc(s.promo || '–')], ['FII activity', esc(s.fii || '–')], ['OPM YoY', esc(s.opmy || '–')], ['OPM QoQ', esc(s.opmq || '–')],
        ['Volume change', deltaHtml(s.volchg, 0)], ['IPO level', esc(s.ipo || '–')]
      ];
      h += '<dl class="kv">' + kv.map(function (p) { return '<div><dt>' + p[0] + '</dt><dd>' + p[1] + '</dd></div>'; }).join('') + '</dl>';
    }
    h += '<div class="links"><a class="btn" target="_blank" rel="noopener" href="' + screenerUrl(sym) + '">Screener.in ↗</a>' +
      '<a class="btn" target="_blank" rel="noopener" href="' + chartUrl(sym) + '">Chart ↗</a></div>';
    body.innerHTML = h;
    var dr = $('#drawer');
    dr.hidden = false;
    dr._opener = opener || document.activeElement;
    document.body.style.overflow = 'hidden';
    $('.drawer-x', dr).focus();
  }
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
      var left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x + 12));
      var top = y - r.height - 12;
      if (top < 8) top = y + 16;
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    }
    document.addEventListener('pointermove', function (e) {
      var el = e.target.closest && e.target.closest('[data-tip]');
      if (el) show(el, e.clientX, e.clientY); else tip.hidden = true;
    });
    document.addEventListener('focusin', function (e) {
      var el = e.target.closest && e.target.closest('[data-tip]');
      if (el) { var r = el.getBoundingClientRect(); show(el, r.left + r.width / 2, r.top); } else tip.hidden = true;
    });
    document.addEventListener('scroll', function () { tip.hidden = true; }, true);
  }

  // ---------- routing ----------
  var TABS = ['overview', 'watchlist', 'results', 'signals', 'alerts', 'markets'];
  function route() {
    var tab = (location.hash || '#overview').slice(1);
    if (TABS.indexOf(tab) < 0) tab = 'overview';
    document.querySelectorAll('.tabs a').forEach(function (a) {
      if (a.getAttribute('data-tab') === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    var app = $('#app');
    app.innerHTML = '';
    try {
      pages[tab](app);
    } catch (err) {
      app.innerHTML = '<p class="empty">This section could not be shown: ' + esc(err.message) + '</p>';
      if (window.console) console.error(err);
    }
    var cur = document.querySelector('.tabs a[aria-current]');
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    document.title = (tab === 'overview' ? '' : (cur ? cur.textContent + ' · ' : '')) + 'Stock Blueprint';
  }

  function setUpdated() {
    var when = D.asOf || D.generated;
    $('#updated').textContent = (LIVE ? 'Live · ' : 'Snapshot · ') + 'data as of ' + F.dateTime(when);
  }

  function initTheme() {
    $('#theme').addEventListener('click', function () {
      var root = document.documentElement;
      var cur = root.getAttribute('data-theme') ||
        (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      var next = cur === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('sb-theme', next); } catch (e) {}
    });
  }

  function start(data) {
    prepare(data);
    setUpdated();
    route();
  }

  document.addEventListener('click', function (e) {
    var s = e.target.closest('[data-sym]');
    if (s) { e.preventDefault(); openStock(s.getAttribute('data-sym'), s); return; }
    if (e.target.closest('[data-close]')) closeDrawer();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeDrawer();
    if (e.key === 'Tab' && !$('#drawer').hidden) {           // keep focus inside the open drawer
      var f = $('#drawer .drawer-panel').querySelectorAll('button, a[href]');
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  window.addEventListener('hashchange', function () { closeDrawer(); route(); $('#app').focus({ preventScroll: true }); window.scrollTo(0, 0); });

  initTheme();
  initTip();

  var cfg = window.SB_CONFIG || {};
  if (cfg.liveUrl) {
    var ctl = window.AbortController ? new AbortController() : null;
    var to = setTimeout(function () { if (ctl) ctl.abort(); }, 15000);
    fetch(cfg.liveUrl, { signal: ctl ? ctl.signal : undefined, cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { clearTimeout(to); if (!j || !j.main) throw new Error('bad data'); LIVE = true; start(j); })
      .catch(function (err) {
        clearTimeout(to);
        if (window.console) console.warn('Live data unavailable, showing snapshot:', err);
        if (window.SB_DATA) start(window.SB_DATA); else $('#app').innerHTML = '<p class="empty">Could not load data.</p>';
      });
  } else if (window.SB_DATA) {
    start(window.SB_DATA);
  } else {
    $('#app').innerHTML = '<p class="empty">No data file found (data/dashboard.js). Run tools/export_xlsx.py first.</p>';
  }
})();
