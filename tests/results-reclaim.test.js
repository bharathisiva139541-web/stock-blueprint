'use strict';
// "Fell after results, then back above" (the owner's friend, 03-Nov-2026: some stocks fall below the pre-results price
// after the results and 15-20 days later climb back above it and keep going up) - web/lib/results.js reclaim /
// reclaimRows / pick, from the daily closes against the sheet's Pre-Result Close.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const R = require('../web/lib/results.js');

// 25 trading days from 2026-10-01 (weekdays)
const DATES = [];
for (let d = new Date(Date.UTC(2026, 9, 1)); DATES.length < 25; d.setUTCDate(d.getUTCDate() + 1)) {
  if (d.getUTCDay() % 6) DATES.push(d.toISOString().slice(0, 10));
}
const H = { dates: DATES, bars: {} };
function stock(sym, closes) { H.bars[sym] = closes.map((c, i) => [i, c, c, c, c, 1000]); }
const row = (sym, extra) => Object.assign({ Symbol: sym, Company: sym + ' Ltd', 'Result Date': DATES[2] + ' 12:00', 'Pre-Result Close': 100 }, extra || {});
//            before  | results on DATES[2] ->
stock('SLOW', [100, 100, 95, 92, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 101, 103, 105, 107, 108, 110, 111, 112, 113, 114, 115]);
stock('FAST', [100, 100, 96, 102, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124]);
stock('NEAR', [100, 100, 94, 92, 91, 92, 93, 94, 95, 96, 97, 97, 98, 98, 98, 98, 98, 98, 98, 98, 98, 98, 98, 98, 98]);
stock('DOWN', [100, 100, 95, 92, 90, 88, 86, 85, 84, 83, 82, 81, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80]);
stock('SMALL', [100, 100, 99, 98.5, 99, 101, 102, 103, 104, 105, 106, 107, 108, 108, 108, 108, 108, 108, 108, 108, 108, 108, 108, 108, 108]);
stock('FADE', [100, 100, 95, 94, 93, 99, 101, 104, 106, 104, 103, 102, 101.5, 101, 101, 101, 101, 101, 101, 101, 101, 101, 101, 101, 101]);
stock('AFTER', [100, 100, 100, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117]);

test('the reads: slow / fast reclaim, near, still falling, a small dip, fading, an after-market result', () => {
  const s = R.reclaim(row('SLOW'), H);
  assert.deepStrictEqual([s.status, s.lowDay, Math.round(s.lowPct), s.reclaimDay, s.reclaimDate, s.trend, s.sessions],
    ['reclaimed', 3, -10, 13, DATES[14], 'Rising', 23]);
  const f = R.reclaim(row('FAST'), H);
  assert.deepStrictEqual([f.status, f.lowDay, f.reclaimDay, f.trend], ['reclaimed', 1, 2, 'Rising']);
  assert.deepStrictEqual([R.reclaim(row('NEAR'), H).status, Math.round(R.reclaim(row('NEAR'), H).nowPct)], ['near', -2]);
  assert.strictEqual(R.reclaim(row('DOWN'), H).status, 'below');
  assert.strictEqual(R.reclaim(row('SMALL'), H).status, 'held', 'only 1.5% below: not the pattern');
  assert.deepStrictEqual([R.reclaim(row('FADE'), H).status, R.reclaim(row('FADE'), H).trend], ['reclaimed', 'Holding'], 'above, under its reclaim-day close');
  // filed after market on DATES[2] (the sheet's Reaction From 'after ...'): the closes from the next session
  const a = R.reclaim(row('AFTER', { 'Reaction From': 'after ' + DATES[2], 'Pre-Result Close': 100 }), H);
  assert.deepStrictEqual([a.lowDate, a.lowDay, a.reclaimDay, a.sessions], [DATES[3], 1, 6, 22]);
  assert.strictEqual(R.reclaim(row('AFTER', { 'Reaction From': 'from ' + DATES[3] }), H).lowDay, 1);
  // no candles / no pre-result close
  assert.strictEqual(R.reclaim(row('NOPE'), H), null);
  assert.strictEqual(R.reclaim(row('SLOW', { 'Pre-Result Close': null }), H), null);
});

test('the lists: back above now, after 2+ weeks, close to it', () => {
  const P = ['SLOW', 'FAST', 'NEAR', 'DOWN', 'SMALL', 'FADE', 'NOPE'].map((s) => row(s));
  const rc = R.reclaimRows(P, H);
  assert.strictEqual(rc.length, 6, 'NOPE has no candles');
  const ids = (k) => R.pick(k, P, [], rc).map((r) => r.Symbol).sort();
  assert.deepStrictEqual(ids('reclaimed'), ['FADE', 'FAST', 'SLOW']);
  assert.deepStrictEqual(ids('reclaimslow'), ['SLOW']);
  assert.deepStrictEqual(ids('nearreclaim'), ['NEAR']);
  const n = R.counts(P, [], rc);
  assert.deepStrictEqual([n.reclaimed, n.reclaimslow, n.nearreclaim], [3, 1, 1]);
  assert.deepStrictEqual([R.counts(P, []).reclaimed, R.pick('reclaimed', P, [])], [0, []], 'no candles loaded yet: empty');
  assert.strictEqual(rc.find((r) => r.Symbol === 'SLOW').reclaimDay, 13, 'columns for the table');
});

test('the saved copy: every "back above" stock really fell 3% and closes above its pre-result close', () => {
  const w = {};
  ['dashboard.js', 'history.js'].forEach((f) => new Function('window', fs.readFileSync(path.join(__dirname, '..', 'web', 'data', f), 'utf8'))(w));
  const perf = w.SB_DATA.resultsPerf;
  const P = R.perfRows(perf, R.seasonOf(perf));
  const rc = R.reclaimRows(P, w.SB_HISTORY);
  assert.ok(rc.length > 50, String(rc.length));
  R.pick('reclaimed', P, [], rc).forEach((r) => {
    assert.ok(r.reclaim.lowPct <= -3 && r.reclaim.now > r['Pre-Result Close'] && r.reclaimDay > r.lowDay, r.Symbol);
  });
});
