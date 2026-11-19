<?php $brand = $org['is_house'] ? null : $org['name']; ?>
<div style="white-space:pre-wrap;margin:0 0 8px"><?= e($body) ?></div>
<?= mail_button(app_url('/t/' . $ticket['token']), 'Reply or view the conversation') ?>
<?= mail_note('Request #' . (int) $ticket['number'] . ' with ' . e($org['is_house'] ? 'SeaGeek' : $org['name']) . '.') ?>
