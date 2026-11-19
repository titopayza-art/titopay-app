<?php
/** Plan comparison and the save button. Expects $in, $calc, $saveUrl, $saveLabel. */
$best = $calc['plans'][$calc['recommended']];
$vatReg = Settings::get('vat_registered') === '1';
?>
<?php if (!$calc['any_volume']): ?>
  <div class="panel quote-empty"><h2>Your estimate appears here</h2><p class="muted" style="margin-top:6px">Enter roughly how much you expect to send or check in a month. We price it on every plan and show the cheapest one that fits. Nothing is charged until you accept and pay.</p></div>
<?php else: ?>
  <div class="panel">
    <div class="panel-head"><h2>Best fit: <?= e($best['plan']['name']) ?></h2><span class="muted"><?= $vatReg ? 'Excl. VAT' : 'No VAT charged' ?></span></div>
    <div class="stat"><div class="v"><?= zar($best['monthly']) ?><small class="muted" style="font-size:15px;font-family:var(--font-sans)"> a month</small></div><div class="d"><?= (float) $best['fee'] > 0 ? 'Plan fee ' . zar($best['fee'], 0) . ' plus usage, less ' . zar($best['included'], 0) . ' included credit' : 'Pay as you go: no monthly fee, usage only' ?></div></div>
    <div class="tbl-wrap" style="margin-top:12px"><table class="tbl lines">
      <thead><tr><th>Item</th><th class="right">Qty</th><th class="right">Price</th><th class="right">Amount</th></tr></thead>
      <tbody>
        <?php if ($best['fee'] > 0): ?><tr><td><?= e($best['plan']['name']) ?> plan</td><td class="num">1</td><td class="num"><?= zar($best['fee']) ?></td><td class="num"><?= zar($best['fee']) ?></td></tr><?php endif; ?>
        <?php foreach ($best['lines'] as $l): ?><tr><td><?= e($l['label']) ?></td><td class="num"><?= number_format($l['qty']) ?></td><td class="num"><?= zar($l['unit_price'], $l['unit_price'] < 1 ? 4 : 2) ?></td><td class="num"><?= zar($l['amount']) ?></td></tr><?php endforeach; ?>
        <?php if ($best['included'] > 0): ?><tr><td>Less usage covered by included plan credit</td><td class="num"></td><td class="num"></td><td class="num" style="color:var(--accent)">-<?= zar($best['included']) ?></td></tr><?php endif; ?>
      </tbody>
      <tfoot><tr class="grand"><td colspan="3">Estimated monthly total</td><td class="num"><?= zar($best['monthly']) ?></td></tr></tfoot>
    </table></div>
  </div>

  <div class="panel flush" style="margin-top:14px">
    <div class="panel-head"><h2>Every plan for these volumes</h2><span class="muted">Plan discounts are applied to usage prices</span></div>
    <div class="tbl-wrap"><table class="plan-compare">
      <thead><tr><th>Plan</th><th>Plan fee</th><th>Usage</th><th>Included</th><th>Monthly total</th></tr></thead>
      <tbody>
      <?php foreach ($calc['plans'] as $code => $c): ?>
        <tr class="<?= $code === $calc['recommended'] ? 'best' : '' ?><?= $c['eligible'] ? '' : ' no' ?>">
          <td><b><?= e($c['plan']['name']) ?></b><?= $code === $calc['recommended'] ? ' <span class="pill green">Best fit</span>' : '' ?><?php if (!$c['eligible']): ?><div class="small muted" style="max-width:260px;white-space:normal">Not suitable: <?= e(implode('; ', $c['reasons'])) ?></div><?php endif; ?></td>
          <td class="mono"><?= zar($c['fee'], 0) ?></td>
          <td class="mono"><?= zar(round($c['usage']), 0) ?></td>
          <td class="mono"><?= $c['included'] > 0 ? '-' . zar(round($c['included']), 0) : 'R0' ?></td>
          <td class="total"><?= zar(round($c['monthly']), 0) ?></td>
        </tr>
      <?php endforeach; ?>
      </tbody>
    </table></div>
  </div>

  <form method="post" action="<?= e($saveUrl) ?>" class="panel" style="margin-top:14px"><?= csrf_field() ?>
    <?php foreach ($in as $k => $v): ?><input type="hidden" name="<?= e($k) ?>" value="<?= e((string) $v) ?>"><?php endforeach; ?>
    <div class="panel-head" style="margin-bottom:8px"><h2>Save this as a quote</h2><span class="muted">Valid for 30 days</span></div>
    <div class="toolbar" style="margin-bottom:12px"><label class="small muted" for="q-plan">Quote on</label>
      <select id="q-plan" name="plan"><?php foreach ($calc['plans'] as $code => $c): ?><option value="<?= e($code) ?>" <?= $code === $calc['recommended'] ? 'selected' : '' ?>><?= e($c['plan']['name']) ?>, <?= zar($c['monthly']) ?> a month</option><?php endforeach; ?></select></div>
    <button class="btn btn-primary"><?= e($saveLabel) ?></button>
    <p class="muted small" style="margin-top:10px">You get a numbered PDF quote. Accepting it switches on the services and raises one invoice for the plan and the first month's credit.</p>
  </form>
<?php endif; ?>
