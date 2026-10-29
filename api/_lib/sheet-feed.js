// Client for the owner's Google Sheet web app (Code.gs doPost, the /exec URL).
// Shared by the 'sheet' quotes provider (action 'snapshot') and the live
// site feed api/site.js (action 'site').
//
// env: SHEET_FEED_URL   the web app /exec URL (treat it as a secret: it is
//                       also the PC bridge's address)
//      SHEET_FEED_TOKEN the read-only feed token (script property
//                       AB_FEED_TOKEN), never the PC bridge token
// Request : POST {token, action, ...} as JSON. Apps Script answers with a
//           302 to googleusercontent.com, so redirects are followed.
// postFeed() never throws and never returns upstream error text: every
// failure becomes one of the fixed reasons below.
(function () {
  'use strict';

  const fetchUtil = require('./fetch-util');

  const REQUIRES = ['SHEET_FEED_URL', 'SHEET_FEED_TOKEN'];
  const URL_RULE = 'SHEET_FEED_URL must be the https:// /exec URL of the Apps Script web app.';
  const NEW_VERSION = 'deploy a New version of the EXISTING web-app deployment';

  /** { url, token, missing:[env names], urlOk, configured } - values stay inside the server. */
  function readConfig(env) {
    const e = env || {};
    const url = String(e.SHEET_FEED_URL || '').trim();
    const token = String(e.SHEET_FEED_TOKEN || '').trim();
    const missing = REQUIRES.filter(function (k) { return !String(e[k] || '').trim(); });
    const urlOk = /^https:\/\/[^\s]+$/i.test(url);
    return { url: url, token: token, missing: missing, urlOk: urlOk, configured: !!(url && token && urlOk) };
  }

  /** True when both env vars are set and the URL is https. */
  function configured(env) { return readConfig(env).configured; }

  /** Why the feed is not configured (env var NAMES only), prefixed with `lead`. */
  function notConfiguredMessage(env, lead) {
    const c = readConfig(env);
    if (c.missing.length) {
      return lead + ': set ' + c.missing.join(' and ') +
        ' in Vercel > Project > Settings > Environment Variables, then redeploy.';
    }
    return lead + ': ' + URL_RULE;
  }

  /** Fixed reason for an { ok:false, error } answer of Code.gs (its text is never passed on). */
  function mapSheetError(err, body) {
    const e = String(err || '');
    const action = String((body && body.action) || '');
    if (/token/i.test(e)) return { code: 'auth', auth: true, reason: 'auth failed: the sheet rejected SHEET_FEED_TOKEN' };
    if (/unknown action/i.test(e)) {
      return { code: 'unknown-action',
               reason: 'the sheet web app does not support action "' + action.replace(/[^a-z]/gi, '').slice(0, 20) +
                 '" yet (add it to Code.gs and ' + NEW_VERSION + ')' };
    }
    if (/unknown part/i.test(e)) {
      return { code: 'unknown-part',
               reason: 'the sheet web app does not support part "' + String((body && body.part) || '').replace(/[^a-z]/gi, '').slice(0, 20) +
                 '" yet (update Code.gs and ' + NEW_VERSION + ')' };
    }
    // My Watchlists (action 'watchlists'): the PIN is checked by the sheet; only the minutes are copied
    const locked = /locked for (\d{1,5}) min/i.exec(e);
    if (locked) {
      return { code: 'locked', reason: (/wrong pin/i.test(e) ? 'wrong PIN - ' : '') + 'too many wrong PINs: the watchlists are locked for ' +
        locked[1] + ' min (setting the PIN again in the sheet unlocks them)' };
    }
    if (/wrong pin/i.test(e)) return { code: 'pin', reason: 'wrong PIN' };
    if (/no pin set/i.test(e)) {
      return { code: 'nopin', reason: 'the sheet has no watchlist PIN yet (sheet menu 3 > My Watchlists sync: set / change PIN)' };
    }
    if (/too big/i.test(e)) return { code: 'too-big', reason: 'the watchlists are too big to keep in the sheet' };
    if (/unreadable/i.test(e)) return { code: 'unreadable', reason: 'the sheet\'s stored watchlists (tab Site_Watchlists) could not be read' };
    if (/busy/i.test(e)) return { code: 'busy', reason: 'sheet busy - try again shortly' };
    if (/updating/i.test(e)) {
      // Only the two counts are copied from the upstream text.
      const m = /(\d{1,6})\s+of\s+(\d{1,6})/.exec(e);
      return { code: 'updating',
               reason: 'sheet is updating' + (m ? ' (History30 has ' + m[1] + ' of ' + m[2] + ' symbols)' : '') +
                 ' - try again shortly' };
    }
    return { code: 'error', reason: 'sheet feed returned an error' };
  }

  /**
   * postFeed(env, deps, body, timeoutMs) -> never throws:
   *   { ok:true, data }                       data = the parsed Code.gs answer (ok:true)
   *   { ok:false, code, reason, auth? }       code: not-configured | timeout | network |
   *                                           malformed | http | auth | unknown-action |
   *                                           unknown-part | busy | updating | error
   * deps: { fetch } (tests inject a mock; otherwise the global fetch).
   */
  async function postFeed(env, deps, body, timeoutMs) {
    const c = readConfig(env);
    const d = deps || {};
    if (!c.configured) return { ok: false, code: 'not-configured', reason: notConfiguredMessage(env, 'Sheet feed not configured') };
    const payload = Object.assign({}, body || {}, { token: c.token });
    const resp = await fetchUtil.requestJson(d.fetch, c.url, {
      method: 'POST',
      redirect: 'follow', // Apps Script answers via a 302 to googleusercontent.com
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload)
    }, timeoutMs > 0 ? timeoutMs : fetchUtil.DEFAULT_TIMEOUT_MS);
    if (resp.error === 'timeout') return { ok: false, code: 'timeout', reason: 'sheet feed timed out (the sheet may be busy)' };
    if (resp.error === 'network' || resp.error === 'no-fetch') {
      return { ok: false, code: 'network', reason: 'sheet feed not reachable (network error)' };
    }
    if (resp.error === 'malformed') {
      return { ok: false, code: 'malformed',
               reason: 'sheet feed did not return JSON (is the web app deployed with access "Anyone"?)' };
    }
    if (!resp.ok) return { ok: false, code: 'http', reason: 'sheet feed failed (HTTP ' + resp.status + ')' };
    const data = resp.data && typeof resp.data === 'object' ? resp.data : {};
    if (data.ok !== true) {
      const m = mapSheetError(data.error, body);
      return Object.assign({ ok: false }, m);
    }
    return { ok: true, data: data };
  }

  module.exports = {
    REQUIRES: REQUIRES,
    URL_RULE: URL_RULE,
    NEW_VERSION: NEW_VERSION,
    readConfig: readConfig,
    configured: configured,
    notConfiguredMessage: notConfiguredMessage,
    mapSheetError: mapSheetError,
    postFeed: postFeed
  };
})();
