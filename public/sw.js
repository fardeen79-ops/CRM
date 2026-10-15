// STRIDE service worker: phone alerts (Web Push) and the app badge. Nothing is cached here, so an
// update of the CRM always loads fresh.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  const work = [self.registration.showNotification(d.title || 'STRIDE', {
    body: d.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    tag: d.tag || undefined,
    data: { url: d.url || '/' },
  })];
  if ('setAppBadge' in self.navigator) work.push((d.badge ? self.navigator.setAppBadge(d.badge) : self.navigator.clearAppBadge()).catch(() => {}));
  e.waitUntil(Promise.all(work));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const w = wins.find((c) => 'focus' in c);
    if (!w) return self.clients.openWindow(url);
    w.postMessage({ type: 'open', url });
    return w.focus();
  }));
});
