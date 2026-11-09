'use strict';
// Code2.gs doPost action 'intraday' (owner, 07-Nov-2026: "PARAGMILK - in the 4 hour timeframe a Spring candlestick
// pattern formed in an FVG; due to lack of this intraday data I missed this opportunity"): the PC (kite_intraday.py)
// asks for PatternData's symbols ({op: 'syms'}) and sends the Spring / Spring in FVG it found on Kite's candles
// ({op: 'put'}) -> tab "Intraday Patterns"; the site feed part 'intraday' (Code.gs ab_site_itd_) = export_xlsx.py
// intraday_patterns(): the allowed columns only (no Kite prices), the newest 10 sessions.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const mock = require('./fixtures/apps-script-mock.js');

const TOKEN = 'bridge-token-0123456789';
const NOW = Date.UTC(2026, 10, 6, 13, 30);          // Fri 06-Nov-2026 19:00 IST
function workbook() {
  return { sheets: [
    { name: 'Main', rows: [['Main watchlist'], ['Checkbox', 'StockName', 'SYMBOL'], [false, 'Parag Milk Foods Ltd.', 'PARAGMILK'],
      [false, 'Mahindra & Mahindra', 'M&M'], [false, 'Flat Co', 'FLAT']] },
    { name: 'PatternData', rows: [['Name', 'Sector', 'Industry', 'Symbol'], ['', '', '', 'PARAGMILK'], ['', '', '', 'M&M'], ['', '', '', 'FLAT']] }
  ] };
}
function env() { return mock.loadCodeGs(workbook(), { props: { AB_BRIDGE_TOKEN: TOKEN }, now: NOW }); }
const put = (items, extra) => Object.assign({ token: TOKEN, action: 'intraday', op: 'put', upto: '2026-11-06', since: '2026-10-23', items: items }, extra || {});
const PARA = { sym: 'PARAGMILK', tf: '4H', pattern: 'Spring in FVG', candle: '2026-10-30 13:15', session: '2026-10-30', low: 228.054, close: 233.7,
  zone: [232.1, 246, '2026-08-24 09:15'] };

test('intraday: the symbol list, then the patterns on the "Intraday Patterns" tab (newest first, one row each, kept 30 days)', () => {
  const e = env();
  assert.deepStrictEqual(e.post({ token: TOKEN, action: 'intraday', op: 'syms' }), { ok: true, syms: ['PARAGMILK', 'M&M', 'FLAT'], indices: [] });
  const r = e.post(put([
    PARA,
    { sym: 'M&M', tf: '1H', pattern: 'Spring', candle: '2026-11-06 14:15', session: '2026-11-06', low: 3000, close: 3010.5, zone: null },
    { sym: 'flat', tf: 'W', pattern: 'Spring', candle: '2026-11-02', session: '2026-11-06', low: 99, close: 100 },
    { sym: 'FLAT', tf: 'M', pattern: 'Spring in FVG', candle: '2026-10', session: '2026-10-30', low: 90, close: 95, zone: [91, 99, '2026-05'] },
    { sym: 'OTHER', tf: '4H', pattern: 'Spring', candle: '2026-11-06 09:15', session: '2026-11-06' },          // not on PatternData
    { sym: 'FLAT', tf: '3H', pattern: 'Spring', candle: '2026-11-06 09:15', session: '2026-11-06' },          // no such timeframe
    { sym: 'FLAT', tf: '4H', pattern: 'Hammer', candle: '2026-11-06 09:15', session: '2026-11-06' },          // not a pattern sent
    { sym: 'FLAT', tf: '4H', pattern: 'Spring', candle: '06-11-2026', session: '2026-11-06' },               // a bad candle time
    { sym: 'FLAT', tf: 'D', pattern: 'Spring', candle: '2026-09-01', session: '2026-09-01', low: 1, close: 2 }   // older than 30 days
  ]));
  assert.deepStrictEqual(r, { ok: true, received: 9, added: 5, skipped: 4, kept: 4, dropped: 0, replaced: 0, removed: 0, tfs: null, slots: {} });
  const rows = e.sheet('Intraday Patterns').rows;
  assert.match(rows[0][0], /^Spring, Spring in FVG and Gap-up FVG \+ Spring from Zerodha Kite candles .* Last scan: session 2026-11-06 \(2026-11-06 19:00\)\. Kept 30 days\./);
  assert.deepStrictEqual(rows[1], ['Session', 'Symbol', 'Company', 'Timeframe', 'Pattern', 'Candle', 'FVG Formed', 'Chart', 'Low', 'Close', 'FVG Bottom', 'FVG Top', 'Found', 'FVG Detail']);
  assert.deepStrictEqual(rows.slice(2).map((x) => [x[0], x[1], x[3], x[4]]), [
    ['2026-11-06', 'FLAT', 'W', 'Spring'], ['2026-11-06', 'M&M', '1H', 'Spring'],
    ['2026-10-30', 'FLAT', 'M', 'Spring in FVG'], ['2026-10-30', 'PARAGMILK', '4H', 'Spring in FVG']], 'newest session, then the biggest timeframe');
  assert.deepStrictEqual(rows[5], ['2026-10-30', 'PARAGMILK', 'Parag Milk Foods Ltd.', '4H', 'Spring in FVG', '2026-10-30 13:15', '2026-08-24 09:15',
    '=HYPERLINK("https://www.tradingview.com/chart/?symbol=NSE%3APARAGMILK&interval=240","4H chart")', 228.05, 233.7, 232.1, 246, '2026-11-06 19:00', '']);
  assert.strictEqual(rows[3][7], '=HYPERLINK("https://www.tradingview.com/chart/?symbol=NSE%3AM%26M&interval=60","1H chart")');
  assert.deepStrictEqual(rows[3].slice(8, 12), [3000, 3010.5, '', ''], 'no zone for a plain Spring');

  // the same pattern again (the PC re-sends after a stop): one row, the first "Found" kept
  e.setNow(Date.UTC(2026, 10, 9, 12, 0));
  const r2 = e.post(put([PARA, { sym: 'FLAT', tf: '15m', pattern: 'Spring in FVG', candle: '2026-11-09 10:30', session: '2026-11-09', low: 100, close: 101,
    zone: [99.5, 100.5, '2026-11-05 11:00'] }], { upto: '2026-11-09' }));
  assert.deepStrictEqual(r2, { ok: true, received: 2, added: 1, skipped: 0, kept: 5, dropped: 0, replaced: 0, removed: 0, tfs: null, slots: {} });
  const rows2 = e.sheet('Intraday Patterns').rows;
  assert.deepStrictEqual(rows2[2].slice(0, 5), ['2026-11-09', 'FLAT', 'Flat Co', '15m', 'Spring in FVG']);
  assert.strictEqual(rows2.find((x) => x[1] === 'PARAGMILK')[12], '2026-11-06 19:00');

  assert.deepStrictEqual(e.post({ token: TOKEN, action: 'intraday', op: 'nope' }).ok, false);
  assert.deepStrictEqual(e.post({ token: TOKEN, action: 'intraday', op: 'put' }), { ok: false, error: 'items missing' });
  assert.deepStrictEqual(e.post({ token: 'bad', action: 'intraday', op: 'syms' }), { ok: false, error: 'bad token' });
});

