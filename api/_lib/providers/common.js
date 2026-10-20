// Shared helpers for market-data providers (payload shapes, numbers, states).
(function () {
  'use strict';

  const cal = require('../market-calendar');
  const validate = require('../validate');

  // Data states, freshest first (see docs/ARCHITECTURE.md "Data states").
  const STATES = ['LIVE', 'DELAYED', 'EOD', 'CACHED', 'UNAVAILABLE'];

  /** The least fresh of several states ('UNAVAILABLE' for none). */
  function leastFresh(states) {
    let worst = -1;
    (states || []).forEach(function (s) {
      const i = STATES.indexOf(s);
      if (i > worst) worst = i;
    });
    return worst < 0 ? 'UNAVAILABLE' : STATES[worst];
  }

  /** Number or null. Accepts numeric strings like '1,234.50'. */
  function toNum(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'string') {
      const s = v.replace(/,/g, '').trim();
      if (!s) return null;
      const n = Number(s);
      return isFinite(n) ? n : null;
    }
    return null;
  }

  /** Positive number or null (0 means "no value" in most feeds). */
  function toPos(v) { const n = toNum(v); return n !== null && n > 0 ? n : null; }

  /** Non-negative number or null. */
  function toNonNeg(v) { const n = toNum(v); return n !== null && n >= 0 ? n : null; }

  function round(n, dp) {
    if (n === null || !isFinite(n)) return null;
    const f = Math.pow(10, dp);
    return Math.round(n * f) / f;
  }

  /** Percent change (2.5 means 2.5 %), 2 decimals, or null. */
  function changePct(ltp, prevClose) {
    if (!(ltp > 0) || !(prevClose > 0)) return null;
    return round((ltp - prevClose) / prevClose * 100, 2);
  }

  /**
   * Cleans a provider's symbols argument without throwing:
   * -> { symbols: unique valid symbols, errors: [{symbol, reason}] }
   */
  function cleanSymbols(symbols) {
    const out = [], errors = [], seen = {};
    (Array.isArray(symbols) ? symbols : []).forEach(function (raw) {
      const s = validate.normalizeSymbol(raw);
      if (!s) { errors.push({ symbol: String(raw === null || raw === undefined ? '' : raw).slice(0, 24), reason: 'invalid symbol' }); return; }
      if (!seen[s]) { seen[s] = true; out.push(s); }
    });
    return { symbols: out, errors: errors };
  }

  /** A whole-request failure for quotes(). errors uses symbol '*' = all symbols. */
  function unavailableQuotes(source, message, now, extraErrors) {
    return {
      state: 'UNAVAILABLE',
      source: source,
      asOf: now === undefined || now === null ? null : cal.istDateTimeStr(now),
      items: [],
      errors: [{ symbol: '*', reason: message }].concat(extraErrors || []),
      message: message
    };
  }

  /** A whole-request failure for history(). */
  function unavailableHistory(source, message, symbol, range, extraErrors) {
    const r = range || {};
    return {
      state: 'UNAVAILABLE',
      source: source,
      symbol: symbol || null,
      from: r.from || null,
      to: r.to || null,
      interval: '1d',
      candles: [],
      errors: [{ symbol: symbol || '*', reason: message }].concat(extraErrors || []),
      message: message
    };
  }

  /** Item shape shared by every provider. */
  function quoteItem(symbol, f) {
    return {
      id: 'NSE:' + symbol,
      symbol: symbol,
      exchange: 'NSE',
      ltp: f.ltp,
      prevClose: f.prevClose === undefined ? null : f.prevClose,
      open: f.open === undefined ? null : f.open,
      high: f.high === undefined ? null : f.high,
      low: f.low === undefined ? null : f.low,
      volume: f.volume === undefined ? null : f.volume,
      changePct: f.changePct === undefined ? null : f.changePct,
      lastTradeTime: f.lastTradeTime === undefined ? null : f.lastTradeTime,
      state: f.state
    };
  }

  module.exports = {
    STATES: STATES,
    leastFresh: leastFresh,
    toNum: toNum,
    toPos: toPos,
    toNonNeg: toNonNeg,
    round: round,
    changePct: changePct,
    cleanSymbols: cleanSymbols,
    unavailableQuotes: unavailableQuotes,
    unavailableHistory: unavailableHistory,
    quoteItem: quoteItem
  };
})();
