// Who may use the website (owner, 28-Nov-2026: "I don't want this website public now. i want to give access to only
// authorized persons" - an access code per person, 3 devices each; the list lives in the sheet's tab 'Website Access',
// Code2.gs ab_accessFromSite_).
//  - a SESSION TOKEN (api/access login) = {p: the person's id, d: this device's id, n: name, i: issued} signed with a
//    key DERIVED from the server-side feed token (env SHEET_FEED_TOKEN) - no new Vercel setting; checked by api/access
//    renew, which asks the sheet every few minutes (an untick / reset / new code ends it);
//  - a CONTENT KEY `k` that every data api wants in its URL (?k=...): HMAC of the 6-hour slot, the current and the
//    previous slot accepted. It sits in the URL because the CDN caches by URL - a cached answer can only be reached with
//    the key, which only a signed-in device gets (from api/access, after the sheet said yes).
//  - env SITE_ACCESS=open turns all of this off (the website public again) - the owner's emergency switch.
(function () {
  'use strict';

  const crypto = require('crypto');

  const SLOT_MS = 6 * 3600 * 1000;
  const memo = new Map();

  function secret(env) {
    const t = String((env && env.SHEET_FEED_TOKEN) || '').trim();
    if (!t) return null;
    if (!memo.has(t)) {
      memo.clear();
      memo.set(t, crypto.createHmac('sha256', t).update('stock-blueprint/site-access/v1').digest());
    }
    return memo.get(t);
  }

  /** True when the website wants an access code (a feed token is set and SITE_ACCESS is not 'open'). */
  function enabled(env) {
    return !!secret(env) && !/^(open|off|public)$/i.test(String((env && env.SITE_ACCESS) || '').trim());
  }

  const b64u = (buf) => Buffer.from(buf).toString('base64url');
  const mac = (key, text) => crypto.createHmac('sha256', key).update(text).digest();

  function same(a, b) {
    const x = Buffer.from(String(a || ''), 'utf8'), y = Buffer.from(String(b || ''), 'utf8');
    return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
  }

  function slotOf(ms) { return Math.floor(ms / SLOT_MS); }
  function keyFor(env, slot) {
    const s = secret(env);
    return s ? b64u(mac(s, 'k:' + slot)).slice(0, 22) : '';
  }
  /** The content key of now: { k, ks (its slot), until (ms - after this the device must renew) }. */
  function issueKey(env, now) {
    const sl = slotOf(now);
    return { k: keyFor(env, sl), ks: sl, until: (sl + 2) * SLOT_MS };
  }
  /** `k` is the key of this slot or the one before. */
  function keyOk(env, k, now) {
    if (typeof k !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(k)) return false;
    const sl = slotOf(now);
    return same(k, keyFor(env, sl)) || same(k, keyFor(env, sl - 1));
  }

  /** A signed session token for {p, d, n, i}. */
  function sign(env, obj) {
    const body = b64u(Buffer.from(JSON.stringify(obj), 'utf8'));
    return 'v1.' + body + '.' + b64u(mac(secret(env), 't:' + body));
  }
  /** The token's {p, d, n, i} when it is ours and unchanged, else null. */
  function verify(env, token) {
    const m = /^v1\.([A-Za-z0-9_-]{8,700})\.([A-Za-z0-9_-]{43})$/.exec(String(token || ''));
    const s = secret(env);
    if (!m || !s || !same(m[2], b64u(mac(s, 't:' + m[1])))) return null;
    try {
      const o = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
      return o && typeof o === 'object' && /^[0-9a-f]{16}$/.test(String(o.p)) && /^[A-Za-z0-9_-]{16,64}$/.test(String(o.d)) ? o : null;
    } catch {
      return null;
    }
  }

  const DENIED = { ok: false, code: 'access', error: 'This website is private - open it and type your access code.' };

  module.exports = {
    SLOT_MS: SLOT_MS,
    DENIED: DENIED,
    enabled: enabled,
    slotOf: slotOf,
    keyFor: keyFor,
    issueKey: issueKey,
    keyOk: keyOk,
    sign: sign,
    verify: verify
  };
})();
