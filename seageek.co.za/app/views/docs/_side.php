<nav class="docs-side" aria-label="API sections">
  <h4>Start here</h4>
  <a href="/docs" class="<?= empty($slug) ? 'on' : '' ?>">Overview</a>
  <a href="/developers">How it connects</a>
  <h4>Products</h4>
  <?php foreach ($services as $k => $sv): ?><a href="/docs/<?= $k ?>" class="<?= ($slug ?? '') === $k ? 'on' : '' ?>"><?= e($sv['name']) ?><?php if ($sv['status'] !== 'live'): ?><small><?= $sv['status'] === 'beta' ? 'Beta' : 'Planned' ?></small><?php endif; ?></a><?php endforeach; ?>
  <h4>Reference</h4>
  <a href="/docs/openapi.json">OpenAPI spec</a>
  <a href="/status">Status</a>
</nav>
