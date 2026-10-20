'use strict';
/* global TextEncoder */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const X = require('../web/lib/xlsx-reader.js');
const { makeZip, makeXlsx, rowsXml } = require('./fixtures/make-xlsx.js');

async function rejectsWith(promise, re) {
  await assert.rejects(promise, function (e) { assert.match(e.message, re); return true; });
}

test('reads shared strings (rich text, phonetic runs), inline strings, str, booleans, errors, numbers', async function () {
  const buf = await makeXlsx({
    sharedStrings: ['Symbol', '<r><rPr><b/></rPr><t>Bold</t></r><r><t xml:space="preserve"> part</t></r>', '<t>漢字</t><rPh sb="0" eb="1"><t>かんじ</t></rPh>', 'A & B', 'line_x000D__x000A_two'],
    sheets: [{
      name: 'Data',
      sheetData:
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c></row>' +
        '<row r="2"><c r="A2" t="inlineStr"><is><t>inline &lt;x&gt;</t></is></c><c r="B2" t="str"><f>"a"&amp;"b"</f><v>ab</v></c>' +
        '<c r="C2" t="b"><v>1</v></c><c r="D2" t="b"><v>0</v></c><c r="E2" t="e"><v>#N/A</v></c><c r="F2" t="e"><f>1/0</f><v>#DIV/0!</v></c></row>' +
        '<row r="3"><c r="A3"><v>42</v></c><c r="B3"><v>-1.5E-3</v></c><c r="C3" t="n"><v>3.14159</v></c><c r="D3" t="inlineStr"><is><r><t>rich</t></r><r><t> inline</t></r></is></c>' +
        '<c r="E3" t="s"><v>99</v></c></row>'
    }]
  });
  const wb = await X.readWorkbook(buf);
  assert.equal(wb.sheets.length, 1);
  const s = wb.sheets[0];
  assert.deepEqual(s.rows[0], ['Symbol', 'Bold part', '漢字', 'A & B', 'line\r\ntwo', null]);
  assert.deepEqual(s.rows[1], ['inline <x>', 'ab', true, false, '#N/A', '#DIV/0!']);
  assert.deepEqual(s.rows[2], [42, -0.0015, 3.14159, 'rich inline', null, null]);
  assert.deepEqual(s.dims, { rows: 3, cols: 6 });
  assert.equal(s.formulas[1][1], '"a"&"b"');
  assert.equal(s.formulas[1][5], '1/0');
  assert.ok(wb.warnings.some(function (w) { return /missing shared strings/.test(w); }), 'bad shared-string index is reported');
});

test('converts date serials with built-in and custom formats; keeps plain numbers', async function () {
  const buf = await makeXlsx({
    numFmts: { 164: 'dd/mm/yyyy', 165: 'dd/mm/yyyy hh:mm', 166: 'hh:mm', 167: '+0.00"%"', 168: '[h]:mm:ss', 169: '0.0%', 170: '[$-409]d-mmm-yy;@' },
    cellXfs: [0, 14, 164, 165, 166, 167, 168, 169, 22, 170, 45],
    sheets: [{
      name: 'Dates',
      sheetData: rowsXml([
        [{ v: 46286, s: 1 }, { v: 46286, s: 2 }, { v: 46286.5, s: 3 }, { v: 0.385416666666667, s: 4 }, { v: -3.88, s: 5 }],
        [{ v: 1.5, s: 6 }, { v: 0.0699, s: 7 }, { v: 46286.75, s: 8 }, { v: 60, s: 2 }, { v: 61, s: 2 }],
        [{ v: 1, s: 2 }, { v: 46286.4999999, s: 2 }, { v: 46286, s: 9 }, { v: 0.0104166666666667, s: 10 }, { v: 46286.9999999, s: 3 }],
        [{ t: 'd', v: '2026-09-21T00:00:00' }, { t: 'd', v: '2026-09-21T14:05:00Z' }]
      ])
    }]
  });
  const s = (await X.readWorkbook(buf)).sheets[0];
  assert.deepEqual(s.rows[0], ['2026-09-21', '2026-09-21', '2026-09-21 12:00', '09:15', -3.88]);
  assert.deepEqual(s.rows[1], ['36:00', 0.0699, '2026-09-21 18:00', '1900-02-29', '1900-03-01']);
  assert.deepEqual(s.rows[2], ['1900-01-01', '2026-09-21', '2026-09-21', '00:15', '2026-09-22 00:00']);
  assert.deepEqual(s.rows[3].slice(0, 2), ['2026-09-21', '2026-09-21 14:05']);
  assert.equal(s.numFmts[0][1], 'dd/mm/yyyy');
  assert.equal(s.numFmts[0][0], 'mm-dd-yy', 'built-in format 14 is reported by its code');
  assert.equal(s.numFmts[0][4], '+0.00"%"');
  assert.equal(s.numFmts[3][0], null);
});

