<p style="margin:0 0 16px">Hi <?= e($user['name']) ?>,</p>
<p style="margin:0 0 16px">Thank you. We have received your payment of <b><?= zar($invoice['total']) ?></b>.</p>
<?= mail_details(['Invoice' => $invoice['number'], 'For' => $invoice['description'], 'Amount paid' => zar($invoice['total']), 'Customer no.' => $org['customer_no']]) ?>
<?= mail_button(app_url('/dashboard/invoice/' . $invoice['number']), 'View invoice') ?>
<?= mail_note('Your monthly statement is in the dashboard under Invoices. Contact ' . e(Settings::get('support_email')) . ' if you do not recognise this payment.') ?>
