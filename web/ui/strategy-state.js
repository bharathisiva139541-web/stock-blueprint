/* Shared strategy state for all pages (browser only).
   - Presets come from web/lib/strategy.js (sheet-discovered + DEMO).
   - The viewer's own edits are saved in THIS browser only (localStorage),
     each save bumps the version and records what changed.
   - runActive() loads the daily candles once and caches the run per
     strategy version + data date, so pages share one result.
   API: SB.strategies = { list, get, activeId, setActive, save, resetToPreset, confirm,
                          isConfirmed, history, exportJson, importJson, runActive, lastRun, candles }
        SB.strategyResults(ctx) -> last run of the active strategy or null (sync) */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, S = SB.strategy;
  var KEY = 'strategies:v1';

  function load() { return ui.store.get(KEY, { active: 'sheet', custom: {}, history: {}, confirmed: {} }); }
  function persist(st) { ui.store.set(KEY, st); }

  function list() {
    var st = load(), out = [];
    Object.keys(S.PRESETS).forEach(function (id) {
      out.push(st.custom[id] || S.clone(S.PRESETS[id]));
    });
    Object.keys(st.custom).forEach(function (id) { if (!S.PRESETS[id]) out.push(st.custom[id]); });
    return out;
  }
  function get(id) {
    var st = load();
    if (st.custom[id]) return S.clone(st.custom[id]);
    if (S.PRESETS[id]) return S.clone(S.PRESETS[id]);
    return null;
  }
  function activeId() { var st = load(); return get(st.active) ? st.active : 'sheet'; }
  function setActive(id) { var st = load(); if (get(id)) { st.active = id; persist(st); cache = null; } }

  /** Save an edited config: validates, bumps version, records the diff. */
  function save(cfg, note) {
    var v = S.validate(cfg);
    if (!v.ok) return v;
    var st = load(), prev = get(cfg.id);
    var next = v.config;
    delete next.__valid;
    var changes = prev ? S.diff(prev, next) : ['created'];
    if (prev && !changes.length) return { ok: true, errors: [], config: prev, unchanged: true };
    next.version = (prev ? prev.version : 0) + 1;
    next.updatedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
    if (next.source === 'discovered' && changes.length) next.source = 'discovered-edited';
    st.custom[next.id] = next;
    (st.history[next.id] = st.history[next.id] || []).unshift({ version: next.version, at: next.updatedAt, note: note || '', changes: changes });
    st.history[next.id] = st.history[next.id].slice(0, 50);
    delete st.confirmed[next.id];               // a changed rule set needs confirming again
    persist(st);
    cache = null;
    return { ok: true, errors: [], config: next, changes: changes };
  }
  function resetToPreset(id) {
    var st = load();
    if (!S.PRESETS[id]) return;
    delete st.custom[id];
    (st.history[id] = st.history[id] || []).unshift({ version: S.PRESETS[id].version, at: new Date().toISOString().slice(0, 16).replace('T', ' '), note: 'reset to the original preset', changes: [] });
    delete st.confirmed[id];
    persist(st);
    cache = null;
  }
  function confirm(id, yes) {
    var st = load(), c = get(id);
    if (!c) return;
    if (yes) st.confirmed[id] = { version: c.version, at: new Date().toISOString().slice(0, 16).replace('T', ' ') };
    else delete st.confirmed[id];
    persist(st);
  }
  /** Confirmed = the viewer confirmed THIS version of the rules (DEMO can never be). */
  function isConfirmed(id) {
    var st = load(), c = get(id), k = st.confirmed[id];
    return !!(c && c.source !== 'demo' && k && k.version === c.version);
  }
  function history(id) { return (load().history[id] || []).slice(); }
  function exportJson(id) { return JSON.stringify(get(id), null, 2); }
  function importJson(text) {
    var cfg;
    try { cfg = JSON.parse(text); } catch (e) { return { ok: false, errors: ['not valid JSON'] }; }
    if (!cfg || typeof cfg !== 'object') return { ok: false, errors: ['not a strategy'] };
    cfg.id = String(cfg.id || 'custom-' + Date.now()).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'custom';
    if (cfg.source === 'demo' && !S.PRESETS[cfg.id]) cfg.source = 'custom';
    return save(cfg, 'imported');
  }

  // ---------- running ----------
  var candleMap = null, cache = null, running = null;
  function candles() {
    var H = SB.ctx.history;
    if (!H) return null;
    if (!candleMap) {
      candleMap = {};
      Object.keys(H.bars).forEach(function (sym) {
        candleMap[sym] = H.bars[sym].map(function (b) { return { t: H.dates[b[0]], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] }; });
      });
    }
    return candleMap;
  }
  /** Promise<run result> for the active (or given) strategy. */
  function runActive(id) {
    var cfg = get(id || activeId());
    var key = cfg.id + '@' + cfg.version + '@' + (SB.ctx.market.asOf || '') + '@' + SB.ctx.market.state;
    if (cache && cache.key === key) return Promise.resolve(cache.result);
    if (running && running.key === key) return running.p;
    var p = SB.loadHistory().then(function (H) {
      if (!H) throw new Error('no candle history file (data/history.js)');
      var r = S.run(cfg, SB.ctx.stocks, candles(), { usePrice: true, latestDate: H.dates[H.dates.length - 1] });
      r.dataAsOf = H.dates[H.dates.length - 1];
      r.dataSource = H.source;
      r.confirmed = isConfirmed(cfg.id);
      r.ranAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
      cache = { key: key, result: r };
      running = null;
      return r;
    }, function (e) { running = null; throw e; });
    running = { key: key, p: p };
    return p;
  }
  function lastRun() { return cache ? cache.result : null; }

  SB.strategies = {
    list: list, get: get, activeId: activeId, setActive: setActive, save: save, resetToPreset: resetToPreset,
    confirm: confirm, isConfirmed: isConfirmed, history: history, exportJson: exportJson, importJson: importJson,
    runActive: runActive, lastRun: lastRun, candles: candles
  };
  SB.strategyResults = function () { return lastRun(); };
})();
