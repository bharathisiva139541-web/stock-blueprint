'use strict';
// Code.gs History60: the PC bridge posts NSE's daily candles (doPost action 'hist'), the sheet keeps
// 60 trading days of the PatternData stocks in tab "History60" (a new day = one new column), and
// ab_readHistoryMerged_ puts the days before History30's window in front of History30's candles -
// split / bonus adjusted from NSE's previous close, matched to GOOGLEFINANCE at the seam - for the
// FVG scans and Results Performance. Phase 1 fills a stock GOOGLEFINANCE gave nothing for; the site
// feed part 'history60' carries the older days to the website.
const test = require('node:test');
const assert = require('node:assert');
const mock = require('./fixtures/apps-script-mock.js');

const TOKEN = 'bridge-token-0123456789';
const FEED = 'feed-token-0123456789';
const NOW = Date.UTC(2026, 9, 28, 14, 30);          // Wed 28-Oct-2026 20:00 IST
const plain = (v) => JSON.parse(JSON.stringify(v));

/** n weekdays ending on `last` ('yyyy-mm-dd'), oldest first. */
function weekdays(n, last) {
  const out = [];
  for (let t = Date.parse(last + 'T00:00:00Z'); out.length < n; t -= 86400000) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift(d.toISOString().slice(0, 10));
  }
  return out;
}
const D = weekdays(70, '2026-10-28');

function patternData(syms) {
  return { name: 'PatternData', rows: [['Name', '', '', 'Symbol']].concat(syms.map((s) => ['Co ' + s, '', '', s])) };
}
function mainTab(syms) {
  return { name: 'Main', rows: [['Main'], ['Checkbox', 'StockName', 'SYMBOL', 'Result Date', 'Price Fall Alert Price', 'Breakout Alert Price', 'Triggered Y/N']]
    .concat(syms.map((s) => [false, 'Co ' + s, s, '', '', '', ''])) };
}
/** History30 rows: { SYM: [[iso, o, h, l, c, v], ...] } (date cells become Dates, as in the sheet). */
function history30(bySym) {
  const rows = [['Symbol', 'Date', 'Open', 'High', 'Low', 'Close', 'Volume']];
  Object.keys(bySym).forEach((s) => bySym[s].forEach((c) => rows.push([s].concat(c))));
  return { name: 'History30', rows: rows, numFmts: rows.map((r, i) => (i ? [null, 'yyyy-mm-dd'] : [])) };
}
/** History60 tab as the sheet keeps it: days newest first, cells 'o h l c v p'. */
function history60(days, cells, linked) {
  const desc = days.slice().reverse();
  const rows = [['note'], ['Symbol'].concat(desc), ['(linked)'].concat(desc.map((d, i) => (linked ? linked(d) : i < desc.length - 1) ? 'Y' : ''))];
  Object.keys(cells).forEach((s) => rows.push([s].concat(desc.map((d) => cells[s][d] || ''))));
  return { name: 'History60', rows: rows };
}
const cell = (o, h, l, c, v, p) => [o, h, l, c, v, p].join(' ');
function env(sheets, extraProps) {
  return mock.loadCodeGs({ sheets: sheets }, { now: NOW, props: Object.assign({ AB_BRIDGE_TOKEN: TOKEN, AB_FEED_TOKEN: FEED }, extraProps || {}) });
}
/** A day of candles for the post: { SYM: [o, h, l, c, v, p] }. */
const flat = (px, prev, vol) => [px - 1, px + 1, px - 2, px, vol || 1000, prev === undefined ? px : prev];

