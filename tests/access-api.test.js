'use strict';
// The website only for the persons with an access code (owner, 28-Nov-2026): api/access (login / renew / logout through
// the REAL Code.gs / Code2.gs in the Apps Script mock), the signed session, the 6-hour content key and the guard every
// data api has (http.endpoint) - no key / a wrong / an old key = 401 never cached; SITE_ACCESS=open = public again.
const test = require('node:test');
const assert = require('node:assert/strict');
const mock = require('./fixtures/apps-script-mock');
const A = require('../api/_lib/access');
const access = require('../api/access');
const financials = require('../api/financials');
const site = require('../api/site');
const push = require('../api/push');
const watchlists = require('../api/watchlists');
const marketStatus = require('../api/market-status');
const cacheLib = require('../api/_lib/cache');

globalThis.fetch = function () { return Promise.reject(new TypeError('network disabled in tests')); };

const FEED = 'feed_SECRET_token_123456';
const URL_ = 'https://script.google.com/macros/s/AKfy_SECRET_ACCESS/exec';
const ENV = { SHEET_FEED_URL: URL_, SHEET_FEED_TOKEN: FEED };
const DEV = (n) => 'dev' + String(n).padStart(2, '0') + 'ABCDEFGHIJKLMNOPQ';
const T0 = Date.UTC(2026, 10, 28, 5, 0);

const fakeRes = function () {
  const r = { headers: {}, statusCode: 200, body: undefined };
  r.setHeader = (k, v) => { r.headers[String(k).toLowerCase()] = v; };
  r.status = (code) => { r.statusCode = code; return r; };
  r.json = (obj) => { r.body = JSON.parse(JSON.stringify(obj)); };
  r.end = () => {};
  return r;
};
async function call(h, req) { const res = fakeRes(); await h(req, res); return res; }

/** A sheet (the real Code.gs) with one person; fetch goes to its doPost. */
function sheetWith(name) {
  const env = mock.loadCodeGs({ sheets: [{ name: 'Main', rows: [[], ['SYMBOL']] }] },
    { now: T0, props: { AB_FEED_TOKEN: FEED }, prompts: [name || 'Siva'] });
  env.call('runWebsiteAccessAdd');
  const rows = env.sheet('Website Access').rows;
  const code = String(rows[2][rows[1].indexOf('Access Code')]);
  const fetch = function (url, init) {
    assert.equal(String(url), URL_);
    const out = env.post(JSON.parse(init.body));
    return Promise.resolve(new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } }));
  };
  return { env, code, fetch };
}
const post = (h, body) => call(h, { method: 'POST', body: body });

