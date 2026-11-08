'use strict';
// Code.gs Gap-up FVG life (owner, 08-Nov-2026: "it should not be removed. it is actually mitigated ... even wick just
// touches this zone, it would be considered mitigated and sent to mail. zone to be invalid only price after that closed
// below the zone. until then the zone should be tracked. email only once at first touch"; and "Gapup FVG area inside a
// FVG area ... is most powerful"): the GapUpFVG tab keeps a touched zone (Status Mitigated, Mitigated On, Inside FVG),
// one mitigated log row per zone (an older touch is marked quietly), no approach alert for a mitigated zone, the zone
// leaves the tab once a candle closes under its bottom; col X text; web/lib/fvg.js gives the same zones.
const test = require('node:test');
const assert = require('node:assert');
const mock = require('./fixtures/apps-script-mock.js');
const FVG = require('../web/lib/fvg.js');

const plain = (v) => JSON.parse(JSON.stringify(v));
function weekdays(n, last) {
  const out = [];
  for (let t = Date.parse(last + 'T00:00:00Z'); out.length < n; t -= 86400000) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift(d.toISOString().slice(0, 10));
  }
  return out;
}
const DAYS = weekdays(25, '2026-11-06').concat(['2026-11-09', '2026-11-10']);
const V = 100000;

// GAPA: wide candles (no 3-candle FVG) - a 4.25 % gap-up on day 15 (106 -> 110.5), a wick to 109 on day 20 = mitigated
// (long before the first scan), never closed under 106 -> still tracked. GAPB: the same, but day 22 closes at 105 under the
// bottom -> gone. GAPC / GAPD: tight candles - a 3.96 % gap-up (101 -> 105) inside the 3-candle FVG of the same candles,
// untouched; day 25 (09-Nov) wicks GAPC to 104.9, day 26 (10-Nov) takes GAPD straight through (close 96).
function series(kind, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    let c;
    if (kind === 'wide') {
      c = i < 15 ? [100, 106, 94, 100] : i === 15 ? [112, 118, 110.5, 114] : i === 20 ? [113, 117, 109, 113] : [113, 117, 111, 114];
    } else {
      c = i < 15 ? [100, 101, 99, 100] : i === 15 ? [106, 108, 105, 107] : [107, 109, 106, 108];
    }
    out.push(c);
  }
  return out;
}
const CANDLES = {
  GAPA: series('wide', 27),
  GAPB: series('wide', 27).map((c, i) => (i === 22 ? [110, 111, 104, 105] : c)),
  GAPC: series('tight', 27).map((c, i) => (i === 25 ? [107, 108, 104.9, 107] : c)),
  GAPD: series('tight', 27).map((c, i) => (i === 26 ? [100, 101, 95, 96] : c))
};
const SYMS = Object.keys(CANDLES);
function history30(upto) {
  const rows = [['Symbol', 'Date', 'Open', 'High', 'Low', 'Close', 'Volume']];
  SYMS.forEach((s) => CANDLES[s].slice(0, upto).forEach((c, i) => rows.push([s, DAYS[i]].concat(c, V))));
  return { name: 'History30', rows: rows, numFmts: rows.map((r, i) => (i ? [null, 'yyyy-mm-dd'] : [])) };
}
function book(upto, prices) {
  return { sheets: [
    { name: 'Main', rows: [['Main'], ['Checkbox', 'StockName', 'SYMBOL', 'MKT Price', 'Price Fall Alert Price', 'Breakout Alert Price', 'Triggered Y/N']]
      .concat(SYMS.map((s) => [false, 'Co ' + s, s, prices[s], '', '', ''])) },
    { name: 'PatternData', rows: [['Name', '', '', 'Symbol']].concat(SYMS.map((s) => ['Co ' + s, '', '', s])) },
    history30(upto)
  ] };
}
// History30 rewritten the way Phase 1 does it (day cells as real dates)
const setHistory = (e, upto) => e.run('(function (rows) { const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("History30");' +
  ' sh.clearContents(); rows = rows.map(function (r, i) { return i ? [r[0], Utilities.parseDate(r[1], AB_TZ, "yyyy-MM-dd")].concat(r.slice(2)) : r; });' +
  ' sh.getRange(1, 1, rows.length, 7).setValues(rows); })(' + JSON.stringify(history30(upto).rows) + ')');

