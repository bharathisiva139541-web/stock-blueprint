// fetch() helpers with a hard timeout (AbortController) that never throw.
(function () {
  'use strict';

  const DEFAULT_TIMEOUT_MS = 10000;

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, Math.max(0, Number(ms) || 0)); });
  }

  /** The fetch to use: an injected one (tests) or the runtime global, read at call time. */
  function pickFetch(injected) {
    if (typeof injected === 'function') return injected;
    const g = /** @type {any} */ (globalThis);
    return typeof g.fetch === 'function' ? g.fetch : null;
  }

  /**
   * Runs work(signal) with a timeout. The AbortController cancels the
   * request, and a racing timer guarantees the promise settles even if the
   * fetch implementation ignores the signal. Rejects with err.code 'TIMEOUT'.
   */
  function withTimeout(timeoutMs, work) {
    const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
    const ctrl = new AbortController();
    let timer = null;
    const timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        const err = new Error('timeout after ' + ms + ' ms');
        /** @type {any} */ (err).code = 'TIMEOUT';
        reject(err);   // settle the race first ...
        ctrl.abort();  // ... then cancel the request
      }, ms);
    });
    let run;
    try { run = Promise.resolve(work(ctrl.signal)); } catch (e) { run = Promise.reject(e); }
    run.catch(function () { /* handled by the race */ });
    return Promise.race([run, timeout]).finally(function () { clearTimeout(timer); });
  }

  function retryAfterMs(res) {
    try {
      const v = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
      const n = Number(v);
      return v !== null && isFinite(n) && n >= 0 ? Math.min(n * 1000, 10000) : null;
    } catch { return null; }
  }

  /**
   * requestJson(fetchImpl, url, init, timeoutMs) -> never throws:
   *   { ok, status, data, error, retryAfterMs }
   * error: null | 'http' (non-2xx) | 'malformed' (2xx body is not JSON) |
   *        'timeout' | 'network' | 'no-fetch'
   * For non-2xx responses `data` holds the parsed error body when it is JSON.
   */
  async function requestJson(fetchImpl, url, init, timeoutMs) {
    const f = pickFetch(fetchImpl);
    if (!f) return { ok: false, status: 0, data: null, error: 'no-fetch', retryAfterMs: null };
    try {
      return await withTimeout(timeoutMs, async function (signal) {
        const res = await f(url, Object.assign({}, init || {}, { signal: signal }));
        const status = Number(res && res.status) || 0;
        const text = await res.text();
        let data = null, malformed = false;
        if (text && String(text).trim()) {
          try { data = JSON.parse(text); } catch { malformed = true; }
        } else {
          malformed = true; // an empty body is never a valid answer here
        }
        const okStatus = status >= 200 && status < 300;
        return {
          ok: okStatus && !malformed,
          status: status,
          data: malformed ? null : data,
          error: okStatus ? (malformed ? 'malformed' : null) : 'http',
          retryAfterMs: retryAfterMs(res)
        };
      });
    } catch (err) {
      return { ok: false, status: 0, data: null,
               error: err && err.code === 'TIMEOUT' ? 'timeout' : 'network', retryAfterMs: null };
    }
  }

  module.exports = {
    DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
    sleep: sleep,
    pickFetch: pickFetch,
    withTimeout: withTimeout,
    requestJson: requestJson
  };
})();
