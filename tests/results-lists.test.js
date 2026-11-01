'use strict';
// Results page lists (web/lib/results.js): the stocks behind each tile / bar of #results must add up to
// the numbers the sheet's Results Performance tab shows (checked on the saved copy, web/data/dashboard.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const R = require('../web/lib/results.js');

const w = {};
new Function('window', fs.readFileSync(path.join(__dirname, '..', 'web', 'data', 'dashboard.js'), 'utf8'))(w);
const D = w.SB_DATA;
const perf = D.resultsPerf;
const season = R.seasonOf(perf);
const P = R.perfRows(perf, season), T = R.trackerRows(D.resultsTracker, season);

test('the lists match the sheet\'s own season numbers', () => {
  const s = perf.seasons[0];
  assert.ok(season && P.length > 50, season + ' ' + P.length);
  assert.strictEqual(P.length, s.tracked, 'Stocks tracked');
  const n = R.counts(P, T);
  const m = /^(\d+) of (\d+)/.exec(s.above);
  assert.strictEqual(n.above, +m[1], 'Above pre-result price');
  assert.strictEqual(n.above + n.below, +m[2], 'every stock with a move is above or below');
  assert.strictEqual(n.soldoff, s.soldOff, 'Strong results, sold off');
  perf.verdicts.forEach((v) => assert.strictEqual(n[v.verdict.toLowerCase()], v.stocks, v.verdict));
  assert.strictEqual(n.waiting, T.filter((r) => r.Status === 'Pending').length);
});

test('announcement sessions come from the Announced text; movers are sorted', () => {
  assert.deepStrictEqual(['29/10 17:05 After market', '01/11 11:00 Market closed', '30/10 13:20 Market hours', '30/10 08:40 Before market', '', null]
    .map((a) => R.session({ Announced: a })), ['after', 'after', 'market', 'before', '', '']);
  const rows = [{ Symbol: 'A', '% Since Results': 5, 'Result Day %': 2, Announced: '29/10 17:05 After market' },
    { Symbol: 'B', '% Since Results': -3, 'Result Day %': -1, Announced: '29/10 11:05 Market hours' },
    { Symbol: 'C', '% Since Results': 9, 'Result Day %': 4, Announced: '29/10 18:05 After market' }, { Symbol: 'D', '% Since Results': null }];
  const s = R.bySession(rows);
  assert.deepStrictEqual(s.map((x) => [x.id, x.count, x.avgDay]), [['after', 2, 3], ['market', 1, -1], ['before', 0, null], ['unknown', 1, null]]);
  assert.deepStrictEqual(R.pick('after', rows, []).map((r) => r.Symbol), ['A', 'C']);
  const mv = R.movers(rows, 5);
  assert.deepStrictEqual([mv.best.map((r) => r.Symbol), mv.worst.map((r) => r.Symbol)], [['C', 'A'], ['B']]);
  const real = R.movers(P, 5);
  assert.strictEqual(real.best.length, 5);
  assert.ok(real.best[0]['% Since Results'] >= real.best[4]['% Since Results']);
});
