// HandicapAI Service Worker — Push Notifications
const CACHE_NAME = 'handicapai-v1';

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

// Handle push notifications
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data.json(); } catch(err) {
    data = { title: '🏆 HandicapAI', body: e.data?.text() || 'New picks available!' };
  }

  const options = {
    body: data.body || 'New picks available!',
    icon: '/icon-192.png',
    badge: '/icon-72.png',
    vibrate: [200, 100, 200],
    tag: 'handicapai-notification',
    renotify: true,
    requireInteraction: true,
    data: { url: data.data?.url || '/' },
    actions: [
      { action: 'view', title: '👀 View Picks' },
      { action: 'dismiss', title: 'Dismiss' }
    ]
  };

  e.waitUntil(
    self.registration.showNotification(data.title || '🏆 HandicapAI', options)
  );
});

// Handle notification click
self.addEventListener('notificationclick', e => {
  e.notification.close();

  if (e.action === 'dismiss') return;

  const url = e.notification.data?.url || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // If app is already open, focus it
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open new window
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});
