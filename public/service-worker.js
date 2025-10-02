const VERSION = '2.0.0';
const CACHE_NAME = 'bascula-v2';
const STATIC_CACHE = 'bascula-static-v2';
const DYNAMIC_CACHE = 'bascula-dynamic-v2';
const RECOVERY_CACHE = 'bascula-recovery';

// Assets to cache on install
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
  console.log('[SW] Installing service worker version:', VERSION);
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => {
        console.log('[SW] Caching static assets');
        return cache.addAll(STATIC_ASSETS);
      })
      .catch((err) => {
        console.error('[SW] Failed to cache assets during install:', err);
        // Store failure flag in recovery cache
        return caches.open(RECOVERY_CACHE).then((cache) => {
          return cache.put(
            new Request('/recovery-flag'),
            new Response(JSON.stringify({ 
              failed: true, 
              error: err.message,
              timestamp: Date.now(),
              version: VERSION
            }))
          );
        }).then(() => {
          // Notify all clients of the failure
          self.clients.matchAll().then((clients) => {
            clients.forEach((client) => {
              client.postMessage({
                type: 'UPDATE_FAILED',
                error: err.message,
                version: VERSION
              });
            });
          });
          throw err;
        });
      })
  );
  self.skipWaiting();
});

// Activate event - clean old caches
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating service worker version:', VERSION);
  event.waitUntil(
    Promise.all([
      // Clean old caches
      caches.keys().then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            if (![STATIC_CACHE, DYNAMIC_CACHE, RECOVERY_CACHE].includes(cacheName)) {
              console.log('[SW] Deleting old cache:', cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      }),
      // Clear recovery flag on successful activation
      caches.open(RECOVERY_CACHE).then((cache) => {
        return cache.delete(new Request('/recovery-flag'));
      })
    ]).then(() => {
      console.log('[SW] Activation successful, version:', VERSION);
      // Notify all clients that update succeeded
      return self.clients.matchAll().then((clients) => {
        clients.forEach((client) => {
          client.postMessage({
            type: 'UPDATE_SUCCESS',
            version: VERSION
          });
        });
      });
    })
  );
  return self.clients.claim();
});

// Fetch event - stale-while-revalidate strategy
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Skip API and WebSocket requests
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      // Return cached response if available
      if (cachedResponse) {
        // Update cache in background
        fetch(request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              caches.open(DYNAMIC_CACHE).then((cache) => {
                cache.put(request, networkResponse.clone());
              });
            }
          })
          .catch(() => {
            // Network failed, cached version is already returned
          });
        
        return cachedResponse;
      }

      // No cache, fetch from network
      return fetch(request)
        .then((networkResponse) => {
          // Cache successful responses
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
          // Return offline page if available
          return caches.match('/index.html');
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
      caches.keys().then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => caches.delete(cacheName))
        );
      })
    );
  }
});
