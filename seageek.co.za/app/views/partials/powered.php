<?php /** "Powered by SeaGeek" on pages SeaGeek shows under a customer's brand. Set $poweredRef to say where it was seen. */ ?>
<p class="powered-wrap"><a class="powered" href="<?= e(app_url('/?ref=powered-' . ($poweredRef ?? 'page'))) ?>" target="_blank" rel="noopener"><?php require APP_DIR . '/views/partials/logo.php'; ?><span>Powered by <b>SeaGeek</b></span></a></p>
