/* Stock Blueprint service worker (owner, 09-Nov-2026: the app on Android / iPhone + phone pop-ups for mitigated FVG zones
   and new results). It only shows pop-ups and opens the app at the right page - it caches nothing, so every visit gets
   the newest website. The pop-ups are encrypted for this device by api/push.js and asked for by the owner's sheet. */
'use strict';

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'Stock Blueprint', body: e.data ? e.data.text() : '' }; }
  var url = typeof d.url === 'string' && /^#[A-Za-z0-9/_-]*$/.test(d.url) ? d.url : '#overview';
  e.waitUntil(self.registration.showNotification(String(d.title || 'Stock Blueprint').slice(0, 140), {
    body: String(d.body || '').slice(0, 600),
    tag: d.tag ? String(d.tag).slice(0, 60) : undefined,
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-96.png',
    data: { url: url }
  }));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var hash = (e.notification.data && e.notification.data.url) || '#overview';
  var target = new URL(self.registration.scope).href.replace(/#.*$/, '') + hash;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.url.indexOf(self.registration.scope) === 0 && 'focus' in c) {
        c.postMessage({ type: 'open', url: hash });
        return c.focus();
      }
    }
    return self.clients.openWindow(target);
  }));
});
