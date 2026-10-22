/// <reference lib="webworker" />
export {};

declare const self: ServiceWorkerGlobalScope;
// Replaced from the final bundle by offlineShell() in vite.config.ts.
declare const __WB_PRECACHE__: string[];
declare const __WB_CACHE_VERSION__: string;

const files = new Set(__WB_PRECACHE__);
const version = __WB_CACHE_VERSION__;
const scope = new URL(self.registration.scope).pathname;
const cachePrefix = `wallbang-browser-${scope}-`;
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(version)
      .then((cache) => cache.addAll([...files]))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(cachePrefix) && key !== version)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    !files.has(url.pathname)
  )
    return;
  event.respondWith(
    caches.open(version).then(async (cache) => {
      if (url.pathname === scope || url.pathname.endsWith('.html')) {
        try {
          return await fetch(event.request);
        } catch {
          return (await cache.match(url.pathname)) || Response.error();
        }
      }
      return (await cache.match(url.pathname)) || fetch(event.request);
    }),
  );
});
