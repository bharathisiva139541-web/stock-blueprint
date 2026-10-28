'use strict';
// End-to-end contract of the live site feed (options 2 + 3), with no network:
//
//   real Code.gs doPost (Apps Script mock, synthetic workbook)
//     -> the exact JSON text doPost returned, through a mocked fetch
//     -> api/site.js, api/quotes.js and api/market-status.js (provider 'sheet')
//     -> the reply the browser reads (web/app.js boot / prepare / loadHistory /
//        initMarket, web/ui/strategy-state.js candles).
//
// The browser's own functions (prepare, validMain, validHistory, sheetState,
// apiBaseFor, candles, candleState) are taken from the web/ sources and run
// here, so this test follows those files. The live JSON must also have the
// same shape as the saved copy web/data/dashboard.js / history.js that every
// page was written against. Fake secrets only; nothing leaves the process.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const mock = require('./fixtures/apps-script-mock.js');
const cal = require('../api/_lib/market-calendar');
const cacheLib = require('../api/_lib/cache');
const fetchUtil = require('../api/_lib/fetch-util');
const siteApi = require('../api/site');
const quotesApi = require('../api/quotes');
const statusApi = require('../api/market-status');
const classify = require('../web/lib/classify.js');
const strategy = require('../web/lib/strategy.js');
const eod = require('../web/lib/eod.js');
const historyLib = require('../web/lib/history.js');

globalThis.fetch = function () { return Promise.reject(new TypeError('network disabled in tests')); };

const ROOT = path.join(__dirname, '..');
const read = function (f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); };

// Fake secrets (never real values)
const FEED_TOKEN = 'feed_FAKE_TOKEN_0123456789';
const BRIDGE_TOKEN = 'bridge_FAKE_TOKEN_9876543210';
const EXEC_URL = 'https://script.google.com/macros/s/AKfycbFAKEdeploymentIdForTests0123456789/exec';
const ENV = { SHEET_FEED_URL: EXEC_URL, SHEET_FEED_TOKEN: FEED_TOKEN };
const PROPS = { AB_FEED_TOKEN: FEED_TOKEN, AB_BRIDGE_TOKEN: BRIDGE_TOKEN };
const OWNER_MAIL = 'owner@example.com';
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;

const IST = function (s) { return cal.parseIstDateTime(s); };
const WED_OPEN = '2026-10-21 11:00';      // Wednesday, session open (Tue 20 Oct is Dussehra)
const MAIN_CC = 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600';
const HISTORY_CC = 'public, max-age=0, s-maxage=1800, stale-while-revalidate=21600';
const STALE_CC = 'public, max-age=0, s-maxage=60';

// The saved copy (made by tools/export_xlsx.py) that the pages were written against.
function windowVar(file, name) { const w = {}; new Function('window', read(file))(w); return w[name]; }
const SAVED = windowVar('web/data/dashboard.js', 'SB_DATA');
const SAVED_HISTORY = windowVar('web/data/history.js', 'SB_HISTORY');

// ---------- synthetic workbook ----------
// [key, Main header, kind] exactly as Code.gs publishes them
const MAIN_COLS = JSON.parse(JSON.stringify(mock.loadCodeGs({ sheets: [] }, { props: {} }).run('AB_SITE_MAIN_COLS')));
// never published: the owner's position columns, an e-mail, the alert-level columns (the snapshot needs those to exist)
const PERSONAL_MAIN = ['Entry Price', 'Stoploss', 'Qty', 'Owner Email', 'Price Fall Alert Price', 'Breakout Alert Price', 'Triggered Y/N'];
const MAIN_HDR = ['Checkbox'].concat(MAIN_COLS.map(function (c) { return c[1]; }).filter(function (h) { return h !== 'Checkbox'; }), PERSONAL_MAIN);

const BASE = {
  sector: 'Information Technology', industry: 'IT - Software', ind: 'Computers - Software & Consulting', idx: 'NIFTY 50',
  rdate: '2026-10-09', done: false, mcap: 100000, chg: 0.5, d10: 0.05, d30: 0.08, hi52: 5000, down52: -0.2, pe: 22.5,
  ipe: 28, pevs: 0.8, ttmEps: 135, lfyEps: 130, epsg: 3.8, peg: 5.9, sig: 'Hold', up: 0.1, sig2: 'Hold', qrev: 2.1,
  qnp: 3.4, yrev: 6.5, ynp: 8.2, promo: 'Stable', fii: 'Buying', opmy: 'Increasing', opmq: 'Slightly Increasing',
  pat: '', fvg: '', e10: '', e21: '', zone: '', volchg: 0.25, ipo: ''
};
// INFY has an Entry Price + Qty and HDFCBANK a Stoploss typed in: their alerts are private.
const STOCKS = [
  { sym: 'TCS', name: 'Tata Consultancy Services', done: true, price: 3050.5, chg: 1.25, tgt: 3500, sig: 'Buy', pat: 'Hammer', 'Owner Email': OWNER_MAIL },
  { sym: 'INFY', name: 'Infosys', price: 1500.25, chg: -0.4, tgt: 1700, 'Entry Price': 1450, Qty: 10 },
  { sym: 'HDFCBANK', name: 'HDFC Bank', sector: 'Financial Services', industry: 'Banks', ind: 'Private Sector Bank', price: 1650, chg: -0.5, Stoploss: 1600 },
  { sym: 'SBIN', name: 'State Bank of India', sector: 'Financial Services', industry: 'Banks', ind: 'Public Sector Bank', price: 812.5, chg: 1.56, tgt: 900 },
  { sym: 'RELIANCE', name: 'Reliance Industries', sector: 'Oil Gas & Consumable Fuels', industry: 'Refineries & Marketing', ind: 'Refineries & Marketing', price: 2900, chg: 0.1 }
];
const SYMS = STOCKS.map(function (s) { return s.sym; });

/** rows + one number format per column for the data rows (row index >= from). */
function sheet(name, rows, colFmts, from) {
  const numFmts = rows.map(function (r, i) {
    return r.map(function (v, j) { return i >= (from || 0) && colFmts && colFmts[j] ? colFmts[j] : null; });
  });
  return { name: name, rows: rows, numFmts: numFmts };
}

function mainSheet(o) {
  const keyOf = {};
  MAIN_COLS.forEach(function (c) { keyOf[c[1]] = c[0]; });
  const rows = STOCKS.map(function (st) {
    const s = Object.assign({}, BASE, st, (o.patch || {})[st.sym] || {});
    return MAIN_HDR.map(function (h) {
      const v = keyOf[h] ? s[keyOf[h]] : s[h];
      return v === undefined ? '' : v;
    });
  });
  rows.splice(2, 0, MAIN_HDR.map(function () { return ''; }));     // a blank row inside the data: skipped
  const fmts = MAIN_HDR.map(function (h) { return h === 'Result Date' ? 'dd/mm/yyyy' : null; });
  return sheet('Main', [['Stock Blueprint']].concat([MAIN_HDR], rows), fmts, 2);
}

