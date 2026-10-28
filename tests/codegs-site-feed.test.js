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
    sheet('IPO Tracker', [
      ['IPO Tracker - mainboard equity IPOs on NSE (SME and debt issues left out)'],
      ['Updated 2026-10-21 19:28 IST from NSE, read by your PC. Unofficial summary - check the offer document before applying.'],
      [''],
      ['Open now (1)'],
      ['Company', 'Symbol', 'Opens', 'Closes', 'Listing date', 'Price range', 'Issue size (shares)', 'Note'],
      ['BLS Polymers Limited', 'BLSPOLY', '2026-10-20', '2026-10-22', '', '\u20B9142 to \u20B9150', 11900000, 'Closes tomorrow'],
      [''],
      ['Closed - awaiting listing (0)'],
      ['Company', 'Symbol', 'Opens', 'Closes', 'Listing date', 'Price range', 'Issue size (shares)', 'Note'],
      ['None'],
      [''],
      ['Upcoming (1)'],
      ['Company', 'Symbol', 'Opens', 'Closes', 'Listing date', 'Price range', 'Issue size (shares)', 'Note'],
      ['M. K. Sons Fine Jewels Limited', 'MKSONS', '2026-10-28', '2026-10-30', '', '\u20B9153 to \u20B9162', 17000000, 'Opens in 7 days']
    ], [null, null, 'dd/mm/yyyy', 'dd/mm/yyyy', 'dd/mm/yyyy'], 4),
    opts.history || history30(['TCS', 'HDFCBANK', 'SBIN']),
    patternData()
  ];
  return { sheets: sheets.filter(function (s) { return !(opts.drop || []).includes(s.name); }) };
}

function load(wb, props) {
  return mock.loadCodeGs(wb || workbook(), { props: props === undefined ? { AB_FEED_TOKEN: TOKEN } : props });
}

/** The feed writes nothing but its own stored copy (hidden tab Site_Feed). */
function onlySiteFeedWrites(env) {
  assert.ok(env.writes.length > 0, 'the on-demand build is stored');
  assert.deepStrictEqual(env.writes.filter(function (w) { return w.sheet !== 'Site_Feed'; }), [], 'writes outside Site_Feed');
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
    'fvg', 'gapup', 'watchLog', 'mitigatedLog', 'alerts', 'indices', 'ipos', 'newIpos', 'priceBands', 'ipoTracker']);
  assert.strictEqual(d.generated, r.readAt);
  assert.strictEqual(d.source, 'Google Sheet (live feed)');
  assert.strictEqual(d.asOf, '2026-10-20 18:45');
  assert.ok(!('fvgBacktest' in d), 'no FVG Backtest tab -> no key');
  assert.strictEqual(r.stored, false, 'no stored copy yet: built on demand');
  assert.strictEqual(r.builtAt, r.readAt);
  onlySiteFeedWrites(env);
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
  const HDR = ['Company', 'Symbol', 'Opens', 'Closes', 'Listing date', 'Price range', 'Issue size (shares)', 'Note'];
  assert.deepStrictEqual(d.ipoTracker, {
    note: 'Updated 2026-10-21 19:28 IST from NSE, read by your PC. Unofficial summary - check the offer document before applying.',
    warning: '',
    open: { cols: HDR, rows: [['BLS Polymers Limited', 'BLSPOLY', '2026-10-20', '2026-10-22', null, '\u20B9142 to \u20B9150', 11900000, 'Closes tomorrow']] },
    closed: { cols: HDR, rows: [] },
    upcoming: { cols: HDR, rows: [['M. K. Sons Fine Jewels Limited', 'MKSONS', '2026-10-28', '2026-10-30', null, '\u20B9153 to \u20B9162', 17000000, 'Opens in 7 days']] }
  }, 'IPO Tracker sections, "None" rows dropped');
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
  onlySiteFeedWrites(env);
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

// ---------------------------------------------------------------------
// Stored copy (hidden tab Site_Feed), the 30-minute refresh trigger and
// the narrow price snapshot. The mock's clock is frozen (opts.now) and
// moved with env.setNow; Script Properties and the sheet persist per env.
// ---------------------------------------------------------------------

/** 'YYYY-MM-DD HH:MM' IST -> ms */
function IST(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(s);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - 330 * 60000;
}
const WED = '2026-10-21';   // a Wednesday (trading day)
const SAT = '2026-10-24';
const TRIGGER_FN = 'ab_siteFeedTrigger_';
const PREPARING = { ok: false, error: 'site feed is being prepared - try again in a minute' };

function loadAt(at, wb, o) {
  o = o || {};
  return mock.loadCodeGs(wb || workbook(), {
    props: Object.assign({ AB_FEED_TOKEN: TOKEN }, o.props || {}), now: IST(at), triggers: o.triggers
  });
}
function meta(env, part) {
  const raw = env.props.getProperty(part === 'main' ? 'AB_SITE_FEED_META_MAIN' : 'AB_SITE_FEED_META_HISTORY');
  return raw ? JSON.parse(raw) : null;
}
function post(env, part) { return env.post({ action: 'site', part: part, token: TOKEN }); }
function resetIo(env) { env.reads.length = 0; env.ranges.length = 0; env.writes.length = 0; }
/** One Site_Feed column (1-based), trailing blanks dropped. */
function siteCol(env, col) {
  const v = env.sheet('Site_Feed').rows.map(function (r) { return r[col - 1] === undefined ? '' : r[col - 1]; });
  while (v.length && v[v.length - 1] === '') v.pop();
  return v;
}
function plain(v) { return JSON.parse(JSON.stringify(v)); }
function bigHistory(n) {
  const syms = [];
  for (let i = 0; i < n; i++) syms.push('SYM' + i);
  return history30(syms);
}
function siteTriggers(env) { return env.triggers.filter(function (t) { return t.handler === TRIGGER_FN; }); }
function freshCx(env) { return env.run('({ ss: SpreadsheetApp.getActiveSpreadsheet(), tz: "Asia/Kolkata", tabs: {}, dates: {} })'); }

