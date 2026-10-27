'use strict';
// Code.gs doPost action 'ipos': the PC bridge posts NSE's IPO lists (current, past
// issues, upcoming); the "IPO Tracker" tab is rebuilt with Open now / Closed -
// awaiting listing / Upcoming (mainboard only) and one email goes out per IST day.
const test = require('node:test');
const assert = require('node:assert');
const mock = require('./fixtures/apps-script-mock.js');

const TOKEN = 'bridge-token-0123456789';
// Tue 27-Oct-2026 19:30 IST
const NOW = Date.UTC(2026, 9, 27, 14, 0);
const REC = [
  { list: 'current', company: 'EAAA India Alternatives Limited', symbol: 'EAAA', type: 'EQ', start: '2026-10-26', end: '2026-10-28', price: 'Rs.400 to Rs.420' },
  { list: 'current', company: 'BLS Polymers Limited', symbol: 'BLSPOLY', type: 'EQ', start: '2026-10-27', end: '2026-10-29' },
  { list: 'current', company: 'Tiny SME Limited', symbol: 'TINY', type: 'SME', start: '2026-10-27', end: '2026-10-29' },
  { list: 'past', company: 'Paras Healthcare Limited', symbol: 'PARASHLTH', type: 'EQ', start: '2026-10-21', end: '2026-10-23', listing: '', price: 'Rs.660 to Rs.693' },
  { list: 'past', company: 'Jio Platforms Limited', symbol: 'JPL', type: 'EQ', start: '2026-10-21', end: '2026-10-23', listing: '2026-10-28' },
  { list: 'past', company: 'Tonbo Imaging India Limited', symbol: 'TONBO', type: 'EQ', start: '2026-10-15', end: '2026-10-19', listing: '2026-10-23' },
  { list: 'past', company: 'Ravita Engineering', symbol: 'RAVITA', type: 'SME', start: '2026-10-14', end: '2026-10-16', listing: '' },
  { list: 'past', company: 'Old Withdrawn Limited', symbol: 'OLDW', type: 'EQ', start: '2026-08-01', end: '2026-08-05', listing: '' },
  // debt issues (NCDs): typed DEBT, or untyped with a numbered symbol and one price
  { list: 'past', company: 'SMC Global Securities Limited', symbol: 'SMCG04', type: '', start: '2026-10-05', end: '2026-10-09', listing: '', price: 'Rs.1,000' },
  { list: 'current', company: 'Muthoot Bond Limited', symbol: 'MBL26', type: 'DEBT', start: '2026-10-26', end: '2026-11-06', price: '1000' },
  { list: 'upcoming', company: 'Bombay Coated and Special Steels Limited', symbol: 'BCSSL', type: 'EQ', start: '2026-10-29', end: '2026-11-02', price: 'Rs.78 to Rs.82', size: '2,34,68,846' },
  { list: 'upcoming', company: 'M. K. Sons Fine Jewels Limited', symbol: 'MKSONS', type: 'EQ', start: '2026-10-28', end: '2026-10-30' },
  { list: 'upcoming', company: 'Dates Pending Limited', symbol: 'DPL', type: 'EQ', start: '', end: '' },
  // the same issue in two lists: merged, not doubled
  { list: 'upcoming', company: 'BLS Polymers Limited', symbol: 'BLSPOLY', type: 'EQ', start: '2026-10-27', end: '2026-10-29', price: 'Rs.100 to Rs.108' }
];

function env(now) { return mock.loadCodeGs({ sheets: [] }, { props: { AB_BRIDGE_TOKEN: TOKEN }, now: now || NOW }); }
function section(rows, title) {
  const i = rows.findIndex((r) => String(r[0]).indexOf(title) === 0);
  assert.ok(i >= 0, 'section ' + title);
  const out = [];
  for (let k = i + 2; k < rows.length && rows[k][0] !== ''; k++) out.push(rows[k]);
  return { title: rows[i][0], rows: out };
}

