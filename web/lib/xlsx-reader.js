/*
 * xlsx-reader.js - safe, dependency-free .xlsx reader (browser + Node).
 *
 *   window.SB.xlsx.readWorkbook(arrayBufferOrUint8Array, opts) -> Promise<{
 *     sheets: [{ name, index, state: 'visible'|'hidden'|'veryHidden',
 *                rows: [[cell]], formulas: [[string|null]], numFmts: [[string|null]],
 *                dims: { rows, cols }, merges: ['A1:D1'], sharedFormulas: [...],
 *                formulaCount, truncated }],
 *     sheetNames: [{ name, index, state }],   // every sheet, even when opts.sheets limits parsing
 *     warnings: [string], date1904: boolean, hasMacros: boolean }>
 *
 * Cells: string | number | boolean | null. Error cells keep their text ('#N/A').
 * Numbers formatted as dates become ISO strings 'YYYY-MM-DD' / 'YYYY-MM-DD HH:MM'
 * (time-only formats give 'HH:MM', [h]:mm durations 'H:MM'); 1904 system honoured.
 * Row/column indices in the grids are 0-based (rows[0][0] is cell A1); every row is
 * padded with null to dims.cols. Style-only cells and empty-string cells without a
 * formula of their own (array-formula spill) are blank and do not extend dims.
 * formulas[r][c] holds formula text without '='; shared-formula children are null
 * and counted in sharedFormulas[{ si, ref, formula, cell, count }].
 * Errors are thrown (Error with .code) for files that are not a readable .xlsx:
 * NOT_XLSX ('Not an .xlsx workbook...'), ZIP64, ENCRYPTED, MULTI_DISK, TOO_MANY_ENTRIES,
 * TOO_LARGE, CORRUPT_ZIP, UNSUPPORTED, NO_INFLATE.
 *
 * Safety: the ZIP container is parsed here (stored + deflate entries only);
 * ZIP64, encrypted and multi-disk archives are rejected; entry count and the
 * total uncompressed size are capped and every inflated entry is checked
 * against its declared size and CRC-32. Only the XML parts needed for cell
 * values are ever decompressed: macros (vbaProject.bin), external links,
 * embedded objects and DTD entities are ignored, never executed or fetched.
 *
 * opts: { maxRowsPerSheet (20000), sheets: [names], onProgress(info),
 *         maxTotalBytes (200 MB), maxEntries (5000), maxGridCells (4e6),
 *         inflateRaw(u8, maxBytes) -> Promise<Uint8Array> (override) }
 */
