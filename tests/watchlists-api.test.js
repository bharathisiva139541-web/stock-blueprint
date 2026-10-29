// api/watchlists.js: the website's server between the browser's My Watchlists sync and the
// sheet (Code.gs doPost action 'watchlists'). It checks the request's shape, forwards it with
// the server-side feed token, never caches, never passes the sheet's own error text on, and
// answers the CORS preflight of the Firebase copy. No network: fetch is mocked.
(function () {
  'use strict';

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const { Readable } = require('node:stream');
  const api = require('../api/watchlists');
  const http = require('../api/_lib/http');

  globalThis.fetch = function () { return Promise.reject(new TypeError('network disabled in tests')); };

  const SHEET_URL = 'https://script.google.com/macros/s/AKfy_SECRET_DEPLOYMENT/exec';
  const SHEET_TOKEN = 'sheet_SECRET_987654';
  const ENV = { SHEET_FEED_URL: SHEET_URL, SHEET_FEED_TOKEN: SHEET_TOKEN };
  const LISTS = [{ id: 'w1', name: 'Swing', syms: ['TCS', 'INFY'], created: '2026-10-27T10:00:00.000Z', updated: '2026-10-28T10:00:00.000Z' }];

  const json = (status, obj) => new Response(typeof obj === 'string' ? obj : JSON.stringify(obj),
    { status: status, headers: { 'content-type': 'application/json' } });
  const mockFetch = function (handler) {
    const calls = [];
    const f = function (url, init) {
      const c = { url: String(url), init: init || {}, body: init && init.body ? JSON.parse(init.body) : null };
      calls.push(c);
      return Promise.resolve().then(() => handler(c, calls.length));
    };
    f.calls = calls;
    return f;
  };
  const fakeRes = function () {
    const r = { headers: {}, statusCode: 200, body: undefined };
    r.setHeader = (k, v) => { r.headers[String(k).toLowerCase()] = v; };
    r.status = (code) => { r.statusCode = code; return r; };
    r.json = (obj) => { r.body = JSON.parse(JSON.stringify(obj)); };
    r.end = () => {};
    return r;
  };
  const call = async function (h, body, method, extra) {
    const res = fakeRes();
    await h(Object.assign({ method: method || 'POST', body: body }, extra || {}), res);
    return res;
  };
  const noSecrets = (res) => {
    const text = JSON.stringify(res.body) + JSON.stringify(res.headers);
    [SHEET_URL, SHEET_TOKEN, 'AKfy_SECRET', 'Blue2026'].forEach((s) => assert.ok(text.indexOf(s) < 0, 'no secret / PIN in the answer: ' + s));
  };
  const sheetOk = (extra) => Object.assign({ ok: true, result: 'ok', rev: 3, savedAt: '2026-10-29 15:30:00', state: { v: 1, lists: LISTS } }, extra || {});

  test('get / put are forwarded with the feed token; the answer is the sheet\'s lists, never cached', async () => {
    const f = mockFetch(() => json(200, sheetOk()));
    const h = api.createHandler({ env: ENV, fetch: f });
    const r = await call(h, { op: 'get', pin: ' Blue2026 ' });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.body, { ok: true, result: 'ok', rev: 3, savedAt: '2026-10-29 15:30:00', state: { v: 1, lists: LISTS } });
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['access-control-allow-origin'], '*');
    assert.equal(f.calls[0].url, SHEET_URL);
    assert.deepEqual(f.calls[0].body, { action: 'watchlists', op: 'get', pin: 'Blue2026', token: SHEET_TOKEN });
    noSecrets(r);

    // put: only the known fields go, the lists cleaned with the website's rules
    const dirty = { v: 1, last: 'w1', extra: 'x', lists: [Object.assign({}, LISTS[0], { syms: ['tcs', 'TCS', 'bad sym', 'INFY'], note: 'x' }), { id: 'bad id', name: 'X' }] };
    await call(h, { op: 'put', pin: 'Blue2026', base: 3, state: dirty, token: 'mine', action: 'hist' });
    assert.deepEqual(f.calls[1].body, { action: 'watchlists', op: 'put', pin: 'Blue2026', base: 3, state: { v: 1, lists: LISTS }, token: SHEET_TOKEN });
    // a conflict comes back as it is (the browser merges)
    const fc = mockFetch(() => json(200, sheetOk({ result: 'conflict', rev: 4 })));
    const c = await call(api.createHandler({ env: ENV, fetch: fc }), { op: 'put', pin: 'Blue2026', base: 3, state: { lists: [] } });
    assert.equal(c.body.result, 'conflict');
    assert.equal(c.body.rev, 4);
    assert.deepEqual(c.body.state.lists, LISTS);
  });

  test('bad requests are answered here (400 / 405 / 413) and never reach the sheet', async () => {
    const f = mockFetch(() => { throw new Error('must not be called'); });
    const h = api.createHandler({ env: ENV, fetch: f });
    const cases = [
      [{ op: 'delete', pin: 'Blue2026' }, /op must be/],
      [{ op: 'get' }, /pin missing/],
      [{ op: 'get', pin: '   ' }, /pin missing/],
      [{ op: 'get', pin: 'x'.repeat(65) }, /pin missing/],
      [{ op: 'put', pin: 'Blue2026', state: { lists: [] } }, /base must be/],
      [{ op: 'put', pin: 'Blue2026', base: -1, state: { lists: [] } }, /base must be/],
      [{ op: 'put', pin: 'Blue2026', base: 1.5, state: { lists: [] } }, /base must be/],
      [{ op: 'put', pin: 'Blue2026', base: 1 }, /state.lists missing/],
      ['not json', /must be JSON/],
      ['[1]', /JSON object/],
      [null, /JSON object/]
    ];
    for (const [body, re] of cases) {
      const r = await call(h, body);
      assert.equal(r.statusCode, 400, JSON.stringify(body));
      assert.match(r.body.error, re);
      assert.equal(r.headers['cache-control'], 'no-store');
    }
    const bodyless = { method: 'POST' };
    Object.defineProperty(bodyless, 'body', { get: function () { throw new Error('Invalid JSON'); } });   // Vercel's parser on bad JSON
    const throwing = fakeRes();
    await h(bodyless, throwing);
    assert.equal(throwing.statusCode, 400);
    assert.match(throwing.body.error, /must be JSON/);
    const g = await call(h, undefined, 'GET');
    assert.equal(g.statusCode, 405);
    assert.match(g.body.error, /use POST/);
    assert.equal(g.headers.allow, 'POST, OPTIONS');
    // the Firebase copy's preflight
    const o = await call(h, undefined, 'OPTIONS');
    assert.equal(o.statusCode, 204);
    assert.equal(o.headers['access-control-allow-methods'], 'POST');
    assert.equal(o.headers['access-control-allow-headers'], 'Content-Type');
    assert.equal(o.headers['access-control-allow-origin'], '*');
    assert.equal(f.calls.length, 0);
  });

  test('a plain Node request body is read from the stream (with a size limit)', async () => {
    const f = mockFetch(() => json(200, sheetOk()));
    const h = api.createHandler({ env: ENV, fetch: f });
    const stream = (text) => Object.assign(Readable.from([Buffer.from(text.slice(0, 5)), Buffer.from(text.slice(5))]), { method: 'POST' });
    const res = fakeRes();
    await h(stream(JSON.stringify({ op: 'get', pin: 'Blue2026' })), res);
    assert.equal(res.body.ok, true);
    const big = fakeRes();
    await h(stream(JSON.stringify({ op: 'put', pin: 'Blue2026', base: 0, state: { lists: [{ id: 'w', name: 'x'.repeat(700 * 1024) }] } })), big);
    assert.equal(big.statusCode, 413);
    assert.equal(f.calls.length, 1);
  });

  test('the sheet\'s refusals become fixed messages with a code (PIN, lock, no PIN, old web app ...)', async () => {
    const cases = [
      [{ ok: false, error: 'wrong PIN' }, 'pin', /^wrong PIN$/],
      [{ ok: false, error: 'wrong PIN - PIN locked for 15 min' }, 'locked', /^wrong PIN - too many wrong PINs: the watchlists are locked for 15 min/],
      [{ ok: false, error: 'PIN locked for 7 min' }, 'locked', /^too many wrong PINs: the watchlists are locked for 7 min/],
      [{ ok: false, error: 'no PIN set yet - sheet menu 3 > My Watchlists sync: set / change PIN' }, 'nopin', /no watchlist PIN yet/],
      [{ ok: false, error: 'bad token' }, 'auth', /rejected SHEET_FEED_TOKEN[\s\S]*older version without My Watchlists sync/],
      [{ ok: false, error: 'sheet busy - try again' }, 'busy', /busy/],
      [{ ok: false, error: 'watchlists too big to keep' }, 'too-big', /too big/],
      [{ ok: false, error: 'the stored watchlists (tab Site_Watchlists) could not be read - unreadable' }, 'unreadable', /could not be read/],
      [{ ok: false, error: 'TypeError: something at line 123 ' + SHEET_URL }, 'error', /^sheet feed returned an error$/],
      [{ ok: true, result: 'maybe', rev: 1, state: { lists: [] } }, 'malformed', /unexpected/],
      [{ ok: true, result: 'ok', rev: '1', state: { lists: [] } }, 'malformed', /unexpected/],
      [{ ok: true, result: 'ok', rev: 1 }, 'malformed', /unexpected/],
      ['<html>login</html>', 'malformed', /did not return JSON/]
    ];
    for (const [answer, code, re] of cases) {
      const h = api.createHandler({ env: ENV, fetch: mockFetch(() => (typeof answer === 'string'
        ? new Response(answer, { status: 200, headers: { 'content-type': 'text/html' } }) : json(200, answer))) });
      const r = await call(h, { op: 'get', pin: 'Blue2026' });
      assert.equal(r.statusCode, 200);
      assert.equal(r.body.ok, false);
      assert.equal(r.body.code, code, JSON.stringify(answer));
      assert.match(r.body.message, re);
      noSecrets(r);
    }
    const down = await call(api.createHandler({ env: ENV, fetch: mockFetch(() => { throw new TypeError('fetch failed'); }) }), { op: 'get', pin: 'Blue2026' });
    assert.equal(down.body.code, 'network');
    const none = await call(api.createHandler({ env: {}, fetch: mockFetch(() => json(200, sheetOk())) }), { op: 'get', pin: 'Blue2026' });
    assert.equal(none.body.code, 'not-configured');
    assert.match(none.body.message, /set SHEET_FEED_URL and SHEET_FEED_TOKEN in Vercel/);
  });

  test('end to end with the real Code.gs: PIN, lock, no PIN, save, conflict', async () => {
    const mock = require('./fixtures/apps-script-mock');
    const env = mock.loadCodeGs({ sheets: [{ name: 'Main', rows: [[], ['SYMBOL']] }] },
      { now: Date.UTC(2026, 9, 29, 10, 0), props: { AB_FEED_TOKEN: SHEET_TOKEN }, prompts: ['Blue2026', 'Blue2026'] });
    const h = api.createHandler({ env: ENV, fetch: mockFetch((c) => json(200, env.post(c.body))) });
    const ask = async (body) => (await call(h, Object.assign({ pin: 'Blue2026' }, body))).body;
    assert.equal((await ask({ op: 'get' })).code, 'nopin');
    env.call('runWatchlistPinSetup');
    assert.deepEqual(await ask({ op: 'get' }), { ok: true, result: 'ok', rev: 0, savedAt: '', state: { v: 1, lists: [] } });
    const saved = await ask({ op: 'put', base: 0, state: { v: 1, lists: LISTS } });
    assert.equal(saved.rev, 1);
    assert.deepEqual(saved.state.lists, LISTS);
    const c = await ask({ op: 'put', base: 0, state: { v: 1, lists: [] } });
    assert.equal(c.result, 'conflict');
    assert.deepEqual(c.state.lists, LISTS);
    for (let i = 0; i < 4; i++) assert.equal((await ask({ op: 'get', pin: 'nope' + i })).code, 'pin');
    const locked = await ask({ op: 'get', pin: 'nope4' });
    assert.equal(locked.code, 'locked');
    assert.match(locked.message, /locked for 15 min/);
    assert.equal((await ask({ op: 'get' })).code, 'locked', 'the right PIN waits too');
  });

  test('GET endpoints keep their method rules', () => {
    const res = fakeRes();
    assert.equal(http.rejectNonGet({ method: 'POST' }, res), true);
    assert.equal(res.statusCode, 405);
    assert.equal(res.body.error, 'method not allowed - use GET');
    assert.equal(res.headers.allow, 'GET, HEAD, OPTIONS');
    assert.equal(http.rejectNonGet({ method: 'HEAD' }, fakeRes()), false);
    const o = fakeRes();
    http.rejectNonGet({ method: 'OPTIONS' }, o);
    assert.equal(o.headers['access-control-allow-methods'], 'GET');
    assert.equal(o.headers['access-control-allow-headers'], undefined);
  });
})();
