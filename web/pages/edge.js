/* Results Edge (#edge) - owner, 17-Nov-2026: "1703 stocks results were updated as of now ... i could not come to a conclusion
   why the stock is rallying ... Entha parameter edukurathu, ethana parameter ah consider panrathu, epdi edutha rally kana
   possibility iruku. make a separate page alone for this. Oru AI epdi analyse panumo athe mari oru dynamic page reactive the
   data change ... next results season la oru stock results update panumpothu ... next day intha stock ah vangalama venamanu
   oru decision edukura mari venum". The season's results, learned on the website's own data (web/lib/edge.js): what went
   with a rally, the best combinations, a score for every result checked on the later part of the season, and the decision
   list for the newest results. Recomputed whenever the data changes (every feed refresh).
   Owner, 17-Nov-2026 (second look): five figures removed (60-day high, 50-day average, 20-session move, FII, promoter), a
   "Show: whole season as one" choice next to "earlier vs later part", and a "Study: gap-up open" for results that came after
   the market / on a closed day (Gap-up chance, Likely gap-up / Maybe / Unlikely). */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, esc = ui.esc, F = ui.F, $ = ui.$, R = SB.results, E = SB.edge;
  var OPT_KEY = 'sb:edge:opts', MODEL_KEY = 'sb:edge:models';
  var ST = { opt: E.clean(store(OPT_KEY) || {}), q: '', list: 'all', feat: null };
  var MEMO = { key: '', A: null };

  function store(k, v) {
    try {
      if (v === undefined) return JSON.parse(localStorage.getItem(k) || 'null');
      localStorage.setItem(k, JSON.stringify(v));
    } catch (e) { /* private window: settings are not kept */ }
    return null;
  }
  function pc(v, d) { return v == null || !isFinite(v) ? '–' : (v * 100).toFixed(d == null ? 0 : d) + '%'; }
  function sgn(v, d) { return v == null || !isFinite(v) ? '–' : (v > 0 ? '+' : '') + v.toFixed(d == null ? 1 : d) + '%'; }
  var VERDICT = { better: ['Better', 's-good'], worse: ['Worse', 's-bad'], chance: ['Could be chance', ''], few: ['Too few', ''] };
  var STATUS = { rally: ['Rallied', 's-good'], no: ['No rally', 's-bad'], pending: ['Still running', 's-info'], upcoming: ['Not traded yet', 's-warn'] };
  var DECIDE = { buy: ['Buy candidate', 's-good'], watch: ['Watch', 's-info'], neutral: ['Neutral', ''], avoid: ['Avoid', 's-bad'], none: ['No score', ''] };
  var KIND = { pop: 'quick jump', trend: 'steady rise', both: 'jump + steady rise' };
  // the gap-up study's words (a 'rally' row = it opened gapPct % or more above the close before)
  var STATUS_GAP = { rally: ['Gapped up', 's-good'], no: ['No gap-up', 's-bad'], pending: ['Still running', 's-info'], upcoming: ['Not opened yet', 's-warn'] };
  var DECIDE_GAP = { buy: ['Likely gap-up', 's-good'], watch: ['Maybe', 's-info'], neutral: ['Neutral', ''], avoid: ['Unlikely', 's-bad'], none: ['No score', ''] };
  /** the words of the study chosen */
  function words(o) {
    var gap = o.goal === 'gapup';
    return gap ? { gap: true, whole: o.view === 'whole', win: 'gapped up', Win: 'Gapped up', noun: 'gap-up', none: 'No gap-up', chance: 'Gap-up chance',
      status: STATUS_GAP, decide: DECIDE_GAP }
      : { gap: false, whole: o.view === 'whole', win: 'rallied', Win: 'Rallied', noun: 'rally', none: 'No rally', chance: 'Rally chance', status: STATUS, decide: DECIDE };
  }
  function dec(Wd, r) { return Wd.decide[r.decision.id] || Wd.decide.none; }

  // ---------- data ----------
  function compute(ctx, H) {
    var perfT = ctx.D.resultsPerf || {}, season = R.seasonOf(perfT);
    var trT = ctx.D.resultsTracker || {};
    var key = [season, (perfT.table && perfT.table.rows || []).length, ctx.site.readAt || ctx.D.generated, H && H.dates ? H.dates.length + H.dates[H.dates.length - 1] : '',
      ctx.market.fetchedAt || '', JSON.stringify(ST.opt)].join('|');
    if (MEMO.key === key && MEMO.A) return MEMO.A;
    var ds = E.dataset({ perf: R.perfRows(perfT, season), tracker: ui.objRows(trT), flagsKnown: (trT.cols || []).indexOf('Flags') >= 0,
      stocks: ctx.stocks, H: H, sigAt: SB.strategy && SB.strategy.ttmSignal }, ST.opt);
    var A = E.analyse(ds, ST.opt);
    A.season = season;
    A.skipped = ds.skipped;
    // the season's lessons kept on this device - the next season scores its first results with them (nothing is frozen in the sheet);
    // one model per study ('<season>' = rally, '<season>|gapup' = the gap-up study)
    var models = store(MODEL_KEY) || {};
    var suffix = ST.opt.goal === 'gapup' ? '|gapup' : '', mine = function (k) { return suffix ? /\|gapup$/.test(k) : k.indexOf('|') < 0; };
    if (A.model && A.finished >= 200 && season) {
      models[season + suffix] = { at: new Date().toISOString(), opt: ST.opt, model: A.model, base: A.base, finished: A.finished, auc: A.check ? A.check.auc : null };
      var ks = Object.keys(models).filter(mine).sort(function (a, b) { return models[b].at < models[a].at ? -1 : 1; });
      ks.slice(4).forEach(function (k) { delete models[k]; });
      store(MODEL_KEY, models);
    } else if (season) {
      var prev = Object.keys(models).filter(function (k) { return k !== season + suffix && mine(k) && models[k].model; })
        .sort(function (a, b) { return models[a].at < models[b].at ? 1 : -1; })[0];
      if (prev) {
        A.borrowed = { season: prev.replace(/\|gapup$/, ''), finished: models[prev].finished, auc: models[prev].auc };
        A.rows.forEach(function (r) {
          var s = E.score(models[prev].model, r);
          r.p = s ? s.p : null;
          r.reasons = s ? s.reasons : [];
          r.decision = E.decision(r.p, models[prev].base);
        });
      }
    }
    MEMO.key = key;
    MEMO.A = A;
    return A;
  }

  // ---------- pieces ----------
  function optSelect(k, label, list, fmt) {
    return '<label class="edge-opt">' + esc(label) + ' <select data-eo="' + k + '">' + list.map(function (v) {
      return '<option value="' + esc(v) + '"' + (String(ST.opt[k]) === String(v) ? ' selected' : '') + '>' + esc(fmt ? fmt(v) : v) + '</option>';
    }).join('') + '</select></label>';
  }
  function ruleWords(o) {
    if (o.goal === 'gapup') {
      return 'Only results that came <b>after the market or on a closed day</b> (the market could not react the same day). A result counts as a ' +
        '<b>gap-up</b> when the next session <b>opened at least ' + o.gapPct + '%</b> above the close before it. PE, PEG, upside, TTM Signal and market ' +
        'cap are worked out at that close - the price you know in the evening, before the open.';
    }
    var pop = 'it went at least ' + o.popPct + '% above the entry within ' + (o.popDays === 1 ? 'the entry session' : 'the first ' + o.popDays + ' sessions') + ' (its high)';
    var tr = 'the close of the ' + o.trendDays + 'th session was at least ' + o.trendPct + '% above the entry';
    return 'The entry = the <b>open of the first session that could react</b>: the result day itself for results before or during market hours, the next ' +
      'trading day for results after the market or on a closed day. A result counts as a <b>rally</b> when ' +
      (o.rally === 'pop' ? pop : o.rally === 'trend' ? tr : pop + ', <b>or</b> ' + tr) + '.';
  }
  function viewWords(o) {
    return o.view === 'whole' ? 'The season is looked at <b>as one part</b> (every result together).'
      : 'Each figure is also checked on the <b>earlier and the later part</b> of the season.';
  }
  function rulesHtml() {
    var C = E.CHOICES, o = ST.opt;
    return '<section class="card" id="edge-rule"><div class="card-head"><div><h2>Your rule</h2><p>' + ruleWords(o) + ' ' + viewWords(o) +
      ' Change it and everything below is worked out again at once.</p></div></div>' +
      '<div class="controls edge-opts">' +
      optSelect('goal', 'Study', C.goal, function (v) { return v === 'gapup' ? 'Gap-up open (after-market results)' : 'Rally after the results'; }) +
      (o.goal === 'gapup'
        ? optSelect('gapPct', 'Gap-up: open at least', C.gapPct, function (v) { return v + '% over the close before'; })
        : optSelect('popPct', 'Quick jump: at least', C.popPct, function (v) { return v + '%'; }) +
          optSelect('popDays', 'within', C.popDays, function (v) { return v === 1 ? 'the entry session' : v + ' sessions'; }) +
          optSelect('trendPct', 'Steady rise: at least', C.trendPct, function (v) { return v + '%'; }) +
          optSelect('trendDays', 'after', C.trendDays, function (v) { return v + ' sessions'; }) +
          optSelect('rally', 'A rally =', C.rally, function (v) { return v === 'either' ? 'either one' : v === 'pop' ? 'quick jump only' : 'steady rise only'; })) +
      optSelect('minN', 'A group needs', C.minN, function (v) { return v + ' results'; }) +
      optSelect('cap', 'Stocks', C.cap, function (v) { return v === 'all' ? 'every size' : v.charAt(0).toUpperCase() + v.slice(1) + ' caps'; }) +
      optSelect('view', 'Show', C.view, function (v) { return v === 'whole' ? 'Whole season as one' : 'Earlier vs later part'; }) +
      '</div></section>';
  }
  function tile(label, value, note, tone, tip) {
    return '<div class="tile"' + (tip ? ' data-tip="' + esc(tip) + '"' : '') + '><div class="label">' + esc(label) + '</div><div class="value' + (tone ? ' ' + tone : '') + '">' + value + '</div>' +
      (note ? '<div class="note2">' + note + '</div>' : '') + '</div>';
  }
  function groupWords(Wd, f, g) {
    return '<b>' + esc(f.label) + ': ' + esc(g.label) + '</b> - ' + pc(g.rate) + ' ' + Wd.win + ' (' + F.int(g.wins) + ' of ' + F.int(g.n) + ')';
  }
  function summaryHtml(A) {
    var Wd = words(A.opt), o = A.opt;
    var h = '<section class="card" id="edge-sum"><div class="card-head"><div><h2>What the data says</h2><p>Season <b>' + esc(A.season || '–') + '</b> · ' +
      F.int(A.rows.length) + ' results with candles' + (Wd.gap ? ' that came after the market or on a closed day' + (A.skipped && A.skipped.notAfter ? ' (' +
        F.int(A.skipped.notAfter) + ' before / during market hours left out)' : '') : '') +
      (A.skipped && A.skipped.nocandles ? ' (' + F.int(A.skipped.nocandles) + ' without candles left out)' : '') +
      '. Worked out again whenever your sheet\'s data changes.</p></div></div>';
    var chk = tile('Score check', A.check && A.check.auc != null ? (A.check.auc * 100).toFixed(0) + ' / 100' : '–', A.check ? 'on the later ' + F.int(A.check.n) +
      ' results (50 = a coin toss)' : 'needs about 100 finished results', '', 'The score is always learned on the earlier part and judged on the later one');
    h += '<div class="tiles">' + (Wd.gap
      ? tile('Results with an outcome', F.int(A.finished), F.int(A.upcoming) + ' not opened yet', '', 'A result counts once the next session has opened') +
        tile('Gapped up', A.base == null ? '–' : pc(A.base), F.int(A.rallied) + ' results opened ' + o.gapPct + '% or more higher', A.base != null ? 'up' : '') +
        tile('Average opening gap', A.avgGap == null ? '–' : sgn(A.avgGap), 'the next open vs the close before, every result') + chk
      : tile('Results with an outcome', F.int(A.finished), F.int(A.pending) + ' still running · ' + F.int(A.upcoming) + ' not traded yet', '',
        'A result counts once its whole window is over') +
        tile('Rallied', A.base == null ? '–' : pc(A.base), F.int(A.rallied) + ' results' + (A.rallied ? ' · ' + F.int(A.kinds.pop + A.kinds.both) + ' quick jumps, ' +
          F.int(A.kinds.trend) + ' steady rises only' : ''), A.base != null ? 'up' : '') +
        tile('Average ' + o.trendDays + '-session move', A.avgRet == null ? '–' : sgn(A.avgRet), 'from the entry, every finished result') + chk) +
      '</div>';
    if (!A.finished) {
      return h + '<p class="empty">' + (Wd.gap ? (A.rows.length ? 'No result that came after the market or on a closed day has opened yet - come back after the next session.'
        : 'No result of this season is known to have come after the market or on a closed day - the study needs the announcement times (Results ' +
          'Performance "Announced" / "Reaction From", from your PC bridge).')
        : 'No result has an outcome yet under this rule - each one counts once ' + o.trendDays + ' sessions have passed since its ' +
        'entry (a quick jump is counted then too, so the early ones do not look better than they are). Come back in a few days, or pick a shorter rule above.') + '</p></section>';
    }
    var real = A.features.filter(function (f) { return f.real; });
    var good = [], bad = [];
    real.forEach(function (f) {
      f.groups.forEach(function (g) {
        if (g.verdict === 'better' && g.held !== 'no') good.push({ f: f, g: g });
        if (g.verdict === 'worse' && g.held !== 'no') bad.push({ f: f, g: g });
      });
    });
    good.sort(function (a, b) { return b.g.rate - a.g.rate; });
    bad.sort(function (a, b) { return a.g.rate - b.g.rate; });
    var li = [];
    li.push(Wd.gap ? 'Out of <b>' + F.int(A.finished) + '</b> results that came after the market or on a closed day, <b>' + F.int(A.rallied) + ' (' + pc(A.base) +
      ')</b> opened at least ' + o.gapPct + '% higher the next session - that is the number to beat.'
      : 'Out of <b>' + F.int(A.finished) + '</b> results with an outcome, <b>' + F.int(A.rallied) + ' (' + pc(A.base) + ')</b> rallied under your rule - ' +
      'that is the number to beat.');
    var more = Wd.gap ? 'gap-ups' : 'rallies';
    if (good.length) li.push('<b>Went with more ' + more + '</b>: ' + good.slice(0, 4).map(function (x) { return groupWords(Wd, x.f, x.g); }).join('; ') + '.');
    else li.push('No single figure clearly went with more ' + more + ' yet - with more finished results this may change.');
    if (bad.length) li.push('<b>Warning signs</b>: ' + bad.slice(0, 3).map(function (x) { return groupWords(Wd, x.f, x.g); }).join('; ') + '.');
    var noise = A.features.filter(function (f) { return !f.real && f.n >= o.minN * 2; }).slice(-4).map(function (f) { return esc(f.label); });
    if (noise.length) li.push('<b>Made little difference</b> this season: ' + noise.join(', ') + '.');
    var c = A.combos.filter(function (x) { return x.held === 'yes'; })[0] || A.combos[0];
    if (c && Wd.whole) {
      li.push('<b>Best combination</b>: ' + c.label.map(esc).join(' + ') + ' - ' + pc(c.devRate) + ' ' + Wd.win + ' (' + F.int(c.devN) + ' results, the season ' +
        pc(c.devBase) + ')' + (c.held === 'yes' ? ' - beyond luck, even after allowing for every combination tried' : ' - could be luck (many combinations were tried)') + '.');
    } else if (c) {
      li.push('<b>Best combination</b>: ' + c.label.map(esc).join(' + ') + ' - ' + pc(c.devRate) + ' ' + Wd.win + ' in the earlier part of the season (' + F.int(c.devN) +
        ' results)' + (c.testN ? ', ' + pc(c.testRate) + ' in the later part (' + F.int(c.testN) + ')' + (c.held === 'yes' ? ' - it held' : c.held === 'no' ? ' - it did NOT hold' : c.held === 'unclear' ? ' - not sure yet' : '') : '') + '.');
    }
    if (A.check) {
      var b0 = A.check.bands[0], b4 = A.check.bands[A.check.bands.length - 1];
      li.push('<b>The score</b> (all the figures together, learned on the earlier part only' + (Wd.whole ? ' - this check always splits the season, else it would ' +
        'only be checking itself' : '') + '): on the later results the top fifth by score ' + Wd.win + ' <b>' + pc(b0.rate) +
        '</b>, the bottom fifth ' + pc(b4.rate) + ' - ' + (A.check.verdict === 'good' ? 'a useful edge.' : A.check.verdict === 'some' ? 'some edge, use it with your own judgement.' :
        'weak this season - treat it as a hint only.'));
    }
    if (A.borrowed) li.push('Too few finished results this season for a score of its own - the scores below use the lessons of <b>' + esc(A.borrowed.season) + '</b> (' + F.int(A.borrowed.finished) + ' results, kept on this device).');
    li.push('<span class="sub">One season of results: these are patterns, not certainties - a figure that went with ' + more + ' did not cause them. PE, PEG, upside, TTM Signal and ' +
      'market cap are worked out at ' + (Wd.gap ? 'the close before the open' : 'the entry price') + '; EPS growth and OPM Qtr YoY are Main\'s values now (not frozen at the result).</span>');
    return h + '<ul class="edge-says">' + li.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul></section>';
  }
  function reasonsHtml(r, max) {
    return (r.reasons || []).slice(0, max || 4).map(function (x) {
      return '<span class="badge ' + (x.pts > 0 ? 's-good' : 's-bad') + '" data-tip="' + esc(x.label) + '">' + (x.pts > 0 ? '+' : '') + x.pts + ' ' + esc(x.label) + '</span>';
    }).join(' ');
  }
  function nowHtml(A) {
    var Wd = words(A.opt);
    return '<section class="card" id="edge-now"><div class="card-head"><div><h2>Decide now - the newest results</h2><p>' + (Wd.gap
      ? 'Results that came after the market or on a closed day and have not opened yet (decide in the evening), and those that opened in the last 3 sessions, ' +
        'highest gap-up chance first. <b>Gap-up chance</b> = how likely the next open is ' + A.opt.gapPct + '% or more above the close, learned from this season\'s ' +
        'after-market results'
      : 'Results not traded yet (their entry is the next session) and those whose entry was in the last 3 sessions, highest rally chance first. <b>Rally chance</b> = ' +
        'the score learned from this season\'s finished results') + '; the badges = what pushed it up (+) or down (-). Research only, not a buy recommendation.</p></div></div>' +
      '<div class="controls"><input class="search" id="edge-q" type="search" placeholder="Check any stock: symbol or company" aria-label="Check a stock" value="' + esc(ST.q) + '">' +
      '<span class="count" id="edge-now-count"></span></div><div id="edge-now-t"></div><div id="edge-one"></div></section>';
  }
  function featHtml(A) {
    var Wd = words(A.opt);
    var max = Math.max.apply(null, A.features.map(function (f) { return f.strength; }).concat([0.0001]));
    return '<section class="card" id="edge-feat"><div class="card-head"><div><h2>What mattered most</h2><p>Every figure, one at a time: how often the results ' +
      'in each of its groups ' + Wd.win + '. <b>Real</b> = the groups differ far more than luck would explain (even after checking ~' + A.features.length +
      ' figures)' + (Wd.whole ? ' over the whole season' : ' and the difference held in the later part of the season') +
      '; the bar = how strongly. Pick one to see its groups.</p></div></div>' +
      '<div class="edge-feats">' + A.features.map(function (f) {
        var w = Math.max(2, Math.round(f.strength / max * 100));
        return '<button type="button" class="edge-feat' + (ST.feat === f.id ? ' on' : '') + '" data-feat="' + esc(f.id) + '"><span class="edge-feat-l">' + esc(f.label) +
          ' <span class="badge' + (f.real ? ' s-good' : '') + '">' + (f.real ? 'Real' : f.n < ST.opt.minN * 2 ? 'Too few' : 'Could be chance') + '</span></span>' +
          '<span class="bar-track"><span class="bar pos" style="width:' + w + '%"></span></span>' +
          '<span class="edge-feat-n">' + (f.best ? 'best: ' + esc(f.best.label) + ' ' + pc(f.best.rate) : f.n ? F.int(f.n) + ' results' : 'no data') + '</span></button>';
      }).join('') + '</div><div id="edge-groups"></div></section>';
  }
  function comboHtml(A) {
    var Wd = words(A.opt);
    return '<section class="card" id="edge-combo"><div class="card-head"><div><h2>Best combinations</h2><p>' + (Wd.whole
      ? 'Two or three conditions together, found on <b>every result</b> of the season. With nothing left to check them on, trust only the ones marked ' +
        '<b>beyond luck</b> - many combinations are tried, so some look good by chance.'
      : 'Two or three conditions together, found on the <b>earlier part</b> of the season (results with an entry before ' + esc(A.split.at || '–') +
        ') and checked on the <b>later part</b> - trust the ones that held.') + '</p></div></div>' +
      (A.combos.length ? '<div id="edge-combo-t"></div>' : '<p class="empty">Not enough finished results yet for combinations (a combination needs ' + A.opt.minN +
        ' results' + (Wd.whole ? '' : ' in the earlier part') + ').</p>') + '</section>';
  }
  function checkHtml(A) {
    var c = A.check, Wd = words(A.opt);
    var h = '<section class="card" id="edge-check"><div class="card-head"><div><h2>Does the score work?</h2><p>The score learned on the earlier part of the ' +
      'season only, then the later results sorted by it into five equal groups: how many of each actually ' + Wd.win + '.' + (Wd.whole ? ' (This check always ' +
      'splits the season - a score judged on the results it learned from would only be checking itself.)' : '') + '</p></div></div>';
    if (!c) return h + '<p class="empty">Needs about 100 finished results.</p></section>';
    h += ui.bars(c.bands.map(function (b) {
      return { label: (b.band === 1 ? 'Top fifth' : b.band === c.bands.length ? 'Bottom fifth' : 'Fifth ' + b.band) + ' (chance ~' + pc(b.avgP) + ')', value: b.rate * 100 };
    }), { fmt: function (v) { return v.toFixed(0) + '% ' + Wd.win; } });
    h += '<p class="sub">All later results: ' + pc(c.testBase) + ' ' + Wd.win + '. Score check ' + (c.auc * 100).toFixed(0) + ' / 100 (50 = no better than a coin toss, 60+ = useful).</p>';
    return h + '</section>';
  }
  function allHtml(A) {
    var Wd = words(A.opt), S = Wd.status;
    var n = { all: A.rows.length };
    A.rows.forEach(function (r) { n[r.status] = (n[r.status] || 0) + 1; });
    var ch = [['all', 'All (' + F.int(n.all) + ')'], ['rally', S.rally[0] + ' (' + F.int(n.rally || 0) + ')'], ['no', S.no[0] + ' (' + F.int(n.no || 0) + ')']];
    if (!Wd.gap) ch.push(['pending', S.pending[0] + ' (' + F.int(n.pending || 0) + ')']);
    ch.push(['upcoming', S.upcoming[0] + ' (' + F.int(n.upcoming || 0) + ')']);
    if (Wd.gap && ST.list === 'pending') ST.list = 'all';
    return '<section class="card" id="edge-all"><div class="card-head"><div><h2>Every result</h2><p>Each result with its entry, what happened and its figures.</p></div>' +
      '<div class="actions"><button class="btn" type="button" id="edge-csv">Export CSV</button></div></div>' +
      '<div class="controls">' + ui.chips('edgelist', ch, ST.list) + '</div><div id="edge-all-t"></div></section>';
  }

  // ---------- tables ----------
  var FCOLS = [['npY', 'NP YoY', 'pct'], ['revY', 'Rev YoY', 'pct'], ['npQ', 'NP QoQ', 'pct'], ['revQ', 'Rev QoQ', 'pct'], ['opmqy', 'OPM Qtr YoY'], ['opmq', 'OPM QoQ'],
    ['epsg', 'EPS growth', 'pct'], ['pe', 'PE', 'num'], ['pevs', 'PE vs ind', 'num'], ['upside', 'Upside', 'pct'], ['sig', 'TTM Signal'],
    ['session', 'When'], ['gap', 'Opening gap', 'pct'], ['cap', 'Size']];
  function rowCols(A) {
    var Wd = words(A.opt), S = Wd.status;
    var cols = [
      { key: 'sym', label: 'Stock', type: 'sym', name: 'name' },
      { key: 'rdate', label: 'Result date', type: 'date' },
      { key: 'entryDay', label: Wd.gap ? 'Opened' : 'Entry', get: function (r) { return r.entryDay || 'next session'; },
        html: function (r) { return r.entryDay ? esc(F.date(r.entryDay)) + ' <span class="sub">' + F.price(r.entry) + '</span>' : '<span class="sub">next session</span>'; } },
      { key: 'status', label: 'Outcome', get: function (r) { return S[r.status][0]; },
        html: function (r) { return ui.badge(S[r.status][0] + (r.kind ? ' · ' + KIND[r.kind] : r.early ? ' · jumped already' : ''), S[r.status][1]); } }
    ];
    if (Wd.gap) {
      cols.push({ key: 'prevClose', label: 'Close before', type: 'num', digits: 2, title: 'The close of the session before the open (the evening price)' },
        { key: 'openGap', label: 'Opening gap', type: 'pct', digits: 1, title: 'The next open vs the close before it' });
    }
    var after = Wd.gap ? ' (from the open)' : '';
    cols.push(
      { key: 'popMax', label: 'Best jump' + after, type: 'pct', digits: 1, title: 'The highest price in the first ' + A.opt.popDays + ' session(s) vs the ' + (Wd.gap ? 'open' : 'entry') },
      { key: 'ret', label: A.opt.trendDays + '-session move' + after, type: 'pct', digits: 1, title: 'The close of the ' + A.opt.trendDays + 'th session vs the ' + (Wd.gap ? 'open' : 'entry') },
      { key: 'maxGain', label: 'Max gain', type: 'pct', digits: 1, title: 'The highest high within ' + A.opt.trendDays + ' sessions vs the ' + (Wd.gap ? 'open' : 'entry') },
      { key: 'maxDD', label: 'Max drawdown', type: 'pct', digits: 1 },
      { key: 'p', label: Wd.chance, type: 'num', get: function (r) { return r.p == null ? null : r.p * 100; }, html: function (r) { return r.p == null ? '–' : pc(r.p); } },
      { key: 'decision', label: 'Decision', get: function (r) { return dec(Wd, r)[0]; },
        html: function (r) { var d = dec(Wd, r); return ui.badge(d[0], d[1]); } });
    FCOLS.forEach(function (c) {
      if (Wd.gap && (c[0] === 'gap' || c[0] === 'session')) return;
      cols.push({ key: 'f_' + c[0], label: c[1], type: c[2] === 'pct' ? 'pct' : c[2] === 'num' ? 'num' : undefined, digits: c[2] === 'num' ? 1 : 1,
        get: function (r) { var v = r.f[c[0]]; return c[0] === 'pe' && v < 0 ? null : v == null ? null : v; },
        html: c[0] === 'pe' ? function (r) { var v = r.f.pe; return v == null ? '–' : v < 0 ? 'loss' : F.num(v, 1); } : undefined });
    });
    return cols;
  }
  function drawAll(el, A) {
    var host = $('#edge-all-t', el);
    if (!host) return;
    var t = new ui.Table({ rows: [], pageSize: 25, id: 'edge-all' + (A.opt.goal === 'gapup' ? '-gap' : ''), sort: { key: 'rdate', dir: -1 }, empty: 'No result in this list', columns: rowCols(A) }).mount(host);
    function apply() { t.setRows(A.rows.filter(function (r) { return ST.list === 'all' || r.status === ST.list; })); }
    ui.bindChips(el, 'edgelist', function (v) { ST.list = v; apply(); });
    $('#edge-csv', el).addEventListener('click', function () { ui.download('results-edge.csv', ui.toCsv(t.toCsvRows())); });
    apply();
  }
  function drawNow(el, A, ctx) {
    var host = $('#edge-now-t', el);
    if (!host) return;
    // the newest 3 entry sessions + the results not traded yet
    var days = [];
    A.rows.forEach(function (r) { if (r.entryDay && days.indexOf(r.entryDay) < 0) days.push(r.entryDay); });
    days.sort();
    var cutoff = days.length >= 3 ? days[days.length - 3] : days[0] || '';
    var list = A.rows.filter(function (r) { return r.status === 'upcoming' || (r.entryDay && r.entryDay >= cutoff); });
    list.sort(function (a, b) { return (b.p == null ? -1 : b.p) - (a.p == null ? -1 : a.p); });
    var Wd = words(A.opt), S = Wd.status;
    var cols = [
      { key: 'sym', label: 'Stock', type: 'sym', name: 'name' },
      { key: 'p', label: Wd.chance, type: 'num', get: function (r) { return r.p == null ? null : r.p * 100; }, html: function (r) { return r.p == null ? '–' : '<b>' + pc(r.p) + '</b>'; } },
      { key: 'decision', label: 'Decision', get: function (r) { return dec(Wd, r)[0]; },
        html: function (r) { var d = dec(Wd, r); return ui.badge(d[0], d[1]); } },
      { key: 'why', label: 'Why', wrap: true, get: function (r) { return (r.reasons || []).map(function (x) { return x.label; }).join('; '); },
        html: function (r) { return '<span class="edge-why">' + reasonsHtml(r, 4) + '</span>'; } },
      { key: 'rdate', label: 'Result date', type: 'date' },
      { key: 'ann', label: 'Announced' },
      { key: 'entryDay', label: Wd.gap ? 'Opened' : 'Entry', get: function (r) { return r.entryDay || 'next session'; },
        html: function (r) { return r.entryDay ? esc(F.date(r.entryDay)) + ' <span class="sub">' + F.price(r.entry) + (Wd.gap && r.openGap != null ? ' · ' + sgn(r.openGap) : '') +
          '</span>' : '<span class="sub">next session</span>'; } },
      { key: 'since', label: Wd.gap ? 'Now vs the open' : 'Now vs entry', type: 'pct', digits: 1, get: function (r) {
        var s = ctx.bySym[r.sym];
        return r.entry && s && s.price > 0 ? (s.price / r.entry - 1) * 100 : null;
      } },
      { key: 'status', label: 'So far', get: function (r) { return r.early ? 'Jumped already' : S[r.status][0]; },
        html: function (r) { return r.early ? ui.badge('Jumped already', 's-good') : ui.badge(S[r.status][0], S[r.status][1]); } }
    ];
    var t = new ui.Table({ rows: list, pageSize: 20, id: 'edge-now' + (Wd.gap ? '-gap' : ''), empty: 'No new result right now - they appear here when the next results arrive.', columns: cols }).mount(host);
    var c = $('#edge-now-count', el);
    if (c) c.textContent = F.int(list.length) + ' results';
    var q = $('#edge-q', el), timer;
    function one() {
      var box = $('#edge-one', el), w = ST.q.trim().toUpperCase();
      if (!box) return;
      if (!w) { box.innerHTML = ''; return; }
      var r = A.rows.filter(function (x) { return x.sym === w; })[0] || A.rows.filter(function (x) { return ui.textMatch(ST.q, [x.sym, x.name]); })[0];
      if (!r) { box.innerHTML = '<p class="empty">No result of this season for "' + esc(ST.q) + '"' + (Wd.gap ? ' that came after the market or on a closed day' : '') + '.</p>'; return; }
      var d = dec(Wd, r);
      box.innerHTML = '<div class="edge-one"><h3>' + esc(r.sym) + ' <span class="sub">' + esc(r.name) + '</span></h3>' +
        '<p>Result ' + esc(F.date(r.rdate)) + (r.ann ? ' · ' + esc(r.ann) : '') + ' · ' + (Wd.gap ? 'opened ' : 'entry ') +
        (r.entryDay ? esc(F.date(r.entryDay)) + ' at ' + F.price(r.entry) + (Wd.gap && r.openGap != null ? ' (' + sgn(r.openGap) + ' vs the close ' + F.price(r.prevClose) + ')' : '') : 'the next session') +
        ' · ' + ui.badge(S[r.status][0] + (r.kind ? ' · ' + KIND[r.kind] : ''), S[r.status][1]) +
        (r.popMax != null ? ' · best jump ' + sgn(r.popMax) : '') + (r.ret != null ? ' · ' + A.opt.trendDays + '-session move ' + sgn(r.ret) : '') + '</p>' +
        '<p>' + Wd.chance + ' <b>' + (r.p == null ? '–' : pc(r.p)) + '</b> (the season: ' + pc(A.base) + ') ' + ui.badge(d[0], d[1]) + '</p>' +
        '<div class="edge-why">' + (reasonsHtml(r, 12) || '<span class="sub">no figure moved the score</span>') + '</div></div>';
    }
    if (q) q.addEventListener('input', function (e) { clearTimeout(timer); timer = setTimeout(function () { ST.q = e.target.value; t.setRows(list.filter(function (r) { return ui.textMatch(ST.q, [r.sym, r.name]); })); one(); }, 150); });
    if (ST.q) { t.setRows(list.filter(function (r) { return ui.textMatch(ST.q, [r.sym, r.name]); })); one(); }
  }
  function drawGroups(el, A) {
    var host = $('#edge-groups', el);
    if (!host) return;
    var f = A.features.filter(function (x) { return x.id === ST.feat; })[0];
    if (!f) { host.innerHTML = '<p class="sub">Pick a figure above to see its groups.</p>'; return; }
    var Wd = words(A.opt);
    host.innerHTML = '<h3 class="edge-gh">' + esc(f.label) + ' <span class="sub">' + F.int(f.n) + ' results with this figure · ' + pc(f.base) + ' ' + Wd.win + '</span></h3>' +
      ui.bars(f.groups.map(function (g) { return { label: g.label + ' (' + F.int(g.n) + ')', value: (g.rate || 0) * 100 }; }), { fmt: function (v) { return v.toFixed(0) + '%'; } }) +
      '<div id="edge-groups-t"></div><p class="sub"><b>Better / Worse</b> = this group vs the other results, clear at 90%' + (Wd.whole ? ' (the whole season).' :
      '; <b>Held</b> = above (or below) the season in the earlier AND the later part.') + '</p>';
    var part = function (x) { return x && x.n ? pc(x.rate) + ' <span class="sub">(' + F.int(x.n) + ')</span>' : '<span class="sub">–</span>'; };
    var cols = [
      { key: 'label', label: 'Group' }, { key: 'n', label: 'Results', type: 'num', digits: 0 },
      { key: 'rate', label: Wd.Win, type: 'num', get: function (g) { return g.rate == null ? null : g.rate * 100; }, html: function (g) { return pc(g.rate); } },
      { key: 'lo', label: 'Likely range', get: function (g) { return g.lo; }, html: function (g) { return g.lo == null ? '–' : pc(g.lo) + ' – ' + pc(g.hi); } },
      Wd.gap ? { key: 'avgGap', label: 'Avg opening gap', type: 'pct', digits: 1 } : { key: 'avgPop', label: 'Avg best jump', type: 'pct', digits: 1 },
      { key: 'avgRet', label: 'Avg ' + A.opt.trendDays + '-session move', type: 'pct', digits: 1 },
      { key: 'verdict', label: 'vs the rest', get: function (g) { return VERDICT[g.verdict][0]; }, html: function (g) { return ui.badge(VERDICT[g.verdict][0], VERDICT[g.verdict][1]); } }
    ];
    if (!Wd.whole) {
      cols.push({ key: 'dev', label: 'Earlier part', get: function (g) { return g.dev.rate; }, html: function (g) { return part(g.dev); } },
        { key: 'test', label: 'Later part', get: function (g) { return g.test.rate; }, html: function (g) { return part(g.test); } },
        { key: 'held', label: 'Held', get: function (g) { return g.held; }, html: function (g) { return g.held === 'yes' ? ui.badge('Yes', 's-good') : g.held === 'no' ? ui.badge('No', 's-bad') : '–'; } });
    }
    new ui.Table({ rows: f.groups, pageSize: 20, id: 'edge-groups' + (Wd.whole ? '-whole' : '') + (Wd.gap ? '-gap' : ''), tools: false, columns: cols }).mount($('#edge-groups-t', host));
  }
  function drawCombos(el, A) {
    var host = $('#edge-combo-t', el);
    if (!host) return;
    var Wd = words(A.opt), w = Wd.win;
    var moveCol = function (k, label) {
      return Wd.gap ? { key: k + 'AvgGap', label: label + 'avg opening gap', type: 'pct', digits: 1 } : { key: k + 'AvgRet', label: label + 'avg ' + A.opt.trendDays + '-session move', type: 'pct', digits: 1 };
    };
    var cond = { key: 'label', label: 'Conditions', get: function (c) { return c.label.join(' + '); }, html: function (c) { return c.label.map(esc).join('<br>'); } };
    var cols = Wd.whole ? [cond,
      { key: 'devN', label: 'Results', type: 'num', digits: 0 },
      { key: 'devRate', label: Wd.Win, type: 'num', get: function (c) { return c.devRate * 100; }, html: function (c) { return '<b>' + pc(c.devRate) + '</b> <span class="sub">(all: ' + pc(c.devBase) + ')</span>'; } },
      { key: 'devLo', label: 'Likely range', get: function (c) { return c.devLo; }, html: function (c) { return pc(c.devLo) + ' – ' + pc(c.devHi); } },
      moveCol('dev', ''),
      { key: 'held', label: 'Beyond luck', get: function (c) { return c.held; }, title: 'Yes = that many ' + w + ' would happen by luck less than 10% of the time, even after allowing for every combination tried',
        html: function (c) { return c.held === 'yes' ? ui.badge('Yes', 's-good') : ui.badge('Could be luck', ''); } }
    ] : [cond,
      { key: 'devN', label: 'Earlier: results', type: 'num', digits: 0 },
      { key: 'devRate', label: 'Earlier: ' + w, type: 'num', get: function (c) { return c.devRate * 100; }, html: function (c) { return '<b>' + pc(c.devRate) + '</b>'; } },
      { key: 'testN', label: 'Later: results', type: 'num', digits: 0 },
      { key: 'testRate', label: 'Later: ' + w, type: 'num', get: function (c) { return c.testRate == null ? null : c.testRate * 100; },
        html: function (c) { return c.testRate == null ? '–' : pc(c.testRate) + ' <span class="sub">(all: ' + pc(c.testBase) + ')</span>'; } },
      moveCol('test', 'Later: '),
      { key: 'held', label: 'Held', get: function (c) { return c.held; }, title: 'Yes = clearly above the later part\'s own rate (90%); Not sure = above it, but it could be luck',
        html: function (c) { return c.held === 'yes' ? ui.badge('Yes', 's-good') : c.held === 'no' ? ui.badge('No', 's-bad') : c.held === 'unclear' ? ui.badge('Not sure', '') : '<span class="sub">too few later</span>'; } }
    ];
    new ui.Table({ rows: A.combos, pageSize: 12, id: 'edge-combos' + (Wd.whole ? '-whole' : '') + (Wd.gap ? '-gap' : ''), tools: false, columns: cols }).mount(host);
  }

  SB.page('edge', {
    render: function (el, params, ctx) {
      var head = '<div class="page-head"><div><h1>Results Edge</h1><p>What this results season says: which figures went with a rally after the results, ' +
        'the best combinations, and a <b>rally chance</b> for every new result - so the day a result arrives you can decide whether to buy the next session. ' +
        'Or study the <b>gap-up open</b> of results that came after the market. Learned on your sheet\'s own data (Results Performance, Main, the daily ' +
        'candles) and worked out again whenever it changes.</p></div></div>';
      var perfT = ctx.D.resultsPerf;
      if (!perfT || !perfT.table || !perfT.table.rows || !perfT.table.rows.length) {
        el.innerHTML = head + '<section class="card"><p class="empty">No Results Performance rows yet - they come with the results season.</p></section>';
        return;
      }
      el.innerHTML = head + rulesHtml() + '<div id="edge-body"><section class="card" aria-busy="true"><h2>Learning from the season…</h2>' + ui.skeleton(3) + '</section></div>';
      bindRule(el);
      SB.loadHistory().then(function (H) {
        if (!el.isConnected) return;
        var A = compute(ctx, H);
        var body = $('#edge-body', el);
        body.innerHTML = summaryHtml(A) + nowHtml(A) + featHtml(A) + comboHtml(A) + checkHtml(A) + allHtml(A);
        if (!ST.feat || !A.features.some(function (f) { return f.id === ST.feat; })) ST.feat = (A.features[0] || {}).id || null;
        drawNow(body, A, ctx);
        drawGroups(body, A);
        drawCombos(body, A);
        drawAll(body, A);
        body.querySelectorAll('[data-feat]').forEach(function (b) {
          b.addEventListener('click', function () {
            ST.feat = b.getAttribute('data-feat');
            body.querySelectorAll('[data-feat]').forEach(function (x) { x.classList.toggle('on', x === b); });
            drawGroups(body, A);
          });
        });
      }, function (e) {
        var body = $('#edge-body', el);
        if (body) body.innerHTML = '<div class="note bad">The daily candles could not be loaded: ' + esc(e && e.message || e) + '</div>';
      });
    }
  });
  function bindRule(el) {
    el.querySelectorAll('[data-eo]').forEach(function (s) {
      s.addEventListener('change', function () {
        var k = s.getAttribute('data-eo'), v = s.value;
        ST.opt[k] = typeof E.DEFAULTS[k] === 'number' ? Number(v) : v;
        ST.opt = E.clean(ST.opt);
        store(OPT_KEY, ST.opt);
        SB.route(true);
      });
    });
  }
})();
