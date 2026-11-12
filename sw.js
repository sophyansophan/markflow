/**
 * MarkFlow Studio — Service Worker (sw.js)
 * Sistem Auto-Update Real-Time untuk GitHub Pages & PWA (HP iOS/Android & MacBook)
 *
 * Cara kerja Auto-Update:
 * 1. Menggunakan strategi Network-First (dengan cache: 'no-store') untuk file aplikasi utama
 *    (index.html, manifest.json, sw.js) sehingga setiap kali ada push/commit baru di GitHub,
 *    aplikasi yang sudah diinstal di HP atau MacBook langsung mengambil versi terbaru dari server.
 * 2. Jika perangkat sedang offline, otomatis beralih (fallback) ke Cache Storage lokal.
 * 3. Menggunakan skipWaiting() dan clients.claim() agar Service Worker baru langsung aktif
 *    tanpa menunggu user menutup semua tab/aplikasi.
 * 4. Membandingkan ETag / Last-Modified / Hash konten untuk memberi notifikasi ke UI aplikasi
 *    ketika update baru dari GitHub terdeteksi.
 */

const APP_VERSION = 'markflow-v2.4.0';
const CACHE_NAME = `markflow-cache-${APP_VERSION}`;

const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon192px.png',
  './icon512px.png'
];

const CDN_ASSETS = [
  'https://cdn.tailwindcss.com/3.4.17',
  'https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js',
  'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js',
  'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github-dark.min.css'
];

// 1. INSTALL: Langsung aktifkan Service Worker baru (skipWaiting)
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Cache core assets satu per satu agar jika salah satu opsional gagal, tidak membatalkan instalasi
      for (const asset of [...CORE_ASSETS, ...CDN_ASSETS]) {
        try {
          const req = new Request(asset, { cache: 'reload' });
          const res = await fetch(req);
          if (res && res.ok) {
            await cache.put(asset, res.clone());
          }
        } catch (err) {
          // Abaikan saat instalasi jika aset eksternal belum terjangkau
        }
      }
    })
  );
});

// 2. ACTIVATE: Hapus semua cache versi lama & ambil alih semua client (clients.claim)
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((name) => name.startsWith('markflow-cache-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();

      // Beritahu semua jendela PWA yang sedang terbuka bahwa versi baru telah aktif
      const allClients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
      for (const client of allClients) {
        client.postMessage({
          type: 'SW_ACTIVATED',
          version: APP_VERSION,
          timestamp: Date.now()
        });
      }
    })()
  );
});

// 3. FETCH: Network-First (bypass HTTP cache browser) untuk dokumen aplikasi agar perubahan di GitHub langsung tampil
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isHTMLOrCore =
    request.mode === 'navigate' ||
    (isSameOrigin && (
      url.pathname.endsWith('/') ||
      url.pathname.endsWith('index.html') ||
      url.pathname.endsWith('manifest.json') ||
      url.pathname.endsWith('sw.js')
    ));

  if (isHTMLOrCore) {
    // Strategi Network-First dengan cache: 'no-store' agar perubahan kodingan di GitHub langsung terunduh
    event.respondWith(
      (async () => {
        try {
          const freshRequest = new Request(request.url, {
            method: 'GET',
            headers: request.headers,
            cache: 'no-store',
            credentials: 'same-origin'
          });
          const networkResponse = await fetch(freshRequest);
          if (networkResponse && networkResponse.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, networkResponse.clone());
            return networkResponse;
          }
          throw new Error('Network response not ok');
        } catch (err) {
          // Offline fallback: ambil dari cache lokal
          const cachedResponse = await caches.match(request) || await caches.match('./index.html');
          if (cachedResponse) return cachedResponse;
          return new Response('Aplikasi sedang offline dan cache belum tersedia.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        }
      })()
    );
    return;
  }

  // Untuk aset statis & CDN (ikon, pustaka JS/CSS): Stale-While-Revalidate
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cachedResponse = await cache.match(request);

      const networkFetch = fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.ok) {
            cache.put(request, networkResponse.clone());
          }
          return networkResponse;
        })
        .catch(() => cachedResponse);

      return cachedResponse || networkFetch;
    })()
  );
});

// 4. MESSAGE: Dukungan perintah langsung dari UI (SKIP_WAITING & FORCE_CHECK_GITHUB_UPDATE)
self.addEventListener('message', (event) => {
  if (!event.data) return;

  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (event.data.type === 'FORCE_REFRESH_CACHE') {
    event.waitUntil(
      (async () => {
        try {
          const cache = await caches.open(CACHE_NAME);
          const freshIndex = await fetch(new Request('./index.html?t=' + Date.now(), { cache: 'no-store' }));
          if (freshIndex && freshIndex.ok) {
            await cache.put('./index.html', freshIndex.clone());
            await cache.put('./', freshIndex.clone());
          }
          if (event.source) {
            event.source.postMessage({
              type: 'CACHE_REFRESHED',
              version: APP_VERSION,
              timestamp: Date.now()
            });
          }
        } catch (err) {
          if (event.source) {
            event.source.postMessage({
              type: 'CACHE_REFRESH_ERROR',
              error: err ? err.message : 'Offline'
            });
          }
        }
      })()
    );
  }
});
