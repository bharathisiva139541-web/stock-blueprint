'use strict';
// Code.gs doPost action 'eod': the PC bridge posts one trading day of NSE end-of-day data
// (each stock's day, Delivery % per stock, each stock's 52-week high). The sheet counts its OWN
// Main stocks: "Market Statistics" (one row per day), "Market Day" (the newest day's Main stocks -
// the lists behind the website's tiles), "Delivery %" (Main stocks x last 10 days) and
// "52 Week High" (new highs of the day + every Main stock); the site feed carries all four.
const test = require('node:test');
const assert = require('node:assert');
const mock = require('./fixtures/apps-script-mock.js');

const TOKEN = 'bridge-token-0123456789';
const NOW = Date.UTC(2026, 9, 27, 16, 0);          // Tue 27-Oct-2026 21:30 IST
const HEAD = ['Checkbox', 'StockName', 'SYMBOL', 'Result Date', 'Price Fall Alert Price', 'Breakout Alert Price', 'Triggered Y/N'];
function workbook() {
  return { sheets: [{ name: 'Main', rows: [['Main watchlist'], HEAD,
    [false, 'Tata Consultancy', 'TCS', '', '', '', ''],
    [false, 'Sona BLW', 'SONA', '', '', '', ''],
    [false, '', '', '', '', '', ''],                       // a blank row inside the data
    [false, 'Rallis India', 'RALLIS', '', '', '', ''],
    [false, 'Sona BLW (again)', 'SONA', '', '', '', '']] }] };
}
function env() { return mock.loadCodeGs(workbook(), { props: { AB_BRIDGE_TOKEN: TOKEN }, now: NOW }); }
const STATS = { traded: 2310, advances: 1520, declines: 700, unchanged: 90, high52: 28, upper: 41, lower: 12 };   // all NSE: not used
// each stock's day: [close, % change, move, circuit, new 52-week high, series]
const DAY = { TCS: [3948, 1.234, 1, '', 0, 'EQ'], SONA: [700, 3.5, 1, 'U', 1, 'EQ'], RALLIS: [380, -2.1, -1, 'L', 0, 'EQ'],
  OTHER: [10, 0, 0, '', 1, 'EQ'], BAD: ['x', 1, 1, '', 0, 'EQ'] };
function day(iso, extra) {
  return Object.assign({ token: TOKEN, action: 'eod', tradeDate: iso, stats: STATS, day: DAY,
    delivery: { TCS: 61.234, SONA: 45.5, RALLIS: 30, OTHER: 80, BAD: 120 },
    high52: [['TCS', 4500, '2026-01-10', 3900], ['SONA', 700, iso, 700], ['NEWCO', 50, iso, 50], ['RALLIS', 400, '2026-09-01', 380],
      ['OLDCO', 90, '2025-12-01', 60], ['ZERO', 0, iso, 1]],
    files: { bhav: true, w52: true, bands: true } }, extra || {});
}
const rows = (e, tab) => e.sheet(tab).rows;

test('eod: the sheet counts its own Main stocks - statistics row, Market Day list, Delivery %, 52-week highs', () => {
  const e = env();
  const r = e.post(day('2026-10-27'));
  assert.deepStrictEqual(r, { ok: true, tradeDate: '2026-10-27', stats: { traded: 3, advances: 2, declines: 1, unchanged: 0, high52: 1, upper: 1, lower: 1 },
    dayTab: 'updated', deliveryInMain: 3, newHighs: 2, newHighsInMain: 1, highTab: 'updated' });

  const ms = rows(e, 'Market Statistics');
  assert.match(ms[0][0], /^Market statistics of YOUR Main stocks/);
  assert.deepStrictEqual(ms[1], ['Date', 'Stocks Traded', 'Advances', 'Declines', 'Unchanged', 'At 52W High', 'Upper Circuit', 'Lower Circuit']);
  assert.deepStrictEqual(ms[2], ['2026-10-27', 3, 2, 1, 0, 1, 1, 1], 'Main stocks only (OTHER is not in Main)');

  const md = rows(e, 'Market Day');
  assert.strictEqual(md[0][0], 'Your Main stocks on 2026-10-27 (NSE end-of-day files read by your PC): 3 traded - 2 advances, 1 declines, 0 unchanged, ' +
    '1 at a new 52-week high, 1 in upper circuit, 1 in lower circuit.');
  assert.deepStrictEqual(md[1], ['Symbol', 'Company', 'Close', '% Change', 'Move', 'Circuit', 'New 52W High', 'Delivery %']);
  assert.deepStrictEqual(md.slice(2), [['TCS', 'Tata Consultancy', 3948, 1.23, 'Advance', '', '', 61.23], ['SONA', 'Sona BLW', 700, 3.5, 'Advance', 'Upper', 'Yes', 45.5],
    ['RALLIS', 'Rallis India', 380, -2.1, 'Decline', 'Lower', '', 30]]);

  const dl = rows(e, 'Delivery %');
  assert.deepStrictEqual(dl[1], ['Symbol', 'Company', '2026-10-27']);
  assert.deepStrictEqual(dl.slice(2), [['TCS', 'Tata Consultancy', 61.23], ['SONA', 'Sona BLW', 45.5], ['RALLIS', 'Rallis India', 30]],
    'Main order, one row per symbol, blank rows skipped, other stocks left out');

  const hi = rows(e, '52 Week High');
  assert.strictEqual(hi[0][0], '52-week highs from NSE (adjusted for corporate actions) - as on 2026-10-27: 2 mainboard stocks made a new 52-week high ' +
    '(1 in your watchlist). Below them: every watchlist stock, nearest to its high first.');
  assert.deepStrictEqual(hi[1], ['Symbol', 'Company', '52W High', '52W High Date', 'Close', '% Below 52W High', 'New High Today', 'In Watchlist']);
  assert.deepStrictEqual(hi.slice(2), [
    ['NEWCO', '', 50, '2026-10-27', 50, 0, 'Yes', ''],
    ['SONA', 'Sona BLW', 700, '2026-10-27', 700, 0, 'Yes', 'Yes'],
    ['RALLIS', 'Rallis India', 400, '2026-09-01', 380, 5, '', 'Yes'],
    ['TCS', 'Tata Consultancy', 4500, '2026-01-10', 3900, 13.3, '', 'Yes']]);
});

