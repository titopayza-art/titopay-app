<p style="margin:0 0 16px">Hi <?= e($user['name']) ?>,</p>
<p style="margin:0 0 16px">Invoice <b><?= e($invoice['number']) ?></b> is ready. <?= e($invoice['description']) ?>.</p>
<?= mail_details(['Invoice' => $invoice['number'], 'Amount' => zar($invoice['total']), 'Due' => date('j F Y', strtotime($invoice['due_at'])), 'EFT reference' => $org['customer_no']]) ?>
<?= mail_button(app_url('/dashboard/pay/' . $invoice['number']), 'Pay ' . zar($invoice['total'])) ?>
<?= mail_note('Pay by card, Instant EFT or bank transfer. For a bank transfer use your customer number <b>' . e($org['customer_no']) . '</b> as the reference and we match it automatically.') ?>
