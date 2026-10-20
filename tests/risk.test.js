'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('../web/lib/risk.js');

test('basic sizing: floor(budget / risk per unit)', () => {
  const r = R.sizePosition({ entry: 100, stop: 95, target: 115 }, { capital: 100000, riskPct: 1 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.riskPerUnit, 5);
  assert.strictEqual(r.qty, 200);            // 1000 / 5
  assert.strictEqual(r.riskAmount, 1000);
  assert.strictEqual(r.value, 20000);
  assert.strictEqual(r.rr, 3);
});

test('rejects zero distance and wrong-side stops (no divide by zero)', () => {
  assert.strictEqual(R.sizePosition({ entry: 100, stop: 100 }, {}).ok, false);
  const w = R.sizePosition({ entry: 100, stop: 105 }, {});
  assert.strictEqual(w.ok, false);
  assert.match(w.errors.join(' '), /below the entry/);
  assert.strictEqual(R.sizePosition({ entry: 0, stop: 0 }, {}).ok, false);
  assert.strictEqual(R.sizePosition({ entry: 100, stop: 105, side: 'short' }, {}).ok, false, 'short disabled by default');
  assert.strictEqual(R.sizePosition({ entry: 100, stop: 105, side: 'short' }, { allowShort: true }).ok, true);
});

test('capital cap: cannot buy more than the account can pay for', () => {
  const r = R.sizePosition({ entry: 1000, stop: 999, target: 1010 }, { capital: 100000, riskPct: 1 });
  // by risk: 1000 shares (= Rs 10 lakh) but only Rs 1 lakh available -> 100
  assert.strictEqual(r.qty, 100);
  assert.ok(r.warnings.some((w) => /capital/.test(w)));
});

test('portfolio heat and position count limits', () => {
  const open = [{ value: 20000, risk: 5500 }];
  const r = R.sizePosition({ entry: 100, stop: 95, target: 120 }, { capital: 100000, riskPct: 1, maxHeatPct: 6 }, { openPositions: open });
  assert.strictEqual(r.qty, 100);            // 500 of heat left / 5
  const full = R.sizePosition({ entry: 100, stop: 95 }, { maxPositions: 1 }, { openPositions: [{ value: 1, risk: 1 }] });
  assert.strictEqual(full.ok, false);
  const daily = R.sizePosition({ entry: 100, stop: 95 }, { capital: 100000, dailyLossPct: 3 }, { realizedTodayLoss: 3000 });
  assert.strictEqual(daily.ok, false);
});

test('lot size and reward:risk warning', () => {
  const r = R.sizePosition({ entry: 100, stop: 97, target: 103 }, { lotSize: 25 });
  assert.strictEqual(r.qty % 25, 0);
  assert.ok(r.warnings.some((w) => /below your minimum/.test(w)));
});

test('portfolio risk summary', () => {
  const p = R.portfolioRisk([{ entry: 100, stop: 90, qty: 100, industry: 'IT' }, { entry: 50, qty: 10 }], { capital: 100000 });
  assert.strictEqual(p.openRisk, 1000 + 500);
  assert.strictEqual(p.exposure, 10500);
  assert.ok(Math.abs(p.heatPct - 1.5) < 1e-9);
});
