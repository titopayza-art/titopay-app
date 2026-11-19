<p style="margin:0 0 16px">Hi,</p>
<p style="margin:0 0 16px"><?= e($by['name']) ?> added you to <b><?= e($org['name']) ?></b> on SeaGeek. Choose a password to sign in.</p>
<?= mail_button($link, 'Set your password') ?>
<?= mail_note('The link works for 3 days.') ?>
