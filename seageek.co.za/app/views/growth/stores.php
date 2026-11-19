<?php $units = balance_units($org); ?>
<div class="grid" style="grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);align-items:start" id="st-grid">
  <div class="panel">
    <div class="panel-head"><h2>Order updates by SMS, no code</h2><span class="price-tag"><?= zar($price) ?> per SMS</span></div>
    <p class="muted">Connect your online store once. Your customers then get an SMS when they order, when payment clears, when the parcel ships, and if they leave items in their cart. You choose which messages go out and what they say.</p>
    <ol class="howto">
      <li><b>1</b><span>Pick your platform below and give the store a name.</span></li>
      <li><b>2</b><span>Paste the link we give you into your store's webhook settings. We show every click.</span></li>
      <li><b>3</b><span>Send a test order, switch on the messages you want, and you are live.</span></li>
    </ol>
    <p class="muted small" style="margin-top:14px">Credit: <b style="color:var(--text)"><?= zar($org['balance']) ?></b>, enough for about <?= number_format($units['store_sms']) ?> store SMS. Customers who agree to marketing are added to a contact list so you can send them <a class="link" href="/dashboard/campaigns">campaigns</a>.</p>
  </div>
  <form method="post" class="panel form"><?= csrf_field() ?>
    <h2>Connect a store</h2>
    <div class="platforms">
      <?php foreach (Stores::PLATFORMS as $k => $label): ?><label class="choice"><input type="radio" name="platform" value="<?= $k ?>" <?= $k === 'shopify' ? 'checked' : '' ?>><span><b><?= e($label) ?></b><small><?= ['shopify' => 'Settings, Notifications, Webhooks', 'woocommerce' => 'WooCommerce, Settings, Advanced, Webhooks', 'wix' => 'Automations with a webhook action', 'other' => 'Magento, BigCommerce, OpenCart, your own site'][$k] ?></small></span></label><?php endforeach; ?>
    </div>
    <div class="row"><div class="field"><label for="st-name">Store name <span class="muted">(used in messages)</span></label><input id="st-name" name="name" placeholder="Acme Stores" required></div><div class="field"><label for="st-domain">Store address</label><input id="st-domain" name="domain" placeholder="acme.co.za"></div></div>
    <button class="btn btn-primary btn-sm">Connect store</button>
  </form>
</div>

<div class="panel flush" style="margin-top:14px">
  <div class="panel-head"><h2>Your stores</h2></div>
  <?php if (!$stores): ?><div class="empty">No stores connected yet.</div><?php else: ?>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Store</th><th>Platform</th><th>Status</th><th class="right">Events</th><th class="right">SMS sent</th><th>Last order event</th><th></th></tr></thead><tbody>
    <?php foreach ($stores as $s): $ready = $s['platform'] !== 'shopify' || $s['secret_enc']; ?><tr>
      <td><a class="link" href="/dashboard/stores/<?= e($s['public_id']) ?>"><?= e($s['name']) ?></a><div class="muted small"><?= e($s['domain'] ?: '') ?></div></td>
      <td class="small"><?= e(Stores::PLATFORMS[$s['platform']] ?? $s['platform']) ?></td>
      <td><?php if (!$ready): ?><span class="pill amber">Finish setup</span><?php else: $status = $s['status']; require APP_DIR . '/views/partials/status.php'; endif; ?></td>
      <td class="right mono small"><?= number_format((int) $s['events_received']) ?></td><td class="right mono small"><?= number_format((int) $s['sms_sent']) ?></td>
      <td class="small nowrap"><?= $s['last_event_at'] ? e(date('j M H:i', strtotime($s['last_event_at'] . ' UTC'))) : '<span class="muted">None yet</span>' ?></td>
      <td class="right"><a class="btn btn-ghost btn-xs" href="/dashboard/stores/<?= e($s['public_id']) ?>">Open</a></td></tr><?php endforeach; ?>
  </tbody></table></div><?php endif; ?>
</div>
<style>@media (max-width: 1000px) { #st-grid { grid-template-columns: 1fr !important; } } .platforms { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; } @media (max-width: 700px) { .platforms { grid-template-columns: 1fr; } }</style>
