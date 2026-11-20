<?php
$play = $_SESSION['playground'] ?? null;
unset($_SESSION['playground']);
$postEndpoints = array_values(array_filter($s['endpoints'], fn($ep) => $ep[0] === 'POST' && !str_contains($ep[1], '{')));
$first = $postEndpoints[0] ?? null;
$sample = $first ? json_encode($first[5], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) : '{}';
if ($svc === 'ai' && $first) $sample = json_encode(['provider' => 'anthropic', 'model' => 'claude-opus-5-5', 'messages' => [['role' => 'user', 'content' => 'Write a one-line welcome message for new customers.']]], JSON_PRETTY_PRINT);
?>
<div class="grid cols-3">
  <div class="panel span-2">
    <div class="panel-head"><h2><?= e($s['name']) ?></h2><span class="pill <?= ['live' => 'green', 'beta' => 'amber', 'soon' => 'blue'][$s['status']] ?? '' ?>"><?= e(Catalog::statusLabel($s['status']) ?? 'Available') ?></span></div>
    <p class="muted"><?= e($s['summary']) ?></p>
    <p class="muted small" style="margin-top:8px"><?= e($s['intro']) ?></p>
    <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap"><a class="btn btn-ghost btn-sm" href="/docs/<?= e($svc) ?>" target="_blank" rel="noopener">Read the <?= e($s['name']) ?> docs</a></div>
  </div>
  <div class="panel">
    <h2>Your prices</h2>
    <?php if ($svc === 'ai'): ?>
      <p class="muted small" style="margin:10px 0">Per million tokens, in rand, excl. VAT.</p>
      <table class="tbl"><tbody><?php foreach (Catalog::aiModels() as $m): $p = Catalog::aiPrice($m); ?><tr><td class="small"><?= e($m['label']) ?></td><td class="right mono small"><?= zar($p['in'], 2) ?> / <?= zar($p['out'], 2) ?></td></tr><?php endforeach; ?></tbody></table>
    <?php elseif ($rates): ?>
      <table class="tbl" style="margin-top:8px"><tbody><?php foreach ($rates as $r): ?><tr><td class="small"><?= e($r['label']) ?></td><td class="right mono small nowrap"><?= zar($r['price'], $r['price'] < 1 ? 3 : 2) ?></td></tr><?php endforeach; ?></tbody></table>
      <?php if ((int) $plan['discount_pct']): ?><p class="muted small" style="margin-top:8px">Includes your <?= (int) $plan['discount_pct'] ?>% plan discount.</p><?php endif; ?>
    <?php endif; ?>
  </div>
</div>

<?php if ($svc === 'sms'): ?>
<div class="panel" style="margin-top:14px">
  <div class="panel-head"><h2>Sender ID</h2><?php $status = $org['sms_sender_status']; require APP_DIR . '/views/partials/status.php'; ?></div>
  <p class="muted small">Your brand name in the "from" field, up to 11 letters and numbers. Without one, live messages use a shared number.</p>
  <form method="post" class="toolbar" style="margin-top:12px"><?= csrf_field() ?><input type="hidden" name="action" value="sender"><input name="sender" maxlength="11" placeholder="e.g. ACMESTORE" value="<?= e($org['sms_sender']) ?>" pattern="[A-Za-z0-9 ]{3,11}" required><button class="btn btn-primary btn-sm">Request approval</button></form>
</div>
<?php elseif ($svc === 'mail'): ?>
<div class="panel" style="margin-top:14px">
  <div class="panel-head"><h2>Sending domain</h2><?php $status = $org['mail_domain_status']; require APP_DIR . '/views/partials/status.php'; ?></div>
  <form method="post" class="toolbar"><?= csrf_field() ?><input type="hidden" name="action" value="domain"><input name="domain" placeholder="yourcompany.co.za" value="<?= e($org['mail_domain']) ?>" required><button class="btn btn-primary btn-sm">Save domain</button></form>
  <?php if ($org['mail_domain']): ?>
  <p class="muted small">Add these DNS records at your domain host. We email you the three DKIM records once the domain is registered with our mail partner.</p>
  <div class="tbl-wrap"><table class="tbl" style="margin-top:8px"><thead><tr><th>Type</th><th>Name</th><th>Value</th></tr></thead><tbody>
    <tr><td>TXT</td><td class="mono small"><?= e($org['mail_domain']) ?></td><td class="mono small">v=spf1 include:amazonses.com ~all</td></tr>
    <tr><td>TXT</td><td class="mono small">_dmarc.<?= e($org['mail_domain']) ?></td><td class="mono small">v=DMARC1; p=none; rua=mailto:dmarc@<?= e($org['mail_domain']) ?></td></tr>
  </tbody></table></div><?php endif; ?>
