#!/usr/bin/env node
/*
 * Check the Code.gs live site feed (doPost action 'site') against the static
 * export that tools/export_xlsx.py made from the SAME downloaded workbook:
 *
 *     node tools/compare_site_feed.js "Copy of Stock Blueprint.xlsx" [--dashboard web/data/dashboard.js] [--history web/data/history.js]
 *
 * The workbook is read with web/lib/xlsx-reader.js and served to Code.gs by
 * the Apps Script mock (tests/fixtures/apps-script-mock.js); ab_feedSite_ runs
 * for part 'main' and part 'history' and its `data` is compared with
 * window.SB_DATA / window.SB_HISTORY (top-level generated / source of main
 * are ignored; numbers equal within 1e-4). Each part is asked twice: the
 * first answer is built on demand (and stored in the mock's hidden Site_Feed
 * tab), the second must come from that stored copy with byte-identical
 * `data`. Exit 1 on any mismatch, or if the feed wrote anywhere else.
 *
 * The workbook is private: only paths, column names and counts are printed,
 * never cell values. Nothing is written to disk; no network.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const xlsx = require('../web/lib/xlsx-reader.js');
const mock = require('../tests/fixtures/apps-script-mock.js');

const ROOT = path.join(__dirname, '..');
const TOL = 1e-4;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const MAX_LIST = 25;

function parseArgs(argv) {
  const a = { file: null, dashboard: path.join(ROOT, 'web', 'data', 'dashboard.js'), history: path.join(ROOT, 'web', 'data', 'history.js') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dashboard') a.dashboard = path.resolve(argv[++i]);
    else if (argv[i] === '--history') a.history = path.resolve(argv[++i]);
    else if (argv[i] === '-h' || argv[i] === '--help') a.help = true;
    else if (!a.file) a.file = argv[i];
  }
  return a;
}

function loadWindowVar(file, name) {
  const w = {};
  new Function('window', fs.readFileSync(file, 'utf8'))(w);
  if (!w[name]) throw new Error(path.basename(file) + ' does not set window.' + name);
  return w[name];
}

function kindOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * Deep compare; returns [{ path, what }] (what: type | value | missing | extra | length).
 * Paths of {cols, rows} tables name the column: section.rows[i].<col>.
 */
function diff(exp, got, p, out, cols) {
  const ke = kindOf(exp), kg = kindOf(got);
  if (ke !== kg) { out.push({ path: p, what: 'type ' + ke + ' vs ' + kg }); return; }
  if (ke === 'number') { if (!(Math.abs(exp - got) <= TOL)) out.push({ path: p, what: 'value' }); return; }
  if (ke === 'array') {
    if (exp.length !== got.length) out.push({ path: p, what: 'length ' + exp.length + ' vs ' + got.length });
    const n = Math.min(exp.length, got.length);
    for (let i = 0; i < n; i++) {
      const sub = cols ? p + '[' + i + ']' : p + '[' + i + ']';
      if (cols && Array.isArray(exp[i])) {
        // a table row: label cells by column name
        const re = exp[i], rg = got[i] || [];
        if (re.length !== rg.length) out.push({ path: sub, what: 'length ' + re.length + ' vs ' + rg.length });
        for (let j = 0; j < Math.min(re.length, rg.length); j++) diff(re[j], rg[j], p + '[' + i + '].' + (cols[j] || '#' + j), out, null);
      } else {
        diff(exp[i], got[i], sub, out, null);
      }
    }
    return;
  }
  if (ke === 'object') {
    const isTable = Array.isArray(exp.cols) && Array.isArray(exp.rows);
    Object.keys(exp).forEach(function (k) {
      if (!(k in got)) { out.push({ path: p + '.' + k, what: 'missing' }); return; }
      diff(exp[k], got[k], p + '.' + k, out, isTable && k === 'rows' ? exp.cols : null);
    });
    Object.keys(got).forEach(function (k) { if (!(k in exp)) out.push({ path: p + '.' + k, what: 'extra' }); });
    return;
  }
  if (exp !== got) out.push({ path: p, what: 'value' });
}

function countLeaves(v) {
  if (v === null || typeof v !== 'object') return 1;
  let n = 0;
  if (Array.isArray(v)) v.forEach(function (x) { n += countLeaves(x); });
  else Object.keys(v).forEach(function (k) { n += countLeaves(v[k]); });
  return n;
}

