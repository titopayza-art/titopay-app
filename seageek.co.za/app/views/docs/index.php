<?php
$slug = 'overview';
$pageTitle = 'SeaGeek API documentation';
$lead = 'One REST API for messaging, identity, AI, QR codes and customer service in South Africa. JSON in and out, the same errors everywhere, signed webhooks and safe retries. Everything is billed in rand from one credit balance.';
require __DIR__ . '/_top.php';
$groups = ['Messaging' => ['sms', 'mail', 'whatsapp', 'voice'], 'Identity and security' => ['auth', 'verify'], 'AI and service' => ['ai', 'desk'], 'No-code tools' => ['stores', 'qr'], 'Coming in 2028' => ['notify', 'sign']];
?>
<div class="start-cards">
  <a href="/docs/quickstart" class="start-card"><b>Quickstart</b><span>Send your first SMS in five minutes, then go live.</span></a>
  <a href="/docs/authentication" class="start-card"><b>Authentication</b><span>Keys, the Authorization header and keeping keys safe.</span></a>
  <a href="/docs/environments" class="start-card"><b>Sandbox and live</b><span>Free testing with realistic results, and the go-live checklist.</span></a>
  <a href="/docs/webhooks" class="start-card"><b>Webhooks</b><span>Delivery receipts and inbound messages, signed and retried.</span></a>
</div>

<h2 id="base-url">Base URL</h2>
<p>All requests go to <code>https://www.seageek.co.za/api/v1</code> over HTTPS with your key in the <code>Authorization</code> header.</p>
<pre class="snippet">curl https://www.seageek.co.za/api/v1/balance \
  -H "Authorization: Bearer sg_test_your_key"</pre>

<?php foreach ($groups as $g => $keys): ?>
<h2 id="<?= e(trim(preg_replace('/[^a-z0-9]+/', '-', strtolower($g)), '-')) ?>"><?= e($g) ?></h2>
<div class="docs-products">
  <?php foreach ($keys as $k): $sv = Catalog::services()[$k]; ?>
    <a class="docs-product" href="/docs/<?= $k ?>">
      <span class="product-icon"><?= icon($sv['icon']) ?></span>
      <span><b><?= e($sv['name']) ?></b><?php if ($sv['status'] !== 'live'): ?> <small class="muted"><?= e((string) Catalog::statusLabel($sv['status'])) ?></small><?php endif; ?><span class="muted"><?= e($sv['summary']) ?></span></span>
    </a>
  <?php endforeach; ?>
</div>
<?php endforeach; ?>

<h2 id="conventions">Conventions</h2>
<table class="params">
  <tr><td>Format</td><td class="muted">JSON request and response bodies, UTF-8. Send <code>Content-Type: application/json</code>.</td></tr>
  <tr><td>Money</td><td class="muted">Amounts are numbers in rand (ZAR), excluding VAT, e.g. <code>0.29</code>.</td></tr>
  <tr><td>Phone numbers</td><td class="muted">E.164 such as <code>+27821234567</code>. Local formats like <code>082 123 4567</code> are converted for you.</td></tr>
  <tr><td>Times</td><td class="muted">ISO 8601 in UTC, e.g. <code>2026-11-18T09:15:02+00:00</code>.</td></tr>
  <tr><td>IDs</td><td class="muted">Strings with a prefix: <code>msg_</code> messages, <code>chk_</code> checks, <code>qr_</code> QR codes, <code>evt_</code> webhook events, <code>req_</code> requests.</td></tr>
  <tr><td>Versioning</td><td class="muted">The version is in the path (<code>/v1</code>). We add fields without notice but never remove or rename them within a version. See the <a class="link" href="/docs/changelog">changelog</a>.</td></tr>
</table>
<?php require __DIR__ . '/_bottom.php'; ?>
