'use strict';
// Code2.gs doPost action 'intraday' (owner, 07-Nov-2026: "PARAGMILK - in the 4 hour timeframe a Spring candlestick
// pattern formed in an FVG; due to lack of this intraday data I missed this opportunity"): the PC (kite_intraday.py)
// asks for PatternData's symbols ({op: 'syms'}) and sends the Spring / Spring in FVG it found on Kite's candles
// ({op: 'put'}) -> tab "Intraday Patterns"; the site feed part 'intraday' (Code.gs ab_site_itd_) = export_xlsx.py
// intraday_patterns(): the allowed columns only (no Kite prices), the newest 10 sessions.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const mock = require('./fixtures/apps-script-mock.js');

const TOKEN = 'bridge-token-0123456789';
const NOW = Date.UTC(2026, 10, 6, 13, 30);          // Fri 06-Nov-2026 19:00 IST
function workbook() {
  return { sheets: [
    { name: 'Main', rows: [['Main watchlist'], ['Checkbox', 'StockName', 'SYMBOL'], [false, 'Parag Milk Foods Ltd.', 'PARAGMILK'],
      [false, 'Mahindra & Mahindra', 'M&M'], [false, 'Flat Co', 'FLAT']] },
    { name: 'PatternData', rows: [['Name', 'Sector', 'Industry', 'Symbol'], ['', '', '', 'PARAGMILK'], ['', '', '', 'M&M'], ['', '', '', 'FLAT']] }
  ] };
}
function env() { return mock.loadCodeGs(workbook(), { props: { AB_BRIDGE_TOKEN: TOKEN }, now: NOW }); }
const put = (items, extra) => Object.assign({ token: TOKEN, action: 'intraday', op: 'put', upto: '2026-11-06', since: '2026-10-23', items: items }, extra || {});
const PARA = { sym: 'PARAGMILK', tf: '4H', pattern: 'Spring in FVG', candle: '2026-10-30 13:15', session: '2026-10-30', low: 228.054, close: 233.7,
  zone: [232.1, 246, '2026-08-24 09:15'] };

