<p style="margin:0 0 16px">Hi <?= e($user['name']) ?>,</p>
<p style="margin:0 0 16px"><?= $days <= 0 ? 'Invoice <b>' . e($invoice['number']) . '</b> is due today.' : 'Invoice <b>' . e($invoice['number']) . '</b> is ' . (int) $days . ' day' . ($days === 1 ? '' : 's') . ' overdue.' ?>
<?= $lock_in > 0 ? 'If it stays unpaid, live API access pauses in ' . (int) $lock_in . ' day' . ($lock_in === 1 ? '' : 's') . '. Sandbox keeps working.' : 'Live API access pauses soon if it stays unpaid.' ?></p>
<?= mail_details(['Invoice' => $invoice['number'], 'Amount' => zar($invoice['total']), 'EFT reference' => $org['customer_no']]) ?>
<?= mail_button(app_url('/dashboard/pay/' . $invoice['number']), 'Pay now') ?>
<?= mail_note('Already paid by EFT without the reference? Reply with your proof of payment and we will match it.') ?>
