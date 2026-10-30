'use strict';
// 29/30-Oct-2026: Phase 1, 2 and 3 all ran out of Google's 6 minutes and the EOD email did not go.
// The FVG watch-list scans (and the FVG column) converted the same few dozen days for every stock -
// ~220,000 Utilities.formatDate / parseDate calls on 1,800 stocks since the History60 merge - and
// every phase retried the unfinished scans first. Checks: day conversions stay a handful, the
// Pattern / FVG columns are one write each, unfinished scans are not retried the same day, and
// Phase 3 does not wait for a Phase 2 that Google stopped.
const test = require('node:test');
const assert = require('node:assert/strict');
const mock = require('./fixtures/apps-script-mock');

const NOW = Date.parse('2026-10-30T13:30:00Z');            // 30-Oct-2026 19:00 IST
const NSYM = 400, D30 = 30, D60 = 60;

function workbook() {
  let seed = 9;
  const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const days = [];
  for (let t = Date.UTC(2026, 6, 1); days.length < D60; t += 86400000) { const d = new Date(t); if (d.getUTCDay() % 6) days.push(d.toISOString().slice(0, 10)); }
  const syms = [];
  for (let i = 0; i < NSYM; i++) syms.push('S' + i + 'X');
  const bars = {};
  syms.forEach((s) => {
    let p = 50 + r() * 500;
    bars[s] = days.map((d) => {
      const o = p * (1 + (r() - 0.5) * 0.02 + (r() < 0.04 ? 0.06 : 0)), c = o * (1 + (r() - 0.5) * 0.05);
      const h = Math.max(o, c) * (1 + r() * 0.01), l = Math.min(o, c) * (1 - r() * 0.01), prev = p;
      p = c;
      return [d, +o.toFixed(2), +h.toFixed(2), +l.toFixed(2), +c.toFixed(2), Math.round(1e5 + r() * 1e6), +prev.toFixed(2)];
    });
  });
  const ist = (iso) => new Date(Date.parse(iso + 'T00:00:00+05:30'));
  const h30 = [['Symbol', 'Date', 'Open', 'High', 'Low', 'Close', 'Volume']];
  syms.forEach((s) => bars[s].slice(-D30).forEach((b) => h30.push([s, ist(b[0]), b[1], b[2], b[3], b[4], b[5]])));
  const h60 = [['History60'], ['Symbol'].concat(days.slice().reverse()), ['(linked)'].concat(days.map(() => 'Y'))];
  syms.forEach((s) => h60.push([s].concat(bars[s].slice().reverse().map((b) => b.slice(1).join(' ')))));
  const tab = (n, d) => ({ name: n, rows: [['TckrSymb', 'OpnPric', 'HghPric', 'LwPric', 'ClsPric']].concat(syms.map((s) => {
    const b = bars[s][D60 - 4 + d];
    return [s, b[1], b[2], b[3], b[4]];
  })) });
  return { sheets: [{ name: 'Main', rows: [[], ['SYMBOL']] }, { name: 'PatternData', rows: [['Date', 'x', 'y', 'Symbol']].concat(syms.map((s) => ['', '', '', s])) },
    { name: 'History30', rows: h30 }, { name: 'History60', rows: h60 }, tab('Day4', 0), tab('ThirdDay', 1), tab('Yesterday', 2), tab('Today', 3)] };
}
function load(props) {
  const env = mock.loadCodeGs(workbook(), { props: props || {}, now: NOW });
  env.run(`(function () { var U = Utilities, c = { n: 0 }; this.__dates = c;
    Utilities = new Proxy(U, { get: function (t, k) {
      if (k === 'formatDate' || k === 'parseDate') return function () { c.n++; return U[k].apply(U, arguments); };
      return t[k]; } }); })()`);
  return env;
}
const dateCalls = (env, fn) => { env.run('__dates.n = 0; AB_H60_MEMO_ = null'); fn(); return env.run('__dates.n'); };

