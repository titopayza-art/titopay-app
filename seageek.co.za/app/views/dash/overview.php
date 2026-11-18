<?php
$u = Auth::user();
$steps = [
    ['Confirm your email', (bool) $u['email_verified_at']],
    ['Get a sandbox key and send a test request', (bool) DB::value("SELECT COUNT(*) FROM messages WHERE org_id = ? AND env = 'test'", [$org['id']])],
    ['Add your company phone number', (bool) $org['phone']],
    ['Add credit to switch on live keys', (bool) $org['live_enabled']],
];
$done = count(array_filter(array_column($steps, 1)));
$monthTotal = array_sum(array_map(fn($r) => (float) $r['a'], $byService));
$monthCount = array_sum(array_map(fn($r) => (int) $r['c'], $byService));
$aiPct = $aiCap > 0 ? min(100, round($aiSpent / $aiCap * 100)) : 0;
?>
<?php foreach ($unpaid as $inv): ?>
  <div class="alert alert-warn">Invoice <b><?= e($inv['number']) ?></b> for <?= zar($inv['total']) ?> is due <?= e(date('j M Y', strtotime($inv['due_at']))) ?>. <a class="link" href="/dashboard/billing">Pay now</a></div>
<?php endforeach; ?>

<div class="toolbar" style="justify-content:space-between">
  <div class="env-switch"><a href="?env=test" class="<?= $env === 'test' ? 'on' : '' ?>">Sandbox</a><a href="?env=live" class="<?= $env === 'live' ? 'on live' : '' ?>">Live</a></div>
  <span class="muted small"><?= e($org['name']) ?> · <?= e($plan['name']) ?> plan<?= $org['plan_renews_at'] ? ' · renews ' . e(date('j M', strtotime($org['plan_renews_at']))) : '' ?></span>
</div>

<div class="grid cols-4">
  <div class="panel stat"><div class="k">Credit balance</div><div class="v"><?= zar($org['balance']) ?></div><div class="d">Alert below <?= zar($org['low_balance'], 0) ?></div></div>
  <div class="panel stat"><div class="k"><?= $env === 'live' ? 'Spend' : 'Requests' ?> this month</div><div class="v"><?= $env === 'live' ? zar($monthTotal) : number_format($monthCount) ?></div><div class="d"><?= number_format($monthCount) ?> requests in <?= $env === 'live' ? 'live' : 'sandbox' ?></div></div>
  <div class="panel stat"><div class="k">AI spend this month</div><div class="v"><?= zar($aiSpent) ?></div><div class="meter <?= $aiPct >= 90 ? 'bad' : ($aiPct >= 70 ? 'warn' : '') ?>"><i style="width:<?= $aiPct ?>%"></i></div><div class="d"><?= $aiPct ?>% of your <?= zar($aiCap, 0) ?> cap</div></div>
  <div class="panel stat"><div class="k">Open tickets</div><div class="v"><?= $desk['open'] ?></div><div class="d"><?= $desk['ai_handled_30d'] ?> handled by AI in 30 days</div></div>
</div>

