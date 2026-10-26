'use strict';
// Industry & sector intelligence: master integrity, Code.gs parity, company mapping,
// search, filters, cap buckets, aggregation methodology, build / import tool.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const IND = require('../web/lib/industry.js');
const METRICS = require('../web/lib/industry-metrics.js');
const tool = require('../tools/build_industry_data.js');

const master = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'classification', 'nse-industry-classification.json'), 'utf8'));
const flat = tool.flatten(master);
const I = IND.createIndex(flat);

function loadDash() {
  const f = path.join(__dirname, '..', 'web', 'data', 'dashboard.js');
  if (!fs.existsSync(f)) return null;
  const w = {}; new Function('window', fs.readFileSync(f, 'utf8'))(w);
  const m = w.SB_DATA.main;
  return m.rows.map((r) => { const o = {}; m.cols.forEach((c, i) => { o[c] = r[i]; }); o.raw = { sector: o.sector, industry: o.industry, ind: o.ind }; return o; });
}
const STOCKS = loadDash();

test('the master holds the full four-level NSE structure with unique stable ids', () => {
  assert.deepStrictEqual(I.counts, { macro: 12, sector: 22, industry: 59, basic: 197 });
  const ids = Object.keys(I.byId);
  assert.strictEqual(ids.length, 290);
  I.basics.forEach((b) => {
    const p = I.path(b.id);
    assert.strictEqual(p.length, 4, b.id);
    assert.deepStrictEqual(p.map((n) => n.level), ['macro', 'sector', 'industry', 'basic']);
    assert.strictEqual(I.resolve('basic', IND.slugOf(b.id)), b.id);
  });
  ['macro', 'sector', 'industry', 'basic'].forEach((lv) => {
    const names = (lv === 'macro' ? I.macros : lv === 'sector' ? I.sectors : lv === 'industry' ? I.industries : I.basics).map((n) => IND.key(n.name));
    assert.strictEqual(new Set(names).size, names.length, lv + ' names unique');
  });
  assert.ok(master.version && master.source && master.verification, 'version, source and verification recorded');
});

test('the master equals Code.gs AB_NSE_TAXONOMY (the sheet audit uses the same list)', () => {
  const T = tool.codeGsTaxonomy();
  const code = new Set(); T.forEach((r) => r[2].forEach((b) => code.add([r[0], r[1], b].map(IND.key).join('|'))));
  const mine = new Set(I.basics.map((b) => I.path(b.id).slice(1).map((n) => IND.key(n.name)).join('|')));
  assert.deepStrictEqual([...code].filter((k) => !mine.has(k)), []);
  assert.deepStrictEqual([...mine].filter((k) => !code.has(k)), []);
});

test('company mapping statuses', () => {
  const v = IND.classifyStock(I, { sym: 'X', raw: { sector: 'Financial Services', industry: 'Banks', ind: 'Public Sector Bank' } });
  assert.strictEqual(v.status, 'verified');
  assert.strictEqual(v.basicId, 'b-public-sector-bank');
  assert.deepStrictEqual(I.crumbs(v.basicId), ['Financial Services', 'Financial Services', 'Banks', 'Public Sector Bank']);
  // punctuation / case differences are not conflicts
  assert.strictEqual(IND.classifyStock(I, { raw: { sector: 'Oil Gas & Consumable Fuels', industry: 'petroleum products', ind: 'LUBRICANTS' } }).status, 'verified');
  const c = IND.classifyStock(I, { raw: { sector: 'Capital Goods', industry: 'Banks', ind: 'Public Sector Bank' } });
  assert.strictEqual(c.status, 'conflicting');
  assert.strictEqual(c.basicId, 'b-public-sector-bank', 'official parents are used, the conflict is reported');
  assert.ok(/official parents/.test(c.note));
  const p = IND.classifyStock(I, { raw: { sector: 'Realty', industry: 'Realty', ind: 'RESIDENTIAL/COMMERCIAL/SEZ Project' } });
  assert.strictEqual(p.status, 'pending');
  assert.strictEqual(p.basicId, null);
  assert.strictEqual(p.industryId, 'i-realty', 'still placed under its official industry');
  assert.strictEqual(IND.classifyStock(I, { raw: {} }).status, 'unclassified');
});

