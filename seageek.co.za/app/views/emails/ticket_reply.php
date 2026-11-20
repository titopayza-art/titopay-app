<?php $brand = $org['is_house'] ? null : $org['name']; $files = $files ?? []; ?>
<p style="margin:0 0 14px;font-size:12px;color:#8a9ba1"><?= e(DeskFlow::MARKER) ?></p>
<div style="white-space:pre-wrap;margin:0 0 8px"><?= e($body) ?></div>
<?php if ($files): ?>
<p style="margin:18px 0 6px;font-size:14px;font-weight:600;color:#13262c">Attached</p>
<?php foreach ($files as $f): ?><p style="margin:0 0 4px;font-size:14px"><a href="<?= e(DeskFiles::url($f)) ?>" style="color:#0f8f80"><?= e($f['name']) ?></a> <span style="color:#8a9ba1">(<?= e(DeskFiles::human((int) $f['size'])) ?>)</span></p><?php endforeach; ?>
<?php endif; ?>
<?= mail_button(app_url('/t/' . $ticket['token']), 'View the conversation') ?>
<?= mail_note('Reply to this email to answer. Request #' . (int) $ticket['number'] . ' with ' . e($org['is_house'] ? 'SeaGeek' : $org['name']) . '.') ?>
