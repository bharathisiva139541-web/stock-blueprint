/* Results Edge (owner, 17-Nov-2026: "1703 stocks results were updated as of now. some stocks move because of OPM Qtr, some
   because of Rev % growth, some because of Net profit % growth ... i could not come to a conclusion why the stock is rallying
   ... before next quarterly results arrive, enkita ipo irukura data va vachu oru Complete edge irukanum. Entha parameter
   edukurathu, ethana parameter ah consider panrathu, epdi edutha rally kana possibility iruku ... Oru AI epdi analyse panumo
   athe mari oru dynamic page ... next results season la oru stock results update panumpothu ... next day intha stock ah
   vangalama venamanu oru decision edukura mari venum"; answers: the entry = "if the result released in the market hours,
   same day morning ... after market hour or closed, buy on next trading day"; a rally = "same day or next day 8% ku mela rise
   ... or consistent ah 10 day la nala rise"; the values at result time are NOT frozen in the sheet - Main's values now).

   Browser + Node, no DOM. Learns from the season's results on the website's own data:
     the Results Performance rows (figures, verdict, announcement time, reaction session), Main (PE / PE vs industry /
     PEG / upside / TTM Signal / EPS growth / FII / promoter / OPM Qtr YoY / market cap - Main's values NOW, the price
     ones moved to the entry price), the Results Tracker's flags and the daily candles (History30 + History60).

   SB.edge = {
     DEFAULTS, FEATURES, bucket(feature, value),
     dataset({perf, tracker, stocks, H, sigAt}, opt) -> { rows, skipped }   one row per result: entry, outcome, features
     analyse(ds, opt) -> { base, finished, rallied, pending, features, combos, model, check, summary ... }
     train(rows, opt) -> model (logistic regression on the feature groups);  score(model, row) -> { p, reasons }
   }
   A row: { sym, name, season, rdate, session, entryDay, entry (the reaction session's open), status 'rally'|'no'|'pending'|
   'upcoming', kind 'pop'|'trend'|'both', popMax, ret, maxGain, maxDD, sessions, f {feature id: value}, g {feature id: group key} }. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.SB = root.SB || /** @type {any} */ ({})).edge = factory();
})(/** @type {any} */ (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  // the owner's rally (17-Nov-2026): a jump of popPct within popDays sessions from the entry (the high), OR the close
  // trendDays sessions after the entry (the entry day = session 1) at least trendPct above it
  var DEFAULTS = { popPct: 8, popDays: 2, trendPct: 10, trendDays: 10, rally: 'either', minN: 25, cap: 'all' };
  var CHOICES = {
    popPct: [5, 8, 10, 15, 20], popDays: [1, 2, 3], trendPct: [5, 8, 10, 15, 20], trendDays: [5, 10, 15, 20],
    rally: ['either', 'pop', 'trend'], minN: [15, 25, 40], cap: ['all', 'large', 'mid', 'small', 'micro']
  };

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function dayOf(v) { var m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v || '')); return m ? m[1] : ''; }
  function clean(o) {
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      var v = o && o[k] != null ? o[k] : DEFAULTS[k];
      if (typeof DEFAULTS[k] === 'number') v = Number(v);
      out[k] = CHOICES[k].indexOf(v) >= 0 ? v : DEFAULTS[k];
    });
    return out;
  }

  // ---------- the features (what was known when the stock could be bought) ----------
  var GROWTH = [[-Infinity, -20, 'below -20%'], [-20, 0, '-20% to 0%'], [0, 15, '0% to 15%'], [15, 40, '15% to 40%'],
    [40, 100, '40% to 100%'], [100, Infinity, 'over 100%']];
  var OPM_WORDS = ['Aggressive Increase', 'Increasing', 'Slightly Increasing', 'Stagnant', 'Slightly Decreasing', 'Decreasing', 'Aggressive Decrease'];
  var TREND_WORDS = ['Increasing', 'Stagnant', 'Decreasing', 'Volatile'];
  var FEATURES = [
    { id: 'npY', label: 'Net profit YoY %', topic: 'Results', bands: GROWTH },
    { id: 'npQ', label: 'Net profit QoQ %', topic: 'Results', bands: GROWTH },
    { id: 'revY', label: 'Revenue YoY %', topic: 'Results', bands: GROWTH },
    { id: 'revQ', label: 'Revenue QoQ %', topic: 'Results', bands: GROWTH },
    { id: 'epsg', label: 'EPS growth %', topic: 'Results', bands: GROWTH },
    { id: 'verdict', label: 'Results verdict', topic: 'Results', words: ['Strong', 'Mixed', 'Weak'] },
    { id: 'opmq', label: 'OPM QoQ', topic: 'Margins', words: OPM_WORDS },
    { id: 'opmy', label: 'OPM YoY (yearly)', topic: 'Margins', words: OPM_WORDS },
    { id: 'opmqy', label: 'OPM Qtr YoY', topic: 'Margins', words: OPM_WORDS },
    { id: 'flagFaster', label: 'Flag: profit growing faster than revenue', topic: 'Flags', words: ['Yes', 'No'] },
    { id: 'flagRevDown', label: 'Flag: revenue up, profit down', topic: 'Flags', words: ['Yes', 'No'] },
    { id: 'flagExc', label: 'Flag: exceptional gain', topic: 'Flags', words: ['Yes', 'No'] },
    { id: 'flagOi', label: 'Flag: other income high', topic: 'Flags', words: ['Yes', 'No'] },
    { id: 'pe', label: 'PE at the entry', topic: 'Valuation', bands: [[-Infinity, 0, 'loss-making'], [0, 15, 'under 15'], [15, 30, '15 to 30'],
      [30, 50, '30 to 50'], [50, 100, '50 to 100'], [100, Infinity, 'over 100']] },
    { id: 'pevs', label: 'PE vs industry PE', topic: 'Valuation', bands: [[-Infinity, 0.6, 'under 0.6x (much cheaper)'], [0.6, 0.9, '0.6x to 0.9x'],
      [0.9, 1.2, '0.9x to 1.2x (in line)'], [1.2, 2, '1.2x to 2x'], [2, Infinity, 'over 2x (much dearer)']] },
    { id: 'peg', label: 'PEG at the entry', topic: 'Valuation', bands: [[-Infinity, 0, 'no EPS growth'], [0, 0.5, 'under 0.5'], [0.5, 1, '0.5 to 1'],
      [1, 2, '1 to 2'], [2, Infinity, 'over 2']] },
    { id: 'upside', label: 'Upside to the TTM target', topic: 'Valuation', bands: [[-Infinity, 0, 'above the target'], [0, 15, '0% to 15%'],
      [15, 40, '15% to 40%'], [40, 100, '40% to 100%'], [100, Infinity, 'over 100%']] },
    { id: 'sig', label: 'TTM Signal at the entry', topic: 'Valuation', words: ['Buy', 'Avoid'] },
    { id: 'fii', label: 'FII holding', topic: 'Holders', words: TREND_WORDS },
    { id: 'promo', label: 'Promoter holding', topic: 'Holders', words: TREND_WORDS },
    { id: 'cap', label: 'Market cap', topic: 'Size', words: ['Large cap', 'Mid cap', 'Small cap', 'Micro cap'] },
    { id: 'session', label: 'When the results came', topic: 'Timing', words: ['Before market', 'Market hours', 'After market / closed'] },
    { id: 'gap', label: 'Opening gap on the entry day', topic: 'Price', bands: [[-Infinity, -3, 'down over 3%'], [-3, -1, 'down 1-3%'],
      [-1, 1, 'flat (within 1%)'], [1, 3, 'up 1-3%'], [3, 8, 'up 3-8%'], [8, Infinity, 'up over 8%']] },
    { id: 'run20', label: 'Price move in the 20 sessions before', topic: 'Price', bands: [[-Infinity, -10, 'fell over 10%'], [-10, -3, 'fell 3-10%'],
      [-3, 3, 'flat (within 3%)'], [3, 10, 'rose 3-10%'], [10, 25, 'rose 10-25%'], [25, Infinity, 'rose over 25%']] },
    { id: 'fromHigh', label: 'Below the 60-day high', topic: 'Price', bands: [[-Infinity, 3, 'within 3%'], [3, 10, '3% to 10% below'],
      [10, 20, '10% to 20% below'], [20, 35, '20% to 35% below'], [35, Infinity, 'over 35% below']] },
    { id: 'sma20', label: 'Price vs its 20-day average', topic: 'Price', words: ['Above', 'Below'] },
    { id: 'sma50', label: 'Price vs its 50-day average', topic: 'Price', words: ['Above', 'Below'] },
    { id: 'vol', label: 'Volume the day before vs its 20-day average', topic: 'Price', bands: [[-Infinity, 0.7, 'quiet (under 0.7x)'],
      [0.7, 1.5, 'normal'], [1.5, 3, 'busy (1.5x to 3x)'], [3, Infinity, 'very busy (over 3x)']] },
    { id: 'sector', label: 'Sector', topic: 'Sector', words: null }
  ];
  var FEAT = {};
  FEATURES.forEach(function (f) { FEAT[f.id] = f; });

  /** a feature value -> { key, label, order } (null when unknown) */
  function bucket(f, v) {
    if (typeof f === 'string') f = FEAT[f];
    if (!f || v == null || v === '') return null;
    if (f.bands) {
      if (!isNum(v)) return null;
      for (var i = 0; i < f.bands.length; i++) {
        var b = f.bands[i];
        if (v >= b[0] && v < b[1]) return { key: 'b' + i, label: b[2], order: i };
      }
      return null;
    }
    var w = String(v).trim();
    if (!w) return null;
    var k = f.words ? f.words.indexOf(w) : -1;
    if (f.words && k < 0) return null;
    return { key: w, label: w, order: k < 0 ? 99 : k };
  }

  function capOf(mcap) {
    if (!isNum(mcap) || mcap <= 0) return '';
    return mcap >= 20000 ? 'Large cap' : mcap >= 5000 ? 'Mid cap' : mcap >= 1000 ? 'Small cap' : 'Micro cap';
  }
  function sessionWord(r) {
    var t = String((r && r.Announced) || '').toLowerCase();
    if (/after market|market closed/.test(t)) return 'After market / closed';
    if (/market hours/.test(t)) return 'Market hours';
    if (/before market/.test(t)) return 'Before market';
    return '';
  }
  // the reaction session (Results Performance 'Reaction From': 'after X' = the next session after X, 'from X' = X itself);
  // an older sheet: the result date, the next session when the results came after the market
  function reactFrom(r) {
    var rf = /^(after|from)\s+(\d{4}-\d{2}-\d{2})/.exec(String(r['Reaction From'] || ''));
    if (rf) return { day: rf[2], strict: rf[1] === 'after' };
    var d = dayOf(r['Result Date']);
    return d ? { day: d, strict: sessionWord(r) === 'After market / closed' } : null;
  }
  function flagIds(text) {
    var out = {};
    String(text || '').split(/;\s*/).forEach(function (t) {
      if (/^revenue up, profit down/i.test(t)) out.revdown = true;
      else if (/^profit growing faster/i.test(t)) out.faster = true;
      else if (/^exceptional gain/i.test(t)) out.exc = true;
      else if (/^other income high/i.test(t)) out.oi = true;
    });
    return out;
  }

  // ---------- the dataset ----------
  /** in: perf (Results Performance rows of one season, objects), tracker (Results Tracker rows), stocks (Main stocks: sym,
   *  name, sector, mcap, price, base.price, ttmEps, epsg, tgt, ipe, sig, fii, promo, opmqy), H {dates, bars} (merged
   *  candles: [dateIndex, o, h, l, c, v]), sigAt(stock, price) -> TTM Signal at that price (optional), flagsKnown (the tracker
 *  has a 'Flags' column).
   *  opt: DEFAULTS. -> { rows, skipped: {nostock, nocandles, nodate} } */
  function dataset(input, opt) {
    var P = clean(opt);
    input = input || {};
    var H = input.H || { dates: [], bars: {} };
    var bySym = {};
    (input.stocks || []).forEach(function (s) { if (s && s.sym) bySym[String(s.sym).toUpperCase()] = s; });
    var flags = {};
    (input.tracker || []).forEach(function (t) {
      if (!t || !t.Symbol) return;
      var k = String(t.Symbol).toUpperCase() + '|' + String(t['Quarter Expected'] || '').toUpperCase();
      if (t.Flags) flags[k] = t.Flags;
    });
    var rows = [], skipped = { nostock: 0, nocandles: 0, nodate: 0 };
    var lastDay = H.dates && H.dates.length ? H.dates[H.dates.length - 1] : '';
    (input.perf || []).forEach(function (r) {
      var sym = String(r.Symbol || '').toUpperCase();
      var s = bySym[sym];
      if (!s) { skipped.nostock++; return; }
      var rf = reactFrom(r);
      if (!rf) { skipped.nodate++; return; }
      var bars = ((H.bars || {})[sym] || []).filter(function (b) { return H.dates[b[0]] && isNum(b[4]) && b[4] > 0; });
      // the entry: the reaction session's open
      var e = -1;
      for (var i = 0; i < bars.length; i++) {
        var d = H.dates[bars[i][0]];
        if (rf.strict ? d > rf.day : d >= rf.day) { e = i; break; }
      }
      // no candle on / after the reaction session: not traded yet (a session after the newest candles), else a gap in the data
      if (e < 0 && (!lastDay || (rf.strict ? rf.day < lastDay : rf.day <= lastDay))) { skipped.nocandles++; return; }
      var base = s.base && isNum(s.base.price) && s.base.price > 0 ? s.base.price : s.price;
      var row = { sym: sym, name: s.name || r.Company || '', season: String(r.Quarter || ''), rdate: dayOf(r['Result Date']), ann: r.Announced || '',
        reactDay: rf.day, strict: rf.strict, entryDay: '', entry: null, status: 'upcoming', kind: '', popMax: null, ret: null, maxGain: null,
        maxDD: null, sessions: 0, f: {}, g: {} };
      var f = row.f;
      if (e >= 0) {
        var eb = bars[e];
        row.entryDay = H.dates[eb[0]];
        row.entry = isNum(eb[1]) && eb[1] > 0 ? eb[1] : eb[4];
        row.sessions = bars.length - e;
        // outcome
        var hi = -Infinity, pop = -Infinity;
        for (var j = e; j < bars.length && j < e + P.trendDays; j++) {
          if (j < e + P.popDays) pop = Math.max(pop, bars[j][2]);
          hi = Math.max(hi, bars[j][2]);
        }
        var lo = Infinity;
        for (var k = e; k < bars.length && k < e + P.trendDays; k++) lo = Math.min(lo, bars[k][3]);
        row.popMax = (pop / row.entry - 1) * 100;
        row.maxGain = (hi / row.entry - 1) * 100;
        row.maxDD = (lo / row.entry - 1) * 100;
        var popDone = row.sessions >= P.popDays, trendDone = row.sessions >= P.trendDays;
        if (trendDone) row.ret = (bars[e + P.trendDays - 1][4] / row.entry - 1) * 100;
        var popHit = row.popMax >= P.popPct - 1e-9, trendHit = row.ret != null && row.ret >= P.trendPct - 1e-9;
        var usePop = P.rally !== 'trend', useTrend = P.rally !== 'pop';
        // a result counts only once its WHOLE window is over - a quick jump decided early while a no waits the full window
        // would make the early numbers look better than they are (it is kept as 'pending' with early = 'pop')
        var done = (!usePop || popDone) && (!useTrend || trendDone);
        if (!done) {
          row.status = 'pending';
          if (usePop && popHit) row.early = 'pop';
        } else if ((usePop && popHit) || (useTrend && trendHit)) {
          row.status = 'rally';
          row.kind = usePop && popHit && useTrend && trendHit ? 'both' : usePop && popHit ? 'pop' : 'trend';
        } else row.status = 'no';
        if (e > 0) f.gap = (row.entry / bars[e - 1][4] - 1) * 100;
      }
      // the price features use only the candles BEFORE the entry
      var before = e >= 0 ? bars.slice(0, e) : bars;
      var price = row.entry != null ? row.entry : isNum(s.price) && s.price > 0 ? s.price : null;
      var n = before.length;
      if (n >= 21) f.run20 = (before[n - 1][4] / before[n - 21][4] - 1) * 100;
      if (n >= 5) {
        var top = -Infinity;
        before.slice(-60).forEach(function (b) { top = Math.max(top, b[2]); });
        f.fromHigh = (1 - before[n - 1][4] / top) * 100;
      }
      var avgClose = function (m) { var t = 0; for (var q = n - m; q < n; q++) t += before[q][4]; return t / m; };
      if (n >= 20) f.sma20 = before[n - 1][4] >= avgClose(20) ? 'Above' : 'Below';
      if (n >= 50) f.sma50 = before[n - 1][4] >= avgClose(50) ? 'Above' : 'Below';
      if (n >= 21 && isNum(before[n - 1][5])) {
        var vs = 0, vn = 0;
        for (var q = n - 21; q < n - 1; q++) if (isNum(before[q][5])) { vs += before[q][5]; vn++; }
        if (vn >= 10 && vs > 0) f.vol = before[n - 1][5] / (vs / vn);
      }
      // the results (Results Performance follows Main while the quarter is the newest) + Main's words now
      f.npY = r['NP YoY %']; f.npQ = r['NP QoQ %']; f.revY = r['Rev YoY %']; f.revQ = r['Rev QoQ %'];
      f.epsg = s.epsg; f.verdict = r['Results Verdict'];
      f.opmq = r['OPM QoQ'] || s.opmq; f.opmy = r['OPM YoY'] || s.opmy; f.opmqy = s.opmqy;
      // the flags (Results Tracker 'Flags') only when the sheet has that column (an older copy has none: unknown, not 'No')
      if (input.flagsKnown) {
        var fl = flagIds(flags[sym + '|' + row.season.toUpperCase()]);
        f.flagFaster = fl.faster ? 'Yes' : 'No'; f.flagRevDown = fl.revdown ? 'Yes' : 'No'; f.flagExc = fl.exc ? 'Yes' : 'No'; f.flagOi = fl.oi ? 'Yes' : 'No';
      }
      // valuation at the entry price (Main's TTM EPS / target / industry PE are the new quarter's)
      if (price != null) {
        if (isNum(s.ttmEps)) f.pe = s.ttmEps > 0 ? price / s.ttmEps : -1;
        if (isNum(f.pe) && f.pe > 0 && isNum(s.ipe) && s.ipe > 0) f.pevs = f.pe / s.ipe;
        if (isNum(f.pe) && f.pe > 0 && isNum(s.epsg)) f.peg = s.epsg > 0 ? f.pe / s.epsg : -1;
        if (isNum(s.tgt) && s.tgt > 0) f.upside = (s.tgt / price - 1) * 100;
        f.sig = input.sigAt ? input.sigAt(s, price) : s.sig;
        if (isNum(s.mcap) && base > 0) f.cap = capOf(s.mcap * price / base);
      }
      f.fii = s.fii; f.promo = s.promo;
      f.session = sessionWord(r);
      f.sector = s.sector || '';
      FEATURES.forEach(function (ft) { var b = bucket(ft, f[ft.id]); if (b) row.g[ft.id] = b.key; });
      rows.push(row);
    });
    if (P.cap !== 'all') {
      var want = { large: 'Large cap', mid: 'Mid cap', small: 'Small cap', micro: 'Micro cap' }[P.cap];
      rows = rows.filter(function (r) { return r.f.cap === want; });
    }
    return { rows: rows, skipped: skipped, opt: P };
  }

  // ---------- statistics ----------
  var Z90 = 1.645;
  function wilson(w, n) {
    if (!n) return [null, null];
    var p = w / n, z2 = Z90 * Z90, d = 1 + z2 / n, c = (p + z2 / (2 * n)) / d, h = Z90 * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / d;
    return [Math.max(0, c - h), Math.min(1, c + h)];
  }
  // two-proportion z: the group vs the rest
  function vsRest(w, n, W, N, minN) {
    var rn = N - n, rw = W - w;
    if (n < minN || rn < 5) return 'few';
    var p1 = w / n, p2 = rw / rn, p = W / N, se = Math.sqrt(p * (1 - p) * (1 / n + 1 / rn));
    if (!(se > 0)) return 'chance';
    var z = (p1 - p2) / se;
    return z >= Z90 ? 'better' : z <= -Z90 ? 'worse' : 'chance';
  }
  function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; }
  // the chi-square test of a feature's groups -> an approximate p-value (Wilson-Hilferty)
  function chiP(chi, df) {
    if (!(df > 0)) return 1;
    var x = Math.pow(chi / df, 1 / 3), m = 1 - 2 / (9 * df), s = Math.sqrt(2 / (9 * df));
    var z = (x - m) / s;
    return 0.5 * erfc(z / Math.SQRT2);
  }
  function erfc(x) {
    var t = 1 / (1 + 0.5 * Math.abs(x));
    var y = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 +
      t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? y : 2 - y;
  }
  function isWin(r) { return r.status === 'rally'; }

  /** the finished rows split by entry day: the first 2/3 = development, the rest = test */
  function split(done) {
    var s = done.slice().sort(function (a, b) { return a.entryDay < b.entryDay ? -1 : a.entryDay > b.entryDay ? 1 : 0; });
    var cut = Math.floor(s.length * 2 / 3);
    while (cut > 0 && cut < s.length && s[cut].entryDay === s[cut - 1].entryDay) cut++;   // one day stays in one part
    return { dev: s.slice(0, cut), test: s.slice(cut), at: s[cut] ? s[cut].entryDay : null };
  }

  function featureStats(done, parts, minN) {
    return FEATURES.map(function (ft) {
      var known = done.filter(function (r) { return r.g[ft.id] != null; });
      var N = known.length, Wk = known.filter(isWin).length;
      var by = {};
      known.forEach(function (r) {
        var k = r.g[ft.id], b = by[k];
        if (!b) {
          var bk = bucket(ft, r.f[ft.id]);
          b = by[k] = { key: k, label: bk.label, order: bk.order, n: 0, wins: 0, rets: [], pops: [] };
        }
        b.n++;
        if (isWin(r)) b.wins++;
        if (isNum(r.ret)) b.rets.push(r.ret);
        if (isNum(r.popMax)) b.pops.push(r.popMax);
      });
      var base = N ? Wk / N : null;
      var partRate = function (rows, key) {
        var g = rows.filter(function (r) { return r.g[ft.id] === key; });
        var all = rows.filter(function (r) { return r.g[ft.id] != null; });
        return { n: g.length, rate: g.length ? g.filter(isWin).length / g.length : null,
          base: all.length ? all.filter(isWin).length / all.length : null };
      };
      var chi = 0, df = -1;
      var groups = Object.keys(by).map(function (k) {
        var b = by[k], ci = wilson(b.wins, b.n);
        // only groups big enough for the test (a few results in a group would make luck look like an edge)
        if (b.n >= minN && base > 0 && base < 1) { chi += Math.pow(b.wins - b.n * base, 2) / (b.n * base * (1 - base)); df++; }
        var d = partRate(parts.dev, k), t = partRate(parts.test, k);
        var held = '';
        if (d.n >= 10 && t.n >= 10 && d.base != null && t.base != null) {
          var up = d.rate > d.base, tup = t.rate > t.base;
          held = up === tup ? 'yes' : 'no';
        }
        return { key: k, label: b.label, order: b.order, n: b.n, wins: b.wins, rate: b.n ? b.wins / b.n : null, lo: ci[0], hi: ci[1],
          avgRet: mean(b.rets), avgPop: mean(b.pops), lift: base != null && b.n ? b.wins / b.n - base : null,
          verdict: vsRest(b.wins, b.n, Wk, N, minN), dev: d, test: t, held: held };
      }).sort(function (a, b) { return a.order - b.order || (a.label < b.label ? -1 : 1); });
      var p = df > 0 ? chiP(chi, df) : 1;
      // strength = Cramér's V (0 none .. 1 decides everything)
      var v = N && df > 0 ? Math.sqrt(chi / N) : 0;
      var good = groups.filter(function (g) { return g.verdict === 'better'; }).sort(function (a, b) { return b.rate - a.rate; });
      var bad = groups.filter(function (g) { return g.verdict === 'worse'; }).sort(function (a, b) { return a.rate - b.rate; });
      // "real": the groups differ beyond luck even after testing ~30 figures (p < 0.3% = 10% shared out), and a clear group pointed the same
      // way in the earlier and the later part of the season
      var heldOne = good.concat(bad).some(function (g) { return g.held === 'yes'; });
      return { id: ft.id, label: ft.label, topic: ft.topic, n: N, wins: Wk, base: base, groups: groups, chi: chi, p: p,
        strength: v, real: p < 0.003 && N >= minN * 2 && heldOne, best: good[0] || null, worst: bad[0] || null };
    }).sort(function (a, b) { return (b.real ? 1 : 0) - (a.real ? 1 : 0) || b.strength - a.strength; });
  }

  // ---------- combinations of 2 or 3 conditions ----------
  function combos(parts, minN) {
    var dev = parts.dev, test = parts.test;
    if (dev.length < minN * 3) return [];
    var conds = [];
    FEATURES.forEach(function (ft) {
      if (ft.id === 'sector') return;
      var keys = {};
      dev.forEach(function (r) { var k = r.g[ft.id]; if (k != null) keys[k] = (keys[k] || 0) + 1; });
      Object.keys(keys).forEach(function (k) {
        if (keys[k] < minN) return;
        var bits = new Uint8Array(dev.length);
        dev.forEach(function (r, i) { if (r.g[ft.id] === k) bits[i] = 1; });
        var b0 = null;
        for (var i = 0; i < dev.length; i++) if (dev[i].g[ft.id] === k) { b0 = bucket(ft, dev[i].f[ft.id]); break; }
        conds.push({ f: ft.id, k: k, label: ft.label + ': ' + (b0 ? b0.label : k), bits: bits });
      });
    });
    var win = new Uint8Array(dev.length);
    var devBase = dev.filter(isWin).length / dev.length;
    dev.forEach(function (r, i) { if (isWin(r)) win[i] = 1; });
    function evalSet(set) {
      var n = 0, w = 0;
      for (var i = 0; i < dev.length; i++) {
        var ok = 1;
        for (var c = 0; c < set.length && ok; c++) ok = set[c].bits[i];
        if (ok) { n++; w += win[i]; }
      }
      return { n: n, w: w, lo: wilson(w, n)[0] };
    }
    var pairs = [];
    for (var a = 0; a < conds.length; a++) {
      for (var b = a + 1; b < conds.length; b++) {
        if (conds[a].f === conds[b].f) continue;
        var e = evalSet([conds[a], conds[b]]);
        if (e.n >= minN) pairs.push({ set: [conds[a], conds[b]], n: e.n, w: e.w, lo: e.lo });
      }
    }
    pairs.sort(function (x, y) { return y.lo - x.lo; });
    var all = pairs.slice(0, 40);
    pairs.slice(0, 20).forEach(function (p) {
      conds.forEach(function (c) {
        if (p.set.some(function (s) { return s.f === c.f; })) return;
        var set = p.set.concat([c]), e = evalSet(set);
        if (e.n >= minN) all.push({ set: set, n: e.n, w: e.w, lo: e.lo });
      });
    });
    var seen = {};
    all = all.filter(function (c) {
      var key = c.set.map(function (s) { return s.f + '=' + s.k; }).sort().join('&');
      if (seen[key]) return false;
      seen[key] = true;
      return c.lo > devBase;                        // clearly above the earlier part's rate, not just by luck
    }).sort(function (x, y) { return y.lo - x.lo; }).slice(0, 12);
    return all.map(function (c) {
      var t = test.filter(function (r) { return c.set.every(function (s) { return r.g[s.f] === s.k; }); });
      var tw = t.filter(isWin).length;
      var tb = test.length ? test.filter(isWin).length / test.length : null;
      var rets = t.map(function (r) { return r.ret; }).filter(isNum);
      return { label: c.set.map(function (s) { return s.label; }), conds: c.set.map(function (s) { return { f: s.f, k: s.k }; }),
        devN: c.n, devRate: c.w / c.n, devLo: c.lo, testN: t.length, testRate: t.length ? tw / t.length : null, testBase: tb, testAvgRet: mean(rets),
        // held = in the later part it is clearly above that part's own rate (90%); 'no' = at or under it; 'unclear' between
        held: t.length >= 10 && tb != null ? (wilson(tw, t.length)[0] > tb ? 'yes' : tw / t.length <= tb ? 'no' : 'unclear') : '' };
    });
  }

  // ---------- the score: logistic regression on the feature groups (L2-shrunk) ----------
  function colsOf(rows) {
    var cols = [], at = {};
    FEATURES.forEach(function (ft) {
      var cnt = {};
      rows.forEach(function (r) { var k = r.g[ft.id]; if (k != null) cnt[k] = (cnt[k] || 0) + 1; });
      Object.keys(cnt).forEach(function (k) { if (cnt[k] >= 8) { at[ft.id + '|' + k] = cols.length; cols.push(ft.id + '|' + k); } });
    });
    return { cols: cols, at: at };
  }
  function xOf(row, at) {
    var x = [];
    FEATURES.forEach(function (ft) { var k = row.g[ft.id]; if (k != null && at[ft.id + '|' + k] != null) x.push(at[ft.id + '|' + k]); });
    return x;
  }
  function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
  function train(rows, opt) {
    opt = opt || {};
    var lam = opt.lambda != null ? opt.lambda : 0.03, iters = opt.iters || 400, lr = opt.lr || 0.5;
    var c = colsOf(rows), m = c.cols.length, n = rows.length;
    var X = rows.map(function (r) { return xOf(r, c.at); }), y = rows.map(function (r) { return isWin(r) ? 1 : 0; });
    var pos = y.reduce(function (a, b) { return a + b; }, 0);
    var p0 = n ? Math.min(0.99, Math.max(0.01, pos / n)) : 0.5;
    var w = new Float64Array(m), b = Math.log(p0 / (1 - p0));
    // Adam on the mean log-loss + lam/2 |w|^2
    var mw = new Float64Array(m), vw = new Float64Array(m), mb = 0, vb = 0, b1 = 0.9, b2 = 0.999, eps = 1e-8;
    for (var it = 1; it <= iters && n; it++) {
      var gw = new Float64Array(m), gb = 0;
      for (var i = 0; i < n; i++) {
        var z = b;
        for (var j = 0; j < X[i].length; j++) z += w[X[i][j]];
        var d = sigmoid(z) - y[i];
        gb += d;
        for (var q = 0; q < X[i].length; q++) gw[X[i][q]] += d;
      }
      gb /= n;
      for (var k = 0; k < m; k++) gw[k] = gw[k] / n + lam * w[k];
      mb = b1 * mb + (1 - b1) * gb; vb = b2 * vb + (1 - b2) * gb * gb;
      b -= lr * 0.1 * (mb / (1 - Math.pow(b1, it))) / (Math.sqrt(vb / (1 - Math.pow(b2, it))) + eps);
      for (var k2 = 0; k2 < m; k2++) {
        mw[k2] = b1 * mw[k2] + (1 - b1) * gw[k2]; vw[k2] = b2 * vw[k2] + (1 - b2) * gw[k2] * gw[k2];
        w[k2] -= lr * 0.1 * (mw[k2] / (1 - Math.pow(b1, it))) / (Math.sqrt(vw[k2] / (1 - Math.pow(b2, it))) + eps);
      }
    }
    return { cols: c.cols, w: Array.prototype.slice.call(w).map(function (v) { return Math.round(v * 1e4) / 1e4; }), b: Math.round(b * 1e4) / 1e4,
      base: n ? pos / n : null, n: n };
  }
  /** a row's rally chance under a model + the reasons (each group's pull, in points = 10 x its log-odds) */
  function score(model, row) {
    if (!model || !model.cols) return null;
    var z = model.b, reasons = [];
    model.cols.forEach(function (col, i) {
      var p = col.indexOf('|'), fid = col.slice(0, p), key = col.slice(p + 1);
      if (row.g[fid] !== key || !model.w[i]) return;
      z += model.w[i];
      var b = bucket(FEAT[fid], row.f[fid]);
      reasons.push({ f: fid, label: (FEAT[fid] ? FEAT[fid].label : fid) + ': ' + (b ? b.label : key), pts: Math.round(model.w[i] * 10) });
    });
    reasons.sort(function (a, b) { return Math.abs(b.pts) - Math.abs(a.pts); });
    return { p: sigmoid(z), reasons: reasons.filter(function (r) { return r.pts; }) };
  }
  function auc(scored) {
    var pos = scored.filter(function (s) { return s.y; }), neg = scored.filter(function (s) { return !s.y; });
    if (!pos.length || !neg.length) return null;
    var all = scored.slice().sort(function (a, b) { return a.p - b.p; });
    var sumPos = 0, i = 0;
    while (i < all.length) {
      var j = i;
      while (j < all.length && all[j].p === all[i].p) j++;
      var r = (i + 1 + j) / 2;
      for (var k = i; k < j; k++) if (all[k].y) sumPos += r;
      i = j;
    }
    return (sumPos - pos.length * (pos.length + 1) / 2) / (pos.length * neg.length);
  }
  /** the model trained on the development part, judged on the test part: the test results in 5 score bands */
  function check(parts) {
    if (parts.dev.length < 60 || parts.test.length < 30) return null;
    var m = train(parts.dev);
    var sc = parts.test.map(function (r) { return { p: score(m, r).p, y: isWin(r) ? 1 : 0, ret: r.ret }; }).sort(function (a, b) { return b.p - a.p; });
    var bands = [], per = Math.ceil(sc.length / 5);
    for (var i = 0; i < 5; i++) {
      var part = sc.slice(i * per, (i + 1) * per);
      if (!part.length) continue;
      bands.push({ band: i + 1, n: part.length, rate: part.filter(function (s) { return s.y; }).length / part.length,
        avgP: mean(part.map(function (s) { return s.p; })), avgRet: mean(part.map(function (s) { return s.ret; }).filter(isNum)) });
    }
    var tb = sc.filter(function (s) { return s.y; }).length / sc.length;
    var a = auc(sc);
    // how sure: the AUC's standard error (Hanley & McNeil 1982) - an edge only when its 90% lower end stays above 0.5
    var nP = sc.filter(function (s) { return s.y; }).length, nN = sc.length - nP, se = null, lo = null;
    if (a != null) {
      var q1 = a / (2 - a), q2 = 2 * a * a / (1 + a);
      se = Math.sqrt(Math.max(0, (a * (1 - a) + (nP - 1) * (q1 - a * a) + (nN - 1) * (q2 - a * a)) / (nP * nN)));
      lo = a - Z90 * se;
    }
    return { auc: a, aucLo: lo, testBase: tb, bands: bands, n: sc.length, pos: nP,
      verdict: a == null || nP < 10 ? 'few' : lo <= 0.5 ? 'weak' : a >= 0.62 ? 'good' : 'some' };
  }

  function decision(p, base) {
    if (p == null || base == null) return { id: 'none', label: 'No score' };
    if (p >= base * 1.5 && p >= 0.2) return { id: 'buy', label: 'Buy candidate' };
    if (p >= base * 1.15) return { id: 'watch', label: 'Watch' };
    if (p < base * 0.8) return { id: 'avoid', label: 'Avoid' };
    return { id: 'neutral', label: 'Neutral' };
  }

  // ---------- everything at once ----------
  function analyse(ds, opt) {
    var P = clean(opt || (ds && ds.opt));
    var rows = (ds && ds.rows) || [];
    var done = rows.filter(function (r) { return r.status === 'rally' || r.status === 'no'; });
    var rallied = done.filter(isWin);
    var base = done.length ? rallied.length / done.length : null;
    var parts = split(done);
    var feats = featureStats(done, parts, P.minN);
    var cmb = base != null ? combos(parts, P.minN) : [];
    var chk = check(parts);
    var model = done.length >= 60 ? train(done) : null;
    var kinds = { pop: 0, trend: 0, both: 0 };
    rallied.forEach(function (r) { kinds[r.kind] = (kinds[r.kind] || 0) + 1; });
    rows.forEach(function (r) {
      var s = model ? score(model, r) : null;
      r.p = s ? s.p : null;
      r.reasons = s ? s.reasons : [];
      r.decision = decision(r.p, base);
    });
    return { opt: P, rows: rows, finished: done.length, rallied: rallied.length, base: base, kinds: kinds,
      pending: rows.filter(function (r) { return r.status === 'pending'; }).length,
      upcoming: rows.filter(function (r) { return r.status === 'upcoming'; }).length,
      split: { at: parts.at, dev: parts.dev.length, test: parts.test.length },
      avgRet: mean(done.map(function (r) { return r.ret; }).filter(isNum)),
      features: feats, combos: cmb, check: chk, model: model };
  }

  return { DEFAULTS: DEFAULTS, CHOICES: CHOICES, FEATURES: FEATURES, bucket: bucket, dataset: dataset, analyse: analyse, train: train,
    score: score, auc: auc, wilson: wilson, decision: decision, clean: clean, capOf: capOf, reactFrom: reactFrom };
});
