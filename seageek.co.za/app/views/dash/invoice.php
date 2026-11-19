<?php
$vatReg = Settings::get('vat_registered') === '1';
$overdue = $inv['status'] === 'unpaid' && $inv['due_at'] < now();
$stamp = $overdue ? 'overdue' : $inv['status'];
$docTitle = $vatReg ? 'Tax invoice' : 'Invoice';
$docNo = $inv['number'];
$docStamp = $stamp;
$docMeta = ['Invoice date' => date('j M Y', strtotime($inv['created_at'])), 'Due date' => date('j M Y', strtotime($inv['due_at'])), 'Customer no.' => $org['customer_no'], 'Amount due' => $inv['status'] === 'paid' ? 'R0.00' : zar($inv['total'])];
$items = $items ?: [['kind' => $inv['kind'], 'description' => $inv['description'], 'quantity' => 1, 'unit_price' => $inv['subtotal'], 'amount' => $inv['subtotal']]];
$kinds = ['plan' => 'Plan', 'package' => 'Package', 'topup' => 'Credit', 'service' => 'Service'];
?>
<div class="doc-tools no-print">
  <div class="grp"><a class="btn btn-ghost btn-sm" href="<?= e($back ?? '/dashboard/invoices') ?>">Back</a></div>
  <div class="grp">
    <?php if ($inv['status'] === 'unpaid' && empty($back)): ?><a class="btn btn-primary btn-sm" href="/dashboard/pay/<?= e($inv['number']) ?>">Pay <?= zar($inv['total']) ?></a><?php endif; ?>
    <button class="btn btn-ghost btn-sm" onclick="window.print()">Print or save as PDF</button>
  </div>
</div>
<article class="doc">
  <?php require APP_DIR . '/views/partials/doc_head.php'; ?>
  <table>
    <thead><tr><th>Description</th><th>Type</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr></thead>
    <tbody>
      <?php foreach ($items as $it): ?>
      <tr><td><?= e($it['description']) ?></td><td><?= e($kinds[$it['kind']] ?? ucfirst($it['kind'])) ?></td><td class="num"><?= rtrim(rtrim(number_format((float) $it['quantity'], 2, '.', ''), '0'), '.') ?></td><td class="num"><?= zar($it['unit_price']) ?></td><td class="num"><?= zar($it['amount']) ?></td></tr>
      <?php endforeach; ?>
    </tbody>
  </table>
  <div class="totals">
    <div><span>Subtotal<?= $vatReg ? ' (excl. VAT)' : '' ?></span><span><?= zar($inv['subtotal']) ?></span></div>
    <?php if ((float) $inv['vat'] > 0): ?><div><span>VAT at <?= e(Settings::get('vat_rate')) ?>%</span><span><?= zar($inv['vat']) ?></span></div><?php endif; ?>
    <div class="grand"><span>Total</span><span><?= zar($inv['total']) ?></span></div>
    <?php foreach ($payments as $p): ?><div class="credit"><span>Paid <?= e(date('j M Y', strtotime($p['created_at']))) ?> (<?= e(['payfast' => 'PayFast', 'eft' => 'EFT', 'credit' => 'credit balance', 'admin' => 'manual'][$p['gateway']] ?? strtoupper($p['gateway'])) ?>)</span><span>-<?= zar($p['amount']) ?></span></div><?php endforeach; ?>
    <?php if ($inv['status'] !== 'paid' && $inv['status'] !== 'void'): ?><div class="grand"><span>Amount due</span><span><?= zar($inv['total']) ?></span></div><?php endif; ?>
  </div>
  <?php if ($inv['status'] === 'unpaid'): $eftAmount = (float) $inv['total']; require APP_DIR . '/views/partials/eft_box.php'; endif; ?>
  <?php if (!$vatReg): ?><p class="muted" style="margin-top:16px;font-size:12.5px">SeaGeek Technologies is not yet registered for VAT, so no VAT is charged.</p><?php endif; ?>
  <div class="doc-foot"><span>Questions about this invoice? <?= e(Settings::get('support_email')) ?></span><span>Page 1 of 1</span></div>
</article>