test('honours the 1904 date system', async function () {
  const buf = await makeXlsx({ date1904: true, cellXfs: [0, 14], sheets: [{ name: 'S', sheetData: rowsXml([[{ v: 0, s: 1 }, { v: 44824, s: 1 }]]) }] });
  const wb = await X.readWorkbook(buf);
  assert.equal(wb.date1904, true);
  assert.deepEqual(wb.sheets[0].rows[0], ['1904-01-01', '2026-09-21']);
});

test('keeps formula text: plain, array, shared master; shared children are null but counted', async function () {
  const sheetData =
    '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><f>A1*2</f><v>2</v></c><c r="C1" t="str"><f t="shared" ref="C1:C3" si="0">"NSE:"&amp;A1</f><v>NSE:1</v></c></row>' +
    '<row r="2"><c r="A2"><v>2</v></c><c r="B2"><f t="array" ref="B2:B3">A2:A3*2</f><v>4</v></c><c r="C2" t="str"><f t="shared" si="0"/><v>NSE:2</v></c></row>' +
    '<row r="3"><c r="A3"><v>3</v></c><c r="B3"><v>6</v></c><c r="C3" t="str"><f t="shared" si="0"/><v>NSE:3</v></c><c r="D3"><f>NOVALUE()</f></c></row>';
  const s = (await X.readWorkbook(await makeXlsx({ sheets: [{ name: 'F', sheetData: sheetData }] }))).sheets[0];
  assert.deepEqual(s.rows.map(function (r) { return r[2]; }), ['NSE:1', 'NSE:2', 'NSE:3']);
  assert.deepEqual(s.formulas.map(function (r) { return r[1]; }), ['A1*2', 'A2:A3*2', null]);
  assert.deepEqual(s.formulas.map(function (r) { return r[2]; }), ['"NSE:"&A1', null, null]);
  assert.equal(s.formulas[2][3], 'NOVALUE()');
  assert.equal(s.rows[2][3], null, 'formula without cached value -> null');
  assert.deepEqual(s.sharedFormulas, [{ si: '0', ref: 'C1:C3', formula: '"NSE:"&A1', cell: 'C1', count: 2 }]);
  assert.equal(s.formulaCount, 6);
});

test('pads sparse rows and columns with null, handles missing r attributes and skips style-only cells', async function () {
  const sheetData =
    '<row r="2"><c r="C2"><v>5</v></c></row>' +
    '<row><c><v>1</v></c><c><v>2</v></c><c r="E3"><v>3</v></c><c><v>4</v></c></row>' +
    '<row r="5"><c r="A5" s="0"/><c r="B5" s="0"></c><c r="C5" t="str"><v></v></c></row>' +
    '<row r="7"><c r="AB7" t="inlineStr"><is><t>far</t></is></c></row>';
  const s = (await X.readWorkbook(await makeXlsx({ sheets: [{ name: 'Sparse', sheetData: sheetData }] }))).sheets[0];
  assert.deepEqual(s.dims, { rows: 7, cols: 28 });
  assert.equal(s.rows.length, 7);
  s.rows.forEach(function (r) { assert.equal(r.length, 28); });
  assert.equal(s.rows[0][0], null);
  assert.equal(s.rows[1][2], 5);
  assert.deepEqual(s.rows[2].slice(0, 6), [1, 2, null, null, 3, 4]);
  assert.ok(s.rows[4].every(function (v) { return v === null; }), 'style-only / empty-string spill cells are blank');
  assert.equal(s.rows[6][27], 'far');
  assert.equal(s.formulas.length, 7);
  assert.equal(s.numFmts[6].length, 28);
});

