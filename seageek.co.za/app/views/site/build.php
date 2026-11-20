<?php
$h1 = 'Build services'; $lead = 'Websites, shops, apps, chatbots and your own system, built once and yours to keep. Prices exclude VAT and exclude hosting, which is billed monthly.';
$meta = 'Most websites and chatbots go live within a week';
require APP_DIR . '/views/site/_pagehero.php';
$needs = ['site' => 'A website or online presence', 'sell' => 'Sell products online', 'answer' => 'Answer customers automatically', 'run' => 'Run my business in one system', 'connect' => 'Connect the tools I already use', 'app' => 'An app for phones'];
$sizes = ['one' => 'One page', 'few' => '2 to 5 pages', 'many' => 'More than 5 pages'];
$extras = ['none' => 'None of these', 'login' => 'A login area or content I update myself', 'system' => 'Staff, reports or my own workflows'];
$ans = $answers;
?>
<section class="section" style="padding-top:44px"><div class="wrap">
  <div class="card chooser" id="chooser">
    <span class="k">Find your fit in three questions</span>
    <form method="get" class="chooser-form" action="/build#recommend">
      <fieldset><legend>What do you need?</legend><div class="pick-grid"><?php foreach ($needs as $k => $l): ?><label class="choice"><input type="radio" name="need" value="<?= $k ?>" <?= $ans['need'] === $k ? 'checked' : '' ?> required><span><?= e($l) ?></span></label><?php endforeach; ?></div></fieldset>
      <fieldset><legend>How big is it?</legend><div class="pick-grid"><?php foreach ($sizes as $k => $l): ?><label class="choice"><input type="radio" name="size" value="<?= $k ?>" <?= $ans['size'] === $k ? 'checked' : '' ?>><span><?= e($l) ?></span></label><?php endforeach; ?></div></fieldset>
      <fieldset><legend>Does it need any of these?</legend><div class="pick-grid"><?php foreach ($extras as $k => $l): ?><label class="choice"><input type="radio" name="extra" value="<?= $k ?>" <?= $ans['extra'] === $k || ($ans['extra'] === '' && $k === 'none') ? 'checked' : '' ?>><span><?= e($l) ?></span></label><?php endforeach; ?></div></fieldset>
      <button class="btn btn-primary btn-sm">Show my option</button>
    </form>
  </div>

  <?php if ($rec): $o = $rec['offer']; ?>
  <div class="card rec" id="recommend">
    <span class="k">Our suggestion</span>
    <div class="rec-row"><div><h2><?= e($o[0]) ?></h2><p class="muted"><?= e($o[2]) ?></p></div>
      <div class="rec-price"><b>From R<?= number_format($o[1]) ?></b><small>excl. VAT, once-off. Hosting from R<?= $hosting ?>/month extra.</small><small>Live in about <?= $o[3] ?> working days once we have your content.</small></div></div>
    <?php if ($rec['alt']): $a = $rec['alt']; ?><p class="muted small" style="margin-top:12px">Also worth a look: <a class="link" href="#offer-<?= e($rec['alt_key']) ?>"><?= e($a[0]) ?></a> from R<?= number_format($a[1]) ?>.</p><?php endif; ?>
    <a class="btn btn-primary btn-sm" href="#request-form" data-pick="<?= e($rec['key']) ?>">Request this</a>
  </div>
  <?php endif; ?>

  <div class="section-head" style="margin-top:44px"><h2>Once-off services</h2><p class="lead">One payment for the build. Keep it, and host it with us or elsewhere.</p></div>
  <div class="offers">
    <?php foreach ($offers as $k => $o): ?>
    <article class="offer-card<?= $rec && $rec['key'] === $k ? ' picked' : '' ?>" id="offer-<?= e($k) ?>">
      <div class="offer-top"><h3><?= e($o[0]) ?></h3><span class="offer-days"><?= $o[3] ?> working days</span></div>
      <p class="offer-price">From <b>R<?= number_format($o[1]) ?></b> <small>excl. VAT</small></p>
      <p><?= e($o[2]) ?></p>
      <p class="muted small">Best for: <?= e($o[4]) ?></p>
      <p class="offer-host">Excludes hosting (from R<?= $hosting ?>/month) and domain name.</p>
      <a class="btn btn-ghost btn-sm" href="#request-form" data-pick="<?= e($k) ?>">Choose this</a>
    </article>
    <?php endforeach; ?>
  </div>
  <p class="muted small" style="margin-top:12px">Prices are starting prices. Anything beyond the listed scope is quoted before work starts, and you approve the quote first.</p>

  <div class="section-head" style="margin-top:56px"><h2>From brief to live in a week</h2><p class="lead">This is how a typical website or chatbot moves. Watch it run.</p></div>
  <div class="sim card" id="sim" aria-label="Animated build simulation">
    <div class="sim-browser"><div class="sim-bar"><i></i><i></i><i></i><span>yourbusiness.co.za</span></div>
      <div class="sim-page">
        <div class="sim-b b1"><b></b><i></i><i class="s"></i></div>
        <div class="sim-b b2"><span></span><span></span><span></span></div>
        <div class="sim-b b3"><i></i><i class="s"></i><i></i></div>
        <div class="sim-b b4 chat"><small>Hi! How can we help?</small></div>
      </div>
    </div>
    <ol class="sim-steps">
      <li class="st1"><b>Day 1</b><span>Brief and content: we agree on what the site or bot does.</span></li>
      <li class="st2"><b>Day 2</b><span>Design: you see the layout and pick the colours.</span></li>
      <li class="st3"><b>Day 3 to 4</b><span>Build: pages, forms and your chatbot trained on your documents.</span></li>
      <li class="st4"><b>Day 5</b><span>Your review: you test it and send changes.</span></li>
      <li class="st5"><b>Day 6</b><span>Checks: mobile, speed and every form tested.</span></li>
      <li class="st6"><b>Day 7</b><span>Live on your domain, with a handover call.</span></li>
    </ol>
    <p class="muted small sim-note">Going live in a week depends on you returning content and feedback promptly. A delay on your side moves the date by the same amount.</p>
  </div>

  <div class="section-head" style="margin-top:56px" id="request"><h2 id="request-form-title">Request a build</h2><p class="lead">Tell us what you need. We reply within one working day to book a short call.</p></div>
  <form method="post" action="/build/request" class="panel form" id="request-form" style="max-width:760px"><?= csrf_field() ?>
    <div class="field"><label for="b-offer">What do you want?</label><select id="b-offer" name="offer" required><?php foreach ($offers as $k => $o): ?><option value="<?= e($k) ?>" <?= $rec && $rec['key'] === $k ? 'selected' : '' ?>><?= e($o[0]) ?> (from R<?= number_format($o[1]) ?>)</option><?php endforeach; ?></select></div>
    <div class="row"><div class="field"><label for="b-name">Your name</label><input id="b-name" name="name" required autocomplete="name"></div><div class="field"><label for="b-email">Email</label><input id="b-email" name="email" type="email" required autocomplete="email"></div></div>
    <div class="field"><label for="b-phone">Phone <span class="muted">(optional)</span></label><input id="b-phone" name="phone" type="tel" autocomplete="tel"></div>
    <div class="field"><label for="b-brief">About your project</label><textarea id="b-brief" name="brief" rows="4" required placeholder="What your business does, who it is for, and what you want the website, app or chatbot to do."></textarea></div>
    <?= Shield::turnstileWidget() ?>
    <button class="btn btn-primary">Send request</button>
  </form>
