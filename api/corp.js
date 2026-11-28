// GET /api/corp[?days=N | ?from=yyyy-mm-dd&to=yyyy-mm-dd | ?older=day:yyyy-mm-dd | ?older=sym:SYMBOL]
// Corporate Intelligence (owner, 28-Nov-2026): NSE's corporate announcements of the Main stocks, sorted into 6 categories
// and scored by fixed rules on the laptop (pcbridge/ScreenerBridge/corp_ann.py - "No AI involvment here"), the last 30 days
// kept in the sheet's hidden tab Corp_Announcements (Code2.gs ab_corpForSite_, doPost action 'site' part 'corp', the
// read-only feed token). Older days and a company's every filing come from the laptop's archive while it is on ("laptop on la
// iruntha all announment um website kaatanum"): ?older=... -> the laptop's answer, or { pending:true } while the sheet waits
// for the laptop (the page asks again every few seconds). NSE's public filings only - unpacked and checked here.
// -> 200 { ok:true, days: [{day, n, made, sum}], cols, rows, laptop (seconds since it last looked, -1 never), fetchedAt }
//    200 { ok:true, older: {key, at, n, from}, cols, rows, laptop } | { ok:true, pending:true, key, laptop }
//    200 { ok:false, message }
(function () {
  'use strict';

  const zlib = require('zlib');
  const http = require('./_lib/http');
  const cacheLib = require('./_lib/cache');
  const cal = require('./_lib/market-calendar');
  const sheetFeed = require('./_lib/sheet-feed');

  const TIMEOUT_MS = 25000;
  const TTL_S = 300;
  const OLDER_TTL_S = 600;
  const MAX_BLOB = 4000000;
  const MAX_ROWS = 8000;
  // = corp_ann.py COLS / EVENTS / CATS
  const COLS = ['id', 'sym', 'co', 'at', 'cat', 'ev', 'ex', 'pr', 'bi', 'gr', 'su', 'risk', 'num', 'sub', 'tx', 'pdf', 'pg', 'why'];
  const CATS = ['A', 'B', 'C', 'D', 'E', 'F'];
  const EVENTS = ['order', 'capex', 'acq', 'merger', 'jv', 'approval', 'results', 'dividend', 'fund', 'buyback', 'bonus', 'split',
    'rating', 'allot', 'record', 'divest', 'kmp', 'director', 'auditor', 'meeting', 'sast', 'update', 'ops', 'sub', 'pledge', 'default',
    'legal', 'insolv', 'disrupt', 'call', 'present', 'clarify', 'press', 'paper', 'comp', 'other'];
  const PRI = ['high', 'med', 'low', 'routine'];
  const NUM_KEYS = ['val', 'mo', 'pct', 'pcty', 'mc', 'dps', 'dpct', 'px', 'stake', 'gr', 'units', 'pl'];
  const WORD_KEYS = {
    cur: /^(USD|EUR|GBP)$/, cap: /^[0-9.,]{1,12} [A-Za-z. ]{1,12}$/, rag: /^(CRISIL|ICRA|CARE|India Ratings|Brickwork|Acuite|Infomerics)$/,
    rrt: /^(AAA|AA[+-]?|A[+-]?|BBB[+-]?|BB[+-]?|B[+-]?|C[+-]?|D)$/, rfrom: /^(AAA|AA[+-]?|A[+-]?|BBB[+-]?|BB[+-]?|B[+-]?|C[+-]?|D)$/,
    ract: /^(up|down|same|new|watch-|outlook-|outlook\+|withdrawn)$/, dty: /^(special|interim|final)$/, rd: /^\d{4}-\d{2}-\d{2}$/,
    ins: /^(QIP|Preferential issue|Rights issue|NCDs|Commercial paper|Warrants|FCCBs|ECB|Term loan)$/, ratio: /^\d{1,3}:\d{1,3}$/,
    role: /^(Auditor|CEO|MD|CFO|Chairman|COO|Whole-time Director|Chief Officer|Company Secretary|Independent Director|Director|KMP)$/,
    act: /^(in|out|change|re|)$/, pact: /^(invoke|release|create)$/
  };
  const PDF_RE = /^https:\/\/(nsearchives|archives|www1?)\.nseindia\.com\/[A-Za-z0-9/_.~%+=&?#:,-]{1,400}$/;
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const KEY_RE = /^(day:\d{4}-\d{2}-\d{2}|sym:[A-Z0-9&_.-]{1,30})$/;
  const memo = cacheLib.createCache({ maxEntries: 40 });

  const int100 = function (v) { const n = Math.round(Number(v)); return isFinite(n) ? Math.max(0, Math.min(100, n)) : 0; };
  const num = function (v) { return typeof v === 'number' && isFinite(v) ? v : null; };
  /** NSE's words: e-mail addresses out, letters / digits / a few signs only */
  const words = function (v, max) {
    return String(v == null ? '' : v).replace(/[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/g, '(e-mail)')
      .replace(/[^A-Za-z0-9 &.,'()/:;%+\-*#[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  };

  function cleanNum(o) {
    const out = {};
    if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
    NUM_KEYS.forEach(function (k) { if (num(o[k]) !== null && Math.abs(o[k]) < 1e9) out[k] = o[k]; });
    Object.keys(WORD_KEYS).forEach(function (k) { if (typeof o[k] === 'string' && WORD_KEYS[k].test(o[k])) out[k] = o[k]; });
    if (Array.isArray(o.fv) && o.fv.length === 2 && num(o.fv[0]) !== null && num(o.fv[1]) !== null) out.fv = [o.fv[0], o.fv[1]];
    return out;
  }

  /** One packed row checked: known columns / codes, numbers, NSE's words - nothing else passes on. */
  function cleanRow(r) {
    if (!Array.isArray(r) || r.length !== COLS.length) return null;
    const o = {};
    COLS.forEach(function (k, i) { o[k] = r[i]; });
    const sym = String(o.sym || '');
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(String(o.id || '')) || !/^[A-Z0-9&_.-]{1,30}$/.test(sym)) return null;
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(o.at || '')) || CATS.indexOf(o.cat) < 0 || EVENTS.indexOf(o.ev) < 0) return null;
    const ex = (Array.isArray(o.ex) ? o.ex : []).filter(function (e) { return EVENTS.indexOf(e) >= 0 && e !== o.ev; }).slice(0, 4);
    return [String(o.id), sym, words(o.co, 120) || sym, String(o.at), o.cat, o.ev, ex, PRI.indexOf(o.pr) >= 0 ? o.pr : 'low',
      int100(o.bi), int100(o.gr), int100(o.su), o.risk ? 1 : 0, cleanNum(o.num), words(o.sub, 200), words(o.tx, 600),
      typeof o.pdf === 'string' && PDF_RE.test(o.pdf) ? o.pdf : '', o.pg === 'r' || o.pg === 'x' ? o.pg : '', words(o.why, 120)];
  }

  function unpack(blob) {
    if (!blob) return [];
    if (typeof blob !== 'string' || blob.length > MAX_BLOB || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) throw new Error('the stored data is not readable');
    const d = JSON.parse(zlib.gunzipSync(Buffer.from(blob, 'base64')).toString('utf8'));
    if (!d || !Array.isArray(d.cols) || !Array.isArray(d.rows)) throw new Error('the stored data is not readable');
    if (d.cols.join(',') !== COLS.join(',')) throw new Error('your laptop has not sent the new announcements yet - run UpdateNow.bat, then CorpNow.bat');
    return d.rows.slice(0, MAX_ROWS).map(cleanRow).filter(Boolean);
  }

  function cleanSum(s) {
    s = s && typeof s === 'object' ? s : {};
    const int = function (v) { return typeof v === 'number' && isFinite(v) && v >= 0 ? Math.round(v) : 0; };
    const out = { n: int(s.n), stocks: int(s.stocks), high: int(s.high), risk: int(s.risk), cats: {}, evs: {} };
    CATS.forEach(function (k) { out.cats[k] = int(s.cats && s.cats[k]); });
    EVENTS.forEach(function (k) { if (s.evs && s.evs[k]) out.evs[k] = int(s.evs[k]); });
    return out;
  }
  function cleanDays(list) {
    return (Array.isArray(list) ? list : []).filter(function (x) { return x && DAY_RE.test(String(x.day)); }).slice(0, 60).map(function (x) {
      return { day: String(x.day), n: Number.isInteger(x.n) && x.n >= 0 ? x.n : 0,
        made: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(String(x.made || '')) ? String(x.made) : '', sum: cleanSum(x.sum) };
    });
  }
  const laptopOf = function (v) { return Number.isInteger(v) && v >= -1 ? v : -1; };

  /** ?days=N (1-10, newest kept days) / ?from=&to= (at most 10 days) / ?older=key -> the sheet's request, or an error text. */
  function parse(q) {
    if (q.older != null) {
      const k = String(q.older);
      return KEY_RE.test(k) ? { older: k } : 'older must be day:yyyy-mm-dd or sym:SYMBOL';
    }
    const from = q.from == null ? '' : String(q.from), to = q.to == null ? '' : String(q.to);
    if ((from && !DAY_RE.test(from)) || (to && !DAY_RE.test(to))) return 'from / to must be dates (yyyy-mm-dd)';
    if (from || to) return { from: from, to: to };
    const n = q.days == null ? 7 : Number(q.days);
    return Number.isInteger(n) && n >= 1 && n <= 10 ? { days: n } : 'days must be 1 to 10';
  }

  /** deps (tests): { env, fetch, now, cache, timeoutMs } */
  function createHandler(deps) {
    const d = deps || {};
    const getEnv = function () { return d.env || http.readEnv(); };
    const now = typeof d.now === 'function' ? d.now : function () { return Date.now(); };
    return http.endpoint('corp', getEnv, async function (req, res, env) {
      const ask = parse(http.getQuery(req));
      if (typeof ask === 'string') {
        http.sendJson(res, 400, { error: ask }, { env: env, cacheControl: cacheLib.noStore() });
        return;
      }
      if (!sheetFeed.configured(env)) {
        http.sendJson(res, 200, { ok: false, message: sheetFeed.notConfiguredMessage(env, 'Live site feed not configured') },
          { env: env, cacheControl: cacheLib.unavailableCacheControl() });
        return;
      }
      const cache = d.cache || memo;
      const key = ask.older ? 'older:' + ask.older : ask.days ? 'days:' + ask.days : 'range:' + ask.from + ':' + ask.to;
      let got;
      try {
        got = await cache.getOrLoad(key, (ask.older ? OLDER_TTL_S : TTL_S) * 1000, async function () {
          const body = { action: 'site', part: 'corp' };
          if (ask.older) body.older = ask.older;
          if (ask.from) body.from = ask.from;
          if (ask.to) body.to = ask.to;
          const r = await sheetFeed.postFeed(env, { fetch: d.fetch }, body, d.timeoutMs > 0 ? d.timeoutMs : TIMEOUT_MS);
          if (!r.ok) throw new Error(r.reason || 'the sheet did not answer');
          const data = r.data || {};
          const laptop = laptopOf(data.laptop);
          if (ask.older) {
            if (data.pending || !data.older) return { pending: true, key: ask.older, laptop: laptop };
            const o = data.older;
            return { older: { key: ask.older, at: num(o.at) || 0, n: Number.isInteger(o.n) ? o.n : 0, from: DAY_RE.test(String(o.from || '')) ? o.from : '' },
              rows: unpack(o.blob), laptop: laptop };
          }
          const days = cleanDays(data.days);
          let blobs = Array.isArray(data.blobs) ? data.blobs : [];
          if (ask.days) blobs = blobs.slice(0, ask.days);
          const rows = [];
          blobs.forEach(function (b) { if (b && DAY_RE.test(String(b.day))) Array.prototype.push.apply(rows, unpack(b.blob)); });
          return { days: days, shown: blobs.map(function (b) { return String(b && b.day || ''); }).filter(function (x) { return DAY_RE.test(x); }),
            rows: rows.slice(0, MAX_ROWS), laptop: laptop };
        }, { staleOnError: !ask.older, shouldCache: function (v) { return !!v && !v.pending; } });
      } catch (err) {
        http.sendJson(res, 200, { ok: false, message: String(err && err.message || 'the sheet did not answer').slice(0, 200) },
          { env: env, cacheControl: cacheLib.unavailableCacheControl() });
        return;
      }
      const at = cal.istDateTimeStr(now());
      if (got.pending) {
        http.sendJson(res, 200, { ok: true, pending: true, key: got.key, laptop: got.laptop, fetchedAt: at }, { env: env, cacheControl: cacheLib.noStore() });
        return;
      }
      const ttl = ask.older ? OLDER_TTL_S : TTL_S;
      const out = ask.older ? { ok: true, older: got.older, cols: COLS, rows: got.rows, laptop: got.laptop, fetchedAt: at }
        : { ok: true, days: got.days, shown: got.shown, cols: COLS, rows: got.rows, laptop: got.laptop, fetchedAt: at };
      http.sendJson(res, 200, out, { env: env, cacheControl: 'public, max-age=0, s-maxage=' + ttl + ', stale-while-revalidate=' + (ttl * 2) });
    }, ['GET'], true);
  }

  module.exports = createHandler();
  module.exports.createHandler = createHandler;
  module.exports.unpack = unpack;
  module.exports.cleanRow = cleanRow;
  module.exports.COLS = COLS;
  module.exports.EVENTS = EVENTS;
})();
