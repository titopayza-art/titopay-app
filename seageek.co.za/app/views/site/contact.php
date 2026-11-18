<?php $h1 = 'Contact'; $meta = 'hello@seageek.co.za'; $lead = 'Questions about products, pricing, partnerships or investment. Every message becomes a ticket, so nothing gets lost.'; require APP_DIR . '/views/site/_pagehero.php'; ?>
<section class="section" style="padding-top:56px"><div class="wrap platform" style="align-items:start">
  <form method="post" class="panel form" style="padding:clamp(20px,3vw,32px)"><?= csrf_field() ?>
    <?php require APP_DIR . '/views/partials/flash.php'; ?>
    <div class="row"><div class="field"><label for="c-name">Name</label><input id="c-name" name="name" autocomplete="name" required></div><div class="field"><label for="c-email">Email</label><input id="c-email" name="email" type="email" autocomplete="email" required></div></div>
    <div class="row"><div class="field"><label for="c-phone">Phone (optional)</label><input id="c-phone" name="phone" type="tel" autocomplete="tel"></div><div class="field"><label for="c-topic">Topic</label><select id="c-topic" name="topic"><option>Sales</option><option>Technical support</option><option>Billing</option><option>Partnership</option><option>Investment</option><option>Other</option></select></div></div>
    <div class="field"><label for="c-msg">Message</label><textarea id="c-msg" name="message" required></textarea></div>
    <label class="consent"><input type="checkbox" required><span>SeaGeek may use these details to reply, as described in the <a class="link" href="/privacy">privacy notice</a>.</span></label>
    <button class="btn btn-primary">Send</button>
  </form>
  <div class="stack">
    <div class="card"><span class="k">Email</span><h3><a href="mailto:hello@seageek.co.za">hello@seageek.co.za</a></h3><p>Sales, support, partnerships and investors.</p></div>
    <div class="card"><span class="k">Live chat</span><h3>Bottom right of every page</h3><p>Our assistant answers straight away and brings in a person when needed. <?= e(Settings::get('support_hours')) ?>.</p></div>
    <div class="card"><span class="k">Help centre</span><h3><a href="/help">Browse articles</a></h3><p>Getting started, billing, WhatsApp, AI limits and Desk.</p></div>
  </div>
</div></section>
