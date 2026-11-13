// POST /api/watchlists   body { op: 'get' | 'put' | 'kite' | 'lab' | 'notes' | 'push', pin, base?, state?, lab?, push? }   (JSON)
// The viewer's "My Watchlists" kept in the owner's Google Sheet (Code.gs doPost action
// 'watchlists', Code2.gs ab_wlFromSite_, hidden tab Site_Watchlists), so the phone, this
// site and the Firebase copy all show the same lists (web/ui/watchlist-sync.js).
// The PIN is checked BY THE SHEET (5 wrong in a row lock the lists for 15 min); this
// function only checks the request's shape and forwards it with the server-side feed
// token (env SHEET_FEED_URL + SHEET_FEED_TOKEN - no other setting needed). Never cached.
//   op 'get'                      -> the sheet's lists and revision
//   op 'put', base, state         -> saved when base = the sheet's revision, else result 'conflict'
//                                    with the sheet's lists (the browser merges and saves again)
//   op 'kite'                     -> the owner's Kite live prices (owner, 08-Nov-2026: only for the owner,
//                                    behind the same PIN): { ok, result:'kite', fresh, at, ageSec,
//                                    items:[[SYMBOL, price, change %, day high, day low]], indices: same rows for
//                                    the Indextracker indices (NIFTY_50 ...) } (both while fresh, or `closed`: today's
//                                    last prices after the close - until the next day)
//   op 'lab', lab:{do, params?, name?, id?}  -> the Backtest Lab (owner, 09-Nov-2026): run / status / result / delete / cancel
//                                    - the sheet keeps the job, the owner's laptop runs it (Code2.gs ab_labFromSite_)
//   op 'notes'                    -> the app's bell: { items:[{id, at, kind, title, body, url}], newest, devices }
//   op 'push', push:{do, sub?}    -> this phone's pop-ups: add / remove / test / list (the sheet keeps the phones; this
//                                    site's own /api/push sends - its address goes along as pushUrl)
//   (op 'kite' answers carry notesNewest = the newest note's time)
// -> 200 { ok:true, result:'ok'|'conflict', rev, savedAt, state:{ v:1, lists } }
//    200 { ok:false, code, message }   code: not-configured | pin | locked | nopin | auth |
//                                      busy | timeout | network | too-big | unreadable | error ...
//    400 { error } a bad request (never forwarded); 405 other methods; 413 body too big
// The PIN and the lists are never logged.
(function () {
  'use strict';

  const http = require('./_lib/http');
  const cacheLib = require('./_lib/cache');
  const sheetFeed = require('./_lib/sheet-feed');
  const M = require('../web/lib/watchlists.js');
  const W = require('./_lib/webpush');

  const TIMEOUT_MS = 25000;          // vercel.json maxDuration is 30 s
  const MAX_BODY = 600 * 1024;       // the sheet keeps at most 400,000 characters of lists
  const AUTH_HINT = ' (if the token is right, the web app still runs an older version without My Watchlists sync: ' +
    sheetFeed.NEW_VERSION + ')';

  function bad(message) {
    const err = new Error(message);
    /** @type {any} */ (err).status = 400;
    return err;
  }

  /** The JSON body: Vercel's parsed req.body (object or text), or read from the stream (plain Node). */
  function tooBig() {
    const e = bad('request too big');
    /** @type {any} */ (e).status = 413;
    return e;
  }
  async function readBody(req) {
    let raw;
    try { raw = req ? req.body : undefined; } catch { throw bad('the body must be JSON'); }   // Vercel parses on access
    if (raw === undefined && req && typeof req.on === 'function') {
      raw = await new Promise(function (resolve, reject) {
        const dec = new TextDecoder();
        let text = '', size = 0;
        req.on('data', function (c) {
          size += c.length;
          if (size > MAX_BODY) { reject(tooBig()); return; }
          text += typeof c === 'string' ? c : dec.decode(c, { stream: true });
        });
        req.on('end', function () { resolve(text + dec.decode()); });
        req.on('error', reject);
      });
    }
    if (raw instanceof Uint8Array) raw = new TextDecoder().decode(raw);
    if (typeof raw === 'string') {
      if (raw.length > MAX_BODY) throw tooBig();
      try { raw = JSON.parse(raw || '{}'); } catch { throw bad('the body must be JSON'); }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('the body must be a JSON object');
    return raw;
  }

  const LAB_DO = ['run', 'status', 'result', 'delete', 'cancel'];
  const PUSH_DO = ['add', 'remove', 'test', 'list'];

  /** The Backtest Lab's rules: a flat object of short strings / numbers / booleans (the sheet and the PC check them again). */
  function labParams(p) {
    const out = {};
    if (!p || typeof p !== 'object' || Array.isArray(p)) return out;
    Object.keys(p).slice(0, 200).forEach(function (k) {     // 200 (13-Nov-2026: ~120 rules now)
      const v = p[k];
      if (!/^[A-Za-z][A-Za-z0-9]{0,19}$/.test(k)) return;
      if ((typeof v === 'number' && isFinite(v)) || typeof v === 'boolean' || (typeof v === 'string' && /^[A-Za-z0-9_.-]{0,20}$/.test(v))) out[k] = v;
    });
    return out;
  }

  /** What goes to the sheet - only these fields, the lists cleaned with the website's rules. `host` = this site
   *  (the push sender's address for the phones: https://<host>/api/push). */
  function toSheet(body, host) {
    const op = body.op;
    if (['get', 'put', 'kite', 'lab', 'notes', 'push'].indexOf(op) < 0) throw bad('op must be "get", "put", "kite", "lab", "notes" or "push"');
    const pin = typeof body.pin === 'string' ? body.pin.trim() : '';
    if (!pin || pin.length > 64) throw bad('pin missing');
    const out = { action: 'watchlists', op: op, pin: pin };
    if (op === 'lab') {
      const q = body.lab || {};
      if (LAB_DO.indexOf(q.do) < 0) throw bad('lab.do must be one of ' + LAB_DO.join(', '));
      out.lab = { do: q.do };
      if (q.do === 'run') { out.lab.params = labParams(q.params); out.lab.name = String(q.name || '').slice(0, 60); }
      if (q.do === 'result' || q.do === 'delete') {
        if (typeof q.id !== 'string' || !/^L[a-z0-9]{4,20}$/.test(q.id)) throw bad('lab.id missing');
        out.lab.id = q.id;
      }
    }
    if (op === 'push') {
      const q = body.push || {};
      if (PUSH_DO.indexOf(q.do) < 0) throw bad('push.do must be one of ' + PUSH_DO.join(', '));
      out.push = { do: q.do };
      if (q.do === 'add') {
        if (!W.validSub(q.sub)) throw bad('push.sub is not a push subscription');
        out.push.sub = { endpoint: q.sub.endpoint, keys: { p256dh: q.sub.keys.p256dh, auth: q.sub.keys.auth } };
        out.push.label = String(q.label || '').slice(0, 60);
      }
      if (q.do === 'remove') {
        if (typeof q.endpoint !== 'string' || !/^https:\/\//.test(q.endpoint) || q.endpoint.length > 1000) throw bad('push.endpoint missing');
        out.push.endpoint = q.endpoint;
      }
      if (/^[a-z0-9.-]+(:\d{2,5})?$/i.test(String(host || ''))) out.pushUrl = 'https://' + host + '/api/push';
    }
    if (op === 'put') {
      if (!(Number.isInteger(body.base) && body.base >= 0)) throw bad('base must be the revision last read (0 or more)');
      if (!body.state || typeof body.state !== 'object' || !Array.isArray(body.state.lists)) throw bad('state.lists missing');
      out.base = body.base;
      out.state = M.strip(body.state);
    }
    return out;
  }

  /** The sheet's Kite prices, checked: only [SYMBOL, price > 0, change % | null, day high | null, day low | null] rows (max 5000). */
  function kiteReply(a) {
    if (!a || a.result !== 'kite' || !Array.isArray(a.items)) return { ok: false, code: 'malformed', message: 'the sheet answered in an unexpected way' };
    const items = [];
    const pos = function (v) { const n = Number(v); return v !== null && v !== '' && n > 0 && isFinite(n) ? n : null; };
    a.items.slice(0, 5000).forEach(function (it) {
      if (!Array.isArray(it) || typeof it[0] !== 'string' || !/^[A-Z0-9&_.-]{1,30}$/.test(it[0])) return;
      const p = Number(it[1]), c = it[2] === null || it[2] === undefined || it[2] === '' ? null : Number(it[2]);
      if (!(p > 0) || !isFinite(p) || (c !== null && !isFinite(c))) return;
      items.push([it[0], p, c, pos(it[3]), pos(it[4])]);
    });
    // the Indextracker indices (NIFTY_50 ...): the same row shape, max 120
    const indices = [];
    (Array.isArray(a.indices) ? a.indices : []).slice(0, 120).forEach(function (it) {
      if (!Array.isArray(it) || typeof it[0] !== 'string' || !/^[A-Z0-9_&]{2,40}$/.test(it[0])) return;
      const p = pos(it[1]), c = it[2] === null || it[2] === undefined || it[2] === '' ? null : Number(it[2]);
      if (p === null || (c !== null && !isFinite(c))) return;
      indices.push([it[0], p, c, pos(it[3]), pos(it[4])]);
    });
    // fresh = sent in the last 3 minutes; closed = today's last prices after the close (kept until the next day)
    const use = (a.fresh === true || a.closed === true) && items.length > 0;
    return { ok: true, result: 'kite', fresh: a.fresh === true && items.length > 0, closed: a.fresh !== true && a.closed === true && items.length > 0,
             at: typeof a.at === 'string' ? a.at.slice(0, 19) : '', ageSec: Number.isFinite(a.ageSec) ? a.ageSec : null,
             items: use ? items : [], indices: use ? indices : [] };
  }

  /** The notes for the bell: short texts, links inside the app only. */
  function notesReply(a) {
    if (!a || a.result !== 'notes' || !Array.isArray(a.items)) return { ok: false, code: 'malformed', message: 'the sheet answered in an unexpected way' };
    const s = (v, max) => String(v === undefined || v === null ? '' : v).slice(0, max);
    const items = a.items.slice(0, 200).map(function (n) {
      const url = s(n && n.url, 200);
      return { id: s(n && n.id, 40), at: s(n && n.at, 25), kind: s(n && n.kind, 20), title: s(n && n.title, 140), body: s(n && n.body, 600),
               url: /^#[A-Za-z0-9/_-]*$/.test(url) ? url : '' };
    }).filter(function (n) { return n.id && n.title; });
    return { ok: true, result: 'notes', newest: s(a.newest, 25), items: items, devices: Number.isInteger(a.devices) ? a.devices : 0 };
  }

  /** deps (tests): { env, fetch, timeoutMs } */
  function createHandler(deps) {
    const d = deps || {};
    const getEnv = function () { return d.env || http.readEnv(); };
    const timeoutMs = d.timeoutMs > 0 ? d.timeoutMs : TIMEOUT_MS;
    const noStore = cacheLib.noStore();
    return http.endpoint('watchlists', getEnv, async function (req, res, env) {
      let ask;
      try {
        const host = String((req && req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '').split(',')[0].trim();
        ask = toSheet(await readBody(req), host);
      } catch (err) {
        if (!(err && err.status)) throw err;
        http.sendJson(res, err.status, { error: err.message }, { env: env, cacheControl: noStore });
        return;
      }
      if (!sheetFeed.configured(env)) {
        http.sendJson(res, 200, { ok: false, code: 'not-configured',
          message: sheetFeed.notConfiguredMessage(env, 'Watchlist sync not configured') }, { env: env, cacheControl: noStore });
        return;
      }
      const r = await sheetFeed.postFeed(env, { fetch: d.fetch }, ask, timeoutMs);
      if (!r.ok) {
        http.sendJson(res, 200, { ok: false, code: r.code, message: r.code === 'auth' ? r.reason + AUTH_HINT : r.reason },
          { env: env, cacheControl: noStore });
        return;
      }
      const a = r.data;
      if (ask.op === 'kite') {
        const k = kiteReply(a);
        if (k.ok && typeof a.notesNewest === 'string') k.notesNewest = a.notesNewest.slice(0, 25);   // the bell looks when this changes
        http.sendJson(res, 200, k, { env: env, cacheControl: noStore });
        return;
      }
      if (ask.op === 'notes') {
        http.sendJson(res, 200, notesReply(a), { env: env, cacheControl: noStore });
        return;
      }
      if (ask.op === 'lab' || ask.op === 'push') {
        // the Backtest Lab's runs / the phones (owner only, behind the PIN): the sheet's own answer
        const ok = a && a.result === ask.op;
        http.sendJson(res, 200, ok ? a : { ok: false, code: 'malformed', message: 'the sheet answered in an unexpected way' },
          { env: env, cacheControl: noStore });
        return;
      }
      if ((a.result !== 'ok' && a.result !== 'conflict') || !Number.isInteger(a.rev) || a.rev < 0 ||
          !a.state || !Array.isArray(a.state.lists)) {
        http.sendJson(res, 200, { ok: false, code: 'malformed', message: 'the sheet answered in an unexpected way' },
          { env: env, cacheControl: noStore });
        return;
      }
      http.sendJson(res, 200, {
        ok: true, result: a.result, rev: a.rev, savedAt: typeof a.savedAt === 'string' ? a.savedAt.slice(0, 30) : '',
        state: M.strip(a.state)
      }, { env: env, cacheControl: noStore });
    }, ['POST']);
  }

  module.exports = createHandler();
  module.exports.createHandler = createHandler;
})();
