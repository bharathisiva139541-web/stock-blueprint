'use strict';
// Results Edge (owner, 17-Nov-2026): which of the season's figures went with a rally after the results - entry = the reaction
// session's open (market-hours / before-market results: that day; after-market / closed: the next session), rally = +8% within
// 2 sessions (the high) OR the 10th session's close +10% - web/lib/edge.js.
const test = require('node:test');
const assert = require('node:assert');
const E = require('../web/lib/edge.js');

// a trading calendar (weekdays) from 2026-09-01
function days(n) {
  const out = [];
  let t = Date.UTC(2026, 8, 1);
  while (out.length < n) {
    const d = new Date(t), wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
    t += 864e5;
  }
  return out;
}
const DATES = days(70);
/** candles: flat at 100 until day `at`, then `path` (closes) from there; o = previous close + gap */
function chart(at, path, opt) {
  opt = opt || {};
  const bars = [];
  let c = 100;
  for (let i = 0; i < DATES.length; i++) {
    let o = c, h, l, nc;
    if (i < at) { nc = 100 + (opt.pre ? opt.pre * i / at : 0); o = c; } else {
      const k = i - at;
      nc = k < path.length ? path[k] : path[path.length - 1];
      if (k === 0 && opt.open) o = opt.open;
    }
    h = Math.max(o, nc) * (1 + (opt.wick || 0.005)); l = Math.min(o, nc) * 0.995;
    if (i >= at && opt.high && opt.high[i - at] != null) h = opt.high[i - at];
    bars.push([i, o, h, l, nc, opt.vol ? opt.vol(i) : 100000]);
    c = nc;
  }
  return bars;
}
function rp(sym, day, ann, extra) {
  return Object.assign({ Symbol: sym, Company: sym + ' Ltd', Quarter: 'Sep 2026', 'Result Date': day + ' 12:00', Announced: ann,
    'Rev QoQ %': 10, 'Rev YoY %': 20, 'NP QoQ %': 15, 'NP YoY %': 30, 'OPM QoQ': 'Increasing', 'OPM YoY': 'Stagnant', 'Results Verdict': 'Strong' }, extra || {});
}
function stock(sym, extra) {
  return Object.assign({ sym, name: sym + ' Ltd', sector: 'Capital Goods', mcap: 8000, price: 120, base: { price: 120 }, ttmEps: 5, epsg: 25,
    tgt: 150, ipe: 30, sig: 'Buy', fii: 'Increasing', promo: 'Stagnant', opmqy: 'Increasing' }, extra || {});
}

test('entry: market-hours / before-market results = that day\'s open; after-market / closed = the next session\'s open', () => {
  const at = 30, d = DATES[at];
  const H = { dates: DATES, bars: { MKT: chart(at, [101, 102]), AFT: chart(at, [101, 102]), RF: chart(at, [101, 102]) } };
  const perf = [rp('MKT', d, d.slice(8) + '/' + d.slice(5, 7) + ' 11:05 Market hours'), rp('AFT', d, '17:05 After market'),
    rp('RF', d, '', { 'Reaction From': 'after ' + d })];
  const ds = E.dataset({ perf, stocks: [stock('MKT'), stock('AFT'), stock('RF')], H });
  const by = Object.fromEntries(ds.rows.map((r) => [r.sym, r]));
  assert.strictEqual(by.MKT.entryDay, d);
  assert.strictEqual(by.AFT.entryDay, DATES[at + 1]);
  assert.strictEqual(by.RF.entryDay, DATES[at + 1], 'the sheet\'s Reaction From wins');
  assert.strictEqual(by.MKT.entry, H.bars.MKT[at][1], 'the open');
});

