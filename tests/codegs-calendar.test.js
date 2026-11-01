'use strict';
// Results calendar from NSE (owner, 01-Nov-2026): the PC posts NSE's forthcoming "Financial Results" meetings
// (doPost action 'calendar'); the sheet adds the companies its Results tab does not have yet - at the bottom,
// same columns, DATE written like the cells already there - moves the date of a company NSE rescheduled within the
// same results quarter (not when that result already came out), and puts the NEXT quarter's meeting in a new row
// right above the company's old row (Main's formula reads the first one). Rows are never removed.
const test = require('node:test');
const assert = require('node:assert');
const mock = require('./fixtures/apps-script-mock.js');

const TOKEN = 'bridge-token-0123456789';
const NOW = Date.UTC(2026, 10, 1, 4, 0);                 // Sun 01-Nov-2026 09:30 IST
const HEAD = [['Result Calender', '', '', ''], ['SYMBOL', 'COMPANY', 'PURPOSE', 'DATE']];
const NSE = [
  ['POWERGRID', 'Power Grid Corporation of India Limited', 'Financial Results/Dividend', '2026-11-01'],
  ['SAIPARENT', 'Sai Parenterals Limited', 'Financial Results', '2026-11-01'],
  ['AAKASH', 'Aakash Exploration Services Limited', 'Financial Results/Other business matters', '2026-11-02'],
  ['ZENTEC', 'Zen Technologies Limited', 'Financial Results', '2026-11-05'],
  ['BUYBACKCO', 'Buyback Co', 'Buyback', '2026-11-03'],
  ['NEWSME', 'New SME Limited', 'Financial Results/Fund Raising', '2026-11-04'],
  ['bad sym!', 'x', 'Financial Results', '2026-11-04'],
  ['NODATE', 'x', 'Financial Results', '04-11-2026']
];
const load = (rows) => mock.loadCodeGs({ sheets: [{ name: 'Results', rows: HEAD.concat(rows) }] },
  { props: { AB_BRIDGE_TOKEN: TOKEN }, now: NOW });
const post = (e, rows) => e.post({ token: TOKEN, action: 'calendar', rows: rows });

test('the missing companies are added at the bottom by date, text dates like the tab has; a moved meeting gets its new date', () => {
  const e = load([['AAKASH', 'Aakash Exploration Services Limited', 'Financial Results/Ot', '02-Nov-26'],
                  ['ZENTEC', 'Zen Technologies Limited', 'Financial Results/Ot', '31-Oct-26'], ['', '', '', '']]);
  const r = post(e, NSE);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(Array.from(r.added), ['POWERGRID', 'SAIPARENT', 'NEWSME']);
  assert.deepStrictEqual(Array.from(r.moved), ['ZENTEC 31/10 -> 05/11']);
  const rows = e.sheet('Results').rows;
  assert.deepStrictEqual(rows.slice(2, 7).map((x) => x.slice(0, 4)), [
    ['AAKASH', 'Aakash Exploration Services Limited', 'Financial Results/Ot', '02-Nov-26'],
    ['ZENTEC', 'Zen Technologies Limited', 'Financial Results', '05-Nov-26'],          // NSE moved it from 31-Oct
    ['POWERGRID', 'Power Grid Corporation of India Limited', 'Financial Results/Dividend', '01-Nov-26'],
    ['SAIPARENT', 'Sai Parenterals Limited', 'Financial Results', '01-Nov-26'],
    ['NEWSME', 'New SME Limited', 'Financial Results/Fund Raising', '04-Nov-26']]);
  assert.ok(e.writes.some((w) => w.sheet === 'Results' && w.kind === 'format' && w.row === 5 && w.col === 4), 'DATE cells set to plain text first');
  // what Main's Result Date and the Results Day check read
  const cal = e.call('ab_rsReadCalendar_').map((c) => c.symbol + ' ' + c.dayKey);
  assert.deepStrictEqual(Array.from(cal), ['AAKASH 2026-11-02', 'ZENTEC 2026-11-05', 'POWERGRID 2026-11-01', 'SAIPARENT 2026-11-01', 'NEWSME 2026-11-04']);
  // the next day: nothing new, nothing moved
  const again = post(e, NSE);
  assert.deepStrictEqual([Array.from(again.added), Array.from(again.moved)], [[], []]);
  assert.strictEqual(e.sheet('Results').rows.filter((x) => x[0]).length, 7);
});

