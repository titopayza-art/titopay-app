<?php
$crumbs = [['Store SMS', '/dashboard/stores'], [$store['name'], null]];
require APP_DIR . '/views/partials/crumbs.php';
$hook = Stores::hookUrl($store);
$p = $store['platform'];
$needsSecret = $p === 'shopify' && !$secret;
$events = Stores::events();
$genericSample = json_encode(['event' => 'order.shipped', 'order' => ['number' => '1042', 'total' => '899.00', 'currency' => 'ZAR', 'tracking_url' => 'https://track.example.co.za/1042'], 'customer' => ['first_name' => 'Thandi', 'phone' => '0821234567', 'accepts_marketing' => true]], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
?>
<div class="toolbar" style="justify-content:space-between">
  <div class="toolbar" style="margin:0"><span class="pill <?= $needsSecret ? 'amber' : ($store['status'] === 'active' ? 'green' : 'red') ?>"><?= $needsSecret ? 'Finish setup' : ($store['status'] === 'active' ? 'Active' : 'Paused') ?></span><span class="muted small"><?= e(Stores::PLATFORMS[$p]) ?><?= $store['domain'] ? ' · ' . e($store['domain']) : '' ?> · <?= number_format((int) $store['sms_sent']) ?> SMS sent</span></div>
  <form method="post" class="inline-form"><?= csrf_field() ?><input type="hidden" name="action" value="<?= $store['status'] === 'active' ? 'pause' : 'resume' ?>"><button class="btn btn-ghost btn-sm"><?= $store['status'] === 'active' ? 'Pause SMS' : 'Resume SMS' ?></button></form>
</div>

<div class="panel" id="setup">
  <div class="panel-head"><h2>Connect <?= e(Stores::PLATFORMS[$p]) ?></h2><span class="muted">About 3 minutes</span></div>
  <div class="field"><label>Your SeaGeek link (keep it private)</label><div class="secret"><span id="hook-url"><?= e($hook) ?></span><button class="copy-btn" type="button" data-copy="hook-url">Copy</button></div></div>
  <?php foreach (StorePlugins::forPlatform($p) as $kind => [$plabel, $pfile, $phelp]): ?>
    <div class="plugin-box"><div><b><?= e($plabel) ?></b><span><?= e($phelp) ?> This copy is already connected to <?= e($store['name']) ?>, so there is nothing to type.</span></div><a class="btn btn-primary btn-sm" href="/dashboard/stores/<?= e($store['public_id']) ?>/download/<?= e($kind) ?>"><?= icon('download') ?>Download <?= e($pfile) ?></a></div>
  <?php endforeach; ?>
  <?php if ($p === 'shopify'): ?>
    <ol class="howto">
      <li><b>1</b><span>In Shopify admin open <b>Settings</b>, then <b>Notifications</b>, then <b>Webhooks</b> at the bottom of the page.</span></li>
      <li><b>2</b><span>Click <b>Create webhook</b>. Event: <b>Order creation</b>. Format: <b>JSON</b>. URL: paste your SeaGeek link. Save.</span></li>
      <li><b>3</b><span>Repeat with the same link for <b>Order payment</b>, <b>Order fulfillment</b>, <b>Order cancellation</b>, <b>Refund create</b> and, for cart reminders, <b>Checkout creation</b>.</span></li>
      <li><b>4</b><span>Shopify shows "Your webhooks will be signed with" and a long key. Copy it and paste it below.</span></li>
    </ol>
    <form method="post" class="toolbar" style="margin:14px 0 0"><?= csrf_field() ?><input type="hidden" name="action" value="secret"><input name="secret" type="password" placeholder="<?= $secret ? 'Signing secret saved. Paste a new one to replace it.' : 'Paste the Shopify webhook signing secret' ?>" style="flex:1;min-width:0" autocomplete="off"><button class="btn <?= $secret ? 'btn-ghost' : 'btn-primary' ?> btn-sm">Save secret</button></form>
  <?php elseif ($p === 'woocommerce'): ?>
    <ol class="howto">
      <li><b>1</b><span>Download the plugin above.</span></li>
      <li><b>2</b><span>In WordPress open <b>Plugins</b>, <b>Add new</b>, <b>Upload plugin</b>, choose the file and click <b>Activate</b>.</span></li>
      <li><b>3</b><span>Done. Place a test order to see the SMS. A tick box at checkout lets customers join your SMS offers list.</span></li>
    </ol>
    <details class="fold-plain"><summary>Prefer WooCommerce webhooks instead of the plugin?</summary>
    <div class="field"><label>Secret for WooCommerce</label><div class="secret"><span id="hook-secret"><?= e((string) $secret) ?></span><button class="copy-btn" type="button" data-copy="hook-secret">Copy</button></div></div>
    <ol class="howto">
      <li><b>1</b><span>In WordPress open <b>WooCommerce</b>, <b>Settings</b>, <b>Advanced</b>, <b>Webhooks</b>, then <b>Add webhook</b>.</span></li>
      <li><b>2</b><span>Name: SeaGeek orders. Status: <b>Active</b>. Topic: <b>Order created</b>. Delivery URL: your SeaGeek link. Secret: the secret above. API version: WP REST API v3. Save.</span></li>
      <li><b>3</b><span>Add a second webhook the same way with the topic <b>Order updated</b>. That one sends payment, completed (shipped), cancelled and refunded updates.</span></li>
      <li><b>4</b><span>For tracking links in the shipped SMS, store them in the order field <code>_tracking_url</code> (most tracking plugins do).</span></li>
    </ol>
    </details>
  <?php else: ?>
    <div class="field"><label>Signing secret (optional)</label><div class="secret"><span id="hook-secret"><?= e((string) $secret) ?></span><button class="copy-btn" type="button" data-copy="hook-secret">Copy</button></div></div>
    <ol class="howto">
      <?php if (in_array($p, ['opencart', 'prestashop', 'magento'], true)): ?>
      <li><b>1</b><span>Download the PHP file above and upload it to your store's folder.</span></li>
      <li><b>2</b><span>Where your store saves an order (or in an order-status module), add <code>require_once 'seageek-store.php';</code> and call <code>seageek_store_event('order.created', $order, $customer)</code>. The file explains every option.</span></li>
      <?php elseif (in_array($p, ['zapier', 'bigcommerce'], true)): ?>
      <li><b>1</b><span>In Zapier or Make, start a flow with your store's trigger, for example BigCommerce <b>New order</b>.</span></li>
      <li><b>2</b><span>Add a <b>Webhooks</b> step: method POST, URL your SeaGeek link, payload type JSON, with the fields shown in the example.</span></li>
      <?php elseif ($p === 'wix'): ?>
      <li><b>1</b><span>In Wix open <b>Automations</b> and create one with the trigger <b>Order placed</b> (and others such as <b>Order fulfilled</b>).</span></li>
      <li><b>2</b><span>Add the action <b>Send HTTP request</b> (webhook), method POST, to your SeaGeek link, with a JSON body like the example.</span></li>
      <?php else: ?>
      <li><b>1</b><span>Ask your developer or plugin to POST JSON to your SeaGeek link when an order is created, paid, shipped, cancelled or refunded.</span></li>
      <li><b>2</b><span>If your platform can sign requests, send header <code>X-SeaGeek-Signature: sha256=HMAC</code> of the body with the secret above.</span></li>
      <?php endif; ?>
      <li><b>3</b><span>Events: <code>order.created</code>, <code>order.paid</code>, <code>order.shipped</code>, <code>order.cancelled</code>, <code>order.refunded</code>, <code>checkout.abandoned</code>.</span></li>
    </ol>
    <pre class="snippet" style="margin-top:12px"><?= e($genericSample) ?></pre>
  <?php endif; ?>
</div>

<form method="post" class="panel" style="margin-top:14px"><?= csrf_field() ?><input type="hidden" name="action" value="messages">
  <div class="panel-head"><h2>Messages</h2><span class="muted"><?= zar($price) ?> per SMS. Longer than 160 characters counts as more than one SMS.</span></div>
  <div class="ev-list">
    <?php foreach ($events as $k => [$label, $default, $onDefault, $when]): $cfg = $settings['events'][$k]; ?>
      <div class="ev">
        <label class="ev-toggle"><input type="checkbox" name="on[<?= $k ?>]" value="1" <?= $cfg['on'] ? 'checked' : '' ?>><span><b><?= e($label) ?></b><small><?= e($when) ?></small></span></label>
        <div><textarea name="text[<?= $k ?>]" rows="2" maxlength="480" data-sms-count="1"><?= e($cfg['text']) ?></textarea><div class="field-help"><span>Example: <?= e(Stores::sampleBody($store, $k)) ?></span><span class="mono" data-sms-out></span></div></div>
      </div>
    <?php endforeach; ?>
  </div>
  <div class="toolbar" style="margin:14px 0 0;justify-content:space-between">
    <span class="muted small">Placeholders: <?= e(implode(', ', array_keys(Stores::placeholders()))) ?></span>
    <span class="toolbar" style="margin:0"><label class="small muted" for="st-delay">Cart reminder after</label><select id="st-delay" name="delay"><?php foreach ([1, 2, 4, 12, 24] as $h): ?><option value="<?= $h ?>" <?= $settings['abandoned_delay_hours'] == $h ? 'selected' : '' ?>><?= $h ?> hour<?= $h === 1 ? '' : 's' ?></option><?php endforeach; ?></select><button class="btn btn-primary btn-sm">Save messages</button></span>
  </div>
</form>

<div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:start;margin-top:14px" id="sd-grid">
  <form method="post" class="panel form"><?= csrf_field() ?><input type="hidden" name="action" value="test">
    <h2>Send a test order</h2>
    <p class="muted small">Runs your message against a sample order. Nothing is sent and nothing is charged.</p>
    <div class="row"><div class="field"><label for="st-ev">Event</label><select id="st-ev" name="event"><?php foreach ($events as $k => [$label]): ?><option value="<?= $k ?>"><?= e($label) ?></option><?php endforeach; ?></select></div><div class="field"><label for="st-phone">Phone</label><input id="st-phone" name="phone" value="<?= e((string) $org['phone']) ?>" inputmode="tel"></div></div>
    <button class="btn btn-ghost btn-sm">Run test</button>
  </form>
  <div class="panel">
    <h2>Marketing list</h2>
    <?php if ($list): ?><p class="muted" style="margin-top:6px"><b style="color:var(--text)"><?= number_format((int) $list['total']) ?></b> <?= (int) $list['total'] === 1 ? 'customer who agreed' : 'customers who agreed' ?> to marketing <?= (int) $list['total'] === 1 ? 'is' : 'are' ?> in <a class="link" href="/dashboard/contacts/<?= (int) $list['id'] ?>"><?= e($list['name']) ?></a>.</p><a class="btn btn-ghost btn-sm" style="margin-top:12px" href="/dashboard/campaigns/new?channel=sms">Send them a campaign</a><?php endif; ?>
    <form method="post" class="toolbar" style="margin:16px 0 0"><?= csrf_field() ?><input type="hidden" name="action" value="details"><input name="name" value="<?= e($store['name']) ?>" aria-label="Store name"><input name="domain" value="<?= e((string) $store['domain']) ?>" placeholder="Store address" aria-label="Store address"><button class="btn btn-ghost btn-sm">Save</button></form>
  </div>
</div>

<div class="panel flush" style="margin-top:14px">
  <div class="panel-head"><h2>Activity</h2><span class="muted">Last 50 events</span></div>
  <?php $rows = $storeEvents; ?>
  <?php if (!$rows): ?><div class="empty">No orders yet. Place a test order in your store, or use Send a test order above.</div><?php else: ?>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Time</th><th>Event</th><th>Order</th><th>Phone</th><th>Status</th><th>Detail</th></tr></thead><tbody>
    <?php foreach ($rows as $ev): ?><tr><td class="small nowrap"><?= e(date('j M H:i', strtotime($ev['created_at'] . ' UTC'))) ?></td><td class="small"><?= e(Stores::events()[$ev['topic']][0] ?? $ev['topic']) ?></td><td class="mono small"><?= e((string) $ev['order_ref']) ?></td><td class="mono small"><?= e($ev['phone'] ? substr($ev['phone'], 0, 6) . '•••' . substr($ev['phone'], -2) : '–') ?></td><td><?php $status = $ev['status']; require APP_DIR . '/views/partials/status.php'; ?></td><td class="small muted" style="max-width:380px"><?= e((string) $ev['note']) ?></td></tr><?php endforeach; ?>
  </tbody></table></div><?php endif; ?>
</div>
<form method="post" style="margin-top:14px" data-confirm="Disconnect <?= e($store['name']) ?>? Orders stop sending SMS."><?= csrf_field() ?><input type="hidden" name="action" value="delete"><button class="btn btn-danger btn-sm">Disconnect store</button></form>
<style>@media (max-width: 1000px) { #sd-grid { grid-template-columns: 1fr !important; } }</style>
