/*****************************************************************
 * AUTO OHLC + PATTERN ENGINE - part 2 of 2 (Code2.gs)
 * -----------------------------------------------------------------
 * The Apps Script editor cuts a file at 1,000,000 characters, so the
 * code is in two files of the SAME project: Code.gs (part 1) and this
 * one. They share one global scope; Apps Script runs the top-level
 * code of the files in the order the editor lists them - Code.gs
 * first, then Code2.gs - so nothing at the top level of Code.gs may
 * call a function of this file (tests/codegs-files.test.js checks the
 * sizes, duplicate names and the load order).
 *****************************************************************/

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
  'Screener Latest Quarter', 'Checks', 'First Checked', 'Last Checked', 'Updated At', 'Note', 'Source'];
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
      note: String(v[10] || ''),
      // where Main's figures came from: 'screener.in', 'moneycontrol' (provisional), '' = before this column
      source: String(v[11] || '').trim()
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
              String(t.checks || 0), t.first || '', t.last || '', t.updatedAt || '', t.note || '', t.source || '']);
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
      return [t.status === 'Updated' ? (t.source === AB_MC_SOURCE ? '#e3eefc' : '#d9f2e3') : t.status === 'Pending' ? '#fff4d6' : '#eeeeee'];
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
                   latest: '', checks: 0, first: '', last: '', updatedAt: '', note: '', source: '' };
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
  //    Rows filled from moneycontrol are checked too (within the wait
  //    window), so screener.in's figures replace them once it catches up.
  const mcOn = ab_mcOn_();
  const isProvisional = function (t) { return t.status === 'Updated' && t.source === AB_MC_SOURCE; };
  const cands = tr.list.filter(function (t) {
    const prov = isProvisional(t);
    if (t.status !== 'Pending' && !prov) return false;
    if (prov && (!t.rdKey || ab_rsDaysBetween_(t.rdKey, todayKey) > AB_RS_MAX_WAIT_DAYS)) return false;
    if (!rowsBySym[t.symbol]) { if (!prov) t.note = 'Symbol not found in Main'; return false; }
    // PC hasn't delivered it yet (screener.in page, or moneycontrol figures for a Pending row)
    if (AB_BRIDGE_ONLY && !ab_bridgeGet_(t.symbol) && (prov || !mcOn || !ab_mcGet_(t.symbol))) return false;
    if (t.rdKey && ab_rsDaysBetween_(t.rdKey, todayKey) < 0) return false;
    if (ab_rsParseTs_(t.last) < runStartFloor) return true;
    // A continuation also gives anything screener refused earlier in this
    // run one more go (continuations are capped, so this can't loop).
    return !!isContinuation && /^Could not read screener/.test(t.note || '');
  }).sort(function (a, b) { return a.rdKey < b.rdKey ? -1 : a.rdKey > b.rdKey ? 1 : 0; });

  const res = { checked: 0, failed: 0, retried: 0, recovered: 0, updatedNow: [], viaMc: [], replacedMc: [],
                throttled: false, outOfTime: false };
  let transportFails = 0;

  // One fetch + verdict for one company. Returns 'ok' (got a readable
  // page - updated, or screener still on an older quarter), 'transport'
  // (screener/network refused the request - worth retrying shortly), or
  // 'error' (page came back but unusable).
  const processOne = function (t, label) {
    const prov = isProvisional(t);
    const combined = ab_qt_fetchOne_(t.symbol);
    const stamp = nowStr();
    t.checks = (Number(t.checks) || 0) + 1;
    if (!t.first) t.first = stamp;
    t.last = stamp;
    let outcome = 'ok';
    const ei = ab_rsQuarterIndex_(t.quarter);
    // A straggler from the PREVIOUS season (e.g. a delayed Sep result
    // landing after the Dec season has started) still gets its figures
    // written, but no tick - ticks belong to the current season.
    const tickIt = isNaN(seasonIdx) || ei >= seasonIdx;
    let why = '';   // why screener.in could not be used (yet)

    if (!combined.quarterOk || !combined.growth) {
      const err = combined.quarterError || combined.tagsError || 'no data';
      outcome = (AB_QT_SKIP_RETRY_ON.test(err) || /HTTP 429|HTTP 5\d\d/.test(err)) ? 'transport' : 'error';
      why = 'Could not read screener (' + err + ')';
    } else {
      const latest = combined.growth.latestQuarter || '';
      t.latest = latest;
      const li = ab_rsQuarterIndex_(latest);
      if (isNaN(li) || isNaN(ei)) {
        why = 'Unrecognised quarter label "' + latest + '"';
      } else if (li < ei) {
        why = 'Screener still shows ' + latest;
      } else {
        // Screener has the quarter we're waiting for - write it and tick.
        rowsBySym[t.symbol].forEach(function (rowIdx) {
          ab_qt_writeRow_(layout, cols, rowIdx, combined);
          if (tickIt) layout.sheet.getRange(rowIdx + 1, layout.qrCheckbox + 1).setValue(true);
          if (prov) ab_mcMarkRow_(layout, rowIdx, '');
        });
        const notes = [];
        const basis = combined.growth.basis || '';
        if (basis && basis.indexOf('Consolidated') === -1) notes.push(basis + ' figures');
        if (!combined.tagsOk) notes.push('trend tags unavailable (' + combined.tagsError + ')');
        if (combined.growth.shortHistory) notes.push('under a year of history - no YoY');
        if (prov) {
          // Replaces the moneycontrol figures quietly - the company was already reported as updated.
          notes.push('screener.in figures replaced the moneycontrol ones on ' + stamp);
          res.replacedMc.push(t.symbol);
        } else {
          t.status = 'Updated';
          t.updatedAt = stamp;
          res.updatedNow.push(t.symbol);
        }
        t.source = 'screener.in';
        t.note = notes.join('; ');
      }
    }

    if (why && prov) {
      // Still on the moneycontrol figures - nothing to retry until the next run.
      outcome = 'ok';
      t.note = 'moneycontrol figures - ' + why + '; screener.in replaces them when it shows ' + t.quarter;
    } else if (why) {
      t.note = why + ' - will retry';
      // First figures from moneycontrol, when it already has the quarter.
      const mcEntry = mcOn ? ab_mcGet_(t.symbol) : null;
      const mcRes = mcEntry ? ab_mcCombined_(mcEntry) : null;
      const mli = mcRes ? ab_rsQuarterIndex_(mcRes.growth.latestQuarter) : NaN;
      if (mcRes && !isNaN(mli) && !isNaN(ei) && mli >= ei) {
        const fetched = Utilities.formatDate(new Date(mcEntry.at), AB_TZ, AB_RS_TS_FMT);
        const mark = AB_MC_NOTE_PREFIX + ' for ' + mcRes.growth.latestQuarter + ' (' + mcEntry.data.basis + ', read ' + fetched +
          '). screener.in replaces them when it shows ' + t.quarter + '. Trend tags (OPM, promoter, FII) are still from the earlier screener.in update.';
        rowsBySym[t.symbol].forEach(function (rowIdx) {
          ab_qt_writeRow_(layout, cols, rowIdx, mcRes);
          if (tickIt) layout.sheet.getRange(rowIdx + 1, layout.qrCheckbox + 1).setValue(true);
          ab_mcMarkRow_(layout, rowIdx, mark);
        });
        t.status = 'Updated';
        t.updatedAt = stamp;
        t.source = AB_MC_SOURCE;
        const notes = ['moneycontrol figures (' + mcEntry.data.basis + ') - ' + why +
                       '; screener.in replaces them when it shows ' + t.quarter, 'trend tags wait for screener.in'];
        if (mcRes.growth.shortHistory) notes.push('under a year of history - no YoY');
        t.note = notes.join('; ');
        res.updatedNow.push(t.symbol);
        res.viaMc.push(t.symbol);
        outcome = 'ok';
      } else if (mcRes && mcRes.growth.latestQuarter) {
        t.note += ' (moneycontrol shows ' + mcRes.growth.latestQuarter + ')';
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
  cont.viaMc = (cont.viaMc || 0) + res.viaMc.length;
  cont.replacedMc = (cont.replacedMc || 0) + res.replacedMc.length;
  cont.replacedSyms = (cont.replacedSyms || []).concat(res.replacedMc);   // for the email (across continuations)
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
    startedAt: startedAt, replaced: cont.replacedSyms || [],
    // An automatic retry only emails if it actually got something through.
    quietUnlessUpdated: /^Retry/.test(cont.slot || '')
  });
  if (cont.viaMc || cont.replacedMc) {
    summary.text += ' moneycontrol: ' + cont.viaMc + ' filled first from moneycontrol, ' + cont.replacedMc + ' replaced by screener.in.';
  }
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
  // moneycontrol figures replaced by screener.in's in this run: a section of their own (the final figures),
  // so they are not listed again under "Updated in Main today"
  const replacedSet = {};
  (ctx.replaced || []).forEach(function (s) { replacedSet[s] = true; });
  const byNewest = function (a, b) {
    if (a.rdKey !== b.rdKey) return !a.rdKey ? 1 : !b.rdKey ? -1 : (a.rdKey < b.rdKey ? 1 : -1);
    return a.symbol < b.symbol ? -1 : 1;
  };
  const replaced = list.filter(function (t) { return replacedSet[t.symbol] && ctx.rowsBySym[t.symbol]; }).sort(byNewest);
  const updatedShown = updatedToday.filter(function (t) { return !replacedSet[t.symbol]; });
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
  const textSummary = updatedToday.length + ' updated today, ' +
    (replaced.length ? replaced.length + ' moved from moneycontrol to screener.in figures, ' : '') + waiting.length + ' waiting on screener, ' +
    upcoming.length + ' due in the next ' + AB_RS_UPCOMING_DAYS + ' days (' + ctx.checked + ' checked this run' +
    (ctx.failed ? ', ' + ctx.failed + ' fetch failures' : '') + ').';

  const newThisRun = updatedToday.filter(function (t) { return ab_rsParseTs_(t.updatedAt) >= ctx.runStartFloor; }).length;
  if (ctx.quietUnlessUpdated && !newThisRun && !replaced.length) {
    Logger.log('Results Day retry: nothing new got through - no email sent.');
    return { updatedToday: updatedToday.length, text: textSummary + ' Retry run - nothing new, no email sent.' };
  }
  if (!updatedToday.length && !replaced.length && !waiting.length && !upcoming.length && !gaveUp.length) {
    Logger.log('Results Day: nothing to report - no email sent.');
    return { updatedToday: 0, text: textSummary + ' Nothing to report - no email sent.' };
  }

  // TTM Signal / Upside are formulas that recalculate AFTER the new results are written - wait for them.
  let calcNote = '';
  const freshSyms = ctx.reportDayKey ? [] : updatedToday.filter(function (t) {
    return ab_rsParseTs_(t.updatedAt) >= ctx.runStartFloor && !replacedSet[t.symbol];
  }).map(function (t) { return t.symbol; }).concat(replaced.map(function (t) { return t.symbol; }));
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
        (replacedSet[s] ? '<br>' + pill('SCREENER.IN FIGURES', '#ffffff', AB_C_POS)
          : isNew ? '<br>' + pill('NEW', '#ffffff', AB_C_POS) : '') +
        (t.source === AB_MC_SOURCE ? '<br>' + pill('VIA MONEYCONTROL', '#1d4ed8', '#e3eefc') : '') + '</td>' +
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
  const buildReplaced = function () {
    if (!replaced.length) return '';
    let s = h3('Now with screener.in figures (they replace the moneycontrol ones)', replaced.length, AB_C_POS) + updatedHead;
    replaced.forEach(function (t) { s += updatedRow(t); });
    return s + '</table><div style="color:' + FAINT + ';font-size:12px;margin-top:4px">These were filled first from moneycontrol; ' +
      'screener.in now shows the quarter, so Main has its figures - TTM EPS, TTM Signal, Upside and the trend tags included.</div>';
  };
  const buildUpdated = function (limit) {
    if (!updatedShown.length) {
      return h3('Updated in Main ' + updWhen, 0, AB_C_POS) +
        '<div style="color:' + FAINT + ';font-size:13px">None yet ' + updWhen + '.</div>';
    }
    const shown = updatedShown.slice(0, limit);
    let s = h3('Updated in Main ' + updWhen, updatedShown.length, AB_C_POS) + updatedHead;
    shown.forEach(function (t) { s += updatedRow(t); });
    s += '</table>';
    if (updatedShown.length > shown.length) {
      s += '<div style="color:' + FAINT + ';font-size:12px;margin-top:6px">+' + (updatedShown.length - shown.length) +
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
      'the Checkbox stays unticked until screener' + (ab_mcOn_() ? ' (or, first, moneycontrol - read by the PC program)' : '') +
      ' shows the expected quarter. Re-checked every run for up to ' +
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
           ';border-radius:14px;padding:22px 18px">' + head + buildReplaced() + buildUpdated(updLimit) +
           buildWaiting(compactWaiting) + gaveUpHtml + buildUpcoming(compactUpcoming) + footer + '</div></div>';
  };
  // Shrink order: upcoming list first, then the waiting list, then (last
  // resort) trim the updated table - the figures you most want stay full.
  let html = assemble(updatedShown.length, false, false);
  if (html.length > AB_RS_MAX_HTML_CHARS) html = assemble(updatedShown.length, true, false);
  if (html.length > AB_RS_MAX_HTML_CHARS) html = assemble(updatedShown.length, true, true);
  let lim = updatedShown.length;
  while (html.length > AB_RS_MAX_HTML_CHARS && lim > 10) {
    lim = Math.floor(lim * 0.7);
    html = assemble(lim, true, true);
  }

  // Plain-text version.
  let text = 'Results Day Update - ' + ctx.slot + ' - ' + ts + ' IST\n' + textSummary + '\n\n';
  const textLine = function (t) {
    const s = t.symbol;
    const pfT = (ctx.perf || {})[s + '|' + String(t.quarter).toUpperCase()];
    return '  ' + s + ' (result ' + ab_rsKeyToDmy_(t.rdKey) + '): Day ' + (cell(s, layout.pctChange) || '-') +
      (pfT && typeof pfT.sincePct === 'number' && !isNaN(pfT.sincePct) ? ' | Since result ' + (pfT.sincePct * 100).toFixed(2) + '%' : '') + ' | Rev QoQ ' + (cell(s, layout.qoqRev) || '-') +
      ' YoY ' + (cell(s, layout.yoyRev) || '-') + ' | NP QoQ ' + (cell(s, layout.qoqNp) || '-') + ' YoY ' + (cell(s, layout.yoyNp) || '-') +
      ' | OPM ' + (cell(s, cols.opmQoQ) || '-') + '/' + (cell(s, cols.opmYoY) || '-') +
      ' | TTM Signal ' + (cell(s, layout.ttmSignal) || '-') + ' | Upside ' + (cell(s, layout.upsidePotential) || '-') + '\n';
  };
  if (replaced.length) {
    text += 'NOW WITH SCREENER.IN FIGURES - THEY REPLACE THE MONEYCONTROL ONES (' + replaced.length + ')\n';
    replaced.forEach(function (t) { text += textLine(t); });
    text += '\n';
  }
  text += 'UPDATED IN MAIN TODAY (' + updatedShown.length + ')\n';
  updatedShown.forEach(function (t) { text += textLine(t); });
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

  const subject = 'Results Update - ' + updatedShown.length + ' updated in Main, ' +
    (replaced.length ? replaced.length + ' now with screener.in figures, ' : '') + waiting.length +
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
  const hist = ab_readHistoryMerged_();   // History30 + History60's older days (results up to ~60 sessions back)
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
 * IPO TRACKER  (NSE mainboard IPOs - filled by the PC bridge)
 * -----------------------------------------------------------------
 * NSE does not answer Google's servers, so the PC bridge
 * (screener_bridge.py) reads NSE's IPO lists (Market Data > IPO:
 * Current, Past Issues, Upcoming Issues) at every run and posts them
 * to doPost action 'ipos' (ab_ipotFromBridge_). The "IPO Tracker" tab
 * is rebuilt each time with three sections:
 *   Open now                  - open for subscription today
 *   Closed - awaiting listing - closed, not listed yet
 *   Upcoming                  - opens on a later day
 * Only equity mainboard issues are kept: SME issues and debt / other
 * issues (NCDs, bonds, units - anything NSE does not type EQ) are left
 * out. The first update of each day (IST) also sends one short email
 * (Control Panel: AB_IPOT_EMAIL). Subscription figures are not read.
 * Dates come from the PC as yyyy-mm-dd.
 *****************************************************************/
const AB_IPOT_SHEET = 'IPO Tracker';
const AB_IPOT_EMAIL = ab_setting_('AB_IPOT_EMAIL', true);
const AB_IPOT_EMAIL_DAY_PROP = 'AB_IPOT_EMAIL_DAY';
const AB_IPOT_CLOSED_MAX_DAYS = 30;   // closed longer ago than this and never listed = withdrawn / stale, not shown
const AB_IPOT_HEADERS_ = ['Company', 'Symbol', 'Opens', 'Closes', 'Listing date', 'Price range', 'Issue size (shares)', 'Note'];
const AB_IPOT_MON_ = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function ab_ipotIso_(v) { const m = String(v || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? m[0] : ''; }
/** yyyy-mm-dd -> a Date at midnight (for sheet cells), '' when empty. */
function ab_ipotCell_(iso) { if (!iso) return ''; const p = iso.split('-'); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); }
/** yyyy-mm-dd -> "27-Oct". */
function ab_ipotShort_(iso) { if (!iso) return '-'; const p = iso.split('-'); return p[2] + '-' + AB_IPOT_MON_[Number(p[1]) - 1]; }
function ab_ipotDays_(fromIso, toIso) {
  const a = fromIso.split('-'), b = toIso.split('-');
  return Math.round((Date.UTC(+b[0], +b[1] - 1, +b[2]) - Date.UTC(+a[0], +a[1] - 1, +a[2])) / 864e5);
}
function ab_ipotIsSme_(type) { const t = String(type || '').trim(); return /SME|EMERGE/i.test(t) || /^(SM|ST)$/i.test(t); }
/**
 * 'main' (equity mainboard), 'sme', or 'other' (debt: NCDs / bonds, REIT / InvIT units...).
 * NSE types an equity issue EQ. With no type, a symbol ending in digits and a single price
 * (no "x to y" range) is a debt issue (e.g. SMCG04 at Rs.1,000).
 */
function ab_ipotKind_(rec) {
  const t = String(rec.type || '').trim();
  if (ab_ipotIsSme_(t)) return 'sme';
  if (t) return /^(EQ|EQUITY|MAIN ?BOARD)$/i.test(t) ? 'main' : 'other';
  return /\d{2}$/.test(rec.symbol || '') && !/ to /i.test(rec.price || '') ? 'other' : 'main';
}
function ab_ipotPrice_(v) { return String(v || '').replace(/Rs\.?\s*/gi, '₹').replace(/\s+/g, ' ').trim(); }

/**
 * NSE records from the PC -> { open, closed, upcoming, sme } (mainboard only, one row per issue).
 * records: [{ list: 'current'|'past'|'upcoming', company, symbol, type, start, end, listing, price, size }].
 */
function ab_ipotClassify_(records, todayIso) {
  const best = {}, sme = {}, other = {};
  (Array.isArray(records) ? records : []).forEach(function (r) {
    if (!r || typeof r !== 'object') return;
    const rec = { list: String(r.list || ''), company: String(r.company || '').trim(), symbol: String(r.symbol || '').trim().toUpperCase(),
      type: String(r.type || '').trim(), start: ab_ipotIso_(r.start), end: ab_ipotIso_(r.end), listing: ab_ipotIso_(r.listing),
      price: ab_ipotPrice_(r.price), size: String(r.size || '').trim() };
    if (!rec.company && !rec.symbol) return;
    const k = rec.symbol || rec.company.toLowerCase();
    const kind = ab_ipotKind_(rec);
    if (kind === 'sme') { sme[k] = true; return; }
    if (kind === 'other') { other[k] = true; return; }
    const cur = best[k];
    if (!cur) { best[k] = rec; return; }
    Object.keys(rec).forEach(function (f) { if (!cur[f] && rec[f]) cur[f] = rec[f]; });   // same issue in two lists
  });
  const out = { open: [], closed: [], upcoming: [], sme: Object.keys(sme).length, other: Object.keys(other).length };
  Object.keys(best).forEach(function (k) {
    const r = best[k];
    if (r.listing && r.listing < todayIso) return;                      // listed already
    if (r.start && r.start > todayIso) out.upcoming.push(r);
    else if (r.end && r.end >= todayIso) (r.list === 'upcoming' && !r.start ? out.upcoming : out.open).push(r);
    else if (r.end) { if (r.listing || ab_ipotDays_(r.end, todayIso) <= AB_IPOT_CLOSED_MAX_DAYS) out.closed.push(r); }
    else if (r.list === 'upcoming') out.upcoming.push(r);             // dates not announced yet
    else if (r.list === 'current') out.open.push(r);
  });
  const by = function (f, g) {
    return function (a, b) { return (a[f] || '9999') < (b[f] || '9999') ? -1 : (a[f] || '9999') > (b[f] || '9999') ? 1 :
      (a[g] || '9999') < (b[g] || '9999') ? -1 : (a[g] || '9999') > (b[g] || '9999') ? 1 : a.company < b.company ? -1 : 1; };
  };
  out.open.sort(by('end', 'start'));
  out.closed.sort(by('listing', 'end'));
  out.upcoming.sort(by('start', 'end'));
  return out;
}

/** One line about where the issue stands, e.g. "Closes in 2 days", "Lists on 30-Oct". */
function ab_ipotNote_(section, r, todayIso) {
  const days = function (n, word) { return n === 0 ? word + ' today' : n === 1 ? word + ' tomorrow' : word + ' in ' + n + ' days'; };
  if (section === 'open') return r.end ? days(ab_ipotDays_(todayIso, r.end), 'Closes') : 'Open';
  if (section === 'closed') return !r.listing ? 'Listing date not announced' : r.listing === todayIso ? 'Lists today' : 'Lists on ' + ab_ipotShort_(r.listing);
  return r.start ? days(ab_ipotDays_(todayIso, r.start), 'Opens') : 'Dates not announced';
}

function ab_ipotSections_(c) {
  return [['open', 'Open now', c.open], ['closed', 'Closed - awaiting listing', c.closed], ['upcoming', 'Upcoming', c.upcoming]];
}

/** Rebuilds the IPO Tracker tab (a snapshot - nothing on it is kept between updates). */
function ab_ipotWriteTab_(c, fetchedAt, failed, todayIso) {
  const sh = ab_getOrCreateSheet_(AB_IPOT_SHEET);
  const W = AB_IPOT_HEADERS_.length;
  const pad = function (a) { while (a.length < W) a.push(''); return a; };
  const rows = [], titles = [], heads = [], data = [];
  rows.push(pad(['IPO Tracker - mainboard equity IPOs on NSE (SME and debt issues left out)']));
  rows.push(pad(['Updated ' + fetchedAt + ' IST from NSE, read by your PC. Unofficial summary - check the offer document before applying.']));
  if (failed.length) rows.push(pad(['Could not read from NSE this time: ' + failed.join(', ') + ' - those sections may be incomplete.']));
  ab_ipotSections_(c).forEach(function (s) {
    rows.push(pad([]));
    titles.push(rows.length + 1); rows.push(pad([s[1] + ' (' + s[2].length + ')']));
    heads.push(rows.length + 1); rows.push(AB_IPOT_HEADERS_.slice());
    if (!s[2].length) { rows.push(pad(['None'])); return; }
    data.push([rows.length + 1, s[2].length]);
    s[2].forEach(function (r) {
      rows.push([r.company || r.symbol, r.symbol, ab_ipotCell_(r.start), ab_ipotCell_(r.end), ab_ipotCell_(r.listing),
                 r.price, r.size, ab_ipotNote_(s[0], r, todayIso)]);
    });
  });
  sh.clear();
  const f = sh.getFilter();
  if (f) f.remove();
  sh.getRange(1, 1, rows.length, W).setValues(rows);
  sh.getRange(1, 1).setFontWeight('bold').setFontSize(13);
  sh.getRange(2, 1).setFontColor('#5f6368');
  titles.forEach(function (r) { sh.getRange(r, 1, 1, W).setFontWeight('bold').setBackground('#e8f0fe'); });
  heads.forEach(function (r) { sh.getRange(r, 1, 1, W).setFontWeight('bold').setBackground('#f1f3f4'); });
  data.forEach(function (d) {
    sh.getRange(d[0], 3, d[1], 3).setNumberFormat('dd/mm/yyyy');
    sh.getRange(d[0], 7, d[1], 1).setNumberFormat('[>=10000000]##\\,##\\,##\\,##0;[>=100000]##\\,##\\,##0;##,##0');   // 2,34,68,846
  });
  sh.autoResizeColumns(1, W);
}

/** The day's short email: three small tables. */
function ab_ipotSendEmail_(c, fetchedAt, failed, todayIso) {
  const th = 'style="text-align:left;padding:5px 8px;background:#f1f3f4;border-bottom:2px solid #dadce0;font-size:12px;color:#5f6368"';
  const td = 'style="padding:5px 8px;border-bottom:1px solid #eee;font-size:13px;vertical-align:top"';
  const esc = function (v) { return String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  let html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:720px;color:#202124">' +
    '<h2 style="margin:0 0 4px;font-size:18px">IPO Tracker</h2>' +
    '<p style="margin:0 0 4px;color:#5f6368;font-size:12px">Mainboard equity IPOs on NSE (SME and debt issues left out). Read from NSE by your PC at ' + esc(fetchedAt) + ' IST.' +
    (failed.length ? ' <b>Could not read: ' + esc(failed.join(', ')) + '.</b>' : '') + '</p>';
  let text = 'IPO TRACKER - mainboard equity IPOs on NSE (SME and debt issues left out), read ' + fetchedAt + ' IST\n';
  ab_ipotSections_(c).forEach(function (s) {
    html += '<h3 style="margin:16px 0 6px;font-size:15px">' + s[1] + ' (' + s[2].length + ')</h3>';
    text += '\n' + s[1].toUpperCase() + ' (' + s[2].length + ')\n';
    if (!s[2].length) { html += '<p style="margin:0;font-size:13px;color:#5f6368">None</p>'; text += '  none\n'; return; }
    html += '<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%"><tr>' +
      ['Company', 'Opens', 'Closes', s[0] === 'closed' ? 'Listing' : 'Price range', ''].map(function (t) { return '<th ' + th + '>' + t + '</th>'; }).join('') + '</tr>';
    s[2].forEach(function (r) {
      const note = ab_ipotNote_(s[0], r, todayIso);
      html += '<tr><td ' + td + '><b>' + esc(r.company || r.symbol) + '</b>' + (r.symbol ? '<br><span style="color:#5f6368;font-size:11px">' + esc(r.symbol) + '</span>' : '') +
        '</td><td ' + td + '>' + ab_ipotShort_(r.start) + '</td><td ' + td + '>' + ab_ipotShort_(r.end) + '</td><td ' + td + '>' +
        (s[0] === 'closed' ? ab_ipotShort_(r.listing) : esc(r.price || '-')) + '</td><td ' + td + ' style="color:#5f6368">' + esc(note) + '</td></tr>';
      text += '  ' + (r.company || r.symbol) + (r.symbol ? ' (' + r.symbol + ')' : '') + ': ' + ab_ipotShort_(r.start) + ' to ' + ab_ipotShort_(r.end) +
        (s[0] === 'closed' ? ', listing ' + ab_ipotShort_(r.listing) : r.price ? ', ' + r.price : '') + ' - ' + note + '\n';
    });
    html += '</table>';
  });
  html += '<p style="margin:16px 0 0;color:#5f6368;font-size:11px">Details: the "' + AB_IPOT_SHEET + '" tab. Dates from NSE; not advice.</p></div>';
  const subject = 'IPO Tracker (' + ab_ipotShort_(todayIso) + '): ' + c.open.length + ' open, ' + c.closed.length + ' awaiting listing, ' +
    c.upcoming.length + ' upcoming';
  return ab_sendMail_({ to: AB_EMAIL_TO, subject: subject, body: text, htmlBody: html });
}

/**
 * PC bridge: NSE's IPO lists. req = { fetchedAt: 'yyyy-mm-dd HH:MM', failed: ['past', ...], records: [...] }.
 * Rebuilds the tab; emails once per IST day (the first update of the day).
 */
function ab_ipotFromBridge_(req) {
  const records = Array.isArray(req.records) ? req.records.slice(0, 1000) : null;
  if (!records) return { ok: false, error: 'records missing' };
  const failed = (Array.isArray(req.failed) ? req.failed : []).map(String).filter(function (x) { return /^(current|past|upcoming)$/.test(x); });
  const now = new Date();
  const todayIso = Utilities.formatDate(now, AB_TZ, 'yyyy-MM-dd');
  const fetchedAt = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(req.fetchedAt || '')) ? String(req.fetchedAt) : Utilities.formatDate(now, AB_TZ, 'yyyy-MM-dd HH:mm');
  const c = ab_ipotClassify_(records, todayIso);
  ab_ipotWriteTab_(c, fetchedAt, failed, todayIso);
  let emailed = false;
  const props = PropertiesService.getScriptProperties();
  if (AB_IPOT_EMAIL && props.getProperty(AB_IPOT_EMAIL_DAY_PROP) !== todayIso && ab_ipotSendEmail_(c, fetchedAt, failed, todayIso)) {
    props.setProperty(AB_IPOT_EMAIL_DAY_PROP, todayIso);
    emailed = true;
  }
  return { ok: true, open: c.open.length, closed: c.closed.length, upcoming: c.upcoming.length, sme: c.sme, other: c.other, emailed: emailed };
}

/*****************************************************************
 * NSE END-OF-DAY: DELIVERY %, 52-WEEK HIGHS, MARKET STATISTICS
 * -----------------------------------------------------------------
 * Each evening the PC bridge downloads three NSE files of the trading
 * day (Full Bhavcopy with deliverable data, the 52 Week High Low report,
 * the price band complete list - NSE blocks Google's servers) and posts
 * a summary here (doPost action 'eod'):
 *   - "Market Statistics" tab: one row per day - of YOUR Main stocks:
 *     traded, advances, declines, unchanged, at a new 52-week high, at
 *     the upper / lower price band (the user's choice: the dashboard
 *     reflects the sheet only, not the whole market);
 *   - "Market Day" tab: those Main stocks on the newest day (close,
 *     % change, move, circuit, new 52-week high, Delivery %) - the
 *     lists behind the website's dashboard tiles;
 *   - "Delivery %" tab: each Main stock's Delivery % for the last
 *     AB_EOD_DELIV_DAYS trading days (newest first);
 *   - "52 Week High" tab: every stock at a new 52-week high that day,
 *     plus every Main stock with its 52-week high, date and distance.
 * The website shows them (site feed parts marketStats / marketDay / delivery / high52).
 * Days arrive oldest first when the PC catches up; an older day never
 * replaces the 52 Week High tab of a newer one.
 *****************************************************************/
const AB_EOD_STATS_SHEET = 'Market Statistics';
const AB_EOD_DELIV_SHEET = 'Delivery %';
const AB_EOD_HIGH_SHEET = '52 Week High';
const AB_EOD_DAY_SHEET = 'Market Day';
const AB_EOD_DAY_HEADERS = ['Symbol', 'Company', 'Close', '% Change', 'Move', 'Circuit', 'New 52W High', 'Delivery %'];
const AB_EOD_DAY_DATE_PROP = 'AB_EOD_DAY_DATE';
const AB_EOD_STATS_HEADERS = ['Date', 'Stocks Traded', 'Advances', 'Declines', 'Unchanged', 'At 52W High', 'Upper Circuit', 'Lower Circuit'];
const AB_EOD_STATS_KEYS = ['traded', 'advances', 'declines', 'unchanged', 'high52', 'upper', 'lower'];
const AB_EOD_HIGH_HEADERS = ['Symbol', 'Company', '52W High', '52W High Date', 'Close', '% Below 52W High', 'New High Today', 'In Watchlist'];
const AB_EOD_STATS_KEEP = 250;      // days of market statistics kept
const AB_EOD_DELIV_DAYS = 10;       // trading days of Delivery % kept
const AB_EOD_HIGH_DATE_PROP = 'AB_EOD_HIGH_DATE';

/** A cell that should hold a yyyy-MM-dd day (Sheets may have turned the text into a Date). */
function ab_eodIso_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return Utilities.formatDate(v, AB_TZ, 'yyyy-MM-dd');
  const s = String(v === null || v === undefined ? '' : v).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

/** Main's stocks in sheet order: [{ sym, name }], one per symbol (blank rows inside the data are skipped). */
function ab_eodMainStocks_() {
  const layout = ab_getMainLayout_();
  const out = [], seen = {};
  for (let r = layout.headerRowIdx + 1; r < layout.data.length; r++) {
    const sym = ab_cellText_(layout.data[r][layout.symbol]).toUpperCase();
    if (!sym || seen[sym]) continue;
    seen[sym] = true;
    out.push({ sym: sym, name: ab_cellText_(layout.data[r][layout.name]) });
  }
  return out;
}

/** Rows below the tab's header row (first cell = firstHeader), and that header. */
function ab_eodReadTable_(sh, firstHeader) {
  if (!sh || sh.getLastRow() < 1) return { header: [], rows: [] };
  const vals = sh.getDataRange().getValues();
  for (let i = 0; i < Math.min(5, vals.length); i++) {
    if (String(vals[i][0]).trim() === firstHeader) {
      return { header: vals[i], rows: vals.slice(i + 1).filter(function (r) { return String(r[0]).trim() !== ''; }) };
    }
  }
  return { header: [], rows: [] };
}

/**
 * Note + header + rows, written in one go. The note / header rows and the
 * columns given as fmt [[column, count, format]] get their formats first
 * ('@' = plain text, so yyyy-MM-dd days are never turned into dates).
 */
function ab_eodWriteTab_(name, note, header, rows, fmt) {
  const sh = ab_getOrCreateSheet_(name);
  const W = header.length;
  const pad = function (a) { a = a.slice(); while (a.length < W) a.push(''); return a; };
  sh.clear();
  sh.getRange(1, 1, 2, W).setNumberFormat('@');
  if (rows.length) {
    (fmt || []).forEach(function (f) {
      if (f[0] < W && f[1] > 0) sh.getRange(3, f[0] + 1, rows.length, Math.min(f[1], W - f[0])).setNumberFormat(f[2]);
    });
  }
  sh.getRange(1, 1, rows.length + 2, W).setValues([pad([note]), header].concat(rows.map(pad)));
  sh.getRange(1, 1).setFontColor('#5f6368');
  sh.getRange(2, 1, 1, W).setFontWeight('bold').setBackground('#f1f3f4');
  sh.setFrozenRows(2);
  return sh;
}

/** One posted day -> clean { day, stats, delivery, highs } or { error }. */
function ab_eodClean_(req) {
  const day = String(req.tradeDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { error: 'tradeDate missing' };
  // each traded stock's day: {SYM: [close, % change, move 1/-1/0, circuit 'U'/'L'/'', new 52W high 1/0, series]}
  const rowsIn = req.day && typeof req.day === 'object' ? req.day : null;
  if (!rowsIn) return { error: 'day missing - update screener_bridge.py on the PC' };
  const isNum = function (v) { return typeof v === 'number' && isFinite(v); };
  const days = {};
  Object.keys(rowsIn).slice(0, 20000).forEach(function (k) {
    const r = rowsIn[k];
    const sym = String(k).trim().toUpperCase();
    if (!sym || !Array.isArray(r) || !isNum(r[0]) || r[0] <= 0 || !isNum(r[1])) return;
    days[sym] = { close: r[0], pct: Math.round(r[1] * 100) / 100, move: r[2] > 0 ? 1 : r[2] < 0 ? -1 : 0,
                  circuit: r[3] === 'U' ? 'Upper' : r[3] === 'L' ? 'Lower' : '', new52: r[4] === 1 || r[4] === true };
  });
  if (!Object.keys(days).length) return { error: 'no stocks in the day\'s data' };
  const files = req.files && typeof req.files === 'object' ? req.files : {};
  const delivery = {};
  const dv = req.delivery && typeof req.delivery === 'object' ? req.delivery : {};
  Object.keys(dv).slice(0, 10000).forEach(function (k) {
    const v = dv[k];
    if (typeof v === 'number' && isFinite(v) && v >= 0 && v <= 100) delivery[String(k).trim().toUpperCase()] = Math.round(v * 100) / 100;
  });
  const highs = {};
  (Array.isArray(req.high52) ? req.high52 : []).slice(0, 10000).forEach(function (r) {
    if (!Array.isArray(r) || typeof r[1] !== 'number' || !isFinite(r[1]) || r[1] <= 0) return;
    const sym = String(r[0] || '').trim().toUpperCase();
    if (!sym || highs[sym]) return;
    highs[sym] = { high: r[1], date: /^\d{4}-\d{2}-\d{2}$/.test(String(r[2] || '')) ? String(r[2]) : '',
                   close: typeof r[3] === 'number' && isFinite(r[3]) && r[3] > 0 ? r[3] : null };
  });
  return { day: day, rows: days, w52: files.w52 !== false, bands: files.bands !== false, delivery: delivery, highs: highs };
}

/** The day's counts for the Main stocks only (null where NSE's file for it was not downloaded). */
function ab_eodMainStats_(c, stocks) {
  const st = { traded: 0, advances: 0, declines: 0, unchanged: 0, high52: 0, upper: 0, lower: 0 };
  stocks.forEach(function (s) {
    const r = c.rows[s.sym];
    if (!r) return;
    st.traded++;
    if (r.move > 0) st.advances++; else if (r.move < 0) st.declines++; else st.unchanged++;
    if (r.new52) st.high52++;
    if (r.circuit === 'Upper') st.upper++;
    if (r.circuit === 'Lower') st.lower++;
  });
  if (!c.w52) st.high52 = null;
  if (!c.bands) { st.upper = null; st.lower = null; }
  return st;
}

/** "Market Day" tab: the Main stocks traded on the day, in Main's order. */
function ab_eodWriteDay_(c, stocks, st) {
  const rows = stocks.filter(function (s) { return c.rows[s.sym]; }).map(function (s) {
    const r = c.rows[s.sym];
    return [s.sym, s.name, r.close, r.pct, r.move > 0 ? 'Advance' : r.move < 0 ? 'Decline' : 'Unchanged', r.circuit,
            r.new52 ? 'Yes' : '', typeof c.delivery[s.sym] === 'number' ? c.delivery[s.sym] : ''];
  });
  ab_eodWriteTab_(AB_EOD_DAY_SHEET,
    'Your Main stocks on ' + c.day + ' (NSE end-of-day files read by your PC): ' + st.traded + ' traded - ' + st.advances + ' advances, ' +
    st.declines + ' declines, ' + st.unchanged + ' unchanged' + (st.high52 === null ? '' : ', ' + st.high52 + ' at a new 52-week high') +
    (st.upper === null ? '' : ', ' + st.upper + ' in upper circuit, ' + st.lower + ' in lower circuit') + '.',
    AB_EOD_DAY_HEADERS.slice(), rows, [[0, 2, '@'], [2, 1, '0.00'], [3, 1, '0.00'], [4, 3, '@'], [7, 1, '0.00']]);
}

function ab_eodWriteStats_(c, st) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AB_EOD_STATS_SHEET);
  const byDay = {};
  ab_eodReadTable_(sh, 'Date').rows.forEach(function (r) {
    const d = ab_eodIso_(r[0]);
    if (d) byDay[d] = r.slice(1, AB_EOD_STATS_HEADERS.length).map(function (v) { return typeof v === 'number' ? v : ''; });
  });
  byDay[c.day] = AB_EOD_STATS_KEYS.map(function (k) { return st[k] === null ? '' : st[k]; });
  const days = Object.keys(byDay).sort().reverse().slice(0, AB_EOD_STATS_KEEP);
  ab_eodWriteTab_(AB_EOD_STATS_SHEET,
    'Market statistics of YOUR Main stocks, counted from NSE\'s end-of-day files (bhavcopy, 52-week high report, price band list) ' +
    'read by your PC - not the whole market. One row per trading day; the newest day\'s stocks are listed on the Market Day tab.',
    AB_EOD_STATS_HEADERS.slice(), days.map(function (d) { return [d].concat(byDay[d]); }), [[0, 1, '@'], [1, AB_EOD_STATS_KEYS.length, '0']]);
}