test('the content key: 6-hour slots, this one and the one before; never another feed token\'s', () => {
  const k = A.issueKey(ENV, T0);
  assert.match(k.k, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(A.keyOk(ENV, k.k, T0), true);
  assert.equal(A.keyOk(ENV, k.k, T0 + A.SLOT_MS), true, 'the next slot still takes it');
  assert.equal(A.keyOk(ENV, k.k, T0 + 2 * A.SLOT_MS), false, 'two slots later: renew');
  assert.equal(A.keyOk({ SHEET_FEED_TOKEN: 'another' }, k.k, T0), false);
  assert.equal(A.keyOk(ENV, '', T0), false);
  assert.equal(A.keyOk(ENV, ['x'], T0), false);
  assert.equal(k.until, (A.slotOf(T0) + 2) * A.SLOT_MS);
  assert.equal(A.enabled(ENV), true);
  assert.equal(A.enabled({}), false, 'no feed token: nothing to protect with');
  assert.equal(A.enabled(Object.assign({ SITE_ACCESS: 'open' }, ENV)), false, 'the owner\'s switch');
  const t = A.sign(ENV, { p: '0123456789abcdef', d: DEV(1), n: 'Siva', i: T0 });
  assert.deepEqual(A.verify(ENV, t), { p: '0123456789abcdef', d: DEV(1), n: 'Siva', i: T0 });
  assert.equal(A.verify({ SHEET_FEED_TOKEN: 'another' }, t), null);
  assert.equal(A.verify(ENV, t.replace(/\.(.)/, '.X')), null, 'changed = refused');
  assert.equal(A.verify(ENV, 'v1.abc'), null);
});

test('every data api wants the key: none / wrong = 401 never cached; with it the usual answer', async () => {
  const fetch = () => Promise.resolve(new Response(JSON.stringify({ ok: true, fin: null }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const h = financials.createHandler({ env: ENV, fetch, now: () => T0 });
  const no = await call(h, { method: 'GET', query: { sym: 'TCS' } });
  assert.equal(no.statusCode, 401);
  assert.equal(no.body.code, 'access');
  assert.equal(no.headers['cache-control'], 'no-store');
  assert.equal((await call(h, { method: 'GET', query: { sym: 'TCS', k: 'A'.repeat(22) } })).statusCode, 401);
  const k = A.issueKey(ENV, Date.now()).k;
  const ok = await call(h, { method: 'GET', query: { sym: 'TCS', k: k } });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.ok, true);
  // the same through the URL (plain Node request)
  const viaUrl = await call(h, { method: 'GET', url: '/api/financials?sym=TCS&k=' + encodeURIComponent(k) });
  assert.equal(viaUrl.statusCode, 200);
  // site / watchlists (POST) / push GET guarded; push POST (the sheet, signed) and market-status are not
  const s = site.createHandler({ env: ENV, fetch, now: () => T0, cache: cacheLib.createCache() });
  assert.equal((await call(s, { method: 'GET', query: { part: 'main' } })).statusCode, 401);
  const w = watchlists.createHandler({ env: ENV, fetch });
  assert.equal((await call(w, { method: 'POST', body: { op: 'get', pin: 'x' } })).statusCode, 401);
  assert.notEqual((await call(w, { method: 'POST', body: { op: 'get', pin: 'Blue2026' }, query: { k } })).statusCode, 401);
  const p = push.createHandler({ env: ENV, fetch });
  assert.equal((await call(p, { method: 'GET', query: {} })).statusCode, 401);
  assert.notEqual((await call(p, { method: 'POST', body: {} })).statusCode, 401, 'the sheet\'s signed post');
  assert.notEqual((await call(marketStatus.createHandler({ env: ENV }), { method: 'GET', query: {} })).statusCode, 401);
  // the preflight of the Firebase copy is answered before the guard
  assert.equal((await call(w, { method: 'OPTIONS' })).statusCode, 204);
  // SITE_ACCESS=open: the website is public again
  const open = financials.createHandler({ env: Object.assign({ SITE_ACCESS: 'open' }, ENV), fetch, now: () => T0 });
  assert.equal((await call(open, { method: 'GET', query: { sym: 'TCS' } })).statusCode, 200);
});

test('api/access through the real sheet: login -> token + key; renew; untick Active / reset / logout close it', async () => {
  const { env, code, fetch } = sheetWith('Siva');
  const h = access.createHandler({ env: ENV, fetch, now: () => T0 });
  const bad = await post(h, { op: 'login', code: 'NOPE1234', dev: DEV(1) });
  assert.deepEqual(bad.body, { ok: false, code: 'wrong', message: access.WORDS.wrong });
  assert.equal((await post(h, { op: 'login', code: 'x', dev: DEV(1) })).body.code, 'wrong', 'never asked the sheet');
  assert.equal((await post(h, { op: 'login', code, dev: 'short' })).statusCode, 400);
  assert.equal((await post(h, { op: 'nope' })).statusCode, 400);
  const a = await post(h, { op: 'login', code: code.toLowerCase(), dev: DEV(1), label: 'Android phone' });
  assert.equal(a.body.ok, true, JSON.stringify(a.body));
  assert.equal(a.body.name, 'Siva');
  assert.equal(a.body.used, 1);
  assert.equal(a.body.max, 3);
  assert.equal(A.keyOk(ENV, a.body.k, T0), true);
  assert.equal(a.headers['cache-control'], 'no-store');
  const text = JSON.stringify(a.body);
  [FEED, URL_, 'AKfy', code].forEach((x) => assert.ok(text.indexOf(x) < 0, 'nothing secret in the answer: ' + x));
  const s = A.verify(ENV, a.body.token);
  assert.equal(s.d, DEV(1));
  // renew: a new token + key
  const r = await post(h, { op: 'renew', token: a.body.token });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.name, 'Siva');
  assert.equal((await post(h, { op: 'renew', token: 'v1.forged.' + 'x'.repeat(43) })).body.code, 'token');
  // 3 devices, the 4th refused
  await post(h, { op: 'login', code, dev: DEV(2) });
  await post(h, { op: 'login', code, dev: DEV(3) });
  assert.equal((await post(h, { op: 'login', code, dev: DEV(4) })).body.code, 'devices');
  // the owner unticks Active: the next renew closes it
  const rows = env.sheet('Website Access').rows, head = rows[1];
  rows[2][head.indexOf('Active')] = false;
  assert.deepEqual((await post(h, { op: 'renew', token: a.body.token })).body, { ok: false, code: 'off', message: access.WORDS.off });
  rows[2][head.indexOf('Active')] = true;
  rows[2][head.indexOf('Reset Devices')] = true;
  assert.equal((await post(h, { op: 'renew', token: a.body.token })).body.code, 'reset');
  const again = await post(h, { op: 'login', code, dev: DEV(1) });
  assert.equal(again.body.used, 1);
  assert.deepEqual((await post(h, { op: 'logout', token: again.body.token })).body, { ok: true });
  assert.equal((await post(h, { op: 'renew', token: again.body.token })).body.code, 'gone');
  // wrong codes lock the logins; the words carry the minutes
  for (let i = 0; i < 30; i++) await post(h, { op: 'login', code: 'WRONG' + String(i).padStart(3, '0'), dev: DEV(5) });
  const l = await post(h, { op: 'login', code, dev: DEV(5) });
  assert.equal(l.body.code, 'locked');
  assert.match(l.body.message, /try again in 30 minutes/);
});

test('api/access: the sheet down / an older web app / access off', async () => {
  const down = access.createHandler({ env: ENV, fetch: () => Promise.reject(new TypeError('fetch failed')), now: () => T0 });
  const a = await post(down, { op: 'login', code: 'ABCDEFGH', dev: DEV(1) });
  assert.deepEqual(a.body, { ok: false, code: 'later', message: access.WORDS.later, retry: true });
  const tok = A.sign(ENV, { p: '0123456789abcdef', d: DEV(1), n: 'Siva', i: T0 });
  assert.equal((await post(down, { op: 'renew', token: tok })).body.code, 'later', 'the device goes on with its key');
  const old = access.createHandler({ env: ENV, now: () => T0,
    fetch: () => Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'bad token' }), { status: 200, headers: { 'content-type': 'application/json' } })) });
  assert.deepEqual((await post(old, { op: 'login', code: 'ABCDEFGH', dev: DEV(1) })).body,
    { ok: false, code: 'old', message: access.WORDS.old, retry: true }, 'the web app before the update: bad token');
  const older = access.createHandler({ env: ENV, now: () => T0,
    fetch: () => Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'unknown action' }), { status: 200, headers: { 'content-type': 'application/json' } })) });
  assert.equal((await post(older, { op: 'login', code: 'ABCDEFGH', dev: DEV(1) })).body.code, 'old');
  assert.deepEqual((await post(down, { op: 'hello' })).body, { ok: true, open: false }, 'no sheet call');
  const open = access.createHandler({ env: Object.assign({ SITE_ACCESS: 'open' }, ENV), fetch: () => { throw new Error('no'); } });
  assert.deepEqual((await post(open, { op: 'hello' })).body, { ok: true, open: true });
  assert.deepEqual((await post(open, { op: 'login', code: 'ABCDEFGH', dev: DEV(1) })).body, { ok: true, open: true });
});
