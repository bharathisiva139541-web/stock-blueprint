// HTTP helpers for the Vercel functions: query parsing, CORS, JSON replies,
// secret redaction and a crash guard. Works with Vercel's helpers
// (res.status().json()) and with a plain Node http.ServerResponse.
(function () {
  'use strict';

  const cacheLib = require('./cache');

  // Env vars whose VALUES must never appear in a response or a log line.
  const SECRET_ENV_KEYS = ['DHAN_ACCESS_TOKEN', 'DHAN_CLIENT_ID', 'SHEET_FEED_TOKEN', 'SHEET_FEED_URL'];

  /** process.env without depending on Node typings. */
  function readEnv() {
    const p = /** @type {any} */ (globalThis).process;
    return (p && p.env) || {};
  }

  function secretValues(env) {
    const e = env || {};
    return SECRET_ENV_KEYS.map(function (k) { return String(e[k] || '').trim(); })
      .filter(function (v) { return v.length >= 6; });
  }

  /** Replaces secret env values inside a string. */
  function redactText(text, env) {
    let s = String(text === undefined || text === null ? '' : text);
    secretValues(env).forEach(function (v) { s = s.split(v).join('[redacted]'); });
    return s;
  }

  /** Deep copy of a JSON value with secret env values removed from every string. */
  function redactDeep(value, env) {
    const secrets = secretValues(env);
    if (!secrets.length) return value;
    const walk = function (v, depth) {
      if (typeof v === 'string') {
        let s = v;
        secrets.forEach(function (x) { if (s.indexOf(x) >= 0) s = s.split(x).join('[redacted]'); });
        return s;
      }
      if (!v || typeof v !== 'object' || depth > 20) return v;
      if (Array.isArray(v)) return v.map(function (x) { return walk(x, depth + 1); });
      const out = {};
      Object.keys(v).forEach(function (k) { out[k] = walk(v[k], depth + 1); });
      return out;
    };
    return walk(value, 0);
  }

  /** Query object from Vercel's req.query, or parsed from req.url. Repeated keys -> array. */
  function getQuery(req) {
    if (req && req.query && typeof req.query === 'object') return req.query;
    const out = {};
    try {
      const u = new URL(String((req && req.url) || '/'), 'http://localhost');
      u.searchParams.forEach(function (v, k) {
        if (Object.prototype.hasOwnProperty.call(out, k)) out[k] = [].concat(out[k], v);
        else out[k] = v;
      });
    } catch { /* empty query */ }
    return out;
  }

  function setHeader(res, k, v) {
    if (res && typeof res.setHeader === 'function') res.setHeader(k, v);
  }

  /**
   * Sends JSON. opts: { cacheControl, env, cors (default true), headers }.
   * CORS: Access-Control-Allow-Origin * on GET replies (public market data, no secrets).
   */
  function sendJson(res, status, body, opts) {
    const o = opts || {};
    const safe = redactDeep(body, o.env);
    setHeader(res, 'Content-Type', 'application/json; charset=utf-8');
    setHeader(res, 'Cache-Control', o.cacheControl || cacheLib.noStore());
    setHeader(res, 'X-Content-Type-Options', 'nosniff');
    if (o.cors !== false) setHeader(res, 'Access-Control-Allow-Origin', '*');
    Object.keys(o.headers || {}).forEach(function (k) { setHeader(res, k, o.headers[k]); });
    if (res && typeof res.status === 'function' && typeof res.json === 'function') {
      res.status(status).json(safe);
      return;
    }
    res.statusCode = status;
    res.end(JSON.stringify(safe));
  }

  /**
   * Handles OPTIONS and non-GET methods. Returns true when the request was answered.
   */
  function rejectNonGet(req, res) {
    const method = String((req && req.method) || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') return false;
    if (method === 'OPTIONS') {
      setHeader(res, 'Access-Control-Allow-Origin', '*');
      setHeader(res, 'Access-Control-Allow-Methods', 'GET');
      setHeader(res, 'Access-Control-Max-Age', '86400');
      setHeader(res, 'Allow', 'GET, HEAD, OPTIONS');
      setHeader(res, 'Cache-Control', cacheLib.noStore());
      if (res && typeof res.status === 'function' && typeof res.end === 'function') res.status(204).end();
      else { res.statusCode = 204; res.end(); }
      return true;
    }
    sendJson(res, 405, { error: 'method not allowed - use GET' },
      { cors: false, headers: { Allow: 'GET, HEAD, OPTIONS' } });
    return true;
  }

  /** Logs without secrets (never logs request headers, env or upstream bodies). */
  function logError(label, err, env) {
    const msg = err && err.message ? err.message : String(err);
    try { console.error('[api/' + label + '] ' + redactText(msg, env).slice(0, 300)); } catch { /* ignore */ }
  }

  /**
   * Wraps an endpoint: (req, res, env) => Promise. Method guard + crash guard
   * (500 JSON with a generic message).
   */
  function endpoint(label, getEnv, fn) {
    return async function (req, res) {
      const env = getEnv();
      try {
        if (rejectNonGet(req, res)) return;
        await fn(req, res, env);
      } catch (err) {
        logError(label, err, env);
        try { sendJson(res, 500, { error: 'internal error' }, { env: env }); } catch { /* response already sent */ }
      }
    };
  }

  module.exports = {
    SECRET_ENV_KEYS: SECRET_ENV_KEYS,
    readEnv: readEnv,
    redactText: redactText,
    redactDeep: redactDeep,
    getQuery: getQuery,
    sendJson: sendJson,
    rejectNonGet: rejectNonGet,
    logError: logError,
    endpoint: endpoint
  };
})();