test('the real watchlist maps onto the hierarchy', { skip: !STOCKS && 'no web/data/dashboard.js' }, () => {
  const map = IND.mapStocks(I, STOCKS);
  const total = Object.values(map.counts).reduce((a, b) => a + b, 0);
  assert.strictEqual(total, STOCKS.length);
  assert.ok(map.counts.verified > 1700, JSON.stringify(map.counts));
  assert.ok(map.basicsWithStocks > 150);
  const banks = map.byNode('i-banks');
  assert.ok(banks.length > 20 && banks.every((s) => /bank/i.test(map.bySym[s].sheet.basic)), 'every stock under Banks is a bank');
  // byNode of a macro = union of its basic industries
  const fin = map.byNode('m-financial-services');
  const viaBasics = I.basicsUnder('m-financial-services').reduce((a, b) => a + (map.byBasic[b] || []).length, 0);
  assert.strictEqual(fin.length, viaBasics);
});

test('cap buckets come from Nifty index membership', () => {
  assert.strictEqual(IND.capBucket({ idx: 'NIFTY50' }).key, 'large');
  assert.strictEqual(IND.capBucket({ idx: 'NIFTYNEXT50' }).key, 'large');
  assert.strictEqual(IND.capBucket({ idx: 'NIFTYMIDCAP50' }).key, 'mid');
  assert.strictEqual(IND.capBucket({ idx: 'MIDCAPNEXT100' }).key, 'mid');
  assert.strictEqual(IND.capBucket({ idx: 'SMALLCAP51-250' }).key, 'small');
  assert.strictEqual(IND.capBucket({ idx: 'MICROCAP250' }).key, 'micro');
  assert.strictEqual(IND.capBucket({ idx: 'NIFTY SME' }).key, 'sme');
  assert.strictEqual(IND.capBucket({ idx: 'NIFTY IPO' }).key, 'other');
  assert.strictEqual(IND.capBucket({}).key, 'other');
});

test('search: levels, companies, symbols, partial words, typos, breadcrumbs', () => {
  const stocks = [{ sym: 'SBIN', name: 'State Bank of India', raw: { sector: 'Financial Services', industry: 'Banks', ind: 'Public Sector Bank' } },
    { sym: 'TCS', name: 'Tata Consultancy Services Ltd.', raw: { sector: 'Information Technology', industry: 'IT - Software', ind: 'Computers - Software & Consulting' } }];
  const map = IND.mapStocks(I, stocks);
  const S = IND.searchIndex(I, stocks, map);
  const top = (q) => IND.search(S, q)[0] || {};
  assert.strictEqual(top('Computers - Software & Consulting').id, 'b-computers-software-and-consulting');
  assert.deepStrictEqual(top('computers software').crumbs, ['Information Technology', 'Information Technology', 'IT - Software', 'Computers - Software & Consulting']);
  const cement = IND.search(S, 'cement').map((r) => r.id);
  assert.deepStrictEqual(cement.slice(0, 2), ['b-cement-and-cement-products', 'i-cement-and-cement-products'], 'basic industry first, its same-named industry next');
  assert.strictEqual(top('SBIN').sym, 'SBIN');
  assert.strictEqual(top('sbin').route, '#industries/basic/public-sector-bank');
  assert.strictEqual(top('state bank').sym, 'SBIN');
  assert.strictEqual(top('pharmaceuticls').id, 'b-pharmaceuticals', 'one missing letter');
  assert.strictEqual(top('fertilisers').id, 'b-fertilizers', 'British spelling');
  assert.ok(IND.search(S, 'fin').some((r) => r.type === 'macro' && r.id === 'm-financial-services'), 'prefix');
  assert.deepStrictEqual(IND.search(S, '   '), []);
  assert.ok(IND.search(S, 'bank', { types: ['basic'] }).every((r) => r.type === 'basic'));
});

