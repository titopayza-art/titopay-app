<?php $h1 = 'Get a quote'; $meta = 'Instant, no sign-up needed'; $lead = 'Tell us roughly what you will use in a month. We price it on every plan, recommend the cheapest one that fits, and you can save it as a numbered quote.'; require APP_DIR . '/views/site/_pagehero.php'; ?>
<section class="section" style="padding-top:0"><div class="wrap">
  <div class="quote-layout">
    <div><?php require APP_DIR . '/views/partials/quote_form.php'; ?></div>
    <div id="quote-result" aria-live="polite"><?php $saveUrl = '/quote'; $saveLabel = Auth::user() ? 'Save quote' : 'Save quote and create my free account'; require APP_DIR . '/views/partials/quote_result.php'; ?></div>
  </div>
  <p class="muted small" style="margin-top:18px">Prices in rand. Estimates use today's rates and your plan's discount. Actual charges follow real usage, and unused credit stays on your account.</p>
</div></section>
<script src="/assets/js/quote.js?v=1" defer></script>
