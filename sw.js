self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const postId = event.notification.data && event.notification.data.postId;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if (postId) {
            client.postMessage({ type: 'OPEN_REPLIED_FLOW', postId });
          }
          return;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(postId ? `/?flow=${encodeURIComponent(postId)}` : '/');
      }
    })
  );
});
