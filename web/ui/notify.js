/* The app's bell + phone pop-ups (owner, 09-Nov-2026: "mitigated notifications and results update notification I am
   receiving through mail can be viewed in Notification icon in the app?"; choice: the bell + pop-ups, the emails go on).
   Owner only - with the My Watchlists PIN of this device (SB.wlSync.owner): the header bell #bell shows the sheet's
   App_Notifications (Code2.gs: every Mitigated FVG Log row, the Results Update email's new rows, a finished Backtest Lab
   run), newest first, a dot / count for the unread ones (read up to = localStorage sb:notify:read). The Kite poll's answer
   carries the newest note's time (app.js -> SB.notify.seen), so the list is fetched only when something new came or the
   bell is opened.
   Phone pop-ups: the service worker (sw.js) + the Push API; the key comes from GET api/push (VAPID, derived from the
   site's feed token), the subscription goes to the sheet (op 'push' add) - the sheet then asks api/push to deliver.
   iPhone: only from the app on the Home Screen (iOS 16.4+). SB.notify = { seen(at), open(), refresh(), setup() }. */
(function () {
  'use strict';
  var SB = window.SB, ui = SB.ui, esc = ui.esc, F = ui.F, $ = ui.$;
  var READ = 'notify:read', PUSHED = 'notify:push';
  var items = [], newest = '', devices = 0, loaded = false, loading = null, pop = null;
  var KIND = { mitigated: ['FVG', 's-info'], results: ['Results', 's-good'], lab: ['Backtest', ''], test: ['Test', ''] };

  function btn() { return $('#bell'); }
  function linked() { return !!(SB.wlSync && SB.wlSync.hasPin() && SB.wlSync.status().linked); }
  function readUpTo() { return String(ui.store.get(READ, '') || ''); }
  function unread() {
    var r = readUpTo();
    if (loaded) return items.filter(function (n) { return n.at > r; }).length;
    return newest && newest > r ? 1 : 0;
  }
  function paint() {
    var b = btn();
    if (!b) return;
    b.hidden = !linked();
    var n = unread();
    b.classList.toggle('has-new', n > 0);
    var dot = b.querySelector('.bell-n');
    if (dot) dot.textContent = n > 0 ? (loaded ? (n > 99 ? '99+' : String(n)) : '•') : '';
    b.setAttribute('aria-label', 'Notifications' + (n > 0 ? ' - ' + (loaded ? n : 'new') + ' unread' : ''));
  }

  function refresh() {
    if (!linked()) return Promise.resolve([]);
    if (loading) return loading;
    loading = SB.wlSync.owner({ op: 'notes' }, function (j) { return j.result === 'notes' && Array.isArray(j.items); }).then(function (j) {
      loading = null;
      items = j.items;
      newest = j.newest || (items[0] && items[0].at) || newest;
      devices = j.devices || 0;
      loaded = true;
      paint();
      if (pop) drawPop();
      return items;
    }, function (e) {
      loading = null;
      if (pop) { var l = $('.bell-list', pop); if (l) l.innerHTML = '<p class="note bad">' + esc(e && e.message || 'could not load the notifications') + '</p>'; }
      throw e;
    });
    return loading;
  }

  /** The Kite poll's newest-note time: fetch the list only when it changed. */
  function seen(at) {
    if (!at || at === newest) { paint(); return; }
    newest = at;
    if (loaded || pop) refresh().catch(function () {});
    paint();
  }

  function ago(at) {
    var t = Date.parse(String(at).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(at) ? '' : '+05:30'));
    if (!isFinite(t)) return esc(at);
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return F.dateTime(at);
  }

  function pushState() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      var ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
      var standalone = window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
      return { can: false, why: ios && !standalone ? 'On iPhone: tap Share → Add to Home Screen, open Stock Blueprint from the Home Screen, then turn this on there (iOS 16.4 or newer).'
        : 'This browser cannot show phone notifications.' };
    }
    if (window.Notification.permission === 'denied') return { can: false, why: 'Notifications are blocked for this site - allow them in the browser / phone settings (Site settings → Notifications).' };
    return { can: true, on: !!ui.store.get(PUSHED, '') && window.Notification.permission === 'granted' };
  }

  function drawPop() {
    if (!pop) return;
    var r = readUpTo();
    var ps = pushState();
    var list = !loaded ? ui.skeleton(3) : !items.length ? '<p class="empty">No notifications yet. Mitigated FVG zones, new results in Main and finished backtests appear here.</p>' :
      items.slice(0, 60).map(function (n) {
        var k = KIND[n.kind] || [n.kind, ''];
        return '<a class="bell-item' + (n.at > r ? ' new' : '') + '" href="' + esc(n.url || '#overview') + '">' +
          '<span class="bell-top">' + ui.badge(k[0], k[1]) + '<span class="sub">' + ago(n.at) + '</span></span>' +
          '<b>' + esc(n.title) + '</b>' + (n.body ? '<span class="bell-body">' + esc(n.body).replace(/\n/g, '<br>') + '</span>' : '') + '</a>';
      }).join('');
    pop.innerHTML = '<div class="bell-head"><b>Notifications</b>' + (items.length ? '<button class="btn sm" type="button" data-bell="read">Mark all read</button>' : '') + '</div>' +
      '<div class="bell-list">' + list + '</div>' +
      '<div class="bell-push">' + (ps.can ? (ps.on ? '<span class="badge s-good">Phone pop-ups: on</span> <button class="btn sm" type="button" data-bell="test">Send a test</button> ' +
        '<button class="btn sm" type="button" data-bell="off">Turn off on this device</button>'
        : '<button class="btn sm primary" type="button" data-bell="on">🔔 Turn on phone pop-ups on this device</button>') :
        '<span class="sub">' + esc(ps.why) + '</span>') +
      (devices ? '<span class="sub"> · ' + devices + ' device' + (devices === 1 ? '' : 's') + ' get pop-ups</span>' : '') + '<span class="bell-msg sub" role="status"></span></div>';
  }

  function msg(t, bad) {
    var m = pop && $('.bell-msg', pop);
    if (m) { m.textContent = ' ' + t; m.style.color = bad ? 'var(--down)' : ''; }
  }

  function open() {
    if (pop) { close(); return; }
    pop = document.createElement('div');
    pop.className = 'bell-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Notifications');
    document.body.appendChild(pop);
    var b = btn().getBoundingClientRect();
    pop.style.top = Math.round(b.bottom + 8) + 'px';
    drawPop();
    refresh().catch(function () {});
    pop.addEventListener('click', function (e) {
      var a = e.target.closest('[data-bell]');
      if (a) { e.preventDefault(); act(a.getAttribute('data-bell')); return; }
      if (e.target.closest('.bell-item')) { markRead(); close(); }
    });
    setTimeout(function () { document.addEventListener('click', outside, true); document.addEventListener('keydown', esc1); }, 0);
  }
  function outside(e) { if (pop && !pop.contains(e.target) && !btn().contains(e.target)) close(); }
  function esc1(e) { if (e.key === 'Escape') close(); }
  function close() {
    if (!pop) return;
    pop.remove();
    pop = null;
    document.removeEventListener('click', outside, true);
    document.removeEventListener('keydown', esc1);
  }
  function markRead() {
    var top = items[0] ? items[0].at : newest;
    if (top) ui.store.set(READ, top);
    paint();
    drawPop();
  }

  // ---------- phone pop-ups
  function b64ToBytes(s) {
    var p = '='.repeat((4 - s.length % 4) % 4), b = window.atob((s + p).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
    return out;
  }
  function bytesToB64(buf) {
    var b = new Uint8Array(buf), s = '';
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return window.btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function serverKey() {
    var base = SB.apiBase ? SB.apiBase() : null;
    if (base == null) return Promise.reject(new Error('this site has no server for pop-ups'));
    return fetch(base + 'api/push', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.ok || !j.publicKey) throw new Error((j && j.message) || 'the site\'s push sender is not set up');
      return j.publicKey;
    });
  }
  function label() {
    var u = navigator.userAgent;
    return /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android' : /Windows/.test(u) ? 'Windows' : /Mac/.test(u) ? 'Mac' : 'Browser';
  }
  /** Subscribes this device (again when the site's key changed) and tells the sheet. */
  function subscribe(quiet) {
    return navigator.serviceWorker.ready.then(function (reg) {
      return serverKey().then(function (key) {
        return reg.pushManager.getSubscription().then(function (cur) {
          if (cur && cur.options && cur.options.applicationServerKey && bytesToB64(cur.options.applicationServerKey) === key) return cur;
          return (cur ? cur.unsubscribe() : Promise.resolve()).then(function () {
            return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
          });
        });
      });
    }).then(function (sub) {
      var j = sub.toJSON();
      return SB.wlSync.owner({ op: 'push', push: { do: 'add', sub: { endpoint: j.endpoint, keys: j.keys }, label: label() } },
        function (a) { return a.result === 'push'; }).then(function (a) {
        ui.store.set(PUSHED, j.endpoint);
        devices = a.devices || devices;
        if (!quiet) msg('On - you will get pop-ups on this device.');
        drawPop();
      });
    });
  }
  function act(what) {
    if (what === 'read') { markRead(); return; }
    if (what === 'on') {
      msg('Asking for permission…');
      window.Notification.requestPermission().then(function (p) {
        if (p !== 'granted') { msg('Not allowed - notifications stay off.', true); drawPop(); return; }
        return subscribe(false);
      }).catch(function (e) { msg(e && e.message || 'could not turn them on', true); });
    } else if (what === 'test') {
      msg('Sending…');
      SB.wlSync.owner({ op: 'push', push: { do: 'test' } }, function (a) { return a.result === 'push'; }).then(function (a) {
        msg(a.sent ? 'Sent - it pops up in a few seconds.' : 'Sent to no device' + (a.error ? ': ' + a.error : '') + '.', !a.sent);
      }, function (e) { msg(e && e.message || 'could not send', true); });
    } else if (what === 'off') {
      var ep = ui.store.get(PUSHED, '');
      navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (s) { return s && s.unsubscribe(); })
        .catch(function () {}).then(function () {
          ui.store.set(PUSHED, '');
          return ep ? SB.wlSync.owner({ op: 'push', push: { do: 'remove', endpoint: ep } }, function (a) { return a.result === 'push'; }) : null;
        }).then(function (a) { if (a) devices = a.devices; msg('Off on this device.'); drawPop(); }, function () { drawPop(); });
    }
  }

  /** At start: the service worker (also what makes the site an installable app), the bell, a key change re-subscribes. */
  function setup() {
    var b = btn();
    if (b) b.addEventListener('click', function (e) { e.preventDefault(); open(); });
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(function () {});
      navigator.serviceWorker.addEventListener('message', function (e) {
        if (e.data && e.data.type === 'open' && typeof e.data.url === 'string' && /^#[A-Za-z0-9/_-]*$/.test(e.data.url)) location.hash = e.data.url;
      });
    }
    paint();
    if (SB.wlSync && SB.wlSync.onStatus) SB.wlSync.onStatus(function () { paint(); });
    // a device that had pop-ups on: keep its subscription in step (a new site key, a new phone address)
    setTimeout(function () {
      if (linked() && ui.store.get(PUSHED, '') && window.Notification && window.Notification.permission === 'granted' && 'serviceWorker' in navigator) subscribe(true).catch(function () {});
    }, 4000);
  }

  SB.notify = { seen: seen, open: open, refresh: refresh, setup: setup, paint: paint };
})();
