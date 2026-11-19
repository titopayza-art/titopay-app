<?php
$crumbs = [[$base === '/dashboard' ? 'Campaigns' : 'Marketing', $listBase], [$c['name'], null]];
require APP_DIR . '/views/partials/crumbs.php';
$channel = $c['channel'];
$draft = $c['status'] === 'draft';
$isHouse = !empty($org['is_house']);
$values = $c;
$count = $preview ? count($preview['list']) : (int) $c['total'];
$delivered = (int) ($delivery['delivered'] ?? 0) + (int) ($delivery['read'] ?? 0);
?>
<div class="toolbar" style="justify-content:space-between">
  <div class="toolbar" style="margin:0"><?php $status = $c['status']; require APP_DIR . '/views/partials/status.php'; ?><span class="muted small"><?= $channel === 'sms' ? 'SMS' : 'Email' ?> · <?= e($audiences[$c['audience']] ?? 'Audience removed') ?></span></div>
  <div class="toolbar" style="margin:0">
    <form method="post" class="inline-form"><?= csrf_field() ?><input type="hidden" name="action" value="duplicate"><button class="btn btn-ghost btn-sm">Duplicate</button></form>
    <?php if (in_array($c['status'], ['scheduled', 'sending'], true)): ?><form method="post" class="inline-form" data-confirm="Stop this campaign? Messages already sent are not affected."><?= csrf_field() ?><input type="hidden" name="action" value="cancel"><button class="btn btn-danger btn-sm">Stop</button></form><?php endif; ?>
  </div>
</div>

<?php if ($draft): ?>
<div class="grid" style="grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);align-items:start" id="cd-grid">
  <form method="post" class="panel form"><?= csrf_field() ?><input type="hidden" name="action" value="save">
    <h2>Message</h2>
    <?php require __DIR__ . '/_campaign_fields.php'; ?>
    <button class="btn btn-ghost btn-sm">Save changes</button>
  </form>
  <div>
    <div class="panel">
      <h2>Preview</h2>
      <?php if ($channel === 'sms'): ?>
        <div class="phone"><div class="bubble them"><?= nl2br(e(Campaigns::render((string) $c['body'], ['name' => 'Thandi Mokoena']))) ?></div></div>
      <?php else: ?>
        <p class="muted small" style="margin:6px 0 8px">Subject: <b style="color:var(--text)"><?= e(Campaigns::render((string) $c['subject'], ['name' => 'Thandi Mokoena'])) ?></b></p>
        <iframe class="mail-preview" title="Email preview" sandbox srcdoc="<?= e(Campaigns::emailHtml($org, $c, 'Thandi Mokoena', 'thandi@example.co.za')) ?>"></iframe>
      <?php endif; ?>
    </div>
    <div class="panel" style="margin-top:14px">
      <h2>Before you send</h2>
      <dl class="kv" style="margin-top:10px;grid-template-columns:150px 1fr">
        <dt>Recipients</dt><dd><b><?= number_format($count) ?></b><?= $preview['skipped'] ? ' <span class="muted small">(' . number_format($preview['skipped']) . ' skipped: opted out, duplicates or no ' . ($channel === 'sms' ? 'phone' : 'email') . ')</span>' : '' ?></dd>
        <?php if ($channel === 'sms'): ?><dt>Length</dt><dd><?= (int) $estimate['segments'] ?> SMS per person</dd><?php endif; ?>
        <dt>Estimated cost</dt><dd class="mono"><?= $isHouse ? 'Internal, not charged' : zar($estimate['total']) ?></dd>
        <?php if (!$isHouse): ?><dt>Your credit</dt><dd class="mono"><?= zar($org['balance']) ?></dd><?php endif; ?>
      </dl>
      <form method="post" class="toolbar" style="margin:16px 0 0"><?= csrf_field() ?><input type="hidden" name="action" value="test">
        <input name="to" placeholder="<?= $channel === 'sms' ? 'Your mobile number' : 'Your email address' ?>" value="<?= e($channel === 'sms' ? (string) ($org['phone'] ?? '') : (string) Auth::user()['email']) ?>" style="flex:1;min-width:0"><button class="btn btn-ghost btn-sm">Send me a test</button>
      </form>
      <form method="post" style="margin-top:14px" data-confirm="Send to <?= number_format($count) ?> people? This cannot be undone."><?= csrf_field() ?><input type="hidden" name="action" value="launch">
        <div class="choice-row">
          <label class="choice"><input type="radio" name="when" value="now" checked><span><b>Send now</b><small>Starts straight away.</small></span></label>
          <label class="choice"><input type="radio" name="when" value="later"><span><b>Schedule</b><small><input type="datetime-local" name="at" value="<?= e(date('Y-m-d\TH:i', strtotime('+1 day 09:00'))) ?>" style="margin-top:6px;width:100%"></small></span></label>
        </div>
        <button class="btn btn-primary" style="margin-top:12px" <?= $count ? '' : 'disabled' ?>>Send to <?= number_format($count) ?> <?= $count === 1 ? 'person' : 'people' ?></button>
        <p class="muted small" style="margin-top:8px">Times are South African time.</p>
      </form>
      <form method="post" style="margin-top:10px" data-confirm="Delete this draft?"><?= csrf_field() ?><input type="hidden" name="action" value="delete"><button class="btn btn-ghost btn-xs">Delete draft</button></form>
    </div>
  </div>
