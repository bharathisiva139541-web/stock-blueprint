'use strict';
// My daily scan (owner, 17-Nov-2026: "Daily Suggestions-இல் வருவது CHoCH / BOS setups மட்டுமே. Add all others too"): every
// pattern of the PC's daily Zerodha scan (the sheet's Intraday Patterns tab, feed part intraday) -> scanIndex -> stock.scan ->
// rule dailyScan / preset dailyScan.
const test = require('node:test');
const assert = require('node:assert');
const S = require('../web/lib/strategy.js');

const COLS = ['Session', 'Symbol', 'Company', 'Timeframe', 'Pattern', 'Candle', 'FVG Formed', 'FVG Detail'];
const TABLE = { cols: COLS, rows: [
  ['2026-11-16', 'ABC', 'Abc Ltd', 'D', 'Spring in FVG', '2026-11-16', '2026-10-28', 'FVG middle (touch 1)'],
  ['2026-11-16', 'ABC', 'Abc Ltd', 'D', 'CHoCH + FVG', '2026-11-16', '2026-10-28', 'FVG middle (touch 1) · Spring · CHoCH 2026-10-30'],
  ['2026-11-13', 'ABC', 'Abc Ltd', '4H', 'Gap-up FVG + Spring', '2026-11-13 13:15', '2026-11-10 09:15', 'Gap-up top (touch 1)'],
  ['2026-11-16', 'DEF', 'Def Ltd', 'D', 'Daily FVG + 4H Spring', '2026-11-16', '2026-11-02', 'FVG top (touch 1) · first day back in the zone'],
  ['2026-11-16', 'GHI', 'Ghi Ltd', 'D', 'Spring', '2026-11-16', '', ''],
  ['2026-11-16', 'GHI', 'Ghi Ltd', 'M', 'Spring in FVG', '2026-11', '2026-05', ''],
  ['2026-11-05', 'JKL', 'Jkl Ltd', 'W', 'BOS + FVG', '2026-11-02', '2026-10-12', 'Zone first touch · BOS 2026-10-26'],
  ['2026-11-16', 'MNO', 'Mno Ltd', 'D', 'Something else', '2026-11-16', '', '']
] };

function candles(n) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const t = new Date(Date.UTC(2026, 9, 1 + k)).toISOString().slice(0, 10);
    out.push({ t: t, o: 100 + k, h: 102 + k, l: 99 + k, c: 101 + k, v: 200000 });
  }
  return out;
}

test('scanIndex: every daily-scan pattern per stock, newest session first, the setups before the plain patterns', () => {
  const ix = S.scanIndex(TABLE);
  assert.deepStrictEqual(Object.keys(ix).sort(), ['ABC', 'DEF', 'GHI', 'JKL']);
  assert.deepStrictEqual(ix.ABC.map((r) => r.tf + ' ' + r.pattern), ['D CHoCH + FVG', 'D Spring in FVG', '4H Gap-up FVG + Spring']);
  assert.strictEqual(ix.DEF[0].detail, 'FVG top (touch 1) · first day back in the zone');
  assert.deepStrictEqual(S.scanIndex(null), {});
  assert.deepStrictEqual(S.scanIndex({ cols: COLS }), {});
  // = the sheet's patterns (Code2.gs AB_ITD_PATTERNS)
  const env = require('./fixtures/apps-script-mock.js').loadCodeGs({});
  const names = JSON.parse(env.run('JSON.stringify(AB_ITD_PATTERNS)'));
  assert.deepStrictEqual(S.SCAN_PATTERNS.slice().sort(), names.slice().sort());
});

test('the preset: a valid setup strategy, the scan\'s setups ticked, plain patterns off', () => {
  const P = S.PRESETS.dailyScan;
  const v = S.validate(P);
  assert.ok(v.ok, v.errors.join('; '));
  assert.deepStrictEqual([v.config.mode, v.config.style, v.config.triggers.map((r) => r.id)], ['setup', 'swing', ['dailyScan']]);
  assert.strictEqual(S.CONDITIONS.dailyScan.pit, false);
  const pats = v.config.triggers[0].params.pats;
  ['CHoCH + FVG', 'BOS + FVG', 'Daily FVG + 4H Spring', 'Spring in FVG', 'Gap-up FVG + Spring', '15m CHoCH in zone'].forEach((p) => assert.ok(pats.indexOf(p) >= 0, p));
  ['Spring', 'FVG First Touch', 'Twin Star Bottom + FVG'].forEach((p) => assert.ok(pats.indexOf(p) < 0, p));
  assert.strictEqual(S.label(v.config.triggers[0]), 'Your daily Zerodha scan found one of your 8 setups on 4H / D / W, at most 1 trading day(s) before today');
  assert.ok(P.assumptions.length >= 3 && /Backtest Lab/.test(P.description));
});

test('the rule: any ticked setup on a ticked timeframe found today / yesterday qualifies', () => {
  const ix = S.scanIndex(TABLE);
  const syms = ['ABC', 'DEF', 'GHI', 'JKL', 'NONE'];
  const stocks = syms.map((s) => ({ sym: s, price: 120, scan: ix[s] || null }));
  const hist = {};
  syms.forEach((s) => { hist[s] = candles(40); });
  const r = S.run(S.PRESETS.dailyScan, stocks, hist, { refDate: '2026-11-17' });
  const chk = (s) => r.bySym[s].checks.find((c) => c.id === 'dailyScan').res;
  assert.strictEqual(chk('ABC').pass, true);
  assert.match(chk('ABC').detail, /^D CHoCH \+ FVG 2026-11-16 \(1 trading day ago\) - FVG middle .*; D Spring in FVG 2026-11-16/);
  assert.ok(!/Gap-up/.test(chk('ABC').detail), 'the 4H row is 2 trading days old');
  assert.strictEqual(chk('DEF').pass, true, 'Daily FVG + 4H Spring');
  assert.strictEqual(chk('GHI').pass, false, 'plain Spring is off, monthly charts are off');
  assert.match(chk('GHI').detail, /not ticked here/);
  assert.strictEqual(chk('JKL').pass, false);
  assert.match(chk('JKL').detail, /^the newest: W BOS \+ FVG 2026-11-02 \(8 trading days ago\)/);
  assert.match(chk('NONE').detail, /none of your setups/);
  assert.ok(['qualified', 'watch'].indexOf(r.bySym.ABC.status) >= 0, r.bySym.ABC.status);
  // the plain Spring + monthly charts ticked, 10 days back: GHI and JKL pass too
  const cfg = S.clone(S.PRESETS.dailyScan);
  cfg.triggers[0].params = { pats: S.SCAN_PATTERNS.slice(), tfs: ['4H', 'D', 'W', 'M'], days: 10 };
  const r2 = S.run(cfg, stocks, hist, { refDate: '2026-11-17' });
  ['ABC', 'DEF', 'GHI', 'JKL'].forEach((s) => assert.strictEqual(r2.bySym[s].checks.find((c) => c.id === 'dailyScan').res.pass, true, s));
  assert.match(r2.bySym.ABC.checks.find((c) => c.id === 'dailyScan').res.detail, /4H Gap-up FVG \+ Spring 2026-11-13 13:15 \(2 trading days ago\)/);
});
