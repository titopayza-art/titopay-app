<?php
/** Shared message fields. Expects $channel, $audiences, $values (name, audience, subject, body, button_label, button_url), $base. */
$v = fn(string $k) => e((string) ($values[$k] ?? ''));
?>
<div class="field"><label for="cp-name">Campaign name <span class="muted">(only you see this)</span></label><input id="cp-name" name="name" value="<?= $v('name') ?>" placeholder="November promotion" required></div>
<div class="field"><label for="cp-aud">Send to</label>
  <?php if ($audiences): ?><select id="cp-aud" name="audience"><?php foreach ($audiences as $k => $label): ?><option value="<?= e($k) ?>" <?= ($values['audience'] ?? '') === $k ? 'selected' : '' ?>><?= e($label) ?></option><?php endforeach; ?></select>
  <?php else: ?><div class="notice">You have no contact lists yet. <a class="link" href="<?= e($base) ?>/contacts">Create one and import contacts</a> first.</div><input type="hidden" name="audience" value=""><?php endif; ?>
</div>
<?php if ($channel === 'email'): ?>
  <div class="field"><label for="cp-subject">Subject line</label><input id="cp-subject" name="subject" value="<?= $v('subject') ?>" maxlength="255" placeholder="What is new this month" required></div>
<?php endif; ?>
<div class="field"><label for="cp-body">Message</label>
  <textarea id="cp-body" name="body" rows="<?= $channel === 'sms' ? 5 : 10 ?>" maxlength="<?= $channel === 'sms' ? 1530 : 20000 ?>" data-sms-count="<?= $channel === 'sms' ? '1' : '' ?>" required><?= $v('body') ?></textarea>
  <div class="field-help"><span>Personalise with <code>{first_name}</code> or <code>{name}</code>. Replace words like {link} or {date} with your details.<?= $channel === 'email' ? ' Leave an empty line between paragraphs.' : ' Add "Reply STOP to opt out" to marketing messages.' ?></span><?php if ($channel === 'sms'): ?><span class="mono" data-sms-out>0 characters, 1 SMS</span><?php endif; ?></div>
</div>
<?php if ($channel === 'email'): ?>
  <div class="row"><div class="field"><label for="cp-bl">Button text <span class="muted">(optional)</span></label><input id="cp-bl" name="button_label" value="<?= $v('button_label') ?>" maxlength="60" placeholder="Shop now"></div><div class="field"><label for="cp-bu">Button link</label><input id="cp-bu" name="button_url" type="url" value="<?= $v('button_url') ?>" placeholder="https://"></div></div>
<?php endif; ?>
