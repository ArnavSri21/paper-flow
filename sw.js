const CACHE_NAME = 'paperflow-app-shell-v9';
const FONT_CACHE_NAME = 'paperflow-fonts-v1';
const NOTIF_META_CACHE = 'paperflow-notif-meta-v1';

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon.svg',
  '/pwa-192x192.png',
  '/pwa-512x512.png',
  '/pwa-maskable-512x512.png',
  '/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.allSettled(
        PRECACHE_URLS.map((url) => cache.add(url).catch(() => null))
      );
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key !== FONT_CACHE_NAME && key !== NOTIF_META_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // NEVER intercept APK binary downloads or API routes in Service Worker
  if (
    url.pathname.toLowerCase().endsWith('.apk') ||
    url.pathname.toLowerCase().endsWith('.idsig') ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/download/') ||
    url.pathname.includes('download-apk') ||
    url.pathname.includes('Paper-Flow')
  ) {
    return;
  }

  // Cache-first for Google Fonts stylesheets and font files
  if (
    url.origin === 'https://fonts.googleapis.com' ||
    url.origin === 'https://fonts.gstatic.com'
  ) {
    event.respondWith(
      caches.open(FONT_CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        try {
          const response = await fetch(request);
          if (response && (response.status === 200 || response.type === 'opaque')) {
            cache.put(request, response.clone());
          }
          return response;
        } catch (err) {
          return cached || Response.error();
        }
      })
    );
    return;
  }

  // Only handle same-origin requests for app shell / assets
  if (url.origin !== self.location.origin) return;

  // Network-first for HTML navigation so live updates are fetched when online, falling back to cached shell offline
  if (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.headers.get('content-type')?.includes('text/html')) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('/', copy));
          }
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_NAME);
          return (await cache.match('/')) || (await cache.match('/index.html'));
        })
    );
    return;
  }

  // Stale-while-revalidate for static assets (icons, manifest, images)
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      const networkPromise = fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => cached);
      return cached || networkPromise;
    })
  );
});

// ── CONSTANT BACKGROUND NOTIFICATIONS (EVEN WHEN WEBSITE OR APP IS CLOSED) ──
self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'SYNC_NOTIF_USER') {
    const userLower = String(event.data.usernameLower || '').trim().toLowerCase();
    event.waitUntil(
      caches.open(NOTIF_META_CACHE).then((cache) =>
        cache.put('/__active_user__', new Response(JSON.stringify({ usernameLower: userLower, ts: Date.now() })))
      )
    );
  } else if (event.data.type === 'CHECK_BG_NOTIFICATIONS_NOW') {
    event.waitUntil(checkBackgroundFlowAlerts());
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { title: 'Paper Flow Update', body: event.data.text() };
    }
  }

  const title = data.title || 'Paper Flow';
  const options = {
    body: data.body || 'New update available on Paper Flow',
    icon: '/pwa-192x192.png',
    badge: '/pwa-192x192.png',
    vibrate: [160, 70, 160],
    tag: data.tag || data.id || data.postId || 'paperflow-alert',
    renotify: true,
    requireInteraction: false,
    data: {
      postId: data.postId || '',
      url: data.url || (data.postId ? `/?post=${encodeURIComponent(data.postId)}` : '/')
    }
  };

  event.waitUntil(
    caches.open(NOTIF_META_CACHE).then(async (cache) => {
      if (data.id) {
        await cache.put(`/seen-notif/${data.id}`, new Response('1'));
      }
      return self.registration.showNotification(title, options);
    })
  );
});

// Periodic Background Sync & One-off Background Sync: fetches developer flows & user alerts in background if push was missed
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'paperflow-background-sync' || event.tag === 'paperflow-alerts') {
    event.waitUntil(checkBackgroundFlowAlerts());
  }
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'paperflow-background-sync' || event.tag === 'paperflow-alerts') {
    event.waitUntil(checkBackgroundFlowAlerts());
  }
});

async function checkBackgroundFlowAlerts() {
  try {
    const cache = await caches.open(NOTIF_META_CACHE);
    let activeUser = '';
    try {
      const userRes = await cache.match('/__active_user__');
      if (userRes) {
        const parsed = await userRes.json();
        activeUser = String(parsed.usernameLower || '').trim().toLowerCase();
      }
    } catch (e) {}

    const res = await fetch(`/api/background-notifications?user=${encodeURIComponent(activeUser)}`);
    if (!res.ok) return;
    const json = await res.json();
    if (!json || !Array.isArray(json.notifications)) return;

    for (const notif of json.notifications.slice(0, 5)) {
      if (!notif || !notif.id) continue;
      const seenKey = `/seen-notif/${notif.id}`;
      const alreadySeen = await cache.match(seenKey);
      if (!alreadySeen) {
        await cache.put(seenKey, new Response('1'));
        await self.registration.showNotification(notif.title || 'Paper Flow Update', {
          body: (notif.body || 'New update on Paper Flow. Tap to open.').slice(0, 140),
          icon: '/pwa-192x192.png',
          badge: '/pwa-192x192.png',
          vibrate: [160, 70, 160],
          tag: notif.tag || notif.id,
          renotify: true,
          data: {
            postId: notif.postId || '',
            url: notif.url || (notif.postId ? `/?post=${encodeURIComponent(notif.postId)}` : '/')
          }
        });
      }
    }
  } catch (err) {}
}

// Focus or open the Paper Flow app window when a notification is clicked
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetPostId = event.notification?.data?.postId || '';
  const targetUrl = event.notification?.data?.url || (targetPostId ? `/?post=${encodeURIComponent(targetPostId)}` : '/');

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if (targetPostId) {
            client.postMessage({ type: 'OPEN_POST_FROM_NOTIFICATION', postId: targetPostId });
            client.postMessage({ type: 'OPEN_REPLIED_FLOW', postId: targetPostId });
          }
          return;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