test('filters combine (AND) and empty values mean any', () => {
  const rows = [{ sym: 'A', macroId: 'm1', sectorId: 's1', status: 'verified', cap: 'large', exchange: 'NSE' },
    { sym: 'B', macroId: 'm1', sectorId: 's2', status: 'pending', cap: 'small', exchange: 'NSE' },
    { sym: 'C', macroId: 'm2', sectorId: 's3', status: 'verified', cap: 'small', exchange: 'NSE' }];
  assert.deepStrictEqual(IND.filterRows(rows, { macroId: 'm1' }).map((r) => r.sym), ['A', 'B']);
  assert.deepStrictEqual(IND.filterRows(rows, { macroId: 'm1', cap: 'small' }).map((r) => r.sym), ['B']);
  assert.deepStrictEqual(IND.filterRows(rows, { status: 'verified', cap: 'small' }).map((r) => r.sym), ['C']);
  assert.strictEqual(IND.filterRows(rows, { macroId: '', cap: '' }).length, 3);
});

test('aggregation: equal-weighted median, breadth, leaders, and no ranking on too few stocks', () => {
  const a = IND.aggregate([{ sym: 'A', value: 5 }, { sym: 'B', value: -1 }, { sym: 'C', value: 1 }, { sym: 'D', value: null }]);
  assert.strictEqual(a.n, 4); assert.strictEqual(a.withData, 3);
  assert.strictEqual(a.median, 1); assert.strictEqual(a.adv, 2); assert.strictEqual(a.dec, 1);
  assert.ok(Math.abs(a.breadthPct - 66.666) < 0.01);
  assert.strictEqual(a.leaders[0].sym, 'A'); assert.strictEqual(a.laggards[0].sym, 'B');
  assert.strictEqual(a.ranked, true);
  const one = IND.aggregate([{ sym: 'X', value: 40 }, { sym: 'Y', value: null }]);
  assert.strictEqual(one.ranked, false, 'one big mover does not make an industry strong');
  // period returns use closes N sessions apart; too-short history is unavailable
  const c = Array.from({ length: 30 }, (_, i) => ({ t: 'd' + i, c: 100 + i, v: 1000 }));
  assert.ok(Math.abs(IND.periodReturn({}, c, '1W').value - (129 / 124 - 1) * 100) < 1e-9);
  assert.ok(Math.abs(IND.periodReturn({}, c, '1M').value - (129 / 108 - 1) * 100) < 1e-9);
  assert.strictEqual(IND.periodReturn({}, c, '3M'), null);
  assert.strictEqual(IND.periodReturn({ chg: 1.5 }, c, '1D').value, 1.5);
  assert.strictEqual(IND.periodReturn({ chg: null }, c, '1D'), null);
  assert.strictEqual(IND.volumeTrend(c), 0);
});

test('metric sets: every KPI and field exists; financials hide operating margin', () => {
  Object.keys(METRICS.SETS).forEach((id) => {
    const s = METRICS.SETS[id];
    s.kpis.forEach((k) => assert.ok(METRICS.KPIS[k], id + ' kpi ' + k));
    s.fields.forEach((f) => assert.ok(METRICS.FIELDS[f], id + ' field ' + f));
  });
  assert.ok(!METRICS.compareColumns('bank').some((c) => c.key === 'opmq'), 'banks: no OPM comparison');
  assert.ok(METRICS.compareColumns('cement').some((c) => c.key === 'opmq'));
});

test('build tool: CSV import keeps ids, reports changes, never touches the master', () => {
  const csv = 'Macro,Sector,Industry,Basic\n' + I.basics.map((b) => I.crumbs(b.id).map((x) => '"' + x.replace(/"/g, '""') + '"').join(',')).join('\n') + '\n';
  const rows = tool.parseCsv(csv);
  assert.strictEqual(rows.length, 198);
  const prevFlat = flat;
  const rep = tool.diffEntities(prevFlat, flat);
  assert.strictEqual(rep.unchanged, 290);
  const changed = JSON.parse(JSON.stringify(flat));
  changed.basics[0].name = 'Commodity Chemicals (renamed)';
  changed.basics.pop();
  const rep2 = tool.diffEntities(flat, changed);
  assert.strictEqual(rep2.renamed.length, 1);
  assert.strictEqual(rep2.removed.length, 1);
});
