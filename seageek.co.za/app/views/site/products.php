<?php
/** Every product, shown the way the end customer sees it, with three steps and the price. */
$h1 = 'See how it works';
$lead = 'Every SeaGeek product, shown the way your customers will see it. Pick what you need, switch it on, and pay only for what you use.';
$meta = 'Pictures show example messages and numbers';
require APP_DIR . '/views/site/_pagehero.php';

$rate = function (string $unit): ?float { $v = DB::value('SELECT price FROM rates WHERE unit = ?', [$unit]); return $v === null ? null : (float) $v; };
$p = fn(string $unit) => ($v = $rate($unit)) === null ? '' : zar($v, 3);
$from = function (string $svc) { $v = DB::value('SELECT MIN(price) FROM rates WHERE service = ? AND unit <> ?', [$svc, 'wa_number']); return $v === null ? '' : zar((float) $v, 3); };
$status = fn(string $k) => Catalog::services()[$k]['status'] ?? 'live';
$signedIn = (bool) Auth::user();
$go = fn(string $path) => $signedIn ? $path : '/register';

$groups = [
    'messaging' => ['Messaging', ['sms', 'whatsapp', 'mail', 'voice', 'campaigns']],
    'identity' => ['Sign-in and identity', ['auth', 'verify']],
    'support' => ['AI assistants and customer service', ['assistants', 'ai', 'desk', 'chat']],
    'website' => ['Website and shop plug-ins', ['stores', 'forms', 'whatsapp_button', 'links', 'qr', 'monitor']],
];

