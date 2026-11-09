'use strict';
// Results Performance rebuilt every evening (owner, 03-Nov-2026: "why result day column is blank and since results % is
// incorrect?"). VRLLOG filed its results on 02/11 at 16:25, after the close, so the 3 Nov session is the reaction day. The
// tab was last built at 08:09 on 3 Nov - before that session traded: Result day blank, Since results +0.1% (the price
// before the open) while the stock closed +6.1% - the PC was off 08:43-19:45 and nothing else rebuilt the tab. Now Phase 4
// (~7:20 PM, after Phase 1 brought the day's candles) rebuilds it, and so does the website feed trigger about every hour
// while the market is open (+ once with the closing prices), with the reaction session's price so far - never while a
// Results Day run is writing it.
const test = require('node:test');
const assert = require('node:assert');
const mock = require('./fixtures/apps-script-mock.js');

const TOKEN = 'bridge-token-0123456789';
const MORNING = Date.UTC(2026, 10, 3, 2, 39);          // Tue 03-Nov-2026 08:09 IST
const EVENING = Date.UTC(2026, 10, 3, 13, 50);         // Tue 03-Nov-2026 19:20 IST (Phase 4)
const ist = (iso) => new Date(Date.parse(iso + 'T00:00:00+05:30'));
const HEAD = ['Checkbox', 'StockName', 'SYMBOL', 'Result Date', 'MKT Price', '% Change', 'QoQ Revenue Growth %', 'QoQ NP Growth %',
  'YoY Revenue Growth %', 'YoY NP Growth %', 'OPM YoY%', 'OPM QoQ%', 'TTM Signal', 'Price Fall Alert Price', 'Breakout Alert Price', 'Triggered Y/N'];
const TRACKER_HEAD = ['Symbol', 'Company', 'Result Date', 'Quarter Expected', 'Status', 'Screener Latest Quarter', 'Checks',
  'First Checked', 'Last Checked', 'Updated At', 'Note', 'Source'];
const BASE = 278.8, CLOSE = 295.8;

function workbook() {
  const h30 = [['Symbol', 'Date', 'Open', 'High', 'Low', 'Close', 'Volume']];
  [['2026-10-29', 275], ['2026-10-30', 280.1], ['2026-11-02', BASE]].forEach(([d, c]) => h30.push(['VRLLOG', ist(d), c, c * 1.01, c * 0.99, c, 100000]));
  return { sheets: [
    { name: 'Main', rows: [['Main watchlist'], HEAD,
      [true, 'VRL Logistics Limited', 'VRLLOG', ist('2026-11-02'), 279.1, 0.11, 9, 27, 21, 106, 'Increasing', 'Increasing', 'Buy', '', '', '']] },
    { name: 'PatternData', rows: [['Date', 'x', 'y', 'Symbol'], ['', '', '', 'VRLLOG']] },
    { name: 'Results Tracker', rows: [TRACKER_HEAD,
      ['VRLLOG', 'VRL Logistics Limited', '02/11/2026', 'Sep 2026', 'Updated', 'Sep 2026', '1', '02/11/2026 18:40', '02/11/2026 18:40',
        '02/11/2026 18:40', '', 'NSE XBRL']] },
    { name: 'History30', rows: h30 }
  ] };
}

function rpRow(e) {
  const rows = e.sheet('Results Performance').rows;
  const h = rows[9];
  const r = rows.slice(10).find((x) => /"VRLLOG"/.test(String(x[0])));
  const o = {};
  h.forEach((k, i) => { o[k] = r[i]; });
  o.note = String(rows[1][0]);
  return o;
}
// the 3 Nov session: Phase 1 adds its candle to History30, Main shows the close
function evening(e) {
  e.setNow(EVENING);
  e.run(`(function () {
    var ss = SpreadsheetApp.getActiveSpreadsheet(), h = ss.getSheetByName('History30');
    h.getRange(h.getLastRow() + 1, 1, 1, 7).setValues([['VRLLOG', new Date(Date.parse('2026-11-03T00:00:00+05:30')), 280, 299, 279.5, ${CLOSE}, 250000]]);
    ss.getSheetByName('Main').getRange(3, 5, 1, 2).setValues([[${CLOSE}, 6.1]]);
    sendQualityWatchEmail_ = function () {};
    computeIpoBases_ = function () { return 0; };
    updateIpoBaseStatus_ = function () { return { approaching: [], brokeOut: [] }; };
    sendIpoBaseEmail_ = function () {};
  })()`);
}