test('the rally: a pop of 8% within 2 sessions (the high), or the 10th close +10%; else no; too new = pending; not traded yet = upcoming', () => {
  const at = 40, d = DATES[at];
  const H = { dates: DATES, bars: {
    POP: chart(at, [100, 101, 99, 98, 98, 98, 98, 98, 98, 98], { high: [104, 109] }),   // high 109 on session 2 = +9%
    LATE: chart(at, [100, 101, 99, 98], { high: [104, 105, 112] }),                       // +12% only on session 3: not a pop
    TREND: chart(at, [101, 102, 103, 104, 105, 106, 107, 108, 109, 111]),                 // 10th close 111 = +11%
    NO: chart(at, [101, 102, 103, 104, 105, 106, 107, 108, 109, 109.5])
  } };
  const syms = Object.keys(H.bars);
  const ds = E.dataset({ perf: syms.map((s) => rp(s, d, 'Market hours')), stocks: syms.map((s) => stock(s)), H });
  const by = Object.fromEntries(ds.rows.map((r) => [r.sym, r]));
  assert.deepStrictEqual([by.POP.status, by.POP.kind], ['rally', 'pop']);
  assert.ok(Math.abs(by.POP.popMax - 9) < 1e-9, by.POP.popMax);
  assert.strictEqual(by.LATE.status, 'no', 'the 3rd session is outside the 2-session pop and the 10th close is down');
  assert.deepStrictEqual([by.TREND.status, by.TREND.kind], ['rally', 'trend']);
  assert.ok(Math.abs(by.TREND.ret - 11) < 1e-9);
  assert.strictEqual(by.NO.status, 'no');
  // other rules: +12% within 3 sessions makes LATE a pop; 'trend' only drops POP
  const r3 = Object.fromEntries(E.dataset({ perf: syms.map((s) => rp(s, d, 'Market hours')), stocks: syms.map((s) => stock(s)), H },
    { popDays: 3, popPct: 10 }).rows.map((r) => [r.sym, r.status]));
  assert.deepStrictEqual([r3.POP, r3.LATE], ['no', 'rally']);
  const rt = Object.fromEntries(E.dataset({ perf: syms.map((s) => rp(s, d, 'Market hours')), stocks: syms.map((s) => stock(s)), H },
    { rally: 'trend' }).rows.map((r) => [r.sym, r.status]));
  assert.deepStrictEqual([rt.POP, rt.TREND], ['no', 'rally']);
  // a quick jump 3 sessions in: still 'pending' until the whole 10-session window is over (else early results look better)
  const H3 = { dates: DATES, bars: { J: chart(65, [100, 109, 110]) } };
  const [j] = E.dataset({ perf: [rp('J', DATES[65], 'Market hours')], stocks: [stock('J')], H: H3 }).rows;
  assert.deepStrictEqual([j.status, j.early], ['pending', 'pop']);
  assert.strictEqual(E.dataset({ perf: [rp('J', DATES[65], 'Market hours')], stocks: [stock('J')], H: H3 }, { rally: 'pop' }).rows[0].status, 'rally',
    'with "quick jump only" the window is the 2 sessions');
  // a result 3 sessions before the newest candle: no pop yet -> pending; after the newest candle: upcoming (price now)
  const H2 = { dates: DATES, bars: { NEW: chart(66, [100, 101, 102, 101]), UP: chart(10, [100]) } };
  const ds2 = E.dataset({ perf: [rp('NEW', DATES[66], 'Market hours'), rp('UP', DATES[69], 'After market')], stocks: [stock('NEW'), stock('UP', { price: 130 })], H: H2 });
  const b2 = Object.fromEntries(ds2.rows.map((r) => [r.sym, r]));
  assert.strictEqual(b2.NEW.status, 'pending');
  assert.strictEqual(b2.UP.status, 'upcoming');
  assert.strictEqual(b2.UP.entry, null);
  assert.ok(Math.abs(b2.UP.f.pe - 130 / 5) < 1e-9, 'PE at the price now');
});

