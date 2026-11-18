<section class="page-hero">
  <div class="hero-card">
    <div class="rays" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div>
    <canvas class="hero-canvas" data-ocean data-horizon="0.38" data-density="0.75" <?= !empty($sharks) ? 'data-sharks="1"' : '' ?> aria-hidden="true"></canvas>
    <div class="inner">
      <?php if (!empty($meta)): ?><p class="hero-meta"><?= e($meta) ?></p><?php endif; ?>
      <h1><?= $h1 ?></h1>
      <?php if (!empty($lead)): ?><p class="lead"><?= e($lead) ?></p><?php endif; ?>
    </div>
  </div>
</section>
<?php $ocean = true; ?>
