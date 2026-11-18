<?php foreach (take_flash() as [$type, $msg]): ?>
<div class="alert alert-<?= $type === 'ok' ? 'ok' : 'error' ?>" role="status"><?= e($msg) ?></div>
<?php endforeach; ?>
