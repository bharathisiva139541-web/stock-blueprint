// The app's phone pop-ups + the Backtest Lab / bell ops (owner, 09-Nov-2026):
//  - api/_lib/webpush.js: RFC 8291 encryption (the RFC's own example message, byte for byte), the VAPID key derived from
//    the feed token (same token = same key), the ES256 JWT verifies with that key;
//  - api/push.js: GET = the public key; POST only when signed by the sheet (HMAC of the feed token, 15 minutes), the
//    message decrypts on the "phone", phones the push service calls gone come back;
//  - api/watchlists.js ops 'lab' / 'notes' / 'push' (+ the Kite answer's notesNewest), checked before the sheet.
// No network: fetch is mocked.
(function () {
  'use strict';

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const crypto = require('crypto');
  const W = require('../api/_lib/webpush');
  const push = require('../api/push');
  const wl = require('../api/watchlists');

  globalThis.fetch = function () { return Promise.reject(new TypeError('network disabled in tests')); };
  const TOKEN = 'sheet_SECRET_987654';
  const ENV = { SHEET_FEED_URL: 'https://script.google.com/macros/s/AKfy_SECRET/exec', SHEET_FEED_TOKEN: TOKEN };
  const b64u = W.b64u, fromB64u = W.fromB64u;

  const fakeRes = function () {
    const r = { headers: {}, statusCode: 200, body: undefined };
    r.setHeader = (k, v) => { r.headers[String(k).toLowerCase()] = v; };
    r.status = (code) => { r.statusCode = code; return r; };
    r.json = (obj) => { r.body = JSON.parse(JSON.stringify(obj)); };
    r.end = () => {};
    return r;
  };
  const call = async (h, body, method, headers) => {
    const res = fakeRes();
    await h({ method: method || 'POST', body: body, headers: headers || { host: 'stock-blueprint.vercel.app' } }, res);
    return res;
  };

  /** A "phone": its keys, and how it opens a message (RFC 8291 / 8188, written here independently). */
  function phone(n) {
    const ua = crypto.createECDH('prime256v1');
    ua.generateKeys();
    const auth = crypto.randomBytes(16);
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/phone' + n, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) } };
    sub.open = function (buf) {
      const salt = buf.subarray(0, 16), idlen = buf[20], asPub = buf.subarray(21, 21 + idlen), ct = buf.subarray(21 + idlen);
      const prkKey = crypto.createHmac('sha256', auth).update(ua.computeSecret(asPub)).digest();
      const ikm = crypto.createHmac('sha256', prkKey).update(Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub, Buffer.from([1])])).digest();
      const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
      const cek = crypto.createHmac('sha256', prk).update(Buffer.from('Content-Encoding: aes128gcm\0\x01', 'latin1')).digest().subarray(0, 16);
      const nonce = crypto.createHmac('sha256', prk).update(Buffer.from('Content-Encoding: nonce\0\x01', 'latin1')).digest().subarray(0, 12);
      const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
      d.setAuthTag(ct.subarray(ct.length - 16));
      const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
      assert.equal(plain[plain.length - 1], 2, 'the last record');
      return JSON.parse(plain.subarray(0, plain.length - 1).toString());
    };
    return sub;
  }

  test('webpush: the RFC 8291 example, byte for byte; a derived VAPID key whose JWT verifies', () => {
    const sub = { endpoint: 'https://x', keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } };
    const out = W.encrypt('When I grow up, I want to be a watermelon', sub, { asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', salt: 'DGv6ra1nlYgDCS1FRnbzlw' });
    assert.equal(b64u(out), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
    const k1 = W.vapidKeys(TOKEN), k2 = W.vapidKeys(TOKEN), k3 = W.vapidKeys('another-token-123');
    assert.equal(k1.publicKey, k2.publicKey);
    assert.notEqual(k1.publicKey, k3.publicKey);
    assert.equal(fromB64u(k1.publicKey).length, 65);
    const auth = W.vapidAuth('https://fcm.googleapis.com/fcm/send/x', W.vapidKeys(TOKEN), 'https://site.example', Date.UTC(2026, 10, 9));
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(auth);
    assert.ok(m);
    assert.deepEqual(JSON.parse(fromB64u(m[2])), { aud: 'https://fcm.googleapis.com', exp: Date.UTC(2026, 10, 9) / 1000 + 43200, sub: 'https://site.example' });
    const pub = fromB64u(m[4]);
    const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: 'jwk' });
    assert.ok(crypto.verify('sha256', Buffer.from(m[1] + '.' + m[2]), { key: key, dsaEncoding: 'ieee-p1363' }, fromB64u(m[3])));
    assert.ok(auth.indexOf(TOKEN) < 0);
  });

  test('api/push: GET = the public key; POST only signed by the sheet; the phones get the message; gone phones come back', async () => {
    const p1 = phone(1), p2 = phone(2);
    const delivered = [];
    const fetch = async (url, init) => {
      if (url === p2.endpoint) return new Response('', { status: 410 });
      delivered.push({ url, init });
      return new Response('', { status: 201 });
    };
    const now = Date.UTC(2026, 10, 9, 10, 0);
    const h = push.createHandler({ env: ENV, fetch: fetch, now: () => now });
    const g = await call(h, undefined, 'GET');
    assert.deepEqual(g.body, { ok: true, publicKey: W.vapidKeys(TOKEN).publicKey });
    const notes = [{ kind: 'mitigated', title: '2 FVG zones mitigated: ABC, XYZ', body: 'Gap-up FVG mitigated: ABC', url: '#signals', tag: 'N1' },
                   { kind: 'results', title: 'Results: 1 new in Main', body: 'ABC: Rev YoY 12%', url: 'https://evil.example/x', tag: 'N2' }];
    const body = JSON.stringify({ subs: [p1, p2, { endpoint: 'http://insecure', keys: {} }], notes: notes });
    const ts = String(now - 60000);
    const sig = crypto.createHmac('sha256', TOKEN).update(ts + '.' + body).digest('hex');
    // unsigned / wrong / old
    assert.equal((await call(h, { ts, sig: 'f'.repeat(64), body })).statusCode, 403);
    assert.equal((await call(h, { ts: String(now - 3600000), sig: crypto.createHmac('sha256', TOKEN).update((now - 3600000) + '.' + body).digest('hex'), body })).statusCode, 403);
    assert.equal(delivered.length, 0);
    const r = await call(h, { ts, sig, body });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.body, { ok: true, sent: 2, failed: 1, gone: [p2.endpoint] });
    assert.equal(delivered.length, 2);
    const got = delivered.map((d) => p1.open(Buffer.from(d.init.body)));
    assert.deepEqual(got[0], notes[0]);
    assert.equal(got[1].url, '#overview', 'links stay inside the app');
    const hd = delivered[0].init.headers;
    assert.equal(hd['Content-Encoding'], 'aes128gcm');
    assert.match(hd.Authorization, /^vapid t=.+, k=/);
    assert.ok(JSON.stringify(delivered).indexOf(TOKEN) < 0, 'the token never goes to a push service');
    // no token configured
    const n = await call(push.createHandler({ env: {} }), undefined, 'GET');
    assert.equal(n.body.code, 'not-configured');
  });

  test('api/watchlists: lab / notes / push ops are checked here, forwarded with the PIN, the phones\' sender address added', async () => {
    const calls = [];
    const answer = { lab: { ok: true, result: 'lab', job: null, list: [] }, push: { ok: true, result: 'push', devices: 1 },
                     notes: { ok: true, result: 'notes', newest: '2026-11-09T15:30:00', devices: 1,
                              items: [{ id: 'N1', at: '2026-11-09T15:30:00', kind: 'mitigated', title: 'Gap-up FVG mitigated: ABC', body: 'x', url: 'javascript:alert(1)' }] },
                     kite: { ok: true, result: 'kite', fresh: true, at: '2026-11-09 15:29:00', ageSec: 5, items: [['ABC', 10, 1, 11, 9]], notesNewest: '2026-11-09T15:30:00' } };
    const fetch = async (url, init) => { const b = JSON.parse(init.body); calls.push(b); return new Response(JSON.stringify(answer[b.op]), { status: 200 }); };
    const h = wl.createHandler({ env: ENV, fetch: fetch });
    const p = phone(1);
    let r = await call(h, { op: 'lab', pin: 'Blue2026', lab: { do: 'run', name: 'My idea', params: { tf: 'D', stopBuf: 0.5, breakeven: true, x: { y: 1 }, 'bad key': 1,
      above10: true, emaSupport: 21, f: '=1+1' } } });
    assert.deepEqual(r.body, answer.lab);
    assert.deepEqual(calls[0].lab, { do: 'run', params: { tf: 'D', stopBuf: 0.5, breakeven: true, above10: true, emaSupport: 21 }, name: 'My idea' });
    r = await call(h, { op: 'push', pin: 'Blue2026', push: { do: 'add', sub: { endpoint: p.endpoint, keys: p.keys }, label: 'Android' } });
    assert.deepEqual(r.body, answer.push);
    assert.equal(calls[1].pushUrl, 'https://stock-blueprint.vercel.app/api/push');
    assert.deepEqual(calls[1].push.sub, { endpoint: p.endpoint, keys: p.keys });
    r = await call(h, { op: 'notes', pin: 'Blue2026' });
    assert.equal(r.body.items[0].url, '', 'only links inside the app');
    assert.equal(r.body.newest, '2026-11-09T15:30:00');
    r = await call(h, { op: 'kite', pin: 'Blue2026' });
    assert.equal(r.body.notesNewest, '2026-11-09T15:30:00');
    const n = calls.length;
    for (const bad of [{ op: 'lab', pin: 'x', lab: { do: 'drop' } }, { op: 'lab', pin: 'x', lab: { do: 'result', id: '../x' } },
                       { op: 'push', pin: 'x', push: { do: 'add', sub: { endpoint: 'http://x', keys: {} } } }, { op: 'push', pin: 'x', push: { do: 'nuke' } }]) {
      assert.equal((await call(h, bad)).statusCode, 400, JSON.stringify(bad));
    }
    assert.equal(calls.length, n, 'never reached the sheet');
  });
  test('api/watchlists op lab: the sheet\'s refusals reach the page in plain words (owner, 11-Nov-2026: "sheet feed error")', async () => {
    const SF = require('../api/_lib/sheet-feed');
    assert.deepEqual(SF.mapSheetError('a run is going on - wait for it (or cancel it)', { op: 'lab' }),
      { code: 'running', reason: 'a backtest is still running on your laptop - wait for it to finish, or press Cancel and run yours' });
    assert.deepEqual(SF.mapSheetError('that result is no longer kept', { op: 'lab' }).code, 'gone');
    assert.equal(SF.mapSheetError('something odd <script>', { op: 'lab' }).reason, 'sheet feed returned an error', 'other texts are never copied');
    const fetch = async () => new Response(JSON.stringify({ ok: false, error: 'a run is going on - wait for it (or cancel it)' }), { status: 200 });
    const r = await call(wl.createHandler({ env: ENV, fetch: fetch }), { op: 'lab', pin: 'Blue2026', lab: { do: 'run', params: { tf: 'D' } } });
    assert.equal(r.body.code, 'running');
    assert.match(r.body.message, /still running on your laptop/);
  });
})();
