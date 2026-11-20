<?php if ($state === 'down'): ?>
<p style="margin:0 0 16px"><b><?= e($m['name']) ?></b> is not answering.</p>
<?= mail_details(['Address' => $m['url'], 'Problem' => (string) $why, 'Noticed' => gmdate('j M Y H:i') . ' UTC']) ?>
<?= mail_note('We check again on schedule and email you the moment it is back.') ?>
<?php else: ?>
<p style="margin:0 0 16px"><b><?= e($m['name']) ?></b> is back up<?= $since ? ' after ' . e($since) : '' ?>.</p>
<?= mail_details(['Address' => $m['url'], 'Back at' => gmdate('j M Y H:i') . ' UTC']) ?>
<?php endif; ?>
<?= mail_button($link, 'Open the monitor') ?>
