// GET /api/market-status
// -> { provider:{name, configured, requires, licensing},
//      session:{state, now, lastCompletedSession, ...}, status:{ok, state, message} }
// Never returns env values (only env var NAMES in provider.requires).
(function () {
  'use strict';

  const http = require('./_lib/http');
  const cacheLib = require('./_lib/cache');
  const cal = require('./_lib/market-calendar');
  const providers = require('./_lib/providers');

  /** deps (tests): { env, fetch, now, sleep, cache, timeoutMs } */
  function createHandler(deps) {
    const d = deps || {};
    const getEnv = function () { return d.env || http.readEnv(); };
    const now = typeof d.now === 'function' ? d.now : function () { return Date.now(); };
    return http.endpoint('market-status', getEnv, async function (req, res, env) {
      const provider = providers.getProvider(env, {
        fetch: d.fetch, now: now, sleep: d.sleep, cache: d.cache, timeoutMs: d.timeoutMs
      });
      const desc = provider.describe();
      const status = await provider.status();
      const nowMs = now();
      const session = {
        state: cal.sessionState(nowMs),
        now: cal.istDateTimeStr(nowMs),
        timezone: 'Asia/Kolkata',
        isTradingDay: cal.isTradingDay(nowMs),
        holiday: cal.holidayName(nowMs),
        lastCompletedSession: cal.lastCompletedSession(nowMs),
        nextTradingDay: cal.nextTradingDay(nowMs),
        hours: cal.SESSION,
        calendarCovered: cal.isCalendarCovered(nowMs)
      };
      if (!session.calendarCovered) {
        session.note = 'NSE holiday list does not cover ' + session.now.slice(0, 4) +
          ' - only weekends are skipped. Update api/_lib/market-calendar.js.';
      }
      http.sendJson(res, 200, {
        provider: { name: desc.name, configured: desc.configured, requires: desc.requires, licensing: desc.licensing },
        session: session,
        status: status
      }, { env: env, cacheControl: cacheLib.statusCacheControl() });
    });
  }

  module.exports = createHandler();
  module.exports.createHandler = createHandler;
})();
