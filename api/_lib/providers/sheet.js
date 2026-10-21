// 'sheet' provider: the owner's own Google Sheet, read through its Apps Script
// web app (/exec URL). Prices there come from GOOGLEFINANCE (~20 min delayed),
// so this provider is never LIVE.
//
// env: SHEET_FEED_URL (the web app /exec URL - treat it as a secret),
//      SHEET_FEED_TOKEN (shared secret checked by doPost).
// Request : POST {token, action:'snapshot'}   (sent by ../sheet-feed.js)
// Response: { ok:true, asOf:'YYYY-MM-DD HH:MM', readAt, delayMinutes:20,
//             cols:['sym','price','chg',...], rows:[[...], ...] }
//           (column keys as in web/data/dashboard.js "main")
(function () {
  'use strict';

  const cal = require('../market-calendar');
  const cacheLib = require('../cache');
  const fetchUtil = require('../fetch-util');
  const sheetFeed = require('../sheet-feed');
  const common = require('./common');

  const REQUIRES = sheetFeed.REQUIRES;
  const SNAPSHOT_TTL_MS = 60 * 1000;
  const DEFAULT_DELAY_MIN = 20;
  // GOOGLEFINANCE lags ~20 min, so a sheet read in the first half hour after
  // the 15:30 close may still hold pre-close prices.
  const SETTLE_TIME = '16:00';

  const LICENSING = 'Prices come from GOOGLEFINANCE inside your own Google Sheet: delayed (~20 min), ' +
    'informational only, not for trading; Google and the exchanges restrict redistribution. Verify terms.';

  // Optional columns the sheet may add (first match wins).
  const COLS = {
    sym: ['sym'],
    price: ['price'],
    chg: ['chg'],
    prevClose: ['prevClose', 'prev', 'pclose'],
    open: ['open'],
    high: ['high'],
    low: ['low'],
    volume: ['volume', 'vol'],
    lastTradeTime: ['ltt', 'tradetime']
  };

  function colIndex(cols, names) {
    for (let i = 0; i < names.length; i++) {
      const j = cols.indexOf(names[i]);
      if (j >= 0) return j;
    }
    return -1;
  }

  /**
   * Honest state of prices read from the sheet at `readAtMs` (never LIVE):
   *   DELAYED  read during today's session (09:15 or later) while the market
   *            is open, or until 16:00 after the close (last minutes settling);
   *   EOD      read after the close of the last completed session (evenings,
   *            weekends, holidays, before 09:15): the prices are that close;
   *   CACHED   no read time, or read before that close (an old copy).
   * Weekends / holidays are never DELAYED.
   */
  function sheetPriceState(readAtMs, nowMs) {
    if (readAtMs === null || readAtMs === undefined || !isFinite(readAtMs)) return 'CACHED';
    const session = cal.sessionState(nowMs);
    if (!session) return 'CACHED';
    const today = cal.istDateStr(nowMs);
    if ((session === 'open' || session === 'closed') && cal.istDateStr(readAtMs) === today) {
      const openMs = cal.parseIstDateTime(today + ' ' + cal.SESSION.open);
      const settleMs = cal.parseIstDateTime(today + ' ' + SETTLE_TIME);
      if (readAtMs >= openMs && nowMs < settleMs) return 'DELAYED';
    }
    const last = cal.lastCompletedSession(nowMs);
    const closeMs = last ? cal.sessionCloseMs(last) : null;
    return closeMs !== null && readAtMs >= closeMs ? 'EOD' : 'CACHED';
  }

  /** One sentence for status(): what the state means for the visitor. */
  function stateNote(state, nowMs) {
    if (state === 'EOD') return ' - market closed: prices are the ' + cal.lastCompletedSession(nowMs) + ' close';
    if (state === 'CACHED') return ' - snapshot is older than the latest session';
    return '';
  }

  function createSheetProvider(env, deps) {
    const e = env || {};
    const d = deps || {};
    const configured = sheetFeed.configured(e);
    const now = typeof d.now === 'function' ? d.now : function () { return Date.now(); };
    const cache = d.cache || cacheLib.shared;
    const timeoutMs = d.timeoutMs > 0 ? d.timeoutMs : fetchUtil.DEFAULT_TIMEOUT_MS;
    const notConfigured = sheetFeed.notConfiguredMessage(e, 'Sheet feed is selected but not configured');

    async function fetchSnapshot() {
      const resp = await sheetFeed.postFeed(e, { fetch: d.fetch }, { action: 'snapshot' }, timeoutMs);
      if (!resp.ok) return resp.auth ? { ok: false, auth: true, reason: resp.reason } : { ok: false, reason: resp.reason };
      const data = resp.data;
      const cols = Array.isArray(data.cols) ? data.cols.map(function (c) { return String(c); }) : null;
      const rows = Array.isArray(data.rows) ? data.rows : null;
      if (!cols || !rows) return { ok: false, reason: 'malformed sheet feed (cols/rows missing)' };
      const idx = {};
      Object.keys(COLS).forEach(function (k) { idx[k] = colIndex(cols, COLS[k]); });
      if (idx.sym < 0 || idx.price < 0) return { ok: false, reason: 'malformed sheet feed (no sym/price column)' };
      const bySymbol = new Map();
      rows.forEach(function (row) {
        if (!Array.isArray(row)) return;
        let s = String(row[idx.sym] === null || row[idx.sym] === undefined ? '' : row[idx.sym]).trim().toUpperCase();
        if (s.indexOf('NSE:') === 0) s = s.slice(4);
        if (s && !bySymbol.has(s)) bySymbol.set(s, row);
      });
      const asOfRaw = typeof data.asOf === 'string' ? data.asOf : data.readAt;
      const asOf = typeof asOfRaw === 'string' && cal.parseIstDateTime(asOfRaw) !== null ? asOfRaw.trim() : null;
      const delay = common.toNum(data.delayMinutes);
      return { ok: true, asOf: asOf, delayMinutes: delay !== null && delay >= 0 ? delay : DEFAULT_DELAY_MIN,
               idx: idx, bySymbol: bySymbol, rowCount: rows.length };
    }

    function snapshot() {
      return cache.getOrLoad('sheet:snapshot', SNAPSHOT_TTL_MS, fetchSnapshot,
        { shouldCache: function (v) { return !!(v && v.ok); } })
        .catch(function () { return { ok: false, reason: 'sheet feed failed' }; });
    }

    function describe() {
      return { name: 'sheet', requires: REQUIRES.slice(), configured: configured, licensing: LICENSING };
    }

    async function status() {
      if (!configured) return { ok: false, state: 'UNAVAILABLE', message: notConfigured };
      const s = await snapshot();
      if (!s.ok) return { ok: false, state: 'UNAVAILABLE', message: s.reason };
      const asOfMs = s.asOf ? cal.parseIstDateTime(s.asOf) : null;
      const nowMs = now();
      const state = sheetPriceState(asOfMs, nowMs);
      return { ok: true, state: state,
               message: 'Sheet feed reachable: ' + s.bySymbol.size + ' symbols, as of ' + (s.asOf || 'unknown time') +
                 ' IST (GOOGLEFINANCE, ~' + s.delayMinutes + ' min delayed)' + stateNote(state, nowMs) + '.' };
    }

    async function quotes(symbols) {
      const nowMs = now();
      const clean = common.cleanSymbols(symbols);
      if (!configured) return common.unavailableQuotes('sheet', notConfigured, nowMs);
      if (!clean.symbols.length) return common.unavailableQuotes('sheet', 'no valid symbols requested', nowMs, clean.errors);
      const s = await snapshot();
      if (!s.ok) return common.unavailableQuotes('sheet', s.reason, nowMs);

      const asOfMs = s.asOf ? cal.parseIstDateTime(s.asOf) : null;
      const state = sheetPriceState(asOfMs, nowMs);
      const items = [], errors = clean.errors.slice();
      const ix = s.idx;
      const cell = function (row, k) { return ix[k] >= 0 ? row[ix[k]] : null; };
      clean.symbols.forEach(function (sym) {
        const row = s.bySymbol.get(sym);
        if (!row) { errors.push({ symbol: sym, reason: 'not in the sheet' }); return; }
        const ltp = common.toPos(cell(row, 'price'));
        if (ltp === null) { errors.push({ symbol: sym, reason: 'no price in the sheet' }); return; }
        const prevClose = common.toPos(cell(row, 'prevClose'));
        const chg = common.toNum(cell(row, 'chg'));
        const ltt = cell(row, 'lastTradeTime');
        items.push(common.quoteItem(sym, {
          ltp: ltp,
          prevClose: prevClose,
          open: common.toPos(cell(row, 'open')),
          high: common.toPos(cell(row, 'high')),
          low: common.toPos(cell(row, 'low')),
          volume: common.toNonNeg(cell(row, 'volume')),
          changePct: chg !== null ? common.round(chg, 2) : common.changePct(ltp, prevClose),
          lastTradeTime: typeof ltt === 'string' && cal.parseIstDateTime(ltt) !== null ? cal.istDateTimeStr(ltt) : null,
          state: state
        }));
      });
      const payload = {
        state: items.length ? state : 'UNAVAILABLE',
        source: 'sheet',
        asOf: s.asOf,
        delayMinutes: s.delayMinutes,
        items: items,
        errors: errors
      };
      if (!items.length) payload.message = 'none of the requested symbols are in the sheet';
      return payload;
    }

    async function history(symbol, range) {
      const r = range || {};
      const sym = common.cleanSymbols([symbol]).symbols[0] || null;
      return common.unavailableHistory('sheet',
        'history is not available from the sheet feed: the sheet keeps only ~30 daily bars (History30). ' +
        'Use MARKET_DATA_PROVIDER=dhan for history.', sym, { from: r.from, to: r.to });
    }

    return { name: 'sheet', describe: describe, status: status, quotes: quotes, history: history };
  }

  module.exports = { createSheetProvider: createSheetProvider, sheetPriceState: sheetPriceState,
                     SNAPSHOT_TTL_MS: SNAPSHOT_TTL_MS, SETTLE_TIME: SETTLE_TIME };
})();
