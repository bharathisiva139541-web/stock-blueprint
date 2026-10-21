'use strict';
// Code.gs live site feed (doPost action 'site', part main | history) and the
// hardened price snapshot (action 'snapshot'), run in the Apps Script mock on
// a small synthetic workbook. The real-workbook check is
// tools/compare_site_feed.js (needs a downloaded copy, not in the repo).
const test = require('node:test');
const assert = require('node:assert');
const mock = require('./fixtures/apps-script-mock.js');

const TOKEN = 'test-feed-token-0123456789';
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const PERSONAL_TABS = ['Portfolio', 'Risk Manager', 'Control Panel', 'Trade Log', 'Trade Dashboard'];

/** rows + one number format per column for the data rows (row index >= from). */
function sheet(name, rows, colFmts, from) {
  const numFmts = rows.map(function (r, i) {
    return r.map(function (v, j) { return i >= (from || 0) && colFmts && colFmts[j] ? colFmts[j] : null; });
  });
  return { name: name, rows: rows, numFmts: numFmts };
}

const MAIN_HDR = ['Checkbox', 'SYMBOL', 'StockName', 'Sector', 'Result Date', 'MKT Price', '% Change', '10 day%',
  'Upside Potential', 'TTM Signal', 'PE Ratio', 'Promotor Holding', 'Entry Price', 'Stoploss', 'Qty', 'Owner Email',
  'Price Fall Alert Price', 'Breakout Alert Price', 'Triggered Y/N'];
const MAIN_FMT = [null, null, null, null, 'dd/mm/yyyy', '0.00', '0.00', '0.00%', '0.00%'];

function mainSheet(extra) {
  return sheet('Main', [
    ['Stock Blueprint'],
    MAIN_HDR,
    [true, 'TCS', 'Tata Consultancy', 'IT', '2026-10-09', 3050.123456, 1.23456, 0.0512, 0.25, 'BUY', '#N/A', 72.5, '', '', '', 'owner@example.com'],
    [false, 'INFY', 'Infosys', 'IT', '21-Aug-2026', '1,500.5', 'Loading...', '', '', '', '', '', 1450, '', 10, ''],
    ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    [false, 'HDFCBANK', 'HDFC Bank', 'Banks', '01/10/2026 20:23', 1650, -0.5, -0.031, 0.1, 'HOLD', 18.2, '', '', '', '', ''],
    [false, 'SBIN', 'State Bank', 'Banks', '2026-10-09 14:05', 800, 0.2, 0, '', 'BUY', 9.1, '', '', 700, 5, ''],
    [false, 'RELIANCE', 'Reliance', 'Energy', '', 2900, '#DIV/0!', '', '', '', '', '', 0, '', '', '']
  ].concat(extra || []), MAIN_FMT, 2);
}

function history30(symbols) {
  const rows = [['Symbol', 'Date', 'Open', 'High', 'Low', 'Close', 'Volume']];
  symbols.forEach(function (s, k) {
    rows.push([s, '2026-10-16', 10 + k, 12 + k, 9 + k, 11 + k, 1000]);
    rows.push([s, '2026-10-14', 9 + k, 11 + k, 8 + k, 10 + k, 900]);
    rows.push([s, '15/10/2026', 9.5 + k, 11.5 + k, 8.5 + k, 10.123456 + k, 950]);   // text date
  });
  rows.push(['', '2026-10-16', 1, 1, 1, 1, 1]);                                          // no symbol: skipped
  return sheet('History30', rows, [null, 'yyyy-mm-dd'], 1);
}

function patternData() {
  const hdr = []; for (let i = 0; i < 27; i++) hdr.push('c' + i);
  hdr[3] = 'Symbol'; hdr[22] = 'Pattern'; hdr[23] = 'Long FVG Touch'; hdr[24] = '10 EMA Support';
  hdr[25] = 'ATR14 (EMA)'; hdr[26] = '21 EMA Support';
  const row = function (sym, pat, fvg, atr) {
    const r = hdr.map(function () { return ''; });
    r[3] = sym; r[22] = pat; r[23] = fvg; r[24] = false; r[25] = atr; r[26] = 'Support';
    return r;
  };
  return sheet('PatternData', [hdr, row('tcs ', 'Hammer', '', 12.5), row('HDFCBANK', '', 'Long FVG', 20)]);
}

