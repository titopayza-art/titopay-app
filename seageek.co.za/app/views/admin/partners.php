<div class="toolbar"><p class="muted" style="max-width:70ch">Your wholesale providers. Customers only ever see SeaGeek. For each product, requests go to the active partner with the lowest priority number; if it fails, the next one takes over automatically.</p><a class="btn btn-primary btn-sm" style="margin-left:auto" href="/admin/partners/new">Add partner</a></div>
<div class="panel flush">
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Partner</th><th>Product</th><th>Connector</th><th>Priority</th><th>Health</th><th class="right">Requests this month</th><th class="right">Cost this month</th></tr></thead><tbody>
  <?php foreach ($partners as $p): ?><tr class="click" onclick="location.href='/admin/partners/<?= (int) $p['id'] ?>'"><td><a class="link" href="/admin/partners/<?= (int) $p['id'] ?>"><?= e($p['name']) ?></a></td><td><?= e(service_names()[$p['service']] ?? $p['service']) ?></td><td class="small mono"><?= e($p['driver']) ?></td><td class="mono"><?= (int) $p['priority'] ?></td>
    <td><?php if (!$p['active']): ?><span class="pill">Off</span><?php elseif ((int) $p['fail_count'] >= 5): ?><span class="pill red">Failing</span><?php elseif ((int) $p['fail_count'] > 0): ?><span class="pill amber"><?= (int) $p['fail_count'] ?> errors</span><?php else: ?><span class="pill green">Healthy</span><?php endif; ?></td>
    <td class="right mono small"><?= (int) $p['month_count'] ?></td><td class="right mono small"><?= zar($p['month_cost']) ?></td></tr><?php endforeach; ?>
  </tbody></table></div>
</div>