function ab_eodWriteDelivery_(c, stocks) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AB_EOD_DELIV_SHEET);
  const t = ab_eodReadTable_(sh, 'Symbol');
  const byDay = {};                                   // day -> { SYM: % }
  t.header.forEach(function (h, j) {
    const d = j >= 2 ? ab_eodIso_(h) : '';
    if (!d) return;
    byDay[d] = {};
    t.rows.forEach(function (r) {
      if (typeof r[j] === 'number') byDay[d][String(r[0]).trim().toUpperCase()] = r[j];
    });
  });
  byDay[c.day] = c.delivery;
  const days = Object.keys(byDay).sort().reverse().slice(0, AB_EOD_DELIV_DAYS);
  let inMain = 0;
  const rows = stocks.map(function (s) {
    if (typeof c.delivery[s.sym] === 'number') inMain++;
    return [s.sym, s.name].concat(days.map(function (d) { const v = byDay[d][s.sym]; return typeof v === 'number' ? v : ''; }));
  });
  ab_eodWriteTab_(AB_EOD_DELIV_SHEET,
    'Delivery % from NSE\'s bhavcopy (EQ series): delivered quantity / traded quantity. Newest trading day first, last ' +
    AB_EOD_DELIV_DAYS + ' days. Read by your PC each evening.',
    ['Symbol', 'Company'].concat(days), rows, [[0, 2, '@'], [2, days.length, '0.00']]);
  return inMain;
}

