'use strict';
// Post-results opportunities (the user's rules, preset 'postResults'): the four set-ups
// from the Results Performance record (Since results, Max gain, Max drawdown, Verdict,
// Reaction) and the supporting quarterly figures; ranking; joining the tab to stocks.
const test = require('node:test');
const assert = require('node:assert');
const S = require('../web/lib/strategy.js');

const P = S.PRESETS.postResults;
const GOOD = { revYoY: 30, npYoY: 60, revQoQ: 10, npQoQ: 20, opmQoQ: 'Increasing', opmYoY: 'Increasing' };
function stock(sym, rp, extra) {
  return Object.assign({ sym: sym, price: 100, epsg: 25, fii: 'Increasing', rp: rp ? Object.assign({}, GOOD, rp) : null }, extra || {});
}
// 30 calm daily candles (enough for the ATR stop placeholder)
const CANDLES = Array.from({ length: 30 }, (_, i) => ({ t: '2026-10-' + String(i + 1).padStart(2, '0'), o: 99, h: 101, l: 98, c: 100, v: 100000 }));
function runAll(stocks) {
  const hist = {};
  stocks.forEach((s) => { hist[s.sym] = CANDLES; });
  return S.run(P, stocks, hist, { usePrice: true, latestDate: CANDLES[CANDLES.length - 1].t });
}

test('the four set-ups: immediate rally, second opportunity, gains eroded (half / erased), delayed reaction', () => {
  const run = runAll([
    stock('RALLY', { since: 18, maxGain: 20, maxDD: -2, verdict: 'Strong', reaction: 'Rallied' }),           // holds 90%
    stock('SECOND', { since: 14, maxGain: 20, maxDD: -2, verdict: 'Strong', reaction: 'Rallied' }),          // holds 70%
    stock('HALF', { since: 9, maxGain: 20, maxDD: -1, verdict: 'Strong', reaction: 'Rallied' }),             // holds 45%
    stock('ERASED', { since: 1, maxGain: 20, maxDD: -3, verdict: 'Strong', reaction: 'Flat' }),              // the sheet says Flat: Max gain shows the rally
    stock('DELAYED', { since: 2, maxGain: 3, maxDD: -4, verdict: 'Strong', reaction: 'Flat' }),
    stock('DELAYWEAK', { since: -3, maxGain: 2, maxDD: -12, verdict: 'Strong', reaction: 'Flat' }),
    stock('SOLD', { since: -9, maxGain: 1, maxDD: -11, verdict: 'Strong', reaction: 'Sold off' }),
    stock('NORESULT', null)
  ]);
  const t = (sym) => run.bySym[sym].setupTypes.join('|');
  const st = (sym) => run.bySym[sym].status;
  assert.deepStrictEqual([t('RALLY'), st('RALLY')], ['Immediate rally', 'qualified']);
  assert.deepStrictEqual([t('SECOND'), st('SECOND')], ['Second opportunity after rally', 'qualified']);
  assert.deepStrictEqual([t('HALF'), st('HALF')], ['Rally gains eroded (about half given back)', 'qualified']);
  assert.deepStrictEqual([t('ERASED'), st('ERASED')], ['Rally gains eroded (nearly erased)', 'qualified']);
  assert.deepStrictEqual([t('DELAYED'), st('DELAYED')], ['Delayed reaction', 'qualified']);
  assert.deepStrictEqual([t('DELAYWEAK'), st('DELAYWEAK')], ['Delayed reaction (weak price record)', 'watch'], 'weak recorded performance is told apart');
  assert.strictEqual(st('SOLD'), 'none');
  assert.strictEqual(st('NORESULT'), 'none');
  assert.match(run.bySym.NORESULT.failed.join(' '), /no trigger fired/);
  const d = run.bySym.HALF.checks.find((c) => c.id === 'postResults').res.detail;
  assert.match(d, /since results \+9%, max gain \+20% \(still holds 45% of it\), max drawdown -1% · verdict Strong, reaction Rallied · gave back 55% of the gain/);
});

