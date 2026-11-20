<p style="margin:0 0 6px;font-size:13px;color:#5b6f76">Reminder</p>
<p style="margin:0 0 16px;font-size:19px;font-weight:600;color:#13262c"><?= e($r['message']) ?></p>
<?= mail_details(['For' => (string) $r['name'], 'Set for' => gmdate('l j F, H:i', strtotime($r['due_at'] . ' UTC') + 7200) . ' SAST']) ?>
<?= mail_note('Set by your SeaGeek assistant. Ask it to change or cancel reminders any time.') ?>
