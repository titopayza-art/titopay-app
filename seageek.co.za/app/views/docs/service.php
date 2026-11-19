<?php
$base = 'https://www.seageek.co.za/api';
$samples = function (array $ep) use ($base): array {
    [$m, $p, , , , $body] = $ep;
    $url = $base . str_replace(['{id}', '{token}'], ['msg_8Kq2vXr1Pz', 'YOUR_STORE_LINK_TOKEN'], $p);
    $hook = str_contains($p, '/hooks/');
    $json = $body ? json_encode($body, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) : null;
    $auth = $hook ? '' : " \\\n  -H \"Authorization: Bearer \$SEAGEEK_KEY\"";
    $curl = "curl" . ($m !== 'GET' ? " -X $m" : '') . " $url" . $auth . ($json ? " \\\n  -H \"Content-Type: application/json\" \\\n  -d '" . $json . "'" : '');
    $phpHeaders = $hook ? "['Content-Type: application/json']" : "['Authorization: Bearer ' . getenv('SEAGEEK_KEY'), 'Content-Type: application/json']";
    $php = "\$ch = curl_init('$url');\ncurl_setopt_array(\$ch, [\n    CURLOPT_RETURNTRANSFER => true,\n    CURLOPT_HTTPHEADER => $phpHeaders,\n" . ($json ? "    CURLOPT_POSTFIELDS => json_encode(" . var_export($body, true) . "),\n" : '') . "]);\n\$result = json_decode(curl_exec(\$ch), true);";
    $php = preg_replace("/array \(\n/", "[\n", str_replace(["\n)", "array (\n"], ["\n]", "[\n"], $php));
    $node = "const res = await fetch(\"$url\", {\n  method: \"$m\",\n  headers: {\n" . ($hook ? '' : "    Authorization: `Bearer \${process.env.SEAGEEK_KEY}`,\n") . "    \"Content-Type\": \"application/json\",\n  }," . ($json ? "\n  body: JSON.stringify(" . $json . "),\n" : "\n") . "});\nconst result = await res.json();";
    $py = "import os, requests\n\nres = requests." . strtolower($m) . "(\n    \"$url\"," . ($hook ? '' : "\n    headers={\"Authorization\": f\"Bearer {os.environ['SEAGEEK_KEY']}\"},") . ($json ? "\n    json=" . preg_replace(['/\btrue\b/', '/\bfalse\b/', '/\bnull\b/'], ['True', 'False', 'None'], $json) . "," : '') . "\n)\nresult = res.json()";
    return ['cURL' => $curl, 'PHP' => $php, 'Node.js' => $node, 'Python' => $py];
};
$pageTitle = $s['name'] . ($slug === 'stores' || $slug === 'qr' ? '' : ' API');
$lead = $s['summary'];
$badge = $s['status'] === 'live' ? null : ($s['status'] === 'beta' ? ['amber', 'Beta'] : ['', 'Planned']);
require __DIR__ . '/_top.php';
$req = Docs::requirements($slug);
?>
<p class="docs-intro"><?= e($s['intro']) ?></p>

<?php if ($s['status'] === 'planned'): ?>
  <div class="callout">This product is not available yet. Tell us what you need at <a class="link" href="mailto:hello@seageek.co.za">hello@seageek.co.za</a> and we will let you know when it opens.</div>
<?php else: ?>

<?php if ($req): ?>
<h2 id="requirements">Before you go live</h2>
<ul class="docs-checklist-plain"><?php foreach ($req as $r): ?><li><?= e($r) ?></li><?php endforeach; ?></ul>
<?php endif; ?>

<h2 id="pricing">Pricing</h2>
<?php if ($slug === 'ai'): ?>
  <table class="params"><?php foreach (Catalog::aiModels() as $m): $p = Catalog::aiPrice($m); ?><tr><td><?= e($m['label']) ?><span class="type"><?= e($m['provider'] . ' / ' . $m['model']) ?></span></td><td class="mono"><?= zar($p['in']) ?> in · <?= zar($p['out']) ?> out <span class="muted">per million tokens</span></td></tr><?php endforeach; ?></table>
  <h3 id="ai-limits">Spending limits</h3>
  <table class="params"><tr><td>Monthly AI spending cap</td><td class="muted">R200 (Pay as you go) to R30,000 (Enterprise). Lower it yourself in the dashboard. Requests that could pass the cap return <code>429 ai_cap_reached</code> before anything is charged.</td></tr><tr><td>Longest reply</td><td class="muted">1,024 to 16,000 tokens by plan. Larger <code>max_tokens</code> values are reduced to your limit.</td></tr><tr><td>Requests per minute</td><td class="muted">10 to 300 by plan. Over the limit returns <code>429 ai_rate_limited</code>.</td></tr></table>
<?php elseif ($slug === 'desk'): ?>
  <p class="muted">Included in every plan. Agent seats: <?= e(implode(', ', array_map(fn($p) => $p['name'] . ' ' . (int) $p['desk_agents'], DB::all('SELECT name, desk_agents FROM plans WHERE active = 1 ORDER BY sort')))) ?>. AI agent replies are billed as AI usage.</p>