function ab_eodWriteHighs_(c, stocks) {
  const inMain = {};
  stocks.forEach(function (s) { inMain[s.sym] = s.name || ''; });
  const row = function (sym) {
    const h = c.highs[sym];
    const below = h.close ? Math.max(0, Math.round((h.high - h.close) / h.high * 1000) / 10) : '';
    return [sym, Object.prototype.hasOwnProperty.call(inMain, sym) ? inMain[sym] : '', h.high, h.date, h.close === null ? '' : h.close,
            below, h.date === c.day ? 'Yes' : '', Object.prototype.hasOwnProperty.call(inMain, sym) ? 'Yes' : ''];
  };
  const fresh = Object.keys(c.highs).filter(function (s) { return c.highs[s].date === c.day; }).sort();
  const watch = stocks.map(function (s) { return s.sym; }).filter(function (s) { return c.highs[s] && c.highs[s].date !== c.day; });
  const rows = fresh.map(row).concat(watch.map(row).sort(function (a, b) {
    return (a[5] === '' ? 1e9 : a[5]) - (b[5] === '' ? 1e9 : b[5]) || (a[0] < b[0] ? -1 : 1);
  }));
  const freshMain = fresh.filter(function (s) { return Object.prototype.hasOwnProperty.call(inMain, s); }).length;
  ab_eodWriteTab_(AB_EOD_HIGH_SHEET,
    '52-week highs from NSE (adjusted for corporate actions) - as on ' + c.day + ': ' + fresh.length +
    ' mainboard stock' + (fresh.length === 1 ? '' : 's') + ' made a new 52-week high (' + freshMain + ' in your watchlist). ' +
    'Below them: every watchlist stock, nearest to its high first.',
    AB_EOD_HIGH_HEADERS.slice(), rows, [[0, 2, '@'], [2, 1, '0.00'], [3, 1, '@'], [4, 1, '0.00'], [5, 1, '0.0'], [6, 2, '@']]);
  return { newHighs: fresh.length, newHighsInMain: freshMain, rows: rows.length };
}