$items = [
    'sms' => ['SMS', 'Text any South African cell number: order updates, reminders, alerts and promotions.',
        ['Write the message in your dashboard, a campaign or your own system through the API.', 'SeaGeek sends it over South African networks, from your sender name.', 'You see when it is delivered, and pay only for messages sent.'],
        $p('sms') . ' per SMS', '/dashboard/service/sms', '/docs/sms'],
    'whatsapp' => ['WhatsApp', 'Message customers on the app they already use, with buttons, images and replies.',
        ['Connect your business number once. We help with the Meta approval.', 'Send approved templates such as receipts, reminders or offers.', 'Customer replies land in your Desk inbox, where the AI or your team answers.'],
        'From ' . $from('whatsapp') . ' per message', '/dashboard/service/whatsapp', '/docs/whatsapp'],
    'mail' => ['Mail', 'Send invoices, receipts, password resets and newsletters that reach the inbox.',
        ['Add your domain and we give you the records that prove emails are really from you.', 'Send from your system, a campaign, or automatically from SeaGeek.', 'See deliveries, opens and bounces for every email.'],
        $p('email') . ' per email', '/dashboard/service/mail', '/docs/mail'],
    'voice' => ['Voice', 'Automated phone calls that read out a message: reminders, alerts and one-time codes.',
        ['Type what the call should say, in English or another supported language.', 'SeaGeek phones your customer and reads it out clearly.', 'They can press a key to confirm, and you see the answer.'],
        $p('voice_minute') . ' per minute', '/dashboard/service/voice', '/docs/voice'],
    'campaigns' => ['Campaigns', 'Bulk SMS and email newsletters to your contact lists, with ready-made templates.',
        ['Import contacts from a spreadsheet, or use the list your store builds.', 'Write from a template and add each person\'s name automatically.', 'Send now or schedule it. Opt-outs are handled for you.'],
        'At the SMS and email rates', '/dashboard/campaigns', '/docs/sms'],
    'auth' => ['Auth', 'One-time codes that prove a customer owns their phone or email, for sign-in and payments.',
        ['Your app asks SeaGeek for a code for the customer.', 'We send it by SMS, WhatsApp, email or voice call, with automatic fallback.', 'Your app checks the code they type. Expiry and retries are handled.'],
        'From ' . $from('auth') . ' per code', '/dashboard/service/auth', '/docs/auth'],
    'verify' => ['Verify', 'Check a South African ID number, a face photo, a company or a bank account in seconds.',
        ['Send the ID number, company number or bank details from your app or dashboard.', 'SeaGeek checks them with the official sources.', 'You get a clear result with each part matched or not.'],
        'From ' . $from('verify') . ' per check', '/dashboard/service/verify', '/docs/verify'],
    'assistants' => ['AI assistants', 'Your own AI assistants for work and projects. They plan, keep your tasks, remind you, draft messages and answer from your documents.',
        ['Pick a role: personal assistant, project manager, sales, support, research or HR, and add your documents.', 'Ask in plain words. It creates tasks and projects, sets reminders and drafts emails and SMS.', 'Nothing is sent until you press Send. Share it with your team, a customer link, or your own app.'],
        'Pay per use from your credit, with a monthly cap', '/dashboard/assistants', '/docs/ai'],
    'ai' => ['SeaGeek AI', 'A smart assistant for your business: answers questions, writes replies and sorts messages, in many languages.',
        ['Add your help articles, prices and policies.', 'The AI answers customers instantly, using only what you gave it.', 'When it is unsure, it hands over to a person. You set a monthly spending cap.'],
        'Pay per use, with a spending cap', '/dashboard/service/ai', '/docs/ai'],
    'desk' => ['Desk', 'One inbox for customer service: website chat, email, WhatsApp and forms, with a help centre.',
        ['Messages from every channel arrive as tickets in one place.', 'The AI answers the easy ones; your team takes the rest.', 'Track response times, and publish help articles for customers.'],
        'Included in every plan', '/dashboard/desk', '/docs/desk'],
    'chat' => ['Website chat', 'A chat box on your website, answered by SeaGeek AI and your team.',
        ['Copy one line into your website.', 'Visitors ask questions and get instant answers.', 'Hard questions move to your Desk inbox for a person.'],
        'Included', '/dashboard/chat', null],
    'stores' => ['Store SMS', 'Order updates by SMS for Shopify, WooCommerce and other online shops.',
        ['Connect your store with a link or our plugin.', 'Pick which messages to send: order placed, paid, shipped, abandoned cart.', 'Customers get each update by SMS, automatically.'],
        $p('store_sms') . ' per SMS', '/dashboard/stores', '/docs/stores'],
    'forms' => ['Website forms', 'Get every contact and quote form message by email, in Desk or as an SMS.',
        ['Create a form in your dashboard.', 'Point your website form at the SeaGeek address.', 'Each message is emailed to you and saved. Spam bots are filtered out.'],
        'Free. SMS alerts at the SMS rate', '/dashboard/forms', null],
    'whatsapp_button' => ['WhatsApp button', 'A "Chat on WhatsApp" button on your website that opens a chat with your number.',
        ['Type your WhatsApp number.', 'Copy one line into your website.', 'Visitors tap it and start a chat in their own WhatsApp.'],
        'Free', '/dashboard/chat#whatsapp', null],
    'links' => ['Short links', 'Short, tidy links that count clicks and can be changed later.',
        ['Paste a long link.', 'Share the short one in SMS, posters or social posts.', 'See clicks per day, and point it somewhere new any time.'],
        'Free', '/dashboard/links', null],
    'qr' => ['QR codes', 'Paste a link and get a QR code for menus, flyers, packaging and signage.',
        ['Paste the link people should open.', 'Download the code as PNG or print-ready SVG.', 'See how many people scan it, and change where it points.'],
        $p('qr_code') . ' per code', '/dashboard/qr', '/docs/qr'],
    'monitor' => ['Website monitor', 'Know the moment your website goes down, before your customers tell you.',
        ['Enter your website address.', 'SeaGeek checks it every few minutes.', 'If it goes down you get an SMS and an email, and another when it is back.'],
        'Free. SMS alerts at the SMS rate', '/dashboard/monitors', null],
];
$qr = Totp::qrSvg('https://www.seageek.co.za/plugins');
?>
<nav class="prod-tabs" aria-label="Product groups"><div class="wrap">
  <?php foreach ($groups as $g => [$label]): ?><a href="#<?= $g ?>"><?= e($label) ?></a><?php endforeach; ?>
</div></nav>