test('hist: the first post writes the tab - PatternData stocks only, newest day first, linked days, a cell per candle', () => {
  const e = env([patternData(['TCS', 'SONA']), mainTab(['TCS', 'SONA'])]);
  const r = e.post({ token: TOKEN, action: 'hist', days: {
    [D[0]]: { TCS: flat(100), SONA: flat(200), OTHER: flat(5) },
    [D[1]]: { TCS: flat(101, 100), SONA: flat(202, 200), BAD: ['x'] },
    [D[2]]: { TCS: flat(102, 101), SONA: flat(204, 300) }               // SONA: prev close not the stored close
  } });
  assert.deepStrictEqual(r, { ok: true, mode: 'rewritten', added: 3, candles: 6, days: 3, newest: D[2], oldest: D[0], symbols: 2, want: 60 });
  const t = e.sheet('History60').rows;
  assert.match(t[0][0], /^NSE daily candles read by your PC/);
  assert.deepStrictEqual(t[1], ['Symbol', D[2], D[1], D[0]]);
  assert.deepStrictEqual(t[2], ['(linked)', 'Y', 'Y', ''], 'half the stocks or more have prev close = the older close');
  assert.deepStrictEqual(t[3], ['TCS', '101 103 100 102 1000 101', '100 102 99 101 1000 100', '99 101 98 100 1000 100']);
  assert.strictEqual(t[4][0], 'SONA');
  assert.strictEqual(t.length, 5, 'OTHER is not in PatternData');
  assert.deepStrictEqual(plain(e.call('ab_h60Info_')), { days: [D[2], D[1], D[0]], want: 60 });
  assert.deepStrictEqual(e.post({ token: TOKEN, action: 'list' }).h60, { days: [D[2], D[1], D[0]], want: 60 }, 'list tells the PC');
});

test('hist: newer days are added as columns, older days rewrite the tab, only the newest 60 are kept', () => {
  const e = env([patternData(['TCS', 'SONA', 'NEWCO']), mainTab(['TCS', 'SONA'])]);
  const day = (i) => ({ TCS: flat(100 + i, 100 + i - 1), SONA: flat(200 + i, 200 + i - 1) });
  const post = (from, to) => {
    const days = {};
    for (let i = from; i <= to; i++) days[D[i]] = day(i);
    return e.post({ token: TOKEN, action: 'hist', days: days });
  };
  assert.strictEqual(post(30, 39).mode, 'rewritten');
  e.writes.length = 0;
  const r = post(40, 41);
  assert.strictEqual(r.mode, 'added');
  assert.ok(e.writes.some((w) => w.kind === 'insertColumns' && w.col === 2), 'two columns put in front');
  assert.ok(!e.writes.some((w) => w.sheet === 'History60' && w.kind === 'clear'), 'the tab is not rewritten');
  let t = e.sheet('History60').rows;
  assert.deepStrictEqual(t[1].slice(0, 4), ['Symbol', D[41], D[40], D[39]]);
  assert.deepStrictEqual(t[2].slice(0, 4), ['(linked)', 'Y', 'Y', 'Y'], 'linked to the stored newest day');
  assert.strictEqual(t[3][1], cell(140, 142, 139, 141, 1000, 140));
  // a new PatternData stock in an added day gets its own row
  assert.strictEqual(e.post({ token: TOKEN, action: 'hist', days: { [D[42]]: Object.assign(day(42), { NEWCO: flat(50, 49) }) } }).symbols, 3);
  t = e.sheet('History60').rows;
  assert.deepStrictEqual([t[5][0], t[5][1], t[5][2]], ['NEWCO', cell(49, 51, 48, 50, 1000, 49), '']);
  // older days (the first fill going back): rewritten, sorted
  const older = post(20, 29);
  assert.deepStrictEqual([older.mode, older.days, older.oldest, older.newest], ['rewritten', 23, D[20], D[42]]);
  t = e.sheet('History60').rows;
  assert.deepStrictEqual([t[1][1], t[1][23]], [D[42], D[20]]);
  assert.strictEqual(t[2][23], '', 'the oldest day has nothing older to follow');
  // 60 days at most: the oldest columns go
  post(0, 9); post(10, 19); post(43, 52); post(53, 57); post(58, 63);
  t = e.sheet('History60').rows;
  assert.strictEqual(t[1].filter(Boolean).length, 61);
  assert.deepStrictEqual([t[1][1], t[1][60]], [D[63], D[4]]);
  assert.strictEqual(e.call('ab_h60Info_').days.length, 60);
});

