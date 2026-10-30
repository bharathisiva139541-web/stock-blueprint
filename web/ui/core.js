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
    // the ☆ (add to one of the viewer's watchlists) comes from web/ui/watchlists.js
    var star = !opts.noStar && SB.wlStar ? SB.wlStar(sym) : '';
    return '<div class="stock">' + (opts.noLogo ? '' : logoHtml(sym)) + '<div class="txt"><span class="sym-line"><button type="button" class="linkish" data-sym="' +
      esc(sym) + '">' + esc(sym) + '</button>' + star + '</span>' + (name ? '<span class="co" title="' + esc(name) + '">' + esc(name) + '</span>' : '') + '</div></div>';
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

  // ---------- generic sortable / filterable / paged table ----------
  // columns: {key, label, type: text|num|pct|price|date|datetime|badge|sym, get(row), html(row), wrap, digits, name, title}
  // Click a heading = sort by that column; Shift+click = add it as the next sort level.
  // "Sort & filter" (above the table): several sort levels and several conditions
  // ("Result day ≥ 10" AND "Verdict is Strong"...). A text column with few values
  // (Verdict, OPM QoQ...) offers them as ticks: "is" = any ticked value, "is not" =
  // none of them (filter.a is then an array). Kept per table in this browser
  // (ui.store 'tbl:<page>|<columns>'); opts.tools false hides the button.
  var tableSeq = 0;
  var OPS = {
    num: [['ge', '≥'], ['le', '≤'], ['between', 'between'], ['eq', '='], ['blank', 'is empty'], ['notblank', 'is not empty']],
    date: [['onafter', 'on or after'], ['onbefore', 'on or before'], ['between', 'between'], ['blank', 'is empty'], ['notblank', 'is not empty']],
    text: [['is', 'is'], ['isnot', 'is not'], ['contains', 'contains'], ['blank', 'is empty'], ['notblank', 'is not empty']]
  };
  function colKind(c) { return /^(num|pct|price)$/.test(c.type) ? 'num' : /^(date|datetime)$/.test(c.type) ? 'date' : 'text'; }
  function strHash(s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
  function Table(opts) {
    this.o = opts;
    this.rows = opts.rows || [];
    this.page = 0;
    this.size = opts.pageSize || 50;
    this.sorts = opts.sort ? [{ key: opts.sort.key, dir: opts.sort.dir }] : [];
    this.sort = this.sorts[0] || null;          // the first level (kept for older callers)
    this.filters = [];                          // [{ key, op, a, b }]
    this.id = 't' + (++tableSeq);
    this.open = false;
  }
  Table.prototype.val = function (c, r) { return c.get ? c.get(r) : r[c.key]; };
  Table.prototype.col = function (k) { return this.o.columns.filter(function (x) { return x.key === k; })[0] || null; };
  Table.prototype.shown = function () { return this.o.columns.filter(function (c) { return !c.csvOnly && c.label; }); };
  Table.prototype.setRows = function (rows) { this.rows = rows; this.page = 0; this.draw(); };
  /** One condition: true when the row passes (a condition still being typed passes). */
  Table.prototype.test = function (f, r) {
    var c = this.col(f.key);
    if (!c) return true;
    var k = colKind(c), v = this.val(c, r);
    var empty = v == null || v === '' || (k === 'num' && !isNum(v));
    if (f.op === 'blank') return empty;
    if (f.op === 'notblank') return !empty;
    if (Array.isArray(f.a)) {                   // ticked values: any of them ("is") / none of them ("is not")
      if (!f.a.length) return true;
      if (empty) return false;
      var sv = String(v).toLowerCase();
      var hit = f.a.some(function (q) { return String(q).toLowerCase() === sv; });
      return f.op === 'isnot' ? !hit : hit;
    }
    var a = f.a == null ? '' : String(f.a).trim(), b = f.b == null ? '' : String(f.b).trim();
    if (a === '' && (f.op !== 'between' || b === '')) return true;
    if (empty) return false;
    if (k === 'num') {
      var x = Number(a), y = Number(b);
      if (f.op === 'ge') return v >= x;
      if (f.op === 'le') return v <= x;
      if (f.op === 'eq') return Math.abs(v - x) < 1e-9;
      if (f.op === 'between') {
        var lo = a === '' ? -Infinity : x, hi = b === '' ? Infinity : y;
        return v >= Math.min(lo, hi) && v <= Math.max(lo, hi);
      }
      return true;
    }
    if (k === 'date') {
      var d = String(v).slice(0, 10);
      if (f.op === 'onafter') return d >= a;
      if (f.op === 'onbefore') return d <= a;
      if (f.op === 'between') return (a === '' || d >= (b === '' || a <= b ? a : b)) && (b === '' || d <= (a === '' || a <= b ? b : a));
      return true;
    }
    var s = String(v).toLowerCase(), q = a.toLowerCase();
    if (f.op === 'is') return s === q;
    if (f.op === 'isnot') return s !== q;
    return s.indexOf(q) >= 0;
  };
  Table.prototype.filtered = function () {
    var self = this, fs = this.filters.filter(function (f) { return self.col(f.key); });
    if (!fs.length) return this.rows;
    return this.rows.filter(function (r) { for (var i = 0; i < fs.length; i++) if (!self.test(fs[i], r)) return false; return true; });
  };
  Table.prototype.sorted = function () {
    var self = this, rows = this.filtered();
    var lv = this.sorts.map(function (s) { var c = self.col(s.key); return c ? { c: c, dir: s.dir, num: /^(num|pct|price)$/.test(c.type) } : null; }).filter(Boolean);
    if (!lv.length) return rows;
    return rows.slice().sort(function (a, b) {
      for (var i = 0; i < lv.length; i++) {
        var L = lv[i], x = self.val(L.c, a), y = self.val(L.c, b);
        var xe = x == null || x === '' || (L.num && !isNum(x)), ye = y == null || y === '' || (L.num && !isNum(y));
        if (xe && ye) continue;
        if (xe) return 1;                       // blanks always last
        if (ye) return -1;
        var r = L.num ? (x - y) * L.dir : String(x).localeCompare(String(y), 'en', { numeric: true }) * L.dir;
        if (r) return r;
      }
      return 0;
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
  // ----- saved sort & filter (per table, this browser) -----
  Table.prototype.storeKey = function () {
    var page = String(location.hash || '#').replace(/^#/, '').split('/')[0] || 'overview';
    return 'tbl:' + (this.o.id || page + '|' + strHash(this.o.columns.map(function (c) { return c.key; }).join(',')));
  };
  Table.prototype.load = function () {
    if (this.o.tools === false) return;
    var self = this, st = store.get(this.storeKey(), null);
    if (!st || typeof st !== 'object') return;
    var ok = function (k) { var c = self.col(k); return c && !c.csvOnly && c.label; };
    if (Array.isArray(st.s) && st.s.length) {
      var s = st.s.filter(function (x) { return x && ok(x.key); }).map(function (x) { return { key: x.key, dir: x.dir < 0 ? -1 : 1 }; });
      if (s.length) this.sorts = s;
    }
    if (Array.isArray(st.f)) {
      this.filters = st.f.filter(function (x) { return x && ok(x.key) && OPS[colKind(self.col(x.key))].some(function (o) { return o[0] === x.op; }); })
        .map(function (x) {
          var a = Array.isArray(x.a) ? x.a.filter(function (v) { return v != null && v !== ''; }).map(String).slice(0, 60) : x.a == null ? '' : String(x.a);
          return { key: x.key, op: x.op, a: a, b: x.b == null ? '' : String(x.b) };
        });
    }
    this.sort = this.sorts[0] || null;
  };
  Table.prototype.save = function () {
    this.sort = this.sorts[0] || null;
    if (this.o.tools === false) return;
    store.set(this.storeKey(), { s: this.sorts, f: this.filters });
  };
  Table.prototype.mount = function (host) {
    this.host = host;
    var self = this;
    host.__sbTable = this;                       // re-mounting on the same host: only the newest table reacts
    host.innerHTML = '<div class="tbl-tools"></div><div class="tbl-panel" id="' + this.id + '-panel" hidden></div><div class="tbl-body"></div>';
    this.toolsEl = host.querySelector('.tbl-tools');
    this.panelEl = host.querySelector('.tbl-panel');
    this.bodyEl = host.querySelector('.tbl-body');
    this.load();
    host.addEventListener('click', function (e) {
      if (host.__sbTable !== self) return;
      var th = e.target.closest('th[data-k]');
      if (th) { self.toggleSort(th.getAttribute('data-k'), e.shiftKey); return; }
      var pb = e.target.closest('[data-page]');
      if (pb) {
        var dir = pb.getAttribute('data-page');
        self.page += +dir;
        self.draw();
        var b = host.querySelector('[data-page="' + dir + '"]:not([disabled])') || host.querySelector('[data-page]:not([disabled])');
        if (b) b.focus();
        return;
      }
      var t = e.target.closest('[data-tt]');
      if (t) self.tool(t.getAttribute('data-tt'));
    });
    host.addEventListener('keydown', function (e) {
      if (host.__sbTable !== self) return;
      var th = e.target.closest('th[data-k]');
      if (th && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); self.toggleSort(th.getAttribute('data-k'), e.shiftKey); }
    });
    host.addEventListener('change', function (e) {
      if (host.__sbTable !== self) return;
      var x = e.target.closest('[data-tp]');
      if (!x) return;
      var p = x.getAttribute('data-tp').split(':'), i = +p[1], f = p[2];   // s:<i>:key|dir  f:<i>:key|op|a|b
      if (p[0] === 's') {
        var lv = self.sorts[i];
        if (!lv) return;
        if (f === 'key') lv.key = x.value; else lv.dir = +x.value;
      } else {
        var fl = self.filters[i];
        if (!fl) return;
        if (f === 'key') {
          fl.key = x.value;
          var ops = OPS[colKind(self.col(fl.key))];
          if (!ops.some(function (o) { return o[0] === fl.op; })) fl.op = ops[0][0];
          fl.a = ''; fl.b = '';
        } else if (f === 'op') {
          fl.op = x.value;
          if (Array.isArray(fl.a) && fl.op !== 'is' && fl.op !== 'isnot') fl.a = fl.a.length === 1 ? fl.a[0] : '';
        } else {                                  // a value: the panel stays as it is
          if (f === 'm') {
            fl.a = Array.prototype.map.call(self.panelEl.querySelectorAll('[data-tp="f:' + i + ':m"]:checked'), function (c) { return c.value; });
          } else fl[f] = x.value;
          self.page = 0; self.save(); self.draw(); return;
        }
      }
      self.page = 0;
      self.save();
      self.drawPanel(x.getAttribute('data-tp'));
      self.draw();
    });
    host.addEventListener('input', function (e) {
      if (host.__sbTable !== self) return;
      var x = e.target.closest('[data-tp]');
      if (!x || x.tagName !== 'INPUT') return;
      var p = x.getAttribute('data-tp').split(':'), fl = self.filters[+p[1]];
      if (p[0] !== 'f' || !fl) return;
      fl[p[2]] = x.value;
      self.page = 0;
      self.save();
      self.draw();
    });
    this.draw();
    return this;
  };
  /** Plain click: sort by this column only (click again = reverse). Shift: add / reverse it as a further level. */
  Table.prototype.toggleSort = function (k, add) {
    var c = this.col(k);
    var first = c && /^(num|pct|price|date|datetime)$/.test(c.type) ? -1 : 1;
    var at = -1;
    this.sorts.forEach(function (s, i) { if (s.key === k) at = i; });
    if (add) {
      if (at >= 0) this.sorts[at].dir = -this.sorts[at].dir;
      else this.sorts.push({ key: k, dir: first });
    } else if (at === 0 && this.sorts.length === 1) this.sorts[0].dir = -this.sorts[0].dir;
    else this.sorts = [{ key: k, dir: at >= 0 ? -this.sorts[at].dir : first }];
    this.page = 0;
    this.save();
    if (this.open) this.drawPanel();
    this.draw();
    var th = this.host.querySelector('th[data-k="' + k + '"]');
    if (th) th.focus();
  };
  Table.prototype.tool = function (what) {
    var cols = this.shown();
    if (what === 'toggle') {
      this.open = !this.open;
      this.drawPanel();
      this.drawTools();
      var f = this.open ? this.panelEl.querySelector('select, input, button') : this.toolsEl.querySelector('[data-tt="toggle"]');
      if (f) f.focus();
      return;
    }
    if (what === 'addsort') {
      var used = this.sorts.map(function (s) { return s.key; });
      var c = cols.filter(function (x) { return used.indexOf(x.key) < 0; })[0] || cols[0];
      this.sorts.push({ key: c.key, dir: /^(num|pct|price|date|datetime)$/.test(c.type) ? -1 : 1 });
    } else if (what === 'addfilter') {
      var c2 = cols.filter(function (x) { return colKind(x) === 'num'; })[0] || cols[0];
      this.filters.push({ key: c2.key, op: OPS[colKind(c2)][0][0], a: '', b: '' });
    } else if (/^rm[sf]:/.test(what)) {
      var i = +what.split(':')[1];
      (what.charAt(2) === 's' ? this.sorts : this.filters).splice(i, 1);
    } else if (what === 'clear') {
      this.sorts = this.o.sort ? [{ key: this.o.sort.key, dir: this.o.sort.dir }] : [];
      this.filters = [];
    } else if (what === 'done') {
      this.open = false;
      this.drawPanel();
      this.drawTools();
      var t = this.toolsEl.querySelector('[data-tt="toggle"]');
      if (t) t.focus();
      return;
    } else return;
    this.page = 0;
    this.save();
    this.drawPanel();
    this.draw();
    var focus = what === 'addsort' ? '[data-tp="s:' + (this.sorts.length - 1) + ':key"]' : what === 'addfilter' ? '[data-tp="f:' + (this.filters.length - 1) + ':key"]' : null;
    var el = focus ? this.panelEl.querySelector(focus) : this.toolsEl.querySelector('[data-tt="toggle"]');
    if (el) el.focus();
  };
  Table.prototype.summary = function () {
    var self = this, parts = [];
    var name = function (k) { var c = self.col(k); return c ? c.label : k; };
    if (this.sorts.length) {
      parts.push('Sorted by ' + this.sorts.map(function (s) { return name(s.key) + (s.dir > 0 ? ' ↑' : ' ↓'); }).join(', then '));
    }
    var fs = this.filters.filter(function (f) { return f.op === 'blank' || f.op === 'notblank' || String(f.a || '') !== '' || String(f.b || '') !== ''; });
    if (fs.length) {
      parts.push(fs.map(function (f) {
        var op = (OPS[colKind(self.col(f.key))].filter(function (o) { return o[0] === f.op; })[0] || ['', f.op])[1];
        var a = Array.isArray(f.a) ? f.a.join(f.op === 'isnot' ? ', ' : ' or ') : f.a;
        return name(f.key) + ' ' + op + (f.op === 'blank' || f.op === 'notblank' ? '' : ' ' + (a || '…') + (f.op === 'between' ? ' and ' + (f.b || '…') : ''));
      }).join(' · '));
    }
    return { text: parts.join(' · '), filters: fs.length };
  };
  Table.prototype.drawTools = function () {
    if (!this.toolsEl) return;
    var sm = this.summary(), n = this.filtered().length;
    var active = this.sorts.length > 1 || sm.filters > 0;
    if (this.o.tools === false || (!active && !this.open && this.rows.length <= 5)) { this.toolsEl.innerHTML = ''; return; }
    this.toolsEl.innerHTML = '<button type="button" class="chip tbl-tbtn" data-tt="toggle" aria-expanded="' + this.open + '" aria-controls="' + this.id + '-panel"' +
      (active ? ' aria-pressed="true"' : '') + '>⇅ Sort &amp; filter' + (sm.filters ? ' (' + sm.filters + ')' : '') + '</button>' +
      (active ? '<span class="tbl-sum">' + esc(sm.text) + (sm.filters ? ' · <b>' + n.toLocaleString('en-IN') + ' of ' + this.rows.length.toLocaleString('en-IN') + ' rows</b>' : '') +
        ' <button type="button" class="linkish tbl-clear" data-tt="clear">Clear</button></span>' : '');
  };
  Table.prototype.drawPanel = function (focusTp) {
    if (!this.panelEl) return;
    if (!this.open) { this.panelEl.hidden = true; this.panelEl.innerHTML = ''; return; }
    var self = this, cols = this.shown();
    var colSel = function (tp, cur, kinds) {
      return '<select class="sel" data-tp="' + tp + '" aria-label="Column">' + cols.filter(function (c) { return !kinds || kinds(c); }).map(function (c) {
        return '<option value="' + esc(c.key) + '"' + (c.key === cur ? ' selected' : '') + '>' + esc(c.label) + '</option>';
      }).join('') + '</select>';
    };
    var h = '<div class="tbl-sec"><div class="tbl-h">Sort by</div>';
    this.sorts.forEach(function (s, i) {
      h += '<div class="tbl-row"><span class="tbl-n">' + (i ? 'then' : '') + '</span>' + colSel('s:' + i + ':key', s.key) +
        '<select class="sel" data-tp="s:' + i + ':dir" aria-label="Order"><option value="-1"' + (s.dir < 0 ? ' selected' : '') + '>High → low / Z → A / newest</option>' +
        '<option value="1"' + (s.dir > 0 ? ' selected' : '') + '>Low → high / A → Z / oldest</option></select>' +
        '<button type="button" class="icon-btn" data-tt="rms:' + i + '" aria-label="Remove this sort level">✕</button></div>';
    });
    h += '<button type="button" class="btn" data-tt="addsort">' + (this.sorts.length ? '+ Then by' : '+ Sort by a column') + '</button>' +
      '<p class="sub">Tip: click a column heading to sort by it; Shift+click adds it as the next level.</p></div>';
    h += '<div class="tbl-sec"><div class="tbl-h">Show only rows where <span class="sub">(all conditions must match)</span></div>';
    this.filters.forEach(function (f, i) {
      var c = self.col(f.key), k = colKind(c), ops = OPS[k];
      var vals = [];                              // a text column's values, offered as a choice when there are few
      if (k === 'text') {
        var seen = {};
        self.rows.forEach(function (r) { var v = self.val(c, r); if (v != null && v !== '' && !seen[v] && vals.length <= 50) { seen[v] = 1; vals.push(String(v)); } });
        if (vals.length > 50) vals = [];
      }
      var inp = function (which, val) {
        if (k === 'text' && vals.length && (f.op === 'is' || f.op === 'isnot')) {   // few values (Verdict, OPM QoQ...): tick one or more
          var picked = (Array.isArray(val) ? val : val ? [String(val)] : []).map(function (x) { return String(x).toLowerCase(); });
          return '<div class="tbl-multi" role="group" aria-label="' + esc(c.label) + ' - tick one or more" title="' +
            (f.op === 'isnot' ? 'Rows with none of the ticked values' : 'Rows with any of the ticked values') + '">' +
            vals.slice().sort().map(function (v) {
              return '<label><input type="checkbox" data-tp="f:' + i + ':m" value="' + esc(v) + '"' + (picked.indexOf(v.toLowerCase()) >= 0 ? ' checked' : '') + '> ' + esc(v) + '</label>';
            }).join('') + '</div>';
        }
        var type = k === 'num' ? 'number' : k === 'date' ? 'date' : 'text';
        return '<input class="search tbl-val" type="' + type + '"' + (type === 'number' ? ' step="any"' : '') + ' data-tp="f:' + i + ':' + which + '" value="' + esc(val) + '"' +
          ' aria-label="' + esc(c.label) + (which === 'b' ? ' (to)' : ' value') + '" placeholder="' + (k === 'num' ? (c.type === 'pct' ? 'e.g. 10 (= 10%)' : 'number') : 'value') + '">';
      };
      h += '<div class="tbl-row"><span class="tbl-n">' + (i ? 'and' : '') + '</span>' + colSel('f:' + i + ':key', f.key) +
        '<select class="sel" data-tp="f:' + i + ':op" aria-label="Condition">' + ops.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === f.op ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
        (f.op === 'blank' || f.op === 'notblank' ? '' : inp('a', f.a) + (f.op === 'between' ? '<span class="sub">and</span>' + inp('b', f.b) : '')) +
        '<button type="button" class="icon-btn" data-tt="rmf:' + i + '" aria-label="Remove this condition">✕</button></div>';
    });
    h += '<button type="button" class="btn" data-tt="addfilter">+ Add condition</button></div>' +
      '<div class="tbl-row tbl-end"><button type="button" class="btn" data-tt="clear">Clear all</button><button type="button" class="btn primary" data-tt="done">Done</button>' +
      '<span class="sub">Saved for this table in this browser.</span></div>';
    this.panelEl.innerHTML = h;
    this.panelEl.hidden = false;
    if (focusTp) { var el = this.panelEl.querySelector('[data-tp="' + focusTp + '"]'); if (el) el.focus(); }
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
    var multi = this.sorts.length > 1;
    var h = '<div class="tbl-wrap"><table class="tbl"><thead><tr>';
    cols.forEach(function (c) {
      var at = -1;
      self.sorts.forEach(function (s, i) { if (s.key === c.key) at = i; });
      var srt = at === 0 ? (self.sorts[0].dir > 0 ? 'ascending' : 'descending') : 'none';
      var num = /^(num|pct|price)$/.test(c.type) ? ' class="num"' : '';
      h += '<th scope="col" tabindex="0" data-k="' + esc(c.key) + '" aria-sort="' + srt + '"' + num +
        (c.title ? ' title="' + esc(c.title) + '"' : '') + '>' + esc(c.label) +
        (multi && at >= 0 ? '<span class="tbl-lvl" aria-label="sort level ' + (at + 1) + '">' + (at + 1) + (at > 0 ? (self.sorts[at].dir > 0 ? '↑' : '↓') : '') + '</span>' : '') + '</th>';
    });
    h += '</tr></thead><tbody>';
    var filtered = this.filters.length && rows.length < this.rows.length;
    if (!slice.length) h += '<tr><td class="empty" colspan="' + cols.length + '">' + esc(filtered && !rows.length ? 'No rows match the Sort & filter conditions - change or clear them' : this.o.empty || 'Nothing to show') + '</td></tr>';
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
    (this.bodyEl || this.host).innerHTML = h;
    this.drawTools();
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