test('stored copy: a build stores chunks + meta in the free slot and flips slots', () => {
  const env = loadAt(WED + ' 10:00', workbook({ history: bigHistory(1500) }));
  const s = plain(env.call('ab_siteBuild_', ['main', 'history'], 'test'));
  assert.deepStrictEqual(Object.keys(s), ['main', 'history']);
  ['main', 'history'].forEach(function (p) {
    assert.strictEqual(s[p].ok, true, s[p].error);
    assert.deepStrictEqual(Object.keys(s[p]), ['ok', 'ms', 'bytes', 'readAt']);
    assert.strictEqual(s[p].readAt, '2026-10-21 10:00');
    assert.strictEqual(s[p].bytes, meta(env, p).length);
  });
  const tab = env.sheet('Site_Feed');
  assert.ok(tab, 'Site_Feed tab created on first use');
  assert.strictEqual(tab.hidden, true);
  assert.strictEqual(tab.size.cols, 6, 'only the 6 slot columns (main, history, history60)');
  assert.strictEqual(env.run('SpreadsheetApp.getActiveSpreadsheet().getActiveSheet().getName()'), 'Main', 'the active tab is kept');

  const hm = meta(env, 'history'), mm = meta(env, 'main');
  assert.deepStrictEqual(Object.keys(hm), ['slot', 'chunks', 'length', 'id', 'readAt', 'readMs', 'builtAt', 'buildMs', 'by', 'fmt']);
  assert.strictEqual(hm.fmt, env.run('AB_SITE_FEED_FORMAT'), 'the format of the code that built it');
  assert.strictEqual(hm.slot, 0);
  assert.strictEqual(mm.slot, 0);
  assert.strictEqual(hm.readAt, '2026-10-21 10:00');
  assert.strictEqual(hm.readMs, IST(WED + ' 10:00'));
  assert.strictEqual(hm.builtAt, '2026-10-21 10:00');
  assert.strictEqual(hm.by, 'test');
  assert.strictEqual(typeof hm.buildMs, 'number');
  // the stored text is the JSON of exactly what ab_site_history_ returns
  const direct = JSON.stringify(env.call('ab_site_history_', freshCx(env)));
  assert.strictEqual(hm.length, direct.length);
  assert.ok(hm.chunks >= 3, 'history spans ' + hm.chunks + ' cells');
  const tag = '~' + hm.id + '~';
  const col3 = siteCol(env, 3);
  assert.strictEqual(col3.length, hm.chunks);
  col3.forEach(function (c, i) {
    assert.ok(c.startsWith(tag), 'cell ' + (i + 1) + ' carries the build id');
    assert.ok(c.length - tag.length <= 45000 && c.length < 50000, 'cell ' + (i + 1) + ' fits a Sheets cell');
  });
  assert.strictEqual(col3.map(function (c) { return c.slice(tag.length); }).join(''), direct);
  assert.strictEqual(siteCol(env, 1).length, mm.chunks);
  assert.deepStrictEqual(siteCol(env, 2), []);
  assert.deepStrictEqual(siteCol(env, 4), []);

  // the next build of main goes to slot 1 (col 2); slot 0 keeps the old copy a reader may still use
  const oldMain = siteCol(env, 1);
  env.setNow(IST(WED + ' 10:30'));
  assert.strictEqual(plain(env.call('ab_siteBuild_', ['main'], 'test')).main.ok, true);
  assert.strictEqual(meta(env, 'main').slot, 1);
  assert.strictEqual(meta(env, 'main').readAt, '2026-10-21 10:30');
  assert.strictEqual(siteCol(env, 2).length, meta(env, 'main').chunks);
  assert.deepStrictEqual(siteCol(env, 1), oldMain);
  assert.strictEqual(meta(env, 'history').slot, 0, 'history untouched');
  assert.strictEqual(meta(env, 'history').id, hm.id);

  // a smaller history: when the build comes back to slot 0, its leftover chunks are cleared
  env.sheet('History30').rows.length = 1 + 3 * 10;          // 10 symbols left
  env.call('ab_siteBuild_', ['history'], 'test');           // -> slot 1
  env.call('ab_siteBuild_', ['history'], 'test');           // -> slot 0
  const h3 = meta(env, 'history');
  assert.strictEqual(h3.slot, 0);
  assert.strictEqual(h3.chunks, 1);
  assert.strictEqual(siteCol(env, 3).length, 1, 'old chunks below the new copy are cleared');
  const r = post(env, 'history');
  assert.strictEqual(r.stored, true);
  assert.strictEqual(Object.keys(r.data.bars).length, 10);
});

test('stored copy: doPost answers from it - byte-identical data, no Main / History30 read', () => {
  const env = loadAt(WED + ' 10:00');
  const onDemandText = {};
  ['main', 'history'].forEach(function (part) {
    const first = post(env, part);
    onDemandText[part] = env.lastOutput.getContent();
    assert.strictEqual(first.ok, true, first.error);
    assert.strictEqual(first.stored, false, part + ': first request builds on demand');
    assert.ok(meta(env, part), part + ': and stores it');
  });
  env.setNow(IST(WED + ' 10:07'));
  ['main', 'history'].forEach(function (part) {
    resetIo(env);
    const r = post(env, part);
    const text = env.lastOutput.getContent();
    assert.strictEqual(r.stored, true, part);
    assert.strictEqual(r.readAt, '2026-10-21 10:00', part + ': readAt = when the sheet was read');
    assert.strictEqual(r.builtAt, '2026-10-21 10:00');
    assert.strictEqual(env.lastOutput.getMimeType(), 'application/json');
    assert.ok(text.startsWith('{"ok":true,"part":"' + part + '","readAt":"2026-10-21 10:00","builtAt":"2026-10-21 10:00",' +
      '"stored":true,"tz":"Asia/Kolkata","data":{'), part + ' envelope');
    assert.strictEqual(text, onDemandText[part].replace('"stored":false', '"stored":true'), part + ': byte-identical to the on-demand answer');
    // nothing but the stored copy was read; nothing written
    assert.ok(!env.reads.includes('Main') && !env.reads.includes('History30'), part + ': ' + env.reads.join(', '));
    assert.deepStrictEqual(env.ranges.filter(function (g) { return g.sheet !== 'Site_Feed'; }), [], part);
    assert.deepStrictEqual(env.writes, [], part + ': serving writes nothing');
    // and the data is exactly what ab_site_main_ / ab_site_history_ return
    const direct = part === 'main' ? env.call('ab_site_main_', freshCx(env), '2026-10-21 10:00') : env.call('ab_site_history_', freshCx(env));
    assert.strictEqual(JSON.stringify(r.data), JSON.stringify(direct), part);
  });
});