</div>
<?php else: ?>
<div class="grid cols-4">
  <div class="panel stat"><div class="k">Recipients</div><div class="v"><?= number_format((int) $c['total']) ?></div><div class="d"><?= number_format((int) $c['skipped']) ?> skipped before sending</div></div>
  <div class="panel stat"><div class="k">Sent</div><div class="v"><?= number_format((int) $c['sent']) ?></div><div class="d"><?= $c['status'] === 'scheduled' ? 'Starts ' . e(date('j M H:i', strtotime($c['scheduled_at'] . ' UTC'))) : ($c['finished_at'] ? 'Finished ' . e(date('j M H:i', strtotime($c['finished_at'] . ' UTC'))) : 'Sending now') ?></div></div>
  <div class="panel stat"><div class="k">Delivered</div><div class="v"><?= number_format($delivered) ?></div><div class="d"><?= (int) $c['sent'] ? round($delivered / max(1, (int) $c['sent']) * 100) . '% of sent, updates as receipts arrive' : 'Waiting for delivery receipts' ?></div></div>
  <div class="panel stat"><div class="k">Cost</div><div class="v"><?= zar($c['cost']) ?></div><div class="d"><?= number_format((int) $c['failed']) ?> failed and refunded</div></div>
</div>
<div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1.3fr);align-items:start;margin-top:14px" id="cr-grid">
  <div class="panel">
    <h2>Message</h2>
    <?php if ($channel === 'sms'): ?><div class="phone"><div class="bubble them"><?= nl2br(e(Campaigns::render((string) $c['body'], ['name' => 'Thandi Mokoena']))) ?></div></div>
    <?php else: ?><p class="muted small" style="margin:6px 0 8px">Subject: <b style="color:var(--text)"><?= e($c['subject']) ?></b></p><iframe class="mail-preview" title="Email preview" sandbox srcdoc="<?= e(Campaigns::emailHtml($org, $c, 'Thandi Mokoena', 'thandi@example.co.za')) ?>"></iframe><?php endif; ?>
  </div>
  <div class="panel flush">
    <div class="panel-head"><h2>Recipients</h2><span class="muted">First 100</span></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Name</th><th><?= $channel === 'sms' ? 'Phone' : 'Email' ?></th><th>Status</th><th>Note</th></tr></thead><tbody>
      <?php foreach ($recipients as $rc): ?><tr><td><?= e($rc['name'] ?: '–') ?></td><td class="mono small"><?= e($rc['address']) ?></td><td><?php $status = $rc['status']; require APP_DIR . '/views/partials/status.php'; ?></td><td class="small muted"><?= e((string) $rc['error']) ?></td></tr><?php endforeach; ?>
    </tbody></table></div>
  </div>
</div>
<?php endif; ?>
<style>@media (max-width: 1000px) { #cd-grid, #cr-grid { grid-template-columns: 1fr !important; } }</style>
