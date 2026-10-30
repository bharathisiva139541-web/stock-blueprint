'use strict';
// Results announcement times (owner, 30-Oct-2026: BOROLTD filed its results at 17:05 on 29-Oct, after the
// close, and reacted on 30-Oct). The PC posts NSE's result filings (doPost action 'results_ann'); the sheet
// keeps the earliest per stock per day for Main / PatternData stocks, fills the Results Tracker column
// 'Announced', puts the reaction day of Results Performance on the session after an after-market filing,
// and emails the results filed since the last close when the PC runs before 09:15 on a weekday.
const test = require('node:test');
const assert = require('node:assert');
const mock = require('./fixtures/apps-script-mock.js');

const TOKEN = 'bridge-token-0123456789';
const MORNING = Date.UTC(2026, 9, 30, 3, 20);         // Fri 30-Oct-2026 08:50 IST
const EVENING = Date.UTC(2026, 9, 30, 13, 0);         // Fri 30-Oct-2026 18:30 IST
const ist = (iso) => new Date(Date.parse(iso + 'T00:00:00+05:30'));
const HEAD = ['Checkbox', 'StockName', 'SYMBOL', 'Result Date', 'MKT Price', '% Change', 'QoQ Revenue Growth %', 'QoQ NP Growth %',
  'YoY Revenue Growth %', 'YoY NP Growth %', 'OPM YoY%', 'OPM QoQ%', 'TTM Signal', 'Price Fall Alert Price', 'Breakout Alert Price', 'Triggered Y/N'];
const OLD_TRACKER_HEAD = ['Symbol', 'Company', 'Result Date', 'Quarter Expected', 'Status', 'Screener Latest Quarter', 'Checks',
  'First Checked', 'Last Checked', 'Updated At', 'Note', 'Source'];
const ANN = [['BOROLTD', '2026-10-29 17:05:25', 'Outcome of Board Meeting'], ['INFY', '2026-10-30 08:40:00', 'Financial Results'],
  ['NOTMINE', '2026-10-29 16:00:00', 'Outcome of Board Meeting'], ['TCS', '2026-10-28 13:20:11', 'Outcome of Board Meeting']];

function workbook() {
  const h30 = [['Symbol', 'Date', 'Open', 'High', 'Low', 'Close', 'Volume']];
  [['2026-10-26', 103], ['2026-10-27', 101], ['2026-10-28', 100], ['2026-10-29', 98.76], ['2026-10-30', 118.5]].forEach(([d, c]) => {
    h30.push(['BOROLTD', ist(d), c, c * 1.01, c * 0.99, c, 100000]);
  });
  return { sheets: [
    { name: 'Main', rows: [['Main watchlist'], HEAD,
      [true, 'Borosil Limited', 'BOROLTD', ist('2026-10-29'), 118.5, 19.98, 43, 146, 8, 39, 'Decreasing', 'Increasing', 'Avoid', '', '', ''],
      [false, 'Infosys', 'INFY', ist('2026-10-30'), 1500, 0.5, '', '', '', '', '', '', 'Buy', '', '', ''],
      [true, 'Tata Consultancy', 'TCS', ist('2026-10-28'), 3000, 0.1, 5, 6, 7, 8, 'Increasing', 'Increasing', 'Buy', '', '', '']] },
    { name: 'PatternData', rows: [['Date', 'x', 'y', 'Symbol'], ['', '', '', 'BOROLTD'], ['', '', '', 'INFY'], ['', '', '', 'TCS']] },
    { name: 'Results Tracker', rows: [OLD_TRACKER_HEAD,
      ['BOROLTD', 'Borosil Limited', '29/10/2026', 'Sep 2026', 'Updated', 'Sep 2026', '1', '29/10/2026 18:00', '29/10/2026 18:00', '29/10/2026 18:00', '', 'screener.in'],
      ['INFY', 'Infosys', '30/10/2026', 'Sep 2026', 'Pending', 'Jun 2026', '0', '', '', '', '', ''],
      ['TCS', 'Tata Consultancy', '28/10/2026', 'Sep 2026', 'Updated', 'Sep 2026', '1', '28/10/2026 18:00', '28/10/2026 18:00', '28/10/2026 18:00', '', 'screener.in']] },
    { name: 'History30', rows: h30 }
  ] };
}
const load = (now, props) => mock.loadCodeGs(workbook(), { props: Object.assign({ AB_BRIDGE_TOKEN: TOKEN, AB_RS_SEASON: 'Sep 2026' }, props || {}), now: now });
const post = (e, ann) => e.post({ token: TOKEN, action: 'results_ann', ann: ann });