<div class="grid cols-3" style="margin-top:14px">
  <div class="panel span-2">
    <div class="panel-head"><h2>Requests, last 30 days</h2><span class="muted"><?= $env === 'live' ? 'Live' : 'Sandbox' ?></span></div>
    <?php $series = $series; $metric = 'count'; require APP_DIR . '/views/partials/chart.php'; ?>
  </div>
  <div class="panel">
    <?php if ($done < count($steps)): ?>
      <div class="panel-head"><h2>Get started</h2><span class="muted"><?= $done ?> of <?= count($steps) ?></span></div>
      <ul class="checklist">
        <?php foreach ($steps as [$label, $ok]): ?><li class="<?= $ok ? 'done' : '' ?>"><span class="tick"><?= $ok ? '✓' : '' ?></span><span><?= e($label) ?></span></li><?php endforeach; ?>
      </ul>
      <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap"><a class="btn btn-primary btn-sm" href="/dashboard/keys">API keys</a><a class="btn btn-ghost btn-sm" href="/docs">Quickstart</a></div>
    <?php else: ?>
      <div class="panel-head"><h2>Plan limits</h2><a class="link small" href="/dashboard/billing">Change plan</a></div>
      <dl class="kv">
        <dt>Requests</dt><dd><?= (int) $plan['api_rps'] ?> a second</dd>
        <dt>AI requests</dt><dd><?= (int) $plan['ai_rpm'] ?> a minute</dd>
        <dt>AI reply length</dt><dd><?= number_format((int) $plan['ai_max_tokens']) ?> tokens</dd>
        <dt>Desk agents</dt><dd><?= (int) $plan['desk_agents'] ?></dd>
        <dt>Usage discount</dt><dd><?= (int) $plan['discount_pct'] ?>%</dd>
      </dl>
    <?php endif; ?>
  </div>
</div>

<div class="panel" style="margin-top:14px">
  <div class="panel-head"><h2>Your environments</h2><span class="muted">Every product, sandbox and live, on one account</span></div>
  <div class="svc-grid">
    <?php foreach (Catalog::services() as $k => $s): if ($s['status'] === 'planned') continue;
      $c = (int) ($byService[$k]['c'] ?? 0);
      $ready = match ($k) {
          'sms' => $org['sms_sender_status'] === 'approved' ? 'Sender ID approved' : 'Shared sender',
          'mail' => $org['mail_domain_status'] === 'verified' ? 'Domain verified' : 'Shared domain',
          'whatsapp' => DB::value("SELECT COUNT(*) FROM wa_numbers WHERE org_id = ? AND status = 'active'", [$org['id']]) ? 'Number active' : 'Connect a number',
          'verify' => $org['kyb_status'] === 'approved' ? 'KYB approved' : 'KYB needed for live',
          'ai' => 'Cap ' . zar($aiCap, 0),
          'desk' => $desk['open'] . ' open tickets',
          default => 'Ready',
      }; ?>
      <a class="svc" href="<?= $k === 'desk' ? '/dashboard/desk' : '/dashboard/service/' . $k ?>">
        <span class="top"><?= icon($s['icon']) ?><?php $status = $org['live_enabled'] && $org['status'] === 'active' ? 'live' : 'sandbox'; ?><span class="pill <?= $status === 'live' ? 'green' : 'violet' ?>"><?= $status === 'live' ? 'Live' : 'Sandbox' ?></span></span>
        <b><?= e($s['name']) ?></b>
        <span class="n"><?= number_format($c) ?> this month · <?= e($ready) ?></span>
      </a>
    <?php endforeach; ?>
  </div>
</div>

<div class="panel flush" style="margin-top:14px">
  <div class="panel-head"><h2>Latest requests</h2><a class="link small" href="/dashboard/usage?env=<?= $env ?>">All usage</a></div>
  <?php if (!$recent): ?><div class="empty">No requests in <?= $env === 'live' ? 'live' : 'sandbox' ?> yet. Try the quickstart in the <a class="link" href="/docs">API docs</a>.</div><?php else: ?>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>ID</th><th>Product</th><th>To</th><th>Status</th><th class="right">Amount</th><th>Time</th></tr></thead><tbody>
    <?php foreach ($recent as $m): ?><tr><td class="mono small"><?= e($m['public_id']) ?></td><td><?= e(service_names()[$m['service']] ?? $m['service']) ?></td><td class="small"><?= e($m['to_addr'] ?: $m['from_addr']) ?></td><td><?php $status = $m['status']; require APP_DIR . '/views/partials/status.php'; ?></td><td class="right mono small"><?= zar($m['amount'], 3) ?></td><td class="muted small nowrap"><?= e(date('j M H:i', strtotime($m['created_at'] . ' UTC'))) ?></td></tr><?php endforeach; ?>
  </tbody></table></div><?php endif; ?>
</div>
