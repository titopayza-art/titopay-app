<?php
$crumbs = [['Billing', '/dashboard/billing'], ['Invoices', '/dashboard/invoices'], [$inv['number'], null]];
require APP_DIR . '/views/partials/crumbs.php';
$paid = $inv['status'] === 'paid';
$kinds = ['plan' => 'Plan', 'package' => 'Package', 'topup' => 'Credit', 'service' => 'Service'];
$creditOk = !$paid && !array_filter($items, fn($i) => in_array($i['kind'], ['topup', 'package'], true)) && (float) $org['balance'] >= (float) $inv['total'];
?>
<ol class="order-steps"><li class="done"><b>1</b><span>Choose services</span></li><li class="done"><b>2</b><span>Review order</span></li><li class="<?= $paid ? 'done' : 'on' ?>"><b>3</b><span>Pay</span></li><li class="<?= $paid ? 'on' : '' ?>"><b>4</b><span>Ready to use</span></li></ol>

<?php if (isset($_GET['paid']) && !$paid): ?>
  <div class="alert alert-ok">Thank you. We are waiting for PayFast to confirm your payment. This page updates on refresh, usually within a minute.</div>
<?php elseif (isset($_GET['cancelled']) && !$paid): ?>
  <div class="alert alert-warn">The card payment was cancelled. Nothing was charged. You can try again or pay by EFT.</div>
<?php endif; ?>

<div class="pay-grid">
  <div class="panel">
    <div class="panel-head"><h2><?= $paid ? 'Paid' : 'Amount to pay' ?></h2><?php $status = $inv['status'] === 'unpaid' && $inv['due_at'] < now() ? 'overdue' : $inv['status']; require APP_DIR . '/views/partials/status.php'; ?></div>
    <div class="stat" style="margin-bottom:12px"><div class="v"><?= zar($inv['total']) ?></div><div class="d">Invoice <span class="mono"><?= e($inv['number']) ?></span> · issued <?= e(date('j M Y', strtotime($inv['created_at']))) ?><?= $paid && $inv['paid_at'] ? ' · paid ' . e(date('j M Y', strtotime($inv['paid_at']))) : '' ?></div></div>
    <div class="tbl-wrap"><table class="tbl lines">
      <thead><tr><th>Item</th><th class="right">Qty</th><th class="right">Amount</th></tr></thead>
      <tbody><?php foreach ($items as $it): ?><tr><td><?= e($it['description']) ?><div class="muted small"><?= e($kinds[$it['kind']] ?? ucfirst($it['kind'])) ?><?php if ($it['kind'] === 'package'): $pk = DB::one('SELECT credit FROM packages WHERE code = ?', [$it['ref']]); if ($pk): ?>, adds <?= zar((float) $pk['credit'] * (float) $it['quantity'], 0) ?> credit<?php endif; endif; ?></div></td><td class="num"><?= rtrim(rtrim(number_format((float) $it['quantity'], 2, '.', ''), '0'), '.') ?></td><td class="num"><?= zar($it['amount']) ?></td></tr><?php endforeach; ?></tbody>
      <tfoot>
        <tr><td colspan="2" class="muted">Subtotal</td><td class="num"><?= zar($inv['subtotal']) ?></td></tr>
        <?php if ((float) $inv['vat'] > 0): ?><tr><td colspan="2" class="muted">VAT (<?= e(Settings::get('vat_rate')) ?>%)</td><td class="num"><?= zar($inv['vat']) ?></td></tr><?php endif; ?>
        <tr class="grand"><td colspan="2">Total</td><td class="num"><?= zar($inv['total']) ?></td></tr>
      </tfoot>
    </table></div>
    <div class="toolbar" style="margin:14px 0 0"><a class="btn btn-ghost btn-sm" href="/dashboard/invoice/<?= e($inv['number']) ?>"><?= icon('doc') ?>View invoice</a><a class="btn btn-ghost btn-sm" href="/dashboard/invoices">All invoices</a></div>
  </div>

  <div>
    <?php if ($paid): ?>
      <div class="panel">
        <h2>Payment received</h2>
        <p class="muted" style="margin-top:6px">Thank you. Your credit, plan and services have been updated. A receipt was emailed to you.</p>
        <div class="toolbar" style="margin:14px 0 0"><a class="btn btn-primary btn-sm" href="/dashboard/services">Go to my services</a><a class="btn btn-ghost btn-sm" href="/dashboard/keys">Get API keys</a></div>
      </div>
    <?php elseif ($inv['status'] === 'void'): ?>
      <div class="panel"><h2>This invoice was cancelled</h2><p class="muted" style="margin-top:6px">Nothing is owed on it. Create a new order from Services if you still need it.</p></div>
    <?php else: ?>
      <div class="panel">
        <h2>Choose how to pay</h2>
        <div class="pay-option" style="margin-top:14px">
          <h3><?= icon('card') ?>Card, Instant EFT, SnapScan or Zapper</h3>
          <p>Secure checkout with PayFast. Your account updates as soon as the payment clears, usually within a minute.</p>
          <?php if ($form): ?><form action="<?= e($form['action']) ?>" method="post" style="margin-top:12px"><?php foreach ($form['fields'] as $k => $v): ?><input type="hidden" name="<?= e($k) ?>" value="<?= e($v) ?>"><?php endforeach; ?><button class="btn btn-primary">Pay <?= zar($inv['total']) ?> now</button></form><?php endif; ?>
        </div>
        <div class="pay-option">
          <h3><?= icon('bank') ?>Bank transfer (EFT)</h3>
          <p>Pay from any South African bank. Use your customer number as the reference and we match it to your account automatically, usually within one working day.</p>
          <div class="ref-big"><span>Payment reference</span><b><?= e($org['customer_no']) ?></b><button class="copy-btn" type="button" data-copy="eft-ref">Copy</button><span id="eft-ref" hidden><?= e($org['customer_no']) ?></span></div>
          <dl class="kv" style="margin-top:12px;grid-template-columns:120px 1fr;font-size:14px"><dt>Bank</dt><dd><?= e(Settings::get('bank_name') ?: 'Shared on request') ?></dd><dt>Account name</dt><dd><?= e(Settings::get('bank_account_name')) ?></dd><dt>Account number</dt><dd class="mono"><?= e(Settings::get('bank_account_number') ?: 'Shared on request') ?></dd><dt>Branch code</dt><dd class="mono"><?= e(Settings::get('bank_branch_code') ?: 'Universal') ?></dd><dt>Amount</dt><dd class="mono"><?= zar($inv['total']) ?></dd></dl>
        </div>
        <?php if ($creditOk): ?>
        <div class="pay-option">
          <h3><?= icon('wallet') ?>From my credit balance</h3>
          <p>You have <?= zar($org['balance']) ?> available. Paying from credit is instant.</p>
          <form method="post" style="margin-top:12px"><?= csrf_field() ?><input type="hidden" name="action" value="credit"><button class="btn btn-ghost btn-sm">Pay <?= zar($inv['total']) ?> from credit</button></form>
        </div>
        <?php endif; ?>
      </div>
    <?php endif; ?>
  </div>
</div>
