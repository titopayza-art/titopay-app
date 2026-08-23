/* Loads the main stylesheet WITHOUT blocking first paint.
 *
 * The app's CSP is `script-src 'self'` (no inline scripts) and `style-src
 * 'self' 'unsafe-inline'`, so the usual `<link media=print onload=...>` swap
 * is blocked. This tiny self-hosted script does the same job the CSP allows:
 * it appends the stylesheet at runtime, which the browser does NOT treat as
 * render-blocking for the already-parsed markup. The inline critical CSS in
 * index.html paints the branded splash immediately; this brings in the full
 * stylesheet a moment later. A <noscript> fallback keeps a normal blocking
 * <link> for the (vanishingly rare) no-JS case.
 *
 * Kept deliberately trivial and dependency-free: if it ever failed to load,
 * the app's own bundle (app.min.js, far larger) would have failed too, so it
 * introduces no new hard-failure mode. */
(function () {
  try {
    var existing = document.querySelector('link[data-titopay-main-css]');
    if (existing) return;
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "./styles.min.css?v=481";
    link.setAttribute("data-titopay-main-css", "1");
    document.head.appendChild(link);
  } catch (e) {
    /* Last-ditch: a blocking link still beats no styles at all. */
    document.write('<link rel="stylesheet" href="./styles.min.css?v=481">');
  }
})();