/** doPost action 'eod': { tradeDate, day: {SYM: [...]}, files: {w52, bands}, delivery: {SYM: %}, high52: [[SYM, high, 'yyyy-MM-dd', close]] }. */
function ab_eodFromBridge_(req) {
  const c = ab_eodClean_(req);
  if (c.error) return { ok: false, error: c.error };
  const stocks = ab_eodMainStocks_();
  const st = ab_eodMainStats_(c, stocks);
  ab_eodWriteStats_(c, st);
  const deliveryInMain = ab_eodWriteDelivery_(c, stocks);
  const props = PropertiesService.getScriptProperties();
  let dayTab = 'kept (a newer day is already there)';
  if (c.day >= (props.getProperty(AB_EOD_DAY_DATE_PROP) || '')) {
    ab_eodWriteDay_(c, stocks, st);
    props.setProperty(AB_EOD_DAY_DATE_PROP, c.day);
    dayTab = 'updated';
  }
  let highs = null;
  const last = props.getProperty(AB_EOD_HIGH_DATE_PROP) || '';
  if (Object.keys(c.highs).length && c.day >= last) {
    highs = ab_eodWriteHighs_(c, stocks);
    props.setProperty(AB_EOD_HIGH_DATE_PROP, c.day);
  }
  return { ok: true, tradeDate: c.day, stats: st, dayTab: dayTab, deliveryInMain: deliveryInMain,
           newHighs: highs ? highs.newHighs : null, newHighsInMain: highs ? highs.newHighsInMain : null,
           highTab: highs ? 'updated' : (Object.keys(c.highs).length ? 'kept (a newer day is already there)' : 'no 52-week report') };
}