test('sessions: before 09:15, market hours, after 15:30, weekend', () => {
  const e = load(EVENING);
  const s = (at) => e.call('ab_annSession_', at).label;
  assert.deepStrictEqual(['2026-10-30 09:14:59', '2026-10-30 09:15:00', '2026-10-30 15:29:59', '2026-10-30 15:30:00', '2026-10-31 11:00:00'].map(s),
    ['Before market', 'Market hours', 'Market hours', 'After market', 'Market closed']);
  assert.strictEqual(e.call('ab_annTime_', '29-Oct-2026 17:05'), '2026-10-29 17:05:00');
  assert.strictEqual(e.call('ab_annTime_', 'soon'), '');
});

test('the filings of Main stocks are kept (the earliest per stock per day) and fill the tracker column', () => {
  const e = load(EVENING);
  const r = post(e, ANN);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual([r.received, r.main, r.fresh, r.kept, r.tracker, r.emailed], [4, 3, 3, 3, 3, false]);
  const tab = e.sheet('Results_Announcements');
  assert.strictEqual(tab.hidden, true);
  assert.deepStrictEqual(tab.rows.slice(0, 4).map((x) => x.slice(0, 3)), [['Symbol', 'Filed (IST)', 'Session'],
    ['INFY', '2026-10-30 08:40:00', 'Before market'], ['BOROLTD', '2026-10-29 17:05:25', 'After market'], ['TCS', '2026-10-28 13:20:11', 'Market hours']]);
  // a later filing the same day does not replace it, an earlier one does
  const r2 = post(e, [['BOROLTD', '2026-10-29 18:10:00', 'Financial Result Updates'], ['TCS', '2026-10-28 10:05:00', 'Financial Results']]);
  assert.deepStrictEqual([r2.main, r2.fresh], [2, 0]);
  const rows = e.sheet('Results_Announcements').rows;
  assert.deepStrictEqual(rows.filter((x) => x[0] === 'BOROLTD').map((x) => x[1]), ['2026-10-29 17:05:25']);
  assert.deepStrictEqual(rows.filter((x) => x[0] === 'TCS').map((x) => x[1]), ['2026-10-28 10:05:00']);
  const tr = e.sheet('Results Tracker').rows;
  assert.strictEqual(tr[0][12], 'Announced');
  assert.deepStrictEqual(tr.slice(1, 4).map((x) => [x[0], x[12]]), [['BOROLTD', '29/10 17:05 After market'], ['INFY', '30/10 08:40 Before market'],
    ['TCS', '28/10 10:05 Market hours']]);
  assert.match(e.post({ token: 'wrong', action: 'results_ann', ann: [] }).error, /bad token/);
  assert.match(post(e, undefined).error, /ann missing/);
});

