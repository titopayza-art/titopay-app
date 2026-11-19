<?php
$crumbs = [['Billing', '/dashboard/billing'], ['Invoices and statements', null]];
require APP_DIR . '/views/partials/crumbs.php';
$f = in_array($_GET['status'] ?? '', ['unpaid', 'paid'], true) ? $_GET['status'] : 'all';
$unpaid = array_filter($invoices, fn($i) => $i['status'] === 'unpaid');
$shown = $f === 'all' ? $invoices : array_filter($invoices, fn($i) => $i['status'] === $f);
$kinds = ['plan' => 'Plan', 'topup' => 'Credit', 'order' => 'Order'];
?>
<div class="refbox" style="margin-bottom:14px">
  <div><span>Customer number and EFT reference</span><b><?= e($org['customer_no']) ?></b></div>
  <div><span>Amount due</span><b><?= zar(array_sum(array_column($unpaid, 'total'))) ?></b></div>
  <div><span>Credit balance</span><b><?= zar($org['balance']) ?></b></div>
</div>

<div class="grid" style="grid-template-columns:minmax(0,1fr) 300px;align-items:start" id="inv-grid">
  <div class="panel flush">
    <div class="panel-head"><h2>Invoices</h2><span class="muted">An invoice is created for every order, plan and payment</span></div>
    <div class="tabs-row" style="padding:0 20px;margin-bottom:0">
      <a class="<?= $f === 'all' ? 'on' : '' ?>" href="?status=all">All<span><?= count($invoices) ?></span></a>
      <a class="<?= $f === 'unpaid' ? 'on' : '' ?>" href="?status=unpaid">Unpaid<span><?= count($unpaid) ?></span></a>
      <a class="<?= $f === 'paid' ? 'on' : '' ?>" href="?status=paid">Paid<span><?= count($invoices) - count($unpaid) ?></span></a>
    </div>
    <?php if (!$shown): ?><div class="empty">No invoices here yet.</div><?php else: ?>
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Invoice</th><th>Date</th><th>Type</th><th class="right">Total</th><th>Status</th><th></th></tr></thead>
      <tbody><?php foreach ($shown as $i): ?>
        <tr>
          <td><a class="link mono small" href="/dashboard/invoice/<?= e($i['number']) ?>"><?= e($i['number']) ?></a><div class="muted small" style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><?= e($i['description']) ?></div></td>
          <td class="small nowrap"><?= e(date('j M Y', strtotime($i['created_at']))) ?></td>
          <td class="small"><?= e($kinds[$i['kind']] ?? ucfirst($i['kind'])) ?></td>
          <td class="right mono small"><?= zar($i['total']) ?></td>
          <td><?php $status = $i['status'] === 'unpaid' && $i['due_at'] < now() ? 'overdue' : $i['status']; require APP_DIR . '/views/partials/status.php'; ?></td>
          <td class="right nowrap"><?php if ($i['status'] === 'unpaid'): ?><a class="btn btn-primary btn-xs" href="/dashboard/pay/<?= e($i['number']) ?>">Pay</a> <?php endif; ?><a class="btn btn-ghost btn-xs" href="/dashboard/invoice/<?= e($i['number']) ?>">View</a></td>
        </tr>
      <?php endforeach; ?></tbody>
    </table></div>
    <?php endif; ?>
  </div>

  <div>
    <div class="panel flush">
      <div class="panel-head"><h2>Monthly statements</h2></div>
      <div class="tbl-wrap"><table class="tbl"><tbody>
        <?php foreach ($months as $m): ?><tr><td><?= e(date('F Y', strtotime($m . '-01'))) ?></td><td class="right"><a class="btn btn-ghost btn-xs" href="/dashboard/statement?month=<?= e($m) ?>"><?= icon('doc') ?>Open</a></td></tr><?php endforeach; ?>
      </tbody></table></div>
    </div>
    <div class="panel" style="margin-top:14px">
      <h2>Paying by EFT</h2>
      <p class="muted small" style="margin-top:6px">Always use <b class="mono" style="color:var(--text)"><?= e($org['customer_no']) ?></b> as the reference. If the amount matches an unpaid invoice, that invoice is marked paid. Any other amount becomes credit and settles open invoices it covers, oldest first.</p>
      <dl class="kv" style="margin-top:10px;grid-template-columns:110px 1fr;font-size:13.5px"><dt>Bank</dt><dd><?= e(Settings::get('bank_name') ?: 'Shared on request') ?></dd><dt>Account</dt><dd class="mono"><?= e(Settings::get('bank_account_number') ?: 'Shared on request') ?></dd><dt>Branch</dt><dd class="mono"><?= e(Settings::get('bank_branch_code') ?: 'Universal') ?></dd></dl>
    </div>
  </div>
</div>
<style>@media (max-width: 1000px) { #inv-grid { grid-template-columns: 1fr !important; } }</style>
