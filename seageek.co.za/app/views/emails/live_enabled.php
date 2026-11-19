<p style="margin:0 0 16px">Hi <?= e($user['name']) ?>,</p>
<p style="margin:0 0 16px">Live access is on for <b><?= e($org['name']) ?></b>. Your live API key is in the dashboard under API keys. Swap it in for your sandbox key and you are sending for real.</p>
<?= mail_button(app_url('/dashboard/keys'), 'Open API keys') ?>
