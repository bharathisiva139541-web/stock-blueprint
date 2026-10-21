// Tests for the live site feed: api/site.js, api/_lib/sheet-feed.js and the
// honest price state of sheet data (providers/sheet.js sheetPriceState).
// Network is never used: the handler gets a mocked fetch, and the global
// fetch fails at once.
(function () {
  'use strict';

  const test = require('node:test');
  const assert = require('node:assert/strict');

  const cal = require('../api/_lib/market-calendar');
  const cacheLib = require('../api/_lib/cache');
  const sheetFeed = require('../api/_lib/sheet-feed');
  const sheetLib = require('../api/_lib/providers/sheet');
  const siteApi = require('../api/site');

  globalThis.fetch = function () { return Promise.reject(new TypeError('network disabled in tests')); };

  // Fake secrets (never real values).
  const SHEET_URL = 'https://script.google.com/macros/s/AKfy_SECRET_DEPLOYMENT/exec';
  const SHEET_TOKEN = 'sheet_SECRET_987654';
  const ENV = { SHEET_FEED_URL: SHEET_URL, SHEET_FEED_TOKEN: SHEET_TOKEN };

  const IST = function (s) { return cal.parseIstDateTime(s); };
  const IN_SESSION = '2026-10-14 11:00';   // Wednesday, market open

  const MAIN_DATA = {
    generated: '2026-10-14 10:55',
    source: 'Google Sheet (live feed)',
    main: { cols: ['sym', 'name', 'price', 'chg'],
            rows: [['SBIN', 'State Bank of India', 812.5, 1.56], ['TCS', 'Tata Consultancy', 3000, -0.5]] },
    resultsTracker: [],
    resultsPerf: { note: '', seasons: [], verdicts: [], lines: [], table: [] },
    asOf: '2026-10-14 10:30',
    alerts: { cols: ['sym', 'type'], rows: [['SBIN', 'Breakout']], note: '' }
  };
  const HISTORY_DATA = {
    asOf: '2026-10-14 10:30',
    source: 'History30 tab (GOOGLEFINANCE daily candles)',
    timeframe: '1d',
    dates: ['2026-10-13', '2026-10-14'],
    cols: ['d', 'o', 'h', 'l', 'c', 'v'],
    bars: { SBIN: [[0, 800, 810, 795, 805, 1000], [1, 805, 815, 800, 812.5, 1200]] },
    sheetTags: {}
  };

  const json = function (status, obj) {
    return new Response(typeof obj === 'string' ? obj : JSON.stringify(obj),
      { status: status, headers: { 'content-type': 'application/json' } });
  };
  const siteReply = function (part, data, readAt) {
    return { ok: true, part: part, readAt: readAt || '2026-10-14 10:55', tz: 'Asia/Kolkata',
             data: data || (part === 'history' ? HISTORY_DATA : MAIN_DATA) };
  };

  /** fetch mock: handler(call, n) -> Response | Promise. Calls are recorded on .calls. */
  const mockFetch = function (handler) {
    const calls = [];
    const f = function (url, init) {
      const c = { url: String(url), init: init || {}, body: null };
      try { c.body = init && init.body ? JSON.parse(init.body) : null; } catch { c.body = init.body; }
      calls.push(c);
      return Promise.resolve().then(function () { return handler(c, calls.length); });
    };
    f.calls = calls;
    return f;
  };

  /** A settable clock shared by the handler and its cache. */
  const clockAt = function (s) {
    const clock = { t: IST(s) };
    clock.now = function () { return clock.t; };
    clock.set = function (str) { clock.t = IST(str); };
    clock.add = function (ms) { clock.t += ms; };
    return clock;
  };

  const handlerFor = function (fetchImpl, clock, extra) {
    const c = clock || clockAt(IN_SESSION);
    return siteApi.createHandler(Object.assign({
      env: ENV, fetch: fetchImpl, now: c.now, cache: cacheLib.createCache({ now: c.now })
    }, extra || {}));
  };

  /** Vercel-style res (status().json()) or a bare Node-style res. */
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

  const get = async function (h, part, style) {
    const res = fakeRes(style);
    const req = style === 'node' ? { method: 'GET', url: '/api/site?part=' + encodeURIComponent(part) }
                                 : { method: 'GET', query: part === undefined ? {} : { part: part } };
    await h(req, res);
    return res;
  };

  const noSecrets = function (value) {
    const text = JSON.stringify(value);
    [SHEET_URL, SHEET_TOKEN, 'AKfy_SECRET'].forEach(function (s) {
      assert.ok(text.indexOf(s) < 0, 'response must not contain a secret');
    });
  };

  const MAIN_CC = 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600';
  const HISTORY_CC = 'public, max-age=0, s-maxage=1800, stale-while-revalidate=21600';
  const STALE_CC = 'public, max-age=0, s-maxage=60';
  const UNAVAILABLE_CC = cacheLib.unavailableCacheControl();

  // ---------- sheet-feed client ----------

  test('sheet-feed: configured() needs both vars and an https URL', function () {
    assert.equal(sheetFeed.configured({}), false);
    assert.equal(sheetFeed.configured(undefined), false);
    assert.equal(sheetFeed.configured({ SHEET_FEED_URL: SHEET_URL }), false);
    assert.equal(sheetFeed.configured({ SHEET_FEED_TOKEN: SHEET_TOKEN }), false);
    assert.equal(sheetFeed.configured({ SHEET_FEED_URL: 'http://insecure.example/exec', SHEET_FEED_TOKEN: SHEET_TOKEN }), false);
    assert.equal(sheetFeed.configured({ SHEET_FEED_URL: ' ' + SHEET_URL + ' ', SHEET_FEED_TOKEN: ' ' + SHEET_TOKEN }), true);
    assert.deepEqual(sheetFeed.readConfig({ SHEET_FEED_URL: SHEET_URL }).missing, ['SHEET_FEED_TOKEN']);
    const msg = sheetFeed.notConfiguredMessage({ SHEET_FEED_URL: SHEET_URL }, 'Lead');
    assert.match(msg, /^Lead: set SHEET_FEED_TOKEN in Vercel/);
    assert.ok(msg.indexOf(SHEET_URL) < 0, 'env values are never part of a message');
    assert.match(sheetFeed.notConfiguredMessage({ SHEET_FEED_URL: 'http://x.example', SHEET_FEED_TOKEN: 'abc' }, 'Lead'),
      /^Lead: SHEET_FEED_URL must be the https:\/\/ \/exec URL/);
  });

  test('sheet-feed: postFeed sends the env token in a JSON POST and follows redirects', async function () {
    const f = mockFetch(function () { return json(200, { ok: true, x: 1 }); });
    const r = await sheetFeed.postFeed(ENV, { fetch: f }, { action: 'site', part: 'main', token: 'body-cannot-override' }, 1000);
    assert.deepEqual(r, { ok: true, data: { ok: true, x: 1 } });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, SHEET_URL);
    assert.equal(f.calls[0].init.method, 'POST');
    assert.equal(f.calls[0].init.redirect, 'follow');
    assert.match(f.calls[0].init.headers['Content-Type'], /application\/json/);
    assert.deepEqual(f.calls[0].body, { action: 'site', part: 'main', token: SHEET_TOKEN });
    const nc = await sheetFeed.postFeed({}, { fetch: f }, { action: 'site' }, 1000);
    assert.equal(nc.ok, false);
    assert.equal(nc.code, 'not-configured');
    assert.equal(f.calls.length, 1, 'nothing fetched when not configured');
  });

  // ---------- honest price state ----------

  test('sheetPriceState: DELAYED only for today\'s session reads, EOD after the close, CACHED for old copies', function () {
    const s = function (readAt, now) { return sheetLib.sheetPriceState(readAt === null ? null : IST(readAt), IST(now)); };
    assert.equal(sheetLib.sheetPriceState(null, IST(IN_SESSION)), 'CACHED');
    assert.equal(sheetLib.sheetPriceState(NaN, IST(IN_SESSION)), 'CACHED');
    assert.equal(sheetLib.sheetPriceState(undefined, IST(IN_SESSION)), 'CACHED');
    // market open (Wednesday 2026-10-14)
    assert.equal(s('2026-10-14 10:55', IN_SESSION), 'DELAYED');
    assert.equal(s('2026-10-14 09:15', IN_SESSION), 'DELAYED');
    assert.equal(s('2026-10-14 09:05', IN_SESSION), 'EOD', 'read before the open = previous close');
    assert.equal(s('2026-10-13 15:45', IN_SESSION), 'EOD');
    assert.equal(s('2026-10-13 15:10', IN_SESSION), 'CACHED', 'mid-session copy of an earlier day');
    assert.equal(s('2026-10-09 15:20', IN_SESSION), 'CACHED');
    // just after the close, GOOGLEFINANCE still settling until 16:00
    assert.equal(s('2026-10-14 15:40', '2026-10-14 15:45'), 'DELAYED');
    assert.equal(s('2026-10-14 15:10', '2026-10-14 15:59'), 'DELAYED');
    assert.equal(s('2026-10-14 15:58', '2026-10-14 16:00'), 'EOD');
    assert.equal(s('2026-10-14 16:25', '2026-10-14 16:30'), 'EOD');
    assert.equal(s('2026-10-14 15:10', '2026-10-14 16:30'), 'CACHED', 'mid-session copy after the close');
    // trading day before the open / pre-open
    assert.equal(s('2026-10-15 08:25', '2026-10-15 08:30'), 'EOD');
    assert.equal(s('2026-10-15 09:04', '2026-10-15 09:05'), 'EOD');
    // weekend and holiday: never DELAYED
    assert.equal(s('2026-10-18 11:59', '2026-10-18 12:00'), 'EOD');
    assert.equal(s('2026-10-16 15:45', '2026-10-18 12:00'), 'EOD');
    assert.equal(s('2026-10-16 15:10', '2026-10-18 12:00'), 'CACHED');
    assert.equal(s('2026-10-20 09:58', '2026-10-20 10:00'), 'EOD', 'Dussehra 2026');
    assert.equal(s('2026-10-20 15:40', '2026-10-20 15:45'), 'EOD');
  });

  // ---------- GET /api/site ----------

  test('GET /api/site: not configured -> ok:false, configured:false, no fetch', async function () {
    const f = mockFetch(function () { throw new Error('must not fetch'); });
    const cases = [
      [{}, /set SHEET_FEED_URL and SHEET_FEED_TOKEN in Vercel/],
      [{ MARKET_DATA_PROVIDER: 'sheet', SHEET_FEED_URL: SHEET_URL }, /set SHEET_FEED_TOKEN in Vercel/],
      [{ SHEET_FEED_URL: 'http://insecure.example/exec', SHEET_FEED_TOKEN: SHEET_TOKEN }, /https:\/\//]
    ];
    for (const c of cases) {
      const h = siteApi.createHandler({ env: c[0], fetch: f, now: clockAt(IN_SESSION).now, cache: cacheLib.createCache() });
      const res = await get(h, 'main');
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.configured, false);
      assert.equal(res.body.part, 'main');
      assert.match(res.body.message, /^Live site feed not configured: /);
      assert.match(res.body.message, c[1]);
      assert.equal(res.headers['cache-control'], UNAVAILABLE_CC);
      assert.equal(res.headers['access-control-allow-origin'], '*');
      noSecrets(res.body);
    }
    assert.equal(f.calls.length, 0);
    assert.equal(typeof siteApi, 'function', 'default export is a ready handler');
  });

  test('GET /api/site: bad part -> 400 no-store, nothing fetched', async function () {
    const f = mockFetch(function () { throw new Error('must not fetch'); });
    const h = handlerFor(f);
    for (const p of [undefined, '', 'all', 'main,history', ['main', 'history'], 'History30']) {
      const res = await get(h, p);
      assert.equal(res.statusCode, 400, 'part=' + JSON.stringify(p));
      assert.match(res.body.error, /part must be "main" or "history"/);
      assert.equal(res.headers['cache-control'], 'no-store');
    }
    const node = await get(h, 'nope', 'node');
    assert.equal(node.statusCode, 400);
    assert.equal(f.calls.length, 0);
  });

  test('GET /api/site?part=main: shape, DELAYED in session, cache headers, independent of MARKET_DATA_PROVIDER', async function () {
    const f = mockFetch(function (c) { return json(200, siteReply(c.body.part)); });
    const clock = clockAt(IN_SESSION);
    const h = siteApi.createHandler({ env: Object.assign({ MARKET_DATA_PROVIDER: 'none' }, ENV), fetch: f,
                                      now: clock.now, cache: cacheLib.createCache({ now: clock.now }) });
    const res = await get(h, ' MAIN ');
    assert.equal(res.statusCode, 200);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, SHEET_URL);
    assert.equal(f.calls[0].init.method, 'POST');
    assert.equal(f.calls[0].init.redirect, 'follow');
    assert.deepEqual(f.calls[0].body, { action: 'site', part: 'main', token: SHEET_TOKEN });
    assert.deepEqual(Object.keys(res.body),
      ['ok', 'configured', 'part', 'readAt', 'fetchedAt', 'stale', 'session', 'priceState', 'data']);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.configured, true);
    assert.equal(res.body.part, 'main');
    assert.equal(res.body.readAt, '2026-10-14 10:55');
    assert.equal(res.body.fetchedAt, '2026-10-14 11:00');
    assert.equal(res.body.stale, false);
    assert.deepEqual(res.body.session, { state: 'open', lastCompletedSession: '2026-10-13' });
    assert.equal(res.body.priceState, 'DELAYED');
    assert.deepEqual(res.body.data, MAIN_DATA);
    assert.equal(res.headers['cache-control'], MAIN_CC);
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.match(res.headers['content-type'], /application\/json/);
    noSecrets(res.body);
  });

  test('GET /api/site?part=history: shape and 30-minute cache headers (plain Node response)', async function () {
    const f = mockFetch(function (c) { return json(200, siteReply(c.body.part)); });
    const res = await get(handlerFor(f), 'history', 'node');
    assert.equal(res.statusCode, 200);
    assert.equal(res.ended, true);
    assert.deepEqual(f.calls[0].body, { action: 'site', part: 'history', token: SHEET_TOKEN });
    assert.equal(res.body.part, 'history');
    assert.equal(res.body.priceState, 'DELAYED');
    assert.deepEqual(res.body.data, HISTORY_DATA);
    assert.equal(res.headers['cache-control'], HISTORY_CC);
    noSecrets(res.body);
  });

  test('GET /api/site: priceState outside the session (EOD evening / weekend / holiday, CACHED without readAt)', async function () {
    const cases = [
      ['2026-10-14 16:30', '2026-10-14 16:29', 'EOD', 'closed'],
      ['2026-10-14 15:45', '2026-10-14 15:44', 'DELAYED', 'closed'],
      ['2026-10-18 12:00', '2026-10-18 11:58', 'EOD', 'weekend'],
      ['2026-10-20 10:00', '2026-10-20 09:59', 'EOD', 'holiday'],
      ['2026-10-14 11:00', 'not a time', 'CACHED', 'open']
    ];
    for (const c of cases) {
      const f = mockFetch(function () { return json(200, siteReply('main', MAIN_DATA, c[1])); });
      const res = await get(handlerFor(f, clockAt(c[0])), 'main');
      assert.equal(res.body.ok, true, c[0]);
      assert.equal(res.body.priceState, c[2], c[0] + ' read ' + c[1]);
      assert.equal(res.body.session.state, c[3]);
      assert.equal(res.body.readAt, c[1] === 'not a time' ? null : c[1]);
    }
  });

  test('GET /api/site: warm-instance cache (main 5 min, history 30 min), one fetch for parallel requests', async function () {
    let n = 0;
    const f = mockFetch(function (c) {
      n++;
      return json(200, siteReply(c.body.part, null, n === 1 ? '2026-10-14 10:55' : '2026-10-14 11:05'));
    });
    const clock = clockAt(IN_SESSION);
    const h = handlerFor(f, clock);
    const both = await Promise.all([get(h, 'main'), get(h, 'main')]);
    assert.equal(f.calls.length, 1, 'parallel requests share one sheet read');
    assert.equal(both[1].body.readAt, '2026-10-14 10:55');
    clock.add(4 * 60 * 1000);
    const warm = await get(h, 'main');
    assert.equal(f.calls.length, 1);
    assert.equal(warm.body.stale, false);
    assert.equal(warm.body.fetchedAt, '2026-10-14 11:04');
    clock.add(61 * 1000);
    const fresh = await get(h, 'main');
    assert.equal(f.calls.length, 2, 'main is re-read after 5 minutes');
    assert.equal(fresh.body.readAt, '2026-10-14 11:05');
    await get(h, 'history');
    assert.equal(f.calls.length, 3);
    clock.add(29 * 60 * 1000);
    await get(h, 'history');
    assert.equal(f.calls.length, 3, 'history is kept for 30 minutes');
  });

  test('GET /api/site: stale-on-error serves the last good copy (CACHED), then recovers', async function () {
    let mode = 'ok';
    const f = mockFetch(function (c) {
      if (mode === 'busy') return json(200, { ok: false, error: 'sheet busy - try again' });
      if (mode === 'down') return Promise.reject(new TypeError('fetch failed'));
      return json(200, siteReply(c.body.part, null, mode === 'ok' ? '2026-10-14 10:55' : '2026-10-14 11:06'));
    });
    const clock = clockAt(IN_SESSION);
    const h = handlerFor(f, clock);
    const first = await get(h, 'main');
    assert.equal(first.body.stale, false);

    clock.add(6 * 60 * 1000);
    mode = 'busy';
    const stale = await get(h, 'main');
    assert.equal(stale.statusCode, 200);
    assert.equal(stale.body.ok, true);
    assert.equal(stale.body.stale, true);
    assert.equal(stale.body.staleReason, 'sheet busy - try again shortly');
    assert.equal(stale.body.priceState, 'CACHED');
    assert.equal(stale.body.readAt, '2026-10-14 10:55');
    assert.equal(stale.body.fetchedAt, '2026-10-14 11:06');
    assert.deepEqual(stale.body.data, MAIN_DATA);
    assert.deepEqual(Object.keys(stale.body),
      ['ok', 'configured', 'part', 'readAt', 'fetchedAt', 'stale', 'staleReason', 'session', 'priceState', 'data']);
    assert.equal(stale.headers['cache-control'], STALE_CC);

    mode = 'down';
    const stale2 = await get(h, 'main');
    assert.equal(stale2.body.stale, true);
    assert.match(stale2.body.staleReason, /not reachable/);

    mode = 'recovered';
    const back = await get(h, 'main');
    assert.equal(back.body.stale, false);
    assert.equal('staleReason' in back.body, false);
    assert.equal(back.body.readAt, '2026-10-14 11:06');
    assert.equal(back.body.priceState, 'DELAYED');
    assert.equal(back.headers['cache-control'], MAIN_CC);

    // the other part has its own copy: no stale copy -> ok:false
    mode = 'busy';
    const hist = await get(h, 'history');
    assert.equal(hist.body.ok, false);
    assert.equal(hist.body.configured, true);
    assert.equal(hist.body.message, 'sheet busy - try again shortly');
    assert.equal(hist.headers['cache-control'], UNAVAILABLE_CC);
  });

  test('GET /api/site: privacy guard blocks personal-data markers (and keeps the last good copy)', async function () {
    const withCell = function (cell) {
      const d = JSON.parse(JSON.stringify(MAIN_DATA));
      d.main.rows[0][1] = cell;
      return d;
    };
    const bad = [
      withCell('write to someone.private@example.com'),
      withCell('see https://script.google.com/macros/s/xyz/exec'),
      withCell('AKfycb' + 'x'.repeat(40)),
      Object.assign({}, MAIN_DATA, { trades: [] }),
      Object.assign({}, MAIN_DATA, { tradeStats: { wins: 1 } })
    ];
    for (const data of bad) {
      const f = mockFetch(function () { return json(200, siteReply('main', data)); });
      const res = await get(handlerFor(f), 'main');
      assert.equal(res.body.ok, false);
      assert.equal(res.body.message, 'blocked: the sheet feed contained personal-data markers');
      assert.equal(res.headers['cache-control'], UNAVAILABLE_CC);
      const text = JSON.stringify(res.body);
      assert.ok(text.indexOf('example.com') < 0 && text.indexOf('AKfycb') < 0 && text.indexOf('xyz/exec') < 0);
      assert.equal('data' in res.body, false);
    }
    // a good copy first, then a leaking one: the good copy is served as stale
    let leak = false;
    const f = mockFetch(function () { return json(200, siteReply('main', leak ? bad[0] : MAIN_DATA)); });
    const clock = clockAt(IN_SESSION);
    const h = handlerFor(f, clock);
    await get(h, 'main');
    leak = true;
    clock.add(6 * 60 * 1000);
    const res = await get(h, 'main');
    assert.equal(res.body.ok, true);
    assert.equal(res.body.stale, true);
    assert.match(res.body.staleReason, /^blocked: /);
    assert.deepEqual(res.body.data, MAIN_DATA);
    assert.ok(JSON.stringify(res.body).indexOf('example.com') < 0);
    // the guard uses the same markers as the build scan of web/data
    assert.equal(siteApi.PERSONAL_MARKERS.length, 5);
  });

  test('GET /api/site: failure reasons are fixed texts (no upstream text, no env values)', async function () {
    const cases = [
      ['main', function () { return new Promise(function () {}); }, /^sheet feed timed out/],
      ['main', function () { return Promise.reject(new TypeError('getaddrinfo ' + SHEET_URL)); }, /^sheet feed not reachable \(network error\)$/],
      ['main', function () { return new Response('<!DOCTYPE html><title>Sign in</title>', { status: 200 }); },
        /did not return JSON \(is the web app deployed with access "Anyone"\?\)/],
      ['main', function () { return new Response('', { status: 200 }); }, /did not return JSON/],
      ['main', function () { return json(500, { error: 'boom ' + SHEET_TOKEN }); }, /^sheet feed failed \(HTTP 500\)$/],
      ['main', function () { return json(200, { ok: false, error: 'bad token' }); },
        /^auth failed: the sheet rejected SHEET_FEED_TOKEN .*deploy a New version of the EXISTING web-app deployment\)$/],
      ['main', function () { return json(200, { ok: false, error: 'unknown action' }); },
        /does not support action "site" yet .*New version of the EXISTING web-app deployment/],
      ['history', function () { return json(200, { ok: false, error: 'unknown part' }); },
        /does not support part "history" yet .*New version of the EXISTING web-app deployment/],
      ['main', function () { return json(200, { ok: false, error: 'sheet busy - try again' }); }, /^sheet busy - try again shortly$/],
      ['history', function () {
        return json(200, { ok: false, error: 'sheet is updating (History30 has 12 of 1800 symbols) - try again shortly' });
      }, /^sheet is updating \(History30 has 12 of 1800 symbols\) - try again shortly$/],
      ['main', function () { return json(200, { ok: false, error: 'Exception: secret cell ' + SHEET_TOKEN + ' private@example.com' }); },
        /^sheet feed returned an error$/],
      ['main', function () { return json(200, { ok: true, part: 'main', readAt: '2026-10-14 10:55', data: {} }); },
        /^malformed site feed \(main\.cols\/rows missing\)$/],
      ['main', function () { return json(200, siteReply('main', { main: { cols: ['sym'], rows: [] } })); }, /no Main rows/],
      ['main', function () { return json(200, siteReply('history')); }, /^malformed site feed \(wrong part\)$/],
      ['history', function () { return json(200, siteReply('history', { dates: [], cols: [], bars: [] })); },
        /^malformed site feed \(dates\/cols\/bars missing\)$/],
      ['history', function () { return json(200, siteReply('history', Object.assign({}, HISTORY_DATA, { bars: {} }))); },
        /no History30 bars/]
    ];
    for (const c of cases) {
      const f = mockFetch(c[1]);
      const res = await get(handlerFor(f, null, { timeoutMs: 30 }), c[0]);
      assert.equal(res.statusCode, 200, String(c[2]));
      assert.equal(res.body.ok, false, String(c[2]));
      assert.equal(res.body.configured, true);
      assert.equal(res.body.part, c[0]);
      assert.match(res.body.message, c[2]);
      assert.equal(res.headers['cache-control'], UNAVAILABLE_CC);
      assert.ok(JSON.stringify(res.body).indexOf('example.com') < 0, 'upstream text is not passed through');
      noSecrets(res.body);
    }
  });

  test('GET /api/site: env values are scrubbed even if the sheet data contains them', async function () {
    const d = JSON.parse(JSON.stringify(MAIN_DATA));
    d.main.rows[1][1] = 'oops ' + SHEET_TOKEN;
    const f = mockFetch(function () { return json(200, siteReply('main', d)); });
    const res = await get(handlerFor(f), 'main');
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.main.rows[1][1], 'oops [redacted]');
    noSecrets(res.body);
  });

  test('GET /api/site: only GET (405 without CORS, OPTIONS 204), crashes never leak', async function () {
    const none = mockFetch(function () { throw new Error('must not fetch'); });
    const h = handlerFor(none);
    const post = fakeRes();
    await h({ method: 'POST', query: { part: 'main' } }, post);
    assert.equal(post.statusCode, 405);
    assert.equal(post.headers['access-control-allow-origin'], undefined);
    const opt = fakeRes('node');
    await h({ method: 'OPTIONS' }, opt);
    assert.equal(opt.statusCode, 204);
    assert.equal(none.calls.length, 0);

    const f = mockFetch(function () { return json(200, siteReply('main')); });
    const original = console.error;
    const logged = [];
    console.error = function (msg) { logged.push(String(msg)); };
    try {
      // a bug inside the sheet read -> generic ok:false (logged without secrets)
      const inLoad = siteApi.createHandler({ env: ENV, fetch: f, cache: cacheLib.createCache(),
                                             now: function () { throw new Error('boom ' + SHEET_TOKEN); } });
      const r1 = await get(inLoad, 'main');
      assert.equal(r1.statusCode, 200);
      assert.deepEqual(r1.body, { ok: false, configured: true, part: 'main', message: 'sheet feed failed' });
      // a crash after the read -> 500 JSON with a generic message
      let calls = 0;
      const after = siteApi.createHandler({ env: ENV, fetch: f, cache: cacheLib.createCache(),
                                            now: function () { calls++; if (calls > 1) throw new Error('boom ' + SHEET_TOKEN); return IST(IN_SESSION); } });
      const r2 = await get(after, 'main');
      assert.equal(r2.statusCode, 500);
      assert.deepEqual(r2.body, { error: 'internal error' });
      assert.equal(logged.length, 2);
      assert.ok(logged.every(function (l) { return l.indexOf(SHEET_TOKEN) < 0 && l.indexOf('[redacted]') > 0; }), 'log lines are redacted');
    } finally { console.error = original; }
  });
})();
