// Service worker: caches the app shell so SafeLink still opens (heuristic
// checking works fully offline) without a network connection. Firebase
// calls (getBlocklist/reportUrl) still require network — those simply
// fail gracefully via app.js's try/catch when offline.

const CACHE_NAME = 'safelink-shell-v1';
const APP_SHELL = [
  'index.html',
  'app.js',
  'heuristics.js',
  'firebase-config.js',
  'style.css',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// Cache-first for same-origin app-shell requests; everything else (Firebase
// CDN scripts, callable requests) goes straight to the network — those are
// either already cached by the browser's HTTP cache or must be fresh.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached);
    })
  );
});
