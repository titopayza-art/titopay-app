<h2 id="setup">Set your endpoint</h2>
<p>Add an HTTPS URL under <b>Webhooks</b> in the dashboard and copy the signing secret. Use <b>Send test event</b> to receive a <code>ping</code> and check your code.</p>

<h2 id="delivery">What we send</h2>
<p>Each event is a <code>POST</code> with a JSON body and these headers:</p>
<table class="params">
  <tr><td><code>SeaGeek-Signature</code></td><td class="muted"><code>t=TIMESTAMP,v1=HMAC</code>. HMAC is SHA-256 of <code>TIMESTAMP.BODY</code> with your signing secret, in hex.</td></tr>
  <tr><td><code>SeaGeek-Event</code></td><td class="muted">The event type, such as <code>message.delivered</code>.</td></tr>
  <tr><td><code>Content-Type</code></td><td class="muted"><code>application/json</code></td></tr>
</table>
<p>Reply with any <code>2xx</code> status within 10 seconds. Do slow work after you reply.</p>

<h2 id="verify">Verify the signature</h2>
<?php $codeTabs = [
  'PHP' => "[\$t, \$v1] = sscanf(\$_SERVER['HTTP_SEAGEEK_SIGNATURE'] ?? '', 't=%d,v1=%s');\n\$body = file_get_contents('php://input');\n\$expected = hash_hmac('sha256', \$t . '.' . \$body, getenv('SEAGEEK_WEBHOOK_SECRET'));\nif (!hash_equals(\$expected, (string) \$v1) || abs(time() - \$t) > 300) {\n    http_response_code(400);\n    exit;\n}\n\$event = json_decode(\$body, true);",
  'Node.js' => "import crypto from \"node:crypto\";\n\n// Use the raw body, before any JSON parsing\nfunction verify(rawBody, header, secret) {\n  const [, t, v1] = header.match(/t=(\\d+),v1=([a-f0-9]+)/) || [];\n  const expected = crypto.createHmac(\"sha256\", secret).update(`\${t}.\${rawBody}`).digest(\"hex\");\n  const fresh = Math.abs(Date.now() / 1000 - Number(t)) < 300;\n  return fresh && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1 || \"\"));\n}",
  'Python' => "import hmac, hashlib, re, time\n\ndef verify(raw_body: bytes, header: str, secret: str) -> bool:\n    m = re.match(r\"t=(\\d+),v1=([a-f0-9]+)\", header or \"\")\n    if not m:\n        return False\n    t, v1 = m.groups()\n    expected = hmac.new(secret.encode(), f\"{t}.\".encode() + raw_body, hashlib.sha256).hexdigest()\n    return hmac.compare_digest(expected, v1) and abs(time.time() - int(t)) < 300",
]; require __DIR__ . '/../_code.php'; ?>

<h2 id="retries">Retries</h2>
<p>If your endpoint does not answer with <code>2xx</code>, we try again after 1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours, 12 hours and 24 hours: 8 attempts over about two days. Every attempt and response code is listed under Webhooks in the dashboard. Events can arrive more than once or out of order, so use the event <code>id</code> to ignore repeats.</p>

<h2 id="events">Events</h2>
<?php foreach (Docs::events() as $e => $desc): ?>
  <h3 id="<?= e(str_replace('.', '-', $e)) ?>"><code><?= e($e) ?></code></h3>
  <p class="muted"><?= e($desc) ?></p>
  <pre class="snippet"><?= e(json_encode(Docs::eventExample($e), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)) ?></pre>
<?php endforeach; ?>
