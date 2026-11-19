<p style="margin:0 0 16px">Hi <?= e($user['name']) ?>,</p>
<p style="margin:0 0 16px">Thank you for your payment. Live access for <b><?= e($org['name']) ?></b> is back on.</p>
<?= mail_button(app_url('/dashboard'), 'Open your dashboard') ?>
