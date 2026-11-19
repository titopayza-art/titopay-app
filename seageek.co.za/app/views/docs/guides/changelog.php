<?php foreach (Docs::changelog() as [$date, $clTitle, $clItems]): ?>
<section class="changelog-entry" id="v-<?= e($date) ?>">
  <h2><?= e(date('j F Y', strtotime($date))) ?><span class="muted"> · <?= e($clTitle) ?></span></h2>
  <ul class="plain"><?php foreach ($clItems as $it): ?><li><?= e($it) ?></li><?php endforeach; ?></ul>
</section>
<?php endforeach; ?>
