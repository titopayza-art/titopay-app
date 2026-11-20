<?php $kindLabel = ['probe' => 'Looked for files that do not exist here', 'scanner' => 'Known attack tool', 'login_failed' => 'Wrong password', 'bad_api_key' => 'Wrong API key', 'csrf' => 'Expired or forged form', 'form_bot' => 'Automated form', '2fa_failed' => 'Wrong two-step code', 'manual' => 'Blocked by staff']; ?>
<div class="grid cols-3" style="margin-bottom:14px">
  <div class="stat"><div class="k">Addresses blocked now</div><div class="v"><?= count($blocks) ?></div></div>
  <div class="stat"><div class="k">Suspicious requests, last 24 hours</div><div class="v"><?= array_sum(array_column($kinds, 'n')) ?></div></div>
  <div class="stat"><div class="k">Staff without two-step sign-in</div><div class="v"><?= count($no2fa) ?></div></div>
</div>
<div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:start" id="sec-grid">
  <div class="stack">
    <div class="panel flush">
      <div class="panel-head"><h2>Blocked addresses</h2></div>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>Address</th><th>Why</th><th>Until</th><th></th></tr></thead>
        <tbody>
        <?php if (!$blocks): ?><tr><td colspan="4" class="muted">No one is blocked.</td></tr><?php endif; ?>
        <?php foreach ($blocks as $b): ?>
          <tr><td class="mono small"><?= e($b['ip']) ?></td><td class="small"><?= e($kindLabel[$b['reason']] ?? $b['reason']) ?></td>
          <td class="small nowrap"><?= strtotime($b['until']) > strtotime('+10 years') ? 'Always' : e(date('j M H:i', strtotime($b['until'] . ' UTC'))) ?></td>
          <td class="right"><form method="post" class="inline-form"><?= csrf_field() ?><input type="hidden" name="action" value="unblock"><input type="hidden" name="ip" value="<?= e($b['ip']) ?>"><button class="btn btn-ghost btn-xs">Unblock</button></form></td></tr>
        <?php endforeach; ?>
        </tbody>
      </table></div>
      <form method="post" class="inline-form" style="padding:14px 16px;gap:8px;display:flex;flex-wrap:wrap"><?= csrf_field() ?><input type="hidden" name="action" value="block">
        <input name="ip" placeholder="IP address to block" aria-label="IP address" style="flex:1;min-width:160px">
        <select name="for" aria-label="How long"><option value="week">For 7 days</option><option value="forever">Always</option></select>
        <button class="btn btn-sm">Block</button>
      </form>
    </div>
    <div class="panel">
      <h2>How the site protects itself</h2>
      <ul class="plain small">
        <li>Addresses that ask for WordPress, .env or database files, or use known attack tools, are refused straight away.</li>
        <li>Wrong passwords, wrong API keys, forged forms and bot form posts each count against the address. 20 in an hour blocks it for an hour.</li>
        <li>Every form carries a hidden field and a signed time. Bots fill the field or post too fast, and are turned away.</li>
        <li>Sign-in, password reset and two-step codes are rate limited per address and per account.</li>
        <li>Passwords are hashed, keys and partner secrets are encrypted, and cookies are secure and HTTP only.</li>
      </ul>
      <p class="muted small">Your address is <span class="mono"><?= e($me) ?></span>. You cannot block it from here.</p>
    </div>
  </div>
  <div class="stack">
    <form method="post" class="panel form"><?= csrf_field() ?><input type="hidden" name="action" value="save">
      <h2>Settings</h2>
      <label class="consent"><input type="checkbox" name="require_staff_2fa" value="1" <?= Settings::get('require_staff_2fa') === '1' ? 'checked' : '' ?>><span>Staff must use two-step sign-in to open the admin console</span></label>
      <?php if ($no2fa): ?><p class="muted small">Not set up yet: <?= e(implode(', ', array_column($no2fa, 'name'))) ?>.</p><?php endif; ?>
      <h2 style="margin-top:10px">Cloudflare Turnstile</h2>
      <p class="muted small">Optional "I am human" check on sign-up, contact, password reset and startup forms. Free at dash.cloudflare.com under Turnstile. Leave empty to rely on the hidden traps only.</p>
      <div class="row"><div class="field"><label for="t-site">Site key</label><input id="t-site" name="turnstile_site_key" value="<?= e(Settings::get('turnstile_site_key')) ?>"></div>
      <div class="field"><label for="t-sec">Secret key</label><input id="t-sec" name="turnstile_secret" type="password" placeholder="<?= Settings::get('turnstile_secret') !== '' ? 'Saved (leave blank to keep)' : '' ?>" autocomplete="new-password"></div></div>
      <p class="muted small">Turnstile is <b><?= Shield::turnstileEnabled() ? 'on' : 'off' ?></b>.<?php if (Shield::turnstileEnabled()): ?> <label class="consent" style="display:inline-flex"><input type="checkbox" name="turnstile_clear" value="1"><span>Remove keys</span></label><?php endif; ?></p>
      <button class="btn btn-sm">Save</button>
    </form>
    <div class="panel flush">
      <div class="panel-head"><h2>Recent activity</h2><span class="muted small">last 24 hours</span></div>
      <div class="tbl-wrap"><table class="tbl">
        <tbody>
        <?php if (!$events): ?><tr><td class="muted">Nothing suspicious recorded.</td></tr><?php endif; ?>
        <?php $seen = []; foreach ($events as $ev): $key = $ev['ip'] . $ev['kind'] . $ev['detail'] . substr($ev['created_at'], 0, 16); if (isset($seen[$key])) continue; $seen[$key] = 1; ?>
          <tr><td class="mono small"><?= e($ev['ip']) ?></td><td class="small"><?= e($kindLabel[$ev['kind']] ?? $ev['kind']) ?><?= $ev['detail'] ? '<div class="muted small mono">' . e(mb_strimwidth($ev['detail'], 0, 60, '…')) . '</div>' : '' ?></td><td class="small muted nowrap"><?= e(date('j M H:i', strtotime($ev['created_at'] . ' UTC'))) ?></td></tr>
        <?php endforeach; ?>
        </tbody>
      </table></div>
    </div>
  </div>
</div>
