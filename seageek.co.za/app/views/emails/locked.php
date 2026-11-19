<p style="margin:0 0 16px">Hi <?= e($user['name']) ?>,</p>
<p style="margin:0 0 16px">Live API access for <b><?= e($org['name']) ?></b> is paused because invoice <b><?= e($invoice['number']) ?></b> is unpaid. Your sandbox keys and data are untouched, and access comes back on its own as soon as the payment clears.</p>
<?= mail_details(['Invoice' => $invoice['number'], 'Amount' => zar($invoice['total']), 'EFT reference' => $org['customer_no']]) ?>
<?= mail_button(app_url('/dashboard/pay/' . $invoice['number']), 'Pay and restore access') ?>
