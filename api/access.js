// POST /api/access   body { op: 'hello' } | { op: 'login', code, dev, label } | { op: 'renew', token } | { op: 'logout', token }
// The website only for the persons the owner added (owner, 28-Nov-2026: "I don't want this website public now. i want to
// give access to only authorized persons" - an access code per person, up to 3 devices each). The list lives in the
// owner's sheet (tab 'Website Access', Code2.gs ab_accessFromSite_, doPost action 'access' with the same feed token as
// api/site); this function signs the device's session and hands out the content key every data api wants (_lib/access.js).
//   op 'login'  -> the sheet checks the code + this device (a new device only while the person has fewer than Max Devices)
//                  -> { ok:true, token, k, ks, until, name, used, max }
//   op 'renew'  -> the sheet checks the person is still Active and this device still theirs (every ~10 minutes while the
//                  website is open) -> a new token + key; refused -> { ok:false, code: off | gone | reset }; the sheet not
//                  answering -> { ok:false, code:'later' } (the device goes on with its key while it is valid)
//   op 'logout' -> the device leaves the person's list (frees a place)
//   op 'hello'  -> { ok:true, open } (no sheet call: does the website want a code at all?)
//   access off (env SITE_ACCESS=open, or no feed token) -> { ok:true, open:true }
// -> 200 { ok:false, code, message } on a refusal (fixed words; never the sheet's text), 400 a bad request. Never cached.
(function () {
  'use strict';

  const http = require('./_lib/http');
  const cacheLib = require('./_lib/cache');
  const sheetFeed = require('./_lib/sheet-feed');
  const A = require('./_lib/access');

  const TIMEOUT_MS = 20000;
  const MAX_BODY = 4096;
  const CODE_RE = /^[A-Za-z0-9]{6,20}$/;
  const DEV_RE = /^[A-Za-z0-9_-]{16,64}$/;

  const WORDS = {
    wrong: 'This access code is not known - check it and type it again.',
    off: 'This access code is turned off - ask the owner of the website.',
    devices: 'This access code is already used on all its devices - ask the owner to free one (Reset Devices).',
    locked: 'Too many wrong codes - try again in a few minutes.',
    gone: 'This device was signed out (the code was changed or the device removed) - type your access code again.',
    reset: 'The owner reset the devices of this code - type your access code again.',
    busy: 'The sheet is busy - try again in a moment.',
    old: 'The website\'s sheet does not know access codes yet (its new code arrives with the laptop\'s next update) - try again later.',
    later: 'The sheet did not answer just now - try again in a minute.',
    token: 'This device\'s sign-in is not valid any more - type your access code again.'
  };

  function bad(message) {
    const err = new Error(message);
    /** @type {any} */ (err).status = 400;
    return err;
  }
  async function readBody(req) {
    let raw;
    try { raw = req ? req.body : undefined; } catch { throw bad('the body must be JSON'); }
    if (raw === undefined && req && typeof req.on === 'function') {
      raw = await new Promise(function (resolve, reject) {
        const dec = new TextDecoder();
        let text = '', size = 0;
        req.on('data', function (c) {
          size += c.length;
          if (size > MAX_BODY) { reject(bad('request too big')); return; }
          text += typeof c === 'string' ? c : dec.decode(c, { stream: true });
        });
        req.on('end', function () { resolve(text + dec.decode()); });
        req.on('error', reject);
      });
    }
    if (raw instanceof Uint8Array) raw = new TextDecoder().decode(raw);
    if (typeof raw === 'string') {
      if (raw.length > MAX_BODY) throw bad('request too big');
      try { raw = JSON.parse(raw || '{}'); } catch { throw bad('the body must be JSON'); }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('the body must be a JSON object');
    return raw;
  }

  function cleanLabel(v) {
    return String(v || '').replace(/[^A-Za-z0-9 ,.()/+-]/g, '').trim().slice(0, 40) || 'a device';
  }

  /** The sheet said no / did not answer -> { ok:false, code, message } (fixed words; `min` of a lock). */
  function refusal(r) {
    // an older web app has no action 'access': its doPost takes the feed token for a wrong bridge token ('bad token')
    let code = r.sheetCode && WORDS[r.sheetCode] ? r.sheetCode
      : r.code === 'unknown-action' || r.code === 'auth' ? 'old' : r.code === 'busy' ? 'busy' : 'later';
    if (r.sheetCode === 'bad') code = 'token';
    const out = { ok: false, code: code, message: WORDS[code] };
    if (code === 'locked' && r.sheetMin > 0) out.message = 'Too many wrong codes - try again in ' + Math.min(r.sheetMin, 999) + ' minutes.';
    if (code === 'later' || code === 'busy' || code === 'old') out.retry = true;
    return out;
  }

  /** deps (tests): { env, fetch, now, timeoutMs } */
  function createHandler(deps) {
    const d = deps || {};
    const getEnv = function () { return d.env || http.readEnv(); };
    const now = typeof d.now === 'function' ? d.now : function () { return Date.now(); };
    const timeoutMs = d.timeoutMs > 0 ? d.timeoutMs : TIMEOUT_MS;
    const noStore = cacheLib.noStore();
    return http.endpoint('access', getEnv, async function (req, res, env) {
      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        if (!(err && err.status)) throw err;
        http.sendJson(res, err.status, { error: err.message }, { env: env, cacheControl: noStore });
        return;
      }
      const op = String(body.op || '');
      if (['hello', 'login', 'renew', 'logout'].indexOf(op) < 0) {
        http.sendJson(res, 400, { error: 'op must be hello, login, renew or logout' }, { env: env, cacheControl: noStore });
        return;
      }
      if (op === 'hello') {                  // does this website want a code? (a device with no sign-in asks first)
        http.sendJson(res, 200, { ok: true, open: !A.enabled(env) }, { env: env, cacheControl: noStore });
        return;
      }
      if (!A.enabled(env)) {
        http.sendJson(res, 200, { ok: true, open: true }, { env: env, cacheControl: noStore });
        return;
      }
      if (!sheetFeed.configured(env)) {
        http.sendJson(res, 200, { ok: false, code: 'later', retry: true, message: sheetFeed.notConfiguredMessage(env, 'Website access not configured') },
          { env: env, cacheControl: noStore });
        return;
      }
      const t = now();
      const send = function (o) { http.sendJson(res, 200, o, { env: env, cacheControl: noStore }); };
      const granted = function (pid, dev, name, extra) {
        const key = A.issueKey(env, t);
        return Object.assign({ ok: true, token: A.sign(env, { p: pid, d: dev, n: name, i: t }), k: key.k, ks: key.ks,
          until: key.until, name: name }, extra || {});
      };
      const nameOf = function (v) { return String(v || '').replace(/[<>"'`\\]/g, '').trim().slice(0, 60) || 'you'; };

      if (op === 'login') {
        const code = String(body.code || '').trim(), dev = String(body.dev || '');
        if (!CODE_RE.test(code)) { send({ ok: false, code: 'wrong', message: WORDS.wrong }); return; }
        if (!DEV_RE.test(dev)) { http.sendJson(res, 400, { error: 'bad device id' }, { env: env, cacheControl: noStore }); return; }
        const r = await sheetFeed.postFeed(env, { fetch: d.fetch },
          { action: 'access', op: 'login', code: code, dev: dev, label: cleanLabel(body.label) }, timeoutMs);
        if (!r.ok) { send(refusal(r)); return; }
        const a = r.data;
        if (!/^[0-9a-f]{16}$/.test(String(a.pid))) { send({ ok: false, code: 'later', retry: true, message: WORDS.later }); return; }
        const num = function (v) { return Number.isInteger(v) && v >= 0 && v <= 99 ? v : null; };
        send(granted(a.pid, dev, nameOf(a.name), { used: num(a.used), max: num(a.max) }));
        return;
      }
      const s = A.verify(env, body.token);
      if (!s) { send({ ok: false, code: 'token', message: WORDS.token }); return; }
      const r = await sheetFeed.postFeed(env, { fetch: d.fetch }, { action: 'access', op: op, pid: s.p, dev: s.d }, timeoutMs);
      if (op === 'logout') { send({ ok: true }); return; }
      if (!r.ok) { send(refusal(r)); return; }
      send(granted(s.p, s.d, nameOf(r.data.name || s.n)));
    }, ['POST']);
  }

  module.exports = createHandler();
  module.exports.createHandler = createHandler;
  module.exports.WORDS = WORDS;
})();
