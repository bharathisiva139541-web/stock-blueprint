// 'dhan' provider: DhanHQ v2 REST APIs (server side only).
//
// env: DHAN_CLIENT_ID, DHAN_ACCESS_TOKEN (never logged, never returned).
// Endpoints used:
//   POST https://api.dhan.co/v2/marketfeed/quote   quotes, <=1000 ids/request, ~1 request/s
//   POST https://api.dhan.co/v2/charts/historical  daily candles
//   GET  https://api.dhan.co/v2/profile            status (token valid, data plan active)
// Instrument ids come from the public scrip master CSV (see dhan-scrip-master.js).
//
// ASSUMPTIONS TO VERIFY against the current DhanHQ docs (see docs/MARKET_DATA.md):
//   A1 quote ohlc.close is the PREVIOUS session close (Kite-style); fallback
//      prevClose = last_price - net_change (net_change = absolute change).
//   A2 quote last_trade_time is IST 'DD/MM/YYYY HH:MM:SS' ('01/01/1980 ...' = no trade);
//      epoch seconds/ms are accepted too.
//   A3 charts/historical toDate is EXCLUSIVE, so one day is added; candles are
//      filtered to [from, to] afterwards anyway.
//   A4 historical timestamps are epoch seconds (UTC); a daily bar's IST date is the date.
(function () {
  'use strict';

  const cal = require('../market-calendar');
  const cacheLib = require('../cache');
  const fetchUtil = require('../fetch-util');
  const common = require('./common');
  const scrip = require('./dhan-scrip-master');

  const BASE = 'https://api.dhan.co/v2';
  const QUOTE_URL = BASE + '/marketfeed/quote';
  const HISTORY_URL = BASE + '/charts/historical';
  const PROFILE_URL = BASE + '/profile';

  const MAX_IDS_PER_REQUEST = 1000;
  const QUOTE_GAP_MS = 1100;             // ~1 request per second for the quote API
  const RATE_LIMIT_BACKOFF_MS = 2000;    // wait after a 429 before the single retry
  const LIVE_MAX_AGE_MS = 5 * 60 * 1000; // last trade within 5 min -> LIVE
  const SCRIP_TTL_MS = 12 * 3600 * 1000;
  const SCRIP_RETRY_MS = 60 * 1000;
  const STATUS_TTL_MS = 60 * 1000;

  const LICENSING = 'DhanHQ Data APIs: needs an active Dhan trading account and a paid/active Data API ' +
    'plan; NSE market data is licensed by the exchange - shown only to this site\'s visitors, not for ' +
    'redistribution. Verify current Dhan and NSE terms.';

  const REQUIRES = ['DHAN_CLIENT_ID', 'DHAN_ACCESS_TOKEN'];

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** A2: Dhan last_trade_time -> epoch ms, or null when absent / placeholder. */
  function parseDhanTime(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number' && isFinite(v)) {
      const ms = v > 1e12 ? v : v * 1000;
      return ms > Date.UTC(2000, 0, 1) ? ms : null;
    }
    const s = String(v).trim();
    let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
    if (m) {
      if (+m[3] < 2000) return null;
      return cal.parseIstDateTime(m[3] + '-' + pad2(+m[2]) + '-' + pad2(+m[1]) + ' ' +
                                  pad2(+m[4]) + ':' + m[5] + ':' + (m[6] || '00'));
    }
    m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/.exec(s);
    if (m) {
      const ms = cal.parseIstDateTime(m[1] + ' ' + m[2]);
      return ms !== null && ms > Date.UTC(2000, 0, 1) ? ms : null;
    }
    if (/^\d{9,13}$/.test(s)) return parseDhanTime(Number(s));
    return null;
  }

  /**
   * Data state of one quote.
   *  session open : last trade <= 5 min old -> LIVE; traded today but older -> DELAYED;
   *                 last trade on an earlier day -> EOD; unknown time -> DELAYED
   *  otherwise    : last trade after the last completed session (e.g. pre-open) -> DELAYED,
   *                 else EOD
   */
  function quoteState(nowMs, lastTradeMs, session, lastCompleted) {
    const today = cal.istDateStr(nowMs);
    if (session === 'open') {
      if (lastTradeMs === null) return 'DELAYED';
      if (nowMs - lastTradeMs <= LIVE_MAX_AGE_MS && lastTradeMs - nowMs <= 60000) return 'LIVE';
      return cal.istDateStr(lastTradeMs) < today ? 'EOD' : 'DELAYED';
    }
    if (lastTradeMs !== null && lastCompleted && cal.istDateStr(lastTradeMs) > lastCompleted) return 'DELAYED';
    return 'EOD';
  }

  /**
   * Classifies an upstream response:
   * { kind: 'ok'|'auth'|'no-access'|'rate'|'timeout'|'network'|'malformed'|'input'|'nodata'|'upstream'|'http', reason }
   * Upstream error messages are NOT passed through (they could echo request data);
   * only a Dhan error code like 'DH-901' is kept.
   */
  function classify(resp) {
    const d = resp && resp.data;
    const code = d && typeof d.errorCode === 'string' && /^DH-\d{3}$/.test(d.errorCode) ? d.errorCode : '';
    const tag = code ? ' (' + code + ')' : '';
    if (!resp) return { kind: 'network', reason: 'Dhan not reachable' };
    if (resp.error === 'timeout') return { kind: 'timeout', reason: 'Dhan request timed out' };
    if (resp.error === 'network' || resp.error === 'no-fetch') return { kind: 'network', reason: 'Dhan not reachable (network error)' };
    if (resp.status === 401 || resp.status === 403 || code === 'DH-901') {
      return { kind: 'auth', reason: 'auth failed: Dhan rejected the access token or client id (tokens expire - generate a new one)' + tag };
    }
    if (code === 'DH-902') return { kind: 'no-access', reason: 'Dhan Data API access denied - is the Data API plan active on this account?' + tag };
    if (resp.status === 429 || code === 'DH-904') return { kind: 'rate', reason: 'rate limited by Dhan - try again shortly' + tag };
    if (resp.error === 'malformed') return { kind: 'malformed', reason: 'malformed response from Dhan (not JSON)' };
    if (code === 'DH-907') return { kind: 'nodata', reason: 'Dhan has no data for this request' + tag };
    if (code === 'DH-905' || resp.status === 400) return { kind: 'input', reason: 'Dhan rejected the request as invalid' + tag };
    if (resp.status >= 500 || code === 'DH-908') return { kind: 'upstream', reason: 'Dhan server error (HTTP ' + resp.status + ')' + tag };
    if (!resp.ok) return { kind: 'http', reason: 'Dhan request failed (HTTP ' + resp.status + ')' + tag };
    return { kind: 'ok', reason: '' };
  }

  // Errors after which further requests in the same call are pointless.
  const FATAL_KINDS = { 'auth': 1, 'no-access': 1, 'rate': 1, 'timeout': 1, 'network': 1 };
  const TRANSIENT_KINDS = { 'rate': 1, 'timeout': 1, 'network': 1, 'upstream': 1, 'malformed': 1, 'http': 1 };

  function createDhanProvider(env, deps) {
    const e = env || {};
    const d = deps || {};
    const clientId = String(e.DHAN_CLIENT_ID || '').trim();
    const token = String(e.DHAN_ACCESS_TOKEN || '').trim();
    const configured = !!(clientId && token);
    const now = typeof d.now === 'function' ? d.now : function () { return Date.now(); };
    const sleep = typeof d.sleep === 'function' ? d.sleep : fetchUtil.sleep;
    const cache = d.cache || cacheLib.shared;
    const timeoutMs = d.timeoutMs > 0 ? d.timeoutMs : fetchUtil.DEFAULT_TIMEOUT_MS;
    const scripTimeoutMs = d.scripTimeoutMs > 0 ? d.scripTimeoutMs : 20000;
    const backoffMs = d.backoffMs >= 0 ? d.backoffMs : RATE_LIMIT_BACKOFF_MS;
    const gapMs = d.quoteGapMs >= 0 ? d.quoteGapMs : QUOTE_GAP_MS;

    const notConfigured = 'Dhan is selected but not configured: set ' +
      REQUIRES.filter(function (k) { return !String(e[k] || '').trim(); }).join(' and ') +
      ' in Vercel > Project > Settings > Environment Variables, then redeploy.';

    function headers() {
      return { 'access-token': token, 'client-id': clientId,
               'Content-Type': 'application/json', 'Accept': 'application/json' };
    }

    function post(url, body) {
      return fetchUtil.requestJson(d.fetch, url,
        { method: 'POST', headers: headers(), body: JSON.stringify(body) }, timeoutMs);
    }

    // Quote API pacing: reserve the next 1-second slot synchronously, then wait.
    async function paced(fn) {
      const t = now();
      const slot = cache.peek('dhan:quote-slot');
      const next = slot ? slot.value : 0;
      const wait = Math.max(0, next - t);
      cache.set('dhan:quote-slot', Math.max(t, next) + gapMs, 60000);
      if (wait > 0) await sleep(wait);
      return fn();
    }

    async function withRetryOn429(send) {
      let resp = await send();
      let k = classify(resp);
      if (k.kind === 'rate') {
        await sleep(resp.retryAfterMs !== null && resp.retryAfterMs !== undefined ? Math.max(resp.retryAfterMs, backoffMs) : backoffMs);
        resp = await send();
        k = classify(resp);
      }
      return { resp: resp, k: k };
    }

    // Scrip master: 12 h in memory; a stale copy is used if a refresh fails;
    // a failed download with no copy is remembered for 60 s so a burst of
    // requests does not re-download a large file that is not reachable.
    async function master() {
      const failed = cache.get('dhan:scrip-master-failed');
      if (failed && !cache.peek('dhan:scrip-master')) return { ok: false, reason: failed };
      try {
        return await cache.getOrLoad('dhan:scrip-master', SCRIP_TTL_MS, async function () {
          const r = await scrip.loadScripMaster({ fetch: d.fetch, timeoutMs: scripTimeoutMs, now: now });
          if (!r.ok) { const err = new Error(r.reason); /** @type {any} */ (err).reason = r.reason; throw err; }
          return r;
        }, { staleOnError: true });
      } catch (err) {
        const reason = (err && err.reason) || 'scrip master unavailable';
        cache.set('dhan:scrip-master-failed', reason, SCRIP_RETRY_MS);
        return { ok: false, reason: reason };
      }
    }

    function describe() {
      return { name: 'dhan', requires: REQUIRES.slice(), configured: configured, licensing: LICENSING };
    }

    async function status() {
      if (!configured) return { ok: false, state: 'UNAVAILABLE', message: notConfigured };
      const cached = cache.get('dhan:status');
      let base = cached;
      if (!base) {
        const resp = await fetchUtil.requestJson(d.fetch, PROFILE_URL,
          { method: 'GET', headers: headers() }, timeoutMs);
        const k = classify(resp);
        if (k.kind !== 'ok') {
          base = { ok: false, message: k.reason };
        } else {
          const plan = resp.data && typeof resp.data.dataPlan === 'string' ? resp.data.dataPlan.trim() : '';
          if (plan && !/^active$/i.test(plan)) {
            base = { ok: false, message: 'Dhan token works, but the Data API plan is not active on this account.' };
          } else {
            base = { ok: true, message: plan ? 'Dhan connected; Data API plan active.'
                                             : 'Dhan connected (Data API plan status not reported).' };
          }
        }
        cache.set('dhan:status', base, STATUS_TTL_MS);
      }
      const session = cal.sessionState(now());
      return { ok: base.ok, state: !base.ok ? 'UNAVAILABLE' : (session === 'open' ? 'LIVE' : 'EOD'), message: base.message };
    }

    function mapQuote(symbol, q, nowMs, session, lastCompleted) {
      if (!q || typeof q !== 'object') return { error: 'no quote returned by Dhan' };
      const ltp = common.toPos(q.last_price);
      if (ltp === null) return { error: 'no last price in Dhan response' };
      const ohlc = q.ohlc && typeof q.ohlc === 'object' ? q.ohlc : {};
      let prevClose = common.toPos(ohlc.close); // A1
      if (prevClose === null) {
        const nc = common.toNum(q.net_change);
        prevClose = nc !== null ? common.toPos(common.round(ltp - nc, 2)) : null;
      }
      const lt = parseDhanTime(q.last_trade_time);
      return {
        item: common.quoteItem(symbol, {
          ltp: ltp,
          prevClose: prevClose,
          open: common.toPos(ohlc.open),
          high: common.toPos(ohlc.high),
          low: common.toPos(ohlc.low),
          volume: common.toNonNeg(q.volume),
          changePct: common.changePct(ltp, prevClose),
          lastTradeTime: lt === null ? null : cal.istDateTimeStr(lt),
          state: quoteState(nowMs, lt, session, lastCompleted)
        })
      };
    }

    async function quotes(symbols) {
      const nowMs = now();
      const clean = common.cleanSymbols(symbols);
      if (!configured) return common.unavailableQuotes('dhan', notConfigured, nowMs);
      if (!clean.symbols.length) {
        return common.unavailableQuotes('dhan', 'no valid symbols requested', nowMs, clean.errors);
      }
      const m = await master();
      if (!m.ok) return common.unavailableQuotes('dhan', 'instrument list unavailable: ' + m.reason, nowMs);

      const errors = clean.errors.slice();
      const wanted = [];
      clean.symbols.forEach(function (s) {
        const hit = m.bySymbol.get(s);
        if (hit) wanted.push({ symbol: s, id: hit.securityId });
        else errors.push({ symbol: s, reason: 'unknown symbol: not an NSE equity in the Dhan scrip master' });
      });

      const session = cal.sessionState(nowMs);
      const lastCompleted = cal.lastCompletedSession(nowMs);
      const items = [];
      const bySymbol = {};
      let fatal = null, partial = false, authFailed = false;

      for (let c = 0; c < wanted.length; c += MAX_IDS_PER_REQUEST) {
        const chunk = wanted.slice(c, c + MAX_IDS_PER_REQUEST);
        if (fatal) {
          chunk.forEach(function (w) { errors.push({ symbol: w.symbol, reason: fatal + ' (skipped)' }); });
          continue;
        }
        const body = { NSE_EQ: chunk.map(function (w) { return Number(w.id); }) };
        const r = await withRetryOn429(function () { return paced(function () { return post(QUOTE_URL, body); }); });
        let k = r.k;
        let seg = null;
        if (k.kind === 'ok') {
          const data = r.resp.data && r.resp.data.data;
          seg = data && typeof data === 'object' ? data.NSE_EQ : null;
          if (!seg || typeof seg !== 'object') {
            k = { kind: 'malformed', reason: 'malformed response from Dhan (no data.NSE_EQ)' };
          }
        }
        if (k.kind !== 'ok') {
          if (k.kind === 'auth') authFailed = true;
          if (TRANSIENT_KINDS[k.kind]) partial = true;
          chunk.forEach(function (w) { errors.push({ symbol: w.symbol, reason: k.reason }); });
          if (FATAL_KINDS[k.kind]) fatal = k.reason;
          continue;
        }
        chunk.forEach(function (w) {
          const out = mapQuote(w.symbol, seg[String(w.id)], nowMs, session, lastCompleted);
          if (out.item) bySymbol[w.symbol] = out.item;
          else errors.push({ symbol: w.symbol, reason: out.error });
        });
      }
      // Keep the caller's order.
      wanted.forEach(function (w) { if (bySymbol[w.symbol]) items.push(bySymbol[w.symbol]); });

      const payload = {
        state: items.length ? common.leastFresh(items.map(function (i) { return i.state; })) : 'UNAVAILABLE',
        source: 'dhan',
        asOf: cal.istDateTimeStr(nowMs),
        items: items,
        errors: errors
      };
      if (!items.length) {
        payload.message = authFailed ? 'auth failed: check DHAN_ACCESS_TOKEN / DHAN_CLIENT_ID (tokens expire)'
          : (errors.length ? errors[errors.length - 1].reason : 'no quotes returned');
      }
      if (partial) payload.partial = true;
      return payload;
    }

    async function history(symbol, range) {
      const r = range || {};
      const sym = common.cleanSymbols([symbol]).symbols[0] || null;
      const from = cal.istDateStr(r.from || '');
      const to = cal.istDateStr(r.to || '');
      const rng = { from: from, to: to };
      if (!configured) return common.unavailableHistory('dhan', notConfigured, sym, rng);
      if (!sym) return common.unavailableHistory('dhan', 'invalid symbol', null, rng);
      if (!from || !to || from > to) return common.unavailableHistory('dhan', 'invalid date range', sym, rng);
      if (r.interval && r.interval !== '1d') return common.unavailableHistory('dhan', "only interval '1d' is supported", sym, rng);

      const m = await master();
      if (!m.ok) return common.unavailableHistory('dhan', 'instrument list unavailable: ' + m.reason, sym, rng);
      const hit = m.bySymbol.get(sym);
      if (!hit) return common.unavailableHistory('dhan', 'unknown symbol: not an NSE equity in the Dhan scrip master', sym, rng);

      const body = { securityId: String(hit.securityId), exchangeSegment: 'NSE_EQ', instrument: 'EQUITY',
                     expiryCode: 0, oi: false, fromDate: from, toDate: cal.addDays(to, 1) }; // A3
      const res = await withRetryOn429(function () { return post(HISTORY_URL, body); });
      if (res.k.kind !== 'ok') {
        const out = common.unavailableHistory('dhan', res.k.reason, sym, rng);
        if (TRANSIENT_KINDS[res.k.kind]) out.partial = true;
        return out;
      }
      const data = res.resp.data || {};
      const ts = data.timestamp;
      if (!Array.isArray(ts) || !Array.isArray(data.open) || !Array.isArray(data.high) ||
          !Array.isArray(data.low) || !Array.isArray(data.close)) {
        return common.unavailableHistory('dhan', 'malformed response from Dhan (missing candle arrays)', sym, rng);
      }
      const nowMs = now();
      const lastCompleted = cal.lastCompletedSession(nowMs);
      const byDate = {};
      let skipped = 0;
      for (let i = 0; i < ts.length; i++) {
        const t = common.toNum(ts[i]);
        const day = t === null ? null : cal.istDateStr(t > 1e12 ? t : t * 1000); // A4
        const o = common.toPos(data.open[i]), h = common.toPos(data.high[i]);
        const l = common.toPos(data.low[i]), c = common.toPos(data.close[i]);
        const vRaw = Array.isArray(data.volume) ? common.toNonNeg(data.volume[i]) : null;
        if (!day || o === null || h === null || l === null || c === null) { skipped++; continue; }
        if (day < from || day > to) continue;
        if (lastCompleted && day > lastCompleted) continue; // today's bar is still forming
        byDate[day] = { t: day, o: o, h: h, l: l, c: c, v: vRaw === null ? 0 : vRaw };
      }
      const candles = Object.keys(byDate).sort().map(function (k) { return byDate[k]; });
      const errors = [];
      if (skipped) errors.push({ symbol: sym, reason: skipped + ' malformed bar(s) skipped' });
      if (!candles.length) {
        return common.unavailableHistory('dhan', 'no daily candles returned for this range', sym, rng, errors);
      }
      return { state: 'EOD', source: 'dhan', symbol: sym, from: from, to: to, interval: '1d',
               candles: candles, errors: errors };
    }

    return { name: 'dhan', describe: describe, status: status, quotes: quotes, history: history };
  }

  module.exports = {
    createDhanProvider: createDhanProvider,
    parseDhanTime: parseDhanTime,
    quoteState: quoteState,
    classify: classify,
    QUOTE_URL: QUOTE_URL,
    HISTORY_URL: HISTORY_URL,
    PROFILE_URL: PROFILE_URL,
    MAX_IDS_PER_REQUEST: MAX_IDS_PER_REQUEST,
    LIVE_MAX_AGE_MS: LIVE_MAX_AGE_MS,
    SCRIP_TTL_MS: SCRIP_TTL_MS
  };
})();
