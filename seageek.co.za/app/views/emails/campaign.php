<?php foreach (preg_split('/\n{2,}/', trim($body)) as $para): ?><p style="margin:0 0 16px"><?= nl2br(e($para)) ?></p><?php endforeach; ?>
<?php if (!empty($button_label) && !empty($button_url)): ?><?= mail_button($button_url, $button_label) ?><?php endif; ?>
