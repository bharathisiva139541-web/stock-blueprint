// Input validation for the public API endpoints. Never throws: every
// function returns { ok:true, ... } or { ok:false, error }.
(function () {
  'use strict';

  const cal = require('./market-calendar');

  const SYMBOL_RE = /^[A-Z0-9&_-]{1,20}$/;
  const MAX_SYMBOLS = 500;
  const MAX_RANGE_YEARS = 3;
  const DEFAULT_RANGE_DAYS = 365;

  /** First value of a query param (Vercel gives an array when a key repeats). */
  function first(v) { return Array.isArray(v) ? v[0] : v; }

  /**
   * Normalises one symbol: trims, uppercases, drops an optional 'NSE:' prefix
   * (ids returned by /api/quotes look like 'NSE:SBIN'). Returns null if invalid.
   */
  function normalizeSymbol(raw) {
    if (raw === null || raw === undefined) return null;
    let s = String(raw).trim().toUpperCase();
    if (s.indexOf('NSE:') === 0) s = s.slice(4);
    return SYMBOL_RE.test(s) ? s : null;
  }

  /**
   * symbols query -> { ok, symbols } (unique, request order kept).
   * Accepts 'SBIN,TCS', 'SBIN TCS' or a repeated param (array).
   */
  function parseSymbols(raw) {
    const parts = [];
    (Array.isArray(raw) ? raw : [raw]).forEach(function (v) {
      if (v === null || v === undefined) return;
      String(v).split(/[\s,]+/).forEach(function (p) { if (p) parts.push(p); });
    });
    if (!parts.length) return { ok: false, error: 'symbols is required, e.g. ?symbols=SBIN,TCS' };
    const seen = {}, out = [], bad = [];
    parts.forEach(function (p) {
      const s = normalizeSymbol(p);
      if (!s) { if (bad.length < 5) bad.push(String(p).slice(0, 24)); return; }
      if (!seen[s]) { seen[s] = true; out.push(s); }
    });
    if (bad.length) {
      return { ok: false, error: 'invalid symbol(s): ' + bad.join(', ') +
        ' (allowed: A-Z 0-9 & _ -, 1-20 characters; send & as %26)' };
    }
    if (out.length > MAX_SYMBOLS) return { ok: false, error: 'too many symbols (max ' + MAX_SYMBOLS + ')' };
    return { ok: true, symbols: out };
  }

  /** 'YYYY-MM-DD' -> { ok, date } (real calendar date). */
  function parseDate(raw, label) {
    const s = String(first(raw) === undefined || first(raw) === null ? '' : first(raw)).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || cal.parseIstDateTime(s) === null) {
      return { ok: false, error: (label || 'date') + ' must be a real date in YYYY-MM-DD format' };
    }
    return { ok: true, date: s };
  }

  function addYears(dateStr, n) {
    const y = Number(dateStr.slice(0, 4)) + n;
    let d = y + dateStr.slice(4);
    // 29 Feb -> 28 Feb in a non-leap target year
    if (cal.parseIstDateTime(d) === null) d = y + dateStr.slice(4, 8) + '28';
    return d;
  }

  /**
   * History query { symbol, from, to, interval } -> { ok, symbol, from, to, interval }.
   * Defaults: to = today (IST), from = to - 365 days, interval = '1d'.
   * Rules: from <= to, from not in the future, to clamped to today,
   * range at most 3 years.
   */
  function parseHistoryQuery(q, now) {
    const query = q || {};
    const symbol = normalizeSymbol(first(query.symbol));
    if (!symbol) return { ok: false, error: 'symbol is required (A-Z 0-9 & _ -, 1-20 characters), e.g. ?symbol=SBIN' };

    const interval = first(query.interval) === undefined || first(query.interval) === '' ? '1d' : String(first(query.interval));
    if (interval !== '1d') return { ok: false, error: "interval must be '1d' (daily candles only)" };

    const today = cal.istDateStr(now);
    let to = today;
    if (first(query.to) !== undefined && first(query.to) !== '') {
      const t = parseDate(query.to, 'to');
      if (!t.ok) return t;
      to = t.date;
    }
    let from;
    if (first(query.from) !== undefined && first(query.from) !== '') {
      const f = parseDate(query.from, 'from');
      if (!f.ok) return f;
      from = f.date;
    } else {
      from = cal.addDays(to > today ? today : to, -DEFAULT_RANGE_DAYS);
    }
    if (from > today) return { ok: false, error: 'from is in the future' };
    if (from > to) return { ok: false, error: 'from must be on or before to' };
    if (to > addYears(from, MAX_RANGE_YEARS)) return { ok: false, error: 'date range too long (max ' + MAX_RANGE_YEARS + ' years)' };
    if (to > today) to = today;
    return { ok: true, symbol: symbol, from: from, to: to, interval: interval };
  }

  module.exports = {
    SYMBOL_RE: SYMBOL_RE,
    MAX_SYMBOLS: MAX_SYMBOLS,
    MAX_RANGE_YEARS: MAX_RANGE_YEARS,
    first: first,
    normalizeSymbol: normalizeSymbol,
    parseSymbols: parseSymbols,
    parseDate: parseDate,
    parseHistoryQuery: parseHistoryQuery
  };
})();