test('hist: refused posts', () => {
  const e = env([patternData(['TCS']), mainTab(['TCS'])]);
  assert.deepStrictEqual(e.post({ token: TOKEN, action: 'hist' }), { ok: false, error: 'days missing - update screener_bridge.py on the PC' });
  assert.deepStrictEqual(e.post({ token: TOKEN, action: 'hist', days: { '28-10-2026': {} } }), { ok: false, error: 'no trading day in the data' });
  const many = {};
  D.slice(0, 16).forEach((d) => { many[d] = { TCS: flat(1) }; });
  assert.deepStrictEqual(e.post({ token: TOKEN, action: 'hist', days: many }), { ok: false, error: 'too many days in one post (at most 15)' });
  assert.deepStrictEqual(e.post({ token: TOKEN, action: 'hist', days: { [D[0]]: { OTHER: flat(1) } } }), { ok: false, error: 'none of the posted stocks is in PatternData' });
  assert.deepStrictEqual(e.post({ token: 'nope', action: 'hist', days: { [D[0]]: { TCS: flat(1) } } }), { ok: false, error: 'bad token' });
  assert.strictEqual(e.sheet('History60'), null);
});

// D[0..9]: History60 has all ten days, History30 (GOOGLEFINANCE) D[5..9]
const NSE = {
  TCS: Object.fromEntries(D.slice(0, 10).map((d, i) => [d, cell(99 + i, 101 + i, 98 + i, 100 + i, 1000, i ? 99 + i : 100)])),
  // 1:2 split on D[3]: NSE's previous close that day is the adjusted 102, the stored close of D[2] is 204
  SONA: Object.fromEntries(D.slice(0, 10).map((d, i) => {
    const px = i < 3 ? 200 + 2 * i : 100 + i;
    const prev = i === 0 ? 200 : i < 3 ? 198 + 2 * i : i === 3 ? 102 : 99 + i;
    return [d, cell(px - 1, px + 1, px - 2, px, i < 3 ? 1000 : 2000, prev)];
  })),
  RALLIS: Object.fromEntries(D.slice(0, 10).map((d, i) => [d, cell(50, 51, 49, 50, 4000, 50)])),
  NEWCO: Object.fromEntries(D.slice(0, 10).map((d, i) => [d, cell(10, 11, 9, 10 + i / 10, 500, i ? 10 + (i - 1) / 10 : 10)])),
  GONE: Object.fromEntries(D.slice(0, 10).map((d) => [d, cell(1, 1, 1, 1, 1, 1)]))
};
NSE.NEWCO[D[10]] = cell(12, 12, 12, 12, 1, 10.9);    // newer than History30's newest day: not used
const GF = {
  TCS: D.slice(5, 10).map((d, i) => [d, 104 + i, 106 + i, 103 + i, 105 + i, 1000]),
  SONA: D.slice(5, 10).map((d, i) => [d, 104 + i, 106 + i, 103 + i, 105 + i, 2000]),
  RALLIS: D.slice(5, 10).map((d) => [d, 55, 56.1, 53.9, 55, 4000])          // 10 % above NSE: adjusted differently
};
function mergedEnv(linked) {
  return env([patternData(['TCS', 'SONA', 'RALLIS', 'NEWCO']), mainTab(['TCS', 'SONA', 'RALLIS', 'NEWCO']),
    history30(GF), history60(D.slice(0, 11), NSE, linked)]);
}
const iso = (e, c) => e.call('ab_h60Iso_', c.date);

test('merged history: older NSE days in front of History30 - split adjusted, matched at the seam, PatternData stocks only', () => {
  const e = mergedEnv();
  const m = e.call('ab_readHistoryMerged_');
  assert.deepStrictEqual(plain(Object.keys(m).sort()), ['NEWCO', 'RALLIS', 'SONA', 'TCS'], 'GONE is not in PatternData');
  const tcs = m.TCS;
  assert.deepStrictEqual(plain(tcs.map((c) => iso(e, c))), D.slice(0, 10));
  assert.ok(tcs[0].date instanceof e.Date, 'a Date like History30\'s day cells');
  assert.deepStrictEqual(plain([tcs[0].Opn, tcs[0].High, tcs[0].Low, tcs[0].Cls, tcs[0].Volume]), [99, 101, 98, 100, 1000]);
  assert.deepStrictEqual([tcs[5].Cls, tcs[9].Cls], [105, 109], 'History30 from its first day on');

  const sona = plain(m.SONA.map((c) => [iso(e, c), c.Opn, c.High, c.Low, c.Cls, c.Volume]));
  assert.deepStrictEqual(sona.slice(0, 5), [
    [D[0], 99.5, 100.5, 99, 100, 2000], [D[1], 100.5, 101.5, 100, 101, 2000], [D[2], 101.5, 102.5, 101, 102, 2000],
    [D[3], 102, 104, 101, 103, 2000], [D[4], 103, 105, 102, 104, 2000]], 'before the split: halved prices, doubled volume');

  const rallis = plain(m.RALLIS.map((c) => [c.Opn, c.High, c.Low, c.Cls, c.Volume]));
  assert.deepStrictEqual(rallis[0], [55, 56.1, 53.9, 55, 3636], 'scaled to History30\'s close on its first day');
  assert.deepStrictEqual(rallis[5], [55, 56.1, 53.9, 55, 4000]);

  assert.deepStrictEqual(plain(m.NEWCO.map((c) => iso(e, c))), D.slice(0, 10), 'not in History30: every NSE day up to History30\'s newest');
  assert.strictEqual(m.NEWCO[9].Cls, 10.9);
});

