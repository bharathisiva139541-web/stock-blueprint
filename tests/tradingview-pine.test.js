'use strict';
// The TradingView indicator (tradingview/StockBlueprint_CHoCH_FVG.pine; owner, 11-Nov-2026: "i open trading view chart and
// i go to that trade date. i check how our backtest enter the trade, how our backtest where it is marked Choch, FVG ... it
// would be helpful if i got pinescript indicator"): its bar-by-bar logic (tradingview/pine_model.py) finds exactly what
// the laptop's backtest finds (structure.py CHoCH events, kite_intraday zones + first touches, the Lab's discount rule) on
// random and made charts; the .pine's defaults = the Lab's; Pine v5 layout checks. Offline: tests/fixtures/tradingview_pine_check.py.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const py = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);

test('TradingView indicator = the laptop backtest (python, offline)', { skip: !py && 'python3 not installed' }, () => {
  const r = spawnSync(py, [path.join(__dirname, 'fixtures', 'tradingview_pine_check.py')], { encoding: 'utf8', timeout: 240000 });
  assert.strictEqual(r.status, 0, (r.stdout || '').slice(-1500) + (r.stderr || '').slice(-1500));
  assert.ok(/(^|\n)OK\s*$/.test(r.stdout), r.stdout.slice(-500));
});

// The Backtest Lab page's "Copy TradingView script" (owner, 11-Nov-2026: "give option to copy the pinescript in this page
// that works with respect to the current setup"): web/lib/pine.js writes the form's rules into the script's inputs.
const fs = require('fs');
const os = require('os');
const BP = require('../tools/build_pine.js');
const PINE = require('../web/lib/pine.js');

test('web/data/pine-template.js = tradingview/StockBlueprint_CHoCH_FVG.pine (run `npm run pine` after changing the script)', () => {
  assert.strictEqual(fs.readFileSync(BP.OUT, 'utf8'), BP.render(fs.readFileSync(BP.SRC, 'utf8')));
});

/** The inputs' default values of a script -> the Lab's own params (the reverse of SB.pine.inputs). */
function readBack(src) {
  const get = (name) => {
    const m = new RegExp('^' + name + ' = input\\.\\w+\\(("[^"]*"|timestamp\\("[^"]*"\\)|[^,]+),', 'm').exec(src);
    assert.ok(m, 'input ' + name);
    return m[1].replace(/^"|"$/g, '');
  };
  const inv = (map, v) => Object.keys(map).find((k) => map[k] === v);
  const iso = (t) => { const m = /timestamp\("(\d{2}) (\w{3}) (\d{4}) 00:00 \+0530"\)/.exec(t); return m ? m[3] + '-' + String(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(m[2]) + 1).padStart(2, '0') + '-' + m[1] : null; };
  const out = {
    structure: get('structOnly') === 'true' ? 'only' : 'off', pivotN: Number(get('pivN')), downN: Number(get('downN')),
    zoneWhen: inv({ both: 'In the CHoCH move or after it', leg: 'Only in the CHoCH move', after: 'Only after the CHoCH candle' }, get('zoneWhen')),
    chochAge: Number(get('chochAge')), discount: Number(get('fibLvl')), discPart: inv({ mid: 'Middle', top: 'Top', bottom: 'Bottom' }, get('discPart')),
    firstPull: get('firstPull') === 'true', belowChoch: get('belowChoch') === 'true',
    entry: get('entryMode') === 'Order at the zone top' ? 'zone' : 'close',
    stop: inv({ zone: 'Under the zone bottom', spring: "Under the touch candle's low", lower: 'Under whichever is lower', pct: '% under the entry' }, get('stopMode')),
    stopBuf: Number(get('stopBuf')), stopPct: Number(get('stopPct')), maxRisk: Number(get('maxRisk')), minPrice: Number(get('minPrice')),
    targetMode: get('targetMode') === 'R multiple' ? 'R' : 'swing', targetR: Number(get('targetR')), swingMinR: Number(get('swingMinR')),
    minTurnover: Number(get('minTurn')), emaSupport: Number(inv({ 0: 'Off', 10: '10 EMA', 21: '21 EMA', 50: '50 EMA', 1: 'Any of 10 / 21 / 50' }, get('emaSup'))),
    emaTouch: Number(get('emaTouch')), above10: get('ab10') === 'true', above21: get('ab21') === 'true', above50: get('ab50') === 'true', emaStack: get('emaStack') === 'true'
  };
  if (get('useDates') === 'true') { out.from = iso(get('fromDate')); out.to = iso(get('toDate')); }
  // the discount level must be one of the input's options (Pine refuses the script otherwise)
  const opts = /^fibLvl = input\.float\([^\n]*options=\[([^\]]*)\]/m.exec(src)[1].split(',').map(Number);
  assert.ok(opts.includes(out.discount), 'fibLvl ' + out.discount + ' in ' + opts);
  return out;
}

