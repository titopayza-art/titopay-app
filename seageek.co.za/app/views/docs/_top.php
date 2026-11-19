<?php
/** Opens a docs page. Expects $slug, $pageTitle; optional $lead, $badge. */
$group = $slug === 'overview' ? null : Docs::groupOf($slug);
?>
<div class="wrap docs-shell">
  <?php require __DIR__ . '/_side.php'; ?>
  <article class="docs-article" id="docs-article">
    <details class="docs-mobile-nav"><summary>Documentation menu</summary><div><?php foreach (Docs::nav() as $navGroup => $navItems): ?><h4><?= e($navGroup) ?></h4><?php foreach ($navItems as [$navTitle, $navHref]): ?><a href="<?= e($navHref) ?>"><?= e($navTitle) ?></a><?php endforeach; endforeach; ?></div></details>
    <nav class="crumbs" aria-label="Breadcrumb"><a href="/docs">Docs</a><?php if ($group): ?><span class="sep">/</span><span><?= e($group) ?></span><?php endif; ?><span class="sep">/</span><span><?= e($pageTitle) ?></span></nav>
    <header class="docs-head"><h1><?= e($pageTitle) ?></h1><?php if (!empty($badge)): ?><span class="pill <?= $badge[0] ?>"><?= e($badge[1]) ?></span><?php endif; ?></header>
    <?php if (!empty($lead)): ?><p class="lead docs-lead"><?= e($lead) ?></p><?php endif; ?>
