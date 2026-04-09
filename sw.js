// Service Worker for OpenClaw PWA
const CACHE = 'oc-v1';
const ASSETS = ['/chat/', '/chat/app.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', e => {
  // Network first, fallback to cache
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

// Handle notification clicks
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({type:'window'}).then(list => {
      for(const c of list){
        if(c.url.includes('/chat/') && 'focus' in c) return c.focus();
      }
      return clients.openWindow('/chat/');
    })
  );
});