<?php foreach ($groups as $g => [$label, $keys]): ?>
<section class="section prod-group" id="<?= $g ?>"><div class="wrap">
  <h2 class="prod-group-title"><?= e($label) ?></h2>
  <?php foreach ($keys as $i => $k): [$name, $summary, $steps, $price, $setup, $docs] = $items[$k]; $st = in_array($k, array_keys(Catalog::baseServices()), true) ? $status($k) : 'live'; ?>
  <article class="prod-row<?= $i % 2 ? ' flip' : '' ?>" id="<?= $k ?>">
    <div class="prod-text">
      <div class="prod-name"><h3><?= e($name) ?></h3><?php if ($st !== 'live'): ?><span class="pill amber"><?= e(Catalog::statusLabel($st) ?? 'Coming soon') ?></span><?php endif; ?></div>
      <p class="prod-sum"><?= e($summary) ?></p>
      <ol class="prod-steps"><?php foreach ($steps as $n => $s): ?><li><b><?= $n + 1 ?></b><span><?= e($s) ?></span></li><?php endforeach; ?></ol>
      <p class="prod-price"><?= e($price) ?></p>
      <div class="prod-links">
        <?php if ($st === 'live'): ?><a class="btn btn-primary btn-sm" href="<?= e($go($setup)) ?>"><?= $signedIn ? 'Set it up' : 'Start with Pay as you Use' ?></a><?php else: ?><a class="btn btn-ghost btn-sm" href="/contact">Get told when it opens</a><?php endif; ?>
        <?php if ($docs): ?><a class="link" href="<?= e($docs) ?>">For developers: API docs</a><?php endif; ?>
      </div>
    </div>
    <div class="prod-visual" aria-hidden="true">
<?php switch ($k):
case 'sms': ?>
      <div class="phone"><div class="ph-bar"><span>09:41</span><span>KASIBITES</span></div><div class="ph-screen sms-app">
        <div class="ph-day">Today</div>
        <div class="bub in d1">Hi Thandi, your order #1042 is on its way. Track it here: sgk.co.za/t/1042</div>
        <div class="bub in d2">Driver Sipho will arrive between 14:00 and 15:00.</div>
        <div class="ph-note d3">Delivered</div>
      </div></div>
<?php break; case 'whatsapp': ?>
      <div class="phone"><div class="ph-bar wa"><span>Kasi Bites</span><span class="tick">Business account</span></div><div class="ph-screen wa-app">
        <div class="bub wa-in d1"><b>Your order is ready</b>Hi Thandi, order #1042 is ready for collection at our Maboneng shop.<span class="wa-btns"><i>Get directions</i><i>Talk to us</i></span></div>
        <div class="bub wa-out d2">Thanks! Can I collect at 5?</div>
        <div class="bub wa-in d3">Yes, we are open until 19:00. See you at 5.<small>Answered by AI</small></div>
      </div></div>
<?php break; case 'mail': ?>
      <div class="browser"><div class="br-bar"><i></i><i></i><i></i><span>Inbox</span></div><div class="br-screen mail-app">
        <div class="mail-list"><div class="ml on d1"><b>Acme Stores</b><span>Invoice INV-2041 for R1,250.00</span></div><div class="ml d2"><b>Acme Stores</b><span>Your password reset link</span></div><div class="ml d3"><b>Acme Stores</b><span>December specials are here</span></div></div>
        <div class="mail-open d2"><div class="mo-from"><span class="av">A</span><div><b>Acme Stores</b><small>billing@acme.co.za</small></div></div><h4>Invoice INV-2041</h4><p>Hi Thandi, thank you for your order. Your invoice for R1,250.00 is attached.</p><span class="mo-btn">View invoice</span></div>
      </div></div>
<?php break; case 'voice': ?>
      <div class="phone"><div class="ph-screen call-app">
        <div class="call-who d1"><span class="av big">AC</span><b>Acme Clinic</b><small>Calling…</small></div>
        <div class="call-say d2">"Hello Thandi. This is a reminder of your appointment tomorrow at 10:00 with Dr Naidoo. Press 1 to confirm or 2 to reschedule."</div>
        <div class="call-keys d3"><i>1</i><i>2</i><i>3</i></div>
        <div class="call-btns"><span class="no"></span><span class="yes"></span></div>
      </div></div>
<?php break; case 'campaigns': ?>
      <div class="browser"><div class="br-bar"><i></i><i></i><i></i><span>Campaign: December specials</span></div><div class="br-screen camp-app">
        <div class="camp-stats"><div class="d1"><small>Sent</small><b>2,400</b></div><div class="d2"><small>Delivered</small><b>2,352</b></div><div class="d3"><small>Clicked</small><b>312</b></div></div>
        <div class="camp-msg d2"><small>Message</small><p>Hi {name}, 20% off all platters this weekend at Kasi Bites. Order: sgk.co.za/l/dec. Reply STOP to opt out.</p></div>
        <div class="camp-bar d3"><span style="width:98%"></span></div><small class="camp-cap d3">Delivery progress</small>
      </div></div>