function workbook(opts) {
  opts = opts || {};
  const sheets = [
    mainSheet(opts.mainExtra),
    sheet('Results Tracker', [
      ['Symbol', 'Company', 'Result Date', 'Status', 'Move'],
      ['TCS', 'Tata Consultancy', '2026-10-09', 'Updated', 0.0412],
      ['', '', '', '', ''],                                   // blank row inside: skipped, not a stop
      ['INFY', 'Infosys', '2026-10-16', 'Pending', -0.01]
    ], [null, null, 'dd/mm/yyyy', null, '0.0%'], 1),
    sheet('Results Performance', [
      ['Results Performance'],
      ['Stocks that reported this season - last refreshed 20/10/2026 18:45'],
      [''],
      ['Season', 'Stocks Tracked', 'Avg', 'Median', 'Above', 'Sold off', '', 'Verdict', 'Stocks', 'Avg', 'Positive', 'Day'],
      ['Q2 FY27', 12, 0.034, 0.02, '7 of 12', 3, '', 'Beat', 5, 0.05, 0.8, 0.012],
      ['Best: TCS +8%', 1, '', '', '', '', '', '', '', '', '', ''],
      ['Note: prices from GOOGLEFINANCE', '', '', '', '', '', '', 'Miss', 2, -0.03, 0.5, -0.01],
      ['Symbol', 'Result Date', 'Since Result %'],
      ['TCS', '2026-10-09', 0.081]
    ], [null, 'dd/mm/yyyy', '0.00%'], 8),
    sheet('Pattern Dashboard', [
      ['Pattern Dashboard - refreshed 20/10/2026 16:10'],
      ['Stocks Scanned', 'Bullish', 'Bearish'],
      [1800, 25, 12],
      [''],
      ['Type', 'Count', 'Avg % Change', '% Advancing'],
      ['Bullish Engulfing', 10, 0.012, 0.6],
      [''],
      ['Basic Industry', 'Stocks', 'Avg % Change'],
      ['IT Services', 4, -0.004],
      [''],
      ['Symbol', 'Pattern', '% Change', '10-day %'],
      ['TCS', 'Hammer', 0.0123, 0.05]
    ]),
    sheet('UnmitigatedFVG', [['Symbol', 'Zone Low', 'Zone High', 'Formed'], ['TCS', 3000, 3020, '2026-10-01'], [''], ['HDFCBANK', 1600, 1610, '2026-10-02']],
      [null, null, null, 'dd-mmm-yyyy'], 1),
    sheet('GapUpFVG', [['Symbol', 'Gap %'], ['TCS', 0.021]], [null, '0.00%'], 1),
    sheet('Signal Watchlist Log', [['Date Flagged', 'Symbol', 'Signal'], ['2026-10-15', 'TCS', 'Breakout watch']], ['yyyy-mm-dd'], 1),
    sheet('Mitigated FVG Log', [['Date', 'Symbol', 'Zone'], ['2026-10-12', 'HDFCBANK', 'Long']], ['dd/mm/yyyy'], 1),
    sheet('Alert Log', [
      ['Alert Log'],
      ['Date', 'Time', 'Symbol', 'Company', 'Alert Type', 'Alert Level', 'Trigger Price', 'Entry Price', 'Qty',
        'Current Price', '% Since Alert', 'Outcome', 'Email'],
      ['2026-10-15', '10:30', 'TCS', 'Tata Consultancy', 'Breakout', 3000, 3005, 2990, 10, 3050, 1.5, 'Open', 'owner@example.com'],
      ['2026-10-15', '10:31', 'TCS', 'Tata Consultancy', 'Entry', 2990, 2990, 2990, 10, 3050, 2, 'Open', ''],
      ['2026-10-15', '10:32', 'INFY', 'Infosys', 'Breakout', 1500, 1501, '', '', 1500, 0, 'Open', ''],
      ['2026-10-15', '10:33', 'SBIN', 'State Bank', 'Price Fall', 790, 789, '', '', 800, 1, 'Open', ''],
      ['2026-10-15', '10:34', 'WIPRO', 'Wipro', 'Breakout', 400, 401, '', '', 405, 1, 'Open', ''],
      ['2026-10-15', '10:35', 'ITC', 'ITC Ltd', 'Breakout', 410, 411, '', '', 415, 1, 'Open', ''],
      ['2026-10-15', '10:36', ' lt ', 'Larsen', 'Price Fall', 3500, 3499, '', '', 3400, -2, 'Open', ''],
      ['', '', '', '', '', '', '', '', '', '', '', '', ''],
      ['2026-10-16', '09:40', 'HDFCBANK', 'HDFC Bank', 'Price Fall', 1660, 1659, '', '', 1650, -0.6, 'Hit', ''],
      ['2026-10-16', '09:41', 'RELIANCE', 'Reliance', 'Stop Hit', 2800, 2799, '', '', 2900, 3, 'Closed', '']
    ], ['yyyy-mm-dd', 'hh:mm'], 2),
    sheet('Trade Log', [['Date', 'Symbol', 'Entry', 'Qty', 'P&L'], ['2026-10-01', 'wipro', 400, 10, 50]]),
    sheet('Portfolio', [['My Portfolio'], ['Symbol', 'Qty', 'Avg Price'], ['ITC', 100, 400], [500325, 1, 1]]),
    sheet('Risk Manager', [['Capital', 100000], ['Symbol', 'Entry', 'Stop'], ['LT', 3500, 3400]]),
    sheet('Control Panel', [['Setting', 'Value'], ['Email', 'owner@example.com']]),
    sheet('Trade Dashboard', [['Win rate', 0.6], ['Owner', 'owner@example.com']]),
    sheet('Indextracker', [
      ['NSE Symbol', 'Price', 'Change'],
      ['NIFTY 50', 25000, 0.5],
      ['Broad indices', '', ''],
      ['NIFTY 50', 25000, 0.5],
      ['NIFTY BANK', 52000, -0.2]
    ]),
    sheet('IPOs', [['NSE SYMBOL', 'Company', 'Listing Date'], ['NEWCO', 'New Co', '2026-09-30']], [null, null, 'dd/mm/yyyy'], 1),
    sheet('New IPOs', [['COMPANY NAME', 'Open', 'Close'], ['Alpha Ltd', '22-Oct-2026', '24-Oct-26'], ['Beta Ltd', '31/02/2026', 'TBA']]),
    sheet('Price Band Changes', [['Report Date', 'Symbol', 'From', 'To'], ['2026-10-17', 'NEWCO', 0.2, 0.1]], ['yyyy-mm-dd', null, '0%', '0%'], 1),
    opts.history || history30(['TCS', 'HDFCBANK', 'SBIN']),
    patternData()
  ];
  return { sheets: sheets.filter(function (s) { return !(opts.drop || []).includes(s.name); }) };
}

