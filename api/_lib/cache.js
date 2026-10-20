// Small in-memory TTL cache + Cache-Control header helpers (server side).
//
// The memory cache lives only as long as one warm serverless instance, so
// it is a cost/rate-limit saver, never a source of truth. The CDN cache
// (Cache-Control s-maxage) is what protects the upstream APIs from many
// visitors at once.
(function () {
  'use strict';

  /**
   * createCache({ now, maxEntries }) -> cache
   *   get(key)                 value, or undefined when missing/expired
   *   peek(key)                { value, expired } even after expiry, or null
   *   set(key, value, ttlMs)
   *   delete(key), clear(), size()
   *   getOrLoad(key, ttlMs, loader, { staleOnError, shouldCache })
   *       Returns the cached value or awaits loader(). Concurrent callers for
   *       the same key share one in-flight load. With staleOnError the last
   *       (expired) value is returned when the loader throws.
   */
  function createCache(opts) {
    const o = opts || {};
    const now = typeof o.now === 'function' ? o.now : function () { return Date.now(); };
    const maxEntries = o.maxEntries > 0 ? o.maxEntries : 500;
    const store = new Map();
    const inflight = new Map();

    function prune() {
      if (store.size <= maxEntries) return;
      const t = now();
      store.forEach(function (e, k) { if (e.expires <= t) store.delete(k); });
      // Still too big: drop the oldest insertions (Map keeps insertion order).
      const it = store.keys();
      while (store.size > maxEntries) {
        const k = it.next();
        if (k.done) break;
        store.delete(k.value);
      }
    }

    function get(key) {
      const e = store.get(key);
      if (!e) return undefined;
      return e.expires > now() ? e.value : undefined;
    }

    function peek(key) {
      const e = store.get(key);
      return e ? { value: e.value, expired: e.expires <= now() } : null;
    }

    function set(key, value, ttlMs) {
      const ttl = Number(ttlMs);
      if (!(ttl > 0)) return;
      store.delete(key); // refresh insertion order
      store.set(key, { value: value, expires: now() + ttl });
      prune();
    }

    async function getOrLoad(key, ttlMs, loader, options) {
      const op = options || {};
      const hit = get(key);
      if (hit !== undefined) return hit;
      if (inflight.has(key)) return inflight.get(key);
      // The loader starts on the next microtask, so `inflight` is always set
      // before the finally-block can remove it (even for a sync throw).
      const p = Promise.resolve().then(async function () {
        try {
          const v = await loader();
          const ok = typeof op.shouldCache === 'function' ? op.shouldCache(v) : v !== undefined;
          if (ok) set(key, v, ttlMs);
          return v;
        } catch (err) {
          const old = op.staleOnError ? peek(key) : null;
          if (old) return old.value;
          throw err;
        } finally {
          inflight.delete(key);
        }
      });
      inflight.set(key, p);
      return p;
    }

    return {
      get: get,
      peek: peek,
      set: set,
      getOrLoad: getOrLoad,
      delete: function (key) { store.delete(key); },
      clear: function () { store.clear(); inflight.clear(); },
      size: function () { return store.size; }
    };
  }

  // One shared cache per warm function instance.
  const shared = createCache({ maxEntries: 500 });

  // Seconds. Quotes: short while the market is open, longer when nothing moves.
  const QUOTES_TTL_S = { 'open': 15, 'pre-open': 30, 'closed': 60, 'holiday': 60, 'weekend': 60 };
  const HISTORY_TTL_S = 6 * 3600;
  const STATUS_TTL_S = 30;
  const UNAVAILABLE_TTL_S = 15;

  /** Seconds a quotes response may be cached for, by NSE session state. */
  function quotesTtlSeconds(session) {
    return Object.prototype.hasOwnProperty.call(QUOTES_TTL_S, session) ? QUOTES_TTL_S[session] : 15;
  }

  function publicCache(seconds, swr) {
    return 'public, max-age=0, s-maxage=' + seconds +
      (swr ? ', stale-while-revalidate=' + swr : '');
  }

  /** Cache-Control for /api/quotes (15-60 s on the CDN depending on session). */
  function quotesCacheControl(session) {
    const s = quotesTtlSeconds(session);
    return publicCache(s, s);
  }

  /** Cache-Control for /api/history (6 h on the CDN). */
  function historyCacheControl() { return publicCache(HISTORY_TTL_S, 3600); }

  /** Cache-Control for /api/market-status. */
  function statusCacheControl() { return publicCache(STATUS_TTL_S, 30); }

  /** Cache-Control for a provider-level UNAVAILABLE payload (short, so a fix shows quickly). */
  function unavailableCacheControl() { return publicCache(UNAVAILABLE_TTL_S, 0); }

  /** Cache-Control for errors (bad input, method not allowed, crashes). */
  function noStore() { return 'no-store'; }

  module.exports = {
    createCache: createCache,
    shared: shared,
    QUOTES_TTL_S: QUOTES_TTL_S,
    HISTORY_TTL_S: HISTORY_TTL_S,
    STATUS_TTL_S: STATUS_TTL_S,
    quotesTtlSeconds: quotesTtlSeconds,
    quotesCacheControl: quotesCacheControl,
    historyCacheControl: historyCacheControl,
    statusCacheControl: statusCacheControl,
    unavailableCacheControl: unavailableCacheControl,
    noStore: noStore
  };
})();
