/* Industry & sector intelligence - data layer (browser + Node, no DOM).
   Source of truth: data/classification/nse-industry-classification.json (NSE Indices
   Industry Classification Structure: Macro-Economic Sector > Sector > Industry > Basic
   Industry), built into web/data/industries.js by tools/build_industry_data.js.

   SB.industry = {
     createIndex(master)            -> I (hierarchy, ids, slugs, routes, breadcrumbs)
     classifyStock(I, stock)        -> { status, basicId, industryId, sectorId, macroId, sheet, note }
     mapStocks(I, stocks)           -> { bySym, byBasic, byNode(id), counts, basicsWithStocks }
     capBucket(stock)               -> { key, label }   (Nifty index membership in the Main tab)
     searchIndex(I, stocks, map)    -> S;  search(S, query, opts) -> [{ type, id, sym, label, crumbs, route, score }]
     filterRows(rows, filters)      -> rows matching every non-empty filter
     periodReturn(stock, candles, period) -> { value, asOf, state } | null
     aggregate(members, valueOf)    -> { n, withData, adv, dec, flat, median, mean, breadthPct, leaders, laggards, ranked }
     volumeTrend(candles)           -> % change of the 5-day vs prior 20-day average volume, or null
   }
   Statuses: verified     = the sheet's Sector / Industry / Basic Industry match the official
                            table exactly (punctuation and case ignored)
             conflicting  = the Basic Industry is official but the sheet's Sector / Industry
                            above it are not its official parents
             pending      = a classification is typed in but its Basic Industry is not an
                            official name (needs checking)
             unclassified = no classification in the sheet */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.SB = root.SB || /** @type {any} */ ({})).industry = factory();
})(/** @type {any} */ (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  var LEVELS = ['macro', 'sector', 'industry', 'basic'];
  var LEVEL_NAMES = { macro: 'Macro-economic sector', sector: 'Sector', industry: 'Industry', basic: 'Basic industry' };
  var PREFIX = { macro: 'm-', sector: 's-', industry: 'i-', basic: 'b-' };
  var MIN_MEMBERS = 3;          // an industry needs this many stocks with data to be ranked strong / weak

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  /** Comparable key: lower case, '&' = 'and', only letters and digits. */
  function key(s) { return String(s == null ? '' : s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ''); }
  /** Search tokens: lower case words ('&' = 'and'). */
  function tokens(s) { return String(s == null ? '' : s).toLowerCase().replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(Boolean); }

  // ---------- hierarchy ----------
  function createIndex(master) {
    var M = master || {};
    var I = { meta: M.meta || {}, byId: {}, bySlug: { macro: {}, sector: {}, industry: {}, basic: {} }, byKey: { macro: {}, sector: {}, industry: {}, basic: {} },
      macros: [], sectors: [], industries: [], basics: [] };
    function add(level, raw, parentId) {
      var n = { id: raw.id, level: level, name: raw.name, parentId: parentId || null, children: [], order: raw.order || 0, raw: raw };
      I.byId[n.id] = n;
      I.bySlug[level][slugOf(n.id)] = n.id;
      I.byKey[level][key(n.name)] = n.id;
      if (parentId && I.byId[parentId]) I.byId[parentId].children.push(n.id);
      return n;
    }
    (M.macros || []).forEach(function (r) { I.macros.push(add('macro', r, null)); });
    (M.sectors || []).forEach(function (r) { I.sectors.push(add('sector', r, r.macroId)); });
    (M.industries || []).forEach(function (r) { I.industries.push(add('industry', r, r.sectorId)); });
    (M.basics || []).forEach(function (r) { I.basics.push(add('basic', r, r.industryId)); });
    I.node = function (id) { return I.byId[id] || null; };
    /** [macro, sector, industry, basic] nodes from the top down to id. */
    I.path = function (id) {
      var out = [], n = I.byId[id];
      while (n) { out.unshift(n); n = n.parentId ? I.byId[n.parentId] : null; }
      return out;
    };
    I.ancestor = function (id, level) {
      var p = I.path(id);
      for (var i = 0; i < p.length; i++) if (p[i].level === level) return p[i];
      return null;
    };
    /** Every basic-industry id under a node (the node itself when it is a basic industry). */
    I.basicsUnder = function (id) {
      var n = I.byId[id], out = [];
      if (!n) return out;
      (function walk(x) {
        if (x.level === 'basic') { out.push(x.id); return; }
        x.children.forEach(function (c) { walk(I.byId[c]); });
      })(n);
      return out;
    };
    I.route = function (id) { var n = I.byId[id]; return n ? '#industries/' + n.level + '/' + slugOf(id) : '#industries'; };
    I.resolve = function (level, slug) { return (I.bySlug[level] || {})[slug] || null; };
    I.crumbs = function (id) { return I.path(id).map(function (n) { return n.name; }); };
    I.counts = { macro: I.macros.length, sector: I.sectors.length, industry: I.industries.length, basic: I.basics.length };
    return I;
  }
  function slugOf(id) { return String(id || '').replace(/^[msib]-/, ''); }

  // ---------- company mapping ----------
  function sheetOf(stock) {
    var r = stock && stock.raw ? stock.raw : stock || {};
    return { sector: r.sector || '', industry: r.industry || '', basic: r.ind != null ? r.ind : r.basicIndustry || '' };
  }
  function classifyStock(I, stock) {
    var sh = sheetOf(stock);
    var out = { status: 'unclassified', basicId: null, industryId: null, sectorId: null, macroId: null, sheet: sh, note: '' };
    if (!key(sh.sector) && !key(sh.industry) && !key(sh.basic)) { out.note = 'No classification in the sheet.'; return out; }
    var bId = I.byKey.basic[key(sh.basic)];
    if (!bId) {
      out.status = 'pending';
      var iId = I.byKey.industry[key(sh.industry)];
      if (iId) { var ip = I.path(iId); out.industryId = iId; out.sectorId = ip[1] && ip[1].id; out.macroId = ip[0] && ip[0].id; }
      out.note = key(sh.basic) ? 'Basic industry "' + sh.basic + '" is not in the official list.' : 'Basic industry missing in the sheet.';
      return out;
    }
    var p = I.path(bId);
    out.macroId = p[0].id; out.sectorId = p[1].id; out.industryId = p[2].id; out.basicId = bId;
    if (key(sh.sector) === key(p[1].name) && key(sh.industry) === key(p[2].name)) { out.status = 'verified'; return out; }
    out.status = 'conflicting';
    out.note = 'The sheet says ' + (sh.sector || '-') + ' / ' + (sh.industry || '-') + '; the official parents of "' + p[3].name + '" are ' + p[1].name + ' / ' + p[2].name + '.';
    return out;
  }
  function mapStocks(I, stocks) {
    var bySym = {}, byBasic = {}, counts = { verified: 0, conflicting: 0, pending: 0, unclassified: 0 };
    (stocks || []).forEach(function (s) {
      var c = classifyStock(I, s);
      bySym[s.sym] = c;
      counts[c.status]++;
      if (c.basicId) (byBasic[c.basicId] = byBasic[c.basicId] || []).push(s.sym);
    });
    var cache = {};
    return {
      bySym: bySym, byBasic: byBasic, counts: counts,
      basicsWithStocks: Object.keys(byBasic).length,
      /** symbols mapped anywhere under a node */
      byNode: function (id) {
        if (cache[id]) return cache[id];
        var out = [];
        I.basicsUnder(id).forEach(function (b) { (byBasic[b] || []).forEach(function (s) { out.push(s); }); });
        cache[id] = out;
        return out;
      }
    };
  }

  // ---------- market-cap bucket (Nifty index membership recorded in the Main tab) ----------
  var CAP = [
    { key: 'large', label: 'Large cap', re: /^(nifty50|niftynext50|nifty100)$/ },
    { key: 'mid', label: 'Mid cap', re: /^(niftymidcap50|midcapnext100|niftymidcap150|midcap150|niftymidcap100)$/ },
    { key: 'small', label: 'Small cap', re: /^(smallcap50|smallcap51250|smallcap250|niftysmallcap250|niftysmallcap50)$/ },
    { key: 'micro', label: 'Micro cap', re: /^(microcap250|niftymicrocap250)$/ },
    { key: 'sme', label: 'SME', re: /^(niftysme|sme|niftyemerge)$/ }
  ];
  var CAP_LABEL = { large: 'Large cap', mid: 'Mid cap', small: 'Small cap', micro: 'Micro cap', sme: 'SME', other: 'Other listed' };
  function capBucket(stock) {
    var parts = String((stock && stock.idx) || '').split(/[,;|/]+/).map(key).filter(Boolean);
    for (var k = 0; k < CAP.length; k++) {
      for (var j = 0; j < parts.length; j++) if (CAP[k].re.test(parts[j])) return { key: CAP[k].key, label: CAP[k].label };
    }
    return { key: 'other', label: CAP_LABEL.other };
  }

  // ---------- search ----------
  function editWithin(a, b, max) {        // Damerau-Levenshtein distance <= max (small strings)
    if (Math.abs(a.length - b.length) > max) return false;
    var prev2 = null, prev = [], cur, i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      var best = i;
      for (j = 1; j <= b.length; j++) {
        var cost = a[i - 1] === b[j - 1] ? 0 : 1;
        var v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
        cur[j] = v;
        if (v < best) best = v;
      }
      if (best > max) return false;
      prev2 = prev; prev = cur;
    }
    return prev[b.length] <= max;
  }
  function tokenScore(q, t) {
    if (t === q) return 3;
    if (t.indexOf(q) === 0) return 2;
    if (q.length >= 4 && editWithin(q, t.slice(0, Math.max(q.length, Math.min(t.length, q.length + 1))), q.length >= 8 ? 2 : 1)) return 1;
    if (q.length >= 4 && editWithin(q, t, q.length >= 8 ? 2 : 1)) return 1;
    return 0;
  }
  /** Precomputed search entries for the hierarchy and the mapped companies. */
  function searchIndex(I, stocks, map) {
    var entries = [];
    LEVELS.forEach(function (level) {
      var list = level === 'macro' ? I.macros : level === 'sector' ? I.sectors : level === 'industry' ? I.industries : I.basics;
      list.forEach(function (n) {
        var aliases = (n.raw && n.raw.aliases) || [];
        entries.push({ type: level, id: n.id, label: n.name, crumbs: I.crumbs(n.id), route: I.route(n.id),
          keys: [key(n.name)].concat(aliases.map(key)), toks: tokens([n.name].concat(aliases).join(' ')) });
      });
    });
    (stocks || []).forEach(function (s) {
      var c = map && map.bySym[s.sym];
      var target = c && (c.basicId || c.industryId);
      entries.push({ type: 'company', sym: s.sym, id: target || null, label: s.name || s.sym, crumbs: target ? I.crumbs(target) : [],
        route: target ? I.route(target) : null, status: c ? c.status : 'unclassified', symKey: key(s.sym),
        keys: [key(s.name)], toks: tokens(s.name || '') });
    });
    return { entries: entries };
  }
  var TYPE_BONUS = { basic: 4, industry: 3, sector: 2, macro: 1, company: 0 };
  function search(S, query, opts) {
    var o = opts || {};
    var qk = key(query), qt = tokens(query);
    if (!qk) return [];
    var out = [];
    S.entries.forEach(function (e) {
      if (o.types && o.types.indexOf(e.type) < 0) return;
      var score = 0;
      if (e.symKey) {
        if (e.symKey === qk) score = 120;
        else if (e.symKey.indexOf(qk) === 0) score = 95;
      }
      e.keys.forEach(function (k) {
        if (!k) return;
        if (k === qk) score = Math.max(score, 110);
        else if (k.indexOf(qk) === 0) score = Math.max(score, 85);
        else if (qk.length >= 3 && k.indexOf(qk) > 0) score = Math.max(score, 55);
      });
      if (score < 85 && qt.length) {
        var total = 0, all = true;
        qt.forEach(function (q) {
          var best = 0;
          e.toks.forEach(function (t) { var v = tokenScore(q, t); if (v > best) best = v; });
          if (!best && !(q === 'and' || q === 'the' || q === 'of')) all = false;
          total += best;
        });
        if (all && total) score = Math.max(score, 30 + total * 8);
      }
      if (score) out.push({ type: e.type, id: e.id, sym: e.sym || null, label: e.label, crumbs: e.crumbs, route: e.route, status: e.status || null,
        score: score + TYPE_BONUS[e.type] });
    });
    out.sort(function (a, b) { return b.score - a.score || a.label.localeCompare(b.label); });
    return out.slice(0, o.limit || 12);
  }

  // ---------- filters ----------
  /** rows: [{ macroId, sectorId, industryId, basicId, exchange, status, cap }]; filters: same keys, '' = any. */
  function filterRows(rows, f) {
    var x = f || {};
    var keys = ['macroId', 'sectorId', 'industryId', 'basicId', 'exchange', 'status', 'cap'].filter(function (k) { return x[k]; });
    return (rows || []).filter(function (r) {
      for (var i = 0; i < keys.length; i++) if (r[keys[i]] !== x[keys[i]]) return false;
      return true;
    });
  }

  // ---------- performance ----------
  var PERIOD_BARS = { '1W': 5, '1M': 21, '3M': 63, '6M': 126, '1Y': 250 };
  /** Return of one stock over a period: 1D from the shown price change; longer periods from
   *  daily closes (last close vs the close N sessions earlier). null when the data is too short. */
  function periodReturn(stock, candles, period) {
    if (period === '1D') return isNum(stock && stock.chg) ? { value: stock.chg, asOf: stock.priceAsOf || null, state: stock.priceState || null } : null;
    var bars = PERIOD_BARS[period], c = candles || [];
    if (!bars || c.length <= bars) return null;
    var last = c[c.length - 1], base = c[c.length - 1 - bars];
    if (!last || !base || !(base.c > 0) || !isNum(last.c)) return null;
    return { value: (last.c / base.c - 1) * 100, asOf: last.t, state: 'EOD' };
  }
  function median(a) {
    if (!a.length) return null;
    var s = a.slice().sort(function (x, y) { return x - y; }), m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  /** Equal-weighted summary of member returns. members: [{ sym, value }] (value null = no data). */
  function aggregate(members) {
    var withData = (members || []).filter(function (m) { return isNum(m.value); });
    var vals = withData.map(function (m) { return m.value; });
    var adv = vals.filter(function (v) { return v > 0; }).length, dec = vals.filter(function (v) { return v < 0; }).length;
    var sorted = withData.slice().sort(function (a, b) { return b.value - a.value; });
    return {
      n: (members || []).length, withData: withData.length, adv: adv, dec: dec, flat: withData.length - adv - dec,
      median: median(vals), mean: vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : null,
      breadthPct: adv + dec ? adv / (adv + dec) * 100 : null,
      leaders: sorted.slice(0, 3), laggards: sorted.slice(-3).reverse(),
      ranked: withData.length >= MIN_MEMBERS
    };
  }
  /** 5-day average volume vs the 20 days before it, in %. */
  function volumeTrend(candles) {
    var c = candles || [];
    if (c.length < 25) return null;
    function avg(a) { var v = a.map(function (x) { return x.v; }).filter(function (x) { return isNum(x) && x >= 0; }); return v.length ? v.reduce(function (p, q) { return p + q; }, 0) / v.length : null; }
    var recent = avg(c.slice(-5)), prior = avg(c.slice(-25, -5));
    return recent != null && prior > 0 ? (recent / prior - 1) * 100 : null;
  }

  return {
    LEVELS: LEVELS, LEVEL_NAMES: LEVEL_NAMES, PREFIX: PREFIX, MIN_MEMBERS: MIN_MEMBERS, CAP_LABEL: CAP_LABEL, PERIOD_BARS: PERIOD_BARS,
    key: key, tokens: tokens, slugOf: slugOf, createIndex: createIndex, classifyStock: classifyStock, mapStocks: mapStocks,
    capBucket: capBucket, searchIndex: searchIndex, search: search, filterRows: filterRows,
    periodReturn: periodReturn, aggregate: aggregate, median: median, volumeTrend: volumeTrend, editWithin: editWithin
  };
});
