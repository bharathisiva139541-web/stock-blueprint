/* Fake Apps Script environment for Node tests: loads Code.gs into a `vm`
 * context with just enough of SpreadsheetApp, PropertiesService, Utilities,
 * ContentService, LockService, ... to run its doPost / feed functions.
 * No network: UrlFetchApp throws, mail is only recorded.
 *
 *   const mock = require('./fixtures/apps-script-mock');
 *   const env = mock.loadCodeGs({ sheets: [{ name, rows, numFmts }] }, { props: { AB_FEED_TOKEN: 't' } });
 *   env.post({ token: 't', action: 'site', part: 'main' })   -> parsed JSON reply of doPost
 *   env.call('ab_site_textDate_', '21-Aug-2026')             -> any Code.gs function
 *   env.run('AB_TZ')                                         -> evaluate in the Code.gs scope
 *   env.reads (getSheetByName names) / env.ranges (cells read: {sheet, kind, row, col, rows, cols})
 *   env.writes / env.mails / env.alerts / env.calls          -> what Code.gs tried to do
 *   env.sheet(name)                                           -> a tab's cells (values written by setValues
 *                                                                read back by getValues), or null
 *   env.triggers ([{ id, handler, everyMinutes, ... }])       -> installed triggers (ScriptApp.newTrigger)
 *   env.props                                                 -> the Script Properties store
 *   env.setNow(ms) (with opts.now)                            -> move the frozen clock
 *   env.onRead = function (range) {...}                       -> called on every getValues (tests move the clock)
 *
 * Workbook = the shape web/lib/xlsx-reader.js returns ({ sheets: [{ name, rows,
 * numFmts }] }), so a real .xlsx can be fed in. null cells read as '' (like
 * getValues). Cells with a date / time number format that hold ISO text
 * ('YYYY-MM-DD', 'YYYY-MM-DD HH:MM', 'HH:MM') become Date objects of that
 * wall-clock time in the spreadsheet's zone (Asia/Kolkata, UTC+05:30), as
 * Apps Script returns them; time-only values sit on 1899-12-30 like Sheets
 * serials. JS Date cells are copied into the vm realm (instanceof works).
 * Unknown service methods are harmless no-ops (recorded in env.calls).
 * Tabs made by insertSheet have Sheets' default size (1000 x 26) and refuse
 * ranges outside it (insertRowsAfter / deleteColumns change it); workbook
 * tabs grow as needed.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const xlsx = require('../../web/lib/xlsx-reader.js');

const CODE_GS = path.join(__dirname, '..', '..', 'Code.gs');
const FIXED_OFFSETS = { 'Asia/Kolkata': 330, 'Asia/Calcutta': 330, UTC: 0, GMT: 0, 'Etc/UTC': 0, 'Etc/GMT': 0 };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function pad(n, w) { let s = String(Math.abs(n)); while (s.length < w) s = '0' + s; return (n < 0 ? '-' : '') + s; }

/** Wall-clock fields of `ms` in time zone `tz` (fixed offset for IST / UTC, Intl otherwise). */
function wallClock(ms, tz) {
  const off = Object.prototype.hasOwnProperty.call(FIXED_OFFSETS, tz) ? FIXED_OFFSETS[tz] : null;
  if (off !== null) {
    const d = new Date(ms + off * 60000);
    return { y: d.getUTCFullYear(), M: d.getUTCMonth() + 1, d: d.getUTCDate(), H: d.getUTCHours(),
             m: d.getUTCMinutes(), s: d.getUTCSeconds(), S: d.getUTCMilliseconds(), wd: d.getUTCDay(), off: off };
  }
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
  const w = { y: +p.year, M: +p.month, d: +p.day, H: +p.hour % 24, m: +p.minute, s: +p.second,
              S: ((ms % 1000) + 1000) % 1000, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
  w.off = Math.round((Date.UTC(w.y, w.M - 1, w.d, w.H, w.m, w.s) - (ms - w.S)) / 60000);
  return w;
}

/** Utilities.formatDate: the SimpleDateFormat letters Code.gs uses (y M d H h m s S E u a Z, 'quoted'). */
function formatDate(date, tz, pattern) {
  const w = wallClock(date.getTime(), tz || 'Asia/Kolkata');
  let out = '';
  for (let i = 0; i < pattern.length;) {
    const ch = pattern[i];
    if (ch === "'") {
      const j = pattern.indexOf("'", i + 1);
      const lit = pattern.slice(i + 1, j === -1 ? pattern.length : j);
      out += lit === '' ? "'" : lit;
      i = j === -1 ? pattern.length : j + 1;
      continue;
    }
    if (!/[A-Za-z]/.test(ch)) { out += ch; i++; continue; }
    let n = 1;
    while (pattern[i + n] === ch) n++;
    i += n;
    switch (ch) {
      case 'y': out += n === 2 ? pad(w.y % 100, 2) : pad(w.y, n); break;
      case 'M': out += n >= 4 ? MONTHS[w.M - 1] : n === 3 ? MONTHS[w.M - 1].slice(0, 3) : pad(w.M, n); break;
      case 'd': out += pad(w.d, n); break;
      case 'H': out += pad(w.H, n); break;
      case 'h': out += pad(w.H % 12 || 12, n); break;
      case 'm': out += pad(w.m, n); break;
      case 's': out += pad(w.s, n); break;
      case 'S': out += pad(w.S, Math.max(n, 3)).slice(0, n); break;
      case 'E': out += n >= 4 ? DAYS[w.wd] : DAYS[w.wd].slice(0, 3); break;
      case 'u': out += String(w.wd === 0 ? 7 : w.wd); break;
      case 'a': out += w.H < 12 ? 'AM' : 'PM'; break;
      case 'Z': out += (w.off < 0 ? '-' : '+') + pad(Math.floor(Math.abs(w.off) / 60), 2) + pad(Math.abs(w.off) % 60, 2); break;
      default: throw new Error('formatDate mock: unsupported pattern letter ' + ch);
    }
  }
  return out;
}

/** Proxy: known members as they are, anything else a recorded no-op (setters chain). */
function makeLenient(name, target, calls) {
  let proxy = null;
  proxy = new Proxy(target, {
    get: function (t, prop) {
      if (typeof prop === 'symbol' || prop in t) return t[prop];
      if (prop === 'then' || prop === 'toJSON' || prop === 'inspect' || prop === 'constructor') return undefined;
      return function () {
        calls.push(name + '.' + String(prop));
        return /^(get|is|has|can)[A-Z]/.test(String(prop)) ? null : proxy;
      };
    }
  });
  return proxy;
}

function a1ToRange(a1) {
  const m = /^\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/i.exec(String(a1).trim());
  if (!m) throw new Error('getRange mock: unsupported A1 notation ' + a1);
  const c0 = xlsx.lettersToCol(m[1].toUpperCase()) + 1, r0 = Number(m[2]);   // lettersToCol is 0-based
  const c1 = m[3] ? xlsx.lettersToCol(m[3].toUpperCase()) + 1 : c0, r1 = m[4] ? Number(m[4]) : r0;
  return [Math.min(r0, r1), Math.min(c0, c1), Math.abs(r1 - r0) + 1, Math.abs(c1 - c0) + 1];
}

/**
 * Build the fake services for `workbook` inside vm context `ctx`.
 * opts: { tz ('Asia/Kolkata'), props: {key: value}, lockBusy, now: Date|ms (frozen clock, env.setNow moves it),
 *         triggers: ['handlerName', ...] (already installed) }
 */
function createEnv(workbook, opts) {
  opts = opts || {};
  const ctx = vm.createContext({});
  const RealmDate = vm.runInContext('Date', ctx);
  const tz = opts.tz || 'Asia/Kolkata';
  const env = { context: ctx, writes: [], reads: [], ranges: [], mails: [], alerts: [], calls: [], logs: [], tz: tz,
                triggers: [], onRead: null };

  const tabs = {};   // name -> { grid, size, hidden() } for env.sheet

  // ---- cells -> Apps Script values (in the vm realm)
  const OFF = Object.prototype.hasOwnProperty.call(FIXED_OFFSETS, tz) ? FIXED_OFFSETS[tz] : 330;
  function wallToDate(y, mo, d, h, mi) { return new RealmDate(Date.UTC(y, mo - 1, d, h, mi) - OFF * 60000); }
  function toCell(v, fmt) {
    if (v === null || v === undefined) return '';
    if (Object.prototype.toString.call(v) === '[object Date]') return new RealmDate(v.getTime());
    if (typeof v === 'string' && fmt && xlsx.isDateFormat(fmt)) {
      let m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/.exec(v);
      if (m) return wallToDate(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0));
      m = /^(\d{1,4}):(\d{2})$/.exec(v);          // time-only / [h]:mm: offset from the 1899-12-30 epoch
      if (m) return wallToDate(1899, 12, 30, +m[1], +m[2]);
    }
    return v;
  }

  function makeSheet(spec) {
    const fmts = spec.numFmts || [];
    const grid = (spec.rows || []).map(function (r, i) {
      return (r || []).map(function (v, j) { return toCell(v, fmts[i] && fmts[i][j]); });
    });
    // inserted tabs have a fixed size like Sheets (1000 x 26); workbook tabs grow as needed
    const size = spec.size ? { rows: spec.size.rows, cols: spec.size.cols } : null;
    let hidden = !!spec.hidden;
    tabs[spec.name] = { grid: grid, size: size, hidden: function () { return hidden; } };
    function lastRow() {
      for (let r = grid.length - 1; r >= 0; r--) if (grid[r].some(function (v) { return v !== ''; })) return r + 1;
      return 0;
    }
    function lastCol() {
      let w = 0;
      grid.forEach(function (r) { for (let c = r.length - 1; c >= w; c--) if (r[c] !== '') { w = c + 1; break; } });
      return w;
    }
    function cell(r, c) { return grid[r] && grid[r][c] !== undefined ? grid[r][c] : ''; }
    function fmtOf(r, c) { return (fmts[r] && fmts[r][c]) || 'General'; }
    let sheet = null;
    function makeRange(row, col, nr, nc) {
      if (!(row >= 1 && col >= 1 && nr >= 1 && nc >= 1)) throw new Error('Range mock: bad coordinates ' + [row, col, nr, nc].join(','));
      if (size && (row + nr - 1 > size.rows || col + nc - 1 > size.cols)) {
        throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
      }
      function grid2(f) {
        const out = [];
        for (let r = 0; r < nr; r++) {
          const line = [];
          for (let c = 0; c < nc; c++) line.push(f(row - 1 + r, col - 1 + c));
          out.push(line);
        }
        return out;
      }
      function copy(v) { return v instanceof RealmDate ? new RealmDate(v.getTime()) : v; }
      function seen(kind) {
        const g = { sheet: spec.name, kind: kind, row: row, col: col, rows: nr, cols: nc };
        env.ranges.push(g);
        if (typeof env.onRead === 'function') env.onRead(g);
      }
      function write(kind, vals) {
        env.writes.push({ sheet: spec.name, kind: kind, row: row, col: col });
        if (kind !== 'values') return;
        vals.forEach(function (line, r) {
          line.forEach(function (v, c) {
            const R = row - 1 + r, C = col - 1 + c;
            while (grid.length <= R) grid.push([]);
            grid[R][C] = toCell(v, null);
          });
        });
      }
      const range = {
        getValues: function () { seen('values'); return grid2(function (r, c) { return copy(cell(r, c)); }); },
        getValue: function () { seen('values'); return copy(cell(row - 1, col - 1)); },
        getDisplayValues: function () {
          seen('values');
          return grid2(function (r, c) {
            const v = cell(r, c);
            return v instanceof RealmDate ? formatDate(v, tz, 'dd/MM/yyyy') : typeof v === 'boolean' ? String(v).toUpperCase() : String(v);
          });
        },
        getDisplayValue: function () { return range.getDisplayValues()[0][0]; },
        getNumberFormats: function () { seen('formats'); return grid2(fmtOf); },
        getNumberFormat: function () { return fmtOf(row - 1, col - 1); },
        getFormulas: function () { return grid2(function () { return ''; }); },
        getFormula: function () { return ''; },
        getRow: function () { return row; },
        getColumn: function () { return col; },
        getNumRows: function () { return nr; },
        getNumColumns: function () { return nc; },
        getLastRow: function () { return row + nr - 1; },
        getLastColumn: function () { return col + nc - 1; },
        getA1Notation: function () {
          const a = xlsx.colToLetters(col - 1) + row;
          return nr === 1 && nc === 1 ? a : a + ':' + xlsx.colToLetters(col + nc - 2) + (row + nr - 1);
        },
        getSheet: function () { return sheet; },
        setValues: function (v) { write('values', v); return proxyRange; },
        setValue: function (v) { write('values', [[v]]); return proxyRange; },
        setFormula: function () { write('formula'); return proxyRange; },
        setFormulas: function () { write('formula'); return proxyRange; },
        setNumberFormat: function () { write('format'); return proxyRange; },
        setNumberFormats: function () { write('format'); return proxyRange; },
        clear: function () { write('clear'); return proxyRange; },
        clearContent: function () { write('clear'); return proxyRange; }
      };
      const proxyRange = makeLenient('Range', range, env.calls);
      return proxyRange;
    }
    const sh = {
      getName: function () { return spec.name; },
      getSheetName: function () { return spec.name; },
      getLastRow: lastRow,
      getLastColumn: lastCol,
      getMaxRows: function () { return size ? size.rows : Math.max(grid.length, 1); },
      getMaxColumns: function () { return size ? size.cols : Math.max(lastCol(), 1); },
      insertRowsAfter: function (after, n) {
        env.writes.push({ sheet: spec.name, kind: 'insertRows', row: after + 1, col: 1 });
        if (size) size.rows += n;
        grid.splice.apply(grid, [Math.min(after, grid.length), 0].concat(Array.from({ length: n }, function () { return []; })));
        return sheet;
      },
      deleteColumns: function (from, n) {
        env.writes.push({ sheet: spec.name, kind: 'deleteColumns', row: 1, col: from });
        if (size) size.cols -= n;
        grid.forEach(function (r) { r.splice(from - 1, n); });
        return sheet;
      },
      clear: function () { grid.length = 0; env.writes.push({ sheet: spec.name, kind: 'clear', row: 1, col: 1 }); return sheet; },
      hideSheet: function () { hidden = true; return sheet; },
      showSheet: function () { hidden = false; return sheet; },
      activate: function () { active = sheet; return sheet; },
      getDataRange: function () { return makeRange(1, 1, Math.max(lastRow(), 1), Math.max(lastCol(), 1)); },
      getRange: function (a, b, c, d) {
        if (typeof a === 'string') { const g = a1ToRange(a); return makeRange(g[0], g[1], g[2], g[3]); }
        return makeRange(a, b, c === undefined ? 1 : c, d === undefined ? 1 : d);
      },
      getFrozenRows: function () { return 0; },
      isSheetHidden: function () { return hidden; },
      getSheetId: function () { return spec.id || 0; },
      getParent: function () { return ss; }
    };
    sheet = makeLenient('Sheet', sh, env.calls);
    return sheet;
  }

  const sheets = (workbook && workbook.sheets || []).map(makeSheet);
  let active = sheets[0] || null;
  const ss = makeLenient('Spreadsheet', {
    getSheetByName: function (n) {
      env.reads.push(n);
      for (let i = 0; i < sheets.length; i++) if (sheets[i].getName() === n) return sheets[i];
      return null;
    },
    getSheets: function () { return sheets.slice(); },
    getNumSheets: function () { return sheets.length; },
    getActiveSheet: function () { return active; },
    setActiveSheet: function (sh) { active = sh; return sh; },
    insertSheet: function (name, index) {
      if (typeof name !== 'string') throw new Error('insertSheet mock: give the tab a name');
      if (sheets.some(function (x) { return x.getName() === name; })) {
        throw new Error('A sheet with the name "' + name + '" already exists. Please enter another name.');
      }
      const sh = makeSheet({ name: name, rows: [], size: { rows: 1000, cols: 26 } });
      sheets.splice(index === undefined ? sheets.length : Math.max(0, Math.min(index, sheets.length)), 0, sh);
      env.writes.push({ sheet: name, kind: 'insertSheet', row: 1, col: 1 });
      active = sh;                                   // like Sheets: the new tab becomes the active one
      return sh;
    },
    deleteSheet: function (sh) {
      const i = sheets.indexOf(sh);
      if (i === -1) throw new Error('deleteSheet mock: not a tab of this spreadsheet');
      sheets.splice(i, 1);
      env.writes.push({ sheet: sh.getName(), kind: 'deleteSheet', row: 1, col: 1 });
      if (active === sh) active = sheets[0] || null;
    },
    getSpreadsheetTimeZone: function () { return tz; },
    getName: function () { return 'Mock workbook'; },
    getId: function () { return 'mock-spreadsheet-id'; },
    getUrl: function () { return 'https://docs.google.com/spreadsheets/d/mock'; },
    toast: function () { /* no UI */ }
  }, env.calls);

  function store(initial) {
    const data = Object.assign({}, initial || {});
    return makeLenient('Properties', {
      getProperty: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? String(data[k]) : null; },
      setProperty: function (k, v) { data[k] = String(v); return this; },
      deleteProperty: function (k) { delete data[k]; return this; },
      getProperties: function () { return Object.assign({}, data); },
      setProperties: function (o) { Object.keys(o || {}).forEach(function (k) { data[k] = String(o[k]); }); return this; },
      getKeys: function () { return Object.keys(data); },
      deleteAllProperties: function () { Object.keys(data).forEach(function (k) { delete data[k]; }); return this; }
    }, env.calls);
  }
  const scriptProps = store(opts.props), userProps = store(), docProps = store();
  env.props = scriptProps;

  const ui = makeLenient('Ui', {
    alert: function () { env.alerts.push(Array.prototype.slice.call(arguments).filter(function (a) { return typeof a === 'string'; })); return 'OK'; },
    ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO', YES_NO_CANCEL: 'YES_NO_CANCEL' },
    Button: { OK: 'OK', CANCEL: 'CANCEL', YES: 'YES', NO: 'NO', CLOSE: 'CLOSE' }
  }, env.calls);

  function cacheStore() {
    const m = {};
    return makeLenient('Cache', {
      get: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
      put: function (k, v) { m[k] = String(v); },
      remove: function (k) { delete m[k]; },
      getAll: function (ks) { const o = {}; (ks || []).forEach(function (k) { if (k in m) o[k] = m[k]; }); return o; },
      putAll: function (o) { Object.keys(o || {}).forEach(function (k) { m[k] = String(o[k]); }); },
      removeAll: function (ks) { (ks || []).forEach(function (k) { delete m[k]; }); }
    }, env.calls);
  }

  // ---- triggers: ScriptApp.newTrigger(fn).timeBased().everyMinutes(n).create() ...
  let triggerSeq = 0;
  function addTrigger(t) { t.id = 'trigger-' + (++triggerSeq); env.triggers.push(t); return t; }
  (opts.triggers || []).forEach(function (h) { addTrigger({ handler: h, kind: 'CLOCK' }); });
  function triggerObj(t) {
    return {
      getHandlerFunction: function () { return t.handler; },
      getUniqueId: function () { return t.id; },
      getEventType: function () { return t.kind; },
      getTriggerSource: function () { return 'CLOCK'; }
    };
  }
  function triggerBuilder(handler) {
    const t = { handler: String(handler), kind: 'CLOCK' };
    const b = {
      timeBased: function () { return b; },
      everyMinutes: function (n) {
        if ([1, 5, 10, 15, 30].indexOf(n) === -1) throw new Error('everyMinutes mock: Apps Script allows 1, 5, 10, 15 or 30');
        t.everyMinutes = n; return b;
      },
      everyHours: function (n) { t.everyHours = n; return b; },
      everyDays: function (n) { t.everyDays = n; return b; },
      everyWeeks: function (n) { t.everyWeeks = n; return b; },
      onWeekDay: function (d) { t.weekDay = d; return b; },
      atHour: function (h) { t.atHour = h; return b; },
      nearMinute: function (m) { t.nearMinute = m; return b; },
      inTimezone: function (z) { t.tz = z; return b; },
      after: function (ms) { t.after = ms; return b; },
      at: function (d) { t.at = d; return b; },
      create: function () { return triggerObj(addTrigger(t)); }
    };
    return b;
  }

  const lock = makeLenient('Lock', {
    tryLock: function () { return !opts.lockBusy; },
    waitLock: function () { if (opts.lockBusy) throw new Error('Lock timeout'); },
    releaseLock: function () { /* nothing held */ },
    hasLock: function () { return !opts.lockBusy; }
  }, env.calls);

  const globals = {
    SpreadsheetApp: makeLenient('SpreadsheetApp', {
      getActiveSpreadsheet: function () { return ss; },
      getActive: function () { return ss; },
      openById: function () { return ss; },
      getUi: function () { return ui; },
      flush: function () { /* nothing pending */ }
    }, env.calls),
    PropertiesService: makeLenient('PropertiesService', {
      getScriptProperties: function () { return scriptProps; },
      getUserProperties: function () { return userProps; },
      getDocumentProperties: function () { return docProps; }
    }, env.calls),
    CacheService: makeLenient('CacheService', {
      getScriptCache: cacheStore, getUserCache: cacheStore, getDocumentCache: cacheStore
    }, env.calls),
    Utilities: makeLenient('Utilities', {
      formatDate: function (d, zone, pattern) { return formatDate(d, zone, pattern); },
      getUuid: function () { return crypto.randomUUID(); },
      sleep: function () { /* no waiting in tests */ },
      base64Encode: function (s) { return Buffer.from(String(s)).toString('base64'); },
      base64Decode: function (s) { return Array.from(Buffer.from(String(s), 'base64')); }
    }, env.calls),
    ContentService: makeLenient('ContentService', {
      MimeType: { JSON: 'application/json', TEXT: 'text/plain', CSV: 'text/csv', JAVASCRIPT: 'application/javascript' },
      createTextOutput: function (text) {
        const out = {
          content: text === undefined ? '' : String(text), mimeType: 'text/plain',
          setMimeType: function (m) { out.mimeType = m; return out; },
          getMimeType: function () { return out.mimeType; },
          getContent: function () { return out.content; },
          setContent: function (s) { out.content = String(s); return out; },
          append: function (s) { out.content += String(s); return out; }
        };
        return out;
      }
    }, env.calls),
    LockService: makeLenient('LockService', {
      getScriptLock: function () { return lock; }, getDocumentLock: function () { return lock; }, getUserLock: function () { return lock; }
    }, env.calls),
    Logger: makeLenient('Logger', { log: function () { env.logs.push(Array.prototype.slice.call(arguments).join(' ')); } }, env.calls),
    Session: makeLenient('Session', {
      getScriptTimeZone: function () { return tz; },
      getActiveUser: function () { return { getEmail: function () { return ''; } }; },
      getEffectiveUser: function () { return { getEmail: function () { return ''; } }; }
    }, env.calls),
    MailApp: makeLenient('MailApp', {
      sendEmail: function () { env.mails.push(Array.prototype.slice.call(arguments)); },
      getRemainingDailyQuota: function () { return 100; }
    }, env.calls),
    GmailApp: makeLenient('GmailApp', { sendEmail: function () { env.mails.push(Array.prototype.slice.call(arguments)); } }, env.calls),
    UrlFetchApp: makeLenient('UrlFetchApp', {
      fetch: function () { throw new Error('UrlFetchApp is disabled in tests (no network)'); },
      fetchAll: function () { throw new Error('UrlFetchApp is disabled in tests (no network)'); }
    }, env.calls),
    ScriptApp: makeLenient('ScriptApp', {
      getService: function () { return { getUrl: function () { return ''; } }; },
      getProjectTriggers: function () { env.triggerReads = (env.triggerReads || 0) + 1; return env.triggers.map(triggerObj); },
      deleteTrigger: function (t) {
        const id = t && t.getUniqueId ? t.getUniqueId() : null;
        const i = env.triggers.findIndex(function (x) { return x.id === id; });
        if (i === -1) throw new Error('deleteTrigger mock: no such trigger');
        env.triggers.splice(i, 1);
      },
      newTrigger: function (handler) { return triggerBuilder(handler); },
      AuthMode: { FULL: 'FULL', LIMITED: 'LIMITED', NONE: 'NONE' },
      EventType: { CLOCK: 'CLOCK', ON_OPEN: 'ON_OPEN', ON_EDIT: 'ON_EDIT' }
    }, env.calls),
    HtmlService: makeLenient('HtmlService', {}, env.calls),
    DriveApp: makeLenient('DriveApp', {}, env.calls),
    console: {
      log: function () { env.logs.push(Array.prototype.slice.call(arguments).join(' ')); },
      info: function () { env.logs.push(Array.prototype.slice.call(arguments).join(' ')); },
      warn: function () { env.logs.push(Array.prototype.slice.call(arguments).join(' ')); },
      error: function () { env.logs.push(Array.prototype.slice.call(arguments).join(' ')); }
    }
  };
  Object.keys(globals).forEach(function (k) { ctx[k] = globals[k]; });

  if (opts.now !== undefined) {
    // frozen clock: new Date() / Date.now() return clock.t inside Code.gs; env.setNow(ms) moves it
    const clock = { t: typeof opts.now === 'number' ? opts.now : opts.now.getTime() };
    vm.runInContext('(function (clock) { const D = Date; function F(...a) { return a.length ? new D(...a) : new D(clock.t); }' +
      ' F.prototype = D.prototype; F.now = function () { return clock.t; }; F.UTC = D.UTC; F.parse = D.parse; Date = F; })', ctx)(clock);
    env.setNow = function (ms) { clock.t = typeof ms === 'number' ? ms : ms.getTime(); };
    env.now = function () { return clock.t; };
  } else {
    env.setNow = function () { throw new Error('env.setNow needs opts.now (a frozen clock)'); };
    env.now = function () { return Date.now(); };
  }
  env.Date = vm.runInContext('Date', ctx);

  /** A tab's cells as Code.gs left them ([] rows of values; '' = empty), its size and hidden flag, or null. */
  env.sheet = function (name) {
    const t = tabs[name];
    if (!t || !sheets.some(function (x) { return x.getName() === name; })) return null;
    return { rows: t.grid, size: t.size, hidden: t.hidden() };
  };
  return env;
}

/** createEnv + run Code.gs in it. Adds env.call / env.run / env.post. */
function loadCodeGs(workbook, opts) {
  const env = createEnv(workbook, opts);
  const code = (opts && opts.code) || fs.readFileSync(CODE_GS, 'utf8');
  vm.runInContext(code, env.context, { filename: 'Code.gs' });
  env.run = function (src) { return vm.runInContext(src, env.context); };
  env.call = function (name) {
    const fn = env.context[name];
    if (typeof fn !== 'function') throw new Error('Code.gs has no function ' + name);
    return fn.apply(null, Array.prototype.slice.call(arguments, 1));
  };
  /** doPost with a JSON body; returns the parsed JSON reply. */
  env.post = function (body) {
    const out = env.call('doPost', { postData: { contents: JSON.stringify(body), type: 'application/json' } });
    env.lastOutput = out;
    return JSON.parse(out.getContent());
  };
  return env;
}

module.exports = { createEnv: createEnv, loadCodeGs: loadCodeGs, formatDate: formatDate, CODE_GS: CODE_GS };