test('Results Performance: an after-market filing moves the reaction day to the next session', () => {
  const e = load(EVENING);
  const rp = () => {
    e.call('ab_rpRefresh_', {});
    const rows = e.sheet('Results Performance').rows;
    const h = rows[9];
    const r = rows.slice(10).find((x) => /"BOROLTD"/.test(String(x[0])));   // the table, not the 'Best: ...' line
    const o = {};
    h.forEach((k, i) => { o[k] = r[i]; });
    return o;
  };
  const before = rp();
  assert.strictEqual(before['Pre-Result Close'], 100, 'without a filing time: the close before the result date');
  assert.ok(Math.abs(before['Result Day %'] - (98.76 / 100 - 1)) < 1e-9, before['Result Day %']);
  assert.strictEqual(before['Reaction From'], 'from 2026-10-29');
  assert.strictEqual(before['Announced'], '');
  post(e, ANN);
  const after = rp();
  assert.strictEqual(after['Announced'], '29/10 17:05 After market');
  assert.strictEqual(after['Reaction From'], 'after 2026-10-29');
  assert.strictEqual(after['Pre-Result Close'], 98.76, 'filed after the close: that day\'s close is the baseline');
  assert.ok(Math.abs(after['Result Day %'] - (118.5 / 98.76 - 1)) < 1e-9, after['Result Day %']);
  assert.strictEqual(after['Result Day Close'], 118.5);
  assert.match(String(e.sheet('Results Performance').rows[1][0]), /filed after 15:30 IST: that day's close/);
});

test('before 09:15 on a weekday: one email with the results filed since the last close', () => {
  const e = load(MORNING);
  const r = post(e, ANN);
  assert.strictEqual(r.emailed, true, r.morning);
  assert.strictEqual(e.mails.length, 1);
  const m = e.mails[0][0];
  assert.strictEqual(m.subject, 'Before the open: 2 results filed after the last close (BOROLTD, INFY)');
  assert.match(m.htmlBody, /BOROLTD[\s\S]*29\/10 17:05[\s\S]*After market[\s\S]*\+43%[\s\S]*Increasing[\s\S]*Avoid/);
  assert.match(m.htmlBody, /INFY[\s\S]*30\/10 08:40[\s\S]*Before market[\s\S]*figures not in the sheet yet/);
  assert.ok(!/TCS/.test(m.htmlBody), 'TCS filed during the 28-Oct session: the market already knew');
  assert.match(m.body, /BOROLTD  29\/10 17:05 After market  Rev QoQ 43/);
  // once a day
  assert.strictEqual(post(e, ANN).emailed, false);
  assert.strictEqual(e.mails.length, 1);
  // after 09:15, on a weekend, or switched off: none
  const late = load(Date.UTC(2026, 9, 30, 3, 50));
  assert.match(post(late, ANN).morning, /after 09:15/);
  const sat = load(Date.UTC(2026, 9, 31, 3, 0));
  assert.match(post(sat, ANN).morning, /weekend/);
  const off = mock.loadCodeGs(workbook(), { props: { AB_BRIDGE_TOKEN: TOKEN }, now: MORNING });
  off.run('AB_SETTINGS_["AB_ANN_MORNING_EMAIL"] = 0');
  assert.match(post(off, ANN).morning, /off/);
  assert.deepStrictEqual([late.mails.length, sat.mails.length, off.mails.length], [0, 0, 0]);
  // Monday morning: Friday's after-close filings count
  const mon = load(Date.UTC(2026, 10, 2, 2, 30));
  const rm = post(mon, [['BOROLTD', '2026-10-30 16:10:00', 'Outcome of Board Meeting'], ['TCS', '2026-10-30 11:00:00', 'Financial Results']]);
  assert.strictEqual(rm.emailed, true, rm.morning);
  assert.match(mon.mails[0][0].subject, /1 result filed after the last close \(BOROLTD\)/);
});

test('the Results Update email shows when NSE got the results', () => {
  const e = load(EVENING);
  post(e, ANN);
  e.run(`(function () {
    var layout = ab_getMainLayout_(), rows = {};
    for (var r = layout.headerRowIdx + 1; r < layout.data.length; r++) rows[String(layout.data[r][layout.symbol])] = [r];
    ab_rsSendEmail_({ layout: layout, cols: { opmQoQ: layout.header.indexOf('OPM QoQ%'), opmYoY: layout.header.indexOf('OPM YoY%'), promoter: -1, fii: -1 },
      todayKey: '2026-10-30', reportDayKey: '2026-10-29', tracker: ab_rsReadTracker_(), rowsBySym: rows, runStartFloor: 0,
      slot: 'test', checked: 1, failed: 0, perf: {}, replaced: [] });
  })()`);
  assert.strictEqual(e.mails.length, 1);
  const html = e.mails[0][0].htmlBody;
  assert.match(html, /BOROLTD[\s\S]*29 Oct 2026[\s\S]*AFTER MKT 17:05[\s\S]*reacts next session/);
  const store = e.run(`(function () {
    var store = ab_annLoad_();
    return [ab_annCell_(ab_annFor_(store, 'BOROLTD', '2026-10-29')), ab_annCell_(ab_annFor_(store, 'BOROLTD', '2026-10-20')),
            ab_annCell_(ab_annFor_(store, 'TCS', '2026-10-27'))];
  })()`);
  assert.deepStrictEqual(Array.from(store), ['29/10 17:05 After market', '', '28/10 13:20 Market hours'], 'matched on the result date, the day before or up to a week after');
});