test('intraday: tfs = the timeframes the PC reports now (owner, 08-Nov-2026: "only 4hr, D, W, M") - other rows leave the tab', () => {
  const e = env();
  e.post(put([PARA, { sym: 'FLAT', tf: '15m', pattern: 'Spring in FVG', candle: '2026-11-06 10:30', session: '2026-11-06', low: 100, close: 101, zone: [99, 100.5, '2026-11-05 11:00'] },
    { sym: 'M&M', tf: '1H', pattern: 'Spring', candle: '2026-11-06 14:15', session: '2026-11-06', low: 3000, close: 3010 }]));
  assert.strictEqual(e.sheet('Intraday Patterns').rows.length, 5);
  const r = e.post(put([{ sym: 'FLAT', tf: 'D', pattern: 'Spring', candle: '2026-11-06', session: '2026-11-06', low: 99, close: 100 },
    { sym: 'FLAT', tf: '30m', pattern: 'Spring in FVG', candle: '2026-11-06 11:15', session: '2026-11-06', low: 99, close: 100 }], { tfs: ['4H', 'D', 'W', 'M', 'nope'] }));
  assert.deepStrictEqual(r, { ok: true, received: 2, added: 1, skipped: 1, kept: 2, dropped: 2, replaced: 0, removed: 0, tfs: ['M', 'W', 'D', '4H'], slots: {} });
  const rows = e.sheet('Intraday Patterns').rows;
  assert.deepStrictEqual(rows.slice(2).map((x) => x[1] + ' ' + x[3]), ['FLAT D', 'PARAGMILK 4H'], 'the 15m and 1H rows are gone, the 30m one was not added');
  assert.match(rows[0][0], /candles \(your PC program\): 4H, D, W, M \(4H = 09:15-13:15 \/ 13:15-15:30\) - the sheet's/);

  // 4H: only the day's 2nd candle (owner, 08-Nov-2026: "only 13.15 4hr candle ... not first one")
  e.post(put([{ sym: 'M&M', tf: '4H', pattern: 'Spring', candle: '2026-11-05 09:15', session: '2026-11-05', low: 3000, close: 3010 }], { tfs: ['4H', 'D', 'W', 'M'] }));
  assert.ok(e.sheet('Intraday Patterns').rows.some((x) => x[1] === 'M&M' && x[5] === '2026-11-05 09:15'), 'kept while no candle rule is sent');
  const r3 = e.post(put([{ sym: 'FLAT', tf: '4H', pattern: 'Spring in FVG', candle: '2026-11-06 09:15', session: '2026-11-06', low: 99, close: 100 },
    { sym: 'FLAT', tf: '4H', pattern: 'Spring', candle: '2026-11-06 13:15', session: '2026-11-06', low: 99, close: 100 }],
  { tfs: ['4H', 'D', 'W', 'M'], slots: { '4H': ['13:15'], D: ['10:00'], bad: ['13:15'], '1H': ['x'] } }));
  assert.deepStrictEqual(r3, { ok: true, received: 2, added: 1, skipped: 1, kept: 3, dropped: 1, replaced: 0, removed: 0, tfs: ['M', 'W', 'D', '4H'], slots: { '4H': ['13:15'] } });
  const rows3 = e.sheet('Intraday Patterns').rows;
  assert.deepStrictEqual(rows3.slice(2).map((x) => x[1] + ' ' + x[3] + ' ' + x[5]), ['FLAT D 2026-11-06', 'FLAT 4H 2026-11-06 13:15', 'PARAGMILK 4H 2026-10-30 13:15'],
    'the 09:15 4H rows are gone, the 13:15 ones and the daily one stay');
  assert.match(rows3[0][0], /4H, D, W, M \(4H Spring: only the day's 2nd candle, 13:15-15:30\)/);
});

test('intraday: FVG+Spring detail, the 4H FVG patterns on every candle, a rescan replaces its sessions (owner, 08-Nov-2026)', () => {
  const e = env();
  const SL = { tfs: ['4H', 'D', 'W', 'M'], slots: { '4H': ['13:15'] } };
  e.post(put([PARA, { sym: 'FLAT', tf: 'D', pattern: 'Spring in FVG', candle: '2026-10-28', session: '2026-10-28', low: 1, close: 2, zone: [1, 2, '2026-10-01'] },
    { sym: 'FLAT', tf: 'D', pattern: 'Spring', candle: '2026-10-20', session: '2026-10-20', low: 1, close: 2 }], SL));
  assert.strictEqual(e.sheet('Intraday Patterns').rows.length, 5);
  // the PC's first post after the new rules: rows of sessions after `since` are replaced, older ones stay
  const r = e.post(put([
    { sym: 'M&M', tf: '4H', pattern: 'Spring in FVG', candle: '2026-11-05 13:15', session: '2026-11-05', low: 3000, close: 3020,
      zone: [2990, 3010, '2026-10-20 09:15', 'FVG', 'top', 2] },
    { sym: 'FLAT', tf: 'W', pattern: 'Spring in FVG', candle: '2026-11-02', session: '2026-11-06', low: 99, close: 100,
      zone: [99.5, 104, '2026-09-07', 'Gap-up', 'bottom', 5] },
    { sym: 'FLAT', tf: '4H', pattern: 'FVG First Touch', candle: '2026-11-06 09:15', session: '2026-11-06', low: 99, close: 100,
      zone: [98, 99.5, '2026-11-02 13:15', 'FVG'] },
    { sym: 'FLAT', tf: '4H', pattern: 'Twin Star Bottom + FVG', candle: '2026-11-04 09:15', session: '2026-11-04', low: 99, close: 100,
      zone: [98, 99.5, '2026-11-02 13:15', 'FVG'] },
    { sym: 'FLAT', tf: '4H', pattern: 'Spring', candle: '2026-11-04 09:15', session: '2026-11-04', low: 99, close: 100 }      // 09:15 Spring: no
  ], Object.assign({ since: '2026-10-24', first: true }, SL)));
  assert.deepStrictEqual([r.added, r.skipped, r.replaced, r.kept], [4, 1, 2, 5], JSON.stringify(r));
  const rows = e.sheet('Intraday Patterns').rows;
  const by = (sym, tf, pat) => rows.find((x) => x[1] === sym && x[3] === tf && x[4] === pat);
  assert.strictEqual(by('M&M', '4H', 'Spring in FVG')[13], 'FVG top (touch 2)');
  assert.strictEqual(by('FLAT', 'W', 'Spring in FVG')[13], 'Gap-up bottom (touch 5)');
  assert.strictEqual(by('FLAT', '4H', 'FVG First Touch')[13], 'FVG', 'the 4H FVG patterns count on the 09:15 candle too');
  assert.ok(by('FLAT', '4H', 'Twin Star Bottom + FVG'));
  assert.ok(!by('PARAGMILK', '4H', 'Spring in FVG') && !by('FLAT', 'D', 'Spring in FVG'), 'the old rule\'s rows after since are gone');
  assert.ok(by('FLAT', 'D', 'Spring'), 'a session before since stays');
  assert.match(rows[0][0], /anywhere on a 3-candle FVG or under its bottom line, closing above the bottom, no earlier close under the Spring low; Gap-up FVG \+ Spring = the same on a Gap-up zone/);
});

test('intraday: a Spring in FVG a later candle closed below is taken off (owner, 08-Nov-2026); FVG Detail "middle"', () => {
  const e = env();
  const SL = { tfs: ['4H', 'D', 'W', 'M'], slots: { '4H': ['13:15'] } };
  e.post(put([PARA, { sym: 'FLAT', tf: 'D', pattern: 'Spring in FVG', candle: '2026-10-28', session: '2026-10-28', low: 1, close: 2,
    zone: [0.5, 3, '2026-10-01', 'FVG', 'middle', 3] }, { sym: 'FLAT', tf: 'D', pattern: 'Spring', candle: '2026-10-29', session: '2026-10-29', low: 1, close: 2 }], SL));
  assert.strictEqual(e.sheet('Intraday Patterns').rows.find((x) => x[1] === 'FLAT' && x[4] === 'Spring in FVG')[13], 'FVG middle (touch 3)');
  const r = e.post(put([{ sym: 'PARAGMILK', tf: '4H', pattern: 'Spring in FVG', candle: '2026-10-30 13:15', session: '2026-10-30', low: 1, close: 2 }],
    Object.assign({ since: '2026-11-05', first: true, upto: '2026-11-06',
      invalid: [{ sym: 'PARAGMILK', tf: '4H', candle: '2026-10-30 13:15' }, { sym: 'FLAT', tf: 'D', candle: '2026-10-29' }, { tf: 'D' }] }, SL)));
  assert.deepStrictEqual([r.removed, r.added, r.skipped], [1, 0, 1], JSON.stringify(r));
  const rows = e.sheet('Intraday Patterns').rows.slice(2).map((x) => x[1] + ' ' + x[3] + ' ' + x[4]);
  assert.deepStrictEqual(rows, ['FLAT D Spring', 'FLAT D Spring in FVG'], 'PARAGMILK gone and not added again; a plain Spring stays');
});

const PRICES = { PARAGMILK: 240, 'M&M': 3050, FLAT: 101 };
function zoneBook() {
  const b = workbook();
  b.sheets[0].rows[1] = ['Checkbox', 'StockName', 'SYMBOL', 'MKT Price'];
  for (let i = 2; i < b.sheets[0].rows.length; i++) b.sheets[0].rows[i].push(PRICES[b.sheets[0].rows[i][2]]);
  return b;
}
const zput = (zones, mitigated, extra) => Object.assign({ token: TOKEN, action: 'intraday', op: 'zones', upto: '2026-11-06', since: '2026-11-05', tf: '4H',
  zones: zones, mitigated: mitigated || [] }, extra || {});

test('4H FVG zones: the tab, the live check in market hours, the PC\'s touched zones, one combined mitigated email an hour', () => {
  const e = mock.loadCodeGs(zoneBook(), { props: { AB_BRIDGE_TOKEN: TOKEN }, now: NOW });
  const r = e.post(zput([
    { sym: 'PARAGMILK', tf: '4H', zone: [229.9, 238, '2026-10-20 13:15', 'FVG'], pct: 3.52 },
    { sym: 'M&M', tf: '4H', zone: [2950, 3040, '2026-11-03 09:15', 'Gap-up'], pct: 3.05 },
    { sym: 'FLAT', tf: '4H', zone: [90, 95, '2026-10-01 13:15', 'FVG'] },
    { sym: 'OTHER', tf: '4H', zone: [1, 2, '2026-10-01 13:15', 'FVG'] },                 // not on PatternData
    { sym: 'FLAT', tf: '4H', zone: [96, 95, '2026-10-02 13:15', 'FVG'] }                 // top under the bottom
  ]));
  assert.deepStrictEqual(r, { ok: true, received: 5, kept: 3, skipped: 2, logged: 0 });
  const t = e.sheet('4H FVG Zones').rows;
  assert.match(t[0][0], /^4H FVG zones from Zerodha Kite 4H candles \(your PC program, session 2026-11-06\): .* kept after its first touch/);
  assert.deepStrictEqual(t[1], ['Symbol', 'Company', 'Kind', 'Zone Bottom', 'Zone Top', 'Zone %', 'Formed', 'Distance %', 'Chart',
    'Mitigated Alerted', 'Mitigated At', 'Updated', 'Inside FVG']);
  assert.deepStrictEqual(t.slice(2).map((x) => x.slice(0, 8)), [
    ['FLAT', 'Flat Co', 'FVG', 90, 95, 5.56, '2026-10-01 13:15', 6.32],
    ['M&M', 'Mahindra & Mahindra', 'Gap-up', 2950, 3040, 3.05, '2026-11-03 09:15', 0.33],
    ['PARAGMILK', 'Parag Milk Foods Ltd.', 'FVG', 229.9, 238, 3.52, '2026-10-20 13:15', 0.84]]);
  assert.strictEqual(t[3][8], '=HYPERLINK("https://www.tradingview.com/chart/?symbol=NSE%3AM%26M&interval=240","4H chart")');

  // outside market hours (Fri 19:00) the live check does nothing
  assert.deepStrictEqual(e.run('ab_itdZoneCheck_().length'), 0);
  // Mon 09-Nov 11:00 IST: M&M at 3035 is under its zone top 3040 = mitigated
  e.setNow(Date.UTC(2026, 10, 9, 5, 30));
  e.sheet('Main').rows[3][3] = 3035;
  const mails0 = e.mails.length;
  assert.deepStrictEqual(JSON.parse(e.run('JSON.stringify(ab_itdZoneCheck_().map(function (r) { return r.sym; }))')), ['M&M']);
  const z2 = e.sheet('4H FVG Zones').rows;
  assert.deepStrictEqual(z2[3].slice(9, 11), ['Y', '2026-11-09 11:00']);
  assert.strictEqual(z2[3][7], -0.16);
  const log = e.sheet('Mitigated FVG Log').rows;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(log[log.length - 1].slice(2, 8))), ['4H Gap-up FVG', 'M&M', 2950, 3040, 3.05, '3035 (Live)']);
  // a second check: no new log row (alerted once)
  e.run('ab_itdZoneCheck_()');
  assert.strictEqual(e.sheet('Mitigated FVG Log').rows.length, log.length);
  // the hourly email: the first one goes at once, with every zone not emailed yet
  assert.strictEqual(e.run('ab_mitMailFlush_(false)'), 1);
  assert.strictEqual(e.mails.length, mails0 + 1);
  const m = e.mails[e.mails.length - 1][0];
  assert.match(m.subject, /^Mitigated FVG - 1: M&M \(09-Nov-2026 11:00\)$/);
  assert.match(m.htmlBody, /4H GAP-UP FVG \(ZERODHA, YOUR PC\)/);
  assert.match(m.htmlBody, /interval=240/);
  // the PC's next scan: PARAGMILK's zone was touched by a 4H candle the live check missed -> logged as EOD, the email waits
  // for the hour; FLAT's zone is still untouched; M&M (alerted) gone
  e.setNow(Date.UTC(2026, 10, 9, 5, 50));
  const r2 = e.post(zput([{ sym: 'FLAT', tf: '4H', zone: [90, 95, '2026-10-01 13:15', 'FVG'] }],
    [{ sym: 'PARAGMILK', tf: '4H', zone: [229.9, 238, '2026-10-20 13:15', 'FVG'], candle: '2026-11-09 09:15', low: 237.5 },
     { sym: 'M&M', tf: '4H', zone: [2950, 3040, '2026-11-03 09:15', 'Gap-up'], candle: '2026-11-09 09:15', low: 3030 },
     { sym: 'FLAT', tf: '4H', zone: [80, 85, '2026-09-01 13:15', 'FVG'], candle: '2026-11-09 09:15', low: 84 }], { upto: '2026-11-09', since: '2026-11-06' }));
  assert.deepStrictEqual(r2, { ok: true, received: 1, kept: 1, skipped: 0, logged: 1 });
  const log2 = e.sheet('Mitigated FVG Log').rows;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(log2[log2.length - 1].slice(0, 8))), ['09-Nov-2026', '11:20', '4H FVG', 'PARAGMILK', 229.9, 238, 3.52, '237.5 (EOD, 4H candle 09:15)']);
  assert.strictEqual(e.mails.length, mails0 + 1, 'the hour since the last mitigated email is not up yet');
  e.setNow(Date.UTC(2026, 10, 9, 6, 31));
  assert.strictEqual(e.run('ab_mitMailFlush_(false)'), 1);
  assert.match(e.mails[e.mails.length - 1][0].subject, /^Mitigated FVG - 1: PARAGMILK/);
  assert.strictEqual(e.run('ab_mitMailFlush_(true)'), 0, 'nothing new');
});

