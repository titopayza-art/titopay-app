<?php $brand = $org['is_house'] ? null : $org['name']; ?>
<p style="margin:0 0 16px">Hi<?= $ticket['requester_name'] ? ' ' . e($ticket['requester_name']) : '' ?>,</p>
<p style="margin:0 0 16px">Thanks for contacting <?= e($org['is_house'] ? 'SeaGeek' : $org['name']) ?>. Your request <b>#<?= (int) $ticket['number'] ?></b> is with our team and we will reply here by email.</p>
<?= mail_button(app_url('/t/' . $ticket['token']), 'View your request') ?>
