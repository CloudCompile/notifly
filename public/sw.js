const CACHE_NAME = 'notifly-v1';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// Install — cache app shell
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)),
  );
});

// Activate — delete old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

// Fetch — shell-first, network-fallback for API
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API routes: network only
  if (url.pathname.startsWith('/api/')) return;

  // GitHub / Pollinations: network only
  if (url.hostname !== self.location.hostname) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        if (res.ok && event.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));
        }
        return res;
      });
    }),
  );
});

// Push event — show native notification
self.addEventListener('push', (event) => {
  let data = { title: 'Notifly', body: 'You have a new digest ready', url: '/digest', icon: '/icons/icon-192.png' };
  try { data = { ...data, ...event.data.json() }; } catch { /* use defaults */ }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body:    data.body,
      icon:    data.icon,
      badge:   '/icons/icon-32.png',
      tag:     'notifly-digest',
      renotify: true,
      data:    { url: data.url },
    }),
  );
});

// Notification click — open/focus the digest page
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/digest';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (new URL(client.url).pathname === url && 'focus' in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
