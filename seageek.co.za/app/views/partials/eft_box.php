<?php /* Bank details with the customer number as reference. Expects $org; optional $eftAmount. */ ?>
<div class="doc-note">
  <b>Pay by EFT</b>, using your customer number <b class="mono"><?= e($org['customer_no']) ?></b> as the reference. Payments are matched to your account automatically.
  <dl>
    <dt>Bank</dt><dd><?= e(Settings::get('bank_name') ?: 'Shared on request') ?></dd>
    <dt>Account name</dt><dd><?= e(Settings::get('bank_account_name')) ?></dd>
    <dt>Account number</dt><dd><?= e(Settings::get('bank_account_number') ?: 'Shared on request') ?></dd>
    <dt>Branch code</dt><dd><?= e(Settings::get('bank_branch_code') ?: 'Universal') ?></dd>
    <dt>Account type</dt><dd><?= e(Settings::get('bank_account_type')) ?></dd>
    <dt>Reference</dt><dd><?= e($org['customer_no']) ?></dd>
    <?php if (!empty($eftAmount)): ?><dt>Amount</dt><dd><?= zar($eftAmount) ?></dd><?php endif; ?>
  </dl>
</div>
