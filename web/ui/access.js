/* The website only for the persons the owner added (owner, 28-Nov-2026: "I don't want this website public now. i want
   to give access to only authorized persons" - an access code per person, up to 3 devices each).
   SB.access: before any data the page asks api/access whether this website wants a code ('hello'); a device signs in
   once with its code ('login' - the sheet's tab 'Website Access' decides), then keeps a signed session + the content key
   `k` that every data api wants in its URL (SB.access.url). While the page is open the session is renewed every
   RENEW_MS (the owner unticking Active / resetting the devices / a new code closes it within minutes); the sheet not
   answering is not a sign-out (the key works its 6-12 hours). Kept in localStorage 'sb:access' {token, k, ks, until,
   name, at}; the device's own id in 'sb:access:dev' (kept after a sign-out - the same device). */
(function () {
  'use strict';
  var SB = window.SB = window.SB || {};

  var KEY = 'sb:access', DEV_KEY = 'sb:access:dev', MSG_KEY = 'sb:access:msg';
  var RENEW_MS = 10 * 60 * 1000;
  var CODE_RE = /^[A-Za-z0-9]{6,20}$/;
  var base = null, st = read(), renewing = null, timer = null, open = false;

  function read() {
    try {
      var o = JSON.parse(window.localStorage.getItem(KEY) || 'null');
      return o && typeof o === 'object' && typeof o.token === 'string' ? o : null;
    } catch (e) { return null; }
  }
  function save(o) {
    st = o;
    try {
      if (o) window.localStorage.setItem(KEY, JSON.stringify(o)); else window.localStorage.removeItem(KEY);
    } catch (e) { /* private window: this visit only */ }
  }
  function devId() {
    var d = null;
    try { d = window.localStorage.getItem(DEV_KEY); } catch (e) { d = null; }
    if (d && /^[A-Za-z0-9_-]{16,64}$/.test(d)) return d;
    var b = new Uint8Array(18), s = '';
    (window.crypto || window.msCrypto).getRandomValues(b);
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    d = window.btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    try { window.localStorage.setItem(DEV_KEY, d); } catch (e) { /* this visit only */ }
    return d;
  }
  function label() {
    var u = navigator.userAgent || '';
    var dev = /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? (/Mobile/.test(u) ? 'Android phone' : 'Android tablet')
      : /Windows/.test(u) ? 'Windows' : /Mac/.test(u) ? 'Mac' : /Linux/.test(u) ? 'Linux' : 'a device';
    var br = /Edg\//.test(u) ? 'Edge' : /Firefox\//.test(u) ? 'Firefox' : /Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : '';
    return (dev + (br ? ' ' + br : '')).slice(0, 40);
  }
  function keyValid() { return !!(st && st.k && Date.now() < (Number(st.until) || 0) - 60000); }

  /** api/access -> its JSON; a site without api/access (404 / not JSON) = open; no internet -> {ok:false, code:'later'} */
  function post(body) {
    var ctl = window.AbortController ? new AbortController() : null;
    var to = setTimeout(function () { if (ctl) ctl.abort(); }, 25000);
    return fetch(base + 'api/access', {
      method: 'POST', cache: 'no-store', signal: ctl ? ctl.signal : undefined,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body)
    }).then(function (r) {
      clearTimeout(to);
      if ((r.headers.get('content-type') || '').indexOf('json') < 0) return r.status === 404 ? { ok: true, open: true } : { ok: false, code: 'later', retry: true };
      return r.json();
    }, function () {
      clearTimeout(to);
      return { ok: false, code: 'later', retry: true, message: 'No internet connection, or the website could not be reached - try again.' };
    });
  }
  function granted(j) {
    save({ token: j.token, k: j.k, ks: j.ks, until: j.until, name: String(j.name || ''), at: Date.now() });
  }

  /** This device is no longer allowed: forget the session and show the sign-in screen with the reason. */
  function lose(msg) {
    save(null);
    try { window.sessionStorage.setItem(MSG_KEY, String(msg || '')); } catch (e) { /* ignore */ }
    window.location.reload();
  }

  /** Asks the sheet (through api/access) whether this device may go on. -> Promise<boolean> (true = go on). */
  function renew(force) {
    if (open || base == null) return Promise.resolve(true);
    if (!st || !st.token) return Promise.resolve(false);
    if (renewing) return renewing;
    if (!force && st.at && Date.now() - st.at < RENEW_MS && keyValid()) return Promise.resolve(true);
    renewing = post({ op: 'renew', token: st.token }).then(function (j) {
      renewing = null;
      if (j && j.ok && j.open) { open = true; return true; }
      if (j && j.ok && j.token && j.k) { granted(j); paintWho(); return true; }
      if (j && j.retry) return keyValid();           // the sheet did not answer: the key still works its hours
      lose(j && j.message);
      return false;
    });
    return renewing;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }

  /** The sign-in screen in #app; resolves once a code got through. */
  function gate(msg) {
    document.body.classList.add('sb-locked');
    var app = document.getElementById('app');
    app.innerHTML = '<section class="card acc-gate" id="acc-gate"><div class="acc-lock" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
      'stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2.2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg></div>' +
      '<h2>Stock Blueprint is private</h2>' +
      '<p class="sub">Type the access code you received from the owner. You type it once on this device - each code works on ' +
      'up to 3 devices.</p>' +
      '<form id="acc-form" class="acc-form" autocomplete="off"><label class="sr-only" for="acc-code">Access code</label>' +
      '<input id="acc-code" class="acc-code" type="text" inputmode="text" autocapitalize="characters" spellcheck="false" ' +
      'maxlength="20" placeholder="Access code" aria-describedby="acc-msg">' +
      '<button class="btn primary" type="submit" id="acc-go">Open</button></form>' +
      '<p id="acc-msg" class="acc-msg" role="alert"' + (msg ? '' : ' hidden') + '>' + esc(msg) + '</p></section>';
    var form = document.getElementById('acc-form'), input = document.getElementById('acc-code');
    var out = document.getElementById('acc-msg'), go = document.getElementById('acc-go');
    try { input.focus(); } catch (e) { /* ignore */ }
    return new Promise(function (resolve) {
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var code = String(input.value || '').replace(/\s+/g, '');
        var say = function (t) { out.textContent = t; out.hidden = !t; };
        if (!CODE_RE.test(code)) { say('An access code is 6 to 20 letters or digits.'); return; }
        go.disabled = true;
        say('');
        go.textContent = 'Checking…';
        post({ op: 'login', code: code, dev: devId(), label: label() }).then(function (j) {
          go.disabled = false;
          go.textContent = 'Open';
          if (j && j.ok && j.open) { open = true; done(); return; }
          if (j && j.ok && j.token && j.k) { granted(j); done(); return; }
          say((j && j.message) || 'The code could not be checked - try again.');
        });
        function done() {
          document.body.classList.remove('sb-locked');
          resolve(true);
        }
      });
    });
  }

  /** The sheet could not say whether this device may go on (its key ran out meanwhile): try again. */
  function later() {
    document.body.classList.add('sb-locked');
    document.getElementById('app').innerHTML = '<section class="card acc-gate" id="acc-later"><h2>Checking your sign-in…</h2>' +
      '<p class="sub">The website could not reach its sheet just now to check this device. Your sign-in is kept.</p>' +
      '<button class="btn primary" type="button" id="acc-retry">Try again</button></section>';
    return new Promise(function (resolve) {
      document.getElementById('acc-retry').addEventListener('click', function () {
        renew(true).then(function (ok) {
          if (ok) { document.body.classList.remove('sb-locked'); resolve(true); }
        });
      });
    });
  }

  /** "Signed in as X · Sign out" in the footer. */
  function paintWho() {
    var el = document.getElementById('acc-who');
    if (!el) return;
    if (!st || open) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = 'Signed in as <b>' + esc(st.name || 'you') + '</b> · <button type="button" class="linklike" id="acc-out">Sign out of this device</button>';
  }

  function signOut() {
    var t = st && st.token;
    var done = function () { save(null); window.location.reload(); };
    if (!t || base == null) { done(); return; }
    post({ op: 'logout', token: t }).then(done, done);
  }

  /** Before any data: resolves when this device may read the website's data (asks for the code when needed). */
  function ready(apiBase) {
    base = apiBase;
    if (base == null) return Promise.resolve({ open: true });                  // a local copy: nothing to ask
    var msg = '';
    try { msg = window.sessionStorage.getItem(MSG_KEY) || ''; window.sessionStorage.removeItem(MSG_KEY); } catch (e) { msg = ''; }
    var started = function () {
      if (open) return { open: true };
      paintWho();
      if (!timer) {
        timer = window.setInterval(function () { renew(false); }, RENEW_MS);
        document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') renew(false); });
      }
      return { open: false, name: st && st.name };
    };
    if (st && st.token) {
      if (keyValid()) {
        renew(false);                                     // in the background: the page opens at once
        return Promise.resolve(started());
      }
      return renew(true).then(function (ok) {
        if (ok) return started();
        return (st ? later() : gate(msg)).then(started);       // st kept = the sheet did not answer (not a sign-out)
      });
    }
    return post({ op: 'hello' }).then(function (j) {
      if (j && j.ok && j.open) { open = true; return started(); }
      return gate(msg).then(started);
    });
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (t && t.id === 'acc-out') signOut();
  });

  SB.access = {
    ready: ready,
    renew: renew,
    signOut: signOut,
    /** the content key for the data apis ('' = none) */
    k: function () { return st && st.k ? st.k : ''; },
    /** `path` with this device's content key (?k=...) */
    url: function (path) {
      var k = st && st.k && !open ? st.k : '';
      return k ? path + (path.indexOf('?') >= 0 ? '&' : '?') + 'k=' + encodeURIComponent(k) : path;
    },
    /** a data api said 401 'access': renew now -> true when a new key came */
    denied: function () { return renew(true); },
    name: function () { return st && st.name || ''; },
    isOpen: function () { return open; }
  };
})();
