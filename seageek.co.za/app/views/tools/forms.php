<div class="grid" style="grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);align-items:start" id="forms-grid">
  <form method="post" class="panel form"><?= csrf_field() ?>
    <div class="panel-head" style="margin-bottom:4px"><h2>New website form</h2><span class="price-tag">Free</span></div>
    <div class="field"><label for="f-name">Name</label><input id="f-name" name="name" placeholder="Contact form, Quote request, Booking" required maxlength="120"></div>
    <div class="row">
      <div class="field"><label for="f-email">Email each message to</label><input id="f-email" name="notify_email" type="email" value="<?= e($me['email'] ?? '') ?>"></div>
      <div class="field"><label for="f-phone">SMS alert to <span class="muted">(optional)</span></label><input id="f-phone" name="notify_phone" inputmode="tel" placeholder="082 123 4567"></div>
    </div>
    <label class="consent"><input type="checkbox" name="to_desk" value="1" checked><span>Open a Desk ticket for each message, so your team can reply and track it</span></label>
    <div class="field" style="margin-top:12px"><label for="f-thanks">Thank-you page <span class="muted">(optional)</span></label><input id="f-thanks" name="thanks_url" type="url" placeholder="https://yourbusiness.co.za/thank-you"></div>
    <button class="btn btn-primary">Create form</button>
    <p class="muted small">SMS alerts cost the normal SMS rate from your credit. Email and Desk are free.</p>
  </form>
  <div class="panel">
    <h2>How it works</h2>
    <ol class="howto">
      <li><b>1</b><span>Create a form here. You get a SeaGeek address for it.</span></li>
      <li><b>2</b><span>Put that address in your website form's <code>action</code>. Keep your own design and fields; we take whatever the form sends.</span></li>
      <li><b>3</b><span>Each message is emailed to you, saved here and, if you like, opens a Desk ticket or sends you an SMS. Spam bots are filtered out.</span></li>
    </ol>
    <p class="muted small" style="margin-top:14px">Works with plain HTML, WordPress (Contact Form 7 and others that allow a custom action), Webflow, Framer and any site builder that lets you set where a form posts.</p>
  </div>
</div>
<div class="panel flush" style="margin-top:14px">
  <div class="panel-head"><h2>Your forms</h2><span class="muted"><?= count($forms) ?></span></div>
  <?php if (!$forms): ?><div class="empty">No forms yet. Create one above.</div><?php else: ?>
  <div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>Form</th><th class="right">Messages</th><th>Last message</th><th>Goes to</th><th>Status</th></tr></thead>
    <tbody><?php foreach ($forms as $f): ?>
      <tr><td><a class="link" href="/dashboard/forms/<?= (int) $f['id'] ?>"><b><?= e($f['name']) ?></b></a></td>
      <td class="right"><?= number_format((int) $f['submissions']) ?></td>
      <td class="small muted nowrap"><?= $f['last_at'] ? e(date('j M H:i', strtotime($f['last_at'] . ' UTC'))) : 'None yet' ?></td>
      <td class="small"><?= e(implode(', ', array_filter([$f['notify_email'] ? 'Email' : null, $f['to_desk'] ? 'Desk' : null, $f['notify_phone'] ? 'SMS' : null])) ?: 'Saved here only') ?></td>
      <td><span class="pill <?= $f['status'] === 'active' ? 'green' : 'amber' ?>"><?= $f['status'] === 'active' ? 'Accepting' : 'Paused' ?></span></td></tr>
    <?php endforeach; ?></tbody>
  </table></div>
  <?php endif; ?>
</div>