test('4H Gap-up zones (owner, 08-Nov-2026): kept after the first touch (mitigated quietly), inside FVG typed apart, first in the email', () => {
  const e = mock.loadCodeGs(zoneBook(), { props: { AB_BRIDGE_TOKEN: TOKEN }, now: NOW });
  // M&M's Gap-up was touched by a 4H candle before the sheet ever listed it -> listed as mitigated, no email; FLAT's
  // Gap-up lies in a 3-candle FVG and is untouched
  const r = e.post(zput([
    { sym: 'M&M', tf: '4H', zone: [2950, 3040, '2026-11-03 09:15', 'Gap-up'], pct: 3.05, touched: '2026-11-05 13:15' },
    { sym: 'FLAT', tf: '4H', zone: [96, 99.5, '2026-11-04 13:15', 'Gap-up'], pct: 3.65, inside: 1 },
    { sym: 'PARAGMILK', tf: '4H', zone: [229.9, 238, '2026-10-20 13:15', 'FVG'], inside: 1 }      // inside is for Gap-ups only
  ]));
  assert.deepStrictEqual([r.kept, r.logged], [3, 0]);
  const rows = () => Object.fromEntries(e.sheet('4H FVG Zones').rows.slice(2).map((x) => [x[0], [x[2], x[9], x[10], x[12]]]));
  assert.deepStrictEqual(rows(), { FLAT: ['Gap-up', '', '', 'Y'], 'M&M': ['Gap-up', 'Y', '2026-11-05 13:15', ''], PARAGMILK: ['FVG', '', '', ''] });
  assert.ok(!e.sheet('Mitigated FVG Log'), 'no log row for a touch before it was listed');
  // Mon 11:00: FLAT at 99.2 (under its top 99.5) -> logged as the inside-FVG kind; M&M at 3035 stays quiet (mitigated before)
  e.setNow(Date.UTC(2026, 10, 9, 5, 30));
  e.sheet('Main').rows[3][3] = 3035;
  e.sheet('Main').rows[4][3] = 99.2;
  assert.deepStrictEqual(JSON.parse(e.run('JSON.stringify(ab_itdZoneCheck_().map(function (r) { return r.sym; }))')), ['FLAT']);
  const log = e.sheet('Mitigated FVG Log').rows;
  assert.deepStrictEqual(log.slice(1).map((x) => x[2] + ' ' + x[3]), ['4H Gap-up FVG (inside FVG) FLAT']);
  // the PC's next scan: both Gap-ups still valid (no close under their bottoms) -> still listed, marks kept
  e.post(zput([
    { sym: 'M&M', tf: '4H', zone: [2950, 3040, '2026-11-03 09:15', 'Gap-up'], pct: 3.05, touched: '2026-11-05 13:15' },
    { sym: 'FLAT', tf: '4H', zone: [96, 99.5, '2026-11-04 13:15', 'Gap-up'], pct: 3.65, inside: 1, touched: '2026-11-09 09:15' }
  ], [{ sym: 'FLAT', tf: '4H', zone: [96, 99.5, '2026-11-04 13:15', 'Gap-up'], candle: '2026-11-09 09:15', low: 99.1, inside: 1 }],
  { upto: '2026-11-09', since: '2026-11-06' }));
  assert.deepStrictEqual(rows(), { FLAT: ['Gap-up', 'Y', '2026-11-09 11:00', 'Y'], 'M&M': ['Gap-up', 'Y', '2026-11-05 13:15', ''] });
  assert.strictEqual(e.sheet('Mitigated FVG Log').rows.length, 2, 'FLAT emailed once (the live catch)');
  assert.strictEqual(e.run('ab_mitMailFlush_(true)'), 1);
  assert.match(e.mails[e.mails.length - 1][0].htmlBody, /4H GAP-UP FVG \(INSIDE FVG\) \(ZERODHA, YOUR PC\)/);
});

