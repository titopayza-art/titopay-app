<?php $n = ['chat' => null, 'whatsapp_button' => null] + $counts; ?>
<p class="muted" style="margin:0 0 16px;max-width:760px">Tools you switch on with no code: copy a line into your website, or paste a link. Most are free; the ones that send SMS use your normal credit.</p>
<div class="tool-grid">
  <?php foreach (Plugins::all() as $k => [$name, $ic, $href, $summary, $price]): $count = $n[$k] ?? null; ?>
    <a class="panel tool-card" href="<?= e($href) ?>">
      <div class="tool-top"><span class="tool-icon"><?= icon($ic) ?></span><span class="tool-price"><?= e($price) ?></span></div>
      <h3><?= e($name) ?></h3>
      <p><?= e($summary) ?></p>
      <span class="tool-foot"><?= $count ? number_format($count) . ' set up' : 'Set up' ?> <span aria-hidden="true">&rarr;</span></span>
    </a>
  <?php endforeach; ?>
</div>
