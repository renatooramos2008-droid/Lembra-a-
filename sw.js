// Lembra Aí — recebe as notificações do servidor e abre o app nos detalhes
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'Lembra Aí', body: e.data && e.data.text() }; }
  const title = d.title || 'Lembra Aí';
  const opts = {
    body: d.body || '',
    icon: 'icon-192.png',
    badge: 'badge-96.png',
    tag: d.tag || undefined,
    renotify: true,
    vibrate: [120, 60, 120, 60, 240],
    data: { url: d.url || '#hoje' },
  };
  e.waitUntil((async () => {
    await self.registration.showNotification(title, opts);
    // se o app estiver aberto, toca o som do Lembra Aí
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    list.forEach((c) => c.postMessage({ type: 'push', title, body: opts.body, url: opts.data.url }));
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '#hoje';
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if ('focus' in c) { await c.focus(); c.postMessage({ type: 'open', url }); return; }
    }
    await self.clients.openWindow('./' + url);
  })());
});
