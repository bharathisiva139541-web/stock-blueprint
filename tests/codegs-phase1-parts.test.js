'use strict';
// Code.gs Phase 1 in parts: the GOOGLEFINANCE fetch of every PatternData stock runs in parts of
// AB_P1_PART_SIZE (900), one execution each (the next part from a one-off trigger a minute later),
// the last part writes the 4-day tabs and History30 in one go. Timer runs of Phase 2 / 3 wait while
// Phase 1 is still going; a Phase 1 that stopped part-way is logged and emailed once.
// GOOGLEFINANCE is played by a fake scratch tab (31 daily candles per stock).
const test = require('node:test');
const assert = require('node:assert');
const mock = require('./fixtures/apps-script-mock.js');

const NOW = Date.UTC(2026, 9, 28, 13, 15);          // Wed 28-Oct-2026 18:45 IST
const TIMER = { triggerUid: 'timer' };

function workbook(n, opts) {
  opts = opts || {};
  const pd = [['Name', '', '', 'Symbol']];
  for (let i = 0; i < n; i++) pd.push(['Co ' + i, '', '', 'S' + String(i).padStart(4, '0')]);
  const tab = (name) => ({ name: name, rows: [['TckrSymb', 'OpnPric', 'HghPric', 'LwPric', 'ClsPric', 'TtlTradgVol'], ['OLD', 1, 1, 1, 1, 1]] });
  return { sheets: [{ name: 'PatternData', rows: pd }, tab('Day4'), tab('ThirdDay'), tab('Yesterday'), tab('Today'),
    { name: 'History30', rows: [['Symbol', 'Date', 'Open', 'High', 'Low', 'Close', 'Volume'], ['OLD', '2026-10-27', 1, 1, 1, 1, 1]] },
    { name: 'AutoFetch Log', rows: [['ts']] }].concat(opts.extra || []) };
}

/** Code.gs with the slow / unrelated steps stubbed and GOOGLEFINANCE played by a fake scratch tab. */
function env(n, opts) {
  opts = opts || {};
  const e = mock.loadCodeGs(workbook(n, opts), { now: NOW, props: { AB_EMAIL_TO: 'x@example.com' } });
  const D = e.Date;
  const calls = { formulas: 0, flushReads: 0, patterns: 0, phase3: 0, symbolsFetched: [] };
  e.calls2 = calls;
  // 31 trading days of candles ending today (the newest = today, 28-Oct)
  const days = [];
  for (let d = new D(Date.UTC(2026, 9, 28, 0, 0) - 330 * 60000); days.length < 31; d = new D(d.getTime() - 86400000)) {
    const wd = new D(d.getTime() + 330 * 60000).getUTCDay();
    if (wd !== 0 && wd !== 6) days.unshift(new D(d.getTime()));
  }
  let formulas = [];
  const scratch = {
    clearContents: () => scratch, getMaxRows: () => 100000, getMaxColumns: () => 26,
    insertRowsAfter: () => scratch, insertColumnsAfter: () => scratch,
    getRange: (r, c, nr, nc) => ({
      setFormulas: (f) => { formulas = f; calls.formulas++; },
      getValues: () => {
        calls.flushReads++;
        const out = [];
        for (let i = 0; i < nr; i++) {
          const m = /NSE:([A-Z0-9]+)/.exec((formulas[i] || [''])[0]);
          if (!m) { out.push(['', '', '', '', '', '']); continue; }
          const sym = m[1];
          calls.symbolsFetched.push(sym);
          const block = [['Date', 'Open', 'High', 'Low', 'Close', 'Volume']];
          if (!(opts.noData || []).includes(sym)) {
            days.forEach((d, k) => block.push([d, 100 + k, 102 + k, 99 + k, 101 + k, 1000 + k]));
          }
          block.forEach((row) => out.push(row));
          i += block.length - 1;
        }
        return out.slice(0, nr);
      }
    })
  };
  e.context.ab_getScratchSheet_ = () => scratch;
  e.run('syncSymbolsFromBlueprint_ = function () {}; fillIpoLevel_ = function () {}; ab_ensureResultDateReal_ = function () {};' +
    'fillPrevDayVolume_ = function () {}; ab_runFvgScansIfPending_ = function () { return false; }; ab_skipWeekendTrigger_ = function () { return false; };' +
    'computeLongFVGTouchPatterns_ = function () {}; computeEmaSupportPatterns_ = function () {}; ab_buildPatternDashboard_ = function () {};');
  e.context.updateAllCandlestickPatterns = () => { calls.patterns++; };
  return e;
}
const plain = (v) => JSON.parse(JSON.stringify(v));
const handlers = (e) => e.triggers.map((t) => t.handler).sort();
const log = (e) => e.sheet('AutoFetch Log').rows.slice(1).map((r) => r[3] + ' | ' + r[4]);

