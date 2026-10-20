'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const A = require('../web/lib/workbook-analysis.js');
const X = require('../web/lib/xlsx-reader.js');
const { makeXlsx, rowsXml } = require('./fixtures/make-xlsx.js');

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;

/** Reader-shaped sheet from plain rows (formulas / numFmts as sparse { 'r,c': value } maps). */
function sheetOf(name, rows, extra) {
  extra = extra || {};
  const cols = rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
  const pad = function (r) { const o = r.slice(); while (o.length < cols) o.push(null); return o.map(function (v) { return v === undefined ? null : v; }); };
  const grid = function (map) {
    return rows.map(function (r, ri) {
      const o = [];
      for (let c = 0; c < cols; c++) o.push(map && map[ri + ',' + c] != null ? map[ri + ',' + c] : null);
      return o;
    });
  };
  return {
    name: name, state: extra.state || 'visible', rows: rows.map(pad),
    formulas: grid(extra.formulas), numFmts: grid(extra.numFmts),
    dims: { rows: rows.length, cols: cols }, merges: [], sharedFormulas: extra.sharedFormulas || [],
    formulaCount: extra.formulaCount || 0, truncated: false
  };
}

function block(a, i) { return a.blocks[i == null ? a.primaryBlock : i]; }
function col(b, header) { return b.columns.find(function (c) { return c.header === header; }); }
function roundTrip(x) { return JSON.parse(JSON.stringify(x)); }

const STOCKS = [
  ['RELIANCE', 'Reliance Industries Ltd', 'Energy', 'Oil Gas & Consumable Fuels', 'Refineries & Marketing', 2850.5],
  ['TCS', 'Tata Consultancy Services', 'Information Technology', 'IT - Software', 'Computers - Software & Consulting', 3990],
  ['M&M', 'Mahindra & Mahindra', 'Automobile and Auto Components', 'Automobiles', 'Passenger Cars & Utility Vehicles', 2800.25],
  ['BAJAJ-AUTO', 'Bajaj Auto Ltd', 'Automobile and Auto Components', 'Automobiles', '2/3 Wheelers', 9100]
];

function masterMap() {
  const m = {};
  STOCKS.forEach(function (s) { m[s[0]] = { sector: s[2], industry: s[3], basicIndustry: s[4] }; });
  return m;
}

test('detects the header below title rows and reports the title and refresh text', function () {
  const s = sheetOf('Pivot', [
    ['BASIC INDUSTRY MOVEMENT'],
    ['Updated: 20-Oct-2026 11:23 - 185 industries'],
    [],
    ['Basic Industry', 'Stocks', 'Avg % Change', 'Advancers'],
    ['Pharmaceuticals', 12, 1.25, 7],
    ['Cement', 5, -0.4, 2],
    ['Banks', 9, 0.1, 5]
  ], { numFmts: { '4,2': '0.00"%"', '5,2': '0.00"%"', '6,2': '0.00"%"' } });
  const a = A.analyzeSheet(s);
  assert.equal(a.ok, true);
  assert.equal(a.blockCount, 1);
  assert.equal(a.headerRow, 4);
  const b = block(a);
  assert.equal(b.firstDataRow, 5);
  assert.equal(b.lastDataRow, 7);
  assert.equal(b.dataRows, 3);
  assert.deepEqual(b.title, ['BASIC INDUSTRY MOVEMENT', 'Updated: 20-Oct-2026 11:23 - 185 industries']);
  assert.equal(a.updated, '20-Oct-2026 11:23 - 185 industries');
  assert.equal(col(b, 'Avg % Change').type, 'percent');
  assert.equal(col(b, 'Avg % Change').pctScale, 'percent');
});