</div>
<?php elseif ($svc === 'whatsapp'): ?>
<div class="grid cols-2" style="margin-top:14px">
  <div class="panel flush">
    <div class="panel-head"><h2>Your WhatsApp numbers</h2><span class="muted"><?= count($numbers) ?> of <?= (int) $plan['wa_numbers'] ?> on your plan</span></div>
    <div class="tbl-wrap"><table class="tbl"><tbody>
      <?php foreach ($numbers as $n): ?><tr><td class="mono"><?= e($n['phone']) ?></td><td><?= e($n['display_name']) ?></td><td class="right"><?php $status = $n['status']; require APP_DIR . '/views/partials/status.php'; ?></td></tr><?php endforeach; ?>
      <?php if (!$numbers): ?><tr><td class="empty">No numbers yet. Sandbox works without one.</td></tr><?php endif; ?>
    </tbody></table></div>
  </div>
  <div class="panel">
    <h2>Connect a number</h2>
    <p class="muted small" style="margin:8px 0 12px">The number must not be in use on the WhatsApp app. We register it with Meta and email you when it's live, usually in 2 working days. <?= zar(Billing::price($org, 'wa_number')['price'], 0) ?> a month per number.</p>
    <form method="post" class="form"><?= csrf_field() ?><input type="hidden" name="action" value="wa_number">
      <div class="row"><div class="field"><label>Number</label><input name="phone" placeholder="+27105550123" required></div><div class="field"><label>Display name</label><input name="display_name" placeholder="<?= e($org['name']) ?>" required></div></div>
      <button class="btn btn-primary btn-sm">Submit number</button></form>
  </div>
</div>
<div class="panel flush" style="margin-top:14px">
  <div class="panel-head"><h2>Inbound messages</h2><span class="muted">Also forwarded to your webhook and opened as Desk tickets</span></div>
  <?php if (!$inbound): ?><div class="empty">No inbound messages yet. In sandbox, send a text to +27000000001 to get a simulated reply.</div><?php else: ?>
  <div class="tbl-wrap"><table class="tbl"><tbody><?php foreach ($inbound as $m): $meta = json_decode((string) $m['meta'], true) ?: []; ?><tr><td class="mono small"><?= e($m['from_addr']) ?></td><td><?= e($meta['text'] ?? '') ?></td><td class="muted small nowrap"><?= e(date('j M H:i', strtotime($m['created_at'] . ' UTC'))) ?></td></tr><?php endforeach; ?></tbody></table></div><?php endif; ?>
</div>
<?php elseif ($svc === 'verify'): ?>
<div class="panel" style="margin-top:14px">
  <div class="panel-head"><h2>Business verification (KYB)</h2><?php $status = $org['kyb_status']; require APP_DIR . '/views/partials/status.php'; ?></div>
  <p class="muted small">Live identity checks process personal information, so we confirm who you are and why you need them (POPIA). We review within one working day.</p>
  <?php if (in_array($org['kyb_status'], ['none', 'rejected'], true)): ?>
  <form method="post" class="form" style="margin-top:12px"><?= csrf_field() ?><input type="hidden" name="action" value="kyb">
    <div class="row"><div class="field"><label>Company registration number</label><input name="company_reg" placeholder="2027/123456/07" value="<?= e($org['company_reg']) ?>" required></div><div class="field"><label>Registered address</label><input name="address" value="<?= e($org['address']) ?>" required></div></div>
    <div class="field"><label>Why you need identity checks</label><textarea name="use_case" required placeholder="e.g. We verify tenants before they sign a lease."><?= e($org['use_case']) ?></textarea></div>
    <button class="btn btn-primary btn-sm">Submit for review</button></form>
  <?php endif; ?>
