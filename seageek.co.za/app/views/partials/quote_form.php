<?php
/** Volume form for quotes. Expects $in. GET keeps working without JavaScript; quote.js updates prices as you type. */
$groups = [
    'Messaging' => ['sms', 'email', 'otp_sms', 'otp_email'],
    'WhatsApp' => ['wa_utility', 'wa_marketing', 'wa_service', 'wa_number'],
    'Verify, Voice and AI' => ['verify_id', 'verify_pep', 'voice_minute', 'ai_requests'],
    'Support desk' => ['desk_agents'],
];
$defs = Quotes::inputs();
?>
<form method="get" class="quote-form" data-live-quote>
  <p class="muted small" style="margin:0">Enter monthly volumes. Leave anything you don't need empty.</p>
  <?php foreach ($groups as $g => $keys): ?>
    <fieldset class="qset">
      <legend><?= e($g) ?></legend>
      <div class="qgrid">
        <?php foreach ($keys as $k): [$label, , , $per] = $defs[$k]; ?>
          <div class="field"><label for="q-<?= e($k) ?>"><?= e($label) ?></label><input id="q-<?= e($k) ?>" name="<?= e($k) ?>" type="number" min="0" step="1" inputmode="numeric" value="<?= (int) $in[$k] ?: '' ?>" placeholder="0"></div>
        <?php endforeach; ?>
        <?php if ($g === 'Verify, Voice and AI'): ?>
          <p class="muted small" style="grid-column:1/-1;margin:0">AI requests are estimated at about <?= number_format(Quotes::AI_IN) ?> tokens in and <?= Quotes::AI_OUT ?> out each. You only pay for tokens actually used.</p>
          <div class="field" style="grid-column:1/-1"><label for="q-ai_model">AI model for the estimate</label><select id="q-ai_model" name="ai_model"><?php foreach (Catalog::aiModels() as $m): $v = $m['provider'] . ':' . $m['model']; ?><option value="<?= e($v) ?>" <?= $in['ai_model'] === $v ? 'selected' : '' ?>><?= e($m['label']) ?> (<?= e($m['provider'] === 'anthropic' ? 'Anthropic' : 'OpenAI') ?>)</option><?php endforeach; ?></select></div>
        <?php endif; ?>
      </div>
    </fieldset>
  <?php endforeach; ?>
  <noscript><button class="btn btn-ghost btn-sm">Update prices</button></noscript>
</form>