function load(wb, props) {
  return mock.loadCodeGs(wb || workbook(), { props: props === undefined ? { AB_FEED_TOKEN: TOKEN } : props });
}

function rowOf(table, key, value) {
  const j = table.cols.indexOf(key);
  return table.rows.find(function (r) { return r[j] === value; });
}

test('site feed: token and part are checked', () => {
  const env = load();
  assert.deepStrictEqual(env.post({ action: 'site', part: 'main', token: 'wrong' }), { ok: false, error: 'bad token' });
  assert.deepStrictEqual(env.post({ action: 'site', part: 'main' }), { ok: false, error: 'bad token' });
  assert.deepStrictEqual(env.post({ action: 'site', part: 'everything', token: TOKEN }), { ok: false, error: 'unknown part' });
  assert.deepStrictEqual(env.post({ action: 'site', token: TOKEN }), { ok: false, error: 'unknown part' });
  // no token set up yet: even an empty token is refused
  const fresh = load(null, {});
  assert.deepStrictEqual(fresh.post({ action: 'site', part: 'main', token: '' }), { ok: false, error: 'bad token' });
  // the bridge token is a different secret: it does not open the feed
  const both = load(null, { AB_BRIDGE_TOKEN: 'bridge-secret', AB_FEED_TOKEN: TOKEN });
  assert.deepStrictEqual(both.post({ action: 'site', part: 'main', token: 'bridge-secret' }), { ok: false, error: 'bad token' });
  assert.strictEqual(env.lastOutput.getMimeType(), 'application/json');
});