test('prefers a wide header row under a sparse group-header row (Main layout)', function () {
  const rows = [
    [true, 'Identity', null, 'Results', 'Price'],
    ['Checkbox', 'StockName', 'SYMBOL', 'Result Date', 'MKT Price', '% Change']
  ];
  STOCKS.forEach(function (st, i) { rows.push([i % 2 === 0, st[1], st[0], '2026-09-2' + i, st[5], i - 1.5]); });
  const a = A.analyzeSheet(sheetOf('Main', rows));
  const b = block(a);
  assert.equal(b.headerRow, 2);
  assert.equal(b.groupHeaderRow, 1);
  assert.equal(col(b, 'StockName').group, 'Identity');
  assert.equal(col(b, 'MKT Price').group, 'Price');
  assert.equal(col(b, 'Checkbox').group, undefined, 'a boolean is not a group label');
  assert.equal(col(b, 'Checkbox').type, 'bool');
  assert.equal(col(b, 'Result Date').type, 'date');
  assert.equal(col(b, 'Result Date').minDate, '2026-09-20');
  assert.equal(col(b, 'Result Date').maxDate, '2026-09-23');
  assert.equal(b.symbolColumn.header, 'SYMBOL');
  assert.equal(b.symbolColumn.detectedBy, 'header');
  assert.equal(b.nameColumn.header, 'StockName');
});

test('splits multi-block sheets at blank separators; a blank row inside data stays in its block', function () {
  const s = sheetOf('Dashboard', [
    ['Alert Type', 'Total', 'Win', 'Open'],
    ['Breakout', 8, 0, 8],
    ['Price Fall', 9, 1, 6],
    [],
    ['RECENT ALERTS (latest 20)'],
    ['Date', 'Symbol', 'Type', 'Trigger Price'],
    ['2026-10-01', 'TCS', 'Breakout', 3990],
    [],
    ['2026-10-02', 'INFY', 'Price Fall', 1500],
    ['2026-10-03', 'WIPRO', 'Breakout', 250],
    [],
    [],
    ['Alert Type', 'Avg %'],
    ['Breakout', -3.18]
  ]);
  const a = A.analyzeSheet(s);
  assert.equal(a.blockCount, 3);
  const [b0, b1, b2] = a.blocks;
  assert.deepEqual([b0.headerRow, b0.firstDataRow, b0.lastDataRow, b0.dataRows], [1, 2, 3, 2]);
  assert.deepEqual([b1.headerRow, b1.firstDataRow, b1.lastDataRow, b1.dataRows], [6, 7, 10, 3]);
  assert.deepEqual(b1.title, ['RECENT ALERTS (latest 20)']);
  assert.equal(b1.quality.blankRowsInside, 1);
  assert.deepEqual(b1.quality.blankRows, [8]);
  assert.deepEqual([b2.headerRow, b2.dataRows], [13, 1]);
  assert.equal(a.primaryBlock, 1);
  assert.equal(a.quality.blankRowsInside, 1);
  assert.equal(b1.symbolColumn.header, 'Symbol');
});

