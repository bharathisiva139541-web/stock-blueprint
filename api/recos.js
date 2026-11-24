// GET /api/recos
// The Analyst Targets (owner, 24-Nov-2026, JLHL: Prabhudas Lilladher's Buy with a target of Rs 330, reached on 24-Nov):
// every broker recommendation since 1-Oct-2026 the laptop found on Moneycontrol / Business Standard / DSIJ, matched to the
// Main stocks, and what the Kite daily candles did after it (pcbridge/ScreenerBridge/analyst_recos.py -> the sheet's hidden
// tab Analyst_Recos -> Code.gs doPost action 'site' part 'recos', the read-only feed token). Unpacked and checked here -
// public company names, broker names, targets and prices; nothing personal.
// -> 200 { ok:true, made, upto, sum, cols, rows, fetchedAt }   (rows = [] when none yet)
//    200 { ok:false, message }   (not configured / the sheet failed)
(function () {
  'use strict';

  const zlib = require('zlib');
  const http = require('./_lib/http');
  const cacheLib = require('./_lib/cache');
  const cal = require('./_lib/market-calendar');
  const sheetFeed = require('./_lib/sheet-feed');

  const TIMEOUT_MS = 25000;
  const TTL_S = 1800;
  const MAX_BLOB = 4000000;
  const MAX_ROWS = 20000;
  // = analyst_recos.py COLS; kp / kd / pg / hh / dd / cl / ix / now = eps_target.after (50 .. 100 % of the way; windows 30 .. 180)
  // kn / kdn = the first session / day within 2 % of the target (owner, 24-Nov-2026: "it can be within 2% range"); a blob of
  // the laptop's first version (OLD_COLS) is still read - its kdn = null = not known (the page then works it out from kp)
  const COLS = ['sym', 'co', 'br', 'call', 'tgt', 'rp', 'at', 'src', 'url', 'seen', 'st', 'why', 'ed', 'ep', 'pre', 'o0', 'n', 'kp', 'kd',
    'pg', 'hh', 'dd', 'cl', 'ix', 'now', 'ph', 'pc', 'kn', 'kdn'];
  const OLD_COLS = COLS.slice(0, 27);
  const CALLS = ['BUY', 'ACCUMULATE', 'ADD', 'OUTPERFORM', 'HOLD', 'NEUTRAL', 'REDUCE', 'SELL'];
  const WHY = ['', 'nosym', 'price', 'wait', 'old'];
  const SRC = ['mc', 'bs', 'dsij'];
  const HOSTS = /^https:\/\/([a-z0-9-]+\.)*(moneycontrol\.com|business-standard\.com|dsij\.in)\/[A-Za-z0-9/_.~%+=&?#:,-]*$/;
  const memo = cacheLib.createCache({ maxEntries: 4 });

  const num = function (v) { return typeof v === 'number' && isFinite(v) ? v : null; };
  const nums = function (a, max) { return (Array.isArray(a) ? a : []).slice(0, max).map(num); };
  const day = function (v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : ''; };
  const words = function (v, max) {      // a company / broker name: letters, digits and a few signs only
    return String(v == null ? '' : v).replace(/[^A-Za-z0-9 &.,'()/-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  };

  function cleanRow(r) {
    if (!Array.isArray(r) || r.length !== COLS.length) return null;
    const o = {};
    COLS.forEach(function (k, i) { o[k] = r[i]; });
    const sym = String(o.sym || '');
    if (sym && !/^[A-Z0-9&_.-]{1,30}$/.test(sym)) return null;
    const co = words(o.co, 80), br = words(o.br, 40);
    if (!co || !br || CALLS.indexOf(o.call) < 0 || !(num(o.tgt) > 0)) return null;
    const at = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(String(o.at || '')) ? String(o.at) : '';
    if (!at) return null;
    const src = String(o.src || '').split(',').filter(function (s) { return SRC.indexOf(s) >= 0; }).join(',');
    const url = typeof o.url === 'string' && o.url.length <= 300 && HOSTS.test(o.url) ? o.url : '';
    return [sym, co, br, o.call, num(o.tgt), num(o.rp), at, src, url, day(o.seen), o.st === 'ok' ? 'ok' : 'x', WHY.indexOf(o.why) >= 0 ? o.why : '',
      day(o.ed), num(o.ep), num(o.pre), num(o.o0), num(o.n), nums(o.kp, 6), (Array.isArray(o.kd) ? o.kd : []).slice(0, 6).map(day),
      nums(o.pg, 5), nums(o.hh, 5), nums(o.dd, 5), nums(o.cl, 5), nums(o.ix, 5), num(o.now), [], [],      // no chart paths on this page
      Number.isInteger(o.kn) && o.kn > 0 ? o.kn : null, o.kdn === null ? null : day(o.kdn)];
  }

  function unpack(blob) {
    if (!blob) return [];
    if (typeof blob !== 'string' || blob.length > MAX_BLOB || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) throw new Error('the stored data is not readable');
    const d = JSON.parse(zlib.gunzipSync(Buffer.from(blob, 'base64')).toString('utf8'));
    if (!d || !Array.isArray(d.cols) || !Array.isArray(d.rows)) throw new Error('the stored data is not readable');
    const old = d.cols.join(',') === OLD_COLS.join(',');
    if (!old && d.cols.join(',') !== COLS.join(',')) throw new Error('your laptop has not sent the new analyst targets yet - run UpdateNow.bat, then AnalystNow.bat');
    return d.rows.slice(0, MAX_ROWS).map(function (r) { return old && Array.isArray(r) ? r.concat([null, null]) : r; }).map(cleanRow).filter(Boolean);
  }

  function cleanSum(s) {
    s = s && typeof s === 'object' ? s : {};
    const int = function (v) { return typeof v === 'number' && isFinite(v) && v >= 0 ? Math.round(v) : 0; };
    const out = { recos: int(s.recos), ok: int(s.ok), brokers: int(s.brokers), stocks: int(s.stocks), buy: int(s.buy), why: {}, src: {},
      from: day(s.from), to: day(s.to) };
    WHY.slice(1).forEach(function (k) { if (s.why && s.why[k]) out.why[k] = int(s.why[k]); });
    SRC.forEach(function (k) { if (s.src && s.src[k]) out.src[k] = int(s.src[k]); });
    return out;
  }

  /** deps (tests): { env, fetch, now, cache, timeoutMs } */
  function createHandler(deps) {
    const d = deps || {};
    const getEnv = function () { return d.env || http.readEnv(); };
    const now = typeof d.now === 'function' ? d.now : function () { return Date.now(); };
    return http.endpoint('recos', getEnv, async function (req, res, env) {
      if (!sheetFeed.configured(env)) {
        http.sendJson(res, 200, { ok: false, message: sheetFeed.notConfiguredMessage(env, 'Live site feed not configured') },
          { env: env, cacheControl: cacheLib.unavailableCacheControl() });
        return;
      }
      const cache = d.cache || memo;
      let got;
      try {
        got = await cache.getOrLoad('recos', TTL_S * 1000, async function () {
          const r = await sheetFeed.postFeed(env, { fetch: d.fetch }, { action: 'site', part: 'recos' }, d.timeoutMs > 0 ? d.timeoutMs : TIMEOUT_MS);
          if (!r.ok) throw new Error(r.reason || 'the sheet did not answer');
          const data = r.data || {};
          const iso = function (v) { return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(String(v || '')) ? String(v) : ''; };
          return { made: iso(data.made), upto: day(data.upto), sum: cleanSum(data.sum), rows: unpack(data.blob) };
        }, { staleOnError: true });
      } catch (err) {
        http.sendJson(res, 200, { ok: false, message: String(err && err.message || 'the sheet did not answer').slice(0, 200) },
          { env: env, cacheControl: cacheLib.unavailableCacheControl() });
        return;
      }
      http.sendJson(res, 200, { ok: true, made: got.made, upto: got.upto, sum: got.sum, cols: COLS, rows: got.rows, fetchedAt: cal.istDateTimeStr(now()) },
        { env: env, cacheControl: 'public, max-age=0, s-maxage=' + TTL_S + ', stale-while-revalidate=' + (TTL_S * 2) });
    }, ['GET']);
  }

  module.exports = createHandler();
  module.exports.createHandler = createHandler;
  module.exports.unpack = unpack;
  module.exports.COLS = COLS;
})();
