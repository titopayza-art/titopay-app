<?php $what = ($what ?? 'qr') === 'link' ? 'link' : 'QR code'; ?>
<h1 style="font-size:24px;margin-top:18px"><?= $paused ? 'This ' . $what . ' is paused' : ucfirst($what) . ' not found' ?></h1>
<p class="muted" style="margin-top:8px"><?= $paused ? 'The business that shared it has paused it for now. Try again later or contact them directly.' : 'It may have been deleted or mistyped.' ?></p>
<a class="btn btn-ghost" style="margin-top:18px" href="/">Go to seageek.co.za</a>
<?php $poweredRef = ($what ?? 'qr') === 'link' ? 'links' : 'qr'; require APP_DIR . '/views/partials/powered.php'; ?>
