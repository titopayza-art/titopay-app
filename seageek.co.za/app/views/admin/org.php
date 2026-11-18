<?php $btn = function (string $action, string $label, string $cls = 'btn-ghost', array $extra = []) { $h = '<form method="post" class="inline-form">' . csrf_field() . '<input type="hidden" name="action" value="' . e($action) . '">'; foreach ($extra as $k => $v) $h .= '<input type="hidden" name="' . e($k) . '" value="' . e($v) . '">'; return $h . '<button class="btn ' . $cls . ' btn-xs">' . e($label) . '</button></form> '; }; ?>
<div class="toolbar"><a class="btn btn-ghost btn-sm" href="/admin/orgs">All customers</a><?= $btn('act_as', 'Open their dashboard') ?><?php $status = $org['status']; require APP_DIR . '/views/partials/status.php'; ?><span class="pill <?= $org['live_enabled'] ? 'green' : 'violet' ?>"><?= $org['live_enabled'] ? 'Live' : 'Sandbox only' ?></span></div>
<div class="grid cols-3">
  <div class="panel">
    <h2>Account</h2>
    <dl class="kv" style="margin-top:12px;grid-template-columns:110px 1fr"><dt>Plan</dt><dd><?= e($plan['name']) ?><?= $org['plan_renews_at'] ? ', renews ' . e(date('j M', strtotime($org['plan_renews_at']))) : '' ?></dd><dt>Balance</dt><dd class="mono"><?= zar($org['balance']) ?></dd><dt>Phone</dt><dd><?= e($org['phone'] ?: '–') ?></dd><dt>Reg no</dt><dd><?= e($org['company_reg'] ?: '–') ?></dd><dt>Use case</dt><dd class="small"><?= e($org['use_case'] ?: '–') ?></dd><dt>Webhook</dt><dd class="small"><?= e($org['webhook_url'] ?: '–') ?></dd></dl>
    <div style="margin-top:14px"><?= $org['status'] === 'locked' ? $btn('unlock', 'Unlock', 'btn-primary') : $btn('lock', 'Lock', 'btn-danger') ?><?= $org['live_enabled'] ? $btn('live_off', 'Turn live off') : $btn('live_on', 'Turn live on') ?></div>
    <?php if ($org['locked_reason']): ?><p class="muted small" style="margin-top:8px">Locked: <?= e($org['locked_reason']) ?></p><?php endif; ?>
  </div>
  <div class="panel">
    <h2>Reviews</h2>
    <dl class="kv" style="margin-top:12px;grid-template-columns:110px 1fr">
      <dt>KYB</dt><dd><?php $status = $org['kyb_status']; require APP_DIR . '/views/partials/status.php'; ?> <?php if ($org['kyb_status'] === 'pending'): ?><br><?= $btn('kyb', 'Approve', 'btn-primary', ['value' => 'approved']) ?><?= $btn('kyb', 'Reject', 'btn-danger', ['value' => 'rejected']) ?><?php endif; ?></dd>
      <dt>Sender ID</dt><dd><?= e($org['sms_sender'] ?: '–') ?> <?php $status = $org['sms_sender_status']; require APP_DIR . '/views/partials/status.php'; ?><?php if ($org['sms_sender_status'] === 'pending'): ?><br><?= $btn('sender', 'Approve', 'btn-primary', ['value' => 'approved']) ?><?= $btn('sender', 'Reject', 'btn-danger', ['value' => 'rejected']) ?><?php endif; ?></dd>
      <dt>Mail domain</dt><dd><?= e($org['mail_domain'] ?: '–') ?> <?php $status = $org['mail_domain_status']; require APP_DIR . '/views/partials/status.php'; ?><?php if ($org['mail_domain_status'] === 'pending'): ?><br><?= $btn('domain', 'Mark verified', 'btn-primary', ['value' => 'verified']) ?><?php endif; ?></dd>
    </dl>
  </div>
  <div class="panel">
    <h2>Limits</h2>
    <form method="post" class="form" style="margin-top:12px"><?= csrf_field() ?><input type="hidden" name="action" value="limits">
      <div class="field"><label>Plan</label><select name="plan_code"><?php foreach ($plans as $p): ?><option value="<?= e($p['code']) ?>" <?= $p['code'] === $org['plan_code'] ? 'selected' : '' ?>><?= e($p['name']) ?></option><?php endforeach; ?></select></div>
      <div class="row"><div class="field"><label>Credit limit (R)</label><input name="credit_limit" type="number" min="0" value="<?= (float) $org['credit_limit'] ?>"></div><div class="field"><label>AI cap (R)</label><input name="ai_monthly_cap" type="number" min="0" value="<?= e($org['ai_monthly_cap'] !== null ? (float) $org['ai_monthly_cap'] : '') ?>" placeholder="Plan"></div></div>
      <button class="btn btn-ghost btn-sm">Save limits</button></form>
  </div>
