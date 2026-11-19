<?php $cur = $slug ?? 'overview'; ?>
<nav class="docs-side" aria-label="Documentation">
  <div class="docs-search">
    <input type="search" placeholder="Search the docs" aria-label="Search the docs" data-docs-search autocomplete="off">
    <div class="docs-results" data-docs-results hidden></div>
  </div>
  <?php foreach (Docs::nav() as $navGroup => $navItems): ?>
    <h4><?= e($navGroup) ?></h4>
    <?php foreach ($navItems as [$navTitle, $navHref, $navSlug, $navBadge]): ?>
      <a href="<?= e($navHref) ?>" class="<?= $navSlug === $cur ? 'on' : '' ?>"<?= $navSlug === $cur ? ' aria-current="page"' : '' ?>><span><?= e($navTitle) ?></span><?php if ($navBadge): ?><small><?= e($navBadge) ?></small><?php endif; ?></a>
    <?php endforeach; ?>
  <?php endforeach; ?>
</nav>
<script type="application/json" id="docs-index"><?= json_encode(Docs::searchIndex(), JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP) ?></script>