function setup() {
  const e = mock.loadCodeGs(workbook(), { props: { AB_BRIDGE_TOKEN: TOKEN, AB_RS_SEASON: 'Sep 2026' }, now: MORNING });
  e.post({ token: TOKEN, action: 'results_ann', ann: [['VRLLOG', '2026-11-02 16:25:00', 'Outcome of Board Meeting']] });
  e.call('ab_rpRefresh_', {});                       // the 08:09 build (a PC round)
  return e;
}

test('the 08:09 build: the reaction session has not traded yet - Result day blank, Since results = the price before the open', () => {
  const e = setup();
  const m = rpRow(e);
  assert.strictEqual(m['Reaction From'], 'after 2026-11-02');
  assert.strictEqual(m['Pre-Result Close'], BASE);
  assert.strictEqual(m['Result Day %'], '');
  assert.ok(Math.abs(m['% Since Results'] - (279.1 / BASE - 1)) < 1e-9, m['% Since Results']);
  assert.strictEqual(m['Max Gain %'], '', 'a price from before the open is not a high / low after the results');
  assert.match(m.note, /last refreshed 03\/11\/2026 08:09 IST/);
});

test('Phase 4 rebuilds Results Performance with the day\'s candle: Result day and Since results filled', () => {
  const e = setup();
  evening(e);
  const note = e.call('ab_dailyPhase4Work_');
  assert.match(note, /Results Performance rebuilt \(1 rows, with today's candles\)/);
  const m = rpRow(e);
  // owner: "use intraday movement as result day % - VRL Logistics should show 14.5% instead of 6%": the day's high here
  assert.ok(Math.abs(m['Result Day %'] - (299 / BASE - 1)) < 1e-9, 'Result day = the intraday move: ' + m['Result Day %']);
  assert.strictEqual(m['Result Day Close'], CLOSE, 'where it closed stays in Result Day Close');
  assert.ok(Math.abs(m['% Since Results'] - (CLOSE / BASE - 1)) < 1e-9, 'Since results: ' + m['% Since Results']);
  assert.ok(Math.abs(m['Max Gain %'] - (299 / BASE - 1)) < 1e-9, 'Max gain from the day\'s high: ' + m['Max Gain %']);
  assert.ok(!('Result Day Move %' in m) && !('Result Day High' in m), 'no extra columns (owner: "don\'t add this columns")');
  assert.match(m.note, /last refreshed 03\/11\/2026 19:20 IST/);
  assert.strictEqual(e.props.getProperty('AB_RP_BUILDING_SINCE'), null, 'its flag is given back');
});

test('while it rebuilds, a PC results check still runs (only its own flag is held); a Results Day rebuild waits for it', () => {
  const e = setup();
  evening(e);
  e.run(`(function () { var real = ab_rpRefresh_; this.__seen = [];
    ab_rpRefresh_ = function (o) { __seen.push([!!(o && o.guarded), PropertiesService.getScriptProperties().getProperty('AB_RS_RUNNING_SINCE'),
      !!PropertiesService.getScriptProperties().getProperty('AB_RP_BUILDING_SINCE')]); return real(o); }; })()`);
  e.call('ab_dailyPhase4Work_');
  assert.strictEqual(e.run('JSON.stringify(__seen)'), '[[true,null,true]]', 'guarded build, the Results Day run flag left free');
  // a Results Day run's own rebuild while another one holds the tab: it waits (then goes on when that one died)
  e.props.setProperty('AB_RP_BUILDING_SINCE', String(e.now() - 1000));
  e.run(`(function () { var c = this.__sleeps = { n: 0 }; var U = Utilities; Utilities = new Proxy(U, { get: function (t, k) {
    if (k === 'sleep') return function () { c.n++; }; return t[k]; } }); })()`);
  e.call('ab_rpRefresh_', {});
  assert.strictEqual(e.run('__sleeps.n'), 30, 'waited for the other build (at most 90 s), then went on');
});

test('a Results Day run writing the tab at that moment: Phase 4 leaves it alone', () => {
  const e = setup();
  evening(e);
  const since = String(EVENING - 60000);
  e.props.setProperty('AB_RS_RUNNING_SINCE', since);
  const note = e.call('ab_dailyPhase4Work_');
  assert.match(note, /Results Performance: skipped \(a Results Day run was going\)/);
  assert.strictEqual(rpRow(e)['Result Day %'], '', 'not rebuilt');
  assert.strictEqual(e.props.getProperty('AB_RS_RUNNING_SINCE'), since, 'the run\'s own flag is kept');
  assert.strictEqual(e.props.getProperty('AB_RP_BUILDING_SINCE'), null);
  // a flag left by a run that died long ago does not block it
  e.props.setProperty('AB_RS_RUNNING_SINCE', String(EVENING - 20 * 60000));
  assert.match(e.call('ab_dailyPhase4Work_'), /Results Performance rebuilt/);
});

const at = (iso, hhmm) => Date.parse(iso + 'T' + hhmm.slice(0, 2) + ':' + hhmm.slice(2) + ':00+05:30');
const price = (e, p, chg) => e.run(`SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Main').getRange(3, 5, 1, 2).setValues([[${p}, ${chg}]])`);

test('market hours, the reaction session: Result day = the price so far, the close column stays empty until the candle', () => {
  const e = setup();
  e.setNow(at('2026-11-03', '1100'));
  price(e, 290, 3.9);
  assert.strictEqual(e.call('ab_rpMarketRefresh_', e.now()), true, '08:09 build is old: rebuilt');
  let m = rpRow(e);
  assert.ok(Math.abs(m['Result Day %'] - (290 / BASE - 1)) < 1e-9, 'Result day so far: ' + m['Result Day %']);
  assert.strictEqual(m['Result Day Close'], '', 'no close yet');
  assert.ok(Math.abs(m['% Since Results'] - (290 / BASE - 1)) < 1e-9);
  assert.ok(Math.abs(m['Max Gain %'] - (290 / BASE - 1)) < 1e-9, 'the price since the open counts');
  // 20 minutes later: not again (about once an hour)
  e.setNow(at('2026-11-03', '1120'));
  price(e, 292, 4.7);
  assert.strictEqual(e.call('ab_rpMarketRefresh_', e.now()), false);
  // 15:48 hourly, then 16:18 once more with the closing price although only 30 minutes passed
  e.setNow(at('2026-11-03', '1548'));
  assert.strictEqual(e.call('ab_rpMarketRefresh_', e.now()), true);
  e.setNow(at('2026-11-03', '1618'));
  price(e, CLOSE, 6.1);
  assert.strictEqual(e.call('ab_rpMarketRefresh_', e.now()), true, 'closing prices');
  m = rpRow(e);
  assert.ok(Math.abs(m['Result Day %'] - (CLOSE / BASE - 1)) < 1e-9, 'the highest price seen today (the close here): ' + m['Result Day %']);
  assert.match(m.note, /last refreshed 03\/11\/2026 16:18 IST/);
  e.setNow(at('2026-11-03', '1628'));
  assert.strictEqual(e.call('ab_rpMarketRefresh_', e.now()), false, 'the close build is done');
  // the evening candle makes it final
  evening(e);
  e.call('ab_dailyPhase4Work_');
  m = rpRow(e);
  assert.strictEqual(m['Result Day Close'], CLOSE);
  assert.ok(Math.abs(m['Result Day %'] - (299 / BASE - 1)) < 1e-9, 'the candle\'s high once it is in');
});

test('Result Day %: a fall that went further than the rise is shown as the fall', () => {
  const e = setup();
  evening(e);
  e.run(`(function () { var h = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('History30');
    h.getRange(h.getLastRow(), 3, 1, 4).setValues([[276, 281, 250.9, 268]]); })()`);
  e.call('ab_dailyPhase4Work_');
  const m = rpRow(e);
  assert.ok(Math.abs(m['Result Day %'] - (250.9 / BASE - 1)) < 1e-9, 'low -10% beats high +0.8%: ' + m['Result Day %']);
  assert.strictEqual(m['Result Day Close'], 268);
});

test('Result Day %: a reaction session older than the history kept keeps the value on the tab', () => {
  const e = setup();
  evening(e);
  e.call('ab_dailyPhase4Work_');
  // weeks later its candle is no longer in History30 / History60
  e.setNow(at('2026-12-10', '1900'));
  e.run(`(function () { var h = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('History30');
    h.getRange(5, 1, 1, 7).setValues([['', '', '', '', '', '', '']]); })()`);
  e.call('ab_rpRefresh_', {});
  const m = rpRow(e);
  assert.ok(Math.abs(m['Result Day %'] - (299 / BASE - 1)) < 1e-9, 'kept: ' + m['Result Day %']);
});

test('the next session: Next day = the price so far vs the reaction day\'s close', () => {
  const e = setup();
  evening(e);
  e.call('ab_dailyPhase4Work_');
  e.setNow(at('2026-11-04', '1130'));
  price(e, 301.7, 2.0);
  assert.strictEqual(e.call('ab_rpMarketRefresh_', e.now()), true);
  const m = rpRow(e);
  assert.ok(Math.abs(m['Next Day %'] - (301.7 / CLOSE - 1)) < 1e-9, 'Next day so far: ' + m['Next Day %']);
  assert.strictEqual(m['Next Day Close'], '');
  assert.ok(Math.abs(m['Result Day %'] - (299 / BASE - 1)) < 1e-9, 'Result day from the candle (its high)');
});

test('no market-hours rebuild before 09:35, after 16:30, at weekends or on an NSE holiday', () => {
  const e = setup();
  [at('2026-11-03', '0920'), at('2026-11-03', '1645'), at('2026-11-07', '1100')].forEach((t) => {
    e.setNow(t);
    assert.strictEqual(e.call('ab_rpMarketRefresh_', e.now()), false, new Date(t).toISOString());
  });
  e.props.setProperty('AB_NSE_HOLIDAYS', JSON.stringify(['2026-11-10']));
  e.setNow(at('2026-11-10', '1100'));
  assert.strictEqual(e.call('ab_rpMarketRefresh_', e.now()), false, 'holiday');
  e.setNow(at('2026-11-09', '1100'));
  assert.strictEqual(e.call('ab_rpMarketRefresh_', e.now()), true, 'a normal Monday');
});

test('the website feed trigger rebuilds the tab in market hours and then sends the main part', () => {
  const e = setup();
  e.setNow(at('2026-11-03', '1048'));
  e.run(`ab_siteFeedDue_ = function () { return false; }; ab_siteBuildRunning_ = function () { return false; };
    ab_siteBuild_ = function (due) { this.__built = due.slice(); };`);
  e.call('ab_siteFeedTrigger_', {});
  assert.strictEqual(e.run('JSON.stringify(__built)'), '["main"]');
  assert.match(rpRow(e).note, /last refreshed 03\/11\/2026 10:48 IST/);
  e.run('__built = null');
  e.setNow(at('2026-11-03', '1118'));
  e.call('ab_siteFeedTrigger_', {});
  assert.strictEqual(e.run('__built'), null, 'nothing due, nothing rebuilt');
});

// owner, 09-Nov-2026: "in results performance table, daily % column is not reflecting true value". FINCABLES filed on
// Saturday 07-Nov (13:50, market closed); the first session after it was the Sunday Muhurat session of 08-Nov, whose
// candle only History60 has (NSE via the PC - GOOGLEFINANCE gives no weekend candle). Daily % was Monday's price vs
// Friday's close (+13 %, two sessions together); now the reaction session is Sunday: Result Day Close = its close, Next
// Day = Monday.
function muhuratBook() {
  const F = 1090.6, SUN = 1308.9, MON = 1232.4;
  const h30 = [['Symbol', 'Date', 'Open', 'High', 'Low', 'Close', 'Volume']];
  [['2026-11-04', 1080], ['2026-11-05', 1085], ['2026-11-06', F]].forEach(([d, c]) => h30.push(['FINCABLES', ist(d), c, c + 5, c - 5, c, 100000]));
  const days = ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-08'];
  const cells = { '2026-11-04': '1080 1085 1075 1080 100000 1075', '2026-11-05': '1085 1090 1080 1085 100000 1080',
    '2026-11-06': '1090.6 1095.6 1085.6 1090.6 100000 1085', '2026-11-08': '1300 1324 1290 1308.9 90000 1090.6' };
  const desc = days.slice().reverse();
  const h60 = [['note'], ['Symbol'].concat(desc), ['(linked)'].concat(desc.map((d, i) => (i < desc.length - 1 ? 'Y' : '')))];
  h60.push(['FINCABLES'].concat(desc.map((d) => cells[d])));
  return { F: F, SUN: SUN, MON: MON, book: { sheets: [
    { name: 'Main', rows: [['Main watchlist'], HEAD,
      [true, 'Finolex Cables Ltd.', 'FINCABLES', ist('2026-11-07'), MON, -5.85, 13, 20, 15, 25, 'Stagnant', 'Increasing', 'Buy', '', '', '']] },
    { name: 'PatternData', rows: [['Date', 'x', 'y', 'Symbol'], ['', '', '', 'FINCABLES']] },
    { name: 'Results Tracker', rows: [TRACKER_HEAD,
      ['FINCABLES', 'Finolex Cables Ltd.', '07/11/2026', 'Sep 2026', 'Updated', 'Sep 2026', '1', '07/11/2026 14:10', '07/11/2026 14:10',
        '07/11/2026 14:10', '', 'NSE XBRL']] },
    { name: 'History30', rows: h30 },
    { name: 'History60', rows: h60 }
  ] } };
}
function rpOf(e, sym) {
  const rows = e.sheet('Results Performance').rows;
  const h = rows[9];
  const r = rows.slice(10).find((x) => new RegExp('"' + sym + '"').test(String(x[0])));
  const o = {};
  h.forEach((k, i) => { o[k] = r[i]; });
  return o;
}

test('a Saturday filing reacts on the Sunday Muhurat session (its candle from History60): Daily % = Sunday\'s close vs Friday\'s', () => {
  const m0 = muhuratBook();
  const e = mock.loadCodeGs(m0.book, { props: { AB_BRIDGE_TOKEN: TOKEN, AB_RS_SEASON: 'Sep 2026' }, now: at('2026-11-09', '1724') });
  e.post({ token: TOKEN, action: 'results_ann', ann: [['FINCABLES', '2026-11-07 13:50:00', 'Integrated Filing - Financial']] });
  e.call('ab_rpRefresh_', {});
  let m = rpOf(e, 'FINCABLES');
  assert.strictEqual(m['Pre-Result Close'], m0.F);
  assert.strictEqual(m['Result Day Close'], m0.SUN, 'the Sunday session closed at 1308.9');
  assert.ok(Math.abs(m['Result Day %'] - (1324 / m0.F - 1)) < 1e-9, 'its high: ' + m['Result Day %']);
  assert.ok(Math.abs(m['% Since Results'] - (m0.MON / m0.F - 1)) < 1e-9);
  assert.ok(Math.abs(m['Next Day %'] - (m0.MON / m0.SUN - 1)) < 1e-9, 'Monday so far vs Sunday\'s close: ' + m['Next Day %']);
  // the website's Daily %: Result Day Close vs Pre-Result Close = +20.0 %
  const R = require('../web/lib/results.js');
  assert.strictEqual(Math.round(R.dailyPct(m) * 10) / 10, 20);
  // a row stored by the earlier version (Monday taken as the reaction day) is worked out again once the Sunday candle is there
  e.run(`(function () { var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('History30');
    sh.getRange(sh.getLastRow() + 1, 1, 1, 7).setValues([['FINCABLES', new Date(Date.parse('2026-11-09T00:00:00+05:30')), 1310, 1324, 1225, ${m0.MON}, 120000]]); })()`);
  e.setNow(at('2026-11-09', '1920'));
  e.call('ab_rpRefresh_', {});
  m = rpOf(e, 'FINCABLES');
  assert.deepStrictEqual([m['Result Day Close'], m['Next Day Close']], [m0.SUN, m0.MON]);
});

test('an after-market filing of today: before the evening\'s candle the baseline is today\'s close (Main\'s price), then the candle', () => {
  const m0 = muhuratBook();
  const e = mock.loadCodeGs(m0.book, { props: { AB_BRIDGE_TOKEN: TOKEN, AB_RS_SEASON: 'Sep 2026' }, now: at('2026-11-09', '1724') });
  e.run(`(function () { var sh = SpreadsheetApp.getActiveSpreadsheet();
    sh.getSheetByName('Main').getRange(3, 4).setValue(new Date(Date.parse('2026-11-09T00:00:00+05:30')));
    sh.getSheetByName('Results Tracker').getRange(2, 3).setValue('09/11/2026'); })()`);
  e.post({ token: TOKEN, action: 'results_ann', ann: [['FINCABLES', '2026-11-09 16:53:00', 'Integrated Filing - Financial']] });
  e.call('ab_rpRefresh_', {});
  let m = rpOf(e, 'FINCABLES');
  assert.strictEqual(m['Reaction From'], 'after 2026-11-09');
  assert.strictEqual(m['Pre-Result Close'], m0.MON, 'today\'s close, not Sunday\'s / Friday\'s');
  assert.strictEqual(m['% Since Results'], 0);
  // Phase 1's candle: the same close from History30
  e.run(`(function () { var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('History30');
    sh.getRange(sh.getLastRow() + 1, 1, 1, 7).setValues([['FINCABLES', new Date(Date.parse('2026-11-09T00:00:00+05:30')), 1310, 1324, 1225, 1232.5, 120000]]); })()`);
  e.setNow(at('2026-11-09', '1920'));
  e.call('ab_rpRefresh_', {});
  m = rpOf(e, 'FINCABLES');
  assert.strictEqual(m['Pre-Result Close'], 1232.5, 'from the candle once it is in');
});