test('merged history: a gap in History60 (a day not received yet) - only the days after it; no History60 = History30 as it is', () => {
  const e = mergedEnv((d) => d !== D[3] && d !== D[0]);       // D[3] does not follow D[2]
  const m = e.call('ab_readHistoryMerged_');
  assert.deepStrictEqual(plain(m.SONA.slice(0, 3).map((c) => [iso(e, c), c.Cls])), [[D[3], 103], [D[4], 104], [D[5], 105]],
    'no candles from before the gap: the series never skips a trading day (and no split is guessed across it)');
  assert.deepStrictEqual(plain(m.NEWCO.map((c) => iso(e, c))), D.slice(3, 10));
  // History60 does not reach History30's first day: nothing in front
  const late = env([patternData(['TCS']), mainTab(['TCS']), history30({ TCS: GF.TCS }), history60(D.slice(0, 4), { TCS: NSE.TCS })]);
  assert.strictEqual(late.call('ab_readHistoryMerged_').TCS.length, 5);
  const plainEnv = env([patternData(['TCS']), mainTab(['TCS']), history30({ TCS: GF.TCS })]);
  const p = plainEnv.call('ab_readHistoryMerged_');
  assert.deepStrictEqual(plain(Object.keys(p)), ['TCS']);
  assert.strictEqual(p.TCS.length, 5);
});

