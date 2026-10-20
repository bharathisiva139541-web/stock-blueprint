'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../web/lib/classify.js');

test('banks are split out of Financial Services by basic industry', () => {
  assert.strictEqual(C.classify({ sector: 'Financial Services', ind: 'Private Sector Bank' }).category, 'banking');
  assert.strictEqual(C.classify({ sector: 'Financial Services', ind: 'Public Sector Bank' }).category, 'banking');
  assert.strictEqual(C.classify({ sector: 'Financial Services', ind: 'Life Insurance' }).category, 'insurance');
  assert.strictEqual(C.classify({ sector: 'Financial Services', ind: 'Non Banking Financial Company (NBFC)' }).category, 'financials');
});

test('sector fallback and spelling variants', () => {
  assert.strictEqual(C.classify({ sector: 'Information Technology', ind: 'IT Enabled Services' }).category, 'it');
  const a = C.classify({ sector: 'Media, Entertainment & Publication', ind: 'Print Media' });
  const b = C.classify({ sector: 'Media Entertainment & Publication', ind: 'Print Media' });
  assert.strictEqual(a.category, 'media');
  assert.strictEqual(b.category, 'media');
  assert.strictEqual(a.sector, b.sector, 'one display spelling per sector');
  assert.strictEqual(C.classify({ sector: 'Oil, Gas & Consumable Fuels', ind: 'Coal' }).category, 'energy');
});

test('chemicals vs agri, capital goods vs packaging', () => {
  assert.strictEqual(C.classify({ sector: 'Chemicals', ind: 'Specialty Chemicals' }).category, 'chemicals');
  assert.strictEqual(C.classify({ sector: 'Chemicals', ind: 'Fertilizers' }).category, 'agri');
  assert.strictEqual(C.classify({ sector: 'Capital Goods', ind: 'Packaging' }).category, 'paper-packaging');
  assert.strictEqual(C.classify({ sector: 'Services', ind: 'Shipping' }).category, 'logistics');
});

test('missing data is unclassified, never guessed from the name', () => {
  const r = C.classify({ sector: null, ind: null, name: 'Infosys Technologies' });
  assert.strictEqual(r.category, null);
  assert.strictEqual(r.categoryName, 'Unclassified');
  assert.ok(r.issues.includes('missing sector'));
  // basic industry alone is enough when it is specific
  assert.strictEqual(C.classify({ sector: null, ind: 'RESIDENTIAL/COMMERCIAL/SEZ Project' }).category, 'realty');
});

test('tidy fixes all-caps NSE spellings', () => {
  assert.strictEqual(C.tidy('HOSPITAL'), 'Hospital');
  assert.strictEqual(C.tidy('HOTELS/RESORTS'), 'Hotels/Resorts');
  assert.strictEqual(C.tidy('  Iron & Steel  '), 'Iron & Steel');
});

test('review list flags missing and conflicting classifications', () => {
  const list = C.reviewList([
    { sym: 'A', sector: 'Healthcare', ind: 'Hospital' },
    { sym: 'B', sector: 'Healthcare', ind: 'Hospital' },
    { sym: 'C', sector: 'Consumer Services', ind: 'Hospital' },
    { sym: 'D', sector: null, ind: null }
  ]);
  const syms = list.map((x) => x.symbol).sort();
  assert.deepStrictEqual(syms, ['C', 'D']);
});

test('every category id is unique and every mapping target exists', () => {
  const ids = C.CATEGORIES.map((c) => c.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});
