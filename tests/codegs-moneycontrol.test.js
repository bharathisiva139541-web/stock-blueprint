'use strict';
// Code.gs moneycontrol "first alert + fallback": the PC bridge posts moneycontrol's quarterly
// figures (doPost action 'mcput') for Results Tracker rows still Pending; the Results Day check
// writes them (tick + Source = moneycontrol + a note on Main) only while screener.in is behind,
// and screener.in's figures replace them later without a second "updated" email.
const test = require('node:test');
const assert = require('node:assert');
const mock = require('./fixtures/apps-script-mock.js');

const TOKEN = 'bridge-token-0123456789';
const NOW = Date.UTC(2026, 9, 27, 14, 0);              // Tue 27-Oct-2026 19:30 IST
const RD = new Date(Date.UTC(2026, 9, 26, 6, 30));      // result date Mon 26-Oct-2026 (noon IST)
const HEAD = ['Checkbox', 'StockName', 'SYMBOL', 'Result Date', '% Change', 'QoQ Revenue Growth %', 'QoQ NP Growth %',
  'YoY Revenue Growth %', 'YoY NP Growth %', 'TTM EPS', 'Last FY EPS', 'Promotor Holding', 'FII Activity', 'OPM YoY%', 'OPM QoQ%',
  'Price Fall Alert Price', 'Breakout Alert Price', 'Triggered Y/N'];
const C = {};
HEAD.forEach((h, i) => { C[h] = i; });
const OLD = [5, 6, 7, 8, 40, 30, 'Stable', 'Increasing', 'Increasing', 'Decreasing'];   // last season's figures and tags
function mainRow(sym, name) { return [false, name, sym, RD, 1.2].concat(OLD); }

function workbook(extra) {
  return { sheets: [
    { name: 'Main', rows: [['Main watchlist'], HEAD, mainRow('ACUTAAS', 'Acutaas Chemicals'), mainRow('LATECO', 'Late Co'),
                           mainRow('SCRNOK', 'Screener First'), mainRow('BLOCKED', 'Blocked Co')] },
    { name: 'AutoFetch Log', rows: [['ts']] }
  ].concat(extra || []) };
}
function env(extra) {
  return mock.loadCodeGs(workbook(extra), { props: { AB_BRIDGE_TOKEN: TOKEN, AB_RS_SEASON: 'Sep 2026' }, now: NOW });
}

/** A screener.in company page with just the quarterly table (oldest -> newest). */
function screener(quarters, sales, np, eps) {
  const row = (label, a) => '<tr><td class="text">' + label + '<button>+</button></td>' + a.map((v) => '<td>' + v + '</td>').join('') + '</tr>';
  return '<section id="quarters"><p>Consolidated Figures in Rs. Crores</p><table class="data-table"><thead><tr><th></th>' +
    quarters.map((q) => '<th>' + q + '</th>').join('') + '</tr></thead><tbody>' +
    row('Sales', sales) + row('Net Profit', np) + row('EPS in Rs', eps) + '</tbody></table></section>';
}
const SQ_OLD = ['Jun 2025', 'Sep 2025', 'Dec 2025', 'Mar 2026', 'Jun 2026'];
const SQ_NEW = ['Sep 2025', 'Dec 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026'];
// ACUTAAS on moneycontrol (the user's test, Sep 2024 .. Sep 2026, consolidated)
const MC_Q = ['Sep 2024', 'Dec 2024', 'Mar 2025', 'Jun 2025', 'Sep 2025', 'Dec 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026'];
const ACUTAAS = { sym: 'ACUTAAS', basis: 'Consolidated', quarters: MC_Q, src: 'consolidated widget + results page',
  revenue: [246, 274, 308, 207, 306, 393, 432, 329, 436], netProfit: [37, 45, 62, 44, 71, 106, 134, 74, 123],
  eps: [9.38, 11.35, 7.8, 5.41, 8.82, 13.19, 16.09, 9.07, 15.29] };

function tracker(e) {
  const rows = e.sheet('Results Tracker').rows;
  const h = rows[0];
  const out = {};
  rows.slice(1).forEach((r) => { const o = {}; h.forEach((k, i) => { o[k] = r[i]; }); out[r[0]] = o; });
  return out;
}
function main(e, sym) {
  const rows = e.sheet('Main').rows;
  const r = rows.findIndex((x) => x[C.SYMBOL] === sym);
  return { row: rows[r], idx: r };
}
const figures = (e, sym) => main(e, sym).row.slice(C['QoQ Revenue Growth %'], C['OPM QoQ%'] + 1);