test('the Lab form -> the TradingView script: every rule lands in its input, the script stays valid Pine', { skip: !py && 'python3 not installed' }, () => {
  const src = BP.render(fs.readFileSync(BP.SRC, 'utf8'));
  const w = {}; new Function('window', src)(w);
  const base = { structure: 'only', pivotN: 5, downN: 3, zoneWhen: 'both', chochAge: 0, discount: 0.5, discPart: 'mid', firstPull: true, belowChoch: false,
    entry: 'zone', stop: 'zone', stopBuf: 0.5, stopPct: 5, maxRisk: 15, minPrice: 0, targetMode: 'R', targetR: 2, swingMinR: 1, minTurnover: 0,
    emaSupport: 0, emaTouch: 1, above10: false, above21: false, above50: false, emaStack: false };
  const sets = [base,
    Object.assign({}, base, { pivotN: 8, downN: 4, discount: 0.382, targetR: 2.5, from: '2020-01-01', to: '2026-11-11' }),       // the owner's screenshot
    Object.assign({}, base, { structure: 'off', zoneWhen: 'leg', chochAge: 40, discount: 0.55, discPart: 'top', firstPull: false, belowChoch: true, entry: 'close',
      stop: 'pct', stopPct: 4, maxRisk: 0, minPrice: 50, targetMode: 'swing', swingMinR: 1.5, minTurnover: 120, emaSupport: 1, emaTouch: 2, above50: true, emaStack: true }),
    Object.assign({}, base, { entry: 'close', stop: 'lower', stopBuf: 1.25, emaSupport: 21, above10: true, above21: true, from: '2015-03-09' })];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pine-'));
  const files = sets.map((p, k) => {
    const code = PINE.build(p, { src: w.SB_PINE_SRC, name: 'Test "' + k + '"\nidea', plain: 'Rules in words.\nNext line', when: '11 Nov 2026' });
    const back = readBack(code);
    const want = Object.assign({}, p);
    if (want.from && !want.to) want.to = '2030-12-31';               // only a start: the script's own end stays
    assert.deepStrictEqual(back, want, 'set ' + k);
    assert.match(code.split('\n')[0], /^\/\/@version=5$/);
    assert.match(code, /^\/\/ Test "\d" idea - copied 11 Nov 2026$/m, 'the name in the header, on one line');
    assert.match(code, /^\/\/ Rules in words\. Next line$/m, 'the rules in words, on comment lines');
    const f = path.join(dir, 'set' + k + '.pine');
    fs.writeFileSync(f, code);
    return f;
  });
  const r = spawnSync(py, [path.join(__dirname, 'fixtures', 'tradingview_pine_check.py'), '--lint'].concat(files), { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  // what the script cannot draw is said
  const n = PINE.notes({ tf: '4H', group: 'fvg', entry: 'next_open', mktIndex: 'NIFTY_50', mktAbove: 50, upWickMax: 5 });
  assert.match(n.join(' '), /4 hour \(240\)/);
  assert.match(n.join(' '), /your Pattern is a different one/);
  assert.match(n.join(' '), /next candle's open/);
  assert.match(n.join(' '), /market condition \(NIFTY 50\)/);
  assert.match(n.join(' '), /Spring shape rules/);
  assert.strictEqual(PINE.notes({ tf: 'D', group: 'touch', entry: 'zone' }).length, 2, 'the timeframe + "only entry / stop / target"');
  // the structure engine options / filters of 12-Nov-2026 are said, not drawn
  const n2 = PINE.notes({ tf: 'D', group: 'touch', entry: 'zone', swingMode: 'zigzag', chochMode: 'protected', lagMin: 10, wkAbove: 21, sweep: true }).join(' ');
  assert.match(n2, /not ZigZag swings, the protected-high CHoCH/);
  assert.match(n2, /Not drawn \(check them on the chart yourself\): the days after the CHoCH, the sweep of the low, the weekly trend\./);
});