test('site feed main: envelope and the export_xlsx.py keys', () => {
  const env = load();
  const r = env.post({ action: 'site', part: 'main', token: TOKEN });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.part, 'main');
  assert.match(r.readAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.strictEqual(r.tz, 'Asia/Kolkata');
  const d = r.data;
  assert.deepStrictEqual(Object.keys(d), ['generated', 'source', 'main', 'resultsTracker', 'resultsPerf', 'asOf', 'patterns',
    'fvg', 'gapup', 'watchLog', 'mitigatedLog', 'alerts', 'indices', 'ipos', 'newIpos', 'priceBands']);
  assert.strictEqual(d.generated, r.readAt);
  assert.strictEqual(d.source, 'Google Sheet (live feed)');
  assert.strictEqual(d.asOf, '2026-10-20 18:45');
  assert.ok(!('fvgBacktest' in d), 'no FVG Backtest tab -> no key');
  assert.deepStrictEqual(env.writes, [], 'the feed never writes');
  assert.deepStrictEqual(env.mails, []);
});

test('site feed main: Main columns, kinds and conversions', () => {
  const d = load().post({ action: 'site', part: 'main', token: TOKEN }).data;
  // only the allow-listed columns that exist, in MAIN_COLS order
  assert.deepStrictEqual(d.main.cols, ['sym', 'name', 'sector', 'rdate', 'done', 'price', 'chg', 'd10', 'pe', 'sig', 'up', 'promo']);
  assert.strictEqual(d.main.rows.length, 5, 'blank row skipped');
  const tcs = rowOf(d.main, 'sym', 'TCS');
  const at = function (row, k) { return row[d.main.cols.indexOf(k)]; };
  assert.strictEqual(at(tcs, 'rdate'), '2026-10-09');       // date cell -> ISO day
  assert.strictEqual(at(tcs, 'done'), true);
  assert.strictEqual(at(tcs, 'price'), 3050.1235);          // rounded to 4 dp
  assert.strictEqual(at(tcs, 'chg'), 1.2346);               // pct: already a percent
  assert.strictEqual(at(tcs, 'd10'), 5.12);                 // frac: x100
  assert.strictEqual(at(tcs, 'up'), 25);
  assert.strictEqual(at(tcs, 'pe'), null);                  // #N/A
  assert.strictEqual(at(tcs, 'promo'), '72.5');             // str kind keeps numbers as text
  const infy = rowOf(d.main, 'sym', 'INFY');
  assert.strictEqual(at(infy, 'rdate'), '2026-08-21');      // text date '21-Aug-2026'
  assert.strictEqual(at(infy, 'price'), 1500.5);            // '1,500.5'
  assert.strictEqual(at(infy, 'chg'), null);                // 'Loading...'
  assert.strictEqual(at(infy, 'd10'), null);                // blank
  assert.strictEqual(at(infy, 'done'), false);
  const hdfc = rowOf(d.main, 'sym', 'HDFCBANK');
  assert.strictEqual(at(hdfc, 'rdate'), '2026-10-01 20:23'); // text date-time
  assert.strictEqual(at(hdfc, 'd10'), -3.1);
  const sbin = rowOf(d.main, 'sym', 'SBIN');
  assert.strictEqual(at(sbin, 'rdate'), '2026-10-09 14:05'); // a time of day in a date-only cell is kept
  assert.strictEqual(at(rowOf(d.main, 'sym', 'RELIANCE'), 'chg'), null);   // #DIV/0!
});

