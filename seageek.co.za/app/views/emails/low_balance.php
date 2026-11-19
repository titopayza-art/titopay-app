<p style="margin:0 0 16px">Hi <?= e($user['name']) ?>,</p>
<p style="margin:0 0 16px">Your SeaGeek credit is running low. <?= !empty($reason) ? e($reason) . '. ' : '' ?>When it runs out, live requests are refused until you add credit.</p>
<?= mail_details(['Credit balance' => zar($org['balance']), 'Customer no.' => $org['customer_no']]) ?>
<?= mail_button(app_url('/dashboard/billing#topup'), 'Add credit') ?>
