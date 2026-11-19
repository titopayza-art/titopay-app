<p style="margin:0 0 16px">Hi <?= e($name) ?>,</p>
<p style="margin:0 0 16px">Confirm your email address to finish creating your SeaGeek account. Your sandbox API key is created as soon as you do.</p>
<?= mail_button($link, 'Confirm email') ?>
<?= mail_note('The link works for 3 days. If you did not sign up, ignore this email.') ?>
