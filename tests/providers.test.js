// Tests for the server-side market-data providers and the api/ endpoints.
// Network is never used: global fetch is replaced by a mock in every test.
(function () {
  'use strict';

  const test = require('node:test');
  const assert = require('node:assert/strict');

  const cal = require('../api/_lib/market-calendar');
  const cacheLib = require('../api/_lib/cache');
  const validate = require('../api/_lib/validate');
  const providers = require('../api/_lib/providers');
  const dhanLib = require('../api/_lib/providers/dhan');
  const scrip = require('../api/_lib/providers/dhan-scrip-master');
  const sheetLib = require('../api/_lib/providers/sheet');
  const fetchUtil = require('../api/_lib/fetch-util');
  const quotesApi = require('../api/quotes');
  const historyApi = require('../api/history');
  const statusApi = require('../api/market-status');

  // ---------- helpers ----------

  // No real network in tests: any fetch that is not mocked fails at once.
  globalThis.fetch = function () { return Promise.reject(new TypeError('network disabled in tests')); };

  const TOKEN = 'tok_SECRET_abcdef123456';
  const CLIENT = '1100003626';
  const DHAN_ENV = { MARKET_DATA_PROVIDER: 'dhan', DHAN_CLIENT_ID: CLIENT, DHAN_ACCESS_TOKEN: TOKEN };
  const SHEET_URL = 'https://script.google.com/macros/s/AKfy_SECRET_DEPLOYMENT/exec';
  const SHEET_TOKEN = 'sheet_SECRET_987654';
  const SHEET_ENV = { MARKET_DATA_PROVIDER: 'sheet', SHEET_FEED_URL: SHEET_URL, SHEET_FEED_TOKEN: SHEET_TOKEN };

  const IST = function (s) { return cal.parseIstDateTime(s); };
  const fixedNow = function (s) { const t = IST(s); return function () { return t; }; };
  const IN_SESSION = '2026-10-14 11:00';   // Wednesday, market open
  const AFTER_CLOSE = '2026-10-14 16:00';

  const json = function (status, obj, headers) {
    return new Response(typeof obj === 'string' ? obj : JSON.stringify(obj),
      { status: status, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}) });
  };

  /** Replaces global fetch; handler(url, init, n) -> Response | Promise. */
  const mockFetch = function (handler) {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = function (url, init) {
      const c = { url: String(url), init: init || {}, body: null };
      try { c.body = init && init.body ? JSON.parse(init.body) : null; } catch { c.body = init.body; }
      calls.push(c);
      return Promise.resolve(handler(c.url, c.init, calls.length, c));
    };
    return { calls: calls, restore: function () { globalThis.fetch = original; } };
  };

  const deps = function (nowStr, extra) {
    const sleeps = [];
    return Object.assign({
      now: fixedNow(nowStr),
      cache: cacheLib.createCache(),
      sleep: function (ms) { sleeps.push(ms); return Promise.resolve(); },
      sleeps: sleeps
    }, extra || {});
  };

  const HEADER = 'SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_EXPIRY_CODE,' +
    'SEM_TRADING_SYMBOL,SEM_LOT_UNITS,SEM_CUSTOM_SYMBOL,SEM_EXPIRY_DATE,SEM_STRIKE_PRICE,SEM_OPTION_TYPE,' +
    'SEM_TICK_SIZE,SEM_EXPIRY_FLAG,SEM_EXCH_INSTRUMENT_TYPE,SEM_SERIES,SM_SYMBOL_NAME';
  const row = function (exch, seg, id, inst, sym, series, name) {
    return [exch, seg, id, inst, '0', sym, '1', sym, '', '', '', '5', 'NA', 'ES', series, name || sym].join(',');
  };
  const SCRIP_CSV = [
    HEADER,
    row('NSE', 'E', '3045', 'EQUITY', 'SBIN', 'EQ', 'STATE BANK OF INDIA'),
    row('NSE', 'E', '11536', 'EQUITY', 'TCS', 'EQ', 'TATA CONSULTANCY SERV LT'),
    row('NSE', 'E', '2885', 'EQUITY', 'RELIANCE', 'EQ', '"RELIANCE INDUSTRIES, LTD"'),
    row('NSE', 'E', '2031', 'EQUITY', 'M&M', 'EQ', 'MAHINDRA & MAHINDRA'),
    row('NSE', 'E', '1234', 'EQUITY', 'XYZ', 'BE'),
    row('NSE', 'E', '1235', 'EQUITY', 'XYZ', 'EQ'),
    row('NSE', 'E', '4321', 'EQUITY', 'SMEONE', 'SM'),
    row('BSE', 'E', '500112', 'EQUITY', 'BSEONLY', 'A'),
    row('NSE', 'D', '35000', 'FUTSTK', 'SBIN-Oct2026-FUT', 'NA'),
    row('NSE', 'I', '13', 'INDEX', 'NIFTY', 'NA'),
    row('NSE', 'E', '9999', 'EQUITY', 'GOVBOND', 'GS'),
    ''
  ].join('\r\n');

  const bigScripCsv = function (n) {
    const lines = [HEADER];
    for (let i = 1; i <= n; i++) lines.push(row('NSE', 'E', String(100000 + i), 'EQUITY', 'S' + i, 'EQ'));
    return lines.join('\n');
  };

  const QUOTE_FIXTURE = {
    3045: { last_price: 812.5, net_change: 12.5, volume: 1234567, last_trade_time: '14/10/2026 10:59:30',
            ohlc: { open: 801, high: 815.2, low: 799.1, close: 800 } },
    11536: { last_price: 3000, net_change: -15, volume: 222, last_trade_time: '14/10/2026 10:59:00',
             ohlc: { open: 3010, high: 3020, low: 2990, close: 3015 } }
  };

  /** Fetch handler for scrip master + quote API (+ optional overrides). */
  const dhanHandler = function (opts) {
    const o = opts || {};
    return function (url, init, n, c) {
      if (url === scrip.SCRIP_MASTER_URL) return new Response(o.csv || SCRIP_CSV, { status: 200 });
      if (url === dhanLib.QUOTE_URL) {
        if (o.quote) return o.quote(c, n);
        const ids = (c.body && c.body.NSE_EQ) || [];
        const data = {};
        ids.forEach(function (id) {
          data[String(id)] = (o.fixture || QUOTE_FIXTURE)[id] ||
            { last_price: 100, volume: 1, last_trade_time: '14/10/2026 10:59:00', ohlc: { open: 99, high: 101, low: 98, close: 99 } };
        });
        return json(200, { data: { NSE_EQ: data }, status: 'success' });
      }
      if (url === dhanLib.HISTORY_URL && o.history) return o.history(c, n);
      if (url === dhanLib.PROFILE_URL && o.profile) return o.profile(c, n);
      return json(404, { errorCode: 'DH-905' });
    };
  };

  const noSecrets = function (value) {
    const text = JSON.stringify(value);
    [TOKEN, CLIENT, SHEET_URL, SHEET_TOKEN].forEach(function (s) {
      assert.ok(text.indexOf(s) < 0, 'response must not contain a secret');
    });
  };

  // ---------- registry + none ----------

  test('getProvider selects by MARKET_DATA_PROVIDER (default none)', function () {
    assert.equal(providers.getProvider({}).name, 'none');
    assert.equal(providers.getProvider({ MARKET_DATA_PROVIDER: ' DHAN ' }).name, 'dhan');
    assert.equal(providers.getProvider({ MARKET_DATA_PROVIDER: 'sheet' }).name, 'sheet');
    assert.equal(providers.getProvider({ MARKET_DATA_PROVIDER: 'none' }).name, 'none');
    assert.equal(providers.getProvider({ MARKET_DATA_PROVIDER: 'yahoo' }).name, 'none');
    assert.equal(providers.getProvider(undefined).name, 'none');
  });

  test('none provider is always UNAVAILABLE, explains env vars, never fetches', async function () {
    const m = mockFetch(function () { throw new Error('must not fetch'); });
    try {
      const p = providers.getProvider({}, deps(IN_SESSION));
      const d = p.describe();
      assert.equal(d.name, 'none');
      assert.equal(d.configured, false);
      assert.deepEqual(d.requires, ['MARKET_DATA_PROVIDER']);
      const st = await p.status();
      assert.equal(st.ok, false);
      assert.equal(st.state, 'UNAVAILABLE');
      assert.match(st.message, /MARKET_DATA_PROVIDER=dhan/);
      assert.match(st.message, /DHAN_ACCESS_TOKEN/);
      assert.match(st.message, /SHEET_FEED_URL/);
      const q = await p.quotes(['SBIN']);
      assert.equal(q.state, 'UNAVAILABLE');
      assert.equal(q.source, 'none');
      assert.deepEqual(q.items, []);
      assert.ok(q.errors.length >= 1);
      const h = await p.history('SBIN', { from: '2026-01-01', to: '2026-02-01', interval: '1d' });
      assert.equal(h.state, 'UNAVAILABLE');
      assert.deepEqual(h.candles, []);
      const unknown = await providers.getProvider({ MARKET_DATA_PROVIDER: 'yahoo' }).status();
      assert.match(unknown.message, /unknown value/);
      assert.equal(m.calls.length, 0);
    } finally { m.restore(); }
  });

  // ---------- Dhan: scrip master ----------

  test('scrip master parsing keeps NSE equities and maps symbol -> securityId', function () {
    const r = scrip.parseScripMaster(SCRIP_CSV);
    assert.equal(r.ok, true);
    assert.equal(r.bySymbol.get('SBIN').securityId, '3045');
    assert.equal(r.bySymbol.get('TCS').securityId, '11536');
    assert.equal(r.bySymbol.get('M&M').securityId, '2031');
    assert.equal(r.bySymbol.get('RELIANCE').name, 'RELIANCE INDUSTRIES, LTD'); // quoted comma
    assert.equal(r.bySymbol.get('XYZ').securityId, '1235'); // EQ preferred over BE
    assert.equal(r.bySymbol.get('SMEONE').series, 'SM');
    assert.equal(r.bySymbol.has('BSEONLY'), false);
    assert.equal(r.bySymbol.has('SBIN-OCT2026-FUT'), false);
    assert.equal(r.bySymbol.has('NIFTY'), false);
    assert.equal(r.bySymbol.has('GOVBOND'), false);
    assert.equal(r.count, 6);
    assert.equal(scrip.parseScripMaster('a,b,c\n1,2,3').ok, false);
    assert.equal(scrip.parseScripMaster('').ok, false);
    assert.deepEqual(scrip.splitCsvLine('a,"b ""q"", c",d'), ['a', 'b "q", c', 'd']);
  });

  test('scrip master is streamed once, cached, and never gets the access token', async function () {
    const m = mockFetch(dhanHandler());
    try {
      const d = deps(IN_SESSION);
      const p = providers.getProvider(DHAN_ENV, d);
      await p.quotes(['SBIN']);
      await providers.getProvider(DHAN_ENV, d).quotes(['TCS']); // new instance, same cache
      const masterCalls = m.calls.filter(function (c) { return c.url === scrip.SCRIP_MASTER_URL; });
      assert.equal(masterCalls.length, 1);
      const h = masterCalls[0].init.headers || {};
      assert.equal(h['access-token'], undefined);
      assert.equal(h['client-id'], undefined);
    } finally { m.restore(); }
  });

  // ---------- Dhan: quotes ----------

  test('dhan quotes: field mapping, changePct and LIVE during the session', async function () {
    const m = mockFetch(dhanHandler());
    try {
      const p = providers.getProvider(DHAN_ENV, deps(IN_SESSION));
      const q = await p.quotes(['sbin', 'TCS']);
      const quoteCalls = m.calls.filter(function (c) { return c.url === dhanLib.QUOTE_URL; });
      assert.equal(quoteCalls.length, 1);
      assert.equal(quoteCalls[0].init.method, 'POST');
      assert.equal(quoteCalls[0].init.headers['access-token'], TOKEN);
      assert.equal(quoteCalls[0].init.headers['client-id'], CLIENT);
      assert.deepEqual(quoteCalls[0].body, { NSE_EQ: [3045, 11536] });

      assert.equal(q.source, 'dhan');
      assert.equal(q.state, 'LIVE');
      assert.equal(q.asOf, IN_SESSION);
      assert.deepEqual(q.errors, []);
      assert.equal(q.items.length, 2);
      const s = q.items[0];
      assert.deepEqual(s, {
        id: 'NSE:SBIN', symbol: 'SBIN', exchange: 'NSE', ltp: 812.5, prevClose: 800,
        open: 801, high: 815.2, low: 799.1, volume: 1234567, changePct: 1.56,
        lastTradeTime: '2026-10-14 10:59', state: 'LIVE'
      });
      assert.equal(q.items[1].symbol, 'TCS');
      assert.equal(q.items[1].changePct, -0.5);
      noSecrets(q);
    } finally { m.restore(); }
  });

  test('dhan quotes: EOD after the close, DELAYED for a stale trade, EOD on weekends', async function () {
    const m = mockFetch(dhanHandler());
    try {
      const after = await providers.getProvider(DHAN_ENV, deps(AFTER_CLOSE)).quotes(['SBIN']);
      assert.equal(after.state, 'EOD');
      assert.equal(after.items[0].state, 'EOD');
      const weekend = await providers.getProvider(DHAN_ENV, deps('2026-10-17 11:00')).quotes(['SBIN']);
      assert.equal(weekend.items[0].state, 'EOD');
      // 11:20 in session: last trade 10:59 is > 5 min old -> DELAYED
      const stale = await providers.getProvider(DHAN_ENV, deps('2026-10-14 11:20')).quotes(['SBIN']);
      assert.equal(stale.items[0].state, 'DELAYED');
      assert.equal(stale.state, 'DELAYED');
    } finally { m.restore(); }
    // pure state rules
    const now = IST(IN_SESSION);
    assert.equal(dhanLib.quoteState(now, now - 60000, 'open', '2026-10-13'), 'LIVE');
    assert.equal(dhanLib.quoteState(now, null, 'open', '2026-10-13'), 'DELAYED');
    assert.equal(dhanLib.quoteState(now, IST('2026-10-13 15:29'), 'open', '2026-10-13'), 'EOD');
    assert.equal(dhanLib.quoteState(IST('2026-10-14 09:10'), IST('2026-10-14 09:08'), 'pre-open', '2026-10-13'), 'DELAYED');
    assert.equal(dhanLib.parseDhanTime('01/01/1980 00:00:00'), null);
    assert.equal(dhanLib.parseDhanTime('14/10/2026 10:59:30'), IST('2026-10-14 10:59:30'));
  });

  test('dhan quotes: prevClose falls back to last_price - net_change; missing price is an error', async function () {
    const fixture = {
      3045: { last_price: 812.5, net_change: 12.5, last_trade_time: '14/10/2026 10:59:30', ohlc: { open: 0, high: 0, low: 0, close: 0 } },
      11536: { last_price: 0, last_trade_time: '14/10/2026 10:59:30' }
    };
    const m = mockFetch(dhanHandler({ fixture: fixture }));
    try {
      const q = await providers.getProvider(DHAN_ENV, deps(IN_SESSION)).quotes(['SBIN', 'TCS']);
      assert.equal(q.items.length, 1);
      assert.equal(q.items[0].prevClose, 800);
      assert.equal(q.items[0].changePct, 1.56);
      assert.equal(q.items[0].open, null);
      assert.deepEqual(q.errors, [{ symbol: 'TCS', reason: 'no last price in Dhan response' }]);
    } finally { m.restore(); }
  });

  test('dhan quotes: unknown symbol is reported, others still returned', async function () {
    const m = mockFetch(dhanHandler());
    try {
      const q = await providers.getProvider(DHAN_ENV, deps(IN_SESSION)).quotes(['SBIN', 'NOTREAL', 'bad.sym']);
      assert.equal(q.items.length, 1);
      assert.equal(q.items[0].symbol, 'SBIN');
      const unknown = q.errors.find(function (e) { return e.symbol === 'NOTREAL'; });
      assert.match(unknown.reason, /unknown symbol/);
      assert.ok(q.errors.find(function (e) { return e.reason === 'invalid symbol'; }));
      const none = await providers.getProvider(DHAN_ENV, deps(IN_SESSION)).quotes(['NOTREAL']);
      assert.equal(none.state, 'UNAVAILABLE');
      assert.match(none.message, /unknown symbol/);
    } finally { m.restore(); }
  });

  test('dhan quotes: more than 1000 ids are batched and paced (~1 request/s)', async function () {
    const csv = bigScripCsv(1500);
    const m = mockFetch(dhanHandler({ csv: csv }));
    try {
      const d = deps(IN_SESSION);
      const syms = [];
      for (let i = 1; i <= 1500; i++) syms.push('S' + i);
      const q = await providers.getProvider(DHAN_ENV, d).quotes(syms);
      const quoteCalls = m.calls.filter(function (c) { return c.url === dhanLib.QUOTE_URL; });
      assert.equal(quoteCalls.length, 2);
      assert.equal(quoteCalls[0].body.NSE_EQ.length, 1000);
      assert.equal(quoteCalls[1].body.NSE_EQ.length, 500);
      assert.equal(quoteCalls[1].body.NSE_EQ[0], 101001);
      assert.equal(q.items.length, 1500);
      assert.equal(q.items[1499].symbol, 'S1500');
      assert.deepEqual(q.errors, []);
      assert.ok(d.sleeps.some(function (ms) { return ms >= 1000; }), 'waits ~1 s between quote requests');
    } finally { m.restore(); }
  });

  test('dhan quotes: 401 -> UNAVAILABLE "auth failed" without echoing the token', async function () {
    const m = mockFetch(dhanHandler({
      quote: function () {
        return json(401, { errorType: 'Invalid_Authentication', errorCode: 'DH-901',
                           errorMessage: 'access token ' + TOKEN + ' for ' + CLIENT + ' is invalid or expired' });
      }
    }));
    try {
      const q = await providers.getProvider(DHAN_ENV, deps(IN_SESSION)).quotes(['SBIN', 'TCS']);
      assert.equal(q.state, 'UNAVAILABLE');
      assert.match(q.message, /auth failed/);
      assert.deepEqual(q.items, []);
      assert.ok(q.errors.every(function (e) { return /auth failed/.test(e.reason); }));
      assert.ok(q.errors.some(function (e) { return /DH-901/.test(e.reason); }));
      noSecrets(q);
      const st = await providers.getProvider(DHAN_ENV, deps(IN_SESSION, {
      })).status();
      assert.equal(st.ok, false); // profile route not mocked -> request fails, still no throw
    } finally { m.restore(); }
  });

  test('dhan quotes: 429 -> back off, retry once, then partial result with errors', async function () {
    const csv = bigScripCsv(1500);
    const m = mockFetch(dhanHandler({
      csv: csv,
      quote: function (c, n) {
        if (c.body.NSE_EQ.length === 1000) {
          const data = {};
          c.body.NSE_EQ.forEach(function (id) { data[String(id)] = { last_price: 50, last_trade_time: '14/10/2026 10:59:50', ohlc: { close: 49 } }; });
          return json(200, { data: { NSE_EQ: data }, status: 'success' });
        }
        return json(429, { errorType: 'Rate_Limit', errorCode: 'DH-904', errorMessage: 'Too many requests' });
      }
    }));
    try {
      const d = deps(IN_SESSION, { backoffMs: 2000 });
      const syms = [];
      for (let i = 1; i <= 1500; i++) syms.push('S' + i);
      const q = await providers.getProvider(DHAN_ENV, d).quotes(syms);
      const quoteCalls = m.calls.filter(function (c) { return c.url === dhanLib.QUOTE_URL; });
      assert.equal(quoteCalls.length, 3); // ok, 429, retry 429
      assert.ok(d.sleeps.indexOf(2000) >= 0, 'backed off before retrying');
      assert.equal(q.items.length, 1000);
      assert.equal(q.errors.length, 500);
      assert.ok(q.errors.every(function (e) { return /rate limited/.test(e.reason); }));
      assert.equal(q.partial, true);
      assert.equal(q.state, 'LIVE');
    } finally { m.restore(); }
  });

  test('dhan quotes: 429 once then success on the retry', async function () {
    const base = dhanHandler();
    const m = mockFetch(function (url, init, n, c) {
      if (url === dhanLib.QUOTE_URL && !m.limited) { m.limited = true; return json(429, { errorCode: 'DH-904' }, { 'retry-after': '1' }); }
      return base(url, init, n, c);
    });
    try {
      const d = deps(IN_SESSION, { backoffMs: 500 });
      const q = await providers.getProvider(DHAN_ENV, d).quotes(['SBIN']);
      assert.equal(q.items.length, 1);
      assert.deepEqual(q.errors, []);
      assert.ok(d.sleeps.indexOf(1000) >= 0, 'Retry-After (1 s) honoured');
    } finally { m.restore(); }
  });

  test('dhan quotes: timeout (AbortController) -> UNAVAILABLE, even if fetch ignores the signal', async function () {
    const respectful = mockFetch(dhanHandler({
      quote: function (c) {
        return new Promise(function (resolve, reject) {
          c.init.signal.addEventListener('abort', function () { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
        });
      }
    }));
    try {
      const q = await providers.getProvider(DHAN_ENV, deps(IN_SESSION, { timeoutMs: 30 })).quotes(['SBIN']);
      assert.equal(q.state, 'UNAVAILABLE');
      assert.match(q.errors[0].reason, /timed out/);
      assert.equal(q.partial, true);
    } finally { respectful.restore(); }
    const deaf = mockFetch(dhanHandler({ quote: function () { return new Promise(function () {}); } }));
    try {
      const q = await providers.getProvider(DHAN_ENV, deps(IN_SESSION, { timeoutMs: 30 })).quotes(['SBIN']);
      assert.equal(q.state, 'UNAVAILABLE');
      assert.match(q.errors[0].reason, /timed out/);
    } finally { deaf.restore(); }
  });

  test('dhan quotes: malformed JSON and missing data are handled', async function () {
    const m = mockFetch(dhanHandler({ quote: function () { return new Response('<html>oops', { status: 200 }); } }));
    try {
      const q = await providers.getProvider(DHAN_ENV, deps(IN_SESSION)).quotes(['SBIN']);
      assert.equal(q.state, 'UNAVAILABLE');
      assert.match(q.errors[0].reason, /malformed/);
    } finally { m.restore(); }
    const m2 = mockFetch(dhanHandler({ quote: function () { return json(200, { status: 'success', data: {} }); } }));
    try {
      const q = await providers.getProvider(DHAN_ENV, deps(IN_SESSION)).quotes(['SBIN']);
      assert.equal(q.state, 'UNAVAILABLE');
      assert.match(q.errors[0].reason, /malformed/);
    } finally { m2.restore(); }
  });

  test('dhan: not configured / scrip master down -> UNAVAILABLE without fetching quotes', async function () {
    const m = mockFetch(function (url) {
      if (url === scrip.SCRIP_MASTER_URL) return new Response('nope', { status: 503 });
      return json(200, {});
    });
    try {
      const p = providers.getProvider({ MARKET_DATA_PROVIDER: 'dhan', DHAN_CLIENT_ID: CLIENT }, deps(IN_SESSION));
      assert.equal(p.describe().configured, false);
      assert.deepEqual(p.describe().requires, ['DHAN_CLIENT_ID', 'DHAN_ACCESS_TOKEN']);
      const q = await p.quotes(['SBIN']);
      assert.equal(q.state, 'UNAVAILABLE');
      assert.match(q.message, /DHAN_ACCESS_TOKEN/);
      assert.ok(q.message.indexOf(CLIENT) < 0);
      assert.equal(m.calls.length, 0);
      const d = deps(IN_SESSION);
      const down = await providers.getProvider(DHAN_ENV, d).quotes(['SBIN']);
      assert.equal(down.state, 'UNAVAILABLE');
      assert.match(down.message, /instrument list unavailable/);
      assert.equal(m.calls.filter(function (c) { return c.url === dhanLib.QUOTE_URL; }).length, 0);
      await providers.getProvider(DHAN_ENV, d).quotes(['TCS']); // failure remembered for 60 s
      assert.equal(m.calls.filter(function (c) { return c.url === scrip.SCRIP_MASTER_URL; }).length, 1);
    } finally { m.restore(); }
  });

  test('dhan status uses /v2/profile (data plan) and is cached', async function () {
    let plan = 'Active';
    const m = mockFetch(dhanHandler({ profile: function () { return json(200, { dhanClientId: CLIENT, dataPlan: plan, dataValidity: '2026-12-31 00:00:00.0' }); } }));
    try {
      const d = deps(IN_SESSION);
      const st = await providers.getProvider(DHAN_ENV, d).status();
      assert.deepEqual([st.ok, st.state], [true, 'LIVE']);
      noSecrets(st);
      plan = 'Inactive';
      const again = await providers.getProvider(DHAN_ENV, d).status();
      assert.equal(again.ok, true, 'cached for a minute');
      const fresh = await providers.getProvider(DHAN_ENV, deps(AFTER_CLOSE)).status();
      assert.equal(fresh.ok, false);
      assert.match(fresh.message, /Data API plan is not active/);
      assert.equal(m.calls.filter(function (c) { return c.url === dhanLib.PROFILE_URL; }).length, 2);
    } finally { m.restore(); }
  });

  // ---------- Dhan: history ----------

  test('dhan history: arrays -> IST-dated candles, oldest first, today dropped', async function () {
    const ts = function (d) { return IST(d) / 1000; };
    const m = mockFetch(dhanHandler({
      history: function () {
        return json(200, {
          open: [802, 795, 790, 805, 1],
          high: [810, 801, 799, 815, 1],
          low: [798, 790, 785, 800, 1],
          close: [808, 799, 796, 812, null],
          volume: [1000, 2000, 3000, 4000, 5],
          timestamp: [ts('2026-10-13'), ts('2026-10-12'), ts('2026-10-09'), ts('2026-10-14'), ts('2026-10-08')]
        });
      }
    }));
    try {
      const h = await providers.getProvider(DHAN_ENV, deps(IN_SESSION))
        .history('sbin', { from: '2026-10-01', to: '2026-10-14', interval: '1d' });
      const call = m.calls.find(function (c) { return c.url === dhanLib.HISTORY_URL; });
      assert.deepEqual(call.body, { securityId: '3045', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY',
                                    expiryCode: 0, oi: false, fromDate: '2026-10-01', toDate: '2026-10-15' });
      assert.equal(call.init.headers['access-token'], TOKEN);
      assert.equal(h.state, 'EOD');
      assert.equal(h.source, 'dhan');
      assert.deepEqual(h.candles, [
        { t: '2026-10-09', o: 790, h: 799, l: 785, c: 796, v: 3000 },
        { t: '2026-10-12', o: 795, h: 801, l: 790, c: 799, v: 2000 },
        { t: '2026-10-13', o: 802, h: 810, l: 798, c: 808, v: 1000 }
      ]); // 10-14 still forming (session open), 10-08 malformed
      assert.match(h.errors[0].reason, /1 malformed bar/);
      // after the close the day's candle is kept
      const after = await providers.getProvider(DHAN_ENV, deps(AFTER_CLOSE))
        .history('SBIN', { from: '2026-10-01', to: '2026-10-14', interval: '1d' });
      assert.equal(after.candles[after.candles.length - 1].t, '2026-10-14');
    } finally { m.restore(); }
  });

  test('dhan history: unknown symbol, auth failure, malformed body', async function () {
    let mode = 'auth';
    const m = mockFetch(dhanHandler({
      history: function () {
        if (mode === 'auth') return json(403, { errorCode: 'DH-901', errorMessage: TOKEN });
        return json(200, { open: [1] });
      }
    }));
    try {
      const p = providers.getProvider(DHAN_ENV, deps(IN_SESSION));
      const unk = await p.history('NOTREAL', { from: '2026-01-01', to: '2026-02-01' });
      assert.equal(unk.state, 'UNAVAILABLE');
      assert.match(unk.message, /unknown symbol/);
      const auth = await p.history('SBIN', { from: '2026-01-01', to: '2026-02-01' });
      assert.equal(auth.state, 'UNAVAILABLE');
      assert.match(auth.message, /auth failed/);
      noSecrets(auth);
      mode = 'bad';
      const bad = await p.history('SBIN', { from: '2026-01-01', to: '2026-02-01' });
      assert.match(bad.message, /malformed/);
    } finally { m.restore(); }
  });

  // ---------- sheet ----------

  const SHEET_OK = {
    ok: true, asOf: '2026-10-14 10:40', delayMinutes: 20,
    cols: ['sym', 'name', 'sector', 'price', 'chg', 'd10'],
    rows: [['SBIN', 'State Bank of India', 'Financial Services', 812.5, 1.5612, 3.2],
           ['TCS', 'TCS', 'IT', '3,000.00', -0.5, 1],
           ['NOPRICE', 'x', 'y', null, null, null]]
  };

  test('sheet provider: mapping, DELAYED state (never LIVE), token sent in the body', async function () {
    const m = mockFetch(function () { return json(200, SHEET_OK); });
    try {
      const p = providers.getProvider(SHEET_ENV, deps(IN_SESSION));
      assert.deepEqual(p.describe().requires, ['SHEET_FEED_URL', 'SHEET_FEED_TOKEN']);
      assert.equal(p.describe().configured, true);
      const q = await p.quotes(['SBIN', 'TCS', 'NOPRICE', 'MISSING']);
      assert.equal(m.calls.length, 1);
      assert.equal(m.calls[0].url, SHEET_URL);
      assert.equal(m.calls[0].init.method, 'POST');
      assert.deepEqual(m.calls[0].body, { token: SHEET_TOKEN, action: 'snapshot' });
      assert.equal(q.state, 'DELAYED');
      assert.equal(q.source, 'sheet');
      assert.equal(q.asOf, '2026-10-14 10:40');
      assert.equal(q.delayMinutes, 20);
      assert.deepEqual(q.items[0], {
        id: 'NSE:SBIN', symbol: 'SBIN', exchange: 'NSE', ltp: 812.5, prevClose: null, open: null,
        high: null, low: null, volume: null, changePct: 1.56, lastTradeTime: null, state: 'DELAYED'
      });
      assert.equal(q.items[1].ltp, 3000);
      assert.deepEqual(q.errors, [{ symbol: 'NOPRICE', reason: 'no price in the sheet' },
                                  { symbol: 'MISSING', reason: 'not in the sheet' }]);
      noSecrets(q);
      // asOf == now still is not LIVE
      const st = await p.status();
      assert.equal(st.ok, true);
      assert.equal(st.state, 'DELAYED');
      noSecrets(st);
    } finally { m.restore(); }
  });

  test('sheet provider: stale snapshot -> CACHED; history -> UNAVAILABLE (~30 bars)', async function () {
    const m = mockFetch(function () { return json(200, Object.assign({}, SHEET_OK, { asOf: '2026-10-09 15:20' })); });
    try {
      const p = providers.getProvider(SHEET_ENV, deps(IN_SESSION));
      const q = await p.quotes(['SBIN']);
      assert.equal(q.state, 'CACHED');
      const h = await p.history('SBIN', { from: '2026-01-01', to: '2026-02-01' });
      assert.equal(h.state, 'UNAVAILABLE');
      assert.match(h.message, /~30/);
      assert.deepEqual(h.candles, []);
    } finally { m.restore(); }
    // weekend: a read after Friday's close is that close -> EOD (never DELAYED);
    // a Friday mid-session copy is older than the close -> CACHED
    assert.equal(sheetLib.sheetPriceState(IST('2026-10-18 11:55'), IST('2026-10-18 12:00')), 'EOD');
    assert.equal(sheetLib.sheetPriceState(IST('2026-10-16 15:45'), IST('2026-10-18 12:00')), 'EOD');
    assert.equal(sheetLib.sheetPriceState(IST('2026-10-16 15:10'), IST('2026-10-18 12:00')), 'CACHED');
    assert.equal(sheetLib.sheetPriceState(null, IST('2026-10-18 12:00')), 'CACHED');
  });

  test('sheet provider: after the close -> DELAYED until 16:00, then EOD (status says so)', async function () {
    let asOf = '2026-10-14 15:40';
    const m = mockFetch(function () { return json(200, Object.assign({}, SHEET_OK, { asOf: asOf })); });
    try {
      const settling = await providers.getProvider(SHEET_ENV, deps('2026-10-14 15:45')).quotes(['SBIN']);
      assert.equal(settling.state, 'DELAYED');
      assert.equal(settling.items[0].state, 'DELAYED');
      asOf = '2026-10-14 16:25';
      const p = providers.getProvider(SHEET_ENV, deps('2026-10-14 16:30'));
      const q = await p.quotes(['SBIN']);
      assert.equal(q.state, 'EOD');
      assert.equal(q.items[0].state, 'EOD');
      const st = await p.status();
      assert.equal(st.ok, true);
      assert.equal(st.state, 'EOD');
      assert.match(st.message, /market closed: prices are the 2026-10-14 close/);
      noSecrets(st);
      // the snapshot's readAt is used when asOf is missing
      const noAsOf = Object.assign({}, SHEET_OK, { readAt: '2026-10-14 16:25' });
      delete noAsOf.asOf;
      const m2 = mockFetch(function () { return json(200, noAsOf); });
      try {
        const q2 = await providers.getProvider(SHEET_ENV, deps('2026-10-14 16:30')).quotes(['SBIN']);
        assert.equal(q2.asOf, '2026-10-14 16:25');
        assert.equal(q2.state, 'EOD');
      } finally { m2.restore(); }
    } finally { m.restore(); }
  });

  test('sheet provider: bad token, non-JSON page, unknown action, not configured', async function () {
    let reply = json(200, { ok: false, error: 'bad token' });
    const m = mockFetch(function () { return reply; });
    try {
      const bad = await providers.getProvider(SHEET_ENV, deps(IN_SESSION)).quotes(['SBIN']);
      assert.equal(bad.state, 'UNAVAILABLE');
      assert.match(bad.message, /auth failed/);
      noSecrets(bad);
      reply = new Response('<!DOCTYPE html><title>Sign in</title>', { status: 200 });
      const html = await providers.getProvider(SHEET_ENV, deps(IN_SESSION)).quotes(['SBIN']);
      assert.match(html.message, /did not return JSON/);
      reply = json(200, { ok: false, error: 'unknown action' });
      const action = await providers.getProvider(SHEET_ENV, deps(IN_SESSION)).status();
      assert.equal(action.ok, false);
      assert.match(action.message, /snapshot/);
      const calls = m.calls.length;
      const nc = providers.getProvider({ MARKET_DATA_PROVIDER: 'sheet', SHEET_FEED_URL: 'http://insecure.example/exec', SHEET_FEED_TOKEN: SHEET_TOKEN }, deps(IN_SESSION));
      assert.equal(nc.describe().configured, false);
      const q = await nc.quotes(['SBIN']);
      assert.equal(q.state, 'UNAVAILABLE');
      assert.equal(m.calls.length, calls, 'nothing fetched when not configured');
    } finally { m.restore(); }
  });

  // ---------- validation + cache ----------

  test('symbol and history validation', function () {
    assert.deepEqual(validate.parseSymbols('sbin, TCS,sbin,NSE:INFY,M&M,BAJAJ-AUTO'),
      { ok: true, symbols: ['SBIN', 'TCS', 'INFY', 'M&M', 'BAJAJ-AUTO'] });
    assert.equal(validate.parseSymbols(['SBIN', 'TCS']).symbols.length, 2);
    assert.equal(validate.parseSymbols('').ok, false);
    assert.equal(validate.parseSymbols(undefined).ok, false);
    assert.equal(validate.parseSymbols('SB.IN').ok, false);
    assert.equal(validate.parseSymbols('ABCDEFGHIJKLMNOPQRSTU').ok, false); // 21 chars
    const many = [];
    for (let i = 0; i < 501; i++) many.push('S' + i);
    assert.match(validate.parseSymbols(many.join(',')).error, /max 500/);
    assert.equal(validate.parseSymbols(many.slice(0, 500).join(',')).ok, true);
    const now = IST(IN_SESSION);
    assert.deepEqual(validate.parseHistoryQuery({ symbol: 'sbin', from: '2024-01-01', to: '2026-01-01' }, now),
      { ok: true, symbol: 'SBIN', from: '2024-01-01', to: '2026-01-01', interval: '1d' });
    assert.equal(validate.parseHistoryQuery({ symbol: 'SBIN', from: '2023-10-14', to: '2026-10-14' }, now).ok, true);
    assert.match(validate.parseHistoryQuery({ symbol: 'SBIN', from: '2023-10-13', to: '2026-10-14' }, now).error, /max 3 years/);
    assert.match(validate.parseHistoryQuery({ symbol: 'SBIN', from: '2026-02-30', to: '2026-03-01' }, now).error, /real date/);
    assert.match(validate.parseHistoryQuery({ symbol: 'SBIN', from: '2026-05-01', to: '2026-04-01' }, now).error, /on or before/);
    assert.match(validate.parseHistoryQuery({ symbol: 'SBIN', from: '2026-12-01' }, now).error, /future/);
    assert.match(validate.parseHistoryQuery({ symbol: 'SBIN', interval: '5m' }, now).error, /interval/);
    assert.equal(validate.parseHistoryQuery({}, now).ok, false);
    assert.equal(validate.parseHistoryQuery({ symbol: 'SBIN', from: '2026-10-01', to: '2026-12-31' }, now).to, '2026-10-14');
    assert.equal(validate.parseHistoryQuery({ symbol: 'SBIN' }, now).from, '2025-10-14');
  });

  test('cache: TTL, in-flight sharing, stale-on-error, cache-control headers', async function () {
    let t = 1000;
    const c = cacheLib.createCache({ now: function () { return t; } });
    c.set('a', 1, 100);
    assert.equal(c.get('a'), 1);
    t = 1100;
    assert.equal(c.get('a'), undefined);
    assert.deepEqual(c.peek('a'), { value: 1, expired: true });
    let loads = 0;
    const loader = function () { loads++; return new Promise(function (r) { setTimeout(function () { r('v'); }, 5); }); };
    const both = await Promise.all([c.getOrLoad('k', 1000, loader), c.getOrLoad('k', 1000, loader)]);
    assert.deepEqual(both, ['v', 'v']);
    assert.equal(loads, 1);
    t = 5000;
    const stale = await c.getOrLoad('k', 1000, function () { throw new Error('down'); }, { staleOnError: true });
    assert.equal(stale, 'v');
    await assert.rejects(c.getOrLoad('zz', 1000, function () { throw new Error('down'); }));
    assert.match(cacheLib.quotesCacheControl('open'), /s-maxage=15/);
    assert.match(cacheLib.quotesCacheControl('closed'), /s-maxage=60/);
    assert.match(cacheLib.historyCacheControl(), /s-maxage=21600/);
    const small = cacheLib.createCache({ maxEntries: 2 });
    small.set('1', 1, 1000); small.set('2', 2, 1000); small.set('3', 3, 1000);
    assert.equal(small.size(), 2);
    assert.equal(small.get('1'), undefined);
  });

  test('withTimeout settles even when the work never does', async function () {
    await assert.rejects(fetchUtil.withTimeout(20, function () { return new Promise(function () {}); }),
      function (err) { return err.code === 'TIMEOUT'; });
    const r = await fetchUtil.requestJson(function () { throw new TypeError('fetch failed'); }, 'https://x.invalid', {}, 50);
    assert.equal(r.error, 'network');
  });

  // ---------- endpoints (fake req/res) ----------

  /** Vercel-style res (status().json()) or a bare Node-style res (statusCode/setHeader/end). */
  const fakeRes = function (style) {
    const r = { headers: {}, statusCode: 200, body: undefined, ended: false };
    r.setHeader = function (k, v) { r.headers[String(k).toLowerCase()] = v; };
    r.end = function (text) { r.ended = true; if (text !== undefined) r.body = JSON.parse(text); };
    if (style !== 'node') {
      r.status = function (code) { r.statusCode = code; return r; };
      r.json = function (obj) { r.ended = true; r.body = JSON.parse(JSON.stringify(obj)); };
    }
    return r;
  };

  test('GET /api/market-status with no provider configured', async function () {
    const m = mockFetch(function () { throw new Error('no fetch expected'); });
    try {
      const h = statusApi.createHandler({ env: {}, now: fixedNow('2026-10-20 10:00') });
      const res = fakeRes();
      await h({ method: 'GET', query: {} }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['access-control-allow-origin'], '*');
      assert.match(res.headers['content-type'], /application\/json/);
      assert.match(res.headers['cache-control'], /s-maxage=30/);
      assert.deepEqual(res.body.provider, { name: 'none', configured: false, requires: ['MARKET_DATA_PROVIDER'],
                                            licensing: 'No market data is fetched or shown by the server.' });
      assert.equal(res.body.session.state, 'holiday'); // Dussehra 2026
      assert.equal(res.body.session.holiday, 'Dussehra');
      assert.equal(res.body.session.now, '2026-10-20 10:00');
      assert.equal(res.body.session.lastCompletedSession, '2026-10-19');
      assert.equal(res.body.status.ok, false);
      assert.equal(res.body.status.state, 'UNAVAILABLE');
      // default export is a ready handler too
      assert.equal(typeof statusApi, 'function');
    } finally { m.restore(); }
  });

  test('GET /api/market-status with dhan configured never leaks env values', async function () {
    const m = mockFetch(dhanHandler({ profile: function () { return json(200, { dhanClientId: CLIENT, dataPlan: 'Active' }); } }));
    try {
      const res = fakeRes('node');
      await statusApi.createHandler(Object.assign(deps(IN_SESSION), { env: DHAN_ENV }))({ method: 'GET', url: '/api/market-status' }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.provider.name, 'dhan');
      assert.equal(res.body.provider.configured, true);
      assert.deepEqual(res.body.provider.requires, ['DHAN_CLIENT_ID', 'DHAN_ACCESS_TOKEN']);
      assert.equal(res.body.session.state, 'open');
      assert.equal(res.body.status.state, 'LIVE');
      noSecrets(res.body);
    } finally { m.restore(); }
  });

  test('GET /api/quotes validates input with 400', async function () {
    const h = quotesApi.createHandler({ env: {}, now: fixedNow(IN_SESSION), cache: cacheLib.createCache() });
    const bad = ['', 'SB.IN', 'ABCDEFGHIJKLMNOPQRSTU', 'A,<script>'];
    for (const s of bad) {
      const res = fakeRes();
      await h({ method: 'GET', query: { symbols: s } }, res);
      assert.equal(res.statusCode, 400, 'symbols=' + s);
      assert.equal(typeof res.body.error, 'string');
      assert.equal(res.headers['cache-control'], 'no-store');
    }
    const many = [];
    for (let i = 0; i < 501; i++) many.push('S' + i);
    const res = fakeRes();
    await h({ method: 'GET', query: { symbols: many.join(',') } }, res);
    assert.equal(res.statusCode, 400);
    const missing = fakeRes('node');
    await h({ method: 'GET', url: '/api/quotes' }, missing);
    assert.equal(missing.statusCode, 400);
  });

  test('GET /api/quotes returns the provider payload (none and dhan)', async function () {
    const none = fakeRes();
    await quotesApi.createHandler({ env: {}, now: fixedNow(IN_SESSION), cache: cacheLib.createCache() })(
      { method: 'GET', query: { symbols: 'SBIN' } }, none);
    assert.equal(none.statusCode, 200);
    assert.equal(none.body.state, 'UNAVAILABLE');
    assert.match(none.headers['cache-control'], /s-maxage=15/);

    const m = mockFetch(dhanHandler());
    try {
      const d = Object.assign(deps(IN_SESSION), { env: DHAN_ENV });
      const h = quotesApi.createHandler(d);
      const res = fakeRes('node'); // plain Node response object
      await h({ method: 'GET', url: '/api/quotes?symbols=sbin,TCS' }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.ended, true);
      assert.equal(res.headers['access-control-allow-origin'], '*');
      assert.match(res.headers['cache-control'], /s-maxage=15/);
      assert.equal(res.body.state, 'LIVE');
      assert.deepEqual(res.body.items.map(function (i) { return i.id; }), ['NSE:SBIN', 'NSE:TCS']);
      noSecrets(res.body);
      // second identical request is served from the warm-instance cache
      const before = m.calls.length;
      const res2 = fakeRes();
      await h({ method: 'GET', query: { symbols: 'SBIN,TCS' } }, res2);
      assert.equal(m.calls.length, before);
      assert.equal(res2.body.items.length, 2);
    } finally { m.restore(); }
  });

  test('GET /api/history validates input and returns candles', async function () {
    const h0 = historyApi.createHandler({ env: {}, now: fixedNow(IN_SESSION), cache: cacheLib.createCache() });
    const badQueries = [
      {}, { symbol: 'SB.IN' }, { symbol: 'SBIN', from: '2026-02-30', to: '2026-03-10' },
      { symbol: 'SBIN', from: '2026-13-01' }, { symbol: 'SBIN', from: '2022-01-01', to: '2026-01-01' },
      { symbol: 'SBIN', from: '2026-05-01', to: '2026-04-01' }, { symbol: 'SBIN', interval: '1m' }
    ];
    for (const q of badQueries) {
      const res = fakeRes();
      await h0({ method: 'GET', query: q }, res);
      assert.equal(res.statusCode, 400, JSON.stringify(q));
    }
    const ts = function (d) { return IST(d) / 1000; };
    const m = mockFetch(dhanHandler({
      history: function () {
        return json(200, { open: [1, 2], high: [2, 3], low: [0.5, 1.5], close: [1.5, 2.5], volume: [10, 20],
                           timestamp: [ts('2026-10-12'), ts('2026-10-13')] });
      }
    }));
    try {
      const res = fakeRes();
      await historyApi.createHandler(Object.assign(deps(IN_SESSION), { env: DHAN_ENV }))(
        { method: 'GET', query: { symbol: 'SBIN', from: '2026-10-01', to: '2026-10-14' } }, res);
      assert.equal(res.statusCode, 200);
      assert.match(res.headers['cache-control'], /s-maxage=21600/);
      assert.equal(res.body.state, 'EOD');
      assert.deepEqual(res.body.candles.map(function (c) { return c.t; }), ['2026-10-12', '2026-10-13']);
      noSecrets(res.body);
    } finally { m.restore(); }
  });

  test('endpoints: only GET (405 without CORS, OPTIONS 204), crash -> 500 JSON', async function () {
    const h = quotesApi.createHandler({ env: {}, now: fixedNow(IN_SESSION), cache: cacheLib.createCache() });
    const post = fakeRes();
    await h({ method: 'POST', query: { symbols: 'SBIN' } }, post);
    assert.equal(post.statusCode, 405);
    assert.equal(post.headers['access-control-allow-origin'], undefined);
    assert.match(post.headers.allow, /GET/);
    const opt = fakeRes('node');
    await h({ method: 'OPTIONS' }, opt);
    assert.equal(opt.statusCode, 204);
    assert.equal(opt.headers['access-control-allow-methods'], 'GET');
    // a provider that throws must not crash the function or leak details
    const original = console.error;
    const logged = [];
    console.error = function (msg) { logged.push(String(msg)); };
    try {
      const boom = statusApi.createHandler({ env: { MARKET_DATA_PROVIDER: 'none', DHAN_ACCESS_TOKEN: TOKEN },
                                             now: function () { throw new Error('boom ' + TOKEN); } });
      const res = fakeRes();
      await boom({ method: 'GET', query: {} }, res);
      assert.equal(res.statusCode, 500);
      assert.deepEqual(res.body, { error: 'internal error' });
      assert.ok(logged.length === 1 && logged[0].indexOf(TOKEN) < 0, 'log line is redacted');
    } finally { console.error = original; }
  });
})();