test('ab_gapUpFvgs_: a touched gap-up stays (mitigated) until a close under its bottom; inside FVG; = web/lib/fvg.js', () => {
  const e = mock.loadCodeGs(book(25, {}), { now: Date.UTC(2026, 10, 6, 14, 0) });
  const z = JSON.parse(e.run('JSON.stringify({A: ab_gapUpFvgs_(ab_readHistoryCandles_().GAPA), B: ab_gapUpFvgs_(ab_readHistoryCandles_().GAPB), ' +
    'C: ab_gapUpFvgs_(ab_readHistoryCandles_().GAPC)})'));
  assert.deepStrictEqual(z.A, [{ bottom: 106, top: 110.5, pct: 4.25, formedIdx: 15, daysAgo: 9, touchIdx: 20, insideFvg: false }]);
  assert.deepStrictEqual(z.B, [], 'closed under the bottom on day 22: invalid');
  assert.deepStrictEqual(z.C, [{ bottom: 101, top: 105, pct: 3.96, formedIdx: 15, daysAgo: 9, touchIdx: -1, insideFvg: true }]);
  const tags = JSON.parse(e.run('JSON.stringify({A: ab_gapUpTags_(ab_readHistoryCandles_().GAPA), C: ab_gapUpTags_(ab_readHistoryCandles_().GAPC)})'));
  assert.deepStrictEqual(tags, { A: ['Gap-up FVG 4.25% (9d ago, mitigated)'], C: ['Gap-up FVG 3.96% (9d ago, inside FVG)'] });
  // the website's port: same zones (Control Panel 3-10 % in the mock)
  const web = (s) => FVG.gapUpFvgs(CANDLES[s].slice(0, 25).map((c, i) => ({ t: DAYS[i], o: c[0], h: c[1], l: c[2], c: c[3], v: V })), { AB_GAPUP_MAX_PCT: 10 })
    .map((g) => ({ bottom: g.bottom, top: g.top, pct: g.pct, formedIdx: g.formedIdx, daysAgo: g.daysAgo, touchIdx: g.touchIdx, insideFvg: g.insideFvg }));
  assert.deepStrictEqual(web('GAPA'), z.A);
  assert.deepStrictEqual(web('GAPB'), z.B);
  assert.deepStrictEqual(web('GAPC'), z.C);
  assert.deepStrictEqual(FVG.gapUpTags(CANDLES.GAPA.slice(0, 25).map((c, i) => ({ t: DAYS[i], o: c[0], h: c[1], l: c[2], c: c[3], v: V })), { AB_GAPUP_MAX_PCT: 10 }), tags.A);
});

