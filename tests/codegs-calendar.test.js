'use strict';
// Results calendar from NSE (owner, 01-Nov-2026): the PC posts NSE's forthcoming "Financial Results" meetings
// (doPost action 'calendar'); the sheet adds the companies its Results tab does not have yet - at the bottom,
// same columns, DATE written like the cells already there - moves the date of a company NSE rescheduled within the
// same results quarter (not when that result already came out), gives the company's first row (what Main's formula
// reads) the NEXT quarter's meeting, and deletes the company's rows of earlier quarters (owner, 01-Nov-2026).
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

test('a date is not moved when that result already came out; the next quarter\'s meeting replaces the old row', () => {
  const e = mock.loadCodeGs({ sheets: [
    { name: 'Results', rows: HEAD.concat([['ZENTEC', 'Zen', 'Financial Results', '31-Oct-26'], ['AAKASH', 'Aakash', 'Financial Results', '10-Aug-26'],
      ['SAIPARENT', 'Sai', 'Financial Results', '30-Oct-26'], ['SAIPARENT', 'Sai', 'Financial Results', '30-Oct-26']]) },
    { name: 'Results Tracker', rows: [['Symbol', 'Company', 'Result Date', 'Quarter Expected', 'Status'], ['ZENTEC', 'Zen', '31/10/2026', 'Sep 2026', 'Updated']] }
  ] }, { props: { AB_BRIDGE_TOKEN: TOKEN }, now: NOW });
  const r = post(e, NSE);
  assert.deepStrictEqual(Array.from(r.moved), ['SAIPARENT 30/10 -> 01/11'], 'ZENTEC came out on 31-Oct');
  assert.deepStrictEqual(Array.from(r.replaced), ['AAKASH 02/11 (was 10/08)'], '10-Aug = June-quarter results, 02-Nov = September-quarter');
  assert.strictEqual(r.removed, 0);
  const rows = e.sheet('Results').rows;
  assert.deepStrictEqual(rows.slice(2, 6).map((x) => x[0] + ' ' + x[3]), ['ZENTEC 31-Oct-26', 'AAKASH 02-Nov-26', 'SAIPARENT 01-Nov-26', 'SAIPARENT 01-Nov-26']);
  assert.strictEqual(rows[3][2], 'Financial Results/Other business matters');
  const again = post(e, NSE);
  assert.deepStrictEqual([Array.from(again.moved), Array.from(again.replaced), again.removed], [[], [], 0]);
  assert.strictEqual(e.sheet('Results').rows.slice(2).filter((x) => x[0]).length, 6, '4 rows + POWERGRID, NEWSME');
});

