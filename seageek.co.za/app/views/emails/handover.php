<p style="margin:0 0 16px"><b>#<?= (int) $ticket['number'] ?> <?= e($ticket['subject']) ?></b> needs a person.</p>
<?= mail_details(['Reason' => $reason, 'From' => trim(($ticket['requester_name'] ?: '') . ' ' . ($ticket['requester_email'] ?: $ticket['requester_phone'] ?: '')), 'Channel' => channel_label((string) $ticket['channel'])]) ?>
<?= mail_button(app_url(Desk::house()['id'] == $ticket['org_id'] ? '/admin/desk/' . $ticket['number'] : '/dashboard/desk/' . $ticket['number']), 'Open ticket') ?>