/** 30 daily candles per symbol, weekdays up to Mon 19 Oct 2026 (the last session before the 21st). */
const DAYS = (function () {
  const out = [];
  for (let t = Date.UTC(2026, 9, 19); out.length < 30; t -= 864e5) {
    const d = new Date(t), iso = d.toISOString().slice(0, 10);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && iso !== '2026-10-02') out.unshift(iso);
  }
  return out;
})();
function history30(symbols) {
  const r2 = function (v) { return Math.round(v * 100) / 100; };
  const rows = [['Symbol', 'Date', 'Open', 'High', 'Low', 'Close', 'Volume']];
  DAYS.forEach(function (day, i) {
    symbols.forEach(function (sym, k) {
      const c = r2((100 + 40 * k) * (1 + 0.004 * i + 0.01 * Math.sin(i + k)));
      rows.push([sym, day, r2(c * 0.995), r2(c * 1.01), r2(c * 0.99), c, 100000 + 1000 * i]);
    });
  });
  return sheet('History30', rows, [null, 'yyyy-mm-dd'], 1);
}

function patternData() {
  const hdr = [];
  for (let i = 0; i < 27; i++) hdr.push('c' + i);
  hdr[3] = 'Symbol'; hdr[22] = 'Pattern'; hdr[23] = 'Long FVG Touch'; hdr[24] = '10 EMA Support';
  hdr[25] = 'ATR14 (EMA)'; hdr[26] = '21 EMA Support';
  const row = function (sym, pat, fvg, atr) {
    const r = hdr.map(function () { return ''; });
    r[3] = sym; r[22] = pat; r[23] = fvg; r[24] = ''; r[25] = atr; r[26] = 'Support';
    return r;
  };
  return sheet('PatternData', [hdr, row('TCS', 'Hammer', '', 12.5), row('SBIN', '', 'Long FVG', 9.5)]);
}

function workbook(o) {
  o = o || {};
  const sheets = [
    mainSheet(o),
    sheet('Results Tracker', [
      ['Symbol', 'Company', 'Result Date', 'Status', 'Move'],
      ['TCS', 'Tata Consultancy Services', '2026-10-09', 'Updated', 0.0412],
      ['SBIN', 'State Bank of India', '2026-10-16', 'Pending', -0.01]
    ], [null, null, 'dd/mm/yyyy', null, '0.0%'], 1),
    sheet('Results Performance', [
      ['Results Performance'],
      ['Stocks that reported this season - last refreshed 21/10/2026 10:45'],
      [''],
      ['Season', 'Stocks Tracked', 'Avg', 'Median', 'Above', 'Sold off', '', 'Verdict', 'Stocks', 'Avg', 'Positive', 'Day'],
      ['Q2 FY27', 12, 0.034, 0.02, '7 of 12', 3, '', 'Beat', 5, 0.05, 0.8, 0.012],
      ['Best: TCS +8%', 1, '', '', '', '', '', '', '', '', '', ''],
      ['Symbol', 'Result Date', 'Since Result %'],
      ['TCS', '2026-10-09', 0.081]
    ], [null, 'dd/mm/yyyy', '0.00%'], 7),
    sheet('Pattern Dashboard', [
      ['Pattern Dashboard - refreshed 21/10/2026 10:10'],
      ['Stocks Scanned', 'With a pattern'],
      [5, 2],
      [''],
      ['Type', 'Count', 'Avg % Change', '% Advancing'],
      ['Hammer', 1, 0.012, 0.6],
      [''],
      ['Basic Industry', 'Stocks', 'Avg % Change'],
      ['Computers - Software & Consulting', 2, -0.004],
      [''],
      ['Symbol', 'Pattern', '% Change', '10-day %'],
      ['TCS', 'Hammer', 0.0125, 0.05]
    ]),
    sheet('UnmitigatedFVG', [['Symbol', 'Zone Low', 'Zone High', 'Formed'], ['TCS', 3000, 3020, '2026-10-01']], [null, null, null, 'dd-mmm-yyyy'], 1),
    sheet('GapUpFVG', [['Symbol', 'Gap %'], ['SBIN', 0.021]], [null, '0.00%'], 1),
    sheet('Signal Watchlist Log', [['Date Flagged', 'Symbol', 'Signal'], ['2026-10-15', 'TCS', 'Breakout watch']], ['yyyy-mm-dd'], 1),
    sheet('FVG Backtest', [['Flagged On', 'Symbol', 'Result'], ['2026-09-15', 'SBIN', 'Win']], ['yyyy-mm-dd'], 1),
    sheet('Mitigated FVG Log', [['Date', 'Symbol', 'Zone'], ['2026-10-12', 'RELIANCE', 'Long']], ['dd/mm/yyyy'], 1),
    sheet('Alert Log', [
      ['Alert Log'],
      ['Date', 'Time', 'Symbol', 'Company', 'Alert Type', 'Alert Level', 'Trigger Price', 'Entry Price', 'Qty', 'Pattern @ Alert',
        'FVG Tags @ Alert', 'Current Price', '% Since Alert', 'Days Since', 'Outcome', 'Email'],
      ['2026-10-15', '10:30', 'TCS', 'Tata Consultancy Services', 'Breakout', 3000, 3005, '', '', 'Hammer', '', 3050, 1.5, 4, 'Open', OWNER_MAIL],
      ['2026-10-15', '10:31', 'TCS', 'Tata Consultancy Services', 'Entry', 2990, 2990, 2990, 10, '', '', 3050, 2, 4, 'Open', ''],
      ['2026-10-15', '10:32', 'INFY', 'Infosys', 'Breakout', 1500, 1501, '', '', '', '', 1500, 0, 4, 'Open', ''],
      ['2026-10-15', '10:33', 'HDFCBANK', 'HDFC Bank', 'Price Fall', 1660, 1659, '', '', '', '', 1650, -0.6, 4, 'Hit', ''],
      ['2026-10-15', '10:34', 'WIPRO', 'Wipro', 'Breakout', 400, 401, '', '', '', '', 405, 1, 4, 'Open', ''],
      ['2026-10-15', '10:35', 'ITC', 'ITC Ltd', 'Breakout', 410, 411, '', '', '', '', 415, 1, 4, 'Open', ''],
      ['2026-10-15', '10:36', 'LT', 'Larsen & Toubro', 'Price Fall', 3500, 3499, '', '', '', '', 3400, -2, 4, 'Open', ''],
      ['2026-10-16', '09:40', 'SBIN', 'State Bank of India', 'Price Fall', 800, 799, '', '', '', 'Long FVG', 812.5, 1.6, 3, 'Open', ''],
      ['2026-10-16', '09:41', 'RELIANCE', 'Reliance Industries', 'Stop Hit', 2800, 2799, '', '', '', '', 2900, 3, 3, 'Closed', '']
    ], ['yyyy-mm-dd', 'hh:mm'], 2),
    sheet('Trade Log', [['Date', 'Symbol', 'Entry', 'Qty', 'P&L'], ['2026-10-01', 'WIPRO', 400, 10, 50]]),
    sheet('Portfolio', [['My Portfolio'], ['Symbol', 'Qty', 'Avg Price'], ['ITC', 100, 400]]),
    sheet('Risk Manager', [['Capital', 100000], ['Symbol', 'Entry', 'Stop'], ['LT', 3500, 3400]]),
    sheet('Control Panel', [['Setting', 'Value'], ['Email', OWNER_MAIL]]),
    sheet('Trade Dashboard', [['Win rate', 0.6], ['Owner', OWNER_MAIL]]),
    sheet('Indextracker', [['NSE Symbol', 'Price', 'Change'], ['NIFTY 50', 25000, 0.5], ['NIFTY BANK', 52000, -0.2]]),
    sheet('IPOs', [['NSE SYMBOL', 'Company', 'Listing Date'], ['NEWCO', 'New Co', '2026-09-30']], [null, null, 'dd/mm/yyyy'], 1),
    sheet('New IPOs', [['COMPANY NAME', 'Open', 'Close'], ['Alpha Ltd', '22-Oct-2026', '24-Oct-26']]),
    sheet('Price Band Changes', [['Report Date', 'Symbol', 'From', 'To'], ['2026-10-17', 'NEWCO', 0.2, 0.1]], ['yyyy-mm-dd', null, '0%', '0%'], 1),
    sheet('IPO Tracker', [
      ['IPO Tracker - mainboard equity IPOs on NSE (SME and debt issues left out)'],
      ['Updated 2026-10-21 19:28 IST from NSE, read by your PC. Unofficial summary - check the offer document before applying.'],
      [''],
      ['Open now (1)'],
      ['Company', 'Symbol', 'Opens', 'Closes', 'Listing date', 'Price range', 'Issue size (shares)', 'Note'],
      ['BLS Polymers Limited', 'BLSPOLY', '2026-10-20', '2026-10-22', '', '\u20B9142 to \u20B9150', 11900000, 'Closes tomorrow'],
      [''],
      ['Closed - awaiting listing (0)'],
      ['Company', 'Symbol', 'Opens', 'Closes', 'Listing date', 'Price range', 'Issue size (shares)', 'Note'],
      ['None'],
      [''],
      ['Upcoming (1)'],
      ['Company', 'Symbol', 'Opens', 'Closes', 'Listing date', 'Price range', 'Issue size (shares)', 'Note'],
      ['M. K. Sons Fine Jewels Limited', 'MKSONS', '2026-10-28', '2026-10-30', '', '\u20B9153 to \u20B9162', 17000000, 'Opens in 7 days']
    ], [null, null, 'dd/mm/yyyy', 'dd/mm/yyyy', 'dd/mm/yyyy'], 4),
    o.history || history30(SYMS),
    patternData()
  ];
  return { sheets: sheets };
}

