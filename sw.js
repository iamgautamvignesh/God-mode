// Bump this version string whenever you want to force everyone's app to pick
// up a fresh copy of the cached files (index.html itself is always fetched
// network-first anyway, so most updates need no version bump at all — see
// below). index.html already calls reg.update() on every app open and
// reloads once automatically when a new service worker takes over, so a
// bump here is enough to roll out a new release.
const CACHE_VERSION = 'v2';
const CACHE_NAME = `chakra-tracker-${CACHE_VERSION}`;

// Only same-origin "app shell" files — never cache Firebase/Cloudinary/CDN
// responses here, they're handled by their own SDKs/URLs at request time.
const APP_SHELL = [
    './',
    './index.html',
    './manifest.json',
    './icon-72.png',
    './icon-96.png',
    './icon-128.png',
    './icon-144.png',
    './icon-152.png',
    './icon-192.png',
    './icon-384.png',
    './icon-512.png',
    './icon-192-maskable.png',
    './icon-512-maskable.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;

    // Only handle same-origin GET requests. Everything else (Firebase,
    // Cloudinary, Google Fonts, cdnjs, POST/PUT calls, etc.) goes straight to
    // the network untouched — trying to cache those causes more problems
    // (stale data, CORS opaque-response bloat) than it solves.
    if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
        return;
    }

    // Network-first for the app shell HTML itself, so a fresh deploy is
    // picked up immediately when online; fall back to the cached copy when
    // offline. Everything else (icons, manifest) is cache-first for speed,
    // with a network fallback + cache refresh.
    if (req.mode === 'navigate' || req.url.endsWith('/index.html') || req.url.endsWith('/')) {
        event.respondWith(
            fetch(req)
                .then((res) => {
                    const copy = res.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
                    return res;
                })
                .catch(() => caches.match(req).then((res) => res || caches.match('./index.html')))
        );
        return;
    }

    event.respondWith(
        caches.match(req).then((cached) => {
            const networkFetch = fetch(req).then((res) => {
                if (res && res.ok) {
                    const copy = res.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
                }
                return res;
            }).catch(() => cached);
            return cached || networkFetch;
        })
    );
});

// Lets a tapped push/local notification (see reg.showNotification in
// index.html) bring an already-open tab to the front, or open a new one.
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if ('focus' in client) return client.focus();
            }
            if (self.clients.openWindow) return self.clients.openWindow('./index.html');
        })
    );
});
