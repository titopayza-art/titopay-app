<div class="tabs-row"><?php foreach (['unpaid' => 'Unpaid', 'paid' => 'Paid', 'void' => 'Void', 'all' => 'All'] as $k => $l): ?><a href="?status=<?= $k ?>" class="<?= $st === $k ? 'on' : '' ?>"><?= $l ?></a><?php endforeach; ?></div>
<div class="panel flush">
  <?php if (!$invoices): ?><div class="empty">No invoices.</div><?php else: ?>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Invoice</th><th>Customer</th><th>Type</th><th class="right">Total</th><th>Status</th><th>Due</th><th>Reminders</th></tr></thead><tbody>
  <?php foreach ($invoices as $i): ?><tr><td class="mono small"><?= e($i['number']) ?></td><td><a class="link" href="/admin/orgs/<?= (int) $i['org_id'] ?>"><?= e($i['org']) ?></a></td><td class="small"><?= e($i['kind'] === 'topup' ? 'Credit' : 'Plan') ?></td><td class="right mono small"><?= zar($i['total']) ?></td><td><?php $status = $i['status'] === 'unpaid' && $i['due_at'] < now() ? 'overdue' : $i['status']; require APP_DIR . '/views/partials/status.php'; ?></td><td class="small muted"><?= e(date('j M Y', strtotime($i['due_at']))) ?></td><td class="small mono"><?= max(0, (int) $i['reminder_stage'] - 1) ?></td></tr><?php endforeach; ?>
  </tbody></table></div><?php endif; ?>
</div>
<div class="panel flush" style="margin-top:14px">
  <div class="panel-head"><h2>Latest payments</h2></div>
  <div class="tbl-wrap"><table class="tbl"><tbody><?php foreach ($payments as $p): ?><tr><td><a class="link" href="/admin/orgs/<?= (int) $p['org_id'] ?>"><?= e($p['org']) ?></a></td><td class="small"><?= e(strtoupper($p['gateway'])) ?></td><td class="mono small muted"><?= e($p['gateway_ref']) ?></td><td class="right mono small"><?= zar($p['amount']) ?></td><td><?php $status = $p['status']; require APP_DIR . '/views/partials/status.php'; ?></td><td class="small muted"><?= e($p['created_at']) ?></td></tr><?php endforeach; ?><?php if (!$payments): ?><tr><td class="empty">No payments yet.</td></tr><?php endif; ?></tbody></table></div>
</div>