test('GapUpFVG tab: Mitigated rows stay, one mitigated log row each (an older touch quietly), no approach alert, gone after a close below', () => {
  const e = mock.loadCodeGs(book(25, { GAPA: 110.8, GAPB: 112, GAPC: 105.3, GAPD: 109 }), { now: Date.UTC(2026, 10, 6, 14, 0) });   // Fri 19:30 IST
  const logRows = () => (e.sheet('Mitigated FVG Log') ? e.sheet('Mitigated FVG Log').rows.slice(1).map((r) => r[2] + ' ' + r[3] + ' ' + r[7]) : []);
  // 1) the first scan of this version: GAPA was touched on day 20 (before anything here) -> listed, mitigated, no email
  let r = plain(e.call('computeGapUpFvgs_'));
  assert.deepStrictEqual([r.gaps, r.mitigated, r.inside, r.eodMitigated.length], [3, 1, 2, 0]);
  let tab = e.sheet('GapUpFVG').rows;
  assert.deepStrictEqual(tab[0], ['Symbol', 'Gap Bottom', 'Gap Top', 'Gap %', 'Formed', 'Status', 'Alerted', 'Mitigated Alerted', 'Mitigated On', 'Inside FVG']);
  const byS = () => Object.fromEntries(e.sheet('GapUpFVG').rows.slice(1).map((x) => [x[0], [x[5], x[6], x[7], x[8] ? e.call('ab_h60Iso_', x[8]) : '', x[9]]]));
  assert.deepStrictEqual(byS(), { GAPA: ['Mitigated', '', 'Y', DAYS[20], ''], GAPC: ['Untouched', '', '', '', 'Y'], GAPD: ['Untouched', '', '', '', 'Y'] });
  assert.deepStrictEqual(logRows(), [], 'an old touch is not emailed again');
  // 2) approaching: GAPA (mitigated) is near its top too, but only the untouched GAPC fires
  const fired = plain(e.call('checkGapUpAlerts_'));
  assert.deepStrictEqual(fired.map((f) => f.symbol), ['GAPC']);
  assert.strictEqual(byS().GAPA[1], '', 'no approach mark on the mitigated zone');
  // 3) Mon 09-Nov: GAPC wicked to 104.9 (the live check missed it) -> one EOD row, typed inside FVG; the zone stays
  e.setNow(Date.UTC(2026, 10, 9, 14, 0));
  setHistory(e, 26);
  r = plain(e.call('computeGapUpFvgs_'));
  assert.deepStrictEqual(r.eodMitigated.map((m) => m.symbol + ' ' + m.label), ['GAPC Gap-up FVG (inside FVG)']);
  assert.deepStrictEqual(byS().GAPC, ['Mitigated', 'Y', 'Y', '2026-11-09', 'Y']);
  assert.deepStrictEqual(logRows(), ['Gap-up FVG (inside FVG) GAPC 104.9 (EOD)']);
  e.call('computeGapUpFvgs_');
  assert.strictEqual(logRows().length, 1, 'once only');
  // 4) Tue 10-Nov: GAPD gapped down through its zone and closed at 96 (under 101) -> gone, but its touch is still emailed once
  e.setNow(Date.UTC(2026, 10, 10, 14, 0));
  setHistory(e, 27);
  r = plain(e.call('computeGapUpFvgs_'));
  assert.deepStrictEqual(Object.keys(byS()), ['GAPA', 'GAPC']);
  assert.deepStrictEqual(logRows(), ['Gap-up FVG (inside FVG) GAPC 104.9 (EOD)', 'Gap-up FVG (inside FVG) GAPD 95 (EOD)']);
  // the hourly email lists the inside-FVG zones first
  e.run('ab_logMitigation_("Unmitigated FVG", "GAPA", 99, 100.5, 1.5, 100.2, "Live")');
  assert.strictEqual(e.run('ab_mitMailFlush_(true)'), 3);
  const m = e.mails[e.mails.length - 1][0];
  assert.ok(m.htmlBody.indexOf('GAP-UP FVG (INSIDE FVG)') < m.htmlBody.indexOf('UNMITIGATED FVG'), 'inside-FVG Gap-ups first');
});

test('the live mitigated check: a Gap-up zone inside an FVG is logged with its own type; an already-mitigated row stays quiet', () => {
  const e = mock.loadCodeGs(book(25, { GAPA: 110, GAPB: 112, GAPC: 104.8, GAPD: 109 }), { now: Date.UTC(2026, 10, 6, 14, 0) });
  e.call('computeGapUpFvgs_');
  e.setNow(Date.UTC(2026, 10, 9, 5, 0));                              // Mon 10:30 IST
  const fired = plain(e.call('checkGapUpMitigatedAlerts_'));
  assert.deepStrictEqual(fired.map((f) => f.symbol + ' ' + f.label), ['GAPC Gap-up FVG (inside FVG)'], 'GAPA (mitigated before) is not emailed again');
});
