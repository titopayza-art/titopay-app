<h2 id="compare">Sandbox and live side by side</h2>
<table class="params">
  <tr><td></td><td><b>Sandbox</b> <code>sg_test_</code></td><td><b>Live</b> <code>sg_live_</code></td></tr>
  <tr><td>Messages</td><td class="muted">Simulated. Nothing leaves SeaGeek.</td><td class="muted">Sent through our network partners, with automatic failover.</td></tr>
  <tr><td>Charges</td><td class="muted">Free. <code>amount</code> is always 0.</td><td class="muted">Charged from your credit at your plan's rates.</td></tr>
  <tr><td>Statuses and webhooks</td><td class="muted">Move through real statuses after a few seconds, with webhooks.</td><td class="muted">Follow real delivery receipts from the networks.</td></tr>
  <tr><td>Products</td><td class="muted">Every product, switched on or not.</td><td class="muted">Only products switched on under Services.</td></tr>
</table>

<h2 id="test-values">Test values per product</h2>
<table class="params">
  <?php foreach (Catalog::services() as $k => $sv): if (!$sv['sandbox']) continue; ?>
    <tr><td><a class="link" href="/docs/<?= $k ?>"><?= e($sv['name']) ?></a></td><td class="muted"><?= e($sv['sandbox']) ?></td></tr>
  <?php endforeach; ?>
</table>

<h2 id="checklist">Go-live checklist</h2>
<ol class="docs-checklist">
  <li>Email address confirmed and company phone number added under Settings.</li>
  <li>First payment made: card, Instant EFT, or bank transfer with your 6-digit customer number as the reference.</li>
  <li>Each product you use switched on under Services, plus its own requirement (below).</li>
  <li>Live key created and stored on your server. Sandbox key removed from production.</li>
  <li>Webhook endpoint set and verifying signatures, if you use webhooks.</li>
  <li>Retries use an <code>Idempotency-Key</code>, so a timeout never sends twice.</li>
</ol>
<table class="params">
  <?php foreach (Catalog::services() as $k => $sv): if ($sv['status'] === 'planned') continue; $req = array_slice(Docs::requirements($k), 1); if (!$req) continue; ?>
    <tr><td><?= e($sv['name']) ?></td><td class="muted"><?= e(implode(' ', $req)) ?></td></tr>
  <?php endforeach; ?>
</table>
