/* Extra content for the stock drawer: the active strategy's verdict for the
   stock and a daily candle chart with EMA 10/21 and the FVG zones the sheet
   rules find. Drawn only from real candles; nothing is annotated without data. */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, esc = ui.esc, F = ui.F, isNum = ui.isNum;

  function candleChart(host, c, zones, emas) {
    if (!c || c.length < 2) { host.innerHTML = '<p class="sub">No daily candles for this stock in the snapshot.</p>'; return; }
    var W = 440, H = 220, P = { l: 46, r: 8, t: 8, b: 22 };
    var lo = Infinity, hi = -Infinity;
    c.forEach(function (k) { lo = Math.min(lo, k.l); hi = Math.max(hi, k.h); });
    zones.forEach(function (z) { lo = Math.min(lo, z.bottom); hi = Math.max(hi, z.top); });
    var pad = (hi - lo) * 0.05 || 1; lo -= pad; hi += pad;
    var n = c.length, bw = (W - P.l - P.r) / n;
    function X(i) { return P.l + bw * i + bw / 2; }
    function Y(v) { return P.t + (hi - v) * (H - P.t - P.b) / (hi - lo); }
    var s = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Daily candles with EMA and FVG zones">';
    for (var g = 0; g <= 3; g++) {
      var v = lo + (hi - lo) * g / 3, y = Y(v);
      s += '<line class="grid-line" x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '"/><text x="' + (P.l - 5) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end">' + esc(F.num(v, v < 100 ? 2 : 0)) + '</text>';
    }
    zones.forEach(function (z) {
      var x0 = X(z.formedIdx) - bw / 2;
      s += '<rect x="' + x0.toFixed(1) + '" width="' + (W - P.r - x0).toFixed(1) + '" y="' + Y(z.top).toFixed(1) + '" height="' + Math.max(1, Y(z.bottom) - Y(z.top)).toFixed(1) +
        '" fill="var(--accent)" fill-opacity="0.14" stroke="var(--accent)" stroke-opacity="0.5" stroke-width="1"><title>' + esc(z.kind + ' zone ' + F.num(z.bottom) + '–' + F.num(z.top) + ' (formed ' + z.formed + ')') + '</title></rect>';
    });
    c.forEach(function (k, i) {
      var up = k.c >= k.o, col = up ? 'var(--up)' : 'var(--down)';
      var top = Y(Math.max(k.o, k.c)), bot = Y(Math.min(k.o, k.c));
      s += '<g><title>' + esc(k.t + '  O ' + k.o + '  H ' + k.h + '  L ' + k.l + '  C ' + k.c) + '</title><line x1="' + X(i).toFixed(1) + '" x2="' + X(i).toFixed(1) + '" y1="' + Y(k.h).toFixed(1) + '" y2="' + Y(k.l).toFixed(1) + '" stroke="' + col + '" stroke-width="1"/>' +
        '<rect x="' + (X(i) - bw * 0.32).toFixed(1) + '" width="' + (bw * 0.64).toFixed(1) + '" y="' + top.toFixed(1) + '" height="' + Math.max(1, bot - top).toFixed(1) + '" fill="' + col + '"/></g>';
    });
    emas.forEach(function (e) {
      var d = '';
      e.values.forEach(function (v, i) { if (isNum(v)) d += (d ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); });
      if (d) s += '<path d="' + d + '" fill="none" stroke="' + e.color + '" stroke-width="1.6" stroke-dasharray="' + (e.dash || '') + '"/>';
    });
    [0, Math.floor(n / 2), n - 1].forEach(function (i) { s += '<text x="' + X(i).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(F.date(c[i].t).replace(/ \d{4}$/, '')) + '</text>'; });
    s += '</svg><div class="legend"><span><i style="background:var(--up)"></i>Up day</span><span><i style="background:var(--down)"></i>Down day</span>' +
      emas.map(function (e) { return '<span><i style="background:' + e.color + '"></i>' + esc(e.name) + '</span>'; }).join('') +
      (zones.length ? '<span><i style="background:var(--accent);opacity:.35"></i>FVG zone (sheet rules)</span>' : '') + '</div>';
    host.innerHTML = s;
  }

  SB.onStockDrawer = function (s, body) {
    var stHost = body.querySelector('#drawer-strategy'), chHost = body.querySelector('#drawer-chart');
    if (chHost) chHost.innerHTML = ui.skeleton(3);
    SB.strategies.runActive().then(function (run) {
      var r = run.bySym[s.sym], cfg = run.config;
      if (stHost && r) {
        stHost.innerHTML = '<section class="card" style="margin-top:12px;padding:12px"><div class="card-head" style="margin-bottom:6px"><div><h3>' + esc(cfg.name) + ' · v' + cfg.version + '</h3>' +
          '<p>' + (cfg.source === 'demo' ? 'DEMO strategy' : SB.strategies.isConfirmed(cfg.id) ? 'Confirmed by you' : 'From your sheet - not yet confirmed') + ' · candles to ' + esc(r.asOf || run.dataAsOf || '') + '</p></div>' +
          '<div class="tags">' + ui.badge(r.statusLabel) + '<span class="badge">' + r.score + '% match</span></div></div>' +
          '<ul class="checks">' + (r.checks || []).map(function (k) {
            var p = k.res.pass;
            return '<li>' + (p === true ? '<span class="ok">✓</span>' : p === false ? '<span class="no">✗</span>' : '<span class="na">–</span>') + '<span>' + esc(k.label) + (k.res.detail ? ' <span class="sub">(' + esc(k.res.detail) + ')</span>' : '') + '</span></li>';
          }).join('') + '</ul>' + (r.failed && r.failed.length && r.status !== 'qualified' ? '<p class="sub" style="margin-top:6px">' + r.failed.map(esc).join('; ') + '</p>' : '') +
          (r.stop > 0 ? '<p class="sub" style="margin-top:6px">Entry ref ' + F.price(r.entry) + ' · stop ' + F.price(r.stop) + ' · target ' + F.price(r.target) + ' · R:R 1:' + F.num(r.rr, 2) + '</p>' : '') + '</section>';
      }
      if (!chHost) return;
      var c = (SB.strategies.candles() || {})[s.sym];
      if (!c) { chHost.innerHTML = '<p class="sub">No daily candles for this stock in the snapshot.</p>'; return; }
      var zones = SB.fvg.watchZones(c).zones;
      chHost.innerHTML = '<h3 style="margin-bottom:6px">Daily candles · last ' + c.length + ' sessions</h3><div id="dc"></div><p class="sub">Source: ' + esc((SB.ctx.history && SB.ctx.history.source) || 'History30') + '. EMA and zones computed with the sheet\'s own rules.</p>';
      candleChart(chHost.querySelector('#dc'), c, zones, [
        { name: 'EMA 10', values: SB.indicators.ema(c, 10), color: 'var(--accent)' },
        { name: 'EMA 21', values: SB.indicators.ema(c, 21), color: 'var(--warn-mark)', dash: '4 3' }
      ]);
    }).catch(function (e) {
      if (chHost) chHost.innerHTML = '<p class="sub">Chart unavailable: ' + esc(e.message) + '</p>';
    });
  };
})();
