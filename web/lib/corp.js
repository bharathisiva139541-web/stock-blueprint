/* Corporate Intelligence - the figures of the page #corp (owner, 28-Nov-2026: "Today's Corporate Intelligence" - NSE's
   corporate announcements of his stocks in 6 categories, a priority, the numbers of each filing, three scores, filters and a
   company search; "No AI involvment here"). The laptop sorts and scores every filing by fixed rules
   (pcbridge/ScreenerBridge/corp_ann.py: EVENTS / FILTERS / COLS are the same there - tests/corp-intel.test.js compares them);
   this file only names, counts and filters what it sent. Node-testable (no DOM). */
(function (root) {
  'use strict';
  var COLS = ['id', 'sym', 'co', 'at', 'cat', 'ev', 'ex', 'pr', 'bi', 'gr', 'su', 'risk', 'num', 'sub', 'tx', 'pdf', 'pg', 'why'];
  var CATS = [['A', 'Business Growth & Opportunities'], ['B', 'Financial & Capital'], ['C', 'Management & Governance'], ['D', 'Operational'],
    ['E', 'Risk & Negative'], ['F', 'Investor Communication & Market']];
  var CAT = {};
  CATS.forEach(function (c) { CAT[c[0]] = c[1]; });
  var CAT_TONE = { A: 's-good', B: 's-info', C: 's-warn', D: '', E: 's-bad', F: '' };
  // code: [name, category] - = corp_ann.py EVENTS
  var EVENTS = {
    order: ['Order win', 'A'], capex: ['Capacity expansion / new plant', 'A'], acq: ['Acquisition', 'A'], merger: ['Merger / demerger / scheme', 'A'],
    jv: ['Partnership / JV / MoU', 'A'], approval: ['Approval / product launch', 'A'], results: ['Financial results', 'B'], dividend: ['Dividend', 'B'],
    fund: ['Fundraising', 'B'], buyback: ['Buyback', 'B'], bonus: ['Bonus issue', 'B'], split: ['Stock split', 'B'], rating: ['Credit rating', 'B'],
    allot: ['Allotment of securities / ESOP', 'B'], record: ['Record date / book closure', 'B'], divest: ['Sale of a business / stake', 'B'],
    kmp: ['Top management change', 'C'], director: ['Director change', 'C'], auditor: ['Auditor change', 'C'], meeting: ['Board / shareholders meeting', 'C'],
    sast: ['Promoter / insider shares', 'C'], update: ['Business / sales update', 'D'], ops: ['Operations update', 'D'], sub: ['Subsidiary set up / closed', 'D'],
    pledge: ['Pledge of promoter shares', 'E'], default: ['Default / fraud', 'E'], legal: ['Legal / regulatory / tax action', 'E'],
    insolv: ['Insolvency (NCLT / IBC)', 'E'], disrupt: ['Fire / accident / shutdown', 'E'], call: ['Analyst / investor meet or call', 'F'],
    present: ['Investor presentation / transcript', 'F'], clarify: ['Clarification on news / price move', 'F'], press: ['Press release', 'F'],
    paper: ['Newspaper publication', 'F'], comp: ['Routine compliance filing', 'F'], other: ['Other update', 'F']
  };
  // the owner's filters (= corp_ann.py FILTERS / FILTER_EVENTS)
  var FILTERS = [['all', 'All announcements'], ['high', 'High-impact events'], ['orders', 'Order wins'], ['mgmt', 'Management changes'],
    ['fund', 'Fundraising'], ['results', 'Financial results'], ['calls', 'Investor calls'], ['risk', 'Risk alerts'], ['actions', 'Corporate actions']];
  var FILTER_EVENTS = { orders: ['order'], mgmt: ['kmp', 'director', 'auditor'], fund: ['fund'], results: ['results'], calls: ['call', 'present'],
    actions: ['dividend', 'bonus', 'split', 'buyback', 'record'] };
  var PRI = { high: ['High', 's-bad'], med: ['Medium', 's-warn'], low: ['Low', 's-info'], routine: ['Routine', ''] };
  var PRI_ORDER = { high: 0, med: 1, low: 2, routine: 3 };
  var RATING_ACT = { up: 'upgraded', down: 'downgraded', same: 'reaffirmed', 'new': 'assigned', 'watch-': 'on watch (negative)',
    'outlook-': 'outlook negative', 'outlook+': 'outlook positive', withdrawn: 'withdrawn' };
  var ROLE_ACT = { 'in': 'appointed', out: 'left', change: 'changed', re: 're-appointed' };
  var PLEDGE_ACT = { invoke: 'invoked', release: 'released', create: 'created' };

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /** the api's answer -> row objects (+ day, top = the larger of impact / risk, filters it belongs to) */
  function objects(res) {
    var cols = (res && res.cols) || COLS;
    return ((res && res.rows) || []).map(function (a) {
      var r = {};
      cols.forEach(function (k, i) { r[k] = a[i]; });
      r.ex = Array.isArray(r.ex) ? r.ex : [];
      r.num = r.num && typeof r.num === 'object' ? r.num : {};
      r.day = String(r.at || '').slice(0, 10);
      r.time = String(r.at || '').slice(11, 16);
      r.top = Math.max(r.bi || 0, r.gr || 0);
      r.risk = !!r.risk;
      r.fl = filtersOf(r);
      return r;
    });
  }

  /** the filters (besides 'all') a row belongs to - by its event or one of its other events (results / calls: its own) */
  function filtersOf(r) {
    var evs = [r.ev].concat(r.ex || []), out = [];
    Object.keys(FILTER_EVENTS).forEach(function (f) {
      var list = f === 'results' || f === 'calls' ? [r.ev] : evs;
      if (list.some(function (e) { return FILTER_EVENTS[f].indexOf(e) >= 0; })) out.push(f);
    });
    if (r.pr === 'high') out.push('high');
    if (r.risk) out.push('risk');
    return out;
  }
  function inFilter(r, f) { return !f || f === 'all' || r.fl.indexOf(f) >= 0; }

  /** counts per filter and per category */
  function counts(rows) {
    var f = { all: rows.length }, c = {};
    FILTERS.forEach(function (x) { if (x[0] !== 'all') f[x[0]] = 0; });
    CATS.forEach(function (x) { c[x[0]] = 0; });
    rows.forEach(function (r) {
      r.fl.forEach(function (k) { f[k] = (f[k] || 0) + 1; });
      c[r.cat] = (c[r.cat] || 0) + 1;
    });
    return { filters: f, cats: c, stocks: Object.keys(rows.reduce(function (o, r) { o[r.sym] = 1; return o; }, {})).length };
  }

  /** newest first, then the bigger score */
  function sort(rows) {
    return rows.slice().sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : b.top - a.top; });
  }
  /** the strongest of the selection: high / medium priority, biggest impact or risk first */
  function top(rows, n) {
    return rows.filter(function (r) { return r.pr === 'high' || r.pr === 'med'; }).sort(function (a, b) {
      return PRI_ORDER[a.pr] - PRI_ORDER[b.pr] || b.top - a.top || b.su - a.su || (a.at < b.at ? 1 : -1);
    }).slice(0, n || 6);
  }

  function crore(v) {
    if (!isNum(v)) return '';
    return v >= 100 ? 'Rs ' + Math.round(v).toLocaleString('en-IN') + ' Cr' : 'Rs ' + (Math.round(v * 100) / 100).toLocaleString('en-IN') + ' Cr';
  }
  function months(m) { return m >= 12 && m % 12 === 0 ? (m / 12) + ' year' + (m === 12 ? '' : 's') : (Math.round(m * 10) / 10) + ' months'; }
  function pct(v, d) { return isNum(v) ? (Math.round(v * Math.pow(10, d || 0)) / Math.pow(10, d || 0)) + '%' : ''; }
  function dmy(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '')); return m ? m[3] + '-' + m[2] + '-' + m[1] : String(iso || ''); }

  /** the filing's numbers in short words, the most telling first */
  function numWords(r) {
    var n = r.num || {}, out = [];
    var what = { order: 'Order', capex: 'Capex', acq: 'Deal', merger: 'Deal', divest: 'Deal', jv: 'Value', fund: 'Raise', buyback: 'Buyback',
      legal: 'Amount', default: 'Amount', update: 'Value', press: 'Value', other: 'Value' }[r.ev] || 'Value';
    if (isNum(n.val)) out.push(what + ' ' + crore(n.val) + (n.cur ? ' (' + n.cur + ')' : ''));
    if (isNum(n.pct)) out.push(pct(n.pct, n.pct < 10 ? 1 : 0) + ' of revenue (TTM)');
    if (isNum(n.pcty) && n.pcty !== n.pct) out.push(pct(n.pcty, 1) + ' of a year\'s revenue a year');
    if (isNum(n.mc)) out.push(pct(n.mc, n.mc < 10 ? 1 : 0) + ' of market cap');
    if (isNum(n.mo)) out.push('over ' + months(n.mo));
    if (n.cap) out.push(n.cap);
    if (n.rag || n.rrt) {
      out.push((n.rag ? n.rag + ' ' : '') + (n.rfrom ? n.rfrom + ' → ' : '') + (n.rrt || '') + (n.ract ? ' ' + (RATING_ACT[n.ract] || n.ract) : ''));
    }
    if (isNum(n.dps)) out.push((n.dty ? n.dty.charAt(0).toUpperCase() + n.dty.slice(1) + ' dividend ' : 'Dividend ') + 'Rs ' + n.dps + ' a share');
    else if (isNum(n.dpct)) out.push('Dividend ' + n.dpct + '% of face value');
    if (n.ratio) out.push('Bonus ' + n.ratio);
    if (n.fv) out.push('Face value Rs ' + n.fv[0] + ' → Rs ' + n.fv[1]);
    if (n.ins) out.push(n.ins);
    if (isNum(n.px)) out.push('at Rs ' + n.px + ' a share');
    if (isNum(n.stake)) out.push(pct(n.stake, 2) + ' stake');
    if (isNum(n.gr)) out.push((n.gr >= 0 ? '+' : '') + pct(n.gr, 1) + ' growth');
    if (isNum(n.units)) out.push(n.units.toLocaleString('en-IN') + ' units');
    if (n.pact) out.push('Pledge ' + (PLEDGE_ACT[n.pact] || n.pact) + (isNum(n.pl) ? ' (' + pct(n.pl, 2) + ')' : ''));
    if (n.role) out.push(n.role + (n.act ? ' ' + (ROLE_ACT[n.act] || n.act) : ''));
    if (n.rd) out.push('Record date ' + dmy(n.rd));
    return out;
  }

  /** does the row match the search words (symbol, company, subject, details) */
  function matches(r, q) {
    var w = String(q || '').trim().toLowerCase();
    if (!w) return true;
    return [r.sym, r.co, r.name, r.sub].some(function (v) { return String(v || '').toLowerCase().indexOf(w) >= 0; });
  }

  /** the day keys of a range ending on `today` ('today' / '1' yesterday .. / N days) */
  function rangeDays(today, n) {
    var out = [], d = new Date(today + 'T12:00:00Z');
    for (var k = 0; k < n; k++) out.push(new Date(d.getTime() - k * 86400000).toISOString().slice(0, 10));
    return out;
  }

  var api = { COLS: COLS, CATS: CATS, CAT: CAT, CAT_TONE: CAT_TONE, EVENTS: EVENTS, FILTERS: FILTERS, FILTER_EVENTS: FILTER_EVENTS, PRI: PRI,
    objects: objects, filtersOf: filtersOf, inFilter: inFilter, counts: counts, sort: sort, top: top, numWords: numWords, matches: matches,
    rangeDays: rangeDays, crore: crore };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) { root.SB = root.SB || {}; root.SB.corp = api; }
})(typeof window !== 'undefined' ? window : null);
