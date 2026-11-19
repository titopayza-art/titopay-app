<p>These endpoints work for every account and every key.</p>
<?php
$acct = ['id' => 2, 'customer_no' => '807960', 'name' => 'Acme Stores', 'environment' => 'live', 'status' => 'active', 'plan' => 'Growth', 'services' => ['sms' => 'active', 'mail' => 'active', 'verify' => 'pending', 'qr' => 'inactive'], 'limits' => ['requests_per_second' => 50, 'ai_requests_per_minute' => 120, 'ai_max_tokens' => 8192, 'ai_monthly_cap' => 8000]];
$samples = [
    ['GET', '/v1/account', 'Your account', 'Organisation, customer number, plan, which services are switched on, and your limits.', $acct],
    ['GET', '/v1/balance', 'Credit balance', 'Credit in rand and this month\'s AI spend against your cap.', ['balance' => 15740, 'credit_limit' => 0, 'currency' => 'ZAR', 'ai_spent_this_month' => 312.4, 'ai_monthly_cap' => 8000]],
    ['GET', '/v1/usage', 'Usage records', 'Filters: service, from and to (YYYY-MM-DD), limit (up to 500). Newest first.', ['data' => [['id' => 'msg_8Kq2vXr1Pz', 'service' => 'sms', 'status' => 'delivered', 'amount' => 0.261, 'created_at' => '2026-11-18T09:15:02+00:00']], 'total_amount' => 0.261]],
    ['GET', '/v1/messages/{id}', 'Any message by ID', 'Works for SMS, email, WhatsApp, calls, checks and QR codes.', ['id' => 'msg_8Kq2vXr1Pz', 'service' => 'sms', 'status' => 'delivered', 'to' => '+27821234567', 'amount' => 0.261, 'currency' => 'ZAR']],
];
foreach ($samples as $i => [$m, $p, $t, $d, $resp]): ?>
<section class="endpoint" id="ep-<?= $i ?>">
  <div class="endpoint-head"><span class="method m-<?= strtolower($m) ?>"><?= $m ?></span><code>/api<?= e($p) ?></code><h3><?= e($t) ?></h3></div>
  <div class="endpoint-body">
    <div><p class="muted"><?= e($d) ?></p><pre class="snippet" style="margin-top:12px">curl https://www.seageek.co.za/api<?= e(str_replace('{id}', 'msg_8Kq2vXr1Pz', $p)) ?> \
  -H "Authorization: Bearer $SEAGEEK_KEY"</pre></div>
    <div><p class="snippet-label" style="margin-top:0">Response</p><pre class="snippet"><?= e(json_encode($resp, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)) ?></pre></div>
  </div>
</section>
<?php endforeach; ?>
