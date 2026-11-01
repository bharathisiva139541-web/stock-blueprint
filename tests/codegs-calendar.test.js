'use strict';
// Results calendar from NSE (owner, 01-Nov-2026): the PC posts NSE's forthcoming "Financial Results" meetings
// (doPost action 'calendar'); the sheet adds ONLY the companies its Results tab does not have yet - at the
// bottom, same columns, DATE written like the cells already there - and never changes a row that is there.
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

test('only the missing companies are added, at the bottom, by date, with text dates like the tab has', () => {
  const e = load([['AAKASH', 'Aakash Exploration Services Limited', 'Financial Results/Ot', '02-Nov-26'],
                  ['ZENTEC', 'Zen Technologies Limited', 'Financial Results/Ot', '31-Oct-26'], ['', '', '', '']]);
  const r = post(e, NSE);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(Array.from(r.added), ['POWERGRID', 'SAIPARENT', 'NEWSME']);
  const rows = e.sheet('Results').rows;
  assert.deepStrictEqual(rows.slice(2, 7).map((x) => x.slice(0, 4)), [
    ['AAKASH', 'Aakash Exploration Services Limited', 'Financial Results/Ot', '02-Nov-26'],
    ['ZENTEC', 'Zen Technologies Limited', 'Financial Results/Ot', '31-Oct-26'],      // never changed (NSE says 05-Nov)
    ['POWERGRID', 'Power Grid Corporation of India Limited', 'Financial Results/Dividend', '01-Nov-26'],
    ['SAIPARENT', 'Sai Parenterals Limited', 'Financial Results', '01-Nov-26'],
    ['NEWSME', 'New SME Limited', 'Financial Results/Fund Raising', '04-Nov-26']]);
  assert.ok(e.writes.some((w) => w.sheet === 'Results' && w.kind === 'format' && w.row === 5 && w.col === 4), 'DATE cells set to plain text first');
  // what Main's Result Date and the Results Day check read
  const cal = e.call('ab_rsReadCalendar_').map((c) => c.symbol + ' ' + c.dayKey);
  assert.deepStrictEqual(Array.from(cal), ['AAKASH 2026-11-02', 'ZENTEC 2026-10-31', 'POWERGRID 2026-11-01', 'SAIPARENT 2026-11-01', 'NEWSME 2026-11-04']);
  // the next day: nothing new
  assert.deepStrictEqual(Array.from(post(e, NSE).added), []);
  assert.strictEqual(e.sheet('Results').rows.filter((x) => x[0]).length, 7);
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
