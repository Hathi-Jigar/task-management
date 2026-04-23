/* Quest Log service worker — simple app-shell cache */
const VERSION = 'v1-2026-04-23';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon.svg'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never cache GitHub API — always network
  if (url.hostname === 'api.github.com') return;
  // Cache-first for shell, network for the rest
  if (SHELL.some(p => e.request.url.endsWith(p.replace('./', '')))) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(e.request, copy));
        return res;
      }))
    );
    return;
  }
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
