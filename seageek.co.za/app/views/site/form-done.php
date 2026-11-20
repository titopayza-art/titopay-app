<h1 style="font-size:24px;margin-top:18px"><?= e($ok ? 'Message sent' : 'Message not sent') ?></h1>
<p class="muted" style="margin-top:8px"><?= e($msg) ?></p>
<?php if ($back && preg_match('#^https?://#i', $back)): ?><a class="btn btn-ghost" style="margin-top:18px" href="<?= e($back) ?>">Back to the website</a><?php endif; ?>
<p class="muted small" style="margin-top:22px">Form handled by SeaGeek.</p>
