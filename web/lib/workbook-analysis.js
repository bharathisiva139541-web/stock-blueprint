/*
 * workbook-analysis.js - per-worksheet structure + data-quality profile.
 *
 *   window.SB.workbookAnalysis.analyzeWorkbook(wb, opts)  // wb = SB.xlsx.readWorkbook() result
 *   window.SB.workbookAnalysis.analyzeSheet(sheet, opts)
 *   window.SB.workbookAnalysis.buildMaster(sheet)          // SYMBOL -> { sector, industry, basicIndustry, name }
 *   window.SB.workbookAnalysis.toCsv(rows, opts)           // RFC 4180
 *
 * opts: { master: { SYMBOL: { sector, industry, basicIndustry } } | Map,
 *         publicMode: false, maxSamples: 5, maxDistinct: 30, maxList: 30, headerScanRows: 12 }
 *
 * Every result is plain JSON. Row numbers are 1-based Excel rows; column
 * `index` is 0-based with its Excel `letter`. Percent values are percent
 * numbers (fillPct 95.5 = 95.5 %). Never throws on bad input: returns
 * { ok: false, reason }.
 *
 * Privacy (publicMode): sheets detected as personal (portfolio / trades /
 * capital / e-mails ...) keep only their structure - names, counts, headers,
 * types - with no values, samples, titles, formulas or lists. On other
 * sheets, personal-looking columns (entry price, stoploss, qty, capital,
 * P&L ...) and rows typed 'Entry'/'Position'/'Trade' are left out of every
 * value-revealing field, and any e-mail address left in a string is masked.
 *
 * System tabs (the script's own storage: 'Site_Feed' = the website feed's
 * stored JSON in 45,000-character cells, 'Site_Watchlists' = the viewer's
 * PIN-protected My Watchlists, same layout) are structure only in every
 * mode: counts and types, no samples, values, titles or header text
 * (result.system = true).
 */