test('mitigated email: daily zones + 4H together, at most one an hour; Unmitigated FVG approaching: no email (owner, 08-Nov-2026)', () => {
  const e = mock.loadCodeGs(zoneBook(), { props: { AB_BRIDGE_TOKEN: TOKEN }, now: Date.UTC(2026, 10, 9, 4, 0) });   // Mon 09:30 IST
  e.run('ab_logMitigation_("Unmitigated FVG", "FLAT", 99, 100.5, 1.5, 100.2, "Live")');
  e.run('ab_logMitigation_("Gap-up FVG", "M&M", 2900, 3000, 3.4, 2998, "Live")');
  e.run('ab_logMitigation_("4H FVG", "PARAGMILK", 229.9, 238, 3.52, 237, "Live")');
  e.run('ab_logMitigation_("Unmitigated FVG", "FLAT", 99, 100.5, 1.5, 99.9, "EOD")');      // the same zone again: listed once
  assert.strictEqual(e.run('ab_mitMailFlush_(false)'), 3);
  const m = e.mails[e.mails.length - 1][0];
  assert.match(m.subject, /^Mitigated FVG - 3: FLAT, M&M, PARAGMILK \(09-Nov-2026 09:30\)$/);
  const at = (txt) => m.htmlBody.indexOf(txt);
  assert.ok(at('UNMITIGATED FVG') < at('GAP-UP FVG') && at('GAP-UP FVG') < at('4H FVG'), 'grouped: daily FVG, Gap-up, 4H');
  e.setNow(Date.UTC(2026, 10, 9, 4, 30));
  e.run('ab_logMitigation_("Gap-up FVG", "FLAT", 90, 93, 3.3, 92, "Live")');
  const n = e.mails.length;
  assert.strictEqual(e.run('ab_sendZoneMitigatedAlerts_([{ symbol: "FLAT" }])'), undefined);
  assert.strictEqual(e.mails.length, n, 'within the hour: waits');
  e.run('ab_sendZoneMitigatedAlerts_([{ symbol: "FLAT" }], true)');
  assert.strictEqual(e.mails.length, n + 1, 'the menu sends at once');
  // Unmitigated FVG approaching: logged, not emailed; Gap-up approaching still emailed
  const before = e.mails.length;
  e.run('ab_sendZoneAlerts_([{ symbol: "FLAT", label: "Unmitigated FVG", price: 101, bottom: 99, top: 100.5, pct: 1.5, distancePct: 0.5, chartUrl: "", screenerUrl: "" }])');
  assert.strictEqual(e.mails.length, before);
  e.run('ab_sendZoneAlerts_([{ symbol: "FLAT", label: "Unmitigated FVG", price: 101, bottom: 99, top: 100.5, pct: 1.5, distancePct: 0.5, chartUrl: "", screenerUrl: "" }], true)');
  assert.strictEqual(e.mails.length, before + 1, 'the menu\'s Check Approaches Now still emails');
  e.run('ab_sendZoneAlerts_([{ symbol: "M&M", label: "Gap-up FVG", price: 3001, bottom: 2900, top: 3000, pct: 3.4, distancePct: 0.03, chartUrl: "", screenerUrl: "" }])');
  assert.strictEqual(e.mails.length, before + 2, 'Gap-up FVG approaching emails go on');
});