test('list: Pending results are also offered for moneycontrol, with the quarter expected', () => {
  const e = env();
  const r = e.post({ token: TOKEN, action: 'list' });
  assert.deepStrictEqual(r.priority, ['ACUTAAS', 'LATECO', 'SCRNOK', 'BLOCKED']);
  assert.deepStrictEqual(r.mc, { ACUTAAS: 'Sep 2026', LATECO: 'Sep 2026', SCRNOK: 'Sep 2026', BLOCKED: 'Sep 2026' });
});

test('mcput: figures checked and stored in a hidden tab; bad items refused one by one', () => {
  const e = env();
  const r = e.post({ token: TOKEN, action: 'mcput', items: [
    ACUTAAS,
    { sym: 'GAP', quarters: ['Mar 2026', 'Sep 2026'], revenue: [1, 2], netProfit: [1, 2] },
    { sym: 'BADQ', quarters: ['Q2FY27', 'Sep 2026'], revenue: [1, 2], netProfit: [1, 2] },
    { sym: 'NOLATEST', quarters: ['Jun 2026', 'Sep 2026'], revenue: [1, null], netProfit: [1, 2] },
    { sym: 'ONE', quarters: ['Sep 2026'], revenue: [1], netProfit: [1] },
    { sym: 'bad sym!', quarters: ['Jun 2026', 'Sep 2026'] }
  ] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.stored, 1);
  assert.deepStrictEqual(r.details.map((d) => [d.sym, d.ok, d.latest || d.error]), [
    ['ACUTAAS', true, 'Sep 2026'],
    ['GAP', false, 'quarters not in a row at Sep 2026'],
    ['BADQ', false, 'bad quarter "Q2FY27"'],
    ['NOLATEST', false, 'no revenue / net profit for Sep 2026'],
    ['ONE', false, 'need 2 to 16 quarters'],
    ['bad sym!', false, 'bad symbol']]);
  const tab = e.sheet('Moneycontrol_Bridge');
  assert.strictEqual(tab.hidden, true);
  assert.strictEqual(tab.rows[1][0], 'ACUTAAS');
  const d = JSON.parse(tab.rows[1][3]);
  assert.deepStrictEqual([d.basis, d.quarters[8], d.revenue[8], d.eps[0]], ['Consolidated', 'Sep 2026', 436, 9.38]);
  // a later post replaces the row, not a second one
  e.post({ token: TOKEN, action: 'mcput', items: [Object.assign({}, ACUTAAS, { basis: 'standalone' })] });
  assert.strictEqual(e.sheet('Moneycontrol_Bridge').rows.filter((x) => x[0] === 'ACUTAAS').length, 1);
  assert.strictEqual(JSON.parse(e.sheet('Moneycontrol_Bridge').rows[1][3]).basis, 'Standalone');
  assert.deepStrictEqual(e.post({ token: 'wrong', action: 'mcput', items: [ACUTAAS] }), { ok: false, error: 'bad token' });
});

test('Results Day: moneycontrol first while screener.in is behind, then screener.in replaces it quietly', () => {
  const e = env();
  // PC round 1: screener.in still on Jun 2026 for three; SCRNOK already has Sep 2026; BLOCKED not delivered
  e.post({ token: TOKEN, action: 'put', items: [
    { sym: 'ACUTAAS', html: screener(SQ_OLD, [207, 306, 393, 432, 329], [44, 71, 106, 134, 74], [5.41, 8.82, 13.19, 16.09, 9.07]) },
    { sym: 'LATECO', html: screener(SQ_OLD, [10, 11, 12, 13, 14], [1, 1, 1, 1, 1], [1, 1, 1, 1, 1]) },
    { sym: 'SCRNOK', html: screener(SQ_NEW, [100, 100, 100, 100, 120], [10, 10, 10, 10, 15], [1, 1, 1, 1, 1]) }] });
  e.post({ token: TOKEN, action: 'mcput', items: [
    ACUTAAS,
    { sym: 'LATECO', basis: 'Consolidated', quarters: ['Mar 2026', 'Jun 2026'], revenue: [13, 14], netProfit: [1, 1] },
    { sym: 'SCRNOK', basis: 'Consolidated', quarters: ['Jun 2026', 'Sep 2026'], revenue: [100, 999], netProfit: [10, 99] },
    { sym: 'BLOCKED', basis: 'Standalone', quarters: ['Jun 2025', 'Sep 2025', 'Dec 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026'],
      revenue: [50, 52, 54, 56, 58, 60], netProfit: [5, 5, 5, 5, 5, 6], eps: [null, null, null, null, null, 1] }] });
  const p1 = e.post({ token: TOKEN, action: 'process' });
  assert.strictEqual(p1.ok, true, JSON.stringify(p1));
  assert.match(p1.result.results, /moneycontrol: 2 filled first from moneycontrol, 0 replaced by screener\.in/);

  let t = tracker(e);
  assert.deepStrictEqual([t.ACUTAAS.Status, t.ACUTAAS.Source, t.ACUTAAS['Screener Latest Quarter']], ['Updated', 'moneycontrol', 'Jun 2026']);
  assert.match(t.ACUTAAS.Note, /^moneycontrol figures \(Consolidated\) - Screener still shows Jun 2026; screener\.in replaces them when it shows Sep 2026; trend tags wait for screener\.in$/);
  // the moneycontrol quarter: QoQ / YoY, TTM EPS (last 4) and last FY EPS (the 4 before) - same maths as screener.in
  assert.deepStrictEqual(figures(e, 'ACUTAAS'), [33, 66, 42, 73, 53.64, 33.38, 'Stable', 'Increasing', 'Increasing', 'Decreasing']);
  assert.strictEqual(main(e, 'ACUTAAS').row[C.Checkbox], true);
  const note = e.sheet('Main').notes[main(e, 'ACUTAAS').idx + ',' + C['QoQ Revenue Growth %']];
  assert.match(note, /^Provisional - moneycontrol figures for Sep 2026 \(Consolidated, read 27\/10\/2026 19:30\)\. screener\.in replaces them/);

  // moneycontrol is behind too: stays Pending, nothing written
  assert.deepStrictEqual([t.LATECO.Status, t.LATECO.Source], ['Pending', '']);
  assert.strictEqual(t.LATECO.Note, 'Screener still shows Jun 2026 - will retry (moneycontrol shows Jun 2026)');
  assert.deepStrictEqual(figures(e, 'LATECO').slice(0, 4), [5, 6, 7, 8]);
  assert.strictEqual(main(e, 'LATECO').row[C.Checkbox], false);

  // screener.in already has it: screener.in wins, moneycontrol's numbers are not used
  assert.deepStrictEqual([t.SCRNOK.Status, t.SCRNOK.Source], ['Updated', 'screener.in']);
  assert.deepStrictEqual(figures(e, 'SCRNOK').slice(0, 4), [20, 50, 20, 50]);

  // no screener.in page from the PC (blocked), moneycontrol has it: standalone figures, short history
  assert.deepStrictEqual([t.BLOCKED.Status, t.BLOCKED.Source], ['Updated', 'moneycontrol']);
  assert.match(t.BLOCKED.Note, /^moneycontrol figures \(Standalone\) - Could not read screener \(PC bridge: no data from the PC yet\);/);
  assert.deepStrictEqual(figures(e, 'BLOCKED').slice(0, 6), [3, 20, 15, 20, 40, 30], 'no EPS history: TTM EPS left as it was');

  // the email: moneycontrol rows are marked
  assert.strictEqual(e.mails.length, 1, JSON.stringify(p1) + e.logs.slice(-8).join('\n'));
  const html = e.mails[0][0].htmlBody;
  assert.strictEqual((html.match(/VIA MONEYCONTROL/g) || []).length, 2);
  assert.match(html, /or, first, moneycontrol/);

  // next list: the moneycontrol rows still want screener.in pages, but no more moneycontrol
  const l2 = e.post({ token: TOKEN, action: 'list' });
  assert.deepStrictEqual(l2.priority, ['ACUTAAS', 'LATECO', 'BLOCKED']);
  assert.deepStrictEqual(l2.mc, { LATECO: 'Sep 2026' });

  // PC round 2, an hour later: screener.in still behind for ACUTAAS -> stays on moneycontrol figures
  e.setNow(NOW + 3600e3);
  e.post({ token: TOKEN, action: 'put', items: [
    { sym: 'ACUTAAS', html: screener(SQ_OLD, [207, 306, 393, 432, 329], [44, 71, 106, 134, 74], [5.41, 8.82, 13.19, 16.09, 9.07]) }] });
  e.post({ token: TOKEN, action: 'process' });
  t = tracker(e);
  assert.deepStrictEqual([t.ACUTAAS.Status, t.ACUTAAS.Source, t.ACUTAAS['Updated At']], ['Updated', 'moneycontrol', '27/10/2026 19:30']);
  assert.match(t.ACUTAAS.Note, /^moneycontrol figures - Screener still shows Jun 2026; screener\.in replaces them when it shows Sep 2026$/);
  assert.strictEqual(e.mails.length, 1, 'nothing new - no email');

  // next day screener.in shows Sep 2026: its figures replace moneycontrol's, note cleared
  e.setNow(NOW + 864e5);
  e.post({ token: TOKEN, action: 'put', items: [
    { sym: 'ACUTAAS', html: screener(SQ_NEW, [306, 393, 432, 329, 440], [71, 106, 134, 74, 125], [8.82, 13.19, 16.09, 9.07, 15.5]) }] });
  const p3 = e.post({ token: TOKEN, action: 'process' });
  assert.match(p3.result.results, /0 filled first from moneycontrol, 1 replaced by screener\.in/);
  t = tracker(e);
  assert.deepStrictEqual([t.ACUTAAS.Status, t.ACUTAAS.Source, t.ACUTAAS['Updated At'], t.ACUTAAS['Screener Latest Quarter']],
    ['Updated', 'screener.in', '27/10/2026 19:30', 'Sep 2026']);
  assert.match(t.ACUTAAS.Note, /screener\.in figures replaced the moneycontrol ones on 28\/10\/2026 19:30/);
  assert.deepStrictEqual(figures(e, 'ACUTAAS').slice(0, 4), [34, 69, 44, 76]);
  assert.strictEqual(e.sheet('Main').notes[main(e, 'ACUTAAS').idx + ',' + C['QoQ Revenue Growth %']], undefined, 'note cleared');
  // ... and an email says so: the stock in its own section, with screener.in's figures
  assert.strictEqual(e.mails.length, 2, 'the replacement is emailed');
  const m3 = e.mails[1][0];
  assert.match(m3.subject, /^Results Update - 0 updated in Main, 1 now with screener\.in figures, /);
  assert.match(m3.htmlBody, /Now with screener\.in figures \(they replace the moneycontrol ones\)/);
  assert.strictEqual((m3.htmlBody.match(/SCREENER\.IN FIGURES/g) || []).length, 1);
  assert.ok(m3.htmlBody.indexOf('ACUTAAS') > 0 && !/VIA MONEYCONTROL/.test(m3.htmlBody.split('Updated in Main')[0]), 'no moneycontrol pill on it any more');
  assert.match(m3.body, /NOW WITH SCREENER\.IN FIGURES - THEY REPLACE THE MONEYCONTROL ONES \(1\)\n {2}ACUTAAS \(result /);
  assert.match(m3.body, /UPDATED IN MAIN TODAY \(0\)/);
  assert.ok(!e.post({ token: TOKEN, action: 'list' }).priority.includes('ACUTAAS'));
});

test('Control Panel AB_RS_MONEYCONTROL = 0: no moneycontrol list, no moneycontrol figures', () => {
  const e = env([{ name: 'Control Panel', rows: [['Setting', 'Value', 'Internal key'], ['moneycontrol', 0, 'AB_RS_MONEYCONTROL']] }]);
  assert.deepStrictEqual(e.post({ token: TOKEN, action: 'list' }).mc, {});
  e.post({ token: TOKEN, action: 'put', items: [
    { sym: 'ACUTAAS', html: screener(SQ_OLD, [207, 306, 393, 432, 329], [44, 71, 106, 134, 74], [5.41, 8.82, 13.19, 16.09, 9.07]) }] });
  e.post({ token: TOKEN, action: 'mcput', items: [ACUTAAS] });
  e.post({ token: TOKEN, action: 'process' });
  const t = tracker(e);
  assert.deepStrictEqual([t.ACUTAAS.Status, t.ACUTAAS.Source, t.ACUTAAS.Note], ['Pending', '', 'Screener still shows Jun 2026 - will retry']);
  assert.deepStrictEqual(figures(e, 'ACUTAAS').slice(0, 4), [5, 6, 7, 8]);
});
