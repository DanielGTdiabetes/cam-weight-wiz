// Se sustituye en build por install-all.sh
const CACHE_VERSION = "cwz-0.0.1-6e27b46";
const STATIC_CACHE = `bascula-static-${CACHE_VERSION}`;
const PRECACHE_ASSETS = [
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/favicon.ico',
  '/robots.txt',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_ASSETS))
      .catch((error) => {
        console.error('[SW] Failed to precache assets', error);
      })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.map((k) => {
          if (k !== STATIC_CACHE) return caches.delete(k);
        })
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) {
    return;
  }

  const isConfigPath = url.pathname === '/config' || url.pathname.startsWith('/config/');

  if (request.mode === 'navigate') {
    const fetchOptions = { cache: 'no-store' };
    if (isConfigPath) {
      fetchOptions.headers = { 'Cache-Control': 'no-store' };
    }
    event.respondWith(
      fetch(request, fetchOptions).catch(() =>
        new Response('<h1>Offline</h1>', {
          status: 503,
          headers: { 'Content-Type': 'text/html' },
        })
      )
    );
    return;
  }

  if (isConfigPath) {
    event.respondWith(
      fetch(request, { cache: 'no-store', headers: { 'Cache-Control': 'no-store' } }).catch(() =>
        new Response('Servicio de configuración no disponible sin conexión', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' },
        })
      )
    );
    return;
  }

  const shouldCache =
    url.origin === self.location.origin &&
    /\.(?:css|js|png|jpe?g|gif|svg|webp|ico|woff2?|ttf)$/i.test(url.pathname);

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (shouldCache && response.ok) {
          const clone = response.clone();
          void caches.open(STATIC_CACHE).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(async () => {
        const cache = await caches.open(STATIC_CACHE);
        const cachedResponse = await cache.match(request);
        if (cachedResponse) {
          return cachedResponse;
        }
        return Response.error();
      })
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (event.data?.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
    );
  }
});