test('profiles columns: types, fill, distinct, min/max/mean, samples, formats, formulas', function () {
  const rows = [['Symbol', 'Close', 'Chg %', '10 day%', 'Listed', 'Active', 'Note', 'Mixed', 'Blank']];
  for (let i = 0; i < 20; i++) {
    rows.push(['S' + String.fromCharCode(65 + i), 100 + i, i - 10, (i - 10) / 100, '2026-01-' + String(10 + i).padStart(2, '0'), i % 3 === 0,
      i < 5 ? 'n' + (i % 2) : null, i % 2 ? 'x' : 5, null]);
  }
  const formulas = {}, numFmts = {};
  for (let r = 1; r <= 20; r++) { formulas[r + ',2'] = 'B' + (r + 1) + '/100'; numFmts[r + ',2'] = '+0.00"%"'; numFmts[r + ',3'] = '0.0%'; }
  const shared = [{ si: '0', ref: 'B2:B21', formula: 'GOOGLEFINANCE(A2)', cell: 'B2', count: 19 }];
  formulas['1,1'] = 'GOOGLEFINANCE(A2)';
  const a = A.analyzeSheet(sheetOf('Prices', rows, { formulas: formulas, numFmts: numFmts, sharedFormulas: shared }), { maxSamples: 3 });
  const b = block(a);
  const close = col(b, 'Close');
  assert.equal(close.type, 'number');
  assert.deepEqual([close.min, close.max, close.mean], [100, 119, 109.5]);
  assert.deepEqual(close.samples, [100, 101, 102]);
  assert.equal(close.distinct, 20);
  assert.equal(close.fillPct, 100);
  assert.equal(close.formula.cells, 20);
  assert.equal(close.formula.shared, true);
  assert.equal(close.formula.example, 'GOOGLEFINANCE(A2)');
  const chg = col(b, 'Chg %');
  assert.equal(chg.type, 'percent');
  assert.equal(chg.pctScale, 'percent');
  assert.equal(chg.numFmt, '+0.00"%"');
  assert.equal(chg.formula.cells, 20);
  assert.equal(col(b, '10 day%').pctScale, 'fraction');
  assert.equal(col(b, 'Listed').type, 'date');
  assert.equal(col(b, 'Active').type, 'bool');
  assert.equal(col(b, 'Note').type, 'text');
  assert.equal(col(b, 'Note').fillPct, 25);
  assert.equal(col(b, 'Note').missing, 15);
  assert.equal(col(b, 'Note').distinct, 2);
  assert.equal(col(b, 'Mixed').type, 'mixed');
  assert.equal(col(b, 'Blank').type, 'empty');
  assert.ok(b.quality.missing.some(function (m) { return m.header === 'Blank' && m.missing === 20 && m.missingPct === 100; }));
});

test('data quality: duplicates, errors, inconsistent symbols, invalid prices, text dates, numbers as text', function () {
  const s = sheetOf('Tracker', [
    ['Symbol', 'Company', 'Result Date', 'MKT Price', 'Checks', 'PE Ratio'],
    ['TCS', 'Tata Consultancy', '01/10/2026', 3990, '16', 30],
    ['tcs ', 'Tata Consultancy', '02/10/2026', 3991, '8', '#N/A'],
    ['INFY', 'Infosys', '03/10/2026', 0, '7', '#DIV/0!'],
    ['TCS', 'Tata again', '04/10/2026', 'n/a', '7', 22],
    ['BAD SYM!', 'Weird', '05/10/2026', -5, '6', '#N/A'],
    ['M&M', 'Mahindra', '06/10/2026', '618..35', '5', 15],
    ['NSE:BAJAJ-AUTO', 'Bajaj', '07/10/2026', 9100, '4', 18]
  ]);
  const a = A.analyzeSheet(s);
  const q = block(a).quality;
  assert.equal(q.duplicateKeys.duplicateRows, 2, 'TCS x3 (one with lowercase + space)');
  assert.deepEqual(q.duplicateKeys.keys[0], { key: 'TCS', count: 3, rows: [2, 3, 5] });
  assert.deepEqual(q.duplicateKeys.keyColumns, ['Symbol']);
  assert.equal(q.errors.total, 3);
  assert.deepEqual(q.errors.byType, { '#N/A': 2, '#DIV/0!': 1 });
  assert.deepEqual(q.errors.cells, ['F3', 'F4', 'F6']);
  assert.equal(q.inconsistentSymbols.count, 2);
  assert.deepEqual(q.inconsistentSymbols.items[0], { row: 3, value: 'tcs', issues: ['space', 'lowercase'] });
  assert.deepEqual(q.inconsistentSymbols.items[1].issues, ['space', 'invalid chars']);
  const price = q.invalidPrices.find(function (p) { return p.header === 'MKT Price'; });
  assert.equal(price.count, 4);
  assert.deepEqual(price.cells.map(function (c) { return c.cell; }), ['D4', 'D5', 'D6', 'D7']);
  assert.deepEqual(price.cells[3], { cell: 'D7', value: '618..35' });
  assert.ok(!q.invalidPrices.some(function (p) { return p.header === 'PE Ratio'; }));
  assert.deepEqual(q.textDates, [{ column: 'C', header: 'Result Date', count: 7 }]);
  assert.deepEqual(q.numbersAsText, [{ column: 'E', header: 'Checks', count: 7 }]);
  assert.equal(a.errorCells, 3);
  assert.equal(a.quality.duplicateRows, 2);
});

