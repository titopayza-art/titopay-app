<?php
$crumbs = [['Short links', '/dashboard/links'], ['/l/' . $l['code'], null]];
require APP_DIR . '/views/partials/crumbs.php';
$max = max(1, max($daily));
$total30 = array_sum($daily);
?>
<div class="grid cols-3" style="margin-bottom:14px">
  <div class="panel stat"><div class="k">Clicks</div><div class="v"><?= number_format((int) $l['clicks']) ?></div><div class="d"><?= number_format($total30) ?> in the last 30 days</div></div>
  <div class="panel stat"><div class="k">Last click</div><div class="v" style="font-size:20px"><?= $l['last_click_at'] ? e(date('j M H:i', strtotime($l['last_click_at'] . ' UTC'))) : 'None yet' ?></div><div class="d"><?= $l['status'] === 'active' ? 'Active' : 'Paused' ?></div></div>
  <div class="panel stat"><div class="k">Created</div><div class="v" style="font-size:20px"><?= e(date('j M Y', strtotime($l['created_at']))) ?></div><div class="d">Free</div></div>
</div>
<div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:start" id="link-grid">
  <div class="stack">
    <form method="post" class="panel form"><?= csrf_field() ?><input type="hidden" name="action" value="save">
      <h2>Details</h2>
      <div class="field"><label>Short link</label><div class="secret"><span id="ld-short"><?= e(ShortLinks::url($l)) ?></span><button class="copy-btn" type="button" data-copy="ld-short">Copy</button></div></div>
      <div class="field"><label for="ld-url">Opens</label><input id="ld-url" name="url" type="url" value="<?= e($l['target_url']) ?>"></div>
      <div class="field"><label for="ld-name">Name</label><input id="ld-name" name="name" value="<?= e((string) $l['name']) ?>"></div>
      <button class="btn btn-primary btn-sm">Save</button>
    </form>
    <div class="panel">
      <div class="btn-row" style="margin-top:0">
        <form method="post" class="inline-form"><?= csrf_field() ?><input type="hidden" name="action" value="<?= $l['status'] === 'active' ? 'pause' : 'resume' ?>"><button class="btn btn-ghost btn-sm"><?= $l['status'] === 'active' ? 'Pause link' : 'Switch back on' ?></button></form>
        <form method="post" class="inline-form" data-confirm="Delete this short link? Anyone who opens it will see 'Link not found'."><?= csrf_field() ?><input type="hidden" name="action" value="delete"><button class="btn btn-danger btn-sm">Delete</button></form>
      </div>
    </div>
  </div>
  <div class="panel">
    <div class="panel-head"><h2>Clicks, last 30 days</h2><span class="muted"><?= number_format($total30) ?> total</span></div>
    <div class="day-bars" role="img" aria-label="Clicks per day for the last 30 days">
      <?php foreach ($daily as $d => $n): ?><span title="<?= e(date('j M', strtotime($d))) ?>: <?= $n ?> click<?= $n === 1 ? '' : 's' ?>"><i style="height:<?= $n ? max(4, round($n / $max * 100)) : 0 ?>%"></i></span><?php endforeach; ?>
    </div>
    <div class="day-axis"><span><?= e(date('j M', strtotime(array_key_first($daily)))) ?></span><span>Today</span></div>
    <?php if ($devices): ?><p class="muted small" style="margin-top:12px">Devices: <?= e(implode(', ', array_map(fn($k, $v) => "$k $v", array_keys($devices), $devices))) ?></p><?php endif; ?>
  </div>
</div>