(function (/** @type {any} */ root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.SB = root.SB || {}; root.SB.xlsx = factory(); }
})(/** @type {any} */ (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  var DEFAULTS = {
    maxRowsPerSheet: 20000,
    maxTotalBytes: 200 * 1024 * 1024,
    maxEntries: 5000,
    maxGridCells: 4000000,
    maxCols: 16384,
    maxRows: 1048576
  };

  var NOT_XLSX = 'Not an .xlsx workbook';

  function fail(message, code, detail) {
    var e = /** @type {any} */ (new Error(message));
    e.code = code;
    e.xlsxReader = true;
    if (detail) e.detail = detail;
    return e;
  }

  // ------------------------------------------------------------------ bytes

  function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (input && input.buffer instanceof ArrayBuffer && typeof input.byteLength === 'number') {
      return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength);
    }
    throw fail(NOT_XLSX + ' (expected an ArrayBuffer or Uint8Array)', 'NOT_XLSX');
  }

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216; }

  var CRC_TABLE = null;
  function crc32(b) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Int32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        CRC_TABLE[n] = c;
      }
    }
    var t = CRC_TABLE, crc = -1;
    for (var i = 0, len = b.length; i < len; i++) crc = t[(crc ^ b[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
  }

  var utf8 = null;
  function decodeText(b) {
    // UTF-16 parts are rare but legal; UTF-8 (BOM stripped by TextDecoder) otherwise
    if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(b);
    if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(b);
    if (!utf8) utf8 = new TextDecoder('utf-8');
    return utf8.decode(b);
  }

  // -------------------------------------------------------------------- zip

  function normPath(p) {
    p = String(p).replace(/\\/g, '/');
    var out = [];
    p.split('/').forEach(function (seg) {
      if (seg === '' || seg === '.') return;
      if (seg === '..') out.pop(); else out.push(seg);
    });
    return out.join('/');
  }

  /** Parse the central directory. Throws on anything that is not a plain, safe zip. */
  function readZipDirectory(bytes, limits, warnings) {
    var len = bytes.length;
    if (len >= 8 && bytes[0] === 0xD0 && bytes[1] === 0xCF && bytes[2] === 0x11 && bytes[3] === 0xE0) {
      throw fail(NOT_XLSX + ': this looks like an old .xls file or a password-protected workbook ' +
        '(save it as a normal .xlsx without a password)', 'NOT_XLSX', 'cfb');
    }
    if (len < 22) throw fail(NOT_XLSX + ' (file too small to be a ZIP archive)', 'NOT_XLSX', 'short');
    var eocd = -1;
    var stop = Math.max(0, len - 22 - 65535);
    for (var i = len - 22; i >= stop; i--) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4B && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06 &&
          i + 22 + u16(bytes, i + 20) <= len) { eocd = i; break; }
    }
    if (eocd < 0) throw fail(NOT_XLSX + ' (not a ZIP archive)', 'NOT_XLSX', 'no-eocd');
    var disk = u16(bytes, eocd + 4), cdDisk = u16(bytes, eocd + 6);
    var onDisk = u16(bytes, eocd + 8), total = u16(bytes, eocd + 10);
    var cdSize = u32(bytes, eocd + 12), cdOffset = u32(bytes, eocd + 16);
    var hasZip64Locator = eocd >= 20 && u32(bytes, eocd - 20) === 0x07064b50;
    if (hasZip64Locator || total === 0xFFFF || onDisk === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) {
      throw fail('ZIP64 workbooks are not supported (the file is too large or was saved by an unusual tool)', 'ZIP64');
    }
    if (disk !== 0 || cdDisk !== 0 || onDisk !== total) {
      throw fail('Multi-part (split) ZIP archives are not supported', 'MULTI_DISK');
    }
    if (total > limits.maxEntries) {
      throw fail('Workbook has too many parts (' + total + ' > ' + limits.maxEntries + ')', 'TOO_MANY_ENTRIES');
    }
    if (cdOffset + cdSize > eocd) throw fail('Corrupt ZIP: central directory is out of range', 'CORRUPT_ZIP');

    var entries = Object.create(null);
    var names = [];
    var totalBytes = 0;
    var p = cdOffset;
    for (var n = 0; n < total; n++) {
      if (p + 46 > len || u32(bytes, p) !== 0x02014b50) throw fail('Corrupt ZIP: bad central directory entry', 'CORRUPT_ZIP');
      var flags = u16(bytes, p + 8), method = u16(bytes, p + 10);
      var crc = u32(bytes, p + 16), csize = u32(bytes, p + 20), usize = u32(bytes, p + 24);
      var nameLen = u16(bytes, p + 28), extraLen = u16(bytes, p + 30), commentLen = u16(bytes, p + 32);
      var localOffset = u32(bytes, p + 42);
      if (p + 46 + nameLen + extraLen + commentLen > len) throw fail('Corrupt ZIP: truncated directory', 'CORRUPT_ZIP');
      var rawName = decodeText(bytes.subarray(p + 46, p + 46 + nameLen));
      if (csize === 0xFFFFFFFF || usize === 0xFFFFFFFF || localOffset === 0xFFFFFFFF) {
        throw fail('ZIP64 workbooks are not supported (the file is too large or was saved by an unusual tool)', 'ZIP64');
      }
      if (flags & 0x41) throw fail('Encrypted / password-protected workbooks are not supported', 'ENCRYPTED');
      totalBytes += usize;
      if (totalBytes > limits.maxTotalBytes) {
        throw fail('Workbook is too large when uncompressed (more than ' +
          Math.round(limits.maxTotalBytes / 1048576) + ' MB)', 'TOO_LARGE');
      }
      var name = normPath(rawName);
      var key = name.toLowerCase();
      if (name && rawName.slice(-1) !== '/') {
        if (entries[key]) {
          warnings.push('Duplicate ZIP entry "' + name + '" ignored');
        } else {
          entries[key] = { name: name, method: method, crc: crc, csize: csize, usize: usize, offset: localOffset };
          names.push(name);
        }
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { entries: entries, names: names, totalBytes: totalBytes };
  }

  function entryData(bytes, e) {
    var lo = e.offset;
    if (lo + 30 > bytes.length || u32(bytes, lo) !== 0x04034b50) {
      throw fail('Corrupt ZIP: bad local header for ' + e.name, 'CORRUPT_ZIP');
    }
    var start = lo + 30 + u16(bytes, lo + 26) + u16(bytes, lo + 28);
    var end = start + e.csize;
    if (end > bytes.length) throw fail('Corrupt ZIP: data for ' + e.name + ' is truncated', 'CORRUPT_ZIP');
    return bytes.subarray(start, end);
  }

  async function inflateRawStream(data, maxBytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw fail('This browser cannot decompress workbooks (DecompressionStream is missing)', 'NO_INFLATE');
    }
    var ds = new DecompressionStream('deflate-raw');
    var writer = ds.writable.getWriter();
    writer.write(data.slice()).catch(function () { /* surfaced by the reader */ });
    writer.close().catch(function () { /* surfaced by the reader */ });
    var reader = ds.readable.getReader();
    var chunks = [], total = 0;
    for (;;) {
      var r = await reader.read();
      if (r.done) break;
      total += r.value.length;
      if (total > maxBytes) {
        reader.cancel().catch(function () { /* ignore */ });
        throw fail('ZIP entry inflates beyond its declared size (possible zip bomb)', 'TOO_LARGE');
      }
      chunks.push(r.value);
    }
    if (chunks.length === 1) return chunks[0];
    var out = new Uint8Array(total), o = 0;
    for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], o); o += chunks[i].length; }
    return out;
  }

  // -------------------------------------------------------------------- xml

  var ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  var ENT_RE = /&(#[xX][0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g;

  function entityRepl(m, e) {
    if (e.charCodeAt(0) !== 35) return ENT[e];
    var cp = (e.charCodeAt(1) === 120 || e.charCodeAt(1) === 88) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    if (!(cp >= 0 && cp <= 0x10FFFF) || (cp >= 0xD800 && cp <= 0xDFFF)) return '�';
    return String.fromCodePoint(cp);
  }

  /** Decode the 5 predefined XML entities and numeric references (no DTD entities, ever). */
  function decodeEntities(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(ENT_RE, entityRepl);
  }

  /** OOXML escapes control characters in strings as _xHHHH_ (and a literal "_x" as _x005F_x). */
  function decodeOoxmlEscapes(s) {
    if (s.indexOf('_x') < 0) return s;
    return s.replace(/_x([0-9A-Fa-f]{4})_/g, function (m, h) { return String.fromCharCode(parseInt(h, 16)); });
  }

  function isWs(c) { return c === 32 || c === 10 || c === 13 || c === 9; }

  /**
   * Minimal streaming XML tokenizer. Calls h.open(localName, attrs, selfClosing),
   * h.close(localName) and h.text(decodedText). Self-closing elements (<a/>) only get
   * open(..., true), no close(). If open() returns false, parsing stops.
   * Comments, processing instructions and DOCTYPE are skipped; CDATA is passed as text.
   * Element names lose their namespace prefix ('x:c' -> 'c'); attribute names are kept.
   */
  function parseXml(str, h) {
    var len = str.length, pos = 0;
    var onOpen = h.open, onClose = h.close, onText = h.text;
    while (pos < len) {
      var lt = str.indexOf('<', pos);
      if (lt < 0) { if (onText) onText(decodeEntities(str.slice(pos))); return; }
      if (lt > pos && onText) onText(decodeEntities(str.slice(pos, lt)));
      var c1 = str.charCodeAt(lt + 1);
      var gt;
      if (c1 === 47) { // </name>
        gt = str.indexOf('>', lt + 2);
        if (gt < 0) return;
        if (onClose) {
          var cn = str.slice(lt + 2, gt).trim();
          var ci = cn.indexOf(':');
          onClose(ci >= 0 ? cn.slice(ci + 1) : cn);
        }
        pos = gt + 1;
        continue;
      }
      if (c1 === 33) { // <!-- -->, <![CDATA[ ]]>, <!DOCTYPE >
        if (str.startsWith('<!--', lt)) {
          gt = str.indexOf('-->', lt + 4);
          pos = gt < 0 ? len : gt + 3;
        } else if (str.startsWith('<![CDATA[', lt)) {
          gt = str.indexOf(']]>', lt + 9);
          if (onText) onText(str.slice(lt + 9, gt < 0 ? len : gt));
          pos = gt < 0 ? len : gt + 3;
        } else {
          var br = str.indexOf('[', lt), gt0 = str.indexOf('>', lt);
          if (br >= 0 && gt0 >= 0 && br < gt0) { gt = str.indexOf(']>', br); pos = gt < 0 ? len : gt + 2; }
          else pos = gt0 < 0 ? len : gt0 + 1;
        }
        continue;
      }
      if (c1 === 63) { // <? ... ?>
        gt = str.indexOf('?>', lt + 2);
        pos = gt < 0 ? len : gt + 2;
        continue;
      }
      // <name attr="v" ...> or <name .../>
      var i = lt + 1, c;
      while (i < len) {
        c = str.charCodeAt(i);
        if (c === 62 || c === 47 || isWs(c)) break;
        i++;
      }
      var name = str.slice(lt + 1, i);
      var colon = name.indexOf(':');
      if (colon >= 0) name = name.slice(colon + 1);
      var attrs = {};
      var selfClosing = false;
      for (;;) {
        while (i < len && isWs(str.charCodeAt(i))) i++;
        if (i >= len) return; // unterminated tag
        c = str.charCodeAt(i);
        if (c === 62) { i++; break; }
        if (c === 47) {
          selfClosing = true;
          gt = str.indexOf('>', i);
          if (gt < 0) return;
          i = gt + 1;
          break;
        }
        var an = i;
        while (i < len) {
          c = str.charCodeAt(i);
          if (c === 61 || c === 62 || c === 47 || isWs(c)) break;
          i++;
        }
        var aname = str.slice(an, i);
        if (i === an) { i++; continue; } // stray character, skip it
        while (i < len && isWs(str.charCodeAt(i))) i++;
        var val = '';
        if (str.charCodeAt(i) === 61) {
          i++;
          while (i < len && isWs(str.charCodeAt(i))) i++;
          var q = str.charCodeAt(i);
          if (q === 34 || q === 39) {
            var ve = str.indexOf(q === 34 ? '"' : "'", i + 1);
            if (ve < 0) return;
            val = str.slice(i + 1, ve);
            i = ve + 1;
          } else {
            var vs = i;
            while (i < len) { c = str.charCodeAt(i); if (c === 62 || isWs(c)) break; i++; }
            val = str.slice(vs, i);
          }
        }
        if (aname !== '__proto__') attrs[aname] = val.indexOf('&') < 0 ? val : decodeEntities(val);
      }
      pos = i;
      if (onOpen && onOpen(name, attrs, selfClosing) === false) return;
    }
  }

  // ------------------------------------------------------------ cell refs

  function colToLetters(c) {
    var s = '';
    c = c + 1;
    while (c > 0) { var m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); }
    return s;
  }

  function lettersToCol(s) {
    var c = 0;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charCodeAt(i) & ~32; // upper-case
      if (ch < 65 || ch > 90) break;
      c = c * 26 + (ch - 64);
    }
    return c - 1;
  }

  /** 'AB12' -> { row: 11, col: 27 } (0-based); '$A$1' accepted; null when invalid. */
  function parseRef(ref) {
    var col = 0, row = 0, i = 0, len = ref ? ref.length : 0, c;
    if (!len) return null;
    if (ref.charCodeAt(0) === 36) i++;
    for (; i < len; i++) {
      c = ref.charCodeAt(i);
      if (c >= 97 && c <= 122) c -= 32;
      if (c < 65 || c > 90) break;
      col = col * 26 + (c - 64);
    }
    if (i < len && ref.charCodeAt(i) === 36) i++;
    var digits = 0;
    for (; i < len; i++) {
      c = ref.charCodeAt(i);
      if (c < 48 || c > 57) break;
      row = row * 10 + (c - 48);
      digits++;
    }
    if (!col || i !== len) return null;
    return { row: digits ? row - 1 : -1, col: col - 1 };
  }

  /** 'A1:C10' -> { r0, c0, r1, c1 } (0-based, inclusive) or null. */
  function parseRange(ref) {
    if (!ref) return null;
    var parts = String(ref).split(':');
    var a = parseRef(parts[0]), b = parseRef(parts[1] || parts[0]);
    if (!a || !b) return null;
    return { r0: Math.min(a.row, b.row), c0: Math.min(a.col, b.col), r1: Math.max(a.row, b.row), c1: Math.max(a.col, b.col) };
  }

  // --------------------------------------------------------- number formats

  var BUILTIN_FMT = {
    0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00',
    5: '"$"#,##0_);("$"#,##0)', 6: '"$"#,##0_);[Red]("$"#,##0)', 7: '"$"#,##0.00_);("$"#,##0.00)',
    8: '"$"#,##0.00_);[Red]("$"#,##0.00)', 9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
    14: 'mm-dd-yy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM',
    20: 'h:mm', 21: 'h:mm:ss', 22: 'm/d/yy h:mm',
    27: 'yyyy"年"m"月"', 28: 'm"月"d"日"', 29: 'm"月"d"日"', 30: 'm-d-yy', 31: 'yyyy"年"m"月"d"日"',
    32: 'h"時"mm"分"', 33: 'h"時"mm"分"ss"秒"', 34: 'yyyy"年"m"月"', 35: 'm"月"d"日"', 36: 'yyyy"年"m"月"',
    37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)',
    41: '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)', 42: '_("$"* #,##0_);_("$"* (#,##0);_("$"* "-"_);_(@_)',
    43: '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)', 44: '_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_);_(@_)',
    45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0', 48: '##0.0E+0', 49: '@',
    50: 'yyyy"年"m"月"', 51: 'm"月"d"日"', 52: 'yyyy"年"m"月"', 53: 'm"月"d"日"', 54: 'm"月"d"日"',
    55: 'yyyy"年"m"月"', 56: 'm"月"d"日"', 57: 'yyyy"年"m"月"', 58: 'm"月"d"日"'
  };

  var fmtInfoCache = Object.create(null);

  /**
   * Classify a number format code: { date, time, elapsed, percent }.
   *  date    - shows a calendar date (d / m(onth) / y)
   *  time    - shows a clock time (h / m(inute) / s, AM/PM)
   *  elapsed - [h] / [m] / [s] duration format
   *  percent - real % operator (value is a fraction: 0.05 shows as 5%)
   */
  function formatInfo(code) {
    if (code == null) return { date: false, time: false, elapsed: false, percent: false };
    var hit = fmtInfoCache[code];
    if (hit) return hit;
    var s = String(code);
    var info = { date: false, time: false, elapsed: false, percent: false };
    if (!/^general$/i.test(s.trim())) {
      var sec = s.split(';')[0];
      var t = sec.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/_./g, '').replace(/\*./g, '');
      if (/\[(h+|m+|s+)\]/i.test(t)) { info.elapsed = true; info.time = true; }
      t = t.replace(/\[[^\]]*\]/g, '');
      info.percent = t.indexOf('%') >= 0;
      if (/AM\/PM|A\/P/i.test(t)) { info.time = true; t = t.replace(/AM\/PM|A\/P/gi, ''); }
      // 'm' right after h or right before s means minutes, not month
      t = t.replace(/(h+)([^a-z]*)m+/gi, '$1$2').replace(/m+([^a-z]*s)/gi, '$1');
      if (/[hs]/i.test(t)) info.time = true;
      if (/[dym]/i.test(t)) info.date = true;
    }
    fmtInfoCache[code] = info;
    return info;
  }

  function isDateFormat(code) { var i = formatInfo(code); return i.date || i.time; }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /**
   * Excel serial -> ISO string ('YYYY-MM-DD', 'YYYY-MM-DD HH:MM' or 'HH:MM').
   * kind: { date, time, elapsed } from formatInfo. 1900 system keeps Excel's
   * fictional 1900-02-29 (serial 60); date1904 counts from 1904-01-01.
   */
  function serialToIso(serial, date1904, kind) {
    if (typeof serial !== 'number' || !isFinite(serial)) return null;
    kind = kind || { date: true, time: false, elapsed: false };
    var secs = Math.round(serial * 86400);
    if (kind.elapsed) {
      var neg = secs < 0 ? '-' : '';
      var a = Math.abs(secs);
      return neg + Math.floor(a / 3600) + ':' + pad2(Math.floor(a / 60) % 60);
    }
    if (serial < 0 || serial > 2958465.99999) return null;
    var days = Math.floor(secs / 86400);
    var rem = secs - days * 86400;
    var hhmm = pad2(Math.floor(rem / 3600)) + ':' + pad2(Math.floor(rem / 60) % 60);
    if (!kind.date && days === 0) return hhmm; // time-only format, no date part
    var ymd;
    if (date1904) {
      ymd = isoDay(Date.UTC(1904, 0, 1) + days * 86400000);
    } else if (days === 60) {
      ymd = '1900-02-29';
    } else {
      ymd = isoDay(Date.UTC(1899, 11, days < 60 ? 31 : 30) + days * 86400000);
    }
    return kind.time || !kind.date ? ymd + ' ' + hhmm : ymd;
  }

  function isoDay(ms) {
    var d = new Date(ms);
    var y = d.getUTCFullYear();
    return (y < 1000 ? ('000' + y).slice(-4) : y) + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  function normalizeIsoDate(s) {
    var m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?/.exec(String(s).trim());
    if (!m) return String(s);
    if (!m[2] || (m[2] === '00' && m[3] === '00')) return m[1];
    return m[1] + ' ' + m[2] + ':' + m[3];
  }

  // ---------------------------------------------------------- part parsers

  function parseRels(xml, basePart) {
    var baseDir = basePart.indexOf('/') >= 0 ? basePart.slice(0, basePart.lastIndexOf('/') + 1) : '';
    var map = Object.create(null);
    parseXml(xml, {
      open: function (name, a) {
        if (name !== 'Relationship' || !a.Id || !a.Target) return;
        if (/^external$/i.test(a.TargetMode || '')) { map[a.Id] = { type: a.Type || '', target: null, external: true }; return; }
        var target = a.Target.charAt(0) === '/' ? normPath(a.Target) : normPath(baseDir + a.Target);
        map[a.Id] = { type: a.Type || '', target: target, external: false };
      }
    });
    return map;
  }

  function relsPathFor(part) {
    var i = part.lastIndexOf('/');
    return (i >= 0 ? part.slice(0, i + 1) : '') + '_rels/' + part.slice(i + 1) + '.rels';
  }

  function attrEndingWith(a, suffix) {
    for (var k in a) if (k === suffix.slice(1) || k.slice(-suffix.length) === suffix) return a[k];
    return null;
  }

  function parseWorkbookXml(xml) {
    var sheets = [], date1904 = false;
    parseXml(xml, {
      open: function (name, a) {
        if (name === 'workbookPr') {
          date1904 = a.date1904 === '1' || /^true$/i.test(a.date1904 || '');
        } else if (name === 'sheet') {
          var st = String(a.state || 'visible');
          var state = /^veryhidden$/i.test(st) ? 'veryHidden' : /^hidden$/i.test(st) ? 'hidden' : 'visible';
          sheets.push({ name: a.name != null ? String(a.name) : 'Sheet' + (sheets.length + 1), sheetId: a.sheetId, state: state, rid: attrEndingWith(a, ':id') });
        }
      }
    });
    return { sheets: sheets, date1904: date1904 };
  }

  function parseSharedStrings(xml) {
    var out = [];
    var inSi = false, inT = false, rph = 0, cur = '';
    parseXml(xml, {
      open: function (name, a, sc) {
        if (name === 'si') { if (sc) out.push(''); else { inSi = true; cur = ''; } }
        else if (name === 't') { if (!sc) inT = true; }
        else if (name === 'rPh') { if (!sc) rph++; }
      },
      close: function (name) {
        if (name === 'si') { if (inSi) out.push(decodeOoxmlEscapes(cur)); inSi = false; }
        else if (name === 't') inT = false;
        else if (name === 'rPh') { if (rph > 0) rph--; }
      },
      text: function (s) { if (inSi && inT && rph === 0) cur += s; }
    });
    return out;
  }

  function parseStyles(xml) {
    var custom = Object.create(null);
    var xfIds = [];
    var inCellXfs = false;
    parseXml(xml, {
      open: function (name, a, sc) {
        if (name === 'numFmt' && a.numFmtId != null) custom[a.numFmtId] = a.formatCode || '';
        else if (name === 'cellXfs') { if (!sc) inCellXfs = true; }
        else if (name === 'xf' && inCellXfs) xfIds.push(parseInt(a.numFmtId || '0', 10) || 0);
      },
      close: function (name) { if (name === 'cellXfs') inCellXfs = false; }
    });
    var codes = [], kinds = [];
    for (var i = 0; i < xfIds.length; i++) {
      var id = xfIds[i];
      var code = custom[id] != null ? custom[id] : BUILTIN_FMT[id];
      if (code == null && id !== 0) code = 'builtin:' + id;
      if (code === 'General' || code === '' || code == null) { codes.push(null); kinds.push(null); continue; }
      codes.push(code);
      var info = formatInfo(code);
      kinds.push(info.date || info.time ? info : null);
    }
    return { codes: codes, kinds: kinds };
  }

  /** Parse one worksheet XML into grids. */
  function parseWorksheet(xml, ctx) {
    var sst = ctx.sst, codes = ctx.codes, kinds = ctx.kinds, date1904 = ctx.date1904;
    var maxRows = ctx.maxRowsPerSheet;
    var rows = [], formulas = [], numFmts = [];
    var merges = [], shared = Object.create(null), sharedList = [];
    var lastRow = -1, nextCol = 0, maxRow = -1, maxCol = -1;
    var truncated = false, formulaCount = 0, dimRef = null;
    var badSst = 0, badRef = 0;
    // current cell
    var cRow = 0, cCol = 0, cType = 'n', cStyle = 0, hasV = false, vText = '';
    var hasF = false, fText = '', fType = null, fSi = null, fRef = null;
    var inV = false, inF = false, inIs = false, inT = false, rph = 0, isText = '', hasIs = false;
    var skipCell = false;
    var stopNow = false; // a real value was found beyond maxRowsPerSheet

    function finishCell() {
      if (skipCell) return;
      var val = null;
      if (cType === 's') {
        if (hasV) {
          var idx = parseInt(vText, 10);
          val = sst[idx];
          if (val === undefined) { val = null; badSst++; }
        }
      } else if (cType === 'str') {
        val = hasV ? decodeOoxmlEscapes(vText) : null;
      } else if (cType === 'inlineStr') {
        val = hasIs ? decodeOoxmlEscapes(isText) : (hasV ? vText : null);
      } else if (cType === 'b') {
        val = hasV ? (vText.trim() === '1' || /^true$/i.test(vText.trim())) : null;
      } else if (cType === 'e') {
        val = hasV ? vText.trim() : null;
      } else if (cType === 'd') {
        val = hasV && vText ? normalizeIsoDate(vText) : null;
      } else if (hasV && vText !== '') {
        var num = +vText;
        if (num !== num) val = vText; // not a number: keep text
        else {
          var kind = kinds[cStyle];
          if (kind) { var iso = serialToIso(num, date1904, kind); val = iso == null ? num : iso; }
          else val = num;
        }
      }
      if (cRow >= maxRows) { // beyond maxRowsPerSheet: never stored; real content means truncated
        if (hasF || (val !== null && val !== '')) { truncated = true; stopNow = true; }
        return;
      }
      var formula = null;
      if (hasF) {
        if (fType === 'shared') {
          if (fText && fSi != null) {
            formula = fText;
            if (!shared[fSi]) {
              shared[fSi] = { si: fSi, ref: fRef || null, formula: fText, cell: colToLetters(cCol) + (cRow + 1), count: 0 };
              sharedList.push(shared[fSi]);
            }
          } else if (fSi != null && shared[fSi]) {
            shared[fSi].count++;
          }
        } else if (fText) {
          formula = fText;
        }
        formulaCount++;
      }
      var fmt = codes[cStyle] || null;
      // '' without a formula (array-formula spill cells) is as blank as a style-only cell
      if (!hasF && (val === null || val === '')) return;
      var row = rows[cRow];
      if (!row) { row = rows[cRow] = []; formulas[cRow] = []; numFmts[cRow] = []; }
      row[cCol] = val;
      if (formula !== null) formulas[cRow][cCol] = formula;
      if (fmt !== null) numFmts[cRow][cCol] = fmt;
      if (cRow > maxRow) maxRow = cRow;
      if (cCol > maxCol) maxCol = cCol;
    }

    parseXml(xml, {
      open: function (name, a, sc) {
        if (stopNow) return false;
        switch (name) {
          case 'c': {
            var r = a.r ? parseRef(a.r) : null;
            if (r) {
              cCol = r.col;
              cRow = r.row >= 0 ? r.row : (lastRow < 0 ? 0 : lastRow);
            } else {
              if (a.r) badRef++;
              cCol = nextCol;
              cRow = lastRow < 0 ? 0 : lastRow;
            }
            nextCol = cCol + 1;
            skipCell = cCol >= DEFAULTS.maxCols || cRow >= DEFAULTS.maxRows || cCol < 0;
            cType = a.t || 'n';
            cStyle = a.s ? (parseInt(a.s, 10) || 0) : 0;
            hasV = false; vText = ''; hasF = false; fText = ''; fType = null; fSi = null; fRef = null;
            hasIs = false; isText = '';
            if (sc) finishCell();
            return;
          }
          case 'v': inV = !sc; hasV = true; vText = ''; return;
          case 'f':
            hasF = true; fText = ''; fType = a.t || null; fSi = a.si != null ? a.si : null; fRef = a.ref || null;
            inF = !sc;
            return;
          case 'row': {
            var rn = a.r ? parseInt(a.r, 10) - 1 : lastRow + 1;
            if (!(rn >= 0)) rn = lastRow + 1;
            lastRow = rn; nextCol = 0;
            return;
          }
          case 'is': hasIs = true; inIs = !sc; isText = ''; return;
          case 't': if (inIs && !sc) inT = true; return;
          case 'rPh': if (!sc) rph++; return;
          case 'mergeCell': if (a.ref) merges.push(a.ref); return;
          case 'dimension': dimRef = a.ref || null; return;
          default:
        }
      },
      close: function (name) {
        switch (name) {
          case 'c': finishCell(); return;
          case 'v': inV = false; return;
          case 'f': inF = false; return;
          case 'is': inIs = false; return;
          case 't': inT = false; return;
          case 'rPh': if (rph > 0) rph--; return;
          default:
        }
      },
      text: function (s) {
        if (inV) vText += s;
        else if (inF) fText += s;
        else if (inT && rph === 0) isText += s;
      }
    });

    var nRows = maxRow + 1, nCols = maxCol + 1;
    var rect = nRows * nCols <= ctx.maxGridCells;
    for (var r = 0; r < nRows; r++) {
      if (!rows[r]) { rows[r] = []; formulas[r] = []; numFmts[r] = []; }
      var width = rect ? nCols : rows[r].length;
      fillNulls(rows[r], width);
      fillNulls(formulas[r], width);
      fillNulls(numFmts[r], width);
    }
    var warnings = [];
    if (!rect) warnings.push('grid too large to pad (' + nRows + 'x' + nCols + '); rows have different lengths');
    if (badSst) warnings.push(badSst + ' cell(s) point to missing shared strings');
    if (badRef) warnings.push(badRef + ' cell(s) have invalid references');
    var dimHint = parseRange(dimRef);
    return {
      rows: rows, formulas: formulas, numFmts: numFmts,
      dims: { rows: nRows, cols: nCols },
      merges: merges, sharedFormulas: sharedList, formulaCount: formulaCount,
      truncated: truncated, totalRowsHint: truncated && dimHint ? dimHint.r1 + 1 : null,
      warnings: warnings
    };
  }

  function fillNulls(arr, width) {
    for (var c = 0; c < width; c++) if (arr[c] === undefined) arr[c] = null;
  }

  // ----------------------------------------------------------------- main

  async function readWorkbook(input, opts) {
    opts = opts || {};
    var limits = {
      maxEntries: opts.maxEntries || DEFAULTS.maxEntries,
      maxTotalBytes: opts.maxTotalBytes || DEFAULTS.maxTotalBytes
    };
    var maxRowsPerSheet = opts.maxRowsPerSheet > 0 ? Math.floor(opts.maxRowsPerSheet) : DEFAULTS.maxRowsPerSheet;
    var maxGridCells = opts.maxGridCells > 0 ? opts.maxGridCells : DEFAULTS.maxGridCells;
    var inflate = typeof opts.inflateRaw === 'function' ? opts.inflateRaw : inflateRawStream;
    var progress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    var warnings = [];

    var bytes = toBytes(input);
    var zip = readZipDirectory(bytes, limits, warnings);
    var E = zip.entries;

    if (!E['[content_types].xml']) throw fail(NOT_XLSX, 'NOT_XLSX', 'missing [Content_Types].xml');
    if (E['xl/workbook.bin']) throw fail(NOT_XLSX + ': binary .xlsb workbooks are not supported (save as .xlsx)', 'NOT_XLSX', 'xlsb');

    var inflated = 0;
    async function read(path, required) {
      var e = E[path.toLowerCase()];
      if (!e) {
        if (required) throw fail(NOT_XLSX, 'NOT_XLSX', 'missing ' + path);
        return null;
      }
      var raw = entryData(bytes, e), out;
      if (e.method === 0) out = raw;
      else if (e.method === 8) {
        try {
          out = await inflate(raw, e.usize);
        } catch (err) {
          if (err && err.xlsxReader) throw err;
          throw fail('Corrupt ZIP: cannot decompress ' + e.name, 'CORRUPT_ZIP', err && err.message);
        }
      }
      else {
        var msg = 'Unsupported ZIP compression method ' + e.method + ' for ' + e.name;
        if (required) throw fail(msg, 'UNSUPPORTED');
        warnings.push(msg + ' (skipped)');
        return null;
      }
      if (out.length !== e.usize) throw fail('Corrupt ZIP: size mismatch for ' + e.name, 'CORRUPT_ZIP');
      inflated += out.length;
      if (inflated > limits.maxTotalBytes) throw fail('Workbook is too large when uncompressed', 'TOO_LARGE');
      if (crc32(out) !== e.crc) throw fail('Corrupt ZIP: checksum mismatch for ' + e.name, 'CORRUPT_ZIP');
      return decodeText(out);
    }

    // locate the workbook part (normally xl/workbook.xml)
    var wbPath = 'xl/workbook.xml';
    var rootRels = await read('_rels/.rels', false);
    if (rootRels) {
      var rr = parseRels(rootRels, '');
      for (var id in rr) {
        if (/\/officeDocument$/.test(rr[id].type) && rr[id].target && E[rr[id].target.toLowerCase()]) { wbPath = rr[id].target; break; }
      }
    }
    if (!E[wbPath.toLowerCase()]) throw fail(NOT_XLSX, 'NOT_XLSX', 'missing xl/workbook.xml');

    var hasMacros = false;
    zip.names.forEach(function (n) {
      if (/vbaProject\.bin$/i.test(n)) hasMacros = true;
    });
    if (hasMacros) warnings.push('Macros found (vbaProject.bin): ignored, never executed');
    if (zip.names.some(function (n) { return /^xl\/externalLinks\//i.test(n); })) {
      warnings.push('External links found: ignored, nothing is fetched');
    }
    if (zip.names.some(function (n) { return /^xl\/(embeddings|activeX)\//i.test(n); })) {
      warnings.push('Embedded objects / ActiveX controls found: ignored');
    }

    if (progress) progress({ phase: 'workbook', done: 0, total: 1 });
    var wbXml = await read(wbPath, true);
    var wb = parseWorkbookXml(wbXml);
    var rels = parseRels((await read(relsPathFor(wbPath), false)) || '', wbPath);

    var sstPath = null, stylesPath = null;
    for (var rid in rels) {
      if (/\/sharedStrings$/.test(rels[rid].type)) sstPath = rels[rid].target;
      else if (/\/styles$/.test(rels[rid].type)) stylesPath = rels[rid].target;
    }
    var baseDir = wbPath.slice(0, wbPath.lastIndexOf('/') + 1);
    var sstXml = await read(sstPath || baseDir + 'sharedStrings.xml', false);
    var stylesXml = await read(stylesPath || baseDir + 'styles.xml', false);
    var sst = sstXml ? parseSharedStrings(sstXml) : [];
    var styles = stylesXml ? parseStyles(stylesXml) : { codes: [], kinds: [] };

    var wanted = null;
    if (Array.isArray(opts.sheets) && opts.sheets.length) {
      wanted = Object.create(null);
      opts.sheets.forEach(function (n) { wanted[String(n).toLowerCase()] = true; });
    }

    var sheetNames = wb.sheets.map(function (s, i) { return { name: s.name, index: i, state: s.state }; });
    if (wanted) {
      Object.keys(wanted).forEach(function (n) {
        if (!wb.sheets.some(function (s) { return s.name.toLowerCase() === n; })) warnings.push('Sheet "' + n + '" not found');
      });
    }
    var todo = [];
    wb.sheets.forEach(function (s, i) {
      if (wanted && !wanted[s.name.toLowerCase()]) return;
      var rel = s.rid ? rels[s.rid] : null;
      if (!rel || !rel.target) { warnings.push('Sheet "' + s.name + '" has no part: skipped'); return; }
      if (!/\/worksheet$/.test(rel.type)) {
        warnings.push('Sheet "' + s.name + '" is not a worksheet (' + rel.type.split('/').pop() + '): skipped');
        return;
      }
      todo.push({ meta: s, index: i, path: rel.target });
    });

    var ctx = { sst: sst, codes: styles.codes, kinds: styles.kinds, date1904: wb.date1904, maxRowsPerSheet: maxRowsPerSheet, maxGridCells: maxGridCells };
    var sheets = [];
    for (var k = 0; k < todo.length; k++) {
      var t = todo[k];
      if (progress) {
        progress({ phase: 'sheet', sheet: t.meta.name, index: k, total: todo.length, done: k / todo.length });
        if (typeof setTimeout === 'function') await new Promise(function (res) { setTimeout(res, 0); });
      }
      var xml = await read(t.path, false);
      if (xml == null) { warnings.push('Sheet "' + t.meta.name + '": part ' + t.path + ' is missing'); continue; }
      var parsed = parseWorksheet(xml, ctx);
      xml = null;
      parsed.warnings.forEach(function (w) { warnings.push('Sheet "' + t.meta.name + '": ' + w); });
      if (parsed.truncated) {
        warnings.push('Sheet "' + t.meta.name + '" truncated at ' + maxRowsPerSheet + ' rows (maxRowsPerSheet)');
      }
      sheets.push({
        name: t.meta.name, index: t.index, state: t.meta.state,
        rows: parsed.rows, formulas: parsed.formulas, numFmts: parsed.numFmts,
        dims: parsed.dims, merges: parsed.merges, sharedFormulas: parsed.sharedFormulas,
        formulaCount: parsed.formulaCount, truncated: parsed.truncated, totalRowsHint: parsed.totalRowsHint
      });
    }
    if (progress) progress({ phase: 'done', done: 1, total: 1 });
    return { sheets: sheets, sheetNames: sheetNames, warnings: warnings, date1904: wb.date1904, hasMacros: hasMacros };
  }

  return {
    readWorkbook: readWorkbook,
    // helpers (exported for tests and other modules)
    parseXml: parseXml,
    decodeEntities: decodeEntities,
    parseRef: parseRef,
    parseRange: parseRange,
    colToLetters: colToLetters,
    lettersToCol: lettersToCol,
    formatInfo: formatInfo,
    isDateFormat: isDateFormat,
    serialToIso: serialToIso,
    crc32: crc32,
    BUILTIN_FMT: BUILTIN_FMT,
    DEFAULTS: DEFAULTS
  };
});
