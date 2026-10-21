// GET /api/site?part=main|history
// The website's data read live from the owner's Google Sheet through its
// Apps Script web app (Code.gs doPost action 'site', read-only token):
//   part=main    -> the same object tools/export_xlsx.py writes as window.SB_DATA
//   part=history -> the same object it writes as window.SB_HISTORY
// Independent of MARKET_DATA_PROVIDER: needs only SHEET_FEED_URL + SHEET_FEED_TOKEN.
// -> 200 { ok:true, configured:true, part, readAt, fetchedAt, stale, staleReason?,
//          session:{state, lastCompletedSession}, priceState, data }
//    200 { ok:false, configured, part, message }   (not configured / sheet failed)
//    400 { error } for a bad part
// When a refresh fails, the last good copy of this warm instance is served
// with stale:true and priceState 'CACHED'. On ok:false the browser falls back
// to the static files in web/data/.
(function () {
  'use strict';

  const http = require('./_lib/http');
  const cacheLib = require('./_lib/cache');
  const cal = require('./_lib/market-calendar');
  const sheetFeed = require('./_lib/sheet-feed');
  const sheetProvider = require('./_lib/providers/sheet');

  const PARTS = ['main', 'history'];
  const TIMEOUT_MS = 25000;               // vercel.json maxDuration is 30 s
  const ERROR_MEMO_MS = 24 * 3600 * 1000; // how long the last failure reason is remembered

  // Same markers as the build's scan of web/data (tools/build.js): the public
  // site must never carry e-mails, the web-app URL / deployment id or trades.
  const PERSONAL_MARKERS = [
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/,
    /script\.google\.com\/macros/,
    /AKfyc[A-Za-z0-9_-]{20,}/,
    /"tradeStats"/,
    /"trades"\s*:/
  ];

  const AUTH_HINT = ' (if the token is right, the web app still runs an older version without the site feed: ' +
    sheetFeed.NEW_VERSION + ')';

  // Own small cache, so quote keys in the shared cache never push out the
  // last good copy that stale-on-error depends on.
  const siteCache = cacheLib.createCache({ maxEntries: 10 });

  /** 'main' | 'history' | null (a repeated or unknown part is rejected). */
  function parsePart(raw) {
    if (typeof raw !== 'string') return null;
    const p = raw.trim().toLowerCase();
    return PARTS.indexOf(p) >= 0 ? p : null;
  }

  /** An Error carrying one of our own fixed reasons (safe to show). */
  function failure(reason) {
    const err = new Error(reason);
    /** @type {any} */ (err).siteReason = reason;
    return err;
  }

  function reasonOf(err) {
    return err && err.siteReason ? String(err.siteReason) : 'sheet feed failed';
  }

  function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  /** Why `data` is not a usable part, or null when it is. */
  function shapeProblem(part, data) {
    if (part === 'main') {
      if (!isObject(data) || !isObject(data.main) || !Array.isArray(data.main.cols) || !Array.isArray(data.main.rows)) {
        return 'malformed site feed (main.cols/rows missing)';
      }
      if (!data.main.rows.length) return 'the sheet feed returned no Main rows (is the Main tab empty?)';
      return null;
    }
    if (!isObject(data) || !Array.isArray(data.dates) || !Array.isArray(data.cols) || !isObject(data.bars)) {
      return 'malformed site feed (dates/cols/bars missing)';
    }
    if (!Object.keys(data.bars).length) return 'the sheet feed returned no History30 bars';
    return null;
  }

  function hasPersonalMarker(data) {
    const text = JSON.stringify(data);
    return PERSONAL_MARKERS.some(function (re) { return re.test(text); });
  }

  /** IST 'YYYY-MM-DD HH:MM' string or null. */
  function validIst(s) {
    return typeof s === 'string' && cal.parseIstDateTime(s) !== null ? s.trim() : null;
  }

  /** One read of a part from the sheet. Throws failure(reason) on any problem. */
  async function loadPart(env, fetchImpl, part, timeoutMs, now) {
    const r = await sheetFeed.postFeed(env, { fetch: fetchImpl }, { action: 'site', part: part }, timeoutMs);
    if (!r.ok) throw failure(r.code === 'auth' ? r.reason + AUTH_HINT : r.reason);
    const body = r.data;
    if (body.part !== undefined && body.part !== part) throw failure('malformed site feed (wrong part)');
    const problem = shapeProblem(part, body.data);
    if (problem) throw failure(problem);
    if (hasPersonalMarker(body.data)) throw failure('blocked: the sheet feed contained personal-data markers');
    return { readAt: validIst(body.readAt), data: body.data, loadedMs: now() };
  }

  /** deps (tests): { env, fetch, now, cache, timeoutMs } */
  function createHandler(deps) {
    const d = deps || {};
    const getEnv = function () { return d.env || http.readEnv(); };
    const now = typeof d.now === 'function' ? d.now : function () { return Date.now(); };
    const timeoutMs = d.timeoutMs > 0 ? d.timeoutMs : TIMEOUT_MS;
    return http.endpoint('site', getEnv, async function (req, res, env) {
      const part = parsePart(http.getQuery(req).part);
      if (!part) {
        http.sendJson(res, 400, { error: 'part must be "main" or "history", e.g. /api/site?part=main' },
          { env: env, cacheControl: cacheLib.noStore() });
        return;
      }
      if (!sheetFeed.configured(env)) {
        http.sendJson(res, 200, {
          ok: false, configured: false, part: part,
          message: sheetFeed.notConfiguredMessage(env, 'Live site feed not configured')
        }, { env: env, cacheControl: cacheLib.unavailableCacheControl() });
        return;
      }

      const cache = d.cache || siteCache;
      const key = 'site:' + part;
      const errKey = key + ':error';
      const ttlMs = cacheLib.siteTtlSeconds(part) * 1000;
      let entry;
      try {
        entry = await cache.getOrLoad(key, ttlMs, async function () {
          try {
            const v = await loadPart(env, d.fetch, part, timeoutMs, now);
            cache.delete(errKey);
            return v;
          } catch (err) {
            if (!(err && err.siteReason)) http.logError('site', err, env);
            cache.set(errKey, reasonOf(err), ERROR_MEMO_MS);
            throw err;
          }
        }, { staleOnError: true });
      } catch (err) {
        http.sendJson(res, 200, { ok: false, configured: true, part: part, message: reasonOf(err) },
          { env: env, cacheControl: cacheLib.unavailableCacheControl() });
        return;
      }

      const nowMs = now();
      const held = cache.peek(key);
      const stale = !!(held && held.expired); // served the old copy after a failed refresh
      const readAtMs = entry.readAt ? cal.parseIstDateTime(entry.readAt) : null;
      const body = {
        ok: true,
        configured: true,
        part: part,
        readAt: entry.readAt,
        fetchedAt: cal.istDateTimeStr(nowMs),
        stale: stale
      };
      if (stale) body.staleReason = cache.get(errKey) || 'the sheet feed could not be refreshed';
      body.session = { state: cal.sessionState(nowMs), lastCompletedSession: cal.lastCompletedSession(nowMs) };
      body.priceState = stale ? 'CACHED' : sheetProvider.sheetPriceState(readAtMs, nowMs);
      body.data = entry.data;
      http.sendJson(res, 200, body, { env: env, cacheControl: cacheLib.siteCacheControl(part, stale) });
    });
  }

  module.exports = createHandler();
  module.exports.createHandler = createHandler;
  module.exports.PERSONAL_MARKERS = PERSONAL_MARKERS;
})();