test('site feed main: results, patterns and market tables', () => {
  const d = load().post({ action: 'site', part: 'main', token: TOKEN }).data;
  assert.deepStrictEqual(d.resultsTracker.cols, ['Symbol', 'Company', 'Result Date', 'Status', 'Move']);
  assert.deepStrictEqual(d.resultsTracker.rows, [
    ['TCS', 'Tata Consultancy', '2026-10-09', 'Updated', 4.12],          // 0.0% format -> frac
    ['INFY', 'Infosys', '2026-10-16', 'Pending', -1]
  ]);
  const p = d.resultsPerf;
  assert.strictEqual(p.note, 'Stocks that reported this season - last refreshed 20/10/2026 18:45');
  assert.deepStrictEqual(p.seasons, [{ season: 'Q2 FY27', tracked: 12, avg: 3.4, median: 2, above: '7 of 12', soldOff: 3 }]);
  assert.deepStrictEqual(p.lines, ['Best: TCS +8%', 'Note: prices from GOOGLEFINANCE']);
  assert.deepStrictEqual(p.verdicts, [
    { verdict: 'Beat', stocks: 5, avg: 5, positive: 80, day: 1.2 },
    { verdict: 'Miss', stocks: 2, avg: -3, positive: 50, day: -1 }
  ]);
  assert.deepStrictEqual(p.table, { cols: ['Symbol', 'Result Date', 'Since Result %'], rows: [['TCS', '2026-10-09', 8.1]] });

  assert.strictEqual(d.patterns.asOf, '2026-10-20 16:10');
  assert.deepStrictEqual(d.patterns.kpis, { 'Stocks Scanned': 1800, Bullish: 25, Bearish: 12 });
  assert.deepStrictEqual(d.patterns.signals.rows, [['Bullish Engulfing', 10, 1.2, 60]]);
  assert.deepStrictEqual(d.patterns.clusters.rows, [['IT Services', 4, -0.4]]);
  assert.deepStrictEqual(d.patterns.stocks.rows, [['TCS', 'Hammer', 1.23, 5]]);

  assert.deepStrictEqual(d.fvg.rows, [['TCS', 3000, 3020, '2026-10-01'], ['HDFCBANK', 1600, 1610, '2026-10-02']]);
  assert.deepStrictEqual(d.gapup.rows, [['TCS', 2.1]]);
  assert.deepStrictEqual(d.watchLog.rows, [['2026-10-15', 'TCS', 'Breakout watch']]);
  assert.deepStrictEqual(d.mitigatedLog.rows, [['2026-10-12', 'HDFCBANK', 'Long']]);
  assert.deepStrictEqual(d.indices, { cols: ['NSE Symbol', 'Price', 'Change'], rows: [['NIFTY 50', 25000, 0.5], ['NIFTY BANK', 52000, -0.2]] });
  assert.deepStrictEqual(d.ipos.rows, [['NEWCO', 'New Co', '2026-09-30']]);
  // text dates: '22-Oct-2026' and '24-Oct-26' convert; an impossible '31/02/2026' stays text
  assert.deepStrictEqual(d.newIpos.rows, [['Alpha Ltd', '2026-10-22', '2026-10-24'], ['Beta Ltd', '31/02/2026', 'TBA']]);
  assert.deepStrictEqual(d.priceBands.rows, [['2026-10-17', 'NEWCO', 20, 10]]);
});

test('site feed main: alerts are watch-level only and leave private symbols out', () => {
  const d = load().post({ action: 'site', part: 'main', token: TOKEN }).data;
  assert.deepStrictEqual(d.alerts.cols, ['Date', 'Symbol', 'Company', 'Alert Type', 'Alert Level', 'Trigger Price',
    'Current Price', '% Since Alert', 'Outcome']);
  // TCS Entry alert dropped (Entry type); INFY (Main Entry Price), SBIN (Main Stoploss),
  // WIPRO (Trade Log), ITC (Portfolio), LT (Risk Manager) dropped; Stop Hit is not public
  assert.deepStrictEqual(d.alerts.rows, [
    ['2026-10-15', 'TCS', 'Tata Consultancy', 'Breakout', 3000, 3005, 3050, 1.5, 'Open'],
    ['2026-10-16', 'HDFCBANK', 'HDFC Bank', 'Price Fall', 1660, 1659, 1650, -0.6, 'Hit']
  ]);
  assert.strictEqual(d.alerts.note, 'watch alerts only; symbols with your own entry/stop-loss or a Trade Log row are left out');
});

test('site feed main: personal tabs, columns and e-mails never reach the JSON', () => {
  const env = load();
  env.reads.length = 0;     // Code.gs reads its Control Panel settings when it loads (every run); count the feed only
  env.ranges.length = 0;
  env.post({ action: 'site', part: 'main', token: TOKEN });
  const json = env.lastOutput.getContent();
  assert.ok(!EMAIL_RE.test(json), 'no e-mail address');
  ['Entry Price', 'Stoploss', 'Qty', 'Owner Email', 'P&L', 'Avg Price', 'Capital', 'Win rate', 'WIPRO', 'ITC', 'Larsen']
    .forEach(function (s) { assert.ok(!json.includes(s), s + ' must not be in the feed'); });
  // Control Panel / Trade Dashboard are never opened; the other personal tabs only for one symbol column
  assert.ok(!env.reads.includes('Control Panel') && !env.reads.includes('Trade Dashboard'));
  const personal = env.ranges.filter(function (g) { return PERSONAL_TABS.includes(g.sheet); });
  assert.ok(personal.length >= 3);
  personal.forEach(function (g) {
    assert.strictEqual(g.cols, 1, g.sheet + ' read wider than its symbol column');
    assert.strictEqual(g.col, g.sheet === 'Trade Log' ? 2 : 1, g.sheet + ' read the wrong column');
  });
});