// ---------- Code.gs behind a mocked fetch ----------
const CODE = fs.readFileSync(mock.CODE_GS, 'utf8');
const SITE_LINE = "  if (req && req.action === 'site') return ab_feedSite_(req);\n";
const SNAPSHOT_LINE = "  if (req && req.action === 'snapshot') return ab_feedSnapshot_(req);\n";

/**
 * The owner's web app: Code.gs doPost on a frozen clock. mode: 'ok' | 'down'
 * (network error) | 'login' (Google sign-in HTML: access not "Anyone") | 'hang'.
 */
function webApp(wb, atMs, o) {
  o = o || {};
  const app = { mode: 'ok', calls: [], replies: [], rewrite: o.rewrite || null };
  app.at = function (ms) {
    app.gs = mock.loadCodeGs(wb, { props: o.props || PROPS, now: ms, code: o.code });
  };
  app.at(atMs);
  app.fetch = function (url, init) {
    const body = JSON.parse(init.body);
    app.calls.push({ url: String(url), method: init.method, redirect: init.redirect, body: body });
    if (app.mode === 'down') return Promise.reject(new TypeError('fetch failed'));
    if (app.mode === 'hang') {
      return new Promise(function (resolve, reject) {
        init.signal.addEventListener('abort', function () { reject(new Error('aborted')); });
      });
    }
    if (app.mode === 'login') {
      return Promise.resolve(new Response('<!doctype html><title>Sign in - Google Accounts</title>',
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
    }
    const out = app.gs.call('doPost', { postData: { contents: JSON.stringify(app.rewrite ? app.rewrite(body) : body), type: 'application/json' } });
    app.replies.push(out.getContent());
    return Promise.resolve(new Response(out.getContent(), { status: 200, headers: { 'content-type': out.getMimeType() + '; charset=utf-8' } }));
  };
  return app;
}

/** Code.gs + the three Vercel endpoints on one settable IST clock. */
function setup(at, o) {
  o = o || {};
  const clock = { t: IST(at) };
  const now = function () { return clock.t; };
  const app = webApp(o.workbook || workbook(o.wb), clock.t, o);
  const env = Object.assign({}, ENV, o.env || {});
  const deps = function (e) { return { env: e, fetch: app.fetch, now: now, cache: cacheLib.createCache({ now: now }) }; };
  const marketEnv = Object.assign({ MARKET_DATA_PROVIDER: 'sheet' }, env);
  return {
    clock: clock, app: app,
    /** move the clock (the sheet answers at the new time too; Code.gs starts afresh: no stored copy) */
    set: function (s) { clock.t = IST(s); app.at(clock.t); },
    /** move the clock of both sides, keeping Code.gs's state (stored copy, Script Properties) */
    tick: function (s) { clock.t = IST(s); app.gs.setNow(clock.t); },
    site: siteApi.createHandler(deps(env)),
    quotes: quotesApi.createHandler(deps(marketEnv)),
    status: statusApi.createHandler(deps(marketEnv))
  };
}

/** Vercel-style res; the body goes through JSON like the wire. */
function fakeRes() {
  const r = { headers: {}, statusCode: 200, body: undefined, text: '' };
  r.setHeader = function (k, v) { r.headers[String(k).toLowerCase()] = v; };
  r.status = function (code) { r.statusCode = code; return r; };
  r.json = function (obj) { r.text = JSON.stringify(obj); r.body = JSON.parse(r.text); };
  r.end = function (t) { if (t !== undefined) { r.text = String(t); r.body = JSON.parse(r.text); } };
  return r;
}
async function call(handler, req) {
  const res = fakeRes();
  await handler(Object.assign({ method: 'GET' }, req), res);
  return res;
}
const site = function (s, part) { return call(s.site, { query: { part: part } }); };

/** Nothing personal or secret in a reply the public site receives. */
function assertPublic(label, text) {
  assert.ok(!EMAIL_RE.test(text), label + ': contains an e-mail address');
  [FEED_TOKEN, BRIDGE_TOKEN, EXEC_URL, 'AKfyc', 'script.google.com'].forEach(function (s) {
    assert.ok(text.indexOf(s) < 0, label + ': contains a secret (' + s.slice(0, 6) + '...)');
  });
  siteApi.PERSONAL_MARKERS.forEach(function (re) { assert.ok(!re.test(text), label + ': personal marker ' + re); });
  ['Entry Price', 'Stoploss', '"Qty"', 'Owner Email', 'P&L', 'Avg Price', 'Capital', 'Win rate', '"WIPRO"', '"ITC"', '"LT"', 'Larsen']
    .forEach(function (w) { assert.ok(text.indexOf(w) < 0, label + ': contains ' + w); });
}

// ---------- the browser's own code ----------
/**
 * Top-level functions / vars of a browser IIFE (2-space indent), evaluated
 * together with `scope` as their free variables. names: 'fnName' or 'var NAME'.
 */
function fromBrowser(file, names, scope) {
  const src = read(file);
  const keys = Object.keys(scope || {});
  const out = [];
  const parts = names.map(function (n) {
    const isVar = n.indexOf('var ') === 0, id = isVar ? n.slice(4) : n;
    const re = isVar ? new RegExp('\\n  var ' + id + ' = [^\\n]*;') : new RegExp('\\n  function ' + id + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}');
    const m = re.exec(src);
    assert.ok(m, file + ' still has ' + n + ' (update tests/site-feed-e2e.test.js if it moved)');
    out.push(id + ': ' + id);
    return m[0];
  });
  const body = "'use strict';\n" + parts.join('\n') + '\nreturn {' + out.join(', ') + '};';
  return new Function(keys.join(','), body).apply(null, keys.map(function (k) { return scope[k]; }));
}

/** A fresh browser context: web/app.js prepare() & co. on a settable clock. */
function browser(nowMs) {
  const clock = { t: nowMs };
  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(clock.t); }
    static now() { return clock.t; }
  }
  const core = fromBrowser('web/ui/core.js', ['isNum', 'objRows', 'parseDate', 'iso'], { Date: FakeDate });
  const ui = { objRows: core.objRows, parseDate: core.parseDate };
  const ctx = {
    D: null, stocks: [], bySym: {}, refDate: new FakeDate(),
    market: { state: 'CACHED', source: 'Sheet snapshot', asOf: null, provider: null, message: '' },
    site: { live: false, apiBase: '' }, history: null
  };
  const SB = { classify: classify, strategy: strategy, eod: eod, ctx: ctx, ui: ui };
  const app = fromBrowser('web/app.js',
    ['var SITE_TIMEOUT_MS', 'var LIVE_SOURCE', 'var QUOTE_TTL', 'istMs', 'sheetState', 'prepare', 'applySignal', 'validMain', 'validHistory', 'apiBaseFor'],
    { SB: SB, ui: ui, F: { dateTime: String }, ctx: ctx, isNum: core.isNum, Date: FakeDate });
  const st = fromBrowser('web/ui/strategy-state.js', ['var candleMap', 'candles'], { SB: SB });
  const cs = /\n {2}SB\.candleState = (function \(H\) \{[\s\S]*?\n {2}\});/.exec(read('web/ui/strategy-state.js'));
  assert.ok(cs, 'web/ui/strategy-state.js still has SB.candleState');
  const candleState = new Function('SB', 'ui', "'use strict'; return (" + cs[1] + ');')(SB, { iso: core.iso });
  return { clock: clock, ctx: ctx, app: app, candles: st.candles, candleState: candleState };
}