</div></section>
<style>
.chooser-form fieldset { border:0; padding:0; margin:0 0 14px; } .chooser-form legend { margin-bottom:6px; font-weight:600; }
.offers { display:grid; grid-template-columns:repeat(auto-fill,minmax(270px,1fr)); gap:14px; }
.offer-card { border:1px solid var(--line); border-radius:var(--radius); padding:20px; background:var(--bg-raised); display:flex; flex-direction:column; gap:8px; scroll-margin-top:110px; }
.offer-card.picked { border-color:rgba(95,227,207,.55); } .offer-card p { margin:0; line-height:1.55; color:var(--text-soft); }
.offer-top { display:flex; justify-content:space-between; gap:8px; align-items:baseline; flex-wrap:wrap; } .offer-top h3 { font-size:19px; margin:0; }
.offer-days { font-size:12.5px; color:var(--muted); } .offer-price { font-size:20px; color:var(--text) !important; } .offer-price small { font-size:13px; color:var(--muted); }
.offer-host { font-size:13px; color:var(--warn) !important; } .offer-card .btn { margin-top:auto; align-self:flex-start; }
.rec { margin-top:18px; scroll-margin-top:110px; } .rec-row { display:flex; justify-content:space-between; gap:22px; flex-wrap:wrap; margin-top:8px; }
.rec h2 { font-size:22px; margin:0 0 6px; } .rec-price { display:grid; gap:4px; text-align:right; } .rec-price b { font-size:24px; } .rec-price small { color:var(--muted); font-size:13px; }
.sim { display:grid; grid-template-columns:minmax(0,1.2fr) minmax(0,1fr); gap:22px; align-items:center; }
.sim-browser { border:1px solid var(--line-strong); border-radius:12px; overflow:hidden; background:#0b1820; }
.sim-bar { display:flex; gap:6px; align-items:center; padding:9px 12px; } .sim-bar i { width:9px; height:9px; border-radius:50%; background:#2b3d45; }
.sim-bar span { margin-left:8px; font-size:12px; color:var(--muted); background:#0f1e25; padding:2px 10px; border-radius:6px; }
.sim-page { background:#f4f7f8; padding:16px; min-height:280px; display:grid; gap:12px; align-content:start; position:relative; }
.sim-b { opacity:0; transform:translateY(12px); animation:simIn 14s infinite; }
.sim-b b { display:block; height:16px; width:45%; background:#13262c; border-radius:4px; margin-bottom:8px; } .sim-b i, .sim-b span { display:block; height:8px; background:#cfdde1; border-radius:4px; margin-bottom:6px; }
.sim-b i.s { width:60%; } .sim-b span { width:30%; display:inline-block; margin-right:6px; height:50px; background:#dfe9ec; }
.b1 { animation-delay:.6s; } .b2 { animation-delay:2.6s; } .b3 { animation-delay:4.6s; } .b4 { animation-delay:6.6s; }
.sim-b.chat { position:absolute; right:14px; bottom:14px; background:#0f8f80; color:#fff; padding:8px 12px; border-radius:12px; font-size:12.5px; }
@keyframes simIn { 0% { opacity:0; transform:translateY(12px); } 8%, 80% { opacity:1; transform:none; } 92%, 100% { opacity:0; } }
.sim-steps { list-style:none; margin:0; padding:0; display:grid; gap:12px; }
.sim-steps li { display:grid; gap:2px; padding-left:14px; border-left:3px solid var(--line-strong); opacity:.35; animation:stepOn 14s infinite; }
.sim-steps b { color:var(--accent); font-size:14px; } .sim-steps span { color:var(--text-soft); font-size:14.5px; line-height:1.5; }
.st1 { animation-delay:.6s; } .st2 { animation-delay:2.6s; } .st3 { animation-delay:4.6s; } .st4 { animation-delay:6.6s; } .st5 { animation-delay:8.6s; } .st6 { animation-delay:10.6s; }
@keyframes stepOn { 0% { opacity:.35; } 6%, 82% { opacity:1; border-left-color:var(--accent); } 92%, 100% { opacity:.35; } }
.sim-note { grid-column:1 / -1; margin:0; }
@media (prefers-reduced-motion: reduce) { .sim-b, .sim-steps li { animation:none; opacity:1; transform:none; } }
@media (max-width:860px) { .sim { grid-template-columns:1fr; } .rec-price { text-align:left; } }
</style>
<script>
(function(){
  document.querySelectorAll('[data-pick]').forEach(function(a){ a.addEventListener('click', function(){ var s=document.getElementById('b-offer'); if(s) s.value=a.getAttribute('data-pick'); }); });
  var sim=document.getElementById('sim'); if(sim && 'IntersectionObserver' in window){ sim.style.animationPlayState='paused'; var io=new IntersectionObserver(function(es){ es.forEach(function(e){ sim.querySelectorAll('*').forEach(function(x){ x.style.animationPlayState=e.isIntersecting?'running':'paused'; }); }); },{threshold:.2}); io.observe(sim); }
})();
</script>