/*****************************************************************
 * HISTORY60 - 60 trading days of daily candles (from NSE via the PC)
 * -----------------------------------------------------------------
 * History30 (GOOGLEFINANCE, Phase 1) stays exactly as it was and needs
 * no PC. The PC bridge (screener_bridge.py hist_step) reads NSE's full
 * bhavcopy (sec_bhavdata_full_DDMMYYYY.csv - the Delivery % file) and
 * posts each trading day's open / high / low / close / volume / previous
 * close (doPost action 'hist', ab_h60FromBridge_). Tab "History60" keeps
 * the newest AB_H60_DAYS days of the PatternData stocks:
 *   row 1 note; row 2 'Symbol' + one column per day, newest first (text
 *   yyyy-MM-dd); row 3 '(linked)' + 'Y' where that day directly follows
 *   the older day beside it (for most stocks NSE's previous close = the
 *   stored close; '' = a gap - a day not received yet); rows 4+ one stock
 *   each, a cell = 'open high low close volume prevclose' (NSE's prices).
 * A new day is added as one column (cheap); older days (the first fill)
 * rewrite the tab.
 * NSE's prices are not adjusted for splits / bonus issues, but on the
 * ex-date NSE's previous close is: a previous close that differs from the
 * stored close of the day before = a corporate action, and every older
 * candle is scaled by that ratio (ab_h60Adjust_). Where a stock's
 * History30 window starts, the NSE candles are matched to GOOGLEFINANCE's
 * close of that day (ab_h60Older_), so the series never jumps.
 * ab_readHistoryMerged_ = History30 + the older History60 days (and all
 * days of a PatternData stock GOOGLEFINANCE gave nothing for) - read by
 * the FVG scans (PatternData col X, GapUpFVG, UnmitigatedFVG, the FVG
 * explainer) and Results Performance only; EMA / ATR / patterns / alerts
 * keep History30. Phase 1 fills History30 / the 4 day tabs of a stock
 * GOOGLEFINANCE gave no data for from History60 (ab_h60FillFailed_).
 * The website gets the older days as site feed part 'history60'.
 * tools/export_xlsx.py history60_data() is the same reading in Python.
 *****************************************************************/
