// GET /api/quotes?symbols=SBIN,TCS   (1-500 NSE symbols)
// -> { state, source, asOf, items:[{ id, symbol, exchange, ltp, prevClose, open, high, low,
//      volume, changePct, lastTradeTime, state }], errors:[{symbol, reason}] }
// 400 on bad input. Provider failures come back as 200 with state 'UNAVAILABLE'.
(function () {
  'use strict';

  const http = require('./_lib/http');
  const cacheLib = require('./_lib/cache');
  const cal = require('./_lib/market-calendar');
  const validate = require('./_lib/validate');
  const providers = require('./_lib/providers');

  /** deps (tests): { env, fetch, now, sleep, cache, timeoutMs } */
  function createHandler(deps) {
    const d = deps || {};
    const getEnv = function () { return d.env || http.readEnv(); };
    const now = typeof d.now === 'function' ? d.now : function () { return Date.now(); };
    return http.endpoint('quotes', getEnv, async function (req, res, env) {
      const query = http.getQuery(req);
      const parsed = validate.parseSymbols(query.symbols);
      if (!parsed.ok) {
        http.sendJson(res, 400, { error: parsed.error }, { env: env, cacheControl: cacheLib.noStore() });
        return;
      }
      const cache = d.cache || cacheLib.shared;
      const provider = providers.getProvider(env, {
        fetch: d.fetch, now: now, sleep: d.sleep, cache: cache, timeoutMs: d.timeoutMs
      });
      const session = cal.sessionState(now());
      const key = 'quotes:' + provider.name + ':' + parsed.symbols.join(',');
      let payload = cache.get(key);
      if (!payload) {
        payload = await provider.quotes(parsed.symbols);
        if (payload.state !== 'UNAVAILABLE' && !payload.partial) {
          cache.set(key, payload, cacheLib.quotesTtlSeconds(session) * 1000);
        }
      }
      const cc = payload.state === 'UNAVAILABLE' || payload.partial
        ? cacheLib.unavailableCacheControl() : cacheLib.quotesCacheControl(session);
      http.sendJson(res, 200, payload, { env: env, cacheControl: cc });
    });
  }

  module.exports = createHandler();
  module.exports.createHandler = createHandler;
})();