test('the owner\'s first live run: old-quarter rows go (the first one gets the new date), same-quarter reschedules are moved', () => {
  const e = load([
    ['ESDS', 'ESDS Software', 'Financial Results', '24-Sep-26'],
    ['GSFC', 'Gujarat State Fertilizers', 'Financial Results', '12-Oct-26'],
    ['AUGMONT', 'Augmont Enterprises', 'Financial Results', '21-Sep-26'],
    ['PRASOLCHEM', 'Prasol Chemicals', 'Financial Results', '02-Nov-26'],   // put above its old row by the earlier version
    ['PRASOLCHEM', 'Prasol Chemicals', 'Financial Results', '28-Sep-26'],
    ['SUMEETINDS', 'Sumeet Industries', 'Financial Results', '31-Oct-26'],
    ['LATER', 'Later Ltd', 'Financial Results', '20-Nov-26'],
    ['AUGMONT', 'Augmont Enterprises', 'Financial Results', '21-Sep-26'],
    ['NOTLISTED', 'Not On NSE Now', 'Financial Results', '01-Aug-26']]);
  const r = post(e, [
    ['ESDS', 'ESDS Software', 'Financial Results', '2026-11-02'],
    ['GSFC', 'Gujarat State Fertilizers', 'Financial Results/Dividend', '2026-11-02'],
    ['AUGMONT', 'Augmont Enterprises', 'Financial Results', '2026-11-04'],
    ['PRASOLCHEM', 'Prasol Chemicals', 'Financial Results', '2026-11-02'],
    ['SUMEETINDS', 'Sumeet Industries', 'Financial Results', '2026-11-03'],
    ['LATER', 'Later Ltd', 'Financial Results', '2026-09-30']]);   // an earlier quarter than the tab's row: left alone
  assert.deepStrictEqual(Array.from(r.moved), ['GSFC 12/10 -> 02/11', 'SUMEETINDS 31/10 -> 03/11']);
  assert.deepStrictEqual(Array.from(r.replaced), ['ESDS 02/11 (was 24/09)', 'AUGMONT 04/11 (was 21/09)']);
  assert.deepStrictEqual([r.removed, Array.from(r.removedSyms), r.later], [2, ['AUGMONT', 'PRASOLCHEM'], 0]);
  const rows = e.sheet('Results').rows;
  assert.deepStrictEqual(rows.slice(2).filter((x) => x[0]).map((x) => x[0] + ' ' + x[3]), [
    'ESDS 02-Nov-26', 'GSFC 02-Nov-26', 'AUGMONT 04-Nov-26', 'PRASOLCHEM 02-Nov-26', 'SUMEETINDS 03-Nov-26', 'LATER 20-Nov-26',
    'NOTLISTED 01-Aug-26']);
  assert.ok(e.writes.some((w) => w.sheet === 'Results' && w.kind === 'format' && w.row === 3 && w.col === 4), 'the new DATE is plain text');
  const firstOf = {};
  e.call('ab_rsReadCalendar_').forEach((c) => { if (!firstOf[c.symbol]) firstOf[c.symbol] = c.dayKey; });
  assert.deepStrictEqual(firstOf, { ESDS: '2026-11-02', GSFC: '2026-11-02', AUGMONT: '2026-11-04', PRASOLCHEM: '2026-11-02',
    SUMEETINDS: '2026-11-03', LATER: '2026-11-20', NOTLISTED: '2026-08-01' });
  // new companies still go at the bottom in the same post
  const r2 = post(e, [['NEWCO', 'New Co', 'Financial Results', '2026-11-06'], ['ESDS', 'ESDS Software', 'Financial Results', '2026-11-02']]);
  assert.deepStrictEqual([Array.from(r2.added), r2.removed], [['NEWCO'], 0]);
  assert.strictEqual(e.sheet('Results').rows.slice(2).filter((x) => x[0]).pop()[0], 'NEWCO');
});

test('a tab not cleared after the season: deleting old rows stops after 3 minutes, the rest go next run', () => {
  const old = [];
  for (let i = 0; i < 6; i++) {
    old.push(['OLD' + i, 'Old ' + i, 'Financial Results', '0' + (i + 1) + '-Nov-26']);
    old.push(['OLD' + i, 'Old ' + i, 'Financial Results', '0' + (i + 1) + '-Aug-26']);
  }
  const e = load(old);
  const sh = e.run('SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Results")');
  const del = sh.deleteRow;
  sh.deleteRow = function (at) { e.setNow(e.now() + 50000); return del(at); };   // 50 s a row
  const nse = [0, 1, 2, 3, 4, 5].map((i) => ['OLD' + i, 'Old ' + i, 'Financial Results', '2026-11-0' + (i + 1)]);
  const r = post(e, nse);
  assert.strictEqual(r.removed + r.later, 6);
  assert.ok(r.later > 0 && r.removed >= 3, JSON.stringify(r));
  const r2 = post(e, nse);
  assert.strictEqual(r2.removed, r.later, 'the rest the next run');
  assert.deepStrictEqual(e.sheet('Results').rows.slice(2).filter((x) => x[0]).map((x) => x[3]),
    ['01-Nov-26', '02-Nov-26', '03-Nov-26', '04-Nov-26', '05-Nov-26', '06-Nov-26']);
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
