<div class="grid cols-2">
  <div class="panel">
    <h2>Endpoint</h2>
    <p class="muted small" style="margin:6px 0 14px">We POST JSON events here: delivery receipts, inbound WhatsApp messages, verification results and Desk handovers. Failed deliveries are retried for 24 hours.</p>
    <form method="post" class="form"><?= csrf_field() ?><input type="hidden" name="action" value="save">
      <div class="field"><label>URL (https)</label><input name="url" type="url" value="<?= e($org['webhook_url']) ?>" placeholder="https://example.co.za/seageek/webhook"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-primary btn-sm">Save</button></div></form>
    <form method="post" style="margin-top:8px"><?= csrf_field() ?><input type="hidden" name="action" value="test"><button class="btn btn-ghost btn-sm" <?= $org['webhook_url'] ? '' : 'disabled' ?>>Send a test event</button></form>
  </div>
  <div class="panel">
    <h2>Signing secret</h2>
    <p class="muted small" style="margin:6px 0 14px">Check the <span class="code-inline">SeaGeek-Signature</span> header on every request: HMAC-SHA256 of <span class="code-inline">timestamp.body</span> with this secret.</p>
    <div class="secret"><span id="whsec"><?= e($org['webhook_secret']) ?></span><button class="copy-btn" type="button" data-copy="whsec">Copy</button></div>
    <form method="post" style="margin-top:10px" data-confirm="Create a new secret? Your endpoint must be updated."><?= csrf_field() ?><input type="hidden" name="action" value="rotate"><button class="btn btn-ghost btn-sm">Rotate secret</button></form>
  </div>
</div>
<div class="panel flush" style="margin-top:14px">
  <div class="panel-head"><h2>Recent deliveries</h2></div>
  <?php if (!$deliveries): ?><div class="empty">No events yet.</div><?php else: ?>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Event</th><th>Status</th><th>HTTP</th><th>Attempts</th><th>Created</th></tr></thead><tbody>
  <?php foreach ($deliveries as $d): ?><tr><td class="mono small"><?= e($d['event']) ?></td><td><?php $status = $d['status']; require APP_DIR . '/views/partials/status.php'; ?></td><td class="mono small"><?= e($d['last_status'] ?? '-') ?></td><td class="small"><?= (int) $d['attempts'] ?></td><td class="muted small"><?= e($d['created_at']) ?></td></tr><?php endforeach; ?>
  </tbody></table></div><?php endif; ?>
</div>
