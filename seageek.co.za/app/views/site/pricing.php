<?php $h1 = 'Pricing'; $meta = 'Rand pricing, excl. VAT'; $lead = 'Prepaid credit, no contracts. Pick a monthly plan for included credit, discounts and higher limits, or pay as you go.'; require APP_DIR . '/views/site/_pagehero.php'; ?>
<?php require APP_DIR . '/views/site/_pricing.php'; ?>
<section class="section"><div class="wrap">
  <div class="section-head"><h2>Usage rates</h2><p class="lead">Charged from your credit as you use them. Discounts from your plan apply automatically.</p></div>
  <div class="grid cols-2">
    <?php $grouped = []; foreach ($rates as $r) $grouped[$r['service']][] = $r;
    foreach ($grouped as $svc => $rows): ?>
    <div class="panel"><h2><?= e(service_names()[$svc] ?? $svc) ?></h2><table class="params" style="margin-top:8px"><?php foreach ($rows as $r): ?><tr><td><?= e($r['label']) ?></td><td class="mono right"><?= zar($r['price'], $r['price'] < 1 ? 3 : 2) ?> <span class="muted small"><?= e($r['per']) ?></span></td></tr><?php endforeach; ?></table></div>
    <?php endforeach; ?>
    <div class="panel"><h2>AI</h2><table class="params" style="margin-top:8px"><?php foreach (Catalog::aiModels() as $m): $p = Catalog::aiPrice($m); ?><tr><td><?= e($m['label']) ?></td><td class="mono right"><?= zar($p['in']) ?> / <?= zar($p['out']) ?> <span class="muted small">per M tokens in / out</span></td></tr><?php endforeach; ?></table><p class="muted small" style="margin-top:8px">Spending is capped per month by plan, and you can set a lower cap.</p></div>
  </div>
  <div class="why" style="margin-top:48px">
    <li><h3>What counts as an SMS segment?</h3><p>160 plain characters, or 70 if the message has emoji or other special characters. Longer messages are split and each part is charged.</p></li>
    <li><h3>Do unused credits expire?</h3><p>No. Credit stays on your account. Included plan credit is added each month and doesn't expire while you're subscribed.</p></li>
    <li><h3>What if I don't pay an invoice?</h3><p>We remind you by email. If a plan invoice is 7 days overdue, live access pauses until it's paid. Sandbox keeps working.</p></li>
    <li><h3>Can I get an invoice for my accounts team?</h3><p>Every payment has an invoice you can download from the dashboard, and you can add a billing contact to your team.</p></li>
  </div>
</div></section>
