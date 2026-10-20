/* Minimal .xlsx (ZIP + SpreadsheetML) generator for tests - no dependencies.
 *
 *   await makeZip([{ name, data, method: 0|8, flags, crc, usize, rawBody }], { eocdEntries, zip64Locator })  -> Uint8Array
 *   await makeXlsx({ sheets: [{ name, state, sheetData, extra }], sharedStrings: ['a', '<r>..</r>'],
 *                    numFmts: { 164: 'dd/mm/yyyy' }, cellXfs: [0, 14, 164], date1904, method,
 *                    files: { 'xl/vbaProject.bin': '...' }, omit: ['xl/workbook.xml'] })  -> Uint8Array
 *   rowsXml([[1, 'text', true, null, { f: 'A1*2', v: 2 }, { v: 45000, s: 1 }]])  -> '<row ...>...'
 */
/* global CompressionStream, TextEncoder */
'use strict';

const encoder = new TextEncoder();

let CRC_TABLE = null;
function crc32(b) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < b.length; i++) crc = CRC_TABLE[(crc ^ b[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function deflateRaw(u8) {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  writer.write(u8);
  writer.close();
  const reader = cs.readable.getReader();
  const chunks = [];
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    chunks.push(r.value);
  }
  return concat(chunks);
}

function toBytes(data) { return typeof data === 'string' ? encoder.encode(data) : data; }

function le(n, bytes) {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = Math.floor(n / Math.pow(256, i)) & 0xFF;
  return out;
}

/** Build a ZIP archive. Per-entry overrides let tests forge broken archives. */
async function makeZip(entries, opts) {
  opts = opts || {};
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const raw = toBytes(e.data);
    const method = e.method == null ? 8 : e.method;
    const body = e.rawBody ? e.rawBody : method === 8 ? await deflateRaw(raw) : raw;
    const name = encoder.encode(e.name);
    const crc = e.crc == null ? crc32(raw) : e.crc;
    const usize = e.usize == null ? raw.length : e.usize;
    const flags = (e.flags || 0) | 0x800;
    const common = [le(20, 2), le(flags, 2), le(method, 2), le(0, 2), le(0x21, 2), le(crc, 4), le(body.length, 4), le(usize, 4), le(name.length, 2), le(0, 2)];
    const local = concat([le(0x04034b50, 4)].concat(common, [name, body]));
    const central = concat([le(0x02014b50, 4), le(20, 2)].concat(common, [le(0, 2), le(0, 2), le(0, 2), le(0, 4), le(offset, 4), name]));
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cd = concat(centrals);
  const n = opts.eocdEntries == null ? entries.length : opts.eocdEntries;
  const eocd = concat([le(0x06054b50, 4), le(0, 2), le(0, 2), le(n, 2), le(n, 2), le(cd.length, 4), le(offset, 4), le(0, 2)]);
  const parts = locals.concat([cd]);
  if (opts.zip64Locator) parts.push(concat([le(0x07064b50, 4), new Uint8Array(16)]));
  parts.push(eocd);
  return concat(parts);
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function colLetters(c) {
  let s = '';
  c += 1;
  while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); }
  return s;
}

/**
 * JS rows -> <row> XML. Cell values: number, string (inline string), boolean, null (skipped),
 * '#N/A'-style strings starting with '#' and ending with !, ? or A -> error cells,
 * or objects { v, s, t, f, fShared: { si, ref }, fChild: si } for full control.
 */
function rowsXml(rows, startRow) {
  const base = startRow || 1;
  return rows.map(function (row, ri) {
    const r = base + ri;
    const cells = (row || []).map(function (v, ci) {
      if (v == null) return '';
      const ref = colLetters(ci) + r;
      if (typeof v === 'object') {
        const t = v.t ? ' t="' + v.t + '"' : (typeof v.v === 'string' ? ' t="str"' : typeof v.v === 'boolean' ? ' t="b"' : '');
        const s = v.s != null ? ' s="' + v.s + '"' : '';
        let f = '';
        if (v.f != null) f = '<f>' + esc(v.f) + '</f>';
        if (v.fShared) f = '<f t="shared" ref="' + v.fShared.ref + '" si="' + v.fShared.si + '">' + esc(v.fShared.f) + '</f>';
        if (v.fChild != null) f = '<f t="shared" si="' + v.fChild + '"/>';
        const val = v.v == null ? '' : '<v>' + esc(typeof v.v === 'boolean' ? (v.v ? 1 : 0) : v.v) + '</v>';
        return '<c r="' + ref + '"' + s + t + '>' + f + val + '</c>';
      }
      if (typeof v === 'number') return '<c r="' + ref + '"><v>' + v + '</v></c>';
      if (typeof v === 'boolean') return '<c r="' + ref + '" t="b"><v>' + (v ? 1 : 0) + '</v></c>';
      if (/^#(N\/A|DIV\/0!|REF!|VALUE!|NAME\?|NUM!|NULL!)$/.test(v)) return '<c r="' + ref + '" t="e"><v>' + esc(v) + '</v></c>';
      return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + esc(v) + '</t></is></c>';
    }).join('');
    return '<row r="' + r + '">' + cells + '</row>';
  }).join('');
}

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

async function makeXlsx(spec) {
  spec = spec || {};
  const sheets = spec.sheets || [{ name: 'Sheet1', sheetData: '' }];
  const files = [];
  const ct = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>';
  files.push(['[Content_Types].xml', ct]);
  files.push(['_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="' + REL + '/officeDocument" Target="xl/workbook.xml"/></Relationships>']);
  const wbSheets = sheets.map(function (s, i) {
    return '<sheet name="' + esc(s.name) + '" sheetId="' + (i + 1) + '"' + (s.state ? ' state="' + s.state + '"' : '') + ' r:id="rId' + (i + 10) + '"/>';
  }).join('');
  files.push(['xl/workbook.xml', '<?xml version="1.0"?><workbook ' + NS + '>' +
    (spec.date1904 ? '<workbookPr date1904="1"/>' : '<workbookPr/>') + '<sheets>' + wbSheets + '</sheets></workbook>']);
  // relationships listed in reverse order: the reader must follow workbook.xml order
  const rels = sheets.map(function (s, i) {
    const type = s.chart ? REL + '/chartsheet' : REL + '/worksheet';
    const target = s.chart ? 'chartsheets/sheet' + (i + 1) + '.xml' : 'worksheets/sheet' + (i + 1) + '.xml';
    return '<Relationship Id="rId' + (i + 10) + '" Type="' + type + '" Target="' + target + '"/>';
  }).reverse().join('');
  files.push(['xl/_rels/workbook.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    rels + '<Relationship Id="rId1" Type="' + REL + '/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId2" Type="' + REL + '/sharedStrings" Target="sharedStrings.xml"/></Relationships>']);
  const sst = (spec.sharedStrings || []).map(function (s) {
    return /^<(r|t)[ >]/.test(s) ? '<si>' + s + '</si>' : '<si><t>' + esc(s) + '</t></si>';
  }).join('');
  files.push(['xl/sharedStrings.xml', '<?xml version="1.0"?><sst ' + NS + ' count="' + (spec.sharedStrings || []).length + '">' + sst + '</sst>']);
  const numFmts = spec.numFmts || {};
  const nf = Object.keys(numFmts).map(function (id) { return '<numFmt numFmtId="' + id + '" formatCode="' + esc(numFmts[id]) + '"/>'; }).join('');
  const xfs = (spec.cellXfs || [0]).map(function (id) { return '<xf numFmtId="' + id + '" fontId="0" fillId="0" borderId="0" xfId="0"/>'; }).join('');
  files.push(['xl/styles.xml', '<?xml version="1.0"?><styleSheet ' + NS + '>' + (nf ? '<numFmts count="1">' + nf + '</numFmts>' : '') +
    '<cellStyleXfs count="1"><xf numFmtId="22" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="' + (spec.cellXfs || [0]).length + '">' + xfs + '</cellXfs></styleSheet>']);
  sheets.forEach(function (s, i) {
    if (s.chart) { files.push(['xl/chartsheets/sheet' + (i + 1) + '.xml', '<chartsheet ' + NS + '/>']); return; }
    const xml = s.xml || ('<?xml version="1.0"?><worksheet ' + NS + '>' + (s.dimension ? '<dimension ref="' + s.dimension + '"/>' : '') +
      '<sheetData>' + (s.sheetData || '') + '</sheetData>' + (s.extra || '') + '</worksheet>');
    files.push(['xl/worksheets/sheet' + (i + 1) + '.xml', xml]);
  });
  Object.keys(spec.files || {}).forEach(function (name) { files.push([name, spec.files[name]]); });
  const omit = spec.omit || [];
  return makeZip(files.filter(function (f) { return omit.indexOf(f[0]) < 0; }).map(function (f) {
    return { name: f[0], data: f[1], method: spec.method == null ? 8 : spec.method };
  }));
}

module.exports = { makeZip: makeZip, makeXlsx: makeXlsx, rowsXml: rowsXml, crc32: crc32, colLetters: colLetters };
