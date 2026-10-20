// 'none' provider: no market data at all. Always UNAVAILABLE, never fabricates.
(function () {
  'use strict';

  const common = require('./common');

  const HOW_TO = 'Set MARKET_DATA_PROVIDER=dhan (plus DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN) or ' +
    'MARKET_DATA_PROVIDER=sheet (plus SHEET_FEED_URL and SHEET_FEED_TOKEN) in ' +
    'Vercel > Project > Settings > Environment Variables, then redeploy.';

  function createNoneProvider(env, opts) {
    const o = opts || {};
    const now = typeof o.now === 'function' ? o.now : function () { return Date.now(); };
    const message = (o.unknownSelection
      ? 'MARKET_DATA_PROVIDER has an unknown value (use dhan, sheet or none). '
      : 'No market-data provider is configured. ') + HOW_TO;

    return {
      name: 'none',
      describe: function () {
        return {
          name: 'none',
          requires: ['MARKET_DATA_PROVIDER'],
          configured: false,
          licensing: 'No market data is fetched or shown by the server.'
        };
      },
      status: async function () {
        return { ok: false, state: 'UNAVAILABLE', message: message };
      },
      quotes: async function (symbols) {
        return common.unavailableQuotes('none', message, now());
      },
      history: async function (symbol, range) {
        const r = range || {};
        return common.unavailableHistory('none', message,
          typeof symbol === 'string' ? symbol.toUpperCase() : null, { from: r.from, to: r.to });
      }
    };
  }

  module.exports = { createNoneProvider: createNoneProvider, HOW_TO: HOW_TO };
})();