test('the features: valuation at the entry price, the move before, the gap, the flags, the market cap', () => {
  const at = 30, d = DATES[at];
  const H = { dates: DATES, bars: { ABC: chart(at, [118, 120], { pre: 10, open: 115 }) } };
  const tracker = [{ Symbol: 'ABC', 'Quarter Expected': 'Sep 2026', Flags: 'Profit growing faster than revenue (+80% vs +20%); Other income high: Rs 5 Cr = 30% of PBT' }];
  const s = stock('ABC', { price: 120, base: { price: 120 }, mcap: 24000, ttmEps: 4, epsg: 50, ipe: 23, tgt: 160 });
  const [r] = E.dataset({ perf: [rp('ABC', d, 'Before market')], tracker, flagsKnown: true, stocks: [s], H, sigAt: (st, p) => (st.tgt > p ? 'Buy' : 'Avoid') }).rows;
  assert.strictEqual(r.entry, 115);
  assert.ok(Math.abs(r.f.pe - 115 / 4) < 1e-9 && Math.abs(r.f.pevs - 115 / 4 / 23) < 1e-9 && Math.abs(r.f.peg - 115 / 4 / 50) < 1e-9);
  assert.ok(Math.abs(r.f.upside - (160 / 115 - 1) * 100) < 1e-9);
  assert.strictEqual(r.f.sig, 'Buy');
  assert.strictEqual(r.f.cap, 'Large cap', '24,000 Cr x 115 / 120 = 23,000 Cr');
  const prev = H.bars.ABC[at - 1][4];
  assert.ok(Math.abs(r.f.gap - (115 / prev - 1) * 100) < 1e-9);
  assert.strictEqual(r.f.sma20, 'Above', 'the closes BEFORE the entry rose');
  // the owner's 17-Nov-2026 list: these five are gone
  ['fii', 'promo', 'run20', 'fromHigh', 'sma50'].forEach((k) => {
    assert.strictEqual(r.f[k], undefined, k);
    assert.ok(!E.FEATURES.some((ft) => ft.id === k), k);
  });
  assert.deepStrictEqual([r.f.flagFaster, r.f.flagOi, r.f.flagExc, r.f.flagRevDown], ['Yes', 'Yes', 'No', 'No']);
  assert.deepStrictEqual([r.g.session, r.g.npY, r.g.verdict], ['Before market', 'b3', 'Strong']);
  // a copy without the tracker's Flags column: the flags are unknown, not 'No'
  const [r2] = E.dataset({ perf: [rp('ABC', d, 'Before market')], stocks: [s], H }).rows;
  assert.strictEqual(r2.g.flagFaster, undefined);
});

test('the analysis finds a planted edge: profit YoY over 100% + OPM Qtr YoY increasing rally far more often', () => {
  // 600 results over 30 days; a stock with NP YoY > 100% and OPM Qtr YoY Increasing rallies ~70%, the rest ~20%
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const perf = [], stocks = [], bars = {};
  for (let k = 0; k < 600; k++) {
    const sym = 'S' + k, at = 25 + (k % 30);
    const big = rnd() < 0.3, opm = rnd() < 0.5;
    const good = big && opm;
    const rally = rnd() < (good ? 0.7 : big || opm ? 0.25 : 0.18);
    const path = rally ? [101, 103, 105, 106, 107, 108, 109, 110, 111, 112] : [100, 99.5, 99, 100, 100.5, 101, 100, 99, 100, 101];
    bars[sym] = chart(at, path);
    perf.push(rp(sym, DATES[at], 'Market hours', { 'NP YoY %': big ? 150 : 5 + rnd() * 30, 'Rev YoY %': rnd() * 40 }));
    stocks.push(stock(sym, { opmqy: opm ? 'Increasing' : 'Decreasing', sector: rnd() < 0.5 ? 'IT' : 'Banks' }));
  }
  const ds = E.dataset({ perf, stocks, H: { dates: DATES, bars } });
  const A = E.analyse(ds);
  assert.strictEqual(A.finished, 600);
  assert.ok(A.base > 0.2 && A.base < 0.4, A.base);
  const top2 = A.features.slice(0, 2).map((f) => f.id).sort();
  assert.deepStrictEqual(top2, ['npY', 'opmqy'], A.features.slice(0, 4).map((f) => f.id + ' ' + f.strength.toFixed(3)).join(', '));
  const np = A.features.find((f) => f.id === 'npY');
  assert.ok(np.real && np.best && np.best.label === 'over 100%' && np.best.verdict === 'better', JSON.stringify(np.best));
  const sector = A.features.find((f) => f.id === 'sector');
  assert.ok(!sector.real, 'a random feature is not "real"');
  // the best combination = the planted pair, and it holds in the test part
  const c0 = A.combos[0];
  assert.ok(c0, 'combos');
  assert.deepStrictEqual(c0.conds.map((c) => c.f).slice(0, 2).sort(), ['npY', 'opmqy'], JSON.stringify(c0.label));
  assert.ok(c0.devRate > 0.55 && c0.held === 'yes', JSON.stringify(c0));
  // the score: trained on the first 2/3, judged on the rest - the top band rallies far more than the bottom one
  assert.ok(A.check && A.check.auc > 0.6, JSON.stringify(A.check));
  assert.ok(A.check.bands[0].rate > A.check.bands[4].rate + 0.25, JSON.stringify(A.check.bands));
  const good = A.rows.find((r) => r.f.npY === 150 && r.f.opmqy === 'Increasing');
  const bad = A.rows.find((r) => r.f.npY !== 150 && r.f.opmqy === 'Decreasing');
  // an additive model cannot reach the pair's 70% exactly (each part alone ~25%), but it ranks it far above the rest
  assert.ok(good.p > 0.4 && bad.p < 0.25 && good.p > A.base * 1.5, good.p + ' / ' + bad.p);
  assert.strictEqual(good.decision.id, 'buy');
  assert.ok(good.reasons.some((x) => /Net profit YoY %: over 100%/.test(x.label) && x.pts > 0), JSON.stringify(good.reasons));
  assert.ok(['avoid', 'neutral'].indexOf(bad.decision.id) >= 0, bad.decision.id);
});