test('long-format sheets use symbol + date as the key', function () {
  const rows = [['Symbol', 'Date', 'Close']];
  ['AAA', 'BBB'].forEach(function (sym) { for (let d = 1; d <= 5; d++) rows.push([sym, '2026-09-0' + d, d]); });
  rows.push(['AAA', '2026-09-05', 9]);
  const q = block(A.analyzeSheet(sheetOf('History30', rows))).quality;
  assert.deepEqual(q.duplicateKeys.keyColumns, ['Symbol', 'Date']);
  assert.equal(q.duplicateKeys.duplicateRows, 1);
  assert.equal(q.duplicateKeys.keys[0].key, 'AAA|2026-09-05');
});

test('finds a symbol column by content when no header matches', function () {
  const rows = [['TckrSymb', 'OpnPric', 'ClsPric', 'Series']];
  ['AEROFLEX', 'GANESHCP', 'RUBICON', 'ACC', '360ONE'].forEach(function (s, i) { rows.push([s, 100 + i, 101 + i, 'EQ']); });
  const b = block(A.analyzeSheet(sheetOf('Today', rows)));
  assert.equal(b.symbolColumn.header, 'TckrSymb');
  assert.equal(b.symbolColumn.detectedBy, 'content');
  const idx = [['Index', 'Count'], ['NIFTY50', 50], ['NIFTYNEXT50', 50], ['MIDCAP150', 150], ['SMALLCAP250', 250]];
  assert.equal(block(A.analyzeSheet(sheetOf('Index Legend', idx))).symbolColumn, null, 'index names are not stock symbols');
});

test('reconciles symbols with the master: matched, unmatched and industry conflicts', function () {
  const rows = [['Symbol', 'Sector', 'Industry', 'Price']];
  rows.push(['RELIANCE', 'Energy', 'Refineries & Marketing', 2850]);
  rows.push(['TCS', 'Information Technology', 'Computers - Software & Consulting', 3990]);
  rows.push(['M&M', 'Automobiles', 'Passenger Cars & Utility Vehicles', 2800]);
  rows.push(['NEWCO', 'Finance', 'NBFC', 10]);
  rows.push(['NSE:BAJAJ-AUTO', 'Automobile and Auto Components', 'Scooters', 9100]);
  const b = block(A.analyzeSheet(sheetOf('Watch', rows), { master: masterMap() }));
  const rec = b.reconciliation;
  assert.equal(rec.symbols, 5);
  assert.equal(rec.matched, 4);
  assert.equal(rec.unmatched, 1);
  assert.deepEqual(rec.unmatchedSymbols, ['NEWCO']);
  assert.equal(rec.matchedPct, 80);
  assert.deepEqual(rec.fieldsChecked, [{ column: 'Sector', field: 'sector' }, { column: 'Industry', field: 'basicIndustry' }],
    'an "Industry" column holding basic industries is compared with basicIndustry');
  assert.equal(rec.conflictCount, 2);
  assert.deepEqual(rec.conflicts.map(function (c) { return [c.symbol, c.field, c.sheet, c.master]; }), [
    ['M&M', 'sector', 'Automobiles', 'Automobile and Auto Components'],
    ['BAJAJ-AUTO', 'basicIndustry', 'Scooters', '2/3 Wheelers']
  ]);
  assert.equal(b.industryDistribution.source, 'sheet');
  assert.equal(b.industryDistribution.column, 'Industry');
  assert.equal(b.industryDistribution.distinct, 5);
  assert.equal(b.sectorDistribution.counts.length, 5);
});

