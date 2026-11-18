<?php $f = fn($k, $d = '') => e($cfg[$k] ?? $d); ?>
<div class="toolbar"><a class="btn btn-ghost btn-sm" href="/admin/partners">All partners</a><?php if ($p['last_error']): ?><span class="pill red" title="<?= e($p['last_error']) ?>">Last error: <?= e(mb_strimwidth($p['last_error'], 0, 70, '…')) ?></span><?php endif; ?></div>
<div class="grid cols-3">
  <form method="post" class="panel span-2 form"><?= csrf_field() ?>
    <div class="row"><div class="field"><label>Name</label><input name="name" value="<?= e($p['name']) ?>" required></div>
    <div class="field"><label>Product</label><select name="service"><?php foreach (['sms', 'mail', 'whatsapp', 'verify', 'voice', 'ai'] as $s): ?><option value="<?= $s ?>" <?= $p['service'] === $s ? 'selected' : '' ?>><?= e(service_names()[$s]) ?></option><?php endforeach; ?></select></div></div>
    <div class="row"><div class="field"><label>Connector</label><select name="driver"><?php foreach (['http' => 'HTTP template (any JSON API)', 'ses' => 'Amazon SES', 'd360' => '360dialog WhatsApp', 'anthropic' => 'Anthropic', 'openai' => 'OpenAI'] as $k => $l): ?><option value="<?= $k ?>" <?= $p['driver'] === $k ? 'selected' : '' ?>><?= e($l) ?></option><?php endforeach; ?></select></div>
    <div class="field"><label>Priority (1 = first choice)</label><input name="priority" type="number" min="1" value="<?= (int) $p['priority'] ?>"></div></div>
    <label class="consent"><input type="checkbox" name="active" value="1" <?= $p['active'] ? 'checked' : '' ?>><span>Active: route live traffic to this partner</span></label>

    <?php if ($p['driver'] === 'http'): ?>
      <h2 style="margin-top:8px">HTTP template</h2>
      <?php if (!empty($cfg['note'])): ?><p class="muted small"><?= e($cfg['note']) ?></p><?php endif; ?>
      <div class="row"><div class="field" style="flex:3"><label>Endpoint URL</label><input name="cfg[url]" value="<?= $f('url') ?>" placeholder="https://api.partner.co.za/v1/send"></div><div class="field"><label>Method</label><input name="cfg[method]" value="<?= $f('method', 'POST') ?>"></div></div>
      <div class="field"><label>API key / secret (stored encrypted; leave blank to keep)</label><input name="cfg[secret]" type="password" placeholder="<?= !empty($cfg['secret']) ? 'Saved' : '' ?>"></div>
      <div class="field"><label>Headers, one per line. {{secret}} is replaced with the key.</label><textarea class="code" name="cfg[headers]" rows="3"><?= $f('headers') ?></textarea></div>
      <div class="field"><label>JSON body template. Placeholders: {{to}} {{body}} {{from}} {{reference}} {{subject}} {{html}} {{text}} {{type}} {{id_number}} {{first_name}} {{last_name}} {{company_reg}}</label><textarea class="code" name="cfg[body]" rows="6" placeholder='{"to":"{{to}}","message":"{{body}}","sender":"{{from}}"}'><?= $f('body') ?></textarea></div>
      <div class="row"><div class="field"><label>Message ID path in response</label><input name="cfg[id_path]" value="<?= $f('id_path', 'id') ?>" placeholder="data.messageId"></div><div class="field"><label>Delivery report: ID path</label><input name="cfg[dlr_id_path]" value="<?= $f('dlr_id_path', 'id') ?>"></div></div>
      <div class="row"><div class="field"><label>Delivery report: status path</label><input name="cfg[dlr_status_path]" value="<?= $f('dlr_status_path', 'status') ?>"></div><div class="field"><label>Values that mean delivered</label><input name="cfg[dlr_delivered]" value="<?= $f('dlr_delivered', 'delivered,delivrd,success') ?>"></div></div>
    <?php elseif ($p['driver'] === 'ses'): ?>
      <h2 style="margin-top:8px">Amazon SES</h2>
      <div class="row"><div class="field"><label>Region</label><input name="cfg[region]" value="<?= $f('region', 'af-south-1') ?>"></div><div class="field"><label>Configuration set (optional)</label><input name="cfg[configuration_set]" value="<?= $f('configuration_set') ?>"></div></div>
      <div class="row"><div class="field"><label>Access key ID</label><input name="cfg[access_key]" value="<?= $f('access_key') ?>"></div><div class="field"><label>Secret access key (blank keeps saved)</label><input name="cfg[secret_key]" type="password" placeholder="<?= !empty($cfg['secret_key']) ? 'Saved' : '' ?>"></div></div>
    <?php elseif ($p['driver'] === 'd360'): ?>
      <h2 style="margin-top:8px">360dialog</h2>
      <div class="field"><label>API base URL</label><input name="cfg[base_url]" value="<?= $f('base_url', 'https://waba-v2.360dialog.io') ?>"></div>
      <p class="muted small">Each WhatsApp number has its own channel API key from the 360dialog Partner Hub. Set it on the customer's page under WhatsApp numbers.</p>
    <?php else: ?>
      <h2 style="margin-top:8px"><?= $p['driver'] === 'anthropic' ? 'Anthropic' : 'OpenAI' ?></h2>
      <div class="field"><label>API key (stored encrypted; blank keeps saved)</label><input name="cfg[api_key]" type="password" placeholder="<?= !empty($cfg['api_key']) ? 'Saved' : '' ?>"></div>
      <?php if ($p['driver'] === 'openai'): ?><div class="field"><label>Base URL</label><input name="cfg[base_url]" value="<?= $f('base_url', 'https://api.openai.com/v1') ?>"></div><?php endif; ?>
    <?php endif; ?>
    <button class="btn btn-primary">Save partner</button>
  </form>
  <div class="stack">
    <?php if ($p['id'] && in_array($p['service'], ['sms', 'mail', 'whatsapp', 'voice'], true)): ?>
    <form method="post" class="panel form"><?= csrf_field() ?><input type="hidden" name="action" value="test"><h2>Send a test</h2><p class="muted small">Sends one real message through this partner only.</p>
      <div class="field"><label><?= $p['service'] === 'mail' ? 'Email' : 'Phone number' ?></label><input name="test_to" required></div><button class="btn btn-ghost btn-sm">Send test</button></form>
    <?php endif; ?>
    <?php if ($p['id'] && $p['driver'] === 'http'): ?>
    <div class="panel"><h2>Delivery report URL</h2><p class="muted small" style="margin:6px 0 10px">Give this to the partner as the callback for delivery receipts.</p><div class="secret" style="font-size:12px"><span id="dlr"><?= e(app_url('/webhooks/partner/' . $p['id'] . '/' . substr(hash_hmac('sha256', 'dlr' . $p['id'], (string) config('app_key')), 0, 32))) ?></span><button class="copy-btn" type="button" data-copy="dlr">Copy</button></div></div>
    <?php endif; ?>
    <div class="panel"><h2>Status</h2><dl class="kv" style="grid-template-columns:100px 1fr;margin-top:10px"><dt>Last success</dt><dd><?= e($p['last_ok_at'] ?: 'Never') ?></dd><dt>Recent failures</dt><dd><?= (int) $p['fail_count'] ?></dd></dl></div>
  </div>
</div>
