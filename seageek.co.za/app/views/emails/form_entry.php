<p style="margin:0 0 16px">Someone filled in <b><?= e($form['name']) ?></b> on your website.</p>
<?= mail_details(array_combine(array_map(fn($k) => ucfirst(str_replace('_', ' ', $k)), array_keys($data)), array_values($data)) + ($page ? ['Sent from' => $page] : [])) ?>
<?= mail_button($link, 'See all messages') ?>
<?= mail_note('Reply to this email to answer them directly.' . ($form['to_desk'] ? ' It is also in your Desk inbox as a ticket.' : '')) ?>
