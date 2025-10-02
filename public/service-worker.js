const CACHE_VERSION = 'v2025.03.01';
const STATIC_CACHE = `bascula-static-${CACHE_VERSION}`;
const DYNAMIC_CACHE = `bascula-dynamic-${CACHE_VERSION}`;
const RECOVERY_CACHE = `bascula-recovery-${CACHE_VERSION}`;
const KNOWN_CACHES = [STATIC_CACHE, DYNAMIC_CACHE, RECOVERY_CACHE];

// Assets to cache on install (excluding index.html to avoid stale caches)
const STATIC_ASSETS = [
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/favicon.ico',
  '/robots.txt',
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
  console.log('[SW] Installing service worker version:', CACHE_VERSION);
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => {
        console.log('[SW] Caching static assets');
        return cache.addAll(STATIC_ASSETS);
      })
      .catch((err) => {
        console.error('[SW] Failed to cache assets during install:', err);
        return caches.open(RECOVERY_CACHE).then((cache) =>
          cache
            .put(
              new Request('/recovery-flag'),
              new Response(
                JSON.stringify({
                  failed: true,
                  error: err.message,
                  timestamp: Date.now(),
                  version: CACHE_VERSION,
                })
              )
            )
            .then(() => {
              self.clients.matchAll().then((clients) => {
                clients.forEach((client) => {
                  client.postMessage({
                    type: 'UPDATE_FAILED',
                    error: err.message,
                    version: CACHE_VERSION,
                  });
                });
              });
              throw err;
            })
        );
      })
  );
  self.skipWaiting();
});

// Activate event - clean old caches
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating service worker version:', CACHE_VERSION);
  event.waitUntil(
    Promise.all([
      caches.keys().then((cacheNames) =>
        Promise.all(
          cacheNames.map((cacheName) => {
            if (!KNOWN_CACHES.includes(cacheName)) {
              console.log('[SW] Deleting old cache:', cacheName);
              return caches.delete(cacheName);
            }
            return undefined;
          })
        )
      ),
      caches.open(RECOVERY_CACHE).then((cache) => cache.delete(new Request('/recovery-flag'))),
    ]).then(() =>
      self.clients.matchAll().then((clients) => {
        clients.forEach((client) => {
          client.postMessage({
            type: 'UPDATE_SUCCESS',
            version: CACHE_VERSION,
          });
        });
      })
    )
  );
  return self.clients.claim();
});

// Fetch event - stale-while-revalidate strategy with HTML bypass
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') {
    return;
  }

  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) {
    return;
  }

  const acceptHeader = request.headers.get('accept') || '';
  const isHTMLRequest = request.mode === 'navigate' || acceptHeader.includes('text/html');

  if (isHTMLRequest) {
    event.respondWith(
      fetch(request, { cache: 'no-store' }).catch(() =>
        new Response('<h1>Offline</h1>', {
          status: 503,
          headers: { 'Content-Type': 'text/html' },
        })
      )
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        event.waitUntil(
          fetch(request)
            .then((networkResponse) => {
              if (networkResponse && networkResponse.status === 200) {
                return caches.open(DYNAMIC_CACHE).then((cache) => {
                  return cache.put(request, networkResponse.clone());
                });
              }
              return undefined;
            })
            .catch(() => undefined)
        );
        return cachedResponse;
      }

      return fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(DYNAMIC_CACHE).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return networkResponse;
        })
        .catch((error) => {
          console.error('[SW] Fetch failed:', error);
          return caches.match(request).then((fallback) => fallback || Response.error());
        });
    })
  );
});

// Message event - allow clients to control the service worker
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (event.data && event.data.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys().then((cacheNames) => Promise.all(cacheNames.map((cacheName) => caches.delete(cacheName))))
    );
  }
});