// objects keyed by data (symbols, KPI names): compare one value's shape, not the keys
const DATA_KEYED = ['data.patterns.kpis', 'history.bars', 'history.sheetTags'];

/**
 * Same shape as the saved copy: every key it has (in the same order), tables,
 * nested objects. The saved copy is regenerated from the owner's workbook, so
 * a blank cell (null) in either copy, or a tab it lacks, is not a mismatch.
 */
function sameShape(live, saved, where) {
  const kind = function (v) {
    if (v === null || v === undefined) return 'null';
    if (Array.isArray(v)) return 'array';
    if (typeof v === 'object') return Array.isArray(v.cols) && Array.isArray(v.rows) ? 'table' : 'object';
    return typeof v;
  };
  const ks = kind(saved), kl = kind(live);
  if (ks === 'null' || (kl === 'null' && ks !== 'object' && ks !== 'table' && ks !== 'array')) return;
  assert.equal(kl, ks, where + ': ' + kl + ' vs saved ' + ks);
  if (ks === 'object' && DATA_KEYED.indexOf(where) >= 0) {
    const a = Object.keys(live), b = Object.keys(saved);
    assert.ok(a.length, where + ' is empty');
    if (b.length && where !== 'data.patterns.kpis') sameShape(live[a[0]], saved[b[0]], where + '[*]');
  } else if (ks === 'object') {
    const keys = Object.keys(live);
    assert.deepEqual(Object.keys(saved).filter(function (k) { return keys.indexOf(k) >= 0; }), Object.keys(saved), where + ' keys');
    assert.deepEqual(keys.filter(function (k) { return k in saved; }), Object.keys(saved), where + ' key order');
    Object.keys(saved).forEach(function (k) { sameShape(live[k], saved[k], where + '.' + k); });
  }
  if (kind(saved) === 'array' && saved.length && live.length) sameShape(live[0], saved[0], where + '[0]');
}

// ---------- tests ----------

