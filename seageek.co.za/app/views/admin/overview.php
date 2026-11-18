<?php $margin = $kpi['usage_month'] > 0 ? round(($kpi['usage_month'] - $kpi['cost_month']) / $kpi['usage_month'] * 100) : 0;
$cronOk = $cron !== '' && strtotime($cron . ' UTC') > time() - 600; ?>
<?php if (!$cronOk): ?><div class="alert alert-error"><b>Scheduled jobs are not running.</b> Reminders, renewals, queued messages and email depend on them. Set up the cron job shown under <a class="link" href="/admin/system">Jobs &amp; logs</a>.</div><?php endif; ?>
<div class="grid cols-4">
  <div class="panel stat"><div class="k">Monthly recurring revenue</div><div class="v"><?= zar($kpi['mrr'], 0) ?></div><div class="d">From plan subscriptions</div></div>
  <div class="panel stat"><div class="k">Usage billed this month</div><div class="v"><?= zar($kpi['usage_month'], 0) ?></div><div class="d">Gross margin <?= $margin ?>% (cost <?= zar($kpi['cost_month'], 0) ?>)</div></div>
  <div class="panel stat"><div class="k">Cash collected this month</div><div class="v"><?= zar($kpi['cash_month'], 0) ?></div><div class="d">PayFast and EFT</div></div>
  <div class="panel stat"><div class="k">Customers</div><div class="v"><?= $kpi['customers'] ?></div><div class="d"><?= $kpi['live'] ?> live · <?= $kpi['locked'] ?> locked · <?= $kpi['overdue'] ?> overdue invoices</div></div>
</div>
<div class="grid cols-3" style="margin-top:14px">
  <div class="panel span-2"><div class="panel-head"><h2>Live usage billed per day</h2><span class="muted">Last 30 days</span></div><?php $metric = 'amount'; require APP_DIR . '/views/partials/chart.php'; ?></div>
  <div class="panel">
    <div class="panel-head"><h2>By product this month</h2></div>
    <?php if (!$byService): ?><div class="empty">No live usage yet.</div><?php else: $top = max(array_map(fn($r) => (float) $r['a'], $byService)) ?: 1; ?>
    <div class="bars"><?php foreach ($byService as $r): ?><div class="bar-row"><span><?= e(service_names()[$r['service']] ?? $r['service']) ?></span><span class="track"><i style="width:<?= round((float) $r['a'] / $top * 100) ?>%"></i></span><span class="right mono small"><?= zar($r['a'], 0) ?></span></div><?php endforeach; ?></div><?php endif; ?>
    <dl class="kv" style="margin-top:18px;grid-template-columns:1fr auto"><dt>Customer credit held</dt><dd class="mono"><?= zar($kpi['balances'], 0) ?></dd><dt>Queued messages</dt><dd class="mono"><?= $queue['messages'] ?></dd><dt>Queued email</dt><dd class="mono"><?= $queue['email'] ?></dd><dt>Pending webhooks</dt><dd class="mono"><?= $queue['webhooks'] ?></dd></dl>
  </div>
</div>
<div class="grid cols-3" style="margin-top:14px;align-items:start">
  <div class="panel flush">
    <div class="panel-head"><h2>Needs a person</h2><span class="muted"><?= count($pendingReviews) ?></span></div>
    <?php if (!$pendingReviews): ?><div class="empty">Nothing waiting. The system is handling everything.</div><?php else: ?>
    <table class="tbl"><tbody><?php foreach ($pendingReviews as $p): ?><tr><td><a class="link" href="/admin/orgs/<?= (int) $p['id'] ?>"><?= e($p['name']) ?></a></td><td class="right"><span class="pill amber"><?= e($p['what']) ?></span></td></tr><?php endforeach; ?></tbody></table><?php endif; ?>
  </div>
  <div class="panel flush">
    <div class="panel-head"><h2>Partner health</h2><a class="link small" href="/admin/partners">Manage</a></div>
    <table class="tbl"><tbody><?php foreach ($partners as $p): ?><tr><td class="small"><?= e($p['name']) ?><div class="muted small"><?= e(service_names()[$p['service']] ?? $p['service']) ?> · priority <?= (int) $p['priority'] ?></div></td><td class="right"><?php if (!$p['active']): ?><span class="pill">Not set up</span><?php elseif ((int) $p['fail_count'] >= 5): ?><span class="pill red">Failing</span><?php elseif ((int) $p['fail_count'] > 0): ?><span class="pill amber">Errors</span><?php else: ?><span class="pill green">Healthy</span><?php endif; ?></td></tr><?php endforeach; ?></tbody></table>
  </div>
  <div class="panel flush">
    <div class="panel-head"><h2>New customers</h2><a class="link small" href="/admin/orgs">All</a></div>
    <?php if (!$signups): ?><div class="empty">No sign-ups yet.</div><?php else: ?>
    <table class="tbl"><tbody><?php foreach ($signups as $s): ?><tr><td><a class="link" href="/admin/orgs/<?= (int) $s['id'] ?>"><?= e($s['name']) ?></a><div class="muted small"><?= e($s['email']) ?></div></td><td class="right"><?php $status = $s['live_enabled'] ? 'live' : 'sandbox'; ?><span class="pill <?= $s['live_enabled'] ? 'green' : 'violet' ?>"><?= $s['live_enabled'] ? 'Live' : 'Sandbox' ?></span></td></tr><?php endforeach; ?></tbody></table><?php endif; ?>
    <div style="padding:14px 20px;border-top:1px solid var(--line)" class="small muted">Support: <?= $desk['open'] ?> open · <?= $desk['ai_handled_30d'] ?> handled by AI in 30 days · <a class="link" href="/admin/desk">Open desk</a></div>
  </div>
</div>