</div>
<div class="grid cols-2" style="margin-top:14px">
  <div class="panel">
    <h2>Adjust balance</h2>
    <form method="post" class="toolbar" style="margin-top:12px"><?= csrf_field() ?><input type="hidden" name="action" value="adjust"><input name="amount" type="number" step="0.01" placeholder="Amount, e.g. 100 or -50" required><input name="note" placeholder="Reason (shown on statement)" required><button class="btn btn-ghost btn-sm">Apply</button></form>
    <h2 style="margin-top:18px">Usage this month</h2>
    <table class="tbl" style="margin-top:8px"><thead><tr><th>Product</th><th class="right">Requests</th><th class="right">Billed</th><th class="right">Cost</th></tr></thead><tbody><?php foreach ($usage as $r): ?><tr><td><?= e(service_names()[$r['service']] ?? $r['service']) ?></td><td class="right mono small"><?= (int) $r['c'] ?></td><td class="right mono small"><?= zar($r['a']) ?></td><td class="right mono small muted"><?= zar($r['k']) ?></td></tr><?php endforeach; ?><?php if (!$usage): ?><tr><td colspan="4" class="empty">No live usage this month.</td></tr><?php endif; ?></tbody></table>
  </div>
  <div class="panel flush">
    <div class="panel-head"><h2>Invoices</h2></div>
    <table class="tbl"><tbody><?php foreach ($invoices as $i): ?><tr><td class="mono small"><?= e($i['number']) ?><div class="muted small"><?= e($i['description']) ?></div></td><td class="right mono small"><?= zar($i['total']) ?></td><td><?php $status = $i['status']; require APP_DIR . '/views/partials/status.php'; ?></td><td class="right"><?php if ($i['status'] === 'unpaid'): ?><form method="post" class="inline-form"><?= csrf_field() ?><input type="hidden" name="action" value="eft"><input type="hidden" name="invoice" value="<?= (int) $i['id'] ?>"><input name="ref" placeholder="Bank ref" style="width:90px;height:30px;border-radius:6px;border:1px solid var(--line-strong);background:var(--bg);color:var(--text);padding:0 8px"> <button class="btn btn-primary btn-xs">Mark EFT paid</button></form><?php endif; ?></td></tr><?php endforeach; ?><?php if (!$invoices): ?><tr><td class="empty">No invoices.</td></tr><?php endif; ?></tbody></table>
  </div>
</div>
<?php if ($numbers): ?>
<div class="panel flush" style="margin-top:14px">
  <div class="panel-head"><h2>WhatsApp numbers</h2><span class="muted">Webhook URL to set at the partner is shown per number</span></div>
  <div class="tbl-wrap"><table class="tbl"><tbody><?php foreach ($numbers as $n): ?><tr><td class="mono"><?= e($n['phone']) ?><div class="muted small"><?= e($n['display_name']) ?></div></td><td class="small mono muted" style="max-width:280px;overflow-wrap:anywhere"><?= e(app_url('/webhooks/whatsapp/' . $n['id'] . '/' . substr(hash_hmac('sha256', 'wa' . $n['id'], (string) config('app_key')), 0, 32))) ?></td>
    <td><form method="post" class="toolbar" style="margin:0"><?= csrf_field() ?><input type="hidden" name="action" value="wa"><input type="hidden" name="number" value="<?= (int) $n['id'] ?>"><select name="status"><?php foreach (['pending', 'active', 'rejected'] as $s): ?><option <?= $n['status'] === $s ? 'selected' : '' ?>><?= $s ?></option><?php endforeach; ?></select><select name="partner_id"><option value="">Any partner</option><?php foreach ($waPartners as $p): ?><option value="<?= (int) $p['id'] ?>" <?= (int) $n['partner_id'] === (int) $p['id'] ? 'selected' : '' ?>><?= e($p['name']) ?></option><?php endforeach; ?></select><input name="channel_key" type="password" placeholder="<?= $n['channel_key_enc'] ? 'Channel key saved' : 'Channel API key' ?>"><button class="btn btn-ghost btn-xs">Save</button></form></td></tr><?php endforeach; ?></tbody></table></div>
</div>
<?php endif; ?>
<div class="grid cols-2" style="margin-top:14px">
  <div class="panel flush"><div class="panel-head"><h2>Users</h2></div><table class="tbl"><tbody><?php foreach ($users as $x): ?><tr><td><?= e($x['name']) ?><div class="muted small"><?= e($x['email']) ?></div></td><td class="small"><?= e($x['role']) ?></td><td class="small muted"><?= $x['email_verified_at'] ? 'Verified' : 'Unverified' ?></td></tr><?php endforeach; ?></tbody></table></div>
  <div class="panel flush"><div class="panel-head"><h2>Activity</h2></div><table class="tbl"><tbody><?php foreach ($audit as $a): ?><tr><td class="small mono"><?= e($a['action']) ?></td><td class="small muted"><?= e(mb_strimwidth((string) $a['detail'], 0, 50, '…')) ?></td><td class="small muted nowrap"><?= e($a['created_at']) ?></td></tr><?php endforeach; ?><?php if (!$audit): ?><tr><td class="empty">No activity yet.</td></tr><?php endif; ?></tbody></table></div>
</div>