test('follows workbook.xml sheet order and states; opts.sheets limits parsing; chart sheets are skipped', async function () {
  const buf = await makeXlsx({
    sheets: [
      { name: 'Visible', sheetData: rowsXml([['a']]) },
      { name: 'Hidden', state: 'hidden', sheetData: rowsXml([['b']]) },
      { name: 'Deep', state: 'veryHidden', sheetData: rowsXml([['c']]) },
      { name: 'Chart1', chart: true },
      { name: 'Q&A <1>', sheetData: rowsXml([['d']]) }
    ]
  });
  const wb = await X.readWorkbook(buf);
  assert.deepEqual(wb.sheets.map(function (s) { return [s.name, s.state, s.rows[0][0]]; }),
    [['Visible', 'visible', 'a'], ['Hidden', 'hidden', 'b'], ['Deep', 'veryHidden', 'c'], ['Q&A <1>', 'visible', 'd']]);
  assert.equal(wb.sheetNames.length, 5);
  assert.ok(wb.warnings.some(function (w) { return /Chart1.*not a worksheet/.test(w); }));
  const only = await X.readWorkbook(buf, { sheets: ['hidden', 'Q&A <1>'] });
  assert.deepEqual(only.sheets.map(function (s) { return s.name; }), ['Hidden', 'Q&A <1>']);
  assert.equal(only.sheetNames.length, 5, 'sheetNames still lists every sheet');
});

test('maxRowsPerSheet truncates with a warning; merges are reported', async function () {
  const rows = [];
  for (let i = 0; i < 50; i++) rows.push([i, 'r' + i]);
  const buf = await makeXlsx({ sheets: [{ name: 'Long', dimension: 'A1:B50', sheetData: rowsXml(rows), extra: '<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>' }] });
  const full = (await X.readWorkbook(buf)).sheets[0];
  assert.equal(full.dims.rows, 50);
  assert.equal(full.truncated, false);
  assert.deepEqual(full.merges, ['A1:B1']);
  const wb = await X.readWorkbook(buf, { maxRowsPerSheet: 10 });
  assert.equal(wb.sheets[0].dims.rows, 10);
  assert.equal(wb.sheets[0].truncated, true);
  assert.equal(wb.sheets[0].totalRowsHint, 50);
  assert.ok(wb.warnings.some(function (w) { return /truncated at 10 rows/.test(w); }));
});

test('blank array-formula spill rows beyond maxRowsPerSheet do not count as truncation', async function () {
  let xml = rowsXml([['Symbol'], ['TCS']]);
  for (let r = 3; r <= 40; r++) xml += '<row r="' + r + '"><c r="A' + r + '" t="str"><v></v></c></row>';
  const wb = await X.readWorkbook(await makeXlsx({ sheets: [{ name: 'Spill', sheetData: xml }] }), { maxRowsPerSheet: 10 });
  assert.equal(wb.sheets[0].truncated, false);
  assert.deepEqual(wb.sheets[0].dims, { rows: 2, cols: 1 });
  assert.deepEqual(wb.warnings, []);
});

test('reads stored (uncompressed) entries and a namespaced, commented, CDATA-bearing worksheet', async function () {
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE x [ <!ENTITY boom "BOOM"> ]>\n' +
    '<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">\n' +
    '  <!-- <c r="Z9"><v>1</v></c> must be ignored -->\n' +
    '  <x:sheetData>\n' +
    '    <x:row r="1">\n' +
    '      <x:c r="A1" t="inlineStr" data-x="a>b"><x:is><x:t><![CDATA[<raw & text>]]></x:t></x:is></x:c>\n' +
    '      <x:c r="B1" t="inlineStr"><x:is><x:t>&#65;&#x42;&amp;&boom;&quot;&apos;</x:t></x:is></x:c>\n' +
    '      <x:c r=\'C1\'><x:v>7</x:v></x:c>\n' +
    '    </x:row>\n' +
    '  </x:sheetData>\n' +
    '</x:worksheet>';
  const buf = await makeXlsx({ method: 0, sheets: [{ name: 'NS', xml: xml }] });
  const s = (await X.readWorkbook(buf)).sheets[0];
  assert.deepEqual(s.rows, [['<raw & text>', 'AB&&boom;"\'', 7]], 'no DTD entity expansion');
});