test('e2e main: Code.gs -> api/site -> the reply web/app.js boots from', async () => {
  const s = setup(WED_OPEN);
  const res = await site(s, 'main');
  // what the web app received from api/site
  assert.equal(s.app.calls.length, 1);
  const c = s.app.calls[0];
  assert.equal(c.url, EXEC_URL);
  assert.equal(c.method, 'POST');
  assert.equal(c.redirect, 'follow', 'Apps Script answers through a 302');
  assert.deepEqual(c.body, { action: 'site', part: 'main', token: FEED_TOKEN });
  const raw = JSON.parse(s.app.replies[0]);
  assert.equal(raw.ok, true, raw.error);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], MAIN_CC);
  assert.equal(res.headers['access-control-allow-origin'], '*', 'CORS for the Firebase copy');
  const r = res.body;
  assert.deepEqual(Object.keys(r), ['ok', 'configured', 'part', 'readAt', 'fetchedAt', 'stale', 'session', 'priceState', 'data']);
  assert.equal(r.ok, true);
  assert.equal(r.part, 'main');
  assert.equal(r.readAt, WED_OPEN, 'readAt = the time Code.gs read the sheet');
  assert.equal(r.fetchedAt, WED_OPEN);
  assert.equal(r.stale, false);
  assert.deepEqual(r.session, { state: 'open', lastCompletedSession: cal.lastCompletedSession(IST(WED_OPEN)) });
  assert.equal(r.priceState, 'DELAYED', 'GOOGLEFINANCE in market hours');
  assert.deepEqual(r.data, raw.data, 'data passes through unchanged');

  // the export_xlsx.py keys (every tab present), and the same shape as the saved copy every page was written against
  assert.deepEqual(Object.keys(r.data), ['generated', 'source', 'main', 'resultsTracker', 'resultsPerf', 'asOf', 'patterns',
    'fvg', 'gapup', 'watchLog', 'fvgBacktest', 'mitigatedLog', 'alerts', 'indices', 'ipos', 'newIpos', 'priceBands', 'ipoTracker']);
  sameShape(r.data, SAVED, 'data');
  assert.deepEqual(r.data.main.cols, MAIN_COLS.map(function (x) { return x[0]; }), 'every Main column, in Code.gs order');
  assert.deepEqual(r.data.main.cols.filter(function (k) { return SAVED.main.cols.indexOf(k) >= 0; }), SAVED.main.cols,
    'the saved copy columns, same order');
  assert.equal(r.data.generated, r.readAt);
  assert.equal(r.data.source, 'Google Sheet (live feed)');
  assert.equal(r.data.asOf, '2026-10-21 10:45', 'Results Performance refresh time');
  assertPublic('api/site main', res.text);

  // the browser boots from it
  const b = browser(IST('2026-10-21 11:02'));
  assert.equal(b.app.validMain(r.data), true);
  b.app.prepare(r.data, { live: true, resp: r });
  const m = b.ctx.market;
  assert.equal(m.state, 'DELAYED');
  assert.equal(m.asOf, WED_OPEN);
  assert.equal(m.live, true);
  assert.deepEqual(m.session, r.session);
  assert.equal(m.fetchedAt, IST(WED_OPEN), 'DELAYED ages from the sheet read');
  assert.match(m.source, /Google Sheet live feed/);
  assert.deepEqual(b.ctx.stocks.map(function (x) { return x.sym; }), SYMS, 'blank Main row skipped');
  const tcs = b.ctx.bySym.TCS;
  assert.equal(tcs.price, 3050.5);
  assert.equal(tcs.chg, 1.25);
  assert.equal(tcs.priceState, 'DELAYED');
  assert.equal(tcs.priceAsOf, WED_OPEN);
  assert.equal(tcs.rdate, '2026-10-09');
  assert.equal(tcs.done, true);
  assert.equal(tcs.d10, 5, 'fractions arrive as percent');
  assert.equal(tcs.id, 'NSE:TCS');
  assert.ok(tcs.cat && tcs.catName, 'classified');
  assert.equal(b.ctx.site.live, true);
  assert.equal(b.ctx.site.readAt, WED_OPEN);
  assert.equal(b.ctx.site.stale, false);
  assert.equal(b.ctx.refDate.getTime(), new Date(2026, 9, 21, 11, 0).getTime(), 'reference date = readAt');
});

test('e2e main: privacy - personal tabs, columns, e-mails and position alerts never reach the site', async () => {
  const s = setup(WED_OPEN);
  const r = (await site(s, 'main')).body;
  const al = r.data.alerts;
  assert.deepEqual(al.cols, JSON.parse(JSON.stringify(s.app.gs.run('AB_SITE_ALERT_COLS'))), 'only the public alert columns');
  const si = al.cols.indexOf('Symbol'), ti = al.cols.indexOf('Alert Type');
  // TCS Entry (a position), INFY (Entry Price), HDFCBANK (Stoploss), WIPRO (Trade Log),
  // ITC (Portfolio), LT (Risk Manager) and the Stop Hit alert are all left out
  assert.deepEqual(al.rows.map(function (x) { return x[si] + ' ' + x[ti]; }), ['TCS Breakout', 'SBIN Price Fall']);
  PERSONAL_MAIN.forEach(function (h) { assert.ok(r.data.main.cols.indexOf(h) < 0, h); });
  r.data.main.cols.forEach(function (k) { assert.doesNotMatch(k, /entry|stop|qty|mail|alert|trigger/i, 'Main column ' + k); });
  ['trades', 'tradeStats', 'portfolio', 'risk', 'controlPanel'].forEach(function (k) { assert.ok(!(k in r.data), 'no ' + k); });
  // the raw Code.gs reply is already clean (api/site's guard is the second line of defence)
  assertPublic('Code.gs site main', s.app.replies[0]);
  // a personal value typed into a PUBLIC Main column is caught by api/site's guard
  const leak = setup(WED_OPEN, { wb: { patch: { TCS: { name: 'Tata - ask ' + OWNER_MAIL } } } });
  const res = await site(leak, 'main');
  assert.ok(EMAIL_RE.test(leak.app.replies[0]), 'Code.gs passed the cell on (it is an allowed column)');
  assert.deepEqual(res.body, { ok: false, configured: true, part: 'main', message: 'blocked: the sheet feed contained personal-data markers' });
  assert.equal(res.headers['cache-control'], cacheLib.unavailableCacheControl());
  assertPublic('blocked reply', res.text);
});

test('e2e history: Code.gs -> api/site -> SB.loadHistory / strategy candles', async () => {
  const s = setup(WED_OPEN);
  const res = await site(s, 'history');
  assert.deepEqual(s.app.calls[0].body, { action: 'site', part: 'history', token: FEED_TOKEN });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], HISTORY_CC);
  assert.equal(res.headers['access-control-allow-origin'], '*');
  const r = res.body;
  assert.equal(r.ok, true, r.message);
  assert.equal(r.part, 'history');
  assert.equal(r.readAt, WED_OPEN);
  assert.equal(r.priceState, 'DELAYED');
  const H = r.data;
  assert.deepEqual(Object.keys(H), Object.keys(SAVED_HISTORY));
  sameShape(H, SAVED_HISTORY, 'history');
  assert.deepEqual(H.cols, ['d', 'o', 'h', 'l', 'c', 'v']);
  assert.equal(H.timeframe, '1d');
  assert.equal(H.asOf, '2026-10-21 10:45');
  assert.deepEqual(H.dates, DAYS, 'every session, in calendar order');
  assert.deepEqual(Object.keys(H.bars), SYMS);
  Object.keys(H.bars).forEach(function (sym) {
    const bars = H.bars[sym];
    assert.equal(bars.length, DAYS.length, sym);
    bars.forEach(function (b, i) {
      assert.equal(b.length, 6);
      assert.equal(b[0], i, sym + ' bar index');
      b.slice(1).forEach(function (v) { assert.equal(typeof v, 'number'); });
    });
  });
  assert.deepEqual(H.sheetTags.TCS, ['Hammer', '', '', 12.5, 'Support']);
  assertPublic('api/site history', res.text);

  // the browser: SB.loadHistory accepts it, candles() maps it, the strategy engine runs on it
  const main = (await site(s, 'main')).body;
  const b = browser(IST('2026-10-21 11:02'));
  b.app.prepare(main.data, { live: true, resp: main });
  assert.equal(b.app.validHistory(H), true);
  b.ctx.history = H;
  const candles = b.candles();
  assert.deepEqual(Object.keys(candles), SYMS);
  const last = candles.TCS[candles.TCS.length - 1];
  assert.equal(last.t, '2026-10-19');
  ['o', 'h', 'l', 'c', 'v'].forEach(function (k) { assert.equal(typeof last[k], 'number', k); });
  assert.ok(last.h >= last.c && last.l <= last.c);
  assert.equal(b.candleState(H), 'EOD', 'the newest candle covers the last completed session');
  const run = strategy.run(strategy.PRESETS.sheet, b.ctx.stocks, candles,
    { usePrice: true, latestDate: H.dates[H.dates.length - 1], refDate: '2026-10-21' });
  assert.deepEqual(run.errors, []);
  assert.deepEqual(run.results.map(function (x) { return x.sym; }).sort(), SYMS.slice().sort());
  run.results.forEach(function (x) { assert.equal(x.asOf, '2026-10-19', x.sym); });

  // part history60 (no History60 tab in this workbook): an empty part, the site keeps the 30 days
  const o = await site(s, 'history60');
  assert.equal(o.statusCode, 200);
  assert.equal(o.headers['cache-control'], HISTORY_CC);
  assert.equal(o.body.ok, true, o.body.message);
  assert.deepEqual(o.body.data, { source: 'History60 tab (NSE bhavcopy via your PC)', timeframe: '1d', stored: null, dates: [], cols: ['d', 'o', 'h', 'l', 'c', 'v'], bars: {} });
  assert.strictEqual(historyLib.merge(H, o.body.data), H);
  assertPublic('api/site history60', o.text);
});