test('intraday: the symbol list, then the patterns on the "Intraday Patterns" tab (newest first, one row each, kept 30 days)', () => {
  const e = env();
  assert.deepStrictEqual(e.post({ token: TOKEN, action: 'intraday', op: 'syms' }), { ok: true, syms: ['PARAGMILK', 'M&M', 'FLAT'] });
  const r = e.post(put([
    PARA,
    { sym: 'M&M', tf: '1H', pattern: 'Spring', candle: '2026-11-06 14:15', session: '2026-11-06', low: 3000, close: 3010.5, zone: null },
    { sym: 'flat', tf: 'W', pattern: 'Spring', candle: '2026-11-02', session: '2026-11-06', low: 99, close: 100 },
    { sym: 'FLAT', tf: 'M', pattern: 'Spring in FVG', candle: '2026-10', session: '2026-10-30', low: 90, close: 95, zone: [91, 99, '2026-05'] },
    { sym: 'OTHER', tf: '4H', pattern: 'Spring', candle: '2026-11-06 09:15', session: '2026-11-06' },          // not on PatternData
    { sym: 'FLAT', tf: '3H', pattern: 'Spring', candle: '2026-11-06 09:15', session: '2026-11-06' },          // no such timeframe
    { sym: 'FLAT', tf: '4H', pattern: 'Hammer', candle: '2026-11-06 09:15', session: '2026-11-06' },          // not a pattern sent
    { sym: 'FLAT', tf: '4H', pattern: 'Spring', candle: '06-11-2026', session: '2026-11-06' },               // a bad candle time
    { sym: 'FLAT', tf: 'D', pattern: 'Spring', candle: '2026-09-01', session: '2026-09-01', low: 1, close: 2 }   // older than 30 days
  ]));
  assert.deepStrictEqual(r, { ok: true, received: 9, added: 5, skipped: 4, kept: 4, dropped: 0, tfs: null });
  const rows = e.sheet('Intraday Patterns').rows;
  assert.match(rows[0][0], /^Spring and Spring in FVG from Zerodha Kite candles .* Last scan: session 2026-11-06 \(2026-11-06 19:00\)\. Kept 30 days\./);
  assert.deepStrictEqual(rows[1], ['Session', 'Symbol', 'Company', 'Timeframe', 'Pattern', 'Candle', 'FVG Formed', 'Chart', 'Low', 'Close', 'FVG Bottom', 'FVG Top', 'Found']);
  assert.deepStrictEqual(rows.slice(2).map((x) => [x[0], x[1], x[3], x[4]]), [
    ['2026-11-06', 'FLAT', 'W', 'Spring'], ['2026-11-06', 'M&M', '1H', 'Spring'],
    ['2026-10-30', 'FLAT', 'M', 'Spring in FVG'], ['2026-10-30', 'PARAGMILK', '4H', 'Spring in FVG']], 'newest session, then the biggest timeframe');
  assert.deepStrictEqual(rows[5], ['2026-10-30', 'PARAGMILK', 'Parag Milk Foods Ltd.', '4H', 'Spring in FVG', '2026-10-30 13:15', '2026-08-24 09:15',
    '=HYPERLINK("https://www.tradingview.com/chart/?symbol=NSE%3APARAGMILK&interval=240","4H chart")', 228.05, 233.7, 232.1, 246, '2026-11-06 19:00']);
  assert.strictEqual(rows[3][7], '=HYPERLINK("https://www.tradingview.com/chart/?symbol=NSE%3AM%26M&interval=60","1H chart")');
  assert.deepStrictEqual(rows[3].slice(8, 12), [3000, 3010.5, '', ''], 'no zone for a plain Spring');

  // the same pattern again (the PC re-sends after a stop): one row, the first "Found" kept
  e.setNow(Date.UTC(2026, 10, 9, 12, 0));
  const r2 = e.post(put([PARA, { sym: 'FLAT', tf: '15m', pattern: 'Spring in FVG', candle: '2026-11-09 10:30', session: '2026-11-09', low: 100, close: 101,
    zone: [99.5, 100.5, '2026-11-05 11:00'] }], { upto: '2026-11-09' }));
  assert.deepStrictEqual(r2, { ok: true, received: 2, added: 1, skipped: 0, kept: 5, dropped: 0, tfs: null });
  const rows2 = e.sheet('Intraday Patterns').rows;
  assert.deepStrictEqual(rows2[2].slice(0, 5), ['2026-11-09', 'FLAT', 'Flat Co', '15m', 'Spring in FVG']);
  assert.strictEqual(rows2.find((x) => x[1] === 'PARAGMILK')[12], '2026-11-06 19:00');

  assert.deepStrictEqual(e.post({ token: TOKEN, action: 'intraday', op: 'nope' }).ok, false);
  assert.deepStrictEqual(e.post({ token: TOKEN, action: 'intraday', op: 'put' }), { ok: false, error: 'items missing' });
  assert.deepStrictEqual(e.post({ token: 'bad', action: 'intraday', op: 'syms' }), { ok: false, error: 'bad token' });
});

