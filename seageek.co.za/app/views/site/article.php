<?php $base = $org['is_house'] ? '/help' : '/h/' . $org['slug']; ?>
<section class="section" style="padding-top:130px"><div class="wrap" style="max-width:820px">
  <p class="muted small"><a class="link" href="<?= e($base) ?>">Help centre</a> · <?= e($a['category']) ?></p>
  <h1 style="font-size:clamp(32px,4.4vw,46px);margin-top:12px"><?= e($a['title']) ?></h1>
  <div class="prose" style="margin-top:22px"><?php foreach (preg_split("/\n\s*\n/", trim($a['body'])) as $para): ?><p><?= nl2br(e($para)) ?></p><?php endforeach; ?></div>
  <p class="muted small" style="margin-top:30px">Updated <?= e(date('j F Y', strtotime($a['updated_at']))) ?></p>
  <?php if ($related): ?><h2 style="font-size:20px;margin-top:40px">Related</h2><ul><?php foreach ($related as $r): ?><li><a class="link" href="<?= e($base . '/' . $r['slug']) ?>"><?= e($r['title']) ?></a></li><?php endforeach; ?></ul><?php endif; ?>
  <div class="card" style="margin-top:40px"><h3>Still need help?</h3><p>Start a chat in the corner, or <a class="link" href="/contact">send us a message</a>.</p></div>
</div></section>
