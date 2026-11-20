<!doctype html>
<html lang="en-ZA">
<head><?php require APP_DIR . '/views/partials/head.php'; ?></head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
  <div class="bar">
    <a class="brand" href="/" aria-label="SeaGeek home"><?php require APP_DIR . '/views/partials/logo.php'; ?><span>SeaGeek</span></a>
    <nav class="nav-pill" aria-label="Primary">
      <?php foreach (['/products' => ['Products', 'products'], '/desk' => ['Desk', 'desk'], '/plugins' => ['Plug-ins', 'plugins'], '/pricing' => ['Pricing', 'pricing'], '/docs' => ['Developers', 'developers'], '/startups' => ['Startups', 'startups'], '/about' => ['About', 'about']] as $href => [$label, $key]): ?>
        <a href="<?= $href ?>"<?= ($nav ?? '') === $key ? ' class="active" aria-current="page"' : '' ?>><?= $label ?></a>
      <?php endforeach; ?>
    </nav>
    <div class="header-actions">
      <?php if (Auth::user()): ?>
        <a class="btn btn-primary btn-sm" href="<?= Auth::user()['is_admin'] ? '/admin' : '/dashboard' ?>">Dashboard</a>
      <?php else: ?>
        <a class="btn btn-ghost btn-sm" href="/login" style="border-color:transparent">Sign in</a>
        <a class="btn btn-primary btn-sm" href="/register">Start free</a>
      <?php endif; ?>
      <button class="icon-btn menu-toggle" aria-label="Menu" aria-expanded="false" aria-controls="mobile-nav"><?= icon('menu') ?></button>
    </div>
  </div>
</header>
<nav class="mobile-nav" id="mobile-nav" aria-label="Mobile">
  <a href="/products">Products</a><a href="/desk">Desk</a><a href="/plugins">Plug-ins</a><a href="/pricing">Pricing</a><a href="/docs">Developers</a><a href="/startups">Startups</a><a href="/about">About</a><a href="/help">Help centre</a><a href="/login">Sign in</a>
  <a class="btn btn-primary" href="/register">Start free</a>
</nav>
<main id="main"><?= $content ?></main>
<footer class="site-footer">
  <div class="wrap">
    <?php if (!empty($_SESSION['flash'])): ?><div class="site-flash"><?php require APP_DIR . '/views/partials/flash.php'; ?></div><?php endif; ?>
    <div class="footer-grid">
      <div class="footer-about">
        <a class="brand" href="/"><?php require APP_DIR . '/views/partials/logo.php'; ?><span>SeaGeek</span></a>
        <p>APIs for messaging, identity, AI and customer service. Based in Johannesburg.</p>
        <p style="margin-top:10px"><a class="link" href="mailto:hello@seageek.co.za">hello@seageek.co.za</a></p>
        <form method="post" action="/newsletter" class="newsletter" id="newsletter"><?= csrf_field() ?>
          <label for="nl-email">Monthly news, at most one email a month</label>
          <div class="nl-row"><input id="nl-email" name="email" type="email" placeholder="you@company.co.za" required><button class="btn btn-ghost btn-sm">Subscribe</button></div>
          <label class="consent small"><input type="checkbox" name="consent" value="1" required><span>I agree to receive SeaGeek news and can unsubscribe at any time.</span></label>
        </form>
      </div>
      <div><h4>Products</h4><ul><?php foreach (Catalog::services() as $k => $s) if ($s['status'] !== 'planned'): ?><li><a href="/docs/<?= $k ?>"><?= e($s['name']) ?></a></li><?php endif; ?></ul></div>
      <div><h4>Developers</h4><ul><li><a href="/docs">API documentation</a></li><li><a href="/docs/quickstart">Quickstart</a></li><li><a href="/developers">How it connects</a></li><li><a href="/plugins">No-code plug-ins</a></li><li><a href="/docs/openapi.json">OpenAPI spec</a></li><li><a href="/status">Status</a></li></ul></div>
      <div><h4>Company</h4><ul><li><a href="/about">About</a></li><li><a href="/pricing">Pricing</a></li><li><a href="/quote">Get a quote</a></li><li><a href="/startups">Startups</a></li><li><a href="/help">Help centre</a></li><li><a href="/contact">Contact</a></li></ul></div>
      <div><h4>Legal</h4><ul><li><a href="/privacy">Privacy</a></li><li><a href="/terms">Terms</a></li><li><a href="/privacy#paia">PAIA</a></li></ul></div>
    </div>
    <div class="footer-bottom"><span>© <?= gmdate('Y') ?> SeaGeek Technologies (Pty) Ltd. Registration pending.</span><span>Johannesburg, South Africa</span></div>
  </div>
</footer>
<script src="/assets/js/main.js?v=3" defer></script>
<?php if (!empty($ocean)): ?><script src="/assets/js/ocean.js?v=5" defer></script><?php endif; ?>
<script src="/assets/js/chat-widget.js?v=5" defer></script>
</body>
</html>