test('eod: days add up (newest first), the same day is replaced, an older catch-up day keeps the newer 52-week tab', () => {
  const e = env();
  e.post(day('2026-10-26', { day: { TCS: DAY.TCS, SONA: DAY.SONA }, delivery: { TCS: 50, SONA: 40 } }));
  e.post(day('2026-10-27'));
  e.post(day('2026-10-27', { files: { bhav: true, w52: true, bands: false } }));     // re-sent without the band list
  const ms = rows(e, 'Market Statistics');
  assert.deepStrictEqual(ms.slice(2).map((x) => [x[0], x[1], x[6]]), [['2026-10-27', 3, ''], ['2026-10-26', 2, 1]]);
  assert.match(rows(e, 'Market Day')[0][0], /3 traded - 2 advances, 1 declines, 0 unchanged, 1 at a new 52-week high\.$/, 'no circuit counts without the band list');
  const dl = rows(e, 'Delivery %');
  assert.deepStrictEqual(dl[1], ['Symbol', 'Company', '2026-10-27', '2026-10-26']);
  assert.deepStrictEqual(dl[4], ['RALLIS', 'Rallis India', 30, ''], 'no value that day');
  // a catch-up of an older day: statistics and delivery filed, the 52-week tab stays on the newest day
  const r = e.post(day('2026-10-23', { high52: [['TCS', 4400, '2026-01-10', 3800]], day: { TCS: DAY.TCS } }));
  assert.strictEqual(r.highTab, 'kept (a newer day is already there)');
  assert.strictEqual(r.dayTab, 'kept (a newer day is already there)');
  assert.match(rows(e, 'Market Day')[0][0], /on 2026-10-27/);
  assert.match(rows(e, '52 Week High')[0][0], /as on 2026-10-27/);
  assert.deepStrictEqual(rows(e, 'Market Statistics').slice(2).map((x) => x[0]), ['2026-10-27', '2026-10-26', '2026-10-23']);
  assert.deepStrictEqual(rows(e, 'Delivery %')[1].slice(2), ['2026-10-27', '2026-10-26', '2026-10-23']);
});

test('eod: only the last 10 trading days of Delivery % are kept; bad posts are refused', () => {
  const e = env();
  for (let d = 1; d <= 12; d++) e.post(day('2026-10-' + String(d).padStart(2, '0')));
  const h = rows(e, 'Delivery %')[1];
  assert.strictEqual(h.length, 12);
  assert.deepStrictEqual([h[2], h[11]], ['2026-10-12', '2026-10-03']);
  assert.deepStrictEqual(e.post({ token: TOKEN, action: 'eod', tradeDate: '27-10-2026', day: DAY }), { ok: false, error: 'tradeDate missing' });
  assert.deepStrictEqual(e.post({ token: TOKEN, action: 'eod', tradeDate: '2026-10-27', stats: STATS }),
    { ok: false, error: 'day missing - update screener_bridge.py on the PC' }, 'an older PC program');
  assert.deepStrictEqual(e.post({ token: TOKEN, action: 'eod', tradeDate: '2026-10-27', day: { BAD: ['x'] } }), { ok: false, error: 'no stocks in the day\'s data' });
  assert.deepStrictEqual(e.post(Object.assign(day('2026-10-27'), { token: 'nope' })), { ok: false, error: 'bad token' });
});

test('site feed: marketStats, marketDay, high52 (with notes) and delivery parts', () => {
  const e = env();
  e.post(day('2026-10-26', { delivery: { TCS: 50 } }));
  e.post(day('2026-10-27'));
  const data = e.run('(function () { const ss = SpreadsheetApp.getActiveSpreadsheet();' +
    ' return ab_site_main_({ ss: ss, tz: AB_TZ, tabs: {}, dates: {} }, "2026-10-27 21:30"); })()');
  const j = JSON.parse(JSON.stringify(data));
  assert.match(j.marketStats.note, /^Market statistics of YOUR Main stocks/);
  assert.deepStrictEqual(j.marketStats.rows[0], ['2026-10-27', 3, 2, 1, 0, 1, 1, 1]);
  assert.match(j.marketDay.note, /^Your Main stocks on 2026-10-27/);
  assert.deepStrictEqual(j.marketDay.rows[1], ['SONA', 'Sona BLW', 700, 3.5, 'Advance', 'Upper', 'Yes', 45.5]);
  assert.match(j.high52.note, /as on 2026-10-27: 2 mainboard stocks/);
  assert.deepStrictEqual(j.high52.rows[1], ['SONA', 'Sona BLW', 700, '2026-10-27', 700, 0, 'Yes', 'Yes']);
  assert.deepStrictEqual(j.delivery.cols, ['Symbol', 'Company', '2026-10-27', '2026-10-26']);
  assert.deepStrictEqual(j.delivery.rows[0], ['TCS', 'Tata Consultancy', 61.23, 50]);
  assert.strictEqual(e.run('AB_SITE_FEED_FORMAT'), 4);
});