test('site feed history: candles, calendar order, sheet tags, asOf', () => {
  const env = load();
  const r = env.post({ action: 'site', part: 'history', token: TOKEN });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.part, 'history');
  const h = r.data;
  assert.deepStrictEqual(Object.keys(h), ['asOf', 'source', 'timeframe', 'dates', 'cols', 'bars', 'sheetTags']);
  assert.strictEqual(h.asOf, '2026-10-20 18:45');
  assert.strictEqual(h.source, 'History30 tab (GOOGLEFINANCE daily candles)');
  assert.strictEqual(h.timeframe, '1d');
  assert.deepStrictEqual(h.cols, ['d', 'o', 'h', 'l', 'c', 'v']);
  assert.deepStrictEqual(h.dates, ['2026-10-14', '2026-10-15', '2026-10-16']);
  assert.deepStrictEqual(Object.keys(h.bars), ['TCS', 'HDFCBANK', 'SBIN']);
  assert.deepStrictEqual(h.bars.TCS, [[0, 9, 11, 8, 10, 900], [1, 9.5, 11.5, 8.5, 10.1235, 950], [2, 10, 12, 9, 11, 1000]]);
  assert.deepStrictEqual(h.sheetTags, { TCS: ['Hammer', '', '', 12.5, 'Support'], HDFCBANK: ['', 'Long FVG', '', 20, 'Support'] });
  assert.deepStrictEqual(env.writes, []);
});

test('site feed history: refused while History30 is being rewritten', () => {
  const env = load(workbook({ history: history30(['TCS']) }));
  assert.deepStrictEqual(env.post({ action: 'site', part: 'history', token: TOKEN }),
    { ok: false, error: 'sheet is updating (History30 has 1 of 5 symbols) - try again shortly' });
});

test('site feed: failures come back as {ok:false, error} without values', () => {
  const noMain = load(workbook({ drop: ['Main'] }));
  assert.deepStrictEqual(noMain.post({ action: 'site', part: 'main', token: TOKEN }), { ok: false, error: 'Could not find a "Main" tab.' });
  const noHist = load(workbook({ drop: ['History30'] }));
  assert.deepStrictEqual(noHist.post({ action: 'site', part: 'history', token: TOKEN }), { ok: false, error: 'Could not find a "History30" tab.' });
  // optional tabs missing: empty tables, same shape
  const thin = load(workbook({ drop: ['GapUpFVG', 'Alert Log', 'Mitigated FVG Log'] }));
  const d = thin.post({ action: 'site', part: 'main', token: TOKEN }).data;
  assert.deepStrictEqual(d.gapup, { cols: [], rows: [] });
  assert.deepStrictEqual(d.alerts.cols, []);
  assert.ok(!('mitigatedLog' in d));
});

