'use strict';
// Code.gs doPost action 'ipos': the PC bridge posts NSE's IPO lists (current, past
// issues, upcoming); the "IPO Tracker" tab is rebuilt with Open now / Closed -
// awaiting listing / Upcoming / Listed recently (mainboard only: EQ and BE) and one
// email goes out per IST day. The IPO workflow (owner, 01-Nov-2026): closed issues go
// to the New IPOs tab, on the listing day to the IPOs tab and Main, LISTING PRICE =
// the listing day's open, Main's Basic Industry from NSE's quote; T+3 listing days.
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

test('ipos: four sections, mainboard only, stale issues left out, T+3 when NSE has no listing date yet', () => {
  const e = env();
  const r = e.post({ token: TOKEN, action: 'ipos', fetchedAt: '2026-10-27 19:28', failed: [], records: REC });
  assert.deepStrictEqual([r.ok, r.open, r.closed, r.upcoming, r.listed, r.sme, r.other, r.emailed], [true, 2, 2, 3, 1, 2, 2, true]);
  assert.deepStrictEqual(Array.from(r.soon), ['JPL lists tomorrow (NSE)', 'PARASHLTH lists tomorrow (T+3, not confirmed by NSE yet)']);
  const rows = e.sheet('IPO Tracker').rows;
  assert.ok(/EQ and BE; SME and debt issues left out/.test(rows[0][0]));
  assert.ok(/Updated 2026-10-27 19:28 IST/.test(rows[1][0]));
  const open = section(rows, 'Open now');
  assert.strictEqual(open.title, 'Open now (2)');
  assert.deepStrictEqual(open.rows.map((x) => [x[1], x[7]]), [['EAAA', 'Closes tomorrow'], ['BLSPOLY', 'Closes in 2 days']]);
  assert.strictEqual(open.rows[0][5], '₹400 to ₹420', 'Rs. shown as the rupee sign');
  assert.strictEqual(open.rows[1][5], '₹100 to ₹108', 'merged from the upcoming list');
  assert.strictEqual(e.call('ab_pbDayKey_', open.rows[0][2]), '2026-10-26', 'real dates');
  const closed = section(rows, 'Closed - awaiting listing');
  assert.deepStrictEqual(closed.rows.map((x) => [x[1], x[7]]),
    [['JPL', 'Lists tomorrow (NSE)'], ['PARASHLTH', 'Expected to list tomorrow (T+3, not confirmed by NSE yet)']]);
  assert.strictEqual(e.call('ab_pbDayKey_', closed.rows[1][4]), '2026-10-28', 'closed Fri 23-Oct: T+3 = Wed 28-Oct');
  const up = section(rows, 'Upcoming');
  assert.deepStrictEqual(up.rows.map((x) => [x[1], x[7]]), [['MKSONS', 'Opens tomorrow'], ['BCSSL', 'Opens in 2 days'], ['DPL', 'Dates not announced']]);
  const listed = section(rows, 'Listed recently');
  assert.deepStrictEqual(listed.rows.map((x) => [x[1], x[9]]), [['TONBO', 'Listed on 23-Oct']]);
  assert.ok(!JSON.stringify(rows).match(/TINY|RAVITA|OLDW|SMCG04|MBL26/), 'SME, debt and stale issues are not shown');
  // the email: one, compact, listings first, then the four sections
  assert.strictEqual(e.mails.length, 1);
  const m = e.mails[0][0];
  assert.strictEqual(m.subject, 'IPO Tracker (27-Oct): JPL, PARASHLTH on Wed 28-Oct | 2 open, 2 awaiting listing, 3 upcoming, 1 listed recently');
  assert.ok(/Listing today \/ next trading day/.test(m.htmlBody) && m.htmlBody.indexOf('Listing today') < m.htmlBody.indexOf('Open now'));
  assert.ok(/Jio Platforms Limited \(JPL\) lists tomorrow - confirmed by NSE/.test(m.body), m.body);
  assert.ok(/Paras Healthcare Limited \(PARASHLTH\) lists tomorrow - expected \(T\+3\), not confirmed by NSE yet; price band/.test(m.body), m.body);
  assert.ok(/Open now \(2\)/.test(m.htmlBody) && /Closed - awaiting listing \(2\)/.test(m.htmlBody) && /Upcoming \(3\)/.test(m.htmlBody) &&
            /Listed recently \(1\)/.test(m.htmlBody));
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
  assert.strictEqual(kind({ type: 'BE', symbol: 'NITYAS' }), 'main', 'BE: a smaller mainboard issue, trade-for-trade at first');
  assert.strictEqual(kind({ type: 'SME', symbol: 'ABC' }), 'sme');
  assert.strictEqual(kind({ type: 'DEBT', symbol: 'SMCG04' }), 'other');
  assert.strictEqual(kind({ type: 'InvIT', symbol: 'XINVIT' }), 'other');
  assert.strictEqual(kind({ type: '', symbol: 'SMCG04', price: '\u20B91,000' }), 'other', 'untyped NCD');
  assert.strictEqual(kind({ type: '', symbol: 'PARASHLTH', price: '\u20B9660 to \u20B9693' }), 'main');
  assert.strictEqual(kind({ type: '', symbol: 'NEW2026', price: '\u20B9100 to \u20B9110' }), 'main', 'a price range is an equity issue');
});

