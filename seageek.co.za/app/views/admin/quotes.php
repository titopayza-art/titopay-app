<?php
$open = array_filter($quotes, fn($q) => $q['status'] === 'open' && $q['valid_until'] >= now());
$accepted = array_filter($quotes, fn($q) => $q['status'] === 'accepted');
?>
<div class="grid cols-3" style="margin-bottom:14px">
  <div class="panel stat"><div class="k">Open quotes</div><div class="v"><?= count($open) ?></div><div class="d"><?= zar(array_sum(array_column($open, 'total')), 0) ?> a month in the pipeline</div></div>
  <div class="panel stat"><div class="k">Accepted</div><div class="v"><?= count($accepted) ?></div><div class="d"><?= zar(array_sum(array_column($accepted, 'total')), 0) ?> a month won</div></div>
  <div class="panel stat"><div class="k">Conversion</div><div class="v"><?= $quotes ? round(count($accepted) / count($quotes) * 100) : 0 ?>%</div><div class="d">Of all quotes created</div></div>
</div>
<div class="panel flush">
  <div class="panel-head"><h2>Customer quotes</h2><span class="muted">Customers build these themselves on the website or in their dashboard</span></div>
  <?php if (!$quotes): ?><div class="empty">No quotes yet.</div><?php else: ?>
  <div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>Quote</th><th>Customer</th><th>Plan</th><th class="right">Monthly</th><th>Created</th><th>Valid until</th><th>Status</th></tr></thead>
    <tbody><?php foreach ($quotes as $q): $st = $q['status'] === 'open' && $q['valid_until'] < now() ? 'expired' : $q['status']; ?>
      <tr><td class="mono small"><a class="link" href="/admin/quotes/<?= e($q['number']) ?>"><?= e($q['number']) ?></a></td><td><?= $q['org_id'] ? '<a class="link" href="/admin/orgs/' . (int) $q['org_id'] . '">' . e($q['org']) . '</a> <span class="muted small mono">' . e($q['customer_no']) . '</span>' : '<span class="muted">Website visitor</span>' ?></td><td class="small"><?= e(ucfirst((string) $q['plan_code'])) ?></td><td class="right mono small"><?= zar($q['total']) ?></td><td class="small nowrap"><?= e(date('j M Y', strtotime($q['created_at']))) ?></td><td class="small nowrap"><?= e(date('j M Y', strtotime($q['valid_until']))) ?></td><td><?php $status = $st; require APP_DIR . '/views/partials/status.php'; ?></td></tr>
    <?php endforeach; ?></tbody>
  </table></div><?php endif; ?>
</div>
