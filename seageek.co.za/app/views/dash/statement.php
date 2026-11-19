<?php
$label = date('F Y', strtotime($month . '-01'));
$docTitle = 'Account statement';
$docNo = $label;
$docTo = 'Statement for';
$docMeta = ['Period' => date('j', strtotime($st['start'])) . ' to ' . date('j M Y', strtotime($st['end'] . ' -1 day')), 'Customer no.' => $org['customer_no'], 'Credit balance' => zar($st['closing']), 'Amount due' => zar($st['due'])];
$kinds = ['topup' => 'Credit', 'usage' => 'Usage', 'plan' => 'Plan', 'invoice' => 'Invoice', 'refund' => 'Refund', 'adjustment' => 'Adjustment', 'included' => 'Plan'];
$isAdmin = str_starts_with((string) parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH), '/admin');
$base = $isAdmin ? '/admin/orgs/' . (int) $org['id'] . '/statement' : '/dashboard/statement';
$prev = date('Y-m', strtotime($month . '-01 -1 month'));
$next = date('Y-m', strtotime($month . '-01 +1 month'));
// Usage is grouped into one line per product per day so a busy month stays readable.
$lines = [];
foreach ($st['rows'] as $row) {
    $amt = (float) $row['amount'];
    if ($row['type'] === 'usage') {
        $product = ledger_product((string) $row['description']);
        $key = substr($row['created_at'], 0, 10) . '|' . $product;
        $lines[$key] ??= ['date' => $row['created_at'], 'desc' => '', 'type' => 'usage', 'n' => 0, 'amount' => 0.0, 'balance' => 0.0, 'product' => $product];
        $lines[$key]['n']++;
        $lines[$key]['amount'] += $amt;
        $lines[$key]['balance'] = (float) $row['balance_after'];
    } else {
        $lines[] = ['date' => $row['created_at'], 'desc' => (string) $row['description'], 'type' => (string) $row['type'], 'n' => 1, 'amount' => $amt, 'balance' => (float) $row['balance_after']];
    }
}
?>
<div class="doc-tools no-print">
  <div class="grp"><a class="btn btn-ghost btn-sm" href="<?= $isAdmin ? '/admin/orgs/' . (int) $org['id'] : '/dashboard/invoices' ?>">Back</a>
    <a class="btn btn-ghost btn-sm" href="<?= e($base) ?>?month=<?= e($prev) ?>">Previous month</a>
    <?php if ($next <= gmdate('Y-m')): ?><a class="btn btn-ghost btn-sm" href="<?= e($base) ?>?month=<?= e($next) ?>">Next month</a><?php endif; ?></div>
  <div class="grp"><button class="btn btn-primary btn-sm" onclick="window.print()">Print or save as PDF</button></div>
</div>
<article class="doc">
  <?php require APP_DIR . '/views/partials/doc_head.php'; ?>
  <h3 class="doc-sub" style="margin-top:0">Credit account</h3>
  <table>
    <thead><tr><th>Date</th><th>Description</th><th>Type</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th></tr></thead>
    <tbody>
      <tr class="sub"><td><?= e(date('j M', strtotime($st['start']))) ?></td><td>Opening balance</td><td></td><td class="num"></td><td class="num"></td><td class="num"><?= zar($st['opening']) ?></td></tr>
      <?php foreach ($lines as $l): $usage = $l['type'] === 'usage' && isset($l['product']); ?>
      <tr>
        <td class="nowrap"><?= e(date('j M', strtotime($l['date']))) ?></td>
        <td><?= $usage ? e($l['product'] . ' usage, ' . number_format($l['n']) . ' ' . ($l['n'] === 1 ? 'charge' : 'charges')) : e($l['desc']) ?></td>
        <td class="nowrap"><?= e($kinds[$l['type']] ?? ucfirst($l['type'])) ?></td>
        <td class="num"><?= $l['amount'] < 0 ? zar(-$l['amount']) : '' ?></td>
        <td class="num credit"><?= $l['amount'] > 0 ? zar($l['amount']) : '' ?></td>
        <td class="num"><?= zar($l['balance']) ?></td>
      </tr>
      <?php endforeach; ?>
      <?php if (!$lines): ?><tr><td colspan="6" class="muted" style="text-align:center;padding:22px">No transactions in <?= e($label) ?>.</td></tr><?php endif; ?>
    </tbody>
  </table>
  <div class="totals">
    <div><span>Opening credit balance</span><span><?= zar($st['opening']) ?></span></div>
    <div><span>Payments and credits</span><span class="credit"><?= zar($st['credits']) ?></span></div>
    <div><span>Usage and charges</span><span><?= zar(-$st['debits']) ?></span></div>
    <div class="grand"><span>Closing credit balance</span><span><?= zar($st['closing']) ?></span></div>
  </div>
  <h3 class="doc-sub">Invoices issued in <?= e($label) ?></h3>
  <table>
    <thead><tr><th>Date</th><th>Invoice</th><th>Description</th><th>Status</th><th class="num">Total</th></tr></thead>
    <tbody>
    <?php foreach ($st['invoices'] as $i): $ist = $i['status'] === 'unpaid' && $i['due_at'] < now() ? 'overdue' : $i['status']; ?>
      <tr><td class="nowrap"><?= e(date('j M', strtotime($i['created_at']))) ?></td><td class="mono nowrap"><?= e($i['number']) ?></td><td><?= e($i['description']) ?></td><td><?= e(ucfirst($ist)) ?></td><td class="num"><?= zar($i['total']) ?></td></tr>
    <?php endforeach; ?>
    <?php if (!$st['invoices']): ?><tr><td colspan="5" class="muted" style="text-align:center;padding:16px">No invoices in <?= e($label) ?>.</td></tr><?php endif; ?>
    </tbody>
  </table>
  <div class="totals"><div class="grand"><span>Amount due today</span><span><?= zar($st['due']) ?></span></div></div>
  <?php $eftAmount = $st['due'] > 0 ? $st['due'] : null; require APP_DIR . '/views/partials/eft_box.php'; ?>
  <div class="doc-foot"><span>Usage is grouped per product per day. Itemised logs are in your dashboard under Usage and logs.</span><span>Generated <?= e(date('j M Y H:i')) ?></span></div>
</article>
