const CACHE_NAME = "titopay-pwa-v507-verify-type";
const APP_SHELL = [
  "./",
  "./index.html",
  "./head-boot.js?v=507",
  "./styles.min.css?v=507",
  "./app.min.js?v=507",
  "./notification-routing-fix.js?v=1",
  "./services-default.json?v=270",
  "./manifest.webmanifest?v=193",
  "./offline.html",
  "./verify-email/",
  // The verification page's styling used to be an inline <style> block, which
  // needed no entry here. It is a file now because the document root sends
  // style-src 'self' and refuses inline blocks. Without this line the page is
  // in the offline shell with no stylesheet to go with it.
  "./verify-email/verify-email.css?v=228",
  "./verify-email/verify-email.js?v=228",
  "./assets/titopay-logo.png",
  "./assets/titopay-logo-night.png",
  // The marketing poster draws a real screen of the app. A shop opening it
  // behind a dead connection should still get the sheet it was shown, so the
  // screen ships in the shell alongside the wordmarks.
  "./assets/poster-app-screen.jpg?v=488",
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

// THE SHELL, FROM WHATEVER CACHE STILL HAS ONE.
//
// Written because the previous version could not answer this question at all:
// it looked only in CACHE_NAME, so the moment a new version's cache was
// incomplete there was nothing left to serve. A stale shell is a working app
// that updates itself on the next good connection. It beats a white screen so
// completely that version correctness is not worth considering here.
async function shellFromAnyCache(request) {
  const names = await caches.keys();
  const ordered = [CACHE_NAME, ...names.filter((name) => name !== CACHE_NAME)];
  for (const name of ordered) {
    const cache = await caches.open(name);
    const hit = (request && await cache.match(request))
      || await cache.match("./index.html")
      || await cache.match("./");
    if (hit) return hit;
  }
  return null;
}

async function matchInAnyCache(url) {
  for (const name of await caches.keys()) {
    const hit = await (await caches.open(name)).match(url);
    if (hit) return hit;
  }
  return null;
}

// A REAL DOCUMENT, ALWAYS. The last resort when every cache is empty and the
// network is gone. It carries no external asset on purpose — the reason it is
// being shown is that assets could not be fetched — and it repaints itself in
// the app's own colours so a customer sees TitoPay, not a blank pane.
const LAST_RESORT_HTML = `<!doctype html><html lang="en-ZA"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>TitoPay</title><style>
html,body{margin:0;height:100%;background:#eef4fe;color:#10203f;
font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{min-height:100%;display:grid;place-items:center;align-content:center;gap:14px;padding:28px;text-align:center}
h1{margin:0;font-size:1.15rem}p{margin:0;color:#62708a;font-size:.9rem;line-height:1.5;max-width:30ch}
a{display:inline-block;margin-top:8px;padding:12px 22px;border-radius:999px;background:#0a4dff;color:#fff;
text-decoration:none;font-weight:600}</style></head>
<body><main><h1>TitoPay needs a connection</h1>
<p>The app could not reach the network to finish loading. Your money and your
account are unaffected.</p><a href="./">Try again</a></main></body></html>`;

self.addEventListener("activate", (event) => {
  // PURGING IS NOT UNCONDITIONAL ANY MORE, and that is the whole fix.
  //
  // install is best-effort by design: it swallows every failed fetch so one
  // 404 cannot kill the worker. The half that was missing is that activate
  // then deleted every other cache regardless — so an update that ran over a
  // weak connection produced an empty cache AND destroyed the last working
  // one. The next navigation had nothing to fall back to, resolved to
  // Response.error(), and a standalone PWA draws that as a blank white screen
  // that survives every relaunch.
  //
  // Now the old caches are only dropped once the new shell can actually serve
  // a launch. If it cannot, they are kept: a little disk is nothing against an
  // app that will not open.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    if (!await cache.match("./index.html")) {
      // One more attempt, now that activation means the network may have come
      // back since install ran.
      try {
        const response = await fetch(new Request("./index.html", { cache: "reload" }));
        if (response && response.ok) await cache.put("./index.html", response);
      } catch (error) {
        // Still offline. The keep-the-old-cache branch below covers it.
      }
    }
    if (await cache.match("./index.html")) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
    } else {
      console.warn("[sw] new shell incomplete - keeping the previous cache so the app can still open");
    }
    await self.clients.claim();
  })());
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

  // A NAVIGATION MAY NEVER RESOLVE TO NOTHING.
  //
  // Response.error() on a navigation is a blank white screen in a standalone
  // PWA — no error page, no reload button, nothing to tell the customer their
  // money is fine. It is the single worst answer this file can give, so it is
  // no longer one of the answers: the chain ends at a real document that is
  // built into this worker and needs no cache and no network.
  const navigationFallback = async (request) =>
    (await shellFromAnyCache(request))
      || (await matchInAnyCache("./offline.html"))
      || new Response(LAST_RESORT_HTML, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
      });

  const navigationFirst = async () => {
    try {
      const response = await fetch(event.request);
      if (response && response.ok) {
        (await caches.open(CACHE_NAME)).put(event.request, response.clone()).catch(() => null);
        return response;
      }
      // A BAD STATUS IS NOT A NETWORK FAILURE, and returning it was still a
      // white screen. A host answering 500, 502 or 503 mid-deploy hands back a
      // response object with an empty body — fetch resolves, so the catch
      // below never runs, and the customer gets a blank pane just the same.
      // A 404 lands here too, which is right for a single-page app: every deep
      // link is served by the shell, so falling back to it routes the link
      // instead of showing the host's error page.
      return navigationFallback(event.request);
    } catch (error) {
      return navigationFallback(event.request);
    }
  };

  if (event.request.mode === "navigate") {
    event.respondWith(navigationFirst());
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
