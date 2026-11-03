'use strict';
// Result Performance Strategy (owner, 03-Nov-2026): "filtering stocks that posted their quarterly results after market
// hours or market closed time (Sunday, Saturday, holidays) - the market has not reacted to them yet - then by OPM QoQ,
// OPM YoY, OPM Qtr YoY, result date (yesterday, n days before), FII, EPS growth". Preset 'resultPerformance' (a screen),
// rule 'resultAnnounced' on stock.rp (the Results Performance row: Announced + Result Date); multi-value text filters.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const S = require('../web/lib/strategy.js');

const P = S.PRESETS.resultPerformance;
const GOOD = { price: 295.8, opmq: 'Increasing', opmy: 'Stagnant', opmqy: 'Aggressive Increase', fii: 'Increasing', epsg: 37 };
function stock(sym, rp, extra) { return Object.assign({ sym: sym }, GOOD, { rp: rp }, extra || {}); }
const run = (stocks, refDate) => S.run(P, stocks, {}, { refDate: refDate || '2026-11-03' });

test('the preset: a valid screen with the owner\'s six rules', () => {
  const v = S.validate(P);
  assert.deepStrictEqual([v.ok, v.config.mode], [true, 'screen']);
  assert.deepStrictEqual(v.config.confirms.map((r) => r.id + (r.params.field ? ':' + r.params.field : '')),
    ['resultAnnounced', 'fieldIn:opmq', 'fieldIn:opmy', 'fieldIn:opmqy', 'fieldIn:fii', 'fieldRange:epsg']);
  assert.strictEqual(S.label(v.config.confirms[0]), 'Results announced After market / Market closed, result date at most 1 trading day(s) before today');
  assert.ok(S.CONDITIONS.fieldIn.params[0].options.indexOf('opmqy') >= 0, 'OPM Qtr YoY is a field the screens can use');
});

test('after market / market closed, result date yesterday (Friday or the weekend counts as 1 on Monday)', () => {
  const r = run([
    stock('VRLLOG', { resultDate: '2026-11-02', announced: '02/11 16:25 After market' }),               // Mon after the close, seen Tue
    stock('INHOURS', { resultDate: '2026-11-02', announced: '02/11 11:20 Market hours' }),              // the market reacted that day
    stock('OLD', { resultDate: '2026-10-29', announced: '29/10 17:05 After market' }),                  // 3 trading days ago
    stock('NOTIME', { resultDate: '2026-11-02', announced: '' }),
    stock('NORP', null)
  ]);
  const st = (s) => r.bySym[s].status;
  assert.deepStrictEqual(['VRLLOG', 'INHOURS', 'OLD', 'NOTIME', 'NORP'].map(st), ['qualified', 'none', 'none', 'none', 'none']);
  assert.match(r.bySym.VRLLOG.checks[0].res.detail, /announced 02\/11 16:25 After market · result date 2026-11-02 \(1 trading day ago\)/);
  assert.match(r.bySym.NOTIME.checks[0].res.detail, /no NSE filing time/);
  assert.match(r.bySym.NORP.checks[0].res.detail, /no Results Performance record/);
  // Friday after market and a Sunday filing, looked at on Monday; on Tuesday the Sunday one has had its reaction day
  const mon = run([stock('FRI', { resultDate: '2026-10-30', announced: '30/10 18:10 After market' }),
    stock('SUN', { resultDate: '2026-11-01', announced: '01/11 11:00 Market closed' })], '2026-11-02');
  assert.deepStrictEqual([mon.bySym.FRI.status, mon.bySym.SUN.status], ['qualified', 'qualified']);
  assert.strictEqual(run([stock('SUN', { resultDate: '2026-11-01', announced: '01/11 11:00 Market closed' })], '2026-11-03').bySym.SUN.status, 'none');
  // the owner widens it to 3 trading days
  const cfg = S.clone(P);
  cfg.confirms[0].params.days = 3;
  assert.strictEqual(S.run(cfg, [stock('OLD', { resultDate: '2026-10-29', announced: '29/10 17:05 After market' })], {}, { refDate: '2026-11-03' }).bySym.OLD.status, 'qualified');
});

