// Service worker: shows the phone notifications the server sends when someone
// ticks something off. It deliberately caches nothing, so the app always
// loads fresh from the server after an update.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function keyBytes(base64url) {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function show(data) {
  const tag = data.tag || 'frugal-shopper';
  let title = data.title || 'Frugal Shopper';
  let body = data.body || '';
  let ticks = [];
  if (data.kind === 'tick' && data.tick) {
    // Ticks that arrive before the phone is looked at stack into one
    // notification rather than a pile of them.
    const [earlier] = await self.registration.getNotifications({ tag });
    ticks = [...(earlier?.data?.ticks ?? []), data.tick].slice(-30);
    if (ticks.length > 1) {
      title = `${data.by} ticked off ${ticks.length} items`;
      body = [...ticks].reverse().join(', ');
    }
  }
  await self.registration.showNotification(title, {
    body,
    tag,
    renotify: true,
    icon: '/icon-192.png',
    timestamp: Date.now(),
    data: { ticks },
  });
}

self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data?.text() ?? '' };
  }
  event.waitUntil(show(data));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => 'focus' in w);
      if (open) return open.focus();
      return self.clients.openWindow('/');
    })(),
  );
});

// Push services occasionally replace a subscription. Sign the new one up in
// place of the old, so notifications keep arriving without opening the app.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      let sub = event.newSubscription;
      if (!sub) {
        const res = await fetch('/api/push', { credentials: 'same-origin' });
        if (!res.ok) return;
        const { publicKey } = await res.json();
        sub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes(publicKey),
        });
      }
      await fetch('/api/push/subscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON(), oldEndpoint: event.oldSubscription?.endpoint }),
      });
    })(),
  );
});
