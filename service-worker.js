const CACHE_NAME = "titopay-pwa-v188-support-icon";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css?v=188",
  "./assets/jsQR.min.js?v=137",
  "./app.js?v=188",
  "./services-default.json?v=188",
  "./manifest.webmanifest?v=188",
  "./offline.html",
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
      return caches.match(event.request) || caches.match("./index.html") || caches.match("./offline.html");
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
