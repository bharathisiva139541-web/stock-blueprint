// Market-data provider registry.
//
// getProvider(env, deps) picks the provider named by env.MARKET_DATA_PROVIDER
// ('dhan' | 'sheet' | 'none', default 'none'). Every provider implements:
//   name
//   describe() -> { name, requires:[env var names], configured, licensing }
//   async status() -> { ok, state, message }
//   async quotes(symbols) -> { state, source, asOf, items:[...], errors:[{symbol, reason}] }
//   async history(symbol, { from, to, interval:'1d' }) -> { state, source, candles:[{t,o,h,l,c,v}], errors }
// deps (optional, mainly for tests): { fetch, now, sleep, cache, timeoutMs }
(function () {
  'use strict';

  const none = require('./none');
  const dhan = require('./dhan');
  const sheet = require('./sheet');

  const PROVIDER_NAMES = ['dhan', 'sheet', 'none'];

  /** Normalised provider name from env, or null when the value is not recognised. */
  function selectedName(env) {
    const raw = env && env.MARKET_DATA_PROVIDER;
    const v = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
    if (!v) return 'none';
    return PROVIDER_NAMES.indexOf(v) >= 0 ? v : null;
  }

  function getProvider(env, deps) {
    const e = env || {};
    const name = selectedName(e);
    if (name === 'dhan') return dhan.createDhanProvider(e, deps);
    if (name === 'sheet') return sheet.createSheetProvider(e, deps);
    return none.createNoneProvider(e, { unknownSelection: name === null, now: deps && deps.now });
  }

  module.exports = { getProvider: getProvider, selectedName: selectedName, PROVIDER_NAMES: PROVIDER_NAMES };
})();