test('the FVG+Spring backtest tabs from the PC (owner, 09-Nov-2026: the 30-day move, 1R - 5R, the highest R)', () => {
  const e = env();
  const rows = [
    { tf: '4H', group: 'FVG+Spring', signals: 40, open: 1, avgUp: 6.25, medUp: 4.1, hits: [55, 47.5, 40, 25, 10], stopped: 52.5, avgR: 1.9, medR: 1.2,
      from: '2021-05-12 13:15', to: '2026-11-06 13:15' },
    { tf: 'D', group: 'Gap-up FVG + Spring - inside FVG', signals: 0, open: 0, avgUp: null, medUp: null, hits: [null, null, null, null, null],
      stopped: null, avgR: null, medR: null, from: '', to: '' },
    { tf: 'X', group: 'nope', hits: [] }];
  const trades = [{ sym: 'PARAGMILK', tf: '4H', candle: '2026-09-30 13:15', zone: 'FVG', where: 'bottom', touch: 3, inside: false, result: '3R', up: 9.4, maxR: 3.4 },
    { sym: 'FLAT', tf: 'W', candle: '2026-09-07', zone: 'Gap-up', where: 'top', touch: 1, inside: true, result: 'stopped', up: 1.2, maxR: 0.3 },
    { sym: 'M&M', tf: 'D', candle: '2026-11-02', zone: 'Gap-up', where: 'middle', touch: 2, inside: false, result: 'open', up: null, maxR: null },
    { sym: 'bad sym!', tf: 'D', candle: '2026-01-01', result: '2R' }];
  assert.deepStrictEqual(e.post({ token: TOKEN, action: 'intraday', op: 'backtest', upto: '2026-11-06', rows: rows, trades: trades, days: 30,
    targets: [1, 1.5, 2, 3, 5], total: 9120 }), { ok: true, rows: 2, trades: 3 });
  const b = e.sheet('Spring Backtest').rows;
  assert.match(b[0][0], /^FVG\+Spring \/ Gap-up FVG \+ Spring backtest on Zerodha Kite candles .* In the 30 days after each signal: Up % = the highest price/);
  assert.deepStrictEqual(b[1], ['Timeframe', 'Group', 'Signals', 'Avg Up % (30d)', 'Median Up % (30d)', 'Hit 1R %', 'Hit 1.5R %', 'Hit 2R %',
    'Hit 3R %', 'Hit 5R %', 'Stopped %', 'Avg Max R', 'Median Max R', 'Still open', 'From', 'To']);
  assert.deepStrictEqual(b[2], ['4H', 'FVG+Spring', 40, 6.25, 4.1, 55, 47.5, 40, 25, 10, 52.5, 1.9, 1.2, 1, '2021-05-12 13:15', '2026-11-06 13:15']);
  assert.deepStrictEqual(b[3].slice(0, 8), ['D', 'Gap-up FVG + Spring - inside FVG', 0, '', '', '', '', '']);
  const t = e.sheet('Spring Backtest Trades').rows;
  assert.match(t[0][0], /\(3 of 9120;/);
  assert.deepStrictEqual(t[1].slice(0, 10), ['Candle', 'Symbol', 'Company', 'Timeframe', 'Zone', 'Where', 'Touch', 'Up % (30d)', 'Max R', 'Result']);
  assert.deepStrictEqual(t[2].slice(0, 10), ['2026-09-30 13:15', 'PARAGMILK', 'Parag Milk Foods Ltd.', '4H', 'FVG', 'Bottom', 3, 9.4, 3.4, '3R reached']);
  assert.deepStrictEqual(t[3].slice(4, 10), ['Gap-up inside FVG', 'Top', 1, 1.2, 0.3, 'Stopped']);
  assert.deepStrictEqual(t[4].slice(7, 10), ['', '', 'Open']);
  assert.strictEqual(e.post({ token: TOKEN, action: 'intraday', op: 'backtest' }).ok, false);
  // a PC with the earlier version (2R rows): refused with a hint, the tab is left as it is
  const old = e.post({ token: TOKEN, action: 'intraday', op: 'backtest', rows: [{ tf: '4H', group: 'FVG+Spring', signals: 1, winRate: 50 }], trades: [] });
  assert.match(old.error, /older backtest from the PC/);
  assert.strictEqual(e.sheet('Spring Backtest').rows[2][3], 6.25);
});

test('site feed part "intraday": the allowed columns only (no prices), newest 10 sessions = export_xlsx.py', () => {
  const e = env();
  const items = [];
  for (let k = 0; k < 13; k++) {
    const day = '2026-10-' + String(10 + k).padStart(2, '0');
    items.push({ sym: 'FLAT', tf: '1H', pattern: 'Spring', candle: day + ' 10:15', session: day, low: 10, close: 11 });
  }
  items.push(PARA);
  e.post(put(items));
  const data = JSON.parse(JSON.stringify(e.run('(function () { const ss = SpreadsheetApp.getActiveSpreadsheet();' +
    ' return ab_site_main_({ ss: ss, tz: AB_TZ, tabs: {}, dates: {} }, "2026-11-06 19:00"); })()')));
  const it = data.intraday;
  assert.deepStrictEqual(it.cols, ['Session', 'Symbol', 'Company', 'Timeframe', 'Pattern', 'Candle', 'FVG Formed', 'FVG Detail']);
  assert.match(it.note, /^Spring, Spring in FVG and Gap-up FVG \+ Spring from Zerodha Kite/);
  const days = [...new Set(it.rows.map((r) => r[0]))];
  assert.strictEqual(days.length, 10);
  assert.deepStrictEqual([days[0], days[9]], ['2026-10-30', '2026-10-14'], 'the newest 10 sessions');
  assert.deepStrictEqual(it.rows.find((r) => r[1] === 'PARAGMILK'), ['2026-10-30', 'PARAGMILK', 'Parag Milk Foods Ltd.', '4H', 'Spring in FVG', '2026-10-30 13:15', '2026-08-24 09:15', null]);
  assert.ok(!JSON.stringify(it).includes('228.05') && !JSON.stringify(it).includes('tradingview'), 'no Kite prices, no chart formula');
  assert.strictEqual(e.run('AB_SITE_FEED_FORMAT'), 13);

  // tools/export_xlsx.py intraday_patterns() on the same tab gives the same JSON
  const py = ['python3', 'python'].find((p) => spawnSync(p, ['-c', 'import openpyxl']).status === 0);
  if (!py) return;
  const tab = e.sheet('Intraday Patterns').rows.map((r) => r.map((v) => (typeof v === 'string' && v.startsWith('=HYPERLINK') ? '4H chart' : v === '' ? null : v)));
  const code = ['import importlib.util, json, sys', 'spec = importlib.util.spec_from_file_location("ex", sys.argv[1])',
    'ex = importlib.util.module_from_spec(spec); spec.loader.exec_module(ex)',
    'print(json.dumps(ex.intraday_patterns(ex.Rows(json.load(sys.stdin)))))'].join('\n');
  const r = spawnSync(py, ['-c', code, path.join(__dirname, '..', 'tools', 'export_xlsx.py')], { input: JSON.stringify(tab), encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), it);
});

test('site feed parts zones4h + springBacktest: no Kite prices, = export_xlsx.py', () => {
  const e = mock.loadCodeGs(zoneBook(), { props: { AB_BRIDGE_TOKEN: TOKEN }, now: NOW });
  e.post(zput([{ sym: 'PARAGMILK', tf: '4H', zone: [229.9, 238, '2026-10-20 13:15', 'FVG'] }, { sym: 'M&M', tf: '4H', zone: [2950, 3040, '2026-11-03 09:15', 'Gap-up'] }]));
  e.post({ token: TOKEN, action: 'intraday', op: 'backtest', upto: '2026-11-06', days: 30, targets: [1, 1.5, 2, 3, 5], total: 1,
    rows: [{ tf: '4H', group: 'FVG+Spring', signals: 1, open: 0, avgUp: 9.4, medUp: 9.4, hits: [100, 100, 100, 100, 0], stopped: 100, avgR: 3.4, medR: 3.4,
      from: '2026-09-30 13:15', to: '2026-09-30 13:15' }],
    trades: [{ sym: 'PARAGMILK', tf: '4H', candle: '2026-09-30 13:15', zone: 'FVG', where: 'bottom', touch: 3, inside: false, result: '3R', up: 9.4, maxR: 3.4 }] });
  e.run('ab_logMitigation_("Gap-up FVG", "M&M", 2900, 3000, 3.4, 2998, "Live")');
  e.run('ab_logMitigation_("4H FVG", "PARAGMILK", 229.9, 238, 3.52, 237, "Live")');
  const data = JSON.parse(JSON.stringify(e.run('(function () { const ss = SpreadsheetApp.getActiveSpreadsheet();' +
    ' return ab_site_main_({ ss: ss, tz: AB_TZ, tabs: {}, dates: {} }, "2026-11-06 19:00"); })()')));
  assert.deepStrictEqual(data.zones4h.cols, ['Symbol', 'Company', 'Kind', 'Zone %', 'Formed', 'Distance %', 'Mitigated Alerted', 'Inside FVG']);
  assert.deepStrictEqual(data.zones4h.rows[1], ['PARAGMILK', 'Parag Milk Foods Ltd.', 'FVG', 3.52, '2026-10-20 13:15', 0.84, null, null]);
  assert.deepStrictEqual(data.springBacktest.summary.rows[0], ['4H', 'FVG+Spring', 1, 9.4, 9.4, 100, 100, 100, 100, 0, 100, 3.4, 3.4, 0,
    '2026-09-30 13:15', '2026-09-30 13:15']);
  assert.deepStrictEqual(data.springBacktest.list.rows[0], ['2026-09-30 13:15', 'PARAGMILK', 'Parag Milk Foods Ltd.', '4H', 'FVG', 'Bottom', 3, 9.4, 3.4, '3R reached']);
  assert.deepStrictEqual(data.mitigatedLog.rows.map((r) => r[2] + ' ' + r[3]), ['Gap-up FVG M&M'], 'the 4H rows (Kite prices) stay on the sheet');
  const txt = JSON.stringify([data.zones4h, data.springBacktest, data.mitigatedLog]);
  // the Vercel api/site.js guard (08-Nov-2026: a "trades" key blocked the whole live feed)
  const site = require('../api/site.js');
  assert.deepStrictEqual(site.PERSONAL_MARKERS.filter((re) => re.test(JSON.stringify(data))).map(String), [], 'no personal-data marker in the main part');
  assert.ok(!/229\.9|238|2950|3040|tradingview/.test(txt), 'no zone prices, no chart formula');

  const py = ['python3', 'python'].find((p) => spawnSync(p, ['-c', 'import openpyxl']).status === 0);
  if (!py) return;
  const tab = (name) => e.sheet(name).rows.map((r) => r.map((v) => (typeof v === 'string' && v.startsWith('=HYPERLINK') ? '4H chart' : v === '' ? null : v)));
  const code = ['import importlib.util, json, sys', 'spec = importlib.util.spec_from_file_location("ex", sys.argv[1])',
    'ex = importlib.util.module_from_spec(spec); spec.loader.exec_module(ex)', 'd = json.load(sys.stdin)',
    'print(json.dumps({"z": ex.zones_4h(ex.Rows(d["z"])), "b": ex.spring_backtest(ex.Rows(d["b"]), ex.Rows(d["t"])),',
    '                  "m": ex.no_kite(ex.table(ex.Rows(d["m"]), "Date", stop_blank=False))}))'].join('\n');
  const r = spawnSync(py, ['-c', code, path.join(__dirname, '..', 'tools', 'export_xlsx.py')],
    { input: JSON.stringify({ z: tab('4H FVG Zones'), b: tab('Spring Backtest'), t: tab('Spring Backtest Trades'), m: tab('Mitigated FVG Log') }), encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepStrictEqual(out.z, data.zones4h);
  assert.deepStrictEqual(out.b, data.springBacktest);
  assert.deepStrictEqual(out.m.rows.map((r) => r[3]), data.mitigatedLog.rows.map((r) => r[3]));
});

test('Kite live prices (owner, 08-Nov-2026): only the "Kite Live" tab, biggest gainers first, Main untouched', () => {
  const e = mock.loadCodeGs(zoneBook(), { props: { AB_BRIDGE_TOKEN: TOKEN }, now: Date.UTC(2026, 10, 8, 12, 35) });
  const mainBefore = JSON.stringify(e.sheet('Main').rows);
  const r = e.post({ token: TOKEN, action: 'kitelive', at: '2026-11-08 18:05:00', items: [
    ['PARAGMILK', 241.5, 236, 243, 235.1, 233], ['FLAT', 99, 100, 100.5, 98.8, 100], ['M&M', 3060, 3050, 3070, 3040, 3060],
    ['bad sym!', 1, 1, 1, 1, 1], ['FLAT', 98, 1, 1, 1, 1], ['ZERO', 0, 1, 1, 1, 1]] });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { ok: true, received: 6, written: 3, skipped: 3, up: 1, down: 1, at: '2026-11-08 18:05:00', indices: 0 });
  const t = e.sheet('Kite Live').rows;
  assert.match(t[0][0], /^Kite live prices \(Zerodha, from your PC - LiveNow\.bat\), updated 2026-11-08 18:05:00 IST: 3 stocks, 1 up \/ 1 down\./);
  assert.deepStrictEqual(t[1], ['Symbol', 'Company', 'Kite LTP', 'Change %', 'Prev Close', 'Open', 'High', 'Low', 'Sheet Price (GOOGLEFINANCE)', 'Kite vs Sheet %']);
  assert.deepStrictEqual(t.slice(2).map((x) => [x[0], x[1], x[2], x[3], x[8], x[9]]), [
    ['PARAGMILK', 'Parag Milk Foods Ltd.', 241.5, 3.65, 240, 0.63],
    ['M&M', 'Mahindra & Mahindra', 3060, 0, 3050, 0.33],
    ['FLAT', 'Flat Co', 99, -1, 101, -1.98]]);
  assert.strictEqual(JSON.stringify(e.sheet('Main').rows), mainBefore, 'Main (GOOGLEFINANCE MKT Price) not touched');
  // the next minute replaces the rows (fewer stocks: the old ones go)
  e.post({ token: TOKEN, action: 'kitelive', at: '2026-11-08 18:06:00', items: [['FLAT', 100.5, 100, 100.6, 98.8, 100]] });
  assert.deepStrictEqual(e.sheet('Kite Live').rows.slice(2).filter((x) => x[0]).map((x) => x[0] + ' ' + x[3]), ['FLAT 0.5']);
  assert.strictEqual(e.post({ token: TOKEN, action: 'kitelive' }).ok, false);
  assert.strictEqual(e.post({ token: 'bad', action: 'kitelive', items: [] }).error, 'bad token');
});

test('Kite indices (owner, 08-Nov-2026): the PC gets the Indextracker symbols, posts their quotes; kept for the owner\'s website view', () => {
  const book = zoneBook();
  book.sheets.push({ name: 'Indextracker', rows: [['NSE Symbol', 'Drop from all time high', 'Current Price'], ['NIFTY_50', -1, 25000], ['nifty_bank', -2, 55000],
    ['', '', ''], ['NIFTY_50', -1, 25000], ['bad sym', 0, 0]] });
  const e = mock.loadCodeGs(book, { props: { AB_BRIDGE_TOKEN: TOKEN }, now: Date.UTC(2026, 10, 8, 12, 35) });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(e.post({ token: TOKEN, action: 'intraday', op: 'syms' }).indices)), ['NIFTY_50', 'NIFTY_BANK']);
  const r = e.post({ token: TOKEN, action: 'kitelive', at: '2026-11-08 18:05:00', items: [['FLAT', 99, 100, 100.5, 98.8, 100]],
    indices: [['NIFTY_50', 25030.35, 24950, 25060, 24940, 24930.6], ['NIFTY_BANK', 55500, 55400, 55600, 55300, 55600], ['bad sym', 1, 1, 1, 1, 1], ['NIFTY_IT', 0, 1, 1, 1, 1]] });
  assert.strictEqual(r.indices, 2);
  assert.match(e.sheet('Kite Live').rows[0][0], /1 up \/ 0 down|0 up \/ 1 down/);
  assert.match(e.sheet('Kite Live').rows[0][0], /; NIFTY 50 25030\.35 \(\+0\.4%\); 2 indices for your website view\./);
  const site = JSON.parse(JSON.stringify(e.run('ab_klForSite_()')));
  assert.deepStrictEqual(site.indices, [['NIFTY_50', 25030.35, 0.4, 25060, 24940], ['NIFTY_BANK', 55500, -0.18, 55600, 55300]]);
  // a post without indices (an older PC program) clears them; stale = none
  e.post({ token: TOKEN, action: 'kitelive', at: '2026-11-08 18:06:00', items: [['FLAT', 99, 100, 100.5, 98.8, 100]] });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(e.run('ab_klForSite_()'))).indices, []);
  e.post({ token: TOKEN, action: 'kitelive', at: '2026-11-08 18:07:00', items: [['FLAT', 99, 100, 100.5, 98.8, 100]], indices: [['NIFTY_50', 25000, 1, 1, 1, 24900]] });
  e.setNow(Date.UTC(2026, 10, 8, 12, 40));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(e.run('ab_klForSite_()'))).indices, [['NIFTY_50', 25000, 0.4, 1, 1]], 'Sunday (no regular session): today\'s last prices stay');
  e.setNow(Date.UTC(2026, 10, 8, 19, 0));               // Mon 00:30 IST
  assert.deepStrictEqual(JSON.parse(JSON.stringify(e.run('ab_klForSite_()'))).indices, [], 'the next day: nothing');
});