test('1,850 stocks: three parts, Phase 2 / 3 wait, the last part writes History30 and the 4-day tabs at once', () => {
  const e = env(1850, { noData: ['S0005'] });
  const r1 = e.call('ab_dailyPhase1Fetch_');
  assert.deepStrictEqual(plain(r1), { part: 1, parts: 3, done: false });
  assert.strictEqual(e.calls2.formulas, 1, 'one write of all formulas per part');
  assert.deepStrictEqual(handlers(e), ['ab_dailyPhase1Continue_']);
  assert.deepStrictEqual(e.sheet('History30').rows[1][0], 'OLD', 'History30 is not touched before the last part');
  assert.strictEqual(e.sheet('Today').rows[1][0], 'OLD');
  const work = e.sheet('P1_Work');
  assert.strictEqual(work.hidden, true);
  assert.strictEqual(work.rows.filter((r) => r[0]).length, 899 * 30, 'part 1 rows kept (S0005 had no data)');

  // the timer runs of Phase 2 and 3 meanwhile: put off 3 minutes
  e.setNow(NOW + 3 * 60000);
  e.call('ab_dailyPhase2Patterns_', TIMER);
  e.call('ab_dailyPhase3AlertsEmail_', TIMER);
  assert.strictEqual(e.calls2.patterns, 0, 'no patterns from yesterday\'s candles');
  assert.deepStrictEqual(handlers(e), ['ab_dailyPhase1Continue_', 'ab_dailyPhase2Retry_', 'ab_dailyPhase3Retry_']);
  assert.ok(e.logs.some((l) => /Phase 2 put off 3 min \(1 of 6\): Phase 1 is still fetching \(part 2 of 3\)/.test(l)), e.logs.join('\n'));

  // the continuations
  const r2 = e.call('ab_dailyPhase1Continue_', TIMER);
  assert.deepStrictEqual(plain(r2), { part: 2, parts: 3, done: false });
  assert.strictEqual(e.triggers.filter((t) => t.handler === 'ab_dailyPhase1Continue_').length, 1, 'one pending continuation');
  e.setNow(NOW + 5 * 60000);
  const r3 = e.call('ab_dailyPhase1Continue_', TIMER);
  assert.deepStrictEqual(plain(r3), { part: 3, parts: 3, done: true });
  assert.strictEqual(new Set(e.calls2.symbolsFetched).size, 1850, 'every stock fetched once');
  assert.ok(!handlers(e).includes('ab_dailyPhase1Continue_'));

  const h = e.sheet('History30').rows;
  assert.deepStrictEqual(h[0], ['Symbol', 'Date', 'Open', 'High', 'Low', 'Close', 'Volume']);
  assert.strictEqual(h.length - 1, 1849 * 30, 'all parts, in PatternData order');
  assert.deepStrictEqual([h[1][0], h[h.length - 1][0]], ['S0000', 'S1849']);
  assert.deepStrictEqual(h[30], ['S0000', '2026-10-28', 130, 132, 129, 131, 1030], 'the newest candle is today');
  assert.strictEqual(e.sheet('Today').rows.length - 1, 1849);
  assert.deepStrictEqual(e.sheet('Today').rows[1], ['S0000', 130, 132, 129, 131, 1030]);
  assert.deepStrictEqual(e.sheet('Day4').rows[1], ['S0000', 127, 129, 126, 128, 1027]);
  assert.ok(!e.sheet('P1_Work').rows.some((r) => r.some((v) => v !== '')), 'the work tab is emptied');
  assert.strictEqual(e.props.getProperty('AB_DATA_FETCHED'), '28-Oct-2026');
  const ok = log(e).filter((l) => /^OK \(phase 1 - fetch\)/.test(l));
  assert.strictEqual(ok.length, 1);
  assert.match(ok[0], /No data for: S0005\. OHLC, History30, Prev Day Vol refreshed in 3 parts \(part 1: \d+s, part 2: \d+s, part 3: \d+s; \d+s from start to end\)\./);
  assert.strictEqual(JSON.parse(e.props.getProperty('AB_DAILY_PHASE1_RESULT')).asOfDate, '28-Oct-2026');

  // the put-off Phase 2 now runs; Phase 3 no longer waits for it
  e.call('ab_dailyPhase2Retry_', TIMER);
  assert.strictEqual(e.calls2.patterns, 1);
  assert.strictEqual(e.props.getProperty('AB_P2_WAITING'), '');
  assert.ok(!handlers(e).includes('ab_dailyPhase2Retry_'));
  assert.strictEqual(e.call('ab_phaseShouldWait_', 3, TIMER), false);
  assert.strictEqual(e.mails.length, 0, 'no failure email');
});