test('site feed helpers follow export_xlsx.py (clean / text_date / round / norm)', () => {
  const env = load();
  const cx = env.run('({ ss: SpreadsheetApp.getActiveSpreadsheet(), tz: "Asia/Kolkata", tabs: {}, dates: {} })');
  const clean = function (v, k) { return env.call('ab_site_clean_', cx, v, k); };
  const td = function (s) { return env.call('ab_site_textDate_', s); };
  assert.strictEqual(td('21-Aug-2026'), '2026-08-21');
  assert.strictEqual(td('21-aug-26'), '2026-08-21');
  assert.strictEqual(td('05-Jan-70'), '1970-01-05');
  assert.strictEqual(td('21-Aug-2026 9:05'), '2026-08-21 09:05');
  assert.strictEqual(td('01/10/2026 20:23'), '2026-10-01 20:23');
  assert.strictEqual(td('29/02/2028'), '2028-02-29');
  assert.strictEqual(td('29/02/2027'), null);
  assert.strictEqual(td('1/10/2026'), null);              // must start with two digits
  assert.strictEqual(td('2026-10-01'), null);
  assert.strictEqual(td('20MICRONS'), null);
  ['#N/A', '#REF!', '#SPILL!', '  ', 'Loading...'].forEach(function (e) { assert.strictEqual(clean(e, 'auto'), null, e); });
  assert.strictEqual(clean('5%', 'num'), null);
  assert.strictEqual(clean(' 0.05 ', 'frac'), 5);
  assert.strictEqual(clean(true, 'str'), null);
  assert.strictEqual(clean(true, 'auto'), true);
  assert.strictEqual(clean(0.03125, 'num'), 0.0312);      // exact tie -> even, like Python round()
  assert.strictEqual(clean(0.03135, 'num'), 0.0314);
  assert.strictEqual(clean(-1.23456789, 'auto'), -1.2346);
  assert.strictEqual(clean(0.00001, 'str'), '1e-05');     // Python str() of a float
  assert.strictEqual(clean(42, 'date'), '42');
  const D = env.Date;
  const ist = function (y, m, d, h, mi) { return new D(Date.UTC(y, m - 1, d, h, mi) - 330 * 60000); };
  assert.strictEqual(clean(ist(2026, 10, 9, 0, 0), 'date'), '2026-10-09');
  assert.strictEqual(clean(ist(2026, 10, 9, 15, 30), 'auto'), '2026-10-09 15:30');
  assert.strictEqual(clean(ist(2026, 10, 9, 15, 30), 'num'), null);
  assert.strictEqual(clean(ist(1899, 12, 30, 10, 30), 'auto'), '10:30:00');   // time-only cell
  assert.strictEqual(env.call('ab_site_norm_', cx, '  Basic \n Industry '), 'basic industry');
  assert.strictEqual(env.call('ab_site_isFracFormat_', '0.00%'), true);
  assert.strictEqual(env.call('ab_site_isFracFormat_', '0.00"%"'), false);
  assert.strictEqual(env.call('ab_site_isFracFormat_', '0.0\\%'), false);
});

test('snapshot: only ticker-like rows, stops at a repeated header, readAt', () => {
  const env = load(workbook({ mainExtra: [
    ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    ['', 'Note: prices are ~20 min delayed', '', '', '', 5, 1],
    ['', 'm&m', 'Mahindra', 'Auto', '', 3000, 0.4],
    ['', 'SYMBOL', 'StockName'],
    ['', 'AFTERHEADER', 'Second table', '', '', 10, 1]
  ] }));
  const r = env.post({ action: 'snapshot', token: TOKEN });
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(r.cols, ['sym', 'price', 'chg']);
  assert.deepStrictEqual(r.rows.map(function (x) { return x[0]; }), ['TCS', 'INFY', 'HDFCBANK', 'SBIN', 'RELIANCE', 'M&M']);
  assert.deepStrictEqual(r.rows[0], ['TCS', 3050.123456, 1.23456]);
  assert.deepStrictEqual(r.rows[1], ['INFY', null, null]);      // text price / 'Loading...'
  assert.strictEqual(r.readAt, r.asOf);
  assert.match(r.readAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.strictEqual(r.delayMinutes, 20);
  assert.deepStrictEqual(load().post({ action: 'snapshot', token: 'nope' }), { ok: false, error: 'bad token' });
});

test('doPost: the PC bridge path is unchanged (its own token, lock)', () => {
  const env = load(null, { AB_FEED_TOKEN: TOKEN, AB_BRIDGE_TOKEN: 'bridge-secret' });
  assert.deepStrictEqual(env.post({ action: 'list', token: TOKEN }), { ok: false, error: 'bad token' });
  assert.deepStrictEqual(env.post({ action: 'nope', token: 'bridge-secret' }), { ok: false, error: 'unknown action' });
});

test('runFeedSetupInfo: one token for both feeds, update the EXISTING deployment', () => {
  const env = load(null, {});
  env.call('runFeedSetupInfo');
  const text = env.alerts[0].join('\n');
  ['MARKET_DATA_PROVIDER', 'SHEET_FEED_URL', 'SHEET_FEED_TOKEN', 'EXISTING', 'New version', 'BOTH'].forEach(function (s) {
    assert.ok(text.includes(s), 'dialog mentions ' + s);
  });
  assert.ok(env.props.getProperty('AB_FEED_TOKEN'), 'token created on first use');
});
