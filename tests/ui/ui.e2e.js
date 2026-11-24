'use strict';
// Browser tests (Playwright + Chromium). Run: npm run test:ui
// Starts its own static server for web/, so nothing else needs to run.
// Checks: every page renders without errors in light and dark themes (the main
// pages in the six other themes too), no horizontal page scroll at 360 px, theme tokens apply, the industry page
// only lists its own category, and Daily Suggestions matches the engine.
// Live site feed: api/site, api/market-status and api/quotes are MOCKED with
// page routes (same-origin Vercel, the Firebase copy's remote API, failures);
// api/watchlists runs the REAL handler against the real Code.gs (tests/fixtures/
// apps-script-mock.js); every other request off the test server is blocked - no
// network is used.
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
let chromium;
try { chromium = require('playwright').chromium; } catch (e) {
  console.log('SKIP: playwright is not installed (npm i -g playwright, or set NODE_PATH)');
  process.exit(0);
}

const WEB = path.join(__dirname, '..', '..', 'web');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = path.join(WEB, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
  if (!p.startsWith(WEB) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

// ---------- live-feed mocks ----------
function windowVar(file, name) { const w = {}; new Function('window', fs.readFileSync(file, 'utf8'))(w); return w[name]; }
const CFG = windowVar(path.join(WEB, 'config.js'), 'SB_CONFIG');
const REMOTE = new URL(CFG.remoteApi);                    // the API the Firebase copy uses (mocked, never contacted)
const FIREBASE = 'http://stock-blueprint.web.app/';      // served from web/ by a route: no DNS, no network
const SAVED = windowVar(path.join(WEB, 'data', 'dashboard.js'), 'SB_DATA');
const HIST = windowVar(path.join(WEB, 'data', 'history.js'), 'SB_HISTORY');
// part history60: five older weekdays for the first three stocks (History60 via the PC)
const HIST60 = (function () {
  const first = new Date(HIST.dates[0] + 'T00:00:00Z'), dates = [];
  for (let t = first.getTime() - 86400000; dates.length < 5; t -= 86400000) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) dates.unshift(d.toISOString().slice(0, 10));
  }
  const bars = {};
  Object.keys(HIST.bars).slice(0, 3).forEach((sym) => {
    const b0 = HIST.bars[sym][0];
    bars[sym] = dates.map((d, i) => [i].concat(b0.slice(1)));
  });
  return { source: 'History60 tab (NSE bhavcopy via your PC)', timeframe: '1d', stored: { days: 60, first: dates[0], last: HIST.dates[HIST.dates.length - 1] },
    dates: dates, cols: ['d', 'o', 'h', 'l', 'c', 'v'], bars: bars };
})();
const SENTINEL = 43210.98;                                // a price only the mocked live feed has
// IST 'YYYY-MM-DD HH:MM' a few minutes ago: web/app.js ages a DELAYED read from readAt
const istAgo = (min) => new Date(Date.now() + (330 - min) * 60000).toISOString().slice(0, 16).replace('T', ' ');
const READ_AT = istAgo(2);
const LIVE_MAIN = JSON.parse(JSON.stringify(SAVED));
LIVE_MAIN.generated = READ_AT;
LIVE_MAIN.source = 'Google Sheet (live feed)';
const SENT_SYM = LIVE_MAIN.main.rows[0][LIVE_MAIN.main.cols.indexOf('sym')];
LIVE_MAIN.main.rows[0][LIVE_MAIN.main.cols.indexOf('price')] = SENTINEL;
// result flags (the Results Tracker's 'Flags' column, feed format 7) on one stock that is also in Results Performance and Main
const FLAGS_TEXT = 'Revenue up, profit down (YoY revenue +12.0%, profit -8.0%); Other income high: Rs 6.00 Cr = 30% of PBT';
const TRK = LIVE_MAIN.resultsTracker;
const IN_PERF = new Set(LIVE_MAIN.resultsPerf.table.rows.map((r) => r[0] + '|' + r[3]));
const IN_MAIN = new Set(LIVE_MAIN.main.rows.map((r) => r[LIVE_MAIN.main.cols.indexOf('sym')]));
const SEASON = LIVE_MAIN.resultsPerf.seasons[0].season;
const FLAG_ROW = TRK.rows.find((r) => r[TRK.cols.indexOf('Status')] === 'Updated' && IN_MAIN.has(r[0]) && IN_PERF.has(r[0] + '|' + r[TRK.cols.indexOf('Quarter Expected')]) &&
  r[TRK.cols.indexOf('Quarter Expected')] === SEASON);
const FLAG_SYM = FLAG_ROW[0];
TRK.cols.push('Flags');
TRK.rows.forEach((r) => r.push(r === FLAG_ROW ? FLAGS_TEXT : ''));
// Main's 'OPM Qtr YoY' (site feed format 8, key opmqy) for the same stock
LIVE_MAIN.main.cols.push('opmqy');
LIVE_MAIN.main.rows.forEach((r) => r.push(r[LIVE_MAIN.main.cols.indexOf('sym')] === FLAG_SYM ? 'Aggressive Increase' : null));
// Historical PE (feed format 17, owner 17-Nov-2026): Main's Median PE 1Y / 3Y / 5Y + Peak PE 5Y from the laptop - the flag stock
// is below its own 5-year median AND below the industry; SENT_SYM has only a 1-year median, far under its PE
['pem1', 'pem3', 'pem5', 'pepk'].forEach((k) => LIVE_MAIN.main.cols.push(k));
LIVE_MAIN.main.rows.forEach((r) => {
  const sym = r[LIVE_MAIN.main.cols.indexOf('sym')];
  if (sym === FLAG_SYM) {
    r[LIVE_MAIN.main.cols.indexOf('pe')] = 20;
    r[LIVE_MAIN.main.cols.indexOf('pevs')] = 0.8;
    r[LIVE_MAIN.main.cols.indexOf('ipe')] = 25;
  }
  if (sym === SENT_SYM) r[LIVE_MAIN.main.cols.indexOf('pe')] = 30;
  r.push.apply(r, sym === FLAG_SYM ? [22, 24, 25, 61.5] : sym === SENT_SYM ? [5, null, null, null] : [null, null, null, null]);
});
// 5 years of results from the laptop's NSE XBRL files (18-Nov-2026) - api/financials answers the flag stock only
const FIN_Q = ['Dec 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026', 'Dec 2026'].map((l, i) =>
  [l, 100 + i * 10, 80 + i * 5, 20 + i * 5, Math.round((20 + i * 5) / (100 + i * 10) * 1000) / 10, 5, i === 1 ? -3.5 : null, 2, 3, 20 + i * 5,
    25, 15 + i * 4, 1.5 + i * 0.4, i === 0 ? 'c' : '']);
FIN_Q.unshift(['Sep 2025', 90, 75, 15, 16.7, 5, null, 2, 3, 15, 25, 11.25, 1.13, '']);
const FIN_Y = [['Mar 2023', 250, 210, 40, 16, 15, null, 7, 11, 37, 26, 27, 2.7, 'r'], ['Mar 2024', 300, 250, 50, 16.7, 20, null, 8, 12, 50, 25, 37.5, 3.75, 'q'],
  ['Mar 2025', 350, 290, 60, 17.1, 20, null, 8, 12, 60, 25, 45, 4.5, 'c'], ['Mar 2026', 410, 330, 80, 19.5, 20, -3.5, 8, 12, 76.5, 25, 57.4, 5.74, '']];
const FIN_NOTE = "EPS adjusted for a bonus / split (today's share count): up to Mar 2025 divided by 3";
// VERSION 7 (owner, 23-Nov-2026, MTARTECH): the other basis's table apart (a switch), its words; 'd' = worked out from
// the year-to-date figures of the other filings
const FIN_BW = 'Dec 2026: only the standalone results are on NSE so far - the consolidated ones have not come yet.';
const FIN_O = { b: 'S', q: [['Jun 2026', 50, 40, 10, 20, 1, null, 1, 1, 9, 25, 6.75, 0.6, ''], ['Sep 2026', 55, 44, 11, 20, 1, null, 1, 1, 10, 25, 7.5, 0.7, 'd']], y: [] };
const FIN_SAMPLE = { b: 'C', q: FIN_Q, y: FIN_Y, files: 6, at: '2026-11-18', note: FIN_NOTE, bw: FIN_BW, o: FIN_O };
// the EPS Growth Target Lab (owner, 23-Nov-2026, LAURUSLABS): api/epstarget = the quarters' figures + one quarter's rows
const EPST = require('../../web/lib/epstarget.js');
const EPST_SYMS = LIVE_MAIN.main.rows.map((r) => r[LIVE_MAIN.main.cols.indexOf('sym')]).filter((x) => x && x !== FLAG_SYM).slice(0, 5);
function epstRow(sym, o) {
  const r = Object.assign({ sym, st: 'ok', why: '', b: 'C', fl: 'r-------', eps: [0.37, 1.71, 4.34, 3.02, 3.61, 4.67, 5.17, 6.81], ttm: 20.26, prev: 9.44,
    g: 114.62, tgt: 2322.17, ann: '2026-07-24 16:05', src: 'nse', ed: '2026-07-27', ep: 1624.1, pre: 1600, o0: 1610, n: 95,
    kp: [38, 45, 53, 60, 68, 75], kd: ['2026-09-17', '2026-09-28', '2026-10-08', '2026-10-21', '2026-10-31', '2026-11-11'], pg: [40, 80, 120, 120, 120],
    hh: [17, 34, 50, 50, 50], dd: [-3, -4, -4, -4, -4], cl: [8, 20, 40, null, null], ix: [1, 2, 3, null, null], nq: 70, nqa: 0, nx: '2026-10-29 16:30',
    wq: [95, 45, -4, 25, 2], now: 46,
    ph: [2, 4, 6, 9, 12, 15, 18, 20, 22, 25, 28, 31, 34, 37, 40, 44, 47], pc: [1, 3, 5, 8, 11, 14, 17, 19, 21, 24, 27, 30, 33, 36, 39, 43, 46] }, o || {});
  return EPST.COLS.map((k) => r[k]);
}
const NOK = { kp: [null, null, null, null, null, null], kd: ['', '', '', '', '', ''] };
const W14 = (a) => a.concat(Array(14 - a.length).fill(0));
const EPST_SUM = (ready, win, dwin) => ({ stocks: 7, ok: 6, target: 5, down: 1, why: { fell: 1 }, win, dwin: dwin || {}, medG: 60, medUp: 40, medN: 85, ready, ann: { nse: 6 } });
const EPST_QS = [{ q: 'Sep 2026', end: '2026-09-30', fy: 'Q2 FY27', made: '2026-11-23T10:00:00', upto: '2026-11-20',
  sum: EPST_SUM(false, { 30: W14([0, 1, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]) }) },
{ q: 'Jun 2026', end: '2026-06-30', fy: 'Q1 FY27', made: '2026-11-23T10:00:00', upto: '2026-11-20',
  sum: EPST_SUM(true, { 30: W14([5, 0, 2, 2, 1, 1, 1, 1]), 60: W14([4, 1, 3, 3, 3, 2, 2, 1]), 90: W14([4, 1, 3, 3, 3, 2, 2, 2]) }, { 60: W14([1, 0, 1, 1, 1, 1, 1, 1]) }) }];
// 60 sessions, 80 % of the way: FLAG reached on 60, [0] on 8, [1] / [2] not ([1] 70 % on 40), [3] still running (40 sessions),
// [4] a DOWNSIDE target; until the next results: FLAG's came 70 sessions after the entry, [0]'s after 6, [3]'s not yet
const EPST_JUN = [epstRow(FLAG_SYM),
  epstRow(EPST_SYMS[0], { g: 30, tgt: 600, ep: 500, ttm: 20, prev: 15.38, kp: [4, 5, 7, 8, 10, 12], kd: ['2026-07-31', '2026-08-03', '2026-08-05', '2026-08-06', '2026-08-10', '2026-08-12'],
    nq: 6, nx: '2026-08-04 18:00', wq: [70, 15, -1, 12, 1] }),
  epstRow(EPST_SYMS[1], Object.assign({ g: 45, tgt: 900, ep: 800, pg: [60, 78, 79, 79, 79], cl: [2, 5, 6, null, null] }, NOK,
    { kp: [20, 28, 40, null, null, null], kd: ['2026-08-24', '2026-09-03', '2026-09-21', '', '', ''] })),
  epstRow(EPST_SYMS[2], Object.assign({ g: 170, tgt: 5000, ep: 1000, pg: [3, 4, 5, 5, 5], cl: [-6, -9, -12, null, null] }, NOK)),
  epstRow(EPST_SYMS[3], Object.assign({ g: 80, tgt: 300, ep: 200, n: 40, pg: [40, 45, 45, 45, 45], cl: [4, null, null, null, null], nq: null, nx: '',
    wq: [45, 20, -2, null, null] }, NOK)),
  epstRow(EPST_SYMS[4], { g: 10, tgt: 50, ep: 80, kp: [2, 3, 4, 5, 6, 8], kd: ['2026-07-29', '2026-07-30', '2026-07-31', '2026-08-03', '2026-08-04', '2026-08-06'] }),
  epstRow('NOTINMAIN', { st: 'x', why: 'fell', g: -12, tgt: null, ed: '', ep: null, n: null, kp: [], kd: [], pg: [], hh: [], dd: [], cl: [], ix: [], nq: null, nx: '',
    wq: [], ph: [], pc: [] })];
// Sep 2026: FLAG reached the target on session 12 with 17 sessions (its window still running)
const EPST_SEP = [epstRow(FLAG_SYM, { ann: '2026-10-28 17:15', ed: '2026-10-29', n: 17, kp: [2, 3, 4, 5, 8, 12],
  kd: ['2026-10-30', '2026-11-02', '2026-11-03', '2026-11-05', '2026-11-10', '2026-11-12'], cl: [null, null, null, null, null], nq: null, nx: '',
  wq: [130, 50, -1, null, null] })];
// the Analyst Targets (owner, 24-Nov-2026, JLHL: Prabhudas Lilladher's Buy, target Rs 330, reached): api/recos = every broker call
const RECOS = require('../../web/lib/recos.js');
function recoRow(sym, o) {
  const r = Object.assign({ sym, co: 'Jupiter Life Line Hospitals', br: 'Prabhudas Lilladher', call: 'BUY', tgt: 330, rp: null, at: '2026-10-27 09:15', src: 'mc',
    url: 'https://www.moneycontrol.com/news/business/stocks/buy-jupiter-life-line-hospitals-target-of-rs-330-prabhudas-lilladher-13654321.html',
    seen: '2026-10-27', st: 'ok', why: '', ed: '2026-10-27', ep: 300, pre: 296, o0: 298, n: 95, kp: [10, 15, 20, 25, 30, 40],
    kd: ['2026-11-10', '2026-11-17', '2026-11-24', '2026-12-01', '2026-12-08', '2026-12-22'], pg: [60, 110, 120, 120, 120], hh: [12, 15, 20, 25, 25],
    dd: [-3, -3, -3, -3, -3], cl: [5, 8, 12, null, null], ix: [1, 2, 3, null, null], now: 11, ph: [], pc: [] }, o || {});
  return RECOS.COLS.map((k) => r[k]);
}
const RNOT = { kp: [12, 20, 30, null, null, null], kd: ['2026-11-12', '2026-11-24', '2026-12-08', '', '', ''] };
const RECOS_ROWS = [
  recoRow(FLAG_SYM),
  recoRow(FLAG_SYM, Object.assign({ br: 'Choice', tgt: 340, at: '2026-10-27 09:05', cl: [4, 6, 9, null, null] }, RNOT)),
  recoRow(EPST_SYMS[0], { co: 'Stock A', br: 'Motilal Oswal', tgt: 600, ep: 500, kp: [2, 3, 4, 5, 6, 8], at: '2026-10-10', cl: [10, 12, 14, null, null] }),
  recoRow(EPST_SYMS[1], Object.assign({ co: 'Stock B', br: 'Motilal Oswal', tgt: 900, ep: 800, at: '2026-10-12', cl: [-2, -4, -6, null, null] }, RNOT)),
  recoRow(EPST_SYMS[2], { co: 'Stock C', br: 'Motilal Oswal', tgt: 1200, ep: 1000, kp: [10, 15, 20, 30, 40, 50], at: '2026-10-14' }),
  recoRow(EPST_SYMS[3], Object.assign({ co: 'Stock D', br: 'ICICI Securities', tgt: 300, ep: 200, n: 40, at: '2026-11-01', cl: [3, null, null, null, null] },
    { kp: [null, null, null, null, null, null], kd: ['', '', '', '', '', ''] })),
  recoRow(EPST_SYMS[4], { co: 'Stock E', br: 'Kotak Securities', call: 'SELL', tgt: 50, ep: 80, at: '2026-10-20', kp: [2, 3, 4, 5, 6, 8] }),
  recoRow('', { co: 'Some Unknown Co', br: 'Ventura', tgt: 100, at: '2026-11-05', st: 'x', why: 'nosym', ed: '', ep: null, n: null, kp: [], kd: [], pg: [], hh: [], dd: [], cl: [], ix: [] }),
  recoRow(EPST_SYMS[0], { co: 'Stock A', br: 'HDFC Securities', tgt: 650, at: '2026-11-21 18:00', st: 'x', why: 'wait', ed: '', ep: null, n: null, kp: [], kd: [], pg: [], hh: [], dd: [], cl: [], ix: [] })];
const RECOS_SUM = { recos: 9, ok: 7, brokers: 7, stocks: 6, buy: 8, why: { nosym: 1, wait: 1 }, src: { mc: 9 }, from: '2026-10-10', to: '2026-11-21' };
// the sheet's 'Result Day %' = the result day's intraday move (owner, 03-Nov-2026: VRLLOG 14.5% where it closed +6%)
const RPT = LIVE_MAIN.resultsPerf.table;
const RP_ROW = RPT.rows.find((r) => r[0] === FLAG_SYM);
RP_ROW[RPT.cols.indexOf('Result Day %')] = 14.5;
RP_ROW[RPT.cols.indexOf('Pre-Result Close')] = 100;
RP_ROW[RPT.cols.indexOf('Result Day Close')] = 106;
// Zerodha Kite patterns (site feed format 9, part 'intraday' - the PC program's "Intraday Patterns" tab; Kite's prices since format 16)
LIVE_MAIN.intraday = { note: 'Spring and Spring in FVG from Zerodha Kite candles (your PC program) ... Last scan: session 2026-10-20 (2026-10-20 19:05). Kept 30 days.',
  cols: ['Session', 'Symbol', 'Company', 'Timeframe', 'Pattern', 'Candle', 'FVG Formed', 'FVG Detail', 'Low', 'Close', 'FVG Bottom', 'FVG Top'],
  rows: [['2026-10-20', FLAG_SYM, 'Flag Co', '4H', 'Spring in FVG', '2026-10-20 13:15', '2026-08-24 09:15', 'FVG bottom (touch 3)', 4321.5, 4388.25, 4330, 4410.75],
    ['2026-10-20', FLAG_SYM, 'Flag Co', '1H', 'Spring', '2026-10-20 14:15', null, null],
    ['2026-10-20', SENT_SYM, null, '4H', 'FVG First Touch', '2026-10-20 09:15', '2026-10-14 13:15', 'FVG'],
    ['2026-10-17', SENT_SYM, null, 'W', 'Spring', '2026-10-13', null, null],
    // the owner's CHoCH + FVG setup (10-Nov-2026): the PC's words, no prices
    ['2026-10-20', FLAG_SYM, 'Flag Co', 'D', 'CHoCH + FVG', '2026-10-20', '2026-10-07', 'FVG middle (touch 1) · Spring · CHoCH 2026-10-09 after 3 lower highs / lows · first pullback',
      4300.1, 4351.6, 4290.4, 4365.9],
    // 13-Nov-2026: BOS + FVG and the smaller chart's CHoCH in the zone (the confirmed entry)
    ['2026-10-20', SENT_SYM, null, 'D', 'BOS + FVG', '2026-10-19', '2026-10-08', 'FVG top (touch 1) · Zone first touch · BOS 2026-10-14 (2 higher highs / lows) · first pullback · zone middle 60% down the move'],
    ['2026-10-20', SENT_SYM, null, 'D', '15m CHoCH in zone', '2026-10-20 11:30', '2026-10-08', 'FVG · D BOS + FVG zone touched 2026-10-19 · 15m CHoCH after 2 lower highs / lows, its final low in the zone · 1 candle after the touch · buy at its close · stop under its final low']] };
// format 14 (owner, 12-Nov-2026, IREDA): CHoCH + FVG setups waiting for the pullback - with Kite's prices (owner: "use kite price")
LIVE_MAIN.chochWait = { note: 'CHoCH + FVG setups WAITING for the pullback, from Zerodha Kite candles (your PC program, session 2026-10-20): ... Rules: swings of 8 candles, ' +
    'at least 10 lower highs / lows, the zone\'s top at least 38.2% down the move, the zone formed only in the CHoCH move. Distance % = ...',
  cols: ['Symbol', 'Company', 'Timeframe', 'CHoCH Candle', 'CHoCH Level', 'Lower Highs / Lows', 'Final Low', 'Final Low On', 'Move High', '50% Line',
    'Zone Kind', 'Zone Bottom', 'Zone Top', 'Zone Formed', 'Zone Depth %', 'Last Close', 'Last Candle', 'Distance %', 'More Zones Below'],
  rows: [[SENT_SYM, null, 'D', '2026-10-15', 117.39, 4, 98.78, '2026-10-06', 123.99, 111.39, 'FVG', 104.1, 108.24, '2026-10-08', 83, 119.25, '2026-10-20', 9.23, 1],
    [SENT_SYM, null, '4H', '2026-10-16 13:15', 120.5, 3, 110.2, '2026-10-14 09:15', 123.99, 117.1, 'Gap-up (inside FVG)', 112, 113.5, '2026-10-15 09:15', 78, 119.25, '2026-10-20 13:15', 4.82, 0]] };
// format 10: 4H FVG zones (no prices) + the FVG+Spring backtest (R only)
LIVE_MAIN.zones4h = { note: '4H FVG zones still untouched ...', cols: ['Symbol', 'Company', 'Kind', 'Zone %', 'Formed', 'Distance %', 'Mitigated Alerted', 'Inside FVG', 'Zone Bottom', 'Zone Top'],
  rows: [[FLAG_SYM, 'Flag Co', 'FVG', 3.52, '2026-10-14 13:15', 1.2, null, null, 4211.25, 4359.5], [SENT_SYM, null, 'Gap-up', 4.1, '2026-10-16 09:15', 6.5, null],
    [SENT_SYM, null, 'FVG', 2.2, '2026-10-01 13:15', -0.4, 'Y']] };
// format 13 (owner, 09-Nov-2026): the 30-day move, 1R - 5R, the highest R before the stop - no prices
const BT_COLS = ['Timeframe', 'Group', 'Signals', 'Avg Up % (30d)', 'Median Up % (30d)', 'Hit 1R %', 'Hit 1.5R %', 'Hit 2R %',
  'Hit 3R %', 'Hit 5R %', 'Stopped %', 'Avg Max R', 'Median Max R', 'Still open', 'From', 'To'];
LIVE_MAIN.springBacktest = {
  summary: { note: 'FVG+Spring / Gap-up FVG + Spring backtest on Zerodha Kite candles ...', cols: BT_COLS, rows: [
    ['4H', 'FVG+Spring', 120, 6.2, 4.1, 55, 47.5, 40, 25, 10, 52.5, 1.9, 1.2, 5, '2021-05-12 13:15', '2026-10-20 13:15'],
    ['4H', 'FVG+Spring - zone top', 70, 7, 4.5, 58, 50, 42, 27, 11, 50, 2, 1.3, 2, '2021-05-12 13:15', '2026-10-20 13:15'],
    ['4H', 'FVG+Spring - zone middle', 0, null, null, null, null, null, null, null, null, null, null, 0, null, null],
    ['4H', 'FVG+Spring - zone bottom', 50, 5, 3.6, 51, 44, 37, 22, 8, 56, 1.7, 1.1, 3, '2021-05-14 13:15', '2026-10-17 13:15'],
    ['4H', 'Spring (every one, for comparison)', 900, 4.4, 3, 45, 38, 30, 18, 6, 60, 1.4, 0.9, 30, '2021-05-11 13:15', '2026-10-20 13:15'],
    ['4H', 'Gap-up FVG + Spring', 20, 8, 6, 60, 55, 45, 30, 12, 50, 2.3, 1.5, 1, '2022-01-03 13:15', '2026-10-16 13:15'],
    ['4H', 'Gap-up FVG + Spring - inside FVG', 6, 11, 9, 67, 67, 50, 33, 17, 33, 2.9, 2, 0, '2023-02-01 13:15', '2026-09-16 13:15'],
    ['D', 'FVG+Spring', 800, 9.1, 6, 60, 50, 42, 26, 9, 48, 2.1, 1.4, 10, '2007-08-02', '2026-10-20'],
    ['W', 'FVG+Spring', 0, null, null, null, null, null, null, null, null, null, null, 0, null, null]] },
  list: { note: 'The newest FVG+Spring / Gap-up FVG + Spring trades ...', cols: ['Candle', 'Symbol', 'Company', 'Timeframe', 'Zone', 'Where', 'Touch', 'Up % (30d)', 'Max R', 'Result'], rows: [
    ['2026-10-20 13:15', FLAG_SYM, 'Flag Co', '4H', 'FVG', 'Bottom', 3, null, null, 'Open'],
    ['2026-09-16', SENT_SYM, null, 'D', 'Gap-up inside FVG', 'Top', 1, 12.5, 4.2, '3R reached'],
    ['2026-09-09 13:15', SENT_SYM, null, '4H', 'FVG', 'Top', 2, 1.1, 0.4, 'Stopped']] } };

/** API answers for one scenario: url -> { json, status } | 'abort'. */
function liveApi(o) {
  return (u) => {
    const part = u.searchParams.get('part');
    if (u.pathname === '/api/site') {
      if (o.site === 'abort') return 'abort';
      if (o.site === 'fail') return { json: { ok: false, configured: true, part, message: 'mock failure: sheet is updating (History30 has 3 of 1800 symbols) - try again shortly' } };
      return { json: { ok: true, configured: true, part, readAt: READ_AT, fetchedAt: istAgo(1), stale: false,
        session: { state: o.session, lastCompletedSession: '2026-10-20' }, priceState: o.priceState, data: part === 'history' ? HIST : part === 'history60' ? HIST60 : LIVE_MAIN } };
    }
    if (u.pathname === '/api/market-status') {
      return { json: o.provider === 'sheet'
        ? { provider: { name: 'sheet', configured: true, requires: ['SHEET_FEED_URL', 'SHEET_FEED_TOKEN'], licensing: 'mock licensing note' },
            session: { state: o.session, now: '2026-10-21 10:06', lastCompletedSession: '2026-10-20' }, status: { ok: false, state: 'UNAVAILABLE', message: 'mock provider: sheet feed timed out' } }
        : { provider: { name: 'none', configured: false, requires: ['MARKET_DATA_PROVIDER'], licensing: '' },
            session: { state: o.session, now: '2026-10-21 10:06', lastCompletedSession: '2026-10-20' }, status: { ok: false, state: 'UNAVAILABLE', message: 'no provider' } } };
    }
    if (u.pathname === '/api/financials') {
      const sym = u.searchParams.get('sym');
      return { json: { ok: true, sym, fin: sym === FLAG_SYM ? FIN_SAMPLE : null, fetchedAt: istAgo(1) } };
    }
    if (u.pathname === '/api/epstarget') {
      const q = u.searchParams.get('q') || 'Jun 2026';
      const rows = (q === 'Sep 2026' ? EPST_SEP : EPST_JUN).map((r) => u.searchParams.get('lite') === '1'
        ? r.map((v, i) => (EPST.COLS[i] === 'ph' || EPST.COLS[i] === 'pc' ? [] : v)) : r);
      return { json: { ok: true, quarters: EPST_QS, q, cols: EPST.COLS, rows, fetchedAt: istAgo(1) } };
    }
    if (u.pathname === '/api/recos') {
      return { json: { ok: true, made: '2026-11-23T10:00:00', upto: '2026-11-20', sum: RECOS_SUM, cols: RECOS.COLS, rows: RECOS_ROWS, fetchedAt: istAgo(1) } };
    }
    if (u.pathname === '/api/quotes') {
      return { json: { state: 'UNAVAILABLE', source: 'sheet', asOf: null, items: [], errors: [{ symbol: '*', reason: 'mock provider: sheet feed timed out' }], message: 'mock provider: sheet feed timed out' } };
    }
    return { status: 404, json: { error: 'not found' } };
  };
}
/** Route every request of a context: mocked api/, web/ files, everything else blocked. */
async function routeAll(context, siteBase, api, calls) {
  const site = new URL(siteBase);
  await context.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if ((u.origin === site.origin || u.origin === REMOTE.origin) && u.pathname.indexOf('/api/') === 0) {
      calls.push(u.origin + u.pathname + u.search);
      const r = await api(u, route.request());
      if (r === 'abort') return route.abort('failed');
      if (r.status === 204) return route.fulfill({ status: 204, headers: r.headers || {}, body: '' });
      return route.fulfill({ status: r.status || 200, contentType: 'application/json; charset=utf-8',
        headers: Object.assign({ 'Access-Control-Allow-Origin': '*' }, r.headers || {}), body: JSON.stringify(r.json) });
    }
    if (u.origin !== site.origin) return route.abort('blockedbyclient');   // nothing leaves the machine
    if (site.hostname !== '127.0.0.1') {                                   // the fake Firebase host: serve web/
      const f = path.join(WEB, decodeURIComponent(u.pathname).replace(/^\/$/, '/index.html'));
      if (!f.startsWith(WEB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
      return route.fulfill({ path: f, contentType: TYPES[path.extname(f)] || 'application/octet-stream' });
    }
    return route.continue();
  });
}
/** The owner's sheet (real Code.gs in the Apps Script mock, PIN Blue2026 set) behind the real api/watchlists. */
function watchlistBackend(now) {
  const gs = require('../fixtures/apps-script-mock').loadCodeGs({ sheets: [{ name: 'Main', rows: [[], ['SYMBOL']] }] },
    Object.assign({ props: { AB_FEED_TOKEN: 'feed-token' }, prompts: ['Blue2026', 'Blue2026'] }, now ? { now: now } : {}));
  gs.call('runWatchlistPinSetup');
  const bodies = [];
  const handler = require('../../api/watchlists').createHandler({
    env: { SHEET_FEED_URL: 'https://sheet.invalid/exec', SHEET_FEED_TOKEN: 'feed-token' },
    fetch: async (url, init) => new Response(JSON.stringify(gs.post(JSON.parse(init.body))), { status: 200, headers: { 'content-type': 'application/json' } })
  });
  gs.setProp = (k, v) => gs.run('PropertiesService.getScriptProperties().setProperty(' + JSON.stringify(k) + ', ' + JSON.stringify(v) + ')');
  return {
    bodies,
    gs,
    lists: () => JSON.parse(JSON.stringify(gs.call('ab_wlRead_').lists)).map((l) => l.name + ': ' + l.syms.join(' ')),
    answer: async (req) => {
      if (req.method() === 'POST') bodies.push(JSON.parse(req.postData() || '{}'));
      const res = { statusCode: 200, headers: {}, body: undefined };
      res.setHeader = (k, v) => { res.headers[k] = v; };
      res.status = (c) => { res.statusCode = c; return res; };
      res.json = (o) => { res.body = o; };
      res.end = () => {};
      await handler({ method: req.method(), body: req.postData() || undefined }, res);
      const headers = {};
      Object.keys(res.headers).filter((k) => /^Access-Control|^Allow$/.test(k)).forEach((k) => { headers[k] = res.headers[k]; });
      return { status: res.statusCode, json: res.body, headers };
    }
  };
}
function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  return errors;
}
const dataReady = () => window.SB && window.SB.ctx && window.SB.ctx.D && document.querySelector('#app .page');
async function pageState(page) {
  return page.evaluate(() => {
    const pill = document.querySelector('#status'), ban = document.querySelector('#site-banner');
    const first = document.querySelector('#ov-data tbody tr');
    return {
      pillCls: pill.className, pill: pill.textContent, tip: pill.title,
      banner: ban.hidden ? null : ban.textContent, live: window.SB.ctx.site.live, state: window.SB.ctx.market.state,
      message: window.SB.ctx.market.message, apiBase: window.SB.apiBase(), siteRow: first ? first.textContent : '',
      liveBadge: [...document.querySelectorAll('.badge, .status-pill')].some((b) => /^LIVE\b/.test(b.textContent.trim())),
      overflow: document.documentElement.scrollWidth - window.innerWidth
    };
  });
}

