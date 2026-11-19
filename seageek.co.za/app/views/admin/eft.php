<?php
$matched = array_filter($results, fn($r) => ($r['status'] ?? '') === 'matched' && empty($r['duplicate']));
$dupes = array_filter($results, fn($r) => !empty($r['duplicate']));
$un = array_filter($results, fn($r) => ($r['status'] ?? '') === 'unmatched' && empty($r['duplicate']));
?>
<div class="grid" style="grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);align-items:start" id="eft-grid">
  <div class="panel">
    <div class="panel-head"><h2>Import bank statement</h2><span class="muted">CSV or copied from online banking</span></div>
    <p class="muted small">Paste the deposits from your bank statement, one per line: date, reference, amount. We find the 6-digit customer number in each reference, pay the matching invoice or add credit, email a receipt, and unlock the account if it was paused. Importing the same lines twice is safe: duplicates are skipped.</p>
    <form method="post" style="margin-top:12px"><?= csrf_field() ?><input type="hidden" name="action" value="import">
      <textarea name="csv" class="code" rows="9" style="min-height:200px" placeholder="2026-11-17, SEAGEEK 482913 ACME, 1149.00&#10;2026-11-17, 731045, 500.00&#10;2026-11-18, PAYMENT THANK YOU, 250.00" required></textarea>
      <div class="toolbar" style="margin:12px 0 0"><button class="btn btn-primary">Import and match</button><span class="muted small">Column order: date, reference, amount. Header rows and withdrawals are ignored.</span></div>
    </form>
  </div>
  <div class="panel">
    <h2>How matching works</h2>
    <ol class="howto">
      <li><b>1</b><span>Every customer has a 6-digit number that never changes. It is printed on invoices, statements and the pay page as the EFT reference.</span></li>
      <li><b>2</b><span>An amount equal to an unpaid invoice pays that invoice.</span></li>
      <li><b>3</b><span>Any other amount becomes prepaid credit on a paid invoice, then settles open invoices it covers, oldest first.</span></li>
      <li><b>4</b><span>Lines without a known customer number wait below for you to assign.</span></li>
    </ol>
  </div>
</div>

<?php if ($results): ?>
<div class="panel flush" style="margin-top:14px">
  <div class="panel-head"><h2>Import result</h2><span class="muted"><?= count($matched) ?> matched · <?= count($un) ?> need attention · <?= count($dupes) ?> already imported</span></div>
  <div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>Date</th><th>Reference</th><th class="right">Amount</th><th>Result</th><th>Note</th></tr></thead>
    <tbody><?php foreach ($results as $r): ?><tr><td class="small nowrap"><?= e($r['posted_on']) ?></td><td class="mono small"><?= e($r['reference']) ?></td><td class="right mono small"><?= zar($r['amount']) ?></td><td><?php $status = !empty($r['duplicate']) ? 'skipped' : $r['status']; require APP_DIR . '/views/partials/status.php'; ?></td><td class="small muted"><?= e(!empty($r['duplicate']) ? 'Already imported' : ($r['note'] ?? '')) ?></td></tr><?php endforeach; ?></tbody>
  </table></div>
</div>
<?php endif; ?>

<div class="panel flush" style="margin-top:14px">
  <div class="panel-head"><h2>Needs attention</h2><span class="muted">Deposits we could not link to a customer</span></div>
  <?php if (!$unmatched): ?><div class="empty">Nothing waiting. Every deposit has been matched.</div><?php else: ?>
  <div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>Date</th><th>Reference</th><th class="right">Amount</th><th>Why</th><th>Assign to customer</th></tr></thead>
    <tbody><?php foreach ($unmatched as $u): ?><tr><td class="small nowrap"><?= e($u['posted_on']) ?></td><td class="mono small"><?= e($u['reference']) ?></td><td class="right mono small"><?= zar($u['amount']) ?></td><td class="small muted"><?= e($u['note']) ?></td>
      <td><?php if ((float) $u['amount'] > 0): ?><form method="post" class="toolbar" style="margin:0"><?= csrf_field() ?><input type="hidden" name="action" value="assign"><input type="hidden" name="line" value="<?= (int) $u['id'] ?>"><input name="customer_no" placeholder="6-digit no." inputmode="numeric" pattern="\d{6}" maxlength="6" style="width:120px;height:32px" required><button class="btn btn-ghost btn-xs">Assign</button></form><?php endif; ?></td></tr><?php endforeach; ?></tbody>
  </table></div><?php endif; ?>
</div>

<div class="panel flush" style="margin-top:14px">
  <div class="panel-head"><h2>Recently matched</h2></div>
  <?php if (!$recent): ?><div class="empty">No EFT payments matched yet.</div><?php else: ?>
  <div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>Date</th><th>Customer</th><th>Reference</th><th class="right">Amount</th><th>Invoice</th><th>Note</th></tr></thead>
    <tbody><?php foreach ($recent as $m): ?><tr><td class="small nowrap"><?= e($m['posted_on']) ?></td><td><a class="link" href="/admin/orgs/<?= (int) $m['org_id'] ?>"><?= e($m['org']) ?></a> <span class="mono small muted"><?= e($m['customer_no']) ?></span></td><td class="mono small"><?= e($m['reference']) ?></td><td class="right mono small"><?= zar($m['amount']) ?></td><td class="mono small"><?= $m['inv'] ? '<a class="link" href="/admin/invoices/' . e($m['inv']) . '">' . e($m['inv']) . '</a>' : '' ?></td><td class="small muted"><?= e($m['note']) ?></td></tr><?php endforeach; ?></tbody>
  </table></div><?php endif; ?>
</div>
<style>@media (max-width: 1000px) { #eft-grid { grid-template-columns: 1fr !important; } }</style>
