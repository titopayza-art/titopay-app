<p style="margin:0 0 8px;font-size:12px;font-weight:600;color:#c2353b;text-transform:uppercase;letter-spacing:.04em">Needs attention now</p>
<p style="margin:0 0 12px;font-size:18px;font-weight:600;color:#13262c"><?= e(preg_replace('/^Urgent: /', '', $title)) ?></p>
<p style="margin:0 0 16px"><?= e($detail) ?></p>
<?= mail_button($link, 'Open it') ?>
<?= mail_note('You get this once, and again every 6 hours while the problem lasts. When it is fixed, the alerts stop.') ?>