const PAGES = ['overview', 'daystats/advances', 'watchlist', 'lists', 'suggestions', 'industries', 'industries/companies', 'industries/groups', 'industries/macro/financial-services',
  'industries/sector/capital-goods', 'industries/industry/banks', 'industries/basic/public-sector-bank', 'industries/it', 'industries/review',
  'strategy', 'signals', 'results', 'today', 'edge', 'epst', 'recos', 'markets'];
let failures = 0;
// tools/lab-guide/build.js (the Backtest Lab guide, 12-Nov-2026) runs only the Lab check (E2E_ONLY) and keeps its screenshots (GUIDE_SHOTS)
const GUIDE = process.env.GUIDE_SHOTS || '';
async function guideShot(page, name, selector) {
  if (!GUIDE) return;
  fs.mkdirSync(GUIDE, { recursive: true });
  // the sticky header / ticker would cover a long element's picture
  await page.addStyleTag({ content: '.top, header.top { position: static !important; } #ticker { display: none !important; }' });
  const el = selector ? await page.$(selector) : null;
  if (el) { await el.scrollIntoViewIfNeeded(); await page.waitForTimeout(150); await el.screenshot({ path: path.join(GUIDE, name + '.png') }); }
  else if (!selector) await page.screenshot({ path: path.join(GUIDE, name + '.png') });
}
function check(name, fn) {
  if (process.env.E2E_ONLY && !new RegExp(process.env.E2E_ONLY).test(name)) return Promise.resolve();
  return Promise.resolve().then(fn).then(() => console.log('  ✓ ' + name), (e) => { failures++; console.log('  ✗ ' + name + '\n    ' + e.message); });
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port + '/';
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  for (const theme of ['light', 'dark']) {
    for (const vp of [{ width: 1366, height: 900 }, { width: 360, height: 780 }]) {
      const ctx = await browser.newContext({ viewport: vp });
      await ctx.addInitScript((t) => { try { localStorage.setItem('sb:theme', JSON.stringify(t)); } catch (e) { /* ignore */ } }, theme);
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
      console.log(theme + ' ' + vp.width + 'px');
      for (const p of PAGES) {
        await check('#' + p + ' renders', async () => {
          errors.length = 0;
          await page.goto(base + '#' + p, { waitUntil: 'load' });
          await page.waitForTimeout(p === 'suggestions' || p === 'signals' || p.indexOf('industries') === 0 ? 2500 : 800);
          const info = await page.evaluate(() => ({
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            text: document.querySelector('#app').innerText.length,
            bad: !!document.querySelector('#app .note.bad') && /could not be shown/.test(document.querySelector('#app').innerText),
            bg: getComputedStyle(document.body).backgroundColor,
            theme: document.documentElement.getAttribute('data-theme')
          }));
          assert.deepStrictEqual(errors, [], 'console/page errors');
          assert.ok(info.text > 200, 'page has content');
          assert.ok(!info.bad, 'page did not crash');
          assert.ok(info.overflow <= 0, 'horizontal page overflow ' + info.overflow + 'px');
          // owner, 24-Nov-2026: the light theme is no longer "everything written on white wall" - a soft blue-grey page, white cards
          if (theme === 'light') assert.strictEqual(info.bg, 'rgb(238, 242, 249)', 'light theme body = the soft blue-grey page');
          else { assert.strictEqual(info.theme, 'dark'); assert.ok(['rgb(255, 255, 255)', 'rgb(238, 242, 249)'].indexOf(info.bg) < 0, 'dark theme body is dark'); }
        });
      }
      if (vp.width > 1000 && theme === 'light') {
        await check('industry page lists only its own category', async () => {
          await page.goto(base + '#industries/it', { waitUntil: 'load' });
          await page.waitForTimeout(2500);
          const syms = await page.$$eval('#app table.tbl tbody button[data-sym]', (b) => b.map((x) => x.getAttribute('data-sym')));
          assert.ok(syms.length > 0, 'IT page lists stocks');
          const cats = await page.evaluate((s) => s.map((x) => window.SB.ctx.bySym[x] && window.SB.ctx.bySym[x].cat), syms);
          assert.ok(cats.every((c) => c === 'it'), 'all listed stocks are IT: ' + cats.filter((c) => c !== 'it').length + ' are not');
        });
        await check('industry explorer: counts, tree, search, basic page, filters, strategy', async () => {
          errors.length = 0;
          await page.goto(base + '#industries', { waitUntil: 'load' });
          await page.waitForSelector('#ix-tiles [data-count="basic"]', { timeout: 15000 });
          const counts = await page.$$eval('#ix-tiles [data-count]', (x) => x.map((e) => e.getAttribute('data-count') + '=' + e.textContent));
          assert.deepStrictEqual(counts, ['macro=12', 'sector=22', 'industry=59', 'basic=197'], 'landing tiles');
          // tree: expanding a macro sector shows its sectors
          await page.evaluate(() => { const d = document.querySelector('#ix-tree-box'); d.open = true; });
          await page.click('[data-tog="m-financial-services"]');
          const kids = await page.$$eval('[data-tog="m-financial-services"]', (b) => [b[0].getAttribute('aria-expanded'), [...b[0].closest('li').querySelectorAll(':scope > ul > li .ix-name')].map((a) => a.textContent)]);
          assert.strictEqual(kids[0], 'true');
          assert.deepStrictEqual(kids[1], ['Financial Services'], 'sectors of the Financial Services macro sector');
          // search: symbol -> breadcrumb -> its basic industry + the stock drawer
          await page.fill('#ix-q', 'sbin');
          await page.waitForSelector('#ix-q-list .ix-opt', { timeout: 5000 });
          const first = await page.$eval('#ix-q-list .ix-opt', (o) => o.innerText);
          assert.ok(/SBIN/.test(first) && /Financial Services › Financial Services › Banks › Public Sector Bank/.test(first), 'first suggestion: ' + first);
          assert.strictEqual(await page.getAttribute('#ix-q', 'aria-activedescendant'), 'ix-opt-0');
          await page.keyboard.press('Enter');
          await page.waitForFunction(() => location.hash === '#industries/basic/public-sector-bank' && document.querySelector('#ix-bstocks tbody'), null, { timeout: 15000 });
          await page.waitForFunction(() => !document.querySelector('#drawer').hidden, null, { timeout: 5000 });
          assert.strictEqual(await page.$eval('#drawer-title', (h) => h.firstChild.textContent), 'SBIN');
          await page.keyboard.press('Escape');
          // basic page: 4 hierarchy links, only its own stocks, strategy statuses from the engine run
          const lv = await page.$$eval('.ix-crumbs a[data-lv]', (a) => a.map((x) => x.getAttribute('data-lv')));
          assert.deepStrictEqual(lv, ['macro', 'sector', 'industry', 'basic']);
          await page.waitForFunction(() => window.SB.strategies.lastRun() && document.querySelector('[data-chip="ixsg"]'), null, { timeout: 15000 });
          const b = await page.evaluate(() => {
            const IND = window.SB.industry, I = IND.createIndex(window.SB_INDUSTRIES);
            const syms = [...document.querySelectorAll('#ix-bstocks tbody button[data-sym]')].map((x) => x.getAttribute('data-sym'));
            const basics = syms.map((x) => IND.classifyStock(I, window.SB.ctx.bySym[x]).basicId);
            const all = window.SB.ctx.stocks.filter((x) => IND.classifyStock(I, x).basicId === 'b-public-sector-bank').map((x) => x.sym);
            const run = window.SB.strategies.lastRun();
            const ev = all.filter((x) => run.bySym[x]);
            const q = ev.filter((x) => run.bySym[x].status === 'qualified').length;
            const chips = [...document.querySelectorAll('[data-chip="ixsg"]')].map((c) => c.textContent);
            return { syms, basics, all: all.length, ev: ev.length, q, chips, items: document.querySelectorAll('.ix-sg-item').length };
          });
          assert.ok(b.syms.length > 0 && b.basics.every((x) => x === 'b-public-sector-bank'), 'only Public Sector Bank stocks: ' + b.basics.join(','));
          assert.strictEqual(b.syms.length, Math.min(25, b.all), 'every mapped stock is listed (first page)');
          assert.strictEqual(b.chips[0], 'All (' + b.ev + ')');
          assert.ok(b.chips.indexOf('Qualified (' + b.q + ')') >= 0, 'qualified chip: ' + b.chips.join(' | '));
          assert.strictEqual(b.items, Math.min(10, b.ev), 'strategy cards');
          // companies: combined filters give the count computed with SB.industry
          await page.goto(base + '#industries/companies', { waitUntil: 'load' });
          await page.waitForSelector('#co-macroId option[value="m-financial-services"]', { state: 'attached', timeout: 15000 });
          await page.selectOption('#co-macroId', 'm-financial-services');
          await page.selectOption('#co-cap', 'large');
          const co = await page.evaluate(() => {
            const IND = window.SB.industry, I = IND.createIndex(window.SB_INDUSTRIES);
            const n = window.SB.ctx.stocks.filter((x) => IND.classifyStock(I, x).macroId === 'm-financial-services' && IND.capBucket(x).key === 'large').length;
            const sectorOpts = [...document.querySelectorAll('#co-sectorId option')].map((o) => o.value).filter(Boolean);
            return { n, text: document.querySelector('#co-count').textContent, sectorOpts };
          });
          assert.ok(co.n > 0 && co.text.indexOf(co.n + ' of ') === 0, co.n + ' vs ' + co.text);
          assert.deepStrictEqual(co.sectorOpts, ['s-financial-services'], 'sector options follow the macro sector');
          await page.click('#co-clear');
          const cleared = await page.evaluate(() => [document.querySelector('#co-count').textContent, document.querySelector('#co-macroId').value, document.querySelector('#co-cap').value]);
          assert.ok(/^1,?800 of /.test(cleared[0]) || cleared[0].split(' of ')[0] === cleared[0].split(' of ')[1].split(' ')[0], 'clear all: ' + cleared[0]);
          assert.deepStrictEqual(cleared.slice(1), ['', '']);
          // unknown slug: friendly not-found
          await page.goto(base + '#industries/basic/no-such-industry', { waitUntil: 'load' });
          await page.waitForFunction(() => /Not found/.test(document.querySelector('#app').innerText), null, { timeout: 15000 });
          assert.deepStrictEqual(errors, [], 'console/page errors');
        });
        await check('IPOs & markets: IPO tracker sections and price band filters', async () => {
          errors.length = 0;
          await page.goto(base + '#markets', { waitUntil: 'load' });
          await page.waitForSelector('#pb-t table', { timeout: 15000 });
          const r = await page.evaluate(() => {
            const H = ['Company', 'Symbol', 'Opens', 'Closes', 'Listing date', 'Price range', 'Issue size (shares)', 'Note'];
            window.SB.ctx.D.ipoTracker = {
              note: 'Updated 2026-10-27 08:28 IST from NSE, read by your PC.', warning: '',
              open: { cols: H, rows: [['BLS Polymers Limited', 'BLSPOLY', '2026-10-27', '2026-10-29', null, '₹142 to ₹150', 11900000, 'Closes in 2 days']] },
              closed: { cols: H, rows: [] },
              upcoming: { cols: H, rows: [['Bombay Coated and Special Steels Limited', 'BCSSL', '2026-10-29', '2026-11-02', null, '₹78 to ₹82', 23468846, 'Opens in 2 days']] },
              listed: { cols: ['Company', 'Symbol', 'Closes', 'Listing date', 'Issue price', 'Listing price', 'Listing gain %', 'Last close', 'Since issue %', 'Note'],
                rows: [['Jio Platforms Limited', 'JPL', '2026-10-23', '2026-10-28', 1119, 1150, 2.77, 1231, 10.01, 'Listed on 28-Oct; last close on 30-Oct']] }
            };
            window.SB.route();
            const t = (id) => document.querySelector(id).innerText;
            const pb = window.SB.ctx.D.priceBands;
            const ei = pb.cols.indexOf('Effective (next weekday)');
            const latest = pb.rows.reduce((m, x) => (x[ei] > m ? x[ei] : m), '');
            return { open: t('#ipot-open'), closed: t('#ipot-closed'), upcoming: t('#ipot-upcoming'), listed: t('#ipot-listed'),
              count: t('#pb-count'), latestN: pb.rows.filter((x) => x[ei] === latest).length };
          });
          assert.ok(/BLS Polymers Limited/.test(r.open) && /BLSPOLY/.test(r.open) && /1,19,00,000/.test(r.open) && /Closes in 2 days/.test(r.open), r.open);
          assert.ok(/Jio Platforms Limited/.test(r.listed) && /1,150\.00/.test(r.listed) && /\+2\.8%/.test(r.listed) && /\+10\.0%/.test(r.listed), r.listed);
          assert.ok(/None/.test(r.closed), r.closed);
          assert.ok(/BCSSL/.test(r.upcoming) && /2,34,68,846/.test(r.upcoming), r.upcoming);
          assert.ok(r.count.indexOf(r.latestN + ' of ' + r.latestN) === 0, 'latest day only by default: ' + r.count);
          await page.click('[data-chip="pbv"][data-v="all"]');
          const all = await page.$eval('#pb-count', (x) => x.textContent);
          assert.ok(/^([\d,]+) of \1$/.test(all), 'all days: ' + all);
          assert.deepStrictEqual(errors, [], 'console/page errors');
        });
        await check('NSE end-of-day: market statistics of the Main stocks, every number opens its list, 52-week highs on Markets, Delivery %', async () => {
          errors.length = 0;
          await page.goto(base + '#overview', { waitUntil: 'load' });
          await page.waitForSelector('#ov-mstat', { timeout: 15000 });
          const st = await page.evaluate(() => {
            const D = window.SB.ctx.D;
            const S = window.SB.ctx.stocks;
            D.marketStats = { note: 'Market statistics of YOUR Main stocks', cols: ['Date', 'Stocks Traded', 'Advances', 'Declines', 'Unchanged', 'At 52W High', 'Upper Circuit', 'Lower Circuit'],
              rows: [['2026-10-27', 4, 2, 1, 1, 1, 1, 0], ['2026-10-26', 900, 300, 500, 100, 20, 30, 10]] };
            D.marketDay = { note: 'Your Main stocks on 2026-10-27 (NSE end-of-day files read by your PC): 4 traded - 2 advances, 1 declines, 1 unchanged, ' +
              '1 at a new 52-week high, 1 in upper circuit, 0 in lower circuit.',
              cols: ['Symbol', 'Company', 'Close', '% Change', 'Move', 'Circuit', 'New 52W High', 'Delivery %'],
              rows: [[S[0].sym, S[0].name, 101, 1.23, 'Advance', null, null, 61.2], [S[1].sym, S[1].name, 200, 4.99, 'Advance', 'Upper', 'Yes', 80],
                [S[2].sym, S[2].name, 50, -2.5, 'Decline', null, null, 30], [S[3].sym, S[3].name, 10, 0, 'Unchanged', null, null, null]] };
            D.high52 = { note: '52-week highs from NSE (adjusted for corporate actions) - as on 2026-10-27: 2 mainboard stocks made a new 52-week high (1 in your watchlist).',
              cols: ['Symbol', 'Company', '52W High', '52W High Date', 'Close', '% Below 52W High', 'New High Today', 'In Watchlist'],
              rows: [['NEWCO', null, 50, '2026-10-27', 50, 0, 'Yes', null], ['TCS', 'Tata Consultancy', 4500, '2026-01-10', 4400, 2.2, null, 'Yes'],
                ['INFY', 'Infosys', 2000, '2025-12-10', 1500, 25, null, 'Yes']] };
            const s0 = S[0];
            s0.deliv = 61.25; s0.delivAvg = 48.5; s0.delivDate = '2026-10-27';
            window.SB.route();
            const box = document.querySelector('#ov-mstat');
            return { text: box.innerText, bar: !!box.querySelector('.mstat-bar .b-up'), sym: s0.sym, syms: S.slice(0, 4).map((x) => x.sym),
              links: [...box.querySelectorAll('a.mstat-t')].map((a) => a.getAttribute('href')) };
          });
          for (const want of ['Your Main stocks on', 'Stocks traded\n4', 'Advances\n2', 'Declines\n1', 'Unchanged\n1', 'Stocks at 52-week high\n▲ 1',
            'Stocks in upper circuit\n1', 'Stocks in lower circuit\n0', 'Advance / decline ratio 2.00']) {
            assert.ok(st.text.indexOf(want) >= 0, JSON.stringify(want) + ' in: ' + st.text);
          }
          assert.ok(!/prev|previous/i.test(st.text), 'no previous-day numbers');
          assert.ok(!/52.week low/i.test(st.text), 'no 52-week low');
          assert.ok(st.bar, 'advance / decline bar');
          assert.deepStrictEqual(st.links, ['#daystats/traded', '#daystats/advances', '#daystats/declines', '#daystats/unchanged',
            '#daystats/high52', '#daystats/upper', '#daystats/lower'], 'every number opens its list');
          // a number opens the list of those stocks
          await page.click('#ov-mstat a[data-kind="advances"]');
          await page.waitForSelector('#ds-t table', { timeout: 15000 });
          const listed = async () => (await page.$$eval('#ds-t tbody button[data-sym]', (b) => b.map((x) => x.getAttribute('data-sym')))).sort();
          assert.deepStrictEqual(await listed(), [st.syms[0], st.syms[1]].sort());
          assert.ok(/Market statistics: Advances/.test(await page.$eval('h1', (x) => x.textContent)));
          await page.click('.ds-kinds a[href="#daystats/declines"]');
          await page.waitForFunction(() => /Declines/.test(document.querySelector('h1').textContent));
          assert.deepStrictEqual(await listed(), [st.syms[2]]);
          await page.click('.ds-kinds a[href="#daystats/upper"]');
          await page.waitForFunction(() => /Upper circuit/.test(document.querySelector('h1').textContent));
          assert.deepStrictEqual(await listed(), [st.syms[1]]);
          await page.goto(base + '#daystats/traded', { waitUntil: 'load' });
          await page.waitForSelector('#ds-t table');
          assert.deepStrictEqual(await listed(), st.syms.slice().sort());
          assert.ok(/4 of 4 stocks/.test(await page.$eval('#ds-count', (x) => x.textContent)));
          await page.goto(base + '#daystats/high52', { waitUntil: 'load' });
          await page.waitForSelector('#ds-t table');
          assert.deepStrictEqual(await listed(), [st.syms[1]]);
          // all NSE 52-week highs: the Markets table (linked from the 52-week list)
          await page.click('a[href="#markets/high52"]');
          await page.waitForSelector('#h52-t table', { timeout: 15000 });
          const newOnly = await page.$$eval('#h52-t tbody button[data-sym]', (b) => b.map((x) => x.getAttribute('data-sym')));
          assert.deepStrictEqual(newOnly, ['NEWCO'], 'new 52-week highs today by default');
          assert.ok(/1 mainboard stock at a new 52-week high · 0 in your watchlist/.test(await page.$eval('#h52-sum', (x) => x.innerText)), 'counted from the rows');
          await page.click('[data-chip="h52"][data-v="near"]');
          assert.deepStrictEqual(await page.$$eval('#h52-t tbody button[data-sym]', (b) => b.map((x) => x.getAttribute('data-sym'))), ['TCS'], 'watchlist within 5%');
          await page.click('[data-chip="h52"][data-v="watch"]');
          assert.deepStrictEqual(await page.$$eval('#h52-t tbody button[data-sym]', (b) => b.map((x) => x.getAttribute('data-sym'))), ['TCS', 'INFY']);
          // Delivery % column in the Watchlist and the stock drawer
          await page.goto(base + '#watchlist', { waitUntil: 'load' });
          await page.waitForSelector('#wl-table table', { timeout: 15000 });
          const heads = await page.$$eval('#wl-table thead th', (t) => t.map((x) => x.innerText.trim()));
          assert.ok(heads.some((h) => /^Deliv %/.test(h)), heads.join(' | '));
          await page.fill('#wl-q', st.sym);
          await page.waitForFunction((s) => document.querySelectorAll('#wl-table tbody tr').length >= 1 && document.querySelector('#wl-table tbody').innerText.indexOf(s) >= 0, st.sym);
          assert.ok(/61\.3/.test(await page.$eval('#wl-table tbody', (x) => x.innerText)), 'Delivery % shown');
          await page.click('#wl-table tbody button[data-sym="' + st.sym + '"]');
          await page.waitForSelector('#drawer-title');
          const dr = await page.$eval('#drawer-body', (x) => x.innerText);
          assert.ok(/Delivery %\s*61\.3% on/.test(dr) && /5-day avg 48\.5%/.test(dr), dr.slice(0, 600));
          await page.keyboard.press('Escape');
          await page.waitForFunction(() => document.querySelector('#drawer').hidden);
          await page.fill('#wl-q', '');
          await page.goto(base + '#overview', { waitUntil: 'load' });      // leave the Watchlist as the next check expects to find it
          assert.deepStrictEqual(errors, [], 'console/page errors');
        });
        await check('my watchlists: star, create, no duplicates, rename, search, delete, kept after reload', async () => {
          errors.length = 0;
          await page.goto(base + '#watchlist', { waitUntil: 'load' });
          await page.waitForSelector('#app table.tbl .wl-star', { timeout: 15000 });
          const sym = await page.$eval('#app table.tbl .wl-star', (x) => x.getAttribute('data-wl'));
          const star = '#app table.tbl .wl-star[data-wl="' + sym + '"]';
          await page.click(star);
          await page.waitForSelector('.wl-pop');
          await page.fill('#wl-pop-name', 'Swing trades');
          await page.press('#wl-pop-name', 'Enter');
          await page.waitForFunction((s) => document.querySelector(s).classList.contains('on'), star);
          assert.strictEqual(await page.$eval(star, (x) => x.textContent), '★');
          await page.keyboard.press('Escape');
          assert.strictEqual(await page.$('.wl-pop'), null, 'Escape closes the popover');
          // the drawer has the same star
          await page.click('#app table.tbl button[data-sym="' + sym + '"]');
          await page.waitForSelector('#drawer-title .wl-star.on');
          await page.keyboard.press('Escape');
          await page.goto(base + '#lists', { waitUntil: 'load' });
          await page.waitForSelector('.wl-names');
          await page.fill('#wl-add-in', 'TCS, infy, TCS, ' + sym);
          await page.press('#wl-add-in', 'Enter');
          await page.waitForFunction(() => /already in this watchlist/.test(document.querySelector('.wl-msg').textContent));
          const syms = await page.$$eval('#wl-table tbody button[data-sym]', (b) => b.map((x) => x.getAttribute('data-sym')).sort());
          assert.deepStrictEqual(syms, [sym, 'INFY', 'TCS'].sort(), 'each stock once');
          await page.fill('#wl-new', 'Long term');
          await page.press('#wl-new', 'Enter');
          await page.fill('#wl-new', 'swing  TRADES');
          await page.press('#wl-new', 'Enter');
          await page.waitForFunction(() => /already exists/.test(document.querySelector('.wl-msg').textContent));
          assert.strictEqual(await page.$$eval('.wl-name', (x) => x.length), 2, 'no duplicate watchlist');
          // rename the selected one (Long term)
          await page.click('#wl-rename-btn');
          await page.fill('#wl-rename-in', 'Long-term holds');
          await page.press('#wl-rename-in', 'Enter');
          await page.waitForFunction(() => [...document.querySelectorAll('.wl-name-t')].some((x) => x.textContent === 'Long-term holds'));
          // search by name and by a symbol inside
          await page.fill('#wl-q', 'hold');
          await page.waitForFunction(() => document.querySelectorAll('.wl-name').length === 1);
          await page.fill('#wl-q', 'TCS');
          await page.waitForFunction(() => document.querySelectorAll('.wl-name').length === 1 && /Swing trades/.test(document.querySelector('.wl-name').textContent));
          await page.fill('#wl-q', '');
          await page.waitForFunction(() => document.querySelectorAll('.wl-name').length === 2);
          // kept after a reload (localStorage)
          await page.reload({ waitUntil: 'load' });
          await page.waitForSelector('.wl-names');
          const names = await page.$$eval('.wl-name', (x) => x.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
          assert.deepStrictEqual(names, ['Long-term holds 0', 'Swing trades 3']);
          // remove a stock, then delete a watchlist (with a confirm step)
          await page.click('[data-wl-pick]:not(.on)');
          await page.click('[data-wl-rm="TCS"]');
          await page.waitForFunction(() => document.querySelectorAll('#wl-table tbody button[data-sym]').length === 2);
          await page.click('#wl-del');
          await page.click('#wl-del-yes');
          await page.waitForFunction(() => document.querySelectorAll('.wl-name').length === 1);
          const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('sb:watchlists')));
          assert.deepStrictEqual(stored.lists.map((l) => [l.name, l.syms.length]), [['Long-term holds', 0]]);
          await page.evaluate(() => localStorage.removeItem('sb:watchlists'));
          assert.deepStrictEqual(errors, [], 'console/page errors');
        });
        await check('tables: sort by several columns and filter on several conditions, kept after reload', async () => {
          errors.length = 0;
          await page.goto(base + '#results', { waitUntil: 'load' });
          await page.waitForSelector('#rp-table .tbl-tbtn', { timeout: 15000 });
          await page.click('#rp-table [data-tt="toggle"]');
          await page.click('#rp-table [data-tt="addfilter"]');
          await page.selectOption('#rp-table [data-tp="f:0:key"]', 'Result Day %');
          await page.fill('#rp-table [data-tp="f:0:a"]', '5');
          await page.click('#rp-table [data-tt="addfilter"]');
          await page.selectOption('#rp-table [data-tp="f:1:key"]', 'Results Verdict');
          await page.check('#rp-table [data-tp="f:1:m"][value="Strong"]');
          await page.click('#rp-table th[data-k="Results Verdict"]');
          await page.click('#rp-table th[data-k="NP YoY %"]', { modifiers: ['Shift'] });
          const check1 = () => page.evaluate(() => {
            const t = document.querySelector('#rp-table').__sbTable;
            const rows = t.sorted();
            const want = t.rows.filter((r) => r['Result Day %'] >= 5 && r['Results Verdict'] === 'Strong').length;
            const ordered = rows.every((r, i) => i === 0 || (rows[i - 1]['NP YoY %'] == null ? r['NP YoY %'] == null : r['NP YoY %'] == null || rows[i - 1]['NP YoY %'] >= r['NP YoY %']));
            return { n: rows.length, want, ordered, sorts: t.sorts.map((x) => x.key + x.dir).join(','), sum: document.querySelector('#rp-table .tbl-sum').textContent };
          });
          const a = await check1();
          assert.ok(a.want > 0, 'the saved copy has strong results that rallied');
          assert.strictEqual(a.n, a.want, 'both conditions apply');
          assert.ok(a.ordered, 'second sort level orders rows with the same verdict');
          assert.strictEqual(a.sorts, 'Results Verdict1,NP YoY %-1');
          assert.match(a.sum, /Result day ≥ 5 · Verdict is Strong/);
          // a second tick: "is" = any of the ticked values; "is not" = none of them
          const other = await page.$$eval('#rp-table [data-tp="f:1:m"]', (x) => x.map((e) => e.value).filter((v) => v !== 'Strong')[0]);
          await page.check('#rp-table [data-tp="f:1:m"][value=' + JSON.stringify(other) + ']');
          const two = (op) => page.evaluate(([v2, o]) => {
            const t = document.querySelector('#rp-table').__sbTable;
            const pick = (r) => r['Results Verdict'] === 'Strong' || r['Results Verdict'] === v2;
            return { n: t.sorted().length, want: t.rows.filter((r) => r['Result Day %'] >= 5 && (o === 'is' ? pick(r) : r['Results Verdict'] != null && r['Results Verdict'] !== '' && !pick(r))).length,
              sum: document.querySelector('#rp-table .tbl-sum').textContent };
          }, [other, op]);
          const m1 = await two('is');
          assert.ok(m1.n > a.n && m1.n === m1.want, 'Strong or ' + other + ': ' + JSON.stringify(m1));
          assert.ok(m1.sum.indexOf('Verdict is Strong or ' + other) >= 0 || m1.sum.indexOf('Verdict is ' + other + ' or Strong') >= 0, m1.sum);
          await page.selectOption('#rp-table [data-tp="f:1:op"]', 'isnot');
          assert.strictEqual(await page.$$eval('#rp-table [data-tp="f:1:m"]:checked', (x) => x.length), 2, 'the ticks stay');
          const m2 = await two('isnot');
          assert.strictEqual(m2.n, m2.want, 'none of them: ' + JSON.stringify(m2));
          await page.selectOption('#rp-table [data-tp="f:1:op"]', 'is');
          await page.uncheck('#rp-table [data-tp="f:1:m"][value=' + JSON.stringify(other) + ']');
          assert.strictEqual((await check1()).n, a.n, 'back to Strong only');
          await page.reload({ waitUntil: 'load' });
          await page.waitForSelector('#rp-table .tbl-sum', { timeout: 15000 });
          const b = await check1();
          assert.deepStrictEqual([b.n, b.sorts], [a.n, a.sorts], 'kept after a reload');
          await page.click('#rp-table .tbl-clear');
          const c = await page.evaluate(() => { const t = document.querySelector('#rp-table').__sbTable; return [t.sorted().length, t.rows.length, t.filters.length]; });
          assert.deepStrictEqual(c, [c[1], c[1], 0], 'Clear shows every row again');
          assert.deepStrictEqual(errors, [], 'console/page errors');
        });
        await check('results: every tile and bar opens the list of its stocks, with the same numbers', async () => {
          errors.length = 0;
          await page.goto(base + '#results', { waitUntil: 'load' });
          await page.waitForSelector('a.tile-link[href="#results/above"]', { timeout: 15000 });
          const tiles = await page.evaluate(() => [...document.querySelector('.tiles').querySelectorAll('a.tile-link')].map((x) => x.getAttribute('href')));
          assert.deepStrictEqual(tiles, ['#results/tracked', '#results/tracked', '#results/tracked', '#results/above', '#results/soldoff', '#results/waiting', '#results/notupdated']);
          // owner, 23-Nov-2026: "1703 stocks results were updated in Main. what about remaining" - the rest, each with its reason
          const nuTile = await page.$eval('a.tile-link[href="#results/notupdated"] .value', (x) => x.textContent.trim());
          await page.click('a.tile-link[href="#results/notupdated"]');
          await page.waitForFunction(() => location.hash === '#results/notupdated' && document.querySelector('#rl-count'), null, { timeout: 15000 });
          const nu = await page.evaluate(() => ({ count: document.querySelector('#rl-count').textContent, help: document.querySelector('.rl-kinds + p.sub') && document.querySelector('.rl-kinds + p.sub').textContent,
            heads: [...document.querySelectorAll('#rl-t thead th')].map((th) => th.textContent.replace(/[▲▼↕\d]/g, '').trim()),
            why: [...document.querySelectorAll('#rl-t tbody tr')].map((tr) => tr.children[3].textContent.trim()) }));
          assert.ok(nu.count.indexOf(nuTile + ' of ') === 0 && +nuTile.replace(/,/g, '') > 0, nu.count + ' vs tile ' + nuTile);
          assert.ok(nu.heads.indexOf('Why not in Main yet') >= 0 && nu.heads.indexOf('Details') >= 0, nu.heads.join(' | '));
          assert.ok(nu.why.length && nu.why.every((w) => w.length > 3), JSON.stringify(nu.why.slice(0, 5)));
          assert.match(nu.help || '', /results are not in Main yet \(not ticked\), and why: /);
          await page.click('a[href="#results"]');
          await page.waitForSelector('a.tile-link[href="#results/above"]', { timeout: 15000 });
          const above = await page.$eval('a.tile-link[href="#results/above"] .value', (x) => x.textContent.trim());
          await page.click('a.tile-link[href="#results/above"]');
          await page.waitForFunction(() => location.hash === '#results/above' && document.querySelector('#rl-count'), null, { timeout: 15000 });
          const a1 = await page.evaluate(() => ({ count: document.querySelector('#rl-count').textContent, cur: document.querySelector('.rl-kinds [aria-current="page"]').textContent,
            h1: document.querySelector('h1').textContent }));
          assert.ok(a1.count.indexOf(above.split(' ')[0] + ' of ') === 0, a1.count + ' vs tile ' + above);
          assert.match(a1.cur, /Above pre-result price/);
          assert.strictEqual(a1.h1, 'Above pre-result price');
          // a verdict bar, then the way back
          await page.click('a[href="#results"]');
          await page.waitForSelector('a.bar-row[href="#results/strong"]', { timeout: 15000 });
          const strongBar = await page.$eval('a.bar-row[href="#results/strong"] .bar-val', (x) => x.textContent.trim());
          await page.click('a.bar-row[href="#results/strong"]');
          await page.waitForFunction(() => location.hash === '#results/strong' && document.querySelector('#rl-count'), null, { timeout: 15000 });
          assert.ok((await page.$eval('#rl-count', (x) => x.textContent)).indexOf(strongBar + ' of ') === 0, 'Strong bar ' + strongBar);
          await page.fill('#rl-q', 'zzzz-no-such');
          await page.waitForFunction(() => /^0 of /.test(document.querySelector('#rl-count').textContent));
          await page.fill('#rl-q', '');
          assert.deepStrictEqual(errors, [], 'console/page errors');
        });
        await check('results today: the stocks due on the copy\'s day, by status, tiles = chips = rows', async () => {
          errors.length = 0;
          await page.goto(base + '#today', { waitUntil: 'load' });
          await page.waitForSelector('#td-count', { timeout: 15000 });
          const r = await page.evaluate(() => ({
            h1: document.querySelector('h1').textContent,
            tiles: [...document.querySelectorAll('.tiles a.tile-link')].map((a) => [a.getAttribute('href'), a.querySelector('.value').textContent.trim()]),
            count: document.querySelector('#td-count').textContent,
            status: [...document.querySelectorAll('#td-t tbody tr')].map((tr) => tr.children[1].textContent.trim()),
            heads: [...document.querySelectorAll('#td-t thead th')].map((th) => th.textContent.replace(/[▲▼↕\d]/g, '').trim()),
            tab: !!document.querySelector('.tabs a[data-tab="today"]')
          }));
          // owner, 03-Nov-2026: the Results Performance table's columns, no Price
          for (const h of ['Industry', 'Quarter', 'Result date', 'Announced', 'Daily %', 'Result day', 'Since results', 'Flags', 'TTM Signal', 'Max gain',
            'Max drawdown', 'Rev YoY', 'Profit YoY', 'Rev QoQ', 'Profit QoQ', 'OPM QoQ', 'OPM YoY', 'OPM Qtr YoY', 'FII', 'EPS growth', 'Verdict', 'Reaction']) {
            assert.ok(r.heads.includes(h), 'Results Today column ' + h + ' (' + r.heads.join(' | ') + ')');
          }
          assert.ok(!r.heads.includes('Price'), 'no Price column');
          assert.match(r.h1, /^Results Today · 20 Oct 2026$/, 'the saved copy\'s day');
          assert.deepStrictEqual(r.tiles.map((x) => x[0]), ['#today', '#today/final', '#today/provisional', '#today/filed', '#today/notfiled']);
          assert.strictEqual(r.tiles[0][1], '4');
          assert.strictEqual(r.count, '4 of 4 stocks');
          assert.deepStrictEqual(r.status, ['Not filed yet', 'Not filed yet', 'Not filed yet', 'Not filed yet'], 'all pending, no filing time in this copy');
          assert.ok(r.tab, 'a tab of its own');
          await page.click('a.tile-link[href="#today/final"]');
          await page.waitForFunction(() => location.hash === '#today/final' && /^0 of 0/.test(document.querySelector('#td-count').textContent), null, { timeout: 15000 });
          assert.deepStrictEqual(errors, [], 'console/page errors');
        });
        // owner, 17-Nov-2026: "page la middle part pathutu irukumpothe, page top ku move aagiruthu" - a quiet redraw (new prices
        // every minute or few) must keep the scroll position (pages whose parts come a moment later too) and each table's page
        await check('a quiet redraw keeps the scroll position and the table page (#results, #edge, #signals, #suggestions, #watchlist)', async () => {
          errors.length = 0;
          for (const pg of ['results', 'edge', 'signals', 'suggestions', 'watchlist']) {
            await page.goto(base + '#' + pg, { waitUntil: 'load' });
            await page.waitForTimeout(1500);
            const r = await page.evaluate(async () => {
              const pager = document.querySelector('#app .pager [data-page="1"]:not([disabled])');
              let pagerText = null;
              if (pager) { pager.click(); pagerText = document.querySelector('#app .pager span').textContent; }
              const max = document.documentElement.scrollHeight - window.innerHeight;
              const want = Math.round(max * 0.6);
              window.scrollTo(0, want);
              const before = window.scrollY;
              window.SB.route(true);
              const right = window.scrollY;
              await new Promise((ok) => setTimeout(ok, 1200));
              const later = window.scrollY;
              const p2 = pager ? document.querySelector('#app .pager span') : null;
              return { max, before, right, later, pagerText, pagerAfter: p2 ? p2.textContent : null };
            });
            assert.ok(r.max > 300, pg + ': a long page ' + JSON.stringify(r));
            assert.ok(Math.abs(r.right - r.before) <= 2 && Math.abs(r.later - r.before) <= 2, pg + ': the scroll position stays ' + JSON.stringify(r));
            if (r.pagerText) {
              assert.ok(!/^1–/.test(r.pagerText), pg + ': on the 2nd page ' + r.pagerText);
              assert.strictEqual(r.pagerAfter, r.pagerText, pg + ': the first table stays on its page ' + JSON.stringify(r));
            }
          }
          // a real navigation still starts a table on its first page
          await page.goto(base + '#overview', { waitUntil: 'load' });
          await page.goto(base + '#watchlist', { waitUntil: 'load' });
          await page.waitForTimeout(800);
          assert.match(await page.$eval('#app .pager span', (x) => x.textContent), /^1–/);
          assert.deepStrictEqual(errors, [], 'console/page errors');
        });
        // owner, 17-Nov-2026: "remove excel analysis, backtesting, alerts and trade page from website"
        await check('removed pages: no Excel Analysis / Backtesting / Alerts & Trades tab, their old links open the Overview', async () => {
          errors.length = 0;
          for (const old of ['excel', 'alerts', 'backtest', 'alerts/journal']) {
            await page.goto(base + '#' + old, { waitUntil: 'load' });
            await page.waitForSelector('#app h1', { timeout: 20000 });
            assert.match(await page.$eval('#app h1', (x) => x.textContent), /Market overview/, old);
          }
          const tabs = await page.$$eval('.tabs a', (a) => a.map((x) => x.getAttribute('data-tab')));
          ['excel', 'alerts', 'backtest'].forEach((t) => assert.ok(!tabs.includes(t), t + ' tab'));
          assert.ok(tabs.includes('lab') && tabs.includes('edge'), tabs.join(','));
          const tiles = await page.$$eval('#app .tile .label', (l) => l.map((x) => x.textContent));
          assert.ok(!tiles.some((t) => /Open alerts|Portfolio heat/.test(t)), tiles.join(' | '));
          await page.goto(base + '#suggestions', { waitUntil: 'load' });
          await page.waitForSelector('[data-chip="sgl"]', { timeout: 20000 });
          const lists = await page.$$eval('[data-chip="sgl"]', (b) => b.map((x) => x.getAttribute('data-v')));
          assert.ok(!lists.includes('exits'), lists.join(','));
          assert.ok(!/Position size|journal/i.test(await page.$eval('#app', (x) => x.textContent)), 'no journal / position size on Daily Suggestions');
          assert.deepStrictEqual(errors, [], 'console/page errors');
        });
        // owner, 17-Nov-2026: "Entha parameter edukurathu ... epdi edutha rally kana possibility iruku. make a separate page alone for this"
        await check('results edge: the season learned on the copy\'s data, the rally rule recomputes it, features / decide / every result', async () => {
          errors.length = 0;
          await page.evaluate(() => { try { localStorage.removeItem('sb:edge:opts'); } catch (e) { /* ignore */ } });
          await page.goto(base + '#edge', { waitUntil: 'load' });
          await page.waitForSelector('#edge-sum', { timeout: 20000 });
          const r = await page.evaluate(() => ({
            tab: !!document.querySelector('.tabs a[data-tab="edge"]'),
            rule: document.querySelector('#edge-rule').textContent,
            tiles: [...document.querySelectorAll('#edge-sum .tile .label')].map((x) => x.textContent),
            feats: document.querySelectorAll('#edge-feat [data-feat]').length,
            groups: !!document.querySelector('#edge-groups table'),
            all: document.querySelectorAll('#edge-all-t tbody tr').length,
            chips: [...document.querySelectorAll('[data-chip="edgelist"]')].map((b) => b.textContent),
            heads: [...document.querySelectorAll('#edge-all-t thead th')].map((th) => th.textContent.replace(/[↑↓]/g, '').trim()),
            now: !!document.querySelector('#edge-now-t table')
          }));
          assert.ok(r.tab, 'a tab of its own');
          assert.match(r.rule, /open of the first session that could react/);
          assert.match(r.rule, /at least 8% above the entry within the first 2 sessions .*or.* the close of the 10th session was at least 10% above the entry/);
          assert.deepStrictEqual(r.tiles, ['Results with an outcome', 'Rallied', 'Average 10-session move', 'Score check']);
          assert.ok(r.feats >= 20 && r.groups && r.now, JSON.stringify(r));
          assert.ok(r.all > 0, 'every result listed');
          assert.match(r.chips.join('|'), /^All \(\d+\)\|Rallied \(\d+\)\|No rally \(\d+\)\|Still running \(\d+\)\|Not traded yet \(\d+\)$/);
          ['Stock', 'Result date', 'Entry', 'Outcome', 'Best jump', '10-session move', 'Rally chance', 'Decision', 'NP YoY', 'OPM Qtr YoY', 'PE'].forEach((h) =>
            assert.ok(r.heads.includes(h), h + ' in ' + r.heads.join(' | ')));
          // owner, 17-Nov-2026: FII, promoter, the 20-session move, the 60-day high and the 50-day average are gone
          ['FII', 'Promoter', '20-session move before'].forEach((h) => assert.ok(!r.heads.includes(h), h));
          assert.strictEqual(await page.$$eval('#edge-feat [data-feat]', (b) => b.filter((x) => /^(fii|promo|run20|fromHigh|sma50)$/.test(x.getAttribute('data-feat'))).length), 0);
          // the counts add up: All = the four lists
          const n = r.chips.map((c) => +/\((\d+)\)/.exec(c)[1]);
          assert.strictEqual(n[0], n[1] + n[2] + n[3] + n[4]);
          // a shorter rule: everything is worked out again (more results have an outcome after 5 sessions)
          const before = await page.$eval('#edge-sum .tile .value', (x) => x.textContent);
          await page.selectOption('[data-eo="trendDays"]', '5');
          await page.waitForFunction((b) => /close of the 5th session/.test(document.querySelector('#edge-rule').textContent) && document.querySelector('#edge-sum .tile .value') &&
            document.querySelector('#edge-sum .tile .value').textContent !== b, before, { timeout: 15000 });
          // a figure's groups + checking one stock
          await page.click('#edge-feat [data-feat="npY"]');
          assert.match(await page.$eval('#edge-groups', (x) => x.textContent), /Net profit YoY %/);
          const sym = await page.$eval('#edge-all-t tbody tr [data-sym]', (b) => b.getAttribute('data-sym'));
          await page.fill('#edge-q', sym);
          await page.waitForSelector('#edge-one .edge-one', { timeout: 5000 });
          assert.match(await page.$eval('#edge-one', (x) => x.textContent), new RegExp(sym + '[\\s\\S]*Rally chance'));
          await page.selectOption('[data-eo="trendDays"]', '10');
          await page.fill('#edge-q', '');
          // owner, 17-Nov-2026: "If I want to exclude sector. There should be cross mark and addition mark"
          assert.match(await page.$eval('#edge-off', (x) => x.textContent), /Tap × next to a figure/);
          await page.click('[data-feat-off="sector"]');
          await page.waitForSelector('#edge-off [data-feat-on="sector"]', { timeout: 15000 });
          const ex = await page.evaluate(() => ({
            feat: !!document.querySelector('#edge-feat [data-feat="sector"]'),
            chip: document.querySelector('#edge-off').textContent,
            sum: document.querySelector('#edge-sum .card-head p').textContent,
            kept: JSON.parse(localStorage.getItem('sb:edge:opts')).off
          }));
          assert.ok(!ex.feat, 'Sector is out of the list');
          assert.match(ex.chip, /Left out by you \(1\):\s*\+ Sector/);
          assert.match(ex.sum, /1 figure left out by you/);
          assert.deepStrictEqual(ex.kept, ['sector'], 'kept on this device');
          await page.click('[data-feat-off="cap"]');
          await page.waitForSelector('#edge-off [data-feat-on="*"]', { timeout: 15000 });
          await page.click('#edge-off [data-feat-on="sector"]');
          await page.waitForSelector('#edge-feat [data-feat="sector"]', { timeout: 15000 });
          assert.ok(!(await page.$('#edge-feat [data-feat="cap"]')), 'Market cap still out');
          await page.click('#edge-off [data-feat-on="cap"]');
          await page.waitForSelector('#edge-feat [data-feat="cap"]', { timeout: 15000 });
          assert.match(await page.$eval('#edge-off', (x) => x.textContent), /Tap × next to a figure/);
          // owner, 17-Nov-2026: "option to see the whole results as one single session instead of two (earlier, later)"
          await page.selectOption('[data-eo="view"]', 'whole');
          await page.waitForFunction(() => /as one part/.test(document.querySelector('#edge-rule').textContent) && document.querySelector('#edge-groups table'), null, { timeout: 15000 });
          await page.click('#edge-feat [data-feat="npY"]');
          const gh = await page.$$eval('#edge-groups thead th', (t) => t.map((th) => th.textContent.replace(/[↑↓]/g, '').trim()));
          assert.ok(gh.includes('vs the rest') && !gh.includes('Earlier part') && !gh.includes('Held'), gh.join(' | '));
          assert.match(await page.$eval('#edge-feat', (x) => x.textContent), /over the whole season/);
          // "possibility of stocks opening in gapup if its result came after or closed market hours" (the copy has no announcement
          // times: every result made an after-market one for this check)
          await page.evaluate(() => { const t = window.SB.ctx.D.resultsPerf.table; t.cols.push('Announced'); t.rows.forEach((x) => x.push('18:00 After market')); });
          await page.selectOption('[data-eo="goal"]', 'gapup');
          await page.waitForFunction(() => /opened at least 3%/.test(document.querySelector('#edge-rule').textContent) && document.querySelector('#edge-all-t table'), null, { timeout: 15000 });
          const g = await page.evaluate(() => ({
            pop: !!document.querySelector('[data-eo="popPct"]'), gapSel: !!document.querySelector('[data-eo="gapPct"]'),
            tiles: [...document.querySelectorAll('#edge-sum .tile .label')].map((x) => x.textContent),
            finished: +document.querySelector('#edge-sum .tile .value').textContent.replace(/,/g, ''),
            chips: [...document.querySelectorAll('[data-chip="edgelist"]')].map((b) => b.textContent),
            heads: [...document.querySelectorAll('#edge-all-t thead th')].map((th) => th.textContent.replace(/[↑↓]/g, '').trim()),
            nowHeads: [...document.querySelectorAll('#edge-now-t thead th')].map((th) => th.textContent.replace(/[↑↓]/g, '').trim()),
            feats: [...document.querySelectorAll('#edge-feat [data-feat]')].map((b) => b.getAttribute('data-feat'))
          }));
          assert.ok(!g.pop && g.gapSel, 'the gap-up rule replaces the rally rule');
          assert.deepStrictEqual(g.tiles, ['Results with an outcome', 'Gapped up', 'Average opening gap', 'Score check']);
          assert.ok(g.finished > 50, 'the copy\'s results now count: ' + g.finished);
          assert.match(g.chips.join('|'), /^All \(\d+\)\|Gapped up \(\d+\)\|No gap-up \(\d+\)\|Not opened yet \(\d+\)$/);
          ['Opened', 'Close before', 'Opening gap', 'Gap-up chance', 'Decision'].forEach((h) => assert.ok(g.heads.includes(h), h + ' in ' + g.heads.join(' | ')));
          assert.ok(!g.heads.includes('When') && g.nowHeads.includes('Gap-up chance'), g.nowHeads.join(' | '));
          assert.ok(!g.feats.includes('gap') && !g.feats.includes('session'), 'the gap is the outcome');
          await page.evaluate(() => { try { localStorage.removeItem('sb:edge:opts'); } catch (e) { /* ignore */ } });
          assert.deepStrictEqual(errors, [], 'console/page errors');
        });
        await check('results: "fell after results, then back above" card (daily closes) and its lists', async () => {
          errors.length = 0;
          await page.goto(base + '#results', { waitUntil: 'load' });
          await page.waitForSelector('#rc-body a.tile-link[href="#results/reclaimed"]', { timeout: 20000 });
          const rc = await page.$$eval('#rc-body a.tile-link', (a) => a.map((x) => [x.getAttribute('href'), x.querySelector('.value').textContent.trim()]));
          assert.deepStrictEqual(rc.map((x) => x[0]), ['#results/reclaimed', '#results/reclaimslow', '#results/nearreclaim']);
          await page.click('#rc-body a.tile-link[href="#results/reclaimed"]');
          await page.waitForFunction(() => location.hash === '#results/reclaimed' && document.querySelector('#rl-count'), null, { timeout: 15000 });
          assert.ok((await page.$eval('#rl-count', (x) => x.textContent)).indexOf(rc[0][1] + ' of ') === 0, 'tile ' + rc[0][1]);
          const heads = await page.$$eval('#rl-t th', (t) => t.map((x) => x.textContent.trim()));
          ['Fell to', 'Back above on session', 'Now vs pre-result', 'Trend'].forEach((h) => assert.ok(heads.some((x) => x.indexOf(h) === 0), h + ' in ' + heads));
          // opened directly (candles not loaded yet): loads them, then the list
          await page.goto(base + '#markets', { waitUntil: 'load' });
          await page.goto(base + '#results/nearreclaim', { waitUntil: 'load' });
          await page.waitForSelector('#rl-count', { timeout: 20000 });
          assert.match(await page.$eval('h1', (x) => x.textContent), /close to the pre-result price/);
          assert.deepStrictEqual(errors, [], 'console/page errors');
        });
        await check('strategy: post-results opportunities preset runs and labels its four set-ups', async () => {
          const r = await page.evaluate(async () => {
            await window.SB.loadHistory();
            const S = window.SB.strategies, list = S.list().map((c) => c.id);
            const run = window.SB.strategy.run(S.get('postResults'), window.SB.ctx.stocks, S.candles() || {}, { usePrice: true });
            const types = {};
            run.results.forEach((x) => (x.setupTypes || []).forEach((t) => { types[t] = (types[t] || 0) + 1; }));
            return { has: list.indexOf('postResults') >= 0, types: Object.keys(types), desc: S.describe(S.get('postResults')).tag };
          });
          assert.ok(r.has, 'listed in Strategy Settings');
          assert.ok(r.types.some((t) => /^Rally gains eroded|^Immediate rally|^Delayed reaction|^Second opportunity/.test(t)), 'types: ' + r.types.join(', '));
          assert.match(r.desc, /not confirmed/);
          await page.goto(base + '#strategy', { waitUntil: 'load' });
          await page.waitForTimeout(800);
          assert.ok(/Post-results opportunities/.test(await page.$eval('#app', (x) => x.innerText)));
        });
        // owner, 03-Nov-2026: "strategy settings page is not user friendly ... once a strategy is set in one browser it should not
        // be deleted when reloaded. Swing, positional, long-term" - style -> strategy -> fine-tune, every change saved by itself
        await check('strategy settings: styles, plain-words recipe, autosave that survives a reload, live preview, new / undo / delete', async () => {
          errors.length = 0;
          await page.goto(base + '#strategy/sheet', { waitUntil: 'load' });
          await page.waitForSelector('#st-live-n', { timeout: 20000 });
          const s0 = await page.evaluate(() => ({
            styles: [...document.querySelectorAll('.ss-style')].map((b) => b.getAttribute('data-style') + ':' + b.getAttribute('aria-pressed')),
            cards: [...document.querySelectorAll('.ss-card')].map((c) => c.querySelector('h3').textContent), recipe: document.querySelectorAll('.ss-recipe > li').length,
            v: window.SB.strategies.get('sheet').version, live: document.querySelector('#st-live-n').textContent,
            q: window.SB.strategy.run(window.SB.strategies.get('sheet'), window.SB.ctx.stocks, window.SB.strategies.candles(), { usePrice: true,
              latestDate: window.SB.ctx.history.dates[window.SB.ctx.history.dates.length - 1], refDate: window.SB.ui.iso(window.SB.ctx.refDate) }).counts.qualified
          }));
          assert.deepStrictEqual(s0.styles, ['swing:true', 'positional:false', 'long-term:false', 'all:false'], 'the style of the strategy in use');
          assert.ok(s0.cards.some((n) => /Post-results opportunities/.test(n)) && !s0.cards.some((n) => /Quality Growth/.test(n)), 'swing strategies only: ' + s0.cards);
          assert.strictEqual(s0.recipe, 5, 'looks at / skips / buy signal / must also be true / exit plan');
          assert.strictEqual(s0.live.replace(/,/g, ''), String(s0.q), 'the preview = the engine run');
          await page.waitForFunction(() => /\d/.test((document.querySelector('[data-count="sheet"]') || {}).textContent || ''), null, { timeout: 15000 });
          // a switch: saved by itself (a new version), the preview follows
          await page.click('label.ss-switch:has(#on-filters-1)');
          await page.waitForFunction((v) => window.SB.strategies.get('sheet').version === v + 1 && /Saved in this browser/.test(document.querySelector('#st-saved').textContent), s0.v, { timeout: 5000 });
          // a second change in the same visit updates that version (no version per keystroke)
          await page.fill('#r-triggers-0-min', '2');
          await page.waitForFunction(() => window.SB.strategies.get('sheet').triggers[0].params.min === 2, null, { timeout: 5000 });
          assert.strictEqual(await page.evaluate(() => window.SB.strategies.get('sheet').version), s0.v + 1);
          await page.waitForFunction((n) => document.querySelector('#st-live-n').textContent !== n, s0.live, { timeout: 5000 });
          // not valid yet: not saved, but kept over a reload
          await page.fill('#r-triggers-0-min', '9');
          await page.waitForFunction(() => /Not saved yet/.test(document.querySelector('#st-saved').textContent), null, { timeout: 5000 });
          await page.reload({ waitUntil: 'load' });
          await page.waitForSelector('#st-live-n', { timeout: 20000 });
          assert.strictEqual(await page.$eval('#r-triggers-0-min', (x) => x.value), '9', 'the change not saved yet survives a reload');
          assert.strictEqual(await page.$eval('#on-filters-1', (x) => x.checked), false, 'the saved change too');
          assert.match(await page.$eval('#st-saved', (x) => x.textContent), /Not saved yet - fix 1 thing/);
          await page.fill('#r-triggers-0-min', '4');
          await page.waitForFunction((v) => window.SB.strategies.get('sheet').triggers[0].params.min === 4 && window.SB.strategies.get('sheet').version === v + 2, s0.v, { timeout: 5000 });
          // a new long-term strategy from the starter, a rule from the picker, undo, delete
          await page.click('[data-act="new"]');
          await page.fill('#st-new-name', 'My long-term test');
          await page.check('input[name="st-new-style"][value="long-term"]');
          await page.click('[data-act="create"]');
          await page.waitForFunction(() => document.querySelector('#st-name') && document.querySelector('#st-name').value === 'My long-term test', null, { timeout: 5000 });
          const nw = await page.evaluate(() => ({ style: document.querySelector('.ss-style[aria-pressed="true"]').getAttribute('data-style'),
            cards: [...document.querySelectorAll('.ss-card h3')].map((h) => h.textContent), id: location.hash.replace('#strategy/', ''),
            rules: document.querySelectorAll('#sec-confirms .ss-rule').length }));
          assert.strictEqual(nw.style, 'long-term');
          assert.ok(nw.cards.indexOf('My long-term test') >= 0, 'listed: ' + nw.cards);
          assert.ok(nw.rules >= 5, 'the starter\'s conditions');
          await page.click('#add-confirms > summary');
          await page.fill('[data-pick-q="confirms"]', 'ema');
          const pick = await page.$$eval('#add-confirms .ss-pick-i:not([hidden])', (a) => a.map((x) => x.getAttribute('data-c')));
          assert.deepStrictEqual(pick.sort(), ['closeAboveEma', 'emaTrend'], 'the picker search');
          await page.click('#add-confirms .ss-pick-i[data-c="closeAboveEma"]');
          await page.waitForFunction((n) => document.querySelectorAll('#sec-confirms .ss-rule').length === n + 1, nw.rules);
          await page.click('#st-undo');
          await page.waitForFunction((n) => document.querySelectorAll('#sec-confirms .ss-rule').length === n, nw.rules);
          await page.waitForFunction((id) => window.SB.strategies.get(id).confirms.length === 6 && /Saved in this browser/.test(document.querySelector('#st-saved').textContent), nw.id, { timeout: 5000 });
          await page.reload({ waitUntil: 'load' });
          await page.waitForSelector('#st-live-n', { timeout: 20000 });
          assert.strictEqual(await page.$eval('#st-name', (x) => x.value), 'My long-term test', 'still there after a reload');
          await page.click('.ss-menu > summary');
          await page.click('[data-act="delete"]');
          await page.click('#st-del-yes');
          await page.waitForFunction((id) => !window.SB.strategies.get(id), nw.id);
          // back to the original for the checks after this one
          await page.goto(base + '#strategy/sheet', { waitUntil: 'load' });
          await page.waitForSelector('#st-live-n', { timeout: 20000 });
          await page.click('.ss-menu > summary');
          await page.click('[data-act="reset"]');
          await page.click('#st-reset-yes');
          assert.strictEqual(await page.evaluate(() => window.SB.strategies.get('sheet').version), 1);
          assert.deepStrictEqual(errors, [], 'console/page errors');
        });
        await check('daily suggestions match the engine run', async () => {
          await page.goto(base + '#suggestions', { waitUntil: 'load' });
          await page.waitForTimeout(3000);
          const r = await page.evaluate(() => {
            const run = window.SB.strategies.lastRun();
            const chip = document.querySelector('[data-chip="sgl"][data-v="qualified"]');
            return { q: run.lists.qualified.length, chip: chip && chip.textContent, cards: document.querySelectorAll('.sugg-item').length };
          });
          assert.ok(r.chip && r.chip.indexOf('(' + r.q + ')') > 0, 'chip shows ' + r.q);
          assert.ok(r.cards === Math.min(20, r.q) || (r.q === 0 && r.cards === 0), 'cards ' + r.cards);
          // the redesign (owner, 03-Nov-2026): headline number, three steps, where every stock landed, list help, ranked cards
          const d = await page.evaluate(() => ({
            big: document.querySelector('#sg-big .sg-big-n').textContent, steps: document.querySelectorAll('.sg-step').length,
            seg: [...document.querySelectorAll('[data-funnel]')].map((b) => b.getAttribute('data-funnel') + ':' + b.querySelector('b').textContent),
            help: document.querySelector('#sg-help').textContent, rank: (document.querySelector('.sugg-item .sg-rank') || {}).textContent,
            opts: [...document.querySelectorAll('#sg-strat option')].map((o) => o.value)
          }));
          assert.strictEqual(d.big.replace(/,/g, ''), String(r.q), 'headline = qualified');
          assert.strictEqual(d.steps, 3);
          assert.ok(d.seg.indexOf('qualified:' + r.q.toLocaleString('en-IN')) >= 0, 'bar: ' + d.seg);
          assert.match(d.help, /^Qualified: Every rule/);
          assert.ok(!r.q || d.rank === '#1', 'rank badge');
          assert.ok(d.opts.indexOf('resultPerformance') >= 0, 'the new strategy is offered: ' + d.opts);
          // a click on the Watch part of the bar opens that list; switching the strategy here re-runs it
          if (d.seg.some((x) => /^watch:/.test(x))) {
            await page.click('[data-funnel="watch"]');
            assert.strictEqual(await page.getAttribute('[data-chip="sgl"][data-v="watch"]', 'aria-pressed'), 'true');
          }
          errors.length = 0;
          await page.selectOption('#sg-strat', 'resultPerformance');
          await page.waitForFunction(() => window.SB.strategies.lastRun() && window.SB.strategies.lastRun().config.id === 'resultPerformance' && !/…/.test(document.querySelector('#sg-big').textContent), null, { timeout: 15000 });
          const rp = await page.evaluate(() => ({ active: window.SB.strategies.activeId(), mode: window.SB.strategies.lastRun().config.mode, text: document.querySelector('#sg-big').textContent }));
          assert.deepStrictEqual([rp.active, rp.mode], ['resultPerformance', 'screen']);
          assert.match(rp.text, /stocks match the screen/);
          assert.deepStrictEqual(errors, [], 'console/page errors');
          await page.evaluate(() => window.SB.strategies.setActive('sheet'));
        });
        await check('theme picker: 8 themes, choice applies at once and persists (default light)', async () => {
          const c2 = await browser.newContext({ viewport: vp });       // no init script: real persistence
          const p2 = await c2.newPage();
          const theme = () => p2.evaluate(() => document.documentElement.getAttribute('data-theme'));
          await p2.goto(base + '#overview', { waitUntil: 'load' });
          const t0 = await theme();
          await p2.click('#theme');
          const opts = await p2.$$eval('#theme-pop [data-theme-id]', (b) => b.map((x) => x.getAttribute('data-theme-id') + ':' + x.getAttribute('aria-checked')));
          const expanded = await p2.getAttribute('#theme', 'aria-expanded');
          await p2.click('#theme-pop [data-theme-id="dark"]');
          const t1 = await theme();
          await p2.keyboard.press('Escape');
          const closed = await p2.evaluate(() => !document.querySelector('#theme-pop'));
          await p2.reload({ waitUntil: 'load' });
          const t2 = await theme();
          await p2.click('#theme');
          await p2.keyboard.press('ArrowRight');                      // keyboard: the next theme
          const t3 = await theme();
          const meta = await p2.evaluate(() => [document.querySelector('meta[name="theme-color"]').content, getComputedStyle(document.documentElement).getPropertyValue('--page').trim()]);
          await p2.click('#theme-pop [data-theme-id="light"]');
          const t4 = await theme();
          await p2.mouse.click(5, 400);                                // a click outside closes it
          const closed2 = await p2.evaluate(() => !document.querySelector('#theme-pop'));
          const stored = await p2.evaluate(() => localStorage.getItem('sb:theme'));
          await c2.close();
          assert.strictEqual(t0, null, 'starts light');
          assert.deepStrictEqual(opts, ['light:true', 'dark:false', 'midnight:false', 'neon:false', 'emerald:false', 'aurora:false', 'graphite:false', 'gold:false']);
          assert.strictEqual(expanded, 'true');
          assert.strictEqual(t1, 'dark');
          assert.ok(closed, 'Escape closes the picker');
          assert.strictEqual(t2, 'dark', 'persists after reload');
          assert.strictEqual(t3, 'midnight', 'arrow key picks the next theme');
          assert.strictEqual(meta[0], meta[1], 'browser bar colour = the theme page colour');
          assert.strictEqual(t4, null, 'back to light');
          assert.ok(closed2, 'a click outside closes the picker');
          assert.strictEqual(stored, '"light"');
        });
      }
      await ctx.close();
    }
  }

  console.log('live site feed (mocked api/)');
  await check('static host: saved copy with banner, no API calls', async () => {
    const c = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const calls = [];
    await routeAll(c, base, liveApi({}), calls);
    const p = await c.newPage(), errors = watchErrors(p);
    await p.goto(base + '#overview', { waitUntil: 'load' });
    await p.waitForFunction(dataReady, null, { timeout: 15000 });
    await p.waitForTimeout(300);
    const st = await pageState(p);
    const bases = await p.evaluate(() => {
      const f = window.SB.apiBaseFor, R = 'https://example.vercel.app';
      return [f('stock-blueprint.web.app', 'https:', null, R), f('x.firebaseapp.com', 'https:', true, R), f('stock-blueprint.web.app', 'https:', null, ''),
        f('stock-blueprint-sandy.vercel.app', 'https:', null, R), f('localhost', 'http:', null, R), f('localhost', 'http:', true, R), f('', 'file:', null, R)];
    });
    await c.close();
    assert.deepStrictEqual(bases, ['https://example.vercel.app/', 'https://example.vercel.app/', null, '', null, '', null], 'API base per host');
    assert.deepStrictEqual(errors, [], 'console/page errors');
    assert.deepStrictEqual(calls, [], 'no api/ request on a static host');
    assert.strictEqual(st.apiBase, null);
    assert.strictEqual(st.live, false);
    assert.ok(/st-CACHED/.test(st.pillCls), 'pill CACHED: ' + st.pillCls);
    assert.ok(st.banner && /Showing a saved copy/.test(st.banner) && /not updated automatically/.test(st.banner), 'banner: ' + st.banner);
    assert.ok(/Site data \(Google Sheet\)\s*Saved copy/.test(st.siteRow), 'site row: ' + st.siteRow);
  });

  await check('live feed (same-origin api/): DELAYED pill, live prices + candles, provider failure shown, no banner', async () => {
    const c = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    await c.addInitScript(() => { try { localStorage.setItem('sb:api', 'true'); } catch (e) { /* ignore */ } });
    const calls = [];
    await routeAll(c, base, liveApi({ priceState: 'DELAYED', session: 'open', provider: 'sheet' }), calls);
    const p = await c.newPage(), errors = watchErrors(p);
    await p.goto(base + '#overview', { waitUntil: 'load' });
    await p.waitForFunction(() => window.SB && window.SB.ctx && window.SB.ctx.D && /Quotes unavailable/.test(window.SB.ctx.market.message || ''), null, { timeout: 15000 });
    const st = await pageState(p);
    const drawer = await p.evaluate((sym) => { window.SB.openStock(sym); return document.querySelector('#drawer-body').textContent; }, SENT_SYM);
    await p.keyboard.press('Escape');
    await p.goto(base + '#suggestions', { waitUntil: 'load' });
    await p.waitForFunction(() => window.SB.ctx.history, null, { timeout: 15000 });
    const H = await p.evaluate(() => ({ live: window.SB.ctx.history.live, readAt: window.SB.ctx.history.readAt, reason: window.SB.ctx.site.historyReason,
      older: window.SB.ctx.history.older, days: window.SB.ctx.history.dates.length, reason60: window.SB.ctx.site.history60Reason }));
    await p.waitForTimeout(500);
    await c.close();
    assert.deepStrictEqual(errors, [], 'console/page errors');
    assert.strictEqual(st.apiBase, '');
    assert.strictEqual(st.live, true);
    assert.ok(/st-DELAYED/.test(st.pillCls) && /^DELAYED/.test(st.pill), 'pill DELAYED: ' + st.pill);
    assert.ok(!st.liveBadge, 'sheet data is never labelled LIVE');
    assert.ok(/mock provider: sheet feed timed out/.test(st.tip), 'provider failure in the pill tooltip: ' + st.tip);
    assert.strictEqual(st.banner, null, 'no stale banner');
    assert.ok(/Site data \(Google Sheet\)\s*Live feed/.test(st.siteRow), 'site row: ' + st.siteRow);
    assert.ok(drawer.indexOf('43,210.98') >= 0, 'sentinel price from the live feed is shown');
    assert.ok(H.live === true && H.readAt === READ_AT && !H.reason, 'candles from the live feed: ' + JSON.stringify(H));
    assert.ok(calls.some((u) => /\/api\/site\?part=main$/.test(u)) && calls.some((u) => /\/api\/site\?part=history$/.test(u)), 'calls: ' + calls.join(' '));
    assert.ok(calls.some((u) => /\/api\/site\?part=history60$/.test(u)), 'the older days are asked for too');
    assert.ok(H.older && H.older.days === 5 && H.days === HIST.dates.length + 5 && !H.reason60, 'History60\'s older days in front: ' + JSON.stringify(H));
    assert.ok(calls.every((u) => u.indexOf(new URL(base).origin) === 0), 'same-origin API only');
  });

  await check('Patterns & FVG: Zerodha intraday / weekly patterns from the live feed, timeframe chips, TradingView buttons', async () => {
    const c = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    await c.addInitScript(() => { try { localStorage.setItem('sb:api', 'true'); } catch (e) { /* ignore */ } });
    await routeAll(c, base, liveApi({ priceState: 'DELAYED', session: 'open', provider: 'sheet' }), []);
    const p = await c.newPage(), errors = watchErrors(p);
    await p.goto(base + '#signals', { waitUntil: 'load' });
    await p.waitForSelector('#sg-itd-t table', { timeout: 15000 });
    const r = await p.evaluate(() => ({
      count: document.querySelector('#sg-itd-count').textContent,
      chips: [...document.querySelectorAll('[data-chip="sgitdtf"]')].map((b) => b.textContent),
      links: [...document.querySelectorAll('#sg-itd-t a.btn')].map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('target')]),
      note: document.querySelector('#sg-itd .card-head p').textContent,
      jump: !!document.querySelector('[data-jump="sg-itd"]')
    }));
    assert.strictEqual(r.count, '7 of 7');
    assert.deepStrictEqual(r.chips, ['All timeframes (7)', '1H (1)', '4H (2)', 'D (3)', 'W (1)']);
    assert.ok(r.links.some((l) => l[0] === 'TradingView 4H ↗' && l[1] === 'https://www.tradingview.com/chart/?symbol=NSE%3A' + encodeURIComponent(FLAG_SYM) + '&interval=240' && l[2] === '_blank'), JSON.stringify(r.links));
    assert.match(r.note, /Last scan: session 2026-10-20/);
    assert.ok(r.jump, 'in the page\'s jump chips');
    assert.ok(await p.$eval('#sg-itd-t', (x) => x.textContent.includes('FVG bottom (touch 3)')), 'the Where column');
    // Kite's prices (owner, 17-Nov-2026: "Website-க்கு Kite zone விலைகள் வருவதில்லை. Yen varuvathilai.")
    const px = await p.evaluate((sym) => {
      const ths = [...document.querySelectorAll('#sg-itd-t thead th')].map((th) => th.textContent.replace(/[↑↓]/g, '').trim());
      const tr = [...document.querySelectorAll('#sg-itd-t tbody tr')].find((x) => x.textContent.includes('Spring in FVG') && x.textContent.includes(sym));
      return { ths, cells: [...tr.children].map((td) => td.textContent.trim()) };
    }, FLAG_SYM);
    ['Close', 'Low', 'Zone bottom', 'Zone top', 'Stop under', 'Now vs close'].forEach((h) => assert.ok(px.ths.indexOf(h) > 0, h + ': ' + px.ths.join(' | ')));
    const cell = (h) => px.cells[px.ths.indexOf(h)];
    assert.deepStrictEqual([cell('Close'), cell('Low'), cell('Zone bottom'), cell('Zone top'), cell('Stop under')].map((x) => x.replace(/[₹,]/g, '')),
      ['4388.25', '4321.50', '4330.00', '4410.75', (Math.round(4330 * 0.995 * 100) / 100).toFixed(2)], JSON.stringify(px.cells));
    // Daily % (owner, 08-Nov-2026) = the stock's s.chg, as in the Watchlist's Today column
    const dp = await p.evaluate(() => {
      const ths = [...document.querySelectorAll('#sg-itd-t thead th')].map((th) => th.textContent.trim());
      const i = ths.findIndex((x) => /^Daily %/.test(x));
      const tr = document.querySelector('#sg-itd-t tbody tr');
      const sym = tr.querySelector('[data-sym]').getAttribute('data-sym');
      return { ths, i, cell: i < 0 ? '' : tr.children[i].textContent.trim(), chg: window.SB.ctx.bySym[sym] && window.SB.ctx.bySym[sym].chg };
    });
    assert.strictEqual(dp.ths[dp.i - 1].replace(/[↑↓]/g, '').trim(), 'Stock', 'Daily % right after Stock: ' + dp.ths.join(' | '));
    assert.ok(typeof dp.chg === 'number', 'the stock has a change %');
    assert.ok(dp.cell.includes(Math.abs(dp.chg).toFixed(2)), dp.cell + ' vs ' + dp.chg);
    await p.click('[data-chip="sgitdtf"][data-v="4H"]');
    assert.strictEqual(await p.$eval('#sg-itd-count', (x) => x.textContent), '2 of 7');
    await p.click('[data-chip="sgitdp"][data-v="FVG First Touch"]');
    assert.strictEqual(await p.$eval('#sg-itd-count', (x) => x.textContent), '1 of 7');
    await p.click('[data-chip="sgitdp"][data-v="Spring"]');
    assert.strictEqual(await p.$eval('#sg-itd-count', (x) => x.textContent), '0 of 7');
    // the owner's CHoCH + FVG setups (10-Nov-2026): their own section first, with what triggered each one
    await p.waitForSelector('#sg-ch-t table');
    const ch = await p.evaluate(() => ({ count: document.querySelector('#sg-ch-count').textContent, text: document.querySelector('#sg-ch-t').textContent,
      link: (document.querySelector('#sg-ch-t a.btn') || {}).textContent, jump: !!document.querySelector('[data-jump="sg-choch"]'),
      first: document.querySelector('#app section.card').id, note: document.querySelector('#sg-choch .card-head p').textContent }));
    assert.deepStrictEqual([ch.count, ch.link, ch.jump, ch.first], ['3 of 3', 'TradingView D ↗', true, 'sg-choch'], JSON.stringify(ch));
    assert.ok(ch.text.includes('Spring · CHoCH 2026-10-09 after 3 lower highs / lows · first pullback'), ch.text);
    assert.ok(/4,?290\.40/.test(ch.text) && /4,?365\.90/.test(ch.text), 'the zone prices in the CHoCH table: ' + ch.text);
    // BOS + FVG and the smaller chart's CHoCH in the zone (owner, 13-Nov-2026): a Setup column + chips
    assert.deepStrictEqual(await p.$$eval('[data-chip="sgchset"]', (b) => b.map((x) => x.textContent)),
      ['Every setup', 'CHoCH + FVG (1)', 'BOS + FVG (1)', 'Confirmed on a smaller chart (1)']);
    await p.click('[data-chip="sgchset"][data-v="ltf"]');
    assert.strictEqual(await p.$eval('#sg-ch-count', (x) => x.textContent), '1 of 3');
    assert.match(await p.$eval('#sg-ch-t tbody', (x) => x.textContent), /15m CHoCH in zone[\s\S]*2026-10-20 11:30[\s\S]*D BOS \+ FVG zone touched 2026-10-19 · 15m CHoCH after 2 lower highs/);
    await p.click('[data-chip="sgchset"][data-v="bos"]');
    assert.match(await p.$eval('#sg-ch-t tbody', (x) => x.textContent), /BOS \+ FVG[\s\S]*BOS 2026-10-14 \(2 higher highs \/ lows\)/);
    await p.click('[data-chip="sgchset"][data-v="all"]');
    assert.match(ch.note, /BOS \+ FVG = the same on a BOS move[\s\S]*15m CHoCH in zone = after such a touch/);
    assert.match(ch.note, /10 lower highs and 10 lower lows \(swings of 8 candles\).*closed above the last lower high \(CHoCH\).*only in the CHoCH move, in the discount part of the move \(its top at least 38\.2% down.*first pullback.*first touch.*ChochRules\.bat/,
      'the laptop\'s own rules (ChochRules.bat), read from the tab note');
    // waiting for the pullback (owner, 12-Nov-2026, IREDA): CHoCH formed, discount zone below - the zone top to buy at, the distance from the price shown
    await p.waitForSelector('#sg-cw-t table');
    const cw = await p.evaluate(() => {
      const ths = [...document.querySelectorAll('#sg-cw-t thead th')].map((th) => th.textContent.replace(/[↑↓]/g, '').trim());
      const rows = [...document.querySelectorAll('#sg-cw-t tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent.trim()));
      return { ths, rows, count: document.querySelector('#sg-cw-count').textContent, jump: !!document.querySelector('[data-jump="sg-chw"]'),
        second: [...document.querySelectorAll('#app section.card')][1].id, note: document.querySelector('#sg-chw .card-head p').textContent };
    });
    assert.deepStrictEqual([cw.count, cw.jump, cw.second], ['2 of 2', true, 'sg-chw'], JSON.stringify(cw));
    // 12-Nov-2026: "Buy at" (the zone top / the Gap-up zone top inside an FVG / the zone's Fib line) and "Stop under"; an older feed = the zone top / bottom
    const zi = cw.ths.indexOf('Buy at'), bi = cw.ths.indexOf('Stop under'), ti = cw.ths.indexOf('Timeframe');
    assert.ok(cw.ths.indexOf('Zone size') > 0 && cw.ths.indexOf('Entry') > 0, cw.ths.join(' | '));
    assert.ok(zi > 0 && bi > 0, cw.ths.join(' | '));
    assert.deepStrictEqual(cw.rows.map((r) => [r[ti], r[zi], r[bi]]).sort(), [['4H', '113.50', '112.00'], ['D', '108.24', '104.10']].sort(), JSON.stringify(cw.rows));
    assert.match(cw.note, /after at least 10 lower highs and 10 lower lows \(swings of 8 candles\).*not come back to it yet.*Buy at.*Gap-up zone inside an FVG.*\(the scan of the session 2026-10-20\)/);
    await p.click('[data-chip="sgcwtf"][data-v="4H"]');
    assert.strictEqual(await p.$eval('#sg-cw-count', (x) => x.textContent), '1 of 2');
    await p.click('[data-chip="sgcwtf"][data-v="all"]');
    // the strategy rule's detail says why the stock is not qualified yet
    const cwd = await p.evaluate((sym) => {
      const s = window.SB.ctx.bySym[sym], S = window.SB.strategy;
      const r = S.run(S.PRESETS.chochFvg, [s], { [sym]: [{ t: '2026-10-19', o: 10, h: 11, l: 9, c: 10, v: 1e6 }, { t: '2026-10-20', o: 10, h: 11, l: 9, c: 10.5, v: 1e6 }] }, { refDate: '2026-10-21' });
      return { n: (s.chochWait || []).length, res: r.bySym[sym].checks.find((c) => c.id === 'chochFvg').res };
    }, SENT_SYM);
    assert.strictEqual(cwd.n, 2);
    assert.strictEqual(cwd.res.pass, false);
    assert.match(cwd.res.detail, /waiting for the pullback: D CHoCH 2026-10-15, discount zone 104.1 - 108.24 - 9.2% below the last close; 4H CHoCH 2026-10-16 13:15/);
    // ... and the strategy rule reads them (Strategy Settings preset 'CHoCH + FVG (your SMC setup)')
    const st = await p.evaluate((sym) => {
      const s = window.SB.ctx.bySym[sym], S = window.SB.strategy;
      const r = S.run(S.PRESETS.chochFvg, [s], { [sym]: [{ t: '2026-10-19', o: 10, h: 11, l: 9, c: 10, v: 1e6 }, { t: '2026-10-20', o: 10, h: 11, l: 9, c: 10.5, v: 1e6 }] }, { refDate: '2026-10-21' });
      return { n: (s.choch || []).length, pass: r.bySym[sym].checks.find((c) => c.id === 'chochFvg').res.pass };
    }, FLAG_SYM);
    assert.deepStrictEqual(st, { n: 1, pass: true });
    // 17-Nov-2026 ("Daily Suggestions-இல் வருவது CHoCH / BOS setups மட்டுமே. Add all others too"): preset 'My daily scan' takes every setup
    const ds = await p.evaluate((syms) => {
      const S = window.SB.strategy, bars = [{ t: '2026-10-19', o: 10, h: 11, l: 9, c: 10, v: 1e6 }, { t: '2026-10-20', o: 10, h: 11, l: 9, c: 10.5, v: 1e6 }];
      const stocks = syms.map((x) => window.SB.ctx.bySym[x]), hist = {};
      syms.forEach((x) => { hist[x] = bars; });
      const r = S.run(S.PRESETS.dailyScan, stocks, hist, { refDate: '2026-10-21' });
      return syms.map((x) => { const c = r.bySym[x].checks.find((k) => k.id === 'dailyScan').res; return [x, c.pass, c.detail]; });
    }, [FLAG_SYM, SENT_SYM]);
    assert.strictEqual(ds[0][1], true, JSON.stringify(ds));
    assert.match(ds[0][2], /D CHoCH \+ FVG 2026-10-20 \(1 trading day ago\).*; 4H Spring in FVG 2026-10-20 13:15/);
    assert.strictEqual(ds[1][1], true, JSON.stringify(ds));
    assert.match(ds[1][2], /D BOS \+ FVG 2026-10-19 \(1 trading day ago\)/);
    await p.goto(base + '#strategy');
    await p.waitForFunction(() => /Strategy|strategy/.test((document.querySelector('#app') || {}).textContent || ''), null, { timeout: 15000 });
    const allBtn = await p.$('[data-style="all"]');
    if (allBtn) await allBtn.click();
    await p.waitForFunction(() => document.querySelector('#app').textContent.includes('CHoCH + FVG (your SMC setup)'), null, { timeout: 15000 });
    await p.goto(base + '#signals');
    await p.waitForSelector('#sg-z4-t table');
    // 4H FVG zones (format 10): kind chips, the "within 2%" chip, status, TradingView 4H
    await p.waitForSelector('#sg-z4-t table');
    const z = await p.evaluate(() => ({
      count: document.querySelector('#sg-z4-count').textContent,
      status: [...document.querySelectorAll('#sg-z4-t tbody tr')].map((tr) => tr.textContent.includes('Mitigated today')),
      link: (document.querySelector('#sg-z4-t a.btn') || {}).textContent,
      jump: !!document.querySelector('[data-jump="sg-z4"]') && !!document.querySelector('[data-jump="sg-sbt"]')
    }));
    assert.strictEqual(z.count, '3 of 3');
    assert.ok(z.status.filter(Boolean).length === 1 && z.link === 'TradingView 4H ↗' && z.jump, JSON.stringify(z));
    assert.ok(await p.$eval('#sg-z4-t', (x) => /4,?211\.25/.test(x.textContent) && /4,?359\.50/.test(x.textContent) && x.textContent.includes('Zone bottom')),
      'the 4H zone prices (17-Nov-2026)');
    await p.click('[data-chip="sgz4"][data-v="near"]');
    assert.strictEqual(await p.$eval('#sg-z4-count', (x) => x.textContent), '2 of 3', 'within 2% of the top (or inside)');
    await p.click('[data-chip="sgz4"][data-v="Gap-up"]');
    assert.strictEqual(await p.$eval('#sg-z4-count', (x) => x.textContent), '1 of 3');
    // FVG+Spring backtest: one tile per timeframe (the 30-day move), the summary table, the trades with result chips
    const b = await p.evaluate(() => ({
      tiles: [...document.querySelectorAll('#sg-sbt [data-sbt]')].map((t) => [t.getAttribute('data-sbt'), t.querySelector('.value').textContent]),
      note4h: (document.querySelector('#sg-sbt [data-sbt="4H"] .note2') || {}).textContent,
      sumRows: document.querySelectorAll('#sg-sbt-sum tbody tr').length,
      trades: document.querySelector('#sg-sbt-count').textContent
    }));
    assert.deepStrictEqual(b.tiles, [['4H', '+6.2%'], ['D', '+9.1%'], ['W', '–']]);
    assert.match(b.note4h, /median \+4\.1% · 120 signals · 2R hit 40% · stopped 52\.5%.*Gap-up FVG \+ Spring \+8% · 2R 45% \(20\).*Gap-up inside FVG \+ Spring \+11% · 2R 50% \(6\).*Every Spring \+4\.4% · 2R 30% \(900\)/);
    assert.ok(b.sumRows === 9 && b.trades === '3 of 3', JSON.stringify(b));
    await p.click('[data-chip="sgsbtr"][data-v="reached"]');
    assert.strictEqual(await p.$eval('#sg-sbt-count', (x) => x.textContent), '1 of 3');
    await p.click('[data-chip="sgsbtf"][data-v="4H"]');
    assert.strictEqual(await p.$eval('#sg-sbt-count', (x) => x.textContent), '0 of 3');
    assert.deepStrictEqual(errors, [], 'console/page errors');
    await c.close();
  });
  await check('result flags: pills in the Results tables and the stock drawer (live feed with the tracker\'s Flags)', async () => {
    const c = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    await c.addInitScript(() => { try { localStorage.setItem('sb:api', 'true'); } catch (e) { /* ignore */ } });
    await routeAll(c, base, liveApi({ priceState: 'DELAYED', session: 'open', provider: 'sheet' }), []);
    const p = await c.newPage(), errors = watchErrors(p);
    await p.goto(base + '#results', { waitUntil: 'load' });
    await p.waitForSelector('#rp-q', { timeout: 15000 });
    await p.fill('#rp-q', FLAG_SYM);
    await p.waitForTimeout(400);
    const rp = await p.$$eval('#rp-table .flag-pills .badge', (b) => b.map((x) => [x.textContent, x.getAttribute('data-tip'), x.className]));
    const heads = await p.$$eval('#rs-table th', (t) => t.map((x) => x.textContent.trim()));
    // OPM Qtr YoY in every table of the page (owner, 03-Nov-2026)
    const opm = await p.evaluate(() => {
      const col = (sel) => {
        const t = document.querySelector(sel + ' table');
        if (!t) return null;
        const hs = [...t.querySelectorAll('th')].map((x) => x.textContent.trim());
        const i = hs.findIndex((h) => /OPM Qtr YoY/.test(h));
        return { i, cells: i < 0 ? [] : [...t.querySelectorAll('tbody tr')].map((tr) => (tr.children[i] || {}).textContent) };
      };
      return { rp: col('#rp-table'), rs: col('#rs-table'), best: col('#mv-best'), worst: col('#mv-worst'), up: col('#up-t') };
    });
    // TTM Signal in every table (owner, 03-Nov-2026); Daily % left of Result day, Result day = the intraday move
    const sig = await p.evaluate(() => {
      const has = (sel) => { const t = document.querySelector(sel + ' table'); return !!t && [...t.querySelectorAll('th')].some((x) => /^TTM Signal/.test(x.textContent.trim())); };
      const hs = [...document.querySelectorAll('#rp-table th')].map((x) => x.textContent.trim());
      const row = document.querySelector('#rp-table tbody tr');
      const cell = (h) => row && row.children[hs.indexOf(h)] ? row.children[hs.indexOf(h)].textContent.trim() : null;
      return { tables: ['#rp-table', '#rs-table', '#mv-best', '#mv-worst', '#up-t'].filter((x) => !has(x)), daily: hs.indexOf('Daily %'), rday: hs.indexOf('Result day'),
        move: cell('Result day'), close: cell('Daily %') };
    });
    // Columns: untick one, it stays hidden after a reload, Show all brings it back
    await p.click('#rp-table [data-tt="cols"]');
    await p.uncheck('#rp-table .tbl-cols input[data-tc="Basic Industry"]');
    const hidden1 = await p.$$eval('#rp-table th', (t) => t.map((x) => x.textContent.trim()));
    const btn = await p.textContent('#rp-table [data-tt="cols"]');
    await p.reload({ waitUntil: 'load' });
    await p.waitForSelector('#rp-table th', { timeout: 15000 });
    const hidden2 = await p.$$eval('#rp-table th', (t) => t.map((x) => x.textContent.trim()));
    await p.click('#rp-table [data-tt="cols"]');
    const firstLocked = await p.$eval('#rp-table .tbl-cols input[data-tc="Symbol"]', (x) => x.disabled);
    await p.click('#rp-table [data-tt="colsall"]');
    const shownAgain = await p.$$eval('#rp-table th', (t) => t.map((x) => x.textContent.trim()));
    await p.fill('#rp-q', FLAG_SYM);
    await p.waitForTimeout(300);
    await p.goto(base + '#results/tracked', { waitUntil: 'load' });
    await p.waitForSelector('#rl-q', { timeout: 15000 });
    await p.fill('#rl-q', FLAG_SYM);
    await p.waitForTimeout(400);
    const list = await p.$$eval('#rl-t .flag-pills .badge', (b) => b.map((x) => x.textContent));
    const listSig = await p.$$eval('#rl-t th', (t) => t.some((x) => /^TTM Signal/.test(x.textContent.trim())));
    const drawer = await p.evaluate((sym) => {
      window.SB.openStock(sym);
      const dt = [...document.querySelectorAll('#drawer-body dt')].find((x) => x.textContent === 'Result flags');
      return dt ? dt.nextElementSibling.textContent : null;
    }, FLAG_SYM);
    await c.close();
    assert.deepStrictEqual(errors, [], 'console/page errors');
    assert.deepStrictEqual(rp.map((x) => x[0]), ['REV \u2191 PROFIT \u2193', 'OTHER INCOME HIGH'], 'Results performance row');
    assert.strictEqual(rp[0][1], 'Revenue up, profit down (YoY revenue +12.0%, profit -8.0%)', 'the figures on hover');
    assert.ok(/s-bad/.test(rp[0][2]) && /s-warn/.test(rp[1][2]), 'colours like the email');
    assert.ok(heads.indexOf('Flags') > 0, 'tracker table column: ' + heads);
    Object.keys(opm).forEach((k) => assert.ok(opm[k] && opm[k].i > 0, 'OPM Qtr YoY column in ' + k + ': ' + JSON.stringify(opm[k])));
    assert.ok(opm.rp.cells.some((c) => /Aggressive Increase/.test(c)), 'the value from Main in Results performance');
    assert.deepStrictEqual(sig.tables, [], 'TTM Signal missing in ' + sig.tables);
    assert.ok(listSig, 'TTM Signal in the lists');
    assert.ok(sig.daily > 0 && sig.rday === sig.daily + 1, 'Daily % just left of Result day: ' + JSON.stringify(sig));
    assert.strictEqual(sig.move, '+14.5%', 'Result day = the intraday move');
    assert.strictEqual(sig.close, '+6.0%', 'Daily % = where it closed');
    assert.ok(hidden1.indexOf('Industry') < 0 && hidden1.indexOf('Stock') === 0, 'Industry hidden: ' + hidden1);
    assert.match(btn, /Columns \(1 hidden\)/);
    assert.ok(hidden2.indexOf('Industry') < 0, 'still hidden after a reload');
    assert.strictEqual(firstLocked, true, 'the stock column always stays');
    assert.ok(shownAgain.indexOf('Industry') === 1, 'Show all: ' + shownAgain);
    assert.deepStrictEqual(list, ['REV \u2191 PROFIT \u2193', 'OTHER INCOME HIGH'], 'the lists');
    assert.ok(drawer && /REV \u2191 PROFIT \u2193/.test(drawer) && /OTHER INCOME HIGH/.test(drawer) && /results$/.test(drawer), 'drawer: ' + drawer);
  });

  await check('historical PE: Watchlist columns + filters, the drawer (live feed with Main\'s Median PE 1Y / 3Y / 5Y)', async () => {
    const c = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    await c.addInitScript(() => { try { localStorage.setItem('sb:api', 'true'); } catch (e) { /* ignore */ } });
    await routeAll(c, base, liveApi({ priceState: 'DELAYED', session: 'open', provider: 'sheet' }), []);
    const p = await c.newPage(), errors = watchErrors(p);
    await p.goto(base + '#watchlist', { waitUntil: 'load' });
    await p.waitForSelector('#wl-table table', { timeout: 15000 });
    const heads = await p.$$eval('#wl-table thead th', (t) => t.map((x) => x.innerText.trim()));
    const syms = () => p.$$eval('#wl-table tbody button[data-sym]', (b) => b.map((x) => x.getAttribute('data-sym')));
    await p.click('[data-chip="wl"][data-v="peown"]');
    await p.waitForTimeout(200);
    const own = await syms();
    const row = await p.$eval('#wl-table tbody tr', (tr) => {
      const hs = [...document.querySelectorAll('#wl-table thead th')].map((x) => x.innerText.trim());
      const cell = (h) => (tr.children[hs.findIndex((x) => x.indexOf(h) === 0)] || {}).innerText;
      return { med: cell('Own median PE'), ratio: cell('PE / own median'), check: cell('PE check') };
    });
    await p.click('[data-chip="wl"][data-v="peboth"]');
    await p.waitForTimeout(200);
    const both = await syms();
    // the 1Y / 3Y / 5Y medians + the peak: hidden until ticked in Columns
    await p.click('#wl-table [data-tt="cols"]');
    await p.check('#wl-table .tbl-cols input[data-tc="pem5"]');
    const heads2 = await p.$$eval('#wl-table thead th', (t) => t.map((x) => x.innerText.trim()));
    const drawer = await p.evaluate((sym) => {
      window.SB.openStock(sym);
      const kv = {};
      document.querySelectorAll('#drawer-body dt').forEach((dt) => { kv[dt.textContent] = dt.nextElementSibling.textContent; });
      // the PE picture (owner, 23-Nov-2026: options C + D + the industry PE) in place of the separate lines
      const pic = document.querySelector('#drawer-body .kv .kv-wide .pe-pic');
      kv.pic = pic && {
        chips: [...pic.querySelectorAll('.pe-pic-head .badge')].map((b) => b.textContent + '|' + b.className),
        sub: pic.querySelector('.pe-pic-head .sub').textContent,
        gauge: [...pic.querySelectorAll('.pe-gauge text')].map((t) => t.textContent),
        bars: [...pic.querySelectorAll('.pe-bars .pv')].map((t) => t.textContent),
        fits: pic.getBoundingClientRect().right <= document.querySelector('.drawer-panel').getBoundingClientRect().right + 1
      };
      return kv;
    }, FLAG_SYM);
    const other = await p.evaluate((sym) => { const s = window.SB.ctx.bySym[sym]; return [s.peOwn, s.peOwnYears, s.peCheck]; }, SENT_SYM);
    // the 5-year results table: on a wide screen two doors - the tables on the left, the stock window on the right (18-Nov-2026)
    await p.waitForSelector('#door-fin-q .fin-t', { timeout: 10000 });
    await p.waitForSelector('#door-fin-y .fin-t', { timeout: 10000 });
    await p.waitForTimeout(500);                       // the doors have finished sliding in
    const fin = await p.evaluate(() => {
      const t = document.querySelector('#door-fin-q .fin-t');
      const rows = {};
      t.querySelectorAll('tbody tr').forEach((tr) => { rows[tr.querySelector('th').textContent] = [...tr.querySelectorAll('td')].map((x) => x.textContent); });
      const sc = document.querySelector('#door-fin-q .fin-scroll');
      const door = document.querySelector('#fin-door').getBoundingClientRect(), panel = document.querySelector('.drawer-panel').getBoundingClientRect();
      return { heads: [...t.querySelectorAll('thead th')].map((x) => x.textContent), rows, note: document.querySelector('#door-note').textContent,
        yHeads: [...document.querySelectorAll('#door-fin-y .fin-t thead th')].map((x) => x.textContent),
        notesInTables: document.querySelectorAll('#fin-door .fin-body .fin-note').length, inPanel: !!document.querySelector('#drawer-body #drawer-fin'),
        csv: [...document.querySelectorAll('#fin-door [data-fin-csv]')].filter((b) => !b.hidden).length,
        scrolled: sc.scrollLeft + sc.clientWidth >= sc.scrollWidth - 2, door: [door.left, door.right], panel: [panel.left, panel.right],
        doorFits: document.querySelector('#fin-door').scrollWidth <= document.querySelector('#fin-door').clientWidth + 1 };
    });
    const chips = await p.$$eval('#door-note [data-fin-basis]', (b) => b.map((x) => x.textContent + (x.classList.contains('on') ? '*' : '')));
    await p.click('#door-note [data-fin-basis="S"]');
    await p.waitForTimeout(200);
    const stand = await p.evaluate(() => ({ heads: [...document.querySelectorAll('#door-fin-q .fin-t thead th')].map((x) => x.textContent),
      tip: document.querySelector('#door-fin-q .fin-t thead th:last-child').getAttribute('data-tip'), note: document.querySelector('#door-note').textContent,
      y: document.querySelector('#door-fin-y .fin-body').textContent, on: document.querySelector('#door-note [data-fin-basis].on').textContent }));
    await p.click('#door-note [data-fin-basis="C"]');
    await p.waitForTimeout(200);
    const backC = await p.$$eval('#door-fin-q .fin-t thead th', (t) => t.length);
    const none = await p.evaluate((sym) => new Promise((ok) => {
      window.SB.openStock(sym);
      const t0 = Date.now();
      (function wait() {
        const b = document.querySelector('#door-fin-q .fin-body');
        if (b && !/Loading/.test(b.textContent)) return ok(b.textContent);
        if (Date.now() - t0 > 8000) return ok('timeout');
        setTimeout(wait, 50);
      })();
    }), SENT_SYM);
    await p.mouse.click(Math.round((fin.door[1] + fin.panel[0]) / 2), 450);          // the space between the doors closes them
    const closed = await p.evaluate(() => document.querySelector('#drawer').hidden);
    // a phone: no doors - the table stays inside the stock window with the Quarterly / Yearly chips
    await p.setViewportSize({ width: 390, height: 820 });
    await p.evaluate((sym) => window.SB.openStock(sym), FLAG_SYM);
    await p.waitForSelector('#drawer-fin .fin-t', { timeout: 10000 });
    await p.waitForTimeout(400);
    const phone = await p.evaluate(() => ({ door: document.querySelector('#fin-door').hidden, doors: document.querySelector('#drawer').classList.contains('doors'),
      panelOk: document.querySelector('#drawer-fin .fin-scroll').getBoundingClientRect().right <= document.querySelector('.drawer-panel').getBoundingClientRect().right,
      note: document.querySelector('#drawer-fin .fin-note').textContent }));
    await p.click('#drawer-fin [data-fin-kind="y"]');
    const finY = await p.$$eval('#drawer-fin .fin-t thead th', (t) => t.map((x) => x.textContent));
    const finYNote = await p.$eval('#drawer-fin .fin-note', (x) => x.textContent);
    const kept = await p.evaluate(() => localStorage.getItem('sb:fin:kind'));
    await p.click('#drawer-fin [data-fin-kind="q"]');
    // wider again while the stock is open: it opens as two doors
    await p.setViewportSize({ width: 1366, height: 900 });
    await p.waitForSelector('#door-fin-q .fin-t', { timeout: 10000 });
    const flipped = await p.evaluate(() => document.querySelector('#drawer').classList.contains('doors') && !document.querySelector('#drawer-body #drawer-fin'));
    await c.close();
    assert.deepStrictEqual(fin.heads, ['', 'Sep 2025', 'Dec 2025*', 'Mar 2026', 'Jun 2026', 'Sep 2026', 'Dec 2026'], fin.heads.join(' | '));
    assert.deepStrictEqual(fin.rows.Sales, ['90.00', '100', '110', '120', '130', '140']);
    assert.deepStrictEqual(fin.rows['OPM %'], ['17%', '20%', '23%', '25%', '27%', '29%']);
    assert.deepStrictEqual(fin.rows['Exceptional items'], ['–', '–', '-3.50', '–', '–', '–'], 'a row with a figure somewhere is shown');
    assert.deepStrictEqual(fin.rows['EPS in Rs'], ['1.13', '1.50', '1.90', '2.30', '2.70', '3.10']);
    assert.ok(fin.rows['Sales growth YoY (same quarter)'] && /\+44%/.test(fin.rows['Sales growth YoY (same quarter)'][4]), JSON.stringify(fin.rows));
    assert.match(fin.note, /^ConsolidatedStandalone Dec 2026: only the standalone results are on NSE so far - the consolidated ones have not come yet\. Consolidated figures, Rs crore, from the company's NSE filings and screener.in · \* = a later filing's comparison column · Σ = the sum of its 4 quarters · sc = screener.in's figures/);
    assert.deepStrictEqual(chips, ['Consolidated*', 'Standalone'], 'a switch between the two tables, the first one on');
    assert.deepStrictEqual(stand.heads, ['', 'Jun 2026', 'Sep 2026d'], 'the standalone table alone - nothing mixed in: ' + stand.heads.join(' | '));
    assert.match(stand.tip, /^Worked out from the year-to-date figures/);
    assert.ok(/Standalone figures, Rs crore/.test(stand.note) && /d = worked out from the other filings' year-to-date figures/.test(stand.note) && stand.on === 'Standalone', JSON.stringify(stand));
    assert.match(stand.y, /No yearly figures/, 'its yearly table: none');
    assert.strictEqual(backC, 7, 'back to the consolidated table');
    assert.ok(fin.note.indexOf(' · ' + FIN_NOTE) > 0, 'the EPS note above the tables: ' + fin.note);
    assert.deepStrictEqual(fin.yHeads, ['', 'Mar 2023sc', 'Mar 2024Σ', 'Mar 2025*', 'Mar 2026', 'TTM'], 'both tables on the left door at once (+ TTM)');
    assert.ok(fin.csv === 2 && fin.scrolled && fin.doorFits && fin.notesInTables === 0 && !fin.inPanel, JSON.stringify(fin));
    assert.ok(fin.door[0] === 0 && fin.panel[1] === 1366 && fin.panel[0] - fin.door[1] >= 40 && fin.panel[0] - fin.door[1] <= 70, 'two doors with a gap: ' + JSON.stringify(fin));
    assert.strictEqual(closed, true, 'a click between the doors closes both');
    assert.ok(phone.door && !phone.doors && phone.panelOk && /from the company's NSE filings · /.test(phone.note), JSON.stringify(phone));
    assert.deepStrictEqual(finY, ['', 'Mar 2023sc', 'Mar 2024Σ', 'Mar 2025*', 'Mar 2026', 'TTM'], 'Σ = a year summed from its 4 quarters, sc = screener.in, TTM = the last 4 quarters');
    assert.match(finYNote, /\* = a later filing's comparison column · Σ = the sum of its 4 quarters · sc = screener.in's figures .* EPS adjusted/);
    assert.strictEqual(kept, '"y"', 'the choice is kept');
    assert.strictEqual(flipped, true, 'wider window: two doors');
    assert.match(none, /No table for .* yet - your laptop reads/);

    assert.deepStrictEqual(errors, [], 'console/page errors');
    ['PE', 'Own median PE', 'PE / own median', 'PE / Ind PE', 'PE check'].forEach((h) => assert.ok(heads.some((x) => x.indexOf(h) === 0), h + ': ' + heads.join(' | ')));
    assert.ok(!heads.some((x) => /^Median PE|^Peak PE/.test(x)), 'hidden at first: ' + heads.join(' | '));
    assert.deepStrictEqual(own, [FLAG_SYM], 'PE below own median');
    assert.deepStrictEqual(both, [FLAG_SYM], 'PE below own + industry median');
    assert.ok(/^25\s*5Y$/.test(row.med) && row.ratio === '0.8' && row.check === 'Below own + industry median', JSON.stringify(row));
    assert.ok(heads2.some((x) => x.indexOf('Median PE 5Y') === 0), 'ticked: ' + heads2.join(' | '));
    ['Own median PE', 'PE check', 'Median PE 1Y / 3Y / 5Y', 'Peak PE 5Y'].forEach((k) => assert.ok(!(k in drawer), k + ': now in the picture'));
    assert.ok(drawer.pic, 'the PE picture in the stock window');
    assert.deepStrictEqual(drawer.pic.chips, ['Cheaper than its usual PE|badge s-good', '20% below industry PE|badge s-good']);
    assert.strictEqual(drawer.pic.sub, 'PE now 20.0 · 33% of its 5-year peak · industry PE 25.0');
    ['1Y 22.0', '3Y 24.0', '5Y 25.0', 'Industry 25.0', 'Peak 61.5', 'PE now 20.0'].forEach((t) => assert.ok(drawer.pic.gauge.includes(t), t + ': ' + drawer.pic.gauge.join(' | ')));
    assert.deepStrictEqual(drawer.pic.bars, ['-9%', '-17%', '-20%', '-67%', '-20%']);
    assert.ok(drawer.pic.fits, 'inside the stock window');
    assert.deepStrictEqual(other.slice(0, 2), [6, 1], 'only a 1-year median: PE 30 / 5');
    assert.match(String(other[2]), /^(Above own median|Above both|Below industry median)$/);
  });

  // the other six themes (owner, 03-Nov-2026): the main pages render with their own tokens, no overflow
  const accents = {};
  for (const theme of ['midnight', 'neon', 'emerald', 'aurora', 'graphite', 'gold']) {
    for (const vp of [{ width: 1366, height: 900 }, { width: 360, height: 780 }]) {
      await check('theme ' + theme + ' ' + vp.width + 'px: overview, watchlist, results, today, markets', async () => {
        const c = await browser.newContext({ viewport: vp });
        await c.addInitScript((t) => { try { localStorage.setItem('sb:theme', JSON.stringify(t)); } catch (e) { /* ignore */ } }, theme);
        const p = await c.newPage(), errors = watchErrors(p);
        const out = [];
        for (const pg of ['overview', 'watchlist', 'results', 'today', 'markets']) {
          await p.goto(base + '#' + pg, { waitUntil: 'load' });
          await p.waitForFunction(dataReady, null, { timeout: 15000 });
          await p.waitForTimeout(400);
          out.push(await p.evaluate(() => ({
            theme: document.documentElement.getAttribute('data-theme'),
            bg: getComputedStyle(document.body).backgroundColor,
            accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            text: document.querySelector('#app').innerText.length,
            ticker: !document.querySelector('#ticker').hidden && document.querySelectorAll('#ticker .tick').length
          })));
        }
        await c.close();
        assert.deepStrictEqual(errors, [], 'console/page errors');
        out.forEach((o) => {
          assert.strictEqual(o.theme, theme);
          assert.notStrictEqual(o.bg, 'rgb(255, 255, 255)', 'a dark page');
          assert.ok(o.overflow <= 0, 'horizontal page overflow ' + o.overflow + 'px');
          assert.ok(o.text > 200, 'page has content');
          assert.ok(o.ticker >= 8, 'movers ticker shown: ' + o.ticker);
        });
        accents[theme] = out[0].accent;
      });
    }
  }
  await check('EPS Target Lab: the owner\'s Q1, 80 % of the way, downside apart, the thesis list, windows, groups, one stock, CSV, next results, target filter', async () => {
    const c = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    await c.addInitScript(() => { try { localStorage.setItem('sb:api', 'true'); } catch (e) { /* ignore */ } });
    const calls = [];
    await routeAll(c, base, liveApi({ priceState: 'DELAYED', session: 'open', provider: 'sheet' }), calls);
    const p = await c.newPage(), errors = watchErrors(p);
    await p.goto(base + '#epst', { waitUntil: 'load' });
    await p.waitForSelector('#et-sum .tiles', { timeout: 15000 });
    const tiles = async () => p.$$eval('#et-sum .tile', (t) => t.map((x) => x.querySelector('.label').innerText.trim() + ' = ' + x.querySelector('.value').innerText.trim()));
    let tl = await tiles();
    assert.ok(/What Jun 2026 · Q1 FY27 says/.test(await p.$eval('#et-sum h2', (h) => h.innerText)), 'the newest ready quarter (the owner\'s Q1)');
    // 60 sessions, 80 % of the way (the owner's rule): 2 of 4 finished, 1 still running, the downside target apart
    assert.ok(tl.indexOf('Long targets (above the entry) = 5') >= 0, tl.join(' | '));
    assert.ok(tl.indexOf('Reached within 60 sessions = 50%') >= 0, tl.join(' | '));
    assert.ok(tl.indexOf('Still running = 1') >= 0 && tl.indexOf('Downside targets = 1') >= 0, tl.join(' | '));
    assert.strictEqual(await p.$eval('#et-t', (x) => x.value), '80');
    assert.deepStrictEqual(await p.$$eval('#et-pick [data-epq]', (b) => b.map((x) => x.textContent.trim() + ':' + x.getAttribute('aria-pressed'))),
      ['Sep 2026 · Q2 FY27 running:false', 'Jun 2026 · Q1 FY27:true']);
    const winRows = await p.$$eval('#et-win tbody tr', (t) => t.map((r) => r.innerText.replace(/\s+/g, ' ').trim()));
    assert.strictEqual(winRows.length, 6);
    assert.ok(/^Until the next results median 70 sessions 4 1 25%/.test(winRows[5]), winRows[5]);
    assert.ok(/^90 sessions .* 4 2 50%/.test(winRows[2]), winRows[2]);
    // the target itself: 60 sessions -> 1 of 4 (FLAG reached it on 75)
    await p.selectOption('#et-t', '100');
    await p.waitForFunction(() => /= 25%|\n25%/.test((document.querySelector('#et-sum .tiles') || {}).innerText || ''));
    tl = await tiles();
    assert.ok(tl.indexOf('Reached within 60 sessions = 25%') >= 0, tl.join(' | '));
    await p.selectOption('#et-w', '90');
    await p.waitForFunction(() => /90 sessions/.test((document.querySelector('#et-sum .tiles') || {}).innerText || ''));
    tl = await tiles();
    assert.ok(tl.indexOf('Reached within 90 sessions = 50%') >= 0, tl.join(' | '));
    // the downside section
    const down = await p.$eval('#et-down', (x) => x.innerText);
    assert.ok(/Downside targets \(target below the entry price\)/.test(down) && /Fell to it within 90 sessions\s*100%/.test(down), down.slice(0, 400));
    // the thesis list: every quarter read (the other one without the charts' paths)
    await p.waitForSelector('#et-th-t table', { timeout: 15000 });
    assert.ok(calls.some((u) => /\/api\/epstarget\?q=Sep%202026&lite=1$/.test(u)), calls.filter((u) => /epstarget/.test(u)).join(' '));
    assert.deepStrictEqual(await p.$$eval('#et-th-t tbody button[data-sym]', (b) => b.map((x) => x.getAttribute('data-sym'))), [FLAG_SYM],
      'reached in every finished quarter (Sep 2026 reached while its window still runs)');
    assert.deepStrictEqual(await p.$$eval('#et-th-t tbody tr:first-child .et-mk', (m) => m.map((x) => x.className.replace('et-mk ', '') + x.textContent)),
      ['et-mk-hit✓', 'et-mk-early✓']);
    await p.click('#et-thesis [data-epth="all"]');
    assert.ok((await p.$$eval('#et-th-t tbody tr', (t) => t.length)) >= 5);
    // groups: upside at the entry
    await p.click('#et-groups [data-epg="upside"]');
    const groups = await p.$$eval('#et-groups tbody tr td:first-child', (t) => t.map((x) => x.innerText.trim()));
    assert.deepStrictEqual(groups, ['0–25%', '25–50%', '50–100%', '100–200%', 'Over 200%']);
    // one stock: the formula and the chart
    await p.fill('#et-q', FLAG_SYM);
    await p.waitForSelector('#et-one .et-one svg');
    const one = await p.$eval('#et-one', (x) => x.innerText);
    assert.ok(one.indexOf('3.61 + 4.67 + 5.17 + 6.81 = 20.26') >= 0 && one.indexOf('(20.26 − 9.44) ÷ 9.44 × 100 = 114.6%') >= 0 &&
      one.indexOf('20.26 × 114.6 = 2322.17') >= 0, one);
    assert.ok(/The price reached the target after 75 sessions/.test(one) && /80% after 60 sessions/.test(one) && /NSE's result filing/.test(one), one);
    assert.ok(/The next quarter's results came out on .* 16:30: 70 sessions after the entry were before them - the target itself not reached before them/.test(one), one);
    assert.deepStrictEqual(await p.$$eval('#et-one .et-eps th', (t) => t.map((x) => x.textContent)),
      ['Sep 2024', 'Dec 2024', 'Mar 2025', 'Jun 2025', 'Sep 2025', 'Dec 2025', 'Mar 2026', 'Jun 2026']);
    assert.strictEqual(await p.$eval('#et-one .et-eps td sup', (x) => x.textContent), 'r', 'screener.in\'s figure marked');
    assert.strictEqual(await p.$$eval('#et-one .et-hit', (x) => x.length), 1, 'the day it was reached on the chart');
    // CSV
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#et-csv')]);
    assert.ok(/eps-target-Jun-2026-90-100\.csv/.test(dl.suggestedFilename()), dl.suggestedFilename());
    // the status chips: the downside target and the one without a target
    await p.fill('#et-q', '');
    await p.click('#et-all [data-eps="down"]');
    await p.waitForTimeout(200);
    assert.deepStrictEqual(await p.$$eval('#et-all-t tbody button[data-sym]', (b) => b.map((x) => x.getAttribute('data-sym'))), [EPST_SYMS[4]]);
    assert.ok(/↓ Fell to it/.test(await p.$eval('#et-all-t tbody', (x) => x.innerText)));
    await p.click('#et-all [data-eps="none"]');
    await p.waitForTimeout(200);
    assert.deepStrictEqual(await p.$$eval('#et-all-t tbody button[data-sym]', (b) => b.map((x) => x.getAttribute('data-sym'))), ['NOTINMAIN']);
    // 50 / 60 / 70 % of the way too (owner, 24-Nov-2026): 60 sessions at 70 % -> [1] reached it on 40 -> 3 of 4
    assert.deepStrictEqual(await p.$$eval('#et-t option', (o) => o.map((x) => x.value)), ['50', '60', '70', '80', '90', '100']);
    await p.selectOption('#et-w', '60');
    await p.waitForFunction(() => /within 60 sessions/.test((document.querySelector('#et-sum .tiles') || {}).innerText || ''));
    await p.selectOption('#et-t', '70');
    await p.waitForFunction(() => /= 75%|\n75%/.test((document.querySelector('#et-sum .tiles') || {}).innerText || ''));
    assert.ok((await tiles()).indexOf('Reached within 60 sessions = 75%') >= 0, (await tiles()).join(' | '));
    // until the next results ("reached within next quarterly result date"): FLAG's 80 % on 60 < 70 yes, [0]'s came after 6 sessions
    // (its 80 % on 8: no), [1] / [2] no, [3]'s next results not out yet
    await p.selectOption('#et-t', '80');
    await p.waitForFunction(() => document.querySelector('#et-t') && document.querySelector('#et-t').value === '80');
    await p.selectOption('#et-w', 'next');
    await p.waitForFunction(() => /before the next results/.test((document.querySelector('#et-sum .tiles') || {}).innerText || ''));
    tl = await tiles();
    assert.ok(tl.indexOf('Reached before the next results = 25%') >= 0 && tl.indexOf('Still running = 1') >= 0, tl.join(' | '));
    assert.ok(/The next results came 70 sessions after the entry for the median result/.test(await p.$eval('#et-sum', (x) => x.innerText)));
    assert.strictEqual(await p.$eval('#et-all-t thead', (x) => /Before the next results/.test(x.innerText)), true);
    // the target filter (owner: "Atleast target vs Entry % ... between"): 30 % to 100 % -> [0] +20 %, [1] +12.5 %, [2] +400 % left out
    await p.selectOption('#et-w', '60');
    await p.waitForFunction(() => /within 60 sessions/.test((document.querySelector('#et-sum .tiles') || {}).innerText || ''));
    await p.selectOption('#et-lo', '30');
    await p.waitForFunction(() => /left out/.test((document.querySelector('#et-filter-note') || {}).innerText || ''));
    await p.selectOption('#et-hi', '100');
    await p.waitForFunction(() => /30% to 100% above the entry/.test((document.querySelector('#et-filter-note') || {}).innerText || ''));
    tl = await tiles();
    assert.ok(tl.indexOf('Reached within 60 sessions = 100%') >= 0 && tl.indexOf('Long targets (above the entry) = 2') >= 0, tl.join(' | '));
    assert.ok(/3 left out by your target filter/.test(await p.$eval('#et-sum .tiles', (x) => x.innerText)));
    assert.strictEqual(await p.$eval('#et-all [data-eps="out"] b', (x) => x.textContent), '3');
    await p.waitForSelector('#et-th-t table', { timeout: 15000 });
    const thSyms = await p.$$eval('#et-th-t tbody button[data-sym]', (b) => b.map((x) => x.getAttribute('data-sym')));
    assert.ok(thSyms.indexOf(FLAG_SYM) >= 0 && thSyms.indexOf(EPST_SYMS[2]) < 0, 'the thesis list follows the filter: ' + thSyms.join(','));
    let st = await p.evaluate(() => JSON.parse(localStorage.getItem('sb:epst:opts')));
    assert.deepStrictEqual([st.lo, st.hi, st.T, st.W], [30, 100, 80, 60], 'kept on this device');
    await p.selectOption('#et-lo', '');
    await p.waitForFunction(() => /at most 100% above the entry/.test((document.querySelector('#et-filter-note') || {}).innerText || ''));
    await p.selectOption('#et-hi', '');
    await p.waitForFunction(() => /every long target counts/.test((document.querySelector('#et-filter-note') || {}).innerText || ''));
    st = await p.evaluate(() => JSON.parse(localStorage.getItem('sb:epst:opts')));
    assert.deepStrictEqual([st.lo, st.hi], [null, null]);
    await p.selectOption('#et-w', '90');
    await p.waitForFunction(() => /within 90 sessions/.test((document.querySelector('#et-sum .tiles') || {}).innerText || ''));
    // every quarter -> another quarter
    assert.strictEqual(await p.$$eval('#et-qs tbody tr', (t) => t.length), 2);
    await p.click('#et-qs button[data-epq="Sep 2026"]');
    await p.waitForFunction(() => /Sep 2026/.test((document.querySelector('#et-sum h2') || {}).innerText || ''));
    assert.ok(calls.some((u) => /\/api\/epstarget\?q=Sep%202026$/.test(u)), calls.filter((u) => /epstarget/.test(u)).join(' '));
    assert.ok(/No long target of Sep 2026 has had 90 sessions yet/.test(await p.$eval('#et-sum', (x) => x.innerText)));
    // a phone: no page overflow
    await p.setViewportSize({ width: 360, height: 780 });
    await p.waitForTimeout(300);
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, 'no horizontal overflow at 360 px');
    await guideShot(p, 'epst', '#et-sum');
    await c.close();
    assert.deepStrictEqual(errors, [], 'console/page errors');
  });

  await check('Analyst Targets: the brokers\' calls, reached or not, the scorecard, new calls, one stock, every call', async () => {
    const c = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    await c.addInitScript(() => { try { localStorage.setItem('sb:api', 'true'); } catch (e) { /* ignore */ } });
    const calls = [];
    await routeAll(c, base, liveApi({ priceState: 'DELAYED', session: 'open', provider: 'sheet' }), calls);
    const p = await c.newPage(), errors = watchErrors(p);
    await p.goto(base + '#recos', { waitUntil: 'load' });
    await p.waitForSelector('#rc-sum .tiles', { timeout: 15000 });
    const tiles = async () => p.$$eval('#rc-sum .tile', (t) => t.map((x) => x.querySelector('.label').innerText.trim() + ' = ' + x.querySelector('.value').innerText.trim()));
    let tl = await tiles();
    // Buy calls, 60 sessions, the target itself: FLAG / PL on 40 yes, Choice no, A on 8 yes, B no, C on 50 yes, D still running (40 sessions)
    assert.ok(tl.indexOf('Calls with a target above the price = 6') >= 0 && tl.indexOf('Reached within 60 sessions = 60%') >= 0, tl.join(' | '));
    assert.ok(tl.indexOf('Still running = 1') >= 0, tl.join(' | '));
    assert.ok(tl.some((x) => /^After 30 \/ 60 \/ 90 sessions = \+/.test(x)) && tl.some((x) => /^Best move within 60 \(MFE\) = \+15\.0%$/.test(x)), tl.join(' | '));
    assert.ok(calls.some((u) => /\/api\/recos$/.test(u)), calls.join(' '));
    // the scorecard: Motilal Oswal ranked first (3 finished, 2 reached)
    const first = await p.$eval('#rc-brokers tbody tr:first-child', (r) => r.innerText.replace(/\s+/g, ' '));
    assert.ok(/^Motilal Oswal 3 3 3 67% 2 of 3/.test(first), first);
    // new calls of the newest 3 days
    assert.ok(/HDFC Securities/.test(await p.$eval('#rc-new', (x) => x.innerText)));
    // a broker -> its calls
    await p.click('#rc-brokers button[data-rcbr="Motilal Oswal"]');
    await p.waitForFunction(() => document.querySelector('#rc-b').value === 'Motilal Oswal');
    assert.strictEqual(await p.$$eval('#rc-all-t tbody tr', (t) => t.length), 3);
    await p.selectOption('#rc-b', '');
    // one stock: every broker's call on it
    await p.fill('#rc-q', FLAG_SYM);
    await p.waitForSelector('#rc-one .et-one');
    const one = await p.$eval('#rc-one', (x) => x.innerText);
    assert.ok(/2 calls from 2 brokers · average target 335\.00 \(from 330\.00 to 340\.00\)/.test(one) && /Prabhudas Lilladher\s+Buy target 330\.00/.test(one) &&
      /reached after 40 sessions/.test(one), one);
    assert.ok(/Choice\s+Buy target 340\.00 when the price was 300\.00 \(\+13\.3%\) - not reached yet in 95 sessions/.test(one), one);
    assert.strictEqual(await p.$eval('#rc-one a[href*="moneycontrol.com"]', (a) => a.getAttribute('target')), '_blank');
    await p.fill('#rc-q', '');
    // the companies not in Main
    assert.ok(/Some Unknown Co/.test(await p.$eval('#rc-nosym', (x) => x.textContent)) && /\(1 company\)/.test(await p.$eval('#rc-nosym summary', (x) => x.textContent)));
    // every call (Sell too): the Sell call's target under the price
    await p.selectOption('#rc-c', 'all');
    await p.waitForFunction(() => /Every call/.test((document.querySelector('#rc-c') || {}).selectedOptions[0].textContent));
    await p.waitForSelector('#rc-all [data-rcs="down"]');
    assert.strictEqual(await p.$eval('#rc-all [data-rcs="down"] b', (x) => x.textContent), '1');
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#rc-csv')]);
    assert.ok(/analyst-targets-60-100\.csv/.test(dl.suggestedFilename()), dl.suggestedFilename());
    const st = await p.evaluate(() => JSON.parse(localStorage.getItem('sb:recos:opts')));
    assert.deepStrictEqual([st.W, st.T, st.calls], [60, 100, 'all']);
    await p.evaluate(() => localStorage.removeItem('sb:recos:opts'));
    await p.setViewportSize({ width: 360, height: 780 });
    await p.waitForTimeout(300);
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, 'no horizontal overflow at 360 px');
    await c.close();
    assert.deepStrictEqual(errors, [], 'console/page errors');
  });

  await check('every theme has its own accent colour', async () => {
    const vals = Object.values(accents);
    assert.strictEqual(vals.length, 6);
    assert.strictEqual(new Set(vals.concat(['#2563eb', '#4c95ef'])).size, 8, JSON.stringify(accents));
  });

  await check('Firebase copy: remote API from web/config.js, EOD pill, no overflow at 360 px', async () => {
    const c = await browser.newContext({ viewport: { width: 360, height: 780 } });
    await c.addInitScript(() => { try { localStorage.setItem('sb:theme', '"dark"'); } catch (e) { /* ignore */ } });
    const calls = [];
    await routeAll(c, FIREBASE, liveApi({ priceState: 'EOD', session: 'closed' }), calls);
    const p = await c.newPage(), errors = watchErrors(p);
    await p.goto(FIREBASE + '#overview', { waitUntil: 'load' });
    await p.waitForFunction(() => window.SB && window.SB.ctx && window.SB.ctx.D && /No market-data provider/.test(window.SB.ctx.market.message || ''), null, { timeout: 15000 });
    const st = await pageState(p);
    await c.close();
    assert.deepStrictEqual(errors, [], 'console/page errors');
    assert.strictEqual(st.apiBase, REMOTE.href);
    assert.ok(calls.length && calls.every((u) => u.indexOf(REMOTE.origin + '/api/') === 0), 'remote API only: ' + calls.join(' '));
    assert.ok(/st-EOD/.test(st.pillCls) && /^EOD/.test(st.pill), 'pill EOD: ' + st.pill);
    assert.strictEqual(st.banner, null, 'no stale banner');
    assert.ok(st.overflow <= 0, 'horizontal page overflow ' + st.overflow + 'px');
  });

  await check('live feed fails (ok:false): saved copy + banner with the reason, candles from data/history.js', async () => {
    const c = await browser.newContext({ viewport: { width: 360, height: 780 } });
    await c.addInitScript(() => { try { localStorage.setItem('sb:api', 'true'); } catch (e) { /* ignore */ } });
    const calls = [];
    await routeAll(c, base, liveApi({ site: 'fail', session: 'open' }), calls);
    const p = await c.newPage(), errors = watchErrors(p);
    await p.goto(base + '#overview', { waitUntil: 'load' });
    await p.waitForFunction(() => window.SB && window.SB.ctx && window.SB.ctx.D && /No market-data provider/.test(window.SB.ctx.market.message || ''), null, { timeout: 15000 });
    const st = await pageState(p);
    const price = await p.evaluate((sym) => window.SB.ctx.bySym[sym].price, SENT_SYM);
    await p.goto(base + '#suggestions', { waitUntil: 'load' });
    await p.waitForFunction(() => window.SB.ctx.history, null, { timeout: 15000 });
    const hLive = await p.evaluate(() => !!window.SB.ctx.history.live);
    await p.waitForTimeout(500);
    await c.close();
    assert.deepStrictEqual(errors, [], 'console/page errors');
    assert.strictEqual(st.live, false);
    assert.ok(/st-CACHED/.test(st.pillCls), 'pill CACHED: ' + st.pillCls);
    assert.ok(st.banner && /Showing a saved copy/.test(st.banner) && /Live data could not be loaded: mock failure: sheet is updating/.test(st.banner), 'banner: ' + st.banner);
    assert.ok(/Saved copy/.test(st.siteRow) && /mock failure/.test(st.siteRow), 'site row: ' + st.siteRow);
    assert.notStrictEqual(price, SENTINEL, 'saved prices, not the live mock');
    assert.strictEqual(hLive, false, 'candles from data/history.js');
    assert.ok(!calls.some((u) => /part=history/.test(u)), 'no live candle request after a failed boot');
    assert.ok(st.overflow <= 0, 'horizontal page overflow ' + st.overflow + 'px');
  });

  await check('live feed unreachable (network error): saved copy + banner', async () => {
    const c = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    await c.addInitScript(() => { try { localStorage.setItem('sb:api', 'true'); } catch (e) { /* ignore */ } });
    await routeAll(c, base, () => 'abort', []);
    const p = await c.newPage(), errors = watchErrors(p);
    await p.goto(base + '#overview', { waitUntil: 'load' });
    await p.waitForFunction(() => window.SB && window.SB.ctx && window.SB.ctx.D && /Market-data API not available/.test(window.SB.ctx.market.message || ''), null, { timeout: 15000 });
    const st = await pageState(p);
    await c.close();
    assert.deepStrictEqual(errors, [], 'console/page errors');
    assert.ok(st.banner && /Live data could not be loaded: /.test(st.banner), 'banner: ' + st.banner);
    assert.ok(/st-CACHED/.test(st.pillCls), 'pill CACHED');
  });

  // owner, 17-Nov-2026 ("why these tables are empty. when page is not live. Make all pages and tables availabe alltime"): a good live
  // read is kept on the device (IndexedDB 'sb-site'); a later failed read shows that copy - every table filled, a warn banner
  await check('live feed fails after a good read: the last live copy kept on this device fills every page (Zerodha tables too)', async () => {
    const c = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    await c.addInitScript(() => { try { localStorage.setItem('sb:api', 'true'); } catch (e) { /* ignore */ } });
    const calls = [];
    let mode = 'ok';
    const okApi = liveApi({ priceState: 'DELAYED', session: 'open' }), failApi = liveApi({ site: 'fail', session: 'open' });
    await routeAll(c, base, (u, req) => (mode === 'ok' ? okApi(u, req) : failApi(u, req)), calls);
    const p = await c.newPage(), errors = watchErrors(p);
    await p.goto(base + '#suggestions', { waitUntil: 'load' });
    await p.waitForFunction(() => window.SB && window.SB.ctx && window.SB.ctx.history && window.SB.ctx.history.live, null, { timeout: 15000 });
    // wait until the three parts are kept
    await p.waitForFunction(() => Promise.all(['main', 'history', 'history60'].map((k) => window.SB.keep.get(k))).then((a) => a.every(Boolean)), null, { timeout: 15000 });
    mode = 'fail';
    const before = calls.length;
    await p.goto(base + '#signals', { waitUntil: 'load' });
    await p.reload({ waitUntil: 'load' });
    await p.waitForFunction(() => window.SB && window.SB.ctx && window.SB.ctx.D && window.SB.ctx.site.kept, null, { timeout: 15000 });
    await p.waitForSelector('#sg-itd-t table', { timeout: 15000 });
    const st = await pageState(p);
    const got = await p.evaluate((sym) => ({ price: window.SB.ctx.bySym[sym].price, itd: document.querySelectorAll('#sg-itd-t tbody tr').length,
      z4: !!document.querySelector('#sg-z4'), stale: window.SB.ctx.site.stale, reason: window.SB.ctx.site.staleReason }), SENT_SYM);
    await p.goto(base + '#suggestions', { waitUntil: 'load' });
    await p.waitForFunction(() => window.SB.ctx.history, null, { timeout: 15000 });
    const H = await p.evaluate(() => ({ live: window.SB.ctx.history.live, kept: window.SB.ctx.history.kept, readAt: window.SB.ctx.history.readAt,
      older: window.SB.ctx.history.older && window.SB.ctx.history.older.days, reason60: window.SB.ctx.site.history60Reason }));
    await p.waitForTimeout(300);
    await c.close();
    assert.deepStrictEqual(errors, [], 'console/page errors');
    assert.strictEqual(st.live, true, 'the kept copy is the live feed\'s');
    assert.ok(got.stale && /mock failure: sheet is updating/.test(got.reason), JSON.stringify(got));
    assert.ok(st.banner && /Live data could not be read just now/.test(st.banner) && /last live copy this device kept/.test(st.banner) &&
      /Every table is filled from it/.test(st.banner), 'banner: ' + st.banner);
    assert.strictEqual(got.price, SENTINEL, 'the live prices of the kept copy, not the saved copy\'s');
    assert.ok(got.itd > 0 && got.z4, 'the Zerodha tables are filled: ' + JSON.stringify(got));
    assert.ok(H.live && H.kept && H.readAt === READ_AT && H.older === 5 && !H.reason60, 'the kept candles + older days: ' + JSON.stringify(H));
    assert.ok(!calls.slice(before).some((u) => /part=history/.test(u)), 'no second wait for the candles: ' + calls.slice(before).join(' '));
  });

  await check('the owner\'s Kite live prices: with the PIN, price + Today % come from Kite with the LIVE label; without it nothing changes', async () => {
    const SUN = Date.UTC(2026, 10, 8, 10, 0);           // the sheet's clock: Sun 08-Nov-2026 15:30 IST (Muhurat day)
    const sheet = watchlistBackend(SUN);
    sheet.gs.setProp('AB_BRIDGE_TOKEN', 'bridge-token');
    const KSYM = SENT_SYM;
    sheet.gs.post({ token: 'bridge-token', action: 'kitelive', at: '2026-11-09 11:00:00', items: [[KSYM, 777.77, 760, 780, 755, 700]],
      indices: [['NIFTY_50', 26543.21, 26400, 26600, 26350, 26000]] });
    const api = (o) => { const site = liveApi(o); return (u, req) => (u.pathname === '/api/watchlists' ? sheet.answer(req) : site(u)); };
    const open = async (pin) => {
      const c = await browser.newContext({ viewport: { width: 1366, height: 900 } });
      await c.addInitScript((pn) => { try { localStorage.setItem('sb:api', 'true'); if (pn) localStorage.setItem('sb:wlsync', JSON.stringify({ pin: pn })); } catch (e) { /* ignore */ } }, pin);
      await routeAll(c, base, api({ priceState: 'DELAYED', session: 'open', provider: 'sheet' }), []);
      const p = await c.newPage(), errors = watchErrors(p);
      await p.goto(base + '#watchlist', { waitUntil: 'load' });
      await p.waitForFunction(dataReady, null, { timeout: 15000 });
      return { c, p, errors };
    };
    const own = await open('Blue2026');
    await own.p.waitForFunction((sym) => { const s = window.SB.ctx.bySym[sym]; return s && s.price === 777.77; }, KSYM, { timeout: 15000 });
    const st = await own.p.evaluate((sym) => ({ chg: window.SB.ctx.bySym[sym].chg, pill: document.querySelector('#status').textContent,
      src: window.SB.ctx.market.source, kiteAsked: true }), KSYM);
    assert.strictEqual(st.chg, 11.11, 'Today % = Kite vs the previous close');
    assert.match(st.pill, /^LIVE/);
    assert.match(st.src, /Kite .*only you/);
    assert.ok(sheet.bodies.some((b) => b.op === 'kite' && b.pin === 'Blue2026'), 'asked with the PIN');
    // owner, 08-Nov-2026: "do whichever we can make as live" - Main's price-based columns follow the Kite price,
    // the day high / low come along, and the Overview's Market statistics count from the prices now
    const dv = await own.p.evaluate((sym) => { const s = window.SB.ctx.bySym[sym]; return { b: s.base, d10: s.d10, up: s.up, tgt: s.tgt, hi: s.dayHigh, lo: s.dayLow, pe: s.pe }; }, KSYM);
    assert.deepStrictEqual([dv.hi, dv.lo], [780, 755], 'Kite\'s day high / low');
    if (typeof dv.b.d10 === 'number' && dv.b.price > 0) assert.ok(Math.abs(dv.d10 - ((1 + dv.b.d10 / 100) * 777.77 / dv.b.price - 1) * 100) < 1e-6, '10D from the price now');
    if (typeof dv.b.pe === 'number' && dv.b.price > 0) assert.ok(Math.abs(dv.pe - dv.b.pe * 777.77 / dv.b.price) < 1e-6, 'PE at the price now');
    if (typeof dv.tgt === 'number' && dv.tgt > 0) assert.ok(Math.abs(dv.up - (dv.tgt / 777.77 - 1) * 100) < 1e-6, 'upside at the price now');
    await own.p.goto(base + '#overview');
    await own.p.waitForSelector('#ov-mstat');
    const ms = await own.p.$eval('#ov-mstat', (x) => x.innerText);
    assert.ok(/Your Main stocks now/.test(ms) && /LIVE/.test(ms), 'Market statistics from the prices now: ' + ms.slice(0, 200));
    // NIFTY 50 from Kite (owner, 08-Nov-2026): the hero tile's level and day change, labelled LIVE
    const hero = await own.p.evaluate(() => { const t = [...document.querySelectorAll('.tile')].find((x) => /NIFTY 50/.test(x.textContent)); return t ? t.innerText : ''; });
    assert.ok(/26,543\.21/.test(hero) && /\+2\.09%/.test(hero) && /LIVE/.test(hero), 'NIFTY 50 tile: ' + hero);
    // after the close (owner, 08-Nov-2026: "after market close, it vanished. show the data"): 10 minutes without a post,
    // the page reloaded - today's last Kite prices stay, labelled EOD, and the live columns keep working from them
    sheet.gs.setNow(SUN + 10 * 60000);
    await own.p.reload({ waitUntil: 'load' });
    await own.p.waitForFunction((sym) => { const s = window.SB && window.SB.ctx && window.SB.ctx.bySym && window.SB.ctx.bySym[sym]; return s && s.price === 777.77; }, KSYM, { timeout: 15000 });
    const cl = await own.p.evaluate(() => ({ pill: document.querySelector('#status').textContent, src: window.SB.ctx.market.source,
      ms: (document.querySelector('#ov-mstat') || {}).innerText || '', live: window.SB.livePrice(window.SB.ctx.stocks.find((x) => x.price === 777.77)),
      hero: ([...document.querySelectorAll('.tile')].find((x) => /NIFTY 50/.test(x.textContent)) || {}).innerText || '' }));
    assert.match(cl.pill, /^EOD/);
    assert.match(cl.src, /last prices your laptop sent today, after the close/);
    assert.ok(cl.live, 'the live columns use them');
    assert.ok(/at today's close/.test(cl.ms), 'Market statistics: ' + cl.ms.slice(0, 160));
    assert.ok(/26,543\.21/.test(cl.hero) && /EOD/.test(cl.hero), 'NIFTY 50 tile after the close: ' + cl.hero);
    sheet.gs.setNow(SUN);                                  // back to the session for the checks below
    assert.deepStrictEqual(own.errors, [], 'console/page errors');
    await own.c.close();
    const n = sheet.bodies.length;
    const other = await open(null);
    await other.p.waitForTimeout(2500);
    const o = await other.p.evaluate((sym) => ({ price: window.SB.ctx.bySym[sym].price, pill: document.querySelector('#status').textContent }), KSYM);
    assert.notStrictEqual(o.price, 777.77, 'no PIN: no Kite price');
    assert.ok(!/^LIVE/.test(o.pill), o.pill);
    assert.strictEqual(sheet.bodies.length, n, 'no PIN: the sheet is not even asked');
    // the PIN typed later on this device (My Watchlists): the Kite prices start without a reload
    await other.p.goto(base + '#lists');
    await other.p.waitForSelector('#wl-pin', { timeout: 15000 });
    await other.p.fill('#wl-pin', 'Blue2026');
    await other.p.press('#wl-pin', 'Enter');
    await other.p.waitForFunction((sym) => window.SB.ctx.bySym[sym].price === 777.77 && /^LIVE/.test(document.querySelector('#status').textContent), KSYM, { timeout: 15000 });
    assert.deepStrictEqual(other.errors, [], 'console/page errors (PIN typed later)');
    await other.c.close();
  });
  await check('the owner\'s Backtest Lab + bell: own rules -> the laptop runs them -> the result; the bell lists the sheet\'s notes', async () => {
    const T = Date.UTC(2026, 10, 9, 10, 0);
    const sheet = watchlistBackend(T);
    sheet.gs.setProp('AB_BRIDGE_TOKEN', 'bridge-token');
    // owner, 11-Nov-2026 ("loading only"): the laptop prepares its candles after an update - the page says so
    sheet.gs.post({ token: 'bridge-token', action: 'lab', op: 'hello', note: 'preparing the candles on the laptop after an update (only once): 600 of 1800 stocks, about 12 min left' });
    sheet.gs.call('ab_noteAdd_', 'mitigated', 'Gap-up FVG (inside FVG) mitigated: ABC', 'Zone 100 - 104, price 103.5 (Live, Kite)', '#signals');
    sheet.gs.call('ab_noteAdd_', 'results', 'Results: 1 new in Main - XYZ', 'XYZ: Rev YoY 12%', '#today');
    const api = (o) => { const site = liveApi(o); return (u, req) => (u.pathname === '/api/watchlists' ? sheet.answer(req) : site(u)); };
    const open = async (pin, hash) => {
      const c = await browser.newContext({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: GUIDE ? 2 : 1 });
      await c.addInitScript((pn) => { try { localStorage.setItem('sb:api', 'true'); if (pn) localStorage.setItem('sb:wlsync', JSON.stringify({ pin: pn })); } catch (e) { /* ignore */ } }, pin);
      await routeAll(c, base, api({ priceState: 'DELAYED', session: 'open', provider: 'sheet' }), []);
      const p = await c.newPage(), errors = watchErrors(p);
      await p.goto(base + hash, { waitUntil: 'load' });
      await p.waitForFunction(dataReady, null, { timeout: 15000 });
      return { c, p, errors };
    };
    const none = await open(null, '#lab');
    await none.p.waitForSelector('#app .page');
    assert.match(await none.p.$eval('#app', (x) => x.innerText), /For you only: type your My Watchlists PIN/);
    assert.ok(await none.p.$eval('#bell', (b) => b.hidden), 'no PIN: no bell');
    await none.c.close();

    const own = await open('Blue2026', '#lab');
    await own.p.waitForSelector('#lab-form', { timeout: 15000 });
    await own.p.waitForSelector('#lab-runs .empty');
    assert.match(await own.p.$eval('#lab-pcnote', (x) => x.textContent), /600 of 1800 stocks, about 12 min left/);
    // the simpler Lab (owner, 12-Nov-2026: "more user-friendly not to be complex"): ready setups, the basics, everything else folded
    const lay = await own.p.evaluate(() => ({ quick: [...document.querySelectorAll('.lab-quick [data-quick]')].map((b) => b.getAttribute('data-quick')),
      secs: [...document.querySelectorAll('#lab-form details.lab-sec')].map((d) => [d.getAttribute('data-sec'), d.open]),
      basics: ['tf', 'group', 'stop', 'stopBuf', 'targetR', 'after', 'trail', 'trailN', 'capital', 'riskPct', 'testFrom'].every((k) => {
        const e = document.querySelector('#lab-form [data-k="' + k + '"]'); return e && e.offsetParent !== null; }),
      guide: (document.querySelector('#lab-form a[href$="Backtest-Lab-Guide.pdf"]') || {}).textContent }));
    assert.deepStrictEqual(lay.quick, ['smc', 'bos', 'both', 'fvg', 'gap', 'fvg4h']);
    await guideShot(own.p, '01-start', '#lab-form');
    assert.deepStrictEqual(lay.secs, [['structure', false], ['fall', false], ['zone', false], ['shape', false], ['trend', false], ['ltf', false], ['entry', false], ['exit', false], ['money', false], ['check', false]]);
    assert.ok(lay.basics, 'the basics are on show');
    assert.match(lay.guide, /Guide/);
    // Daily FVG + 4H Spring (owner, 15-Nov-2026): the card fills its rules (buy at the next open, the lower of the zone bottom / the
    // day's low, or 1 x ATR), its own fields and words; the 15-minute CHoCH fields go when it is not checked
    await own.p.click('[data-quick="fvg4h"]');
    await own.p.waitForSelector('#lab-h4-note');
    assert.deepStrictEqual(await own.p.evaluate(() => ['tf', 'group', 'entry', 'stop', 'stopAtr', 'h4Body', 'h4Zones', 'm15Choch', 'm15Pivot', 'm15Down']
      .map((k) => (document.querySelector('#lab-form [data-k="' + k + '"]') || {}).value)), ['D', 'fvg4h', 'next_open', 'lower', '1', '0.5', 'both', 'show', '3', '2']);
    assert.match(await own.p.$eval('#lab-plain', (x) => x.textContent), /Daily FVG \+ 4H Spring: the first daily candle to come back into an FVG or Gap-up zone is a red candle with a body of at least 0\.5 x ATR closing above the zone bottom, and its two 4-hour candles that day \(09:15 and 13:15\) are a Spring\. A 15-minute CHoCH that day \(swings of 3 candles, at least 2 lower highs and lower lows\) is marked on every trade - the result compares with and without it\./);
    await guideShot(own.p, '01b-fvg4h', '#lab-form .form-grid');
    await own.p.selectOption('#lab-form select[data-k="m15Choch"]', 'off');
    await own.p.waitForFunction(() => !document.querySelector('#lab-form [data-k="m15Pivot"]'));
    assert.ok(!/15-minute CHoCH/.test(await own.p.$eval('#lab-plain', (x) => x.textContent)));
    await own.p.selectOption('#lab-form select[data-k="tf"]', 'W');
    await own.p.waitForFunction(() => /Choose Timeframe: Daily/.test(document.querySelector('#lab-h4-note').textContent));
    await own.p.evaluate(() => { localStorage.removeItem('sb:lab:form'); window.SB.route(true); });     // back to the defaults
    await own.p.waitForFunction(() => document.querySelector('#lab-form [data-k="group"]').value === 'fvg' && !document.querySelector('#lab-h4-note'));
    // My daily scan (owner, 16-Nov-2026, IREDA: "Backtestlab laye entha strategy lam venum, ena rules lam venum nu dailyscan ku angaiye
    // setpanra mari venum ... enakh ethu daily scan ku venumo atha nan choose panikiren"): the setups ticked here + the form's rules ->
    // the sheet -> the laptop's next poll; ChochRules.bat no longer needed
    await own.p.waitForFunction(() => /Not set from this page yet/.test((document.querySelector('#lab-scan-now') || {}).textContent || ''));
    assert.deepStrictEqual(await own.p.$$eval('#lab-scan [data-scan]', (xs) => xs.map((x) => [x.getAttribute('data-scan'), x.type === 'checkbox' ? x.checked : x.value])),
      [['scanChoch', true], ['bos', true], ['scanSpring', true], ['scanGapSpring', true], ['scanH4', false], ['on4H', true], ['onD', true], ['onW', true], ['ltf', '15m']]);
    assert.match(await own.p.$eval('#lab-scan-both', (x) => x.textContent), /CHoCH \+ FVG and BOS \+ FVG together/);
    await own.p.click('[data-quick="smc"]');
    await own.p.waitForFunction(() => document.querySelector('#lab-form [data-k="group"]').value === 'touch');
    let scanTxt = await own.p.$eval('#lab-scan-rules', (x) => x.innerText);
    assert.match(scanTxt, /Swings: 5 candles each side/);
    assert.match(scanTxt, /Discount: Half way down - the 50% line \(discount\) - Its middle/);
    assert.ok(!/Daily FVG \+ 4H Spring/.test(scanTxt));
    await own.p.uncheck('#lab-scan [data-scan="scanSpring"]');
    await own.p.check('#lab-scan [data-scan="scanH4"]');
    await own.p.uncheck('#lab-scan [data-scan="on4H"]');
    scanTxt = await own.p.$eval('#lab-scan-rules', (x) => x.innerText);
    assert.match(scanTxt, /Daily FVG \+ 4H Spring: the first daily candle back into an FVG or Gap-up zone is red with a body of at least 0\.5 x ATR, closes above the zone bottom/);
    // a rule the daily scan does not have (the Lab only) is said
    await own.p.evaluate(() => { const f = JSON.parse(localStorage.getItem('sb:lab:form')); f.upWickMax = 5; localStorage.setItem('sb:lab:form', JSON.stringify(f)); window.SB.route(true); });
    await own.p.waitForSelector('#lab-scan-unused');
    assert.match(await own.p.$eval('#lab-scan-unused', (x) => x.textContent), /Not used by the daily scan \(the Backtest Lab only\): the Spring candle shape\./);
    assert.strictEqual(await own.p.$eval('#lab-scan [data-scan="scanH4"]', (x) => x.checked), true, 'the ticks stay after a redraw');
    await own.p.click('#lab-scan-save');
    await own.p.waitForSelector('#lab-scan-saved');
    let nowTxt = await own.p.$eval('#lab-scan-now', (x) => x.textContent);
    assert.match(nowTxt, /Lists: CHoCH \+ FVG, BOS \+ FVG, Gap-up FVG \+ Spring on D, W; Daily FVG \+ 4H Spring \(the red day's body at least 0\.5 x ATR/);
    assert.match(nowTxt, /CHoCH \/ BOS rules: swings of 5 candles, at least 3 lower highs \/ lows, the zone's middle at least 50% down the move/);
    assert.match(nowTxt, /waiting for your laptop/);
    const scanBody = sheet.bodies.filter((b) => b.op === 'lab' && b.lab.do === 'scan').pop();
    assert.deepStrictEqual([scanBody.lab.rules.pivotN, scanBody.lab.rules.fib, scanBody.lab.rules.part, scanBody.lab.rules.scanSpring, scanBody.lab.rules.scanH4,
      scanBody.lab.rules.on4H, scanBody.lab.rules.ltf, scanBody.lab.params.group], [5, 0.5, 'mid', false, true, false, '15m', 'touch']);
    // the laptop's poll takes them; the page says so
    const poll1 = JSON.parse(JSON.stringify(sheet.gs.post({ token: 'bridge-token', action: 'lab', op: 'poll', scanAt: '' })));
    assert.strictEqual(poll1.scan.rules.scanH4, true);
    sheet.gs.post({ token: 'bridge-token', action: 'lab', op: 'poll', scanAt: poll1.scan.at });
    await own.p.evaluate(() => window.SB.route(true));
    await own.p.waitForFunction(() => /your laptop has it/.test((document.querySelector('#lab-scan-took') || {}).textContent || ''));
    // "Put the daily scan's rules in the form": the saved form values come back
    await own.p.evaluate(() => { const f = JSON.parse(localStorage.getItem('sb:lab:form')); f.pivotN = 10; localStorage.setItem('sb:lab:form', JSON.stringify(f)); window.SB.route(true); });
    await own.p.waitForFunction(() => /10 candles/.test(document.querySelector('#lab-scan-rules').innerText));
    own.p.once('dialog', (d) => d.accept());
    await own.p.click('#lab-scan-load');
    await own.p.waitForFunction(() => /Swings: 5 candles/.test(document.querySelector('#lab-scan-rules').innerText));
    await guideShot(own.p, '00-daily-scan', '#lab-scan');
    await own.p.evaluate(() => { localStorage.removeItem('sb:lab:form'); window.SB.route(true); });     // back to the defaults
    await own.p.waitForFunction(() => document.querySelector('#lab-form [data-k="group"]').value === 'fvg');
    await own.p.click('[data-quick="fvg"]');
    await own.p.waitForSelector('.lab-quick .lab-rec.on [data-quick="fvg"]');
    assert.strictEqual(await own.p.$eval('#lab-form select[data-k="group"]', (e) => e.value), 'fvg');
    // open every section (remembered on this device) for the steps below
    await own.p.evaluate(() => { localStorage.setItem('sb:lab:open', JSON.stringify(['structure', 'fall', 'shape', 'trend', 'ltf', 'entry', 'exit', 'money', 'check'])); window.SB.route(true); });
    await own.p.waitForSelector('details.lab-sec[data-sec="trend"][open]');
    // the owner's idea: 1 % under the zone, 2R, then the last 3 lows
    await own.p.fill('[data-k="stopBuf"]', '1');
    await own.p.fill('[data-k="trailN"]', '3');
    await own.p.fill('[data-k="name"]', 'Zone stop 1%');
    await own.p.dispatchEvent('[data-k="trailN"]', 'change');
    // EMA confluence (owner, 09-Nov-2026): support at the 10 EMA + closed above the 21 EMA
    await own.p.selectOption('[data-k="emaSupport"]', '10');
    await own.p.waitForSelector('[data-k="emaTouch"]');
    await own.p.check('[data-k="above21"]');
    assert.match(await own.p.$eval('#lab-plain', (x) => x.textContent), /Only when the Spring candle took support at the 10 EMA .*; it closed above the 21 EMA\./);
    assert.strictEqual(await own.p.$eval('[data-k="name"]', (x) => x.value), 'Zone stop 1%', 'the form keeps what was typed when it redraws');
    // market condition (owner, 09-Nov-2026): NIFTY 50 above its 50 EMA that day
    await own.p.selectOption('[data-k="mktIndex"]', 'NIFTY_50');
    await own.p.waitForSelector('[data-k="mktAbove"]');
    await own.p.selectOption('[data-k="mktAbove"]', '50');
    assert.match(await own.p.$eval('#lab-plain', (x) => x.textContent), /Only on days when NIFTY 50 closed above its 50 EMA\./);
    assert.match(await own.p.$eval('#lab-plain', (x) => x.textContent), /1% below the zone bottom.*At 2R move the stop up to the target \(a fall back to it = sold there, a win\), then trail it under the lowest low of the last 3 candles/);
    // hard Spring rules (owner, 10-Nov-2026): my recommendation fills the boxes, the plain words follow, the rest of the form stays
    const plainText = () => own.p.$eval('#lab-plain', (x) => x.textContent);
    await own.p.click('[data-rec="hammer"]');
    await own.p.waitForSelector('.lab-rec.on [data-rec="hammer"]');
    assert.deepStrictEqual(await own.p.$$eval('[data-k="upWickMax"],[data-k="loWickMin"]', (x) => x.map((e) => e.value)), ['5', '60']);
    assert.match(await plainText(), /Only Springs where the Spring candle has an upper wick of at most 5% of its range, a lower wick of at least 60% of its range\./);
    assert.strictEqual(await own.p.$eval('[data-k="emaSupport"]', (x) => x.value), '10', 'the EMA rule stays when a recommendation is used');
    await own.p.selectOption('[data-k="upWickMax"]', '0');
    assert.match(await plainText(), /no upper wick at all/);
    await own.p.selectOption('[data-k="fallN"]', '10');
    await own.p.waitForSelector('[data-k="fallPct"]');
    await own.p.selectOption('[data-k="fallPct"]', '8');
    await own.p.selectOption('[data-k="c2Color"]', 'green');
    assert.match(await plainText(), /price had fallen at least 8% from the highest high of the last 10 candles/);
    assert.match(await plainText(), /a green close/);
    assert.strictEqual(await own.p.$$eval('#lab-recs .lab-rec.on', (x) => x.length), 0, 'no recommendation matches any more');
    await own.p.click('#lab-shape-off');
    assert.strictEqual(await own.p.$eval('[data-k="upWickMax"]', (x) => x.value), '100');
    assert.ok(!/Only Springs where/.test(await plainText()), 'cleared');
    await own.p.click('[data-rec="hammer"]');
    // the Pattern library (owner, 13-Nov-2026 - the bullish pattern engine, M1): every pattern of his master prompt with its real
    // state; an implemented one goes into the form with "Use", its own fields and exact rules show, the plain words follow
    await own.p.click('#lab-lib summary');
    await own.p.waitForSelector('#lab-lib-table table');
    assert.match(await own.p.$eval('#lab-lib summary', (x) => x.textContent), /Pattern library - 194 patterns \+ your own \(192 built in the new engine so far\)/);
    await own.p.fill('#lab-lib-q', 'engulf');
    await own.p.waitForFunction(() => document.querySelectorAll('#lab-lib-table tbody tr').length === 1);
    assert.match(await own.p.$eval('#lab-lib-table tbody tr', (x) => x.textContent), /K08\s*Bullish Engulfing\s*Candlestick patterns\s*Implemented/);
    await own.p.fill('#lab-lib-q', '');
    await own.p.click('[data-chip="labcat"][data-v="S"]');
    await own.p.waitForFunction(() => document.querySelectorAll('#lab-lib-table tbody tr').length === 25);
    const smcRows = await own.p.$eval('#lab-lib-table tbody', (x) => x.textContent);
    assert.ok(/S22\s*Discount Zone Entry[\s\S]*Implemented/.test(smcRows) && /S08\s*Bullish Order Block[\s\S]*Implemented/.test(smcRows), 'statuses as they are');
    assert.strictEqual(await own.p.$$eval('#lab-lib-table [data-usepat]', (x) => x.length), 25, 'phase 3: every SMC pattern is built in the new engine');
    await own.p.click('[data-chip="labcat"][data-v="C"]');
    await own.p.waitForFunction(() => document.querySelectorAll('#lab-lib-table tbody tr').length === 20);
    assert.match(await own.p.$eval('#lab-lib-table tbody', (x) => x.textContent), /C01\s*Double Bottom[\s\S]*Implemented/);
    assert.strictEqual(await own.p.$$eval('#lab-lib-table [data-usepat]', (x) => x.length), 20, 'phase 4: the classical chart patterns too');
    await own.p.click('[data-chip="labcat"][data-v="all"]');
    await own.p.fill('#lab-lib-q', 'K08');
    await own.p.waitForSelector('[data-usepat="K08"]');
    await own.p.click('[data-usepat="K08"]');
    await own.p.waitForSelector('#lab-form select[data-k="pattern"]');
    assert.deepStrictEqual(await own.p.$$eval('#lab-form select[data-k="group"],#lab-form select[data-k="pattern"],#lab-form select[data-k="structure"]', (x) => x.map((e) => e.value)),
      ['pattern', 'K08', 'off']);
    assert.match(await plainText(), /^In plain words: Pattern library: K08 Bullish Engulfing on the daily chart\./);
    assert.strictEqual(await own.p.$eval('#lab-form select[data-k="stop"] option[value="zone"]', (x) => x.textContent), 'Under the pattern\'s low (the lowest point of its candles)');
    await own.p.selectOption('[data-k="pattern"]', 'I01');
    await own.p.waitForSelector('[data-k="divPivot"]');
    await own.p.selectOption('[data-k="divRsiMax"]', '40');
    assert.match(await plainText(), /Pattern library: I01 RSI Bullish Divergence \(RSI\(14\), swing lows of 5 candles each side, at most 60 candles apart, RSI at the 1st low at most 40 - the signal comes when the 2nd low is confirmed \(5 candles after it\)\)/);
    assert.match(await own.p.$eval('#lab-form details.lab-rules', (x) => x.textContent), /The exact rules of I01 RSI Bullish Divergence \(version 1\)[\s\S]*never p2/);
    await own.p.selectOption('[data-k="pattern"]', 'B03');
    await own.p.waitForSelector('[data-k="boVol"]');
    await own.p.selectOption('[data-k="boVol"]', '2');
    assert.match(await plainText(), /Pattern library: B03 52-Week High Breakout \(a fresh close above the level, volume at least 2 x the 20-candle average\)/);
    // phase 2 / 3 / 4 (13-Nov-2026): 192 patterns in the picker, grouped; a reversal pattern can be kept only after a fall
    assert.ok(await own.p.$$eval('#lab-form select[data-k="pattern"] optgroup', (x) => x.length) >= 8, 'grouped by category');
    assert.strictEqual(await own.p.$$eval('#lab-form select[data-k="pattern"] option', (x) => x.length), 192);
    assert.ok(!(await own.p.$('#lab-form select[data-k="patCtx"]')), 'a breakout has no trend-context choice');
    await own.p.selectOption('[data-k="pattern"]', 'K01');
    await own.p.waitForSelector('#lab-form select[data-k="patCtx"]');
    await own.p.selectOption('[data-k="patCtx"]', 'down');
    assert.match(await plainText(), /Pattern library: K01 Hammer \(only after a fall - the candle before it closed under its falling 20-SMA\)/);
    assert.match(await own.p.$eval('#lab-form details.lab-rules', (x) => x.textContent), /Shared definitions:[\s\S]*Long body = body >= 0\.7 x ATR/);
    // phase 3: a structure pattern has the swing size; a divergence its swing lows; a relative-strength one names NIFTY 50
    assert.ok(!(await own.p.$('#lab-form select[data-k="patSwing"]')), 'a candle pattern has no swings');
    await own.p.selectOption('[data-k="pattern"]', 'P09');
    await own.p.waitForSelector('#lab-form select[data-k="patSwing"]');
    await own.p.selectOption('[data-k="patSwing"]', '3');
    assert.match(await plainText(), /Pattern library: P09 Swing Failure Pattern \(SFP\) \(swings of 3 candles each side - a swing counts only once 3 candles after it/);
    assert.match(await own.p.$eval('#lab-form details.lab-rules', (x) => x.textContent), /Swings \(phase 3\)[\s\S]*KNOWN patSwing candles/);
    await own.p.selectOption('[data-k="pattern"]', 'I08');
    await own.p.waitForSelector('#lab-form select[data-k="divPivot"]');
    assert.ok(!(await own.p.$('#lab-form select[data-k="divRsiMax"]')), 'only I01 has the RSI limit');
    assert.match(await plainText(), /I08 MACD Positive Divergence \(swing lows of 5 candles each side, at most 60 candles apart/);
    await own.p.selectOption('[data-k="pattern"]', 'I23');
    await own.p.waitForFunction(() => /against NIFTY 50/.test(document.querySelector('#lab-plain').textContent));
    // phase 4: a classical chart pattern - its swings field and its rules
    await own.p.selectOption('[data-k="pattern"]', 'C10');
    await own.p.waitForFunction(() => /C10 Cup and Handle \(swings of \d+ candles each side/.test(document.querySelector('#lab-plain').textContent));
    assert.ok(await own.p.$('#lab-form select[data-k="patSwing"]'), 'the cup is drawn through swings');
    assert.match(await own.p.$eval('#lab-form details.lab-rules', (x) => x.textContent), /Handle: after the right rim[\s\S]*Chart patterns \(phase 4\)/);
    // market structure (owner, 10-Nov-2026): his CHoCH + FVG setup in one click, the plain words follow
    await own.p.evaluate(() => { localStorage.setItem('sb:lab:open', '[]'); window.SB.route(true); });
    await own.p.waitForSelector('details.lab-sec[data-sec="trend"]:not([open])');
    await own.p.click('#lab-smc');
    await own.p.waitForSelector('.lab-rec.on #lab-smc');
    await guideShot(own.p, '02-ready', '.lab-quick');
    await guideShot(own.p, '03-basics', '#lab-form .form-grid');
    await guideShot(own.p, '04-more', '.lab-secs');
    await own.p.evaluate(() => { localStorage.setItem('sb:lab:open', JSON.stringify(['structure', 'fall', 'shape', 'trend', 'ltf', 'entry', 'exit', 'money', 'check'])); window.SB.route(true); });
    await own.p.waitForSelector('details.lab-sec[data-sec="trend"][open]');
    await guideShot(own.p, '05-structure', 'details.lab-sec[data-sec="structure"]');
    await own.p.click('#lab-smc');
    await own.p.waitForSelector('[data-k="downN"]');
    assert.deepStrictEqual(await own.p.$$eval('[data-k="structure"],[data-k="pivotN"],[data-k="downN"],[data-k="zoneWhen"]', (x) => x.map((e) => e.value)), ['only', '5', '3', 'both']);
    assert.match(await plainText(), /Market structure \(swings of 5 candles each side\): a CHoCH = a candle closing above the last swing high after at least 3 lower highs and 3 lower lows\. Only signals where the zone formed after the CHoCH's final low, in the CHoCH move or after it; the zone's middle \(no zone: the entry\) at least 50% down the move from the CHoCH's final low to its high before the signal - the discount half; the first pullback/);
    assert.match(await plainText(), /Buy with an order waiting at the zone top/);
    assert.strictEqual(await own.p.$eval('#lab-form select[data-k="group"]', (e) => e.value), 'touch', 'the setup = the first touch of a zone');
    assert.strictEqual(await own.p.$eval('#lab-form select[data-k="discount"]', (e) => e.value), '0.5');
    assert.strictEqual(await own.p.$eval('#lab-form select[data-k="entry"]', (e) => e.value), 'zone', 'an order at the zone top');
    assert.ok(await own.p.$('.lab-rec.on #lab-smc'), 'the setup card shows In use');
    // the owner's rules of 16-Nov-2026: a gap-down open into the zone (the near stop), no straight fall from the move high, the move
    // high's distance - options, all OFF by default ("ethuvum default ah on la vaika vendam")
    assert.doesNotMatch(await plainText(), /no straight fall into the zone/);
    assert.strictEqual(await own.p.$eval('#lab-form select[data-k="gapAtr"]', (e) => e.value), '0', 'a gap-down open: off');
    assert.ok(!(await own.p.$('#lab-form select[data-k="gapBelow"]')), '... its "at most" box only when on');
    assert.strictEqual(await own.p.$eval('#lab-form select[data-k="hhMax"]', (e) => e.value), '0', 'the move high\'s distance: off');
    assert.strictEqual(await own.p.$eval('#lab-form select[data-k="fallLh"]', (e) => e.value), '0', 'no straight fall: off');
    // the fall into the zone (owner, 16-Nov-2026: "intha field la more options add panu") - its own section, every rule off
    assert.deepStrictEqual(await own.p.$$eval('details.lab-sec[data-sec="fall"] select[data-k]', (x) => x.map((e) => e.getAttribute('data-k') + '=' + e.value)),
      ['fallLh=0', 'fallGreen=0', 'fallRedRun=0', 'fallBigRed=0', 'touchBig=0', 'fallBars=0', 'fallVol=0', 'fallTime=0', 'hhMax=0']);
    assert.match(await own.p.$eval('details.lab-sec[data-sec="fall"]', (x) => x.textContent), /run once with these off - "What worked best" then shows each of them/);
    assert.match(await plainText(), /A candle that opens under the zone top is bought at its open with the usual stop \(an open under that stop is skipped\)\./);
    await own.p.selectOption('#lab-form select[data-k="fallLh"]', '1');
    await own.p.waitForFunction(() => /on the way down from the move high at least 1 lower high \(a swing high with 2 lower candles each side\) - no straight fall into the zone/.test(document.querySelector('#lab-plain').textContent));
    await own.p.selectOption('#lab-form select[data-k="fallGreen"]', '2');
    await own.p.selectOption('#lab-form select[data-k="fallBigRed"]', '1');
    await own.p.selectOption('#lab-form select[data-k="touchBig"]', '1');
    await own.p.waitForFunction(() => /at least 2 green candles on the way down; no red candle on the way down bigger than 1x the zone's height; the touch candle falling into the zone by at most 1x the zone's height/.test(document.querySelector('#lab-plain').textContent));
    assert.match(await own.p.$eval('details.lab-sec[data-sec="fall"] summary', (x) => x.textContent), /4 changed/);
    await guideShot(own.p, '05c-fall', 'details.lab-sec[data-sec="fall"]');
    for (const k of ['fallGreen', 'fallBigRed', 'touchBig']) await own.p.selectOption('#lab-form select[data-k="' + k + '"]', '0');
    await own.p.selectOption('#lab-form select[data-k="gapAtr"]', '0.5');
    await own.p.waitForSelector('#lab-form select[data-k="gapBelow"]');
    assert.strictEqual(await own.p.$eval('#lab-form select[data-k="gapBelow"]', (e) => e.value), '2', '... an open at most 2% under the zone');
    assert.match(await plainText(), /When the touch candle opens inside the zone or at most 2% under its bottom \(a gap down\), it is bought at that open and the stop goes 0\.5 x ATR under it - or just under the final low when that is nearer; a deeper open is skipped\./);
    await own.p.selectOption('#lab-form select[data-k="hhMax"]', '30');
    await own.p.waitForFunction(() => /the move high \(HH\) at most 30% above the zone top/.test(document.querySelector('#lab-plain').textContent));
    await guideShot(own.p, '06b-entry', 'details.lab-sec[data-sec="entry"]');
    await own.p.selectOption('#lab-form select[data-k="gapAtr"]', '0');
    await own.p.waitForFunction(() => !document.querySelector('#lab-form select[data-k="gapBelow"]'));
    await own.p.selectOption('#lab-form select[data-k="hhMax"]', '0');
    await own.p.waitForFunction(() => !/at most 30% above the zone top/.test(document.querySelector('#lab-plain').textContent));
    await own.p.selectOption('#lab-form select[data-k="fallLh"]', '0');
    await own.p.waitForFunction(() => !/no straight fall into the zone/.test(document.querySelector('#lab-plain').textContent));
    // BOS + FVG (owner, 13-Nov-2026: "Shall we track BOS setup like this ... continuous BOS in uptrend. or BOS formed after Choch"):
    // the same setup on the BOS move in one click, its kinds, and the lower-timeframe confirmation
    await own.p.click('#lab-bos');
    await own.p.waitForSelector('.lab-rec.on #lab-bos');
    assert.ok(!(await own.p.$('.lab-rec.on #lab-smc')), 'one setup card in use');
    assert.deepStrictEqual(await own.p.$$eval('#lab-form select[data-k="bosKind"],#lab-form select[data-k="group"],#lab-form select[data-k="discount"]', (x) => x.map((e) => e.value)), ['touch', 'both', '0.5']);
    const setupBoxes = () => own.p.$$eval('#lab-setups [data-setup]', (x) => x.map((e) => e.getAttribute('data-setup') + ':' + e.checked));
    assert.deepStrictEqual(await setupBoxes(), ['choch:false', 'bos:true'], 'the setup tick boxes (14-Nov-2026)');
    assert.match(await plainText(), /BOS \+ FVG \(swings of 5 candles each side\): a BOS = a candle closing above the last swing high when that high was a higher high and the pullback since it a higher low; every BOS - the 1st after a CHoCH \(3 lower highs \/ lows before it\) and the ones of a running up-trend; the BOS move = from that higher low to the highest high before the signal\. Only signals where the zone formed after the BOS's higher low, in the BOS move or after it; the zone's middle \(no zone: the entry\) at least 50% down the move from the BOS's higher low to its high/);
    await own.p.selectOption('#lab-form select[data-k="bosKind"]', 'trend');
    await own.p.waitForSelector('#lab-form select[data-k="upN"]');
    assert.ok(!(await own.p.$('#lab-form select[data-k="downN"]')), 'a running up-trend has no CHoCH before it to count');
    assert.match(await plainText(), /a BOS of a running up-trend \(at least 1 higher high and higher low, not the 1st after a CHoCH\)/);
    await own.p.selectOption('#lab-form select[data-k="ltf"]', '15m');
    await own.p.waitForSelector('#lab-form select[data-k="ltfWait"]');
    assert.deepStrictEqual(await own.p.$$eval('#lab-form select[data-k="ltf"] option', (o) => o.map((x) => x.value)), ['off', '1H', '15m'], 'smaller than the daily chart');
    assert.match(await plainText(), /Confirmation on the 15-minute chart: after the signal, wait up to 5 daily candles for a CHoCH there \(swings of 3 candles, at least 2 lower highs and lower lows\) whose final low is in the zone \(at most 0\.5% under its bottom\); buy at the close of that CHoCH candle; stop a little under that small final low\. No small CHoCH in time, or a daily close under the zone first = no trade\./);
    // the Smart entry (owner, 14-Nov-2026): in the zone -> the small CHoCH's close; above it -> the small FVG top, else the 50% line
    await own.p.selectOption('#lab-form select[data-k="ltfEntry"]', 'smart');
    await own.p.waitForSelector('#lab-smart-note');
    assert.ok(!(await own.p.$('#lab-form select[data-k="ltfUnder"]')) && !(await own.p.$('#lab-form select[data-k="ltfStop"]')), 'Smart has its own final-low / stop rules');
    assert.match(await own.p.$eval('#lab-smart-note', (x) => x.innerText), /Smart buy: the small CHoCH's level \(the small high it broke\) at \/ under the zone top → buy at its close[\s\S]*50% line[\s\S]*the target reached first = missed/);
    assert.match(await plainText(), /Smart buy: its level at \/ under the zone top → at its close; above the zone → an order at the top of its highest small FVG, else at the 50% line of its move\. Stop: a buy above the zone → a little under the small final low, in the zone → as set above\./);
    // the small CHoCH line just above the zone (owner, 14-Nov-2026, PCJEWELLER: "within 2% (it can be controllable)")
    assert.strictEqual(await own.p.$eval('#lab-form select[data-k="ltfNear"]', (x) => x.value), '2', 'Smart: the small CHoCH line at most 2% above the zone top');
    assert.match(await plainText(), /its final low anywhere; its line at most 2% above the zone top\)/);
    await own.p.selectOption('#lab-form select[data-k="ltfNear"]', '1');
    await own.p.waitForFunction(() => /its line at most 1% above the zone top/.test(document.querySelector('#lab-plain').textContent));
    assert.match(await own.p.$eval('#lab-smart-note', (x) => x.innerText), /its line must sit just above the zone \(at most 1% above the zone top\)/);
    await own.p.selectOption('#lab-form select[data-k="ltfNear"]', '2');
    await own.p.waitForFunction(() => /its line at most 2% above the zone top/.test(document.querySelector('#lab-plain').textContent));
    await guideShot(own.p, '05b-ltf', 'details.lab-sec[data-sec="ltf"]');
    await own.p.selectOption('#lab-form select[data-k="ltfEntry"]', 'close');
    await own.p.waitForSelector('#lab-form select[data-k="ltfUnder"]');
    // the small CHoCH above the protected high (owner, 14-Nov-2026)
    await own.p.selectOption('#lab-form select[data-k="ltfChoch"]', 'protected');
    await own.p.waitForFunction(() => /a close above the protected high\) whose final low is in the zone/.test(document.querySelector('#lab-plain').textContent));
    await own.p.selectOption('#lab-form select[data-k="ltfChoch"]', 'last');
    await own.p.selectOption('#lab-form select[data-k="tf"]', 'W');
    await own.p.waitForFunction(() => [...document.querySelectorAll('#lab-form select[data-k="ltf"] option')].map((x) => x.value).join() === 'off,D,1H,15m');
    await own.p.selectOption('#lab-form select[data-k="tf"]', 'D');
    await own.p.selectOption('#lab-form select[data-k="ltf"]', 'off');
    await own.p.waitForFunction(() => !document.querySelector('#lab-form select[data-k="ltfWait"]'));
    // both setups in one run (owner, 14-Nov-2026: "if i want to run CHoch+FVG, BOS+FVG at a same time"): the card and the tick boxes
    await own.p.click('[data-quick="both"]');
    await own.p.waitForSelector('.lab-rec.on [data-quick="both"]');
    assert.deepStrictEqual(await setupBoxes(), ['choch:true', 'bos:true']);
    assert.match(await plainText(), /Two setups together - every zone touch is checked as CHoCH \+ FVG first, then as BOS \+ FVG \(one trade a candle\)\. CHoCH \+ FVG: Market structure[\s\S]* BOS \+ FVG: BOS \+ FVG \(swings of 5/);
    assert.ok(await own.p.$('#lab-form select[data-k="bosKind"]'), 'the BOS kinds with both ticked');
    await own.p.click('#lab-setups [data-setup="bos"]');          // untick BOS -> CHoCH only
    await own.p.waitForFunction(() => !document.querySelector('#lab-form select[data-k="bosKind"]'));
    await own.p.click('#lab-smc');
    await own.p.waitForSelector('.lab-rec.on #lab-smc');
    assert.deepStrictEqual(await setupBoxes(), ['choch:true', 'bos:false']);
    // the TradingView script with these rules (owner, 11-Nov-2026: "give option to copy the pinescript in this page that works
    // with respect to the current setup before running the setup")
    await own.p.evaluate(() => {
      window.__pine = null;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__pine = t; return Promise.resolve(); } } });
    });
    await own.p.selectOption('[data-k="pivotN"]', '8');
    await own.p.click('#lab-pine');
    await own.p.waitForSelector('#lab-pine-box .note.good');
    await guideShot(own.p, '11-pine', '#lab-pine-box');
    const pine = await own.p.evaluate(() => window.__pine);
    assert.match(pine, /^\/\/@version=5\n\/\/ -+ your Backtest Lab rules\n/);
    for (const want of ['structOnly = input.bool(true,', 'pivN = input.int(8,', 'downN = input.int(3,', 'fibLvl = input.float(0.5,', 'discPart = input.string("Middle",',
      'entryMode = input.string("Order at the zone top",', 'stopMode = input.string("Under the zone bottom",', 'belowChoch = input.bool(false,']) {
      assert.ok(pine.includes('\n' + want), 'the script has ' + want);
    }
    assert.match(pine, /^\/\/ First touch of a zone - every FVG \/ Gap-up zone \(your SMC entry\) on the daily chart/m, 'the rules in words on top');
    const pineBox = await own.p.$eval('#lab-pine-box', (x) => x.innerText);
    assert.match(pineBox, /Copied[\s\S]*Pine Editor[\s\S]*Alt\+G/);
    assert.match(pineBox, /Open the Daily \(1D\) chart on TradingView/);
    assert.ok(await own.p.$('#lab-pine-box a[download$=".pine"]'), 'a download link too');
    await own.p.selectOption('[data-k="pivotN"]', '5');
    // the owner's stop / target / exit options (13-Nov-2026): the ATR stop next to the stop loss, a % target, half at the target,
    // the stop to the entry at 1R, a time stop
    await own.p.selectOption('[data-k="stopAtr"]', '2');
    assert.match(await plainText(), /or 2 x ATR\(14\) under the entry - whichever is lower \(the wider stop\)/);
    await own.p.selectOption('[data-k="targetMode"]', 'pct');
    await own.p.waitForSelector('[data-k="targetPct"]');
    await own.p.selectOption('[data-k="targetPct"]', '30');
    await own.p.evaluate(() => { document.querySelector('[data-sec="exit"]').open = true; });
    await own.p.selectOption('[data-k="partialPct"]', '50');
    await own.p.selectOption('[data-k="beAt"]', '1');
    await own.p.selectOption('[data-k="timeN"]', '10');
    await own.p.waitForSelector('[data-k="timeR"]');
    const exitWords = await plainText();
    assert.match(exitWords, /Before the target: once price is 1R up, move the stop to the entry\./);
    assert.match(exitWords, /Time stop: if price has not gone 1R up within 10 candles, sell at that candle's close\./);
    assert.match(exitWords, /At 30% above the entry sell 50% and for the rest move the stop up to the target/);
    assert.match(await own.p.$eval('[data-sec="exit"] summary', (x) => x.textContent), /3 changed/);
    await own.p.selectOption('[data-k="targetMode"]', 'swing');
    await own.p.waitForSelector('[data-k="swingMinR"]');
    assert.match(await plainText(), /At the last swing high \(at least 1R above the entry - none = no trade\) sell 50% and for the rest move the stop up to the target/);
    assert.ok(/Only Springs where the Spring candle has an upper wick of at most 5%/.test(await plainText()), 'the Spring rules stay');
    // the development / test split (owner, 12-Nov-2026): a test period from 2020
    await own.p.fill('[data-k="testFrom"]', '2020-01-01');
    await own.p.dispatchEvent('[data-k="testFrom"]', 'change');
    assert.match(await plainText(), /Development part: the signals before 01 Jan 2020|Development part: the signals before .*2020/);
    await guideShot(own.p, '06-plain', '#lab-plain');
    // the charts PDF to Google Drive only when asked for this run (owner, 15-Nov-2026: "need iruntha matum driveku anupalam")
    assert.strictEqual(await own.p.$eval('.lab-actions [data-k="pdfDrive"]', (x) => x.checked), false, 'Drive copy off by default');
    await own.p.check('.lab-actions [data-k="pdfDrive"]');
    await guideShot(own.p, '06b-actions', '.lab-actions');
    await own.p.click('#lab-run');
    await own.p.waitForFunction(() => /waiting for your laptop/.test((document.querySelector('#lab-status') || {}).textContent || ''), null, { timeout: 15000 });
    await guideShot(own.p, '07-status', '#lab-status');
    // the laptop (backtest_lab.py) takes it and sends its result
    const got = JSON.parse(JSON.stringify(sheet.gs.post({ token: 'bridge-token', action: 'lab', op: 'poll' })));
    assert.strictEqual(got.job.name, 'Zone stop 1%');
    assert.deepStrictEqual([got.job.params.stopBuf, got.job.params.trailN, got.job.params.stop, got.job.params.targetR], [1, 3, 'zone', 2]);
    assert.deepStrictEqual([got.job.params.emaSupport, got.job.params.above21, got.job.params.above10, got.job.params.emaStack], [10, true, false, false]);
    assert.deepStrictEqual([got.job.params.mktIndex, got.job.params.mktAbove, got.job.params.mktStack], ['NIFTY_50', 50, false]);
    assert.deepStrictEqual([got.job.params.upWickMax, got.job.params.loWickMin, got.job.params.c2Color, got.job.params.recover, got.job.params.fallN, got.job.params.undercutMin],
      [5, 60, 'any', false, 0, 0.1], 'the Spring shape rules reach the laptop (through the sheet\'s generic filter)');
    assert.deepStrictEqual([got.job.params.group, got.job.params.structure, got.job.params.pivotN, got.job.params.downN, got.job.params.zoneWhen,
      got.job.params.belowChoch, got.job.params.firstPull, got.job.params.targetMode, got.job.params.swingMinR, got.job.params.discount,
      got.job.params.discPart, got.job.params.entry],
    ['touch', 'only', 5, 3, 'both', false, true, 'swing', 1, 0.5, 'mid', 'zone'], 'the market-structure rules reach the laptop');
    assert.strictEqual(got.job.params.testFrom, '2020-01-01', 'the test period reaches the laptop');
    assert.strictEqual(got.job.params.pdfDrive, true, 'the Drive tick reaches the laptop');
    assert.deepStrictEqual([got.job.params.stopAtr, got.job.params.targetPct, got.job.params.partialPct, got.job.params.beAt, got.job.params.timeN, got.job.params.timeR],
      [2, 30, 50, 1, 10, 1], 'the stop / target / exit options reach the laptop');
    const missing = (await own.p.evaluate(() => Object.keys(window.SB.lab.DEF))).filter((k) => !(k in got.job.params));
    assert.deepStrictEqual(missing, ['name', 'from', 'to', 'valFrom'], 'every rule reaches the laptop (empty dates left out)');
    assert.ok(got.job.params.swingMode === 'fractal' && got.job.params.rollYears === 3 && got.job.params.atrK === 3);
    const cols = ['sym', 'signal', 'zone', 'where', 'touch', 'entry', 'stop', 'riskPct', 'exit', 'exitOn', 'reason', 'R', 'ret', 'days', 'maxR', 'qty', 'pnl', 'taken', 'ema', 'upW', 'loW', 'dip', 'stage', 'struct', 'target', 'acct',
      'stopBy', 'fill', 'gapo', 'hh', 'flh', 'fgr', 'frr', 'fbars'];
    const result = { v: 1, params: Object.assign({}, got.job.params), groupName: 'FVG+Spring', cacheUpto: '2026-11-06', from: '2010-01-04', to: '2026-10-20',
      stats: { trades: 3, winPct: 66.7, avgR: 1.21, medR: 1.5, totalR: 3.6, pf: 4.6, avgWinR: 2.3, avgLossR: -1, hitPct: 66.7, avgRet: 5.1, medRet: 4.2,
               avgDays: 21.5, bestR: 3.1, worstR: -1, avgMaxR: 2.6, maxLosingStreak: 1, avgRLo: -0.4, avgRHi: 2.8, edge: 'few' },
      // "real or chance?" + the breakdowns + the dev / test split (owner, 12-Nov-2026)
      rolling: [{ from: 2010, to: 2012, trades: 1, winPct: 0, avgR: -1, lo: null, hi: null, edge: 'few' },
        { from: 2025, to: 2026, trades: 2, winPct: 100, avgR: 2.3, lo: 1.6, hi: 3.0, edge: 'few' }],
      split: { at: '2020-01-01', dev: { trades: 1, winPct: 0, avgR: -1, totalR: -1, pf: 0, avgRLo: null, avgRHi: null, edge: 'few', from: '2010-01-04', to: '2010-01-04' },
        test: { trades: 2, winPct: 100, avgR: 2.3, totalR: 4.6, pf: null, avgRLo: 1.6, avgRHi: 3.0, edge: 'few', from: '2026-03-02', to: '2026-09-01' } },
      breakdowns: [
        { key: 'depth', name: 'Zone depth in the move (0% = the move high, 100% = the final low)', trades: 3, rows: [
          { label: '61.8 - 70.5%', trades: 40, winPct: 20, avgR: -0.31, medR: -1, totalR: -12.4, hitPct: 20, lo: -0.6, hi: -0.02, verdict: 'worse',
            dev: { trades: 30, avgR: -0.35 }, test: { trades: 10, avgR: -0.2 }, held: 'yes' },
          { label: '78.6 - 90%', trades: 60, winPct: 40, avgR: 0.45, medR: -0.5, totalR: 27, hitPct: 40, lo: 0.1, hi: 0.8, verdict: 'better',
            dev: { trades: 45, avgR: 0.5 }, test: { trades: 15, avgR: -0.1 }, held: 'no' }] },
        { key: 'lhll', name: 'Lower highs / lows before the CHoCH', trades: 3, rows: [
          { label: '3', trades: 20, winPct: 30, avgR: 0.01, medR: -1, totalR: 0.2, hitPct: 30, lo: -0.4, hi: 0.4, verdict: 'few', dev: { trades: 12, avgR: 0 }, test: { trades: 8, avgR: 0.02 }, held: '' },
          { label: '4', trades: 35, winPct: 35, avgR: 0.34, medR: -0.4, totalR: 11.9, hitPct: 35, lo: -0.1, hi: 0.78, verdict: 'chance', dev: { trades: 20, avgR: 0.3 }, test: { trades: 15, avgR: 0.4 }, held: 'yes' }] }],
      warnings: ['The stocks are today\'s ~1,800 listed ones - ... (survivorship bias).'],
      // the lower-timeframe confirmation against none on the same signals (owner, 13-Nov-2026)
      ltf: { tf: '15m', name: '15-minute', signals: 40, confirmed: 22, why: { ltfnone: 15, ltfbroke: 3 }, nodata: 120, notyet: 1, from: '2021-03-01',
        with: { trades: 21, winPct: 52.4, avgR: 0.85, totalR: 17.9, pf: 2.1, avgRLo: 0.1, avgRHi: 1.6, edge: 'few' },
        without: { trades: 39, winPct: 35.9, avgR: 0.21, totalR: 8.2, pf: 1.3, avgRLo: -0.2, avgRHi: 0.6, edge: 'chance' },
        withoutConfirmed: { trades: 21, winPct: 47.6, avgR: 0.4, totalR: 8.4, pf: 1.5, avgRLo: -0.2, avgRHi: 1.0, edge: 'few' },
        // the Smart entry's three ways + the orders price ran away from (14-Nov-2026)
        missed: 4, missedAtClose: { trades: 4, winPct: 75, avgR: 1.9, totalR: 7.6, pf: 4.1, avgRLo: 0.3, avgRHi: 3.5, edge: 'few' },
        byHow: { close: { n: 9, trades: 9, winPct: 55.6, avgR: 1.1, totalR: 9.9, pf: 2.4, avgRLo: 0.1, avgRHi: 2.1, edge: 'few' },
                 fvg: { n: 8, trades: 8, winPct: 50, avgR: 0.7, totalR: 5.6, pf: 1.9, avgRLo: -0.4, avgRHi: 1.8, edge: 'few' },
                 half: { n: 4, trades: 4, winPct: 50, avgR: 0.6, totalR: 2.4, pf: 1.7, avgRLo: -0.9, avgRHi: 2.1, edge: 'few' } } },
      open: 1, skipped: { risk: 2, ema: 37, mkt: 12, shape: 140, struct: 300, noswing: 5, zoneentry: 9, gapdeep: 4, h4spring: 7, m15no: 3 }, shapeWhy: { upwick: 90, lowick: 40, doji: 10 }, structWhy: { nochoch: 200, bos: 70, above: 20, premium: 10, straight: 5 },
      stages: [{ stage: 'below', name: 'Below the CHoCH level, first pullback (your setup)', trades: 3, open: 1, winPct: 66.7, avgR: 1.21, medR: 1.5, totalR: 3.6, hitPct: 66.7, avgMaxR: 2.6 }],
      reasons: { stop: 1, trail: 2, open: 1 }, indexNames: ['NIFTY_50', 'NIFTY_IT', 'NIFTY_BANK'],
      account: { capital: 1000000, final: 1036000, pnl: 36000, returnPct: 3.6, cagr: 0.21, maxDD: 1, taken: 3, skipped: 1, openNow: 1, openPnl: 500, years: 16.8,
                 curve: [['2010-02-01', 990000], ['2015-01-01', 1012000], ['2026-10-20', 1036000]], blown: null,
                 skipReasons: { full: 0, cap: 1, risk: 0, blown: 0 }, capped: 0 },
      years: [{ year: 2010, trades: 1, winPct: 0, avgR: -1, totalR: -1, pnl: -10000, taken: 1 }, { year: 2026, trades: 2, winPct: 100, avgR: 2.3, totalR: 4.6, pnl: 46000, taken: 2 }],
      hist: [{ label: '-1R to 0', n: 1 }, { label: '1R to 2R', n: 1 }, { label: '3R to 5R', n: 1 }],
      tradeCols: cols, tradesTotal: 4, secs: 1.2, pdf: { file: '2026-11-12 091500 Zone stop 1%.pdf', folder: 'lab_charts', path: 'D:\\StockBlueprintData\\lab_charts', pages: 5, trades: 4, shown: 4,
        drive: { id: '1AbCdEfGhIjKlMnOp_q-r', url: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp_q-r/view' } },
      trades: [['ABC', '2026-10-30', 'Gap-up zone touch inside FVG', 'top', 1, 232.1, 228.4, 1.59, 232.1, '2026-11-06', 'open', 0, 0, 7, 0.4, 0, 0, 1, 'support 10 EMA · above 21', '', '', '', 'disc',
        'CHoCH 240.00 on 2026-10-10 (3 lower highs / lows, final low 220.00 on 2026-10-01) · move high 251.00 · zone middle 62% down the move (50% line 235.50)', 250, '40 shares, Rs 9,284 invested, Rs 148 at risk.',
        'gapatr', 'in', 2.1, 8.2, 2, 3, 2, 9],
               ['XYZ', '2026-09-01', 'FVG', 'bottom', 2, 100, 95, 5, 115.5, '2026-09-25', 'trail', 3.1, 15.3, 24, 3.6, 2000, 31000, 1, 'support 10 EMA · above 21', 0, 80.5, 2.1, 'below', 'CHoCH 110.00 on 2026-08-20 (4 lower highs / lows, final low 92.00)', 115.5, '2000 shares, Rs 2,00,000 invested, Rs 10,000 at risk.', 'gapfinal', 'under', -1.3, 21.5, 0, 0, 5, 4],
               ['PQR', '2026-03-02', 'FVG', 'middle', 1, 50, 48, 4, 53, '2026-03-20', 'trail', 1.5, 6, 18, 2.2, 5000, 15000, 1, 'support 10 EMA · above 21', 4.8, 62.5, 0.6, 'below', 'CHoCH 55.00 on 2026-02-20 (3 lower highs / lows, final low 45.00)', 53, '5000 shares, Rs 2,50,000 invested, Rs 10,000 at risk.', '', 'wick', null, 12.0, 1, 2, 3, 7],
               ['LMN', '2010-01-04', 'FVG', 'top', 1, 30435, 28825, 5, 31290, '2010-01-12', 'trail', 0.5, 2.6, 8, 0.9, 0, 0, 0, 'support 10 EMA · above 21', 9.1, 55, 3.4, 'below', 'CHoCH 32000.00 on 2009-12-20 (3 lower highs / lows, final low 28000.00)', 31290,
                'Not taken: one share costs Rs 30,435, more than your position limit of Rs 15,000 (5% of the account, Money: "One position at most").', '', 'wick', null, 30.4, 1, 1, 2, 6]] };
    assert.deepStrictEqual(JSON.parse(JSON.stringify(sheet.gs.post({ token: 'bridge-token', action: 'lab', op: 'result', id: got.job.id, result: result }))), { ok: true, stored: true });
    // the page sees it done (it asks every 4 s) and opens it
    await own.p.waitForFunction(() => /Every signal/.test((document.querySelector('#lab-result') || {}).textContent || ''), null, { timeout: 20000 });
    await guideShot(own.p, '08-verdict', '#lab-verdict');
    await guideShot(own.p, '08b-head', '#lab-result .card-head');
    await guideShot(own.p, '09-split', 'details[data-rsec="split"]');
    await guideShot(own.p, '10-bd', 'details[data-rsec="bd"]');
    await guideShot(own.p, '12-trades', 'details[data-rsec="trades"]');
    await guideShot(own.p, '13-folded', '#lab-result section.card');
    const view = await own.p.$eval('#lab-result', (x) => x.textContent);
    assert.match(await own.p.$eval('#lab-verdict', (x) => x.textContent), /survivorship bias/, 'every result says the universe is today\'s stocks');
    assert.ok(/Zone stop 1%/.test(view) && /66\.7%/.test(view) && /1\.21R/.test(view) && /₹10,36,000/.test(view), view.slice(0, 600));
    assert.match(view, /At the last swing high \(at least 1R above the entry - none = no trade\) sell 50% and for the rest move the stop up to the target \(a fall back to it = sold there, a win\), then trail it under the lowest low of the last 3 candles/);
    assert.strictEqual(await own.p.$$eval('#lab-trades tbody tr', (r) => r.length), 4);
    // why a signal was skipped: on the word itself (hover / tap), and counted in the account tile
    assert.match(view, /37 left out by your EMA rules · 12 left out by your market rule/);
    assert.match(view, /140 Springs left out by your shape rules/);
    assert.match(view, /Spring shape rules: 4 of 144 Springs passed\. Left out - 90 the upper wick was too long; 40 the lower wick was too short; 10 it was a doji/);
    assert.match(view, /Only 3 trades are left\. An average of 1\.21R over so few trades can easily be luck/);
    assert.match(view, /Only Springs where the Spring candle has an upper wick of at most 5% of its range, a lower wick of at least 60% of its range\./);
    for (const h of ['Upper wick %', 'Lower wick %', 'Dip %', 'Structure', 'Target']) assert.ok(await own.p.$('#lab-trades th:has-text("' + h + '")'), 'the ' + h + ' column');
    assert.match(view, /300 left out by your market-structure rules · 5 without a swing high above \(target\)/);
    assert.match(view, /Market structure: left out - 200 no live CHoCH before it; 70 a BOS came first \(not the first pullback\); 20 its zone is not below the CHoCH level; 10 its zone was not in the discount part of the move \(above your Fib line\); 5 fewer lower highs on the way down from the move high than your rule \(a straight fall\)\./);
    assert.match(view, /9 not first touches \(the zone-top order fills on those only\) · 4 opened too far under the zone \(gap down\)/);
    // the gap-down open (16-Nov-2026): how the order filled, which stop, how high the move high was
    for (const h of ['Order filled', 'Stop from', 'HH above zone %', 'LH on the way', 'Green on the way', 'Red in a row', 'Fall candles']) assert.ok(await own.p.$('#lab-trades th:has-text("' + h + '")'), 'the ' + h + ' column');
    const fillTxt = await own.p.$$eval('#lab-trades tbody tr', (r) => r.map((x) => x.innerText));
    assert.ok(/Gap open: ATR/.test(fillTxt[0]) && /Opened in the zone \(\+2\.1%\)/.test(fillTxt[0]), fillTxt[0]);
    assert.ok(fillTxt.some((t) => /Gap open: final low/.test(t) && /Opened 1\.3% under it/.test(t)) && fillTxt.some((t) => /Came down to it/.test(t)), fillTxt.join('\n'));
    assert.match(view, /7 whose 4-hour candles were not a Spring · 3 without a 15-minute CHoCH that day/, 'Daily FVG + 4H Spring skips (15-Nov-2026)');
    // the charts PDF the laptop made with the run (owner, 12-Nov-2026: a chart page per trade, the losing ones first)
    assert.match(view, /Charts PDF on your laptop - two pages for every trade \(the chart with HH \/ HL \/ LH \/ LL, CHoCH, BOS, zone, BUY; then why it was taken and how it ended\) - the losing ones first: D:\\StockBlueprintData\\lab_charts\\2026-11-12 091500 Zone stop 1%\.pdf - 5 pages.*File Explorer → D:\\StockBlueprintData\\lab_charts \(the newest 20/);
    // ... and its copy in Google Drive (owner, 15-Nov-2026: "pdf um tablet or phone la ye pakanumna"): one button that opens it
    assert.deepStrictEqual(await own.p.$eval('#lab-pdf-drive', (a) => [a.getAttribute('href'), a.getAttribute('target'), a.textContent]),
      ['https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp_q-r/view', '_blank', '📄 Open the charts PDF']);
    assert.match(view, /from your Google Drive \(folder "Stock Blueprint - Backtest PDFs"\) - on this phone, tablet or computer/);
    assert.ok(!(await own.p.$('#lab-pdf-laptop-only')), 'no "only on the laptop" hint when the copy is in Drive');
    // the discount setup's badge + its words, and a TradingView button per trade (owner, 11-Nov-2026: "i open trading view chart and i go to that trade date")
    assert.match(await own.p.$eval('#lab-trades tbody tr:first-child', (x) => x.innerText), /Discount, 1st pullback/);
    assert.match(await own.p.$eval('#lab-trades tbody tr:first-child .lab-acct', (x) => x.getAttribute('data-tip')), /move high 251\.00 · zone middle 62% down the move \(50% line 235\.50\)/);
    assert.strictEqual(await own.p.$eval('#lab-trades tbody tr:first-child a[href*="tradingview.com"]', (a) => a.getAttribute('href')),
      'https://www.tradingview.com/chart/?symbol=NSE%3AABC&interval=D');
    assert.match(view, /By market structure - where each signal sat/);
    // "real or chance?", the dev / test split and the breakdowns (owner, 12-Nov-2026)
    assert.match(await own.p.$eval('#lab-edge', (x) => x.innerText), /Real or chance\?\s*Too few trades[\s\S]*-0\.4R to 2\.8R/);
    assert.match(view, /likely -0\.4R to 2\.8R/);
    const spl = await own.p.$eval('#lab-split', (x) => x.innerText);
    assert.match(spl, /Development \(before\)[\s\S]*-1R[\s\S]*Test \(from\)[\s\S]*2\.3R[\s\S]*1\.6R to 3R/);
    assert.match(view, /Development vs test \(split on/);
    assert.match(view, /The development part itself did not make money per trade/);
    assert.match(view, /What worked best - one thing at a time/);
    assert.match(await own.p.$eval('#lab-rolling', (x) => x.textContent), /2010 - 2012[\s\S]*-1R[\s\S]*2025 - 2026[\s\S]*2\.3R/, 'steady over time');
    const bd1 = await own.p.$eval('#lab-bd', (x) => x.innerText);
    assert.match(bd1, /61\.8 - 70\.5%[\s\S]*-0\.31R[\s\S]*-0\.6R to -0\.02R[\s\S]*Worse[\s\S]*Yes/);
    assert.match(bd1, /78\.6 - 90%[\s\S]*Better[\s\S]*No/);
    await own.p.click('[data-chip="labbd"][data-v="lhll"]');
    await own.p.waitForFunction(() => /Lower highs \/ lows/.test(document.querySelector('#lab-bd').innerText));
    const bd2 = await own.p.$eval('#lab-bd', (x) => x.innerText);
    assert.match(bd2, /Too few[\s\S]*too few/);
    assert.match(bd2, /Could be chance[\s\S]*Yes/);
    assert.match(await own.p.$eval('#lab-stages', (x) => x.textContent), /Below CHoCH, 1st pullback[\s\S]*1\.21R/);
    // the answer first: the verdict card; the rest folded (Development vs test, What worked best and the trades open)
    const rs = await own.p.$$eval('#lab-result details.lab-rsec', (d) => d.map((x) => [x.getAttribute('data-rsec'), x.open]));
    assert.deepStrictEqual(rs, [['ltf', true], ['all', false], ['split', true], ['bd', true], ['stages', false], ['account', false], ['exits', false], ['time', false], ['trades', true]]);
    const ltfT = await own.p.$eval('#lab-ltf', (x) => x.innerText);
    assert.match(ltfT, /With the confirmation[\s\S]*21[\s\S]*52\.4%[\s\S]*0\.85R[\s\S]*Without it - every signal[\s\S]*39[\s\S]*0\.21R[\s\S]*Without it - only the confirmed ones[\s\S]*0\.4R/);
    assert.match(view, /The 15-minute confirmation helped: 0\.85R a trade against 0\.21R without it \(\+0\.64R a trade\), on 21 of the 39 signals\. Few trades/);
    assert.match(await own.p.$eval('#lab-smart', (x) => x.innerText), /Small CHoCH in the zone[\s\S]*9[\s\S]*1\.1R[\s\S]*Above the zone - small FVG[\s\S]*0\.7R[\s\S]*Above the zone - 50% line[\s\S]*0\.6R[\s\S]*Missed orders, if bought at the CHoCH close[\s\S]*4 orders: the target came before the retest[\s\S]*1\.9R/);
    assert.match(view, /40 signals with 15-minute candles \(from [^)]+\): 22 confirmed, not confirmed: 15 no small CHoCH in the zone in time, 3 a candle of the chart closed under the zone first\. 120 older signals left out - no 15-minute candles that old on the laptop/);
    await guideShot(own.p, '10b-ltf', 'details[data-rsec="ltf"]');
    assert.match(await own.p.$eval('#lab-verdict', (x) => x.innerText), /Real or chance\?[\s\S]*Test part \(from[\s\S]*2\.3R a trade over 2 trades[\s\S]*Account/);
    assert.match(await own.p.$eval('#lab-trades .lab-acct:not(.skip)', (x) => x.getAttribute('data-tip')), /^CHoCH \d/);
    assert.match(view, /Only on days when NIFTY 50 closed above its 50 EMA/);
    assert.deepStrictEqual(await own.p.$$eval('#lab-mkt-index option', (o) => o.map((x) => x.value)), ['', 'NIFTY_50', 'NIFTY_IT', 'NIFTY_BANK'],
      'the Index list = the indices the laptop has');
    assert.match(view, /1 skipped: 1 one share cost more than your position limit/);
    const tipText = await own.p.$eval('#lab-trades .lab-acct.skip', (x) => x.getAttribute('data-tip'));
    assert.match(tipText, /^Not taken: one share costs ₹30,435, more than your position limit of ₹15,000/);
    await own.p.hover('#lab-trades .lab-acct.skip');           // (scrolling it into view hides the tip once - move again)
    const bx = await own.p.$eval('#lab-trades .lab-acct.skip', (x) => { const r = x.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
    await own.p.mouse.move(bx[0] + 1, bx[1]);
    await own.p.waitForFunction(() => !document.querySelector('#tip').hidden && /position limit/.test(document.querySelector('#tip').textContent), null, { timeout: 5000 });
    assert.ok(await own.p.$('#lab-trades th:text-is("EMA")'), 'the EMA column (EMA rules on)');
    assert.ok(!(await own.p.$('#lab-curve svg')), 'the account section is folded: no chart yet');
    await own.p.click('details[data-rsec="account"] > summary');
    await own.p.waitForSelector('#lab-curve svg');
    assert.match(await own.p.$eval('#lab-runs', (x) => x.innerText), /Zone stop 1%[\s\S]*Too few trades[\s\S]*2\.3R/, 'the runs comparison: the range verdict and the test part');
    await guideShot(own.p, '14-runs', '#lab-runs');
    await guideShot(own.p, '15-account', 'details[data-rsec="account"]');
    // the bell: two unread notes from the sheet (+ "Backtest ready"), newest first
    await own.p.waitForFunction(() => !document.querySelector('#bell').hidden, null, { timeout: 15000 });
    await own.p.click('#bell');
    await own.p.waitForFunction(() => document.querySelectorAll('.bell-pop .bell-item').length >= 3, null, { timeout: 15000 });
    const bell = await own.p.$eval('.bell-pop', (x) => x.innerText);
    assert.ok(/Backtest ready: Zone stop 1%/.test(bell) && /Results: 1 new in Main - XYZ/.test(bell) && /mitigated: ABC/.test(bell), bell);
    assert.ok(/phone pop-ups|cannot show phone notifications|Home Screen|blocked/i.test(bell), 'the pop-ups switch: ' + bell.slice(-200));
    assert.ok(await own.p.$eval('#bell', (b) => b.classList.contains('has-new')));
    await own.p.click('.bell-pop [data-bell="read"]');
    assert.ok(!(await own.p.$eval('#bell', (b) => b.classList.contains('has-new'))), 'all read');
    assert.ok(sheet.bodies.some((b) => b.op === 'notes') && sheet.bodies.some((b) => b.op === 'lab' && b.lab.do === 'run'), 'ops: ' + sheet.bodies.map((b) => b.op).join(' '));
    // a Pattern library run (owner, 13-Nov-2026: "entha pattern select paninalum, our backtest run only on Bullishengulfing ... stop
    // loss using zone FVG Zone bottom is irrelevant here"): the pattern stops have no zone; a laptop program that ran another pattern
    // is named on the result, a current one shows its pattern engine
    await own.p.keyboard.press('Escape');
    await own.p.evaluate(() => { location.hash = '#lab'; });
    await own.p.waitForSelector('#lab-form [data-k="group"]');
    await own.p.selectOption('#lab-form [data-k="group"]', 'pattern');
    await own.p.waitForSelector('#lab-form select[data-k="pattern"]');
    await own.p.selectOption('#lab-form [data-k="structure"]', 'off').catch(() => {});
    await own.p.selectOption('#lab-form select[data-k="pattern"]', 'K01');
    await own.p.waitForFunction(() => /K01 Hammer/.test(document.querySelector('#lab-plain').textContent));
    await own.p.selectOption('#lab-form select[data-k="entry"]', 'close').catch(() => {});
    assert.deepStrictEqual(await own.p.$$eval('#lab-form select[data-k="stop"] option', (o) => o.map((x) => x.value)), ['zone', 'spring', 'pct'],
      'a pattern has no zone: its low, the signal candle\'s low or a % (the CHoCH low only with the structure on)');
    assert.match(await plainText(), /Stop loss [\d.]+% below the pattern's low \(the lowest point of its candles\)/);
    assert.ok(!/zone bottom/.test(await plainText()), 'no zone bottom in a pattern run\'s words');
    for (const [ran, engine, want] of [['K08', null, /You chose K01 Hammer but your laptop ran K08 Bullish Engulfing - these figures and the charts PDF are for that pattern\. Your laptop's program is older than this website: extract the newest ScreenerBridge\.zip/],
      ['K01', { version: 4, patterns: 192 }, /Laptop program: pattern engine v4 · 192 patterns/]]) {
      await own.p.click('#lab-run');
      await own.p.waitForFunction(() => /waiting for your laptop/.test((document.querySelector('#lab-status') || {}).textContent || ''), null, { timeout: 15000 });
      const pj = JSON.parse(JSON.stringify(sheet.gs.post({ token: 'bridge-token', action: 'lab', op: 'poll' })));
      assert.ok(pj.job.params.group === 'pattern' && pj.job.params.pattern === 'K01' && pj.job.params.stop === 'zone', JSON.stringify(pj.job.params).slice(0, 200));
      const pres = { v: 1, params: Object.assign({}, pj.job.params, { pattern: ran }), groupName: 'Pattern library: ' + ran + (ran === 'K08' ? ' Bullish Engulfing' : ' Hammer'),
        cacheUpto: '2026-11-12', from: '', to: '', stats: { trades: 0 }, trades: [], tradeCols: cols, tradesTotal: 0, open: 0, skipped: {}, secs: 0.4, warnings: [] };
      if (engine) pres.engine = engine;
      assert.deepStrictEqual(JSON.parse(JSON.stringify(sheet.gs.post({ token: 'bridge-token', action: 'lab', op: 'result', id: pj.job.id, result: pres }))), { ok: true, stored: true });
      await own.p.waitForFunction((rx) => new RegExp(rx).test((document.querySelector('#lab-engine') || {}).textContent || ''), want.source, { timeout: 20000 })
        .catch(async (e) => { throw new Error(e.message + ' | status: ' + (await own.p.$eval('#lab-status', (x) => x.textContent).catch(() => '-')).slice(0, 300) +
          ' | result: ' + (await own.p.$eval('#lab-result', (x) => x.textContent).catch(() => '-')).slice(0, 400)); });
    }
    // speed (owner, 16-Nov-2026: "takunu vara mari"): a compressed result unpacked here, the charts PDF told later (the page asks until
    // it is there), a run opened again comes from this device (no sheet call)
    await own.p.click('#lab-run');
    await own.p.waitForFunction(() => /waiting for your laptop/.test((document.querySelector('#lab-status') || {}).textContent || ''), null, { timeout: 15000 });
    const zj = JSON.parse(JSON.stringify(sheet.gs.post({ token: 'bridge-token', action: 'lab', op: 'poll', wait: 3 })));
    assert.strictEqual(zj.v, 2, 'the web app says it takes compressed results');
    const zres = { v: 1, params: zj.job.params, groupName: 'Pattern library: K01 Hammer', cacheUpto: '2026-11-12', from: '', to: '', stats: { trades: 0 }, trades: [],
      tradeCols: cols, tradesTotal: 0, open: 0, skipped: {}, secs: 0.3, warnings: [], engine: { version: 4, patterns: 192 }, pdf: { pending: true } };
    const zblob = require('zlib').gzipSync(Buffer.from(JSON.stringify(zres))).toString('base64');
    const zsum = { params: zres.params, groupName: zres.groupName, cacheUpto: zres.cacheUpto, from: '', to: '', stats: zres.stats, account: {}, split: { test: {} }, pdf: { pending: true } };
    assert.deepStrictEqual(JSON.parse(JSON.stringify(sheet.gs.post({ token: 'bridge-token', action: 'lab', op: 'result', id: zj.job.id, summary: zsum, blob: zblob }))), { ok: true, stored: true });
    await own.p.waitForSelector('#lab-pdf-pending', { timeout: 20000 });
    assert.match(await own.p.$eval('#lab-engine', (x) => x.textContent), /pattern engine v4 · 192 patterns/, 'unpacked here');
    sheet.gs.post({ token: 'bridge-token', action: 'lab', op: 'pdf', id: zj.job.id, pdf: { file: '2026-11-16 101500 fast.pdf', folder: 'lab_charts', path: 'D:\\StockBlueprintData\\lab_charts', pages: 3, trades: 0, shown: 0 } });
    await own.p.waitForFunction(() => !document.querySelector('#lab-pdf-pending') && /Charts PDF on your laptop/.test((document.querySelector('#lab-pdf-box') || {}).textContent || ''), null, { timeout: 20000 });
    const asked = () => sheet.bodies.filter((b) => b.op === 'lab' && b.lab && b.lab.do === 'result').length;
    const before = asked();
    await own.p.evaluate(() => { location.hash = '#lab'; });
    await own.p.waitForFunction(() => !location.hash.includes('/'));
    await own.p.evaluate((id) => { location.hash = '#lab/' + id; }, zj.job.id);
    await own.p.waitForFunction(() => /Charts PDF on your laptop/.test((document.querySelector('#lab-pdf-box') || {}).textContent || ''), null, { timeout: 15000 });
    assert.strictEqual(asked(), before, 'opened again from this device - no sheet call');
    // phone width: no sideways scroll on the page
    await own.p.setViewportSize({ width: 360, height: 780 });
    await own.p.keyboard.press('Escape');
    const over = await own.p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(over <= 1, 'no overflow at 360 px: ' + over);
    assert.deepStrictEqual(own.errors, [], 'console/page errors');
    await own.c.close();
  });
  await check('my watchlists sync: a PC on Vercel and a phone on Firebase share the lists through api/watchlists + the sheet', async () => {
    const sheet = watchlistBackend();
    const api = (o) => { const site = liveApi(o); return (u, req) => (u.pathname === '/api/watchlists' ? sheet.answer(req) : site(u)); };
    const start = async (vp, host, local, opts) => {
      const c = await browser.newContext({ viewport: vp });
      await c.addInitScript((l) => {
        try { if (!window.sessionStorage.getItem('seeded')) { window.sessionStorage.setItem('seeded', '1'); if (l) localStorage.setItem('sb:watchlists', JSON.stringify(l)); localStorage.setItem('sb:api', 'true'); } } catch (e) { /* ignore */ }
      }, local);
      const calls = [];
      await routeAll(c, host, api(opts), calls);
      const p = await c.newPage(), errors = watchErrors(p);
      await p.goto(host + '#lists', { waitUntil: 'load' });
      await p.waitForSelector('#wl-sync .wl-sync', { timeout: 15000 });
      return { c, p, errors, calls };
    };
    const names = (p) => p.$$eval('.wl-name', (x) => x.map((e) => e.querySelector('.wl-name-t').textContent + ' ' + e.querySelector('.wl-n').textContent));
    const synced = (p) => p.waitForFunction(() => window.SB.wlSync.status().phase === 'ok' && !document.querySelector('#wl-sync-now[disabled]'), null, { timeout: 15000 });
    const T = '2026-10-27T10:00:00.000Z';
    const pc = await start({ width: 1366, height: 900 }, base, { v: 1, last: 'wa', lists: [{ id: 'wa', name: 'Swing trades', syms: ['TCS', 'INFY'], created: T, updated: T }] }, { priceState: 'DELAYED', session: 'open' });
    assert.ok(await pc.p.$('#wl-pin'), 'not connected yet: the PIN box');
    await pc.p.fill('#wl-pin', 'Wrong123');
    await pc.p.press('#wl-pin', 'Enter');
    await pc.p.waitForFunction(() => /Checking the PIN/.test((document.querySelector('#wl-pin-msg') || {}).textContent) || /Wrong PIN/.test((document.querySelector('#wl-pin-msg') || {}).textContent), null, { timeout: 15000 });
    assert.strictEqual(await pc.p.$('#wl-sync-off'), null, 'not shown as connected while the PIN is checked');
    await pc.p.waitForFunction(() => /Wrong PIN/.test((document.querySelector('#wl-pin-msg') || {}).textContent), null, { timeout: 15000 });
    await pc.p.fill('#wl-pin', 'Blue2026');
    await pc.p.click('#wl-pin-form button[type=submit]');
    await synced(pc.p);
    assert.match(await pc.p.$eval('#wl-sync', (x) => x.textContent), /In step with your Google Sheet/);
    assert.deepStrictEqual(sheet.lists(), ['Swing trades: TCS INFY'], 'the PC\'s list went to the sheet');

    // the phone (Firebase copy, 360 px) has its own list: after the PIN both have both
    const phone = await start({ width: 360, height: 780 }, FIREBASE, { v: 1, last: 'wb', lists: [{ id: 'wb', name: 'Banks', syms: ['SBIN'], created: T, updated: T }] }, { priceState: 'EOD', session: 'closed' });
    await phone.p.fill('#wl-pin', 'Blue2026');
    await phone.p.press('#wl-pin', 'Enter');
    await synced(phone.p);
    assert.deepStrictEqual(await names(phone.p), ['Banks 1', 'Swing trades 2']);
    assert.deepStrictEqual(sheet.lists(), ['Swing trades: TCS INFY', 'Banks: SBIN']);
    assert.ok(phone.calls.some((u) => u === REMOTE.origin + '/api/watchlists'), 'the Firebase copy uses the Vercel API');
    // a stock added on the phone reaches the sheet by itself, the PC on Sync now
    await phone.p.click('[data-wl-pick]:not(.on)');
    await phone.p.fill('#wl-add-in', 'HDFCBANK');
    await phone.p.press('#wl-add-in', 'Enter');
    await phone.p.waitForFunction(() => true);
    for (let i = 0; i < 50 && sheet.lists()[0] !== 'Swing trades: TCS INFY HDFCBANK'; i++) await phone.p.waitForTimeout(200);
    assert.deepStrictEqual(sheet.lists(), ['Swing trades: TCS INFY HDFCBANK', 'Banks: SBIN']);
    await pc.p.click('#wl-sync-now');
    await pc.p.waitForFunction(() => document.querySelectorAll('.wl-name').length === 2, null, { timeout: 15000 });
    await synced(pc.p);
    assert.deepStrictEqual(await names(pc.p), ['Banks 1', 'Swing trades 3']);
    // a list deleted on the PC goes on the phone too
    await pc.p.click('[data-wl-pick]:not(.on)');
    assert.match(await pc.p.$eval('.wl-title h2', (x) => x.textContent), /Banks/);
    await pc.p.click('#wl-del');
    await pc.p.click('#wl-del-yes');
    for (let i = 0; i < 50 && sheet.lists().length !== 1; i++) await pc.p.waitForTimeout(200);
    assert.deepStrictEqual(sheet.lists(), ['Swing trades: TCS INFY HDFCBANK']);
    await phone.p.click('#wl-sync-now');
    await phone.p.waitForFunction(() => document.querySelectorAll('.wl-name').length === 1, null, { timeout: 15000 });
    // the phone stays connected after a reload; "Stop sync" keeps the lists
    await phone.p.reload({ waitUntil: 'load' });
    await phone.p.waitForSelector('#wl-sync-off', { timeout: 15000 });
    await synced(phone.p);
    assert.deepStrictEqual(await names(phone.p), ['Swing trades 3']);
    const overflow = await phone.p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await phone.p.click('#wl-sync-off');
    await phone.p.waitForSelector('#wl-pin');
    assert.deepStrictEqual(await names(phone.p), ['Swing trades 3'], 'the lists stay on the phone');
    assert.strictEqual(await phone.p.evaluate(() => localStorage.getItem('sb:wlsync')), null, 'the PIN is gone from the phone');
    await phone.p.waitForTimeout(300);
    const allCalls = pc.calls.concat(phone.calls);
    await pc.c.close();
    await phone.c.close();
    assert.deepStrictEqual(pc.errors.concat(phone.errors), [], 'console/page errors');
    assert.ok(overflow <= 0, 'horizontal page overflow ' + overflow + 'px');
    assert.ok(allCalls.every((u) => u.indexOf('Blue2026') < 0), 'the PIN never goes in a URL');
    // 'kite' = the owner's Kite live prices, asked once the PIN is on the device (none come here: no Kite Live tab)
    assert.ok(sheet.bodies.length >= 6 && sheet.bodies.every((b) => b.op === 'get' || b.op === 'put' || b.op === 'kite' || b.op === 'notes'), 'ops: ' + sheet.bodies.map((b) => b.op).join(' '));
  });

  const preview = path.join(__dirname, '..', '..', 'dist', 'stock-blueprint-preview.html');
  if (fs.existsSync(preview)) {
    await check('single-file preview (file://) renders the inlined saved copy', async () => {
      const c = await browser.newContext({ viewport: { width: 1366, height: 900 } });
      const p = await c.newPage(), errors = watchErrors(p);
      await p.goto('file://' + preview + '#overview', { waitUntil: 'load' });
      await p.waitForFunction(dataReady, null, { timeout: 15000 });
      const st = await pageState(p);
      await c.close();
      assert.deepStrictEqual(errors, [], 'console/page errors');
      assert.strictEqual(st.apiBase, null);
      assert.ok(st.banner && /not updated automatically/.test(st.banner), 'banner: ' + st.banner);
    });
  } else console.log('  - single-file preview: skipped (run npm run build first)');

  await browser.close();
  server.close();
  console.log(failures ? '\n' + failures + ' UI check(s) failed' : '\nall UI checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
