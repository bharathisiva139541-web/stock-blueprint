/* My Watchlists kept in the owner's Google Sheet, so the phone, the Vercel site and the
   Firebase copy all show the same lists. The PIN (set in the sheet: menu 3 > My Watchlists
   sync: set / change PIN) is typed once per device and kept in this browser
   (localStorage sb:wlsync = { pin, rev, base, at }); the SHEET checks it (Code2.gs
   ab_wlFromSite_ - 5 wrong PINs in a row lock the lists for 15 minutes), through the
   website's server: POST api/watchlists (Vercel; the Firebase copy uses web/config.js remoteApi).

   A sync: changes made here are saved on top of the sheet revision seen last (rev). When
   another device saved in between, the sheet answers 'conflict' with its lists; both sides
   are merged (SB.wlModel.merge, base = the sheet's lists at the last sync) and saved again.
   Runs at start, 1.5 s after a change, when the tab comes back to the front or goes online,
   and on "Sync now". Offline the lists stay in this browser and go with the next sync.

   SB.wlSync = { status(), connect(pin) -> Promise(status), disconnect(), syncNow() -> Promise,
                 onStatus(fn(status)) -> off() }
   status() = { phase, linked, at, message }   (linked stays false while a newly typed PIN is being checked)
     phase: 'nohost' (no website server here: localhost / file) | 'off' (no PIN on this device) |
            'syncing' | 'ok' | 'offline' (tried, will try again) | 'locked' (too many wrong PINs) |
            'pin' (wrong PIN - type it again) | 'nopin' (the sheet has no PIN yet) | 'error' */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, M = SB.wlModel, W = SB.watchlists;
  var KEY = 'wlsync', PIN_RE = /^[A-Za-z0-9]{6,20}$/;
  var DEBOUNCE_MS = 1500, FRONT_MS = 20000, TIMEOUT_MS = 30000, MAX_TRIES = 4;
  var listeners = [], busy = null, again = false, timer = null, lastRun = 0, trying = false;

  function meta() { var m = ui.store.get(KEY, null); return m && typeof m === 'object' ? m : {}; }
  var st = { phase: meta().pin ? 'syncing' : 'off', linked: !!meta().pin, at: meta().at || null, message: '' };
  function host() { return SB.apiBase ? SB.apiBase() : null; }
  function set(phase, message) {
    var m = meta();
    st = { phase: phase, linked: !!m.pin && !trying, at: m.at || null, message: message || '' };
    listeners.slice().forEach(function (fn) { try { fn(st); } catch (e) { if (window.console) console.error(e); } });
  }
  function fail(code, message) {
    var e = new Error(message || '');
    /** @type {any} */ (e).code = code;
    return e;
  }

  /** One call to api/watchlists -> the sheet's answer { result, rev, savedAt, state } or a rejection with .code. */
  function send(m, body) {
    var b = host();
    if (b == null) return Promise.reject(fail('nohost'));
    var ctl = window.AbortController ? new AbortController() : null;
    var to = setTimeout(function () { if (ctl) ctl.abort(); }, TIMEOUT_MS);
    body.pin = m.pin;
    return fetch(b + 'api/watchlists', {
      method: 'POST', cache: 'no-store', signal: ctl ? ctl.signal : undefined,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body)
    }).then(function (r) {
      clearTimeout(to);
      if ((r.headers.get('content-type') || '').indexOf('json') < 0) {
        throw fail('offline', r.ok || r.status === 404 ? 'this site has no watchlist sync yet' : 'HTTP ' + r.status + ' from the site');
      }
      return r.json();
    }, function (e) {
      clearTimeout(to);
      throw fail('offline', e && e.name === 'AbortError' ? 'the sheet took too long to answer' : 'no internet connection, or the site could not be reached');
    }).then(function (j) {
      if (j && j.ok === true && j.state && Array.isArray(j.state.lists) && typeof j.rev === 'number') return j;
      throw fail((j && j.code) || 'error', (j && (j.message || j.error)) || 'an unexpected answer');
    });
  }

  // remote = the sheet's answer just received, or null (not asked yet). local = this browser's lists
  // when this step started: whatever changes here while the sheet answers are merged in afterwards.
  function step(m, remote, n) {
    var known = m.base && typeof m.rev === 'number' ? { lists: m.base } : null;
    var local = W.state();
    if (!remote) {
      if (known && !M.same(local, known)) {
        // changed here since the last sync: save straight on top of the revision seen then
        return send(m, { op: 'put', base: m.rev, state: M.strip(local) }).then(function (r) { return after(m, r, local, n); });
      }
      return send(m, { op: 'get' }).then(function (r) { return step(m, r, n); });
    }
    var merged = M.merge(known, local, remote.state);
    if (M.same(merged, remote.state)) return finish(m, remote, local);
    if (n >= MAX_TRIES) throw fail('offline', 'the lists kept changing on another device - press Sync now');
    return send(m, { op: 'put', base: remote.rev, state: M.strip(merged) }).then(function (r) { return after(m, r, local, n + 1); });
  }
  function after(m, r, local, n) {
    if (r.result === 'conflict') return step(m, r, n + 1);   // another device saved in between: merge with its lists
    return finish(m, r, local);
  }
  /** The sheet now holds r.state (revision r.rev): this browser takes it, with any change made here meanwhile. */
  function finish(m, r, local) {
    var now = meta();
    if (now.pin !== m.pin) return;                           // disconnected (or a new PIN) while the sheet answered
    now.rev = r.rev;
    now.base = M.strip(r.state).lists;
    now.at = new Date().toISOString();
    ui.store.set(KEY, now);
    var next = M.merge(local, W.state(), r.state);
    W.replace(next);
    if (!M.same(next, r.state)) again = true;                // changed here meanwhile: that goes next
  }
  function failed(used, e) {
    var code = (e && e.code) || 'offline', msg = (e && e.message) || '';
    if (code === 'nohost') { set('nohost'); return; }
    if (code === 'pin' || code === 'nopin' || (code === 'locked' && /^wrong pin/i.test(msg))) {
      var m = meta();
      if (m.pin === used.pin) { delete m.pin; ui.store.set(KEY, m); }   // asked again; the lists and the last sync stay
      set(code === 'nopin' ? 'nopin' : 'pin', msg);
      return;
    }
    if (code === 'locked') { set('locked', msg); return; }
    if (code === 'auth' || code === 'not-configured' || code === 'unknown-action' || code === 'too-big' || code === 'unreadable') { set('error', msg); return; }
    if (!(e && e.code) && window.console) console.error(e);
    set('offline', msg);
  }

  function run() {
    var m = meta();
    if (host() == null) { set('nohost'); return Promise.resolve(); }
    if (!m.pin) { set('off'); return Promise.resolve(); }
    if (busy) { again = true; return busy; }
    clearTimeout(timer);
    lastRun = Date.now();
    again = false;
    set('syncing');
    busy = step(m, null, 0).then(function () { trying = false; set(meta().pin ? 'ok' : 'off'); }, function (e) { trying = false; failed(m, e); }).then(function () {
      busy = null;
      var pin = meta().pin;
      if (again && pin && (st.phase === 'ok' || pin !== m.pin)) return run();   // more changes, or a PIN typed meanwhile
    });
    return busy;
  }

  function connect(pin) {
    var p = String(pin == null ? '' : pin).trim();
    if (!PIN_RE.test(p)) { set('pin', 'The PIN is 6 to 20 letters or digits.'); return Promise.resolve(st); }
    var m = meta();
    m.pin = p;
    ui.store.set(KEY, m);
    trying = true;                                           // shown as "checking the PIN" until the sheet answers
    return run().then(function () { trying = false; return st; });
  }
  function disconnect() {
    clearTimeout(timer);
    trying = false;
    ui.store.del(KEY);                                       // the lists stay in this browser (and in the sheet)
    set(host() == null ? 'nohost' : 'off');
  }

  // a change made here goes to the sheet a moment later (several quick changes go together)
  W.onChange(function (s, origin) {
    if (origin !== 'local' || !meta().pin) return;
    clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  });
  function front() { if (meta().pin && !busy && Date.now() - lastRun > FRONT_MS) run(); }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') front(); });
  window.addEventListener('focus', front);
  window.addEventListener('online', function () { if (meta().pin) run(); });
  // another tab of this site connected / disconnected
  window.addEventListener('storage', function (e) {
    if (e.key !== 'sb:' + KEY || busy) return;
    if (!meta().pin) set(host() == null ? 'nohost' : 'off');
    else if (!st.linked) run();
    else set(st.phase, st.message);
  });
  // first sync once app.js has set SB.apiBase
  setTimeout(function () { run(); }, 300);

  SB.wlSync = {
    status: function () { return !st.linked && st.phase === 'off' && host() == null ? { phase: 'nohost', linked: false, at: null, message: '' } : st; },
    connect: connect,
    disconnect: disconnect,
    syncNow: run,
    onStatus: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; }
  };
})();
