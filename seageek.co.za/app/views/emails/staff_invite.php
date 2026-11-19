<p style="margin:0 0 16px">Hi <?= e($name) ?>,</p>
<p style="margin:0 0 16px"><?= e($by['name']) ?> added you to the SeaGeek team as <b><?= e($role) ?></b>. Choose a password to open the admin console.</p>
<?= mail_button($link, 'Set your password') ?>
<?= mail_note('The link works for 3 days. If you were not expecting this, ignore this email.') ?>
