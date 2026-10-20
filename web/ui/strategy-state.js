/* Shared strategy state for all pages (browser only).
   - Presets come from web/lib/strategy.js (sheet-discovered + DEMO).
   - The viewer's own edits are saved in THIS browser only (localStorage),
     each save bumps the version and records what changed.
   - runActive() loads the daily candles once and caches the run per
     strategy version + data date, so pages share one result.
   API: SB.strategies = { list, get, activeId, setActive, save, resetToPreset, confirm,
                          isConfirmed, history, exportJson, importJson, runActive, lastRun, candles, describe }
        SB.strategyResults(ctx) -> last run of the active strategy or null (sync) */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, S = SB.strategy;
  var KEY = 'strategies:v1';

  function load() {
    var st = ui.store.get(KEY, null) || {};
    st.active = st.active || 'sheet'; st.custom = st.custom || {}; st.history = st.history || {};
    st.confirmed = st.confirmed || {}; st.versions = st.versions || {};
    return st;
  }
  // timestamps in IST (the market's time zone), independent of the viewer's clock zone
  function istNow() { return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 16).replace('T', ' ') + ' IST'; }
  function norm(cfg) { var v = S.validate(cfg).config; delete v.__valid; return v; }
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
  function setActive(id) { var st = load(); if (get(id)) { st.active = id; persist(st); } }

  /** Save an edited config: validates, bumps version, records the diff. */
  function save(cfg, note) {
    var v = S.validate(cfg);
    if (!v.ok) return v;
    var st = load(), prev = get(cfg.id);
    var next = v.config;
    delete next.__valid;
    var changes = prev ? S.diff(norm(prev), next) : ['created'];
    if (prev && !changes.length) return { ok: true, errors: [], config: prev, unchanged: true };
    next.version = Math.max(prev ? prev.version : 0, st.versions[next.id] || 0) + 1;   // never reused, even after a reset
    st.versions[next.id] = next.version;
    next.updatedAt = istNow();
    if (next.source === 'discovered' && changes.length) next.source = 'discovered-edited';
    st.custom[next.id] = next;
    (st.history[next.id] = st.history[next.id] || []).unshift({ version: next.version, at: next.updatedAt, note: note || '', changes: changes });
    st.history[next.id] = st.history[next.id].slice(0, 50);
    delete st.confirmed[next.id];               // a changed rule set needs confirming again
    persist(st);
    drop(next.id);
    return { ok: true, errors: [], config: next, changes: changes };
  }
  function resetToPreset(id) {
    var st = load();
    if (!S.PRESETS[id]) return;
    delete st.custom[id];
    (st.history[id] = st.history[id] || []).unshift({ version: S.PRESETS[id].version, at: istNow(), note: 'reset to the original preset (next save continues from v' + ((st.versions[id] || 1) + 1) + ')', changes: [] });
    delete st.confirmed[id];
    persist(st);
    drop(id);
  }
  function confirm(id, yes) {
    var st = load(), c = get(id);
    if (!c) return;
    if (yes) st.confirmed[id] = { version: c.version, at: istNow() };
    else delete st.confirmed[id];
    persist(st);
    Object.keys(cache).forEach(function (k) { if (cache[k].result.config.id === id) cache[k].result.confirmed = isConfirmed(id); });
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
    // a file cannot claim to be "from your sheet" or turn DEMO into something confirmable
    if (S.PRESETS[cfg.id]) cfg.source = S.PRESETS[cfg.id].source === 'demo' ? 'demo' : 'discovered-edited';
    else cfg.source = 'custom';
    return save(cfg, 'imported');
  }

  // ---------- running ----------
  var candleMap = null, cache = {}, running = {};   // cache/running keyed by strategy id
  function drop(id) { delete cache[id]; delete running[id]; }
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
    if (!cfg) return Promise.reject(new Error('unknown strategy ' + id));
    var key = cfg.id + '@' + cfg.version + '@' + (cfg.updatedAt || '') + '@' + (SB.ctx.market.asOf || '') + '@' + SB.ctx.market.state;
    var c = cache[cfg.id], rn = running[cfg.id];
    if (c && c.key === key) return Promise.resolve(c.result);
    if (rn && rn.key === key) return rn.p;
    var p = SB.loadHistory().then(function (H) {
      if (!H) throw new Error('no candle history file (data/history.js)');
      var r = S.run(cfg, SB.ctx.stocks, candles(), { usePrice: true, latestDate: H.dates[H.dates.length - 1], refDate: ui.iso(SB.ctx.refDate) });
      r.dataAsOf = H.dates[H.dates.length - 1];
      r.dataSource = H.source;
      r.confirmed = isConfirmed(cfg.id);
      r.ranAt = istNow();
      cache[cfg.id] = { key: key, result: r };
      delete running[cfg.id];
      return r;
    }, function (e) { delete running[cfg.id]; throw e; });
    running[cfg.id] = { key: key, p: p };
    return p;
  }
  /** Last run of the given (default: ACTIVE) strategy, or null. */
  function lastRun(id) { var c = cache[id || activeId()]; return c ? c.result : null; }

  /** One honest wording of where a strategy's rules come from, for every page.
   *  -> { tag: short text, cls: badge class, long: sentence } */
  function describe(cfg) {
    if (!cfg) return { tag: 'no strategy', cls: 's-bad', long: 'No strategy is selected.' };
    var conf = isConfirmed(cfg.id), v = ' v' + cfg.version;
    if (cfg.source === 'demo') return { tag: 'DEMO', cls: 's-warn', long: 'DEMO strategy - for testing the engine only, not your strategy and not recommendations.' };
    if (cfg.source === 'custom') return conf ? { tag: 'Your own rules · confirmed' + v, cls: 's-good', long: 'Your own rules (made or imported in this browser), confirmed by you.' }
      : { tag: 'Your own rules · not confirmed', cls: 's-warn', long: 'Your own rules (made or imported in this browser), not yet confirmed.' };
    if (cfg.source === 'discovered-edited') return conf ? { tag: 'Edited from your sheet · confirmed' + v, cls: 's-good', long: 'Rules taken from your sheet and edited by you, confirmed by you.' }
      : { tag: 'Edited from your sheet · not confirmed', cls: 's-warn', long: 'Rules taken from your sheet and edited in this browser, not yet confirmed.' };
    return conf ? { tag: 'From your sheet · confirmed' + v, cls: 's-good', long: 'Rules taken from your sheet (Code.gs), confirmed by you.' }
      : { tag: 'From your sheet · not confirmed', cls: 's-warn', long: 'Rules taken from your sheet (Code.gs); how they combine into a suggestion and the stop/target method are assumptions until you confirm them.' };
  }

  SB.strategies = {
    describe: describe,
    list: list, get: get, activeId: activeId, setActive: setActive, save: save, resetToPreset: resetToPreset,
    confirm: confirm, isConfirmed: isConfirmed, history: history, exportJson: exportJson, importJson: importJson,
    runActive: runActive, lastRun: lastRun, candles: candles
  };
  SB.strategyResults = function () { return lastRun(); };

  /** EOD only when the newest daily candle covers the last completed NSE session
   *  (from the market-data API) or, without the API, the price snapshot's date. Otherwise CACHED. */
  SB.candleState = function (H) {
    if (!H || !H.dates || !H.dates.length) return 'UNAVAILABLE';
    var last = H.dates[H.dates.length - 1], m = SB.ctx.market;
    var need = m && m.session && m.session.lastCompletedSession || ui.iso(SB.ctx.refDate);
    return last >= need ? 'EOD' : 'CACHED';
  };
})();
