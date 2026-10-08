// ======================================================
// Paseta · Service Worker (PWA)
// ======================================================
// - La carcasa de la app se precarga (offline total).
// - Los .vrm (20-30 MB) NO se precargan: se cachean bajo
//   demanda la primera vez que se usa cada avatar.
// - La API del backend y el chat nunca se cachean.
// - Sube CACHE_VERSION para forzar actualización.

const CACHE_VERSION = 'paseta-v1';

const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const MODELS_CACHE = `${CACHE_VERSION}-models`;
const FONTS_CACHE = `${CACHE_VERSION}-fonts`;

const APP_SHELL = [
    '/',
    '/index.html',
    '/manifest.webmanifest',
    '/icons/icon-192.png',
    '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {

    event.waitUntil(
        caches.open(SHELL_CACHE)
            .then((cache) => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting())
            .catch((err) => console.error('[SW] precarga fallida:', err))
    );
});

self.addEventListener('activate', (event) => {

    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys
                    .filter((k) => !k.startsWith(CACHE_VERSION))
                    .map((k) => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('message', (event) => {

    if (event.data === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

function networkFirst(request) {

    return fetch(request)
        .then((res) => {

            if (res && res.ok) {
                const copy = res.clone();
                caches.open(SHELL_CACHE).then((c) => c.put(request, copy));
            }

            return res;
        })
        .catch(() => caches.match(request)
            .then((hit) => hit || caches.match('/index.html')));
}

function cacheFirst(request, cacheName) {

    return caches.match(request)
        .then((hit) => {

            if (hit) {
                return hit;
            }

            return fetch(request).then((res) => {

                // Solo se guardan respuestas completas y válidas
                // (los rangos parciales no se pueden cachear).
                if (
                    res &&
                    res.ok &&
                    !res.headers.get('content-range')
                ) {
                    const copy = res.clone();
                    caches.open(cacheName)
                        .then((c) => c.put(request, copy))
                        .catch(() => { /* cuota llena: seguir sin caché */ });
                }

                return res;
            });
        });
}

function staleWhileRevalidate(request, cacheName) {

    return caches.match(request).then((hit) => {

        const network = fetch(request).then((res) => {

            if (res && res.ok) {
                const copy = res.clone();
                caches.open(cacheName).then((c) => c.put(request, copy));
            }

            return res;
        }).catch(() => hit);

        return hit || network;
    });
}

self.addEventListener('fetch', (event) => {

    const { request } = event;

    if (request.method !== 'GET') {
        return;
    }

    let url;

    try {
        url = new URL(request.url);
    } catch {
        return;
    }

    // Backend (puerto 3001) y resto de orígenes de datos:
    // siempre red, nunca caché.
    if (url.origin !== self.location.origin) {

        // Excepción: fuentes de Google (solo lectura y
        // versionadas) para que la tipografía aguante offline.
        if (
            url.hostname === 'fonts.googleapis.com' ||
            url.hostname === 'fonts.gstatic.com'
        ) {
            event.respondWith(staleWhileRevalidate(request, FONTS_CACHE));
        }

        return;
    }

    // Navegación: red primero, la app como reserva offline.
    if (request.mode === 'navigate') {
        event.respondWith(networkFirst(request));
        return;
    }

    // Avatares .vrm: caché bajo demanda (no precarga).
    if (url.pathname.startsWith('/models/')) {
        event.respondWith(cacheFirst(request, MODELS_CACHE));
        return;
    }

    // Resto de estáticos propios: JS/CSS/imagenes/manifiesto.
    if (
        url.pathname.startsWith('/assets/') ||
        url.pathname.startsWith('/icons/') ||
        url.pathname.startsWith('/images/') ||
        /\.(js|css|png|jpg|jpeg|webp|svg|ico|webmanifest)$/i.test(url.pathname)
    ) {
        event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
        return;
    }

    // Cualquier otro GET propio: red primero, reserva en caché.
    event.respondWith(networkFirst(request));
});