test('rejects files that are not a safe, plain .xlsx', async function () {
  await rejectsWith(X.readWorkbook(new Uint8Array(10)), /Not an \.xlsx workbook/);
  await rejectsWith(X.readWorkbook(new TextEncoder().encode('hello, this is a plain text file, not a zip at all')), /Not an \.xlsx workbook/);
  const cfb = new Uint8Array(512); cfb.set([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
  await rejectsWith(X.readWorkbook(cfb), /old \.xls file or a password-protected/);
  await rejectsWith(X.readWorkbook(await makeZip([{ name: 'hello.txt', data: 'hi' }])), /^Not an \.xlsx workbook$/);
  await rejectsWith(X.readWorkbook(await makeXlsx({ omit: ['xl/workbook.xml'] })), /^Not an \.xlsx workbook$/);
  await rejectsWith(X.readWorkbook(await makeXlsx({ omit: ['[Content_Types].xml'] })), /^Not an \.xlsx workbook$/);
  await rejectsWith(X.readWorkbook(await makeZip([{ name: '[Content_Types].xml', data: '<Types/>' }, { name: 'xl/workbook.bin', data: 'x' }])), /xlsb/);
  await rejectsWith(X.readWorkbook(await makeZip([{ name: '[Content_Types].xml', data: '<Types/>', flags: 1 }])), /Encrypted/);
  await rejectsWith(X.readWorkbook(await makeZip([{ name: 'a', data: 'a' }], { zip64Locator: true })), /ZIP64/);
  await rejectsWith(X.readWorkbook(await makeZip([{ name: 'a', data: 'a' }], { eocdEntries: 0xFFFF })), /ZIP64/);
  await rejectsWith(X.readWorkbook(await makeZip([{ name: 'a', data: 'a' }, { name: 'b', data: 'b' }, { name: 'c', data: 'c' }]), { maxEntries: 2 }), /too many parts/);
  await rejectsWith(X.readWorkbook(await makeZip([{ name: 'a', data: 'x', usize: 300 * 1024 * 1024 }])), /too large/);
  await rejectsWith(X.readWorkbook(await makeXlsx({}), { maxTotalBytes: 100 }), /too large/);
});

test('detects corrupt entries: bad CRC, size lies (zip bomb guard), truncated data, bad deflate stream', async function () {
  const good = await makeXlsx({ sheets: [{ name: 'S', sheetData: rowsXml([[1]]) }] });
  // corrupt the CRC of xl/workbook.xml via a rebuilt archive
  const parts = [
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'xl/workbook.xml', data: '<workbook><sheets/></workbook>', crc: 12345 }
  ];
  await rejectsWith(X.readWorkbook(await makeZip(parts)), /checksum mismatch/);
  const lie = [{ name: '[Content_Types].xml', data: '<Types/>' }, { name: 'xl/workbook.xml', data: '<workbook>' + 'x'.repeat(5000) + '</workbook>', usize: 100 }];
  await rejectsWith(X.readWorkbook(await makeZip(lie)), /beyond its declared size|size mismatch/);
  await rejectsWith(X.readWorkbook(good.subarray(0, good.length - 30)), /Not an \.xlsx workbook|Corrupt/);
  // a deflate stream that is not valid deflate data
  const badDeflate = [{ name: '[Content_Types].xml', data: '<Types/>' }, { name: 'xl/workbook.xml', data: '<workbook/>', rawBody: new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x13]) }];
  await rejectsWith(X.readWorkbook(await makeZip(badDeflate)), /Corrupt ZIP: cannot decompress xl\/workbook\.xml/);
});

test('macros, external links and embedded objects are ignored with warnings', async function () {
  const buf = await makeXlsx({
    sheets: [{ name: 'S', sheetData: rowsXml([['ok']]) }],
    files: { 'xl/vbaProject.bin': 'Attribute VB_Name = "Evil"', 'xl/externalLinks/externalLink1.xml': '<externalLink/>', 'xl/embeddings/oleObject1.bin': 'x' }
  });
  const wb = await X.readWorkbook(buf);
  assert.equal(wb.hasMacros, true);
  assert.equal(wb.sheets[0].rows[0][0], 'ok');
  assert.ok(wb.warnings.some(function (w) { return /Macros found.*never executed/.test(w); }));
  assert.ok(wb.warnings.some(function (w) { return /External links/.test(w); }));
  assert.ok(wb.warnings.some(function (w) { return /Embedded objects/.test(w); }));
});

test('accepts ArrayBuffer and Buffer input and reports progress', async function () {
  const buf = await makeXlsx({ sheets: [{ name: 'A', sheetData: rowsXml([[1]]) }, { name: 'B', sheetData: rowsXml([[2]]) }] });
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const seen = [];
  const wb = await X.readWorkbook(ab, { onProgress: function (p) { seen.push(p.phase + ':' + (p.sheet || '')); } });
  assert.deepEqual(wb.sheets.map(function (s) { return s.rows[0][0]; }), [1, 2]);
  assert.deepEqual(seen, ['workbook:', 'sheet:A', 'sheet:B', 'done:']);
  const fromBuffer = await X.readWorkbook(Buffer.from(buf));
  assert.equal(fromBuffer.sheets.length, 2);
  await rejectsWith(X.readWorkbook('not bytes'), /Not an \.xlsx workbook/);
});