const AB_H60_SHEET = 'History60';
const AB_H60_DAYS = 60;                 // trading days kept
const AB_H60_MAX_POST_DAYS = 15;        // days in one post from the PC
const AB_H60_LINK = '(linked)';
const AB_H60_NOTE = 'NSE daily candles read by your PC (full bhavcopy), newest day first. Cell = Open High Low Close Volume ' +
  'PrevClose, NSE\'s own prices (a split / bonus is adjusted when the candles are read). Used for the 60-day FVG scans and ' +
  'Results Performance; the last 30 days there come from History30 (GOOGLEFINANCE). Row "(linked)": Y = the day directly ' +
  'follows the day beside it.';
let AB_H60_MEMO_ = null;                // this execution's parsed History60 (ab_h60Load_)

/** A day cell (Date, 'yyyy-MM-dd...', 'dd/MM/yyyy', 'dd-MMM-yyyy') -> 'yyyy-MM-dd', else ''. */
function ab_h60Iso_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, AB_TZ, 'yyyy-MM-dd');
  const s = String(v === null || v === undefined ? '' : v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  const k = ab_msDateKey_(s);
  return k ? k.slice(0, 4) + '-' + k.slice(4, 6) + '-' + k.slice(6, 8) : '';
}

/** Price to 2 decimals / volume to a whole number - the same arithmetic as export_xlsx.py. */
function ab_h60R2_(x) { return Math.floor(x * 100 + 0.5) / 100; }
function ab_h60Vol_(v, f) { return isNaN(v) ? NaN : Math.floor(v / f + 0.5); }

/** 'o h l c v p' -> [o, h, l, c, v, p] (v / p NaN when missing) or null. */
function ab_h60ParseCell_(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  const a = v.trim().split(/\s+/).map(Number);
  if (a.length < 4 || !(a[0] > 0 && a[1] > 0 && a[2] > 0 && a[3] > 0)) return null;
  return [a[0], a[1], a[2], a[3], a.length > 4 && a[4] >= 0 ? a[4] : NaN, a.length > 5 && a[5] > 0 ? a[5] : NaN];
}

/** A posted [o, h, l, c, v, p] -> the stored cell text, or '' when it is not a usable candle. */
function ab_h60Cell_(r) {
  const ok = function (x) { return typeof x === 'number' && isFinite(x) && x > 0; };
  if (!Array.isArray(r) || !ok(r[0]) || !ok(r[1]) || !ok(r[2]) || !ok(r[3])) return '';
  const v = typeof r[4] === 'number' && isFinite(r[4]) && r[4] >= 0 ? Math.round(r[4]) : '';
  const p = ok(r[5]) ? r[5] : '';
  return [r[0], r[1], r[2], r[3], v === '' ? 'NaN' : v, p === '' ? 'NaN' : p].join(' ');
}

/**
 * History60 values -> { days: [iso, oldest first], linked: [bool per day], syms: [in tab order],
 * cells: { SYM: [[o, h, l, c, v, p] | null per day] } }.
 */
function ab_h60Grid_(vals) {
  const out = { days: [], linked: [], syms: [], cells: {} };
  let h = -1;
  for (let i = 0; i < Math.min(5, vals.length); i++) if (String(vals[i][0]).trim() === 'Symbol') { h = i; break; }
  if (h === -1) return out;
  const cols = [], seen = {};
  vals[h].forEach(function (v, j) {
    const d = j ? ab_h60Iso_(v) : '';
    if (d && !seen[d]) { seen[d] = true; cols.push([j, d]); }
  });
  cols.sort(function (a, b) { return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0; });
  const link = vals[h + 1] && String(vals[h + 1][0]).trim() === AB_H60_LINK ? vals[h + 1] : null;
  out.days = cols.map(function (c) { return c[1]; });
  out.linked = cols.map(function (c) { return !!link && String(link[c[0]]).trim() === 'Y'; });
  for (let r = h + (link ? 2 : 1); r < vals.length; r++) {
    const sym = String(vals[r][0] === null || vals[r][0] === undefined ? '' : vals[r][0]).trim().toUpperCase();
    if (!sym || out.cells[sym]) continue;
    out.syms.push(sym);
    out.cells[sym] = cols.map(function (c) { return ab_h60ParseCell_(vals[r][c[0]]); });
  }
  return out;
}

