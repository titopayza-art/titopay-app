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
  /* NIGHT MODE, BEFORE THE FIRST PAINT.
   *
   * app.js applies data-theme="night" from prefers-color-scheme, but app.js is
   * the deferred bundle — so a dark-mode phone got a pale-blue splash that
   * flipped to navy once the bundle ran. Worse, the splash wordmark is chosen
   * by <picture> from prefers-color-scheme, which resolves during PARSE: the
   * white night mark was being painted onto that still-light ground, which is
   * the mirror of the bug this was fixing.
   *
   * Setting the attribute here, synchronously in <head>, means the ground and
   * the wordmark are decided by the same signal at the same moment. app.js sets
   * the very same attribute later and keeps it in step when the phone's setting
   * flips; this only moves the first application earlier. */
  try {
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
      document.documentElement.setAttribute("data-theme", "night");
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", "#071433");
    }
  } catch (themeError) {
    /* No matchMedia: the light theme is the default and stays. */
  }
  try {
    var existing = document.querySelector('link[data-titopay-main-css]');
    if (existing) return;
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "./styles.min.css?v=521";
    link.setAttribute("data-titopay-main-css", "1");
    document.head.appendChild(link);
  } catch (e) {
    /* Last-ditch: a blocking link still beats no styles at all. */
    document.write('<link rel="stylesheet" href="./styles.min.css?v=521">');
  }
})();