/** Group mismatches by path with row numbers replaced by [*]. */
function summarize(label, list) {
  const groups = {};
  list.forEach(function (d) {
    const key = d.path.replace(/\[\d+\]/g, '[*]') + '  (' + d.what.replace(/\d+ vs \d+/, 'n vs m') + ')';
    groups[key] = (groups[key] || 0) + 1;
  });
  const keys = Object.keys(groups).sort(function (a, b) { return groups[b] - groups[a]; });
  console.log('  ' + label + ': ' + list.length + ' mismatch(es) in ' + keys.length + ' group(s)');
  keys.slice(0, MAX_LIST).forEach(function (k) { console.log('    ' + groups[k] + ' x ' + k); });
  if (keys.length > MAX_LIST) console.log('    ... ' + (keys.length - MAX_LIST) + ' more group(s)');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.file) {
    console.log('usage: node tools/compare_site_feed.js <export.xlsx> [--dashboard file] [--history file]');
    process.exit(args.help ? 0 : 2);
  }
  const t0 = Date.now();
  const buf = fs.readFileSync(args.file);
  const opts = { maxRowsPerSheet: 2000000, maxGridCells: 60000000 };
  // xlsx-reader shows a cell with a date-only format as 'YYYY-MM-DD' (what the
  // cell displays) and drops its time of day, but Apps Script getValues()
  // returns the full date-time - and the feed, like openpyxl, writes
  // 'YYYY-MM-DD HH:MM' when that time isn't midnight. So: pass 1 collects the
  // date-only format codes, their (cached, shared) formatInfo entries are
  // marked time:true, and pass 2 keeps the time ('YYYY-MM-DD HH:MM').
  let marked = 0;
  (await xlsx.readWorkbook(buf, opts)).sheets.forEach(function (s) {
    s.numFmts.forEach(function (r) {
      r.forEach(function (code) {
        if (code === null) return;
        const info = xlsx.formatInfo(code);
        if (info.date && !info.time && !info.elapsed) { info.time = true; marked++; }
      });
    });
  });
  const wb = await xlsx.readWorkbook(buf, opts);
  const truncated = wb.sheets.filter(function (s) { return s.truncated; }).map(function (s) { return s.name; });
  if (truncated.length) throw new Error('workbook sheets truncated by the reader: ' + truncated.join(', '));
  console.log('read ' + path.basename(args.file) + ': ' + wb.sheets.length + ' sheets in ' + (Date.now() - t0) + ' ms' +
    (marked ? ' (date-only formats read with their time of day)' : ''));

  // a throw-away token for this run only (the real one lives in the script properties)
  const token = crypto.randomBytes(16).toString('hex');
  const env = mock.loadCodeGs(wb, { props: { AB_FEED_TOKEN: token } });

  const parts = [
    { part: 'main', expected: loadWindowVar(args.dashboard, 'SB_DATA'), ignore: ['generated', 'source'] },
    { part: 'history', expected: loadWindowVar(args.history, 'SB_HISTORY'), ignore: [] }
  ];
  let bad = 0;
  parts.forEach(function (p) {
    const t1 = Date.now();
    const resp = env.post({ token: token, action: 'site', part: p.part });
    const ms = Date.now() - t1;
    if (!resp.ok) { console.log('  ' + p.part + ': feed error: ' + resp.error); bad++; return; }
    if (resp.stored !== false) { console.log('  ' + p.part + ': the first answer should be built on demand (stored:false)'); bad++; }
    // the second request is served from the stored copy (Site_Feed tab): same data, byte for byte
    const dataText = env.lastOutput.getContent().replace(/^\{"ok":true,.*?,"data":/, '');
    const again = env.post({ token: token, action: 'site', part: p.part });
    const againText = env.lastOutput.getContent().replace(/^\{"ok":true,.*?,"data":/, '');
    let storedNote;
    if (again.stored !== true) { storedNote = 'the second answer did not come from the stored copy'; bad++; }
    else if (againText !== dataText) { storedNote = 'the stored copy differs from the on-demand answer'; bad++; }
    else storedNote = 'stored copy identical (' + JSON.parse(env.props.getProperty('AB_SITE_FEED_META_' + p.part.toUpperCase())).chunks + ' cells)';
    const json = JSON.stringify(resp);
    if (EMAIL_RE.test(json)) { console.log('  ' + p.part + ': PRIVACY: the feed contains an e-mail address'); bad++; }
    const exp = Object.assign({}, p.expected), got = Object.assign({}, resp.data);
    p.ignore.forEach(function (k) { delete exp[k]; delete got[k]; });
    const list = [];
    diff(exp, got, p.part, list, null);
    console.log(p.part + ': ' + countLeaves(exp) + ' values compared, feed ' + Math.round(json.length / 1024) +
      ' KB in ' + ms + ' ms (mock), readAt ' + (resp.readAt ? 'set' : 'MISSING'));
    if (list.length) { summarize(p.part, list); bad++; } else console.log('  ' + p.part + ': match');
    console.log('  ' + p.part + ': ' + storedNote);
  });
  const elsewhere = env.writes.filter(function (w) { return w.sheet !== 'Site_Feed'; });
  if (elsewhere.length) { console.log('  the feed WROTE outside its Site_Feed tab ' + elsewhere.length + ' time(s)'); bad++; }
  console.log(bad ? 'MISMATCH' : 'OK: the live feed reproduces export_xlsx.py');
  process.exit(bad ? 1 : 0);
}

main().catch(function (e) {
  console.error('compare_site_feed: ' + e.message);
  process.exit(2);
});