test('e2e quotes (option 2): Code.gs snapshot -> api/quotes + api/market-status, provider sheet', async () => {
  const s = setup(WED_OPEN);
  const st = await call(s.status, {});
  assert.equal(st.statusCode, 200);
  assert.deepEqual(s.app.calls[0].body, { action: 'snapshot', token: FEED_TOKEN });
  const raw = JSON.parse(s.app.replies[0]);
  assert.equal(raw.ok, true, raw.error);
  assert.deepEqual(raw.cols, ['sym', 'price', 'chg']);
  assert.equal(raw.readAt, WED_OPEN);
  // what initMarket / loadStatus reads
  assert.equal(st.body.provider.name, 'sheet');
  assert.equal(st.body.provider.configured, true);
  assert.deepEqual(st.body.provider.requires, ['SHEET_FEED_URL', 'SHEET_FEED_TOKEN'], 'env var names only');
  assert.equal(st.body.session.state, 'open');
  assert.equal(st.body.status.ok, true);
  assert.equal(st.body.status.state, 'DELAYED');
  assert.match(st.body.status.message, /Sheet feed reachable: 5 symbols, as of 2026-10-21 11:00 IST/);

  const q = await call(s.quotes, { query: { symbols: 'TCS,SBIN,NOPE' } });
  assert.equal(q.statusCode, 200);
  // separate Vercel functions, so separate memory caches: one snapshot read each
  assert.deepEqual(s.app.calls.map(function (x) { return x.body.action; }), ['snapshot', 'snapshot']);
  // what refreshQuotes reads
  assert.equal(q.body.state, 'DELAYED');
  assert.equal(q.body.source, 'sheet');
  assert.equal(q.body.asOf, WED_OPEN);
  const items = {};
  q.body.items.forEach(function (it) { items[it.symbol] = it; });
  assert.deepEqual(Object.keys(items), ['TCS', 'SBIN']);
  assert.equal(items.TCS.ltp, 3050.5);
  assert.equal(items.TCS.changePct, 1.25);
  assert.equal(items.TCS.state, 'DELAYED');
  assert.equal(items.SBIN.ltp, 812.5);
  assert.deepEqual(q.body.errors, [{ symbol: 'NOPE', reason: 'not in the sheet' }]);
  [st, q].forEach(function (x, i) { assertPublic(i ? 'api/quotes' : 'api/market-status', x.text); });
  assertPublic('Code.gs snapshot', s.app.replies[0]);
});

test('e2e stored copy: the refresh trigger stores the feed; api/site gets it at once, labelled by the build\'s readAt', async () => {
  const s = setup('2026-10-21 10:30');
  s.app.gs.call('ab_siteFeedTrigger_');                    // the 30-minute refresh: nothing stored yet, builds both parts
  const fresh = setup('2026-10-21 10:30');                 // the same sheet read on demand in the same minute
  const onDemand = { main: (await site(fresh, 'main')).body, history: (await site(fresh, 'history')).body };
  assert.equal(JSON.parse(fresh.app.replies[0]).stored, false, 'on-demand path');

  s.tick('2026-10-21 10:40');
  for (const part of ['main', 'history']) {
    s.app.gs.reads.length = 0;
    s.app.gs.ranges.length = 0;
    const res = await site(s, part);
    const raw = JSON.parse(s.app.replies[s.app.replies.length - 1]);
    assert.equal(raw.ok, true, raw.error);
    assert.equal(raw.stored, true, part + ': stored path');
    assert.equal(raw.readAt, '2026-10-21 10:30');
    assert.equal(raw.builtAt, '2026-10-21 10:30');
    assert.deepEqual(s.app.gs.ranges.filter(function (g) { return g.sheet !== 'Site_Feed'; }), [], part + ': no Main / History30 read');
    const r = res.body;
    assert.equal(res.statusCode, 200);
    assert.deepEqual(Object.keys(r), ['ok', 'configured', 'part', 'readAt', 'fetchedAt', 'stale', 'session', 'priceState', 'data']);
    assert.equal(r.readAt, '2026-10-21 10:30', part + ': when the sheet was read, not when it was served');
    assert.equal(r.fetchedAt, '2026-10-21 10:40');
    assert.equal(r.stale, false);
    assert.equal(r.priceState, 'DELAYED');
    assert.deepEqual(r.data, onDemand[part].data, part + ': the same data as an on-demand read');
    assertPublic('stored ' + part, res.text);
    assertPublic('Code.gs stored ' + part, s.app.replies[s.app.replies.length - 1]);
  }
  const main = (await site(s, 'main')).body;
  const b = browser(IST('2026-10-21 10:41'));
  assert.equal(b.app.validMain(main.data), true);
  b.app.prepare(main.data, { live: true, resp: main });
  assert.equal(b.ctx.market.state, 'DELAYED');
  assert.equal(b.ctx.site.readAt, '2026-10-21 10:30');
  assert.deepEqual(b.ctx.stocks.map(function (x) { return x.sym; }), SYMS);

  // built after the close: EOD; a copy from the previous session (refresh stopped): CACHED
  const eve = setup('2026-10-21 18:30');
  eve.app.gs.call('ab_siteFeedTrigger_');
  eve.tick('2026-10-21 19:00');
  const e = (await site(eve, 'main')).body;
  assert.equal(e.readAt, '2026-10-21 18:30');
  assert.equal(e.priceState, 'EOD');
  const old = setup('2026-10-21 15:00');
  old.app.gs.call('ab_siteFeedTrigger_');
  old.tick('2026-10-22 10:00');
  const o = (await site(old, 'main')).body;
  assert.equal(JSON.parse(old.app.replies[0]).stored, true);
  assert.equal(o.readAt, '2026-10-21 15:00');
  assert.equal(o.priceState, 'CACHED', 'an old stored copy is never shown as DELAYED');
});

