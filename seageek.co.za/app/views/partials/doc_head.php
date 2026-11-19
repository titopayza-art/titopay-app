<?php
/**
 * Letterhead for invoices, statements and quotes.
 * Expects: $org, $docTitle, $docNo, $docMeta (label => value), optional $docStamp, $docStampLabel.
 */
?>
<div class="doc-head">
  <div>
    <div class="doc-brand"><?php require APP_DIR . '/views/partials/logo.php'; ?><span>SeaGeek</span></div>
    <div class="doc-from"><?= e(Settings::get('company_name')) ?><?= Settings::get('company_reg') ? '<br>Reg. ' . e(Settings::get('company_reg')) : '' ?><br><?= e(Settings::get('company_address')) ?><br><?= e(Settings::get('support_email')) ?> · seageek.co.za<?= Settings::get('vat_number') ? '<br>VAT ' . e(Settings::get('vat_number')) : '' ?></div>
  </div>
  <div class="doc-title">
    <h1><?= e($docTitle) ?></h1>
    <div class="no"><?= e($docNo) ?></div>
    <?php if (!empty($docStamp)): ?><span class="doc-stamp <?= e($docStamp) ?>"><?= e($docStampLabel ?? $docStamp) ?></span><?php endif; ?>
  </div>
</div>
<div class="doc-meta">
  <?php foreach ($docMeta as $label => $value): ?><div><span><?= e($label) ?></span><b><?= e($value) ?></b></div><?php endforeach; ?>
</div>
<div class="doc-parties">
  <div>
    <h3><?= e($docTo ?? 'Bill to') ?></h3>
    <b><?= e($org['name']) ?></b><br>
    <span class="muted"><?= nl2br(e($org['address'] ?: '')) ?><?= $org['address'] ? '<br>' : '' ?><?= $org['company_reg'] ? 'Reg. ' . e($org['company_reg']) . '<br>' : '' ?><?= $org['vat_no'] ? 'VAT ' . e($org['vat_no']) . '<br>' : '' ?><?= $org['phone'] ? e($org['phone']) : '' ?></span>
  </div>
  <div>
    <h3>Customer number</h3>
    <b class="mono" style="font-size:18px;letter-spacing:.08em"><?= e($org['customer_no']) ?></b><br>
    <span class="muted">Use this number as your reference for every EFT payment.</span>
  </div>
</div>