test('stored copy: chunks of <= 45,000 characters round-trip, an emoji is never split', () => {
  const env = loadAt(WED + ' 10:00');
  const chunks = function (t) { return plain(env.call('ab_siteFeedChunks_', t)); };
  assert.deepStrictEqual(chunks('x'.repeat(45000)).map(function (c) { return c.length; }), [45000]);
  assert.deepStrictEqual(chunks('x'.repeat(90000)).map(function (c) { return c.length; }), [45000, 45000]);
  assert.deepStrictEqual(chunks('x'.repeat(90001)).map(function (c) { return c.length; }), [45000, 45000, 1]);
  const rocket = 'x'.repeat(44999) + '🚀' + 'y'.repeat(10);          // straddles the boundary
  assert.deepStrictEqual(chunks(rocket).map(function (c) { return c.length; }), [44999, 12]);
  assert.strictEqual(chunks(rocket).join(''), rocket);

  // through the sheet: several cells, exact text back, a valid reply
  const value = 'x'.repeat(44993) + '😀' + 'é€😀'.repeat(15000) + 'z'.repeat(30000);
  const text = JSON.stringify({ a: value });
  assert.strictEqual(text.charCodeAt(44999), 0xD83D, 'the emoji sits on the first boundary');
  const info = { readAt: '2026-10-21 10:00', readMs: IST(WED + ' 10:00'), builtAt: '2026-10-21 10:00', buildMs: 5, by: 'test' };
  env.call('ab_siteFeedStore_', 'main', text, info);
  env.sheet('Site_Feed').size.rows = 2;                     // a short tab: the store adds rows
  env.call('ab_siteFeedStore_', 'main', text, info);
  assert.ok(env.sheet('Site_Feed').size.rows >= meta(env, 'main').chunks);
  assert.ok(meta(env, 'main').chunks >= 4);
  assert.strictEqual(env.call('ab_siteFeedRead_', 'main').text, text);
  siteCol(env, 2).forEach(function (cell) {
    const last = cell.charCodeAt(cell.length - 1);
    assert.ok(!(last >= 0xD800 && last <= 0xDBFF), 'no cell ends in half an emoji');
  });
  const r = post(env, 'main');
  assert.strictEqual(r.stored, true);
  assert.strictEqual(r.data.a, value);
});

test('stored copy: a corrupt or mismatched copy counts as missing and is rebuilt on demand', () => {
  const setMeta = function (env, f) {
    const m = meta(env, 'main');
    f(m);
    env.props.setProperty('AB_SITE_FEED_META_MAIN', JSON.stringify(m));
  };
  const cases = [
    ['total length off by one', function (env) { setMeta(env, function (m) { m.length += 1; }); }],
    ['one chunk less', function (env) { setMeta(env, function (m) { m.chunks -= 1; m.length -= 1; }); }],
    ['a cell of another build', function (env) { const g = env.sheet('Site_Feed').rows; g[0][0] = g[0][0].replace(/^~[^~]*~/, '~0123456789~'); }],
    ['a cell cleared', function (env) { env.sheet('Site_Feed').rows[0][0] = ''; }],
    ['a cell that reads back as a number', function (env) { env.sheet('Site_Feed').rows[0][0] = 12345; }],
    ['meta points at the empty slot', function (env) { setMeta(env, function (m) { m.slot = 1; }); }],
    ['meta is not JSON', function (env) { env.props.setProperty('AB_SITE_FEED_META_MAIN', '{oops'); }],
    ['meta without chunks', function (env) { setMeta(env, function (m) { m.chunks = 0; }); }],
    ['Site_Feed tab deleted', function (env) { env.run('(function (ss) { ss.deleteSheet(ss.getSheetByName("Site_Feed")); })(SpreadsheetApp.getActiveSpreadsheet())'); }]
  ];
  cases.forEach(function (c) {
    const env = loadAt(WED + ' 10:00', workbook({ mainExtra: [['', 'BIG', 'x'.repeat(50000)]] }));
    assert.strictEqual(post(env, 'main').stored, false, c[0]);
    assert.ok(meta(env, 'main').chunks >= 2, c[0] + ': the copy spans 2+ cells');
    assert.ok(env.call('ab_siteFeedRead_', 'main'), c[0] + ': readable before');
    c[1](env);
    assert.strictEqual(env.call('ab_siteFeedRead_', 'main'), null, c[0]);
    env.setNow(IST(WED + ' 10:05'));
    const r = post(env, 'main');
    assert.strictEqual(r.ok, true, c[0] + ': ' + r.error);
    assert.strictEqual(r.stored, false, c[0] + ': rebuilt');
    assert.strictEqual(r.readAt, '2026-10-21 10:05', c[0]);
    assert.strictEqual(post(env, 'main').stored, true, c[0] + ': stored again');
  });
});

test('stored copy: one build at a time (AB_SITE_BUILDING_SINCE), never the script lock', () => {
  const at = IST(WED + ' 10:00');
  const env = loadAt(WED + ' 10:00', null, { props: { AB_SITE_BUILDING_SINCE: String(at - 60000) } });
  env.run('LockService.getScriptLock = LockService.getDocumentLock = LockService.getUserLock = ' +
    'function () { throw new Error("the site feed must not take a lock"); }');
  // another request started building a minute ago and nothing is stored yet
  resetIo(env);
  assert.deepStrictEqual(post(env, 'main'), PREPARING);
  assert.ok(!env.reads.includes('Main'), 'no second build');
  assert.deepStrictEqual(env.writes, []);
  assert.deepStrictEqual(plain(env.call('ab_siteBuild_', ['main', 'history'], 'test')), {
    main: { ok: false, busy: true, error: 'another build is running' },
    history: { ok: false, busy: true, error: 'another build is running' }
  });
  env.call(TRIGGER_FN);
  assert.strictEqual(meta(env, 'main'), null, 'the trigger waits too');
  assert.strictEqual(env.props.getProperty('AB_SITE_BUILDING_SINCE'), String(at - 60000), 'the other run\'s mark is left alone');
  // a mark 10 minutes old belongs to a run that died: ignored
  env.setNow(at + 8 * 60000);
  assert.deepStrictEqual(post(env, 'main'), PREPARING);
  env.setNow(at + 9 * 60000);
  const r = post(env, 'main');
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.stored, false);
  assert.strictEqual(env.props.getProperty('AB_SITE_BUILDING_SINCE'), null, 'cleared after the build');
  // a running build does not hold up readers of a stored copy
  env.props.setProperty('AB_SITE_BUILDING_SINCE', String(env.now()));
  assert.strictEqual(post(env, 'main').stored, true);
  env.props.deleteProperty('AB_SITE_BUILDING_SINCE');
  // the mark is cleared when a build fails too (History30 being rewritten)
  env.sheet('History30').rows.length = 4;
  assert.deepStrictEqual(plain(env.call('ab_siteBuild_', ['history'], 'test')),
    { history: { ok: false, error: 'sheet is updating (History30 has 1 of 5 symbols) - try again shortly' } });
  assert.strictEqual(env.props.getProperty('AB_SITE_BUILDING_SINCE'), null);
  assert.strictEqual(meta(env, 'history'), null, 'a failed build stores nothing');
  assert.deepStrictEqual(post(env, 'history'), { ok: false, error: 'sheet is updating (History30 has 1 of 5 symbols) - try again shortly' });
});