test('up to 900 stocks: one part, as before - no trigger, no work tab, no waiting', () => {
  const e = env(600);
  assert.deepStrictEqual(plain(e.call('ab_dailyPhase1Fetch_')), { part: 1, parts: 1, done: true });
  assert.deepStrictEqual(handlers(e), []);
  assert.strictEqual(e.sheet('P1_Work'), null);
  assert.strictEqual(e.sheet('History30').rows.length - 1, 600 * 30);
  assert.match(log(e)[0], /^OK \(phase 1 - fetch\) \| OHLC, History30, Prev Day Vol refreshed in \d+s\.$/);
  assert.strictEqual(e.call('ab_phaseShouldWait_', 2, TIMER), false);
});

test('a Phase 1 stopped part-way (6-minute limit): reported once, Phase 2 then runs on the old candles', () => {
  const e = env(1850);
  e.call('ab_dailyPhase1Fetch_');
  e.triggers.length = 0;                         // part 2 never came
  e.setNow(NOW + 15 * 60000);                    // a late trigger is still waited for
  assert.strictEqual(e.call('ab_phaseShouldWait_', 2, TIMER), true);
  e.triggers.length = 0;
  e.setNow(NOW + 21 * 60000);
  e.call('ab_dailyPhase2Patterns_', TIMER);
  assert.strictEqual(e.calls2.patterns, 1, 'not put off: nothing is running any more');
  assert.strictEqual(e.mails.length, 1);
  const m = e.mails[0][0];
  assert.match(m.subject, /^Auto Bhavcopy FAILED - Phase 1 \(fetch\)/);
  assert.match(m.body, /Phase 1 \(fetch\) did not finish: it stopped in part 2 of 3 \(last step at 18:45 IST\)/);
  assert.ok(log(e).some((l) => /^ERROR \(phase 1 - fetch\) \| Phase 1 \(fetch\) did not finish/.test(l)));
  assert.strictEqual(e.call('ab_p1CheckDied_'), false, 'reported once a day');
  assert.strictEqual(e.mails.filter((x) => /FAILED - Phase 1/.test(x[0].subject)).length, 1, 'once a day');
  // a stale continuation does nothing
  e.call('ab_dailyPhase1Continue_', TIMER);
  assert.ok(e.logs.some((l) => /Phase 1 continuation: nothing to continue/.test(l)));
});

test('Phase 2 waits at most 6 times, then runs anyway; menu runs never wait', () => {
  const e = env(1850);
  e.call('ab_dailyPhase1Fetch_');
  for (let i = 0; i < 6; i++) {
    e.setNow(NOW + (i + 1) * 60000);           // Phase 1 still "running" (fresh progress mark)
    e.run('(function () { const st = ab_p1State_(); st.lastMs = Date.now(); ab_p1Save_(st); })()');
    e.call('ab_dailyPhase2Patterns_', TIMER);
  }
  assert.strictEqual(e.calls2.patterns, 0);
  e.call('ab_dailyPhase2Patterns_', TIMER);
  assert.strictEqual(e.calls2.patterns, 1, 'the 7th time it runs');
  assert.ok(e.logs.some((l) => /Phase 2: Phase 1 is still fetching .* after 6 waits - running now anyway/.test(l)));
  e.call('ab_dailyPhase2Patterns_');            // menu
  assert.strictEqual(e.calls2.patterns, 2);
  // a fresh Phase 1 run forgets an unfinished one and its continuation
  e.call('ab_dailyPhase1Fetch_');
  assert.strictEqual(e.triggers.filter((t) => t.handler === 'ab_dailyPhase1Continue_').length, 1);
  assert.strictEqual(JSON.parse(e.props.getProperty('AB_P1_STATE')).next, 900);
});

test('removeDailyPhaseTriggers also removes the one-off continuation / retry triggers', () => {
  const e = env(1850);
  e.call('ab_dailyPhase1Fetch_');
  e.call('ab_dailyPhase2Patterns_', TIMER);
  assert.deepStrictEqual(handlers(e), ['ab_dailyPhase1Continue_', 'ab_dailyPhase2Retry_']);
  e.call('removeDailyPhaseTriggers');
  assert.deepStrictEqual(handlers(e), []);
});