test('the FVG column and both watch-list scans convert each day once, not once per stock', () => {
  const env = load();
  const colX = dateCalls(env, () => env.call('computeLongFVGTouchPatterns_'));
  assert.ok(colX <= 2 * D60 + 10, 'FVG column: ' + colX + ' day conversions (was ' + 2 * NSYM * D30 + ')');
  const scans = dateCalls(env, () => { env.call('computeGapUpFvgs_'); env.call('computeUnmitigatedFvgs_'); });
  assert.ok(scans <= 2 * D60 + 10, 'scans: ' + scans + ' day conversions');
  assert.ok(env.sheet('GapUpFVG').rows.length > 20 && env.sheet('UnmitigatedFVG').rows.length > 20, 'both lists are filled');
});

test('the Pattern (W) and FVG (X) columns are written in one go, rows without a symbol keep their cell', () => {
  const env = load();
  const pd = env.sheet('PatternData').rows;
  pd.splice(5, 0, ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'keep W', 'keep X']);
  const w0 = env.writes.length;
  env.call('updateAllCandlestickPatterns');
  env.call('computeLongFVGTouchPatterns_');
  const writes = env.writes.slice(w0).filter((w) => w.sheet === 'PatternData');
  assert.deepEqual(writes.map((w) => w.col + ':' + w.row), ['23:2', '24:1', '24:2'], 'one column write each (+ the X header)');
  const rows = env.sheet('PatternData').rows;
  assert.deepEqual([rows[5][22], rows[5][23]], ['keep W', 'keep X']);
  assert.ok(rows.slice(1).filter((r) => r[22]).length > 50 && rows.slice(1).filter((r) => r[23]).length > 50, 'tags written');
});

test('scans that started today and never finished are not tried again today (the EOD email comes first)', () => {
  const today = '30-Oct-2026';
  const env = load({ AB_DATA_FETCHED: today, AB_FVG_SCANS_TRY: today + ' Phase 1 18:54' });
  assert.equal(env.call('ab_runFvgScansIfPending_', 'Phase 3'), false);
  assert.equal(env.sheet('GapUpFVG'), null, 'nothing scanned');
  assert.ok(env.logs.some((l) => /Phase 3 - Gap-up\/Unmitigated FVG scans skipped: they started today \(Phase 1 18:54\) and did not finish/.test(l)), env.logs.join('\n'));
  // a new day (or Phase 1's fresh data) runs them again, once
  const fresh = load({ AB_DATA_FETCHED: today, AB_FVG_SCANS_TRY: '29-Oct-2026 Phase 1 18:54' });
  assert.equal(fresh.call('ab_runFvgScansIfPending_', 'Phase 1'), true);
  assert.equal(fresh.props.getProperty('AB_FVG_SCANS_TRY'), today + ' Phase 1 19:00');
  assert.equal(fresh.props.getProperty('AB_FVG_SCANS_DONE'), today);
  assert.equal(fresh.call('ab_runFvgScansIfPending_', 'Phase 2'), false, 'done today');
});

test('Phase 3 waits for a Phase 2 that is still working, not for one Google stopped', () => {
  const today = '30-Oct-2026', trig = { triggerUid: 't1' };
  const alive = load({ AB_P2_WAITING: today, AB_P2_START: today + ' ' + (NOW - 2 * 60000) });
  assert.equal(alive.call('ab_phaseShouldWait_', 3, trig), true);
  assert.ok(alive.logs.some((l) => /Phase 3 put off 3 min \(1 of 6\): Phase 2 has not finished yet/.test(l)));
  const dead = load({ AB_P2_WAITING: today, AB_P2_START: today + ' ' + (NOW - 8 * 60000) });
  assert.equal(dead.call('ab_phaseShouldWait_', 3, trig), false);
  assert.ok(dead.logs.some((l) => /Phase 2 started at 18:52 and did not finish \(stopped by Google's 6-minute limit\) - not waiting for it/.test(l)), dead.logs.join('\n'));
  assert.equal(dead.props.getProperty('AB_P2_WAITING'), '');
  // put off, not started yet (yesterday's start mark): still waits
  const queued = load({ AB_P2_WAITING: today, AB_P2_START: '29-Oct-2026 ' + (NOW - 86400000) });
  assert.equal(queued.call('ab_phaseShouldWait_', 3, trig), true);
});