test('T+3: trading days after the close skip weekends and NSE holidays', () => {
  const e = env();
  const t3 = (d, h) => e.call('ab_ipoTradingDayAfter_', d, 3, h || []);
  assert.strictEqual(t3('2026-10-23'), '2026-10-28', 'JPL: Fri -> Wed');
  assert.strictEqual(t3('2026-10-19', ['2026-10-20']), '2026-10-23', 'TONBO: Mon, Tue a holiday -> Fri');
  assert.strictEqual(t3('2026-10-16', ['2026-10-20']), '2026-10-22', 'FUSIONCX');
  assert.strictEqual(t3('2026-10-28'), '2026-11-02', 'EDELALTS');
  assert.strictEqual(t3('2026-10-29'), '2026-11-03', 'BLSPOLY / SFCTECH');
});

// ---------------------------------------------------------------- the IPO workflow
const MON = Date.UTC(2026, 10, 2, 2, 30);              // Mon 02-Nov-2026 08:00 IST
const D = (y, m, d) => new Date(y, m - 1, d);
function book() {
  return { sheets: [
    { name: 'Main', rows: [['Stock Blueprint'],
      ['Checkbox', 'StockName', 'SYMBOL', 'Sector', 'Industry', 'Basic Industry', 'MKT Price', 'Price Fall Alert Price', 'Breakout Alert Price', 'Triggered Y/N'],
      [false, 'Reliance Industries Ltd', 'RELIANCE', 'Oil, Gas & Consumable Fuels', 'Petroleum Products', 'Refineries & Marketing', 1400],
      [false, 'Tonbo Imaging India Ltd', 'TONBO', '', '', 'Aerospace & Defense', 812]] },
    { name: 'IPOs', rows: [['S.No', 'NSE SYMBOL', 'LISTING DATE', 'LISTING PRICE', 'MarketPrice'],
      [1, 'FUSIONCX', D(2026, 10, 22), 300, 310], [2, 'TONBO', D(2026, 10, 23), '', 820]] },
    { name: 'New IPOs', rows: [['COMPANY NAME', 'SECURITY TYPE', 'Symbol', 'DATE OF LISTING'],
      ['Tonbo Imaging India Limited', 'EQ', 'TONBO', D(2026, 10, 23)], ['Fusion CX Limited', 'EQ', 'FUSIONCX', D(2026, 10, 22)]],
      numFmts: [[], [null, null, null, 'dd-mmm-yy'], [null, null, null, 'dd-mmm-yy']] }
  ] };
}
const AERO = { macro: 'Industrials', sector: 'Capital Goods', industry: 'Aerospace & Defense', basic: 'Aerospace & Defense' };
const WORK = [
  { list: 'past', company: 'EAAA India Alternatives Limited', symbol: 'EDELALTS', type: 'EQ', start: '2026-10-26', end: '2026-10-28',
    listing: '', price: 'Rs.1585 to Rs.1665', nseListing: '2026-11-02', industry: { macro: 'Financial Services', sector: 'Financial Services',
      industry: 'Capital Markets', basic: 'Asset Management Company' } },
  { list: 'past', company: 'BLS Polymers Limited', symbol: 'BLSPOLY', type: 'EQ', start: '2026-10-27', end: '2026-10-29', listing: '', price: 'Rs.142 to Rs.150' },
  { list: 'past', company: 'SFC Environmental Technologies Limited', symbol: 'SFCTECH', type: 'BE', start: '2026-10-27', end: '2026-10-29', listing: '' },
  { list: 'past', company: 'Jio Platforms Limited', symbol: 'JPL', type: 'EQ', start: '2026-10-21', end: '2026-10-23', listing: '2026-10-28',
    issue: '1119', day1: [1150, 1180, 1120, 1170.5], last: ['2026-10-30', 1231], industry: AERO },
  { list: 'past', company: 'Tonbo Imaging India Limited', symbol: 'TONBO', type: 'EQ', start: '2026-10-15', end: '2026-10-19', listing: '2026-10-23',
    issue: '700', day1: [812, 830, 790, 805.4], last: ['2026-10-30', 842.3], industry: { macro: 'x', sector: 'y', industry: 'z', basic: 'Something Else' } },
  { list: 'upcoming', company: 'Later Limited', symbol: 'LATER', type: 'EQ', start: '2026-11-05', end: '2026-11-09' }
];
const work = (e, extra) => e.post(Object.assign({ token: TOKEN, action: 'ipos', fetchedAt: '2026-11-02 08:00', records: WORK, holidays: ['2026-11-10'] }, extra || {}));