test('helpers: parseXml, decodeEntities, refs, formatInfo, serialToIso', function () {
  const events = [];
  X.parseXml('<a x="1" y=\'2 > 3\'><b/>t&amp;x<c:d>z</c:d></a>', {
    open: function (n, a, sc) { events.push('<' + n + JSON.stringify(a) + (sc ? '/' : '')); },
    close: function (n) { events.push('</' + n); },
    text: function (t) { events.push('#' + t); }
  });
  assert.deepEqual(events, ['<a{"x":"1","y":"2 > 3"}', '<b{}/', '#t&x', '<d{}', '#z', '</d', '</a']);
  assert.equal(X.decodeEntities('&lt;&#x1F600;&#9731;&bogus;&#xD800;'), '<\u{1F600}☃&bogus;�');
  assert.deepEqual(X.parseRef('AB12'), { row: 11, col: 27 });
  assert.deepEqual(X.parseRef('$XFD$1048576'), { row: 1048575, col: 16383 });
  assert.equal(X.parseRef('12'), null);
  assert.equal(X.colToLetters(0), 'A');
  assert.equal(X.colToLetters(27), 'AB');
  assert.equal(X.colToLetters(16383), 'XFD');
  assert.equal(X.lettersToCol('ab'), 27);
  assert.deepEqual(X.parseRange('B2:A1'), { r0: 0, c0: 0, r1: 1, c1: 1 });
  assert.equal(X.isDateFormat('dd/mm/yyyy'), true);
  assert.equal(X.isDateFormat('0.00"x"'), false);
  assert.equal(X.isDateFormat('"₹"#,##0.00'), false);
  assert.equal(X.isDateFormat('General'), false);
  assert.equal(X.isDateFormat('+0.00"%";-0.00"%";0.00"%"'), false);
  assert.deepEqual(X.formatInfo('h:mm AM/PM'), { date: false, time: true, elapsed: false, percent: false });
  assert.deepEqual(X.formatInfo('mmm-yy'), { date: true, time: false, elapsed: false, percent: false });
  assert.deepEqual(X.formatInfo('mm:ss'), { date: false, time: true, elapsed: false, percent: false });
  assert.equal(X.formatInfo('0.0%').percent, true);
  assert.equal(X.formatInfo('0.0"%"').percent, false);
  assert.equal(X.serialToIso(45000, false, { date: true }), '2023-03-15');
  assert.equal(X.serialToIso(-1, false, { date: true }), null);
  assert.equal(X.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
});

// ---------------------------------------------------------------- real file
const REAL = process.env.SB_REAL_XLSX || '/tmp/claude-0/-home-user/72385330-b2ce-55e6-a364-e92f580f4fef/scratchpad/xlsx/sb.xlsx';

test('real workbook (only when available): parses quickly and matches known structure', { skip: !fs.existsSync(REAL) && 'real workbook not present' }, async function () {
  const t0 = Date.now();
  const wb = await X.readWorkbook(fs.readFileSync(REAL), { maxRowsPerSheet: 200000 });
  const ms = Date.now() - t0;
  assert.ok(ms < 20000, 'parse took ' + ms + ' ms');
  assert.ok(wb.sheets.length >= 30);
  const main = wb.sheets.find(function (s) { return s.name === 'Main'; });
  assert.ok(main, 'Main sheet');
  const hdr = main.rows[1];
  ['Checkbox', 'StockName', 'Sector', 'Industry', 'Basic Industry', 'SYMBOL', 'Result Date', 'MKT Price', '% Change'].forEach(function (h) {
    assert.ok(hdr.indexOf(h) >= 0, 'Main row 2 has header ' + h);
  });
  const row = main.rows[2];
  assert.equal(typeof row[hdr.indexOf('SYMBOL')], 'string');
  const rd = row[hdr.indexOf('Result Date')];
  assert.ok(rd === null || /^\d{4}-\d{2}-\d{2}$/.test(rd), 'Result Date is ISO: ' + rd);
  assert.equal(main.numFmts[2][hdr.indexOf('Result Date')], 'dd/mm/yyyy');
  const chg = row[hdr.indexOf('% Change')];
  assert.ok(typeof chg === 'number' || /^#/.test(String(chg)));
  assert.equal(typeof row[hdr.indexOf('Checkbox')], 'boolean');
  assert.ok(wb.sheets.some(function (s) { return s.state === 'hidden'; }));
  const big = wb.sheets.reduce(function (m, s) { return Math.max(m, s.dims.rows); }, 0);
  assert.ok(big > 20000, 'largest sheet has ' + big + ' rows');
});