test('stored copy: a failed build keeps the previous copy, which is still served', () => {
  const env = loadAt(WED + ' 14:00');
  env.call('ab_siteBuild_', ['main', 'history'], 'test');
  const before = meta(env, 'history');
  const keep = env.sheet('History30').rows.slice();
  env.sheet('History30').rows.length = 4;                   // Phase 1 rewriting History30
  env.setNow(IST(WED + ' 19:15'));
  const s = plain(env.call('ab_siteBuild_', ['main', 'history'], 'test'));
  assert.strictEqual(s.main.ok, true);
  assert.strictEqual(s.history.ok, false);
  assert.deepStrictEqual(meta(env, 'history'), before);
  const r = post(env, 'history');
  assert.strictEqual(r.stored, true);
  assert.strictEqual(r.readAt, '2026-10-21 14:00');
  assert.deepStrictEqual(Object.keys(r.data.bars), ['TCS', 'HDFCBANK', 'SBIN']);
  keep.slice(4).forEach(function (row) { env.sheet('History30').rows.push(row); });
  env.setNow(IST(WED + ' 19:45'));
  env.call(TRIGGER_FN);
  assert.strictEqual(meta(env, 'history').readAt, '2026-10-21 19:45', 'the next run picks it up');
});

test('refresh trigger: doPost creates it once (checked at most every 6 h), duplicates are removed', () => {
  const env = loadAt(WED + ' 10:00', null, { triggers: ['checkIntradayAlerts_'] });
  assert.strictEqual(post(env, 'main').ok, true);
  assert.strictEqual(siteTriggers(env).length, 1);
  assert.strictEqual(siteTriggers(env)[0].everyMinutes, 30);
  const looked = env.triggerReads;
  env.setNow(IST(WED + ' 15:59'));
  post(env, 'history');
  post(env, 'main');
  assert.strictEqual(env.triggerReads, looked, 'not looked at again within 6 h (requests stay fast)');
  // someone deleted it: the first request after 6 h puts it back
  env.triggers.splice(env.triggers.indexOf(siteTriggers(env)[0]), 1);
  env.setNow(IST(WED + ' 16:01'));
  post(env, 'main');
  assert.strictEqual(siteTriggers(env).length, 1);
  assert.deepStrictEqual(env.triggers.map(function (t) { return t.handler; }).sort(), ['ab_siteFeedTrigger_', 'checkIntradayAlerts_']);

  const dup = loadAt(WED + ' 10:00', null, { triggers: [TRIGGER_FN, 'checkIntradayAlerts_', TRIGGER_FN, TRIGGER_FN] });
  assert.deepStrictEqual(plain(dup.call('ab_ensureSiteFeedTrigger_')), { created: false, removed: 2 });
  assert.deepStrictEqual(dup.triggers.map(function (t) { return t.handler; }), [TRIGGER_FN, 'checkIntradayAlerts_']);
  assert.deepStrictEqual(plain(dup.call('ab_ensureSiteFeedTrigger_')), { created: false, removed: 0 });

  // a trigger problem never breaks the answer (and is not retried on every request)
  const broken = loadAt(WED + ' 10:00');
  broken.run('ScriptApp.getProjectTriggers = function () { throw new Error("Authorization is required to perform that action."); }');
  const r = post(broken, 'main');
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(post(broken, 'main').stored, true);
  assert.ok(broken.props.getProperty('AB_SITE_FEED_TRIGGER_CHECKED'));
});

test('refresh trigger: skips while fresh; main after 25 min in the busy windows, 3 h otherwise', () => {
  const env = loadAt(WED + ' 10:00');
  const run = function (at) {
    env.setNow(IST(at));
    resetIo(env);
    env.call(TRIGGER_FN);
    return meta(env, 'main').readAt.slice(5);
  };
  assert.strictEqual(run(WED + ' 10:00'), '10-21 10:00', 'nothing stored: built');
  assert.strictEqual(meta(env, 'history').readAt, '2026-10-21 10:00');
  assert.strictEqual(meta(env, 'main').by, 'auto');
  // fresh: back at once, without touching the spreadsheet
  assert.strictEqual(run(WED + ' 10:24'), '10-21 10:00');
  assert.deepStrictEqual(env.reads, []);
  assert.deepStrictEqual(env.ranges, []);
  assert.deepStrictEqual(env.writes, []);
  // weekday 09:00-16:15: 25 minutes
  assert.strictEqual(run(WED + ' 10:25'), '10-21 10:25');
  assert.strictEqual(meta(env, 'history').readAt, '2026-10-21 10:00', 'history: 6 h');
  assert.strictEqual(run(WED + ' 16:15'), '10-21 16:15');
  assert.strictEqual(run(WED + ' 16:45'), '10-21 16:15', '16:16-17:29: 3 h');
  assert.strictEqual(run(WED + ' 17:29'), '10-21 16:15');
  // every day 17:30-21:30: 25 minutes
  assert.strictEqual(run(WED + ' 17:30'), '10-21 17:30');
  assert.strictEqual(run(WED + ' 17:54'), '10-21 17:30');
  assert.strictEqual(run(WED + ' 17:55'), '10-21 17:55');
  assert.strictEqual(run(WED + ' 21:30'), '10-21 21:30');
  assert.strictEqual(run(WED + ' 21:59'), '10-21 21:30', 'after 21:30: 3 h');
  assert.strictEqual(run('2026-10-22 00:29'), '10-21 21:30');
  assert.strictEqual(run('2026-10-22 00:30'), '10-22 00:30');
  assert.strictEqual(run('2026-10-22 08:59'), '10-22 08:59', '3 h');
  assert.strictEqual(run('2026-10-22 09:20'), '10-22 08:59', 'market window: 25 min');
  assert.strictEqual(run('2026-10-22 09:24'), '10-22 09:24');
  // weekend: no market window, the evening window still applies
  assert.strictEqual(run(SAT + ' 10:00'), '10-24 10:00');
  assert.strictEqual(run(SAT + ' 10:30'), '10-24 10:00');
  assert.strictEqual(run(SAT + ' 12:59'), '10-24 10:00');
  assert.strictEqual(run(SAT + ' 13:00'), '10-24 13:00');
  assert.strictEqual(run(SAT + ' 17:40'), '10-24 17:40');
  assert.strictEqual(run(SAT + ' 18:04'), '10-24 17:40');
  assert.strictEqual(run(SAT + ' 18:05'), '10-24 18:05');
});

