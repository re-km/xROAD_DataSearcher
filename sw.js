const XRDS_SHELL_CACHE = 'xrds-shell-v31';
const XRDS_TILE_CACHE = 'xrds-gsi-tiles-v1';
const XRDS_SHELL_FILES = [
    '/',
    '/index.html',
    '/mobile.html',
    '/static/leaflet/leaflet.css',
    '/static/leaflet/leaflet.js',
    '/static/leaflet/images/marker-icon.png',
    '/static/leaflet/images/marker-shadow.png',
    '/static/map.js?v=31',
    '/static/offline.js?v=2',
    '/static/manifest.webmanifest',
    '/static/manifest-mobile.webmanifest',
    '/static/icon.svg',
];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(XRDS_SHELL_CACHE).then(cache => cache.addAll(XRDS_SHELL_FILES)));
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(caches.keys().then(keys => Promise.all(
        keys.filter(key => key.startsWith('xrds-shell-') && key !== XRDS_SHELL_CACHE)
            .map(key => caches.delete(key))
    )));
    self.clients.claim();
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);

    if (url.hostname === 'cyberjapandata.gsi.go.jp' && /\/xyz\//.test(url.pathname)) {
        event.respondWith(caches.open(XRDS_TILE_CACHE).then(async cache => {
            const cached = await cache.match(request);
            if (cached) return cached;
            try {
                const response = await fetch(request);
                if (response.ok || response.type === 'opaque') await cache.put(request, response.clone());
                return response;
            } catch (error) {
                return cached || Response.error();
            }
        }));
        return;
    }

    if (url.origin !== self.location.origin) return;
    if (request.mode === 'navigate') {
        const fallback = url.pathname === '/mobile.html' ? '/mobile.html' : '/index.html';
        event.respondWith(fetch(request).catch(() => caches.match(fallback)));
        return;
    }
    if (url.pathname.startsWith('/static/')) {
        event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
            if (response.ok) {
                const copy = response.clone();
                caches.open(XRDS_SHELL_CACHE).then(cache => cache.put(request, copy));
            }
            return response;
        })));
    }
});
