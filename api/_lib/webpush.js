// Web Push for the app's phone notifications (owner, 09-Nov-2026: "mitigated notifications and results update notification
// I am receiving through mail can be viewed in Notification icon in the app?" - choice: the bell + phone pop-ups).
// No library: Node's crypto does it all.
//  - VAPID (RFC 8292): the key pair is DERIVED from the server-side feed token (env SHEET_FEED_TOKEN), so no new Vercel
//    setting is needed and the private key never exists anywhere else; a new feed token = a new key (the app subscribes
//    again by itself - web/ui/notify.js compares the key).
//  - the message is encrypted for the phone (RFC 8291, "aes128gcm" content coding, RFC 8188).
(function () {
  'use strict';

  const crypto = require('crypto');

  const N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');   // the P-256 group order
  const RS = 4096;                     // record size; a payload must stay under RS - 17 bytes
  const MAX_PAYLOAD = 3000;

  const b64u = (buf) => Buffer.from(buf).toString('base64url');
  const fromB64u = (s) => Buffer.from(String(s || ''), 'base64url');
  const hkdf = (ikm, salt, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

  const memo = new Map();
  /** The VAPID key pair of this feed token: { publicKey (base64url, 65 bytes), privateKey (KeyObject) }. */
  function vapidKeys(token) {
    const t = String(token || '');
    if (!t) throw new Error('no feed token');
    if (memo.has(t)) return memo.get(t);
    let d = null;
    for (let k = 0; k < 100 && !d; k++) {
      const c = hkdf(Buffer.from(t, 'utf8'), Buffer.from('stock-blueprint/vapid/v1'), Buffer.from('key-' + k), 32);
      const v = BigInt('0x' + c.toString('hex'));
      if (v > 0n && v < N) d = c;
    }
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(d);
    const pub = ecdh.getPublicKey();
    const privateKey = crypto.createPrivateKey({
      key: { kty: 'EC', crv: 'P-256', d: b64u(d), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk'
    });
    const out = { publicKey: b64u(pub), privateKey: privateKey };
    memo.clear();
    memo.set(t, out);
    return out;
  }

  /** The Authorization header for one push service (aud = its origin). */
  function vapidAuth(endpoint, keys, subject, nowMs) {
    const aud = new URL(endpoint).origin;
    const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const claims = b64u(JSON.stringify({ aud: aud, exp: Math.floor((nowMs || Date.now()) / 1000) + 12 * 3600, sub: subject }));
    const sig = crypto.sign('sha256', Buffer.from(head + '.' + claims), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
    return 'vapid t=' + head + '.' + claims + '.' + b64u(sig) + ', k=' + keys.publicKey;
  }

  /** RFC 8291: the payload encrypted for the subscription {keys: {p256dh, auth}}. opts {asPrivate, salt} = tests only. */
  function encrypt(payload, sub, opts) {
    const o = opts || {};
    const uaPublic = fromB64u(sub.keys.p256dh);
    const auth = fromB64u(sub.keys.auth);
    if (uaPublic.length !== 65 || uaPublic[0] !== 4 || auth.length < 16) throw new Error('bad subscription keys');
    const as = crypto.createECDH('prime256v1');
    if (o.asPrivate) as.setPrivateKey(fromB64u(o.asPrivate)); else as.generateKeys();
    const asPublic = as.getPublicKey();
    const shared = as.computeSecret(uaPublic);
    const ikm = hkdf(shared, auth, Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]), 32);
    const salt = o.salt ? fromB64u(o.salt) : crypto.randomBytes(16);
    const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16);
    const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12);
    const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])]);
    const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
    const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    const head = Buffer.alloc(21);
    salt.copy(head, 0);
    head.writeUInt32BE(RS, 16);
    head[20] = asPublic.length;
    return Buffer.concat([head, asPublic, body]);
  }

  /** Sends one notification. -> { status } (201 = delivered to the push service; 404 / 410 = the phone is gone). */
  async function send(sub, payloadObj, keys, opts) {
    const o = opts || {};
    const text = JSON.stringify(payloadObj);
    if (Buffer.byteLength(text) > MAX_PAYLOAD) throw new Error('payload too big');
    const fetchImpl = o.fetch || fetch;
    const r = await fetchImpl(sub.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm', TTL: String(o.ttl || 86400),
        Urgency: 'high', Authorization: vapidAuth(sub.endpoint, keys, o.subject || 'https://stock-blueprint.vercel.app', o.now)
      },
      body: encrypt(text, sub),
      signal: o.signal
    });
    return { status: r.status };
  }

  /** A subscription as the browser gives it - checked (an https endpoint, the two keys). */
  function validSub(s) {
    return !!(s && typeof s.endpoint === 'string' && /^https:\/\/[^\s]{8,1000}$/.test(s.endpoint) && s.keys &&
      typeof s.keys.p256dh === 'string' && /^[A-Za-z0-9_-]{80,100}={0,2}$/.test(s.keys.p256dh) &&
      typeof s.keys.auth === 'string' && /^[A-Za-z0-9_-]{16,40}={0,2}$/.test(s.keys.auth));
  }

  module.exports = { vapidKeys, vapidAuth, encrypt, send, validSub, b64u, fromB64u, MAX_PAYLOAD };
})();