test('a date is not moved when that result already came out; the next quarter\'s meeting goes in a new row above the old one', () => {
  const e = mock.loadCodeGs({ sheets: [
    { name: 'Results', rows: HEAD.concat([['ZENTEC', 'Zen', 'Financial Results', '31-Oct-26'], ['AAKASH', 'Aakash', 'Financial Results', '10-Aug-26'],
      ['SAIPARENT', 'Sai', 'Financial Results', '30-Oct-26'], ['SAIPARENT', 'Sai', 'Financial Results', '30-Oct-26']]) },
    { name: 'Results Tracker', rows: [['Symbol', 'Company', 'Result Date', 'Quarter Expected', 'Status'], ['ZENTEC', 'Zen', '31/10/2026', 'Sep 2026', 'Updated']] }
  ] }, { props: { AB_BRIDGE_TOKEN: TOKEN }, now: NOW });
  const r = post(e, NSE);
  assert.deepStrictEqual(Array.from(r.moved), ['SAIPARENT 30/10 -> 01/11'], 'ZENTEC came out on 31-Oct');
  assert.deepStrictEqual(Array.from(r.above), ['AAKASH 02/11 (above 10/08)'], '10-Aug = June-quarter results, 02-Nov = September-quarter');
  const rows = e.sheet('Results').rows;
  assert.deepStrictEqual(rows.slice(2, 7).map((x) => x[0] + ' ' + x[3]),
    ['ZENTEC 31-Oct-26', 'AAKASH 02-Nov-26', 'AAKASH 10-Aug-26', 'SAIPARENT 01-Nov-26', 'SAIPARENT 01-Nov-26']);
  assert.strictEqual(rows[3][2], 'Financial Results/Other business matters');
  // the next day: the new row is the first one, so nothing more
  const again = post(e, NSE);
  assert.deepStrictEqual([Array.from(again.moved), Array.from(again.above)], [[], []]);
  assert.strictEqual(e.sheet('Results').rows.filter((x) => x[0]).length, 9);
});

test('the owner\'s first live run: other-quarter rows are kept (new row above), same-quarter reschedules are moved', () => {
  const e = load([
    ['ESDS', 'ESDS Software', 'Financial Results', '24-Sep-26'],
    ['GSFC', 'Gujarat State Fertilizers', 'Financial Results', '12-Oct-26'],
    ['AUGMONT', 'Augmont Enterprises', 'Financial Results', '21-Sep-26'],
    ['SUMEETINDS', 'Sumeet Industries', 'Financial Results', '31-Oct-26'],
    ['LATER', 'Later Ltd', 'Financial Results', '20-Nov-26'],
    ['AUGMONT', 'Augmont Enterprises', 'Financial Results', '21-Sep-26']]);
  const r = post(e, [
    ['ESDS', 'ESDS Software', 'Financial Results', '2026-11-02'],
    ['GSFC', 'Gujarat State Fertilizers', 'Financial Results/Dividend', '2026-11-02'],
    ['AUGMONT', 'Augmont Enterprises', 'Financial Results', '2026-11-04'],
    ['SUMEETINDS', 'Sumeet Industries', 'Financial Results', '2026-11-03'],
    ['LATER', 'Later Ltd', 'Financial Results', '2026-09-30']]);   // an earlier quarter than the tab's row: left alone
  assert.deepStrictEqual(Array.from(r.moved), ['GSFC 12/10 -> 02/11', 'SUMEETINDS 31/10 -> 03/11']);
  assert.deepStrictEqual(Array.from(r.above), ['ESDS 02/11 (above 24/09)', 'AUGMONT 04/11 (above 21/09)']);
  assert.strictEqual(r.later, 0);
  const rows = e.sheet('Results').rows;
  assert.deepStrictEqual(rows.slice(2).filter((x) => x[0]).map((x) => x[0] + ' ' + x[3]), [
    'ESDS 02-Nov-26', 'ESDS 24-Sep-26', 'GSFC 02-Nov-26', 'AUGMONT 04-Nov-26', 'AUGMONT 21-Sep-26',
    'SUMEETINDS 03-Nov-26', 'LATER 20-Nov-26', 'AUGMONT 21-Sep-26']);
  assert.ok(e.writes.some((w) => w.sheet === 'Results' && w.kind === 'format' && w.row === 3 && w.col === 4), 'the new row\'s DATE is plain text');
  // what Main's Result Date formula reads: the first row of each symbol
  const firstOf = {};
  e.call('ab_rsReadCalendar_').forEach((c) => { if (!firstOf[c.symbol]) firstOf[c.symbol] = c.dayKey; });
  assert.deepStrictEqual(firstOf, { ESDS: '2026-11-02', GSFC: '2026-11-02', AUGMONT: '2026-11-04', SUMEETINDS: '2026-11-03', LATER: '2026-11-20' });
});

