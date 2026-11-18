<section class="section" style="padding-top:130px"><div class="wrap" style="max-width:820px">
  <p class="muted small"><?= e($org['is_house'] ? 'SeaGeek' : $org['name']) ?> support</p>
  <h1 style="font-size:clamp(28px,4vw,40px);margin-top:8px">#<?= (int) $t['number'] ?> <?= e($t['subject']) ?></h1>
  <p style="margin-top:10px"><?php $status = $t['status']; require APP_DIR . '/views/partials/status.php'; ?></p>
  <?php require APP_DIR . '/views/partials/flash.php'; ?>
  <div class="thread" style="margin-top:20px">
    <?php foreach ($messages as $m): ?><div class="msg <?= e($m['author']) ?>"><div class="who"><b><?= e(['customer' => 'You', 'ai' => 'Assistant', 'system' => 'Update', 'agent' => $m['author_name'] ?: 'Support'][$m['author']] ?? $m['author']) ?></b><span><?= e(date('j M H:i', strtotime($m['created_at'] . ' UTC'))) ?></span></div><div class="body"><?= e($m['body']) ?></div></div><?php endforeach; ?>
  </div>
  <?php if (in_array($t['status'], ['solved', 'closed'], true) && !$t['csat']): ?>
    <form method="post" class="panel" style="margin-top:16px"><?= csrf_field() ?><h2>How did we do?</h2><div class="csat" style="margin-top:10px"><?php for ($i = 1; $i <= 5; $i++): ?><button name="csat" value="<?= $i ?>" aria-label="<?= $i ?> out of 5"><?= $i ?></button><?php endfor; ?></div><p class="muted small" style="margin-top:8px">1 is poor, 5 is excellent.</p></form>
  <?php endif; ?>
  <?php if ($t['status'] !== 'closed'): ?>
  <form method="post" class="panel form" style="margin-top:16px"><?= csrf_field() ?><div class="field"><label for="body">Add a reply</label><textarea id="body" name="body" required></textarea></div><button class="btn btn-primary btn-sm">Send reply</button></form>
  <?php endif; ?>
</div></section>
