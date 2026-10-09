// TicketRoom service worker: caches the app shell so the ticket wallet opens
// with no signal at the venue. API responses are never cached here; the
// wallet keeps its own copy of the user's tickets in localStorage.
const CACHE = "ticketroom-shell-v1";
const SHELL = ["/account", "/assets/tr.css", "/assets/core.js", "/assets/account.js", "/assets/logo-mark.svg", "/assets/favicon.svg", "/manifest.webmanifest"];
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/sim/")) return;
  // Network first, fall back to the cached shell.
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok && SHELL.includes(url.pathname)) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match("/account"))));
});