test('verdict: Strong qualifies, Mixed is Watch, Weak is left out; weak quarterly figures make it Watch', () => {
  const run = runAll([
    stock('MIXED', { since: 18, maxGain: 20, maxDD: -2, verdict: 'Mixed', reaction: 'Rallied' }),
    stock('WEAK', { since: 9, maxGain: 20, maxDD: -2, verdict: 'Weak', reaction: 'Rallied' }),
    stock('THIN', { since: 18, maxGain: 20, maxDD: -2, verdict: 'Strong', reaction: 'Rallied', revQoQ: -5, npQoQ: -10, opmQoQ: 'Decreasing', revYoY: -1 }, { epsg: -3, fii: 'Decreasing' })
  ]);
  assert.strictEqual(run.bySym.MIXED.status, 'watch');
  assert.strictEqual(run.bySym.WEAK.status, 'none');
  assert.match(run.bySym.WEAK.checks[0].res.detail, /thesis not supported/);
  assert.strictEqual(run.bySym.THIN.status, 'watch', 'below 60% of the figures positive');
  const sup = run.bySym.THIN.checks.find((c) => c.id === 'resultsSupport').res;
  assert.strictEqual(sup.pass, false);
  assert.match(sup.detail, /^2 of 8 positive \(25%\)/);
});

test('ranking: eroded stocks by gains given back and by the quarter\'s figures', () => {
  const run = runAll([
    stock('E45', { since: 11, maxGain: 20, maxDD: -1, verdict: 'Strong', reaction: 'Rallied' }),   // gave back 45%
    stock('E90', { since: 2, maxGain: 20, maxDD: -1, verdict: 'Strong', reaction: 'Flat' }),       // gave back 90%
    stock('E90LOW', { since: 2, maxGain: 20, maxDD: -1, verdict: 'Strong', reaction: 'Flat', revQoQ: -1 }, { epsg: -1 })
  ]);
  const order = run.lists.qualified.map((r) => r.sym);
  assert.deepStrictEqual(order, ['E90', 'E90LOW', 'E45']);
  assert.ok(run.bySym.E90.rank > run.bySym.E90LOW.rank);
});

test('thresholds are editable and validated like every rule; the preset is "your rules", not confirmed', () => {
  const v = S.validate(P);
  assert.strictEqual(v.ok, true, v.errors.join('; '));
  assert.strictEqual(P.source, 'request');
  const cfg = S.clone(P);
  cfg.triggers[0].params.keepRally = 95;                     // stricter: 90% held is no longer an "immediate rally"
  const run = S.run(cfg, [stock('RALLY', { since: 18, maxGain: 20, maxDD: -2, verdict: 'Strong', reaction: 'Rallied' })], { RALLY: CANDLES }, { usePrice: true });
  assert.strictEqual(run.bySym.RALLY.setupTypes[0], 'Second opportunity after rally');
  assert.ok(P.assumptions.length >= 6, 'the assumptions are listed for the user to confirm');
});

test('rpIndex: the latest Results Performance row per symbol', () => {
  const table = { cols: ['Symbol', 'Quarter', 'Result Date', '% Since Results', 'Max Gain %', 'Max Drawdown %', 'Results Verdict', 'Market Reaction', 'Rev YoY %', 'OPM QoQ'],
    rows: [['abc', 'Jun 2026', '2026-07-20 12:00', 5, 8, -1, 'Mixed', 'Rallied', 3, 'Increasing'],
      ['ABC', 'Sep 2026', '2026-10-21 12:00', 12, 15, -2, 'Strong', 'Rallied', 30, 'Increasing'],
      ['XYZ', 'Sep 2026', '2026-10-10 12:00', null, 'x', null, 'Weak', 'Flat', null, '']] };
  const ix = S.rpIndex(table);
  assert.deepStrictEqual(Object.keys(ix).sort(), ['ABC', 'XYZ']);
  assert.strictEqual(ix.ABC.quarter, 'Sep 2026');
  assert.strictEqual(ix.ABC.since, 12);
  assert.strictEqual(ix.ABC.revYoY, 30);
  assert.strictEqual(ix.XYZ.maxGain, null, 'non-numbers are missing, not zero');
  assert.deepStrictEqual(S.rpIndex(null), {});
});
