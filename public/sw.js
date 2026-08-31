// Lets the portal open with no signal, and keeps working while entering
// marks or attendance offline. saveRoster() in store.js already queues
// changes on the device and sends them the moment a connection returns —
// this only handles the app itself opening without one.
//
// Two things happen here:
//   1. Every page and asset loaded while online is quietly kept as a
//      fallback, so the app shell itself opens with no signal.
//   2. If a page navigation genuinely fails offline, a proper offline
//      page is shown instead of the browser's own broken-connection screen.
//
// Deliberately NOT cached: anything talking to Supabase or this project's
// own /api/ functions. Real pupil data and a password reset must always be
// asked for fresh, never served stale from a cache.

const CACHE = "portal-shell-v2";
const OFFLINE_PAGE = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.add(OFFLINE_PAGE))
  );
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

  // A full page load (someone opening or reloading the app) falls back to
  // the offline page specifically if the network genuinely fails — this is
  // the pattern installability checks look for.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match(OFFLINE_PAGE))
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request))
  );
});
