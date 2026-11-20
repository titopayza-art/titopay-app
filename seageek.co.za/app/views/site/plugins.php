<?php
$h1 = 'Plug-ins';
$lead = 'Tools for your website and shop that you switch on by copying one line or pasting a link. No developer needed.';
$meta = 'Most are free with a SeaGeek account';
require APP_DIR . '/views/site/_pagehero.php';
$steps = [
    'chat' => ['Paste one line before </body>', 'Pick a colour and greeting', 'Reply to handed-over chats in Desk'],
    'whatsapp_button' => ['Enter your WhatsApp number', 'Paste one line on your site', 'Chats open in your own WhatsApp'],
    'forms' => ['Create a form in your dashboard', 'Set your form\'s action to the SeaGeek address', 'Get each message by email, Desk or SMS'],
    'links' => ['Paste a long link', 'Choose your own ending if you like', 'Share it and watch the clicks'],
    'monitor' => ['Enter your website address', 'Choose how often to check', 'Get an SMS the moment it goes down'],
    'qr' => ['Paste a link', 'Download PNG or SVG', 'Print it and count the scans'],
    'stores' => ['Connect Shopify, WooCommerce or another store', 'Pick which order messages to send', 'Customers get updates by SMS'],
    'campaigns' => ['Import contacts or use your store list', 'Write from a template', 'Send now or schedule, with opt-outs handled'],
];
?>
<section class="section" style="padding-top:56px"><div class="wrap">
  <div class="tool-grid tool-grid-site">
    <?php foreach (Plugins::all() as $k => [$name, $ic, $href, $summary, $price]): ?>
      <article class="card tool-card">
        <div class="tool-top"><span class="tool-icon"><?= icon($ic) ?></span><span class="tool-price"><?= e($price) ?></span></div>
        <h3><?= e($name) ?></h3>
        <p><?= e($summary) ?></p>
        <ol class="mini-steps"><?php foreach ($steps[$k] ?? [] as $st): ?><li><?= e($st) ?></li><?php endforeach; ?></ol>
      </article>
    <?php endforeach; ?>
  </div>
  <div class="cta-row">
    <a class="btn btn-primary" href="/register">Create a free account</a>
    <a class="btn btn-ghost" href="/contact">Ask us a question</a>
  </div>
  <p class="muted small" style="margin-top:14px">SMS sent by plug-ins (form alerts, website monitor alerts, store messages, campaigns) is paid from your prepaid credit at the rates on the <a class="link" href="/pricing">pricing page</a>. Developers can do all of this and more with the <a class="link" href="/docs">APIs</a>.</p>
</div></section>