test('then OPM QoQ, OPM YoY, OPM Qtr YoY, FII and EPS growth', () => {
  const rp = { resultDate: '2026-11-02', announced: '02/11 16:25 After market' };
  const r = run([stock('OK', rp), stock('OPMDOWN', rp, { opmq: 'Decreasing' }), stock('QYOYDOWN', rp, { opmqy: 'Slightly Decreasing' }),
    stock('FIIOUT', rp, { fii: 'Decreasing' }), stock('EPSNEG', rp, { epsg: -5 }), stock('NOQY', rp, { opmqy: null })]);
  assert.deepStrictEqual(['OK', 'OPMDOWN', 'QYOYDOWN', 'FIIOUT', 'EPSNEG', 'NOQY'].map((s) => r.bySym[s].status), ['qualified', 'none', 'none', 'none', 'none', 'none']);
  assert.strictEqual(r.bySym.OK.statusLabel, 'Matches screen');
  assert.match(r.bySym.QYOYDOWN.failed.join(' '), /OPM Qtr YoY = Slightly Decreasing/);
});

test('rpIndex carries Announced and Reaction From of the latest row', () => {
  const ix = S.rpIndex({ cols: ['Symbol', 'Quarter', 'Result Date', 'Announced', 'Reaction From'],
    rows: [['VRLLOG', 'Jun 2026', '2026-08-01', '01/08 16:00 After market', 'after 2026-08-01'], ['VRLLOG', 'Sep 2026', '2026-11-02', '02/11 16:25 After market', 'after 2026-11-02']] });
  assert.deepStrictEqual([ix.VRLLOG.announced, ix.VRLLOG.reactFrom, ix.VRLLOG.quarter], ['02/11 16:25 After market', 'after 2026-11-02', 'Sep 2026']);
  assert.deepStrictEqual([S.weekdaysAfter('2026-11-02', '2026-11-03'), S.weekdaysAfter('2026-10-31', '2026-11-02'), S.weekdaysAfter('2026-11-05', '2026-11-03')], [1, 1, -1]);
});

/** ui.Table in a sandbox (no DOM needed for test / summary). */
function loadUi() {
  const ctx = { window: {}, console, document: { addEventListener: () => {}, querySelector: () => null }, location: { hash: '#results' } };
  ctx.window.document = ctx.document;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'ui', 'core.js'), 'utf8'), ctx);
  return ctx.window.SB.ui;
}

test('table filter: several values with a comma between = any of them (owner: Announced "after, closed")', () => {
  const ui = loadUi();
  const t = new ui.Table({ columns: [{ key: 'Symbol', label: 'Stock' }, { key: 'Announced', label: 'Announced' }],
    rows: [{ Symbol: 'A', Announced: '02/11 16:25 After market' }, { Symbol: 'B', Announced: '01/11 11:00 Market closed' },
      { Symbol: 'C', Announced: '02/11 11:20 Market hours' }, { Symbol: 'D', Announced: '' }] });
  const syms = () => t.filtered().map((r) => r.Symbol).join(',');
  t.filters = [{ key: 'Announced', op: 'contains', a: 'after, closed', b: '' }];
  assert.strictEqual(syms(), 'A,B');
  assert.match(t.summary().text, /Announced contains after or closed/);
  t.filters = [{ key: 'Announced', op: 'contains', a: 'after', b: '' }];
  assert.strictEqual(syms(), 'A', 'one value as before');
  t.filters = [{ key: 'Announced', op: 'isnot', a: '02/11 16:25 After market, 01/11 11:00 Market closed', b: '' }];
  assert.strictEqual(syms(), 'C', 'is not = none of them (a blank cell never matches a typed value)');
  t.filters = [{ key: 'Announced', op: 'is', a: '01/11 11:00 Market closed ,02/11 11:20 Market hours', b: '' }];
  assert.strictEqual(syms(), 'B,C');
});