test('workflow: listing-day adds to IPOs + Main, New IPOs rows, listing price, Basic Industry, one email', () => {
  const e = mock.loadCodeGs(book(), { props: { AB_BRIDGE_TOKEN: TOKEN }, now: MON });
  const r = work(e);
  assert.deepStrictEqual(Array.from(r.problems), []);
  assert.deepStrictEqual(Array.from(r.soon), ['EDELALTS lists today (NSE)', 'BLSPOLY lists tomorrow (T+3, not confirmed by NSE yet)',
    'SFCTECH lists tomorrow (T+3, not confirmed by NSE yet)']);
  assert.deepStrictEqual(Array.from(r.added), ['JPL', 'EDELALTS'], 'listed 28-Oct (caught up) and today; TONBO was there');
  assert.deepStrictEqual(Array.from(r.newIpos), ['BLSPOLY', 'SFCTECH', 'EDELALTS', 'JPL']);
  assert.deepStrictEqual(Array.from(r.priced), ['TONBO 812'], 'TONBO\'s blank LISTING PRICE = its listing-day open');
  assert.deepStrictEqual(Array.from(r.industry), ['JPL: Aerospace & Defense', 'EDELALTS: Asset Management Company']);
  // Main: the new stocks after the last one, NSE's name, Basic Industry + Sector / Industry; TONBO's typed Basic Industry kept
  const main = e.sheet('Main').rows;
  const row = (sym) => main.find((x) => x[2] === sym);
  assert.deepStrictEqual(main.slice(4).map((x) => x[2]), ['JPL', 'EDELALTS']);
  assert.deepStrictEqual(row('JPL').slice(1, 6), ['Jio Platforms Limited', 'JPL', 'Capital Goods', 'Aerospace & Defense', 'Aerospace & Defense']);
  assert.strictEqual(row('EDELALTS')[5], 'Asset Management Company');
  assert.strictEqual(row('TONBO')[5], 'Aerospace & Defense', 'never overwritten');
  // IPOs tab: listing date, listing price (JPL: its listing-day open; EDELALTS: not known yet)
  const ipos = e.sheet('IPOs').rows;
  const ipo = (sym) => ipos.find((x) => x[1] === sym);
  assert.deepStrictEqual(ipos.slice(1).map((x) => x[1]), ['FUSIONCX', 'TONBO', 'JPL', 'EDELALTS']);
  assert.strictEqual(e.call('ab_pbDayKey_', ipo('JPL')[2]), '2026-10-28');
  assert.deepStrictEqual([ipo('JPL')[3], ipo('EDELALTS')[3], ipo('TONBO')[3], ipo('FUSIONCX')[3]], [1150, '', 812, 300]);
  // New IPOs tab: new rows on top (newest close first), NSE's date only, written like the cells there, a NOTE column
  const nw = e.sheet('New IPOs').rows;
  assert.strictEqual(nw[0][4], 'NOTE');
  assert.deepStrictEqual(nw.slice(1, 7).map((x) => [x[2], x[1], x[3] && typeof x[3].getTime === 'function' ? e.call('ab_pbDayKey_', x[3]) : x[3], x[4] || '']), [
    ['BLSPOLY', 'EQ', '', 'Closed 29-Oct; listing expected 03-Nov (T+3)'],
    ['SFCTECH', 'BE', '', 'Closed 29-Oct; listing expected 03-Nov (T+3)'],
    ['EDELALTS', 'EQ', '2026-11-02', 'Added to the IPOs tab + Main on 02-Nov'],
    ['JPL', 'EQ', '2026-10-28', 'Added to the IPOs tab + Main on 02-Nov'],
    ['TONBO', 'EQ', '2026-10-23', 'Listed on 23-Oct (NSE)'],
    ['FUSIONCX', 'EQ', '2026-10-22', '']]);
  // the tracker: EDELALTS lists today (no candle yet), JPL / TONBO listed recently with gains
  const rows = e.sheet('IPO Tracker').rows;
  assert.deepStrictEqual(section(rows, 'Closed - awaiting listing').rows.map((x) => [x[1], x[7]]), [
    ['EDELALTS', 'Lists today (NSE)'], ['BLSPOLY', 'Expected to list tomorrow (T+3, not confirmed by NSE yet)'],
    ['SFCTECH', 'Expected to list tomorrow (T+3, not confirmed by NSE yet)']]);
  const listed = section(rows, 'Listed recently').rows;
  assert.deepStrictEqual(listed.map((x) => [x[1], x[4], x[5], Math.round(x[6] * 1000) / 1000, x[7], Math.round(x[8] * 1000) / 1000, x[9]]), [
    ['JPL', 1119, 1150, 0.028, 1231, 0.1, 'Listed on 28-Oct; last close on 30-Oct'],
    ['TONBO', 700, 812, 0.16, 842.3, 0.203, 'Listed on 23-Oct; last close on 30-Oct']]);
  // one email with everything: listings first, what the sheet did, the sections
  assert.strictEqual(e.mails.length, 1);
  const m = e.mails[0][0];
  assert.strictEqual(m.subject, 'IPO Tracker (02-Nov): EDELALTS lists today; BLSPOLY, SFCTECH on Tue 03-Nov | 0 open, 3 awaiting listing, 1 upcoming, 2 listed recently');
  assert.ok(/Added to the IPOs tab and Main: JPL, EDELALTS/.test(m.body) && /LISTING PRICE filled \(listing-day open\): TONBO 812/.test(m.body), m.body);
  assert.ok(/Jio Platforms Limited \(JPL\): listed 28-Oct, issue ₹1,119, listing ₹1,150 \(\+2\.8%\), last ₹1,231 \(\+10\.0% since issue\)/.test(m.body), m.body);
  // the next round the same day: nothing done twice, no second email
  const r2 = work(e, { fetchedAt: '2026-11-02 09:05' });
  assert.deepStrictEqual([r2.added, r2.newIpos, r2.priced, r2.industry, r2.problems].map((x) => x.length), [0, 0, 0, 0, 0]);
  assert.strictEqual(e.mails.length, 1);
  assert.strictEqual(e.sheet('Main').rows.filter((x) => x[2] === 'JPL').length, 1);
});