<?php break; case 'auth': ?>
      <div class="phone"><div class="ph-screen otp-app">
        <div class="ph-banner d1"><b>Messages</b>Your Acme code is 482 917. It expires in 5 minutes.</div>
        <div class="otp-box d2"><b>Enter your code</b><small>We sent a 6-digit code to 082 *** 4567</small><div class="otp-digits"><i>4</i><i>8</i><i>2</i><i>9</i><i>1</i><i>7</i></div><span class="otp-ok d3">Verified</span></div>
      </div></div>
<?php break; case 'verify': ?>
      <div class="browser"><div class="br-bar"><i></i><i></i><i></i><span>ID check</span></div><div class="br-screen ver-app">
        <div class="ver-head d1"><span class="av big">TM</span><div><b>Thandi Mokoena</b><small>ID 9001015009087</small></div><span class="ver-badge">Verified</span></div>
        <ul class="ver-list">
          <li class="d1"><span>ID number is valid</span><i class="ok"></i></li>
          <li class="d2"><span>Name matches Home Affairs</span><i class="ok"></i></li>
          <li class="d2"><span>Face matches ID photo</span><i class="ok"></i></li>
          <li class="d3"><span>Not on PEP or sanctions lists</span><i class="ok"></i></li>
          <li class="d3"><span>Bank account in her name</span><i class="ok"></i></li>
        </ul>
      </div></div>
<?php break; case 'assistants': ?>
      <div class="chatwin asst-vis"><div class="cw-head"><b>Nandi · Project manager</b><small>Your assistant</small></div><div class="cw-body">
        <div class="bub out d1">Plan the website relaunch for the next two weeks and email Thabo</div>
        <div class="vis-done d2"><span>✓ Created project Website relaunch</span><span>✓ Task: Write home page copy, due Fri</span><span>✓ Task: Choose photos, due Mon</span></div>
        <div class="bub in d2">Done. I set up the project with two tasks and drafted an email to Thabo.</div>
        <div class="vis-draft d3"><b>Email to thabo@kasibites.co.za</b><span>Draft, needs your approval</span><i><em>Send</em><em>Cancel</em></i></div>
      </div></div>
<?php break; case 'ai': ?>
      <div class="chatwin"><div class="cw-head"><b>Kasi Bites</b><small>Assistant replies straight away</small></div><div class="cw-body">
        <div class="bub out d1">Do you deliver to Soweto on Sundays?</div>
        <div class="bub in d2"><small class="who">Assistant</small>Yes. We deliver to Soweto every day from 10:00 to 20:00. Delivery costs R35 and is free on orders over R300.</div>
        <div class="bub out d3">Ngiyabonga!</div>
        <div class="bub in d3"><small class="who">Assistant</small>Wamukelekile! Would you like the menu?</div>
      </div></div>
<?php break; case 'desk': ?>
      <div class="browser"><div class="br-bar"><i></i><i></i><i></i><span>Desk</span></div><div class="br-screen desk-app">
        <div class="dk-row head"><span>Ticket</span><span>From</span><span>Status</span></div>
        <div class="dk-row d1"><span><b>#1042 Refund for damaged item</b><small>Email</small></span><span>Sipho D.</span><span class="pill amber">Open</span></div>
        <div class="dk-row d2"><span><b>#1043 Catering for 40 people</b><small>Website form</small></span><span>Lerato K.</span><span class="pill">New</span></div>
        <div class="dk-row d2"><span><b>#1044 Opening hours on holidays</b><small>WhatsApp, answered by AI</small></span><span>Zola M.</span><span class="pill green">Solved</span></div>
        <div class="dk-row d3"><span><b>#1045 Change my delivery address</b><small>Chat, handed to a person</small></span><span>Ayesha P.</span><span class="pill amber">Open</span></div>
      </div></div>
<?php break; case 'chat': ?>
      <div class="browser"><div class="br-bar"><i></i><i></i><i></i><span>kasibites.co.za</span></div><div class="br-screen site-app">
        <div class="site-hero"><b>Kasi Bites</b><span></span><span class="s"></span></div>
        <div class="site-chat d1"><div class="sc-head">Chat with us</div><div class="bub in d1">Hi! Ask us about the menu, delivery or opening hours.</div><div class="bub out d2">Are you open on Monday?</div><div class="bub in d3">Yes, from 09:00 to 19:00.</div></div>
        <span class="site-fab d1">Chat with us</span>
      </div></div>