test('no edge where there is none: random candles and figures give no "real" figure, a coin-toss score, no held combination', () => {
  let s = 11;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const D = days(75), bars = {}, perf = [], stocks = [];
  for (let k = 0; k < 1500; k++) {
    const sym = 'R' + k;
    let c = 100;
    bars[sym] = D.map((d, i) => {
      const o = c * (1 + (rnd() - 0.5) * 0.01);
      c = o * (1 + (rnd() - 0.5) * 0.12);
      return [i, o, Math.max(o, c) * (1 + rnd() * 0.01), Math.min(o, c) * (1 - rnd() * 0.01), c, 1e5 * (1 + rnd())];
    });
    perf.push(rp(sym, D[25 + (k % 45)], ['10:00 Market hours', '17:00 After market', '08:30 Before market'][k % 3],
      { 'NP YoY %': rnd() * 200 - 50, 'Rev YoY %': rnd() * 60 - 10, 'NP QoQ %': rnd() * 100 - 30, 'Rev QoQ %': rnd() * 30 - 10, 'Results Verdict': ['Strong', 'Mixed', 'Weak'][k % 3] }));
    stocks.push(stock(sym, { sector: ['IT', 'Banks', 'Auto', 'Pharma'][k % 4], mcap: rnd() * 50000, price: 100, base: { price: 100 }, ttmEps: 3, epsg: rnd() * 80 - 20,
      opmqy: ['Increasing', 'Decreasing', 'Stagnant'][k % 3] }));
  }
  const A = E.analyse(E.dataset({ perf, stocks, H: { dates: D, bars } }));
  assert.ok(A.finished > 1000 && A.base > 0.1, A.finished + ' ' + A.base);
  assert.deepStrictEqual(A.features.filter((f) => f.real).map((f) => f.id), []);
  assert.ok(A.check && A.check.verdict === 'weak' && Math.abs(A.check.auc - 0.5) < 0.08, JSON.stringify([A.check.auc, A.check.aucLo, A.check.verdict]));
  assert.ok(A.combos.filter((c) => c.held === 'yes').length <= 2, A.combos.map((c) => c.held).join(','));
});

