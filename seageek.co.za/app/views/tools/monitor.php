<?php
$crumbs = [['Website monitor', '/dashboard/monitors'], [$m['name'], null]];
require APP_DIR . '/views/partials/crumbs.php';
$st = $m['paused'] ? 'paused' : $m['state'];
$label = ['up' => 'Up', 'down' => 'Down', 'pending' => 'Checking', 'paused' => 'Paused'][$st] ?? $st;
?>
<div class="grid cols-3" style="margin-bottom:14px">
  <div class="panel stat"><div class="k">Status</div><div class="v" style="font-size:22px"><span class="mon-state mon-<?= e($st) ?>"><i></i><?= e($label) ?></span></div><div class="d"><?= $m['state_since'] && !$m['paused'] && $m['state'] !== 'pending' ? 'For ' . e(Monitors::duration(time() - strtotime($m['state_since'] . ' UTC'))) : '' ?><?= $m['state'] === 'down' && $m['last_error'] ? '. ' . e($m['last_error']) : '' ?><?= !$m['state_since'] && !$m['last_error'] ? '&nbsp;' : '' ?></div></div>
  <div class="panel stat"><div class="k">Last response</div><div class="v"><?= $m['last_ms'] !== null ? (int) $m['last_ms'] . ' ms' : 'None' ?></div><div class="d"><?= $m['last_error'] && $m['last_code'] && $m['last_code'] < 400 ? 'Answered ' . (int) $m['last_code'] . ', but the page was wrong' : ($m['last_code'] ? 'Answered ' . (int) $m['last_code'] : 'No answer') ?><?= $m['last_check_at'] ? ' at ' . e(date('H:i', strtotime($m['last_check_at'] . ' UTC'))) : '' ?></div></div>
  <div class="panel stat"><div class="k">Uptime</div><div class="v"><?= e(Monitors::uptime($m) ?? 'n/a') ?></div><div class="d"><?= number_format((int) $m['checks']) ?> checks since <?= e(date('j M', strtotime($m['created_at']))) ?></div></div>
</div>
<div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:start" id="mond-grid">
  <div class="stack">
    <form method="post" class="panel form"><?= csrf_field() ?><input type="hidden" name="action" value="save">
      <h2>Settings</h2>
      <div class="field"><label for="md-url">Website address</label><input id="md-url" name="url" type="url" value="<?= e($m['url']) ?>"></div>
      <div class="row">
        <div class="field"><label for="md-name">Name</label><input id="md-name" name="name" value="<?= e($m['name']) ?>"></div>
        <div class="field"><label for="md-every">Check</label><select id="md-every" name="every_min"><?php foreach (Monitors::INTERVALS as $k => $lab): ?><option value="<?= $k ?>" <?= $k === (int) $m['every_min'] ? 'selected' : '' ?>><?= e($lab) ?></option><?php endforeach; ?></select></div>
      </div>
      <div class="row">
        <div class="field"><label for="md-email">Email alerts to</label><input id="md-email" name="alert_email" type="email" value="<?= e((string) $m['alert_email']) ?>"></div>
        <div class="field"><label for="md-phone">SMS alerts to</label><input id="md-phone" name="alert_phone" inputmode="tel" value="<?= e((string) $m['alert_phone']) ?>"></div>
      </div>
      <div class="field"><label for="md-key">Words that must be on the page</label><input id="md-key" name="keyword" value="<?= e((string) $m['keyword']) ?>"></div>
      <button class="btn btn-primary btn-sm">Save</button>
    </form>
    <div class="panel">
      <div class="btn-row" style="margin-top:0">
        <form method="post" class="inline-form"><?= csrf_field() ?><input type="hidden" name="action" value="check"><button class="btn btn-ghost btn-sm">Check now</button></form>
        <form method="post" class="inline-form"><?= csrf_field() ?><input type="hidden" name="action" value="<?= $m['paused'] ? 'resume' : 'pause' ?>"><button class="btn btn-ghost btn-sm"><?= $m['paused'] ? 'Resume' : 'Pause' ?></button></form>
        <form method="post" class="inline-form" data-confirm="Stop watching this website and delete its history?"><?= csrf_field() ?><input type="hidden" name="action" value="delete"><button class="btn btn-danger btn-sm">Delete</button></form>
      </div>
    </div>
  </div>
  <div class="panel flush">
    <div class="panel-head"><h2>History</h2></div>
    <?php if (!$events): ?><div class="empty">No outages recorded. We list every time it goes down or comes back.</div><?php else: ?>
    <div class="tbl-wrap"><table class="tbl"><tbody>
      <?php foreach ($events as $ev): ?><tr><td><span class="mon-state mon-<?= e($ev['state']) ?>"><i></i><?= $ev['state'] === 'up' ? 'Back up' : 'Went down' ?></span></td><td class="small"><?= e((string) $ev['detail']) ?></td><td class="small muted nowrap"><?= e(date('j M H:i', strtotime($ev['created_at'] . ' UTC'))) ?></td></tr><?php endforeach; ?>
    </tbody></table></div>
    <?php endif; ?>
  </div>
</div>