/** True when `newer` directly follows `older`: at least half the stocks' previous close = the older day's close. */
function ab_h60Linked_(newer, older) {
  let n = 0, same = 0;
  Object.keys(newer).forEach(function (s) {
    const a = newer[s], b = older[s];
    if (!a || !b || !(a[5] > 0)) return;
    n++;
    if (Math.abs(a[5] / b[3] - 1) <= 1e-4) same++;
  });
  return n > 0 && same * 2 >= n;
}

/**
 * One stock's candles, oldest first: [{ iso, Opn, High, Low, Cls, Volume }], scaled for the splits /
 * bonus issues seen in NSE's previous close (only across days with no gap between them).
 */
function ab_h60Adjust_(g, sym) {
  const cells = g.cells[sym] || [];
  const out = [];
  let f = 1, newer = -1;
  for (let i = cells.length - 1; i >= 0; i--) {
    const c = cells[i];
    if (!c) continue;
    if (newer !== -1) {
      let gap = false;
      for (let k = i + 1; k <= newer; k++) if (!g.linked[k]) { gap = true; break; }
      const p = cells[newer][5];
      if (!gap && p > 0 && Math.abs(p / c[3] - 1) > 1e-4) f = f * (p / c[3]);
    }
    out.push({ iso: g.days[i], Opn: ab_h60R2_(c[0] * f), High: ab_h60R2_(c[1] * f), Low: ab_h60R2_(c[2] * f),
               Cls: ab_h60R2_(c[3] * f), Volume: ab_h60Vol_(c[4], f) });
    newer = i;
  }
  return out.reverse();
}

/**
 * The History60 candles that History30 does not have, per stock (oldest first, with iso): the days
 * before the stock's first History30 day, back to the first gap in History60 (an unlinked day) so the
 * series never skips a trading day - only when History60 has that first day too, and scaled to
 * History30's close of it when the two differ by more than 0.5 % (prices adjusted differently). A
 * stock of `allowed` (PatternData) that History30 has no candles for gets the unbroken run of days
 * ending at History30's newest day (or the newest before it).
 * gf = ab_readHistoryCandles_() / ab_historyFromValues_().
 */
function ab_h60Older_(gf, g, allowed) {
  let newest = '';
  const first = {};                       // SYM -> [iso, close] of its first History30 candle
  Object.keys(gf).forEach(function (s) {
    (gf[s] || []).forEach(function (c) {
      const k = ab_h60Iso_(c.date);
      if (!k) return;
      if (k > newest) newest = k;
      if (!first[s] || k < first[s][0]) first[s] = [k, c.Cls];
    });
  });
  const at = {};
  g.days.forEach(function (d, i) { at[d] = i; });
  let last = -1;                          // the newest History60 day not after History30's newest
  for (let i = g.days.length - 1; i >= 0; i--) if (!newest || g.days[i] <= newest) { last = i; break; }
  const runFrom = function (e) { let k = e; while (k > 0 && g.linked[k]) k--; return g.days[k]; };
  const out = {};
  g.syms.forEach(function (sym) {
    const own = first[sym];
    if (!own && gf[sym] && gf[sym].length) return;          // History30 rows without readable days: leave alone
    if (!own && !(allowed && allowed[sym])) return;
    if (own ? at[own[0]] === undefined : last === -1) return;
    const nse = ab_h60Adjust_(g, sym);
    if (!own) {
      const from = runFrom(last), to = g.days[last];
      const list = nse.filter(function (c) { return c.iso >= from && c.iso <= to; });
      if (list.length) out[sym] = list;
      return;
    }
    const seam = nse.filter(function (c) { return c.iso === own[0]; })[0];
    if (!seam) return;
    const from = runFrom(at[own[0]]);
    let older = nse.filter(function (c) { return c.iso >= from && c.iso < own[0]; });
    if (!older.length) return;
    if (own[1] > 0) {
      const r = own[1] / seam.Cls;
      if (!(r > 0.02 && r < 50)) return;                      // not the same prices at all
      if (Math.abs(r - 1) > 0.005) {
        older = older.map(function (c) {
          return { iso: c.iso, Opn: ab_h60R2_(c.Opn * r), High: ab_h60R2_(c.High * r), Low: ab_h60R2_(c.Low * r),
                   Cls: ab_h60R2_(c.Cls * r), Volume: ab_h60Vol_(c.Volume, r) };
        });
      }
    }
    out[sym] = older;
  });
  return out;
}

/** History60 parsed (only = [symbols]: just their rows), or an empty grid when there is no tab. */
function ab_h60Load_(only) {
  if (!only && AB_H60_MEMO_) return AB_H60_MEMO_;
  const empty = { days: [], linked: [], syms: [], cells: {} };
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AB_H60_SHEET);
  if (!sh || sh.getLastRow() < 2) return empty;
  let vals;
  if (only && only.length <= 20) {
    const W = Math.max(1, sh.getLastColumn()), last = sh.getLastRow();
    vals = sh.getRange(1, 1, Math.min(3, last), W).getValues();
    if (last > 3) {
      const want = {};
      only.forEach(function (s) { want[String(s).toUpperCase()] = true; });
      sh.getRange(4, 1, last - 3, 1).getValues().forEach(function (r, i) {
        if (want[String(r[0]).trim().toUpperCase()]) vals.push(sh.getRange(4 + i, 1, 1, W).getValues()[0]);
      });
    }
  } else {
    vals = sh.getDataRange().getValues();
  }
  const g = ab_h60Grid_(vals);
  if (!only) AB_H60_MEMO_ = g;
  return g;
}

/** 'yyyy-MM-dd' -> Date (midnight IST, like History30's day cells). */
function ab_h60Date_(iso) { return Utilities.parseDate(iso, AB_TZ, 'yyyy-MM-dd'); }

/**
 * History30 + History60's older days: { SYM: [{ date, Opn, High, Low, Cls, Volume }] } oldest first,
 * the same shape as ab_readHistoryCandles_. Without a History60 tab it is just History30.
 */
function ab_readHistoryMerged_(gf) {
  gf = gf || ab_readHistoryCandles_();
  let g;
  try { g = ab_h60Load_(); } catch (e) { Logger.log('History60 not read: ' + e.message); return gf; }
  if (!g.days.length) return gf;
  const allowed = {};
  ab_p1Symbols_().forEach(function (s) { allowed[s] = true; });
  const older = ab_h60Older_(gf, g, allowed);
  const out = {};
  Object.keys(gf).forEach(function (s) { out[s] = gf[s]; });
  Object.keys(older).forEach(function (s) {
    out[s] = older[s].map(function (c) {
      return { date: ab_h60Date_(c.iso), Opn: c.Opn, High: c.High, Low: c.Low, Cls: c.Cls, Volume: c.Volume };
    }).concat(gf[s] || []);
  });
  return out;
}

/**
 * Phase 1: stocks GOOGLEFINANCE gave no candles for get them from History60 - History30 rows for
 * the days of GOOGLEFINANCE's window, and the 4 day tabs when History60 has the newest day too.
 * hist / byTab are Phase 1's rows (added to here). Returns { filled: [SYM], tabs: n, upTo: iso }.
 */
function ab_h60FillFailed_(failed, hist, byTab) {
  const out = { filled: [], tabs: 0, upTo: '' };
  try {
    const have = {}, dates = {};
    hist.forEach(function (r) {
      have[String(r[0])] = true;
      const d = ab_h60Iso_(r[1]);
      if (d) dates[d] = true;
    });
    const want = failed.filter(function (s) { return !have[s]; });
    const days = Object.keys(dates).sort();
    if (!want.length || !days.length) return out;
    const g = ab_h60Load_(want);
    if (!g.days.length) return out;
    const newest = days[days.length - 1], last4 = days.slice(-4)[0];
    let e = -1;                                            // newest History60 day not after GOOGLEFINANCE's, and its unbroken run
    for (let i = g.days.length - 1; i >= 0; i--) if (g.days[i] <= newest) { e = i; break; }
    if (e === -1) return out;
    let k = e;
    while (k > 0 && g.linked[k]) k--;
    const from = g.days[k] > days[0] ? g.days[k] : days[0];
    want.forEach(function (sym) {
      const c = ab_h60Adjust_(g, sym).filter(function (x) { return x.iso >= from && x.iso <= newest; }).slice(-30);
      if (!c.length) return;
      c.forEach(function (x) { hist.push([sym, x.iso, x.Opn, x.High, x.Low, x.Cls, isNaN(x.Volume) ? '' : x.Volume]); });
      out.filled.push(sym);
      if (c[c.length - 1].iso > out.upTo) out.upTo = c[c.length - 1].iso;
      if (c[c.length - 1].iso !== newest) return;          // no candle for the newest day: the day tabs stay without it
      const l4 = c.filter(function (x) { return x.iso >= last4; }).slice(-4);
      const tabs = AB_DAY_TABS.slice(AB_DAY_TABS.length - l4.length);
      l4.forEach(function (x, j) { byTab[tabs[j]].push([sym, x.Opn, x.High, x.Low, x.Cls, isNaN(x.Volume) ? '' : x.Volume]); });
      out.tabs++;
    });
  } catch (e) {
    Logger.log('History60 fill skipped: ' + e.message);
  }
  return out;
}