test('alerts use Kite\'s live price while the laptop sends it (fresh <= 3 min), else GOOGLEFINANCE (owner, 08-Nov-2026)', () => {
  const e = mock.loadCodeGs(zoneBook(), { props: { AB_BRIDGE_TOKEN: TOKEN }, now: NOW });
  e.post(zput([{ sym: 'M&M', tf: '4H', zone: [2950, 3040, '2026-11-03 09:15', 'Gap-up'] }, { sym: 'FLAT', tf: '4H', zone: [90, 100.2, '2026-10-01 13:15', 'FVG'] }]));
  // Mon 09-Nov 11:00 IST: GOOGLEFINANCE (Main) says M&M 3050 / FLAT 101 - above both tops; Kite says M&M 3035 (under 3040)
  e.setNow(Date.UTC(2026, 10, 9, 5, 30));
  assert.strictEqual(e.run('ab_kiteLivePrices_()'), null, 'no Kite prices yet');
  e.post({ token: TOKEN, action: 'kitelive', at: '2026-11-09 11:00:00', items: [['M&M', 3035, 3050, 3060, 3030, 3040], ['FLAT', 101.5, 100, 102, 99.5, 100]] });
  assert.strictEqual(e.run('ab_kiteLivePrices_()["M&M"]'), 3035);
  assert.deepStrictEqual(JSON.parse(e.run('JSON.stringify(ab_itdZoneCheck_().map(function (r) { return r.sym; }))')), ['M&M']);
  const log = e.sheet('Mitigated FVG Log').rows;
  assert.strictEqual(log[log.length - 1][7], '3035 (Live, Kite)');
  // 4 minutes later without a new post (laptop off): stale -> Main's GOOGLEFINANCE price
  e.setNow(Date.UTC(2026, 10, 9, 5, 34));
  assert.strictEqual(e.run('ab_kiteLivePrices_()'), null);
  e.sheet('Main').rows[4][3] = 100;                  // FLAT on GOOGLEFINANCE now 100 (under its top 100.2)
  assert.deepStrictEqual(JSON.parse(e.run('JSON.stringify(ab_itdZoneCheck_().map(function (r) { return r.sym; }))')), ['FLAT']);
  const log2 = e.sheet('Mitigated FVG Log').rows;
  assert.strictEqual(log2[log2.length - 1][7], '100 (Live)');
  // ab_kiteLiveOverlay_: Kite wins for the symbols it has, the rest keep their sheet price
  e.setNow(Date.UTC(2026, 10, 9, 5, 35));
  e.post({ token: TOKEN, action: 'kitelive', at: '2026-11-09 11:05:00', items: [['FLAT', 99, 100, 102, 98.5, 100]] });
  assert.deepStrictEqual(JSON.parse(e.run('(function () { const p = { FLAT: 101, PARAGMILK: 240 }; const u = ab_kiteLiveOverlay_(p); return JSON.stringify([p, u]); })()')),
    [{ FLAT: 99, PARAGMILK: 240 }, { FLAT: true }]);
});