test('e2e stored copy: a build already running and nothing stored -> ok:false, the browser keeps its saved copy', async () => {
  const s = setup(WED_OPEN, { props: Object.assign({ AB_SITE_BUILDING_SINCE: String(IST(WED_OPEN) - 60000) }, PROPS) });
  const res = await site(s, 'main');
  assert.deepEqual(JSON.parse(s.app.replies[0]), { ok: false, error: 'site feed is being prepared - try again in a minute' });
  assert.equal(res.body.ok, false);
  assert.equal(res.body.configured, true);
  assert.equal(res.headers['cache-control'], cacheLib.unavailableCacheControl());
  assertPublic('being prepared', res.text);
  // the build finishes (mark cleared, copy stored): the next request is served from it
  s.app.gs.props.deleteProperty('AB_SITE_BUILDING_SINCE');
  s.app.gs.call('ab_siteBuild_', ['main'], 'test');
  s.tick('2026-10-21 11:01');
  const ok = (await site(s, 'main')).body;
  assert.equal(ok.ok, true);
  assert.equal(ok.readAt, '2026-10-21 11:00');
  assert.equal(JSON.parse(s.app.replies[1]).stored, true);
});

test('e2e price state: DELAYED in session and until 16:00, EOD after it, on weekends and holidays', async () => {
  const cases = [
    ['2026-10-21 09:20', 'open', 'DELAYED'],
    ['2026-10-21 15:45', 'closed', 'DELAYED'],
    ['2026-10-21 18:30', 'closed', 'EOD'],
    ['2026-10-24 10:00', 'weekend', 'EOD'],
    ['2026-11-10 11:00', 'holiday', 'EOD']
  ];
  for (const [at, session, state] of cases) {
    const s = setup(at);
    const r = (await site(s, 'main')).body;
    assert.equal(r.readAt, at);
    assert.equal(r.session.state, session, at);
    assert.equal(r.priceState, state, at);
    const b = browser(IST(at) + 60000);
    b.app.prepare(r.data, { live: true, resp: r });
    assert.equal(b.ctx.market.state, state, 'browser ' + at);
    const q = (await call(s.quotes, { query: { symbols: 'TCS' } })).body;
    assert.equal(q.items[0].state, state, 'quotes ' + at);
  }
});

test('e2e: an older CDN copy (stale-while-revalidate) is not labelled DELAYED in the browser', async () => {
  const s = setup(WED_OPEN);
  const r = (await site(s, 'main')).body;
  assert.equal(r.priceState, 'DELAYED');
  // the CDN may hand this same reply out for up to s-maxage + stale-while-revalidate
  const b = browser(IST(WED_OPEN) + 45 * 60000);
  b.app.prepare(r.data, { live: true, resp: r });
  assert.equal(b.ctx.market.state, 'CACHED');
  assert.ok(b.ctx.stocks.every(function (x) { return x.priceState === 'CACHED'; }));
  assert.match(b.ctx.market.message, /over 30 minutes ago, so shown as CACHED/);
  // EOD does not age (prices are the last session's close)
  const e = setup('2026-10-21 18:30');
  const re = (await site(e, 'main')).body;
  const b2 = browser(IST('2026-10-21 23:30'));
  b2.app.prepare(re.data, { live: true, resp: re });
  assert.equal(b2.ctx.market.state, 'EOD');
});

test('e2e: a failed refresh serves the last good copy (stale), then recovers', async () => {
  const s = setup(WED_OPEN);
  assert.equal((await site(s, 'main')).body.stale, false);
  s.app.mode = 'down';
  s.set('2026-10-21 11:06');                 // past the 5 min memory TTL
  const res = await site(s, 'main');
  const r = res.body;
  assert.equal(r.ok, true);
  assert.equal(r.stale, true);
  assert.equal(r.staleReason, 'sheet feed not reachable (network error)');
  assert.equal(r.readAt, WED_OPEN, 'the old read time');
  assert.equal(r.priceState, 'CACHED');
  assert.equal(res.headers['cache-control'], STALE_CC);
  const b = browser(IST('2026-10-21 11:06'));
  b.app.prepare(r.data, { live: true, resp: r });
  assert.equal(b.ctx.market.state, 'CACHED');
  assert.equal(b.ctx.site.stale, true);
  assert.equal(b.ctx.site.staleReason, 'sheet feed not reachable (network error)');
  assert.match(b.ctx.market.message, /last good copy/);
  s.app.mode = 'ok';
  s.set('2026-10-21 11:07');
  const ok = (await site(s, 'main')).body;
  assert.equal(ok.stale, false);
  assert.equal(ok.readAt, '2026-10-21 11:07');
  assert.equal(ok.priceState, 'DELAYED');
});