<?php break; case 'stores': ?>
      <div class="phone"><div class="ph-bar"><span>09:41</span><span>KASIBITES</span></div><div class="ph-screen sms-app">
        <div class="ph-day">Today</div>
        <div class="bub in d1">Thanks Thandi! We received order #1042 for R899.00.</div>
        <div class="bub in d2">Payment received for order #1042. We are packing it now.</div>
        <div class="bub in d3">Order #1042 has shipped. Track it: sgk.co.za/t/1042</div>
        <div class="store-tag d3"><span>Shopify</span><span>WooCommerce</span><span>Wix</span></div>
      </div></div>
<?php break; case 'forms': ?>
      <div class="split-vis">
        <div class="mini-form d1"><b>Get a quote</b><span class="mf-in">Lerato Khumalo</span><span class="mf-in">lerato@example.co.za</span><span class="mf-in tall">Catering for 40 people on Saturday?</span><span class="mf-btn">Send</span></div>
        <div class="vis-arrow d2"></div>
        <div class="stack-vis">
          <div class="notif d2"><b>New message from Quote request</b><span>Lerato Khumalo: Catering for 40 people on Saturday?</span></div>
          <div class="notif d3"><b>Desk ticket #1046 opened</b><span>Reply from Desk or straight from the email</span></div>
          <div class="notif sms d3"><b>SMS alert</b><span>New quote request from Lerato</span></div>
        </div>
      </div>
<?php break; case 'whatsapp_button': ?>
      <div class="browser"><div class="br-bar"><i></i><i></i><i></i><span>kasibites.co.za</span></div><div class="br-screen site-app">
        <div class="site-hero"><b>Kasi Bites</b><span></span><span class="s"></span></div>
        <div class="site-cards"><i></i><i></i><i></i></div>
        <span class="wa-fab d1">Chat on WhatsApp</span>
      </div></div>
<?php break; case 'links': ?>
      <div class="browser"><div class="br-bar"><i></i><i></i><i></i><span>Short links</span></div><div class="br-screen link-app">
        <div class="lk-long d1">kasibites.co.za/specials/december-2026?utm_source=sms&amp;utm_campaign=dec</div>
        <div class="vis-arrow down d2"></div>
        <div class="lk-short d2"><em>seageek.co.za/l/<b>december</b></em><span>Copy</span></div>
        <div class="lk-chart d3"><?php foreach ([2, 4, 3, 6, 9, 12, 8, 14, 18, 11, 9, 16, 20, 17] as $h): ?><i style="height:<?= $h * 5 ?>%"></i><?php endforeach; ?></div>
        <small class="lk-cap d3">312 clicks this month · iPhone 54% · Android 41%</small>
      </div></div>
<?php break; case 'qr': ?>
      <div class="poster d1">
        <b>Scan for our menu</b>
        <div class="qr-img"><?= $qr ?></div>
        <small>Kasi Bites · Maboneng</small>
        <span class="scan-chip d3">412 scans this month</span>
      </div>
<?php break; case 'monitor': ?>
      <div class="split-vis">
        <div class="mon-list d1">
          <div class="mon-row"><span class="dot up"></span><b>Online shop</b><small>Up · 99.98%</small></div>
          <div class="mon-row"><span class="dot down"></span><b>Booking site</b><small>Down · 4 minutes</small></div>
          <div class="mon-row"><span class="dot up"></span><b>Company website</b><small>Up · 100%</small></div>
        </div>
        <div class="vis-arrow d2"></div>
        <div class="phone small"><div class="ph-screen sms-app"><div class="bub in d2">SeaGeek monitor: Booking site is DOWN. The site answered with error 503.</div><div class="bub in d3">Booking site is back UP after 6 minutes.</div></div></div>
      </div>
<?php break; endswitch; ?>
    </div>
  </article>
  <?php endforeach; ?>
</div></section>
<?php endforeach; ?>

<section class="section" style="padding-top:0"><div class="wrap">
  <div class="card prod-cta">
    <div><h2>One account for all of it</h2><p class="muted">One login, one prepaid balance in rand, one invoice. Start with what you need today and switch on more later.</p></div>
    <div class="cta-row" style="margin-top:0"><a class="btn btn-primary" href="/register">Create a free account</a><a class="btn btn-ghost" href="/quote">Get a quote</a></div>
  </div>
</div></section>
<script>
(function () {
  var rows = document.querySelectorAll('.prod-visual');
  if (!('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) { rows.forEach(function (r) { r.classList.add('play'); }); return; }
  var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('play'); io.unobserve(e.target); } }); }, { threshold: 0.3 });
  rows.forEach(function (r) { r.classList.add('anim'); io.observe(r); });
})();
</script>
