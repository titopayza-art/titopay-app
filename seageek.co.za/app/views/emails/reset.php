<p style="margin:0 0 16px">Hi <?= e($name) ?>,</p>
<p style="margin:0 0 16px">Use the button below to choose a new password. The link works for one hour.</p>
<?= mail_button($link, 'Reset password') ?>
<?= mail_note('If you did not ask for this, ignore this email. Your password stays the same.') ?>
