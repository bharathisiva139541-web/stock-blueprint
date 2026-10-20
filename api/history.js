// GET /api/history?symbol=SBIN&from=YYYY-MM-DD&to=YYYY-MM-DD   (daily, max 3 years)
// -> { state, source, symbol, from, to, interval:'1d', candles:[{t,o,h,l,c,v}] oldest first, errors }
// Defaults: to = today (IST), from = to - 365 days. 400 on bad input.
(function () {
  'use strict';

  const http = require('./_lib/http');
  const cacheLib = require('./_lib/cache');
  const validate = require('./_lib/validate');
  const providers = require('./_lib/providers');

  /** deps (tests): { env, fetch, now, sleep, cache, timeoutMs } */
  function createHandler(deps) {
    const d = deps || {};
    const getEnv = function () { return d.env || http.readEnv(); };
    const now = typeof d.now === 'function' ? d.now : function () { return Date.now(); };
    return http.endpoint('history', getEnv, async function (req, res, env) {
      const parsed = validate.parseHistoryQuery(http.getQuery(req), now());
      if (!parsed.ok) {
        http.sendJson(res, 400, { error: parsed.error }, { env: env, cacheControl: cacheLib.noStore() });
        return;
      }
      const cache = d.cache || cacheLib.shared;
      const provider = providers.getProvider(env, {
        fetch: d.fetch, now: now, sleep: d.sleep, cache: cache, timeoutMs: d.timeoutMs
      });
      const key = 'history:' + provider.name + ':' + parsed.symbol + ':' + parsed.from + ':' + parsed.to;
      let payload = cache.get(key);
      if (!payload) {
        payload = await provider.history(parsed.symbol, { from: parsed.from, to: parsed.to, interval: parsed.interval });
        if (payload.state !== 'UNAVAILABLE') cache.set(key, payload, cacheLib.HISTORY_TTL_S * 1000);
      }
      const cc = payload.state === 'UNAVAILABLE' ? cacheLib.unavailableCacheControl() : cacheLib.historyCacheControl();
      http.sendJson(res, 200, payload, { env: env, cacheControl: cc });
    });
  }

  module.exports = createHandler();
  module.exports.createHandler = createHandler;
})();
