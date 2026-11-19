<?php $plansList = DB::all('SELECT * FROM plans WHERE active = 1 ORDER BY sort'); ?>
<section class="section" id="pricing">
  <div class="wrap">
    <div class="section-head">
      <h2>Pricing</h2>
      <p class="lead">Every plan includes all products, sandbox and Desk. Monthly plans include usage credit, so the fee mostly pays for what you send anyway.</p>
    </div>
    <div class="pricing">
      <?php foreach ($plansList as $p): $feat = json_decode((string) $p['features'], true) ?: []; ?>
      <div class="plan">
        <span class="name"><?= e($p['name']) ?></span>
        <div class="price"><?= (float) $p['price'] ? zar($p['price'], 0) : 'R0' ?><small> /month</small></div>
        <p class="for"><?= $p['code'] === 'payg' ? 'No monthly fee. Pay only for usage.' : 'Includes ' . zar($p['included_credit'], 0) . ' of usage every month.' ?></p>
        <ul><?php foreach ($feat as $f): ?><li><?= icon('check') ?><?= e($f) ?></li><?php endforeach; ?></ul>
        <a class="btn <?= $p['code'] === 'business' ? 'btn-primary' : 'btn-ghost' ?>" href="<?= $p['code'] === 'enterprise' ? '/contact' : '/register' ?>"><?= $p['code'] === 'enterprise' ? 'Contact sales' : 'Start free' ?></a>
      </div>
      <?php endforeach; ?>
    </div>
    <div class="quote-cta">
      <div><b>Not sure which plan fits?</b><span>Enter your monthly volumes and we price them on every plan, pick the cheapest one that fits and give you a numbered quote.</span></div>
      <a class="btn btn-ghost" href="/quote"><?= icon('calc') ?>Get a quote</a>
    </div>
    <p class="pricing-note">Prices exclude VAT. Usage rates per message, check and minute are on the <a class="link" href="/pricing">pricing page</a>.</p>
  </div>
</section>