test('the saved copy of the sheet: every Results Performance row gets an entry from its own candles', () => {
  global.window = {};
  require('../web/data/dashboard.js');
  require('../web/data/history.js');
  require('../web/data/history60.js');
  const D = global.window.SB_DATA;
  const H = require('../web/lib/history.js').merge(global.window.SB_HISTORY, global.window.SB_HISTORY60);
  const objRows = (t) => t.rows.map((r) => Object.fromEntries(t.cols.map((c, i) => [c, r[i]])));
  const stocks = objRows(D.main);
  const perf = objRows(D.resultsPerf.table);
  const ds = E.dataset({ perf, stocks, H });
  assert.ok(ds.rows.length >= 100, JSON.stringify(ds.skipped));
  const withEntry = ds.rows.filter((r) => r.entry != null), last = H.dates[H.dates.length - 1];
  assert.ok(withEntry.length >= 80, withEntry.length);
  withEntry.forEach((r) => assert.ok(r.entryDay >= r.rdate, r.sym + ' ' + r.entryDay + ' ' + r.rdate));
  // no entry = the reaction session comes after the newest candle of the copy
  ds.rows.filter((r) => r.entry == null).forEach((r) => assert.ok(r.reactDay >= last, r.sym + ' ' + r.reactDay + ' ' + last));
  const A = E.analyse(ds);
  assert.strictEqual(A.finished + A.pending + A.upcoming, ds.rows.length);
  delete global.window;
});