test('industry distribution falls back to the master when the sheet has no industry column', function () {
  const rows = [['Symbol', 'Close'], ['M&M', 1], ['BAJAJ-AUTO', 2], ['TCS', 3], ['M&M', 4], ['UNKNOWN', 5]];
  const b = block(A.analyzeSheet(sheetOf('Closes', rows), { master: masterMap() }));
  assert.equal(b.industryDistribution.source, 'master');
  assert.equal(b.industryDistribution.field, 'industry');
  assert.deepEqual(b.industryDistribution.counts[0], { name: 'Automobiles', rows: 3, symbols: 2 });
  assert.equal(b.industryDistribution.unknownRows, 1);
  assert.equal(b.sectorDistribution.source, 'master');
  assert.equal(A.analyzeSheet(sheetOf('Closes', rows)).blocks[0].industryDistribution, undefined);
});

test('flags strategy columns by header or formula and lists categorical values', function () {
  const rows = [['Symbol', 'TTM Signal', 'Upside Potential', 'Remarks', 'Calc', 'Pattern']];
  const sig = ['Buy', 'Avoid', 'Avoid', 'Buy', 'Avoid', 'Avoid'];
  sig.forEach(function (sg, i) { rows.push(['S' + i, sg, 0.1 * i, 'note', i, i % 2 ? 'Spring' : 'Bullish Harami']); });
  const formulas = {};
  for (let r = 1; r <= 6; r++) formulas[r + ',4'] = 'IF(B' + (r + 1) + '="Buy",1,0)';
  const st = block(A.analyzeSheet(sheetOf('Main', rows, { formulas: formulas }))).strategyColumns;
  const byHeader = {};
  st.forEach(function (s) { byHeader[s.header] = s; });
  assert.deepEqual(Object.keys(byHeader).sort(), ['Calc', 'Pattern', 'TTM Signal', 'Upside Potential']);
  assert.deepEqual(byHeader['TTM Signal'].values, [{ value: 'Avoid', count: 4 }, { value: 'Buy', count: 2 }]);
  assert.deepEqual(byHeader['TTM Signal'].reasons, ['header']);
  assert.deepEqual(byHeader.Calc.reasons, ['formula']);
  assert.deepEqual(byHeader.Calc.keywords, ['buy']);
  assert.equal(byHeader.Calc.formula, 'IF(B2="Buy",1,0)');
  assert.equal(byHeader['Upside Potential'].values, undefined, 'numeric columns have no value list');
});

