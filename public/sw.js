/* O2D — phone ki ghanti. Sirf notification dikhata hai; app ki koi file cache nahi karta (speed pe asar nahi). */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (e) {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { title: 'O2D', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Kaam late hai!', {
    body: d.body || 'App kholo',
    tag: 'o2d-ghanti',
    renotify: true,              // har baar dobara ghanti
    requireInteraction: true,    // tap kiye bina nahi hatega
    silent: false,
    vibrate: d.red ? [900, 200, 900, 200, 900, 200, 900] : [500, 200, 500],
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    timestamp: d.at || Date.now(),
    data: { url: d.url || '/' }
  }));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (const c of list) {
      if (c.url.indexOf(self.location.origin) === 0 && 'focus' in c) {
        return c.focus().then(function (w) { return w && w.navigate ? w.navigate(url) : w; });
      }
    }
    return self.clients.openWindow(url);
  }));
});
