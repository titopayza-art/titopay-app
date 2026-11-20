<?php
$h1 = 'Build with SeaGeek';
$meta = 'For South African startups';
$lead = 'You are building something new. We give you the messaging, identity, AI and support building blocks, launch credit to get going, and rand pricing that grows with you.';
require APP_DIR . '/views/site/_pagehero.php';
$credit = (float) Settings::get('startup_credit');
$months = (int) Settings::get('startup_plan_months');
$startup = DB::one("SELECT * FROM plans WHERE code = 'startup'");
?>
<section class="section" style="padding-top:56px"><div class="wrap">
  <div class="section-head"><h2>What you get</h2></div>
  <div class="grid-3">
    <div class="card"><span class="k">Launch credit</span><h3><?= zar($credit, 0) ?> of free credit</h3><p>Spend it on any product: SMS, email, WhatsApp, OTP codes, ID checks, AI, QR codes or store SMS.</p></div>
    <div class="card"><span class="k">Startup plan</span><h3>Free for <?= $months ?> months</h3><p>Normally <?= zar($startup['price'] ?? 299, 0) ?> a month, with <?= zar($startup['included_credit'] ?? 150, 0) ?> of usage credit included every month.</p></div>
    <div class="card"><span class="k">Engineers on call</span><h3>Help from our team</h3><p>Direct help from the people who build SeaGeek while you integrate, through Desk and chat.</p></div>
    <div class="card"><span class="k">Free sandbox</span><h3>Build before you pay</h3><p>Every product has a sandbox with realistic results, so you can finish your integration first.</p></div>
    <div class="card"><span class="k">One bill in rand</span><h3>No dollar surprises</h3><p>Prepaid credit or invoices, paid by card, Instant EFT or bank transfer. No contracts.</p></div>
    <div class="card"><span class="k">Grow with us</span><h3>Better prices as you scale</h3><p>Plan discounts of 5 to 15% on every product, AI with spending caps, and Desk included.</p></div>
  </div>
</div></section>
<section class="section" style="padding-top:0"><div class="wrap platform" style="align-items:start">
  <div class="stack">
    <div class="card"><span class="k">Who can apply</span><ul class="plain" style="margin-top:8px">
      <li>A South African startup or founder team.</li>
      <li>Building a product that will use at least one SeaGeek product.</li>
      <li>New to SeaGeek, or on our platform for less than three months.</li>
    </ul></div>
    <div class="card"><span class="k">How it works</span><ol class="howto">
      <li><b>1</b><span>Apply with the form. It takes two minutes.</span></li>
      <li><b>2</b><span>We reply within two working days, usually with a short call.</span></li>
      <li><b>3</b><span>Your credit and plan are added to your account and you start building.</span></li>
    </ol></div>
  </div>
  <form method="post" class="panel form" id="apply" style="padding:clamp(20px,3vw,32px)"><?= csrf_field() ?>
    <h2 style="font-size:24px">Apply</h2>
    <?php require APP_DIR . '/views/partials/flash.php'; ?>
    <div class="row"><div class="field"><label for="s-name">Your name</label><input id="s-name" name="name" autocomplete="name" required></div><div class="field"><label for="s-email">Email</label><input id="s-email" name="email" type="email" autocomplete="email" required></div></div>
    <div class="row"><div class="field"><label for="s-company">Startup name</label><input id="s-company" name="company" required></div><div class="field"><label for="s-site">Website (optional)</label><input id="s-site" name="website" placeholder="https://"></div></div>
    <div class="row"><div class="field"><label for="s-phone">Phone (optional)</label><input id="s-phone" name="phone" type="tel"></div><div class="field"><label for="s-stage">Stage</label><select id="s-stage" name="stage"><option>Idea</option><option>Building the product</option><option>Launched, no revenue yet</option><option>Launched, earning revenue</option></select></div></div>
    <div class="field"><label for="s-what">What are you building?</label><textarea id="s-what" name="what" required placeholder="Who it is for and how you would use SeaGeek"></textarea></div>
    <fieldset class="field" style="border:0;padding:0;margin:0"><legend style="margin-bottom:6px">Products you plan to use</legend>
      <div class="pick-grid"><?php foreach (Catalog::services() as $k => $s): if ($s['status'] === 'planned') continue; ?><label class="consent"><input type="checkbox" name="products[]" value="<?= e($s['name']) ?>"><span><?= e($s['name']) ?></span></label><?php endforeach; ?></div>
    </fieldset>
    <label class="consent"><input type="checkbox" required><span>SeaGeek may use these details to review my application, as described in the <a class="link" href="/privacy">privacy notice</a>.</span></label>
    <?= Shield::turnstileWidget() ?>
    <button class="btn btn-primary">Send application</button>
  </form>
</div></section>