test('FVG scans and Results Performance read the merged history', () => {
  // a 4 % gap-up formed before History30's window and never touched since
  const nse = { GAP: {} };
  D.slice(0, 10).forEach((d, i) => {
    const px = i < 3 ? 100 : 110 + i;
    nse.GAP[d] = cell(px, px + 1, i < 3 ? px - 1 : 104 + i, px, 100000, i ? (i < 3 ? 100 : i === 3 ? 100 : 110 + i - 1) : 100);
  });
  const gf = { GAP: D.slice(5, 10).map((d, i) => [d, 115 + i, 116 + i, 109 + i, 115 + i, 100000]) };
  const e = env([patternData(['GAP']), mainTab(['GAP']), history30(gf), history60(D.slice(0, 10), nse)]);
  const r = plain(e.call('computeGapUpFvgs_'));
  assert.strictEqual(r.gaps, 1, JSON.stringify(r));
  const row = e.sheet('GapUpFVG').rows[1];
  assert.deepStrictEqual([row[0], row[1], row[2]], ['GAP', 101, 107]);
  assert.strictEqual(e.call('ab_h60Iso_', row[4]), D[3], 'formed on a History60 day');
  const src = e.run('ab_rpRefresh_.toString() + computeUnmitigatedFvgs_.toString() + computeLongFVGTouchPatterns_.toString() + runExplainFvgSymbol.toString()');
  assert.strictEqual((src.match(/ab_readHistoryMerged_\(/g) || []).length, 4);
  assert.ok(!/ab_readHistoryMerged_/.test(e.run('computeEmaSupportPatterns_.toString() + computeAtrPatterns_.toString()')), 'EMA / ATR keep History30');
});

test('site feed part history60: only the days History30 does not have', () => {
  const e = mergedEnv();
  const r = e.post({ action: 'site', part: 'history60', token: FEED });
  assert.strictEqual(r.ok, true, r.error);
  const h = r.data;
  assert.deepStrictEqual(Object.keys(h), ['source', 'timeframe', 'stored', 'dates', 'cols', 'bars']);
  assert.deepStrictEqual(h.stored, { days: 11, first: D[0], last: D[10] });
  assert.deepStrictEqual(h.dates, D.slice(0, 10));
  assert.deepStrictEqual(Object.keys(h.bars), ['TCS', 'SONA', 'RALLIS', 'NEWCO']);
  assert.deepStrictEqual(h.bars.TCS, [[0, 99, 101, 98, 100, 1000], [1, 100, 102, 99, 101, 1000], [2, 101, 103, 100, 102, 1000],
    [3, 102, 104, 101, 103, 1000], [4, 103, 105, 102, 104, 1000]]);
  assert.deepStrictEqual(h.bars.SONA[0], [0, 99.5, 100.5, 99, 100, 2000]);
  assert.strictEqual(h.bars.NEWCO.length, 10);
  // without a History60 tab: an empty part
  const none = env([patternData(['TCS']), mainTab(['TCS']), history30({ TCS: GF.TCS })]);
  assert.deepStrictEqual(none.post({ action: 'site', part: 'history60', token: FEED }).data,
    { source: 'History60 tab (NSE bhavcopy via your PC)', timeframe: '1d', stored: null, dates: [], cols: ['d', 'o', 'h', 'l', 'c', 'v'], bars: {} });
});

// ---- Phase 1: a stock GOOGLEFINANCE gave nothing for is filled from History60
function phase1Env(n, noData, nse) {
  const pd = [['Name', '', '', 'Symbol']];
  for (let i = 0; i < n; i++) pd.push(['Co ' + i, '', '', 'S' + String(i).padStart(4, '0')]);
  const tab = (name) => ({ name: name, rows: [['TckrSymb', 'OpnPric', 'HghPric', 'LwPric', 'ClsPric', 'TtlTradgVol']] });
  const e = mock.loadCodeGs({ sheets: [{ name: 'PatternData', rows: pd }, tab('Day4'), tab('ThirdDay'), tab('Yesterday'), tab('Today'),
    { name: 'History30', rows: [['Symbol', 'Date', 'Open', 'High', 'Low', 'Close', 'Volume']] }, { name: 'AutoFetch Log', rows: [['ts']] },
    history60(D.slice(-35), nse)] }, { now: NOW, props: { AB_EMAIL_TO: 'x@example.com' } });
  const days = D.slice(-31).map((d) => e.call('ab_h60Date_', d));
  let formulas = [];
  const scratch = {
    clearContents: () => scratch, getMaxRows: () => 100000, getMaxColumns: () => 26, insertRowsAfter: () => scratch, insertColumnsAfter: () => scratch,
    getRange: (r, c, nr) => ({
      setFormulas: (f) => { formulas = f; },
      getValues: () => {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const m = /NSE:([A-Z0-9]+)/.exec((formulas[i] || [''])[0]);
          if (!m) { out.push(['', '', '', '', '', '']); continue; }
          const block = [['Date', 'Open', 'High', 'Low', 'Close', 'Volume']];
          if (!noData.includes(m[1])) days.forEach((d, k) => block.push([d, 100 + k, 102 + k, 99 + k, 101 + k, 1000 + k]));
          block.forEach((row) => out.push(row));
          i += block.length - 1;
        }
        return out.slice(0, nr);
      }
    })
  };
  e.context.ab_getScratchSheet_ = () => scratch;
  e.run('syncSymbolsFromBlueprint_ = function () {}; fillIpoLevel_ = function () {}; ab_ensureResultDateReal_ = function () {};' +
    'fillPrevDayVolume_ = function () {}; ab_runFvgScansIfPending_ = function () { return false; }; ab_skipWeekendTrigger_ = function () { return false; };');
  return e;
}

