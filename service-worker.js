/* Quest Log service worker
 * Network-first for app shell so deploys propagate instantly.
 * Cache acts as offline fallback only.
 */
const VERSION = 'v3-2026-04-23-merge-refresh';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon.svg'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // GitHub API — always network (never cache)
  if (url.hostname === 'api.github.com') return;

  // Same-origin (app shell): network-first, cache as fallback
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(VERSION).then(c => c.put(e.request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Cross-origin (fonts, CDN): cache-first, network fallback
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
