// Service Worker for SRS暗記アプリ
// Strategy: stale-while-revalidate for static assets, network-only for dynamic data

const CACHE_NAME = 'srs-app-v1';

const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './cards.json',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// Paths that must always go to the network (no caching)
const NETWORK_ONLY_PATTERNS = [
  /\/imported_sources\.json($|\?)/,
  /\/today\.json($|\?)/,
  /\/proposals\//
];

function isNetworkOnly(url) {
  return NETWORK_ONLY_PATTERNS.some((re) => re.test(url));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // addAll is atomic — if any fail, install fails. Use individual adds to be resilient.
      return Promise.all(
        STATIC_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[sw] precache failed for', url, err);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle GET
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Same-origin only
  if (url.origin !== self.location.origin) return;

  // Network-only for dynamic files
  if (isNetworkOnly(url.pathname)) {
    event.respondWith(fetch(req));
    return;
  }

  // Stale-while-revalidate for everything else
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(req);
      const networkFetch = fetch(req)
        .then((response) => {
          // Only cache successful, basic (same-origin) responses
          if (response && response.status === 200 && response.type === 'basic') {
            cache.put(req, response.clone()).catch(() => {});
          }
          return response;
        })
        .catch(() => cached);

      return cached || networkFetch;
    })
  );
});