test('the gap-up study: only after-market / closed-day results, a win = the next open gapPct % over the close before, figures at that close', () => {
  const at = 30, d = DATES[at];
  const H = { dates: DATES, bars: {
    UP: chart(at + 1, [118, 119], { open: 105 }),         // after market: next open 105 vs 100 = +5%
    SMALL: chart(at + 1, [101, 101], { open: 102 }),      // +2%
    CLOSED: chart(at + 1, [110, 111], { open: 104 }),     // a closed-day filing (Reaction From 'after'): +4%
    MKT: chart(at, [110, 111], { open: 106 })             // market hours: not in the study
  } };
  const perf = [rp('UP', d, '17:05 After market'), rp('SMALL', d, '16:10 After market'), rp('CLOSED', d, '', { 'Reaction From': 'after ' + d }),
    rp('MKT', d, '11:00 Market hours'), rp('NEW', DATES[69], '18:00 After market')];
  const stocks = ['UP', 'SMALL', 'CLOSED', 'MKT'].map((s) => stock(s, { ttmEps: 4, tgt: 150 })).concat([stock('NEW', { price: 130, ttmEps: 4 })]);
  const ds = E.dataset({ perf, stocks, H: Object.assign({}, H, { bars: Object.assign({ NEW: chart(10, [100]) }, H.bars) }) }, { goal: 'gapup' });
  const by = Object.fromEntries(ds.rows.map((r) => [r.sym, r]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['CLOSED', 'NEW', 'SMALL', 'UP']);
  assert.strictEqual(ds.skipped.notAfter, 1, 'the market-hours result is left out');
  assert.deepStrictEqual([by.UP.status, by.SMALL.status, by.CLOSED.status, by.NEW.status], ['rally', 'no', 'rally', 'upcoming']);
  assert.ok(Math.abs(by.UP.openGap - 5) < 1e-9 && by.UP.prevClose === 100 && by.UP.entryDay === DATES[at + 1]);
  // the figures at the close before the open (the price known in the evening), never at the open itself
  assert.ok(Math.abs(by.UP.f.pe - 100 / 4) < 1e-9 && Math.abs(by.UP.f.upside - 50) < 1e-9, by.UP.f.pe + ' ' + by.UP.f.upside);
  assert.ok(Math.abs(by.NEW.f.pe - 130 / 4) < 1e-9, 'not opened yet: the price now');
  assert.strictEqual(by.UP.g.gap, undefined, 'the opening gap is the outcome - not a figure');
  assert.strictEqual(by.UP.g.session, undefined);
  assert.ok(by.UP.g.npY != null);
  // 5% needed: only UP
  const r5 = E.dataset({ perf, stocks, H }, { goal: 'gapup', gapPct: 5 }).rows.filter((r) => r.status === 'rally').map((r) => r.sym);
  assert.deepStrictEqual(r5, ['UP']);
  const A = E.analyse(ds);
  assert.ok(!A.features.some((f) => f.id === 'gap' || f.id === 'session'));
  assert.ok(Math.abs(A.avgGap - (5 + 2 + 4) / 3) < 1e-9, A.avgGap);
});

test('the gap-up study finds a planted edge, and the whole-season view finds it without the earlier / later split', () => {
  let seed = 5;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const perf = [], stocks = [], bars = {};
  for (let k = 0; k < 600; k++) {
    const sym = 'G' + k, at = 25 + (k % 30);
    const big = rnd() < 0.3;
    const up = rnd() < (big ? 0.65 : 0.15);
    bars[sym] = chart(at + 1, [101, 102], { open: up ? 104 + rnd() * 4 : 99 + rnd() * 2.5 });
    perf.push(rp(sym, DATES[at], '17:30 After market', { 'NP YoY %': big ? 150 : 5 + rnd() * 30 }));
    stocks.push(stock(sym, { sector: rnd() < 0.5 ? 'IT' : 'Banks' }));
  }
  const ds = E.dataset({ perf, stocks, H: { dates: DATES, bars } }, { goal: 'gapup' });
  const A = E.analyse(ds);
  assert.strictEqual(A.finished, 600);
  assert.strictEqual(A.features[0].id, 'npY');
  assert.ok(A.features[0].real && A.features[0].best.label === 'over 100%', JSON.stringify(A.features[0].best));
  const big = A.rows.find((r) => r.f.npY === 150);
  assert.ok(big.p > A.base * 1.5 && big.decision.id === 'buy', big.p + ' ' + A.base);
  // the whole season as one part: no earlier / later numbers, the same figure found
  const W = E.analyse(ds, { goal: 'gapup', view: 'whole' });
  assert.strictEqual(W.features[0].id, 'npY');
  assert.ok(W.features[0].real);
  W.features[0].groups.forEach((g) => { assert.strictEqual(g.dev.n, 0); assert.strictEqual(g.held, ''); });
  assert.ok(W.combos.length && W.combos.every((c) => c.testN === 0 && c.devN >= 25), JSON.stringify(W.combos[0]));
  assert.ok(W.combos.some((c) => c.held === 'yes' && c.conds.some((x) => x.f === 'npY')), W.combos.map((c) => c.label.join('+') + ' ' + c.held).join(' | '));
  assert.ok(W.check, 'the score check still learns on the earlier part');
});

test('the whole-season view on random data: no "real" figure, no combination beyond luck', () => {
  let s = 23;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const D = days(75), bars = {}, perf = [], stocks = [];
  for (let k = 0; k < 1500; k++) {
    const sym = 'W' + k;
    let c = 100;
    bars[sym] = D.map((d, i) => {
      const o = c * (1 + (rnd() - 0.5) * 0.06);
      c = o * (1 + (rnd() - 0.5) * 0.1);
      return [i, o, Math.max(o, c) * (1 + rnd() * 0.01), Math.min(o, c) * (1 - rnd() * 0.01), c, 1e5 * (1 + rnd())];
    });
    perf.push(rp(sym, D[25 + (k % 45)], ['10:00 Market hours', '17:00 After market', '08:30 Before market'][k % 3],
      { 'NP YoY %': rnd() * 200 - 50, 'Rev YoY %': rnd() * 60 - 10, 'NP QoQ %': rnd() * 100 - 30, 'Rev QoQ %': rnd() * 30 - 10, 'Results Verdict': ['Strong', 'Mixed', 'Weak'][k % 3] }));
    stocks.push(stock(sym, { sector: ['IT', 'Banks', 'Auto', 'Pharma'][k % 4], mcap: rnd() * 50000, price: 100, base: { price: 100 }, ttmEps: 3, epsg: rnd() * 80 - 20,
      opmqy: ['Increasing', 'Decreasing', 'Stagnant'][k % 3] }));
  }
  [{ view: 'whole' }, { view: 'whole', goal: 'gapup', gapPct: 2 }].forEach((o) => {
    const A = E.analyse(E.dataset({ perf, stocks, H: { dates: D, bars } }, o), o);
    assert.ok(A.finished > 400 && A.base > 0.05, JSON.stringify(o) + ' ' + A.finished + ' ' + A.base);
    assert.ok(A.features.filter((f) => f.real).length <= 1, JSON.stringify(o) + ' ' + A.features.filter((f) => f.real).map((f) => f.id));
    assert.deepStrictEqual(A.combos.filter((c) => c.held === 'yes').map((c) => c.label.join(' + ')), [], JSON.stringify(o));
  });
});
