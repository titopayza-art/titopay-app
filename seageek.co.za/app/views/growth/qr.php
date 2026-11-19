<?php
$crumbs = [['QR codes', $qrBase], [$qr['name'], null]];
require APP_DIR . '/views/partials/crumbs.php';
$days = $stats['days'];
$max = max(1, max($days));
$total30 = array_sum($days);
?>
<div class="grid" style="grid-template-columns:340px minmax(0,1fr);align-items:start" id="qrd-grid">
  <div class="panel qr-hero">
    <div class="qr-frame"><img src="<?= e(Qr::imagePath($qr, 'svg')) ?>" alt="QR code for <?= e($qr['name']) ?>" width="260" height="260"></div>
    <div class="toolbar" style="margin:16px 0 0;justify-content:center">
      <a class="btn btn-primary btn-sm" href="<?= e($qrBase . '/' . $qr['public_id'] . '.png') ?>"><?= icon('download') ?>PNG</a>
      <a class="btn btn-ghost btn-sm" href="<?= e($qrBase . '/' . $qr['public_id'] . '.svg') ?>"><?= icon('download') ?>SVG for print</a>
    </div>
    <p class="muted small" style="margin-top:12px;text-align:center">Print at least 2 cm wide. Leave white space around it.</p>
  </div>
  <div>
    <div class="grid cols-3" style="margin-bottom:14px">
      <div class="panel stat"><div class="k">Scans</div><div class="v"><?= $qr['dynamic'] ? number_format((int) $qr['scans']) : 'n/a' ?></div><div class="d"><?= $qr['dynamic'] ? number_format($total30) . ' in the last 30 days' : 'Static codes are not counted' ?></div></div>
      <div class="panel stat"><div class="k">Last scan</div><div class="v" style="font-size:20px"><?= $qr['last_scan_at'] ? e(date('j M H:i', strtotime($qr['last_scan_at'] . ' UTC'))) : 'None yet' ?></div><div class="d"><?= $qr['status'] === 'active' ? 'Active' : 'Paused' ?></div></div>
      <div class="panel stat"><div class="k">Paid</div><div class="v"><?= zar($qr['amount']) ?></div><div class="d">Created <?= e(date('j M Y', strtotime($qr['created_at']))) ?></div></div>
    </div>
    <form method="post" class="panel form"><?= csrf_field() ?>
      <h2>Details</h2>
      <div class="field"><label for="qd-name">Name</label><input id="qd-name" name="name" value="<?= e($qr['name']) ?>"></div>
      <?php if ($qr['dynamic']): ?>
        <div class="field"><label for="qd-url">Sends people to</label><input id="qd-url" name="url" type="url" value="<?= e($qr['target_url']) ?>"></div>
        <div class="field"><label>Short link in the code</label><div class="secret"><span id="qr-short"><?= e(Qr::shortUrl($qr)) ?></span><button class="copy-btn" type="button" data-copy="qr-short">Copy</button></div></div>
        <div class="field"><label for="qd-status">Status</label><select id="qd-status" name="status"><option value="active" <?= $qr['status'] === 'active' ? 'selected' : '' ?>>Active: scans open the link</option><option value="paused" <?= $qr['status'] === 'paused' ? 'selected' : '' ?>>Paused: scans show a short notice</option></select></div>
      <?php else: ?>
        <div class="field"><label>Contains</label><div class="secret"><span><?= e($qr['target_url']) ?></span></div><p class="muted small" style="margin-top:6px">Static codes hold the link itself, so it cannot be changed.</p></div>
      <?php endif; ?>
      <button class="btn btn-ghost btn-sm">Save changes</button>
    </form>
    <?php if ($qr['dynamic']): ?>
    <div class="panel" style="margin-top:14px">
      <div class="panel-head"><h2>Scans, last 30 days</h2><span class="muted"><?= number_format($total30) ?> total</span></div>
      <div class="day-bars" role="img" aria-label="Scans per day for the last 30 days">
        <?php foreach ($days as $d => $n): ?><span title="<?= e(date('j M', strtotime($d))) ?>: <?= $n ?> scan<?= $n === 1 ? '' : 's' ?>"><i style="height:<?= $n ? max(4, round($n / $max * 100)) : 0 ?>%"></i></span><?php endforeach; ?>
      </div>
      <div class="day-axis"><span><?= e(date('j M', strtotime(array_key_first($days)))) ?></span><span>Today</span></div>
      <?php if ($stats['devices']): ?><p class="muted small" style="margin-top:12px">Devices: <?= e(implode(', ', array_map(fn($k, $v) => "$k $v", array_keys($stats['devices']), $stats['devices']))) ?></p><?php endif; ?>
    </div>
    <?php endif; ?>
  </div>
</div>
<style>@media (max-width: 1000px) { #qrd-grid { grid-template-columns: 1fr !important; } }</style>