test('personal sheets: detected by name, headers or e-mail; publicMode keeps structure only', function () {
  const pf = sheetOf('Portfolio', [
    ['Portfolio Summary - capital 5,00,000'],
    ['Symbol', 'Qty', 'Avg Buy Price', 'Buy Value', 'Profit / Loss (₹)', 'Status'],
    ['TCS', 10, 3500, 35000, 4900, 'Holding'],
    ['INFY', 5, 1400, 7000, -250, 'Sold']
  ], { formulas: { '2,3': 'B3*C3' } });
  const priv = A.analyzeSheet(pf);
  assert.equal(priv.personal, true);
  assert.ok(priv.personalReasons.indexOf('sheet name') >= 0);
  assert.ok(col(block(priv), 'Qty').samples, 'values are kept outside publicMode');
  const pub = A.analyzeSheet(pf, { publicMode: true });
  assert.equal(pub.publicStructureOnly, true);
  const b = block(pub);
  assert.equal(b.title, undefined);
  assert.equal(b.reconciliation, undefined);
  b.columns.forEach(function (c) {
    assert.deepEqual(Object.keys(c).filter(function (k) { return ['samples', 'min', 'max', 'mean', 'distinct', 'minDate', 'maxDate'].indexOf(k) >= 0; }), [], c.header);
    if (c.formula) assert.equal(c.formula.example, undefined);
  });
  assert.deepEqual(b.columns.map(function (c) { return c.header; }), ['Symbol', 'Qty', 'Avg Buy Price', 'Buy Value', 'Profit / Loss (₹)', 'Status']);
  assert.equal(col(b, 'Qty').type, 'number');
  const text = JSON.stringify(pub);
  ['35000', '4900', 'Holding', '5,00,000', 'B3*C3', 'TCS'].forEach(function (v) { assert.ok(text.indexOf(v) < 0, 'leaked ' + v); });

  const byHeader = A.analyzeSheet(sheetOf('Sheet7', [['Symbol', 'Quantity', 'Price'], ['TCS', 3, 10], ['INFY', 4, 11]]), { publicMode: true });
  assert.equal(byHeader.personal, true);
  assert.match(byHeader.personalReasons[0], /Quantity/);
  const notPersonal = A.analyzeSheet(sheetOf('Main', [['Symbol', 'Net Profit', 'Win/Loss', 'Working Capital'], ['TCS', 10, 'Win', 5], ['INFY', 1, 'Loss', 6]]));
  assert.equal(notPersonal.personal, false, '"Net Profit" / "Win/Loss" / "Working Capital" are company / alert data');

  const mail = sheetOf('Settings', [['Setting', 'Value', 'Notes'], ['EMAIL_TO', 'someone@example.com', 'alerts'], ['MAX', 5, 'x']]);
  const m = A.analyzeSheet(mail, { publicMode: true });
  assert.equal(m.personal, true);
  assert.deepEqual(m.personalReasons, ['e-mail address']);
  assert.ok(!EMAIL.test(JSON.stringify(m)));
});

test('publicMode on normal sheets: redacts personal columns and Entry rows, masks e-mails', function () {
  const rows = [['Date', 'Symbol', 'Alert Type', 'Trigger Price', 'Entry Price', 'Notes']];
  rows.push(['2026-08-09', 'SBIN', 'Breakout', 1097.2, null, 'ok']);
  rows.push(['2026-08-16', 'HFCL', 'Entry', 222.76, 222.76, 'contact me: trader@example.org']);
  rows.push(['2026-08-17', 'LODHA', 'Price Fall', 1250.9, null, 'ok']);
  const sheet = sheetOf('Signals', rows);
  sheet.rows[2][5] = 'mine';
  assert.equal(A.analyzeSheet(sheetOf('Alert Log', rows), { publicMode: true }).personalReasons[0], 'sheet name', 'the owner\'s alert sheets are structure only');
  const a = A.analyzeSheet(sheet, { publicMode: true });
  assert.equal(a.personal, false);
  const b = block(a);
  assert.equal(col(b, 'Entry Price').redacted, true);
  assert.equal(col(b, 'Entry Price').samples, undefined);
  // alert levels / triggers reveal the owner's positions too: structure only
  const trig = col(b, 'Trigger Price');
  assert.equal(trig.redacted, true);
  assert.equal(trig.samples, undefined);
  assert.equal(trig.max, undefined);
  const notes = col(b, 'Notes');
  assert.ok(Array.isArray(notes.samples) && notes.samples.indexOf('mine') < 0, 'the Entry row is not sampled');
  assert.ok(JSON.stringify(a).indexOf('222.76') < 0);
  assert.ok(JSON.stringify(a).indexOf('1097.2') < 0);
  const withMail = sheetOf('Signals', rows);
  const pm = A.analyzeSheet(withMail, { publicMode: true });
  assert.equal(pm.personal, true, 'an e-mail anywhere makes the sheet personal');
  assert.ok(!EMAIL.test(JSON.stringify(pm)));
});

