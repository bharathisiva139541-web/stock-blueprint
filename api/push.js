// /api/push - the app's phone pop-ups (owner, 09-Nov-2026: mitigated FVG zones + new results, like the emails).
//   GET  -> { ok, publicKey }   the key the app subscribes with (VAPID public key, derived from SHEET_FEED_TOKEN -
//                               api/_lib/webpush.js; nothing secret)
//   POST { ts, sig, body }      from the owner's sheet only (Code2.gs ab_pushSend_): body = JSON text of
//                               { subs: [push subscriptions], notes: [{ kind, title, body, url, tag }] } and
//                               sig = HMAC-SHA256(SHEET_FEED_TOKEN, ts + '.' + body) in hex, ts within 15 minutes - so the
//                               feed token itself never travels and nobody else can make the phones ring.
//        -> { ok, sent, failed, gone: [endpoints of phones the push service says are gone] } (the sheet forgets those)
// The phones' addresses come from the sheet with each request; nothing is stored here. Never cached.
(function () {
  'use strict';

  const crypto = require('crypto');
  const http = require('./_lib/http');
  const cacheLib = require('./_lib/cache');
  const W = require('./_lib/webpush');

  const MAX_BODY = 64 * 1024;
  const MAX_SUBS = 20;
  const MAX_NOTES = 5;
  const SKEW_MS = 15 * 60 * 1000;
  const SEND_TIMEOUT_MS = 8000;

  async function readJson(req) {
    let raw = req ? req.body : undefined;
    if (raw === undefined && req && typeof req.on === 'function') {
      raw = await new Promise(function (resolve, reject) {
        let text = '', size = 0;
        req.on('data', function (c) { size += c.length; if (size > MAX_BODY) reject(new Error('too big')); else text += c; });
        req.on('end', function () { resolve(text); });
        req.on('error', reject);
      });
    }
    if (raw instanceof Uint8Array) raw = new TextDecoder().decode(raw);
    if (typeof raw === 'string') {
      if (raw.length > MAX_BODY) throw new Error('too big');
      raw = JSON.parse(raw || '{}');
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
    return raw;
  }

  function sameHex(a, b) {
    const x = Buffer.from(String(a || ''), 'utf8'), y = Buffer.from(String(b || ''), 'utf8');
    return x.length === y.length && x.length === 64 && crypto.timingSafeEqual(x, y);
  }

  /** A note for the phone: short texts, a link inside the app only. */
  function cleanNote(n) {
    if (!n || typeof n !== 'object') return null;
    const s = (v, max) => String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u0009\u000b-\u001f]/g, ' ').slice(0, max);
    const title = s(n.title, 140).trim();
    if (!title) return null;
    const url = s(n.url, 200);
    return { kind: s(n.kind, 20), title: title, body: s(n.body, 600), url: /^#[A-Za-z0-9/_-]*$/.test(url) ? url : '#overview', tag: s(n.tag, 60) };
  }

  /** deps (tests): { env, fetch, now } */
  function createHandler(deps) {
    const d = deps || {};
    const getEnv = function () { return d.env || http.readEnv(); };
    const noStore = cacheLib.noStore();
    return http.endpoint('push', getEnv, async function (req, res, env) {
      const token = String(env.SHEET_FEED_TOKEN || '').trim();
      if (!token) {
        http.sendJson(res, 200, { ok: false, code: 'not-configured', message: 'set SHEET_FEED_TOKEN in Vercel first' }, { env: env, cacheControl: noStore });
        return;
      }
      const keys = W.vapidKeys(token);
      if (String(req.method || 'GET').toUpperCase() !== 'POST') {
        http.sendJson(res, 200, { ok: true, publicKey: keys.publicKey }, { env: env, cacheControl: noStore });
        return;
      }
      let q;
      try { q = await readJson(req); } catch {
        http.sendJson(res, 400, { ok: false, error: 'the body must be JSON' }, { env: env, cacheControl: noStore, cors: false });
        return;
      }
      const now = d.now ? d.now() : Date.now();
      const body = typeof q.body === 'string' ? q.body : '';
      const want = crypto.createHmac('sha256', token).update(String(q.ts) + '.' + body).digest('hex');
      if (!(Math.abs(now - Number(q.ts)) <= SKEW_MS) || !sameHex(q.sig, want)) {
        http.sendJson(res, 403, { ok: false, error: 'not signed by the sheet' }, { env: env, cacheControl: noStore, cors: false });
        return;
      }
      let msg;
      try { msg = JSON.parse(body); } catch { msg = null; }
      const subs = (msg && Array.isArray(msg.subs) ? msg.subs : []).filter(W.validSub).slice(0, MAX_SUBS);
      const notes = (msg && Array.isArray(msg.notes) ? msg.notes : []).map(cleanNote).filter(Boolean).slice(0, MAX_NOTES);
      const host = String((req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '').split(',')[0].trim();
      const subject = /^[a-z0-9.-]+(:\d+)?$/i.test(host) ? 'https://' + host : 'https://stock-blueprint.vercel.app';
      let sent = 0, failed = 0;
      const gone = [];
      await Promise.all(subs.map(async function (sub) {
        for (const n of notes) {
          const ctl = new AbortController();
          const timer = setTimeout(function () { ctl.abort(); }, SEND_TIMEOUT_MS);
          try {
            const r = await W.send(sub, n, keys, { fetch: d.fetch, subject: subject, signal: ctl.signal, now: now });
            if (r.status >= 200 && r.status < 300) sent++;
            else if ([401, 403, 404, 410].indexOf(r.status) >= 0) { if (gone.indexOf(sub.endpoint) < 0) gone.push(sub.endpoint); failed++; break; }
            else failed++;
          } catch {
            failed++;
          } finally {
            clearTimeout(timer);
          }
        }
      }));
      http.sendJson(res, 200, { ok: true, sent: sent, failed: failed, gone: gone }, { env: env, cacheControl: noStore, cors: false });
    }, ['GET', 'POST']);
  }

  module.exports = createHandler();
  module.exports.createHandler = createHandler;
})();
