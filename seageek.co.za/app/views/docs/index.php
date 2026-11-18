<div class="wrap docs-shell">
  <?php require APP_DIR . '/views/docs/_side.php'; ?>
  <div>
    <h1 style="font-size:clamp(34px,4.6vw,52px)">API documentation</h1>
    <p class="lead" style="margin-top:14px">One REST API for every SeaGeek product. JSON in and out, the same errors everywhere, signed webhooks and safe retries.</p>

    <h2 style="margin-top:44px;font-size:26px">Base URL and keys</h2>
    <p class="muted" style="margin-top:8px">All requests go to <code>https://www.seageek.co.za/api/v1</code> over HTTPS. Send your key in the Authorization header. Keys starting <code>sg_test_</code> use the free sandbox; <code>sg_live_</code> keys send for real and are billed from your credit.</p>
    <pre class="snippet" style="margin-top:12px">curl https://www.seageek.co.za/api/v1/balance \
  -H "Authorization: Bearer sg_test_your_key"</pre>

    <h2 style="margin-top:40px;font-size:26px">Products</h2>
    <div class="grid cols-3" style="margin-top:16px">
      <?php foreach ($services as $k => $sv): ?><a class="svc" href="/docs/<?= $k ?>"><span class="top"><?= icon($sv['icon']) ?><span class="pill <?= $sv['status'] === 'live' ? 'green' : ($sv['status'] === 'beta' ? 'amber' : '') ?>"><?= ucfirst($sv['status'] === 'live' ? 'Available' : $sv['status']) ?></span></span><b><?= e($sv['name']) ?></b><span class="muted small"><?= e($sv['summary']) ?></span></a><?php endforeach; ?>
    </div>

    <h2 style="margin-top:44px;font-size:26px">Account endpoints</h2>
    <table class="params" style="margin-top:10px"><?php foreach (Catalog::platformEndpoints() as [$m, $p, $d]): ?><tr><td><span class="method m-<?= strtolower($m) ?>"><?= $m ?></span> <code><?= e($p) ?></code></td><td class="muted"><?= e($d) ?></td></tr><?php endforeach; ?></table>

    <h2 style="margin-top:44px;font-size:26px">Errors</h2>
    <p class="muted" style="margin-top:8px">Errors return the HTTP status below and a body like <code>{"error": {"type": "insufficient_balance", "message": "..."}, "request_id": "req_..."}</code>. Quote the request ID when you contact support.</p>
    <table class="params" style="margin-top:10px">
      <?php foreach ([['400', 'invalid_json', 'The body is not valid JSON.'], ['401', 'authentication_error', 'Missing, invalid or revoked key.'], ['402', 'insufficient_balance / account_locked', 'Not enough credit, or live access is paused for an unpaid invoice.'], ['403', 'live_not_enabled / kyb_required', 'Live access or business verification still needed.'], ['404', 'not_found', 'No such endpoint or object.'], ['409', '–', 'Not used. Repeated Idempotency-Keys replay the first response instead.'], ['422', 'missing_parameter, invalid_number, …', 'A parameter is missing or wrong. Nothing was charged.'], ['429', 'rate_limited / ai_cap_reached / ai_rate_limited', 'Slow down, or your AI spending cap was reached.'], ['5xx', 'api_error / provider_error', 'A problem on our side or at a partner. Retry with the same Idempotency-Key.']] as [$c, $t, $d]): ?>
      <tr><td><code><?= $c ?></code><span class="type"><?= e($t) ?></span></td><td class="muted"><?= e($d) ?></td></tr><?php endforeach; ?>
    </table>

    <h2 style="margin-top:44px;font-size:26px">Idempotency</h2>
    <p class="muted" style="margin-top:8px">Add <code>Idempotency-Key: your-unique-value</code> to any POST. If you retry with the same key, we return the first response and do not send or charge again.</p>

    <h2 style="margin-top:44px;font-size:26px">Webhooks</h2>
    <p class="muted" style="margin-top:8px">Set your endpoint in the dashboard. Each event is a POST with a JSON body and a <code>SeaGeek-Signature: t=TIMESTAMP,v1=HMAC</code> header, where HMAC is SHA-256 of <code>TIMESTAMP.BODY</code> using your signing secret. Reply with any 2xx status. We retry for 24 hours.</p>
    <pre class="snippet" style="margin-top:12px">// PHP
[$t, $v1] = sscanf($_SERVER['HTTP_SEAGEEK_SIGNATURE'], 't=%d,v1=%s');
$body = file_get_contents('php://input');
$ok = hash_equals(hash_hmac('sha256', $t . '.' . $body, getenv('SEAGEEK_WEBHOOK_SECRET')), $v1)
   &amp;&amp; abs(time() - $t) &lt; 300;</pre>
    <p class="muted small" style="margin-top:10px">Events: message.delivered, message.read, message.failed, whatsapp.inbound, verify.completed, desk.ticket_created, desk.handover, ping.</p>

    <h2 style="margin-top:44px;font-size:26px">Limits</h2>
    <p class="muted" style="margin-top:8px">Request rates, AI spending caps and the longest AI reply depend on your plan (see <code>GET /v1/account</code>). The AI cap is checked before each AI request, so you are never charged past it.</p>
  </div>
</div>
