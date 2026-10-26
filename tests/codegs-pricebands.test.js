'use strict';
// Code.gs doPost action 'pricebands': the PC bridge posts one day's NSE
// "Price Band changes from next trade date" file; it is filed on the
// "Price Band Changes" tab like a paste (duplicates ignored) and the day's
// email goes out once, only while the changes are current.
const test = require('node:test');
const assert = require('node:assert');
const mock = require('./fixtures/apps-script-mock.js');

const TOKEN = 'bridge-token-0123456789';
const MAIN = { name: 'Main', rows: [
  ['Stock Blueprint'],
  ['Checkbox', 'SYMBOL', 'StockName', 'Sector', 'MKT Price', 'Price Fall Alert Price', 'Breakout Alert Price', 'Triggered Y/N'],
  [false, 'SBIN', 'State Bank', 'Banks', 800, '', '', ''],
  [false, 'TCS', 'Tata Consultancy', 'IT', 3050, '', '', '']
] };
const ROWS = [
  { symbol: 'SBIN', series: 'EQ', name: 'State Bank of India', from: '10', to: '20' },
  { symbol: 'abc', series: 'BE', name: 'ABC Ltd', from: '20', to: '5' },
  { symbol: 'XYZ', series: 'EQ', name: 'XYZ Ltd', from: 'No Band', to: '20' },
  { symbol: '', series: 'EQ', name: 'blank', from: '5', to: '10' },
  { symbol: 'BAD', series: 'EQ', name: 'no bands', from: '', to: '' }
];
// Tue 27-Oct-2026 19:30 IST
const NOW = Date.UTC(2026, 9, 27, 14, 0);

function env() { return mock.loadCodeGs({ sheets: [MAIN] }, { props: { AB_BRIDGE_TOKEN: TOKEN }, now: NOW }); }
function logRows(e) {
  const sh = e.sheet('Price Band Changes');
  return sh ? sh.rows.slice(1).filter((r) => r[2]) : [];
}

test('pricebands: files the rows, emails once, ignores repeats', () => {
  const e = env();
  const r1 = e.post({ token: TOKEN, action: 'pricebands', reportDate: '2026-10-27', rows: ROWS });
  assert.strictEqual(r1.ok, true, JSON.stringify(r1));
  assert.strictEqual(r1.rows, 3, 'blank symbol and band-less rows are skipped');
  assert.strictEqual(r1.added, 3);
  assert.strictEqual(r1.inMain, 1, 'SBIN is in Main');
  assert.strictEqual(r1.emailed, true);
  assert.strictEqual(e.mails.length, 1);
  assert.ok(/Price Band Changes \(28-Oct\)/.test(JSON.stringify(e.mails[0])), 'effective the next weekday');
  const log = logRows(e);
  assert.deepStrictEqual(log.map((r) => r[2]).sort(), ['ABC', 'SBIN', 'XYZ']);
  const sbin = log.find((r) => r[2] === 'SBIN');
  assert.strictEqual(sbin[7], 'Widened (positive)');
  assert.strictEqual(sbin[8], 'Yes');
  assert.strictEqual(log.find((r) => r[2] === 'ABC')[7], 'Tightened (negative)');
  // the second run of the evening sends the same file: nothing new, no second email
  const r2 = e.post({ token: TOKEN, action: 'pricebands', reportDate: '2026-10-27', rows: ROWS });
  assert.strictEqual(r2.added, 0);
  assert.strictEqual(r2.emailed, false);
  assert.strictEqual(e.mails.length, 1);
  assert.strictEqual(logRows(e).length, 3);
});

test('pricebands: an old catch-up day is filed quietly (no email)', () => {
  const e = env();
  const r = e.post({ token: TOKEN, action: 'pricebands', reportDate: '2026-10-22', rows: ROWS });
  assert.strictEqual(r.added, 3);
  assert.strictEqual(r.emailed, false);
  assert.strictEqual(r.quiet, true);
  assert.strictEqual(e.mails.length, 0);
  // Friday's file read on Monday is still current (effective Monday)
  const e2 = mock.loadCodeGs({ sheets: [MAIN] }, { props: { AB_BRIDGE_TOKEN: TOKEN }, now: Date.UTC(2026, 9, 26, 14, 0) });
  assert.strictEqual(e2.post({ token: TOKEN, action: 'pricebands', reportDate: '2026-10-23', rows: ROWS }).emailed, true);
});