test('refresh trigger: history every 6 h, and once from the evening cutoff (last phase time + 25 min) when read before it', () => {
  const env = loadAt(WED + ' 14:00');
  assert.strictEqual(env.call('ab_siteEveningMin_'), 19 * 60 + 26, 'Phase 3 at 19:01 + 25 min (nearMinute +/-15, run <= 6)');
  const hist = function (at) {
    env.setNow(IST(at));
    env.call(TRIGGER_FN);
    return meta(env, 'history').readAt;
  };
  assert.strictEqual(hist(WED + ' 14:00'), '2026-10-21 14:00');
  assert.strictEqual(hist(WED + ' 19:25'), '2026-10-21 14:00', 'not before the cutoff');
  assert.strictEqual(hist(WED + ' 19:26'), '2026-10-21 19:26', 'read before the cutoff today: rebuilt once');
  assert.strictEqual(hist(WED + ' 19:56'), '2026-10-21 19:26', 'read after it: done for today');
  assert.strictEqual(hist(WED + ' 23:56'), '2026-10-21 19:26');
  assert.strictEqual(hist('2026-10-22 01:25'), '2026-10-21 19:26', 'under 6 h');
  assert.strictEqual(hist('2026-10-22 01:26'), '2026-10-22 01:26', '6 h');
  // a copy read during the phases (19:07, 19:25) is not the evening copy: the next run after the cutoff rebuilds it
  ['19:07', '19:25'].forEach(function (t) {
    const late = loadAt(WED + ' ' + t);
    late.call(TRIGGER_FN);
    late.setNow(IST(WED + ' 19:25'));
    late.call(TRIGGER_FN);
    assert.strictEqual(meta(late, 'history').readAt, WED + ' ' + t, t + ': kept until the cutoff');
    late.setNow(IST(WED + ' 19:37'));
    late.call(TRIGGER_FN);
    assert.strictEqual(meta(late, 'history').readAt, '2026-10-21 19:37', t + ': rebuilt after the cutoff');
  });
  // Phase 3 writes ATR14 (PatternData Z) at ~19:19, after a 19:16 build: the site has it from the next run
  const atr = loadAt(WED + ' 19:16');
  atr.call(TRIGGER_FN);
  assert.strictEqual(post(atr, 'history').data.sheetTags.TCS[3], 12.5);
  atr.sheet('PatternData').rows[1][25] = 99.9;
  atr.setNow(IST(WED + ' 19:46'));
  atr.call(TRIGGER_FN);
  const got = post(atr, 'history');
  assert.strictEqual(got.readAt, '2026-10-21 19:46');
  assert.strictEqual(got.data.sheetTags.TCS[3], 99.9);
  // "rebuild now" at 13:05 and the trigger at :07 / :37: the 6-h cycle alone would settle on 19:07 every
  // day (before Phase 3); every evening still gets a copy read after the cutoff
  const cyc = loadAt(WED + ' 13:05');
  cyc.call('runSiteFeedRebuildNow');
  const builds = [];
  for (let t = IST(WED + ' 13:07'); t <= IST('2026-10-23 23:59'); t += 30 * 60000) {
    cyc.setNow(t);
    cyc.call(TRIGGER_FN);
    const ra = meta(cyc, 'history').readAt;
    if (builds[builds.length - 1] !== ra) builds.push(ra);
  }
  ['2026-10-21', '2026-10-22', '2026-10-23'].forEach(function (d) {
    assert.ok(builds.includes(d + ' 19:37'), d + ' evening copy after 19:26: ' + builds.join(', '));
  });
  // the rule is the same on a weekend evening (no Phase 1, one cheap rebuild)
  const fmt = env.run('AB_SITE_FEED_FORMAT');
  const due = function (readAt, now) {
    return env.call('ab_siteFeedDue_', 'history', { readMs: IST(readAt), readAt: readAt, fmt: fmt }, IST(now));
  };
  assert.strictEqual(due(SAT + ' 15:00', SAT + ' 19:30'), true);
  assert.strictEqual(due(SAT + ' 19:27', SAT + ' 23:00'), false);
  assert.strictEqual(due(SAT + ' 13:00', SAT + ' 19:00'), true, '6 h');
  assert.strictEqual(env.call('ab_siteFeedDue_', 'history', null, IST(SAT + ' 10:00')), true, 'nothing stored');
});

test('refresh trigger: the evening cutoff follows the Control Panel phase times', () => {
  const withTimes = function (rows) {
    const wb = workbook();
    wb.sheets = wb.sheets.map(function (x) { return x.name === 'Control Panel' ? sheet('Control Panel', [['Key', 'Value']].concat(rows)) : x; });
    return loadAt(WED + ' 14:00', wb);
  };
  const late = withTimes([['AB_DAILY_P1_TIME', '20:00'], ['AB_DAILY_P3_TIME', '20:40']]);
  assert.strictEqual(late.call('ab_siteEveningMin_'), 21 * 60 + 5, 'Phase 3 at 20:40 + 25 min');
  late.call(TRIGGER_FN);
  late.setNow(IST(WED + ' 19:40'));
  late.call(TRIGGER_FN);
  assert.strictEqual(meta(late, 'history').readAt, '2026-10-21 14:00', 'the default 19:26 no longer applies');
  late.setNow(IST(WED + ' 21:10'));
  late.call(TRIGGER_FN);
  assert.strictEqual(meta(late, 'history').readAt, '2026-10-21 21:10');
  // Phase 2 moved last; a cutoff past midnight is capped at 23:59
  assert.strictEqual(withTimes([['AB_DAILY_P2_TIME', '19:50']]).call('ab_siteEveningMin_'), 20 * 60 + 15);
  assert.strictEqual(withTimes([['AB_DAILY_P3_TIME', '23:50']]).call('ab_siteEveningMin_'), 23 * 60 + 59);
});

test('refresh trigger: on weekdays main is rebuilt once from 16:00 when read before 16:00 (trigger at :16 / :46)', () => {
  const env = loadAt(WED + ' 09:16');
  const builds = [];
  for (let t = IST(WED + ' 09:16'); t <= IST(WED + ' 18:30'); t += 30 * 60000) {
    env.setNow(t);
    env.call(TRIGGER_FN);
    const ra = meta(env, 'main').readAt.slice(11);
    if (builds[builds.length - 1] !== ra) builds.push(ra);
  }
  assert.deepStrictEqual(builds.slice(-5), ['15:16', '15:46', '16:16', '17:46', '18:16'],
    'a read at 15:46 (~15:26 prices) is not left as the EOD copy until 17:46');
  const fmt = env.run('AB_SITE_FEED_FORMAT');
  const due = function (readAt, now) {
    return env.call('ab_siteFeedDue_', 'main', { readMs: IST(readAt), readAt: readAt, fmt: fmt }, IST(now));
  };
  assert.strictEqual(due(WED + ' 15:50', WED + ' 15:59'), false);
  assert.strictEqual(due(WED + ' 15:50', WED + ' 16:00'), true, 'from 16:00');
  assert.strictEqual(due(WED + ' 16:00', WED + ' 16:29'), false, 'read at 16:00: settled');
  assert.strictEqual(due(WED + ' 15:59', WED + ' 17:29'), true);
  assert.strictEqual(due('2026-10-20 15:59', WED + ' 10:00'), true, 'market window: 25 min');
  assert.strictEqual(due(WED + ' 07:00', WED + ' 08:59'), false, 'before 16:00: only the age counts');
  assert.strictEqual(due(SAT + ' 15:00', SAT + ' 16:30'), false, 'weekend: no session to settle');
});

