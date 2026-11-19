<?php
$expired = $q['status'] === 'open' && $q['valid_until'] < now();
$stamp = $expired ? 'expired' : $q['status'];
$docTitle = 'Quote';
$docNo = $q['number'];
$docStamp = $stamp;
$docTo = 'Prepared for';
$docMeta = ['Quote date' => date('j M Y', strtotime($q['created_at'])), 'Valid until' => date('j M Y', strtotime($q['valid_until'])), 'Customer no.' => $org['customer_no'], 'Plan' => $plan['name'] ?? ucfirst((string) $q['plan_code'])];
$vatReg = Settings::get('vat_registered') === '1';
$isAdmin = str_starts_with((string) parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH), '/admin');
?>
<div class="doc-tools no-print">
  <div class="grp"><a class="btn btn-ghost btn-sm" href="<?= $isAdmin ? '/admin/quotes' : '/dashboard/quotes' ?>">Back</a></div>
  <div class="grp">
    <?php if (!$isAdmin && $q['status'] === 'open' && !$expired): ?><form method="post" class="inline-form" data-confirm="Accept quote <?= e($q['number']) ?>? We switch on the services and create one invoice for you to pay."><?= csrf_field() ?><input type="hidden" name="action" value="accept"><button class="btn btn-primary btn-sm">Accept and pay</button></form><?php endif; ?>
    <?php if ($q['invoice_id'] && ($inv = DB::one('SELECT number, status FROM invoices WHERE id = ?', [$q['invoice_id']]))): ?><a class="btn btn-ghost btn-sm" href="<?= $isAdmin ? '#' : '/dashboard/' . ($inv['status'] === 'unpaid' ? 'pay' : 'invoice') . '/' . e($inv['number']) ?>">Invoice <?= e($inv['number']) ?></a><?php endif; ?>
    <button class="btn btn-ghost btn-sm" onclick="window.print()">Print or save as PDF</button>
  </div>
</div>
<article class="doc">
  <?php require APP_DIR . '/views/partials/doc_head.php'; ?>
  <table>
    <thead><tr><th>Description</th><th class="num">Qty a month</th><th class="num">Unit price</th><th class="num">Amount</th></tr></thead>
    <tbody>
    <?php foreach ($items as $it): $neg = (float) $it['amount'] < 0; ?>
      <tr class="<?= $neg ? 'sub' : '' ?>"><td><?= e($it['label']) ?></td><td class="num"><?= $neg ? '' : number_format((float) $it['qty']) ?></td><td class="num"><?= $neg ? '' : zar($it['unit_price'], (float) $it['unit_price'] < 1 ? 4 : 2) ?></td><td class="num <?= $neg ? 'credit' : '' ?>"><?= zar($it['amount']) ?></td></tr>
    <?php endforeach; ?>
    </tbody>
  </table>
  <div class="totals">
    <div><span>Monthly subtotal<?= $vatReg ? ' (excl. VAT)' : '' ?></span><span><?= zar($q['subtotal']) ?></span></div>
    <?php if ((float) $q['vat'] > 0): ?><div><span>VAT at <?= e(Settings::get('vat_rate')) ?>%</span><span><?= zar($q['vat']) ?></span></div><?php endif; ?>
    <div class="grand"><span>Estimated monthly total</span><span><?= zar($q['total']) ?></span></div>
  </div>
  <div class="doc-note">
    <b>How this quote works.</b> Usage is prepaid from one credit balance shared by all your services. Accepting this quote switches on the services listed and raises one invoice for <?= $plan && (float) $plan['price'] > 0 ? 'the ' . e($plan['name']) . ' plan\'s first month and ' : '' ?>prepaid credit to cover the first month's usage. Actual charges follow real usage at the rates above; unused credit stays on your account. Rates are fixed for the validity of this quote.
  </div>
  <?php $eftAmount = null; require APP_DIR . '/views/partials/eft_box.php'; ?>
  <div class="doc-foot"><span>Quote <?= e($q['number']) ?> · valid until <?= e(date('j M Y', strtotime($q['valid_until']))) ?></span><span><?= e(Settings::get('support_email')) ?></span></div>
</article>
