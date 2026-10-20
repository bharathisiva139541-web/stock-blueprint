/* Excel Analysis - worksheet structure, data quality, industries, the rules
   hidden in the formulas, and stock-by-stock views of the Stock Blueprint workbook.
   Two sources:
   (A) the public summary made by tools/analyze_workbook.js (data/workbook-analysis.js
       -> window.SB_WORKBOOK, loaded on demand; personal sheets are structure only);
   (B) a workbook picked by the viewer, parsed by SB.xlsx.readWorkbook and analysed by
       SB.workbookAnalysis in THIS browser only. It is kept in memory (never in
       localStorage), never sent anywhere, and nothing in it is executed. */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, esc = ui.esc, F = ui.F, isNum = ui.isNum, $ = ui.$;
  var WA = SB.workbookAnalysis, XL = SB.xlsx;

  var MAX_MB = 50;
  var MAX_ROWS = 200000;   // same limit as tools/analyze_workbook.js
  var STATUS_CLS = { qualified: 's-good', watch: 's-info', avoid: 's-bad', insufficient: 's-warn', none: '' };
  // the owner's own position columns: never picked as a stock's "key values"
  var PERSONAL_COL_RE = /entry|stop\s*-?\s*loss|exit price|\b(qty|quantity)\b|capital|invested|buy value|sell value|buy price|sell price|avg (buy )?price|profit\s*[\/&]\s*loss|p\s*&\s*l|\bpnl\b/i;
  var NOT_PERSONAL_RE = /working capital|share capital|equity capital|capital (goods|employed|markets?)/i;
  // same patterns as web/lib/workbook-analysis.js (numbers / dates typed as text)
  var NUM_TEXT_RE = /^[+\-]?(\d{1,3}(,\d{2,3})+|\d+)?(\.\d+)?([eE][+\-]?\d+)?%?$/;
  var TEXT_DATE_RE = /^(\d{1,2}[\/\-. ](\d{1,2}|[A-Za-z]{3,9})[\/\-. ]\d{2,4}|[A-Za-z]{3,9} \d{1,2},? \d{4}|\d{4}\/\d{1,2}\/\d{1,2})( \d{1,2}:\d{2}(:\d{2})?)?$/;
  var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  var ERR_HELP = {
    '#N/A': 'lookup found no match (e.g. a symbol missing from the looked-up tab)',
    '#DIV/0!': 'division by zero or by a blank cell',
    '#REF!': 'formula points to a deleted cell or range',
    '#VALUE!': 'wrong kind of value in a calculation',
    '#NAME?': 'unknown function or name',
    '#NUM!': 'invalid number',
    '#ERROR!': 'formula could not be parsed (Google Sheets)',
    'Loading...': 'GOOGLEFINANCE / import still loading when the file was saved'
  };

  // One short line per worksheet (written from the worksheet catalog; no values).
  var PURPOSE = {
    'LearnOrder': 'Hidden symbol / name list in a fixed order; not used by Code.gs (leftover).',
    'Screener_Bridge': 'Cache of screener.in pages sent by the PC bridge: quarterly growth and trend tags per symbol.',
    'Mitigated FVG Log': 'Log of every FVG / gap-up zone that price traded into (intraday or end of day).',
    'FVG Backtest': 'Next-day outcome of every flagged FVG zone or Spring signal.',
    'Main': 'Master watchlist of ~1,800 NSE stocks: classification, prices, results, valuation, signals and technical tags.',
    'Price Band Changes': 'History of NSE price-band (circuit limit) revisions, with impact and whether the stock is in Main.',
    'Results Tracker': 'Results Season engine state: has screener.in published each company\'s expected quarter yet?',
    'Results Performance': 'How stocks moved after this season\'s results: season summary, verdict breakdown, one row per company.',
    'Signal Watchlist Log': 'Every day a stock was flagged by Mitigated FVG or Spring, with the price at flag time.',
    'Risk Manager': 'Personal risk dashboard: risk settings, position-size calculator, portfolio heat, open trades.',
    'Index Legend': 'Key for the index colours on Main\'s SYMBOL cells.',
    'Classification Audit': 'Main rows whose sector / industry differs from the official NSE classification.',
    'UnmitigatedFVG': 'Open (untouched) bullish FVG zones per symbol, watched for approach / mitigation alerts.',
    'GapUpFVG': 'Open overnight gap-up zones, watched for approach / mitigation alerts.',
    'SmartDashboard': 'Interactive screener over Main: trend, Buy / Avoid, industry and range filters.',
    'Control Panel': 'Personal settings read by Code.gs (ab_setting_); blank rows fall back to the coded defaults.',
    'Priceband': 'Paste area for NSE price-band changes (imported into Price Band Changes).',
    'Trade Dashboard': 'Personal summary of real trades: counts, win rate, reward : risk, latest resolved trades.',
    'TrendlyneIDs': 'Empty hidden tab, not used by Code.gs (leftover).',
    'Trade Log': 'Personal: one row per resolved real trade, graded Win / Loss.',
    'IPOs': 'IPO master list: price vs listing price and the IPO Base levels.',
    'New IPOs': 'Paste area for newly listed securities; "Add new IPOs" moves them into IPOs and Main.',
    'Alert Log': 'Log of every triggered price alert (Breakout / Price Fall / Entry) with tags and outcome.',
    'Alert Dashboard': 'Hit rate and average move by alert type, plus the 20 latest alerts.',
    'GF_Scratch': 'Scratch area where the script writes, reads and clears GOOGLEFINANCE formulas.',
    'BasicIndustry PE': 'Industry PE per NSE basic industry (the lookup source of Main\'s Industry PE).',
    'Portfolio': 'Personal portfolio and trade journal: buy / sell rows, P&L, weightage.',
    'Pivot': 'Basic-industry movement: day / 10-day / 30-day averages, advancers, top gainer / loser.',
    'Indextracker': 'NSE index tracker: level, day change, 1 / 5 / 10-year levels and returns.',
    'Results': 'NSE results calendar pasted by you; the source of Main\'s Result Date.',
    'Pattern Dashboard': 'The day\'s technical signals: KPI tiles, per-signal summary, industry clusters, confluence list.',
    'Day4': 'Daily OHLCV, 4th-most-recent candle per symbol (input to pattern detection).',
    'History30': 'Last 30 daily candles per symbol: input for FVG, EMA support, ATR and backtests.',
    'ThirdDay': 'Daily OHLCV, 3rd-most-recent candle per symbol.',
    'Yesterday': 'Daily OHLCV, previous candle per symbol (also Main\'s Prev Day Vol).',
    'Today': 'Daily OHLCV of the latest candle per symbol.',
    'PatternData': 'Per-symbol output of the technical engines; Main reads Pattern / FVG / EMA / ATR from it.',
    'AutoFetch Log': 'Run log: one row per pipeline phase or menu run.'
  };

  // Ambiguities found while reviewing Code.gs and the sheet (static; need the owner's confirmation).
  var KNOWN = [
    { title: 'Two TTM Signal formula variants in Main',
      text: 'Most rows of "TTM Signal" only compare TargetPrice with MKT Price. Only the rows fixed by ab_fixSignalFormulas_ also give "Avoid" when TTM EPS growth < 0 or TTM EPS ≤ 0. The dashboard uses the fixed rule for every stock. The "Signal" column has the same two variants.' },
    { title: 'Gap-up FVG largest gap: 5 % in the sheet, 10 % in the code',
      text: 'AB_GAPUP_MAX_PCT is 5 in your Control Panel but defaults to 10 in Code.gs. Which one do you mean?' },
    { title: 'Trade "Win": measured from the entry price, help text says the alert price',
      text: 'resolveTradesEOD_ grades a trade Win at entry × (1 + AB_TRADE_WIN_PCT / 100), while the comment and help text say "above the ALERT price". The dashboard follows the code (from entry).' }
  ];

  // Public source: tabs whose rows are already in the dashboard snapshot (data/dashboard.js).
  function snapTable(key, sym, name, keys) {
    return function (D) {
      var t = D && D[key];
      if (key === 'resultsPerf') t = D && D.resultsPerf && D.resultsPerf.table;
      if (key === 'patterns') t = D && D.patterns && D.patterns.stocks;
      return t && t.cols ? { rows: ui.objRows(t), sym: sym, name: name, keys: keys } : null;
    };
  }
  var SNAP = {
    'Main': function (D, ctx) {
      return { rows: ctx.stocks, sym: 'sym', name: 'name', keys: [['rdate', 'Result date', 'date'], ['up', 'Upside', 'pct'], ['pe', 'PE', 'num'], ['pat', 'Pattern', 'text']] };
    },
    'Results Tracker': snapTable('resultsTracker', 'Symbol', 'Company', [['Result Date', 'Result date', 'date'], ['Quarter Expected', 'Expected', 'text'], ['Status', 'Status', 'badge']]),
    'Results Performance': snapTable('resultsPerf', 'Symbol', 'Company', [['Result Date', 'Result date', 'date'], ['% Since Results', 'Since results', 'pct'], ['Results Verdict', 'Verdict', 'badge']]),
    'UnmitigatedFVG': snapTable('fvg', 'Symbol', null, [['Zone Bottom', 'Zone bottom', 'price'], ['Zone Top', 'Zone top', 'price'], ['Formed', 'Formed', 'date'], ['Status', 'Status', 'badge']]),
    'GapUpFVG': snapTable('gapup', 'Symbol', null, [['Gap Bottom', 'Gap bottom', 'price'], ['Gap Top', 'Gap top', 'price'], ['Formed', 'Formed', 'date'], ['Status', 'Status', 'badge']]),
    'Signal Watchlist Log': snapTable('watchLog', 'Symbol', 'Name', [['Date Flagged', 'Flagged', 'date'], ['Source', 'Source', 'text'], ['Price At Flag', 'Price at flag', 'price']]),
    'FVG Backtest': snapTable('fvgBacktest', 'Symbol', null, [['Flagged On', 'Flagged', 'date'], ['Zone Type', 'Zone type', 'text'], ['Category', 'Outcome', 'badge']]),
    'Mitigated FVG Log': snapTable('mitigatedLog', 'Symbol', null, [['Date', 'Date', 'date'], ['Type', 'Type', 'text'], ['Zone Bottom', 'Zone bottom', 'price']]),
    'Alert Log': snapTable('alerts', 'Symbol', 'Company', [['Date', 'Date', 'date'], ['Alert Type', 'Alert type', 'text'], ['Outcome', 'Outcome', 'badge']]),
    'IPOs': snapTable('ipos', 'NSE SYMBOL', null, [['LISTING DATE', 'Listing date', 'date'], ['LISTING PRICE', 'Listing price', 'price'], ['Base Status', 'Base status', 'text']]),
    'New IPOs': snapTable('newIpos', 'Symbol', 'COMPANY NAME', [['DATE OF LISTING', 'Listing date', 'date'], ['SECURITY TYPE', 'Type', 'text']]),
    'Price Band Changes': snapTable('priceBands', 'Symbol', 'Company', [['Report Date', 'Report date', 'date'], ['Impact', 'Impact', 'text'], ['To %', 'New band', 'text']]),
    'Pattern Dashboard': snapTable('patterns', 'Symbol', 'Company', [['Pattern', 'Pattern', 'text'], ['FVG', 'FVG', 'text'], ['Confluence', 'Confluence', 'num']])
  };

  // ---------- state: memory only (an uploaded workbook is never written to storage) ----------
  var ST = { source: 'public', sheet: { public: null, upload: null }, block: {}, cat: '', q: '', colQ: '', scope: 'sheet' };
  var UP = null;                                   // { file, wb, analysis, master, readMs, analyzeMs, cache }
  var JOB = { id: 0, busy: false, text: '', pct: 0, error: null, fileName: '' };
  var PG = null;                                   // the page currently shown (re-created on every visit)

  // ---------- small helpers ----------
  function blank(v) { return v == null || (typeof v === 'string' && v.trim() === ''); }
  function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function stamp(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function mb(n) { return (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' MB'; }
  function slug(s) { return String(s || 'sheet').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'sheet'; }
  function letter(i) { return XL.colToLetters(i); }
  function colIdx(l) { return XL.lettersToCol(String(l || '')); }
  function sub(t) { return '<span class="sub">' + esc(t) + '</span>'; }
  function dash() { return '<span class="sub">–</span>'; }
  function fmtN(v) { return isNum(v) ? F.num(v, Math.abs(v) >= 100 ? 2 : 4) : '–'; }
  function code(f, n, nowrap) {
    return '<code style="font-size:12px;' + (nowrap ? 'white-space:nowrap' : 'overflow-wrap:anywhere;white-space:pre-wrap') + '" title="' + esc(clip(f, 1000)) + '">' +
      esc(clip(f, n || 120)) + '</code>';
  }
  function csv(rows) { return WA.toCsv(rows, { bom: true, escapeFormulas: true }); }
  function alive(pg) { return !!pg && pg === PG && pg.el.isConnected; }
  /** Normalized key: header lower-cased, every run of non-alphanumerics -> '_'. */
  function colKey(c) {
    var k = c.header ? String(c.header).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') : '';
    return k || 'col_' + String(c.letter).toLowerCase();
  }
  function personalCol(c) { return !!(c && c.header && PERSONAL_COL_RE.test(c.header) && !NOT_PERSONAL_RE.test(c.header)); }
  /** Values (samples, min / max / mean, distinct values) stay hidden for personal sheets and position columns, in both sources. */
  function hideValues(sh, c) { return !!(sh.personal || sh.publicStructureOnly || (c && (c.redacted || personalCol(c)))); }
  function stateTag(s) {
    return s === 'hidden' ? ui.badge('hidden', 's-warn') : s === 'veryHidden' ? ui.badge('very hidden', 's-bad') : ui.badge(s || 'visible', '');
  }
  function scrollToId(id) {
    var t = PG && $('#' + id, PG.el);
    if (!t) return;
    var top = document.querySelector('.top'), off = (top ? top.offsetHeight : 0) + 8;
    var y = t.getBoundingClientRect().top + window.pageYOffset - off;
    var smooth = !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    window.scrollTo({ top: Math.max(0, y), behavior: smooth ? 'smooth' : 'auto' });
  }
  function setHash() {
    var s = ST.sheet[ST.source];
    try { window.history.replaceState(null, '', '#excel/' + ST.source + (s ? '/' + encodeURIComponent(s) : '')); } catch (e) { /* ignore */ }
  }
  function findSheet(name) {
    var list = PG && PG.A ? PG.A.sheets || [] : [];
    for (var i = 0; i < list.length; i++) if (list[i].name === name) return list[i];
    return null;
  }
  function defaultSheet(A) {
    var list = A.sheets || [];
    return list.filter(function (s) { return s.name === 'Main'; })[0] || list.filter(function (s) { return s.state === 'visible' && s.dataRows; })[0] || list[0] || null;
  }
  function readerSheet(name) {
    if (!UP) return null;
    for (var i = 0; i < UP.wb.sheets.length; i++) if (UP.wb.sheets[i].name === name) return UP.wb.sheets[i];
    return null;
  }

  // ---------- upload: validate -> read -> analyse (in this browser only) ----------
  function validateFile(f) {
    var m = /\.([a-z0-9]+)$/i.exec(f.name || ''), ext = m ? m[1].toLowerCase() : '';
    if (ext !== 'xlsx' && ext !== 'xlsm') {
      return { code: 'BAD_TYPE', message: ext === 'xls' ? 'old .xls workbooks are not supported - open the file in Excel or Google Sheets and save / download it as .xlsx.' :
        'choose an Excel workbook (.xlsx or .xlsm)' + (ext ? '; this file is .' + ext : '') + '.' };
    }
    if (!f.size) return { code: 'EMPTY', message: 'the file is empty.' };
    if (f.size > MAX_MB * 1048576) return { code: 'TOO_BIG', message: 'the file is ' + mb(f.size) + '; the limit is ' + MAX_MB + ' MB.' };
    return null;
  }
  function readFile(file) {
    if (file.arrayBuffer) return file.arrayBuffer();
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(fr.error || new Error('could not read the file')); };
      fr.readAsArrayBuffer(file);
    });
  }
  function progress(text, pct) {
    JOB.text = text; JOB.pct = pct;
    var el = PG && PG.el;
    if (!el) return;
    var t = $('#xa-prog-t', el), b = $('#xa-prog-b', el);
    if (t) t.textContent = text;
    if (b) b.style.width = Math.max(2, Math.min(100, pct)).toFixed(0) + '%';
  }
  function summarize(wb, sheets, master) {
    var names = wb.sheetNames || wb.sheets;
    var s = { sheetCount: names.length, analyzedSheets: sheets.length, visible: 0, hidden: 0, veryHidden: 0, totalRows: 0, totalDataRows: 0,
      totalFormulaCells: 0, totalErrorCells: 0, personalSheets: [], sheetsWithErrors: [], sheetsWithBlankRows: [], sheetsWithDuplicates: [] };
    names.forEach(function (x) { if (typeof s[x.state] === 'number') s[x.state]++; });
    sheets.forEach(function (a) {
      if (!a.ok) return;
      s.totalRows += a.rows;
      a.blocks.forEach(function (b) { s.totalDataRows += b.dataRows; });
      s.totalFormulaCells += a.formulaCells;
      s.totalErrorCells += a.errorCells;
      if (a.personal) s.personalSheets.push(a.name);
      if (a.errorCells) s.sheetsWithErrors.push({ name: a.name, errors: a.errorCells });
      if (a.quality.blankRowsInside) s.sheetsWithBlankRows.push({ name: a.name, blankRows: a.quality.blankRowsInside });
      if (a.quality.duplicateRows) s.sheetsWithDuplicates.push({ name: a.name, duplicateRows: a.quality.duplicateRows });
    });
    return { ok: true, summary: s, date1904: !!wb.date1904, hasMacros: !!wb.hasMacros, masterSymbols: master ? Object.keys(master).length : 0,
      warnings: (wb.warnings || []).slice(0, 100), sheets: sheets };
  }
  /** Analyse sheet by sheet, yielding to the browser in between (keeps the page responsive). */
  function analyzeAsync(wb, id) {
    return new Promise(function (resolve, reject) {
      var n = wb.sheets.length, i = 0, out = [], master;
      var main = wb.sheets.filter(function (s) { return String(s.name).trim().toLowerCase() === 'main'; })[0];
      function step() {
        if (id !== JOB.id) { resolve(null); return; }
        try {
          if (master === undefined) {
            master = main ? WA.buildMaster(main) : null;
            if (master && !Object.keys(master).length) master = null;
            setTimeout(step, 0);
            return;
          }
          if (i < n) {
            var s = wb.sheets[i];
            progress('Analysing sheet ' + (i + 1) + ' of ' + n + ': ' + s.name, 70 + 29 * i / n);
            setTimeout(function () {
              if (id !== JOB.id) { resolve(null); return; }
              try {
                var a = WA.analyzeSheet(s, { master: master, publicMode: false });
                out.push(a.ok ? a : { ok: false, name: s.name, state: s.state, reason: a.reason, blocks: [], quality: {} });
                i++;
                setTimeout(step, 0);
              } catch (e) { reject(e); }
            }, 0);
            return;
          }
          var res = summarize(wb, out, master);
          res.master = master;
          resolve(res);
        } catch (e) { reject(e); }
      }
      progress('Building the stock master from Main…', 68);
      setTimeout(step, 0);
    });
  }
  function handleFile(file) {
    if (!file || (JOB.busy && JOB.fileName === file.name)) return;
    ST.source = 'upload';
    var bad = validateFile(file);
    if (bad) {
      JOB.error = { file: file.name, code: bad.code, message: bad.message };
      setHash();
      if (PG) { setSourceChips(); drawSource(); drawBody(); }
      return;
    }
    var id = ++JOB.id, t0 = Date.now(), tRead = 0;
    JOB.busy = true; JOB.error = null; JOB.fileName = file.name; JOB.text = 'Reading ' + file.name + '…'; JOB.pct = 2;
    setHash();
    if (PG) { setSourceChips(); drawSource(); drawBody(); }
    readFile(file).then(function (buf) {
      if (id !== JOB.id) return null;
      progress('Unzipping the workbook…', 5);
      return XL.readWorkbook(buf, {
        maxRowsPerSheet: MAX_ROWS,
        onProgress: function (p) {
          if (id !== JOB.id || p.phase !== 'sheet') return;
          progress('Reading sheet ' + (p.index + 1) + ' of ' + p.total + ': ' + p.sheet, 5 + 62 * p.done);
        }
      });
    }).then(function (wb) {
      if (!wb || id !== JOB.id) return null;
      tRead = Date.now() - t0;
      return analyzeAsync(wb, id).then(function (an) {
        if (!an || id !== JOB.id) return;
        var master = an.master;
        delete an.master;
        wb.sheets.forEach(function (s) { s.numFmts = null; });      // not needed after the analysis: frees memory
        UP = { file: { name: file.name, size: file.size, modified: file.lastModified || null }, wb: wb, analysis: an, master: master,
          readMs: tRead, analyzeMs: Date.now() - t0 - tRead, cache: {} };
        JOB.busy = false;
        ST.sheet.upload = null; ST.cat = ''; ST.q = '';
      });
    }).catch(function (e) {
      if (id !== JOB.id) return;
      JOB.busy = false;
      JOB.error = { file: file.name, code: (e && e.code) || 'READ_ERROR', message: (e && e.message) || String(e) };
      if (window.console) console.warn('Excel analysis:', e);
    }).then(function () {
      if (id !== JOB.id || !PG || !PG.el.isConnected || ST.source !== 'upload') return;
      setHash();
      drawSource();
      drawBody();
    });
  }
  function clearUpload() {
    JOB.id++;
    JOB.busy = false; JOB.error = null; JOB.fileName = '';
    UP = null;
    ST.sheet.upload = null;
    setHash();
    drawSource();
    drawBody();
    var st = PG && $('#xa-src-msg', PG.el);
    if (st) st.textContent = 'The workbook was removed from this page\'s memory.';
  }

  // ---------- source card ----------
  function setSourceChips() {
    if (!PG) return;
    PG.el.querySelectorAll('[data-chip="xa-src"]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-v') === ST.source)); });
  }
  var PRIVACY = 'Your workbook is read <strong>only inside this browser tab</strong>. It is never uploaded or sent anywhere and it is not saved: ' +
    'it stays in this page\'s memory until you press Clear, reload or close the tab. Macros (VBA) are ignored and never run; formulas are read as text ' +
    'and never executed; external links and embedded objects are not opened or fetched. The original file is never changed.';
  function drawSource() {
    var pg = PG;
    if (!pg) return;
    var host = $('#xa-src-body', pg.el);
    if (!host) return;
    var h;
    if (ST.source === 'public') {
      var W = window.SB_WORKBOOK;
      if (!W) { host.innerHTML = ui.skeleton(2); return; }
      var per = (W.summary && W.summary.personalSheets) || [];
      h = '<div class="tags">' + ui.stateBadge(W.state || 'CACHED', W.generated, 'data/workbook-analysis.js') + ui.badge('Public summary', 's-info') + '</div>' +
        '<p style="margin-top:8px">Made from <b>' + esc(W.source || 'the workbook') + '</b>' + (W.sourceModified ? ' (file saved ' + esc(F.dateTime(W.sourceModified)) + ')' : '') +
        ' by tools/analyze_workbook.js on ' + esc(F.dateTime(W.generated)) + '. It is a saved copy, not live.</p>' +
        '<div class="note" style="margin-top:8px"><strong>Personal sheets are summarised by structure only</strong>' + (per.length ? ' (' + per.map(esc).join(', ') + ')' : '') +
        ': sheet names, row / column counts, headers and types - no values, samples, titles or formulas. Personal-looking columns on other sheets ' +
        '(entry price, stop-loss, quantity, capital, P&amp;L) are hidden the same way. For full detail, analyse the workbook in this browser.</div>';
    } else {
      h = '<div class="note good">' + PRIVACY + '</div>';
      if (UP) {
        var an = UP.analysis, warn = an.warnings || [];
        h += '<div class="controls" style="margin:12px 0 0"><span>' + ui.badge('In memory only', 's-good') + ' <b>' + esc(UP.file.name) + '</b> <span class="sub">' + esc(mb(UP.file.size)) +
          ' · ' + F.int(an.summary.sheetCount) + ' worksheets · read in ' + F.num(UP.readMs / 1000, 1) + ' s, analysed in ' + F.num(UP.analyzeMs / 1000, 1) + ' s' +
          (UP.file.modified ? ' · file saved ' + esc(F.dateTime(stamp(UP.file.modified))) : '') + '</span></span>' +
          '<span class="count" style="display:flex;gap:8px"><button class="btn" type="button" data-pick>Analyse another file</button><button class="btn danger" type="button" id="xa-clear">Clear</button></span></div>' +
          (an.hasMacros ? '<div class="note warn" style="margin-top:8px">This workbook contains macros (VBA). They were ignored and never run.</div>' : '') +
          (warn.length ? '<details style="margin-top:8px"><summary class="sub">' + warn.length + ' reader note' + (warn.length === 1 ? '' : 's') + '</summary><ul style="margin:6px 0 0 18px;padding:0" class="sub">' +
            warn.slice(0, 30).map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul></details>' : '');
      } else if (!JOB.busy) {
        h += '<div id="xa-drop" class="note" style="margin-top:12px;border:2px dashed var(--border-strong);text-align:center;padding:22px 14px">' +
          '<p><b>Drop an .xlsx or .xlsm workbook here</b></p>' +
          '<p style="margin-top:10px"><button class="btn primary" type="button" data-pick>Choose a workbook…</button></p>' +
          '<p class="sub" style="margin-top:10px">Up to ' + MAX_MB + ' MB. Tip: in Google Sheets use File › Download › Microsoft Excel (.xlsx).</p></div>';
      }
      if (JOB.busy) {
        h += '<div id="xa-prog" role="status" aria-live="polite" style="margin-top:12px"><div id="xa-prog-t">' + esc(JOB.text) + '</div>' +
          '<div class="meter" style="margin-top:6px;height:8px"><span id="xa-prog-b" style="width:' + Math.max(2, JOB.pct).toFixed(0) + '%"></span></div>' +
          '<p class="sub" style="margin-top:6px">Large workbooks take a few seconds. Everything happens in this tab.</p></div>';
      }
      if (JOB.error) {
        h += '<div class="note bad" role="alert" style="margin-top:12px"><strong>Could not analyse "' + esc(JOB.error.file) + '"</strong> (' + esc(JOB.error.code) + '): ' + esc(JOB.error.message) + '</div>';
      }
      h += '<input id="xa-file" type="file" accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel.sheet.macroEnabled.12" hidden>' +
        '<p id="xa-src-msg" class="sub" role="status" style="margin-top:6px"></p>';
    }
    host.innerHTML = h;
    var drop = $('#xa-drop', pg.el);
    if (drop) {
      var on = function (e) { e.preventDefault(); drop.style.borderColor = 'var(--accent)'; drop.style.background = 'var(--accent-wash)'; };
      var off = function () { drop.style.borderColor = 'var(--border-strong)'; drop.style.background = ''; };
      drop.addEventListener('dragenter', on);
      drop.addEventListener('dragover', on);
      drop.addEventListener('dragleave', off);
      drop.addEventListener('drop', off);
    }
  }

  // ---------- body ----------
  function drawBody() {
    var pg = PG;
    if (!pg) return;
    var body = $('#xa-body', pg.el);
    pg.A = null;
    if (ST.source === 'public') {
      if (window.SB_WORKBOOK) { drawAnalysis(window.SB_WORKBOOK, 'public'); return; }
      body.innerHTML = '<section class="card">' + ui.skeleton(8) + '</section>';
      ui.loadScript('data/workbook-analysis.js').then(function () {
        if (!alive(pg) || ST.source !== 'public') return;
        if (!window.SB_WORKBOOK || !window.SB_WORKBOOK.sheets) throw new Error('data/workbook-analysis.js has no analysis (run tools/analyze_workbook.js)');
        drawSource();
        drawBody();
      }).catch(function (e) {
        if (!alive(pg) || ST.source !== 'public') return;
        body.innerHTML = '<div class="note bad">The public workbook summary could not be loaded: ' + esc(e.message) + '. You can still analyse a workbook in this browser.</div>';
        var s = $('#xa-src-body', pg.el);
        if (s) s.innerHTML = ui.stateBadge('UNAVAILABLE');
      });
      return;
    }
    if (JOB.busy) { body.innerHTML = '<section class="card">' + ui.skeleton(8) + '</section>'; return; }
    if (!UP) {
      body.innerHTML = '<section class="card"><p class="empty">Choose or drop a workbook above to see its worksheets, data quality, industries and rules here.</p></section>';
      return;
    }
    drawAnalysis(UP.analysis, 'upload');
  }

  function drawAnalysis(A, mode) {
    var pg = PG;
    pg.A = A; pg.mode = mode;
    var body = $('#xa-body', pg.el);
    body.innerHTML = overviewHtml(A) + '<section class="card" id="xa-sel"></section><div id="xa-sheetwrap" style="display:grid;gap:16px"></div>';
    new ui.Table({ rows: overviewRows(A), pageSize: 60, columns: overviewColumns(), empty: 'No worksheets' }).mount($('#xa-ov-t', pg.el));
    drawSheet();
  }

  // ---------- 1. workbook overview ----------
  function overviewRows(A) {
    return (A.sheets || []).map(function (sh, i) {
      var q = sh.quality || {};
      return { i: i + 1, name: sh.name, state: sh.state || 'visible', purpose: PURPOSE[sh.name] || '', rows: sh.rows, cols: sh.cols, blocks: sh.blockCount,
        formulas: sh.formulaCells, errors: sh.errorCells, blank: q.blankRowsInside || 0, dups: q.duplicateRows || 0, personal: !!sh.personal,
        reasons: (sh.personalReasons || []).join('; '), so: !!sh.publicStructureOnly, failed: sh.ok === false };
    });
  }
  function overviewColumns() {
    return [
      { key: 'i', label: '#', type: 'num', digits: 0 },
      { key: 'name', label: 'Worksheet', html: function (r) { return '<button type="button" class="linkish" data-sheet="' + esc(r.name) + '">' + esc(r.name) + '</button>' + (r.failed ? ' ' + ui.badge('not analysed', 's-bad') : ''); } },
      { key: 'state', label: 'State', html: function (r) { return r.state === 'visible' ? sub('visible') : stateTag(r.state); } },
      { key: 'purpose', label: 'Purpose', wrap: true, html: function (r) { return r.purpose ? '<span style="display:block;min-width:250px">' + esc(r.purpose) + '</span>' : dash(); } },
      { key: 'rows', label: 'Rows', type: 'num', digits: 0 },
      { key: 'cols', label: 'Columns', type: 'num', digits: 0 },
      { key: 'blocks', label: 'Tables', type: 'num', digits: 0, title: 'Separate tables (header + data block) found on the sheet' },
      { key: 'formulas', label: 'Formula cells', type: 'num', digits: 0 },
      { key: 'errors', label: 'Error cells', type: 'num', digits: 0 },
      { key: 'blank', label: 'Blank rows', type: 'num', digits: 0, title: 'Blank rows inside the data' },
      { key: 'dups', label: 'Duplicates', type: 'num', digits: 0, title: 'Rows whose key (symbol, or symbol + date) repeats' },
      { key: 'personal', label: 'Personal', get: function (r) { return r.personal ? 'Personal' : ''; },
        html: function (r) { return r.personal ? '<span data-tip="' + esc(r.reasons) + '">' + ui.badge(r.so ? 'Personal · structure only' : 'Personal', 's-warn') + '</span>' : dash(); } }
    ];
  }
  function overviewHtml(A) {
    var s = A.summary || {}, sheets = A.sheets || [], blocks = 0;
    sheets.forEach(function (sh) { blocks += sh.blockCount || 0; });
    var hid = (s.hidden || 0) + (s.veryHidden || 0), per = s.personalSheets || [];
    var flagged = {};
    (s.sheetsWithDuplicates || []).concat(s.sheetsWithBlankRows || []).forEach(function (x) { flagged[x.name] = 1; });
    var tiles = '<div class="tiles">' +
      ui.tile('Worksheets', F.int(s.sheetCount), esc(F.int(s.visible) + ' visible · ' + F.int(hid) + ' hidden' + (s.veryHidden ? ' (' + s.veryHidden + ' very hidden)' : ''))) +
      ui.tile('Data rows', F.int(s.totalDataRows), esc(F.int(blocks) + ' tables detected')) +
      ui.tile('Formula cells', F.int(s.totalFormulaCells), 'read as text, never run') +
      ui.tile('Error cells', F.int(s.totalErrorCells), esc('in ' + (s.sheetsWithErrors || []).length + ' sheet' + ((s.sheetsWithErrors || []).length === 1 ? '' : 's') + ' (#N/A, #DIV/0! …)')) +
      ui.tile('Personal sheets', F.int(per.length), PG.mode === 'public' ? 'structure only in this summary' : 'shown only in this browser') +
      ui.tile('Sheets to tidy', F.int(Object.keys(flagged).length), 'duplicate keys or blank rows inside data') +
      '</div>';
    return '<section class="card" id="xa-ov"><div class="card-head"><div><h2>Workbook overview</h2><p>' +
      (PG.mode === 'public' ? 'Public summary of your sheet export' : 'Your workbook, analysed in this browser') +
      '. Click a worksheet (or use the selector below) to see its analysis.</p></div></div>' + tiles +
      '<div id="xa-ov-t" style="margin-top:14px"></div></section>';
  }

  // ---------- 2. selector + per-sheet panel ----------
  function selectorHtml() {
    var sheets = PG.A.sheets || [], sh = PG.sheet, i = sheets.indexOf(sh);
    var opts = sheets.map(function (s) {
      return '<option value="' + esc(s.name) + '"' + (s === sh ? ' selected' : '') + '>' + esc(s.name + ' · ' + F.int(s.dataRows || 0) + ' rows' +
        (s.state && s.state !== 'visible' ? ' · ' + s.state : '') + (s.personal ? ' · personal' : '')) + '</option>';
    }).join('');
    var jumps = [['xa-sheet', 'Columns'], ['xa-q', 'Data quality'], ['xa-ind', 'Industries'], ['xa-rules', 'Rules'], ['xa-stocks', 'Stocks'], ['xa-stats', 'Statistics'], ['xa-exp', 'Exports']];
    return '<div class="card-head"><div><h2>Worksheet</h2><p>' + (sh ? 'Sheet ' + (i + 1) + ' of ' + sheets.length + '. ' : '') +
      'Every section below is about this worksheet.</p></div></div>' +
      '<div class="controls"><button class="btn" type="button" id="xa-prev" aria-label="Previous worksheet">‹ Prev</button>' +
      '<label class="sr-only" for="xa-sheet-sel">Worksheet</label><select class="sel" id="xa-sheet-sel" style="flex:1 1 220px;min-width:0">' + opts + '</select>' +
      '<button class="btn" type="button" id="xa-next" aria-label="Next worksheet">Next ›</button></div>' +
      '<div class="chips" role="group" aria-label="Jump to a section">' + jumps.map(function (j) {
        return '<button type="button" class="chip" data-jump="' + j[0] + '">' + esc(j[1]) + '</button>';
      }).join('') + '</div>';
  }

  function blockLabel(b, i) {
    return 'Table ' + (i + 1) + (b.title && b.title[0] ? ': ' + clip(b.title[0], 34) : b.firstDataRow ? ' · rows ' + b.firstDataRow + '–' + b.lastDataRow : '');
  }
  function sheetCard() {
    var sh = PG.sheet, b = PG.block;
    var h = '<section class="card" id="xa-sheet"><div class="card-head"><div><h2>' + esc(sh.name) + '</h2><p>' + esc(PURPOSE[sh.name] || 'No description for this worksheet.') +
      '</p></div><div class="tags">' + stateTag(sh.state) + (sh.personal ? ui.badge('Personal', 's-warn') : '') +
      (sh.publicStructureOnly ? ui.badge('Structure only', 's-warn') : '') + (sh.truncated ? ui.badge('Truncated', 's-warn') : '') + '</div></div>';
    if (sh.ok === false) return h + '<div class="note bad">This worksheet could not be analysed: ' + esc(sh.reason || 'unknown reason') + '</div></section>';
    if (sh.personal) {
      h += sh.publicStructureOnly ?
        '<div class="note warn"><strong>Personal sheet.</strong> The public summary keeps only its structure (headers, types, counts) - no values, samples, titles or formulas.' +
          (sh.personalReasons && sh.personalReasons.length ? ' Detected by: ' + esc(sh.personalReasons.join('; ')) + '.' : '') + '</div>' :
        '<div class="note warn"><strong>Personal sheet</strong>' + (sh.personalReasons && sh.personalReasons.length ? ' (' + esc(sh.personalReasons.join('; ')) + ')' : '') +
          '. Shown only in this browser; samples and row values are hidden on this page.</div>';
    }
    var kv = [
      ['Used range', F.int(sh.rows) + ' rows × ' + F.int(sh.cols) + ' columns'],
      ['Non-empty rows', F.int(sh.nonEmptyRows)],
      ['Tables found', F.int(sh.blockCount) + (sh.blockCount > 1 ? ' (main: table ' + (sh.primaryBlock + 1) + ')' : '')],
      ['Formula cells', F.int(sh.formulaCells)],
      ['Error cells', F.int(sh.errorCells)],
      ['Updated (from the title)', sh.updated && /\d/.test(sh.updated) ? esc(sh.updated) : '–']
    ];
    if (sh.truncated) kv.push(['Truncated', 'only the first ' + F.int(MAX_ROWS) + ' rows were read']);
    h += '<dl class="kv" style="margin-top:4px">' + kv.map(function (p) { return '<div><dt>' + esc(p[0]) + '</dt><dd>' + p[1] + '</dd></div>'; }).join('') + '</dl>';
    if (!b) return h + '<p class="empty">This worksheet is empty.</p></section>';
    if (sh.blockCount > 1) {
      h += '<h3 style="margin-top:16px">Tables on this sheet</h3><p class="sub">This sheet holds ' + sh.blockCount + ' separate tables; each is analysed on its own. Pick one:</p>' +
        '<div style="margin-top:8px">' + ui.chips('xa-blk', sh.blocks.map(function (x, i) { return [i, blockLabel(x, i)]; }), PG.bi) + '</div>' +
        '<div id="xa-blocks-t" style="margin-top:10px"></div>';
    }
    h += '<h3 style="margin-top:16px">' + (sh.blockCount > 1 ? esc(blockLabel(b, PG.bi)) : 'Layout') + '</h3>' +
      '<p class="sub" style="margin-top:2px">' + (b.headerRow ? 'Header row ' + b.headerRow + (b.groupHeaderRow ? ' (group headers on row ' + b.groupHeaderRow + ')' : '') : 'No header row found') +
      (b.firstDataRow ? ' · data rows ' + b.firstDataRow + '–' + b.lastDataRow + ' (' + F.int(b.dataRows) + ')' : ' · no data rows') +
      (b.firstColumn ? ' · columns ' + esc(b.firstColumn) + '–' + esc(b.lastColumn) + ' (' + b.columnCount + ')' : '') +
      (b.emptyColumnsOmitted ? ' · ' + b.emptyColumnsOmitted + ' empty column' + (b.emptyColumnsOmitted === 1 ? '' : 's') + ' not listed' : '') + '</p>' +
      (b.title && b.title.length ? '<p class="sub" style="margin-top:4px">Title: ' + b.title.map(function (t) { return esc(clip(t, 140)); }).join(' / ') + '</p>' : '');
    var det = [['Symbol', b.symbolColumn], ['Name', b.nameColumn], ['Sector', b.sectorColumn], ['Industry', b.industryColumn], ['Basic industry', b.basicIndustryColumn]];
    h += '<div class="tags" style="margin-top:8px">' + det.map(function (d) {
      var c = d[1];
      return c ? ui.badge(d[0] + ': ' + c.letter + ' · ' + (c.header || '') + (c.detectedBy === 'content' ? ' (by content)' : ''), 's-info') : ui.badge(d[0] + ': not found', '');
    }).join('') + '</div>';
    h += '<h3 style="margin-top:16px">Columns</h3><p class="sub">Original header as written in the sheet, the normalized key (lower case, other characters → _), inferred type and profile. ' +
      'Percent scale: "fraction" means 0.05 is shown as 5 %; "percent" means 5 is 5 %.' + (hideValues(sh) ? ' Samples are hidden for personal sheets.' : '') + '</p>' +
      '<div class="controls" style="margin-top:8px"><input class="search" id="xa-colq" type="search" placeholder="Filter columns (header, key, type)" aria-label="Filter columns" value="' + esc(ST.colQ) + '">' +
      '<span class="count" id="xa-colq-n"></span></div><div id="xa-cols-t"></div>';
    return h + '</section>';
  }
  function columnColumns(sh) {
    return [
      { key: 'index', label: 'Col', html: function (c) { return '<b>' + esc(c.letter) + '</b>'; } },
      { key: 'header', label: 'Original header', wrap: true, html: function (c) {
        return (c.header ? esc(c.header) : sub('(no header)')) + (c.group ? '<span class="co">group: ' + esc(c.group) + '</span>' : '') + (c.redacted || personalCol(c) ? ' ' + ui.badge('values hidden', 's-warn') : '');
      } },
      { key: 'key', label: 'Key', get: colKey, html: function (c) { return code(colKey(c), 40, true); } },
      { key: 'type', label: 'Type' },
      { key: 'fillPct', label: 'Fill %', type: 'num', digits: 1 },
      { key: 'filled', label: 'Filled', type: 'num', digits: 0 },
      { key: 'missing', label: 'Missing', type: 'num', digits: 0 },
      { key: 'errors', label: 'Errors', type: 'num', digits: 0 },
      { key: 'distinct', label: 'Distinct', type: 'num', digits: 0, html: function (c) { return c.distinct == null ? dash() : F.int(c.distinct) + (c.distinctCapped ? '+' : ''); } },
      { key: 'min', label: 'Min', type: 'num', get: function (c) { return isNum(c.min) ? c.min : null; }, html: function (c) { return hideValues(sh, c) ? sub('hidden') : isNum(c.min) ? fmtN(c.min) : c.minDate ? esc(c.minDate) : dash(); } },
      { key: 'max', label: 'Max', type: 'num', get: function (c) { return isNum(c.max) ? c.max : null; }, html: function (c) { return hideValues(sh, c) ? sub('hidden') : isNum(c.max) ? fmtN(c.max) : c.maxDate ? esc(c.maxDate) : dash(); } },
      { key: 'mean', label: 'Mean', type: 'num', get: function (c) { return isNum(c.mean) ? c.mean : null; }, html: function (c) { return hideValues(sh, c) ? sub('hidden') : fmtN(c.mean); } },
      { key: 'numFmt', label: 'Number format', html: function (c) { return c.numFmt ? code(c.numFmt, 22, true) : dash(); } },
      { key: 'pctScale', label: '% scale', html: function (c) { return c.pctScale ? esc(c.pctScale) : dash(); } },
      { key: 'fcells', label: 'Formula cells', type: 'num', digits: 0, get: function (c) { return c.formula ? c.formula.cells : 0; } },
      { key: 'fex', label: 'Example formula', wrap: true, get: function (c) { return c.formula && c.formula.example; },
        html: function (c) { return c.formula && c.formula.example ? '<span style="display:block;min-width:230px">' + code(c.formula.example, 72) + '</span>' : c.formula ? sub('hidden') : dash(); } },
      { key: 'samples', label: 'Samples', wrap: true, get: function (c) { return (c.samples || []).join(' | '); },
        html: function (c) { return hideValues(sh, c) ? sub('hidden (personal)') : c.samples && c.samples.length ? '<span style="display:block;min-width:230px">' + esc(clip(c.samples.join(' | '), 96)) + '</span>' : dash(); } }
    ];
  }
  function filteredColumns() {
    var q = ST.colQ.trim().toLowerCase(), cols = PG.block ? PG.block.columns || [] : [];
    if (!q) return cols;
    return cols.filter(function (c) { return ui.textMatch(q, [c.letter, c.header, c.group, colKey(c), c.type]); });
  }

  // ---------- 3. data quality ----------
  /** Upload only: first rows / cells of each problem, read from the in-memory grid. */
  function scanBlock(sh, b) {
    var key = 'scan|' + sh.name + '|' + PG.bi;
    if (UP.cache[key]) return UP.cache[key];
    var rs = readerSheet(sh.name), out = { missing: {}, textDate: {}, numText: {}, err: {} };
    UP.cache[key] = out;
    if (!rs || !b.firstDataRow || !b.firstColumn) return out;
    var c0 = colIdx(b.firstColumn), c1 = colIdx(b.lastColumn);
    function push(map, k, v) { var a = map[k] || (map[k] = []); if (a.length < 5) a.push(v); }
    for (var r = b.firstDataRow - 1; r <= b.lastDataRow - 1; r++) {
      var row = rs.rows[r] || [], any = false, c;
      for (c = 0; c < row.length; c++) if (!blank(row[c])) { any = true; break; }
      if (!any) continue;
      for (c = c0; c <= c1; c++) {
        var v = row[c];
        if (blank(v)) { push(out.missing, c, r + 1); continue; }
        if (typeof v !== 'string') continue;
        var s = v.trim();
        if (WA.isErrorValue(s)) { push(out.err, s, letter(c) + (r + 1)); continue; }
        if (/\d/.test(s) && NUM_TEXT_RE.test(s.replace(/\s/g, ''))) push(out.numText, c, r + 1);
        else if (TEXT_DATE_RE.test(s)) push(out.textDate, c, r + 1);
      }
    }
    return out;
  }
  function issuesFor(sh, b) {
    var q = b.quality || {}, out = [];
    var scan = PG.mode === 'upload' ? scanBlock(sh, b) : null;
    function add(check, column, header, count, where, detail) {
      if (count) out.push({ check: check, column: column || '', header: header || '', count: count, where: where || [], detail: detail || '' });
    }
    function hdr(l) { for (var i = 0; i < b.columns.length; i++) if (b.columns[i].letter === l) return b.columns[i].header || ''; return ''; }
    add('Blank rows inside the data', '', '', q.blankRowsInside, (q.blankRows || []).slice(0, 5), 'loops that stop at the first blank row miss every row below it');
    if (q.duplicateKeys) {
      var dk = q.duplicateKeys;
      add('Duplicate keys', '', dk.keyColumns.join(' + '), dk.duplicateRows, (dk.keys || []).slice(0, 5).map(function (k) { return k.key + ' (rows ' + k.rows.join(', ') + ')'; }),
        F.int(dk.distinctKeys) + ' distinct keys; key = ' + dk.keyColumns.join(' + '));
    } else add('Duplicate keys', '', '', q.duplicateRows, [], '');
    var er = q.errors || {}, types = Object.keys(er.byType || {});
    add('Error cells (all types)', '', '', er.total, (er.cells || []).slice(0, 5), types.map(function (t) { return t + ' ' + F.int(er.byType[t]); }).join(', '));
    types.forEach(function (t) { add('Error cells: ' + t, '', '', er.byType[t], scan ? scan.err[t] || [] : [], ERR_HELP[t] || ''); });
    var inc = q.inconsistentSymbols;
    if (typeof inc === 'number') add('Inconsistent symbols', '', '', inc, [], '');
    else if (inc) {
      add('Inconsistent symbols', b.symbolColumn && b.symbolColumn.letter, b.symbolColumn && b.symbolColumn.header, inc.count,
        (inc.items || []).slice(0, 5).map(function (it) { return 'row ' + it.row + ' (' + it.issues.join(', ') + ')'; }), 'lower case, spaces, invalid characters or numbers in the symbol column');
    }
    if (Array.isArray(q.invalidPrices)) {
      q.invalidPrices.forEach(function (p) {
        add('Invalid prices (zero, negative or text)', p.column, p.header, p.count, (p.cells || []).slice(0, 5).map(function (c) { return c.cell; }), 'in a price / target column');
      });
    } else add('Invalid prices (zero, negative or text)', '', '', q.invalidPrices, [], '');
    (q.textDates || []).forEach(function (t) { add('Dates stored as text', t.column, t.header, t.count, scan ? scan.textDate[colIdx(t.column)] || [] : [], 'text dates sort alphabetically, not by date'); });
    (q.numbersAsText || []).forEach(function (t) { add('Numbers stored as text', t.column, t.header, t.count, scan ? scan.numText[colIdx(t.column)] || [] : [], 'text numbers are skipped by sums and comparisons'); });
    var rc = b.reconciliation;
    if (rc) {
      add('Symbols not in Main', b.symbolColumn && b.symbolColumn.letter, b.symbolColumn && b.symbolColumn.header, rc.unmatched, (rc.unmatchedSymbols || []).slice(0, 5), 'not found in the Main tab (the stock master)');
      add('Industry conflicts with Main', '', (rc.fieldsChecked || []).map(function (f) { return f.column; }).join(', '), rc.conflictCount,
        (rc.conflicts || []).slice(0, 5).map(function (c) { return c.symbol + ' row ' + c.row; }), 'sheet value differs from Main');
    }
    if (Array.isArray(q.missing)) {
      q.missing.forEach(function (m) { add('Missing values', m.column, m.header, m.missing, scan ? scan.missing[colIdx(m.column)] || [] : [], F.num(m.missingPct, 1) + '% of data rows blank'); });
    } else add('Columns with missing values', '', '', q.missingColumns, [], 'counts only in the public summary');
    out.forEach(function (it) { if (!it.header && it.column) it.header = hdr(it.column); });
    return out;
  }
  function whereHtml(it) {
    if (!it.where.length) return PG.mode === 'public' && /^(Missing|Dates|Numbers|Error cells:)/.test(it.check) ? sub('not in the public summary') : dash();
    return esc(it.where.join(', ')) + (it.count > it.where.length ? ' …' : '');
  }
  function issueColumns() {
    return [
      { key: 'check', label: 'Check', wrap: true },
      { key: 'column', label: 'Column', get: function (it) { return it.column ? it.column + ' ' + it.header : it.header; },
        html: function (it) { return it.column ? '<b>' + esc(it.column) + '</b> ' + esc(it.header) : it.header ? esc(it.header) : dash(); } },
      { key: 'count', label: 'Count', type: 'num', digits: 0 },
      { key: 'where', label: 'First rows / cells', wrap: true, get: function (it) { return it.where.join(', '); }, html: whereHtml },
      { key: 'detail', label: 'Detail', wrap: true, html: function (it) { return it.detail ? esc(it.detail) : dash(); } }
    ];
  }
  function qualityCard() {
    var sh = PG.sheet, b = PG.block;
    var h = '<section class="card" id="xa-q"><div class="card-head"><div><h2>Data quality' + (sh.blockCount > 1 && b ? ' · ' + esc(blockLabel(b, PG.bi)) : '') + '</h2>' +
      '<p>Problems found in ' + esc(sh.name) + ', with counts and the first few row numbers (Excel rows). Row numbers come from the workbook analysed in this browser; ' +
      'the public summary keeps some of them.</p></div></div>';
    if (!b) return h + '<p class="empty">Nothing to check: the worksheet is empty.</p></section>';
    var q = b.quality || {}, missingCells = 0;
    (b.columns || []).forEach(function (c) { missingCells += c.missing || 0; });
    var dup = q.duplicateKeys ? q.duplicateKeys.duplicateRows : q.duplicateRows;
    var inc = typeof q.inconsistentSymbols === 'number' ? q.inconsistentSymbols : q.inconsistentSymbols ? q.inconsistentSymbols.count : null;
    var inv = Array.isArray(q.invalidPrices) ? q.invalidPrices.reduce(function (n, p) { return n + p.count; }, 0) : q.invalidPrices;
    h += '<div class="tiles">' +
      ui.tile('Blank rows inside', F.int(q.blankRowsInside || 0)) +
      ui.tile('Duplicate rows', b.symbolColumn ? F.int(dup || 0) : '–', b.symbolColumn ? '' : 'no symbol column') +
      ui.tile('Error cells', F.int((q.errors && q.errors.total) || 0)) +
      ui.tile('Inconsistent symbols', b.symbolColumn ? F.int(inc || 0) : '–') +
      ui.tile('Invalid prices', F.int(inv || 0)) +
      ui.tile('Missing cells', F.int(missingCells), 'blank cells in data rows') +
      '</div>';
    h += '<div id="xa-q-t" style="margin-top:14px"></div>';
    h += '<h3 style="margin-top:16px">Missing values per column</h3><div id="xa-miss-t" style="margin-top:8px"></div>';
    // master reconciliation
    var rc = b.reconciliation;
    h += '<h3 style="margin-top:16px">Reconciliation with Main (the stock master)</h3>';
    if (!b.symbolColumn) h += '<p class="sub">No symbol column, so this table is not compared with Main.</p>';
    else if (!rc) h += '<p class="sub">' + (sh.publicStructureOnly ? 'Not available for personal sheets in the public summary.' : 'No Main tab with symbols was found in this workbook, so nothing to compare.') + '</p>';
    else {
      h += (sh.name === 'Main' ? '<p class="sub">Main is the master itself; this only checks it is consistent.</p>' : '') +
        '<div class="tiles" style="margin-top:8px">' +
        ui.tile('Symbols in this table', F.int(rc.symbols)) +
        ui.tile('Matched in Main', F.int(rc.matched), esc(F.num(rc.matchedPct, 1) + '% of symbols')) +
        ui.tile('Not in Main', F.int(rc.unmatched), rc.unmatched ? 'renamed, delisted or typo?' : '') +
        ui.tile('Industry conflicts', F.int(rc.conflictCount), esc((rc.fieldsChecked || []).length ? 'checked: ' + rc.fieldsChecked.map(function (f) { return f.column; }).join(', ') : 'no sector / industry columns to check')) +
        '</div>' +
        (rc.unmatchedSymbols && rc.unmatchedSymbols.length ? '<p class="sub" style="margin-top:10px">Not in Main' + (rc.unmatched > rc.unmatchedSymbols.length ? ' (first ' + rc.unmatchedSymbols.length + ')' : '') + ':</p><div class="tags" style="margin-top:4px">' +
          rc.unmatchedSymbols.map(function (s) { return ui.badge(s, 's-warn'); }).join('') + '</div>' : '') +
        (rc.conflicts && rc.conflicts.length ? '<div id="xa-rc-t" style="margin-top:10px"></div>' : '');
    }
    return h + '</section>';
  }

  // ---------- 4. industry breakdown + 6. stock list data ----------
  var nameMapCache = null;
  function nameMaps() {
    if (nameMapCache && nameMapCache.n === PG.ctx.stocks.length) return nameMapCache;
    var C = SB.classify, raw = { basic: {}, industry: {} };
    PG.ctx.stocks.forEach(function (s) {
      if (!s.cat) return;
      [['basic', s.ind], ['industry', s.industry]].forEach(function (p) {
        var k = C.normalise(p[1]);
        if (!k) return;
        var m = raw[p[0]][k] || (raw[p[0]][k] = {});
        m[s.cat] = (m[s.cat] || 0) + 1;
      });
    });
    function major(map) {
      var o = {};
      Object.keys(map).forEach(function (k) { o[k] = Object.keys(map[k]).sort(function (a, b) { return map[k][b] - map[k][a]; })[0]; });
      return o;
    }
    nameMapCache = { n: PG.ctx.stocks.length, basic: major(raw.basic), industry: major(raw.industry) };
    return nameMapCache;
  }
  function catFor(sym, sv) {
    var C = SB.classify, m = PG.ctx.bySym[sym], c;
    if (m && m.cat) return { cat: m.cat, name: m.catName, from: 'main' };
    if (sv && (sv.sector || sv.industry || sv.basicIndustry)) {
      c = C.classify(sv);
      if (c.category) return { cat: c.category, name: c.categoryName, from: 'sheet' };
    }
    if (UP && PG.mode === 'upload' && UP.master && UP.master[sym]) {
      c = C.classify(UP.master[sym]);
      if (c.category) return { cat: c.category, name: c.categoryName, from: 'upload' };
    }
    return { cat: 'unclassified', name: 'Unclassified', from: m ? 'main' : 'none' };
  }
  function cellVal(v, kind) {
    if (v == null || v === '') return dash();
    if (kind === 'badge') return ui.badge(v);
    if (kind === 'date') return typeof v === 'string' ? F.date(v) : esc(v);
    if (typeof v === 'number') {
      if (kind === 'frac') return F.pct(v * 100, 1);
      if (kind === 'pct') return F.pct(v, 1);
      if (kind === 'price') return F.price(v);
      if (kind === 'num') return fmtN(v);
      return esc(F.num(v, 4));
    }
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return esc(clip(v, 48));
  }
  function pickKeyCols(sh, b) {
    if (sh.personal) return [];
    var sem = [b.symbolColumn, b.nameColumn, b.sectorColumn, b.industryColumn, b.basicIndustryColumn].filter(Boolean).map(function (c) { return c.index; });
    var strat = {};
    (b.strategyColumns || []).forEach(function (s) { strat[s.column] = true; });
    return (b.columns || []).filter(function (c) {
      return c.header && c.type !== 'empty' && sem.indexOf(c.index) < 0 && !c.redacted && !personalCol(c) &&
        !/^(ttm signal|mkt price|nse ticker|checkbox)$/i.test(String(c.header).trim()) && c.fillPct >= 20;
    }).map(function (c) {
      return { c: c, score: (strat[c.letter] ? 3 : 0) + (c.type === 'date' ? 2 : 0) + (c.type === 'number' || c.type === 'percent' ? 1 : 0) + (c.type === 'text' && c.distinct <= 30 ? 1 : 0) };
    }).sort(function (a, b2) { return b2.score - a.score || a.c.index - b2.c.index; }).slice(0, 4).sort(function (a, b2) { return a.c.index - b2.c.index; }).map(function (x) {
      var c = x.c;
      return { key: 'k' + c.index, col: c.index, label: c.header, kind: c.type === 'percent' ? (c.pctScale === 'fraction' ? 'frac' : 'pct') : c.type === 'number' ? 'num' : c.type === 'date' ? 'date' : 'text' };
    });
  }
  function textAt(row, c) { var v = c >= 0 ? row[c] : null; return blank(v) || WA.isErrorValue(v) ? null : String(v); }
  function stockList() {
    var sh = PG.sheet, b = PG.block, out = { ok: false, reason: '', items: [], keys: [], basis: '' };
    if (!b) { out.reason = 'The worksheet is empty.'; return out; }
    if (!b.symbolColumn) { out.reason = sh.blockCount > 1 ? 'This table has no symbol column - pick another table above.' : 'This worksheet has no symbol column.'; return out; }
    var map = {}, list = [];
    function add(sym, name, rowNo, vals, sv) {
      var it = map[sym];
      if (!it) { it = map[sym] = { sym: sym, sheetName: name || '', rows: 0, row: rowNo, vals: vals, sv: sv }; list.push(it); }
      it.rows++;
    }
    if (PG.mode === 'upload') {
      var rs = readerSheet(sh.name);
      if (!rs || !b.firstDataRow) { out.reason = 'No data rows.'; return out; }
      var sc = b.symbolColumn.index, nc = b.nameColumn ? b.nameColumn.index : -1;
      var cs = b.sectorColumn ? b.sectorColumn.index : -1, ci = b.industryColumn ? b.industryColumn.index : -1, cb = b.basicIndustryColumn ? b.basicIndustryColumn.index : -1;
      out.keys = pickKeyCols(sh, b);
      for (var r = b.firstDataRow - 1; r <= b.lastDataRow - 1; r++) {
        var row = rs.rows[r];
        if (!row || blank(row[sc]) || WA.isErrorValue(row[sc])) continue;
        var sym = WA.normalizeSymbol(row[sc]);
        if (!sym || map[sym]) { if (sym) map[sym].rows++; continue; }
        var vals = {};
        out.keys.forEach(function (k) { vals[k.key] = row[k.col]; });
        add(sym, nc >= 0 && !blank(row[nc]) ? String(row[nc]) : '', r + 1, vals, { sector: textAt(row, cs), industry: textAt(row, ci), basicIndustry: textAt(row, cb) });
      }
      out.basis = 'rows of this table in your workbook';
    } else {
      if (sh.publicStructureOnly) { out.reason = 'Personal sheet: the public summary keeps its structure only, so its symbols are not listed.'; return out; }
      var f = SNAP[sh.name], snap = null;
      try { snap = f ? f(PG.ctx.D, PG.ctx) : null; } catch (e) { snap = null; }
      if (!snap || !snap.rows.length) {
        out.reason = 'The public summary does not list the symbols of this tab. Analyse the workbook in this browser for a stock-by-stock view.';
        out.approx = true;
        return out;
      }
      out.keys = snap.keys.map(function (k) { return { key: 'k_' + k[0], src: k[0], label: k[1], kind: k[2] }; });
      snap.rows.forEach(function (o) {
        var sym = WA.normalizeSymbol(o[snap.sym]);
        if (!sym) return;
        if (map[sym]) { map[sym].rows++; return; }
        var vals = {};
        out.keys.forEach(function (k) { vals[k.key] = o[k.src]; });
        add(sym, snap.name ? o[snap.name] : '', null, vals, { basicIndustry: o['Basic Industry'] || null });
      });
      out.basis = 'the published dashboard snapshot of this tab (data/dashboard.js)';
    }
    list.forEach(function (it) {
      var m = PG.ctx.bySym[it.sym], c = catFor(it.sym, it.sv);
      it.cat = c.cat; it.catName = c.name; it.catFrom = c.from;
      it.inMain = !!m;
      it.name = (m && m.name) || it.sheetName || '';
      it.price = m ? m.price : null;
      it.sig = m ? m.sig : null;
      delete it.sv;
    });
    out.ok = list.length > 0;
    if (!out.ok) out.reason = 'No symbols in this table.';
    out.items = list;
    return out;
  }
  function industryData() {
    var st = PG.stocks, b = PG.block, groups = {}, order = [];
    function add(id, name, rows, syms) {
      var g = groups[id];
      if (!g) { g = groups[id] = { id: id, name: name, rows: 0, symbols: 0 }; order.push(g); }
      g.rows += rows || 0; g.symbols += syms || 0;
    }
    if (st && st.ok) {
      var from = { main: 0, sheet: 0, upload: 0, none: 0 };
      st.items.forEach(function (it) { add(it.cat, it.catName, it.rows, 1); from[it.catFrom]++; });
      order.sort(function (a, c) { return c.rows - a.rows || a.name.localeCompare(c.name); });
      return { kind: 'stocks', items: order, from: from, total: st.items.reduce(function (n, it) { return n + it.rows; }, 0) };
    }
    if (!b || PG.mode !== 'public') return null;
    var d = b.industryDistribution || b.sectorDistribution;
    if (!d || !d.counts || !d.counts.length) return null;
    var C = SB.classify, maps = nameMaps();
    d.counts.forEach(function (c) {
      var k = C.normalise(c.name), id = null;
      if (d.field === 'sector') id = C.classify({ sector: c.name }).category;
      else if (d.field === 'basicIndustry') id = maps.basic[k] || C.classify({ basicIndustry: c.name }).category;
      else id = maps.industry[k] || C.classify({ sector: c.name }).category;
      var cat = id ? C.categoryById(id) : null;
      add(id || 'unclassified', cat ? cat.name : 'Unclassified', c.rows, c.symbols);
    });
    if (d.otherRows) add('_other', 'Not itemised in the summary', d.otherRows, null);
    if (d.unknownRows) add('_unknown', 'No industry value', d.unknownRows, null);
    order.sort(function (a, c) { return (a.id.charAt(0) === '_') - (c.id.charAt(0) === '_') || c.rows - a.rows; });
    return { kind: 'approx', items: order, field: d.field, column: d.column, source: d.source, total: order.reduce(function (n, g) { return n + g.rows; }, 0) };
  }
  function industryCard() {
    var ind = PG.industry, b = PG.block, sh = PG.sheet;
    var h = '<section class="card" id="xa-ind"><div class="card-head"><div><h2>Industry-wise breakdown</h2><p>Rows of ' + esc(sh.name) + ' per dashboard category. ' +
      'Each symbol is mapped through its Main classification; symbols not in Main use the sheet\'s own sector / industry columns.</p></div></div>';
    if (!ind) {
      return h + '<p class="sub">' + esc(PG.stocks && PG.stocks.reason ? PG.stocks.reason : 'No symbol or industry column in this table.') + '</p></section>';
    }
    var items = ind.items.map(function (g) {
      return { label: g.name, value: g.rows, tip: g.name + ': ' + F.int(g.rows) + ' rows' + (g.symbols ? ' · ' + F.int(g.symbols) + ' symbols' : '') + ' · ' + F.num(ind.total ? 100 * g.rows / ind.total : 0, 1) + '%' };
    });
    if (ind.kind === 'approx') {
      h += '<div class="note warn">Approximate: the public summary lists only the ' + (ind.field === 'sector' ? 'sector' : ind.field === 'basicIndustry' ? 'basic industry' : 'industry') +
        ' counts of this tab' + (ind.column ? ' (column "' + esc(ind.column) + '")' : ' (looked up in Main)') + ', mapped here to dashboard categories. ' +
        'Analyse the workbook in this browser for exact per-stock counts.</div><div style="margin-top:12px">' + ui.bars(items) + '</div></section>';
      return h;
    }
    var f = ind.from;
    h += '<div class="grid g2"><div>' + ui.bars(items) + '</div><div><p class="sub">' + F.int(PG.stocks.items.length) + ' symbols in ' + F.int(ind.total) + ' rows, from ' + esc(PG.stocks.basis) + '.</p>' +
      '<p class="sub" style="margin-top:6px">Category taken from: Main ' + F.int(f.main) + ' · the sheet\'s own industry columns ' + F.int(f.sheet) +
      (PG.mode === 'upload' ? ' · your workbook\'s Main ' + F.int(f.upload) : '') + ' · unknown ' + F.int(f.none) + '.</p>' +
      '<p class="sub" style="margin-top:10px">Filter the stock list below by category:</p><div style="margin-top:6px">' +
      ui.chips('xa-cat', [['', 'All (' + PG.stocks.items.length + ')']].concat(ind.items.map(function (g) { return [g.id, g.name + ' (' + g.symbols + ')']; })), ST.cat) + '</div></div></div>';
    var d = b && (b.industryDistribution || b.sectorDistribution);
    if (d && d.counts && d.counts.length && d.source === 'sheet') {
      h += '<details style="margin-top:12px"><summary class="sub">As written in the sheet\'s "' + esc(d.column) + '" column (' + F.int(d.distinct) + ' values)</summary>' +
        '<ul class="list" style="margin-top:6px">' + d.counts.slice(0, 15).map(function (c) {
          return '<li><span class="grow">' + esc(c.name) + '</span><span class="num">' + F.int(c.rows) + ' rows</span></li>';
        }).join('') + (d.counts.length > 15 || d.otherRows ? '<li class="sub">…and more</li>' : '') + '</ul></details>';
    }
    return h + '</section>';
  }

  // ---------- 5. strategy rules ----------
  /** Formula pattern: row numbers ignored; Google's export wrapper IFERROR(__xludf.DUMMYFUNCTION("f"), cached) keeps "f" only. */
  function formulaPattern(f) {
    return String(f).replace(/^(\s*IFERROR\(__xludf\.DUMMYFUNCTION\("(?:[^"]|"")*"\)),[\s\S]*\)\s*$/, '$1,#)').replace(/(\$?[A-Za-z]{1,3}\$?)\d+/g, '$1#');
  }
  /** Upload only: distinct formula patterns of one column of a table ->
      { all, sig (patterns used by >= 2 cells and >= 1 % of the formula cells), oneOff, rowSpecific }. */
  function variantsFor(sheetName, bi, c) {
    var key = 'var|' + sheetName + '|' + bi + '|' + c;
    if (UP.cache[key]) return UP.cache[key];
    var rs = readerSheet(sheetName), sh = findSheet(sheetName), b = sh && sh.blocks[bi], out = [];
    var res = UP.cache[key] = { all: out, sig: [], oneOff: 0, rowSpecific: false };
    if (!rs || !b || !b.firstDataRow) return res;
    var r0 = b.firstDataRow - 1, r1 = b.lastDataRow - 1, map = {};
    function add(f, cell, n) {
      var k = formulaPattern(f);
      var v = map[k];
      if (!v) { v = map[k] = { formula: f, firstCell: cell, cells: 0 }; out.push(v); }
      v.cells += n;
    }
    for (var r = r0; r <= r1; r++) { var fr = rs.formulas[r]; if (fr && fr[c]) add(fr[c], letter(c) + (r + 1), 1); }
    (rs.sharedFormulas || []).forEach(function (sf) {
      var g = XL.parseRange(sf.ref);
      if (!g || c < g.c0 || c > g.c1) return;
      var lo = Math.max(g.r0, r0), hi = Math.min(g.r1, r1);
      if (hi < lo) return;
      var n = Math.round((sf.count || 0) * ((hi - lo + 1) / (g.r1 - g.r0 + 1)) / (g.c1 - g.c0 + 1));
      if (n) add(sf.formula, sf.cell, n);
    });
    out.sort(function (a, x) { return x.cells - a.cells; });
    var total = out.reduce(function (n, v) { return n + v.cells; }, 0);
    res.sig = out.filter(function (v) { return v.cells >= Math.max(2, total / 100); });
    res.oneOff = out.length - res.sig.length;
    res.rowSpecific = out.length > 20 && res.sig.length <= 1;      // e.g. a HYPERLINK typed per row
    return res;
  }
  function stratRows(scope) {
    var out = [], sheets = scope === 'all' ? PG.A.sheets || [] : [PG.sheet];
    sheets.forEach(function (sh) {
      (sh.blocks || []).forEach(function (b, bi) {
        if (scope !== 'all' && bi !== PG.bi) return;
        var byL = {};
        (b.columns || []).forEach(function (c) { byL[c.letter] = c; });
        (b.strategyColumns || []).forEach(function (s) {
          out.push({ sheet: sh.name, bi: bi, multi: sh.blockCount > 1, s: s, col: byL[s.column] || null, hidden: !!(sh.publicStructureOnly || (byL[s.column] && byL[s.column].redacted)), personal: !!sh.personal || personalCol(byL[s.column]) });
        });
      });
    });
    return out;
  }
  function valuesHtml(x) {
    if (x.hidden || x.personal) return sub('hidden (personal)');
    var v = x.s.values;
    if (!v || !v.length) return dash();
    return v.slice(0, 8).map(function (e) { return esc(clip(e.value, 40)) + ' <span class="sub">' + F.int(e.count) + '</span>'; }).join(' · ') +
      (v.length > 8 ? ' <span class="sub">+' + (v.length - 8) + ' more</span>' : '');
  }
  function stratColumns(all) {
    var cols = [];
    if (all) cols.push({ key: 'sheet', label: 'Sheet', get: function (x) { return x.sheet + (x.multi ? ' T' + (x.bi + 1) : ''); },
      html: function (x) { return '<button type="button" class="linkish" data-sheet="' + esc(x.sheet) + '">' + esc(x.sheet) + '</button>' + (x.multi ? sub(' table ' + (x.bi + 1)) : ''); } });
    return cols.concat([
      { key: 'col', label: 'Column', get: function (x) { return colIdx(x.s.column); }, html: function (x) { return '<b>' + esc(x.s.column) + '</b>'; } },
      { key: 'header', label: 'Header', wrap: true, get: function (x) { return x.s.header; }, html: function (x) { return x.s.header ? esc(x.s.header) : dash(); } },
      { key: 'type', label: 'Type', get: function (x) { return x.s.type; } },
      { key: 'by', label: 'Found by', get: function (x) { return x.s.reasons.join(' + ') + ': ' + x.s.keywords.join(', '); },
        html: function (x) { return esc(x.s.reasons.join(' + ')) + '<span class="co">' + esc(x.s.keywords.join(', ')) + '</span>'; } },
      { key: 'values', label: 'Distinct values (count)', wrap: true, get: function (x) { return (x.s.values || []).map(function (e) { return e.value + ' (' + e.count + ')'; }).join('; '); }, html: valuesHtml },
      { key: 'formula', label: 'Example formula', wrap: true, get: function (x) { return x.s.formula || ''; },
        html: function (x) { return x.hidden ? sub('hidden (personal)') : x.s.formula ? code(x.s.formula, 110) : dash(); } }
    ]);
  }
  var RULE_HEAD_RE = /signal|target|peg|upside|stop|entry|score|ema|fvg|pattern|atr|buy|sell|avoid/i;
  function formulaRows(scope) {
    return stratRows(scope).filter(function (x) { return x.col && x.col.formula && !x.hidden && RULE_HEAD_RE.test((x.s.header || '') + ' ' + x.s.keywords.join(' ')); }).map(function (x) {
      return { sheet: x.sheet, bi: x.bi, multi: x.multi, column: x.s.column, header: x.s.header, cells: x.col.formula.cells, pct: x.col.formula.pct,
        example: x.s.formula || x.col.formula.example || '', variants: PG.mode === 'upload' ? variantsFor(x.sheet, x.bi, x.col.index) : null };
    });
  }
  function formulaColumns(all) {
    var cols = [];
    if (all) cols.push({ key: 'sheet', label: 'Sheet', html: function (x) { return '<button type="button" class="linkish" data-sheet="' + esc(x.sheet) + '">' + esc(x.sheet) + '</button>'; } });
    return cols.concat([
      { key: 'column', label: 'Column', html: function (x) { return '<b>' + esc(x.column) + '</b> ' + esc(x.header || ''); } },
      { key: 'cells', label: 'Formula cells', type: 'num', digits: 0, html: function (x) { return F.int(x.cells) + '<span class="co">' + F.num(x.pct, 1) + '% of rows</span>'; } },
      { key: 'nv', label: 'Variants', get: function (x) { return x.variants ? x.variants.sig.length : null; }, html: function (x) {
        var v = x.variants;
        if (!v) return sub('n/a in the public summary');
        var extra = v.oneOff ? '<span class="co">+ ' + F.int(v.oneOff) + ' one-off</span>' : '';
        if (v.rowSpecific) return ui.badge('typed per row', '') + extra;
        return (v.sig.length > 1 ? ui.badge(v.sig.length + ' variants', 's-warn') : ui.badge('1 variant', 's-good')) + extra;
      } },
      { key: 'example', label: 'Formula (rule)', wrap: true, get: function (x) { return x.example; }, html: function (x) {
        if (x.variants && x.variants.sig.length > 1) {
          return x.variants.sig.slice(0, 4).map(function (v) { return code(v.formula, 140) + '<span class="co">' + F.int(v.cells) + ' cells, e.g. ' + esc(v.firstCell) + '</span>'; }).join('<div style="height:6px"></div>');
        }
        return x.example ? code(x.example, 160) : dash();
      } }
    ]);
  }
  function rulesCard() {
    var h = '<section class="card" id="xa-rules"><div class="card-head"><div><h2>Strategy rule extraction</h2><p>Columns and formulas in your workbook that look like trading rules. ' +
      'They are treated as <b>data and potential rules</b> to review - not as unquestionable truth. Nothing here changes your strategy.</p></div>' +
      ui.chips('xa-sc', [['sheet', 'This worksheet'], ['all', 'All worksheets']], ST.scope) + '</div><div id="xa-rules-body"></div></section>';
    return h;
  }
  function drawRules() {
    var pg = PG, host = $('#xa-rules-body', pg.el);
    if (!host) return;
    var all = ST.scope === 'all', rows = stratRows(ST.scope), fx = formulaRows(ST.scope);
    host.innerHTML = '<h3>Strategy-related columns</h3><p class="sub">Header or formula mentions signal, buy / sell / avoid, target, stop, entry, pattern, FVG, EMA, RSI, PEG, upside or score. ' +
      F.int(rows.length) + ' found' + (all ? ' in the workbook' : ' in this ' + (pg.sheet.blockCount > 1 ? 'table' : 'worksheet')) + '.</p><div id="xa-sc-t" style="margin-top:8px"></div>' +
      '<h3 style="margin-top:16px">Formulas that encode rules</h3><p class="sub">' +
      (pg.mode === 'upload' ? 'Every distinct formula pattern of the column is counted (row numbers ignored), so mixed rule versions stand out.' :
        'The public summary keeps one example formula per column, so different formula versions can only be found by analysing the workbook in this browser.') +
      '</p><div id="xa-fx-t" style="margin-top:8px"></div>';
    new ui.Table({ rows: rows, pageSize: 25, columns: stratColumns(all), empty: 'No strategy-related columns here' }).mount($('#xa-sc-t', host));
    new ui.Table({ rows: fx, pageSize: 25, columns: formulaColumns(all), empty: 'No rule formulas here' }).mount($('#xa-fx-t', host));
  }

  function strategyInfo() {
    var S = SB.strategies;
    if (!S) return null;
    var id = S.activeId(), cfg = S.get(id);
    return cfg ? { id: id, cfg: cfg, confirmed: S.isConfirmed(id), demo: cfg.source === 'demo' } : null;
  }
  function registryRows(info) {
    var C = SB.strategy.CONDITIONS, cfg = info ? info.cfg : null;
    return Object.keys(C).filter(function (id) { return C[id].kind === 'sheet'; }).map(function (id) {
      var d = C[id], used = [];
      if (cfg) ['filters', 'triggers', 'confirms'].forEach(function (g) { (cfg[g] || []).forEach(function (r) { if (r && r.id === id) used.push(r); }); });
      var params = {};
      (d.params || []).forEach(function (p) { params[p.key] = p.def; });
      var label;
      try { label = SB.strategy.label({ id: id, params: params }); } catch (e) { label = d.label; }
      return { id: id, label: label, role: d.setGroup, pit: d.pit, ref: d.ref || '', used: used, on: used.filter(function (r) { return r.enabled !== false; }) };
    });
  }
  function registryColumns(info) {
    var ROLE = { filter: 'Filter (must pass)', trigger: 'Signal', confirm: 'Requirement' };
    return [
      { key: 'label', label: 'Rule', wrap: true },
      { key: 'role', label: 'Role', html: function (r) { return esc(ROLE[r.role] || r.role) + (r.pit === false ? '<span class="co" title="Uses today\'s fundamentals">not in backtests</span>' : ''); } },
      { key: 'ref', label: 'Found in (Code.gs function / sheet column)', wrap: true, html: function (r) { return r.ref ? code(r.ref, 140) : dash(); } },
      { key: 'disc', label: 'Origin', get: function () { return 'Discovered from your Code.gs / sheet'; }, html: function () { return ui.badge('Discovered from your Code.gs / sheet', 's-info'); } },
      { key: 'use', label: 'In the active strategy', get: function (r) { return r.used.length ? (r.on.length ? 'Yes' : 'Off') : 'No'; }, html: function (r) {
        if (!r.used.length) return sub('not used');
        return (r.on.length ? ui.badge('Used', 's-info') : ui.badge('Off', '')) + r.used.map(function (u) {
          var l;
          try { l = SB.strategy.label(u); } catch (e) { l = r.label; }
          return '<span class="co" title="' + esc(l) + '">' + esc(clip(l, 60)) + (u.watchOnly ? ' (watch only)' : '') + (u.enabled === false ? ' (off)' : '') + '</span>';
        }).join('');
      } },
      { key: 'conf', label: 'Confirmed by you?', get: function (r) { return !r.used.length ? '' : info.demo ? 'DEMO' : info.confirmed ? 'Confirmed' : 'Not confirmed'; }, html: function (r) {
        if (!r.used.length || !info) return dash();
        if (info.demo) return ui.badge('DEMO strategy', 's-warn');
        return info.confirmed ? ui.badge('Confirmed by you (v' + info.cfg.version + ')', 's-good') : ui.badge('Not confirmed yet', 's-warn');
      } }
    ];
  }
  function ambiguities() {
    var out = [], sh = PG.sheet, b = PG.block;
    if (!b || sh.publicStructureOnly) return out;
    (b.columns || []).forEach(function (c) {
      var ex = c.formula && c.formula.example, name = (c.header || 'Column ' + c.letter) + ' (' + sh.name + ' column ' + c.letter + ')';
      if (ex && ex.indexOf('#REF!') >= 0) out.push({ title: name + ': formula points to a deleted range (#REF!)', text: 'Example: ' + clip(ex, 220) });
      if (PG.mode === 'upload' && c.formula && !hideValues(sh, c)) {
        var v = variantsFor(sh.name, PG.bi, c.index).sig;
        if (v.length > 1) {
          out.push({ title: name + ': ' + v.length + ' different formulas in one column', text: v.slice(0, 4).map(function (x) { return F.int(x.cells) + ' cells like ' + x.firstCell; }).join(' · ') +
            '. Which version is the rule you mean?', formulas: v.slice(0, 3) });
        }
      }
    });
    (b.strategyColumns || []).forEach(function (s) {
      if (!s.values) return;
      var g = {};
      s.values.forEach(function (v) { if (typeof v.value === 'string') { var k = v.value.trim().toLowerCase(); (g[k] = g[k] || []).push(v.value); } });
      var dup = Object.keys(g).filter(function (k) { return g[k].length > 1; }).map(function (k) { return g[k].join(' / '); });
      if (dup.length) {
        out.push({ title: (s.header || s.column) + ' (' + sh.name + ' column ' + s.column + '): the same value is written in different ways',
          text: dup.slice(0, 6).join(' · ') + '. Exact-match filters treat these as different values.' });
      }
    });
    return out;
  }
  function itemHtml(it) {
    return '<li style="margin-top:8px"><b>' + esc(it.title) + '</b><div class="sub" style="margin-top:2px">' + esc(it.text) + '</div>' +
      (it.formulas ? it.formulas.map(function (f) { return '<div style="margin-top:4px">' + code(f.formula, 200) + '</div>'; }).join('') : '') + '</li>';
  }
  function registryCard() {
    var info = strategyInfo(), dyn = ambiguities(), sh = PG.sheet;
    var h = '<section class="card" id="xa-reg"><div class="card-head"><div><h2>Rule registry and review</h2><p>Every rule the dashboard took from your Code.gs / sheet, where it came from, ' +
      'and whether the active strategy uses it. "Discovered" means read from your files; only you can mark a strategy as confirmed.</p></div></div>';
    if (info) {
      var badge = info.demo ? ui.badge('DEMO - for testing only', 's-warn') : info.confirmed ? ui.badge('Confirmed by you (v' + info.cfg.version + ')', 's-good') : ui.badge('Discovered - not confirmed by you', 's-warn');
      h += '<div class="note' + (info.confirmed && !info.demo ? ' good' : ' warn') + '">Active strategy: <b>' + esc(info.cfg.name) + '</b> · v' + esc(info.cfg.version) + ' ' + badge +
        (info.confirmed && !info.demo ? '' : '<br>Its rules were discovered from your workbook and Code.gs, but how they are combined is an assumption until you confirm it.') +
        ' <a href="#strategy">Review in Strategy settings</a></div>';
    } else h += '<div class="note warn">The strategy module did not load, so rule usage cannot be shown.</div>';
    h += '<div id="xa-reg-t" style="margin-top:12px"></div>';
    h += '<h3 style="margin-top:16px">Needs your confirmation</h3>';
    if (dyn.length) {
      h += '<p class="sub">Found in ' + esc(sh.name) + (PG.mode === 'upload' ? ' (your workbook, this browser)' : ' (public summary)') + ':</p><ul style="margin:0 0 0 18px;padding:0">' + dyn.slice(0, 12).map(itemHtml).join('') + '</ul>';
    }
    h += '<p class="sub" style="margin-top:10px">Known items from the review of your Code.gs and sheet:</p><ul style="margin:0 0 0 18px;padding:0">' + KNOWN.map(itemHtml).join('') + '</ul>';
    return h + '</section>';
  }

  // ---------- 6. stock by stock ----------
  function stratOf(sym) { var run = PG.run; return run && run.bySym ? run.bySym[sym] || null : null; }
  function stockColumns(st) {
    var cols = [
      { key: 'sym', label: 'Stock', html: function (r) { return ui.stockCell(r.sym, r.name); } },
      { key: 'name', label: 'Name', csvOnly: true },
      { key: 'rows', label: 'Rows', type: 'num', digits: 0, title: 'Rows of this table with the symbol' }
    ];
    if (PG.mode === 'upload') cols.push({ key: 'row', label: 'First row', type: 'num', digits: 0, title: 'Excel row of the first occurrence' });
    cols.push(
      { key: 'catName', label: 'Category', wrap: true, html: function (r) { return esc(r.catName) + (r.catFrom === 'sheet' ? '<span class="co">from the sheet\'s industry</span>' : r.catFrom === 'upload' ? '<span class="co">from your Main</span>' : ''); } },
      { key: 'inMain', label: 'In Main', get: function (r) { return r.inMain ? 'Yes' : 'No'; }, html: function (r) { return r.inMain ? 'Yes' : ui.badge('Not in Main', 's-warn'); } },
      { key: 'price', label: 'Price (Main)', type: 'price' },
      { key: 'sig', label: 'TTM Signal (Main)', type: 'badge' },
      { key: 'strat', label: 'Active strategy', get: function (r) { var x = stratOf(r.sym); return x ? x.statusLabel : null; }, html: function (r) {
        var x = stratOf(r.sym);
        if (x) return ui.badge(x.statusLabel, STATUS_CLS[x.status] != null ? STATUS_CLS[x.status] : '');
        if (!r.inMain) return dash();
        return PG.runErr ? dash() : sub(PG.run ? 'not evaluated' : '…');
      } }
    );
    st.keys.forEach(function (k) {
      var numeric = /^(num|pct|frac|price)$/.test(k.kind);
      cols.push({ key: k.key, label: k.label, type: numeric ? 'num' : undefined, wrap: k.kind === 'text',
        get: function (r) { var v = r.vals[k.key]; return numeric ? (isNum(v) ? v : null) : v; },
        csv: function (r) { var v = r.vals[k.key]; return v == null ? '' : v; },
        html: function (r) { return cellVal(r.vals[k.key], k.kind); } });
    });
    return cols;
  }
  function filteredStocks() {
    var st = PG.stocks, q = ST.q.trim().toLowerCase();
    return st.items.filter(function (it) {
      return (!ST.cat || it.cat === ST.cat) && (!q || ui.textMatch(q, [it.sym, it.name, it.catName]));
    });
  }
  function stocksCard() {
    var st = PG.stocks, sh = PG.sheet;
    var h = '<section class="card" id="xa-stocks"><div class="card-head"><div><h2>Stock-by-stock</h2><p>Each symbol of ' + esc(sh.name) +
      ' with its Main fields, the active strategy\'s status and ' + (st.keys && st.keys.length ? 'the row\'s own key values (first row with the symbol).' : 'Main details.') + '</p></div></div>';
    if (!st.ok) return h + '<p class="sub">' + esc(st.reason) + '</p></section>';
    if (sh.personal) h += '<div class="note warn">Personal sheet: only the Main fields are shown, not the row\'s own values.</div>';
    var ind = PG.industry, opts = ind ? [['', 'All categories']].concat(ind.items.map(function (g) { return [g.id, g.name]; })) : [];
    h += '<div class="controls" style="margin-top:8px"><input class="search" id="xa-stq" type="search" placeholder="Search symbol, company or category" aria-label="Search stocks" value="' + esc(ST.q) + '">' +
      (opts.length ? '<label class="sr-only" for="xa-catsel">Category</label><select class="sel" id="xa-catsel" style="max-width:260px">' + opts.map(function (o) {
        return '<option value="' + esc(o[0]) + '"' + (o[0] === ST.cat ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
      }).join('') + '</select>' : '') +
      '<span class="count" id="xa-st-n"></span></div><div id="xa-st-t"></div>' +
      '<p class="sub" style="margin-top:8px" id="xa-st-note">' + esc('Source: ' + st.basis + '. Price and TTM Signal come from the Main snapshot (CACHED); TTM Signal is the sheet\'s own target-price signal, not advice.') + '</p>';
    return h + '</section>';
  }
  function applyStocks() {
    var pg = PG;
    if (!pg.stockTable) return;
    var rows = filteredStocks();
    pg.stockTable.setRows(rows);
    var n = $('#xa-st-n', pg.el);
    if (n) n.textContent = F.int(rows.length) + ' of ' + F.int(pg.stocks.items.length) + ' symbols';
  }
  function loadStrategy() {
    var pg = PG, st = pg.stocks;
    if (!st || !st.ok || !SB.strategies) return;
    if (!st.items.some(function (it) { return it.inMain; })) return;
    var table = pg.stockTable;
    var p;
    try { p = SB.strategies.runActive(); } catch (e) { p = Promise.reject(e); }
    p.then(function (run) {
      if (!alive(pg) || pg.stockTable !== table) return;
      pg.run = run;
      table.draw();
    }, function (e) {
      if (!alive(pg) || pg.stockTable !== table) return;
      pg.runErr = e.message || String(e);
      table.draw();
      var n = $('#xa-st-note', pg.el);
      if (n) n.textContent += ' Strategy status unavailable: ' + pg.runErr + '.';
    });
  }

  // ---------- 7. summary statistics ----------
  function statsCard() {
    var b = PG.block;
    var h = '<section class="card" id="xa-stats"><div class="card-head"><div><h2>Summary statistics</h2><p>Count, minimum, maximum and mean of every numeric column' +
      (b && b.columns.some(function (c) { return c.type === 'date'; }) ? ', plus the first and last date of date columns' : '') + '. Values as stored in the sheet.</p></div></div>';
    if (!b) return h + '<p class="empty">No data.</p></section>';
    return h + '<div id="xa-stats-t"></div></section>';
  }
  function statsColumns(sh) {
    function show(c, v, d) {
      if (hideValues(sh, c)) return sub('hidden');
      if (c.type === 'date') return d ? esc(d) : dash();
      if (!isNum(v)) return dash();
      return fmtN(v) + (c.pctScale === 'fraction' ? '<span class="co">= ' + F.num(v * 100, 2) + '%</span>' : c.pctScale === 'percent' ? '<span class="co">%</span>' : '');
    }
    return [
      { key: 'index', label: 'Col', html: function (c) { return '<b>' + esc(c.letter) + '</b>'; } },
      { key: 'header', label: 'Header', wrap: true, html: function (c) { return c.header ? esc(c.header) : sub('(no header)'); } },
      { key: 'type', label: 'Type', html: function (c) { return esc(c.type) + (c.pctScale ? '<span class="co">' + esc(c.pctScale) + '</span>' : ''); } },
      { key: 'filled', label: 'Count', type: 'num', digits: 0 },
      { key: 'min', label: 'Min', type: 'num', get: function (c) { return isNum(c.min) ? c.min : null; }, html: function (c) { return show(c, c.min, c.minDate); } },
      { key: 'max', label: 'Max', type: 'num', get: function (c) { return isNum(c.max) ? c.max : null; }, html: function (c) { return show(c, c.max, c.maxDate); } },
      { key: 'mean', label: 'Mean', type: 'num', get: function (c) { return isNum(c.mean) ? c.mean : null; }, html: function (c) { return c.type === 'date' ? dash() : show(c, c.mean); } }
    ];
  }

  // ---------- 8. exports ----------
  function exportCard() {
    var st = PG.stocks, up = PG.mode === 'upload', b = PG.block;
    function btn(k, label, off) { return '<button class="btn" type="button" data-exp="' + k + '"' + (off ? ' disabled' : '') + '>' + esc(label) + '</button>'; }
    var h = '<section class="card" id="xa-exp"><div class="card-head"><div><h2>Exports</h2><p>Files for ' + esc(PG.sheet.name) + (PG.sheet.blockCount > 1 && b ? ' (' + esc(blockLabel(b, PG.bi)) + ')' : '') +
      ', made in this browser. CSV files are UTF-8 for Excel / Google Sheets; text starting with = + - @ gets a leading \' so it is never run as a formula.</p></div></div>' +
      '<div class="controls">' + btn('columns', 'Column profile (CSV)', !b) + btn('quality', 'Data-quality issues (CSV)', !b) + btn('industry', 'Industry summary (CSV)', !PG.industry) +
      btn('stocks', 'Stock-by-stock (CSV)', !(st && st.ok)) + btn('json', 'Full analysis report (JSON)') + (up ? btn('clean', 'Cleaned data (CSV)', !(b && b.firstDataRow)) : '') + '</div>';
    if (up) {
      h += '<p class="sub">Cleaned data = header row + data rows of this table, with error values blanked, symbols trimmed and upper-cased, text dates turned into ISO dates ' +
        '(YYYY-MM-DD; dd/mm/yyyy order assumed), numbers stored as text turned into numbers in the flagged columns, spaces trimmed and fully blank rows dropped. ' +
        'Percent columns keep the sheet\'s own scale. It is built from the copy in memory - your original file is never changed. The JSON report and cleaned data contain values from your workbook: keep them private.</p>';
    } else h += '<p class="sub">The JSON report is the public summary plus the rule registry and the checks of the selected worksheet. Cleaned data needs the workbook itself: analyse it in this browser.</p>';
    return h + '<p class="sub" id="xa-exp-msg" role="status" style="margin-top:6px"></p></section>';
  }
  function textDateToIso(s) {
    var m, d, mo, y, tm = '';
    var t = /\s(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s);
    if (t) { tm = ' ' + pad2(+t[1]) + ':' + t[2]; s = s.slice(0, t.index); }
    if ((m = /^(\d{1,2})[\/\-. ](\d{1,2})[\/\-. ](\d{2,4})$/.exec(s))) {
      d = +m[1]; mo = +m[2]; y = +m[3];
      if (mo > 12 && d <= 12) { var x = d; d = mo; mo = x; }
    } else if ((m = /^(\d{1,2})[\/\-. ]([A-Za-z]{3,9})[\/\-. ](\d{2,4})$/.exec(s))) {
      d = +m[1]; mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; y = +m[3];
    } else if ((m = /^([A-Za-z]{3,9}) (\d{1,2}),? (\d{4})$/.exec(s))) {
      mo = MONTHS[m[1].slice(0, 3).toLowerCase()]; d = +m[2]; y = +m[3];
    } else if ((m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s))) {
      y = +m[1]; mo = +m[2]; d = +m[3];
    } else return null;
    if (y < 100) y += 2000;
    if (!mo || mo > 12 || !(d >= 1 && d <= 31)) return null;
    var dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCDate() !== d || dt.getUTCMonth() !== mo - 1) return null;
    return y + '-' + pad2(mo) + '-' + pad2(d) + tm;
  }
  function cleanedRows() {
    var sh = PG.sheet, b = PG.block, rs = readerSheet(sh.name);
    if (!rs || !b || !b.firstDataRow) return null;
    var c0 = colIdx(b.firstColumn), c1 = colIdx(b.lastColumn), symC = b.symbolColumn ? b.symbolColumn.index : -1;
    var byIdx = {}, numCols = {}, stats = { rows: 0, errors: 0, symbols: 0, dates: 0, numbers: 0, trimmed: 0, blankRows: 0 };
    (b.columns || []).forEach(function (c) { byIdx[c.index] = c; });
    ((b.quality && b.quality.numbersAsText) || []).forEach(function (t) { numCols[colIdx(t.column)] = true; });
    var hr = b.headerRow ? rs.rows[b.headerRow - 1] || [] : [], head = [], c;
    for (c = c0; c <= c1; c++) head.push(blank(hr[c]) ? 'Column ' + letter(c) : String(hr[c]).replace(/\s+/g, ' ').trim());
    var out = [head];
    function clean(v, col) {
      if (v == null) return null;
      if (typeof v !== 'string') return v;
      var s = v.trim();
      if (s !== v) stats.trimmed++;
      if (s === '') return null;
      if (WA.isErrorValue(s)) { stats.errors++; return null; }
      if (col === symC) { var u = s.toUpperCase(); if (u !== s) stats.symbols++; return u; }
      var p = byIdx[col];
      if (p && (p.type === 'date' || p.datesAsText) && TEXT_DATE_RE.test(s)) { var iso = textDateToIso(s); if (iso) { stats.dates++; return iso; } }
      if (numCols[col] && /^[+\-]?(\d{1,3}(,\d{2,3})+|\d+)(\.\d+)?$/.test(s.replace(/\s/g, ''))) {
        var n = Number(s.replace(/[,\s]/g, ''));
        if (isFinite(n)) { stats.numbers++; return n; }
      }
      return s;
    }
    for (var r = b.firstDataRow - 1; r <= b.lastDataRow - 1; r++) {
      var row = rs.rows[r] || [], any = false;
      for (c = c0; c <= c1; c++) if (!blank(row[c])) { any = true; break; }
      if (!any) { stats.blankRows++; continue; }
      var line = [];
      for (c = c0; c <= c1; c++) line.push(clean(row[c], c));
      out.push(line);
      stats.rows++;
    }
    return { rows: out, stats: stats };
  }
  function reportJson() {
    var info = strategyInfo(), sh = PG.sheet, A = PG.A;
    var src = PG.mode === 'public' ?
      { kind: 'public summary', file: A.source, generated: A.generated, sourceModified: A.sourceModified, state: A.state || 'CACHED', publicMode: true } :
      { kind: 'workbook analysed in this browser', file: UP.file.name, bytes: UP.file.size, readMs: UP.readMs, analyzeMs: UP.analyzeMs, publicMode: false,
        note: 'Contains values from your workbook - keep this file private.' };
    var rep = {
      report: 'Stock Blueprint - Excel analysis',
      exportedAt: new Date().toISOString(),
      source: src,
      selected: { sheet: sh.name, table: PG.bi + 1, issues: PG.issues, industry: PG.industry ? PG.industry.items : null, stocks: PG.stocks && PG.stocks.ok ? PG.stocks.items.length : 0 },
      activeStrategy: info ? { id: info.id, name: info.cfg.name, version: info.cfg.version, confirmed: info.confirmed, demo: info.demo } : null,
      ruleRegistry: registryRows(info).map(function (r) { return { id: r.id, rule: r.label, role: r.role, foundIn: r.ref, origin: 'discovered from Code.gs / sheet', usedByActive: r.on.length > 0 }; }),
      needsConfirmation: ambiguities().map(function (a) { return { title: a.title, text: a.text }; }).concat(KNOWN),
      analysis: A
    };
    return JSON.stringify(rep, null, 2);
  }
  function doExport(kind) {
    var pg = PG, sh = pg.sheet, b = pg.block, base = 'excel-' + pg.mode + '-' + slug(sh.name) + (sh.blockCount > 1 ? '-t' + (pg.bi + 1) : '');
    var msg = $('#xa-exp-msg', pg.el), rows;
    function done(name, text, mime) { ui.download(name, text, mime); if (msg) msg.textContent = 'Saved ' + name + '.'; }
    if (kind === 'columns' && b) {
      rows = [['Sheet', 'Table', 'Column', 'Original header', 'Group header', 'Normalized key', 'Type', 'Filled', 'Missing', 'Errors', 'Fill %', 'Distinct', 'Min', 'Max', 'Mean',
        'Number format', 'Percent scale', 'Formula cells', 'Formula % of rows', 'Example formula', 'Samples']];
      b.columns.forEach(function (c) {
        rows.push([sh.name, pg.bi + 1, c.letter, c.header, c.group || null, colKey(c), c.type, c.filled, c.missing, c.errors, c.fillPct, c.distinct == null ? null : c.distinct,
          isNum(c.min) ? c.min : c.minDate || null, isNum(c.max) ? c.max : c.maxDate || null, isNum(c.mean) ? c.mean : null, c.numFmt, c.pctScale || null,
          c.formula ? c.formula.cells : 0, c.formula ? c.formula.pct : 0, c.formula && c.formula.example ? c.formula.example : null,
          hideValues(sh, c) ? null : (c.samples || []).join(' | ')]);
      });
      done(base + '-columns.csv', csv(rows));
    } else if (kind === 'quality' && b) {
      rows = [['Sheet', 'Table', 'Check', 'Column', 'Header', 'Count', 'First rows / cells', 'Detail']];
      pg.issues.forEach(function (it) { rows.push([sh.name, pg.bi + 1, it.check, it.column, it.header, it.count, it.where.join(', '), it.detail]); });
      done(base + '-quality.csv', csv(rows));
    } else if (kind === 'industry' && pg.industry) {
      var ind = pg.industry;
      rows = [['Sheet', 'Table', 'Category', 'Rows', 'Symbols', '% of rows', 'Basis']];
      ind.items.forEach(function (g) {
        rows.push([sh.name, pg.bi + 1, g.name, g.rows, g.symbols, ind.total ? Math.round(1000 * g.rows / ind.total) / 10 : 0,
          ind.kind === 'stocks' ? 'per symbol: Main category, else the sheet\'s industry' : 'approximate, from the summary\'s ' + ind.field + ' counts']);
      });
      done(base + '-industries.csv', csv(rows));
    } else if (kind === 'stocks' && pg.stockTable) {
      done(base + '-stocks.csv', csv(pg.stockTable.toCsvRows()));
    } else if (kind === 'json') {
      done(base + '-report.json', reportJson(), 'application/json;charset=utf-8');
    } else if (kind === 'clean' && pg.mode === 'upload') {
      var cl = cleanedRows();
      if (!cl) { if (msg) msg.textContent = 'No data rows to export.'; return; }
      ui.download(base + '-cleaned.csv', csv(cl.rows));
      var s = cl.stats;
      if (msg) {
        msg.textContent = 'Saved ' + base + '-cleaned.csv: ' + F.int(s.rows) + ' rows; ' + F.int(s.errors) + ' error values blanked, ' + F.int(s.symbols) + ' symbols upper-cased, ' +
          F.int(s.dates) + ' text dates and ' + F.int(s.numbers) + ' text numbers converted, ' + F.int(s.trimmed) + ' cells trimmed, ' + F.int(s.blankRows) + ' blank rows dropped.';
      }
    }
  }

  // ---------- draw the selected worksheet ----------
  function drawSheet() {
    var pg = PG, A = pg.A;
    var sh = findSheet(ST.sheet[pg.mode]) || defaultSheet(A);
    ST.sheet[pg.mode] = sh ? sh.name : null;
    pg.sheet = sh;
    pg.run = SB.strategies && SB.strategies.lastRun ? SB.strategies.lastRun() : null;
    pg.runErr = null;
    pg.stockTable = null; pg.colTable = null;
    var wrap = $('#xa-sheetwrap', pg.el);
    if (!sh) { $('#xa-sel', pg.el).innerHTML = '<p class="empty">No worksheets in this workbook.</p>'; wrap.innerHTML = ''; return; }
    var bk = pg.mode + '|' + sh.name, bi = ST.block[bk];
    if (!(bi >= 0 && sh.blocks && bi < sh.blocks.length)) bi = sh.primaryBlock != null ? sh.primaryBlock : 0;
    pg.bi = bi;
    pg.block = sh.blocks && sh.blocks.length ? sh.blocks[bi] : null;
    $('#xa-sel', pg.el).innerHTML = selectorHtml();
    if (sh.ok === false) { wrap.innerHTML = sheetCard(); return; }
    pg.stocks = stockList();
    pg.issues = pg.block ? issuesFor(sh, pg.block) : [];
    pg.industry = industryData();
    if (ST.cat && !(pg.industry && pg.industry.kind === 'stocks' && pg.industry.items.some(function (g) { return g.id === ST.cat; }))) ST.cat = '';
    wrap.innerHTML = sheetCard() + qualityCard() + industryCard() + rulesCard() + registryCard() + stocksCard() + statsCard() + exportCard();

    var b = pg.block, el = pg.el;
    if (b) {
      if (sh.blockCount > 1) {
        new ui.Table({ rows: sh.blocks.map(function (x, i) {
          return { i: i, title: x.title && x.title[0] ? x.title[0] : '', headerRow: x.headerRow, groupHeaderRow: x.groupHeaderRow, firstDataRow: x.firstDataRow, lastDataRow: x.lastDataRow,
            dataRows: x.dataRows, columnCount: x.columnCount, firstColumn: x.firstColumn, lastColumn: x.lastColumn, symbolColumn: x.symbolColumn };
        }), pageSize: 20, columns: [
          { key: 'i', label: 'Table', html: function (x) { return x.i === pg.bi ? ui.badge('Table ' + (x.i + 1) + ' · shown', 's-info') : '<button type="button" class="linkish" data-block="' + x.i + '">Table ' + (x.i + 1) + '</button>'; } },
          { key: 'title', label: 'Title', wrap: true, html: function (x) { return x.title ? esc(clip(x.title, 90)) : dash(); } },
          { key: 'headerRow', label: 'Header row', type: 'num', digits: 0 },
          { key: 'groupHeaderRow', label: 'Group header', type: 'num', digits: 0 },
          { key: 'firstDataRow', label: 'Data rows', get: function (x) { return x.firstDataRow; }, html: function (x) { return x.firstDataRow ? x.firstDataRow + '–' + x.lastDataRow : dash(); } },
          { key: 'dataRows', label: 'Rows', type: 'num', digits: 0 },
          { key: 'columnCount', label: 'Columns', get: function (x) { return x.columnCount; }, html: function (x) { return x.firstColumn ? esc(x.firstColumn + '–' + x.lastColumn) + ' (' + x.columnCount + ')' : dash(); } },
          { key: 'sym', label: 'Symbol column', get: function (x) { return x.symbolColumn ? x.symbolColumn.header : ''; }, html: function (x) { return x.symbolColumn ? esc(x.symbolColumn.letter + ' · ' + (x.symbolColumn.header || '')) : dash(); } }
        ] }).mount($('#xa-blocks-t', el));
      }
      pg.colTable = new ui.Table({ rows: filteredColumns(), pageSize: 25, columns: columnColumns(sh), empty: 'No matching columns' }).mount($('#xa-cols-t', el));
      updateColCount();
      var miss = pg.issues.filter(function (it) { return it.check === 'Missing values'; });
      new ui.Table({ rows: pg.issues.filter(function (it) { return it.check !== 'Missing values'; }), pageSize: 25, columns: issueColumns(), empty: 'No problems found' }).mount($('#xa-q-t', el));
      new ui.Table({ rows: miss, pageSize: 15, columns: issueColumns().filter(function (c) { return c.key !== 'check'; }),
        empty: Array.isArray(b.quality && b.quality.missing) ? 'No missing values' : 'Per-column counts are not in the public summary for this sheet' }).mount($('#xa-miss-t', el));
      var rc = b.reconciliation;
      if (rc && rc.conflicts && rc.conflicts.length) {
        new ui.Table({ rows: rc.conflicts, pageSize: 15, columns: [
          { key: 'symbol', label: 'Stock', html: function (r) { return ui.stockCell(r.symbol, null, { noLogo: true }); } },
          { key: 'row', label: 'Row', type: 'num', digits: 0 },
          { key: 'column', label: 'Column' },
          { key: 'field', label: 'Main field' },
          { key: 'sheet', label: 'Sheet value', wrap: true },
          { key: 'master', label: 'Main value', wrap: true }
        ] }).mount($('#xa-rc-t', el));
      }
      new ui.Table({ rows: (b.columns || []).filter(function (c) { return c.type === 'number' || c.type === 'percent' || c.type === 'date'; }), pageSize: 30,
        columns: statsColumns(sh), empty: 'No numeric columns in this table' }).mount($('#xa-stats-t', el));
    }
    drawRules();
    var info = strategyInfo();
    new ui.Table({ rows: registryRows(info), pageSize: 30, columns: registryColumns(info), empty: 'No rules' }).mount($('#xa-reg-t', el));
    if (pg.stocks.ok) {
      var multi = pg.stocks.items.some(function (it) { return it.rows > 1; });
      pg.stockTable = new ui.Table({ rows: filteredStocks(), pageSize: 25, sort: multi ? { key: 'rows', dir: -1 } : null, columns: stockColumns(pg.stocks), empty: 'No symbols match' }).mount($('#xa-st-t', el));
      applyStocks();
      loadStrategy();
    }
  }
  function updateColCount() {
    var n = PG && $('#xa-colq-n', PG.el);
    if (n && PG.block) n.textContent = F.int(filteredColumns().length) + ' of ' + F.int((PG.block.columns || []).length) + ' columns';
  }
  function selectSheet(name, scroll) {
    var sh = findSheet(name);
    if (!sh) return;
    if (sh.name !== ST.sheet[PG.mode]) { ST.cat = ''; ST.q = ''; ST.colQ = ''; }
    ST.sheet[PG.mode] = sh.name;
    setHash();
    drawSheet();
    if (scroll) scrollToId('xa-sel');
  }
  function step(dir) {
    var list = PG.A.sheets || [], i = list.indexOf(PG.sheet);
    if (!list.length) return;
    selectSheet(list[(i + dir + list.length) % list.length].name);
    var b = $(dir < 0 ? '#xa-prev' : '#xa-next', PG.el);
    if (b) b.focus();
  }

  // ---------- page ----------
  SB.page('excel', {
    render: function (el, params, ctx) {
      PG = { el: el, ctx: ctx, A: null, mode: ST.source };
      if (params[0] === 'public' || params[0] === 'upload') ST.source = params[0];
      if (params[1]) ST.sheet[ST.source] = params[1];
      el.innerHTML = '<div class="page-head"><div><h1>Excel analysis</h1><p>Every worksheet of your Stock Blueprint workbook: structure, data quality, industries, ' +
        'the rules hidden in its formulas and a stock-by-stock view. The workbook is treated as data and as a source of possible rules - not as unquestionable truth.</p></div></div>' +
        '<section class="card" id="xa-src"><div class="card-head"><div><h2>Source</h2><p>Choose what to analyse.</p></div></div>' +
        ui.chips('xa-src', [['public', 'Your sheet export (public summary)'], ['upload', 'Analyse a workbook in this browser']], ST.source) +
        '<div id="xa-src-body" style="margin-top:12px"></div></section>' +
        '<div id="xa-body" style="display:grid;gap:16px"></div>';

      ui.bindChips(el, 'xa-src', function (v) { ST.source = v === 'upload' ? 'upload' : 'public'; JOB.error = null; setHash(); drawSource(); drawBody(); });
      ui.bindChips(el, 'xa-blk', function (v) { ST.block[PG.mode + '|' + PG.sheet.name] = +v; drawSheet(); });
      ui.bindChips(el, 'xa-sc', function (v) { ST.scope = v === 'all' ? 'all' : 'sheet'; drawRules(); });
      ui.bindChips(el, 'xa-cat', function (v) {
        ST.cat = v;
        var s = $('#xa-catsel', el);
        if (s) s.value = v;
        applyStocks();
      });
      el.addEventListener('click', function (e) {
        var t = e.target;
        if (t.closest('[data-pick]')) { var inp = $('#xa-file', el); if (inp) { inp.value = ''; inp.click(); } return; }
        if (t.closest('#xa-clear')) { clearUpload(); return; }
        if (t.closest('#xa-prev')) { step(-1); return; }
        if (t.closest('#xa-next')) { step(1); return; }
        var j = t.closest('[data-jump]');
        if (j) { scrollToId(j.getAttribute('data-jump')); return; }
        var bl = t.closest('[data-block]');
        if (bl) { ST.block[PG.mode + '|' + PG.sheet.name] = +bl.getAttribute('data-block'); drawSheet(); return; }
        var x = t.closest('[data-exp]');
        if (x && !x.disabled) { doExport(x.getAttribute('data-exp')); return; }
        var s = t.closest('[data-sheet]');
        if (s) { selectSheet(s.getAttribute('data-sheet'), true); return; }
        var tr = t.closest('#xa-ov-t tbody tr');                 // whole overview row is clickable
        if (tr && !t.closest('a,button,input,select')) {
          var nb = tr.querySelector('[data-sheet]');
          if (nb) selectSheet(nb.getAttribute('data-sheet'), true);
        }
      });
      el.addEventListener('change', function (e) {
        var t = e.target;
        if (t.id === 'xa-file') { if (t.files && t.files[0]) handleFile(t.files[0]); }
        else if (t.id === 'xa-sheet-sel') selectSheet(t.value);
        else if (t.id === 'xa-catsel') {
          ST.cat = t.value;
          el.querySelectorAll('[data-chip="xa-cat"]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-v') === ST.cat)); });
          applyStocks();
        }
      });
      el.addEventListener('input', function (e) {
        var t = e.target;
        if (t.id === 'xa-stq') { ST.q = t.value; applyStocks(); }
        else if (t.id === 'xa-colq' && PG.colTable) { ST.colQ = t.value; PG.colTable.setRows(filteredColumns()); updateColCount(); }
      });
      // a workbook dropped anywhere on this page is analysed here (and never opened by the browser)
      el.addEventListener('dragover', function (e) { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0) e.preventDefault(); });
      el.addEventListener('drop', function (e) {
        var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (!f) return;
        e.preventDefault();
        if (ST.source !== 'upload') { ST.source = 'upload'; setSourceChips(); }
        handleFile(f);
      });

      drawSource();
      drawBody();
    }
  });
})();