test('refresh trigger: a run starts no build after ~4.5 minutes', () => {
  const t0 = IST(WED + ' 10:00');
  const slowMain = function (env) { env.onRead = function (g) { if (g.sheet === 'Main') env.setNow(t0 + 4 * 60000); }; };
  const env = loadAt(WED + ' 10:00');
  slowMain(env);
  env.call(TRIGGER_FN);
  env.onRead = null;
  assert.ok(meta(env, 'main'), 'the first part always runs');
  assert.strictEqual(meta(env, 'history'), null, 'no time left for history');
  assert.strictEqual(env.props.getProperty('AB_SITE_BUILDING_SINCE'), null);
  env.setNow(t0 + 30 * 60000);
  env.call(TRIGGER_FN);
  assert.strictEqual(meta(env, 'history').readAt, '2026-10-21 10:30', 'the next run builds it');

  const env2 = loadAt(WED + ' 10:00');
  slowMain(env2);
  const s = plain(env2.call('ab_siteBuild_', ['main', 'history'], 'auto', { deadline: t0 + 270000 }));
  assert.strictEqual(s.main.ok, true);
  assert.deepStrictEqual(s.history, { ok: false, error: 'skipped - no time left in this run' });
});

test('menu: "rebuild now" builds both parts and switches auto-refresh on; "stop auto-refresh" removes it for good', () => {
  const src = require('fs').readFileSync(mock.CODE_GS, 'utf8');
  assert.ok(src.includes(".addItem('Website feed: setup info (read-only token)', 'runFeedSetupInfo')\n" +
    "        .addItem('Website feed: rebuild now', 'runSiteFeedRebuildNow')\n" +
    "        .addItem('Website feed: stop auto-refresh', 'runSiteFeedStopAutoRefresh')"), 'menu items under 3. next to setup info');

  const env = loadAt(WED + ' 18:50');
  env.call('runSiteFeedRebuildNow');
  const text = env.alerts[0].join('\n');
  assert.match(text, /^Website feed - rebuild now\n/);
  assert.match(text, /main: OK - \d+ KB in \d+ s \(sheet read 2026-10-21 18:50 IST\)/);
  assert.match(text, /history: OK - \d+ KB in \d+ s/);
  assert.match(text, /Auto-refresh: ON - every 30 minutes \(switched on now\)/);
  assert.strictEqual(siteTriggers(env).length, 1);
  assert.strictEqual(meta(env, 'main').by, 'menu');

  env.call('runSiteFeedStopAutoRefresh');
  assert.strictEqual(siteTriggers(env).length, 0);
  assert.match(env.alerts[1].join('\n'), /refresh trigger was removed[\s\S]*rebuild now/);
  env.setNow(IST('2026-10-22 08:00'));                     // > 6 h later: doPost does not bring it back
  assert.strictEqual(post(env, 'main').stored, true);
  assert.strictEqual(siteTriggers(env).length, 0);

  env.sheet('History30').rows.length = 4;
  env.call('runSiteFeedRebuildNow');
  assert.strictEqual(siteTriggers(env).length, 1, 'switched back on');
  assert.strictEqual(env.props.getProperty('AB_SITE_FEED_AUTO_OFF'), null);
  const t2 = env.alerts[2].join('\n');
  assert.match(t2, /main: OK/);
  assert.match(t2, /history: NOT rebuilt - sheet is updating \(History30 has 1 of 5 symbols\) - try again shortly\. The previous copy \(if any\) is still used\./);
  assert.strictEqual(meta(env, 'history').readAt, '2026-10-21 18:50');
});

// The snapshot as it was before the narrow read (whole Main via ab_getMainLayout_).
const OLD_SNAPSHOT_SRC = `(function (req) {
  const real = ab_feedToken_(false);
  if (!real || req.token !== real) return ab_bridgeJson_({ ok: false, error: 'bad token' });
  try {
    const layout = ab_getMainLayout_();
    const rows = [];
    for (let r = layout.headerRowIdx + 1; r < layout.data.length; r++) {
      const row = layout.data[r];
      const sym = String(row[layout.symbol] || '').trim().toUpperCase();
      if (!sym) continue;
      if (sym === 'SYMBOL') break;
      if (!AB_FEED_TICKER_RE.test(sym)) continue;
      const num = function (v) { return (v === '' || v === null || v === undefined) ? NaN : Number(v); };
      const price = num(row[layout.mktPrice]);
      const chg = layout.pctChange === -1 ? NaN : num(row[layout.pctChange]);
      rows.push([sym, isFinite(price) && price > 0 ? price : null, isFinite(chg) ? chg : null]);
    }
    const now = Utilities.formatDate(new Date(), AB_TZ, 'yyyy-MM-dd HH:mm');
    return ab_bridgeJson_({ ok: true, asOf: now, readAt: now, delayMinutes: 20,
      source: 'GOOGLEFINANCE via Stock Blueprint sheet', cols: ['sym', 'price', 'chg'], rows: rows });
  } catch (err) {
    return ab_bridgeJson_({ ok: false, error: err.message });
  }
})`;