test('pricebands: bad token, bad date, empty file', () => {
  const e = env();
  assert.deepStrictEqual(e.post({ token: 'nope', action: 'pricebands', reportDate: '2026-10-27', rows: ROWS }), { ok: false, error: 'bad token' });
  assert.strictEqual(e.post({ token: TOKEN, action: 'pricebands', reportDate: '27-10-2026', rows: ROWS }).ok, false);
  const r = e.post({ token: TOKEN, action: 'pricebands', reportDate: '2026-10-27', rows: [] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.added, 0);
  assert.strictEqual(e.mails.length, 0);
  // the website feed token cannot write price bands
  const e2 = mock.loadCodeGs({ sheets: [MAIN] }, { props: { AB_BRIDGE_TOKEN: TOKEN, AB_FEED_TOKEN: 'feed' }, now: NOW });
  assert.strictEqual(e2.post({ token: 'feed', action: 'pricebands', reportDate: '2026-10-27', rows: ROWS }).ok, false);
});

test('pricebands: the same NSE file filed under two dates is cleared, and never filed twice', () => {
  const HDR = ['Report Date', 'Effective (next weekday)', 'Symbol', 'Company', 'Series', 'From %', 'To %', 'Impact', 'In Main', 'Chart'];
  const row = (d, sym, from, to) => [d, '', sym, sym + ' Ltd', 'EQ', from, to, '', '', ''];
  // Friday's file pasted on Sunday 25/10, then filed again as 26/10 (the first bridge version);
  // Thursday's file pasted as 22/10, then filed again as 23/10; FLIP really went 5 -> 10 -> 5 -> 10.
  const LOG = { name: 'Price Band Changes', rows: [HDR,
    row('26/10/2026', 'EMAMIPAP', 5, 20), row('26/10/2026', 'ELPROINTL', 20, 10),
    row('25/10/2026', 'EMAMIPAP', 5, 20), row('25/10/2026', 'ELPROINTL', 20, 10),
    row('23/10/2026', 'MICEL', 5, 10), row('22/10/2026', 'MICEL', 5, 10),
    row('21/10/2026', 'FLIP', 5, 10), row('20/10/2026', 'FLIP', 10, 5), row('19/10/2026', 'FLIP', 5, 10)] };
  const e = mock.loadCodeGs({ sheets: [MAIN, LOG] }, { props: { AB_BRIDGE_TOKEN: TOKEN }, now: Date.UTC(2026, 9, 26, 16, 0) });
  const fri = [{ symbol: 'EMAMIPAP', series: 'EQ', from: '5', to: '20' }, { symbol: 'ELPROINTL', series: 'EQ', from: '20', to: '10' }];
  // the fixed bridge re-sends Friday's file under its real report date (Fri 23/10): nothing new, repeats cleared
  const r1 = e.post({ token: TOKEN, action: 'pricebands', reportDate: '2026-10-23', rows: fri });
  assert.strictEqual(r1.added, 0, JSON.stringify(r1));
  assert.strictEqual(r1.removed, 3, 'the 26/10 copies and the 23/10 MICEL copy');
  assert.strictEqual(r1.emailed, false);
  const keys = logRows(e).map((r) => r[2] + '@' + e.call('ab_pbDayKey_', r[0])).sort();
  assert.deepStrictEqual(keys, ['ELPROINTL@2026-10-25', 'EMAMIPAP@2026-10-25', 'FLIP@2026-10-19', 'FLIP@2026-10-20', 'FLIP@2026-10-21', 'MICEL@2026-10-22']);
  // Monday evening's file (effective Tuesday): new, emailed
  const r2 = e.post({ token: TOKEN, action: 'pricebands', reportDate: '2026-10-26', rows: [{ symbol: 'KHADIM', series: 'EQ', from: '5', to: '20' }] });
  assert.strictEqual(r2.added, 1);
  assert.strictEqual(r2.removed, 0);
  assert.strictEqual(r2.emailed, true);
  assert.strictEqual(e.mails.length, 1);
  // pasting Monday's file again by hand on Tuesday adds nothing (no second email)
  assert.deepStrictEqual(Array.from(e.call('ab_pbImport_', e.call('ab_pbToDate_', '27/10/2026'),
    [{ symbol: 'KHADIM', series: 'EQ', name: '', from: 5, to: 20 }])), []);
});
