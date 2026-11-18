<?php
$base = 'https://www.seageek.co.za/api';
$samples = function (array $ep) use ($base): array {
    [$m, $p, , , , $body] = $ep;
    $url = $base . str_replace('{id}', 'msg_8Kq2vXr1Pz', $p);
    $json = $body ? json_encode($body, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) : null;
    $curl = "curl" . ($m !== 'GET' ? " -X $m" : '') . " $url \\\n  -H \"Authorization: Bearer \$SEAGEEK_KEY\"" . ($json ? " \\\n  -H \"Content-Type: application/json\" \\\n  -d '" . $json . "'" : '');
    $php = "\$ch = curl_init('$url');\ncurl_setopt_array(\$ch, [\n    CURLOPT_RETURNTRANSFER => true,\n    CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . getenv('SEAGEEK_KEY'), 'Content-Type: application/json'],\n" . ($json ? "    CURLOPT_POSTFIELDS => json_encode(" . var_export($body, true) . "),\n" : '') . "]);\n\$result = json_decode(curl_exec(\$ch), true);";
    $php = preg_replace("/array \(\n/", "[\n", str_replace(["\n)", "array (\n"], ["\n]", "[\n"], $php));
    $node = "const res = await fetch(\"$url\", {\n  method: \"$m\",\n  headers: {\n    Authorization: `Bearer \${process.env.SEAGEEK_KEY}`,\n    \"Content-Type\": \"application/json\",\n  }," . ($json ? "\n  body: JSON.stringify(" . $json . "),\n" : "\n") . "});\nconst result = await res.json();";
    $py = "import os, requests\n\nres = requests." . strtolower($m) . "(\n    \"$url\",\n    headers={\"Authorization\": f\"Bearer {os.environ['SEAGEEK_KEY']}\"}," . ($json ? "\n    json=" . preg_replace(['/\btrue\b/', '/\bfalse\b/', '/\bnull\b/'], ['True', 'False', 'None'], $json) . "," : '') . "\n)\nresult = res.json()";
    return ['cURL' => $curl, 'PHP' => $php, 'Node.js' => $node, 'Python' => $py];
};
?>
<div class="wrap docs-shell">
  <?php require APP_DIR . '/views/docs/_side.php'; ?>
  <div>
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><h1 style="font-size:clamp(34px,4.6vw,52px)"><?= e($s['name']) ?> API</h1><span class="pill <?= $s['status'] === 'live' ? 'green' : ($s['status'] === 'beta' ? 'amber' : '') ?>"><?= $s['status'] === 'live' ? 'Available' : ucfirst($s['status']) ?></span></div>
    <p class="lead" style="margin-top:14px"><?= e($s['summary']) ?></p>
    <p class="muted" style="margin-top:12px;max-width:72ch"><?= e($s['intro']) ?></p>

    <?php if ($rates): ?>
    <h2 style="margin-top:34px;font-size:22px">Pricing</h2>
    <table class="params" style="margin-top:8px"><?php foreach ($rates as $r): ?><tr><td><?= e($r['label']) ?></td><td class="mono"><?= zar($r['price'], $r['price'] < 1 ? 3 : 2) ?> <span class="muted"><?= e($r['per']) ?></span></td></tr><?php endforeach; ?></table>
    <p class="muted small" style="margin-top:6px">Standard rates excl. VAT. Business, Growth and Enterprise plans get 5 to 15% off.</p>
    <?php elseif ($slug === 'ai'): ?>
    <h2 style="margin-top:34px;font-size:22px">Models and pricing</h2>
    <table class="params" style="margin-top:8px"><?php foreach (Catalog::aiModels() as $m): $p = Catalog::aiPrice($m); ?><tr><td><?= e($m['label']) ?><span class="type"><?= e($m['provider'] . ' / ' . $m['model']) ?></span></td><td class="mono"><?= zar($p['in']) ?> in · <?= zar($p['out']) ?> out <span class="muted">per million tokens</span></td></tr><?php endforeach; ?></table>
    <h2 style="margin-top:28px;font-size:22px">Limits</h2>
    <table class="params" style="margin-top:8px"><tr><td>Monthly AI spending cap</td><td class="muted">R200 (Pay as you go) to R30,000 (Enterprise). Lower it yourself in the dashboard. Requests that could pass the cap return <code>429 ai_cap_reached</code> before anything is charged.</td></tr><tr><td>Longest reply</td><td class="muted">1,024 to 16,000 tokens by plan. Larger <code>max_tokens</code> values are reduced to your limit.</td></tr><tr><td>Requests per minute</td><td class="muted">10 to 300 by plan. Over the limit returns <code>429 ai_rate_limited</code>.</td></tr></table>
    <?php endif; ?>

    <?php if (!$s['endpoints']): ?><div class="notice" style="margin-top:28px">This product isn't available yet.</div><?php endif; ?>
    <?php foreach ($s['endpoints'] as $i => $ep): [$m, $p, $t, $d, $params, $body, $resp] = $ep; ?>
    <section class="endpoint" id="ep-<?= $i ?>">
      <div class="endpoint-head"><span class="method m-<?= strtolower($m) ?>"><?= $m ?></span><code>/api<?= e($p) ?></code><h3><?= e($t) ?></h3></div>
      <div class="endpoint-body">
        <div>
          <p class="muted"><?= e($d) ?></p>
          <?php if ($params): ?><table class="params" style="margin-top:10px"><?php foreach ($params as $pr): ?><tr><td><code><?= e($pr['name']) ?></code><?= $pr['req'] ? '<span class="req">required</span>' : '' ?><span class="type"><?= e($pr['type']) ?></span></td><td class="muted small"><?= e($pr['desc']) ?></td></tr><?php endforeach; ?></table><?php endif; ?>
        </div>
        <div class="code-window" data-tabs>
          <div class="code-head"><div class="tabs" role="tablist"><?php $first = true; foreach (array_keys($samples($ep)) as $lang): ?><button class="tab" role="tab" data-lang="<?= e($lang) ?>" aria-selected="<?= $first ? 'true' : 'false' ?>"><?= e($lang) ?></button><?php $first = false; endforeach; ?></div><button class="copy-btn" type="button">Copy</button></div>
          <div class="code-body"><?php $first = true; foreach ($samples($ep) as $lang => $code): ?><pre data-lang="<?= e($lang) ?>"<?= $first ? '' : ' hidden' ?>><?= e($code) ?></pre><?php $first = false; endforeach; ?></div>
          <div class="snippet-label" style="padding:0 16px">Response</div>
          <pre class="snippet" style="margin:0 16px 16px;border:0;padding:0;background:none"><?= e(json_encode($resp, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)) ?></pre>
        </div>
      </div>
    </section>
    <?php endforeach; ?>

    <?php if ($s['events']): ?><h2 style="margin-top:34px;font-size:22px">Webhook events</h2><p class="muted" style="margin-top:6px"><?= implode(', ', array_map(fn($x) => '<code>' . e($x) . '</code>', $s['events'])) ?></p><?php endif; ?>
    <?php if ($s['sandbox']): ?><h2 style="margin-top:34px;font-size:22px">Testing in sandbox</h2><p class="muted" style="margin-top:6px"><?= e($s['sandbox']) ?></p><?php endif; ?>
  </div>
</div>