/** doPost 'list': which days History60 has (newest first), for the PC. */
function ab_h60Info_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AB_H60_SHEET);
  let days = [];
  if (sh && sh.getLastRow() >= 2) {
    days = ab_h60Grid_(sh.getRange(1, 1, Math.min(3, sh.getLastRow()), Math.max(1, sh.getLastColumn())).getValues()).days;
  }
  return { days: days.slice().reverse(), want: AB_H60_DAYS };
}

/** Number format + values of a block, growing the tab first when needed. */
function ab_h60Put_(sh, row, col, vals) {
  if (!vals.length || !vals[0].length) return;
  const needR = row + vals.length - 1, needC = col + vals[0].length - 1;
  if (sh.getMaxRows() < needR) sh.insertRowsAfter(sh.getMaxRows(), needR - sh.getMaxRows());
  if (sh.getMaxColumns() < needC) sh.insertColumnsAfter(sh.getMaxColumns(), needC - sh.getMaxColumns());
  const rg = sh.getRange(row, col, vals.length, vals[0].length);
  rg.setNumberFormat('@');
  rg.setValues(vals);
}

/** The whole tab from a grid (days oldest first in g; written newest first). */
function ab_h60WriteAll_(sh, g) {
  const days = g.days.slice().reverse();
  const at = days.map(function (d) { return g.days.indexOf(d); });
  const cellText = function (c) { return c ? ab_h60Cell_(c) : ''; };
  const rows = [[AB_H60_NOTE].concat(days.map(function () { return ''; })), ['Symbol'].concat(days),
    [AB_H60_LINK].concat(at.map(function (i) { return g.linked[i] ? 'Y' : ''; }))];
  g.syms.forEach(function (s) { rows.push([s].concat(at.map(function (i) { return cellText(g.cells[s][i]); }))); });
  sh.clear();
  ab_h60Put_(sh, 1, 1, rows);
  try { sh.setFrozenRows(3); sh.setFrozenColumns(1); } catch (e) { /* cosmetic */ }
}

/**
 * doPost action 'hist': { days: { 'yyyy-MM-dd': { SYM: [open, high, low, close, volume, prev close] } } } -
 * up to AB_H60_MAX_POST_DAYS trading days of NSE's bhavcopy from the PC. Only PatternData stocks are kept,
 * the newest AB_H60_DAYS days. A day sent again replaces that day. Days newer than every stored one are
 * added as columns; anything else rewrites the tab.
 */
function ab_h60FromBridge_(req) {
  const daysIn = req.days && typeof req.days === 'object' && !Array.isArray(req.days) ? req.days : null;
  if (!daysIn) return { ok: false, error: 'days missing - update screener_bridge.py on the PC' };
  const isos = Object.keys(daysIn).filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); }).sort();
  if (!isos.length) return { ok: false, error: 'no trading day in the data' };
  if (isos.length > AB_H60_MAX_POST_DAYS) return { ok: false, error: 'too many days in one post (at most ' + AB_H60_MAX_POST_DAYS + ')' };
  const want = ab_p1Symbols_();
  if (!want.length) return { ok: false, error: 'PatternData has no symbols' };
  const wanted = {};
  want.forEach(function (s) { wanted[s] = true; });
  const fresh = {};                          // iso -> { SYM: [o, h, l, c, v, p] }
  let candles = 0;
  isos.forEach(function (d) {
    const src = daysIn[d] && typeof daysIn[d] === 'object' ? daysIn[d] : {};
    const day = {};
    Object.keys(src).slice(0, 20000).forEach(function (k) {
      const sym = String(k).trim().toUpperCase();
      if (!wanted[sym]) return;
      const t = ab_h60Cell_(src[k]);
      if (t) { day[sym] = ab_h60ParseCell_(t); candles++; }
    });
    fresh[d] = day;
  });
  if (!candles) return { ok: false, error: 'none of the posted stocks is in PatternData' };

  AB_H60_MEMO_ = null;
  const sh = ab_getOrCreateSheet_(AB_H60_SHEET);
  const last = sh.getLastRow();
  // add new days as columns: only when every posted day is newer and no stored stock has left PatternData
  if (last >= 4) {
    const W = Math.max(1, sh.getLastColumn());
    const head = ab_h60Grid_(sh.getRange(1, 1, Math.min(3, last), W).getValues());
    const symCol = sh.getRange(4, 1, last - 3, 1).getValues().map(function (r) { return String(r[0]).trim().toUpperCase(); });
    const gone = symCol.some(function (s) { return s && !wanted[s]; }) || symCol.indexOf('') !== -1;
    const newestStored = head.days.length ? head.days[head.days.length - 1] : '';
    if (newestStored && isos[0] > newestStored && !gone) {
      const prevCol = sh.getRange(4, 2, last - 3, 1).getValues();    // the newest stored day, column 2
      let older = {};
      symCol.forEach(function (s, i) { const c = ab_h60ParseCell_(prevCol[i][0]); if (c) older[s] = c; });
      const linked = {};
      isos.forEach(function (d) { linked[d] = ab_h60Linked_(fresh[d], older); older = fresh[d]; });
      const newSyms = want.filter(function (s) { return symCol.indexOf(s) === -1; });
      const desc = isos.slice().reverse();
      sh.insertColumnsBefore(2, desc.length);
      const block = [desc.map(function () { return ''; }), desc, desc.map(function (d) { return linked[d] ? 'Y' : ''; })];
      symCol.concat(newSyms).forEach(function (s) {
        block.push(desc.map(function (d) { return fresh[d][s] ? ab_h60Cell_(fresh[d][s]) : ''; }));
      });
      ab_h60Put_(sh, 1, 2, block);
      if (newSyms.length) ab_h60Put_(sh, 4 + symCol.length, 1, newSyms.map(function (s) { return [s]; }));
      const total = head.days.length + desc.length;
      if (total > AB_H60_DAYS) sh.deleteColumns(2 + AB_H60_DAYS, total - AB_H60_DAYS);
      const days = head.days.concat(isos).slice(-AB_H60_DAYS);
      return { ok: true, mode: 'added', added: isos.length, candles: candles, days: days.length, newest: days[days.length - 1],
               oldest: days[0], symbols: symCol.length + newSyms.length, want: AB_H60_DAYS };
    }
  }
  // rewrite: stored days + the posted ones (a posted day replaces the stored one), newest AB_H60_DAYS
  const g = ab_h60Grid_(last >= 2 ? sh.getDataRange().getValues() : []);
  const byDay = {};
  g.days.forEach(function (d, i) {
    const m = {};
    g.syms.forEach(function (s) { if (g.cells[s][i]) m[s] = g.cells[s][i]; });
    byDay[d] = m;
  });
  isos.forEach(function (d) { byDay[d] = fresh[d]; });
  const days = Object.keys(byDay).sort().slice(-AB_H60_DAYS);
  const out = { days: days, linked: days.map(function (d, i) { return i > 0 && ab_h60Linked_(byDay[d], byDay[days[i - 1]]); }),
                syms: want.slice(), cells: {} };
  want.forEach(function (s) { out.cells[s] = days.map(function (d) { return byDay[d][s] || null; }); });
  ab_h60WriteAll_(sh, out);
  return { ok: true, mode: 'rewritten', added: isos.length, candles: candles, days: days.length, newest: days[days.length - 1],
           oldest: days[0], symbols: want.length, want: AB_H60_DAYS };
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
    const by = ab_readHistoryMerged_();     // what the FVG scans read: History30 + History60's older days
    const c = by[sym];
    if (!c || !c.length) {
      ui.alert('Why is this stock missing?', sym + ' has no rows in History30 / History60 at all - so no FVG scan can see it.\n\n' +
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