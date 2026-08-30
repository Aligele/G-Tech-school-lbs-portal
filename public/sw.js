// Lets the portal open with no signal, and keeps working while entering
// marks or attendance offline. saveRoster() in store.js already queues
// changes on the device and sends them the moment a connection returns —
// this only handles the app itself opening without one.
//
// Network-first, cache-as-you-go: every page and asset that loads while
// online is quietly kept as a fallback. Nothing is pre-listed by filename,
// so a new build's hashed files are picked up automatically the next time
// the app is opened with a signal — no separate step needed here when the
// app itself changes.
//
// Deliberately NOT cached: anything talking to Supabase or this project's
// own /api/ functions. Real pupil data and a password reset must always be
// asked for fresh, never served stale from a cache.

const CACHE = "portal-shell-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;          // never cache Supabase
  if (url.pathname.startsWith("/api/")) return;              // never cache the reset function

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() =>
        caches.match(request).then((cached) => cached || caches.match("/"))
      )
  );
});