test('intraday: tfs = the timeframes the PC reports now (owner, 08-Nov-2026: "only 4hr, D, W, M") - other rows leave the tab', () => {
  const e = env();
  e.post(put([PARA, { sym: 'FLAT', tf: '15m', pattern: 'Spring in FVG', candle: '2026-11-06 10:30', session: '2026-11-06', low: 100, close: 101, zone: [99, 100.5, '2026-11-05 11:00'] },
    { sym: 'M&M', tf: '1H', pattern: 'Spring', candle: '2026-11-06 14:15', session: '2026-11-06', low: 3000, close: 3010 }]));
  assert.strictEqual(e.sheet('Intraday Patterns').rows.length, 5);
  const r = e.post(put([{ sym: 'FLAT', tf: 'D', pattern: 'Spring', candle: '2026-11-06', session: '2026-11-06', low: 99, close: 100 },
    { sym: 'FLAT', tf: '30m', pattern: 'Spring in FVG', candle: '2026-11-06 11:15', session: '2026-11-06', low: 99, close: 100 }], { tfs: ['4H', 'D', 'W', 'M', 'nope'] }));
  assert.deepStrictEqual(r, { ok: true, received: 2, added: 1, skipped: 1, kept: 2, dropped: 2, tfs: ['M', 'W', 'D', '4H'] });
  const rows = e.sheet('Intraday Patterns').rows;
  assert.deepStrictEqual(rows.slice(2).map((x) => x[1] + ' ' + x[3]), ['FLAT D', 'PARAGMILK 4H'], 'the 15m and 1H rows are gone, the 30m one was not added');
  assert.match(rows[0][0], /candles \(your PC program\): 4H, D, W, M \(4H = 09:15-13:15 \/ 13:15-15:30\) - the sheet's/);
});

test('site feed part "intraday": the allowed columns only (no prices), newest 10 sessions = export_xlsx.py', () => {
  const e = env();
  const items = [];
  for (let k = 0; k < 13; k++) {
    const day = '2026-10-' + String(10 + k).padStart(2, '0');
    items.push({ sym: 'FLAT', tf: '1H', pattern: 'Spring', candle: day + ' 10:15', session: day, low: 10, close: 11 });
  }
  items.push(PARA);
  e.post(put(items));
  const data = JSON.parse(JSON.stringify(e.run('(function () { const ss = SpreadsheetApp.getActiveSpreadsheet();' +
    ' return ab_site_main_({ ss: ss, tz: AB_TZ, tabs: {}, dates: {} }, "2026-11-06 19:00"); })()')));
  const it = data.intraday;
  assert.deepStrictEqual(it.cols, ['Session', 'Symbol', 'Company', 'Timeframe', 'Pattern', 'Candle', 'FVG Formed']);
  assert.match(it.note, /^Spring and Spring in FVG from Zerodha Kite/);
  const days = [...new Set(it.rows.map((r) => r[0]))];
  assert.strictEqual(days.length, 10);
  assert.deepStrictEqual([days[0], days[9]], ['2026-10-30', '2026-10-14'], 'the newest 10 sessions');
  assert.deepStrictEqual(it.rows.find((r) => r[1] === 'PARAGMILK'), ['2026-10-30', 'PARAGMILK', 'Parag Milk Foods Ltd.', '4H', 'Spring in FVG', '2026-10-30 13:15', '2026-08-24 09:15']);
  assert.ok(!JSON.stringify(it).includes('228.05') && !JSON.stringify(it).includes('tradingview'), 'no Kite prices, no chart formula');
  assert.strictEqual(e.run('AB_SITE_FEED_FORMAT'), 9);

  // tools/export_xlsx.py intraday_patterns() on the same tab gives the same JSON
  const py = ['python3', 'python'].find((p) => spawnSync(p, ['-c', 'import openpyxl']).status === 0);
  if (!py) return;
  const tab = e.sheet('Intraday Patterns').rows.map((r) => r.map((v) => (typeof v === 'string' && v.startsWith('=HYPERLINK') ? '4H chart' : v === '' ? null : v)));
  const code = ['import importlib.util, json, sys', 'spec = importlib.util.spec_from_file_location("ex", sys.argv[1])',
    'ex = importlib.util.module_from_spec(spec); spec.loader.exec_module(ex)',
    'print(json.dumps(ex.intraday_patterns(ex.Rows(json.load(sys.stdin)))))'].join('\n');
  const r = spawnSync(py, ['-c', code, path.join(__dirname, '..', 'tools', 'export_xlsx.py')], { input: JSON.stringify(tab), encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), it);
});
