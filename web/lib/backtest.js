/* Backtester - runs the SAME versioned strategy rules as the live screen,
   bar by bar, with no look-ahead:
   - the signal is evaluated on bar i using candles 0..i only;
   - entry is at the NEXT bar's open (i+1) plus slippage;
   - exits are checked from bar i+1 onward;
   - fundamental conditions (today's TTM/PE/upside values) are skipped, since
     their historical values are not available (using them would leak).
   Exit models:
   - 'close' (sheet rule, resolveTradesEOD_): Loss when a daily CLOSE <= stop,
     Win when a CLOSE >= target; checked once per day; exit at that close.
   - 'intrabar': stop when LOW <= stop (or the open, if it gapped below), target
     when HIGH >= target; if both happen on one bar the stop is assumed first.
   Portfolio: fixed-fractional risk sizing (risk.js formula) with a cap of
   maxPositions concurrent trades; daily mark-to-market equity. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./strategy.js'));
  else (root.SB = root.SB || /** @type {any} */ ({})).backtest = factory(root.SB.strategy);
})(/** @type {any} */ (typeof self !== 'undefined' ? self : this), function (S) {
  'use strict';

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  var DEFAULTS = {
    capital: 100000, riskPct: 1, maxPositions: 10, exitModel: 'close', maxHoldBars: 0,
    costPctPerSide: 0.1, slippagePct: 0.05, from: null, to: null, warmup: 0
  };

  /** universe: [{sym, cat, ...stock fields}], history: {SYM: candles}, cfg: strategy config */
  function run(cfgIn, universe, history, optsIn) {
    var o = {};
    Object.keys(DEFAULTS).forEach(function (k) { o[k] = optsIn && optsIn[k] != null && optsIn[k] !== '' ? optsIn[k] : DEFAULTS[k]; });
    var v = S.validate(cfgIn);
    var cfg = v.config;
    cfg.__valid = true;
    var notes = [];
    if (v.errors.length) return { ok: false, errors: v.errors };

    // calendar of all dates in range
    var dateSet = {};
    universe.forEach(function (s) { (history[s.sym] || []).forEach(function (c) { dateSet[c.t] = 1; }); });
    var dates = Object.keys(dateSet).sort().filter(function (d) { return (!o.from || d >= o.from) && (!o.to || d <= o.to); });
    if (dates.length < 3) return { ok: false, errors: ['not enough history in the selected range (' + dates.length + ' sessions)'] };

    // per-symbol index lookup
    var idx = {};
    universe.forEach(function (s) {
      var m = {};
      (history[s.sym] || []).forEach(function (c, i) { m[c.t] = i; });
      idx[s.sym] = m;
    });

    var cash = o.capital, open = [], trades = [], equity = [], signals = 0, skippedFull = 0;
    var pending = [];   // signals from day d, filled at the next session's open
    var excluded = {};
    (cfg.filters.concat(cfg.triggers, cfg.confirms)).forEach(function (r) { if (S.CONDITIONS[r.id].pit === false && r.enabled !== false) excluded[S.label(r)] = 1; });
    if (Object.keys(excluded).length) notes.push('Skipped in the backtest (no historical values): ' + Object.keys(excluded).join('; ') + '.');

    function closeTrade(t, price, date, reason) {
      var exitPx = price * (1 - o.slippagePct / 100);
      var gross = (exitPx - t.entry) * t.qty;
      var costs = (t.entry * t.qty + exitPx * t.qty) * o.costPctPerSide / 100;
      cash += exitPx * t.qty - exitPx * t.qty * o.costPctPerSide / 100;
      t.exit = exitPx; t.exitDate = date; t.reason = reason;
      t.pnl = gross - costs; t.costs = costs;
      t.retPct = (exitPx / t.entry - 1) * 100 - o.costPctPerSide * 2;
      t.r = t.risk > 0 ? t.pnl / (t.risk * t.qty) : NaN;
      t.outcome = t.pnl > 0 ? 'Win' : 'Loss';
      trades.push(t);
    }

    dates.forEach(function (d, di) {
      // 1) fill yesterday's signals at today's open
      pending.forEach(function (sg) {
        var i = idx[sg.sym][d];
        if (i == null) return;                         // no bar today for that symbol
        var c = history[sg.sym][i];
        if (open.length >= o.maxPositions) { skippedFull++; return; }
        if (open.some(function (t) { return t.sym === sg.sym; })) return;
        var entry = c.o * (1 + o.slippagePct / 100);
        var stop = sg.stop, risk = entry - stop;
        if (!(risk > 0) || !(entry > 0)) return;       // gapped below the stop: no trade
        var eqNow = equityAt(di - 1);
        var qty = Math.floor(eqNow * o.riskPct / 100 / risk);
        qty = Math.min(qty, Math.floor(cash / (entry * (1 + o.costPctPerSide / 100))));
        if (qty < 1) return;
        cash -= entry * qty * (1 + o.costPctPerSide / 100);
        var target = sg.targetMode === 'pct' ? entry * (1 + sg.targetPct / 100) : entry + sg.targetR * risk;
        open.push({ sym: sg.sym, signalDate: sg.date, entryDate: d, entry: entry, stop: stop, target: target, qty: qty, risk: risk, bars: 0, setup: sg.setup });
      });
      pending = [];

      // 2) manage open positions on today's bar
      open = open.filter(function (t) {
        var i = idx[t.sym][d];
        if (i == null) return true;
        var c = history[t.sym][i];
        t.bars++;                                       // the entry bar counts: exits are checked on its close
        if (o.exitModel === 'intrabar') {
          if (c.l <= t.stop) { closeTrade(t, Math.min(c.o, t.stop), d, 'stop'); return false; }
          if (c.h >= t.target) { closeTrade(t, Math.max(c.o, t.target), d, 'target'); return false; }
        } else {
          if (c.c <= t.stop) { closeTrade(t, c.c, d, 'stop (close)'); return false; }
          if (c.c >= t.target) { closeTrade(t, c.c, d, 'target (close)'); return false; }
        }
        if (o.maxHoldBars > 0 && t.bars >= o.maxHoldBars) { closeTrade(t, c.c, d, 'time'); return false; }
        return true;
      });

      // 3) evaluate signals at today's close (filled tomorrow)
      if (di < dates.length - 1) {
        universe.forEach(function (s) {
          var i = idx[s.sym][d];
          if (i == null) return;
          var x = S.buildContext(s, history[s.sym], i, { pointInTime: true });
          var r = S.evaluate(cfg, x);
          if (r.status !== 'qualified' || !(r.stop > 0)) return;
          signals++;
          pending.push({ sym: s.sym, date: d, stop: r.stop, setup: r.triggersPassed.join(' + '),
            targetMode: cfg.exits.target.method, targetPct: cfg.exits.target.pct, targetR: cfg.exits.target.rr });
        });
      }

      // 4) mark to market
      var mtm = open.reduce(function (a, t) {
        var i = idx[t.sym][d];
        var px = i != null ? history[t.sym][i].c : t.lastPx || t.entry;
        t.lastPx = px;
        return a + px * t.qty;
      }, 0);
      equity.push({ x: d, y: cash + mtm });
    });

    function equityAt(di) { return di >= 0 && equity[di] ? equity[di].y : o.capital; }

    // open trades at the end are marked, not counted as wins/losses
    var stillOpen = open.map(function (t) {
      return { sym: t.sym, entryDate: t.entryDate, entry: t.entry, stop: t.stop, target: t.target, qty: t.qty, lastPx: t.lastPx, unrealPct: t.lastPx ? (t.lastPx / t.entry - 1) * 100 : NaN, setup: t.setup };
    });

    // benchmark: equal-weight buy & hold of the universe over the same dates
    var first = dates[0], last = dates[dates.length - 1], rets = [];
    universe.forEach(function (s) {
      var a = idx[s.sym][first], b = idx[s.sym][last];
      if (a == null || b == null) return;
      var h = history[s.sym];
      if (h[a].o > 0) rets.push(h[b].c / h[a].o - 1);
    });
    var bench = rets.length ? rets.reduce(function (x, y) { return x + y; }, 0) / rets.length * 100 : NaN;

    return { ok: true, errors: [], notes: notes, trades: trades, open: stillOpen, equity: equity, signals: signals, skippedFull: skippedFull,
      stats: stats(trades, equity, o), benchmark: { name: 'Equal-weight buy & hold of the selected universe', returnPct: bench, n: rets.length },
      range: { from: first, to: last, sessions: dates.length }, options: o, strategy: { id: cfg.id, name: cfg.name, version: cfg.version } };
  }

  function stats(trades, equity, o) {
    var wins = trades.filter(function (t) { return t.pnl > 0; }), losses = trades.filter(function (t) { return t.pnl <= 0; });
    var gw = wins.reduce(function (a, t) { return a + t.pnl; }, 0), gl = losses.reduce(function (a, t) { return a - t.pnl; }, 0);
    var peak = -Infinity, mdd = 0;
    equity.forEach(function (p) { if (p.y > peak) peak = p.y; var dd = (peak - p.y) / peak * 100; if (dd > mdd) mdd = dd; });
    var end = equity.length ? equity[equity.length - 1].y : o.capital;
    var avg = function (a, f) { return a.length ? a.reduce(function (s, t) { return s + f(t); }, 0) / a.length : NaN; };
    var rs = trades.map(function (t) { return t.r; }).filter(isNum);
    return {
      trades: trades.length, wins: wins.length, losses: losses.length,
      winRate: trades.length ? wins.length / trades.length * 100 : NaN,
      netReturnPct: (end / o.capital - 1) * 100, netPnl: end - o.capital,
      profitFactor: gl > 0 ? gw / gl : (gw > 0 ? Infinity : NaN),
      maxDrawdownPct: mdd,
      avgWinPct: avg(wins, function (t) { return t.retPct; }), avgLossPct: avg(losses, function (t) { return t.retPct; }),
      avgR: rs.length ? rs.reduce(function (a, b) { return a + b; }, 0) / rs.length : NaN,
      expectancyPct: avg(trades, function (t) { return t.retPct; }),
      avgBars: avg(trades, function (t) { return t.bars; }),
      sampleWarning: trades.length < 30 ? 'Only ' + trades.length + ' closed trades - far too few to judge this strategy. Treat the numbers as anecdotal.' : null
    };
  }

  return { DEFAULTS: DEFAULTS, run: run, stats: stats };
});
