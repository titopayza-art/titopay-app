<?php $pages = max(1, (int) ceil($total / 50)); $qs = fn(array $x) => '?' . http_build_query(array_merge(['env' => $env, 'service' => $svc], $x)); ?>
<form class="toolbar" method="get">
  <div class="env-switch"><a href="<?= $qs(['env' => 'test', 'page' => 1]) ?>" class="<?= $env === 'test' ? 'on' : '' ?>">Sandbox</a><a href="<?= $qs(['env' => 'live', 'page' => 1]) ?>" class="<?= $env === 'live' ? 'on live' : '' ?>">Live</a></div>
  <input type="hidden" name="env" value="<?= e($env) ?>">
  <select name="service" onchange="this.form.submit()"><option value="">All products</option><?php foreach (service_names() as $k => $n): ?><option value="<?= $k ?>" <?= $svc === $k ? 'selected' : '' ?>><?= e($n) ?></option><?php endforeach; ?></select>
  <a class="btn btn-ghost btn-sm" style="margin-left:auto" href="<?= $qs(['format' => 'csv']) ?>">Download CSV</a>
</form>
<div class="panel flush">
  <?php if (!$rows): ?><div class="empty">No usage for this filter.</div><?php else: ?>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>ID</th><th>Product</th><th>Direction</th><th>To / from</th><th>Status</th><th class="right">Qty</th><th class="right">Amount</th><th>Reference</th><th>Time (UTC)</th></tr></thead><tbody>
  <?php foreach ($rows as $m): ?><tr title="<?= e($m['error'] ?? '') ?>"><td class="mono small"><?= e($m['public_id']) ?></td><td><?= e(service_names()[$m['service']] ?? $m['service']) ?></td><td class="small muted"><?= $m['direction'] === 'in' ? 'Inbound' : 'Outbound' ?></td><td class="small"><?= e($m['direction'] === 'in' ? $m['from_addr'] : $m['to_addr']) ?></td><td><?php $status = $m['status']; require APP_DIR . '/views/partials/status.php'; ?></td><td class="right mono small"><?= rtrim(rtrim(number_format((float) $m['quantity'], 2), '0'), '.') ?></td><td class="right mono small"><?= zar($m['amount'], 4) ?></td><td class="small muted"><?= e($m['reference']) ?></td><td class="small muted nowrap"><?= e($m['created_at']) ?></td></tr><?php endforeach; ?>
  </tbody></table></div><?php endif; ?>
</div>
<?php if ($pages > 1): ?><div class="toolbar" style="margin-top:12px;justify-content:center"><?php if ($page > 1): ?><a class="btn btn-ghost btn-sm" href="<?= $qs(['page' => $page - 1]) ?>">Newer</a><?php endif; ?><span class="muted small">Page <?= $page ?> of <?= $pages ?></span><?php if ($page < $pages): ?><a class="btn btn-ghost btn-sm" href="<?= $qs(['page' => $page + 1]) ?>">Older</a><?php endif; ?></div><?php endif; ?>