test('results are plain JSON and bad input never throws', function () {
  const a = A.analyzeSheet(sheetOf('X', [['Symbol', 'Price'], ['TCS', 1], ['INFY', '#N/A']]), { master: masterMap() });
  assert.deepEqual(roundTrip(a), a);
  assert.deepEqual(A.analyzeSheet(null), { ok: false, reason: 'not a sheet (expected reader output with rows[])' });
  assert.equal(A.analyzeSheet({ rows: 'nope' }).ok, false);
  assert.equal(A.analyzeWorkbook(undefined).ok, false);
  const empty = A.analyzeSheet({ name: 'E', rows: [] });
  assert.equal(empty.ok, true);
  assert.equal(empty.blockCount, 0);
  const ragged = A.analyzeSheet({ name: 'R', rows: [['a', 'b', 'c'], [1], [], [undefined, 2, 3, 4]] });
  assert.equal(ragged.ok, true);
  const noHeader = A.analyzeSheet(sheetOf('N', [[1, 2], [3, 4]]));
  assert.equal(noHeader.headerRow, null);
  assert.equal(noHeader.dataRows, 2);
});

test('buildMaster reads SYMBOL / Sector / Industry / Basic Industry from a Main-style sheet', function () {
  const rows = [[true, 'Group'], ['Checkbox', 'StockName', 'Sector', 'Industry', 'Basic Industry', 'SYMBOL']];
  STOCKS.forEach(function (s) { rows.push([false, s[1], s[2], s[3], s[4], s[0]]); });
  rows.push([false, 'Dup', 'X', 'Y', 'Z', 'TCS']);
  rows.push([false, 'Err', 'X', 'Y', 'Z', '#N/A']);
  const m = A.buildMaster(sheetOf('Main', rows));
  assert.deepEqual(Object.keys(m), ['RELIANCE', 'TCS', 'M&M', 'BAJAJ-AUTO']);
  assert.deepEqual(m.TCS, { sector: 'Information Technology', industry: 'IT - Software', basicIndustry: 'Computers - Software & Consulting', name: 'Tata Consultancy Services' });
  assert.deepEqual(A.buildMaster(null), {});
});

test('toCsv follows RFC 4180', function () {
  assert.equal(A.toCsv([['a', 'b,c', 'say "hi"'], [1, null, true], ['multi\nline', undefined, -2.5]]),
    'a,"b,c","say ""hi"""\r\n1,,TRUE\r\n"multi\nline",,-2.5\r\n');
  assert.equal(A.toCsv([{ sym: 'TCS', px: 1 }, { sym: 'M&M', px: 2 }]), 'sym,px\r\nTCS,1\r\nM&M,2\r\n');
  assert.equal(A.toCsv([['a;b', 'c']], { delimiter: ';', eol: '\n' }), '"a;b";c\n');
  assert.equal(A.toCsv([['=HYPERLINK("x")', '-3.5', '@SUM(A1)']], { escapeFormulas: true }), '"\'=HYPERLINK(""x"")",-3.5,\'@SUM(A1)\r\n');
  assert.equal(A.toCsv([['x']], { bom: true }), '﻿x\r\n');
  assert.equal(A.toCsv([]), '');
  assert.equal(A.toCsv('nope'), '');
  assert.equal(A.toCsv([[NaN, Infinity]]), ',\r\n');
  const rows = A.columnsToRows(block(A.analyzeSheet(sheetOf('X', [['Symbol', 'Price'], ['TCS', 1], ['INFY', 3]]))));
  assert.equal(rows[0][0], 'Column');
  assert.deepEqual(rows[2].slice(0, 3), ['B', 'Price', 'number']);
});