test('a tab not cleared after the season: new rows above stop after 3 minutes, the rest go next run', () => {
  const old = [];
  for (let i = 0; i < 6; i++) old.push(['OLD' + i, 'Old ' + i, 'Financial Results', '0' + (i + 1) + '-Aug-26']);
  const e = load(old);
  const sh = e.run('SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Results")');
  const ins = sh.insertRowsBefore;
  sh.insertRowsBefore = function (b, n) { e.setNow(e.now() + 50000); return ins(b, n); };   // 50 s a row
  const nse = old.map((x, i) => [x[0], x[1], 'Financial Results', '2026-11-0' + (i + 1)]);
  const r = post(e, nse);
  assert.strictEqual(r.above.length + r.later, 6);
  assert.ok(r.later > 0 && r.above.length >= 3, JSON.stringify(r));
  const r2 = post(e, nse);
  assert.strictEqual(r2.above.length, r.later, 'the rest the next run');
  assert.strictEqual(e.sheet('Results').rows.slice(2).filter((x) => x[0]).length, 12);
});

test('the DATE style of the tab is kept: 4-digit years, or real dates', () => {
  const e4 = load([['AAKASH', 'Aakash', 'Financial Results', '02-Nov-2026']]);
  post(e4, NSE);
  assert.strictEqual(e4.sheet('Results').rows.find((x) => x[0] === 'POWERGRID')[3], '01-Nov-2026');
  const ed = load([['AAKASH', 'Aakash', 'Financial Results', new Date(Date.UTC(2026, 10, 2, 6, 30))]]);
  post(ed, NSE);
  const d = ed.sheet('Results').rows.find((x) => x[0] === 'POWERGRID')[3];
  assert.ok(d && typeof d.getTime === 'function', 'a real date like the others: ' + d);
  assert.strictEqual(ed.call('ab_rsDayKey_', d), '2026-11-01');
});

test('an empty tab (header only) gets the meetings; bad posts are refused', () => {
  const e = load([]);
  assert.deepStrictEqual(Array.from(post(e, NSE).added), ['POWERGRID', 'SAIPARENT', 'AAKASH', 'NEWSME', 'ZENTEC']);
  assert.strictEqual(e.sheet('Results').rows[2][3], '01-Nov-26');
  assert.match(post(e, undefined).error, /rows missing/);
  assert.match(e.post({ token: 'nope', action: 'calendar', rows: [] }).error, /bad token/);
  const nohead = mock.loadCodeGs({ sheets: [{ name: 'Results', rows: [['just a note']] }] }, { props: { AB_BRIDGE_TOKEN: TOKEN }, now: NOW });
  assert.match(post(nohead, NSE).error, /no SYMBOL \/ DATE header/);
});
