var CACHE_VERSION = 'aura-v4';

self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        names.filter(function(name) { return name !== CACHE_VERSION; })
          .map(function(name) { return caches.delete(name); })
      );
    }).then(function() { return clients.claim(); })
  );
});

self.addEventListener('push', function(event) {
  var data = { title: 'Aura', body: 'You have a new update.' };
  if (event.data) {
    try { data = event.data.json(); } catch (e) {}
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: data
    })
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url.indexOf('dashboard.html') !== -1 && 'focus' in list[i]) {
          return list[i].focus();
        }
      }
      return clients.openWindow('/dashboard.html');
    })
  );
});
