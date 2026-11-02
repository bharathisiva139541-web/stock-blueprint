'use strict';
// Result flags on the website (owner, 03-Nov-2026: pills in the tables + the stock drawer): web/lib/results.js flagList /
// flagIndex read the Results Tracker's 'Flags' text (Code2.gs ab_rsFlags_) - the same four pills as the email.
const test = require('node:test');
const assert = require('node:assert');
const R = require('../web/lib/results.js');

test('flagList: the email\'s pills, the full text kept for the tip, unknown text still shown', () => {
  const t = 'Revenue up, profit down (YoY revenue +12.0%, profit -8.0%); Profit growing faster than revenue (QoQ profit +40.0% vs revenue +5.0%); ' +
    'Exceptional gain Rs 10.00 Cr = 24% of PBT; Other income high: Rs 6.00 Cr = 30% of PBT, 2.5x a year ago (Rs 2.40 Cr); Something new';
  const L = R.flagList(t);
  assert.deepStrictEqual(L.map((f) => [f.id, f.label, f.tone]), [['revdown', 'REV \u2191 PROFIT \u2193', 'bad'], ['profitfaster', 'PROFIT > REVENUE', 'good'],
    ['exceptional', 'EXCEPTIONAL GAIN', 'warn'], ['otherincome', 'OTHER INCOME HIGH', 'warn'], ['other', 'FLAG', 'info']]);
  assert.strictEqual(L[3].text, 'Other income high: Rs 6.00 Cr = 30% of PBT, 2.5x a year ago (Rs 2.40 Cr)');
  assert.deepStrictEqual([R.flagList(''), R.flagList(null), R.flagList(undefined)], [[], [], []]);
});

test('flagIndex: by stock + quarter, and each stock\'s newest result with flags', () => {
  const ix = R.flagIndex([
    { Symbol: 'A', 'Quarter Expected': 'Jun 2026', 'Result Date': '2026-08-10', Flags: 'Exceptional gain Rs 1.00 Cr = 20% of PBT' },
    { Symbol: 'A', 'Quarter Expected': 'Sep 2026', 'Result Date': '2026-11-02', Flags: 'Other income high: Rs 6.00 Cr = 30% of PBT' },
    { Symbol: 'B', 'Quarter Expected': 'Sep 2026', 'Result Date': '2026-11-02', Flags: '' },
    { Symbol: '', Flags: 'x' }]);
  assert.strictEqual(ix['A|Jun 2026'], 'Exceptional gain Rs 1.00 Cr = 20% of PBT');
  assert.deepStrictEqual([ix.A.quarter, ix.A.text], ['Sep 2026', 'Other income high: Rs 6.00 Cr = 30% of PBT']);
  assert.strictEqual(ix.B, undefined, 'no flags, no entry');
  assert.deepStrictEqual(R.flagIndex(null), {});
});