(function (/** @type {any} */ root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.SB = root.SB || {}; root.SB.workbookAnalysis = factory(); }
})(/** @type {any} */ (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  var ERROR_RE = /^#(N\/A|DIV\/0!|REF!|VALUE!|NAME\?|NUM!|NULL!|ERROR!|SPILL!|CALC!|GETTING_DATA|FIELD!|BLOCKED!|CONNECT!|BUSY!|UNKNOWN!)/;
  var LOADING_RE = /^Loading\.\.\.$/;
  var ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/;
  var TIME_RE = /^\d{1,2}:\d{2}(:\d{2})?$/;
  var TEXT_DATE_RE = /^(\d{1,2}[\/\-. ](\d{1,2}|[A-Za-z]{3,9})[\/\-. ]\d{2,4}|[A-Za-z]{3,9} \d{1,2},? \d{4}|\d{4}\/\d{1,2}\/\d{1,2})( \d{1,2}:\d{2}(:\d{2})?)?$/;
  var NUM_TEXT_RE = /^[+\-]?(\d{1,3}(,\d{2,3})+|\d+)?(\.\d+)?([eE][+\-]?\d+)?%?$/;
  var EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}/;
  var EMAIL_RE_G = new RegExp(EMAIL_RE.source, 'g');

  var SYMBOL_HEADER_RES = [/^(nse )?symbol$/i, /^ticker$/i, /nse ticker/i, /^stock$/i];
  var SYMBOL_TOKEN_RE = /^[A-Z0-9&\-]{1,20}$/;
  var VALID_SYMBOL_RE = /^[A-Z0-9&_\-]{1,20}$/;
  var NAME_HEADER_RE = /company|stockname|name/i;
  var SECTOR_HEADER_RE = /sector/i;
  var INDUSTRY_HEADER_RE = /industry/i;
  var BASIC_INDUSTRY_RE = /basic\s*industry/i;
  var STRATEGY_RE = /signal|buy|sell|avoid|target|stop|entry|pattern|fvg|\bema\b|\brsi\b|\bpeg\b|upside|score/gi;
  var PRICE_HEADER_RE = /price|^ltp$|^cmp$|\bclose\b|\bopen\b|\bhigh\b|\blow\b|clspric|opnpric|hghpric|lwpric|stop\s*-?\s*loss|target/i;
  var NOT_PRICE_RE = /%|change|chg|band|date|time|source|type|signal|y\/n|ratio|drop|down|\bup\b|\bfrom\b|gain|loss %|return|diff|vs\b|count|vol|median|avg|average|mean/i;
  var NOT_SYMBOL_HEADER_RE = /index|series|type|status|signal|zone|pattern|category|source|sector|industry|flag|alerted|y\/n|verdict|quarter|season|outcome|colou?r/i;
  var PERSONAL_SHEET_RE = /portfolio|risk manager|control panel|trade log|trade dashboard|alert log|alert dashboard|entry alerts?/i;
  var PERSONAL_HEADER_RE = /\b(qty|quantity)\b|\bbuy value\b|\bsell value\b|^(profit|loss|p\s*&\s*l|pnl)\b|\bprofit\s*[\/&]\s*loss\b|\bcapital\b|\binvested\b/i;
  // columns whose VALUES are the owner's own levels/trades (alert levels, triggers,
  // outcomes too: they reveal positions) - public mode keeps only their structure
  var PERSONAL_COLUMN_RE = /entry|stop\s*-?\s*loss|exit price|\b(qty|quantity)\b|capital|invested|buy value|sell value|buy price|sell price|avg (buy )?price|profit\s*[\/&]\s*loss|p\s*&\s*l|\bpnl\b|alert (price|level)|trigger(ed)?|after alert|since alert|win\s*\/\s*loss|^outcome$/i;
  var NOT_PERSONAL_HEADER_RE = /working capital|share capital|equity capital|capital (goods|employed|markets?)/i;
  var TYPE_HEADER_RE = /\btype\b/i;
  var PRIVATE_ROW_VALUE_RE = /^(entry|position|holding|trade)$/i;
  // tabs Code.gs keeps for itself: the website feed's stored copy (cells of raw JSON text)
  var SYSTEM_SHEET_RE = /^(site_feed|site_watchlists)$/i;
  var HEADER_WORD_RE = /(^|[^a-z])(symbol|ticker|name|company|date|time|price|open|high|low|close|volume|vol|sector|industry|type|status|qty|value|signal|pattern|index|count|total|change|avg|score|level|zone|source|series|notes?|remarks?|setting|key|description)($|[^a-z])|%/i;

  var DEFAULTS = { maxSamples: 5, maxDistinct: 30, maxList: 30, headerScanRows: 12, maxTrackDistinct: 20000 };

  // ---------------------------------------------------------------- helpers

  function isBlank(v) { return v == null || (typeof v === 'string' && v.trim() === ''); }
  function isErrorValue(v) { return typeof v === 'string' && (v.charCodeAt(0) === 35 ? ERROR_RE.test(v) : LOADING_RE.test(v)); }

  /** 'blank' | 'error' | 'bool' | 'number' | 'date' | 'text' */
  function cellKind(v) {
    if (v == null) return 'blank';
    var t = typeof v;
    if (t === 'number') return isFinite(v) ? 'number' : 'error';
    if (t === 'boolean') return 'bool';
    if (t !== 'string') return 'text';
    var s = v.trim();
    if (s === '') return 'blank';
    if (isErrorValue(s)) return 'error';
    if (ISO_DATE_RE.test(s)) return 'date';
    return 'text';
  }

  /** Text that would be a good header cell (not a number, date or error written as text). */
  function isHeaderText(v) {
    if (typeof v !== 'string') return false;
    var s = v.trim();
    if (!s || s.length > 80 || isErrorValue(s) || ISO_DATE_RE.test(s) || TIME_RE.test(s)) return false;
    if (NUM_TEXT_RE.test(s.replace(/\s/g, '')) && /\d/.test(s)) return false;
    if (TEXT_DATE_RE.test(s)) return false;
    return true;
  }

  function colLetter(c) {
    var s = '';
    c = c + 1;
    while (c > 0) { var m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); }
    return s;
  }

  function parseRange(ref) {
    var m = /^\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?$/.exec(String(ref || '').trim());
    if (!m) return null;
    function col(s) { var c = 0; s = s.toUpperCase(); for (var i = 0; i < s.length; i++) c = c * 26 + (s.charCodeAt(i) - 64); return c - 1; }
    var c0 = col(m[1]), r0 = +m[2] - 1, c1 = m[3] ? col(m[3]) : c0, r1 = m[4] ? +m[4] - 1 : r0;
    return { r0: Math.min(r0, r1), r1: Math.max(r0, r1), c0: Math.min(c0, c1), c1: Math.max(c0, c1) };
  }

  function round(x, d) {
    if (typeof x !== 'number' || !isFinite(x)) return null;
    var p = Math.pow(10, d == null ? 4 : d);
    return Math.round(x * p) / p;
  }

  function pct(n, d) { return d > 0 ? round(100 * n / d, 1) : 0; }

  function clip(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function sampleValue(v) { return typeof v === 'string' ? clip(v.trim(), 80) : v; }

  function cleanHeader(v) {
    if (v == null || typeof v === 'boolean') return null;
    var s = String(v).replace(/\s+/g, ' ').trim();
    return s === '' ? null : clip(s, 80);
  }

  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function normalizeSymbol(v) {
    if (v == null) return '';
    var s = String(v).trim().toUpperCase().replace(/^(NSE|BSE)\s*:\s*/, '').replace(/\.(NS|BO)$/, '');
    return s;
  }

  function masterGet(master, sym) {
    if (!master || !sym) return null;
    if (typeof master.get === 'function' && typeof master.has === 'function') return master.get(sym) || null;
    return hasOwn(master, sym) ? master[sym] : null;
  }

  function masterSize(master) {
    if (!master) return 0;
    if (typeof master.size === 'number' && typeof master.get === 'function') return master.size;
    return Object.keys(master).length;
  }

  function sameText(a, b) {
    return String(a).replace(/\s+/g, ' ').trim().toLowerCase() === String(b).replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /** Real % operator (value is a fraction) vs a literal "%" in quotes (value already a percent). */
  function percentScale(fmt) {
    if (!fmt) return null;
    var stripped = String(fmt).replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '');
    if (stripped.indexOf('%') >= 0) return 'fraction';
    if (/"[^"]*%[^"]*"|\\%/.test(fmt)) return 'percent';
    return null;
  }

  function topCounts(map, limit) {
    var arr = [];
    map.forEach(function (n, k) { arr.push([k, n]); });
    arr.sort(function (a, b) { return b[1] - a[1] || (String(a[0]) < String(b[0]) ? -1 : 1); });
    return arr.slice(0, limit);
  }

  function isEmailLike(s) { return typeof s === 'string' && s.indexOf('@') >= 0 && EMAIL_RE.test(s); }

  /** Deep copy with e-mail addresses masked (used for publicMode output). */
  function scrub(x) {
    if (typeof x === 'string') return x.indexOf('@') >= 0 ? x.replace(EMAIL_RE_G, '[email]') : x;
    if (Array.isArray(x)) return x.map(scrub);
    if (x && typeof x === 'object') {
      var o = {};
      for (var k in x) if (hasOwn(x, k)) o[k] = scrub(x[k]);
      return o;
    }
    return x;
  }

  function options(opts) {
    opts = opts || {};
    return {
      master: opts.master || null,
      publicMode: !!opts.publicMode,
      maxSamples: opts.maxSamples >= 0 ? opts.maxSamples : DEFAULTS.maxSamples,
      maxDistinct: opts.maxDistinct > 0 ? opts.maxDistinct : DEFAULTS.maxDistinct,
      maxList: opts.maxList > 0 ? opts.maxList : DEFAULTS.maxList,
      headerScanRows: opts.headerScanRows > 0 ? opts.headerScanRows : DEFAULTS.headerScanRows
    };
  }

  // ------------------------------------------------------- row summaries

  function summarizeRows(rows) {
    var n = rows.length;
    var nonEmpty = new Int32Array(n), text = new Int32Array(n), str = new Int32Array(n), first = new Int32Array(n), last = new Int32Array(n);
    var errorCells = 0, emails = 0;
    for (var r = 0; r < n; r++) {
      var row = rows[r] || [];
      var ne = 0, tx = 0, st = 0, f = -1, l = -1;
      for (var c = 0; c < row.length; c++) {
        var v = row[c];
        if (isBlank(v)) continue;
        ne++;
        if (f < 0) f = c;
        l = c;
        if (typeof v === 'string') {
          if (isErrorValue(v.trim())) errorCells++;
          else { st++; if (isHeaderText(v)) tx++; }
          if (emails === 0 && isEmailLike(v)) emails++;
        }
      }
      nonEmpty[r] = ne; text[r] = tx; str[r] = st; first[r] = f; last[r] = l;
    }
    return { n: n, nonEmpty: nonEmpty, text: text, str: str, first: first, last: last, errorCells: errorCells, hasEmail: emails > 0 };
  }

  // ---------------------------------------------------- header detection

  function nextNonBlank(S, r, within) {
    for (var k = r + 1; k < S.n && k <= r + within; k++) if (S.nonEmpty[k] > 0) return k;
    return -1;
  }

  /** Header row r has text in a column where data row d has a number / bool / date. */
  function typeBreak(rows, r, d) {
    if (d < 0) return false;
    var hr = rows[r] || [], dr = rows[d] || [];
    var len = Math.min(hr.length, dr.length);
    for (var c = 0; c < len; c++) {
      if (!isHeaderText(hr[c])) continue;
      var k = cellKind(dr[c]);
      if (k === 'number' || k === 'bool' || k === 'date') return true;
      if (typeof dr[c] === 'string' && TEXT_DATE_RE.test(dr[c].trim())) return true;
    }
    return false;
  }

  function headerWordCount(rows, r) {
    var row = rows[r] || [], n = 0;
    for (var c = 0; c < row.length; c++) {
      // split camelCase so 'StockName' / 'MarketPrice' count, but 'updated' does not match 'date'
      if (isHeaderText(row[c]) && HEADER_WORD_RE.test(String(row[c]).replace(/([a-z])([A-Z])/g, '$1 $2'))) n++;
    }
    return n;
  }

  function shortCells(rows, r, max) {
    var row = rows[r] || [];
    for (var c = 0; c < row.length; c++) if (typeof row[c] === 'string' && row[c].trim().length > max) return false;
    return true;
  }

  function isHeaderCandidate(rows, S, r) {
    var tx = S.text[r], ne = S.nonEmpty[r];
    if (tx >= 3 && tx / ne >= 0.6) return true;
    if (tx === 2 && ne === 2 && shortCells(rows, r, 40)) {
      return headerWordCount(rows, r) >= 1 || typeBreak(rows, r, nextNonBlank(S, r, 3));
    }
    return false;
  }

  function isTitleRow(rows, S, r) {
    return S.nonEmpty[r] > 0 && S.nonEmpty[r] <= 2 && S.str[r] === S.nonEmpty[r];
  }

  /** Prefer a much wider header right below a sparse group-header row (Main: row 1 groups, row 2 headers). */
  function refineHeader(rows, S, r) {
    var d = nextNonBlank(S, r, 1);
    if (d > 0 && isHeaderCandidate(rows, S, d) && S.text[d] >= 2 * S.text[r] && nextNonBlank(S, d, 3) > 0) {
      return { header: d, group: r };
    }
    return { header: r, group: -1 };
  }

  function findFirstHeader(rows, S, scan) {
    var lim = Math.min(S.n, scan);
    var firstNoData = -1;
    for (var r = 0; r < lim; r++) {
      if (S.nonEmpty[r] === 0 || !isHeaderCandidate(rows, S, r)) continue;
      if (nextNonBlank(S, r, 3) < 0) { if (firstNoData < 0) firstNoData = r; continue; }
      return refineHeader(rows, S, r);
    }
    if (firstNoData >= 0) return { header: firstNoData, group: -1 };
    return null;
  }

  function headerSet(rows, r) {
    var set = Object.create(null), row = rows[r] || [];
    for (var c = 0; c < row.length; c++) if (isHeaderText(row[c])) set[String(row[c]).trim().toLowerCase()] = true;
    return set;
  }

  /** After a blank separator: does row r start a new table? */
  function detectBlockStart(rows, S, r, cur) {
    function evidence(h, hadTitle) {
      if (!isHeaderCandidate(rows, S, h)) return false;
      var d = nextNonBlank(S, h, 3);
      if (d < 0) return false;
      if (typeBreak(rows, h, d)) return true;
      if (cur && cur.header >= 0) {
        var prev = headerSet(rows, cur.header), row = rows[h] || [], hit = 0, tot = 0;
        for (var c = 0; c < row.length; c++) {
          if (!isHeaderText(row[c])) continue;
          tot++;
          if (prev[String(row[c]).trim().toLowerCase()]) hit++;
        }
        if (tot && hit / tot >= 0.5) return true;
      }
      var hw = headerWordCount(rows, h);
      return hadTitle ? hw >= 1 : (hw >= 2 && hw >= S.text[h] / 2);
    }
    if (isHeaderCandidate(rows, S, r) && evidence(r, false)) {
      var ref = refineHeader(rows, S, r);
      return { start: r, header: ref.header, group: ref.group };
    }
    if (isTitleRow(rows, S, r)) {
      var k = r;
      for (var step = 0; step < 3; step++) {
        k = nextNonBlank(S, k, 2);
        if (k < 0) break;
        if (isHeaderCandidate(rows, S, k)) {
          if (evidence(k, true)) {
            var ref2 = refineHeader(rows, S, k);
            return { start: r, header: ref2.header, group: ref2.group };
          }
          break;
        }
        if (!isTitleRow(rows, S, k)) break;
      }
    }
    return null;
  }

  /** Split the sheet into blocks: [{ start, header, group, first, last, blankRows: [] }] (0-based rows). */
  function findBlocks(rows, S, scan) {
    var blocks = [];
    if (!S.n) return blocks;
    var h = findFirstHeader(rows, S, scan);
    var cur;
    var startRow = 0;
    while (startRow < S.n && S.nonEmpty[startRow] === 0) startRow++;
    if (startRow >= S.n) return blocks;
    if (h) cur = { start: startRow, header: h.header, group: h.group, first: -1, last: -1, dataRows: 0, blankRows: [] };
    else cur = { start: startRow, header: -1, group: -1, first: -1, last: -1, dataRows: 0, blankRows: [] };
    var r = cur.header >= 0 ? cur.header + 1 : startRow;
    var pendingBlank = [];
    for (; r < S.n; r++) {
      if (S.nonEmpty[r] === 0) { if (cur.dataRows > 0 || cur.header >= 0) pendingBlank.push(r); continue; }
      if (pendingBlank.length) {
        var nb = detectBlockStart(rows, S, r, cur);
        if (nb) {
          blocks.push(cur);
          cur = { start: nb.start, header: nb.header, group: nb.group, first: -1, last: -1, dataRows: 0, blankRows: [] };
          pendingBlank = [];
          r = nb.header;
          continue;
        }
        if (cur.dataRows > 0) Array.prototype.push.apply(cur.blankRows, pendingBlank);
        pendingBlank = [];
      }
      if (cur.first < 0) cur.first = r;
      cur.last = r;
      cur.dataRows++;
    }
    blocks.push(cur);
    return blocks;
  }

  // ------------------------------------------------------ column profiling

  function newAcc() {
    return {
      filled: 0, blank: 0, err: 0, kinds: { number: 0, percent: 0, date: 0, text: 0, bool: 0 },
      numText: 0, textDate: 0, min: Infinity, max: -Infinity, sum: 0, n: 0, minDate: null, maxDate: null,
      distinct: new Map(), distinctCapped: false, samples: [], fmts: new Map(),
      formulas: 0, formulaTexts: [], shared: false, upper: 0, strings: 0
    };
  }

  function profileBlock(sheet, S, blk, o, privateRowsFor) {
    var rows = sheet.rows, formulas = sheet.formulas || [], numFmts = sheet.numFmts || [];
    var hdrRow = blk.header >= 0 ? rows[blk.header] || [] : [];
    var grpRow = blk.group >= 0 ? rows[blk.group] || [] : [];
    // column span: header span plus data span
    var c0 = Infinity, c1 = -1;
    function span(r) { if (r >= 0 && S.first[r] >= 0) { c0 = Math.min(c0, S.first[r]); c1 = Math.max(c1, S.last[r]); } }
    span(blk.header);
    if (blk.first >= 0) for (var r = blk.first; r <= blk.last; r++) span(r);
    if (c1 < 0) { c0 = 0; c1 = -1; }
    var ncols = c1 - c0 + 1;
    var accs = [];
    for (var i = 0; i < ncols; i++) accs.push(newAcc());

    var priv = privateRowsFor(blk, c0, c1);
    var dataRows = 0, errors = { total: 0, byType: new Map(), cells: [] };
    var maxTrack = DEFAULTS.maxTrackDistinct;
    if (blk.first >= 0) {
      for (r = blk.first; r <= blk.last; r++) {
        if (S.nonEmpty[r] === 0) continue;
        dataRows++;
        var row = rows[r] || [], frow = formulas[r], nrow = numFmts[r];
        var isPriv = priv !== null && priv[r] === 1;
        for (var c = c0; c <= c1; c++) {
          var a = accs[c - c0];
          var v = row[c];
          var f = frow ? frow[c] : null;
          if (f != null) {
            a.formulas++;
            if (a.formulaTexts.length < 5 && a.formulaTexts.indexOf(f) < 0) a.formulaTexts.push(f);
          }
          var k = cellKind(v);
          if (k === 'blank') { a.blank++; continue; }
          if (k === 'error') {
            a.err++;
            var et = String(v).trim();
            errors.total++;
            errors.byType.set(et, (errors.byType.get(et) || 0) + 1);
            if (errors.cells.length < 10) errors.cells.push(colLetter(c) + (r + 1));
            continue;
          }
          a.filled++;
          var fmt = nrow ? nrow[c] : null;
          if (fmt != null) a.fmts.set(fmt, (a.fmts.get(fmt) || 0) + 1);
          if (k === 'number') {
            if (percentScale(fmt)) a.kinds.percent++; else a.kinds.number++;
          } else a.kinds[k]++;
          if (k === 'text') {
            var s = v.trim();
            a.strings++;
            if (SYMBOL_TOKEN_RE.test(s) && /[A-Z]/.test(s)) a.upper++;
            if (/\d/.test(s) && NUM_TEXT_RE.test(s.replace(/\s/g, ''))) a.numText++;
            else if (TEXT_DATE_RE.test(s)) a.textDate++;
          }
          if (isPriv) continue;
          if (k === 'number') {
            if (v < a.min) a.min = v;
            if (v > a.max) a.max = v;
            a.sum += v; a.n++;
          } else if (k === 'date') {
            var ds = v.trim();
            if (a.minDate === null || ds < a.minDate) a.minDate = ds;
            if (a.maxDate === null || ds > a.maxDate) a.maxDate = ds;
          }
          var key = typeof v === 'string' ? v.trim() : v;
          var seen = a.distinct.get(key);
          if (seen === undefined) {
            if (a.distinct.size < maxTrack) a.distinct.set(key, 1); else a.distinctCapped = true;
            if (a.samples.length < o.maxSamples) a.samples.push(sampleValue(v));
          } else a.distinct.set(key, seen + 1);
        }
      }
    }

    // shared-formula children are not in the formulas grid: use the shared ranges
    (sheet.sharedFormulas || []).forEach(function (sf) {
      var rg = parseRange(sf.ref);
      if (!rg || blk.first < 0) return;
      var lo = Math.max(rg.r0, blk.first), hi = Math.min(rg.r1, blk.last);
      if (hi < lo) return;
      var w = rg.c1 - rg.c0 + 1, h = rg.r1 - rg.r0 + 1;
      for (var cc = Math.max(rg.c0, c0); cc <= Math.min(rg.c1, c1); cc++) {
        var acc = accs[cc - c0];
        acc.shared = true;
        acc.formulas += Math.round((sf.count || 0) * ((hi - lo + 1) / h) / w);
        if (acc.formulaTexts.length < 5 && acc.formulaTexts.indexOf(sf.formula) < 0) acc.formulaTexts.push(sf.formula);
      }
    });

    var columns = [];
    for (i = 0; i < ncols; i++) {
      c = c0 + i;
      var acc2 = accs[i];
      var header = cleanHeader(isBlank(hdrRow[c]) ? null : hdrRow[c]);
      var group = null;
      if (blk.group >= 0) {
        for (var g = c; g >= c0; g--) if (isHeaderText(grpRow[g])) { group = cleanHeader(grpRow[g]); break; }
      }
      columns.push(finishColumn(acc2, c, header, group, dataRows, o));
    }
    return { columns: columns, dataRows: dataRows, c0: c0, c1: c1, errors: errors, accs: accs, priv: priv };
  }

  function inferType(a, header) {
    var k = a.kinds, nonBlank = a.filled;
    if (!nonBlank) return 'empty';
    var numeric = k.number + k.percent;
    if (numeric / nonBlank >= 0.9) {
      if (k.percent >= k.number) return 'percent';
      if (header && /%|percent|\bpct\b/i.test(header)) return 'percent';
      return 'number';
    }
    if (k.date / nonBlank >= 0.9) return 'date';
    if (k.bool / nonBlank >= 0.9) return 'bool';
    if (k.text / nonBlank >= 0.9) return 'text';
    return 'mixed';
  }

  function finishColumn(a, c, header, group, dataRows, o) {
    var type = inferType(a, header);
    var fmt = null;
    if (a.fmts.size) fmt = topCounts(a.fmts, 1)[0][0];
    var col = {
      index: c, letter: colLetter(c), header: header,
      type: type,
      filled: a.filled, missing: a.blank, errors: a.err,
      fillPct: pct(a.filled, dataRows),
      distinct: a.distinct.size,
      numFmt: fmt
    };
    if (a.distinctCapped) col.distinctCapped = true;
    if (group) col.group = group;
    if (type === 'percent') {
      col.pctScale = percentScale(fmt) || (a.n && Math.max(Math.abs(a.min), Math.abs(a.max)) > 1.5 ? 'percent' : 'fraction');
    }
    if (a.n) { col.min = round(a.min, 6); col.max = round(a.max, 6); col.mean = round(a.sum / a.n, 4); }
    if (a.minDate !== null) { col.minDate = a.minDate; col.maxDate = a.maxDate; }
    if (a.samples.length) col.samples = a.samples;
    if (a.formulas) {
      col.formula = { cells: a.formulas, pct: pct(Math.min(a.formulas, dataRows), dataRows), example: clip(a.formulaTexts[0], 200) };
      if (a.shared) col.formula.shared = true;
    }
    if (a.numText) col.numbersAsText = a.numText;
    if (a.textDate) col.datesAsText = a.textDate;
    return col;
  }

  // ------------------------------------------------- semantic columns

  function pickByHeader(columns, res, filter) {
    for (var i = 0; i < res.length; i++) {
      for (var j = 0; j < columns.length; j++) {
        var h = columns[j].header;
        if (h && res[i].test(h) && (!filter || filter(columns[j]))) return j;
      }
    }
    return -1;
  }

  function detectSymbolColumn(columns, accs) {
    var j = pickByHeader(columns, SYMBOL_HEADER_RES, function (col) { return col.type === 'text' || col.type === 'mixed' || col.type === 'empty'; });
    if (j >= 0) return { index: j, by: 'header' };
    var best = -1, bestShare = 0;
    for (var i = 0; i < columns.length; i++) {
      var a = accs[i];
      if (a.filled < 3 || columns[i].type !== 'text' || (columns[i].header && NOT_SYMBOL_HEADER_RE.test(columns[i].header))) continue;
      var share = a.upper / a.filled;
      var distinctRatio = a.distinct.size / Math.max(1, a.filled);
      if (share >= 0.8 && distinctRatio >= 0.5 && share > bestShare) { best = i; bestShare = share; }
    }
    return best >= 0 ? { index: best, by: 'content' } : null;
  }

  function isTextCol(col) { return col.type === 'text' || col.type === 'mixed'; }

  function detectSemantic(columns, accs) {
    var sym = detectSymbolColumn(columns, accs);
    var name = pickByHeader(columns, [/company|stockname/i, NAME_HEADER_RE], function (col) {
      return isTextCol(col) && (!sym || columns.indexOf(col) !== sym.index);
    });
    var sector = pickByHeader(columns, [/^sector$/i, SECTOR_HEADER_RE], isTextCol);
    var basic = pickByHeader(columns, [BASIC_INDUSTRY_RE], isTextCol);
    var industry = pickByHeader(columns, [/^industry$/i, INDUSTRY_HEADER_RE], function (col) {
      return isTextCol(col) && !BASIC_INDUSTRY_RE.test(col.header) && !SECTOR_HEADER_RE.test(col.header);
    });
    return { symbol: sym, name: name, sector: sector, industry: industry, basic: basic };
  }

  function colRef(columns, j) {
    if (j == null || j < 0) return null;
    return { index: columns[j].index, letter: columns[j].letter, header: columns[j].header };
  }

  // ----------------------------------------------------- data quality

  function symbolIssues(v) {
    if (typeof v === 'number') return ['numeric'];
    if (typeof v !== 'string') return ['invalid'];
    var issues = [];
    var s = v.trim();
    if (v !== s || /\s/.test(s)) issues.push('space');
    if (/[a-z]/.test(s)) issues.push('lowercase');
    var core = s.replace(/^(NSE|BSE)\s*:\s*/i, '').replace(/\.(NS|BO)$/i, '').toUpperCase().replace(/\s+/g, '');
    if (!VALID_SYMBOL_RE.test(core)) issues.push('invalid chars');
    return issues;
  }

  function blockQuality(sheet, S, blk, prof, sem, o, redact) {
    var rows = sheet.rows;
    var columns = prof.columns, c0 = prof.c0;
    var q = {
      blankRowsInside: blk.blankRows.length,
      blankRows: blk.blankRows.slice(0, o.maxList).map(function (r) { return r + 1; }),
      errors: {
        total: prof.errors.total,
        byType: topCounts(prof.errors.byType, o.maxList).reduce(function (m, e) { m[e[0]] = e[1]; return m; }, {}),
        cells: prof.errors.cells
      },
      missing: columns.filter(function (col) { return col.missing > 0 && col.header; })
        .sort(function (a, b) { return b.missing - a.missing; })
        .slice(0, o.maxList)
        .map(function (col) { return { column: col.letter, header: col.header, missing: col.missing, missingPct: pct(col.missing, prof.dataRows) }; }),
      textDates: columns.filter(function (col) { return col.datesAsText && col.datesAsText >= 0.5 * col.filled; })
        .map(function (col) { return { column: col.letter, header: col.header, count: col.datesAsText }; }),
      numbersAsText: columns.filter(function (col) { return col.numbersAsText && col.numbersAsText >= 0.5 * col.filled; })
        .map(function (col) { return { column: col.letter, header: col.header, count: col.numbersAsText }; })
    };

    // duplicates + symbol hygiene on the symbol column
    if (sem.symbol && blk.first >= 0) {
      var sc = columns[sem.symbol.index].index;
      var dateCol = -1;
      for (var j = 0; j < columns.length; j++) {
        if (columns[j].type === 'date' || (columns[j].header && /date/i.test(columns[j].header) && columns[j].filled)) { dateCol = columns[j].index; break; }
      }
      var counts = new Map(), firstRows = new Map(), bad = [], badCount = 0, filled = 0;
      for (var r = blk.first; r <= blk.last; r++) {
        if (S.nonEmpty[r] === 0) continue;
        var v = (rows[r] || [])[sc];
        if (isBlank(v) || isErrorValue(v)) continue;
        filled++;
        var issues = symbolIssues(v);
        if (issues.length) {
          badCount++;
          if (bad.length < o.maxList && !(redact && redact.values)) bad.push({ row: r + 1, value: sampleValue(v), issues: issues });
        }
        var key = normalizeSymbol(v);
        counts.set(key, (counts.get(key) || 0) + 1);
        var lst = firstRows.get(key);
        if (!lst) firstRows.set(key, [r + 1]); else if (lst.length < 5) lst.push(r + 1);
      }
      var dupRows = 0;
      counts.forEach(function (n) { if (n > 1) dupRows += n - 1; });
      var keyCols = [columns[sem.symbol.index].header || columns[sem.symbol.index].letter];
      if (filled && dupRows / filled > 0.5 && dateCol >= 0) {
        // long format (one row per symbol per date): the key is symbol + date
        keyCols.push(columns[dateCol - c0].header || columns[dateCol - c0].letter);
        counts = new Map(); firstRows = new Map(); dupRows = 0;
        for (r = blk.first; r <= blk.last; r++) {
          var row = rows[r] || [];
          if (S.nonEmpty[r] === 0 || isBlank(row[sc])) continue;
          var k2 = normalizeSymbol(row[sc]) + '|' + (row[dateCol] == null ? '' : String(row[dateCol]).trim());
          counts.set(k2, (counts.get(k2) || 0) + 1);
          var l2 = firstRows.get(k2);
          if (!l2) firstRows.set(k2, [r + 1]); else if (l2.length < 5) l2.push(r + 1);
        }
        counts.forEach(function (n) { if (n > 1) dupRows += n - 1; });
      }
      var dups = [];
      counts.forEach(function (n, key2) { if (n > 1) dups.push({ key: key2, count: n, rows: firstRows.get(key2) }); });
      dups.sort(function (a, b) { return b.count - a.count; });
      q.duplicateKeys = {
        keyColumns: keyCols,
        duplicateRows: dupRows,
        distinctKeys: counts.size,
        keys: (redact && redact.values) ? [] : dups.slice(0, o.maxList)
      };
      q.inconsistentSymbols = { count: badCount, items: bad };
    }

    // invalid prices in price-like numeric columns
    var priceIssues = [];
    columns.forEach(function (col, idx) {
      if (!col.header || col.type === 'percent' || !PRICE_HEADER_RE.test(col.header) || NOT_PRICE_RE.test(col.header)) return;
      var a = prof.accs[idx];
      var numeric = a.kinds.number + a.kinds.percent;
      if (!a.filled || numeric / a.filled < 0.5) return;
      var count = 0, samples = [];
      var hideValues = (redact && redact.values) || (redact && redact.columns && redact.columns[idx]);
      for (var r2 = blk.first; r2 <= blk.last && blk.first >= 0; r2++) {
        if (S.nonEmpty[r2] === 0) continue;
        var v2 = (rows[r2] || [])[col.index];
        if (isBlank(v2) || isErrorValue(v2)) continue;
        if (typeof v2 === 'number' ? v2 <= 0 : true) {
          count++;
          var hideRow = hideValues || (prof.priv !== null && prof.priv[r2] === 1);
          // a hidden column/row gives no cell reference either (row -> symbol would leak)
          if (samples.length < 10 && !hideRow) samples.push({ cell: col.letter + (r2 + 1), value: sampleValue(v2) });
        }
      }
      if (count) priceIssues.push({ column: col.letter, header: col.header, count: count, cells: samples });
    });
    q.invalidPrices = priceIssues;
    return q;
  }

  // --------------------------------------------------- strategy columns

  function strategyColumns(columns, accs, o, redact) {
    var out = [];
    columns.forEach(function (col, idx) {
      var a = accs[idx];
      var reasons = [], words = Object.create(null);
      var hm = col.header ? col.header.match(STRATEGY_RE) : null;
      if (hm) { reasons.push('header'); hm.forEach(function (w) { words[w.toLowerCase()] = true; }); }
      var fm = null;
      for (var i = 0; i < a.formulaTexts.length; i++) {
        var m = a.formulaTexts[i].match(STRATEGY_RE);
        if (m) { fm = m; m.forEach(function (w) { words[w.toLowerCase()] = true; }); }
      }
      if (fm) reasons.push('formula');
      if (!reasons.length) return;
      var item = { column: col.letter, header: col.header, type: col.type, reasons: reasons, keywords: Object.keys(words).slice(0, 10) };
      var hide = (redact && redact.values) || (redact && redact.columns && redact.columns[idx]);
      if (col.formula && !hide) item.formula = col.formula.example;
      var categorical = (col.type === 'text' || col.type === 'bool' || col.type === 'mixed') &&
        a.distinct.size > 0 && a.distinct.size <= o.maxDistinct && !a.distinctCapped &&
        a.distinct.size <= Math.max(10, a.filled / 2);
      if (categorical && !hide) {
        item.values = topCounts(a.distinct, o.maxDistinct).map(function (e) { return { value: sampleValue(e[0]), count: e[1] }; });
      }
      out.push(item);
    });
    return out;
  }

  // ------------------------------------------- industries + master match

  function distribution(map, symMap, limit) {
    var arr = [];
    map.forEach(function (n, k) { arr.push({ name: k, rows: n, symbols: symMap.get(k) ? symMap.get(k).size : 0 }); });
    arr.sort(function (a, b) { return b.rows - a.rows || (a.name < b.name ? -1 : 1); });
    var top = arr.slice(0, limit), other = 0;
    for (var i = limit; i < arr.length; i++) other += arr[i].rows;
    return { distinct: arr.length, counts: top, otherRows: other };
  }

  function industryAndMaster(sheet, S, blk, prof, sem, o) {
    var rows = sheet.rows, columns = prof.columns;
    var out = {};
    if (blk.first < 0) return out;
    var symC = sem.symbol ? columns[sem.symbol.index].index : -1;
    var master = o.master;

    function dist(colIdx, field) {
      var counts = new Map(), syms = new Map(), unknown = 0, source = null, column = null;
      var useSheet = colIdx >= 0;
      if (!useSheet && (!master || symC < 0)) return null;
      source = useSheet ? 'sheet' : 'master';
      column = useSheet ? columns[colIdx].header : null;
      for (var r = blk.first; r <= blk.last; r++) {
        if (S.nonEmpty[r] === 0) continue;
        var row = rows[r] || [];
        var sym = symC >= 0 ? normalizeSymbol(row[symC]) : '';
        var val = null;
        if (useSheet) val = row[columns[colIdx].index];
        else { var m = masterGet(master, sym); val = m ? m[field] : null; }
        if (isBlank(val) || isErrorValue(val)) { unknown++; continue; }
        var key = String(val).replace(/\s+/g, ' ').trim();
        counts.set(key, (counts.get(key) || 0) + 1);
        if (sym) { var st = syms.get(key); if (!st) syms.set(key, st = new Set()); st.add(sym); }
      }
      if (!counts.size) return null;
      var d = distribution(counts, syms, o.maxDistinct);
      return { source: source, column: column, field: field, distinct: d.distinct, unknownRows: unknown, counts: d.counts, otherRows: d.otherRows };
    }

    var ind = sem.industry >= 0 ? dist(sem.industry, 'industry')
      : sem.basic >= 0 ? dist(sem.basic, 'basicIndustry')
        : dist(-1, 'industry') || dist(-1, 'basicIndustry');
    if (ind) out.industryDistribution = ind;
    var sec = sem.sector >= 0 ? dist(sem.sector, 'sector') : dist(-1, 'sector');
    if (sec) out.sectorDistribution = sec;

    if (master && symC >= 0) {
      var seen = new Set(), matched = 0, unmatched = [], unmatchedCount = 0;
      var checks = [];
      if (sem.sector >= 0) checks.push({ j: sem.sector, fields: ['sector'], field: 'sector' });
      if (sem.industry >= 0) checks.push({ j: sem.industry, fields: ['industry', 'basicIndustry'], field: 'industry' });
      if (sem.basic >= 0) checks.push({ j: sem.basic, fields: ['basicIndustry'], field: 'basicIndustry' });
      // an 'Industry' column may hold basic industries: map it to whichever field agrees more
      checks.forEach(function (ch) {
        if (ch.fields.length < 2) { ch.field = ch.fields[0]; return; }
        var agree = [0, 0], tested = 0;
        for (var r = blk.first; r <= blk.last && tested < 300; r++) {
          var row = rows[r] || [];
          var m = masterGet(master, normalizeSymbol(row[symC]));
          var v = row[columns[ch.j].index];
          if (!m || isBlank(v)) continue;
          tested++;
          if (m[ch.fields[0]] != null && sameText(v, m[ch.fields[0]])) agree[0]++;
          if (m[ch.fields[1]] != null && sameText(v, m[ch.fields[1]])) agree[1]++;
        }
        ch.field = agree[1] > agree[0] ? ch.fields[1] : ch.fields[0];
      });
      var conflicts = [], conflictCount = 0, conflictSeen = new Set();
      for (var r = blk.first; r <= blk.last; r++) {
        if (S.nonEmpty[r] === 0) continue;
        var row = rows[r] || [];
        var sym = normalizeSymbol(row[symC]);
        if (!sym || isErrorValue(row[symC])) continue;
        var m = masterGet(master, sym);
        if (!seen.has(sym)) {
          seen.add(sym);
          if (m) matched++;
          else { unmatchedCount++; if (unmatched.length < o.maxList) unmatched.push(sym); }
        }
        if (!m) continue;
        for (var i = 0; i < checks.length; i++) {
          var ch = checks[i];
          var sv = row[columns[ch.j].index], mv = m[ch.field];
          if (isBlank(sv) || isErrorValue(sv) || isBlank(mv) || sameText(sv, mv)) continue;
          var ck = sym + '|' + ch.field;
          if (conflictSeen.has(ck)) continue;
          conflictSeen.add(ck);
          conflictCount++;
          if (conflicts.length < o.maxList) {
            conflicts.push({ symbol: sym, row: r + 1, field: ch.field, column: columns[ch.j].header, sheet: sampleValue(sv), master: sampleValue(mv) });
          }
        }
      }
      out.reconciliation = {
        masterSymbols: masterSize(master),
        symbols: seen.size, matched: matched, unmatched: unmatchedCount,
        matchedPct: pct(matched, seen.size),
        unmatchedSymbols: unmatched,
        conflictCount: conflictCount,
        conflicts: conflicts,
        fieldsChecked: checks.map(function (ch) { return { column: columns[ch.j].header, field: ch.field }; })
      };
    }
    return out;
  }

  // ------------------------------------------------------------ personal

  function personalCheck(sheet, S, blocks) {
    var reasons = [];
    if (PERSONAL_SHEET_RE.test(sheet.name || '')) reasons.push('sheet name');
    var hdrs = [];
    blocks.forEach(function (b) {
      [b.header, b.group].forEach(function (r) {
        if (r < 0) return;
        var row = sheet.rows[r] || [];
        for (var c = 0; c < row.length; c++) if (isHeaderText(row[c])) hdrs.push(String(row[c]).trim());
      });
    });
    var hit = hdrs.filter(function (h) { return PERSONAL_HEADER_RE.test(h) && !NOT_PERSONAL_HEADER_RE.test(h); });
    if (hit.length) reasons.push('personal columns (' + hit.slice(0, 5).map(function (h) { return clip(h, 30); }).join(', ') + ')');
    if (S.hasEmail) reasons.push('e-mail address');
    return reasons;
  }

  /** Rows tagged Entry/Position/Trade in a 'Type' column (personal positions inside public logs). */
  function makePrivateRows(sheet, S) {
    return function (blk, c0, c1) {
      if (blk.header < 0 || blk.first < 0) return null;
      var hdr = sheet.rows[blk.header] || [], typeCols = [];
      for (var c = c0; c <= c1; c++) if (typeof hdr[c] === 'string' && TYPE_HEADER_RE.test(hdr[c])) typeCols.push(c);
      if (!typeCols.length) return null;
      var flags = new Uint8Array(S.n), any = false;
      for (var r = blk.first; r <= blk.last; r++) {
        var row = sheet.rows[r] || [];
        for (var i = 0; i < typeCols.length; i++) {
          var v = row[typeCols[i]];
          if (typeof v === 'string' && PRIVATE_ROW_VALUE_RE.test(v.trim())) { flags[r] = 1; any = true; break; }
        }
      }
      return any ? flags : null;
    };
  }

  function structureOnlyColumn(col) {
    var o = { index: col.index, letter: col.letter, header: col.header, type: col.type, filled: col.filled, missing: col.missing, errors: col.errors, fillPct: col.fillPct, numFmt: col.numFmt };
    if (col.group) o.group = col.group;
    if (col.pctScale) o.pctScale = col.pctScale;
    if (col.formula) o.formula = { cells: col.formula.cells, pct: col.formula.pct };
    return o;
  }

  // ---------------------------------------------------------------- main

  function analyzeSheet(sheet, opts) {
    if (!sheet || typeof sheet !== 'object' || !Array.isArray(sheet.rows)) return { ok: false, reason: 'not a sheet (expected reader output with rows[])' };
    var o = options(opts);
    var rows = sheet.rows;
    var S = summarizeRows(rows);
    var blocksRaw = findBlocks(rows, S, o.headerScanRows);
    var nonEmptyRows = 0;
    for (var r = 0; r < S.n; r++) if (S.nonEmpty[r] > 0) nonEmptyRows++;

    var reasons = personalCheck(sheet, S, blocksRaw);
    var personal = reasons.length > 0;
    var system = SYSTEM_SHEET_RE.test(String(sheet.name == null ? '' : sheet.name).trim());
    var structureOnly = system || (personal && o.publicMode);
    var privateRowsFor = o.publicMode ? makePrivateRows(sheet, S) : function () { return null; };
    var updated = null;

    var blocks = blocksRaw.map(function (blk, bi) {
      var prof = profileBlock(sheet, S, blk, o, privateRowsFor);
      var sem = detectSemantic(prof.columns, prof.accs);
      var redactCols = {};
      if (o.publicMode) {
        prof.columns.forEach(function (col, idx) {
          if (col.header && PERSONAL_COLUMN_RE.test(col.header) && !NOT_PERSONAL_HEADER_RE.test(col.header)) redactCols[idx] = true;
        });
      }
      var redact = { values: structureOnly, columns: redactCols };
      var titles = [];
      for (var tr = blk.start; tr < (blk.header >= 0 ? (blk.group >= 0 ? blk.group : blk.header) : blk.start); tr++) {
        if (S.nonEmpty[tr] === 0) continue;
        var texts = (rows[tr] || []).filter(function (v) { return typeof v === 'string' && v.trim(); }).map(function (v) { return clip(v.replace(/\s+/g, ' ').trim(), 120); });
        if (texts.length) titles.push(texts.join(' | '));
        if (!updated) {
          for (var ti = 0; ti < texts.length; ti++) {
            var um = /(?:updated|refreshed|as of|last run)\s*[:\-]?\s*(.+)$/i.exec(texts[ti]);
            if (um) { updated = clip(um[1], 40); break; }
          }
        }
      }
      var out = {
        index: bi,
        headerRow: blk.header >= 0 ? blk.header + 1 : null,
        groupHeaderRow: blk.group >= 0 ? blk.group + 1 : null,
        firstDataRow: blk.first >= 0 ? blk.first + 1 : null,
        lastDataRow: blk.last >= 0 ? blk.last + 1 : null,
        dataRows: prof.dataRows,
        firstColumn: prof.c1 >= prof.c0 ? colLetter(prof.c0) : null,
        lastColumn: prof.c1 >= prof.c0 ? colLetter(prof.c1) : null,
        columnCount: prof.columns.length
      };
      if (!structureOnly && titles.length) out.title = titles.slice(0, 3);
      out.symbolColumn = sem.symbol ? Object.assign(colRef(prof.columns, sem.symbol.index), { detectedBy: sem.symbol.by }) : null;
      out.nameColumn = colRef(prof.columns, sem.name);
      out.sectorColumn = colRef(prof.columns, sem.sector);
      out.industryColumn = colRef(prof.columns, sem.industry);
      out.basicIndustryColumn = colRef(prof.columns, sem.basic);
      var omitted = 0;
      out.columns = prof.columns.map(function (col, idx) {
        if (!col.header && !col.filled && !col.errors && !col.formula) { omitted++; return null; }
        if (structureOnly || redactCols[idx]) {
          var so = structureOnlyColumn(col);
          if (redactCols[idx] && !structureOnly) so.redacted = true;
          return so;
        }
        return col;
      }).filter(function (col) { return col !== null; });
      if (omitted) out.emptyColumnsOmitted = omitted;
      /** @type {any} */
      var q = blockQuality(sheet, S, blk, prof, sem, o, redact);
      if (structureOnly) {
        q = {
          blankRowsInside: q.blankRowsInside,
          errors: { total: q.errors.total, byType: q.errors.byType },
          missingColumns: q.missing.length,
          duplicateRows: q.duplicateKeys ? q.duplicateKeys.duplicateRows : 0,
          inconsistentSymbols: q.inconsistentSymbols ? q.inconsistentSymbols.count : 0,
          invalidPrices: q.invalidPrices.reduce(function (n, p) { return n + p.count; }, 0)
        };
      }
      out.quality = q;
      out.strategyColumns = strategyColumns(prof.columns, prof.accs, o, redact);
      if (system) {
        // its "headers" are pieces of stored JSON, not column names
        out.symbolColumn = out.nameColumn = out.sectorColumn = out.industryColumn = out.basicIndustryColumn = null;
        out.columns.forEach(function (col) { col.header = null; delete col.group; });
        out.strategyColumns = [];
      } else if (structureOnly) {
        out.strategyColumns = out.strategyColumns.map(function (s) { return { column: s.column, header: s.header, type: s.type, reasons: s.reasons, keywords: s.keywords }; });
      } else {
        var extra = industryAndMaster(sheet, S, blk, prof, sem, o);
        for (var k in extra) out[k] = extra[k];
      }
      return out;
    });

    var primary = 0;
    blocks.forEach(function (b, i) { if (b.dataRows > blocks[primary].dataRows) primary = i; });

    var totals = { blankRowsInside: 0, errorCells: S.errorCells, duplicateRows: 0, inconsistentSymbols: 0, invalidPrices: 0, missingCells: 0 };
    blocks.forEach(function (b) {
      var q = b.quality;
      totals.blankRowsInside += q.blankRowsInside || 0;
      totals.duplicateRows += q.duplicateKeys ? q.duplicateKeys.duplicateRows : (q.duplicateRows || 0);
      totals.inconsistentSymbols += q.inconsistentSymbols ? (typeof q.inconsistentSymbols === 'number' ? q.inconsistentSymbols : q.inconsistentSymbols.count) : 0;
      totals.invalidPrices += Array.isArray(q.invalidPrices) ? q.invalidPrices.reduce(function (n, p) { return n + p.count; }, 0) : (q.invalidPrices || 0);
      b.columns.forEach(function (col) { totals.missingCells += col.missing || 0; });
    });

    var result = {
      ok: true,
      name: String(sheet.name == null ? '' : sheet.name),
      state: sheet.state || 'visible',
      personal: personal,
      personalReasons: reasons,
      rows: (sheet.dims && sheet.dims.rows) || S.n,
      cols: (sheet.dims && sheet.dims.cols) || rows.reduce(function (m, rw) { return Math.max(m, rw ? rw.length : 0); }, 0),
      nonEmptyRows: nonEmptyRows,
      formulaCells: sheet.formulaCount || 0,
      errorCells: S.errorCells,
      truncated: !!sheet.truncated,
      headerRow: blocks.length ? blocks[primary].headerRow : null,
      dataRows: blocks.length ? blocks[primary].dataRows : 0,
      primaryBlock: blocks.length ? primary : null,
      blockCount: blocks.length,
      quality: totals,
      blocks: blocks
    };
    if (updated && !structureOnly) result.updated = updated;
    if (structureOnly) result.publicStructureOnly = true;
    if (system) result.system = true;
    return o.publicMode ? scrub(result) : result;
  }

  /** Build SYMBOL -> { sector, industry, basicIndustry, name } from a stock-master sheet (e.g. 'Main'). */
  function buildMaster(sheet) {
    if (!sheet || !Array.isArray(sheet.rows)) return {};
    var rows = sheet.rows;
    var S = summarizeRows(rows);
    var h = findFirstHeader(rows, S, DEFAULTS.headerScanRows);
    if (!h) return {};
    var hdr = rows[h.header] || [];
    function find(res) {
      for (var i = 0; i < res.length; i++) for (var c = 0; c < hdr.length; c++) if (typeof hdr[c] === 'string' && res[i].test(hdr[c].trim())) return c;
      return -1;
    }
    var cSym = find(SYMBOL_HEADER_RES), cSec = find([/^sector$/i]), cInd = find([/^industry$/i]);
    var cBasic = find([/^basic\s*industry$/i]), cName = find([/^(stock\s*name|company( name)?|name)$/i]);
    if (cSym < 0) return {};
    var map = {};
    for (var r = h.header + 1; r < rows.length; r++) {
      var row = rows[r] || [];
      var sym = normalizeSymbol(row[cSym]);
      if (!sym || sym === '__PROTO__' || isErrorValue(row[cSym]) || hasOwn(map, sym)) continue;
      var val = function (c) { var v = c >= 0 ? row[c] : null; return isBlank(v) || isErrorValue(v) ? null : String(v).trim(); };
      map[sym] = { sector: val(cSec), industry: val(cInd), basicIndustry: val(cBasic), name: val(cName) };
    }
    return map;
  }

  function analyzeWorkbook(wb, opts) {
    if (!wb || !Array.isArray(wb.sheets)) return { ok: false, reason: 'not a workbook (expected SB.xlsx.readWorkbook() output)' };
    var o = options(opts);
    var sheets = wb.sheets.map(function (s) {
      var a = analyzeSheet(s, opts);
      return a.ok ? a : { ok: false, name: s && s.name, reason: a.reason };
    });
    var summary = {
      sheetCount: (wb.sheetNames || wb.sheets).length,
      analyzedSheets: sheets.length,
      visible: 0, hidden: 0, veryHidden: 0,
      totalRows: 0, totalDataRows: 0, totalFormulaCells: 0, totalErrorCells: 0,
      personalSheets: [], sheetsWithErrors: [], sheetsWithBlankRows: [], sheetsWithDuplicates: []
    };
    (wb.sheetNames || wb.sheets).forEach(function (s) { if (hasOwn(summary, s.state)) summary[s.state]++; });
    sheets.forEach(function (a) {
      if (!a.ok) return;
      summary.totalRows += a.rows;
      a.blocks.forEach(function (b) { summary.totalDataRows += b.dataRows; });
      summary.totalFormulaCells += a.formulaCells;
      summary.totalErrorCells += a.errorCells;
      if (a.personal) summary.personalSheets.push(a.name);
      if (a.errorCells) summary.sheetsWithErrors.push({ name: a.name, errors: a.errorCells });
      if (a.quality.blankRowsInside) summary.sheetsWithBlankRows.push({ name: a.name, blankRows: a.quality.blankRowsInside });
      if (a.quality.duplicateRows) summary.sheetsWithDuplicates.push({ name: a.name, duplicateRows: a.quality.duplicateRows });
    });
    var result = {
      ok: true,
      summary: summary,
      date1904: !!wb.date1904,
      hasMacros: !!wb.hasMacros,
      masterSymbols: o.master ? masterSize(o.master) : 0,
      warnings: (wb.warnings || []).slice(0, 100),
      sheets: sheets
    };
    return o.publicMode ? scrub(result) : result;
  }

  // ------------------------------------------------------------------ CSV

  /**
   * RFC 4180 CSV. rows: array of arrays (or array of objects -> header row from the first
   * object's keys). opts: { delimiter: ',', eol: '\r\n', bom: false, escapeFormulas: false }.
   * escapeFormulas prefixes text starting with = + - @ (tab, CR) with an apostrophe so that
   * spreadsheet apps do not run it as a formula.
   */
  function toCsv(rows, opts) {
    opts = opts || {};
    if (!Array.isArray(rows)) return '';
    var delim = typeof opts.delimiter === 'string' && opts.delimiter.length === 1 ? opts.delimiter : ',';
    var eol = opts.eol === '\n' ? '\n' : '\r\n';
    var list = rows;
    if (rows.length && rows[0] && typeof rows[0] === 'object' && !Array.isArray(rows[0])) {
      var keys = Object.keys(rows[0]);
      list = [keys].concat(rows.map(function (o) { return keys.map(function (k) { return o ? o[k] : null; }); }));
    }
    var needs = new RegExp('["\\r\\n' + (delim === '\t' ? '\\t' : delim.replace(/[\\^$.*+?()[\]{}|\-]/g, '\\$&')) + ']');
    var lines = list.map(function (row) {
      if (!Array.isArray(row)) row = [row];
      return row.map(function (v) {
        var s;
        if (v == null) s = '';
        else if (typeof v === 'boolean') s = v ? 'TRUE' : 'FALSE';
        else if (typeof v === 'number') s = isFinite(v) ? String(v) : '';
        else {
          s = String(v);
          if (opts.escapeFormulas && /^[=+\-@\t\r]/.test(s) && !/^[+\-]?\d/.test(s)) s = "'" + s;
        }
        return needs.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(delim);
    });
    return (opts.bom ? '﻿' : '') + lines.join(eol) + (lines.length ? eol : '');
  }

  /** Column profile of one block as CSV-ready rows (header row first). */
  function columnsToRows(block) {
    var out = [['Column', 'Header', 'Type', 'Filled', 'Missing', 'Errors', 'Fill %', 'Distinct', 'Min', 'Max', 'Mean', 'Number format', 'Formula cells', 'Example formula', 'Samples']];
    if (!block || !Array.isArray(block.columns)) return out;
    block.columns.forEach(function (c) {
      out.push([c.letter, c.header, c.type, c.filled, c.missing, c.errors, c.fillPct, c.distinct == null ? null : c.distinct,
        c.min == null ? (c.minDate || null) : c.min, c.max == null ? (c.maxDate || null) : c.max, c.mean == null ? null : c.mean,
        c.numFmt, c.formula ? c.formula.cells : 0, c.formula && c.formula.example ? c.formula.example : null,
        (c.samples || []).join(' | ')]);
    });
    return out;
  }

  return {
    analyzeWorkbook: analyzeWorkbook,
    analyzeSheet: analyzeSheet,
    buildMaster: buildMaster,
    toCsv: toCsv,
    columnsToRows: columnsToRows,
    // helpers
    cellKind: cellKind,
    normalizeSymbol: normalizeSymbol,
    symbolIssues: symbolIssues,
    percentScale: percentScale,
    isErrorValue: isErrorValue
  };
});