test('ipos: three sections, mainboard only, listed and stale issues left out', () => {
  const e = env();
  const r = e.post({ token: TOKEN, action: 'ipos', fetchedAt: '2026-10-27 19:28', failed: [], records: REC });
  assert.deepStrictEqual(r, { ok: true, open: 2, closed: 2, upcoming: 3, sme: 2, other: 2, emailed: true });
  const rows = e.sheet('IPO Tracker').rows;
  assert.ok(/SME and debt issues left out/.test(rows[0][0]));
  assert.ok(/Updated 2026-10-27 19:28 IST/.test(rows[1][0]));
  const open = section(rows, 'Open now');
  assert.strictEqual(open.title, 'Open now (2)');
  assert.deepStrictEqual(open.rows.map((x) => [x[1], x[7]]), [['EAAA', 'Closes tomorrow'], ['BLSPOLY', 'Closes in 2 days']]);
  assert.strictEqual(open.rows[0][5], '₹400 to ₹420', 'Rs. shown as the rupee sign');
  assert.strictEqual(open.rows[1][5], '₹100 to ₹108', 'merged from the upcoming list');
  assert.strictEqual(e.call('ab_pbDayKey_', open.rows[0][2]), '2026-10-26', 'real dates');
  const closed = section(rows, 'Closed - awaiting listing');
  assert.deepStrictEqual(closed.rows.map((x) => [x[1], x[7]]), [['JPL', 'Lists on 28-Oct'], ['PARASHLTH', 'Listing date not announced']]);
  const up = section(rows, 'Upcoming');
  assert.deepStrictEqual(up.rows.map((x) => [x[1], x[7]]), [['MKSONS', 'Opens tomorrow'], ['BCSSL', 'Opens in 2 days'], ['DPL', 'Dates not announced']]);
  assert.ok(!JSON.stringify(rows).match(/TINY|RAVITA|TONBO|OLDW|SMCG04|MBL26/), 'SME, debt, listed and stale issues are not shown');
  // the email: one, compact, with the three sections
  assert.strictEqual(e.mails.length, 1);
  const m = e.mails[0][0];
  assert.strictEqual(m.subject, 'IPO Tracker (27-Oct): 2 open, 2 awaiting listing, 3 upcoming');
  assert.ok(/Open now \(2\)/.test(m.htmlBody) && /Closed - awaiting listing \(2\)/.test(m.htmlBody) && /Upcoming \(3\)/.test(m.htmlBody));
  assert.ok(m.htmlBody.length < 20000, 'small email');
});

test('ipos: one email per day; the tab still updates; next day emails again', () => {
  const e = env();
  e.post({ token: TOKEN, action: 'ipos', fetchedAt: '2026-10-27 19:28', records: REC });
  const r2 = e.post({ token: TOKEN, action: 'ipos', fetchedAt: '2026-10-27 20:29', failed: ['past'], records: REC.filter((x) => x.list !== 'past') });
  assert.strictEqual(r2.emailed, false);
  assert.strictEqual(r2.closed, 0);
  assert.strictEqual(e.mails.length, 1);
  const rows = e.sheet('IPO Tracker').rows;
  assert.ok(/20:29/.test(rows[1][0]));
  assert.ok(/Could not read from NSE this time: past/.test(rows[2][0]));
  assert.ok(!JSON.stringify(rows).match(/PARASHLTH/), 'old rows are not kept');
  e.setNow(NOW + 864e5);
  assert.strictEqual(e.post({ token: TOKEN, action: 'ipos', fetchedAt: '2026-10-28 19:10', records: REC }).emailed, true);
  assert.strictEqual(e.mails.length, 2);
});

test('ipos: bad token or no records', () => {
  const e = env();
  assert.deepStrictEqual(e.post({ token: 'nope', action: 'ipos', records: REC }), { ok: false, error: 'bad token' });
  assert.strictEqual(e.post({ token: TOKEN, action: 'ipos' }).ok, false);
  const r = e.post({ token: TOKEN, action: 'ipos', records: [] });
  assert.strictEqual(r.ok, true);
  const rows = e.sheet('IPO Tracker').rows;
  assert.strictEqual(section(rows, 'Open now').rows[0][0], 'None');
});

test('ipos: equity / SME / debt kinds', () => {
  const e = env();
  const kind = (r) => e.call('ab_ipotKind_', r);
  assert.strictEqual(kind({ type: 'EQ', symbol: 'ABC' }), 'main');
  assert.strictEqual(kind({ type: 'SME', symbol: 'ABC' }), 'sme');
  assert.strictEqual(kind({ type: 'DEBT', symbol: 'SMCG04' }), 'other');
  assert.strictEqual(kind({ type: 'InvIT', symbol: 'XINVIT' }), 'other');
  assert.strictEqual(kind({ type: '', symbol: 'SMCG04', price: '\u20B91,000' }), 'other', 'untyped NCD');
  assert.strictEqual(kind({ type: '', symbol: 'PARASHLTH', price: '\u20B9660 to \u20B9693' }), 'main');
  assert.strictEqual(kind({ type: '', symbol: 'NEW2026', price: '\u20B9100 to \u20B9110' }), 'main', 'a price range is an equity issue');
});