<?php elseif ($rates): ?>
  <table class="params"><?php foreach ($rates as $r): ?><tr><td><?= e($r['label']) ?></td><td class="mono"><?= zar($r['price'], $r['price'] < 1 ? 3 : 2) ?> <span class="muted"><?= e($r['per']) ?></span></td></tr><?php endforeach; ?></table>
  <p class="muted small" style="margin-top:6px">Standard rates excl. VAT, charged from your credit. Business, Growth and Enterprise plans get 5 to 15% off. <a class="link" href="/docs/billing">How billing works</a>.</p>
<?php endif; ?>

<?php if ($slug === 'stores'): ?>
<h2 id="platforms">Connect your platform</h2>
<table class="params">
  <tr><td>Shopify</td><td class="muted">Settings, Notifications, Webhooks. Create webhooks for Order creation, Order payment, Order fulfillment, Order cancellation, Refund create and Checkout creation, all pointing to your SeaGeek link, format JSON. Paste the signing secret Shopify shows into SeaGeek. Requests are checked with the <code>X-Shopify-Hmac-Sha256</code> header.</td></tr>
  <tr><td>WooCommerce</td><td class="muted">WooCommerce, Settings, Advanced, Webhooks. Two webhooks to your SeaGeek link with the secret SeaGeek gives you: topic Order created, and topic Order updated (processing means paid, completed means shipped, cancelled, refunded). Checked with <code>X-WC-Webhook-Signature</code>.</td></tr>
  <tr><td>Wix</td><td class="muted">Automations with the action Send HTTP request (webhook), sending the JSON shown below.</td></tr>
  <tr><td>Any other platform</td><td class="muted">POST the JSON below to your SeaGeek link. Optionally sign it with header <code>X-SeaGeek-Signature: sha256=HMAC</code> of the body using your store secret.</td></tr>
</table>
<h3 id="messages">Messages you can send</h3>
<table class="params"><?php foreach (Stores::events() as $k => [$label, $text, , $when]): ?><tr><td><?= e($label) ?><span class="type"><?= e($when) ?></span></td><td class="muted"><?= e($text) ?></td></tr><?php endforeach; ?></table>
<p class="muted small" style="margin-top:6px">Placeholders: <?= e(implode(', ', array_keys(Stores::placeholders()))) ?>. Each event sends at most once per order, even when the platform retries.</p>
<?php endif; ?>

<?php if ($s['endpoints']): ?>
<h2 id="endpoints">Endpoints</h2>
<table class="params ep-index"><?php foreach ($s['endpoints'] as $i => $ep): ?><tr><td><a class="link" href="#ep-<?= $i ?>"><span class="method m-<?= strtolower($ep[0]) ?>"><?= $ep[0] ?></span> <code>/api<?= e($ep[1]) ?></code></a></td><td class="muted"><?= e($ep[2]) ?></td></tr><?php endforeach; ?></table>
<?php foreach ($s['endpoints'] as $i => $ep): [$m, $p, $t, $d, $params, $body, $resp] = $ep; ?>
<section class="endpoint" id="ep-<?= $i ?>" data-toc-title="<?= e($t) ?>">
  <div class="endpoint-head"><span class="method m-<?= strtolower($m) ?>"><?= $m ?></span><code>/api<?= e($p) ?></code><h3><?= e($t) ?></h3></div>
  <div class="endpoint-body">
    <div>
      <p class="muted"><?= e($d) ?></p>
      <?php if ($params): ?><p class="snippet-label">Parameters</p><table class="params"><?php foreach ($params as $pr): ?><tr><td><code><?= e($pr['name']) ?></code><?= $pr['req'] ? '<span class="req">required</span>' : '' ?><span class="type"><?= e($pr['type']) ?></span></td><td class="muted small"><?= e($pr['desc']) ?></td></tr><?php endforeach; ?></table><?php endif; ?>
    </div>
    <div>
      <?php $codeTabs = $samples($ep); require __DIR__ . '/_code.php'; ?>
      <p class="snippet-label">Response</p>
      <pre class="snippet"><?= e(json_encode($resp, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)) ?></pre>
    </div>
  </div>
</section>
<?php endforeach; ?>
<?php endif; ?>

<?php if ($s['events']): ?>
<h2 id="events">Webhook events</h2>
<table class="params"><?php foreach ($s['events'] as $ev): ?><tr><td><a class="link" href="/docs/webhooks#<?= e(str_replace('.', '-', $ev)) ?>"><code><?= e($ev) ?></code></a></td><td class="muted"><?= e(Docs::events()[$ev] ?? '') ?></td></tr><?php endforeach; ?></table>
<p class="snippet-label">Example: <?= e($s['events'][0]) ?></p>
<pre class="snippet"><?= e(json_encode(Docs::eventExample($s['events'][0]), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)) ?></pre>
<?php endif; ?>

<?php if ($s['sandbox']): ?>
<h2 id="sandbox">Testing in sandbox</h2>
<p><?= e($s['sandbox']) ?></p>
<?php endif; ?>
<?php endif; ?>
<?php require __DIR__ . '/_bottom.php'; ?>