test('e2e failures: clear messages, no upstream text, never a secret (the browser then uses the saved copy)', async () => {
  const fail = async function (label, s, part, re) {
    const res = await site(s, part || 'main');
    assert.equal(res.statusCode, 200, label);
    assert.equal(res.body.ok, false, label);
    assert.equal(res.body.configured, true, label);
    assert.match(res.body.message, re, label + ': ' + res.body.message);
    assert.equal(res.headers['cache-control'], cacheLib.unavailableCacheControl(), label);
    assert.equal(res.headers['access-control-allow-origin'], '*', label);
    assertPublic(label, res.text);
    return res.body.message;
  };
  const NEW_VERSION = /deploy a New version of the EXISTING web-app deployment/;

  // Vercel's SHEET_FEED_TOKEN is not the sheet's AB_FEED_TOKEN
  const badToken = setup(WED_OPEN, { env: { SHEET_FEED_TOKEN: 'feed_WRONG_TOKEN_000000' } });
  const m1 = await fail('bad token', badToken, 'main', /^auth failed: the sheet rejected SHEET_FEED_TOKEN/);
  assert.match(m1, NEW_VERSION);
  assert.deepEqual(JSON.parse(badToken.app.replies[0]), { ok: false, error: 'bad token' });

  // the web app still runs a version without action 'site' (no New version deployed yet)
  const old = CODE.replace(SITE_LINE, '');
  assert.notEqual(old, CODE, 'Code.gs doPost has the site dispatch line');
  const oldApp = setup(WED_OPEN, { code: old });
  const m2 = await fail('old web-app version', oldApp, 'main', /older version without the site feed/);
  assert.match(m2, NEW_VERSION);
  assert.deepEqual(JSON.parse(oldApp.app.replies[0]), { ok: false, error: 'bad token' }, 'falls through to the PC-bridge check');
  // ... while option 2 (prices) already works on it
  const q = (await call(oldApp.quotes, { query: { symbols: 'TCS' } })).body;
  assert.equal(q.items[0].state, 'DELAYED');
  // a version from before the website feed: the price feed explains itself too
  const older = setup(WED_OPEN, { code: old.replace(SNAPSHOT_LINE, '') });
  const q2 = (await call(older.quotes, { query: { symbols: 'TCS' } })).body;
  assert.equal(q2.state, 'UNAVAILABLE');
  assert.match(q2.message, /^auth failed: the sheet rejected SHEET_FEED_TOKEN/);
  const st2 = (await call(older.status, {})).body;
  assert.equal(st2.status.ok, false);
  assertPublic('old quotes', JSON.stringify([q2, st2]));

  // a part this Code.gs version does not know
  const part = setup(WED_OPEN, { rewrite: function (b) { return Object.assign({}, b, { part: 'candles' }); } });
  const m3 = await fail('unknown part', part, 'main', /does not support part "main" yet/);
  assert.match(m3, NEW_VERSION);
  assert.deepEqual(JSON.parse(part.app.replies[0]), { ok: false, error: 'unknown part' });

  // History30 half rewritten by Phase 1: history refused, main still fine
  const busy = setup(WED_OPEN, { wb: { history: history30(['TCS']) } });
  await fail('History30 updating', busy, 'history', /^sheet is updating \(History30 has 1 of 5 symbols\) - try again shortly$/);
  assert.equal((await site(busy, 'main')).body.ok, true);

  // web app deployed with access other than "Anyone": Google answers with a sign-in page
  const login = setup(WED_OPEN);
  login.app.mode = 'login';
  await fail('access not Anyone', login, 'main', /did not return JSON \(is the web app deployed with access "Anyone"\?\)/);

  // the sheet itself failed (here: no Main tab) - the upstream text is not passed on
  const wb = workbook();
  wb.sheets = wb.sheets.filter(function (x) { return x.name !== 'Main'; });
  const broken = setup(WED_OPEN, { workbook: wb });
  await fail('Code.gs error', broken, 'main', /^sheet feed returned an error$/);
  assert.match(JSON.parse(broken.app.replies[0]).error, /Main/);

  // the sheet takes longer than api/site waits
  const slow = setup(WED_OPEN);
  slow.app.mode = 'hang';
  const h = siteApi.createHandler({ env: ENV, fetch: slow.app.fetch, now: function () { return slow.clock.t; },
    cache: cacheLib.createCache(), timeoutMs: 30 });
  const t = await call(h, { query: { part: 'main' } });
  assert.deepEqual(t.body, { ok: false, configured: true, part: 'main', message: 'sheet feed timed out (the sheet may be busy)' });

  // not configured on Vercel: names the missing variables, no request is made
  const none = setup(WED_OPEN, { env: { SHEET_FEED_URL: '', SHEET_FEED_TOKEN: '' } });
  const nc = await site(none, 'history');
  assert.deepEqual(nc.body, { ok: false, configured: false, part: 'history',
    message: 'Live site feed not configured: set SHEET_FEED_URL and SHEET_FEED_TOKEN in Vercel > Project > Settings > Environment Variables, then redeploy.' });
  assert.equal(none.app.calls.length, 0);

  // a bad part never reaches the sheet
  const bad = await call(setup(WED_OPEN).site, { query: { part: 'everything' } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.headers['access-control-allow-origin'], '*');

  // every ok:false reply makes the browser use the saved copy (loadLive)
  const b = browser(IST(WED_OPEN));
  assert.equal(b.app.validMain(undefined), false);
});

test('e2e Firebase copy: web/config.js remote API, CORS preflight, URL the handler understands', async () => {
  const cfg = windowVar('web/config.js', 'SB_CONFIG');
  const b = browser(IST(WED_OPEN));
  const base = b.app.apiBaseFor('stock-blueprint.web.app', 'https:', null, cfg.remoteApi);
  assert.equal(base, 'https://stock-blueprint-sandy.vercel.app/');
  assert.equal(b.app.apiBaseFor('stock-blueprint.firebaseapp.com', 'https:', null, cfg.remoteApi), base);
  assert.equal(b.app.apiBaseFor('stock-blueprint-sandy.vercel.app', 'https:', null, cfg.remoteApi), '', 'Vercel: same origin');
  assert.equal(b.app.apiBaseFor('localhost', 'http:', null, cfg.remoteApi), null, 'localhost: saved copy only');
  // the browser asks relative paths, so they work after the remote base and on the same origin
  const appJs = read('web/app.js');
  ['api/site?part=main', 'api/site?part=history', 'api/market-status', 'api/quotes?symbols='].forEach(function (p) {
    assert.ok(appJs.indexOf("apiGet('" + p) >= 0, 'web/app.js asks ' + p);
  });
  // a plain GET with an Accept header only: no preflight needed, but OPTIONS is answered anyway
  const s = setup(WED_OPEN);
  const pre = fakeRes();
  await s.site({ method: 'OPTIONS', url: '/api/site?part=main' }, pre);
  assert.equal(pre.statusCode, 204);
  assert.equal(pre.headers['access-control-allow-origin'], '*');
  assert.equal(pre.headers['access-control-allow-methods'], 'GET');
  const u = new URL(base + 'api/site?part=history');
  const res = fakeRes();
  delete res.status; delete res.json;                  // a bare Node response, like `vercel dev`
  await s.site({ method: 'GET', url: u.pathname + u.search }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.part, 'history');
  assert.equal(res.headers['access-control-allow-origin'], '*');
  // vercel.json serves web/ and runs every api/*.js (api/site.js included) as a function
  const vercel = JSON.parse(read('vercel.json'));
  assert.equal(vercel.outputDirectory, 'web');
  assert.ok(vercel.functions['api/*.js'], 'api/*.js functions');
  assert.ok(!vercel.rewrites && !vercel.redirects, 'nothing rewrites /api/');
});

test('e2e timeouts: the browser outwaits the server, the server answers inside Vercel maxDuration', () => {
  const vercel = JSON.parse(read('vercel.json'));
  const maxMs = vercel.functions['api/*.js'].maxDuration * 1000;
  const apiMs = Number((/const TIMEOUT_MS = (\d+);/.exec(read('api/site.js')) || [])[1]);
  const b = browser(IST(WED_OPEN));
  const webMs = b.app.SITE_TIMEOUT_MS;
  assert.ok(apiMs > 0 && apiMs + 3000 <= maxMs, 'api/site waits ' + apiMs + ' ms for the sheet, Vercel allows ' + maxMs);
  assert.ok(webMs >= maxMs, 'the browser (' + webMs + ' ms) must outwait the function (' + maxMs + ' ms), or the last good copy never arrives');
  // market-status with the 'sheet' provider waits up to the snapshot timeout
  const statusMs = Number((/apiGet\('api\/market-status', (\d+)\)/.exec(read('web/app.js')) || [])[1]);
  assert.ok(statusMs > fetchUtil.DEFAULT_TIMEOUT_MS, 'browser market-status timeout ' + statusMs + ' > server ' + fetchUtil.DEFAULT_TIMEOUT_MS);
});
