<div class="no-print toolbar"><a class="btn btn-ghost btn-sm" href="/dashboard/billing">Back to billing</a><button class="btn btn-primary btn-sm" onclick="window.print()">Print or save as PDF</button></div>
<div class="panel" style="padding:32px">
  <div style="display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap">
    <div><a class="brand"><?php require APP_DIR . '/views/partials/logo.php'; ?><span>SeaGeek</span></a><p class="muted small" style="margin-top:10px"><?= e(Settings::get('company_name')) ?><br>Johannesburg, Gauteng<br><?= e(Settings::get('support_email')) ?><?= Settings::get('vat_number') ? '<br>VAT ' . e(Settings::get('vat_number')) : '' ?></p></div>
    <div class="right"><h1 style="font-size:26px"><?= Settings::get('vat_registered') === '1' ? 'Tax invoice' : 'Invoice' ?></h1><p class="mono"><?= e($inv['number']) ?></p><p class="muted small">Issued <?= e(date('j M Y', strtotime($inv['created_at']))) ?><br>Due <?= e(date('j M Y', strtotime($inv['due_at']))) ?></p><?php $status = $inv['status']; require APP_DIR . '/views/partials/status.php'; ?></div>
  </div>
  <p style="margin-top:22px"><b>Bill to</b><br><?= e($org['name']) ?><br><span class="muted small"><?= e($org['address'] ?: '') ?><?= $org['vat_no'] ? '<br>VAT ' . e($org['vat_no']) : '' ?></span></p>
  <table class="tbl" style="margin-top:20px"><thead><tr><th>Description</th><th class="right">Amount</th></tr></thead><tbody>
    <tr><td><?= e($inv['description']) ?></td><td class="right mono"><?= zar($inv['subtotal']) ?></td></tr>
    <?php if ((float) $inv['vat'] > 0): ?><tr><td>VAT (<?= e(Settings::get('vat_rate')) ?>%)</td><td class="right mono"><?= zar($inv['vat']) ?></td></tr><?php endif; ?>
    <tr><td><b>Total</b></td><td class="right mono"><b><?= zar($inv['total']) ?></b></td></tr>
  </tbody></table>
  <?php foreach ($payments as $p): ?><p class="muted small" style="margin-top:12px">Paid <?= zar($p['amount']) ?> by <?= e(strtoupper($p['gateway'])) ?> on <?= e(date('j M Y', strtotime($p['created_at']))) ?>.</p><?php endforeach; ?>
</div>