test('snapshot: the narrow read answers exactly like the old whole-Main read', () => {
  const ALERT = ['Price Fall Alert Price', 'Breakout Alert Price', 'Triggered Y/N'];
  const D = new Date(Date.UTC(2026, 9, 1));
  const mains = {
    'the test workbook': mainSheet(),
    'blank rows, notes, a repeated header': mainSheet([
      ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
      ['', 'Note: prices are ~20 min delayed', '', '', '', 5, 1],
      ['', 'm&m', 'Mahindra', 'Auto', '', 3000, 0.4],
      ['', ' bajaj-auto ', 'Bajaj', 'Auto', '', '9,000', '1.5'],
      ['', 'ZERO', 'Zero', '', '', 0, -0],
      ['', 'NEG', 'Neg', '', '', -5, 'x'],
      ['', 'BOOL', 'Bool', '', '', true, false],
      ['', 'DATE', 'Date', '', '', D, D],
      ['', 'SYMBOL', 'StockName'],
      ['', 'AFTERHEADER', 'Second table', '', '', 10, 1]
    ]),
    'header on row 5, columns apart and out of order': sheet('Main', [
      ['Stock Blueprint'], [''], ['notes'], [''],
      ['% Change', 'x', 'StockName', ' MKT Price ', 'y', 'SYMBOL '].concat(ALERT),
      [1.5, 'a', 'Tata', 3050, 'b', 'TCS'],
      ['', '', '', '', '', ''],
      [-0.2, '', 'Infy', '1500', '', 'INFY', '', '', '', 'extra', 'cells'],
      ['', '', '', 999, '', '']
    ]),
    'no % Change column': sheet('Main', [['x'], ['SYMBOL', 'StockName', 'MKT Price'].concat(ALERT), ['TCS', 'Tata', 3050]]),
    'no MKT Price column': sheet('Main', [['x'], ['SYMBOL', 'StockName', '% Change'].concat(ALERT), ['TCS', 'Tata', 1.5]]),
    'an alert column missing': sheet('Main', [['x'], ['SYMBOL', 'StockName', 'MKT Price', 'Price Fall Alert Price'], ['TCS', 'Tata', 3050]]),
    'no StockName / SYMBOL header row': sheet('Main', [['x'], ['Symbol', 'Name', 'MKT Price'], ['TCS', 'Tata', 3050]]),
    'header below row 10': sheet('Main', [[''], [''], [''], [''], [''], [''], [''], [''], [''], [''],
      ['SYMBOL', 'StockName', 'MKT Price'].concat(ALERT), ['TCS', 'Tata', 3050]]),
    'header only': sheet('Main', [['SYMBOL', 'StockName', 'MKT Price', '% Change'].concat(ALERT)]),
    'empty Main tab': sheet('Main', []),
    'no Main tab': null
  };
  Object.keys(mains).forEach(function (label) {
    const env = loadAt(WED + ' 11:00', { sheets: mains[label] ? [mains[label]] : [] });
    const oldText = env.run(OLD_SNAPSHOT_SRC)({ action: 'snapshot', token: TOKEN }).getContent();
    const newText = env.call('doPost', { postData: { contents: JSON.stringify({ action: 'snapshot', token: TOKEN }) } }).getContent();
    assert.strictEqual(newText, oldText, label);
  });
  // the cases above cover both answers
  const ok = loadAt(WED + ' 11:00', { sheets: [mains['header on row 5, columns apart and out of order']] })
    .post({ action: 'snapshot', token: TOKEN });
  assert.deepStrictEqual(ok.rows, [['TCS', 3050, 1.5], ['INFY', 1500, -0.2]]);
  const err = loadAt(WED + ' 11:00', { sheets: [mains['an alert column missing']] }).post({ action: 'snapshot', token: TOKEN });
  assert.deepStrictEqual(err, { ok: false, error: 'Main is missing expected alert column(s): Breakout Alert Price, Triggered Y/N' });
});

test('snapshot: reads the header rows and the 3 columns only', () => {
  const hdr = [];
  for (let c = 0; c < 40; c++) hdr.push('Col ' + c);
  hdr[3] = 'SYMBOL'; hdr[4] = 'StockName'; hdr[20] = 'MKT Price'; hdr[21] = '% Change';
  hdr[30] = 'Price Fall Alert Price'; hdr[31] = 'Breakout Alert Price'; hdr[32] = 'Triggered Y/N';
  const rows = [['Stock Blueprint'], hdr];
  for (let i = 0; i < 300; i++) {
    const r = hdr.map(function (h, c) { return '=formula ' + c; });
    r[3] = 'S' + i; r[4] = 'Name ' + i; r[20] = 100 + i; r[21] = i / 100;
    rows.push(r);
  }
  const env = loadAt(WED + ' 11:00', { sheets: [sheet('Main', rows)] });
  resetIo(env);
  const r = env.post({ action: 'snapshot', token: TOKEN });
  assert.strictEqual(r.rows.length, 300);
  assert.deepStrictEqual(r.rows[7], ['S7', 107, 0.07]);
  assert.deepStrictEqual(env.ranges.map(function (g) { return [g.sheet, g.row, g.col, g.rows, g.cols]; }), [
    ['Main', 1, 1, 10, 40],          // header search: first 10 rows
    ['Main', 3, 4, 300, 1],          // SYMBOL
    ['Main', 3, 21, 300, 2]          // MKT Price + % Change, side by side: one read
  ]);
  assert.deepStrictEqual(env.writes, []);
  assert.strictEqual(env.post({ action: 'snapshot', token: 'nope' }).error, 'bad token');
});

test('first request with no stored copy builds it; a stored copy is served without rebuilding', () => {
  const env = loadAt(WED + ' 10:00');
  assert.strictEqual(env.sheet('Site_Feed'), null);
  const r = post(env, 'history');
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.stored, false);
  assert.strictEqual(r.readAt, '2026-10-21 10:00');
  assert.strictEqual(meta(env, 'history').by, 'request');
  assert.strictEqual(meta(env, 'main'), null, 'only the part asked for');
  env.setNow(IST(WED + ' 12:00'));                         // old, but the stored copy is still what is served
  resetIo(env);
  const again = post(env, 'history');
  assert.strictEqual(again.stored, true);
  assert.strictEqual(again.readAt, '2026-10-21 10:00');
  assert.deepStrictEqual(again.data, r.data);
  assert.deepStrictEqual(env.writes, []);
});