test('workflow: NSE confirms a date later; a stock you delete from Main is not added back', () => {
  const e = mock.loadCodeGs(book(), { props: { AB_BRIDGE_TOKEN: TOKEN }, now: MON });
  work(e);
  // you delete JPL from Main; the next day NSE confirms BLSPOLY for 03-Nov and the bhavcopy has EDELALTS's listing day
  const main = e.sheet('Main').rows;
  main.splice(main.findIndex((x) => x[2] === 'JPL'), 1);
  e.setNow(MON + 864e5);
  const recs = WORK.map((x) => Object.assign({}, x));
  recs[1].nseListing = '2026-11-03';
  recs[0].day1 = [1700, 1750, 1650, 1720];
  recs[0].last = ['2026-11-02', 1720];
  const r = work(e, { records: recs, fetchedAt: '2026-11-03 08:00' });
  assert.deepStrictEqual(Array.from(r.added), ['BLSPOLY'], 'JPL is not added back');
  assert.deepStrictEqual(Array.from(r.priced), ['EDELALTS 1700']);
  assert.deepStrictEqual(Array.from(r.soon), ['BLSPOLY lists today (NSE)', 'SFCTECH lists today (T+3, not confirmed by NSE yet)']);
  assert.ok(!e.sheet('Main').rows.some((x) => x[2] === 'JPL'));
  const nw = e.sheet('New IPOs').rows;
  const bls = nw.find((x) => x[2] === 'BLSPOLY');
  assert.strictEqual(e.call('ab_pbDayKey_', bls[3]), '2026-11-03', 'the date once NSE gave it');
  assert.strictEqual(bls[4], 'Added to the IPOs tab + Main on 03-Nov');
  assert.strictEqual(e.mails.length, 2, 'the next day\'s email');
});

test('workflow: the New IPOs tab with text dates gets text dates; problems are reported, the tab and email still go', () => {
  const b = book();
  b.sheets[2] = { name: 'New IPOs', rows: [['COMPANY NAME', 'SECURITY TYPE', 'Symbol', 'DATE OF LISTING'], ['Tonbo Imaging India Limited', 'EQ', 'TONBO', '23-Oct-26']] };
  b.sheets.splice(1, 1);                                   // no IPOs tab
  const e = mock.loadCodeGs(b, { props: { AB_BRIDGE_TOKEN: TOKEN }, now: MON });
  const r = work(e);
  assert.ok(r.problems.some((p) => /^IPOs tab \+ Main: Could not find an "IPOs" tab/.test(p)), JSON.stringify(r.problems));
  assert.strictEqual(e.sheet('New IPOs').rows.find((x) => x[2] === 'EDELALTS')[3], '02-Nov-26');
  assert.ok(section(e.sheet('IPO Tracker').rows, 'Listed recently').rows.length === 2);
  assert.strictEqual(e.mails.length, 1);
  assert.ok(/Could not finish: IPOs tab \+ Main/.test(e.mails[0][0].body));
});
