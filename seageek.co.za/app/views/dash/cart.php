<?php
$crumbs = [['Services', '/dashboard/services'], ['Your order', null]];
require APP_DIR . '/views/partials/crumbs.php';
$svcNames = service_names();
$byService = array_fill_keys(array_keys(Services::sellable()), []);
foreach ($packages as $p) $byService[$p['service']][] = $p;
$byService = array_filter($byService);
$inCart = $_SESSION['cart']['packages'] ?? [];
$kinds = ['plan' => 'Plan', 'package' => 'Package', 'topup' => 'Credit'];
?>
<ol class="order-steps"><li class="done"><b>1</b><span>Choose services</span></li><li class="on"><b>2</b><span>Review order</span></li><li><b>3</b><span>Pay</span></li><li><b>4</b><span>Ready to use</span></li></ol>

<div class="pay-grid">
  <div>
    <div class="panel flush">
      <div class="panel-head"><h2>Your order</h2><?php if ($lines): ?><form method="post" class="inline-form"><?= csrf_field() ?><input type="hidden" name="action" value="clear"><button class="btn btn-ghost btn-xs">Empty order</button></form><?php endif; ?></div>
      <?php if (!$lines): ?>
        <div class="empty">Your order is empty. <a class="link" href="/dashboard/services">Choose services</a> or add a package below.</div>
      <?php else: ?>
      <div class="tbl-wrap"><table class="tbl lines">
        <thead><tr><th>Item</th><th>Qty</th><th class="right">Unit</th><th class="right">Amount</th><th></th></tr></thead>
        <tbody>
        <?php foreach ($lines as [$kind, $ref, $desc, $qty, $unit]): ?>
          <tr>
            <td><?= e($desc) ?><div class="muted small"><?= e($kinds[$kind] ?? $kind) ?><?php if ($kind === 'package'): $pk = DB::one('SELECT credit FROM packages WHERE code = ?', [$ref]); ?>, adds <?= zar((float) $pk['credit'] * $qty, 0) ?> credit<?php endif; ?></div></td>
            <td><?php if ($kind === 'package'): ?><form method="post" class="qty-form"><?= csrf_field() ?><input type="hidden" name="action" value="qty"><input type="hidden" name="code" value="<?= e($ref) ?>"><input type="number" name="qty" min="1" max="100" value="<?= (int) $qty ?>" onchange="this.form.submit()" aria-label="Quantity"></form><?php else: ?><span class="mono small">1</span><?php endif; ?></td>
            <td class="num small"><?= zar($unit) ?></td>
            <td class="num"><?= zar($qty * $unit) ?></td>
            <td class="right"><form method="post" class="inline-form"><?= csrf_field() ?><?php if ($kind === 'package'): ?><input type="hidden" name="action" value="remove"><input type="hidden" name="code" value="<?= e($ref) ?>"><?php elseif ($kind === 'plan'): ?><input type="hidden" name="action" value="plan"><input type="hidden" name="plan" value=""><?php else: ?><input type="hidden" name="action" value="topup"><input type="hidden" name="amount" value="0"><?php endif; ?><button class="btn btn-ghost btn-xs" aria-label="Remove <?= e($desc) ?>"><?= icon('x') ?></button></form></td>
          </tr>
        <?php endforeach; ?>
        </tbody>
      </table></div>
      <?php endif; ?>
    </div>

    <details class="panel fold" style="margin-top:14px" <?= $lines ? '' : 'open' ?>>
      <summary class="panel-head"><h2>Add packages</h2><span class="muted">Credit from every package goes into your one balance</span></summary>
      <div class="tbl-wrap"><table class="tbl">
        <tbody>
        <?php foreach ($byService as $svc => $list): foreach ($list as $i => $p): $bonus = (float) $p['credit'] - (float) $p['price']; ?>
          <tr>
            <td class="small" style="width:120px"><?= $i === 0 ? '<b>' . e($svcNames[$svc] ?? $svc) . '</b>' : '' ?></td>
            <td><?= e($p['name']) ?><div class="muted small"><?= e($p['description']) ?></div></td>
            <td class="right mono small nowrap"><?= zar($p['price'], 0) ?><?php if ($bonus > 0): ?><div class="small" style="color:var(--accent)">+<?= zar($bonus, 0) ?> bonus</div><?php endif; ?></td>
            <td class="right"><form method="post" class="inline-form"><?= csrf_field() ?><input type="hidden" name="action" value="add"><input type="hidden" name="code" value="<?= e($p['code']) ?>"><button class="btn btn-ghost btn-xs"><?= !empty($inCart[$p['code']]) ? 'Add another' : 'Add' ?></button></form></td>
          </tr>
        <?php endforeach; endforeach; ?>
        </tbody>
      </table></div>
    </details>
  </div>

  <div>
    <div class="panel">
      <h2>Summary</h2>
      <table class="tbl lines" style="margin-top:10px"><tbody>
        <tr><td class="muted">Subtotal</td><td class="num"><?= zar($subtotal) ?></td></tr>
        <?php if ($vat > 0): ?><tr><td class="muted">VAT (<?= e(Settings::get('vat_rate')) ?>%)</td><td class="num"><?= zar($vat) ?></td></tr><?php endif; ?>
      </tbody><tfoot><tr class="grand"><td>Total</td><td class="num"><?= zar($total) ?></td></tr></tfoot></table>
      <form method="post" style="margin-top:14px"><?= csrf_field() ?><input type="hidden" name="action" value="checkout"><button class="btn btn-primary" style="width:100%" <?= $lines ? '' : 'disabled' ?>>Continue to payment</button></form>
      <p class="muted small" style="margin-top:10px">One invoice for everything, billed to <?= e($org['name']) ?> (customer no. <span class="mono"><?= e($org['customer_no']) ?></span>). Pay by card, Instant EFT or bank transfer.</p>
    </div>

    <div class="panel" style="margin-top:14px">
      <h2>Monthly plan</h2>
      <p class="muted small" style="margin-top:4px">Plans add included credit every month and lower your usage prices. You are on <b><?= e(Billing::plan($org)['name']) ?></b>.</p>
      <form method="post" class="toolbar" style="margin:12px 0 0"><?= csrf_field() ?><input type="hidden" name="action" value="plan">
        <select name="plan" style="flex:1;min-width:0"><option value="">Keep my current plan</option><?php foreach ($plans as $p): if ($p['code'] === $org['plan_code']) continue; ?><option value="<?= e($p['code']) ?>" <?= $cartPlan === $p['code'] ? 'selected' : '' ?>><?= e($p['name']) ?>, <?= zar($p['price'], 0) ?>/mo with <?= zar($p['included_credit'], 0) ?> credit</option><?php endforeach; ?></select>
        <button class="btn btn-ghost btn-sm">Update</button></form>
    </div>

    <div class="panel" style="margin-top:14px">
      <h2>Prepaid credit</h2>
      <p class="muted small" style="margin-top:4px">Credit works for every service. Minimum <?= zar(Settings::get('min_topup'), 0) ?>.</p>
      <form method="post" class="toolbar" style="margin:12px 0 0"><?= csrf_field() ?><input type="hidden" name="action" value="topup">
        <input name="amount" type="number" min="0" step="10" value="<?= $cartTopup ? (float) $cartTopup : '' ?>" placeholder="Amount in rand" style="flex:1;min-width:0">
        <button class="btn btn-ghost btn-sm"><?= $cartTopup ? 'Update' : 'Add' ?></button></form>
    </div>
  </div>
</div>
