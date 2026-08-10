const CACHE_NAME = "titopay-pwa-v297-topup-back-action";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.min.css?v=297",
  "./app.min.js?v=297",
  "./notification-routing-fix.js?v=1",
  "./services-default.json?v=269",
  "./manifest.webmanifest?v=193",
  "./offline.html",
  "./verify-email/",
  "./verify-email/verify-email.js?v=227",
  "./assets/titopay-logo.png",
  "./assets/icon-192.png?v=165",
  "./assets/icon-512.png?v=165",
  "./assets/maskable-512.png?v=165",
  "./assets/favicon.png?v=165"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin || requestUrl.hostname === "api.titopay.co.za") return;

  const networkFirst = async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(event.request);
      if (response && response.ok) cache.put(event.request, response.clone());
      return response;
    } catch (error) {
      // Each of these is a Promise, and every Promise is truthy, so chaining
      // them with || returned the FIRST one regardless of whether it resolved
      // to anything. On a cache miss the handler resolved to undefined,
      // respondWith got a non-Response, and the request failed as a network
      // error instead of falling back — which is why offline.html has never
      // once been served despite being precached since the day it shipped.
      // Await each in turn so the fallback is a fallback.
      return (await caches.match(event.request))
        || (await caches.match("./index.html"))
        || (await caches.match("./offline.html"))
        || Response.error();
    }
  };

  if (event.request.mode === "navigate") {
    event.respondWith(networkFirst());
    return;
  }

  if (/\.(?:html|js|css|json|webmanifest)$/i.test(requestUrl.pathname)) {
    event.respondWith(networkFirst());
    return;
  }

  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const route = String(event.notification.data?.route || "profile").replace(/^#/, "");
  const destination = new URL(`./#${route}`, self.registration.scope).href;
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
      const existing = windows.find((client) => client.url.startsWith(self.registration.scope));
      if (existing) {
        await existing.navigate(destination);
        return existing.focus();
      }
      return clients.openWindow(destination);
    })
  );
});
