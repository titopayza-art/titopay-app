// TicketRoom service worker: caches the app shell so the ticket wallet and the
// gate scanner open with no signal at the venue. API responses are never
// cached here; the wallet keeps its own copy of the user's tickets (with their
// QR codes) in localStorage, and the gate scanner keeps the event's ticket list
// in IndexedDB. The cache is named after the build, so every upload starts a
// fresh one and the old one is removed.
const BUILD = "2026-10-22-phases";
const CACHE = `ticketroom-shell-${BUILD}`;
const SHELL = ["/account", "/scan", "/retail", "/safety", "/manifest.webmanifest",
  "/assets/tr.css", "/assets/core.js", "/assets/site.js", "/assets/legal.js", "/assets/retail.js", "/assets/account.js",
  "/assets/scan.js", "/assets/scan-offline.js", "/assets/boxoffice.js", "/assets/cashdesk.js", "/assets/reader.js", "/assets/jsQR.min.js",
  "/assets/logo-mark.svg", "/assets/logo-mark-dark.svg", "/assets/favicon.svg",
  "/assets/app/icon-192.png", "/assets/app/icon-512.png", "/assets/app/maskable-192.png", "/assets/app/apple-touch-icon.png"];
// A slow venue connection: after this long, answer from the cache if we can.
const PATIENCE = 4000;

self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("ticketroom-shell-") && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));

const cached = (req, path) => caches.open(CACHE).then((c) => c.match(req, { ignoreSearch: true }).then((r) => r || c.match(path, { ignoreSearch: true })));
const fallback = (path) => caches.open(CACHE).then((c) => c.match(path.startsWith("/scan") ? "/scan" : "/account"));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/sim/") || url.pathname.startsWith("/media/")) return;
  const inShell = SHELL.includes(url.pathname);
  const page = e.request.mode === "navigate";
  if (!inShell && !page) return;
  // Network first, so a new upload shows straight away; the cached shell when
  // there is no signal (or it is too slow to wait for).
  const net = fetch(e.request).then((res) => {
    if (res.ok && inShell) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(url.pathname, copy)); }
    return res;
  });
  e.respondWith(new Promise((resolve, reject) => {
    let done = false;
    const answer = (r) => { if (!done && r) { done = true; resolve(r); } return !!r; };
    const timer = setTimeout(() => cached(e.request, url.pathname).then(answer), PATIENCE);
    net.then((res) => { clearTimeout(timer); answer(res); }, () => {
      clearTimeout(timer);
      cached(e.request, url.pathname).then((r) => r || (page ? fallback(url.pathname) : null)).then((r) => { if (!answer(r) && !done) reject(new TypeError("offline")); });
    });
  }));
});
