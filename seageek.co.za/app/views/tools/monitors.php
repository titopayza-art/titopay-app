<?php $old = $_SESSION['old'] ?? []; unset($_SESSION['old']); ?>
<div class="grid" style="grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);align-items:start" id="mon-grid">
  <form method="post" class="panel form"><?= csrf_field() ?>
    <div class="panel-head" style="margin-bottom:4px"><h2>Watch a website</h2><span class="price-tag">Free</span></div>
    <div class="field"><label for="m-url">Website address</label><input id="m-url" name="url" type="url" inputmode="url" value="<?= e($old['url'] ?? '') ?>" placeholder="https://yourbusiness.co.za" required></div>
    <div class="row">
      <div class="field"><label for="m-name">Name</label><input id="m-name" name="name" value="<?= e($old['name'] ?? '') ?>" placeholder="Online shop"></div>
      <div class="field"><label for="m-every">Check</label><select id="m-every" name="every_min"><?php foreach (Monitors::INTERVALS as $k => $lab): ?><option value="<?= $k ?>" <?= $k === 5 ? 'selected' : '' ?>><?= e($lab) ?></option><?php endforeach; ?></select></div>
    </div>
    <div class="row">
      <div class="field"><label for="m-email">Email alerts to</label><input id="m-email" name="alert_email" type="email" value="<?= e($old['alert_email'] ?? ($me['email'] ?? '')) ?>"></div>
      <div class="field"><label for="m-phone">SMS alerts to <span class="muted">(optional)</span></label><input id="m-phone" name="alert_phone" inputmode="tel" value="<?= e($old['alert_phone'] ?? '') ?>" placeholder="082 123 4567"></div>
    </div>
    <div class="field"><label for="m-key">Words that must be on the page <span class="muted">(optional)</span></label><input id="m-key" name="keyword" value="<?= e($old['keyword'] ?? '') ?>" placeholder="Add to cart"><p class="muted small" style="margin-top:6px">Catches a broken page that still loads, such as a database error.</p></div>
    <button class="btn btn-primary">Start monitoring</button>
    <p class="muted small">Up to <?= Monitors::MAX_PER_ACCOUNT ?> websites. SMS alerts cost the normal SMS rate; email alerts are free.</p>
  </form>
  <div class="panel">
    <h2>How it works</h2>
    <ol class="howto">
      <li><b>1</b><span>We open your website on the schedule you pick, from our servers.</span></li>
      <li><b>2</b><span>If it fails twice in a row, you get an SMS and an email straight away. One slow moment does not wake you up.</span></li>
      <li><b>3</b><span>When it answers again, you get a "back up" message with how long it was down.</span></li>
    </ol>
  </div>
</div>
<div class="panel flush" style="margin-top:14px">
  <div class="panel-head"><h2>Your websites</h2><span class="muted"><?= count($monitors) ?> of <?= Monitors::MAX_PER_ACCOUNT ?></span></div>
  <?php if (!$monitors): ?><div class="empty">Nothing watched yet.</div><?php else: ?>
  <div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>Website</th><th>Status</th><th class="right">Response</th><th class="right">Uptime</th><th>Last check</th></tr></thead>
    <tbody><?php foreach ($monitors as $m): $st = $m['paused'] ? 'paused' : $m['state']; ?>
      <tr><td><a class="link" href="/dashboard/monitors/<?= (int) $m['id'] ?>"><b><?= e($m['name']) ?></b></a><div class="muted small"><?= e(preg_replace('#^https?://#', '', $m['url'])) ?></div></td>
      <td><span class="mon-state mon-<?= e($st) ?>"><i></i><?= e(['up' => 'Up', 'down' => 'Down', 'pending' => 'Checking', 'paused' => 'Paused'][$st] ?? $st) ?></span></td>
      <td class="right mono small"><?= $m['last_ms'] !== null ? (int) $m['last_ms'] . ' ms' : '' ?></td>
      <td class="right mono small"><?= e((string) Monitors::uptime($m)) ?></td>
      <td class="small muted nowrap"><?= $m['last_check_at'] ? e(date('j M H:i', strtotime($m['last_check_at'] . ' UTC'))) : 'Not yet' ?></td></tr>
    <?php endforeach; ?></tbody>
  </table></div>
  <?php endif; ?>
</div>
