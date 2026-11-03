'use strict';
// Results Performance rebuilt every evening (owner, 03-Nov-2026: "why result day column is blank and since results % is
// incorrect?"). VRLLOG filed its results on 02/11 at 16:25, after the close, so the 3 Nov session is the reaction day. The
// tab was last built at 08:09 on 3 Nov - before that session traded: Result day blank, Since results +0.1% (the price
// before the open) while the stock closed +6.1%. Phase 4 (~7:20 PM, after Phase 1 brought the day's candles) now rebuilds
// the tab, unless a Results Day run is writing it at that moment.
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
  assert.match(m.note, /last refreshed 03\/11\/2026 08:09 IST/);
});

test('Phase 4 rebuilds Results Performance with the day\'s candle: Result day and Since results filled', () => {
  const e = setup();
  evening(e);
  const note = e.call('ab_dailyPhase4Work_');
  assert.match(note, /Results Performance rebuilt \(1 rows, with today's candles\)/);
  const m = rpRow(e);
  assert.ok(Math.abs(m['Result Day %'] - (CLOSE / BASE - 1)) < 1e-9, 'Result day: ' + m['Result Day %']);
  assert.strictEqual(m['Result Day Close'], CLOSE);
  assert.ok(Math.abs(m['% Since Results'] - (CLOSE / BASE - 1)) < 1e-9, 'Since results: ' + m['% Since Results']);
  assert.ok(Math.abs(m['Max Gain %'] - (299 / BASE - 1)) < 1e-9, 'Max gain from the day\'s high: ' + m['Max Gain %']);
  assert.match(m.note, /last refreshed 03\/11\/2026 19:20 IST/);
  assert.strictEqual(e.props.getProperty('AB_RS_RUNNING_SINCE'), null, 'the run flag is given back');
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
  // a flag left by a run that died long ago does not block it
  e.props.setProperty('AB_RS_RUNNING_SINCE', String(EVENING - 20 * 60000));
  assert.match(e.call('ab_dailyPhase4Work_'), /Results Performance rebuilt/);
});
