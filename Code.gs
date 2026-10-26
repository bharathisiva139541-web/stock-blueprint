/*****************************************************************
 * AUTO OHLC + PATTERN ENGINE
 * -----------------------------------------------------------------
 * Replaces the manual "download NSE report -> paste into
 * Yesterday/Today/ThirdDay/Day4 -> run script" workflow.
 *
 * NOTE: an earlier version of this fetched NSE's raw bhavcopy file
 * directly, but NSE blocks/stalls requests from Apps Script's IP
 * ranges. This version pulls OHLC via GOOGLEFINANCE instead, which
 * runs inside Google's own infrastructure and isn't blocked.
 *
 * MERGED SINGLE-FILE VERSION: everything now lives inside the ONE
 * "Stock Blueprint" spreadsheet. The old setup had two separate
 * files (Blueprint + a "Stock Pattern AutoFeed" file) joined by
 * IMPORTRANGE. Now the data tabs sit alongside Main in the same
 * file, so there's no IMPORTRANGE, no cross-file authorization, and
 * no second file to keep in sync.
 *
 * This file is meant to live in the Apps Script project BOUND to
 * the "Stock Blueprint" Google Sheet (Extensions > Apps Script on
 * that sheet). It:
 *   1. Pulls the stock/symbol list from the Main tab (same file)
 *   2. Fetches each symbol's last few days of daily OHLC via
 *      GOOGLEFINANCE instead of you downloading/pasting NSE data
 *   3. Rebuilds the 4-day OHLC window (Day4/ThirdDay/Yesterday/
 *      Today) fresh from that data every run
 *   4. Runs the SAME candlestick pattern-detection logic you already
 *      use in Stocktracker (ported verbatim from your
 *      "Stocktracker main" Apps Script project) and writes results
 *      to column W of the PatternData tab
 *   5. Computes the long-only FVG tags into column X of PatternData
 *   6. Can run automatically every trading day on a time trigger
 *
 * SETUP (one-time, after merging the tabs into Blueprint):
 *   1. Open the "Stock Blueprint" sheet
 *   2. Extensions > Apps Script
 *   3. Delete any placeholder code, paste this whole file in
 *   4. Set EMAIL_TO below if needed
 *   5. Run `installDailyTrigger` once from the editor toolbar
 *      (you'll be asked to authorize - that's expected)
 *   6. Reload the sheet - a new "Auto Bhavcopy" menu appears with
 *      manual controls (Run Now, Sync Symbols, etc.)
 *****************************************************************/

/***** CONFIG *****/
const AB_TZ = 'Asia/Kolkata';

/*****************************************************************
 * CONTROL PANEL - tune the script's behaviour from the spreadsheet
 * itself, no code editing required.
 *
 * The "Control Panel" tab (menu: "Setup / Add Missing Control Panel
 * Settings") lists every alert-sensitivity knob below - the kind of
 * thing you've already been tuning by hand in code, like the 0.5%
 * FVG approach threshold. Change a value there and it takes effect
 * on the VERY NEXT run (next trigger firing or menu click) - nothing
 * to redeploy.
 *
 * Deliberately NOT included: internal engine plumbing (scraping retry
 * timing, batch sizes, cooldown windows, the 4.5-minute resumable-run
 * time budgets). Those are safety rails tied to Apps Script's 6-minute
 * execution cap and to how hard screener.in can be hit before it
 * throttles back - a bad value there can quietly break the resumable
 * scrape logic rather than just changing how many alerts you get, so
 * they stay hardcoded at their current, already-tested values.
 *
 * How a setting is wired in: `const AB_X = ab_setting_('AB_X', 5);`
 * reads the Control Panel's "AB_X" row if present and non-blank,
 * otherwise falls back to the coded default (5 here) - so an empty,
 * missing, or deleted Control Panel row NEVER breaks anything, it
 * just means "use the default". To add a new tunable: add a row to
 * AB_CP_SECTIONS_ below, then wrap that constant's definition
 * the same way.
 *****************************************************************/
const AB_CONTROL_SHEET = 'Control Panel';

// Read ONCE per execution - every trigger firing or menu click starts
// the whole script fresh, so this one getRange() call loads every
// setting in a single round trip rather than one per constant below.
const AB_SETTINGS_ = ab_loadControlPanel_();

function ab_loadControlPanel_() {
  // Reads either layout: the original (Key | Value in columns A/B) or the
  // friendly one setupControlPanel_() builds (Setting | Value | Default |
  // ... | Internal key). The key/value columns are found by header name,
  // so the tab can be rearranged without breaking anything.
  //
  // A "..._TIME" row (e.g. AB_DAILY_P1_TIME = 18:45) is split into the
  // matching ..._HOUR and ..._MIN settings the code reads - purely a
  // naming convention, so this needs nothing defined further down the
  // file (it runs before the rest of the file's constants exist).
  try {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AB_CONTROL_SHEET);
    if (!sh || sh.getLastRow() < 2) return {};
    const rng = sh.getDataRange();
    const vals = rng.getValues();
    const disp = rng.getDisplayValues();
    let kc = -1, vc = -1, h = -1;
    for (let r = 0; r < Math.min(15, vals.length); r++) {
      const row = vals[r].map(function (v) { return String(v).trim().toLowerCase(); });
      let k = row.findIndex(function (c) { return c.indexOf('internal key') === 0; });
      if (k === -1) k = row.indexOf('key');
      const v = row.indexOf('value');
      if (k !== -1 && v !== -1) { h = r; kc = k; vc = v; break; }
    }
    if (h === -1) return {};
    const out = {};
    for (let r = h + 1; r < vals.length; r++) {
      const key = String(vals[r][kc] || '').trim();
      if (!/^AB_[A-Z0-9_]+$/.test(key)) continue;
      if (/_TIME$/.test(key)) {
        const t = String(disp[r][vc] || '').trim().match(/^(\d{1,2}):(\d{2})/);
        if (t) {
          const base = key.slice(0, -5);
          out[base + '_HOUR'] = Number(t[1]);
          out[base + '_MIN'] = Number(t[2]);
        }
        continue;
      }
      out[key] = vals[r][vc];
    }
    return out;
  } catch (e) {
    return {}; // sheet missing/unreadable - every setting below falls back to its default
  }
}

/**
 * Value from the Control Panel sheet if that key's row exists and
 * isn't blank, otherwise the coded default `def`. `def`'s type (number
 * / boolean / string) decides how a sheet value gets coerced.
 */
function ab_setting_(key, def) {
  const v = AB_SETTINGS_[key];
  if (v === undefined || v === null || v === '') return def;
  if (typeof def === 'number') {
    const n = Number(v);
    return isNaN(n) ? def : n;
  }
  if (typeof def === 'boolean') {
    const s = String(v).trim().toUpperCase();
    return s === 'TRUE' || s === 'YES' || s === '1';
  }
  return String(v).trim();
}

// Everything the Control Panel tab shows, in the order it shows it.
// Each item: key (what ab_setting_ reads), label (plain-English name),
// def (coded default - MUST match the ab_setting_() default in code),
// type: number | hour | time | bool | text | quarter, help, and
// optional fmt (number format). A "time" item's key ends in _TIME and
// stands for the matching _HOUR + _MIN settings (see the loader).
// Each section's `after` says what to do once a value is changed.
const AB_CP_SECTIONS_ = [
  { title: 'General', note: 'Where everything is sent', items: [
    { key: 'AB_EMAIL_TO', label: 'Email recipients', def: 'bharathi200620@gmail.com, spm260193@gmail.com', type: 'text',
      help: 'Every alert and summary email goes to these addresses (comma-separated). Each address counts against Gmail\'s 100-recipients-a-day limit for scripts.' }
  ] },

  { title: 'Daily Pipeline schedule (IST)', note: 'When the evening fetch / patterns / EOD email run',
    after: 'Re-run menu: 1. Daily Pipeline > Install Daily Pipeline Triggers', items: [
    { key: 'AB_DAILY_P1_TIME', label: 'Phase 1 - fetch prices, History30, FVG lists', def: '18:45', type: 'time',
      help: '24-hour time, e.g. 18:45. Runs after market close.' },
    { key: 'AB_DAILY_P2_TIME', label: 'Phase 2 - candlestick patterns', def: '18:53', type: 'time',
      help: 'Must be after Phase 1 has finished (Phase 1 takes up to ~6 minutes).' },
    { key: 'AB_DAILY_P3_TIME', label: 'Phase 3 - alerts, trades, EOD Summary email', def: '19:01', type: 'time',
      help: 'Must be after Phase 1 has finished.' },
    { key: 'AB_DAILY_P4_TIME', label: 'Phase 4 - Quality Watch email + IPO Base Watch email', def: '19:20', type: 'time',
      after: 'Re-run menu: 1. Daily Pipeline > Install Daily Pipeline Triggers',
      help: 'Runs on its own so Phase 3 stays under the 6-minute limit. Keep it ~15 minutes after Phase 3.' },
    { key: 'AB_HOUSEKEEPING_TIME', label: 'Post-daily housekeeping (Index colours, Pivot, Risk Manager)', def: '19:00', type: 'time',
      after: 'Re-run menu: 7. Dashboards > Install Post-Daily Housekeeping Trigger',
      help: 'Keep it after Phase 1.' },
    { key: 'AB_SKIP_WEEKEND_RUNS', label: 'Skip the evening phases and Market Movers emails on Saturday / Sunday - 1 = skip, 0 = run', def: 1, type: 'number',
      help: 'Phases 1-4 and the 11:15 / 5 PM Movers emails do nothing on weekends (market closed). Running one from the menu always works.' },
    { key: 'AB_SKIP_HOLIDAY_RUNS', label: 'Also skip them on weekday exchange holidays (no trading today) - 1 = skip, 0 = run', def: 1, type: 'number',
      help: 'Checks the live trade time of 5 large stocks. If the last trade is not from today the market was closed, so the evening phases and Movers emails do nothing. If the check cannot tell, everything runs as normal.' }
  ] },

  { title: 'Results Season', note: 'Quarterly results checks, Results Tracker and Results Performance tabs', items: [
    { key: 'AB_RS_DAILY_TIME', label: 'Daily results check (runs once a day)', def: '18:00', type: 'time',
      after: 'Re-run menu: 2. Results Season > Install Daily Check', help: '24-hour time.' },
    { key: 'AB_RS_MAX_WAIT_DAYS', label: 'Keep re-checking for (days after the result date)', def: 21, type: 'number',
      help: 'If screener.in still hasn\'t shown the new quarter after this many days, the company is marked "Gave up".' },
    { key: 'AB_RS_UPCOMING_DAYS', label: '"Upcoming results" list in the email covers (days)', def: 15, type: 'number',
      help: 'How far ahead the Results email lists companies due to report.' },
    { key: 'AB_UPCOMING_RESULTS_ON', label: 'Daily "Upcoming Results" email - 1 = on, 0 = off', def: 1, type: 'number',
      help: 'Lists watchlist companies by result date (today first), with Chart and Screener links. Monday to Friday only. Covers the number of days set above.' },
    { key: 'AB_UPCOMING_RESULTS_TIME', label: 'Upcoming Results email - time (Mon-Fri)', def: '06:00', type: 'time',
      after: 'Re-run menu: 2. Results Season > Install Upcoming Results Email (6 AM, Mon-Fri)',
      help: '24-hour time, e.g. 06:00. Google runs it within about 15 minutes after this time.' },
    { key: 'AB_RP_MOVE_PCT', label: 'Move since results that counts as Rallied / Sold off (%)', def: 5, type: 'number',
      help: 'Used by the Results Performance tab\'s Market Reaction and Signal columns.' },
    { key: 'AB_RS_TARGET_QUARTER', label: 'Force the quarter to verify (normally blank)', def: '', type: 'quarter',
      help: 'Leave blank - the quarter is worked out from each result date. Only fill in (e.g. Sep 2026) to override.' }
  ] },

  { title: 'EOD Summary email', note: 'What the evening summary lists', items: [
    { key: 'AB_EOD_GAINER_PCT_MIN', label: 'Top Gainers: minimum day move (%)', def: 10, type: 'number',
      help: 'Stocks up at least this much today are listed as Top Gainers.' },
    { key: 'AB_EOD_LOSER_COUNT', label: 'Top Losers: how many to list', def: 20, type: 'number', help: 'The day\'s worst movers.' },
    { key: 'AB_EOD_INDUSTRY_TOP_N', label: 'Basic Industries to rank each way', def: 5, type: 'number',
      help: 'How many best and worst Basic Industries to show.' },
    { key: 'AB_EOD_INDUSTRY_MIN_COUNT', label: 'Minimum stocks for an industry to be ranked', def: 2, type: 'number',
      help: 'A single stock\'s move isn\'t an "industry" move.' },
    { key: 'AB_MISSED_PCT', label: 'Missed Opportunities: move since flagged (%)', def: 4, type: 'number',
      help: 'Yesterday\'s Mitigated FVG / Spring stocks that moved at least this much are reported.' }
  ] },

  { title: 'FVG zones', note: 'How sensitive the FVG watch lists and alerts are', items: [
    { key: 'AB_UNMIT_NEAR_PCT', label: 'Unmitigated FVG: "approaching" distance above zone top (%)', def: 0.5, type: 'number',
      help: 'Alert when price comes within this % of the zone top.' },
    { key: 'AB_UNMIT_MIN_AGE_DAYS', label: 'Unmitigated FVG: ignore zones younger than (days)', def: 1, type: 'number',
      help: 'Skips zones that only formed today.' },
    { key: 'AB_GAPUP_MIN_PCT', label: 'Gap-up FVG: smallest gap to track (%)', def: 3, type: 'number', help: 'Overnight gap-up size.' },
    { key: 'AB_GAPUP_MAX_PCT', label: 'Gap-up FVG: largest gap still treated as an imbalance (%)', def: 10, type: 'number',
      help: 'Bigger gaps are usually news-driven and are not tracked. (Was 5 - raised so strong-trend gaps such as 7% are not missed.)' },
    { key: 'AB_GAPUP_NEAR_PCT', label: 'Gap-up FVG: "approaching" distance above gap top (%)', def: 0.5, type: 'number',
      help: 'Alert when price comes within this % of the gap top.' },
    { key: 'AB_GAPUP_MIN_AGE_DAYS', label: 'Gap-up FVG: ignore gaps younger than (days)', def: 1, type: 'number',
      help: 'Skips gaps that only formed today.' },
    { key: 'AB_FVG_MIN_AVG_TURNOVER', label: 'Skip illiquid stocks: minimum average daily turnover (Rs)', def: 5000000, type: 'number', fmt: '#,##0',
      help: 'Average of price x volume over the last 30 days (circuit-locked days excluded). 50,00,000 = Rs 50 lakh.' },
    { key: 'AB_CIRCUIT_LOCK_RANGE_PCT', label: 'Circuit-lock detection: max day range (%)', def: 0.05, type: 'number',
      help: 'A day whose High-Low range is below this is treated as frozen (no real trading).' }
  ] },

  { title: 'Technical tags', note: 'EMA support tags in Main', items: [
    { key: 'AB_EMA_SUPPORT_TOUCH_PCT', label: 'EMA support: how close the Low must get to count as a touch (%)', def: 0.5, type: 'number',
      help: 'Used for the 10 EMA and 21 EMA support tags.' }
  ] },

  { title: 'Alert & Trade dashboards', note: 'How alerts and trades are graded', items: [
    { key: 'AB_ALERT_WIN_PCT', label: 'Alert Dashboard: gain that counts as a Win (%)', def: 10, type: 'number',
      help: 'Measured from the alert price.' },
    { key: 'AB_TRADE_WIN_PCT', label: 'Trade Dashboard: gain that counts as a Win (%)', def: 10, type: 'number',
      help: 'Measured from the alert price.' }
  ] },

  { title: 'Risk Management', note: 'Risk Manager tab', items: [
    { key: 'AB_RISK_CAPITAL', label: 'Trading capital (Rs)', def: 100000, type: 'number', fmt: '#,##0',
      help: 'Positions and risk are sized against this.' },
    { key: 'AB_RISK_PCT_PER_TRADE', label: 'Risk per trade (% of capital)', def: 1, type: 'number',
      help: 'Drives the position-size calculator.' },
    { key: 'AB_RISK_MAX_HEAT_PCT', label: 'Max total open risk (% of capital)', def: 6, type: 'number', help: 'Warning only.' },
    { key: 'AB_RISK_DAILY_LOSS_PCT', label: 'Max loss in one day (% of capital)', def: 3, type: 'number', help: 'Warning only.' }
  ] },

  { title: 'IPOs', note: 'IPO Base watch and the weekly IPO sync', items: [
    { key: 'AB_IPOBASE_NEAR_PCT', label: 'IPO Base: "approaching" distance below the base (%)', def: 5, type: 'number',
      help: 'Alert when price gets within this % under the IPO base.' },
    { key: 'AB_IPOBASE_INTRADAY_ON', label: 'IPO Base: live (intraday) alerts during market hours - 1 = on, 0 = off', def: 1, type: 'number',
      help: 'Every 5 minutes: an alert when price comes within the approaching distance below the active base, and when it trades above it. Each symbol alerts once a day per type. The 7 PM email still confirms by the close.' },
    { key: 'AB_IPOBASE_WEAK_BREAKOUT_PCT', label: 'IPO Base: breakouts smaller than this are "weak" (%)', def: 25, type: 'number',
      help: 'Only used for IPOs whose daily price history cannot be fetched: a smaller breakout switches the active base to the 52-week high.' },
    { key: 'AB_IPOBASE_MIN_CONSOL_DAYS', label: 'IPO Base 2: days price must stay under the level before it counts', def: 5, type: 'number',
      help: 'After the rejection candle, this many closes at/below the level before any close above it. If price shoots straight back up, it was not a base.' },
    { key: 'AB_IPOBASE_TOUCH_TOL_PCT', label: 'IPO Base 2 (Rejection type): candle may fall this far short of the previous high (%)', def: 0, type: 'number',
      help: 'Normally 0: the rejection candle must reach the previous high and close below it. Raise it only if you want near-misses to count as rejections too.' },
    { key: 'AB_IPOBASE_REJECT_WITHIN_DAYS', label: 'IPO Base 2: rejection candle must come within this many trading days after the previous base broke', def: 10, type: 'number',
      help: 'Counted from the day the previous base closed above. A pullback weeks after the break is not the next base.' },
    { key: 'AB_IPOBASE_MAX_BASES', label: 'IPO Base: how many bases to track per IPO', def: 2, type: 'number',
      help: 'Base 1 = listing-day high. Base 2 = the high a rejection candle failed at after Base 1 closed above. 2 is what has been taught so far.' },
    { key: 'AB_IPOBASE_LOOKAHEAD_DAYS', label: 'IPO Base: days after listing date to find the first trading day', def: 6, type: 'number',
      help: 'Covers listing dates that fall on a weekend or holiday.' },
    { key: 'AB_IPOBASE_ALERT_MAX_AGE_DAYS', label: 'IPO Base: stop alerting once listed longer than (days)', def: 730, type: 'number',
      help: '0 = no limit. A base can sit unbroken for a year or more (Aeroflex), so keep this long.' },
    { key: 'AB_IPOBASE_FVG_MAX_PCT', label: 'IPO Base: show an open FVG / Gap-up this far under the active base (%)', def: 15, type: 'number',
      help: 'Looks in the UnmitigatedFVG and GapUpFVG tabs for a zone whose top is under the active base, no more than this % below it.' },
    { key: 'AB_IPOBASE_FIRST_PEAK_MIN_DAYS', label: 'IPO Base 1 (when the listing high was dropped): closes under the first rally peak before it counts', def: 3, type: 'number',
      help: 'Only for the FIRST base after a dropped listing high (MILKYMIST). Later bases still need the full count above.' },
    { key: 'AB_IPOBASE_SWING_BARS', label: 'IPO Base 2A: candles each side that must be lower for a swing high', def: 5, type: 'number',
      help: 'Base 2A is a lower swing high inside Base 2. Needs this many lower-high candles on both sides.' },
    { key: 'AB_IPO_SYNC_HOUR', label: 'Weekly IPO sync (Sunday): hour', def: 9, type: 'hour',
      after: 'Re-run menu: 9. IPOs > Install Weekly IPO Trigger', help: '0-23, IST.' },
    { key: 'AB_IPO_SYNC_EMAIL', label: 'Email me when the weekly sync finds new IPOs', def: true, type: 'bool',
      help: 'Tick = on.' }
  ] },

  { title: 'NSE Price Bands', note: 'Daily price band (circuit limit) changes - Price Band Changes tab and email', items: [
    { key: 'AB_PB_EMAIL', label: 'Email me the day\'s price band changes', def: true, type: 'bool',
      help: 'Tick = on. One email each time you import new changes.' },
    { key: 'AB_PB_KEEP_DAYS', label: 'Keep price band history for (days)', def: 120, type: 'number',
      help: 'Older rows are dropped from the Price Band Changes tab.' }
  ] },

  { title: 'Dashboards', note: 'Pivot (Basic Industry Movement) refresh times', items: [
    { key: 'AB_PIVOT_AM_TIME', label: 'Pivot refresh - mid-session', def: '11:15', type: 'time',
      after: 'Re-run menu: 7. Dashboards > Install Pivot Refresh Triggers', help: '24-hour time.' },
    { key: 'AB_PIVOT_PM_TIME', label: 'Pivot refresh - after market', def: '17:00', type: 'time',
      after: 'Re-run menu: 7. Dashboards > Install Pivot Refresh Triggers', help: '24-hour time.' }
  ] },

  { title: 'Candlestick patterns (advanced)', note: 'What counts as each pattern - change with care', items: [
    { key: 'AB_SPRING_BODY_MIN_PCT', label: 'Spring: min body of the 1st (red) candle (% of open)', def: 0.5, type: 'number', help: '' },
    { key: 'AB_SPRING_DAY2_BODY_MAX_PCT', label: 'Spring: 2nd candle body under (% of 1st body)', def: 30, type: 'number', help: '' },
    { key: 'AB_SPRING_UNDERCUT_PCT', label: 'Spring: 2nd candle must dip below the 1st low by (%)', def: 0.1, type: 'number', help: '' },
    { key: 'AB_SPRING_RECLAIM_MAX_PCT', label: 'Spring: 2nd candle high may reach back into the 1st range (%)', def: 50, type: 'number', help: '' },
    { key: 'AB_SPRINGQ_BODY_MIN_PCT', label: 'Spring?: min body of the big red candle (% of open)', def: 1.5, type: 'number', help: '' },
    { key: 'AB_SPRINGQ_WICK_MAX_PCT', label: 'Spring?: lower wick under (% of the candle range)', def: 25, type: 'number', help: '' },
    { key: 'AB_ENGULFING_REQUIRE_BIGGER', label: 'Bullish Engulfing: 2nd body must be bigger', def: true, type: 'bool', help: 'Tick = on.' },
    { key: 'AB_HARAMI_REQUIRE_SMALLER', label: 'Bullish Harami: 2nd body must be smaller', def: true, type: 'bool', help: 'Tick = on.' }
  ] }
];

const AB_CP_HEADER_ROW = 5;

/**
 * Menu: (re)builds the Control Panel tab in its friendly layout -
 * grouped sections, plain-English names, a Default column, what to do
 * after changing a value, and input checks on every cell. Your current
 * values are always carried over (from either the old Key/Value layout
 * or this one), so it's safe to re-run any time - e.g. after an update
 * adds new settings.
 */
function setupControlPanel_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ab_getOrCreateSheet_(AB_CONTROL_SHEET);
  const cur = ab_loadControlPanel_(); // whatever is set now, either layout
  const W = 6;
  const pad = function (n) { return ('0' + n).slice(-2); };
  const has = function (k) { return cur[k] !== undefined && cur[k] !== null && cur[k] !== ''; };

  // ---- work out every row ----
  const known = {};
  const rows = []; // { kind, values[6], item? }
  AB_CP_SECTIONS_.forEach(function (sec) {
    rows.push({ kind: 'section', values: [sec.title.toUpperCase() + '   ·   ' + sec.note, '', '', '', '', ''] });
    sec.items.forEach(function (it) {
      let v = it.def;
      if (it.type === 'time') {
        const base = it.key.slice(0, -5);
        known[base + '_HOUR'] = known[base + '_MIN'] = true;
        if (has(base + '_HOUR')) v = pad(Number(cur[base + '_HOUR'])) + ':' + pad(has(base + '_MIN') ? Number(cur[base + '_MIN']) : 0);
      } else if (has(it.key)) {
        v = cur[it.key];
        if (it.type === 'bool') v = (v === true || /^(true|yes|1)$/i.test(String(v).trim()));
        if (it.type === 'number' || it.type === 'hour') { const n = Number(v); v = isNaN(n) ? it.def : n; }
        if (it.type === 'quarter' && v instanceof Date) v = Utilities.formatDate(v, AB_TZ, 'MMM yyyy');
      }
      known[it.key] = true;
      const after = it.after || sec.after || 'Applies on the next run - nothing else to do';
      rows.push({ kind: 'item', item: it, values: [it.label, v, it.def, it.help || '', after, it.key] });
    });
  });
  // Anything in the old tab this version doesn't know about - kept, not lost.
  // Settings an older version used and this one no longer reads - dropped
  // quietly rather than listed as "other settings".
  const retired = { AB_RS_RUN1_HOUR: 1, AB_RS_RUN1_MIN: 1, AB_RS_RUN2_HOUR: 1, AB_RS_RUN2_MIN: 1,
                    AB_LEARN_COUNT: 1, AB_LEARN_HOUR: 1 };
  const extras = Object.keys(cur).filter(function (k) { return !known[k] && !retired[k]; });
  if (extras.length) {
    rows.push({ kind: 'section', values: ['OTHER SETTINGS   ·   not used by this version of the script (kept so nothing is lost)', '', '', '', '', ''] });
    extras.forEach(function (k) {
      rows.push({ kind: 'item', item: { key: k, type: 'text' }, values: [k, cur[k], '', '', '', k] });
    });
  }

  // ---- reset the tab ----
  const maxR = sh.getMaxRows(), maxC = Math.max(sh.getMaxColumns(), W);
  sh.getRange(1, 1, maxR, maxC).breakApart().clearDataValidations();
  sh.setConditionalFormatRules([]);
  sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function (p) {
    if (p.getDescription() === 'Control Panel keys') p.remove();
  });
  sh.clear();
  const need = AB_CP_HEADER_ROW + rows.length + 2;
  if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
  sh.setHiddenGridlines(true);

  // ---- title + how-to ----
  sh.getRange(1, 1).setValue('Control Panel').setFontSize(18).setFontWeight('bold').setFontColor('#1f3a5f');
  sh.getRange(2, 1).setValue('Change only the yellow Value cells. Most changes apply on the very next run; schedule times also need the ' +
    'menu item shown under "After changing".').setFontColor('#444444');
  sh.getRange(3, 1).setValue('A value in bold blue differs from its default - copy the Default back to undo it. ' +
    'Menu > Settings & Maintenance > Rebuild Control Panel re-tidies this tab and always keeps your values.')
    .setFontColor('#777777').setFontSize(9);

  // ---- table ----
  sh.getRange(AB_CP_HEADER_ROW, 1, 1, W)
    .setValues([['Setting', 'Value', 'Default', 'What it does', 'After changing', 'Internal key (don\'t edit)']])
    .setFontWeight('bold').setFontColor('#5f6368').setBackground('#f1f3f4')
    .setBorder(null, null, true, null, null, null, '#dadce0', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);

  const first = AB_CP_HEADER_ROW + 1;
  const n = rows.length;
  // Text formats first, so times/quarters/email are stored exactly as typed.
  rows.forEach(function (r, i) {
    if (r.kind !== 'item') return;
    const t = r.item.type, row = first + i;
    if (t === 'time' || t === 'quarter' || t === 'text') sh.getRange(row, 2, 1, 2).setNumberFormat('@');
    else if (r.item.fmt) sh.getRange(row, 2, 1, 2).setNumberFormat(r.item.fmt);
  });
  sh.getRange(first, 1, n, W).setValues(rows.map(function (r) { return r.values; }));

  const rules = [];
  rows.forEach(function (r, i) {
    const row = first + i;
    if (r.kind === 'section') {
      sh.getRange(row, 1, 1, W).merge().setBackground('#1f3a5f').setFontColor('#ffffff').setFontWeight('bold')
        .setFontSize(10);
      sh.setRowHeight(row, 26);
      return;
    }
    const it = r.item, a1 = 'B' + row;
    const valCell = sh.getRange(row, 2);
    valCell.setBackground('#fff8d6').setFontWeight('bold').setHorizontalAlignment('center')
      .setBorder(true, true, true, true, null, null, '#e6c84f', SpreadsheetApp.BorderStyle.SOLID);
    let dv = null;
    if (it.type === 'bool') {
      valCell.insertCheckboxes();
      valCell.setValue(r.values[1] === true);
    } else if (it.type === 'number') {
      dv = SpreadsheetApp.newDataValidation().requireNumberGreaterThanOrEqualTo(0);
    } else if (it.type === 'hour') {
      dv = SpreadsheetApp.newDataValidation().requireNumberBetween(0, 23);
    } else if (it.type === 'time') {
      dv = SpreadsheetApp.newDataValidation().requireFormulaSatisfied('=REGEXMATCH(TO_TEXT(' + a1 + '),"^([01]?[0-9]|2[0-3]):[0-5][0-9]$")');
    } else if (it.type === 'quarter') {
      dv = SpreadsheetApp.newDataValidation().requireFormulaSatisfied('=OR(' + a1 + '="",REGEXMATCH(TO_TEXT(' + a1 + '),"^(Mar|Jun|Sep|Dec) 20[0-9][0-9]$"))');
    } else if (it.key === 'AB_EMAIL_TO') {
      dv = SpreadsheetApp.newDataValidation().requireFormulaSatisfied('=REGEXMATCH(TO_TEXT(' + a1 + '),"@")');
    }
    if (dv) {
      const tip = { number: 'Enter a number (0 or more).', hour: 'Enter an hour from 0 to 23.',
                    time: 'Enter a 24-hour time like 18:45.', quarter: 'Leave blank, or e.g. Sep 2026.' }[it.type] || 'Enter an email address.';
      valCell.setDataValidation(dv.setAllowInvalid(false).setHelpText(tip + (it.help ? ' ' + it.help : '')).build());
    }
    sh.getRange(row, 3).setFontColor('#888888').setHorizontalAlignment('center');
    sh.getRange(row, 1).setFontWeight('bold').setFontColor('#222222');
    sh.getRange(row, 4).setFontColor('#555555');
    sh.getRange(row, 5).setFontColor(/^Re-run/.test(r.values[4]) ? '#b45309' : '#9aa0a6').setFontSize(9);
    sh.getRange(row, 6).setFontColor('#b0b0b0').setFontSize(8);
    sh.getRange(row, 1, 1, W).setBorder(null, null, true, null, null, null, '#ececec', SpreadsheetApp.BorderStyle.SOLID);
  });

  // Changed-from-default highlight on the Value column.
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=AND($F' + first + '<>"",TO_TEXT($B' + first + ')<>TO_TEXT($C' + first + '))')
    .setFontColor('#1558d6').setBackground('#e3edfd')
    .setRanges([sh.getRange(first, 2, n, 1)]).build());
  sh.setConditionalFormatRules(rules);

  sh.getRange(first, 1, n, W).setVerticalAlignment('middle').setWrap(true);
  sh.getRange(first, 6, n, 1).setWrap(false);
  sh.setColumnWidth(1, 340);
  sh.setColumnWidth(2, 190);
  sh.setColumnWidth(3, 120);
  sh.setColumnWidth(4, 430);
  sh.setColumnWidth(5, 280);
  sh.setColumnWidth(6, 210);
  sh.setFrozenRows(AB_CP_HEADER_ROW);
  sh.getRange(first, 6, n, 1).protect().setDescription('Control Panel keys').setWarningOnly(true);
  ss.setActiveSheet(sh);
  sh.setActiveSelection('B' + (first + 1));

  const itemCount = rows.filter(function (r) { return r.kind === 'item'; }).length - extras.length;
  const msg = 'Control Panel rebuilt - ' + itemCount + ' settings in ' + AB_CP_SECTIONS_.length +
    ' sections. Your existing values were kept' + (extras.length ? '; ' + extras.length + ' unrecognised setting(s) kept at the bottom.' : '.');
  Logger.log(msg);
  try { ss.toast(msg, 'Control Panel', 10); } catch (e) { /* no UI context */ }
}

const AB_EMAIL_TO = ab_setting_('AB_EMAIL_TO', 'bharathi200620@gmail.com, spm260193@gmail.com'); // <-- change here or in the Control Panel sheet; comma-separate for more than one address

// The watchlist tab inside this same spreadsheet (was a separate file before)
const AB_MAIN_SHEET = 'Main';

// "Pivot" tab - rebuilt from scratch by buildBasicIndustryMovementDashboard_()
// below. Whatever is on this tab gets wiped every rebuild, so it's not a
// place to keep anything by hand.
const AB_PIVOT_SHEET = 'Pivot';

// Mid-session and after-market times for the Pivot-only refresh
// triggers (see installPivotRefreshTriggers below) - edit the
// AB_PIVOT_AM_*/AB_PIVOT_PM_* rows in the Control Panel to change them.
const AB_PIVOT_AM_HOUR = ab_setting_('AB_PIVOT_AM_HOUR', 11);
const AB_PIVOT_AM_MIN = ab_setting_('AB_PIVOT_AM_MIN', 15);
const AB_PIVOT_PM_HOUR = ab_setting_('AB_PIVOT_PM_HOUR', 17);
const AB_PIVOT_PM_MIN = ab_setting_('AB_PIVOT_PM_MIN', 0);

// Daily Pipeline times (07-Oct-2026) - autoDailyUpdate kept hitting
// the 6-minute execution cap even after batching away the setValue()
// loops, so the daily run is split across three separate triggers,
// each with its own fresh 6-minute budget - see the THREE-PHASE DAILY
// TRIGGER section below for the full explanation. Edit the
// AB_DAILY_P1/P2/P3_HOUR/MIN rows in the Control Panel to change these,
// then re-run "Install Daily Pipeline Triggers" from the menu.
const AB_DAILY_P1_HOUR = ab_setting_('AB_DAILY_P1_HOUR', 18);
const AB_DAILY_P1_MIN = ab_setting_('AB_DAILY_P1_MIN', 45);
const AB_DAILY_P2_HOUR = ab_setting_('AB_DAILY_P2_HOUR', 18);
const AB_DAILY_P2_MIN = ab_setting_('AB_DAILY_P2_MIN', 53);
const AB_DAILY_P3_HOUR = ab_setting_('AB_DAILY_P3_HOUR', 19);
const AB_DAILY_P3_MIN = ab_setting_('AB_DAILY_P3_MIN', 1);
// Phase 4 (Quality Watch + IPO Base Watch) - split off Phase 3 on 13-Oct-2026 after Phase 3 hit the 6-minute cap.
const AB_DAILY_P4_HOUR = ab_setting_('AB_DAILY_P4_HOUR', 19);
const AB_DAILY_P4_MIN = ab_setting_('AB_DAILY_P4_MIN', 20);

// Post-Daily Housekeeping time (Index colours, Pivot rebuild, Risk
// Manager refresh) - deliberately AFTER the main 6:45 PM trigger, on
// its own separate execution. Edit the AB_HOUSEKEEPING_HOUR/MIN rows
// in the Control Panel to change it, then re-run "Install Post-Daily
// Housekeeping Trigger" from the menu.
const AB_HOUSEKEEPING_HOUR = ab_setting_('AB_HOUSEKEEPING_HOUR', 19);
const AB_HOUSEKEEPING_MIN = ab_setting_('AB_HOUSEKEEPING_MIN', 0);

// Legend tab for the SYMBOL-cell index colour-coding (which colour means
// which index) - rebuilt from scratch every run by ab_colorCodeSymbolsByIndex_().
const AB_INDEX_LEGEND_SHEET = 'Index Legend';

// "Indextracker" tab (NSE Symbol | Drop from ATH | Current Price | Day
// change | Price 1Y/5Y/10Y ago | All time high | 1Y/5Y/10Y returns |
// Chart) - a GOOGLEFINANCE-driven tab the user maintains by hand today.
// ab_addMissingIndices_() fills in any catalog index that isn't already
// listed in column A, by cloning row 2's own formulas/formatting down
// (so every formula's relative references auto-repoint at the new row)
// and then overwriting only column A with the new symbol.
const AB_INDEXTRACKER_SHEET = 'Indextracker';
const AB_INDEXTRACKER_TEMPLATE_ROW = 2;

// Candidate NSE index tickers, in the "NIFTY_XXX" form GOOGLEFINANCE's
// INDEXNSE: prefix expects (this differs from TradingView's older CNX-
// prefixed names, e.g. CNXENERGY vs NIFTY_ENERGY). Not every entry here
// is guaranteed to be a ticker GOOGLEFINANCE actually recognises -
// ab_addMissingIndices_() verifies each candidate's Current Price
// resolves to a real number before keeping it, and removes + reports by
// name any that don't, so a wrong guess here self-corrects instead of
// leaving a broken formula row in the sheet.
const AB_INDEX_CATALOG_ = [
  // Broad market
  'NIFTY_50', 'NIFTY_NEXT_50', 'NIFTY_100', 'NIFTY_200', 'NIFTY_500',
  'NIFTY_MIDCAP_50', 'NIFTY_MIDCAP_100', 'NIFTY_MIDCAP_150',
  'NIFTY_SMLCAP_50', 'NIFTY_SMLCAP_100', 'NIFTY_SMLCAP_250',
  // Sectoral
  'NIFTY_AUTO', 'NIFTY_BANK', 'NIFTY_CHEMICALS', 'NIFTY_CONSR_DURBL',
  'NIFTY_ENERGY', 'NIFTY_FIN_SERVICE', 'NIFTY_FMCG', 'NIFTY_HEALTHCARE',
  'NIFTY_IT', 'NIFTY_MEDIA', 'NIFTY_METAL', 'NIFTY_OIL_AND_GAS',
  'NIFTY_PHARMA', 'NIFTY_PSU_BANK', 'NIFTY_PVT_BANK', 'NIFTY_REALTY',
  'NIFTY_INFRA',
  // Thematic / strategy
  'NIFTY_COMMODITIES', 'NIFTY_CPSE', 'NIFTY_MNC', 'NIFTY_PSE',
  'NIFTY_SERV_SECTOR', 'NIFTY_CONSUMPTION',
  // User-requested additions (full niftyindices.com sectoral list, Oct
  // 2026) - several of these are newer/niche indices NSE launched in
  // 2023-2024, so the GOOGLEFINANCE ticker spelling below is a best
  // guess at the established NIFTY_XXX convention, not a confirmed
  // ticker for every entry. Unresolved guesses are pruned and reported
  // by ab_addMissingIndices_() exactly like any other candidate - this
  // list is deliberately over-inclusive rather than under-inclusive.
  'NIFTY_CAPITAL_GOODS', 'NIFTY_CEMENT', 'NIFTY_COMM_TRANS',
  'NIFTY_CONSTRUCTION', 'NIFTY_CONSR_SERVICES', 'NIFTY_FIN_SERV_25_50',
  'NIFTY_FIN_SERV_EXBANK', 'NIFTY_HOSPITALS', 'NIFTY_HOUSING_FIN',
  'NIFTY_INSURANCE', 'NIFTY_NBFC', 'NIFTY_POWER', 'NIFTY_REITS_REALTY',
  'NIFTY_RETAIL', 'NIFTY_TELECOM', 'NIFTY500_HEALTHCARE',
  'NIFTY_MIDSML_FINSERVICE', 'NIFTY_MIDSML_HEALTHCARE',
  'NIFTY_MIDSML_IT_TELECOM'
];

// IPOs tab: S.No | NSE SYMBOL | LISTING DATE | LISTING PRICE | MarketPrice |
// % change | % Down/up from Listing Price | Below or Above IPO price
// Column H there is already a computed "Below"/"Above" value - this just
// copies it into Main's IPO Level column, it doesn't recompute anything.
const AB_IPO_SHEET = 'IPOs';
const AB_IPO_SYMBOL_HEADER = 'NSE SYMBOL';
// Resolved by HEADER NAME, not a fixed column index - same rule as
// ab_getMainLayout_ uses for Main. This used to be a hardcoded index 7
// (column H), which was one past the tab's actual last column: the
// level really sits in G. Reading the missing column yielded undefined,
// and String(undefined) is the literal text "undefined", which is
// truthy - so "undefined" got written into Main's IPO Level for every
// IPO symbol instead of Above/Below.
const AB_IPO_LEVEL_HEADER = 'Below or Above IPO price';

// New-IPO auto-sync: pulls freshly-listed mainboard IPOs (Company, NSE
// Symbol, Listing Date, Issue Price) from Chittorgarh's public "IPO
// Listing Dates" report and appends any symbol not already in the IPOs
// tab. NSE's own site blocks/stalls Apps Script requests (see the OHLC
// section below), so this hits Chittorgarh's own JSON data API instead
// of scraping their page (their listing table is client-rendered, so
// IMPORTHTML/IMPORTXML can't see it either - confirmed by inspecting
// the page's network calls). SME IPOs are excluded by default since
// Main's watchlist is mainboard-focused; add 'sme' to the list below if
// you want those too.
/***** IPO BASE BREAKOUT WATCH *****/
// (Newer rule: Base 1 = listing-day high, then Base 2 ... - see "IPO BASES -
// the rule" below. The text here describes Base 1.)
// "IPO base" = the HIGH of the listing-day candle. A newly listed stock
// often drifts below that first-day high for weeks, then reclaims it -
// which is the level worth watching. XTRANET's base was 136.87; it
// spent two weeks under it, then broke through and ran to 176.
//
// The base never changes once set, so it's computed ONCE per symbol
// (first trading day at/after the listing date, via GOOGLEFINANCE) and
// cached in the IPOs tab. Each daily run then just compares today's
// price to that stored number - no refetching history.
//
// Add these three headers to the IPOs tab yourself; matched by name:
const AB_IPOBASE_BASE_HEADER = 'IPO Base';
const AB_IPOBASE_PCT_HEADER = '% to IPO Base';
const AB_IPOBASE_STATUS_HEADER = 'Base Status';
// OPTIONAL extra columns. Add them if you want to see the working;
// leave them out and the logic still runs, just without showing it.
//
// Some IPOs list, run well above the listing-day high, then fade back
// under it. Once that's happened the listing-day high is no longer the
// level that matters - the 52-week high it went on to make is. So when
// BOTH: 52W high > IPO base, AND price is currently below the IPO base,
// the active level becomes the 52W high. "Active Base" records which
// one is in force so the status is never ambiguous.
const AB_IPOBASE_52W_HEADER = '52W High';
const AB_IPOBASE_ACTIVE_HEADER = 'Active Base';
// How close below the base counts as "approaching" - this is the
// warning you actually want, before the breakout rather than after.
const AB_IPOBASE_NEAR_PCT = ab_setting_('AB_IPOBASE_NEAR_PCT', 5);
// A second case for the same reason: a stock can clear its IPO base by
// only a small margin while a much bigger high already exists on
// record (KNACK is the case in point - +10.77% above its listing-day
// high of 192, while its 52-week high sits at 222). That's not a
// confirmed breakout, it's still trading under its real ceiling. So if
// the gain over the IPO base is under this percent AND a higher 52W
// high exists, the 52W high becomes the active base instead - tagged
// distinctly from the KUSUMGAR-style reclaim case above.
const AB_IPOBASE_WEAK_BREAKOUT_PCT = ab_setting_('AB_IPOBASE_WEAK_BREAKOUT_PCT', 25);
// Rows to reserve per symbol when batch-fetching listing-day candles.
// The listing date can fall on a weekend/holiday in the sheet, so a
// few days are requested and the FIRST trading day is taken.
const AB_IPOBASE_ROWS_PER_BLOCK = 10;
const AB_IPOBASE_LOOKAHEAD_DAYS = ab_setting_('AB_IPOBASE_LOOKAHEAD_DAYS', 6);
// Ignore IPOs listed longer ago than this when alerting (0 = no limit).
// An IPO from 2023 sitting 200% above its base isn't a base trade.
const AB_IPOBASE_ALERT_MAX_AGE_DAYS = ab_setting_('AB_IPOBASE_ALERT_MAX_AGE_DAYS', 730);
const AB_IPOBASE_SWING_BARS = ab_setting_('AB_IPOBASE_SWING_BARS', 5);
const AB_IPOBASE_FIRST_PEAK_MIN_DAYS = ab_setting_('AB_IPOBASE_FIRST_PEAK_MIN_DAYS', 3);
const AB_IPOBASE_INTRADAY_ON = ab_setting_('AB_IPOBASE_INTRADAY_ON', 1);
const AB_IPOBASE_BASE2A_HEADER = 'IPO Base 2A';
const AB_IPOBASE_FVG_HEADER = 'FVG Under Base';
const AB_IPOBASE_FVG_MAX_PCT = ab_setting_('AB_IPOBASE_FVG_MAX_PCT', 15);
// Candle rule (see "IPO BASES - the rule" further down): extra IPOs-tab
// columns the script adds by itself, and how many bases it tracks.
const AB_IPOBASE_BASE2_HEADER = 'IPO Base 2';
const AB_IPOBASE_ACTIVE_NO_HEADER = 'Active Base No';
const AB_IPOBASE_MAX_BASES = ab_setting_('AB_IPOBASE_MAX_BASES', 2);
// A later base only counts if price really consolidated under it: after the
// rejection candle, at least this many daily closes stay at/below the level
// before any close above it. (CPPLUS had 7, Omnitech about 8.)
const AB_IPOBASE_MIN_CONSOL_DAYS = ab_setting_('AB_IPOBASE_MIN_CONSOL_DAYS', 5);
// ... and the rejection candle has to come within this many trading days AFTER
// the previous base was broken (CPPLUS 1, Omnitech 1-3, Shreeji about 4).
// A stock that keeps running straight up (Anlon) has no Base 2. It is counted
// from the break, not from listing - Shreeji broke Base 1 about 12 weeks
// after listing and its Base 2 is still a Base 2.
const AB_IPOBASE_REJECT_WITHIN_DAYS = ab_setting_('AB_IPOBASE_REJECT_WITHIN_DAYS', 10);
// A rejection candle must REACH the previous candle's high - or come within
// this percent of it - and still close below it. (Shreeji: the rejection
// candle's high stopped 0.25% short of the previous high, then it sold off.)
const AB_IPOBASE_TOUCH_TOL_PCT = ab_setting_('AB_IPOBASE_TOUCH_TOL_PCT', 0);
// Daily history is fetched this many symbols at a time, and the fetching
// stops after this long so the daily run can never run out of time.
const AB_IPOBASE_FETCH_CHUNK = 50;
const AB_IPOBASE_FETCH_BUDGET_MS = 150000;

const AB_IPO_CHITTORGARH_CATEGORIES = ['mainboard'];
const AB_IPO_CHITTORGARH_URL_TMPL =
  'https://webnodejs.chittorgarh.com/cloud/report/data-read/25/1/1/{YEAR}/{YEAR}-{FYY}/0/{CATEGORY}/0';

// The IPO sync runs weekly, NOT as part of the daily 6:45pm run - new
// listings only happen a few times a week, and the source is a
// third-party site. Sunday morning by default: the week's listings have
// all settled and had a full trading day of prices by then.
// To switch to Saturday, change to ScriptApp.WeekDay.SATURDAY, then
// re-run "Install Weekly IPO Trigger" from the menu to apply it.
const AB_IPO_SYNC_HOUR = ab_setting_('AB_IPO_SYNC_HOUR', 9); // 9-10 AM IST
const AB_IPO_SYNC_EMAIL = ab_setting_('AB_IPO_SYNC_EMAIL', true); // email a summary when new IPOs are found

// Matches the existing rows in the IPOs tab (19/04/2024, not 4/19/2024).
// Applied explicitly to every synced date cell - a newly written cell
// otherwise inherits the locale default (M/d/yyyy) instead of the
// format the rest of the column uses.
const AB_IPO_DATE_FORMAT = 'dd/MM/yyyy';

const AB_DAY_TABS = ['Day4', 'ThirdDay', 'Yesterday', 'Today']; // oldest -> newest
const AB_OHLC_HEADERS = ['TckrSymb', 'OpnPric', 'HghPric', 'LwPric', 'ClsPric', 'TtlTradgVol'];

// GOOGLEFINANCE returns volume as a raw share count. Divide by this to
// get the unit you want in Main's "Prev Day Vol" column:
//   1000000  -> millions   (2,850,000 shares shows as 2.85)   <- default
//   10000000 -> crores     (2,850,000 shares shows as 0.285)
//   100000   -> lakhs      (2,850,000 shares shows as 28.5)
//   1        -> raw shares (2,850,000 shows as 2850000)
const AB_VOL_DIVISOR = 1000000;
const AB_VOL_DECIMALS = 2;
// Renamed from the old generic 'Sheet2' - Blueprint may already have a
// tab by that name, and an ambiguous name here would silently target
// the wrong tab. Rename the copied tab to 'PatternData' during the merge.
const AB_PATTERN_SHEET = 'PatternData';
const AB_LOG_SHEET = 'AutoFetch Log';
const AB_COL_W = 23; // Pattern output column, matches Stocktracker layout

const AB_HISTORY_SHEET = 'History30';
const AB_HISTORY_LOOKBACK_DAYS = 45; // calendar days back - gives ~30 trading days after weekends/holidays
const AB_HISTORY_ROWS_PER_BLOCK = 40; // buffer per symbol in the scratch fetch

const AB_COL_LONGFVG = 24; // X - Long-only FVG "First Touch" / "First Touch Confirmed" output column

// 10 EMA support: flags a symbol whose price pulled back down to touch/
// near its own 10-day EMA and closed back above it - a bounce off the
// EMA acting as support, not just "price is above/below the EMA."
const AB_COL_EMA_SUPPORT = 25;   // Y - 10 EMA
const AB_COL_EMA21_SUPPORT = 27; // AA - 21 EMA
const AB_EMA_SUPPORT_LENGTH = 10;
const AB_EMA21_SUPPORT_LENGTH = 21;
const AB_EMA_SUPPORT_TOUCH_PCT = ab_setting_('AB_EMA_SUPPORT_TOUCH_PCT', 0.5); // how close the Low must get to the EMA to count as a "touch"

// 14-day ATR, smoothed with EMA (not the default Wilder/RMA smoothing
// most platforms use) - a rolling volatility reading per symbol.
const AB_COL_ATR = 26; // Z
const AB_ATR_LENGTH = 14;

/***** QUARTERLY RESULTS (QoQ / YoY growth) *****/
// Fills Main's QoQ[Revenue Growth%] / QoQ[NP Growth %] / YoY[Revenue
// Growth %] / YoY[NP Growth %] from screener.in's quarterly results
// table, replacing the manual read-off-Moneycontrol step.
//
// Source: https://www.screener.in/company/<SYMBOL>/consolidated/
// That page is server-rendered, so UrlFetchApp sees the real numbers
// (Moneycontrol builds its tables in JavaScript, so it can't be read
// this way). screener.in's robots.txt permits /company/<SYM>/ paths -
// only /company/source/quarter/* (the raw filing PDFs) is disallowed,
// and this never touches those.
//
// CONSOLIDATED vs STANDALONE: the /consolidated/ URL returns
// consolidated figures when the company reports them. Companies that
// only ever file standalone (many smallcaps) return standalone numbers
// at that same URL. The page states which it gave us, and that basis
// is recorded per symbol so a standalone figure is never silently
// passed off as consolidated - see the run log / AB_QR_BASIS_NOTE_COL.
const AB_QR_URL_TMPL = 'https://www.screener.in/company/{SYM}/consolidated/';
// Once screener starts refusing, it stays that way for a while. Without
// a cooldown every hourly pass - and every impatient manual run - walks
// straight back into the wall, which is what keeps the block alive.
// After a throttled run, bulk passes stand down for this long.
// Refreshing a NAMED symbol still works: that's one request, and it's
// usually the thing you actually need right now.
const AB_QR_COOLDOWN_PROP = 'AB_QR_COOLDOWN_UNTIL';
const AB_QR_COOLDOWN_MS = 2 * 60 * 60 * 1000;// "Address unavailable" doesn't fail fast - the request HANGS for ~30s
// before giving up, so retrying it 3x costs ~90s for a single symbol.
// Measured on a real run: 3 such symbols consumed 4.5 of 5.5 minutes
// while 280 successful ones took under a second each. So these get ONE
// attempt and are then skipped; their cells stay blank, which means the
// next run picks them up anyway. Far better to spend the remaining time
// on symbols that will actually answer.
const AB_QR_SKIP_RETRY_ON = /address unavailable|timed? ?out|timeout|dns error/i;
// Live progress. Logger lines stream into the editor's Execution log
// while the run is still going, and the toast shows progress in the
// sheet itself. Set false to quieten a scheduled run.
const AB_QR_VERBOSE = true;
const AB_QR_DECIMALS = 0;
/***** ALERT SYSTEM *****/
// Fires when the day's close crosses the alert levels you set by hand in
// Main's existing "Alert System" block (Price Fall / Breakout columns).
const AB_ALERT_LOG_SHEET = 'Alert Log';
const AB_ALERT_DASH_SHEET = 'Alert Dashboard';
// How a logged alert resolves, measured as "up is good" - these are
// long-side alerts (a Price Fall alert is a buy-the-dip signal, so a
// recovery upward is still the favourable outcome).
//
//   Win  - price reaches AB_ALERT_WIN_PCT% above the ALERT level.
//   Loss - price closes at or below the Stoploss set for that symbol
//          in Main. NOT a fixed percentage: the stop is where you
//          actually decided the idea was wrong, so that's the honest
//          bar. A symbol with no stoploss filled in therefore can only
//          ever read Win or Open, never Loss.
//   Open - anything in between, or still short of both.
//
// This matches the real-trade tracker (AB_TRADE_WIN_PCT / Stoploss), so
// both scoreboards now grade on the same rule.
const AB_ALERT_WIN_PCT = ab_setting_('AB_ALERT_WIN_PCT', 10);

/***** INTRADAY PRICE-LEVEL ALERTS (Fall / Breakout / Entry) *****/
// A separate, faster-cadence system layered on top of the above. Runs
// every 5 min and reads Main's live MKT Price column directly.
//
// What a row means is decided by WHICH cells you've filled in:
//
//   Alert level only (Price Fall and/or Breakout, no Entry+Stoploss)
//     -> a WATCH. Just tells you the level was hit. Never a trade,
//        never graded Win/Loss. Fires 24x7.
//
//   Alert level + Entry Price + Stoploss
//     -> a TRADE, entered off that level. Fires ONLY during market
//        hours, because a fill you can't actually take is noise. Note
//        this means the 6pm EOD safety-net pass will NOT fire these -
//        they depend on the 5-min intraday trigger being installed.
//
//   Entry Price + Stoploss only (no alert level)
//     -> a TRADE, live as soon as price is AT OR ABOVE your entry.
//        Fires 24x7. No tolerance band: if MKT Price is 200 and you
//        set an entry of 200 or anything below it, the trade is on -
//        you're either already in it, or you'd have been filled on the
//        way past. An entry set ABOVE the current price still waits,
//        so you can park a "buy it when it gets up to X" row here.
//
// Both trade types land in the Trade Log and get graded Win/Loss; a
// watch never does. See TRADE TRACKING below.

// NSE regular session, IST. Used only to gate alert-level trades.
const AB_MARKET_OPEN_MIN = 9 * 60 + 15;   // 09:15
const AB_MARKET_CLOSE_MIN = 15 * 60 + 30; // 15:30

/***** TRADE TRACKING (real trades only - Entry Price filled in) *****/
// Only counts as an actual trade once you fill in Entry Price for a
// symbol that has already triggered. Resolved once daily at EOD:
//   - Loss: price hits Stoploss
//   - Win: price is 10%+ above the ALERT price (not entry price)
// Resolved trades get one permanent row in "Trade Log"; open ones
// (entered but not yet resolved) stay silent until they resolve.
const AB_TRADE_LOG_SHEET = 'Trade Log';
const AB_TRADE_DASH_SHEET = 'Trade Dashboard';
const AB_TRADE_WIN_PCT = ab_setting_('AB_TRADE_WIN_PCT', 10); // % above ALERT price counts as a Win

/***** RISK MANAGEMENT *****/
// Dedicated dashboard: per-trade position-size calculator (how many
// shares to buy so a stop-out costs exactly your target % of capital),
// portfolio-wide open risk ("heat"), a daily-loss warn-only check, and
// drawdown/loss-streak tracking off the existing Trade Log. See the
// RISK MANAGER section below (near the end of the file) for the full
// implementation.
const AB_RISK_SHEET = 'Risk Manager';
const AB_RISK_CAPITAL = ab_setting_('AB_RISK_CAPITAL', 100000);
const AB_RISK_PCT_PER_TRADE = ab_setting_('AB_RISK_PCT_PER_TRADE', 1);
const AB_RISK_MAX_HEAT_PCT = ab_setting_('AB_RISK_MAX_HEAT_PCT', 6);
const AB_RISK_DAILY_LOSS_PCT = ab_setting_('AB_RISK_DAILY_LOSS_PCT', 3);

/***** MISSED OPPORTUNITIES *****/
// Every symbol that shows up in the EOD Summary's Mitigated FVG,
// Unmitigated/Gap-up FVG Approaching, or Spring Pattern sections gets
// logged (date + price at the time) to the "Signal Watchlist Log"
// sheet. The VERY NEXT EOD run checks that list against today's price
// - cross >= AB_MISSED_PCT% and it's reported as a missed opportunity
// (your LCL example) - then the log is replaced with today's fresh
// list, so each symbol is only ever checked once, against the next
// day's close, never piled up or re-checked for days after. See the
// MISSED OPPORTUNITIES section below (near sendEodSummaryEmail_) for
// the logging/checking functions themselves.
const AB_SIGNAL_WATCHLIST_SHEET = 'Signal Watchlist Log';
const AB_MISSED_PCT = ab_setting_('AB_MISSED_PCT', 4);

// Pushbullet push notifications.
// The access token is deliberately NOT stored in this file - it lives in
// Script Properties instead, so this script stays safe to copy/share and
// the token can be rotated without touching the code.
//   Apps Script editor > Project Settings (gear) > Script Properties
//   > Add script property:  PUSHBULLET_TOKEN = <your token>
const AB_PUSHBULLET_PROP = 'PUSHBULLET_TOKEN';
const AB_PUSHBULLET_URL = 'https://api.pushbullet.com/v2/pushes';

// Optional in-code fallback token, used ONLY if the Script Property
// above is missing. Deliberately left empty: the live token is stored
// in Project Settings > Script Properties > PUSHBULLET_TOKEN, which
// keeps it out of the code so this file stays safe to copy or share.
//
// Paste a token here only if you ever need the script to work without
// the Script Property being set - and remember it's readable by anyone
// who can open the project if you do.
const AB_PUSHBULLET_TOKEN = '';

/*****************************************************************
 * MENU
 *****************************************************************/
/**
 * Menu: deletes any installed trigger whose handler no longer exists in
 * this script (or belongs to a feature that was removed) - e.g. the old
 * single-shot autoDailyUpdate, the hourly Quarterly-only fill, the Daily
 * Learning email. Left in place, such a trigger would just fail on every
 * firing. Also run automatically by "Install Daily Pipeline Triggers".
 */
function ab_removeOrphanTriggers_() {
  const retired = ['autoDailyUpdate', 'hourlyQuarterlyFill_', 'sendDailyStockLesson', 'ab_pbTriggerRun_'];
  const g = (function () { return this; })();
  const removed = [];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const fn = t.getHandlerFunction();
    if (retired.indexOf(fn) !== -1 || typeof g[fn] !== 'function') {
      ScriptApp.deleteTrigger(t);
      removed.push(fn);
    }
  });
  return removed;
}

function runCleanUpOldTriggers() {
  const removed = ab_removeOrphanTriggers_();
  SpreadsheetApp.getActiveSpreadsheet().toast(removed.length
    ? 'Removed ' + removed.length + ' old trigger(s): ' + removed.join(', ') + '.'
    : 'No old triggers found - nothing to clean up.', 'Clean Up Old Triggers', 12);
}

function onOpen() {
  // getUi() only works when there's a live spreadsheet UI session behind
  // the call - i.e. the sheet is actually open in a browser tab. Running
  // this function manually from the Apps Script editor (rather than by
  // opening/reloading the sheet itself) doesn't have that, and throws
  // "Cannot call SpreadsheetApp.getUi() from this context." Wrapped in
  // try/catch so a manual run just silently does nothing instead of
  // showing a scary error - the menu still builds normally the moment
  // you open the sheet for real.
  try {
    const ui = SpreadsheetApp.getUi();
    const sub = function (title) { return ui.createMenu(title); };

    ui.createMenu('Auto Bhavcopy')
      // Everyday quick access
      .addItem('Open Screener (filter Main in one go)', 'showScreener')
      .addItem('Show All Rows (clear screener)', 'clearScreenerFilter')
      .addSeparator()

      .addSubMenu(sub('1. Daily Pipeline')
        .addItem('Run Now (fetch + patterns)', 'runFullUpdateNow')
        .addItem('Recompute Patterns Only (no fetch)', 'recomputeAllPatternsNow')
        .addSeparator()
        .addItem('Run Phase 1 Now (fetch)', 'runDailyPhase1Now')
        .addItem('Run Phase 2 Now (patterns)', 'runDailyPhase2Now')
        .addItem('Run Phase 3 Now (alerts/trades/email)', 'runDailyPhase3Now')
        .addItem('Run Phase 4 Now (Quality Watch + IPO base emails)', 'runDailyPhase4Now')
        .addSeparator()
        .addItem('Install Daily Pipeline Triggers (4-phase: fetch / patterns / alerts+email / quality+IPO base)', 'installDailyPhaseTriggers')
        .addItem('Remove Daily Pipeline Triggers', 'removeDailyPhaseTriggers'))

      .addSubMenu(sub('2. Results Season')
        .addItem('Check Quarterly + Trend Tags Now (results due / pending)', 'runResultsDayCheckNow')
        .addItem('Refresh Results Performance tab', 'runResultsPerformanceNow')
        .addItem('Re-send Results Update email (no fetch)', 'runResultsEmailResend')
        .addItem('Send Upcoming Results Email Now', 'runUpcomingResultsEmailNow')
        .addItem('Install Upcoming Results Email (6 AM, Mon-Fri)', 'installUpcomingResultsTrigger')
        .addItem('Remove Upcoming Results Email', 'removeUpcomingResultsTrigger')
        .addSeparator()
        .addItem('Install Daily Check (once a day, ~6 PM)', 'installResultsDayTriggers')
        .addItem('Remove Daily Check', 'removeResultsDayTriggers')
        .addSeparator()
        .addItem('Clear Checkboxes Now (new season)', 'runResultsSeasonResetNow')
        .addItem('Install Result Date Live Formula (from Results sheet)', 'runInstallResultDateFormulaNow'))

      .addSubMenu(sub('3. Quarterly Results & Trend Tags')
        .addItem('Pause ALL screener.in fetching (2 days)', 'runPauseScreener2Days')
        .addItem('Resume screener.in fetching', 'runResumeScreener')
        .addSeparator()
        .addItem('PC Bridge: setup info (address + secret code)', 'runBridgeSetupInfo')
        .addItem('PC Bridge: status', 'runBridgeStatus')
        .addItem('Website feed: setup info (read-only token)', 'runFeedSetupInfo')
        .addItem('Website feed: rebuild now', 'runSiteFeedRebuildNow')
        .addItem('Website feed: stop auto-refresh', 'runSiteFeedStopAutoRefresh')
        .addSeparator()
        .addItem('Selected row(s)', 'runQuarterlyTrendForSelection')
        .addItem('Paste symbol list...', 'runQuarterlyTrendForSymbolPrompt')
        .addItem('Fill never-attempted rows', 'runQuarterlyTrendMissing')
        .addItem('Backfill ALL (resumable)', 'runQuarterlyTrendBackfill')
        .addSeparator()
        .addItem('Show Parked Symbols', 'showParkedQuarterlyTrendSymbols')
        .addItem('Reset Backfill Cursor', 'resetQuarterlyTrendBackfillCursor'))

      .addSubMenu(sub('4. Emails & Notifications')
        .addItem('Send EOD Summary Now', 'sendEodSummaryNow')
        .addItem('Send Quality Watch Email Now', 'runQualityWatchNow')
        .addItem('Check Missed Opportunities Now (log + check)', 'runMissedOpportunitiesCheckNow')
        .addItem('Re-send EOD Summary for the Last Trading Day', 'runResendEodSummaryForLastDay')
        .addItem('Update FVG Backtest Now (next-day results)', 'runFvgBacktestNow')
        .addItem('Clean Wrong Spring Flags from Log (one-time fix)', 'runCleanStaleSpringFlags')
        .addSeparator()
        .addItem('Pause All Emails for 24 Hours', 'runPauseEmails24h')
        .addItem('Resume Emails Now', 'runResumeEmails')
        .addItem('Email Status (paused? allowance left)', 'runEmailStatus')
        .addSeparator()
        .addItem('Send Test Pushbullet Notification', 'testPushbullet'))

      .addSubMenu(sub('5. Price Alerts, Trades & Risk')
        .addItem('Check Price Alerts Now', 'runAlertsNow')
        .addItem('Reset Triggered Flags (re-arm alerts)', 'resetTriggeredFlags_')
        .addItem('Rebuild Alert Dashboard', 'buildAlertDashboard_')
        .addSeparator()
        .addItem('Resolve Trades Now (Win/Loss)', 'runTradeResolutionNow')
        .addItem('Rebuild Trade Dashboard', 'buildTradeDashboard_')
        .addItem('Setup / Rebuild Risk Manager', 'setupRiskManager')
        .addSeparator()
        .addItem('Install Intraday Alert Trigger (every 5 min)', 'installIntradayAlertTrigger')
        .addItem('Remove Intraday Alert Trigger', 'removeIntradayAlertTrigger'))

      .addSubMenu(sub('6. FVG Zones & Pattern Tags')
        .addSubMenu(sub('Unmitigated FVG')
          .addItem('Scan Unmitigated FVGs', 'runUnmitigatedScanNow')
          .addItem('Check Approaches Now', 'runUnmitigatedAlertsNow')
          .addItem('Check MITIGATED Now (market hours)', 'runUnmitigatedMitigatedAlertsNow')
          .addSeparator()
          .addItem('Re-arm Approach Alerts', 'resetUnmitigatedAlerts')
          .addItem('Re-arm Mitigated Alerts', 'resetUnmitigatedMitigatedAlerts'))
        .addSubMenu(sub('Gap-up FVG')
          .addItem('Scan Gap-up FVGs', 'runGapUpScanNow')
          .addItem('Check Approaches Now', 'runGapUpAlertsNow')
          .addItem('Check MITIGATED Now (market hours)', 'runGapUpMitigatedAlertsNow')
          .addSeparator()
          .addItem('Re-arm Approach Alerts', 'resetGapUpAlerts')
          .addItem('Re-arm Mitigated Alerts', 'resetGapUpMitigatedAlerts'))
        .addSeparator()
        .addItem('Why is this stock missing? (check one symbol)', 'runExplainFvgSymbol')
        .addItem('Fetch Last 30 Days OHLC (History30 tab)', 'fetchHistory30_')
        .addItem('Recompute Long FVG Touch Tags (col X)', 'computeLongFVGTouchPatterns_')
        .addItem('Recompute EMA Support Tags (10 EMA col Y, 21 EMA col AA)', 'computeEmaSupportPatterns_')
        .addItem('Recompute 14-Day ATR / EMA (col Z)', 'computeAtrPatterns_'))

      .addSubMenu(sub('7. Dashboards')
        .addItem('Rebuild Pattern Dashboard', 'runPatternDashboardNow')
        .addSeparator()
        .addItem('Refresh Smart Dashboard', 'runSmartDashboard')
        .addItem('Clear Smart Dashboard Filters', 'clearSmartDashboardFilters')
        .addItem('Setup Smart Dashboard', 'setupSmartDashboard')
        .addSeparator()
        .addItem('Rebuild Basic Industry Movement (Pivot)', 'rebuildBasicIndustryMovement')
        .addItem('Install Pivot Refresh Triggers (~11:15 AM + ~5 PM IST)', 'installPivotRefreshTriggers')
        .addItem('Remove Pivot Refresh Triggers', 'removePivotRefreshTriggers')
        .addSeparator()
        .addItem('Run Post-Daily Housekeeping Now (Index colours + Pivot + Risk Manager)', 'runPostDailyHousekeepingNow')
        .addItem('Install Post-Daily Housekeeping Trigger (~7 PM IST)', 'installPostDailyHousekeepingTrigger')
        .addItem('Remove Post-Daily Housekeeping Trigger', 'removePostDailyHousekeepingTrigger'))

      .addSubMenu(sub('8. Symbols, Indices & Main Upkeep')
        .addItem('Sync Symbols from Stock Blueprint', 'syncSymbolsFromBlueprint_')
        .addItem('Style Main Sheet (fintech look)', 'runStyleMainSheet')
        .addItem('Fix Buy/Avoid Signals (negative EPS growth = Avoid)', 'runFixSignalFormulas')
        .addItem('Fill Details for NEW Symbols (paste symbol, run this)', 'runFillNewSymbols')
        .addItem('Fill Missing Chart/Screener Links', 'runFillChartScreenerLinks')
        .addItem('Fill Prev Day Volume', 'runPrevDayVolumeNow')
        .addItem('Apply Updated Industry PE to Main (from BasicIndustry PE tab)', 'runApplyUpdatedIndustryPeNow')
        .addSeparator()
        .addItem('Fill Sector/Industry from Basic Industry', 'runFillSectorIndustryFromBasicIndustry')
        .addItem('Audit Industry Classification vs NSE list', 'auditIndustryClassification')
        .addItem('Fix Classification from Audit (68 inconsistent)', 'runFixClassificationFromAudit')
        .addSeparator()
        .addItem('Color-Code Symbols by Index', 'runIndexColorCodeNow')
        .addItem('Add Missing Indices to Index Tracker', 'runAddMissingIndicesNow')
        .addItem('Fix Index Tracker Chart Links Only', 'runFixIndexChartLinksNow'))

      .addSubMenu(sub('9. IPOs')
        .addItem('Sync New IPOs (Chittorgarh)', 'runIpoSyncNow')
        .addItem('Add SME Stocks to IPOs (listed since 2025)', 'runAddSmeToIposNow')
        .addItem('Open SME List Tab (paste NSE file)', 'runOpenSmeListTab')
        .addItem('Open "New IPOs" Tab (paste NSE list here)', 'runOpenNewIposTab')
        .addItem('Add New IPOs (IPOs tab + Main)', 'runAddNewIpos')
        .addItem('Style IPOs Tab (fintech look)', 'runStyleIposTab')
        .addItem('Fill IPO Level (Above/Below)', 'fillIpoLevel_')
        .addItem('IPO Base Watch (compute + alert now)', 'runIpoBaseWatchNow')
        .addItem('Refresh IPO Base Columns (no email)', 'runRefreshIpoBases')
        .addItem('IPO Base Live Check (send test now)', 'runIpoBaseIntradayNow')
        .addItem('Explain IPO Bases for a Symbol', 'runIpoBaseExplain')
        .addItem('Why are IPO Bases blank?', 'runIpoBaseDiagnosis')
        .addItem('Fix IPO Listing Date Formats', 'fixIpoListingDateFormats_')
        .addItem('Check IPO Listing Dates (find swapped day/month)', 'runCheckIpoListingDates')
        .addSeparator()
        .addItem('Install Weekly IPO Trigger (Sun ~9 AM)', 'installWeeklyIpoTrigger')
        .addItem('Remove Weekly IPO Trigger', 'removeWeeklyIpoTrigger'))

      .addSubMenu(sub('10. NSE Price Bands')
        .addItem('Open Paste Tab', 'runOpenPriceBandPasteTab')
        .addItem('Import Pasted Rows (and send email)', 'runImportPastedPriceBands'))

      .addSeparator()
      .addSubMenu(sub('Settings & Maintenance')
        .addItem('Rebuild Control Panel (keeps your values)', 'setupControlPanel_')
        .addSeparator()
        .addItem('Clean Up Old Triggers (removed features)', 'runCleanUpOldTriggers'))
      .addToUi();
  } catch (e) {
    Logger.log('onOpen: no UI context available (' + e.message + ') - open the sheet directly to see the menu.');
  }
}

/**
 * Simple trigger - Apps Script runs this automatically on any edit to
 * the spreadsheet, no manual "install" step needed. If you manually
 * delete (or add/edit) a row in Alert Log or Trade Log, the matching
 * dashboard rebuilds itself right away instead of showing stale
 * entries until the next scheduled run.
 *
 * Both dashboards also get fully rebuilt from their log every daily
 * run and every manual "Rebuild ... Dashboard" click regardless, so
 * even in the rare case this doesn't fire (e.g. a bulk paste that
 * Sheets doesn't report as a normal edit), it self-heals on the next
 * run - this is a nice-to-have for instant feedback, not the only
 * thing keeping the dashboards correct.
 */
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    const sheetName = e.range.getSheet().getName();
    if (sheetName === AB_ALERT_LOG_SHEET) {
      buildAlertDashboard_();
    } else if (sheetName === AB_TRADE_LOG_SHEET) {
      buildTradeDashboard_();
    } else if (ab_sameSheetName_(sheetName, AB_SMART_SHEET)) {
      // Only the filter panel (columns A-D) re-screens - edits to the
      // results table never do, so the rebuild's own writes can't loop.
      ab_smartOnEdit_(e);
    } else if (ab_sameSheetName_(sheetName, AB_RISK_SHEET)) {
      // Only the calculator's two input cells (Entry Price, Stoploss)
      // trigger a refresh, and only that small output row gets
      // rewritten - not the whole dashboard - so typing in the
      // calculator stays instant even on a slow connection.
      if (e.range.getRow() === AB_RISK_CALC_ROW &&
          e.range.getColumn() >= AB_RISK_CALC_ENTRY_COL &&
          e.range.getColumn() <= AB_RISK_CALC_STOP_COL) {
        ab_riskCalcRefresh_();
      }
    }
  } catch (err) {
    Logger.log('onEdit dashboard refresh failed: ' + err.message);
  }
}

/*****************************************************************
 * ORCHESTRATOR - this is what the daily trigger calls
 *****************************************************************/

/**
 * Menu "Run Now (fetch + patterns)". Same pass as the daily trigger
 * PLUS the full pattern engine - run this once today's OHLC has landed
 * and the pattern columns will reflect today's candle.
 */
function runFullUpdateNow() {
  return ab_runUpdate_(true);
}

/**
 * Recomputes the four signal columns - Pattern, Long FVG Touch, 10 EMA
 * and 21 EMA - from the OHLC already in the sheet. No fetching, so it
 * takes seconds rather than minutes.
 *
 * This is the usual evening click: the daily run has already pulled
 * today's OHLC and History30, so the numbers are there and only the
 * tags need recalculating. Use "Run Now (fetch + patterns)" instead if
 * you think the underlying data itself is stale.
 *
 * ATR isn't here - it already refreshes on the daily run, and has its
 * own menu item if you ever want it on its own.
 */
function recomputeAllPatternsNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Recomputing signal columns from the OHLC already in the sheet...');
  updateAllCandlestickPatterns();
  computeLongFVGTouchPatterns_();
  computeEmaSupportPatterns_(); // writes both 10 EMA and 21 EMA
  logRun_(Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm'), '', 0,
          'OK (patterns only)', 'Pattern/FVG/10-21 EMA recomputed from existing OHLC - no fetch.');
  ss.toast('Pattern, FVG, 10 EMA and 21 EMA recomputed.');
}

function ab_runUpdate_(includePatterns) {
  const ts = Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm');
  try {
    syncSymbolsFromBlueprint_();

    // NOTE: the Chittorgarh new-IPO sync deliberately does NOT run here.
    // New listings only appear a handful of times a week, so hitting a
    // third-party site every single evening is wasted work. It runs on
    // its own weekly trigger instead - see weeklyIpoUpdate below.
    // fillIpoLevel_ still runs daily: it only reads the IPOs tab you
    // already have and refreshes Main's Above/Below column against
    // today's prices.
    fillIpoLevel_();

    // Raw data always refreshes: the 4-day OHLC window and History30.
    // These are just numbers - having them current costs nothing and
    // means a manual pattern run later has today's candle to work with.
    const result = refreshAllOHLC_();
    fetchHistory30_();

    // Prev Day Vol comes straight out of the day tabs just written, so
    // it can never disagree with the prices sitting next to it.
    // Soft-fails - a volume problem shouldn't stop the alert pass.
    try {
      fillPrevDayVolume_();
    } catch (vErr) {
      Logger.log('Prev Day Vol fill failed: ' + vErr.message);
    }

    // NOTE: Index colour-coding, the Pivot rebuild, and the Risk
    // Manager refresh used to run right here. They were pulled out
    // (06-Oct-2026) after this run hit Apps Script's hard 6-minute
    // execution cap and got killed outright ("Exceeded maximum
    // execution time") - a timeout can't be caught by try/catch, so
    // none of the usual soft-fail logging even ran. Those three are
    // now ab_postDailyHousekeeping_(), on its own trigger a little
    // after this one, so a slow evening here can never risk the
    // OHLC/alerts/trades pipeline below. See that function for why
    // each one is safe to run from a separate execution instead.

    // Refresh the open gap-up list against the OHLC just written, so the
    // 5-minute alert pass is watching current levels. Retires any gap
    // that got filled today and picks up any that formed. Each rebuild
    // also surfaces zones genuinely mitigated by today's real Low that
    // the delayed live quote never caught - see ab_sendEodMitigatedAlerts_.
    try {
      ab_sendEodMitigatedAlerts_(computeGapUpFvgs_().eodMitigated);
    } catch (gErr) {
      Logger.log('Gap-up scan failed: ' + gErr.message);
    }
    try {
      ab_sendEodMitigatedAlerts_(computeUnmitigatedFvgs_().eodMitigated);
    } catch (uErr) {
      Logger.log('Unmitigated FVG scan failed: ' + uErr.message);
    }

    // EOD sweep over both zone types, against today's settled prices.
    // Anything the 5-minute pass already reported stays quiet (the
    // Alerted flag), so this only surfaces what it missed - including
    // zones that only came into existence in the scan just above.
    try {
      ab_sendZoneAlerts_(checkGapUpAlerts_());
      ab_sendZoneAlerts_(checkUnmitigatedAlerts_());
    } catch (zErr) {
      Logger.log('EOD zone alert sweep failed: ' + zErr.message);
    }

    // ATR (col Z) stays on the daily run. It's a 14-day volatility
    // average, so one unsettled session barely moves it - unlike the
    // signal columns below, where a stale candle changes the answer
    // outright ("10 EMA Support (Today)" when it wasn't today).
    computeAtrPatterns_();

    // Signal columns - Pattern (W), Long FVG Touch (X), 10 EMA (Y) and
    // 21 EMA (AA) - ONLY on an explicit run. See autoDailyUpdate.
    if (includePatterns) {
      updateAllCandlestickPatterns();
      computeLongFVGTouchPatterns_();
      computeEmaSupportPatterns_(); // writes both 10 EMA and 21 EMA
    }

    // NOTE: quarterly results are deliberately NOT fetched here. They're
    // handled on demand ("Refresh Quarterly for SELECTED row(s)") and by
    // the hourly blank-fill trigger, so the daily run stays purely about
    // prices, patterns and alerts - and never depends on screener.in
    // being reachable at 6:45pm.

    // Alert pass - runs last so it sees today's fresh prices AND the
    // patterns/FVG tags computed above, and can record them alongside
    // each firing.
    // EOD safety-net pass - catches anything the intraday trigger missed
    // (e.g. if it wasn't installed, or a level was set after the market
    // closed) using the day's close instead of a live price.
    const fired = checkPriceAlerts_();
    updateAlertOutcomes_();
    buildAlertDashboard_();
    if (fired.length) {
      sendAlertEmail_(fired);
      sendAlertPush_(fired);
    }

    // Real trades: resolve Win/Loss for anything with Entry Price set,
    // log resolutions, rebuild the trade performance dashboard.
    const resolvedTrades = resolveTradesEOD_();
    buildTradeDashboard_();

    // The day's catch-up mail - what fired, what's open, what closed.
    // Soft-fails: a mail problem must not take down the rest of the run.
    try {
      sendEodSummaryEmail_(resolvedTrades);
    } catch (sErr) {
      Logger.log('EOD summary failed: ' + sErr.message);
    }

    // Separate Quality Watch screen (fundamentals improving + Buy +
    // verifiable EPS) - deliberately its own email, sent right after
    // the EOD summary. Soft-fails for the same reason as above.
    try {
      sendQualityWatchEmail_();
    } catch (qErr) {
      Logger.log('Quality Watch email failed: ' + qErr.message);
    }

    // IPO base watch - which recent listings are closing in on their
    // listing-day high, and which broke it today. Soft-fails so a
    // problem here can't take down the price/alert run.
    let ipoBaseNote = '';
    try {
      const newBases = computeIpoBases_();
      const baseAlerts = updateIpoBaseStatus_();
      sendIpoBaseEmail_(baseAlerts);
      ipoBaseNote = ' IPO base: ' + baseAlerts.approaching.length + ' approaching, ' +
                    baseAlerts.brokeOut.length + ' broke out' +
                    (newBases ? (', ' + newBases + ' new base(s)') : '') + '.';
    } catch (baseErr) {
      ipoBaseNote = ' IPO base watch failed: ' + baseErr.message;
      Logger.log(ipoBaseNote);
    }

    logRun_(ts, result.asOfDate, result.symbolCount,
            includePatterns ? 'OK (data + patterns)' : 'OK (data only)',
            (result.failed.length ? ('No data for: ' + result.failed.join(', ') + '. ') : '') +
            fired.length + ' alert(s) fired, ' + resolvedTrades.length + ' trade(s) resolved.' +
            ipoBaseNote +
            (includePatterns
              ? ' Pattern/FVG/10-21 EMA recomputed.'
              : ' ATR updated; Pattern/FVG/10-21 EMA left as-is - use "Run Now (fetch + patterns)".'));
  } catch (e) {
    logRun_(ts, '', 0, 'ERROR', e.message);
    try {
      ab_sendMail_({
        to: AB_EMAIL_TO,
        subject: 'Auto Bhavcopy FAILED - ' + ts,
        body: 'The daily OHLC fetch/pattern run failed:\n\n' + e.message +
              '\n\nCheck the "AutoFetch Log" tab for details.'
      });
    } catch (mailErr) {
      Logger.log('Also failed to send failure email: ' + mailErr.message);
    }
    throw e;
  }
}

/*****************************************************************
 * THREE-PHASE DAILY TRIGGER (07-Oct-2026)
 * -----------------------------------------------------------------
 * ab_runUpdate_ above (what autoDailyUpdate calls) kept hitting Apps
 * Script's hard 6-minute execution cap - even after batching away the
 * setValue()-per-row loops in syncSymbolsFromBlueprint_ and
 * computeAtrPatterns_, one execution doing the full OHLC fetch for
 * ~1,793 symbols AND the pattern engine AND every alert/trade/email
 * step just doesn't leave enough margin, and a timeout is an
 * uncatchable hard kill - no try/catch runs, nothing soft-fails, the
 * whole evening is lost.
 *
 * Same fix as Post-Daily Housekeeping above, applied to the main run
 * itself: split the SAME work across three separate triggers so each
 * stage gets its own fresh 6-minute budget. A slow Phase 1 can never
 * threaten Phase 2 or Phase 3 - they're independent executions, not
 * nested calls.
 *
 *   Phase 1 (~6:45 PM, ab_dailyPhase1Fetch_) - FETCH: symbol sync, IPO
 *     level, OHLC fetch (4-day tabs + History30), Prev Day Vol, rebuild
 *     the Gap-up/Unmitigated FVG watch lists. The expensive half.
 *   Phase 2 (~6:53 PM, ab_dailyPhase2Patterns_) - PATTERNS: recomputes
 *     Pattern/Long FVG Touch/10-21 EMA from the OHLC Phase 1 already
 *     wrote - no fetching, so this is fast (same logic
 *     recomputeAllPatternsNow already uses). autoDailyUpdate used to
 *     skip this entirely and leave it to a manual "Run Now (fetch +
 *     patterns)" click - this now gives you patterns every evening
 *     automatically instead.
 *   Phase 3 (~7:01 PM, ab_dailyPhase3AlertsEmail_) - ALERTS/TRADES/
 *     EMAIL: the EOD "approaching" zone sweep, ATR, price alerts, trade
 *     resolution, the Alert/Trade dashboards, the EOD Summary email,
 *     and the IPO base watch.
 *
 * Each phase is a fresh execution, so none of them can see a plain JS
 * variable another phase set - anything Phase 3's final log line needs
 * from Phase 1 (symbolCount/asOfDate/failed symbols) is handed off
 * through PropertiesService, stamped with today's date so a stale
 * leftover from a failed or skipped run is never picked up by mistake.
 *
 * Each phase fires on its own schedule regardless of whether an
 * earlier phase succeeded - exactly like Post-Daily Housekeeping
 * already behaves relative to autoDailyUpdate. If Phase 1 fails,
 * Phase 2/3 simply work from yesterday's OHLC instead of stopping -
 * you'll still get Phase 1's own failure email, so it's never silent.
 *
 * Install with "Install Daily Pipeline Triggers" from the menu - this
 * also removes the old single-shot autoDailyUpdate trigger first (if
 * it's still installed) so OHLC never gets fetched twice in one
 * evening. The old installDailyTrigger/autoDailyUpdate path is kept in
 * the code only as a manual fallback, not meant to run alongside this.
 *****************************************************************/

const AB_DAILY_HANDOFF_PROP_ = 'AB_DAILY_PHASE1_RESULT';

/** Saves what Phase 3's final log line needs from Phase 1, stamped with today's date. */
function ab_saveDailyPhase1Result_(result) {
  try {
    PropertiesService.getScriptProperties().setProperty(AB_DAILY_HANDOFF_PROP_, JSON.stringify({
      date: Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy'),
      asOfDate: result.asOfDate, symbolCount: result.symbolCount, failed: result.failed
    }));
  } catch (e) {
    Logger.log('Could not save Phase 1 handoff: ' + e.message);
  }
}

/** Reads it back - null if missing or not from today (Phase 1 didn't run, or ran a different day). */
function ab_readDailyPhase1Result_() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(AB_DAILY_HANDOFF_PROP_);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    const todayStr = Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy');
    return (obj.date === todayStr) ? obj : null;
  } catch (e) {
    return null;
  }
}

/** Shared failure email for any of the three phases - same shape as ab_runUpdate_'s own. */
function ab_sendDailyPhaseFailureEmail_(phaseName, ts, e) {
  try {
    ab_sendMail_({
      to: AB_EMAIL_TO,
      subject: 'Auto Bhavcopy FAILED - ' + phaseName + ' - ' + ts,
      body: 'The daily ' + phaseName + ' run failed:\n\n' + e.message +
            '\n\nCheck the "AutoFetch Log" tab for details.'
    });
  } catch (mailErr) {
    Logger.log('Also failed to send failure email (' + phaseName + '): ' + mailErr.message);
  }
}

/**
 * The Gap-up / Unmitigated FVG watch-list scans (+ their "mitigated today" mails).
 * They must run once per day AFTER the fresh fetch and BEFORE the EOD summary.
 * Phase 1 runs them when it still has time; otherwise Phase 2 (and as a last
 * resort Phase 3) picks them up - so a slow Google Finance evening can never
 * make them vanish. Returns true when it ran them just now.
 */
const AB_FVG_SCANS_PROP_ = 'AB_FVG_SCANS_DONE';
const AB_DATA_FETCHED_PROP_ = 'AB_DATA_FETCHED';
function ab_todayStr_() { return Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy'); }
function ab_propGet_(k) { try { return PropertiesService.getScriptProperties().getProperty(k) || ''; } catch (e) { return ''; } }
function ab_propSet_(k, v) { try { PropertiesService.getScriptProperties().setProperty(k, v); } catch (e) { /* best effort */ } }

function ab_runFvgScansIfPending_(label) {
  const today = ab_todayStr_();
  if (ab_propGet_(AB_DATA_FETCHED_PROP_) !== today) return false; // no fresh fetch today - nothing new to scan
  if (ab_propGet_(AB_FVG_SCANS_PROP_) === today) return false;    // already done today
  const t = Date.now();
  try {
    ab_sendEodMitigatedAlerts_(computeGapUpFvgs_().eodMitigated);
  } catch (gErr) {
    Logger.log('Gap-up scan failed: ' + gErr.message);
  }
  try {
    ab_sendEodMitigatedAlerts_(computeUnmitigatedFvgs_().eodMitigated);
  } catch (uErr) {
    Logger.log('Unmitigated FVG scan failed: ' + uErr.message);
  }
  ab_propSet_(AB_FVG_SCANS_PROP_, today);
  Logger.log(label + ' - Gap-up/Unmitigated FVG scans done in ' + Math.round((Date.now() - t) / 1000) + 's.');
  return true;
}

const AB_TRADING_DAY_PROP_ = 'AB_TRADING_DAY_CHECK';

/**
 * Was the NSE open today? Reads the live "last trade time" of 5 large stocks
 * (GOOGLEFINANCE "tradetime"): on a trading day it is today, on a weekend or an
 * exchange holiday it is still the previous session. The verdict is remembered
 * for the day, so only the first timer run of the day pays for it.
 *
 * Fails OPEN: before 10:00 IST (GOOGLEFINANCE lags ~20 min behind the 9:15 open), or if fewer than 3 of the 5 stocks answer, it
 * returns true ("assume trading") so a data hiccup can never silently
 * suppress a real trading day's emails.
 */
function ab_isTradingDayToday_() {
  const todayKey = Utilities.formatDate(new Date(), AB_TZ, 'yyyyMMdd');
  const cached = ab_propGet_(AB_TRADING_DAY_PROP_);
  if (cached.indexOf(todayKey + ':') === 0) return cached.charAt(9) === 'Y';
  if (Number(Utilities.formatDate(new Date(), AB_TZ, 'HHmm')) < 1000) return true; // too early: GOOGLEFINANCE lags ~20 min after the 9:15 open
  const syms = ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK'];
  const COL = 10; // column J - clear of the OHLC blocks (columns A-F)
  let verdict = '', lastKey = '';
  try {
    const sh = ab_getScratchSheet_();
    if (sh.getMaxColumns() < COL) sh.insertColumnsAfter(sh.getMaxColumns(), COL - sh.getMaxColumns());
    if (sh.getMaxRows() < syms.length) sh.insertRowsAfter(sh.getMaxRows(), syms.length - sh.getMaxRows());
    const rng = sh.getRange(1, COL, syms.length, 1);
    rng.setFormulas(syms.map(function (x) { return ['=IFERROR(GOOGLEFINANCE("NSE:' + x + '","tradetime"),"")']; }));
    let keys = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      SpreadsheetApp.flush();
      keys = rng.getValues().map(function (r) { return r[0]; })
        .filter(function (v) { return v instanceof Date && !isNaN(v.getTime()); })
        .map(function (d) { return Utilities.formatDate(d, AB_TZ, 'yyyyMMdd'); });
      if (keys.length >= 3) break;
      Utilities.sleep(2500);
    }
    rng.clearContent();
    if (keys.length >= 3) {
      keys.sort();
      lastKey = keys[keys.length - 1];
      verdict = lastKey === todayKey ? 'Y' : 'N';
    }
  } catch (e) {
    Logger.log('Trading-day check failed (assuming trading): ' + e.message);
  }
  if (!verdict) return true; // could not tell - run as normal, try again next time
  ab_propSet_(AB_TRADING_DAY_PROP_, todayKey + ':' + verdict + ':' + lastKey);
  return verdict === 'Y';
}

/**
 * True when a TIMER-fired run should be skipped because the market is closed:
 * Saturday / Sunday (IST), or a weekday exchange holiday (no trade today).
 * Runs started from the menu pass no event object, so they always go ahead.
 * Switch off with Control Panel "Skip ... Saturday / Sunday" = 0 and
 * "Also skip ... weekday exchange holidays" = 0.
 */
function ab_skipWeekendTrigger_(e, label) {
  if (!e || !e.triggerUid) return false;                       // menu / manual run
  if (!ab_setting_('AB_SKIP_WEEKEND_RUNS', 1)) return false;   // switched off
  if (Number(Utilities.formatDate(new Date(), AB_TZ, 'u')) >= 6) {
    Logger.log(label + ' skipped - Saturday/Sunday, market closed.');
    return true;
  }
  if (ab_setting_('AB_SKIP_HOLIDAY_RUNS', 1) && !ab_isTradingDayToday_()) {
    const c = ab_propGet_(AB_TRADING_DAY_PROP_); // yyyyMMdd:N:lastTradeKey
    const last = c.split(':')[2] || '';
    Logger.log(label + ' skipped - exchange holiday (last trade ' + last + ').');
    try {
      logRun_(Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm'), '', 0, 'SKIPPED (market holiday)',
              label + ' not run - no trading today (last trade seen: ' +
              (last ? last.slice(6) + '-' + last.slice(4, 6) + '-' + last.slice(0, 4) : 'n/a') + ').');
    } catch (lErr) { /* log tab unreachable - nothing more to do */ }
    return true;
  }
  return false;
}

/** Phase 1 (~6:45 PM): symbol sync, IPO level, ONE OHLC + History30 fetch, Prev Day Vol, then the FVG watch-list scans if time allows. */
function ab_dailyPhase1Fetch_(e) {
  if (ab_skipWeekendTrigger_(e, 'Phase 1 (fetch)')) return;
  ab_ensureResultDateReal_();
  const ts = Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm');
  const t0 = Date.now();
  const lap = function (label) { Logger.log('Phase 1 - ' + label + ' done at +' + Math.round((Date.now() - t0) / 1000) + 's'); };
  try {
    syncSymbolsFromBlueprint_();
    fillIpoLevel_();
    lap('symbol sync + IPO level');

    const result = ab_refreshOhlcAndHistory_();
    ab_propSet_(AB_DATA_FETCHED_PROP_, ab_todayStr_());
    ab_propSet_(AB_FVG_SCANS_PROP_, ''); // fresh data -> scans must run again
    lap('OHLC + History30 (one fetch)');

    try {
      fillPrevDayVolume_();
    } catch (vErr) {
      Logger.log('Prev Day Vol fill failed: ' + vErr.message);
    }
    lap('Prev Day Vol');

    // Only start the FVG scans if there is clearly time left (they have their own
    // fallback in Phase 2 / Phase 3), so Phase 1 can always finish and log itself.
    let scanNote = '';
    if (Date.now() - t0 < 170000) {
      ab_runFvgScansIfPending_('Phase 1');
      lap('FVG watch-list scans');
    } else {
      scanNote = ' FVG watch-list scans moved to Phase 2 (Phase 1 used ' + Math.round((Date.now() - t0) / 1000) + 's).';
    }

    ab_saveDailyPhase1Result_(result);
    logRun_(ts, result.asOfDate, result.symbolCount, 'OK (phase 1 - fetch)',
            (result.failed.length ? ('No data for: ' + result.failed.join(', ') + '. ') : '') +
            'OHLC, History30, Prev Day Vol refreshed in ' + Math.round((Date.now() - t0) / 1000) + 's.' + scanNote);
  } catch (e) {
    logRun_(ts, '', 0, 'ERROR (phase 1 - fetch)', e.message);
    ab_sendDailyPhaseFailureEmail_('Phase 1 (fetch)', ts, e);
    throw e;
  }
}

/** Phase 2 (~6:53 PM): patterns only, from the OHLC Phase 1 already wrote - no fetching. */
function ab_dailyPhase2Patterns_(e) {
  if (ab_skipWeekendTrigger_(e, 'Phase 2 (patterns)')) return;
  const ts = Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm');
  try {
    updateAllCandlestickPatterns();
    computeLongFVGTouchPatterns_();
    computeEmaSupportPatterns_(); // writes both 10 EMA and 21 EMA
    // Patterns are fresh now - rebuild the Pattern Dashboard off them.
    // Soft-fails: a dashboard problem must never fail the pattern run.
    try {
      SpreadsheetApp.flush();
      ab_buildPatternDashboard_();
    } catch (pdErr) {
      Logger.log('Pattern Dashboard rebuild failed: ' + pdErr.message);
    }
    // Any FVG watch-list scan Phase 1 had no time for runs here (no-op when already done).
    let scanNote = '';
    try {
      if (ab_runFvgScansIfPending_('Phase 2')) scanNote = ' FVG watch-list scans ran here (Phase 1 had no time).';
    } catch (fErr) {
      Logger.log('Phase 2 FVG scans failed: ' + fErr.message);
    }
    logRun_(ts, '', 0, 'OK (phase 2 - patterns)',
            'Pattern/FVG/10-21 EMA recomputed from the OHLC Phase 1 fetched - no new fetch.' + scanNote);
  } catch (e) {
    logRun_(ts, '', 0, 'ERROR (phase 2 - patterns)', e.message);
    ab_sendDailyPhaseFailureEmail_('Phase 2 (patterns)', ts, e);
    throw e;
  }
}

/** Phase 3 (~7:01 PM): EOD zone sweep, ATR, price alerts, trade resolution, dashboards, EOD email, IPO base watch. */
function ab_dailyPhase3AlertsEmail_(e) {
  if (ab_skipWeekendTrigger_(e, 'Phase 3 (alerts/EOD)')) return;
  const ts = Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm');
  const t0 = Date.now();
  const lap = function (label) { Logger.log('Phase 3 - ' + label + ' done at +' + Math.round((Date.now() - t0) / 1000) + 's'); };
  try {
    // Last resort: if neither Phase 1 nor Phase 2 managed the FVG watch-list scans, do them now
    // (the sweep and the EOD summary below read what they write).
    try { ab_runFvgScansIfPending_('Phase 3'); } catch (fErr) { Logger.log('Phase 3 FVG scans failed: ' + fErr.message); }
    lap('pending FVG scans check');

    // EOD sweep over both zone types, against today's settled prices -
    // catches an "approaching" zone the 5-minute intraday pass missed
    // (not installed, or the level only came into range after close).
    try {
      ab_sendZoneAlerts_(checkGapUpAlerts_());
      ab_sendZoneAlerts_(checkUnmitigatedAlerts_());
    } catch (zErr) {
      Logger.log('EOD zone alert sweep failed: ' + zErr.message);
    }

    lap('zone sweep');
    computeAtrPatterns_();
    lap('ATR');

    const fired = checkPriceAlerts_();
    updateAlertOutcomes_();
    buildAlertDashboard_();
    if (fired.length) {
      sendAlertEmail_(fired);
      sendAlertPush_(fired);
    }

    lap('price alerts + outcomes + alert dashboard');
    const resolvedTrades = resolveTradesEOD_();
    buildTradeDashboard_();
    lap('trades + trade dashboard');

    try {
      sendEodSummaryEmail_(resolvedTrades);
    } catch (sErr) {
      Logger.log('EOD summary failed: ' + sErr.message);
    }

    lap('EOD summary');

    // Quality Watch and the IPO Base Watch run in Phase 4 (own trigger, own 6-minute budget).
    // If that trigger is not installed yet, do them here as before so nothing goes missing.
    let ipoBaseNote = '';
    if (!ab_hasPhase4Trigger_()) {
      if (Date.now() - t0 < 200000) {
        ab_dailyPhase4Work_();
        ipoBaseNote = ' (Phase 4 trigger missing - Quality Watch / IPO base ran here; re-run Install Daily Pipeline Triggers)';
        lap('Quality Watch + IPO base (inline)');
      } else {
        ipoBaseNote = ' (Phase 4 trigger missing and Phase 3 already used 200s - Quality Watch / IPO base skipped; re-run Install Daily Pipeline Triggers)';
      }
    }

    const p1 = ab_readDailyPhase1Result_();
    logRun_(ts, p1 ? p1.asOfDate : '', p1 ? p1.symbolCount : 0, 'OK (phase 3 - alerts/trades/email)',
            (p1 && p1.failed && p1.failed.length ? ('No data for: ' + p1.failed.join(', ') + '. ') : '') +
            fired.length + ' alert(s) fired, ' + resolvedTrades.length + ' trade(s) resolved.' + ipoBaseNote);
  } catch (e) {
    logRun_(ts, '', 0, 'ERROR (phase 3 - alerts/trades/email)', e.message);
    ab_sendDailyPhaseFailureEmail_('Phase 3 (alerts/trades/email)', ts, e);
    throw e;
  }
}

/** Menu: run one phase right now - useful for testing, or to recover a single phase without repeating the others. */
function runDailyPhase1Now() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    ab_dailyPhase1Fetch_();
    ss.toast('Phase 1 (fetch) complete.', 'Daily Pipeline', 10);
  } catch (e) {
    ss.toast('Phase 1 (fetch) failed: ' + e.message);
  }
}
function runDailyPhase2Now() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    ab_dailyPhase2Patterns_();
    ss.toast('Phase 2 (patterns) complete.', 'Daily Pipeline', 10);
  } catch (e) {
    ss.toast('Phase 2 (patterns) failed: ' + e.message);
  }
}
function runDailyPhase4Now() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    ab_dailyPhase4Extras_();
    ss.toast('Phase 4 (Quality Watch + IPO base) complete.', 'Daily Pipeline', 10);
  } catch (e) {
    ss.toast('Phase 4 (Quality Watch + IPO base) failed: ' + e.message);
  }
}

function runDailyPhase3Now() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    ab_dailyPhase3AlertsEmail_();
    ss.toast('Phase 3 (alerts/trades/email) complete.', 'Daily Pipeline', 10);
  } catch (e) {
    ss.toast('Phase 3 (alerts/trades/email) failed: ' + e.message);
  }
}

/** True when the Phase 4 trigger is installed. */
function ab_hasPhase4Trigger_() {
  try {
    return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'ab_dailyPhase4Extras_'; });
  } catch (e) { return false; }
}

/** The two extra emails: Quality Watch, then the IPO Base Watch. Each soft-fails on its own. Returns a short note. */
function ab_dailyPhase4Work_() {
  let note = '';
  try {
    sendQualityWatchEmail_();
  } catch (qErr) {
    Logger.log('Quality Watch email failed: ' + qErr.message);
    note += ' Quality Watch failed: ' + qErr.message + '.';
  }
  try {
    const newBases = computeIpoBases_();
    const baseAlerts = updateIpoBaseStatus_();
    sendIpoBaseEmail_(baseAlerts);
    note += ' IPO base: ' + baseAlerts.approaching.length + ' approaching, ' +
            baseAlerts.brokeOut.length + ' broke out' + (newBases ? (', ' + newBases + ' new base(s)') : '') + '.';
  } catch (baseErr) {
    note += ' IPO base watch failed: ' + baseErr.message;
    Logger.log('IPO base watch failed: ' + baseErr.message);
  }
  return note;
}

/** Phase 4 (~7:20 PM): Quality Watch email + IPO Base Watch email, on their own 6-minute budget. */
function ab_dailyPhase4Extras_(e) {
  if (ab_skipWeekendTrigger_(e, 'Phase 4 (Quality Watch / IPO base)')) return;
  const ts = Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm');
  const t0 = Date.now();
  try {
    const note = ab_dailyPhase4Work_();
    Logger.log('Phase 4 done in ' + Math.round((Date.now() - t0) / 1000) + 's.' + note);
    logRun_(ts, '', 0, 'OK (phase 4 - quality watch / IPO base)', note.trim());
  } catch (e) {
    logRun_(ts, '', 0, 'ERROR (phase 4 - quality watch / IPO base)', e.message);
    ab_sendDailyPhaseFailureEmail_('Phase 4 (Quality Watch / IPO base)', ts, e);
    throw e;
  }
}

/** Menu: install all three phase triggers. Removes the old single-shot autoDailyUpdate trigger first (if present) so OHLC never gets fetched twice in one evening. */
function installDailyPhaseTriggers() {
  ab_removeOrphanTriggers_();
  removeDailyPhaseTriggers();
  ScriptApp.newTrigger('ab_dailyPhase1Fetch_')
    .timeBased().atHour(AB_DAILY_P1_HOUR).nearMinute(AB_DAILY_P1_MIN).everyDays(1).inTimezone(AB_TZ).create();
  ScriptApp.newTrigger('ab_dailyPhase2Patterns_')
    .timeBased().atHour(AB_DAILY_P2_HOUR).nearMinute(AB_DAILY_P2_MIN).everyDays(1).inTimezone(AB_TZ).create();
  ScriptApp.newTrigger('ab_dailyPhase3AlertsEmail_')
    .timeBased().atHour(AB_DAILY_P3_HOUR).nearMinute(AB_DAILY_P3_MIN).everyDays(1).inTimezone(AB_TZ).create();
  ScriptApp.newTrigger('ab_dailyPhase4Extras_')
    .timeBased().atHour(AB_DAILY_P4_HOUR).nearMinute(AB_DAILY_P4_MIN).everyDays(1).inTimezone(AB_TZ).create();
  SpreadsheetApp.getActiveSpreadsheet().toast(
    'Daily pipeline installed - Phase 1 (fetch) ~' + AB_DAILY_P1_HOUR + ':' + ('0' + AB_DAILY_P1_MIN).slice(-2) +
    ', Phase 2 (patterns) ~' + AB_DAILY_P2_HOUR + ':' + ('0' + AB_DAILY_P2_MIN).slice(-2) +
    ', Phase 3 (alerts/trades/email) ~' + AB_DAILY_P3_HOUR + ':' + ('0' + AB_DAILY_P3_MIN).slice(-2) +
    ', Phase 4 (Quality Watch + IPO base) ~' + AB_DAILY_P4_HOUR + ':' + ('0' + AB_DAILY_P4_MIN).slice(-2) +
    ' IST, every day. The old single autoDailyUpdate trigger (if any) was removed so OHLC is never fetched twice.',
    'Daily Pipeline', 15);
}

/** Menu: remove all three phase triggers. */
function removeDailyPhaseTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const fn = t.getHandlerFunction();
    if (fn === 'ab_dailyPhase1Fetch_' || fn === 'ab_dailyPhase2Patterns_' || fn === 'ab_dailyPhase3AlertsEmail_' || fn === 'ab_dailyPhase4Extras_') {
      ScriptApp.deleteTrigger(t);
    }
  });
}

/*****************************************************************
 * SYMBOL SYNC - pulls StockName + SYMBOL from Stock Blueprint
 * so PatternData always reflects your current watchlist
 *****************************************************************/
function syncSymbolsFromBlueprint_() {
  // Same spreadsheet now - no openById, no cross-file permission needed.
  const bp = SpreadsheetApp.getActiveSpreadsheet();
  const bpSheet = bp.getSheetByName(AB_MAIN_SHEET);
  if (!bpSheet) throw new Error('Could not find a "' + AB_MAIN_SHEET + '" tab in this spreadsheet.');
  const data = bpSheet.getDataRange().getValues();

  // Find header row (contains both "StockName" and "SYMBOL")
  let headerRowIdx = -1, nameCol = -1, symCol = -1;
  for (let r = 0; r < Math.min(10, data.length); r++) {
    const row = data[r].map(v => String(v).trim());
    const ni = row.indexOf('StockName');
    const si = row.indexOf('SYMBOL');
    if (ni !== -1 && si !== -1) {
      headerRowIdx = r; nameCol = ni; symCol = si;
      break;
    }
  }
  if (headerRowIdx === -1) throw new Error('Could not find StockName/SYMBOL header in Stock Blueprint');

  // The "Main" tab isn't just the watchlist - it has several other
  // tables (IPO tracker, industry PE, trade log, results calendar,
  // pattern dashboard...) stacked below it in the SAME tab,
  // separated by blank rows. Stop at the first fully-blank row so we
  // only read the actual watchlist block, not the rest of the sheet.
  const bpMap = {}; // symbol -> company name
  for (let r = headerRowIdx + 1; r < data.length; r++) {
    const sym = String(data[r][symCol]).trim().toUpperCase();
    const name = String(data[r][nameCol]).trim();
    if (!sym && !name) break; // end of the watchlist block
    if (sym) bpMap[sym] = name;
  }

  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AB_PATTERN_SHEET);
  const lastRow = sh.getLastRow();
  const existingSymbols = lastRow > 1
    ? sh.getRange(2, 4, lastRow - 1, 1).getValues().flat().map(v => String(v).trim().toUpperCase())
    : [];

  // Update company names for existing rows - collect first, write once.
  // This used to be one sh.getRange(...).setValue(...) PER ROW, so at
  // ~1800 symbols it was ~1800 separate Sheets-API round-trips every
  // single evening - by far the single biggest hidden cost in the
  // whole daily run, and the real reason autoDailyUpdate kept hitting
  // Apps Script's 6-minute cap even after the other fixes (07-Oct-2026).
  // Same one-setValues()-beats-N-setValue()-calls fix already used by
  // fillIpoLevel_ and fillPrevDayVolume_ below.
  if (existingSymbols.length) {
    const existingNames = sh.getRange(2, 2, existingSymbols.length, 1).getValues();
    let changed = false;
    const namesOut = existingSymbols.map(function (sym, i) {
      if (sym && bpMap[sym] && bpMap[sym] !== existingNames[i][0]) {
        changed = true;
        return [bpMap[sym]];
      }
      return [existingNames[i][0]];
    });
    if (changed) {
      sh.getRange(2, 2, namesOut.length, 1).setValues(namesOut);
    }
  }

  // Append any Blueprint symbols not already present - also batched into
  // one write instead of one setValues() call per new symbol.
  const existingSet = new Set(existingSymbols);
  const toAdd = Object.keys(bpMap).filter(sym => !existingSet.has(sym));
  if (toAdd.length) {
    const newRows = toAdd.map(function (sym) {
      const row = new Array(23).fill('');
      row[1] = bpMap[sym]; // B - Company
      row[3] = sym;        // D - Symbol
      return row;
    });
    sh.getRange(lastRow + 1, 1, newRows.length, 23).setValues(newRows);
  }
}

/*****************************************************************
 * CHART / SCREENER.IN LINK FILL  (added 30-Aug-2026)
 * -----------------------------------------------------------------
 * Fills Main's "Chart" and "Screener.in" HYPERLINK cells for any row
 * that has a SYMBOL but is missing one or both link cells. This is a
 * standalone repair pass, separate from fillNewSymbolDetails_ - that
 * one only touches rows with a blank StockName (freshly pasted
 * symbols); this one scans EVERY row in the watchlist block, so it
 * also catches a row where the symbol was there all along but the
 * link cell got cleared, pasted over, or was simply never filled in.
 *
 * A cell already holding something is left completely alone - only
 * genuinely blank Chart/Screener.in cells are touched, so nothing
 * you already have gets overwritten.
 *
 * Each link is always built fresh from THAT row's OWN SYMBOL, never
 * copied from another row: the symbol is a literal string baked into
 * the URL, not a cell reference, so a copyTo()-style fill-down would
 * just repeat whichever symbol the source row happened to have -
 * same reasoning fillNewSymbolDetails_ already documents.
 *****************************************************************/
function fillChartScreenerLinks_() {
  const layout = ab_getMainLayout_();
  const header = layout.header;
  const chartCol = header.indexOf('Chart');
  const screenerCol = header.indexOf('Screener.in');
  if (chartCol === -1 && screenerCol === -1) {
    throw new Error('Main needs a "Chart" and/or "Screener.in" column to fill links into.');
  }

  const data = layout.data;
  let filled = 0, scanned = 0;

  for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
    const sym = ab_cellText_(data[r][layout.symbol]).toUpperCase();
    const name = ab_cellText_(data[r][layout.name]);
    if (!sym && !name) break; // end of the watchlist block - other tables follow
    if (!sym) continue;
    scanned++;

    const row = r + 1;
    let touchedRow = false;

    if (chartCol !== -1 && ab_cellText_(data[r][chartCol]) === '') {
      layout.sheet.getRange(row, chartCol + 1)
        .setFormula('=HYPERLINK("' + ab_chartUrl_(sym) + '","📈 Chart")');
      touchedRow = true;
    }
    if (screenerCol !== -1 && ab_cellText_(data[r][screenerCol]) === '') {
      layout.sheet.getRange(row, screenerCol + 1)
        .setFormula('=HYPERLINK("' + ab_screenerUrl_(sym) + '","📊 Screener")');
      touchedRow = true;
    }
    if (touchedRow) filled++;
  }

  Logger.log('Chart/Screener links: ' + filled + ' row(s) filled out of ' + scanned + ' scanned.');
  return { filled: filled, scanned: scanned };
}

/** Menu: fill in any missing Chart / Screener.in links in Main. */
function runFillChartScreenerLinks() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Filling missing Chart / Screener.in links...');
  try {
    const s = fillChartScreenerLinks_();
    logRun_(Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm'), '', s.filled,
            'OK (chart/screener links)', s.filled + ' row(s) filled out of ' + s.scanned + ' scanned.');
    ss.toast(s.filled + ' row(s) filled out of ' + s.scanned + ' scanned.', 'Chart/Screener links', 10);
  } catch (e) {
    ss.toast('Fill failed: ' + e.message);
  }
}

/**
 * Reads the IPOs tab and returns { symbol -> "Below"/"Above" } straight
 * from its own column H ("Below or Above IPO price") - that column is
 * already computed there (against Listing Price), this just copies it,
 * it doesn't recompute anything itself.
 */
function ab_getIpoLevelMap_() {
  const map = {};
  let layout;
  try {
    layout = ab_getIpoSheetLayout_();
  } catch (e) {
    Logger.log('Could not read the "' + AB_IPO_SHEET + '" tab: ' + e.message);
    return map;
  }
  if (layout.level === -1) {
    Logger.log('Could not find a "' + AB_IPO_LEVEL_HEADER + '" column in the "' + AB_IPO_SHEET + '" tab.');
    return map;
  }

  const data = layout.data;
  for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
    const sym = ab_cellText_(data[r][layout.symbol]).toUpperCase();
    if (!sym) continue;
    const level = ab_cellText_(data[r][layout.level]);
    if (level) map[sym] = level; // later duplicate rows overwrite earlier ones
  }
  return map;
}

/**
 * Cell value -> trimmed string, with null/undefined mapped to '' rather
 * than the literal text "null"/"undefined". Plain String(v) on a
 * missing cell yields "undefined", which is truthy and silently
 * propagates into the sheet - that's exactly what put "undefined" in
 * Main's IPO Level column.
 */
function ab_cellText_(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

/**
 * Fills Main's "IPO Level" column for every symbol that's also in the
 * IPOs tab. Symbols not in that tracker (i.e. not an IPO stock) are
 * left blank rather than guessed at.
 */
function fillIpoLevel_() {
  const layout = ab_getMainLayout_();
  if (layout.ipoLevel === -1) {
    Logger.log('Could not find "IPO Level" column in Main - skipping.');
    return;
  }
  const ipoMap = ab_getIpoLevelMap_();
  const data = layout.data;
  let filled = 0;

  // Collect first, write once. One setValues() beats ~800 setValue()
  // round-trips, which is the difference between a second and a minute
  // inside the daily run.
  const out = [];
  let firstRow = -1;
  for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
    const sym = ab_cellText_(data[r][layout.symbol]).toUpperCase();
    const name = ab_cellText_(data[r][layout.name]);
    if (!sym && !name) break; // end of the watchlist block
    if (firstRow === -1) firstRow = r + 1;
    // Non-IPO symbols get '' rather than being skipped, so a stale value
    // from a previous run (including the old "undefined") gets cleared.
    const level = (sym && ipoMap[sym]) ? ipoMap[sym] : '';
    out.push([level]);
    if (level) filled++;
  }

  if (out.length) {
    layout.sheet.getRange(firstRow, layout.ipoLevel + 1, out.length, 1).setValues(out);
  }
  SpreadsheetApp.getActiveSpreadsheet().toast('IPO Level filled for ' + filled + ' symbol(s).');
}

/*****************************************************************
 * NEW-IPO AUTO-SYNC (Chittorgarh)
 * -----------------------------------------------------------------
 * Finds newly-listed IPOs and appends them to the IPOs tab so you
 * don't have to add each one by hand. Source: Chittorgarh's "IPO
 * Listing Dates" report, hit directly as JSON (see AB_IPO_CHITTORGARH_
 * URL_TMPL above) - this is a public, unauthenticated endpoint their
 * own site's frontend calls, confirmed reachable with a plain fetch
 * (unlike NSE's own domain, which blocks Apps Script's IP ranges).
 *
 * This is a third-party site, not an official exchange feed - if
 * Chittorgarh changes their API shape this will start returning 0
 * rows or erroring; both cases are logged and swallowed rather than
 * breaking the daily run (see the try/catch around the call in
 * autoDailyUpdate). Run "Sync New IPOs (Chittorgarh)" from the menu
 * any time to check it's still working.
 *****************************************************************/

/**
 * Turns Chittorgarh's "2026-08-06T00:00:00.000Z" into a plain
 * calendar date with no time component.
 *
 * Passing that string straight to new Date() parses it as UTC midnight,
 * which in IST is 5:30 AM the same day - so the cell ends up holding a
 * timestamp ("8/6/2026 5:30:00") rather than a date. Reading the
 * y/m/d off the string and constructing the Date from those parts
 * sidesteps the timezone conversion entirely: the listing date is a
 * calendar fact, not a moment in time.
 */
function ab_parseIsoDateOnly_(iso) {
  if (!iso) return null;
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])); // local midnight
}

/** Fetches one category/year's IPO listing report as an array of raw
 *  record objects, or [] on any failure (network, bad JSON, etc). */
function ab_fetchChittorgarhIpoListings_(category, year) {
  const fyy = String((year + 1) % 100).padStart(2, '0');
  const url = AB_IPO_CHITTORGARH_URL_TMPL
    .split('{YEAR}').join(year) // two {YEAR} placeholders - split/join replaces both
    .replace('{FYY}', fyy)
    .replace('{CATEGORY}', category);
  try {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      Logger.log('Chittorgarh IPO fetch (' + category + ' ' + year + ') failed: HTTP ' + res.getResponseCode());
      return [];
    }
    const json = JSON.parse(res.getContentText());
    return json.reportTableData || [];
  } catch (e) {
    Logger.log('Chittorgarh IPO fetch (' + category + ' ' + year + ') failed: ' + e.message);
    return [];
  }
}

/**
 * Resolves the IPOs tab's columns by header name, same convention as
 * ab_getMainLayout_ - so adding/reordering columns there doesn't
 * silently break the sync.
 */
function ab_getIpoSheetLayout_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(AB_IPO_SHEET);
  if (!sh) throw new Error('Could not find an "' + AB_IPO_SHEET + '" tab.');
  const data = sh.getDataRange().getValues();

  let headerRowIdx = -1;
  for (let r = 0; r < Math.min(10, data.length); r++) {
    const row = data[r].map(v => String(v).trim().toUpperCase());
    if (row.indexOf(AB_IPO_SYMBOL_HEADER) !== -1) { headerRowIdx = r; break; }
  }
  if (headerRowIdx === -1) throw new Error('Could not find the "' + AB_IPO_SYMBOL_HEADER + '" header in ' + AB_IPO_SHEET + '.');

  const header = data[headerRowIdx].map(v => String(v).trim().toUpperCase());
  // Exact match first, then a punctuation/space-insensitive one - so a
  // stray trailing space or a "%" typed differently doesn't silently
  // lose a column.
  const normHeader = header.map(ab_normHeader_);
  function col(name) {
    const exact = header.indexOf(name.toUpperCase());
    if (exact !== -1) return exact;
    return normHeader.indexOf(ab_normHeader_(name));
  }

  return {
    sheet: sh,
    data: data,
    headerRowIdx: headerRowIdx,
    lastColumn: sh.getLastColumn(),
    // S.No is optional - the tab currently starts straight at NSE SYMBOL.
    // Everything downstream checks for -1 before using it.
    sNo: col('S.No'),
    symbol: col(AB_IPO_SYMBOL_HEADER),
    listingDate: col('LISTING DATE'),
    listingPrice: col('LISTING PRICE'),
    marketPrice: col('MarketPrice'),
    level: col(AB_IPO_LEVEL_HEADER),
    // IPO base breakout watch - add these headers yourself.
    base: col(AB_IPOBASE_BASE_HEADER),
    baseGap: col(AB_IPOBASE_PCT_HEADER),
    baseStatus: col(AB_IPOBASE_STATUS_HEADER),
    high52: col(AB_IPOBASE_52W_HEADER),      // optional
    activeBase: col(AB_IPOBASE_ACTIVE_HEADER), // optional (added automatically)
    base2: col(AB_IPOBASE_BASE2_HEADER),       // added automatically
    activeNo: col(AB_IPOBASE_ACTIVE_NO_HEADER), // added automatically
    base2a: col(AB_IPOBASE_BASE2A_HEADER),      // added automatically
    fvg: col(AB_IPOBASE_FVG_HEADER)             // added automatically
  };
}

/**
 * Pulls freshly-listed IPOs from Chittorgarh and appends any symbol not
 * already present in the IPOs tab. Fills S.No / NSE SYMBOL / LISTING
 * DATE / LISTING PRICE directly, then copies the formula cells (Market
 * Price, % change, Below/Above IPO price, etc) down from the last
 * existing row so the new row picks up the same live formulas instead
 * of sitting blank. Returns the list of symbols added.
 */
function syncNewIposFromChittorgarh_() {
  const layout = ab_getIpoSheetLayout_();
  const missing = [];
  if (layout.symbol === -1) missing.push(AB_IPO_SYMBOL_HEADER);
  if (layout.listingDate === -1) missing.push('LISTING DATE');
  if (layout.listingPrice === -1) missing.push('LISTING PRICE');
  if (missing.length) {
    throw new Error(AB_IPO_SHEET + ' is missing expected column(s): ' + missing.join(', '));
  }

  const existingSymbols = new Set();
  for (let r = layout.headerRowIdx + 1; r < layout.data.length; r++) {
    const sym = String(layout.data[r][layout.symbol]).trim().toUpperCase();
    if (sym) existingSymbols.add(sym);
  }

  const year = Number(Utilities.formatDate(new Date(), AB_TZ, 'yyyy'));
  const newRows = []; // [sNo, symbol, listingDate, listingPrice] positioned to real columns below
  const addedSymbols = [];

  AB_IPO_CHITTORGARH_CATEGORIES.forEach(category => {
    const records = ab_fetchChittorgarhIpoListings_(category, year);
    records.forEach(rec => {
      const sym = String(rec['~nse_symbol'] || '').trim().toUpperCase();
      if (!sym || existingSymbols.has(sym)) return; // no symbol, or already tracked

      const listingDate = ab_parseIsoDateOnly_(rec['~IL_IPO_Listing_date']);
      const issuePrice = ab_toNum_(rec['Issue Price (Rs.)']);

      newRows.push({
        sNo: 0, // filled in below once we know the final count
        symbol: sym,
        listingDate: listingDate,
        listingPrice: isNaN(issuePrice) ? '' : issuePrice
      });
      existingSymbols.add(sym); // guard against duplicates within this same run
      addedSymbols.push(sym);
    });
  });

  if (!newRows.length) return addedSymbols;

  const sh = layout.sheet;
  const lastRow = sh.getLastRow();
  let dataRowCount = Math.max(0, lastRow - layout.headerRowIdx - 1);
  const maxKnownCol = Math.max(layout.sNo, layout.symbol, layout.listingDate, layout.listingPrice);
  // Only copy formula columns down if there's both (a) at least one real
  // existing data row to copy from, and (b) columns past the 4 known
  // ones to actually copy.
  const hasExistingDataRow = lastRow > layout.headerRowIdx + 1;
  const hasFormulaCols = layout.lastColumn > maxKnownCol + 1;

  newRows.forEach(row => {
    dataRowCount++;
    const targetRow = layout.headerRowIdx + 1 + dataRowCount;
    if (layout.sNo !== -1) sh.getRange(targetRow, layout.sNo + 1).setValue(dataRowCount);
    sh.getRange(targetRow, layout.symbol + 1).setValue(row.symbol);
    if (row.listingDate) {
      // Format first, then write - so the value never renders in the
      // locale default (M/d/yyyy) even briefly.
      sh.getRange(targetRow, layout.listingDate + 1)
        .setNumberFormat(AB_IPO_DATE_FORMAT)
        .setValue(row.listingDate);
    }
    sh.getRange(targetRow, layout.listingPrice + 1).setValue(row.listingPrice);

    // Copy any formula columns (MarketPrice, % change, Below/Above IPO
    // price, ...) down from the row directly above, same as dragging
    // the fill handle. targetRow-1 is always a real data row here: for
    // the first new row that's the last pre-existing row, and for
    // every row after that it's the new row this loop just filled in.
    if (hasExistingDataRow && hasFormulaCols) {
      const srcRow = targetRow - 1;
      sh.getRange(srcRow, maxKnownCol + 2, 1, layout.lastColumn - maxKnownCol - 1)
        .copyTo(sh.getRange(targetRow, maxKnownCol + 2, 1, layout.lastColumn - maxKnownCol - 1));

      // The copy above is meant for the live formula columns. The IPO
      // base trio holds per-symbol VALUES, not formulas - copying them
      // would stamp the previous company's listing-day high onto this
      // new row, and computeIpoBases_ would then skip it as "already
      // known". Blank them so the real base gets computed.
      [layout.base, layout.baseGap, layout.baseStatus, layout.base2, layout.base2a, layout.activeBase, layout.activeNo, layout.high52, layout.fvg].forEach(function (c) {
        if (c !== undefined && c !== -1) sh.getRange(targetRow, c + 1).clearContent();
      });
    }
  });

  try { ab_linkIpoSymbols_(); } catch (e) { Logger.log('IPO symbol links skipped: ' + e.message); }
  return addedSymbols;
}

/**
 * ONE-TIME (safe to re-run) repair for rows the sync already wrote with
 * a timestamp instead of a plain date - e.g. "8/6/2026 5:30:00" from the
 * UTC-midnight bug described in ab_parseIsoDateOnly_. Walks the whole
 * LISTING DATE column, strips any time component off real Date values,
 * and applies AB_IPO_DATE_FORMAT so every row matches (19/04/2024).
 *
 * Rows already stored as plain dates are left alone apart from the
 * format; text values that aren't dates at all are skipped rather than
 * guessed at, so nothing gets mangled.
 */
function fixIpoListingDateFormats_() {
  const layout = ab_getIpoSheetLayout_();
  if (layout.listingDate === -1) throw new Error('Could not find a "LISTING DATE" column in ' + AB_IPO_SHEET + '.');

  const sh = layout.sheet;
  const firstDataRow = layout.headerRowIdx + 2;
  const lastRow = sh.getLastRow();
  if (lastRow < firstDataRow) {
    SpreadsheetApp.getActiveSpreadsheet().toast('No IPO rows to fix.');
    return 0;
  }

  const range = sh.getRange(firstDataRow, layout.listingDate + 1, lastRow - firstDataRow + 1, 1);
  const values = range.getValues();
  let fixed = 0;

  const cleaned = values.map(r => {
    const v = r[0];
    if (Object.prototype.toString.call(v) !== '[object Date]') return [v]; // blank or text - leave it
    if (v.getHours() === 0 && v.getMinutes() === 0 && v.getSeconds() === 0) return [v]; // already clean
    fixed++;
    return [new Date(v.getFullYear(), v.getMonth(), v.getDate())]; // drop the time part
  });

  range.setNumberFormat(AB_IPO_DATE_FORMAT); // whole column, so old rows match too
  range.setValues(cleaned);

  SpreadsheetApp.getActiveSpreadsheet().toast(
    'IPO listing dates normalised to ' + AB_IPO_DATE_FORMAT +
    (fixed ? (' - stripped the time off ' + fixed + ' row(s).') : ' - no stray timestamps found.'));
  return fixed;
}

/*****************************************************************
 * IPO LISTING DATE CHECK (day / month swapped)
 * -----------------------------------------------------------------
 * Typing 11/09/2023 into a sheet whose locale is month-first stores
 * 9 NOVEMBER 2023, not 11 September. Only dates with a day of 12 or
 * less can be mixed up like this (25/12 can't be a month).
 *
 * For each such row this asks GOOGLEFINANCE for the FIRST day the
 * stock ever traded, looking at a window that covers both readings of
 * the date. If the first trading day is next to the date as stored,
 * the date is fine; if it is next to the swapped reading, the row is
 * listed and (after a Yes) corrected. Anything that matches neither is
 * listed for a manual look but never changed.
 *****************************************************************/

/**
 * items = [{ sym, from: Date, to: Date }] -> { SYM: Date | null }
 * The first trading day GOOGLEFINANCE returns inside each window.
 * One scratch cell per symbol, one flush for all of them.
 */
function ab_ipoFirstTradeDates_(items) {
  const out = {};
  if (!items || !items.length) return out;
  const scratch = ab_getScratchSheet_();
  scratch.clearContents();
  if (scratch.getMaxRows() < items.length) scratch.insertRowsAfter(scratch.getMaxRows(), items.length - scratch.getMaxRows());
  items.forEach(function (it, i) {
    const a = it.from, b = it.to;
    scratch.getRange(i + 1, 1).setFormula(
      '=IFERROR(INDEX(GOOGLEFINANCE("NSE:' + it.sym + '","close",DATE(' + a.getFullYear() + ',' + (a.getMonth() + 1) + ',' + a.getDate() +
      '),DATE(' + b.getFullYear() + ',' + (b.getMonth() + 1) + ',' + b.getDate() + ')),2,1),"")');
  });
  SpreadsheetApp.flush();
  const vals = scratch.getRange(1, 1, items.length, 1).getValues();
  items.forEach(function (it, i) {
    const v = vals[i][0];
    out[it.sym] = (v === '' || v === null) ? null : ab_toJsDate_(v);
  });
  scratch.clearContents();
  return out;
}

/**
 * Works out which rows have a swapped listing date. `rows` =
 * [{ rowIdx, sym, date }]. Returns { swapped:[{rowIdx,sym,date,fixed,first}],
 * ok:n, unknown:[{rowIdx,sym,date,first}] }.
 */
function ab_classifyIpoDates_(rows) {
  const res = { swapped: [], ok: 0, unknown: [] };
  const today = new Date();
  const DAY = 86400000, NEAR = 4;
  const items = [], meta = [];
  rows.forEach(function (r) {
    const d = r.date, y = d.getFullYear();
    const dd = d.getDate(), mm = d.getMonth() + 1;
    if (dd > 12 || dd === mm) { res.ok++; return; }           // cannot be swapped
    const alt = ab_mkDate_(y, dd, mm);                        // day <-> month
    if (!alt) { res.ok++; return; }
    const lo = new Date(Math.min(d.getTime(), alt.getTime()) - 5 * DAY);
    let hi = new Date(Math.max(d.getTime(), alt.getTime()) + 10 * DAY);
    if (hi > today) hi = today;
    if (lo > hi) { res.ok++; return; }
    items.push({ sym: r.sym, from: lo, to: hi });
    meta.push({ r: r, alt: alt });
  });
  const first = ab_ipoFirstTradeDates_(items);
  meta.forEach(function (m) {
    const f = first[m.r.sym];
    if (!f) { res.unknown.push({ rowIdx: m.r.rowIdx, sym: m.r.sym, date: m.r.date, first: null }); return; }
    const dStored = Math.abs(f - m.r.date) / DAY, dAlt = Math.abs(f - m.alt) / DAY;
    if (dStored <= NEAR) { res.ok++; return; }
    if (dAlt <= NEAR) { res.swapped.push({ rowIdx: m.r.rowIdx, sym: m.r.sym, date: m.r.date, fixed: new Date(f.getFullYear(), f.getMonth(), f.getDate()), first: f }); return; }
    res.unknown.push({ rowIdx: m.r.rowIdx, sym: m.r.sym, date: m.r.date, first: f });
  });
  return res;
}

/** Menu: find (and, after a Yes, fix) IPO rows whose listing day/month were swapped. */
function runCheckIpoListingDates() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const layout = ab_getIpoSheetLayout_();
    if (layout.listingDate === -1) throw new Error('Could not find a "LISTING DATE" column in ' + AB_IPO_SHEET + '.');
    const rows = [];
    for (let r = layout.headerRowIdx + 1; r < layout.data.length; r++) {
      const sym = ab_cellText_(layout.data[r][layout.symbol]).toUpperCase();
      const v = layout.data[r][layout.listingDate];
      if (!sym || Object.prototype.toString.call(v) !== '[object Date]' || isNaN(v.getTime())) continue;
      rows.push({ rowIdx: r, sym: sym, date: v });
    }
    ss.toast('Checking ' + rows.length + ' listing dates against Google Finance...', 'IPO dates', 30);
    const res = ab_classifyIpoDates_(rows);
    const f = function (d) { return Utilities.formatDate(d, AB_TZ, 'dd/MM/yyyy'); };

    if (!res.swapped.length) {
      let msg = 'No swapped day/month found in ' + rows.length + ' listing dates.';
      if (res.unknown.length) msg += '\n\nCould not confirm ' + res.unknown.length + ' (no price history, or the first trade is on neither reading):\n' +
        res.unknown.slice(0, 25).map(function (u) { return u.sym + ' ' + f(u.date) + (u.first ? ' (first trade ' + f(u.first) + ')' : ''); }).join('\n');
      ui.alert('IPO listing dates', msg, ui.ButtonSet.OK);
      return;
    }
    let msg = res.swapped.length + ' listing date(s) have day and month swapped:\n\n' +
      res.swapped.map(function (x) { return x.sym + ':  ' + f(x.date) + '  ->  ' + f(x.fixed) + '   (first trade ' + f(x.first) + ')'; }).join('\n');
    if (res.unknown.length) msg += '\n\nNot confirmed (left untouched, check by hand):\n' +
      res.unknown.slice(0, 15).map(function (u) { return u.sym + ' ' + f(u.date) + (u.first ? ' (first trade ' + f(u.first) + ')' : ''); }).join('\n');
    msg += '\n\nCorrect these dates now? Their IPO Base columns will be cleared so they are recalculated from the right date.';
    if (ui.alert('IPO listing dates', msg, ui.ButtonSet.YES_NO) !== ui.Button.YES) return;

    const sh = layout.sheet;
    const derived = [layout.base, layout.baseGap, layout.baseStatus, layout.base2, layout.base2a, layout.activeBase, layout.activeNo, layout.high52, layout.fvg]
      .filter(function (c) { return c !== undefined && c !== -1; });
    res.swapped.forEach(function (x) {
      sh.getRange(x.rowIdx + 1, layout.listingDate + 1).setNumberFormat(AB_IPO_DATE_FORMAT).setValue(x.fixed);
      derived.forEach(function (c) { sh.getRange(x.rowIdx + 1, c + 1).clearContent(); });
    });
    SpreadsheetApp.flush();
    ss.toast(res.swapped.length + ' listing date(s) corrected. Now run: Auto Bhavcopy > 9. IPOs > Refresh IPO Base Columns (no email).', 'IPO dates', 20);
  } catch (e) {
    ss.toast('IPO date check failed: ' + e.message);
  }
}

/*****************************************************************
 * IPO BASE BREAKOUT WATCH
 * -----------------------------------------------------------------
 * Two halves:
 *   computeIpoBases_()      one-off per symbol - the listing-day high
 *   updateIpoBaseStatus_()  daily - distance to that level + alerts
 *
 * The alert fires while price is still BELOW the base and closing in,
 * which is the part worth acting on; a separate one fires the day it
 * actually breaks through.
 *****************************************************************/

/**
 * Fills the "IPO Base" column for any row that hasn't got one yet.
 *
 * The listing-day candle's high is fetched from GOOGLEFINANCE by
 * asking for a short window starting at the listing date and taking
 * the FIRST trading day returned - that handles listing dates that
 * fall on a weekend/holiday, or that are recorded a day out, without
 * needing an exact match.
 *
 * Same batching as refreshAllOHLC_: write all formulas, flush ONCE,
 * read the whole block back. Skips rows already filled, so it costs
 * nothing on later runs.
 */
function computeIpoBases_() {
  const layout = ab_getIpoSheetLayout_();
  if (layout.base === -1) {
    // Show what the script can actually see - far more useful than
    // just repeating what's missing.
    const found = layout.data[layout.headerRowIdx]
      .map(function (v) { return ab_cellText_(v); })
      .filter(function (v) { return v !== ''; });
    throw new Error('No "' + AB_IPOBASE_BASE_HEADER + '" column found in the ' + AB_IPO_SHEET +
      ' tab. Add these three headers on the same row as "' + AB_IPO_SYMBOL_HEADER + '": "' +
      AB_IPOBASE_BASE_HEADER + '", "' + AB_IPOBASE_PCT_HEADER + '", "' + AB_IPOBASE_STATUS_HEADER +
      '". Headers currently on row ' + (layout.headerRowIdx + 1) + ': ' + found.join(' | '));
  }
  if (layout.listingDate === -1) throw new Error('No "LISTING DATE" column in ' + AB_IPO_SHEET + '.');

  const data = layout.data;
  const todo = []; // {rowIdx, sym, y, m, d}
  for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
    const sym = ab_cellText_(data[r][layout.symbol]).toUpperCase();
    if (!sym) continue;
    if (ab_cellText_(data[r][layout.base]) !== '') continue; // already known
    const raw = data[r][layout.listingDate];
    const d = ab_parseDate_(raw); // day-first; see ab_parseDate_
    if (!d) continue;
    todo.push({ rowIdx: r, sym: sym, y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() });
  }
  if (!todo.length) return 0;

  const scratch = ab_getScratchSheet_();
  const totalRows = todo.length * AB_IPOBASE_ROWS_PER_BLOCK;
  scratch.clearContents();
  if (scratch.getMaxRows() < totalRows) {
    scratch.insertRowsAfter(scratch.getMaxRows(), totalRows - scratch.getMaxRows());
  }
  if (scratch.getMaxColumns() < AB_BLOCK_COLS) {
    scratch.insertColumnsAfter(scratch.getMaxColumns(), AB_BLOCK_COLS - scratch.getMaxColumns());
  }

  todo.forEach(function (t, i) {
    const start = i * AB_IPOBASE_ROWS_PER_BLOCK + 1;
    const dt = 'DATE(' + t.y + ',' + t.m + ',' + t.d + ')';
    scratch.getRange(start, 1).setFormula(
      '=IFERROR(GOOGLEFINANCE("NSE:' + t.sym + '","all",' + dt + ',' + dt +
      '+' + AB_IPOBASE_LOOKAHEAD_DAYS + '),"")');
  });
  SpreadsheetApp.flush(); // one round-trip for every symbol

  const all = scratch.getRange(1, 1, totalRows, AB_BLOCK_COLS).getValues();
  let filled = 0;
  todo.forEach(function (t, i) {
    const block = all.slice(i * AB_IPOBASE_ROWS_PER_BLOCK,
                            i * AB_IPOBASE_ROWS_PER_BLOCK + AB_IPOBASE_ROWS_PER_BLOCK);
    // Drop the header row and any blanks; the first survivor is the
    // listing day itself.
    const rows = block.filter(function (r) {
      return r[0] !== '' && r[0] !== null && String(r[0]).toLowerCase() !== 'date';
    });
    if (!rows.length) return;
    const high = ab_toNum_(rows[0][2]); // Date, Open, HIGH, Low, Close, Volume
    if (isNaN(high) || high <= 0) return;
    layout.sheet.getRange(t.rowIdx + 1, layout.base + 1).setValue(Math.round(high * 100) / 100);
    filled++;
  });
  scratch.clearContents();
  Logger.log('IPO bases computed for ' + filled + ' of ' + todo.length + ' pending symbol(s).');
  return filled;
}

/**
 * Why is an IPO Base still blank?
 *
 * computeIpoBases_ deliberately fails quietly - one unavailable symbol
 * must not stop the other 140 - but that means a row that never fills
 * gives no clue why. This asks the same question in a way that keeps
 * the answer:
 *
 *   - does NSE:SYMBOL resolve at all? (live price test)
 *   - does the historical query return any rows for the recorded
 *     listing date + AB_IPOBASE_LOOKAHEAD_DAYS?
 *   - if it does, what is the FIRST date it hands back? A date well
 *     after the one in column B means the listing date recorded is
 *     wrong (often the issue-open date rather than the first trading
 *     day), and the window is simply looking in the wrong place.
 *
 * Read-only: reports, changes nothing.
 */
function diagnoseIpoBases_() {
  const layout = ab_getIpoSheetLayout_();
  if (layout.base === -1 || layout.listingDate === -1) {
    throw new Error('The ' + AB_IPO_SHEET + ' tab needs both a "' +
      AB_IPOBASE_BASE_HEADER + '" and a "LISTING DATE" column.');
  }

  const data = layout.data;
  const todo = [];
  for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
    const sym = ab_cellText_(data[r][layout.symbol]).toUpperCase();
    if (!sym) continue;
    if (ab_cellText_(data[r][layout.base]) !== '') continue; // already resolved
    const raw = data[r][layout.listingDate];
    const d = ab_parseDate_(raw); // day-first; see ab_parseDate_
    todo.push({ sym: sym, date: d, rawDate: ab_cellText_(raw) });
  }
  if (!todo.length) return { checked: 0, lines: ['Every IPO already has a base - nothing blank.'] };

  const scratch = ab_getScratchSheet_();
  scratch.clearContents();
  const needRows = todo.length * AB_IPOBASE_ROWS_PER_BLOCK;
  if (scratch.getMaxRows() < needRows) {
    scratch.insertRowsAfter(scratch.getMaxRows(), needRows - scratch.getMaxRows());
  }
  if (scratch.getMaxColumns() < AB_BLOCK_COLS + 2) {
    scratch.insertColumnsAfter(scratch.getMaxColumns(), AB_BLOCK_COLS + 2 - scratch.getMaxColumns());
  }

  todo.forEach(function (t, i) {
    const start = i * AB_IPOBASE_ROWS_PER_BLOCK + 1;
    // Column H: does the ticker resolve at all right now?
    scratch.getRange(start, AB_BLOCK_COLS + 1)
      .setFormula('=IFERROR(GOOGLEFINANCE("NSE:' + t.sym + '","price"),"#NOSYMBOL")');
    // Columns A-F: the same historical query computeIpoBases_ runs.
    if (t.date) {
      const dt = 'DATE(' + t.date.getFullYear() + ',' + (t.date.getMonth() + 1) + ',' +
                 t.date.getDate() + ')';
      scratch.getRange(start, 1).setFormula(
        '=IFERROR(GOOGLEFINANCE("NSE:' + t.sym + '","all",' + dt + ',' + dt +
        '+' + AB_IPOBASE_LOOKAHEAD_DAYS + '),"")');
    }
  });
  SpreadsheetApp.flush();

  const all = scratch.getRange(1, 1, needRows, AB_BLOCK_COLS + 1).getValues();
  const lines = [];
  const counts = { noDate: 0, noSymbol: 0, noHistory: 0, dateOff: 0, ok: 0 };

  todo.forEach(function (t, i) {
    const block = all.slice(i * AB_IPOBASE_ROWS_PER_BLOCK,
                            i * AB_IPOBASE_ROWS_PER_BLOCK + AB_IPOBASE_ROWS_PER_BLOCK);
    const priceCell = block[0] ? block[0][AB_BLOCK_COLS] : '';
    const resolves = !(priceCell === '' || String(priceCell) === '#NOSYMBOL');

    if (!t.date) {
      counts.noDate++;
      lines.push(t.sym + ': listing date unreadable ("' + t.rawDate + '")');
      return;
    }
    const rows = block.filter(function (r) {
      return r[0] !== '' && r[0] !== null && String(r[0]).toLowerCase() !== 'date';
    });
    const asked = Utilities.formatDate(t.date, AB_TZ, 'dd-MMM-yyyy');

    if (!rows.length) {
      if (!resolves) {
        counts.noSymbol++;
        lines.push(t.sym + ': NSE:' + t.sym + ' does not resolve on Google Finance at all');
      } else {
        counts.noHistory++;
        lines.push(t.sym + ': trades today, but no history for ' + asked + ' +' +
                   AB_IPOBASE_LOOKAHEAD_DAYS + 'd');
      }
      return;
    }

    const firstDate = ab_toJsDate_(rows[0][0]);
    const got = firstDate ? Utilities.formatDate(firstDate, AB_TZ, 'dd-MMM-yyyy') : String(rows[0][0]);
    const dayGap = firstDate ? Math.round((firstDate - t.date) / 86400000) : 0;
    if (dayGap > 1) {
      counts.dateOff++;
      lines.push(t.sym + ': listing date says ' + asked + ' but first candle is ' + got +
                 ' (' + dayGap + 'd later)');
    } else {
      counts.ok++;
      lines.push(t.sym + ': ' + rows.length + ' row(s) from ' + got +
                 ', high ' + ab_toNum_(rows[0][2]) + ' - should have filled, re-run the base fill');
    }
  });

  scratch.clearContents();
  Logger.log('IPO base diagnosis:\n' + lines.join('\n'));
  return { checked: todo.length, counts: counts, lines: lines };
}

/** Menu: explain every blank IPO Base. */
function runIpoBaseDiagnosis() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const r = diagnoseIpoBases_();
    const c = r.counts || {};
    const summary = r.checked + ' blank base(s) checked.\n' +
      (c.noSymbol ? c.noSymbol + ' not on Google Finance\n' : '') +
      (c.noHistory ? c.noHistory + ' trade now but have no history at that date\n' : '') +
      (c.dateOff ? c.dateOff + ' have a listing date that misses the first candle\n' : '') +
      (c.noDate ? c.noDate + ' have an unreadable listing date\n' : '') +
      (c.ok ? c.ok + ' look fetchable - re-run "Fill IPO Bases"\n' : '');
    let ui = null;
    try { ui = SpreadsheetApp.getUi(); } catch (e) { /* no UI available */ }
    if (ui) ui.alert('IPO Base Diagnosis', summary + '\n' + r.lines.join('\n'), ui.ButtonSet.OK);
    else ss.toast(summary, 'IPO Base Diagnosis', 30);
  } catch (e) {
    ss.toast('Diagnosis failed: ' + e.message);
  }
}

/**
 * 52-week highs for the given symbols, in one batched GOOGLEFINANCE
 * round-trip. Returns { SYMBOL: number }.
 *
 * Uses the "high52" attribute rather than scanning history - it's a
 * single cell per symbol, and for a stock listed a few months ago it
 * simply reports the high since listing, which is what's wanted.
 */
function ab_fetch52WeekHighs_(symbols) {
  const out = {};
  if (!symbols || !symbols.length) return out;
  const scratch = ab_getScratchSheet_();
  scratch.clearContents();
  if (scratch.getMaxRows() < symbols.length) {
    scratch.insertRowsAfter(scratch.getMaxRows(), symbols.length - scratch.getMaxRows());
  }
  symbols.forEach(function (sym, i) {
    scratch.getRange(i + 1, 1).setFormula(
      '=IFERROR(GOOGLEFINANCE("NSE:' + sym + '","high52"),"")');
  });
  SpreadsheetApp.flush(); // one flush for all of them
  const vals = scratch.getRange(1, 1, symbols.length, 1).getValues();
  symbols.forEach(function (sym, i) {
    const n = ab_toNum_(vals[i][0]);
    if (!isNaN(n) && n > 0) out[sym] = n;
  });
  scratch.clearContents();
  return out;
}

/*****************************************************************
 * IPO BASES - the rule (taught from the CPPLUS chart)
 * -----------------------------------------------------------------
 * A stock can have several bases, one after another:
 *
 *   BASE 1 = the HIGH of the listing-day candle - but only if the next
 *   candle does NOT close above it. If candle 2 closes above the listing
 *   high, that high was never a base (INDOMIM): it is dropped and the next
 *   base found below becomes Base 1. If candle 2's HIGH goes above the
 *   listing high but it closes below it, Base 1 = candle 2's high
 *   (Rejection, MVELECTRO).
 *
 *   The FIRST base after a dropped listing high only needs
 *   AB_IPOBASE_FIRST_PEAK_MIN_DAYS (3) closes under its rally peak
 *   (MILKYMIST: peak 211.73, 3 closes under it, then it broke). Every
 *   base is judged BEFORE it breaks - never by what price did after.
 *
 *   A base is "broken" the first time a candle CLOSES above it
 *   (touching it during the day is not enough).
 *
 *   Once a base is broken, the next base is found like this:
 *     - look for the first REJECTION candle after the break: a candle
 *       whose high reaches the previous candle's high (or stops within
 *       AB_IPOBASE_TOUCH_TOL_PCT, 0.5%, short of it) but which closes
 *       BELOW that previous candle's high (a failed breakout / rejection);
 *     - the next base = that previous candle's high (the level that
 *       got pierced and rejected). It must be higher than the base that
 *       was just broken;  [type: REJECTION BASE - CPPLUS]
 *     - OR, if there is no such rejection candle, the PEAK of the first
 *       rally after the break: a candle whose high is the highest since
 *       the break and is higher than the highs of the next 2 candles.
 *       The peak's high is the next base. [type: PEAK PULLBACK BASE -
 *       SHREEJISPG, JGCHEM, RATNAVEER]. There is no depth rule and no
 *       price-floor rule: any pullback (RATNAVEER fell ~18% and
 *       consolidated for 3 months) is fine, as long as price stays under
 *       the peak for the minimum number of closes;
 *     - it only counts if price then CONSOLIDATED under it: at least
 *       AB_IPOBASE_MIN_CONSOL_DAYS (5) closes at/below the level before
 *       any close above it. If price shoots straight back up it was not a
 *       base and the search carries on;
 *     - and the rejection must come within AB_IPOBASE_REJECT_WITHIN_DAYS (10)
 *       trading days after the previous base was broken. A stock that runs
 *       straight up after Base 1 (Anlon) simply has no Base 2.
 *
 *   BASE 2A [type: LOWER-HIGH BASE - ADVIT JEWELS]: while price is under
 *   Base 2, a swing high that is lower than Base 2 but higher than Base 1
 *   (its high beats the 5 candles on each side), after which price stays
 *   under it for at least 5 closes before closing above. When it exists
 *   and is not broken yet, it is the nearest level, so it is the one the
 *   Near Base alert watches.
 *
 *   The ACTIVE base is the one not broken yet. The point of the watch is
 *   to be told while price is still BELOW the active base and closing in
 *   (entry before the breakout) - and again on the day a base breaks.
 *
 * CPPLUS: Base 1 = 1,103.7 (5-Aug listing high). 7-Aug closed above it
 * (broken). 8-Aug spiked to 1,225 but closed below 7-Aug's high, so
 * Base 2 = 7-Aug's high = 1,168.4. 20-Aug closed above it (broken).
 *****************************************************************/

/**
 * Works out the base sequence from daily candles (oldest first,
 * candles[0] = listing day; each candle needs h = high, c = close).
 * `level1` is the stored listing-day high from the IPOs tab (used for
 * Base 1 when given), `maxBases` how many bases to look for.
 *
 * Returns { bases: [{ no, level, formed, broken, rejectedAt }], active }
 *   formed     index of the candle whose high is the level
 *   broken     index of the first candle that closed above it, or -1
 *   rejectedAt index of the rejection candle (Base 2 onwards), or -1
 *   type       'Rejection' or 'Peak Pullback' (Base 2 onwards)
 *   voidBase   the listing-day high when it was dropped (candle 2 closed above it)
 *   sub        Base 2A (a lower swing high inside Base 2) or null
 *   active     the base not broken yet, or null when every base found
 *              has been broken (the next base is still to form)
 */
function ab_ipoBaseSequence_(candles, level1, maxBases, opts) {
  const out = { bases: [], active: null, forming: null };
  const n = candles ? candles.length : 0;
  if (!n) return out;
  opts = opts || {};
  const limit = maxBases && maxBases > 0 ? maxBases : 2;
  const minDays = opts.minConsolDays > 0 ? opts.minConsolDays : AB_IPOBASE_MIN_CONSOL_DAYS;
  const within = opts.rejectWithinDays > 0 ? opts.rejectWithinDays : AB_IPOBASE_REJECT_WITHIN_DAYS;
  const tol = opts.touchTolPct >= 0 ? opts.touchTolPct : AB_IPOBASE_TOUCH_TOL_PCT;
  const firstCloseAbove = function (level, from) {
    for (let j = from; j < n; j++) if (candles[j].c > level) return j;
    return -1;
  };

  const first = (typeof level1 === 'number' && level1 > 0) ? level1 : candles[0].h;
  // How Base 1 is decided from candle 2 (the first candle after listing day):
  //   candle 2 CLOSES above the listing high  -> the listing high was never a
  //       base (INDOMIM, LCL). It is dropped; the next base becomes Base 1.
  //   candle 2's HIGH goes above the listing high but it closes back under it
  //       -> a rejection: Base 1 = candle 2's high (MVELECTRO), as long as price
  //       then stays under it for the minimum number of closes.
  //   otherwise -> Base 1 = the listing-day high (CPPLUS).
  const second = n > 1 ? candles[1] : null;
  let voidFirst = !!(second && second.c > first);
  let cur = null;
  if (second && !voidFirst && second.h > first) {
    const lvl = second.h;
    const j2 = firstCloseAbove(lvl, 2);
    const held2 = (j2 === -1 ? n : j2) - 2;
    if (held2 >= minDays || j2 === -1) {
      cur = { no: 1, level: lvl, formed: 1, broken: j2, rejectedAt: 1, type: 'Rejection (2nd candle)' };
    } else {
      voidFirst = true;                              // shot straight up: no base here, carry on from the break
    }
  }
  if (!cur) cur = { no: 1, level: first, formed: 0, broken: firstCloseAbove(first, 1), rejectedAt: -1, type: 'Listing high' };
  out.bases.push(cur);
  const target = limit + (voidFirst ? 1 : 0);

  while (cur.broken !== -1 && out.bases.length < target) {
    let next = null;
    let runMax = -Infinity;
    for (let i = cur.broken; i < n && i - cur.broken <= within; i++) {
      const prevMax = runMax;
      runMax = Math.max(runMax, candles[i].h);

      // (a) REJECTION BASE: candle i+1 reaches the high of candle i and closes below it
      const x = i + 1;
      const pierced = candles[i].h;
      if (x < n && x - cur.broken <= within &&
          pierced > cur.level && candles[x].h >= pierced * (1 - tol / 100) && candles[x].c < pierced) {
        const j = firstCloseAbove(pierced, x + 1);
        const held = (j === -1 ? n : j) - x;        // closes x .. j-1 stayed at/below the level
        if (held >= minDays) {
          next = { no: cur.no + 1, level: pierced, formed: i, broken: j, rejectedAt: x, type: 'Rejection' };
          break;
        }
        if (j === -1) {                              // too recent to confirm yet
          out.forming = { no: cur.no + 1, level: pierced, formed: i, rejectedAt: x, type: 'Rejection' };
          break;
        }
        // shot straight back up: not a consolidation - fall through to the peak test
      }

      // (b) PEAK PULLBACK BASE: highest high since the break, followed by two lower highs
      if (i + 1 < n && candles[i].h > prevMax && candles[i].h > cur.level &&
          candles[i + 1].h < candles[i].h && (i + 2 >= n || candles[i + 2].h < candles[i].h)) {
        const lvl = candles[i].h;
        const j = firstCloseAbove(lvl, i + 1);
        const end = j === -1 ? n : j;               // candles i+1 .. end-1 stayed under the peak
        const held = end - (i + 1);
        const needPeak = (voidFirst && cur.no === 1) ? Math.min(minDays, AB_IPOBASE_FIRST_PEAK_MIN_DAYS) : minDays;
        if (held >= needPeak) {
          next = { no: cur.no + 1, level: lvl, formed: i, broken: j, rejectedAt: -1, type: 'Peak Pullback' };
          break;
        }
        if (j === -1) {
          out.forming = { no: cur.no + 1, level: lvl, formed: i, rejectedAt: -1, type: 'Peak Pullback' };
          break;
        }
      }
    }
    if (!next) break;
    out.bases.push(next);
    cur = next;
  }
  if (voidFirst) {                                   // drop it and renumber: the next base becomes Base 1
    out.voidBase = out.bases.shift();
    out.bases.forEach(function (b) { b.no -= 1; });
    if (out.forming) out.forming.no -= 1;
  }
  const last = out.bases.length ? out.bases[out.bases.length - 1] : null;
  out.active = last && last.broken === -1 ? last : null;

  // BASE 2A (lower-high base): a swing high INSIDE Base 2 - after Base 2's
  // peak, before Base 2 breaks, higher than Base 1 and lower than Base 2.
  out.sub = null;
  if (out.bases.length >= 2 && out.bases[0].no === 1) {
    const b1 = out.bases[0], b2 = out.bases[1];
    const kb = opts.swingBars > 0 ? opts.swingBars : AB_IPOBASE_SWING_BARS;
    const to = (b2.broken === -1 ? n : b2.broken) - 1;
    for (let p = b2.formed + 1; p <= to && p + kb < n; p++) {
      const h = candles[p].h;
      if (!(h > b1.level && h < b2.level)) continue;
      let pivot = true;
      for (let k = 1; k <= kb && pivot; k++) {
        if (p - k >= 0 && candles[p - k].h >= h) pivot = false;
        if (p + k < n && candles[p + k].h >= h) pivot = false;
      }
      if (!pivot) continue;
      const j = firstCloseAbove(h, p + 1);
      const held = (j === -1 ? n : j) - (p + 1);
      if (held < minDays) continue;
      out.sub = { no: '2A', level: h, formed: p, broken: j, rejectedAt: -1, type: 'Lower High' };
      break;
    }
  }
  return out;
}

/**
 * Daily candles from each IPO's listing date to today, in ONE batched
 * GOOGLEFINANCE round-trip (same scratch-sheet method as the other
 * fetches). items = [{ sym, listing: Date }]. Returns
 * { SYMBOL: [{ d, o, h, l, c }] } oldest first; symbols with no usable
 * history are simply left out.
 */
function ab_fetchIpoCandles_(items) {
  const out = {};
  if (!items || !items.length) return out;
  const scratch = ab_getScratchSheet_();
  scratch.clearContents();
  const now = new Date();

  let total = 0;
  const jobs = items.map(function (it) {
    const days = Math.max(10, Math.ceil((now - it.listing) / 86400000) + 6);
    const job = { sym: it.sym, listing: it.listing, start: total + 1, rows: days + 2 };
    total += job.rows;
    return job;
  });
  if (scratch.getMaxRows() < total) scratch.insertRowsAfter(scratch.getMaxRows(), total - scratch.getMaxRows());
  if (scratch.getMaxColumns() < AB_BLOCK_COLS) {
    scratch.insertColumnsAfter(scratch.getMaxColumns(), AB_BLOCK_COLS - scratch.getMaxColumns());
  }

  jobs.forEach(function (j) {
    const d = j.listing;
    scratch.getRange(j.start, 1).setFormula(
      '=IFERROR(GOOGLEFINANCE("NSE:' + j.sym + '","all",DATE(' + d.getFullYear() + ',' +
      (d.getMonth() + 1) + ',' + d.getDate() + '),TODAY()),"")');
  });
  SpreadsheetApp.flush(); // one round-trip for every symbol

  const all = scratch.getRange(1, 1, total, AB_BLOCK_COLS).getValues();
  jobs.forEach(function (j) {
    const block = all.slice(j.start - 1, j.start - 1 + j.rows);
    const candles = [];
    block.forEach(function (r) {
      if (r[0] === '' || r[0] === null || String(r[0]).toLowerCase() === 'date') return;
      const o = ab_toNum_(r[1]), h = ab_toNum_(r[2]), l = ab_toNum_(r[3]), c = ab_toNum_(r[4]);
      if (isNaN(h) || isNaN(c) || h <= 0 || c <= 0) return;
      candles.push({ d: r[0], o: o, h: h, l: l, c: c });
    });
    if (candles.length) out[j.sym] = candles;
  });
  scratch.clearContents();
  return out;
}

/**
 * Adds the extra base columns to the IPOs tab header row if they are
 * missing: "IPO Base 2", "IPO Base 2A", "FVG Under Base", "Active Base", "Active Base No". Returns true
 * when it added anything (caller should re-read the layout).
 */
function ab_ensureIpoBaseColumns_(layout) {
  const wanted = [];
  if (layout.base2 === -1) wanted.push(AB_IPOBASE_BASE2_HEADER);
  if (layout.activeBase === -1) wanted.push(AB_IPOBASE_ACTIVE_HEADER);
  if (layout.activeNo === -1) wanted.push(AB_IPOBASE_ACTIVE_NO_HEADER);
  if (layout.base2a === -1) wanted.push(AB_IPOBASE_BASE2A_HEADER);
  if (layout.fvg === -1) wanted.push(AB_IPOBASE_FVG_HEADER);
  if (!wanted.length) return false;
  const sh = layout.sheet;
  const hdrRow = layout.headerRowIdx + 1;
  const hdr = layout.data[layout.headerRowIdx];
  let lastCol = 0;
  hdr.forEach(function (v, i) { if (String(v).trim() !== '') lastCol = i + 1; });
  wanted.forEach(function (title, i) {
    const target = sh.getRange(hdrRow, lastCol + 1 + i);
    try {
      sh.getRange(hdrRow, lastCol).copyTo(target, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    } catch (e) { /* formatting is cosmetic */ }
    target.setValue(title);
  });
  return true;
}

/**
 * Open FVG / Gap-up zones per symbol, read from the two zone tabs
 * (UnmitigatedFVG and GapUpFVG: A=Symbol, B=bottom, C=top, E=Formed,
 * F=Status). Returns { SYM: [{ kind, lo, hi }] }. Missing tabs are fine.
 */
function ab_openFvgZones_() {
  const out = {};
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  [[AB_UNMIT_SHEET, 'FVG'], [AB_GAPUP_SHEET, 'Gap-up']].forEach(function (pair) {
    const sh = ss.getSheetByName(pair[0]);
    if (!sh || sh.getLastRow() < 2) return;
    sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues().forEach(function (r) {
      const sym = String(r[0] || '').trim().toUpperCase();
      const lo = ab_toNum_(r[1]), hi = ab_toNum_(r[2]);
      if (!sym || isNaN(lo) || isNaN(hi) || hi <= lo) return;
      if (/^mitigated/i.test(String(r[5] || '').trim())) return;
      (out[sym] = out[sym] || []).push({ kind: pair[1], lo: lo, hi: hi });
    });
  });
  return out;
}

/**
 * Text for the "FVG Under Base" column: the open zone sitting just under
 * `level` (its top at or under the base, no more than `maxPct`% below it).
 * '' when there is none.
 */
function ab_fvgUnderBase_(zones, level, price, maxPct) {
  if (!zones || !zones.length || !(level > 0)) return '';
  let best = null;
  zones.forEach(function (z) {
    if (z.hi > level * 1.001) return;                         // not under the base
    if ((level - z.hi) / level * 100 > maxPct) return;        // too far below it
    if (!best || z.hi > best.hi) best = z;
  });
  if (!best) return '';
  const rnd = function (v) { return Math.round(v * 100) / 100; };
  let t = best.kind + ' ' + rnd(best.lo) + '-' + rnd(best.hi) + ' (' + (Math.round((level - best.hi) / level * 1000) / 10) + '% under base)';
  if (price >= best.lo && price <= best.hi * 1.005) t += ' - price at zone';
  return t;
}

/** Same number (or same text) - used so unchanged cells are not rewritten every day. */
function ab_sameCell_(a, b) {
  if (a === b) return true;
  const na = Number(a), nb = Number(b);
  if (a !== '' && b !== '' && !isNaN(na) && !isNaN(nb)) return Math.abs(na - nb) < 0.005;
  return String(a) === String(b);
}

/*
 * EARLIER RULE (kept as the fallback): listing-day high, replaced by the
 * 52-week high in two situations. Only used for symbols whose daily
 * history can't be fetched.
 */
/**
 * Decides which level is actually in force for a symbol.
 *
 * Normally it's the listing-day high. Two situations override that,
 * both only possible when the 52-week high sits ABOVE the IPO base
 * (i.e. the stock made a bigger move at some point than its listing
 * day) - otherwise the IPO base is already the highest level on record
 * and there's nothing to override it with:
 *
 *   1. RECLAIM ('52W') - price has fallen back BELOW the IPO base after
 *      that bigger move. The base to watch is the higher level it needs
 *      to reclaim, not the listing-day high it's already under.
 *      KUSUMGAR: listed, rallied, now trading under its listing-day high.
 *
 *   2. WEAK BREAKOUT ('52W-WEAK') - price is ABOVE the IPO base, but
 *      only barely (under AB_IPOBASE_WEAK_BREAKOUT_PCT), while a much
 *      higher 52-week high still exists. Clearing the listing-day high
 *      by a few percent isn't a confirmed breakout while a bigger
 *      ceiling sits untouched above it. KNACK: +10.77% over its base,
 *      but its 52W high is over 15% higher again.
 *
 * Returns { level, source } where source is 'IPO', '52W', or '52W-WEAK'.
 */
function ab_activeIpoBase_(ipoBase, high52, price) {
  if (isNaN(high52) || high52 <= ipoBase) {
    return { level: ipoBase, source: 'IPO' };
  }
  if (price < ipoBase) {
    return { level: high52, source: '52W' };
  }
  const weakCeiling = ipoBase * (1 + AB_IPOBASE_WEAK_BREAKOUT_PCT / 100);
  if (price < weakCeiling) {
    return { level: high52, source: '52W-WEAK' };
  }
  return { level: ipoBase, source: 'IPO' };
}

/**
 * Daily pass: distance from today's price to each symbol's ACTIVE base,
 * plus the status text - and returns the rows worth emailing about.
 *
 * Every IPO with a listing date uses the candle rule above (Base 1, Base 2
 * ...), newest listings first. Daily history is fetched in chunks with a
 * time budget; a symbol that could not be fetched this time is left as it
 * was (if it already had a candle-rule status) or falls back to the
 * earlier listing-high / 52-week-high logic, so nothing goes blank.
 * Alerts still only go out for listings younger than
 * AB_IPOBASE_ALERT_MAX_AGE_DAYS.
 *
 * A breakout is flagged when a base closed-above happened in the last two
 * candles AND yesterday's status wasn't already "Above Base" (that second
 * check stops a re-run on the same day from alerting twice).
 */
function updateIpoBaseStatus_() {
  let layout = ab_getIpoSheetLayout_();
  const alerts = { approaching: [], brokeOut: [] };
  if (layout.base === -1) return alerts;
  try {
    if (ab_ensureIpoBaseColumns_(layout)) layout = ab_getIpoSheetLayout_();
  } catch (e) {
    Logger.log('Could not add the base columns: ' + e.message);
  }

  const data = layout.data;
  const now = new Date();
  const maxAgeMs = AB_IPOBASE_ALERT_MAX_AGE_DAYS > 0 ? AB_IPOBASE_ALERT_MAX_AGE_DAYS * 86400000 : 0;

  // Rows we can actually evaluate.
  const live = [];
  for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
    const sym = ab_cellText_(data[r][layout.symbol]).toUpperCase();
    if (!sym) continue;
    const base = ab_screenerNum_(data[r][layout.base]);
    if (isNaN(base) || base <= 0) continue;
    const price = layout.marketPrice !== -1 ? ab_screenerNum_(data[r][layout.marketPrice]) : NaN;
    if (isNaN(price) || price <= 0) continue; // e.g. #N/A on a brand-new listing
    const listing = layout.listingDate !== -1 ? ab_parseDate_(data[r][layout.listingDate]) : null;
    live.push({ r: r, sym: sym, base: base, price: price, listing: listing });
  }
  if (!live.length) return alerts;

  // Daily candle history, newest listings first, in chunks with a time budget.
  const prevStatusOf = function (x) {
    return layout.baseStatus !== -1 ? ab_cellText_(data[x.r][layout.baseStatus]) : '';
  };
  const byRule = function (st) { return /Base \d|^Waiting for next base/.test(st); };
  const wantCandles = live.filter(function (x) { return x.listing; })
    .sort(function (a, b) { return b.listing - a.listing; });
  const candles = {};
  const t0 = Date.now();
  for (let i = 0; i < wantCandles.length; i += AB_IPOBASE_FETCH_CHUNK) {
    if (Date.now() - t0 > AB_IPOBASE_FETCH_BUDGET_MS) {
      Logger.log('IPO candle fetch: time budget used up after ' + i + ' of ' + wantCandles.length + ' symbols.');
      break;
    }
    try {
      const got = ab_fetchIpoCandles_(wantCandles.slice(i, i + AB_IPOBASE_FETCH_CHUNK)
        .map(function (x) { return { sym: x.sym, listing: x.listing }; }));
      Object.keys(got).forEach(function (k) { candles[k] = got[k]; });
    } catch (e) {
      Logger.log('IPO candle history chunk failed: ' + e.message);
    }
  }
  const usable = function (x) { return candles[x.sym] && candles[x.sym].length >= 2; };
  // Rows that already carry a candle-rule status keep it when this run could not fetch them.
  const keepAsIs = function (x) { return !usable(x) && byRule(prevStatusOf(x)); };

  // 52-week highs only for the rows still on the earlier rule.
  const highs = ab_fetch52WeekHighs_(live.filter(function (x) { return !usable(x) && !keepAsIs(x); })
    .map(function (x) { return x.sym; }));

  let fvgZones = {};
  try { fvgZones = ab_openFvgZones_(); } catch (e) { Logger.log('FVG zones skipped: ' + e.message); }

  const put = function (r, c, value) {
    if (c === -1 || c === undefined) return;
    if (ab_sameCell_(data[r][c], value)) return;
    layout.sheet.getRange(r + 1, c + 1).setValue(value);
  };

  live.forEach(function (x) {
    const r = x.r, sym = x.sym, price = x.price;
    const prevStatus = layout.baseStatus !== -1 ? ab_cellText_(data[r][layout.baseStatus]) : '';
    const ageOk = !(maxAgeMs && x.listing && (now - x.listing) > maxAgeMs);
    const wasAbove = /^Above Base/.test(prevStatus);
    const baseInfo = function (level, no, source) {
      return { symbol: sym, base: level, baseNo: no, price: price,
               gap: (price - level) / level * 100, source: source, ipoBase: x.base,
               chartUrl: ab_chartUrl_(sym), screenerUrl: ab_screenerUrl_(sym) };
    };

    if (keepAsIs(x)) return;

    if (usable(x)) {
      // ---- candle rule: Base 1, Base 2 ... ----
      const cs = candles[sym];
      const seq = ab_ipoBaseSequence_(cs, x.base, AB_IPOBASE_MAX_BASES);
      const lastBase = seq.bases[seq.bases.length - 1];
      if (!seq.bases.length) {                      // listing high dropped and no real base found yet
        put(r, layout.baseGap, '');
        put(r, layout.baseStatus, 'Waiting for next base (listing high broken on day 2)');
        put(r, layout.base2, ''); put(r, layout.base2a, ''); put(r, layout.activeBase, ''); put(r, layout.activeNo, '');
        put(r, layout.fvg, '');
        return;
      }
      const sub = seq.sub;
      const subOpen = !!(sub && sub.broken === -1);
      let ref = seq.active || lastBase;             // the level price is measured against
      if (subOpen && (!seq.active || sub.level < seq.active.level)) ref = sub;   // Base 2A is nearer
      const hasOpen = !!(seq.active || subOpen);
      const gap = (price - ref.level) / ref.level * 100;

      let status;
      if (hasOpen) {
        status = (gap >= 0 ? 'Above Base' : gap >= -AB_IPOBASE_NEAR_PCT ? 'Near Base' : 'Below Base') +
                 ' ' + ref.no;
      } else {
        const forming = seq.forming ? ', Base ' + seq.forming.no + ' forming' : '';
        status = gap >= 0 ? 'Above Base (Base ' + lastBase.no + ' cleared' + forming + ')'
                          : 'Waiting for next base (Base ' + lastBase.no + ' cleared' + forming + ')';
      }

      put(r, layout.baseGap, Math.round(gap * 100) / 100);
      put(r, layout.baseStatus, status);
      put(r, layout.base2, seq.bases.length > 1 ? Math.round(seq.bases[1].level * 100) / 100 : '');
      const fvgNote = hasOpen ? ab_fvgUnderBase_(fvgZones[sym], ref.level, price, AB_IPOBASE_FVG_MAX_PCT) : '';
      put(r, layout.fvg, fvgNote);
      put(r, layout.base2a, sub ? Math.round(sub.level * 100) / 100 : '');
      put(r, layout.activeBase, hasOpen ? Math.round(ref.level * 100) / 100 : '');
      put(r, layout.activeNo, hasOpen ? ref.no : '');

      if (!ageOk) return;
      const brokeLately = seq.bases.concat(sub ? [sub] : [])
        .filter(function (b) { return b.broken !== -1 && b.broken >= cs.length - 2; });
      if (brokeLately.length && prevStatus && !wasAbove) {
        const b = brokeLately[brokeLately.length - 1];
        alerts.brokeOut.push(baseInfo(b.level, b.no, 'BASE'));
      } else if (hasOpen && /^Near Base/.test(status)) {
        const info = baseInfo(ref.level, ref.no, 'BASE');
        info.fvg = fvgNote;
        alerts.approaching.push(info);
      }
      return;
    }

    // ---- earlier rule (listing-day high, 52-week high override) ----
    const high52 = highs[sym];
    const active = ab_activeIpoBase_(x.base, high52, price);
    const base = active.level;
    const gap = (price - base) / base * 100;       // negative = still below

    let status;
    if (gap >= 0) status = 'Above Base';
    else if (gap >= -AB_IPOBASE_NEAR_PCT) status = 'Near Base';
    else status = 'Below Base';
    if (active.source === '52W') status += ' (52W)';
    else if (active.source === '52W-WEAK') status += ' (52W - Weak Breakout)';

    put(r, layout.baseGap, Math.round(gap * 100) / 100);
    put(r, layout.baseStatus, status);
    if (!isNaN(high52)) put(r, layout.high52, Math.round(high52 * 100) / 100);
    put(r, layout.activeBase, Math.round(base * 100) / 100);
    put(r, layout.activeNo, '');
    const legacyFvg = ab_fvgUnderBase_(fvgZones[sym], base, price, AB_IPOBASE_FVG_MAX_PCT);
    put(r, layout.fvg, legacyFvg);

    if (!ageOk) return;
    const info = baseInfo(base, '', active.source);
    info.fvg = legacyFvg;
    info.source = active.source;
    if (/^Above Base/.test(status) && prevStatus && !wasAbove) {
      alerts.brokeOut.push(info);   // crossed the level today
    } else if (/^Near Base/.test(status)) {
      alerts.approaching.push(info); // the heads-up you actually want
    }
  });

  // Closest to the base first - those are the most actionable.
  alerts.approaching.sort(function (a, b) { return b.gap - a.gap; });
  return alerts;
}

/** EOD email: who's approaching their IPO base, and who just broke it. */
function sendIpoBaseEmail_(alerts) {
  if (!alerts || (!alerts.approaching.length && !alerts.brokeOut.length)) return;
  const ts = Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy');

  function card(f, accent) {
    const byRule = f.source === 'BASE';
    const uses52W = f.source === '52W' || f.source === '52W-WEAK';
    const badge = byRule ? 'BASE ' + f.baseNo
                : f.source === '52W' ? '52W HIGH BASE'
                : f.source === '52W-WEAK' ? 'WEAK BREAKOUT - 52W BASE' : '';
    const origLabel = f.source === '52W'
      ? 'Original IPO base (now below price action)'
      : 'IPO base already cleared (but only by ' + AB_IPOBASE_WEAK_BREAKOUT_PCT + '%, so it\'s not the real ceiling)';
    const baseLabel = byRule
      ? 'Base ' + f.baseNo + (f.baseNo === 1 ? ' (listing-day high)' : f.baseNo === '2A' ? ' (lower high inside Base 2)' : ' (high that turned price back)')
      : (uses52W ? 'Active base (52-week high)' : 'IPO Base (listing-day high)');
    return '<div style="border:1px solid #e2e2e2;border-left:5px solid ' + accent +
      ';border-radius:8px;padding:10px 14px;margin-bottom:10px;">' +
      '<div style="font-size:17px;font-weight:700;color:#111;">' + f.symbol +
      (badge ? '<span style="font-size:11px;font-weight:600;color:#7a4fd0;' +
        'background:#f1ecfb;border-radius:4px;padding:2px 6px;margin-left:8px;">' + badge + '</span>' : '') +
      '</div>' +
      '<table style="border-collapse:collapse;font-size:13px;margin-top:4px;">' +
      '<tr><td style="color:#666;padding:2px 12px 2px 0;">' +
      baseLabel + '</td>' +
      '<td style="font-weight:600;">' + f.base + '</td></tr>' +
      (uses52W
        ? '<tr><td style="color:#666;padding:2px 12px 2px 0;">' + origLabel + '</td>' +
          '<td style="color:#888;">' + f.ipoBase + '</td></tr>'
        : '') +
      '<tr><td style="color:#666;padding:2px 12px 2px 0;">Price now</td>' +
      '<td style="font-weight:600;">' + f.price + '</td></tr>' +
      '<tr><td style="color:#666;padding:2px 12px 2px 0;">Distance to base</td>' +
      '<td style="font-weight:700;color:' + accent + ';">' +
      (f.gap >= 0 ? '+' : '') + f.gap.toFixed(2) + '%</td></tr>' +
      (f.fvg ? '<tr><td style="color:#666;padding:2px 12px 2px 0;">Open zone under base</td>' +
               '<td style="font-weight:600;color:#7a4fd0;">' + f.fvg + '</td></tr>' : '') +
      '</table>' +
      '<div style="margin-top:8px;">' +
      '<a href="' + f.chartUrl + '" style="padding:6px 12px;background:' + accent +
      ';color:#fff;border-radius:5px;text-decoration:none;font-size:12px;font-weight:600;">View Chart</a>' +
      '<a href="' + f.screenerUrl + '" style="margin-left:8px;padding:6px 12px;background:#333;' +
      'color:#fff;border-radius:5px;text-decoration:none;font-size:12px;font-weight:600;">Screener</a>' +
      '</div></div>';
  }

  let html = '<div style="font-family:Arial,Helvetica,sans-serif;">';
  html += '<h2 style="margin:0 0 2px;">IPO Base Watch</h2>';
  html += '<div style="color:#777;font-size:13px;margin-bottom:14px;">' + ts + ' &middot; Base 1 = listing-day high (unless candle 2 closed above it) &middot; later bases = rally peaks / rejection highs</div>';

  if (alerts.brokeOut.length) {
    html += '<h3 style="margin:12px 0 6px;color:#0a8f4f;">Closed above a base (' +
            alerts.brokeOut.length + ')</h3>';
    alerts.brokeOut.forEach(function (f) { html += card(f, '#0a8f4f'); });
  }
  if (alerts.approaching.length) {
    html += '<h3 style="margin:12px 0 6px;color:#c77700;">Approaching the base from below (' +
            alerts.approaching.length + ')</h3>';
    alerts.approaching.forEach(function (f) { html += card(f, '#c77700'); });
  }
  html += '<div style="color:#999;font-size:12px;margin-top:10px;">' +
          'Within ' + AB_IPOBASE_NEAR_PCT + '% below the base counts as approaching. ' +
          'Full list with distances is in the "' + AB_IPO_SHEET + '" tab.</div></div>';

  let text = 'IPO Base Watch - ' + ts + '\n\n';
  alerts.brokeOut.forEach(function (f) {
    text += 'BROKE OUT: ' + f.symbol + ' base ' + f.base + ', now ' + f.price +
            ' (' + f.gap.toFixed(2) + '%)\n'; });
  alerts.approaching.forEach(function (f) {
    text += 'APPROACHING: ' + f.symbol + ' base ' + f.base + ', now ' + f.price +
            ' (' + f.gap.toFixed(2) + '%)\n'; });

  try {
    ab_sendMail_({
      to: AB_EMAIL_TO,
      subject: 'IPO Base Watch - ' + alerts.brokeOut.length + ' broke out, ' +
               alerts.approaching.length + ' approaching (' + ts + ')',
      body: text, htmlBody: html
    });
  } catch (e) {
    Logger.log('IPO base email failed: ' + e.message);
  }
}

/** Menu: compute any missing bases, refresh statuses, email the watchlist. */
function runIpoBaseWatchNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const filled = computeIpoBases_();
    const alerts = updateIpoBaseStatus_();
    sendIpoBaseEmail_(alerts);
    ss.toast('IPO base watch: ' + filled + ' new base(s) computed, ' +
             alerts.approaching.length + ' approaching, ' + alerts.brokeOut.length + ' broke out.');
  } catch (e) {
    ss.toast('IPO base watch failed: ' + e.message);
  }
}

/*****************************************************************
 * IPO BASE - LIVE (INTRADAY) ALERTS
 * -----------------------------------------------------------------
 * The 7 PM "IPO Base Watch" email judges by the CLOSE. This is the live
 * companion that rides the 5-minute trigger during market hours:
 *   - APPROACHING: price is under the Active Base, within
 *     AB_IPOBASE_NEAR_PCT %.
 *   - ABOVE (not confirmed): price is trading above the Active Base.
 *     A base only counts as broken when a daily candle CLOSES above it, so
 *     the evening email is the confirmation.
 * The Active Base (and its number) come from the IPOs tab columns that the
 * daily pass fills, so a base is only watched live once the daily pass has
 * worked it out. Price is the IPOs tab's MarketPrice column.
 * Each symbol alerts at most once per day per type (kept in script
 * properties, reset every new day). Setting AB_IPOBASE_INTRADAY_ON = 0 turns it off.
 *****************************************************************/
const AB_IPOBASE_INTRA_PROP_ = 'AB_IPOBASE_INTRADAY_STATE';

/** Number from a cell, NaN for blank / text. */
function ab_ipoCellNum_(v) {
  if (v === '' || v === null || v === undefined) return NaN;
  const n = Number(v);
  return isNaN(n) ? NaN : n;
}

/**
 * Finds live approaches / above-base moves. opts.force skips the market-hours gate and the
 * once-a-day memory (used by the menu test). Returns { near: [], above: [] }.
 */
function checkIpoBaseIntraday_(opts) {
  const force = !!(opts && opts.force);
  const out = { near: [], above: [] };
  if (!AB_IPOBASE_INTRADAY_ON && !force) return out;
  if (!force && !ab_isMarketHours_()) return out;

  const L = ab_getIpoSheetLayout_();
  if (L.symbol === -1 || L.activeBase === -1 || L.marketPrice === -1) return out;

  const props = PropertiesService.getScriptProperties();
  const todayStr = Utilities.formatDate(new Date(), AB_TZ, 'yyyy-MM-dd');
  let state = { date: todayStr, sent: {} };
  if (!force) {
    try {
      const saved = JSON.parse(props.getProperty(AB_IPOBASE_INTRA_PROP_) || 'null');
      if (saved && saved.date === todayStr && saved.sent) state = saved;
    } catch (e) { Logger.log('IPO base intraday state unreadable, starting fresh: ' + e.message); }
  }

  const maxAgeMs = AB_IPOBASE_ALERT_MAX_AGE_DAYS > 0 ? AB_IPOBASE_ALERT_MAX_AGE_DAYS * 86400000 : 0;
  const now = new Date();
  let changed = false;

  for (let r = L.headerRowIdx + 1; r < L.data.length; r++) {
    const row = L.data[r];
    const sym = ab_cellText_(row[L.symbol]).toUpperCase();
    if (!sym) continue;
    const base = ab_ipoCellNum_(row[L.activeBase]);
    const price = ab_ipoCellNum_(row[L.marketPrice]);
    if (isNaN(base) || base <= 0 || isNaN(price) || price <= 0) continue;
    if (maxAgeMs && L.listingDate !== -1) {
      const ld = row[L.listingDate];
      if (ld instanceof Date && now.getTime() - ld.getTime() > maxAgeMs) continue;
    }
    const gapPct = (price - base) / base * 100;
    const noRaw = L.activeNo !== -1 ? ab_cellText_(row[L.activeNo]) : '';
    const item = {
      symbol: sym, base: base, price: price, gapPct: gapPct,
      baseNo: noRaw || '',
      fvg: L.fvg !== -1 ? ab_cellText_(row[L.fvg]) : '',
      chartUrl: ab_chartUrl_(sym), screenerUrl: ab_screenerUrl_(sym)
    };

    if (price > base) {
      const k = sym + '|above';
      if (force || !state.sent[k]) { out.above.push(item); state.sent[k] = 1; state.sent[sym + '|near'] = 1; changed = true; }
    } else if (gapPct >= -AB_IPOBASE_NEAR_PCT) {
      const k = sym + '|near';
      if (force || !state.sent[k]) { out.near.push(item); state.sent[k] = 1; changed = true; }
    }
  }

  if (changed && !force) {
    try { props.setProperty(AB_IPOBASE_INTRA_PROP_, JSON.stringify(state)); }
    catch (e) { Logger.log('IPO base intraday state not saved: ' + e.message); }
  }
  return out;
}

/** Emails + pushes the live IPO base alerts. */
function sendIpoBaseIntradayEmail_(alerts) {
  if (!alerts || (!alerts.near.length && !alerts.above.length)) return false;
  const ts = Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm');
  const td = 'style="padding:6px 10px;border-bottom:1px solid #eee;font-size:13px"';

  function card(f, above) {
    const accent = above ? '#0a8f4f' : '#c77700';
    const bg = above ? '#eafaf1' : '#fff8e1';
    const label = f.baseNo ? 'BASE ' + f.baseNo : 'BASE';
    let h = '<div style="border:1px solid #e2e2e2;border-radius:10px;overflow:hidden;margin-bottom:14px">';
    h += '<div style="background:' + bg + ';padding:12px 14px;border-left:5px solid ' + accent + '">';
    h += '<div style="font-size:11px;letter-spacing:0.5px;font-weight:700;color:' + accent + '">' +
         (above ? 'TRADING ABOVE THE BASE - NOT CONFIRMED UNTIL THE CLOSE' : 'APPROACHING THE BASE') +
         ' &middot; ' + label + '</div>';
    h += '<div style="font-size:18px;font-weight:700;color:#111">' + f.symbol + '</div></div>';
    h += '<table style="width:100%;border-collapse:collapse">';
    h += '<tr><td ' + td + '>Active base</td><td ' + td + ' align="right"><b>' + ab_num2_(f.base) + '</b></td></tr>';
    h += '<tr><td ' + td + '>Price now</td><td ' + td + ' align="right"><b>' + ab_num2_(f.price) + '</b></td></tr>';
    h += '<tr><td ' + td + '>' + (above ? 'Above the base by' : 'Distance to base') + '</td><td ' + td +
         ' align="right"><span style="color:' + accent + ';font-weight:bold">' + ab_pct2_(f.gapPct) + '</span></td></tr>';
    if (f.fvg) h += '<tr><td ' + td + '>Open zone under base</td><td ' + td + ' align="right">' + f.fvg + '</td></tr>';
    h += '</table><div style="padding:10px 14px;background:#fafafa;border-top:1px solid #eee">';
    h += '<a href="' + f.chartUrl + '" style="display:inline-block;margin-right:8px;padding:7px 12px;background:' + accent +
         ';color:#fff;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600">View Chart</a>';
    h += '<a href="' + f.screenerUrl + '" style="display:inline-block;padding:7px 12px;background:#333;color:#fff;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600">Screener.in</a>';
    h += '</div></div>';
    return h;
  }

  let html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:620px">';
  html += '<h2 style="margin:0 0 2px">IPO Base - live alert</h2>';
  html += '<p style="margin:0 0 16px;color:#5f6368;font-size:13px">' + ts + ' IST &middot; live price, not the close</p>';
  if (alerts.above.length) {
    html += '<h3 style="margin:10px 0 6px;color:#0a8f4f">Trading above the base (' + alerts.above.length + ')</h3>';
    alerts.above.forEach(function (f) { html += card(f, true); });
  }
  if (alerts.near.length) {
    html += '<h3 style="margin:10px 0 6px;color:#c77700">Approaching the base (' + alerts.near.length + ')</h3>';
    alerts.near.forEach(function (f) { html += card(f, false); });
  }
  html += '<p style="margin:8px 0 0;color:#5f6368;font-size:11px">A base counts as broken only when a daily candle CLOSES above it. ' +
          'Today\'s 7 PM IPO Base Watch email confirms it. Approaching = within ' + AB_IPOBASE_NEAR_PCT +
          '% below the base. Each symbol alerts once a day per type.</p></div>';

  let text = 'IPO Base - live alert (' + ts + ')\n\n';
  alerts.above.forEach(function (f) {
    text += '[ABOVE - close not confirmed] ' + f.symbol + ' ' + ab_num2_(f.price) + ' vs base ' + ab_num2_(f.base) +
            ' (' + ab_pct2_(f.gapPct) + ')\n  Chart: ' + f.chartUrl + '\n\n';
  });
  alerts.near.forEach(function (f) {
    text += '[NEAR] ' + f.symbol + ' ' + ab_num2_(f.price) + ' vs base ' + ab_num2_(f.base) +
            ' (' + ab_pct2_(f.gapPct) + ')\n  Chart: ' + f.chartUrl + '\n\n';
  });

  const names = alerts.above.map(function (f) { return f.symbol + ' above'; })
        .concat(alerts.near.map(function (f) { return f.symbol + ' near'; })).join(', ');
  let sent = false;
  try {
    ab_sendMail_({ to: AB_EMAIL_TO, subject: 'IPO Base live - ' + names + ' (' + ts + ')', body: text, htmlBody: html });
    sent = true;
  } catch (e) { Logger.log('IPO base live email failed: ' + e.message); }
  try { ab_sendPushbullet_('IPO Base live - ' + names, text); }
  catch (pe) { Logger.log('IPO base live push failed: ' + pe.message); }
  return sent;
}

/** Menu: run the live check right now (ignores market hours and the once-a-day memory). */
function runIpoBaseIntradayNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const a = checkIpoBaseIntraday_({ force: true });
    if (!a.near.length && !a.above.length) {
      ss.toast('No IPO is within ' + AB_IPOBASE_NEAR_PCT + '% below its active base, and none is trading above one, at the current MarketPrice.', 'IPO Base live', 12);
      return;
    }
    sendIpoBaseIntradayEmail_(a);
    ss.toast(a.near.length + ' approaching, ' + a.above.length + ' above - email sent.', 'IPO Base live', 12);
  } catch (e) {
    ss.toast('IPO base live check failed: ' + e.message);
  }
}

/** Menu: refresh every IPO's base columns and status - no email. */
function runRefreshIpoBases() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const filled = computeIpoBases_();
    const alerts = updateIpoBaseStatus_();
    ss.toast('IPO bases refreshed: ' + filled + ' new Base 1 computed, ' +
             alerts.approaching.length + ' approaching, ' + alerts.brokeOut.length + ' broke out. ' +
             'No email sent.', 'IPO Bases', 15);
  } catch (e) {
    ss.toast('IPO base refresh failed: ' + e.message);
  }
}

/**
 * Menu: type a symbol, see its bases exactly as the script reads them -
 * level, the candle date it comes from, the rejection date, and when
 * (if ever) a candle closed above it. Handy for checking against a
 * chart you marked by hand.
 */
function runIpoBaseExplain() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const resp = ui.prompt('IPO bases for a symbol', 'NSE symbol from the IPOs tab (for example CPPLUS):', ui.ButtonSet.OK_CANCEL);
    if (resp.getSelectedButton() !== ui.Button.OK) return;
    const sym = String(resp.getResponseText() || '').trim().toUpperCase();
    if (!sym) return;

    const layout = ab_getIpoSheetLayout_();
    let listing = null, stored = NaN;
    for (let r = layout.headerRowIdx + 1; r < layout.data.length; r++) {
      if (ab_cellText_(layout.data[r][layout.symbol]).toUpperCase() !== sym) continue;
      listing = layout.listingDate !== -1 ? ab_parseDate_(layout.data[r][layout.listingDate]) : null;
      stored = layout.base !== -1 ? ab_screenerNum_(layout.data[r][layout.base]) : NaN;
      break;
    }
    if (!listing) { ui.alert('IPO bases', sym + ' was not found in the ' + AB_IPO_SHEET + ' tab (or has no listing date).', ui.ButtonSet.OK); return; }

    const cs = ab_fetchIpoCandles_([{ sym: sym, listing: listing }])[sym];
    if (!cs || cs.length < 2) { ui.alert('IPO bases', 'No daily price history came back for ' + sym + '.', ui.ButtonSet.OK); return; }

    const seq = ab_ipoBaseSequence_(cs, stored, AB_IPOBASE_MAX_BASES);
    const fmt = function (i) { return Utilities.formatDate(ab_parseDate_(cs[i].d) || new Date(cs[i].d), AB_TZ, 'dd-MMM-yyyy'); };
    const lines = ['Listing: ' + fmt(0) + '   (' + cs.length + ' daily candles read)', ''];
    if (seq.voidBase) {
      lines.push('Listing-day high ' + (Math.round(seq.voidBase.level * 100) / 100) + ' is NOT a base - the next candle closed above it (' + fmt(seq.voidBase.broken) + ').');
    }
    seq.bases.forEach(function (b) {
      let t = 'Base ' + b.no + ': ' + (Math.round(b.level * 100) / 100) + '  - high of ' + fmt(b.formed);
      if (b.type) t += '  [' + b.type + ' base]';
      if (b.rejectedAt !== -1) t += ' (rejected on ' + fmt(b.rejectedAt) + ')';
      t += b.broken !== -1 ? '\n      broken: closed above on ' + fmt(b.broken) : '\n      NOT broken yet';
      lines.push(t);
    });
    if (seq.sub) {
      let t = 'Base 2A: ' + (Math.round(seq.sub.level * 100) / 100) + '  - high of ' + fmt(seq.sub.formed) + '  [Lower High base, inside Base 2]';
      t += seq.sub.broken !== -1 ? '\n      broken: closed above on ' + fmt(seq.sub.broken) : '\n      NOT broken yet';
      lines.push(t);
    }
    if (seq.forming) {
      lines.push('Base ' + seq.forming.no + ' forming: ' + (Math.round(seq.forming.level * 100) / 100) +
                 ' [' + seq.forming.type + ' base]' + (seq.forming.rejectedAt !== -1 ? ' (rejected on ' + fmt(seq.forming.rejectedAt) + ')' : '') +
                 ' - counts once price has stayed under it for ' +
                 AB_IPOBASE_MIN_CONSOL_DAYS + ' closes.');
    }
    const last = cs[cs.length - 1];
    lines.push('', 'Last close ' + (Math.round(last.c * 100) / 100) + ' on ' + fmt(cs.length - 1));
    const subOpen = seq.sub && seq.sub.broken === -1;
    const nearest = subOpen && (!seq.active || seq.sub.level < seq.active.level) ? seq.sub : seq.active;
    lines.push(nearest ? 'Active base: Base ' + nearest.no + ' at ' + (Math.round(nearest.level * 100) / 100)
                          : 'No active base - all bases found are broken; the next one forms after a rejection candle or a rally peak.');
    ui.alert('IPO bases - ' + sym, lines.join('\n'), ui.ButtonSet.OK);
  } catch (e) {
    ss.toast('IPO base explain failed: ' + e.message);
  }
}

/** Menu entry point - runs the IPO sync on demand and reports the result. */
function runIpoSyncNow() {
  let added = [];
  try {
    added = syncNewIposFromChittorgarh_();
  } catch (e) {
    SpreadsheetApp.getActiveSpreadsheet().toast('IPO sync failed: ' + e.message);
    return;
  }
  SpreadsheetApp.getActiveSpreadsheet().toast(
    added.length ? ('Added ' + added.length + ' new IPO(s): ' + added.join(', ')) : 'No new IPOs found.');
}

/*****************************************************************
 * SME STOCKS -> IPOs TAB
 * -----------------------------------------------------------------
 * Adds NSE SME stocks listed on/after AB_SME_FROM (01/01/2025) that are
 * ALREADY IN THE MAIN SHEET (so GOOGLEFINANCE has their prices) to the
 * IPOs tab: symbol + listing date, with the same live formula columns
 * (MarketPrice, % change, Below/Above ...) copied from the last row.
 * Symbols already in the IPOs tab are skipped, so it is safe to run
 * again any time.
 *
 * Where the list comes from:
 *   1. the "SME List" tab, if you paste NSE's SME_EQUITY_L.csv there
 *      (needs the SYMBOL and DATE_OF_LISTING columns), otherwise
 *   2. the list built into the script (NSE file downloaded 10-Oct-2026).
 * LISTING PRICE is filled from Chittorgarh's SME issue price when it
 * can be fetched; otherwise it is left blank.
 *****************************************************************/
const AB_SME_FROM = new Date(2025, 0, 1);
const AB_SME_PASTE_SHEET = 'SME List';
const AB_SME_SEED_ = [
  'ANYA|2025-01-02', 'DELTIC|2025-01-14', 'SATKARTAR|2025-01-17', 'BARFLEX|2025-01-20',
  'KKJEWELS|2025-01-22', 'EMAPARTNER|2025-01-24', 'REXPRO|2025-01-29', 'CHAMUNDA|2025-02-11',
  'KEN|2025-02-12', 'READYMIX|2025-02-13', 'ELGNZ|2025-02-14', 'CHANDAN|2025-02-17',
  'MAXVOLT|2025-02-19', 'PSRAJ|2025-02-19', 'VOLERCAR|2025-02-19', 'ROYALARC|2025-02-24',
  'TEJASCARGO|2025-02-24', 'HPTL|2025-02-28', 'BALAJIPHOS|2025-03-07', 'DIVINEHIRA|2025-03-24',
  'GCHOTELS|2025-03-27', 'ACTIVEINFR|2025-03-28', 'RAPIDFLEET|2025-03-28', 'ATCENERGY|2025-04-02',
  'SHRIAHIMSA|2025-04-02', 'TANKUP|2025-04-30', 'IWARE|2025-05-06', 'ARUNAYA|2025-05-07',
  'VGINFOTECH|2025-05-19', 'INTEGRITY|2025-05-20', 'ACCPL|2025-05-21', 'DCCL|2025-05-28',
  'BLUEWATER|2025-06-03', 'NIKITA|2025-06-03', 'NEPTUNE|2025-06-04', 'NRVANDANA|2025-06-04',
  'GANGABATH|2025-06-11', 'SACHEEROME|2025-06-16', 'JAINIK|2025-06-17', 'MONOLITH|2025-06-19',
  'PATILAUTOM|2025-06-23', 'SAMAY|2025-06-23', 'EEPL|2025-06-24', 'INFLUX|2025-06-25',
  'AAKAAR|2025-06-27', 'MAYASHEEL|2025-06-27', 'SAFEENTP|2025-06-27', 'SHKSIL|2025-07-01',
  'RTL|2025-07-02', 'SUNTECH|2025-07-02', 'MMEL|2025-07-03', 'PROFX|2025-07-03',
  'CEDAAR|2025-07-07', 'PUSHPA|2025-07-07', 'SILKY|2025-07-07', 'ETL|2025-07-08',
  'WHITEFORCE|2025-07-10', 'SMARTEN|2025-07-14', 'SPUNWEB|2025-07-21', 'SAVY|2025-07-28',
  'TSC|2025-07-30', 'SELLOWRAP|2025-08-01', 'KAYTEX|2025-08-05', 'CUDML|2025-08-07',
  'RNPL|2025-08-07', 'FLYSBS|2025-08-08', 'AARADHYA|2025-08-11', 'BHADORA|2025-08-11',
  'JYOTIGLOBL|2025-08-11', 'PARTH|2025-08-11', 'CONNPLEX|2025-08-14', 'SAWALIYA|2025-08-14',
  'AMCL|2025-08-18', 'MEDISTEP|2025-08-18', 'MRIL|2025-08-20', 'STUDIOLSD|2025-08-25',
  'ARCIIL|2025-08-29', 'ANONDITA|2025-09-01', 'CLASSICEIL|2025-09-01', 'SHIVASHRIT|2025-09-01',
  'CURRENT|2025-09-03', 'SATTVAENGG|2025-09-03', 'SNEHAA|2025-09-05', 'OPTIVALUE|2025-09-10',
  'VIGOR|2025-09-12', 'TAURIAN|2025-09-16', 'GML|2025-09-17', 'TECHD|2025-09-22',
  'SIDDHICOTS|2025-09-26', 'PRIMECAB|2025-09-29', 'ECOLINE|2025-09-30', 'MGSL|2025-09-30',
  'GURUNANAK|2025-10-01', 'MPEL|2025-10-06', 'SUBAHOTELS|2025-10-07', 'VIJAYPD|2025-10-07',
  'BAGDIGITAL|2025-10-08', 'MUNISH|2025-10-08', 'SHEEL|2025-10-08', 'GREENLEAF|2025-10-09',
  'JAYESH|2025-11-03', 'SHETHJI|2025-11-12', 'FINBUD|2025-11-13', 'CURIS|2025-11-14',
  'CSSL|2025-12-08', 'INVICTA|2025-12-08', 'SPEB|2025-12-08', 'NEOCHEM|2025-12-09',
  'SHRIKANHA|2025-12-10', 'ENCOMPAS|2025-12-12', 'FWSTC|2025-12-12', 'ASHWINI|2025-12-19',
  'EXIMROUTES|2025-12-19', 'MARC|2025-12-24', 'EPWINDIA|2025-12-30', 'SHYAMDHANI|2025-12-30',
  'SOCL|2025-12-30', 'DHARARAIL|2025-12-31', 'E2ERAIL|2026-01-02', 'VICTORYEV|2026-01-14',
  'AVANA|2026-01-20', 'ARMOUR|2026-01-22', 'KRMAYURVED|2026-01-29', 'CKKRETAIL|2026-02-06',
  'BRANDMAN|2026-02-11', 'GJL|2026-02-11', 'BIOPOL|2026-02-13', 'MARUSHIKA|2026-02-19',
  'MANILAM|2026-02-27', 'MOBILISE|2026-03-02', 'YAAP|2026-03-05', 'STRIDERS|2026-03-06',
  'ACETEC|2026-03-09', 'SPCON|2026-03-13', 'APSISAERO|2026-03-18', 'VIVIDEL|2026-04-07',
  'ADISOFT|2026-04-30', 'AMBAAUTO|2026-05-05', 'VALUE360|2026-05-11', 'SIMCA|2026-05-15',
  'RFBL|2026-05-19', 'NFPSAMPOOR|2026-05-25', 'TEAMTECH|2026-05-26', 'BMLL|2026-05-29',
  'QLINE|2026-05-29', 'GENXAI|2026-06-12', 'UTKAL|2026-06-17', 'CLAYCRAFT|2026-06-24',
  'AVIENCE|2026-06-25', 'SHREEDHAR|2026-07-01', 'TEJA|2026-07-07', 'VMOBILE|2026-07-07',
  'ICELCO|2026-07-10', 'HAPPY|2026-07-16', 'METALIC|2026-07-28', 'PROPSHOP|2026-08-03',
  'ANAWIL|2026-08-10', 'OPTIMYSTIX|2026-08-14', 'PRAMODINI|2026-08-19', 'CREDENT|2026-08-20',
  'SKYTECH|2026-08-21', 'FASCINATE|2026-08-24', 'ABH|2026-09-01', 'MADHURKNIT|2026-09-01',
  'SUMAX|2026-09-02', 'ASHUTOSH|2026-09-07', 'SHANTIINOR|2026-09-07', 'QUALIANCE|2026-09-11',
  'VINOD|2026-09-17', 'KHERIAAUTO|2026-09-24', 'SPECTRAA|2026-09-24', 'AXIOMGAS|2026-09-25',
  'COREIN|2026-09-30', 'POOJALOGIS|2026-09-30', 'BMISL|2026-10-05', 'HIMALAYAN|2026-10-05',
  'GREENASIA|2026-10-07', 'PAPADMALJI|2026-10-07', 'EVENTIONS|2026-10-08'
];

/** "28-Aug-26" / Date / "2026-08-28" / "28/08/2026" -> Date (local midnight) or null. */
function ab_smeParseDate_(v) {
  if (v instanceof Date && !isNaN(v)) return new Date(v.getFullYear(), v.getMonth(), v.getDate());
  const t = String(v === null || v === undefined ? '' : v).trim();
  if (!t) return null;
  const mon = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  let m = t.match(/^(\d{1,2})[-\/ ]([A-Za-z]{3})[A-Za-z]*[-\/ ,]+(\d{2}|\d{4})$/);
  if (m && mon[m[2].toUpperCase()] !== undefined) {
    let y = Number(m[3]); if (y < 100) y += 2000;
    return new Date(y, mon[m[2].toUpperCase()], Number(m[1]));
  }
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = t.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return null;
}

/** The SME list to use: [{symbol, date}] - pasted tab if it has data, else the built-in list. */
function ab_smeCollect_() {
  const out = [];
  let source = 'built-in list';
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AB_SME_PASTE_SHEET);
  if (sh && sh.getLastRow() >= 2) {
    const grid = sh.getRange(1, 1, Math.min(sh.getLastRow(), 5000), Math.max(2, sh.getLastColumn())).getValues();
    let hdr = -1, cs = -1, cd = -1;
    for (let r = 0; r < Math.min(5, grid.length); r++) {
      const row = grid[r].map(ab_normHeader_);
      const s = row.indexOf('SYMBOL'), d = row.indexOf('DATEOFLISTING');
      if (s !== -1 && d !== -1) { hdr = r; cs = s; cd = d; break; }
    }
    if (hdr !== -1) {
      for (let r = hdr + 1; r < grid.length; r++) {
        const sym = String(grid[r][cs] || '').trim().toUpperCase();
        const d = ab_smeParseDate_(grid[r][cd]);
        if (sym && !/\s/.test(sym) && d) out.push({ symbol: sym, date: d });
      }
      if (out.length) source = '"' + AB_SME_PASTE_SHEET + '" tab';
    }
  }
  if (!out.length) {
    AB_SME_SEED_.forEach(function (s) {
      const p = s.split('|');
      out.push({ symbol: p[0], date: ab_smeParseDate_(p[1]) });
    });
  }
  return { rows: out, source: source };
}

/** SME issue prices from Chittorgarh -> { SYMBOL: price } ({} if unreachable). */
function ab_smeIssuePrices_(fromYear) {
  const map = {};
  const nowY = Number(Utilities.formatDate(new Date(), AB_TZ, 'yyyy'));
  for (let y = fromYear; y <= nowY; y++) {
    try {
      ab_fetchChittorgarhIpoListings_('sme', y).forEach(function (rec) {
        const sym = String(rec['~nse_symbol'] || '').trim().toUpperCase();
        const px = ab_toNum_(rec['Issue Price (Rs.)']);
        if (sym && !isNaN(px) && px > 0) map[sym] = px;
      });
    } catch (e) { Logger.log('SME issue prices ' + y + ' skipped: ' + e.message); }
  }
  return map;
}

/**
 * Appends rows [{symbol, date, price?}] (already sorted, oldest first) under the last real
 * symbol row of the IPOs tab: S.No, symbol, listing date and listing price are written,
 * the live formula columns are copied down from the last real row, and every per-symbol
 * VALUE column (IPO bases, 52W high, FVG ...) is left blank so the real values get computed.
 * Returns how many rows got a listing price.
 */
function ab_appendIpoRows_(layout, lastSymRow, fresh, prices) {
  const sh = layout.sheet;
  const n = fresh.length, first = lastSymRow + 1;
  if (sh.getMaxRows() < lastSymRow + n) sh.insertRowsAfter(sh.getMaxRows(), lastSymRow + n - sh.getMaxRows());

  // Live formula columns (everything right of LISTING PRICE) copied down from the last real row.
  const lastCol = layout.lastColumn;
  const known = Math.max(layout.sNo, layout.symbol, layout.listingDate, layout.listingPrice);
  if (lastSymRow > layout.headerRowIdx + 1 && lastCol > known + 1) {
    sh.getRange(lastSymRow, known + 2, 1, lastCol - known - 1)
      .copyTo(sh.getRange(first, known + 2, n, lastCol - known - 1));
    // Base / 52W high / FVG etc. hold per-symbol VALUES, not formulas - never copy another company's.
    [layout.base, layout.baseGap, layout.baseStatus, layout.high52, layout.activeBase,
     layout.base2, layout.base2a, layout.activeNo, layout.fvg].forEach(function (c) {
      if (c !== undefined && c !== -1) sh.getRange(first, c + 1, n, 1).clearContent();
    });
  }

  let priced = 0;
  const syms = [], dates = [], pxs = [], snos = [];
  fresh.forEach(function (x, i) {
    syms.push([x.symbol]);
    dates.push([x.date]);
    const p = prices ? prices[x.symbol] : null;
    if (p) priced++;
    pxs.push([p || '']);
    snos.push([lastSymRow - layout.headerRowIdx - 1 + i + 1]);
  });
  if (layout.sNo !== -1) sh.getRange(first, layout.sNo + 1, n, 1).setValues(snos);
  sh.getRange(first, layout.symbol + 1, n, 1).setValues(syms);
  sh.getRange(first, layout.listingDate + 1, n, 1).setNumberFormat(AB_IPO_DATE_FORMAT).setValues(dates);
  if (layout.listingPrice !== -1) sh.getRange(first, layout.listingPrice + 1, n, 1).setValues(pxs);
  SpreadsheetApp.flush();
  try { ab_linkIpoSymbols_(); } catch (e) { Logger.log('IPO symbol links skipped: ' + e.message); }
  return priced;
}

/**
 * Adds the SME stocks (listed on/after AB_SME_FROM) that are not yet on
 * the IPOs tab, oldest first at the bottom (same order as the rest of the
 * tab). Returns { added: [symbols], already: n, source, priced: n }.
 */
function ab_addSmeToIpos_() {
  const layout = ab_getIpoSheetLayout_();
  if (layout.symbol === -1 || layout.listingDate === -1) {
    throw new Error(AB_IPO_SHEET + ' needs "' + AB_IPO_SYMBOL_HEADER + '" and "LISTING DATE" columns.');
  }
  const sh = layout.sheet;
  const have = {};
  let lastSymRow = layout.headerRowIdx + 1; // 1-based row of the last real symbol
  for (let r = layout.headerRowIdx + 1; r < layout.data.length; r++) {
    const sym = ab_cellText_(layout.data[r][layout.symbol]).toUpperCase();
    if (sym) { have[sym] = true; lastSymRow = r + 1; }
  }

  const list = ab_smeCollect_();
  const inMain = ab_pbMainSymbols_(); // { SYMBOL: true } for every stock in the Main sheet
  if (!Object.keys(inMain).length) throw new Error('Could not read any symbols from the Main sheet.');
  const seen = {};
  const fresh = [];
  let already = 0, recent = 0, notInMain = 0;
  list.rows.forEach(function (x) {
    if (x.date < AB_SME_FROM || seen[x.symbol]) return;
    seen[x.symbol] = true;
    recent++;
    if (!inMain[x.symbol]) { notInMain++; return; } // not in Main -> no GOOGLEFINANCE price, skip
    if (have[x.symbol]) { already++; return; }
    fresh.push(x);
  });
  fresh.sort(function (a, b) { return a.date - b.date || (a.symbol < b.symbol ? -1 : 1); });
  const stats = { recent: recent, notInMain: notInMain };
  if (!fresh.length) return { added: [], already: already, source: list.source, priced: 0, stats: stats };

  let prices = {};
  try { prices = ab_smeIssuePrices_(AB_SME_FROM.getFullYear()); } catch (e) { Logger.log('SME prices skipped: ' + e.message); }

  const priced = ab_appendIpoRows_(layout, lastSymRow, fresh, prices);
  return { added: fresh.map(function (x) { return x.symbol; }), already: already, source: list.source, priced: priced, stats: stats };
}

/** Menu: add SME stocks listed on/after 01/01/2025 to the IPOs tab. */
function runAddSmeToIposNow() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const res = ab_addSmeToIpos_();
    if (!res.added.length) {
      ui.alert('SME -> IPOs', 'Nothing to add.\n' + res.stats.recent + ' SME stocks listed since 01/01/2025 in the list:\n' +
               res.stats.notInMain + ' are not in your Main sheet (skipped), ' + res.already +
               ' are already on the "' + AB_IPO_SHEET + '" tab.', ui.ButtonSet.OK);
      return;
    }
    try { fillIpoLevel_(); } catch (e) { Logger.log('fillIpoLevel_ after SME add skipped: ' + e.message); }
    ui.alert('SME -> IPOs',
      'Added ' + res.added.length + ' SME stock(s) to the "' + AB_IPO_SHEET + '" tab (source: ' + res.source + ').\n' +
      res.already + ' were already there; ' + res.stats.notInMain + ' of the ' + res.stats.recent +
      ' SME stocks listed since 01/01/2025 are not in your Main sheet, so they were skipped.\n' +
      (res.priced ? 'Listing price filled for ' + res.priced + ' of them.' : 'LISTING PRICE could not be fetched - it is blank for these rows.') +
      '\n\nNext: Auto Bhavcopy > 9. IPOs > IPO Base Watch (compute + alert now) to fill their IPO Base.',
      ui.ButtonSet.OK);
  } catch (e) {
    Logger.log('SME -> IPOs failed: ' + e.message);
    ss.toast('SME -> IPOs failed: ' + e.message);
  }
}

/** Menu: opens (creating on first use) the tab where NSE's SME_EQUITY_L.csv can be pasted. */
function runOpenSmeListTab() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(AB_SME_PASTE_SHEET);
  if (!sh) {
    sh = ss.insertSheet(AB_SME_PASTE_SHEET);
    sh.getRange(1, 1, 1, 7).setValues([['SYMBOL', 'NAME_OF_COMPANY', 'SERIES', 'DATE_OF_LISTING', 'PAID_UP_VALUE', 'ISIN_NUMBER', 'FACE_VALUE']])
      .setFontWeight('bold').setBackground('#f1f3f4');
    sh.setFrozenRows(1);
  }
  ss.setActiveSheet(sh);
}

/*****************************************************************
 * ADD NEW IPOs  (IPOs tab + Main sheet, one click)
 * -----------------------------------------------------------------
 * Weekly routine:
 *   1. Download NSE's "Past Issues" report, delete the SME / DEBT rows
 *      (GOOGLEFINANCE has no price for SME symbols).
 *   2. Menu: Auto Bhavcopy > 9. IPOs > Open "New IPOs" Tab, paste the
 *      rows (COMPANY NAME, SECURITY TYPE, Symbol, DATE OF LISTING).
 *   3. Menu: Auto Bhavcopy > 9. IPOs > Add New IPOs (IPOs tab + Main).
 *
 * For every symbol that is missing it
 *   - IPOs tab: adds the symbol at the bottom (oldest first), the
 *     listing date as 01/10/2026 (the tab's own format) and the live
 *     formulas copied from the last row. LISTING PRICE and the IPO Base
 *     columns are left blank - you type the price, the refresh fills the bases.
 *   - Main: adds the symbol after the last stock, copies the formula
 *     columns from the last stock row (price, MCAP, PE, EMA ... all pointing
 *     at the new row), leaves typed-in columns blank, builds the Chart /
 *     Screener links and fetches the StockName.
 * You still type the Basic Industry by hand in Main (then run "Fill
 * Sector/Industry"), exactly as for any other new symbol.
 * Rows that are already present are skipped, so pasting an overlapping
 * list again is harmless. SME / DEBT rows, rows without a date and rows
 * with a date in the future are skipped and listed in the result.
 *****************************************************************/
const AB_NEWIPO_PASTE_SHEET = 'New IPOs';

/** "08-Oct-26" text / real Date -> sensible Date, or null. Text is read day-month-year, never month-first. */
function ab_newIpoDate_(v) {
  const d = ab_smeParseDate_(v);
  if (!d || isNaN(d.getTime())) return null;
  return d;
}

/** The pasted rows: { rows: [{symbol, type, date}], bad: [text], total } or null when the tab is missing/empty. */
function ab_newIpoCollect_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AB_NEWIPO_PASTE_SHEET);
  if (!sh || sh.getLastRow() < 1) return null;
  const grid = sh.getRange(1, 1, Math.min(sh.getLastRow(), 2000), Math.max(4, sh.getLastColumn())).getValues();
  let hdr = -1, cs = 2, cd = 3, ct = 1;
  for (let r = 0; r < Math.min(5, grid.length); r++) {
    const row = grid[r].map(ab_normHeader_);
    const s = row.indexOf('SYMBOL'), d = row.indexOf('DATEOFLISTING');
    if (s !== -1 && d !== -1) { hdr = r; cs = s; cd = d; ct = row.indexOf('SECURITYTYPE'); break; }
  }
  const out = { rows: [], bad: [], total: 0 };
  for (let r = hdr + 1; r < grid.length; r++) {
    const sym = String(grid[r][cs] === undefined ? '' : grid[r][cs]).trim().toUpperCase();
    if (!sym) continue;
    out.total++;
    const type = ct === -1 ? '' : String(grid[r][ct] || '').trim().toUpperCase();
    const raw = grid[r][cd];
    out.rows.push({ symbol: sym, type: type, date: ab_newIpoDate_(raw), raw: raw instanceof Date ? '' : String(raw === undefined ? '' : raw) });
  }
  return out;
}

/**
 * Adds symbols [{symbol}] to the bottom of Main: formulas copied from the last stock row
 * (relative references move with the row), typed-in cells left blank, links rebuilt.
 * Returns the number of rows added. Names are filled afterwards by fillNewSymbolDetails_.
 */
function ab_appendMainRows_(list) {
  if (!list.length) return 0;
  const layout = ab_getMainLayout_();
  const sh = layout.sheet;
  const lastCol = sh.getLastColumn();
  let lastSymRow = layout.headerRowIdx + 1;
  for (let r = layout.headerRowIdx + 1; r < layout.data.length; r++) {
    if (ab_cellText_(layout.data[r][layout.symbol])) lastSymRow = r + 1;
  }
  if (lastSymRow <= layout.headerRowIdx + 1) throw new Error('Main has no stock row to copy the formulas from.');

  // Source row: the last stock row whose MKT Price cell holds a formula (looks back up to 30 rows).
  const from = Math.max(layout.headerRowIdx + 2, lastSymRow - 29);
  const block = sh.getRange(from, 1, lastSymRow - from + 1, lastCol).getFormulas();
  let srcIdx = block.length - 1;
  if (layout.mktPrice !== -1) {
    for (let i = block.length - 1; i >= 0; i--) {
      if (String(block[i][layout.mktPrice]).charAt(0) === '=') { srcIdx = i; break; }
    }
  }
  const srcRow = from + srcIdx;
  const srcF = block[srcIdx];

  const n = list.length, first = lastSymRow + 1;
  if (sh.getMaxRows() < lastSymRow + n) sh.insertRowsAfter(sh.getMaxRows(), lastSymRow + n - sh.getMaxRows());
  sh.getRange(srcRow, 1, 1, lastCol).copyTo(sh.getRange(first, 1, n, lastCol));

  // Typed-in columns of the source row (no formula) must not be stamped onto new stocks.
  for (let j = 0; j < lastCol; j++) {
    if (String(srcF[j]).charAt(0) !== '=') sh.getRange(first, j + 1, n, 1).clearContent();
  }

  const header = layout.header;
  const tickerCol = header.indexOf('NSE Ticker'), chartCol = header.indexOf('Chart'), screenerCol = header.indexOf('Screener.in');
  list.forEach(function (x, i) {
    const row = first + i;
    sh.getRange(row, layout.symbol + 1).setValue(x.symbol);
    // NSE Ticker keeps its own formula when it has one; otherwise it is typed as NSE:SYMBOL.
    if (tickerCol !== -1 && String(srcF[tickerCol]).charAt(0) !== '=') sh.getRange(row, tickerCol + 1).setValue('NSE:' + x.symbol);
    // Links carry the symbol as a literal inside the URL, so they are rebuilt, never copied.
    if (chartCol !== -1) sh.getRange(row, chartCol + 1).setFormula('=HYPERLINK("' + ab_chartUrl_(x.symbol) + '","📈 Chart")');
    if (screenerCol !== -1) sh.getRange(row, screenerCol + 1).setFormula('=HYPERLINK("' + ab_screenerUrl_(x.symbol) + '","📊 Screener")');
  });
  SpreadsheetApp.flush();
  return n;
}

/**
 * Runs fn() with the sheet's filter switched off. Copying/pasting into a range that
 * contains a filtered-out row throws "This operation is not supported on a range with a
 * filtered out row". The filter is put back afterwards (same range, grown to cover new
 * rows) but WITHOUT its old criteria, so every row - including the new ones - is visible.
 * Returns fn()'s result; sets ab_withFilterOff_.cleared when a filter had to be removed.
 */
function ab_withFilterOff_(sh, fn) {
  let saved = null;
  try {
    const f = sh.getFilter();
    if (f) {
      const rg = f.getRange();
      saved = { row: rg.getRow(), col: rg.getColumn(), cols: rg.getNumColumns(), rows: rg.getNumRows() };
      f.remove();
      ab_withFilterOff_.cleared = true;
    }
  } catch (e) { Logger.log('Could not read the sheet filter: ' + e.message); }
  try {
    return fn();
  } finally {
    if (saved) {
      try {
        const rows = Math.max(saved.rows, sh.getLastRow() - saved.row + 1);
        sh.getRange(saved.row, saved.col, rows, saved.cols).createFilter();
      } catch (e) { Logger.log('Could not put the filter back: ' + e.message); }
    }
  }
}

/** Adds the missing IPOs to the IPOs tab and Main. Returns a result object for the dialog. */
function ab_addNewIpos_() {
  const pasted = ab_newIpoCollect_();
  if (!pasted || !pasted.total) return { empty: true };

  ab_withFilterOff_.cleared = false;
  const res = { total: pasted.total, ipoAdded: [], mainAdded: [], ipoHad: 0, mainHad: 0,
                skippedType: [], skippedDate: [], names: null, filterCleared: false };

  // ---- which rows are usable ----
  const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
  const seen = {}, usable = [];
  pasted.rows.forEach(function (x) {
    if (seen[x.symbol]) return;
    seen[x.symbol] = true;
    if (x.type === 'SME' || x.type === 'DEBT') { res.skippedType.push(x.symbol + ' (' + x.type + ')'); return; }
    if (!x.date || x.date.getTime() > todayEnd.getTime()) {
      res.skippedDate.push(x.symbol + (x.raw ? ' (' + x.raw + ')' : ''));
      return;
    }
    usable.push(x);
  });
  usable.sort(function (a, b) { return a.date - b.date || (a.symbol < b.symbol ? -1 : 1); });

  // ---- Main ----
  const mainLayout = ab_getMainLayout_();
  const inMain = {};
  for (let r = mainLayout.headerRowIdx + 1; r < mainLayout.data.length; r++) {
    const sym = ab_cellText_(mainLayout.data[r][mainLayout.symbol]).toUpperCase();
    if (sym) inMain[sym] = true;
  }
  const mainNew = usable.filter(function (x) { if (inMain[x.symbol]) { res.mainHad++; return false; } return true; });
  if (mainNew.length) {
    ab_withFilterOff_(mainLayout.sheet, function () { ab_appendMainRows_(mainNew); });
    res.mainAdded = mainNew.map(function (x) { return x.symbol; });
    try { res.names = fillNewSymbolDetails_(); } catch (e) { Logger.log('New IPO names skipped: ' + e.message); }
  }

  // ---- IPOs tab ----
  const layout = ab_getIpoSheetLayout_();
  if (layout.symbol === -1 || layout.listingDate === -1) {
    throw new Error(AB_IPO_SHEET + ' needs "' + AB_IPO_SYMBOL_HEADER + '" and "LISTING DATE" columns.');
  }
  const have = {};
  let lastSymRow = layout.headerRowIdx + 1;
  for (let r = layout.headerRowIdx + 1; r < layout.data.length; r++) {
    const sym = ab_cellText_(layout.data[r][layout.symbol]).toUpperCase();
    if (sym) { have[sym] = true; lastSymRow = r + 1; }
  }
  const ipoNew = usable.filter(function (x) { if (have[x.symbol]) { res.ipoHad++; return false; } return true; });
  if (ipoNew.length) {
    // LISTING PRICE is typed by hand afterwards, so it is left blank here.
    ab_withFilterOff_(layout.sheet, function () { ab_appendIpoRows_(layout, lastSymRow, ipoNew, null); });
    res.ipoAdded = ipoNew.map(function (x) { return x.symbol; });
  }
  res.filterCleared = !!ab_withFilterOff_.cleared;
  return res;
}

/** Menu: add the IPOs pasted in the "New IPOs" tab to the IPOs tab and Main. */
function runAddNewIpos() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    ss.toast('Adding the new IPOs...', 'New IPOs', 10);
    const res = ab_addNewIpos_();
    if (res.empty) {
      ui.alert('New IPOs', 'The "' + AB_NEWIPO_PASTE_SHEET + '" tab is empty (or missing).\n\nUse: Auto Bhavcopy > 9. IPOs > Open "New IPOs" Tab, paste the NSE rows there, then run this again.', ui.ButtonSet.OK);
      return;
    }
    if (res.ipoAdded.length) { try { fillIpoLevel_(); } catch (e) { Logger.log('fillIpoLevel_ after new IPOs skipped: ' + e.message); } }
    const lines = [];
    lines.push('Pasted rows: ' + res.total);
    lines.push('IPOs tab: ' + res.ipoAdded.length + ' added' + (res.ipoAdded.length ? ' (' + res.ipoAdded.join(', ') + ')' : '') + ', ' + res.ipoHad + ' already there.');
    lines.push('Main: ' + res.mainAdded.length + ' added' + (res.mainAdded.length ? ' (' + res.mainAdded.join(', ') + ')' : '') + ', ' + res.mainHad + ' already there.');
    if (res.names) lines.push('Main StockName: ' + res.names.filled + ' filled, ' + res.names.failed + ' not found.');
    if (res.filterCleared) lines.push('Note: a filter was active on a sheet - it was cleared so all rows (and the new ones) are visible.');
    if (res.skippedType.length) lines.push('Skipped (SME / DEBT): ' + res.skippedType.join(', '));
    if (res.skippedDate.length) lines.push('Skipped (date missing or in the future - check it): ' + res.skippedDate.join(', '));
    lines.push('');
    lines.push('Next:');
    if (res.mainAdded.length) lines.push('1. Main: type the Basic Industry of the new stocks, then Auto Bhavcopy > 8. Symbols, Indices & Main Upkeep > Fill Sector/Industry from Basic Industry.');
    let k = res.mainAdded.length ? 2 : 1;
    if (res.ipoAdded.length) lines.push((k++) + '. IPOs tab: type the LISTING PRICE of the new rows.');
    lines.push(k + '. Auto Bhavcopy > 9. IPOs > Refresh IPO Base Columns (no email).');
    ui.alert('New IPOs', lines.join('\n'), ui.ButtonSet.OK);
  } catch (e) {
    Logger.log('Add New IPOs failed: ' + e.message + '\n' + e.stack);
    ss.toast('Add New IPOs failed: ' + e.message);
  }
}

/** Menu: opens (creating on first use) the tab where NSE's past-issue rows are pasted. */
function runOpenNewIposTab() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(AB_NEWIPO_PASTE_SHEET);
  if (!sh) {
    sh = ss.insertSheet(AB_NEWIPO_PASTE_SHEET);
    sh.getRange(1, 1, 1, 4).setValues([['COMPANY NAME', 'SECURITY TYPE', 'Symbol', 'DATE OF LISTING']])
      .setFontWeight('bold').setBackground('#f1f3f4');
    // Plain text, so "08-Oct-26" stays exactly as typed and is never re-read month-first.
    sh.getRange(2, 4, 1000, 1).setNumberFormat('@');
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 280); sh.setColumnWidth(3, 130); sh.setColumnWidth(4, 130);
  }
  ss.setActiveSheet(sh);
}

/*****************************************************************
 * IPOs TAB - FINTECH LOOK
 * -----------------------------------------------------------------
 * Restyles the IPOs tab in place. Your data, formulas, column order and
 * headers are NOT touched - only colours, fonts, number formats, column
 * widths, frozen header, filter and colour rules. Safe to run again any
 * time (e.g. after adding a column). The colour rules cover the whole
 * column, so rows added later by the IPO sync pick them up by themselves.
 *
 *   % columns ..... green when up, red when down
 *   Below/Above ... green "Above" / red "Below" chip
 *   Base Status ... green Above Base / amber Near Base / red Below Base
 *   % to IPO Base . green above the base, red below it
 *   every 2nd row . light stripe
 * Any old colour rules on this tab are replaced by these.
 *****************************************************************/
const AB_IPOUI_ = {
  navy: '#0f172a', ink: '#1e293b', muted: '#94a3b8', stripe: '#f8fafc', line: '#e2e8f0',
  upFg: '#047857', upBg: '#d1fae5', downFg: '#b91c1c', downBg: '#fee2e2', warnFg: '#b45309', warnBg: '#fef3c7'
};

function ab_styleIposTab_() {
  const L = ab_getIpoSheetLayout_();
  const sh = L.sheet;
  const U = AB_IPOUI_;
  const hdrRow = L.headerRowIdx + 1;          // 1-based header row
  const first = hdrRow + 1;                   // first data row
  const maxRows = Math.max(sh.getMaxRows(), first + 1);
  const nData = maxRows - hdrRow;
  let lastSym = hdrRow;
  for (let r = L.headerRowIdx + 1; r < L.data.length; r++) {
    if (ab_cellText_(L.data[r][L.symbol]) !== '') lastSym = r + 1;
  }
  const headers = L.data[L.headerRowIdx].map(ab_normHeader_);
  const find = function (name) { return headers.indexOf(ab_normHeader_(name)); };
  const pctChange = find('% change');
  const pctListing = find('% Down/up from Listing Price');
  // Last header column that has a title (ignores stray empty columns).
  let nCols = 0;
  headers.forEach(function (h, i) { if (h !== '') nCols = i + 1; });
  if (nCols < 1) throw new Error('No headers found on the ' + AB_IPO_SHEET + ' tab.');

  // ---- base look ----
  sh.setHiddenGridlines(true);
  sh.setFrozenRows(hdrRow);
  if (L.symbol === 0) sh.setFrozenColumns(1);
  const all = sh.getRange(1, 1, maxRows, nCols);
  all.setFontFamily('Roboto').setFontSize(10).setFontColor(U.ink).setVerticalAlignment('middle')
     .setBackground(null).setWrap(false);

  // ---- header ----
  const hdr = sh.getRange(hdrRow, 1, 1, nCols);
  hdr.setBackground(U.navy).setFontColor('#ffffff').setFontWeight('bold').setFontSize(10)
     .setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true);
  sh.setRowHeight(hdrRow, 44);
  for (let r = 1; r < hdrRow; r++) sh.getRange(r, 1, 1, nCols).setBackground(U.navy).setFontColor('#ffffff');

  // ---- body alignment + number formats (whole column, so new rows match) ----
  const col = function (c) { return sh.getRange(first, c + 1, nData, 1); };
  sh.getRange(first, 1, nData, nCols).setHorizontalAlignment('right');
  if (L.sNo !== -1) col(L.sNo).setHorizontalAlignment('center').setFontColor(U.muted);
  if (L.symbol !== -1) col(L.symbol).setHorizontalAlignment('left').setFontWeight('bold').setFontColor(U.navy);
  if (L.listingDate !== -1) col(L.listingDate).setHorizontalAlignment('center').setNumberFormat(AB_IPO_DATE_FORMAT);
  if (L.listingPrice !== -1) col(L.listingPrice).setNumberFormat('#,##0.00');
  if (L.marketPrice !== -1) col(L.marketPrice).setNumberFormat('#,##0.00').setFontWeight('bold');
  if (pctChange !== -1) col(pctChange).setNumberFormat('+0.00"%";-0.00"%";0.00"%"');
  if (pctListing !== -1) col(pctListing).setNumberFormat('+0.0%;-0.0%;0.0%').setFontWeight('bold');
  if (L.level !== -1) col(L.level).setHorizontalAlignment('center').setFontWeight('bold');
  if (L.base !== -1) col(L.base).setNumberFormat('#,##0.00');
  if (L.baseGap !== -1) col(L.baseGap).setNumberFormat('+0.0"%";-0.0"%";0.0"%"').setFontWeight('bold');
  if (L.baseStatus !== -1) col(L.baseStatus).setHorizontalAlignment('center').setFontWeight('bold');
  if (L.high52 !== -1) col(L.high52).setNumberFormat('#,##0.00');
  if (L.activeBase !== -1) col(L.activeBase).setHorizontalAlignment('center').setNumberFormat('#,##0.00');
  if (L.base2 !== -1) col(L.base2).setNumberFormat('#,##0.00');
  if (L.base2a !== -1) col(L.base2a).setNumberFormat('#,##0.00');
  if (L.fvg !== -1) col(L.fvg).setHorizontalAlignment('left');
  if (L.activeNo !== -1) col(L.activeNo).setHorizontalAlignment('center');

  // thin line under the header and under the last real row
  sh.getRange(hdrRow, 1, 1, nCols).setBorder(null, null, true, null, null, null, U.navy, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  if (lastSym > hdrRow) sh.getRange(lastSym, 1, 1, nCols).setBorder(null, null, true, null, null, null, U.line, SpreadsheetApp.BorderStyle.SOLID);

  // ---- column widths ----
  const width = function (c, w) { if (c !== -1) sh.setColumnWidth(c + 1, w); };
  width(L.sNo, 50); width(L.symbol, 135); width(L.listingDate, 105); width(L.listingPrice, 100);
  width(L.marketPrice, 105); width(pctChange, 85); width(pctListing, 120); width(L.level, 120);
  width(L.base, 95); width(L.baseGap, 100); width(L.baseStatus, 280); width(L.high52, 95); width(L.activeBase, 110);
  width(L.base2, 100); width(L.base2a, 100); width(L.fvg, 250); width(L.activeNo, 110);

  // ---- colour rules (whole column from the first data row) ----
  const rules = [];
  const rng = function (c) { return sh.getRange(first, c + 1, nData, 1); };
  const mk = function () { return SpreadsheetApp.newConditionalFormatRule(); };
  const chip = function (b, c, bg, fg) { return b.setBackground(bg).setFontColor(fg).setBold(true).setRanges([rng(c)]).build(); };

  // error / not-available values: grey, not alarming
  if (L.marketPrice !== -1) {
    rules.push(mk().whenFormulaSatisfied('=ISERROR(' + ab_colToLetter_(L.marketPrice + 1) + first + ')')
      .setFontColor(U.muted).setRanges([sh.getRange(first, L.marketPrice + 1, nData, nCols - L.marketPrice)]).build());
  }
  [pctChange, pctListing, L.baseGap].forEach(function (c) {
    if (c === -1) return;
    rules.push(chip(mk().whenNumberGreaterThan(0), c, U.upBg, U.upFg));
    rules.push(chip(mk().whenNumberLessThan(0), c, U.downBg, U.downFg));
  });
  if (L.level !== -1) {
    rules.push(chip(mk().whenTextEqualTo('Above'), L.level, U.upBg, U.upFg));
    rules.push(chip(mk().whenTextEqualTo('Below'), L.level, U.downBg, U.downFg));
  }
  if (L.baseStatus !== -1) {
    rules.push(chip(mk().whenTextStartsWith('Above'), L.baseStatus, U.upBg, U.upFg));
    rules.push(chip(mk().whenTextStartsWith('Near'), L.baseStatus, U.warnBg, U.warnFg));
    rules.push(chip(mk().whenTextStartsWith('Below'), L.baseStatus, U.downBg, U.downFg));
    rules.push(chip(mk().whenTextStartsWith('Waiting'), L.baseStatus, '#e2e8f0', '#475569'));
  }
  // zebra stripe last, so it only shows where nothing above coloured the cell
  rules.push(mk().whenFormulaSatisfied('=AND($' + ab_colToLetter_(L.symbol + 1) + first + '<>"",ISEVEN(ROW()))')
    .setBackground(U.stripe).setRanges([sh.getRange(first, 1, nData, nCols)]).build());
  sh.setConditionalFormatRules(rules);

  // ---- filter on the header (kept if you already have one) ----
  try {
    if (!sh.getFilter()) sh.getRange(hdrRow, 1, maxRows - hdrRow + 1, nCols).createFilter();
  } catch (e) { Logger.log('IPOs filter skipped: ' + e.message); }
  return { rows: Math.max(0, lastSym - hdrRow), cols: nCols };
}

/**
 * Makes every symbol on the IPOs tab a clickable TradingView link. The
 * cell still holds just the symbol (so every formula and the daily jobs
 * read it exactly as before) - the link is attached to the text.
 * Returns the number of symbols linked.
 */
function ab_linkIpoSymbols_() {
  const L = ab_getIpoSheetLayout_();
  if (L.symbol === -1) return 0;
  const first = L.headerRowIdx + 2;
  const n = L.data.length - L.headerRowIdx - 1;
  if (n < 1) return 0;
  const style = SpreadsheetApp.newTextStyle().setForegroundColor(AB_IPOUI_.navy).setBold(true).setUnderline(false).build();
  const vals = L.sheet.getRange(first, L.symbol + 1, n, 1).getValues();
  const out = [];
  let linked = 0;
  vals.forEach(function (row) {
    const sym = ab_cellText_(row[0]);
    const b = SpreadsheetApp.newRichTextValue().setText(sym);
    if (sym && !/\s/.test(sym)) { b.setLinkUrl(ab_chartUrl_(sym)).setTextStyle(style); linked++; }
    out.push([b.build()]);
  });
  L.sheet.getRange(first, L.symbol + 1, n, 1).setRichTextValues(out);
  return linked;
}

/** Menu: restyle the IPOs tab. */
function runStyleIposTab() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const r = ab_styleIposTab_();
    try { r.linked = ab_linkIpoSymbols_(); } catch (e) { Logger.log('IPO symbol links skipped: ' + e.message); r.linked = 0; }
    ss.setActiveSheet(ss.getSheetByName(AB_IPO_SHEET));
    ss.toast('IPOs tab restyled (' + r.rows + ' rows, ' + r.cols + ' columns); ' + r.linked + ' symbols link to TradingView. Data and formulas untouched.', 'IPOs', 8);
  } catch (e) {
    ss.toast('Could not style the IPOs tab: ' + e.message);
  }
}

/*****************************************************************
 * MAIN SHEET - FINTECH LOOK
 * -----------------------------------------------------------------
 * Restyles Main in place. Data, formulas, column order, headers,
 * checkboxes, your own colours (symbol/index colours, sector colours)
 * and every existing colour rule are KEPT - this only adds:
 *   - navy header row + coloured section bands above it
 *     (Alert System, Quarterly Results, Valuation, ...)
 *   - clean font, row height, alignment and +/- number formats
 *   - light lines between rows, no gridlines
 *   - extra colour chips: IPO Level, Win/Loss, Triggered, Pattern, FVG, Zone
 * Safe to run again any time. Existing frozen rows/columns and your
 * filter are left as they are.
 *****************************************************************/
const AB_MAINUI_ = {
  navy: '#0f172a', slate: '#1e293b', ink: '#1e293b', muted: '#94a3b8', line: '#e2e8f0',
  upFg: '#047857', upBg: '#d1fae5', downFg: '#b91c1c', downBg: '#fee2e2',
  warnFg: '#b45309', warnBg: '#fef3c7', infoFg: '#1d4ed8', infoBg: '#dbeafe', violFg: '#6d28d9', violBg: '#ede9fe'
};
// section band colour by the text in Main's row 1 (matched loosely)
const AB_MAINUI_BANDS_ = [
  ['ALERTSYSTEM', '#be123c'], ['QUARTERLYRESULTS', '#0369a1'], ['VALUATION', '#047857'],
  ['PROMOTOR', '#6d28d9'], ['OPM', '#0f766e'], ['TECHNICAL', '#c2410c']
];


// One soft fill per sector (text stays black). Unknown/new sectors get a stable fill from the spare list.
const AB_MAINUI_SECTOR_FILL_ = {
  capitalgoods: '#fde2c8', financialservices: '#cfe2f3', healthcare: '#d9ead3', chemicals: '#c8f2dc',
  fastmovingconsumergoods: '#f3d6f5', consumerdurables: '#d6e4ff', automobileandautocomponents: '#fad2d2',
  informationtechnology: '#dcd6f7', consumerservices: '#fff2b3', services: '#c6eef0', textiles: '#f7d4e6',
  construction: '#d7ccc8', realty: '#f4e2c0', metalsmining: '#e8d3f0', power: '#ffe0b3',
  constructionmaterials: '#cfd8dc', oilgasconsumablefuels: '#e6ee9c', mediaentertainmentpublication: '#f9c9d9',
  telecommunication: '#b3e5fc', forestmaterials: '#c5e1a5', utilities: '#ffccbc', diversified: '#e0e0e0'
};
const AB_MAINUI_SECTOR_SPARE_ = ['#fff9c4', '#d1c4e9', '#b2dfdb', '#ffe0b2', '#c8e6c9', '#f0f4c3', '#e1bee7', '#bbdefb'];

/**
 * Returns the conditional-format rules with the given Main columns (1-based
 * numbers, as a lookup) cut out of every rule's ranges. A rule that only
 * covered those columns disappears; a rule that also covered other columns
 * keeps them. Used so one column's old colours can be replaced without
 * touching any other column's colours.
 */
function ab_stripRuleColumns_(sh, rules, cols) {
  const out = [];
  rules.forEach(function (rule) {
    const keep = [];
    let touched = false;
    rule.getRanges().forEach(function (rg) {
      const r = rg.getRow(), nr = rg.getNumRows(), c1 = rg.getColumn(), c2 = rg.getLastColumn();
      let seg = null;
      for (let c = c1; c <= c2 + 1; c++) {
        const cut = c > c2 || cols[c];
        if (c <= c2 && cols[c]) touched = true;
        if (!cut) { if (seg === null) seg = c; }
        else if (seg !== null) { keep.push(sh.getRange(r, seg, nr, c - seg)); seg = null; }
      }
    });
    if (!touched) out.push(rule);
    else if (keep.length) out.push(rule.copy().setRanges(keep).build());
  });
  return out;
}

function ab_sectorColour_(name) {
  const key = String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (AB_MAINUI_SECTOR_FILL_[key]) return AB_MAINUI_SECTOR_FILL_[key];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 1000003;
  return AB_MAINUI_SECTOR_SPARE_[h % AB_MAINUI_SECTOR_SPARE_.length];
}

function ab_styleMainSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(AB_MAIN_SHEET);
  if (!sh) throw new Error('Could not find a "' + AB_MAIN_SHEET + '" tab.');
  const U = AB_MAINUI_;
  const nColsAll = sh.getLastColumn();
  const top = sh.getRange(1, 1, 3, nColsAll).getValues();
  let hdrRow = 0;
  for (let r = 0; r < 3; r++) {
    const row = top[r].map(function (v) { return String(v).trim(); });
    if (row.indexOf('StockName') !== -1 && row.indexOf('SYMBOL') !== -1) { hdrRow = r + 1; break; }
  }
  if (!hdrRow) throw new Error('Could not find the StockName/SYMBOL header row in Main.');
  const hdrVals = top[hdrRow - 1].map(ab_normHeader_);
  let nCols = 0;
  hdrVals.forEach(function (h, i) { if (h !== '') nCols = i + 1; });
  const idx = function (name) { return hdrVals.indexOf(ab_normHeader_(name)); };
  const first = hdrRow + 1;
  const maxRows = Math.max(sh.getMaxRows(), first + 1);
  const nData = maxRows - hdrRow;
  const symCol = idx('SYMBOL');
  const symVals = sh.getRange(first, symCol + 1, maxRows - hdrRow, 1).getValues();
  let lastSym = hdrRow;
  symVals.forEach(function (r, i) { if (String(r[0]).trim() !== '') lastSym = first + i; });
  const nRows = lastSym - hdrRow;

  sh.setHiddenGridlines(true);
  try { sh.setTabColor(U.navy); } catch (e) { /* cosmetic */ }

  // ---- body: font, alignment, row height, number formats (no fills touched) ----
  const body = sh.getRange(first, 1, nData, nCols);
  body.setFontFamily('Roboto').setFontSize(10).setVerticalAlignment('middle');
  const colRange = function (name) { const c = idx(name); return c === -1 ? null : sh.getRange(first, c + 1, nData, 1); };
  const eachCol = function (names, fn) { names.forEach(function (n) { const r = colRange(n); if (r) fn(r); }); };
  eachCol(['StockName', 'Sector', 'Industry', 'Basic Industry', 'SYMBOL', 'NSE Ticker', 'INDICES', 'Remarks', 'Pattern', 'FVG'],
          function (r) { r.setHorizontalAlignment('left'); });
  eachCol(['Checkbox', 'Result Date', 'Chart', 'Screener.in', 'Zone', 'Triggered Y/N', 'Triggered Date', 'Win/Loss', 'TTM Signal', 'Signal',
           'Promotor Holding', 'FII Activity', 'OPM YoY%', 'OPM QoQ%', 'IPO Level'],
          function (r) { r.setHorizontalAlignment('center'); });
  eachCol(['MCAP(CR)', 'MKT Price', '% Change', '10 day%', '30Day%', 'Price Fall Alert Price', 'Breakout Alert Price', 'Entry Price', 'Stoploss',
           'ATR', '% Up/Down After Alert', 'QoQ[Revenue Growth%}', 'QoQ[NP Growth %]', 'YoY[Revenue Growth %]', 'YoY[NP Growth %]', 'Net Profit',
           '52W High', '% down', 'PE Ratio', 'PE vs Industry PE', 'Vol', 'Prev Day Vol', '%vol Change'],
          function (r) { r.setHorizontalAlignment('right'); });
  const sb = colRange('SYMBOL'); if (sb) sb.setFontWeight('bold');
  const nb = colRange('StockName'); if (nb) nb.setFontWeight('bold');
  const fmt = function (name, f, bold) { const r = colRange(name); if (r) { r.setNumberFormat(f); if (bold) r.setFontWeight('bold'); } };
  fmt('MCAP(CR)', '#,##0'); fmt('MKT Price', '#,##0.00', true);
  fmt('% Change', '+0.00"%";-0.00"%";0.00"%"', true);
  fmt('10 day%', '+0.0%;-0.0%;0.0%'); fmt('30Day%', '+0.0%;-0.0%;0.0%');
  fmt('% down', '+0.0%;-0.0%;0.0%');
  sh.setRowHeights(first, nData, 26);

  // light line between rows (real rows only)
  if (nRows > 0) {
    sh.getRange(first, 1, nRows, nCols).setBorder(null, null, true, null, null, true, U.line, SpreadsheetApp.BorderStyle.SOLID);
  }

  // ---- header row 2 ----
  const hdr = sh.getRange(hdrRow, 1, 1, nCols);
  hdr.setBackground(U.navy).setFontColor('#ffffff').setFontWeight('bold').setFontFamily('Roboto').setFontSize(10)
     .setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true);
  hdr.setBorder(null, null, true, null, null, null, '#38bdf8', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  sh.setRowHeight(hdrRow, 46);
  const left = sh.getRange(hdrRow, 1, 1, 1); // keep Checkbox header readable
  left.setFontSize(9);
  ['StockName', 'Sector', 'Industry', 'Basic Industry', 'SYMBOL'].forEach(function (n) {
    const c = idx(n); if (c !== -1) sh.getRange(hdrRow, c + 1).setHorizontalAlignment('left');
  });

  // ---- section bands (row above the header) ----
  if (hdrRow > 1) {
    const bandRow = hdrRow - 1;
    const labels = top[bandRow - 1];
    const starts = [];
    labels.forEach(function (v, i) { if (i < nCols && String(v).trim() !== '' && i > 0) starts.push(i); });
    const band = sh.getRange(bandRow, 1, 1, nCols);
    band.setBackground(U.slate).setFontColor('#ffffff').setFontWeight('bold').setFontFamily('Roboto').setFontSize(10)
        .setHorizontalAlignment('center').setVerticalAlignment('middle');
    sh.setRowHeight(bandRow, 28);
    starts.forEach(function (s, k) {
      const end = k + 1 < starts.length ? starts[k + 1] : nCols; // exclusive
      const key = ab_normHeader_(labels[s]);
      let colour = U.slate;
      AB_MAINUI_BANDS_.forEach(function (b) { if (key.indexOf(b[0]) === 0) colour = b[1]; });
      sh.getRange(bandRow, s + 1, 1, end - s).setBackground(colour);
    });
  }

  // ---- extra colour chips, added AFTER your existing rules (they keep priority) ----
  // Columns whose old colours are replaced by the clean set below (every other column keeps its colours).
  const redo = {};
  ['Sector', 'ATR', 'QoQ[Revenue Growth%}', 'QoQ[NP Growth %]', 'YoY[Revenue Growth %]', 'YoY[NP Growth %]', 'Net Profit',
   'TTM EPS Growth', 'Promotor Holding', 'FII Activity', 'OPM YoY%', 'OPM QoQ%',
   'IPO Level', 'Win/Loss', 'Triggered Y/N', 'Pattern', 'FVG', 'Zone'].forEach(function (n) { const c = idx(n); if (c !== -1) redo[c + 1] = true; });
  const rules = ab_stripRuleColumns_(sh, sh.getConditionalFormatRules(), redo);
  const mk = function () { return SpreadsheetApp.newConditionalFormatRule(); };
  const rng = function (name) { const c = idx(name); return c === -1 ? null : sh.getRange(first, c + 1, nData, 1); };
  // Every colour rule is a cell fill only - the text always stays black and regular weight.
  const put = function (name, builder, bg) {
    const r = rng(name);
    if (!r) return;
    rules.push(builder.setBackground(bg).setFontColor('#000000').setBold(false).setRanges([r]).build());
  };
  const black = function (name) { const r = rng(name); if (r) r.setFontColor('#000000'); };

  // Sector: one soft fill per sector (the old dropdown chips are removed so every cell looks the same)
  const secR = rng('Sector');
  if (secR) {
    try { secR.clearDataValidations(); } catch (e) { Logger.log('Sector dropdowns not cleared: ' + e.message); }
    secR.setFontWeight('normal').setFontColor('#000000').setHorizontalAlignment('left');
    const seen = {};
    sh.getRange(first, idx('Sector') + 1, nRows, 1).getValues().forEach(function (v) {
      const s = String(v[0]).trim();
      if (!s || seen[s]) return;
      seen[s] = true;
      put('Sector', mk().whenTextEqualTo(s), ab_sectorColour_(s));
    });
    sh.setColumnWidth(idx('Sector') + 1, 215);
  }

  // Quarterly results + TTM EPS growth (values are % numbers)
  ['QoQ[Revenue Growth%}', 'QoQ[NP Growth %]', 'YoY[Revenue Growth %]', 'YoY[NP Growth %]', 'TTM EPS Growth', 'Net Profit'].forEach(function (n) {
    black(n);
    if (n !== 'Net Profit') put(n, mk().whenNumberGreaterThanOrEqualTo(20), '#86efac');
    if (n !== 'Net Profit') put(n, mk().whenNumberLessThanOrEqualTo(-20), '#fca5a5');
    put(n, mk().whenNumberGreaterThan(0), '#dcfce7');
    put(n, mk().whenNumberLessThan(0), '#fee2e2');
  });

  // Promotor Holding / FII Activity / OPM YoY% / OPM QoQ% (trend words) - dropdown arrows removed, centred, wider
  ['Promotor Holding', 'FII Activity', 'OPM YoY%', 'OPM QoQ%'].forEach(function (n) {
    const r = rng(n);
    if (r) {
      try { r.clearDataValidations(); } catch (e) { Logger.log(n + ' dropdowns not cleared: ' + e.message); }
      r.setFontColor('#000000').setHorizontalAlignment('center');
      sh.setColumnWidth(idx(n) + 1, 150);
    }
    put(n, mk().whenTextEqualTo('Aggressive Increase'), '#86efac');
    put(n, mk().whenTextEqualTo('Increasing'), '#bbf7d0');
    put(n, mk().whenTextEqualTo('Slightly Increasing'), '#dcfce7');
    put(n, mk().whenTextEqualTo('Aggressive Decrease'), '#fca5a5');
    put(n, mk().whenTextEqualTo('Decreasing'), '#fecaca');
    put(n, mk().whenTextEqualTo('Slightly Decreasing'), '#fee2e2');
    put(n, mk().whenTextEqualTo('Volatile'), '#fde68a');
    put(n, mk().whenTextEqualTo('Stagnant'), '#e2e8f0');
    put(n, mk().whenTextEqualTo('Insignificant'), '#f1f5f9');
  });
  const ck = idx('Checkbox'); if (ck !== -1) sh.setColumnWidth(ck + 1, 64);

  put('IPO Level', mk().whenTextEqualTo('Above'), '#bbf7d0');
  put('IPO Level', mk().whenTextEqualTo('Below'), '#fecaca');
  put('Win/Loss', mk().whenTextContains('Win'), '#bbf7d0');
  put('Win/Loss', mk().whenTextContains('Loss'), '#fecaca');
  put('Triggered Y/N', mk().whenTextEqualTo('Y'), '#fde68a');
  put('Pattern', mk().whenTextEqualTo('Spring?'), '#ede9fe');
  ['Spring', 'Bullish', 'Morningstar', 'Tweezer'].forEach(function (w) { put('Pattern', mk().whenTextContains(w), '#bbf7d0'); });
  put('Pattern', mk().whenTextContains('FVG'), '#bfdbfe');
  put('FVG', mk().whenTextContains('Confirmed'), '#bbf7d0');
  put('FVG', mk().whenTextContains('First Touch'), '#fde68a');
  put('FVG', mk().whenTextContains('Unmitigated'), '#bfdbfe');
  const zc = idx('Zone');
  if (zc !== -1) {
    rules.push(mk().whenFormulaSatisfied('=LEN(' + ab_colToLetter_(zc + 1) + first + ')>0').setBackground('#ede9fe').setFontColor('#000000')
      .setBold(false).setRanges([sh.getRange(first, zc + 1, nData, 1)]).build());
  }
  sh.setConditionalFormatRules(rules);

  // "📈 View Chart" -> "📈 Chart" (only cells that still use the long label are rewritten)
  const cc = idx('Chart');
  if (cc !== -1 && nRows > 0) {
    const cr = sh.getRange(first, cc + 1, nRows, 1);
    const fs = cr.getFormulas(), vs = cr.getValues();
    let changed = 0;
    const outF = fs.map(function (f, i) {
      const t = String(f[0]);
      if (/View Chart"\s*\)\s*$/.test(t)) { changed++; return [t.replace(/View Chart"\s*\)\s*$/, 'Chart")')]; }
      return [t !== '' ? t : vs[i][0]];
    });
    if (changed) cr.setFormulas(outF);
  }
  try { if (!sh.getFilter()) sh.getRange(hdrRow, 1, maxRows - hdrRow + 1, nCols).createFilter(); } catch (e) { Logger.log('Main filter skipped: ' + e.message); }
  return { rows: nRows, cols: nCols };
}

/** Menu: restyle the Main sheet (data, formulas and existing colours untouched). */
function runStyleMainSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const r = ab_styleMainSheet_();
    ss.setActiveSheet(ss.getSheetByName(AB_MAIN_SHEET));
    ss.toast('Main restyled (' + r.rows + ' stocks, ' + r.cols + ' columns). Data, formulas and your colours untouched.', 'Main', 8);
  } catch (e) {
    ss.toast('Could not style Main: ' + e.message);
  }
}

/*****************************************************************
 * BUY / AVOID SIGNAL FIX (negative EPS growth = Avoid)
 * -----------------------------------------------------------------
 * Main's TTM Signal (and Signal) formulas compared TargetPrice with the
 * market price. When EPS is NEGATIVE, "growth x EPS" turns the target
 * price positive and the row wrongly shows Buy. The new formula says
 * Avoid whenever EPS Growth is negative or EPS is zero/negative, and
 * otherwise works exactly as before. Only cells that already hold a
 * formula are rewritten; typed values and blank cells are left alone.
 *****************************************************************/
function ab_fixSignalFormulas_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(AB_MAIN_SHEET);
  if (!sh) throw new Error('Could not find a "' + AB_MAIN_SHEET + '" tab.');
  const head = sh.getRange(1, 1, 3, sh.getLastColumn()).getValues();
  let hdrRow = 0;
  for (let r = 0; r < 3; r++) {
    const row = head[r].map(function (v) { return String(v).trim(); });
    if (row.indexOf('StockName') !== -1 && row.indexOf('SYMBOL') !== -1) { hdrRow = r + 1; break; }
  }
  if (!hdrRow) throw new Error('Could not find the StockName/SYMBOL header row in Main.');
  const raw = head[hdrRow - 1].map(function (v) { return String(v).trim(); });
  const hv = raw.map(ab_normHeader_);
  // exact header first ("TargetPrice" and "Target Price" are two different columns), then a loose match
  const ix = function (n) { const e = raw.indexOf(n); return e !== -1 ? e : hv.indexOf(ab_normHeader_(n)); };
  const L = function (i) { return ab_colToLetter_(i + 1); };
  const price = ix('MKT Price'), sym = ix('SYMBOL');
  const sets = [
    { label: 'TTM Signal', sig: ix('TTM Signal'), eps: ix('TTM EPS'), gr: ix('TTM EPS Growth'), tgt: ix('TargetPrice') },
    { label: 'Signal', sig: ix('Signal'), eps: ix('EPS'), gr: ix('EPS Growth%'), tgt: ix('Target Price') }
  ];
  if (price === -1 || sym === -1) throw new Error('Main needs "MKT Price" and "SYMBOL" columns.');
  const first = hdrRow + 1;
  const n = sh.getMaxRows() - hdrRow;
  const symVals = sh.getRange(first, sym + 1, n, 1).getValues();
  const done = [];
  sets.forEach(function (s) {
    if (s.sig === -1 || s.eps === -1 || s.gr === -1 || s.tgt === -1) return;
    const rng = sh.getRange(first, s.sig + 1, n, 1);
    const cur = rng.getFormulas();
    let changed = 0;
    const out = cur.map(function (f, i) {
      const t = String(f[0]);
      if (t.charAt(0) !== '=' || String(symVals[i][0]).trim() === '') return [t];
      const r = first + i;
      const T = L(s.tgt) + r, P = L(price) + r, G = L(s.gr) + r, E = L(s.eps) + r;
      changed++;
      return ['=IFERROR(IF(OR(ISBLANK(' + T + '), ' + T + '=""), "", IF(OR(N(' + G + ')<0, N(' + E + ')<=0), "Avoid", ' +
              'IF(VALUE(' + T + ')<VALUE(' + P + '), "Avoid", IF(VALUE(' + T + ')>VALUE(' + P + '), "Buy", "")))), "")'];
    });
    if (changed) {
      // keep untouched cells (typed values) exactly as they were
      const vals = rng.getValues();
      rng.setFormulas(out.map(function (o, i) { return [o[0] !== '' ? o[0] : vals[i][0]]; }));
    }
    done.push(s.label + ': ' + changed + ' rows');
  });
  if (!done.length) throw new Error('Could not find the TTM Signal / TTM EPS / TTM EPS Growth / TargetPrice columns in Main.');
  return done;
}

/** Menu: rewrite the Buy/Avoid signal formulas so negative EPS growth is always Avoid. */
function runFixSignalFormulas() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const done = ab_fixSignalFormulas_();
    ss.toast('Signal formulas fixed - ' + done.join('; ') + '. Negative EPS growth now shows Avoid.', 'Main', 10);
  } catch (e) {
    ss.toast('Could not fix the signals: ' + e.message);
  }
}

/**
 * WEEKLY entry point - this is what the weekly trigger calls. Separate
 * from autoDailyUpdate on purpose: new IPOs list only a few times a
 * week, so this doesn't need to run nightly.
 *
 * After adding new symbols it also refreshes Main's Above/Below column
 * so the new rows aren't left blank until the next evening run, then
 * logs the outcome to "AutoFetch Log" (same log the daily run uses) so
 * there's a visible record of every weekly check, including quiet weeks
 * where nothing new listed.
 */
function weeklyIpoUpdate() {
  const ts = Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm');
  try {
    const added = syncNewIposFromChittorgarh_();

    if (added.length) {
      // Only worth re-running when something actually got added.
      try {
        fillIpoLevel_();
      } catch (levelErr) {
        Logger.log('fillIpoLevel_ after IPO sync failed: ' + levelErr.message);
      }
      if (AB_IPO_SYNC_EMAIL) sendIpoSyncEmail_(added, ts);
    }

    logRun_(ts, '', added.length, 'OK (weekly IPO sync)',
            added.length ? ('Added: ' + added.join(', ')) : 'No new IPOs found.');
  } catch (e) {
    logRun_(ts, '', 0, 'ERROR (weekly IPO sync)', e.message);
    Logger.log('Weekly IPO sync failed: ' + e.message);
    // Deliberately NOT rethrown - a third-party site being down shouldn't
    // show up as a red failed execution every week.
  }
}

/** Short heads-up email listing the IPOs that were just added. */
function sendIpoSyncEmail_(added, ts) {
  if (!added || !added.length) return;
  try {
    let html = '<div style="font-family:Arial,Helvetica,sans-serif;">';
    html += '<h2 style="margin:0 0 4px 0;">' + added.length + ' New IPO' + (added.length > 1 ? 's' : '') + ' Added</h2>';
    html += '<div style="color:#777;font-size:13px;margin-bottom:12px;">' + ts + ' IST</div>';
    html += '<ul style="font-size:14px;line-height:1.6;">';
    added.forEach(function (sym) {
      html += '<li><strong>' + sym + '</strong> &nbsp;' +
              '<a href="' + ab_chartUrl_(sym) + '">Chart</a> &middot; ' +
              '<a href="' + ab_screenerUrl_(sym) + '">Screener.in</a></li>';
    });
    html += '</ul>';
    html += '<div style="color:#999;font-size:12px;">Added to the IPOs tab with listing date and issue price. ' +
            'Add them to Main yourself if you want them on the watchlist.</div></div>';

    ab_sendMail_({
      to: AB_EMAIL_TO,
      subject: 'New IPO' + (added.length > 1 ? 's' : '') + ' listed - ' + added.join(', '),
      body: added.length + ' new IPO(s) added to the IPOs tab on ' + ts + ':\n\n' +
            added.map(function (s) { return '- ' + s + '\n    Chart: ' + ab_chartUrl_(s); }).join('\n'),
      htmlBody: html
    });
  } catch (e) {
    Logger.log('IPO sync email failed: ' + e.message);
  }
}

function installWeeklyIpoTrigger() {
  removeWeeklyIpoTrigger();
  // Change to ScriptApp.WeekDay.SATURDAY if you'd rather have it on
  // Saturday, then re-run this from the menu to apply the change.
  const day = ScriptApp.WeekDay.SUNDAY;
  ScriptApp.newTrigger('weeklyIpoUpdate')
    .timeBased()
    .onWeekDay(day)
    .atHour(AB_IPO_SYNC_HOUR)
    .inTimezone(AB_TZ)
    .create();
  SpreadsheetApp.getActiveSpreadsheet().toast(
    'Weekly IPO trigger installed - Sundays around ' + AB_IPO_SYNC_HOUR + ' AM IST.');
}

function removeWeeklyIpoTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'weeklyIpoUpdate') ScriptApp.deleteTrigger(t);
  });
}


/*****************************************************************
 * OHLC FETCH VIA GOOGLEFINANCE
 * -----------------------------------------------------------------
 * NSE's archive server blocks/stalls requests coming from Apps
 * Script's IP ranges (confirmed - UrlFetchApp just hangs there).
 * GOOGLEFINANCE runs inside Google's own infrastructure instead of
 * doing an external fetch, so it isn't blocked, and it's already
 * what the rest of your sheets use for price/volume. We use it here
 * to pull each symbol's last few days of daily OHLC directly.
 *****************************************************************/
function ab_toNum_(v) {
  const n = Number(v);
  return isNaN(n) ? NaN : n;
}

// GOOGLEFINANCE's date column sometimes comes back as a raw Sheets
// serial number instead of a JS Date - convert either form safely.
function ab_toJsDate_(v) {
  if (v instanceof Date) return v;
  const serial = Number(v);
  if (isNaN(serial)) return null;
  // Sheets epoch is 1899-12-30; 25569 = days between that and 1970-01-01
  return new Date(Math.round((serial - 25569) * 86400 * 1000));
}

/**
 * Reads a date cell that might be a real Date, a Sheets serial, or
 * TEXT - without letting JavaScript silently swap the day and month.
 *
 * The trap: new Date("12/04/2025") returns 4 DECEMBER, because the JS
 * parser assumes American month-first order. Every date in this sheet
 * is written day-first, so a text cell like "12/04/2025" meaning 12
 * April was being read five months out, and any code that wrote it
 * back stored the wrong day. That is exactly how a listing date can
 * appear to change by itself.
 *
 * Order of interpretation:
 *   real Date / Sheets serial -> used as-is, no parsing at all
 *   yyyy-mm-dd                -> unambiguous, taken literally
 *   d/m/y                     -> DAY FIRST, unless the numbers make
 *                                that impossible (e.g. 25/12 can only
 *                                be day-first; 12/25 only month-first)
 *   anything else             -> handed to the JS parser, which is
 *                                safe for spelled-out months
 */
function ab_mkDate_(y, mo, d) {
  if (!y || !mo || !d || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, mo - 1, d);
  return isNaN(dt.getTime()) ? null : dt;
}

function ab_parseDate_(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (Object.prototype.toString.call(raw) === '[object Date]') {
    return isNaN(raw.getTime()) ? null : raw;
  }
  if (typeof raw === 'number') return ab_toJsDate_(raw);

  const s = String(raw).trim();
  if (!s) return null;

  // ISO first - no ambiguity possible.
  let m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (m) return ab_mkDate_(Number(m[1]), Number(m[2]), Number(m[3]));

  m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    if (a > 12 && b <= 12) return ab_mkDate_(y, b, a); // first can only be a day
    if (b > 12 && a <= 12) return ab_mkDate_(y, a, b); // second can only be a day
    return ab_mkDate_(y, b, a);                        // ambiguous -> day first
  }

  const p = new Date(s); // "12 Apr 2025" and similar
  return isNaN(p.getTime()) ? null : p;
}

const AB_SCRATCH_SHEET = 'GF_Scratch';

function ab_getScratchSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(AB_SCRATCH_SHEET);
  if (!sh) {
    sh = ss.insertSheet(AB_SCRATCH_SHEET);
    sh.hideSheet();
  }
  return sh;
}


/**
 * For every symbol currently in PatternData, fetches its last 4 trading
 * days via GOOGLEFINANCE and writes them straight into the
 * Day4/ThirdDay/Yesterday/Today tabs (oldest -> newest). Unlike the
 * old bhavcopy approach, this always rebuilds the full window fresh
 * from the source data each run, so there's no rotation/state to
 * maintain or get out of sync.
 *
 * IMPORTANT: this batches all symbols into ONE flush() instead of
 * one flush() per symbol. Each flush() is a real round-trip (Sheets
 * recalculation + GOOGLEFINANCE fetch) and doing 40+ of them
 * sequentially blew past Apps Script's 6-minute execution cap.
 * Writing every formula first, flushing once, then reading
 * everything in one shot is dramatically faster.
 */
const AB_ROWS_PER_BLOCK = 20; // headroom for ~15 trading days + header
const AB_BLOCK_COLS = 6;      // GOOGLEFINANCE "all" -> Date,Open,High,Low,Close,Volume

function refreshAllOHLC_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet2 = ss.getSheetByName(AB_PATTERN_SHEET);
  const lastRow = sheet2.getLastRow();
  const symbols = lastRow > 1
    ? sheet2.getRange(2, 4, lastRow - 1, 1).getValues().flat()
        .map(v => String(v).trim().toUpperCase()).filter(Boolean)
    : [];

  const byTab = { Day4: [], ThirdDay: [], Yesterday: [], Today: [] };
  const failed = [];
  let asOfDate = '';

  if (!symbols.length) {
    return { symbolCount: 0, failed: [], asOfDate: '' };
  }

  const scratch = ab_getScratchSheet_();
  const totalRows = symbols.length * AB_ROWS_PER_BLOCK;

  scratch.clearContents();
  if (scratch.getMaxRows() < totalRows) {
    scratch.insertRowsAfter(scratch.getMaxRows(), totalRows - scratch.getMaxRows());
  }
  if (scratch.getMaxColumns() < AB_BLOCK_COLS) {
    scratch.insertColumnsAfter(scratch.getMaxColumns(), AB_BLOCK_COLS - scratch.getMaxColumns());
  }

  // Write every symbol's formula first - no flush yet, this is fast.
  symbols.forEach((symbol, i) => {
    const startRow = i * AB_ROWS_PER_BLOCK + 1;
    scratch.getRange(startRow, 1).setFormula(
      '=IFERROR(GOOGLEFINANCE("NSE:' + symbol + '","all",TODAY()-15,TODAY(),"DAILY"),"")'
    );
  });

  SpreadsheetApp.flush(); // ONE flush for every symbol, not 41

  // Read the whole scratch block in a single call.
  const allValues = scratch.getRange(1, 1, totalRows, AB_BLOCK_COLS).getValues();

  symbols.forEach((symbol, i) => {
    const startRow = i * AB_ROWS_PER_BLOCK;
    const block = allValues.slice(startRow, startRow + AB_ROWS_PER_BLOCK);
    const rows = block.filter(r => r[0] !== '' && r[0] !== null && String(r[0]).toLowerCase() !== 'date');

    const candles = rows.map(r => ({
      date: r[0],
      Opn: ab_toNum_(r[1]),
      High: ab_toNum_(r[2]),
      Low: ab_toNum_(r[3]),
      Cls: ab_toNum_(r[4]),
      // Column 6 of GOOGLEFINANCE "all". Was previously fetched and
      // thrown away; kept now so Prev Day Vol comes from the same
      // snapshot as the prices instead of a separate lookup that can
      // drift a day out of step with them.
      Vol: ab_toNum_(r[5])
    })).filter(c => !isNaN(c.Opn) && !isNaN(c.Cls));

    if (!candles.length) { failed.push(symbol); return; }

    // Take the last 4 available trading days (oldest -> newest)
    const last4 = candles.slice(-4);
    // Right-align against AB_DAY_TABS so a symbol with fewer than 4
    // days of history (e.g. recent IPO) still lands on 'Today'
    const tabsForThisSymbol = AB_DAY_TABS.slice(AB_DAY_TABS.length - last4.length);

    last4.forEach((c, j) => {
      byTab[tabsForThisSymbol[j]].push([symbol, c.Opn, c.High, c.Low, c.Cls,
                                        isNaN(c.Vol) ? '' : c.Vol]);
      if (tabsForThisSymbol[j] === 'Today' && c.date) {
        const d = ab_toJsDate_(c.date);
        if (d) asOfDate = Utilities.formatDate(d, AB_TZ, 'dd-MMM-yyyy');
      }
    });
  });

  AB_DAY_TABS.forEach(tab => writeOHLCSheet_(tab, byTab[tab]));
  scratch.clearContents();

  return { symbolCount: symbols.length - failed.length, failed: failed, asOfDate: asOfDate };
}

/*****************************************************************
 * 30-DAY HISTORY - separate from the 4-day pattern-detection tabs.
 * Doesn't touch Day4/ThirdDay/Yesterday/Today or PatternData's pattern
 * logic at all; just writes a long-format history table (one row
 * per symbol per day) to its own "History30" tab for reference,
 * charting, or backtesting. Same write-all-formulas/one-flush/
 * one-read batching as refreshAllOHLC_, sized for ~30 trading days
 * instead of 4.
 *****************************************************************/
function ab_getOrCreateSheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

function fetchHistory30_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet2 = ss.getSheetByName(AB_PATTERN_SHEET);
  const lastRow = sheet2.getLastRow();
  const symbols = lastRow > 1
    ? sheet2.getRange(2, 4, lastRow - 1, 1).getValues().flat()
        .map(v => String(v).trim().toUpperCase()).filter(Boolean)
    : [];

  if (!symbols.length) {
    SpreadsheetApp.getActiveSpreadsheet().toast('No symbols in PatternData - run "Sync Symbols" first.');
    return;
  }

  const scratch = ab_getScratchSheet_();
  const totalRows = symbols.length * AB_HISTORY_ROWS_PER_BLOCK;

  scratch.clearContents();
  if (scratch.getMaxRows() < totalRows) {
    scratch.insertRowsAfter(scratch.getMaxRows(), totalRows - scratch.getMaxRows());
  }
  if (scratch.getMaxColumns() < AB_BLOCK_COLS) {
    scratch.insertColumnsAfter(scratch.getMaxColumns(), AB_BLOCK_COLS - scratch.getMaxColumns());
  }

  // Write every symbol's formula first - no flush yet.
  symbols.forEach((symbol, i) => {
    const startRow = i * AB_HISTORY_ROWS_PER_BLOCK + 1;
    scratch.getRange(startRow, 1).setFormula(
      '=IFERROR(GOOGLEFINANCE("NSE:' + symbol + '","all",TODAY()-' +
      AB_HISTORY_LOOKBACK_DAYS + ',TODAY(),"DAILY"),"")'
    );
  });

  SpreadsheetApp.flush(); // ONE flush for every symbol

  const allValues = scratch.getRange(1, 1, totalRows, AB_BLOCK_COLS).getValues();

  const outRows = []; // Symbol, Date, Open, High, Low, Close, Volume
  const failed = [];

  symbols.forEach((symbol, i) => {
    const startRow = i * AB_HISTORY_ROWS_PER_BLOCK;
    const block = allValues.slice(startRow, startRow + AB_HISTORY_ROWS_PER_BLOCK);
    const rows = block.filter(r => r[0] !== '' && r[0] !== null && String(r[0]).toLowerCase() !== 'date');

    const candles = rows.map(r => ({
      date: r[0],
      Opn: ab_toNum_(r[1]),
      High: ab_toNum_(r[2]),
      Low: ab_toNum_(r[3]),
      Cls: ab_toNum_(r[4]),
      Vol: ab_toNum_(r[5])
    })).filter(c => !isNaN(c.Opn) && !isNaN(c.Cls));

    if (!candles.length) { failed.push(symbol); return; }

    // Take the last 30 trading days available (oldest -> newest)
    candles.slice(-30).forEach(c => {
      const d = ab_toJsDate_(c.date);
      outRows.push([
        symbol,
        d ? Utilities.formatDate(d, AB_TZ, 'yyyy-MM-dd') : '',
        c.Opn, c.High, c.Low, c.Cls, isNaN(c.Vol) ? '' : c.Vol
      ]);
    });
  });

  const historySheet = ab_getOrCreateSheet_(AB_HISTORY_SHEET);
  historySheet.clearContents();
  historySheet.getRange(1, 1, 1, 7)
    .setValues([['Symbol', 'Date', 'Open', 'High', 'Low', 'Close', 'Volume']]);
  if (outRows.length) {
    historySheet.getRange(2, 1, outRows.length, 7).setValues(outRows);
  }

  scratch.clearContents();

  SpreadsheetApp.getActiveSpreadsheet().toast(
    'History30 updated: ' + (symbols.length - failed.length) + ' symbols, ' + outRows.length + ' rows.' +
    (failed.length ? (' No data for: ' + failed.join(', ')) : '')
  );
}

/**
 * ONE Google Finance fetch that feeds BOTH the 4-day tabs (Day4 /
 * ThirdDay / Yesterday / Today) and History30. The daily pipeline used
 * to fetch every symbol twice (refreshAllOHLC_ then fetchHistory30_);
 * the 45-day fetch already contains the last 4 candles, so the second
 * pass was pure waiting. Same outputs, same "failed" rule (a symbol whose
 * last candle is older than 15 days is left out of the 4-day tabs, as
 * the old 15-day fetch did), roughly half the time.
 * Returns { symbolCount, failed, asOfDate } like refreshAllOHLC_.
 */
function ab_refreshOhlcAndHistory_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet2 = ss.getSheetByName(AB_PATTERN_SHEET);
  const lastRow = sheet2.getLastRow();
  const symbols = lastRow > 1
    ? sheet2.getRange(2, 4, lastRow - 1, 1).getValues().flat()
        .map(v => String(v).trim().toUpperCase()).filter(Boolean)
    : [];
  if (!symbols.length) return { symbolCount: 0, failed: [], asOfDate: '' };

  const scratch = ab_getScratchSheet_();
  const totalRows = symbols.length * AB_HISTORY_ROWS_PER_BLOCK;
  scratch.clearContents();
  if (scratch.getMaxRows() < totalRows) {
    scratch.insertRowsAfter(scratch.getMaxRows(), totalRows - scratch.getMaxRows());
  }
  if (scratch.getMaxColumns() < AB_BLOCK_COLS) {
    scratch.insertColumnsAfter(scratch.getMaxColumns(), AB_BLOCK_COLS - scratch.getMaxColumns());
  }

  symbols.forEach((symbol, i) => {
    scratch.getRange(i * AB_HISTORY_ROWS_PER_BLOCK + 1, 1).setFormula(
      '=IFERROR(GOOGLEFINANCE("NSE:' + symbol + '","all",TODAY()-' +
      AB_HISTORY_LOOKBACK_DAYS + ',TODAY(),"DAILY"),"")'
    );
  });
  SpreadsheetApp.flush(); // ONE flush for every symbol
  const allValues = scratch.getRange(1, 1, totalRows, AB_BLOCK_COLS).getValues();

  const cut = new Date(); cut.setDate(cut.getDate() - 15);
  const cutKey = Utilities.formatDate(cut, AB_TZ, 'yyyyMMdd');

  const byTab = { Day4: [], ThirdDay: [], Yesterday: [], Today: [] };
  const outRows = [];
  const failed = [];
  let asOfKey = '', asOfDate = '';

  symbols.forEach((symbol, i) => {
    const startRow = i * AB_HISTORY_ROWS_PER_BLOCK;
    const block = allValues.slice(startRow, startRow + AB_HISTORY_ROWS_PER_BLOCK);
    const rows = block.filter(r => r[0] !== '' && r[0] !== null && String(r[0]).toLowerCase() !== 'date');
    const candles = rows.map(r => ({
      date: r[0], Opn: ab_toNum_(r[1]), High: ab_toNum_(r[2]), Low: ab_toNum_(r[3]),
      Cls: ab_toNum_(r[4]), Vol: ab_toNum_(r[5])
    })).filter(c => !isNaN(c.Opn) && !isNaN(c.Cls));

    // History30 (any symbol with at least one candle in 45 days)
    if (!candles.length) { failed.push(symbol); return; }
    candles.slice(-30).forEach(c => {
      const d = ab_toJsDate_(c.date);
      outRows.push([symbol, d ? Utilities.formatDate(d, AB_TZ, 'yyyy-MM-dd') : '',
                    c.Opn, c.High, c.Low, c.Cls, isNaN(c.Vol) ? '' : c.Vol]);
    });

    // 4-day tabs: only candles from the last 15 calendar days (same window as before)
    const recent = candles.filter(c => {
      const d = ab_toJsDate_(c.date);
      return !d || Utilities.formatDate(d, AB_TZ, 'yyyyMMdd') >= cutKey;
    });
    if (!recent.length) { failed.push(symbol); return; }
    const last4 = recent.slice(-4);
    const tabsForThisSymbol = AB_DAY_TABS.slice(AB_DAY_TABS.length - last4.length);
    last4.forEach((c, j) => {
      byTab[tabsForThisSymbol[j]].push([symbol, c.Opn, c.High, c.Low, c.Cls, isNaN(c.Vol) ? '' : c.Vol]);
      if (tabsForThisSymbol[j] === 'Today' && c.date) {
        const d = ab_toJsDate_(c.date);
        if (d) {
          const k = Utilities.formatDate(d, AB_TZ, 'yyyyMMdd');
          if (k >= asOfKey) { asOfKey = k; asOfDate = Utilities.formatDate(d, AB_TZ, 'dd-MMM-yyyy'); }
        }
      }
    });
  });

  AB_DAY_TABS.forEach(tab => writeOHLCSheet_(tab, byTab[tab]));

  const historySheet = ab_getOrCreateSheet_(AB_HISTORY_SHEET);
  historySheet.clearContents();
  historySheet.getRange(1, 1, 1, 7).setValues([['Symbol', 'Date', 'Open', 'High', 'Low', 'Close', 'Volume']]);
  if (outRows.length) historySheet.getRange(2, 1, outRows.length, 7).setValues(outRows);

  scratch.clearContents();
  return { symbolCount: symbols.length - failed.length, failed: failed, asOfDate: asOfDate };
}

/*****************************************************************
 * LONG-ONLY FVG "FIRST TOUCH" / "FIRST TOUCH CONFIRMED"
 * -----------------------------------------------------------------
 * Ported from the "ICT Fair Value Gap (FVG) Scanner v2" Pine Script
 * (Arun_K_Bhaskar) - LONG/BULLISH side only, and only the "First
 * Touch" and "First Touch Confirmed" signals (no FVG %, Full Fill,
 * Full Fill Confirmed, or Reversal, and no bearish/short side).
 *
 * Rule: a bullish Fair Value Gap can FORM on any of the last 30
 * trading days (from History30). But the symbol is only tagged if
 * the First Touch / First Touch Confirmed EVENT itself happened on
 * one of the last 4 trading days available in that 30-day window -
 * an old gap that was touched weeks ago does not get tagged again.
 *
 * Bullish FVG (3-candle gap): low[i] > high[i-2], gap size >= 70% of
 * the 14-bar average high-low range (matches the Pine Script's
 * "Minimal Deviation" default). Once formed, that gap's top/bottom
 * persist (like Pine's `var`) until a newer gap overwrites them.
 *   - First Touch: price's Low crosses back down under the gap's
 *     top edge for the first time after the gap formed.
 *   - First Touch Confirmed: price's Close later crosses back above
 *     the High of the candle that made that first touch.
 * Both are 2/3-state machines that reset once they fire, exactly
 * mirroring the Pine Script's `var ..._current_state` logic.
 *
 * FVG+Spring (custom, your own definition): a 'Spring' candle pair -
 * the same test and Control Panel thresholds as the Spring pattern
 * (ab_isSpringPair_: a big red candle, then a small candle that fakes
 * a breakdown below its low and closes back above it) - whose 2nd
 * candle dips into ANY bullish gap formed earlier in the 30-day
 * window, touched before (mitigated) or not (unmitigated), while that
 * gap still holds: no close below the gap's bottom between the gap and
 * the pair, the Spring candle's low reaches the gap top or lower, and
 * it closes back at or above the gap bottom.
 *
 * FVG Unmitigated (custom): the most recent gap somewhere in the
 * 30-day window that has never been touched at all, right up through
 * today - i.e. it's still sitting there completely untouched. Unlike
 * the other tags this isn't gated to "happened in the last 4 days" -
 * it's a still-true-as-of-today state check, so it stays tagged for
 * as long as the gap remains untouched.
 *****************************************************************/
function ab_longFvgDetail_(candles) {
  const n = (candles || []).length;
  // Not enough bars for a reliable 14-bar average range + gap + touch.
  if (n < 17) return { tags: [], unmitigated: null };

  // 14-bar average high-low range, computed causally at each bar,
  // then 70% of it = minimal gap size (matches Pine Script default).
  const minDeviation = new Array(n).fill(NaN);
  for (let i = 13; i < n; i++) {
    let sum = 0;
    for (let k = i - 13; k <= i; k++) sum += (candles[k].High - candles[k].Low);
    minDeviation[i] = 0.70 * (sum / 14);
  }

  // Detect bullish gaps and carry the active gap's top/bottom forward
  // (persisted, like Pine's `var`) until a newer gap overwrites them.
  const isFVGUp = new Array(n).fill(false);
  const fvgTop = new Array(n).fill(NaN);
  let curTop = NaN, curBottom = NaN;
  for (let i = 0; i < n; i++) {
    let up = false;
    if (i >= 2 && !isNaN(minDeviation[i])) {
      const low = candles[i].Low, highTwoBack = candles[i - 2].High;
      if (low > highTwoBack && (low - highTwoBack) >= minDeviation[i]) up = true;
    }
    isFVGUp[i] = up;
    if (up) curTop = candles[i].Low; // isFVGUp_top := low
    fvgTop[i] = curTop;
  }

  // First touch = Low crosses under the active gap's top edge.
  const longCont2 = new Array(n).fill(false);
  const cont2High = new Array(n).fill(NaN);
  let curCont2High = NaN;
  for (let i = 1; i < n; i++) {
    if (!isNaN(fvgTop[i - 1]) && !isNaN(fvgTop[i]) &&
        candles[i - 1].Low >= fvgTop[i - 1] && candles[i].Low < fvgTop[i]) {
      longCont2[i] = true;
    }
    if (longCont2[i]) curCont2High = candles[i].High;
    cont2High[i] = curCont2High;
  }

  // First touch confirmed = Close later crosses back above the High
  // of the candle that made the first touch.
  const longCont2Conf = new Array(n).fill(false);
  for (let i = 1; i < n; i++) {
    if (!isNaN(cont2High[i - 1]) && !isNaN(cont2High[i]) &&
        candles[i - 1].Cls <= cont2High[i - 1] && candles[i].Cls > cont2High[i]) {
      longCont2Conf[i] = true;
    }
  }

  // FVG+Spring: a Spring pair (c1 = i-1, c2 = i) whose c2 dips into any
  // gap formed before c1 that still holds (see the header above).
  const springCfg = ab_springCfg_();
  const springSignal = new Array(n).fill(false);
  for (let i = 3; i < n; i++) {
    if (!ab_isSpringPair_(candles[i - 1], candles[i], springCfg)) continue;
    const c2 = candles[i];
    for (let g = 2; g <= i - 2 && !springSignal[i]; g++) {
      if (!isFVGUp[g]) continue;
      const top = candles[g].Low, bottom = candles[g - 2].High;
      if (!(c2.Low <= top && c2.Cls >= bottom)) continue;
      let holds = true;
      for (let k = g + 1; k <= i - 2; k++) {
        if (candles[k].Cls < bottom) { holds = false; break; }
      }
      if (holds) springSignal[i] = true;
    }
  }

  // State machine: First Touch (fires once per gap, then resets)
  const ftSignal = new Array(n).fill(false);
  let ftState = 0;
  for (let i = 0; i < n; i++) {
    let cur = (ftState === 2) ? 0 : ftState;
    if (isFVGUp[i] && cur === 0) cur = 1;
    if (longCont2[i] && cur === 1) cur = 2;
    ftSignal[i] = (cur === 2);
    ftState = cur;
  }

  // State machine: First Touch Confirmed
  const ftcSignal = new Array(n).fill(false);
  let ftcState = 0;
  for (let i = 0; i < n; i++) {
    let cur = (ftcState === 3) ? 0 : ftcState;
    if (isFVGUp[i] && cur === 0) cur = 1;
    if (longCont2[i] && cur === 1) cur = 2;
    if (longCont2Conf[i] && cur === 2) cur = 3;
    ftcSignal[i] = (cur === 3);
    ftcState = cur;
  }

  // Only tag if the signal fired on one of the last 4 available bars -
  // and remember exactly which bar, so the tag can say how fresh it is
  // (spot brand-new setups without opening every chart).
  const lastN = Math.min(4, n);
  let touchIdx = -1, confIdx = -1, springIdx = -1;
  for (let i = n - lastN; i < n; i++) {
    if (ftSignal[i]) touchIdx = i;   // keeps the most recent occurrence
    if (ftcSignal[i]) confIdx = i;
    if (springSignal[i]) springIdx = i;
  }

  // FVG Unmitigated: the most recent gap in the whole 30-day window that
  // has NEVER been touched (no longCont2 event) from the day it formed
  // all the way through today. Not restricted to the last-4-day window -
  // this is a "still true as of today" state check, not a recent event.
  let lastGapIdx = -1;
  for (let i = 0; i < n; i++) {
    if (isFVGUp[i]) lastGapIdx = i; // keeps the most recently formed gap
  }
  let unmitigated = false;
  if (lastGapIdx !== -1) {
    unmitigated = true;
    for (let i = lastGapIdx + 1; i < n; i++) {
      if (longCont2[i]) { unmitigated = false; break; }
    }
  }

  function recencyLabel_(idx) {
    const daysAgo = (n - 1) - idx;
    return daysAgo === 0 ? '(Today)' : '(' + daysAgo + 'd ago)';
  }

  const tags = [];
  if (touchIdx !== -1) tags.push('FVG First Touch ' + recencyLabel_(touchIdx));
  if (confIdx !== -1) tags.push('FVG First Touch Confirmed ' + recencyLabel_(confIdx));
  if (springIdx !== -1) tags.push('FVG+Spring ' + recencyLabel_(springIdx));

  // The unmitigated gap's actual PRICE LEVELS, taken from the very same
  // state machine that decided the tag. Anything that wants to watch
  // this zone must read it from here rather than re-deriving it, or the
  // watch list and the FVG column would sooner or later disagree about
  // which symbols are unmitigated.
  let unmitZone = null;
  if (unmitigated) {
    const daysAgo = (n - 1) - lastGapIdx;
    tags.push('FVG Unmitigated ' + (daysAgo === 0 ? '(formed today)' : '(formed ' + daysAgo + 'd ago)'));
    const bottom = lastGapIdx >= 2 ? candles[lastGapIdx - 2].High : NaN;
    const top = candles[lastGapIdx].Low;
    if (!isNaN(bottom) && !isNaN(top) && bottom > 0 && top > bottom) {
      unmitZone = {
        bottom: bottom,
        top: top,
        pct: Math.round((top - bottom) / bottom * 10000) / 100,
        formedIdx: lastGapIdx,
        daysAgo: daysAgo
      };
    }
  }

  return { tags: tags, unmitigated: unmitZone };
}

/** Tags only - what the FVG column has always been written from. */
function ab_computeLongFVGTouchTags_(candles) {
  return ab_longFvgDetail_(candles).tags;
}

/**
 * Reads History30 (already refreshed by fetchHistory30_ earlier in the
 * same run), groups it by symbol, and writes the long-only FVG touch
 * tags into PatternData column X - a column of its own, separate from the
 * existing Pattern column (W) and its 12-pattern engine.
 */
function computeLongFVGTouchPatterns_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const historySheet = ss.getSheetByName(AB_HISTORY_SHEET);
  const sheet2 = ss.getSheetByName(AB_PATTERN_SHEET);
  if (!historySheet) {
    Logger.log('History30 sheet not found - run "Fetch Last 30 Days OHLC" first.');
    return;
  }

  const histData = historySheet.getDataRange().getValues();
  histData.shift(); // header row

  const bySymbol = {}; // symbol -> [{Opn,High,Low,Cls}, ...] oldest -> newest
  histData.forEach(r => {
    const sym = String(r[0]).trim().toUpperCase();
    if (!sym) return;
    if (!bySymbol[sym]) bySymbol[sym] = [];
    bySymbol[sym].push({
      Opn: ab_toNum_(r[2]),
      High: ab_toNum_(r[3]),
      Low: ab_toNum_(r[4]),
      Cls: ab_toNum_(r[5])
    });
  });

  const data = sheet2.getDataRange().getValues();
  sheet2.getRange(1, AB_COL_LONGFVG).setValue('Long FVG Touch'); // header, safe to re-set every run

  for (let i = 1; i < data.length; i++) {
    const symbol = String(data[i][3]).trim().toUpperCase(); // col D
    if (!symbol) continue;
    const candles = bySymbol[symbol] || [];
    // Both gap families share this column - the 3-candle ICT gaps above
    // and the plain consecutive-day gap-ups. Same candles, one write.
    const tags = ab_computeLongFVGTouchTags_(candles).concat(ab_gapUpTags_(candles));
    sheet2.getRange(i + 1, AB_COL_LONGFVG).setValue(tags.join(', '));
  }
}

/*****************************************************************
 * GAP-UP FVG
 * -----------------------------------------------------------------
 * A different, simpler gap than the 3-candle ICT gap above: a plain
 * overnight gap up between two CONSECUTIVE trading days.
 *
 *   Day 1 high = the gap's BOTTOM
 *   Day 2 low  = the gap's TOP
 *   gap size   = (day2Low - day1High) / day1High * 100
 *
 * Only gaps between AB_GAPUP_MIN_PCT and AB_GAPUP_MAX_PCT count -
 * anything smaller is noise, anything larger is usually news or a
 * corporate action rather than a tradeable imbalance.
 *
 * A gap only counts while it is COMPLETELY UNTOUCHED. If any later
 * candle has traded at or below the gap top - even a wick - the
 * imbalance has been visited, and it is dropped entirely: no longer
 * listed, no longer alerted, never revived. What you want is the
 * FIRST return to a virgin zone; a second or third visit is a
 * different, weaker setup.
 *
 * That one condition also gives "approach from above" for free. If
 * price has never traded at or below the gap top, it cannot be
 * anywhere but above the zone - so an approach is always a fall back
 * toward it, never a rise up into it from underneath. It equally
 * handles a later gap DOWN straight past the zone: that candle's low
 * sits below the gap top, so the gap is retired without any special
 * case for it.
 *
 * The alert therefore fires at most once per gap, when live price
 * first comes within AB_GAPUP_NEAR_PCT above the top or enters the
 * zone. It never re-arms.
 *****************************************************************/
const AB_GAPUP_SHEET = 'GapUpFVG';
const AB_GAPUP_MIN_PCT = ab_setting_('AB_GAPUP_MIN_PCT', 3);   // smallest gap worth tracking
const AB_GAPUP_MAX_PCT = ab_setting_('AB_GAPUP_MAX_PCT', 10);   // largest - beyond this it's news, not an imbalance
const AB_GAPUP_NEAR_PCT = ab_setting_('AB_GAPUP_NEAR_PCT', 0.5);  // how far above the gap top counts as "approaching"

// A gap formed by TODAY's own candle has today's Close sitting just a
// hair above today's Low - and today's Low IS the gap top by
// definition. So on the very day it forms, price is ALWAYS trivially
// "near" its own top - that's not a retest, it's just the candle that
// made the gap in the first place. Mirrors AB_UNMIT_MIN_AGE_DAYS below:
// give a gap at least this many days to be left alone and then
// genuinely approached from above before it's added to the watch list.
// (06-Oct-2026 - was missing here, which is why MMWL's gap, formed
// today, showed up in the very same evening's "Gap-up FVG Approaching"
// section.) This filters the WATCH LIST only - the FVG column still
// tags a same-day gap as a gap-up, because it is one.
const AB_GAPUP_MIN_AGE_DAYS = ab_setting_('AB_GAPUP_MIN_AGE_DAYS', 1);

// A candle whose whole high-low range is this small (as a % of price)
// is treated as circuit-locked: open, high, low and close all at the
// same number means the stock never actually traded, it just sat at the
// band limit all session. Detected by the flat range rather than by the
// move being 4.99% or 5% or 10%, because circuit limits differ per
// stock (2/5/10/20%) and a percentage test would need all of them.
// A small tolerance rather than exact equality guards against rounding
// in the feed, and catches the near-frozen illiquid days too.
const AB_CIRCUIT_LOCK_RANGE_PCT = ab_setting_('AB_CIRCUIT_LOCK_RANGE_PCT', 0.05);

/** Did this candle never really trade - locked at a circuit band? */
function ab_isCircuitLocked_(candle) {
  if (!candle) return false;
  const hi = candle.High, lo = candle.Low;
  if (isNaN(hi) || isNaN(lo) || lo <= 0) return false;
  return (hi - lo) / lo * 100 <= AB_CIRCUIT_LOCK_RANGE_PCT;
}

// Minimum average daily turnover (price x volume, in Rs, over whatever
// of the History30 window is available, skipping circuit-locked days -
// see ab_avgTurnover_) a symbol needs before its Gap-up/Unmitigated FVG
// zones are watched at all. Below this, a "gap" or "mitigation" is more
// likely a thinly-traded stock lurching between circuit bands than a
// real, fillable setup - exactly the RELINFRA/MMWL kind of alert this
// exists to filter out. Tune in the Control Panel; a symbol with NO
// volume data at all is let through rather than silently dropped (same
// fail-open convention as ab_daysSince_ returning Infinity).
const AB_FVG_MIN_AVG_TURNOVER = ab_setting_('AB_FVG_MIN_AVG_TURNOVER', 5000000);

/**
 * Reads History30 once into { SYMBOL: [{date,Opn,High,Low,Cls,Volume}, ...] },
 * oldest -> newest, exactly as the sheet is written. The single place
 * that knows History30's column layout - computeGapUpFvgs_,
 * computeUnmitigatedFvgs_ and ab_todaysCircuitLockedSymbols_ all read
 * through this rather than each re-parsing the sheet their own way.
 */
function ab_readHistoryCandles_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const historySheet = ss.getSheetByName(AB_HISTORY_SHEET);
  const bySymbol = {};
  if (!historySheet) return bySymbol;
  const histData = historySheet.getDataRange().getValues();
  const histHeader = histData.shift() || [];
  const dateIdx = histHeader.indexOf('Date');
  histData.forEach(function (r) {
    const sym = String(r[0] || '').trim().toUpperCase();
    if (!sym) return;
    if (!bySymbol[sym]) bySymbol[sym] = [];
    bySymbol[sym].push({
      date: dateIdx === -1 ? '' : r[dateIdx],
      Opn: ab_toNum_(r[2]), High: ab_toNum_(r[3]),
      Low: ab_toNum_(r[4]), Cls: ab_toNum_(r[5]), Volume: ab_toNum_(r[6])
    });
  });
  return bySymbol;
}

/**
 * Average daily turnover (mid-price x volume) across whatever of
 * `candles` are usable, deliberately SKIPPING circuit-locked days -
 * a frozen day's printed volume is typically just a handful of trades
 * at the band, not a real market, and would otherwise flatter an
 * illiquid stock's average. Returns NaN (never 0) when nothing usable
 * is found, so a symbol with no volume data fails OPEN, not closed.
 */
function ab_avgTurnover_(candles) {
  if (!candles || !candles.length) return NaN;
  let sum = 0, n = 0;
  candles.forEach(function (c) {
    if (ab_isCircuitLocked_(c)) return;
    const mid = (c.High + c.Low) / 2;
    if (isNaN(mid) || mid <= 0 || isNaN(c.Volume) || c.Volume <= 0) return;
    sum += mid * c.Volume;
    n++;
  });
  return n ? sum / n : NaN;
}

/**
 * Symbols whose MOST RECENT History30 candle is circuit-locked right
 * now (today's, once Phase 1 has refreshed it; otherwise whatever the
 * last fetched day was). Used to hold back the live approach/mitigation
 * checks - ab_checkZoneAlerts_ / ab_checkZoneMitigatedAlerts_ - from
 * firing off Main's live price when that price is just a frozen
 * circuit print, not a genuine fill. Mirrors the same reasoning
 * ab_isCircuitLocked_'s other callers already use, applied to the one
 * place (the live check) that doesn't otherwise see real OHLC at all.
 */
function ab_todaysCircuitLockedSymbols_() {
  const bySymbol = ab_readHistoryCandles_();
  const locked = {};
  Object.keys(bySymbol).forEach(function (sym) {
    const candles = bySymbol[sym];
    const today = candles.length ? candles[candles.length - 1] : null;
    if (ab_isCircuitLocked_(today)) locked[sym] = true;
  });
  return locked;
}

/**
 * Every UNTOUCHED gap-up in one symbol's candle series, oldest last.
 * `candles` is oldest -> newest, as built from History30.
 *
 * Returns [{ bottom, top, pct, formedIdx, daysAgo }], NEWEST FIRST - a
 * stock can have several open gaps at once (all are tracked); the most
 * recently formed one leads. A gap that any
 * later candle has traded into - low at or below the gap top - is
 * dropped, however briefly it was visited.
 */
function ab_gapUpFvgs_(candles) {
  const out = [];
  const n = (candles || []).length;
  if (n < 2) return out;

  for (let i = 1; i < n; i++) {
    // Either side circuit-locked and the gap isn't real. A locked day
    // has no genuine high or low - the price simply stopped at the band
    // - so measuring an imbalance off it produces a zone nobody could
    // have traded into or out of.
    if (ab_isCircuitLocked_(candles[i - 1]) || ab_isCircuitLocked_(candles[i])) continue;

    const prevHigh = candles[i - 1].High;
    const low = candles[i].Low;
    if (isNaN(prevHigh) || isNaN(low) || prevHigh <= 0) continue;
    if (low <= prevHigh) continue; // no gap at all

    const pct = (low - prevHigh) / prevHigh * 100;
    if (pct < AB_GAPUP_MIN_PCT || pct > AB_GAPUP_MAX_PCT) continue;

    // Has anything since come back down to it? Comparing against the
    // gap TOP (not the bottom) means a wick that only clips the upper
    // edge still counts as touched - the zone is no longer virgin, and
    // a virgin zone is the whole point. The scan starts at i+1 because
    // the gap candle's own low IS the top by definition. A circuit-
    // locked day is skipped here too, same reasoning as the formation
    // check above: its "Low" is just the frozen band price, not a real
    // trade down into the zone, so it can't be what mitigates it.
    let touched = false;
    for (let j = i + 1; j < n; j++) {
      if (ab_isCircuitLocked_(candles[j])) continue;
      if (!isNaN(candles[j].Low) && candles[j].Low <= low) { touched = true; break; }
    }
    if (touched) continue;

    out.push({
      bottom: prevHigh,
      top: low,
      pct: Math.round(pct * 100) / 100,
      formedIdx: i,
      daysAgo: (n - 1) - i
    });
  }
  // Newest first: the loop above runs oldest -> newest.
  out.reverse();
  return out;
}

/** Tag text for the FVG column, e.g. "Gap-up FVG 3.8% (2d ago)". */
function ab_gapUpTags_(candles) {
  return ab_gapUpFvgs_(candles).map(function (g) {
    return 'Gap-up FVG ' + g.pct + '% ' +
           (g.daysAgo === 0 ? '(today)' : '(' + g.daysAgo + 'd ago)');
  });
}

/**
 * Rebuilds the GapUpFVG tab from History30 - one row per open gap.
 *
 * The tab exists so the 5-minute alert pass has a small, cheap thing
 * to read: rescanning 30 days x ~900 symbols every five minutes just
 * to rediscover the same handful of gaps would be pure waste. It also
 * makes the levels visible, so you can see exactly what's being
 * watched and why an alert fired.
 *
 * The "Alerted" flag is preserved across rebuilds for gaps that still
 * exist, so a nightly refresh doesn't re-arm something you were told
 * about this morning.
 */
function computeGapUpFvgs_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const historySheet = ss.getSheetByName(AB_HISTORY_SHEET);
  if (!historySheet) {
    Logger.log('History30 not found - run the daily update first.');
    return { gaps: 0, symbols: 0 };
  }

  // Remember which gaps have already been alerted on.
  const prevAlerted = {};
  const prevMitigatedAlerted = {};
  const prevZones = {}; // key -> {sym, bottom, top, pct} - for the EOD-missed-mitigation sweep below
  const existing = ss.getSheetByName(AB_GAPUP_SHEET);
  if (existing && existing.getLastRow() > 1) {
    const prev = existing.getDataRange().getValues();
    prev.shift();
    prev.forEach(function (r) {
      const sym = String(r[0] || '').trim().toUpperCase();
      if (!sym) return;
      // Keyed on the levels too, so a NEW gap on the same symbol still
      // alerts even though an older one had already fired.
      const key = sym + '|' + r[1] + '|' + r[2];
      prevAlerted[key] = String(r[6] || '').trim().toUpperCase() === 'Y';
      // col H (index 7) - "Mitigated Alerted", for the live, during-
      // market-hours mitigation alert (checkGapUpMitigatedAlerts_),
      // tracked independently of the "approaching" flag in col G.
      prevMitigatedAlerted[key] = String(r[7] || '').trim().toUpperCase() === 'Y';
      prevZones[key] = { sym: sym, bottom: ab_toNum_(r[1]), top: ab_toNum_(r[2]), pct: ab_toNum_(r[3]) };
    });
  }

  const bySymbol = ab_readHistoryCandles_();
  const scanSinceKey = ab_propGet_('AB_GAPUP_SCAN_KEY'); // data day of the previous scan ('' = unknown)
  const scanNowKey = ab_msLatestHistoryKey_(bySymbol);

  const rows = [];
  const openKeys = {};
  let tooNew = 0, illiquid = 0;
  Object.keys(bySymbol).sort().forEach(function (sym) {
    const candles = bySymbol[sym];
    // Too thinly traded for a gap here to mean anything - see
    // AB_FVG_MIN_AVG_TURNOVER. Skipped entirely (never added to the
    // watch list at all), not just held back from alerting, since a
    // chronically illiquid stock's "gaps" are circuit noise start to
    // finish, not a setup that will eventually become tradeable.
    const turnover = ab_avgTurnover_(candles);
    if (!isNaN(turnover) && turnover < AB_FVG_MIN_AVG_TURNOVER) { illiquid++; return; }
    ab_gapUpFvgs_(candles).forEach(function (g) {
      // Newborns (formed by today's own candle) still go on the sheet -
      // see AB_GAPUP_MIN_AGE_DAYS - so (a) the EOD-missed-mitigation
      // sweep below and (b) the live mitigated-check can both still
      // catch it the moment price genuinely reaches the zone, even the
      // very next trading day. Only the "approaching" alert (fired by
      // ab_checkZoneAlerts_, which re-checks the age itself off the
      // Formed date) is held back for a newborn - a gap's own forming
      // candle is trivially "near" its own top (today's Close sits just
      // above today's Low, which IS the gap top), so without that hold
      // every new gap would wrongly fire "approaching" on day zero.
      if (g.daysAgo < AB_GAPUP_MIN_AGE_DAYS) tooNew++;
      const formed = candles[g.formedIdx] ? candles[g.formedIdx].date : '';
      const key = sym + '|' + g.bottom + '|' + g.top;
      openKeys[key] = true;
      rows.push([sym, g.bottom, g.top, g.pct, formed, 'Untouched',
                 prevAlerted[key] ? 'Y' : '', prevMitigatedAlerted[key] ? 'Y' : '']);
    });
  });

  // Catch what the delayed live price missed: a zone that was open
  // yesterday but is NOT in today's list has disappeared either because
  // it was genuinely touched, or (far more rarely) because its forming
  // candles rolled out of the 30-day History30 window. The only way to
  // tell the two apart is to check the real EOD data directly - if
  // today's actual Low on that symbol reached the zone top, it was
  // mitigated, full stop, regardless of what the 5-minute live price
  // check (reading Google Sheets' own delayed GOOGLEFINANCE quote)
  // happened to see in between. Only reported here if the live check
  // never already caught it (prevMitigatedAlerted), so nothing doubles up.
  const eodMitigated = [];
  Object.keys(prevZones).forEach(function (key) {
    if (openKeys[key]) return; // still open, nothing to report
    if (prevMitigatedAlerted[key]) return; // live check already caught this one
    const z = prevZones[key];
    const candles = bySymbol[z.sym];
    // Looks at EVERY candle since the last scan (normally just today's). If a scan
    // was missed (e.g. Phase 1 timed out), a touch on the skipped day is still found
    // instead of being lost because today's own Low is higher. Circuit-locked days
    // are skipped inside (a frozen "Low" is the band price, not a real fill).
    const today = ab_firstFillCandle_(candles, z.top, scanSinceKey);
    if (!today) return; // not actually mitigated - window rolled, most likely
    eodMitigated.push({
      symbol: z.sym, bottom: z.bottom, top: z.top, pct: z.pct,
      low: today.Low, close: today.Cls, date: today.date,
      chartUrl: ab_chartUrl_(z.sym), screenerUrl: ab_screenerUrl_(z.sym),
      label: 'Gap-up FVG'
    });
    ab_logMitigation_('Gap-up FVG', z.sym, z.bottom, z.top, z.pct, today.Low, 'EOD', today.date);
  });

  // Most recently formed gaps first (ties: alphabetical). The alert pass
  // reads this tab row by row and writes its flags back in the same
  // order, so re-ordering here is safe.
  const ab_t = function (v) {
    const d = (v instanceof Date) ? v : new Date(v);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  };
  rows.sort(function (a, b) {
    return (ab_t(b[4]) - ab_t(a[4])) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) || (b[2] - a[2]);
  });

  const sh = ab_getOrCreateSheet_(AB_GAPUP_SHEET);
  sh.clearContents();
  sh.getRange(1, 1, 1, 8).setValues([[
    'Symbol', 'Gap Bottom', 'Gap Top', 'Gap %', 'Formed', 'Status', 'Alerted', 'Mitigated Alerted'
  ]]);
  sh.setFrozenRows(1);
  if (rows.length) sh.getRange(2, 1, rows.length, 8).setValues(rows);
  if (scanNowKey) ab_propSet_('AB_GAPUP_SCAN_KEY', scanNowKey);

  const symCount = rows.reduce(function (acc, r) {
    acc[r[0]] = true; return acc;
  }, {});
  Logger.log('Gap-up FVG: ' + rows.length + ' open gap(s) across ' +
             Object.keys(symCount).length + ' symbol(s), ' + tooNew + ' formed today (tracked, approach-alert held), ' +
             illiquid + ' symbol(s) skipped as too illiquid (< Rs' + AB_FVG_MIN_AVG_TURNOVER + '/day avg turnover).' +
             (eodMitigated.length ? ' ' + eodMitigated.length + ' mitigated today, missed live.' : ''));
  return { gaps: rows.length, symbols: Object.keys(symCount).length, tooNew: tooNew, illiquid: illiquid, eodMitigated: eodMitigated };
}

/**
 * Whole calendar days between `dateVal` (anything getValues() can hand
 * back for a date cell - a real Date, or occasionally a plain string)
 * and today, both read in AB_TZ so this can't drift by a day near
 * midnight. Returns Infinity for anything unparseable, which is the
 * safe direction here - callers use this to HOLD BACK an alert on a
 * zone that's too new, and an unknown age should never hold back an
 * alert forever.
 */
function ab_daysSince_(dateVal) {
  if (!dateVal) return Infinity;
  const d = (dateVal instanceof Date) ? dateVal : new Date(dateVal);
  if (isNaN(d.getTime())) return Infinity;
  const todayMid = new Date(Utilities.formatDate(new Date(), AB_TZ, 'yyyy-MM-dd') + 'T00:00:00');
  const formedMid = new Date(Utilities.formatDate(d, AB_TZ, 'yyyy-MM-dd') + 'T00:00:00');
  return Math.round((todayMid - formedMid) / 86400000);
}

/**
 * Live check: has price come back to any open gap?
 *
 * Reads the GapUpFVG tab (small - only open gaps) and compares each
 * against Main's live MKT Price. Fires when price is at or below
 * gapTop x (1 + AB_GAPUP_NEAR_PCT%) and still above the gap bottom -
 * i.e. approaching from above, or already inside the zone.
 *
 * Each gap alerts ONCE. It re-arms only if price climbs clearly away
 * again (back above the approach band), so a stock sitting on the
 * edge of a gap all afternoon doesn't mail you every five minutes.
 *
 * `minAgeDays` (AB_GAPUP_MIN_AGE_DAYS / AB_UNMIT_MIN_AGE_DAYS) holds
 * back a zone formed too recently - re-checked here off the sheet's
 * own "Formed" date (column E) every time this runs, rather than
 * baked in once at scan time, so a zone that was too new this morning
 * correctly becomes alertable the moment it crosses the age threshold,
 * without waiting for the next nightly rebuild. The zone itself is
 * NOT removed from the sheet while it's too new - see computeGapUpFvgs_
 * / computeUnmitigatedFvgs_ - so the separate mitigated-check and the
 * EOD-missed-mitigation sweep still watch it from day zero.
 *
 * Returns the list of gaps that fired.
 */
function ab_checkZoneAlerts_(sheetName, nearPct, label, minAgeDays) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(sheetName);
  if (!sh || sh.getLastRow() < 2) return [];

  let layout;
  try {
    layout = ab_getMainLayout_();
  } catch (e) {
    Logger.log(label + ' alerts skipped - ' + e.message);
    return [];
  }
  if (layout.mktPrice === -1) {
    Logger.log(label + ' alerts skipped - Main has no MKT Price column.');
    return [];
  }

  // Live price per symbol, straight from Main.
  const priceBySym = {};
  const nameBySym = {};
  const data = layout.data;
  for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
    const sym = String(data[r][layout.symbol] || '').trim().toUpperCase();
    const nm = String(data[r][layout.name] || '').trim();
    if (!sym && !nm) break;
    if (!sym) continue;
    const p = ab_toNum_(data[r][layout.mktPrice]);
    if (!isNaN(p) && p > 0) priceBySym[sym] = p;
    if (nm) nameBySym[sym] = nm;
  }

  // Symbols whose latest real candle is circuit-locked - Main's live
  // price for these is just the frozen band print, not a genuine fill,
  // so it can't be trusted to say price has really reached a zone.
  let circuitLocked = {};
  try { circuitLocked = ab_todaysCircuitLockedSymbols_(); } catch (e) {
    Logger.log(label + ' alerts: circuit-lock check skipped - ' + e.message);
  }

  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues();
  const fired = [];
  const alertedOut = [];
  let changed = false;
  let tooNew = 0, circuitSkipped = 0;

  rows.forEach(function (r) {
    const sym = String(r[0] || '').trim().toUpperCase();
    const bottom = ab_toNum_(r[1]);
    const top = ab_toNum_(r[2]);
    const pct = ab_toNum_(r[3]);
    let alerted = String(r[6] || '').trim().toUpperCase() === 'Y';

    const price = priceBySym[sym];
    if (!sym || isNaN(bottom) || isNaN(top) || price === undefined) {
      alertedOut.push([alerted ? 'Y' : '']);
      return;
    }

    // Held back while too new - see the minAgeDays comment above. Still
    // carries forward whatever Alerted already says (never un-sets it),
    // it just can't newly fire while under age.
    if (minAgeDays && !alerted && ab_daysSince_(r[4]) < minAgeDays) {
      tooNew++;
      alertedOut.push(['']);
      return;
    }

    // Held back while circuit-locked, same reasoning - never un-sets
    // an already-fired alert, just can't newly fire off a frozen print.
    if (!alerted && circuitLocked[sym]) {
      circuitSkipped++;
      alertedOut.push(['']);
      return;
    }

    const nearLine = top * (1 + nearPct / 100);

    // Fires once and stays quiet for good - no re-arming. Once price
    // has come to this zone the setup is spent, and the nightly scan
    // will drop the gap entirely on the next pass anyway because the
    // candle's low will have reached the top.
    //
    // The price > bottom guard keeps it from firing on a stock that has
    // already crashed clean through: by then the entry is long gone and
    // the alert would be noise.
    if (price <= nearLine && price > bottom && !alerted) {
      const inZone = price <= top;
      fired.push({
        symbol: sym,
        name: nameBySym[sym] || '',
        price: price,
        bottom: bottom,
        top: top,
        pct: pct,
        inZone: inZone,
        distancePct: (price - top) / top * 100,
        chartUrl: ab_chartUrl_(sym),
        screenerUrl: ab_screenerUrl_(sym),
        label: label,
        nearPct: nearPct
      });
      alerted = true;
      changed = true;
    }
    alertedOut.push([alerted ? 'Y' : '']);
  });

  if (changed && alertedOut.length) {
    sh.getRange(2, 7, alertedOut.length, 1).setValues(alertedOut);
  }
  if (fired.length) Logger.log(label + ' alerts fired: ' + fired.map(f => f.symbol).join(', '));
  if (tooNew) Logger.log(label + ' alerts: ' + tooNew + ' zone(s) held back - still newer than ' + minAgeDays + 'd.');
  if (circuitSkipped) Logger.log(label + ' alerts: ' + circuitSkipped + ' zone(s) held back - symbol is circuit-locked right now.');
  return fired;
}

/** The two concrete zone types. */
function checkGapUpAlerts_() {
  return ab_checkZoneAlerts_(AB_GAPUP_SHEET, AB_GAPUP_NEAR_PCT, 'Gap-up FVG', AB_GAPUP_MIN_AGE_DAYS);
}
function checkUnmitigatedAlerts_() {
  return ab_checkZoneAlerts_(AB_UNMIT_SHEET, AB_UNMIT_NEAR_PCT, 'Unmitigated FVG', AB_UNMIT_MIN_AGE_DAYS);
}

/** Email + push for gap-up approaches. Plain text mirrors the email. */
function ab_sendZoneAlerts_(fired) {
  if (!fired || !fired.length) return;
  const label = fired[0].label || 'Gap-up FVG';
  const nearPct = fired[0].nearPct || AB_GAPUP_NEAR_PCT;
  const ts = Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm');

  const td = 'style="padding:6px 10px;border-bottom:1px solid #eee;font-size:13px"';
  let html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:620px">';
  html += '<h2 style="margin:0 0 2px">' + label + ' - ' + fired.length +
          ' approaching</h2>';
  html += '<p style="margin:0 0 16px;color:#5f6368;font-size:13px">' + ts + ' IST</p>';

  fired.forEach(function (f) {
    const accent = f.inZone ? AB_C_POS : AB_C_WARN;
    const state = f.inZone ? 'INSIDE THE GAP' : 'APPROACHING';
    html += '<div style="border:1px solid #e2e2e2;border-radius:10px;overflow:hidden;margin-bottom:14px">';
    html += '<div style="background:' + (f.inZone ? '#eafaf1' : '#fff8e1') +
            ';padding:12px 14px;border-left:5px solid ' + accent + '">';
    html += '<div style="font-size:11px;letter-spacing:0.5px;font-weight:700;color:' +
            accent + '">' + state + '</div>';
    html += '<div style="font-size:18px;font-weight:700;color:#111">' + f.symbol + '</div>';
    html += '<div style="font-size:13px;color:#555">' + (f.name || '') + '</div>';
    html += '</div><table style="width:100%;border-collapse:collapse">';
    html += '<tr><td ' + td + ' >Price now</td><td ' + td +
            ' align="right"><b>' + ab_num2_(f.price) + '</b></td></tr>';
    html += '<tr><td ' + td + ' >Gap top (enter here)</td><td ' + td +
            ' align="right"><span style="color:' + AB_C_POS + ';font-weight:bold">' +
            ab_num2_(f.top) + '</span></td></tr>';
    html += '<tr><td ' + td + ' >Gap bottom (gap filled below)</td><td ' + td +
            ' align="right"><span style="color:' + AB_C_NEG + ';font-weight:bold">' +
            ab_num2_(f.bottom) + '</span></td></tr>';
    html += '<tr><td ' + td + ' >Gap size</td><td ' + td +
            ' align="right">' + ab_num2_(f.pct) + '%</td></tr>';
    html += '<tr><td ' + td + ' >Distance to gap top</td><td ' + td +
            ' align="right">' + ab_pct2_(f.distancePct) + '</td></tr>';
    html += '</table>';
    html += '<div style="padding:10px 14px;background:#fafafa;border-top:1px solid #eee">';
    html += '<a href="' + f.chartUrl + '" style="display:inline-block;margin-right:8px;padding:7px 12px;background:' +
            accent + ';color:#fff;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600">View Chart</a>';
    html += '<a href="' + f.screenerUrl + '" style="display:inline-block;padding:7px 12px;background:#333;color:#fff;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600">Screener.in</a>';
    html += '</div></div>';
  });
  html += '<p style="margin:8px 0 0;color:#5f6368;font-size:11px">' +
          'This is the FIRST return to an untouched zone, approached from ' +
          'above (within ' + nearPct + '%). Each zone alerts once and never ' +
          'again - once price has been here it stops counting as ' +
          'unmitigated at all.</p></div>';

  let text = label + ' - ' + fired.length + ' approaching (' + ts + ')\n\n';
  fired.forEach(function (f) {
    text += (f.inZone ? '[INSIDE] ' : '[NEAR] ') + f.symbol +
            (f.name ? ' (' + f.name + ')' : '') + '\n';
    text += '  Price ' + ab_num2_(f.price) + ', gap ' + ab_num2_(f.bottom) + ' - ' +
            ab_num2_(f.top) + ' (' + ab_num2_(f.pct) + '%), ' +
            ab_pct2_(f.distancePct) + ' from the top\n';
    text += '  Chart: ' + f.chartUrl + '\n\n';
  });

  try {
    ab_sendMail_({
      to: AB_EMAIL_TO,
      subject: label + ' - ' + fired.map(function (f) { return f.symbol; }).join(', ') +
               ' approaching (' + ts + ')',
      body: text,
      htmlBody: html
    });
  } catch (e) {
    Logger.log(label + ' email failed: ' + e.message);
  }
  try {
    ab_sendPushbullet_(label + ' - ' + fired.length + ' approaching', text);
  } catch (pe) {
    Logger.log(label + ' push failed: ' + pe.message);
  }
}

/** Kept so existing callers and tests stay valid. */
function sendGapUpAlerts_(fired) { return ab_sendZoneAlerts_(fired); }

/** Menu: run the gap-up approach check right now. */
function runGapUpAlertsNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const fired = checkGapUpAlerts_();
    sendGapUpAlerts_(fired);
    ss.toast(fired.length
      ? fired.length + ' gap-up alert(s) sent: ' + fired.map(f => f.symbol).join(', ')
      : 'No gap-up approaches right now.', 'Gap-up FVG', 10);
  } catch (e) {
    ss.toast('Gap-up alert check failed: ' + e.message);
  }
}

/** Menu: clear every Alerted flag so all open gaps can fire again. */
function resetGapUpAlerts() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(AB_GAPUP_SHEET);
  if (!sh || sh.getLastRow() < 2) { ss.toast('No gap list yet - run the scan first.'); return; }
  sh.getRange(2, 7, sh.getLastRow() - 1, 1).clearContent();
  ss.toast('Gap-up alerts re-armed.');
}

/*****************************************************************
 * UNMITIGATED FVG ZONES
 * -----------------------------------------------------------------
 * The other gap family - the 3-candle ICT bullish gap already tagged
 * in column X as "FVG Unmitigated" - given the same treatment as the
 * gap-ups: levels written to their own tab, and an alert the first
 * time price comes back down to the zone.
 *
 *   bottom = high of candle i-2
 *   top    = low of candle i
 *   size   = must clear the same 14-bar minimum deviation the tag
 *            engine uses, so this stays consistent with column X
 *
 * "Unmitigated" here means exactly what it means for gap-ups: no
 * later candle has traded at or below the zone top. Same single rule,
 * so approach is always from above, and one visit retires the zone
 * for good.
 *
 * Only the MOST RECENT untouched zone per symbol is kept. Older ones
 * further down are still technically unfilled, but the nearest one is
 * the level price will reach first, and listing five stale zones per
 * symbol would bury the useful one.
 *****************************************************************/
const AB_UNMIT_SHEET = 'UnmitigatedFVG';
const AB_UNMIT_NEAR_PCT = ab_setting_('AB_UNMIT_NEAR_PCT', 0.5); // how close above the zone top counts as approaching

// A zone must be at least this many sessions old before it goes on the
// watch list. A gap formed TODAY is useless to watch: the third candle
// is today's, so today's low IS the zone top, which means price is
// already touching it by definition. It would alert the instant it was
// discovered, having never actually left and come back. Give it a day
// to move away first, then a return to the zone means something.
//
// This filters the WATCH LIST only. The FVG column still tags a
// same-day gap as unmitigated, because it is one - it just isn't
// something to watch for a retest yet.
const AB_UNMIT_MIN_AGE_DAYS = ab_setting_('AB_UNMIT_MIN_AGE_DAYS', 1);

/**
 * The unmitigated FVG zone for one symbol, or null.
 *
 * Delegates entirely to ab_longFvgDetail_ - the same engine that
 * writes "FVG Unmitigated" into the FVG column. It is NOT a second
 * implementation of the idea: if the column says a symbol is
 * unmitigated, this returns that zone's levels, and if the column
 * says nothing, this returns null. One definition, one answer.
 *
 * Note this is a different animal from ab_gapUpFvgs_: that one is a
 * plain two-day overnight gap sized 2-5%, this one is the three-candle
 * ICT gap measured against a 14-bar minimum deviation. They are kept
 * in separate tabs and alert separately.
 */
function ab_unmitigatedFvg_(candles) {
  return ab_longFvgDetail_(candles).unmitigated;
}

/** Rebuilds the UnmitigatedFVG tab from History30. */
function computeUnmitigatedFvgs_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const historySheet = ss.getSheetByName(AB_HISTORY_SHEET);
  if (!historySheet) {
    Logger.log('History30 not found - run the daily update first.');
    return { zones: 0, symbols: 0 };
  }

  const prevAlerted = {};
  const prevMitigatedAlerted = {};
  const prevZones = {}; // key -> {sym, bottom, top, pct} - for the EOD-missed-mitigation sweep below
  const existing = ss.getSheetByName(AB_UNMIT_SHEET);
  if (existing && existing.getLastRow() > 1) {
    const prev = existing.getDataRange().getValues();
    prev.shift();
    prev.forEach(function (r) {
      const sym = String(r[0] || '').trim().toUpperCase();
      if (!sym) return;
      const key = sym + '|' + r[1] + '|' + r[2];
      prevAlerted[key] = String(r[6] || '').trim().toUpperCase() === 'Y';
      // col H (index 7) - "Mitigated Alerted", added so the live, during-
      // market-hours mitigation alert (checkUnmitigatedMitigatedAlerts_)
      // only fires once per zone, same as the approach alert in col G.
      prevMitigatedAlerted[key] = String(r[7] || '').trim().toUpperCase() === 'Y';
      prevZones[key] = { sym: sym, bottom: ab_toNum_(r[1]), top: ab_toNum_(r[2]), pct: ab_toNum_(r[3]) };
    });
  }

  const bySymbol = ab_readHistoryCandles_();
  const scanSinceKey = ab_propGet_('AB_UNMIT_SCAN_KEY'); // data day of the previous scan ('' = unknown)
  const scanNowKey = ab_msLatestHistoryKey_(bySymbol);

  // Symbols the gap-up watch already covers. A stock that gapped up
  // will usually ALSO satisfy the three-candle rule over the same bars
  // - it is one gap being described twice - so without this you get two
  // tabs, two emails and two zones only rupees apart for a single
  // setup. Gap-up wins because it is the tighter, more specific rule:
  // an actual overnight gap of a stated size, not a structural
  // imbalance inferred across three candles.
  const gapUpSyms = {};
  const gapSheet = ss.getSheetByName(AB_GAPUP_SHEET);
  if (gapSheet && gapSheet.getLastRow() > 1) {
    gapSheet.getRange(2, 1, gapSheet.getLastRow() - 1, 1).getValues().forEach(function (r) {
      const s = String(r[0] || '').trim().toUpperCase();
      if (s) gapUpSyms[s] = true;
    });
  }

  const rows = [];
  const openKeys = {};
  let tooNew = 0, dupes = 0, illiquid = 0;
  Object.keys(bySymbol).sort().forEach(function (sym) {
    if (gapUpSyms[sym]) { dupes++; return; } // already watched as a gap-up
    const candles = bySymbol[sym];
    // Same illiquidity floor as computeGapUpFvgs_ - see AB_FVG_MIN_AVG_TURNOVER.
    const turnover = ab_avgTurnover_(candles);
    if (!isNaN(turnover) && turnover < AB_FVG_MIN_AVG_TURNOVER) { illiquid++; return; }
    const z = ab_unmitigatedFvg_(candles);
    if (!z) return;
    // Newborns still go on the sheet - see AB_UNMIT_MIN_AGE_DAYS - so the
    // EOD-missed-mitigation sweep below and the live mitigated-check can
    // still catch a genuine mitigation even the very next trading day.
    // Only the "approaching" alert (ab_checkZoneAlerts_, which re-checks
    // the age itself off the Formed date) is held back for a newborn.
    if (z.daysAgo < AB_UNMIT_MIN_AGE_DAYS) tooNew++;
    const formed = candles[z.formedIdx] ? candles[z.formedIdx].date : '';
    const key = sym + '|' + z.bottom + '|' + z.top;
    openKeys[key] = true;
    rows.push([sym, z.bottom, z.top, z.pct, formed, 'Untouched',
               prevAlerted[key] ? 'Y' : '', prevMitigatedAlerted[key] ? 'Y' : '']);
  });

  // Same EOD-missed-mitigation sweep as computeGapUpFvgs_ - see the
  // comment there for why the real Low is checked rather than trusting
  // "disappeared from the list" by itself (a zone can also vanish here
  // just because its symbol got reclassified onto the gap-up watch).
  const eodMitigated = [];
  Object.keys(prevZones).forEach(function (key) {
    if (openKeys[key]) return;
    if (prevMitigatedAlerted[key]) return;
    const z = prevZones[key];
    const candles = bySymbol[z.sym];
    const today = ab_firstFillCandle_(candles, z.top, scanSinceKey); // every candle since the last scan - see computeGapUpFvgs_
    if (!today) return;
    eodMitigated.push({
      symbol: z.sym, bottom: z.bottom, top: z.top, pct: z.pct,
      low: today.Low, close: today.Cls, date: today.date,
      chartUrl: ab_chartUrl_(z.sym), screenerUrl: ab_screenerUrl_(z.sym),
      label: 'Unmitigated FVG'
    });
    ab_logMitigation_('Unmitigated FVG', z.sym, z.bottom, z.top, z.pct, today.Low, 'EOD', today.date);
  });

  const sh = ab_getOrCreateSheet_(AB_UNMIT_SHEET);
  sh.clearContents();
  sh.getRange(1, 1, 1, 8).setValues([[
    'Symbol', 'Zone Bottom', 'Zone Top', 'Zone %', 'Formed', 'Status', 'Alerted', 'Mitigated Alerted'
  ]]);
  sh.setFrozenRows(1);
  if (rows.length) sh.getRange(2, 1, rows.length, 8).setValues(rows);
  if (scanNowKey) ab_propSet_('AB_UNMIT_SCAN_KEY', scanNowKey);

  Logger.log('Unmitigated FVG: ' + rows.length + ' watchable zone(s), ' + tooNew +
             ' formed today (tracked, approach-alert held), ' + dupes + ' already on the gap-up watch, ' +
             illiquid + ' skipped as too illiquid (< Rs' + AB_FVG_MIN_AVG_TURNOVER + '/day avg turnover).' +
             (eodMitigated.length ? ' ' + eodMitigated.length + ' mitigated today, missed live.' : ''));
  return { zones: rows.length, tooNew: tooNew, dupes: dupes, illiquid: illiquid, symbols: rows.length, eodMitigated: eodMitigated };
}

/** Menu: rebuild the unmitigated-zone list. */
function runUnmitigatedScanNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const s = computeUnmitigatedFvgs_();
    ab_sendEodMitigatedAlerts_(s.eodMitigated);
    ss.toast(s.zones + ' watchable zone(s)' +
             (s.tooNew ? ', ' + s.tooNew + ' formed today (tracked, approach-alert held for now)' : '') +
             (s.dupes ? ', ' + s.dupes + ' already on the gap-up watch' : '') +
             (s.eodMitigated && s.eodMitigated.length
               ? ', ' + s.eodMitigated.length + ' mitigated today (missed by the live check, alert sent)'
               : '') + '.',
             'Unmitigated FVG', 10);
  } catch (e) {
    ss.toast('Unmitigated scan failed: ' + e.message);
  }
}

/** Menu: run the unmitigated approach check right now. */
function runUnmitigatedAlertsNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const fired = checkUnmitigatedAlerts_();
    ab_sendZoneAlerts_(fired);
    ss.toast(fired.length
      ? fired.length + ' alert(s) sent: ' + fired.map(f => f.symbol).join(', ')
      : 'No unmitigated-FVG approaches right now.', 'Unmitigated FVG', 10);
  } catch (e) {
    ss.toast('Unmitigated alert check failed: ' + e.message);
  }
}

/** Menu: clear every Alerted flag so all zones can fire again. */
function resetUnmitigatedAlerts() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(AB_UNMIT_SHEET);
  if (!sh || sh.getLastRow() < 2) { ss.toast('No zone list yet - run the scan first.'); return; }
  sh.getRange(2, 7, sh.getLastRow() - 1, 1).clearContent();
  ss.toast('Unmitigated FVG alerts re-armed.');
}

/** Durable log of every FVG mitigation this engine has reported - both
 *  the live, during-market-hours catches and the EOD-missed ones found
 *  by the nightly rebuild. Exists so a later report (e.g. the EOD
 *  market summary) can answer "what mitigated today" without having to
 *  reconstruct it from tabs that, by design, no longer hold a zone once
 *  it's mitigated. */
const AB_MITIGATED_LOG_SHEET = 'Mitigated FVG Log';

/**
 * The first candle (oldest first) after `sinceKey` (yyyymmdd) whose Low reached
 * `top` - i.e. really filled the zone - skipping circuit-locked days. With no
 * `sinceKey` (first run after this feature) the last 3 candles are considered.
 * Returns the candle or null.
 */
function ab_firstFillCandle_(candles, top, sinceKey) {
  if (!candles || !candles.length) return null;
  const from = sinceKey ? 0 : Math.max(0, candles.length - 3);
  for (let i = from; i < candles.length; i++) {
    const c = candles[i];
    if (sinceKey) {
      const k = ab_msDateKey_(c.date);
      if (!k || k <= sinceKey) continue;
    }
    if (isNaN(c.Low) || c.Low > top) continue;
    if (ab_isCircuitLocked_(c)) continue;
    return c;
  }
  return null;
}

/** Appends one row to the Mitigated FVG Log. `source` is 'Live' (caught
 *  by the 5-minute during-market-hours check) or 'EOD' (only confirmed
 *  once the nightly rebuild compared the day's actual Low against the
 *  zone top - see computeGapUpFvgs_ / computeUnmitigatedFvgs_). */
function ab_logMitigation_(label, symbol, bottom, top, pct, price, source, candleDate) {
  try {
    const sh = ab_getOrCreateSheet_(AB_MITIGATED_LOG_SHEET);
    if (sh.getLastRow() < 1) {
      sh.getRange(1, 1, 1, 8).setValues([[
        'Date', 'Time', 'Type', 'Symbol', 'Zone Bottom', 'Zone Top', 'Zone %', 'Price / Source'
      ]]);
      sh.setFrozenRows(1);
    }
    const now = new Date();
    // An EOD catch is dated by the candle that filled the zone (normally today; the
    // skipped day when a scan was missed), so the log and the missed-opportunity
    // check see the true day.
    let logDay = Utilities.formatDate(now, AB_TZ, 'dd-MMM-yyyy');
    if (candleDate) {
      const cd = ab_toJsDate_(candleDate);
      if (cd) logDay = Utilities.formatDate(cd, AB_TZ, 'dd-MMM-yyyy');
    }
    sh.appendRow([
      logDay,
      Utilities.formatDate(now, AB_TZ, 'HH:mm'),
      label, symbol, bottom, top, pct, ab_num2_(price) + ' (' + source + ')'
    ]);
  } catch (e) {
    Logger.log('Mitigated FVG Log write failed for ' + symbol + ' - ' + e.message);
  }
}

/**
 * Live, market-hours-only check: has price actually touched or gone
 * below a zone's top - i.e. mitigated it - right now? Shared by both
 * zone families (Unmitigated FVG and Gap-up FVG) via `sheetName`/`label`,
 * same pattern as ab_checkZoneAlerts_ for the "approaching" check.
 *
 * This is deliberately separate from the "approaching" check (fired
 * within AB_UNMIT_NEAR_PCT / AB_GAPUP_NEAR_PCT % of the top): that one
 * goes quiet forever the first time it fires for a zone, so a stock
 * already flagged as "approaching" earlier in the day would otherwise
 * never get a second, more important alert the moment it actually
 * reaches and mitigates the zone. Tracked with its own "Mitigated
 * Alerted" flag (col H) so the two alerts fire completely independently
 * of each other.
 *
 * Only the top matters here, per spec - no bottom guard like the
 * approach check has, since the whole point is to catch the exact
 * moment the zone stops being unmitigated.
 *
 * Gated on ab_isMarketHours_() - outside the 09:15-15:30 IST session
 * this returns [] without reading anything, so a trigger that runs
 * 24x7 still only alerts "during market hours" as asked.
 */
function ab_checkZoneMitigatedAlerts_(sheetName, label) {
  if (!ab_isMarketHours_()) return [];

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(sheetName);
  if (!sh || sh.getLastRow() < 2) return [];

  let layout;
  try {
    layout = ab_getMainLayout_();
  } catch (e) {
    Logger.log(label + ' mitigated alerts skipped - ' + e.message);
    return [];
  }
  if (layout.mktPrice === -1) {
    Logger.log(label + ' mitigated alerts skipped - Main has no MKT Price column.');
    return [];
  }

  const priceBySym = {};
  const nameBySym = {};
  const data = layout.data;
  for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
    const sym = String(data[r][layout.symbol] || '').trim().toUpperCase();
    const nm = String(data[r][layout.name] || '').trim();
    if (!sym && !nm) break;
    if (!sym) continue;
    const p = ab_toNum_(data[r][layout.mktPrice]);
    if (!isNaN(p) && p > 0) priceBySym[sym] = p;
    if (nm) nameBySym[sym] = nm;
  }

  // Symbols whose latest real candle is circuit-locked - see
  // ab_checkZoneAlerts_ for why Main's live price can't be trusted for
  // these. This is exactly the RELINFRA-style case: a frozen print
  // sitting right at/through a zone's top isn't a real mitigation.
  let circuitLocked = {};
  try { circuitLocked = ab_todaysCircuitLockedSymbols_(); } catch (e) {
    Logger.log(label + ' mitigated alerts: circuit-lock check skipped - ' + e.message);
  }

  // getDataRange (not a fixed-width getRange) so this keeps working even
  // against a tab a rebuild hasn't yet widened to 8 columns.
  const all = sh.getDataRange().getValues();
  all.shift(); // header
  const fired = [];
  const mitigatedOut = [];
  let changed = false;
  let circuitSkipped = 0;

  all.forEach(function (r) {
    const sym = String(r[0] || '').trim().toUpperCase();
    const bottom = ab_toNum_(r[1]);
    const top = ab_toNum_(r[2]);
    const pct = ab_toNum_(r[3]);
    let mitigatedAlerted = String(r[7] || '').trim().toUpperCase() === 'Y';

    const price = priceBySym[sym];
    if (!sym || isNaN(top) || price === undefined) {
      mitigatedOut.push([mitigatedAlerted ? 'Y' : '']);
      return;
    }

    if (!mitigatedAlerted && circuitLocked[sym]) {
      circuitSkipped++;
      mitigatedOut.push(['']);
      return;
    }

    if (price <= top && !mitigatedAlerted) {
      fired.push({
        symbol: sym,
        name: nameBySym[sym] || '',
        price: price,
        bottom: bottom,
        top: top,
        pct: pct,
        chartUrl: ab_chartUrl_(sym),
        screenerUrl: ab_screenerUrl_(sym),
        label: label
      });
      ab_logMitigation_(label, sym, bottom, top, pct, price, 'Live');
      mitigatedAlerted = true;
      changed = true;
    }
    mitigatedOut.push([mitigatedAlerted ? 'Y' : '']);
  });

  if (changed && mitigatedOut.length) {
    sh.getRange(2, 8, mitigatedOut.length, 1).setValues(mitigatedOut);
  }
  if (fired.length) Logger.log(label + ' mitigated: ' + fired.map(f => f.symbol).join(', '));
  if (circuitSkipped) Logger.log(label + ' mitigated alerts: ' + circuitSkipped + ' zone(s) held back - symbol is circuit-locked right now.');
  return fired;
}

/** The two concrete mitigation checks. */
function checkUnmitigatedMitigatedAlerts_() {
  return ab_checkZoneMitigatedAlerts_(AB_UNMIT_SHEET, 'Unmitigated FVG');
}
function checkGapUpMitigatedAlerts_() {
  return ab_checkZoneMitigatedAlerts_(AB_GAPUP_SHEET, 'Gap-up FVG');
}

/** Email + push: a zone just got mitigated (price touched/crossed the top). */
function ab_sendZoneMitigatedAlerts_(fired) {
  if (!fired || !fired.length) return;
  const label = fired[0].label || 'FVG';
  const ts = Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm');

  const td = 'style="padding:6px 10px;border-bottom:1px solid #eee;font-size:13px"';
  let html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:620px">';
  html += '<h2 style="margin:0 0 2px">' + label + ' - ' + fired.length + ' mitigated</h2>';
  html += '<p style="margin:0 0 16px;color:#5f6368;font-size:13px">' + ts + ' IST</p>';

  fired.forEach(function (f) {
    html += '<div style="border:1px solid #e2e2e2;border-radius:10px;overflow:hidden;margin-bottom:14px">';
    html += '<div style="background:#fdeaea;padding:12px 14px;border-left:5px solid ' + AB_C_NEG + '">';
    html += '<div style="font-size:11px;letter-spacing:0.5px;font-weight:700;color:' +
            AB_C_NEG + '">MITIGATED</div>';
    html += '<div style="font-size:18px;font-weight:700;color:#111">' + f.symbol + '</div>';
    html += '<div style="font-size:13px;color:#555">' + (f.name || '') + '</div>';
    html += '</div><table style="width:100%;border-collapse:collapse">';
    html += '<tr><td ' + td + ' >Price now</td><td ' + td +
            ' align="right"><b>' + ab_num2_(f.price) + '</b></td></tr>';
    html += '<tr><td ' + td + ' >Zone top (touched)</td><td ' + td +
            ' align="right"><span style="color:' + AB_C_NEG + ';font-weight:bold">' +
            ab_num2_(f.top) + '</span></td></tr>';
    html += '<tr><td ' + td + ' >Zone bottom</td><td ' + td +
            ' align="right">' + ab_num2_(f.bottom) + '</td></tr>';
    html += '<tr><td ' + td + ' >Zone size</td><td ' + td +
            ' align="right">' + ab_num2_(f.pct) + '%</td></tr>';
    html += '</table>';
    html += '<div style="padding:10px 14px;background:#fafafa;border-top:1px solid #eee">';
    html += '<a href="' + f.chartUrl + '" style="display:inline-block;margin-right:8px;padding:7px 12px;background:' +
            AB_C_NEG + ';color:#fff;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600">View Chart</a>';
    html += '<a href="' + f.screenerUrl + '" style="display:inline-block;padding:7px 12px;background:#333;color:#fff;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600">Screener.in</a>';
    html += '</div></div>';
  });
  html += '<p style="margin:8px 0 0;color:#5f6368;font-size:11px">' +
          'Price touched or closed through the zone top during market hours - the zone is ' +
          'no longer unmitigated. Independent of the "approaching" alert; fires once per zone.</p></div>';

  let text = label + ' - ' + fired.length + ' mitigated (' + ts + ')\n\n';
  fired.forEach(function (f) {
    text += f.symbol + (f.name ? ' (' + f.name + ')' : '') + '\n';
    text += '  Price ' + ab_num2_(f.price) + ', zone top ' + ab_num2_(f.top) +
            ', zone bottom ' + ab_num2_(f.bottom) + ' (' + ab_num2_(f.pct) + '%)\n';
    text += '  Chart: ' + f.chartUrl + '\n\n';
  });

  try {
    ab_sendMail_({
      to: AB_EMAIL_TO,
      subject: label + ' - ' + fired.map(function (f) { return f.symbol; }).join(', ') +
               ' mitigated (' + ts + ')',
      body: text,
      htmlBody: html
    });
  } catch (e) {
    Logger.log(label + ' mitigated email failed: ' + e.message);
  }
  try {
    ab_sendPushbullet_(label + ' - ' + fired.length + ' mitigated', text);
  } catch (pe) {
    Logger.log(label + ' mitigated push failed: ' + pe.message);
  }
}

/**
 * Email + push for zones the nightly rebuild (computeGapUpFvgs_ /
 * computeUnmitigatedFvgs_) confirms were mitigated by today's REAL
 * trading - using History30's actual Low for the day - that the live,
 * during-market-hours check never caught.
 *
 * Why this exists: Main's "MKT Price" is a Google Sheets GOOGLEFINANCE
 * quote, which lags the real tape by anywhere from a few seconds to a
 * couple of minutes. A fast mitigate-and-bounce - price dips into the
 * zone and is already back above it again before the next 5-minute
 * check reads a fresh quote - can slip through the live check entirely.
 * This EOD pass is the backstop: it trusts the day's actual Low, not a
 * delayed snapshot, so nothing that genuinely got mitigated goes
 * unreported, even if the live alert missed the exact moment.
 *
 * `zones` is the eodMitigated array either compute function returns -
 * {symbol, bottom, top, pct, low, close, date, chartUrl, screenerUrl,
 * label}. Best-effort company-name lookup against Main; soft-fails to
 * a blank name rather than blocking the alert if Main can't be read.
 */
function ab_sendEodMitigatedAlerts_(zones) {
  if (!zones || !zones.length) return;

  const nameBySym = {};
  try {
    const layout = ab_getMainLayout_();
    const data = layout.data;
    for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
      const sym = String(data[r][layout.symbol] || '').trim().toUpperCase();
      const nm = String(data[r][layout.name] || '').trim();
      if (!sym && !nm) break;
      if (sym && nm) nameBySym[sym] = nm;
    }
  } catch (e) {
    Logger.log('EOD-mitigated alert: Main name lookup skipped - ' + e.message);
  }

  // One email can cover a mix of Gap-up and Unmitigated zones, so each
  // card is labelled individually rather than assuming one label for all.
  const ts = Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm');
  const td = 'style="padding:6px 10px;border-bottom:1px solid #eee;font-size:13px"';
  let html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:620px">';
  html += '<h2 style="margin:0 0 2px">' + zones.length + ' mitigated today - missed by the live check</h2>';
  html += '<p style="margin:0 0 16px;color:#5f6368;font-size:13px">' + ts + ' IST</p>';
  html += '<p style="margin:0 0 16px;color:#5f6368;font-size:12px">Confirmed from today\'s actual Low ' +
          '(History30), not the delayed live quote - likely a fast mitigate-and-bounce that happened ' +
          'between 5-minute checks.</p>';

  zones.forEach(function (f) {
    html += '<div style="border:1px solid #e2e2e2;border-radius:10px;overflow:hidden;margin-bottom:14px">';
    html += '<div style="background:#fdeaea;padding:12px 14px;border-left:5px solid ' + AB_C_NEG + '">';
    html += '<div style="font-size:11px;letter-spacing:0.5px;font-weight:700;color:' +
            AB_C_NEG + '">' + (f.label || 'FVG') + ' - MITIGATED (EOD)</div>';
    html += '<div style="font-size:18px;font-weight:700;color:#111">' + f.symbol + '</div>';
    html += '<div style="font-size:13px;color:#555">' + (nameBySym[f.symbol] || '') + '</div>';
    html += '</div><table style="width:100%;border-collapse:collapse">';
    html += '<tr><td ' + td + ' >Day\'s Low (touched)</td><td ' + td +
            ' align="right"><span style="color:' + AB_C_NEG + ';font-weight:bold">' +
            ab_num2_(f.low) + '</span></td></tr>';
    html += '<tr><td ' + td + ' >Close</td><td ' + td +
            ' align="right"><b>' + ab_num2_(f.close) + '</b></td></tr>';
    html += '<tr><td ' + td + ' >Zone top</td><td ' + td +
            ' align="right">' + ab_num2_(f.top) + '</td></tr>';
    html += '<tr><td ' + td + ' >Zone bottom</td><td ' + td +
            ' align="right">' + ab_num2_(f.bottom) + '</td></tr>';
    html += '<tr><td ' + td + ' >Zone size</td><td ' + td +
            ' align="right">' + ab_num2_(f.pct) + '%</td></tr>';
    html += '</table>';
    html += '<div style="padding:10px 14px;background:#fafafa;border-top:1px solid #eee">';
    html += '<a href="' + f.chartUrl + '" style="display:inline-block;margin-right:8px;padding:7px 12px;background:' +
            AB_C_NEG + ';color:#fff;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600">View Chart</a>';
    html += '<a href="' + f.screenerUrl + '" style="display:inline-block;padding:7px 12px;background:#333;color:#fff;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600">Screener.in</a>';
    html += '</div></div>';
  });
  html += '</div>';

  let text = zones.length + ' mitigated today, missed by the live check (' + ts + ')\n\n';
  zones.forEach(function (f) {
    const nm = nameBySym[f.symbol] || '';
    text += '[' + (f.label || 'FVG') + '] ' + f.symbol + (nm ? ' (' + nm + ')' : '') + '\n';
    text += '  Low ' + ab_num2_(f.low) + ', close ' + ab_num2_(f.close) + ', zone ' +
            ab_num2_(f.bottom) + ' - ' + ab_num2_(f.top) + ' (' + ab_num2_(f.pct) + '%)\n';
    text += '  Chart: ' + f.chartUrl + '\n\n';
  });

  try {
    ab_sendMail_({
      to: AB_EMAIL_TO,
      subject: zones.length + ' mitigated today (missed live) - ' +
               zones.map(function (f) { return f.symbol; }).join(', ') + ' (' + ts + ')',
      body: text,
      htmlBody: html
    });
  } catch (e) {
    Logger.log('EOD-mitigated email failed: ' + e.message);
  }
  try {
    ab_sendPushbullet_(zones.length + ' mitigated today (missed live)', text);
  } catch (pe) {
    Logger.log('EOD-mitigated push failed: ' + pe.message);
  }
}

/** Menu: run the Unmitigated-FVG mitigation check right now (still
 *  honours the market-hours gate internally, so outside market hours
 *  this will just report nothing to do). */
function runUnmitigatedMitigatedAlertsNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const fired = checkUnmitigatedMitigatedAlerts_();
    ab_sendZoneMitigatedAlerts_(fired);
    ss.toast(fired.length
      ? fired.length + ' mitigation alert(s) sent: ' + fired.map(f => f.symbol).join(', ')
      : (ab_isMarketHours_()
          ? 'No Unmitigated FVG zones mitigated right now.'
          : 'Market is closed - mitigation alerts only run 09:15-15:30 IST.'),
      'Unmitigated FVG', 10);
  } catch (e) {
    ss.toast('Unmitigated mitigation check failed: ' + e.message);
  }
}

/** Menu: clear every Mitigated Alerted flag so all Unmitigated-FVG zones
 *  can fire again. */
function resetUnmitigatedMitigatedAlerts() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(AB_UNMIT_SHEET);
  if (!sh || sh.getLastRow() < 2) { ss.toast('No zone list yet - run the scan first.'); return; }
  sh.getRange(2, 8, sh.getLastRow() - 1, 1).clearContent();
  ss.toast('Unmitigated FVG mitigation alerts re-armed.');
}

/** Menu: run the Gap-up-FVG mitigation check right now (still honours
 *  the market-hours gate internally, so outside market hours this will
 *  just report nothing to do). */
function runGapUpMitigatedAlertsNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const fired = checkGapUpMitigatedAlerts_();
    ab_sendZoneMitigatedAlerts_(fired);
    ss.toast(fired.length
      ? fired.length + ' mitigation alert(s) sent: ' + fired.map(f => f.symbol).join(', ')
      : (ab_isMarketHours_()
          ? 'No Gap-up FVG zones mitigated right now.'
          : 'Market is closed - mitigation alerts only run 09:15-15:30 IST.'),
      'Gap-up FVG', 10);
  } catch (e) {
    ss.toast('Gap-up mitigation check failed: ' + e.message);
  }
}

/** Menu: clear every Mitigated Alerted flag so all Gap-up-FVG zones can
 *  fire again. */
function resetGapUpMitigatedAlerts() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(AB_GAPUP_SHEET);
  if (!sh || sh.getLastRow() < 2) { ss.toast('No gap list yet - run the scan first.'); return; }
  sh.getRange(2, 8, sh.getLastRow() - 1, 1).clearContent();
  ss.toast('Gap-up FVG mitigation alerts re-armed.');
}

/** Menu: rebuild the gap list from the OHLC already in the sheet. */
function runGapUpScanNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const s = computeGapUpFvgs_();
    ab_sendEodMitigatedAlerts_(s.eodMitigated);
    ss.toast(s.gaps + ' open gap(s) across ' + s.symbols + ' symbol(s)' +
             (s.tooNew ? ', ' + s.tooNew + ' formed today (tracked, approach-alert held for now)' : '') + '.' +
             (s.eodMitigated && s.eodMitigated.length
               ? ' ' + s.eodMitigated.length + ' mitigated today (missed by the live check, alert sent).'
               : ''),
             'Gap-up FVG', 10);
  } catch (e) {
    ss.toast('Gap-up scan failed: ' + e.message);
  }
}

/*****************************************************************
 * 10 EMA SUPPORT
 * -----------------------------------------------------------------
 * You watch the 10 EMA for support bounces (like the Moving Average
 * Ribbon indicator's EMA line, just isolated to length 10). Flags a
 * symbol when, within the last 4 available days:
 *   - yesterday's close was already above its EMA10 (an established
 *     uptrend - the EMA is acting as a support line, not something
 *     price just crossed for the first time)
 *   - today's Low came down to touch (or dip slightly under) today's
 *     EMA10 - within AB_EMA_SUPPORT_TOUCH_PCT%
 *   - today's Close held back above the EMA10 - the bounce/rejection
 *****************************************************************/

/** Standard EMA, seeded with an SMA of the first `length` closes. */
function ab_computeEMA_(candles, length) {
  const n = candles.length;
  const ema = new Array(n).fill(NaN);
  if (n < length) return ema;
  let sum = 0;
  for (let i = 0; i < length; i++) sum += candles[i].Cls;
  ema[length - 1] = sum / length;
  const k = 2 / (length + 1);
  for (let i = length; i < n; i++) {
    ema[i] = candles[i].Cls * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

/**
 * Generic EMA-support detector. `length` picks which EMA to test
 * against, so the same rules drive both the 10 EMA and 21 EMA columns.
 */
function ab_computeEmaSupportTag_(candles, length) {
  length = length || AB_EMA_SUPPORT_LENGTH;
  const n = candles.length;
  if (n < length + 2) return ''; // need the EMA to be established, plus a prior bar for context

  const ema = ab_computeEMA_(candles, length);
  const lastN = Math.min(4, n - length);
  let hitIdx = -1;

  for (let i = Math.max(length, n - lastN); i < n; i++) {
    if (isNaN(ema[i]) || isNaN(ema[i - 1])) continue;
    const wasAboveYesterday = candles[i - 1].Cls > ema[i - 1];
    const touchedToday = candles[i].Low <= ema[i] * (1 + AB_EMA_SUPPORT_TOUCH_PCT / 100);
    const closedAboveToday = candles[i].Cls > ema[i];
    if (wasAboveYesterday && touchedToday && closedAboveToday) hitIdx = i; // keeps the most recent
  }
  if (hitIdx === -1) return '';

  const daysAgo = (n - 1) - hitIdx;
  return length + ' EMA Support ' + (daysAgo === 0 ? '(Today)' : '(' + daysAgo + 'd ago)');
}

/**
 * Reads History30 (same data computeLongFVGTouchPatterns_ uses), computes
 * the 10 EMA support tag per symbol, and writes it to PatternData column
 * Y - its own column, separate from Pattern (W) and Long FVG Touch (X).
 */
function computeEmaSupportPatterns_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const historySheet = ss.getSheetByName(AB_HISTORY_SHEET);
  const sheet2 = ss.getSheetByName(AB_PATTERN_SHEET);
  if (!historySheet) {
    Logger.log('History30 sheet not found - run "Fetch Last 30 Days OHLC" first.');
    return;
  }

  const histData = historySheet.getDataRange().getValues();
  histData.shift(); // header row

  const bySymbol = {}; // symbol -> [{Opn,High,Low,Cls}, ...] oldest -> newest
  histData.forEach(r => {
    const sym = String(r[0]).trim().toUpperCase();
    if (!sym) return;
    if (!bySymbol[sym]) bySymbol[sym] = [];
    bySymbol[sym].push({
      Opn: ab_toNum_(r[2]),
      High: ab_toNum_(r[3]),
      Low: ab_toNum_(r[4]),
      Cls: ab_toNum_(r[5])
    });
  });

  const data = sheet2.getDataRange().getValues();
  // headers, safe to re-set every run
  sheet2.getRange(1, AB_COL_EMA_SUPPORT).setValue('10 EMA Support');
  sheet2.getRange(1, AB_COL_EMA21_SUPPORT).setValue('21 EMA Support');

  const tags10 = [];
  const tags21 = [];
  for (let i = 1; i < data.length; i++) {
    const symbol = String(data[i][3]).trim().toUpperCase(); // col D
    const candles = symbol ? (bySymbol[symbol] || []) : [];
    tags10.push([symbol ? ab_computeEmaSupportTag_(candles, AB_EMA_SUPPORT_LENGTH) : '']);
    tags21.push([symbol ? ab_computeEmaSupportTag_(candles, AB_EMA21_SUPPORT_LENGTH) : '']);
  }

  if (tags10.length) {
    // bulk writes - one call per column instead of one per cell
    sheet2.getRange(2, AB_COL_EMA_SUPPORT, tags10.length, 1).setValues(tags10);
    sheet2.getRange(2, AB_COL_EMA21_SUPPORT, tags21.length, 1).setValues(tags21);
  }
}

/*****************************************************************
 * 14-DAY ATR (EMA-SMOOTHED)
 * -----------------------------------------------------------------
 * True Range per candle:
 *   TR = max(High-Low, |High-PrevClose|, |Low-PrevClose|)
 * Most platforms default ATR to Wilder/RMA smoothing. You asked for
 * EMA smoothing instead, so this seeds with an SMA of the first 14
 * TR values, then applies the standard EMA recursion (k = 2/15) on
 * top of it - same shape as ab_computeEMA_, just over TR instead of
 * Close.
 *****************************************************************/

/** Latest 14-day ATR (EMA-smoothed) for one symbol's candle series. */
function ab_computeATR14EMA_(candles) {
  const n = candles.length;
  const length = AB_ATR_LENGTH;
  if (n < length + 1) return NaN; // need a prior candle for the first TR value

  const tr = new Array(n).fill(NaN);
  tr[0] = candles[0].High - candles[0].Low; // no prior close for the first bar
  for (let i = 1; i < n; i++) {
    const prevClose = candles[i - 1].Cls;
    tr[i] = Math.max(
      candles[i].High - candles[i].Low,
      Math.abs(candles[i].High - prevClose),
      Math.abs(candles[i].Low - prevClose)
    );
  }

  let sum = 0;
  for (let i = 0; i < length; i++) sum += tr[i];
  let atr = sum / length; // SMA seed
  const k = 2 / (length + 1);
  for (let i = length; i < n; i++) {
    atr = tr[i] * k + atr * (1 - k);
  }
  return atr;
}

/**
 * Reads History30, computes 14-day ATR (EMA) per symbol, and writes
 * the raw value to PatternData column Z - its own column alongside
 * Pattern (W), Long FVG Touch (X), 10 EMA Support (Y).
 */
function computeAtrPatterns_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const historySheet = ss.getSheetByName(AB_HISTORY_SHEET);
  const sheet2 = ss.getSheetByName(AB_PATTERN_SHEET);
  if (!historySheet) {
    Logger.log('History30 sheet not found - run "Fetch Last 30 Days OHLC" first.');
    return;
  }

  const histData = historySheet.getDataRange().getValues();
  histData.shift(); // header row

  const bySymbol = {}; // symbol -> [{Opn,High,Low,Cls}, ...] oldest -> newest
  histData.forEach(r => {
    const sym = String(r[0]).trim().toUpperCase();
    if (!sym) return;
    if (!bySymbol[sym]) bySymbol[sym] = [];
    bySymbol[sym].push({
      Opn: ab_toNum_(r[2]),
      High: ab_toNum_(r[3]),
      Low: ab_toNum_(r[4]),
      Cls: ab_toNum_(r[5])
    });
  });

  const data = sheet2.getDataRange().getValues();
  sheet2.getRange(1, AB_COL_ATR).setValue('ATR14 (EMA)'); // header, safe to re-set every run

  // Collect first, write once - same batching fix as syncSymbolsFromBlueprint_
  // above and the sibling signal-column functions (computeEmaSupportPatterns_,
  // computeLongFVGTouchPatterns_). This was the one function in that family
  // still using a setValue() PER ROW - at ~1800 symbols that alone was
  // ~1800 separate Sheets-API round-trips every evening, and together with
  // the same bug in syncSymbolsFromBlueprint_ it was the real reason
  // autoDailyUpdate kept hitting the 6-minute cap (07-Oct-2026). A blank-
  // symbol row keeps whatever was already in its cell, same as before.
  const existingAtr = data.length > 1 ? sheet2.getRange(2, AB_COL_ATR, data.length - 1, 1).getValues() : [];
  const atrs = [];
  for (let i = 1; i < data.length; i++) {
    const symbol = String(data[i][3]).trim().toUpperCase(); // col D
    if (!symbol) { atrs.push([existingAtr[i - 1] ? existingAtr[i - 1][0] : '']); continue; }
    const candles = bySymbol[symbol] || [];
    const atr = ab_computeATR14EMA_(candles);
    atrs.push([isNaN(atr) ? '' : Math.round(atr * 100) / 100]);
  }
  if (atrs.length) {
    sheet2.getRange(2, AB_COL_ATR, atrs.length, 1).setValues(atrs);
  }
}

/*****************************************************************
 * QUARTERLY RESULTS - QoQ / YoY growth from screener.in
 * -----------------------------------------------------------------
 * Parses the "Quarterly Results" table off a company's screener.in
 * page and computes the four growth figures Main tracks:
 *
 *   QoQ Revenue = latest quarter vs the quarter before it
 *   QoQ NP      = same, on Net Profit
 *   YoY Revenue = latest quarter vs the SAME quarter a year earlier
 *   YoY NP      = same, on Net Profit
 *
 * Apps Script has no DOM parser, so the table is read with regexes
 * against the raw HTML. The structure being matched (verified against
 * live pages for both a bank and a non-bank):
 *
 *   <section id="quarters"> <table class="data-table ...">
 *     <thead><th></th><th>Jun 2023</th>...<th>Jun 2026</th></thead>
 *     <tbody>
 *       <tr><td class="text">Sales<button>+</button></td><td>1,234</td>...
 *       <tr><td class="text">Net Profit<button>+</button></td><td>567</td>...
 *
 * Banks label the top line "Revenue"; everyone else calls it "Sales".
 * Both are accepted. Row labels carry a trailing "+" expander button
 * that gets stripped along with the rest of the tags.
 *****************************************************************/

/** Letters+digits only, for tolerant header/label matching. */
function ab_normHeader_(s) {
  return String(s === null || s === undefined ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Strips tags/entities from an HTML fragment and collapses whitespace. */
function ab_stripHtml_(html) {
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Screener cell -> number. Handles "1,234", "-5,665", "12%", "" and "-". */
function ab_qrNum_(text) {
  const s = String(text === null || text === undefined ? '' : text)
    .replace(/,/g, '').replace(/%/g, '').replace(/\s/g, '').trim();
  if (s === '' || s === '-') return NaN;
  const n = Number(s);
  return isNaN(n) ? NaN : n;
}

/**
 * Pulls the quarterly table out of a screener.in company page.
 * Returns { ok, basis, quarters[], revenue[], netProfit[], error }
 * with the arrays ordered oldest -> newest and aligned to `quarters`.
 */
function ab_parseScreenerQuarters_(html) {
  const fail = function (msg) {
    return { ok: false, basis: '', quarters: [], revenue: [], netProfit: [], error: msg };
  };
  if (!html) return fail('empty response');

  const secMatch = html.match(/<section[^>]*id=["']quarters["'][\s\S]*?<\/section>/i);
  if (!secMatch) return fail('no quarterly results section (symbol may not exist on screener)');
  const section = secMatch[0];

  // "Consolidated Figures in Rs. Crores" / "Standalone Figures..." /
  // plain "Figures in Rs. Crores" when the company files only one set.
  let basis = 'Unknown';
  const noteText = ab_stripHtml_(section.slice(0, 900));
  if (/Consolidated Figures/i.test(noteText)) basis = 'Consolidated';
  else if (/Standalone Figures/i.test(noteText)) basis = 'Standalone';
  else if (/Figures in/i.test(noteText)) basis = 'Standalone (only basis reported)';

  const theadMatch = section.match(/<thead[\s\S]*?<\/thead>/i);
  if (!theadMatch) return fail('no table header');
  const quarters = [];
  const thRe = /<th[^>]*>([\s\S]*?)<\/th>/gi;
  let m;
  while ((m = thRe.exec(theadMatch[0])) !== null) quarters.push(ab_stripHtml_(m[1]));
  quarters.shift(); // leading blank corner cell
  if (!quarters.length) return fail('no quarter columns');

  const tbodyMatch = section.match(/<tbody[\s\S]*?<\/tbody>/i);
  if (!tbodyMatch) return fail('no table body');

  let revenue = null, netProfit = null, eps = null;
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr;
  while ((tr = trRe.exec(tbodyMatch[0])) !== null) {
    const cells = [];
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let td;
    while ((td = tdRe.exec(tr[1])) !== null) cells.push(ab_stripHtml_(td[1]));
    if (!cells.length) continue;

    const label = ab_normHeader_(cells[0]); // "Net Profit +" -> "NETPROFIT"
    const nums = cells.slice(1).map(ab_qrNum_);

    // Exact matches only: "SALES"/"REVENUE" must not capture
    // "OTHERINCOME", and "NETPROFIT" must not capture "NETPROFITMARGIN".
    if (!revenue && (label === 'SALES' || label === 'REVENUE')) revenue = nums;
    else if (!netProfit && label === 'NETPROFIT') netProfit = nums;
    else if (!eps && label === 'EPSINRS') eps = nums; // "EPS in Rs"
  }

  if (!revenue) return fail('no Sales/Revenue row');
  if (!netProfit) return fail('no Net Profit row');

  return {
    ok: true, basis: basis, quarters: quarters,
    revenue: revenue, netProfit: netProfit,
    eps: eps || [], // optional - a company can report results without an EPS row
    error: ''
  };
}

/**
 * Sums `count` consecutive quarters ending at index `endIdx` (inclusive).
 * Returns '' if the window runs off the start of the data or any
 * quarter in it is blank - a partial sum would silently understate the
 * figure, which is worse than leaving the cell alone.
 */
function ab_sumQuarters_(arr, endIdx, count) {
  const startIdx = endIdx - count + 1;
  if (!arr || startIdx < 0 || endIdx >= arr.length) return '';
  let total = 0;
  for (let i = startIdx; i <= endIdx; i++) {
    if (isNaN(arr[i])) return '';
    total += arr[i];
  }
  return Math.round(total * 100) / 100;
}

/**
 * Percentage change from `prev` to `cur`.
 *
 * The denominator is |prev| deliberately: when a company swings from a
 * loss to a profit (prev negative), dividing by the signed value flips
 * the sign and reports a turnaround as negative growth. Using the
 * magnitude keeps "loss -> profit" positive, which is how these are
 * normally read. Returns '' when prev is zero or either side is
 * missing, since growth off a zero base has no meaningful percentage.
 */
function ab_pctChange_(cur, prev) {
  if (isNaN(cur) || isNaN(prev) || prev === 0) return '';
  const pct = (cur - prev) / Math.abs(prev) * 100;
  if (!isFinite(pct)) return '';
  const f = Math.pow(10, AB_QR_DECIMALS);
  return Math.round(pct * f) / f;
}

/**
 * Computes the four growth figures from parsed quarter arrays.
 * YoY compares against 4 quarters back - the same quarter last year -
 * so seasonal businesses aren't measured against their off-season.
 */
function ab_computeQuarterGrowth_(parsed) {
  const out = {
    qoqRev: '', qoqNp: '', yoyRev: '', yoyNp: '',
    ttmEps: '', lastFyEps: '',
    latestQuarter: '', basis: parsed.basis || '',
    // True when the company simply hasn't reported enough quarters yet
    // for a year-on-year comparison. Not a failure - the fetch worked
    // and the numbers are real, there just isn't a year of history.
    shortHistory: false, quartersReported: 0
  };
  if (!parsed.ok) return out;

  const rev = parsed.revenue, np = parsed.netProfit, qs = parsed.quarters;
  // The newest column can be a not-yet-reported placeholder; anchor on
  // the last quarter that actually carries a revenue figure.
  let last = -1;
  for (let i = rev.length - 1; i >= 0; i--) {
    if (!isNaN(rev[i])) { last = i; break; }
  }
  if (last < 0) return out;

  out.latestQuarter = qs[last] || '';
  out.quartersReported = last + 1;
  out.shortHistory = (last - 4 < 0); // no year-ago quarter to compare against
  if (last - 1 >= 0) {
    out.qoqRev = ab_pctChange_(rev[last], rev[last - 1]);
    out.qoqNp = ab_pctChange_(np[last], np[last - 1]);
  }
  if (last - 4 >= 0) {
    out.yoyRev = ab_pctChange_(rev[last], rev[last - 4]);
    out.yoyNp = ab_pctChange_(np[last], np[last - 4]);
  }

  // TTM EPS      = the last 4 reported quarters' EPS added up.
  // Last FY EPS  = the 4 quarters immediately before those.
  // Together they give a like-for-like trailing-twelve-month comparison
  // (which is what makes TTM EPS Growth meaningful). Verified against
  // screener's own P&L "TTM" column for SBIN: 93.39.
  if (parsed.eps && parsed.eps.length) {
    out.ttmEps = ab_sumQuarters_(parsed.eps, last, 4);
    out.lastFyEps = ab_sumQuarters_(parsed.eps, last - 4, 4);
  }
  return out;
}

/**
 * Fetches and parses quarterly results for a list of symbols.
 * Uses UrlFetchApp.fetchAll so a batch goes out in parallel rather than
 * one blocking request at a time. Returns { SYM: growthObject|null }.
 *
 * No User-Agent spoofing here: if screener ever blocks Apps Script's
 * requests we want to see that plainly in the log rather than paper
 * over it.
 */
function ab_qrUrl_(sym) {
  return AB_QR_URL_TMPL.replace('{SYM}', encodeURIComponent(sym));
}

/** The standalone (default) company page - the fallback when a company
 *  files no consolidated results. */
function ab_qrPlainUrl_(sym) {
  return 'https://www.screener.in/company/' + encodeURIComponent(sym) + '/';
}


/*****************************************************************
 * SCREENER.IN PAUSE SWITCH
 * -----------------------------------------------------------------
 * Menu: 3. Quarterly Results & Trend Tags > Pause ALL screener.in
 * fetching (2 days) / Resume screener.in fetching.
 *
 * While paused, NOTHING in this script contacts screener.in:
 *   - the Results Day check (scheduled or manual) skips its run
 *   - every bulk Quarterly + Trend Tags pass stands down (same path
 *     as its cooldown)
 *   - named-symbol refreshes (selected rows / pasted lists) stop with
 *     a message instead of trying
 *   - and, as a last safety net, every individual screener fetch
 *     returns "paused" without making a request.
 * Nothing is lost - pending Results Day companies stay pending, blank
 * cells stay blank - and everything picks up again once it resumes
 * (automatically after 2 days, or straight away with Resume).
 *****************************************************************/
const AB_SCREENER_PAUSE_PROP = 'AB_SCREENER_PAUSED_UNTIL';
const AB_SCREENER_PAUSE_DAYS = 2;

/** Minutes left on the manual screener pause, or 0. */
function ab_screenerPauseMin_() {
  const u = Number(PropertiesService.getScriptProperties().getProperty(AB_SCREENER_PAUSE_PROP) || 0);
  return (u && Date.now() < u) ? Math.ceil((u - Date.now()) / 60000) : 0;
}

function ab_screenerPauseText_() {
  const u = Number(PropertiesService.getScriptProperties().getProperty(AB_SCREENER_PAUSE_PROP) || 0);
  return 'screener.in fetching is paused until ' + Utilities.formatDate(new Date(u), AB_TZ, 'dd-MMM-yyyy HH:mm') +
         ' IST (menu: 3. Quarterly Results & Trend Tags > Resume screener.in fetching)';
}

/** Menu: stop every screener.in fetch for 2 days. */
function runPauseScreener2Days() {
  const until = Date.now() + AB_SCREENER_PAUSE_DAYS * 86400000;
  PropertiesService.getScriptProperties().setProperty(AB_SCREENER_PAUSE_PROP, String(until));
  const when = Utilities.formatDate(new Date(until), AB_TZ, 'dd-MMM-yyyy HH:mm');
  Logger.log('screener.in fetching paused until ' + when + ' IST.');
  SpreadsheetApp.getActiveSpreadsheet().toast('All screener.in fetching is paused until ' + when + ' IST - Results Day ' +
    'check and every Quarterly + Trend Tags run stand down. Nothing is lost; it resumes by itself.',
    'screener.in paused', 15);
}

/** Menu: allow screener.in fetching again now (also clears the automatic cooldowns). */
function runResumeScreener() {
  const props = PropertiesService.getScriptProperties();
  [AB_SCREENER_PAUSE_PROP, AB_QR_COOLDOWN_PROP, AB_QT_COOLDOWN_PROP, AB_TT_COOLDOWN_PROP]
    .forEach(function (k) { props.deleteProperty(k); });
  SpreadsheetApp.getActiveSpreadsheet().toast('screener.in fetching is back on (automatic cooldowns cleared too). ' +
    'If screener is still blocking, runs will stop again after a few refusals.', 'screener.in resumed', 12);
}


/*****************************************************************
 * NEW SYMBOL AUTO-FILL
 * -----------------------------------------------------------------
 * Paste a symbol into Main's SYMBOL column and run this - it fills in
 * StockName, Sector, Industry and Basic Industry, and copies the
 * NSE Ticker / Chart / Screener.in cells down from the row above so
 * they keep whatever formula style you already use.
 *
 * Source is the same screener.in company page the quarterly figures
 * come from. Its "Peer comparison" block carries the full NSE-style
 * classification as four titled links:
 *
 *   title="Broad Sector"    Financial Services
 *   title="Sector"          Financial Services   -> Main "Sector"
 *   title="Broad Industry"  Banks                -> Main "Industry"
 *   title="Industry"        Public Sector Bank   -> Main "Basic Industry"
 *
 * Note the deliberate offset: what screener calls "Broad Industry" is
 * your "Industry", and its "Industry" is your "Basic Industry". That's
 * NSE's own four-level taxonomy (Macro / Sector / Industry / Basic
 * Industry) under different labels - verified against SBIN, where NSE
 * lists Sector=Financial Services, Industry=Banks, Basic Industry=
 * Public Sector Bank.
 *****************************************************************/
const AB_NEWSYM_MAX_PER_RUN = 40;

/*****************************************************************
 * NSE INDUSTRY CLASSIFICATION (official, July 2023)
 * -----------------------------------------------------------------
 * Transcribed from "NSE Indices Industry Classification Structure,
 * July 2023". Nothing outside this table is ever written into Main -
 * whatever a third-party site calls an industry, the value that lands
 * in the sheet is the official one.
 *
 * Shape: [ Sector, Industry, [ Basic Industries... ] ]
 * These map 1:1 onto Main's Sector / Industry / Basic Industry.
 *
 * Basic Industry is the key: it's unique across the whole table, so
 * matching on it pins the Sector and Industry above it automatically -
 * which means the three columns can never disagree with each other.
 *****************************************************************/
const AB_NSE_TAXONOMY = [
  // IN01 Commodities
  ['Chemicals', 'Chemicals & Petrochemicals', ['Commodity Chemicals', 'Specialty Chemicals', 'Carbon Black', 'Dyes And Pigments', 'Explosives', 'Petrochemicals', 'Printing Inks', 'Trading - Chemicals', 'Industrial Gases']],
  ['Chemicals', 'Fertilizers & Agrochemicals', ['Fertilizers', 'Pesticides & Agrochemicals']],
  ['Construction Materials', 'Cement & Cement Products', ['Cement & Cement Products']],
  ['Construction Materials', 'Other Construction Materials', ['Other Construction Materials']],
  ['Metals & Mining', 'Ferrous Metals', ['Ferro & Silica Manganese', 'Pig Iron', 'Sponge Iron', 'Iron & Steel']],
  ['Metals & Mining', 'Non - Ferrous Metals', ['Aluminium', 'Copper', 'Zinc', 'Precious Metals']],
  ['Metals & Mining', 'Diversified Metals', ['Diversified Metals']],
  ['Metals & Mining', 'Minerals & Mining', ['Industrial Minerals']],
  ['Metals & Mining', 'Metals & Minerals Trading', ['Trading - Metals', 'Trading - Minerals']],
  ['Forest Materials', 'Paper, Forest & Jute Products', ['Paper & Paper Products', 'Forest Products', 'Jute & Jute Products']],
  // IN02 Consumer Discretionary
  ['Automobile and Auto Components', 'Automobiles', ['Passenger Cars & Utility Vehicles', '2/3 Wheelers', 'Auto Dealer']],
  ['Automobile and Auto Components', 'Auto Components', ['Auto Components & Equipments', 'Tyres & Rubber Products', 'Trading - Auto Components']],
  ['Consumer Durables', 'Consumer Durables', ['Cycles', 'Consumer Electronics', 'Furniture, Home Furnishing', 'Ceramics', 'Granites & Marbles', 'Gems, Jewellery And Watches', 'Glass - Consumer', 'Household Appliances', 'Houseware', 'Leather And Leather Products', 'Leisure Products', 'Plastic Products - Consumer', 'Plywood Boards/ Laminates', 'Sanitary Ware', 'Paints', 'Diversified consumer products', 'Footwear']],
  ['Textiles', 'Textiles & Apparels', ['Garments & Apparels', 'Other Textile Products', 'Trading - Textile Products']],
  ['Media, Entertainment & Publication', 'Media', ['Advertising & Media Agencies', 'Electronic Media', 'Web based media and service', 'Print Media']],
  ['Media, Entertainment & Publication', 'Entertainment', ['Film Production, Distribution & Exhibition', 'Digital Entertainment', 'Media & Entertainment', 'TV Broadcasting & Software Production']],
  ['Media, Entertainment & Publication', 'Printing & Publication', ['Printing & Publication']],
  ['Realty', 'Realty', ['Residential, Commercial Projects', 'Real Estate related services', 'Real Estate Investment Trusts (REITs)']],
  ['Consumer Services', 'Leisure Services', ['Hotels & Resorts', 'Restaurants', 'Amusement Parks/ Other Recreation', 'Wellness', 'Tour, Travel Related Services']],
  ['Consumer Services', 'Other Consumer Services', ['Education', 'E-Learning', 'Food Storage Facilities', 'Other Consumer Services']],
  ['Consumer Services', 'Retailing', ['Speciality Retail', 'Pharmacy Retail', 'Diversified Retail', 'E-Retail/ E-Commerce', 'Internet & Catalogue Retail', 'Distributors']],
  // IN03 Energy
  ['Oil, Gas & Consumable Fuels', 'Gas', ['Gas Transmission/Marketing', 'LPG/CNG/PNG/LNG Supplier', 'Trading - Gas']],
  ['Oil, Gas & Consumable Fuels', 'Oil', ['Oil Exploration & Production', 'Offshore Support Solution Drilling', 'Oil Storage & Transportation', 'Oil Equipment & Services']],
  ['Oil, Gas & Consumable Fuels', 'Petroleum Products', ['Refineries & Marketing', 'Lubricants']],
  ['Oil, Gas & Consumable Fuels', 'Consumable Fuels', ['Coal', 'Trading - Coal']],
  // IN04 FMCG
  ['Fast Moving Consumer Goods', 'Agricultural Food & other Products', ['Edible Oil', 'Sugar', 'Tea & Coffee', 'Other Agricultural Products']],
  ['Fast Moving Consumer Goods', 'Beverages', ['Breweries & Distilleries', 'Other Beverages']],
  ['Fast Moving Consumer Goods', 'Cigarettes & Tobacco Products', ['Cigarettes & Tobacco Products']],
  ['Fast Moving Consumer Goods', 'Food Products', ['Animal Feed', 'Dairy Products', 'Other Food Products', 'Packaged Foods', 'Seafood', 'Meat Products including Poultry']],
  ['Fast Moving Consumer Goods', 'Personal Products', ['Personal Care']],
  ['Fast Moving Consumer Goods', 'Household Products', ['Household Products', 'Stationary']],
  ['Fast Moving Consumer Goods', 'Diversified FMCG', ['Diversified FMCG']],
  // IN05 Financial Services
  ['Financial Services', 'Finance', ['Financial Institution', 'Housing Finance Company', 'Investment Company', 'Non Banking Financial Company (NBFC)', 'Other Financial Services', 'Holding Company', 'Microfinance Institutions', 'Securitisation']],
  ['Financial Services', 'Banks', ['Public Sector Bank', 'Private Sector Bank', 'Other Bank']],
  ['Financial Services', 'Capital Markets', ['Asset Management Company', 'Depositories, Clearing Houses and Other Intermediaries', 'Financial Products Distributor', 'Ratings', 'Exchange and Data Platform', 'Stockbroking & Allied', 'Other Capital Market related Services']],
  ['Financial Services', 'Insurance', ['General Insurance', 'Life Insurance', 'Other Insurance Companies', 'Insurance Distributors']],
  ['Financial Services', 'Financial Technology (Fintech)', ['Financial Technology (Fintech)']],
  // IN06 Healthcare
  ['Healthcare', 'Pharmaceuticals & Biotechnology', ['Pharmaceuticals', 'Biotechnology']],
  ['Healthcare', 'Healthcare Equipment & Supplies', ['Medical Equipment & Supplies']],
  ['Healthcare', 'Healthcare Services', ['Hospital', 'Healthcare Service Provider', 'Healthcare Research, Analytics & Technology']],
  // IN07 Industrials
  ['Construction', 'Construction', ['Civil Construction']],
  ['Capital Goods', 'Aerospace & Defense', ['Aerospace & Defense']],
  ['Capital Goods', 'Agricultural, Commercial & Construction Vehicles', ['Tractors', 'Commercial Vehicles', 'Construction Vehicles', 'Dealers-Commercial Vehicles, Tractors, Construction Vehicles']],
  ['Capital Goods', 'Electrical Equipment', ['Heavy Electrical Equipment', 'Other Electrical Equipment']],
  ['Capital Goods', 'Industrial Manufacturing', ['Railway Wagons', 'Ship Building & Allied Services', 'Industrial Products']],
  ['Capital Goods', 'Industrial Products', ['Cables - Electricals', 'Castings & Forgings', 'Packaging', 'Plastic Products - Industrial', 'Rubber', 'Other Industrial Products', 'Glass - Industrial', 'Aluminium, Copper & Zinc Products', 'Iron & Steel Products', 'Abrasives & Bearings', 'Compressors, Pumps & Diesel Engines', 'Electrodes & Refractories']],
  // IN08 Information Technology
  ['Information Technology', 'IT - Software', ['Computers - Software & Consulting', 'Software Products']],
  ['Information Technology', 'IT - Services', ['IT Enabled Services']],
  ['Information Technology', 'IT - Hardware', ['Computers Hardware & Equipments']],
  // IN09 Services
  ['Services', 'Engineering Services', ['Dredging']],
  ['Services', 'Transport Services', ['Airline', 'Logistics Solution Provider', 'Railways', 'Road Transport', 'Shipping', 'Transport Related Services']],
  ['Services', 'Transport Infrastructure', ['Airport & Airport services', 'Port & Port services', 'Road Assets-Toll, Annuity, Hybrid-Annuity']],
  ['Services', 'Commercial Services & Supplies', ['Trading & Distributors', 'Consulting Services', 'Data Processing Services', 'Diversified Commercial Services', 'Business Process Outsourcing (BPO)/ Knowledge Process Outsourcing (KPO)']],
  ['Services', 'Public Services', ['Urban Local Bodies', 'Development Authority']],
  // IN10 Telecommunication
  ['Telecommunication', 'Telecom - Services', ['Telecom - Cellular & Fixed line services', 'Telecom - Infrastructure', 'Other Telecom Services']],
  ['Telecommunication', 'Telecom - Equipment & Accessories', ['Telecom - Equipment & Accessories']],
  // IN11 Utilities
  ['Power', 'Power', ['Power Generation', 'Integrated Power Utilities', 'Power Trading', 'Power - Transmission', 'Power Distribution']],
  ['Utilities', 'Other Utilities', ['Water Supply & Management', 'Waste Management', 'Emergency Services', 'Multi Utilities', 'Other Utilities']],
  // IN12 Diversified
  ['Diversified', 'Diversified', ['Diversified']]
];

/** Lazily-built indexes over AB_NSE_TAXONOMY, keyed on normalised text. */
var AB_NSE_INDEX_ = null;
function ab_nseIndex_() {
  if (AB_NSE_INDEX_) return AB_NSE_INDEX_;
  const byBasic = {}, byIndustry = {}, sectors = {};
  AB_NSE_TAXONOMY.forEach(function (row) {
    const sector = row[0], industry = row[1];
    sectors[ab_normHeader_(sector)] = sector;
    // An Industry name is unique in this table EXCEPT where it repeats
    // under the same Sector, so first-wins is safe.
    const ik = ab_normHeader_(industry);
    if (!byIndustry[ik]) byIndustry[ik] = { sector: sector, industry: industry };
    row[2].forEach(function (basic) {
      byBasic[ab_normHeader_(basic)] = { sector: sector, industry: industry, basicIndustry: basic };
    });
  });
  AB_NSE_INDEX_ = { byBasic: byBasic, byIndustry: byIndustry, sectors: sectors };
  return AB_NSE_INDEX_;
}

/**
 * Resolves whatever a source called things into the official triple.
 * Basic Industry wins - it uniquely determines the two levels above it,
 * so the three columns can't end up inconsistent. Falls back to the
 * Industry level, and returns null if neither is recognised (in which
 * case nothing is written, rather than writing something unofficial).
 */
function ab_nseResolve_(sectorRaw, industryRaw, basicRaw) {
  const idx = ab_nseIndex_();
  const b = idx.byBasic[ab_normHeader_(basicRaw)];
  if (b) return { sector: b.sector, industry: b.industry, basicIndustry: b.basicIndustry, matched: 'basic' };
  const i = idx.byIndustry[ab_normHeader_(industryRaw)];
  if (i) return { sector: i.sector, industry: i.industry, basicIndustry: '', matched: 'industry' };
  return null;
}


/**
 * Company names for newly-added symbols, batched through GOOGLEFINANCE
 * (one flush for the whole slice) - an open data source, not screener.
 * Returns { SYMBOL: name }.
 */
function ab_fetchStockNames_(symbols) {
  const out = {};
  if (!symbols || !symbols.length) return out;
  const scratch = ab_getScratchSheet_();
  scratch.clearContents();
  if (scratch.getMaxRows() < symbols.length) {
    scratch.insertRowsAfter(scratch.getMaxRows(), symbols.length - scratch.getMaxRows());
  }
  symbols.forEach(function (sym, i) {
    scratch.getRange(i + 1, 1).setFormula(
      '=IFERROR(GOOGLEFINANCE("NSE:' + sym + '","name"),"")');
  });
  SpreadsheetApp.flush(); // one flush for all of them
  const vals = scratch.getRange(1, 1, symbols.length, 1).getValues();
  symbols.forEach(function (sym, i) {
    const v = ab_cellText_(vals[i][0]).trim();
    if (v) out[sym] = v;
  });
  scratch.clearContents();
  return out;
}

/**
 * Fills details for every Main row that has a SYMBOL but no StockName.
 *
 * No screener.in fetch happens here at all:
 *  - StockName comes from GOOGLEFINANCE (an open source), batched in one
 *    round-trip.
 *  - Basic Industry is never written - you fill that by hand from the
 *    NSE website. Sector and Industry are looked up from whatever Basic
 *    Industry you've already typed in, against the official NSE table.
 *  - NSE Ticker / Chart / Screener.in are built fresh from each row's OWN
 *    symbol (never copied from another row) - copying a formula whose
 *    symbol is baked into a literal URL string just duplicates the same
 *    symbol into every new row, since copyTo() only adjusts relative
 *    cell references, not text inside the formula.
 */
function fillNewSymbolDetails_() {
  const layout = ab_getMainLayout_();
  if (layout.name === -1 || layout.symbol === -1) {
    throw new Error('Main needs both "StockName" and "SYMBOL" columns.');
  }
  if (layout.basicIndustry === -1) {
    throw new Error('Main needs a "Basic Industry" column to map Sector/Industry from.');
  }

  const header = layout.header;
  function colOf(n) { return header.indexOf(n); }
  const tickerCol = colOf('NSE Ticker');
  const chartCol = colOf('Chart');
  const screenerCol = colOf('Screener.in');

  const data = layout.data;
  const todo = [];
  for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
    const sym = ab_cellText_(data[r][layout.symbol]).toUpperCase();
    const name = ab_cellText_(data[r][layout.name]);
    if (!sym && !name) break; // end of the watchlist block
    if (!sym) continue;
    if (name) continue;
    todo.push({
      rowIdx: r,
      sym: sym,
      basicIndustry: ab_cellText_(data[r][layout.basicIndustry])
    });
  }

  const summary = { requested: 0, filled: 0, failed: 0, lines: [] };
  if (!todo.length) return summary;

  const slice = todo.slice(0, AB_NEWSYM_MAX_PER_RUN);
  const names = ab_fetchStockNames_(slice.map(function (t) { return t.sym; }));

  slice.forEach(function (t, i) {
    summary.requested++;
    const row = t.rowIdx + 1;
    const name = names[t.sym];

    if (name) {
      layout.sheet.getRange(row, layout.name + 1).setValue(name);
    } else {
      summary.failed++;
    }

    // Sector/Industry are mapped from the Basic Industry you've already
    // typed in by hand - Basic Industry itself is never overwritten here.
    let clsNote;
    if (!t.basicIndustry) {
      clsNote = 'Basic Industry blank - fill it in first';
    } else {
      const cls = ab_nseResolve_('', '', t.basicIndustry);
      if (!cls) {
        clsNote = '"' + t.basicIndustry + '" not found in NSE structure - Sector/Industry left blank';
      } else {
        if (layout.sector !== -1) layout.sheet.getRange(row, layout.sector + 1).setValue(cls.sector);
        if (layout.industry !== -1) layout.sheet.getRange(row, layout.industry + 1).setValue(cls.industry);
        clsNote = cls.sector + ' > ' + cls.industry;
      }
    }

    // Link columns: always built fresh from THIS row's own symbol, never
    // copied from another row (the symbol is a literal string inside the
    // URL, not a cell reference, so copyTo would just repeat whichever
    // symbol the source row happened to have).
    if (tickerCol !== -1) layout.sheet.getRange(row, tickerCol + 1).setValue('NSE:' + t.sym);
    if (chartCol !== -1) {
      layout.sheet.getRange(row, chartCol + 1)
        .setFormula('=HYPERLINK("' + ab_chartUrl_(t.sym) + '","📈 Chart")');
    }
    if (screenerCol !== -1) {
      layout.sheet.getRange(row, screenerCol + 1)
        .setFormula('=HYPERLINK("' + ab_screenerUrl_(t.sym) + '","📊 Screener")');
    }

    summary.filled++;
    summary.lines.push(t.sym + ': ' + (name || '(name not found)') + ' | ' + clsNote);
    Logger.log('[' + (i + 1) + '/' + slice.length + '] row ' + row + '  ' + t.sym + '  ' +
               (name || '(name not found)') + '  |  ' + clsNote);
  });

  if (todo.length > slice.length) {
    summary.lines.push((todo.length - slice.length) + ' more row(s) left - run again.');
  }
  return summary;
}

/** Menu: fill in details for any newly pasted symbols. */
function runFillNewSymbols() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Filling in newly pasted symbols...');
  try {
    const s = fillNewSymbolDetails_();
    if (!s.requested) { ss.toast('No rows with a SYMBOL but no StockName - nothing to fill.'); return; }
    logRun_(Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm'), '', s.filled,
            'OK (new symbols)', s.filled + ' filled, ' + s.failed + ' name lookup failed. ' + s.lines.join(' ; '));
    ss.toast(s.filled + ' filled, ' + s.failed + ' name lookup failed.\n' + s.lines.slice(0, 8).join('\n'),
             'New symbols', 30);
  } catch (e) {
    ss.toast('Fill failed: ' + e.message);
  }
}

/*****************************************************************
 * SECTOR / INDUSTRY FILL FROM AN ALREADY-TYPED BASIC INDUSTRY
 * -----------------------------------------------------------------
 * fillNewSymbolDetails_ above already maps Sector/Industry from a
 * hand-typed Basic Industry, using the exact same ab_nseResolve_
 * lookup this function calls too - but it only looks at rows with a
 * BLANK StockName, since that's what marks a freshly-pasted symbol
 * needing its whole row built. It deliberately skips any row that
 * already has a StockName (the "if (name) continue;" a few lines up)
 * on the assumption that a named row has already been filled in.
 *
 * That assumption breaks for a batch of symbols added earlier whose
 * StockName was already there, but whose Basic Industry has ONLY JUST
 * been typed in by hand (e.g. copied off the NSE quote page for each
 * one) - Sector and Industry next to it are still blank, and nothing
 * else in the script ever revisits those two cells. This scans the
 * WHOLE watchlist block instead - not just blank-StockName rows, the
 * same "scan everything, only touch genuinely blank cells" approach
 * fillChartScreenerLinks_ uses - and fills Sector/Industry for any row
 * that has a Basic Industry typed in but is still missing one or both
 * of the two columns above it. Basic Industry itself is never written,
 * only read; a row that's already fully classified, or has no Basic
 * Industry to look up yet, is left untouched.
 *****************************************************************/
function fillSectorIndustryFromBasicIndustry_() {
  const layout = ab_getMainLayout_();
  if (layout.basicIndustry === -1) {
    throw new Error('Main needs a "Basic Industry" column to map Sector/Industry from.');
  }
  if (layout.sector === -1 && layout.industry === -1) {
    throw new Error('Main needs a "Sector" and/or "Industry" column to fill.');
  }

  const data = layout.data;
  const summary = { scanned: 0, filled: 0, notFound: [], lines: [] };

  for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
    const sym = ab_cellText_(data[r][layout.symbol]).toUpperCase();
    const name = ab_cellText_(data[r][layout.name]);
    if (!sym && !name) break; // end of the watchlist block
    if (!sym) continue;

    const basicIndustry = ab_cellText_(data[r][layout.basicIndustry]);
    if (!basicIndustry) continue; // nothing to look up yet

    const sectorBlank = layout.sector !== -1 && ab_cellText_(data[r][layout.sector]) === '';
    const industryBlank = layout.industry !== -1 && ab_cellText_(data[r][layout.industry]) === '';
    if (!sectorBlank && !industryBlank) continue; // already fully classified

    summary.scanned++;
    const cls = ab_nseResolve_('', '', basicIndustry);
    if (!cls) {
      summary.notFound.push(sym + ' ("' + basicIndustry + '")');
      continue;
    }

    const row = r + 1;
    if (sectorBlank) layout.sheet.getRange(row, layout.sector + 1).setValue(cls.sector);
    if (industryBlank) layout.sheet.getRange(row, layout.industry + 1).setValue(cls.industry);
    summary.filled++;
    summary.lines.push(sym + ': ' + cls.sector + ' > ' + cls.industry);
  }

  return summary;
}

/** Menu: fill Sector/Industry for any row whose Basic Industry is
 *  already typed in but Sector and/or Industry is still blank. */
function runFillSectorIndustryFromBasicIndustry() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Filling Sector/Industry from Basic Industry...');
  try {
    const s = fillSectorIndustryFromBasicIndustry_();
    if (!s.scanned) {
      ss.toast('Nothing to do - every row is either fully classified or has no Basic Industry typed in yet.');
      return;
    }
    let msg = s.filled + ' row(s) filled (of ' + s.scanned + ' scanned).';
    if (s.notFound.length) {
      msg += ' ' + s.notFound.length + ' Basic Industry value(s) not recognised - check spelling ' +
             'against the NSE list: ' + s.notFound.slice(0, 10).join(', ') +
             (s.notFound.length > 10 ? ' +' + (s.notFound.length - 10) + ' more' : '') + '.';
    }
    logRun_(Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm'), '', s.filled,
            'OK (sector/industry from basic industry)', msg + ' ' + s.lines.join(' ; '));
    ss.toast(msg, 'Sector/Industry fill', 20);
  } catch (e) {
    ss.toast('Fill failed: ' + e.message);
  }
}


/**
 * Audits every existing Main row against the official NSE structure and
 * writes the mismatches to a "Classification Audit" tab.
 *
 * Nothing is changed in Main - this only reports, so you can decide
 * what to correct. Three kinds of finding:
 *   NOT IN LIST   - the Basic Industry isn't an official one at all
 *   INCONSISTENT  - Basic Industry is valid, but the Sector/Industry
 *                   next to it don't belong to it
 *   BLANK         - classification missing entirely
 */
function auditIndustryClassification() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const layout = ab_getMainLayout_();
  const data = layout.data;
  const rows = [];

  for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
    const sym = ab_cellText_(data[r][layout.symbol]).toUpperCase();
    const name = ab_cellText_(data[r][layout.name]);
    if (!sym && !name) break;
    if (!sym) continue;

    const sec = layout.sector !== -1 ? ab_cellText_(data[r][layout.sector]) : '';
    const ind = layout.industry !== -1 ? ab_cellText_(data[r][layout.industry]) : '';
    const bas = layout.basicIndustry !== -1 ? ab_cellText_(data[r][layout.basicIndustry]) : '';

    if (!sec && !ind && !bas) {
      rows.push([r + 1, sym, sec, ind, bas, 'BLANK', '', '', '']);
      continue;
    }
    const cls = ab_nseResolve_(sec, ind, bas);
    if (!cls) {
      rows.push([r + 1, sym, sec, ind, bas, 'NOT IN LIST', '', '', '']);
    } else if (cls.matched === 'basic' &&
               (ab_normHeader_(sec) !== ab_normHeader_(cls.sector) ||
                ab_normHeader_(ind) !== ab_normHeader_(cls.industry))) {
      rows.push([r + 1, sym, sec, ind, bas, 'INCONSISTENT',
                 cls.sector, cls.industry, cls.basicIndustry]);
    }
  }

  const sh = ab_getOrCreateSheet_('Classification Audit');
  sh.clearContents();
  sh.getRange(1, 1, 1, 9).setValues([['Row', 'Symbol', 'Sector (sheet)', 'Industry (sheet)',
    'Basic Industry (sheet)', 'Issue', 'Official Sector', 'Official Industry', 'Official Basic Industry']]);
  sh.setFrozenRows(1);
  if (rows.length) sh.getRange(2, 1, rows.length, 9).setValues(rows);
  sh.getRange(1, 1, 1, 9).setFontWeight('bold');

  ss.toast(rows.length
    ? (rows.length + ' row(s) differ from the NSE structure - see "Classification Audit".')
    : 'Every row matches the official NSE classification.');
  return rows.length;
}

/**
 * Applies the official NSE classification from the "Classification Audit"
 * tab (built by auditIndustryClassification()) back into Main, fixing
 * every row flagged INCONSISTENT - i.e. the 68 stocks whose Sector/
 * Industry don't match their own Basic Industry.
 *
 * For each INCONSISTENT audit row, writes:
 *   Official Sector         -> Main's Sector column
 *   Official Industry       -> Main's Industry column
 *   Official Basic Industry -> Main's Basic Industry column
 *
 * The audit's "Row" column already holds the exact 1-based Main row
 * (auditIndustryClassification() wrote it as r + 1), so it's used
 * directly - but as a safety net in case Main's rows shifted since the
 * audit was last run, the Symbol at that row is checked first; on a
 * mismatch, Main is re-scanned for that Symbol and the row found that
 * way is used instead. A Symbol that can't be found anywhere in Main
 * is skipped and reported, never guessed at.
 *
 * BLANK and NOT IN LIST audit rows have no Official values to apply
 * (auditIndustryClassification() only fills those three columns for
 * INCONSISTENT rows) and are skipped automatically.
 */
function fixClassificationFromAudit_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const auditSh = ss.getSheetByName('Classification Audit');
  const summary = { scanned: 0, fixed: 0, rowShifted: [], notFound: [], lines: [] };
  if (!auditSh) {
    summary.error = 'No "Classification Audit" tab found - run "Audit Industry Classification vs NSE list" first.';
    return summary;
  }

  const auditData = auditSh.getDataRange().getValues();
  if (auditData.length < 2) return summary; // header only, nothing to fix

  const layout = ab_getMainLayout_();
  if (layout.sector === -1 && layout.industry === -1 && layout.basicIndustry === -1) {
    throw new Error('Main needs Sector/Industry/Basic Industry columns to apply the fix to.');
  }

  const mainData = layout.data;
  // Build a symbol -> 1-based row lookup over Main, for the fallback re-scan.
  const symbolToRow = {};
  for (let r = layout.headerRowIdx + 1; r < mainData.length; r++) {
    const sym = ab_cellText_(mainData[r][layout.symbol]).toUpperCase();
    const name = ab_cellText_(mainData[r][layout.name]);
    if (!sym && !name) break;
    if (sym && symbolToRow[sym] === undefined) symbolToRow[sym] = r + 1;
  }

  for (let i = 1; i < auditData.length; i++) {
    const auditRow = auditData[i];
    const sym = ab_cellText_(auditRow[1]).toUpperCase();
    const issue = ab_cellText_(auditRow[5]);
    const offSector = ab_cellText_(auditRow[6]);
    const offIndustry = ab_cellText_(auditRow[7]);
    const offBasic = ab_cellText_(auditRow[8]);
    if (!sym) continue;
    if (issue !== 'INCONSISTENT') continue; // BLANK / NOT IN LIST have nothing to apply
    if (!offSector && !offIndustry && !offBasic) continue; // nothing to write

    summary.scanned++;

    let row = Number(auditRow[0]) || 0;
    const symAtRow = row >= 1 && row <= mainData.length
      ? ab_cellText_(mainData[row - 1][layout.symbol]).toUpperCase() : '';
    if (symAtRow !== sym) {
      const shifted = symbolToRow[sym];
      if (!shifted) {
        summary.notFound.push(sym);
        continue;
      }
      row = shifted;
      summary.rowShifted.push(sym);
    }

    if (offSector && layout.sector !== -1) layout.sheet.getRange(row, layout.sector + 1).setValue(offSector);
    if (offIndustry && layout.industry !== -1) layout.sheet.getRange(row, layout.industry + 1).setValue(offIndustry);
    if (offBasic && layout.basicIndustry !== -1) layout.sheet.getRange(row, layout.basicIndustry + 1).setValue(offBasic);
    summary.fixed++;
    summary.lines.push(sym + ': ' + offSector + ' > ' + offIndustry + ' > ' + offBasic);
  }

  return summary;
}

/** Menu: apply the official NSE Sector/Industry/Basic Industry from the
 *  "Classification Audit" tab onto every INCONSISTENT row in Main. */
function runFixClassificationFromAudit() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Applying official classification from Classification Audit...');
  try {
    const s = fixClassificationFromAudit_();
    if (s.error) {
      ss.toast(s.error);
      return;
    }
    if (!s.scanned) {
      ss.toast('Nothing to fix - no INCONSISTENT rows found in "Classification Audit". Re-run the audit if Main has changed.');
      return;
    }
    let msg = s.fixed + ' row(s) corrected (of ' + s.scanned + ' INCONSISTENT).';
    if (s.rowShifted.length) {
      msg += ' ' + s.rowShifted.length + ' row(s) had shifted since the audit and were re-located by Symbol: ' +
             s.rowShifted.slice(0, 10).join(', ') +
             (s.rowShifted.length > 10 ? ' +' + (s.rowShifted.length - 10) + ' more' : '') + '.';
    }
    if (s.notFound.length) {
      msg += ' ' + s.notFound.length + ' Symbol(s) from the audit could not be found in Main at all - ' +
             're-run the audit: ' + s.notFound.slice(0, 10).join(', ') +
             (s.notFound.length > 10 ? ' +' + (s.notFound.length - 10) + ' more' : '') + '.';
    }
    logRun_(Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm'), '', s.fixed,
            'OK (classification fixed from audit)', msg + ' ' + s.lines.join(' ; '));
    ss.toast(msg, 'Classification fix', 20);
  } catch (e) {
    ss.toast('Fix failed: ' + e.message);
  }
}

/*****************************************************************
 * TREND TAGS  (Promotor Holding / FII Activity / OPM YoY% / OPM QoQ%)
 * -----------------------------------------------------------------
 * Reads screener.in and writes one of four words into each column:
 *
 *     Increasing | Decreasing | Stagnant | Volatile
 *
 * What each column looks at (exactly as specified):
 *
 *   OPM QoQ%          last 2 QUARTERS of the quarterly OPM % row
 *   OPM YoY%          last 2 FINANCIAL YEARS of the annual OPM % row,
 *                     with the TTM column deliberately dropped
 *   Promotor Holding  last 4 QUARTERS of the Promoters row
 *   FII Activity      last 4 QUARTERS of the FIIs row
 *
 * With only 2 data points a series cannot be "Volatile" - it can only
 * rise, fall, or sit still - so the OPM columns never produce that tag.
 * The 4-quarter holding columns can.
 *
 * THIS SECTION IS DELIBERATELY STANDALONE. It shares no state, no
 * cooldown, and no call path with the Quarterly Results engine - it has
 * its own fetch, its own cooldown property and its own parsers, so
 * running one never triggers or interferes with the other.
 *****************************************************************/

const AB_TT_PROMOTER_HEADER = 'Promotor Holding';
const AB_TT_FII_HEADER = 'FII Activity';
const AB_TT_OPM_YOY_HEADER = 'OPM YoY%';
const AB_TT_OPM_QOQ_HEADER = 'OPM QoQ%';


// Its OWN cooldown key - independent of AB_QR_COOLDOWN_PROP.
const AB_TT_COOLDOWN_PROP = 'AB_TT_COOLDOWN_UNTIL';

// "Noise floor" in percentage points for PROMOTER/FII holdings: a move
// smaller than this is not treated as a real move.
//
// OPM no longer has a single noise floor - it uses the graded bands
// further down (AB_TT_OPM_FLAT_PP and friends) instead, because one
// threshold cannot tell "unchanged" from "improved a little".
const AB_TT_HOLDING_NOISE_PP = 1.0;

// For a series that moves both ways, this decides "trending" vs "noisy".
// It's the efficiency ratio: how far the value actually ended up from
// where it started, divided by the total distance it travelled getting
// there. A straight climb scores 1.0; a series that zig-zags back over
// its own path scores near 0. Below this cutoff the move is Volatile.
const AB_TT_EFFICIENCY_MIN = 0.5;

// The override that keeps the calm settings above from hiding real news:
// if the MOST RECENT quarter moved at least this much, that move decides
// the tag outright. So a promoter dumping 7pp last quarter reads
// Decreasing even though the three quarters before it were flat, while
// ordinary drift keeps getting smoothed into Stagnant.
const AB_TT_HOLDING_AGGRESSIVE_PP = 2.0;

const AB_TT_TAG_INCREASING = 'Increasing';
const AB_TT_TAG_DECREASING = 'Decreasing';
const AB_TT_TAG_STAGNANT = 'Stagnant';
const AB_TT_TAG_VOLATILE = 'Volatile';

// ---- OPM-only tags -------------------------------------------------
// A single noise floor can't describe a margin. Lumping "16% -> 17%"
// in with "16% -> 16%" as Stagnant throws away a real improvement, and
// calling "19% -> 33%" merely Increasing understates a step change.
// So OPM gets its own graded scale, in percentage POINTS:
//
//   < AB_TT_OPM_FLAT_PP        Stagnant             16 -> 16.4
//   < AB_TT_OPM_SLIGHT_PP      Slightly Increasing  16 -> 17     (MUTHOOTMF)
//   < AB_TT_OPM_AGGRESSIVE_PP  Increasing           16 -> 19
//   >=                          Aggressive Increase  19 -> 33     (INDO-MIM)
//
// Mirrored for falls. These apply ONLY to the two OPM columns -
// promoter and FII holdings keep the original four tags, because a
// stake moving 5pp is a completely different event from a margin
// moving 5pp and shouldn't share a scale.
const AB_TT_TAG_SLIGHT_UP = 'Slightly Increasing';
const AB_TT_TAG_SLIGHT_DOWN = 'Slightly Decreasing';
const AB_TT_TAG_AGGR_UP = 'Aggressive Increase';
const AB_TT_TAG_AGGR_DOWN = 'Aggressive Decrease';

const AB_TT_OPM_FLAT_PP = 0.5;       // genuinely unchanged
const AB_TT_OPM_SLIGHT_PP = 2.0;     // a nudge worth noting
const AB_TT_OPM_AGGRESSIVE_PP = 5.0; // a step change, not drift

/** Screener cell -> number, tolerating "1,234", "59.11%", "-", "". */
function ab_tt_num_(text) {
  const s = String(text === null || text === undefined ? '' : text)
    .replace(/,/g, '').replace(/%/g, '').replace(/\s/g, '').trim();
  if (s === '' || s === '-') return NaN;
  const n = Number(s);
  return isNaN(n) ? NaN : n;
}

/**
 * Tag for a 2-point series (the OPM columns).
 * Cannot return Volatile - two points define a direction, not a pattern.
 */
function ab_tt_tagPair_(prev, last, noisePp) {
  if (isNaN(prev) || isNaN(last)) return '';
  const delta = last - prev;
  if (Math.abs(delta) <= noisePp) return AB_TT_TAG_STAGNANT;
  return delta > 0 ? AB_TT_TAG_INCREASING : AB_TT_TAG_DECREASING;
}

/**
 * Tag for the two OPM columns - the graded version.
 *
 * Deliberately separate from ab_tt_tagPair_ rather than a flag on it,
 * because that function is also what a 2-point promoter/FII series
 * falls back to, and those must keep the original four tags.
 *
 * Bands are on the ABSOLUTE move in percentage points, then signed at
 * the end, so a rise and a fall of the same size always get the same
 * strength word.
 */
function ab_tt_tagOpmPair_(prev, last) {
  if (isNaN(prev) || isNaN(last)) return '';
  const delta = last - prev;
  const size = Math.abs(delta);
  if (size < AB_TT_OPM_FLAT_PP) return AB_TT_TAG_STAGNANT;
  const up = delta > 0;
  if (size < AB_TT_OPM_SLIGHT_PP) return up ? AB_TT_TAG_SLIGHT_UP : AB_TT_TAG_SLIGHT_DOWN;
  if (size < AB_TT_OPM_AGGRESSIVE_PP) return up ? AB_TT_TAG_INCREASING : AB_TT_TAG_DECREASING;
  return up ? AB_TT_TAG_AGGR_UP : AB_TT_TAG_AGGR_DOWN;
}

/**
 * Tag for a multi-point series (the 4-quarter holding columns).
 *
 *   - MOST RECENT quarter moved aggressively        -> follow that move
 *   - barely moved across the whole window          -> Stagnant
 *   - every meaningful step in one direction        -> Increasing/Decreasing
 *   - moves both ways but still travels efficiently
 *     from start to finish                          -> follow the net move
 *   - moves both ways and doubles back over its
 *     own path                                      -> Volatile
 *
 * The first rule is what lets the rest stay deliberately calm. Ordinary
 * quarter-to-quarter drift gets smoothed away as Stagnant, but a sharp
 * move in the latest quarter is never smoothed - that's the case worth
 * knowing about, so it decides the tag on its own.
 */
function ab_tt_tagSeries_(values, noisePp, aggressivePp) {
  const v = (values || []).filter(function (n) { return !isNaN(n); });
  if (v.length < 2) return '';

  // Recent aggression wins outright.
  const lastStep = v[v.length - 1] - v[v.length - 2];
  if (aggressivePp && Math.abs(lastStep) >= aggressivePp) {
    return lastStep > 0 ? AB_TT_TAG_INCREASING : AB_TT_TAG_DECREASING;
  }

  if (v.length === 2) return ab_tt_tagPair_(v[0], v[1], noisePp);

  let max = v[0], min = v[0];
  v.forEach(function (n) { if (n > max) max = n; if (n < min) min = n; });
  if (max - min <= noisePp) return AB_TT_TAG_STAGNANT;

  const net = v[v.length - 1] - v[0];
  let ups = 0, downs = 0, travel = 0;
  const stepNoise = noisePp / 2; // a single step is judged more finely
  for (let i = 1; i < v.length; i++) {
    const d = v[i] - v[i - 1];
    travel += Math.abs(d);
    if (d > stepNoise) ups++;
    else if (d < -stepNoise) downs++;
  }

  if (ups && !downs) return AB_TT_TAG_INCREASING;
  if (downs && !ups) return AB_TT_TAG_DECREASING;
  if (!ups && !downs) return AB_TT_TAG_STAGNANT;

  // Moved both ways. Did it actually get somewhere, or just thrash?
  // Compare the net displacement against the total ground covered -
  // a series that retraces its own path scores badly here even when
  // its first and last values happen to sit far apart.
  const efficiency = travel ? Math.abs(net) / travel : 0;
  if (efficiency >= AB_TT_EFFICIENCY_MIN && Math.abs(net) > noisePp) {
    return net > 0 ? AB_TT_TAG_INCREASING : AB_TT_TAG_DECREASING;
  }
  return AB_TT_TAG_VOLATILE;
}

/** Grabs <section id="..."> ... </section> from the page. */
function ab_tt_section_(html, id) {
  const re = new RegExp('<section[^>]*id=["\']' + id + '["\'][\\s\\S]*?<\\/section>', 'i');
  const m = String(html || '').match(re);
  return m ? m[0] : '';
}

/** Every <tr> in a chunk of HTML, as arrays of stripped cell text. */
function ab_tt_rows_(chunk) {
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr;
  while ((tr = trRe.exec(chunk)) !== null) {
    const cells = [];
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let td;
    while ((td = tdRe.exec(tr[1])) !== null) cells.push(ab_stripHtml_(td[1]));
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/** Column headings of the first table in a chunk (minus the corner cell). */
function ab_tt_headings_(chunk) {
  const thead = String(chunk).match(/<thead[\s\S]*?<\/thead>/i);
  if (!thead) return [];
  const out = [];
  const thRe = /<th[^>]*>([\s\S]*?)<\/th>/gi;
  let m;
  while ((m = thRe.exec(thead[0])) !== null) out.push(ab_stripHtml_(m[1]));
  out.shift();
  return out;
}

/** Finds a labelled row and returns its numeric cells. */
function ab_tt_rowNums_(chunk, wantedLabel) {
  const want = ab_normHeader_(wantedLabel);
  const rows = ab_tt_rows_(chunk);
  for (let i = 0; i < rows.length; i++) {
    if (ab_normHeader_(rows[i][0]) === want) {
      return rows[i].slice(1).map(ab_tt_num_);
    }
  }
  return null;
}

// Screener uses a different Profit & Loss template for lenders - banks,
// NBFCs, housing finance companies, microfinance institutions, general
// insurers, holding companies and other financial institutions - since
// their core activity is lending/underwriting, not selling something.
// There is no "Operating Profit" line for them; the equivalent row is
// labelled "Financing Profit" / "Financing Margin %" instead, in both
// the quarterly and annual tables. Try the normal label first, then
// this one.
const AB_TT_OPM_ROW_LABELS = ['OPM %', 'Financing Margin %'];

/** Like ab_tt_rowNums_, but tries several possible row labels in turn
 * and returns the first one found (or null if none of them are present). */
function ab_tt_rowNumsAny_(chunk, labels) {
  for (let i = 0; i < labels.length; i++) {
    const nums = ab_tt_rowNums_(chunk, labels[i]);
    if (nums) return nums;
  }
  return null;
}

/**
 * Pulls everything the four tags need out of one screener page.
 *
 * Returns { ok, quarterOpm[], annualOpm[], promoters[], fiis[], error }
 * with every array ordered oldest -> newest, and the annual array
 * already stripped of its TTM column.
 */
function ab_tt_parse_(html) {
  const fail = function (msg) { return { ok: false, error: msg }; };
  if (!html) return fail('empty response');

  // ---- quarterly OPM (or "Financing Margin %" for banks/NBFCs/etc.) ----
  const qSec = ab_tt_section_(html, 'quarters');
  if (!qSec) return fail('no quarterly results section');
  // A missing margin row does NOT fail the whole parse - Promoter/FII
  // data lives in a completely separate section of the page and should
  // still be extracted even when neither margin label can be found
  // (unrecognised label variant, or a genuinely new listing with no
  // results published yet). Downstream, ab_tt_tagsFrom_ already leaves
  // the OPM tags blank for an empty array without touching the others.
  const quarterOpm = ab_tt_rowNumsAny_(qSec, AB_TT_OPM_ROW_LABELS) || [];

  // ---- annual OPM, minus TTM ----
  const pSec = ab_tt_section_(html, 'profit-loss');
  if (!pSec) return fail('no profit & loss section');
  const annualHeads = ab_tt_headings_(pSec);
  let annualOpm = ab_tt_rowNumsAny_(pSec, AB_TT_OPM_ROW_LABELS) || [];
  // Drop any column headed TTM - the spec is "last 2 financial years,
  // not TTM". Compare by position so a shorter row still lines up.
  const keep = [];
  annualOpm.forEach(function (n, i) {
    const head = annualHeads[i] || '';
    if (!/^TTM$/i.test(head.trim())) keep.push(n);
  });
  annualOpm = keep;

  // ---- shareholding, QUARTERLY table only ----
  const shSec = ab_tt_section_(html, 'shareholding');
  if (!shSec) return fail('no shareholding section');
  // The section holds a quarterly table and a yearly table. Slice from
  // the quarterly anchor up to the yearly one so the yearly figures can
  // never be read by mistake.
  let shChunk = shSec;
  const qIdx = shChunk.search(/id=["']quarterly-shareholding["']/i);
  if (qIdx !== -1) {
    shChunk = shChunk.slice(qIdx);
    const yIdx = shChunk.search(/id=["']yearly-shareholding["']/i);
    if (yIdx !== -1) shChunk = shChunk.slice(0, yIdx);
  }
  const promoters = ab_tt_rowNums_(shChunk, 'Promoters');
  const fiis = ab_tt_rowNums_(shChunk, 'FIIs');

  return {
    ok: true,
    quarterOpm: quarterOpm,
    annualOpm: annualOpm,
    promoters: promoters || [],
    fiis: fiis || [],
    error: ''
  };
}

/** Turns parsed figures into the four tags. */
function ab_tt_tagsFrom_(parsed) {
  const lastN = function (arr, n) {
    const clean = (arr || []).filter(function (x) { return !isNaN(x); });
    return clean.slice(Math.max(0, clean.length - n));
  };

  const q = lastN(parsed.quarterOpm, 2);
  const a = lastN(parsed.annualOpm, 2);
  const p = lastN(parsed.promoters, 4);
  const f = lastN(parsed.fiis, 4);

  return {
    opmQoQ: q.length === 2 ? ab_tt_tagOpmPair_(q[0], q[1]) : '',
    opmYoY: a.length === 2 ? ab_tt_tagOpmPair_(a[0], a[1]) : '',
    promoter: ab_tt_tagSeries_(p, AB_TT_HOLDING_NOISE_PP, AB_TT_HOLDING_AGGRESSIVE_PP),
    fii: ab_tt_tagSeries_(f, AB_TT_HOLDING_NOISE_PP, AB_TT_HOLDING_AGGRESSIVE_PP),
    used: { q: q, a: a, p: p, f: f }
  };
}


/** How many usable numbers a parse actually yielded. -1 means it failed. */
function ab_tt_dataScore_(p) {
  if (!p || !p.ok) return -1;
  const n = function (a) {
    return (a || []).filter(function (x) { return !isNaN(x); }).length;
  };
  return n(p.quarterOpm) + n(p.annualOpm) + n(p.promoters) + n(p.fiis);
}


/*****************************************************************
 * QUARTERLY RESULTS + TREND TAGS - COMBINED SINGLE-FETCH ENGINE
 * -----------------------------------------------------------------
 * The Quarterly Results engine (AB_QR_*, just above) and the Trend
 * Tags engine (AB_TT_*, just above that) are deliberately independent
 * of each other - but they both fetch the exact same screener.in page
 * for the exact same symbol. Run them back to back and you've made two
 * HTTP requests for one page's worth of information - twice the time,
 * and twice the chance of tripping a screener block, for nothing extra.
 *
 * This section fetches a symbol's screener.in page ONCE and feeds that
 * single HTML string into BOTH existing parsers untouched -
 * ab_parseScreenerQuarters_ / ab_computeQuarterGrowth_ for Quarterly
 * Results + TTM EPS, and ab_tt_parse_ / ab_tt_tagsFrom_ for the four
 * trend tags. Nothing about how either one reads the page or computes
 * its numbers changes; only the fetch-and-pick-a-page step is shared.
 * A nice side effect: today, an on-demand Quarterly refresh and an
 * on-demand Trend Tags refresh can each independently decide to fall
 * back to the standalone page, so it's possible for the two engines to
 * end up reading DIFFERENT pages for the same symbol. This engine picks
 * one page and reads both halves off it, so that can't happen here.
 *
 * The original Quarterly and Trend Tags menu items are untouched and
 * still work exactly as before, independently - this is an ADDITIONAL
 * option for when you want one single run to fill both sets of columns.
 *****************************************************************/

const AB_QT_BATCH_SIZE = 5;           // just for progress/flush cadence - fetches are sequential
const AB_QT_SEQ_SPACING_MS = 1500;    // gap between sequential requests
const AB_QT_RETRIES = 2;              // per-symbol retries before falling back to standalone
const AB_QT_RETRY_BACKOFF_MS = 1500;
const AB_QT_ABORT_AFTER_FAILS = 6;
const AB_QT_TIME_BUDGET_MS = 4.5 * 60 * 1000; // stop before the 6-min execution cap
const AB_QT_SKIP_RETRY_ON = AB_QR_SKIP_RETRY_ON; // same "hangs rather than fails" list

// Own cooldown/cursor/parking state - independent of AB_QR_* and AB_TT_*,
// for the same reason those two are independent of each other: a block
// tripped while running one engine shouldn't silently gate a different
// one's next run.
const AB_QT_COOLDOWN_PROP = 'AB_QT_COOLDOWN_UNTIL';
const AB_QT_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours
const AB_QT_CURSOR_PROP = 'AB_QT_CURSOR';
const AB_QT_UNFILLABLE_PROP = 'AB_QT_UNFILLABLE';
const AB_QT_SKIP_AFTER = 3;
const AB_QT_TOONEW_PROP = 'AB_QT_TOO_NEW';
const AB_QT_TOONEW_RECHECK_DAYS = 45;

function ab_qt_cooldownRemainingMin_() {
  const paused = ab_screenerPauseMin_(); // manual pause beats everything
  if (paused) return paused;
  const until = Number(PropertiesService.getScriptProperties()
    .getProperty(AB_QT_COOLDOWN_PROP) || 0);
  if (!until || isNaN(until) || Date.now() >= until) return 0;
  return Math.ceil((until - Date.now()) / 60000);
}

function ab_qt_getUnfillable_() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(AB_QT_UNFILLABLE_PROP);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}
function ab_qt_saveUnfillable_(map) {
  try {
    PropertiesService.getScriptProperties().setProperty(AB_QT_UNFILLABLE_PROP, JSON.stringify(map));
  } catch (e) {
    Logger.log('Could not save the combined-engine unfillable list: ' + e.message);
  }
}
function ab_qt_getTooNew_() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(AB_QT_TOONEW_PROP);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}
function ab_qt_saveTooNew_(map) {
  try {
    PropertiesService.getScriptProperties().setProperty(AB_QT_TOONEW_PROP, JSON.stringify(map));
  } catch (e) {
    Logger.log('Could not save the combined-engine recently-listed list: ' + e.message);
  }
}
function ab_qt_isParkedTooNew_(map, sym) {
  const due = Number(map[sym] || 0);
  return due > 0 && Date.now() < due;
}

/**
 * True for errors that mean "neither engine has anything to give for
 * this symbol", as opposed to "screener is busy right now" - the same
 * idea as ab_qrIsDefinitiveError_, widened to also recognise the Trend
 * Tags engine's section-not-found errors.
 */
function ab_qt_isDefinitiveError_(err) {
  const e = String(err || '');
  if (AB_QT_SKIP_RETRY_ON.test(e)) return false;   // transport - try again later
  if (/HTTP 429|HTTP 5\d\d/.test(e)) return false;  // rate limited / server side
  return /no quarter columns|no quarterly data|404|no Sales\/Revenue row|no Net Profit row|no quarterly results section|no profit & loss section|no shareholding section/i
    .test(e);
}

/** Column lookup identical in spirit to the one inside
 *  ab_tt_updateTrendTags_ - exact match, then normalised fallback. */
function ab_qt_findCol_(header, name) {
  let idx = header.indexOf(name);
  if (idx !== -1) return idx;
  const want = ab_normHeader_(name);
  for (let i = 0; i < header.length; i++) {
    if (ab_normHeader_(header[i]) === want) return i;
  }
  return -1;
}

/**
 * Runs BOTH existing parsers against one page of HTML and normalises
 * the result into one shape. Each half succeeds or fails on its own -
 * a page can easily have a full quarterly table but no shareholding
 * section (or vice versa), and that's not a reason to throw away the
 * half that worked.
 *
 * `score` is only used to choose between the consolidated and
 * standalone page when a fallback fetch happens - see ab_qt_fetchOne_.
 * `quarterOpmCount` mirrors the same "is this page worth stopping at"
 * check the Trend Tags engine already uses on its own.
 */
function ab_qt_parseBoth_(html) {
  const qParsed = ab_parseScreenerQuarters_(html);
  const growth = qParsed.ok ? ab_computeQuarterGrowth_(qParsed) : null;

  const tParsed = ab_tt_parse_(html);
  const tags = tParsed.ok ? ab_tt_tagsFrom_(tParsed) : null;

  const quarterOpmCount = tParsed.ok
    ? tParsed.quarterOpm.filter(function (x) { return !isNaN(x); }).length
    : 0;
  const score = (qParsed.ok ? 1 : 0) + Math.max(0, ab_tt_dataScore_(tParsed));

  return {
    quarterOk: qParsed.ok, growth: growth, quarterError: qParsed.ok ? '' : qParsed.error,
    tagsOk: tParsed.ok, tags: tags, tagsError: tParsed.ok ? '' : tParsed.error,
    quarterOpmCount: quarterOpmCount, score: score
  };
}

/*****************************************************************
 * PC BRIDGE - screener.in pages fetched by YOUR computer
 * -----------------------------------------------------------------
 * screener.in refuses requests that come from Google's servers
 * ("Address unavailable"), so this script can't read it directly.
 * Your own PC isn't blocked. A small Python program on the PC
 * (screener_bridge.py, run by Windows Task Scheduler) does this:
 *
 *   1. asks this sheet which symbols still need screener data
 *      (results due / pending, plus never-attempted rows);
 *   2. opens those screener pages from your home internet;
 *   3. posts the page text back to this sheet (a web app below);
 *   4. tells the sheet to process it.
 *
 * "Process" = the SAME Results Day check and "Fill never-attempted
 * rows" engines as always, with one difference: instead of fetching
 * from screener they read what the PC delivered (tab Screener_Bridge,
 * hidden). Every rule - quarter check, Checkbox tick, trend tags,
 * emails - is untouched.
 *
 * The web app is protected by a secret code (menu: 3. Quarterly
 * Results & Trend Tags > PC Bridge: setup info). Nothing is returned
 * without it.
 *****************************************************************/
const AB_BRIDGE_SHEET = 'Screener_Bridge';
const AB_BRIDGE_TOKEN_PROP = 'AB_BRIDGE_TOKEN';
// Data newer than this is used instead of a live fetch.
const AB_BRIDGE_FRESH_MS = 6 * 60 * 60 * 1000;
// If a live fetch fails (it will, while Google is blocked), data up to
// this old is still better than nothing.
const AB_BRIDGE_STALE_OK_MS = 14 * 24 * 60 * 60 * 1000;
const AB_BRIDGE_HEADER = ['Symbol', 'Fetched (ms)', 'Fetched at (IST)', 'Data (JSON)'];
// True only while the web app is processing PC data: engines then read
// the bridge tab and NEVER try a live fetch.
let AB_BRIDGE_ONLY = false;
// Set by ab_qt_fetchOne_: the last answer came from the bridge (so no
// politeness sleep is needed before the next one).
let AB_BRIDGE_LAST_HIT = false;
let AB_BRIDGE_CACHE_ = null;

function ab_bridgeSheet_(create) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(AB_BRIDGE_SHEET);
  if (!sh && create) {
    sh = ss.insertSheet(AB_BRIDGE_SHEET);
    sh.getRange(1, 1, 1, AB_BRIDGE_HEADER.length).setValues([AB_BRIDGE_HEADER]).setFontWeight('bold');
    sh.setColumnWidth(4, 300);
    sh.setFrozenRows(1);
    try { sh.hideSheet(); } catch (e) { /* cosmetic */ }
  }
  return sh;
}

/** symbol -> { at: ms, combined: parse result, row: sheet row }. Cached per run. */
function ab_bridgeLoad_() {
  if (AB_BRIDGE_CACHE_) return AB_BRIDGE_CACHE_;
  const map = {};
  const sh = ab_bridgeSheet_(false);
  if (sh && sh.getLastRow() > 1) {
    const vals = sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues();
    for (let i = 0; i < vals.length; i++) {
      const sym = String(vals[i][0] || '').trim().toUpperCase();
      if (!sym) continue;
      let combined = null;
      try { combined = JSON.parse(String(vals[i][3] || '')); } catch (e) { combined = null; }
      if (!combined) continue;
      map[sym] = { at: Number(vals[i][1]) || 0, combined: combined, row: i + 2 };
    }
  }
  AB_BRIDGE_CACHE_ = map;
  return map;
}

function ab_bridgeGet_(sym) {
  return ab_bridgeLoad_()[String(sym || '').trim().toUpperCase()] || null;
}

/** The bridge entry as an ab_qt_parseBoth_-shaped result. */
function ab_bridgeResult_(b) {
  const c = JSON.parse(JSON.stringify(b.combined));
  c.fromBridge = true;
  return c;
}

/** Writes (or overwrites) entries: [{ sym, combined }]. */
function ab_bridgePutMany_(entries) {
  if (!entries.length) return;
  const sh = ab_bridgeSheet_(true);
  const map = ab_bridgeLoad_();
  const now = Date.now();
  const stamp = Utilities.formatDate(new Date(now), AB_TZ, 'dd-MMM-yyyy HH:mm');
  const adds = [];
  entries.forEach(function (en) {
    const sym = String(en.sym).trim().toUpperCase();
    const row = [sym, now, stamp, JSON.stringify(en.combined)];
    const cur = map[sym];
    if (cur) {
      sh.getRange(cur.row, 1, 1, 4).setValues([row]);
      cur.at = now; cur.combined = en.combined;
    } else {
      adds.push(row);
      map[sym] = { at: now, combined: en.combined, row: -1 };
    }
  });
  if (adds.length) {
    const start = sh.getLastRow() + 1;
    sh.getRange(start, 1, adds.length, 4).setValues(adds);
    adds.forEach(function (row, i) { map[row[0]].row = start + i; });
  }
  SpreadsheetApp.flush();
}

/** Same choice ab_qt_fetchOne_ makes between consolidated and standalone. */
function ab_bridgePick_(cons, plain) {
  const thin = !cons.quarterOk || cons.quarterOpmCount < 2;
  if (!thin || !plain) return cons;
  return plain.score >= cons.score ? plain : cons;
}

/** Pause between requests - skipped when the last answer came from the bridge. */
function ab_qtPause_(ms) {
  if (!AB_BRIDGE_LAST_HIT) Utilities.sleep(ms);
}

function ab_bridgeToken_(create) {
  const props = PropertiesService.getScriptProperties();
  let t = props.getProperty(AB_BRIDGE_TOKEN_PROP) || '';
  if (!t && create) {
    t = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
    props.setProperty(AB_BRIDGE_TOKEN_PROP, t);
  }
  return t;
}

/**
 * Symbols the PC should fetch, most urgent first:
 *   priority - result date is today / within the wait window and the
 *              Results Day tracker still has it Pending (or not yet seen);
 *   missing  - never-attempted rows (all ten target columns blank),
 *              skipping the ones already parked/unfillable.
 */
function ab_bridgeWanted_() {
  const layout = ab_getMainLayout_();
  const cols = {
    promoter: ab_qt_findCol_(layout.header, AB_TT_PROMOTER_HEADER),
    fii: ab_qt_findCol_(layout.header, AB_TT_FII_HEADER),
    opmYoY: ab_qt_findCol_(layout.header, AB_TT_OPM_YOY_HEADER),
    opmQoQ: ab_qt_findCol_(layout.header, AB_TT_OPM_QOQ_HEADER)
  };
  const targetCols = [layout.qoqRev, layout.qoqNp, layout.yoyRev, layout.yoyNp,
                      layout.ttmEps, layout.lastFyEps,
                      cols.promoter, cols.fii, cols.opmYoY, cols.opmQoQ];
  const todayKey = ab_rsDayKey_(new Date());
  const tr = ab_rsReadTracker_();
  const unfillable = ab_qt_getUnfillable_();
  const tooNew = ab_qt_getTooNew_();
  const data = layout.data;
  const priority = [], missing = [], seen = {};

  for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
    const sym = ab_cellText_(data[r][layout.symbol]).toUpperCase();
    const name = ab_cellText_(data[r][layout.name]);
    if (!sym && !name) break;
    if (!sym || seen[sym]) continue;

    if (layout.resultDate !== -1) {
      const rd = ab_rsToDate_(data[r][layout.resultDate]);
      if (rd) {
        const age = ab_rsDaysBetween_(ab_rsDayKey_(rd), todayKey);
        if (age >= 0 && age <= AB_RS_MAX_WAIT_DAYS) {
          const t = tr.byKey[sym + '|' + ab_rsExpectedQuarter_(rd).toUpperCase()];
          if (!t || t.status === 'Pending') { priority.push(sym); seen[sym] = true; continue; }
        }
      }
    }

    let everWritten = false;
    for (let k = 0; k < targetCols.length; k++) {
      if (targetCols[k] !== -1 && ab_cellText_(data[r][targetCols[k]]) !== '') { everWritten = true; break; }
    }
    if (everWritten) continue;
    if ((unfillable[sym] || 0) >= AB_QT_SKIP_AFTER) continue;
    if (ab_qt_isParkedTooNew_(tooNew, sym)) continue;
    missing.push(sym); seen[sym] = true;
  }
  return { priority: priority, missing: missing };
}

/** Runs the two normal engines on whatever the PC delivered - no live fetches. */
function ab_bridgeProcess_() {
  const out = { results: '', missing: '', errors: [] };
  AB_BRIDGE_ONLY = true;
  try {
    try {
      const r = ab_rsRun_('Retry (PC bridge)', false);
      out.results = !r ? 'done' : r.skipped ? 'skipped (another run is going)' :
        r.continued ? ('checked ' + r.checked + ', ' + r.remaining + ' to go') :
        (r.summary && r.summary.text ? r.summary.text : 'done');
    } catch (e) { out.errors.push('Results Day: ' + e.message); }
    try {
      const s = ab_qt_updateQuarterlyAndTrendTags_('missing');
      out.missing = 'checked ' + s.requested + ', filled ' + s.updated + ', failed ' + s.failed;
    } catch (e) { out.errors.push('Never-attempted rows: ' + e.message); }
  } finally {
    AB_BRIDGE_ONLY = false;
  }
  return out;
}

function ab_bridgeJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Opening the web app URL in a browser just says it is alive. No data, no token. */
function doGet(e) {
  return ab_bridgeJson_({ ok: true, message: 'Auto Bhavcopy PC bridge is running. Use screener_bridge.py on your PC.' });
}

/** The PC program talks here. Body = JSON { token, action, ... }. */
function doPost(e) {
  let req = null;
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { req = null; }
  // Website feed: read-only, its own token (never the bridge token, which can write).
  if (req && req.action === 'snapshot') return ab_feedSnapshot_(req);
  if (req && req.action === 'site') return ab_feedSite_(req);
  const real = ab_bridgeToken_(false);
  if (!req || !real || req.token !== real) return ab_bridgeJson_({ ok: false, error: 'bad token' });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(120000)) return ab_bridgeJson_({ ok: false, error: 'sheet busy - try again' });
  try {
    if (req.action === 'list') {
      const w = ab_bridgeWanted_();
      return ab_bridgeJson_({ ok: true, priority: w.priority, missing: w.missing });
    }
    if (req.action === 'put') {
      const entries = [], details = [];
      (req.items || []).forEach(function (it) {
        const sym = String(it.sym || '').trim().toUpperCase();
        if (!sym) return;
        let combined;
        if (it.status === 404) {
          const msg = 'not on screener (404)';
          combined = { quarterOk: false, growth: null, quarterError: msg, tagsOk: false, tags: null,
                       tagsError: msg, quarterOpmCount: 0, score: -1 };
        } else if (it.html2) {
          const cur = ab_bridgeGet_(sym);
          const plain = ab_qt_parseBoth_(String(it.html2));
          combined = cur ? ab_bridgePick_(cur.combined, plain) : plain;
        } else {
          combined = ab_qt_parseBoth_(String(it.html || ''));
        }
        entries.push({ sym: sym, combined: combined });
        details.push({ sym: sym, quarterOk: !!combined.quarterOk, tagsOk: !!combined.tagsOk,
                       thin: !combined.quarterOk || combined.quarterOpmCount < 2,
                       latest: combined.growth ? combined.growth.latestQuarter : '',
                       error: combined.quarterError || combined.tagsError || '' });
      });
      ab_bridgePutMany_(entries);
      return ab_bridgeJson_({ ok: true, stored: entries.length, details: details });
    }
    if (req.action === 'process') {
      return ab_bridgeJson_({ ok: true, result: ab_bridgeProcess_() });
    }
    if (req.action === 'pricebands') {
      return ab_bridgeJson_(ab_pbFromBridge_(req));
    }
    return ab_bridgeJson_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return ab_bridgeJson_({ ok: false, error: err.message });
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------
// WEBSITE FEED (read-only). The dashboard's server (Vercel api/, env
// SHEET_FEED_URL + SHEET_FEED_TOKEN) posts {token, action:'snapshot'} and
// gets Main's symbol / MKT Price / % Change (only the header rows and
// those 3 columns are read). Prices are GOOGLEFINANCE, so the site labels
// them DELAYED (~20 min). Separate token from the PC bridge: this one can
// never change the owner's data - it reads the sheet and keeps only the
// website's own stored copy (hidden tab Site_Feed, action 'site') and that
// copy's 30-minute refresh trigger.
// ---------------------------------------------------------------------
const AB_FEED_TOKEN_PROP = 'AB_FEED_TOKEN';

function ab_feedToken_(create) {
  const props = PropertiesService.getScriptProperties();
  let t = props.getProperty(AB_FEED_TOKEN_PROP) || '';
  if (!t && create) {
    t = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
    props.setProperty(AB_FEED_TOKEN_PROP, t);
  }
  return t;
}

// Main SYMBOL cells that look like an NSE ticker (notes / labels below the
// list never reach the website's price feed).
const AB_FEED_TICKER_RE = /^[A-Z0-9][A-Z0-9&._-]{0,19}$/;

function ab_feedSnapshot_(req) {
  const real = ab_feedToken_(false);
  if (!real || req.token !== real) return ab_bridgeJson_({ ok: false, error: 'bad token' });
  try {
    const layout = ab_feedPriceLayout_();
    const rows = [];
    for (let r = layout.headerRowIdx + 1; r < layout.data.length; r++) {
      const row = layout.data[r];
      const sym = String(row[layout.symbol] || '').trim().toUpperCase();
      if (!sym) continue;                     // blank rows inside the range are skipped, not a stop
      if (sym === 'SYMBOL') break;            // a repeated header row: another table starts below
      if (!AB_FEED_TICKER_RE.test(sym)) continue;
      const num = function (v) { return (v === '' || v === null || v === undefined) ? NaN : Number(v); };
      const price = num(row[layout.mktPrice]);
      const chg = layout.pctChange === -1 ? NaN : num(row[layout.pctChange]);
      rows.push([sym, isFinite(price) && price > 0 ? price : null, isFinite(chg) ? chg : null]);
    }
    const now = Utilities.formatDate(new Date(), AB_TZ, 'yyyy-MM-dd HH:mm');
    return ab_bridgeJson_({
      ok: true,
      asOf: now,
      readAt: now,
      delayMinutes: 20,
      source: 'GOOGLEFINANCE via Stock Blueprint sheet',
      cols: ['sym', 'price', 'chg'],
      rows: rows
    });
  } catch (err) {
    return ab_bridgeJson_({ ok: false, error: err.message });
  }
}

/**
 * Just what the price snapshot needs from Main: the header row (found in
 * the first 10 rows by the same rules as ab_getMainLayout_) and the
 * SYMBOL / MKT Price / % Change cells of the rows below it. Reading the
 * whole tab (~1,800 rows x 64 formula columns) made every call slow.
 * Returns the ab_getMainLayout_ fields the snapshot uses, with the same
 * errors; data[r] holds only those three cells of row r.
 */
function ab_feedPriceLayout_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AB_MAIN_SHEET);
  if (!sh) throw new Error('Could not find a "' + AB_MAIN_SHEET + '" tab.');
  // the same rows / columns getDataRange() covers
  const lastRow = Math.max(sh.getLastRow(), 1), lastCol = Math.max(sh.getLastColumn(), 1);
  const head = sh.getRange(1, 1, Math.min(10, lastRow), lastCol).getValues();
  let headerRowIdx = -1;
  for (let r = 0; r < head.length; r++) {
    const row = head[r].map(v => String(v).trim());
    if (row.indexOf('StockName') !== -1 && row.indexOf('SYMBOL') !== -1) {
      headerRowIdx = r;
      break;
    }
  }
  if (headerRowIdx === -1) throw new Error('Could not find the StockName/SYMBOL header row in Main.');
  const header = head[headerRowIdx].map(v => String(v).trim());
  function col(name) { return header.indexOf(name); }
  // ab_getMainLayout_ refuses a Main without its alert columns - so does this
  const missing = ['Price Fall Alert Price', 'Breakout Alert Price', 'Triggered Y/N'].filter(function (h) { return col(h) === -1; });
  if (missing.length) throw new Error('Main is missing expected alert column(s): ' + missing.join(', '));

  const layout = { headerRowIdx: headerRowIdx, symbol: col('SYMBOL'), mktPrice: col('MKT Price'), pctChange: col('% Change'), data: [] };
  for (let r = 0; r < lastRow; r++) layout.data.push([]);
  const n = lastRow - headerRowIdx - 1;
  if (n < 1) return layout;
  // one read per run of side-by-side columns (MKT Price and % Change usually are)
  const want = [layout.symbol, layout.mktPrice, layout.pctChange]
    .filter(function (c, i, a) { return c !== -1 && a.indexOf(c) === i; })
    .sort(function (a, b) { return a - b; });
  for (let i = 0; i < want.length;) {
    let j = i;
    while (j + 1 < want.length && want[j + 1] === want[j] + 1) j++;
    const vals = sh.getRange(headerRowIdx + 2, want[i] + 1, n, j - i + 1).getValues();
    for (let r = 0; r < n; r++) {
      for (let k = i; k <= j; k++) layout.data[headerRowIdx + 1 + r][want[k]] = vals[r][k - i];
    }
    i = j + 1;
  }
  return layout;
}

// ---------------------------------------------------------------------
// WEBSITE SITE FEED (same token as 'snapshot'; never changes the owner's
// data, writes only its stored copy - see STORED COPY below). The website's
// server (Vercel api/site) posts {token, action:'site', part} and gets
//   part 'main'    -> the object tools/export_xlsx.py export() writes as
//                     window.SB_DATA (web/data/dashboard.js)
//   part 'history' -> what export_history() writes as window.SB_HISTORY
//                     (web/data/history.js)
// so the site shows the sheet's CURRENT data without a manual export.
// The Python exporter is the reference: same tabs, keys and value
// conversions, and the same privacy allow-list (the site is public).
// Portfolio, Risk Manager, Control Panel, Trade Log, Trade Dashboard,
// 'Entry' alerts and the entry / stop / qty columns are never sent; Trade
// Log, Portfolio and Risk Manager are read ONLY for their symbol column,
// to leave those symbols' alerts out. No lock (it writes only its own
// stored copy, see STORED COPY below), so it can't hold up the PC bridge
// or the alert job.
// Check against a downloaded copy: node tools/compare_site_feed.js <file.xlsx>
// ---------------------------------------------------------------------
const AB_SITE_SOURCE = 'Google Sheet (live feed)';
const AB_SITE_ERRORS = ['#N/A', '#DIV/0!', '#REF!', '#VALUE!', '#ERROR!', '#NAME?', '#NUM!', '#NULL!', 'Loading...'];

// Main tab: [output key, header name in row 2, kind]
//   kind: str | num | pct (already a percent number) | frac (fraction -> x100) | date | bool
const AB_SITE_MAIN_COLS = [
  ['sym', 'SYMBOL', 'str'], ['name', 'StockName', 'str'], ['sector', 'Sector', 'str'],
  ['industry', 'Industry', 'str'], ['ind', 'Basic Industry', 'str'], ['idx', 'INDICES', 'str'],
  ['rdate', 'Result Date', 'date'], ['done', 'Checkbox', 'bool'], ['mcap', 'MCAP(CR)', 'num'],
  ['price', 'MKT Price', 'num'], ['chg', '% Change', 'pct'], ['d10', '10 day%', 'frac'],
  ['d30', '30Day%', 'frac'], ['hi52', '52W High', 'num'], ['down52', '% down', 'frac'],
  ['pe', 'PE Ratio', 'num'], ['ipe', 'Industry PE', 'num'], ['pevs', 'PE vs Industry PE', 'num'],
  ['ttmEps', 'TTM EPS', 'num'], ['lfyEps', 'Last FY EPS', 'num'], ['epsg', 'TTM EPS Growth', 'num'],
  ['peg', 'TTM PEG Ratio', 'num'], ['tgt', 'TargetPrice', 'num'], ['sig', 'TTM Signal', 'str'],
  ['up', 'Upside Potential', 'frac'], ['sig2', 'Signal', 'str'],
  ['qrev', 'QoQ[Revenue Growth%}', 'pct'], ['qnp', 'QoQ[NP Growth %]', 'pct'],
  ['yrev', 'YoY[Revenue Growth %]', 'pct'], ['ynp', 'YoY[NP Growth %]', 'pct'],
  ['promo', 'Promotor Holding', 'str'], ['fii', 'FII Activity', 'str'], ['opmy', 'OPM YoY%', 'str'],
  ['opmq', 'OPM QoQ%', 'str'], ['pat', 'Pattern', 'str'], ['fvg', 'FVG', 'str'],
  ['e10', '10 EMA', 'str'], ['e21', '21 EMA', 'str'], ['zone', 'Zone', 'str'],
  ['volchg', '%vol Change', 'frac'], ['ipo', 'IPO Level', 'str']
];

// Alert Log columns that may be published (no personal position data)
const AB_SITE_ALERT_COLS = ['Date', 'Symbol', 'Company', 'Alert Type', 'Alert Level', 'Trigger Price',
  'Pattern @ Alert', 'FVG Tags @ Alert', 'Current Price', '% Since Alert', 'Days Since', 'Outcome'];
const AB_SITE_PUBLIC_ALERT_TYPES = ['Breakout', 'Price Fall'];

// Python strptime formats of text_date(), in its order (%d %m %H %M take 1-2
// digits, %b a 3-letter month in any letter case).
const AB_SITE_TEXT_DATES = (function () {
  const d = '(3[01]|[12]\\d|0[1-9]|[1-9]| [1-9])', m = '(1[0-2]|0[1-9]|[1-9])';
  const b = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)', t = '\\s+(2[0-3]|[01]\\d|\\d):([0-5]\\d|\\d)';
  const f = function (src, month, year, time) { return { re: new RegExp('^' + src + '$', 'i'), month: month, year: year, time: time }; };
  return [
    f(d + '-' + b + '-(\\d{4})' + t, 'b', 'Y', true),
    f(d + '-' + b + '-(\\d{4})', 'b', 'Y', false),
    f(d + '-' + b + '-(\\d{2})', 'b', 'y', false),
    f(d + '/' + m + '/(\\d{4})' + t, 'm', 'Y', true),
    f(d + '/' + m + '/(\\d{4})', 'm', 'Y', false)
  ];
})();
const AB_SITE_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * doPost action 'site'. Answers from the STORED copy (hidden tab Site_Feed,
 * kept fresh by ab_siteFeedTrigger_ - see "WEBSITE SITE FEED - STORED
 * COPY" below) without reading Main / History30: building the feed takes
 * 30+ s, longer than the website's server waits. Only when no stored copy
 * exists yet is the part built on demand (slow once; it is stored too).
 */
function ab_feedSite_(req) {
  const real = ab_feedToken_(false);
  if (!real || req.token !== real) return ab_bridgeJson_({ ok: false, error: 'bad token' });
  const part = req.part;
  if (part !== 'main' && part !== 'history') return ab_bridgeJson_({ ok: false, error: 'unknown part' });
  try { ab_siteFeedTriggerCheck_(); } catch (e) { /* never break the answer over the trigger */ }
  try {
    const stored = ab_siteFeedRead_(part);
    if (stored) return ab_siteFeedReply_(part, stored.meta, stored.text, true);
    if (ab_siteBuildRunning_()) return ab_bridgeJson_({ ok: false, error: AB_SITE_PREPARING });
    const got = {};
    const sum = ab_siteBuild_([part], 'request', { out: got })[part];
    if (got[part]) return ab_siteFeedReply_(part, got[part], got[part].text, false);
    return ab_bridgeJson_({ ok: false, error: sum.busy ? AB_SITE_PREPARING : sum.error });
  } catch (err) {
    return ab_bridgeJson_({ ok: false, error: err.message });
  }
}

/** Part 'main' = export_xlsx.py export() (window.SB_DATA). */
function ab_site_main_(cx, readAt) {
  const data = { generated: readAt, source: AB_SITE_SOURCE };

  // Main: headers on row 2, data from row 3; blank rows are skipped
  const mainTab = ab_site_tab_(cx, AB_MAIN_SHEET);
  if (!mainTab) throw new Error('Could not find a "' + AB_MAIN_SHEET + '" tab.');
  const m = mainTab.values;
  const hdr = (m[1] || []).map(function (h) { return ab_site_norm_(cx, h); });
  const idx = [];                               // [key, column, kind]
  AB_SITE_MAIN_COLS.forEach(function (c) {
    const j = hdr.indexOf(ab_site_norm_(cx, c[1]));
    if (j !== -1) idx.push([c[0], j, c[2]]);
  });
  const symI = hdr.indexOf('symbol');
  if (symI === -1) throw new Error('Main has no SYMBOL column on row 2.');
  const stocks = [];
  for (let r = 2; r < m.length; r++) {
    if (ab_site_isBlank_(m[r][symI])) continue;
    stocks.push(idx.map(function (c) { return ab_site_clean_(cx, m[r][c[1]], c[2]); }));
  }
  data.main = { cols: idx.map(function (c) { return c[0]; }), rows: stocks };
  const priv = ab_site_privateSymbols_(cx, m, hdr, symI);

  // Results season
  data.resultsTracker = ab_site_table_(cx, ab_site_tab_(cx, 'Results Tracker'), 'Symbol', { stopBlank: false });
  const perf = ab_site_resultsPerf_(cx, ab_site_tab_(cx, 'Results Performance'));
  data.resultsPerf = perf;
  // "as of" = when the sheet last refreshed (from the Results Performance note)
  const asOf = ab_site_asOf_(perf.note);
  if (asOf) data.asOf = asOf;

  // Signals
  data.patterns = ab_site_patterns_(cx, ab_site_tab_(cx, 'Pattern Dashboard'));
  data.fvg = ab_site_table_(cx, ab_site_tab_(cx, 'UnmitigatedFVG'), 'Symbol', { stopBlank: false });
  data.gapup = ab_site_table_(cx, ab_site_tab_(cx, 'GapUpFVG'), 'Symbol', { stopBlank: false });
  data.watchLog = ab_site_table_(cx, ab_site_tab_(cx, 'Signal Watchlist Log'), 'Date Flagged', { stopBlank: false });
  const bt = ab_site_tab_(cx, 'FVG Backtest');
  if (bt) data.fvgBacktest = ab_site_table_(cx, bt, 'Flagged On', { stopBlank: false });
  const ml = ab_site_tab_(cx, 'Mitigated FVG Log');
  if (ml) data.mitigatedLog = ab_site_table_(cx, ml, 'Date', { stopBlank: false });

  // Alerts: watch-level alerts only (see ab_site_alerts_)
  data.alerts = ab_site_alerts_(cx, ab_site_tab_(cx, 'Alert Log'), priv);

  // Markets
  data.indices = ab_site_indices_(cx, ab_site_tab_(cx, 'Indextracker'));
  data.ipos = ab_site_table_(cx, ab_site_tab_(cx, 'IPOs'), 'NSE SYMBOL', { stopBlank: false });
  data.newIpos = ab_site_table_(cx, ab_site_tab_(cx, 'New IPOs'), 'COMPANY NAME', { stopBlank: false, maxRows: 300 });
  data.priceBands = ab_site_table_(cx, ab_site_tab_(cx, 'Price Band Changes'), 'Report Date', { stopBlank: false });
  return data;
}

/**
 * Symbols that are (or were) the user's own trades: any Main row with an
 * Entry Price or Stoploss typed in, every Trade Log symbol (col B), and the
 * Portfolio / Risk Manager 'Symbol' blocks (col A). Their alert rows are
 * never published, because alert levels and outcomes reveal the position.
 * Only those symbol cells are read from the personal tabs.
 */
function ab_site_privateSymbols_(cx, m, hdr, symI) {
  const priv = {};
  ['entry price', 'stoploss'].forEach(function (name) {
    const ci = hdr.indexOf(name);
    if (ci === -1) return;
    for (let r = 2; r < m.length; r++) {
      const v = m[r][ci];
      if (m[r][symI] && !ab_site_isBlank_(v) && ab_site_clean_(cx, v, 'num')) {
        priv[ab_site_pyStr_(cx, m[r][symI]).trim().toUpperCase()] = true;
      }
    }
  });
  ab_site_column_(cx, 'Trade Log', 2).slice(1).forEach(function (v) {
    if (v) priv[ab_site_pyStr_(cx, v).trim().toUpperCase()] = true;
  });
  ['Portfolio', 'Risk Manager'].forEach(function (name) {
    const col = ab_site_column_(cx, name, 1);
    let from = -1;
    for (let i = 0; i < col.length && from === -1; i++) if (ab_site_norm_(cx, col[i]) === 'symbol') from = i + 1;
    if (from === -1) return;
    for (let i = from; i < col.length; i++) {
      const v = col[i];
      if (typeof v === 'string' && /^[A-Z0-9&_-]{1,20}$/.test(v.trim().toUpperCase())) priv[v.trim().toUpperCase()] = true;
    }
  });
  return priv;
}

/** Results Performance: A2 note, the season / verdict block, the stock table. */
function ab_site_resultsPerf_(cx, tab) {
  const rp = tab ? tab.values : [];
  const C = function (v, kind) { return ab_site_clean_(cx, v, kind); };
  const perf = { note: rp.length > 1 ? C(rp[1][0]) : null, seasons: [], verdicts: [], lines: [] };
  for (let i = 0; i < rp.length; i++) {
    if (ab_site_norm_(cx, rp[i][0]) !== 'season') continue;
    for (let j = i + 1; j < rp.length && ab_site_norm_(cx, rp[j][0]) !== 'symbol'; j++) {
      const r = rp[j];
      if (!ab_site_isBlank_(r[0]) && r.length > 5 && !ab_site_isBlank_(r[1]) &&
          !/^(Best|Worst)/.test(ab_site_pyStr_(cx, r[0]))) {
        perf.seasons.push({ season: C(r[0]), tracked: C(r[1], 'num'), avg: C(r[2], 'frac'),
                            median: C(r[3], 'frac'), above: C(r[4]), soldOff: C(r[5], 'num') });
      } else if (r[0]) {
        perf.lines.push(C(r[0]));
      }
      if (r.length > 11 && !ab_site_isBlank_(r[7])) {
        perf.verdicts.push({ verdict: C(r[7]), stocks: C(r[8], 'num'), avg: C(r[9], 'frac'),
                             positive: C(r[10], 'frac'), day: C(r[11], 'frac') });
      }
    }
    break;
  }
  perf.table = ab_site_table_(cx, tab, 'Symbol');
  return perf;
}

/** 'last refreshed dd/MM/yyyy HH:mm' in the Results Performance note -> ISO text. */
function ab_site_asOf_(note) {
  const mt = /last refreshed (\d{2}\/\d{2}\/\d{4} \d{2}:\d{2})/.exec(note === null || note === undefined ? '' : String(note));
  return mt ? ab_site_textDate_(mt[1]) : null;
}

/** Pattern Dashboard: refresh time, KPI row, signals / clusters / stocks tables. */
function ab_site_patterns_(cx, tab) {
  const pd = tab ? tab.values : [];
  const top = [];
  pd.slice(0, 3).forEach(function (r) { r.forEach(function (c) { if (c) top.push(ab_site_pyStr_(cx, c)); }); });
  const mt = /refreshed (\d{2}\/\d{2}\/\d{4} \d{2}:\d{2})/.exec(top.join(' '));
  const kp = {};
  for (let i = 0; i < pd.length; i++) {
    if (ab_site_norm_(cx, pd[i][0]) !== 'stocks scanned') continue;
    const next = pd[i + 1] || [];
    for (let j = 0; j < Math.min(pd[i].length, next.length); j++) {
      if (pd[i][j]) kp[ab_site_pyStr_(cx, pd[i][j])] = ab_site_clean_(cx, next[j]);
    }
    break;
  }
  return {
    asOf: mt ? ab_site_textDate_(mt[1]) : null,
    kpis: kp,
    signals: ab_site_table_(cx, tab, 'Type', { kinds: { 'Avg % Change': 'frac', '% Advancing': 'frac', 'Avg 10-day %': 'frac', 'Avg 30-day %': 'frac' } }),
    clusters: ab_site_table_(cx, tab, 'Basic Industry', { kinds: { 'Avg % Change': 'frac' } }),
    stocks: ab_site_table_(cx, tab, 'Symbol', { kinds: { '% Change': 'frac', '10-day %': 'frac', '30-day %': 'frac' } })
  };
}

/**
 * Alert Log: watch-level alerts only. 'Entry' alerts are the user's real
 * positions (alert level = their entry price) and private symbols are left
 * out; only the AB_SITE_ALERT_COLS columns are sent.
 */
function ab_site_alerts_(cx, tab, priv) {
  const al = ab_site_table_(cx, tab, 'Date', { stopBlank: false });
  const keep = al.cols.filter(function (c) { return AB_SITE_ALERT_COLS.indexOf(c) !== -1; });
  const ti = al.cols.indexOf('Alert Type'), si = al.cols.indexOf('Symbol');
  const rows = al.rows.filter(function (r) {
    if (ti === -1 || si === -1 || AB_SITE_PUBLIC_ALERT_TYPES.indexOf(r[ti]) === -1) return false;
    const sym = r[si] === null || r[si] === undefined ? '' : String(r[si]).trim().toUpperCase();
    return !priv[sym];
  });
  return {
    cols: keep,
    rows: rows.map(function (r) { return keep.map(function (c) { return r[al.cols.indexOf(c)]; }); }),
    note: 'watch alerts only; symbols with your own entry/stop-loss or a Trade Log row are left out'
  };
}

/** Indextracker: drop label rows (no numbers) and the repeated block. */
function ab_site_indices_(cx, tab) {
  const ix = ab_site_table_(cx, tab, 'NSE Symbol', { stopBlank: false });
  const seen = {}, rows = [];
  ix.rows.forEach(function (r) {
    const key = typeof r[0] === 'string' ? 's' + r[0] : r[0] === null ? 'null' : 'n' + Number(r[0]);
    const hasNum = r.slice(1).some(function (v) { return typeof v === 'number' || typeof v === 'boolean'; });
    if (seen[key] || !hasNum) return;
    seen[key] = true;
    rows.push(r);
  });
  return { cols: ix.cols, rows: rows };
}

/**
 * Part 'history' = export_xlsx.py export_history() (window.SB_HISTORY):
 * History30 daily candles + PatternData W..AA tags. Refused while Phase 1 is
 * rewriting History30 (bars for fewer than half of the Main symbols).
 */
function ab_site_history_(cx) {
  const tab = ab_site_tab_(cx, 'History30');
  if (!tab) throw new Error('Could not find a "History30" tab.');
  const rows = tab.values;
  const hdr = (rows[0] || []).map(function (h) { return ab_site_norm_(cx, h); });
  const ci = {};
  ['symbol', 'date', 'open', 'high', 'low', 'close', 'volume'].forEach(function (k) {
    ci[k] = hdr.indexOf(k);
    if (ci[k] === -1) throw new Error('History30 has no "' + k + '" column.');
  });
  const ohlcv = [ci.open, ci.high, ci.low, ci.close, ci.volume];
  let dates = [];
  const didx = {}, bars = {}, dayOf = {};
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r], sym = row[ci.symbol];
    if (!sym) continue;
    const raw = row[ci.date];
    const key = raw instanceof Date ? 'd' + raw.getTime() : typeof raw + ':' + raw;
    let d = dayOf[key];
    if (d === undefined) {                      // ~30 distinct dates in ~54,000 rows
      d = ab_site_clean_(cx, raw, 'date');
      d = d && d.indexOf('/') !== -1 ? ab_site_textDate_(d) : d;
      d = dayOf[key] = d ? d.slice(0, 10) : '';
    }
    if (!d) continue;
    if (didx[d] === undefined) { didx[d] = dates.length; dates.push(d); }
    const bar = [didx[d]];
    for (let k = 0; k < ohlcv.length; k++) bar.push(ab_site_clean_(cx, row[ohlcv[k]], 'num'));
    const s = ab_site_pyStr_(cx, sym).trim().toUpperCase();
    (bars[s] = bars[s] || []).push(bar);
  }
  // re-index dates in calendar order
  const order = dates.map(function (x, i) { return i; }).sort(function (a, b) { return dates[a] < dates[b] ? -1 : dates[a] > dates[b] ? 1 : 0; });
  const remap = {};
  order.forEach(function (old, i) { remap[old] = i; });
  dates = order.map(function (i) { return dates[i]; });
  Object.keys(bars).forEach(function (s) {
    bars[s] = bars[s].map(function (b) { return [remap[b[0]]].concat(b.slice(1)); })
      .sort(function (a, b) { return a[0] - b[0]; });
  });

  const have = Object.keys(bars).length, want = ab_site_mainSymbolCount_(cx);
  if (have * 2 < want) {
    throw new Error('sheet is updating (History30 has ' + have + ' of ' + want + ' symbols) - try again shortly');
  }

  // [pattern W, fvg X, 10 EMA Y, ATR14 Z, 21 EMA AA] per PatternData symbol (col D)
  const tags = {};
  const pdTab = ab_site_tab_(cx, 'PatternData');
  if (pdTab) {
    const pr = pdTab.values;
    const ph = (pr[0] || []).map(function (h) { return ab_site_norm_(cx, h); });
    const col = function (name, dflt) { const j = ph.indexOf(name); return j === -1 ? dflt : j; };
    const at = [col('pattern', 22), col('long fvg touch', 23), col('10 ema support', 24),
                col('atr14 (ema)', 25), col('21 ema support', 26)];
    for (let r = 1; r < pr.length; r++) {
      const sym = pr[r].length > 3 ? pr[r][3] : null;
      if (!sym) continue;
      tags[ab_site_pyStr_(cx, sym).trim().toUpperCase()] = at.map(function (j) {
        const v = j < pr[r].length ? pr[r][j] : null;
        return typeof v === 'number' ? v : v instanceof Date ? ab_site_clean_(cx, v) : (v || '');
      });
    }
  }
  const note = ab_site_resultsNote_(cx);
  return { asOf: ab_site_asOf_(note), source: 'History30 tab (GOOGLEFINANCE daily candles)', timeframe: '1d',
           dates: dates, cols: ['d', 'o', 'h', 'l', 'c', 'v'], bars: bars, sheetTags: tags };
}

/** The Results Performance A2 note (holds 'last refreshed dd/MM/yyyy HH:mm'). */
function ab_site_resultsNote_(cx) {
  const sh = cx.ss.getSheetByName('Results Performance');
  return sh && sh.getLastRow() >= 2 ? ab_site_clean_(cx, sh.getRange(2, 1).getValue()) : null;
}

/** Distinct non-blank Main SYMBOLs (row 2 header), reading that column only. */
function ab_site_mainSymbolCount_(cx) {
  const sh = cx.ss.getSheetByName(AB_MAIN_SHEET);
  if (!sh || sh.getLastRow() < 3 || sh.getLastColumn() < 1) return 0;
  const hdr = sh.getRange(2, 1, 1, sh.getLastColumn()).getValues()[0]
    .map(function (h) { return ab_site_norm_(cx, h); });
  const j = hdr.indexOf('symbol');
  if (j === -1) return 0;
  const seen = {};
  sh.getRange(3, j + 1, sh.getLastRow() - 2, 1).getValues().forEach(function (r) {
    if (!ab_site_isBlank_(r[0])) seen[ab_site_pyStr_(cx, r[0]).trim().toUpperCase()] = true;
  });
  return Object.keys(seen).length;
}

/** A whole tab, read once per call: { sheet, values } or null. */
function ab_site_tab_(cx, name) {
  if (!Object.prototype.hasOwnProperty.call(cx.tabs, name)) {
    const sh = cx.ss.getSheetByName(name);
    cx.tabs[name] = sh ? { sheet: sh, values: sh.getDataRange().getValues() } : null;
  }
  return cx.tabs[name];
}

/** One column of a tab (1-based), e.g. the symbols of a personal tab - nothing else is read. */
function ab_site_column_(cx, name, col) {
  const sh = cx.ss.getSheetByName(name);
  if (!sh || sh.getLastRow() < 1 || sh.getLastColumn() < col) return [];
  return sh.getRange(1, col, sh.getLastRow(), 1).getValues().map(function (r) { return r[0]; });
}

/**
 * export_xlsx.py table(): find the row whose first cell is `firstHeader`,
 * read headers from it and data rows below until the first blank first cell
 * (opt.stopBlank false: skip blank rows instead). opt.kinds = {header: kind};
 * other columns get frac/auto from the number format of their first numeric
 * cell (formats are read for those rows only). opt.maxRows caps the rows.
 */
function ab_site_table_(cx, tab, firstHeader, opt) {
  opt = opt || {};
  const stopBlank = opt.stopBlank !== false, kinds = opt.kinds || {};
  const rows = tab ? tab.values : [];
  const want = ab_site_norm_(cx, firstHeader);
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].length || ab_site_norm_(cx, rows[i][0]) !== want) continue;
    const hdr = rows[i].map(function (h) { return ab_site_isBlank_(h) ? '' : ab_site_pyStr_(cx, h).trim(); });
    while (hdr.length && !hdr[hdr.length - 1]) hdr.pop();
    const idxs = [];
    for (let k = i + 1; k < rows.length; k++) {
      if (!rows[k].length || ab_site_isBlank_(rows[k][0])) {
        if (stopBlank) break;
        continue;
      }
      idxs.push(k);
      if (opt.maxRows && idxs.length >= opt.maxRows) break;
    }
    let fmts = null;
    const fmtAt = function (k, j) {
      if (!fmts) {
        const hi = idxs[Math.min(idxs.length, 200) - 1];
        fmts = tab.sheet.getRange(idxs[0] + 1, 1, hi - idxs[0] + 1, rows[i].length).getNumberFormats();
      }
      const fr = fmts[k - idxs[0]] || [];
      return j < fr.length ? fr[j] : '';
    };
    const ks = hdr.map(function (h, j) {
      if (Object.prototype.hasOwnProperty.call(kinds, h) && kinds[h]) return kinds[h];
      for (let n = 0; n < Math.min(idxs.length, 200); n++) {   // col_kind(): first numeric cell
        if (typeof rows[idxs[n]][j] === 'number') return ab_site_isFracFormat_(fmtAt(idxs[n], j)) ? 'frac' : 'auto';
      }
      return 'auto';
    });
    return {
      cols: hdr,
      rows: idxs.map(function (k) { return hdr.map(function (h, j) { return ab_site_clean_(cx, rows[k][j], ks[j]); }); })
    };
  }
  return { cols: [], rows: [] };
}

/**
 * export_xlsx.py clean(v, kind): one cell -> JSON value.
 *   kind: str | num | pct | frac (x100) | date | bool | auto (default)
 * Errors ('#N/A', 'Loading...', anything starting with '#') and blanks ->
 * null; numbers rounded to 4 dp; dates -> 'yyyy-MM-dd' ('yyyy-MM-dd HH:mm'
 * when the time isn't midnight) in the spreadsheet's time zone; text dates
 * such as '21-Aug-2026' -> ISO text.
 */
function ab_site_clean_(cx, v, kind) {
  kind = kind || 'auto';
  if (v === null || v === undefined) return null;
  const numeric = kind === 'num' || kind === 'pct' || kind === 'frac';
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '' || s.charAt(0) === '#' || AB_SITE_ERRORS.indexOf(s) !== -1) return null;
    if (!numeric) return ab_site_textDate_(s) || s;
    v = ab_site_pyFloat_(s.replace(/,/g, ''));
    if (v === null) return null;
  }
  if (typeof v === 'boolean') return kind === 'bool' || kind === 'auto' ? v : null;
  if (v instanceof Date) {
    const t = ab_site_fmtDate_(cx, v);
    if (t.slice(0, 10) === '1899-12-30') return t.slice(11);   // time-only cell: Python str(time)
    if (numeric) return null;
    return t.slice(11, 16) === '00:00' ? t.slice(0, 10) : t.slice(0, 16);
  }
  if (typeof v === 'number') {
    if (kind === 'frac') v = v * 100;
    if (kind === 'str' || kind === 'date') return ab_site_pyStr_(cx, v);
    return ab_site_round4_(v);
  }
  return String(v);
}

/** Date -> 'yyyy-MM-dd HH:mm:ss' in the spreadsheet's zone (cached: History30 repeats ~30 dates). */
function ab_site_fmtDate_(cx, d) {
  const k = d.getTime();
  if (!(k in cx.dates)) cx.dates[k] = Utilities.formatDate(d, cx.tz, 'yyyy-MM-dd HH:mm:ss');
  return cx.dates[k];
}

/** export_xlsx.py text_date(): '21-Aug-2026', '01/10/2026 20:23' ... -> ISO text, or null. */
function ab_site_textDate_(s) {
  if (!(s.length >= 8 && s.length <= 17 && /^\d\d/.test(s))) return null;
  for (let i = 0; i < AB_SITE_TEXT_DATES.length; i++) {
    const f = AB_SITE_TEXT_DATES[i], mt = f.re.exec(s);
    if (!mt) continue;
    const day = Number(mt[1]);
    const mon = f.month === 'b' ? AB_SITE_MONTHS.indexOf(mt[2].toLowerCase()) + 1 : Number(mt[2]);
    let year = Number(mt[3]);
    if (f.year === 'y') year += year <= 68 ? 2000 : 1900;
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    if (day > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mon - 1]) continue;
    const p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    const ymd = ('000' + year).slice(-4) + '-' + p2(mon) + '-' + p2(day);
    return f.time ? ymd + ' ' + p2(Number(mt[4])) + ':' + p2(Number(mt[5])) : ymd;
  }
  return null;
}

/** export_xlsx.py norm(): collapse whitespace, lower-case. */
function ab_site_norm_(cx, h) {
  return (h ? ab_site_pyStr_(cx, h) : '').split(/\s+/).filter(String).join(' ').toLowerCase();
}

/** Python str() of a cell value as openpyxl reads it (whole numbers are int). */
function ab_site_pyStr_(cx, v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (v instanceof Date) {
    const t = ab_site_fmtDate_(cx, v);
    return t.slice(0, 10) === '1899-12-30' ? t.slice(11) : t;
  }
  if (typeof v !== 'number') return String(v);
  if (!isFinite(v)) return isNaN(v) ? 'nan' : v > 0 ? 'inf' : '-inf';
  if (Number.isInteger(v) && Math.abs(v) < 1e16) return String(v);
  const e = v.toExponential().split('e'), x = Number(e[1]);   // shortest digits, like Python repr
  if (x >= -4 && x < 16) return String(v);
  return e[0] + 'e' + (x < 0 ? '-' : '+') + (Math.abs(x) < 10 ? '0' : '') + Math.abs(x);
}

/** Python float(text), or null (also for nan / inf, which JSON can't carry). */
function ab_site_pyFloat_(s) {
  const t = s.trim();
  if (!/^[+-]?(\d(_?\d)*(\.(\d(_?\d)*)?)?|\.\d(_?\d)*)([eE][+-]?\d(_?\d)*)?$/.test(t)) return null;
  return Number(t.replace(/_/g, ''));
}

/** Python round(v, 4): nearest 4-dp value, exact ties (odd multiples of 1/32) to even. */
function ab_site_round4_(v) {
  if (!isFinite(v)) return null;
  if (Number.isInteger(v * 32) && (v * 32) % 2 !== 0 && Math.abs(v) < 1e10) {
    const f = Math.floor(v * 10000);
    return (f % 2 === 0 ? f : f + 1) / 10000;
  }
  return Number(v.toFixed(4));
}

/** True for formats such as 0.00% (a quoted "%" or \% is a literal sign: the value is already a percent). */
function ab_site_isFracFormat_(f) {
  return String(f || '').replace(/"[^"]*"/g, '').replace(/\\./g, '').indexOf('%') !== -1;
}

function ab_site_isBlank_(v) { return v === null || v === undefined || v === ''; }

// ---------------------------------------------------------------------
// WEBSITE SITE FEED - STORED COPY. Building part 'main' / 'history' reads
// big tabs and takes 30+ s in Apps Script (a page load sends several
// requests at once and they slow each other down) - longer than the
// website's server waits (25 s). So the feed is built AHEAD of time and
// stored, and doPost 'site' hands out the stored text at once.
//   Hidden tab Site_Feed: col 1 / 2 = main slot 0 / 1, col 3 / 4 = history
//   slot 0 / 1. A slot holds JSON.stringify(data) - exactly what
//   ab_site_main_ / ab_site_history_ return - in chunks of <= 45,000
//   characters (a cell holds 50,000), one per row from row 1. Every cell
//   starts with '~<build id>~', so Sheets never takes a chunk for a
//   number, date or formula and chunks of two builds can't be mixed up.
//   Script Properties AB_SITE_FEED_META_MAIN / _HISTORY describe the copy:
//   { slot, chunks, length, id, readAt, readMs, builtAt, buildMs, by, fmt }
//   (readAt / builtAt 'yyyy-MM-dd HH:mm' IST; readAt = when the sheet was
//   read, the time the website's DELAYED / EOD / CACHED label uses; fmt =
//   AB_SITE_FEED_FORMAT of the code that built it).
// A build writes the slot NOT in use, then points the meta at it, so a
// reader never sees half-written data; a failed build (e.g. History30 is
// being rewritten) keeps the previous copy. No LockService (the 5-minute
// alert job and the PC bridge use the script lock): Script Property
// AB_SITE_BUILDING_SINCE ('<ms>:<run id>') stops two builds overlapping. A
// property is not a lock (two runs can both find it empty), so a build only
// points the meta at its slot while the mark and the slot's first cell are
// still its own. Nothing is written anywhere but the Site_Feed tab and these
// properties.
// Kept fresh by the time-driven ab_siteFeedTrigger_ (every 30 min; rules
// in ab_siteFeedDue_). Menu: 3. Quarterly Results & Trend Tags > Website
// feed: rebuild now / stop auto-refresh.
// The trigger and the menu run the SAVED code, doPost the DEPLOYED version:
// saving (clasp push) a Code.gs that changes the feed changes what the site
// gets within ~30 min, even before the New version deploy. So keep the
// storage layout readable by the older deployed reader, and bump
// AB_SITE_FEED_FORMAT whenever ab_site_main_ / ab_site_history_ output or
// the allow-list changes: a copy built by older code is then rebuilt by the
// next trigger run and never served by the newer deployed version.
// ---------------------------------------------------------------------
const AB_SITE_FEED_FORMAT = 1;
const AB_SITE_FEED_SHEET = 'Site_Feed';
const AB_SITE_FEED_PARTS = ['main', 'history'];
const AB_SITE_FEED_CHUNK = 45000;
const AB_SITE_FEED_MARK = '~';
const AB_SITE_FEED_META_PROPS = { main: 'AB_SITE_FEED_META_MAIN', history: 'AB_SITE_FEED_META_HISTORY' };
const AB_SITE_BUILDING_PROP = 'AB_SITE_BUILDING_SINCE';
const AB_SITE_BUILD_STALE_MS = 10 * 60 * 1000;          // a build "running" longer than this has died
const AB_SITE_PREPARING = 'site feed is being prepared - try again in a minute';
const AB_SITE_TRIGGER_FN = 'ab_siteFeedTrigger_';
const AB_SITE_TRIGGER_CHECK_PROP = 'AB_SITE_FEED_TRIGGER_CHECKED';
const AB_SITE_TRIGGER_CHECK_MS = 6 * 60 * 60 * 1000;    // doPost looks at the trigger at most this often
const AB_SITE_AUTO_OFF_PROP = 'AB_SITE_FEED_AUTO_OFF';  // set by "stop auto-refresh"
const AB_SITE_BUDGET_MS = 4.5 * 60 * 1000;              // a trigger run starts no build after this
const AB_SITE_SETTLE_MIN = 16 * 60;                     // 16:00 IST: api/'s SETTLE_TIME, prices hold the close from here
const AB_SITE_PHASE_SLACK_MIN = 25;                     // a daily phase: nearMinute +/-15 min, runs <= 6 min, + margin

/** The Site_Feed tab (made on first use: hidden, 4 columns), or null. */
function ab_siteFeedSheet_(create) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(AB_SITE_FEED_SHEET);
  if (!sh && create) {
    let active = null;
    try { active = ss.getActiveSheet(); } catch (e) { active = null; }
    try {
      sh = ss.insertSheet(AB_SITE_FEED_SHEET, ss.getNumSheets());
    } catch (e) {
      // another run (the other part's request, the trigger) made it a moment ago
      sh = ss.getSheetByName(AB_SITE_FEED_SHEET);
      if (!sh) throw e;
      return sh;
    }
    // cosmetic, each on its own: fewer cells against the file's limit, back to
    // the tab the owner was on (insertSheet switched to the new one), hidden
    try { if (sh.getMaxColumns() > 4) sh.deleteColumns(5, sh.getMaxColumns() - 4); } catch (e) { /* cosmetic */ }
    try { if (active) active.activate(); } catch (e) { /* no UI (web app / trigger) */ }
    try { sh.hideSheet(); } catch (e) { /* cosmetic */ }
  }
  return sh;
}

function ab_siteFeedCol_(part, slot) { return (part === 'main' ? 1 : 3) + slot; }

/** The stored copy's description for `part`, or null when there is none. */
function ab_siteFeedMeta_(part) {
  const raw = PropertiesService.getScriptProperties().getProperty(AB_SITE_FEED_META_PROPS[part]);
  if (!raw) return null;
  try {
    const m = JSON.parse(raw);
    return m && (m.slot === 0 || m.slot === 1) && m.chunks >= 1 && m.length >= 1 ? m : null;
  } catch (e) {
    return null;
  }
}

/** True when the copy was built by code with an older AB_SITE_FEED_FORMAT (or before it existed). */
function ab_siteFeedOldFormat_(meta) {
  return (Number(meta.fmt) || 0) < AB_SITE_FEED_FORMAT;
}

/**
 * The stored text of `part` as { text, meta }, or null when there is none,
 * it was built by older code (AB_SITE_FEED_FORMAT) or it doesn't add up (a
 * chunk of another build, a different total length). A NEWER format is
 * served: that is the saved code's trigger running ahead of the deployment.
 */
function ab_siteFeedRead_(part) {
  const meta = ab_siteFeedMeta_(part);
  if (!meta || ab_siteFeedOldFormat_(meta)) return null;
  try {
    const sh = ab_siteFeedSheet_(false);
    if (!sh) return null;
    const vals = sh.getRange(1, ab_siteFeedCol_(part, meta.slot), meta.chunks, 1).getValues();
    const tag = AB_SITE_FEED_MARK + (meta.id || '') + AB_SITE_FEED_MARK;
    const pieces = [];
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i][0];
      if (typeof v !== 'string' || v.slice(0, tag.length) !== tag) return null;
      pieces.push(v.slice(tag.length));
    }
    const text = pieces.join('');
    return text.length === meta.length ? { text: text, meta: meta } : null;
  } catch (e) {
    return null;
  }
}

/** `text` in pieces of <= AB_SITE_FEED_CHUNK characters, never splitting an emoji (surrogate pair). */
function ab_siteFeedChunks_(text) {
  const out = [];
  for (let i = 0; i < text.length;) {
    let j = Math.min(i + AB_SITE_FEED_CHUNK, text.length);
    const c = text.charCodeAt(j - 1);
    if (j < text.length && c >= 0xD800 && c <= 0xDBFF) j--;
    out.push(text.slice(i, j));
    i = j;
  }
  return out;
}

/**
 * Writes `text` into the free slot of `part`, then points the meta at it and
 * returns the meta. info: { readAt, readMs, builtAt, buildMs, by }.
 * mark (ab_siteBuild_'s AB_SITE_BUILDING_SINCE value): when another build
 * has taken over meanwhile - the mark or the slot's first cell is no longer
 * this build's - the meta is left as it is and null is returned.
 */
function ab_siteFeedStore_(part, text, info, mark) {
  const sh = ab_siteFeedSheet_(true);
  const props = PropertiesService.getScriptProperties();
  const old = ab_siteFeedMeta_(part);
  const slot = old && old.slot === 0 ? 1 : 0;
  const col = ab_siteFeedCol_(part, slot);
  const id = Utilities.getUuid().replace(/-/g, '').slice(0, 10);
  const tag = AB_SITE_FEED_MARK + id + AB_SITE_FEED_MARK;
  const chunks = ab_siteFeedChunks_(text);
  const rows = Math.max(chunks.length, sh.getLastRow());   // '' below the chunks clears an older, longer copy
  if (sh.getMaxRows() < rows) sh.insertRowsAfter(sh.getMaxRows(), rows - sh.getMaxRows());
  const vals = [];
  for (let i = 0; i < rows; i++) vals.push([i < chunks.length ? tag + chunks[i] : '']);
  sh.getRange(1, col, rows, 1).setValues(vals);
  SpreadsheetApp.flush();
  const first = sh.getRange(1, col).getValue();
  if (typeof first !== 'string' || first.slice(0, tag.length) !== tag) return null;
  if (mark && props.getProperty(AB_SITE_BUILDING_PROP) !== mark) return null;
  const meta = { slot: slot, chunks: chunks.length, length: text.length, id: id, readAt: info.readAt, readMs: info.readMs,
                 builtAt: info.builtAt, buildMs: info.buildMs, by: info.by, fmt: AB_SITE_FEED_FORMAT };
  props.setProperty(AB_SITE_FEED_META_PROPS[part], JSON.stringify(meta));
  return meta;
}

/** True while another run is building (its AB_SITE_BUILDING_SINCE mark '<ms>:<run id>' is under 10 min old). */
function ab_siteBuildRunning_() {
  const raw = PropertiesService.getScriptProperties().getProperty(AB_SITE_BUILDING_PROP) || '';
  const since = Number(raw.split(':')[0]) || 0;
  const age = Date.now() - since;
  return since > 0 && age >= 0 && age < AB_SITE_BUILD_STALE_MS;
}

/**
 * Builds `parts` (['main'], ['history'] or both) with ab_site_main_ /
 * ab_site_history_ and stores them. Returns a short summary:
 *   { part: { ok:true, ms, bytes, readAt } | { ok:false, error, busy? } }
 * reason: who asked ('request' | 'auto' | 'menu'), kept in the meta / log.
 * opt.deadline (ms): a part is only started while its last build time
 * still fits before it (the first one always is). opt.out = {} receives
 * { part: { text, readAt, builtAt } } of each part built (even if storing
 * it failed), for doPost's on-demand answer.
 */
function ab_siteBuild_(parts, reason, opt) {
  opt = opt || {};
  const out = {};
  if (ab_siteBuildRunning_()) {
    parts.forEach(function (p) { out[p] = { ok: false, busy: true, error: 'another build is running' }; });
    return out;
  }
  const props = PropertiesService.getScriptProperties();
  const mark = Date.now() + ':' + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
  props.setProperty(AB_SITE_BUILDING_PROP, mark);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let started = 0;
    parts.forEach(function (part) {
      if (AB_SITE_FEED_PARTS.indexOf(part) === -1) { out[part] = { ok: false, error: 'unknown part' }; return; }
      const last = ab_siteFeedMeta_(part);
      const expectMs = last && last.buildMs > 0 ? last.buildMs : 60 * 1000;
      if (opt.deadline && started && Date.now() + expectMs > opt.deadline) {
        out[part] = { ok: false, error: 'skipped - no time left in this run' };
        return;
      }
      started++;
      const t0 = Date.now();
      let text, info;
      try {
        const readAt = Utilities.formatDate(new Date(t0), AB_TZ, 'yyyy-MM-dd HH:mm');
        const cx = { ss: ss, tz: ss.getSpreadsheetTimeZone() || AB_TZ, tabs: {}, dates: {} };
        text = JSON.stringify(part === 'main' ? ab_site_main_(cx, readAt) : ab_site_history_(cx));
        info = { readAt: readAt, readMs: t0, builtAt: Utilities.formatDate(new Date(), AB_TZ, 'yyyy-MM-dd HH:mm'),
                 buildMs: Date.now() - t0, by: String(reason || '') };
        if (opt.out) opt.out[part] = { text: text, readAt: info.readAt, builtAt: info.builtAt };
      } catch (e) {
        out[part] = { ok: false, error: e.message };
        return;
      }
      try {
        out[part] = ab_siteFeedStore_(part, text, info, mark)
          ? { ok: true, ms: Date.now() - t0, bytes: text.length, readAt: info.readAt }
          : { ok: false, busy: true, error: 'another build is running' };   // it stores its own copy
      } catch (e) {
        out[part] = { ok: false, error: 'built but not stored: ' + e.message };
      }
    });
  } finally {
    // only our own mark: a run that took over keeps its guard
    if (props.getProperty(AB_SITE_BUILDING_PROP) === mark) props.deleteProperty(AB_SITE_BUILDING_PROP);
  }
  Logger.log('Website feed build (' + reason + '): ' + JSON.stringify(out));
  return out;
}

/** doPost answer for a stored / just-built text, made without parsing the text again. */
function ab_siteFeedReply_(part, meta, text, stored) {
  return ContentService.createTextOutput('{"ok":true,"part":' + JSON.stringify(part) +
    ',"readAt":' + JSON.stringify(String(meta.readAt || '')) + ',"builtAt":' + JSON.stringify(String(meta.builtAt || '')) +
    ',"stored":' + (stored ? 'true' : 'false') + ',"tz":' + JSON.stringify(AB_TZ) + ',"data":' + text + '}')
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Is the stored `part` due for a rebuild at nowMs? Always when it was
 * built by older code (AB_SITE_FEED_FORMAT). Age = since the sheet was
 * read (IST clock):
 *   main    - 25 min on weekdays 09:00-16:15 (market hours + GOOGLEFINANCE
 *             delay) and every day 17:30-21:30 (Results Day ~18:00, the
 *             evening phases 18:45-19:30); 3 h otherwise. And on weekdays
 *             once from 16:00 when read before 16:00 today (a read in the
 *             first half hour after the 15:30 close may hold pre-close
 *             prices; the website calls it EOD).
 *   history - 6 h; and once from the evening cutoff (ab_siteEveningMin_,
 *             ~19:26) when read before it today: by then Phase 1 has
 *             rewritten History30 and Phase 2 / 3 PatternData's tags.
 */
function ab_siteFeedDue_(part, meta, nowMs) {
  if (!meta || !(meta.readMs > 0) || ab_siteFeedOldFormat_(meta)) return true;
  const age = nowMs - meta.readMs;
  const w = Utilities.formatDate(new Date(nowMs), AB_TZ, 'u HH mm yyyy-MM-dd').split(' ');
  const dow = Number(w[0]), mins = Number(w[1]) * 60 + Number(w[2]);
  // from minute-of-day m, once: the copy was read before m today
  const readBefore = function (m) {
    const hhmm = ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + m % 60).slice(-2);
    return mins >= m && Utilities.formatDate(new Date(meta.readMs), AB_TZ, 'yyyy-MM-dd HH:mm') < w[3] + ' ' + hhmm;
  };
  if (part === 'main') {
    const busy = (dow <= 5 && mins >= 9 * 60 && mins <= 16 * 60 + 15) || (mins >= 17 * 60 + 30 && mins <= 21 * 60 + 30);
    return age >= (busy ? 25 : 180) * 60 * 1000 || (dow <= 5 && readBefore(AB_SITE_SETTLE_MIN));
  }
  return age >= 6 * 60 * 60 * 1000 || readBefore(ab_siteEveningMin_());
}

/**
 * Minute of the day (IST) from which today's evening run has written
 * History30 (Phase 1) and PatternData's tags (Phase 2, ATR in Phase 3):
 * the latest of the Control Panel's Phase 1-3 times + AB_SITE_PHASE_SLACK_MIN
 * (19:01 + 25 = 19:26 by default).
 */
function ab_siteEveningMin_() {
  const at = function (h, m) { return Number(h) * 60 + Number(m); };
  const last = Math.max(at(AB_DAILY_P1_HOUR, AB_DAILY_P1_MIN), at(AB_DAILY_P2_HOUR, AB_DAILY_P2_MIN),
                        at(AB_DAILY_P3_HOUR, AB_DAILY_P3_MIN));
  return isFinite(last) ? Math.min(last + AB_SITE_PHASE_SLACK_MIN, 23 * 60 + 59) : 19 * 60 + 26;
}

/**
 * Time-driven, every 30 min (ab_ensureSiteFeedTrigger_): rebuilds the
 * parts that are due. Runs 48 times a day against Google's daily
 * trigger-runtime quota, so when nothing is due it only reads two Script
 * Properties and returns. A run starts no build after ~4.5 minutes.
 */
function ab_siteFeedTrigger_(e) {
  const t0 = Date.now();
  const due = AB_SITE_FEED_PARTS.filter(function (p) { return ab_siteFeedDue_(p, ab_siteFeedMeta_(p), t0); });
  if (!due.length || ab_siteBuildRunning_()) return;
  ab_siteBuild_(due, 'auto', { deadline: t0 + AB_SITE_BUDGET_MS });
}

/**
 * Exactly one ab_siteFeedTrigger_ trigger, every 30 minutes (extra copies
 * are deleted). After creating one it looks again: two requests arriving
 * together can both find none and both create one.
 */
function ab_ensureSiteFeedTrigger_() {
  const mine = function () {
    return ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === AB_SITE_TRIGGER_FN; });
  };
  let list = mine();
  const created = !list.length;
  if (created) {
    ScriptApp.newTrigger(AB_SITE_TRIGGER_FN).timeBased().everyMinutes(30).create();
    list = mine();
  }
  let removed = 0;
  for (let i = 1; i < list.length; i++) {
    try { ScriptApp.deleteTrigger(list[i]); removed++; } catch (e) { /* the other request deleted it already */ }
  }
  return { created: created, removed: removed };
}

/** doPost: makes sure the refresh trigger exists - at most every 6 h, and not after "stop auto-refresh". */
function ab_siteFeedTriggerCheck_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(AB_SITE_AUTO_OFF_PROP)) return;
  const last = Number(props.getProperty(AB_SITE_TRIGGER_CHECK_PROP)) || 0;
  const age = Date.now() - last;
  if (last && age >= 0 && age < AB_SITE_TRIGGER_CHECK_MS) return;
  props.setProperty(AB_SITE_TRIGGER_CHECK_PROP, String(Date.now()));   // first: a failing check is not retried on every request
  ab_ensureSiteFeedTrigger_();
}

/** Menu: build both parts now and (re)start the 30-minute auto-refresh. Run once after each New version deploy. */
function runSiteFeedRebuildNow() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(AB_SITE_AUTO_OFF_PROP);
  let auto;
  try {
    const t = ab_ensureSiteFeedTrigger_();
    props.setProperty(AB_SITE_TRIGGER_CHECK_PROP, String(Date.now()));
    auto = 'Auto-refresh: ON - every 30 minutes' + (t.created ? ' (switched on now)' : '') + '.';
  } catch (e) {
    auto = 'Auto-refresh could NOT be switched on: ' + e.message;
  }
  const r = ab_siteBuild_(AB_SITE_FEED_PARTS, 'menu');
  const lines = AB_SITE_FEED_PARTS.map(function (p) {
    const x = r[p];
    return p + ': ' + (x.ok
      ? 'OK - ' + Math.max(1, Math.round(x.bytes / 1024)) + ' KB in ' + Math.round(x.ms / 1000) + ' s (sheet read ' + x.readAt + ' IST)'
      : 'NOT rebuilt - ' + x.error + (x.busy ? ' (try again in a minute)' : '') + '. The previous copy (if any) is still used.');
  });
  ui.alert('Website feed - rebuild now',
    lines.join('\n') + '\n\n' + auto + '\n\n' +
    'The website gets these stored copies at once (no waiting for the sheet).\n' +
    'Market hours and evenings: refreshed every ~30 min; otherwise every 3-6 h.',
    ui.ButtonSet.OK);
}

/** Menu: remove the refresh trigger (doPost no longer re-creates it until "rebuild now"). */
function runSiteFeedStopAutoRefresh() {
  const ui = SpreadsheetApp.getUi();
  PropertiesService.getScriptProperties().setProperty(AB_SITE_AUTO_OFF_PROP, String(Date.now()));
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === AB_SITE_TRIGGER_FN) { ScriptApp.deleteTrigger(t); n++; }
  });
  ui.alert('Website feed - auto-refresh stopped',
    (n ? 'The 30-minute refresh trigger was removed.' : 'No refresh trigger was installed.') + '\n\n' +
    'The website keeps getting the last stored copy (labelled CACHED once it is old).\n' +
    'To switch it back on: Website feed: rebuild now.',
    ui.ButtonSet.OK);
}

/** Menu: shows the website feed token (it never changes the owner's data) for the website's server settings. */
function runFeedSetupInfo() {
  const ui = SpreadsheetApp.getUi();
  const token = ab_feedToken_(true);
  ui.alert('Website feed - setup info',
    'READ-ONLY FEED TOKEN (copy exactly):\n' + token + '\n\n' +
    'This one token feeds BOTH the website\'s price feed and its full live data\n' +
    '(the same tabs the Excel export publishes - never Portfolio, Risk Manager,\n' +
    'Control Panel, Trade Log, Trade Dashboard or Entry alerts).\n\n' +
    'In Vercel > your project > Settings > Environment Variables add:\n' +
    '  MARKET_DATA_PROVIDER = sheet\n' +
    '  SHEET_FEED_URL = the same web app address the PC bridge uses (ends with /exec)\n' +
    '  SHEET_FEED_TOKEN = the token above\n' +
    'then redeploy the site. This token cannot change your data: it reads the sheet and\n' +
    'only keeps the website\'s own stored copy (hidden tab Site_Feed) and its 30-minute\n' +
    'refresh trigger.\n\n' +
    'The web app must be on the NEW version of this code - update the EXISTING deployment\n' +
    '(never "New deployment": that changes the address the PC bridge uses):\n' +
    'Deploy > Manage deployments > pencil > Version: New version > Deploy.\n' +
    'Then run Website feed: rebuild now once (it stores the site data and starts its 30-minute refresh).',
    ui.ButtonSet.OK);
}

/** Menu: shows the web app address and the secret code to type into the PC program. */
function runBridgeSetupInfo() {
  const ui = SpreadsheetApp.getUi();
  const token = ab_bridgeToken_(true);
  let url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (e) { url = ''; }
  const deployed = /\/exec$/.test(url);
  ui.alert('PC Bridge - setup info',
    'SECRET CODE (copy exactly):\n' + token + '\n\n' +
    (deployed ? 'WEB APP ADDRESS (copy exactly):\n' + url + '\n\n'
              : 'WEB APP ADDRESS: not deployed yet.\n' +
                'Do this once: Extensions > Apps Script > Deploy > New deployment > (gear icon) Web app >\n' +
                '   Execute as: Me   |   Who has access: Anyone > Deploy > Authorize > copy the "Web app" URL.\n\n') +
    'Paste both into the PC program when its setup asks.\n\n' +
    'NOTE: after you paste a NEW Code.gs in future, update the web app too:\n' +
    'Deploy > Manage deployments > pencil icon > Version: New version > Deploy (the address stays the same).',
    ui.ButtonSet.OK);
}

/** Menu: how much the PC has delivered, and what it still has to fetch. */
function runBridgeStatus() {
  const ui = SpreadsheetApp.getUi();
  const map = ab_bridgeLoad_();
  const syms = Object.keys(map);
  let newest = 0;
  syms.forEach(function (s) { if (map[s].at > newest) newest = map[s].at; });
  let w = { priority: [], missing: [] };
  try { w = ab_bridgeWanted_(); } catch (e) { /* shown as zero */ }
  const ago = newest ? Math.round((Date.now() - newest) / 60000) : null;
  ui.alert('PC Bridge - status',
    'Symbols delivered by the PC so far: ' + syms.length + '\n' +
    'Last delivery: ' + (newest ? Utilities.formatDate(new Date(newest), AB_TZ, 'dd-MMM-yyyy HH:mm') +
                                  ' IST (' + (ago < 90 ? ago + ' min ago' : Math.round(ago / 60) + ' h ago') + ')' : 'never') + '\n\n' +
    'Still waiting for the PC:\n' +
    '  results due / pending: ' + w.priority.length + (w.priority.length ? ' (' + w.priority.slice(0, 8).join(', ') + (w.priority.length > 8 ? ', ...' : '') + ')' : '') + '\n' +
    '  never-attempted rows: ' + w.missing.length + '\n\n' +
    'Secret code set: ' + (ab_bridgeToken_(false) ? 'yes' : 'no (run "PC Bridge: setup info")'),
    ui.ButtonSet.OK);
}

/**
 * One symbol, one fetch (with retries), falling back to the standalone
 * page only when the consolidated page came back thin for EITHER
 * engine - this mirrors AB_QR's "no quarter columns -> try plain URL"
 * trigger and AB_TT's "fewer than 2 OPM points -> try plain URL"
 * trigger, combined into a single decision so only one extra request is
 * ever made per symbol, not one per engine.
 *
 * Always returns the ab_qt_parseBoth_ shape - quarterOk/tagsOk are both
 * false with matching error text when the fetch never got a usable page
 * at all (404, or every retry hit a transport error).
 */
function ab_qt_fetchOne_(sym) {
  // PC bridge first: screener refuses Google's servers, so pages fetched
  // by the user's PC (tab Screener_Bridge) are the real source.
  AB_BRIDGE_LAST_HIT = false;
  const bridged = ab_bridgeGet_(sym);
  const bridgedAge = bridged ? Date.now() - bridged.at : Infinity;
  if (bridged && (bridgedAge <= AB_BRIDGE_FRESH_MS || (AB_BRIDGE_ONLY && bridgedAge <= AB_BRIDGE_STALE_OK_MS))) {
    AB_BRIDGE_LAST_HIT = true;
    return ab_bridgeResult_(bridged);
  }
  if (AB_BRIDGE_ONLY) {
    return { quarterOk: false, growth: null, quarterError: 'PC bridge: no data from the PC yet',
             tagsOk: false, tags: null, tagsError: 'PC bridge: no data from the PC yet', quarterOpmCount: 0, score: -1 };
  }
  if (ab_screenerPauseMin_()) {
    return { quarterOk: false, growth: null, quarterError: 'screener.in fetching paused',
             tagsOk: false, tags: null, tagsError: 'screener.in fetching paused', quarterOpmCount: 0, score: -1 };
  }
  const url = ab_qrUrl_(sym);
  let lastErr = '';
  let consolidated = null;

  for (let attempt = 0; attempt <= AB_QT_RETRIES; attempt++) {
    if (attempt) Utilities.sleep(AB_QT_RETRY_BACKOFF_MS * attempt);
    try {
      const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
      const code = res.getResponseCode();
      if (code === 404) { lastErr = 'not on screener (404)'; break; }
      if (code !== 200) { lastErr = 'HTTP ' + code; continue; }
      consolidated = ab_qt_parseBoth_(res.getContentText());
      break;
    } catch (e) {
      lastErr = e.message;
      if (AB_QT_SKIP_RETRY_ON.test(lastErr)) break; // hangs, not worth retrying
    }
  }
  if (!consolidated) {
    // Live fetch failed (expected while Google is blocked). Older PC data
    // beats a failure - unless the failure was definitive (404 etc.).
    if (bridged && bridgedAge <= AB_BRIDGE_STALE_OK_MS && !ab_qt_isDefinitiveError_(lastErr)) {
      AB_BRIDGE_LAST_HIT = true;
      return ab_bridgeResult_(bridged);
    }
    return { quarterOk: false, growth: null, quarterError: lastErr || 'unknown error',
             tagsOk: false, tags: null, tagsError: lastErr || 'unknown error',
             quarterOpmCount: 0, score: -1 };
  }

  // Good enough on its own - the same bar AB_QR and AB_TT each already
  // use before bothering with a second request.
  const thin = !consolidated.quarterOk || consolidated.quarterOpmCount < 2;
  if (!thin) return consolidated;

  let standalone = null;
  try {
    const res2 = UrlFetchApp.fetch(ab_qrPlainUrl_(sym), { muteHttpExceptions: true, followRedirects: true });
    if (res2.getResponseCode() === 200) standalone = ab_qt_parseBoth_(res2.getContentText());
  } catch (e2) {
    // Same host as the request that just worked - a transport failure
    // here is unlucky, not informative. Fall through and use whatever
    // the consolidated page gave us.
  }
  if (!standalone) return consolidated;
  return standalone.score >= consolidated.score ? standalone : consolidated;
}

/**
 * Writes one symbol's figures into its Main row - both the six
 * Quarterly/TTM EPS columns and the four Trend Tag columns, in one
 * pass. Each value is written only when it was actually computed, so a
 * company with too little history (or a page missing one section)
 * keeps whatever was already there. Returns how many previously-EMPTY
 * cells were filled.
 */
function ab_qt_writeRow_(layout, cols, rowIdx, combined) {
  const row = rowIdx + 1;
  let newlyFilled = 0;
  function put(colIdx, val) {
    if (colIdx === -1 || val === '' || val === undefined || val === null) return;
    if (ab_cellText_(layout.data[rowIdx][colIdx]) === '') newlyFilled++;
    layout.sheet.getRange(row, colIdx + 1).setValue(val);
  }
  if (combined.quarterOk && combined.growth) {
    const g = combined.growth;
    put(layout.qoqRev, g.qoqRev);
    put(layout.qoqNp, g.qoqNp);
    put(layout.yoyRev, g.yoyRev);
    put(layout.yoyNp, g.yoyNp);
    put(layout.ttmEps, g.ttmEps);
    put(layout.lastFyEps, g.lastFyEps);
  }
  if (combined.tagsOk && combined.tags) {
    const t = combined.tags;
    put(cols.promoter, t.promoter);
    put(cols.fii, t.fii);
    put(cols.opmYoY, t.opmYoY);
    put(cols.opmQoQ, t.opmQoQ);
  }
  return newlyFilled;
}

/**
 * Main driver - mirrors ab_updateQuarterlyResults_'s structure, widened
 * to check and write both engines' columns together.
 *
 * @param {string} mode 'missing' (default) = only rows that have NEVER
 *   been successfully attempted - every one of the ten target columns
 *   is still blank. A row with even one cell filled is left alone, since
 *   plenty of blanks are permanent (no shareholding history, too new for
 *   a YoY figure) rather than "still to do" - see the comment at the
 *   candidate-selection loop below. 'all' = every symbol regardless of
 *   what's already filled, resumable across runs.
 */
function ab_qt_updateQuarterlyAndTrendTags_(mode) {
  mode = mode || 'missing';
  const startedAt = Date.now();

  const cooling = AB_BRIDGE_ONLY ? 0 : ab_qt_cooldownRemainingMin_();
  if (cooling) {
    Logger.log('Combined engine cooldown active - skipping this pass, ' + cooling + ' min left.');
    return { requested: 0, updated: 0, newlyFilled: 0, failed: 0, standalone: [], errors: [],
             done: false, nextCursor: 0, total: 0, skipped: 0, skippedTooNew: 0,
             parkedTooNew: [], throttled: false, cooldownMin: cooling };
  }

  const layout = ab_getMainLayout_();
  const cols = {
    promoter: ab_qt_findCol_(layout.header, AB_TT_PROMOTER_HEADER),
    fii: ab_qt_findCol_(layout.header, AB_TT_FII_HEADER),
    opmYoY: ab_qt_findCol_(layout.header, AB_TT_OPM_YOY_HEADER),
    opmQoQ: ab_qt_findCol_(layout.header, AB_TT_OPM_QOQ_HEADER)
  };

  const missingCols = [];
  if (layout.qoqRev === -1) missingCols.push('QoQ[Revenue Growth%]');
  if (layout.qoqNp === -1) missingCols.push('QoQ[NP Growth %]');
  if (layout.yoyRev === -1) missingCols.push('YoY[Revenue Growth %]');
  if (layout.yoyNp === -1) missingCols.push('YoY[NP Growth %]');
  if (missingCols.length) {
    throw new Error('Main is missing quarterly growth column(s): ' + missingCols.join(', '));
  }
  if (cols.promoter === -1 && cols.fii === -1 && cols.opmYoY === -1 && cols.opmQoQ === -1) {
    throw new Error('Main has none of the trend tag columns: "' + AB_TT_PROMOTER_HEADER + '", "' +
                    AB_TT_FII_HEADER + '", "' + AB_TT_OPM_YOY_HEADER + '", "' + AB_TT_OPM_QOQ_HEADER + '".');
  }

  const data = layout.data;
  const candidates = [];
  const unfillable = ab_qt_getUnfillable_();
  const tooNew = ab_qt_getTooNew_();
  let skipped = 0, skippedTooNew = 0;

  const targetCols = [layout.qoqRev, layout.qoqNp, layout.yoyRev, layout.yoyNp,
                       layout.ttmEps, layout.lastFyEps,
                       cols.promoter, cols.fii, cols.opmYoY, cols.opmQoQ];

  for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
    const sym = ab_cellText_(data[r][layout.symbol]).toUpperCase();
    const name = ab_cellText_(data[r][layout.name]);
    if (!sym && !name) break; // end of the watchlist block
    if (!sym) continue;

    if (mode === 'missing') {
      // A row needs work only when EVERY target column across BOTH
      // engines is still blank - i.e. this symbol has never been
      // successfully attempted. Deliberately NOT "at least one cell is
      // blank": plenty of rows only ever get PART of the ten cells
      // filled, permanently - a company with too little shareholding
      // history genuinely never gets a Promoter/FII tag, a recent
      // listing genuinely never gets a YoY figure - and re-querying
      // screener for those every single pass, across 1755+ rows,
      // burns most of a run's time budget on symbols that are already
      // as done as they're ever going to get. This mirrors the
      // standalone Trend Tags engine's own 'missing' check just above
      // (ab_tt_updateTrendTags_ - "a symbol counts as done the moment
      // ANY of its four cells has been written"), now applied across
      // all ten combined columns. "Backfill ALL" still exists for a
      // deliberate full refresh (e.g. once a reporting season lands).
      let everWritten = false;
      for (let k = 0; k < targetCols.length; k++) {
        if (targetCols[k] !== -1 && ab_cellText_(data[r][targetCols[k]]) !== '') { everWritten = true; break; }
      }
      if (everWritten) continue;
      if ((unfillable[sym] || 0) >= AB_QT_SKIP_AFTER) { skipped++; continue; }
      if (ab_qt_isParkedTooNew_(tooNew, sym)) { skippedTooNew++; continue; }
    }
    if (AB_BRIDGE_ONLY && !ab_bridgeGet_(sym)) continue; // PC hasn't delivered it yet
    candidates.push({ sym: sym, rowIdx: r });
  }

  // Resume where the last run stopped - only for 'all', same reasoning
  // as the standalone Quarterly engine: 'missing' rebuilds its candidate
  // list from whichever cells are still blank, so it shrinks on its own.
  const props = PropertiesService.getScriptProperties();
  const cursorKey = AB_QT_CURSOR_PROP + '_' + mode;
  let cursor = 0;
  if (mode === 'all') {
    cursor = Number(props.getProperty(cursorKey) || 0);
    if (isNaN(cursor) || cursor < 0 || cursor >= candidates.length) cursor = 0;
  }

  const summary = { requested: 0, updated: 0, newlyFilled: 0, failed: 0,
                    standalone: [], errors: [],
                    done: true, nextCursor: 0, total: candidates.length,
                    skipped: skipped, skippedTooNew: skippedTooNew, parkedTooNew: [],
                    throttled: false };
  const slice = candidates.slice(cursor);
  if (!slice.length) {
    props.deleteProperty(cursorKey);
    return summary;
  }

  let consecutiveTransportFails = 0;
  let unfillableChanged = false, tooNewChanged = false;
  let processed = 0;

  for (let i = 0; i < slice.length; i++) {
    if (Date.now() - startedAt > AB_QT_TIME_BUDGET_MS) { summary.done = false; break; }
    if (consecutiveTransportFails >= AB_QT_ABORT_AFTER_FAILS) {
      summary.done = false;
      summary.throttled = true;
      props.setProperty(AB_QT_COOLDOWN_PROP, String(Date.now() + AB_QT_COOLDOWN_MS));
      Logger.log('Stopping early: ' + consecutiveTransportFails +
                 ' transport failures in a row - screener is refusing requests. ' +
                 'Combined-engine passes paused for ' + Math.round(AB_QT_COOLDOWN_MS / 60000) + ' min.');
      break;
    }

    const c = slice[i];
    summary.requested++;
    processed++;
    const posn = '[' + (cursor + processed) + '/' + candidates.length + '] ';
    const combined = ab_qt_fetchOne_(c.sym);

    if (!combined.quarterOk && !combined.tagsOk) {
      summary.failed++;
      const err = combined.quarterError || combined.tagsError || 'no data';
      if (AB_QT_SKIP_RETRY_ON.test(err)) consecutiveTransportFails++;
      if (ab_qt_isDefinitiveError_(err)) {
        unfillable[c.sym] = (unfillable[c.sym] || 0) + 1;
        unfillableChanged = true;
      }
      if (summary.errors.length < 25) summary.errors.push(c.sym + ': ' + err);
      if (AB_QR_VERBOSE) Logger.log(posn + c.sym + '  FAILED - ' + err);
    } else {
      consecutiveTransportFails = 0;
      if (unfillable[c.sym]) { delete unfillable[c.sym]; unfillableChanged = true; }
      summary.updated++;
      summary.newlyFilled += ab_qt_writeRow_(layout, cols, c.rowIdx, combined);

      const g = combined.growth;
      const basis = g && g.basis;
      if (basis && basis.indexOf('Consolidated') === -1) {
        summary.standalone.push(c.sym + ' (' + basis + ')');
      }
      if (g && g.shortHistory) {
        tooNew[c.sym] = Date.now() + AB_QT_TOONEW_RECHECK_DAYS * 86400000;
        tooNewChanged = true;
        summary.parkedTooNew.push(c.sym);
      } else if (tooNew[c.sym]) {
        delete tooNew[c.sym];
        tooNewChanged = true;
      }

      if (AB_QR_VERBOSE) {
        const gLine = combined.quarterOk
          ? ('QoQ ' + g.qoqRev + '/' + g.qoqNp + '  YoY ' + g.yoyRev + '/' + g.yoyNp +
             '  EPS ttm ' + g.ttmEps + '/' + g.lastFyEps)
          : ('quarterly: ' + combined.quarterError);
        const tLine = combined.tagsOk
          ? ('tags: OPM ' + combined.tags.opmQoQ + '/' + combined.tags.opmYoY +
             '  Promoter ' + combined.tags.promoter + '  FII ' + combined.tags.fii)
          : ('tags: ' + combined.tagsError);
        Logger.log(posn + c.sym + '  ' + gLine + '  |  ' + tLine);
      }
    }

    if ((i + 1) % AB_QT_BATCH_SIZE === 0 || i === slice.length - 1) {
      try {
        SpreadsheetApp.flush();
        SpreadsheetApp.getActiveSpreadsheet().toast(
          (cursor + processed) + '/' + candidates.length + ' · last: ' + c.sym,
          'Quarterly + Trend Tags', 5);
      } catch (uiErr) {
        // No spreadsheet UI (e.g. run from the editor) - the log still shows progress.
      }
    }
    if (i < slice.length - 1) ab_qtPause_(AB_QT_SEQ_SPACING_MS);
  }

  if (unfillableChanged) ab_qt_saveUnfillable_(unfillable);
  if (tooNewChanged) ab_qt_saveTooNew_(tooNew);
  if (!summary.throttled) props.deleteProperty(AB_QT_COOLDOWN_PROP);

  if (mode === 'all') {
    const next = cursor + processed;
    if (!summary.done && next < candidates.length) {
      props.setProperty(cursorKey, String(next));
      summary.nextCursor = next;
    } else {
      props.deleteProperty(cursorKey);
      summary.done = true;
    }
  }
  return summary;
}

/**
 * On-demand refresh for named symbols - forces a re-fetch and
 * OVERWRITES whatever is there. Also clears the symbol from the
 * parked/unfillable lists.
 *
 * A pasted list has no upper bound - a 130-symbol paste at roughly
 * 1.5-2s/symbol (fetch + politeness sleep, sometimes a second fetch for
 * the standalone fallback) can comfortably exceed Apps Script's 6-minute
 * hard execution cap, and unlike a killed 'missing'/'all' pass - whose
 * progress is at least findable by re-running 'missing' afterwards - a
 * hard-killed named-list run gives back NOTHING: no summary, no "still
 * to do" list, nothing. So this stops itself early, well inside the cap,
 * and hands back the untouched symbols so the SAME menu prompt can be
 * re-run with exactly that shorter list pasted back in. (Symbols already
 * written to the sheet before the stop are safe either way - a
 * setValue() call takes effect immediately, it doesn't need the run to
 * finish or a flush() to become durable.)
 */
function ab_qt_refreshForSymbols_(symbols) {
  if (ab_screenerPauseMin_()) {
    return { requested: (symbols || []).length, updated: 0, failed: 0,
             lines: ['Not run - ' + ab_screenerPauseText_() + '.'], remaining: (symbols || []).slice() };
  }
  const layout = ab_getMainLayout_();
  const cols = {
    promoter: ab_qt_findCol_(layout.header, AB_TT_PROMOTER_HEADER),
    fii: ab_qt_findCol_(layout.header, AB_TT_FII_HEADER),
    opmYoY: ab_qt_findCol_(layout.header, AB_TT_OPM_YOY_HEADER),
    opmQoQ: ab_qt_findCol_(layout.header, AB_TT_OPM_QOQ_HEADER)
  };
  const wanted = {};
  (symbols || []).forEach(function (s) {
    const k = ab_cellText_(s).toUpperCase();
    if (k) wanted[k] = [];
  });
  if (!Object.keys(wanted).length) return { requested: 0, updated: 0, failed: 0, lines: [], remaining: [] };

  const data = layout.data;
  for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
    const sym = ab_cellText_(data[r][layout.symbol]).toUpperCase();
    const name = ab_cellText_(data[r][layout.name]);
    if (!sym && !name) break;
    if (sym && wanted[sym]) wanted[sym].push(r);
  }

  const syms = Object.keys(wanted);
  const out = { requested: syms.length, updated: 0, failed: 0, lines: [], remaining: [] };
  const unfillable = ab_qt_getUnfillable_();
  let unfillableChanged = false;
  const tooNew = ab_qt_getTooNew_();
  let tooNewChanged = false;
  const failedSyms = [];
  const startedAt = Date.now();

  for (let i = 0; i < syms.length; i++) {
    if (Date.now() - startedAt > AB_QT_TIME_BUDGET_MS) {
      out.remaining = syms.slice(i);
      out.lines.push('Stopped at ' + i + '/' + syms.length +
                     ' to stay under the execution time limit - paste the remaining ' +
                     'symbols back in and run this menu item again.');
      Logger.log('Combined refresh: time budget reached after ' + i + '/' + syms.length + ' symbols.');
      break;
    }

    const sym = syms[i];
    const rows = wanted[sym];
    const combined = ab_qt_fetchOne_(sym);

    if (!combined.quarterOk && !combined.tagsOk) {
      out.failed++;
      const err = combined.quarterError || combined.tagsError || 'no data';
      out.lines.push(sym + ': FAILED - ' + err);
      failedSyms.push(sym);
      if (ab_qt_isDefinitiveError_(err)) {
        unfillable[sym] = (unfillable[sym] || 0) + 1;
        unfillableChanged = true;
      }
    } else {
      if (unfillable[sym]) { delete unfillable[sym]; unfillableChanged = true; }
      const g = combined.growth;
      if (g && g.shortHistory) {
        tooNew[sym] = Date.now() + AB_QT_TOONEW_RECHECK_DAYS * 86400000;
        tooNewChanged = true;
      } else if (tooNew[sym]) {
        delete tooNew[sym];
        tooNewChanged = true;
      }
      rows.forEach(function (rowIdx) { ab_qt_writeRow_(layout, cols, rowIdx, combined); });
      out.updated++;
      const gLine = combined.quarterOk
        ? ('QoQ ' + g.qoqRev + '/' + g.qoqNp + ' YoY ' + g.yoyRev + '/' + g.yoyNp +
           ' EPS ttm ' + g.ttmEps + '/' + g.lastFyEps)
        : ('quarterly: ' + combined.quarterError);
      const tLine = combined.tagsOk
        ? ('OPM ' + combined.tags.opmQoQ + '/' + combined.tags.opmYoY +
           ' Promoter ' + combined.tags.promoter + ' FII ' + combined.tags.fii)
        : ('tags: ' + combined.tagsError);
      out.lines.push(sym + ': ' + gLine + ' | ' + tLine);
    }

    // Push writes out and show progress periodically on a long paste -
    // same cadence the bulk driver uses, so a big list isn't silent for
    // minutes at a time.
    if ((i + 1) % AB_QT_BATCH_SIZE === 0 || i === syms.length - 1) {
      try {
        SpreadsheetApp.flush();
        SpreadsheetApp.getActiveSpreadsheet().toast(
          (i + 1) + '/' + syms.length + ' · last: ' + sym, 'Quarterly + Trend Tags', 5);
      } catch (uiErr) {
        // No spreadsheet UI - the log still shows progress.
      }
    }
    if (i < syms.length - 1) ab_qtPause_(AB_QT_SEQ_SPACING_MS);
  }

  if (unfillableChanged) ab_qt_saveUnfillable_(unfillable);
  if (tooNewChanged) ab_qt_saveTooNew_(tooNew);
  // Anything that failed is worth another go too - most failures here
  // are transient network errors, not "this symbol doesn't exist".
  out.remaining = failedSyms.concat(out.remaining);
  return out;
}

function ab_qt_summaryText_(s) {
  if (s.cooldownMin && ab_screenerPauseMin_()) return 'Skipped - ' + ab_screenerPauseText_() + '.';
  if (s.cooldownMin) {
    return 'Skipped - screener refused us recently, so combined passes are paused for another ' +
           s.cooldownMin + ' min. Refreshing a named symbol still works.';
  }
  let msg = s.updated + ' updated, ' + s.failed + ' failed (of ' + s.requested + ' checked).';
  if (s.skipped) msg += ' ' + s.skipped + ' skipped (no data on screener).';
  if (s.skippedTooNew) {
    msg += ' ' + s.skippedTooNew + ' skipped (listed recently - waiting for a year of quarters).';
  }
  if (s.parkedTooNew && s.parkedTooNew.length) {
    msg += ' Parked as too new: ' + s.parkedTooNew.slice(0, 15).join(', ') +
           (s.parkedTooNew.length > 15 ? ' +' + (s.parkedTooNew.length - 15) + ' more' : '') + '.';
  }
  if (s.throttled) {
    msg += ' THROTTLED - screener stopped answering, so the run gave up early. ' +
           'Leave it an hour or two and run again; nothing was lost.';
  }
  if (s.standalone.length) {
    msg += ' STANDALONE (not consolidated): ' + s.standalone.slice(0, 15).join(', ') +
           (s.standalone.length > 15 ? ' +' + (s.standalone.length - 15) + ' more' : '') + '.';
  }
  if (s.errors.length) msg += ' Errors: ' + s.errors.join('; ') + '.';
  if (!s.done) {
    msg += s.nextCursor
      ? (' STOPPED EARLY at ' + s.nextCursor + '/' + s.total + ' - run again to continue.')
      : (' STOPPED EARLY - ' + s.total + ' still need filling; run again to continue.');
  }
  return msg;
}

/** Menu: fill only rows never yet attempted (all ten cells still blank) -
 *  rows with even one cell filled are left alone, since many blanks
 *  (short shareholding history, too-new-for-YoY) are permanent, not
 *  "still to do". Use the Backfill ALL item for a deliberate full
 *  re-check regardless of what's already filled in. */
function runQuarterlyTrendMissing() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Filling rows never yet attempted (Quarterly Results + Trend Tags)...');
  try {
    const s = ab_qt_updateQuarterlyAndTrendTags_('missing');
    logRun_(Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm'), '', s.updated,
            'OK (quarterly+trend, missing)', ab_qt_summaryText_(s));
    ss.toast(ab_qt_summaryText_(s));
  } catch (e) {
    ss.toast('Quarterly + Trend Tags update failed: ' + e.message);
  }
}

/** Menu: refresh EVERY symbol for both engines together (resumable). */
function runQuarterlyTrendBackfill() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Backfilling Quarterly Results + Trend Tags together (resumable)...');
  try {
    const s = ab_qt_updateQuarterlyAndTrendTags_('all');
    logRun_(Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm'), '', s.updated,
            'OK (quarterly+trend, backfill)', ab_qt_summaryText_(s));
    ss.toast(ab_qt_summaryText_(s));
  } catch (e) {
    ss.toast('Quarterly + Trend Tags backfill failed: ' + e.message);
  }
}

/** Menu: refresh just the rows you've selected, for both engines. */
function runQuarterlyTrendForSelection() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const layout = ab_getMainLayout_();
    const sel = layout.sheet.getActiveRangeList();
    if (!sel) { ss.toast('Select one or more rows in Main first.'); return; }
    const syms = [];
    sel.getRanges().forEach(function (rg) {
      const start = rg.getRow(), n = rg.getNumRows();
      for (let r = start; r < start + n; r++) {
        const v = ab_cellText_(layout.sheet.getRange(r, layout.symbol + 1).getValue()).toUpperCase();
        if (v && syms.indexOf(v) === -1) syms.push(v);
      }
    });
    if (!syms.length) { ss.toast('No symbols found in the selection.'); return; }
    ss.toast('Updating Quarterly + Trend Tags for ' + syms.length + ' symbol(s)...');
    const s = ab_qt_refreshForSymbols_(syms);
    let toastMsg = s.updated + ' updated, ' + s.failed + ' failed.\n' + s.lines.slice(0, 5).join('\n');
    if (s.remaining && s.remaining.length) {
      toastMsg += '\n\n' + s.remaining.length + ' still to do - select those rows and run again.';
    }
    ss.toast(toastMsg, 'Quarterly + Trend Tags (selection)', 30);
    logRun_(Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm'), '', s.updated,
            'OK (quarterly+trend, selection)', s.updated + ' updated, ' + s.failed + ' failed. ' + s.lines.join(' ; ') +
            (s.remaining && s.remaining.length ? ' | STILL TO DO: ' + s.remaining.join(', ') : ''));
  } catch (e) {
    ss.toast('Quarterly + Trend Tags (selection) failed: ' + e.message);
  }
}

/** Menu: paste a symbol list, refresh just those for both engines. */
function runQuarterlyTrendForSymbolPrompt() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let ui;
  try {
    ui = SpreadsheetApp.getUi();
  } catch (e) {
    Logger.log('No UI available - call ab_qt_refreshForSymbols_ directly instead.');
    return;
  }
  const answer = ui.prompt('Update Quarterly Results + Trend Tags',
    'Symbol(s) to update - paste one per line or comma-separated ' +
    '(e.g. JGCHEM, NAUKRI, ATHERENERG):', ui.ButtonSet.OK_CANCEL);
  if (answer.getSelectedButton() !== ui.Button.OK) return;

  const symbols = String(answer.getResponseText() || '')
    .split(/[,\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  if (!symbols.length) { ss.toast('No symbols entered.'); return; }

  ss.toast('Updating Quarterly + Trend Tags for ' + symbols.length + ' symbol(s)...');
  const s = ab_qt_refreshForSymbols_(symbols);

  // A big paste can run into Apps Script's 6-minute execution cap before
  // finishing. Hand back exactly the unfinished symbols, ready to paste
  // straight into this same box, so a resume never re-does work that's
  // already been written.
  let body = s.updated + ' updated, ' + s.failed + ' failed of ' +
             s.requested + ' requested.\n\n' + s.lines.join('\n');
  if (s.remaining && s.remaining.length) {
    body += '\n\n--- ' + s.remaining.length + ' still to do - copy the line below ' +
            'and run this menu item again ---\n' + s.remaining.join(', ');
  }
  ui.alert('Quarterly + Trend Tags Update', body || 'Nothing updated.', ui.ButtonSet.OK);
  logRun_(Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm'), '', s.updated,
          'OK (quarterly+trend, prompt)', s.updated + ' updated, ' + s.failed + ' failed. ' + s.lines.join(' ; ') +
          (s.remaining && s.remaining.length
            ? ' | STILL TO DO: ' + s.remaining.join(', ') : ''));
}

/*****************************************************************
 * RESULTS DAY - QUARTERLY + TREND TAGS, VERIFIED BY QUARTER
 * -----------------------------------------------------------------
 * Runs ONCE a day (~6 PM IST by default) and, for every
 * company whose Result Date (Main, fed live from the Results sheet) is
 * today or in the last AB_RS_MAX_WAIT_DAYS days:
 *
 *   1. Works out WHICH quarter that result date is for - the latest
 *      quarter-end strictly before it. A result date of 08/10/2026 is
 *      for "Sep 2026"; 15/01/2027 would be for "Dec 2026". (Override
 *      with AB_RS_TARGET_QUARTER in the Control Panel if ever needed.)
 *   2. Fetches the company's screener.in page ONCE (the same combined
 *      Quarterly + Trend Tags fetch the menu items use) and reads the
 *      newest quarter screener actually has figures for.
 *   3. Only if screener's newest quarter IS that quarter (or later):
 *      writes the Quarterly Results + Trend Tag columns and ticks the
 *      row's Checkbox. If screener is still showing an older quarter
 *      (it often lags the company's filing by a day or more), NOTHING
 *      is written and the box stays unticked - the company stays on
 *      the list and is re-checked on every following run until
 *      screener catches up, or until AB_RS_MAX_WAIT_DAYS have passed.
 *
 * State lives in a visible "Results Tracker" tab (one row per company
 * per quarter: Pending / Updated / Gave up, what screener showed, how
 * many checks, when). That's what makes "carry it over to the next
 * day's run" work, and it means you can always see exactly where each
 * company stands without opening the logs. It never relies on the
 * Checkbox to decide what's done - a box ticked by hand last season
 * won't make a company get skipped this season.
 *
 * After each run, one email: what got updated in Main today (with the
 * actual figures), who's announced but screener hasn't caught up yet,
 * and every watchlist company due to report in the next
 * AB_RS_UPCOMING_DAYS days, by date.
 *
 * A heavy results day (100+ companies) won't fit in one 6-minute Apps
 * Script execution, so a run that hits its time budget schedules a
 * continuation of itself a minute later (up to AB_RS_MAX_CONTINUATIONS
 * times) and only sends the email once the whole list is done.
 *****************************************************************/
const AB_RS_TRACKER_SHEET = 'Results Tracker';
// One run a day (user's choice, 09-Oct-2026 - was ~5 PM + ~11:30 PM).
const AB_RS_DAILY_HOUR = ab_setting_('AB_RS_DAILY_HOUR', 18);
const AB_RS_DAILY_MIN = ab_setting_('AB_RS_DAILY_MIN', 0);
const AB_RS_MAX_WAIT_DAYS = ab_setting_('AB_RS_MAX_WAIT_DAYS', 21);
const AB_RS_UPCOMING_DAYS = ab_setting_('AB_RS_UPCOMING_DAYS', 15);
const AB_UPCOMING_RESULTS_ON = ab_setting_('AB_UPCOMING_RESULTS_ON', 1);
const AB_UPCOMING_RESULTS_HOUR = ab_setting_('AB_UPCOMING_RESULTS_HOUR', 6);
const AB_UPCOMING_RESULTS_MIN = ab_setting_('AB_UPCOMING_RESULTS_MIN', 0);
const AB_RS_TARGET_QUARTER = ab_setting_('AB_RS_TARGET_QUARTER', '');
const AB_RS_MAX_CONTINUATIONS = 4;
// Pauses before each retry round for requests screener refused, and the
// gap between retried requests (slower than the main pass on purpose).
const AB_RS_RETRY_WAITS_MS = [15000, 30000, 45000];
const AB_RS_RETRY_SPACING_MS = 3000;
// Extra automatic runs later the same day when screener blocks the daily
// run. Switched OFF (empty) - the user wants exactly one run a day; a
// blocked company simply stays pending for the next day's run. Put e.g.
// [45, 90] back to re-enable retries 45 and 90 minutes later.
const AB_RS_THROTTLE_RETRY_MIN = [];
const AB_RS_THROTTLE_PROP = 'AB_RS_THROTTLE_RETRIES';
const AB_RS_CONT_PROP = 'AB_RS_CONTINUATION';
const AB_RS_RUNNING_PROP = 'AB_RS_RUNNING_SINCE';
const AB_RS_RUNNING_STALE_MS = 8 * 60 * 1000;
const AB_RS_KEEP_DAYS = 180;          // finished tracker rows older than this are pruned
const AB_RS_UPCOMING_MAX_ROWS = 400;  // email size guard
const AB_RS_MAX_HTML_CHARS = 150000;  // same MailApp body-size guard as Quality Watch
const AB_RS_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const AB_RS_HEADERS = ['Symbol', 'Company', 'Result Date', 'Quarter Expected', 'Status',
  'Screener Latest Quarter', 'Checks', 'First Checked', 'Last Checked', 'Updated At', 'Note'];
const AB_RS_TS_FMT = 'dd/MM/yyyy HH:mm';
// Which results season (quarter) the Checkbox column currently reflects.
// When the season rolls over (e.g. Sep 2026 -> Dec 2026 on 1 Jan) every
// tick is cleared once, so a tick always means "updated for THIS season".
const AB_RS_SEASON_PROP = 'AB_RS_SEASON';

/* ---------- small date / quarter helpers ---------- */

function ab_rsMonthIdx_(txt) {
  const t = String(txt || '').slice(0, 3).toLowerCase();
  for (let i = 0; i < 12; i++) if (AB_RS_MONTHS[i].toLowerCase() === t) return i;
  return -1;
}

/** "Sep 2026" -> 2026*12+9, comparable across years. NaN if not a "Mon YYYY" label. */
function ab_rsQuarterIndex_(label) {
  const m = String(label || '').trim().match(/^([A-Za-z]{3})[A-Za-z]*\.?\s*'?(\d{2}|\d{4})$/);
  if (!m) return NaN;
  const mi = ab_rsMonthIdx_(m[1]);
  if (mi === -1) return NaN;
  let y = Number(m[2]);
  if (y < 100) y += 2000;
  return y * 12 + mi + 1;
}

function ab_rsQuarterLabel_(idx) {
  const y = Math.floor((idx - 1) / 12);
  return AB_RS_MONTHS[(idx - 1) - y * 12] + ' ' + y;
}

/** Control Panel override, tolerant of Sheets turning "Sep 2026" into a date. */
function ab_rsTargetQuarter_() {
  const raw = AB_SETTINGS_['AB_RS_TARGET_QUARTER'];
  if (raw instanceof Date && !isNaN(raw.getTime())) return Utilities.formatDate(raw, AB_TZ, 'MMM yyyy');
  const idx = ab_rsQuarterIndex_(AB_RS_TARGET_QUARTER);
  return isNaN(idx) ? '' : ab_rsQuarterLabel_(idx);
}

/** The quarter a result date reports on: the latest quarter-end strictly before it. */
function ab_rsExpectedQuarter_(d) {
  const forced = ab_rsTargetQuarter_();
  if (forced) return forced;
  const y = Number(Utilities.formatDate(d, AB_TZ, 'yyyy'));
  const m = Number(Utilities.formatDate(d, AB_TZ, 'M'));
  const qm = Math.floor((m - 1) / 3) * 3; // 0, 3, 6 or 9
  return qm === 0 ? ('Dec ' + (y - 1)) : (AB_RS_MONTHS[qm - 1] + ' ' + y);
}

/** Noon IST on a calendar day - noon so no timezone shift can move it to another day. */
function ab_rsMakeDate_(y, monthIdx, day) {
  return Utilities.parseDate(y + '-' + ('0' + (monthIdx + 1)).slice(-2) + '-' + ('0' + day).slice(-2) + ' 12:00',
                             AB_TZ, 'yyyy-MM-dd HH:mm');
}

/** Sheet cell -> Date. Accepts real dates, "08-Oct-26", "08 Oct 2026" and "08/10/2026". */
function ab_rsToDate_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const s = String(v === null || v === undefined ? '' : v).trim();
  if (!s) return null;
  let m = s.match(/^(\d{1,2})[-\s\/.]([A-Za-z]{3,9})[-\s\/.,]*(\d{2}|\d{4})$/);
  if (m) {
    const mi = ab_rsMonthIdx_(m[2]);
    if (mi === -1) return null;
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    return ab_rsMakeDate_(y, mi, Number(m[1]));
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return ab_rsMakeDate_(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return null;
}

function ab_rsDayKey_(d) { return Utilities.formatDate(d, AB_TZ, 'yyyy-MM-dd'); }

/** Whole days from one yyyy-MM-dd key to another (positive when `toKey` is later). */
function ab_rsDaysBetween_(fromKey, toKey) {
  const a = String(fromKey).split('-').map(Number), b = String(toKey).split('-').map(Number);
  return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000);
}

function ab_rsKeyToDmy_(key) {
  const p = String(key || '').split('-');
  return p.length === 3 ? (p[2] + '/' + p[1] + '/' + p[0]) : '';
}

function ab_rsDmyToKey_(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? (m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2)) : '';
}

/** "Fri, 09 Oct 2026" for a yyyy-MM-dd key. */
function ab_rsPrettyDay_(key) {
  const p = String(key).split('-').map(Number);
  return Utilities.formatDate(ab_rsMakeDate_(p[0], p[1] - 1, p[2]), AB_TZ, 'EEE, dd MMM yyyy');
}

function ab_rsParseTs_(s) {
  if (!s) return 0;
  try { return Utilities.parseDate(String(s), AB_TZ, AB_RS_TS_FMT).getTime(); } catch (e) { return 0; }
}

function ab_rsEsc_(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---------- Results Tracker tab ---------- */

function ab_rsReadTracker_() {
  const sh = ab_getOrCreateSheet_(AB_RS_TRACKER_SHEET);
  const vals = sh.getDataRange().getDisplayValues();
  const list = [], byKey = {};
  for (let r = 1; r < vals.length; r++) {
    const v = vals[r];
    const sym = String(v[0] || '').trim().toUpperCase();
    if (!sym) continue;
    const t = {
      symbol: sym, company: String(v[1] || ''), rdKey: ab_rsDmyToKey_(v[2]),
      quarter: String(v[3] || '').trim(), status: String(v[4] || '').trim() || 'Pending',
      latest: String(v[5] || ''), checks: Number(v[6]) || 0,
      first: String(v[7] || ''), last: String(v[8] || ''), updatedAt: String(v[9] || ''),
      note: String(v[10] || '')
    };
    const key = sym + '|' + t.quarter.toUpperCase();
    if (byKey[key]) continue; // a hand-made duplicate - first one wins
    byKey[key] = t;
    list.push(t);
  }
  return { sheet: sh, list: list, byKey: byKey };
}

function ab_rsWriteTracker_(tr) {
  const sh = tr.sheet;
  const order = { 'Pending': 0, 'Updated': 1, 'Gave up': 2 };
  const rank = function (t) { return order[t.status] !== undefined ? order[t.status] : 3; };
  const rows = tr.list.slice().sort(function (a, b) {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.status === 'Pending') {
      if (a.rdKey !== b.rdKey) return a.rdKey < b.rdKey ? -1 : 1;
      return a.symbol < b.symbol ? -1 : 1;
    }
    const d = ab_rsParseTs_(b.updatedAt || b.last) - ab_rsParseTs_(a.updatedAt || a.last);
    if (d) return d;
    return a.symbol < b.symbol ? -1 : 1;
  });

  const out = [AB_RS_HEADERS];
  rows.forEach(function (t) {
    out.push([t.symbol, t.company || '', ab_rsKeyToDmy_(t.rdKey), t.quarter, t.status, t.latest || '',
              String(t.checks || 0), t.first || '', t.last || '', t.updatedAt || '', t.note || '']);
  });

  const w = AB_RS_HEADERS.length;
  sh.clearContents();
  // Plain text throughout, so dates/quarters read back exactly as written
  // instead of Sheets "helpfully" turning "Sep 2026" into a date.
  sh.getRange(1, 1, out.length, w).setNumberFormat('@').setValues(out);
  sh.getRange(1, 1, 1, w).setFontWeight('bold').setBackground('#1f3a5f').setFontColor('#ffffff');
  sh.setFrozenRows(1);

  const maxRows = sh.getMaxRows();
  if (maxRows > 1) sh.getRange(2, 5, maxRows - 1, 1).setBackground(null);
  if (rows.length) {
    sh.getRange(2, 5, rows.length, 1).setBackgrounds(rows.map(function (t) {
      return [t.status === 'Updated' ? '#d9f2e3' : t.status === 'Pending' ? '#fff4d6' : '#eeeeee'];
    }));
  }
}

/* ---------- new-season Checkbox reset ---------- */

/**
 * Unticks every ticked Checkbox in Main, then re-ticks the rows whose
 * company the Results Tracker already shows as Updated for `season` -
 * so a reset can never wipe out a tick that's genuinely earned this
 * season (e.g. a manual reset after the 5 PM run already ticked TCS).
 * Uses check()/uncheck() on just the affected cells rather than
 * rewriting the whole column, so nothing else in column A is touched.
 */
function ab_rsResetCheckboxes_(layout, tr, season, rowsBySym) {
  const colIdx = layout.qrCheckbox;
  if (colIdx === -1) return { cleared: 0, reticked: 0 };
  const colLetter = ab_colToLetter_(colIdx + 1);
  const data = layout.data;

  const keep = {};
  tr.list.forEach(function (t) {
    if (t.status === 'Updated' && t.quarter.toUpperCase() === String(season).toUpperCase()) {
      (rowsBySym[t.symbol] || []).forEach(function (r) { keep[r] = true; });
    }
  });

  const toClear = [], toTick = [];
  for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
    const ticked = data[r][colIdx] === true;
    if (ticked && !keep[r]) toClear.push(colLetter + (r + 1));
    if (!ticked && keep[r]) toTick.push(colLetter + (r + 1));
  }
  const apply = function (a1s, fn) {
    for (let i = 0; i < a1s.length; i += 400) {
      const rl = layout.sheet.getRangeList(a1s.slice(i, i + 400));
      if (fn === 'check') rl.check(); else rl.uncheck();
    }
  };
  apply(toClear, 'uncheck');
  apply(toTick, 'check');
  // Keep the in-memory copy in step, so later reads in this run agree.
  toClear.forEach(function (a1) { data[Number(a1.slice(colLetter.length)) - 1][colIdx] = false; });
  toTick.forEach(function (a1) { data[Number(a1.slice(colLetter.length)) - 1][colIdx] = true; });
  return { cleared: toClear.length, reticked: toTick.length };
}

/** Menu: clear the Checkbox column now for the current results season. */
function runResultsSeasonResetNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const season = ab_rsExpectedQuarter_(new Date());
  try {
    const ui = SpreadsheetApp.getUi();
    const ans = ui.alert('Start results season ' + season + '?',
      'This unticks every Checkbox in Main, except companies the Results Tracker already shows as ' +
      'updated for ' + season + '. It also happens automatically on the first run of each new season.',
      ui.ButtonSet.YES_NO);
    if (ans !== ui.Button.YES) return;
  } catch (e) {
    // No UI (run from the editor) - go ahead.
  }
  try {
    const layout = ab_getMainLayout_();
    const rowsBySym = {};
    for (let r = layout.headerRowIdx + 1; r < layout.data.length; r++) {
      const sym = ab_cellText_(layout.data[r][layout.symbol]).toUpperCase();
      const name = ab_cellText_(layout.data[r][layout.name]);
      if (!sym && !name) break;
      if (sym) (rowsBySym[sym] = rowsBySym[sym] || []).push(r);
    }
    const r = ab_rsResetCheckboxes_(layout, ab_rsReadTracker_(), season, rowsBySym);
    PropertiesService.getScriptProperties().setProperty(AB_RS_SEASON_PROP, season);
    ss.toast('Season ' + season + ': cleared ' + r.cleared + ' tick(s)' +
             (r.reticked ? ', re-ticked ' + r.reticked + ' already updated this season' : '') + '.', 'Results Day', 15);
  } catch (e) {
    ss.toast('Checkbox reset failed: ' + e.message);
  }
}

/* ---------- Results calendar (for the "upcoming" list) ---------- */

function ab_rsReadCalendar_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AB_RESULTS_SHEET);
  if (!sh) return [];
  const data = sh.getDataRange().getValues();
  let h = -1, cSym = -1, cDate = -1, cCo = -1, cPur = -1;
  for (let r = 0; r < Math.min(10, data.length); r++) {
    const row = data[r].map(function (v) { return String(v).trim().toUpperCase(); });
    if (row.indexOf('SYMBOL') !== -1 && row.indexOf('DATE') !== -1) {
      h = r; cSym = row.indexOf('SYMBOL'); cDate = row.indexOf('DATE');
      cCo = row.indexOf('COMPANY'); cPur = row.indexOf('PURPOSE');
      break;
    }
  }
  if (h === -1) return [];
  const out = [];
  for (let r = h + 1; r < data.length; r++) {
    const sym = String(data[r][cSym] || '').trim().toUpperCase();
    if (!sym) continue;
    const d = ab_rsToDate_(data[r][cDate]);
    if (!d) continue;
    out.push({
      symbol: sym,
      company: cCo !== -1 ? String(data[r][cCo] || '').trim() : '',
      purpose: cPur !== -1 ? String(data[r][cPur] || '').trim() : '',
      dayKey: ab_rsDayKey_(d)
    });
  }
  return out;
}

/* ---------- the run ---------- */

/**
 * Entry point for triggers, the menu and continuations. Guards against
 * two runs overlapping (e.g. a manual click while the 5 PM run is still
 * going) with a "running since" marker that goes stale after 8 minutes,
 * so a crashed run can never block the next one for long.
 */
function ab_rsRun_(slotLabel, isContinuation) {
  if (!isContinuation) ab_ensureResultDateReal_();
  if (!AB_BRIDGE_ONLY && ab_screenerPauseMin_()) {
    Logger.log('Results Day check skipped - ' + ab_screenerPauseText_() + '.');
    return { skipped: true, paused: true };
  }
  const props = PropertiesService.getScriptProperties();
  const since = Number(props.getProperty(AB_RS_RUNNING_PROP) || 0);
  if (since && Date.now() - since < AB_RS_RUNNING_STALE_MS) {
    Logger.log('Results Day check: another run started ' + Math.round((Date.now() - since) / 1000) +
               's ago and is still going - skipping this one.');
    return { skipped: true };
  }
  props.setProperty(AB_RS_RUNNING_PROP, String(Date.now()));
  try {
    return ab_rsRunCore_(slotLabel, isContinuation);
  } finally {
    props.deleteProperty(AB_RS_RUNNING_PROP);
  }
}

function ab_rsRunCore_(slotLabel, isContinuation) {
  const startedAt = Date.now();
  const props = PropertiesService.getScriptProperties();

  let cont = null;
  if (isContinuation) {
    try { cont = JSON.parse(props.getProperty(AB_RS_CONT_PROP) || 'null'); } catch (e) { cont = null; }
  }
  if (!cont) {
    props.deleteProperty(AB_RS_CONT_PROP);
    cont = { runStart: startedAt, count: 0, slot: slotLabel || 'Manual run', checked: 0, failed: 0 };
  }
  const runStartFloor = Math.floor(cont.runStart / 60000) * 60000;
  const nowStr = function () { return Utilities.formatDate(new Date(), AB_TZ, AB_RS_TS_FMT); };
  const todayKey = ab_rsDayKey_(new Date());

  const layout = ab_getMainLayout_();
  if (layout.resultDate === -1) throw new Error('Main has no "Result Date" column.');
  if (layout.qrCheckbox === -1) throw new Error('Main has no "Checkbox" column to tick.');
  const cols = {
    promoter: ab_qt_findCol_(layout.header, AB_TT_PROMOTER_HEADER),
    fii: ab_qt_findCol_(layout.header, AB_TT_FII_HEADER),
    opmYoY: ab_qt_findCol_(layout.header, AB_TT_OPM_YOY_HEADER),
    opmQoQ: ab_qt_findCol_(layout.header, AB_TT_OPM_QOQ_HEADER)
  };

  // Every Main row per symbol (a symbol can sit on more than one row).
  const data = layout.data;
  const rowsBySym = {}, infoBySym = {};
  for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
    const sym = ab_cellText_(data[r][layout.symbol]).toUpperCase();
    const name = ab_cellText_(data[r][layout.name]);
    if (!sym && !name) break;
    if (!sym) continue;
    (rowsBySym[sym] = rowsBySym[sym] || []).push(r);
    if (!infoBySym[sym]) infoBySym[sym] = { name: name, rd: ab_rsToDate_(data[r][layout.resultDate]) };
  }

  // 1. Add anyone whose result date is today or within the wait window.
  const tr = ab_rsReadTracker_();
  Object.keys(infoBySym).forEach(function (sym) {
    const rd = infoBySym[sym].rd;
    if (!rd) return;
    const rdKey = ab_rsDayKey_(rd);
    const age = ab_rsDaysBetween_(rdKey, todayKey);
    if (age < 0 || age > AB_RS_MAX_WAIT_DAYS) return;
    const q = ab_rsExpectedQuarter_(rd);
    const key = sym + '|' + q.toUpperCase();
    const t = tr.byKey[key];
    if (!t) {
      const nt = { symbol: sym, company: infoBySym[sym].name, rdKey: rdKey, quarter: q, status: 'Pending',
                   latest: '', checks: 0, first: '', last: '', updatedAt: '', note: '' };
      tr.byKey[key] = nt;
      tr.list.push(nt);
    } else if (t.status === 'Pending' && t.rdKey !== rdKey) {
      t.rdKey = rdKey; // calendar date changed
    }
  });

  // 2. Give up on anyone who's waited too long; prune old finished rows.
  tr.list = tr.list.filter(function (t) {
    const age = t.rdKey ? ab_rsDaysBetween_(t.rdKey, todayKey) : 0;
    if (t.status === 'Pending' && age > AB_RS_MAX_WAIT_DAYS) {
      t.status = 'Gave up';
      t.last = nowStr();
      t.note = 'Screener never showed ' + t.quarter + ' within ' + AB_RS_MAX_WAIT_DAYS +
               ' days of the result date' + (t.latest ? ' (last seen: ' + t.latest + ')' : '');
    }
    return !(t.status !== 'Pending' && age > AB_RS_KEEP_DAYS);
  });

  // 2b. New results season? Clear every Checkbox once (only on the
  //     first segment of a run, never mid-continuation), then re-tick
  //     anyone already confirmed for the new season.
  const season = ab_rsExpectedQuarter_(new Date());
  const seasonIdx = ab_rsQuarterIndex_(season);
  if (!isContinuation && props.getProperty(AB_RS_SEASON_PROP) !== season) {
    const r = ab_rsResetCheckboxes_(layout, tr, season, rowsBySym);
    props.setProperty(AB_RS_SEASON_PROP, season);
    cont.seasonReset = { to: season, cleared: r.cleared, reticked: r.reticked };
    Logger.log('Results Day: new season ' + season + ' - cleared ' + r.cleared + ' tick(s), re-ticked ' + r.reticked + '.');
  }

  // 3. Who to check now: still Pending, in Main, not already checked
  //    earlier in this same run (matters for continuations). Oldest
  //    result date first - they've waited longest.
  const cands = tr.list.filter(function (t) {
    if (t.status !== 'Pending') return false;
    if (!rowsBySym[t.symbol]) { t.note = 'Symbol not found in Main'; return false; }
    if (AB_BRIDGE_ONLY && !ab_bridgeGet_(t.symbol)) return false; // PC hasn't delivered it yet
    if (t.rdKey && ab_rsDaysBetween_(t.rdKey, todayKey) < 0) return false;
    if (ab_rsParseTs_(t.last) < runStartFloor) return true;
    // A continuation also gives anything screener refused earlier in this
    // run one more go (continuations are capped, so this can't loop).
    return !!isContinuation && /^Could not read screener/.test(t.note || '');
  }).sort(function (a, b) { return a.rdKey < b.rdKey ? -1 : a.rdKey > b.rdKey ? 1 : 0; });

  const res = { checked: 0, failed: 0, retried: 0, recovered: 0, updatedNow: [], throttled: false, outOfTime: false };
  let transportFails = 0;

  // One fetch + verdict for one company. Returns 'ok' (got a readable
  // page - updated, or screener still on an older quarter), 'transport'
  // (screener/network refused the request - worth retrying shortly), or
  // 'error' (page came back but unusable).
  const processOne = function (t, label) {
    const combined = ab_qt_fetchOne_(t.symbol);
    const stamp = nowStr();
    t.checks = (Number(t.checks) || 0) + 1;
    if (!t.first) t.first = stamp;
    t.last = stamp;
    let outcome = 'ok';

    if (!combined.quarterOk || !combined.growth) {
      const err = combined.quarterError || combined.tagsError || 'no data';
      outcome = (AB_QT_SKIP_RETRY_ON.test(err) || /HTTP 429|HTTP 5\d\d/.test(err)) ? 'transport' : 'error';
      t.note = 'Could not read screener (' + err + ') - will retry';
    } else {
      const latest = combined.growth.latestQuarter || '';
      t.latest = latest;
      const li = ab_rsQuarterIndex_(latest), ei = ab_rsQuarterIndex_(t.quarter);
      if (isNaN(li) || isNaN(ei)) {
        t.note = 'Unrecognised quarter label "' + latest + '" - will retry';
      } else if (li < ei) {
        t.note = 'Screener still shows ' + latest + ' - will retry';
      } else {
        // Screener has the quarter we're waiting for - write it and tick.
        // A straggler from the PREVIOUS season (e.g. a delayed Sep result
        // landing after the Dec season has started) still gets its
        // figures written, but no tick - ticks belong to the current season.
        const tickIt = isNaN(seasonIdx) || ei >= seasonIdx;
        rowsBySym[t.symbol].forEach(function (rowIdx) {
          ab_qt_writeRow_(layout, cols, rowIdx, combined);
          if (tickIt) layout.sheet.getRange(rowIdx + 1, layout.qrCheckbox + 1).setValue(true);
        });
        t.status = 'Updated';
        t.updatedAt = stamp;
        const notes = [];
        const basis = combined.growth.basis || '';
        if (basis && basis.indexOf('Consolidated') === -1) notes.push(basis + ' figures');
        if (!combined.tagsOk) notes.push('trend tags unavailable (' + combined.tagsError + ')');
        if (combined.growth.shortHistory) notes.push('under a year of history - no YoY');
        t.note = notes.join('; ');
        res.updatedNow.push(t.symbol);
      }
    }
    if (AB_QR_VERBOSE) Logger.log('Results Day ' + label + ' ' + t.symbol + ' expected ' + t.quarter + ' -> ' +
                                  t.status + (t.note ? ' (' + t.note + ')' : ''));
    return outcome;
  };

  try {
    // Main pass.
    const retryQueue = [];
    for (let i = 0; i < cands.length; i++) {
      if (Date.now() - startedAt > AB_QT_TIME_BUDGET_MS) { res.outOfTime = true; break; }
      if (transportFails >= AB_QT_ABORT_AFTER_FAILS) {
        res.throttled = true;
        props.setProperty(AB_QT_COOLDOWN_PROP, String(Date.now() + AB_QT_COOLDOWN_MS));
        Logger.log('Results Day check: screener refused ' + transportFails + ' requests in a row - stopping.');
        break;
      }
      const t = cands[i];
      const outcome = processOne(t, '[' + (i + 1) + '/' + cands.length + ']');
      res.checked++;
      if (outcome === 'transport') { transportFails++; retryQueue.push(t); }
      else { transportFails = 0; if (outcome === 'error') res.failed++; }
      if (i < cands.length - 1) ab_qtPause_(AB_QT_SEQ_SPACING_MS);
    }

    // Retry rounds for anything screener refused ("Address unavailable",
    // 429/5xx). Those refusals are intermittent - in the first live run
    // they alternated with successes request by request - so a pause and
    // a slower second (and third...) attempt usually gets through, rather
    // than leaving the company waiting until the next scheduled run.
    let queue = retryQueue;
    for (let round = 0; round < AB_RS_RETRY_WAITS_MS.length && queue.length && !res.throttled; round++) {
      const wait = AB_RS_RETRY_WAITS_MS[round];
      const need = wait + queue.length * (AB_RS_RETRY_SPACING_MS + 3000);
      if (Date.now() - startedAt + need > AB_QT_TIME_BUDGET_MS) {
        Logger.log('Results Day: not enough time left to retry ' + queue.length + ' refused request(s) - next run picks them up.');
        break;
      }
      Logger.log('Results Day: screener refused ' + queue.length + ' request(s) - retrying in ' +
                 Math.round(wait / 1000) + 's (round ' + (round + 1) + ' of ' + AB_RS_RETRY_WAITS_MS.length + ').');
      Utilities.sleep(wait);
      const next = [];
      for (let k = 0; k < queue.length; k++) {
        const t = queue[k];
        if (Date.now() - startedAt > AB_QT_TIME_BUDGET_MS) { next.push(t); continue; }
        res.retried++;
        const outcome = processOne(t, '[retry ' + (round + 1) + ']');
        if (outcome === 'transport') next.push(t);
        else { res.recovered++; if (outcome === 'error') res.failed++; }
        if (k < queue.length - 1) Utilities.sleep(AB_RS_RETRY_SPACING_MS);
      }
      queue = next;
    }
    res.failed += queue.length;
  } finally {
    // Always save progress, even if something above threw part-way.
    ab_rsWriteTracker_(tr);
    SpreadsheetApp.flush();
  }

  cont.checked += res.checked;
  cont.failed += res.failed;
  const notChecked = cands.length - res.checked;

  if (res.outOfTime && notChecked > 0 && cont.count < AB_RS_MAX_CONTINUATIONS) {
    cont.count++;
    props.setProperty(AB_RS_CONT_PROP, JSON.stringify(cont));
    ab_rsScheduleContinuation_();
    Logger.log('Results Day check: time budget reached, ' + notChecked + ' still to check - continuing in ~1 min.');
    return { continued: true, checked: cont.checked, remaining: notChecked, updatedNow: res.updatedNow };
  }
  props.deleteProperty(AB_RS_CONT_PROP);

  let retryAt = '';
  if (res.throttled) {
    // Stand the bulk screener passes down too - fewer requests from this
    // project is what gets screener to let us back in.
    props.setProperty(AB_QR_COOLDOWN_PROP, String(Date.now() + AB_QR_COOLDOWN_MS));
    retryAt = ab_rsScheduleThrottleRetry_(todayKey);
  }

  // Refresh the post-results performance tab first, so the email can
  // show each updated stock's move since its result date. Soft-fails -
  // a price-history hiccup must never cost you the results email.
  let perf = {};
  try {
    perf = ab_rpRefresh_({ layout: layout, cols: cols, tracker: tr }).byKey;
  } catch (pErr) {
    Logger.log('Results Performance refresh failed: ' + pErr.message);
  }

  const summary = ab_rsSendEmail_({
    layout: layout, cols: cols, tracker: tr, rowsBySym: rowsBySym, todayKey: todayKey,
    runStartFloor: runStartFloor, slot: cont.slot, checked: cont.checked, failed: cont.failed,
    notChecked: notChecked, throttled: res.throttled, retryAt: retryAt, seasonReset: cont.seasonReset || null, perf: perf,
    startedAt: startedAt,
    // An automatic retry only emails if it actually got something through.
    quietUnlessUpdated: /^Retry/.test(cont.slot || '')
  });
  logRun_(Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm'), '', summary.updatedToday,
          'OK (results day - ' + cont.slot + ')', summary.text);
  return { continued: false, checked: cont.checked, summary: summary, throttled: res.throttled, retryAt: retryAt };
}

/**
 * Books a one-off retry run after screener blocked this one. Returns the
 * retry time as "HH:mm" (IST), or '' once today's retries are used up.
 */
function ab_rsScheduleThrottleRetry_(todayKey) {
  const props = PropertiesService.getScriptProperties();
  let st = null;
  try { st = JSON.parse(props.getProperty(AB_RS_THROTTLE_PROP) || 'null'); } catch (e) { st = null; }
  if (!AB_RS_THROTTLE_RETRY_MIN.length) {
    Logger.log('Results Day: screener is blocking requests - those companies stay pending for tomorrow\'s run.');
    return '';
  }
  if (!st || st.day !== todayKey) st = { day: todayKey, n: 0 };
  if (st.n >= AB_RS_THROTTLE_RETRY_MIN.length) {
    Logger.log('Results Day: screener still blocking and today\'s automatic retries are used up - the next scheduled run will try again.');
    return '';
  }
  const mins = AB_RS_THROTTLE_RETRY_MIN[st.n];
  st.n++;
  props.setProperty(AB_RS_THROTTLE_PROP, JSON.stringify(st));
  ab_rsDeleteTriggers_(['ab_rsThrottleRetryRun_']);
  ScriptApp.newTrigger('ab_rsThrottleRetryRun_').timeBased().after(mins * 60 * 1000).create();
  const at = Utilities.formatDate(new Date(Date.now() + mins * 60000), AB_TZ, 'HH:mm');
  Logger.log('Results Day: screener is blocking requests - automatic retry ' + st.n + ' of ' +
             AB_RS_THROTTLE_RETRY_MIN.length + ' booked for ~' + at + ' IST.');
  return at;
}

/** Trigger handler - one-shot retry after screener blocked a run. */
function ab_rsThrottleRetryRun_() {
  ab_rsDeleteTriggers_(['ab_rsThrottleRetryRun_']);
  const ts = Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm');
  try {
    ab_rsRun_('Retry run (screener was blocking)', false);
  } catch (e) {
    logRun_(ts, '', 0, 'ERROR (results day retry)', e.message);
    throw e;
  }
}

function ab_rsDeleteTriggers_(handlers) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (handlers.indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
}

function ab_rsScheduleContinuation_() {
  ab_rsDeleteTriggers_(['ab_rsContinueRun_']);
  ScriptApp.newTrigger('ab_rsContinueRun_').timeBased().after(60 * 1000).create();
}

/** Trigger handler - the two daily runs. */
function ab_rsTriggerRun_() {
  const slot = 'Daily run';
  const ts = Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm');
  ab_rsDeleteTriggers_(['ab_rsThrottleRetryRun_']); // this run does the retry's job
  try {
    ab_rsRun_(slot, false);
  } catch (e) {
    logRun_(ts, '', 0, 'ERROR (results day)', e.message);
    ab_sendDailyPhaseFailureEmail_('Results Day check', ts, e);
    throw e;
  }
}

/** Trigger handler - one-shot continuation after a run hit its time budget. */
function ab_rsContinueRun_() {
  ab_rsDeleteTriggers_(['ab_rsContinueRun_']);
  const ts = Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm');
  try {
    ab_rsRun_(null, true);
  } catch (e) {
    logRun_(ts, '', 0, 'ERROR (results day continuation)', e.message);
    ab_sendDailyPhaseFailureEmail_('Results Day check (continuation)', ts, e);
    throw e;
  }
}

/** Menu: run the check right now (also sends the email when done). */
function runResultsDayCheckNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Checking companies with results due today / still pending...', 'Results Day', 10);
  try {
    const out = ab_rsRun_('Manual run', false);
    if (out && out.paused) {
      ss.toast('Not run - ' + ab_screenerPauseText_() + '.', 'Results Day', 15);
    } else if (!out || out.skipped) {
      ss.toast('A Results Day check is already running - wait a few minutes and try again.', 'Results Day', 10);
    } else if (out.continued) {
      ss.toast(out.checked + ' checked so far, ' + out.remaining + ' to go - it carries on automatically in ' +
               'about a minute and emails you when finished. Progress is in the "' + AB_RS_TRACKER_SHEET + '" tab.',
               'Results Day', 20);
    } else if (out.throttled) {
      ss.toast('screener.in is refusing requests from Google\'s servers right now (not a problem with your sheet). ' +
               (out.retryAt ? 'It will retry automatically at ~' + out.retryAt + ' IST' : 'The next scheduled run will try again') +
               ' - nothing was lost, every company stays pending. ' + out.summary.text, 'Results Day', 30);
    } else {
      ss.toast(out.summary.text, 'Results Day', 20);
    }
  } catch (e) {
    ss.toast('Results Day check failed: ' + e.message);
  }
}

/**
 * Menu: re-send the Results Update email from what is ALREADY in Main and the
 * Results Tracker - no screener fetch, Main is not touched (only the Results Performance tab is refreshed). Uses today's updates,
 * or the most recent day that has any, and the current look / values (e.g. after
 * a formula fix). Useful to re-see the email without waiting for a new result.
 */
function runResultsEmailResend() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const layout = ab_getMainLayout_();
    const cols = {
      promoter: ab_qt_findCol_(layout.header, AB_TT_PROMOTER_HEADER),
      fii: ab_qt_findCol_(layout.header, AB_TT_FII_HEADER),
      opmYoY: ab_qt_findCol_(layout.header, AB_TT_OPM_YOY_HEADER),
      opmQoQ: ab_qt_findCol_(layout.header, AB_TT_OPM_QOQ_HEADER)
    };
    const rowsBySym = {};
    for (let r = layout.headerRowIdx + 1; r < layout.data.length; r++) {
      const sym = ab_cellText_(layout.data[r][layout.symbol]).toUpperCase();
      const name = ab_cellText_(layout.data[r][layout.name]);
      if (!sym && !name) break;
      if (!sym) continue;
      (rowsBySym[sym] = rowsBySym[sym] || []).push(r);
    }
    const tr = ab_rsReadTracker_();
    const todayKey = ab_rsDayKey_(new Date());
    // Report day = today if anything was updated today, else the latest day that has updates.
    let reportKey = '';
    tr.list.forEach(function (t) {
      if (t.status !== 'Updated') return;
      const k = ab_rsDmyToKey_(String(t.updatedAt || ''));
      if (k && k > reportKey) reportKey = k;
    });
    if (!reportKey) {
      ss.toast('Nothing to re-send - no company is marked Updated in the Results Tracker yet.', 'Results Day', 10);
      return;
    }
    ss.toast('Building the Results Update email from the current sheet values...', 'Results Day', 8);
    let perf = {};
    try { perf = ab_rpRefresh_({ layout: layout, cols: cols, tracker: tr }).byKey; }
    catch (pErr) { Logger.log('Results Performance refresh failed: ' + pErr.message); }
    const summary = ab_rsSendEmail_({
      layout: layout, cols: cols, tracker: tr, rowsBySym: rowsBySym, todayKey: todayKey,
      reportDayKey: reportKey === todayKey ? '' : reportKey,
      runStartFloor: Number.MAX_SAFE_INTEGER, slot: 'Re-sent (no fetch)', checked: 0, failed: 0,
      notChecked: 0, throttled: false, retryAt: '', seasonReset: null, perf: perf, quietUnlessUpdated: false
    });
    ss.toast(summary.text, 'Results Day', 20);
  } catch (e) {
    ss.toast('Re-send failed: ' + e.message, 'Results Day', 20);
  }
}

/** Menu: install the single daily run (~6 PM IST by default). Removes any
 *  older twice-a-day triggers and pending retries first. */
function installResultsDayTriggers() {
  removeResultsDayTriggers();
  ScriptApp.newTrigger('ab_rsTriggerRun_').timeBased()
    .atHour(AB_RS_DAILY_HOUR).nearMinute(AB_RS_DAILY_MIN).everyDays(1).inTimezone(AB_TZ).create();
  SpreadsheetApp.getActiveSpreadsheet().toast(
    'Results Day check installed - once a day at ~' + AB_RS_DAILY_HOUR + ':' + ('0' + AB_RS_DAILY_MIN).slice(-2) +
    ' IST (Google runs time triggers within about 15 minutes of the set time). Any older 5 PM / 11:30 PM ' +
    'triggers and pending retries were removed.', 'Results Day', 15);
}

/** Menu: remove the daily run, any pending continuation and any pending retry. */
function removeResultsDayTriggers() {
  ab_rsDeleteTriggers_(['ab_rsTriggerRun_', 'ab_rsContinueRun_', 'ab_rsThrottleRetryRun_']);
  PropertiesService.getScriptProperties().deleteProperty(AB_RS_CONT_PROP);
}

/* ---------- email ---------- */

/**
 * Main's TTM Signal / Upside Potential (and the PE / PEG / Target chain behind
 * them) are sheet FORMULAS - they only recalculate after the new quarterly
 * numbers have been written, and GOOGLEFINANCE-based parts take a few seconds.
 * Before the email is built, flush the writes and wait (up to maxMs) until the
 * two columns stop changing for the rows updated in this run, so the email
 * shows the post-results values, not the old ones. Returns how many cells were
 * still blank / #N/A / Loading when it stopped waiting.
 */
function ab_rsWaitForFormulas_(layout, symbols, rowsBySym, maxMs) {
  const colIdx = [layout.ttmSignal, layout.upsidePotential].filter(function (c) { return c !== -1 && c !== undefined; });
  if (!colIdx.length || !symbols.length || maxMs < 6000) return { pending: 0, waitedMs: 0 };
  const t0 = Date.now();
  SpreadsheetApp.flush();
  const rowList = [];
  symbols.forEach(function (sym) { (rowsBySym[sym] || []).forEach(function (r) { rowList.push(r); }); });
  const lastRow = layout.sheet.getLastRow();
  const snapshot = function () {
    const parts = [];
    let pending = 0, loading = false;
    colIdx.forEach(function (c) {
      const vals = layout.sheet.getRange(1, c + 1, lastRow, 1).getDisplayValues();
      rowList.forEach(function (r) {
        const x = String((vals[r] || [''])[0]).trim();
        parts.push(x);
        if (/^loading/i.test(x)) loading = true;
        if (x === '' || /^(loading|#N\/A)/i.test(x)) pending++;
      });
    });
    return { key: parts.join('|'), pending: pending, loading: loading };
  };
  Utilities.sleep(4000); // give the recalculation a head start
  let prev = null, same = 0, cur = snapshot();
  for (;;) {
    if (!cur.loading && prev !== null && cur.key === prev) same++; else same = 0;
    if (!cur.loading && ((cur.pending === 0 && same >= 1) || same >= 2)) break;
    if (Date.now() - t0 + 3500 > maxMs) break;
    prev = cur.key;
    Utilities.sleep(3000);
    cur = snapshot();
  }
  Logger.log('Results Day: waited ' + Math.round((Date.now() - t0) / 1000) + 's for TTM Signal / Upside to recalculate (' +
             cur.pending + ' cell(s) still blank/#N/A).');
  return { pending: cur.pending, waitedMs: Date.now() - t0 };
}

function ab_rsSendEmail_(ctx) {
  const layout = ctx.layout, cols = ctx.cols, todayKey = ctx.todayKey;
  const reportKey = ctx.reportDayKey || todayKey; // a re-sent email may report an earlier day
  const todayDmy = ab_rsKeyToDmy_(reportKey);
  const list = ctx.tracker.list;

  const updatedToday = list.filter(function (t) {
    return t.status === 'Updated' && String(t.updatedAt).indexOf(todayDmy) === 0;
  }).sort(function (a, b) {
    // Newest result date first, then earlier dates going back; same date -> latest update first, then A-Z.
    if (a.rdKey !== b.rdKey) return !a.rdKey ? 1 : !b.rdKey ? -1 : (a.rdKey < b.rdKey ? 1 : -1);
    return ab_rsParseTs_(b.updatedAt) - ab_rsParseTs_(a.updatedAt) || (a.symbol < b.symbol ? -1 : 1);
  });
  const waiting = list.filter(function (t) { return t.status === 'Pending' && ctx.rowsBySym[t.symbol]; })
    .sort(function (a, b) { return a.rdKey < b.rdKey ? -1 : a.rdKey > b.rdKey ? 1 : (a.symbol < b.symbol ? -1 : 1); });
  const gaveUp = list.filter(function (t) { return t.status === 'Gave up' && ab_rsParseTs_(t.last) >= ctx.runStartFloor; });

  // Upcoming, from the calendar itself (so Purpose comes along too) -
  // only companies on the Main watchlist.
  const cal = ab_rsReadCalendar_();
  const seen = {};
  let notInMain = 0;
  const upcoming = [];
  cal.forEach(function (c) {
    const d = ab_rsDaysBetween_(todayKey, c.dayKey);
    if (d < 1 || d > AB_RS_UPCOMING_DAYS) return;
    const k = c.symbol + '|' + c.dayKey;
    if (seen[k]) return;
    seen[k] = true;
    if (!ctx.rowsBySym[c.symbol]) { notInMain++; return; }
    upcoming.push(c);
  });
  upcoming.sort(function (a, b) { return a.dayKey < b.dayKey ? -1 : a.dayKey > b.dayKey ? 1 : (a.symbol < b.symbol ? -1 : 1); });

  const ts = Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm');
  const textSummary = updatedToday.length + ' updated today, ' + waiting.length + ' waiting on screener, ' +
    upcoming.length + ' due in the next ' + AB_RS_UPCOMING_DAYS + ' days (' + ctx.checked + ' checked this run' +
    (ctx.failed ? ', ' + ctx.failed + ' fetch failures' : '') + ').';

  const newThisRun = updatedToday.filter(function (t) { return ab_rsParseTs_(t.updatedAt) >= ctx.runStartFloor; }).length;
  if (ctx.quietUnlessUpdated && !newThisRun) {
    Logger.log('Results Day retry: nothing new got through - no email sent.');
    return { updatedToday: updatedToday.length, text: textSummary + ' Retry run - nothing new, no email sent.' };
  }
  if (!updatedToday.length && !waiting.length && !upcoming.length && !gaveUp.length) {
    Logger.log('Results Day: nothing to report - no email sent.');
    return { updatedToday: 0, text: textSummary + ' Nothing to report - no email sent.' };
  }

  // TTM Signal / Upside are formulas that recalculate AFTER the new results are written - wait for them.
  let calcNote = '';
  const freshSyms = ctx.reportDayKey ? [] : updatedToday.filter(function (t) {
    return ab_rsParseTs_(t.updatedAt) >= ctx.runStartFloor;
  }).map(function (t) { return t.symbol; });
  if (freshSyms.length) {
    const left = ctx.startedAt ? 5.5 * 60000 - (Date.now() - ctx.startedAt) : 45000;
    const w = ab_rsWaitForFormulas_(layout, freshSyms, ctx.rowsBySym, Math.min(45000, left));
    if (w.pending > 0) calcNote = 'Some TTM Signal / Upside cells were still calculating when this email was built (shown as "-") - check Main.';
  }
  const display = layout.sheet.getDataRange().getDisplayValues();
  const cell = function (sym, colIdx) {
    const rows = ctx.rowsBySym[sym];
    if (!rows || colIdx === -1 || colIdx === undefined) return '';
    return String(display[rows[0]][colIdx] || '').trim();
  };
  const pct = function (v) {
    if (!v) return '<span style="color:' + AB_C_MUTED + '">-</span>';
    const n = Number(String(v).replace(/[%,+\s]/g, ''));
    if (isNaN(n)) return ab_rsEsc_(v);
    const col = n > 0 ? AB_C_POS : n < 0 ? AB_C_NEG : AB_C_MUTED;
    return '<span style="color:' + col + ';font-weight:700">' + (n > 0 ? '+' : '') +
           ab_rsEsc_(String(v).replace(/[%+]/g, '').trim()) + '%</span>';
  };
  const tag = function (label, v) {
    if (!v) return '<span style="color:' + AB_C_MUTED + '">-</span>';
    return '<span style="color:' + ab_fieldColour_(label, v) + ';font-weight:600">' + ab_rsEsc_(v) + '</span>';
  };
  // ---- look & feel: clean "fintech" cards (all inline CSS - Gmail strips <style>) ----
  const updWhen = reportKey === todayKey ? 'today' : 'on ' + ab_rsKeyToDmy_(reportKey);
  const FONT = '-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif';
  const INK = '#0f172a', SLATE = '#64748b', FAINT = '#94a3b8', LINE = '#eef0f5', CARD_BORDER = '#e6e9f0';
  const small = 'style="color:' + FAINT + ';font-size:11px"';
  const th = 'style="text-align:left;padding:10px 9px;background:#f8fafc;border-bottom:1px solid ' + CARD_BORDER +
             ';font-size:10.5px;font-weight:600;color:' + FAINT + ';text-transform:uppercase;letter-spacing:.6px;white-space:nowrap"';
  const td = 'style="padding:12px 9px;border-bottom:1px solid ' + LINE + ';font-size:13px;color:' + INK + ';vertical-align:top"';
  const tdKpi = 'style="padding:12px 9px;border-bottom:1px solid ' + LINE + ';font-size:13px;color:' + INK +
                ';vertical-align:top;text-align:right;background:#fafbfd"';
  const thKpi = th.replace('text-align:left', 'text-align:right');
  const symLink = function (sym) {
    return '<a href="' + ab_chartUrl_(sym) + '" style="color:' + INK + ';font-weight:700;font-size:14px;text-decoration:none">' +
           ab_rsEsc_(sym) + '</a><br><a href="' + ab_screenerUrl_(sym) + '" style="color:' + FAINT + ';font-size:11px;text-decoration:none">screener &#8599;</a>';
  };
  const h3 = function (title, n, colour) {
    return '<div style="margin:26px 0 10px 0;font-size:12px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:' + SLATE + '">' +
           '<span style="color:' + colour + '">&#9679;</span>&nbsp; ' + title +
           ' <span style="display:inline-block;margin-left:6px;padding:1px 8px;border-radius:10px;background:#eef2f7;color:' + SLATE +
           ';font-size:11px;font-weight:600;letter-spacing:0">' + n + '</span></div>';
  };
  const pill = function (text, fg, bg) {
    return '<span style="display:inline-block;padding:2px 9px;border-radius:10px;background:' + bg + ';color:' + fg +
           ';font-size:11px;font-weight:700;letter-spacing:.3px">' + text + '</span>';
  };
  const shortDay = function (key) {
    const p = String(key || '').split('-');
    if (p.length !== 3) return '-';
    const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return Number(p[2]) + ' ' + M[Number(p[1]) - 1] + ' ' + p[0];
  };
  // "QoQ  +7%" / "YoY  +16%" - small grey label, coloured value
  const kv = function (label, valueHtml) {
    return '<div style="line-height:1.75;white-space:nowrap"><span style="display:inline-block;width:30px;color:' + FAINT +
           ';font-size:11px">' + label + '</span>' + valueHtml + '</div>';
  };
  const signalPill = function (v) {
    if (!v || /^#/.test(v)) return '<span style="color:' + FAINT + '">-</span>';
    const L = v.toLowerCase();
    if (L === 'buy') return pill('BUY', AB_C_POS, '#e6f6ed');
    if (L === 'avoid' || L === 'sell') return pill(ab_rsEsc_(v.toUpperCase()), AB_C_NEG, '#fdecec');
    return pill(ab_rsEsc_(v.toUpperCase()), SLATE, '#eef2f7');
  };
  const upsideCell = function (v) {
    if (!v || /^#/.test(v)) return '<span style="color:' + FAINT + '">-</span>';
    const n = Number(String(v).replace(/[%,+\s]/g, ''));
    if (isNaN(n)) return ab_rsEsc_(v);
    const col = n > 0 ? AB_C_POS : n < 0 ? AB_C_NEG : SLATE;
    return '<span style="font-size:15px;font-weight:700;color:' + col + '">' + (n > 0 ? '+' : '') +
           ab_rsEsc_(String(v).replace(/[%+]/g, '').trim()) + '%</span>';
  };

  // --- header + tiles ---
  const tile = function (n, label, colour) {
    return '<td style="width:33%;padding:14px 16px;background:#f8fafc;border:1px solid ' + CARD_BORDER +
           ';border-top:3px solid ' + colour + ';border-radius:10px">' +
           '<div style="font-size:28px;font-weight:700;color:' + INK + ';line-height:1.1">' + n + '</div>' +
           '<div style="font-size:11px;color:' + SLATE + ';text-transform:uppercase;letter-spacing:.6px;margin-top:4px">' + label + '</div></td>';
  };
  let head = '<div style="font-size:22px;font-weight:700;color:' + INK + ';letter-spacing:-.2px">Results Day Update</div>' +
    '<div style="color:' + SLATE + ';font-size:12px;margin:4px 0 16px 0">' + ab_rsEsc_(ctx.slot) + ' &middot; ' + ts + ' IST</div>' +
    '<table role="presentation" style="width:100%;border-collapse:separate;border-spacing:10px 0;margin:0 0 4px -10px"><tr>' +
    tile(updatedToday.length, 'Updated in Main ' + updWhen, AB_C_POS) +
    tile(waiting.length, 'Waiting on screener', AB_C_WARN) +
    tile(upcoming.length, 'Due in next ' + AB_RS_UPCOMING_DAYS + ' days', AB_C_INFO) +
    '</tr></table>';
  const runNotes = [];
  if (ctx.throttled) runNotes.push('screener.in started refusing requests, so this run stopped early - ' +
    (ctx.retryAt ? 'it retries automatically at ~' + ctx.retryAt + ' IST.' : 'the rest are checked next run.'));
  else if (ctx.notChecked > 0) runNotes.push(ctx.notChecked + ' pending compan' + (ctx.notChecked === 1 ? 'y was' : 'ies were') +
    ' not reached this run (time limit) - they are checked first next run.');
  if (ctx.failed) runNotes.push(ctx.failed + ' fetch failure(s) this run - those stay pending and are retried.');
  if (calcNote) runNotes.push(calcNote);
  if (ctx.seasonReset) {
    runNotes.push('New results season ' + ctx.seasonReset.to + ' - cleared ' + ctx.seasonReset.cleared +
                  ' Checkbox tick(s) from last season.');
  }
  if (runNotes.length) {
    head += '<div style="color:' + AB_C_WARN + ';font-size:12px;margin-top:8px">' + runNotes.map(ab_rsEsc_).join('<br>') + '</div>';
  }

  // --- updated today (newest result date first) ---
  const updatedRow = function (t) {
    const s = t.symbol;
    const isNew = ab_rsParseTs_(t.updatedAt) >= ctx.runStartFloor;
    const bi = cell(s, layout.basicIndustry);
    // Today's % change sits under the symbol; the move since the result date sits under the result date.
    const dayRaw = cell(s, layout.pctChange);
    const dayHtml = (dayRaw && !/^#/.test(dayRaw)) ? '<div style="font-size:12px;margin-top:1px">' + pct(dayRaw) + '</div>' : '';
    const pf = (ctx.perf || {})[s + '|' + String(t.quarter).toUpperCase()];
    const sinceHtml = (pf && typeof pf.sincePct === 'number' && !isNaN(pf.sincePct))
      ? '<div style="font-size:12px;margin-top:2px">' + pct((pf.sincePct * 100).toFixed(2)) + '</div>' +
        '<div style="color:' + FAINT + ';font-size:10px">since result</div>' : '';
    return '<tr>' +
      '<td ' + td + '>' + '<a href="' + ab_chartUrl_(s) + '" style="color:' + INK + ';font-weight:700;font-size:14px;text-decoration:none">' + ab_rsEsc_(s) + '</a>' +
        (dayHtml || '<br>') + '<a href="' + ab_screenerUrl_(s) + '" style="color:' + FAINT + ';font-size:11px;text-decoration:none">screener &#8599;</a>' +
        (isNew ? '<br>' + pill('NEW', '#ffffff', AB_C_POS) : '') + '</td>' +
      '<td ' + td + '>' + ab_rsEsc_(t.company || cell(s, layout.name)) + (bi ? '<br><span ' + small + '>' + ab_rsEsc_(bi) + '</span>' : '') + '</td>' +
      '<td ' + td + ' nowrap><b>' + shortDay(t.rdKey) + '</b>' + sinceHtml + '</td>' +
      '<td ' + td + '>' + kv('QoQ', pct(cell(s, layout.qoqRev))) + kv('YoY', pct(cell(s, layout.yoyRev))) + '</td>' +
      '<td ' + td + '>' + kv('QoQ', pct(cell(s, layout.qoqNp))) + kv('YoY', pct(cell(s, layout.yoyNp))) + '</td>' +
      '<td ' + td + '>' + kv('QoQ', tag('OPM QoQ%', cell(s, cols.opmQoQ))) + kv('YoY', tag('OPM YoY%', cell(s, cols.opmYoY))) + '</td>' +
      '<td ' + td + '>' + kv('Prom', tag('Promotor Holding', cell(s, cols.promoter))) + kv('FII', tag('FII Activity', cell(s, cols.fii))) + '</td>' +
      '<td ' + tdKpi + '>' + signalPill(cell(s, layout.ttmSignal)) + '</td>' +
      '<td ' + tdKpi + '>' + upsideCell(cell(s, layout.upsidePotential)) + '</td>' +
      '</tr>' + (t.note ? '<tr><td colspan="9" style="padding:0 12px 8px 12px;font-size:11px;color:' + FAINT + ';border-bottom:1px solid ' + LINE + '">' + ab_rsEsc_(t.note) + '</td></tr>' : '');
  };
  const tblOpen = '<table role="presentation" style="width:100%;border-collapse:collapse;border:1px solid ' + CARD_BORDER + '">';
  const updatedHead = tblOpen +
    '<tr><th ' + th + '>Symbol</th><th ' + th + '>Company</th><th ' + th + '>Result</th><th ' + th + '>Revenue</th>' +
    '<th ' + th + '>Net Profit</th><th ' + th + '>OPM</th><th ' + th + '>Holdings</th>' +
    '<th ' + thKpi + '>TTM Signal</th><th ' + thKpi + '>Upside</th></tr>';
  const buildUpdated = function (limit) {
    if (!updatedToday.length) {
      return h3('Updated in Main ' + updWhen, 0, AB_C_POS) +
        '<div style="color:' + FAINT + ';font-size:13px">None yet ' + updWhen + '.</div>';
    }
    const shown = updatedToday.slice(0, limit);
    let s = h3('Updated in Main ' + updWhen, updatedToday.length, AB_C_POS) + updatedHead;
    shown.forEach(function (t) { s += updatedRow(t); });
    s += '</table>';
    if (updatedToday.length > shown.length) {
      s += '<div style="color:' + FAINT + ';font-size:12px;margin-top:6px">+' + (updatedToday.length - shown.length) +
           ' more - see the "' + AB_RS_TRACKER_SHEET + '" tab.</div>';
    }
    return s;
  };

  // --- waiting on screener ---
  const buildWaiting = function (compact) {
    if (!waiting.length) return '';
    let s = h3('Results announced - screener not updated yet (auto re-check)', waiting.length, AB_C_WARN);
    if (compact) {
      // Heavy-day fallback: one line per result date instead of a full table.
      const byDay = {}, days = [];
      waiting.forEach(function (t) {
        if (!byDay[t.rdKey]) { byDay[t.rdKey] = []; days.push(t.rdKey); }
        byDay[t.rdKey].push(t);
      });
      days.forEach(function (k) {
        s += '<div style="margin:6px 0 2px 0;font-size:13px;font-weight:700">Result ' + ab_rsKeyToDmy_(k) +
             ' <span style="color:#888;font-weight:400">(' + byDay[k].length + ')</span></div>' +
             '<div style="font-size:12px;line-height:1.6">' + byDay[k].map(function (t) {
               return ab_rsEsc_(t.symbol) + ' <span style="color:#888">(' + ab_rsEsc_(t.latest || 'not checked') + ')</span>';
             }).join(', ') + '</div>';
      });
    } else {
      s += tblOpen +
        '<tr><th ' + th + '>Symbol</th><th ' + th + '>Company</th><th ' + th + '>Result Date</th><th ' + th + '>Waiting For</th>' +
        '<th ' + th + '>Screener Shows</th><th ' + th + ' align="right">Days</th><th ' + th + ' align="right">Checks</th></tr>';
      waiting.forEach(function (t) {
        const days = t.rdKey ? ab_rsDaysBetween_(t.rdKey, todayKey) : '';
        const failed = /^Could not read|^Unrecognised/.test(t.note || '');
        s += '<tr><td ' + td + '>' + symLink(t.symbol) + '</td>' +
          '<td ' + td + '>' + ab_rsEsc_(t.company) + '</td>' +
          '<td ' + td + '>' + ab_rsKeyToDmy_(t.rdKey) + '</td>' +
          '<td ' + td + '><b>' + ab_rsEsc_(t.quarter) + '</b></td>' +
          '<td ' + td + '>' + (failed ? '<span style="color:' + AB_C_NEG + '">' + ab_rsEsc_(t.note) + '</span>'
                                      : ab_rsEsc_(t.latest || (t.checks ? '-' : 'not checked yet'))) + '</td>' +
          '<td ' + td + ' align="right">' + days + '</td>' +
          '<td ' + td + ' align="right">' + (t.checks || 0) + '</td></tr>';
      });
      s += '</table>';
    }
    return s + '<div style="color:#888;font-size:12px;margin-top:4px">Nothing is written to Main and ' +
      'the Checkbox stays unticked until screener shows the expected quarter. Re-checked every run for up to ' +
      AB_RS_MAX_WAIT_DAYS + ' days after the result date.</div>';
  };

  let gaveUpHtml = '';
  if (gaveUp.length) {
    gaveUpHtml = h3('Stopped checking (no update after ' + AB_RS_MAX_WAIT_DAYS + ' days)', gaveUp.length, AB_C_MUTED) +
      '<div style="font-size:13px">' + gaveUp.map(function (t) {
        return '<b>' + ab_rsEsc_(t.symbol) + '</b> (' + ab_rsKeyToDmy_(t.rdKey) + ', screener still at ' +
               ab_rsEsc_(t.latest || '?') + ')';
      }).join(', ') + '</div>';
  }

  // --- upcoming ---
  const buildUpcoming = function (compact) {
    if (!upcoming.length) {
      return h3('Upcoming results - next ' + AB_RS_UPCOMING_DAYS + ' days', 0, AB_C_INFO) +
        '<div style="color:#888;font-size:13px">No watchlist companies in the Results calendar for this window.</div>';
    }
    const byDay = {};
    const days = [];
    upcoming.slice(0, AB_RS_UPCOMING_MAX_ROWS).forEach(function (c) {
      if (!byDay[c.dayKey]) { byDay[c.dayKey] = []; days.push(c.dayKey); }
      byDay[c.dayKey].push(c);
    });
    let s = h3('Upcoming results - next ' + AB_RS_UPCOMING_DAYS + ' days', upcoming.length, AB_C_INFO);
    if (compact) {
      days.forEach(function (k) {
        s += '<div style="margin:8px 0 2px 0;font-size:13px;font-weight:700">' + ab_rsPrettyDay_(k) +
             ' <span style="color:#888;font-weight:400">(' + byDay[k].length + ')</span></div>' +
             '<div style="font-size:12px;line-height:1.6">' + byDay[k].map(function (c) {
               return '<a href="' + ab_chartUrl_(c.symbol) + '" style="color:#1558d6;text-decoration:none">' + ab_rsEsc_(c.symbol) + '</a>';
             }).join(', ') + '</div>';
      });
    } else {
      s += tblOpen +
        '<tr><th ' + th + '>Symbol</th><th ' + th + '>Company</th><th ' + th + '>Basic Industry</th><th ' + th + '>Purpose</th></tr>';
      days.forEach(function (k) {
        const n = ab_rsDaysBetween_(todayKey, k);
        s += '<tr><td colspan="4" style="padding:10px 8px 4px 8px;font-size:13px;font-weight:700;background:#f8f9fb;border-bottom:1px solid #e3e3e3">' +
             ab_rsPrettyDay_(k) + ' <span style="color:#888;font-weight:400">&middot; in ' + n + ' day' + (n === 1 ? '' : 's') +
             ' &middot; ' + byDay[k].length + ' compan' + (byDay[k].length === 1 ? 'y' : 'ies') + '</span></td></tr>';
        byDay[k].forEach(function (c) {
          s += '<tr><td ' + td + '><a href="' + ab_chartUrl_(c.symbol) + '" style="color:#1558d6;font-weight:700;text-decoration:none">' +
               ab_rsEsc_(c.symbol) + '</a></td><td ' + td + '>' + ab_rsEsc_(c.company || cell(c.symbol, layout.name)) + '</td>' +
               '<td ' + td + '><span ' + small + '>' + ab_rsEsc_(cell(c.symbol, layout.basicIndustry)) + '</span></td>' +
               '<td ' + td + '><span ' + small + '>' + ab_rsEsc_(c.purpose) + '</span></td></tr>';
        });
      });
      s += '</table>';
    }
    const extra = [];
    if (upcoming.length > AB_RS_UPCOMING_MAX_ROWS) extra.push('+' + (upcoming.length - AB_RS_UPCOMING_MAX_ROWS) + ' more not shown');
    if (notInMain) extra.push(notInMain + ' other calendar entr' + (notInMain === 1 ? 'y is' : 'ies are') + ' not on your Main watchlist');
    if (extra.length) s += '<div style="color:#888;font-size:12px;margin-top:4px">' + extra.join(' &middot; ') + '.</div>';
    return s;
  };

  const footer = '<div style="color:#94a3b8;font-size:12px;margin-top:24px;max-width:760px">Quarterly Results + Trend Tags ' +
    'are written to Main and the Checkbox ticked only once screener.in shows the quarter the result date is for. ' +
    'Full status per company: "' + AB_RS_TRACKER_SHEET + '" tab.</div>';

  // Assemble, shrinking the two potentially-long sections if MailApp's
  // body-size limit would otherwise be hit on a heavy results day.
  const assemble = function (updLimit, compactUpcoming, compactWaiting) {
    return '<div style="background:#f4f6fa;padding:16px 8px;font-family:' + FONT + '">' +
           '<div style="max-width:980px;margin:0 auto;background:#ffffff;border:1px solid ' + CARD_BORDER +
           ';border-radius:14px;padding:22px 18px">' + head + buildUpdated(updLimit) +
           buildWaiting(compactWaiting) + gaveUpHtml + buildUpcoming(compactUpcoming) + footer + '</div></div>';
  };
  // Shrink order: upcoming list first, then the waiting list, then (last
  // resort) trim the updated table - the figures you most want stay full.
  let html = assemble(updatedToday.length, false, false);
  if (html.length > AB_RS_MAX_HTML_CHARS) html = assemble(updatedToday.length, true, false);
  if (html.length > AB_RS_MAX_HTML_CHARS) html = assemble(updatedToday.length, true, true);
  let lim = updatedToday.length;
  while (html.length > AB_RS_MAX_HTML_CHARS && lim > 10) {
    lim = Math.floor(lim * 0.7);
    html = assemble(lim, true, true);
  }

  // Plain-text version.
  let text = 'Results Day Update - ' + ctx.slot + ' - ' + ts + ' IST\n' + textSummary + '\n\n';
  text += 'UPDATED IN MAIN TODAY (' + updatedToday.length + ')\n';
  updatedToday.forEach(function (t) {
    const s = t.symbol;
    const pfT = (ctx.perf || {})[s + '|' + String(t.quarter).toUpperCase()];
    text += '  ' + s + ' (result ' + ab_rsKeyToDmy_(t.rdKey) + '): Day ' + (cell(s, layout.pctChange) || '-') +
      (pfT && typeof pfT.sincePct === 'number' && !isNaN(pfT.sincePct) ? ' | Since result ' + (pfT.sincePct * 100).toFixed(2) + '%' : '') + ' | Rev QoQ ' + (cell(s, layout.qoqRev) || '-') +
      ' YoY ' + (cell(s, layout.yoyRev) || '-') + ' | NP QoQ ' + (cell(s, layout.qoqNp) || '-') + ' YoY ' + (cell(s, layout.yoyNp) || '-') +
      ' | OPM ' + (cell(s, cols.opmQoQ) || '-') + '/' + (cell(s, cols.opmYoY) || '-') +
      ' | TTM Signal ' + (cell(s, layout.ttmSignal) || '-') + ' | Upside ' + (cell(s, layout.upsidePotential) || '-') + '\n';
  });
  if (waiting.length) {
    text += '\nWAITING ON SCREENER (' + waiting.length + ')\n';
    waiting.forEach(function (t) {
      text += '  ' + t.symbol + ' - result ' + ab_rsKeyToDmy_(t.rdKey) + ', waiting for ' + t.quarter +
              ', screener shows ' + (t.latest || '-') + '\n';
    });
  }
  text += '\nUPCOMING - NEXT ' + AB_RS_UPCOMING_DAYS + ' DAYS (' + upcoming.length + ')\n';
  let lastDay = '';
  upcoming.slice(0, AB_RS_UPCOMING_MAX_ROWS).forEach(function (c) {
    if (c.dayKey !== lastDay) { text += '  ' + ab_rsPrettyDay_(c.dayKey) + '\n'; lastDay = c.dayKey; }
    text += '    ' + c.symbol + (c.company ? ' - ' + c.company : '') + '\n';
  });

  const subject = 'Results Update - ' + updatedToday.length + ' updated in Main, ' + waiting.length +
    ' awaiting screener, ' + upcoming.length + ' due in ' + AB_RS_UPCOMING_DAYS + 'd (' + ts + ')';
  try {
    ab_sendMail_({ to: AB_EMAIL_TO, subject: subject, body: text, htmlBody: html });
  } catch (e) {
    Logger.log('Results Day email failed: ' + e.message);
    return { updatedToday: updatedToday.length, text: textSummary + ' EMAIL FAILED: ' + e.message };
  }
  return { updatedToday: updatedToday.length, text: textSummary + ' Email sent.' };
}

/*****************************************************************
 * UPCOMING RESULTS - daily email
 * -----------------------------------------------------------------
 * Every weekday morning (own trigger, ~6 AM) one email listing the Main watchlist
 * companies that report results from TODAY through the next
 * AB_RS_UPCOMING_DAYS days, in date order, each with Chart and
 * Screener links. Reads only the Results calendar tab and Main - it
 * never calls screener.in, so it keeps working while screener fetching
 * is paused or blocked. Skipped (no mail) when nobody is due.
 *****************************************************************/
function ab_collectUpcomingResults_() {
  const layout = ab_getMainLayout_();
  const todayKey = ab_rsDayKey_(new Date());
  const main = {};
  for (let r = layout.headerRowIdx + 1; r < layout.data.length; r++) {
    const row = layout.data[r];
    const sym = ab_cellText_(row[layout.symbol]).toUpperCase();
    const nm = layout.name !== -1 ? ab_cellText_(row[layout.name]) : '';
    if (!sym && !nm) break;
    if (!sym || main[sym]) continue;
    main[sym] = {
      name: nm,
      industry: layout.basicIndustry !== -1 ? ab_cellText_(row[layout.basicIndustry]) : '',
      price: layout.mktPrice !== -1 ? ab_toNum_(row[layout.mktPrice]) : NaN,
      pct: layout.pctChange !== -1 ? ab_toNum_(row[layout.pctChange]) : NaN,
      rd: layout.resultDate !== -1 ? ab_rsToDate_(row[layout.resultDate]) : null
    };
  }

  const rows = [], seen = {};
  let notInMain = 0;
  ab_rsReadCalendar_().forEach(function (c) {
    const d = ab_rsDaysBetween_(todayKey, c.dayKey);
    if (d < 0 || d > AB_RS_UPCOMING_DAYS) return;
    const k = c.symbol + '|' + c.dayKey;
    if (seen[k]) return;
    seen[k] = true;
    const m = main[c.symbol];
    if (!m) { notInMain++; return; }
    rows.push({ symbol: c.symbol, company: c.company || m.name, industry: m.industry, purpose: c.purpose,
                dayKey: c.dayKey, price: m.price, pct: m.pct });
  });
  // Main's own Result Date column also counts (a symbol the calendar tab does not list).
  Object.keys(main).forEach(function (sym) {
    const m = main[sym];
    if (!m.rd) return;
    const dk = ab_rsDayKey_(m.rd);
    const d = ab_rsDaysBetween_(todayKey, dk);
    if (d < 0 || d > AB_RS_UPCOMING_DAYS) return;
    if (seen[sym + '|' + dk]) return;
    // Same symbol already listed from the calendar on another day? Trust the calendar.
    if (rows.some(function (x) { return x.symbol === sym; })) return;
    seen[sym + '|' + dk] = true;
    rows.push({ symbol: sym, company: m.name, industry: m.industry, purpose: '', dayKey: dk, price: m.price, pct: m.pct });
  });
  rows.sort(function (a, b) { return a.dayKey < b.dayKey ? -1 : a.dayKey > b.dayKey ? 1 : (a.symbol < b.symbol ? -1 : 1); });
  return { rows: rows, todayKey: todayKey, notInMain: notInMain };
}

/** Sends the Upcoming Results email. Returns how many companies were listed (0 = nothing sent). */
function sendUpcomingResultsEmail_() {
  const data = ab_collectUpcomingResults_();
  const rows = data.rows, todayKey = data.todayKey;
  if (!rows.length) {
    Logger.log('Upcoming Results: nobody on the watchlist reports in the next ' + AB_RS_UPCOMING_DAYS + ' days - no email sent.');
    return 0;
  }
  const shown = rows.slice(0, AB_RS_UPCOMING_MAX_ROWS);
  const todayCount = rows.filter(function (x) { return x.dayKey === todayKey; }).length;
  const ts = Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm');

  const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const groupDays = function (list) {
    const g = { byDay: {}, days: [] };
    list.forEach(function (c) {
      if (!g.byDay[c.dayKey]) { g.byDay[c.dayKey] = []; g.days.push(c.dayKey); }
      g.byDay[c.dayKey].push(c);
    });
    return g;
  };
  const within = function (n) {
    return rows.filter(function (x) { const d = ab_rsDaysBetween_(todayKey, x.dayKey); return d >= 0 && d <= n; }).length;
  };
  const tile = function (num, label, color) {
    return '<td width="33%" align="center" style="padding:10px 4px;background:#ffffff;border:1px solid #e6e9ef;border-radius:10px">' +
           '<div style="font-family:' + FONT + ';font-size:24px;line-height:28px;font-weight:700;color:' + color + '">' + num + '</div>' +
           '<div style="font-family:' + FONT + ';font-size:11px;letter-spacing:.4px;text-transform:uppercase;color:#6b7280;margin-top:2px">' + label + '</div></td>';
  };

  const buildHead = function () {
  // One fluid column (max 640px): reads the same on a phone and a laptop.
  let html = '<div style="background:#f3f5f9;padding:16px 8px;font-family:' + FONT + '">';
  html += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;border-collapse:separate">';

  // Header band
  html += '<tr><td style="background:#0b1f3a;border-radius:14px 14px 0 0;padding:18px 18px 16px 18px">' +
          '<div style="font-family:' + FONT + ';font-size:11px;letter-spacing:1.2px;color:#7fd1b9;font-weight:700">RESULTS CALENDAR</div>' +
          '<div style="font-family:' + FONT + ';font-size:22px;line-height:28px;color:#ffffff;font-weight:700;margin-top:2px">Upcoming Results</div>' +
          '<div style="font-family:' + FONT + ';font-size:12px;color:#aab6c8;margin-top:4px">' + ab_rsPrettyDay_(todayKey) +
          ' &middot; watchlist companies, next ' + AB_RS_UPCOMING_DAYS + ' days</div></td></tr>';

  // KPI tiles
  html += '<tr><td style="background:#f3f5f9;padding:12px 0 6px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="6" style="border-collapse:separate"><tr>' +
          tile(todayCount, 'Today', todayCount ? '#067647' : '#6b7280') +
          tile(within(7), 'Next 7 days', '#1a56db') +
          tile(rows.length, 'Next ' + AB_RS_UPCOMING_DAYS + ' days', '#0b1f3a') + '</tr></table></td></tr>';
  return html;
  };

  // mode: 'full' (cards) -> 'compact' (one line per company) -> 'names' (symbols only, per day)
  const buildDays = function (mode, g) {
  let html = '';
  const byDay = g.byDay, days = g.days;
  days.forEach(function (k) {
    const n = ab_rsDaysBetween_(todayKey, k);
    const isToday = n === 0;
    const when = isToday ? 'TODAY' : (n === 1 ? 'TOMORROW' : 'IN ' + n + ' DAYS');
    const pillBg = isToday ? '#d1fadf' : (n === 1 ? '#dbeafe' : '#e8ebf0');
    const pillFg = isToday ? '#067647' : (n === 1 ? '#1e40af' : '#475467');
    const list = byDay[k];
    // Day header
    html += '<tr><td style="padding:14px 4px 6px 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
            '<td style="font-family:' + FONT + ';font-size:14px;font-weight:700;color:#101828">' + ab_rsPrettyDay_(k) +
            ' <span style="font-weight:400;color:#667085;font-size:12px">&middot; ' + list.length + ' compan' + (list.length === 1 ? 'y' : 'ies') + '</span></td>' +
            '<td align="right"><span style="display:inline-block;font-family:' + FONT + ';font-size:10px;letter-spacing:.8px;font-weight:700;padding:3px 9px;border-radius:999px;background:' +
            pillBg + ';color:' + pillFg + '">' + when + '</span></td></tr></table></td></tr>';
    if (mode === 'names') {
      html += '<tr><td style="background:#ffffff;border:1px solid #e6e9ef;border-radius:12px;padding:10px 14px;font-family:' + FONT +
              ';font-size:13px;line-height:22px">' + list.map(function (c) {
        return '<a href="' + ab_chartUrl_(c.symbol) + '" style="color:#1a56db;font-weight:600;text-decoration:none">' + ab_rsEsc_(c.symbol) + '</a>';
      }).join(' &middot; ') + '</td></tr>';
      return;
    }
    // Company cards (one table row each, rounded group)
    html += '<tr><td style="background:#ffffff;border:1px solid #e6e9ef;border-radius:12px;padding:0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">';
    list.forEach(function (c, idx) {
      if (mode === 'compact') {
        const cp = !isNaN(c.pct);
        const ccol = !cp ? '#667085' : (c.pct > 0 ? '#067647' : (c.pct < 0 ? '#b42318' : '#667085'));
        html += '<tr><td style="padding:7px 14px;font-family:' + FONT + ';font-size:13px;' + (idx ? 'border-top:1px solid #eef0f3' : '') + '">' +
          '<a href="' + ab_chartUrl_(c.symbol) + '" style="font-weight:700;color:#1a56db;text-decoration:none">' + ab_rsEsc_(c.symbol) + '</a>' +
          ' <span style="color:#667085;font-size:12px">' + ab_rsEsc_(String(c.company || '').slice(0, 30)) + '</span></td>' +
          '<td align="right" style="padding:7px 14px;font-family:' + FONT + ';font-size:12px;white-space:nowrap;' + (idx ? 'border-top:1px solid #eef0f3' : '') + '">' +
          (isNaN(c.price) ? '-' : '&#8377;' + ab_num2_(c.price)) + ' <span style="color:' + ccol + ';font-weight:600">' + (cp ? ab_pct2_(c.pct) : '') + '</span></td></tr>';
        return;
      }
      const hasPct = !isNaN(c.pct);
      const col = !hasPct ? '#667085' : (c.pct > 0 ? '#067647' : (c.pct < 0 ? '#b42318' : '#667085'));
      const arrow = !hasPct ? '' : (c.pct > 0 ? '&#9650; ' : (c.pct < 0 ? '&#9660; ' : ''));
      const chips = [];
      if (c.purpose) chips.push('<span style="display:inline-block;font-size:10px;padding:2px 7px;border-radius:999px;background:#eef2ff;color:#3730a3;margin:3px 4px 0 0">' + ab_rsEsc_(c.purpose) + '</span>');
      if (c.industry) chips.push('<span style="display:inline-block;font-size:10px;padding:2px 7px;border-radius:999px;background:#f2f4f7;color:#475467;margin:3px 4px 0 0">' + ab_rsEsc_(c.industry) + '</span>');
      html += '<tr><td style="padding:12px 14px;' + (idx ? 'border-top:1px solid #eef0f3' : '') + '">' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
        '<td valign="top" style="font-family:' + FONT + '">' +
          '<a href="' + ab_chartUrl_(c.symbol) + '" style="font-size:17px;line-height:22px;font-weight:700;color:#1a56db;text-decoration:none">' + ab_rsEsc_(c.symbol) + '</a>' +
          '<div style="font-size:12px;line-height:16px;color:#667085;margin-top:1px">' + ab_rsEsc_(c.company) + '</div>' +
          '<div>' + chips.join('') + '</div></td>' +
        '<td valign="top" align="right" style="font-family:' + FONT + ';white-space:nowrap;padding-left:10px">' +
          '<div style="font-size:16px;line-height:22px;font-weight:700;color:#101828">' + (isNaN(c.price) ? '-' : '&#8377;' + ab_num2_(c.price)) + '</div>' +
          '<div style="font-size:12px;line-height:16px;font-weight:600;color:' + col + '">' + (hasPct ? arrow + ab_pct2_(c.pct) : '&nbsp;') + '</div>' +
          '<div style="margin-top:4px"><a href="' + ab_screenerUrl_(c.symbol) + '" style="font-size:11px;font-weight:600;color:#475467;text-decoration:none;border:1px solid #d0d5dd;border-radius:6px;padding:2px 7px;display:inline-block">Screener &#8599;</a></div></td>' +
        '</tr></table></td></tr>';
    });
    html += '</table></td></tr>';
  });
  return html;
  };

  const buildTail = function (hiddenRows, mode) {
  let html = '';
  const extra = [];
  if (hiddenRows > 0) extra.push('+' + hiddenRows + ' more not shown');
  if (data.notInMain) extra.push(data.notInMain + ' other calendar entr' + (data.notInMain === 1 ? 'y is' : 'ies are') + ' not on your Main watchlist');
  html += '<tr><td style="padding:14px 6px 4px 6px;font-family:' + FONT + ';font-size:11px;line-height:16px;color:#98a2b3;text-align:center">' +
          'Tap a symbol to open its chart. ' + (mode !== 'full' ? 'Compact view because the list is long. ' : '') + + (extra.length ? extra.join(' &middot; ') + '. ' : '') + 'Prices are the last values in your sheet. Sent ' + ts + ' IST.</td></tr>';
  html += '</table></div>';
  return html;
  };

  // Pick the richest layout that fits MailApp's body-size limit (a long calendar after a fresh paste
  // can run to hundreds of companies).
  const MAX_HTML = 120000;
  let html = '', mode = 'full', list = shown;
  const build = function (m, l) {
    const g = groupDays(l);
    return buildHead() + buildDays(m, g) + buildTail(rows.length - l.length, m) + '</table></div>';
  };
  const order = ['full', 'compact', 'names'];
  for (let mi = 0; mi < order.length; mi++) {
    mode = order[mi];
    html = build(mode, list);
    if (html.length <= MAX_HTML) break;
  }
  while (html.length > MAX_HTML && list.length > 20) { // still too big: show fewer companies
    list = list.slice(0, Math.floor(list.length * 0.8));
    html = build('names', list);
  }

  let text = 'Upcoming Results - ' + ts + ' IST\n' + rows.length + ' watchlist companies in the next ' + AB_RS_UPCOMING_DAYS + ' days' +
             (todayCount ? ' (' + todayCount + ' today)' : '') + '\n';
  let last = '';
  const withLinks = list.length <= 40; // long lists: names only, keeps the plain-text part small
  list.forEach(function (c) {
    if (c.dayKey !== last) { text += '\n' + ab_rsPrettyDay_(c.dayKey) + '\n'; last = c.dayKey; }
    text += '  ' + c.symbol + (c.company ? ' - ' + c.company : '') + (c.purpose && withLinks ? ' [' + c.purpose + ']' : '') +
            (withLinks ? '\n    Chart: ' + ab_chartUrl_(c.symbol) + '\n    Screener: ' + ab_screenerUrl_(c.symbol) : '') + '\n';
  });

  const subject = 'Upcoming Results - ' + (todayCount ? todayCount + ' today, ' : '') + rows.length + ' in next ' + AB_RS_UPCOMING_DAYS + ' days (' + ts + ')';
  const ok = ab_sendMail_({ to: AB_EMAIL_TO, subject: subject, body: text, htmlBody: html });
  return ok === false ? 0 : rows.length;
}

/** Trigger entry point: weekdays only, own execution, own failure email. */
function ab_upcomingResultsTriggerRun_() {
  const ts = Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm');
  if (Number(Utilities.formatDate(new Date(), AB_TZ, 'u')) >= 6) {
    Logger.log('Upcoming Results skipped - Saturday/Sunday.');
    return;
  }
  if (!AB_UPCOMING_RESULTS_ON) {
    Logger.log('Upcoming Results skipped - switched off in the Control Panel.');
    return;
  }
  try {
    const n = sendUpcomingResultsEmail_();
    logRun_(ts, '', n, 'OK (upcoming results email)', n ? n + ' company(ies) listed.' : 'Nobody due - no email sent.');
  } catch (e) {
    logRun_(ts, '', 0, 'ERROR (upcoming results email)', e.message);
    ab_sendDailyPhaseFailureEmail_('Upcoming Results email', ts, e);
    throw e;
  }
}

/** Menu: install the daily 6 AM (Mon-Fri) Upcoming Results email. */
function installUpcomingResultsTrigger() {
  removeUpcomingResultsTrigger();
  ScriptApp.newTrigger('ab_upcomingResultsTriggerRun_').timeBased()
    .atHour(AB_UPCOMING_RESULTS_HOUR).nearMinute(AB_UPCOMING_RESULTS_MIN).everyDays(1).inTimezone(AB_TZ).create();
  SpreadsheetApp.getActiveSpreadsheet().toast(
    'Upcoming Results email installed - every morning at ~' + AB_UPCOMING_RESULTS_HOUR + ':' + ('0' + AB_UPCOMING_RESULTS_MIN).slice(-2) +
    ' IST, Monday to Friday (Google runs it within about 15 minutes of that time; Saturday and Sunday it does nothing).',
    'Upcoming Results', 15);
}

function removeUpcomingResultsTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'ab_upcomingResultsTriggerRun_') ScriptApp.deleteTrigger(t);
  });
}

/** Menu: send the Upcoming Results email right now. */
function runUpcomingResultsEmailNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const n = sendUpcomingResultsEmail_();
    ss.toast(n ? 'Upcoming Results emailed (' + n + ' companies).' : 'Nothing sent - nobody due in the next ' + AB_RS_UPCOMING_DAYS + ' days, or emails are paused.', 'Upcoming Results', 12);
  } catch (e) {
    ss.toast('Upcoming Results failed: ' + e.message);
  }
}

/*****************************************************************
 * RESULTS PERFORMANCE - how each updated stock moved after results
 * -----------------------------------------------------------------
 * A "Results Performance" tab with one row per company per quarter,
 * added the moment the Results Day check confirms that company's
 * numbers in Main, and refreshed on every Results Day run.
 *
 * The baseline is the LAST CLOSE BEFORE THE RESULT DATE - the price
 * before the market knew the numbers - so "% Since Results" captures
 * the whole reaction, whether results came out mid-session or after
 * the close. Alongside it:
 *   Result Day %   first session on/after the result date vs baseline
 *   Next Day %     the session after that vs the result-day close
 *   Max Gain / Max Drawdown   best and worst point since the result,
 *                  vs baseline (from daily highs/lows + today's price)
 *   Results Verdict  Strong / Mixed / Weak, from the quarter's revenue
 *                  and profit growth (NP YoY counted double) and OPM trend
 *   Market Reaction  Rallied / Flat / Sold off (+/- AB_RP_MOVE_PCT %)
 *   Signal         where the two disagree: strong results that got sold
 *                  off ("watch"), weak results that rallied ("caution")
 *
 * Prices come from History30 (30 trading days, refreshed by the daily
 * pipeline) and Main's live MKT Price. Anything that can't change once
 * known - baseline, result-day/next-day closes, the quarter's growth
 * figures - is stored in the row the first time it's available and
 * read back on every refresh, so a stock keeps its full post-results
 * record long after its result date has scrolled out of History30.
 * The highest high / lowest low are carried forward the same way.
 *
 * The top of the tab summarises the current season: average and
 * median move since results, how many are above their pre-result
 * price, best/worst, and the same broken down by Results Verdict -
 * i.e. are strong results actually being rewarded this season?
 *****************************************************************/
const AB_RP_SHEET = 'Results Performance';
const AB_RP_MOVE_PCT = ab_setting_('AB_RP_MOVE_PCT', 5);
const AB_RP_HEADER_ROW = 10;
const AB_RP_COLS = ['Symbol', 'Company', 'Basic Industry', 'Quarter', 'Result Date', 'Days Since',
  'Pre-Result Close', 'Result Day %', 'Next Day %', 'Current Price', 'Today %', '% Since Results',
  'Max Gain %', 'Max Drawdown %', 'Results Verdict', 'Market Reaction', 'Signal',
  'Rev QoQ %', 'Rev YoY %', 'NP QoQ %', 'NP YoY %', 'OPM QoQ', 'OPM YoY',
  'Result Day Close', 'Next Day Close', 'Highest Since', 'Lowest Since', 'Last Refreshed'];

function ab_rpNum_(v) {
  if (v === '' || v === null || v === undefined) return NaN;
  return typeof v === 'number' ? v : ab_toNum_(v);
}

function ab_rpPct_(a, b) {
  return (!isNaN(a) && !isNaN(b) && b > 0) ? a / b - 1 : NaN;
}

/** Reads back every row already on the tab, keyed SYMBOL|QUARTER. */
function ab_rpReadExisting_(sh) {
  const vals = sh.getDataRange().getValues();
  let h = -1;
  for (let r = 0; r < Math.min(40, vals.length); r++) {
    if (String(vals[r][0]).trim() === 'Symbol' && String(vals[r][1]).trim() === 'Company') { h = r; break; }
  }
  const out = {};
  if (h === -1) return out;
  const hdr = vals[h].map(function (v) { return String(v).trim(); });
  for (let r = h + 1; r < vals.length; r++) {
    let sym = String(vals[r][0] || '').trim();
    const link = sym.match(/^=HYPERLINK\([^,]*,\s*"([^"]*)"\)/i); // formula text, if ever read as such
    sym = (link ? link[1] : sym).toUpperCase();
    if (!sym) continue;
    const g = function (name) { const i = hdr.indexOf(name); return i === -1 ? '' : vals[r][i]; };
    let q = g('Quarter');
    q = q instanceof Date ? Utilities.formatDate(q, AB_TZ, 'MMM yyyy') : String(q || '').trim();
    out[sym + '|' + q.toUpperCase()] = {
      symbol: sym, company: String(g('Company') || ''), basicIndustry: String(g('Basic Industry') || ''),
      quarter: q, rd: ab_rsToDate_(g('Result Date')),
      base: ab_rpNum_(g('Pre-Result Close')), rdClose: ab_rpNum_(g('Result Day Close')),
      nextClose: ab_rpNum_(g('Next Day Close')), hi: ab_rpNum_(g('Highest Since')), lo: ab_rpNum_(g('Lowest Since')),
      revQoQ: ab_rpNum_(g('Rev QoQ %')), revYoY: ab_rpNum_(g('Rev YoY %')),
      npQoQ: ab_rpNum_(g('NP QoQ %')), npYoY: ab_rpNum_(g('NP YoY %')),
      opmQoQ: String(g('OPM QoQ') || ''), opmYoY: String(g('OPM YoY') || '')
    };
  }
  return out;
}

/** Strong / Mixed / Weak from the quarter's growth figures and OPM trend. */
function ab_rpVerdict_(row) {
  let score = 0, n = 0;
  const sgn = function (v) { return v > 0 ? 1 : v < 0 ? -1 : 0; };
  [row.revQoQ, row.revYoY, row.npQoQ, row.npYoY].forEach(function (v) {
    if (!isNaN(v)) { n++; score += sgn(v); }
  });
  if (!n) return '';
  if (!isNaN(row.npYoY)) score += sgn(row.npYoY); // the headline number counts double
  const opm = String(row.opmYoY || '').toLowerCase();
  if (/increas/.test(opm)) score += 1;
  else if (/decreas/.test(opm)) score -= 1;
  return score >= 3 ? 'Strong' : score <= -2 ? 'Weak' : 'Mixed';
}

function ab_rpReaction_(sincePct) {
  if (isNaN(sincePct)) return '';
  const t = AB_RP_MOVE_PCT / 100;
  return sincePct >= t ? 'Rallied' : sincePct <= -t ? 'Sold off' : 'Flat';
}

function ab_rpSignal_(verdict, reaction) {
  if (verdict === 'Strong' && reaction === 'Sold off') return 'Strong results, sold off - watch';
  if (verdict === 'Weak' && reaction === 'Rallied') return 'Weak results, rallied - caution';
  if (verdict === 'Strong' && reaction === 'Rallied') return 'Confirmed strength';
  if (verdict === 'Weak' && reaction === 'Sold off') return 'Confirmed weakness';
  return '';
}

/**
 * Rebuilds the Results Performance tab. Returns { byKey: {SYM|QTR: row}, count }.
 * opts.cols / opts.tracker can be passed in to save re-reading (Main is always re-read).
 */
function ab_rpRefresh_(opts) {
  opts = opts || {};
  // Always a FRESH read of Main: the Results Day run writes this
  // quarter's figures with setValue(), which doesn't update the layout
  // it read at the start - snapshotting from that would capture LAST
  // quarter's numbers.
  SpreadsheetApp.flush();
  const layout = ab_getMainLayout_();
  const cols = opts.cols || {
    opmYoY: ab_qt_findCol_(layout.header, AB_TT_OPM_YOY_HEADER),
    opmQoQ: ab_qt_findCol_(layout.header, AB_TT_OPM_QOQ_HEADER)
  };
  const tr = opts.tracker || ab_rsReadTracker_();
  const sh = ab_getOrCreateSheet_(AB_RP_SHEET);
  const rows = ab_rpReadExisting_(sh);
  const hist = ab_readHistoryCandles_();
  const todayKey = ab_rsDayKey_(new Date());
  const nowDate = new Date();

  // First Main row per symbol, plus display values for today's % Change.
  const data = layout.data;
  const display = layout.sheet.getDataRange().getDisplayValues();
  const mainRow = {};
  for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
    const sym = ab_cellText_(data[r][layout.symbol]).toUpperCase();
    const name = ab_cellText_(data[r][layout.name]);
    if (!sym && !name) break;
    if (sym && mainRow[sym] === undefined) mainRow[sym] = r;
  }
  const mainNum = function (r, colIdx) {
    return (r === undefined || colIdx === -1 || colIdx === undefined) ? NaN : ab_rpNum_(data[r][colIdx]);
  };
  const mainText = function (r, colIdx) {
    return (r === undefined || colIdx === -1 || colIdx === undefined) ? '' : ab_cellText_(data[r][colIdx]);
  };

  // New rows for every company the Results Day check has confirmed.
  tr.list.forEach(function (t) {
    if (t.status !== 'Updated' || !t.rdKey) return;
    const key = t.symbol + '|' + t.quarter.toUpperCase();
    const p = t.rdKey.split('-').map(Number);
    if (rows[key]) {
      if (!rows[key].rd) rows[key].rd = ab_rsMakeDate_(p[0], p[1] - 1, p[2]); // Result Date cell was edited/cleared
      return;
    }
    const r = mainRow[t.symbol];
    // The quarter's figures are snapshotted now, while Main still holds
    // this quarter - next season will overwrite Main, not this row.
    rows[key] = {
      symbol: t.symbol, company: t.company || mainText(r, layout.name),
      basicIndustry: mainText(r, layout.basicIndustry), quarter: t.quarter,
      rd: ab_rsMakeDate_(p[0], p[1] - 1, p[2]),
      base: NaN, rdClose: NaN, nextClose: NaN, hi: NaN, lo: NaN,
      revQoQ: mainNum(r, layout.qoqRev) / 100, revYoY: mainNum(r, layout.yoyRev) / 100,
      npQoQ: mainNum(r, layout.qoqNp) / 100, npYoY: mainNum(r, layout.yoyNp) / 100,
      opmQoQ: mainText(r, cols.opmQoQ), opmYoY: mainText(r, cols.opmYoY)
    };
  });

  const keyOf = function (d) {
    if (d instanceof Date) return isNaN(d.getTime()) ? '' : ab_rsDayKey_(d);
    const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? m[0] : '';
  };

  const list = Object.keys(rows).map(function (k) { return rows[k]; }).filter(function (x) { return x.rd; });
  list.forEach(function (row) {
    const rdKey = ab_rsDayKey_(row.rd);
    const candles = (hist[row.symbol] || []).map(function (c) {
      return { k: keyOf(c.date), High: c.High, Low: c.Low, Cls: c.Cls };
    }).filter(function (c) { return c.k && !isNaN(c.Cls); })
      .sort(function (a, b) { return a.k < b.k ? -1 : a.k > b.k ? 1 : 0; });

    if (isNaN(row.base)) {
      const pre = candles.filter(function (c) { return c.k < rdKey; });
      if (pre.length) row.base = pre[pre.length - 1].Cls;
    }
    const post = candles.filter(function (c) { return c.k >= rdKey; });
    if (isNaN(row.rdClose) && post.length >= 1) row.rdClose = post[0].Cls;
    if (isNaN(row.nextClose) && post.length >= 2) row.nextClose = post[1].Cls;
    post.forEach(function (c) {
      if (!isNaN(c.High)) row.hi = isNaN(row.hi) ? c.High : Math.max(row.hi, c.High);
      if (!isNaN(c.Low)) row.lo = isNaN(row.lo) ? c.Low : Math.min(row.lo, c.Low);
    });

    const r = mainRow[row.symbol];
    let cur = mainNum(r, layout.mktPrice);
    if (isNaN(cur) && candles.length) cur = candles[candles.length - 1].Cls;
    row.cur = cur;
    row.days = ab_rsDaysBetween_(rdKey, todayKey);
    if (!isNaN(cur) && row.days >= 0) {
      row.hi = isNaN(row.hi) ? cur : Math.max(row.hi, cur);
      row.lo = isNaN(row.lo) ? cur : Math.min(row.lo, cur);
    }
    // Today's % Change - read off the display text so it's right whether
    // Main stores 1.5 or 0.015 behind a % format.
    const dayTxt = (r === undefined || layout.pctChange === -1) ? '' : String(display[r][layout.pctChange] || '');
    const dayN = Number(dayTxt.replace(/[%,+\s]/g, ''));
    row.todayPct = (dayTxt && !/^#/.test(dayTxt) && !isNaN(dayN)) ? dayN / 100 : NaN;

    row.sincePct = ab_rpPct_(cur, row.base);
    row.rdPct = ab_rpPct_(row.rdClose, row.base);
    row.nextPct = ab_rpPct_(row.nextClose, row.rdClose);
    row.maxGain = ab_rpPct_(row.hi, row.base);
    row.maxDD = ab_rpPct_(row.lo, row.base);
    row.verdict = ab_rpVerdict_(row);
    row.reaction = ab_rpReaction_(row.sincePct);
    row.signal = ab_rpSignal_(row.verdict, row.reaction);
  });

  list.sort(function (a, b) {
    const d = b.rd.getTime() - a.rd.getTime();
    return d || (a.symbol < b.symbol ? -1 : 1);
  });

  ab_rpWriteSheet_(sh, list, nowDate);

  const byKey = {};
  list.forEach(function (x) { byKey[x.symbol + '|' + String(x.quarter).toUpperCase()] = x; });
  return { byKey: byKey, count: list.length };
}

function ab_rpWriteSheet_(sh, list, nowDate) {
  const W = AB_RP_COLS.length;
  const H = AB_RP_HEADER_ROW;
  const blank = function (v) { return (typeof v === 'number' && isNaN(v)) || v === undefined || v === null ? '' : v; };

  // ---- season summary (latest quarter on the tab) ----
  let seasonIdx = NaN;
  list.forEach(function (x) {
    const qi = ab_rsQuarterIndex_(x.quarter);
    if (!isNaN(qi) && (isNaN(seasonIdx) || qi > seasonIdx)) seasonIdx = qi;
  });
  const season = isNaN(seasonIdx) ? '' : ab_rsQuarterLabel_(seasonIdx);
  const seasonRows = list.filter(function (x) { return ab_rsQuarterIndex_(x.quarter) === seasonIdx; });
  const moved = seasonRows.filter(function (x) { return !isNaN(x.sincePct); });
  const mean = function (a) { return a.length ? a.reduce(function (s, v) { return s + v; }, 0) / a.length : NaN; };
  const median = function (a) {
    if (!a.length) return NaN;
    const s = a.slice().sort(function (x, y) { return x - y; });
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const since = moved.map(function (x) { return x.sincePct; });
  const above = moved.filter(function (x) { return x.sincePct > 0; }).length;
  const watch = seasonRows.filter(function (x) { return /watch/.test(x.signal); }).length;
  const best = moved.slice().sort(function (a, b) { return b.sincePct - a.sincePct; })[0];
  const worst = moved.slice().sort(function (a, b) { return a.sincePct - b.sincePct; })[0];

  // ---- reset the tab ----
  const oldFilter = sh.getFilter();
  if (oldFilter) oldFilter.remove();
  sh.setConditionalFormatRules([]);
  sh.clear();
  if (sh.getMaxColumns() < W) sh.insertColumnsAfter(sh.getMaxColumns(), W - sh.getMaxColumns());
  const needRows = H + Math.max(list.length, 1) + 5;
  if (sh.getMaxRows() < needRows) sh.insertRowsAfter(sh.getMaxRows(), needRows - sh.getMaxRows());

  // Title
  sh.getRange(1, 1).setValue('Results Performance - how stocks moved after their results')
    .setFontSize(15).setFontWeight('bold').setFontColor('#1f3a5f');
  sh.getRange(2, 1).setValue('Baseline = last close before the result date. "% Since Results" = current price vs that baseline. ' +
    'Refreshed on every Results Day run · last refreshed ' + Utilities.formatDate(nowDate, AB_TZ, 'dd/MM/yyyy HH:mm') + ' IST')
    .setFontColor('#777777').setFontSize(10);

  // KPI tiles (A4:F5)
  const pctFmt = '+0.00%;-0.00%;0.00%';
  const tiles = [
    ['Season', season || '-'],
    ['Stocks Tracked', seasonRows.length],
    ['Avg % Since Results', blank(mean(since))],
    ['Median % Since Results', blank(median(since))],
    ['Above Pre-Result Price', moved.length ? above + ' of ' + moved.length + ' (' + Math.round(above / moved.length * 100) + '%)' : '-'],
    ['Strong Results, Sold Off', watch]
  ];
  sh.getRange(4, 1, 1, tiles.length).setValues([tiles.map(function (t) { return t[0]; })])
    .setFontColor('#666666').setFontSize(9).setFontWeight('bold').setBackground('#f1f3f4');
  sh.getRange(5, 1, 1, tiles.length).setNumberFormat('@');
  sh.getRange(5, 3, 1, 2).setNumberFormat(pctFmt);
  sh.getRange(5, 1, 1, tiles.length).setValues([tiles.map(function (t) { return t[1]; })])
    .setFontSize(14).setFontWeight('bold').setBackground('#f8f9fb');
  sh.getRange(4, 1, 2, tiles.length).setBorder(true, true, true, true, true, false, '#dadce0', SpreadsheetApp.BorderStyle.SOLID);
  const bw = [];
  if (best) bw.push('Best: ' + best.symbol + ' ' + (best.sincePct >= 0 ? '+' : '') + (best.sincePct * 100).toFixed(1) + '%');
  if (worst && worst !== best) bw.push('Worst: ' + worst.symbol + ' ' + (worst.sincePct >= 0 ? '+' : '') + (worst.sincePct * 100).toFixed(1) + '%');
  sh.getRange(7, 1).setValue(bw.join('    ·    ') || 'No price moves to compare yet.').setFontColor('#444444');

  // Verdict breakdown (H4:L7) - are strong results being rewarded?
  const bd = [['Results Verdict', 'Stocks', 'Avg % Since Results', '% Positive', 'Avg Result-Day %']];
  ['Strong', 'Mixed', 'Weak'].forEach(function (v) {
    const g = seasonRows.filter(function (x) { return x.verdict === v; });
    const gm = g.filter(function (x) { return !isNaN(x.sincePct); });
    const gr = g.filter(function (x) { return !isNaN(x.rdPct); });
    bd.push([v, g.length,
      blank(mean(gm.map(function (x) { return x.sincePct; }))),
      gm.length ? gm.filter(function (x) { return x.sincePct > 0; }).length / gm.length : '',
      blank(mean(gr.map(function (x) { return x.rdPct; })))]);
  });
  const bdR = sh.getRange(4, 8, bd.length, 5);
  bdR.setValues(bd);
  sh.getRange(4, 8, 1, 5).setFontColor('#666666').setFontSize(9).setFontWeight('bold').setBackground('#f1f3f4');
  sh.getRange(5, 10, 3, 1).setNumberFormat(pctFmt);
  sh.getRange(5, 11, 3, 1).setNumberFormat('0%');
  sh.getRange(5, 12, 3, 1).setNumberFormat(pctFmt);
  sh.getRange(5, 8, 3, 1).setFontWeight('bold');
  bdR.setBorder(true, true, true, true, true, true, '#dadce0', SpreadsheetApp.BorderStyle.SOLID);

  // ---- main table ----
  const ci = function (name) { return AB_RP_COLS.indexOf(name) + 1; };
  sh.getRange(H, 1, 1, W).setValues([AB_RP_COLS])
    .setFontWeight('bold').setFontColor('#ffffff').setBackground('#1f3a5f').setWrap(true).setVerticalAlignment('middle');
  sh.setRowHeight(H, 36);

  const n = list.length;
  if (n) {
    const body = sh.getRange(H + 1, 1, n, W);
    // Formats first - Quarter must be plain text BEFORE it's written or
    // Sheets turns "Sep 2026" into a date.
    sh.getRange(H + 1, ci('Quarter'), n, 1).setNumberFormat('@');
    sh.getRange(H + 1, ci('Result Date'), n, 1).setNumberFormat('dd/mm/yyyy');
    sh.getRange(H + 1, ci('Last Refreshed'), n, 1).setNumberFormat('dd/mm/yyyy hh:mm');
    sh.getRange(H + 1, ci('Days Since'), n, 1).setNumberFormat('0');
    ['Pre-Result Close', 'Current Price', 'Result Day Close', 'Next Day Close', 'Highest Since', 'Lowest Since']
      .forEach(function (c) { sh.getRange(H + 1, ci(c), n, 1).setNumberFormat('#,##0.00'); });
    ['Result Day %', 'Next Day %', 'Today %', '% Since Results', 'Max Gain %', 'Max Drawdown %']
      .forEach(function (c) { sh.getRange(H + 1, ci(c), n, 1).setNumberFormat(pctFmt); });
    ['Rev QoQ %', 'Rev YoY %', 'NP QoQ %', 'NP YoY %']
      .forEach(function (c) { sh.getRange(H + 1, ci(c), n, 1).setNumberFormat('+0%;-0%;0%'); });

    const out = list.map(function (x) {
      return [
        '=HYPERLINK("' + ab_chartUrl_(x.symbol) + '","' + x.symbol + '")',
        x.company, x.basicIndustry, x.quarter, x.rd, blank(x.days),
        blank(x.base), blank(x.rdPct), blank(x.nextPct), blank(x.cur), blank(x.todayPct), blank(x.sincePct),
        blank(x.maxGain), blank(x.maxDD), x.verdict, x.reaction, x.signal,
        blank(x.revQoQ), blank(x.revYoY), blank(x.npQoQ), blank(x.npYoY), x.opmQoQ, x.opmYoY,
        blank(x.rdClose), blank(x.nextClose), blank(x.hi), blank(x.lo), nowDate
      ];
    });
    body.setValues(out);
    body.setVerticalAlignment('middle').setFontSize(10);
    sh.getRange(H + 1, 1, n, 1).setFontWeight('bold');
    sh.getRange(H + 1, ci('% Since Results'), n, 1).setFontWeight('bold');
    // Light grey for the raw reference columns on the far right.
    sh.getRange(H + 1, ci('Result Day Close'), n, 5).setFontColor('#888888');
    sh.getRange(H, 1, n + 1, W).setBorder(null, null, true, null, null, true, '#e3e3e3', SpreadsheetApp.BorderStyle.SOLID);
    sh.getRange(H, 1, n + 1, W).createFilter();

    // ---- colour rules ----
    const rules = [];
    const R = function (name) { return sh.getRange(H + 1, ci(name), n, 1); };
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .setGradientMinpointWithValue('#e67c73', SpreadsheetApp.InterpolationType.NUMBER, '-0.15')
      .setGradientMidpointWithValue('#ffffff', SpreadsheetApp.InterpolationType.NUMBER, '0')
      .setGradientMaxpointWithValue('#57bb8a', SpreadsheetApp.InterpolationType.NUMBER, '0.15')
      .setRanges([R('% Since Results')]).build());
    const signed = ['Result Day %', 'Next Day %', 'Today %', 'Max Gain %', 'Max Drawdown %',
                    'Rev QoQ %', 'Rev YoY %', 'NP QoQ %', 'NP YoY %'].map(R)
      .concat([sh.getRange(5, 3, 1, 2), sh.getRange(5, 10, 3, 1), sh.getRange(5, 12, 3, 1)]);
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0).setFontColor(AB_C_POS).setRanges(signed).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(0).setFontColor(AB_C_NEG).setRanges(signed).build());
    const verdictR = [R('Results Verdict'), sh.getRange(5, 8, 3, 1)];
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Strong').setBackground('#d9f2e3').setFontColor(AB_C_POS).setRanges(verdictR).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Mixed').setBackground('#fff4d6').setFontColor(AB_C_WARN).setRanges(verdictR).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Weak').setBackground('#fde2e1').setFontColor(AB_C_NEG).setRanges(verdictR).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Rallied').setFontColor(AB_C_POS).setBold(true).setRanges([R('Market Reaction')]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Sold off').setFontColor(AB_C_NEG).setBold(true).setRanges([R('Market Reaction')]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Flat').setFontColor(AB_C_MUTED).setRanges([R('Market Reaction')]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextContains('watch').setBackground('#e3edfd').setFontColor(AB_C_INFO).setBold(true).setRanges([R('Signal')]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextContains('caution').setBackground('#fff0e0').setFontColor('#b45309').setBold(true).setRanges([R('Signal')]).build());
    ['OPM QoQ', 'OPM YoY'].forEach(function (c) {
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextContains('ncreas').setFontColor(AB_C_POS).setRanges([R(c)]).build());
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextContains('ecreas').setFontColor(AB_C_NEG).setRanges([R(c)]).build());
    });
    sh.setConditionalFormatRules(rules);
  } else {
    sh.getRange(H + 1, 1).setValue('No companies confirmed yet - rows appear here as the Results Day check updates them in Main.')
      .setFontColor('#888888');
  }

  sh.setFrozenRows(H);
  sh.setFrozenColumns(1);
  sh.setColumnWidth(1, 110);
  sh.setColumnWidth(2, 210);
  sh.setColumnWidth(3, 170);
  sh.setColumnWidth(ci('Signal'), 210);
  for (let c = 4; c <= W; c++) {
    if (c === ci('Signal')) continue;
    sh.setColumnWidth(c, 92);
  }
}

/*****************************************************************
 * PATTERN DASHBOARD
 * -----------------------------------------------------------------
 * Replaces the old hand-made pivot tables on this tab. Those had two
 * problems: their source range stopped at Main row 881 (Main is ~1,800
 * rows now, so half the watchlist was invisible), and they counted the
 * Pattern cell's whole text - "Bullish Engulfing, Spring?" was its own
 * "pattern" - so nothing added up. They also ignored FVG and EMA
 * support completely.
 *
 * Rebuilt from scratch by the script (menu: 7. Dashboards > Rebuild
 * Pattern Dashboard, and automatically at the end of Daily Pipeline
 * Phase 2, right after the patterns are recomputed):
 *
 *   KPI tiles     how many stocks carry each kind of signal today
 *   Signals       one row per INDIVIDUAL signal (each candlestick
 *                 pattern, each FVG state, 10/21 EMA support) - how many
 *                 stocks, how many of them are fresh today, how they're
 *                 trading (avg day / 10-day / 30-day %, % advancing),
 *                 and which Basic Industry has the most of them
 *   Chart         stocks per signal, at a glance
 *   Clusters      Basic Industries where signals are bunching up
 *   Every stock   the full list with all its signals side by side, a
 *                 Confluence count (how many of the 4 signal types it
 *                 has at once), price performance and TTM Signal -
 *                 sorted strongest confluence first, with filters
 *****************************************************************/
const AB_PATTERN_DASH_SHEET = 'Pattern Dashboard';

/** "FVG First Touch (3d ago)" -> "FVG First Touch"; "Gap-up FVG 4.81% (2d ago)" -> "Gap-up FVG". */
function ab_pdNormTag_(t) {
  return String(t || '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/^Gap-up FVG.*$/i, 'Gap-up FVG').replace(/\s+/g, ' ').trim();
}

/** Comma-split that keeps "(...)" groups together. */
function ab_pdSplit_(text) {
  return String(text || '').split(/,(?![^()]*\))/).map(function (s) { return s.trim(); }).filter(Boolean);
}

/** Is this tag about today (a candlestick pattern always is; FVG/EMA say so in brackets)? */
function ab_pdIsFresh_(raw, group) {
  if (group === 'Pattern') return true;
  return /\((today|formed today)\)/i.test(raw) || /\(today\)/i.test(raw);
}

function ab_buildPatternDashboard_() {
  const layout = ab_getMainLayout_();
  const data = layout.data;
  const num = function (r, c) { return c === -1 || c === undefined ? NaN : ab_toNum_(data[r][c]); };
  const txt = function (r, c) { return c === -1 || c === undefined ? '' : ab_cellText_(data[r][c]); };
  // % columns are read off their DISPLAY text so the unit is always right:
  // Main's % Change holds 1.5 for 1.5% while 10 day% / 30Day% hold 0.015
  // behind a % format - both display as "1.5..." so text/100 works for all.
  const display = layout.sheet.getDataRange().getDisplayValues();
  const pctOf = function (r, c) {
    if (c === -1 || c === undefined) return NaN;
    const t = String(display[r][c] || '').trim();
    if (!t || /^#/.test(t)) return NaN;
    const n = Number(t.replace(/[%,+\s]/g, ''));
    return isNaN(n) ? NaN : n / 100;
  };

  // ---- collect every stock's signals ----
  const stocks = [];
  let scanned = 0;
  for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
    const sym = txt(r, layout.symbol).toUpperCase();
    const name = txt(r, layout.name);
    if (!sym && !name) break;
    if (!sym) continue;
    scanned++;
    const s = {
      symbol: sym, name: name, industry: txt(r, layout.basicIndustry) || '(none)',
      pattern: txt(r, layout.pattern), fvg: txt(r, layout.fvg),
      ema10: txt(r, layout.emaSupport10), ema21: txt(r, layout.emaSupport21),
      day: pctOf(r, layout.pctChange), d10: pctOf(r, layout.tenDayPct), d30: pctOf(r, layout.thirtyDayPct),
      price: num(r, layout.mktPrice), ttm: txt(r, layout.ttmSignal), tags: []
    };
    ab_pdSplit_(s.pattern).forEach(function (t) { s.tags.push({ group: 'Pattern', name: ab_pdNormTag_(t), fresh: true }); });
    ab_pdSplit_(s.fvg).forEach(function (t) { s.tags.push({ group: 'FVG', name: ab_pdNormTag_(t), fresh: ab_pdIsFresh_(t, 'FVG') }); });
    [s.ema10, s.ema21].forEach(function (t) {
      if (t) s.tags.push({ group: 'EMA support', name: ab_pdNormTag_(t), fresh: ab_pdIsFresh_(t, 'EMA') });
    });
    s.confluence = [s.pattern, s.fvg, s.ema10, s.ema21].filter(Boolean).length;
    // On the full list: anything with a pattern or FVG tag, or EMA support that's fresh today.
    s.listed = !!(s.pattern || s.fvg || s.tags.some(function (t) { return t.group === 'EMA support' && t.fresh; }));
    stocks.push(s);
  }

  const mean = function (a) {
    const v = a.filter(function (x) { return !isNaN(x); });
    return v.length ? v.reduce(function (p, c) { return p + c; }, 0) / v.length : '';
  };

  // ---- one row per individual signal ----
  const sig = {};
  stocks.forEach(function (s) {
    const seen = {};
    s.tags.forEach(function (t) {
      const k = t.group + '|' + t.name;
      if (seen[k]) return; // same signal twice on one stock counts once
      seen[k] = true;
      if (!sig[k]) sig[k] = { group: t.group, name: t.name, stocks: [], fresh: 0, inds: {} };
      sig[k].stocks.push(s);
      if (t.fresh) sig[k].fresh++;
      sig[k].inds[s.industry] = (sig[k].inds[s.industry] || 0) + 1;
    });
  });
  const groupOrder = { 'Pattern': 0, 'FVG': 1, 'EMA support': 2 };
  const sigRows = Object.keys(sig).map(function (k) { return sig[k]; }).sort(function (a, b) {
    return (groupOrder[a.group] - groupOrder[b.group]) || (b.stocks.length - a.stocks.length);
  }).map(function (g) {
    const days = g.stocks.map(function (s) { return s.day; }).filter(function (x) { return !isNaN(x); });
    const topInd = Object.keys(g.inds).sort(function (a, b) { return g.inds[b] - g.inds[a]; })[0] || '';
    return [g.group, g.name, g.stocks.length, g.fresh,
      mean(g.stocks.map(function (s) { return s.day; })),
      days.length ? days.filter(function (x) { return x > 0; }).length / days.length : '',
      mean(g.stocks.map(function (s) { return s.d10; })),
      mean(g.stocks.map(function (s) { return s.d30; })),
      topInd ? topInd + ' (' + g.inds[topInd] + ')' : ''];
  });

  // ---- industry clusters ----
  const listed = stocks.filter(function (s) { return s.listed; });
  const byInd = {};
  listed.forEach(function (s) {
    if (!byInd[s.industry]) byInd[s.industry] = { stocks: [], tags: {} };
    byInd[s.industry].stocks.push(s);
    s.tags.forEach(function (t) { if (t.fresh) byInd[s.industry].tags[t.name] = (byInd[s.industry].tags[t.name] || 0) + 1; });
  });
  const clusterRows = Object.keys(byInd).filter(function (k) { return byInd[k].stocks.length >= 2 && k !== '(none)'; })
    .sort(function (a, b) { return byInd[b].stocks.length - byInd[a].stocks.length; }).slice(0, 15)
    .map(function (k) {
      const c = byInd[k];
      const mix = Object.keys(c.tags).sort(function (a, b) { return c.tags[b] - c.tags[a]; }).slice(0, 4)
        .map(function (t) { return t + ' ' + c.tags[t]; }).join(', ');
      const m = mean(c.stocks.map(function (s) { return s.day; }));
      return [k, c.stocks.length, c.stocks.filter(function (s) { return s.confluence >= 2; }).length, m,
              mix, c.stocks.slice().sort(function (a, b) { return b.confluence - a.confluence || (b.day || 0) - (a.day || 0); })
                .slice(0, 6).map(function (s) { return s.symbol; }).join(', ')];
    });

  // ---- the full list ----
  listed.sort(function (a, b) {
    return (b.confluence - a.confluence) || ((isNaN(b.day) ? -1e9 : b.day) - (isNaN(a.day) ? -1e9 : a.day));
  });
  const detailRows = listed.map(function (s) {
    return ['=HYPERLINK("' + ab_chartUrl_(s.symbol) + '","' + s.symbol + '")', s.name, s.industry,
      s.pattern, s.fvg, s.ema10, s.ema21, s.confluence,
      isNaN(s.day) ? '' : s.day, isNaN(s.d10) ? '' : s.d10, isNaN(s.d30) ? '' : s.d30,
      isNaN(s.price) ? '' : s.price, s.ttm,
      '=HYPERLINK("' + ab_screenerUrl_(s.symbol) + '","screener")'];
  });

  // ---- KPI tiles ----
  const withPattern = stocks.filter(function (s) { return s.pattern; });
  const strictPattern = stocks.filter(function (s) { return ab_pdSplit_(s.pattern).some(function (t) { return t !== 'Spring?'; }); });
  const freshFvg = stocks.filter(function (s) { return s.tags.some(function (t) { return t.group === 'FVG' && t.fresh; }); });
  const freshEma = stocks.filter(function (s) { return s.tags.some(function (t) { return t.group === 'EMA support' && t.fresh; }); });
  const conf3 = stocks.filter(function (s) { return s.confluence >= 3; });
  const advancing = withPattern.filter(function (s) { return s.day > 0; }).length;
  const tiles = [
    ['Stocks scanned', scanned],
    ['With a pattern', withPattern.length + ' (' + strictPattern.length + ' excl. Spring?)'],
    ['New FVG signal today', freshFvg.length],
    ['EMA support today', freshEma.length],
    ['Confluence 3+ signal types', conf3.length],
    ['Pattern stocks up today', withPattern.length ? Math.round(advancing / withPattern.length * 100) + '%' : '-']
  ];

  ab_pdWriteSheet_(tiles, sigRows, clusterRows, detailRows);
  return { scanned: scanned, signals: sigRows.length, listed: detailRows.length };
}

function ab_pdWriteSheet_(tiles, sigRows, clusterRows, detailRows) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ab_getOrCreateSheet_(AB_PATTERN_DASH_SHEET);
  const W = 14;
  const pct = '+0.00%;-0.00%;0.00%';
  const NAVY = '#1f3a5f';

  // ---- clear out the old pivots, charts, filter and formatting ----
  try { sh.getPivotTables().forEach(function (p) { p.remove(); }); } catch (e) { Logger.log('Pivot removal: ' + e.message); }
  sh.getCharts().forEach(function (c) { sh.removeChart(c); });
  const f = sh.getFilter();
  if (f) f.remove();
  sh.setConditionalFormatRules([]);
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart();
  sh.clear();
  if (sh.getMaxColumns() < W) sh.insertColumnsAfter(sh.getMaxColumns(), W - sh.getMaxColumns());
  sh.setHiddenGridlines(true);

  const sectionTitle = function (row, text, sub) {
    sh.getRange(row, 1).setValue(text).setFontSize(13).setFontWeight('bold').setFontColor(NAVY);
    if (sub) sh.getRange(row + 1, 1).setValue(sub).setFontColor('#777777').setFontSize(9);
  };
  const header = function (row, labels) {
    sh.getRange(row, 1, 1, labels.length).setValues([labels]).setFontWeight('bold').setFontColor('#ffffff')
      .setBackground(NAVY).setWrap(true).setVerticalAlignment('middle');
    sh.setRowHeight(row, 32);
  };
  const rules = [];
  const signColour = function (ranges) {
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0).setFontColor(AB_C_POS).setRanges(ranges).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(0).setFontColor(AB_C_NEG).setRanges(ranges).build());
  };

  // ---- title + tiles ----
  sh.getRange(1, 1).setValue('Pattern Dashboard').setFontSize(18).setFontWeight('bold').setFontColor(NAVY);
  sh.getRange(2, 1).setValue('Patterns, FVG and EMA support across the whole Main watchlist · refreshed ' +
    Utilities.formatDate(new Date(), AB_TZ, 'dd/MM/yyyy HH:mm') + ' IST (rebuilt automatically after the patterns run each evening)')
    .setFontColor('#777777').setFontSize(9);
  sh.getRange(4, 1, 1, tiles.length).setValues([tiles.map(function (t) { return t[0]; })])
    .setFontSize(9).setFontWeight('bold').setFontColor('#666666').setBackground('#f1f3f4').setWrap(true);
  sh.getRange(5, 1, 1, tiles.length).setNumberFormat('@').setValues([tiles.map(function (t) { return String(t[1]); })])
    .setFontSize(15).setFontWeight('bold').setFontColor(NAVY).setBackground('#f8f9fb');
  sh.getRange(4, 1, 2, tiles.length).setBorder(true, true, true, true, true, false, '#dadce0', SpreadsheetApp.BorderStyle.SOLID)
    .setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.setRowHeight(5, 36);

  // ---- signals summary ----
  let row = 7;
  sectionTitle(row, 'Signals summary', 'One row per individual signal. "Fresh" = formed / touched today. Averages are across every stock carrying that signal.');
  row += 2;
  const sigHead = ['Type', 'Signal', 'Stocks', 'Fresh today', 'Avg % Change', '% Advancing', 'Avg 10-day %', 'Avg 30-day %', 'Most common Basic Industry'];
  header(row, sigHead);
  const sigStart = row + 1;
  if (sigRows.length) {
    sh.getRange(sigStart, 5, sigRows.length, 1).setNumberFormat(pct);
    sh.getRange(sigStart, 6, sigRows.length, 1).setNumberFormat('0%');
    sh.getRange(sigStart, 7, sigRows.length, 2).setNumberFormat(pct);
    sh.getRange(sigStart, 1, sigRows.length, sigHead.length).setValues(sigRows);
    sh.getRange(sigStart, 2, sigRows.length, 1).setFontWeight('bold');
    sh.getRange(sigStart, 1, sigRows.length, 1).setFontColor('#777777').setFontSize(9);
    // Band each signal type so the three groups read as blocks.
    const bands = { 'Pattern': '#eef4fb', 'FVG': '#f3effa', 'EMA support': '#eef8f1' };
    sh.getRange(sigStart, 1, sigRows.length, 1).setBackgrounds(sigRows.map(function (r) { return [bands[r[0]] || '#ffffff']; }));
    signColour([sh.getRange(sigStart, 5, sigRows.length, 1), sh.getRange(sigStart, 7, sigRows.length, 2)]);
    rules.push(SpreadsheetApp.newConditionalFormatRule().setGradientMaxpoint('#4a7fd4').setGradientMinpointWithValue('#ffffff', SpreadsheetApp.InterpolationType.NUMBER, '0')
      .setRanges([sh.getRange(sigStart, 3, sigRows.length, 1)]).build());
    sh.getRange(row, 1, sigRows.length + 1, sigHead.length)
      .setBorder(null, null, true, null, null, true, '#e3e3e3', SpreadsheetApp.BorderStyle.SOLID);
  }

  // Chart: stocks per signal, beside the summary.
  if (sigRows.length) {
    const chart = sh.newChart().asBarChart()
      .addRange(sh.getRange(row, 2, sigRows.length + 1, 2))
      .setNumHeaders(1)
      .setTitle('Stocks per signal')
      .setLegendPosition(Charts.Position.NONE)
      .setColors(['#1558d6'])
      .setOption('hAxis', { gridlines: { color: '#eeeeee' }, textStyle: { color: '#777777' } })
      .setOption('vAxis', { textStyle: { color: '#444444', fontSize: 10 } })
      .setOption('series', { 0: { dataLabel: 'value', dataLabelPlacement: 'outsideEnd' } })
      .setOption('bar', { groupWidth: '70%' })
      .setPosition(row, 11, 0, 0)
      .setOption('width', 520)
      .setOption('height', Math.max(260, 26 * sigRows.length + 80))
      .build();
    sh.insertChart(chart);
  }
  row = sigStart + Math.max(sigRows.length, 1) + 2;

  // ---- industry clusters ----
  sectionTitle(row, 'Where signals are clustering', 'Basic Industries with 2+ signalled stocks (top 15). Mix counts fresh signals only.');
  row += 2;
  const clHead = ['Basic Industry', 'Signalled stocks', 'With 2+ signal types', 'Avg % Change', 'Signal mix (fresh)', 'Strongest names'];
  header(row, clHead);
  const clStart = row + 1;
  if (clusterRows.length) {
    sh.getRange(clStart, 4, clusterRows.length, 1).setNumberFormat(pct);
    sh.getRange(clStart, 1, clusterRows.length, clHead.length).setValues(clusterRows);
    sh.getRange(clStart, 1, clusterRows.length, 1).setFontWeight('bold');
    signColour([sh.getRange(clStart, 4, clusterRows.length, 1)]);
    sh.getRange(row, 1, clusterRows.length + 1, clHead.length)
      .setBorder(null, null, true, null, null, true, '#e3e3e3', SpreadsheetApp.BorderStyle.SOLID);
  } else {
    sh.getRange(clStart, 1).setValue('No industry has 2+ signalled stocks right now.').setFontColor('#888888');
  }
  row = clStart + Math.max(clusterRows.length, 1) + 2;

  // ---- every stock ----
  sectionTitle(row, 'Every stock with a signal (' + detailRows.length + ')',
    'Any Pattern or FVG tag, or EMA support fresh today. Confluence = how many of the 4 signal types (Pattern, FVG, 10 EMA, 21 EMA) it has at once. Use the filter buttons to sort / narrow.');
  row += 2;
  const dHead = ['Symbol', 'Company', 'Basic Industry', 'Pattern', 'FVG', '10 EMA', '21 EMA', 'Confluence',
                 '% Change', '10-day %', '30-day %', 'MKT Price', 'TTM Signal', 'Screener'];
  header(row, dHead);
  const dStart = row + 1;
  if (detailRows.length) {
    const need = dStart + detailRows.length + 2;
    if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
    sh.getRange(dStart, 9, detailRows.length, 3).setNumberFormat(pct);
    sh.getRange(dStart, 12, detailRows.length, 1).setNumberFormat('#,##0.00');
    sh.getRange(dStart, 1, detailRows.length, W).setValues(detailRows).setFontSize(10).setVerticalAlignment('middle');
    sh.getRange(dStart, 1, detailRows.length, 1).setFontWeight('bold');
    sh.getRange(dStart, 4, detailRows.length, 4).setWrap(true).setFontSize(9);
    sh.getRange(dStart, 8, detailRows.length, 1).setHorizontalAlignment('center').setFontWeight('bold');
    signColour([sh.getRange(dStart, 9, detailRows.length, 3)]);
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThanOrEqualTo(3).setBackground('#cfe8d8').setFontColor('#0a6b3b')
      .setRanges([sh.getRange(dStart, 8, detailRows.length, 1)]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenNumberEqualTo(2).setBackground('#e8f5ee')
      .setRanges([sh.getRange(dStart, 8, detailRows.length, 1)]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Buy').setFontColor(AB_C_POS).setBold(true)
      .setRanges([sh.getRange(dStart, 13, detailRows.length, 1)]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Avoid').setFontColor(AB_C_MUTED)
      .setRanges([sh.getRange(dStart, 13, detailRows.length, 1)]).build());
    sh.getRange(row, 1, detailRows.length + 1, W)
      .setBorder(null, null, true, null, null, true, '#ececec', SpreadsheetApp.BorderStyle.SOLID);
    sh.getRange(row, 1, detailRows.length + 1, W).createFilter();
  } else {
    sh.getRange(dStart, 1).setValue('No signals on the watchlist right now.').setFontColor('#888888');
  }

  sh.setConditionalFormatRules(rules);
  const widths = [110, 200, 170, 150, 190, 150, 150, 85, 80, 80, 80, 85, 80, 75];
  widths.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.setFrozenRows(0);
  sh.setFrozenColumns(1);
}

/** Menu: rebuild the Pattern Dashboard now. */
function runPatternDashboardNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const r = ab_buildPatternDashboard_();
    ss.toast('Pattern Dashboard rebuilt - ' + r.signals + ' signals across ' + r.scanned + ' stocks, ' +
             r.listed + ' stocks listed.', 'Pattern Dashboard', 10);
  } catch (e) {
    ss.toast('Pattern Dashboard failed: ' + e.message);
  }
}

/** Menu: rebuild the Results Performance tab now. */
function runResultsPerformanceNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const r = ab_rpRefresh_();
    ss.toast(r.count + ' compan' + (r.count === 1 ? 'y' : 'ies') + ' on the "' + AB_RP_SHEET + '" tab, refreshed.',
             'Results Performance', 10);
  } catch (e) {
    ss.toast('Results Performance refresh failed: ' + e.message);
  }
}

/** Menu: show what's parked for the combined engine and why. */
function showParkedQuarterlyTrendSymbols() {
  const tooNew = ab_qt_getTooNew_();
  const unfillable = ab_qt_getUnfillable_();
  const now = Date.now();

  const waiting = [];
  Object.keys(tooNew).forEach(function (sym) {
    const due = Number(tooNew[sym] || 0);
    if (due > now) {
      waiting.push(sym + ' (recheck ' + Utilities.formatDate(new Date(due), AB_TZ, 'dd-MMM') + ')');
    }
  });
  const parked = Object.keys(unfillable).filter(function (s) {
    return (unfillable[s] || 0) >= AB_QT_SKIP_AFTER;
  });

  const msg =
    'Recently listed, waiting for more quarters (' + waiting.length + '):\n' +
    (waiting.length ? waiting.join(', ') : 'none') + '\n\n' +
    'No data on screener at all (' + parked.length + '):\n' +
    (parked.length ? parked.join(', ') : 'none');
  Logger.log(msg);
  SpreadsheetApp.getActiveSpreadsheet().toast(
    waiting.length + ' waiting for more quarters, ' + parked.length +
    ' with no data. Full list in the execution log.', 'Parked symbols (combined)', 30);
}

/** Menu: clear the combined engine's cursor, parking lists and cooldown. */
function resetQuarterlyTrendBackfillCursor() {
  const props = PropertiesService.getScriptProperties();
  ['all', 'missing'].forEach(function (m) {
    props.deleteProperty(AB_QT_CURSOR_PROP + '_' + m);
  });
  const parked = Object.keys(ab_qt_getUnfillable_()).length;
  const waiting = Object.keys(ab_qt_getTooNew_()).length;
  props.deleteProperty(AB_QT_UNFILLABLE_PROP);
  props.deleteProperty(AB_QT_TOONEW_PROP);
  props.deleteProperty(AB_QT_COOLDOWN_PROP);
  SpreadsheetApp.getActiveSpreadsheet().toast(
    'Reset - next combined run starts from the top' +
    (parked + waiting
      ? (' and re-checks ' + parked + ' parked + ' + waiting + ' recently-listed symbol(s).')
      : '.'));
}

/*****************************************************************
 * ALERT SYSTEM
 * -----------------------------------------------------------------
 * Main already had a hand-maintained "Alert System" block (Zone,
 * Price Fall Alert Price, Breakout Alert Price, Triggered Y/N,
 * Triggered Date, % Up/Down After Alert). This automates it:
 *
 *   1. You keep setting Price Fall / Breakout levels by hand.
 *   2. Each daily run compares the day's CLOSE against those levels.
 *   3. On a cross it stamps Triggered Y/N = 'Y' + Triggered Date,
 *      and appends a permanent row to the "Alert Log" tab capturing
 *      what the patterns looked like at that moment.
 *   4. Every run afterwards it re-prices every past alert so you can
 *      see whether it actually worked (% since alert, Win/Loss/Open).
 *   5. "Alert Dashboard" summarises hit rate by alert type.
 *
 * An alert only fires ONCE - the Triggered Y/N = 'Y' flag stops it
 * re-firing every day while price sits past the level. Clear that
 * flag (or use the menu's "Reset Triggered Flags") to re-arm.
 *****************************************************************/

/**
 * Locates Main's header row and resolves the alert-related columns by
 * NAME rather than fixed letters, so inserting a column in Main won't
 * silently point the alert engine at the wrong data.
 */
function ab_getMainLayout_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(AB_MAIN_SHEET);
  if (!sh) throw new Error('Could not find a "' + AB_MAIN_SHEET + '" tab.');
  const data = sh.getDataRange().getValues();

  let headerRowIdx = -1;
  for (let r = 0; r < Math.min(10, data.length); r++) {
    const row = data[r].map(v => String(v).trim());
    if (row.indexOf('StockName') !== -1 && row.indexOf('SYMBOL') !== -1) {
      headerRowIdx = r;
      break;
    }
  }
  if (headerRowIdx === -1) throw new Error('Could not find the StockName/SYMBOL header row in Main.');

  const header = data[headerRowIdx].map(v => String(v).trim());
  function col(name) { return header.indexOf(name); }

  // Loose match: compares letters and digits only, so punctuation and
  // spacing differences don't matter. Needed for the growth columns -
  // e.g. Main's header is "QoQ[Revenue Growth%}" with a closing BRACE
  // rather than a bracket, which no exact match would ever find.
  const normHeader = header.map(ab_normHeader_);
  function colNorm(name) { return normHeader.indexOf(ab_normHeader_(name)); }

  const patternCol = col('Pattern');
  const layout = {
    sheet: sh,
    data: data,
    headerRowIdx: headerRowIdx,
    name: col('StockName'),
    sector: col('Sector'),
    industry: col('Industry'),
    symbol: col('SYMBOL'),
    mcap: col('MCAP(CR)'),
    mktPrice: col('MKT Price'),
    pctChange: col('% Change'),
    zone: col('Zone'),
    fallLevel: col('Price Fall Alert Price'),
    breakLevel: col('Breakout Alert Price'),
    entryPrice: col('Entry Price'),
    stoploss: col('Stoploss'),
    triggered: col('Triggered Y/N'),
    trigDate: col('Triggered Date'),
    pctAfter: col('% Up/Down After Alert'),
    winLoss: col('Win/Loss'),
    ipoLevel: col('IPO Level'),
    pattern: patternCol,
    // The FVG tag column sits immediately right of Pattern (AY -> AZ).
    // Its own header still reads "Doc" from an earlier use, so it can't
    // be found by name - derive it from Pattern's position instead.
    fvg: patternCol === -1 ? -1 : patternCol + 1,
    // Extra fields for the detailed alert card/email (see ab_buildRowDetails_
    // below) - resolved by name like everything else here.
    header: header,
    qrCheckbox: col('Checkbox'), // "Quarterly Results" tick box, col A
    basicIndustry: col('Basic Industry'),
    // Which NSE indices this symbol belongs to (e.g. "NIFTY IPO",
    // "SMALLCAP50") - may list more than one, comma/newline-separated.
    // Used by the SYMBOL-cell colour-coding below. -1 if the column
    // doesn't exist, which the colour-coder treats as "skip, don't fail".
    indices: col('INDICES'),
    peVsIndustryPe: col('PE vs Industry PE'),
    pegRatioCol: col('PEG Ratio'),
    // Quarterly results growth columns - matched loosely, see colNorm above.
    resultDate: col('Result Date'),
    qoqRev: colNorm('QoQ Revenue Growth %'),
    qoqNp: colNorm('QoQ NP Growth %'),
    yoyRev: colNorm('YoY Revenue Growth %'),
    yoyNp: colNorm('YoY NP Growth %'),
    ttmEps: colNorm('TTM EPS'),
    lastFyEps: colNorm('Last FY EPS'),
    // Optional - how many shares you actually hold for an open trade.
    // Main doesn't have this column today; the Risk Manager works
    // fine without it (sizing its heat estimate off the target risk %
    // instead), but if you ever add a "Qty"/"Quantity"/"Shares" column
    // it'll switch to using your real holdings for exact figures.
    qty: (function () {
      const names = ['Qty', 'Quantity', 'Shares', 'No of Shares', 'No. of Shares'];
      for (let i = 0; i < names.length; i++) {
        const idx = colNorm(names[i]);
        if (idx !== -1) return idx;
      }
      return -1;
    })()
  };

  // Fields for the Quality Watch email (ab_qualityWatchSymbols_ /
  // sendQualityWatchEmail_) - the TTM-based valuation chain specifically
  // (TTM EPS Growth / TTM PEG Ratio / TargetPrice / TTM Signal / Upside
  // Potential all reference each other's cells in Main's own formulas),
  // not the separate non-TTM EPS/EPS Growth%/PEG Ratio/Target Price/
  // Signal chain that sits right next to it under the same category.
  layout.ttmSignal = col('TTM Signal');
  layout.upsidePotential = col('Upside Potential');
  layout.targetPrice = col('TargetPrice');
  layout.ttmEpsGrowth = col('TTM EPS Growth');
  layout.ttmPegRatio = col('TTM PEG Ratio');
  layout.promotorHolding = col('Promotor Holding');
  layout.fiiActivity = col('FII Activity');
  layout.opmYoY = col(AB_TT_OPM_YOY_HEADER);
  layout.opmQoQ = col(AB_TT_OPM_QOQ_HEADER);
  layout.tenDayPct = col('10 day%');
  layout.thirtyDayPct = col('30Day%');
  // Trailing-space/punctuation quirks in Main's real headers ("10 EMA ",
  // "%vol Change") - loose match folds those away, same as qoqRev etc.
  layout.emaSupport10 = colNorm('10 EMA');
  layout.emaSupport21 = colNorm('21 EMA');
  layout.volChangePct = colNorm('Vol Change %');

  const missing = [];
  if (layout.symbol === -1) missing.push('SYMBOL');
  if (layout.fallLevel === -1) missing.push('Price Fall Alert Price');
  if (layout.breakLevel === -1) missing.push('Breakout Alert Price');
  if (layout.triggered === -1) missing.push('Triggered Y/N');
  if (missing.length) {
    throw new Error('Main is missing expected alert column(s): ' + missing.join(', '));
  }
  return layout;
}

// =====================================================================
// BASIC INDUSTRY PE -> MAIN  (manual, run from the menu whenever you like)
// =====================================================================
// Type a new PE in the "Updated PE" column of the BasicIndustry PE tab,
// then run  8. Symbols, Indices & Main Upkeep > Apply Updated Industry PE
// to Main. Every stock in Main with that Basic Industry gets the new
// Industry PE.
//
// How it writes: Main's "Industry PE" column is normally ONE array
// formula (in the header cell) that looks each stock's Basic Industry up
// in BasicIndustry PE columns A:B. Typing values into Main would break
// that formula, so instead the Updated PE is copied into the tab's
// "Industry PE" column - the formula then carries it to every matching
// stock automatically. If the Main column is ever plain values (no
// formula), the matching Main cells are written directly instead.
// "Updated PE" itself is left as you typed it, so re-running is harmless.
const AB_INDUSTRY_PE_SHEET = 'BasicIndustry PE';

/** Lower-case, trimmed, single-spaced - so "Airline " matches "airline". */
function ab_ipeKey_(s) {
  return String(s === null || s === undefined ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();
}

/** A usable PE number from a cell (number or text like "45.2"), else null. */
function ab_ipeNum_(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  return isFinite(n) ? n : null;
}

function ab_applyUpdatedIndustryPe_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ip = ss.getSheetByName(AB_INDUSTRY_PE_SHEET);
  if (!ip) throw new Error('Could not find the "' + AB_INDUSTRY_PE_SHEET + '" tab.');

  // ---- 1. Read the BasicIndustry PE tab (columns found by header name) ----
  const ipVals = ip.getDataRange().getValues();
  let h = -1, cInd = -1, cPe = -1, cUpd = -1;
  for (let r = 0; r < Math.min(10, ipVals.length); r++) {
    const row = ipVals[r].map(ab_normHeader_);
    const upd = row.indexOf('UPDATEDPE');
    if (upd === -1) continue;
    let ind = row.indexOf('BASICINDUSTRYTYPE');
    if (ind === -1) ind = row.indexOf('BASICINDUSTRY');
    const pe = row.indexOf('INDUSTRYPE');
    if (ind !== -1 && pe !== -1) { h = r; cInd = ind; cPe = pe; cUpd = upd; break; }
  }
  if (h === -1) {
    throw new Error('In "' + AB_INDUSTRY_PE_SHEET + '", could not find the header row with ' +
      '"Basic Industry Type", "Industry PE" and "Updated PE".');
  }

  const updates = {};   // key -> { name, row, oldPe, newPe }
  const invalid = [];   // Updated PE cells that aren't numbers
  for (let r = h + 1; r < ipVals.length; r++) {
    const name = String(ipVals[r][cInd] || '').trim();
    const raw = ipVals[r][cUpd];
    if (!name || raw === '' || raw === null) continue;
    const n = ab_ipeNum_(raw);
    if (n === null || n <= 0) { invalid.push(name + ' ("' + raw + '")'); continue; }
    updates[ab_ipeKey_(name)] = { name: name, row: r, oldPe: ipVals[r][cPe], newPe: n };
  }
  const keys = Object.keys(updates);
  if (!keys.length) {
    return { applied: [], unmatched: [], invalid: invalid, mode: 'none', totalStocks: 0, noValues: true };
  }

  // ---- 2. Look at Main ----
  const layout = ab_getMainLayout_();
  const sh = layout.sheet;
  const indCol = layout.header.indexOf('Industry PE');
  if (layout.basicIndustry === -1) throw new Error('Main has no "Basic Industry" column.');
  if (indCol === -1) throw new Error('Main has no "Industry PE" column.');

  const hdrRow = layout.headerRowIdx + 1;      // 1-based header row
  const firstRow = hdrRow + 1;
  const nRows = layout.data.length - layout.headerRowIdx - 1;
  const hdrFormula = sh.getRange(hdrRow, indCol + 1).getFormula();
  const firstFormula = nRows > 0 ? sh.getRange(firstRow, indCol + 1).getFormula() : '';
  const formulaDriven = /BasicIndustry PE/i.test(hdrFormula + ' ' + firstFormula);

  // Count stocks per industry (and their current Industry PE) in Main.
  const counts = {};
  for (let r = layout.headerRowIdx + 1; r < layout.data.length; r++) {
    const k = ab_ipeKey_(layout.data[r][layout.basicIndustry]);
    if (k && updates[k]) counts[k] = (counts[k] || 0) + 1;
  }

  // ---- 3. Write ----
  if (formulaDriven) {
    // Copy Updated PE into the tab's Industry PE column (one batched write).
    const colVals = ip.getRange(h + 2, cPe + 1, ipVals.length - h - 1, 1).getValues();
    const colForms = ip.getRange(h + 2, cPe + 1, ipVals.length - h - 1, 1).getFormulas();
    for (let i = 0; i < colVals.length; i++) if (colForms[i][0]) colVals[i][0] = colForms[i][0];
    keys.forEach(function (k) { colVals[updates[k].row - h - 1][0] = updates[k].newPe; });
    ip.getRange(h + 2, cPe + 1, colVals.length, 1).setValues(colVals);
  } else if (nRows > 0) {
    // Main's column is plain values: write the matching stocks directly,
    // keeping any formulas that happen to sit in that column.
    const rng = sh.getRange(firstRow, indCol + 1, nRows, 1);
    const vals = rng.getValues();
    const forms = rng.getFormulas();
    for (let i = 0; i < nRows; i++) {
      const k = ab_ipeKey_(layout.data[layout.headerRowIdx + 1 + i][layout.basicIndustry]);
      if (forms[i][0]) vals[i][0] = forms[i][0];
      else if (k && updates[k]) vals[i][0] = updates[k].newPe;
    }
    rng.setValues(vals);
  }
  SpreadsheetApp.flush();

  const applied = [], unmatched = [];
  let totalStocks = 0;
  keys.forEach(function (k) {
    const u = updates[k];
    const c = counts[k] || 0;
    if (!c) { unmatched.push(u.name); return; }
    totalStocks += c;
    applied.push({ name: u.name, oldPe: u.oldPe, newPe: u.newPe, stocks: c });
  });
  applied.sort(function (a, b) { return b.stocks - a.stocks; });
  return { applied: applied, unmatched: unmatched, invalid: invalid,
           mode: formulaDriven ? 'formula' : 'values', totalStocks: totalStocks };
}

/** Menu: 8. Symbols, Indices & Main Upkeep > Apply Updated Industry PE to Main */
function runApplyUpdatedIndustryPeNow() {
  const ui = SpreadsheetApp.getUi();
  try {
    const res = ab_applyUpdatedIndustryPe_();
    if (res.noValues) {
      let m = 'No numbers found in the "Updated PE" column of "' + AB_INDUSTRY_PE_SHEET + '".\n\n' +
        'Type the new PE next to an industry, then run this again.';
      if (res.invalid.length) m += '\n\nNot a valid PE (skipped): ' + res.invalid.join(', ');
      ui.alert('Apply Updated Industry PE', m, ui.ButtonSet.OK);
      return;
    }
    const fmt = function (v) {
      const n = ab_ipeNum_(v);
      return n === null ? (v === '' || v === null ? '(blank)' : String(v)) : String(Math.round(n * 100) / 100);
    };
    const lines = [];
    lines.push('Updated ' + res.applied.length + ' industr' + (res.applied.length === 1 ? 'y' : 'ies') +
      ' -> ' + res.totalStocks + ' stock' + (res.totalStocks === 1 ? '' : 's') + ' in Main.');
    lines.push('');
    res.applied.slice(0, 30).forEach(function (a) {
      lines.push('- ' + a.name + ': ' + fmt(a.oldPe) + ' -> ' + fmt(a.newPe) + '  (' + a.stocks + (a.stocks === 1 ? ' stock)' : ' stocks)'));
    });
    if (res.applied.length > 30) lines.push('... and ' + (res.applied.length - 30) + ' more');
    if (res.unmatched.length) {
      lines.push('');
      lines.push('No stocks in Main with these Basic Industries (check spelling):');
      lines.push(res.unmatched.join(', '));
    }
    if (res.invalid.length) {
      lines.push('');
      lines.push('Not a valid PE (skipped): ' + res.invalid.join(', '));
    }
    lines.push('');
    lines.push(res.mode === 'formula'
      ? 'The new value was copied into "Industry PE" on the ' + AB_INDUSTRY_PE_SHEET +
        ' tab, so Main\'s Industry PE and "PE vs Industry PE" update on their own.'
      : 'Main\'s Industry PE cells were written directly.');
    Logger.log(lines.join('\n'));
    ui.alert('Apply Updated Industry PE', lines.join('\n'), ui.ButtonSet.OK);
  } catch (err) {
    Logger.log('Apply Updated Industry PE failed: ' + err.message);
    ui.alert('Apply Updated Industry PE failed: ' + err.message);
  }
}


/*****************************************************************
 * NSE PRICE BAND CHANGES  (you paste, the script does the rest)
 * -----------------------------------------------------------------
 * Every evening NSE publishes the securities whose circuit (price
 * band) limit changes from the NEXT trading day: Sr. No, Symbol,
 * Series, Security Name, From, To.
 *
 *   1. Copy NSE's table and paste it into the "Priceband" tab (under
 *      its header row).
 *   2. Run  Auto Bhavcopy > 10. NSE Price Bands > Import Pasted Rows -
 *      it asks which day the table is for (default today). This is
 *      MANUAL on purpose - there is no timed trigger. The pasted rows
 *      are cleared afterwards.
 *
 * Rows go onto the "Price Band Changes" tab (history kept, duplicates
 * ignored) and ONE email is sent for the day. A band going UP (5% ->
 * 20%) is read as positive for the stock - more room to run; going
 * DOWN (20% -> 5%) is negative - a tighter limit, usually surveillance.
 *
 * NSE's own download link is deliberately NOT fetched by the script:
 * NSE does not answer Google's servers, and the attempt just hangs
 * until the script times out. Instead the PC bridge (screener_bridge.py)
 * downloads NSE's "Price Band changes from next trade date" CSV
 * (eq_band_changes_DDMMYYYY.csv) on the owner's computer at each run and
 * posts it to doPost action 'pricebands' (ab_pbFromBridge_), which files it
 * exactly like a paste. The paste tab stays as the manual fallback.
 *****************************************************************/
const AB_PB_SHEET = 'Price Band Changes';
const AB_PB_PASTE_SHEET = 'Priceband';
const AB_PB_EMAIL = ab_setting_('AB_PB_EMAIL', true);
const AB_PB_KEEP_DAYS = ab_setting_('AB_PB_KEEP_DAYS', 120);
const AB_PB_HEADERS_ = ['Report Date', 'Effective (next weekday)', 'Symbol', 'Company', 'Series',
                        'From %', 'To %', 'Impact', 'In Main', 'Chart'];

/** yyyy-MM-dd in IST - used for de-duplication. */
function ab_pbDayKey_(d) { return Utilities.formatDate(d, AB_TZ, 'yyyy-MM-dd'); }

/** Midnight (script clock) for a Date's IST calendar day. */
function ab_pbDayStart_(d) {
  const p = ab_pbDayKey_(d).split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

/** The next Monday-Friday after `d` (NSE holidays are not known here). */
function ab_pbNextWeekday_(d) {
  const x = ab_pbDayStart_(d);
  do { x.setDate(x.getDate() + 1); } while (x.getDay() === 0 || x.getDay() === 6);
  return x;
}

/** A report date typed or pasted by hand: a Date, or "dd/mm/yyyy". */
function ab_pbToDate_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return ab_pbDayStart_(v);
  const m = String(v || '').trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (!m) return null;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
}

/** Band cell -> number, or NaN for text like "No Band". */
function ab_pbBand_(v) {
  if (typeof v === 'number') return v;
  const n = Number(String(v === null || v === undefined ? '' : v).replace('%', '').trim());
  return String(v).trim() === '' ? NaN : n;
}

/** Current Main symbols -> company name (for the "In Main" column). */
function ab_pbMainSymbols_() {
  const out = {};
  try {
    const layout = ab_getMainLayout_();
    for (let r = layout.headerRowIdx + 1; r < layout.data.length; r++) {
      const sym = ab_cellText_(layout.data[r][layout.symbol]).toUpperCase();
      const nm = ab_cellText_(layout.data[r][layout.name]);
      if (!sym && !nm) break;
      if (sym) out[sym] = nm || sym;
    }
  } catch (e) {
    Logger.log('Price bands: Main symbols unavailable - ' + e.message);
  }
  return out;
}

function ab_pbImpact_(from, to) {
  if (isNaN(from) || isNaN(to)) return 'Changed';
  return to > from ? 'Widened (positive)' : to < from ? 'Tightened (negative)' : 'Changed';
}

/** The log tab as records, oldest data first doesn't matter - it is re-sorted on write. */
function ab_pbReadLog_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AB_PB_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  const vals = sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues();
  const out = [];
  vals.forEach(function (r) {
    const d = ab_pbToDate_(r[0]);
    const sym = String(r[2] || '').trim().toUpperCase();
    if (!d || !sym) return;
    out.push({ date: d, symbol: sym, name: String(r[3] || ''), series: String(r[4] || ''),
               from: ab_pbBand_(r[5]), to: ab_pbBand_(r[6]) });
  });
  return out;
}

function ab_pbKey_(rec) {
  return ab_pbDayKey_(rec.date) + '|' + rec.symbol + '|' + rec.series + '|' + rec.from + '|' + rec.to;
}

/** Re-writes the whole tab from `recs`: newest first, positives first within a day. */
function ab_pbWriteLog_(recs) {
  const sh = ab_getOrCreateSheet_(AB_PB_SHEET);
  const mainSyms = ab_pbMainSymbols_();
  const cutoff = ab_pbDayStart_(new Date());
  cutoff.setDate(cutoff.getDate() - AB_PB_KEEP_DAYS);

  const keep = recs.filter(function (x) { return x.date >= cutoff; });
  const rank = function (x) {
    const i = ab_pbImpact_(x.from, x.to);
    return i.indexOf('Widened') === 0 ? 0 : i.indexOf('Tightened') === 0 ? 2 : 1;
  };
  keep.sort(function (a, b) {
    return (b.date - a.date) || (rank(a) - rank(b)) ||
           ((isNaN(b.to) ? 0 : b.to) - (isNaN(a.to) ? 0 : a.to)) || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0);
  });

  sh.clear();
  const oldFilter = sh.getFilter();
  if (oldFilter) oldFilter.remove();
  sh.getRange(1, 1, 1, AB_PB_HEADERS_.length).setValues([AB_PB_HEADERS_])
    .setFontWeight('bold').setBackground('#f1f3f4');
  sh.setFrozenRows(1);
  if (keep.length) {
    const rows = keep.map(function (x) {
      return [x.date, ab_pbNextWeekday_(x.date), x.symbol, x.name, x.series,
              isNaN(x.from) ? '' : x.from, isNaN(x.to) ? '' : x.to, ab_pbImpact_(x.from, x.to),
              mainSyms[x.symbol] ? 'Yes' : '', '=HYPERLINK("' + ab_chartUrl_(x.symbol) + '","Chart")'];
    });
    const n = rows.length, w = AB_PB_HEADERS_.length;
    sh.getRange(2, 1, n, w).setValues(rows);
    sh.getRange(2, 1, n, 2).setNumberFormat('dd/mm/yyyy');
    sh.getRange(2, 6, n, 2).setNumberFormat('0"%"');
    // Impact colouring + bold for stocks you actually hold in Main.
    const bg = rows.map(function (r) {
      return [r[7].indexOf('Widened') === 0 ? '#d9f2e3' : r[7].indexOf('Tightened') === 0 ? '#fbdcdc' : '#f1f3f4'];
    });
    sh.getRange(2, 8, n, 1).setBackgrounds(bg);
    sh.getRange(2, 1, n, w).setFontWeights(rows.map(function (r) {
      return new Array(w).fill(r[8] === 'Yes' ? 'bold' : 'normal');
    }));
    sh.getRange(1, 1, n + 1, w).createFilter();
  }
  sh.autoResizeColumns(1, AB_PB_HEADERS_.length);
  return { total: keep.length, mainSyms: mainSyms };
}

// The same band change for the same stock filed again within this many days is one NSE
// file imported twice under two report dates (e.g. pasted on a Sunday and also downloaded
// by the PC bridge) - a real repeat that soon is not possible (the band already moved).
const AB_PB_ECHO_DAYS = 4;

function ab_pbChangeKey_(rec) { return rec.symbol + '|' + rec.series + '|' + rec.from + '|' + rec.to; }
function ab_pbDaysApart_(a, b) { return Math.round((ab_pbDayStart_(b) - ab_pbDayStart_(a)) / 864e5); }

/**
 * Drops repeats from the log: a record with the same stock, series and band change as the
 * previous record of that stock, filed 1..AB_PB_ECHO_DAYS days later. Keeps the earliest.
 */
function ab_pbDropEchoes_(recs) {
  const byStock = {};
  recs.forEach(function (x) { const k = x.symbol + '|' + x.series; (byStock[k] = byStock[k] || []).push(x); });
  const drop = new Set();
  Object.keys(byStock).forEach(function (k) {
    const list = byStock[k].slice().sort(function (a, b) { return a.date - b.date; });
    let keep = list[0];
    for (let i = 1; i < list.length; i++) {
      const x = list[i], gap = ab_pbDaysApart_(keep.date, x.date);
      if (gap >= 0 && gap <= AB_PB_ECHO_DAYS && ab_pbChangeKey_(x) === ab_pbChangeKey_(keep)) drop.add(x);
      else keep = x;
    }
  });
  return recs.filter(function (x) { return !drop.has(x); });
}

/**
 * Adds one report date's rows to the log, skipping any already there - also when the same
 * file was filed under a nearby date - and clearing such repeats from the log.
 * Returns { added: records that were genuinely new, removed: repeats cleared }.
 */
function ab_pbImportEx_(reportDate, rows) {
  const day = ab_pbDayStart_(reportDate);
  const read = ab_pbReadLog_();
  const log = ab_pbDropEchoes_(read);
  const removed = read.length - log.length;
  const seen = {}, near = {};
  log.forEach(function (x) {
    seen[ab_pbKey_(x)] = true;
    (near[ab_pbChangeKey_(x)] = near[ab_pbChangeKey_(x)] || []).push(x.date);
  });
  const added = [];
  rows.forEach(function (r) {
    const rec = { date: day, symbol: r.symbol, name: r.name, series: r.series, from: r.from, to: r.to };
    const k = ab_pbKey_(rec), ck = ab_pbChangeKey_(rec);
    if (seen[k]) return;
    if ((near[ck] || []).some(function (d) { return Math.abs(ab_pbDaysApart_(d, day)) <= AB_PB_ECHO_DAYS; })) return;
    seen[k] = true;
    (near[ck] = near[ck] || []).push(day);
    added.push(rec);
    log.push(rec);
  });
  if (added.length || removed || !SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AB_PB_SHEET)) ab_pbWriteLog_(log);
  return { added: added, removed: removed };
}

/** ab_pbImportEx_ for callers that only need the new records. */
function ab_pbImport_(reportDate, rows) { return ab_pbImportEx_(reportDate, rows).added; }


/**
 * PC bridge: one day's NSE price band file, downloaded on the owner's PC.
 * req = { reportDate: 'yyyy-mm-dd', rows: [{ symbol, series, name, from, to }] }. NSE names the file
 * after the NEXT trading day (eq_band_changes_27102026.csv is published on the evening of the 26th);
 * the PC sends the weekday before that date as reportDate, like a paste made that evening.
 * Same import as the paste tab (duplicates ignored). The day's email goes out only while
 * its changes are current (effective today or later); older catch-up days are filed quietly.
 */
function ab_pbFromBridge_(req) {
  const m = String(req.reportDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return { ok: false, error: 'reportDate must be yyyy-mm-dd' };
  const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const rows = [];
  (Array.isArray(req.rows) ? req.rows : []).forEach(function (r) {
    const sym = String((r && r.symbol) || '').trim().toUpperCase();
    const from = ab_pbBand_(r && r.from), to = ab_pbBand_(r && r.to);
    if (!sym || /\s/.test(sym) || sym === 'SYMBOL' || (isNaN(from) && isNaN(to))) return;
    rows.push({ symbol: sym, series: String(r.series || '').trim(), name: String(r.name || '').trim(), from: from, to: to });
  });
  if (!rows.length) return { ok: true, rows: 0, added: 0, removed: 0, inMain: 0, emailed: false, quiet: false };
  const res = ab_pbImportEx_(day, rows), added = res.added;
  const mainSyms = ab_pbMainSymbols_();
  const inMain = added.filter(function (x) { return mainSyms[x.symbol]; }).length;
  const current = ab_pbNextWeekday_(day) >= ab_pbDayStart_(new Date());
  const emailed = !!(added.length && current && AB_PB_EMAIL && ab_pbSendEmail_(added, mainSyms));
  return { ok: true, rows: rows.length, added: added.length, removed: res.removed, inMain: inMain, emailed: emailed,
           quiet: !!(added.length && !current) };
}


/* ---------------- email ---------------- */

function ab_pbSendEmail_(added, mainSyms) {
  if (!added.length) return false;
  const kind = function (x) { const i = ab_pbImpact_(x.from, x.to); return i.indexOf('Widened') === 0 ? 'up' : i.indexOf('Tightened') === 0 ? 'down' : 'chg'; };
  const inMain = added.filter(function (x) { return mainSyms[x.symbol]; });
  const others = added.filter(function (x) { return !mainSyms[x.symbol]; });
  const sortFn = function (a, b) { return (isNaN(b.to) ? 0 : b.to) - (isNaN(a.to) ? 0 : a.to) || (a.symbol < b.symbol ? -1 : 1); };
  const ups = inMain.filter(function (x) { return kind(x) === 'up'; }).sort(sortFn);
  const downs = inMain.filter(function (x) { return kind(x) === 'down'; }).sort(sortFn);
  const chg = inMain.filter(function (x) { return kind(x) === 'chg'; }).sort(sortFn);
  const othersUp = others.filter(function (x) { return kind(x) === 'up'; }).sort(sortFn);
  const othersDown = others.filter(function (x) { return kind(x) === 'down'; }).sort(sortFn);

  const reportDay = added.reduce(function (m, x) { return x.date > m ? x.date : m; }, added[0].date);
  const effective = ab_pbNextWeekday_(reportDay);
  const effTxt = Utilities.formatDate(effective, AB_TZ, 'EEE dd-MMM-yyyy');

  const th = 'style="text-align:left;padding:6px 8px;background:#f1f3f4;border-bottom:2px solid #dadce0;font-size:12px;color:#5f6368"';
  const td = 'style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;vertical-align:top"';
  const bandTxt = function (v) { return isNaN(v) ? '-' : v + '%'; };
  const link = function (sym) {
    return '<a href="' + ab_chartUrl_(sym) + '" style="color:#1a56c4;text-decoration:none"><b>' + sym + '</b></a>';
  };
  const table = function (title, colour, bg, list) {
    if (!list.length) return '';
    let h = '<h3 style="margin:18px 0 6px;font-size:15px;color:' + colour + '">' + title + ' (' + list.length + ')</h3>' +
      '<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%"><tr>' +
      ['Symbol', 'Company', 'Series', 'Band change'].map(function (t) { return '<th ' + th + '>' + t + '</th>'; }).join('') + '</tr>';
    list.forEach(function (x) {
      h += '<tr style="background:' + bg + '"><td ' + td + '>' + link(x.symbol) + '</td><td ' + td + '>' + (mainSyms[x.symbol] || x.name) +
           '</td><td ' + td + '>' + x.series + '</td><td ' + td + '><b>' + bandTxt(x.from) + ' &rarr; ' + bandTxt(x.to) + '</b></td></tr>';
    });
    return h + '</table>';
  };
  const compact = function (title, colour, list) {
    if (!list.length) return '';
    return '<p style="margin:14px 0 4px;font-size:13px"><b style="color:' + colour + '">' + title + ' (' + list.length + ')</b></p>' +
      '<p style="margin:0;font-size:12px;color:#3c4043;line-height:1.7">' +
      list.map(function (x) { return '<a href="' + ab_chartUrl_(x.symbol) + '" style="color:#3c4043">' + x.symbol + '</a> ' + bandTxt(x.from) + '&rarr;' + bandTxt(x.to); }).join(' &middot; ') +
      '</p>';
  };

  let html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:720px;color:#202124">' +
    '<h2 style="margin:0 0 4px;font-size:18px">NSE Price Band Changes</h2>' +
    '<p style="margin:0 0 6px;color:#5f6368;font-size:13px">Effective from the next trading day (' + effTxt + '). ' +
    added.length + ' change' + (added.length === 1 ? '' : 's') + ' in all &middot; <b>' + inMain.length + '</b> in your Main sheet.</p>' +
    '<p style="margin:0 0 4px;color:#5f6368;font-size:12px">A higher band (e.g. 5% &rarr; 20%) is positive for the stock; a lower band (20% &rarr; 5%) is negative.</p>';
  if (!inMain.length) html += '<p style="margin:14px 0 0;font-size:13px">None of the changes affect stocks in Main.</p>';
  html += table('Band widened - positive (your stocks)', '#0a8f4f', '#f3fbf6', ups);
  html += table('Band tightened - negative (your stocks)', '#d64545', '#fef6f6', downs);
  html += table('Band changed (your stocks)', '#5f6368', '#ffffff', chg);
  html += compact('Other NSE stocks - band widened', '#0a8f4f', othersUp);
  html += compact('Other NSE stocks - band tightened', '#d64545', othersDown);
  html += '<p style="margin:18px 0 0;color:#5f6368;font-size:11px">Full history: the "' + AB_PB_SHEET + '" tab.</p></div>';

  const line = function (x) { return '  ' + x.symbol + ' ' + bandTxt(x.from) + ' -> ' + bandTxt(x.to) + ' (' + x.series + ')'; };
  let text = 'NSE PRICE BAND CHANGES - effective ' + effTxt + '\n' + added.length + ' in all, ' + inMain.length + ' in Main.\n';
  if (ups.length) text += '\nWIDENED - positive (your stocks)\n' + ups.map(line).join('\n') + '\n';
  if (downs.length) text += '\nTIGHTENED - negative (your stocks)\n' + downs.map(line).join('\n') + '\n';
  if (chg.length) text += '\nCHANGED (your stocks)\n' + chg.map(line).join('\n') + '\n';
  if (othersUp.length) text += '\nOther NSE stocks widened: ' + othersUp.map(function (x) { return x.symbol + ' ' + bandTxt(x.from) + '->' + bandTxt(x.to); }).join(', ') + '\n';
  if (othersDown.length) text += '\nOther NSE stocks tightened: ' + othersDown.map(function (x) { return x.symbol + ' ' + bandTxt(x.from) + '->' + bandTxt(x.to); }).join(', ') + '\n';

  const subject = 'Price Band Changes (' + Utilities.formatDate(effective, AB_TZ, 'dd-MMM') + ') - ' +
    (inMain.length ? inMain.length + ' in Main: ' + ups.length + ' widened, ' + downs.length + ' tightened'
                   : 'none in Main, ' + added.length + ' NSE-wide');
  return ab_sendMail_({ to: AB_EMAIL_TO, subject: subject, body: text, htmlBody: html });
}

/* ---------------- entry points ---------------- */

/** Creates the paste tab (header only) the first time. */
function ab_pbEnsurePasteTab_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(AB_PB_PASTE_SHEET);
  if (!sh) {
    sh = ss.insertSheet(AB_PB_PASTE_SHEET);
    sh.getRange(1, 1, 1, 6).setValues([['Sr. No', 'Symbol', 'Series', 'Security Name', 'From', 'To']])
      .setFontWeight('bold').setBackground('#f1f3f4');
    sh.setFrozenRows(1);
  }
  return sh;
}

/**
 * Reads whatever is pasted on the paste tab and imports it for `day`
 * (default today), then clears the pasted rows so the next paste starts
 * clean (the header row is kept). The header row is found by its
 * words - Symbol / Series / Security Name / From / To - wherever it
 * sits in the first 5 rows, so the tab can be laid out as NSE's table
 * copies; with no header, columns are taken as B-F.
 * Returns { sheetMissing } | { rows: n, added: [...], day }.
 */
function ab_pbImportPasted_(day) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AB_PB_PASTE_SHEET);
  if (!sh) return { sheetMissing: true };
  const last = sh.getLastRow(), lastCol = Math.max(6, sh.getLastColumn());
  if (last < 1) return { rows: 0, added: [] };
  const grid = sh.getRange(1, 1, last, lastCol).getValues();

  let hdr = -1, ix = { s: 1, series: 2, n: 3, f: 4, t: 5 };
  for (let r = 0; r < Math.min(5, grid.length); r++) {
    const row = grid[r].map(ab_normHeader_);
    const s = row.indexOf('SYMBOL'), f = row.indexOf('FROM'), t = row.indexOf('TO');
    if (s !== -1 && f !== -1 && t !== -1) {
      ix = { s: s, series: row.indexOf('SERIES'), n: row.indexOf('SECURITYNAME'), f: f, t: t };
      hdr = r;
      break;
    }
  }
  const rows = [];
  for (let r = hdr + 1; r < grid.length; r++) {
    const g = grid[r];
    const sym = String(g[ix.s] || '').trim().toUpperCase();
    const from = ab_pbBand_(g[ix.f]), to = ab_pbBand_(g[ix.t]);
    if (!sym || /\s/.test(sym) || sym === 'SYMBOL' || (isNaN(from) && isNaN(to))) continue;
    rows.push({
      symbol: sym,
      series: ix.series === -1 ? '' : String(g[ix.series] || '').trim(),
      name: ix.n === -1 ? '' : String(g[ix.n] || '').trim(),
      from: from, to: to
    });
  }
  if (!rows.length) return { rows: 0, added: [] };
  const useDay = day || ab_pbDayStart_(new Date());
  const added = ab_pbImport_(useDay, rows);
  // Clear the pasted rows (keep the header) so tomorrow's paste starts clean.
  if (last > hdr + 1) sh.getRange(hdr + 2, 1, last - hdr - 1, lastCol).clearContent();
  return { rows: rows.length, added: added, day: useDay };
}

/** Menu: opens (creating on first use) the paste tab. */
function runOpenPriceBandPasteTab() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ab_pbEnsurePasteTab_();
  ss.setActiveSheet(sh);
}

/** Menu: import what is pasted (asks which report date), then send the day's email. */
function runImportPastedPriceBands() {
  const ui = SpreadsheetApp.getUi();
  try {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AB_PB_PASTE_SHEET);
    if (!sh) {
      runOpenPriceBandPasteTab();
      ui.alert('NSE Price Bands', 'I created the "' + AB_PB_PASTE_SHEET + '" tab and opened it.\n\nPaste NSE\'s table there ' +
        '(Symbol, Series, Security Name, From, To), then run this menu item again.', ui.ButtonSet.OK);
      return;
    }
    const todayTxt = Utilities.formatDate(new Date(), AB_TZ, 'dd/MM/yyyy');
    const ans = ui.prompt('NSE Price Bands - report date',
      'Which day is this NSE table for? (dd/mm/yyyy)\nLeave as today if you pasted today\'s report.', ui.ButtonSet.OK_CANCEL);
    if (ans.getSelectedButton() !== ui.Button.OK) return;
    const txt = String(ans.getResponseText() || '').trim() || todayTxt;
    const day = ab_pbToDate_(txt);
    if (!day) { ui.alert('"' + txt + '" is not a date. Use dd/mm/yyyy, e.g. ' + todayTxt + '.'); return; }

    const res = ab_pbImportPasted_(day);
    if (!res.rows) {
      ui.alert('NSE Price Bands', 'Nothing to import - paste NSE\'s table into the "' + AB_PB_PASTE_SHEET +
        '" tab first (Symbol, From and To columns).', ui.ButtonSet.OK);
      return;
    }
    const mainSyms = ab_pbMainSymbols_();
    const inMain = res.added.filter(function (x) { return mainSyms[x.symbol]; }).length;
    let emailed = '';
    if (res.added.length && AB_PB_EMAIL) emailed = ab_pbSendEmail_(res.added, mainSyms) ? ' Email sent.' : ' (Email not sent - emails are paused.)';
    ui.alert('NSE Price Bands',
      'Imported ' + res.rows + ' row(s) for ' + Utilities.formatDate(res.day, AB_TZ, 'dd/MM/yyyy') + ':\n' +
      res.added.length + ' new, ' + (res.rows - res.added.length) + ' already on the "' + AB_PB_SHEET + '" tab; ' +
      inMain + ' of the new ones are in your Main sheet.' + emailed +
      '\n\nThe pasted rows were cleared from "' + AB_PB_PASTE_SHEET + '" ready for the next paste.', ui.ButtonSet.OK);
  } catch (e) {
    Logger.log('Price band paste import failed: ' + e.message);
    ui.alert('Import failed: ' + e.message);
  }
}

/*****************************************************************
 * RESULT DATE - LIVE FORMULA (not a script run)
 *
 * Main's "Result Date" column used to be filled by a per-row
 * =VLOOKUP(F#, Results!B:C, 2, 0) formula pointing at the OLD
 * "Results" sheet (SYMBOL in col B, date in col C). The user deleted
 * that sheet and replaced it with a new "Results" tab laid out as a
 * "Result Calender": SYMBOL | COMPANY | PURPOSE | DATE, covering the
 * next ~1 month. Every old formula now shows #REF!, and ~800 rows
 * never had the formula at all.
 *
 * Per the user's explicit instruction, this is NOT meant to be a
 * daily script-driven refresh - it should behave like a native
 * spreadsheet lookup that updates itself the instant the Results
 * sheet is edited. ab_installResultDateFormula_() is a ONE-TIME setup
 * action (menu item, not a trigger) that writes a single
 * self-expanding ARRAYFORMULA into Main's Result Date column. After
 * that one run, Google Sheets itself keeps it live - no Apps Script
 * involvement on an ongoing basis, no trigger, nothing to re-run
 * unless you want to point it at a different layout later.
 *****************************************************************/

const AB_RESULTS_SHEET = 'Results';

/** Converts a 1-based column number (1 -> A, 27 -> AA) to its letter(s). */
function ab_colToLetter_(colNum) {
  let letter = '';
  while (colNum > 0) {
    const rem = (colNum - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    colNum = Math.floor((colNum - 1) / 26);
  }
  return letter;
}

/**
 * Resolves the Results sheet's SYMBOL and DATE columns by header name
 * (not fixed letters) so a future re-layout of that sheet doesn't
 * silently break the formula the way the old hardcoded Results!B:C
 * reference did when the sheet was rebuilt.
 */
function ab_getResultsLookupInfo_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(AB_RESULTS_SHEET);
  if (!sh) throw new Error('Could not find a "' + AB_RESULTS_SHEET + '" tab.');
  const data = sh.getDataRange().getValues();

  let headerRowIdx = -1, symCol = -1, dateCol = -1;
  for (let r = 0; r < Math.min(10, data.length); r++) {
    const row = data[r].map(v => String(v).trim().toUpperCase());
    const si = row.indexOf('SYMBOL');
    const di = row.indexOf('DATE');
    if (si !== -1 && di !== -1) { headerRowIdx = r; symCol = si; dateCol = di; break; }
  }
  if (headerRowIdx === -1) {
    throw new Error('Could not find SYMBOL and DATE headers (within the first 10 rows) in the "' +
      AB_RESULTS_SHEET + '" tab.');
  }
  if (dateCol <= symCol) {
    throw new Error('In "' + AB_RESULTS_SHEET + '", the DATE column must be to the RIGHT of the ' +
      'SYMBOL column for a VLOOKUP-style formula to read it (currently SYMBOL is column ' +
      ab_colToLetter_(symCol + 1) + ', DATE is column ' + ab_colToLetter_(dateCol + 1) + ').');
  }
  return {
    sheetName: sh.getName(),
    symbolColLetter: ab_colToLetter_(symCol + 1),
    dateColLetter: ab_colToLetter_(dateCol + 1),
    // VLOOKUP's column index is 1-based counting from the lookup column.
    lookupIndex: dateCol - symCol + 1
  };
}

/**
 * Writes a VLOOKUP-based formula into EVERY row of Main's Result Date
 * column (from the first data row down through the sheet's current
 * bottom), each one looking up that row's own SYMBOL against the
 * Results sheet.
 *
 * NOTE on two earlier, both-blank attempts: v1 used a single
 * ARRAYFORMULA wrapping IF/IFERROR/TEXT/DATEVALUE/VLOOKUP, spilling
 * down the whole column - came back entirely blank on the live sheet.
 * v2 switched to one plain formula per row (ruling out array-context
 * quirks) but kept TEXT(DATEVALUE(...)) for the DD/MM/YYYY reformat -
 * ALSO came back entirely blank, including for symbols confirmed
 * present in Results (e.g. TCS). DATEVALUE() is the one thing both
 * broken attempts shared that the very first working version (plain
 * VLOOKUP+IFERROR, no reformatting, which the user confirmed showed
 * "08-Oct-26" correctly) didn't have - so DATEVALUE failing to parse
 * this sheet's "08-Oct-26" text (almost certainly a locale/date-parsing
 * mismatch) is what's silently tripping IFERROR on every single row.
 *
 * v3 never called DATEVALUE at all - it sliced the text with LEFT/MID/
 * RIGHT + a literal Jan..Dec lookup and concatenated the pieces into a
 * "01/10/2026"-looking STRING. That displayed correctly, but a sort or
 * filter on a text column sorts alphabetically, not chronologically -
 * "15/10/2026" sorts before "03/11/2026" as text (1 < 3) even though
 * November is later than October. Confirmed broken by the user filtering
 * the column and getting a non-chronological order.
 *
 * v4 (this version) keeps the same locale-independent LEFT/MID/RIGHT +
 * SWITCH slicing to pull the day/month/year apart - but instead of
 * concatenating them into text, feeds them into DATE(year, month, day)
 * to build a real date VALUE. DATE() takes three plain numbers, so
 * there's no text-parsing step for Sheets to get a locale opinion about
 * (unlike DATEVALUE, which parses a whole date STRING and is what broke
 * v1/v2). The column then gets a dd/mm/yyyy number format applied so it
 * still DISPLAYS "01/10/2026" - but because the underlying value is now
 * a real date, sorting and filtering the column puts rows in actual
 * chronological order.
 */
function ab_installResultDateFormula_() {
  const layout = ab_getMainLayout_();
  if (layout.symbol === -1) throw new Error('Could not find a "SYMBOL" column in Main.');
  if (layout.resultDate === -1) throw new Error('Could not find a "Result Date" column in Main.');

  const results = ab_getResultsLookupInfo_();

  const sh = layout.sheet;
  const firstDataRow = layout.headerRowIdx + 2; // 1-based first data row under the header
  const lastRow = sh.getMaxRows();
  const numRows = lastRow - firstDataRow + 1;
  if (numRows <= 0) throw new Error('Main has no data rows below its header row.');

  const symbolColLetter = ab_colToLetter_(layout.symbol + 1);
  const resultDateCol1Based = layout.resultDate + 1;
  const resultDateColLetter = ab_colToLetter_(resultDateCol1Based);

  const resultsRef = "'" + results.sheetName + "'!$" + results.symbolColLetter +
    ':$' + results.dateColLetter;
  // Maps the 3-letter month text Results already uses ("Oct") to its
  // month NUMBER (10) - feeds straight into DATE(), no date-string
  // parsing (and so no locale ambiguity) anywhere in this formula.
  const monthSwitch =
    '"Jan",1,"Feb",2,"Mar",3,"Apr",4,"May",5,"Jun",6,' +
    '"Jul",7,"Aug",8,"Sep",9,"Oct",10,"Nov",11,"Dec",12';
  const formulas = [];
  for (let r = firstDataRow; r <= lastRow; r++) {
    const lookup = 'VLOOKUP($' + symbolColLetter + r + ',' + resultsRef + ',' + results.lookupIndex + ',0)';
    // "08-Oct-26" -> day=VALUE(LEFT,2)=8, month=SWITCH(MID(4,3))=10,
    // year=2000+VALUE(RIGHT,2)=2026 -> DATE(2026,10,8), a real date.
    formulas.push(['=IFERROR(DATE(2000+VALUE(RIGHT(' + lookup + ',2)),SWITCH(MID(' + lookup +
      ',4,3),' + monthSwitch + '),VALUE(LEFT(' + lookup + ',2))),"")']);
  }
  sh.getRange(firstDataRow, resultDateCol1Based, numRows, 1).setFormulas(formulas);
  // Real date values sort/filter chronologically on their own - this
  // just controls how they're DISPLAYED, matching what you asked for.
  sh.getRange(firstDataRow, resultDateCol1Based, numRows, 1).setNumberFormat('dd/mm/yyyy');

  const msg = 'Result Date (column ' + resultDateColLetter + ' in Main) now runs a live VLOOKUP ' +
    'formula on every row from ' + firstDataRow + ' to ' + lastRow + ', reading "' +
    results.sheetName + '" (' + results.symbolColLetter + ':' + results.dateColLetter + '). Each ' +
    'cell holds a REAL date (shown as dd/mm/yyyy), so sorting/filtering the column now orders ' +
    'chronologically. Recalculates the moment you add, edit, or remove a row in ' + results.sheetName +
    ' - no script run, no trigger. Re-run this menu item only if the Results sheet\'s column layout ' +
    'changes, or if Main ever needs rows beyond ' + lastRow + '.';
  Logger.log(msg);
  return msg;
}

/**
 * Self-healing Result Date column. Older versions wrote the date as TEXT
 * ("27/10/2026"), which sorts alphabetically, not by date. If any row still
 * has that old text-style formula, this silently re-installs the real-date
 * formula on the whole column (same as the menu item "Install Result Date
 * Live Formula"). Checked at most once every 12 hours, never throws, and
 * does nothing when the column is already fine.
 */
const AB_RD_CHECK_PROP_ = 'AB_RD_FORMULA_CHECKED';
function ab_ensureResultDateReal_() {
  try {
    const props = PropertiesService.getScriptProperties();
    const last = Number(props.getProperty(AB_RD_CHECK_PROP_) || 0);
    if (last && Date.now() - last < 12 * 3600 * 1000) return false;
    const layout = ab_getMainLayout_();
    if (layout.resultDate === -1 || layout.symbol === -1) return false;
    const sh = layout.sheet;
    const first = layout.headerRowIdx + 2;
    const n = sh.getMaxRows() - first + 1;
    if (n <= 0) return false;
    const f = sh.getRange(first, layout.resultDate + 1, n, 1).getFormulas();
    let old = 0;
    for (let i = 0; i < f.length; i++) {
      if (f[i][0] && String(f[i][0]).indexOf('&"/"&') !== -1) old++;
    }
    if (!old) { props.setProperty(AB_RD_CHECK_PROP_, String(Date.now())); return false; }
    ab_installResultDateFormula_();
    SpreadsheetApp.flush();
    props.setProperty(AB_RD_CHECK_PROP_, String(Date.now()));
    Logger.log('Result Date column: ' + old + ' text-style formula(s) replaced with real-date formulas (sorts chronologically now).');
    return true;
  } catch (e) {
    Logger.log('Result Date auto-fix skipped: ' + e.message);
    return false;
  }
}

function runInstallResultDateFormulaNow() {
  try {
    const msg = ab_installResultDateFormula_();
    SpreadsheetApp.getUi().alert(msg);
  } catch (err) {
    SpreadsheetApp.getUi().alert('Failed to install the Result Date formula: ' + err.message);
    throw err;
  }
}

function ab_chartUrl_(symbol) {
  return 'https://www.tradingview.com/chart/?symbol=NSE:' + encodeURIComponent(symbol);
}
function ab_screenerUrl_(symbol) {
  return 'https://www.screener.in/company/' + encodeURIComponent(symbol) + '/';
}

/*****************************************************************
 * FULL ROW DETAILS FOR ALERT NOTIFICATIONS
 * -----------------------------------------------------------------
 * The alert email used to only show a hand-picked handful of fields.
 * This builds a complete, grouped dump of everything else in that
 * symbol's Main row - Basic Industry, PE vs Industry PE, PEG Ratio,
 * Quarterly Results (from the Checkbox column), and every Alert
 * System / Quarterly Results / Valuation / Promotor-FII / OPM /
 * Technical column - so the notification stands on its own without
 * needing to open the sheet.
 *
 * Category labels are read live from the row directly ABOVE the
 * header row (the merged "Alert System / Quarterly Results /
 * Valuation / ..." band) and forward-filled across blank/merged
 * cells. This is best-effort - if Main's merge boundaries don't line
 * up with a field the way you'd expect, the field still shows, just
 * under a neighbouring category label. Nothing gets silently dropped.
 *****************************************************************/
const AB_CATEGORY_ORDER = [
  'Company Info', 'Alert System', 'Quarterly Results', 'Valuation',
  'Promotor/FII Activity', 'OPM', 'Technical'
];

/** Forward-fills the merged category row into one label per column. */
function ab_getMainCategoryRow_(layout) {
  const header = layout.header;
  const categories = new Array(header.length).fill('');
  const catRowIdx = layout.headerRowIdx - 1;
  if (catRowIdx < 0) return categories;
  const raw = layout.data[catRowIdx] || [];
  let last = '';
  for (let c = 0; c < header.length; c++) {
    const v = String(raw[c] || '').trim();
    if (v) last = v;
    categories[c] = last;
  }
  return categories;
}

/**
 * Columns already shown up top in the alert card (Alert Level, Price
 * Now, Zone, MCAP, Entry/Stoploss, Pattern, FVG...) plus pure UI/link
 * columns (Chart, Screener.in, NSE Ticker) - skipped here so the "full
 * row" section below doesn't just repeat them. Resolved by INDEX (not
 * header name), since at least one of these columns (FVG) has a stale
 * header text ("Doc") that can't be matched by name.
 */
function ab_rowDetailSkipSet_(layout) {
  const idxFields = [
    layout.name, layout.sector, layout.symbol, layout.mktPrice, layout.pctChange,
    layout.zone, layout.entryPrice, layout.stoploss, layout.pattern, layout.fvg,
    layout.fallLevel, layout.breakLevel, layout.qrCheckbox, layout.mcap
  ];
  const set = new Set();
  idxFields.forEach(i => { if (i !== -1 && i !== undefined) set.add(i); });
  const skipByName = ['NSE Ticker', 'Chart', 'Screener.in'];
  layout.header.forEach((h, i) => { if (skipByName.indexOf(String(h).trim()) !== -1) set.add(i); });
  return set;
}

/**
 * Builds the grouped "everything else in this row" list for one fired
 * alert. `rowDisplay` must be that row's DISPLAY values (not raw
 * getValues()) so percent/date/currency formatting matches what you'd
 * see in the sheet itself instead of raw fractions like 0.1139.
 */
function ab_buildRowDetails_(layout, rowDisplay, categories, skipSet) {
  const header = layout.header;
  const buckets = {};
  function push(cat, label, value) {
    if (!buckets[cat]) buckets[cat] = [];
    buckets[cat].push({ label: label, value: value });
  }

  if (layout.qrCheckbox !== -1) {
    const raw = String(rowDisplay[layout.qrCheckbox] || '').trim().toUpperCase();
    const updated = (raw === 'TRUE' || raw === 'Y' || raw === 'YES' || raw === 'X' || raw === '✓');
    push('Quarterly Results', 'Results Updated', updated ? 'Yes' : 'No');
  }

  for (let c = 0; c < header.length; c++) {
    if (skipSet.has(c)) continue;
    const name = String(header[c] || '').trim();
    if (!name) continue;
    const val = String(rowDisplay[c] || '').trim();
    if (!val) continue;
    const cat = categories[c] || 'Company Info';
    push(cat, name, val);
  }

  const ordered = [];
  AB_CATEGORY_ORDER.forEach(cat => {
    if (buckets[cat]) { ordered.push([cat, buckets[cat]]); delete buckets[cat]; }
  });
  Object.keys(buckets).forEach(cat => ordered.push([cat, buckets[cat]]));
  return ordered;
}

/** Plain-text rendering of ab_buildRowDetails_'s output, for the email's
 *  text fallback and the Pushbullet push body. */
function ab_detailsToText_(details) {
  if (!details || !details.length) return '';
  let out = '';
  details.forEach(group => {
    const cat = group[0], fields = group[1];
    if (!fields.length) return;
    out += '  [' + cat + ']\n';
    fields.forEach(fld => { out += '    ' + fld.label + ': ' + fld.value + '\n'; });
  });
  return out;
}


/** Latest close per symbol, straight from the Today tab this run just built. */
function ab_getTodayCloseMap_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('Today');
  const map = {};
  if (!sh) return map;
  const data = sh.getDataRange().getValues();
  const header = data.shift();
  const symIdx = header.indexOf('TckrSymb');
  const clsIdx = header.indexOf('ClsPric');
  if (symIdx === -1 || clsIdx === -1) return map;
  data.forEach(r => {
    const sym = String(r[symIdx]).trim().toUpperCase();
    if (!sym) return;
    const c = ab_toNum_(r[clsIdx]);
    if (!isNaN(c)) map[sym] = c;
  });
  return map;
}

function ab_getAlertLogSheet_() {
  const sh = ab_getOrCreateSheet_(AB_ALERT_LOG_SHEET);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, 12).setValues([[
      'Date', 'Symbol', 'Company', 'Alert Type', 'Alert Level', 'Trigger Price',
      'Pattern @ Alert', 'FVG Tags @ Alert', 'Current Price', '% Since Alert',
      'Days Since', 'Outcome'
    ]]);
    sh.setFrozenRows(1);
  }
  return sh;
}

/**
 * The alert engine. Compares the given price map against each row's
 * hand-set Price Fall / Breakout levels, stamps Main, and logs new
 * firings. Returns the list of alerts that fired on this run, with the
 * full row's data attached (for the rich email/push notification).
 *
 * @param {Object} priceMap symbol -> price (live intraday price during
 *   market hours, or the day's close for the EOD safety-net pass)
 * @param {string} priceSource 'live' or 'close' - only used for logging
 */
/**
 * Is `when` inside the NSE regular session (Mon-Fri, 09:15-15:30 IST)?
 *
 * Deliberately formats through AB_TZ rather than reading the Date's own
 * getHours()/getDay(), so this stays correct regardless of what
 * timezone the Apps Script project itself is set to.
 *
 * Trading holidays are NOT handled - there's no holiday calendar in the
 * sheet. On a holiday the market simply never moves, so a level can't
 * be crossed and nothing fires anyway.
 */
function ab_isMarketHours_(when) {
  const d = when || new Date();
  const dow = Utilities.formatDate(d, AB_TZ, 'u'); // 1=Mon .. 7=Sun
  const dayNum = Number(dow);
  if (dayNum >= 6) return false; // weekend
  const hhmm = Utilities.formatDate(d, AB_TZ, 'HH:mm').split(':');
  const mins = Number(hhmm[0]) * 60 + Number(hhmm[1]);
  return mins >= AB_MARKET_OPEN_MIN && mins <= AB_MARKET_CLOSE_MIN;
}

/**
 * What kind of row is this, judged purely by which cells are filled?
 *
 *   'watch'       - alert level(s), no entry/stop. Not a trade.
 *   'alert-trade' - alert level(s) + entry + stop. Trade, market hours only.
 *   'entry-trade' - entry + stop, no alert level. Trade, fires any time.
 *   'none'        - nothing actionable set.
 *
 * A half-filled trade (entry but no stoploss, or vice versa) is
 * deliberately NOT treated as a trade: without both, there's no way to
 * grade it. If it also has an alert level it degrades to a plain watch,
 * otherwise it's 'none'.
 */
function ab_classifyAlertRow_(fall, brk, entry, stop) {
  const has = function (n) { return !isNaN(n) && n > 0; };
  const hasAlert = has(fall) || has(brk);
  const hasTrade = has(entry) && has(stop);
  if (hasAlert && hasTrade) return 'alert-trade';
  if (hasAlert) return 'watch';
  if (hasTrade) return 'entry-trade';
  return 'none';
}

/**
 * Writes a percentage into a cell WITHOUT the classic factor-of-100
 * trap.
 *
 * Sheets stores a percent-formatted cell as a fraction: 0.05 displays
 * as "5.00%". So writing the number 5 into a percent-formatted cell
 * shows "500.00%", and writing -0.25 (meaning minus a quarter of one
 * percent) shows "-25.00%". This takes the value in percent units,
 * stores the fraction, and pins the display format so the cell can't be
 * misread whatever formatting it had before.
 */
function ab_writePct_(range, pctValue) {
  if (pctValue === null || pctValue === undefined || isNaN(pctValue)) return;
  range.setValue(Math.round(pctValue * 100) / 100 / 100).setNumberFormat('0.00%');
}

/**
 * Has price reached the entry for an entry-only trade?
 *
 * Plain "price is at or above entry" - no tolerance band. An entry-only
 * row isn't a level you're waiting to be touched exactly; it's the
 * price you're in at (or would have been filled at). So an entry at or
 * below the current price means the trade is already on, and an entry
 * above it means you're still waiting for the stock to get there.
 */
function ab_entryReached_(price, entry) {
  if (isNaN(price) || isNaN(entry) || entry <= 0) return false;
  return price >= entry;
}

function checkPriceAlerts_(priceMap, priceSource) {
  priceMap = priceMap || ab_getTodayCloseMap_();
  priceSource = priceSource || 'close';

  const layout = ab_getMainLayout_();
  const logSheet = ab_getAlertLogSheet_();
  const nowTs = Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm');

  // Computed once per run, not per row - see FULL ROW DETAILS section below.
  const categories = ab_getMainCategoryRow_(layout);
  const skipSet = ab_rowDetailSkipSet_(layout);

  const data = layout.data;
  const fired = [];
  const newLogRows = [];

  for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
    const row = data[r];
    const sym = String(row[layout.symbol]).trim().toUpperCase();
    const name = String(row[layout.name]).trim();
    if (!sym && !name) break; // end of the watchlist block (other tables follow)
    if (!sym) continue;

    // Don't re-fire an alert that's already flagged.
    const alreadyTriggered = String(row[layout.triggered]).trim().toUpperCase() === 'Y';
    if (alreadyTriggered) continue;

    const fall = ab_toNum_(row[layout.fallLevel]);
    const brk = ab_toNum_(row[layout.breakLevel]);
    const entryPrice = layout.entryPrice !== -1 ? ab_toNum_(row[layout.entryPrice]) : NaN;
    const stoploss = layout.stoploss !== -1 ? ab_toNum_(row[layout.stoploss]) : NaN;

    // Which cells you filled in decides both what can fire this row and
    // when it's allowed to - see the INTRADAY PRICE-LEVEL ALERTS notes.
    const kind = ab_classifyAlertRow_(fall, brk, entryPrice, stoploss);
    if (kind === 'none') continue;

    // A trade taken off an alert level is only actionable while you can
    // actually place the order, so it stays silent outside the session.
    if (kind === 'alert-trade' && !ab_isMarketHours_()) continue;

    // NOTE the "> 0" guard. ab_toNum_ runs Number(), and Number('') is
    // 0 rather than NaN - so an empty MKT Price cell would otherwise
    // read as a real price of zero, which sits below every Price Fall
    // level ever set and would fire a false alert on every blank row.
    const mktRaw = layout.mktPrice !== -1 ? ab_toNum_(row[layout.mktPrice]) : NaN;
    const mktCell = (!isNaN(mktRaw) && mktRaw > 0) ? mktRaw : NaN;
    let price, rowSource = priceSource;

    if (kind === 'entry-trade') {
      // Entry-only trades are compared against Main's own MKT Price
      // column, ALWAYS - not the Today-tab close the other row types
      // use. That column is what you were looking at when you typed the
      // entry in, so this is the only way "price reached my entry"
      // means the same thing to you and to the script. It also makes
      // "Check Price Alerts Now" behave the way you'd expect at any
      // hour, instead of silently comparing against a stale close.
      price = !isNaN(mktCell) ? mktCell : priceMap[sym];
      if (!isNaN(mktCell)) rowSource = 'mkt';
    } else {
      // Prefer the price map passed in; fall back to Main's own MKT
      // Price cell if this symbol wasn't returned by the fetch.
      price = priceMap[sym];
      if (price === undefined && !isNaN(mktCell)) price = mktCell;
    }
    if (price === undefined || isNaN(price) || price <= 0) continue;

    let alertType = '', level = NaN;
    if (kind === 'entry-trade') {
      // No level to cross - live the moment price is at or above entry.
      if (ab_entryReached_(price, entryPrice)) {
        alertType = 'Entry'; level = entryPrice;
      }
    } else if (!isNaN(fall) && fall > 0 && price <= fall) {
      alertType = 'Price Fall'; level = fall;
    } else if (!isNaN(brk) && brk > 0 && price >= brk) {
      alertType = 'Breakout'; level = brk;
    }
    if (!alertType) continue;

    const pattern = layout.pattern !== -1 ? String(row[layout.pattern]).trim() : '';
    const fvg = layout.fvg !== -1 ? String(row[layout.fvg]).trim() : '';
    const pctMove = (price - level) / level * 100;

    // Stamp Main in place
    const sheetRow = r + 1;
    layout.sheet.getRange(sheetRow, layout.triggered + 1).setValue('Y');
    if (layout.trigDate !== -1) {
      layout.sheet.getRange(sheetRow, layout.trigDate + 1).setValue(nowTs);
    }
    if (layout.pctAfter !== -1) {
      ab_writePct_(layout.sheet.getRange(sheetRow, layout.pctAfter + 1), pctMove);
    }

    // Store a REAL Date (not a formatted string) so updateAlertOutcomes_
    // can read it back and compute "Days Since" reliably.
    newLogRows.push([
      new Date(), sym, name, alertType, level, price,
      pattern, fvg, price, 0, 0, 'Open'
    ]);

    // Full row detail for the notification - read as DISPLAY values so
    // percent/date formatting matches what the sheet shows, not raw
    // fractions. Only fetched for rows that actually fired, since this
    // is a small extra read per alert, not per row scanned.
    let details = [];
    let highlights = { basicIndustry: '', peVsIndustryPe: '', pegRatio: '', resultsUpdated: '' };
    try {
      const rowDisplay = layout.sheet.getRange(sheetRow, 1, 1, layout.header.length).getDisplayValues()[0];
      details = ab_buildRowDetails_(layout, rowDisplay, categories, skipSet);
      highlights = {
        basicIndustry: layout.basicIndustry !== -1 ? String(rowDisplay[layout.basicIndustry] || '').trim() : '',
        peVsIndustryPe: layout.peVsIndustryPe !== -1 ? String(rowDisplay[layout.peVsIndustryPe] || '').trim() : '',
        pegRatio: layout.pegRatioCol !== -1 ? String(rowDisplay[layout.pegRatioCol] || '').trim() : '',
        resultsUpdated: layout.qrCheckbox !== -1
          ? (String(rowDisplay[layout.qrCheckbox] || '').trim().toUpperCase() === 'TRUE' ? 'Yes' : 'No')
          : ''
      };
    } catch (dErr) {
      Logger.log('Could not build row details for ' + sym + ': ' + dErr.message);
    }

    fired.push({
      symbol: sym, name: name, type: alertType, level: level, price: price,
      kind: kind, isTrade: (kind === 'alert-trade' || kind === 'entry-trade'),
      pctMove: pctMove, pattern: pattern, fvg: fvg,
      entryPrice: (!isNaN(entryPrice) && entryPrice > 0) ? entryPrice : null,
      stoploss: (!isNaN(stoploss) && stoploss > 0) ? stoploss : null,
      sector: layout.sector !== -1 ? String(row[layout.sector]).trim() : '',
      industry: layout.industry !== -1 ? String(row[layout.industry]).trim() : '',
      mcap: layout.mcap !== -1 ? row[layout.mcap] : '',
      pctChange: layout.pctChange !== -1 ? row[layout.pctChange] : '',
      zone: layout.zone !== -1 ? String(row[layout.zone]).trim() : '',
      priceSource: rowSource,
      chartUrl: ab_chartUrl_(sym),
      screenerUrl: ab_screenerUrl_(sym),
      details: details,
      highlights: highlights
    });
  }

  if (newLogRows.length) {
    logSheet.getRange(logSheet.getLastRow() + 1, 1, newLogRows.length, 12).setValues(newLogRows);
  }
  return fired;
}

/**
 * Re-prices every alert ever logged so the hit-rate numbers stay live:
 * updates Current Price, % Since Alert, Days Since and Outcome. Also
 * pushes the % back into Main's "% Up/Down After Alert" column for the
 * most recent alert of each symbol.
 */
/**
 * Stoploss per symbol, straight from Main. Used to resolve alert
 * outcomes: a Loss is "price closed at or below where I decided the
 * idea was wrong", not an arbitrary percentage drop.
 *
 * Best-effort - if Main has no Stoploss column, or the layout can't be
 * read for any reason, this returns an empty map and every alert simply
 * stays Open until it either wins or you set a stop.
 */
function ab_stoplossBySymbol_() {
  const map = {};
  try {
    const layout = ab_getMainLayout_();
    if (layout.stoploss === -1) return map;
    const data = layout.data;
    for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
      const sym = String(data[r][layout.symbol] || '').trim().toUpperCase();
      const name = String(data[r][layout.name] || '').trim();
      if (!sym && !name) break;
      if (!sym) continue;
      const sl = ab_toNum_(data[r][layout.stoploss]);
      if (!isNaN(sl) && sl > 0) map[sym] = sl;
    }
  } catch (e) {
    Logger.log('Stoploss lookup unavailable (' + e.message + ') - alerts will resolve on the win rule only.');
  }
  return map;
}

function updateAlertOutcomes_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logSheet = ss.getSheetByName(AB_ALERT_LOG_SHEET);
  if (!logSheet || logSheet.getLastRow() < 2) return;

  const priceMap = ab_getTodayCloseMap_();
  const stopMap = ab_stoplossBySymbol_();
  const rows = logSheet.getRange(2, 1, logSheet.getLastRow() - 1, 12).getValues();
  const now = new Date();
  const latestPctBySymbol = {};

  const out = rows.map(r => {
    const sym = String(r[1]).trim().toUpperCase();
    // Use the ALERT LEVEL (the price you set) as the base, not the exact
    // execution price at the moment of firing - those two are nearly
    // identical for an after-hours trigger (both ~= the day's close),
    // which made this math come out near zero regardless of the real
    // move. Alert Level matches what the trigger email/push shows.
    const alertLevel = ab_toNum_(r[4]);
    let cur = priceMap[sym];
    if (cur === undefined || isNaN(cur)) cur = ab_toNum_(r[8]); // keep last known
    let pct = 0;
    if (!isNaN(cur) && !isNaN(alertLevel) && alertLevel > 0) {
      pct = (cur - alertLevel) / alertLevel * 100;
    }

    // Log dates are written as real Date objects, but tolerate a string or
    // a Sheets serial number in case a row was edited/pasted by hand.
    let daysSince = ab_toNum_(r[10]);
    let d = null;
    d = ab_parseDate_(r[0]);
    if (d) daysSince = Math.max(0, Math.round((now - d) / (1000 * 60 * 60 * 24)));

    // Stoploss is checked FIRST: if price is sitting under your stop,
    // the idea is dead regardless of what the percentage move says.
    const stop = stopMap[sym];
    let outcome = 'Open';
    if (stop !== undefined && !isNaN(cur) && cur <= stop) outcome = 'Loss';
    else if (pct >= AB_ALERT_WIN_PCT) outcome = 'Win';

    latestPctBySymbol[sym] = pct; // later rows overwrite earlier = most recent alert
    return [cur, Math.round(pct * 100) / 100, daysSince, outcome];
  });

  logSheet.getRange(2, 9, out.length, 4).setValues(out);

  // Mirror the most recent alert's % back into Main's own column
  try {
    const layout = ab_getMainLayout_();
    if (layout.pctAfter !== -1) {
      const data = layout.data;
      for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
        const sym = String(data[r][layout.symbol]).trim().toUpperCase();
        const name = String(data[r][layout.name]).trim();
        if (!sym && !name) break;
        if (!sym || latestPctBySymbol[sym] === undefined) continue;
        ab_writePct_(layout.sheet.getRange(r + 1, layout.pctAfter + 1), latestPctBySymbol[sym]);
      }
    }
  } catch (e) {
    Logger.log('Could not mirror % back into Main: ' + e.message);
  }
}

/**
 * Rebuilds the "Alert Dashboard" tab: hit rate by alert type, plus the
 * most recent alerts. Recomputed from the Alert Log every run.
 */
function buildAlertDashboard_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logSheet = ss.getSheetByName(AB_ALERT_LOG_SHEET);
  const dash = ab_getOrCreateSheet_(AB_ALERT_DASH_SHEET);
  dash.clearContents();

  const stamp = Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm');
  if (!logSheet || logSheet.getLastRow() < 2) {
    dash.getRange(1, 1, 2, 1).setValues([['ALERT DASHBOARD'], ['No alerts logged yet. Updated ' + stamp]]);
    return;
  }

  const rows = logSheet.getRange(2, 1, logSheet.getLastRow() - 1, 12).getValues();

  // Aggregate by alert type
  const types = {};
  rows.forEach(r => {
    const t = String(r[3]).trim() || 'Unknown';
    if (!types[t]) types[t] = { total: 0, win: 0, loss: 0, open: 0, pctSum: 0, pctN: 0 };
    const s = types[t];
    s.total++;
    const outcome = String(r[11]).trim();
    if (outcome === 'Win') s.win++;
    else if (outcome === 'Loss') s.loss++;
    else s.open++;
    const pct = ab_toNum_(r[9]);
    if (!isNaN(pct)) { s.pctSum += pct; s.pctN++; }
  });

  const block = [];
  block.push(['ALERT DASHBOARD', '', '', '', '', '']);
  block.push(['Updated: ' + stamp, '', '', '', '', '']);
  block.push(['', '', '', '', '', '']);
  block.push(['Alert Type', 'Total', 'Win', 'Loss', 'Open', 'Hit Rate % (of settled)']);

  Object.keys(types).sort().forEach(t => {
    const s = types[t];
    const settled = s.win + s.loss;
    const hitRate = settled ? Math.round((s.win / settled) * 1000) / 10 : '';
    block.push([t, s.total, s.win, s.loss, s.open, hitRate]);
  });

  block.push(['', '', '', '', '', '']);
  block.push(['Alert Type', 'Avg % Since Alert', '', '', '', '']);
  Object.keys(types).sort().forEach(t => {
    const s = types[t];
    block.push([t, s.pctN ? Math.round((s.pctSum / s.pctN) * 100) / 100 : '', '', '', '', '']);
  });

  block.push(['', '', '', '', '', '']);
  block.push(['RECENT ALERTS (latest 20)', '', '', '', '', '']);
  block.push(['Date', 'Symbol', 'Type', 'Trigger Price', '% Since', 'Outcome']);
  rows.slice(-20).reverse().forEach(r => {
    block.push([r[0], r[1], r[3], r[5], r[9], r[11]]);
  });

  dash.getRange(1, 1, block.length, 6).setValues(block);
  dash.getRange(4, 1, 1, 6).setFontWeight('bold');
  dash.getRange(1, 1, 1, 1).setFontWeight('bold');
}

/*****************************************************************
 * ALERT EMAIL COLOUR CODING
 * -----------------------------------------------------------------
 * One palette, one rule-set, applied to every field in the card so
 * the numbers that matter read at a glance instead of being a wall of
 * identical bold black text.
 *
 * Colour is assigned from the field's LABEL where the meaning is fixed
 * regardless of value (entry is always green, stoploss always red),
 * and from the VALUE where the meaning depends on it (a growth figure
 * is green when positive, red when negative; a trend tag is green when
 * Increasing, red when Decreasing).
 *
 * Fields with no clear good/bad reading - dates, indices, MCAP, ATR,
 * sector names - are deliberately left plain. Colouring everything
 * would mean colouring nothing.
 *****************************************************************/
const AB_C_POS = '#0a8f4f'; // good / up / in your favour
const AB_C_NEG = '#d64545'; // bad / down / against you
const AB_C_WARN = '#b8860b'; // unsettled - Volatile
const AB_C_MUTED = '#777777'; // flat / neutral - Stagnant, zero moves
const AB_C_INFO = '#1558d6'; // informational - Open trades, Entry alerts
const AB_C_PLAIN = '#111111'; // no opinion

/**
 * Colour for one label/value pair. Returns AB_C_PLAIN when the field
 * carries no good-or-bad meaning.
 */
function ab_fieldColour_(label, value) {
  const L = String(label || '').toLowerCase();
  const raw = String(value === null || value === undefined ? '' : value).trim();
  if (!raw) return AB_C_PLAIN;
  const V = raw.toLowerCase();

  // --- fixed by label, whatever the number says ---
  if (/stop\s*-?\s*loss/.test(L)) return AB_C_NEG;
  if (/entry price/.test(L)) return AB_C_POS;
  if (/target/.test(L)) return AB_C_POS;

  // --- fixed by value ---
  // Checked before the plain words so "Slightly Increasing" isn't
  // mistaken for "Increasing" by a looser match later on.
  if (V === 'aggressive increase') return AB_C_POS;
  if (V === 'aggressive decrease') return AB_C_NEG;
  if (V === 'slightly increasing') return AB_C_POS;
  if (V === 'slightly decreasing') return AB_C_NEG;
  if (V === 'increasing') return AB_C_POS;
  if (V === 'decreasing') return AB_C_NEG;
  if (V === 'volatile') return AB_C_WARN;
  if (V === 'stagnant') return AB_C_MUTED;
  if (V === 'win') return AB_C_POS;
  if (V === 'loss') return AB_C_NEG;
  if (V === 'open') return AB_C_INFO;
  if (V === 'y' || V === 'yes') return AB_C_POS;
  if (V === 'n' || V === 'no') return AB_C_MUTED;

  // --- signed numbers, but only on fields where sign means something ---
  if (/%|growth|change|move|eps|profit|margin|return/.test(L)) {
    const n = Number(raw.replace(/[%,+\s]/g, ''));
    if (!isNaN(n)) {
      if (n > 0) return AB_C_POS;
      if (n < 0) return AB_C_NEG;
      return AB_C_MUTED;
    }
  }
  return AB_C_PLAIN;
}

/**
 * Fintech-app-style HTML card for one fired alert - full row context,
 * colour-coded by alert type, with View Chart / Screener.in buttons.
 */
function ab_alertCardHtml_(f) {
  // Breakout is a move in your favour, Price Fall a move against you,
  // Entry is neither - it just means a trade you set up is now live.
  let accent = AB_C_NEG, bg = '#fdecec';
  if (f.type === 'Breakout') { accent = AB_C_POS; bg = '#eafaf1'; }
  else if (f.type === 'Entry') { accent = AB_C_INFO; bg = '#eaf1fd'; }

  const moveColor = f.pctMove > 0 ? AB_C_POS : (f.pctMove < 0 ? AB_C_NEG : AB_C_MUTED);
  const moveSign = f.pctMove >= 0 ? '+' : '';

  function row(label, val) {
    if (val === '' || val === null || val === undefined) return '';
    const colour = ab_fieldColour_(label, val);
    const weight = colour === AB_C_PLAIN ? '600' : '700';
    return '<tr><td style="padding:4px 10px;color:#666;font-size:13px;">' + label + '</td>' +
           '<td style="padding:4px 10px;color:' + colour + ';font-size:13px;font-weight:' + weight +
           ';text-align:right;">' + val + '</td></tr>';
  }

  let html = '';
  html += '<div style="font-family:Arial,Helvetica,sans-serif;max-width:420px;border:1px solid #e2e2e2;border-radius:12px;overflow:hidden;margin-bottom:16px;">';
  html += '  <div style="background:' + bg + ';padding:14px 16px;border-left:5px solid ' + accent + ';">';
  html += '    <div style="font-size:11px;letter-spacing:0.5px;color:' + accent + ';font-weight:700;text-transform:uppercase;">' + f.type + ' Alert' + (f.priceSource === 'live' ? ' · LIVE' : '') + '</div>';
  html += '    <div style="font-size:19px;font-weight:700;color:#111;margin-top:2px;">' + f.symbol + '</div>';
  html += '    <div style="font-size:13px;color:#555;">' + (f.name || '') + (f.sector ? ' · ' + f.sector : '') + '</div>';
  html += '  </div>';
  html += '  <table style="width:100%;border-collapse:collapse;padding:6px 0;">';
  html += row('Alert Level', f.level);
  html += row('Price Now', f.price);
  html += '<tr><td style="padding:4px 10px;color:#666;font-size:13px;">% Move from Alert</td>' +
          '<td style="padding:4px 10px;color:' + moveColor + ';font-size:13px;font-weight:700;text-align:right;">' + moveSign + f.pctMove.toFixed(2) + '%</td></tr>';
  html += row('% Change (day)', typeof f.pctChange === 'number' ? f.pctChange + '%' : f.pctChange);
  html += row('Zone', f.zone);
  html += row('MCAP (Cr)', f.mcap);
  if (f.entryPrice) html += row('Your Entry Price', f.entryPrice);
  if (f.stoploss) html += row('Your Stoploss', f.stoploss);
  html += row('Pattern', f.pattern);
  html += row('FVG Tags', f.fvg);
  html += '  </table>';

  // Full row detail, grouped by category - everything else Main has for
  // this symbol (Basic Industry, PE vs Industry PE, PEG Ratio, Quarterly
  // Results status, the rest of Alert System/Valuation/Promotor-FII/OPM/
  // Technical) so the email stands on its own.
  if (f.details && f.details.length) {
    f.details.forEach(function (group) {
      const cat = group[0], fields = group[1];
      if (!fields.length) return;
      html += '  <div style="padding:8px 16px 4px;background:#fff;border-top:1px solid #eee;">';
      html += '    <div style="font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:2px;">' + cat + '</div>';
      html += '    <table style="width:100%;border-collapse:collapse;">';
      fields.forEach(function (fld) { html += row(fld.label, fld.value); });
      html += '    </table>';
      html += '  </div>';
    });
  }

  html += '  <div style="padding:12px 16px;background:#fafafa;border-top:1px solid #eee;">';
  html += '    <a href="' + f.chartUrl + '" style="display:inline-block;margin-right:10px;padding:8px 14px;background:' + accent + ';color:#fff;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600;">View Chart</a>';
  html += '    <a href="' + f.screenerUrl + '" style="display:inline-block;padding:8px 14px;background:#333;color:#fff;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600;">Screener.in</a>';
  html += '  </div>';
  html += '</div>';
  return html;
}

/** Rich HTML digest email - one fintech-style card per fired alert. */
function sendAlertEmail_(fired) {
  if (!fired || !fired.length) return;
  const ts = Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm');
  const isLive = fired.some(f => f.priceSource === 'live');

  let html = '<div style="font-family:Arial,Helvetica,sans-serif;">';
  html += '<h2 style="margin:0 0 4px 0;">' + fired.length + ' Alert' + (fired.length > 1 ? 's' : '') + ' Triggered</h2>';
  html += '<div style="color:#777;font-size:13px;margin-bottom:16px;">' + ts + ' IST</div>';
  fired.forEach(f => { html += ab_alertCardHtml_(f); });
  html += '<div style="color:#999;font-size:12px;margin-top:8px;">';
  html += 'Full history and hit-rate stats: "Alert Dashboard" tab. Each alert fires once - clear "Triggered Y/N" in Main to re-arm it.';
  html += '</div></div>';

  // Plain-text fallback for clients that don't render HTML
  let text = 'These alerts triggered on ' + ts + ':\n\n';
  fired.forEach(f => {
    text += '- ' + f.symbol + (f.name ? ' (' + f.name + ')' : '') + '\n';
    text += '    ' + f.type + ' alert - level ' + f.level + ', now ' + f.price + ' (' + (f.pctMove >= 0 ? '+' : '') + f.pctMove.toFixed(2) + '%)\n';
    if (f.pattern) text += '    Pattern: ' + f.pattern + '\n';
    if (f.fvg) text += '    FVG: ' + f.fvg + '\n';
    text += '    Chart: ' + f.chartUrl + '\n    Screener: ' + f.screenerUrl + '\n';
    text += ab_detailsToText_(f.details);
    text += '\n';
  });

  try {
    ab_sendMail_({
      to: AB_EMAIL_TO,
      subject: (isLive ? '⚡ ' : '') + 'Trading Alert' + (fired.length > 1 ? 's' : '') + ' - ' + fired.length + ' triggered (' + ts + ')',
      body: text,
      htmlBody: html
    });
  } catch (e) {
    Logger.log('Alert email failed: ' + e.message);
  }
}

/*****************************************************************
 * PUSHBULLET PUSH NOTIFICATIONS
 * -----------------------------------------------------------------
 * Sends the same alerts to the Pushbullet app (phone/desktop) as
 * well as email. Uses the v2 "pushes" endpoint with a note-type push.
 *
 * Token resolution order:
 *   1. Script Property PUSHBULLET_TOKEN, if set
 *   2. the AB_PUSHBULLET_TOKEN constant above
 * With neither, every push function quietly no-ops so the rest of the
 * run is unaffected.
 *****************************************************************/
function ab_getPushbulletToken_() {
  try {
    const t = PropertiesService.getScriptProperties().getProperty(AB_PUSHBULLET_PROP);
    if (t && String(t).trim()) return String(t).trim();
  } catch (e) {
    Logger.log('Could not read Pushbullet Script Property (' + e.message + ') - using the built-in token.');
  }
  return (typeof AB_PUSHBULLET_TOKEN === 'string') ? AB_PUSHBULLET_TOKEN.trim() : '';
}

/**
 * Sends one note-type push. Returns true on success. Never throws -
 * a push failure must not break the daily data run.
 */
function ab_sendPushbullet_(title, body) {
  const token = ab_getPushbulletToken_();
  if (!token) {
    Logger.log('Pushbullet skipped - no token available (neither ' + AB_PUSHBULLET_PROP +
               ' nor AB_PUSHBULLET_TOKEN is set).');
    return false;
  }
  try {
    const res = UrlFetchApp.fetch(AB_PUSHBULLET_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'Access-Token': token },
      payload: JSON.stringify({ type: 'note', title: title, body: body }),
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    if (code >= 200 && code < 300) return true;
    Logger.log('Pushbullet failed (HTTP ' + code + '): ' + res.getContentText());
    return false;
  } catch (e) {
    Logger.log('Pushbullet error: ' + e.message);
    return false;
  }
}

/**
 * Alert digest as a push. Pushbullet notes are plain text (no HTML), so
 * this lays out the same "entire row" info as the email card, just as
 * readable text with the chart/screener URLs on their own lines - the
 * Pushbullet app auto-links bare URLs.
 */
function sendAlertPush_(fired) {
  if (!fired || !fired.length) return;
  const ts = Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm');
  const isLive = fired.some(f => f.priceSource === 'live');

  let body = '';
  fired.forEach(f => {
    body += (isLive ? '⚡ ' : '') + f.symbol + (f.name ? ' (' + f.name + ')' : '') + '\n';
    body += f.type + ' alert - level ' + f.level + ', now ' + f.price +
            ' (' + (f.pctMove >= 0 ? '+' : '') + f.pctMove.toFixed(2) + '%)\n';
    if (f.sector) body += 'Sector: ' + f.sector + '\n';
    if (f.zone) body += 'Zone: ' + f.zone + '\n';
    if (f.entryPrice) body += 'Your Entry: ' + f.entryPrice + '\n';
    if (f.stoploss) body += 'Your Stoploss: ' + f.stoploss + '\n';
    if (f.pattern) body += 'Pattern: ' + f.pattern + '\n';
    if (f.fvg) body += 'FVG: ' + f.fvg + '\n';
    // Condensed highlights only (full breakdown is in the email) - keeps
    // the push notification readable on a phone.
    if (f.highlights) {
      if (f.highlights.basicIndustry) body += 'Basic Industry: ' + f.highlights.basicIndustry + '\n';
      if (f.highlights.peVsIndustryPe) body += 'PE vs Industry PE: ' + f.highlights.peVsIndustryPe + '\n';
      if (f.highlights.pegRatio) body += 'PEG Ratio: ' + f.highlights.pegRatio + '\n';
      if (f.highlights.resultsUpdated) body += 'Quarterly Results Updated: ' + f.highlights.resultsUpdated + '\n';
    }
    body += 'Chart: ' + f.chartUrl + '\n';
    body += 'Screener: ' + f.screenerUrl + '\n';
    body += '\n';
  });
  body += 'Full field-by-field breakdown: check your email. History: Alert Dashboard tab.';

  ab_sendPushbullet_(
    (isLive ? '⚡ ' : '') + 'Trading Alert' + (fired.length > 1 ? 's' : '') + ' - ' + fired.length + ' triggered (' + ts + ')',
    body);
}

/** Menu item - confirms the token and connection actually work. */
function testPushbullet() {
  const ok = ab_sendPushbullet_(
    'Stock Blueprint - test',
    'If you can read this, Pushbullet alerts are wired up correctly.');
  SpreadsheetApp.getActiveSpreadsheet().toast(
    ok ? 'Test push sent - check your Pushbullet app.'
       : 'Push failed - the token may be wrong or revoked. See the Executions log for the HTTP response.');
}

/** Menu entry point - runs the whole alert pass on demand. */
function runAlertsNow() {
  const fired = checkPriceAlerts_();
  updateAlertOutcomes_();
  buildAlertDashboard_();
  sendAlertEmail_(fired);
  sendAlertPush_(fired);
  SpreadsheetApp.getActiveSpreadsheet().toast(
    fired.length ? (fired.length + ' alert(s) fired - see Alert Log.') : 'No new alerts fired.');
}

/** Re-arms every alert by clearing the Triggered Y/N flags in Main. */
function resetTriggeredFlags_() {
  const layout = ab_getMainLayout_();
  const data = layout.data;
  let cleared = 0;
  for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
    const sym = String(data[r][layout.symbol]).trim();
    const name = String(data[r][layout.name]).trim();
    if (!sym && !name) break;
    if (!sym) continue;
    if (String(data[r][layout.triggered]).trim()) {
      layout.sheet.getRange(r + 1, layout.triggered + 1).clearContent();
      cleared++;
    }
  }
  SpreadsheetApp.getActiveSpreadsheet().toast('Cleared ' + cleared + ' triggered flag(s). Alerts are re-armed.');
}

/*****************************************************************
 * INTRADAY CHECK - the fast-cadence trigger
 * -----------------------------------------------------------------
 * Runs every 5 minutes (or however often you've set the trigger to),
 * 24x7. Price-level alerts have no market-hours restriction; the FVG
 * "approaching" and "mitigated" zone passes only act 9:15-3:30 IST on
 * weekdays.
 *
 * No GOOGLEFINANCE fetch of its own - Main's own "MKT Price" column is
 * already a live-updating cell, so this just reads that directly
 * (via checkPriceAlerts_'s built-in fallback: pass an empty price map
 * and it uses each row's own MKT Price). That's faster than a separate
 * batched fetch, and removes the scratch-sheet collision risk entirely
 * since nothing gets written anywhere before reading - it's a single
 * read-then-stamp pass over Main.
 *
 * Still locked, since two overlapping runs could otherwise both try to
 * stamp the same row's Triggered flag at once - now a much smaller,
 * near-instant window than the old GOOGLEFINANCE round-trip.
 *****************************************************************/
function checkIntradayAlerts_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    Logger.log('checkIntradayAlerts_: previous run still in progress, skipping this cycle.');
    return;
  }

  try {
    const fired = checkPriceAlerts_({}, 'live'); // {} forces the MKT Price fallback for every row
    if (fired.length) {
      sendAlertEmail_(fired);
      sendAlertPush_(fired);
    }

    // Gap-up / Unmitigated FVG "approaching" alerts ride the same
    // 5-minute cadence - that's what makes them immediate - but ONLY
    // during market hours. Outside them MKT Price is just the frozen
    // last close, so nothing can genuinely "approach" anything. Without
    // this gate, every zone formed by the evening scan was held back as
    // too new until midnight, then fired at ~00:01 the moment the date
    // rolled over and it turned 1 day old - off a stale closing price.
    // (The evening EOD sweep in the daily pipeline is separate and
    // still runs against the day's settled prices.) Soft-fails so a
    // problem here can't stop the price-level alerts above from running
    // on the next cycle.
    if (ab_isMarketHours_()) {
      try {
        ab_sendZoneAlerts_(checkGapUpAlerts_());
      } catch (gErr) {
        Logger.log('Gap-up alert pass failed: ' + gErr.message);
      }
      try {
        ab_sendZoneAlerts_(checkUnmitigatedAlerts_());
      } catch (uErr) {
        Logger.log('Unmitigated FVG alert pass failed: ' + uErr.message);
      }
      // IPO bases: live "approaching" / "trading above" (the 7 PM mail confirms by the close).
      try {
        sendIpoBaseIntradayEmail_(checkIpoBaseIntraday_());
      } catch (iErr) {
        Logger.log('IPO base live alert pass failed: ' + iErr.message);
      }
    }

    // Separate "mitigated" passes - self-gate on market hours inside
    // ab_checkZoneMitigatedAlerts_, so these are safe to call 24x7.
    try {
      ab_sendZoneMitigatedAlerts_(checkUnmitigatedMitigatedAlerts_());
    } catch (mErr) {
      Logger.log('Unmitigated FVG mitigated-alert pass failed: ' + mErr.message);
    }
    try {
      ab_sendZoneMitigatedAlerts_(checkGapUpMitigatedAlerts_());
    } catch (gmErr) {
      Logger.log('Gap-up FVG mitigated-alert pass failed: ' + gmErr.message);
    }
  } finally {
    lock.releaseLock();
  }
}

function installIntradayAlertTrigger() {
  removeIntradayAlertTrigger();
  ScriptApp.newTrigger('checkIntradayAlerts_')
    .timeBased()
    .everyMinutes(5)
    .create();
  SpreadsheetApp.getActiveSpreadsheet().toast(
    'Intraday alert trigger installed - every 5 min. Watches and entry-only trades ' +
    'fire 24x7; trades taken off an alert level fire only 9:15am-3:30pm IST.');
}

function removeIntradayAlertTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'checkIntradayAlerts_') ScriptApp.deleteTrigger(t);
  });
}

/*****************************************************************
 * TRADE TRACKING - real trades only (Entry Price filled in)
 * -----------------------------------------------------------------
 * The alert system above just watches and notifies. This is the
 * layer on top of it that treats a symbol as an actual trade once
 * you fill in Entry Price for something that already triggered:
 *
 *   - Loss: price hits your Stoploss
 *   - Win:  price is AB_TRADE_WIN_PCT% or more above the ALERT price
 *           (the level you set, not your entry price)
 *   - otherwise it stays open - nothing logged yet
 *
 * Checked once daily at EOD (part of autoDailyUpdate). A resolved
 * trade gets exactly one permanent row in "Trade Log" and stamps
 * Main's Win/Loss column; open trades stay silent until they resolve.
 *****************************************************************/

function ab_getTradeLogSheet_() {
  const sh = ab_getOrCreateSheet_(AB_TRADE_LOG_SHEET);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, 13).setValues([[
      'Resolved Date', 'Symbol', 'Company', 'Alert Type', 'Alert Price',
      'Entry Price', 'Stoploss', 'Exit Price', '% From Alert', '% From Entry',
      'Days Held', 'Outcome', 'Triggered Date'
    ]]);
    sh.setFrozenRows(1);
  }
  return sh;
}

/**
 * For every symbol in the Alert Log, keep only the MOST RECENT row per
 * symbol - that's the alert an open trade is measured against.
 */
function ab_latestAlertBySymbol_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logSheet = ss.getSheetByName(AB_ALERT_LOG_SHEET);
  const map = {};
  if (!logSheet || logSheet.getLastRow() < 2) return map;
  const rows = logSheet.getRange(2, 1, logSheet.getLastRow() - 1, 12).getValues();
  rows.forEach(r => {
    const sym = String(r[1]).trim().toUpperCase();
    if (!sym) return;
    map[sym] = { date: r[0], type: r[3], level: ab_toNum_(r[4]) }; // later rows overwrite = most recent
  });
  return map;
}

/**
 * EOD trade resolution. Only looks at rows with Entry Price filled,
 * already Triggered = Y, and Win/Loss still blank (i.e. an open real
 * trade). Uses the day's close as the exit-check price.
 */
function resolveTradesEOD_() {
  const layout = ab_getMainLayout_();
  if (layout.entryPrice === -1 || layout.stoploss === -1 || layout.winLoss === -1) {
    Logger.log('Trade tracking columns (Entry Price / Stoploss / Win/Loss) not found in Main - skipping.');
    return [];
  }

  const priceMap = ab_getTodayCloseMap_();
  const alertMap = ab_latestAlertBySymbol_();
  const tradeLog = ab_getTradeLogSheet_();
  const todayStr = Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy');
  const now = new Date();

  const data = layout.data;
  const newRows = [];
  const resolved = [];

  for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
    const row = data[r];
    const sym = String(row[layout.symbol]).trim().toUpperCase();
    const name = String(row[layout.name]).trim();
    if (!sym && !name) break;
    if (!sym) continue;

    const triggered = String(row[layout.triggered]).trim().toUpperCase() === 'Y';
    const entryPrice = ab_toNum_(row[layout.entryPrice]);
    const stoploss = ab_toNum_(row[layout.stoploss]);
    const existingOutcome = String(row[layout.winLoss]).trim();
    if (!triggered || isNaN(entryPrice) || entryPrice <= 0 || existingOutcome) continue; // not a real open trade

    let price = priceMap[sym];
    if (price === undefined && layout.mktPrice !== -1) price = ab_toNum_(row[layout.mktPrice]);
    if (price === undefined || isNaN(price)) continue;

    const alert = alertMap[sym];
    const alertLevel = alert ? alert.level : ab_toNum_(row[layout.fallLevel]) || ab_toNum_(row[layout.breakLevel]);
    const alertType = alert ? alert.type : '';

    // Graded against YOUR ENTRY, not the alert level. Entry is the only
    // base both trade types share - an entry-only trade has no alert
    // level at all - and it's what you actually paid, so the percentage
    // is the one you'd really have made.
    let outcome = '';
    if (!isNaN(stoploss) && stoploss > 0 && price <= stoploss) {
      outcome = 'Loss';
    } else if (price >= entryPrice * (1 + AB_TRADE_WIN_PCT / 100)) {
      outcome = 'Win';
    }
    if (!outcome) continue; // still open - check again tomorrow

    const pctFromAlert = (!isNaN(alertLevel) && alertLevel > 0) ? (price - alertLevel) / alertLevel * 100 : NaN;
    const pctFromEntry = (price - entryPrice) / entryPrice * 100;

    let daysHeld = '';
    if (alert && alert.date) {
      const d = ab_parseDate_(alert.date);
      if (d) daysHeld = Math.max(0, Math.round((now - d) / (1000 * 60 * 60 * 24)));
    }

    layout.sheet.getRange(r + 1, layout.winLoss + 1).setValue(outcome);

    newRows.push([
      todayStr, sym, name, alertType, alertLevel, entryPrice, stoploss, price,
      isNaN(pctFromAlert) ? '' : Math.round(pctFromAlert * 100) / 100,
      Math.round(pctFromEntry * 100) / 100,
      daysHeld, outcome, alert && alert.date ? alert.date : ''
    ]);
    resolved.push({ symbol: sym, name: name, outcome: outcome, pctFromEntry: pctFromEntry, price: price });
  }

  if (newRows.length) {
    tradeLog.getRange(tradeLog.getLastRow() + 1, 1, newRows.length, 13).setValues(newRows);
  }
  return resolved;
}

/*****************************************************************
 * DAILY EOD SUMMARY EMAIL
 * -----------------------------------------------------------------
 * One mail at the end of the day covering:
 *   1. Everything that triggered today (watches and trades alike)
 *   2. Every open trade and where it stands - % from your entry, and
 *      how far price is above your stoploss
 *   3. Any trade that resolved to Win/Loss today
 *
 * Section 1 is read from Main's "Triggered Date" column rather than
 * from the EOD alert pass's return value, so it includes rows that the
 * 5-minute intraday trigger fired hours earlier - the whole point of
 * the mail is to catch you up on a day you couldn't watch.
 *
 * Sends nothing at all when all three sections are empty, so a quiet
 * day doesn't clutter your inbox.
 *****************************************************************/

/** Everything in Main whose Triggered Date falls on `dayStr`. */
function ab_triggeredToday_(layout, dayStr) {
  const out = [];
  if (layout.trigDate === -1) return out;
  const data = layout.data;
  for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
    const sym = String(data[r][layout.symbol] || '').trim().toUpperCase();
    const name = String(data[r][layout.name] || '').trim();
    if (!sym && !name) break;
    if (!sym) continue;
    if (String(data[r][layout.triggered] || '').trim().toUpperCase() !== 'Y') continue;

    const raw = data[r][layout.trigDate];
    let stamped = '';
    if (raw instanceof Date) stamped = Utilities.formatDate(raw, AB_TZ, 'dd-MMM-yyyy');
    else if (raw) stamped = String(raw).trim().slice(0, 11);
    if (stamped.indexOf(dayStr) !== 0) continue;

    const entry = layout.entryPrice !== -1 ? ab_toNum_(data[r][layout.entryPrice]) : NaN;
    const stop = layout.stoploss !== -1 ? ab_toNum_(data[r][layout.stoploss]) : NaN;
    const fall = ab_toNum_(data[r][layout.fallLevel]);
    const brk = ab_toNum_(data[r][layout.breakLevel]);
    out.push({
      symbol: sym, name: name,
      kind: ab_classifyAlertRow_(fall, brk, entry, stop),
      price: layout.mktPrice !== -1 ? ab_toNum_(data[r][layout.mktPrice]) : NaN,
      entry: entry, stop: stop,
      // Stored as a fraction by ab_writePct_ (0.0125 = +1.25%), so scale
      // back up into percent units for display.
      pctAfter: layout.pctAfter !== -1 ? ab_toNum_(data[r][layout.pctAfter]) * 100 : NaN
    });
  }
  return out;
}

/** Trades that are entered and triggered but not yet resolved. */
function ab_openTrades_(layout) {
  const out = [];
  if (layout.entryPrice === -1 || layout.stoploss === -1 || layout.winLoss === -1) return out;
  const data = layout.data;
  for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
    const sym = String(data[r][layout.symbol] || '').trim().toUpperCase();
    const name = String(data[r][layout.name] || '').trim();
    if (!sym && !name) break;
    if (!sym) continue;
    if (String(data[r][layout.triggered] || '').trim().toUpperCase() !== 'Y') continue;
    if (String(data[r][layout.winLoss] || '').trim()) continue; // already resolved

    const entry = ab_toNum_(data[r][layout.entryPrice]);
    const stop = ab_toNum_(data[r][layout.stoploss]);
    if (isNaN(entry) || entry <= 0) continue;

    const price = layout.mktPrice !== -1 ? ab_toNum_(data[r][layout.mktPrice]) : NaN;
    out.push({
      symbol: sym, name: name, entry: entry, stop: stop, price: price,
      pctFromEntry: (!isNaN(price)) ? (price - entry) / entry * 100 : NaN,
      pctToStop: (!isNaN(price) && !isNaN(stop) && stop > 0) ? (price - stop) / stop * 100 : NaN,
      target: entry * (1 + AB_TRADE_WIN_PCT / 100)
    });
  }
  return out;
}

function ab_num2_(n) {
  return (n === null || n === undefined || isNaN(n)) ? '-' : (Math.round(n * 100) / 100).toString();
}
function ab_pct2_(n) {
  if (n === null || n === undefined || isNaN(n)) return '-';
  const v = Math.round(n * 100) / 100;
  return (v > 0 ? '+' : '') + v + '%';
}

/*****************************************************************
 * MISSED OPPORTUNITIES
 * -----------------------------------------------------------------
 * The EOD Summary's Mitigated FVG and Spring Pattern lists are
 * "watch this" signals. Every symbol that appears in either is logged
 * (day + source) to the "Signal Watchlist Log" and NEVER removed. On
 * the first trading day after it was flagged, if the stock moved from
 * its OPEN to its HIGH by AB_MISSED_PCT% or more (History30 candles
 * only - no Google Finance price), it is reported in the EOD email's
 * "Missed Opportunities" section. Weekends and exchange holidays are
 * skipped because the check uses the first History30 candle dated
 * after the flag. Running the EOD summary more than once in a day
 * changes nothing.
 *
 * Deliberately NOT tracked: Triggered/Open Trades, the Gainers/Losers
 * lists, and the Unmitigated/Gap-up FVG "Approaching" lists.
 *****************************************************************/

function ab_getSignalWatchlistSheet_() {
  const sh = ab_getOrCreateSheet_(AB_SIGNAL_WATCHLIST_SHEET);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, 5).setValues([[
      'Date Flagged', 'Symbol', 'Name', 'Source', 'Price At Flag'
    ]]);
    sh.setFrozenRows(1);
  }
  return sh;
}

/** A log date cell ("08-Oct-2026" text, or a real date) -> sortable "yyyymmdd", '' if unreadable. */
function ab_msDateKey_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return Utilities.formatDate(v, AB_TZ, 'yyyyMMdd');
  const m = String(v || '').trim().match(/^(\d{1,2})[-\/ ]([A-Za-z]{3})[a-z]*[-\/ ](\d{4})$/);
  if (!m) return '';
  const mon = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2].toLowerCase());
  if (mon === -1) return '';
  return m[3] + ('0' + (mon + 1)).slice(-2) + ('0' + m[1]).slice(-2);
}


/** Latest trading day in History30, as "yyyymmdd" ('' if none) - the day the EOD summary describes. */
function ab_msLatestHistoryKey_(bySymbol) {
  let latest = '';
  Object.keys(bySymbol).forEach(function (sym) {
    const c = bySymbol[sym];
    if (!c.length) return;
    const k = ab_msDateKey_(c[c.length - 1].date);
    if (k > latest) latest = k;
  });
  return latest;
}

/** "yyyymmdd" -> "dd-MMM-yyyy". */
function ab_msKeyToDmy_(k) {
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return k.slice(6, 8) + '-' + mon[Number(k.slice(4, 6)) - 1] + '-' + k.slice(0, 4);
}

/** True when a "yyyymmdd" key falls on a Saturday or Sunday (no trading). */
function ab_msIsWeekendKey_(k) {
  if (!k || k.length < 8) return false;
  const d = new Date(Number(k.slice(0, 4)), Number(k.slice(4, 6)) - 1, Number(k.slice(6, 8))).getDay();
  return d === 0 || d === 6;
}

/** Existing log rows as {key, dateKey, symbol, source, name}. Weekend-dated rows (no session) are ignored. */
function ab_msReadLog_() {
  const sh = ab_getSignalWatchlistSheet_();
  if (sh.getLastRow() < 2) return [];
  const out = [];
  sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues().forEach(function (r) {
    const dk = ab_msDateKey_(r[0]);
    const sym = String(r[1] || '').trim().toUpperCase();
    if (!dk || !sym || ab_msIsWeekendKey_(dk)) return;
    out.push({ dateKey: dk, symbol: sym, name: String(r[2] || ''), source: String(r[3] || '').trim() });
  });
  return out;
}

/**
 * Fills in earlier days' "Mitigated FVG" flags from the Mitigated FVG
 * Log (which has always recorded every mitigation with its date) for any
 * day the Signal Watchlist Log doesn't already hold. Safe to run every
 * time - only missing day/symbol pairs are added, nothing is removed.
 * Looks back 40 days (a little past History30's 30-day window).
 */
function ab_msBackfillFromMitigatedLog_(bySymbol) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const mlog = ss.getSheetByName(AB_MITIGATED_LOG_SHEET);
  if (!mlog || mlog.getLastRow() < 2) return 0;
  const sh = ab_getSignalWatchlistSheet_();
  const have = {};
  ab_msReadLog_().forEach(function (x) { have[x.dateKey + '|' + x.symbol + '|' + x.source] = true; });

  const cut = new Date(); cut.setDate(cut.getDate() - 40);
  const cutKey = Utilities.formatDate(cut, AB_TZ, 'yyyyMMdd');
  const add = [];
  mlog.getRange(2, 1, mlog.getLastRow() - 1, 4).getValues().forEach(function (r) {
    const dk = ab_msDateKey_(r[0]);
    const sym = String(r[3] || '').trim().toUpperCase();
    if (!dk || dk < cutKey || !sym) return;
    const key = dk + '|' + sym + '|Mitigated FVG';
    if (have[key]) return;
    have[key] = true;
    add.push([ab_msKeyToDmy_(dk), sym, '', 'Mitigated FVG', ab_msCloseOn_(bySymbol, sym, dk)]);
  });
  if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, 5).setValues(add);
  return add.length;
}

/** History30 close for a symbol on a day ('' if none). */
function ab_msCloseOn_(bySymbol, sym, dateKey) {
  const c = bySymbol[sym] || [];
  for (let i = c.length - 1; i >= 0; i--) {
    if (ab_msDateKey_(c[i].date) === dateKey) return isNaN(c[i].Cls) ? '' : c[i].Cls;
  }
  return '';
}

/**
 * MISSED OPPORTUNITIES for one trading day (default: the latest day in
 * History30). A symbol flagged on an earlier day (Mitigated FVG / Spring
 * Pattern) is looked at on the FIRST TRADING DAY AFTER it was flagged -
 * the first History30 candle dated after the flag, so Saturdays, Sundays
 * and exchange holidays are skipped automatically. If that candle's
 * move from OPEN to HIGH is at least AB_MISSED_PCT%, it was a missed
 * opportunity. Prices come only from History30 (the official daily
 * candles), never from Main's Google Finance quote.
 *
 * The log is never wiped, so this gives the same answer however many
 * times the EOD summary runs. The returned array carries .meta =
 * { checked, flaggedOn, biggest } (what was looked at, and the biggest
 * Open-to-High move seen) for the "nothing crossed" message.
 */
function ab_checkMissedOpportunities_(layout, dayKey, bySymbol) {
  const hits = [];
  hits.meta = { checked: 0, flaggedOn: '', biggest: null };
  const candlesBySym = bySymbol || ab_readHistoryCandles_();
  const checkKey = dayKey || ab_msLatestHistoryKey_(candlesBySym);
  if (!checkKey) return hits;

  const bySym = {};  // symbol -> { sources:{}, keys:{source: flagDayKey}, name, candle }
  const flagDays = {};
  const zoneIdx = ab_btZoneIndex_();
  ab_msReadLog_().forEach(function (x) {
    if (x.dateKey >= checkKey) return; // flagged on/after the day being checked - nothing to measure yet
    const c = candlesBySym[x.symbol];
    if (!c || !c.length) return;
    // First candle after the flag day.
    let first = null;
    for (let i = 0; i < c.length; i++) {
      if (ab_msDateKey_(c[i].date) > x.dateKey) { first = c[i]; break; }
    }
    if (!first || ab_msDateKey_(first.date) !== checkKey) return; // its day is not the one being reported
    const e = bySym[x.symbol] || (bySym[x.symbol] = { sources: {}, keys: {}, flaggedKey: x.dateKey, name: x.name, candle: first });
    e.sources[x.source] = true;
    if (!e.keys[x.source] || x.dateKey > e.keys[x.source]) e.keys[x.source] = x.dateKey;
    if (x.dateKey > e.flaggedKey) e.flaggedKey = x.dateKey;
    if (x.name && !e.name) e.name = x.name;
    flagDays[x.dateKey] = true;
  });

  const names = {};
  try {
    for (let r = layout.headerRowIdx + 1; r < layout.data.length; r++) {
      const sym = ab_cellText_(layout.data[r][layout.symbol]).toUpperCase();
      const nm = layout.name !== -1 ? ab_cellText_(layout.data[r][layout.name]) : '';
      if (!sym && !nm) break;
      if (sym) names[sym] = nm;
    }
  } catch (e) { /* names are cosmetic */ }

  Object.keys(bySym).forEach(function (sym) {
    const e = bySym[sym], k = e.candle;
    if (isNaN(k.Opn) || isNaN(k.High) || k.Opn <= 0) return;
    const pct = (k.High - k.Opn) / k.Opn * 100;
    hits.meta.checked++;
    if (!hits.meta.biggest || pct > hits.meta.biggest.pct) hits.meta.biggest = { symbol: sym, pct: pct };
    if (pct >= AB_MISSED_PCT) {
      const src = e.sources['Mitigated FVG'] ? 'Mitigated FVG' : 'Spring Pattern';
      const cl = ab_btClassifyFlag_(sym, e.keys[src], src, candlesBySym, zoneIdx);
      hits.push({ symbol: sym, name: names[sym] || e.name, source: Object.keys(e.sources).join(' + '),
                  cat: cl.cat, type: cl.type, zonePct: cl.zonePct,
                  dateFlagged: ab_msKeyToDmy_(e.flaggedKey), open: k.Opn, high: k.High, close: k.Cls, pct: pct,
                  closePct: isNaN(k.Cls) ? NaN : (k.Cls - k.Opn) / k.Opn * 100 });
    }
  });
  const days = Object.keys(flagDays).sort();
  hits.meta.flaggedOn = days.map(ab_msKeyToDmy_).join(', ');
  hits.sort(function (a, b) { return b.pct - a.pct; });
  Logger.log('Missed opportunities for ' + ab_msKeyToDmy_(checkKey) + ': checked ' + hits.meta.checked +
             ' symbol(s) flagged ' + (hits.meta.flaggedOn || '-') + ' - ' + hits.length + ' moved >= ' + AB_MISSED_PCT + '% open-to-high' +
             (hits.meta.biggest ? '; biggest ' + hits.meta.biggest.symbol + ' ' + ab_pct2_(hits.meta.biggest.pct) : '') + '.');
  return hits;
}

/**
 * Adds the day's fresh Mitigated FVG / Spring Pattern symbols to the
 * Signal Watchlist Log. NOTHING is ever deleted or replaced: a symbol
 * already logged for that day/source is simply skipped, so running the
 * EOD summary any number of times in a day changes nothing.
 * Returns how many new rows were added.
 */
function ab_logSignalWatchlist_(layout, mitigatedToday, springs, dayStr, bySymbol) {
  const sh = ab_getSignalWatchlistSheet_();
  const day = dayStr || Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy');
  const dayKey = ab_msDateKey_(day);
  if (ab_msIsWeekendKey_(dayKey)) return 0; // Saturday/Sunday: no session, nothing to flag
  const candles = bySymbol || ab_readHistoryCandles_();

  const names = {};
  for (let r = layout.headerRowIdx + 1; r < layout.data.length; r++) {
    const sym = ab_cellText_(layout.data[r][layout.symbol]).toUpperCase();
    const nm = layout.name !== -1 ? ab_cellText_(layout.data[r][layout.name]) : '';
    if (!sym && !nm) break;
    if (sym) names[sym] = nm;
  }

  const have = {};
  ab_msReadLog_().forEach(function (x) { have[x.dateKey + '|' + x.symbol + '|' + x.source] = true; });

  const add = [];
  const push = function (symRaw, source) {
    const sym = String(symRaw || '').trim().toUpperCase();
    if (!sym) return;
    const key = dayKey + '|' + sym + '|' + source;
    if (have[key]) return;
    have[key] = true;
    add.push([day, sym, names[sym] || '', source, ab_msCloseOn_(candles, sym, dayKey)]);
  };
  (mitigatedToday || []).forEach(function (m) { push(m.symbol, 'Mitigated FVG'); });
  (springs || []).forEach(function (s) { push(s.symbol, 'Spring Pattern'); });

  if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, 5).setValues(add);
  return add.length;
}

/*****************************************************************
 * FVG BACKTEST - which kind of flag worked the NEXT day
 * -----------------------------------------------------------------
 * Every Mitigated FVG / Spring Pattern flag (Signal Watchlist Log) is
 * judged on the first trading day after it was flagged, from History30:
 *   - Open to High %   (the opportunity that was there)
 *   - Close vs Open %  (did the day finish green)
 * and each result is stored ONCE on the "FVG Backtest" tab, tagged with
 * the flag's category (how the zone behaved on the flag day - Opened
 * inside & green / Held / Swept / Closed inside / Broke below) and its
 * zone type (FVG or Gap-up FVG). The EOD email then shows running totals
 * per category, so over weeks it shows which kinds worked.
 *
 * "Worked" = next-day Open to High >= AB_MISSED_PCT (read from the stored
 * numbers each time, so changing that setting re-scores the history).
 * One row per flagged day + symbol + source, so re-running never
 * double-counts.
 *****************************************************************/
const AB_BACKTEST_SHEET = 'FVG Backtest';
const AB_BT_HEADERS_ = ['Flagged On', 'Next Trading Day', 'Symbol', 'Source', 'Zone Type', 'Category', 'Zone %',
                        'Open', 'High', 'Close', 'Open to High %', 'Close vs Open %'];
const AB_BT_SPRING_ = { key: 'spring', label: 'Spring Pattern', colour: '#6a4fb3', bg: '#efeaf9',
                        note: 'Flagged by the Spring candlestick pattern (not an FVG).' };

/** All category definitions incl. Spring, in display order. */
function ab_btCats_() { return AB_MIT_CATS_.concat([AB_BT_SPRING_]); }

function ab_btCatByKey_(key) {
  const all = ab_btCats_();
  for (let i = 0; i < all.length; i++) if (all[i].key === key) return all[i];
  return all[all.length - 2]; // nodata
}

function ab_btCatByLabel_(label) {
  const all = ab_btCats_();
  for (let i = 0; i < all.length; i++) if (all[i].label === label) return all[i];
  return null;
}

/** Mitigated FVG Log -> { "yyyymmdd|SYMBOL": {type, bottom, top, pct} } (first zone per symbol per day). */
function ab_btZoneIndex_() {
  const idx = {};
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AB_MITIGATED_LOG_SHEET);
  if (!sh || sh.getLastRow() < 2) return idx;
  sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues().forEach(function (r) {
    const dk = ab_msDateKey_(r[0]);
    const sym = String(r[3] || '').trim().toUpperCase();
    if (!dk || !sym) return;
    const key = dk + '|' + sym;
    if (idx[key]) return;
    idx[key] = { type: String(r[2] || ''), bottom: ab_toNum_(r[4]), top: ab_toNum_(r[5]), pct: ab_toNum_(r[6]) };
  });
  return idx;
}

/**
 * Category of a flag: for a Mitigated FVG, how the zone behaved on the
 * FLAG day (same judgement as the "Mitigated FVG Today" groups, taken
 * from that day's History30 candle); Spring flags are their own group.
 * Returns { cat (key), type ('FVG' | 'Gap-up FVG' | 'Spring'), zonePct }.
 */
function ab_btClassifyFlag_(sym, flagKey, source, bySymbol, zoneIdx) {
  if (source === 'Spring Pattern') return { cat: 'spring', type: 'Spring', zonePct: NaN };
  const z = zoneIdx[flagKey + '|' + sym];
  if (!z) return { cat: 'nodata', type: 'FVG', zonePct: NaN };
  const type = /gap/i.test(z.type) ? 'Gap-up FVG' : 'FVG';
  const c = bySymbol[sym] || [];
  let k = null;
  for (let i = c.length - 1; i >= 0; i--) { if (ab_msDateKey_(c[i].date) === flagKey) { k = c[i]; break; } }
  if (!k) return { cat: 'nodata', type: type, zonePct: z.pct };
  const cls = ab_classifyMitigation_({ top: z.top, bottom: z.bottom }, { o: k.Opn, h: k.High, l: k.Low, c: k.Cls });
  return { cat: cls.cat, type: type, zonePct: z.pct };
}

function ab_btSheet_() {
  const sh = ab_getOrCreateSheet_(AB_BACKTEST_SHEET);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, AB_BT_HEADERS_.length).setValues([AB_BT_HEADERS_]).setFontWeight('bold').setBackground('#f1f3f4');
    sh.setFrozenRows(1);
  }
  return sh;
}

/**
 * Records, once each, the next-trading-day result of EVERY flag in the
 * Signal Watchlist Log whose next trading day exists in History30 - so a
 * first run also back-fills everything History30 still covers. Returns
 * the number of new rows.
 */
function ab_btSync_(bySymbol) {
  const sh = ab_btSheet_();
  const have = {};
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues().forEach(function (r) {
      have[ab_msDateKey_(r[0]) + '|' + String(r[2] || '').trim().toUpperCase() + '|' + String(r[3] || '').trim()] = true;
    });
  }
  const zoneIdx = ab_btZoneIndex_();
  const add = [];
  ab_msReadLog_().forEach(function (x) {
    const key = x.dateKey + '|' + x.symbol + '|' + x.source;
    if (have[key]) return;
    const c = bySymbol[x.symbol];
    if (!c || !c.length) return;
    let next = null;
    for (let i = 0; i < c.length; i++) { if (ab_msDateKey_(c[i].date) > x.dateKey) { next = c[i]; break; } }
    if (!next || isNaN(next.Opn) || isNaN(next.High) || next.Opn <= 0) return;
    have[key] = true;
    const cl = ab_btClassifyFlag_(x.symbol, x.dateKey, x.source, bySymbol, zoneIdx);
    add.push([ab_msKeyToDmy_(x.dateKey), ab_msKeyToDmy_(ab_msDateKey_(next.date)), x.symbol, x.source, cl.type,
              ab_btCatByKey_(cl.cat).label, isNaN(cl.zonePct) ? '' : cl.zonePct,
              next.Opn, next.High, isNaN(next.Cls) ? '' : next.Cls,
              Math.round((next.High - next.Opn) / next.Opn * 10000) / 100,
              isNaN(next.Cls) ? '' : Math.round((next.Cls - next.Opn) / next.Opn * 10000) / 100]);
  });
  if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, AB_BT_HEADERS_.length).setValues(add);
  return add.length;
}

/**
 * Running totals from the FVG Backtest tab, up to `asOfKey` (yyyymmdd):
 * { total, since, byCat: {key: stat}, byType: {type: stat} } where stat =
 * { n, hit, green, avgOh, avgClose }. "hit" = next-day Open to High >=
 * AB_MISSED_PCT; "green" = next-day close above open.
 */
function ab_btStats_(asOfKey) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AB_BACKTEST_SHEET);
  const out = { total: 0, since: '', byCat: {}, byType: {} };
  if (!sh || sh.getLastRow() < 2) return out;
  let sinceKey = '';
  const bump = function (m, k, oh, cl) {
    const s = m[k] || (m[k] = { n: 0, hit: 0, green: 0, sumOh: 0, sumCl: 0, nCl: 0 });
    s.n++; s.sumOh += oh;
    if (oh >= AB_MISSED_PCT) s.hit++;
    if (!isNaN(cl)) { s.nCl++; s.sumCl += cl; if (cl > 0) s.green++; }
  };
  sh.getRange(2, 1, sh.getLastRow() - 1, AB_BT_HEADERS_.length).getValues().forEach(function (r) {
    const flagKey = ab_msDateKey_(r[0]), checkKey = ab_msDateKey_(r[1]);
    if (!flagKey || !checkKey || (asOfKey && checkKey > asOfKey)) return;
    const oh = ab_toNum_(r[10]);
    if (isNaN(oh)) return;
    const cl = r[11] === '' ? NaN : ab_toNum_(r[11]);
    const cat = ab_btCatByLabel_(String(r[5] || '').trim());
    out.total++;
    if (!sinceKey || flagKey < sinceKey) sinceKey = flagKey;
    bump(out.byCat, cat ? cat.key : 'nodata', oh, cl);
    bump(out.byType, String(r[4] || '') || 'FVG', oh, cl);
  });
  out.since = sinceKey ? ab_msKeyToDmy_(sinceKey) : '';
  [out.byCat, out.byType].forEach(function (m) {
    Object.keys(m).forEach(function (k) {
      const s = m[k];
      s.avgOh = s.n ? s.sumOh / s.n : NaN;
      s.avgClose = s.nCl ? s.sumCl / s.nCl : NaN;
    });
  });
  return out;
}

/**
 * Menu: explains, for ONE symbol, what the FVG scans see - candle count,
 * liquidity filter, which zones were open on each of the last 3 days, what
 * is on the watch tabs now, and the Mitigated FVG Log entries. Answers
 * "why is this stock not in the list?" without anyone reading code.
 */
function runExplainFvgSymbol() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();
  try {
    const resp = ui.prompt('Why is this stock missing?', 'Type the symbol exactly as in Main (e.g. SHANTIGOLD):', ui.ButtonSet.OK_CANCEL);
    if (resp.getSelectedButton() !== ui.Button.OK) return;
    const sym = String(resp.getResponseText() || '').trim().toUpperCase();
    if (!sym) return;

    const dmy = function (d) {
      const j = ab_toJsDate_(d);
      return j ? Utilities.formatDate(j, AB_TZ, 'dd-MMM') : '?';
    };
    const zoneTxt = function (b, t) { return ab_num2_(b) + ' - ' + ab_num2_(t); };
    const by = ab_readHistoryCandles_();
    const c = by[sym];
    if (!c || !c.length) {
      ui.alert('Why is this stock missing?', sym + ' has no rows in History30 at all - so no FVG scan can see it.\n\n' +
        'Check the symbol spelling, that it is in Main, and run Sync Symbols + the daily fetch.', ui.ButtonSet.OK);
      return;
    }
    const L = [];
    L.push('CANDLES: ' + c.length + ' daily candles in History30 (latest ' + dmy(c[c.length - 1].date) + ').');
    if (c.length < 17) {
      L.push('-> The 3-candle "Unmitigated FVG" needs at least 17 candles. This stock has only ' + c.length +
             ', so it is NOT scanned for that type yet (Gap-up FVG still works).');
    }
    const turn = ab_avgTurnover_(c);
    if (isNaN(turn)) {
      L.push('LIQUIDITY: no usable volume data - the stock is let through (not filtered).');
    } else {
      L.push('LIQUIDITY: average daily turnover Rs ' + Math.round(turn).toLocaleString('en-IN') + ' vs the minimum Rs ' +
             AB_FVG_MIN_AVG_TURNOVER.toLocaleString('en-IN') + ' -> ' + (turn < AB_FVG_MIN_AVG_TURNOVER ? 'TOO ILLIQUID, skipped by both scans.' : 'passes.'));
    }
    const locked = c.filter(function (x) { return ab_isCircuitLocked_(x); }).length;
    if (locked) L.push('CIRCUIT-LOCKED days (ignored by the scans): ' + locked + ' of ' + c.length + '.');

    L.push('');
    L.push('ZONES THE SCAN WOULD HAVE SEEN (latest 3 days):');
    for (let back = 0; back < 3; back++) {
      const cs = c.slice(0, c.length - back);
      if (cs.length < 2) break;
      const gaps = ab_gapUpFvgs_(cs);
      const uz = cs.length >= 17 ? ab_unmitigatedFvg_(cs) : null;
      L.push(dmy(cs[cs.length - 1].date) + ':  Gap-up zone(s): ' +
             (gaps.length ? gaps.map(function (g) { return zoneTxt(g.bottom, g.top); }).join(' ; ') : 'none') +
             '   |   3-candle zone: ' + (uz ? zoneTxt(uz.bottom, uz.top) : 'none') +
             (gaps.length && uz ? '  (3-candle zone is skipped while a Gap-up zone is watched)' : ''));
    }

    L.push('');
    const tabRows = function (name, label) {
      const sh = ss.getSheetByName(name);
      const out = [];
      if (sh && sh.getLastRow() > 1) {
        sh.getDataRange().getValues().slice(1).forEach(function (r) {
          if (String(r[0] || '').trim().toUpperCase() === sym) out.push(zoneTxt(r[1], r[2]));
        });
      }
      L.push(label + ' tab now: ' + (out.length ? out.join(' ; ') : 'not listed'));
    };
    tabRows(AB_GAPUP_SHEET, 'Gap-up FVG');
    tabRows(AB_UNMIT_SHEET, 'Unmitigated FVG');

    const mlog = ss.getSheetByName(AB_MITIGATED_LOG_SHEET);
    const mrows = [];
    if (mlog && mlog.getLastRow() > 1) {
      mlog.getDataRange().getValues().slice(1).forEach(function (r) {
        if (String(r[3] || '').trim().toUpperCase() === sym) mrows.push(ab_msDateKey_(r[0]) ? ab_msKeyToDmy_(ab_msDateKey_(r[0])) + ' ' + r[2] + ' ' + zoneTxt(r[4], r[5]) + ' (' + r[7] + ')' : String(r[0]));
      });
    }
    L.push('Mitigated FVG Log: ' + (mrows.length ? mrows.slice(-5).join(' ; ') : 'no entry for this symbol'));

    const msg = L.join('\n');
    Logger.log(msg);
    ui.alert('FVG check - ' + sym, msg, ui.ButtonSet.OK);
  } catch (e) {
    ss.toast('FVG check failed: ' + e.message);
  }
}

/** Menu: record any outstanding next-day results now and say how much history there is. */
function runFvgBacktestNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const by = ab_readHistoryCandles_();
    const back = ab_msBackfillFromMitigatedLog_(by);
    const added = ab_btSync_(by);
    const st = ab_btStats_('');
    ss.toast(added + ' new next-day result(s) recorded (' + back + ' earlier flag(s) restored). ' + st.total +
             ' result(s) in total' + (st.since ? ', flags since ' + st.since : '') + '. See the "' + AB_BACKTEST_SHEET + '" tab.',
             'FVG Backtest', 15);
  } catch (e) {
    ss.toast('FVG Backtest failed: ' + e.message);
  }
}

/**
 * Menu: one-time clean-up. Removes "Spring Pattern" flags that were logged
 * on a day when no real Spring had formed (an EOD mail sent before that
 * day's fetch/pattern run logged the PREVIOUS day's Springs under the new
 * date). Each logged Spring is re-checked against the History30 candles of
 * its flag day; wrong ones are deleted from the Signal Watchlist Log and
 * the FVG Backtest tab. Flags whose day is older than History30 are kept.
 */
function runCleanStaleSpringFlags() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();
  try {
    const by = ab_readHistoryCandles_();
    const cfg = ab_springCfg_();
    const isWrong = function (dateKey, sym) {
      const c = by[sym];
      if (!dateKey || !c || c.length < 2) return false;
      for (let i = 0; i < c.length; i++) {
        if (ab_msDateKey_(c[i].date) === dateKey) {
          return i >= 1 ? !ab_isSpringPair_(c[i - 1], c[i], cfg) : false;
        }
      }
      return false; // flag day not in History30 - cannot judge, keep
    };
    const scan = function (sh, ncols, dateCol, symCol, srcCol) {
      const res = { sh: sh, ncols: ncols, keep: [], wrong: 0, total: 0 };
      if (!sh || sh.getLastRow() < 2) return res;
      sh.getRange(2, 1, sh.getLastRow() - 1, ncols).getValues().forEach(function (r) {
        res.total++;
        const src = String(r[srcCol] || '').trim();
        const sym = String(r[symCol] || '').trim().toUpperCase();
        if (src === 'Spring Pattern' && sym && isWrong(ab_msDateKey_(r[dateCol]), sym)) { res.wrong++; return; }
        res.keep.push(r);
      });
      return res;
    };
    const logRes = scan(ss.getSheetByName(AB_SIGNAL_WATCHLIST_SHEET), 5, 0, 1, 3);
    const btRes = scan(ss.getSheetByName(AB_BACKTEST_SHEET), AB_BT_HEADERS_.length, 0, 2, 3);
    if (!logRes.wrong && !btRes.wrong) {
      ui.alert('Clean Wrong Spring Flags', 'No wrong Spring flags found - nothing to remove.', ui.ButtonSet.OK);
      return;
    }
    const ok = ui.alert('Clean Wrong Spring Flags',
      logRes.wrong + ' wrong Spring flag(s) found in "' + AB_SIGNAL_WATCHLIST_SHEET + '" (of ' + logRes.total + ') and ' +
      btRes.wrong + ' in "' + AB_BACKTEST_SHEET + '".\n\nThese are Springs logged on a day when no Spring had formed. Remove them?',
      ui.ButtonSet.YES_NO);
    if (ok !== ui.Button.YES) return;
    [logRes, btRes].forEach(function (x) {
      if (!x.wrong) return;
      x.sh.getRange(2, 1, x.total, x.ncols).clearContent();
      if (x.keep.length) x.sh.getRange(2, 1, x.keep.length, x.ncols).setValues(x.keep);
    });
    ss.toast('Removed ' + logRes.wrong + ' wrong flag(s) from the log and ' + btRes.wrong + ' from the backtest.', 'Spring clean-up', 15);
  } catch (e) {
    ss.toast('Spring clean-up failed: ' + e.message);
  }
}

/** Menu: backfill + log the latest trading day's signals and report what moved >= the threshold the day after. */
function runMissedOpportunitiesCheckNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const layout = ab_getMainLayout_();
    const by = ab_readHistoryCandles_();
    const back = ab_msBackfillFromMitigatedLog_(by);
    const dayKey = ab_msLatestHistoryKey_(by);
    const hits = ab_checkMissedOpportunities_(layout, dayKey, by);

    let mitigatedToday = [], springs = [];
    try { mitigatedToday = ab_mitigatedToday_(ab_msKeyToDmy_(dayKey)); } catch (e) { Logger.log('mitigatedToday skipped: ' + e.message); }
    try { springs = ab_freshSprings_(ab_springPatternStocks_(), dayKey, by); } catch (e) { Logger.log('springs skipped: ' + e.message); }
    const logged = ab_logSignalWatchlist_(layout, mitigatedToday, springs, ab_msKeyToDmy_(dayKey), by);

    ss.toast(hits.length + ' missed opportunity(ies) on ' + ab_msKeyToDmy_(dayKey) + (hits.length ? ': ' + hits.map(function (h) { return h.symbol + ' ' + ab_pct2_(h.pct); }).join(', ') : '') +
             '. ' + back + ' earlier flag(s) restored, ' + logged + ' new flag(s) logged.', 'Missed Opportunities', 15);
  } catch (e) {
    ss.toast('Missed Opportunities check failed: ' + e.message);
  }
}

/**
 * Builds and sends the end-of-day catch-up mail.
 * `resolved` is resolveTradesEOD_'s return value.
 */
function sendEodSummaryEmail_(resolved, asOfDayStr) {
  let layout;
  try {
    layout = ab_getMainLayout_();
  } catch (e) {
    Logger.log('EOD summary skipped - ' + e.message);
    return false;
  }

  if (!asOfDayStr && Number(Utilities.formatDate(new Date(), AB_TZ, 'u')) >= 6) {
    Logger.log('EOD summary skipped - Saturday/Sunday, no trading session.');
    return false;
  }
  const dayStr = asOfDayStr || Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy');
  const triggered = ab_triggeredToday_(layout, dayStr);
  const open = ab_openTrades_(layout);
  const done = resolved || [];

  // Market-wide section - gainers/losers, Basic Industry leaders and
  // laggards, today's FVG mitigations, what's still approaching, and
  // today's Spring patterns. One combined email (not a second mail) so
  // this stays well clear of MailApp's daily send quota. Each piece is
  // gathered independently so one bad column or empty tab can't blank
  // out the whole digest - it just reports that one section as empty.
  let movers = { gainers: [], losers: [], topIndustries: [], bottomIndustries: [] };
  try {
    movers = ab_marketMoversSummary_();
  } catch (e) {
    Logger.log('EOD summary: market-movers section skipped - ' + e.message);
  }
  let gapApproaching = [], unmitApproaching = [], mitigatedToday = [], springs = [];
  try { gapApproaching = ab_listApproachingZones_(AB_GAPUP_SHEET); } catch (e) { Logger.log('EOD summary: gap-approaching skipped - ' + e.message); }
  try { unmitApproaching = ab_listApproachingZones_(AB_UNMIT_SHEET); } catch (e) { Logger.log('EOD summary: unmit-approaching skipped - ' + e.message); }
  try { mitigatedToday = ab_mitigatedToday_(dayStr); } catch (e) { Logger.log('EOD summary: mitigated-today skipped - ' + e.message); }
  let hist = null;
  try {
    springs = ab_springPatternStocks_();
    // Only Springs that really formed on THIS trading day (see ab_freshSprings_).
    hist = ab_readHistoryCandles_();
    const before = springs.length;
    springs = ab_freshSprings_(springs, ab_msDateKey_(dayStr), hist);
    if (before !== springs.length) Logger.log('EOD summary: ' + (before - springs.length) + ' Spring tag(s) ignored - not formed on ' + dayStr + ' (Pattern column not up to date for that day).');
  } catch (e) { springs = []; Logger.log('EOD summary: spring-pattern skipped - ' + e.message); }

  // Today's candle per symbol (for mitigation depth / close position and
  // the distance-to-zone figures) and each symbol's % Change from Main.
  let candles = {};
  try { candles = ab_getTodayCandleMap_(); } catch (e) { Logger.log('EOD summary: Today candles unavailable - ' + e.message); }
  const dayPct = {}, mainPrice = {};
  for (let r = layout.headerRowIdx + 1; r < layout.data.length; r++) {
    const sym = ab_cellText_(layout.data[r][layout.symbol]).toUpperCase();
    const nm = ab_cellText_(layout.data[r][layout.name]);
    if (!sym && !nm) break;
    if (!sym || dayPct[sym] !== undefined) continue;
    dayPct[sym] = layout.pctChange === -1 ? NaN : ab_toNum_(layout.data[r][layout.pctChange]);
    mainPrice[sym] = layout.mktPrice === -1 ? NaN : ab_toNum_(layout.data[r][layout.mktPrice]);
  }
  const closeOf = function (sym) {
    const c = candles[sym];
    return c && !isNaN(c.c) ? c.c : mainPrice[sym];
  };
  // How far today's close sits above a zone's top, in %.
  const gapToZone = function (z) {
    const c = closeOf(z.symbol), top = ab_toNum_(z.top);
    return (isNaN(c) || isNaN(top) || top <= 0) ? NaN : (c - top) / top * 100;
  };
  mitigatedToday.forEach(function (m) { m.cls = ab_classifyMitigation_(m, candles[m.symbol]); });
  const byDayPct = function (a, b) {
    const x = isNaN(dayPct[a.symbol]) ? -Infinity : dayPct[a.symbol], y = isNaN(dayPct[b.symbol]) ? -Infinity : dayPct[b.symbol];
    return y - x;
  };
  mitigatedToday.sort(byDayPct);
  unmitApproaching.sort(byDayPct);
  gapApproaching.sort(byDayPct);
  springs.sort(byDayPct);

  // Missed Opportunities - check PRIOR days' flagged symbols against
  // today's price first, then log TODAY's fresh signal-list symbols for
  // future runs to check (deliberately in that order, so a symbol
  // flagged for the first time today is never checked against itself
  // the same run it was logged).
  let missedOpportunities = [];
  let backtest = null;
  try {
    if (!hist) hist = ab_readHistoryCandles_();
    ab_msBackfillFromMitigatedLog_(hist);
    missedOpportunities = ab_checkMissedOpportunities_(layout, ab_msDateKey_(dayStr), hist);
    ab_logSignalWatchlist_(layout, mitigatedToday, springs, dayStr, hist);
    ab_btSync_(hist);
    backtest = ab_btStats_(ab_msDateKey_(dayStr));
  } catch (e) {
    Logger.log('EOD summary: missed-opportunities / backtest step skipped - ' + e.message);
  }

  const hasMarketData = movers.gainers.length || movers.losers.length || movers.topIndustries.length ||
    movers.bottomIndustries.length || gapApproaching.length || unmitApproaching.length ||
    mitigatedToday.length || springs.length || missedOpportunities.length;

  if (!triggered.length && !open.length && !done.length && !hasMarketData) {
    Logger.log('EOD summary: nothing triggered, no open trades, nothing resolved, no market data - no mail sent.');
    return false;
  }

  const KIND_LABEL = {
    'watch': 'Watch', 'alert-trade': 'Trade (alert)',
    'entry-trade': 'Trade (entry)', 'none': '-'
  };

  const th = 'style="text-align:left;padding:6px 10px;background:#f1f3f4;' +
             'border-bottom:2px solid #dadce0;font-size:12px;color:#5f6368"';
  const td = 'style="padding:6px 10px;border-bottom:1px solid #eee;font-size:13px"';

  function pctCell(pct) {
    const c = pct > 0 ? AB_C_POS : (pct < 0 ? AB_C_NEG : AB_C_MUTED);
    return '<span style="color:' + c + ';font-weight:bold">' + ab_pct2_(pct) + '</span>';
  }
  // Every symbol in this email links straight to its chart - inherits
  // the surrounding bold/color styling (no blue-underline default link
  // look) but keeps a dotted underline as the only hint it's clickable.
  function symLink(sym) {
    return '<a href="' + ab_chartUrl_(sym) + '" style="color:inherit;text-decoration:none;' +
           'border-bottom:1px dotted #999">' + sym + '</a>';
  }
  function section(title, rows, headerCells, rowFn, emptyMsg) {
    let out = '<h3 style="margin:22px 0 6px;font-size:15px">' + title + '</h3>';
    if (!rows.length) {
      out += '<p style="color:#5f6368;font-size:13px;margin:0">' + emptyMsg + '</p>';
      return out;
    }
    out += '<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%">' +
           '<tr>' + headerCells.map(function (h) { return '<th ' + th + '>' + h + '</th>'; }).join('') + '</tr>';
    rows.forEach(function (r) { out += rowFn(r); });
    out += '</table>';
    return out;
  }

  let html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:760px">';
  html += '<h2 style="margin:0 0 4px">EOD Summary - ' + dayStr + '</h2>';
  html += '<p style="margin:0 0 18px;color:#5f6368;font-size:13px">' +
          triggered.length + ' triggered today &middot; ' + open.length +
          ' open trade(s) &middot; ' + done.length + ' resolved today &middot; ' +
          movers.gainers.length + ' gainer(s) &gt;' + AB_EOD_GAINER_PCT_MIN + '% &middot; ' +
          mitigatedToday.length + ' FVG mitigated &middot; ' +
          (gapApproaching.length + unmitApproaching.length) + ' zone(s) approaching &middot; ' +
          springs.length + ' Spring pattern(s)</p>';

  // ---- 1. triggered today ----
  html += '<h3 style="margin:18px 0 6px;font-size:15px">Triggered today</h3>';
  if (!triggered.length) {
    html += '<p style="color:#5f6368;font-size:13px;margin:0">Nothing triggered today.</p>';
  } else {
    html += '<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%">' +
            '<tr><th ' + th + '>Symbol</th><th ' + th + '>Type</th><th ' + th + '>Price</th>' +
            '<th ' + th + '>Entry</th><th ' + th + '>Stop</th><th ' + th + '>% since</th></tr>';
    triggered.forEach(function (t) {
      const aCol = isNaN(t.pctAfter) ? AB_C_MUTED
                 : (t.pctAfter > 0 ? AB_C_POS : (t.pctAfter < 0 ? AB_C_NEG : AB_C_MUTED));
      html += '<tr><td ' + td + '><b>' + symLink(t.symbol) + '</b><br>' +
              '<span style="color:#5f6368;font-size:11px">' + t.name + '</span></td>' +
              '<td ' + td + '>' + (KIND_LABEL[t.kind] || t.kind) + '</td>' +
              '<td ' + td + '>' + ab_num2_(t.price) + '</td>' +
              '<td ' + td + '><span style="color:' + AB_C_POS + ';font-weight:bold">' +
              ab_num2_(t.entry) + '</span></td>' +
              '<td ' + td + '><span style="color:' + AB_C_NEG + ';font-weight:bold">' +
              ab_num2_(t.stop) + '</span></td>' +
              '<td ' + td + '><span style="color:' + aCol + ';font-weight:bold">' +
              ab_pct2_(t.pctAfter) + '</span></td></tr>';
    });
    html += '</table>';
  }

  // ---- 2. open trades ----
  html += '<h3 style="margin:22px 0 6px;font-size:15px">Open trades</h3>';
  if (!open.length) {
    html += '<p style="color:#5f6368;font-size:13px;margin:0">No open trades.</p>';
  } else {
    html += '<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%">' +
            '<tr><th ' + th + '>Symbol</th><th ' + th + '>Entry</th><th ' + th + '>Now</th>' +
            '<th ' + th + '>% from entry</th><th ' + th + '>Stop</th>' +
            '<th ' + th + '>Above stop</th><th ' + th + '>Target (+' + AB_TRADE_WIN_PCT + '%)</th></tr>';
    open.forEach(function (t) {
      const colour = isNaN(t.pctFromEntry) ? AB_C_MUTED
                   : (t.pctFromEntry > 0 ? AB_C_POS : (t.pctFromEntry < 0 ? AB_C_NEG : AB_C_MUTED));
      // How much room is left above the stop. Tight = amber, very tight
      // = red, so a trade about to be stopped out is obvious.
      const room = t.pctToStop;
      const roomCol = isNaN(room) ? AB_C_MUTED
                    : (room <= 1 ? AB_C_NEG : (room <= 3 ? AB_C_WARN : AB_C_POS));
      html += '<tr><td ' + td + '><b>' + symLink(t.symbol) + '</b><br>' +
              '<span style="color:#5f6368;font-size:11px">' + t.name + '</span></td>' +
              '<td ' + td + '><span style="color:' + AB_C_POS + ';font-weight:bold">' +
              ab_num2_(t.entry) + '</span></td>' +
              '<td ' + td + '>' + ab_num2_(t.price) + '</td>' +
              '<td ' + td + ' ><span style="color:' + colour + ';font-weight:bold">' +
              ab_pct2_(t.pctFromEntry) + '</span></td>' +
              '<td ' + td + '><span style="color:' + AB_C_NEG + ';font-weight:bold">' +
              ab_num2_(t.stop) + '</span></td>' +
              '<td ' + td + '><span style="color:' + roomCol + ';font-weight:bold">' +
              ab_pct2_(room) + '</span></td>' +
              '<td ' + td + '><span style="color:' + AB_C_POS + '">' + ab_num2_(t.target) + '</span></td></tr>';
    });
    html += '</table>';
  }

  // ---- 3. resolved today ----
  html += '<h3 style="margin:22px 0 6px;font-size:15px">Resolved today</h3>';
  if (!done.length) {
    html += '<p style="color:#5f6368;font-size:13px;margin:0">Nothing resolved today.</p>';
  } else {
    html += '<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%">' +
            '<tr><th ' + th + '>Symbol</th><th ' + th + '>Outcome</th>' +
            '<th ' + th + '>Exit</th><th ' + th + '>% from entry</th></tr>';
    done.forEach(function (t) {
      const oCol = ab_fieldColour_('Outcome', t.outcome);
      const pCol = isNaN(t.pctFromEntry) ? AB_C_MUTED
                 : (t.pctFromEntry > 0 ? AB_C_POS : (t.pctFromEntry < 0 ? AB_C_NEG : AB_C_MUTED));
      html += '<tr><td ' + td + '><b>' + symLink(t.symbol) + '</b><br>' +
              '<span style="color:#5f6368;font-size:11px">' + t.name + '</span></td>' +
              '<td ' + td + '><span style="color:' + oCol + ';font-weight:bold">' +
              t.outcome + '</span></td>' +
              '<td ' + td + '>' + ab_num2_(t.price) + '</td>' +
              '<td ' + td + '><span style="color:' + pCol + ';font-weight:bold">' +
              ab_pct2_(t.pctFromEntry) + '</span></td></tr>';
    });
    html += '</table>';
  }

  html += '<p style="margin:22px 0 0;color:#5f6368;font-size:11px">' +
          'A trade is graded Win at +' + AB_TRADE_WIN_PCT +
          '% from your entry, Loss when price closes at or below your stoploss. ' +
          'Watch rows are never graded.</p>';

  // ---- 4-11. market-wide section ----
  html += section('Top Gainers (> +' + AB_EOD_GAINER_PCT_MIN + '%)', movers.gainers,
    ['Symbol', 'Name', '% Change'],
    function (s) {
      return '<tr><td ' + td + '><b>' + symLink(s.symbol) + '</b></td><td ' + td + '>' + s.name + '</td>' +
             '<td ' + td + '>' + pctCell(s.pct) + '</td></tr>';
    }, 'None today.');

  html += section('Top ' + AB_EOD_LOSER_COUNT + ' Losers', movers.losers,
    ['Symbol', 'Name', '% Change'],
    function (s) {
      return '<tr><td ' + td + '><b>' + symLink(s.symbol) + '</b></td><td ' + td + '>' + s.name + '</td>' +
             '<td ' + td + '>' + pctCell(s.pct) + '</td></tr>';
    }, 'No data.');

  html += section('Top ' + AB_EOD_INDUSTRY_TOP_N + ' Basic Industries (gains)', movers.topIndustries,
    ['Basic Industry', 'Avg % Change', 'Stocks'],
    function (g) {
      return '<tr><td ' + td + '>' + g.name + '</td><td ' + td + '>' + pctCell(g.avgPct) +
             '</td><td ' + td + '>' + g.count + '</td></tr>';
    }, 'Not enough data.');

  html += section('Bottom ' + AB_EOD_INDUSTRY_TOP_N + ' Basic Industries (losses)', movers.bottomIndustries,
    ['Basic Industry', 'Avg % Change', 'Stocks'],
    function (g) {
      return '<tr><td ' + td + '>' + g.name + '</td><td ' + td + '>' + pctCell(g.avgPct) +
             '</td><td ' + td + '>' + g.count + '</td></tr>';
    }, 'Not enough data.');

  // ---- Mitigated FVG Today, grouped by how the zone held ----
  html += (function () {
    const total = mitigatedToday.length;
    let out = '<h3 style="margin:22px 0 6px;font-size:15px">Mitigated FVG Today (' + total + ')</h3>';
    if (!total) return out + '<p style="color:#5f6368;font-size:13px;margin:0">None today.</p>';

    const groups = {};
    AB_MIT_CATS_.forEach(function (c) { groups[c.key] = []; });
    mitigatedToday.forEach(function (m) { groups[(m.cls && m.cls.cat) || 'nodata'].push(m); });
    const dp = function (m) { const v = dayPct[m.symbol]; return isNaN(v) ? -Infinity : v; };
    Object.keys(groups).forEach(function (k) { groups[k].sort(function (a, b) { return dp(b) - dp(a); }); });

    // One-line breakdown, colour-coded like the groups below.
    out += '<p style="margin:0 0 8px;font-size:13px">' + AB_MIT_CATS_.filter(function (c) { return groups[c.key].length; })
      .map(function (c) {
        return '<span style="color:' + c.colour + ';font-weight:700">' + groups[c.key].length + '</span> ' +
               c.label.split(' - ')[0].toLowerCase();
      }).join(' &middot; ') + '</p>';

    const depthCell = function (k) {
      if (k.cat === 'openin') {
        return '<span style="font-size:12px"><b style="color:#1a56c4">Open ' + ab_num2_(k.open) + '</b> (' + Math.round(k.openFill) +
               '% into zone)</span><div style="font-size:11px;color:#5f6368">candle ' +
               (k.greenPct >= 0 ? '+' : '') + ab_num2_(k.greenPct) + '% green</div>';
      }
      if (isNaN(k.depth)) return '-';
      const w = Math.min(100, Math.round(k.depth));
      const colour = k.depth > 100 ? '#0b7a75' : k.depth >= 50 ? '#b8860b' : '#0a8f4f';
      const bar = '<div style="width:70px;height:6px;background:#e6e6e6;border-radius:3px;margin-top:3px">' +
                  '<div style="width:' + w + '%;height:6px;background:' + colour + ';border-radius:3px"></div></div>';
      const txt = k.depth > 100
        ? 'through, ' + ab_num2_(k.sweptPct) + '% under'
        : Math.round(k.depth) + '% deep' + (k.depth >= 50 ? '' : ' (shallow)');
      return '<span style="font-size:12px">' + txt + '</span>' + bar;
    };
    const closeCell = function (k) {
      if (k.closeKind === 'above') return '<span style="color:#0a8f4f;font-weight:700">+' + ab_num2_(k.closePct) + '%</span> above top';
      if (k.closeKind === 'inside') return '<span style="color:#b8860b;font-weight:700">' + Math.round(k.closeFill) + '%</span> into zone';
      if (k.closeKind === 'below') return '<span style="color:#d64545;font-weight:700">' + ab_num2_(k.closePct) + '%</span> under bottom';
      return '-';
    };

    out += '<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%"><tr>' +
      ['Symbol', 'Type', 'Zone %', 'Low Reached / Open', 'Close vs Zone', '% Change'].map(function (h) {
        return '<th ' + th + '>' + h + '</th>';
      }).join('') + '</tr>';
    AB_MIT_CATS_.forEach(function (c) {
      const g = groups[c.key];
      if (!g.length) return;
      out += '<tr><td colspan="6" style="padding:8px 10px 6px;background:' + c.bg + ';border-left:4px solid ' + c.colour +
             ';font-size:13px"><b style="color:' + c.colour + '">' + c.label + ' (' + g.length + ')</b>' +
             '<div style="color:#5f6368;font-size:11px;margin-top:2px">' + c.note + '</div></td></tr>';
      g.forEach(function (m) {
        const k = m.cls || {};
        out += '<tr><td ' + td + '><b>' + symLink(m.symbol) + '</b></td>' +
               '<td ' + td + '><span style="font-size:12px;color:#5f6368">' + (/gap/i.test(m.type) ? 'Gap-up FVG' : 'FVG') + '</span></td>' +
               '<td ' + td + '>' + ab_num2_(ab_toNum_(m.pct)) + '%</td>' +
               '<td ' + td + '>' + depthCell(k) + '</td>' +
               '<td ' + td + '><span style="font-size:12px">' + closeCell(k) + '</span></td>' +
               '<td ' + td + '>' + pctCell(dayPct[m.symbol]) + '</td></tr>';
      });
    });
    out += '</table><p style="margin:6px 0 0;color:#5f6368;font-size:11px">Low Reached = how far the day\'s low got into ' +
           'the zone from its top (100% = filled to the bottom). Open = where the day opened (for "opened inside the zone" stocks). ' +
           'Close vs Zone = where the day closed relative to the zone.</p>';
    return out;
  })();

  html += section('Unmitigated FVG Approaching (' + unmitApproaching.length + ')', unmitApproaching,
    ['Symbol', 'Zone %', 'Gap to Zone %', '% Change'],
    function (z) {
      const g = gapToZone(z);
      return '<tr><td ' + td + '><b>' + symLink(z.symbol) + '</b></td><td ' + td + '>' + ab_num2_(z.pct) + '%</td>' +
             '<td ' + td + '>' + (isNaN(g) ? '-' : ab_num2_(g) + '%') + '</td><td ' + td + '>' + pctCell(dayPct[z.symbol]) + '</td></tr>';
    }, 'None right now.');

  html += section('Gap-up FVG Approaching (' + gapApproaching.length + ')', gapApproaching,
    ['Symbol', 'Zone %', 'Gap to Zone %', '% Change'],
    function (z) {
      const g = gapToZone(z);
      return '<tr><td ' + td + '><b>' + symLink(z.symbol) + '</b></td><td ' + td + '>' + ab_num2_(z.pct) + '%</td>' +
             '<td ' + td + '>' + (isNaN(g) ? '-' : ab_num2_(g) + '%') + '</td><td ' + td + '>' + pctCell(dayPct[z.symbol]) + '</td></tr>';
    }, 'None right now.');
  if (unmitApproaching.length || gapApproaching.length) {
    html += '<p style="margin:6px 0 0;color:#5f6368;font-size:11px">Zone % = height of the zone (for a Gap-up FVG, the size of ' +
            'the gap). Gap to Zone % = how far today\'s close is above the zone top.</p>';
  }

  html += section('Spring Pattern Today (' + springs.length + ')', springs,
    ['Symbol', 'Company', '% Change'],
    function (s) {
      return '<tr><td ' + td + '><b>' + symLink(s.symbol) + '</b></td><td ' + td + '>' + s.company + '</td>' +
             '<td ' + td + '>' + pctCell(dayPct[s.symbol]) + '</td></tr>';
    }, 'None today.');

  // ---- Missed Opportunities, grouped by how the zone behaved on the flag day ----
  html += (function () {
    const n = missedOpportunities.length;
    let out = '<h3 style="margin:22px 0 6px;font-size:15px">Missed Opportunities (>' + AB_MISSED_PCT +
              '% open-to-high the day after flagged) (' + n + ')</h3>';
    if (!n) {
      const mt = missedOpportunities.meta;
      return out + '<p style="color:#5f6368;font-size:13px;margin:0">Nothing from a prior signal moved that much' +
        (!mt || !mt.checked ? ' (no earlier flags fall on this day).'
          : ' - checked ' + mt.checked + ' symbols flagged ' + mt.flaggedOn + '; biggest open-to-high ' +
            (mt.biggest ? mt.biggest.symbol + ' ' + ab_pct2_(mt.biggest.pct) : 'n/a') + '.') + '</p>';
    }
    out += '<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%"><tr>' +
      ['Symbol', 'Name', 'Type', 'Open to High', 'Close vs Open', 'Flagged On'].map(function (h) { return '<th ' + th + '>' + h + '</th>'; }).join('') + '</tr>';
    ab_btCats_().forEach(function (cat) {
      const g = missedOpportunities.filter(function (m) { return (m.cat || 'nodata') === cat.key; });
      if (!g.length) return;
      out += '<tr><td colspan="6" style="padding:8px 10px 6px;background:' + cat.bg + ';border-left:4px solid ' + cat.colour +
             ';font-size:13px"><b style="color:' + cat.colour + '">' + cat.label + ' (' + g.length + ')</b></td></tr>';
      g.forEach(function (m) {
        out += '<tr><td ' + td + '><b>' + symLink(m.symbol) + '</b></td><td ' + td + '>' + m.name + '</td>' +
               '<td ' + td + '><span style="font-size:12px;color:#5f6368">' + (m.type || '') + '</span></td>' +
               '<td ' + td + '>' + pctCell(m.pct) + '</td><td ' + td + '>' + pctCell(m.closePct) + '</td>' +
               '<td ' + td + '>' + m.dateFlagged + '</td></tr>';
      });
    });
    return out + '</table>';
  })();

  // ---- Backtest: running next-day record per flag category ----
  html += (function () {
    let out = '<h3 style="margin:22px 0 6px;font-size:15px">FVG Backtest - what happened the next day' +
              (backtest && backtest.since ? ' (flags since ' + backtest.since + ', ' + backtest.total + ' in all)' : '') + '</h3>';
    if (!backtest || !backtest.total) return out + '<p style="color:#5f6368;font-size:13px;margin:0">No next-day results recorded yet.</p>';
    const rate = function (k, n) { return n ? Math.round(k / n * 100) : 0; };
    const rateColour = function (r) { return r >= 50 ? AB_C_POS : r >= 30 ? '#b8860b' : AB_C_NEG; };
    const cell = function (k, n) {
      const r = rate(k, n);
      return '<b style="color:' + rateColour(r) + '">' + r + '%</b> <span style="font-size:11px;color:#5f6368">(' + k + ' of ' + n + ')</span>';
    };
    const row = function (label, s, bold, colour) {
      return '<tr><td ' + td + '>' + (bold ? '<b>' : '') + '<span style="color:' + (colour || '#202124') + '">' + label + '</span>' + (bold ? '</b>' : '') + '</td>' +
             '<td ' + td + '>' + s.n + '</td><td ' + td + '>' + cell(s.hit, s.n) + '</td><td ' + td + '>' + cell(s.green, s.nCl) + '</td>' +
             '<td ' + td + '>' + pctCell(s.avgOh) + '</td></tr>';
    };
    out += '<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%"><tr>' +
      ['Flagged as', 'Flags', 'Next day: open-to-high >=' + AB_MISSED_PCT + '%', 'Next day: closed green', 'Avg open-to-high'].map(function (h) { return '<th ' + th + '>' + h + '</th>'; }).join('') + '</tr>';
    const all = { n: 0, hit: 0, green: 0, nCl: 0, sumOh: 0 };
    ab_btCats_().forEach(function (cat) {
      const s = backtest.byCat[cat.key];
      if (!s) return;
      out += row(cat.label, s, false, cat.colour);
      if (cat.key !== 'spring') { all.n += s.n; all.hit += s.hit; all.green += s.green; all.nCl += s.nCl; all.sumOh += s.sumOh; }
    });
    if (all.n) { all.avgOh = all.sumOh / all.n; out += row('All Mitigated FVG', all, true); }
    const types = Object.keys(backtest.byType).filter(function (t) { return t !== 'Spring'; });
    if (types.length > 1) {
      out += '<tr><td colspan="5" style="padding:8px 10px 4px;background:#f1f3f4;font-size:12px;color:#5f6368"><b>By zone type</b></td></tr>';
      types.sort().forEach(function (t) { out += row(t, backtest.byType[t], false); });
    }
    return out + '</table><p style="margin:6px 0 0;color:#5f6368;font-size:11px">Each flagged symbol is judged once, on the next trading day (History30). ' +
      'Small counts are only a hint - the picture firms up as days add up. Full list: the "' + AB_BACKTEST_SHEET + '" tab.</p>';
  })();

  html += '<p style="margin:22px 0 0;color:#5f6368;font-size:11px">' +
          '"Approaching" = flagged within the live near-threshold at some point today and still ' +
          'unmitigated. "Spring" excludes the separate, looser "Spring?" tag. "Missed Opportunities" ' +
          'looks at each Mitigated FVG / Spring Pattern symbol on the first trading day after it was flagged ' +
          '(History30 open and high; weekends and holidays skipped).</p></div>';

  // Plain-text fallback. Every symbol line is followed by its own
  // indented "Chart:" line, same convention the other alert emails use.
  function chartLine(sym) { return '    Chart: ' + ab_chartUrl_(sym) + '\n'; }

  let text = 'EOD Summary - ' + dayStr + '\n\n';
  text += 'TRIGGERED TODAY (' + triggered.length + ')\n';
  triggered.forEach(function (t) {
    text += '  ' + t.symbol + ' [' + (KIND_LABEL[t.kind] || t.kind) + '] price ' +
            ab_num2_(t.price) + ', entry ' + ab_num2_(t.entry) + ', stop ' + ab_num2_(t.stop) + '\n' +
            chartLine(t.symbol);
  });
  text += '\nOPEN TRADES (' + open.length + ')\n';
  open.forEach(function (t) {
    text += '  ' + t.symbol + ' entry ' + ab_num2_(t.entry) + ' now ' + ab_num2_(t.price) +
            ' (' + ab_pct2_(t.pctFromEntry) + '), stop ' + ab_num2_(t.stop) +
            ' (' + ab_pct2_(t.pctToStop) + ' above)\n' + chartLine(t.symbol);
  });
  text += '\nRESOLVED TODAY (' + done.length + ')\n';
  done.forEach(function (t) {
    text += '  ' + t.symbol + ' ' + t.outcome + ' at ' + ab_num2_(t.price) +
            ' (' + ab_pct2_(t.pctFromEntry) + ' from entry)\n' + chartLine(t.symbol);
  });
  text += '\nTOP GAINERS (>' + AB_EOD_GAINER_PCT_MIN + '%): ' + movers.gainers.length + '\n';
  movers.gainers.forEach(function (s) { text += '  ' + s.symbol + ' ' + ab_pct2_(s.pct) + '\n' + chartLine(s.symbol); });
  text += '\nTOP ' + AB_EOD_LOSER_COUNT + ' LOSERS\n';
  movers.losers.forEach(function (s) { text += '  ' + s.symbol + ' ' + ab_pct2_(s.pct) + '\n' + chartLine(s.symbol); });
  text += '\nTOP BASIC INDUSTRIES (GAINS)\n';
  movers.topIndustries.forEach(function (g) { text += '  ' + g.name + ' ' + ab_pct2_(g.avgPct) + ' (' + g.count + ' stocks)\n'; });
  text += '\nBOTTOM BASIC INDUSTRIES (LOSSES)\n';
  movers.bottomIndustries.forEach(function (g) { text += '  ' + g.name + ' ' + ab_pct2_(g.avgPct) + ' (' + g.count + ' stocks)\n'; });
  text += '\nMITIGATED FVG TODAY (' + mitigatedToday.length + ')\n';
  AB_MIT_CATS_.forEach(function (c) {
    const g = mitigatedToday.filter(function (m) { return ((m.cls && m.cls.cat) || 'nodata') === c.key; });
    if (!g.length) return;
    text += '  -- ' + c.label + ' (' + g.length + ')\n';
    g.forEach(function (m) {
      const k = m.cls || {};
      const depth0 = k.cat === 'openin' ? 'opened ' + ab_num2_(k.open) + ' (' + Math.round(k.openFill) + '% into zone), low ' : '';
      const depth = depth0 + (isNaN(k.depth) ? '-' : (k.depth > 100 ? 'through (' + ab_num2_(k.sweptPct) + '% under)' : Math.round(k.depth) + '% deep'));
      const close = k.closeKind === 'above' ? '+' + ab_num2_(k.closePct) + '% above top'
                  : k.closeKind === 'inside' ? Math.round(k.closeFill) + '% into zone'
                  : k.closeKind === 'below' ? ab_num2_(k.closePct) + '% under bottom' : '-';
      text += '    ' + m.symbol + ' [' + (/gap/i.test(m.type) ? 'Gap-up FVG' : 'FVG') + '] zone ' + ab_num2_(ab_toNum_(m.pct)) +
              '%, ' + (k.cat === 'openin' ? '' : 'low ') + depth + ', close ' + close + ', day ' + ab_pct2_(dayPct[m.symbol]) + '\n' + chartLine(m.symbol);
    });
  });
  text += '\nUNMITIGATED FVG APPROACHING (' + unmitApproaching.length + ')\n';
  unmitApproaching.forEach(function (z) {
    text += '  ' + z.symbol + ' zone ' + ab_num2_(z.pct) + '%, gap to zone ' + ab_num2_(gapToZone(z)) + '%, day ' +
            ab_pct2_(dayPct[z.symbol]) + '\n' + chartLine(z.symbol);
  });
  text += '\nGAP-UP FVG APPROACHING (' + gapApproaching.length + ')\n';
  gapApproaching.forEach(function (z) {
    text += '  ' + z.symbol + ' zone ' + ab_num2_(z.pct) + '%, gap to zone ' + ab_num2_(gapToZone(z)) + '%, day ' +
            ab_pct2_(dayPct[z.symbol]) + '\n' + chartLine(z.symbol);
  });
  text += '\nSPRING PATTERN TODAY (' + springs.length + ')\n';
  springs.forEach(function (s) { text += '  ' + s.symbol + ' (' + s.company + '), day ' + ab_pct2_(dayPct[s.symbol]) + '\n' + chartLine(s.symbol); });
  text += '\nMISSED OPPORTUNITIES (>' + AB_MISSED_PCT + '% open-to-high): ' + missedOpportunities.length + '\n';
  if (!missedOpportunities.length && missedOpportunities.meta && missedOpportunities.meta.checked) {
    text += '  (checked ' + missedOpportunities.meta.checked + ' symbols flagged ' + missedOpportunities.meta.flaggedOn + '; biggest open-to-high ' +
            (missedOpportunities.meta.biggest ? missedOpportunities.meta.biggest.symbol + ' ' + ab_pct2_(missedOpportunities.meta.biggest.pct) : 'n/a') + ')\n';
  }
  missedOpportunities.forEach(function (m) {
    text += '  ' + m.symbol + ' [' + ab_btCatByKey_(m.cat || 'nodata').label + ', ' + (m.type || '') + '] flagged ' + m.dateFlagged +
            ': open-to-high ' + ab_pct2_(m.pct) + ', close ' + ab_pct2_(m.closePct) + ' vs open\n' + chartLine(m.symbol);
  });
  if (backtest && backtest.total) {
    text += '\nFVG BACKTEST - next day (flags since ' + backtest.since + ', ' + backtest.total + ' in all)\n';
    ab_btCats_().forEach(function (cat) {
      const s = backtest.byCat[cat.key];
      if (!s) return;
      text += '  ' + cat.label + ': ' + s.n + ' flags, ' + s.hit + ' (' + Math.round(s.hit / s.n * 100) + '%) open-to-high >=' + AB_MISSED_PCT +
              '%, ' + s.green + ' of ' + s.nCl + ' closed green, avg ' + ab_pct2_(s.avgOh) + '\n';
    });
    text += '\n';
  }

  const subject = 'EOD Summary ' + dayStr + ' - ' + triggered.length + ' triggered, ' +
                  open.length + ' open, ' + done.length + ' resolved, ' +
                  movers.gainers.length + ' gainers, ' + mitigatedToday.length + ' mitigated, ' +
                  missedOpportunities.length + ' missed';

  let sent = false;
  try {
    ab_sendMail_({ to: AB_EMAIL_TO, subject: subject, body: text, htmlBody: html });
    Logger.log('EOD summary emailed: ' + triggered.length + ' triggered, ' + open.length +
               ' open, ' + done.length + ' resolved, ' + movers.gainers.length + ' gainers, ' +
               mitigatedToday.length + ' mitigated.');
    sent = true;
  } catch (e) {
    Logger.log('EOD summary email failed: ' + e.message);
  }

  // Same summary to the phone. Independent of the email above - if one
  // channel fails the other should still get through.
  try {
    ab_sendPushbullet_(subject, text);
  } catch (pe) {
    Logger.log('EOD summary push failed: ' + pe.message);
  }

  return sent;
}

/** Menu: send the EOD summary right now, without waiting for 6pm. */
function sendEodSummaryNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sent = sendEodSummaryEmail_([]);
  ss.toast(sent ? 'EOD summary emailed to ' + AB_EMAIL_TO
                : 'Nothing to report - no mail sent.');
}

/**
 * Menu: re-send the EOD Summary for the LAST TRADING DAY in History30
 * (e.g. on a weekend, Friday's). Uses whatever the sheet holds right
 * now - it stays accurate until the next daily run replaces the Today /
 * History30 data. Trades resolved that day are not repeated.
 */
function runResendEodSummaryForLastDay() {
  const ui = SpreadsheetApp.getUi();
  try {
    const by = ab_readHistoryCandles_();
    const key = ab_msLatestHistoryKey_(by);
    if (!key) { ui.alert('History30 has no data yet.'); return; }
    const dmy = ab_msKeyToDmy_(key);
    const ok = ui.alert('Re-send EOD Summary', 'Send the EOD Summary for ' + dmy + ' again (with the corrected Missed Opportunities)?\n\n' +
      'It uses the data currently in the sheet.', ui.ButtonSet.YES_NO);
    if (ok !== ui.Button.YES) return;
    const sent = sendEodSummaryEmail_([], dmy);
    SpreadsheetApp.getActiveSpreadsheet().toast(sent ? 'EOD summary for ' + dmy + ' emailed to ' + AB_EMAIL_TO
                                                     : 'Nothing sent (emails paused, or nothing to report).');
  } catch (e) {
    ui.alert('Re-send failed: ' + e.message);
  }
}

/*****************************************************************
 * QUALITY WATCH EMAIL
 * -----------------------------------------------------------------
 * A separate, standing screen for "quality" stocks - fundamentally
 * improving AND currently flagged Buy - cross-referenced against
 * their live technicals, sent as its own email right after the EOD
 * summary. Criteria (all must hold; tightened from the first version,
 * which let through too much on Stagnant alone):
 *
 *   1. OPM QoQ% is exactly "Increasing", "Aggressive Increase" or
 *      "Slightly Increasing".
 *   2. OPM YoY% - same three values.
 *   3. TTM Signal = "Buy".
 *   4. Last FY EPS has a real value - not blank.
 *   5. TTM EPS is not negative.
 *
 * On (4): Main computes TTM Signal / Upside Potential / TargetPrice
 * from TargetPrice = TTM EPS x (industry) PE and Upside = (TargetPrice
 * - MKT Price) / MKT Price - neither formula touches Last FY EPS at
 * all. So a symbol can show "Buy" with a perfectly good TargetPrice
 * even while Last FY EPS is blank (recently listed, or quarterly
 * backfill hasn't reached it yet) - but TTM EPS Growth, which DOES
 * use Last FY EPS, is then silently meaningless for that symbol rather
 * than erroring. A "quality" screen that can't verify EPS actually grew
 * isn't one, so those rows are left out here even though Buy still shows.
 *
 * On (5): TTM EPS Growth = (TTM EPS - Last FY EPS) / ABS(TTM EPS) - with
 * a negative TTM EPS the ABS() in the denominator flips what the sign
 * of that result actually means (a swing from a bigger loss to a
 * smaller one can come out looking like "growth"), so a negative TTM
 * EPS is excluded outright rather than trusting that number either.
 *
 * Deliberately reads the TTM-based valuation chain (TTM EPS Growth /
 * TTM PEG Ratio / TargetPrice / TTM Signal / Upside Potential), not the
 * separate non-TTM EPS/EPS Growth%/PEG Ratio/Target Price/Signal chain
 * sitting right next to it under the same "Valuation" category in
 * Main - the two are independent calculations and TTM Signal only
 * lines up with the first.
 *****************************************************************/
const AB_QUALITY_REQUIRED_COLS_ = {
  ttmSignal: 'TTM Signal', lastFyEps: 'Last FY EPS', ttmEps: 'TTM EPS',
  opmQoQ: 'OPM QoQ% (or equivalent)', opmYoY: 'OPM YoY% (or equivalent)'
};

// Only these exact OPM trend tags qualify now - Stagnant and "Slightly
// Decreasing"/"Decreasing"/"Aggressive Decrease" still don't pass (see
// the block comment above).
const AB_QUALITY_OPM_OK_ = ['increasing', 'aggressive increase', 'slightly increasing'];

/** Does this OPM trend tag count as genuinely improving? */
function ab_opmTrendOk_(tag) {
  const v = String(tag || '').trim().toLowerCase();
  return AB_QUALITY_OPM_OK_.indexOf(v) !== -1;
}

/**
 * Scans Main for symbols passing every Quality Watch criterion above.
 * Returns { layout, matches: [{ sheetRow, symbol }] } - cheap, since it
 * only reads the few columns the filter needs from the data layout
 * ab_getMainLayout_ already loaded; full per-symbol detail is fetched
 * separately (ab_qualityWatchDetails_), only for rows that actually match.
 */
function ab_qualityWatchSymbols_() {
  const layout = ab_getMainLayout_();
  const missing = Object.keys(AB_QUALITY_REQUIRED_COLS_).filter(k => layout[k] === -1);
  if (missing.length) {
    throw new Error('Main is missing column(s) needed for the Quality Watch filter: ' +
      missing.map(k => AB_QUALITY_REQUIRED_COLS_[k]).join(', '));
  }

  const data = layout.data;
  const matches = [];
  for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
    const sym = String(data[r][layout.symbol] || '').trim();
    const name = layout.name !== -1 ? String(data[r][layout.name] || '').trim() : '';
    if (!sym && !name) break;
    if (!sym) continue;

    if (String(data[r][layout.ttmSignal] || '').trim().toUpperCase() !== 'BUY') continue;

    const lastFyEps = ab_toNum_(data[r][layout.lastFyEps]);
    if (isNaN(lastFyEps)) continue; // blank/#N/A - can't verify EPS growth, see the block comment above

    const ttmEps = ab_toNum_(data[r][layout.ttmEps]);
    if (isNaN(ttmEps) || ttmEps < 0) continue; // negative TTM EPS - see point 5 above

    const qoq = String(data[r][layout.opmQoQ] || '').trim();
    const yoy = String(data[r][layout.opmYoY] || '').trim();
    if (!ab_opmTrendOk_(qoq) || !ab_opmTrendOk_(yoy)) continue;

    matches.push({ sheetRow: r + 1, symbol: sym });
  }
  return { layout: layout, matches: matches };
}

/**
 * Full display-formatted field set for one matched row, in exactly the
 * order the email presents them. Reads the WHOLE sheet's display
 * values in one batched call (cached on `cache`, passed in by the
 * caller) rather than one getDisplayValues() call per symbol.
 */
function ab_qualityWatchDetails_(layout, sheetRow, displayRows) {
  const row = displayRows[sheetRow - 1]; // displayRows is 0-indexed from row 1
  function v(idx) { return idx !== -1 ? String(row[idx] || '').trim() : ''; }
  return {
    symbol: v(layout.symbol),
    name: v(layout.name),
    basicIndustry: v(layout.basicIndustry),
    pctChange: v(layout.pctChange),
    tenDayPct: v(layout.tenDayPct),
    thirtyDayPct: v(layout.thirtyDayPct),
    resultDate: v(layout.resultDate),
    qoqRev: v(layout.qoqRev), qoqNp: v(layout.qoqNp),
    yoyRev: v(layout.yoyRev), yoyNp: v(layout.yoyNp),
    peVsIndustryPe: v(layout.peVsIndustryPe),
    epsGrowth: v(layout.ttmEpsGrowth),
    pegRatio: v(layout.ttmPegRatio),
    upside: v(layout.upsidePotential),
    targetPrice: v(layout.targetPrice),
    promotorHolding: v(layout.promotorHolding),
    fiiActivity: v(layout.fiiActivity),
    opmYoY: v(layout.opmYoY),
    opmQoQ: v(layout.opmQoQ),
    pattern: v(layout.pattern),
    fvg: v(layout.fvg),
    ema10: v(layout.emaSupport10),
    ema21: v(layout.emaSupport21),
    volChangePct: v(layout.volChangePct),
    chartUrl: ab_chartUrl_(v(layout.symbol)),
    screenerUrl: ab_screenerUrl_(v(layout.symbol))
  };
}


/**
 * Builds and sends the Quality Watch email: a summary table first
 * (Symbol/Company/% Change/Pattern/FVG - the "at a glance" view), then
 * one full detailed card per symbol. Returns the number of symbols
 * emailed (0 if the screen found nothing or nothing needed sending).
 */
// MailApp has a real per-message HTML size cap - past roughly 200 KB it
// fails outright with "Limit Exceeded: Email Body Size" (which is
// exactly what happened the first time this ran against 141 matches:
// a full multi-section card per symbol adds up fast). Rather than
// arbitrarily truncating the watchlist to fit one email, or shrinking
// the cards until they're less useful, this chunks the detail cards
// across as many emails as it takes - every symbol still gets its full
// card, just split "[Part 1/2]", "[Part 2/2]" etc. when needed. Tune
// the threshold in the Control Panel if you ever see the error again.
const AB_QUALITY_MAX_HTML_CHARS = ab_setting_('AB_QUALITY_MAX_HTML_CHARS', 150000);


function sendQualityWatchEmail_() {
  const screen = ab_qualityWatchSymbols_();
  const matches = screen.matches;
  if (!matches.length) {
    Logger.log('Quality Watch: no symbols passed the filter today.');
    return 0;
  }

  const layout = screen.layout;
  const displayRows = layout.sheet.getDataRange().getDisplayValues();
  const details = matches.map(m => ab_qualityWatchDetails_(layout, m.sheetRow, displayRows));
  // Biggest gainer first, biggest loser last. Rows with no % Change sink
  // to the bottom rather than being treated as 0.
  const pctNum = function (f) {
    const n = Number(String(f.pctChange || '').replace(/[%,+\s]/g, ''));
    return (f.pctChange === '' || /^#/.test(f.pctChange) || isNaN(n)) ? -Infinity : n;
  };
  details.sort(function (a, b) { return pctNum(b) - pctNum(a); });
  const ts = Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm');

  const intro = '<h2 style="margin:0 0 4px 0;">Quality Watch - ' + details.length + ' stock(s)</h2>' +
    '<div style="color:#777;font-size:13px;margin-bottom:4px;">' + ts + ' IST</div>' +
    '<div style="color:#999;font-size:12px;margin-bottom:16px;max-width:620px;">' +
    'OPM QoQ% and OPM YoY% both Increasing, Aggressive Increase or Slightly Increasing, TTM Signal = Buy, ' +
    'Last FY EPS present and TTM EPS not negative (so EPS Growth % is actually verifiable).</div>';

  // Summary table - Symbol / Company / % Change / Pattern / FVG.
  const th = 'style="text-align:left;padding:6px 10px;background:#f1f3f4;border-bottom:2px solid #dadce0;font-size:12px;color:#5f6368"';
  const td = 'style="padding:6px 10px;border-bottom:1px solid #eee;font-size:13px"';
  let summaryTable = '<table style="width:100%;border-collapse:collapse;max-width:720px;margin-bottom:20px;">' +
    '<tr><th ' + th + '>Symbol</th><th ' + th + '>Company</th><th ' + th + ' align="right">% Change</th>' +
    '<th ' + th + '>Pattern</th><th ' + th + '>FVG</th></tr>';
  details.forEach(function (f) {
    const chColour = ab_fieldColour_('% Change', f.pctChange);
    // Same link style as the other alert emails: symbol -> TradingView
    // chart, with a small screener.in link under it; the company name
    // also opens screener.in.
    const n = pctNum(f);
    const chText = n === -Infinity ? '-' : ((n > 0 ? '+' : '') + String(f.pctChange).replace(/[+%]/g, '').trim() + '%');
    summaryTable += '<tr><td ' + td + '><a href="' + ab_chartUrl_(f.symbol) + '" style="color:#1558d6;font-weight:700;text-decoration:none">' +
      f.symbol + '</a><br><a href="' + ab_screenerUrl_(f.symbol) + '" style="color:#888;font-size:11px">screener</a></td>' +
      '<td ' + td + '><a href="' + ab_screenerUrl_(f.symbol) + '" style="color:#111;text-decoration:none">' + f.name + '</a></td>' +
      // One style attribute only - a second style="" on the same tag is
      // ignored by mail clients, which is why % Change wasn't coloured.
      '<td align="right" style="padding:6px 10px;border-bottom:1px solid #eee;font-size:13px;color:' + chColour +
      ';font-weight:700">' + chText + '</td>' +
      '<td ' + td + '>' + (f.pattern || '-') + '</td><td ' + td + '>' + (f.fvg || '-') + '</td></tr>';
  });
  summaryTable += '</table>';

  const footer = '<div style="color:#999;font-size:12px;margin-top:8px;">This is a standing fundamentals + ' +
    'technicals screen, not a price-level alert - it re-sends the full current list every run rather than ' +
    'firing once per symbol. Click a symbol for its chart, or the company name for screener.in.</div>';

  // ONE email - the summary table only, no per-stock detail cards. The
  // cards used to push this into 6-7 emails (each costing a recipient
  // slot per address against Gmail's 100-recipients/day Apps Script
  // limit), which is what exhausted the daily quota before the EOD
  // Summary could go out. The table is one compact row per stock, so
  // even a long list fits comfortably in a single message.
  let html = '<div style="font-family:Arial,Helvetica,sans-serif;">' + intro + summaryTable + footer + '</div>';
  if (html.length > AB_QUALITY_MAX_HTML_CHARS) {
    // Pathologically long list - keep the top of the table (biggest
    // gainers first) and say how many were left off, rather than fail.
    const rowsHtml = summaryTable.split('</tr>');
    let kept = rowsHtml[0] + '</tr>'; // header row
    let n = 0;
    for (let i = 1; i < rowsHtml.length - 1; i++) {
      if (intro.length + kept.length + rowsHtml[i].length + footer.length + 400 > AB_QUALITY_MAX_HTML_CHARS) break;
      kept += rowsHtml[i] + '</tr>';
      n++;
    }
    html = '<div style="font-family:Arial,Helvetica,sans-serif;">' + intro + kept + '</table>' +
      '<div style="color:#b8860b;font-size:12px">+' + (details.length - n) + ' more not shown (email size limit).</div>' +
      footer + '</div>';
  }

  let text = 'Quality Watch - ' + details.length + ' stock(s) (' + ts + ')\n\n';
  details.forEach(function (f) {
    const n = pctNum(f);
    text += f.symbol + ' - ' + f.name + ' | ' + (n === -Infinity ? '-' : (n > 0 ? '+' : '') + n + '%') +
            ' | ' + (f.pattern || '-') + ' | ' + (f.fvg || '-') + '\n    ' + ab_chartUrl_(f.symbol) + '\n';
  });

  try {
    ab_sendMail_({
      to: AB_EMAIL_TO,
      subject: 'Quality Watch - ' + details.length + ' stock(s) (' + ts + ')',
      body: text,
      htmlBody: html
    });
    return details.length;
  } catch (e) {
    Logger.log('Quality Watch email failed: ' + e.message);
    return 0;
  }
}

/*****************************************************************
 * EMAIL PAUSE SWITCH
 * -----------------------------------------------------------------
 * Every email in this script goes through ab_sendMail_(). While a
 * pause is on (menu: 4. Emails & Notifications > Pause All Emails for
 * 24 Hours) nothing is sent - each skipped email is just noted in the
 * execution log. Everything else carries on as normal: sheets, tabs,
 * flags and Pushbullet notifications still update. The pause ends by
 * itself after 24 hours, or straight away with "Resume Emails Now".
 *
 * Gmail's own limit for scripts (100 recipients a day on a gmail.com
 * account, each address in AB_EMAIL_TO counting once per email) resets
 * 24 hours after the first email of the current period - "Email Status"
 * shows how many recipients are left right now.
 *****************************************************************/
const AB_EMAIL_PAUSE_PROP = 'AB_EMAIL_PAUSED_UNTIL';
const AB_EMAIL_PAUSE_HOURS = 24;

/** Epoch ms the pause ends, or 0 when emails are on. */
function ab_emailPausedUntil_() {
  const u = Number(PropertiesService.getScriptProperties().getProperty(AB_EMAIL_PAUSE_PROP) || 0);
  return (u && Date.now() < u) ? u : 0;
}

/** Drop-in for MailApp.sendEmail({...}) that respects the pause. Returns true if sent. */
function ab_sendMail_(msg) {
  const until = ab_emailPausedUntil_();
  if (until) {
    Logger.log('Emails paused until ' + Utilities.formatDate(new Date(until), AB_TZ, 'dd-MMM-yyyy HH:mm') +
               ' IST - skipped: ' + (msg && msg.subject));
    return false;
  }
  MailApp.sendEmail(msg);
  return true;
}

/** Menu: pause every email for 24 hours. */
function runPauseEmails24h() {
  const until = Date.now() + AB_EMAIL_PAUSE_HOURS * 3600000;
  PropertiesService.getScriptProperties().setProperty(AB_EMAIL_PAUSE_PROP, String(until));
  const when = Utilities.formatDate(new Date(until), AB_TZ, 'dd-MMM-yyyy HH:mm');
  Logger.log('Emails paused until ' + when + ' IST.');
  SpreadsheetApp.getActiveSpreadsheet().toast('All emails paused until ' + when + ' IST. Everything else keeps running; ' +
    'use "Resume Emails Now" to switch them back on early.', 'Emails paused', 15);
}

/** Menu: switch emails back on now. */
function runResumeEmails() {
  PropertiesService.getScriptProperties().deleteProperty(AB_EMAIL_PAUSE_PROP);
  SpreadsheetApp.getActiveSpreadsheet().toast('Emails are back on.', 'Emails resumed', 10);
}

/** Menu: is email paused, and how much of Gmail's daily allowance is left? */
function runEmailStatus() {
  const until = ab_emailPausedUntil_();
  let left = '?';
  try { left = MailApp.getRemainingDailyQuota(); } catch (e) { left = 'unknown (' + e.message + ')'; }
  const recipients = String(AB_EMAIL_TO || '').split(',').filter(function (x) { return x.trim(); }).length || 1;
  const msg = (until
      ? 'Emails are PAUSED until ' + Utilities.formatDate(new Date(until), AB_TZ, 'dd-MMM-yyyy HH:mm') + ' IST.'
      : 'Emails are ON.') +
    '\n\nGmail allowance left right now: ' + left + ' recipient(s)' +
    (typeof left === 'number' ? ' - about ' + Math.floor(left / recipients) + ' more email(s) to your ' + recipients + ' address(es).' : '.') +
    (left === 0 ? '\n\nThe allowance is used up. It comes back 24 hours after the first email of the current period.' : '');
  try {
    SpreadsheetApp.getUi().alert('Email status', msg, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {
    Logger.log(msg);
  }
}

/** Menu: run the Quality Watch screen + email right now. */
function runQualityWatchNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const n = sendQualityWatchEmail_();
    ss.toast(n ? n + ' quality stock(s) emailed to ' + AB_EMAIL_TO
                : 'No symbols currently pass the Quality Watch filter.', 'Quality Watch', 10);
  } catch (e) {
    ss.toast('Quality Watch failed: ' + e.message);
  }
}

/*****************************************************************
 * EOD MARKET SUMMARY DATA - feeds the market-wide section of the
 * combined EOD Summary email above (sendEodSummaryEmail_).
 * -----------------------------------------------------------------
 * These four helpers answer: who moved, which Basic Industries
 * led/lagged, which FVG zones mitigated today or are still
 * approaching, and which stocks printed a genuine Spring. They used to
 * feed a second, separate email - folded into one combined EOD Summary
 * so only a single mail goes out per day (and to stay well clear of
 * MailApp's daily quota).
 *****************************************************************/
const AB_EOD_GAINER_PCT_MIN = ab_setting_('AB_EOD_GAINER_PCT_MIN', 10);    // "top gainers" inclusion threshold
const AB_EOD_LOSER_COUNT = ab_setting_('AB_EOD_LOSER_COUNT', 20);       // how many of the day's worst movers to list
const AB_EOD_INDUSTRY_TOP_N = ab_setting_('AB_EOD_INDUSTRY_TOP_N', 5);     // how many Basic Industries to rank each way
const AB_EOD_INDUSTRY_MIN_COUNT = ab_setting_('AB_EOD_INDUSTRY_MIN_COUNT', 2); // a lone stock's move isn't an "industry" move

/**
 * Gainers over the threshold, the worst movers, and average-%-change
 * rankings by Basic Industry - all off Main's own "% Change" column.
 */
function ab_marketMoversSummary_() {
  const layout = ab_getMainLayout_();
  if (layout.pctChange === -1) {
    throw new Error('Main needs a "% Change" column for the market-movers summary.');
  }
  const data = layout.data;

  const stocks = [];
  for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
    const sym = ab_cellText_(data[r][layout.symbol]).toUpperCase();
    const name = ab_cellText_(data[r][layout.name]);
    if (!sym && !name) break;
    if (!sym) continue;
    const pct = ab_toNum_(data[r][layout.pctChange]);
    if (isNaN(pct)) continue;
    const basicIndustry = layout.basicIndustry !== -1 ? ab_cellText_(data[r][layout.basicIndustry]) : '';
    stocks.push({ symbol: sym, name: name, pct: pct, basicIndustry: basicIndustry });
  }

  const gainers = stocks.filter(function (s) { return s.pct > AB_EOD_GAINER_PCT_MIN; })
                         .sort(function (a, b) { return b.pct - a.pct; });
  const losers = stocks.slice()
                        .sort(function (a, b) { return a.pct - b.pct; })
                        .slice(0, AB_EOD_LOSER_COUNT);

  // Average % Change per Basic Industry. A group with just one stock in
  // it isn't an "industry" move, it's that one stock's move, so it's
  // filtered out rather than letting a single outlier claim a top-5 spot.
  const byIndustry = {};
  stocks.forEach(function (s) {
    if (!s.basicIndustry) return;
    if (!byIndustry[s.basicIndustry]) byIndustry[s.basicIndustry] = { name: s.basicIndustry, sum: 0, count: 0 };
    byIndustry[s.basicIndustry].sum += s.pct;
    byIndustry[s.basicIndustry].count++;
  });
  const industries = Object.keys(byIndustry)
    .map(function (k) { return byIndustry[k]; })
    .filter(function (g) { return g.count >= AB_EOD_INDUSTRY_MIN_COUNT; })
    .map(function (g) { return { name: g.name, avgPct: g.sum / g.count, count: g.count }; });

  const topIndustries = industries.slice()
    .sort(function (a, b) { return b.avgPct - a.avgPct; })
    .slice(0, AB_EOD_INDUSTRY_TOP_N);
  const bottomIndustries = industries.slice()
    .sort(function (a, b) { return a.avgPct - b.avgPct; })
    .slice(0, AB_EOD_INDUSTRY_TOP_N);

  return { gainers: gainers, losers: losers, topIndustries: topIndustries, bottomIndustries: bottomIndustries };
}

/**
 * Zones still open (i.e. not yet mitigated - a mitigated zone is
 * dropped from its tab entirely) that have come within the live
 * near-threshold at some point today - Alerted = 'Y' in the tab's own
 * col G. Shared by both AB_GAPUP_SHEET and AB_UNMIT_SHEET.
 */
function ab_listApproachingZones_(sheetName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(sheetName);
  if (!sh || sh.getLastRow() < 2) return [];
  const rows = sh.getDataRange().getValues();
  rows.shift(); // header
  const out = [];
  rows.forEach(function (r) {
    const sym = String(r[0] || '').trim().toUpperCase();
    if (!sym) return;
    const alerted = String(r[6] || '').trim().toUpperCase() === 'Y';
    if (!alerted) return;
    out.push({ symbol: sym, bottom: ab_toNum_(r[1]), top: ab_toNum_(r[2]), pct: ab_toNum_(r[3]) });
  });
  return out;
}

/** Today's rows from the Mitigated FVG Log - see ab_logMitigation_. */
function ab_mitigatedToday_(dayStr) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(AB_MITIGATED_LOG_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  const todayStr = dayStr || Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy');
  const rows = sh.getDataRange().getValues();
  rows.shift();
  return rows
    .filter(function (r) { return ab_msDateKey_(r[0]) === ab_msDateKey_(todayStr); })
    .map(function (r) {
      return { date: r[0], time: r[1], type: r[2], symbol: String(r[3] || '').trim().toUpperCase(),
               bottom: r[4], top: r[5], pct: r[6], priceSource: r[7] };
    })
    // The same zone can be logged twice in a day (live catch + EOD sweep) -
    // keep the first.
    .filter(function (m, i, all) {
      return all.findIndex(function (x) {
        return x.symbol === m.symbol && Number(x.top) === Number(m.top) && Number(x.bottom) === Number(m.bottom);
      }) === i;
    });
}

/** Today's full candle per symbol (Open/High/Low/Close) from the Today tab. */
function ab_getTodayCandleMap_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Today');
  const map = {};
  if (!sh || sh.getLastRow() < 2) return map;
  const data = sh.getDataRange().getValues();
  const h = data.shift().map(function (v) { return String(v).trim(); });
  const ix = { s: h.indexOf('TckrSymb'), o: h.indexOf('OpnPric'), hi: h.indexOf('HghPric'), l: h.indexOf('LwPric'), c: h.indexOf('ClsPric') };
  if (ix.s === -1 || ix.l === -1 || ix.c === -1) return map;
  data.forEach(function (r) {
    const sym = String(r[ix.s] || '').trim().toUpperCase();
    if (!sym) return;
    map[sym] = { o: ix.o === -1 ? NaN : ab_toNum_(r[ix.o]), h: ix.hi === -1 ? NaN : ab_toNum_(r[ix.hi]),
                 l: ab_toNum_(r[ix.l]), c: ab_toNum_(r[ix.c]) };
  });
  return map;
}

/**
 * How a mitigated (bullish) FVG behaved on the day it was hit, judged
 * on the day's LOW (how deep price went) and CLOSE (where it settled):
 *
 *   held    low reached into the zone, close back ABOVE the zone top -
 *           buyers defended it (the classic tap-and-go)
 *   swept   low went right THROUGH the zone (below its bottom) but the
 *           close recovered to back above the bottom - a liquidity sweep
 *   inside  close still sitting INSIDE the zone - undecided
 *   broken  close BELOW the zone bottom - the zone failed as support
 *   openin  the day's OPEN was already inside the zone and the day
 *           finished as a GREEN candle (close above open) - a gap-down
 *           / flat open into the zone that buyers lifted straight away.
 *           Checked first: it describes the whole candle, so it wins
 *           over held / swept / inside.
 *   nodata  no end-of-day candle to judge with
 *
 * depth     how far the low got into the zone, as % of the zone's height
 *           measured down from the top (100% = filled to the bottom,
 *           over 100% = pierced through)
 */
function ab_classifyMitigation_(m, candle) {
  const top = ab_toNum_(m.top), bottom = ab_toNum_(m.bottom);
  const out = { cat: 'nodata', depth: NaN, sweptPct: NaN, closeKind: '', closePct: NaN, closeFill: NaN, low: NaN, close: NaN,
                open: NaN, openFill: NaN, greenPct: NaN };
  if (!candle || isNaN(candle.l) || isNaN(candle.c) || isNaN(top) || isNaN(bottom) || top <= bottom) return out;
  const h = top - bottom;
  out.low = candle.l;
  out.close = candle.c;
  out.depth = Math.max(0, (top - candle.l) / h * 100);
  if (candle.l < bottom) out.sweptPct = (candle.l - bottom) / bottom * 100;
  if (candle.c > top) { out.closeKind = 'above'; out.closePct = (candle.c - top) / top * 100; }
  else if (candle.c >= bottom) { out.closeKind = 'inside'; out.closeFill = (top - candle.c) / h * 100; }
  else { out.closeKind = 'below'; out.closePct = (candle.c - bottom) / bottom * 100; }

  // Open inside the zone (edges count) + green candle.
  const op = candle.o;
  if (!isNaN(op) && op > 0) {
    out.open = op;
    out.openFill = (top - Math.min(Math.max(op, bottom), top)) / h * 100; // 0% = at the top edge, 100% = at the bottom edge
    out.greenPct = (candle.c - op) / op * 100;
  }
  const openedInside = !isNaN(op) && op <= top && op >= bottom;

  if (openedInside && candle.c > op) out.cat = 'openin';
  else if (out.closeKind === 'below') out.cat = 'broken';
  else if (candle.l < bottom) out.cat = 'swept';
  else if (out.closeKind === 'above') out.cat = 'held';
  else out.cat = 'inside';
  return out;
}

const AB_MIT_CATS_ = [
  { key: 'openin', label: 'Opened inside the zone & closed green', colour: '#1a56c4', bg: '#e8effc',
    note: "The day's OPEN was already inside the zone and the candle finished green (close above open) - bullish: buyers took over from the open." },
  { key: 'held', label: 'Held - tested the zone, closed above it', colour: '#0a8f4f', bg: '#e8f5ee',
    note: 'Low dipped into the zone, close finished back above the zone top - buyers defended it.' },
  { key: 'swept', label: 'Swept through & reclaimed', colour: '#0b7a75', bg: '#e3f4f3',
    note: 'Low pierced right through the zone bottom, but the close recovered back above it - a liquidity sweep.' },
  { key: 'inside', label: 'Closed inside the zone', colour: '#b8860b', bg: '#fff6dd',
    note: 'Still sitting in the zone at the close - not decided yet; watch the next session.' },
  { key: 'broken', label: 'Broke below - closed under the zone', colour: '#d64545', bg: '#fdeaea',
    note: 'Close below the zone bottom - the zone failed as support.' },
  { key: 'nodata', label: 'No end-of-day candle', colour: '#777777', bg: '#f1f3f4',
    note: "Today's OHLC wasn't available for these symbols, so they couldn't be judged." }
];

/** Spring thresholds from the Control Panel (percent values, as typed there). */
function ab_springCfg_() {
  return {
    bodyMin: ab_setting_('AB_SPRING_BODY_MIN_PCT', 0.5),
    day2BodyMax: ab_setting_('AB_SPRING_DAY2_BODY_MAX_PCT', 30),
    undercut: ab_setting_('AB_SPRING_UNDERCUT_PCT', 0.10),
    reclaimMax: ab_setting_('AB_SPRING_RECLAIM_MAX_PCT', 50)
  };
}

/** True when candle pair c1 (big red) -> c2 forms a Spring. Candles are {Opn,High,Low,Cls}. */
function ab_isSpringPair_(c1, c2, cfg) {
  const v = [c1.Opn, c1.High, c1.Low, c1.Cls, c2.Opn, c2.High, c2.Low, c2.Cls];
  if (v.some(function (x) { return typeof x !== 'number' || isNaN(x); })) return false;
  const c1Body = Math.abs(c1.Cls - c1.Opn);
  const c1Range = c1.High - c1.Low;
  return (c1.Cls < c1.Opn) &&
         (c1Body / c1.Opn >= cfg.bodyMin / 100) &&
         (c2.Low < c1.Low) &&
         (c2.Cls > c1.Low) &&
         (Math.abs(c2.Cls - c2.Opn) < (cfg.day2BodyMax / 100) * c1Body) &&
         (c2.Low <= c1.Low * (1 - cfg.undercut / 100)) &&
         (c2.High <= c1.Low + (cfg.reclaimMax / 100) * c1Range);
}

/**
 * Keeps only the Spring stocks whose Spring REALLY formed on `dayKey`
 * (yyyymmdd): the symbol has a History30 candle for that day and that candle
 * with the one before it passes the Spring test. A Pattern column that is
 * still yesterday's (EOD mail sent before Phase 1/2 ran) can therefore never
 * put old Springs into today's list or into the Signal Watchlist Log.
 */
function ab_freshSprings_(springs, dayKey, bySymbol) {
  const cfg = ab_springCfg_();
  return (springs || []).filter(function (s) {
    const c = bySymbol[String(s.symbol || '').toUpperCase()];
    if (!c || c.length < 2) return false;
    for (let i = c.length - 1; i >= 1; i--) {
      const k = ab_msDateKey_(c[i].date);
      if (k === dayKey) return ab_isSpringPair_(c[i - 1], c[i], cfg);
      if (k && k < dayKey) return false;
    }
    return false;
  });
}

/**
 * Symbols whose PatternData Pattern tag is exactly "Spring" today.
 * Deliberately excludes "Spring?" - a separate, looser, single-candle
 * tag computed a few lines below it in updateAllCandlestickPatterns -
 * by checking for an exact token match after splitting the comma-joined
 * Pattern column, rather than a substring match that "Spring?" would
 * also satisfy.
 */
function ab_springPatternStocks_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(AB_PATTERN_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  const data = sh.getDataRange().getValues();
  data.shift(); // header
  const out = [];
  data.forEach(function (r) {
    const sym = String(r[3] || '').trim().toUpperCase(); // col D
    if (!sym) return;
    const patternText = String(r[AB_COL_W - 1] || '').trim(); // col W (1-based) -> index 22
    if (!patternText) return;
    const tags = patternText.split(',').map(function (t) { return t.trim(); });
    if (tags.indexOf('Spring') !== -1) {
      out.push({ symbol: sym, company: String(r[1] || '').trim() }); // col B
    }
  });
  return out;
}

/**
 * Rebuilds the "Pivot" tab from scratch as ONE sortable/filterable
 * table - one row per Basic Industry across every symbol in Main,
 * with average daily / 10-day / 30-day % change, advance/decline
 * counts, and that industry's single best and worst mover today.
 *
 * Replaces the two old reference tables that used to live on this tab
 * (a Basic Industry breakdown and a separate Industry-level one) -
 * this fully clears the sheet and writes just this table instead.
 *
 * The header row gets Sheets' own filter dropdowns (Data > Create a
 * filter), so you can sort or filter by any of the %-change columns
 * right from the sheet to see which Basic Industry is moving today,
 * over 10 days, or over 30 days - no formulas to maintain. The three
 * average-%-change columns are also colour-scaled (red below zero,
 * white at zero, green above) so the hot/cold industries jump out
 * before you even filter anything.
 */
function buildBasicIndustryMovementDashboard_() {
  const layout = ab_getMainLayout_();
  if (layout.basicIndustry === -1) throw new Error('Main has no "Basic Industry" column.');
  if (layout.pctChange === -1) throw new Error('Main has no "% Change" column.');

  // Not part of ab_getMainLayout_ - only this dashboard needs them.
  const tenDayCol = layout.header.indexOf('10 day%');
  const thirtyDayCol = layout.header.indexOf('30Day%');

  const data = layout.data;
  const groups = {}; // Basic Industry name -> running stats
  let totalSymbols = 0;

  for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
    const symbol = ab_cellText_(data[r][layout.symbol]);
    const name = ab_cellText_(data[r][layout.name]);
    if (!symbol && !name) break; // end of the watchlist block
    const industry = ab_cellText_(data[r][layout.basicIndustry]);
    if (!industry || !symbol) continue;
    totalSymbols++;

    if (!groups[industry]) {
      groups[industry] = {
        name: industry, stocks: 0,
        pctSum: 0, pctN: 0, advancers: 0, decliners: 0,
        tenSum: 0, tenN: 0, thirtySum: 0, thirtyN: 0,
        bestSym: '', bestPct: -Infinity, worstSym: '', worstPct: Infinity
      };
    }
    const g = groups[industry];
    g.stocks++;

    const pct = ab_qrNum_(data[r][layout.pctChange]);
    if (!isNaN(pct)) {
      g.pctSum += pct; g.pctN++;
      if (pct > 0) g.advancers++; else if (pct < 0) g.decliners++;
      if (pct > g.bestPct) { g.bestPct = pct; g.bestSym = symbol; }
      if (pct < g.worstPct) { g.worstPct = pct; g.worstSym = symbol; }
    }
    if (tenDayCol !== -1) {
      const ten = ab_qrNum_(data[r][tenDayCol]);
      if (!isNaN(ten)) { g.tenSum += ten; g.tenN++; }
    }
    if (thirtyDayCol !== -1) {
      const thirty = ab_qrNum_(data[r][thirtyDayCol]);
      if (!isNaN(thirty)) { g.thirtySum += thirty; g.thirtyN++; }
    }
  }

  const rows = Object.keys(groups).map(function (name) {
    const g = groups[name];
    return [
      g.name,
      g.stocks,
      g.pctN ? Math.round((g.pctSum / g.pctN) * 100) / 100 : '',
      g.tenN ? Math.round((g.tenSum / g.tenN) * 100) / 100 : '',
      g.thirtyN ? Math.round((g.thirtySum / g.thirtyN) * 100) / 100 : '',
      g.advancers,
      g.decliners,
      g.bestPct > -Infinity ? g.bestSym : '',
      g.bestPct > -Infinity ? g.bestPct : '',
      g.worstPct < Infinity ? g.worstSym : '',
      g.worstPct < Infinity ? g.worstPct : ''
    ];
  });

  // Default sort: today's biggest average movers first. The filter
  // dropdowns on the header let you re-sort by 10-day, 30-day, or
  // anything else at any time - this is just the opening view.
  rows.sort(function (a, b) {
    const av = (typeof a[2] === 'number') ? a[2] : -Infinity;
    const bv = (typeof b[2] === 'number') ? b[2] : -Infinity;
    return bv - av;
  });

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ab_getOrCreateSheet_(AB_PIVOT_SHEET);
  const existingFilter = sh.getFilter();
  if (existingFilter) existingFilter.remove(); // can't rebuild under a stale filter range
  sh.clear(); // wipes both old reference tables and all their formatting
  sh.clearConditionalFormatRules();

  const stamp = Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm');
  sh.getRange(1, 1).setValue('BASIC INDUSTRY MOVEMENT').setFontWeight('bold').setFontSize(12);
  sh.getRange(2, 1).setValue('Updated: ' + stamp + ' - ' + rows.length + ' industries, ' +
    totalSymbols + ' symbols').setFontColor('#666666');

  const header = ['Basic Industry', 'Stocks', 'Avg % Change (Daily)', 'Avg 10 Day %', 'Avg 30 Day %',
                  'Advancers', 'Decliners', 'Top Gainer', 'Top Gainer %', 'Top Loser', 'Top Loser %'];
  const headerRow = 4;
  sh.getRange(headerRow, 1, 1, header.length).setValues([header])
    .setFontWeight('bold').setBackground('#f1f3f4');
  sh.setFrozenRows(headerRow);

  if (rows.length) {
    sh.getRange(headerRow + 1, 1, rows.length, header.length).setValues(rows);

    // Percent columns display with a literal "%" suffix - the values are
    // already percentage points (1.6 means 1.6%), not 0-1 fractions.
    [3, 4, 5, 9, 11].forEach(function (c) {
      sh.getRange(headerRow + 1, c, rows.length, 1).setNumberFormat('0.00"%"');
    });

    // Red (below zero) -> white (zero) -> green (above zero) on the three
    // average-%-change columns only - these are the "is it moving" signal.
    const rules = sh.getConditionalFormatRules();
    [3, 4, 5].forEach(function (c) {
      rules.push(SpreadsheetApp.newConditionalFormatRule()
        .setGradientMinpoint('#d64545')
        .setGradientMidpointWithValue('#ffffff', SpreadsheetApp.InterpolationType.NUMBER, '0')
        .setGradientMaxpoint('#0a8f4f')
        .setRanges([sh.getRange(headerRow + 1, c, rows.length, 1)])
        .build());
    });
    sh.setConditionalFormatRules(rules);

    // Sheets' native filter - gives every column a dropdown to sort or
    // filter by, e.g. "Avg 10 Day %" descending to see what's been
    // building for a week, with no formulas to maintain.
    sh.getRange(headerRow, 1, rows.length + 1, header.length).createFilter();

    sh.autoResizeColumns(1, header.length);
  }

  try { ss.toast('Basic Industry Movement rebuilt - ' + rows.length + ' industries, ' + totalSymbols + ' symbols.'); } catch (e) { /* no UI context */ }
  return { industries: rows.length, symbols: totalSymbols };
}

/** Menu: rebuild the "Pivot" tab's Basic Industry Movement table. */
function rebuildBasicIndustryMovement() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Rebuilding Basic Industry Movement...');
  try {
    const s = buildBasicIndustryMovementDashboard_();
    Logger.log('Basic Industry Movement: ' + s.industries + ' industries, ' + s.symbols + ' symbols.');
  } catch (e) {
    ss.toast('Basic Industry Movement failed: ' + e.message);
    Logger.log('rebuildBasicIndustryMovement failed: ' + e.message);
  }
}

/*****************************************************************
 * PIVOT-ONLY REFRESH TRIGGERS (mid-session + after-market)
 * -----------------------------------------------------------------
 * The full daily trigger (~6:45 PM) already rebuilds Pivot as part
 * of its run, but that's only once, after the close. Main's MKT
 * Price / % Change / 10 Day % / 30 Day % columns are live
 * GOOGLEFINANCE-based formulas (not written by this script), so
 * rebuilding Pivot from them is accurate and cheap at ANY time of
 * day - it's just a regroup-and-rewrite of whatever Main currently
 * shows, with no OHLC fetch, no pattern engine, and no alert pass.
 * That makes it safe to also run once DURING market hours (default
 * ~11:15 AM) and once more shortly after close (default ~5:00 PM),
 * on top of the 6:45 PM run, so you can see which Basic Industry is
 * actually moving mid-session instead of waiting for the evening.
 *
 * Each firing ALSO emails a compact "who's moving" snapshot - top
 * individual gainers/losers plus top/bottom Basic Industries - reusing
 * the exact same ranking function (ab_marketMoversSummary_) the 6:45 PM
 * EOD Summary already uses, so the numbers always agree with the
 * evening email. This is deliberately a smaller, faster mail than the
 * EOD Summary: no triggered-alerts/open-trades/FVG-zone sections, just
 * the market-wide movers, since those other sections only make sense
 * once-a-day anyway.
 *
 * Both times are Control Panel settings (AB_PIVOT_AM_HOUR/MIN,
 * AB_PIVOT_PM_HOUR/MIN) - change them there and re-run "Install
 * Pivot Refresh Triggers" from the menu to apply the new time.
 *****************************************************************/

/**
 * Compact "who's moving right now" email - individual Top
 * Gainers/Losers plus Top/Bottom Basic Industries, off the same
 * ab_marketMoversSummary_() data the EOD Summary uses. Self-contained
 * (its own copy of the small HTML helpers) rather than reusing
 * sendEodSummaryEmail_'s internals, so this can never affect that
 * working email. Returns true if a mail actually went out.
 */
function ab_sendMidDayMoversEmail_(subjectPrefix) {
  let movers;
  try {
    movers = ab_marketMoversSummary_();
  } catch (e) {
    Logger.log('Mid-day movers email: market-movers data unavailable - ' + e.message);
    return false;
  }
  const hasData = movers.gainers.length || movers.losers.length ||
                  movers.topIndustries.length || movers.bottomIndustries.length;
  if (!hasData) {
    Logger.log('Mid-day movers email: no market data yet - no mail sent.');
    return false;
  }

  const stamp = Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm');
  const th = 'style="text-align:left;padding:6px 10px;background:#f1f3f4;' +
             'border-bottom:2px solid #dadce0;font-size:12px;color:#5f6368"';
  const td = 'style="padding:6px 10px;border-bottom:1px solid #eee;font-size:13px"';

  function pctCell(pct) {
    const c = pct > 0 ? AB_C_POS : (pct < 0 ? AB_C_NEG : AB_C_MUTED);
    return '<span style="color:' + c + ';font-weight:bold">' + ab_pct2_(pct) + '</span>';
  }
  function symLink(sym) {
    return '<a href="' + ab_chartUrl_(sym) + '" style="color:inherit;text-decoration:none;' +
           'border-bottom:1px dotted #999">' + sym + '</a>';
  }
  function section(title, rows, headerCells, rowFn, emptyMsg) {
    let out = '<h3 style="margin:22px 0 6px;font-size:15px">' + title + '</h3>';
    if (!rows.length) {
      out += '<p style="color:#5f6368;font-size:13px;margin:0">' + emptyMsg + '</p>';
      return out;
    }
    out += '<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%">' +
           '<tr>' + headerCells.map(function (h) { return '<th ' + th + '>' + h + '</th>'; }).join('') + '</tr>';
    rows.forEach(function (r) { out += rowFn(r); });
    out += '</table>';
    return out;
  }

  let html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:760px">';
  html += '<h2 style="margin:0 0 4px">' + subjectPrefix + '</h2>';
  html += '<p style="margin:0 0 18px;color:#5f6368;font-size:13px">' + stamp +
          ' &middot; live snapshot off Main, not a settled EOD figure &middot; ' +
          movers.gainers.length + ' gainer(s) &gt;' + AB_EOD_GAINER_PCT_MIN + '%</p>';

  html += section('Top Gainers (> +' + AB_EOD_GAINER_PCT_MIN + '%)', movers.gainers,
    ['Symbol', 'Name', '% Change'],
    function (s) {
      return '<tr><td ' + td + '><b>' + symLink(s.symbol) + '</b></td><td ' + td + '>' + s.name + '</td>' +
             '<td ' + td + '>' + pctCell(s.pct) + '</td></tr>';
    }, 'None right now.');

  html += section('Top ' + AB_EOD_LOSER_COUNT + ' Losers', movers.losers,
    ['Symbol', 'Name', '% Change'],
    function (s) {
      return '<tr><td ' + td + '><b>' + symLink(s.symbol) + '</b></td><td ' + td + '>' + s.name + '</td>' +
             '<td ' + td + '>' + pctCell(s.pct) + '</td></tr>';
    }, 'No data.');

  html += section('Top ' + AB_EOD_INDUSTRY_TOP_N + ' Basic Industries (gains)', movers.topIndustries,
    ['Basic Industry', 'Avg % Change', 'Stocks'],
    function (g) {
      return '<tr><td ' + td + '>' + g.name + '</td><td ' + td + '>' + pctCell(g.avgPct) +
             '</td><td ' + td + '>' + g.count + '</td></tr>';
    }, 'Not enough data.');

  html += section('Bottom ' + AB_EOD_INDUSTRY_TOP_N + ' Basic Industries (losses)', movers.bottomIndustries,
    ['Basic Industry', 'Avg % Change', 'Stocks'],
    function (g) {
      return '<tr><td ' + td + '>' + g.name + '</td><td ' + td + '>' + pctCell(g.avgPct) +
             '</td><td ' + td + '>' + g.count + '</td></tr>';
    }, 'Not enough data.');

  html += '<p style="margin:22px 0 0;color:#5f6368;font-size:11px">' +
          'The full day-end summary (triggered alerts, open trades, FVG zones) still arrives separately, around 6:45 PM.</p>';
  html += '</div>';

  let text = subjectPrefix + ' - ' + stamp + '\n\n';
  text += 'Top Gainers (> +' + AB_EOD_GAINER_PCT_MIN + '%):\n';
  movers.gainers.forEach(function (s) { text += '  ' + s.symbol + ' ' + ab_pct2_(s.pct) + '\n'; });
  text += '\nTop ' + AB_EOD_LOSER_COUNT + ' Losers:\n';
  movers.losers.forEach(function (s) { text += '  ' + s.symbol + ' ' + ab_pct2_(s.pct) + '\n'; });
  text += '\nTop ' + AB_EOD_INDUSTRY_TOP_N + ' Basic Industries (gains):\n';
  movers.topIndustries.forEach(function (g) { text += '  ' + g.name + ' ' + ab_pct2_(g.avgPct) + ' (' + g.count + ' stocks)\n'; });
  text += '\nBottom ' + AB_EOD_INDUSTRY_TOP_N + ' Basic Industries (losses):\n';
  movers.bottomIndustries.forEach(function (g) { text += '  ' + g.name + ' ' + ab_pct2_(g.avgPct) + ' (' + g.count + ' stocks)\n'; });

  ab_sendMail_({ to: AB_EMAIL_TO, subject: subjectPrefix + ' - ' + stamp, body: text, htmlBody: html });
  return true;
}

/**
 * Rebuilds Pivot AND sends the mid-day movers email - the two are
 * independent (each in its own try/catch) so a mail quota hiccup
 * can't stop the sheet from refreshing, and vice versa. Logs one
 * combined line either way.
 */
function ab_refreshPivotOnly_(label, subjectPrefix) {
  const ts = Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm');

  let pivotResult = null, pivotErr = null;
  try {
    pivotResult = buildBasicIndustryMovementDashboard_();
  } catch (e) {
    pivotErr = e;
    Logger.log('Pivot-only refresh (' + (label || '') + ') failed: ' + e.message);
  }

  let mailSent = false, mailErr = null;
  try {
    mailSent = ab_sendMidDayMoversEmail_(subjectPrefix);
  } catch (e) {
    mailErr = e;
    Logger.log('Mid-day movers email (' + (label || '') + ') failed: ' + e.message);
  }

  const status = (pivotErr ? 'FAILED' : 'OK') + ' (pivot only' + (label ? ', ' + label : '') + ')';
  const notes = (pivotResult ? (pivotResult.industries + ' industries, ' + pivotResult.symbols + ' symbols')
                              : ('pivot failed: ' + (pivotErr && pivotErr.message))) +
                ' | email: ' + (mailSent ? 'sent' : (mailErr ? 'failed - ' + mailErr.message : 'skipped, no data'));
  try { logRun_(ts, '', pivotResult ? pivotResult.industries : 0, status, notes); }
  catch (logErr) { /* AutoFetch Log itself unreachable - nothing more to do */ }
}

// Kept as two separate named functions (rather than one function with
// an argument) so each shows up as its own distinct row in Apps
// Script's trigger list and execution log - easy to tell which one
// ran, or failed, at a glance.
function midSessionPivotRefresh(e) {
  if (ab_skipWeekendTrigger_(e, 'Mid-Session Movers')) return;
  ab_refreshPivotOnly_('mid-session', 'Mid-Session Movers (~11:15 AM)');
}
function afterMarketPivotRefresh(e) {
  if (ab_skipWeekendTrigger_(e, 'After-Market Movers')) return;
  ab_refreshPivotOnly_('after-market', 'After-Market Movers (~5 PM)');
}

/** Menu: install (or re-install, after changing the Control Panel times) both pivot-only triggers. */
function installPivotRefreshTriggers() {
  removePivotRefreshTriggers();
  ScriptApp.newTrigger('midSessionPivotRefresh')
    .timeBased().atHour(AB_PIVOT_AM_HOUR).nearMinute(AB_PIVOT_AM_MIN).everyDays(1).inTimezone(AB_TZ).create();
  ScriptApp.newTrigger('afterMarketPivotRefresh')
    .timeBased().atHour(AB_PIVOT_PM_HOUR).nearMinute(AB_PIVOT_PM_MIN).everyDays(1).inTimezone(AB_TZ).create();
  SpreadsheetApp.getActiveSpreadsheet().toast(
    'Pivot refresh triggers installed - around ' +
    AB_PIVOT_AM_HOUR + ':' + ('0' + AB_PIVOT_AM_MIN).slice(-2) + ' IST and ' +
    AB_PIVOT_PM_HOUR + ':' + ('0' + AB_PIVOT_PM_MIN).slice(-2) + ' IST, every day.', 'Pivot Refresh', 10);
}

/** Menu: remove both pivot-only triggers (the full daily trigger is untouched). */
function removePivotRefreshTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const fn = t.getHandlerFunction();
    if (fn === 'midSessionPivotRefresh' || fn === 'afterMarketPivotRefresh') ScriptApp.deleteTrigger(t);
  });
}

/*****************************************************************
 * POST-DAILY HOUSEKEEPING (06-Oct-2026)
 * -----------------------------------------------------------------
 * Index colour-coding, the Pivot rebuild, and the Risk Manager
 * refresh used to run inside ab_runUpdate_ itself, right alongside
 * the OHLC fetch and alert/trade pass. That's what pushed one evening
 * run to 360.7 seconds and straight into Apps Script's hard 6-minute
 * execution cap - a timeout KILLS the script outright, not something
 * try/catch can soft-fail around, so the whole run (alerts, trade
 * resolution, EOD email) was lost that evening, not just these three.
 *
 * None of these three are time-critical the way prices/alerts/trades
 * are - a slightly-stale Pivot or Risk Manager tab for a few more
 * minutes costs nothing - so they now run from their OWN trigger, a
 * little after the main one. A separate trigger firing is a fresh
 * execution with its own fresh 6-minute budget, so a slow evening
 * here can never again threaten the core pipeline.
 *
 * Each piece still soft-fails independently exactly as before - one
 * bad step can't take down the other two.
 *****************************************************************/

function ab_postDailyHousekeeping_() {
  const ts = Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm');
  const notes = [];

  try {
    ab_colorCodeSymbolsByIndex_();
    notes.push('index colours OK');
  } catch (cErr) {
    Logger.log('Post-daily housekeeping: index colour-coding failed - ' + cErr.message);
    notes.push('index colours FAILED: ' + cErr.message);
  }

  try {
    buildBasicIndustryMovementDashboard_();
    notes.push('Pivot OK');
  } catch (pErr) {
    Logger.log('Post-daily housekeeping: Pivot rebuild failed - ' + pErr.message);
    notes.push('Pivot FAILED: ' + pErr.message);
  }

  try {
    if (SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AB_RISK_SHEET)) {
      ab_buildRiskManager_();
      notes.push('Risk Manager OK');
    } else {
      notes.push('Risk Manager skipped (no tab yet)');
    }
  } catch (rErr) {
    Logger.log('Post-daily housekeeping: Risk Manager refresh failed - ' + rErr.message);
    notes.push('Risk Manager FAILED: ' + rErr.message);
  }

  try { logRun_(ts, '', 0, 'OK (post-daily housekeeping)', notes.join(' | ')); }
  catch (logErr) { /* AutoFetch Log itself unreachable - nothing more to do */ }
}

/** Menu: run the housekeeping pass (index colours, Pivot, Risk Manager) right now, without waiting for its trigger. */
function runPostDailyHousekeepingNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    ab_postDailyHousekeeping_();
    ss.toast('Index colours, Pivot, and Risk Manager refreshed.', 'Post-Daily Housekeeping', 10);
  } catch (e) {
    ss.toast('Post-daily housekeeping failed: ' + e.message);
  }
}

/** Menu: install the housekeeping trigger - runs shortly after the main daily trigger, in its own execution. */
function installPostDailyHousekeepingTrigger() {
  removePostDailyHousekeepingTrigger();
  ScriptApp.newTrigger('ab_postDailyHousekeeping_')
    .timeBased().atHour(AB_HOUSEKEEPING_HOUR).nearMinute(AB_HOUSEKEEPING_MIN).everyDays(1).inTimezone(AB_TZ).create();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Post-Daily Housekeeping trigger installed - around ' +
    AB_HOUSEKEEPING_HOUR + ':' + ('0' + AB_HOUSEKEEPING_MIN).slice(-2) + ' IST, every day.',
    'Post-Daily Housekeeping', 10);
}

function removePostDailyHousekeepingTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'ab_postDailyHousekeeping_') ScriptApp.deleteTrigger(t);
  });
}

/**
 * "Trade Dashboard" - the professional-trader-style log summary:
 * triggered vs pending, open vs resolved, win rate, average win/loss
 * size, and risk:reward ratio (avg win % / avg loss % magnitude).
 */
function buildTradeDashboard_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dash = ab_getOrCreateSheet_(AB_TRADE_DASH_SHEET);
  dash.clearContents();
  const stamp = Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy HH:mm');

  // Watchlist-level counts: triggered vs not-yet-triggered, with/without
  // an entry price (i.e. a real trade vs just a watched alert).
  let layout = null;
  try { layout = ab_getMainLayout_(); } catch (e) { Logger.log(e.message); }

  let totalArmed = 0, totalTriggered = 0, totalNotTriggered = 0;
  let realTrades = 0, openTrades = 0, pendingEntry = 0;
  if (layout && layout.entryPrice !== -1) {
    const data = layout.data;
    for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
      const row = data[r];
      const sym = String(row[layout.symbol]).trim().toUpperCase();
      const name = String(row[layout.name]).trim();
      if (!sym && !name) break;
      if (!sym) continue;
      const fall = ab_toNum_(row[layout.fallLevel]);
      const brk = ab_toNum_(row[layout.breakLevel]);
      const armed = (!isNaN(fall) && fall > 0) || (!isNaN(brk) && brk > 0);
      if (!armed) continue;
      totalArmed++;
      const triggered = String(row[layout.triggered]).trim().toUpperCase() === 'Y';
      if (triggered) totalTriggered++; else totalNotTriggered++;

      const entryPrice = ab_toNum_(row[layout.entryPrice]);
      const hasEntry = !isNaN(entryPrice) && entryPrice > 0;
      const outcome = layout.winLoss !== -1 ? String(row[layout.winLoss]).trim() : '';
      if (triggered && hasEntry) {
        realTrades++;
        if (!outcome) openTrades++;
      } else if (!triggered && hasEntry) {
        pendingEntry++; // entry price set in advance, waiting for the level to hit
      }
    }
  }

  const logSheet = ss.getSheetByName(AB_TRADE_LOG_SHEET);
  const block = [];
  block.push(['TRADE DASHBOARD', '', '', '', '', '']);
  block.push(['Updated: ' + stamp, '', '', '', '', '']);
  block.push(['', '', '', '', '', '']);
  block.push(['Watchlist Overview', '', '', '', '', '']);
  block.push(['Alerts Armed (level set)', totalArmed, '', '', '', '']);
  block.push(['Triggered', totalTriggered, '', '', '', '']);
  block.push(['Not Yet Triggered', totalNotTriggered, '', '', '', '']);
  block.push(['Real Trades (Entry Price set)', realTrades, '', '', '', '']);
  block.push(['  - Open (unresolved)', openTrades, '', '', '', '']);
  block.push(['  - Pending (entry set, not triggered yet)', pendingEntry, '', '', '', '']);
  block.push(['', '', '', '', '', '']);

  if (!logSheet || logSheet.getLastRow() < 2) {
    block.push(['No resolved trades logged yet.', '', '', '', '', '']);
    dash.getRange(1, 1, block.length, 6).setValues(block);
    dash.getRange(1, 1, 1, 1).setFontWeight('bold');
    dash.getRange(4, 1, 1, 1).setFontWeight('bold');
    return;
  }

  const rows = logSheet.getRange(2, 1, logSheet.getLastRow() - 1, 13).getValues();
  let wins = 0, losses = 0, winPctSum = 0, lossPctSum = 0, daysSum = 0;
  rows.forEach(r => {
    const outcome = String(r[11]).trim();
    const pctFromEntry = ab_toNum_(r[9]);
    const days = ab_toNum_(r[10]);
    if (!isNaN(days)) daysSum += days;
    if (outcome === 'Win') { wins++; if (!isNaN(pctFromEntry)) winPctSum += pctFromEntry; }
    else if (outcome === 'Loss') { losses++; if (!isNaN(pctFromEntry)) lossPctSum += pctFromEntry; }
  });
  const settled = wins + losses;
  const winRate = settled ? Math.round((wins / settled) * 1000) / 10 : 0;
  const avgWinPct = wins ? Math.round((winPctSum / wins) * 100) / 100 : 0;
  const avgLossPct = losses ? Math.round((lossPctSum / losses) * 100) / 100 : 0; // negative number
  // Risk:Reward - avg win size vs avg loss size (magnitude). Expressed as
  // "1 : X" the way professional trading logs usually present it.
  const rrRatio = (losses && avgLossPct !== 0) ? Math.round((avgWinPct / Math.abs(avgLossPct)) * 100) / 100 : '';
  const avgDaysHeld = rows.length ? Math.round((daysSum / rows.length) * 10) / 10 : 0;
  // Expectancy: average % result per trade taken, win or lose.
  const expectancy = settled ? Math.round(((winPctSum + lossPctSum) / settled) * 100) / 100 : 0;

  block.push(['Resolved Trade Performance', '', '', '', '', '']);
  block.push(['Total Resolved', settled, '', '', '', '']);
  block.push(['Wins', wins, '', '', '', '']);
  block.push(['Losses', losses, '', '', '', '']);
  block.push(['Win Rate %', winRate, '', '', '', '']);
  block.push(['Avg Win % (from entry)', avgWinPct, '', '', '', '']);
  block.push(['Avg Loss % (from entry)', avgLossPct, '', '', '', '']);
  block.push(['Risk:Reward (1 : X)', rrRatio, '', '', '', '']);
  block.push(['Expectancy % per trade', expectancy, '', '', '', '']);
  block.push(['Avg Days Held', avgDaysHeld, '', '', '', '']);
  block.push(['', '', '', '', '', '']);
  block.push(['RECENT TRADES (latest 20)', '', '', '', '', '']);
  block.push(['Date', 'Symbol', 'Entry', 'Exit', '% From Entry', 'Outcome']);
  rows.slice(-20).reverse().forEach(r => {
    block.push([r[0], r[1], r[5], r[7], r[9], r[11]]);
  });

  dash.getRange(1, 1, block.length, 6).setValues(block);
  dash.getRange(1, 1, 1, 1).setFontWeight('bold');
  dash.getRange(4, 1, 1, 1).setFontWeight('bold');
  const perfHeaderRow = block.findIndex(r => r[0] === 'Resolved Trade Performance') + 1;
  if (perfHeaderRow > 0) dash.getRange(perfHeaderRow, 1, 1, 1).setFontWeight('bold');
}

/** Menu item - runs the trade resolution + dashboard rebuild on demand. */
function runTradeResolutionNow() {
  const resolved = resolveTradesEOD_();
  buildTradeDashboard_();
  SpreadsheetApp.getActiveSpreadsheet().toast(
    resolved.length ? (resolved.length + ' trade(s) resolved - see Trade Log.') : 'No trades resolved.');
}

/*****************************************************************
 * RISK MANAGER
 * -----------------------------------------------------------------
 * A dedicated "Risk Manager" tab covering the four things a
 * disciplined trader actually checks before and during a trade:
 *
 *   1. POSITION SIZE CALCULATOR - type an Entry Price and Stoploss,
 *      it tells you exactly how many shares to buy so a stop-out
 *      costs no more than your target % of capital (AB_RISK_PCT_PER_TRADE,
 *      default 1%). This is the core discipline: every trade risks
 *      the same slice of capital regardless of the stock's price.
 *
 *   2. PORTFOLIO HEAT - total risk currently "live" across every open
 *      trade in Main (Triggered = Y, Entry Price filled, Win/Loss
 *      still blank) at once, checked against AB_RISK_MAX_HEAT_PCT.
 *      Main has no Quantity/Shares column, so this is EXACT only for
 *      a row where you've added one yourself (Qty/Quantity/Shares,
 *      matched by name, same as every other optional column in this
 *      script) - everywhere else it ASSUMES the trade was sized at
 *      the target risk %, which is true for anything actually sized
 *      with the calculator above. Rows using that assumption are
 *      flagged "(assumed)" rather than silently presented as exact.
 *
 *   3. DAILY LOSS CHECK (warn only, per your choice - nothing is
 *      blocked automatically) - counts today's resolved Losses from
 *      Trade Log at the target risk % each, against AB_RISK_DAILY_LOSS_PCT.
 *      Same reasoning as #2: a Loss by construction costs the target
 *      risk % if sized via the calculator, so counting Losses is a
 *      close read on today's real damage without needing fill-price
 *      bookkeeping this sheet doesn't keep.
 *
 *   4. DRAWDOWN / LOSS STREAK - a simple sequential equity curve built
 *      purely from Trade Log's existing "% From Entry" column (each
 *      resolved trade compounds onto the last), giving current and
 *      max drawdown plus the current losing streak - entirely free of
 *      new assumptions, since it's just your own logged trade data.
 *
 * Rebuilds in full on "Setup / Rebuild Risk Manager", every daily run
 * (soft-fails, see ab_runUpdate_), and whenever a trade resolves via
 * runTradeResolutionNow(). The calculator's two input cells refresh
 * instantly on their own via onEdit, without the full rebuild.
 *****************************************************************/

// Cell layout - the calculator's one editable input row. Keep these in
// one place since onEdit, the rebuild, and the refresh fn all need them.
const AB_RISK_CALC_ROW = 10;
const AB_RISK_CALC_ENTRY_COL = 1; // A: Entry Price (you type)
const AB_RISK_CALC_STOP_COL = 2;  // B: Stoploss (you type)
// C: Risk/Share, D: Risk This Trade (Rs), E: Suggested Qty,
// F: Capital Deployed (Rs), G: % of Capital Deployed, H: Note/error

/**
 * Pure math - given an entry/stoploss and the capital/risk-% to size
 * against, works out how many shares keep the stop-out at exactly
 * that % of capital. No sheet access, so it's trivially testable and
 * reused by both the calculator and the "assumed" heat estimate.
 */
function ab_riskCalc_(entry, stop, capital, riskPct) {
  const out = { riskPerShare: NaN, riskAmount: NaN, qty: 0, capitalDeployed: 0, pctDeployed: 0,
                actualRiskPct: 0, error: '', note: '' };
  if (isNaN(entry) || entry <= 0) { out.error = 'Enter Entry Price'; return out; }
  if (isNaN(stop) || stop <= 0) { out.error = 'Enter Stoploss'; return out; }
  if (stop >= entry) { out.error = 'Stoploss must be below Entry Price'; return out; }
  if (isNaN(capital) || capital <= 0) { out.error = 'Set AB_RISK_CAPITAL in the Control Panel'; return out; }

  const riskPerShare = entry - stop;
  const riskAmount = capital * (riskPct / 100);
  // Two independent caps on quantity: the risk-based figure (so a
  // stop-out costs exactly the target %) AND what capital can even
  // physically buy. A tight stop on a cheap stock with a big capital
  // base can otherwise "suggest" buying far more shares than you can
  // afford - capital always wins when the two disagree.
  const riskBasedQty = Math.floor(riskAmount / riskPerShare);
  const capitalBasedQty = Math.floor(capital / entry);
  const qty = Math.min(riskBasedQty, capitalBasedQty);

  out.riskPerShare = riskPerShare;
  out.riskAmount = riskAmount;
  out.qty = qty;
  out.capitalDeployed = qty * entry;
  out.pctDeployed = capital > 0 ? (qty * entry / capital) * 100 : 0;
  out.actualRiskPct = capital > 0 ? (qty * riskPerShare / capital) * 100 : 0;

  if (qty < 1) {
    out.error = capitalBasedQty < 1
      ? 'Not enough capital to buy even 1 share at this entry price'
      : 'Stop too close to entry - even 1 share risks more than target %';
    return out;
  }
  if (capitalBasedQty < riskBasedQty) {
    out.note = 'Capital-limited: actual risk is only ' +
               (Math.round(out.actualRiskPct * 100) / 100) + '% (target ' + riskPct + '%) - ' +
               'capital runs out before risk does at this price.';
  }
  return out;
}

/** Rewrites ONLY the calculator's output cells (C:H) - fast, for onEdit. */
function ab_riskCalcRefresh_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AB_RISK_SHEET);
  if (!sh) return;
  const entry = ab_toNum_(sh.getRange(AB_RISK_CALC_ROW, AB_RISK_CALC_ENTRY_COL).getValue());
  const stop = ab_toNum_(sh.getRange(AB_RISK_CALC_ROW, AB_RISK_CALC_STOP_COL).getValue());
  const r = ab_riskCalc_(entry, stop, AB_RISK_CAPITAL, AB_RISK_PCT_PER_TRADE);

  const row = [
    isNaN(r.riskPerShare) ? '-' : Math.round(r.riskPerShare * 100) / 100,
    isNaN(r.riskAmount) ? '-' : Math.round(r.riskAmount),
    r.qty || '-',
    r.capitalDeployed || '-',
    r.capitalDeployed ? (Math.round(r.pctDeployed * 100) / 100 + '%') : '-',
    r.error || r.note || 'OK'
  ];
  sh.getRange(AB_RISK_CALC_ROW, AB_RISK_CALC_ENTRY_COL + 2, 1, row.length).setValues([row]);
  sh.getRange(AB_RISK_CALC_ROW, AB_RISK_CALC_ENTRY_COL + 2 + row.length - 1)
    .setFontColor(r.error ? AB_C_NEG : (r.note ? '#b36b00' : AB_C_POS));
}

/**
 * Every currently open real trade in Main - same definition
 * resolveTradesEOD_() uses (Triggered = Y, Entry Price filled,
 * Win/Loss still blank) - with its risk estimate attached. Exact if a
 * Qty/Quantity/Shares column is present and filled for that row,
 * otherwise assumed at the target risk % (see file-header note above).
 */
function ab_openTradeRisk_(layout, capital, riskPct) {
  const out = [];
  if (layout.entryPrice === -1 || layout.stoploss === -1 || layout.winLoss === -1) return out;
  const data = layout.data;
  for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
    const row = data[r];
    const sym = String(row[layout.symbol] || '').trim();
    const name = layout.name !== -1 ? String(row[layout.name] || '').trim() : '';
    if (!sym && !name) break;
    if (!sym) continue;

    const triggered = String(row[layout.triggered] || '').trim().toUpperCase() === 'Y';
    const entry = ab_toNum_(row[layout.entryPrice]);
    const stop = layout.stoploss !== -1 ? ab_toNum_(row[layout.stoploss]) : NaN;
    const outcome = String(row[layout.winLoss] || '').trim();
    if (!triggered || isNaN(entry) || entry <= 0 || outcome) continue; // not an open real trade

    const qty = layout.qty !== -1 ? ab_toNum_(row[layout.qty]) : NaN;
    let riskAmount, pct, assumed;
    if (!isNaN(qty) && qty > 0 && !isNaN(stop) && stop > 0 && stop < entry) {
      riskAmount = (entry - stop) * qty;
      pct = capital > 0 ? riskAmount / capital * 100 : 0;
      assumed = false;
    } else {
      pct = riskPct;
      riskAmount = capital * (riskPct / 100);
      assumed = true;
    }
    out.push({ symbol: sym, name: name, entry: entry, stop: stop, qty: isNaN(qty) ? '' : qty,
               riskAmount: riskAmount, pct: pct, assumed: assumed });
  }
  return out;
}

/**
 * Sequential equity curve from Trade Log's "% From Entry" column -
 * each resolved trade compounds onto the last, as if the same capital
 * were reused trade after trade. Gives current/max drawdown and the
 * current consecutive-loss streak, using only data already logged -
 * no new assumptions, no new columns.
 */
function ab_computeEquityCurve_() {
  const out = { trades: 0, equity: 100, peak: 100, maxDrawdownPct: 0, currentDrawdownPct: 0,
                lossStreak: 0, maxLossStreak: 0, lossesToday: 0, winsToday: 0 };
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AB_TRADE_LOG_SHEET);
  if (!sh || sh.getLastRow() < 2) return out;

  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 13).getValues()
    .map(function (r) { return { date: ab_parseDate_(r[0]), pctFromEntry: ab_toNum_(r[9]), outcome: String(r[11] || '').trim() }; })
    .filter(function (r) { return r.date && !isNaN(r.pctFromEntry); });

  rows.sort(function (a, b) { return a.date - b.date; }); // oldest first, in case the log is ever reordered by hand

  const todayStr = Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM-yyyy');
  let equity = 100, peak = 100, maxDd = 0, streak = 0, maxStreak = 0;
  rows.forEach(function (r) {
    equity *= (1 + r.pctFromEntry / 100);
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak * 100 : 0;
    if (dd > maxDd) maxDd = dd;
    if (r.outcome === 'Loss') { streak++; if (streak > maxStreak) maxStreak = streak; }
    else if (r.outcome === 'Win') { streak = 0; }

    if (Utilities.formatDate(r.date, AB_TZ, 'dd-MMM-yyyy') === todayStr) {
      if (r.outcome === 'Loss') out.lossesToday++;
      else if (r.outcome === 'Win') out.winsToday++;
    }
  });

  out.trades = rows.length;
  out.equity = equity;
  out.peak = peak;
  out.maxDrawdownPct = maxDd;
  out.currentDrawdownPct = peak > 0 ? (peak - equity) / peak * 100 : 0;
  out.lossStreak = streak;
  out.maxLossStreak = maxStreak;
  return out;
}

/**
 * Full rebuild of the "Risk Manager" tab - settings summary, the
 * calculator, portfolio heat, the daily loss check, and drawdown/loss
 * streak, plus a detail table of every currently open trade. Wipes
 * and rewrites the whole tab except the calculator's two input cells,
 * which are preserved so you don't lose what you were typing.
 */
function ab_buildRiskManager_() {
  const sh = ab_getOrCreateSheet_(AB_RISK_SHEET);
  const savedEntry = sh.getRange(AB_RISK_CALC_ROW, AB_RISK_CALC_ENTRY_COL).getValue();
  const savedStop = sh.getRange(AB_RISK_CALC_ROW, AB_RISK_CALC_STOP_COL).getValue();
  sh.clear();

  const capital = AB_RISK_CAPITAL, riskPct = AB_RISK_PCT_PER_TRADE,
        maxHeatPct = AB_RISK_MAX_HEAT_PCT, dailyLossPct = AB_RISK_DAILY_LOSS_PCT;

  sh.getRange(1, 1).setValue('RISK MANAGER').setFontWeight('bold').setFontSize(14);
  sh.getRange(2, 1).setValue('Settings below come from the Control Panel tab (AB_RISK_... rows) - edit them there, not here.')
    .setFontColor(AB_C_MUTED);

  sh.getRange(4, 1, 1, 4).setValues([['Capital (Rs)', 'Risk % / Trade', 'Max Portfolio Heat %', 'Daily Loss Limit %']])
    .setFontWeight('bold').setBackground('#f1f3f4');
  sh.getRange(5, 1, 1, 4).setValues([[capital, riskPct + '%', maxHeatPct + '%', dailyLossPct + '%']]);

  // --- Position Size Calculator ------------------------------------
  sh.getRange(7, 1).setValue('POSITION SIZE CALCULATOR').setFontWeight('bold');
  sh.getRange(8, 1).setValue('Type your planned Entry Price and Stoploss below - everything else fills in automatically.')
    .setFontColor(AB_C_MUTED);
  sh.getRange(9, 1, 1, 8).setValues([[
    'Entry Price', 'Stoploss', 'Risk/Share (Rs)', 'Risk This Trade (Rs)',
    'Suggested Qty', 'Capital Deployed (Rs)', '% of Capital', 'Status'
  ]]).setFontWeight('bold').setBackground('#f1f3f4');
  sh.getRange(AB_RISK_CALC_ROW, 1).setValue(savedEntry);
  sh.getRange(AB_RISK_CALC_ROW, 2).setValue(savedStop);
  sh.getRange(AB_RISK_CALC_ROW, 1, 1, 2).setBackground('#fff8e1'); // the only cells meant to be typed into

  // --- Portfolio Heat -----------------------------------------------
  const openTrades = ab_openTradeRisk_(ab_getMainLayout_(), capital, riskPct);
  const totalRiskAmount = openTrades.reduce(function (s, t) { return s + t.riskAmount; }, 0);
  const totalRiskPct = capital > 0 ? totalRiskAmount / capital * 100 : 0;
  const anyAssumed = openTrades.some(function (t) { return t.assumed; });

  sh.getRange(12, 1).setValue('PORTFOLIO HEAT - every currently open trade, all at once').setFontWeight('bold');
  sh.getRange(13, 1, 1, 4).setValues([['Open Trades', 'Total Open Risk (Rs)', 'Total Open Risk (%)', 'vs Max Heat']])
    .setFontWeight('bold').setBackground('#f1f3f4');
  const heatStatus = totalRiskPct > maxHeatPct ? 'OVER LIMIT' : 'OK';
  sh.getRange(14, 1, 1, 4).setValues([[
    openTrades.length,
    Math.round(totalRiskAmount) + (anyAssumed ? ' (assumed)' : ''),
    (Math.round(totalRiskPct * 100) / 100) + '%',
    heatStatus + ' (limit ' + maxHeatPct + '%)'
  ]]);
  sh.getRange(14, 4).setFontColor(heatStatus === 'OVER LIMIT' ? AB_C_NEG : AB_C_POS).setFontWeight('bold');
  if (anyAssumed) {
    sh.getRange(15, 1).setValue('"(assumed)" = sized at target risk % - add a Qty/Quantity/Shares column to Main for exact figures.')
      .setFontColor(AB_C_MUTED);
  }

  // --- Daily Loss Check (warn only) ----------------------------------
  const curve = ab_computeEquityCurve_();
  const lossToday = curve.lossesToday * riskPct;
  sh.getRange(17, 1).setValue("TODAY'S LOSS CHECK (warn only - nothing is blocked automatically)").setFontWeight('bold');
  sh.getRange(18, 1, 1, 4).setValues([['Losses Today', 'Wins Today', 'Est. Loss Today (%)', 'vs Daily Limit']])
    .setFontWeight('bold').setBackground('#f1f3f4');
  const lossStatus = lossToday > dailyLossPct ? 'LIMIT HIT - consider stopping for today' : 'OK';
  sh.getRange(19, 1, 1, 4).setValues([[
    curve.lossesToday, curve.winsToday,
    (Math.round(lossToday * 100) / 100) + '%',
    lossStatus + ' (limit ' + dailyLossPct + '%)'
  ]]);
  sh.getRange(19, 4).setFontColor(lossStatus === 'OK' ? AB_C_POS : AB_C_NEG).setFontWeight('bold');

  // --- Drawdown / Loss Streak ----------------------------------------
  sh.getRange(21, 1).setValue('DRAWDOWN & LOSS STREAK - from every resolved trade in Trade Log').setFontWeight('bold');
  sh.getRange(22, 1, 1, 5).setValues([['Resolved Trades', 'Current Drawdown', 'Max Drawdown Ever', 'Current Loss Streak', 'Worst Loss Streak']])
    .setFontWeight('bold').setBackground('#f1f3f4');
  sh.getRange(23, 1, 1, 5).setValues([[
    curve.trades,
    (Math.round(curve.currentDrawdownPct * 100) / 100) + '%',
    (Math.round(curve.maxDrawdownPct * 100) / 100) + '%',
    curve.lossStreak,
    curve.maxLossStreak
  ]]);
  sh.getRange(23, 2).setFontColor(curve.currentDrawdownPct > 0 ? AB_C_NEG : AB_C_MUTED);

  // --- Open trade detail table ---------------------------------------
  sh.getRange(25, 1).setValue('OPEN TRADES').setFontWeight('bold');
  const detailHeader = ['Symbol', 'Name', 'Entry', 'Stoploss', 'Qty', 'Est. Risk (Rs)', '% of Capital', 'Basis'];
  sh.getRange(26, 1, 1, detailHeader.length).setValues([detailHeader]).setFontWeight('bold').setBackground('#f1f3f4');
  if (openTrades.length) {
    const detailRows = openTrades
      .sort(function (a, b) { return b.pct - a.pct; })
      .map(function (t) {
        return [t.symbol, t.name, t.entry, isNaN(t.stop) ? '' : t.stop, t.qty,
                Math.round(t.riskAmount), (Math.round(t.pct * 100) / 100) + '%',
                t.assumed ? 'Assumed (target %)' : 'Exact (Qty on row)'];
      });
    sh.getRange(27, 1, detailRows.length, detailHeader.length).setValues(detailRows);
  } else {
    sh.getRange(27, 1).setValue('No open trades right now.').setFontColor(AB_C_MUTED);
  }

  sh.setFrozenRows(2);
  sh.autoResizeColumns(1, 8);
  ab_riskCalcRefresh_(); // fills C:H for whatever Entry/Stoploss survived the clear
}

/** Menu: first-time setup AND on-demand rebuild - same function either way. */
function setupRiskManager() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    ab_buildRiskManager_();
    ss.toast('Risk Manager ready - type an Entry Price and Stoploss into the calculator to try it.',
             'Risk Manager', 10);
  } catch (e) {
    ss.toast('Risk Manager setup failed: ' + e.message);
  }
}

/*****************************************************************
 * SHEET WRITE
 *****************************************************************/
/*****************************************************************
 * PREV DAY VOLUME
 * -----------------------------------------------------------------
 * Fills Main's "Prev Day Vol" from the day tabs the daily run already
 * builds - no extra fetch, no GOOGLEFINANCE formula in the sheet.
 *
 * "Previous day" means the session BEFORE the most recent completed
 * one. The day tabs are ordered oldest -> newest (Day4, ThirdDay,
 * Yesterday, Today), so with Today = the last session that closed,
 * Yesterday is the one we want. Reading it from the same snapshot the
 * prices come from is the whole point: a separate live formula can sit
 * a day out of step with the OHLC around it, which is exactly how a
 * figure ends up looking wrong for no obvious reason.
 *
 * Volume is divided by AB_VOL_DIVISOR (see the constant near the top)
 * so the column reads in whatever unit you keep it in.
 *****************************************************************/
function ab_volumeMapFromTab_(tabName) {
  const map = {};
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tabName);
  if (!sh || sh.getLastRow() < 2) return map;
  const data = sh.getDataRange().getValues();
  const header = data.shift();
  const symIdx = header.indexOf('TckrSymb');
  const volIdx = header.indexOf('TtlTradgVol');
  if (symIdx === -1 || volIdx === -1) return map;
  data.forEach(function (r) {
    const sym = String(r[symIdx] || '').trim().toUpperCase();
    if (!sym) return;
    const v = ab_toNum_(r[volIdx]);
    if (!isNaN(v) && v > 0) map[sym] = v;
  });
  return map;
}

/**
 * Writes the column in ONE setValues call rather than per row - at
 * ~900 symbols a cell-at-a-time loop is the difference between a
 * second and a timeout. Rows with no volume on file keep whatever
 * they already had instead of being blanked.
 */
function fillPrevDayVolume_() {
  const layout = ab_getMainLayout_();
  const col = (function () {
    const want = ab_normHeader_('Prev Day Vol');
    for (let i = 0; i < layout.header.length; i++) {
      if (ab_normHeader_(layout.header[i]) === want) return i;
    }
    return -1;
  })();
  if (col === -1) {
    Logger.log('No "Prev Day Vol" column in Main - skipping volume fill.');
    return { filled: 0, missing: 0 };
  }

  const volMap = ab_volumeMapFromTab_('Yesterday');
  if (!Object.keys(volMap).length) {
    Logger.log('Yesterday tab has no volume data yet - run the daily update first.');
    return { filled: 0, missing: 0 };
  }

  const data = layout.data;
  const firstRow = layout.headerRowIdx + 1;
  const out = [];
  let filled = 0, missing = 0, lastIdx = -1;

  for (let r = firstRow; r < data.length; r++) {
    const sym = String(data[r][layout.symbol] || '').trim().toUpperCase();
    const name = String(data[r][layout.name] || '').trim();
    if (!sym && !name) break;
    const existing = data[r][col];
    if (!sym) { out.push([existing]); continue; }

    const raw = volMap[sym];
    if (raw === undefined) {
      out.push([existing]); // leave alone rather than wipe
      missing++;
    } else {
      const scaled = raw / AB_VOL_DIVISOR;
      const f = Math.pow(10, AB_VOL_DECIMALS);
      out.push([Math.round(scaled * f) / f]);
      filled++;
    }
    lastIdx = out.length;
  }

  if (lastIdx > 0) {
    layout.sheet.getRange(firstRow + 1, col + 1, lastIdx, 1)
      .setValues(out.slice(0, lastIdx));
  }
  Logger.log('Prev Day Vol: ' + filled + ' filled, ' + missing + ' with no volume on file.');
  return { filled: filled, missing: missing };
}

/** Menu: refill Prev Day Vol from the day tabs already in the sheet. */
function runPrevDayVolumeNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const s = fillPrevDayVolume_();
    ss.toast(s.filled + ' row(s) filled, ' + s.missing + ' had no volume on file.',
             'Prev Day Vol', 10);
  } catch (e) {
    ss.toast('Prev Day Vol failed: ' + e.message);
  }
}

/*****************************************************************
 * INDEX COLOUR-CODING
 * -----------------------------------------------------------------
 * Colours each SYMBOL cell in Main by which NSE index that stock
 * belongs to (Main's "INDICES" column), so e.g. every symbol under
 * "NIFTY IPO" shares one colour and every symbol under "SMALLCAP50"
 * shares a different one - scannable at a glance without opening a
 * filter.
 *
 * Two deliberate choices behind this (both confirmed with the user):
 *   - Only the SYMBOL cell gets coloured, not the whole row or the
 *     INDICES cell itself.
 *   - A stock listed under more than one index (comma/newline/slash/
 *     pipe-separated in the cell) is coloured by whichever index is
 *     listed FIRST in that cell - no other index it belongs to
 *     affects its colour.
 *
 * The actual set of index names is never hardcoded - Main's distinct
 * INDICES values vary and change over time, so this discovers them
 * fresh every run (in order of first appearance, top to bottom of the
 * sheet) and assigns colours from a curated palette in that order.
 * That means the same index can end up a different colour after a
 * run where its first appearance moved (e.g. new symbols inserted
 * above it) - the "Index Legend" tab this writes is always the
 * current, authoritative key, so check that rather than memorising a
 * colour.
 *****************************************************************/

// 24 curated, visually-distinct pastel colours - readable with plain
// black text, which is what ab_colorCodeSymbolsByIndex_() pairs them
// with. Cycles (colour reused) if Main ever has more distinct
// first-listed indices than this at once.
const AB_INDEX_COLOR_PALETTE_ = [
  '#F28B82', '#FBBC04', '#FFF475', '#CCFF90', '#A7FFEB',
  '#CBF0F8', '#AECBFA', '#D7AEFB', '#FDCFE8', '#E6C9A8',
  '#D3D3D3', '#F6C7B6', '#C4E8B4', '#B4D4E8', '#E8B4D4',
  '#C9C4E8', '#E8E0B4', '#B4E8DA', '#E8B4B4', '#C4B4E8',
  '#B4C4E8', '#E8D4B4', '#C4E8E0', '#D4E8B4'
];
const AB_INDEX_NONE_COLOR_ = '#ffffff'; // no INDICES value on that row

/**
 * First index name out of a (possibly multi-index) INDICES cell.
 * Accepts comma, semicolon, pipe, slash, or newline as separators -
 * whichever the sheet actually uses - and trims whitespace.
 */
function ab_firstIndexToken_(raw) {
  const s = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!s) return '';
  const parts = s.split(/[,;|\/\n]+/).map(function (p) { return p.trim(); }).filter(Boolean);
  return parts.length ? parts[0] : '';
}

/**
 * Colours every SYMBOL cell in Main by its first-listed INDICES value.
 * One batched setBackgrounds() call, so this is cheap even at Main's
 * full 1793-row size. Also rebuilds the "Index Legend" tab so the
 * colour key is always visible without re-running this function.
 * Soft-skips (returns a zero result, doesn't throw) if Main has no
 * INDICES column at all.
 */
function ab_colorCodeSymbolsByIndex_() {
  const layout = ab_getMainLayout_();
  if (layout.indices === -1) {
    Logger.log('No "INDICES" column in Main - skipping index colour-coding.');
    return { coded: 0, blank: 0, indexCount: 0 };
  }

  const data = layout.data;
  const firstRow = layout.headerRowIdx + 1;

  // Pass 1: first-listed index token per row, plus the order each
  // distinct index first appears in (top to bottom) - that order is
  // what decides palette assignment.
  const tokens = [];
  const order = [];
  const display = {};   // UPPERCASE key -> original-case text to show in the legend
  const countByKey = {};
  for (let r = firstRow; r < data.length; r++) {
    const sym = String(data[r][layout.symbol] || '').trim();
    const name = layout.name !== -1 ? String(data[r][layout.name] || '').trim() : '';
    if (!sym && !name) break;
    const tok = ab_firstIndexToken_(data[r][layout.indices]);
    tokens.push(tok);
    if (tok) {
      const key = tok.toUpperCase();
      if (!display[key]) { display[key] = tok; order.push(key); }
      countByKey[key] = (countByKey[key] || 0) + 1;
    }
  }

  if (!tokens.length) {
    Logger.log('Index colour-coding: no data rows found in Main.');
    return { coded: 0, blank: 0, indexCount: 0 };
  }

  const colorByKey = {};
  order.forEach(function (key, i) {
    colorByKey[key] = AB_INDEX_COLOR_PALETTE_[i % AB_INDEX_COLOR_PALETTE_.length];
  });

  const backgrounds = [];
  let coded = 0, blank = 0;
  tokens.forEach(function (tok) {
    if (!tok) { backgrounds.push([AB_INDEX_NONE_COLOR_]); blank++; return; }
    backgrounds.push([colorByKey[tok.toUpperCase()]]);
    coded++;
  });

  layout.sheet.getRange(firstRow + 1, layout.symbol + 1, backgrounds.length, 1)
    .setBackgrounds(backgrounds)
    .setFontColor('#111111');

  ab_writeIndexLegend_(order, display, colorByKey, countByKey);

  Logger.log('Index colour-coding: ' + coded + ' symbol(s) coloured across ' +
             order.length + ' distinct index(es), ' + blank + ' with no index listed.');
  return { coded: coded, blank: blank, indexCount: order.length };
}

/** Rebuilds the "Index Legend" tab - which colour means which index. */
function ab_writeIndexLegend_(order, display, colorByKey, countByKey) {
  const sh = ab_getOrCreateSheet_(AB_INDEX_LEGEND_SHEET);
  sh.clear();
  sh.setTabColor(null);

  const headerRow = ['Index', 'Symbol Count', 'Colour (SYMBOL cell background)'];
  sh.getRange(1, 1, 1, headerRow.length).setValues([headerRow])
    .setFontWeight('bold').setBackground('#f1f3f4');
  sh.setFrozenRows(1);

  if (!order.length) {
    sh.getRange(2, 1).setValue('No INDICES values found in Main.');
    sh.autoResizeColumns(1, headerRow.length);
    return;
  }

  const rows = order.map(function (key) {
    return [display[key], countByKey[key] || 0, ''];
  });
  sh.getRange(2, 1, rows.length, headerRow.length).setValues(rows);
  order.forEach(function (key, i) {
    sh.getRange(2 + i, 3).setBackground(colorByKey[key]).setFontColor('#111111')
      .setValue(colorByKey[key]);
  });
  sh.getRange(2, 1, rows.length, headerRow.length).setFontColor('#111111');

  sh.autoResizeColumns(1, headerRow.length);
  Logger.log('Index Legend: ' + order.length + ' distinct index(es) listed.');
}

/** Menu: run the SYMBOL-cell index colour-coding on demand. */
function runIndexColorCodeNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const s = ab_colorCodeSymbolsByIndex_();
    if (s.indexCount === 0 && s.coded === 0 && s.blank === 0) {
      ss.toast('No "INDICES" column found in Main - nothing to colour.', 'Index Colour-Coding', 10);
      return;
    }
    ss.toast(s.coded + ' symbol(s) coloured across ' + s.indexCount + ' index(es), ' +
             s.blank + ' with no index listed. See the "Index Legend" tab for the colour key.',
             'Index Colour-Coding', 10);
  } catch (e) {
    ss.toast('Index colour-coding failed: ' + e.message);
  }
}

/*****************************************************************
 * INDEXTRACKER CHART LINK (column L)
 * -----------------------------------------------------------------
 * BUG: column L's HYPERLINK is hand-typed per row (e.g.
 * ="HYPERLINK("https://in.tradingview.com/chart/?symbol=NSE%3ABANKNIFTY","Chart")
 * on the NIFTY_BANK template row) rather than a formula built off
 * column A. copyTo() carries formula TEXT verbatim for a cell with no
 * relative reference to move, so every row ab_addMissingIndices_ ever
 * added got the TEMPLATE row's chart link - i.e. BANKNIFTY's - instead
 * of its own. Confirmed live in the sheet: rows 21-29 (NIFTY_NEXT_50,
 * NIFTY_100, NIFTY_200, NIFTY_500, NIFTY_COMMODITIES, NIFTY_CPSE,
 * NIFTY_MNC, NIFTY_SERV_SECTOR, NIFTY_CONSUMPTION) all point at
 * BANKNIFTY's chart.
 *
 * FIX: column L is now set explicitly, per row, from this lookup
 * table (GOOGLEFINANCE ticker in column A -> real TradingView symbol)
 * instead of ever being copied. ab_addMissingIndices_ repairs EVERY
 * existing catalog row's link (not just new ones) each time it runs,
 * so rows 21-29 get corrected the next time you use the menu, without
 * needing a separate one-off cleanup.
 *
 * The first 16 entries below are copied straight from this sheet's
 * own hand-built rows 2-18 (NIFTY_BANK, NIFTY_METAL, NIFTY_AUTO, etc.)
 * - those links were typed by hand before any script touched them, so
 * they're ground truth, not a guess. The next block is long-established
 * legacy NSE/TradingView tickers (CNX100, NIFTY500, NIFTYJR, the
 * NIFTYMIDCAP/NIFTYSMLCAP family, ...) that are high-confidence but not
 * hand-verified in this sheet the way the first block is.
 *
 * Anything in AB_INDEX_CATALOG_ NOT in this table (mostly the 2023-24
 * thematic additions - Capital Goods, Cement, Insurance, REITs, Housing
 * Finance, NBFC, Hospitals, etc.) has no confirmed TradingView ticker.
 * Guessing one wrong is exactly how the old bug made every new row
 * silently point at BANKNIFTY, so instead of guessing, those get a
 * Google-search link labelled "Chart (verify)" that reliably surfaces
 * the right TradingView chart in one click - open it, confirm the
 * symbol, and add it to this table so it's a direct link from then on.
 *****************************************************************/
const AB_INDEX_CHART_SYMBOL_ = {
  // Ground truth - copied from this sheet's own pre-existing rows 2-18.
  'NIFTY_BANK': 'BANKNIFTY',
  'NIFTY_METAL': 'CNXMETAL',
  'NIFTY_AUTO': 'CNXAUTO',
  'NIFTY_FIN_SERVICE': 'CNXFINANCE',
  'NIFTY_MIDCAP_50': 'NIFTYMIDCAP50',
  'NIFTY_50': 'NIFTY',
  'NIFTY_INFRA': 'CNXINFRA',
  'NIFTY_PVT_BANK': 'NIFTYPVTBANK',
  'NIFTY_PHARMA': 'CNXPHARMA',
  'NIFTY_PSU_BANK': 'CNXPSUBANK',
  'NIFTY_PSE': 'CNXPSE',
  'NIFTY_FMCG': 'CNXFMCG',
  'NIFTY_ENERGY': 'CNXENERGY',
  'NIFTY_REALTY': 'CNXREALTY',
  'NIFTY_IT': 'CNXIT',
  'NIFTY_MEDIA': 'CNXMEDIA',
  // Long-established legacy tickers - high confidence, not hand-verified
  // in-sheet.
  'NIFTY_NEXT_50': 'NIFTYJR',
  'NIFTY_100': 'CNX100',
  'NIFTY_200': 'CNX200',
  'NIFTY_500': 'NIFTY500',
  'NIFTY_COMMODITIES': 'CNXCOMMODITIES',
  'NIFTY_CPSE': 'CNXCPSE',
  'NIFTY_MNC': 'CNXMNC',
  'NIFTY_SERV_SECTOR': 'CNXSERVICE',
  'NIFTY_CONSUMPTION': 'CNXCONSUMPTION',
  'NIFTY_MIDCAP_100': 'NIFTYMIDCAP100',
  'NIFTY_MIDCAP_150': 'NIFTYMIDCAP150',
  'NIFTY_SMLCAP_50': 'NIFTYSMLCAP50',
  'NIFTY_SMLCAP_100': 'NIFTYSMLCAP100',
  'NIFTY_SMLCAP_250': 'NIFTYSMLCAP250'
};

const AB_INDEXTRACKER_CHART_COL = 12; // column L

/**
 * Builds the Chart cell's formula for one index symbol - a direct
 * TradingView link when the ticker is confirmed, otherwise a labelled
 * Google-search fallback rather than a guessed (and possibly wrong)
 * TradingView symbol.
 */
function ab_indexChartFormula_(gfSymbol) {
  const tv = AB_INDEX_CHART_SYMBOL_[String(gfSymbol || '').toUpperCase()];
  if (tv) {
    return '=HYPERLINK("https://in.tradingview.com/chart/?symbol=NSE%3A' + tv + '","Chart")';
  }
  const readable = String(gfSymbol || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const query = 'TradingView NSE ' + readable + ' index chart';
  return '=HYPERLINK("https://www.google.com/search?q=' + encodeURIComponent(query) +
    '","Chart (verify)")';
}

/**
 * Repairs column L (Chart) for every row in Indextracker whose column A
 * holds a catalog symbol - both brand-new rows and ones added before
 * this fix existed. Rows whose column A isn't a recognised catalog
 * symbol (manual extras, stray text) are left untouched.
 */
function ab_fixIndexChartLinks_() {
  const sh = ab_getOrCreateSheet_(AB_INDEXTRACKER_SHEET);
  const lastRow = sh.getLastRow();
  if (lastRow < AB_INDEXTRACKER_TEMPLATE_ROW) return { fixed: [], unconfirmed: [] };

  const catalogSet = {};
  AB_INDEX_CATALOG_.forEach(function (sym) { catalogSet[sym.toUpperCase()] = true; });

  const numRows = lastRow - AB_INDEXTRACKER_TEMPLATE_ROW + 1;
  const colA = sh.getRange(AB_INDEXTRACKER_TEMPLATE_ROW, 1, numRows, 1).getValues();

  const fixed = [];
  const unconfirmed = [];
  for (let i = 0; i < numRows; i++) {
    const sym = String(colA[i][0] || '').trim();
    if (!sym || !catalogSet[sym.toUpperCase()]) continue;
    const row = AB_INDEXTRACKER_TEMPLATE_ROW + i;
    sh.getRange(row, AB_INDEXTRACKER_CHART_COL).setFormula(ab_indexChartFormula_(sym));
    fixed.push(sym);
    if (!AB_INDEX_CHART_SYMBOL_[sym.toUpperCase()]) unconfirmed.push(sym);
  }
  return { fixed: fixed, unconfirmed: unconfirmed };
}

/** Menu: repair Indextracker's Chart links without adding any new rows. */
function runFixIndexChartLinksNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const r = ab_fixIndexChartLinks_();
    let msg = r.fixed.length + ' Chart link(s) refreshed.';
    if (r.unconfirmed.length) {
      msg += ' ' + r.unconfirmed.length + ' have no confirmed TradingView symbol yet and got a ' +
             '"Chart (verify)" search link instead: ' + r.unconfirmed.join(', ') + '.';
    }
    ss.toast(msg, 'Fix Index Chart Links', 20);
    Logger.log(msg);
  } catch (e) {
    ss.toast('Fix Index Chart Links failed: ' + e.message);
  }
}

/**
 * Fills in any NSE index from AB_INDEX_CATALOG_ that isn't already
 * listed in the "Indextracker" sheet's column A.
 *
 * Design:
 *  1. Read the existing column A (row 2 down) to find what's already
 *     there, case-insensitively, and stop at the first fully-blank row
 *     (same "blank row = end of data" convention used elsewhere in this
 *     file).
 *  2. Diff against the catalog to get the missing list. If none are
 *     missing, stop here - nothing to add.
 *  3. For each missing symbol, copyTo() the template row (row 2) down
 *     to a brand-new row. copyTo() carries the template's formulas AND
 *     formatting, and - because the template's formulas reference their
 *     own row's column A cell with a normal (relative) reference -
 *     Sheets automatically re-points every copied formula at the NEW
 *     row's own column A cell. Nothing here has to read, parse, or
 *     rewrite formula text by hand.
 *  4. Overwrite just column A of each new row with the real symbol,
 *     then flush + wait so GOOGLEFINANCE has a chance to resolve.
 *  5. Self-validate: re-read column C (Current Price) for every new
 *     row. Any row that isn't a real positive number gets one longer
 *     retry wait (GOOGLEFINANCE can be slow/rate-limited right after a
 *     burst of new formulas, which looks identical to an unrecognised
 *     ticker at first glance) before being judged. Rows that still
 *     don't resolve are deleted (bottom-up, so earlier deletions don't
 *     shift the row numbers of later ones) and their symbols are
 *     reported back by name as "failed" - the sheet never ends up with
 *     a half-broken row, and the caller finds out exactly which catalog
 *     tickers need manual checking, instead of me asserting a ticker
 *     spelling I can't fully verify.
 */
function ab_addMissingIndices_() {
  const sh = ab_getOrCreateSheet_(AB_INDEXTRACKER_SHEET);
  const lastRow = sh.getLastRow();
  const lastCol = Math.max(sh.getLastColumn(), 12);

  if (lastRow < AB_INDEXTRACKER_TEMPLATE_ROW) {
    throw new Error('"' + AB_INDEXTRACKER_SHEET + '" has no template row (row ' +
                     AB_INDEXTRACKER_TEMPLATE_ROW + ') to copy formulas from.');
  }

  // Existing symbols: column A, row 2 downward, stopping at the first
  // fully-blank row.
  const existing = {};
  if (lastRow >= AB_INDEXTRACKER_TEMPLATE_ROW) {
    const colA = sh.getRange(AB_INDEXTRACKER_TEMPLATE_ROW, 1, lastRow - AB_INDEXTRACKER_TEMPLATE_ROW + 1, 1)
      .getValues();
    for (let i = 0; i < colA.length; i++) {
      const sym = String(colA[i][0] || '').trim();
      if (!sym) break;
      existing[sym.toUpperCase()] = true;
    }
  }

  const missing = AB_INDEX_CATALOG_.filter(function (sym) {
    return !existing[sym.toUpperCase()];
  });

  if (!missing.length) {
    // Still worth repairing Chart links even when there's nothing new to
    // add - this is the only path that fixes rows added before the
    // chart-link bug was found (e.g. rows 21-29, all pointing at
    // whatever symbol happened to be in the template row at the time).
    const repair = ab_fixIndexChartLinks_();
    Logger.log('Add Missing Indices: nothing to add, all ' + AB_INDEX_CATALOG_.length +
               ' catalog indices already present. Chart links refreshed for ' +
               repair.fixed.length + ' row(s).');
    return {
      added: [], failed: [], alreadyPresent: AB_INDEX_CATALOG_.length,
      chartLinksFixed: repair.fixed.length, chartLinksUnconfirmed: repair.unconfirmed
    };
  }

  // Append one fresh copy of the template row per missing symbol, then
  // stamp column A on each new row with its real symbol.
  const templateRange = sh.getRange(AB_INDEXTRACKER_TEMPLATE_ROW, 1, 1, lastCol);
  const firstNewRow = Math.max(lastRow + 1, AB_INDEXTRACKER_TEMPLATE_ROW + 1);

  missing.forEach(function (sym, i) {
    const destRow = firstNewRow + i;
    templateRange.copyTo(sh.getRange(destRow, 1, 1, lastCol));
    sh.getRange(destRow, 1).setValue(sym);
  });

  SpreadsheetApp.flush();
  Utilities.sleep(4000);

  // First pass: check which new rows resolved a real Current Price.
  let check = sh.getRange(firstNewRow, 3, missing.length, 1).getValues();
  let unresolved = [];
  missing.forEach(function (sym, i) {
    const v = check[i][0];
    if (typeof v !== 'number' || isNaN(v) || v <= 0) unresolved.push(i);
  });

  // Give GOOGLEFINANCE a second, longer chance before judging any
  // candidate a bad ticker - right after a burst of new formulas a slow
  // resolve looks identical to an invalid one.
  if (unresolved.length) {
    SpreadsheetApp.flush();
    Utilities.sleep(8000);
    check = sh.getRange(firstNewRow, 3, missing.length, 1).getValues();
    unresolved = [];
    missing.forEach(function (sym, i) {
      const v = check[i][0];
      if (typeof v !== 'number' || isNaN(v) || v <= 0) unresolved.push(i);
    });
  }

  const added = [];
  const failed = [];
  missing.forEach(function (sym, i) {
    if (unresolved.indexOf(i) === -1) added.push(sym);
    else failed.push(sym);
  });

  // Delete failed rows bottom-up so earlier deletions don't shift the
  // row index of rows still waiting to be deleted.
  unresolved.slice().sort(function (a, b) { return b - a; }).forEach(function (i) {
    sh.deleteRow(firstNewRow + i);
  });

  // Repair Chart links for EVERY catalog row, not just the ones just
  // added - this is what actually fixes rows added before this fix
  // existed (e.g. 21-29, all still pointing at the template's symbol).
  const repair = ab_fixIndexChartLinks_();

  Logger.log('Add Missing Indices: added ' + added.length + ' (' + added.join(', ') + '); ' +
             failed.length + ' failed/removed (' + failed.join(', ') + '); ' +
             repair.fixed.length + ' Chart link(s) refreshed.');
  return {
    added: added, failed: failed, alreadyPresent: AB_INDEX_CATALOG_.length - missing.length,
    chartLinksFixed: repair.fixed.length, chartLinksUnconfirmed: repair.unconfirmed
  };
}

/** Menu: add any catalog index missing from the "Indextracker" sheet. */
function runAddMissingIndicesNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const r = ab_addMissingIndices_();
    if (!r.added.length && !r.failed.length) {
      let msg = 'All ' + r.alreadyPresent + ' catalog indices are already in "' +
                AB_INDEXTRACKER_SHEET + '". Nothing to add. Chart links refreshed for ' +
                r.chartLinksFixed + ' row(s).';
      if (r.chartLinksUnconfirmed && r.chartLinksUnconfirmed.length) {
        msg += ' ' + r.chartLinksUnconfirmed.length + ' have no confirmed TradingView symbol ' +
               'yet (got a "Chart (verify)" search link): ' + r.chartLinksUnconfirmed.join(', ') + '.';
      }
      ss.toast(msg, 'Add Missing Indices', 20);
      return;
    }
    let msg = r.added.length + ' index(es) added: ' + (r.added.join(', ') || '(none)') + '.';
    if (r.failed.length) {
      msg += ' ' + r.failed.length + ' ticker(s) GOOGLEFINANCE did not recognise (removed): ' +
             r.failed.join(', ') + '.';
    }
    msg += ' Chart links refreshed for ' + r.chartLinksFixed + ' row(s).';
    if (r.chartLinksUnconfirmed && r.chartLinksUnconfirmed.length) {
      msg += ' ' + r.chartLinksUnconfirmed.length + ' unconfirmed (verify-search link): ' +
             r.chartLinksUnconfirmed.join(', ') + '.';
    }
    ss.toast(msg, 'Add Missing Indices', 20);
    Logger.log(msg);
  } catch (e) {
    ss.toast('Add Missing Indices failed: ' + e.message);
  }
}

/*****************************************************************
 * SMART DASHBOARD  (stock screener)
 * -----------------------------------------------------------------
 * Left side  = the filter panel. Tick as many boxes as you like:
 *     - several ticks in ONE group mean "either" (OR)
 *       e.g. OPM QoQ%: Increasing + Slightly Increasing
 *     - different groups must ALL match (AND)
 *     - nothing ticked in a group = that group is ignored
 *   Ready-made screens (top dropdown), a Sort dropdown, a Reset
 *   tick-box and number ranges (blank = no limit) sit in the same panel.
 * Right side = summary cards + the matching stocks, best first.
 *
 * Rebuilds by itself the moment you tick / type in the panel (see
 * onEdit -> ab_smartOnEdit_), or from the menu.
 *
 * Every Main column is found by its header NAME, so a column that is
 * missing is simply left blank instead of breaking the build.
 *****************************************************************/
const AB_SMART_SHEET = 'SmartDashboard';

/** Same name ignoring spaces and case - "Smart Dashboard" == "SmartDashboard". */
function ab_sameSheetName_(a, b) {
  return String(a || '').replace(/\s+/g, '').toLowerCase() ===
         String(b || '').replace(/\s+/g, '').toLowerCase();
}

/**
 * Finds the dashboard tab whatever spacing/capitalisation it was
 * created with, so a hand-made "SmartDashboard" and a script-made
 * "Smart Dashboard" can never end up sitting side by side as two
 * separate tabs.
 */
function ab_smartSheet_(createIfMissing) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const exact = ss.getSheetByName(AB_SMART_SHEET);
  if (exact) return exact;
  const all = ss.getSheets();
  for (let i = 0; i < all.length; i++) {
    if (ab_sameSheetName_(all[i].getName(), AB_SMART_SHEET)) return all[i];
  }
  return createIfMissing ? ss.insertSheet(AB_SMART_SHEET) : null;
}

// ---- look ----
const AB_SD = {
  navy: '#0f172a', slate: '#1e293b', ink: '#0f172a', muted: '#64748b', soft: '#94a3b8',
  line: '#e2e8f0', panel: '#f8fafc', card: '#f1f5f9', inputLine: '#cbd5e1', link: '#1d4ed8'
};
const AB_SD_FONT = 'Roboto';

// The trend words, in the order they are listed (best -> worst, then Volatile),
// each with the fill colour used for its chip and in the results table.
const AB_SD_TAGS = [
  AB_TT_TAG_AGGR_UP, AB_TT_TAG_INCREASING, AB_TT_TAG_SLIGHT_UP, AB_TT_TAG_STAGNANT,
  AB_TT_TAG_SLIGHT_DOWN, AB_TT_TAG_DECREASING, AB_TT_TAG_AGGR_DOWN, AB_TT_TAG_VOLATILE
];
const AB_SD_TAG_FILL = ['#86efac', '#bbf7d0', '#dcfce7', '#e2e8f0', '#fee2e2', '#fecaca', '#fca5a5', '#fde68a'];

// ---- panel layout (columns A-D; results start in column F) ----
const AB_SD_RAIL_COLS = 4;
const AB_SD_FIRST_RES_COL = 6;
const AB_SD_CARD_LABEL_ROW = 4;
const AB_SD_CARD_VALUE_ROW = 5;
const AB_SD_PRESET_ROW = 5;
const AB_SD_ACTION_ROW = 7;   // A7 = reset tick-box, C7:D7 = sort dropdown (also the results header row)
const AB_SD_HEADER_ROW = 7;
const AB_SD_FIRST_ROW = 8;    // first result row
const AB_SD_MAX_ROWS = 2000;  // most result rows ever written
const AB_SD_TREND_BAND_ROW = 8;
const AB_SD_TAG_GROUPS = [
  { header: 'Promotor Holding', title: 'Promoter Holding', col: 1, titleRow: 9 },
  { header: 'FII Activity',     title: 'FII Activity',     col: 3, titleRow: 9 },
  { header: 'OPM YoY%',         title: 'OPM YoY%',         col: 1, titleRow: 19 },
  { header: 'OPM QoQ%',         title: 'OPM QoQ%',         col: 3, titleRow: 19 }
];
const AB_SD_SIGNAL_TITLE_ROW = 29;     // Buy = next row, Avoid = row after; Basic Industry box = C30
const AB_SD_SIGNALS = ['Buy', 'Avoid'];
const AB_SD_SIGNAL_FILL = ['#bbf7d0', '#fecaca'];
const AB_SD_RANGE_BAND_ROW = 33;
const AB_SD_RANGE_FIRST_ROW = 34;      // label row of the first range filter; input row = next row
const AB_SD_RAIL_LAST_ROW = 46;
const AB_SD_PRESET_NONE = 'Choose a ready-made screen…';

// Number-range filters. Percent-type inputs hold a fraction (typing 20 in a
// "%" cell stores 0.2), the same as the Main column they read.
const AB_SD_NUM = [
  { key: 'upside',    label: 'Upside Potential',          src: 'Upside Potential',      fmt: '0.0%' },
  { key: 'peVsInd',   label: 'PE vs Industry PE (times)', src: 'PE vs Industry PE',     fmt: '0.00' },
  { key: 'pctDown',   label: 'From 52W High (below = −)',  src: '% down',                fmt: '0.0%' },
  { key: 'epsGrowth', label: 'TTM EPS Growth %',          src: 'TTM EPS Growth',        fmt: '0.0"%"', calc: true },
  { key: 'qoqRev',    label: 'QoQ Revenue Growth %',      src: 'QoQ Revenue Growth %',  fmt: '0.0"%"' },
  { key: 'volChg',    label: 'Volume Change',             src: 'Vol Change %',          fmt: '0%' }
];

// Sort choices (dropdown at C7). dir -1 = high to low, 1 = low to high.
const AB_SD_SORTS = [
  { label: 'Sort: Upside ↓',               key: 'upside',    dir: -1 },
  { label: 'Sort: Fall from 52W high ↓',   key: 'pctDown',   dir: 1 },
  { label: 'Sort: PE vs Industry ↑',       key: 'peVsInd',   dir: 1, positiveOnly: true },
  { label: 'Sort: TTM EPS growth ↓',       key: 'epsGrowth', dir: -1 },
  { label: 'Sort: QoQ revenue growth ↓',   key: 'qoqRev',    dir: -1 },
  { label: 'Sort: Volume change ↓',        key: 'volChg',    dir: -1 },
  { label: 'Sort: Day % ↓',                key: 'dayChg',    dir: -1 },
  { label: 'Sort: Stock name A–Z',         key: 'name',      dir: 1, text: true }
];

// Ready-made screens (top dropdown). Picking one fills the panel for you;
// you can still tick more / change anything afterwards.
const AB_SD_PRESETS = [
  { name: 'Quality Growth',
    tags: { 'OPM YoY%': ['Aggressive Increase', 'Increasing', 'Slightly Increasing'],
            'OPM QoQ%': ['Aggressive Increase', 'Increasing', 'Slightly Increasing'] },
    signal: ['Buy'], ranges: { qoqRev: [10, null] } },
  { name: 'Smart Money Buying',
    tags: { 'FII Activity': ['Increasing'], 'Promotor Holding': ['Increasing', 'Stagnant'] },
    signal: ['Buy'], ranges: {} },
  { name: 'Deep Value',
    tags: {}, signal: ['Buy'], ranges: { peVsInd: [0.01, 0.8], upside: [0.2, null] } },
  { name: 'Volume Breakout',
    tags: {}, signal: ['Buy'], ranges: { volChg: [1, null] } },
  { name: 'Beaten Down + Improving',
    tags: { 'OPM QoQ%': ['Aggressive Increase', 'Increasing', 'Slightly Increasing'] },
    signal: [], ranges: { pctDown: [null, -0.3] } }
];

// Result columns, left to right starting at column F.
//   src = Main header the value comes from, num = number, fmt = display format.
const AB_SD_RES = [
  { key: 'n',         title: '#',              w: 44,  align: 'center', fmt: '0' },
  { key: 'name',      title: 'Stock',          w: 215, align: 'left',   src: 'StockName' },
  { key: 'sym',       title: 'Symbol',         w: 115, align: 'left' },
  { key: 'basic',     title: 'Basic Industry', w: 195, align: 'left',   src: 'Basic Industry' },
  { key: 'price',     title: 'Price',          w: 90,  align: 'right',  src: 'MKT Price',            num: true, fmt: '#,##0.00' },
  { key: 'dayChg',    title: 'Day %',          w: 80,  align: 'right',  src: '% Change',             num: true, fmt: '+0.00"%";-0.00"%";0.00"%"' },
  { key: 'pctDown',   title: 'From 52W High',  w: 105, align: 'right',  src: '% down',               num: true, fmt: '+0.0%;-0.0%;0.0%' },
  { key: 'peVsInd',   title: 'PE vs Ind',      w: 85,  align: 'right',  src: 'PE vs Industry PE',    num: true, fmt: '0.00"x"' },
  { key: 'upside',    title: 'Upside',         w: 95,  align: 'right',  src: 'Upside Potential',     num: true, fmt: '+#,##0.0%;-#,##0.0%;0.0%' },
  { key: 'epsGrowth', title: 'TTM EPS Gr',     w: 100, align: 'right',  src: 'TTM EPS Growth',       num: true, fmt: '+#,##0.0"%";-#,##0.0"%";0.0"%"' },
  { key: 'qoqRev',    title: 'QoQ Rev Gr',     w: 95,  align: 'right',  src: 'QoQ Revenue Growth %', num: true, fmt: '+#,##0.0"%";-#,##0.0"%";0.0"%"' },
  { key: 'volChg',    title: 'Vol Chg',        w: 85,  align: 'right',  src: 'Vol Change %',         num: true, fmt: '+#,##0%;-#,##0%;0%' },
  { key: 'signal',    title: 'TTM Signal',     w: 100, align: 'center', src: 'TTM Signal' },
  { key: 'opmY',      title: 'OPM YoY%',       w: 150, align: 'center', src: 'OPM YoY%' },
  { key: 'opmQ',      title: 'OPM QoQ%',       w: 150, align: 'center', src: 'OPM QoQ%' },
  { key: 'prom',      title: 'Promoter',       w: 130, align: 'center', src: 'Promotor Holding' },
  { key: 'fii',       title: 'FII',            w: 130, align: 'center', src: 'FII Activity' }
];
const AB_SD_LAST_COL = AB_SD_FIRST_RES_COL + AB_SD_RES.length - 1;

// Summary cards above the table: [first result-column index, last, key].
const AB_SD_CARDS = [
  { from: 0,  to: 2,  key: 'matches', label: 'MATCHING STOCKS',      accent: '#0369a1' },
  { from: 3,  to: 4,  key: 'buys',    label: 'BUY SIGNALS',          accent: '#047857' },
  { from: 5,  to: 7,  key: 'upside',  label: 'MEDIAN UPSIDE',        accent: '#6d28d9' },
  { from: 8,  to: 10, key: 'pe',      label: 'MEDIAN PE VS INDUSTRY', accent: '#c2410c' },
  { from: 11, to: 13, key: 'down',    label: 'MEDIAN FROM 52W HIGH', accent: '#be123c' },
  { from: 14, to: 16, key: 'top',     label: 'TOP PICK',             accent: '#0f766e' }
];

/** Column index in Main for a header name, or -1. Normalised match. */
function ab_smartCol_(header, name) {
  const want = ab_normHeader_(name);
  for (let i = 0; i < header.length; i++) {
    if (ab_normHeader_(header[i]) === want) return i;
  }
  return -1;
}

/** "Increasing, Stagnant" -> ['increasing','stagnant']. Blank -> []. */
function ab_smartTokens_(text) {
  return String(text === null || text === undefined ? '' : text)
    .split(',')
    .map(function (s) { return s.trim().toLowerCase(); })
    .filter(Boolean);
}

/** Does a cell value satisfy the filter tokens? [] always passes. */
function ab_smartMatch_(cellValue, tokens, loose) {
  if (!tokens.length) return true;
  const v = String(cellValue === null || cellValue === undefined ? '' : cellValue)
    .trim().toLowerCase();
  if (!v) return false; // a blank cell can't match an active filter
  for (let i = 0; i < tokens.length; i++) {
    const t = String(tokens[i]).trim().toLowerCase();
    if (!t) continue;
    if (loose ? v.indexOf(t) !== -1 : v === t) return true;
  }
  return false;
}

/**
 * Percent/number cells arrive in different shapes - 0.45, "45%", "45.2",
 * "-12%", "1,234". Pulls a comparable number out of any of them and
 * returns NaN for anything non-numeric (#N/A, #DIV/0!, text, blank).
 */
function ab_smartNum_(v) {
  if (v === null || v === undefined || v === '') return NaN;
  if (typeof v === 'number') return isFinite(v) ? v : NaN;
  const cleaned = String(v).replace(/[%,\s₹]/g, '');
  if (!cleaned || !/^-?\.?\d/.test(cleaned)) return NaN;
  const n = Number(cleaned);
  return isNaN(n) ? NaN : n;
}

/** A Min/Max filter cell -> a bound to compare against, or null ("no limit"). */
function ab_smartBound_(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = ab_smartNum_(v);
  return isNaN(n) ? null : n;
}

/**
 * Does a metric value satisfy an active Min/Max range? Both bounds
 * null = filter not set, everything passes; once either is set, a row
 * with no number for this metric can't satisfy it.
 */
function ab_smartRangeOk_(value, minV, maxV) {
  if (minV === null && maxV === null) return true;
  if (isNaN(value)) return false;
  if (minV !== null && value < minV) return false;
  if (maxV !== null && value > maxV) return false;
  return true;
}

function ab_smartMedian_(arr) {
  const a = arr.filter(function (x) { return typeof x === 'number' && !isNaN(x); })
    .sort(function (x, y) { return x - y; });
  if (!a.length) return NaN;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function ab_smartIsTrue_(v) {
  return v === true || String(v).toUpperCase() === 'TRUE';
}

/** First row of the input cells for range filter i (the label sits one row above). */
function ab_smartRangeInputRow_(i) { return AB_SD_RANGE_FIRST_ROW + i * 2 + 1; }

/** Reads the whole panel in one go. */
function ab_smartReadFilters_(sh) {
  const g = sh.getRange(1, 1, AB_SD_RAIL_LAST_ROW, AB_SD_RAIL_COLS).getValues();
  const cell = function (row, col) { return g[row - 1][col - 1]; };

  const tags = AB_SD_TAG_GROUPS.map(function (grp) {
    const on = [];
    AB_SD_TAGS.forEach(function (t, i) {
      if (ab_smartIsTrue_(cell(grp.titleRow + 1 + i, grp.col))) on.push(t.toLowerCase());
    });
    return { header: grp.header, tokens: on };
  });

  const signal = [];
  AB_SD_SIGNALS.forEach(function (s, i) {
    if (ab_smartIsTrue_(cell(AB_SD_SIGNAL_TITLE_ROW + 1 + i, 1))) signal.push(s.toLowerCase());
  });

  const basic = ab_smartTokens_(cell(AB_SD_SIGNAL_TITLE_ROW + 1, 3));

  const ranges = AB_SD_NUM.map(function (def, i) {
    const row = ab_smartRangeInputRow_(i);
    return { def: def, min: ab_smartBound_(cell(row, 1)), max: ab_smartBound_(cell(row, 3)) };
  });

  const sortLabel = String(cell(AB_SD_ACTION_ROW, 3) || '');
  const sort = AB_SD_SORTS.filter(function (s) { return s.label === sortLabel; })[0] || AB_SD_SORTS[0];
  return { tags: tags, signal: signal, basic: basic, ranges: ranges, sort: sort };
}

/** Does one stock row pass every active filter? `m` = its numbers by key. */
function ab_smartRowPasses_(filters, cols, rowVals, m) {
  for (let i = 0; i < filters.tags.length; i++) {
    const f = filters.tags[i];
    if (!f.tokens.length) continue;
    const c = cols.tag[f.header];
    if (c === undefined || c === -1) return false;
    if (!ab_smartMatch_(rowVals[c], f.tokens, false)) return false;
  }
  if (filters.signal.length) {
    if (cols.signal === -1) return false;
    if (!ab_smartMatch_(rowVals[cols.signal], filters.signal, false)) return false;
  }
  if (filters.basic.length) {
    if (cols.basic === -1) return false;
    if (!ab_smartMatch_(rowVals[cols.basic], filters.basic, true)) return false;
  }
  for (let i = 0; i < filters.ranges.length; i++) {
    const rg = filters.ranges[i];
    if (rg.min === null && rg.max === null) continue;
    if (!ab_smartRangeOk_(m[rg.def.key], rg.min, rg.max)) return false;
  }
  return true;
}

/** Rebuilds the summary cards, the table and the status line from the panel. Returns { matched, scanned }. */
function buildSmartDashboard_() {
  const sh = ab_smartSheet_(false);
  if (!sh) {
    Logger.log('No "' + AB_SMART_SHEET + '" tab - run Setup Smart Dashboard first.');
    return { matched: 0, scanned: 0 };
  }

  const layout = ab_getMainLayout_();
  const header = layout.header;
  const data = layout.data;
  const firstRow = layout.headerRowIdx + 1;

  const filters = ab_smartReadFilters_(sh);

  // Where each wanted column lives in Main.
  const srcIdx = {};
  AB_SD_RES.forEach(function (c) { if (c.src) srcIdx[c.key] = ab_smartCol_(header, c.src); });
  if (srcIdx.name === -1) srcIdx.name = layout.name;
  const cols = {
    tag: {
      'Promotor Holding': srcIdx.prom, 'FII Activity': srcIdx.fii,
      'OPM YoY%': srcIdx.opmY, 'OPM QoQ%': srcIdx.opmQ
    },
    signal: srcIdx.signal,
    basic: srcIdx.basic
  };

  const rows = [];
  let scanned = 0;
  for (let r = firstRow; r < data.length; r++) {
    const sym = String(data[r][layout.symbol] || '').trim().toUpperCase();
    const nm = String(data[r][layout.name] || '').trim();
    if (!sym && !nm) break;
    if (!sym) continue;
    scanned++;

    const raw = data[r];
    const m = {};
    AB_SD_RES.forEach(function (c) {
      if (!c.num) return;
      m[c.key] = srcIdx[c.key] === -1 ? NaN : ab_smartNum_(raw[srcIdx[c.key]]);
    });
    // TTM EPS Growth comes straight from Main; if that column is missing,
    // work it out from TTM EPS vs Last FY EPS instead.
    if (srcIdx.epsGrowth === -1) {
      const g = ab_pctChange_(ab_toNum_(raw[layout.ttmEps]), ab_toNum_(raw[layout.lastFyEps]));
      m.epsGrowth = g === '' ? NaN : g;
    }

    if (!ab_smartRowPasses_(filters, cols, raw, m)) continue;
    rows.push({ sym: sym, name: nm, raw: raw, m: m });
  }

  // ---- sort: chosen key first, blanks always last ----
  const sk = filters.sort;
  const keyOf = function (rw) {
    if (sk.text) return String(rw.name || '').toLowerCase();
    let v = rw.m[sk.key];
    if (sk.positiveOnly && !(v > 0)) v = NaN;
    return v;
  };
  rows.sort(function (a, b) {
    const av = keyOf(a), bv = keyOf(b);
    if (sk.text) return av < bv ? -1 : av > bv ? 1 : 0;
    const an = isNaN(av), bn = isNaN(bv);
    if (an && bn) return 0;
    if (an) return 1;
    if (bn) return -1;
    if (av !== bv) return (av - bv) * sk.dir;
    return 0;
  });
  const shown = rows.slice(0, AB_SD_MAX_ROWS);

  // ---- table ----
  const nCols = AB_SD_RES.length;
  const maxRows = sh.getMaxRows();
  if (maxRows < AB_SD_FIRST_ROW + AB_SD_MAX_ROWS) {
    sh.insertRowsAfter(maxRows, AB_SD_FIRST_ROW + AB_SD_MAX_ROWS - maxRows);
  }
  const clearRows = sh.getMaxRows() - AB_SD_FIRST_ROW + 1;
  sh.getRange(AB_SD_FIRST_ROW, AB_SD_FIRST_RES_COL, clearRows, nCols).clear();

  if (shown.length) {
    const grid = [], fmts = [], aligns = [];
    shown.forEach(function (rw, i) {
      grid.push(AB_SD_RES.map(function (c) {
        if (c.key === 'n') return i + 1;
        if (c.key === 'sym') {
          return '=HYPERLINK("' + ab_chartUrl_(rw.sym).replace(/"/g, '""') + '","' +
                 rw.sym.replace(/"/g, '""') + '")';
        }
        if (c.num) { const v = rw.m[c.key]; return isNaN(v) ? '' : v; }
        const t = srcIdx[c.key] === -1 ? '' : rw.raw[srcIdx[c.key]];
        const s = String(t === null || t === undefined ? '' : t).trim();
        return /^#(N\/A|DIV\/0!|REF!|VALUE!|NAME\?|NUM!|NULL!|ERROR!)/.test(s) ? '' : s;
      }));
    });
    const fmtRow = AB_SD_RES.map(function (c) { return c.fmt || 'General'; });
    const alignRow = AB_SD_RES.map(function (c) { return c.align || 'left'; });
    for (let i = 0; i < shown.length; i++) { fmts.push(fmtRow); aligns.push(alignRow); }

    const block = sh.getRange(AB_SD_FIRST_ROW, AB_SD_FIRST_RES_COL, shown.length, nCols);
    block.setNumberFormats(fmts);
    block.setValues(grid);
    block.setHorizontalAlignments(aligns);
    block.setFontFamily(AB_SD_FONT).setFontSize(10).setFontColor('#000000')
      .setVerticalAlignment('middle');
    block.setBorder(null, null, true, null, null, true, AB_SD.line, SpreadsheetApp.BorderStyle.SOLID);
    // Symbol column: link look
    const symCol = AB_SD_FIRST_RES_COL + AB_SD_RES.map(function (c) { return c.key; }).indexOf('sym');
    sh.getRange(AB_SD_FIRST_ROW, symCol, shown.length, 1)
      .setFontColor(AB_SD.link).setFontWeight('bold');
  } else {
    const msg = sh.getRange(AB_SD_FIRST_ROW + 1, AB_SD_FIRST_RES_COL + 1);
    msg.setValue(scanned
      ? 'No stock matches every selected filter. Untick a few boxes, widen a range, or tick "↺ Reset all" on the left.'
      : 'Main has no stocks to screen yet.');
    msg.setFontFamily(AB_SD_FONT).setFontSize(11).setFontColor(AB_SD.muted).setFontStyle('italic');
  }

  // ---- summary cards ----
  const num = function (key) { return shown.map(function (rw) { return rw.m[key]; }); };
  const buys = shown.filter(function (rw) {
    return srcIdx.signal !== -1 && String(rw.raw[srcIdx.signal]).trim().toLowerCase() === 'buy';
  }).length;
  const medUp = ab_smartMedian_(num('upside'));
  const medPe = ab_smartMedian_(num('peVsInd').filter(function (v) { return v > 0; }));
  const medDown = ab_smartMedian_(num('pctDown'));
  let top = '—';
  if (shown.length) {
    const t0 = shown[0], tv = t0.m[sk.key === 'name' ? 'upside' : sk.key];
    top = t0.sym + (typeof tv === 'number' && !isNaN(tv) && !sk.text
      ? '   ' + ab_smartCardVal_(sk.key, tv) : '');
  }
  const cardVals = {
    matches: [scanned ? shown.length + ' / ' + scanned : '—', '@'],
    buys: [shown.length ? buys : '—', '0'],
    upside: [isNaN(medUp) ? '—' : medUp, '+#,##0.0%;-#,##0.0%;0.0%'],
    pe: [isNaN(medPe) ? '—' : medPe, '0.00"x"'],
    down: [isNaN(medDown) ? '—' : medDown, '+0.0%;-0.0%;0.0%'],
    top: [top, '@']
  };
  AB_SD_CARDS.forEach(function (cd) {
    const c = sh.getRange(AB_SD_CARD_VALUE_ROW, AB_SD_FIRST_RES_COL + cd.from);
    const cv = cardVals[cd.key];
    c.setNumberFormat(cv[1]);
    c.setValue(cv[0]);
  });

  // ---- status line (top right) ----
  const activeTags = filters.tags.filter(function (f) { return f.tokens.length; }).length;
  const activeCount = activeTags + (filters.signal.length ? 1 : 0) + (filters.basic.length ? 1 : 0) +
    filters.ranges.filter(function (f) { return f.min !== null || f.max !== null; }).length;
  sh.getRange(1, AB_SD_FIRST_RES_COL + 7).setValue(
    (activeCount ? activeCount + ' filter' + (activeCount > 1 ? 's' : '') + ' active' : 'no filters - showing everything') +
    '  ·  updated ' + Utilities.formatDate(new Date(), AB_TZ, 'dd-MMM HH:mm'));

  Logger.log('Smart Dashboard: ' + shown.length + '/' + scanned + ' matched.');
  return { matched: rows.length, scanned: scanned };
}

/** Short text for the Top Pick card, matching the column the list is sorted by. */
function ab_smartCardVal_(key, v) {
  const sgn = v > 0 ? '+' : '';
  if (Math.abs(v) >= 100 && (key === 'upside' || key === 'pctDown' || key === 'volChg')) return sgn + '10,000%+';
  if (key === 'upside' || key === 'pctDown' || key === 'volChg') return sgn + (Math.round(v * 1000) / 10) + '%';
  if (key === 'peVsInd') return (Math.round(v * 100) / 100) + 'x';
  return sgn + (Math.round(v * 10) / 10) + '%';
}

/** Merges a block of cells and returns it. */
function ab_smartMerge_(sh, row, col, nRows, nCols) {
  const rg = sh.getRange(row, col, nRows, nCols);
  rg.merge();
  return rg;
}

/** Conditional colours for the results table (black text, fills only). */
function ab_smartCfRules_(sh) {
  const first = AB_SD_FIRST_ROW, n = AB_SD_MAX_ROWS;
  const keys = AB_SD_RES.map(function (c) { return c.key; });
  const colOf = function (k) { return AB_SD_FIRST_RES_COL + keys.indexOf(k); };
  const rng = function (k) { return sh.getRange(first, colOf(k), n, 1); };
  const mk = function () { return SpreadsheetApp.newConditionalFormatRule(); };
  const rules = [];
  const put = function (range, builder, bg) {
    rules.push(builder.setBackground(bg).setFontColor('#000000').setRanges([range]).build());
  };

  // Day %
  put(rng('dayChg'), mk().whenNumberGreaterThan(0), '#d1fae5');
  put(rng('dayChg'), mk().whenNumberLessThan(0), '#fee2e2');
  // From 52W high (deeper below = redder)
  put(rng('pctDown'), mk().whenNumberLessThanOrEqualTo(-0.4), '#fecaca');
  put(rng('pctDown'), mk().whenNumberLessThanOrEqualTo(-0.2), '#fee2e2');
  // PE vs industry: cheaper than the industry = green, pricier = red
  put(rng('peVsInd'), mk().whenNumberBetween(0.0001, 1), '#d1fae5');
  put(rng('peVsInd'), mk().whenNumberGreaterThan(1.5), '#fee2e2');
  // Upside
  put(rng('upside'), mk().whenNumberGreaterThanOrEqualTo(0.5), '#86efac');
  put(rng('upside'), mk().whenNumberGreaterThan(0.2), '#bbf7d0');
  put(rng('upside'), mk().whenNumberGreaterThan(0), '#dcfce7');
  put(rng('upside'), mk().whenNumberLessThan(0), '#fee2e2');
  // EPS / revenue growth (percent numbers)
  ['epsGrowth', 'qoqRev'].forEach(function (k) {
    put(rng(k), mk().whenNumberGreaterThanOrEqualTo(25), '#bbf7d0');
    put(rng(k), mk().whenNumberGreaterThan(0), '#dcfce7');
    put(rng(k), mk().whenNumberLessThan(0), '#fee2e2');
  });
  // Volume change (fraction: 1 = +100%)
  put(rng('volChg'), mk().whenNumberGreaterThanOrEqualTo(1), '#bbf7d0');
  put(rng('volChg'), mk().whenNumberGreaterThan(0), '#dcfce7');
  put(rng('volChg'), mk().whenNumberLessThan(0), '#fee2e2');
  // Buy / Avoid chips
  put(rng('signal'), mk().whenTextEqualTo('Buy'), '#bbf7d0');
  put(rng('signal'), mk().whenTextEqualTo('Avoid'), '#fecaca');
  // Trend words (four neighbouring columns)
  const trend = sh.getRange(first, colOf('opmY'), n, 4);
  AB_SD_TAGS.forEach(function (t, i) {
    put(trend, mk().whenTextEqualTo(t), AB_SD_TAG_FILL[i]);
  });
  // Light zebra stripe on cells nothing else coloured
  const nameL = ab_colToLetter_(colOf('name'));
  rules.push(mk().whenFormulaSatisfied('=AND($' + nameL + first + '<>"",ISEVEN(ROW()))')
    .setBackground('#f8fafc')
    .setRanges([sh.getRange(first, AB_SD_FIRST_RES_COL, n, AB_SD_RES.length)]).build());
  return rules;
}

/** Draws the (static) look of the whole tab. Called by setup. */
function ab_smartPaint_(sh) {
  const U = AB_SD;
  const lastCol = AB_SD_LAST_COL;
  const nRes = AB_SD_RES.length;
  const need = AB_SD_FIRST_ROW + AB_SD_MAX_ROWS;
  if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
  if (sh.getMaxColumns() < lastCol + 1) sh.insertColumnsAfter(sh.getMaxColumns(), lastCol + 1 - sh.getMaxColumns());
  if (sh.getMaxColumns() > lastCol + 1) sh.deleteColumns(lastCol + 2, sh.getMaxColumns() - lastCol - 1);

  // base
  const all = sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns());
  all.setFontFamily(AB_SD_FONT).setFontSize(10).setFontColor(U.ink).setBackground('#ffffff')
    .setVerticalAlignment('middle');
  sh.setHiddenGridlines(true);
  try { sh.setTabColor('#0f172a'); } catch (e) { /* cosmetic */ }

  // column widths
  [34, 140, 34, 140, 16].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  AB_SD_RES.forEach(function (c, i) { sh.setColumnWidth(AB_SD_FIRST_RES_COL + i, c.w); });
  sh.setColumnWidth(lastCol + 1, 20);

  // row heights
  sh.setRowHeight(1, 42);
  sh.setRowHeight(2, 24);
  sh.setRowHeight(3, 8);
  sh.setRowHeight(4, 20);
  sh.setRowHeight(5, 34);
  sh.setRowHeight(6, 8);
  sh.setRowHeight(7, 30);
  sh.setRowHeights(AB_SD_FIRST_ROW, sh.getMaxRows() - AB_SD_FIRST_ROW + 1, 26);

  // ---- banner ----
  sh.getRange(1, 1, 2, lastCol + 1).setBackground(U.navy);
  const title = ab_smartMerge_(sh, 1, 1, 1, AB_SD_FIRST_RES_COL + 6);
  title.setValue('📊  SMART DASHBOARD  ·  Stock Screener')
    .setFontSize(18).setFontWeight('bold').setFontColor('#ffffff')
    .setHorizontalAlignment('left').setVerticalAlignment('middle');
  const status = ab_smartMerge_(sh, 1, AB_SD_FIRST_RES_COL + 7, 1, lastCol - (AB_SD_FIRST_RES_COL + 7) + 1);
  status.setFontColor('#cbd5e1').setFontSize(10).setHorizontalAlignment('right');
  const sub = ab_smartMerge_(sh, 2, 1, 1, lastCol);
  sub.setValue('Tick one or more boxes in a group — any of them can match. Different groups must all match. The list updates the moment you tick.')
    .setFontColor(U.soft).setFontSize(9).setHorizontalAlignment('left');

  // ---- quick screen + reset + sort (left panel top) ----
  sh.getRange(AB_SD_CARD_LABEL_ROW, 1).setValue('QUICK SCREEN');
  ab_smartMerge_(sh, AB_SD_CARD_LABEL_ROW, 1, 1, AB_SD_RAIL_COLS)
    .setFontSize(9).setFontWeight('bold').setFontColor(U.muted).setHorizontalAlignment('left');
  const preset = ab_smartMerge_(sh, AB_SD_PRESET_ROW, 1, 1, AB_SD_RAIL_COLS);
  preset.setValue(AB_SD_PRESET_NONE)
    .setBackground('#ffffff').setFontWeight('bold').setFontSize(11).setFontColor(U.ink)
    .setHorizontalAlignment('left')
    .setBorder(true, true, true, true, false, false, '#0369a1', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  preset.setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList([AB_SD_PRESET_NONE].concat(AB_SD_PRESETS.map(function (p) { return p.name; })), true)
    .setAllowInvalid(false).build());

  const checkRule = SpreadsheetApp.newDataValidation().requireCheckbox().build();
  const reset = sh.getRange(AB_SD_ACTION_ROW, 1);
  reset.setDataValidation(checkRule).setValue(false).setHorizontalAlignment('center').setBackground('#fee2e2');
  sh.getRange(AB_SD_ACTION_ROW, 2).setValue('↺ Reset all')
    .setFontWeight('bold').setFontSize(10).setBackground('#fee2e2').setHorizontalAlignment('left');
  const sortCell = ab_smartMerge_(sh, AB_SD_ACTION_ROW, 3, 1, 2);
  sortCell.setValue(AB_SD_SORTS[0].label)
    .setBackground(U.card).setFontWeight('bold').setFontSize(9).setHorizontalAlignment('left')
    .setBorder(true, true, true, true, false, false, U.inputLine, SpreadsheetApp.BorderStyle.SOLID);
  sortCell.setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(AB_SD_SORTS.map(function (s) { return s.label; }), true)
    .setAllowInvalid(false).build());

  const band = function (row, text) {
    ab_smartMerge_(sh, row, 1, 1, AB_SD_RAIL_COLS).setValue(text)
      .setBackground(U.navy).setFontColor('#ffffff').setFontWeight('bold').setFontSize(10)
      .setHorizontalAlignment('left');
  };

  // ---- trend filters ----
  band(AB_SD_TREND_BAND_ROW, '  TREND FILTERS  ·  tick one or more');
  AB_SD_TAG_GROUPS.forEach(function (grp) {
    ab_smartMerge_(sh, grp.titleRow, grp.col, 1, 2).setValue(grp.title)
      .setBackground(U.line).setFontWeight('bold').setFontSize(10).setHorizontalAlignment('left');
    const boxes = sh.getRange(grp.titleRow + 1, grp.col, AB_SD_TAGS.length, 1);
    boxes.setDataValidation(checkRule).setValue(false).setHorizontalAlignment('center');
    AB_SD_TAGS.forEach(function (t, i) {
      const rowN = grp.titleRow + 1 + i;
      sh.getRange(rowN, grp.col + 1).setValue(t).setFontSize(10).setHorizontalAlignment('left');
      sh.getRange(rowN, grp.col, 1, 2).setBackground(AB_SD_TAG_FILL[i])
        .setBorder(true, true, true, true, false, false, '#ffffff', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
    });
  });

  // ---- signal + basic industry ----
  const sr = AB_SD_SIGNAL_TITLE_ROW;
  ab_smartMerge_(sh, sr, 1, 1, 2).setValue('TTM Signal')
    .setBackground(U.line).setFontWeight('bold').setHorizontalAlignment('left');
  ab_smartMerge_(sh, sr, 3, 1, 2).setValue('Basic Industry contains')
    .setBackground(U.line).setFontWeight('bold').setHorizontalAlignment('left');
  sh.getRange(sr + 1, 1, AB_SD_SIGNALS.length, 1).setDataValidation(checkRule).setValue(false)
    .setHorizontalAlignment('center');
  AB_SD_SIGNALS.forEach(function (s, i) {
    sh.getRange(sr + 1 + i, 2).setValue(s).setHorizontalAlignment('left');
    sh.getRange(sr + 1 + i, 1, 1, 2).setBackground(AB_SD_SIGNAL_FILL[i])
      .setBorder(true, true, true, true, false, false, '#ffffff', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  });
  ab_smartMerge_(sh, sr + 1, 3, 1, 2).setBackground('#ffffff').setHorizontalAlignment('left')
    .setBorder(true, true, true, true, false, false, U.inputLine, SpreadsheetApp.BorderStyle.SOLID);
  ab_smartMerge_(sh, sr + 2, 3, 1, 2).setValue('e.g. Bank, Pharma  (comma = either)')
    .setFontColor(U.soft).setFontSize(8).setFontStyle('italic').setHorizontalAlignment('left');

  // ---- number ranges ----
  band(AB_SD_RANGE_BAND_ROW, '  RANGE FILTERS  ·  blank = no limit');
  AB_SD_NUM.forEach(function (def, i) {
    const labelRow = AB_SD_RANGE_FIRST_ROW + i * 2;
    const inputRow = labelRow + 1;
    ab_smartMerge_(sh, labelRow, 1, 1, AB_SD_RAIL_COLS).setValue(def.label)
      .setFontWeight('bold').setFontSize(9).setFontColor(U.muted).setHorizontalAlignment('left')
      .setVerticalAlignment('bottom');
    [1, 3].forEach(function (c) {
      ab_smartMerge_(sh, inputRow, c, 1, 2).setNumberFormat(def.fmt).setBackground('#ffffff')
        .setHorizontalAlignment('center')
        .setBorder(true, true, true, true, false, false, U.inputLine, SpreadsheetApp.BorderStyle.SOLID);
    });
  });
  ab_smartMerge_(sh, AB_SD_RAIL_LAST_ROW, 1, 1, AB_SD_RAIL_COLS)
    .setValue('Left box = from (min), right box = to (max). Type 20 in a % box for 20%.')
    .setFontColor(U.soft).setFontSize(8).setFontStyle('italic').setHorizontalAlignment('left')
    .setVerticalAlignment('top').setWrap(true);

  // ---- summary cards ----
  AB_SD_CARDS.forEach(function (cd) {
    const c1 = AB_SD_FIRST_RES_COL + cd.from;
    const w = cd.to - cd.from + 1;
    const lab = ab_smartMerge_(sh, AB_SD_CARD_LABEL_ROW, c1, 1, w);
    lab.setValue(cd.label).setBackground(U.card).setFontColor(U.muted).setFontSize(8)
      .setFontWeight('bold').setHorizontalAlignment('center').setVerticalAlignment('bottom');
    const val = ab_smartMerge_(sh, AB_SD_CARD_VALUE_ROW, c1, 1, w);
    val.setBackground(U.card).setFontColor(U.ink).setFontSize(17).setFontWeight('bold')
      .setHorizontalAlignment('center').setVerticalAlignment('middle');
    const box = sh.getRange(AB_SD_CARD_LABEL_ROW, c1, 2, w);
    box.setBorder(true, true, true, true, false, false, '#ffffff', SpreadsheetApp.BorderStyle.SOLID_THICK);
    lab.setBorder(true, null, null, null, null, null, cd.accent, SpreadsheetApp.BorderStyle.SOLID_THICK);
  });

  // ---- results header ----
  const head = sh.getRange(AB_SD_HEADER_ROW, AB_SD_FIRST_RES_COL, 1, nRes);
  head.setValues([AB_SD_RES.map(function (c) { return c.title; })])
    .setBackground(U.navy).setFontColor('#ffffff').setFontWeight('bold').setFontSize(10)
    .setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange(AB_SD_HEADER_ROW, 1, 1, AB_SD_RAIL_COLS).setVerticalAlignment('middle');

  sh.setFrozenRows(AB_SD_HEADER_ROW);
}

/**
 * Builds (or fully rebuilds) the Smart Dashboard tab: filter panel,
 * summary cards, results table. Safe to run again any time - but it
 * redraws the tab from scratch, so any filters you had ticked are reset.
 */
function setupSmartDashboard() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ab_smartSheet_(true);
  const layout = ab_getMainLayout_();
  const header = layout.header;

  // Start from a clean sheet (old layout, merges, dropdowns, colours).
  try { sh.setFrozenRows(0); } catch (e) { /* nothing frozen */ }
  try { sh.setFrozenColumns(0); } catch (e) { /* nothing frozen */ }
  const full = sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns());
  try { full.breakApart(); } catch (e) { /* nothing merged */ }
  full.clear();
  try { full.clearDataValidations(); } catch (e) { /* none */ }
  try { full.clearNote(); } catch (e) { /* none */ }
  sh.clearConditionalFormatRules();

  ab_smartPaint_(sh);
  try { sh.setConditionalFormatRules(ab_smartCfRules_(sh)); }
  catch (cfErr) { Logger.log('Could not apply Smart Dashboard colours: ' + cfErr.message); }

  const missing = [];
  AB_SD_RES.forEach(function (c) {
    if (c.src && ab_smartCol_(header, c.src) === -1) missing.push(c.src);
  });

  buildSmartDashboard_();
  try { ss.setActiveSheet(sh); } catch (e) { /* cosmetic */ }
  ss.toast(missing.length
    ? 'Smart Dashboard ready. Not found in Main (left blank): ' + missing.join(', ')
    : 'Smart Dashboard ready - tick a box and the list updates itself.',
    'Smart Dashboard', 15);
}

/** Menu: rebuild the list from the current panel. */
function runSmartDashboard() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    if (!ab_smartSheet_(false)) { setupSmartDashboard(); return; }
    const s = buildSmartDashboard_();
    ss.toast(s.matched + ' of ' + s.scanned + ' stocks match.', 'Smart Dashboard', 10);
  } catch (e) {
    ss.toast('Smart Dashboard failed: ' + e.message);
  }
}

/** Unticks every box and empties every range/text filter (sort is left alone). */
function ab_smartClearFilters_(sh) {
  AB_SD_TAG_GROUPS.forEach(function (grp) {
    sh.getRange(grp.titleRow + 1, grp.col, AB_SD_TAGS.length, 1).setValue(false);
  });
  sh.getRange(AB_SD_SIGNAL_TITLE_ROW + 1, 1, AB_SD_SIGNALS.length, 1).setValue(false);
  sh.getRange(AB_SD_SIGNAL_TITLE_ROW + 1, 3).clearContent();
  AB_SD_NUM.forEach(function (def, i) {
    const row = ab_smartRangeInputRow_(i);
    sh.getRange(row, 1).clearContent();
    sh.getRange(row, 3).clearContent();
  });
  sh.getRange(AB_SD_PRESET_ROW, 1).setValue(AB_SD_PRESET_NONE);
}

/** Fills the panel with one ready-made screen. Returns false for an unknown name. */
function ab_smartApplyPreset_(sh, name) {
  const p = AB_SD_PRESETS.filter(function (x) { return x.name === name; })[0];
  if (!p) return false;
  ab_smartClearFilters_(sh);
  Object.keys(p.tags || {}).forEach(function (header) {
    const grp = AB_SD_TAG_GROUPS.filter(function (g) { return g.header === header; })[0];
    if (!grp) return;
    p.tags[header].forEach(function (t) {
      const i = AB_SD_TAGS.indexOf(t);
      if (i !== -1) sh.getRange(grp.titleRow + 1 + i, grp.col).setValue(true);
    });
  });
  (p.signal || []).forEach(function (s) {
    const i = AB_SD_SIGNALS.indexOf(s);
    if (i !== -1) sh.getRange(AB_SD_SIGNAL_TITLE_ROW + 1 + i, 1).setValue(true);
  });
  if (p.basic) sh.getRange(AB_SD_SIGNAL_TITLE_ROW + 1, 3).setValue(p.basic);
  Object.keys(p.ranges || {}).forEach(function (key) {
    const i = AB_SD_NUM.map(function (d) { return d.key; }).indexOf(key);
    if (i === -1) return;
    const row = ab_smartRangeInputRow_(i);
    if (p.ranges[key][0] !== null) sh.getRange(row, 1).setValue(p.ranges[key][0]);
    if (p.ranges[key][1] !== null) sh.getRange(row, 3).setValue(p.ranges[key][1]);
  });
  sh.getRange(AB_SD_PRESET_ROW, 1).setValue(name);
  return true;
}

/**
 * Called from onEdit for the Smart Dashboard tab. Only the filter panel
 * (columns A-D) re-screens; edits to the results area are ignored so the
 * table's own writes can't trigger a loop.
 */
function ab_smartOnEdit_(e) {
  const r = e.range, sh = r.getSheet();
  const row = r.getRow(), col = r.getColumn();
  if (col > AB_SD_RAIL_COLS || row < AB_SD_PRESET_ROW || row > AB_SD_RAIL_LAST_ROW) return;

  if (row === AB_SD_PRESET_ROW) {
    const picked = String(r.getValue() || '');
    if (picked === AB_SD_PRESET_NONE || !ab_smartApplyPreset_(sh, picked)) return;
  } else if (row === AB_SD_ACTION_ROW) {
    if (col === 1) {
      if (!ab_smartIsTrue_(r.getValue())) return;
      ab_smartClearFilters_(sh);
      r.setValue(false);
    } else if (col < 3) {
      return;
    } // col 3-4 = sort dropdown: just rebuild
  } else if (row > AB_SD_TREND_BAND_ROW) {
    // any real filter change means the ready-made screen no longer applies
    const p = sh.getRange(AB_SD_PRESET_ROW, 1);
    if (p.getValue() !== AB_SD_PRESET_NONE) p.setValue(AB_SD_PRESET_NONE);
  } else {
    return;
  }
  buildSmartDashboard_();
}

/** Menu: untick everything and show all stocks again. */
function clearSmartDashboardFilters() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ab_smartSheet_(false);
  if (!sh) { ss.toast('No Smart Dashboard tab yet - run Setup first.'); return; }
  ab_smartClearFilters_(sh);
  buildSmartDashboard_();
  ss.toast('Filters cleared.');
}


function writeOHLCSheet_(sheetName, rows) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  sh.clearContents();
  sh.getRange(1, 1, 1, AB_OHLC_HEADERS.length).setValues([AB_OHLC_HEADERS]);
  if (rows.length) {
    sh.getRange(2, 1, rows.length, AB_OHLC_HEADERS.length).setValues(rows);
  }
}

/*****************************************************************
 * LOGGING
 *****************************************************************/
function logRun_(ts, dateUsed, rowCount, status, notes) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AB_LOG_SHEET);
  sh.appendRow([ts, dateUsed, rowCount, status, notes]);
}

/*****************************************************************
 * PATTERN DETECTION - ported verbatim from "Stocktracker main"
 * (updateAllCandlestickPatterns). Same detection logic, same
 * output column (W), just reading this spreadsheet's own tabs.
 *****************************************************************/
/*****************************************************************
 * BULLISH HARAMI + INVERTED HAMMER (2 candles; c1 = red, c2 = green)
 * -----------------------------------------------------------------
 * c1: big red body, at least AB_HIH_C1_BODY_MIN of its High-Low range.
 * c2: small green body (25-50% of c1's body) opening at c1's close
 *     (within AB_HIH_OPEN_TOL) and staying in the lower half of c1's
 *     body; a long upper wick (>= 1.5 x its body) reaching at least
 *     c1's open and at most a little above c1's high (15% of c1's body); almost no lower wick (<= 10% of
 *     its range) and its low never below c1's low (owner's strict rule).
 *     Selling is fading but sellers still capped the high,
 *     so it is a watch signal on its own - the "(confirmed)" tag needs
 *     the NEXT close above c2's high.
 * Candles are {Opn, High, Low, Cls}. Ported 1:1 to web/lib/patterns.js.
 *****************************************************************/
const AB_HIH_C1_BODY_MIN = 0.65;
const AB_HIH_BODY_MIN = 0.25;
const AB_HIH_BODY_MAX = 0.50;
const AB_HIH_OPEN_TOL = 0.005;
const AB_HIH_UPPER_WICK_MIN = 1.5;
const AB_HIH_LOWER_WICK_MAX = 0.10;
const AB_HIH_HIGH_OVER_MAX = 0.15;    // c2's wick may poke above c1's high by this x c1's body

function ab_isHaramiInvHammerPair_(c1, c2) {
  const v = [c1.Opn, c1.High, c1.Low, c1.Cls, c2.Opn, c2.High, c2.Low, c2.Cls];
  if (v.some(function (x) { return typeof x !== 'number' || isNaN(x); })) return false;
  const c1Body = c1.Opn - c1.Cls, c1Range = c1.High - c1.Low;
  const c2Body = c2.Cls - c2.Opn, c2Range = c2.High - c2.Low;
  if (!(c1Body > 0 && c1Range > 0 && c2Body > 0 && c2Range > 0)) return false;   // red, then green
  return (c1Body / c1Range >= AB_HIH_C1_BODY_MIN) &&
    (c2Body >= AB_HIH_BODY_MIN * c1Body) && (c2Body <= AB_HIH_BODY_MAX * c1Body) &&
    (Math.abs(c2.Opn - c1.Cls) <= AB_HIH_OPEN_TOL * c1.Cls) &&
    (c2.Cls <= (c1.Opn + c1.Cls) / 2) &&
    (c2.High - c2.Cls >= AB_HIH_UPPER_WICK_MIN * c2Body) &&
    (c2.High >= c1.Opn) && (c2.High <= c1.High + AB_HIH_HIGH_OVER_MAX * c1Body) &&
    (c2.Opn - c2.Low <= AB_HIH_LOWER_WICK_MAX * c2Range) &&
    (c2.Low >= c1.Low);
}

function updateAllCandlestickPatterns() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet2 = ss.getSheetByName(AB_PATTERN_SHEET);
  const yesterday = ss.getSheetByName('Yesterday');
  const today = ss.getSheetByName('Today');
  const thirdDay = ss.getSheetByName('ThirdDay');
  const day4 = ss.getSheetByName('Day4');

  if (!yesterday || !today) {
    throw new Error('Missing Yesterday or Today sheet');
  }

  function toNum(val) {
    return val ? Number(val) : NaN;
  }

  const LOW_EQUAL_TOL = 0.0125;
  const BODY_SIM_TOL = 0.25;
  const WICK_SIM_TOL = 0.30;
  const REQUIRE_HARAMI_SMALLER = ab_setting_('AB_HARAMI_REQUIRE_SMALLER', true);
  const REQUIRE_ENGULFING_BIGGER = ab_setting_('AB_ENGULFING_REQUIRE_BIGGER', true);
  const BODY_SIZE_THRESHOLD = 0.01;

  // Spring / Spring? thresholds - tunable from the Control Panel sheet
  // (category "Patterns"). Stored there as plain percentages (0.5 means
  // 0.5%), so every use below divides by 100 to get back to the 0-1
  // fraction the comparisons need.
  const springCfg = ab_springCfg_();
  const SPRINGQ_BODY_MIN_PCT = ab_setting_('AB_SPRINGQ_BODY_MIN_PCT', 1.5);
  const SPRINGQ_WICK_MAX_PCT = ab_setting_('AB_SPRINGQ_WICK_MAX_PCT', 25);

  function mapDay(sheet) {
    const data = sheet.getDataRange().getValues();
    const header = data.shift();
    const map = {};
    data.forEach(r => {
      const sym = String(r[header.indexOf('TckrSymb')]).trim().toUpperCase();
      if (!sym) return;
      map[sym] = {
        Opn: toNum(r[header.indexOf('OpnPric')]),
        High: toNum(r[header.indexOf('HghPric')]),
        Low: toNum(r[header.indexOf('LwPric')]),
        Cls: toNum(r[header.indexOf('ClsPric')])
      };
    });
    return map;
  }

  const yMap = mapDay(yesterday);
  const tMap = mapDay(today);
  const thirdDayMap = mapDay(thirdDay);
  const day4Map = mapDay(day4);

  const data = sheet2.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    const symbol = String(data[i][3]).trim().toUpperCase(); // col D
    if (!symbol) continue;

    const yRow = yMap[symbol];
    const tRow = tMap[symbol];
    const thRow = thirdDayMap[symbol];

    let allPatterns = [];

    if (yRow && tRow) {
      let c1Open = yRow.Opn, c1High = yRow.High, c1Low = yRow.Low, c1Close = yRow.Cls;
      let c2Open = tRow.Opn, c2High = tRow.High, c2Low = tRow.Low, c2Close = tRow.Cls;

      if (![c1Open, c1High, c1Low, c1Close, c2Open, c2High, c2Low, c2Close].some(isNaN)) {
        let c1Body = Math.abs(c1Close - c1Open);

        // The Spring test itself lives in ab_isSpringPair_ (shared with the EOD
        // flag log, so both always agree on what a Spring is).
        if (ab_isSpringPair_({ Opn: c1Open, High: c1High, Low: c1Low, Cls: c1Close },
                             { Opn: c2Open, High: c2High, Low: c2Low, Cls: c2Close }, springCfg)) {
          allPatterns.push('Spring');
        }

        const p_cond1 = (c1Close < c1Open);
        const p_cond2 = (c2Open < c1Low);
        const p_cond3 = (c2Close > (c1Open + c1Close) / 2);
        const p_cond4 = (c2Close < c1Open);
        if (p_cond1 && p_cond2 && p_cond3 && p_cond4) allPatterns.push('Piercing');

        const c2Body = Math.abs(c2Close - c2Open);
        const c1LowerWick = Math.min(c1Open, c1Close) - c1Low;
        const c2LowerWick = Math.min(c2Open, c2Close) - c2Low;

        let engulfing = false;
        if (c1Close < c1Open && c2Close > c2Open) {
          const e1 = (c2Open <= c1Close && c2Close >= c1Open);
          const e2 = REQUIRE_ENGULFING_BIGGER ? (c2Body > c1Body) : true;
          if (e1 && e2) { allPatterns.push('Bullish Engulfing'); engulfing = true; }
        }

        if (!engulfing) {
          if (c1Close < c1Open && c2Close > c2Open) {
            const h1 = (c2Open >= c1Close && c2Close <= c1Open);
            const h2 = (c2Low > c1Low);
            const h3 = REQUIRE_HARAMI_SMALLER ? (c2Body < c1Body) : true;
            if (h1 && h2 && h3) allPatterns.push('Bullish Harami');
          }
        }

        if (c1Close < c1Open && c2Close > c2Open) {
          const avgLow = (c1Low + c2Low) / 2 || 1;
          const lowsEqual = Math.abs(c1Low - c2Low) <= avgLow * LOW_EQUAL_TOL;
          const bodiesSimilar = (Math.abs(c1Body - c2Body) <= Math.max(c1Body, c2Body) * BODY_SIM_TOL);
          const wicksSimilar = (Math.abs(c1LowerWick - c2LowerWick) <= Math.max(c1LowerWick, c2LowerWick) * WICK_SIM_TOL);
          const wickPresent = (c1LowerWick > 0 && c2LowerWick > 0);

          if (lowsEqual && bodiesSimilar && wicksSimilar && wickPresent) {
            allPatterns.push('Tweezer Bottoms');
          }
        }
      }
    }

    if (tRow) {
      let open = tRow.Opn, high = tRow.High, low = tRow.Low, close = tRow.Cls;
      if (![open, high, low, close].some(isNaN)) {
        let body = Math.abs(close - open);
        let candleSize = high - low;
        let lowerWick = Math.min(open, close) - low;

        let bigBear = close < open && (body / open >= SPRINGQ_BODY_MIN_PCT / 100);
        let wickSmall = (lowerWick / candleSize) <= SPRINGQ_WICK_MAX_PCT / 100;

        if (bigBear && wickSmall) {
          allPatterns.push('Spring?');
        }
      }
    }

    if (thRow && yRow && tRow) {
      let c1Open = thRow.Opn, c1Low = thRow.Low, c1Close = thRow.Cls;
      let c2Open = yRow.Opn, yLow = yRow.Low, c2Close = yRow.Cls;
      let c3Open = tRow.Opn, tLow = tRow.Low, c3Close = tRow.Cls;

      if (![c1Open, c1Low, c1Close, c2Open, yLow, c2Close, c3Open, tLow, c3Close].some(isNaN)) {
        let c1Body = Math.abs(c1Close - c1Open);
        let c2Body = Math.abs(c2Close - c2Open);
        let c3Body = Math.abs(c3Close - c3Open);

        if (
          c1Close < c1Open && c2Close < c2Open && c3Close < c3Open &&
          c1Body / c1Open >= BODY_SIZE_THRESHOLD &&
          c2Body / c2Open >= BODY_SIZE_THRESHOLD &&
          c3Body / c3Open >= BODY_SIZE_THRESHOLD
        ) {
          if (
            (yLow < c1Low) && (c2Close > c1Low) &&
            (tLow < yLow) && (c3Close > yLow)
          ) {
            allPatterns.push('Three Day Low Rejection');
          }
        }
      }
    }

    if (thRow && yRow && tRow) {
      let c1Open = thRow.Opn, c1High = thRow.High, c1Low = thRow.Low, c1Close = thRow.Cls;
      let c2Open = yRow.Opn, c2High = yRow.High, c2Low = yRow.Low, c2Close = yRow.Cls;
      let c3Open = tRow.Opn, c3High = tRow.High, c3Low = tRow.Low, c3Close = tRow.Cls;

      if (![c1Open, c1High, c1Low, c1Close, c2Open, c2High, c2Low, c2Close, c3Open, c3High, c3Low, c3Close].some(isNaN)) {
        let c1Body = Math.abs(c1Close - c1Open);
        let c2Body = Math.abs(c2Close - c2Open);
        let c3Body = Math.abs(c3Close - c3Open);

        let c1BodyRatio = c1Body / c1Open;
        let c3BodyRatio = c3Body / c3Open;

        let c1LowerWick = Math.min(c1Open, c1Close) - c1Low;
        let c1CandleSize = c1High - c1Low;
        let bigBear = (c1Close < c1Open) && (c1BodyRatio >= 0.02);
        let wickSmall = (c1LowerWick / c1CandleSize) <= 0.3;

        let smallBodyDay2 = (c2Body / c1Body) <= 0.3;

        let bullishDay3 = (c3Close > c3Open) && (c3BodyRatio >= 0.02);
        let c3CloseIntoC1Body = c3Close >= (c1Open + c1Close) / 2;

        if (bigBear && wickSmall && smallBodyDay2 && bullishDay3 && c3CloseIntoC1Body) {
          allPatterns.push('Morningstar');
        }
      }
    }

    if (thRow && yRow && tRow) {
      let c1Open = thRow.Opn, c1High = thRow.High, c1Low = thRow.Low, c1Close = thRow.Cls;
      let c2Open = yRow.Opn, c2High = yRow.High, c2Low = yRow.Low, c2Close = yRow.Cls;
      let c3Open = tRow.Opn, c3High = tRow.High, c3Low = tRow.Low, c3Close = tRow.Cls;

      if (![c1Open, c1High, c1Low, c1Close, c2Open, c2High, c2Low, c2Close, c3Open, c3High, c3Low, c3Close].some(isNaN)) {
        let c1Body = Math.abs(c1Close - c1Open);
        let c1Large = c1Body / c1Open >= 0.03;

        let cond1 = (c1Close < c1Open);
        let cond2 = c1Large;
        let cond3 = (c2Low < c1Low);
        let cond4 = (c2Close > c1Low);
        let cond5 = (Math.abs(c2Close - c2Open) < 0.3 * c1Body);
        let cond6 = (c2Low <= c1Low * (1 - 0.0025));
        let cond7 = (c2High <= c1High + (0.4 * c1Body));

        let c3BreaksBothLows = (c3Low < c2Low) && (c3Low < c1Low);
        let c3ClosesAboveBothLows = (c3Close > c2Low) && (c3Close > c1Low);

        if (
          cond1 && cond2 && cond3 && cond4 && cond5 && cond6 && cond7 &&
          c3BreaksBothLows && c3ClosesAboveBothLows
        ) {
          allPatterns.push('Trio');
        }
      }
    }

    if (day4Map[symbol] && thirdDayMap[symbol] && yMap[symbol] && tMap[symbol]) {
      let c1 = day4Map[symbol];
      let c2 = thirdDayMap[symbol];
      let c3 = yMap[symbol];
      let c4 = tMap[symbol];

      let c1Body = Math.abs(c1.Cls - c1.Opn);
      let c2Body = Math.abs(c2.Cls - c2.Opn);
      let c3Body = Math.abs(c3.Cls - c3.Opn);
      let c4Body = Math.abs(c4.Cls - c4.Opn);

      if (![c1.Opn, c1.Cls, c2.Opn, c2.Low, c2.Cls, c3.High, c3.Low, c3.Opn, c3.Cls, c4.High, c4.Low, c4.Opn, c4.Cls].some(isNaN)) {
        let c1Bullish = c1.Cls > c1.Opn;
        let c1BodyRatio = c1Body / c1.Opn;

        let c2Bullish = c2.Cls > c2.Opn;
        let c2BodyRatio = c2Body / c2.Opn;
        let c2LowerWick = Math.min(c2.Opn, c2.Cls) - c2.Low;
        let c2UpperWick = c2.High - Math.max(c2.Opn, c2.Cls);
        let c2LowerWickAcceptable = c2LowerWick <= 0.01 * c2.Opn;
        let c2UpperWickAcceptable = c2UpperWick <= 0.003 * c2.Cls;

        let fvgGap = c2.Low > c1.Opn;

        let c3Bearish = c3.Cls < c3.Opn;
        let c3BodySimilar = Math.abs(c3Body - c2Body) <= Math.max(c2Body, c3Body) * 0.15;
        let c3HighOkay = c3.High <= c2.High;
        let c3LowOkay = c3.Low >= c2.Low;

        let c4Bullish = c4.Cls > c4.Opn;
        let c4BodyBigger = c4Body > c3Body;
        let c4HighOkay = c4.High <= c2.High;
        let c4LowWithinFVG = (c4.Low >= c1.Opn) && (c4.Low <= c2.Low);

        if (c1Bullish && c1BodyRatio >= 0.02 &&
            c2Bullish && c2BodyRatio >= 0.01 &&
            c2LowerWickAcceptable && c2UpperWickAcceptable &&
            fvgGap &&
            c3Bearish && c3BodySimilar && c3HighOkay && c3LowOkay &&
            c4Bullish && c4BodyBigger && c4HighOkay && c4LowWithinFVG) {
          allPatterns.push('FVG 1234');
        }
      }
    }

    if (thirdDayMap[symbol] && yMap[symbol] && tMap[symbol]) {
      let c1 = thirdDayMap[symbol];
      let c2 = yMap[symbol];
      let c3 = tMap[symbol];

      let c1Body = Math.abs(c1.Cls - c1.Opn);
      let c2Body = Math.abs(c2.Cls - c2.Opn);
      let c3Body = Math.abs(c3.Cls - c3.Opn);

      if (![c1.Opn, c1.Cls, c2.Opn, c2.Cls, c2.Low, c2.High, c3.Opn, c3.Cls, c3.High, c3.Low].some(isNaN)) {
        let c1Bullish = c1.Cls > c1.Opn;
        let c1BodyRatio = c1Body / c1.Opn;

        let c2Bullish = c2.Cls > c2.Opn;
        let c2BodyRatio = c2Body / c2.Opn;
        let c2LowerWick = Math.min(c2.Opn, c2.Cls) - c2.Low;
        let c2UpperWick = c2.High - Math.max(c2.Opn, c2.Cls);
        let c2LowerWickAcceptable = c2LowerWick <= 0.015 * c2.Opn;
        let c2UpperWickAcceptable = c2UpperWick <= 0.03 * c2.Cls;

        let fvgGap = c2.Low > c1.Opn;

        let c3Bearish = c3.Cls < c3.Opn;
        let c3BodySimilar = Math.abs(c3Body - c2Body) <= Math.max(c2Body, c3Body) * 0.50;
        let c3HighOkay = c3.High <= c2.High;
        let c3LowInFVG = (c3.Low >= c1.Opn) && (c3.Low <= c2.Low);
        let c3CloseOK = c3.Cls >= c2.Low;

        if (
          c1Bullish && c1BodyRatio >= 0.02 &&
          c2Bullish && c2BodyRatio >= 0.005 &&
          c2LowerWickAcceptable && c2UpperWickAcceptable && fvgGap &&
          c3Bearish && c3BodySimilar && c3HighOkay && c3LowInFVG && c3CloseOK
        ) {
          allPatterns.push('FVG 123');
        }
      }
    }

    if (thirdDayMap[symbol] && yMap[symbol] && tMap[symbol]) {
      let c1 = thirdDayMap[symbol];
      let c2 = yMap[symbol];
      let c3 = tMap[symbol];

      let c2Body = Math.abs(c2.Cls - c2.Opn);
      let c3Body = Math.abs(c3.Cls - c3.Opn);
      let c1Body = Math.abs(c1.Cls - c1.Opn);

      if (![c1.Opn, c1.Cls, c2.Opn, c2.Cls, c2.Low, c2.High, c3.Opn, c3.Cls, c3.High, c3.Low].some(isNaN)) {
        let c1Bullish = c1.Cls > c1.Opn;
        let c1BodyRatio = c1Body / c1.Opn;

        let c2Bullish = c2.Cls > c2.Opn;
        let c2BodyRatio = c2Body / c2.Opn;
        let c2LowerWick = Math.min(c2.Opn, c2.Cls) - c2.Low;
        let c2UpperWick = c2.High - Math.max(c2.Opn, c2.Cls);
        let c2LowerWickAcceptable = c2LowerWick <= 0.015 * c2.Opn;
        let c2UpperWickAcceptable = c2UpperWick <= 0.03 * c2.Cls;

        let fvgGap = c2.Low > c1.Opn;

        let c3Bearish = c3.Cls > c2.Low;
        let c3BodySimilar = Math.abs(c3Body - c2Body) <= Math.max(c2Body, c3Body) * 0.50;
        let c3LowInFVG = (c3.Low >= c1.Opn) && (c3.Low <= c2.Low);
        let c3CloseOK = c3.Cls >= c2.Low;

        if (
          c1Bullish && c1BodyRatio >= 0.02 &&
          c2Bullish && c2BodyRatio >= 0.005 &&
          c2LowerWickAcceptable && c2UpperWickAcceptable && fvgGap &&
          c3Bearish && c3BodySimilar && c3LowInFVG && c3CloseOK
        ) {
          allPatterns.push('FVG 123 Type 2');
        }
      }
    }

    if (thirdDayMap[symbol] && yMap[symbol] && tMap[symbol]) {
      let c1 = thirdDayMap[symbol];
      let c2 = yMap[symbol];
      let c3 = tMap[symbol];

      let c1Body = Math.abs(c1.Cls - c1.Opn);
      let c2Body = Math.abs(c2.Cls - c2.Opn);

      if (![c1.Opn, c1.Cls, c2.Opn, c2.Cls, c2.High, c2.Low, c3.Opn, c3.Cls, c3.High, c3.Low].some(isNaN)) {
        let c1Bullish = c1.Cls > c1.Opn;
        let c1BodyRatio = c1Body / c1.Opn;

        let c2BodyRatio = c2Body / c2.Opn;
        let c2Indecision = c2BodyRatio <= 0.01;
        let c2LowerWick = Math.min(c2.Opn, c2.Cls) - c2.Low;
        let c2UpperWick = c2.High - Math.max(c2.Opn, c2.Cls);
        let c2LowerWickAcceptable = c2LowerWick <= 0.02 * c2.Opn;
        let c2UpperWickAcceptable = c2UpperWick <= 0.02 * c2.Cls;

        let fvgGap = c2.Low > c1.Opn;

        let c3Bearish = c3.Cls < c3.Opn;
        let c3OpenBelowPrevHigh = c3.Opn < c2.High;
        let c3LowInFVG = (c3.Low >= c1.Opn) && (c3.Low <= c2.Low);
        let c3CloseAboveFVG = c3.Cls >= c2.Low;

        if (
          c1Bullish && c1BodyRatio >= 0.02 &&
          c2Indecision &&
          c2LowerWickAcceptable && c2UpperWickAcceptable &&
          fvgGap &&
          c3Bearish && c3OpenBelowPrevHigh && c3LowInFVG && c3CloseAboveFVG
        ) {
          allPatterns.push('FVGTouch');
        }
      }
    }

    // Bullish Harami + Inverted Hammer: today's pair, and yesterday's pair
    // confirmed by today's close above yesterday's high
    if (yRow && tRow && ab_isHaramiInvHammerPair_(yRow, tRow)) {
      allPatterns.push('Bullish Harami + Inverted Hammer');
    }
    if (thRow && yRow && tRow && ab_isHaramiInvHammerPair_(thRow, yRow) && tRow.Cls > yRow.High) {
      allPatterns.push('Bullish Harami + Inverted Hammer (confirmed)');
    }

    sheet2.getRange(i + 1, AB_COL_W).setValue(allPatterns.join(', '));
  }
}

/*****************************************************************
 * SCREENER - one-step multi-condition filter over Main
 * -----------------------------------------------------------------
 * Instead of opening each column's filter dropdown one at a time,
 * this opens a sidebar where you stack as many conditions as you
 * like (IPO Level = Below AND 21 EMA Support contains Today AND
 * ATR > 40 ...) and hit Apply once. Rows that fail ANY condition
 * are hidden in Main; everything else stays put, so all your
 * formulas, formatting and column positions are untouched.
 *
 * Column choices are read live from Main's header row, so any new
 * column you add shows up in the screener automatically - nothing
 * here is hard-coded to a letter.
 *****************************************************************/

const AB_SCREENER_PRESET_PROP = 'AB_SCREENER_PRESETS';

/** Opens the screener sidebar. */
function showScreener() {
  const html = HtmlService.createHtmlOutput(ab_screenerHtml_())
    .setTitle('Stock Screener')
    .setWidth(360);
  SpreadsheetApp.getUi().showSidebar(html);
}

/*
 * NOTE: the five functions the sidebar calls (abScreenerFields,
 * abScreenerValues, abScreenerApply, abScreenerSavePreset,
 * abScreenerDeletePreset) deliberately do NOT end in an underscore.
 * Apps Script treats a trailing underscore as "private" and
 * google.script.run cannot reach such a function - the call just
 * fails silently.
 */

/** Column list + saved presets, handed to the sidebar on load. */
function abScreenerFields() {
  const layout = ab_getMainLayout_();
  const header = layout.data[layout.headerRowIdx].map(v => String(v).trim());
  const fields = [];
  header.forEach(function (h, i) {
    if (h) fields.push({ col: i, name: h });
  });
  return { fields: fields, presets: ab_getScreenerPresets_() };
}

/*****************************************************************
 * SCREENER VALUE SUGGESTIONS
 * -----------------------------------------------------------------
 * Feeds the value box's dropdown so you can pick from what's actually
 * in a column instead of remembering the exact wording. It's a
 * <datalist>, not a <select>, so typing your own value still works
 * exactly as before - the list only suggests.
 *
 * Tag columns (Pattern, FVG, 10/21 EMA Support) hold comma-joined
 * multi-tags with a recency suffix - e.g.
 *   "FVG First Touch (1d ago), FVG Unmitigated (formed today)"
 * A raw distinct-value list there is useless: nearly every cell is
 * unique. So each cell is broken into
 *   - its individual comma-separated tags, and
 *   - the tag with its "(Today)"/"(3d ago)"/"(formed today)" suffix
 *     stripped off
 * and the results are ranked by how often they occur. The bare tags
 * ("FVG Unmitigated", "10 EMA Support") recur constantly so they sort
 * to the top, which is what you'd usually pair with "contains", while
 * the more specific dated variants remain available further down.
 *****************************************************************/
const AB_SCREENER_MAX_SUGGESTIONS = 300;

/** Splits one cell into the set of strings worth suggesting. */
function ab_screenerTokens_(text) {
  const out = [];
  const seen = {};
  function add(t) {
    t = String(t).trim();
    if (!t || seen[t]) return;
    seen[t] = true;
    out.push(t);
  }

  const hasCommas = text.indexOf(',') !== -1;
  // For a multi-tag cell the whole string is too specific to ever be a
  // useful suggestion - only its parts are.
  if (!hasCommas) add(text);
  const parts = hasCommas ? text.split(',') : [text];

  parts.forEach(function (p) {
    p = p.trim();
    if (!p) return;
    add(p);
    // "... (Today)" / "... (3d ago)" / "... (formed today)" / "... (formed 2d ago)"
    const base = p.replace(/\s*\((?:formed\s+)?(?:today|\d+\s*d\s*ago)\)\s*$/i, '').trim();
    if (base && base !== p) add(base);
  });

  return out;
}

/**
 * Distinct suggestions for one Main column, ranked by frequency.
 * Called from the sidebar whenever you pick a column.
 *
 * Numeric columns return no list - a dropdown of 800 prices helps
 * nobody - but do report their min/max so the box can hint at the
 * range you're filtering within.
 */
function abScreenerValues(colIndex) {
  colIndex = Number(colIndex);
  const empty = { values: [], numeric: false, total: 0 };
  if (isNaN(colIndex) || colIndex < 0) return empty;

  const layout = ab_getMainLayout_();
  const data = layout.data;
  const counts = {};
  let total = 0, numericCount = 0, min = Infinity, max = -Infinity;

  for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
    const sym = ab_cellText_(data[r][layout.symbol]);
    const name = ab_cellText_(data[r][layout.name]);
    if (!sym && !name) break; // end of the watchlist block
    if (!sym) continue;

    const raw = data[r][colIndex];
    const text = ab_cellText_(raw);
    if (!text) continue;
    total++;

    const n = ab_screenerNum_(raw);
    if (!isNaN(n)) {
      numericCount++;
      if (n < min) min = n;
      if (n > max) max = n;
    }

    ab_screenerTokens_(text).forEach(function (tok) {
      counts[tok] = (counts[tok] || 0) + 1;
    });
  }

  // Mostly-numeric column: range hint instead of a picklist. Not 100%,
  // so a stray "N/A" or "-" doesn't turn a price column into a dropdown.
  if (total > 0 && (numericCount / total) >= 0.8) {
    return {
      values: [], numeric: true, total: total,
      min: isFinite(min) ? Math.round(min * 100) / 100 : '',
      max: isFinite(max) ? Math.round(max * 100) / 100 : ''
    };
  }

  const values = Object.keys(counts)
    .sort(function (a, b) { return (counts[b] - counts[a]) || a.localeCompare(b); })
    .slice(0, AB_SCREENER_MAX_SUGGESTIONS);

  return { values: values, numeric: false, total: total };
}

function ab_getScreenerPresets_() {
  const raw = PropertiesService.getDocumentProperties().getProperty(AB_SCREENER_PRESET_PROP);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (err) { return {}; }
}

function abScreenerSavePreset(name, criteria) {
  name = String(name || '').trim();
  if (!name) throw new Error('Give the preset a name.');
  const presets = ab_getScreenerPresets_();
  presets[name] = criteria;
  PropertiesService.getDocumentProperties()
    .setProperty(AB_SCREENER_PRESET_PROP, JSON.stringify(presets));
  return presets;
}

function abScreenerDeletePreset(name) {
  const presets = ab_getScreenerPresets_();
  delete presets[name];
  PropertiesService.getDocumentProperties()
    .setProperty(AB_SCREENER_PRESET_PROP, JSON.stringify(presets));
  return presets;
}

/**
 * Forgiving number parse for the screener only. The shared ab_toNum_
 * is a bare Number(), which returns NaN the moment a cell is stored as
 * TEXT ("1,277.10", "₹1,277", "12%") rather than a real number - and a
 * NaN would silently drop that row from every numeric filter. This
 * strips the usual decorations first so a text-formatted cell still
 * screens correctly.
 */
function ab_screenerNum_(v) {
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  const s = String(v === null || v === undefined ? '' : v)
    .replace(/[₹$,\s]/g, '')
    .replace(/%$/, '')
    .trim();
  if (s === '') return NaN;
  const n = Number(s);
  return isNaN(n) ? NaN : n;
}

/**
 * A condition's values, always as an array. The sidebar now sends
 * `vals` (one entry per chip); `val` is still read as a fallback so
 * presets saved before multi-value existed keep working unchanged.
 */
function ab_criterionValues_(c) {
  if (c && Object.prototype.toString.call(c.vals) === '[object Array]') {
    return c.vals.map(function (v) { return ab_cellText_(v); }).filter(function (v) { return v !== ''; });
  }
  const single = ab_cellText_(c ? c.val : '');
  return single === '' ? [] : [single];
}

/**
 * Tests one cell against one condition.
 *
 * Multiple values within a single condition are OR'd - "FVG contains
 * [FVG Unmitigated] [FVG First Touch]" keeps a row matching either.
 * The negative operators invert that to "matches none of them", which
 * is what you'd actually want from "does not contain A, B".
 * Conditions in different rows are still AND'ed by abScreenerApply.
 */
function ab_matchCriterion_(raw, c) {
  const s = ab_cellText_(raw);
  const op = c.op;
  const vals = ab_criterionValues_(c);

  if (op === 'blank') return s === '';
  if (op === 'notblank') return s !== '';

  // No value typed or picked - treat the condition as "not set" rather
  // than as a filter on the empty string. ("is blank" is the explicit
  // way to ask for empties.)
  if (!vals.length) return true;

  const S = s.toUpperCase();
  if (op === 'contains') {
    return vals.some(function (v) { return S.indexOf(v.toUpperCase()) !== -1; });
  }
  if (op === 'notcontains') {
    return vals.every(function (v) { return S.indexOf(v.toUpperCase()) === -1; });
  }
  if (op === 'equals') {
    return vals.some(function (v) { return S === v.toUpperCase(); });
  }
  if (op === 'notequals') {
    return vals.every(function (v) { return S !== v.toUpperCase(); });
  }

  // numeric comparisons from here down
  const n = ab_screenerNum_(raw);
  if (isNaN(n)) return false;

  if (op === 'between') {
    // Two chips = the two bounds. A single "40,80" (older presets, or
    // typed straight in) still parses the same way it always did.
    let a, b;
    if (vals.length >= 2) {
      a = parseFloat(vals[0]); b = parseFloat(vals[1]);
    } else {
      const parts = vals[0].split(',').map(function (x) { return parseFloat(String(x).trim()); });
      a = parts[0]; b = parts[1];
    }
    if (isNaN(a) || isNaN(b)) return false;
    return n >= Math.min(a, b) && n <= Math.max(a, b);
  }

  // >, >=, <, <= with several numbers stays consistent with the OR rule
  // above, so it resolves to the loosest of them. Normally you'd give
  // just one.
  const nums = vals.map(function (v) { return parseFloat(v); })
                   .filter(function (v) { return !isNaN(v); });
  if (!nums.length) return false;
  if (op === 'gt') return nums.some(function (t) { return n > t; });
  if (op === 'gte') return nums.some(function (t) { return n >= t; });
  if (op === 'lt') return nums.some(function (t) { return n < t; });
  if (op === 'lte') return nums.some(function (t) { return n <= t; });
  return true;
}

/**
 * Applies every condition at once. A row survives only if it passes
 * ALL of them (AND logic). Non-matching rows are hidden, not deleted.
 */
function abScreenerApply(criteria) {
  criteria = criteria || [];
  const layout = ab_getMainLayout_();
  const sh = layout.sheet;
  const data = layout.data;
  const firstDataRow = layout.headerRowIdx + 2; // 1-based first data row
  const lastRow = sh.getLastRow();

  // A native Sheets filter wins over showRows/hideRows - rows it has
  // hidden CANNOT be revealed by the script, so the screener would show
  // a wrong count and look broken. Drop it (the header dropdowns go
  // away; Data > Create a filter puts them back whenever you want).
  const existing = sh.getFilter();
  const hadNativeFilter = !!existing;
  if (existing) existing.remove();

  // always start from a clean slate so conditions don't stack up run over run
  if (lastRow >= firstDataRow) sh.showRows(firstDataRow, lastRow - firstDataRow + 1);
  if (!criteria.length) {
    const n = Math.max(0, data.length - (layout.headerRowIdx + 1));
    return { matched: n, total: n, cleared: true, hadNativeFilter: hadNativeFilter };
  }

  const hide = [];
  let total = 0, matched = 0;

  for (let r = layout.headerRowIdx + 1; r < data.length; r++) {
    const row = data[r];
    const sym = String(row[layout.symbol] || '').trim();
    if (!sym) { hide.push(r + 1); continue; } // padding rows below the data
    total++;

    let ok = true;
    for (let k = 0; k < criteria.length; k++) {
      const c = criteria[k];
      if (c.col === '' || c.col === null || c.col === undefined) continue;
      if (!ab_matchCriterion_(row[Number(c.col)], c)) { ok = false; break; }
    }
    if (ok) matched++; else hide.push(r + 1);
  }

  // hide contiguous blocks in one call each rather than row by row
  let i = 0;
  while (i < hide.length) {
    let j = i;
    while (j + 1 < hide.length && hide[j + 1] === hide[j] + 1) j++;
    sh.hideRows(hide[i], hide[j] - hide[i] + 1);
    i = j + 1;
  }

  return { matched: matched, total: total, cleared: false, hadNativeFilter: hadNativeFilter };
}

/** Unhides everything in Main. Also on the menu for when the sidebar is closed. */
function clearScreenerFilter() {
  const layout = ab_getMainLayout_();
  const sh = layout.sheet;
  const firstDataRow = layout.headerRowIdx + 2;
  const lastRow = sh.getLastRow();
  const existing = sh.getFilter();
  if (existing) existing.remove(); // same reason as in abScreenerApply
  if (lastRow >= firstDataRow) sh.showRows(firstDataRow, lastRow - firstDataRow + 1);
  return { matched: 0, total: 0, cleared: true };
}

/** Sidebar markup. Kept as one string so the script stays a single file. */
function ab_screenerHtml_() {
  return '' +
'<!DOCTYPE html><html><head><base target="_top"><style>' +
'body{font-family:Arial,Helvetica,sans-serif;font-size:12px;margin:8px;color:#202124}' +
'h3{margin:0 0 8px;font-size:13px}' +
'.row{border:1px solid #dadce0;border-radius:6px;padding:6px;margin-bottom:6px;background:#f8f9fa}' +
'select,input{display:block;width:100%;box-sizing:border-box;padding:4px;margin-top:3px;' +
'font-size:12px;border:1px solid #dadce0;border-radius:4px;height:26px}' +
'.row select,.row input{clear:both}' +
'.x{float:right;color:#d93025;cursor:pointer;font-weight:bold;padding:0 3px}' +
'button{padding:7px 10px;font-size:12px;border-radius:4px;border:1px solid #dadce0;' +
'background:#fff;cursor:pointer;margin-right:4px;margin-top:4px}' +
'button.p{background:#1a73e8;color:#fff;border-color:#1a73e8}' +
'#count{margin-top:8px;padding:7px;background:#e8f0fe;border-radius:4px;font-weight:bold;' +
'text-align:center;white-space:pre-line}' +
'hr{border:none;border-top:1px solid #dadce0;margin:10px 0}' +
'.lbl{font-size:11px;color:#5f6368}' +
'.chips{margin-top:4px}' +
'.chip{display:inline-block;background:#e8f0fe;border:1px solid #c6dafc;border-radius:10px;' +
'padding:1px 4px 1px 8px;font-size:11px;color:#1a3d7c;margin:0 3px 3px 0;max-width:100%;' +
'overflow-wrap:anywhere}' +
'.chip b{cursor:pointer;color:#d93025;margin-left:5px;font-weight:700}' +
'.hint{font-size:11px;color:#5f6368;margin:-4px 0 8px}' +
'</style></head><body>' +
'<h3>Conditions (all must match)</h3>' +
'<div class="hint">Pick or type a value, then Enter. Several values in one ' +
'box match ANY of them.</div>' +
'<div id="rows"></div>' +
'<button onclick="addRow()">+ Add condition</button>' +
'<hr>' +
'<button class="p" onclick="apply()">Apply Filter</button>' +
'<button onclick="clearAll()">Show All</button>' +
'<div id="count"></div>' +
'<hr>' +
'<div class="lbl">Presets</div>' +
'<select id="preset" onchange="loadPreset()"><option value="">-- pick a preset --</option></select>' +
'<input id="pname" placeholder="name to save as">' +
'<button onclick="savePreset()">Save</button>' +
'<button onclick="delPreset()">Delete</button>' +
'<script>' +
'var FIELDS=[],PRESETS={},VALCACHE={},UID=0;' +
'var OPS=[["contains","contains"],["notcontains","does not contain"],["equals","is exactly"],' +
'["notequals","is not"],["notblank","is not blank"],["blank","is blank"],' +
'["gt","greater than"],["gte","greater or equal"],["lt","less than"],["lte","less or equal"],' +
'["between","between (a,b)"]];' +
'google.script.run.withSuccessHandler(init).withFailureHandler(err).abScreenerFields();' +
'function init(d){FIELDS=d.fields||[];PRESETS=d.presets||{};refreshPresets();addRow();' +
'if(!FIELDS.length){document.getElementById("count").innerText=' +
'"No columns found - could not read Main\'s header row.";}}' +
'function refreshPresets(){var s=document.getElementById("preset");' +
's.innerHTML="<option value=\\"\\">-- pick a preset --</option>";' +
'for(var k in PRESETS){var o=document.createElement("option");o.value=k;o.text=k;s.add(o);}}' +
'function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;")' +
'.replace(/>/g,"&gt;").replace(/\\"/g,"&quot;");}' +
'function addRow(col,op,val){var d=document.createElement("div");d.className="row";' +
'var uid="dl"+(UID++);' +
'var f="<span class=\\"x\\" onclick=\\"this.parentNode.remove()\\">x</span>";' +
'f+="<select class=\\"c\\" onchange=\\"loadValues(this)\\">";' +
'for(var i=0;i<FIELDS.length;i++){f+="<option value=\\""+FIELDS[i].col+"\\""+' +
'(String(FIELDS[i].col)===String(col)?" selected":"")+">"+esc(FIELDS[i].name)+"</option>";}' +
'f+="</select><select class=\\"o\\">";' +
'for(var j=0;j<OPS.length;j++){f+="<option value=\\""+OPS[j][0]+"\\""+' +
'(OPS[j][0]===op?" selected":"")+">"+OPS[j][1]+"</option>";}' +
'f+="</select><input class=\\"v\\" list=\\""+uid+"\\" autocomplete=\\"off\\" ' +
'placeholder=\\"value\\">";' +
'f+="<datalist id=\\""+uid+"\\"></datalist><div class=\\"chips\\"></div>";' +
'd.innerHTML=f;document.getElementById("rows").appendChild(d);' +
// Restore saved values as chips. Presets written before multi-value
// existed store a plain string, which becomes a single chip.
'var seed=(Object.prototype.toString.call(val)==="[object Array]")?val:(val?[val]:[]);' +
'for(var q=0;q<seed.length;q++)addChip(d,seed[q]);' +
'var inp=d.querySelector(".v");' +
// "change" covers both picking from the dropdown and clicking away
// after typing - so hitting Apply straight after typing still counts
// the value (blur fires before the button click).
'inp.addEventListener("change",function(){addChip(d,this.value);this.value="";});' +
'inp.addEventListener("keydown",function(ev){' +
'if(ev.key==="Enter"){ev.preventDefault();addChip(d,this.value);this.value="";}' +
'else if(ev.key==="Backspace"&&this.value===""){' +
'var cs=d.querySelectorAll(".chip");if(cs.length)cs[cs.length-1].remove();}});' +
'loadValues(d.querySelector(".c"));}' +
'function addChip(row,text){text=String(text==null?"":text).trim();if(!text)return;' +
'var have=chipValues(row);' +
'for(var i=0;i<have.length;i++)if(have[i].toUpperCase()===text.toUpperCase())return;' +
'var s=document.createElement("span");s.className="chip";s.setAttribute("data-v",text);' +
's.innerHTML=esc(text)+"<b onclick=\\"this.parentNode.remove()\\">x</b>";' +
'row.querySelector(".chips").appendChild(s);}' +
'function chipValues(row){var out=[],cs=row.querySelectorAll(".chip");' +
'for(var i=0;i<cs.length;i++)out.push(cs[i].getAttribute("data-v"));return out;}' +
// Pulls the distinct values for the chosen column and hangs them off
// the row's own <datalist>. Cached per column so re-picking is instant
// and we don't re-scan ~840 rows on every dropdown change.
'function loadValues(sel){if(!sel)return;var row=sel.parentNode;' +
'var col=sel.value,inp=row.querySelector(".v"),dl=row.querySelector("datalist");' +
'if(col===""||col===null||col===undefined)return;' +
'if(VALCACHE[col]){fillList(dl,inp,VALCACHE[col]);return;}' +
'inp.placeholder="loading options...";' +
'google.script.run.withSuccessHandler(function(d){VALCACHE[col]=d;fillList(dl,inp,d);})' +
'.withFailureHandler(function(){inp.placeholder="value";}).abScreenerValues(col);}' +
'function fillList(dl,inp,d){dl.innerHTML="";' +
'if(d&&d.numeric){inp.placeholder=(d.min!==""&&d.min!==undefined)?' +
'("number ("+d.min+" to "+d.max+")"):"number";return;}' +
'var vals=(d&&d.values)||[];' +
'for(var i=0;i<vals.length;i++){var o=document.createElement("option");' +
'o.value=vals[i];dl.appendChild(o);}' +
'inp.placeholder=vals.length?("type or pick ("+vals.length+")"):"value";}' +
'function gather(){var out=[],rs=document.querySelectorAll("#rows .row");' +
'for(var i=0;i<rs.length;i++){var row=rs[i];var vals=chipValues(row);' +
// Safety net: text still sitting in the box that never became a chip
// (e.g. Enter not pressed and no blur) is counted anyway.
'var left=row.querySelector(".v").value.trim();' +
'if(left){var dup=false;' +
'for(var k=0;k<vals.length;k++)if(vals[k].toUpperCase()===left.toUpperCase())dup=true;' +
'if(!dup)vals.push(left);}' +
'out.push({col:row.querySelector(".c").value,op:row.querySelector(".o").value,' +
'vals:vals,val:vals.join(", ")});}return out;}' +
'function apply(){document.getElementById("count").innerText="Filtering...";' +
'google.script.run.withSuccessHandler(done).withFailureHandler(err).abScreenerApply(gather());}' +
'function clearAll(){document.getElementById("rows").innerHTML="";addRow();' +
'google.script.run.withSuccessHandler(function(){document.getElementById("count").innerText=' +
'"Filter cleared - all rows visible";}).clearScreenerFilter();}' +
'function done(r){var t=r.cleared?"Filter cleared - all rows visible":' +
'(r.matched+" of "+r.total+" stocks match");' +
'if(r.hadNativeFilter)t+="\\n(removed the old column filter - Data > Create a filter restores it)";' +
'document.getElementById("count").innerText=t;}' +
'function err(e){document.getElementById("count").innerText="Error: "+e.message;}' +
'function savePreset(){var n=document.getElementById("pname").value;if(!n){alert("Name it first");return;}' +
'google.script.run.withSuccessHandler(function(p){PRESETS=p;refreshPresets();' +
'document.getElementById("pname").value="";alert("Saved: "+n);})' +
'.withFailureHandler(err).abScreenerSavePreset(n,gather());}' +
'function delPreset(){var n=document.getElementById("preset").value;if(!n){alert("Pick one first");return;}' +
'google.script.run.withSuccessHandler(function(p){PRESETS=p;refreshPresets();})' +
'.withFailureHandler(err).abScreenerDeletePreset(n);}' +
'function loadPreset(){var n=document.getElementById("preset").value;if(!n)return;' +
'var c=PRESETS[n]||[];document.getElementById("rows").innerHTML="";' +
// prefer the chip array; fall back to the old single-string format
'for(var i=0;i<c.length;i++)addRow(c[i].col,c[i].op,c[i].vals||c[i].val);}' +
'<\/script></body></html>';
}