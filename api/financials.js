// GET /api/financials?sym=TCS
// One stock's 5-year results table (quarterly + yearly P&L like screener.in's), from the owner's Google Sheet: the laptop
// reads NSE's XBRL result filings (pcbridge/ScreenerBridge/xbrl_history.py, 18-Nov-2026) and posts each stock's table to
// the hidden tab Financials; Code.gs doPost action 'site' part 'fin' answers one stock (the same read-only token as the
// site feed). Asked by the website when a stock's window opens - public company figures, no personal data.
// -> 200 { ok:true, sym, fin: {b, q, y, files, at, note?, k?} | null, cols, fetchedAt }
//    200 { ok:false, sym, message }   (not configured / the sheet failed)
//    400 { error } for a bad symbol
(function () {
  'use strict';

  const http = require('./_lib/http');
  const cacheLib = require('./_lib/cache');
  const cal = require('./_lib/market-calendar');
  const sheetFeed = require('./_lib/sheet-feed');

  const TIMEOUT_MS = 20000;
  const TTL_S = 1800;                       // a table changes at most once a day (the laptop's posts)
  const SYM_RE = /^[A-Z0-9&_.-]{1,30}$/;
  const COLS = ['rev', 'exp', 'op', 'opm', 'oi', 'exc', 'int', 'dep', 'pbt', 'taxp', 'np', 'eps'];
  const memo = cacheLib.createCache({ maxEntries: 300 });

  function parseSym(raw) {
    if (typeof raw !== 'string') return null;
    const s = raw.trim().toUpperCase();
    return SYM_RE.test(s) ? s : null;
  }

  /** The sheet's table checked again (numbers / null only, known labels) - never passes anything else on. */
  function cleanFin(fin) {
    if (!fin || typeof fin !== 'object') return null;
    const rows = function (a) {
      return (Array.isArray(a) ? a : []).filter(function (r) {
        return Array.isArray(r) && /^[A-Z][a-z]{2} \d{4}$/.test(String(r[0]));
      }).slice(-40).map(function (r) {
        const out = [String(r[0])];
        for (let i = 1; i <= COLS.length; i++) out.push(typeof r[i] === 'number' && isFinite(r[i]) ? r[i] : null);
        const f = r[COLS.length + 1];
        out.push(f === 'c' || f === 'd' || f === 's' || f === 'q' || f === 'r' ? f : '');
        return out;
      });
    };
    const q = rows(fin.q), y = rows(fin.y);
    if (!q.length && !y.length) return null;
    const out = { b: fin.b === 'S' ? 'S' : 'C', q: q, y: y, files: typeof fin.files === 'number' ? fin.files : 0,
      at: /^\d{4}-\d{2}-\d{2}$/.test(String(fin.at || '')) ? fin.at : '' };
    const words = function (t) { return String(t || '').replace(/[^A-Za-z0-9 .,;:()'\/%-]/g, '').slice(0, 200).trim(); };
    const note = words(fin.note);
    if (note) out.note = note;
    if (fin.k === 'bank') out.k = 'bank';
    const bw = words(fin.bw);              // the words about the basis (a consolidated table that ended, 23-Nov-2026)
    if (bw) out.bw = bw;
    const o = fin.o && typeof fin.o === 'object' ? cleanFin(Object.assign({}, fin.o, { o: null })) : null;   // the other basis's table
    if (o && o.b !== out.b) {
      out.o = { b: o.b, q: o.q, y: o.y };
      if (o.note) out.o.note = o.note;
      if (o.k) out.o.k = o.k;
    }
    return out;
  }

  /** deps (tests): { env, fetch, now, cache, timeoutMs } */
  function createHandler(deps) {
    const d = deps || {};
    const getEnv = function () { return d.env || http.readEnv(); };
    const now = typeof d.now === 'function' ? d.now : function () { return Date.now(); };
    return http.endpoint('financials', getEnv, async function (req, res, env) {
      const sym = parseSym(http.getQuery(req).sym);
      if (!sym) {
        http.sendJson(res, 400, { error: 'sym must be an NSE symbol, e.g. /api/financials?sym=TCS' },
          { env: env, cacheControl: cacheLib.noStore() });
        return;
      }
      if (!sheetFeed.configured(env)) {
        http.sendJson(res, 200, { ok: false, sym: sym, message: sheetFeed.notConfiguredMessage(env, 'Live site feed not configured') },
          { env: env, cacheControl: cacheLib.unavailableCacheControl() });
        return;
      }
      const cache = d.cache || memo;
      let fin;
      try {
        fin = await cache.getOrLoad('fin:' + sym, TTL_S * 1000, async function () {
          const r = await sheetFeed.postFeed(env, { fetch: d.fetch }, { action: 'site', part: 'fin', sym: sym },
            d.timeoutMs > 0 ? d.timeoutMs : TIMEOUT_MS);
          if (!r.ok) throw new Error(r.reason || 'the sheet did not answer');
          return cleanFin(r.data && r.data.fin);
        }, { staleOnError: true });
      } catch (err) {
        http.sendJson(res, 200, { ok: false, sym: sym, message: String(err && err.message || 'the sheet did not answer').slice(0, 200) },
          { env: env, cacheControl: cacheLib.unavailableCacheControl() });
        return;
      }
      http.sendJson(res, 200, { ok: true, sym: sym, fin: fin || null, cols: COLS, fetchedAt: cal.istDateTimeStr(now()) },
        { env: env, cacheControl: 'public, max-age=0, s-maxage=' + TTL_S + ', stale-while-revalidate=' + (TTL_S * 2) });
    }, ['GET']);
  }

  module.exports = createHandler();
  module.exports.createHandler = createHandler;
  module.exports.cleanFin = cleanFin;
})();