test('stored copy: two overlapping builds never leave the meta on the other build\'s chunks; each clears only its own mark', () => {
  // A Script Property is not a lock: two runs can both find no build running. Build B runs inside build A,
  // between A's write (setValues + flush) and A's meta flip; both picked the same free slot.
  const env = loadAt(WED + ' 10:00');
  env.call('ab_siteBuild_', ['main'], 'menu');                                  // a good copy in slot 0
  let inner = null;
  env.context.__hook = function () {
    if (inner) return;
    inner = {};
    env.props.deleteProperty('AB_SITE_BUILDING_SINCE');                          // B saw no build running
    env.setNow(IST(WED + ' 10:01'));
    inner.res = plain(env.call('ab_siteBuild_', ['main'], 'auto'));
  };
  env.run('SpreadsheetApp.flush = function () { __hook(); }');
  env.setNow(IST(WED + ' 10:00'));
  const a = plain(env.call('ab_siteBuild_', ['main'], 'request'));
  assert.strictEqual(inner.res.main.ok, true, 'B stored its copy');
  assert.deepStrictEqual(a, { main: { ok: false, busy: true, error: 'another build is running' } }, 'A gave way');
  const m = meta(env, 'main');
  assert.strictEqual(m.by, 'auto');
  assert.ok(env.sheet('Site_Feed').rows[0][m.slot].startsWith('~' + m.id + '~'), 'meta and cells are the same build');
  assert.ok(env.call('ab_siteFeedRead_', 'main'), 'the stored copy stays readable');
  env.setNow(IST(WED + ' 10:05'));
  assert.strictEqual(post(env, 'main').stored, true, 'the next request is served at once');

  // another run took the mark over while this one was writing: no flip (the old copy is kept), its mark is left alone
  const env2 = loadAt(WED + ' 10:00');
  env2.call('ab_siteBuild_', ['main'], 'menu');
  const before = meta(env2, 'main');
  const other = String(IST(WED + ' 10:00')) + ':other';
  env2.context.__hook = function () { env2.props.setProperty('AB_SITE_BUILDING_SINCE', other); };
  env2.run('SpreadsheetApp.flush = function () { __hook(); }');
  assert.deepStrictEqual(plain(env2.call('ab_siteBuild_', ['main'], 'auto')).main, { ok: false, busy: true, error: 'another build is running' });
  assert.deepStrictEqual(meta(env2, 'main'), before);
  assert.ok(env2.call('ab_siteFeedRead_', 'main'));
  assert.strictEqual(env2.props.getProperty('AB_SITE_BUILDING_SINCE'), other, 'the other run keeps its guard');
  assert.strictEqual(env2.call('ab_siteBuildRunning_'), true, "'<ms>:<run id>' marks count as running");

  // the slot's first cell was overwritten by another build (same mark): no flip either
  const env3 = loadAt(WED + ' 10:00');
  env3.call('ab_siteBuild_', ['main'], 'menu');
  const before3 = meta(env3, 'main');
  env3.context.__hook = function () { env3.sheet('Site_Feed').rows[0][1] = '~someoneelse~{}'; };
  env3.run('SpreadsheetApp.flush = function () { __hook(); }');
  assert.strictEqual(plain(env3.call('ab_siteBuild_', ['main'], 'auto')).main.busy, true);
  assert.deepStrictEqual(meta(env3, 'main'), before3);
  assert.strictEqual(env3.props.getProperty('AB_SITE_BUILDING_SINCE'), null, 'its own mark is cleared');
});

test('stored copy: a Site_Feed tab made by another run a moment ago is used ("already exists" is not a failure)', () => {
  const env = loadAt(WED + ' 10:00');
  env.run('(function (ss) { const ins = ss.insertSheet; let first = true;' +
    ' ss.insertSheet = function (n, i) { if (first && n === "Site_Feed") { first = false; ins.call(ss, n, i); } return ins.call(ss, n, i); }; })' +
    '(SpreadsheetApp.getActiveSpreadsheet())');
  const r = post(env, 'main');
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.stored, false);
  assert.ok(meta(env, 'main'), 'stored in the tab the other run made');
  assert.ok(!env.logs.some(function (l) { return /built but not stored/.test(l); }), env.logs.join('\n'));
  env.setNow(IST(WED + ' 10:05'));
  assert.strictEqual(post(env, 'main').stored, true);
  // a real insertSheet failure is still reported
  const bad = loadAt(WED + ' 10:00');
  bad.run('SpreadsheetApp.getActiveSpreadsheet().insertSheet = function () { throw new Error("Service Spreadsheets failed"); }');
  assert.deepStrictEqual(plain(bad.call('ab_siteBuild_', ['main'], 'test')).main,
    { ok: false, error: 'built but not stored: Service Spreadsheets failed' });
});

test('refresh trigger: two requests that both find none leave exactly one', () => {
  const env = loadAt(WED + ' 10:00');
  env.context.__other = function () {
    env.props.deleteProperty('AB_SITE_FEED_TRIGGER_CHECKED');                  // B read it before A wrote it
    env.call('ab_siteFeedTriggerCheck_');
  };
  // B runs its whole check while A is listing the triggers (both see none)
  env.run('(function () { const list = ScriptApp.getProjectTriggers; let nested = false;' +
    ' ScriptApp.getProjectTriggers = function () { const l = list.call(ScriptApp); if (!nested) { nested = true; __other(); } return l; }; })()');
  env.call('ab_siteFeedTriggerCheck_');
  assert.strictEqual(siteTriggers(env).length, 1);
  assert.strictEqual(siteTriggers(env)[0].everyMinutes, 30);
});

test('stored copy: a copy built by older code (AB_SITE_FEED_FORMAT) is rebuilt; a newer one is served', () => {
  const env = loadAt(WED + ' 21:40');
  env.call(TRIGGER_FN);
  const fmt = env.run('AB_SITE_FEED_FORMAT');
  assert.ok(fmt >= 1);
  const setFmt = function (v) {
    const m = meta(env, 'main');
    if (v === undefined) delete m.fmt; else m.fmt = v;
    env.props.setProperty('AB_SITE_FEED_META_MAIN', JSON.stringify(m));
  };
  // older (or none: built before the format existed): not served, due for the trigger, rebuilt by the next request
  [fmt - 1, undefined].forEach(function (v) {
    setFmt(v);
    assert.strictEqual(env.call('ab_siteFeedRead_', 'main'), null, String(v));
    assert.strictEqual(env.call('ab_siteFeedDue_', 'main', meta(env, 'main'), IST(WED + ' 21:45')), true, String(v));
  });
  env.setNow(IST(WED + ' 22:10'));
  const r = post(env, 'main');
  assert.strictEqual(r.stored, false, 'rebuilt by the deployed code at once');
  assert.strictEqual(r.readAt, '2026-10-21 22:10');
  assert.strictEqual(meta(env, 'main').fmt, fmt);
  // the trigger rebuilds an old-format copy on its next run (here outside the busy window, well under 3 h)
  setFmt(fmt - 1);
  env.setNow(IST(WED + ' 22:40'));
  env.call(TRIGGER_FN);
  assert.strictEqual(meta(env, 'main').readAt, '2026-10-21 22:40');
  assert.strictEqual(meta(env, 'main').fmt, fmt);
  // newer (the saved code's trigger ran ahead of the deployment): served, not rebuilt over and over
  setFmt(fmt + 1);
  env.setNow(IST(WED + ' 23:10'));
  const n = post(env, 'main');
  assert.strictEqual(n.stored, true);
  assert.strictEqual(n.readAt, '2026-10-21 22:40');
  assert.strictEqual(env.call('ab_siteFeedDue_', 'main', meta(env, 'main'), IST(WED + ' 23:10')), false);
});

test('runFeedSetupInfo: the token is described honestly (it keeps the website\'s stored copy and trigger)', () => {
  const env = load(null, {});
  env.call('runFeedSetupInfo');
  const text = env.alerts[0].join('\n');
  assert.ok(!/can only read|cannot change the sheet/.test(text), text);
  assert.match(text, /cannot change your data[\s\S]*Site_Feed[\s\S]*30-minute\s+refresh trigger/);
});