test('end to end: reader output -> analyzeWorkbook (hidden sheet, multi-block, master)', async function () {
  const mainRows = [[true, 'Info'], ['Checkbox', 'StockName', 'Sector', 'Industry', 'Basic Industry', 'SYMBOL', 'Result Date', 'MKT Price']];
  STOCKS.forEach(function (s, i) { mainRows.push([i % 2 === 0, s[1], s[2], s[3], s[4], s[0], { v: 46286 + i, s: 1 }, s[5]]); });
  const buf = await makeXlsx({
    numFmts: { 164: 'dd/mm/yyyy' }, cellXfs: [0, 164],
    sheets: [
      { name: 'Main', sheetData: rowsXml(mainRows) },
      { name: 'Bridge', state: 'hidden', sheetData: rowsXml([['Symbol', 'Data'], ['TCS', '{}']]) },
      { name: 'Risk Manager', sheetData: rowsXml([['Capital (Rs)', 'Risk %', 'Max Heat %'], [500000, 1, 6]]) },
      { name: 'Board', sheetData: rowsXml([['Type', 'Signal', 'Stocks'], ['Pattern', 'Spring', 5], [], ['Industries'], ['Basic Industry', 'Stocks', 'Avg %'], ['Cement', 3, 0.5]]) }
    ]
  });
  const wb = await X.readWorkbook(buf);
  const master = A.buildMaster(wb.sheets[0]);
  assert.equal(Object.keys(master).length, 4);
  const res = A.analyzeWorkbook(wb, { master: master, publicMode: true });
  assert.equal(res.ok, true);
  assert.equal(res.summary.sheetCount, 4);
  assert.equal(res.summary.hidden, 1);
  assert.deepEqual(res.summary.personalSheets, ['Risk Manager']);
  assert.equal(res.masterSymbols, 4);
  const main = res.sheets[0];
  assert.equal(main.headerRow, 2);
  assert.equal(col(block(main), 'Result Date').type, 'date');
  assert.equal(col(block(main), 'Result Date').numFmt, 'dd/mm/yyyy');
  assert.equal(block(main).reconciliation.matched, 4);
  assert.equal(res.sheets[1].state, 'hidden');
  assert.equal(res.sheets[3].blockCount, 2);
  assert.ok(JSON.stringify(res).indexOf('500000') < 0, 'capital never leaks');
  assert.deepEqual(roundTrip(res), res);
});

const REAL = process.env.SB_REAL_XLSX || '/tmp/claude-0/-home-user/72385330-b2ce-55e6-a364-e92f580f4fef/scratchpad/xlsx/sb.xlsx';

test('real workbook (only when available): public analysis has no e-mails or personal values', { skip: !fs.existsSync(REAL) && 'real workbook not present' }, async function () {
  const wb = await X.readWorkbook(fs.readFileSync(REAL), { maxRowsPerSheet: 200000 });
  const main = wb.sheets.find(function (s) { return s.name === 'Main'; });
  const master = A.buildMaster(main);
  assert.ok(Object.keys(master).length > 500);
  const t0 = Date.now();
  const res = A.analyzeWorkbook(wb, { master: master, publicMode: true });
  assert.ok(Date.now() - t0 < 20000);
  const json = JSON.stringify(res);
  assert.ok(!EMAIL.test(json), 'no e-mail address in the public analysis');
  ['Portfolio', 'Risk Manager', 'Control Panel', 'Trade Log', 'Trade Dashboard'].forEach(function (n) {
    const s = res.sheets.find(function (x) { return x.name === n; });
    if (!s) return;
    assert.equal(s.personal, true, n);
    assert.equal(s.publicStructureOnly, true, n);
    s.blocks.forEach(function (b) { b.columns.forEach(function (c) { assert.equal(c.samples, undefined, n + ' ' + c.letter); }); });
  });
  const m = res.sheets.find(function (x) { return x.name === 'Main'; });
  assert.equal(m.headerRow, 2);
  assert.equal(m.personal, false);
  assert.ok(block(m).strategyColumns.some(function (s) { return s.header === 'TTM Signal' && s.values; }));
});
