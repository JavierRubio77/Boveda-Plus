const CACHE = 'boveda-v5';
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg', '/plantillas/Plantilla-importacion-Boveda-Plus.xlsx'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const requestUrl = new URL(event.request.url);
  const isDocument = requestUrl.origin === self.location.origin && ['/', '/index.html', '/sw.js'].includes(requestUrl.pathname);
  if (isDocument) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).then((response) => {
        if (response.ok) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
        return response;
      }).catch(() => caches.match(event.request)),
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok && new URL(event.request.url).origin === self.location.origin) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      });
    }),
  );
});
