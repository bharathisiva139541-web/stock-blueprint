// NSE (India) market calendar helpers - server side (CommonJS).
//
// Everything here works in Asia/Kolkata time WITHOUT depending on the
// server's own time zone (Vercel runs in UTC, a laptop may be anywhere):
// IST is a fixed UTC+05:30 offset with no daylight saving, so a Date is
// shifted by +05:30 and read with the getUTC* methods.
//
// Pure functions: "now" is always passed in (a Date, epoch ms, or an
// IST string). Bad input never throws - functions return null / false.
(function () {
  'use strict';

  const IST_OFFSET_MS = 330 * 60 * 1000; // +05:30

  // Session times in seconds after IST midnight (NSE capital market segment).
  const PRE_OPEN_START = 9 * 3600;            // 09:00:00 pre-open order entry
  const OPEN_START = 9 * 3600 + 15 * 60;      // 09:15:00 normal market opens
  const CLOSE = 15 * 3600 + 30 * 60;          // 15:30:00 normal market closes (inclusive)

  // NSE capital-market (equity) trading holidays that fall on weekdays.
  // !!! THIS LIST MUST BE UPDATED EVERY YEAR !!!
  // Copy it from the official NSE circular "Trading holidays for the
  // calendar year YYYY" (published every December on nseindia.com >
  // Resources > Exchange Communication > Circulars) and verify every date;
  // NSE also adds one-off holidays during the year (e.g. elections).
  // Special sessions (Muhurat trading on Diwali) are NOT modelled.
  // Years present below are the only years treated as "covered".
  const NSE_HOLIDAYS = {
    // 2025 (NSE circular of December 2024)
    '2025-02-26': 'Mahashivratri',
    '2025-03-14': 'Holi',
    '2025-03-31': 'Id-Ul-Fitr (Ramadan Eid)',
    '2025-04-10': 'Shri Mahavir Jayanti',
    '2025-04-14': 'Dr. Baba Saheb Ambedkar Jayanti',
    '2025-04-18': 'Good Friday',
    '2025-05-01': 'Maharashtra Day',
    '2025-08-15': 'Independence Day',
    '2025-08-27': 'Ganesh Chaturthi',
    '2025-10-02': 'Mahatma Gandhi Jayanti / Dussehra',
    '2025-10-21': 'Diwali Laxmi Pujan (Muhurat trading only)',
    '2025-10-22': 'Diwali Balipratipada',
    '2025-11-05': 'Prakash Gurpurb Sri Guru Nanak Dev',
    '2025-12-25': 'Christmas',
    // 2026 (NSE circular of December 2025 + one-off circular NSE/CMTR/72260)
    '2026-01-15': 'Municipal Corporation Election in Maharashtra',
    '2026-01-26': 'Republic Day',
    '2026-03-03': 'Holi',
    '2026-03-26': 'Shri Ram Navami',
    '2026-03-31': 'Shri Mahavir Jayanti',
    '2026-04-03': 'Good Friday',
    '2026-04-14': 'Dr. Baba Saheb Ambedkar Jayanti',
    '2026-05-01': 'Maharashtra Day',
    '2026-05-28': 'Bakri Id',
    '2026-06-26': 'Muharram',
    '2026-09-14': 'Ganesh Chaturthi',
    '2026-10-02': 'Mahatma Gandhi Jayanti',
    '2026-10-20': 'Dussehra',
    '2026-11-10': 'Diwali Balipratipada',
    '2026-11-24': 'Prakash Gurpurb Sri Guru Nanak Dev',
    '2026-12-25': 'Christmas'
  };

  const COVERED_YEARS = (function () {
    const set = {};
    Object.keys(NSE_HOLIDAYS).forEach(function (d) { set[d.slice(0, 4)] = true; });
    return Object.keys(set).map(Number).sort();
  })();

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** Accepts a Date, epoch ms, 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM[:SS]' (IST). Returns epoch ms or null. */
  function toMs(x) {
    if (x instanceof Date) { const t = x.getTime(); return isFinite(t) ? t : null; }
    if (typeof x === 'number') return isFinite(x) ? x : null;
    if (typeof x === 'string') return parseIstDateTime(x);
    return null;
  }

  /**
   * Parses an IST wall-clock string 'YYYY-MM-DD', 'YYYY-MM-DD HH:MM' or
   * 'YYYY-MM-DD HH:MM:SS' (a 'T' separator is accepted too) -> epoch ms.
   */
  function parseIstDateTime(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(s || '').trim());
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3], hh = +(m[4] || 0), mi = +(m[5] || 0), ss = +(m[6] || 0);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 59) return null;
    const utc = Date.UTC(y, mo - 1, d, hh, mi, ss);
    const back = new Date(utc);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
    return utc - IST_OFFSET_MS;
  }

  /** IST calendar parts of an instant: { y, m (1-12), d, hh, mm, ss, wd (0=Sun..6=Sat), secs }. */
  function istParts(x) {
    const ms = toMs(x);
    if (ms === null) return null;
    const s = new Date(ms + IST_OFFSET_MS);
    const hh = s.getUTCHours(), mm = s.getUTCMinutes(), ss = s.getUTCSeconds();
    return { y: s.getUTCFullYear(), m: s.getUTCMonth() + 1, d: s.getUTCDate(),
             hh: hh, mm: mm, ss: ss, wd: s.getUTCDay(), secs: hh * 3600 + mm * 60 + ss };
  }

  /** 'YYYY-MM-DD' (IST) of an instant. A bare 'YYYY-MM-DD' string is returned as-is (validated). */
  function istDateStr(x) {
    if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.trim())) {
      return parseIstDateTime(x) === null ? null : x.trim();
    }
    const p = istParts(x);
    return p ? p.y + '-' + pad2(p.m) + '-' + pad2(p.d) : null;
  }

  /** 'YYYY-MM-DD HH:MM' (IST) of an instant. */
  function istDateTimeStr(x) {
    const p = istParts(x);
    return p ? p.y + '-' + pad2(p.m) + '-' + pad2(p.d) + ' ' + pad2(p.hh) + ':' + pad2(p.mm) : null;
  }

  /** Adds whole days to a 'YYYY-MM-DD' string. */
  function addDays(dateStr, n) {
    const ms = parseIstDateTime(dateStr);
    if (ms === null || !isFinite(n)) return null;
    return istDateStr(ms + Math.round(n) * 86400000);
  }

  /** Day of week (0=Sun) of a 'YYYY-MM-DD' calendar date. */
  function weekdayOf(dateStr) {
    const ms = parseIstDateTime(dateStr);
    return ms === null ? null : new Date(ms + IST_OFFSET_MS).getUTCDay();
  }

  /** Holiday name for an IST date (Date / ms / 'YYYY-MM-DD'), or null. */
  function holidayName(x) {
    const d = istDateStr(x);
    return d && Object.prototype.hasOwnProperty.call(NSE_HOLIDAYS, d) ? NSE_HOLIDAYS[d] : null;
  }

  /** True when the holiday list contains the year of this date. */
  function isCalendarCovered(x) {
    const d = istDateStr(x);
    return !!d && COVERED_YEARS.indexOf(Number(d.slice(0, 4))) >= 0;
  }

  /** Monday-Friday (IST) and not an NSE holiday. Years outside the list only skip weekends. */
  function isTradingDay(x) {
    const d = istDateStr(x);
    if (!d) return false;
    const wd = weekdayOf(d);
    if (wd === 0 || wd === 6) return false;
    return !holidayName(d);
  }

  /**
   * NSE equity session state at `now` (IST):
   *   'weekend'  Saturday / Sunday
   *   'holiday'  weekday NSE holiday
   *   'pre-open' 09:00:00 - 09:14:59 on a trading day
   *   'open'     09:15:00 - 15:30:00 on a trading day (close inclusive)
   *   'closed'   any other time on a trading day
   * Returns null for an invalid `now`.
   */
  function sessionState(now) {
    const p = istParts(now);
    if (!p) return null;
    if (p.wd === 0 || p.wd === 6) return 'weekend';
    const d = p.y + '-' + pad2(p.m) + '-' + pad2(p.d);
    if (holidayName(d)) return 'holiday';
    if (p.secs >= OPEN_START && p.secs <= CLOSE) return 'open';
    if (p.secs >= PRE_OPEN_START && p.secs < OPEN_START) return 'pre-open';
    return 'closed';
  }

  /** True while the normal market is open. */
  function isSessionOpen(now) { return sessionState(now) === 'open'; }

  /**
   * 'YYYY-MM-DD' of the latest trading day whose session has ended by `now`:
   * today after 15:30 IST on a trading day, otherwise the previous trading day.
   */
  function lastCompletedSession(now) {
    const p = istParts(now);
    if (!p) return null;
    let d = p.y + '-' + pad2(p.m) + '-' + pad2(p.d);
    if (!(isTradingDay(d) && p.secs > CLOSE)) d = addDays(d, -1);
    for (let i = 0; i < 30 && d; i++) {
      if (isTradingDay(d)) return d;
      d = addDays(d, -1);
    }
    return null;
  }

  /** 'YYYY-MM-DD' of the first trading day strictly after the given date. */
  function nextTradingDay(x) {
    let d = istDateStr(x);
    for (let i = 0; i < 30 && d; i++) {
      d = addDays(d, 1);
      if (d && isTradingDay(d)) return d;
    }
    return null;
  }

  /** Epoch ms of the session close (15:30 IST) of a 'YYYY-MM-DD' date. */
  function sessionCloseMs(dateStr) {
    const ms = parseIstDateTime(dateStr);
    return ms === null ? null : ms + CLOSE * 1000;
  }

  module.exports = {
    IST_OFFSET_MS: IST_OFFSET_MS,
    SESSION: { preOpen: '09:00', open: '09:15', close: '15:30' },
    NSE_HOLIDAYS: NSE_HOLIDAYS,
    COVERED_YEARS: COVERED_YEARS,
    parseIstDateTime: parseIstDateTime,
    istParts: istParts,
    istDateStr: istDateStr,
    istDateTimeStr: istDateTimeStr,
    addDays: addDays,
    weekdayOf: weekdayOf,
    holidayName: holidayName,
    isCalendarCovered: isCalendarCovered,
    isTradingDay: isTradingDay,
    sessionState: sessionState,
    isSessionOpen: isSessionOpen,
    lastCompletedSession: lastCompletedSession,
    nextTradingDay: nextTradingDay,
    sessionCloseMs: sessionCloseMs
  };
})();
