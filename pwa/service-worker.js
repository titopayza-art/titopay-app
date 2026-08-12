const CACHE_NAME = "titopay-pwa-v337-public-page";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.min.css?v=337",
  "./app.min.js?v=337",
  "./notification-routing-fix.js?v=1",
  "./services-default.json?v=269",
  "./manifest.webmanifest?v=193",
  "./offline.html",
  "./verify-email/",
  // The verification page's styling used to be an inline <style> block, which
  // needed no entry here. It is a file now because the document root sends
  // style-src 'self' and refuses inline blocks. Without this line the page is
  // in the offline shell with no stylesheet to go with it.
  "./verify-email/verify-email.css?v=227",
  "./verify-email/verify-email.js?v=227",
  "./assets/titopay-logo.png",
  "./assets/icon-192.png?v=165",
  "./assets/icon-512.png?v=165",
  "./assets/maskable-512.png?v=165",
  "./assets/favicon.png?v=165"
];

self.addEventListener("install", (event) => {
  // cache.addAll is atomic: one 404 anywhere in APP_SHELL rejects the whole
  // install, the worker never activates, and the app silently loses offline
  // support with nothing on screen to say so. Several entries carry their own
  // ?v= number and one is a directory that depends on the host serving an
  // index, so a single stale line was enough to do it.
  //
  // Each file is fetched on its own instead. A miss costs that one file from
  // the offline shell; it no longer costs the entire service worker.
  event.waitUntil(caches.open(CACHE_NAME).then(async (cache) => {
    const missing = [];
    await Promise.all(APP_SHELL.map(async (url) => {
      try {
        const response = await fetch(new Request(url, { cache: "reload" }));
        if (response && response.ok) await cache.put(url, response);
        else missing.push(`${url} (${response && response.status})`);
      } catch (error) {
        missing.push(`${url} (${error && error.message})`);
      }
    }));
    if (missing.length) console.warn("[sw] not precached:", missing.join(", "));
  }));
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