</div>
<?php elseif ($svc === 'ai'): ?>
<?php $cap = Billing::aiCap($org); $pct = $cap > 0 ? min(100, round($aiSpent / $cap * 100)) : 0; ?>
<div class="grid cols-2" style="margin-top:14px">
  <div class="panel">
    <div class="panel-head"><h2>Spending limits</h2><span class="muted">Protects you from runaway costs</span></div>
    <div class="stat"><div class="k">Spent this month</div><div class="v"><?= zar($aiSpent) ?> <span class="muted" style="font-size:15px">of <?= zar($cap, 0) ?></span></div><div class="meter <?= $pct >= 90 ? 'bad' : ($pct >= 70 ? 'warn' : '') ?>"><i style="width:<?= $pct ?>%"></i></div></div>
    <form method="post" class="form" style="margin-top:16px"><?= csrf_field() ?><input type="hidden" name="action" value="ai_limits">
      <div class="row">
        <div class="field"><label>Monthly cap (R)</label><input name="ai_monthly_cap" type="number" min="0" step="1" max="<?= (float) $plan['ai_monthly_cap'] ?>" value="<?= e($org['ai_monthly_cap'] !== null ? (float) $org['ai_monthly_cap'] : '') ?>" placeholder="Plan maximum <?= (int) $plan['ai_monthly_cap'] ?>"></div>
        <div class="field"><label>Longest reply (tokens)</label><input name="ai_max_tokens" type="number" min="16" max="<?= (int) $plan['ai_max_tokens'] ?>" value="<?= e($org['ai_max_tokens'] ?? '') ?>" placeholder="Plan maximum <?= (int) $plan['ai_max_tokens'] ?>"></div>
      </div>
      <p class="muted small">Your plan allows up to <?= zar($plan['ai_monthly_cap'], 0) ?> a month, <?= number_format((int) $plan['ai_max_tokens']) ?> tokens per reply and <?= (int) $plan['ai_rpm'] ?> requests a minute. Requests that would pass the cap are refused before any cost is incurred.</p>
      <button class="btn btn-primary btn-sm">Save limits</button>
    </form>
  </div>
  <div class="panel">
    <?php $edit = $agents[0] ?? null; ?>
    <div class="panel-head"><h2>AI support agent</h2><?php if ($edit): ?><span class="mono small muted"><?= e($edit['public_id']) ?></span><?php endif; ?></div>
    <p class="muted small" style="margin-bottom:12px">Answers your customers in Desk, WhatsApp and the chat widget from your help centre and the notes below, and hands over to your team when it should.</p>
    <form method="post" class="form"><?= csrf_field() ?><input type="hidden" name="action" value="agent"><input type="hidden" name="id" value="<?= (int) ($edit['id'] ?? 0) ?>">
      <div class="row"><div class="field"><label>Name</label><input name="name" value="<?= e($edit['name'] ?? 'Support agent') ?>"></div>
      <div class="field"><label>Model</label><select name="model" onchange="this.form.provider.value=this.selectedOptions[0].dataset.p"><?php foreach (Catalog::aiModels() as $m): ?><option data-p="<?= e($m['provider']) ?>" value="<?= e($m['model']) ?>" <?= ($edit['model'] ?? 'claude-opus-5-5') === $m['model'] ? 'selected' : '' ?>><?= e($m['label']) ?></option><?php endforeach; ?></select><input type="hidden" name="provider" value="<?= e($edit['provider'] ?? 'anthropic') ?>"></div></div>
      <div class="field"><label>Instructions</label><textarea name="instructions" placeholder="Tone, what to help with, what never to promise."><?= e($edit['instructions'] ?? '') ?></textarea></div>
      <div class="field"><label>Extra knowledge</label><textarea name="knowledge" placeholder="Opening hours, delivery areas, returns policy..."><?= e($edit['knowledge'] ?? '') ?></textarea></div>
      <label class="consent"><input type="checkbox" name="handover" value="1" <?= !$edit || $edit['handover'] ? 'checked' : '' ?>><span>Hand over to my team when needed</span></label>
      <label class="consent"><input type="checkbox" name="active" value="1" <?= !$edit || $edit['active'] ? 'checked' : '' ?>><span>Agent is on</span></label>
      <button class="btn btn-primary btn-sm">Save agent</button></form>
  </div>
</div>
<?php endif; ?>

<?php if ($first): ?>
<div class="panel" style="margin-top:14px">
  <div class="panel-head"><h2>Try it in sandbox</h2><span class="muted">Runs a real request with your sandbox environment. Free.</span></div>
  <form method="post" class="grid cols-2" style="align-items:start"><?= csrf_field() ?><input type="hidden" name="action" value="try">
    <div class="form">
      <div class="field"><label>Endpoint</label><select name="endpoint"><?php foreach ($s['endpoints'] as $ep): if (str_contains($ep[1], '{')) continue; ?><option <?= ($play['endpoint'] ?? '') === $ep[0] . ' ' . $ep[1] ? 'selected' : '' ?>><?= e($ep[0] . ' ' . $ep[1]) ?></option><?php endforeach; ?></select></div>
      <div class="field"><label>Request body (JSON)</label><textarea class="code" name="payload" rows="10"><?= e($play['payload'] ?? $sample) ?></textarea></div>
      <button class="btn btn-primary btn-sm">Send request</button>
    </div>
    <div class="field"><label>Response <?= $play ? '<span class="pill ' . ($play['status'] < 300 ? 'green' : 'red') . '">' . (int) $play['status'] . '</span>' : '' ?></label>
      <pre class="snippet" style="min-height:250px"><?= e($play['response'] ?? 'Send a request to see the response here.') ?></pre></div>
  </form>
</div>
<?php endif; ?>

<div class="panel flush" style="margin-top:14px">
  <div class="panel-head"><h2>Recent <?= e($s['name']) ?> activity</h2><a class="link small" href="/dashboard/usage?service=<?= e($svc) ?>">All</a></div>
  <?php if (!$recent): ?><div class="empty">Nothing yet.</div><?php else: ?>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>ID</th><th>Env</th><th>To / from</th><th>Status</th><th class="right">Amount</th><th>Time</th></tr></thead><tbody>
  <?php foreach ($recent as $m): ?><tr><td class="mono small"><?= e($m['public_id']) ?></td><td><span class="pill <?= $m['env'] === 'live' ? 'green' : 'violet' ?>"><?= $m['env'] === 'live' ? 'Live' : 'Sandbox' ?></span></td><td class="small"><?= e($m['direction'] === 'in' ? $m['from_addr'] : $m['to_addr']) ?></td><td><?php $status = $m['status']; require APP_DIR . '/views/partials/status.php'; ?></td><td class="right mono small"><?= zar($m['amount'], 3) ?></td><td class="muted small nowrap"><?= e(date('j M H:i', strtotime($m['created_at'] . ' UTC'))) ?></td></tr><?php endforeach; ?>
  </tbody></table></div><?php endif; ?>
</div>
