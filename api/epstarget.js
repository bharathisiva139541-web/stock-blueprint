// GET /api/epstarget?q=Jun%202026[&lite=1]
// The EPS Growth Target Lab (owner, 23-Nov-2026): for every stock and quarter, the sheet's target (TTM EPS x EPS growth %),
// when the results came out, the entry (the close of the first session that could react) and what the price did after it.
// The laptop works it out (pcbridge/ScreenerBridge/eps_target.py) and posts one quarter at a time to the sheet (hidden tab
// EPS_Target, packed: base64 of the gzip of {cols, rows}); Code.gs doPost action 'site' part 'epst' answers the quarters'
// figures + one quarter's packed rows (the read-only feed token). Unpacked and checked here - public company figures and
// prices, no personal data.
// -> 200 { ok:true, quarters:[{q, end, fy, made, upto, sum}], q, cols, rows, fetchedAt }   (rows = [] when none yet)
//    200 { ok:false, message }   (not configured / the sheet failed)
//    400 { error } for a bad quarter
(function () {
  'use strict';

  const zlib = require('zlib');
  const http = require('./_lib/http');
  const cacheLib = require('./_lib/cache');
  const cal = require('./_lib/market-calendar');
  const sheetFeed = require('./_lib/sheet-feed');

  const TIMEOUT_MS = 25000;
  const TTL_S = 1800;                       // the laptop posts at most once a round (every few hours)
  const Q_RE = /^(Mar|Jun|Sep|Dec) \d{4}$/;
  const MAX_BLOB = 4000000;
  const MAX_ROWS = 6000;
  // kp / kd = the first session (+ its day) reaching 50 / 60 / 70 / 80 / 90 / 100 % of the way from the entry to the target
  // (owner, 24-Nov-2026); pg = the best progress, hh / dd = the highest high / lowest low vs the entry - per window 30 / 60 / 90 /
  // 120 / 180; nq = the sessions before the next quarter's results (null = not out yet), nqa 1 = no date found for them (SEBI's
  // last day taken), nx = when they came, wq = [pg, hh, dd, cl, ix] of that window
  const COLS = ['sym', 'st', 'why', 'b', 'fl', 'eps', 'ttm', 'prev', 'g', 'tgt', 'ann', 'src', 'ed', 'ep', 'pre', 'o0', 'n', 'kp',
    'kd', 'pg', 'hh', 'dd', 'cl', 'ix', 'nq', 'nqa', 'nx', 'wq', 'now', 'ph', 'pc'];
  const ANN_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
  const WHY = ['', 'loss', 'prevloss', 'fell', 'date', 'wait', 'price', 'nofiling'];
  const OLDER = 'your laptop has not sent the new EPS targets yet - run UpdateNow.bat, then EpsTargetNow.bat';
  const memo = cacheLib.createCache({ maxEntries: 40 });

  function parseQ(raw) {
    if (raw === undefined || raw === null || raw === '') return '';
    const s = String(raw).trim();
    return Q_RE.test(s) ? s : null;
  }
  const num = function (v) { return typeof v === 'number' && isFinite(v) ? v : null; };
  const nums = function (a, max) { return (Array.isArray(a) ? a : []).slice(0, max).map(num); };
  const day = function (v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : ''; };

  /** One packed row checked: known columns only, numbers / dates / short codes - nothing else passes on (`lite` = without the
   *  chart's path: the page's every-quarter view needs only the figures). */
  function cleanRow(r, lite) {
    if (!Array.isArray(r) || r.length !== COLS.length) return null;
    const o = {};
    COLS.forEach(function (k, i) { o[k] = r[i]; });
    const sym = String(o.sym || '');
    if (!/^[A-Z0-9&_.-]{1,30}$/.test(sym)) return null;
    const nq = num(o.nq);
    return [sym, o.st === 'ok' ? 'ok' : 'x', WHY.indexOf(o.why) >= 0 ? o.why : '', o.b === 'S' ? 'S' : o.b === 'C' ? 'C' : '',
      /^[-a-z]{8}$/.test(String(o.fl || '')) ? o.fl : '', nums(o.eps, 8), num(o.ttm), num(o.prev), num(o.g), num(o.tgt),
      ANN_RE.test(String(o.ann || '')) ? o.ann : '', o.src === 'nse' || o.src === 'xbrl' ? o.src : '',
      day(o.ed), num(o.ep), num(o.pre), num(o.o0), num(o.n), nums(o.kp, 6), (Array.isArray(o.kd) ? o.kd : []).slice(0, 6).map(day),
      nums(o.pg, 5), nums(o.hh, 5), nums(o.dd, 5), nums(o.cl, 5), nums(o.ix, 5), nq != null && nq >= 0 ? Math.round(nq) : null,
      o.nqa === 1 ? 1 : 0, ANN_RE.test(String(o.nx || '')) ? o.nx : '', nums(o.wq, 5), num(o.now), lite ? [] : nums(o.ph, 40),
      lite ? [] : nums(o.pc, 40)];
  }

  /** The sheet's blob -> clean rows (throws on a broken one). */
  function unpack(blob, lite) {
    if (!blob) return [];
    if (typeof blob !== 'string' || blob.length > MAX_BLOB || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) throw new Error('the stored data is not readable');
    const d = JSON.parse(zlib.gunzipSync(Buffer.from(blob, 'base64')).toString('utf8'));
    if (!d || !Array.isArray(d.cols) || !Array.isArray(d.rows)) throw new Error('the stored data is not readable');
    if (d.cols.join(',') !== COLS.join(',')) throw new Error(OLDER);
    return d.rows.slice(0, MAX_ROWS).map(function (r) { return cleanRow(r, lite); }).filter(Boolean);
  }

  function cleanSum(s) {
    s = s && typeof s === 'object' ? s : {};
    const int = function (v) { return typeof v === 'number' && isFinite(v) && v >= 0 ? Math.round(v) : 0; };
    const out = { stocks: int(s.stocks), ok: int(s.ok), target: int(s.target), down: int(s.down), medG: num(s.medG), medUp: num(s.medUp),
      medN: num(s.medN), ready: s.ready === true, why: {}, win: {}, dwin: {}, ann: {} };
    WHY.slice(1).forEach(function (k) { if (s.why && s.why[k]) out.why[k] = int(s.why[k]); });
    ['nse', 'xbrl'].forEach(function (k) { if (s.ann && s.ann[k]) out.ann[k] = int(s.ann[k]); });
    ['win', 'dwin'].forEach(function (g) {
      ['30', '60', '90', '120', '180', 'next'].forEach(function (k) {
        const w = s[g] && s[g][k];
        if (Array.isArray(w)) out[g][k] = w.slice(0, 14).map(int);
      });
    });
    return out;
  }
  function cleanQuarters(list) {
    return (Array.isArray(list) ? list : []).filter(function (x) { return x && Q_RE.test(String(x.q)); }).slice(0, 24).map(function (x) {
      return { q: String(x.q), end: day(x.end), fy: /^Q[1-4] FY\d{2}$/.test(String(x.fy || '')) ? x.fy : '',
        made: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(String(x.made || '')) ? x.made : '', upto: day(x.upto), sum: cleanSum(x.sum) };
    });
  }

  /** deps (tests): { env, fetch, now, cache, timeoutMs } */
  function createHandler(deps) {
    const d = deps || {};
    const getEnv = function () { return d.env || http.readEnv(); };
    const now = typeof d.now === 'function' ? d.now : function () { return Date.now(); };
    return http.endpoint('epstarget', getEnv, async function (req, res, env) {
      const query = http.getQuery(req);
      const q = parseQ(query.q);
      const lite = query.lite === '1';
      if (q === null) {
        http.sendJson(res, 400, { error: 'q must be a quarter like "Jun 2026"' }, { env: env, cacheControl: cacheLib.noStore() });
        return;
      }
      if (!sheetFeed.configured(env)) {
        http.sendJson(res, 200, { ok: false, message: sheetFeed.notConfiguredMessage(env, 'Live site feed not configured') },
          { env: env, cacheControl: cacheLib.unavailableCacheControl() });
        return;
      }
      const cache = d.cache || memo;
      let got;
      try {
        got = await cache.getOrLoad('epst:' + q + (lite ? ':lite' : ''), TTL_S * 1000, async function () {
          const body = { action: 'site', part: 'epst' };
          if (q) body.q = q;
          const r = await sheetFeed.postFeed(env, { fetch: d.fetch }, body, d.timeoutMs > 0 ? d.timeoutMs : TIMEOUT_MS);
          if (!r.ok) throw new Error(r.reason || 'the sheet did not answer');
          const data = r.data || {};
          return { quarters: cleanQuarters(data.quarters), q: Q_RE.test(String(data.q || '')) ? data.q : '', rows: unpack(data.blob, lite) };
        }, { staleOnError: true });
      } catch (err) {
        http.sendJson(res, 200, { ok: false, message: String(err && err.message || 'the sheet did not answer').slice(0, 200) },
          { env: env, cacheControl: cacheLib.unavailableCacheControl() });
        return;
      }
      http.sendJson(res, 200, { ok: true, quarters: got.quarters, q: got.q, cols: COLS, rows: got.rows, fetchedAt: cal.istDateTimeStr(now()) },
        { env: env, cacheControl: 'public, max-age=0, s-maxage=' + TTL_S + ', stale-while-revalidate=' + (TTL_S * 2) });
    }, ['GET']);
  }

  module.exports = createHandler();
  module.exports.createHandler = createHandler;
  module.exports.unpack = unpack;
  module.exports.COLS = COLS;
})();