test('Phase 1: a stock GOOGLEFINANCE gave no data for gets History30 rows and the day tabs from History60', () => {
  const nse = {
    S0001: Object.fromEntries(D.slice(-35).map((d, i) => [d, cell(50 + i, 52 + i, 49 + i, 51 + i, 700, 50 + i)])),
    S0002: Object.fromEntries(D.slice(-35, -1).map((d, i) => [d, cell(20, 21, 19, 20, 300, 20)]))   // no candle for the newest day
  };
  const e = phase1Env(4, ['S0001', 'S0002', 'S0003'], nse);
  assert.deepStrictEqual(plain(e.call('ab_dailyPhase1Fetch_')), { part: 1, parts: 1, done: true });
  const h = e.sheet('History30').rows.slice(1);
  const s1 = h.filter((r) => r[0] === 'S0001');
  assert.strictEqual(s1.length, 30);
  assert.deepStrictEqual([s1[0][1], s1[29][1]].map((v) => e.call('ab_h60Iso_', v)), [D[D.length - 30], D[D.length - 1]]);
  assert.deepStrictEqual(s1[29].slice(2), [84, 86, 83, 85, 700]);
  assert.strictEqual(h.filter((r) => r[0] === 'S0002').length, 29, 'up to the day before the newest');
  assert.deepStrictEqual(e.sheet('Today').rows.find((r) => r[0] === 'S0001'), ['S0001', 84, 86, 83, 85, 700]);
  assert.deepStrictEqual(e.sheet('Day4').rows.find((r) => r[0] === 'S0001'), ['S0001', 81, 83, 80, 82, 700]);
  assert.strictEqual(e.sheet('Today').rows.find((r) => r[0] === 'S0002'), undefined, 'no candle for the newest day: not in the day tabs');
  const ok = e.sheet('AutoFetch Log').rows.slice(1).map((r) => r[3] + ' | ' + r[4]).filter((l) => /^OK/.test(l));
  assert.strictEqual(ok.length, 1);
  assert.match(ok[0], new RegExp('No data for: S0003\\. From History60 \\(NSE via your PC, candles up to ' + D[D.length - 1] +
    '\\): S0001, S0002 \\(day tabs for 1 - the others have no candle for the newest day yet\\)\\. OHLC, History30'));
  assert.strictEqual(e.sheet('History30').rows.filter((r) => r[0] === 'S0000').length, 30);
});

test('a holiday NSE answered with the day before\'s file: that copy day is left out, the series runs across it', () => {
  // D[3] is an exchange holiday: its column is D[2]'s file again; D[4]'s previous close is D[2]'s close
  const cells = {}, gf = {};
  ['AAA', 'BBB'].forEach((s, k) => {
    cells[s] = {};
    let prev = 50 + k;
    D.slice(0, 10).forEach((d, i) => {
      if (i === 3) { cells[s][d] = cells[s][D[2]]; return; }
      const c = 50 + k + i;
      cells[s][d] = cell(c - 1, c + 1, c - 2, c, 100, prev);
      prev = c;
    });
    gf[s] = D.slice(5, 10).map((d, i) => [d, 54 + k + i, 56 + k + i, 53 + k + i, 55 + k + i, 100]);
  });
  const e = env([patternData(['AAA', 'BBB']), mainTab(['AAA', 'BBB']), history30(gf), history60(D.slice(0, 10), cells, (d) => d !== D[0] && d !== D[3])]);
  const g = e.call('ab_h60Load_');
  assert.deepStrictEqual(plain(g.dropped), [D[3]]);
  assert.deepStrictEqual(plain(g.days), D.slice(0, 10).filter((d) => d !== D[3]));
  const m = e.call('ab_readHistoryMerged_');
  assert.deepStrictEqual(plain(m.AAA.map((c) => iso(e, c))), D.slice(0, 10).filter((d) => d !== D[3]), 'all the older days, without the copy');
  assert.ok(!plain(e.call('ab_h60Info_').days).includes(D[3]), 'the PC is not told the copy day is there');
  assert.ok(!e.post({ action: 'site', part: 'history60', token: FEED }).data.dates.includes(D[3]));
  // the next rewrite (older days from the PC) takes the copy out of the tab
  e.post({ token: TOKEN, action: 'hist', days: { '2026-07-01': { AAA: flat(40) } } });   // older than D[0]
  assert.ok(!e.sheet('History60').rows[1].includes(D[3]));
  assert.deepStrictEqual(plain(e.call('ab_h60Load_').dropped), []);
});
