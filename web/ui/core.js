/* Shared UI helpers for all pages (browser only).
   window.SB.ui = { esc, F, deltaHtml, badge, stockCell, logoHtml, Table, bars,
                    lineChart, tile, card, chips, bindChips, textMatch, store,
                    download, stateBadge, leastFresh, skeleton, objRows } */
(function () {
  'use strict';
  var SB = window.SB = window.SB || {};

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
  function parseDate(v) {
    if (!v) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(v));
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  }
  function iso(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function dayDiff(a, b) {
    var x = new Date(a.getFullYear(), a.getMonth(), a.getDate()), y = new Date(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.round((x - y) / 864e5);
  }

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
      var k = d == null ? 1 : d;
      var s = Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: k, maximumFractionDigits: k });
      var shown = Math.round(Math.abs(v) * Math.pow(10, k));          // what is displayed, so tiny values get no sign
      return (shown && v > 0 ? '+' : shown && v < 0 ? '−' : '') + s + '%';
    },
    cr: function (v) { return isNum(v) ? Math.round(v).toLocaleString('en-IN') + ' Cr' : '–'; },
    inr: function (v) { return isNum(v) ? '₹' + Math.round(v).toLocaleString('en-IN') : '–'; },
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

  // status text -> badge class (colour never carries meaning alone: the text is always shown)
  var STATUS = {
    buy: 's-good', avoid: 's-bad', hold: 's-warn', sell: 's-bad',
    updated: 's-good', pending: 's-warn', 'gave up': 's-bad',
    win: 's-good', loss: 's-bad', open: 's-info',
    strong: 's-good', mixed: 's-warn', weak: 's-bad',
    untouched: 's-info', 'first touch': 's-warn', mitigated: 's-warn',
    rallied: 's-good', flat: 's-warn', 'sold off': 's-bad', fell: 's-bad',
    qualified: 's-good', breakout: 's-good', pullback: 's-good', watch: 's-info', exit: 's-bad',
    'no signal': '', 'insufficient data': 's-warn', demo: 's-warn',
    live: 's-good', delayed: 's-info', eod: 's-info', cached: 's-warn', unavailable: 's-bad'
  };
  function badge(v, cls) {
    if (v == null || v === '') return '<span class="sub">–</span>';
    var k = String(v).toLowerCase();
    var c = cls != null ? cls : STATUS[k];
    if (c == null) {
      if (/^widened|increas|above|bull/.test(k)) c = 's-good';
      else if (/^narrowed|decreas|below|bear/.test(k)) c = 's-bad';
      else c = '';
    }
    return '<span class="badge ' + c + '">' + esc(v) + '</span>';
  }

  // ---------- logos ----------
  // Only verified mappings from web/data/logos.js (window.SB_LOGOS) are used.
  // Otherwise a neutral monogram is shown - never a guessed logo.
  function monogram(sym) {
    var s = String(sym || '?').replace(/[^A-Z0-9]/gi, '');
    return esc(s.slice(0, 2).toUpperCase() || '?');
  }
  function logoHtml(sym, size) {
    var m = window.SB_LOGOS && window.SB_LOGOS['NSE:' + sym];
    var cls = 'logo' + (size === 'lg' ? ' lg' : '');
    if (m && m.url && m.verified) {
      return '<span class="' + cls + '" data-mono="' + monogram(sym) + '"><img class="logo-img" src="' + esc(m.url) +
        '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"></span>';
    }
    return '<span class="' + cls + '" aria-hidden="true">' + monogram(sym) + '</span>';
  }
  // broken logo image -> monogram
  document.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t.classList && t.classList.contains('logo-img')) {
      var p = t.parentNode;
      if (p) p.textContent = p.getAttribute('data-mono') || '?';
    }
  }, true);

  function stockCell(sym, name, opts) {
    if (!sym) return '–';
    opts = opts || {};
    return '<div class="stock">' + (opts.noLogo ? '' : logoHtml(sym)) + '<div class="txt"><button type="button" class="linkish" data-sym="' +
      esc(sym) + '">' + esc(sym) + '</button>' + (name ? '<span class="co" title="' + esc(name) + '">' + esc(name) + '</span>' : '') + '</div></div>';
  }

  // ---------- data state ----------
  var STATE_HELP = {
    LIVE: 'Real-time from the market data provider during this session',
    DELAYED: 'From a provider with a known delay (e.g. Google Sheet / GOOGLEFINANCE ~20 min)',
    EOD: 'Last completed trading session',
    CACHED: 'Saved copy (snapshot exported from the sheet) - not current',
    UNAVAILABLE: 'No data available'
  };
  // freshness order: a mix of states is described by its least fresh member
  var FRESH = ['LIVE', 'DELAYED', 'EOD', 'CACHED', 'UNAVAILABLE'];
  function leastFresh(states) {
    var worst = -1;
    (states || []).forEach(function (st) { var i = FRESH.indexOf(st || 'UNAVAILABLE'); if (i > worst) worst = i; });
    return worst < 0 ? 'UNAVAILABLE' : FRESH[worst];
  }
  function stateBadge(state, asOf, source) {
    var s = state || 'UNAVAILABLE';
    var cls = { LIVE: 's-good', DELAYED: 's-info', EOD: 's-info', CACHED: 's-warn', UNAVAILABLE: 's-bad' }[s] || '';
    return '<span class="badge ' + cls + '" tabindex="0" data-tip="' + esc(STATE_HELP[s] || s) + (source ? ' · Source: ' + esc(source) : '') + '">' + esc(s) +
      (asOf ? ' · ' + F.dateTime(asOf) : '') + '</span>';
  }

  // ---------- generic sortable / paged table ----------
  // columns: {key, label, type: text|num|pct|price|date|datetime|badge|sym, get(row), html(row), wrap, digits, name, title}
  var tableSeq = 0;
  function Table(opts) {
    this.o = opts;
    this.rows = opts.rows || [];
    this.page = 0;
    this.size = opts.pageSize || 50;
    this.sort = opts.sort || null;
    this.id = 't' + (++tableSeq);
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
      if (xe) return 1;                       // blanks always last
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
      case 'sym': return stockCell(v, c.name ? r[c.name] : null);
      default: return v == null || v === '' ? '<span class="sub">–</span>' : esc(v);
    }
  };
  Table.prototype.mount = function (host) {
    this.host = host;
    var self = this;
    host.__sbTable = this;                       // re-mounting on the same host: only the newest table reacts
    host.addEventListener('click', function (e) {
      if (host.__sbTable !== self) return;
      var th = e.target.closest('th[data-k]');
      if (th) { self.toggleSort(th.getAttribute('data-k')); return; }
      var pb = e.target.closest('[data-page]');
      if (pb) {
        var dir = pb.getAttribute('data-page');
        self.page += +dir;
        self.draw();
        var b = host.querySelector('[data-page="' + dir + '"]:not([disabled])') || host.querySelector('[data-page]:not([disabled])');
        if (b) b.focus();
      }
    });
    host.addEventListener('keydown', function (e) {
      if (host.__sbTable !== self) return;
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
  Table.prototype.visibleRows = function () { return this.sorted(); };
  Table.prototype.toCsvRows = function () {
    var self = this, cols = this.o.columns.filter(function (c) { return !c.noExport; });
    var out = [cols.map(function (c) { return c.label; })];
    this.sorted().forEach(function (r) {
      out.push(cols.map(function (c) { var v = c.csv ? c.csv(r) : self.val(c, r); return v == null ? '' : v; }));
    });
    return out;
  };
  Table.prototype.draw = function () {
    if (!this.host) return;
    var self = this, rows = this.sorted();
    var cols = this.o.columns.filter(function (c) { return !c.csvOnly; });   // csvOnly columns are export-only
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
    if (!slice.length) h += '<tr><td class="empty" colspan="' + cols.length + '">' + esc(this.o.empty || 'Nothing to show') + '</td></tr>';
    slice.forEach(function (r) {
      h += '<tr>';
      cols.forEach(function (c) {
        var cls = /^(num|pct|price)$/.test(c.type) ? 'num' : c.wrap ? 'wrap' : '';
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

  // ---------- horizontal bar chart (single series) ----------
  // items: [{label, value, tip, href}], opts: {diverging, fmt}
  function bars(items, opts) {
    opts = opts || {};
    var fmt = opts.fmt || function (v) { return F.num(v, 0); };
    var max = Math.max.apply(null, items.map(function (i) { return Math.abs(i.value) || 0; }).concat([1e-9]));
    var h = '<div class="bars" role="list">';
    items.forEach(function (it) {
      var v = isNum(it.value) ? it.value : 0, w = Math.abs(v) / max;
      var bar;
      if (opts.diverging) {
        bar = '<div class="bar-track div"><div class="bar ' + (v < 0 ? 'neg' : 'pos') + '" style="' +
          (v < 0 ? 'right:50%;' : 'left:50%;') + 'width:' + (w * 50).toFixed(2) + '%"></div></div>';
      } else {
        bar = '<div class="bar-track"><div class="bar pos" style="left:0;width:' + Math.max(w * 100, v ? 1 : 0).toFixed(2) + '%"></div></div>';
      }
      var tag = it.href ? 'a' : 'div';
      h += '<' + tag + (it.href ? ' href="' + esc(it.href) + '"' : '') + ' class="bar-row" role="listitem" tabindex="0" data-tip="' +
        esc(it.tip || (it.label + ': ' + fmt(v))) + '">' +
        '<span class="bar-label" title="' + esc(it.label) + '">' + esc(it.label) + '</span>' + bar +
        '<span class="bar-val">' + (isNum(it.value) ? fmt(v) : '–') + '</span></' + tag + '>';
    });
    return h + '</div>';
  }

  // ---------- SVG line chart with hover crosshair ----------
  // series: [{name, points:[{x:'YYYY-MM-DD', y:number}], color}], opts: {height, fmt, zeroLine}
  function lineChart(host, series, opts) {
    opts = opts || {};
    // drawn at the container's width so labels keep their size on phones
    var W = Math.max(300, Math.round(host.clientWidth || 760)), H = opts.height || 220, P = { l: 52, r: 12, t: 10, b: 24 };
    var all = [];
    series.forEach(function (s) { s.points.forEach(function (p) { if (isNum(p.y)) all.push(p); }); });
    if (!all.length) { host.innerHTML = '<p class="empty">No data to chart</p>'; return; }
    var xs = series[0].points.map(function (p) { return p.x; });
    var ymin = Math.min.apply(null, all.map(function (p) { return p.y; }));
    var ymax = Math.max.apply(null, all.map(function (p) { return p.y; }));
    if (opts.zeroLine) { ymin = Math.min(ymin, 0); ymax = Math.max(ymax, 0); }
    if (ymin === ymax) { ymin -= 1; ymax += 1; }
    var pad = (ymax - ymin) * 0.06; ymin -= pad; ymax += pad;
    var fmt = opts.fmt || function (v) { return F.num(v, 0); };
    function X(i) { return P.l + (xs.length < 2 ? 0 : i * (W - P.l - P.r) / (xs.length - 1)); }
    function Y(v) { return P.t + (ymax - v) * (H - P.t - P.b) / (ymax - ymin); }
    var svg = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(opts.label || 'Line chart') + '">';
    for (var g = 0; g <= 4; g++) {
      var v = ymin + (ymax - ymin) * g / 4, y = Y(v);
      svg += '<line class="grid-line" x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '"/>' +
        '<text x="' + (P.l - 6) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end">' + esc(fmt(v)) + '</text>';
    }
    var ticks = Math.min(6, xs.length);
    for (var t = 0; t < ticks; t++) {
      var i = Math.round(t * (xs.length - 1) / Math.max(1, ticks - 1));
      svg += '<text x="' + X(i).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="' + (t === ticks - 1 && ticks > 1 ? 'end' : t === 0 && P.l < 30 ? 'start' : 'middle') + '">' + esc(F.date(xs[i]).replace(/ \d{4}$/, '')) + '</text>';
    }
    if (opts.zeroLine) svg += '<line class="axis" x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + Y(0).toFixed(1) + '" y2="' + Y(0).toFixed(1) + '"/>';
    series.forEach(function (s) {
      var d = '';
      s.points.forEach(function (p, i) { if (isNum(p.y)) d += (d ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(p.y).toFixed(1); });
      svg += '<path d="' + d + '" fill="none" stroke="' + (s.color || 'var(--bar)') + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
    });
    svg += '<line class="xhair" x1="0" x2="0" y1="' + P.t + '" y2="' + (H - P.b) + '" stroke="var(--border-strong)" visibility="hidden"/>';
    svg += '<rect x="' + P.l + '" y="' + P.t + '" width="' + (W - P.l - P.r) + '" height="' + (H - P.t - P.b) + '" fill="transparent" class="hit"/></svg>';
    var legend = series.length > 1 ? '<div class="legend">' + series.map(function (s) {
      return '<span><i style="background:' + (s.color || 'var(--bar)') + '"></i>' + esc(s.name) + '</span>';
    }).join('') + '</div>' : '';
    host.innerHTML = svg + legend;
    var el = host.querySelector('svg'), hit = host.querySelector('.hit'), xh = host.querySelector('.xhair'), tip = $('#tip');
    hit.addEventListener('pointermove', function (e) {
      var r = el.getBoundingClientRect();
      var px = (e.clientX - r.left) * W / r.width;
      var i = Math.max(0, Math.min(xs.length - 1, Math.round((px - P.l) * (xs.length - 1) / (W - P.l - P.r))));
      xh.setAttribute('x1', X(i)); xh.setAttribute('x2', X(i)); xh.setAttribute('visibility', 'visible');
      tip.textContent = F.date(xs[i]) + ' · ' + series.map(function (s) { var p = s.points[i]; return s.name + ': ' + (p && isNum(p.y) ? fmt(p.y) : '–'); }).join(' · ');
      tip.hidden = false;
      tip.style.left = Math.min(window.innerWidth - 290, e.clientX + 12) + 'px';
      tip.style.top = (e.clientY - 40) + 'px';
    });
    hit.addEventListener('pointerleave', function () { xh.setAttribute('visibility', 'hidden'); tip.hidden = true; });
  }

  function tile(label, value, note, cls) {
    return '<div class="tile' + (cls ? ' ' + cls : '') + '"><div class="label">' + esc(label) + '</div>' +
      '<div class="value">' + value + '</div>' + (note ? '<div class="note2">' + note + '</div>' : '') + '</div>';
  }
  function card(title, sub, body, attrs) {
    return '<section class="card"' + (attrs || '') + '><div class="card-head"><div><h2>' + esc(title) + '</h2>' +
      (sub ? '<p>' + sub + '</p>' : '') + '</div></div>' + body + '</section>';
  }
  function chips(name, options, current) {
    return '<div class="chips" role="group" aria-label="' + esc(name) + '">' + options.map(function (o) {
      return '<button type="button" class="chip" data-chip="' + esc(name) + '" data-v="' + esc(o[0]) + '" aria-pressed="' +
        (String(o[0]) === String(current)) + '">' + esc(o[1]) + '</button>';
    }).join('') + '</div>';
  }
  // host must be the page's own element (re-created on every route), so
  // listeners never pile up across visits.
  function bindChips(host, name, fn) {
    host.addEventListener('click', function (e) {
      var b = e.target.closest('[data-chip="' + name + '"]');
      if (!b) return;
      host.querySelectorAll('[data-chip="' + name + '"]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      fn(b.getAttribute('data-v'));
    });
  }
  function textMatch(q, parts) {
    if (!q) return true;
    q = q.toLowerCase();
    for (var i = 0; i < parts.length; i++) if (parts[i] && String(parts[i]).toLowerCase().indexOf(q) >= 0) return true;
    return false;
  }
  function skeleton(n) {
    var h = '<div class="skeleton" aria-busy="true" aria-label="Loading">';
    for (var i = 0; i < (n || 4); i++) h += '<i style="width:' + (60 + (i * 13) % 40) + '%"></i>';
    return h + '</div>';
  }

  // ---------- per-viewer storage (never shared, never sent anywhere) ----------
  var store = {
    get: function (k, def) {
      try { var v = localStorage.getItem('sb:' + k); return v == null ? def : JSON.parse(v); } catch (e) { return def; }
    },
    set: function (k, v) {
      try { localStorage.setItem('sb:' + k, JSON.stringify(v)); return true; } catch (e) { return false; }
    },
    del: function (k) { try { localStorage.removeItem('sb:' + k); } catch (e) { /* ignore */ } }
  };

  function toCsv(rows) {
    return rows.map(function (r) {
      return r.map(function (v) {
        var s = v == null ? '' : String(v);
        return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\r\n');
  }
  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  // load an extra data script once (e.g. data/history.js), resolves when loaded
  var loaded = {};
  function loadScript(src) {
    if (!loaded[src]) {
      loaded[src] = new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = src;
        s.onload = function () { res(true); };
        s.onerror = function () { loaded[src] = null; rej(new Error('Could not load ' + src)); };
        document.head.appendChild(s);
      });
    }
    return loaded[src];
  }

  // page registry (pages load before app.js): SB.page(id, { render(host, params, ctx) })
  SB.pages = SB.pages || {};
  SB.page = function (id, def) { SB.pages[id] = def; };

  SB.ui = {
    $: $, esc: esc, isNum: isNum, objRows: objRows, parseDate: parseDate, iso: iso, dayDiff: dayDiff, F: F,
    deltaHtml: deltaHtml, badge: badge, logoHtml: logoHtml, stockCell: stockCell, stateBadge: stateBadge, leastFresh: leastFresh,
    Table: Table, bars: bars, lineChart: lineChart, tile: tile, card: card, chips: chips, bindChips: bindChips,
    textMatch: textMatch, skeleton: skeleton, store: store, toCsv: toCsv, download: download, loadScript: loadScript
  };
})();
