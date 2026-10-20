/* Alerts & trades (#alerts, nav "Alerts & Trades").
   1. Sheet alerts   - the sheet's public watch alerts (Alert Log snapshot).
   2. My alert rules - the viewer's own rules, checked only while this page is
      open, against snapshot / delayed data (never real-time, never pushed).
   3. Trade journal  - manual records typed in by the viewer, not broker positions.
   4. Risk & position size - settings, position-size calculator, portfolio heat.
   Everything personal lives ONLY in this browser (ui.store -> localStorage):
   'alerts:rules', 'alerts:history', 'journal:v1', 'risk:settings'. Export /
   import as files; nothing is sent anywhere and no order is ever placed.
   Deep links: #alerts/<sheet|rules|journal|risk>[/SYMBOL] (symbol prefills the form). */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, esc = ui.esc, F = ui.F, isNum = ui.isNum, $ = ui.$;

  var K = { rules: 'alerts:rules', hist: 'alerts:history', journal: 'journal:v1', risk: 'risk:settings' };
  var HIST_MAX = 500, FILE_MAX = 2 * 1024 * 1024, AUTO_MS = 60000;
  var SYM_RE = /^[A-Z0-9][A-Z0-9&._-]{0,24}$/, ID_RE = /^[A-Za-z0-9_-]{4,48}$/;
  var TABS = [['sheet', 'Sheet alerts'], ['rules', 'My alert rules'], ['journal', 'Trade journal'], ['risk', 'Risk & position size']];
  var ST = { tab: null, logF: 'all', logType: '', logQ: '', jq: '' };      // remembered between visits
  var TILES = ' style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))"';   // two tiles per row on phones
  var STORE_FAIL = 'Not saved: this browser is blocking site storage or it is full (private window?). Nothing was changed.';
  var DISCLAIMER = 'Alerts are checked only while this page is open, against snapshot/delayed data - they are not real-time and are not pushed to your phone. ' +
    'Your sheet\'s own alerts (Code.gs e-mail / Pushbullet, on its time triggers with ~20-minute delayed GOOGLEFINANCE prices) keep working as before.';

  // ---------- small helpers ----------
  function istNow() { return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 16).replace('T', ' '); }
  function istToday() { return istNow().slice(0, 10); }
  function uid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function pad2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
  function toNum(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    if (v == null) return NaN;
    var s = String(v).replace(/[₹,\s]/g, '').replace(/^−/, '-');
    if (s === '') return NaN;
    var n = Number(s);
    return isFinite(n) ? n : NaN;
  }
  function posOrNull(v) { var n = toNum(v); return n > 0 ? n : null; }
  function nonNeg(v) { var n = toNum(v); return n > 0 ? n : 0; }
  function str(v, max) { return v == null ? '' : String(v).slice(0, max || 200); }
  function plural(n, w) { return F.num(n, 2) + ' ' + w + (n === 1 ? '' : 's'); }
  function normDate(v) {
    if (v == null || v === '') return '';
    var s = String(v).trim(), m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);       // dd/mm/yyyy (sheet style)
    return m ? m[3] + '-' + pad2(m[2]) + '-' + pad2(m[1]) : '';
  }
  function validDate(s) { var d = ui.parseDate(s); return typeof s === 'string' && s.length === 10 && !!d && ui.iso(d) === s; }
  function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : NaN; }
  function total(a) { return a.reduce(function (x, y) { return x + y; }, 0); }
  function inrS(v) {
    if (!isNum(v)) return '–';
    var r = Math.round(v);
    return (r < 0 ? '−' : r > 0 ? '+' : '') + '₹' + Math.abs(r).toLocaleString('en-IN');
  }
  function pnlHtml(v) {
    if (!isNum(v)) return '<span class="sub">–</span>';
    return '<span class="' + (v >= 0.5 ? 'up' : v <= -0.5 ? 'down' : '') + '">' + inrS(v) + '</span>';
  }
  function rupee(v) { return isNum(v) ? '₹' + F.price(v) : '–'; }
  function val(x) { return x == null || (typeof x === 'number' && !isFinite(x)) ? '' : esc(String(x)); }
  function fieldHtml(label, control, attrs) { return '<label class="field"' + (attrs || '') + '><span>' + esc(label) + '</span>' + control + '</label>'; }
  function numInput(id, value, step, extra) {
    return '<input class="inp" id="' + id + '" type="number" inputmode="decimal" step="' + (step || 'any') + '" min="0" value="' + val(value) + '" style="width:100%"' + (extra || '') + '>';
  }
  function symInput(id, value, ph) {
    return '<input class="inp" id="' + id + '" list="al-syms" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="' +
      esc(ph || 'e.g. SBIN') + '" value="' + val(value) + '" style="width:100%">';
  }
  function listHtml(a) { return '<ul style="margin:4px 0 0 18px;padding:0">' + a.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'; }
  function msg(P, id, cls, html) {
    var box = $('#' + id, P.el);
    if (box) box.innerHTML = html ? '<div class="note' + (cls ? ' ' + cls : '') + '" role="status">' + html + '</div>' : '';
  }
  function fval(P, id) { var x = $('#' + id, P.el); return x ? String(x.value).trim() : ''; }
  // destructive buttons need a second click within 4 s (no native dialogs)
  function confirmTwice(btn, label) {
    if (btn.getAttribute('data-armed') === '1') return true;
    var old = btn.textContent;
    btn.setAttribute('data-armed', '1');
    btn.textContent = label || 'Click again to confirm';
    setTimeout(function () { if (btn.isConnected && btn.getAttribute('data-armed') === '1') { btn.removeAttribute('data-armed'); btn.textContent = old; } }, 4000);
    return false;
  }
  function readFile(file, cb) {
    if (!file) return;
    if (file.size > FILE_MAX) { cb(new Error(file.name + ' is larger than 2 MB - this is not one of this page\'s export files.')); return; }
    var fr = new FileReader();
    fr.onload = function () { cb(null, String(fr.result || '')); };
    fr.onerror = function () { cb(new Error('Could not read ' + file.name)); };
    fr.readAsText(file);
  }
  function stamp() { return istToday(); }
  function stratBadge(source, confirmed) {
    if (source === 'demo') return ui.badge('DEMO', 's-warn');
    return confirmed ? ui.badge('Confirmed by you', 's-good') : ui.badge('Unconfirmed', 's-warn');
  }
  function stratLine(cfg) {
    return esc(cfg.name) + ' · v' + cfg.version + ' ' + stratBadge(cfg.source, SB.strategies.isConfirmed(cfg.id));
  }

  // ---------- rule model ----------
  var RT = {
    priceAbove: { label: 'Price at or above ₹X', field: 'Price X (₹)', help: 'Fires when the current price (sheet snapshot, or a configured provider) is at or above X.' },
    priceBelow: { label: 'Price at or below ₹X', field: 'Price X (₹)', help: 'Fires when the current price is at or below X.' },
    chgUp: { label: '% change today at or above +X%', field: 'X (%)', help: 'Uses today\'s % change from the same price data.' },
    chgDown: { label: '% change today at or below −X%', field: 'X (%)', help: 'Uses today\'s % change; X is entered as a positive number (5 means −5% or lower).' },
    qualified: { label: 'Strategy status becomes Qualified', field: null, help: 'Uses the active strategy from Strategy Settings. Fires when it rates the stock Qualified (or "Matches screen"); after firing it waits until the stock stops being Qualified before it can fire again.' },
    nearStop: { label: 'Near the stop-loss of my journal position', field: 'Within X (%)', help: 'Uses your open trade-journal position in this symbol: fires when the price is within X% of its stop-loss, or past it.' },
    nearTarget: { label: 'Near the target of my journal position', field: 'Within X (%)', help: 'Uses your open trade-journal position in this symbol: fires when the price is within X% of its target, or past it.' },
    resultWithin: { label: 'Result date within N days', field: 'N (days)', help: 'Uses the Result Date from your sheet: fires when the result date is between today and N days ahead.' }
  };
  var RT_ORDER = ['priceAbove', 'priceBelow', 'chgUp', 'chgDown', 'qualified', 'nearStop', 'nearTarget', 'resultWithin'];

  function valueError(type, v) {
    if (!RT[type]) return 'choose a condition';
    if (type === 'qualified') return null;
    if (!isNum(v)) return RT[type].field + ' is required';
    switch (type) {
      case 'priceAbove': case 'priceBelow': return v > 0 ? null : 'the price must be above 0';
      case 'chgUp': case 'chgDown': return v >= 0 && v <= 100 ? null : 'X must be between 0 and 100 (%)';
      case 'nearStop': case 'nearTarget': return v >= 0 && v <= 50 ? null : 'X must be between 0 and 50 (%)';
      case 'resultWithin': return v >= 0 && v <= 90 && Math.floor(v) === v ? null : 'N must be a whole number of days from 0 to 90';
    }
    return 'unknown condition';
  }
  function ruleText(r) {
    var x = r.value;
    switch (r.type) {
      case 'priceAbove': return 'Price at or above ₹' + F.price(x);
      case 'priceBelow': return 'Price at or below ₹' + F.price(x);
      case 'chgUp': return 'Today\'s change at or above +' + F.num(x, 2) + '%';
      case 'chgDown': return 'Today\'s change at or below −' + F.num(x, 2) + '%';
      case 'qualified': return 'Active strategy rates it Qualified';
      case 'nearStop': return 'Within ' + F.num(x, 2) + '% of my journal stop-loss';
      case 'nearTarget': return 'Within ' + F.num(x, 2) + '% of my journal target';
      case 'resultWithin': return 'Result date within ' + plural(x, 'day');
    }
    return String(r.type);
  }
  function cleanRule(r, fallbackId) {
    if (!r || typeof r !== 'object' || !RT[r.type]) return null;
    var sym = String(r.sym || r.symbol || '').trim().toUpperCase();
    if (!SYM_RE.test(sym)) return null;
    var x = r.type === 'qualified' ? null : toNum(r.value);
    if (valueError(r.type, x)) return null;
    return {
      id: ID_RE.test(String(r.id || '')) ? String(r.id) : (fallbackId || uid('r')), sym: sym, type: r.type, value: x,
      mode: r.mode === 'repeat' ? 'repeat' : 'once', enabled: r.enabled !== false, done: !!r.done && r.enabled === false,
      note: str(r.note, 120), createdAt: str(r.createdAt, 20), lastFiredKey: r.lastFiredKey ? str(r.lastFiredKey, 300) : null,
      lastFiredAt: r.lastFiredAt ? str(r.lastFiredAt, 20) : null, fireCount: Math.max(0, parseInt(r.fireCount, 10) || 0), armed: r.armed !== false
    };
  }
  function cleanHist(h) {
    if (!h || typeof h !== 'object' || !h.firedAt) return null;
    var o = {
      id: ID_RE.test(String(h.id || '')) ? String(h.id) : uid('h'), ruleId: str(h.ruleId, 48), sym: str(h.sym, 25).toUpperCase(), type: RT[h.type] ? h.type : '',
      rule: str(h.rule, 200), firedAt: str(h.firedAt, 20), dataKey: str(h.dataKey, 300), dataState: str(h.dataState, 12) || 'UNAVAILABLE',
      dataAsOf: h.dataAsOf ? str(h.dataAsOf, 20) : null, price: isNum(h.price) ? h.price : null, seen: str(h.seen, 300), mode: h.mode === 'repeat' ? 'repeat' : 'once'
    };
    if (h.strategy && typeof h.strategy === 'object') {
      o.strategy = { id: str(h.strategy.id, 40), version: parseInt(h.strategy.version, 10) || 1, name: str(h.strategy.name, 120), source: str(h.strategy.source, 30), confirmed: !!h.strategy.confirmed };
    }
    return o;
  }
  function loadRules() {
    var a = ui.store.get(K.rules, []);
    return (Array.isArray(a) ? a : []).map(function (r, i) { return cleanRule(r, 'rule-legacy-' + i); }).filter(Boolean);
  }
  function saveRules(a) { return ui.store.set(K.rules, a); }
  function loadHist() { var a = ui.store.get(K.hist, []); return (Array.isArray(a) ? a : []).map(cleanHist).filter(Boolean); }
  function saveHist(a) { return ui.store.set(K.hist, a.slice(0, HIST_MAX)); }

  // ---------- journal model ----------
  function cleanSignal(g) {
    if (!g || typeof g !== 'object') return null;
    return {
      strategyId: str(g.strategyId, 40), strategyVersion: parseInt(g.strategyVersion, 10) || null, strategyName: str(g.strategyName, 120),
      source: str(g.source, 30), confirmed: !!g.confirmed, status: str(g.status, 20), statusLabel: str(g.statusLabel, 40), score: isNum(g.score) ? g.score : null,
      scoreNote: str(g.scoreNote, 80), triggersPassed: (Array.isArray(g.triggersPassed) ? g.triggersPassed : []).slice(0, 10).map(function (x) { return str(x, 160); }),
      checks: (Array.isArray(g.checks) ? g.checks : []).slice(0, 30).filter(function (k) { return k && typeof k === 'object'; }).map(function (k) {
        return { group: str(k.group, 12), label: str(k.label, 160), pass: k.pass === true ? true : k.pass === false ? false : null, detail: str(k.detail, 200) };
      }),
      failed: (Array.isArray(g.failed) ? g.failed : []).slice(0, 10).map(function (x) { return str(x, 200); }),
      candlesAsOf: g.candlesAsOf ? str(g.candlesAsOf, 20) : null, priceState: g.priceState ? str(g.priceState, 12) : null,
      priceAsOf: g.priceAsOf ? str(g.priceAsOf, 20) : null, takenAt: g.takenAt ? str(g.takenAt, 20) : null
    };
  }
  /** Normalise one journal record (also tolerates field names other pages read: symbol, entryPrice, stopLoss, exitPrice). */
  function cleanTrade(t, errs, label, fallbackId) {
    function bad(m) { if (errs) errs.push(label + ': ' + m); return null; }
    if (!t || typeof t !== 'object') return bad('not a trade record');
    var sym = String(t.sym || t.symbol || '').trim().toUpperCase();
    if (!SYM_RE.test(sym)) return bad('symbol missing or invalid');
    var entry = toNum(t.entry != null ? t.entry : t.entryPrice), qty = toNum(t.qty != null ? t.qty : t.quantity);
    if (!(entry > 0)) return bad('entry price missing or not above 0');
    if (!(qty > 0)) return bad('quantity missing or not above 0');
    var exit = toNum(t.exit != null && t.exit !== '' ? t.exit : t.exitPrice);
    var closed = t.status === 'closed' || t.closed === true || exit > 0;
    if (closed && !(exit > 0)) return bad('closed trade without an exit price');
    var o = {
      id: ID_RE.test(String(t.id || '')) ? String(t.id) : (fallbackId || uid('t')), sym: sym,
      side: String(t.side || 'long').toLowerCase() === 'short' ? 'short' : 'long',
      entryDate: normDate(t.entryDate || t.date), entry: entry, qty: qty,
      stop: posOrNull(t.stop != null ? t.stop : t.stopLoss != null ? t.stopLoss : t.stoploss), target: posOrNull(t.target),
      fees: nonNeg(t.fees), strategyId: str(t.strategyId, 40), strategyVersion: parseInt(t.strategyVersion, 10) || null,
      strategyName: str(t.strategyName, 120), strategySource: str(t.strategySource, 30), reason: str(t.reason, 1000),
      status: closed ? 'closed' : 'open', closed: closed, createdAt: str(t.createdAt, 20), updatedAt: str(t.updatedAt, 20)
    };
    if (closed) { o.exit = exit; o.exitDate = normDate(t.exitDate); o.exitFees = nonNeg(t.exitFees); o.exitReason = str(t.exitReason, 1000); }
    var sg = cleanSignal(t.signal);
    if (sg) o.signal = sg;
    return o;
  }
  function loadTrades() {
    var j = ui.store.get(K.journal, null);
    var a = Array.isArray(j) ? j : j && Array.isArray(j.trades) ? j.trades : j && Array.isArray(j.entries) ? j.entries : [];
    return a.map(function (t, i) { return cleanTrade(t, null, '', 'trade-legacy-' + i); }).filter(Boolean);
  }
  function saveTrades(a) { return ui.store.set(K.journal, { version: 1, trades: a }); }
  function findTrade(id) { return loadTrades().filter(function (t) { return t.id === id; })[0] || null; }
  function sideSign(t) { return t.side === 'short' ? -1 : 1; }
  /** Computed figures for one trade. Long: P&L = (exit - entry) x qty - fees; short reversed. */
  function calc(t, stock) {
    var sg = sideSign(t), fees = t.fees || 0, o = { cost: t.entry * t.qty };
    o.rpu = t.stop > 0 ? sg * (t.entry - t.stop) : NaN;              // initial risk per share
    o.risk = o.rpu > 0 ? o.rpu * t.qty : t.stop > 0 ? 0 : o.cost;     // no stop -> whole position at risk
    if (t.status === 'closed') {
      o.fees = fees + (t.exitFees || 0);
      o.pnl = sg * (t.exit - t.entry) * t.qty - o.fees;
      o.ret = o.pnl / o.cost * 100;
      o.r = o.rpu > 0 ? sg * (t.exit - t.entry) / o.rpu : NaN;
      var a = ui.parseDate(t.entryDate), b = ui.parseDate(t.exitDate);
      o.days = a && b ? ui.dayDiff(b, a) : NaN;
    } else {
      o.price = stock && isNum(stock.price) ? stock.price : NaN;
      o.state = stock ? stock.priceState || 'UNAVAILABLE' : 'UNAVAILABLE';
      o.asOf = stock ? stock.priceAsOf : null;
      o.upnl = isNum(o.price) ? sg * (o.price - t.entry) * t.qty - fees : NaN;
      o.uret = isNum(o.upnl) ? o.upnl / o.cost * 100 : NaN;
      o.rNow = isNum(o.price) && o.rpu > 0 ? sg * (o.price - t.entry) / o.rpu : NaN;
      var e = ui.parseDate(t.entryDate);
      o.days = e ? ui.dayDiff(ui.parseDate(istToday()), e) : NaN;
    }
    return o;
  }
  function openTrades() { return loadTrades().filter(function (t) { return t.status === 'open'; }); }
  function riskContext(P) {
    var trades = loadTrades(), today = istToday();
    var open = trades.filter(function (t) { return t.status === 'open'; }).map(function (t) {
      var s = P.ctx.bySym[t.sym], c = calc(t, s);
      return { value: c.cost, risk: c.risk, industry: s ? s.catName : 'Unclassified' };
    });
    var todayPnl = total(trades.filter(function (t) { return t.status === 'closed' && t.exitDate === today; }).map(function (t) { return calc(t).pnl; }));
    return { openPositions: open, realizedTodayLoss: Math.max(0, -todayPnl), todayPnl: todayPnl };
  }
  // shared with Overview / Daily suggestions: the journal is read through the same cleaner everywhere
  SB.journal = {
    open: openTrades,
    riskContext: function (ctx) { return riskContext({ ctx: ctx }); },
    portfolio: function (ctx, settings) {
      return SB.risk.portfolioRisk(openTrades().map(function (t) {
        var s = ctx.bySym[t.sym];
        return { entry: t.entry, stop: t.stop, qty: t.qty, side: t.side, industry: s ? s.catName : 'Unclassified' };
      }), settings || loadRisk().s);
    }
  };
  function review(closed) {
    var rows = closed.map(function (t) { var c = calc(t); c.t = t; return c; });
    var wins = rows.filter(function (c) { return c.pnl > 0; }), losses = rows.filter(function (c) { return c.pnl < 0; });
    var gw = total(wins.map(function (c) { return c.pnl; })), gl = -total(losses.map(function (c) { return c.pnl; }));
    var rs = rows.map(function (c) { return c.r; }).filter(isNum);
    var sorted = rows.slice().sort(function (a, b) {
      return String(a.t.exitDate || '').localeCompare(String(b.t.exitDate || '')) || String(a.t.entryDate || '').localeCompare(String(b.t.entryDate || ''));
    });
    var cum = 0, peak = 0, dd = 0, start = sorted.map(function (c) { return c.t.entryDate; }).filter(validDate).sort()[0];
    var curve = [{ x: start || (sorted[0] && sorted[0].t.exitDate) || istToday(), y: 0 }];
    sorted.forEach(function (c) {
      cum += c.pnl; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum);
      curve.push({ x: c.t.exitDate || istToday(), y: cum });
    });
    return {
      n: rows.length, wins: wins.length, losses: losses.length, even: rows.length - wins.length - losses.length,
      winRate: rows.length ? wins.length / rows.length * 100 : NaN,
      avgWin: mean(wins.map(function (c) { return c.ret; })), avgLoss: mean(losses.map(function (c) { return c.ret; })),
      pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : NaN, expectancy: mean(rows.map(function (c) { return c.ret; })),
      avgR: mean(rs), nR: rs.length, maxDD: dd, total: cum, curve: curve
    };
  }

  // ---------- risk settings ----------
  var RISK_FIELDS = [
    ['capital', 'Capital (₹)', 'Account equity every % below is measured on', '1'],
    ['riskPct', 'Risk per trade (% of capital)', 'Up to 10%', 'any'],
    ['maxPositions', 'Max open positions', 'Whole number', '1'],
    ['maxHeatPct', 'Max portfolio heat (%)', 'Total open risk ÷ capital', 'any'],
    ['dailyLossPct', 'Daily loss limit (%)', 'No new trades after this realized loss today', 'any'],
    ['maxExposurePct', 'Max exposure (%)', 'Total position value ÷ capital', 'any'],
    ['maxIndustryPct', 'Max per industry category (%)', '0 = no limit', 'any'],
    ['minRR', 'Minimum reward : risk (1 : x)', 'Warn below this', 'any'],
    ['lotSize', 'Lot size (shares)', '1 for cash equity', '1'],
    ['costPctPerSide', 'Costs % per side', 'Brokerage + taxes + slippage; 0 = not modelled', 'any']
  ];
  function loadRisk() {
    var raw = ui.store.get(K.risk, null), ok = !!raw && typeof raw === 'object' && !Array.isArray(raw);
    return { s: SB.risk.validateSettings(ok ? raw : {}).settings, saved: ok };
  }
  /** Extra page-level checks on top of SB.risk.validateSettings (which only rejects negatives). */
  function checkSettings(o) {
    var e = [];
    if (o.riskPct <= 0) e.push('risk per trade must be above 0%');
    if (o.maxPositions < 1 || Math.floor(o.maxPositions) !== o.maxPositions) e.push('max open positions must be a whole number of at least 1');
    if (o.maxHeatPct <= 0 || o.maxHeatPct > 100) e.push('max portfolio heat must be above 0 and at most 100%');
    if (o.dailyLossPct <= 0 || o.dailyLossPct > 100) e.push('daily loss limit must be above 0 and at most 100%');
    if (o.maxExposurePct <= 0 || o.maxExposurePct > 1000) e.push('max exposure must be above 0% (at most 1000%)');
    if (o.maxIndustryPct > 100) e.push('max per industry category must be 0-100%');
    if (Math.floor(o.lotSize) !== o.lotSize) e.push('lot size must be a whole number');
    if (o.costPctPerSide > 5) e.push('costs per side above 5% look like a typo');
    return e;
  }

  // ---------- strategy run (shared, cached by SB.strategies) ----------
  function ensureRun(P) {
    if (!P.runP) {
      P.runP = SB.strategies.runActive().then(function (run) { P.run = run; P.runErr = null; return run; },
        function (e) { P.runErr = e && e.message ? e.message : String(e); return null; });
    }
    return P.runP;
  }
  function snapshot(P, sym) {
    var run = P.run || SB.strategies.lastRun();
    var r = run && run.bySym[sym];
    if (!r) return null;
    var cfg = run.config, s = P.ctx.bySym[sym];
    return cleanSignal({
      strategyId: cfg.id, strategyVersion: cfg.version, strategyName: cfg.name, source: cfg.source, confirmed: SB.strategies.isConfirmed(cfg.id),
      status: r.status, statusLabel: r.statusLabel, score: r.score, scoreNote: r.scoreNote, triggersPassed: r.triggersPassed,
      checks: (r.checks || []).map(function (k) { return { group: k.group, label: k.label, pass: k.res && k.res.pass, detail: k.res && k.res.detail }; }),
      failed: r.failed, candlesAsOf: r.asOf || run.dataAsOf, priceState: s && s.priceState, priceAsOf: s && s.priceAsOf, takenAt: istNow()
    });
  }
  function sigTip(g) {
    return g.strategyName + ' v' + (g.strategyVersion || '?') + (g.source === 'demo' ? ' (DEMO)' : g.confirmed ? ' (confirmed)' : ' (unconfirmed)') +
      ' · ' + g.statusLabel + (isNum(g.score) ? ' · ' + g.score + '% of rules met' : '') + (g.candlesAsOf ? ' · candles to ' + g.candlesAsOf : '') +
      (g.triggersPassed.length ? ' · signals: ' + g.triggersPassed.join(' + ') : '');
  }
  function sigCell(g) {
    if (!g) return '<span class="sub">–</span>';
    return '<span data-tip="' + esc(sigTip(g)) + '" tabindex="0">' + ui.badge(g.statusLabel || '–') + (isNum(g.score) ? ' <span class="sub">' + g.score + '%</span>' : '') +
      (g.source === 'demo' ? ' ' + ui.badge('DEMO', 's-warn') : '') + '</span>';
  }
  function checksHtml(g) {
    return '<ul class="checks">' + g.checks.map(function (k) {
      var mark = k.pass === true ? '<span class="ok" aria-label="passed">✓</span>' : k.pass === false ? '<span class="no" aria-label="failed">✗</span>' : '<span class="na" aria-label="not applicable">–</span>';
      return '<li>' + mark + '<span>' + esc(k.label) + (k.detail ? ' <span class="sub">(' + esc(k.detail) + ')</span>' : '') + '</span></li>';
    }).join('') + '</ul>';
  }

  // ======================================================================
  // 1. Sheet alerts
  // ======================================================================
  function buildSheet(P) {
    var D = P.ctx.D, host = $('#sec-sheet', P.el), rows = ui.objRows(D.alerts);
    var by = {}, order = [], tot = { total: 0, win: 0, loss: 0, open: 0 };
    rows.forEach(function (r) {
      var k = r['Alert Type'] || 'Unspecified';
      if (!by[k]) { by[k] = { type: k, total: 0, win: 0, loss: 0, open: 0, sum: 0, n: 0 }; order.push(k); }
      var t = by[k], o = String(r.Outcome || '').toLowerCase();
      t.total++; tot.total++;
      if (o === 'win') { t.win++; tot.win++; } else if (o === 'loss') { t.loss++; tot.loss++; } else if (o === 'open') { t.open++; tot.open++; }
      if (isNum(r['% Since Alert'])) { t.sum += r['% Since Alert']; t.n++; }
    });
    var types = order.map(function (k) {
      var t = by[k];
      t.decided = t.win + t.loss; t.hit = t.decided ? t.win / t.decided * 100 : NaN; t.avg = t.n ? t.sum / t.n : NaN;
      return t;
    });
    var decided = tot.win + tot.loss;
    var src = ui.stateBadge('CACHED', D.asOf, 'Alert Log tab of your sheet');
    var h = '<section class="card"><div class="card-head"><div><h2>Sheet watch alerts</h2><p>From your sheet\'s Alert Log: the Price Fall / Breakout levels you set in Main, logged when the close crossed them. ' +
      'Only these public watch alerts are on this site - your personal Entry alerts and trades are deliberately not exported.</p></div><div class="tags">' + src + '</div></div>';
    if (!rows.length) {
      host.innerHTML = h + '<p class="empty">The Alert Log in this snapshot is empty. Alerts appear here after the sheet logs a Price Fall or Breakout level cross and the data is exported again (tools/export_xlsx.py).</p></section>' + gradingHtml();
      return;
    }
    h += '<div class="tiles"' + TILES + '>' +
      ui.tile('Alerts logged', F.int(tot.total), types.map(function (t) { return esc(t.type) + ' ' + t.total; }).join(' · ')) +
      ui.tile('Win', F.int(tot.win), 'price ≥ alert level +10% (sheet setting)') +
      ui.tile('Loss', F.int(tot.loss), 'closed at / below your stop-loss') +
      ui.tile('Open', F.int(tot.open), 'neither yet') +
      ui.tile('Hit rate', decided ? F.num(tot.win / decided * 100, 0) + '%' : '–', 'Win ÷ (Win + Loss) · ' + plural(decided, 'decided alert')) +
      '</div>' + (decided && decided < 10 ? '<p class="sub" style="margin-top:10px">Only ' + plural(decided, 'alert') + ' decided so far - far too few for the hit rate to mean much.</p>' : '') + '</section>';
    h += '<div class="grid g2">' +
      ui.card('By alert type', 'Hit rate = Win ÷ (Win + Loss); Open alerts are not counted in it', '<div id="sa-types"></div>') +
      ui.card('Average % since alert, by type', 'From the alert level to the price at the sheet\'s last refresh',
        ui.bars(types.map(function (t) {
          return { label: t.type, value: t.avg, tip: t.type + ': average ' + F.pct(t.avg, 2) + ' since the alert level across ' + plural(t.n, 'alert') };
        }), { diverging: true, fmt: function (x) { return F.pct(x, 2); } }) +
        '<div class="legend"><span><i style="background:var(--bar)"></i>Above the alert level</span><span><i style="background:var(--bar-neg)"></i>Below the alert level</span></div>') +
      '</div>';
    h += gradingHtml();
    h += '<section class="card"><div class="card-head"><div><h2>Alert log</h2><p>Latest price, % since alert, days and outcome are as of the sheet\'s refresh at ' + esc(F.dateTime(D.asOf)) + '.</p></div></div>' +
      '<div class="controls"><input class="search" id="sa-q" type="search" placeholder="Search symbol, company, pattern or FVG tag" aria-label="Search sheet alerts" value="' + val(ST.logQ) + '">' +
      '<select class="sel" id="sa-type" aria-label="Alert type"><option value="">All types</option>' + types.map(function (t) {
        return '<option value="' + esc(t.type) + '"' + (ST.logType === t.type ? ' selected' : '') + '>' + esc(t.type) + ' (' + t.total + ')</option>';
      }).join('') + '</select><button class="btn" type="button" data-act="sa-csv">Export CSV</button></div>' +
      '<div class="controls">' + ui.chips('sa-out', [['all', 'All (' + tot.total + ')'], ['Open', 'Open (' + tot.open + ')'], ['Win', 'Win (' + tot.win + ')'], ['Loss', 'Loss (' + tot.loss + ')']], ST.logF) +
      '<span class="count" id="sa-count"></span></div><div id="sa-log"></div></section>';
    host.innerHTML = h;

    new ui.Table({
      rows: types, pageSize: 20, sort: { key: 'total', dir: -1 },
      columns: [
        { key: 'type', label: 'Type' },
        { key: 'total', label: 'Alerts', type: 'num', digits: 0 },
        { key: 'win', label: 'Win', type: 'num', digits: 0 },
        { key: 'loss', label: 'Loss', type: 'num', digits: 0 },
        { key: 'open', label: 'Open', type: 'num', digits: 0 },
        { key: 'hit', label: 'Hit rate', type: 'num', title: 'Win ÷ (Win + Loss)', html: function (t) { return isNum(t.hit) ? F.num(t.hit, 0) + '% <span class="sub">of ' + t.decided + '</span>' : '<span class="sub">none decided</span>'; } },
        { key: 'avg', label: 'Avg since alert', type: 'pct', digits: 2 }
      ]
    }).mount($('#sa-types', host));

    P.sheetLog = new ui.Table({
      rows: [], pageSize: 25, sort: { key: 'Date', dir: -1 }, empty: 'No sheet alerts match these filters - clear the search or choose "All".',
      columns: [
        { key: 'Date', label: 'Alerted', type: 'datetime' },
        { key: 'Symbol', label: 'Stock', type: 'sym', name: 'Company' },
        { key: 'Company', label: 'Company', csvOnly: true },
        { key: 'Alert Type', label: 'Type' },
        { key: 'Alert Level', label: 'Alert level', type: 'price', title: 'The level you set in Main' },
        { key: 'Trigger Price', label: 'Trigger price', type: 'price', title: 'Price when the alert fired' },
        { key: 'Current Price', label: 'Latest price', type: 'price', title: 'Price at the sheet\'s last refresh' },
        { key: '% Since Alert', label: 'Since alert', type: 'pct', digits: 2, title: 'Latest price vs the alert level' },
        { key: 'Days Since', label: 'Days', type: 'num', digits: 0 },
        { key: 'Outcome', label: 'Outcome', type: 'badge' },
        { key: 'Pattern @ Alert', label: 'Pattern @ alert', wrap: true },
        { key: 'FVG Tags @ Alert', label: 'FVG @ alert', wrap: true }
      ]
    }).mount($('#sa-log', host));
    P.sheetRows = rows;
    applySheet(P);
  }
  function applySheet(P) {
    if (!P.sheetLog) return;
    var rows = P.sheetRows.filter(function (r) {
      if (ST.logF !== 'all' && r.Outcome !== ST.logF) return false;
      if (ST.logType && (r['Alert Type'] || 'Unspecified') !== ST.logType) return false;
      return ui.textMatch(ST.logQ, [r.Symbol, r.Company, r['Pattern @ Alert'], r['FVG Tags @ Alert'], r['Alert Type']]);
    });
    $('#sa-count', P.el).textContent = plural(rows.length, 'alert');
    P.sheetLog.setRows(rows);
  }
  function gradingHtml() {
    return '<section class="card"><div class="card-head"><div><h2>How the sheet grades these alerts</h2><p>Rules from Code.gs (updateAlertOutcomes_) - this site shows the sheet\'s own grade</p></div></div>' +
      '<p>Each alert is measured from its <b>alert level</b> (the price you set) as a long-side idea - a Price Fall alert is a buy-the-dip watch, so a recovery upward is the favourable outcome.</p>' +
      '<ul class="checks" style="margin-top:8px">' +
      '<li><span class="no" aria-hidden="true">●</span><span><b>Loss</b> - the close is at or below the stop-loss you set for that symbol in Main (checked first). A symbol without a stop-loss can only be Win or Open.</span></li>' +
      '<li><span class="ok" aria-hidden="true">●</span><span><b>Win</b> - the price is at least +10% above the alert level (AB_ALERT_WIN_PCT, default 10; your Control Panel value applies).</span></li>' +
      '<li><span class="na" aria-hidden="true">●</span><span><b>Open</b> - anything in between.</span></li></ul>' +
      '<p class="sub" style="margin-top:8px">Outcomes are re-graded every day with that day\'s close, so an Open alert can still become Win or Loss, and a grade here is only as fresh as the snapshot. ' +
      'Your stop-loss values are personal and are not exported, so this site cannot re-grade alerts itself. Past alert outcomes say nothing certain about future ones.</p></section>';
  }

  // ======================================================================
  // 2. My alert rules
  // ======================================================================
  function buildRules(P, preSym) {
    var host = $('#sec-rules', P.el);
    host.innerHTML =
      '<div class="note warn" role="note"><strong>Not real-time.</strong> ' + esc(DISCLAIMER) + '</div>' +
      '<section class="card"><div class="card-head"><div><h2>Add an alert rule</h2><p>Saved only in this browser. A rule fires at most once per data update (the data timestamp it read); one-shot rules switch themselves off after firing.</p></div></div>' +
      '<form id="ar-form" novalidate><div class="form-grid">' +
      fieldHtml('Symbol', symInput('ar-sym', preSym)) +
      fieldHtml('Condition', '<select class="sel" id="ar-type" style="width:100%">' + RT_ORDER.map(function (k) { return '<option value="' + k + '">' + esc(RT[k].label) + '</option>'; }).join('') + '</select>') +
      '<label class="field" id="ar-val-f"><span id="ar-val-l">' + esc(RT.priceAbove.field) + '</span>' + numInput('ar-val', '') + '</label>' +
      fieldHtml('Fires', '<select class="sel" id="ar-mode" style="width:100%"><option value="once">One-shot, then off</option><option value="repeat">Repeat on new data</option></select>') +
      fieldHtml('Note (optional)', '<input class="inp" id="ar-note" maxlength="120" autocomplete="off" style="width:100%">') +
      '<div class="field" style="align-content:end"><button class="btn primary" type="submit">Add rule</button></div>' +
      '</div></form><div id="ar-help" class="sub" style="margin-top:10px"></div><div id="ar-msg" style="margin-top:10px"></div></section>' +
      '<section class="card"><div class="card-head"><div><h2>My rules</h2><p id="ar-status">Checking…</p></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" type="button" data-act="rules-check" id="ar-check">Check now</button>' +
      '<button class="btn" type="button" data-act="rules-export">Export JSON</button><button class="btn" type="button" data-act="rules-import">Import JSON</button>' +
      '<input type="file" id="ar-file" accept=".json,application/json" hidden></div></div><div id="ar-list-msg" style="margin-bottom:10px"></div><div id="ar-list"></div>' +
      '<details style="margin-top:12px"><summary class="sub" style="cursor:pointer">How rules are checked</summary><ul class="sub" style="margin:6px 0 0 18px;padding:0">' +
      '<li>When this page opens, every minute while it stays open, and when you press Check now - never in the background, never on your phone.</li>' +
      '<li>Against the data this site has right now: the sheet snapshot (CACHED) unless a market-data provider is configured, in which case the price state (DELAYED / LIVE / EOD) is shown with each result.</li>' +
      '<li>Duplicate suppression: each rule remembers the data timestamp it last fired on and never fires twice for the same data. Repeat rules fire again only when newer data still meets the condition.</li>' +
      '<li>"Strategy status becomes Qualified" uses the active strategy at check time; if it is the DEMO or an unconfirmed strategy, the alert says so.</li></ul></details></section>' +
      '<section class="card"><div class="card-head"><div><h2>Alert history</h2><p>Every time one of your rules fired in this browser, with the price and its data state at that moment (newest first, last ' + HIST_MAX + ' kept).</p></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" type="button" data-act="hist-csv">Export CSV</button><button class="btn danger" type="button" data-act="hist-clear">Clear history</button></div></div>' +
      '<div id="ar-hist-msg"></div><div id="ar-hist"></div></section>';
    updateRuleHelp(P);
  }
  function updateRuleHelp(P) {
    var type = fval(P, 'ar-type') || 'priceAbove', sym = fval(P, 'ar-sym').toUpperCase(), s = P.ctx.bySym[sym], d = RT[type];
    var vf = $('#ar-val-f', P.el);
    if (vf) vf.style.display = d.field ? '' : 'none';         // .field sets display:grid, which beats [hidden]
    if (d.field) $('#ar-val-l', P.el).textContent = d.field;
    var h = esc(d.help);
    if (sym && !s) h = '<span class="down">' + esc(sym) + ' is not in your watchlist data - pick a symbol from the list.</span> ' + h;
    else if (s) {
      h = '<b>' + esc(s.sym) + '</b> ' + esc(s.name || '') + ' · ' + rupee(s.price) + ' ' + ui.deltaHtml(s.chg, 2) + ' ' + ui.stateBadge(s.priceState, s.priceAsOf) +
        (s.rdate ? ' · result date ' + esc(F.date(s.rdate)) : '') + '<br>' + h;
      if (type === 'nearStop' || type === 'nearTarget') {
        var pos = openTrades().filter(function (t) { return t.sym === sym; });
        h += pos.length ? ' Open journal position: ' + pos.map(function (t) { return (t.side === 'short' ? 'short ' : '') + F.int(t.qty) + ' @ ' + rupee(t.entry) + ', stop ' + rupee(t.stop) + ', target ' + rupee(t.target); }).join('; ') + '.'
          : ' <span class="down">No open journal position in ' + esc(sym) + ' - add it in the Trade journal first.</span>';
      }
    }
    if (type === 'qualified') {
      var cfg = P.run ? P.run.config : SB.strategies.get(SB.strategies.activeId());
      if (cfg) h += ' Active strategy: ' + stratLine(cfg) + '.';
    }
    $('#ar-help', P.el).innerHTML = h;
  }
  function addRule(P) {
    var sym = fval(P, 'ar-sym').toUpperCase(), type = fval(P, 'ar-type'), x = type === 'qualified' ? null : toNum(fval(P, 'ar-val'));
    var errs = [];
    if (!sym) errs.push('enter a symbol');
    else if (!P.ctx.bySym[sym]) errs.push(sym + ' is not in your watchlist data - choose one from the suggestions');
    var ve = valueError(type, x);
    if (ve) errs.push(ve);
    if (!errs.length && (type === 'nearStop' || type === 'nearTarget')) {
      var has = openTrades().some(function (t) { return t.sym === sym && (type === 'nearStop' ? t.stop > 0 : t.target > 0); });
      if (!has) errs.push('there is no open trade-journal position in ' + sym + ' with a ' + (type === 'nearStop' ? 'stop-loss' : 'target') + ' - add it in the Trade journal tab first');
    }
    if (errs.length) { msg(P, 'ar-msg', 'bad', '<strong>Rule not added:</strong>' + listHtml(errs)); return; }
    var rule = cleanRule({ id: uid('r'), sym: sym, type: type, value: x, mode: fval(P, 'ar-mode'), enabled: true, note: fval(P, 'ar-note'), createdAt: istNow() });
    var rules = loadRules();
    rules.push(rule);
    if (!saveRules(rules)) { msg(P, 'ar-msg', 'bad', esc(STORE_FAIL)); return; }
    msg(P, 'ar-msg', 'good', '<strong>Rule added:</strong> ' + esc(sym + ' - ' + ruleText(rule)) + ' (' + (rule.mode === 'repeat' ? 'repeat' : 'one-shot') + '). It was checked against the current data straight away - see "Now" below.');
    $('#ar-val', P.el).value = '';
    $('#ar-note', P.el).value = '';
    updateTabCounts(P);
    checkRules(P, 'rule added');
  }

  /** Evaluate one rule against the CURRENT data. -> {met, na, text, key, price, state, asOf} */
  function evalRule(rule, P, open) {
    var ctx = P.ctx, s = ctx.bySym[rule.sym], x = rule.value;
    var out = { met: false, na: false, text: '', key: null, price: null, state: 'UNAVAILABLE', asOf: null };
    function na(t) { out.na = true; out.text = t; return out; }
    if (!s) return na(rule.sym + ' is not in the watchlist data');
    out.price = isNum(s.price) ? s.price : null;
    out.state = s.priceState || 'UNAVAILABLE';
    out.asOf = s.priceAsOf || null;
    var pxKey = 'price ' + out.state + ' ' + (out.asOf || '?');
    switch (rule.type) {
      case 'priceAbove': case 'priceBelow':
        if (!isNum(s.price)) return na('no current price');
        out.key = pxKey;
        out.met = rule.type === 'priceAbove' ? s.price >= x : s.price <= x;
        out.text = 'price ' + rupee(s.price) + (rule.type === 'priceAbove' ? (out.met ? ' ≥ ' : ' < ') : (out.met ? ' ≤ ' : ' > ')) + rupee(x);
        return out;
      case 'chgUp': case 'chgDown':
        if (!isNum(s.chg)) return na('no % change for today');
        out.key = pxKey;
        out.met = rule.type === 'chgUp' ? s.chg >= x : s.chg <= -x;
        out.text = 'today ' + F.pct(s.chg, 2) + (out.met ? ' meets ' : ' vs ') + (rule.type === 'chgUp' ? '+' : '−') + F.num(x, 2) + '%';
        return out;
      case 'qualified':
        if (P.runErr) return na('the strategy could not run: ' + P.runErr);
        if (!P.run) return na('the strategy has not run yet');
        var r = P.run.bySym[rule.sym], cfg = P.run.config;
        if (!r) return na('not in the active strategy\'s universe');
        out.key = 'strategy ' + cfg.id + ' v' + cfg.version + ' candles ' + (P.run.dataAsOf || '?') + ' / ' + pxKey;
        out.met = r.status === 'qualified';
        out.text = cfg.name + ' v' + cfg.version + (cfg.source === 'demo' ? ' [DEMO]' : SB.strategies.isConfirmed(cfg.id) ? '' : ' [unconfirmed]') + ': ' + r.statusLabel + ' (' + r.score + '% of rules met)';
        out.strategy = { id: cfg.id, version: cfg.version, name: cfg.name, source: cfg.source, confirmed: SB.strategies.isConfirmed(cfg.id) };
        return out;
      case 'nearStop': case 'nearTarget':
        if (!isNum(s.price)) return na('no current price');
        var stopRule = rule.type === 'nearStop';
        var pos = open.filter(function (t) { return t.sym === rule.sym && (stopRule ? t.stop > 0 : t.target > 0); });
        if (!pos.length) return na('no open journal position in ' + rule.sym + ' with a ' + (stopRule ? 'stop-loss' : 'target'));
        var best = null;
        pos.forEach(function (t) {
          var lvl = stopRule ? t.stop : t.target, sg = sideSign(t);
          var dist = stopRule ? sg * (s.price - lvl) / s.price * 100 : sg * (lvl - s.price) / s.price * 100;
          if (!best || dist < best.d) best = { d: dist, lvl: lvl };
        });
        out.key = pxKey;
        out.met = best.d <= x;
        out.text = 'price ' + rupee(s.price) + (best.d <= 0 ? ' is past your ' : ' is ' + F.num(best.d, 2) + '% from your ') + (stopRule ? 'stop-loss ' : 'target ') + rupee(best.lvl);
        return out;
      case 'resultWithin':
        var d = ui.parseDate(s.rdate);
        out.key = 'sheet ' + (ctx.D.asOf || '?') + ' result date ' + (s.rdate || 'none');
        if (!d) return na('no result date in the sheet');
        var dd = ui.dayDiff(d, ui.parseDate(istToday()));
        out.met = dd >= 0 && dd <= x;
        out.text = dd < 0 ? 'result date ' + F.date(s.rdate) + ' has passed (' + plural(-dd, 'day') + ' ago)' : 'result date ' + F.date(s.rdate) + (dd === 0 ? ' is today' : ' is in ' + plural(dd, 'day'));
        return out;
    }
    return na('unknown condition');
  }

  /** Check every rule against the current data; fire the ones that meet their condition (deduped per data timestamp). */
  function checkRules(P, why) {
    if (P.checking) return P.checking;
    var btn = $('#ar-check', P.el);
    if (btn) btn.disabled = true;
    var needRun = loadRules().some(function (r) { return r.type === 'qualified'; });
    P.checking = (needRun ? ensureRun(P) : Promise.resolve()).then(function () {
      var rules = loadRules(), hist = loadHist(), now = istNow(), open = openTrades(), fired = [];
      P.evals = {};
      rules.forEach(function (rule) {
        var ev = evalRule(rule, P, open);
        P.evals[rule.id] = ev;
        if (!rule.enabled || ev.na) return;
        if (rule.type === 'qualified' && !ev.met) { rule.armed = true; return; }
        if (!ev.met) return;
        if (rule.lastFiredKey === ev.key) { ev.dup = true; return; }
        if (rule.type === 'qualified' && rule.armed === false) { ev.waiting = true; return; }
        var e = cleanHist({
          id: uid('h'), ruleId: rule.id, sym: rule.sym, type: rule.type, rule: ruleText(rule) + (rule.note ? ' - ' + rule.note : ''), firedAt: now,
          dataKey: ev.key, dataState: ev.state, dataAsOf: ev.asOf, price: ev.price, seen: ev.text, mode: rule.mode, strategy: ev.strategy
        });
        hist.unshift(e);
        fired.push(e);
        ev.firedNow = true;
        rule.lastFiredKey = ev.key; rule.lastFiredAt = now; rule.fireCount = (rule.fireCount || 0) + 1;
        if (rule.type === 'qualified') rule.armed = false;
        if (rule.mode === 'once') { rule.enabled = false; rule.done = true; }
      });
      var ok = saveRules(rules) && (!fired.length || saveHist(hist));
      P.lastCheck = { at: now, why: why, fired: fired.length, ok: ok, n: rules.length, on: rules.filter(function (r) { return r.enabled; }).length };
      if (ok) P.fired = fired.concat(P.fired);
      P.checking = null;
      if (!P.el.isConnected) return;
      if (btn) btn.disabled = false;
      drawRuleList(P); drawHist(P); drawTop(P); updateTabCounts(P);
      if (!ok) msg(P, 'ar-list-msg', 'bad', esc(STORE_FAIL));
      else if (why === 'Check now') {
        msg(P, 'ar-list-msg', fired.length ? 'good' : '', fired.length ? '<strong>' + plural(fired.length, 'rule') + ' fired</strong> - see Alert history below.' :
          'Checked ' + plural(rules.length, 'rule') + ' at ' + esc(F.dateTime(now)) + ' IST - nothing new fired' + (rules.length ? ' (a rule never fires twice for the same data; the snapshot changes only when the sheet is exported again or a provider updates prices).' : '.'));
      }
    }, function (e) { P.checking = null; if (btn) btn.disabled = false; msg(P, 'ar-list-msg', 'bad', 'Check failed: ' + esc(e && e.message)); });
    return P.checking;
  }
  function autoCheck(P) {
    setTimeout(function tick() {
      if (!P.el.isConnected) return;                        // page left: stop
      if (loadRules().some(function (r) { return r.enabled; })) checkRules(P, 'auto');
      setTimeout(tick, AUTO_MS);
    }, AUTO_MS);
  }
  function drawRuleList(P) {
    var rules = loadRules(), m = P.ctx.market, lc = P.lastCheck;
    var st = $('#ar-status', P.el);
    if (st) {
      st.innerHTML = (lc ? 'Last checked ' + esc(F.dateTime(lc.at)) + ' IST (' + esc(lc.why === 'auto' ? 'automatic, every minute while open' : lc.why) + ')' : 'Not checked yet') +
        ' · ' + plural(rules.filter(function (r) { return r.enabled; }).length, 'rule') + ' on · prices ' + ui.stateBadge(m.state, m.asOf, m.source) +
        (P.run ? ' · strategy ' + stratLine(P.run.config) + ' <span class="sub">candles to ' + esc(F.date(P.run.dataAsOf)) + '</span>' : '');
    }
    var rows = rules.map(function (r) {
      var s = P.ctx.bySym[r.sym], ev = P.evals[r.id];
      return { r: r, ev: ev, sym: r.sym, name: s ? s.name : '(not in watchlist)', cond: ruleText(r), mode: r.mode === 'repeat' ? 'Repeat' : 'One-shot',
        state: r.enabled ? 'On' : r.done ? 'Fired' : 'Off', now: ev ? (ev.met && !ev.na ? '1 met' : ev.na ? '3 cannot check' : '2 not met') : '4 not checked', last: r.lastFiredAt || '' };
    });
    var opts = {
      rows: rows, pageSize: 25, sort: { key: 'now', dir: 1 },
      empty: 'No rules yet. Add one above - for example "SBIN, price at or below ₹900" - or import a rules file you exported earlier.',
      columns: [
        { key: 'sym', label: 'Stock', type: 'sym', name: 'name' },
        { key: 'cond', label: 'Condition', wrap: true, html: function (x) { return esc(x.cond) + (x.r.note ? '<div class="sub">' + esc(x.r.note) + '</div>' : ''); } },
        { key: 'mode', label: 'Fires' },
        { key: 'state', label: 'Status', html: function (x) { return x.r.enabled ? ui.badge('On', 's-good') : x.r.done ? ui.badge('Fired · off', 's-info') : ui.badge('Off', ''); } },
        { key: 'now', label: 'Now', wrap: true, html: function (x) { return evHtml(x.ev); } },
        { key: 'last', label: 'Last fired', html: function (x) {
          return x.r.lastFiredAt ? esc(F.dateTime(x.r.lastFiredAt)) + ' IST<div class="sub">' + plural(x.r.fireCount || 1, 'time') + '</div>' : '<span class="sub">never</span>';
        } },
        { key: 'act', label: 'Actions', get: function () { return ''; }, html: function (x) {
          return '<div style="display:flex;gap:6px"><button class="btn" type="button" data-act="rule-toggle" data-id="' + esc(x.r.id) + '">' +
            (x.r.enabled ? 'Turn off' : x.r.done ? 'Re-arm' : 'Turn on') + '</button><button class="btn danger" type="button" data-act="rule-del" data-id="' + esc(x.r.id) + '">Delete</button></div>';
        } }
      ]
    };
    tableIn(P, 'rules', $('#ar-list', P.el), opts);
  }
  function evHtml(ev) {
    if (!ev) return '<span class="sub">not checked yet</span>';
    if (ev.na) return ui.badge('Can\'t check', 's-warn') + '<div class="sub" style="white-space:normal">' + esc(ev.text) + '</div>';
    var h = (ev.firedNow ? ui.badge('Fired now', 's-good') : ev.met ? ui.badge('Condition met', 's-good') : ui.badge('Not met', '')) +
      '<div style="white-space:normal">' + esc(ev.text) + '</div>';
    if (ev.dup) h += '<div class="sub" style="white-space:normal">already fired for this data - waits for newer data</div>';
    if (ev.waiting) h += '<div class="sub" style="white-space:normal">still Qualified since it last fired - fires again after it drops out and returns</div>';
    return h + '<div style="margin-top:3px">' + ui.stateBadge(ev.state, ev.asOf) + '</div>';
  }
  function drawHist(P) {
    var hist = loadHist();
    tableIn(P, 'hist', $('#ar-hist', P.el), {
      rows: hist, pageSize: 20, sort: { key: 'firedAt', dir: -1 },
      empty: 'Nothing has fired yet in this browser. When a rule\'s condition is met during a check, it is recorded here.',
      columns: [
        { key: 'firedAt', label: 'Fired (IST)', type: 'datetime' },
        { key: 'sym', label: 'Stock', type: 'sym' },
        { key: 'rule', label: 'Rule', wrap: true },
        { key: 'seen', label: 'What was seen', wrap: true, html: function (h) {
          return esc(h.seen) + (h.strategy ? '<div style="margin-top:3px">' + stratBadge(h.strategy.source, h.strategy.confirmed) + '</div>' : '');
        } },
        { key: 'price', label: 'Price', type: 'price' },
        { key: 'dataState', label: 'Data', html: function (h) { return ui.stateBadge(h.dataState, h.dataAsOf); }, csv: function (h) { return h.dataState + (h.dataAsOf ? ' ' + h.dataAsOf : ''); } }
      ]
    });
  }
  function drawTop(P) {
    var box = $('#al-top', P.el);
    if (!box) return;
    if (!P.fired.length) { box.innerHTML = ''; box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = '<div class="note" role="status"><strong>' + plural(P.fired.length, 'alert rule') + ' fired while this page was open</strong>' +
      '<ul style="margin:6px 0 0 18px;padding:0">' + P.fired.slice(0, 8).map(function (h) {
        return '<li>' + esc(F.dateTime(h.firedAt)) + ' IST · <b>' + esc(h.sym) + '</b> - ' + esc(h.rule) + ': ' + esc(h.seen) + ' ' + ui.stateBadge(h.dataState, h.dataAsOf) + '</li>';
      }).join('') + '</ul>' + (P.fired.length > 8 ? '<p class="sub">…and ' + (P.fired.length - 8) + ' more in the history.</p>' : '') +
      '<p class="sub" style="margin-top:6px">Checked against snapshot/delayed data - confirm the live price yourself before acting. This is not advice.</p>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><button class="btn" type="button" data-act="goto-rules">See alert history</button><button class="btn" type="button" data-act="top-dismiss">Dismiss</button></div></div>';
  }
  function exportRules() {
    var data = { kind: 'stock-blueprint.alert-rules', version: 1, exportedAt: istNow() + ' IST', note: 'Personal file - your own alert rules and their history from Stock Blueprint (this browser only).', rules: loadRules(), history: loadHist() };
    ui.download('stock-blueprint-alert-rules-' + stamp() + '.json', JSON.stringify(data, null, 2), 'application/json');
  }
  function importRules(P, text, name) {
    var j;
    try { j = JSON.parse(text); } catch (e) { msg(P, 'ar-list-msg', 'bad', '<strong>Not imported:</strong> ' + esc(name) + ' is not valid JSON.'); return; }
    var arr = Array.isArray(j) ? j : j && Array.isArray(j.rules) ? j.rules : null;
    if (!arr) { msg(P, 'ar-list-msg', 'bad', '<strong>Not imported:</strong> no "rules" list in ' + esc(name) + ' - use a file made with Export JSON on this page.'); return; }
    var rules = loadRules(), byId = {}, added = 0, updated = 0, skipped = 0;
    rules.forEach(function (r, i) { byId[r.id] = i; });
    arr.forEach(function (raw) {
      var r = cleanRule(raw);
      if (!r) { skipped++; return; }
      if (r.id in byId) { rules[byId[r.id]] = r; updated++; } else { byId[r.id] = rules.length; rules.push(r); added++; }
    });
    var hist = loadHist(), seen = {}, hAdded = 0;
    hist.forEach(function (h) { seen[h.id] = 1; });
    (j && Array.isArray(j.history) ? j.history : []).forEach(function (raw) {
      var h = cleanHist(raw);
      if (h && !seen[h.id]) { hist.push(h); seen[h.id] = 1; hAdded++; }
    });
    hist.sort(function (a, b) { return String(b.firedAt).localeCompare(String(a.firedAt)); });
    if (!saveRules(rules) || !saveHist(hist)) { msg(P, 'ar-list-msg', 'bad', esc(STORE_FAIL)); return; }
    msg(P, 'ar-list-msg', (added + updated) ? 'good' : 'warn', '<strong>Imported from ' + esc(name) + ':</strong> ' + added + ' new, ' + updated + ' updated' +
      (skipped ? ', ' + skipped + ' skipped (invalid symbol, condition or value)' : '') + (hAdded ? ' · ' + hAdded + ' history entries added' : '') + '.');
    drawRuleList(P); drawHist(P); updateTabCounts(P);
  }

  // ======================================================================
  // 3. Trade journal
  // ======================================================================
  function buildJournal(P) {
    $('#sec-journal', P.el).innerHTML =
      '<div class="note"><strong>Manual journal records - not broker positions.</strong> You type these in yourself; they are saved only in this browser and are not linked to any broker account. ' +
      'Unrealized P&amp;L uses the prices this site has (snapshot or delayed - the state is shown next to each price).</div>' +
      '<section class="card" id="jr-form-card"><div id="jr-form-host"></div><div id="jr-msg" style="margin-top:10px"></div></section>' +
      '<div id="jr-close-host"></div>' +
      '<section class="card"><div class="card-head"><div><h2>Open positions</h2><p>Manual journal records - not broker positions. Unrealized P&amp;L = (price − entry) × qty − entry fees (long; reversed for short).</p></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" type="button" data-act="jr-export-json">Export JSON</button><button class="btn" type="button" data-act="jr-export-csv">Export CSV</button>' +
      '<button class="btn" type="button" data-act="jr-import">Import JSON / CSV</button><input type="file" id="jr-file" accept=".json,.csv,application/json,text/csv" hidden></div></div>' +
      '<div id="jr-io-msg" style="margin-bottom:10px"></div><div class="controls"><input class="search" id="jr-q" type="search" placeholder="Filter open and closed trades by symbol" aria-label="Filter journal by symbol" value="' + val(ST.jq) + '">' +
      '<span class="count" id="jr-count"></span></div><div id="jr-tiles" style="margin-bottom:12px"></div><div id="jr-open"></div></section>' +
      '<section class="card"><div class="card-head"><div><h2>Closed trades</h2><p>Manual journal records - not broker positions. Realized P&amp;L = (exit − entry) × qty − entry and exit fees (long; reversed for short). R = price move ÷ initial risk per share (entry − stop).</p></div></div><div id="jr-closed"></div></section>' +
      '<section class="card"><div class="card-head"><div><h2>Review - all closed trades</h2><p>Manual journal records - not broker positions. Past results do not predict future ones.</p></div></div><div id="jr-review"></div></section>';
  }
  function strategyOptions(selId, trade) {
    var list = SB.strategies.list(), found = false;
    var h = '<option value="">None / discretionary</option>' + list.map(function (c) {
      if (c.id === selId) found = true;
      return '<option value="' + esc(c.id) + '"' + (c.id === selId ? ' selected' : '') + '>' + esc(c.name + ' · v' + c.version + (c.source === 'demo' && !/DEMO/.test(c.name) ? ' (DEMO)' : '')) + '</option>';
    }).join('');
    if (selId && !found) h += '<option value="' + esc(selId) + '" selected>' + esc((trade && trade.strategyName) || selId) + ' (no longer saved here)</option>';
    return h;
  }
  function drawJForm(P, pre) {
    var host = $('#jr-form-host', P.el), risk = loadRisk().s, today = istToday();
    var t = P.editId ? findTrade(P.editId) : null;
    if (P.editId && !t) P.editId = null;
    var v = t || pre || {}, closed = !!(t && t.status === 'closed');
    var sid = t ? t.strategyId : v.strategyId != null ? v.strategyId : SB.strategies.activeId();
    var shortOk = risk.allowShort || (t && t.side === 'short');
    var h = '<div class="card-head"><div><h2>' + (t ? 'Edit trade · ' + esc(t.sym) + (closed ? ' (closed)' : '') : 'Add a trade') + '</h2><p>' +
      (t ? 'Change any field and save. ' : 'Record a trade you took. ') + 'Manual journal record - not a broker position; nothing is sent to any broker.</p></div></div>' +
      '<form id="jr-form" novalidate><div class="form-grid">' +
      fieldHtml('Symbol', symInput('jr-sym', v.sym)) +
      fieldHtml('Side', '<select class="sel" id="jr-side" style="width:100%"><option value="long">Long</option><option value="short"' + (shortOk ? '' : ' disabled') + '>Short' +
        (shortOk ? '' : ' (off in risk settings)') + '</option></select>') +
      fieldHtml('Entry date', '<input class="inp" id="jr-edate" type="date" max="' + today + '" value="' + val(v.entryDate || today) + '" style="width:100%">') +
      fieldHtml('Entry price (₹)', numInput('jr-entry', v.entry)) +
      fieldHtml('Quantity (shares)', numInput('jr-qty', v.qty, '1')) +
      fieldHtml('Stop-loss (₹)', numInput('jr-stop', v.stop)) +
      fieldHtml('Target (₹)', numInput('jr-target', v.target)) +
      fieldHtml('Entry fees (₹)', numInput('jr-fees', t ? v.fees : v.fees || '')) +
      fieldHtml('Strategy', '<select class="sel" id="jr-strat" style="width:100%">' + strategyOptions(sid, t) + '</select>') +
      '</div><label class="field" style="margin-top:12px"><span>Reason for entry</span><textarea class="inp" id="jr-reason" maxlength="1000" rows="2">' + val(v.reason) + '</textarea></label>';
    if (closed) {
      h += '<div class="form-grid" style="margin-top:12px">' +
        fieldHtml('Exit date', '<input class="inp" id="jr-xdate" type="date" max="' + today + '" value="' + val(t.exitDate) + '" style="width:100%">') +
        fieldHtml('Exit price (₹)', numInput('jr-exit', t.exit)) + fieldHtml('Exit fees (₹)', numInput('jr-xfees', t.exitFees)) + '</div>' +
        '<label class="field" style="margin-top:12px"><span>Reason for exit</span><textarea class="inp" id="jr-xreason" maxlength="1000" rows="2">' + val(t.exitReason) + '</textarea></label>';
    }
    h += '<div id="jr-prev" class="sub" style="margin-top:10px"></div>';
    if (t && t.signal) {
      h += '<details style="margin-top:10px"><summary style="cursor:pointer">Signal snapshot at entry: ' + sigCell(t.signal) + '</summary><p class="sub" style="margin-top:6px">' + esc(sigTip(t.signal)) +
        (t.signal.takenAt ? ' · taken ' + esc(F.dateTime(t.signal.takenAt)) + ' IST' : '') + '</p>' + (t.signal.checks.length ? checksHtml(t.signal) : '') + '</details>';
    }
    h += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px"><button class="btn primary" type="submit">' + (t ? 'Save changes' : 'Add trade') + '</button>' +
      '<button class="btn" type="button" data-act="jr-usepx">Use current price</button><button class="btn" type="button" data-act="jr-uselv">Use strategy stop &amp; target</button>' +
      (t ? '<button class="btn" type="button" data-act="jr-cancel">Cancel edit</button>' : '<button class="btn" type="button" data-act="jr-clear">Clear form</button>') + '</div></form>';
    host.innerHTML = h;
    $('#jr-side', P.el).value = v.side === 'short' && shortOk ? 'short' : 'long';
    updateJPrev(P);
  }
  function updateJPrev(P) {
    var box = $('#jr-prev', P.el);
    if (!box) return;
    var sym = fval(P, 'jr-sym').toUpperCase(), s = P.ctx.bySym[sym], t = P.editId ? findTrade(P.editId) : null, parts = [];
    if (sym && !s) parts.push('<span class="down">' + esc(sym) + ' is not in your watchlist - it can still be journalled, but there is no current price for P&amp;L.</span>');
    if (s) parts.push('<b>' + esc(s.sym) + '</b> ' + esc(s.name || '') + ' · ' + esc(s.catName || '') + ' · ' + rupee(s.price) + ' ' + ui.deltaHtml(s.chg, 2) + ' ' + ui.stateBadge(s.priceState, s.priceAsOf));
    if (s && !(t && t.sym === sym && t.signal)) {
      if (P.run) {
        var g = snapshot(P, sym);
        parts.push(g ? 'Signal snapshot that will be saved with this trade: ' + sigCell(g) + ' <span class="sub">' + esc(g.strategyName + ' v' + g.strategyVersion) + '</span>' :
          'The active strategy did not evaluate ' + esc(sym) + ' - no signal snapshot will be saved.');
      } else parts.push(P.runErr ? 'Strategy unavailable (' + esc(P.runErr) + ') - no signal snapshot will be saved.' : 'Loading the active strategy for the signal snapshot…');
    }
    var entry = toNum(fval(P, 'jr-entry')), stop = toNum(fval(P, 'jr-stop')), side = fval(P, 'jr-side') === 'short' ? 'short' : 'long';
    if (entry > 0 && stop > 0 && !(t && t.status === 'closed')) {
      var rc = riskContext(P);
      if (t) { var ids = openTrades().map(function (x) { return x.id; }); rc.openPositions = rc.openPositions.filter(function (p, i) { return ids[i] !== t.id; }); }
      var z = SB.risk.sizePosition({ entry: entry, stop: stop, target: toNum(fval(P, 'jr-target')), side: side, industry: s ? s.catName : null }, loadRisk().s, rc);
      parts.push(z.ok ? 'Your risk settings would size this at <b>' + F.int(z.qty) + ' shares</b> (risk ' + F.inr(z.riskAmount) + ').' : 'Position sizing: ' + esc(z.errors[0] || 'n/a') + '.');
    }
    box.innerHTML = parts.join('<br>');
  }
  function readTradeForm(P, t) {
    var risk = loadRisk().s, today = istToday(), errs = [], warns = [];
    var o = {
      sym: fval(P, 'jr-sym').toUpperCase(), side: fval(P, 'jr-side') === 'short' ? 'short' : 'long', entryDate: fval(P, 'jr-edate'),
      entry: toNum(fval(P, 'jr-entry')), qty: toNum(fval(P, 'jr-qty')), stop: toNum(fval(P, 'jr-stop')), target: toNum(fval(P, 'jr-target')),
      fees: fval(P, 'jr-fees') === '' ? 0 : toNum(fval(P, 'jr-fees')), strategyId: fval(P, 'jr-strat'), reason: fval(P, 'jr-reason')
    };
    if (!SYM_RE.test(o.sym)) errs.push('enter a valid NSE symbol');
    else if (!P.ctx.bySym[o.sym]) warns.push(o.sym + ' is not in your watchlist, so there is no current price for it');
    if (o.side === 'short' && !risk.allowShort && !(t && t.side === 'short')) errs.push('short trades are switched off in your risk settings (Risk & position size tab)');
    if (!validDate(o.entryDate)) errs.push('enter the entry date');
    else if (o.entryDate > today) errs.push('the entry date is in the future');
    if (!(o.entry > 0)) errs.push('entry price must be above 0');
    if (!(o.qty > 0) || Math.floor(o.qty) !== o.qty) errs.push('quantity must be a whole number of shares above 0');
    if (fval(P, 'jr-stop') !== '') {
      if (!(o.stop > 0)) errs.push('stop-loss must be above 0 (or leave it empty)');
      else if (o.entry > 0 && (o.side === 'long' ? o.stop >= o.entry : o.stop <= o.entry)) errs.push('stop-loss must be ' + (o.side === 'long' ? 'below' : 'above') + ' the entry for a ' + o.side + ' trade');
    } else { o.stop = null; warns.push('no stop-loss: the whole position counts as at risk in portfolio heat and R cannot be computed'); }
    if (fval(P, 'jr-target') !== '') {
      if (!(o.target > 0)) errs.push('target must be above 0 (or leave it empty)');
      else if (o.entry > 0 && (o.side === 'long' ? o.target <= o.entry : o.target >= o.entry)) errs.push('target must be ' + (o.side === 'long' ? 'above' : 'below') + ' the entry for a ' + o.side + ' trade');
    } else o.target = null;
    if (!(o.fees >= 0)) errs.push('fees must be 0 or more');
    if (t && t.status === 'closed') {
      o.exitDate = fval(P, 'jr-xdate'); o.exit = toNum(fval(P, 'jr-exit')); o.exitFees = fval(P, 'jr-xfees') === '' ? 0 : toNum(fval(P, 'jr-xfees')); o.exitReason = fval(P, 'jr-xreason');
      exitChecks(o, errs, today);
    }
    return { o: o, errs: errs, warns: warns };
  }
  function exitChecks(o, errs, today) {
    if (!validDate(o.exitDate)) errs.push('enter the exit date');
    else if (o.exitDate > today) errs.push('the exit date is in the future');
    else if (validDate(o.entryDate) && o.exitDate < o.entryDate) errs.push('the exit date is before the entry date');
    if (!(o.exit > 0)) errs.push('exit price must be above 0');
    if (!(o.exitFees >= 0)) errs.push('exit fees must be 0 or more');
  }
  function saveTradeForm(P) {
    var t = P.editId ? findTrade(P.editId) : null;
    var f = readTradeForm(P, t);
    if (f.errs.length) { msg(P, 'jr-msg', 'bad', '<strong>Not saved:</strong>' + listHtml(f.errs)); return; }
    var o = f.o, trades = loadTrades(), now = istNow();
    var cfg = o.strategyId ? SB.strategies.get(o.strategyId) : null;
    var rec = t ? Object.assign({}, t) : { id: uid('t'), status: 'open', closed: false, createdAt: now };
    ['sym', 'side', 'entryDate', 'entry', 'qty', 'stop', 'target', 'fees', 'reason'].forEach(function (k) { rec[k] = o[k]; });
    if (t && t.status === 'closed') ['exitDate', 'exit', 'exitFees', 'exitReason'].forEach(function (k) { rec[k] = o[k]; });
    if (!t || t.strategyId !== o.strategyId) {
      rec.strategyId = o.strategyId; rec.strategyVersion = cfg ? cfg.version : null;
      rec.strategyName = cfg ? cfg.name : o.strategyId ? (t && t.strategyName) || o.strategyId : ''; rec.strategySource = cfg ? cfg.source : '';
    }
    if (!t || t.sym !== o.sym) { var g = snapshot(P, o.sym); if (g) rec.signal = g; else delete rec.signal; }
    rec.updatedAt = now;
    var clean = cleanTrade(rec, [], 'trade');
    if (!clean) { msg(P, 'jr-msg', 'bad', 'Not saved: the record did not validate.'); return; }
    if (t) trades = trades.map(function (x) { return x.id === t.id ? clean : x; }); else trades.push(clean);
    if (!saveTrades(trades)) { msg(P, 'jr-msg', 'bad', esc(STORE_FAIL)); return; }
    P.editId = null;
    drawJForm(P);
    msg(P, 'jr-msg', 'good', '<strong>' + (t ? 'Saved changes to ' : 'Added ') + esc(clean.sym) + '</strong> - ' + (clean.side === 'short' ? 'short ' : 'long ') + F.int(clean.qty) + ' @ ' + rupee(clean.entry) +
      (clean.signal && (!t || t.sym !== clean.sym) ? ' · signal snapshot saved (' + esc(clean.signal.statusLabel) + ')' : '') + '.' + (f.warns.length ? listHtml(f.warns) : ''));
    journalChanged(P);
  }
  function drawClose(P) {
    var host = $('#jr-close-host', P.el), t = P.closeId ? findTrade(P.closeId) : null;
    if (!t || t.status !== 'open') { P.closeId = null; host.innerHTML = ''; return; }
    var s = P.ctx.bySym[t.sym], px = s && isNum(s.price) ? s.price : null;
    host.innerHTML = '<section class="card" id="jr-close-card"><div class="card-head"><div><h2>Close trade · ' + esc(t.sym) + '</h2><p>' + (t.side === 'short' ? 'Short ' : 'Long ') + F.int(t.qty) +
      ' @ ' + rupee(t.entry) + ' from ' + esc(F.date(t.entryDate)) + '. Records the exit in your journal only - no order is placed.</p></div></div>' +
      '<form id="jr-cform" novalidate><div class="form-grid">' +
      fieldHtml('Exit date', '<input class="inp" id="jr-cdate" type="date" max="' + istToday() + '" value="' + istToday() + '" style="width:100%">') +
      fieldHtml('Exit price (₹)', numInput('jr-cexit', px)) + fieldHtml('Exit fees (₹)', numInput('jr-cfees', '')) + '</div>' +
      '<label class="field" style="margin-top:12px"><span>Reason for exit</span><textarea class="inp" id="jr-creason" maxlength="1000" rows="2"></textarea></label>' +
      (px != null ? '<p class="sub" style="margin-top:8px">Exit price prefilled with the price this site has: ' + rupee(px) + ' ' + ui.stateBadge(s.priceState, s.priceAsOf) + ' - change it to your actual fill.</p>' : '') +
      '<div id="jr-cprev" style="margin-top:8px"></div><div id="jr-cmsg" style="margin-top:8px"></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px"><button class="btn primary" type="submit">Close trade</button><button class="btn" type="button" data-act="jr-cclose">Cancel</button></div></form></section>';
    updateClosePrev(P);
    scrollToEl($('#jr-close-card', P.el));
    var inp = $('#jr-cexit', P.el);
    if (inp) inp.focus({ preventScroll: true });
  }
  function updateClosePrev(P) {
    var box = $('#jr-cprev', P.el), t = P.closeId ? findTrade(P.closeId) : null;
    if (!box || !t) return;
    var x = toNum(fval(P, 'jr-cexit'));
    if (!(x > 0)) { box.innerHTML = '<span class="sub">Enter the exit price to see the result.</span>'; return; }
    var c = calc(Object.assign({}, t, { status: 'closed', exit: x, exitFees: nonNeg(fval(P, 'jr-cfees')), exitDate: fval(P, 'jr-cdate') }));
    box.innerHTML = '<span class="sub">Result: </span>' + pnlHtml(c.pnl) + ' · ' + ui.deltaHtml(c.ret, 2) + (isNum(c.r) ? ' · ' + F.num(c.r, 2) + 'R' : '') + ' <span class="sub">(after ' + F.inr(c.fees) + ' fees)</span>';
  }
  function closeTrade(P) {
    var t = P.closeId ? findTrade(P.closeId) : null;
    if (!t) return;
    var o = { entryDate: t.entryDate, exitDate: fval(P, 'jr-cdate'), exit: toNum(fval(P, 'jr-cexit')), exitFees: fval(P, 'jr-cfees') === '' ? 0 : toNum(fval(P, 'jr-cfees')) }, errs = [];
    exitChecks(o, errs, istToday());
    if (errs.length) { msg(P, 'jr-cmsg', 'bad', '<strong>Not closed:</strong>' + listHtml(errs)); return; }
    var rec = Object.assign({}, t, { status: 'closed', closed: true, exit: o.exit, exitDate: o.exitDate, exitFees: o.exitFees, exitReason: fval(P, 'jr-creason'), updatedAt: istNow() });
    var clean = cleanTrade(rec, [], 'trade');
    if (!saveTrades(loadTrades().map(function (x) { return x.id === t.id ? clean : x; }))) { msg(P, 'jr-cmsg', 'bad', esc(STORE_FAIL)); return; }
    P.closeId = null;
    drawClose(P);
    var c = calc(clean);
    msg(P, 'jr-msg', 'good', '<strong>Closed ' + esc(clean.sym) + '</strong> at ' + rupee(clean.exit) + ': ' + pnlHtml(c.pnl) + ' (' + F.pct(c.ret, 2) + (isNum(c.r) ? ', ' + F.num(c.r, 2) + 'R' : '') + ').');
    if (P.editId === t.id) { P.editId = null; drawJForm(P); }
    journalChanged(P);
  }
  function journalChanged(P) { drawJTables(P); drawPortfolio(P); drawCalcOut(P); updateTabCounts(P); }
  function stratCell(t) {
    if (!t.strategyName && !t.strategyId) return '<span class="sub">none</span>';
    return esc((t.strategyName || t.strategyId) + (t.strategyVersion ? ' · v' + t.strategyVersion : '')) + (t.strategySource === 'demo' || t.strategyId === 'demo' ? ' ' + ui.badge('DEMO', 's-warn') : '');
  }
  function actBtns(t, acts) {
    return '<div style="display:flex;gap:6px">' + acts.map(function (a) {
      return '<button class="btn' + (a[0] === 'jr-del' ? ' danger' : '') + '" type="button" data-act="' + a[0] + '" data-id="' + esc(t.id) + '">' + esc(a[1]) + '</button>';
    }).join('') + '</div>';
  }
  function drawJTables(P) {
    var trades = loadTrades(), q = ST.jq.trim().toUpperCase(), ctx = P.ctx;
    function match(t) { return !q || t.sym.indexOf(q) >= 0; }
    var openT = trades.filter(function (t) { return t.status === 'open'; }), closedT = trades.filter(function (t) { return t.status === 'closed'; });
    var oRows = openT.filter(match).map(function (t) {
      var s = ctx.bySym[t.sym], c = calc(t, s);
      return { t: t, c: c, id: t.id, sym: t.sym, name: s ? s.name : '(not in watchlist)', side: t.side === 'short' ? 'Short' : 'Long', entryDate: t.entryDate, entry: t.entry, qty: t.qty, stop: t.stop, target: t.target,
        price: c.price, upnl: c.upnl, uret: c.uret, rNow: c.rNow, days: c.days, strat: t.strategyName || '', sig: t.signal ? t.signal.statusLabel : '' };
    });
    var cRows = closedT.filter(match).map(function (t) {
      var s = ctx.bySym[t.sym], c = calc(t);
      return { t: t, c: c, id: t.id, sym: t.sym, name: s ? s.name : '', side: t.side === 'short' ? 'Short' : 'Long', entryDate: t.entryDate, exitDate: t.exitDate, days: c.days,
        entry: t.entry, exit: t.exit, qty: t.qty, fees: c.fees, pnl: c.pnl, ret: c.ret, r: c.r, strat: t.strategyName || '', why: [t.reason, t.exitReason].filter(Boolean).join(' / ') };
    });
    $('#jr-count', P.el).textContent = q ? oRows.length + ' open · ' + cRows.length + ' closed match' : '';
    var allOpen = openT.map(function (t) { return calc(t, ctx.bySym[t.sym]); }), priced = allOpen.filter(function (c) { return isNum(c.upnl); });
    var realized = total(closedT.map(function (t) { return calc(t).pnl; }));
    $('#jr-tiles', P.el).innerHTML = '<div class="tiles"' + TILES + '>' +
      ui.tile('Open positions', F.int(openT.length), 'manual records') +
      ui.tile('Invested (at entry)', F.inr(total(allOpen.map(function (c) { return c.cost; }))), 'entry price × qty') +
      ui.tile('Unrealized P&L', priced.length ? pnlHtml(total(priced.map(function (c) { return c.upnl; }))) : '–',
        priced.length < openT.length ? (openT.length - priced.length) + ' without a current price' : 'at ' + esc(ctx.market.state) + ' prices') +
      ui.tile('Realized P&L', closedT.length ? pnlHtml(realized) : '–', plural(closedT.length, 'closed trade')) + '</div>';
    tableIn(P, 'jopen', $('#jr-open', P.el), {
      rows: oRows, pageSize: 25, sort: { key: 'entryDate', dir: -1 },
      empty: q ? 'No open trade matches "' + q + '".' : 'No open positions in your journal. Add a trade above (or use "Add to journal" in the position-size calculator).',
      columns: [
        { key: 'sym', label: 'Stock', type: 'sym', name: 'name' },
        { key: 'side', label: 'Side' },
        { key: 'entryDate', label: 'Entry date', type: 'date' },
        { key: 'entry', label: 'Entry', type: 'price' },
        { key: 'qty', label: 'Qty', type: 'num', digits: 0 },
        { key: 'stop', label: 'Stop', type: 'price' },
        { key: 'target', label: 'Target', type: 'price' },
        { key: 'price', label: 'Price now', type: 'price', html: function (x) { return isNum(x.price) ? F.price(x.price) + '<div style="margin-top:2px">' + ui.stateBadge(x.c.state, x.c.asOf) + '</div>' : ui.stateBadge('UNAVAILABLE'); } },
        { key: 'upnl', label: 'Unrealized P&L', type: 'num', html: function (x) { return pnlHtml(x.upnl) + '<div>' + ui.deltaHtml(x.uret, 2) + '</div>'; } },
        { key: 'rNow', label: 'R now', type: 'num', digits: 2 },
        { key: 'days', label: 'Days', type: 'num', digits: 0 },
        { key: 'strat', label: 'Strategy', wrap: true, html: function (x) { return stratCell(x.t); } },
        { key: 'sig', label: 'Signal at entry', html: function (x) { return sigCell(x.t.signal); } },
        { key: 'act', label: 'Actions', get: function () { return ''; }, html: function (x) { return actBtns(x.t, [['jr-close', 'Close'], ['jr-edit', 'Edit'], ['jr-del', 'Delete']]); } }
      ]
    });
    tableIn(P, 'jclosed', $('#jr-closed', P.el), {
      rows: cRows, pageSize: 25, sort: { key: 'exitDate', dir: -1 },
      empty: q ? 'No closed trade matches "' + q + '".' : 'No closed trades yet. Use "Close" on an open position to record the exit.',
      columns: [
        { key: 'sym', label: 'Stock', type: 'sym', name: 'name' },
        { key: 'side', label: 'Side' },
        { key: 'entryDate', label: 'Entry date', type: 'date' },
        { key: 'exitDate', label: 'Exit date', type: 'date' },
        { key: 'days', label: 'Days', type: 'num', digits: 0, title: 'Holding days (calendar)' },
        { key: 'entry', label: 'Entry', type: 'price' },
        { key: 'exit', label: 'Exit', type: 'price' },
        { key: 'qty', label: 'Qty', type: 'num', digits: 0 },
        { key: 'fees', label: 'Fees', type: 'num', html: function (x) { return F.inr(x.fees); } },
        { key: 'pnl', label: 'P&L', type: 'num', html: function (x) { return pnlHtml(x.pnl); } },
        { key: 'ret', label: 'Return', type: 'pct', digits: 2, title: 'Net P&L ÷ (entry × qty)' },
        { key: 'r', label: 'R', type: 'num', digits: 2, title: 'Price move ÷ initial risk per share' },
        { key: 'strat', label: 'Strategy', wrap: true, html: function (x) { return stratCell(x.t) + (x.t.signal ? '<div style="margin-top:3px">' + sigCell(x.t.signal) + '</div>' : ''); } },
        { key: 'why', label: 'Reasons (entry / exit)', wrap: true },
        { key: 'act', label: 'Actions', get: function () { return ''; }, html: function (x) { return actBtns(x.t, [['jr-edit', 'Edit'], ['jr-del', 'Delete']]); } }
      ]
    });
    drawReview(P, closedT);
  }
  function drawReview(P, closed) {
    var host = $('#jr-review', P.el);
    if (!closed.length) { host.innerHTML = '<p class="empty">No closed trades yet. Once you close trades, this shows win rate, average win and loss, profit factor, expectancy, average R and the drawdown of your cumulative P&amp;L.</p>'; return; }
    var m = review(closed), cap = loadRisk().s.capital;
    host.innerHTML = '<div class="tiles"' + TILES + '>' +
      ui.tile('Closed trades', F.int(m.n), m.wins + ' won · ' + m.losses + ' lost' + (m.even ? ' · ' + m.even + ' break-even' : '')) +
      ui.tile('Win rate', F.num(m.winRate, 0) + '%', 'trades with net P&L above 0') +
      ui.tile('Avg win', isNum(m.avgWin) ? ui.deltaHtml(m.avgWin, 2) : '–', 'net return per winning trade') +
      ui.tile('Avg loss', isNum(m.avgLoss) ? ui.deltaHtml(m.avgLoss, 2) : '–', 'net return per losing trade') +
      ui.tile('Profit factor', m.pf === Infinity ? '∞' : isNum(m.pf) ? F.num(m.pf, 2) : '–', m.pf === Infinity ? 'no losing trades yet' : 'gross wins ÷ gross losses') +
      ui.tile('Expectancy', isNum(m.expectancy) ? ui.deltaHtml(m.expectancy, 2) : '–', 'average net return per trade') +
      ui.tile('Average R', isNum(m.avgR) ? F.num(m.avgR, 2) + 'R' : '–', m.nR ? plural(m.nR, 'trade') + ' with a stop-loss' : 'needs trades with a stop-loss') +
      ui.tile('Max drawdown', m.maxDD > 0 ? '<span class="down">' + inrS(-m.maxDD) + '</span>' : '₹0', m.maxDD > 0 ? F.num(m.maxDD / cap * 100, 2) + '% of your capital setting' : 'of the cumulative P&L curve') +
      ui.tile('Total realized', pnlHtml(m.total), 'after all fees') + '</div>' +
      '<h3 style="margin:16px 0 6px">Cumulative realized P&amp;L</h3><div id="jr-curve"></div>' +
      '<p class="sub" style="margin-top:6px">Closed trades in exit-date order, starting from 0 at the first entry. Max drawdown = largest fall from a peak of this curve.</p>' +
      (m.n < 20 ? '<p class="note" style="margin-top:10px">Only ' + plural(m.n, 'closed trade') + ' - too few for these statistics to be reliable.</p>' : '');
    ui.lineChart($('#jr-curve', host), [{ name: 'Cumulative P&L', points: m.curve }], { height: 200, zeroLine: true, fmt: inrS, label: 'Cumulative realized P&L of closed journal trades' });
  }
  var CSV_COLS = [
    ['id', 'ID'], ['sym', 'Symbol'], ['side', 'Side'], ['status', 'Status'], ['entryDate', 'Entry date'], ['entry', 'Entry price'], ['qty', 'Quantity'],
    ['stop', 'Stop-loss'], ['target', 'Target'], ['fees', 'Entry fees'], ['strategyName', 'Strategy'], ['strategyId', 'Strategy id'], ['strategyVersion', 'Strategy version'],
    ['sigStatus', 'Signal at entry'], ['sigScore', 'Signal score %'], ['sigTriggers', 'Signal triggers'], ['reason', 'Reason for entry'],
    ['exitDate', 'Exit date'], ['exit', 'Exit price'], ['exitFees', 'Exit fees'], ['exitReason', 'Reason for exit']
  ];
  var CSV_CALC = [['pnl', 'Realized P&L'], ['ret', 'Return %'], ['r', 'R multiple'], ['days', 'Holding days'], ['price', 'Current price'], ['priceState', 'Price data state'], ['priceAsOf', 'Price as of'], ['upnl', 'Unrealized P&L']];
  function round2(x) { return isNum(x) ? Math.round(x * 100) / 100 : ''; }
  function exportJournalCsv(P) {
    var rows = [CSV_COLS.concat(CSV_CALC).map(function (c) { return c[1]; })];
    loadTrades().forEach(function (t) {
      var s = P.ctx.bySym[t.sym], c = calc(t, s), g = t.signal;
      var x = Object.assign({}, t, { sigStatus: g ? g.statusLabel : '', sigScore: g && isNum(g.score) ? g.score : '', sigTriggers: g ? g.triggersPassed.join(' + ') : '' });
      var cc = t.status === 'closed' ? { pnl: round2(c.pnl), ret: round2(c.ret), r: round2(c.r), days: isNum(c.days) ? c.days : '' } :
        { days: isNum(c.days) ? c.days : '', price: isNum(c.price) ? c.price : '', priceState: c.state, priceAsOf: c.asOf || '', upnl: round2(c.upnl) };
      rows.push(CSV_COLS.map(function (k) { var v = x[k[0]]; return v == null ? '' : v; }).concat(CSV_CALC.map(function (k) { return cc[k[0]] == null ? '' : cc[k[0]]; })));
    });
    ui.download('stock-blueprint-journal-' + stamp() + '.csv', ui.toCsv(rows));
  }
  function exportJournalJson() {
    var data = { kind: 'stock-blueprint.trade-journal', version: 1, exportedAt: istNow() + ' IST', note: 'Manual journal records - not broker positions. Personal file from Stock Blueprint (this browser only).', trades: loadTrades() };
    ui.download('stock-blueprint-journal-' + stamp() + '.json', JSON.stringify(data, null, 2), 'application/json');
  }
  function parseCsv(text) {
    var rows = [], row = [], f = '', q = false, i, c;
    text = String(text).replace(/^﻿/, '');
    for (i = 0; i < text.length; i++) {
      c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
      else f += c;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (x) { return String(x).trim() !== ''; }); });
  }
  function csvToTrades(text) {
    var rows = parseCsv(text);
    if (rows.length < 2) return null;
    var alias = { symbol: 'sym', 'entry price': 'entry', quantity: 'qty', qty: 'qty', 'stop-loss': 'stop', stoploss: 'stop', 'stop loss': 'stop', 'exit price': 'exit', fees: 'fees' };
    CSV_COLS.forEach(function (c) { alias[c[1].toLowerCase()] = c[0]; alias[c[0].toLowerCase()] = c[0]; });
    var head = rows[0].map(function (h) { return alias[String(h).trim().toLowerCase()] || null; });
    if (head.indexOf('sym') < 0) return null;
    return rows.slice(1).map(function (r) {
      var o = {};
      head.forEach(function (k, i) { if (k && r[i] != null && String(r[i]).trim() !== '') o[k] = String(r[i]).trim(); });
      if (o.status) o.status = String(o.status).toLowerCase();
      if (o.sigStatus) o.signal = { statusLabel: o.sigStatus, score: toNum(o.sigScore), triggersPassed: o.sigTriggers ? o.sigTriggers.split(' + ') : [], strategyName: o.strategyName || '', strategyVersion: o.strategyVersion };
      if (o.signal && !isNum(o.signal.score)) o.signal.score = null;
      return o;
    });
  }
  function importJournal(P, text, name) {
    var raw, isCsv = /\.csv$/i.test(name) || !/^\s*[[{]/.test(text);
    if (isCsv) raw = csvToTrades(text);
    else {
      try { var j = JSON.parse(text); raw = Array.isArray(j) ? j : j && Array.isArray(j.trades) ? j.trades : j && Array.isArray(j.entries) ? j.entries : null; } catch (e) { raw = null; }
    }
    if (!raw) { msg(P, 'jr-io-msg', 'bad', '<strong>Not imported:</strong> ' + esc(name) + ' is not a journal file (use Export JSON or Export CSV from this page; a CSV needs a "Symbol" column).'); return; }
    var errs = [], trades = loadTrades(), byId = {}, added = 0, updated = 0;
    trades.forEach(function (t, i) { byId[t.id] = i; });
    raw.forEach(function (r, i) {
      var t = cleanTrade(r, errs, (isCsv ? 'row ' + (i + 2) : 'trade ' + (i + 1)), null);
      if (!t) return;
      if (t.id in byId) { trades[byId[t.id]] = t; updated++; } else { byId[t.id] = trades.length; trades.push(t); added++; }
    });
    if ((added || updated) && !saveTrades(trades)) { msg(P, 'jr-io-msg', 'bad', esc(STORE_FAIL)); return; }
    msg(P, 'jr-io-msg', added + updated ? 'good' : 'bad', '<strong>' + (added + updated ? 'Imported from ' : 'Nothing imported from ') + esc(name) + ':</strong> ' + added + ' new, ' + updated + ' updated' +
      (errs.length ? ', ' + errs.length + ' skipped' + listHtml(errs.slice(0, 8)) + (errs.length > 8 ? '<span class="sub">…and ' + (errs.length - 8) + ' more</span>' : '') : '.'));
    journalChanged(P);
  }

  // ======================================================================
  // 4. Risk management
  // ======================================================================
  function buildRisk(P) {
    $('#sec-risk', P.el).innerHTML =
      '<div class="note warn" role="note"><strong>Caution.</strong> Stop-loss orders are not guaranteed to fill at the stop price - gaps, circuit limits and fast markets can fill them worse, so the real loss can be larger than the risk shown. ' +
      'Brokerage, taxes and slippage are included only when you set "Costs % per side" (0 = not modelled, none shown). These are planning numbers, not advice and not a promise of any result.</div>' +
      '<div class="grid g2"><section class="card"><div id="rk-set"></div><div id="rk-set-msg" style="margin-top:10px"></div></section>' +
      '<section class="card"><div class="card-head"><div><h2>Position-size calculator</h2><p>Quantity = floor(risk budget ÷ risk per share), then capped by your heat, exposure, category, position and daily-loss limits. Uses your <b>saved</b> settings and your open journal positions.</p></div></div>' +
      '<div id="rk-calc"></div><div id="rk-out" style="margin-top:14px"></div></section></div>' +
      '<section class="card"><div class="card-head"><div><h2>Portfolio risk</h2><p>From the open positions in your trade journal (manual records - not broker positions). A position without a stop-loss counts as fully at risk.</p></div></div><div id="rk-port"></div></section>';
  }
  function drawRiskForm(P) {
    var r = loadRisk(), s = r.s;
    var h = '<div class="card-head"><div><h2>Risk settings</h2><p>' + (r.saved ? 'Saved in this browser only.' : 'Not saved yet - these are default values (capital, risk %, heat and daily-loss defaults mirror your sheet\'s Control Panel defaults), not your own. Enter yours and save.') + '</p></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" type="button" data-act="rk-export">Export JSON</button><button class="btn" type="button" data-act="rk-import">Import JSON</button>' +
      '<input type="file" id="rk-file" accept=".json,application/json" hidden></div></div>' +
      '<form id="rk-sform" novalidate><div class="form-grid">' + RISK_FIELDS.map(function (f) {
        return '<label class="field"><span>' + esc(f[1]) + '</span>' + numInput('rk-' + f[0], s[f[0]], f[3]) + '<span class="sub">' + esc(f[2]) + '</span></label>';
      }).join('') +
      '<label class="field" style="align-content:start"><span>Short selling</span><span style="display:flex;gap:8px;align-items:center;min-height:34px"><input class="inp" type="checkbox" id="rk-allowShort"' + (s.allowShort ? ' checked' : '') + '> Allow short trades</span>' +
      '<span class="sub">Off = long only (journal and calculator)</span></label></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px"><button class="btn primary" type="submit">Save settings</button><button class="btn danger" type="button" data-act="rk-reset">Reset to defaults</button></div></form>';
    $('#rk-set', P.el).innerHTML = h;
  }
  function saveRiskForm(P) {
    var o = {}, errs = [];
    RISK_FIELDS.forEach(function (f) {
      var raw = fval(P, 'rk-' + f[0]);
      if (raw === '') { errs.push(f[1] + ' is required'); return; }
      var n = toNum(raw);
      if (!isNum(n)) errs.push(f[1] + ' must be a number'); else o[f[0]] = n;
    });
    o.allowShort = !!($('#rk-allowShort', P.el) || {}).checked;
    var v = SB.risk.validateSettings(o);
    errs = errs.concat(v.errors, errs.length ? [] : checkSettings(v.settings));
    if (errs.length) { msg(P, 'rk-set-msg', 'bad', '<strong>Not saved:</strong>' + listHtml(errs)); return; }
    if (!ui.store.set(K.risk, v.settings)) { msg(P, 'rk-set-msg', 'bad', esc(STORE_FAIL)); return; }
    riskChanged(P);
    msg(P, 'rk-set-msg', 'good', '<strong>Saved.</strong> Capital ' + F.inr(v.settings.capital) + ', risk ' + F.num(v.settings.riskPct, 2) + '% per trade (' + F.inr(v.settings.capital * v.settings.riskPct / 100) + '), heat limit ' + F.num(v.settings.maxHeatPct, 2) + '%.');
  }
  function riskChanged(P) {
    drawRiskForm(P); drawCalc(P, true); drawCalcOut(P); drawPortfolio(P); drawReview(P, loadTrades().filter(function (t) { return t.status === 'closed'; }));
    var keep = P.editId;
    if (!keep) drawJForm(P, readPrefillFromForm(P)); else drawJForm(P);
  }
  function readPrefillFromForm(P) {
    if (!$('#jr-form', P.el)) return null;
    return { sym: fval(P, 'jr-sym'), side: fval(P, 'jr-side'), entryDate: fval(P, 'jr-edate'), entry: fval(P, 'jr-entry'), qty: fval(P, 'jr-qty'), stop: fval(P, 'jr-stop'),
      target: fval(P, 'jr-target'), fees: fval(P, 'jr-fees'), strategyId: fval(P, 'jr-strat'), reason: fval(P, 'jr-reason') };
  }
  function drawCalc(P, keepValues, pre) {
    var risk = loadRisk().s, old = keepValues && $('#rk-cform', P.el) ? { sym: fval(P, 'rk-sym'), side: fval(P, 'rk-side'), entry: fval(P, 'rk-entry'), stop: fval(P, 'rk-stop'), target: fval(P, 'rk-target') } : (pre || {});
    $('#rk-calc', P.el).innerHTML = '<form id="rk-cform" novalidate><div class="form-grid">' +
      fieldHtml('Symbol (optional)', symInput('rk-sym', old.sym, 'any watchlist symbol')) +
      fieldHtml('Side', '<select class="sel" id="rk-side" style="width:100%"><option value="long">Long</option><option value="short"' + (risk.allowShort ? '' : ' disabled') + '>Short' + (risk.allowShort ? '' : ' (off in settings)') + '</option></select>') +
      fieldHtml('Entry (₹)', numInput('rk-entry', old.entry)) + fieldHtml('Stop-loss (₹)', numInput('rk-stop', old.stop)) + fieldHtml('Target (₹, optional)', numInput('rk-target', old.target)) +
      '</div><div id="rk-sym-info" class="sub" style="margin-top:8px"></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><button class="btn" type="button" data-act="rk-usepx">Use current price</button><button class="btn" type="button" data-act="rk-uselv">Use strategy stop &amp; target</button>' +
      '<button class="btn primary" type="button" data-act="rk-tojournal">Add to journal…</button><button class="btn" type="button" data-act="rk-clear">Clear</button></div></form>';
    $('#rk-side', P.el).value = old.side === 'short' && risk.allowShort ? 'short' : 'long';
    updateCalcSym(P);
  }
  function updateCalcSym(P) {
    var box = $('#rk-sym-info', P.el);
    if (!box) return;
    var sym = fval(P, 'rk-sym').toUpperCase(), s = P.ctx.bySym[sym];
    if (!sym) { box.innerHTML = 'Pick a symbol to prefill the entry from its price and apply your per-category limit, or just type the numbers.'; return; }
    if (!s) { box.innerHTML = '<span class="down">' + esc(sym) + ' is not in your watchlist data.</span>'; return; }
    var r = P.run && P.run.bySym[sym];
    box.innerHTML = '<b>' + esc(s.sym) + '</b> ' + esc(s.name || '') + ' · ' + esc(s.catName || 'Unclassified') + ' · ' + rupee(s.price) + ' ' + ui.stateBadge(s.priceState, s.priceAsOf) +
      (r && r.stop > 0 ? '<br>Active strategy levels: stop ' + rupee(r.stop) + ' (' + esc(r.stopNote || '') + '), target ' + rupee(r.target) + ' · ' + ui.badge(r.statusLabel) + ' ' + stratBadge(P.run.config.source, SB.strategies.isConfirmed(P.run.config.id)) : '');
  }
  function drawCalcOut(P) {
    var box = $('#rk-out', P.el);
    if (!box || !$('#rk-cform', P.el)) return;
    var risk = loadRisk().s, sym = fval(P, 'rk-sym').toUpperCase(), s = P.ctx.bySym[sym];
    var input = { entry: toNum(fval(P, 'rk-entry')), stop: toNum(fval(P, 'rk-stop')), target: toNum(fval(P, 'rk-target')), side: fval(P, 'rk-side') === 'short' ? 'short' : 'long', industry: s ? s.catName : null };
    if (!isNum(input.entry) && !isNum(input.stop)) { box.innerHTML = '<p class="empty">Enter an entry price and a stop-loss to size a position.</p>'; P.lastSize = null; return; }
    var rc = riskContext(P), z = SB.risk.sizePosition(input, risk, rc);
    P.lastSize = { z: z, input: input, sym: s ? sym : '' };
    var lv = P.levelsSrc && P.levelsSrc.sym === sym && P.levelsSrc.entry === input.entry ? P.levelsSrc : null;
    var h = lv ? '<p class="sub" style="margin-bottom:8px">' + esc(lv.text) + '</p>' : '';
    if (z.qty > 0 || z.steps.length) {
      h += '<div class="tiles"' + TILES + '>' +
        ui.tile('Quantity', F.int(z.qty), risk.lotSize > 1 ? 'in lots of ' + F.int(risk.lotSize) : 'shares') +
        ui.tile('Position value', F.inr(z.value), F.num(z.value / risk.capital * 100, 1) + '% of capital') +
        ui.tile('Risk if stopped', F.inr(z.riskAmount), F.num(z.riskAmount / risk.capital * 100, 2) + '% of capital · ' + rupee(z.riskPerUnit) + '/share') +
        ui.tile('Reward : risk', isNum(z.rr) ? '1 : ' + F.num(z.rr, 2) : '–', isNum(z.rr) ? 'reward ' + F.inr(z.reward * z.qty) + ' at target' : 'no valid target') + '</div>' +
        '<p class="sub" style="margin-top:8px">' + (risk.costPctPerSide > 0 ? 'Estimated round-trip costs at ' + F.num(risk.costPctPerSide, 2) + '% per side: ' + F.inr(z.costs) + ' (not included in the risk above).' : 'Costs and taxes are not modelled (Costs % per side = 0).') + '</p>';
    }
    if (z.errors.length) h += '<div class="note bad" style="margin-top:10px"><strong>' + (z.qty > 0 ? 'Problems' : 'Cannot size this trade') + ':</strong>' + listHtml(z.errors) + '</div>';
    if (z.warnings.length) h += '<div class="note warn" style="margin-top:10px"><strong>Warnings:</strong>' + listHtml(z.warnings) + '</div>';
    if (z.steps.length) {
      h += '<details style="margin-top:10px" open><summary style="cursor:pointer"><b>Working</b></summary><ol class="sub" style="margin:6px 0 0 18px;padding:0">' + z.steps.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') +
        (z.qty > 0 ? '<li>' + esc('After limits' + (risk.lotSize > 1 ? ' and lot size ' + risk.lotSize : '') + ': ' + z.qty + ' shares × ₹' + input.entry + ' = ₹' + Math.round(z.value)) + '</li>' : '') + '</ol></details>';
    }
    h += '<p class="sub" style="margin-top:8px">Context used: ' + plural(rc.openPositions.length, 'open journal position') + ' (open risk ' + F.inr(total(rc.openPositions.map(function (p) { return p.risk; }))) + ', value ' +
      F.inr(total(rc.openPositions.map(function (p) { return p.value; }))) + ') · realized today ' + inrS(rc.todayPnl) + ' · capital ' + F.inr(risk.capital) + ', risk ' + F.num(risk.riskPct, 2) + '% per trade.</p>';
    box.innerHTML = h;
  }
  function drawPortfolio(P) {
    var host = $('#rk-port', P.el), risk = loadRisk().s, open = openTrades();
    if (!open.length) {
      host.innerHTML = '<p class="empty">No open journal positions, so portfolio heat is 0%. Record trades in the Trade journal tab to see open risk, heat against your ' + F.num(risk.maxHeatPct, 2) + '% limit and exposure by category.</p>' +
        '<div style="text-align:center"><button class="btn" type="button" data-act="goto-journal">Open the trade journal</button></div>';
      return;
    }
    var pr = SB.journal.portfolio(P.ctx, risk), heatW = Math.min(100, pr.heatPct / pr.heatLimitPct * 100);
    var inds = Object.keys(pr.byIndustry).sort(function (a, b) { return pr.byIndustry[b] - pr.byIndustry[a]; });
    var h = '<div class="tiles"' + TILES + '>' +
      ui.tile('Open positions', F.int(open.length) + ' <span class="sub">/ ' + F.int(risk.maxPositions) + '</span>', 'your maximum is ' + F.int(risk.maxPositions)) +
      ui.tile('Open risk', F.inr(pr.openRisk), 'loss if every stop is hit (fills not guaranteed)') +
      ui.tile('Portfolio heat', '<span class="' + (pr.overHeat ? 'down' : '') + '">' + F.num(pr.heatPct, 2) + '%</span> <span class="sub">/ ' + F.num(pr.heatLimitPct, 2) + '%</span>',
        '<div class="meter" role="meter" aria-label="Heat used" aria-valuemin="0" aria-valuemax="' + pr.heatLimitPct + '" aria-valuenow="' + F.num(pr.heatPct, 2) + '"><span style="width:' + heatW.toFixed(1) + '%"></span></div>') +
      ui.tile('Exposure', F.inr(pr.exposure), F.num(pr.exposurePct, 1) + '% of capital · limit ' + F.num(risk.maxExposurePct, 0) + '%') + '</div>';
    if (pr.overHeat) h += '<div class="note bad" style="margin-top:10px"><strong>Over your heat limit:</strong> open risk is ' + F.num(pr.heatPct, 2) + '% of capital, above your ' + F.num(pr.heatLimitPct, 2) + '% limit - the calculator will not size new trades until it is below.</div>';
    if (open.length >= risk.maxPositions) h += '<div class="note warn" style="margin-top:10px">You are at your maximum of ' + F.int(risk.maxPositions) + ' open positions.</div>';
    if (pr.exposurePct > risk.maxExposurePct) h += '<div class="note warn" style="margin-top:10px">Exposure ' + F.num(pr.exposurePct, 1) + '% is above your ' + F.num(risk.maxExposurePct, 0) + '% maximum.</div>';
    h += '<div class="grid g2" style="margin-top:14px"><div><h3 style="margin-bottom:6px">Exposure by industry category</h3>' +
      ui.bars(inds.map(function (k) { var x = pr.byIndustry[k]; return { label: k, value: x, tip: k + ': ' + F.inr(x) + ' · ' + F.num(x / risk.capital * 100, 1) + '% of capital' }; }), { fmt: F.inr }) +
      (risk.maxIndustryPct > 0 ? '<p class="sub" style="margin-top:6px">Your per-category limit: ' + F.num(risk.maxIndustryPct, 0) + '% of capital (' + F.inr(risk.capital * risk.maxIndustryPct / 100) + ').</p>' : '<p class="sub" style="margin-top:6px">No per-category limit set.</p>') +
      '</div><div><h3 style="margin-bottom:6px">Risk by position</h3><div id="rk-pos"></div></div></div>';
    host.innerHTML = h;
    var rows = open.map(function (t) {
      var s = P.ctx.bySym[t.sym], c = calc(t, s);
      return { sym: t.sym, name: s ? s.name : '', side: t.side === 'short' ? 'Short' : 'Long', value: c.cost, risk: c.risk, pct: c.risk / risk.capital * 100, stop: t.stop };
    });
    new ui.Table({
      rows: rows, pageSize: 10, sort: { key: 'risk', dir: -1 },
      columns: [
        { key: 'sym', label: 'Stock', type: 'sym', name: 'name' },
        { key: 'side', label: 'Side' },
        { key: 'value', label: 'Value', type: 'num', html: function (x) { return F.inr(x.value); } },
        { key: 'risk', label: 'Risk', type: 'num', html: function (x) { return F.inr(x.risk) + (x.stop > 0 ? '' : ' <span class="sub">no stop</span>'); } },
        { key: 'pct', label: '% of capital', type: 'num', digits: 2 }
      ]
    }).mount($('#rk-pos', host));
  }
  function exportRisk() {
    var data = { kind: 'stock-blueprint.risk-settings', version: 1, exportedAt: istNow() + ' IST', note: 'Personal file - your risk settings from Stock Blueprint (this browser only).', settings: loadRisk().s };
    ui.download('stock-blueprint-risk-settings-' + stamp() + '.json', JSON.stringify(data, null, 2), 'application/json');
  }
  function importRisk(P, text, name) {
    var j;
    try { j = JSON.parse(text); } catch (e) { msg(P, 'rk-set-msg', 'bad', '<strong>Not imported:</strong> ' + esc(name) + ' is not valid JSON.'); return; }
    var raw = j && typeof j === 'object' && j.settings && typeof j.settings === 'object' ? j.settings : j;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.keys(SB.risk.DEFAULTS).some(function (k) { return k in raw; })) {
      msg(P, 'rk-set-msg', 'bad', '<strong>Not imported:</strong> no risk settings found in ' + esc(name) + '.'); return;
    }
    var v = SB.risk.validateSettings(raw), errs = v.errors.concat(checkSettings(v.settings));
    if (errs.length) { msg(P, 'rk-set-msg', 'bad', '<strong>Not imported from ' + esc(name) + ':</strong>' + listHtml(errs)); return; }
    if (!ui.store.set(K.risk, v.settings)) { msg(P, 'rk-set-msg', 'bad', esc(STORE_FAIL)); return; }
    riskChanged(P);
    msg(P, 'rk-set-msg', 'good', '<strong>Imported risk settings from ' + esc(name) + '.</strong> Missing fields were filled with the defaults.');
  }

  // ======================================================================
  // page plumbing
  // ======================================================================
  /** One Table per host, re-used on redraw (a fresh mount would stack listeners on the same element). */
  /** Empty states are shown as a wrapping paragraph instead of a cut-off nowrap table cell. */
  function tableIn(P, name, host, opts) {
    var t = P.tables[name];
    if (!t) {
      host.innerHTML = '<div></div><p class="empty" hidden></p>';
      t = P.tables[name] = new ui.Table(opts).mount(host.firstChild);
    } else t.setRows(opts.rows);
    var none = !opts.rows.length;
    host.firstChild.hidden = none;
    host.lastChild.hidden = !none;
    host.lastChild.textContent = none ? opts.empty || 'Nothing to show' : '';
    return t;
  }
  function updateTabCounts(P) {
    var on = loadRules().filter(function (r) { return r.enabled; }).length, open = openTrades().length;
    var L = { sheet: 'Sheet alerts (' + ui.objRows(P.ctx.D.alerts).length + ')', rules: 'My alert rules (' + on + ' on)', journal: 'Trade journal (' + open + ' open)', risk: 'Risk & position size' };
    P.el.querySelectorAll('[data-chip="al-tab"]').forEach(function (b) { b.textContent = L[b.getAttribute('data-v')]; });
  }
  /** Scroll so the element sits just below the sticky header. */
  function scrollToEl(node) {
    if (!node) return;
    var top = document.querySelector('.top'), off = top ? top.getBoundingClientRect().height : 0;
    window.scrollTo(0, Math.max(0, node.getBoundingClientRect().top + window.pageYOffset - off - 10));
  }
  function focusIn(node) {
    if (!node) return;
    var f = node.matches('input,select,textarea,button,[tabindex]') ? node : node.querySelector('input:not([type=hidden]):not([hidden]),select,textarea,button,[tabindex]');
    if (f) f.focus({ preventScroll: true });
  }
  function setTab(P, tab, focusSel) {
    ST.tab = tab;
    P.el.querySelectorAll('[data-chip="al-tab"]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-v') === tab)); });
    P.el.querySelectorAll('[data-sec]').forEach(function (s) { s.hidden = s.getAttribute('data-sec') !== tab; });
    try { if (window.history && window.history.replaceState) window.history.replaceState(null, '', '#alerts/' + tab); } catch (e) { /* ignore */ }
    if (focusSel) { var f = $(focusSel, P.el); scrollToEl(f); focusIn(f); }
  }
  function useLevels(P, prefix) {
    var sym = fval(P, prefix + '-sym').toUpperCase(), s = P.ctx.bySym[sym], box = prefix === 'jr' ? 'jr-msg' : 'rk-out';
    if (!s) { msg(P, box, 'warn', 'Choose a watchlist symbol first.'); return false; }
    if (!P.run) { msg(P, box, 'warn', P.runErr ? 'The strategy could not run: ' + esc(P.runErr) : 'The strategy is still loading - try again in a moment.'); return false; }
    var r = P.run.bySym[sym];
    if (!r || !(r.stop > 0)) { msg(P, box, 'warn', 'The active strategy has no stop-loss for ' + esc(sym) + (r ? ' (' + esc(r.stopNote || r.statusLabel) + ')' : '') + '.'); return false; }
    // stop and target are computed from the strategy's entry reference, so the entry is filled with it too
    $('#' + prefix + '-entry', P.el).value = String(r.entry);
    $('#' + prefix + '-stop', P.el).value = String(Math.round(r.stop * 100) / 100);
    $('#' + prefix + '-target', P.el).value = r.target > 0 ? String(Math.round(r.target * 100) / 100) : '';
    if (prefix === 'rk') P.levelsSrc = { sym: sym, entry: r.entry, text: 'Entry ' + rupee(r.entry) + ' = close of ' + F.date(r.asOf || P.run.dataAsOf) + '; stop and target from ' + P.run.config.name + ' v' + P.run.config.version +
      (P.run.config.source === 'demo' ? ' (DEMO strategy - testing only)' : SB.strategies.isConfirmed(P.run.config.id) ? '' : ' (unconfirmed rules)') + '.' };
    if (prefix === 'jr') msg(P, 'jr-msg', P.run.config.source === 'demo' ? 'warn' : '', 'Filled entry ' + rupee(r.entry) + ' (close of ' + esc(F.date(r.asOf || P.run.dataAsOf)) + '), stop ' + rupee(r.stop) +
      (r.target > 0 ? ' and target ' + rupee(r.target) : '') + ' from ' + esc(P.run.config.name + ' v' + P.run.config.version) +
      (P.run.config.source === 'demo' ? ' - a DEMO strategy, for testing only.' : SB.strategies.isConfirmed(P.run.config.id) ? '.' : ' (unconfirmed rules). Check them against your own plan.'));
    return true;
  }
  function usePrice(P, prefix) {
    var sym = fval(P, prefix + '-sym').toUpperCase(), s = P.ctx.bySym[sym];
    if (!s || !isNum(s.price)) { msg(P, prefix === 'jr' ? 'jr-msg' : 'rk-out', 'warn', s ? 'No current price for ' + esc(sym) + '.' : 'Choose a watchlist symbol first.'); return false; }
    $('#' + prefix + '-entry', P.el).value = String(s.price);
    return true;
  }
  function onFile(P, input, fn, msgId) {
    var file = input.files && input.files[0];
    if (!file) return;
    readFile(file, function (err, text) {
      input.value = '';
      if (!P.el.isConnected) return;
      if (err) { msg(P, msgId, 'bad', '<strong>Not imported:</strong> ' + esc(err.message)); return; }
      fn(P, text, file.name);
    });
  }

  function bind(P) {
    var el = P.el;
    ui.bindChips(el, 'al-tab', function (v) { setTab(P, v); });
    ui.bindChips(el, 'sa-out', function (v) { ST.logF = v; applySheet(P); });
    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b || !el.contains(b)) return;
      var act = b.getAttribute('data-act'), id = b.getAttribute('data-id'), rules, t;
      switch (act) {
        case 'sa-csv': if (P.sheetLog) ui.download('sheet-alert-log.csv', ui.toCsv(P.sheetLog.toCsvRows())); break;
        case 'rules-check': msg(P, 'ar-list-msg', '', ''); checkRules(P, 'Check now'); break;
        case 'rules-export': exportRules(); break;
        case 'rules-import': $('#ar-file', el).click(); break;
        case 'rule-toggle':
          rules = loadRules();
          rules.forEach(function (r) {
            if (r.id !== id) return;
            if (r.enabled) r.enabled = false; else { r.enabled = true; r.done = false; r.armed = true; }
            msg(P, 'ar-list-msg', '', esc(r.sym + ' - ' + ruleText(r)) + (r.enabled ? ' is on again. It fires when data newer than the last firing meets the condition (press Check now).' : ' is off - it will not fire until you turn it on.'));
          });
          if (!saveRules(rules)) msg(P, 'ar-list-msg', 'bad', esc(STORE_FAIL));
          drawRuleList(P); updateTabCounts(P);
          break;
        case 'rule-del':
          if (!confirmTwice(b, 'Delete?')) return;
          rules = loadRules().filter(function (r) { return r.id !== id; });
          if (!saveRules(rules)) { msg(P, 'ar-list-msg', 'bad', esc(STORE_FAIL)); return; }
          delete P.evals[id];
          msg(P, 'ar-list-msg', '', 'Rule deleted. Its past firings stay in the history.');
          drawRuleList(P); updateTabCounts(P);
          break;
        case 'hist-csv': if (P.tables.hist) ui.download('stock-blueprint-alert-history-' + stamp() + '.csv', ui.toCsv(P.tables.hist.toCsvRows())); break;
        case 'hist-clear':
          if (!loadHist().length) { msg(P, 'ar-hist-msg', '', 'The history is already empty.'); return; }
          if (!confirmTwice(b, 'Click again to clear')) return;
          if (!saveHist([])) { msg(P, 'ar-hist-msg', 'bad', esc(STORE_FAIL)); return; }
          P.fired = []; drawTop(P); drawHist(P);
          msg(P, 'ar-hist-msg', '', 'History cleared.');
          break;
        case 'goto-rules': setTab(P, 'rules', '#ar-hist'); break;
        case 'goto-journal': setTab(P, 'journal', '#jr-sym'); break;
        case 'top-dismiss': P.fired = []; drawTop(P); break;
        case 'jr-usepx': if (usePrice(P, 'jr')) updateJPrev(P); break;
        case 'jr-uselv': if (useLevels(P, 'jr')) updateJPrev(P); break;
        case 'jr-cancel': P.editId = null; drawJForm(P); msg(P, 'jr-msg', '', ''); break;
        case 'jr-clear': drawJForm(P, {}); msg(P, 'jr-msg', '', ''); break;
        case 'jr-edit':
          P.editId = id; P.closeId = null; drawClose(P); drawJForm(P); msg(P, 'jr-msg', '', '');
          scrollToEl($('#jr-form-card', el));
          $('#jr-sym', el).focus({ preventScroll: true });
          break;
        case 'jr-close': P.closeId = id; drawClose(P); break;
        case 'jr-cclose': P.closeId = null; drawClose(P); break;
        case 'jr-del':
          if (!confirmTwice(b, 'Delete?')) return;
          t = findTrade(id);
          if (!saveTrades(loadTrades().filter(function (x) { return x.id !== id; }))) { msg(P, 'jr-io-msg', 'bad', esc(STORE_FAIL)); return; }
          if (P.editId === id) { P.editId = null; drawJForm(P); }
          if (P.closeId === id) { P.closeId = null; drawClose(P); }
          msg(P, 'jr-io-msg', '', 'Deleted the ' + esc(t ? t.sym : '') + ' journal record.');
          journalChanged(P);
          break;
        case 'jr-export-json': exportJournalJson(); break;
        case 'jr-export-csv': exportJournalCsv(P); break;
        case 'jr-import': $('#jr-file', el).click(); break;
        case 'rk-export': exportRisk(); break;
        case 'rk-import': $('#rk-file', el).click(); break;
        case 'rk-reset':
          if (!confirmTwice(b, 'Click again to reset')) return;
          ui.store.del(K.risk);
          riskChanged(P);
          msg(P, 'rk-set-msg', '', 'Reset to the default values (not saved as your own until you press Save settings).');
          break;
        case 'rk-usepx': if (usePrice(P, 'rk')) drawCalcOut(P); break;
        case 'rk-uselv': if (useLevels(P, 'rk')) drawCalcOut(P); break;
        case 'rk-clear': drawCalc(P, false, {}); drawCalcOut(P); break;
        case 'rk-tojournal':
          var z = P.lastSize;
          if (!z || !z.z.ok) { drawCalcOut(P); var o = $('#rk-out', el); o.insertAdjacentHTML('afterbegin', '<div class="note warn" style="margin-bottom:10px">Size a valid trade first (symbol, entry and stop-loss).</div>'); return; }
          if (!z.sym) { var o2 = $('#rk-out', el); o2.insertAdjacentHTML('afterbegin', '<div class="note warn" style="margin-bottom:10px">Choose the symbol first, so the journal knows which stock it is.</div>'); return; }
          P.editId = null;
          drawJForm(P, { sym: z.sym, side: z.input.side, entry: z.input.entry, stop: z.input.stop, target: isNum(z.input.target) ? z.input.target : null, qty: z.z.qty, entryDate: istToday() });
          msg(P, 'jr-msg', '', 'Prefilled from the position-size calculator - check the numbers and press Add trade. Nothing is placed with any broker.');
          setTab(P, 'journal', '#jr-form-card');
          break;
      }
    });
    el.addEventListener('submit', function (e) {
      var f = e.target;
      e.preventDefault();
      if (f.id === 'ar-form') addRule(P);
      else if (f.id === 'jr-form') saveTradeForm(P);
      else if (f.id === 'jr-cform') closeTrade(P);
      else if (f.id === 'rk-sform') saveRiskForm(P);
      else if (f.id === 'rk-cform') drawCalcOut(P);
    });
    var timer, jTimer;
    el.addEventListener('input', function (e) {
      var id = e.target.id || '';
      if (id === 'sa-q') { clearTimeout(timer); timer = setTimeout(function () { ST.logQ = e.target.value.trim(); applySheet(P); }, 120); }
      else if (/^ar-(sym|type)$/.test(id)) updateRuleHelp(P);
      else if (id === 'jr-q') { clearTimeout(jTimer); jTimer = setTimeout(function () { ST.jq = e.target.value; drawJTables(P); }, 120); }
      else if (/^jr-c/.test(id)) updateClosePrev(P);
      else if (/^jr-(sym|entry|stop|target|side)$/.test(id)) updateJPrev(P);
      else if (/^rk-(sym|entry|stop|target|side)$/.test(id)) {
        if (id === 'rk-sym') {
          var s = P.ctx.bySym[fval(P, 'rk-sym').toUpperCase()];
          if (s && isNum(s.price) && !fval(P, 'rk-entry')) $('#rk-entry', el).value = String(s.price);   // prefill entry from the price
          updateCalcSym(P);
        }
        drawCalcOut(P);
      }
    });
    el.addEventListener('change', function (e) {
      var id = e.target.id || '';
      if (id === 'sa-type') { ST.logType = e.target.value; applySheet(P); }
      else if (id === 'ar-type' || id === 'ar-sym') updateRuleHelp(P);
      else if (id === 'jr-side' || id === 'jr-sym') updateJPrev(P);
      else if (id === 'rk-side' || id === 'rk-sym') { updateCalcSym(P); drawCalcOut(P); }
      else if (id === 'ar-file') onFile(P, e.target, importRules, 'ar-list-msg');
      else if (id === 'jr-file') onFile(P, e.target, importJournal, 'jr-io-msg');
      else if (id === 'rk-file') onFile(P, e.target, importRisk, 'rk-set-msg');
    });
  }

  SB.page('alerts', {
    render: function (el, params, ctx) {
      var P = { el: el, ctx: ctx, run: null, runErr: null, runP: null, checking: null, lastCheck: null, evals: {}, fired: [], editId: null, closeId: null, tables: {}, lastSize: null };
      var want = params[0], known = TABS.some(function (t) { return t[0] === want; });
      var tab = known ? want : ST.tab || 'sheet';
      var preSym = known && params[1] ? String(params[1]).toUpperCase() : '';
      if (preSym && !ctx.bySym[preSym]) preSym = '';
      ST.tab = tab;
      var h = '<div class="page-head"><div><h1>Alerts &amp; trades</h1><p>Your sheet\'s watch alerts, your own alert rules, a manual trade journal and position sizing. ' +
        'Rules, journal and risk settings are saved <strong>only in this browser</strong> (localStorage) - nothing is uploaded or shared; use the Export buttons to back them up. ' +
        'No orders are placed and no broker is connected.</p></div></div>';
      h += '<div class="controls" style="margin-bottom:0">' + ui.chips('al-tab', TABS, tab) + '</div><div id="al-top" hidden></div>';
      TABS.forEach(function (t) {
        h += '<div data-sec="' + t[0] + '"' + (t[0] === tab ? '' : ' hidden') + ' role="region" aria-label="' + esc(t[1]) + '"><div style="display:grid;gap:16px;min-width:0" id="sec-' + t[0] + '"></div></div>';
      });
      h += '<datalist id="al-syms">' + ctx.stocks.map(function (s) { return '<option value="' + esc(s.sym) + '">' + esc(s.name || '') + '</option>'; }).join('') + '</datalist>';
      el.innerHTML = h;

      buildSheet(P);
      buildRules(P, tab === 'rules' ? preSym : '');
      buildJournal(P);
      buildRisk(P);
      drawJForm(P, tab === 'journal' && preSym ? { sym: preSym, entry: isNum(ctx.bySym[preSym].price) ? ctx.bySym[preSym].price : null } : null);
      drawJTables(P);
      drawRiskForm(P);
      drawCalc(P, false, tab === 'risk' && preSym ? { sym: preSym, entry: isNum(ctx.bySym[preSym].price) ? ctx.bySym[preSym].price : '' } : {});
      drawCalcOut(P);
      drawPortfolio(P);
      drawRuleList(P);
      drawHist(P);
      updateTabCounts(P);
      bind(P);
      try { if (window.history && window.history.replaceState) window.history.replaceState(null, '', '#alerts/' + tab + (preSym ? '/' + encodeURIComponent(preSym) : '')); } catch (e) { /* ignore */ }

      // rules are evaluated when the page opens; the strategy is loaded for the journal's signal snapshot too
      checkRules(P, 'when the page opened');
      ensureRun(P).then(function () {
        if (!el.isConnected) return;
        updateJPrev(P); updateCalcSym(P); updateRuleHelp(P);
        if (!P.checking) drawRuleList(P);
      });
      autoCheck(P);
    }
  });
})();
